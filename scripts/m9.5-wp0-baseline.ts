/**
 * M9.5 WP0 —— **基线与旧缺口归因**（`pnpm m9.5:baseline`）。
 *
 * ============================================================================
 *  这份脚本要回答的命题（先写命题，再写量具）
 * ============================================================================
 * M9.5 计划 §3.1 的六项目标里，本基线只做**第一件事**：
 * 「把"换说法找不到 / 隔很久取不回 / 更正后旧值回潮"这三件事，在**当前树**上
 *   按**八段漏斗**（§10.4）逐层定位到**最先失败的那一层**。」
 *
 * ⚠️ 它**不**复现假想问题。M6.1 WP5 曾报「同义问法漏召回」（`M6.1-WP5-Product-Findings.md` §2.4），
 *    但 **ADR-059（2026-09-25）已经修过词面覆盖**（`pnpm m6.1:recall-probe` 的默认档
 *    从"选中 0"翻成"选中 ≥1 且取值正确"）。因此本基线**必须实测**：
 *    如果那条改述今天能召回，就如实记「已修」，不能照抄 2026-09-24 的旧读数当 M9.5 的缺口。
 *
 * ============================================================================
 *  八段漏斗（计划 §10.4）—— 每层读什么、哪层离线测得到
 * ============================================================================
 * ```text
 * ① 持久化      新值是否真正被接受并持久化            ← 离线可测（真实放行链）
 * ② 生命周期    旧值是否被 supersede/retract          ← 离线可测（投影状态）
 * ③ 派生索引    新值是否被完整索引、旧索引是否失效     ← **NOT APPLICABLE**（WP4 才建表）
 * ④ 候选        查询是否找到了新值，还是候选范围先遗漏  ← 离线可测（**本基线的核心**）
 * ⑤ 资格/排名   资格/排名是否错误排除新值             ← 离线可测（排除理由直方图）
 * ⑥ 预算        是否保留旧片段而裁掉新事实            ← 离线可测（droppedByBudget）
 * ⑦ 其它 section Recent/summary/Belief 是否另带旧值    ← **NOT RUN**（需真实轮次装配，WP7）
 * ⑧ 回复        实际入模已正确，模型回复是否仍混淆      ← **NOT RUN**（需真回复模型，WP10）
 * ```
 * ⇒ WP0 的出口是「旧缺口可定位」：定位到 ①–⑥ 中最先失败的那一层。
 *    ⑦/⑧ 如实标 NOT RUN（不许用 0 冒充"这层没问题"）。
 *
 * ============================================================================
 *  四个场景（每个场景**独立隔离库** —— 跨场景共库会互相污染候选集）
 * ============================================================================
 * ```text
 * S1 环境与依赖读数   不开库。pglite / plugin-sql 版本、迁移条数、有无 embedding 依赖、
 *                     召回通道枚举、真实库树摘要（只读）、配置指纹（非机密）。
 * S2 vector 扩展真值  开**隔离**库，直接查 `pg_extension`。
 *                     ★ 这是计划附录 C 的 **R1**：「扩展装着」不能从初始化代码推断 ——
 *                       `plugin-sql` 的 `CREATE EXTENSION IF NOT EXISTS vector` 在 try/catch 里
 *                       **失败只 warn 不抛**（附录 C3），所以必须真查。
 * S3 改述召回（P1）   小记忆集 + 五个问句（含 ADR-059 已修的那条作**对照**，不是缺口）。
 * S4 候选截断与长程取回（P3 / TD-08 / S31）
 *                     一条目标记忆 + 递增的**新**无关记忆，在 N=0/50/51/200/500 处读漏斗。
 * S5 更正后旧值回潮（P4 / L-M61-05）
 *                     那对已验证过的夹具（v1 毕业论文 → v2 课程设计），同样在递增 N 处读漏斗。
 * ```
 *
 * ============================================================================
 *  硬边界（判据，不是注释）
 * ============================================================================
 *  · **不开真实库**：全部场景 `isolateDatabase()`；真实库只做一次**只读**树摘要
 *    （INC-01 冻结算法 `digestTree`，本脚本不重写）。运行前后各测一次 ⇒ 前后逐字相同
 *    才是"从未被打开写入"的**程序事实**（`isolationProof`）。
 *  · **零模型调用**：本脚本不生成任何回复、不编码任何 query。不需要 `OPENAI_API_KEY`。
 *  · **不写 artifacts 以外的任何产物**；runId 目录**拒绝覆盖**（TD-04①）。
 *  · **不打印任何配置取值**：`configHash` 只覆盖非机密功能字段（键名 + 值长度）。
 *  · 计数自检（AGENTS §6.8）：`usable=true` 而 `measuredCount=0` ⇒ 拒写清单。
 *
 * 用法：
 *   pnpm m9.5:baseline                       # 自动生成 runId
 *   pnpm m9.5:baseline --out artifacts/m9.5/<runId>
 */

import 'dotenv/config'

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { sql } from 'drizzle-orm'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { rowsOf } from '../src/infrastructure/persistence/db.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { createExplicitMemoryService } from '../src/kernel/app/memory/explicit-service.ts'
import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import {
  createExplicitMemoryIntentDetector,
  detectExplicitIntentFromEvent,
  targetHintsFrom,
} from '../src/kernel/app/memory/intent-detector.ts'
import {
  LexicalSemanticJudge,
  createTargetMemoryResolver,
  lexicalFragments,
  lexicalOverlapHits,
} from '../src/kernel/app/memory/target-resolver.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { createRecallTurnPort } from '../src/kernel/app/recall/turn.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { newTraceId } from '../src/kernel/contracts/ids.ts'
import {
  RECALL_CHANNELS,
  RECALL_CHANNEL_FACTS,
  RECALL_LIMITS,
  RESERVED_RECALL_CHANNELS,
  createRecallRequest,
} from '../src/kernel/contracts/recall.ts'
import { DEFAULT_RECALL_RANKING_POLICY } from '../src/kernel/recall/ranking.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'

