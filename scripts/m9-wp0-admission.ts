/**
 * M9 WP0 —— **准入审计**（`pnpm m9:wp0:admission`）：PRE-01…PRE-10 逐项机器读数。
 *
 * ============================================================================
 *  要测的命题（先写命题，再写量具）
 * ============================================================================
 * 计划 §4.1 的十项准入，每项都要有 PASS / NOT BLOCKING / 具名接受边界 / 缺口登记
 * 的**机器读数**，不许"以后再看"：
 *
 *   PRE-02（L-M8-13 M7 双缺陷）：隔离复现 tool 事件楔死 + catch 不 finishJob。
 *     ⚠️ 本脚本在**基线时刻**运行：E1/E2 的 PASS = **缺陷如实在场**（复现成功）。
 *     WP0-R 修复后这两条会翻红——那是预期行为，修复验证走 `m9:wp0r:verify`
 *     （同一场景、修复后期望），本证据按时间点保留，不回写。
 *   PRE-03（TD-08 召回规模）：1000 条隔离样本，位置 1/50/51/500/501/最老——
 *     belief 的两条读路径（按确 ID `store.get` + 域事件流 `domainEventsFor`）
 *     都**不经过**召回排名的 50/250/500 窗口。
 *   PRE-04（TD-09 歧义遗忘）：`target_ambiguous` 的具名拒绝仍在、且只出现在
 *     已知清单文件里（信念不得猜目标 = WP1/WP5 设计约束，现状闸门健康）。
 *   PRE-05（L-M61-04/05 长尾）：更正/撤回后按 ID 回查读到的是**当前状态**
 *     （superseded/retracted）——侵蚀发生在召回排名层，belief 的依赖回查
 *     不走那层；长尾行为发现保持登记，不因本读数冒充已关闭。
 *
 * ============================================================================
 *  硬边界（判据，不是注释）
 * ============================================================================
 *  · `isolateDatabase()` 一次性沙箱库（本文件顶部、任何数据库 import 之前）；
 *    真实库**从不被打开**（不取租约、不建连接、不迁移）。
 *  · 不调模型、不出站；纯本地读写沙箱（commitAndFold 走规则抽取器，零 LLM）。
 *  · 计数型自检：每条测量都有非零分母（AGENTS §6.8）。
 *  · 静态检查只读源码文本；不修改任何文件。
 *  · E1/E2 用**真实生产函数**（maybeRunRelationshipEvaluation / enqueueJob /
 *    markJobRunning / runRelationshipEvaluation），不是复制品。
 */
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m9-wp0-admission', { keep: false })

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { asConversationId, entityRef } from '../src/kernel/contracts/index.ts'
import { registeredPredicates } from '../src/kernel/contracts/memory-predicates.ts'
import { createConversationLedger } from '../src/infrastructure/persistence/ledger.ts'
import { domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { enqueueJob, getJob, getWatermark, markJobRunning } from '../src/infrastructure/persistence/job-store.ts'
import { latestCharacterEventSequence } from '../src/infrastructure/persistence/conversation-store.ts'
import {
  createRelationshipJobPorts,
  maybeRunRelationshipEvaluation,
  relationshipOwnerOf,
} from '../src/infrastructure/runtime/relationship-scheduler.ts'
import {
  RELATIONSHIP_JOB_TRIGGER_KIND,
  relationshipEvaluationIdempotencyKey,
  runRelationshipEvaluation,
} from '../src/kernel/app/relationship/job.ts'
import {
  RELATIONSHIP_EVALUATOR_NAME,
  RELATIONSHIP_EVALUATOR_VERSION,
} from '../src/kernel/app/relationship/evaluator.ts'
import { M4_T0, createM4Harness, type M4Harness } from './m4-harness.ts'
import { createM9RunId, openM9RunDir, writeM9Manifest } from './m9-evidence.ts'

const REPO_ROOT = resolve(process.cwd())

/** PRE-03 的隔离样本量（计划 §4.3：51 / 501 / 1000 三档都要越过）。 */
const SEED_COUNT = 1000

// ---------------------------------------------------------------------------
// 量具：检查条目
// ---------------------------------------------------------------------------

interface Check {
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}

const checks: Check[] = []
function record(id: string, label: string, expected: string, actual: string, pass: boolean): void {
  checks.push({ id, label, expected, actual, pass })
}

// ---------------------------------------------------------------------------
// 静态代码事实（只读源码文本）
// ---------------------------------------------------------------------------

function readSrc(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8')
}

function srcFilesUnder(dir: string): string[] {
  const out: string[] = []
  const visit = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name)
      if (entry.isDirectory()) visit(abs)
      else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(abs)
    }
  }
  visit(dir)
  return out
}

