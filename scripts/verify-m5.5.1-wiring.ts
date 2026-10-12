/**
 * M5.5.1 WP4 —— **接线门**（`pnpm m5.5.1:verify`）。
 *
 * ============================================================================
 *  它补的是 `m5.5.1:test` 补不了的那一块
 * ============================================================================
 * `m5.5.1:test` 是**部件级**（纯函数 + fixture）。它证明不了"生产轮次上，
 * 显式候选真的经过了判定"—— ADR-049 §11.3 逐字点名了这件事：
 * "WP3 的适配器部件通过不等于生产路径已经具备否决能力"。
 *
 * 这一门因此跑**真实链路**：
 *
 * ```text
 * 用户原话 → 词形检测器（候选） → resolveSearchNeed（判定 → 授权 → 绑定 query）
 *          → ActionRequest → 真实 Policy/Gateway → 计数 provider → 账本
 * ```
 *
 * 库里是**隔离库**（`isolateDatabase`），provider 是**计数 fixture**，
 * 判定器是**离线 fixture** ⇒ 不联网、不调模型、可重复。
 *
 * ---------------------------------------------------------------------------
 *  三条硬性质（每条都有正控 + 负控 + 恢复）
 * ---------------------------------------------------------------------------
 * 1. **两模式的显式候选都过判定**：放行时 provider 恰好 1 次；判定说非 search 时 **0 次**。
 * 2. **explicit 模式无词形 ⇒ 判定 0 次、provider 0 次**（`R2` §11.3 要保住的那条）。
 * 3. **旁路必须被抓**：把"没有接解析器的旧装配"（= 词形命中就直通）放进同一套判据里跑，
 *    它必须**失败**。只做正控的门与"什么都不检查"在输出上无法区分。
 *
 * ⚠️ 本门**不**宣称"生产 `main.ts` 的装配已验证"。它验证的是**内核装配**
 *    （`resolveSearchNeed` + `createActionTurnPort` + 真实 Gateway/Policy/账本），
 *    并用一条**静态等价检查**证明 `main.ts` 装的是同一组东西。
 */

import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'

isolateDatabase('m5.5.1-wiring')

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
import { applySearchNeedReplyPolicy } from '../src/kernel/action/search-need-reply.ts'
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

// ---------------------------------------------------------------------------
// 计数 provider（**量具**：这一轮到底有没有出站，只有它说了算）
// ---------------------------------------------------------------------------

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
// 与 `main.ts` 同形的接线（WP4 的被测对象）
// ---------------------------------------------------------------------------

interface WiringOptions {
  registry: ReturnType<typeof createCapabilityRegistry>
  gateway: ReturnType<typeof createActionGateway>
  judge: SearchNeedJudgePort
  mode: string
  /** `false` = 故意装成**没有解析器**的旧装配（旁路注入用） */
  withResolver?: boolean
  dryRun?: boolean
  observed: { judgeCalls: number; codes: string[] }
}

/**
 * 构造轮次端口。
 *
 * ⚠️ 这里的 `resolveIntent` 逻辑与 `main.ts` 的 `buildSearchResolver()` **同形**：
 *    本地动作原样放行 → 词形命中即"显式候选" → `resolveSearchNeed` → 只有
 *    `action === 'search'` 才产出请求，且 query **只用判定通过的那一段**。
 *    两者的等价性由 §4 的静态检查守着（"装配层装的是同一组东西"）。
 */
