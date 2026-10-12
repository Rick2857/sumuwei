/**
 * M10 WP0 —— **准入审计**（`pnpm m10:wp0:admission`）。
 *
 * ============================================================================
 *  这份脚本要回答什么（M10 计划 §12 WP0「必须回答」六问）
 * ============================================================================
 * ```text
 *   Q1  实际 Memory revision 从哪里读取                       （§1.4 缺口 1）
 *   Q2  Belief 资格如何复用                                   （§1.4 缺口 3）
 *   Q3  Goal 操作的用户归因从哪里取得                          （§7.1 / §8.2）
 *   Q4  正式 assistant event 何时落盘                          （§9.1 / §9.2）
 *   Q5  哪些接口允许幂等兑现补记                               （§9.3）
 *   Q6  是否真的需要迁移                                       （§8.1 推荐 NONE）
 * ```
 * 每一问都要有**代码指针**（静态只读）+ **准入探针**（隔离库实测），
 * 并给出 `ANSWERED / PARTIALLY ANSWERED / BLOCKED` 的机器判定。
 *
 * ============================================================================
 *  硬边界（判据，不是注释）
 * ============================================================================
 *  · `isolateDatabase()` 一次性沙箱库（本文件顶部、任何数据库 import 之前）；
 *    **真实库从不被打开**（不取租约、不建连接、不迁移）。
 *  · 不调模型、**零出站**；纯本地读写沙箱（走规则抽取器，零 LLM）。
 *  · 计数型自检：每条测量都有非零分母（AGENTS §6.8）。
 *  · 静态检查只读源码文本；**不修改任何文件**。
 *  · 探针用**真实生产函数**（validator / applyMemoryEvent / appendDomainEvent /
 *    getProjection / originReadingOfEvent），不是复制品。
 *  · 探针**只读真实库之外的沙箱**；`artifacts/m10/` 只写本次 runId 目录。
 *
 * ============================================================================
 *  本脚本**不**替 WP1 做决定
 * ============================================================================
 * 它给的是读数与指针。`M10-D01…D20` 的冻结、字段/事件/状态机的最终形状、
 * 阈值与语料规模都留在 WP1（`M10-Unresolved-Decisions.md` 登记未决项）。
 */

