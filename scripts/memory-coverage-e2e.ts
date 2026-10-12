/**
 * M9.7 / WP4 —— **端到端写读**（Level 2：账本 / 事件）—— `pnpm memory-coverage:e2e`
 *
 * ============================================================================
 *  它回答什么（WP0 回答不了的那一半）
 * ============================================================================
 * `pnpm memory-coverage:verify`（WP0/WP1）量的是**可达性**：一句话能不能走到
 * "抽出一个已登记槽位"那一步。**它不回答"有没有真的落库"** ——
 * 抽取之后还有目标解析 / 冲突 / 去重 / 放行口 / 折叠，任何一步都可能把它挡下。
 *
 * 本门把**同一个语料**喂进**生产形状**的显式记忆链路，然后**数账本**：
 *
 * ```text
 *   用户原话 → recordUserEvidence（真实 conversation_event）
 *            → ExplicitMemoryIntentDetector（生产缺省 = 规则 + 规则型分类器）
 *            → ExplicitMemoryTurnPort → ExplicitMemoryService
 *                 （RuleBasedContentExtractor · TargetMemoryResolver · 生产同款冲突端口 ·
 *                  MemoryMutationValidator 放行口 · applyAcceptedEvents 提交）
 *            → 读 `countsOf()`：character_domain_events(MEMORY_%) 与 memory_records
 * ```
 *
 * ⚠️ **它判什么、不判什么**
 *
 * ```text
 *   判    "这句话在**生产缺省**的显式路径下**真的写进了一条记忆**吗"（Level 2 + 投影）
 *   不判  真实模型：`replyText` 由本门自己给（fixture）⇒ 不证明"模型学会了记住"
 *   不判  后台路径（NOT-WIRED）· 不判语义召回 · 不判回复措辞
 *   不判  假阳率的总体：本语料是**抽样**，不是真实对话分布
 * ```
 *
 * ============================================================================
 *  三段式自证（`AGENTS.md` §6.7）+ 计数自检（§6.8）
 * ============================================================================
 * ```text
 *   正控   逐条比对"语料声明的期望"与"实测写读"（期望：extracted ⇒ 恰好 +1 条 active；其余 ⇒ +0）
 *   负控① **把"尝试"与"写入"分开**：数"尝试"（端口返回了结果）会得到一个**更大**的数
 *          ⇒ 若两者相等，说明本门分不清"她试过"与"她记住了" ⇒ FAIL
 *   负控② **幂等**：同一条说法喂**两次** ⇒ active 不得变成 2（否则数的是尝试，不是写入）
 *   恢复   换一个**全新隔离库**重喂同一条 ⇒ 读数与正控里那一条**逐字段相同**
 * ```
 *
 * ⚠️ **每个语料条目一个全新隔离库**（`isolateDatabase` + `resetPluginSqlConnection`）：
 *    同一个库里连续喂多条会让同槽位的第二条撞冲突/去重路径，期望就不再是"恰好 +1"。
 *    ⇒ 逐条隔离换来的是**期望干净**（代价是 46 次建库，实测可接受）。
 *
 * ⚠️ 本门**不打开真实库**：所有库都是 `%TEMP%` 下的一次性沙箱（`isolateDatabase`）。
 *    退出码：0 = PASS · 3 = FAIL / MEASUREMENT INVALID。
 */

import 'dotenv/config'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { applyAcceptedEvents } from '../src/infrastructure/persistence/event-store.ts'
import { createExplicitMemoryService } from '../src/kernel/app/memory/explicit-service.ts'
import { createExplicitMemoryTurnPort } from '../src/kernel/app/memory/explicit-turn.ts'
import { createExplicitMemoryIntentDetector } from '../src/kernel/app/memory/intent-detector.ts'
import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import {
  createTargetMemoryResolver,
  LexicalSemanticJudge,
} from '../src/kernel/app/memory/target-resolver.ts'
import type { EntityRef } from '../src/kernel/contracts/index.ts'
import { countsOf, createM4Harness } from './m4-harness.ts'
import {
  DB_TOUCHED,
  MC_CONTRACT_VERSION,
  MC_CORPUS_VERSION,
  MC_INSTRUMENT_VERSION,
  REPO_ROOT,
  dirtyPaths,
  gitOrNull,
  makeRunId,
  selfCheckMeasurement,
  sha256,
  sourceTreeReading,
  writeManifestAtomic,
  writePayload,
} from './memory-coverage-evidence.ts'

