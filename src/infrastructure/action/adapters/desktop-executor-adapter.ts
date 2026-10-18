/**
 * 执行端 ↔ 真 windows-mcp worker 的接线（ADR-146 `D03`）。
 *
 * ============================================================================
 *  这一层只做**翻译**，不做判断
 * ============================================================================
 *
 * - `snapshot` ⇒ worker 的 `op:'state'`（真去读**此刻**的桌面）
 * - `execute` ⇒ worker 的 `op:'act'`（核对已经在上层做过了，这里只传）
 *
 * ⚠️ **它复用既有 worker，不另起一套**：
 *    上游那三重复核（索引 → 控件名 → 所属窗口 → 前台窗口）在 worker 里
 *    **本来就有一份**（ADR-106 边界 ③）。这里**不复制**它，只在**它之前**
 *    多加一层"此刻还成立吗"（`delegation-revalidation.ts`）。
 *    ⇒ 两次核对是**串联**关系，不是重复实现。
 *
 * ⚠️⚠️ **写它不等于跑它。**
 *    真正调用会**真的动鼠标键盘**。M-03/M-04 的真机档必须**人在场**
 *    （ADR-106 纪律不进 CI）。本文件本身只是接线，不含任何"跑一次试试"。
 */

import { runDesktopWorker } from './desktop-control.ts'
import {
  DESKTOP_CONTROL_PROTOCOL,
  DESKTOP_MCP_VERSION,
  defaultDesktopControlPython,
  defaultDesktopControlWorker,
} from './desktop-control-assets.ts'
import { DESKTOP_ELEMENT_LIMIT, DESKTOP_INSPECT_TIMEOUT_MS, DESKTOP_ACTION_TIMEOUT_MS } from '../../../kernel/action/desktop-capability.ts'
import type { DesktopSnapshot } from '../../../kernel/action/delegation-revalidation.ts'

export interface RealWorkerOptions {
  readonly python?: string
  readonly workerScript?: string
  readonly maxElements?: number
  readonly onLog?: (message: string) => void
}

function headerOf(extra: Record<string, unknown>): Record<string, unknown> {
  // ⚠️ `expectedVersion` 是 worker 侧的**自检**（上游包版本对不上就拒跑），
  //    与 ADR-146 `D07` 的**线协议版本**是两件事，名字像但不通用。
  return { protocol: DESKTOP_CONTROL_PROTOCOL, expectedVersion: DESKTOP_MCP_VERSION, ...extra }
}

async function call(options: RealWorkerOptions, extra: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  const run = await runDesktopWorker({
    executable: options.python ?? defaultDesktopControlPython(),
    workerScript: options.workerScript ?? defaultDesktopControlWorker(),
    header: headerOf(extra),
    timeoutMs,
  })
  // ⚠️ 读回解析失败（`parseProblem`）与"worker 交回空结果"是**两件事**，分开说
  if (run.parseProblem !== undefined) throw new Error(String(run.parseProblem))
  const parsed = run.result
  if (parsed === undefined) {
    throw new Error(
      `worker 没有交回可判定的结果（exit=${String(run.exitCode)}` +
      `${run.killReason === undefined ? '' : ` kill=${run.killReason}`}）`,
    )
  }
  if (Object.keys(parsed).length === 0) throw new Error('worker 交回的是空结果')
  return parsed
}

/**
 * 取**此刻**的桌面快照（ADR-146 `D03` 的输入）。
 *
 * ⚠️ 任何读不到 / 读不全 ⇒ **抛异常**。上层（`executor-server.ts`）把它归成
 *    `executor_snapshot_unavailable` 并**拒绝执行**。
 *    ⚠️ 绝不返回"半个快照"或"空快照当正常" —— 那等于让上层以为核对过了。
 */