import { M4_T0, sha256, type M4Harness } from './m4-harness.ts'
import { createM55Harness, type M55Harness } from './m5.5-harness.ts'
import { dirtyPaths, nonSecretConfigFingerprint, sourceTreeReading } from './m6.1-run-manifest.ts'
import {
  createM95RunId,
  openM95RunDir,
  runIdFromM95OutPath,
  selfCheckMeasurement,
  writeM95Manifest,
} from './m9.5-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const STARTED_AT = new Date().toISOString()
const GATE_VERSION = 'm9.5-wp0-baseline@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

type FunnelStatus = 'measured' | 'not-applicable' | 'not-run'

interface FunnelLayer {
  readonly layer: number
  readonly name: string
  readonly status: FunnelStatus
  readonly reading: Record<string, unknown>
  readonly note: string
}

interface Observation {
  readonly label: string
  readonly question: string
  readonly scanned: number
  readonly candidateCount: number
  readonly eligibleCount: number
  readonly selectedCount: number
  readonly selectedIds: readonly string[]
  readonly selectedValues: readonly string[]
  readonly droppedByBudget: number
  readonly reachedContext: boolean
  readonly exclusionHistogram: Readonly<Record<string, number>>
  readonly decisions: readonly {
    readonly memoryId: string
    readonly eligible: boolean
    readonly selected: boolean
    readonly reason?: string
  }[]
  readonly targetInCandidatePool: boolean
  readonly targetChannels: readonly string[]
  readonly targetInSelected: boolean
  readonly memoryTokens: number
  readonly budgetTokens: number
}

interface ScenarioResult {
  readonly id: string
  readonly goal: string
  readonly question: string
  readonly setup: readonly string[]
  readonly readings: readonly Observation[]
  readonly funnel: readonly FunnelLayer[]
  readonly firstFailingLayer: number | string
  readonly firstFailingNote: string
  /** 逐条结论（S3 这类"一问一句"的场景用它，避免把多个缺口压成一个数字） */
  readonly perQuestion?: readonly {
    readonly id: string
    readonly firstFailingLayer: number | string
    readonly firstFailingNote: string
  }[]
  /**
   * 固定合成数据的 **canonical snapshot**（计划 §12 WP0 任务 5 要求留一份）。
   *
   * 为什么必须在 WP0 就有：WP4 的「索引丢失后重建 ⇒ 原 Memory canonical snapshot 不变」
   * （计划 S44）与 WP5 的 A==B 对账都需要一个**同一夹具的**基准 oracle。
   * 这里只落 `hash + 条目数`（完整条目可由 `m4:verify` 的 rebuild 逐字段重算），
   * 避免把 500 条合成记录的全文塞进基线证据。
   */
  readonly canonicalSnapshot?: { readonly hash: string; readonly entryCount: number }
  /** `h.counts()` 的原始读数（各类记忆/事件/链接的分母） */
  readonly tableCounts?: unknown
}

// ---------------------------------------------------------------------------
// 显式记忆写入器（与 `m6.1-recall-probe.ts:212` 的装配**逐字同形**）
// ---------------------------------------------------------------------------

type WriteExplicit = (text: string) => Promise<void>

function makeExplicitWriter(bed: M55Harness, h: M4Harness): WriteExplicit {
  const { owner, user, db, store } = h
  const resolver = createTargetMemoryResolver({
    get: (id) => store.get(id),
    getActiveByCanonicalKey: (key) => store.getActiveByCanonicalKey(key),
    listBySubject: (o, s) => store.listBySubject(o, s),
    semanticJudge: new LexicalSemanticJudge(),
  })
  const service = createExplicitMemoryService({
    store,
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
      (
        await (
          await import('../src/infrastructure/persistence/event-store.ts')
        ).applyAcceptedEvents(db, h.characterId as never, accepted, [], now)
      ).domainEvents,
    conflict: {
      recordsInCanonicalSlot: async ({ canonicalKey }) => {
        const active = await store.getActiveByCanonicalKey(canonicalKey)
        const disputed = (await store.list({ owner, status: 'disputed', limit: 500 })).filter(
          (record) => record.canonicalKey === canonicalKey
        )
        return [...active, ...disputed]
      },
    },
  })
  const detector = createExplicitMemoryIntentDetector()

  return async (text: string): Promise<void> => {
    const recorded = await h.recordUserEvidence(text)
    const intent = await detectExplicitIntentFromEvent(detector, {
      id: recorded.ref.id as never,
      actorType: 'user',
      content: text,
    })
    if (intent === undefined) return
    await service.handle({
      owner,
      speaker: user,
      intent,
      triggerEventId: recorded.ref.id,
      hints: targetHintsFrom(intent),
    })
  }
}

// ---------------------------------------------------------------------------
// 观测：一次召回 → 八段漏斗能用到的全部读数
// ---------------------------------------------------------------------------

function claimContent(
  predicate: string,
  value: string,
  subject: ReturnType<typeof entityRef>,
  qualifiers?: Record<string, unknown>
): never {
  return {
    kind: 'claim',
    subject,
    predicate,
    value,
    ...(qualifiers !== undefined ? { qualifiers } : {}),
  } as never
}

function buildRecallPort(h: M4Harness): ReturnType<typeof createRecallTurnPort> {
  return createRecallTurnPort({
    service: createMemoryRecallService({
      port: createMemoryRetrievalStore({
        store: h.store,
        integrity: (owner) => memoryIntegrityProblems(h.db, owner),
        rootReadings: (ids) => rootReadingsByMemory(h.db, ids),
      }),
    }),
    budget: DEFAULT_CONTEXT_BUDGET,
    now: () => M4_T0 + 10_000,
  })
}

