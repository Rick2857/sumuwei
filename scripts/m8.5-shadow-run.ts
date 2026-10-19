/**
 * M8.5 WP10 —— 影子对照（§18；`pnpm with-test-model pnpm m8.5:shadow:run`）
 *
 * 生产库**副本**上的真历史：逐条合格用户消息，词形路径（M8 冻结规则表，
 * `dominantAffectRuleFamily` 纯函数）与语义路径（真模型直连评估）**并行各判
 * 一遍**，按 §18 七类分类学出读数。**无硬一致性阈值**（Corpus-Spec §5：
 * rules 命中处的分歧恰是 M8.5 的价值所在）；读数供激活候选（§22）与分层
 * 抽样人审。
 *
 * 隔离纪律：
 *   · 真实库**只复制、从不打开**（副本落 %TEMP%；前后 digestTree 逐字对照）；
 *   · 双路径都是**纯评估**——零生产写入、零副本提交（比 §18 的"词形照常写"
 *     更强：本门连副本都不写；单写入者不变量由 WP8 门另证）；
 *   · 入库证据**不含正文**（§6.3）；分歧抽样人审材料（含正文）落 gitignore
 *     的 local/。
 *
 * 边界（如实登记）：离线评估钻取，不套用生产来源资格矩阵（cutover/ESTABLISHED
 * 是生产提交资格；这里是对历史消息的纯评估）。量具纪律：measured_count 自检
 * （零 source = INVALID，不是 PASS）。
 */
import type { Character } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { PRODUCTION_DB_DIR, isProductionDir } from '../src/dev/sandbox.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'

// ---------------------------------------------------------------------------
// ① 副本（只复制，从不打开真实库）
// ---------------------------------------------------------------------------

if (!existsSync(PRODUCTION_DB_DIR)) {
  console.error(`找不到真实库：${PRODUCTION_DB_DIR}`)
  process.exit(2)
}
if ((process.env.OPENAI_API_KEY ?? '').trim() === '') {
  console.error('OPENAI_API_KEY 缺失：影子对照需要测试端点（pnpm with-test-model pnpm m8.5:shadow:run）')
  process.exit(2)
}

const work = mkdtempSync(join(tmpdir(), 'project-lg-m85-shadow-'))
const dbDir = join(work, 'pglite')
cpSync(PRODUCTION_DB_DIR, dbDir, { recursive: true })
if (isProductionDir(dbDir)) {
  console.error('拒绝：副本路径被判成生产库')
  process.exit(2)
}
const realDbBefore = digestTree(PRODUCTION_DB_DIR)

// 打开副本（live-smoke 同款 env 契约：PGLITE_DATA_DIR + PROJECT_LG_SANDBOX 指向副本）
process.env.PGLITE_DATA_DIR = dbDir
process.env.PROJECT_LG_SANDBOX = dbDir

// ---------------------------------------------------------------------------
// ② 引导（副本上的内核；读事件用）
// ---------------------------------------------------------------------------



import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { recentConversationEvents } from '../src/infrastructure/persistence/conversation-store.ts'
import type { ConversationEvent } from '../src/kernel/contracts/conversation-event.ts'
import { dominantAffectRuleFamily } from '../src/kernel/app/affect/patterns.ts'
import {
  assembleSemanticContextWindow,
  buildSemanticOutbound,
  evaluateSemanticResponse,
} from '../src/kernel/app/affect/semantic-evaluator.ts'
import { createOpenAiAffectSemanticProvider } from '../src/infrastructure/model/affect-semantic-provider.ts'

const runtime = createThinHostRuntime({
    character: character,
    settings: {},
  })
await initDatabase(runtime)
await runtime.initialize()
const kernel = await initKernel(runtime, { definition: characterDefinitionFromCharacter(character) })
const characterId = kernel.characterId
const db = kernel.stores.db

// ---------------------------------------------------------------------------
// ③ 读真历史（最近 2000 条事件内，取最近 120 个 user_message source）
// ---------------------------------------------------------------------------

