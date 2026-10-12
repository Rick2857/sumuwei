/**
 * 桌面查看 / 操作的适配器（[`ADR-106`](../../../../docs/adr/ADR-106-desktop-control.md)）。
 *
 * ============================================================================
 *  形状：与 `image-ocr.ts` 同型（**一次调用一个新进程**）
 * ============================================================================
 * ```text
 * 父进程（Node）                       子进程（固定 venv 的 python）
 *   spawn(venv python, worker.py)
 *   stdin  第 1 行 = JSON 头  ─────────▶  worker 读头、跑 UIA、写结果
 *   stdout 恰好一行 RESULT=<json> ◀─────  （其余一律 stderr）
 *   超时 / 取消 ⇒ SIGKILL + 等它真的 close
 * ```
 * ⚠️ 为什么每次一个新进程：生命周期（启动 / 收尾 / 僵尸 / 并发）是一条**新的**责任链，
 *    而首版的收益只有时延。代价如实登记（ADR-106 `L-DC-02`）。
 *
 * ============================================================================
 *  三条边界（每条都有机器闸）
 * ============================================================================
 * ① **正文只走当轮内容**：worker 交回的桌面文字进 `turnContent`（内存载体），
 *    账本 / trace / 开发者面只收 `TurnContentRef`（无正文）。失败详情里**不放**
 *    桌面文字（只放具名码与计数）。
 * ② **要输入的正文只走私有暂存**：`content` 是 `TASK_STAGED_ARG_KEYS` 的成员 ⇒
 *    执行环把它换成 `payloadRef`；拿不到引用就失败关闭，绝不"输入一个空串"。
 * ③ **不做半懂的操作**：动作前重新核对"索引 → 控件名 → 所属窗口 → 前台窗口"，
 *    任何一条不成立就失败关闭（worker 侧判定，见 `desktop-control-worker.py`）。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { ActionFailure } from '../../../kernel/action/errors.ts'
import { ActionFailureError, actionFailure } from '../../../kernel/action/errors.ts'
import { stringArg, type AdapterExecuteInput, type AdapterOutcome, type CapabilityAdapter } from '../../../kernel/action/executor-port.ts'
import {
  DESKTOP_ACTION_KINDS,
  DESKTOP_APPS_OPERATION,
  DESKTOP_ACTION_TIMEOUT_MS,
  DESKTOP_ELEMENT_LIMIT,
  DESKTOP_INSPECT,
  DESKTOP_INSPECT_OPERATION,
  DESKTOP_INSPECT_TIMEOUT_MS,
  DESKTOP_NAME_MAX_CHARS,
  DESKTOP_OPERATE,
  DESKTOP_OPERATE_OPERATION,
  DESKTOP_STATE_MAX_CHARS,
  DESKTOP_TYPE_MAX_CHARS,
  isDesktopActionKind,
  type DesktopActionKind,
} from '../../../kernel/action/desktop-capability.ts'
import type { PayloadStagingPort } from '../../../kernel/action/payload-staging.ts'
import type { DesktopStateTurnContent } from '../../../kernel/contracts/turn-content.ts'
import {
  defaultDesktopControlPython,
  defaultDesktopControlWorker,
  DESKTOP_CONTROL_PROTOCOL,
  DESKTOP_CONTROL_RESULT_PREFIX,
  DESKTOP_MCP_VERSION,
} from './desktop-control-assets.ts'

/** 子进程最多被记下多少 stdout / stderr 字符（先例 `MAX_CAPTURED_STDIO`） */
const MAX_CAPTURED_STDIO = 64 * 1024

export interface DesktopControlOptions {
  /** 独立 venv 的解释器（缺省 = `defaultDesktopControlPython()`） */
  pythonPath?: string
  /** worker 脚本（缺省 = 同目录的 `desktop-control-worker.py`） */
  workerPath?: string
  timeoutMs?: number
  /** 子进程环境（缺省继承 `process.env`；门里据此注入夹具） */
  env?: NodeJS.ProcessEnv
  /** 私有暂存（**必须有**：`type` 的正文只从它来） */
  staging?: PayloadStagingPort
  /** 期望的上游版本（缺省 = 固定的 0.8.7；门里据此构造负控） */
  expectedVersion?: string
}