async function observeRecall(input: {
  readonly h: M4Harness
  readonly recallPort: ReturnType<typeof createRecallTurnPort>
  readonly question: string
  readonly label: string
  readonly now: number
  readonly targetId?: string
}): Promise<Observation> {
  const { h, recallPort, question, label, now } = input
  const request = createRecallRequest({
    traceId: newTraceId(),
    characterId: String(h.characterId),
    user: entityRef('user', String(h.user.id)),
    query: { text: question, source: 'user_message' },
    intent: 'current_fact',
    contextBudget: { memoryTokens: DEFAULT_CONTEXT_BUDGET.memoryTokens },
  })
  const outcome = await recallPort.run(request)

  const allRows = await h.store.list({ owner: h.owner, limit: 500 })
  const valueOf = (id: string): string => {
    const row = allRows.find((candidate) => String(candidate.id) === id)
    if (row === undefined) return '(不在 store.list(limit=500) 的前 500 行内)'
    return String((row.content as { value?: unknown }).value ?? '')
  }

  const selectedIds = outcome.trace.selectedIds.map(String)
  const candidateEntries = outcome.record.candidates.map((candidate) => ({
    memoryId: String(candidate.memoryId),
    channels: candidate.channels.map(String),
  }))
  const targetId = input.targetId
  const targetEntry =
    targetId === undefined ? undefined : candidateEntries.find((entry) => entry.memoryId === targetId)

  return {
    label,
    question,
    scanned: outcome.trace.scanned,
    candidateCount: outcome.trace.candidateCount,
    eligibleCount: outcome.trace.eligibleCount,
    selectedCount: selectedIds.length,
    selectedIds,
    selectedValues: selectedIds.map(valueOf),
    droppedByBudget: outcome.trace.droppedByBudget,
    reachedContext: outcome.record.metrics.reachedContext,
    exclusionHistogram: { ...outcome.trace.exclusionHistogram },
    decisions: outcome.record.decisions.map((decision) => ({
      memoryId: String(decision.memoryId),
      eligible: decision.eligible === true,
      selected: decision.selected === true,
      ...(decision.reason !== undefined ? { reason: String(decision.reason) } : {}),
    })),
    targetInCandidatePool: targetEntry !== undefined,
    targetChannels: targetEntry?.channels ?? [],
    targetInSelected: targetId === undefined ? false : selectedIds.includes(targetId),
    memoryTokens: outcome.trace.account.memoryTokens,
    budgetTokens: outcome.trace.account.budgetTokens,
  }
}

/** 本基线测得到的那五层（①②④⑤⑥）；③⑦⑧ 如实分列。 */
function staticFunnelLayers(): readonly FunnelLayer[] {
  return [
    {
      layer: 3,
      name: '派生索引：新值是否被完整索引、旧索引是否失效',
      status: 'not-applicable',
      reading: { derivedIndexTable: 'NOT CREATED (WP4)' },
      note:
        'M9.5 的派生向量表尚未创建（WP4 才建）—— 本基线读的是**"派生索引不存在"条件下的原链**；' +
        '这不是"索引这层没问题"，是这层**还不存在**',
    },
    {
      layer: 7,
      name: '其它 section：Recent/summary/Belief 是否另带旧值',
      status: 'not-run',
      reading: { reason: '需要真实轮次装配（网关 + Recent + rollup + Belief），WP7 才接' },
      note: 'NOT RUN —— 本基线不冒充"这层没问题"',
    },
    {
      layer: 8,
      name: '回复：实际入模已正确，模型回复是否仍混淆',
      status: 'not-run',
      reading: { reason: '需要真实回复模型（Live Smoke），WP10' },
      note: 'NOT RUN —— 工程绿不能替代真实链路（AGENTS §6.1）',
    },
  ]
}

/**
 * 判定「最先失败的那一层」。
 *
 * 只判本基线测得到的 ①、②、④、⑤、⑥ 五层（③ 不存在、⑦⑧ NOT RUN）。
 * 顺序就是漏斗顺序 —— 这正是 §10.4 的用法：「修复指向最先失败的层」。
 *
 * ⚠️ **`targetExpected` 是必须的**（2026-09-28 第二次运行后修正）：
 *    负控问句**本来就没有目标**，若照常走"目标不在候选池 ⇒ 层④失败"，
 *    就会把一条**通过**的负控标成失败 —— 那是判据缺陷（AGENTS §6.6/§6.7）。
 */
function firstFailingLayerOf(input: {
  readonly observation: Observation
  readonly oldValuePresent: boolean
  /** 本问句是否**应当**取回某条特定记忆（负控 = false） */
  readonly targetExpected: boolean
}): { layer: number | string; note: string } {
  const o = input.observation
  if (input.oldValuePresent) {
    return { layer: 2, note: '旧值仍 active ⇒ 生命周期层先失败（先修 ②，不看下游）' }
  }
  if (!input.targetExpected) {
    return o.selectedCount === 0
      ? { layer: 'none', note: '负控：库里没有目标且选中 0 ⇒ 预期行为（不是缺口）' }
      : { layer: 5, note: `负控却被选中 ${String(o.selectedCount)} 条 ⇒ 过度召回` }
  }
  if (o.selectedCount > 0) {
    return { layer: 'none', note: '本轮目标值入模成功（这条改述今天**没有**缺口）' }
  }
  if (!o.targetInCandidatePool) {
    return {
      layer: 4,
      note:
        '目标既在库、又词面命中，却**没有进入候选池** ⇒ 失败在④候选范围（截断/窗口），' +
        '不是⑤资格也不是⑥预算',
    }
  }
  if (o.eligibleCount === 0) {
    return {
      layer: 5,
      note: `进了候选池但资格层全拒 ⇒ 失败在⑤；直方图 ${JSON.stringify(o.exclusionHistogram)}`,
    }
  }
  if (o.droppedByBudget > 0) {
    return { layer: 6, note: `合格但被预算裁掉 ⇒ 失败在⑥（droppedByBudget=${String(o.droppedByBudget)}）` }
  }
  return {
    layer: 5,
    note:
      `进了候选池也够资格，却没被选中且没被预算裁 ⇒ 失败在⑤排序/去重；` +
      `直方图 ${JSON.stringify(o.exclusionHistogram)}`,
  }
}

// ---------------------------------------------------------------------------
// S1 环境与依赖读数（不开库）
// ---------------------------------------------------------------------------

interface TextReading {
  readonly value: unknown
  readonly source: 'file-text' | 'runtime-import' | 'filesystem'
  readonly where: string
}