const MAX_EVENTS_READ = 2000
const MAX_SOURCES = 120

const allEvents: ConversationEvent[] = []
let beforeSequence: number | undefined = undefined
for (;;) {
  const page = await recentConversationEvents(db, {
    characterId, limit: 1000, ...(beforeSequence === undefined ? {} : { beforeSequence }),
  })
  if (page.length === 0) break
  allEvents.push(...page)
  beforeSequence = page[0].sequence - 1
  if (allEvents.length >= MAX_EVENTS_READ) break
}
allEvents.sort((a, b) => a.sequence - b.sequence)

const userSources = allEvents
  .filter((e) => e.type === 'user_message')
  .slice(-MAX_SOURCES)
if (userSources.length === 0) {
  console.error('measured_count 自检失败：副本里没有 user_message 事件（INVALID，不是 PASS）')
  process.exit(2)
}
console.log(`副本事件 ${String(allEvents.length)} 条（上限 ${String(MAX_EVENTS_READ)}）；影子面 = 最近 ${String(userSources.length)} 个用户 source（上限 ${String(MAX_SOURCES)}）`)

// ---------------------------------------------------------------------------
// ④ 双路径评估 + §18 七类分类
// ---------------------------------------------------------------------------

const provider = createOpenAiAffectSemanticProvider()

type ShadowClass =
  | 'AGREE' | 'LEGACY_MISS' | 'LEGACY_FALSE_POSITIVE' | 'SEMANTIC_MISS'
  | 'FAMILY_DISAGREEMENT' | 'SEMANTIC_ABSTAIN' | 'SEMANTIC_FAILURE'

interface ShadowRecord {
  sourceRef: string
  sequence: number
  conversationId: string
  keywordHit: boolean
  keywordFamily: string | null
  semanticStatus: 'ok' | 'parse_failed' | 'transport_failed'
  semanticDecision: string | null
  semanticFamily: string | null
  failureCode: string | null
  latencyMs: number | null
  shadowClass: ShadowClass
}

const records: ShadowRecord[] = []
const sampleItems: Array<{ record: ShadowRecord; content: string; contextLines: string[] }> = []
let done = 0

for (const source of userSources) {
  const keyword = dominantAffectRuleFamily(source.content)
  const keywordHit = keyword !== undefined
  const keywordFamily = keyword?.ruleId ?? null

  const window = assembleSemanticContextWindow({
    conversationId: source.conversationId,
    sourceSequence: source.sequence,
    sourceAt: Number(source.createdAt),
    candidates: allEvents,
  })
  const request = {
    characterAlias: character.name,
    context: window.messages,
    currentMessage: source.content,
  }
  const outbound = buildSemanticOutbound(request)
  let semanticStatus: ShadowRecord['semanticStatus']
  let semanticDecision: string | null = null
  let semanticFamily: string | null = null
  let failureCode: string | null = null
  let latencyMs: number | null = null
  if (!outbound.ok) {
    semanticStatus = 'parse_failed'
    failureCode = 'input_budget_exceeded'
  } else {
    const outcome = await provider.call({ outboundText: outbound.outbound.text })
    latencyMs = outcome.ok ? (outcome.shape?.totalMs ?? null) : (outcome.shape?.totalMs ?? null)
    if (!outcome.ok) {
      semanticStatus = 'transport_failed'
      failureCode = outcome.failure
    } else {
      const evaluated = evaluateSemanticResponse(outcome.envelope, request)
      if (evaluated.kind !== 'judgment') {
        semanticStatus = 'parse_failed'
        failureCode = evaluated.failure
      } else {
        semanticStatus = 'ok'
        semanticDecision = evaluated.judgment.decision
        semanticFamily = evaluated.judgment.decision === 'IMPACT' ? (evaluated.mapping.dominantFamily ?? null) : null
      }
    }
  }

  let shadowClass: ShadowClass
  if (semanticStatus !== 'ok') {
    shadowClass = 'SEMANTIC_FAILURE'
  } else if (keywordHit && semanticDecision === 'IMPACT') {
    shadowClass = keywordFamily === semanticFamily ? 'AGREE' : 'FAMILY_DISAGREEMENT'
  } else if (keywordHit && semanticDecision === 'NEUTRAL') {
    shadowClass = 'LEGACY_FALSE_POSITIVE'
  } else if (keywordHit && (semanticDecision === 'UNCERTAIN' || semanticDecision === 'OUT_OF_SCOPE')) {
    shadowClass = 'SEMANTIC_ABSTAIN'
  } else if (!keywordHit && semanticDecision === 'IMPACT') {
    shadowClass = 'LEGACY_MISS'
  } else {
    shadowClass = 'AGREE'
  }

  const record: ShadowRecord = {
    sourceRef: source.id, sequence: source.sequence, conversationId: source.conversationId,
    keywordHit, keywordFamily, semanticStatus, semanticDecision, semanticFamily,
    failureCode, latencyMs, shadowClass,
  }
  records.push(record)

  // 分歧抽样（人审材料；含正文 → 只进 local/）
  if (shadowClass !== 'AGREE' && shadowClass !== 'SEMANTIC_FAILURE' && sampleItems.length < 40) {
    sampleItems.push({
      record,
      content: source.content,
      contextLines: window.messages.map((m) => `- [${m.role === 'assistant' ? '她' : '用户'}] ${m.text}`),
    })
  }

  done += 1
  if (done % 20 === 0) console.log(`  影子评估：${String(done)}/${String(userSources.length)}`)
}

