/**
 * `m5.5.1:e2e:verify` —— M5.5.1 的**端到端门**（计划 §7.1 承诺的最后一个入口）。
 *
 * 为什么单独存在、以及它**不**做什么（用户 2026-09-22 指示："先核对现有 wiring/smoke 覆盖，
 * 复用已有验证，只补缺口"）：
 *   · H1–H6 与 §7.2 语义矩阵的**确定性层**已由 `m5.5.1:verify`（接线 28/0）与
 *     `m5.5.1:smoke:live`（真实进程 20/0）覆盖 ⇒ **本门不重造那些断言**，只在 §0 只读复用它们的落盘证据。
 *   · 真正**没有任何门断言过**的只有两条 ⇒ 本门补的就是这两条：
 *       ① `dryRun` 下**新增调用为 0**（判定器 + 搜索 provider 都不许被调用）
 *       ② 显式 + 自动在**同一轮**里**不双发**（一次解析入口、≤1 次判定、≤1 次出站）
 *
 * 环境：`createM55Harness` 起**隔离库** + 真实 `TurnGateway` + **离线 fixture 判定器** +
 *       **计数 fixture provider** ⇒ 不联网、不调真实模型、真实库只读（与 wiring 同一套纪律）。
 */
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'

isolateDatabase('m5.5.1-e2e')

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM55Harness } from './m5.5-harness.ts'
import { createFixtureSearchProvider } from '../src/infrastructure/search/fixture-search-provider.ts'
import { createSha256Fingerprinter } from '../src/infrastructure/search/fingerprint.ts'
import { createFixtureSearchNeedJudge } from '../src/infrastructure/model/fixture-search-need-judge.ts'
import { createWebSearchAdapter } from '../src/infrastructure/action/adapters/web-search.ts'
import { createEchoAdapter } from '../src/infrastructure/action/adapters/echo.ts'
import {
  createSandboxReadAdapter,
  createSandboxWriteAdapter,
  listSandboxEntries,
} from '../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import { createActionLedgerStore } from '../src/infrastructure/action/action-ledger-store.ts'
import {
  DEFAULT_GRANTED_PERMISSIONS,
  createCapabilityRegistry,
  createDefaultCapabilityDefinitions,
} from '../src/kernel/action/capability-registry.ts'
import {
  WEB_SEARCH,
  WEB_SEARCH_PERMISSION,
  createExternalEvidenceCapabilityDefinitions,
} from '../src/kernel/action/external-evidence-capability.ts'
import { createActionGateway } from '../src/kernel/action/gateway.ts'
import {
  createActionTurnPort,
  type ActionTurnPort,
  type ResolvedActionIntent,
} from '../src/kernel/action/action-turn.ts'
import type { ActionIntent } from '../src/kernel/action/intent-detector.ts'
import { createActionIntentDetector } from '../src/kernel/action/intent-detector.ts'
import {
  chainIntentDetectors,
  createExternalEvidenceIntentDetector,
} from '../src/kernel/action/external-evidence-intent.ts'
import { resolveSearchNeed } from '../src/kernel/action/search-need-resolution.ts'
import { resolveActionTarget } from '../src/kernel/action/target-resolver.ts'
import { hasSideEffect } from '../src/kernel/action/action-request.ts'
import { searchFactOf } from '../src/kernel/action/external-evidence-reply.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import type { SearchProviderPort } from '../src/kernel/action/search-port.ts'
import type { SearchNeedJudgePort } from '../src/kernel/action/search-need-judge.ts'

const ROOT = resolve('.')
const EVIDENCE_DIR = join(ROOT, 'artifacts', 'm5.5.1')