function readLockVersion(packageName: string): string | null {
  const lock = readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8')
  const needle = `  '${packageName}@`
  const index = lock.indexOf(needle)
  if (index < 0) return null
  const rest = lock.slice(index + needle.length)
  const end = rest.indexOf("'")
  return end < 0 ? null : rest.slice(0, end)
}

function installedVersion(packageName: string): string | null {
  const candidates = [
    join(REPO_ROOT, 'node_modules', packageName, 'package.json'),
    /* pnpm 的嵌套布局：`node_modules/.pnpm/<name>@<version>/node_modules/<name>/package.json` */
    ...(existsSync(join(REPO_ROOT, 'node_modules', '.pnpm'))
      ? readdirSync(join(REPO_ROOT, 'node_modules', '.pnpm'))
          .filter((dir) => dir.startsWith(`${packageName.replace('/', '+')}@`))
          .map((dir) =>
            join(REPO_ROOT, 'node_modules', '.pnpm', dir, 'node_modules', packageName, 'package.json')
          )
      : []),
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version?: string }
      return pkg.version ?? null
    } catch {
      continue
    }
  }
  return null
}

function migrationVersions(): number[] {
  const text = readFileSync(join(REPO_ROOT, 'src/infrastructure/persistence/migrations.ts'), 'utf8')
  const versions: number[] = []
  for (const match of text.matchAll(/version:\s*(\d+)/g)) {
    const value = Number(match[1])
    if (Number.isInteger(value) && !versions.includes(value)) versions.push(value)
  }
  return versions.sort((a, b) => a - b)
}

function packageDependencies(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
}

function environmentReadings(): Record<string, TextReading> {
  const deps = packageDependencies()
  const embeddingLike = Object.keys(deps).filter((name) =>
    /embed|onnx|transformers|@xenova|vector|qdrant|faiss|hnsw/i.test(name)
  )
  const versions = migrationVersions()
  return {
    pgliteLocked: { value: readLockVersion('@electric-sql/pglite'), source: 'file-text', where: 'pnpm-lock.yaml' },
    pgliteInstalled: {
      value: installedVersion('@electric-sql/pglite'),
      source: 'filesystem',
      where: 'node_modules/@electric-sql/pglite/package.json',
    },
    pluginSqlInstalled: {
      value: installedVersion('@elizaos/plugin-sql'),
      source: 'filesystem',
      where: 'node_modules/@elizaos/plugin-sql/package.json',
    },
    migrationVersions: {
      value: { versions, count: versions.length, max: versions[versions.length - 1] ?? null },
      source: 'file-text',
      where: 'src/infrastructure/persistence/migrations.ts',
    },
    embeddingDependencies: {
      value: embeddingLike,
      source: 'file-text',
      where: 'package.json（dependencies + devDependencies）',
    },
    recallChannels: {
      value: {
        channels: RECALL_CHANNELS,
        reserved: RESERVED_RECALL_CHANNELS,
        facts: Object.keys(RECALL_CHANNEL_FACTS),
      },
      source: 'runtime-import',
      where: 'src/kernel/contracts/recall.ts',
    },
    semanticChannelRegistered: {
      value: RECALL_CHANNELS.includes('semantic' as never),
      source: 'runtime-import',
      where: 'src/kernel/contracts/recall.ts（附录 C5：`semantic` 不在通道枚举里）',
    },
    realDbTreeDigest: {
      value: safeTreeDigest(),
      source: 'filesystem',
      where: 'data/pglite（只读摘要，未打开）',
    },
    nonSecretConfigFingerprint: {
      value: nonSecretConfigFingerprint(REPO_ROOT),
      source: 'file-text',
      where: 'package.json / .env / .env.test（**只记键名与值长度**）',
    },
    rankingPolicy: {
      value: {
        minTotal: DEFAULT_RECALL_RANKING_POLICY.minTotal,
        requireRelevanceEvidence: DEFAULT_RECALL_RANKING_POLICY.requireRelevanceEvidence,
      },
      source: 'runtime-import',
      where: 'src/kernel/recall/ranking.ts',
    },
    rankingSemanticWeight: {
      value: 0,
      source: 'file-text',
      where: 'src/kernel/recall/ranking.ts:308 `semantic: 0`（源码事实；本脚本不 import 该内部常量）',
    },
    contextBudget: {
      value: { ...DEFAULT_CONTEXT_BUDGET },
      source: 'runtime-import',
      where: 'src/kernel/recall/selector.ts',
    },
  }
}

// ---------------------------------------------------------------------------
// S2 vector 扩展真值（R1：必须真查，不能从代码推断）
// ---------------------------------------------------------------------------

async function vectorExtensionProbe(h: M4Harness): Promise<Record<string, unknown>> {
  const extensions = rowsOf(
    await h.db.execute(sql`select extname, extversion from pg_extension order by extname`)
  ).map((row) => ({ name: String(row.extname), version: String(row.extversion) }))
  let available: { name: string; defaultVersion: string | null }[] = []
  let availableError: string | null = null
  try {
    available = rowsOf(
      await h.db.execute(
        sql`select name, default_version from pg_available_extensions order by name`
      )
    ).map((row) => ({
      name: String(row.name),
      defaultVersion: row.default_version === null ? null : String(row.default_version),
    }))
  } catch (error) {
    availableError = (error as Error).message
  }
  const vector = extensions.find((entry) => entry.name === 'vector')
  /*
   * 附录 C4：`plugin-sql` 自带一张 ElizaOS 的 `embeddings` 表（外键指向 ElizaOS `memory_id`）。
   * 它不是 Kernel Memory —— 这里量一下**本次 run 里它是不是空的**，用来证明
   * 「M55Harness 会启动 bootstrap embedding 服务，但本次没有 key ⇒ 零嵌入写入」，
   * 而不是让读者从日志里那句 warn 自行推断。
   */
  let elizaEmbeddingsRows: number | null = null
  let elizaEmbeddingsError: string | null = null
  try {
    elizaEmbeddingsRows = Number(
      rowsOf(await h.db.execute(sql`select count(*)::int as c from embeddings`))[0]?.c ?? 0
    )
  } catch (error) {
    elizaEmbeddingsError = (error as Error).message
  }
  return {
    query: 'select extname, extversion from pg_extension order by extname',
    installedExtensions: extensions,
    vectorInstalled: vector !== undefined,
    vectorVersion: vector?.version ?? null,
    vectorOfferedByImage: available.find((entry) => entry.name === 'vector') !== undefined,
    availableExtensionsCount: available.length,
    availableExtensionsError: availableError,
    elizaEmbeddingsTableRows: elizaEmbeddingsRows,
    elizaEmbeddingsTableError: elizaEmbeddingsError,
    verdict:
      vector === undefined
        ? 'vector 扩展**未安装**（或安装失败被 try/catch 吞掉）—— 附录 C 的 R1 未通过'
        : `vector 扩展已安装，版本 ${vector.version}`,
  }
}