// ---------------------------------------------------------------------------
// ⑤ 汇总 + 证据落盘
// ---------------------------------------------------------------------------

const tally: Record<ShadowClass, number> = {
  AGREE: 0, LEGACY_MISS: 0, LEGACY_FALSE_POSITIVE: 0, SEMANTIC_MISS: 0,
  FAMILY_DISAGREEMENT: 0, SEMANTIC_ABSTAIN: 0, SEMANTIC_FAILURE: 0,
}
for (const r of records) tally[r.shadowClass] += 1

const latencies = records.map((r) => r.latencyMs).filter((v): v is number => typeof v === 'number' && v >= 0).sort((a, b) => a - b)
const pct = (p: number): number | null =>
  latencies.length === 0 ? null : latencies[Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1)]

const realDbAfter = digestTree(PRODUCTION_DB_DIR)
// digestTree 返回结构体（{treeSha256, measuredCount, totalBytes, ...}）——比较内容，不比较对象引用
const realDbUntouched = realDbBefore.treeSha256 === realDbAfter.treeSha256
  && realDbBefore.measuredCount === realDbAfter.measuredCount
  && realDbBefore.totalBytes === realDbAfter.totalBytes

const runId = `shadow-${new Date().toISOString().replaceAll(/[-:TZ.]/g, '').slice(0, 17)}`
const localDir = join(process.cwd(), 'artifacts', 'm8.5', 'local', runId)
mkdirSync(localDir, { recursive: true })
const ignoreCheck = spawnSync('git', ['check-ignore', localDir], { cwd: process.cwd(), encoding: 'utf8' })
if (ignoreCheck.status !== 0) {
  console.error(`local_not_ignored：${localDir} 未被 git 忽略 ⇒ 拒绝写正文进盘`)
  process.exit(2)
}

// 分歧抽样人审材料（含正文；仅 local/）
{
  const lines: string[] = ['# M8.5 影子对照分歧抽样（§18 分层人审材料）', '',
    '> 每条：上下文（如有）+ 用户发言 + 双方判定（不标哪条是词形/语义——盲审纪律）。',
    '> 人审问题：哪个判定更符合"用户此刻对她的互动"？', '']
  sampleItems.forEach((item, index) => {
    lines.push(`## ${String(index + 1)}. ${item.record.sourceRef}（${item.record.shadowClass}）`)
    if (item.contextLines.length > 0) lines.push(...item.contextLines)
    lines.push(`用户发言：${item.content}`)
    lines.push(`判定甲：${item.record.keywordHit ? `IMPACT/${String(item.record.keywordFamily)}` : '无影响'}`)
    lines.push(`判定乙：${item.record.semanticStatus === 'ok' ? (item.record.semanticDecision === 'IMPACT' ? `IMPACT/${String(item.record.semanticFamily)}` : String(item.record.semanticDecision)) : `FAILED(${String(item.record.failureCode)})`}`)
    lines.push(`更符合互动事实的判定：____　备注：____`)
    lines.push('')
  })
  writeFileSync(join(localDir, 'shadow-sample.md'), lines.join('\n'), 'utf8')
}