export async function readLiveSnapshot(options: RealWorkerOptions = {}): Promise<DesktopSnapshot> {
  const result = await call(options, {
    op: 'state',
    maxElements: options.maxElements ?? DESKTOP_ELEMENT_LIMIT,
  }, DESKTOP_INSPECT_TIMEOUT_MS)

  const state = (result['state'] ?? {}) as Record<string, unknown>

  /*
   * ⚠️⚠️ 下面三处字段名**按真读回定**，不是按想象定的（本轮真机只读探针抓到的）：
   *     · `state.activeWindow` 是**对象** `{name, handle, status, width, height, processId}`，**不是**字符串
   *     · 元素在 `state.elements[]`，是**扁平**数组（靠每项的 `window` 字段归属），**不是** `windows[].elements`
   *     · **没有** `actionable` 字段；有的是 `password`（密码类控件才是不可操作的那些）
   *   我第一版三条全猜错了，而且离线门**抓不到** —— 那些门喂的是我自己注入的假快照，
   *   形状自洽当然绿。⇒ 教训：**形状判据必须有一道对着真生产者跑**，见
   *   `scripts/postlv2-executor-readonly-probe.ts`（只读，可以安全地随时跑）。
   */
  const activeRaw = state['activeWindow']
  const activeName = typeof activeRaw === 'string'
    ? activeRaw
    : typeof (activeRaw as Record<string, unknown> | undefined)?.['name'] === 'string'
      ? String((activeRaw as Record<string, unknown>)['name'])
      : ''
  // ⚠️ 读不到前台窗口名 ⇒ 抛。**不能**当成"前台是空"然后让所有核对都失败 ——
  //    那是两回事：一个是"读不到"，一个是"读到了但没有"。
  if (activeName === '') throw new Error('worker 没有报出前台窗口名（AT-SPI 可能不可用）')

  const rawElements = state['elements']
  if (!Array.isArray(rawElements)) throw new Error('worker 的读回里没有 state.elements 数组')

  // 扁平 → 按 `window` 字段分组（`byWindow` 的键来自**元素**，不来自 windows 列表）
  type Bucket = Array<{ index: number; name: string; actionable: boolean }>
  const byWindow = new Map<string, Bucket>()
  for (const raw of rawElements) {
    const el = (raw ?? {}) as Record<string, unknown>
    const windowName = typeof el['window'] === 'string' ? el['window'] : ''
    if (windowName === '') continue
    const bucket = byWindow.get(windowName) ?? []
    /*
     * ⚠️ 可操作性**从 `password` 推**，不是读一个不存在的 `actionable` 字段。
     *    缺省按**不可操作**处理 —— "读不到就当可以点"是这条链上最危险的默认值。
     */
    bucket.push({
      index: typeof el['index'] === 'number' ? el['index'] : -1,
      name: typeof el['name'] === 'string' ? el['name'] : '',
      actionable: el['password'] !== true,
    })
    byWindow.set(windowName, bucket)
  }

  const rawWindows = state['windows']
  /*
   * ⚠️⚠️ 窗口名必须取**并集**，不能只取 `state.windows[]` 的名字。
   *    真机实测：前台窗口**不在** `state.windows[]` 里（那 4 个是最小化的后台窗口），
   *    只取那份 ⇒ **一个元素都挂不上** ⇒ 元素数 0 ⇒ 全部核对都会误判成"序号不在"。
   *    这条是被只读探针当场抓到的，不是推理出来的。
   */
  const names = new Set<string>(byWindow.keys())
  if (Array.isArray(rawWindows)) {
    for (const w of rawWindows) {
      const n = ((w ?? {}) as Record<string, unknown>)['name']
      if (typeof n === 'string' && n !== '') names.add(n)
    }
  }
  const windows = [...names].map((name) => ({ name, elements: byWindow.get(name) ?? [] }))

  // ⚠️ `truncated` 必须**如实传下去**：它决定"序号不在快照里"该怎么归因（见 revalidation ③）
  const truncated = state['truncated'] === true
  return { activeWindow: activeName, windows, truncated }
}

/**
 * 构造 `op:'act'` 的头。**抽成纯函数**是为了能拿它去对着**真 worker** 验形状。
 *
 * ⚠️ 键名不是猜的：`desktop-control-worker.py:506-529` 里
 *   · 窗口动作（`switch_app`/`launch_app`）会**拒收** `index`/`name`/`content`（或 `window`…）
 *   · 元素动作（`click`/`type`/…）走 `resolve_target`，用的正是 `window`/`index`/`name`
 *   ⇒ 本函数**按元素动作**构造，**不**混进 `handle`（worker 对它另有语义）。
 * ⚠️ `dryRun` 只在**验证**时给：`worker` 侧会跑完整条核对链但**不动手**
 *   （`desktop-control-worker.py:538`）—— 仓库自己的只读门就是这么用的。
 */
export function buildActHeader(
  action: { readonly kind: string; readonly content?: string; readonly name?: string },
  args: { readonly window?: string; readonly index?: number; readonly name?: string },
  dryRun?: boolean
): Record<string, unknown> {
  return headerOf({
    op: 'act',
    action: action.kind,
    ...(args.window === undefined ? {} : { window: args.window }),
    ...(args.index === undefined ? {} : { index: args.index }),
    ...(args.name === undefined ? {} : { name: args.name }),
    ...(action.content === undefined ? {} : { content: action.content }),
    ...(dryRun === true ? { dryRun: true } : {}),
  })
}

/**
 * 真的做一次。
 *
 * ⚠️ ⚠️ 调用它会**真的动鼠标键盘**。只有上层核对通过、且**真机档里有人在场**时才走。
 * ⚠️ 不接受 `dryRun`：真机档要的就是"真做了"，干跑证明不了任何事
 *    （要验形状请走 {@link buildActHeader} + worker 的 `dryRun`）。
 */
export async function performLiveAction(
  action: { readonly kind: string; readonly content?: string; readonly name?: string },
  args: { readonly window?: string; readonly index?: number; readonly name?: string },
  options: RealWorkerOptions = {}
): Promise<void> {
  await call(options, buildActHeader(action, args), DESKTOP_ACTION_TIMEOUT_MS)
  options.onLog?.(`已执行 ${action.kind}${args.window === undefined ? '' : ` 于「${args.window}」`}`)
}