function rel(p: string): string {
  return relative(REPO_ROOT, p).split(/[\\/]/).join('/')
}

/** TD-09：`target_ambiguous` 的命中文件集必须落在已知清单内（M7 同款三段式对照）。 */
const TARGET_AMBIGUOUS_KNOWN_FILES: readonly string[] = [
  'src/kernel/app/memory/explicit-service.ts',
  'src/kernel/app/memory/response-truth.ts',
  'src/kernel/app/memory/correction-fallback.ts',
  'src/kernel/app/memory/target-resolver.ts',
  'src/kernel/app/memory/explicit-turn.ts',
  'src/kernel/recall/eligibility.ts',
  'src/kernel/contracts/recall.ts',
  // M4.5 action 域的**定义点**（错误分类法 + 策略映射；首轮量具漏记，校准补录）
  'src/kernel/action/errors.ts',
  'src/kernel/action/policy.ts',
  'src/kernel/action/gateway.ts',
  'src/kernel/action/action-turn.ts',
  'src/kernel/action/external-evidence-reply.ts',
  'src/kernel/app/memory/admin.ts',
]

function staticChecks(): void {
  // ---- PRE-02：M7 双缺陷的代码事实（基线时刻：缺陷在场 = 复现目标存在）----
  const relJob = readSrc('src/kernel/app/relationship/job.ts')
  const relScheduler = readSrc('src/infrastructure/runtime/relationship-scheduler.ts')
  const affectJob = readSrc('src/kernel/app/affect/job.ts')
  const affectScheduler = readSrc('src/infrastructure/runtime/affect-scheduler.ts')

  const relJobUnfiltered =
    relJob.includes('events.map((event) => processorEventViewOf(event))') &&
    !relJob.includes("actorType !== 'tool'")
  record(
    'S1',
    'PRE-02(a) 在场：relationship/job.ts 把窗口全部事件裸转 ProcessorEventView（无 tool 过滤）',
    '缺陷在场（WP0-R 修复对象）',
    relJobUnfiltered ? '裸转在、无过滤' : '已有过滤（与基线预期不符）',
    relJobUnfiltered,
  )

  const relCatch = /catch \(error\) \{[\s\S]*?return \{ kind: 'failed'[\s\S]*?\}/.exec(relScheduler)
  const relCatchNoFinish =
    relCatch !== null && !relCatch[0].includes('finishJob') && !relScheduler.includes("finishJob(db, job.id, 'failed'")
  record(
    'S2',
    "PRE-02(b) 在场：relationship-scheduler catch 只 return failed、从不 finishJob('failed')",
    '缺陷在场（WP0-R 修复对象）',
    relCatchNoFinish ? 'catch 无 finishJob' : 'catch 已落 failed（与基线预期不符）',
    relCatchNoFinish,
  )

  const affectJobFiltered = affectJob.includes("filter((event) => event.actorType !== 'tool')")
  record(
    'S3',
    'M8 参照修复 (a) 在场：affect/job.ts 先滤 tool 事件再转视图',
    '参照实现存在（WP0-R 抄它的形状）',
    affectJobFiltered ? '过滤在场' : '过滤缺失（与 M8 交付不符）',
    affectJobFiltered,
  )

  const affectCatchFinish = affectScheduler.includes("finishJob(db, job.id, 'failed'")
  record(
    'S4',
    "M8 参照修复 (b) 在场：affect-scheduler catch 里 finishJob(job.id, 'failed')",
    '参照实现存在（WP0-R 抄它的形状）',
    affectCatchFinish ? 'finishJob 在 catch 内' : '缺失（与 M8 交付不符）',
    affectCatchFinish,
  )

  // ---- 存储承载审计（计划 §8.2 / WP0 任务 4：迁移目标 NONE）----
  const migrations = readSrc('src/infrastructure/persistence/migrations.ts')
  const projectionsPk =
    migrations.includes('create table if not exists character_projections') &&
    migrations.includes('primary key (character_id, projection_type)')
  // 列型断言用容忍间距的正则（首轮量具教训：逐字空格数与 DDL 排版耦合，量的是排版不是事实）
  const textColumns =
    /\btype\s+text\s+not null/.test(migrations) &&
    /\bprojection_type\s+text\s+not null/.test(migrations) &&
    /\bprocessor\s+text\s+not null/.test(migrations)
  const relContracts = readSrc('src/kernel/contracts/relationship.ts')
  const scopeInType = relContracts.includes("relationship:user:") || relContracts.includes('relationship:<kind>:<id>')
  record(
    'S5',
    '通用投影表可承载 belief（PK (character_id, projection_type) · 全 text 列 · relationship 先例把作用域编进 projectionType）⇒ 零迁移可行',
    '三事实齐备 ⇒ BELIEF_* 事件名与 belief:<beliefId> 投影行无需新迁移',
    `PK=${String(projectionsPk)} · text列=${String(textColumns)} · 作用域先例=${String(scopeInType)}`,
    projectionsPk && textColumns && scopeInType,
  )

  // ---- Context 预留 ----
  const context = readSrc('src/kernel/contracts/context.ts')
  record(
    'S6',
    "Context 预留在场：section kind 'belief' + SECTION_PRIORITY.belief = 50",
    '枚举与优先级都已预留（M3.5 起）',
    `kind=${String(context.includes("'belief' // M9"))} · priority50=${String(context.includes('belief: 50'))}`,
    context.includes("'belief' // M9") && context.includes('belief: 50'),
  )

  // ---- PRE-08：FC-T05 阶段锁 ----
  const fc = readSrc('scripts/future-compat-tests.ts')
  const fcLock = fc.includes("includes('belief')") && fc.includes('M3.5 不实现 Belief store')
  record(
    'S7',
    'PRE-08：FC-T05 存在性锁在场（contracts 下无 belief 文件）——WP2 建 contracts/belief.ts 时按计划 §11 正式交接',
    '锁在场（交接是 WP1 冻结 / WP2 落地的已排工作，不是缺口）',
    fcLock ? '存在性锁在' : '锁已被移除（与基线预期不符）',
    fcLock,
  )

  // ---- flags 现状 ----
  const flags = readSrc('src/kernel/app/flags.ts')
  record(
    'S8',
    'flags.ts 尚无 CHARACTER_BELIEF_ENABLED（预期：WP6 才新增，缺省 off）',
    '键不存在（预期形态）',
    flags.includes('CHARACTER_BELIEF_ENABLED') ? '键已存在（与基线预期不符）' : '键不存在',
    !flags.includes('CHARACTER_BELIEF_ENABLED'),
  )

  // ---- 谓词登记表（B-REPORTED 白名单候选）----
  const registered = registeredPredicates().map((p) => p.key)
  const expectedPredicates = [
    'food.preference.cilantro',
    'food.avoid.general',
    'education.status',
    'education.major',
    'education.institution',
    'preferred.explanation.style',
    'preferred.address',
    'project.background.active',
    'device.primary',
    'tooling.preference.editor',
  ]
  const missingPredicates = expectedPredicates.filter((k) => !registered.includes(k))
  record(
    'S9',
    'Memory 谓词登记表 10 键齐备（B-REPORTED 白名单候选池）',
    '10/10 已登记',
    `${String(registered.length)} 键 · 缺=${missingPredicates.join(',') || '无'}`,
    registered.length >= 10 && missingPredicates.length === 0,
  )

  // ---- PRE-04：target_ambiguous 的零依赖闸 ----
  const hits: string[] = []
  for (const file of srcFilesUnder(join(REPO_ROOT, 'src'))) {
    if (readFileSync(file, 'utf8').includes('target_ambiguous')) hits.push(rel(file))
  }
  const unknownHits = hits.filter((f) => !TARGET_AMBIGUOUS_KNOWN_FILES.includes(f))
  record(
    'S10',
    'PRE-04：target_ambiguous 只出现在已知清单文件（歧义=具名拒绝，无批量删、无猜测改）',
    '命中文件集 ⊆ 已知清单',
    `${String(hits.length)} 处 · 未知=${unknownHits.join(',') || '无'}`,
    hits.length > 0 && unknownHits.length === 0,
  )

  // ---- TD-08 对照面 ----
  const retrieval = readSrc('src/infrastructure/persistence/memory-retrieval-store.ts')
  const slicePresent = retrieval.includes('filtered.slice(0, query.limit)')
  record(
    'S11',
    'TD-08 对照面：召回排序前 slice(0, query.limit) 仍在（recall 路径受 50/250/500 窗口影响——belief 的按 ID 读不走这层）',
    '切片行在场（已知限制保持登记）',
    slicePresent ? 'slice 在场' : 'slice 已不在（与基线预期不符）',
    slicePresent,
  )

  // ---- PRE-06：src/state 兼容窗口 ----
  record(
    'S12',
    'PRE-06：src/state 兼容窗口仍在（M8 off 回退保留；Belief 不读旧情绪字段 = WP1 冻结的读取策略）',
    '目录存在',
    existsSync(join(REPO_ROOT, 'src', 'state')) ? '存在' : '不存在（与基线预期不符）',
    existsSync(join(REPO_ROOT, 'src', 'state')),
  )

  // ---- PRE-09：M6.1 聚合门当前读数可判 ----
  // 聚合器把 gate-results.json 写进**第一个 --manifest 的 run 目录**（不是固定路径）。
  // "最新"按**文件 mtime** 判（目录名里的日期夹在 wp 名中间，字典序 ≠ 时间序——
  // 首轮量具按名字排序挑中了 09-25 的 REFUSED 历史档，校准为 mtime）。
  const m61Dir = join(REPO_ROOT, 'artifacts', 'm6.1')
  let m61Overall = '(无读数文件)'
  if (existsSync(m61Dir)) {
    const candidates = readdirSync(m61Dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(m61Dir, e.name, 'gate-results.json'))
      .filter((p) => existsSync(p))
      .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    const newest = candidates[0]
    if (newest !== undefined) {
      try {
        const parsed = JSON.parse(readFileSync(newest.p, 'utf8')) as { overall?: string }
        m61Overall = `${rel(dirname(newest.p))} ⇒ overall=${parsed.overall ?? '(缺 overall)'}（mtime 最新）`
      } catch {
        m61Overall = '(读数文件解析失败)'
      }
    }
  }
  record(
    'S13',
    'PRE-09：M6.1 聚合读数在场且 mtime 最新一份 overall=PASS（2026-09-27 修订读数；L-M61-14/15 残余保持登记）',
    'mtime 最新 gate-results.json 的 overall = PASS',
    m61Overall,
    m61Overall.includes('overall=PASS'),
  )

  // ---- PRE-10：INC-01 工具链可用 ----
  const inc01Tools =
    existsSync(join(REPO_ROOT, 'scripts', 'snapshot-db.ts')) &&
    existsSync(join(REPO_ROOT, 'scripts', 'restore-db.ts')) &&
    existsSync(join(REPO_ROOT, 'scripts', 'inc-01-gates.ts'))
  record(
    'S14',
    'PRE-10：INC-01 快照/恢复/聚合门工具链在场（M9 全程不打开真实库做探针；需要副本时走既有流程）',
    'snapshot-db / restore-db / inc-01-gates 三脚本齐备',
    inc01Tools ? '齐备' : '缺件',
    inc01Tools,
  )

  // ---- 变更流缺口（WP3/WP4 工作项登记）----
  const eventStore = readSrc('src/infrastructure/persistence/event-store.ts')
  const noLowerBound = !eventStore.includes('afterSequence')
  record(
    'S15',
    '域事件流缺下界读法（domainEventsFor 无 afterSequence）——带水位的 belief-memory reconciler 需要追加该读法（冻结区"只允许追加能力"，走对应门）',
    '缺口在场（已登记为 WP3/WP4 工作项，不是阻断）',
    noLowerBound ? '无 afterSequence（缺口确认）' : '已有下界读法（与基线预期不符）',
    noLowerBound,
  )

  // ---- 按 ID 回查组合 ----
  const qualRead = readSrc('src/infrastructure/persistence/qualification-read.ts')
  const qualComplete =
    qualRead.includes('rootReadingsByMemory') && qualRead.includes('qualificationsForMemories')
  record(
    'S16',
    '按 ID 回查组合齐备：store.get(id) + qualificationsForMemories（当前资格读时派生）——belief 依赖回查零新增 SQL',
    '两个读取口都在',
    qualComplete ? '齐备' : '缺件',
    qualComplete,
  )
}

// ---------------------------------------------------------------------------
// 隔离实验
// ---------------------------------------------------------------------------

async function experimentE1(h: M4Harness, ledger: ReturnType<typeof createConversationLedger>, conversationId: ReturnType<typeof asConversationId>): Promise<void> {
  // E1a 对照：纯用户窗口不抛（证明窗口本身可处理）
  const evidence = await h.recordUserEvidence('谢谢你最近一直陪我聊天。')
  void evidence
  const owner = relationshipOwnerOf(h.characterId)
  let controlThrew = false
  let controlKind = '(未运行)'
  try {
    const outcome = await maybeRunRelationshipEvaluation(h.db, {
      characterId: h.characterId,
      owner,
    })
    controlKind = outcome.kind
  } catch (error) {
    controlThrew = true
    controlKind = `throw: ${(error as Error).message}`
  }
  record(
    'E1a',
    'PRE-02 对照：纯用户消息窗口，调度器完整返回（不抛）',
    '不抛（kind 任意）',
    controlKind,
    !controlThrew,
  )

  // E1b 缺陷 (a)：窗口混入 tool 事件 ⇒ dry-run 在 try 之外裸转 ⇒ 异常穿透调度器
  await ledger.appendToolEvent({
    characterId: h.kernel.characterId,
    conversationId,
    conversationSequence: 9001,
    toolName: 'web-search',
    content: '搜索结果摘要：谢谢你……（外部内容）',
    createdAt: M4_T0 + 50,
  })
  let defectCode = '(未抛)'
  let threw = false
  try {
    await maybeRunRelationshipEvaluation(h.db, {
      characterId: h.characterId,
      owner,
    })
  } catch (error) {
    threw = true
    defectCode = (error as { code?: string }).code ?? (error as Error).message
  }
  record(
    'E1b',
    'PRE-02(a) 复现：tool 事件进窗口 ⇒ processorEventViewOf 抛 tool_event_not_extractable_in_m4，且 dry-run 在 try 之外 ⇒ 异常穿透 maybeRunRelationshipEvaluation（违反自身"不抛"契约）',
    '抛 tool_event_not_extractable_in_m4',
    threw ? defectCode : '(未抛——缺陷不在场)',
    threw && defectCode === 'tool_event_not_extractable_in_m4',
  )
}

async function experimentE2(h: M4Harness): Promise<void> {
  // 手动驱动 job 级序列（与调度器消费段同一形状）：
  // enqueue → markRunning → run（抛）→【调度器 catch 实际行为：对 job 什么都不做】
  const owner = relationshipOwnerOf(h.characterId)
  const watermarkRow = await getWatermark(
    h.db,
    h.kernel.characterId,
    RELATIONSHIP_EVALUATOR_NAME,
    RELATIONSHIP_EVALUATOR_VERSION,
  )
  const from = (watermarkRow?.processedThroughSequence ?? 0) + 1
  const latest = await latestCharacterEventSequence(h.db, h.kernel.characterId)
  const idempotencyKey = relationshipEvaluationIdempotencyKey({
    characterId: h.kernel.characterId,
    processor: RELATIONSHIP_EVALUATOR_NAME,
    processorVersion: RELATIONSHIP_EVALUATOR_VERSION,
    sourceFromSequence: from,
    sourceToSequence: latest,
  })
  const { job } = await enqueueJob(h.db, {
    characterId: h.kernel.characterId,
    processor: RELATIONSHIP_EVALUATOR_NAME,
    processorVersion: RELATIONSHIP_EVALUATOR_VERSION,
    sourceFromSequence: from,
    sourceToSequence: latest,
    idempotencyKey,
    triggerKind: RELATIONSHIP_JOB_TRIGGER_KIND,
    now: M4_T0 + 100,
  })
  await markJobRunning(h.db, job.id, M4_T0 + 100)

  const ports = createRelationshipJobPorts(h.db)
  let jobLevelThrew = false
  let jobLevelCode = '(未抛)'
  try {
    await runRelationshipEvaluation(ports, {
      characterId: h.kernel.characterId,
      owner,
      fromSequence: from,
      toSequence: latest,
      now: M4_T0 + 100,
    })
  } catch (error) {
    jobLevelThrew = true
    jobLevelCode = (error as { code?: string }).code ?? (error as Error).message
  }
  record(
    'E2a',
    'PRE-02(a) job 级复现：markRunning 之后 runRelationshipEvaluation 抛 tool_event_not_extractable_in_m4',
    '抛 tool_event_not_extractable_in_m4',
    jobLevelThrew ? jobLevelCode : '(未抛)',
    jobLevelThrew && jobLevelCode === 'tool_event_not_extractable_in_m4',
  )

  // 缺陷 (b)：调度器 catch 对 job 什么都不做 ⇒ 行楔在 running
  const stuck = await getJob(h.db, job.id)
  record(
    'E2b',
    "PRE-02(b) 复现：失败后 job 行楔在 running（catch 不 finishJob('failed')）",
    "status === 'running'",
    `status=${stuck?.status ?? '(不存在)'}`,
    stuck?.status === 'running',
  )

  // 楔死证明：同键重试 ⇒ enqueue 返回旧 running 行（created=false）⇒ markRunning 抛 job_not_pending
  const retry = await enqueueJob(h.db, {
    characterId: h.kernel.characterId,
    processor: RELATIONSHIP_EVALUATOR_NAME,
    processorVersion: RELATIONSHIP_EVALUATOR_VERSION,
    sourceFromSequence: from,
    sourceToSequence: latest,
    idempotencyKey,
    triggerKind: RELATIONSHIP_JOB_TRIGGER_KIND,
    now: M4_T0 + 200,
  })
  let wedgeCode = '(未抛)'
  try {
    await markJobRunning(h.db, retry.job.id, M4_T0 + 200)
  } catch (error) {
    wedgeCode = (error as { code?: string }).code ?? (error as Error).message
  }
  record(
    'E2c',
    '楔死证明：同窗重试撞 job_not_pending ⇒ 该窗口永久无法重处理、水位永不前进（M8 因 catch 里 finishJob 而有 L-M8-14 两步自愈，M7 没有）',
    'job_not_pending',
    `created=${String(retry.created)} · ${wedgeCode}`,
    wedgeCode === 'job_not_pending',
  )
}

async function experimentE3(h: M4Harness): Promise<void> {
  // 1000 条隔离样本（越过 51 / 501 两档），位置 1/50/51/500/501/最老 全部按 ID 可读
  const evidenceRefs: { kind: 'conversation_event'; id: string }[] = []
  for (let i = 0; i < 4; i += 1) {
    const ev = await h.recordUserEvidence(`准入样本播种第 ${i} 批：我在写长期项目。`)
    evidenceRefs.push(ev.ref)
  }

  const ids: string[] = []
  for (let i = 0; i < SEED_COUNT; i += 1) {
    const subject = h.newSubject(`m9-wp0-probe-${i}`)
    const candidate = h.makeCandidate(
      'person_fact',
      {
        kind: 'claim',
        subject,
        predicate: 'project.background.active',
        value: `长期项目-${i}`,
      },
      { sourceRefs: [evidenceRefs[i % evidenceRefs.length]!] },
    )
    const recordResult = await h.commitAndFold(candidate, M4_T0 + 1000 + i * 10)
    if (recordResult === null) throw new Error(`样本 ${i} 提交失败（非预期——准入实验要求全部落库）`)
    ids.push(String(recordResult.id))
  }
  if (ids.length !== SEED_COUNT) throw new Error(`播种数 ${ids.length} ≠ ${SEED_COUNT}`)

  // 按 recordedAt 降序取位置（位置 1 = 最新）
  const all: { id: string; recordedAt: number }[] = []
  for (const id of ids) {
    const r = await h.store.get(id as never)
    if (r === null) throw new Error(`样本 ${id} 读回失败`)
    all.push({ id, recordedAt: Number(r.recordedAt) })
  }
  all.sort((a, b) => b.recordedAt - a.recordedAt)
  const positions = [1, 50, 51, 500, 501, SEED_COUNT]
  const positionReads = positions.map((p) => {
    const expected = all[p - 1]!
    const got = expected ? '读到' : '(缺位)'
    return `位置${p}=${got}`
  })
  const allPositionsReadable = positions.every((p) => all[p - 1] !== undefined)
  record(
    'E3a',
    `PRE-03：${SEED_COUNT} 条样本按 ID 回查，位置 1/50/51/500/501/最老 全部可读（store.get 不经召回排名窗口）`,
    '6 个位置全读到',
    positionReads.join(' · '),
    allPositionsReadable,
  )

  // 域事件流：MEMORY_CREATED 全量可见（reconciler 的源流无截断）
  const created = await domainEventsFor(h.db, h.kernel.characterId, { type: 'MEMORY_CREATED' })
  record(
    'E3b',
    'PRE-03：MEMORY_CREATED 域事件流全量可见（domainEventsFor 无 50/250/500 窗口——belief reconciler 的源流不受 TD-08 影响）',
    `≥ ${SEED_COUNT}`,
    `${String(created.length)} 条`,
    created.length >= SEED_COUNT,
  )
}

async function experimentE4(h: M4Harness): Promise<void> {
  // 更正（supersede）后按 ID 回查 = 当前状态；active-by-key 只剩新值
  const evA = await h.recordUserEvidence('记住，我最喜欢吃香菜。')
  const a = (await h.commitAndFold(
    h.makeCandidate(
      'preference',
      { kind: 'claim', subject: h.user, predicate: 'food.preference.cilantro', value: 'like' },
      { sourceRefs: [evA.ref] },
    ),
    M4_T0 + 20_000,
  ))!
  const evB = await h.recordUserEvidence('更正一下，我现在不吃香菜了。')
  const b = (await h.commitAndFold(
    h.makeCandidate(
      'preference',
      { kind: 'claim', subject: h.user, predicate: 'food.preference.cilantro', value: 'dislike' },
      { sourceRefs: [evB.ref] },
    ),
    M4_T0 + 21_000,
  ))!
  await h.applyStateChange(
    'supersede',
    evB.ref.id,
    {
      memoryId: a.id,
      supersededBy: b.id,
      validUntil: M4_T0 + 21_000,
      reason: '用户更正：现在不吃香菜了',
    },
    M4_T0 + 21_000,
  )
  const aAfter = await h.store.get(a.id as never)
  const active = await h.store.getActiveByCanonicalKey(a.canonicalKey as never)
  const activeOnlyNew = active.length === 1 && String(active[0]!.id) === String(b.id)
  record(
    'E4a',
    'PRE-05（更正）：supersede 后按 ID 回查读到 superseded 状态、槽位 active 只剩新值——belief 的依赖回查看到的是"当前事实"，L-M61-05 的侵蚀发生在召回排名层（belief 不走）',
    "旧=superseded · active 只剩新值",
    `旧状态=${aAfter?.status ?? '(读不到)'} · active数=${String(active.length)} · 只剩新值=${String(activeOnlyNew)}`,
    aAfter?.status === 'superseded' && activeOnlyNew,
  )

  // 遗忘（retract）后按 ID 回查 = retracted（belief 依赖失效的触发源）
  const evForget = await h.recordUserEvidence('忘掉我吃香菜偏好这件事。')
  await h.applyStateChange(
    'retract',
    evForget.ref.id,
    { memoryId: b.id, reason: 'explicit_forget', note: '用户要求忘掉' },
    M4_T0 + 22_000,
  )
  const bAfter = await h.store.get(b.id as never)
  record(
    'E4b',
    'PRE-05（遗忘）：retract 后按 ID 回查读到 retracted 状态——"Belief 不得绕过 Memory 遗忘"（INV-M9-06）的依赖失效信号在按 ID 读路径上如实可见',
    "status === 'retracted'",
    `状态=${bAfter?.status ?? '(读不到)'}`,
    bAfter?.status === 'retracted',
  )
}

// ---------------------------------------------------------------------------
// PRE 判定汇总
// ---------------------------------------------------------------------------

function preVerdicts(): { pre: string; verdict: string; basis: string }[] {
  const byId = new Map(checks.map((c) => [c.id, c]))
  const ok = (ids: string[]): boolean => ids.every((id) => byId.get(id)?.pass === true)
  return [
    {
      pre: 'PRE-01 基线与共享树',
      verdict: 'PASS（见同 WP 的 baseline run：B1–B6/A7–A9）',
      basis: 'm9:wp0:baseline before/after 两段采样；脏文件归属分类 unknown=0',
    },
    {
      pre: 'PRE-02 L-M8-13 M7 双缺陷',
      verdict: ok(['S1', 'S2', 'E1b', 'E2a', 'E2b', 'E2c'])
        ? 'DEFECT CONFIRMED —— WP0-R 修复欠账（阻断范围：三域联合验收之前）'
        : 'UNEXPECTED（复现形状与登记不符，先查量具）',
      basis: 'S1/S2 代码事实 + E1b 穿透 + E2a-c 楔死链',
    },
    {
      pre: 'PRE-03 TD-08 召回规模',
      verdict: ok(['E3a', 'E3b'])
        ? 'NOT BLOCKING（belief 两条读路径均不经召回窗口；召回路径限制保持登记）'
        : 'BLOCKED（按 ID / 域事件流读不通 ⇒ 必须先修）',
      basis: 'E3a 位置 1/50/51/500/501/最老 + E3b 域事件全量 + S11 对照面',
    },
    {
      pre: 'PRE-04 TD-09 歧义遗忘',
      verdict: ok(['S10'])
        ? 'NOT BLOCKING（具名拒绝闸健康；"信念不猜目标"进 WP1/WP5 设计约束）'
        : 'BLOCKED（闸门漂移 ⇒ 遗忘交付阻断）',
      basis: 'S10 target_ambiguous 零依赖清单',
    },
    {
      pre: 'PRE-05 L-M61-04/05 长尾',
      verdict: ok(['E4a', 'E4b'])
        ? 'NOT BLOCKING for belief 依赖回查（按 ID 读到当前状态）；长尾行为发现保持登记、不冒充已关闭'
        : 'BLOCKED（按 ID 读不到当前状态 ⇒ belief 来源/使用受影响，必须先修）',
      basis: 'E4a supersede + E4b retract 的按 ID 回查',
    },
    {
      pre: 'PRE-06 src/state 兼容窗口',
      verdict: ok(['S12'])
        ? 'ACCEPTED BOUNDARY（M8 off 回退保留；Belief 不读旧情绪字段——WP1 冻结读取策略）'
        : 'BLOCKED（兼容窗口不在 ⇒ 退役裁定必须先落地）',
      basis: 'S12 目录存在性',
    },
    {
      pre: 'PRE-07 M8 人审 PENDING',
      verdict: 'ACCEPTED BOUNDARY（M8 Human Review = PENDING 保持分列；M9 自己的人审不得借用 M8 结论；三域共同措辞进 M9 场景）',
      basis: 'M8-Gate-Decision §4/§6 的既有分列（文档读数，非本脚本机器断言）',
    },
    {
      pre: 'PRE-08 FC-T05 阶段锁',
      verdict: ok(['S7'])
        ? 'NOT BLOCKING（锁在场；WP1 记录交接、WP2 落地等强判据——已排工作不是缺口）'
        : 'UNEXPECTED（锁已消失但交接未记录 ⇒ 查历史）',
      basis: 'S7 存在性锁在场',
    },
    {
      pre: 'PRE-09 M6.1 聚合门',
      verdict: ok(['S13'])
        ? 'NOT BLOCKING（最新聚合读数 overall=PASS（2026-09-27）；L-M61-14/15 残余保持登记）'
        : 'NOT BLOCKING with 具名缺口（聚合读数不可判 ⇒ 按登记册 R-17 分列，不阻断 M9）',
      basis: 'S13 最新 gate-results.json 的 overall 读数',
    },
    {
      pre: 'PRE-10 生产安全',
      verdict: ok(['S14'])
        ? 'PASS（INC-01 工具链在场；M9 WP0 全程未打开真实库）'
        : 'BLOCKED（工具链缺件 ⇒ 任何需要数据副本的测试阻断）',
      basis: 'S14 三脚本存在性 + 本脚本 isolateDatabase 纪律',
    },
  ]
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  staticChecks()

  const h = await createM4Harness({ label: 'm9-wp0-admission' })
  try {
    const ledger = createConversationLedger({ db: h.db })
    const conversationId = asConversationId('m9-wp0-admission')

    await experimentE1(h, ledger, conversationId)
    await experimentE2(h)
    await experimentE3(h)
    await experimentE4(h)
  } finally {
    await h.stop()
  }

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM9RunId({ wpId: 'wp0-admission', headShort: head })
  const dir = openM9RunDir(REPO_ROOT, runId)

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const verdicts = preVerdicts()
  const blocking = verdicts.filter((v) => v.verdict.startsWith('BLOCKED')).length

  const payload = {
    schema: 'm9-wp0-admission@1',
    runId,
    head,
    seedCount: SEED_COUNT,
    checks,
    preVerdicts: verdicts,
    summary: {
      total: checks.length,
      passed,
      failed,
      blockingPres: blocking,
      verdict:
        failed === 0 && blocking === 0
          ? 'ADMISSION PASS（PRE-02 为已确认缺陷，修复欠账归 WP0-R——按计划 §4.1 不阻断 M9 开工，阻断三域联合验收）'
          : failed === 0
            ? 'ADMISSION PASS WITH NAMED BLOCKERS'
            : 'ADMISSION FAIL',
    },
  }
  writeFileSync(join(dir, 'admission.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM9Manifest(dir, {
    runId,
    wp: 'wp0',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'admission',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes: 'PRE-01…PRE-10 准入审计：E1/E2 为基线时刻的缺陷复现（PASS=缺陷在场），WP0-R 修复后走 m9:wp0r:verify',
    databaseScope: 'isolated',
    mode: 'offline',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label}`)
    console.log(`      期望 ${c.expected} · 实测 ${c.actual}`)
  }
  console.log('--- PRE 判定 ---')
  for (const v of verdicts) console.log(`  ${v.pre} ⇒ ${v.verdict}`)
  console.log(`verdict: ${payload.summary.verdict}（${passed}/${checks.length}）`)
  process.exitCode = failed === 0 ? 0 : 1
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