const outDir = join(process.cwd(), 'artifacts', 'm8.5', runId)
mkdirSync(outDir, { recursive: true })
const evidence = {
  gate: 'm8.5:shadow:run',
  section: '计划 §18 / Corpus-Spec §5（shadow 无硬阈值）',
  verdict: records.length > 0 && realDbUntouched ? 'READINGS' : 'INVALID',
  measured_count: records.length,
  bounds: { eventsRead: allEvents.length, maxEventsRead: MAX_EVENTS_READ, sources: userSources.length, maxSources: MAX_SOURCES },
  taxonomy: tally,
  taxonomyMapping: {
    AGREE: '双 IMPACT 同族，或双方均无影响',
    LEGACY_MISS: '词形未命中、语义 IMPACT',
    LEGACY_FALSE_POSITIVE: '词形命中、语义判 NEUTRAL（**候选**归属：语义纠正词形误报；最终由人审抽样确认）',
    SEMANTIC_MISS: '语义漏判、词形命中——**机器无金标不能判"漏"**：本读数恒为 0，只能由人审抽样把 LEGACY_FALSE_POSITIVE 候选改判过来',
    FAMILY_DISAGREEMENT: '双 IMPACT 但族不同',
    SEMANTIC_ABSTAIN: '词形命中、语义 UNCERTAIN/OUT_OF_SCOPE',
    SEMANTIC_FAILURE: '语义侧 FAILED（传输/解析）',
  },
  latency: { p50: pct(50), p95: pct(95), p99: pct(99), samples: latencies.length },
  realDbUntouched: { before: realDbBefore, after: realDbAfter, identical: realDbUntouched },
  isolation: '生产库只复制从不打开；双路径纯评估零写入（比 §18 单写入者更强的隔离）',
  records: records.map((r) => ({
    sourceRef: r.sourceRef, sequence: r.sequence, conversationId: r.conversationId,
    keyword: r.keywordHit ? (r.keywordFamily ?? 'HIT') : 'MISS',
    semantic: r.semanticStatus === 'ok'
      ? (r.semanticDecision === 'IMPACT' ? `IMPACT/${String(r.semanticFamily)}` : String(r.semanticDecision))
      : `FAILED/${String(r.failureCode)}`,
    latencyMs: r.latencyMs, class: r.shadowClass,
  })),
  sampleNote: `分歧抽样人审材料（含正文）在 ${join('artifacts', 'm8.5', 'local', runId)}（gitignore 不入库）`,
}
writeFileSync(join(outDir, 'shadow-taxonomy.json'), JSON.stringify(evidence, null, 2), 'utf8')

console.log('========================================================================')
console.log(`M8.5 影子对照：${String(records.length)} 个真历史 source（${realDbUntouched ? '读数齐备' : 'INVALID'}）`)
for (const key of Object.keys(tally) as ShadowClass[]) {
  console.log(`  ${key}: ${String(tally[key])}`)
}
console.log(`  延迟：p50=${String(pct(50) ?? '-')}ms p95=${String(pct(95) ?? '-')}ms p99=${String(pct(99) ?? '-')}ms`)
console.log(`  真实库摘要前后逐字相同：${realDbUntouched ? 'YES' : 'NO（异常！）'}`)
console.log(`  证据：${join('artifacts', 'm8.5', runId, 'shadow-taxonomy.json')}`)
console.log('========================================================================')
if (records.length === 0 || !realDbUntouched) process.exit(1)