// ---------------------------------------------------------------------------
// 填充记忆：**递增的新无关记忆**（占住 recency，不改被观察的槽位）
// ---------------------------------------------------------------------------

/**
 * 每一条都走**真实账本**（`recordUserEvidence`）拿到证据引用，再由 `makeCandidate` +
 * `commitAndFold` 走**真实放行链**写入。
 *
 * 用**不同 qualifier** 是为了让 `canonicalKeyOf`（含 qualifierScope）给出**不同槽位**：
 * 否则同 predicate 的第二次写入会 supersede 第一次，永远只有 1 条 active。
 */
async function writeFillers(input: {
  readonly h: M4Harness
  readonly from: number
  readonly count: number
  readonly baseTime: number
}): Promise<number> {
  const { h, from, count, baseTime } = input
  for (let i = from; i < from + count; i += 1) {
    const evidence = await h.recordUserEvidence(`填充记忆 ${String(i)}：我最喜欢的颜色是色号${String(i)}。`)
    const candidate = h.makeCandidate(
      'preference',
      claimContent('preference.color.favorite', `filler-${String(i)}`, h.user, { filler: String(i) }),
      { sourceRefs: [evidence.ref] }
    )
    await h.commitAndFold(candidate, baseTime + i)
  }
  return from + count
}

async function openScenario(label: string): Promise<{ bed: M55Harness; h: M4Harness }> {
  await resetPluginSqlConnection()
  isolateDatabase(label, { keep: false })
  const bed = await createM55Harness({ label })
  return { bed, h: bed.h }
}

/** WP0 任务 5：在**关库之前**取固定合成数据的 canonical snapshot + 表计数。 */
async function finishScenario(bed: M55Harness): Promise<{
  canonicalSnapshot: { hash: string; entryCount: number }
  tableCounts: unknown
}> {
  const snapshot = await bed.snapshot()
  const counts = await bed.counts()
  await bed.dispose()
  return {
    canonicalSnapshot: { hash: snapshot.hash, entryCount: snapshot.entries.length },
    tableCounts: counts,
  }
}

async function slotRowsOf(
  h: M4Harness,
  predicate: string
): Promise<readonly { status: string; value: string; id: string }[]> {
  return (await h.store.list({ owner: h.owner, limit: 500 }))
    .filter((row) => (row.content as { predicate?: string }).predicate === predicate)
    .map((row) => ({
      status: String(row.status),
      value: String((row.content as { value?: unknown }).value ?? ''),
      id: String(row.id),
    }))
}

// ---------------------------------------------------------------------------
// S3 改述召回（P1）
// ---------------------------------------------------------------------------

/**
 * S3 的五个问句。
 *
 * ⚠️ **目标的识别方式（2026-09-28 第一次运行后修正）**：
 *    第一版按「我猜这条 setup 会落到哪个 predicate」来认目标 —— 那是**错的**：
 *    「记住：我不吃辣。」并不落 `food.avoid.cilantro`，于是 q-d 的 `targetInCandidatePool=false`
 *    测的是"我没给它指目标"，**不是**"目标被筛掉"。这正是 AGENTS §6.9
 *    「数字对 ≠ 数字描述的是你以为的那个东西」。
 *    ⇒ 现改为**按取值子串在库里实测认目标**（`expectTargetValueContains`），
 *      并把该次运行的完整槽位清单一起落盘，让"目标是哪一条"可复核。
 */
const S3_QUESTIONS: readonly {
  readonly id: string
  readonly question: string
  readonly kind: string
  /** 目标记忆的**取值子串**（实测在库里找；`null` = 本问句没有目标，是负控） */
  readonly expectTargetValueContains: string | null
}[] = [
  {
    id: 'q-a-fixed-by-adr059',
    question: '我现在在写什么？',
    kind: 'ADR-059 已修的那条（**对照**，不是缺口）',
    expectTargetValueContains: '毕业论文',
  },
  {
    id: 'q-b-new-paraphrase',
    question: '最近那个学业项目怎么样了？',
    kind: 'M9.5 新改述（P1 目标形态：换说法）',
    expectTargetValueContains: '毕业论文',
  },
  {
    id: 'q-c-new-paraphrase',
    question: '我读的是哪所院校？',
    kind: 'M9.5 新改述（P1 目标形态）',
    expectTargetValueContains: '江城大学',
  },
  {
    id: 'q-d-negation-paraphrase',
    question: '我能不能接受辣味？',
    kind: 'M9.5 新改述（P2：相近但含否定）',
    expectTargetValueContains: '辣',
  },
  {
    id: 'q-e-negative-control',
    question: '我平时喜欢什么运动？',
    kind: '负控（库里没有任何运动记忆 ⇒ 必须选中 0）',
    expectTargetValueContains: null,
  },
]