interface WorkerRun {
  exitCode: number | null
  signal: NodeJS.Signals | null
  killReason?: 'timeout' | 'cancelled'
  releasedMs: number
  stdout: string
  stderr: string
  result?: Record<string, unknown>
  parseProblem?: string
}

function roundMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : 0
}

function intOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

/**
 * 调用方可以通过 `args.signal` / `args.abortSignal` 传入取消信号（形状不认识就当没给）。
 *
 * ⚠️ 与 `image-ocr.ts` 的 `abortSignalOf()` **同形不同模块**：那一个住在 OCR 适配器里
 *    （它是那个文件的私有约定），这里照抄形状而不是 import 整个 OCR 模块
 *    （后者会把一条重依赖链拉进桌面适配器的模块图）。
 */
function abortSignalOf(args: Record<string, unknown>): AbortSignal | undefined {
  const candidate = args.signal ?? args.abortSignal
  if (candidate === null || typeof candidate !== 'object') return undefined
  const maybe = candidate as {
    aborted?: unknown
    addEventListener?: unknown
    removeEventListener?: unknown
  }
  if (
    typeof maybe.aborted !== 'boolean' ||
    typeof maybe.addEventListener !== 'function' ||
    typeof maybe.removeEventListener !== 'function'
  ) {
    return undefined
  }
  return candidate as AbortSignal
}
export function parseWorkerStdout(stdout: string): {
  result?: Record<string, unknown>
  problem?: string
} {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const resultLines = lines.filter((line) => line.startsWith(DESKTOP_CONTROL_RESULT_PREFIX))
  if (resultLines.length === 0) return { problem: 'stdout 上没有结果行' }
  if (lines.length !== 1) {
    return { problem: `stdout 上有 ${String(lines.length)} 行（协议要求恰好一行）` }
  }
  try {
    const parsed = JSON.parse(resultLines[0].slice(DESKTOP_CONTROL_RESULT_PREFIX.length))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { problem: '结果行不是 JSON 对象' }
    }
    return { result: parsed as Record<string, unknown> }
  } catch {
    return { problem: '结果行不是合法 JSON' }
  }
}

/**
 * 把 worker 的**具名码**映射到内核的**闭集失败码**（`ActionFailureCode` 只有十个）。
 *
 * ⚠️ 原始具名码不丢：它进 `details.workerCode` —— 于是"为什么没动手"既能被策略层
 *    归一，也能被事后审计逐字查回。
 */
export function kernelFailureOf(workerCode: string, message: string): ActionFailure {
  const details = { workerCode }
  switch (workerCode) {
    case 'window_not_found':
      return actionFailure('target_not_found', message, details)
    case 'stale_reference':
      return actionFailure('target_not_found', message, details)
    case 'target_ambiguous':
    case 'window_mismatch':
    case 'focus_changed':
      return actionFailure('target_uncertain', message, details)
    case 'runtime_mismatch':
    case 'not_actionable':
    case 'unsupported_action':
      return actionFailure('unsupported', message, details)
    case 'validation_failed':
      return actionFailure('validation_failed', message, details)
    case 'protocol_error':
      return actionFailure('execution_failed', message, details)
    default:
      return actionFailure('execution_failed', message, details)
  }
}

/**
 * 跑一次 worker。
 *
 * 三条纪律（与 `runOcrWorker` 逐条同源）：
 *   · 桌面文字**只走 stdout**，头里没有"读某个文件当状态"的入口；
 *   · 超时 / 取消 ⇒ `SIGKILL` + **等它真的 `close`**；
 *   · 无论走哪条路，返回之前子进程一定已经结束。
 */
