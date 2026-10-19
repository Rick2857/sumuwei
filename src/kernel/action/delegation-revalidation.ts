/**
 * 委派到达时，执行端的**重新核对**（[`ADR-146`](../../../docs/adr/ADR-146-remote-tool-execution.md) `D03`）。
 *
 * ============================================================================
 *  这就是「不盲目，但不是全盲」的那一半
 * ============================================================================
 *
 * ```text
 * 核心（服务器）  决定「该不该做」 —— 策略 / 权限 / 额度 / 目标解析
 * 执行端（本机）  决定「现在还能不能做」 —— **此刻**的前台窗口 / 控件是否还在
 * ```
 *
 * ⚠️ 为什么核心那边的判断**不能**直接拿来用：
 *    核心的快照是**几秒到几十秒前**的。那之后用户可能已经切了窗口。
 *    **在过期快照上做的点击，就是在陌生界面上盲点。**
 *    ⇒ 委派只带「当时要做什么」，不带「当时那会儿是真的」。
 *
 * ⚠️ 为什么也不能"一律执行端说了算"：
 *    如果执行端只检查"现在能不能点"，那就等于**丢掉了**核心那边的策略判断。
 *    ⇒ 核心的 `admission` 已经**先于**这一行做完了（见 `action-delegation.ts`）；
 *    执行端这一层**只**加不减。
 *
 * ============================================================================
 *  纯函数：可注入快照 ⇒ 不需要真开窗口就能验证结构
 * ============================================================================
 *
 * ⚠️ 真机档（M-03 / M-04）**仍必须**在有人在场时跑：那一档要真点鼠标。
 *    本模块只让"核对逻辑本身对不对"变成可离线判据，**不能替代**真机档。
 */

import { DESKTOP_ACTION_KINDS, DESKTOP_ACTION_TIMEOUT_MS } from './desktop-capability.ts'

/** 执行端此刻看到的桌面形状（⚠️ 字段名按 windows-mcp **真读回**定的，见 `desktop-executor-adapter.ts`） */
export interface DesktopSnapshot {
  /** 前台窗口名（由 `state.activeWindow.name` 取出，**不是**对象本身） */
  readonly activeWindow: string
  readonly windows: ReadonlyArray<{
    readonly name: string
    readonly elements: ReadonlyArray<{
      /** ⚠️ 窗口内序号（上游按窗口过滤时会重新编号，全局序号会 `stale_reference`） */
      readonly index: number
      readonly name: string
      /** 密码类控件**永远**不可操作 */
      readonly actionable: boolean
    }>
  }>
  /**
   * 这一份快照**是不是被截断过**（真机实测：`elementsTotal` 常常远超 `maxElements`）。
   *
   * ⚠️ 为何要带它：截断时"某序号**不**在这份快照里"有两个**互不相同**的原因 ——
   *    「序号漂了」与「它根本没被截进来」。两者的正确处置**不一样**，
   *    所以理由码也不能混（见 `executor_element_not_captured`）。
   */
  readonly truncated?: boolean
}

export type RevalidationRejection =
  /** 目标窗口**此刻**不是前台 —— 用户切走了 */
  | 'executor_window_not_foreground'
  /** 那扇窗此刻**已经不在**（关掉了 / 被最小化 / 重名窗口换了个内容） */
  | 'executor_window_gone'
  /** 那个序号此刻**指向别的控件**（列表刷新过，序号漂了） */
  | 'executor_index_moved'
  /**
   * 序号**不在**这份快照里，而这份快照**被截断过**。
   *
   * ⚠️ 与 `executor_index_moved` **分开**：截断意味着"没被截进来"这个可能**不能排除**，
   *    而两者该给排查者的线索完全不同。混成一个码就会把人引向错误的结论
   *    （"序号漂了，去查列表刷新"← 而真相可能是"树太大了没截到"）。
   *    两者都拒绝执行；区别只在**理由说真话**。
   */
  | 'executor_element_not_captured'
  /** 序号在，但**控件名对不上** ⇒ 点到别的东西上了 */
  | 'executor_control_renamed'
  /** 控件此刻不可操作（密码字段 / 已失效） */
  | 'executor_control_not_actionable'
  /** 委派的动作不在闭集里 */
  | 'executor_action_not_allowed'
  /** 委派要的窗口名是空的 —— 那就没有任何东西可核对 */
  | 'executor_window_unspecified'