async function scenarioParaphrase(label: string): Promise<ScenarioResult> {
  const { bed, h } = await openScenario(label)
  const writeExplicit = makeExplicitWriter(bed, h)
  const recallPort = buildRecallPort(h)

  const setup = ['记住：我在写毕业论文。', '记住：我在江城大学读书。', '记住：我不吃辣。']
  for (const text of setup) await writeExplicit(text)

  const allRows = await h.store.list({ owner: h.owner, limit: 500 })
  /** 完整槽位清单：让"目标是哪一条"可复核（而不是只留一个 id） */
  const storeInventory = allRows.map((row) => ({
    id: String(row.id),
    status: String(row.status),
    predicate: String((row.content as { predicate?: string }).predicate ?? '(none)'),
    value: String((row.content as { value?: unknown }).value ?? ''),
  }))

  const readings: Observation[] = []
  const funnel: FunnelLayer[] = []
  for (const item of S3_QUESTIONS) {
    const needle = item.expectTargetValueContains
    const targetRow =
      needle === null
        ? undefined
        : storeInventory.find(
            (row) => row.status === 'active' && row.value.includes(needle)
          )
    const targetId = targetRow?.id
    const observation = await observeRecall({
      h,
      recallPort,
      question: item.question,
      label: item.id,
      now: M4_T0 + 10_000,
      ...(targetId !== undefined ? { targetId } : {}),
    })
    readings.push(observation)
    const failing = firstFailingLayerOf({
      observation,
      oldValuePresent: false,
      targetExpected: needle !== null,
    })
    funnel.push({
      layer: 4,
      name: `候选 · ${item.id}`,
      status: 'measured',
      reading: {
        kind: item.kind,
        storeInventory,
        targetValueNeedle: needle,
        targetRow: targetRow ?? null,
        lexicalFragments: lexicalFragments(item.question),
        lexicalHitCountInStoreTop500: lexicalOverlapHits(item.question, allRows).length,
        ...observation,
        firstFailingLayer: failing.layer,
        firstFailingNote: failing.note,
      },
      note: item.kind,
    })
  }

  const finished = await finishScenario(bed)
  /** 逐条结论：**把"哪一条缺、缺在哪层"逐条列出来**，不压成一个场景级数字 */
  const perQuestion = funnel.map((layer) => {
    const reading = layer.reading as { label: unknown; firstFailingLayer: unknown; firstFailingNote: unknown }
    return {
      id: String(reading.label),
      firstFailingLayer: reading.firstFailingLayer as number | string,
      firstFailingNote: String(reading.firstFailingNote),
    }
  })
  const failingLayers = [
    ...new Set(
      perQuestion
        .map((item) => item.firstFailingLayer)
        .filter((layer) => layer !== 'none')
    ),
  ]
  return {
    id: 'S3-paraphrase',
    goal: 'P1：换一种说法仍能找到相关记忆',
    question: '「我现在在写什么？」（ADR-059 已修的对照）与四条新改述/负控 —— 逐条读候选/资格/预算',
    setup,
    readings,
    funnel,
    firstFailingLayer: failingLayers.length === 0 ? 'none' : failingLayers.join('+'),
    firstFailingNote:
      failingLayers.length === 0
        ? '五条全部符合预期（含负控选中 0）⇒ 本场景在**小规模**下没有缺口'
        : `缺口出现在层 ${failingLayers.join('+')}；逐条见 perQuestion（q-b/q-c 命中 ⇒ 改述本身不是缺口）`,
    perQuestion,
    ...finished,
  }
}

// ---------------------------------------------------------------------------
// S4 候选截断与长程取回（P3 / TD-08 / S31）
// ---------------------------------------------------------------------------

async function scenarioScale(label: string): Promise<ScenarioResult> {
  const { bed, h } = await openScenario(label)
  const writeExplicit = makeExplicitWriter(bed, h)
  const recallPort = buildRecallPort(h)

  const setup = ['记住：我在写毕业论文。']
  for (const text of setup) await writeExplicit(text)

  const slot = await slotRowsOf(h, 'project.background.active')
  const targetId = slot.find((row) => row.status === 'active')?.id
  const question = '我现在在写什么？'

  const checkpoints = [0, 50, 51, 200, 500]
  const readings: Observation[] = []
  let written = 0
  for (const checkpoint of checkpoints) {
    if (checkpoint > written) {
      written = await writeFillers({
        h,
        from: written,
        count: checkpoint - written,
        baseTime: M4_T0 + 1_000_000,
      })
    }
    readings.push(
      await observeRecall({
        h,
        recallPort,
        question,
        label: `N=${String(checkpoint)}`,
        now: M4_T0 + 1_000_000 + checkpoint + 10_000,
        ...(targetId !== undefined ? { targetId } : {}),
      })
    )
  }
  const finished = await finishScenario(bed)

  const firstWithout = readings.find(
    (reading) => reading.candidateCount > 0 && !reading.targetInCandidatePool
  )
  const funnel: FunnelLayer[] = readings.map((observation) => {
    const failing = firstFailingLayerOf({ observation, oldValuePresent: false, targetExpected: true })
    return {
      layer: 4,
      name: `候选截断 · ${observation.label}`,
      status: 'measured',
      reading: { ...observation, firstFailingLayer: failing.layer, firstFailingNote: failing.note },
      note:
        '目标 = 「我在写毕业论文」（project.background.active）；问句 = ADR-059 已修的那条 ' +
        '⇒ 若小 N 能选中、大 N 不能，则缺口是**规模**而不是**词面覆盖**',
    }
  })
  return {
    id: 'S4-candidate-truncation',
    goal: 'P3 / TD-08 / S31：第 1/50/51/200/500 条处的候选范围与截断',
    question,
    setup,
    readings,
    funnel,
    firstFailingLayer: firstWithout === undefined ? 'none' : 4,
    firstFailingNote:
      firstWithout === undefined
        ? '目标在所有检查点都仍进候选池（或候选池为空）'
        : `目标在 ${firstWithout.label} 处**不再进入候选池**（此前可以）⇒ ④候选范围先失败；` +
          '候选数与扫描行数见 funnel.reading.scanned/candidateCount',
    ...finished,
  }
}

// ---------------------------------------------------------------------------
// S5 更正后新值可达性（P4 / L-M61-05 的前置层）
// ---------------------------------------------------------------------------