export async function runDesktopWorker(input: {
  executable: string
  workerScript: string
  header: Record<string, unknown>
  timeoutMs: number
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}): Promise<WorkerRun> {
  const startedAt = performance.now()
  const child = spawn(input.executable, ['-X', 'utf8', input.workerScript], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: input.env,
  })

  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    if (stdout.length < MAX_CAPTURED_STDIO) stdout += chunk
  })
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length < MAX_CAPTURED_STDIO) stderr += chunk
  })
  // 子进程被杀之后写 stdin 会异步 EPIPE —— 必须有监听者，否则父进程自己崩
  child.stdin?.on('error', () => {})

  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClosed) => {
    child.once('close', (code, signal) => {
      resolveClosed({ code, signal })
    })
  })
  child.once('error', () => {
    /* spawn 本身失败时 `close` 也会到（code=null）；这里只避免未处理事件 */
  })

  let killReason: 'timeout' | 'cancelled' | undefined
  const kill = (reason: 'timeout' | 'cancelled'): void => {
    if (killReason === undefined) killReason = reason
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    child.stdin?.destroy()
  }

  const timer = setTimeout(() => {
    kill('timeout')
  }, input.timeoutMs)
  const signal = input.signal
  const onAbort = (): void => {
    kill('cancelled')
  }
  if (signal !== undefined) {
    if (signal.aborted) kill('cancelled')
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    child.stdin?.write(`${JSON.stringify(input.header)}\n`)
    child.stdin?.end()
  } catch {
    /* stdin 已经不可写：由退出码 / parseProblem 说明问题，不在这里抛 */
  }

  const { code, signal: exitSignal } = await closed
  clearTimeout(timer)
  if (signal !== undefined) signal.removeEventListener('abort', onAbort)

  const parsed = parseWorkerStdout(stdout)
  return {
    exitCode: code,
    signal: exitSignal,
    ...(killReason !== undefined ? { killReason } : {}),
    releasedMs: roundMs(performance.now() - startedAt),
    stdout,
    stderr,
    ...(parsed.result !== undefined ? { result: parsed.result } : {}),
    ...(parsed.problem !== undefined ? { parseProblem: parsed.problem } : {}),
  }
}

function hexDigestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 把 worker 的状态对象转成**当轮内容**（有界；超出即截断并如实标记）。
 *
 * ⚠️ `scope.totalChars` 取的是 **worker 报的裁剪前字符数**（`textCharsBeforeClip`），
 *    不是交回来的那一段的长度 —— 否则"裁剪"这件事会在这一层消失
 *    （2026-10-05 实测：worker 先裁到 4000+省略号，适配器再拿 4001 判上限
 *     ⇒ `truncated` 永远是 false。范围事实必须由**知道原始长度**的那一侧给出）。
 * ⚠️ `scope.includedChars` 必须等于 `text.length`（契约的机器判据）。
 */