import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m10-wp0-admission', { keep: false })

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { M10_MANIFEST_VERSION, createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'
import { M4_T0, createM4Harness, type M4Harness } from './m4-harness.ts'
import { sourceQualificationOf } from '../src/kernel/contracts/attribution.ts'
import { DIAGNOSTIC_SIGNAL } from '../src/kernel/contracts/domain-event.ts'
import type { AcceptedDomainEvent } from '../src/kernel/policies/validator.ts'
import { getConversationEvent } from '../src/infrastructure/persistence/conversation-store.ts'
import {
  applyAcceptedEvents,
  domainEventsFor,
  getProjection,
  insertProjection,
  listProjections,
} from '../src/infrastructure/persistence/event-store.ts'
import {
  originReadingOfEvent,
  qualificationsForMemories,
} from '../src/infrastructure/persistence/qualification-read.ts'
import type { CharacterProjection } from '../src/kernel/contracts/projection.ts'
import type { MemoryType } from '../src/kernel/contracts/memory.ts'

const REPO_ROOT = resolve(process.cwd())

/** Q6 规模探针的样本量：必须越过「第 1 / 第 51 / 最老」三档（计划 §14 G46）。 */
const GOAL_PROBE_COUNT = 60

/** 一条"上界形状"的目标正文（计划 §5.1：statement ≤500 字 / nextStep ≤300 字）。 */
const GOAL_STATEMENT_SAMPLE = '把一起完成论文提纲设为我们接下来的目标。'.repeat(20).slice(0, 480)
const GOAL_NEXT_STEP_SAMPLE = '下次继续时把第二章拆成三个步骤，并先确认第一章的材料是否已经齐了。'

// ---------------------------------------------------------------------------
// 量具：检查条目
// ---------------------------------------------------------------------------

interface Check {
  id: string
  question: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | 'Q6'
  label: string
  expected: string
  actual: string
  pass: boolean
  /**
   * **`true` = 这一行是"登记"，不是断言**（`L-M10-65`）。
   * ⚠️ 登记**不进** `passed/total`，只另报 `notes: N` —— 否则"N/N PASS"会把
   *    "什么都没断言的行"也算成"验证过的事"（`recordNote()` 记的就是这类）。
   */
  note: boolean
}

const checks: Check[] = []
function record(
  question: Check['question'],
  id: string,
  label: string,
  expected: string,
  actual: string,
  pass: boolean,
): void {
  checks.push({ id, question, label, expected, actual, pass, note: false })
}
/**
 * 记一条**登记**（如实报出一个读数，**不对它作断言**）—— `L-M10-65` 的修法。
 *
 * ⚠️ 它**没有 `pass` 参数**：调用点连"传个恒真的表达式"都做不到，
 *    所以"空量具混进断言计数"在这条路径上**是类型上不可能的**。
 * ⚠️ 读数仍**留在 `checks` 数组里**（不丢），只是**不进** `passed/total`。
 */
function recordNote(
  question: Check['question'],
  id: string,
  label: string,
  expected: string,
  actual: string,
): void {
  checks.push({ question, id, label, expected, actual, pass: true, note: true })
}

function readSrc(relPath: string): string {
  const abs = join(REPO_ROOT, relPath)
  return existsSync(abs) ? readFileSync(abs, 'utf8') : ''
}

/** 1-based 行号（静态指针的机器判据：指的文件里真有这一行）。 */
function lineOf(relPath: string, needle: string): number | null {
  const lines = readSrc(relPath).split(/\r?\n/)
  const index = lines.findIndex((line) => line.includes(needle))
  return index >= 0 ? index + 1 : null
}

function pointer(relPath: string, needle: string): string {
  const line = lineOf(relPath, needle)
  return `${relPath}:${line ?? '?'}`
}

function ptrExists(relPath: string, needle: string): boolean {
  return lineOf(relPath, needle) !== null
}

// ---------------------------------------------------------------------------
// Q1 —— 实际 Memory revision 从哪里读取
// ---------------------------------------------------------------------------

function staticQ1(): void {
  const contract = 'src/kernel/contracts/memory.ts'
  record(
    'Q1',
    'S1',
    '契约 `MemoryRecord.revision`（乐观锁版本，每成功应用一个领域事件 +1）在场',
    '字段在契约里',
    `${pointer(contract, 'revision: number')}`,
    ptrExists(contract, 'revision: number'),
  )

  const store = 'src/infrastructure/persistence/memory-store.ts'
  record(
    'Q1',
    'S2',
    '行 → 记录的读映射把 `revision` **读出来**（不是常量）',
    '`revision: Number(row.revision)`',
    pointer(store, 'revision: Number(row.revision)'),
    ptrExists(store, 'revision: Number(row.revision)'),
  )
  record(
    'Q1',
    'S3',
    '每次折叠把 revision **递增**（`current === null ? 1 : current.revision + 1`）',
    '递增行在场',
    pointer(store, 'current === null ? 1 : current.revision + 1'),
    ptrExists(store, 'current === null ? 1 : current.revision + 1'),
  )

  const fixture = 'src/kernel/app/recall/handoff-fixtures.ts'
  record(
    'Q1',
    'S4',
    '缺口在场：M9.5 交接 fixture 的 `referencesFromOutcome()` 把 `sourceRevision` **固定为 1**'
      + '（计划 §1.4 第 1 条；这是 fixture 事实，不代表生产引用有真版本）',
    '固定值在场（WP2 新建真实引用构造路径，不把 fixture 变生产权威）',
    pointer(fixture, 'sourceRevision: 1'),
    ptrExists(fixture, 'sourceRevision: 1'),
  )
  record(
    'Q1',
    'S5',
    '缺口在场：同一文件的 `recheckReferences()` **只调用**消费者传入的 `stillValid()`'
      + '（不自查库、不比版本 ⇒ 生产复核的 owner/subject/revision 必须由 M10 装配落实）',
    '回调式复核在场',
    pointer(fixture, 'recheck.stillValid(reference)'),
    ptrExists(fixture, 'recheck.stillValid(reference)'),
  )
}

async function probeQ1(h: M4Harness): Promise<void> {
  const ev = await h.recordUserEvidence('记住：我正在写一篇关于长期记忆的论文。')
  const created = await h.commitAndFold(
    h.makeCandidate(
      'person_fact',
      {
        kind: 'claim',
        subject: h.user,
        predicate: 'project.background.active',
        value: '长期记忆论文',
      },
      { sourceRefs: [ev.ref] },
    ),
    M4_T0 + 100,
  )
  if (created === null) throw new Error('Q1 探针：创建失败（非预期）')
  const afterCreate = await h.store.get(created.id as never)

  const ev2 = await h.recordUserEvidence('更正一下，论文方向改成持续角色 Agent 了。')
  const replacement = (await h.commitAndFold(
    h.makeCandidate(
      'person_fact',
      {
        kind: 'claim',
        subject: h.user,
        predicate: 'project.background.active',
        value: '持续角色 Agent',
      },
      { sourceRefs: [ev2.ref] },
    ),
    M4_T0 + 200,
  ))!
  await h.applyStateChange(
    'supersede',
    ev2.ref.id,
    {
      memoryId: created.id,
      supersededBy: replacement.id,
      validUntil: M4_T0 + 200,
      reason: '用户更正方向',
    },
    M4_T0 + 200,
  )
  const afterSupersede = await h.store.get(created.id as never)

  record(
    'Q1',
    'E1',
    '隔离实测：新建记录的 revision = 1；被取代后**同一条记录**的 revision = 2'
      + '（⇒ 真实 revision 按 ID 读得到，M9.5 fixture 的常量 1 只是 fixture 层事实）',
    'create 后 1 · supersede 后 2',
    `create=${String(afterCreate?.revision ?? '(读不到)')} · supersede=${String(afterSupersede?.revision ?? '(读不到)')} · status=${String(afterSupersede?.status ?? '(读不到)')}`,
    afterCreate?.revision === 1 && afterSupersede?.revision === 2,
  )
}

// ---------------------------------------------------------------------------
// Q2 —— Belief 资格如何复用
// ---------------------------------------------------------------------------

function staticQ2(): void {
  const eligibility = 'src/kernel/app/belief/eligibility.ts'
  record(
    'Q2',
    'S6',
    '复用口一：`recheckBeliefDependencies()` 按**确切 ID** 批量回查根/记忆，'
      + '异常 ⇒ 全体 `unavailable`（失败关闭，不当 valid、也不当不存在）',
    '批量回查 + 失败关闭在场',
    `${pointer(eligibility, 'export async function recheckBeliefDependencies')} · ${pointer(eligibility, "reason: 'unavailable'")}`,
    ptrExists(eligibility, 'export async function recheckBeliefDependencies') &&
      ptrExists(eligibility, "reason: 'unavailable'"),
  )
  record(
    'Q2',
    'S7',
    '复用口二：`applyInvalidationOverlay()` 同轮遮蔽（纯函数；写侧未收敛时读侧仍挡住）',
    '同轮 overlay 在场',
    pointer(eligibility, 'export function applyInvalidationOverlay'),
    ptrExists(eligibility, 'export function applyInvalidationOverlay'),
  )
  record(
    'Q2',
    'S8',
    '缺口在场：`listActiveBeliefs()` **只做 status 过滤**（读到 active ≠ 其 Memory/根证据此刻仍有效）'
      + '⇒ M10 必须叠加资格链，不能只调这个低层列表（计划 §1.4 第 3 条）',
    '只按 status 过滤（缺口确认）',
    pointer('src/infrastructure/persistence/belief-store.ts', "state.status !== 'active'"),
    ptrExists('src/infrastructure/persistence/belief-store.ts', "state.status !== 'active'"),
  )
  record(
    'Q2',
    'S9',
    '按 ID 的当前状态读法在场：`qualificationsForMemories()` + `originReadingOfEvent()`'
      + '（唯一适配边界 `processorEventViewOf` 的消费点；零新增 SQL）',
    '两个读取口都在',
    `${pointer('src/infrastructure/persistence/qualification-read.ts', 'export async function qualificationsForMemories')} · ${pointer('src/infrastructure/persistence/qualification-read.ts', 'export function originReadingOfEvent')}`,
    ptrExists('src/infrastructure/persistence/qualification-read.ts', 'export async function qualificationsForMemories') &&
      ptrExists('src/infrastructure/persistence/qualification-read.ts', 'export function originReadingOfEvent'),
  )
}

async function probeQ2(h: M4Harness): Promise<void> {
  const ev = await h.recordUserEvidence('记住，我最喜欢吃香菜。')
  const like = (await h.commitAndFold(
    h.makeCandidate(
      'preference',
      { kind: 'claim', subject: h.user, predicate: 'food.preference.cilantro', value: 'like' },
      { sourceRefs: [ev.ref] },
    ),
    M4_T0 + 300,
  ))!

  const before = await h.store.get(like.id as never)
  const beforeQual = await qualificationsForMemories(h.db, [
    { id: String(like.id), type: String(before!.type) as MemoryType },
  ])

  const evForget = await h.recordUserEvidence('忘掉我吃香菜偏好这件事。')
  await h.applyStateChange(
    'retract',
    evForget.ref.id,
    { memoryId: like.id, reason: 'explicit_forget', note: '用户要求忘掉' },
    M4_T0 + 400,
  )
  const after = await h.store.get(like.id as never)
  const afterQual = await qualificationsForMemories(h.db, [
    { id: String(like.id), type: String(before!.type) as MemoryType },
  ])
  const activeSlot = await h.store.getActiveByCanonicalKey(before!.canonicalKey as never)

  record(
    'Q2',
    'E2',
    '隔离实测：遗忘前按 ID 读到 active、资格 = ESTABLISHED；遗忘后按 ID 读到 retracted、'
      + '槽位 active 集清空 —— 这就是 M10 喂给 `recheckBeliefDependencies` 的 `EligibilityMemoryLookup` 的原料',
    '前 active/ESTABLISHED · 后 retracted/无 active',
    `前=${String(before?.status ?? '(读不到)')}/${String(beforeQual.get(String(like.id)) ?? '(无)')} · ` +
      `后=${String(after?.status ?? '(读不到)')}/${String(afterQual.get(String(like.id)) ?? '(无)')} · active槽位数=${String(activeSlot.length)}`,
    before?.status === 'active' &&
      beforeQual.get(String(like.id)) === 'ESTABLISHED' &&
      after?.status === 'retracted' &&
      activeSlot.length === 0,
  )
}

// ---------------------------------------------------------------------------
// Q3 —— Goal 操作的用户归因从哪里取得
// ---------------------------------------------------------------------------

function staticQ3(): void {
  const attribution = 'src/kernel/contracts/attribution.ts'
  record(
    'Q3',
    'S10',
    '受信归因构造口在场：`buildTrustedAttributionContext()` / `conversationAttributionEnvelopeOf()`'
      + '（调用方自报的 provenance 不算 —— DR-6）',
    '两个构造口都在',
    `${pointer(attribution, 'export function buildTrustedAttributionContext')} · ${pointer(attribution, 'export function conversationAttributionEnvelopeOf')}`,
    ptrExists(attribution, 'export function buildTrustedAttributionContext') &&
      ptrExists(attribution, 'export function conversationAttributionEnvelopeOf'),
  )
  record(
    'Q3',
    'S11',
    '资格**唯一**派生口在场：`sourceQualificationOf()`（规则版本 '
      + '`COGNITIVE_QUALIFICATION_RULE_VERSION`）；`qualificationEstablishesUserFact()` 只认 ESTABLISHED',
    '单一派生 + 单一判据',
    `${pointer(attribution, 'export function sourceQualificationOf')} · ${pointer(attribution, 'COGNITIVE_QUALIFICATION_RULE_VERSION = 1')} · ${pointer(attribution, 'export function qualificationEstablishesUserFact')}`,
    ptrExists(attribution, 'export function sourceQualificationOf') &&
      ptrExists(attribution, 'COGNITIVE_QUALIFICATION_RULE_VERSION = 1') &&
      ptrExists(attribution, 'export function qualificationEstablishesUserFact'),
  )
  record(
    'Q3',
    'S12',
    '读侧唯一适配边界在场：`processorEventViewOf()`（R-59：全 `src/**` 只有一处派生 `trustedOrigin`）',
    '唯一派生点在场',
    pointer('src/kernel/app/memory/extractor.ts', 'processorEventViewOf'),
    ptrExists('src/kernel/app/memory/extractor.ts', 'processorEventViewOf'),
  )
  record(
    'Q3',
    'S13',
    'TurnGateway 消费 `triggeringConversationEventOf`（动作归因的因果起点）',
    '导入点在 turn-gateway',
    pointer('src/kernel/app/turn-gateway.ts', 'triggeringConversationEventOf'),
    ptrExists('src/kernel/app/turn-gateway.ts', 'triggeringConversationEventOf'),
  )
}

async function probeQ3(h: M4Harness): Promise<void> {
  const ev = await h.recordUserEvidence('把一起完成论文提纲设为我们接下来的目标。')
  const event = await getConversationEvent(h.db, ev.event.id as never)
  const reading = event === undefined ? undefined : originReadingOfEvent(event)
  const qualification = sourceQualificationOf(reading)

  record(
    'Q3',
    'E3',
    '隔离实测：经真实入口写下的一条用户话语，从库里回读其受信归因 ⇒ 资格 = ESTABLISHED'
      + '（M10 的 Goal 操作归因取自**这一条**，不取自聊天文本或模型分类）',
    'ESTABLISHED',
    `attributionOrigin=${String(reading?.attributionOrigin ?? '(无)')} · axisBConfirmed=${String(reading?.axisBConfirmed ?? '(无)')} · qualification=${qualification}`,
    qualification === 'ESTABLISHED' && reading?.attributionOrigin === 'RECORDED',
  )

  // 反例：她的输出 = 来源已确立但**不是人** ⇒ 不能建立"关于用户个人的事实"
  record(
    'Q3',
    'S14',
    '反例面在场：assistant 通道由 `conversationAttributionForEntryMode()` 统一装配'
      + '（两个入口模式**都**装 `createCharacterAssistantTurnIngress()`；她的输出有信封但 '
      + 'contentOriginator ≠ USER）⇒ `sourceQualificationOf` 给 CONTRADICTED_ORIGIN、'
      + '`qualificationEstablishesUserFact` = false（M10 不得把她的输出当用户请求）',
    '反例通道装配点在 main.ts 与 runtime wiring',
    `${pointer('src/main.ts', 'conversationAttributionForEntryMode')} · ${pointer('src/infrastructure/runtime/conversation-attribution.ts', 'producers: Object.freeze([userIngress, createCharacterAssistantTurnIngress()])')}`,
    ptrExists('src/main.ts', 'conversationAttributionForEntryMode') &&
      ptrExists('src/infrastructure/runtime/conversation-attribution.ts', 'producers: Object.freeze([userIngress, createCharacterAssistantTurnIngress()])'),
  )
}

// ---------------------------------------------------------------------------
// Q4 —— 正式 assistant event 何时落盘
// ---------------------------------------------------------------------------

function staticQ4(): void {
  const gateway = 'src/kernel/app/turn-gateway.ts'
  record(
    'Q4',
    'S15',
    '落盘点：`completeTurn()` 内 `resolveWithEvent(intent)` 才真正写 assistant 事件'
      + '（干跑与无序号合成轮次**不写**）',
    '落盘点在场',
    `${pointer(gateway, 'async completeTurn(')} · ${pointer(gateway, 'resolver.resolveWithEvent(intent)')}`,
    ptrExists(gateway, 'async completeTurn(') && ptrExists(gateway, 'resolver.resolveWithEvent(intent)'),
  )
  record(
    'Q4',
    'S16',
    '落盘**门**：`shouldResolve = dryRun || assistantSequence !== undefined`'
      + '（没有序号 = 这一轮没真的发生 ⇒ 不落库）',
    '门在场',
    pointer(gateway, 'const shouldResolve = this.options.dryRun'),
    ptrExists(gateway, 'const shouldResolve = this.options.dryRun'),
  )
  record(
    'Q4',
    'S17',
    '崩溃窗口**如实存在**：落库失败**不吞**（继续抛），因此在"回复文本已生成、'
      + 'assistant 事件尚未提交"之间存在一个窗口 —— M10 不得在这段窗口里宣告承诺已兑现（WP6 负责恢复）',
    '不吞异常（窗口确认）',
    pointer(gateway, '落库失败**不吞**'),
    ptrExists(gateway, '落库失败**不吞**'),
  )
  record(
    'Q4',
    'S18',
    '结果形状带 `assistantEvent?`（可为 undefined ⇒ 调用方必须区分"落了/没落"）',
    '字段在场',
    pointer(gateway, 'assistantEvent?: ConversationEvent'),
    ptrExists(gateway, 'assistantEvent?: ConversationEvent'),
  )
}

function staticQ4Deferral(): void {
  recordNote(
    'Q4',
    'S19',
    '本轮**不**做可执行探针：完整一轮需要真实模型或一个可注入的 provider，'
      + '而 WP0 的硬边界是"零模型调用"。'
      + '⇒ 具名交接：Q4 的端到端探针（落盘成功 / 落盘失败两种形状）归 **WP6**，'
      + '本步只给代码指针与窗口判定，不假装已实测',
    '具名交接（不是"已验"）',
    'WP6: m10:completion:verify',
  )
}

// ---------------------------------------------------------------------------
// Q5 —— 哪些接口允许幂等兑现补记
// ---------------------------------------------------------------------------

function staticQ5(): void {
  const store = 'src/infrastructure/persistence/event-store.ts'
  record(
    'Q5',
    'S20',
    '域事件写入口自带幂等两层：**快路径按 idempotency_key 探测** + '
      + '`on conflict (idempotency_key) do nothing` + 失败回读',
    '两层 + 回读都在',
    `${pointer(store, 'findDomainEventByIdempotencyKey(db, accepted.idempotencyKey)')} · ${pointer(store, 'on conflict (idempotency_key) do nothing')}`,
    ptrExists(store, 'findDomainEventByIdempotencyKey(db, accepted.idempotencyKey)') &&
      ptrExists(store, 'on conflict (idempotency_key) do nothing'),
  )
  record(
    'Q5',
    'S21',
    '**幂等的最终裁判**表在场：`processed_operations` 的 PK = `idempotency_key`'
      + '（无 DomainEvent 的终态也走它 —— 兑现补记的落点）',
    'PK 唯一',
    pointer('src/infrastructure/persistence/migrations.ts', 'create table if not exists processed_operations'),
    ptrExists('src/infrastructure/persistence/migrations.ts', 'create table if not exists processed_operations') &&
      ptrExists('src/infrastructure/persistence/migrations.ts', 'idempotency_key text   primary key'),
  )
  record(
    'Q5',
    'S22',
    '通用投影写入是**乐观锁**（`expectedRevision` 不符即 `projection_revision_conflict`）'
      + '⇒ 迟到结果不会覆盖新状态',
    '乐观锁在场',
    pointer(store, 'projection_revision_conflict'),
    ptrExists(store, 'projection_revision_conflict'),
  )
}

async function probeQ5(h: M4Harness): Promise<void> {
  const characterId = h.kernel.characterId
  const countCreated = async (): Promise<number> =>
    (await domainEventsFor(h.db, characterId, { type: 'MEMORY_CREATED' })).length
  const countSignals = async (): Promise<number> =>
    (await domainEventsFor(h.db, characterId, { type: DIAGNOSTIC_SIGNAL })).length

  // -------------------------------------------------------------------------
  // E4a —— **直接**探 Q5 点名的接口：`applyAcceptedEvents` 的幂等补记
  // -------------------------------------------------------------------------
  // 形状与"依据同一条持久结果补记兑现事件"完全一致：同一条 accepted 事件、
  // 同一个幂等键，投递两次。第一次应当 created=1，第二次应当 created=0 且
  // deduplicated=1，且返回的是**同一条**已存在事件（没有第二次副作用）。
  const ev = await h.recordUserEvidence('记住：我下周要去做年度体检。')
  const accepted: AcceptedDomainEvent = {
    type: DIAGNOSTIC_SIGNAL,
    operation: 'fulfillment_backfill_probe',
    payload: { counterDelta: 1 },
    sourceConversationEventIds: [ev.event.id],
    idempotencyKey: 'm10-wp0-admission:fulfillment-backfill-probe',
    processor: 'm10-wp0-admission',
    processorVersion: 'm10-wp0-admission@1',
    scope: 'CHARACTER_INTERNAL',
  }
  const signalsBefore = await countSignals()
  const firstApply = await applyAcceptedEvents(h.db, characterId, [accepted], [], M4_T0 + 500)
  const signalsAfterFirst = await countSignals()
  const secondApply = await applyAcceptedEvents(h.db, characterId, [accepted], [], M4_T0 + 600)
  const signalsAfterSecond = await countSignals()
  const sameEventId =
    firstApply.domainEvents[0] !== undefined &&
    secondApply.domainEvents[0] !== undefined &&
    String(firstApply.domainEvents[0].id) === String(secondApply.domainEvents[0].id)

  record(
    'Q5',
    'E4a',
    '隔离实测（直接探点名的接口）：`applyAcceptedEvents` 同一 accepted 事件投递两次 ⇒ '
      + '第一次 created=1 / deduplicated=0，第二次 created=0 / deduplicated=1，'
      + '域事件总数只 +1，且第二次返回**同一条**已存在事件（可据此幂等补记，无第二次副作用）',
    'created 1→0 · deduplicated 0→1 · 事件数 +1 · 两侧 eventId 相同',
    `first.created=${String(firstApply.createdCount)}/dedup=${String(firstApply.deduplicatedCount)} · ` +
      `second.created=${String(secondApply.createdCount)}/dedup=${String(secondApply.deduplicatedCount)} · ` +
      `信号事件数 ${String(signalsBefore)}→${String(signalsAfterFirst)}→${String(signalsAfterSecond)} · 同 eventId=${String(sameEventId)}`,
    firstApply.createdCount === 1 &&
      firstApply.deduplicatedCount === 0 &&
      secondApply.createdCount === 0 &&
      secondApply.deduplicatedCount === 1 &&
      signalsAfterFirst === signalsBefore + 1 &&
      signalsAfterSecond === signalsAfterFirst &&
      sameEventId,
  )

  // -------------------------------------------------------------------------
  // E4b —— 走**完整放行口**的重复投递：如实记录是**哪一道闸**先把它挡住
  // -------------------------------------------------------------------------
  const candidate = h.makeCandidate(
    'person_fact',
    {
      kind: 'claim',
      subject: h.user,
      predicate: 'project.background.active',
      value: '年度体检安排',
    },
    { sourceRefs: [ev.ref] },
  )
  const createdBefore = await countCreated()
  const first = await h.tryCommit(candidate, M4_T0 + 500)
  const createdAfterFirst = await countCreated()
  const second = await h.tryCommit(candidate, M4_T0 + 500)
  const createdAfterSecond = await countCreated()

  // 反面对照：换证据区间 + 换内容 ⇒ 必须真的多 1 条（幂等 ≠ 吞掉一切）
  const ev2 = await h.recordUserEvidence('另外记一下：季度复盘安排在下个月。')
  const candidate2 = h.makeCandidate(
    'person_fact',
    {
      kind: 'claim',
      subject: h.user,
      predicate: 'project.background.active',
      value: '季度复盘安排',
    },
    { sourceRefs: [ev2.ref] },
  )
  const third = await h.tryCommit(candidate2, M4_T0 + 700)
  const createdAfterThird = await countCreated()

  record(
    'Q5',
    'E4b',
    '隔离实测（完整放行口）：同一提案在同一证据区间重复投递 ⇒ 第二次 accepted=0 且有具名拒绝码、'
      + 'MEMORY_CREATED 不增加；换证据区间 + 换内容 ⇒ 真的多 1 条。'
      + '⚠️ **如实读数**：本例的拒绝码是 `duplicate_content`（**内容去重闸**先于幂等键闸命中）'
      + '⇒ M10 的兑现补记**不能**依赖内容去重，必须自带确定性事件身份与幂等键（见 E4a）',
    '第一次 accepted=1 · 第二次 accepted=0 且有拒绝码 · 事件增量 +1 / +0 / +1',
    `first.accepted=${String(first.accepted)}/rejected=${first.rejected.join(',') || '无'} · ` +
      `second.accepted=${String(second.accepted)}/rejected=${second.rejected.join(',') || '无'} · ` +
      `third.accepted=${String(third.accepted)}/rejected=${third.rejected.join(',') || '无'} · ` +
      `事件增量 ${String(createdAfterFirst - createdBefore)}/${String(createdAfterSecond - createdAfterFirst)}/${String(createdAfterThird - createdAfterSecond)}`,
    first.accepted === 1 &&
      first.rejected.length === 0 &&
      second.accepted === 0 &&
      second.rejected.length > 0 &&
      createdAfterFirst - createdBefore === 1 &&
      createdAfterSecond - createdAfterFirst === 0 &&
      createdAfterThird - createdAfterSecond === 1,
  )
}

// ---------------------------------------------------------------------------
// Q6 —— 是否真的需要迁移
// ---------------------------------------------------------------------------

interface MigrationSnapshot {
  versions: { version: number; name: string }[]
  latestVersion: number
  contiguous: boolean
}

function migrationSnapshot(): MigrationSnapshot {
  const text = readSrc('src/infrastructure/persistence/migrations.ts')
  const versions: { version: number; name: string }[] = []
  const re = /version:\s*(\d+),\s*\n\s*name:\s*'([^']+)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    versions.push({ version: Number(m[1]), name: m[2] })
  }
  versions.sort((a, b) => a.version - b.version)
  const contiguous = versions.every((v, i) => v.version === i + 1)
  return {
    versions,
    latestVersion: versions.at(-1)?.version ?? 0,
    contiguous,
  }
}