function turnPortOf(options: WiringOptions): ActionTurnPort {
  const { registry, gateway, judge, mode } = options
  const withResolver = options.withResolver !== false
  const dryRun = options.dryRun === true

  return createActionTurnPort({
    gateway,
    detector: chainIntentDetectors([
      createActionIntentDetector(),
      createExternalEvidenceIntentDetector(),
    ]),
    registry,
    ...(withResolver
      ? {
          resolveIntent: async (input: { text: string; baseline?: ActionIntent }): Promise<ResolvedActionIntent> => {
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
        }
      : {}),
  })
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

const harness = await createM55Harness({ label: 'm551-wiring', evidenceTokens: 800 })
const { h } = harness
const sandboxOptions = { root: `${ROOT}/data/action-sandbox-m551-wiring` }
const registry = createCapabilityRegistry([
  ...createDefaultCapabilityDefinitions(),
  ...createExternalEvidenceCapabilityDefinitions(),
])
const ledger = createActionLedgerStore(h.kernel.stores.db)

const fixtureBase = createFixtureSearchProvider({ id: 'fixture-m551' })
const offProvider = countingProvider(fixtureBase, 'fixture-m551')
/** 与 `main.ts` 同形：授予 `web:search` + 构造适配器（两件事少一件都不算打开） */
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

/** 一个网关 = 一份真实轮次；`actionWriter` 就是被测的那个端口 */
const gatewayWith = (port: ActionTurnPort): TurnGateway =>
  new TurnGateway({
    kernel: h.kernel,
    definition: h.kernel.definition,
    identity: h.kernel.identitySnapshot,
    recorder: h.recorder,
    conversationSequence: h.nextTurnSequence,
    recentLimit: 16,
    slowPathEnabled: false,
    dryRun: false,
    userId: h.userId,
    actionWriter: port,
    actionEnabled: true,
    recallBudget: { ...DEFAULT_CONTEXT_BUDGET, externalEvidenceTokens: 800 },
  })

/** 判定语料：**判定输出是数据，断言在门里** */
const judgeOutputs: Record<string, string> = {
  帮我联网搜索台风最新路径: JSON.stringify({
    decision: 'search',
    reason: 'explicit_public_sourcing',
    querySpan: { start: 6, end: 12 },
  }),
  现在黄金价格是多少: JSON.stringify({
    decision: 'search',
    reason: 'time_sensitive_fact',
    querySpan: { start: 2, end: 6 },
  }),
  我查一下我的笔记: JSON.stringify({ decision: 'answer', reason: 'private_object' }),
}

interface TurnReport {
  label: string
  code: string
  kind: string
  providerCalls: number
  judgeCalls: number
  query?: string
  searchState?: string
}

async function runTurn(input: {
  text: string
  judge: SearchNeedJudgePort
  mode: string
  withResolver?: boolean
}): Promise<TurnReport> {
  const observed = { judgeCalls: 0, codes: [] as string[] }
  const port = turnPortOf({
    registry,
    gateway,
    judge: input.judge,
    mode: input.mode,
    observed,
    ...(input.withResolver !== undefined ? { withResolver: input.withResolver } : {}),
  })
  const before = offProvider.calls()
  const turn = await harness.say({
    gateway: gatewayWith(port),
    text: input.text,
    replyText: '（本轮是门合成的回复，不参与判定）',
  })
  const search = searchFactOf(turn.turn.actionResults)
  return {
    label: input.text,
    code: observed.codes.at(-1) ?? '-',
    kind: search === undefined ? 'no_search' : search.status,
    providerCalls: offProvider.calls() - before,
    judgeCalls: observed.judgeCalls,
    ...(offProvider.queries().length > 0 ? { query: offProvider.queries().at(-1) } : {}),
    ...(search !== undefined ? { searchState: search.status } : {}),
  }
}

// ===========================================================================
section('§1 正控：两模式的显式候选都**经过判定**，放行时 provider 恰好 1 次')
// ===========================================================================

const judge = createFixtureSearchNeedJudge({ outputs: judgeOutputs })
const explicitAllowed = await runTurn({
  text: '帮我联网搜索台风最新路径',
  judge,
  mode: 'explicit',
})
check(
  '★ 正控（explicit 模式）：词形命中 + 判定 search ⇒ provider 恰好 1 次',
  explicitAllowed.providerCalls === 1 && explicitAllowed.judgeCalls === 1,
  `provider=${explicitAllowed.providerCalls} · judge=${explicitAllowed.judgeCalls} · code=${explicitAllowed.code}`
)
check(
  '★ 绑定：出站 query 是**判定通过的那一段**（`台风最新路径`），不是旧抽法',
  explicitAllowed.query === '台风最新路径',
  JSON.stringify(explicitAllowed.query)
)
const autoAllowed = await runTurn({ text: '现在黄金价格是多少', judge, mode: 'auto_public' })
check(
  '★ 正控（auto_public 模式）：无词形 ⇒ 自动候选送判定 ⇒ 判定 search ⇒ provider 1 次',
  autoAllowed.providerCalls === 1 && autoAllowed.judgeCalls === 1 && autoAllowed.code === 'allowed',
  `provider=${autoAllowed.providerCalls} · judge=${autoAllowed.judgeCalls} · code=${autoAllowed.code}`
)

// ===========================================================================
section('§2 负控：R2 §11.3 点名的两种"零出站"')
// ===========================================================================

const explicitNoCandidate = await runTurn({
  text: '现在黄金价格是多少',
  judge,
  mode: 'explicit',
})
check(
  '★ 负控：**explicit 模式 + 无词形命中 ⇒ 判定 0 次、provider 0 次**（连模型都不问）',
  explicitNoCandidate.providerCalls === 0 &&
    explicitNoCandidate.judgeCalls === 0 &&
    explicitNoCandidate.code === 'no_candidate',
  `provider=${explicitNoCandidate.providerCalls} · judge=${explicitNoCandidate.judgeCalls} · code=${explicitNoCandidate.code}`
)
const explicitPrivate = await runTurn({
  text: '我查一下我的笔记',
  judge,
  mode: 'explicit',
})
check(
  '★ ★ 负控（裁定点名的用例）：**显式私人查询被否决** —— 词形命中、判定说 answer ⇒ provider 0 次',
  explicitPrivate.providerCalls === 0 &&
    explicitPrivate.judgeCalls === 1 &&
    explicitPrivate.code === 'no_action',
  `provider=${explicitPrivate.providerCalls} · judge=${explicitPrivate.judgeCalls} · code=${explicitPrivate.code}`
)
const autoPrivate = await runTurn({ text: '我查一下我的笔记', judge, mode: 'auto_public' })
check(
  '★ 负控：auto_public 下同一句私人查询 ⇒ provider 0 次',
  autoPrivate.providerCalls === 0 && autoPrivate.code === 'no_action',
  `provider=${autoPrivate.providerCalls} · code=${autoPrivate.code}`
)
const failingJudge = createFixtureSearchNeedJudge({
  failures: { 帮我联网搜索台风最新路径: 'timeout' },
})
const judgeTimeout = await runTurn({
  text: '帮我联网搜索台风最新路径',
  judge: failingJudge,
  mode: 'explicit',
})
check(
  '★ 负控：判定**超时** ⇒ provider 0 次（不回退旧 detector、不补搜）',
  judgeTimeout.providerCalls === 0 && judgeTimeout.code === 'judge_failed',
  `provider=${judgeTimeout.providerCalls} · code=${judgeTimeout.code}`
)
/*
 * ⚠️ 必须**显式**覆盖这一句的输出：fixture 的 `outputs` 与默认语料是**合并**的，
 *    只改 `fallback` 不会影响这一句（第一版就是这么写错的 —— 它照样走通并出站 1 次）。
 */
const badOutputJudge = createFixtureSearchNeedJudge({
  outputs: { 帮我联网搜索台风最新路径: '{"decision":' },
})
const judgeAbsent = await runTurn({
  text: '帮我联网搜索台风最新路径',
  judge: badOutputJudge,
  mode: 'explicit',
})
check(
  '★ 前提核对：判定器**在场但输出非法**时同样 0 出站（`judge_failed`）',
  judgeAbsent.providerCalls === 0 && judgeAbsent.code === 'judge_failed',
  `provider=${judgeAbsent.providerCalls} · code=${judgeAbsent.code}`
)

// ===========================================================================
section('§3 旁路注入：把"没有解析器的旧装配"放进同一套判据 ⇒ 它必须**失败**')
// ===========================================================================

const bypassTurn = await runTurn({
  text: '我查一下我的笔记',
  judge,
  mode: 'explicit',
  withResolver: false,
})
check(
  '★ 旁路检测器（② 负控）：**无解析器装配**在"显式私人查询"上出站 1 次 ⇒ 判据必须能分辨出来',
  bypassTurn.providerCalls === 1,
  `旁路装配 provider=${bypassTurn.providerCalls}（接好解析器时是 0）`
)
check(
  '★ 判据有效性：同一个输入，**接好解析器 = 0 次**、**旁路装配 = 1 次** ⇒ 两者可区分',
  explicitPrivate.providerCalls === 0 && bypassTurn.providerCalls === 1,
  `0 vs 1`
)
check(
  '★ 旁路检测器（③ 恢复）：接回解析器后同一个输入重新变成 0 次出站',
  (await runTurn({ text: '我查一下我的笔记', judge, mode: 'explicit' })).providerCalls === 0,
  '恢复后 0 次'
)
const bypassNoForm = await runTurn({
  text: '现在黄金价格是多少',
  judge,
  mode: 'explicit',
  withResolver: false,
})
check(
  '★ 旁路检测器：**无词形**的句子在旁路装配下也是 0 次（说明它靠的是词形直通，不是判定）',
  bypassNoForm.providerCalls === 0 && bypassNoForm.judgeCalls === 0,
  `provider=${bypassNoForm.providerCalls} · judge=${bypassNoForm.judgeCalls}`
)

// ===========================================================================
section('§4 装配等价性 + 账本读回（「生产 `main.ts` 装的是同一组东西」可证）')
// ===========================================================================

const mainSource = readFileSync('src/main.ts', 'utf8')
const wiringMarkers: { label: string; pattern: RegExp }[] = [
  { label: '装了共用解析入口 `resolveSearchNeed`', pattern: /resolveSearchNeed\(/ },
  /*
   * ⚠️ 判据更新（S4 起，**登记在案**）：判定器工厂现在**必须带参数**（超时来自配置），
   *    因此不再匹配空括号 `/\(\)/`。改判据的同时把要求**收紧**：还要证明超时确实来自 flags。
   */
  { label: '装了判定器工厂 `createOpenAiSearchNeedJudge(...)`', pattern: /createOpenAiSearchNeedJudge\(\{/ },
  { label: '判定超时来自**配置入口** flags（不是硬编码、也不是静默缺省）', pattern: /timeoutMs:\s*judgeTimeoutMs/ },
  { label: '配置非法 ⇒ 不构造判定器（失败关闭）', pattern: /if \(judgeTimeoutMs === undefined\) return undefined/ },
  { label: '解析器挂在 `resolveIntent` 上（不是改 `detect()`）', pattern: /resolveIntent:\s*searchResolution/ },
  { label: '判定器缺席时不配钩子（failing closed）', pattern: /flags\.webSearchMode === undefined\)\s*return undefined/ },
  { label: '模式非法 ⇒ 与开关关闭同一条路（不授权/不构造适配器）', pattern: /webSearchEnabled === true && searchModeValid/ },
]
for (const marker of wiringMarkers) {
  check(`★ 静态等价：\`main.ts\` ${marker.label}`, marker.pattern.test(mainSource), marker.pattern.source.slice(0, 42))
}
check(
  '★ 静态等价：`main.ts` 的 `resolveIntent` 里**没有**直接用词形检测器的 query（否则 L-M55-17 会复活）',
  !/args:\s*\{\s*query:\s*(?:baseline|intent)\.args\.query/.test(mainSource),
  '未回落到旧抽取'
)

const rows = await harness.actionRows()
const searchRows = rows.filter((row) =>
  String((row as { capability?: unknown }).capability ?? '').includes('web')
)
check(
  '★ 账本读回：放行的那一轮在账本里留下了 `web.search` 记录（真执行过，不是只算了个数）',
  searchRows.length >= 1,
  `${searchRows.length} 行 web 记录 / 共 ${rows.length} 行`
)
/*
 * 判据用**计数 provider**当口径，不用魔数：账本里的 `web.search` 记录数必须**等于**
 * 这一门里真正发生过的出站次数（含 §3 那个故意注入的旁路装配）。
 * 被否决的轮次如果也落了 `executed` 行，这个等式立刻就不成立。
 */
const totalProviderCalls = offProvider.calls()
check(
  '★ 账本读回：账本记录数 **== 真正出站次数**（被否决的轮次没有伪造 `executed` 记录）',
  searchRows.length === totalProviderCalls,
  `web 记录 ${searchRows.length} 行 · 真实出站 ${totalProviderCalls} 次（含 §3 的旁路注入 1 次）`
)
const rowText = JSON.stringify(rows)
check(
  '★ 隐私：账本里没有判定器的原始输出、没有用户原话（判据：不含哨兵文本）',
  !rowText.includes('台风最新路径') && !rowText.includes('private_object'),
  '账本不含 query 原文与判定原文'
)

function readFileSyncSafe(path: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('node:fs').readFileSync(path, 'utf8') as string
}

// ===========================================================================
section('§5 回复绑定：真实轮次的判定码 ⇒ "未查"如实句（不冒充成功）')
// ===========================================================================

const CLAIM = '我上网查了一下，结果如下。'
const replyRows: { label: string; code: string; expectReplaced: boolean }[] = [
  { label: '放行的那一轮（code=allowed）⇒ 回复逐字不改', code: explicitAllowed.code, expectReplaced: false },
  { label: '无词形的那一轮（no_candidate）⇒ **不接手**（L-M55-03 边界）', code: explicitNoCandidate.code, expectReplaced: false },
  { label: '★ 显式私人查询（no_action）⇒ 成功口吻被如实句顶替', code: explicitPrivate.code, expectReplaced: true },
  { label: '判定超时（judge_failed）⇒ 顶替，且句子与"查了没结果"不同', code: judgeTimeout.code, expectReplaced: true },
]
for (const row of replyRows) {
  const outcome = applySearchNeedReplyPolicy({
    ...(row.code !== '-' ? { resolutionCode: row.code } : {}),
    searchState: 'no_search',
    replyText: CLAIM,
  })
  check(
    `★ ${row.label}`,
    outcome.replaced === row.expectReplaced && (!outcome.replaced || !outcome.replyText.includes('我上网查了一下')),
    `code=${row.code} · state=${outcome.state} · replaced=${outcome.replaced}`
  )
}
check(
  '★ 至少有一行**真的**发生了顶替（否则这一节全是对一个哑策略断言"不改写"）',
  replyRows.some((row) => row.expectReplaced),
  `${replyRows.filter((r) => r.expectReplaced).length} 行应当顶替`
)
// ===========================================================================
// 证据
// ===========================================================================

const evidence = {
  testId: 'M5.5.1 / WP4 wiring (real TurnGateway · isolated DB · counting provider · fixture judge)',
  note:
    '补 m5.5.1:test 补不了的那一块：生产轮次上显式/自动候选是否真的经过判定。' +
    '库里是隔离库，provider 是计数 fixture，判定器是离线 fixture ⇒ 不联网、不调模型、可重复。' +
    '⚠️ 不宣称"main.ts 的装配已验证"：本门验证内核装配，另用静态等价检查证明 main.ts 装的是同一组东西。',
  passed,
  failed,
  failures,
  checks,
  turns: {
    explicitAllowed,
    autoAllowed,
    explicitNoCandidate,
    explicitPrivate,
    autoPrivate,
    judgeTimeout,
    bypassTurn,
    bypassNoForm,
  },
  judgeVersion: 'm5.5.1',
}
mkdirSync(EVIDENCE_DIR, { recursive: true })
writeFileSync(join(EVIDENCE_DIR, 'wiring.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log(`\nM5.5.1 WP4 接线门：${passed} 通过 / ${failed} 失败`)
console.log(`  证据：artifacts/m5.5.1/wiring.json`)
await harness.dispose()
process.exit(failed > 0 ? 1 : 0)