export function desktopTurnContentOf(input: {
  actionId: string
  capability: string
  operation: string
  text: string
  /** 裁剪前的字符数（缺省 = `text.length`，即"没有裁剪"） */
  charsBeforeClip?: number
  /** worker 自报"它裁剪过" */
  workerClipped?: boolean
  windowCount: number
  elementsListed: number
  stateTruncated: boolean
  windowFilter?: string
  action?: DesktopActionKind
}): DesktopStateTurnContent {
  const totalChars = Math.max(input.charsBeforeClip ?? input.text.length, input.text.length)
  const shaped =
    input.text.length > DESKTOP_STATE_MAX_CHARS
      ? `${input.text.slice(0, DESKTOP_STATE_MAX_CHARS)}…`
      : input.text
  const clipped = input.workerClipped === true || shaped.length < totalChars
  const facts = [
    input.operation === DESKTOP_APPS_OPERATION
      ? '当前内容是系统应用目录与三个系统文件夹（回收站 / 此电脑 / 控制面板），不是窗口或控件快照；窗口/元素计数不表示桌面为空'
      : `窗口 ${String(input.windowCount)} 个，列出可交互元素 ${String(input.elementsListed)} 个`,
    input.stateTruncated
      ? '上游快照在上限处被截断：有些元素**没有**被访问到（这不是"桌面上只有这些"）'
      : '上游快照没有被截断',
    clipped
      ? `这份文本本身被截断过（原始 ${String(totalChars)} 字符 ⇒ 取了 ${String(shaped.length)} 字符）`
      : '这份文本没有被截断',
    input.action === undefined
      ? '密码字段不取名、不取值；这次只读，没有截图、没有点击、没有输入'
      : '密码字段不取名、不取值；下方为动作后的实际桌面读回，没有截图',
    ...(input.windowFilter !== undefined ? [`只看窗口名含「${input.windowFilter}」的部分`] : []),
    ...(input.action !== undefined ? [`这次做过的动作：${input.action}`] : []),
    ...(input.action === 'launch_app' ? ['启动请求已提交；是否出现目标窗口只能依据实际读回，不能仅凭提交成功说已打开'] : []),
  ]
  return {
    contentId: `${input.actionId}:${input.capability === DESKTOP_INSPECT ? 'desktop-state' : 'desktop-readback'}`,
    kind: 'desktop-state',
    capability: input.capability,
    operation: input.operation,
    sourceKind: 'desktop-ui',
    /*
     * `resourceRef` 刻意**不是路径**：桌面没有路径。这里给的是"看的是哪个窗口"
     * （省略 = 整个桌面）—— 它是引用，不是内容。
     */
    ...(input.windowFilter !== undefined ? { resourceRef: input.windowFilter } : {}),
    resultFingerprint: hexDigestOf(input.text),
    scope: {
      totalChars,
      includedChars: shaped.length,
      truncated: clipped,
    },
    facts,
    text: shaped,
    windowCount: input.windowCount,
    elementCount: input.elementsListed,
    stateTruncated: input.stateTruncated,
    ...(input.windowFilter !== undefined ? { windowFilter: input.windowFilter } : {}),
    ...(input.action !== undefined ? { action: input.action } : {}),
  }
}

/**
 * 两个适配器（**同一个 worker**，两个能力）。
 *
 * ⚠️ 返回的是**两个**适配器而不是一个：`CapabilityAdapter.capabilityId` 只能有一个，
 *    而"看"与"动手"是两个能力（登记表里就是两条）。
 */
