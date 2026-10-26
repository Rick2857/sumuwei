/**
 * `pnpm desktop-control:verify` —— 桌面能力的**离线硬门**（ADR-106）。
 *
 * ============================================================================
 *  它测的是哪一半（说清楚，别让读数超出它能主张的范围）
 * ============================================================================
 * ```text
 * 本门测的：**适配器 + 登记表 + 目录 + 参数白名单**（离线、可复现、不碰 UIA）
 *   · worker 协议（stdout 恰好一行）与"没有结果行"的失败关闭
 *   · 有界与截断（scope.includedChars === text.length 这条契约判据）
 *   · worker 具名码 → 内核闭集失败码的**映射**（原始码保留在 details.workerCode）
 *   · 闭集动作：非法动作**在拉起进程之前**就被拒（用"标记文件没被写"证明）
 *   · 隐私边界：桌面文字与要输入的正文**都不进**证据 / effect 文本
 *   · 登记表 / 参数白名单 / 工具目录四态 / 无通用绕过入口
 *
 * 本门**不**测的：真机上 UIA 到底读到了什么、真点一次之后世界怎么变
 *   ⇒ 那两半分别在 `pnpm desktop-control:probe`（只读）与
 *      `pnpm desktop-control:act`（真动手，需用户在场）。
 * ```
 *
 * ⚠️ 夹具 worker 不是生产 worker 的替身（见 `fixtures/fake-desktop-worker.py` 头注释）。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createCapabilityRegistry,
  createDefaultCapabilityDefinitions,
} from '../../src/kernel/action/capability-registry.ts'
import { createExternalEvidenceCapabilityDefinitions } from '../../src/kernel/action/external-evidence-capability.ts'
import { createUtilityCapabilityDefinitions } from '../../src/kernel/action/utility-capabilities.ts'
import { createLocalFileCapabilityDefinitions } from '../../src/kernel/action/local-file-capabilities.ts'
import { createWeatherCapabilityDefinitions } from '../../src/kernel/action/weather-capability.ts'
import { createXidianCapabilityDefinitions } from '../../src/kernel/action/xidian-capability.ts'
import { createOfficeCapabilityDefinitions } from '../../src/kernel/action/office-capability.ts'
import { createNewsCapabilityDefinitions } from '../../src/kernel/action/news-capability.ts'
import { createBrowserCapabilityDefinitions } from '../../src/kernel/action/browser-capability.ts'
import { createLearningCapabilityDefinitions } from '../../src/kernel/action/learning-capabilities.ts'
import { createQqProactiveCapabilityDefinitions } from '../../src/kernel/action/qq-proactive-capability.ts'
import { createLocalReminderCapabilities } from '../../src/kernel/action/local-reminder-capability.ts'
import {
  DESKTOP_ACTION_KINDS,
  DESKTOP_ELEMENT_LIMIT,
  DESKTOP_INSPECT,
  DESKTOP_INSPECT_OPERATION,
  DESKTOP_INSPECT_PERMISSION,
  DESKTOP_OPERATE,
  DESKTOP_OPERATE_OPERATION,
  DESKTOP_OPERATE_PERMISSION,
  DESKTOP_SHELL_FOLDERS,
  DESKTOP_STATE_MAX_CHARS,
  DESKTOP_TYPE_MAX_CHARS,
  createDesktopCapabilityDefinitions,
  renderDesktopCapabilityFacts,
} from '../../src/kernel/action/desktop-capability.ts'
import { TASK_ARG_KEYS, TASK_STAGED_ARG_KEYS } from '../../src/kernel/action/task-plan.ts'
import {
  FORBIDDEN_ARG_KEY_PATTERN,
  auditToolCatalog,
  buildToolCatalog,
  renderToolCatalogForModel,
} from '../../src/kernel/action/tool-catalog.ts'
import {
  createDesktopAdapters,
  kernelFailureOf,
  parseWorkerStdout,
} from '../../src/infrastructure/action/adapters/desktop-control.ts'
import {
  DESKTOP_CONTROL_PROTOCOL,
  DESKTOP_MCP_VERSION,
  defaultDesktopControlPython,
  defaultDesktopControlWorker,
  verifyDesktopRuntimeSync,
} from '../../src/infrastructure/action/adapters/desktop-control-assets.ts'
import type { CapabilityAdapter } from '../../src/kernel/action/executor-port.ts'
import { newActionId } from '../../src/kernel/contracts/ids.ts'
import { buildTaskPlannerInstruction } from '../../src/infrastructure/model/openai-task-planner.ts'
import { buildToolDecisionInstruction } from '../../src/infrastructure/model/openai-tool-decision.ts'
import { verifyDesktopReplyChain } from './reply-chain.ts'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const EVIDENCE_PARENT = 'artifacts/post-lv2/desktop-control'

type Status = 'PASS' | 'FAIL' | 'NOT RUN'
interface Reading {
  id: string
  title: string
  status: Status
  observed: unknown
  note?: string
}

const cases: Reading[] = []
let measuredInputs = 0

function record(id: string, title: string, ok: boolean | 'not-run', observed: unknown): void {
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

// ---------------------------------------------------------------------------
// 夹具驱动的适配器调用
// ---------------------------------------------------------------------------

const python = defaultDesktopControlPython()
const fixture = join(REPO_ROOT, 'scripts/desktop-control/fixtures/fake-desktop-worker.py')
const scratch = join(tmpdir(), `lg-desktop-verify-${String(process.pid)}`)
mkdirSync(scratch, { recursive: true })

function adapters(scenario: string, marker?: string, timeoutMs?: number): CapabilityAdapter[] {
  return createDesktopAdapters({
    pythonPath: python,
    workerPath: fixture,
    env: {
      ...process.env,
      DESKTOP_FIXTURE_SCENARIO: scenario,
      ...(marker !== undefined ? { DESKTOP_FIXTURE_MARKER: marker } : {}),
    },
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  })
}

const target = {
  type: 'local_executor',
  canonicalId: 'windows-desktop',
  displayName: '当前用户桌面（UI Automation 读取）',
  confidence: 'exact' as const,
}

  async function run(
  adapter: CapabilityAdapter,
  args: Record<string, unknown> = {},
  staging?: { read: (ref: string) => { kind: string; text?: string } | undefined },
  operation?: string
): Promise<{ ok: true; outcome: Awaited<ReturnType<CapabilityAdapter['execute']>> } | { ok: false; code: string; message: string; workerCode?: unknown }> {
  const capabilityIsInspect = adapter.capabilityId === DESKTOP_INSPECT
  try {
    const outcome = await adapter.execute({
      actionId: newActionId(),
      operation: operation ?? (capabilityIsInspect ? DESKTOP_INSPECT_OPERATION : DESKTOP_OPERATE_OPERATION),
      target,
      args,
      now: () => Date.now() as never,
    })
    return { ok: true, outcome }
  } catch (error) {
    const failure = (error as { failure?: { code?: string; message?: string; details?: Record<string, unknown> } }).failure
    if (failure?.code !== undefined) {
      return {
        ok: false,
        code: failure.code,
        message: failure.message ?? '',
        workerCode: failure.details?.workerCode,
      }
    }
    return { ok: false, code: 'thrown', message: String(error) }
  }
}

/** 一个最小的暂存桩（只实现 `read`；`type` 的正文只从它来） */
function stagingStub(entries: Record<string, { kind: string; text?: string }>) {
  return { read: (ref: string) => entries[ref] } as never
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const label = process.argv.find((arg) => arg.startsWith('--label='))?.slice('--label='.length) ?? 'offline'
  const writeEvidence = process.argv.includes('--evidence')

  // ---- ① 固定值与非空登记 --------------------------------------------------
  const registry = createCapabilityRegistry([
    ...createDefaultCapabilityDefinitions(),
    ...createExternalEvidenceCapabilityDefinitions(),
    ...createUtilityCapabilityDefinitions(),
    ...createLocalFileCapabilityDefinitions(),
    ...createWeatherCapabilityDefinitions(),
    ...createXidianCapabilityDefinitions(),
    ...createOfficeCapabilityDefinitions(),
    ...createNewsCapabilityDefinitions(),
    ...createBrowserCapabilityDefinitions(),
    ...createDesktopCapabilityDefinitions(),
    ...createLearningCapabilityDefinitions(),
    ...createQqProactiveCapabilityDefinitions(),
    ...createLocalReminderCapabilities(),
  ])
  const registryIds = registry.list().map((item) => item.id)
  const plannerInstruction = buildTaskPlannerInstruction([DESKTOP_INSPECT, DESKTOP_OPERATE])
  const decisionInstruction = buildToolDecisionInstruction()
  for (const [name, instruction] of [['planner', plannerInstruction], ['decision', decisionInstruction]]) {
    measuredInputs += 2
    record(
      `dc-${name}-desktop-protocol`,
      '模型调用说明包含桌面真实 operation 与动作参数要求',
      instruction.includes(`${DESKTOP_INSPECT}=${DESKTOP_INSPECT_OPERATION}`) &&
        instruction.includes(`${DESKTOP_OPERATE}=${DESKTOP_OPERATE_OPERATION}`) &&
        instruction.includes('window / index / name') && instruction.includes('整数'),
      { name }
    )
  }
  const desktopOffFacts = renderDesktopCapabilityFacts({ inspect: false, operate: false, connected: true })
  const desktopReadFacts = renderDesktopCapabilityFacts({ inspect: true, operate: false, connected: true }) ?? ''
  const desktopDisconnectedFacts = renderDesktopCapabilityFacts({ inspect: true, operate: true, connected: false }) ?? ''
  measuredInputs += 3
  record(
    'dc-reply-availability',
    '回复区分只读、未连接与全关；全关不改变既有 prompt',
    desktopOffFacts === undefined && desktopReadFacts.includes('desktop.inspect.state：已启用') &&
      desktopReadFacts.includes('desktop.operate.act：未启用') && desktopDisconnectedFacts.includes('未连接，当前不能调用'),
    { offProducesFacts: desktopOffFacts !== undefined }
  )
  measuredInputs += registryIds.length
  record(
    'dc-registry',
    '两个桌面能力都在登记表里（恒登记 ⇒ 关闭时也查得到"为什么不可用"）',
    registry.has(DESKTOP_INSPECT) && registry.has(DESKTOP_OPERATE),
    { registryIds, count: registryIds.length }
  )
  record(
    'dc-pinned-version',
    `上游版本固定为 ${DESKTOP_MCP_VERSION}，且协议名固定`,
    DESKTOP_MCP_VERSION === '0.8.7' && DESKTOP_CONTROL_PROTOCOL === 'desktop-control/1',
    { version: DESKTOP_MCP_VERSION, protocol: DESKTOP_CONTROL_PROTOCOL }
  )

  const runtime = verifyDesktopRuntimeSync()
  measuredInputs += 1
  record(
    'dc-runtime-present',
    '本机独立运行时在位且版本与固定值一致（不在位 = NOT RUN，不是 PASS）',
    runtime.ok ? true : 'not-run',
    { ok: runtime.ok, version: runtime.version, problems: runtime.problems }
  )

  // ---- ② 登记表覆盖与闭集 --------------------------------------------------
  const audit = auditToolCatalog(registry)
  measuredInputs += registryIds.length
  record(
    'dc-audit',
    '每项桌面能力都有参数白名单与治理开关（无遗漏、无漂移）',
    audit.length === 0,
    { problems: audit }
  )
  const desktopArgKeys = TASK_ARG_KEYS[DESKTOP_OPERATE] ?? []
  const badKeys = desktopArgKeys.filter((key) => FORBIDDEN_ARG_KEY_PATTERN.test(key))
  measuredInputs += desktopArgKeys.length
  record(
    'dc-no-generic-bypass',
    '桌面参数白名单里没有通用执行入口（shell / exec / eval / 任意调用）',
    badKeys.length === 0,
    { keys: desktopArgKeys, badKeys, stagedKeys: TASK_STAGED_ARG_KEYS }
  )
  record(
    'dc-type-text-staged',
    '`type` 的正文走**既有暂存通道**（`content` ∈ staged）⇒ 正文不进参数与账本',
    TASK_STAGED_ARG_KEYS.includes('content') && desktopArgKeys.includes('content'),
    { staged: TASK_STAGED_ARG_KEYS, desktopArgs: desktopArgKeys }
  )
  const inspectRows = TASK_ARG_KEYS[DESKTOP_INSPECT] ?? []
  measuredInputs += inspectRows.length
  record(
    'dc-inspect-args',
    '`desktop.inspect` 的参数是闭集（state 的 window 与 apps 的 query）',
    inspectRows.length === 2 && inspectRows.includes('window') && inspectRows.includes('query'),
    { inspectRows }
  )

  // ---- ③ 动作闭集在**两处**一致（TS 常量 vs worker 源码） -------------------
  const workerSource = readFileSync(defaultDesktopControlWorker(), 'utf8')
  const workerWhitelist = /ACTION_WHITELIST\s*=\s*\(([^)]*)\)/.exec(workerSource)?.[1] ?? ''
  const workerActions = [...workerWhitelist.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
  const actionSetsAgree =
    workerActions.length === DESKTOP_ACTION_KINDS.length &&
    [...workerActions].sort().join(',') === [...DESKTOP_ACTION_KINDS].sort().join(',')
  measuredInputs += Math.max(1, DESKTOP_ACTION_KINDS.length)
  record(
    'dc-action-set-parity',
    '动作闭集在 TS 侧与 worker 侧**逐字一致**（两处都在，任一处被改坏都会响）',
    actionSetsAgree,
    { ts: DESKTOP_ACTION_KINDS, worker: workerActions }
  )

  // ---- ③b shell 文件夹闭集在**两处**一致（TS 常量 vs worker 源码） ----------
  /*
   * ⚠️ 这一条与上面那条同型，但对象是**目标**（`shell:RecycleBinFolder` 这类）：
   *   TS 侧那份给模型看名字、worker 侧那份才真的提交给 ShellExecute。
   *   两处漂移的后果是"她说能开回收站、实际开的是别的东西"—— 必须机器判据钉住。
   */
  const workerFolderBlock = /SHELL_FOLDERS\s*=\s*\(([\s\S]*?)\n\)/.exec(workerSource)?.[1] ?? ''
  const workerFolders = [...workerFolderBlock.matchAll(/\('([^']+)',\s*\([^)]*\),\s*'([^']+)'\)/g)]
    .map((match) => ({ label: match[1], target: match[2] }))
  const tsFolders = DESKTOP_SHELL_FOLDERS.map((entry) => ({ label: entry.label, target: entry.target }))
  const shellFacts = renderDesktopCapabilityFacts({ inspect: true, operate: true, connected: true }) ?? ''
  const noSelfAssembledTarget =
    plannerInstruction.includes('不得自己拼路径') &&
    shellFacts.includes('不要') && shellFacts.includes('CLSID') && shellFacts.includes('shell: 命令')
  const folderSetsAgree =
    workerFolders.length === tsFolders.length &&
    JSON.stringify(workerFolders) === JSON.stringify(tsFolders)
  measuredInputs += Math.max(1, tsFolders.length)
  record(
    'dc-shell-folder-parity',
    '系统文件夹闭集（名字 ↔ 提交目标）在 TS 侧与 worker 侧**逐字一致**',
    folderSetsAgree,
    { ts: tsFolders, worker: workerFolders }
  )
  const foldersInContract = tsFolders.every((entry) =>
    plannerInstruction.includes(entry.label) && shellFacts.includes(entry.label)) && noSelfAssembledTarget
  record(
    'dc-shell-folder-contract',
    '协议与能力事实列出三个系统文件夹，并明说"不要自己拼路径 / CLSID / shell: 命令"',
    foldersInContract,
    { labels: tsFolders.map((entry) => entry.label), foldersNamed: tsFolders.every((entry) => shellFacts.includes(entry.label)), noSelfAssembledTarget }
  )

  // ---- ④ 适配器协议（夹具） ------------------------------------------------
  const inspectOk = await run(adapters('state-ok')[0], {})
  const okContent = inspectOk.ok ? inspectOk.outcome.turnContent?.[0] : undefined
  record(
    'dc-protocol-single-line',
    '正常协议：拿到结果行 ⇒ 产出当轮内容，且 `scope.includedChars === text.length`',
    inspectOk.ok &&
      okContent !== undefined &&
      okContent.kind === 'desktop-state' &&
      okContent.scope.includedChars === okContent.text.length,
    inspectOk.ok
      ? {
          kind: okContent?.kind,
          chars: okContent?.text.length,
          included: okContent?.scope.includedChars,
          truncated: okContent?.scope.truncated,
        }
      : inspectOk
  )
  const emptyText = await run(adapters('state-empty-text')[0], {})
  record(
    'dc-empty-text-is-honest',
    'worker 交回空文本 ⇒ `target_not_found`（**不**编一份内容出来）',
    !emptyText.ok && emptyText.code === 'target_not_found',
    emptyText
  )
  const multiLine = await run(adapters('state-multiline-stdout')[0], {})
  record(
    'dc-protocol-multiline',
    'stdout 多于一行 ⇒ 协议不符 ⇒ `execution_failed`（宽松解析会让"多出来的那行"变成隐形内容）',
    !multiLine.ok && multiLine.code === 'execution_failed',
    multiLine
  )
  const garbage = await run(adapters('state-garbage')[0], {})
  record(
    'dc-protocol-garbage',
    '结果行不是 JSON ⇒ `execution_failed`',
    !garbage.ok && garbage.code === 'execution_failed',
    garbage
  )
  const noLine = await run(adapters('state-no-result-line')[0], {})
  record(
    'dc-protocol-missing-line',
    '完全没有结果行 ⇒ `execution_failed`',
    !noLine.ok && noLine.code === 'execution_failed',
    noLine
  )

  const huge = await run(adapters('state-huge')[0], {})
  const hugeContent = huge.ok ? huge.outcome.turnContent?.[0] : undefined
  record(
    'dc-truncation',
    `超长正文（9000 字符）⇒ 截断到 ≤ ${String(DESKTOP_STATE_MAX_CHARS)} + 1（省略号）且如实标 truncated`,
    huge.ok &&
      hugeContent !== undefined &&
      hugeContent.text.length <= DESKTOP_STATE_MAX_CHARS + 1 &&
      hugeContent.scope.truncated === true &&
      hugeContent.scope.includedChars === hugeContent.text.length,
    huge.ok
      ? { chars: hugeContent?.text.length, scope: hugeContent?.scope }
      : huge
  )
  const upstreamTruncated = await run(adapters('state-truncated-upstream')[0], {})
  const upstreamContent = upstreamTruncated.ok ? upstreamTruncated.outcome.turnContent?.[0] : undefined
  record(
    'dc-upstream-truncation-visible',
    '上游自己截断了 ⇒ 当轮内容如实说出来（"这不是桌面上只有这些"）',
    upstreamTruncated.ok &&
      (upstreamContent as { stateTruncated?: boolean } | undefined)?.stateTruncated === true &&
      (upstreamContent?.facts ?? []).some((fact) => fact.includes('截断')),
    upstreamTruncated.ok
      ? { stateTruncated: (upstreamContent as { stateTruncated?: boolean })?.stateTruncated, facts: upstreamContent?.facts }
      : upstreamTruncated
  )

  /*
   * ⚠️ 这一档来自 **2026-10-05 真机读数发现的一处缺陷**：
   *    worker 先把文本裁到上限 + 省略号，适配器再拿"裁过的那一段"去判有没有超上限
   *    ⇒ `scope.truncated` **永远**是 false（"她说这是全文"而其实不是）。
   *    夹具不预裁剪，所以它当时是绿的 —— 现在两档都在：报了的、和**没报**的。
   */
  const workerClipped = await run(adapters('state-worker-clipped')[0], {})
  const workerClippedContent = workerClipped.ok ? workerClipped.outcome.turnContent?.[0] : undefined
  record(
    'dc-worker-reported-clip',
    'worker 自报"我裁过"（`textClipped` + 裁剪前长度）⇒ 当轮内容如实标 `truncated` 并给出原始字符数',
    workerClipped.ok &&
      workerClippedContent?.scope.truncated === true &&
      workerClippedContent.scope.totalChars === 9000 &&
      workerClippedContent.scope.includedChars === workerClippedContent.text.length,
    workerClipped.ok ? { scope: workerClippedContent?.scope } : workerClipped
  )
  const silentlyClipped = await run(adapters('state-worker-clipped-silently')[0], {})
  const silentlyClippedContent = silentlyClipped.ok ? silentlyClipped.outcome.turnContent?.[0] : undefined
  record(
    'dc-silent-clip-still-marked',
    'worker **裁了但没报**（只交回更短的文本）⇒ 适配器仍按它报的原始长度如实标 `truncated`',
    silentlyClipped.ok &&
      silentlyClippedContent?.scope.truncated === true &&
      silentlyClippedContent.scope.totalChars === 9000,
    silentlyClipped.ok ? { scope: silentlyClippedContent?.scope } : silentlyClipped
  )

  // ---- ⑤ 具名码 → 内核失败码 ----------------------------------------------
  const mapping: Record<string, string> = {
    window_not_found: 'target_not_found',
    stale_reference: 'target_not_found',
    window_mismatch: 'target_uncertain',
    focus_changed: 'target_uncertain',
    runtime_mismatch: 'unsupported',
    not_actionable: 'unsupported',
    unsupported_action: 'unsupported',
    validation_failed: 'validation_failed',
    protocol_error: 'execution_failed',
    execution_failed: 'execution_failed',
  }
  for (const [workerCode, expected] of Object.entries(mapping)) {
    measuredInputs += 1
    const failure = kernelFailureOf(workerCode, '夹具')
    const viaFixture = await run(adapters(`code:${workerCode}`)[0], {})
    record(
      `dc-map-${workerCode}`,
      `${workerCode} ⇒ ${expected}（原始具名码保留在 details.workerCode）`,
      failure.code === expected && !viaFixture.ok && viaFixture.workerCode === workerCode,
      { kernel: failure.code, details: failure.details, viaFixture }
    )
  }

  // ---- ⑥ "在拉起进程之前就拒掉"的几条（标记文件没被写 = 真的没 spawn） ------
  const marker = join(scratch, 'spawn-marker.txt')
  const expectNoSpawn = async (id: string, title: string, adapter: CapabilityAdapter, args: Record<string, unknown>, stub?: unknown): Promise<void> => {
    rmSync(marker, { force: true })
    const outcome = await run(adapter, args, stub as never)
    record(id, `${title}（标记文件没被写 ⇒ 真的没有拉起进程）`, !outcome.ok && !existsSync(marker), {
      outcome,
      spawned: existsSync(marker),
    })
  }

  const operate = adapters('act-ok', marker)[1]
  const appsResult = await run(adapters('state-reply')[0], { query: 'Edge' }, undefined, 'apps')
  record('dc-apps-operation', '应用目录通过已登记的只读 apps 操作返回当轮内容',
    appsResult.ok && appsResult.outcome.turnContent?.[0]?.operation === 'apps', appsResult)
  for (const args of [
    { action: 'right_click', window: '夹具窗口', index: 0, name: '确定' },
    { action: 'double_click', window: '夹具窗口', index: 0, name: '确定' },
    { action: 'switch_app', window: '夹具窗口', handle: 42 },
    { action: 'launch_app', name: 'Microsoft Edge' },
  ]) {
    const outcome = await run(operate, args)
    record(`dc-extended-${args.action}`, '新增桌面动作按各自目标参数执行并返回读回',
      outcome.ok && outcome.outcome.turnContent?.[0]?.kind === 'desktop-state' &&
        outcome.outcome.turnContent[0].action === args.action, outcome)
  }
  const extendedFacts = renderDesktopCapabilityFacts({ inspect: true, operate: true, connected: true }) ?? ''
  record('dc-extended-model-contract', '规划与回复明确右键、双击、窗口切换和应用启动的协议',
    ['right_click', 'double_click', 'switch_app', 'launch_app', 'desktop.inspect.apps', 'handle'].every(
      word => plannerInstruction.includes(word) && extendedFacts.includes(word)), {})
  for (const args of [
    { action: 'switch_app', window: '夹具窗口' },
    { action: 'switch_app', window: '夹具窗口', handle: '42' },
    { action: 'switch_app', window: '夹具窗口', handle: 42, index: 0 },
    { action: 'launch_app', name: 'C:\\Windows\\cmd.exe' },
    { action: 'launch_app', name: 'shell:RecycleBinFolder' },
    { action: 'launch_app', name: '::{645FF040-5081-101B-9F08-00AA002F954E}' },
    { action: 'launch_app', name: 'Microsoft Edge', content: '--anything' },
    { action: 'launch_app', name: '' },
    { action: 'double_click', window: '夹具窗口', index: -1, name: '确定' },
    { action: 'right_click', window: '夹具窗口', name: '确定' },
    { action: 'right_click', window: '夹具窗口', index: '0', name: '确定' },
  ]) {
    await expectNoSpawn(`dc-invalid-${args.action}-${JSON.stringify(args)}`, '新增动作目标不完整或混入不适用参数须拒绝', operate, args)
  }
  const workerTests = execFileSync(python, ['-X', 'utf8', join(REPO_ROOT, 'scripts/desktop-control/worker-actions-verify.py')],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  record('dc-production-worker-routing', '生产 worker 的动作路由、目标核对、干跑及读回（替换 OS/UIA 端口）',
    true, { exitCode: 0, stdoutChars: workerTests.length })
  await expectNoSpawn(
    'dc-closed-action-set',
    '非法动作（scroll，不在闭集里）⇒ `validation_failed`',
    operate,
    { action: 'scroll', window: '夹具窗口', index: 0, name: '确定' }
  )
  await expectNoSpawn(
    'dc-missing-target-fields',
    '缺 window / index / name ⇒ `validation_failed`（不允许凭坐标猜）',
    operate,
    { action: 'click', window: '夹具窗口' }
  )
  await expectNoSpawn(
    'dc-type-needs-staging',
    '`type` 没有 payloadRef ⇒ `validation_failed`（拒绝直接放在参数里的正文）',
    operate,
    { action: 'type', window: '夹具窗口', index: 0, name: '确定', content: '绕过暂存' }
  )
  await expectNoSpawn(
    'dc-type-unknown-payload',
    '`type` 的 payloadRef 不在暂存里 ⇒ `validation_failed`（拒绝凭引用输入取不到的正文）',
    operate,
    { action: 'type', window: '夹具窗口', index: 0, name: '确定', payloadRef: 'pl_不存在' },
    stagingStub({})
  )
  await expectNoSpawn(
    'dc-type-non-text-payload',
    '`type` 的载荷不是文本 ⇒ `validation_failed`',
    operate,
    { action: 'type', window: '夹具窗口', index: 0, name: '确定', payloadRef: 'pl_json' },
    stagingStub({ pl_json: { kind: 'json' } })
  )
  await expectNoSpawn(
    'dc-type-oversized',
    `一次输入超过 ${String(DESKTOP_TYPE_MAX_CHARS)} 字符 ⇒ \`validation_failed\``,
    operate,
    { action: 'type', window: '夹具窗口', index: 0, name: '确定', payloadRef: 'pl_big' },
    stagingStub({ pl_big: { kind: 'text', text: '字'.repeat(DESKTOP_TYPE_MAX_CHARS + 1) } })
  )

  // ---- ⑦ 隐私边界：正文不进证据 / effect --------------------------------
  const secretText = '绝不能出现在证据里的正文-9f3a'
  const secretAdapter = createDesktopAdapters({
    pythonPath: python,
    workerPath: fixture,
    env: { ...process.env, DESKTOP_FIXTURE_SCENARIO: 'state-ok' },
    staging: stagingStub({ pl_secret: { kind: 'text', text: secretText } }),
  })
  const inspectPrivacy = await run(secretAdapter[0], {})
  /** ⚠️ 只把**证据与 effect**串起来看：`turnContent` 本来就该含正文（那是它的职责） */
  const evidenceOnly = (outcome: unknown): string =>
    JSON.stringify(
      outcome !== null && typeof outcome === 'object'
        ? {
            evidence: (outcome as { evidence?: unknown }).evidence,
            effect: (outcome as { effect?: unknown }).effect,
          }
        : outcome
    )
  const inspectEvidenceText = inspectPrivacy.ok ? evidenceOnly(inspectPrivacy.outcome) : JSON.stringify(inspectPrivacy)
  const operatePrivacy = await run(
    secretAdapter[1],
    { action: 'type', window: '夹具窗口', index: 0, name: '确定', payloadRef: 'pl_secret' },
    stagingStub({ pl_secret: { kind: 'text', text: secretText } })
  )
  const operateEvidenceText = operatePrivacy.ok ? evidenceOnly(operatePrivacy.outcome) : JSON.stringify(operatePrivacy)
  measuredInputs += 2
  record(
    'dc-privacy-type-text-not-in-evidence',
    '`type` 的正文不进证据 / effect（**只有**程序事实：控件类型 / 窗口 / 坐标 / 字符数）',
    !operateEvidenceText.includes(secretText) && operatePrivacy.ok,
    {
      containsSecret: operateEvidenceText.includes(secretText),
      evidence: operatePrivacy.ok ? operatePrivacy.outcome.evidence : operatePrivacy,
    }
  )
  record(
    'dc-privacy-desktop-text-not-in-evidence',
    '桌面文字只在 `turnContent` 里（证据串里不出现它）',
    inspectPrivacy.ok &&
      inspectEvidenceText.includes('夹具窗口') === false &&
      (inspectPrivacy.outcome.turnContent?.[0]?.text ?? '').includes('夹具窗口'),
    { turnContentKind: inspectPrivacy.ok ? inspectPrivacy.outcome.turnContent?.[0]?.kind : undefined }
  )

  // ---- ⑧ 超时 / 取消 -------------------------------------------------------
  const timeout = await run(adapters('sleep:1500', undefined, 300)[0], {})
  record(
    'dc-timeout',
    '超时 ⇒ `timeout`（工作器被杀且确认退出）',
    !timeout.ok && timeout.code === 'timeout',
    timeout
  )
  const controller = new AbortController()
  controller.abort()
  const cancelled = await run(adapters('sleep:1500', undefined, 5000)[0], { abortSignal: controller.signal })
  record(
    'dc-cancelled',
    '调用方已取消 ⇒ `cancelled`',
    !cancelled.ok && cancelled.code === 'cancelled',
    cancelled
  )

  // ---- ⑨ 工具目录四态（如实"未连接"而不是"猜成可用"） --------------------
  const allOff = buildToolCatalog(registry, { grantedPermissions: [] })
  const desktopOff = allOff.filter((entry) => entry.capability.startsWith('desktop.'))
  measuredInputs += desktopOff.length
  record(
    'dc-catalog-default-off',
    '代码缺省（全 off）：桌面两项都 `enabled=false`、`authorized=false`、`connection=unknown`',
    desktopOff.length === 2 &&
      desktopOff.every(
        (entry) => !entry.enabled && !entry.authorized && entry.connection === 'unknown'
      ),
    { desktopOff: desktopOff.map((entry) => `${entry.capability}:${String(entry.enabled)}/${entry.authorized}/${entry.connection}`) }
  )
  const onCatalog = buildToolCatalog(registry, {
    isGateEnabled: (key) => key === 'desktopInspectEnabled' || key === 'desktopOperateEnabled',
    grantedPermissions: [DESKTOP_INSPECT_PERMISSION, DESKTOP_OPERATE_PERMISSION],
    connectionStates: {
      [DESKTOP_INSPECT]: runtime.ok ? 'connected' : 'disconnected',
      [DESKTOP_OPERATE]: runtime.ok ? 'connected' : 'disconnected',
    },
  }).filter((entry) => entry.capability.startsWith('desktop.'))
  record(
    'dc-catalog-on-and-connected',
    '开关打开且运行时在位：桌面两项 `enabled`/`authorized` 都为真，连接态取**真实读数**',
    onCatalog.length === 2 &&
      onCatalog.every((entry) => entry.enabled && entry.authorized) &&
      onCatalog.every((entry) => entry.connection === (runtime.ok ? 'connected' : 'disconnected')),
    { onCatalog: onCatalog.map((entry) => `${entry.capability}:${entry.connection}`) }
  )
  const rendered = renderToolCatalogForModel(onCatalog)
  record(
    'dc-catalog-rendered',
    '目录文本里有这两项、且**没有**累计列出上游那些没登记的入口（shell / registry / clipboard）',
    rendered.includes(DESKTOP_INSPECT) &&
      rendered.includes(DESKTOP_OPERATE) &&
      !/registry|clipboard|powershell/i.test(rendered),
    { bytes: Buffer.byteLength(rendered, 'utf8') }
  )
  const elementLimitBounded = DESKTOP_ELEMENT_LIMIT > 0 && DESKTOP_ELEMENT_LIMIT <= 200
  record(
    'dc-element-limit-bounded',
    `元素上限 ${String(DESKTOP_ELEMENT_LIMIT)} 有界（模型只能下调）`,
    elementLimitBounded,
    { limit: DESKTOP_ELEMENT_LIMIT }
  )

  // ---- ⑩ 三段式量具：登记表/参数表**共享**的那条判据 ----------------------
  const detector = (): readonly { code: string; message: string }[] => auditToolCatalog(registry)
  const quietBefore = detector().length
  const argTable = TASK_ARG_KEYS as unknown as Record<string, readonly string[]>
  const original = argTable[DESKTOP_OPERATE]
  let negativeHit = -1
  try {
    argTable[DESKTOP_OPERATE] = [...(original ?? []), 'shell']
    negativeHit = detector().filter((problem) => problem.code === 'generic_bypass_arg').length
  } finally {
    argTable[DESKTOP_OPERATE] = original
  }
  const quietAfter = detector().length
  measuredInputs += 3
  record(
    'dc-measurement-three-stage',
    '量具三段式：正控安静（0 处）· 注入 `shell` 参数必须响（≥1）· 恢复后重新安静（0 处）',
    quietBefore === 0 && negativeHit >= 1 && quietAfter === 0,
    { quietBefore, negativeHit, quietAfter }
  )

  for (const reading of (await verifyDesktopReplyChain()).cases) {
    measuredInputs += 1
    record(reading.id, reading.title, reading.passed, reading.observed)
  }

  // ---- ⑪ 计数型检测器自检 --------------------------------------------------
  record(
    'dc-measured-count',
    '计数型判据自检：本门真的读到了输入（`measuredInputs > 0`）',
    measuredInputs > 0,
    { measuredInputs, cases: cases.length }
  )

  // -------------------------------------------------------------------------
  // 汇总与证据
  // -------------------------------------------------------------------------
  const failed = cases.filter((item) => item.status === 'FAIL')
  const notRun = cases.filter((item) => item.status === 'NOT RUN')
  const overall = failed.length === 0 && notRun.length === 0

  for (const item of cases) {
    const mark = item.status === 'PASS' ? '·' : item.status === 'FAIL' ? '×' : '!'
    process.stdout.write(`[desktop-control:verify] ${mark} ${item.status.padEnd(7)} ${item.id} — ${item.title}\n`)
    if (item.status !== 'PASS') process.stdout.write(`[desktop-control:verify]     observed = ${JSON.stringify(item.observed)}\n`)
  }
  process.stdout.write(
    `[desktop-control:verify] 判据 ${String(cases.length)} 条 · 未运行 ${String(notRun.length)} · 未通过 ${String(failed.length)} · measuredInputs=${String(measuredInputs)}\n`
  )
  process.stdout.write(`[desktop-control:verify] overall = ${overall ? 'PASS' : 'NOT PASS'}\n`)

  if (writeEvidence) {
    const runId = runIdOf(label)
    const runDir = join(REPO_ROOT, EVIDENCE_PARENT, runId)
    if (existsSync(runDir)) throw new Error(`runId 目录已存在，拒绝覆盖：${runDir}`)
    mkdirSync(runDir, { recursive: true })
    const evidence = {
      schemaVersion: 'desktop-control-offline@1',
      runId,
      head: git(['rev-parse', 'HEAD']),
      startedAt: new Date().toISOString(),
      /** 真实模型调用为 0；使用夹具 worker、登记表与隔离 main.ts 的本地模拟模型，不碰 UIA。 */
      modelCalls: 0,
      uiaTouched: false,
      pinned: { package: 'windows-mcp', version: DESKTOP_MCP_VERSION, protocol: DESKTOP_CONTROL_PROTOCOL },
      runtime: { ok: runtime.ok, version: runtime.version, problems: runtime.problems },
      measuredInputs,
      overall: overall ? 'PASS' : 'NOT PASS',
      cases,
    }
    writeFileSync(join(runDir, 'offline.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    process.stdout.write(`[desktop-control:verify] runId = ${runId}\n`)
    process.stdout.write(`[desktop-control:verify] 证据 = ${EVIDENCE_PARENT}/${runId}/offline.json\n`)
  }

  rmSync(scratch, { recursive: true, force: true })
  return overall ? 0 : 1
}

process.exit(await main())