function staticQ6(): void {
  const migrations = 'src/infrastructure/persistence/migrations.ts'
  const snapshot = migrationSnapshot()

  record(
    'Q6',
    'S23',
    `迁移清单 1..${String(snapshot.latestVersion)} 严格连续（只许往后追加；改既有 DDL 必须新写一条）`,
    '连续递增',
    `${snapshot.versions.map((v) => `${String(v.version)}:${v.name}`).join(' · ')}`,
    snapshot.contiguous && snapshot.latestVersion >= 9,
  )
  record(
    'Q6',
    'S24',
    '通用投影表的键就是作用域：PK `(character_id, projection_type)`，'
      + '两列都是 `text`（**无长度上限**）、state 是 `jsonb`（**无大小上限**）',
    'PK + 全 text + jsonb',
    `${pointer(migrations, 'primary key (character_id, projection_type)')} · ${pointer(migrations, 'projection_type          text    not null')}`,
    ptrExists(migrations, 'primary key (character_id, projection_type)') &&
      ptrExists(migrations, 'projection_type          text    not null'),
  )
  record(
    'Q6',
    'S25',
    '域事件表的 `type` / `idempotency_key` 同为 `text` + `idempotency_key` 唯一约束'
      + '（新事件族不需要 DDL）',
    '全 text + 唯一约束',
    `${pointer(migrations, 'idempotency_key             text    not null')} · ${pointer(migrations, 'constraint character_domain_events_idempotency_unique')}`,
    ptrExists(migrations, 'idempotency_key             text    not null') &&
      ptrExists(migrations, 'constraint character_domain_events_idempotency_unique'),
  )
  record(
    'Q6',
    'S26',
    '**先例**：M9 信念域零迁移 —— 一族多行、每对象一行 `belief:<beliefId>`，'
      + '`foldBeliefRows` 的 apply 与 rebuild 走同一条折叠核心 ⇒ M10 的目标域可照抄该形状',
    '零迁移先例在场',
    pointer('src/infrastructure/persistence/belief-store.ts', 'belief:<beliefId>'),
    ptrExists('src/infrastructure/persistence/belief-store.ts', 'belief:<beliefId>'),
  )
  record(
    'Q6',
    'S27',
    '先例的**代价面**也要登记：族读取是"列出本角色全部投影行 + 内存前缀过滤"'
      + '（`listBeliefRows` 就是这么做的）⇒ 目标数与历史规模上去后，'
      + '族读取成本随**全部**投影行增长。WP9 的规模门必须实测它，不能假定零成本',
    '族读取为前缀过滤（已登记）',
    pointer('src/infrastructure/persistence/belief-store.ts', "startsWith('belief:')"),
    ptrExists('src/infrastructure/persistence/belief-store.ts', "startsWith('belief:')"),
  )
}