export function createDesktopAdapters(options: DesktopControlOptions = {}): CapabilityAdapter[] {
  const python = options.pythonPath ?? defaultDesktopControlPython()
  const worker =
    options.workerPath ?? defaultDesktopControlWorker()
  const expectedVersion = options.expectedVersion ?? DESKTOP_MCP_VERSION

  async function callWorker(
    input: AdapterExecuteInput,
    header: Record<string, unknown>,
    timeoutMs: number
  ): Promise<Record<string, unknown>> {
    const signal = abortSignalOf(input.args)
    const run = await runDesktopWorker({
      executable: python,
      workerScript: worker,
      header: { protocol: DESKTOP_CONTROL_PROTOCOL, expectedVersion, ...header },
      timeoutMs,
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(signal !== undefined ? { signal } : {}),
    })
    if (run.killReason === 'timeout') {
      throw new ActionFailureError(
        actionFailure('timeout', `桌面调用超过 ${String(timeoutMs)} ms，工作器已被杀掉并确认退出`, {
          releasedMs: run.releasedMs,
        })
      )
    }
    if (run.killReason === 'cancelled') {
      throw new ActionFailureError(actionFailure('cancelled', '桌面调用被取消'))
    }
    if (run.result === undefined) {
      /*
       * ⚠️ 失败信息里**不放** stdout / stderr 正文：那里可能有桌面文字。
       *    只放"协议不符在哪一步"与退出码。
       */
      throw new ActionFailureError(
        actionFailure(
          'execution_failed',
          `桌面工作器没有给出可解析的结果（${run.parseProblem ?? '未知'}；exit=${String(run.exitCode)}；signal=${String(run.signal)}）`,
          { releasedMs: run.releasedMs, stderrChars: run.stderr.length }
        )
      )
    }
    const result = run.result
    if (result.ok !== true) {
      const workerCode = typeof result.code === 'string' ? result.code : 'execution_failed'
      const message = typeof result.message === 'string' ? result.message : '桌面调用失败'
      throw new ActionFailureError(kernelFailureOf(workerCode, message))
    }
    return result
  }

  function stateOf(result: Record<string, unknown>): {
    text: string
    windows: number
    elements: number
    truncated: boolean
    charsBeforeClip: number | undefined
    workerClipped: boolean
  } {
    const state = result.state
    if (state === null || typeof state !== 'object') {
      throw new ActionFailureError(
        actionFailure('execution_failed', '桌面工作器返回的 state 不是对象（协议不符）')
      )
    }
    const record = state as Record<string, unknown>
    const text = typeof result.text === 'string' ? result.text : ''
    const windows = intOf(record.windowsTotal) ?? 0
    const elements = Array.isArray(record.elements) ? record.elements.length : 0
    const truncated = record.truncated === true
    return {
      text,
      windows,
      elements,
      truncated,
      charsBeforeClip: intOf(result.textCharsBeforeClip),
      workerClipped: result.textClipped === true,
    }
  }

  const inspectAdapter: CapabilityAdapter = {
    capabilityId: DESKTOP_INSPECT,
    async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
      const apps = input.operation === DESKTOP_APPS_OPERATION
      if (!apps && input.operation !== DESKTOP_INSPECT_OPERATION) {
        throw new ActionFailureError(actionFailure('unsupported', '桌面查看只支持 state / apps'))
      }
      const window = stringArg(input.args, 'window')
      const query = stringArg(input.args, 'query')
      if ((apps && input.args.window !== undefined) || (!apps && input.args.query !== undefined) ||
        (input.args.query !== undefined && query === undefined) ||
        (query !== undefined && query.length > DESKTOP_NAME_MAX_CHARS)) {
        throw new ActionFailureError(actionFailure('validation_failed', 'state 仅接受 window，apps 仅接受有界 query'))
      }
      const requested = intOf(input.args.maxElements)
      const maxElements = Math.max(1, Math.min(requested ?? DESKTOP_ELEMENT_LIMIT, DESKTOP_ELEMENT_LIMIT))
      const result = await callWorker(
        input,
        { op: apps ? 'apps' : 'state', maxElements,
          ...(apps ? (query !== undefined ? { query } : {}) : (window !== undefined ? { window } : {})) },
        options.timeoutMs ?? DESKTOP_INSPECT_TIMEOUT_MS
      )
      const state = stateOf(result)
      if (state.text.trim() === '') {
        throw new ActionFailureError(
          actionFailure('target_not_found', '这次没有读到任何可说的桌面内容（元素列表是空的）')
        )
      }
      const content = desktopTurnContentOf({
        actionId: String(input.actionId),
        capability: DESKTOP_INSPECT,
        operation: input.operation,
        text: state.text,
        windowCount: state.windows,
        elementsListed: state.elements,
        stateTruncated: state.truncated,
        ...(state.charsBeforeClip !== undefined ? { charsBeforeClip: state.charsBeforeClip } : {}),
        workerClipped: state.workerClipped,
        ...(!apps && window !== undefined ? { windowFilter: window } : {}),
      })
      return {
        effect: {
          kind: 'content_read',
          detail: apps ? `应用目录：列出 ${String(result.appsListed ?? 0)} 项` :
            `桌面状态：${String(state.windows)} 个窗口 / ${String(state.elements)} 个元素`,
          fingerprint: content.resultFingerprint,
          bytes: state.text.length,
        },
        evidence: [
          {
            kind: 'adapter',
            detail:
              `desktop.inspect windows=${String(state.windows)} elements=${String(state.elements)}` +
              ` truncated=${String(state.truncated)} via windows-mcp ${expectedVersion}`,
            ...(window !== undefined ? { ref: `window:${window.slice(0, DESKTOP_NAME_MAX_CHARS)}` } : {}),
          },
        ],
        turnContent: [content],
      }
    },
  }

  const operateAdapter: CapabilityAdapter = {
    capabilityId: DESKTOP_OPERATE,
    async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
      const action = input.args.action
      if (!isDesktopActionKind(action)) {
        throw new ActionFailureError(
          actionFailure(
            'validation_failed',
            `动作必须是闭集 ${DESKTOP_ACTION_KINDS.join(' / ')} 之一，收到 ${JSON.stringify(action)}`
          )
        )
      }
      const window = stringArg(input.args, 'window')
      const name = stringArg(input.args, 'name')
      const index = intOf(input.args.index)
      const handle = intOf(input.args.handle)
      const validName = (value: string | undefined): boolean => value !== undefined &&
        value.trim() !== '' && value.length <= DESKTOP_NAME_MAX_CHARS && !/[\r\n\0]/.test(value)
      /*
       * 走"控件核对链"的三+一类：click / right_click / double_click / type。
       * ⚠️ `right_click` 的读回**不用** `window` 过滤（下面的 `windowFilter` 只在 click / type
       *    给出）—— 它弹出的上下文菜单是另一个顶层窗口，过滤会把菜单项滤掉。
       */
      const controlAction = action === 'click' || action === 'right_click' ||
        action === 'double_click' || action === 'type'
      if (controlAction && (!validName(window) || !validName(name) || index === undefined || index < 0 || index >= DESKTOP_ELEMENT_LIMIT)) {
        throw new ActionFailureError(
          actionFailure(
            'validation_failed',
            '动手前必须给出它看到过的 window / index / name（三者都要）—— 不允许凭坐标猜'
          )
        )
      }
      if (action === 'switch_app' && (!validName(window) || handle === undefined || handle <= 0 ||
        ['index', 'name', 'content', 'payloadRef'].some(key => input.args[key] !== undefined))) {
        throw new ActionFailureError(actionFailure('validation_failed', 'switch_app 只接受实际窗口的完整 window 标题与正整数 handle'))
      }
      if (action === 'launch_app' && (!validName(name) || /[\\/:]/.test(name!) ||
        ['window', 'index', 'handle', 'content', 'payloadRef'].some(key => input.args[key] !== undefined))) {
        throw new ActionFailureError(actionFailure('validation_failed', 'launch_app 只接受系统应用目录中的完整 name，不接受路径、命令或自定义参数'))
      }

      /* 正文只从私有暂存来（`content` 已被执行环改写成 `payloadRef`）。 */
      let content: string | undefined
      if (action === 'type') {
        const payloadRef = stringArg(input.args, 'payloadRef')
        if (payloadRef === undefined || payloadRef === '') {
          throw new ActionFailureError(
            actionFailure(
              'validation_failed',
              'type 缺少 payloadRef —— 要输入的正文必须经私有暂存传递，不接受直接放在参数里的 content'
            )
          )
        }
        if (options.staging === undefined) {
          throw new ActionFailureError(
            actionFailure(
              'execution_failed',
              '本适配器没有装暂存端口 —— 装配错误，不是用户错误（要输入的正文无处可取）'
            )
          )
        }
        const staged = options.staging.read(payloadRef)
        if (staged === undefined) {
          throw new ActionFailureError(
            actionFailure(
              'validation_failed',
              `载荷 ${payloadRef} 不在私有暂存里（过期或从未放入）—— 拒绝凭引用输入一段取不到的正文`
            )
          )
        }
        content = staged.kind === 'text' ? staged.text : undefined
        if (content === undefined) {
          throw new ActionFailureError(
            actionFailure('validation_failed', `载荷 ${payloadRef} 不是文本（type 只接受文本）`)
          )
        }
        if (content.length > DESKTOP_TYPE_MAX_CHARS) {
          throw new ActionFailureError(
            actionFailure(
              'validation_failed',
              `一次输入的正文超过 ${String(DESKTOP_TYPE_MAX_CHARS)} 个字符（收到 ${String(content.length)}）`
            )
          )
        }
      }

      const result = await callWorker(
        input,
        {
          op: 'act',
          action,
          window,
          index,
          name,
          handle,
          /* 干跑只在**程序**侧给（不在 `TASK_ARG_KEYS` 里 ⇒ 模型给不出这个字段） */
          ...(input.args.dryRun === true ? { dryRun: true } : {}),
          ...(content !== undefined ? { content } : {}),
        },
        options.timeoutMs ?? DESKTOP_ACTION_TIMEOUT_MS
      )
      if (result.dryRun === true) {
        /*
         * 干跑：核对链全部通过、但**没有动手**。
         * ⚠️ 刻意**不**产出当轮内容（没有读回就没有"我看到了什么"），
         *    effect 也如实写"没有变更"。
         */
        const wouldPerform = (result.wouldPerform ?? {}) as Record<string, unknown>
        return {
          effect: {
            kind: 'no_change',
            detail:
              `干跑（未动手）：${action} → ${String(wouldPerform.controlType ?? '')}` +
              `「${String(wouldPerform.name ?? '')}」@${String(wouldPerform.x ?? '')},${String(wouldPerform.y ?? '')}`,
          },
          evidence: [
            {
              kind: 'adapter',
              detail:
                `desktop.operate ${action} DRY-RUN guardChain=passed control=${String(wouldPerform.controlType ?? '')}` +
                ` via windows-mcp ${expectedVersion}`,
            },
          ],
        }
      }
      const performed = (result.performed ?? {}) as Record<string, unknown>
      const readbackText = typeof result.readbackText === 'string' ? result.readbackText : ''
      const readback = (result.readback ?? {}) as Record<string, unknown>
      const content0 = desktopTurnContentOf({
        actionId: String(input.actionId),
        capability: DESKTOP_OPERATE,
        operation: DESKTOP_OPERATE_OPERATION,
        text: readbackText === '' ? `（这次动作后的读回是空的）` : readbackText,
        windowCount: intOf(readback.windowsTotal) ?? 0,
        elementsListed: intOf(readback.elementsTotal) ?? 0,
        stateTruncated: readback.truncated === true,
        ...(intOf(result.readbackCharsBeforeClip) !== undefined ? { charsBeforeClip: intOf(result.readbackCharsBeforeClip)! } : {}),
        workerClipped: result.readbackClipped === true,
        ...((action === 'click' || action === 'type') && window !== undefined ? { windowFilter: window } : {}),
        action,
      })
      /*
       * ⚠️ 证据里**只放**程序事实（动作 / 控件类型 / 窗口 / 坐标 / 字符数）：
       *    输入的正文一个字都不进证据，也不进账本。
       */
      return {
        effect: {
          /*
           * ⚠️ 用 `no_change`（与 `browser.operate` 逐条同源）：`ActionEffect.kind` 是
           *    M4.5 冻结契约里的**闭集**，里面没有"我动了鼠标键盘"这一档；如实表达它的地方
           *    是登记表的 `sideEffect: 'write'` + 下面这条 detail。
           *    "no_change" 在这里的含义是"**没有文件系统变更**"，不是"什么都没发生"。
           */
          kind: 'no_change',
          detail:
            `桌面动作 ${action}：${String(performed.controlType ?? '')}` +
            `「${String(performed.name ?? performed.window ?? '')}」` +
            (action === 'launch_app' ? '，启动请求已提交，窗口是否出现以实际读回为准' :
              action === 'switch_app' ? '，前台句柄已核实' : `@${String(performed.x ?? '')},${String(performed.y ?? '')}`),
          fingerprint: content0.resultFingerprint,
        },
        evidence: [
          {
            kind: 'adapter',
            detail:
              `desktop.operate ${action} control=${String(performed.controlType ?? '')}` +
              ` chars=${String(performed.enteredChars ?? 0)} via windows-mcp ${expectedVersion}`,
            ...(typeof performed.x === 'number' && typeof performed.y === 'number'
              ? { ref: `${String(performed.window ?? window)}@${String(performed.x)},${String(performed.y)}` }
              : {}),
          },
        ],
        turnContent: [content0],
      }
    },
  }

  return [inspectAdapter, operateAdapter]
}

/** worker 脚本的缺省路径（门与开发者面读它用；与适配器缺省同源） */
export function defaultDesktopWorkerPath(): string {
  return fileURLToPath(new URL('./desktop-control-worker.py', import.meta.url))
}