let passed = 0
let failed = 0
const failures: string[] = []
const checks: { label: string; ok: boolean; detail: string }[] = []
function check(label: string, ok: boolean, detail = ''): boolean {
  checks.push({ label, ok, detail })
  if (ok) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? `  [${detail}]` : ''}`)
  } else {
    failed += 1
    failures.push(`${label} :: ${detail}`)
    console.log(`  ❌ ${label}${detail ? `  [${detail}]` : ''}`)
  }
  return ok
}
function section(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}

interface CountingProvider extends SearchProviderPort {
  calls(): number
  queries(): readonly string[]
}
function countingProvider(base: SearchProviderPort, id: string): CountingProvider {
  let calls = 0
  const queries: string[] = []
  return {
    id,
    endpointHost: base.endpointHost,
    calls: () => calls,
    queries: () => queries,
    async search(input) {
      calls += 1
      queries.push(input.query)
      return await base.search(input)
    },
  }
}

// ---------------------------------------------------------------------------
// §0 复用已有验证（**只读**：缺证据 = 不算过，本门不重跑它们）
// ---------------------------------------------------------------------------

section('§0 复用已有验证：H1–H6 与确定性层由 wiring / smoke 承载（只读）')

const readEvidence = (rel: string): Record<string, unknown> | null => {
  const p = join(ROOT, rel)
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}
const wiringEvidence = readEvidence('artifacts/m5.5.1/wiring.json')
const smokeEvidence = readEvidence('artifacts/m5.5.1/smoke/smoke-live.json')
const greenOf = (o: Record<string, unknown> | null): boolean =>
  o !== null && typeof o.passed === 'number' && typeof o.failed === 'number' && o.passed > 0 && o.failed === 0
check(
  '★ 复用：`m5.5.1:verify`（接线 28 项）的落盘证据是绿的 —— H1–H6 不在本门重复断言',
  greenOf(wiringEvidence),
  wiringEvidence === null ? 'wiring.json 不存在 ⇒ NOT RUN（不算过）' : `passed=${String(wiringEvidence.passed)} failed=${String(wiringEvidence.failed)}`
)
check(
  '★ 复用：`m5.5.1:smoke:live`（真实进程 20 项）的落盘证据是绿的',
  greenOf(smokeEvidence),
  smokeEvidence === null ? 'smoke-live.json 不存在 ⇒ NOT RUN（不算过）' : `passed=${String(smokeEvidence.passed)} failed=${String(smokeEvidence.failed)}`
)

// ---------------------------------------------------------------------------
// 装配（与 `verify-m5.5.1-wiring.ts` **同一套**：隔离库 + 真实 TurnGateway + 离线 fixture）
// ---------------------------------------------------------------------------

const harness = await createM55Harness({ label: 'm551-e2e', evidenceTokens: 800 })
const { h } = harness
const sandboxOptions = { root: `${ROOT}/data/action-sandbox-m551-e2e` }
const registry = createCapabilityRegistry([
  ...createDefaultCapabilityDefinitions(),
  ...createExternalEvidenceCapabilityDefinitions(),
])
const ledger = createActionLedgerStore(h.kernel.stores.db)
const fixtureBase = createFixtureSearchProvider({ id: 'fixture-m551-e2e' })
const offProvider = countingProvider(fixtureBase, 'fixture-m551-e2e')
const gateway = createActionGateway({
  registry,
  ledger,
  adapters: [
    createEchoAdapter(),
    createSandboxReadAdapter(sandboxOptions),
    createSandboxWriteAdapter(sandboxOptions),
    createWebSearchAdapter({ provider: offProvider, fingerprint: createSha256Fingerprinter() }),
  ],
  grantedPermissions: [...DEFAULT_GRANTED_PERMISSIONS, WEB_SEARCH_PERMISSION],
  maxRiskLevel: 'R1',
  dryRun: false,
  now: () => Date.now(),
  resolveTarget: async ({ request, operation }) => {
    if (request.capability === WEB_SEARCH) {
      return {
        target: {
          type: 'external_service',
          canonicalId: offProvider.id,
          displayName: '离线计数 fixture 搜索服务',
          confidence: 'exact',
        },
        scopeViolation: false,
      }
    }
    return await resolveActionTarget({
      targetType: 'sandbox_file',
      ...(request.target !== undefined ? { declared: request.target } : {}),
      hints: typeof request.arguments.path === 'string' ? [request.arguments.path] : [],
      listEntries: () => listSandboxEntries(sandboxOptions),
      allowMissing: operation !== undefined && hasSideEffect(operation.sideEffect),
    })
  },
})
const gatewayWith = (port: ActionTurnPort, dryRun: boolean): TurnGateway =>
  new TurnGateway({
    kernel: h.kernel,
    definition: h.kernel.definition,
    identity: h.kernel.identitySnapshot,
    recorder: h.recorder,
    conversationSequence: h.nextTurnSequence,
    recentLimit: 16,
    slowPathEnabled: false,
    dryRun,
    userId: h.userId,
    actionWriter: port,
    actionEnabled: true,
    recallBudget: { ...DEFAULT_CONTEXT_BUDGET, externalEvidenceTokens: 800 },
  })

/** ⚠️ 与 wiring 的唯一差别：`dryRun` **真的**透传给 `resolveSearchNeed`（wiring 没有传 ⇒ 这条一直没被测） */
interface E2EOptions {
  registry: ReturnType<typeof createCapabilityRegistry>
  gateway: ReturnType<typeof createActionGateway>
  judge: SearchNeedJudgePort
  mode: string
  dryRun: boolean
  observed: { judgeCalls: number; resolverCalls: number; codes: string[] }
}
function turnPortOf(options: E2EOptions): ActionTurnPort {
  const { registry, gateway, judge, mode, dryRun } = options
  return createActionTurnPort({
    gateway,
    detector: chainIntentDetectors([
      createActionIntentDetector(),
      createExternalEvidenceIntentDetector(),
    ]),
    registry,
    resolveIntent: async (input: { text: string; baseline?: ActionIntent }): Promise<ResolvedActionIntent> => {
      options.observed.resolverCalls += 1
      const baseline = input.baseline
      if (baseline !== undefined && baseline.capability !== WEB_SEARCH) {
        return { intent: baseline }
      }
      const explicitCandidate = baseline?.capability === WEB_SEARCH
      const resolution = await resolveSearchNeed(
        {
          text: input.text,
          mode,
          masterEnabled: true,
          dryRun,
          localActionFired: baseline !== undefined && explicitCandidate !== true,
          providerCallsUsed: 0,
          judgeCallsUsed: 0,
          explicitCandidate,
        },
        { judge }
      )
      if (resolution.judgeCalls > 0) options.observed.judgeCalls += 1
      options.observed.codes.push(resolution.code)
      if (resolution.action !== 'search' || resolution.query === undefined) {
        return { diagnostics: { search_need_code: resolution.code } }
      }
      return {
        intent: {
          capability: WEB_SEARCH,
          operation: 'search',
          args: { query: resolution.query, limit: 5, locale: 'zh-CN' },
          hints: [],
          rule: 'search_need_judged',
          phrase: input.text.slice(0, 60),
        } as never,
        diagnostics: { search_need_code: resolution.code },
      }
    },
  })
}

const judgeOutputs: Record<string, string> = {
  帮我联网搜索台风最新路径: JSON.stringify({
    decision: 'search',
    reason: 'explicit_public_sourcing',
    querySpan: { start: 6, end: 12 },
  }),
  我查一下我的笔记: JSON.stringify({ decision: 'answer', reason: 'private_object' }),
}

interface TurnReport {
  code: string
  providerCalls: number
  judgeCalls: number
  resolverCalls: number
  searchState?: string
}
async function runTurn(input: {
  text: string
  judge: SearchNeedJudgePort
  mode: string
  dryRun: boolean
}): Promise<TurnReport> {
  const observed = { judgeCalls: 0, resolverCalls: 0, codes: [] as string[] }
  const port = turnPortOf({
    registry,
    gateway,
    judge: input.judge,
    mode: input.mode,
    dryRun: input.dryRun,
    observed,
  })
  const before = offProvider.calls()
  const turn = await harness.say({
    gateway: gatewayWith(port, input.dryRun),
    text: input.text,
    replyText: '（本轮是门合成的回复，不参与判定）',
  })
  const search = searchFactOf(turn.turn.actionResults)
  return {
    code: observed.codes.at(-1) ?? '-',
    providerCalls: offProvider.calls() - before,
    judgeCalls: observed.judgeCalls,
    resolverCalls: observed.resolverCalls,
    ...(search !== undefined ? { searchState: search.status } : {}),
  }
}

const judge = createFixtureSearchNeedJudge({ outputs: judgeOutputs })

// ---------------------------------------------------------------------------
// §1 缺口①：`dryRun` ⇒ **新增调用为 0**
// ---------------------------------------------------------------------------

section('§1 缺口①：`dryRun` 下判定器与搜索 provider 的**新增调用都是 0**')

const dryPort = await runTurn({
  text: '帮我联网搜索台风最新路径',
  judge,
  mode: 'explicit',
  dryRun: true,
})
check(
  '★ dryRun（网关层）：显式搜索句 ⇒ 判定 **0** 次、出站 **0** 次',
  dryPort.judgeCalls === 0 && dryPort.providerCalls === 0,
  `judge=${dryPort.judgeCalls} · provider=${dryPort.providerCalls} · code=${dryPort.code}`
)

// 层内直证：即使真的走到解析入口，`dryRun` 也不许调用判定器
let dryResolutionJudgeCalls = -1
let dryResolutionAction = '-'
const dryProbe = await resolveSearchNeed(
  {
    text: '帮我联网搜索台风最新路径',
    mode: 'explicit',
    masterEnabled: true,
    dryRun: true,
    localActionFired: false,
    providerCallsUsed: 0,
    judgeCallsUsed: 0,
    explicitCandidate: true,
  },
  { judge }
)
dryResolutionJudgeCalls = dryProbe.judgeCalls
dryResolutionAction = dryProbe.action
check(
  '★ dryRun（解析层，正控）：走到 `resolveSearchNeed` 也不调判定器 ⇒ judgeCalls = 0 且 action ≠ search',
  dryResolutionJudgeCalls === 0 && dryResolutionAction !== 'search',
  `judgeCalls=${dryResolutionJudgeCalls} · action=${dryResolutionAction} · code=${dryProbe.code}`
)

// 恢复：同一个句子在 dryRun=false 下必须真的调用判定器并出站一次（证明上一条有牙）
const wetPort = await runTurn({
  text: '帮我联网搜索台风最新路径',
  judge,
  mode: 'explicit',
  dryRun: false,
})
check(
  '★ 恢复：同一句在 `dryRun=false` 下 ⇒ 判定恰好 1 次、出站恰好 1 次',
  wetPort.judgeCalls === 1 && wetPort.providerCalls === 1,
  `judge=${wetPort.judgeCalls} · provider=${wetPort.providerCalls} · code=${wetPort.code}`
)

// ---------------------------------------------------------------------------
// §2 缺口②：显式 + 自动在**同一轮**里**不双发**
// ---------------------------------------------------------------------------

section('§2 缺口②：同一轮里显式候选与自动路径**不双发**（一次解析入口、≤1 判定、≤1 出站）')

const autoBoth = await runTurn({
  text: '帮我联网搜索台风最新路径',
  judge,
  mode: 'auto_public',
  dryRun: false,
})
check(
  '★ auto_public：句子**同时**带显式搜索词形且够自动 ⇒ 解析入口 **恰好 1** 次、判定 ≤1、出站 ≤1（不得 2）',
  autoBoth.resolverCalls === 1 && autoBoth.judgeCalls <= 1 && autoBoth.providerCalls <= 1,
  `resolver=${autoBoth.resolverCalls} · judge=${autoBoth.judgeCalls} · provider=${autoBoth.providerCalls} · code=${autoBoth.code}`
)
check(
  '★ auto_public：该轮**确实**发生了搜索（否则"不双发"可能只是"什么都没做"）',
  autoBoth.providerCalls === 1 && autoBoth.searchState !== undefined,
  `provider=${autoBoth.providerCalls} · searchState=${autoBoth.searchState ?? '(无)'}`
)

const explicitBoth = await runTurn({
  text: '帮我联网搜索台风最新路径',
  judge,
  mode: 'explicit',
  dryRun: false,
})
check(
  '★ explicit（正控）：同一句 ⇒ 解析入口恰好 1 次、判定 1 次、出站 1 次',
  explicitBoth.resolverCalls === 1 && explicitBoth.judgeCalls === 1 && explicitBoth.providerCalls === 1,
  `resolver=${explicitBoth.resolverCalls} · judge=${explicitBoth.judgeCalls} · provider=${explicitBoth.providerCalls}`
)

const autoPrivate = await runTurn({
  text: '我查一下我的笔记',
  judge,
  mode: 'auto_public',
  dryRun: false,
})
check(
  '★ auto_public（负控）：私人对象 ⇒ 出站 **0** 次（自动路径不许把它补搜出去）',
  autoPrivate.providerCalls === 0,
  `resolver=${autoPrivate.resolverCalls} · judge=${autoPrivate.judgeCalls} · provider=${autoPrivate.providerCalls} · code=${autoPrivate.code}`
)

// ---------------------------------------------------------------------------
// 证据
// ---------------------------------------------------------------------------

mkdirSync(EVIDENCE_DIR, { recursive: true })
const outPath = join(EVIDENCE_DIR, 'e2e.json')
writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      testId: 'M5.5.1 / WP6 端到端（只补缺口：dryRun 零新增调用 · 显式+自动不双发）',
      note:
        'H1–H6 与 §7.2 确定性层由 m5.5.1:verify / m5.5.1:smoke:live 承载（§0 只读复用）；' +
        '本门只断言两条此前无人断言的性质。隔离库 + 真实 TurnGateway + 离线 fixture 判定器 + 计数 fixture provider。',
      passed,
      failed,
      failures,
      checks,
      judgeVersion: 'm5.5.1',
      coverage: {
        reused: ['artifacts/m5.5.1/wiring.json', 'artifacts/m5.5.1/smoke/smoke-live.json'],
        addedByThisGate: ['dryRun ⇒ 判定 0 / 出站 0', '同一轮显式+自动不双发（resolver=1 · judge≤1 · provider≤1）'],
      },
    },
    null,
    2
  )}\n`,
  'utf8'
)

console.log(`\nM5.5.1 端到端门：${passed} 通过 / ${failed} 失败`)
if (failures.length > 0) console.log(`失败项：${failures.join(' | ')}`)
console.log(`证据：${outPath.replace(`${ROOT}\\`, '').split('\\').join('/')}`)
process.exit(failed === 0 ? 0 : 1)