interface GoalProbeReading {
  inserted: number
  byIdMs: { oldest: number; pos51: number; pos1: number }
  allReadable: boolean
  stateBytes: number
  familyRowsBefore: number
  familyRowsAfter: number
  familyListMsBefore: number
  familyListMsAfter: number
}

async function probeQ6(h: M4Harness): Promise<GoalProbeReading> {
  const characterId = h.kernel.characterId
  const t0Family = Date.now()
  const before = await listProjections(h.db, characterId)
  const familyListMsBefore = Date.now() - t0Family

  const ids: string[] = []
  let stateBytes = 0
  for (let i = 0; i < GOAL_PROBE_COUNT; i += 1) {
    const goalId = `goal-probe-${String(i + 1).padStart(3, '0')}`
    const state = {
      goalId,
      owner: { kind: 'character', id: String(characterId) },
      targetEntity: { kind: 'user', id: h.userId },
      origin: 'user_requested',
      statement: i === GOAL_PROBE_COUNT - 1 ? GOAL_STATEMENT_SAMPLE : `目标样本 ${String(i + 1)}`,
      successCriterion: { kind: 'user_report' },
      status: 'active',
      priority: 'normal',
      revision: 1,
      nextStep: i === GOAL_PROBE_COUNT - 1 ? GOAL_NEXT_STEP_SAMPLE : undefined,
      dependencies: [],
      commitment: null,
      createdAt: M4_T0 + 1000 + i,
    }
    const projection: CharacterProjection<unknown> = {
      characterId,
      projectionType: `goal:${goalId}`,
      revision: 1,
      reducerVersion: 'goal-fold@1',
      state,
      updatedAt: M4_T0 + 1000 + i,
    }
    await insertProjection(h.db, projection, M4_T0 + 1000 + i)
    if (i === GOAL_PROBE_COUNT - 1) {
      stateBytes = Buffer.byteLength(JSON.stringify(state), 'utf8')
    }
    ids.push(goalId)
  }

  const readTimed = async (goalId: string): Promise<{ found: boolean; ms: number }> => {
    const started = Date.now()
    const row = await getProjection(h.db, characterId, `goal:${goalId}`)
    return { found: row !== undefined, ms: Date.now() - started }
  }

  // 位置语义：pos1 = 最新（最后插入）· pos51 = 倒数第 51 个 · oldest = 第一个
  const pos1 = await readTimed(ids[GOAL_PROBE_COUNT - 1]!)
  const pos51 = await readTimed(ids[GOAL_PROBE_COUNT - 51]!)
  const oldest = await readTimed(ids[0]!)

  const t1Family = Date.now()
  const after = await listProjections(h.db, characterId)
  const familyListMsAfter = Date.now() - t1Family

  return {
    inserted: ids.length,
    byIdMs: { oldest: oldest.ms, pos51: pos51.ms, pos1: pos1.ms },
    allReadable: pos1.found && pos51.found && oldest.found,
    stateBytes,
    familyRowsBefore: before.length,
    familyRowsAfter: after.length,
    familyListMsBefore,
    familyListMsAfter,
  }
}

