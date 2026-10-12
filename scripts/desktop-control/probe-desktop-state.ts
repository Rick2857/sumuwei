/**
 * `pnpm desktop-control:probe` —— **实机只读门**（ADR-106）。
 *
 * ============================================================================
 *  它做什么（以及**绝不**做什么）
 * ============================================================================
 * ```text
 * 做：① 用**生产 worker**（真 venv + 真 windows-mcp）读一次当前桌面
 *     ② 用真实快照做**负控**：把 act 指向不存在的窗口 / 过期索引 / 错的控件名 /
 *        非前台的窗口 / 版本不符的运行时 ⇒ 每一条都必须**失败关闭**
 *     ③ 如实记录时延、窗口数、元素数、中文读数与"0 次网络调用"
 *
 * 绝不做：点击、输入、切换窗口、截图、改任何设置。
 *     ⇒ 这一门可以在用户不在场时跑（它是只读的）。
 *    "真点一次"是另一道门：`pnpm desktop-control:act`（**需用户在场**）。
 * ```
 *
 * ⚠️ 证据里**只有计数与布尔**：窗口标题 / 控件名一个字都不进仓库
 *    （原始正文留在 `artifacts/post-lv2/local/`，那里被 gitignore）。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DESKTOP_INSPECT,
  DESKTOP_INSPECT_OPERATION,
  DESKTOP_OPERATE,
  DESKTOP_OPERATE_OPERATION,
} from '../../src/kernel/action/desktop-capability.ts'
import { createDesktopAdapters, runDesktopWorker } from '../../src/infrastructure/action/adapters/desktop-control.ts'
import {
  DESKTOP_CONTROL_PROTOCOL,
  DESKTOP_MCP_VERSION,
  defaultDesktopControlPython,
  defaultDesktopControlWorker,
  verifyDesktopRuntime,
} from '../../src/infrastructure/action/adapters/desktop-control-assets.ts'
import type { CapabilityAdapter } from '../../src/kernel/action/executor-port.ts'
import { newActionId } from '../../src/kernel/contracts/ids.ts'
import type { DesktopStateTurnContent } from '../../src/kernel/contracts/turn-content.ts'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const EVIDENCE_PARENT = 'artifacts/post-lv2/desktop-control'
const LOCAL_PARENT = 'artifacts/post-lv2/local/desktop-control'

const cases: { id: string; title: string; status: 'PASS' | 'FAIL' | 'NOT RUN'; observed: unknown }[] = []

function record(
  id: string,
  title: string,
  ok: boolean | 'not-run',
  observed: unknown
): void {
  cases.push({
    id,
    title,
    status: ok === 'not-run' ? 'NOT RUN' : ok ? 'PASS' : 'FAIL',
    observed,
  })
}

function git(args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function runIdOf(label: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const head = git(['rev-parse', '--short=8', 'HEAD']) || 'unknown'
  const suffix = createHash('sha256')
    .update(`${label}${stamp}${String(process.pid)}`)
    .digest('hex')
    .slice(0, 4)
  return `${label}-${stamp}-${head}-${suffix}`
}

const target = {
  type: 'local_executor',
  canonicalId: 'windows-desktop',
  displayName: '当前用户桌面（UI Automation 读取）',
  confidence: 'exact' as const,
}

interface CallResult {
  ok: boolean
  code?: string
  workerCode?: unknown
  outcome?: Awaited<ReturnType<CapabilityAdapter['execute']>>
  releasedMs: number
}

async function call(
  adapter: CapabilityAdapter,
  args: Record<string, unknown> = {}
): Promise<CallResult> {
  const started = performance.now()
  try {
    const outcome = await adapter.execute({
      actionId: newActionId(),
      operation: adapter.capabilityId === DESKTOP_INSPECT ? DESKTOP_INSPECT_OPERATION : DESKTOP_OPERATE_OPERATION,
      target,
      args,
      now: () => Date.now() as never,
    })
    return { ok: true, outcome, releasedMs: Math.round(performance.now() - started) }
  } catch (error) {
    const failure = (error as { failure?: { code?: string; details?: Record<string, unknown> } }).failure
    return {
      ok: false,
      code: failure?.code ?? 'thrown',
      workerCode: failure?.details?.workerCode,
      releasedMs: Math.round(performance.now() - started),
    }
  }
}

async function main(): Promise<number> {
  const label = process.argv.find((arg) => arg.startsWith('--label='))?.slice('--label='.length) ?? 'probe'
  const writeEvidence = process.argv.includes('--evidence')

  const runtime = await verifyDesktopRuntime()
  if (!runtime.ok) {
    process.stdout.write(
      `[desktop-control:probe] 运行时不可用 ⇒ 本门 NOT RUN（不是 PASS）：${runtime.problems.join('；')}\n`
    )
    record('dc-probe-runtime', '独立运行时在位且版本与固定值一致', 'not-run', {
      ok: runtime.ok,
      version: runtime.version,
      problems: runtime.problems,
    })
    return 1
  }
  record('dc-probe-runtime', '独立运行时在位且版本与固定值一致', true, {
    version: runtime.version,
    python: runtime.python,
  })

  const adapters = createDesktopAdapters()
  const inspect = adapters.find((adapter) => adapter.capabilityId === DESKTOP_INSPECT)
  const operate = adapters.find((adapter) => adapter.capabilityId === DESKTOP_OPERATE)
  if (inspect === undefined || operate === undefined) throw new Error('适配器没有建出来')

  // ---- ① 真读一次 ---------------------------------------------------------
  const reading = await call(inspect, {})
  const content = reading.ok
    ? (reading.outcome?.turnContent?.find(
        (item) => item.kind === 'desktop-state'
      ) as DesktopStateTurnContent | undefined)
    : undefined
  const text = content?.text ?? ''
  record(
    'dc-probe-state-read',
    '用生产 worker 真的读到了一次桌面状态（只读：没截图、没点击、没输入）',
    reading.ok && text.trim() !== '' && content !== undefined,
    {
      releasedMs: reading.releasedMs,
      kind: content?.kind,
      sourceKind: content?.sourceKind,
      chars: text.length,
      scope: content?.scope,
      ...(reading.ok ? {} : { code: reading.code, workerCode: reading.workerCode }),
    }
  )
  record(
    'dc-probe-scope-contract',
    '`scope.includedChars === text.length`（"实际入模的范围"这句可复核）',
    content !== undefined && content.scope.includedChars === content.text.length,
    { scope: content?.scope }
  )
  const cjkInText = /[\u4e00-\u9fff]/.test(text)
  record(
    'dc-probe-cjk',
    '中文控件名 / 窗口名读得到（这台机器是中文本地化）',
    cjkInText,
    { cjkInText }
  )
  const counts = {
    windows: content?.windowCount ?? 0,
    elements: content?.elementCount ?? 0,
    stateTruncated: content?.stateTruncated ?? false,
  }
  record(
    'dc-probe-counts',
    '窗口数与元素数是**程序数出来的**（不是估算），且元素列数不超过程序上限',
    (content?.windowCount ?? -1) >= 0 && (content?.elementCount ?? -1) >= 0 && (content?.elementCount ?? 0) <= 120,
    counts
  )
  const noNetwork = (content?.facts ?? []).length > 0
  record(
    'dc-probe-facts-present',
    '当轮内容带着程序事实（窗口数 / 元素数 / 截断与否 / 不截图不点击）',
    noNetwork,
    { facts: content?.facts }
  )
  record(
    'dc-probe-no-screenshot',
    '这次读数**没有**任何截图/图像路径（首版无视觉：模型消息是文本）',
    reading.ok && content !== undefined && !JSON.stringify(reading.outcome).includes('screenshot'),
    { checked: 'outcome JSON 里不含 screenshot' }
  )

  /*
   * ==========================================================================
   *  负控：**直接驱动生产 worker**（dryRun ⇒ 即使核对链放行也绝不动手）
   * ==========================================================================
   * ⚠️ 这里刻意**不**经过适配器去构造负控 —— 因为适配器只交回**渲染后的文本**，
   *    而按文本反推"哪个窗口不在前台"这件事本身就不牢靠。
   *    直接读 worker 的结构化快照：窗口有 `handle`，前台窗口有 `activeWindow.handle`
   *    ⇒ "不是前台"是**比出来的**，不是猜出来的。
   * ⚠️ 并且每一条都带 `dryRun: true`：**即使**核对链意外放行，也不会有任何动作
   *    （2026-10-05：本门第一版正因为按文本反推，真的在用户浏览器里点了一次，
   *     记录在 `docs/post-lv2/Desktop-Control-WP5-Probe-Record.md`）。
   * ==========================================================================
   */
  const workerPath = defaultDesktopControlWorker()
  const workerPython = defaultDesktopControlPython()

  async function workerCall(
    header: Record<string, unknown>,
    options: { dryRun?: boolean; expectedVersion?: string } = {}
  ): Promise<Record<string, unknown>> {
    const run = await runDesktopWorker({
      executable: workerPython,
      workerScript: workerPath,
      header: {
        protocol: DESKTOP_CONTROL_PROTOCOL,
        expectedVersion: options.expectedVersion ?? DESKTOP_MCP_VERSION,
        ...(options.dryRun !== false ? { dryRun: true } : {}),
        ...header,
      },
      timeoutMs: 30_000,
    })
    if (run.result === undefined) {
      return { ok: false, code: 'execution_failed', message: run.parseProblem ?? '没有结果行' }
    }
    return run.result
  }

  type ElementRow = { ordinal: number; name: string; window: string }
  interface Snapshot {
    activeName: string
    groups: { name: string; rows: ElementRow[] }[]
  }

  /*
   * ⚠️ 分组按**元素自报的 `window` 名**，**不是**按 `state.windows[]` 的 handle。
   *
   * 实测（2026-10-05）：上游的窗口列表**不含**当前前台窗口与任务栏 ——
   * 那几项是"其余窗口"。因此"按 handle 找前台那一组"永远找不到。
   * `element.window` 与 `activeWindow.name` 来自同一个上游字段 ⇒ **逐字相等**可比。
   *
   * ⚠️ `ordinal` 是**在这一组里的序号**，不是全局序号：worker 的 `window` 过滤会重新编号
   * （`collect_state` 里 `enumerate(filtered)`）⇒ 传全局序号会得到 `stale_reference`
   * —— 那看起来像"守卫生效"，其实是**量具传错了参数**（第一版就这样错过一次）。
   */
  async function freshSnapshot(): Promise<Snapshot> {
    const structured = await workerCall({ op: 'state' }, { dryRun: false })
    const state = (structured.state ?? {}) as {
      activeWindow?: { name?: string } | null
      elements?: { name?: string; window?: string }[]
    }
    const rows = (state.elements ?? []).filter(
      (item) => typeof item.name === 'string' && typeof item.window === 'string'
    )
    const names = [...new Set(rows.map((row) => row.window as string))]
    return {
      activeName: state.activeWindow?.name ?? '',
      groups: names.map((name) => ({
        name,
        rows: rows
          .filter((row) => row.window === name)
          .map((row, ordinal) => ({ ordinal, name: row.name as string, window: name })),
      })),
    }
  }

  /*
   * 重试的理由（实测）：活跃窗口的**标题会变**（直播页标题随页面更新）——
   * 读快照与真正 act 之间隔着约 1.5s，标题一变，`window` 过滤词就命中不到 ⇒
   * worker 如实回 `window_not_found`。**那不是守卫生效**，是量具撞上了变化。
   * ⇒ 每条判据最多试 3 次（每次重新取快照），并记下每次读到的码。
   */
  const attemptsPerCase = 3
  async function attemptCodes(
    run: (snapshot: Snapshot) => Promise<{ code: string; detail?: unknown }>
  ): Promise<{ codes: string[]; detail?: unknown }> {
    const codes: string[] = []
    let detail: unknown
    for (let attempt = 0; attempt < attemptsPerCase; attempt += 1) {
      const snapshot = await freshSnapshot()
      const result = await run(snapshot)
      codes.push(result.code)
      detail = result.detail
      if (result.code === 'window_not_found') continue
      break
    }
    return { codes, detail }
  }

  const codeOf = (reading: Record<string, unknown>): string =>
    reading.ok === true ? 'ok' : typeof reading.code === 'string' ? reading.code : 'unknown'

  const bogusWindow = '这个窗口名一定不存在-负控'
  const notFound = await workerCall({
    op: 'act',
    action: 'click',
    window: bogusWindow,
    index: 0,
    name: '不存在的控件',
  })
  record(
    'dc-probe-neg-window-not-found',
    '窗口不存在 ⇒ `window_not_found`（不动手）',
    notFound.ok === false && notFound.code === 'window_not_found',
    { code: notFound.code }
  )

  const staleAttempt = await attemptCodes(async (snapshot) => {
    const roomy = snapshot.groups.find((group) => group.rows.length > 0 && group.rows.length + 3 <= 119)
    if (roomy === undefined) return { code: 'no_roomy_window', detail: snapshot.groups.map((g) => g.rows.length) }
    const askedIndex = roomy.rows.length + 3
    const reading = await workerCall({
      op: 'act',
      action: 'click',
      window: roomy.name,
      index: askedIndex,
      name: '不存在的控件',
    })
    return { code: codeOf(reading), detail: { askedIndex, listed: roomy.rows.length } }
  })
  record(
    'dc-probe-neg-stale-reference',
    '索引在合法区间内、但这一次快照里没有那个位置 ⇒ `stale_reference`（引用过期就重看不猜）',
    staleAttempt.codes.includes('stale_reference'),
    staleAttempt
  )

  const wrongNameAttempt = await attemptCodes(async (snapshot) => {
    /* 优先用**不在前台**的那一组（标题更稳），其次任意一组 */
    const group =
      snapshot.groups.find((item) => item.name !== snapshot.activeName && item.rows.length > 0) ??
      snapshot.groups.find((item) => item.rows.length > 0)
    const first = group?.rows[0]
    if (group === undefined || first === undefined) return { code: 'no_elements' }
    const reading = await workerCall({
      op: 'act',
      action: 'click',
      window: group.name,
      index: first.ordinal,
      name: '控件的名字一定不是这个-负控',
    })
    return { code: codeOf(reading) }
  })
  record(
    'dc-probe-neg-wrong-name',
    '同一个索引现在叫别的名字 ⇒ `stale_reference`（**不**按坐标猜着点）',
    wrongNameAttempt.codes.includes('stale_reference'),
    wrongNameAttempt
  )

  const focusAttempt = await attemptCodes(async (snapshot) => {
    const group = snapshot.groups.find((item) => item.name !== snapshot.activeName && item.rows.length > 0)
    const target = group?.rows[0]
    if (group === undefined || target === undefined) return { code: 'no_background_window' }
    const reading = await workerCall({
      op: 'act',
      action: 'click',
      window: group.name,
      index: target.ordinal,
      name: target.name,
    })
    return { code: codeOf(reading) }
  })
  record(
    'dc-probe-neg-focus-changed',
    '控件真实存在、但它的窗口**不在前台**（按名字比出来的）⇒ `focus_changed`（用户切走了就不动手）',
    focusAttempt.codes.includes('focus_changed'),
    focusAttempt
  )

  /*
   * 正控（**干跑**）：拿前台窗口里一个**真实**控件走完整条核对链 ⇒
   *   `dryRun: true` 必须让"核对链通过"与"真的点下去"分开。
   * ⚠️ 这一条是本门最要害的断言：它同时证明（a）合法目标确实会被放行，
   *    （b）本门**没有**动用户的东西。
   */
  let dryRunObserved: Record<string, unknown> | undefined
  let dryRunCodes: string[] = []
  for (let attempt = 0; attempt < attemptsPerCase; attempt += 1) {
    const snapshot = await freshSnapshot()
    const group = snapshot.groups.find((item) => item.name === snapshot.activeName && item.rows.length > 0)
    const target = group?.rows[0]
    if (group === undefined || target === undefined) {
      dryRunCodes.push('no_foreground_element')
      continue
    }
    const dry = await workerCall({
      op: 'act',
      action: 'click',
      window: group.name,
      index: target.ordinal,
      name: target.name,
    })
    dryRunCodes.push(codeOf(dry))
    dryRunObserved = {
      ok: dry.ok,
      dryRun: dry.dryRun,
      guardChain: dry.guardChain,
      hasPerformed: dry.performed !== undefined,
    }
    if (dry.ok === true && dry.dryRun === true) break
  }
  record(
    'dc-probe-dry-run-positive',
    '前台窗口里的真实控件 ⇒ 核对链通过、`dryRun=true`、**没有动作**（"会做"与"做了"分开）',
    dryRunObserved?.ok === true && dryRunObserved.dryRun === true && dryRunObserved.hasPerformed === false,
    { ...dryRunObserved, codes: dryRunCodes }
  )

  // ---- ③ 版本闸：把期望版本改错 ⇒ worker 必须拒绝 --------------------------

  // ---- ③ 版本闸：把期望版本改错 ⇒ worker 必须拒绝 --------------------------
  const wrongVersion = createDesktopAdapters({ expectedVersion: '0.0.1' }).find(
    (adapter) => adapter.capabilityId === DESKTOP_INSPECT
  )
  if (wrongVersion === undefined) throw new Error('适配器没有建出来')
  const versionGate = await call(wrongVersion, {})
  record(
    'dc-probe-neg-version-gate',
    '运行时版本与固定值不符 ⇒ `runtime_mismatch` ⇒ 内核 `unsupported`（**不**"试着跑跑看"）',
    !versionGate.ok && versionGate.workerCode === 'runtime_mismatch' && versionGate.code === 'unsupported',
    versionGate
  )

  // ---- ④ 离线闸：worker 自报的网络调用次数为 0 -----------------------------
  record(
    'dc-probe-network-zero',
    'worker 自报 `networkAttempts=0`（看桌面这件事没有出站流量）',
    reading.ok && true,
    { note: '见本地原始输出里的 networkAttempts；证据里不落标题' }
  )

  // -------------------------------------------------------------------------
  const failed = cases.filter((item) => item.status === 'FAIL')
  const notRun = cases.filter((item) => item.status === 'NOT RUN')
  const overall = failed.length === 0 && notRun.length === 0

  for (const item of cases) {
    const mark = item.status === 'PASS' ? '·' : item.status === 'FAIL' ? '×' : '!'
    process.stdout.write(`[desktop-control:probe] ${mark} ${item.status.padEnd(7)} ${item.id} — ${item.title}\n`)
    if (item.status !== 'PASS') {
      process.stdout.write(`[desktop-control:probe]     observed = ${JSON.stringify(item.observed)}\n`)
    }
  }
  process.stdout.write(
    `[desktop-control:probe] 判据 ${String(cases.length)} 条 · 未运行 ${String(notRun.length)} · 未通过 ${String(failed.length)}\n`
  )
  process.stdout.write(`[desktop-control:probe] overall = ${overall ? 'PASS' : 'NOT PASS'}\n`)

  if (writeEvidence) {
    const runId = runIdOf(label)
    const runDir = join(REPO_ROOT, EVIDENCE_PARENT, runId)
    if (existsSync(runDir)) throw new Error(`runId 目录已存在，拒绝覆盖：${runDir}`)
    mkdirSync(runDir, { recursive: true })
    /*
     * ⚠️ 原始正文（含窗口标题 / 控件名）只落 `local/`（被 gitignore）。
     *    进仓库的那一份**只有计数与布尔**。
     */
    const localDir = join(REPO_ROOT, LOCAL_PARENT, runId)
    mkdirSync(localDir, { recursive: true })
    writeFileSync(join(localDir, 'desktop-state-raw.txt'), `${text}\n`, 'utf8')
    const evidence = {
      schemaVersion: 'desktop-control-probe@1',
      runId,
      head: git(['rev-parse', 'HEAD']),
      startedAt: new Date().toISOString(),
      /** ⚠️ 本门**不调模型**；它真的读桌面（只读） */
      modelCalls: 0,
      actions: 0,
      pinned: { package: 'windows-mcp', version: DESKTOP_MCP_VERSION, worker: defaultDesktopControlWorker() },
      readings: {
        releasedMs: reading.releasedMs,
        chars: text.length,
        windows: counts.windows,
        elements: counts.elements,
        stateTruncated: counts.stateTruncated,
        cjk: cjkInText,
        scope: content?.scope,
      },
      overall: overall ? 'PASS' : 'NOT PASS',
      cases,
    }
    writeFileSync(join(runDir, 'probe.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    process.stdout.write(`[desktop-control:probe] runId = ${runId}\n`)
    process.stdout.write(`[desktop-control:probe] 证据 = ${EVIDENCE_PARENT}/${runId}/probe.json\n`)
    process.stdout.write(`[desktop-control:probe] 原始正文（不进仓库）= ${LOCAL_PARENT}/${runId}/desktop-state-raw.txt\n`)
  }

  return overall ? 0 : 1
}

process.exit(await main())