const STARTED_AT = new Date().toISOString()
const RUN_ID = makeRunId('memory-coverage-e2e')
const E2E_INSTRUMENT_VERSION = 'memory-coverage-e2e@1'
const CORPUS_REL = 'evals/memory-coverage/corpus/memory-coverage-corpus.jsonl'
const CORPUS_MANIFEST_REL = 'evals/memory-coverage/corpus/manifest.json'
const ARTIFACT_ROOT = join(REPO_ROOT, 'artifacts', 'memory-coverage', 'e2e')

// ---------------------------------------------------------------------------
// 语料
// ---------------------------------------------------------------------------

type ExpectedGate =
  | 'extracted'
  | 'intent_not_detected'
  | 'content_unresolved'
  | 'content_empty'
  | 'not_remember_intent'

interface CorpusItem {
  readonly id: string
  readonly text: string
  readonly expect: { readonly gate: ExpectedGate; readonly predicate?: string; readonly value?: string }
  readonly class: string
  readonly provenance: string
  readonly note: string
}

function loadCorpus(): { items: CorpusItem[]; sha: string; rawSha: string } {
  const bytes = readFileSync(join(REPO_ROOT, CORPUS_REL))
  const text = bytes.toString('utf8').replace(/\r\n/g, '\n')
  const items = text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CorpusItem)
  return { items, sha: sha256(text), rawSha: sha256(bytes) }
}

/**
 * 本门**只**喂 `remember` 流的说法。
 *
 * ⚠️ `not_remember_intent` 走的是**另一条服务路径**（`service.correct()` 等），本门**没有**为它
 * 装配那条路径（那需要 `recentExplicitWrites` 一类端口）⇒ **如实排除**，不计入分母。
 * 与 WP0 的量具同一条纪律（AGENTS §6.2：不许量一个不是本门要判的东西）。
 */
function isRememberFlow(item: CorpusItem): boolean {
  return item.expect.gate !== 'not_remember_intent'
}

// ---------------------------------------------------------------------------
// 一次喂入（生产形状装配 + 全新隔离库）
// ---------------------------------------------------------------------------

interface FeedReading {
  readonly intentDetected: boolean
  /** 端口给出的结论：`written` / `not_written` / `no_intent` */
  readonly kind: string
  readonly reason: string | null
  /** 账本读数：`character_domain_events` 里 `MEMORY_%` 的条数（before / after） */
  readonly domainEventsBefore: number
  readonly domainEventsAfter: number
  /** 投影读数：`memory_records` 的 active 条数 */
  readonly activeBefore: number
  readonly activeAfter: number
  /** 这一步**净增**了几条（读数就是这两个差） */
  readonly activeDelta: number
  readonly domainEventsDelta: number
  /** 这一步**尝试**了吗（端口返回了结果）—— 负控① 靠它把"尝试"与"写入"分开 */
  readonly attempted: boolean
}