// ---------------------------------------------------------------------------
// 六问判定
// ---------------------------------------------------------------------------

interface Answer {
  question: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | 'Q6'
  ask: string
  answer: string
  pointers: string[]
  status: 'ANSWERED' | 'PARTIALLY ANSWERED' | 'BLOCKED'
}

function answers(probe: GoalProbeReading): Answer[] {
  const ok = (ids: string[]): boolean =>
    ids.every((id) => checks.find((c) => c.id === id)?.pass === true)

  const q1 = ok(['S1', 'S2', 'S3', 'E1'])
  const q1Gap = !checks.find((c) => c.id === 'S4')?.pass
  const q2 = ok(['S6', 'S7', 'S9', 'E2'])
  const q3 = ok(['S10', 'S11', 'S12', 'E3'])
  const q4 = ok(['S15', 'S16', 'S17', 'S18'])
  const q5 = ok(['S20', 'S21', 'S22', 'E4a', 'E4b'])
  const q6 = ok(['S23', 'S24', 'S25', 'S26']) && probe.allReadable

  return [
    {
      question: 'Q1',
      ask: '实际 Memory revision 从哪里读取？',
      answer:
        '按 ID 读 `MemoryRecord.revision`（memory-store 的行映射 + 每次折叠递增）。'
        + '契约字段、行映射、递增三处都已实测（E1：create=1 → supersede=2）。'
        + (q1Gap
          ? '⚠️ M9.5 交接 fixture 把 `sourceRevision` 写死为 1 —— 那是 fixture 层事实，'
            + '**WP2 必须新建真实引用构造路径**（从当前记录取 revision），保留原 fixture 的契约作用。'
          : ''),
      pointers: [
        pointer('src/kernel/contracts/memory.ts', 'revision: number'),
        pointer('src/infrastructure/persistence/memory-store.ts', 'revision: Number(row.revision)'),
        pointer('src/infrastructure/persistence/memory-store.ts', 'current === null ? 1 : current.revision + 1'),
        pointer('src/kernel/app/recall/handoff-fixtures.ts', 'sourceRevision: 1'),
      ],
      status: q1 ? 'ANSWERED' : 'BLOCKED',
    },
    {
      question: 'Q2',
      ask: 'Belief 资格如何复用？',
      answer:
        '复用 M9 的两层：`recheckBeliefDependencies()`（按确切 ID 批量回查 + 失败关闭）'
        + '与 `applyInvalidationOverlay()`（同轮遮蔽，纯函数）。原料由'
        + '`store.get(id)`（当前 status）+ `qualificationsForMemories()`（读时派生资格）供上，'
        + '零新增 SQL。**不得**只调 `listActiveBeliefs()`（它只按 status 过滤，E2 实测了遗忘前后两个读数）。',
      pointers: [
        pointer('src/kernel/app/belief/eligibility.ts', 'export async function recheckBeliefDependencies'),
        pointer('src/kernel/app/belief/eligibility.ts', 'export function applyInvalidationOverlay'),
        pointer('src/infrastructure/persistence/belief-store.ts', "state.status !== 'active'"),
        pointer('src/infrastructure/persistence/qualification-read.ts', 'export async function qualificationsForMemories'),
      ],
      status: q2 ? 'ANSWERED' : 'BLOCKED',
    },
    {
      question: 'Q3',
      ask: 'Goal 操作的用户归因从哪里取得？',
      answer:
        '取自**本轮那条已落库的用户对话事件**的受信归因：'
        + '`getConversationEvent()` → `originReadingOfEvent()`（唯一适配边界 R-59 的消费点）'
        + '→ `sourceQualificationOf()`。E3 实测该资格 = ESTABLISHED。'
        + '⇒ 归因**不**取自聊天文本、模型意图分类或记忆里的偏好（计划 §7.1 第 3 条）。',
      pointers: [
        pointer('src/kernel/contracts/attribution.ts', 'export function sourceQualificationOf'),
        pointer('src/infrastructure/persistence/qualification-read.ts', 'export function originReadingOfEvent'),
        pointer('src/kernel/app/turn-gateway.ts', 'triggeringConversationEventOf'),
        pointer('src/kernel/contracts/attribution.ts', 'export function qualificationEstablishesUserFact'),
      ],
      status: q3 ? 'ANSWERED' : 'BLOCKED',
    },
    {
      question: 'Q4',
      ask: '正式 assistant event 何时落盘？',
      answer:
        '在 `TurnGateway.completeTurn()` 内、`ConversationIntentResolver.resolveWithEvent(intent)`'
        + '返回时落盘；门是 `dryRun || assistantSequence !== undefined`。'
        + '落库失败**不吞**（继续抛）⇒「回复文本已生成、事件尚未提交」的崩溃窗口**真实存在**，'
        + 'M10 不得在该窗口内宣告承诺兑现。可执行端到端探针**具名交接给 WP6**（WP0 零模型调用）。',
      pointers: [
        pointer('src/kernel/app/turn-gateway.ts', 'async completeTurn('),
        pointer('src/kernel/app/turn-gateway.ts', 'resolver.resolveWithEvent(intent)'),
        pointer('src/kernel/app/turn-gateway.ts', 'const shouldResolve = this.options.dryRun'),
        pointer('src/kernel/app/turn-gateway.ts', 'assistantEvent?: ConversationEvent'),
      ],
      status: q4 ? 'ANSWERED' : 'BLOCKED',
    },
    {
      question: 'Q5',
      ask: '哪些接口允许幂等兑现补记？',
      answer:
        '两条：① `appendDomainEvent()` / `applyAcceptedEvents()`（快路径幂等探测 + '
        + '`on conflict (idempotency_key) do nothing` + 回读）把"依据同一条持久结果补记兑现事件"做成幂等；'
        + '② `processed_operations`（PK = idempotency_key）作为**没有 DomainEvent 的终态**的裁判。'
        + '投影侧另有乐观锁（`projection_revision_conflict`）保证迟到结果不覆盖新状态。'
        + 'E4a 直接实测了 ①：同一 accepted 事件投递两次 ⇒ created 1→0 / deduplicated 0→1、'
        + '事件总数只 +1、两侧返回同一个 eventId。'
        + '⚠️ E4b 的如实读数：走**完整放行口**的重复投递被 `duplicate_content`（内容去重闸）挡下 —— '
        + '即**不是**幂等键闸先命中 ⇒ 兑现补记不能依赖内容去重，必须自带确定性事件身份（E4a 证明这条路可用）。',
      pointers: [
        pointer('src/infrastructure/persistence/event-store.ts', 'findDomainEventByIdempotencyKey(db, accepted.idempotencyKey)'),
        pointer('src/infrastructure/persistence/event-store.ts', 'on conflict (idempotency_key) do nothing'),
        pointer('src/infrastructure/persistence/migrations.ts', 'create table if not exists processed_operations'),
        pointer('src/infrastructure/persistence/event-store.ts', 'projection_revision_conflict'),
      ],
      status: q5 ? 'ANSWERED' : 'BLOCKED',
    },
    {
      question: 'Q6',
      ask: '是否真的需要迁移？',
      answer:
        `**读数支持"迁移目标 NONE"**（与计划 §8.1 的推荐一致，但这是实测不是预设）：`
        + `通用投影表 PK = (character_id, projection_type)、全 text 无长度上限、state 为 jsonb；`
        + `域事件表同理；M9 信念域已有"每对象一行 + 零迁移"的先例。`
        + `本轮规模探针插入了 ${String(probe.inserted)} 条 \`goal:<id>\` 行并成功按 ID 读回第 1 / 第 51 / 最老三档`
        + `（实测单次按 ID 读取 ${String(probe.byIdMs.pos1)}/${String(probe.byIdMs.pos51)}/${String(probe.byIdMs.oldest)} ms；`
        + `上界形状的一条目标 state ≈ ${String(probe.stateBytes)} 字节）。`
        + `⚠️ **但有一条已登记的代价**：族读取（\`goal:%\`）在当前实现里是"列出本角色全部投影行 + 内存前缀过滤"`
        + `（${String(probe.familyRowsBefore)} → ${String(probe.familyRowsAfter)} 行，`
        + `${String(probe.familyListMsBefore)} → ${String(probe.familyListMsAfter)} ms）⇒ 随投影行总数线性增长。`
        + `WP3 可选"另加一条只含 goal 行的表"（= 迁移 0010，须另写 ADR），`
        + `WP9 的规模门必须把族读取成本实测出来，不得假定零成本。`,
      pointers: [
        pointer('src/infrastructure/persistence/migrations.ts', 'primary key (character_id, projection_type)'),
        pointer('src/infrastructure/persistence/migrations.ts', 'create table if not exists processed_operations'),
        pointer('src/infrastructure/persistence/belief-store.ts', "startsWith('belief:')"),
        pointer('src/infrastructure/persistence/event-store.ts', 'export async function listProjections'),
      ],
      status: q6 ? 'ANSWERED' : 'BLOCKED',
    },
  ]
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  staticQ1()
  staticQ2()
  staticQ3()
  staticQ4()
  staticQ4Deferral()
  staticQ5()
  staticQ6()

  const h = await createM4Harness({ label: 'm10-wp0-admission' })
  let goalProbe: GoalProbeReading
  try {
    await probeQ1(h)
    await probeQ2(h)
    await probeQ3(h)
    await probeQ5(h)
    goalProbe = await probeQ6(h)
  } finally {
    await h.stop()
  }

  // 探针自身的空跑自检（AGENTS §6.8：0 检查 0 失败 = INVALID，不是 PASS）
  record(
    'Q6',
    'E5',
    `规模探针分母自检：插入 ${String(goalProbe.inserted)} 条 goal 投影行、三档按 ID 全部读回`,
    `${String(GOAL_PROBE_COUNT)} 条 / 3 档可读`,
    `inserted=${String(goalProbe.inserted)} · pos1=${String(goalProbe.byIdMs.pos1)}ms · pos51=${String(goalProbe.byIdMs.pos51)}ms · oldest=${String(goalProbe.byIdMs.oldest)}ms · stateBytes=${String(goalProbe.stateBytes)}`,
    goalProbe.inserted === GOAL_PROBE_COUNT && goalProbe.allReadable && goalProbe.stateBytes > 0,
  )

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM10RunId({ wpId: 'wp0-admission', headShort: head })
  const dir = openM10RunDir(REPO_ROOT, runId)

  const answerList = answers(goalProbe)
  /*
   * ⚠️ **分母只算断言**（`L-M10-65`）：登记（`recordNote`）不进 `passed/total`，
   *    只另报 `notes: N` —— 否则"N/N PASS"会把"什么都没断言的行"也算成"验证过的事"。
   */
  const assertions = checks.filter((c) => !c.note)
  const notes = checks.length - assertions.length
  const passed = assertions.filter((c) => c.pass).length
  const failed = assertions.length - passed
  const blocked = answerList.filter((a) => a.status === 'BLOCKED').length

  const payload = {
    schema: 'm10-wp0-admission@1',
    manifestVersion: M10_MANIFEST_VERSION,
    runId,
    head,
    goalProbeCount: GOAL_PROBE_COUNT,
    goalProbe,
    checks,
    answers: answerList,
    summary: {
      total: assertions.length,
      passed,
      failed,
      /** **登记**条数（不进 `total/passed`）—— `L-M10-65` */
      notes,
      blockedQuestions: blocked,
      verdict:
        failed === 0 && blocked === 0
          ? 'ADMISSION PASS（六问均有代码指针与实测读数；Q4 的端到端探针具名交接 WP6）'
          : failed === 0
            ? 'ADMISSION PARTIAL（有具名未答项）'
            : 'ADMISSION FAIL',
    },
  }
  writeFileSync(join(dir, 'admission.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp0',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'admission',
    counts: { total: assertions.length, passed, failed, notes },
    phases: ['single'],
    supersedes: null,
    notes: 'M10 计划 §12 WP0「必须回答」六问的代码指针 + 隔离库实测；真实库从未被打开',
    databaseScope: 'isolated',
    mode: 'offline',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} [${c.question}] ${c.label}`)
    console.log(`      期望 ${c.expected} · 实测 ${c.actual}`)
  }
  console.log('--- 六问判定 ---')
  for (const a of answerList) {
    console.log(`${a.question}（${a.status}）${a.ask}`)
    console.log(`   ${a.answer}`)
  }
  console.log(
      `verdict: ${payload.summary.verdict}（断言 ${String(passed)}/${String(assertions.length)}` +
        `${notes > 0 ? ` · 登记 ${String(notes)} 条` : ''}）`,
    )
  process.exitCode = failed === 0 ? 0 : 1
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
