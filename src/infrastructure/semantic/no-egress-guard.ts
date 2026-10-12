/**
 * M9.5 WP8 —— **不出站守卫**（本地编码路径的硬闸）。
 *
 * ============================================================================
 *  为什么需要一条**硬**守卫，而不是"我们设了 allowRemoteModels=false"
 * ============================================================================
 * ```text
 * `allowRemoteModels = false` 是**库的**一项配置：它管的是"模型文件要不要下载"。
 * 而计划 §12 WP8 要求的是「**无私人文本出站**」—— 那是一句更强的话：
 *   用户那句话（可能含姓名/学校/健康/关系）**任何情况下**都不许离开这台机器。
 * 库的配置不承诺这件事（它只承诺"不从远端取模型"）。
 * ⇒ 于是把"出站"这件事在**子进程里物理封死**：任何 `fetch` 调用立刻抛错。
 *   编码器与它的依赖因此**不可能**把正文送出去 —— 不是"我们没这么写"，
 *   而是"写了就会立刻失败"。
 * ```
 *
 * ⚠️ 安装点必须在**加载推理库之前**（`encoder-worker-entry.ts` 的顶部）——
 *    库在 import 时可能自带初始化。
 * ⚠️ 守卫**只**拦 `fetch` 与 `XMLHttpRequest`；它不拦本地 `node:fs` 读模型
 *    （那是本地路径，且由清单的 sha256 守着）。
 */

/** 守卫命中的错误码（具名，便于在日志里一眼看出"这是一次被拦下的出站"） */
export const EGRESS_GUARD_CODE = 'm95_no_egress_violation'

export class NoEgressViolationError extends Error {
  readonly code = EGRESS_GUARD_CODE
  constructor(target: string) {
    super(
      `[${EGRESS_GUARD_CODE}] 本地语义路径试图出站：${target}\n` +
        '⚠️ 计划 §12 WP8 要求「无私人文本出站」⇒ 语义编码路径**不得**发起任何网络请求。\n' +
        '   若确实需要出站，那是**另一个能力**（需要自己的授权与账本），不是这条路径的一部分。'
    )
    this.name = 'NoEgressViolationError'
  }
}

export interface EgressGuardHandle {
  /** 是否已安装（幂等） */
  readonly installed: boolean
  /** 被拦下的次数（**证明守卫真的在工作**，而不是装了个空壳） */
  readonly blockedCount: number
  /** 观察到过的目标（只记 origin/host，不记查询串 —— 隐私边界适用于日志本身） */
  readonly blockedTargets: readonly string[]
}

let handle: { installed: boolean; blockedCount: number; blockedTargets: string[] } | null = null

/** 只保留 origin/host，**不记**完整 URL（URL 里可能带正文） */
function safeTargetOf(input: unknown): string {
  try {
    const raw = typeof input === 'string' ? input : String((input as { url?: unknown })?.url ?? input)
    const url = new URL(raw)
    return `${url.protocol}//${url.host}/…`
  } catch {
    return '(unparseable)'
  }
}

/**
 * 安装守卫（幂等）。返回的句柄可读 `blockedCount` ——
 * **门会断言它 ≥ 1**，因为"装了个从不触发的守卫"与"没有守卫"在输出上无法区分。
 */
export function installNoEgressGuard(): EgressGuardHandle {
  if (handle !== null) return handle
  const state = { installed: true, blockedCount: 0, blockedTargets: [] as string[] }
  handle = state

  const guard = (target: unknown): never => {
    state.blockedCount += 1
    state.blockedTargets.push(safeTargetOf(target))
    throw new NoEgressViolationError(safeTargetOf(target))
  }

  const globalObject = globalThis as Record<string, unknown>
  globalObject.fetch = ((input: unknown) => guard(input)) as unknown as typeof fetch
  /*
   * 老式路径也封死：有的库会退回 XHR。
   * ⚠️ 这里用 `unknown` 而不是 DOM 的 `XMLHttpRequest` 类型 —— 本仓库的 tsconfig
   *    没有 DOM lib（`node:*` + 标准类型），直接引用那个名字会编译不过。
   */
  globalObject.XMLHttpRequest = class {
    constructor() {
      guard('XMLHttpRequest')
    }
  }

  return handle
}

/** 只读：当前守卫状态（未安装时 `installed: false`）。 */
export function egressGuardStatus(): EgressGuardHandle {
  return handle ?? { installed: false, blockedCount: 0, blockedTargets: [] }
}