async function feedOnce(label: string, text: string): Promise<FeedReading> {
  await resetPluginSqlConnection()
  isolateDatabase(`m97-wp4-${label}`, { keep: false })
  const h = await createM4Harness({ label: `m97-wp4-${label}` })
  try {
    const resolver = createTargetMemoryResolver({
      get: (id) => h.store.get(id),
      getActiveByCanonicalKey: (key) => h.store.getActiveByCanonicalKey(key),
      listBySubject: (o: EntityRef, s: EntityRef) => h.store.listBySubject(o, s),
      semanticJudge: new LexicalSemanticJudge(),
    })
    const service = createExplicitMemoryService({
      store: h.store,
      validator: h.validator,
      extractor: createRuleOnlyContentExtractor(),
      resolveTarget: (input) =>
        resolver.resolve({
          owner: input.owner,
          text: input.text,
          ...(input.canonicalKey !== undefined ? { canonicalKey: input.canonicalKey } : {}),
          ...(input.subject !== undefined ? { subject: input.subject } : {}),
          ...(input.hints !== undefined ? { hints: input.hints } : {}),
        }),
      commitEvents: async (accepted, now) =>
        (await applyAcceptedEvents(h.db, h.characterId as never, accepted, [], now)).domainEvents,
      /* ⚠️ **生产同款**冲突端口（与 `src/main.ts` 的 `buildMemoryWriter` / `verify-m6.1-e2e.ts` 逐字相同） */
      conflict: {
        recordsInCanonicalSlot: async ({ canonicalKey }) => {
          const active = await h.store.getActiveByCanonicalKey(canonicalKey)
          const disputed = (await h.store.list({ owner: h.owner, status: 'disputed', limit: 500 })).filter(
            (record) => record.canonicalKey === canonicalKey
          )
          return [...active, ...disputed]
        },
      },
    })
    const port = createExplicitMemoryTurnPort({ service })
    const detector = createExplicitMemoryIntentDetector()

    const before = await countsOf(h.db, h.owner)
    const recorded = await h.recordUserEvidence(text)
    const intent = await detector.detect(text)
    const result = await port.handleTurn({
      owner: h.owner,
      speaker: h.user,
      event: { id: recorded.ref.id as never, actorType: 'user', content: text },
    })
    const after = await countsOf(h.db, h.owner)

    const kind = result === undefined ? 'no_intent' : String(result.kind)
    const reason =
      result === undefined
        ? null
        : (() => {
            const raw = (result as { reason?: unknown }).reason
            const text2 = raw === undefined || raw === null ? '' : String(raw)
            return text2 === '' ? null : text2
          })()

    return {
      intentDetected: intent !== undefined,
      kind,
      reason,
      domainEventsBefore: before.domainEvents,
      domainEventsAfter: after.domainEvents,
      activeBefore: before.active,
      activeAfter: after.active,
      activeDelta: after.active - before.active,
      domainEventsDelta: after.domainEvents - before.domainEvents,
      attempted: result !== undefined,
    }
  } finally {
    await h.stop()
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

interface ItemReading {
  readonly id: string
  readonly class: string
  readonly text: string
  readonly expectedGate: ExpectedGate
  readonly expectedWrite: boolean
  readonly actualKind: string
  readonly actualReason: string | null
  readonly attempted: boolean
  readonly wroteMemory: boolean
  readonly domainEventsDelta: number
  readonly activeDelta: number
  readonly agree: boolean
  readonly mismatch: string | null
}

function section(title: string): void {
  process.stdout.write(`\n=== ${title} ===\n`)
}

async function judge(items: readonly CorpusItem[]): Promise<ItemReading[]> {
  const readings: ItemReading[] = []
  for (const item of items) {
    const feed = await feedOnce(item.id, item.text)
    const expectedWrite = item.expect.gate === 'extracted'
    const wroteMemory = feed.activeDelta === 1
    const problems: string[] = []
    if (expectedWrite && !wroteMemory) {
      problems.push(
        `期望写入恰好 1 条 active，实测 activeDelta=${String(feed.activeDelta)}` +
          `（端口 kind=${feed.kind}${feed.reason === null ? '' : ` · reason=${feed.reason}`}）`
      )
    }
    if (!expectedWrite && feed.activeDelta !== 0) {
      problems.push(`期望**不**写入，实测 activeDelta=${String(feed.activeDelta)}`)
    }
    if (expectedWrite && feed.domainEventsDelta <= 0) {
      problems.push(`期望账本里出现 MEMORY_% 事件，实测 domainEventsDelta=${String(feed.domainEventsDelta)}`)
    }
    if (!expectedWrite && feed.domainEventsDelta !== 0) {
      problems.push(`期望账本不动，实测 domainEventsDelta=${String(feed.domainEventsDelta)}`)
    }
    readings.push({
      id: item.id,
      class: item.class,
      text: item.text,
      expectedGate: item.expect.gate,
      expectedWrite,
      actualKind: feed.kind,
      actualReason: feed.reason,
      attempted: feed.attempted,
      wroteMemory,
      domainEventsDelta: feed.domainEventsDelta,
      activeDelta: feed.activeDelta,
      agree: problems.length === 0,
      mismatch: problems.length === 0 ? null : problems.join('；'),
    })
  }
  return readings
}

async function main(): Promise<void> {
  const failures: string[] = []
  const notes: string[] = []

  // ---- 0. 语料冻结 -------------------------------------------------------
  section('0. 语料冻结')
  const corpus = loadCorpus()
  const corpusManifest = JSON.parse(readFileSync(join(REPO_ROOT, CORPUS_MANIFEST_REL), 'utf8')) as {
    corpusSha256?: string
  }
  const frozenSha = corpusManifest.corpusSha256 ?? '(缺失)'
  const freezeOk = frozenSha === corpus.sha
  process.stdout.write(
    `  语料 ${String(corpus.items.length)} 条 · sha256 ${corpus.sha.slice(0, 16)}… ⇒ ${freezeOk ? '一致' : '**不一致**'}\n`
  )
  if (!freezeOk) {
    failures.push(
      `corpus_drift：语料 sha256=${corpus.sha}，而清单声明 ${String(frozenSha)} ⇒ 改语料必须有意重刷`
    )
  }

  const fed = corpus.items.filter(isRememberFlow)
  const skipped = corpus.items.filter((item) => !isRememberFlow(item))
  process.stdout.write(
    `  本门喂 ${String(fed.length)} 条（remember 流）· 如实跳过 ${String(skipped.length)} 条` +
      `（${skipped.map((item) => item.id).join(', ')} —— 非 remember 意图走另一条服务路径）\n`
  )
  if (skipped.length > 0) {
    notes.push(
      `${String(skipped.length)} 条被**如实排除**（非 remember 意图，本门没装配那条路径）：` +
        skipped.map((item) => item.id).join(', ')
    )
  }

  // ---- 1. 正控：逐条写读 ------------------------------------------------
  section('1. 正控（每条喂进生产形状链路 ⇒ 比对声明的期望）')
  const positive = await judge(fed)
  const mismatches = positive.filter((reading) => !reading.agree)
  const writes = positive.filter((reading) => reading.wroteMemory).length
  const attempts = positive.filter((reading) => reading.attempted).length
  process.stdout.write(
    `  真的写入 ${String(writes)} / ${String(positive.length)} · 端口"尝试过" ${String(attempts)}\n` +
      `  一致 ${String(positive.length - mismatches.length)} / 不一致 ${String(mismatches.length)}\n`
  )
  for (const reading of mismatches) {
    process.stdout.write(`  ✗ ${reading.id}（${reading.class}）：${String(reading.mismatch)}\n`)
  }
  if (mismatches.length > 0) {
    failures.push(`正控有 ${String(mismatches.length)} 条与语料声明的期望不符（见上）`)
  }

  // ---- 2. 负控①：把"尝试"与"写入"分开 ---------------------------------
  section('2. 负控①（数"尝试"会得到更大的数 ⇒ 证明本门分得清"试过"与"记住了"）')
  const discriminates = attempts > writes
  process.stdout.write(
    `  尝试 ${String(attempts)} vs 写入 ${String(writes)} ⇒ ` +
      `${discriminates ? '✅ 两个数不同' : '⛔ **相等**'}\n`
  )
  if (!discriminates) {
    failures.push(
      'negative_control_1_did_not_fire：数"尝试"与数"写入"得到**同一个数** ⇒ ' +
        '本门无法区分"她试过"与"她真的记住了"（那正是这道门存在的理由）'
    )
  }

  // ---- 3. 负控②：幂等（同一条喂两次 ⇒ active 不得变成 2）---------------
  section('3. 负控②（同一条说法喂两次 ⇒ active 不得变成 2）')
  const idempotenceItem = positive.find((reading) => reading.expectedWrite) ?? positive[0]
  let idempotenceOk = false
  let idempotenceDetail = '(无可用条目)'
  if (idempotenceItem !== undefined) {
    const label = `idem-${idempotenceItem.id}`
    await resetPluginSqlConnection()
    isolateDatabase(`m97-wp4-${label}`, { keep: false })
    const h = await createM4Harness({ label: `m97-wp4-${label}` })
    try {
      const resolver = createTargetMemoryResolver({
        get: (id) => h.store.get(id),
        getActiveByCanonicalKey: (key) => h.store.getActiveByCanonicalKey(key),
        listBySubject: (o: EntityRef, s: EntityRef) => h.store.listBySubject(o, s),
        semanticJudge: new LexicalSemanticJudge(),
      })
      const service = createExplicitMemoryService({
        store: h.store,
        validator: h.validator,
        extractor: createRuleOnlyContentExtractor(),
        resolveTarget: (input) =>
          resolver.resolve({
            owner: input.owner,
            text: input.text,
            ...(input.canonicalKey !== undefined ? { canonicalKey: input.canonicalKey } : {}),
            ...(input.subject !== undefined ? { subject: input.subject } : {}),
            ...(input.hints !== undefined ? { hints: input.hints } : {}),
          }),
        commitEvents: async (accepted, now) =>
          (await applyAcceptedEvents(h.db, h.characterId as never, accepted, [], now)).domainEvents,
        conflict: {
          recordsInCanonicalSlot: async ({ canonicalKey }) => {
            const active = await h.store.getActiveByCanonicalKey(canonicalKey)
            const disputed = (
              await h.store.list({ owner: h.owner, status: 'disputed', limit: 500 })
            ).filter((record) => record.canonicalKey === canonicalKey)
            return [...active, ...disputed]
          },
        },
      })
      const port = createExplicitMemoryTurnPort({ service })
      const feedTwice = async (): Promise<{ kind: string; active: number }> => {
        const recorded = await h.recordUserEvidence(idempotenceItem.text)
        const result = await port.handleTurn({
          owner: h.owner,
          speaker: h.user,
          event: { id: recorded.ref.id as never, actorType: 'user', content: idempotenceItem.text },
        })
        const counts = await countsOf(h.db, h.owner)
        return {
          kind: result === undefined ? 'no_intent' : String(result.kind),
          active: counts.active,
        }
      }
      const first = await feedTwice()
      const second = await feedTwice()
      idempotenceOk = first.active === 1 && second.active === 1
      idempotenceDetail =
        `第一次 kind=${first.kind} active=${String(first.active)} · ` +
        `第二次 kind=${second.kind} active=${String(second.active)}`
      process.stdout.write(`  ${idempotenceOk ? '✅' : '⛔'} ${idempotenceDetail}\n`)
      if (!idempotenceOk) {
        failures.push(
          `negative_control_2_did_not_fire：同一条喂两次之后 active=${String(second.active)}` +
            `（第一次 ${String(first.active)}）⇒ 这个计数器数的是**尝试**，不是**写入**`
        )
      }
    } finally {
      await h.stop()
    }
  }

  // ---- 4. 恢复：换一个全新隔离库重喂同一条 ⇒ 与正控逐字段相同 ----------
  section('4. 恢复（全新隔离库重喂同一条 ⇒ 与正控那一条逐字段相同）')
  let restoreOk = false
  let restoreDetail = '(无可用条目)'
  if (idempotenceItem !== undefined) {
    const again = await feedOnce(`restore-${idempotenceItem.id}`, idempotenceItem.text)
    const original = positive.find((reading) => reading.id === idempotenceItem.id)
    /* 逐字段比较（不用对象恒等：只比本门声明为读数的那几项） */
    const same =
      original !== undefined &&
      again.kind === original.actualKind &&
      again.activeDelta === original.activeDelta &&
      again.domainEventsDelta === original.domainEventsDelta &&
      again.attempted === original.attempted
    restoreOk = same
    restoreDetail =
      `重喂 kind=${again.kind} activeDelta=${String(again.activeDelta)} ` +
      `domainEventsDelta=${String(again.domainEventsDelta)} ⇒ ${same ? '与正控逐字段相同' : '**与正控不同**'}`
    process.stdout.write(`  ${restoreOk ? '✅' : '⛔'} ${restoreDetail}\n`)
    if (!restoreOk) {
      failures.push('restore_mismatch：恢复档与正控档读数不同 ⇒ 本门不确定（同输入两次读数必须相同）')
    }
  }

  // ---- 5. 计数自检 -------------------------------------------------------
  section('5. 计数自检（measuredCount > 0）')
  const selfCheck = selfCheckMeasurement({
    measuredCount: positive.length,
    notRunCount: 0,
    failedCount: mismatches.length,
  })
  process.stdout.write(`  ${selfCheck.verdict} —— ${selfCheck.reason}\n`)
  if (selfCheck.verdict !== 'PASS') {
    failures.push(`self_check_${selfCheck.verdict}：${selfCheck.reason}`)
  }

  // ---- 落盘 -------------------------------------------------------------
  const runDir = join(ARTIFACT_ROOT, RUN_ID)
  const byClass = new Map<string, number>()
  for (const reading of positive) byClass.set(reading.class, (byClass.get(reading.class) ?? 0) + 1)
  const payload = {
    schemaVersion: 'memory-coverage-e2e@1',
    runId: RUN_ID,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies:
        '生产**缺省**的显式记忆链路端到端：真实 `conversation_event` → 规则意图检测 → ' +
        '`ExplicitMemoryService`（规则抽取 · 目标解析 · 生产同款冲突端口 · 放行口 · 提交）' +
        '⇒ 读 `character_domain_events(MEMORY_%)` 与 `memory_records.active`。',
      notVerifies:
        '不判真实模型（`replyText` 是 fixture）· 不判后台路径（NOT-WIRED）· 不判语义召回 · ' +
        '不判假阳率的总体（语料是抽样）· 不判取值正确性（ADR-056 / `m6.1:extractor:repro`）。',
      corpusVersion: MC_CORPUS_VERSION,
      contractVersion: MC_CONTRACT_VERSION,
      instrumentVersion: `${MC_INSTRUMENT_VERSION}+${E2E_INSTRUMENT_VERSION}`,
      isolation: '每一条一个全新 `isolateDatabase` 沙箱（%TEMP%）+ `resetPluginSqlConnection()`',
    },
    corpus: { file: CORPUS_REL, sha256: corpus.sha, rawSha256: corpus.rawSha, frozenSha256FromManifest: frozenSha, freezeOk },
    counts: {
      fed: positive.length,
      skippedNotRemember: skipped.length,
      wroteMemory: writes,
      attempted: attempts,
      agree: positive.length - mismatches.length,
      mismatched: mismatches.length,
      byClass: Object.fromEntries([...byClass.entries()].sort()),
    },
    selfProof: {
      positiveControl: { readings: positive.length, mismatched: mismatches.length },
      negativeControl1_attemptsVsWrites: { attempts, writes, discriminates },
      negativeControl2_idempotence: { item: idempotenceItem?.id ?? null, ok: idempotenceOk, detail: idempotenceDetail },
      restore: { item: idempotenceItem?.id ?? null, ok: restoreOk, detail: restoreDetail },
    },
    selfCheck,
    readings: positive,
    failures,
    notes,
    dbProtection: {
      dbTouched: DB_TOUCHED,
      method:
        '**每个条目一个 `%TEMP%` 下的一次性沙箱**（`isolateDatabase` ⇒ `PGLITE_DATA_DIR`/`PROJECT_LG_SANDBOX` ' +
        '都指向它，且 `isProductionDir()` 硬拦重叠）；**真实库从未被打开**。',
    },
  }
  const payloadHash = writePayload(runDir, 'write-read.json', payload)

  const tree = sourceTreeReading(REPO_ROOT)
  const verdict =
    failures.length === 0
      ? 'PASS'
      : selfCheck.verdict === 'MEASUREMENT INVALID'
        ? 'MEASUREMENT INVALID'
        : 'FAIL'
  const manifestPath = writeManifestAtomic(runDir, {
    schemaVersion: 'memory-coverage-e2e-manifest@1',
    runId: RUN_ID,
    stage: 'wp4',
    lane: 'offline',
    gateVersion: 'memory-coverage-e2e@1',
    startedAt: STARTED_AT,
    completedAt: new Date().toISOString(),
    head: gitOrNull(['rev-parse', 'HEAD']),
    headShort: (gitOrNull(['rev-parse', 'HEAD']) ?? '').slice(0, 12),
    branch: gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyPaths: dirtyPaths(),
    sourceTreeHash: tree.treeSha256,
    sourceTreeHashDefinition: tree.definition,
    dbKind: 'isolated-sandbox',
    isolationProof: {
      dbTouched: true,
      method: payload.dbProtection.method,
      realDbOpened: false,
    },
    corpusVersion: MC_CORPUS_VERSION,
    contractVersion: MC_CONTRACT_VERSION,
    instrumentVersion: `${MC_INSTRUMENT_VERSION}+${E2E_INSTRUMENT_VERSION}`,
    corpusSha256: corpus.sha,
    command: [{ cmd: 'pnpm memory-coverage:e2e', exitCode: failures.length === 0 ? 0 : 3 }],
    exitCode: failures.length === 0 ? 0 : 3,
    completion: 'complete',
    usable: verdict === 'PASS',
    verdict,
    measuredCount: positive.length,
    notRunCount: 0,
    counts: payload.counts,
    selfProof: payload.selfProof,
    toolVersions: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      git: gitOrNull(['--version']),
    },
    artifactHashes: { 'write-read.json': payloadHash },
    supersedes: null,
  })

  process.stdout.write(
    [
      '',
      '──────────────────────────────────────────────────────────────',
      `M9.7 / WP4 端到端写读（Level 2）：${verdict}`,
      `  喂 ${String(positive.length)} 条 · 真的写入 ${String(writes)} 条 · 一致 ${String(positive.length - mismatches.length)} · 不一致 ${String(mismatches.length)}`,
      ...failures.map((line) => `  ✗ ${line}`),
      ...notes.map((line) => `  · ${line}`),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  清单：${manifestPath}`,
      '',
    ].join('\n')
  )

  if (failures.length > 0) process.exitCode = 3
}

await main()