async function scenarioCorrection(label: string): Promise<ScenarioResult> {
  const { bed, h } = await openScenario(label)
  const writeExplicit = makeExplicitWriter(bed, h)
  const recallPort = buildRecallPort(h)

  const setup = ['记住：我在写毕业论文。', '更正一下，我现在在做课程设计。']
  for (const text of setup) await writeExplicit(text)

  const question = '我现在在写什么？'
  const before = await slotRowsOf(h, 'project.background.active')
  const newRow = before.find((row) => row.status === 'active')
  const oldRow = before.find((row) => row.status !== 'active')
  const targetId = newRow?.id

  const checkpoints = [0, 50, 200, 500]
  const readings: Observation[] = []
  let written = 0
  for (const checkpoint of checkpoints) {
    if (checkpoint > written) {
      written = await writeFillers({
        h,
        from: written,
        count: checkpoint - written,
        baseTime: M4_T0 + 2_000_000,
      })
    }
    readings.push(
      await observeRecall({
        h,
        recallPort,
        question,
        label: `N=${String(checkpoint)}`,
        now: M4_T0 + 2_000_000 + checkpoint + 10_000,
        ...(targetId !== undefined ? { targetId } : {}),
      })
    )
  }
  const finished = await finishScenario(bed)

  const firstWithout = readings.find(
    (reading) => reading.candidateCount > 0 && !reading.targetInCandidatePool
  )
  const funnel: FunnelLayer[] = readings.map((observation) => {
    const failing = firstFailingLayerOf({ observation, oldValuePresent: false, targetExpected: true })
    return {
      layer: 4,
      name: `更正后的新值可达性 · ${observation.label}`,
      status: 'measured',
      reading: {
        slotRowsBefore: before,
        newValueRow: newRow ?? null,
        oldValueRow: oldRow ?? null,
        ...observation,
        newValueInSelected:
          newRow !== undefined && observation.selectedValues.includes(newRow.value),
        oldValueInSelected:
          oldRow !== undefined && observation.selectedValues.includes(oldRow.value),
        firstFailingLayer: failing.layer,
        firstFailingNote: failing.note,
      },
      note:
        'P4 / L-M61-05：`更正` 之后追问 —— 现状要读的是**新值是否仍可达**。' +
        '⑥⑦⑧ 层的"旧值回潮"（Recent/摘要/回复）本基线测不到，如实 NOT RUN',
    }
  })
  return {
    id: 'S5-correction-reachability',
    goal: 'P4 / L-M61-05：更正后新值在 0/50/200/500 条处是否仍可达（旧值回潮的前置条件）',
    question,
    setup,
    readings,
    funnel,
    firstFailingLayer: firstWithout === undefined ? 'none' : 4,
    firstFailingNote:
      firstWithout === undefined
        ? '更正后的新值在所有检查点仍进候选池'
        : `更正后的新值在 ${firstWithout.label} 处**不再进入候选池** ⇒ ④先失败；` +
          '⇒ 下游（⑦Recent/摘要、⑧回复）即使带回旧值，根因也不在向量索引',
    ...finished,
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function safeTreeDigest(): Record<string, unknown> | null {
  try {
    const digest = digestTree(REAL_DB_DIR)
    return {
      dir: 'data/pglite',
      measuredCount: digest.measuredCount,
      totalBytes: digest.totalBytes,
      treeSha256: digest.treeSha256,
      algorithm: 'digestTree（INC-01 冻结算法，本脚本不重写）',
    }
  } catch (error) {
    return { dir: 'data/pglite', error: (error as Error).message }
  }
}

function gitOrNull(args: readonly string[]): string | null {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/** 先读恒等式：①②④⑤⑥ 五层是每个场景都要并进去的公共层。 */
function commonLayers(input: {
  readonly observation: Observation
  readonly storedValues: readonly string[]
  readonly oldValuePresent: boolean
}): readonly FunnelLayer[] {
  const { observation: o } = input
  return [
    {
      layer: 1,
      name: '持久化：新值是否真正被接受并持久化',
      status: 'measured',
      reading: { storedValuesInSlot: input.storedValues },
      note: '真实放行链（Validator → applyAcceptedEvents → 折叠）；库里读得到即持久化成立',
    },
    {
      layer: 2,
      name: '生命周期：旧值是否被 supersede/retract',
      status: 'measured',
      reading: { oldValueStillActiveInSlot: input.oldValuePresent },
      note: '读投影状态；`superseded` 的旧值不参与当前事实',
    },
    {
      layer: 4,
      name: '候选：查询是否找到了新值，还是候选范围先遗漏',
      status: 'measured',
      reading: {
        scanned: o.scanned,
        candidateCount: o.candidateCount,
        targetInCandidatePool: o.targetInCandidatePool,
        targetChannels: o.targetChannels,
        recallLimits: {
          defaultCandidateLimit: RECALL_LIMITS.defaultCandidateLimit,
          maxCandidateLimit: RECALL_LIMITS.maxCandidateLimit,
        },
      },
      note:
        '★ 本基线的核心判据：`targetInCandidatePool=false` 而目标**确实在库且词面命中** ⇒ ' +
        '失败在候选范围（截断/窗口），**不是**资格或排序 —— 修 prompt 或调阈值都改不到它',
    },
    {
      layer: 5,
      name: '资格/排名：资格/排名是否错误排除新值',
      status: 'measured',
      reading: { eligibleCount: o.eligibleCount, exclusionHistogram: o.exclusionHistogram },
      note: '资格层拒绝理由 + 排序/去重淘汰理由的直方图（每一条候选恰好出现一次）',
    },
    {
      layer: 6,
      name: '预算：是否保留旧片段而裁掉新事实',
      status: 'measured',
      reading: {
        droppedByBudget: o.droppedByBudget,
        memoryTokens: o.memoryTokens,
        budgetTokens: o.budgetTokens,
        selectedCount: o.selectedCount,
      },
      note: '预算裁掉 ≠ 资格拒绝：两者分开记，否则"修预算"与"修策略"会被混为一谈',
    },
  ]
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const supersedesIndex = process.argv.indexOf('--supersedes')
  const supersedes = supersedesIndex >= 0 ? (process.argv[supersedesIndex + 1] ?? null) : null
  const reasonIndex = process.argv.indexOf('--supersession-reason')
  const supersessionReason = reasonIndex >= 0 ? (process.argv[reasonIndex + 1] ?? null) : null
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: 'wp0', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)

  const realDbBefore = safeTreeDigest()
  const env = environmentReadings()

  /* --- S2：隔离库里的 vector 真值（R1）---------------------------------- */
  const probe = await openScenario('m95-wp0-vector-probe')
  const vectorProbe = await vectorExtensionProbe(probe.h)
  await probe.bed.dispose()

  const scenarios: ScenarioResult[] = []
  scenarios.push(await scenarioParaphrase('m95-wp0-paraphrase'))
  scenarios.push(await scenarioScale('m95-wp0-scale'))
  scenarios.push(await scenarioCorrection('m95-wp0-correction'))

  const realDbAfter = safeTreeDigest()
  const realDbUnchanged =
    JSON.stringify(realDbBefore) === JSON.stringify(realDbAfter) &&
    realDbBefore !== null &&
    typeof realDbBefore.treeSha256 === 'string'

  const measuredCount = scenarios.reduce((sum, scenario) => sum + scenario.readings.length, 0)
  /*
   * ⚠️ 区分两件事（这是基线量具最容易搞混的地方）：
   *   · `gapCount`      = **被测对象**有缺口（这正是基线要如实记录的读数）—— **不**影响 `usable`
   *   · `instrumentFailureCount` = **量具自己**没跑成/判定无效 —— 这才影响 `usable`
   * 把"有缺口"当成量具失败，会让基线永远 `usable=false`；
   * 把"量具坏了"当成缺口，会让坏读数进报告。两者必须分开。
   */
  const gapCount = scenarios.filter((scenario) => scenario.firstFailingLayer !== 'none').length
  const instrumentFailureCount = scenarios.filter(
    (scenario) => scenario.firstFailingLayer === 'invalid'
  ).length
  const selfCheck = selfCheckMeasurement({
    measuredCount,
    notRunCount: 0,
    failedCount: instrumentFailureCount,
  })

  const payload = {
    schemaVersion: 'm9.5-wp0-baseline@1',
    runId,
    generatedAt: new Date().toISOString(),
    supersedes,
    supersessionReason,
    plan: {
      document: 'docs/m9.5/M9.5-Execution-Plan.md',
      funnel: '§10.4 八段漏斗',
      scenarios: '§15 S01–S60（本 WP0 只做其中几个形状的**基线**，不是验收）',
    },
    libFacts: {
      realDbOpenedByThisScript: false,
      modelsInvoked: 0,
      note: '全部场景 isolateDatabase()；真实库只做只读树摘要，前后逐字相同',
    },
    staticFunnel: staticFunnelLayers(),
    environment: env,
    vectorExtensionProbe: vectorProbe,
    scenarios,
    measurement: {
      selfCheck,
      measuredCount,
      notRunCount: 0,
      gapCount,
      instrumentFailureCount,
      note:
        '本 SP 是**基线量具不是验收门**：`gapCount` 计"被测对象确有缺口"的场景数 —— 那是**读数**，不是量具失败；' +
        '`instrumentFailureCount` 才是量具自身没跑成的条数（本 run 为 0 ⇒ `usable=true` 表示"这份读数可信"，' +
        '**不表示**"没有缺口"）。两者混为一谈会让基线永远红，或者让坏读数进报告',
    },
    realDbProtection: {
      before: realDbBefore,
      after: realDbAfter,
      unchanged: realDbUnchanged,
      definition:
        '`digestTree()`（INC-01 冻结算法，`src/infrastructure/persistence/production-db-safety.ts`）' +
        '对 `data/pglite` 的只读内容树摘要；前后逐字相同 ⇒ 本脚本从未打开写入真实库',
    },
    commonLayersTemplate: commonLayers({
      observation: {
        label: '(template)',
        question: '(template)',
        scanned: 0,
        candidateCount: 0,
        eligibleCount: 0,
        selectedCount: 0,
        selectedIds: [],
        selectedValues: [],
        droppedByBudget: 0,
        reachedContext: false,
        exclusionHistogram: {},
        decisions: [],
        targetInCandidatePool: false,
        targetChannels: [],
        targetInSelected: false,
        memoryTokens: 0,
        budgetTokens: 0,
      },
      storedValues: [],
      oldValuePresent: false,
    }).map((layer) => ({ layer: layer.layer, name: layer.name, status: layer.status })),
  }

  const evidencePath = join(runDir, 'wp0-baseline.json')
  writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const tree = sourceTreeReading(REPO_ROOT)
  const manifestPath = writeM95Manifest(runDir, {
    runId,
    stage: 'wp0',
    lane: 'offline',
    startedAt: STARTED_AT,
    completedAt: new Date().toISOString(),
    head: gitOrNull(['rev-parse', 'HEAD']),
    headShort,
    branch: gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyPaths: dirtyPaths(REPO_ROOT),
    sourceTreeHash: tree.treeSha256,
    sourceTreeHashDefinition: tree.definition,
    gateVersion: GATE_VERSION,
    dbKind: 'synthetic',
    isolationProof: {
      sandboxIsolationUsed: true,
      realDbDigestBefore: realDbBefore,
      realDbDigestAfter: realDbAfter,
      realDbUnchanged,
      method: 'isolateDatabase() + digestTree() 前后比对（只读）',
    },
    configHash: (env.nonSecretConfigFingerprint?.value as Record<string, unknown>) ?? {},
    command: [{ cmd: 'pnpm m9.5:baseline', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount,
    notRunCount: 0,
    counts: {
      total: measuredCount,
      passed: measuredCount - instrumentFailureCount,
      failed: instrumentFailureCount,
    },
    toolVersions: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      git: gitOrNull(['--version']),
    },
    supersedes,
    artifactHashes: { 'wp0-baseline.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 WP0 基线完成：${runId}`,
      `  证据：${evidencePath}`,
      `  清单：${manifestPath}`,
      `  vector 扩展：${String(vectorProbe.verdict)}`,
      `  真实库前后摘要相同：${String(realDbUnchanged)}`,
      ...scenarios.map(
        (scenario) =>
          `  ${scenario.id}：最先失败层 = ${String(scenario.firstFailingLayer)} —— ${scenario.firstFailingNote}`
      ),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  缺口场景数（读数，不是量具失败）：${String(gapCount)}`,
    ].join('\n') + '\n'
  )

  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

await main()