export type RevalidationVerdict =
  | {
      readonly ok: true
      /**
       * 核对通过后**解析成**的这次动作。
       *
       * ⚠️⚠️ 它**必须带齐 `window` + `index`**，否则执行端拿到手也点不了 ——
       *    `ActionExecutorServer` 的 `execute(action)` 只收这一个对象，
       *    没有第二份参数来源。⚠️ 而且这里带的必须是**此刻读数**里的
       *    窗口名与序号，**不是**线上那个（线上那个是几十秒前的）。
       */
      readonly action: {
        readonly kind: string
        readonly window: string
        readonly index: number
        readonly content?: string
        readonly name?: string
      }
    }
  | { readonly ok: false; readonly rejection: RevalidationRejection; readonly detail?: string }

/**
 * 用**执行端此刻的**快照，重新核对一次线上来的委派。
 *
 * ⚠️ 这个函数**不评估风险、不查权限、不问额度**（`D02`）——
 *    那些在委派发出去之前就已经过了。它只回答"现在还能不能做"。
 */
export function revalidateAgainstSnapshot(
  snapshot: DesktopSnapshot,
  request: {
    readonly action: string
    readonly window?: string
    readonly index?: number
    /**
     * 核心理**当时**看到的控件名。
     *
     * ⚠️ 它是**要被推翻的**，不是权威：执行端拿它和**此刻**的读数比。
     *   不一致就拒（序号漂了 / 列表刷新了 / 那已经是另一个控件了）。
     * ⚠️ 缺省（`undefined` / `''`）⇒ 这一条**跳过**，但**不等于"不用核对"**：
     *   只是没有可比的基准。保证"委派带全控件名"是**核心侧**的义务。
     */
    readonly name?: string
    readonly content?: string
  }
): RevalidationVerdict {
  if (!DESKTOP_ACTION_KINDS.includes(request.action as never)) {
    return { ok: false, rejection: 'executor_action_not_allowed' }
  }
  if (typeof request.window !== 'string' || request.window === '') {
    return { ok: false, rejection: 'executor_window_unspecified' }
  }

  // ① 窗口此刻是不是前台。⚠️ 先判这个再找窗口：不是前台的话，
  //    后面两条核对**没有意义**（在后台窗口上按序号点，点的不是用户以为的地方）
  if (snapshot.activeWindow !== request.window) {
    return {
      ok: false,
      rejection: 'executor_window_not_foreground',
      // ⚠️ detail 只带**此刻的前台窗口名**，不是用户内容；用于诊断"她点错了哪扇窗"
      detail: `active=${snapshot.activeWindow}`,
    }
  }

  // ② 那扇窗此刻还在不在
  const win = snapshot.windows.find((w) => w.name === request.window)
  if (win === undefined) return { ok: false, rejection: 'executor_window_gone' }

  // ③ 序号此刻指向谁
  const element = win.elements.find((e) => e.index === request.index)
  if (element === undefined) {
    /*
     * ⚠️ 截断 vs 漂了：**理由要说真话**。
     *    截断时"不在快照里"不能断言为"漂了" —— 它可能根本没被截进来。
     *    两者都拒执行，但给排查者的线索完全不同（见 ExecutorRefusal 注释）。
     */
    return snapshot.truncated === true
      ? { ok: false, rejection: 'executor_element_not_captured', detail: 'snapshot_truncated' }
      : { ok: false, rejection: 'executor_index_moved' }
  }

  // ④ 序号在，但**控件名对不上** ⇒ 那就是点到了别的东西
  //    ⚠️ 线上带控件名时才有这一条；核心没给名就跳过（"没给" ≠ "不用核对"，
  //    但也没有可比的基准 —— 那由核心侧保证给全，执行端如实说"这一条我核不了"）
  const claimedName = request.name
  if (typeof claimedName === 'string' && claimedName !== '' && claimedName !== element.name) {
    return { ok: false, rejection: 'executor_control_renamed', detail: `now=${element.name}` }
  }

  // ⑤ 可操作性（密码字段永远不）
  if (!element.actionable) return { ok: false, rejection: 'executor_control_not_actionable' }

  return {
    ok: true,
    action: {
      kind: request.action,
      // ⚠️ 窗口名与序号取自**此刻**的读数（`win` / `element`），
      //    **不是**线上那次的 `request.window` / `request.index`。
      window: win.name,
      index: element.index,
      ...(request.content === undefined ? {} : { content: request.content }),
      ...(element.name === '' ? {} : { name: element.name }),
    },
  }
}

export { DESKTOP_ACTION_TIMEOUT_MS }
