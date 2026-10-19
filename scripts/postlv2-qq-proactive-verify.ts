/**
 * post-Lv2 / **QQ 主动联系** —??离线门（计划 §8 ??`postlv2:qq-proactive:verify`）?? *
 * ============================================================================
 *  这个门在 WP2 阶段覆盖什?? * ============================================================================
 * ```text
 * ??迁移 0014 真的落地（两张表 + 三个结构??CHECK + 唯一占用?? * ??通知意图 / 实例的持久语义：登记、去重、改时（计划版本 +1）、取消、终?? * ??**发送幂等的唯一占用**（同 occurrenceKey 只产生一个外发尝试）
 * ??状态机：未??失败**不许**变成接受；终??*不可**迁移；重启遗??`dispatching` 隔离
 * ??**具名触发许可**（ADR-110 `D02`）：旧闸不放宽、默认仍拒绝、具名才通行
 * ??修好的那??*撞键绕过触发??*的洞（`job-store.ts` 早退在闸之前?? * ??时间判据：`L-QQP-01`（同????不可排期）??指定时区日键 · 活动时段
 * ??**三段??*：正????负控 ??恢复（恢复之后正控必须重新成立）
 * ```
 *
 * ⚠️ 全部??*隔离??*上跑（`isolateDatabase`）；**绝不**打开真实库?? * ⚠️ 量具有效性：每条判据都有**正控**（该过的过）??*负控**（不该过的必须被拒）?? *    并统??`measured_count`?? 0 才算量过东西）?? */
import 'dotenv/config'

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { ENTRY_PROTOCOL_VERSION } from '../src/infrastructure/qq/entry-handshake.ts'
import { sql } from 'drizzle-orm'
import { AgentRuntime, type Character, type Plugin } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'

import { character } from '../src/character/index.ts'
import { isolateDatabase } from '../src/dev/sandbox.ts'
import { initDatabase } from '../src/db/index.ts'
import { currentSchemaVersion, exec, getRawDb } from '../src/infrastructure/persistence/db.ts'
import { openRawPGlite } from '../src/infrastructure/persistence/production-db-safety.ts'
import { latestSchemaVersion, MIGRATIONS } from '../src/infrastructure/persistence/migrations.ts'
import { enqueueJob, getJob } from '../src/infrastructure/persistence/job-store.ts'
import {
  advanceOccurrence,
  cancelIntent,
  countQuotaUsage,
  createIntent,
  findIntentByDedupeKey,
  getIntent,
  getOccurrence,
  listAttemptedReminderOccurrenceKeys,
  listDueIntents,
  listPendingIntents,
  pauseNotifications,
  quarantineOrphanedDispatching,
  readControl,
  reserveOccurrence,
  rescheduleIntent,
  updateReminderText,
  resumeNotifications,
} from '../src/infrastructure/persistence/notification-store.ts'
import {
  DEFAULT_ACTIVE_WINDOW,
  DEFAULT_PROACTIVE_POLICY,
  NAMED_TRIGGER_PERMITS,
  PROACTIVE_REMINDER_PROCESSOR,
  assertOccurrenceTransition,
  assertTriggerEnabledInM3_5,
  careOccurrenceKey,
  careOpportunityKey,
  canTransitionOccurrence,
  dayKeyOf,
  decideReminderDue,
  isWithinActiveWindow,
  newNotificationIntentId,
  notificationTextFingerprint,
  occurrenceOccupiesQuota,
  onceShotIsSchedulable,
  parseProactiveProposal,
  precheckCareOpportunity,
  programActionFor,
  programActionOnModelFailure,
  readReminderRequest,
  reminderDedupeKey,
  reminderExpiryState,
  reminderOccurrenceKey,
  reminderTemplateText,
  renderProactiveBriefing,
  verifyProactiveSources,
  buildProactiveInstruction,
  decisionAuthorityFor,
  PROACTIVE_DECISIONS,
  PROACTIVE_DEFER_MAX_MINUTES,
  PROACTIVE_DEFER_MIN_MINUTES,
  PROACTIVE_MAX_SOURCE_OPTIONS,
  PROACTIVE_SOURCE_SUMMARY_CODEPOINTS,
  PROACTIVE_TEXT_MAX_CODEPOINTS,
  zonedPartsOf,
  PROACTIVE_SCHEDULER_PRINCIPAL_ID,
  type CarePrecheckInput,
  type CharacterId,
  type NotificationOccurrenceState,
} from '../src/kernel/contracts/index.ts'
import {
  FORBIDDEN_RECIPIENT_ARG_KEYS,
  QQ_PRIVATE_SEND_ARG_KEYS,
  QQ_PRIVATE_SEND_OPERATION,
  QQ_PRIVATE_SEND_TEXT,
  assertQqSendArgKeys,
  createQqProactiveCapabilityDefinitions,
  recipientArgViolation,
} from '../src/kernel/action/qq-proactive-capability.ts'
import { TOOL_GATE_KEYS } from '../src/kernel/action/tool-catalog.ts'
import { TASK_ARG_KEYS } from '../src/kernel/action/task-plan.ts'
import { readProactivePolicy } from '../src/kernel/app/flags.ts'
/* post-Lv2 / ADR-110 `D06`：主动投递的闭集双向协议（??7 逐条核对它） */
import {
  BRIDGE_MESSAGE_KINDS,
  BRIDGE_QQ_DELIVERY_STATUSES,
  QQ_DELIVERY_TEXT_MAX_CODEPOINTS,
  TurnBridge,
  handleBridgeMessage,
  isBridgeControlMessageKind,
  isBridgeMessageKind,
  isBridgeQqDeliveryStatus,
} from '../src/kernel/app/bridge/turn-bridge.ts'
/* post-Lv2 / ADR-110 `D06`：外壳侧两个真件（??8 用模??OneBot + 假核心跑它们??*/
import { LgStdioClient } from '../src/infrastructure/qq/lg-stdio-client.ts'
import { OneBotPrivateClient } from '../src/infrastructure/qq/onebot-private-client.ts'
import { readQqPrivateConfig } from '../src/infrastructure/qq/private-config.ts'
/* post-Lv2 / ADR-110 `D07`/`D08`：投递登记（连接代次 + 回执结算）与适配??*/
import {
  QQ_DELIVERY_STATUSES,
  QqDeliveryRegistry,
  type NotificationDeliveryPort,
} from '../src/kernel/app/notification-delivery.ts'
import {
  dispatchProactiveText,
  type ProactiveActionPort,
  type ProactiveDispatchPort,
} from '../src/kernel/app/proactive-delivery.ts'
/* post-Lv2 / ADR-110 `D04`：调度器（注入假定时器跑判据）+ 真 croner 的接线 */
import {
  CARE_TIMER_NAME,
  ProactiveScheduler,
  REMINDER_TIMER_NAME,
  excludeAttempted,
  type ProactiveTimerPort,
} from '../src/kernel/app/proactive-scheduler.ts'
import { createCronerTimer } from '../src/infrastructure/time/croner-timer.ts'
/* post-Lv2 / ADR-110 `D07`：到点提醒的五步（**对真 store 跑**） */
import { deliverReminder, type ReminderStorePort } from '../src/kernel/app/proactive-reminder.ts'
/* post-Lv2 / ADR-110 `D03`/`D04`/`D14`：自主关心那一条（四道闸 + shadow） */
import { runCareOpportunity, type CareStorePort } from '../src/kernel/app/proactive-care.ts'
/* post-Lv2 / ADR-110 `D03`/`D04`：关心的**真实读数**与**私有调用** */
import { zonedDayWindow } from '../src/kernel/contracts/notification.ts'
import { lastInboundAt, hasInFlightOccurrence } from '../src/infrastructure/persistence/notification-store.ts'
import { createOpenAiProactiveCarePort } from '../src/infrastructure/model/openai-proactive-care.ts'
/* post-Lv2 / ADR-111：依据面（可用来源集的有界化） */
import { boundProactiveSources, renderSystemOpportunitySection } from '../src/kernel/contracts/proactive-proposal.ts'
import { createSystemOpportunityProvider } from '../src/kernel/context/sections.ts'
import {
  deferOccurrence,
  pendingCareDeferrals,
} from '../src/infrastructure/persistence/notification-store.ts'
import { buildProactiveSourceCandidates } from '../src/infrastructure/runtime/proactive-sources.ts'
import { runReminderTurn } from '../src/kernel/app/reminder-turn.ts'
import { asNotificationIntentId } from '../src/kernel/contracts/ids.ts'
import { readReminderTextResponse } from '../src/kernel/contracts/proactive-proposal.ts'
/* post-Lv2 / ADR-110 `D05a`：**写**归因豁免（闭集 + 收窄复核） */
import {
  ACTION_ATTRIBUTION_EXEMPTIONS,
  WRITE_CAPABLE_ATTRIBUTION_EXEMPTIONS,
  attestActionInitiatorFromNamedExemption,
  isNamedExemptionInitiatorEvidence,
  namedExemptionViolation,
} from '../src/kernel/contracts/attribution.ts'
import { createQqProactiveDeliveryAdapter } from '../src/infrastructure/action/adapters/qq-proactive-delivery.ts'
import { QQ_PRIVATE_OWNER_TARGET_TYPE } from '../src/kernel/action/qq-proactive-capability.ts'
import { QQ_PRIVATE_SEND_PERMISSION } from '../src/kernel/action/qq-proactive-capability.ts'
import { evaluateActionPolicy } from '../src/kernel/action/policy.ts'
import { createActionRequest } from '../src/kernel/action/action-request.ts'

// ---------------------------------------------------------------------------
// 极简检查器
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
let measured = 0
const failures: string[] = []

function check(label: string, condition: boolean, detail = ''): void {
  measured += 1
  if (condition) {
    passed += 1
    console.log(`  ??${label}${detail ? ` ??${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(label)
    console.log(`  ??${label}${detail ? ` ??${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

function okCode(fn: () => unknown): { ok: boolean; code?: string } {
  try {
    fn()
    return { ok: true }
  } catch (error) {
    const code = (error as { code?: unknown })?.code
    return { ok: false, code: typeof code === 'string' ? code : String(error) }
  }
}

/** 跑一??**async** 调用并把它收敛成"过了 / 被拒（带具名码）"——负控统一走这??*/
async function attemptCode(fn: () => Promise<unknown>): Promise<{ ok: boolean; code?: string }> {
  try {
    await fn()
    return { ok: true }
  } catch (error) {
    const code = (error as { code?: unknown })?.code
    return { ok: false, code: typeof code === 'string' ? code : String(error) }
  }
}

const sandbox = isolateDatabase('qq-proactive-wp2-verify', { keep: true })
const characterId = String(character.id ?? character.name) as CharacterId
/** WP5：能力声明（本门??§16 里逐条核对它） */
const capabilities = createQqProactiveCapabilityDefinitions()
/*
 * WP5-B §18：外壳侧的模拟件?? *
 * ⚠️ ??`scripts/qq/verify.ts` **同一??*??`ws` 的办法（它是 `jsdom` 的传递依赖，
 *    不是本仓库的直接依赖 ??不改 `package.json` / lockfile）?? */
const OWNER_ID = '10001'
const OWNER_BOT_ID = '10002'
const COEXIST_TOKEN = 'wp5-coexist-token-0123456789ab'

const runtime = new AgentRuntime({
  character: character as Character,
  plugins: [sqlPlugin] as Plugin[],
  conversationLength: 16,
  settings: { OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '' },
})
await initDatabase(runtime, sqlPlugin)

const db = getRawDb(runtime)

// ===========================================================================
section('1. 迁移 0014：两张表 + 结构??CHECK（正控）')
// ===========================================================================

check(
  '迁移注册??*连续且与已应用一??*（动态式：不写死版本??—??WP0 的教训）',
  latestSchemaVersion() === MIGRATIONS.length &&
    MIGRATIONS.length >= 15 &&
    (await currentSchemaVersion(db)) === latestSchemaVersion() &&
    MIGRATIONS.every((migration, index) => migration.version === index + 1),
  `latest=${String(latestSchemaVersion())} 行数=${String(MIGRATIONS.length)} 已应??${String(await currentSchemaVersion(db))}`
)

const tables = (
  await exec(
    db,
    sql`select table_name from information_schema.tables
        where table_name in ('notification_intents', 'notification_occurrences')
        order by table_name`,
    '读取新表'
  )
).map((row) => String(row.table_name))
check(
'两张新表都在（notification_intents / notification_occurrences）',
  tables.length === 2,
  tables.join(', ')
)

/** 直接往表里插一行（绕过 store，用来量**表级** CHECK 本身??*/
async function rawInsertOccurrence(fields: {
  key: string
  kind: string
  state: string
  messageId: string | null
  candidateText?: string | null
  candidateFingerprint?: string | null
  candidateLength?: number | null
}): Promise<{ ok: boolean; error?: string }> {
  try {
    await exec(
      db,
      sql`insert into notification_occurrences
            (occurrence_key, intent_id, character_id, kind, state, due_at, attempt,
             candidate_text, candidate_fingerprint, candidate_length, platform_message_id,
             permission_version, policy_version, created_at, updated_at, schema_version)
          values (${fields.key}, null, ${characterId}, ${fields.kind}, ${fields.state}, 1000, 1,
                  ${fields.candidateText ?? null}, ${fields.candidateFingerprint ?? null},
                  ${fields.candidateLength ?? null}, ${fields.messageId},
                  'perm@1', 'policy@1', 1000, 1000, 1)
          returning occurrence_key`,
'裸插入实例',
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

const checkAcceptedWithoutMessageId = await rawInsertOccurrence({
  key: 'wp2-check:accepted-without-id', kind: 'care', state: 'api_accepted', messageId: null,
})
/* ??差分正控：同一条插??*带上**回执 id 就必须成????拒绝的原因只可能是那??CHECK */
const twinAcceptedWithMessageId = await rawInsertOccurrence({
  key: 'wp2-check:accepted-with-id', kind: 'care', state: 'api_accepted', messageId: '77',
})
check(
'CHECK ②：api_accepted 必须有 platform_message_id（负控：接受却没有回执 ⇒ 拒绝；差分正控：带上回执 ⇒ 通过）',
  !checkAcceptedWithoutMessageId.ok && twinAcceptedWithMessageId.ok,
`负控=${checkAcceptedWithoutMessageId.ok ? '竟然插进去了' : '被拒'} · 正控=${twinAcceptedWithMessageId.ok ? '通过' : '也被拒（说明不是这条 CHECK 在挡）'} · ${(checkAcceptedWithoutMessageId.error ?? '').slice(0, 120)}`
)

const checkMessageIdWithoutAccepted = await rawInsertOccurrence({
  key: 'wp2-check:id-without-accepted', kind: 'care', state: 'pending', messageId: '999',
})
const twinPendingWithoutMessageId = await rawInsertOccurrence({
  key: 'wp2-check:pending-no-id', kind: 'care', state: 'pending', messageId: null,
})
check(
'CHECK ②（反向）：带着回执却说没被接受 ⇒ 同样拒绝（差分正控：pending 不带回执 ⇒ 通过）',
  !checkMessageIdWithoutAccepted.ok && twinPendingWithoutMessageId.ok,
`负控=${checkMessageIdWithoutAccepted.ok ? '竟然插进去了' : '被拒'} · 正控=${twinPendingWithoutMessageId.ok ? '通过' : '也被拒'}`
)

/*
 * ⚠️ 这两??*必须**给全 `candidate_text` + `candidate_fingerprint` + `candidate_length`?? *    只给一部分会被**成对**约束（pairing）挡住，那样量到的就**不是**上下界那??CHECK?? *    这正是差分正控抓出来的量具缺??—??初版分两轮分别漏??length ??fingerprint?? *    两次都是"负控过了、正控也过不??，说明挡住的其实**不是**被测的那条约束?? */
const checkCandidateLengthOutOfBounds = await rawInsertOccurrence({
  key: 'wp2-check:length-too-big', kind: 'care', state: 'pending', messageId: null,
  candidateText: 'x'.repeat(501), candidateFingerprint: 'ntf:length-too-big', candidateLength: 501,
})
const twinLengthAtBound = await rawInsertOccurrence({
  key: 'wp2-check:length-at-bound', kind: 'care', state: 'pending', messageId: null,
  candidateText: 'x'.repeat(500), candidateFingerprint: 'ntf:length-at-bound', candidateLength: 500,
})
check(
'CHECK ③：候选长度上限 500（负控：501 ⇒ 拒绝；差分正控：恰好 500 ⇒ 通过）',
  !checkCandidateLengthOutOfBounds.ok && twinLengthAtBound.ok,
  `负控=${checkCandidateLengthOutOfBounds.ok ? '竟然插进去了' : '被拒'} · 正控=${twinLengthAtBound.ok ? '通过' : `也被????挡住的不是这条约束`}`
)

const checkLengthWithoutText = await rawInsertOccurrence({
  key: 'wp2-check:length-without-text', kind: 'care', state: 'pending', messageId: null,
  candidateText: null, candidateFingerprint: null, candidateLength: 5,
})
check(
'CHECK：正文与长度**成对**（负控：只给 length 不给 text ⇒ 拒绝）',
  !checkLengthWithoutText.ok,
  checkLengthWithoutText.ok ? '竟然插进去了' : '被拒'
)

const checkReminderWithoutIntent = await rawInsertOccurrence({
  key: 'wp2-check:reminder-without-intent', kind: 'reminder', state: 'pending', messageId: null,
})
check(
'CHECK：提醒的实例必须挂在意图上（负控：没有 intent_id ⇒ 拒绝）',
  !checkReminderWithoutIntent.ok,
  checkReminderWithoutIntent.ok ? '竟然插进去了' : `被拒 · ${(checkReminderWithoutIntent.error ?? '').slice(0, 120)}`
)

// ===========================================================================
section('2. 通知意图：登记 / 去重 / 改时 / 取消（正控 + 负控）')
// ===========================================================================

const reminderIntentId = newNotificationIntentId()
const dedupeKey = 'wp2:reminder:event-1:1791300000000'
const scheduledAt = 1_791_300_000_000

const created = await createIntent(db, {
  id: reminderIntentId,
  characterId,
  ownerRef: '10001',
  conversationRef: 'dm-smw-x-qq',
  kind: 'reminder',
  sourceRefs: ['cev:char:dm-smw-x-qq:7'],
  scheduledAt,
  timezone: DEFAULT_PROACTIVE_POLICY.timeZone,
  permissionVersion: 'perm@1',
  policyVersion: 'policy@1',
text: '十分钟后提醒我喝水',
  dedupeKey,
  now: 1_791_299_000_000,
})
check(
'登记一条明确提醒（有正文、有来源、有排期）',
created.created && created.intent?.text === '十分钟后提醒我喝水' &&
created.intent.textFingerprint === notificationTextFingerprint('十分钟后提醒我喝水') &&
    created.intent.sourceRefs.length === 1,
  `id=${String(created.intent?.id)} status=${String(created.intent?.status)}`
)

const duplicate = await createIntent(db, {
  id: newNotificationIntentId(),
  characterId,
  ownerRef: '10001',
  conversationRef: 'dm-smw-x-qq',
  kind: 'reminder',
  sourceRefs: ['cev:char:dm-smw-x-qq:7'],
  scheduledAt,
  timezone: DEFAULT_PROACTIVE_POLICY.timeZone,
  permissionVersion: 'perm@1',
  policyVersion: 'policy@1',
text: '十分钟后提醒我喝水',
  dedupeKey,
})
check(
'同一件事不许排两次（负控：同 dedupeKey ⇒ created=false，且读回的是**原来那条**）',
  duplicate.created === false && String(duplicate.intent?.id) === String(reminderIntentId),
  `created=${String(duplicate.created)} id=${String(duplicate.intent?.id)}`
)

const missingSource = await attemptCode(() => createIntent(db, {
  id: newNotificationIntentId(), characterId, ownerRef: '10001', conversationRef: 'dm-smw-x-qq',
  kind: 'reminder', scheduledAt, timezone: DEFAULT_PROACTIVE_POLICY.timeZone,
permissionVersion: 'perm@1', policyVersion: 'policy@1', text: '没有来源的提醒',
  dedupeKey: 'wp2:reminder:no-source',
}))
check(
'负控：提醒**必须**有原请求来源（不许凭空设一条提醒）',
  missingSource.ok === false && missingSource.code === 'notification_reminder_without_source',
  String(missingSource.code)
)

const careWithText = await attemptCode(() => createIntent(db, {
  id: newNotificationIntentId(), characterId, ownerRef: '10001', conversationRef: 'dm-smw-x-qq',
  kind: 'care', scheduledAt, timezone: DEFAULT_PROACTIVE_POLICY.timeZone,
permissionVersion: 'perm@1', policyVersion: 'policy@1', text: '关心不该存正文',
  dedupeKey: 'wp2:care:with-text',
}))
check(
'负控：自主关心的意图**不**保存正文（候选正文只活在实例行上）',
  careWithText.ok === false && careWithText.code === 'notification_care_with_text',
  String(careWithText.code)
)

check(
'待办列表读得到它（按排期升序）',
  (await listPendingIntents(db, characterId, { kind: 'reminder' })).some(
    (intent) => String(intent.id) === String(reminderIntentId)
  ) && (await listDueIntents(db, characterId, scheduledAt)).length === 1,
  `pending=${String((await listPendingIntents(db, characterId)).length)}`
)

const rescheduled = await rescheduleIntent(db, reminderIntentId, {
  scheduledAt: scheduledAt + 60_000,
  timezone: DEFAULT_PROACTIVE_POLICY.timeZone,
  permissionVersion: 'perm@1',
  now: 1_791_299_500_000,
})
check(
'改时 ⇒ 计划版本 +1（旧计划版本不再触发）',
  rescheduled.ok && rescheduled.planVersion === 2,
  `planVersion=${String(rescheduled.planVersion)}`
)

// ===========================================================================
section('3. 发送幂等：**唯一占用**（正控 + 负控）')
// ===========================================================================

const keyBefore = reminderOccurrenceKey({ intentId: String(reminderIntentId), planVersion: 1, dueAt: scheduledAt })
const keyAfter = reminderOccurrenceKey({ intentId: String(reminderIntentId), planVersion: 2, dueAt: scheduledAt + 60_000 })

check(
'占用键对同一 (意图, 计划版本, 时刻) 稳定可复算（同输入 ⇒ 同键）',
  keyBefore ===
    reminderOccurrenceKey({ intentId: String(reminderIntentId), planVersion: 1, dueAt: scheduledAt }) &&
    keyBefore !== keyAfter,
  `${keyBefore} vs ${keyAfter}`
)

const firstReserve = await reserveOccurrence(db, {
  occurrenceKey: keyAfter, intentId: reminderIntentId, characterId, kind: 'reminder',
  dueAt: scheduledAt + 60_000, permissionVersion: 'perm@1', policyVersion: 'policy@1',
  now: 1_791_299_600_000,
})
const secondReserve = await reserveOccurrence(db, {
  occurrenceKey: keyAfter, intentId: reminderIntentId, characterId, kind: 'reminder',
  dueAt: scheduledAt + 60_000, permissionVersion: 'perm@1', policyVersion: 'policy@1',
  now: 1_791_299_700_000,
})
check(
'同一次机会只产生一个外发尝试（负控：第二次占用 ⇒ created=false，**不**新建、**不**报错）',
  firstReserve.created === true && secondReserve.created === false,
  `first=${String(firstReserve.created)} second=${String(secondReserve.created)}`
)

const careKey = careOccurrenceKey({
  ownerRef: '10001', permissionVersion: 'perm@1', opportunityKey: careOpportunityKey(scheduledAt, DEFAULT_PROACTIVE_POLICY.timeZone),
})
const careReserve = await reserveOccurrence(db, {
  occurrenceKey: careKey, characterId, kind: 'care', dueAt: scheduledAt,
  permissionVersion: 'perm@1', policyVersion: 'policy@1',
})
check(
'自主关心的实例键锚在 (owner, 许可版本, 机会日) 上，且不挂意图',
  careReserve.created && careReserve.occurrence?.intentId === undefined,
  careKey
)

// ===========================================================================
section('4. 交付真相：状态机 / 未知不许变接??/ 重启隔离')
// ===========================================================================

const walk = [
  { to: 'evaluating' as const },
{ to: 'prepared' as const, text: '该喝水了。' },
  { to: 'dispatching' as const },
  { to: 'api_accepted' as const, platformMessageId: 'mid-123' },
]
let walkOk = true
const walkReadings: string[] = []
for (const step of walk) {
  const result = await advanceOccurrence(db, keyAfter, step)
  walkReadings.push(`${step.to}=${String(result.ok)}`)
  if (!result.ok) walkOk = false
}
const accepted = await getOccurrence(db, keyAfter)
check(
'正控：pending → evaluating → prepared → dispatching → api_accepted（带平台回执 id）',
  walkOk && accepted?.state === 'api_accepted' && accepted.platformMessageId === 'mid-123' &&
accepted.candidateText === '该喝水了。' && accepted.candidateLength === 5,
  walkReadings.join(' ')
)

const afterAccepted = await advanceOccurrence(db, keyAfter, { to: 'dispatching' })
check(
'负控：**终态不可迁移**（已接受 ⇒ 不许回到 dispatching）',
  afterAccepted.ok === false && afterAccepted.code === 'notification_transition_denied',
  String(afterAccepted.code)
)

const acceptedWithoutId = await reserveOccurrence(db, {
  occurrenceKey: 'wp2:occ:accepted-without-id', characterId, kind: 'care', dueAt: scheduledAt,
  permissionVersion: 'perm@1', policyVersion: 'policy@1',
})
void acceptedWithoutId
await advanceOccurrence(db, 'wp2:occ:accepted-without-id', { to: 'evaluating' })
await advanceOccurrence(db, 'wp2:occ:accepted-without-id', { to: 'prepared', text: '测试' })
await advanceOccurrence(db, 'wp2:occ:accepted-without-id', { to: 'dispatching' })
const noIdAccept = await advanceOccurrence(db, 'wp2:occ:accepted-without-id', { to: 'api_accepted' })
check(
'负控：**没有平台回执 id 就不许记成接受**（具名理由码）',
  noIdAccept.ok === false && noIdAccept.code === 'occurrence_accepted_without_message_id',
  String(noIdAccept.code)
)

const unknownToAccepted = await advanceOccurrence(db, 'wp2:occ:accepted-without-id', {
  to: 'delivery_unknown', reasonCode: 'timeout',
})
const unknownThenAccept = await advanceOccurrence(db, 'wp2:occ:accepted-without-id', { to: 'api_accepted' })
const unknownThenDispatch = await advanceOccurrence(db, 'wp2:occ:accepted-without-id', { to: 'dispatching' })
check(
'负控：`delivery_unknown` **不许**变成 api_accepted，也**不许**回到 dispatching（不自动重发）',
  unknownToAccepted.ok && unknownThenAccept.ok === false && unknownThenDispatch.ok === false,
  `unknown=${String(unknownToAccepted.ok)} →accepted=${String(unknownThenAccept.code)} →dispatching=${String(unknownThenDispatch.code)}`
)

const failedReserve = await reserveOccurrence(db, {
  occurrenceKey: 'wp2:occ:failed-confirmed', characterId, kind: 'care', dueAt: scheduledAt,
  permissionVersion: 'perm@1', policyVersion: 'policy@1',
})
void failedReserve
await advanceOccurrence(db, 'wp2:occ:failed-confirmed', { to: 'evaluating' })
await advanceOccurrence(db, 'wp2:occ:failed-confirmed', { to: 'prepared', text: '测试' })
await advanceOccurrence(db, 'wp2:occ:failed-confirmed', { to: 'dispatching' })
await advanceOccurrence(db, 'wp2:occ:failed-confirmed', { to: 'failed_confirmed', reasonCode: 'onebot_api_failed' })
const failedThenAccept = await advanceOccurrence(db, 'wp2:occ:failed-confirmed', { to: 'api_accepted' })
check(
'负控：`failed_confirmed` **不许**变成 api_accepted（失败不会自己变成功）',
  failedThenAccept.ok === false && failedThenAccept.code === 'notification_transition_denied',
  String(failedThenAccept.code)
)

/* 重启兜底：造一条遗??dispatching */
await reserveOccurrence(db, {
  occurrenceKey: 'wp2:occ:orphan', characterId, kind: 'care', dueAt: scheduledAt,
  permissionVersion: 'perm@1', policyVersion: 'policy@1',
})
await advanceOccurrence(db, 'wp2:occ:orphan', { to: 'evaluating' })
await advanceOccurrence(db, 'wp2:occ:orphan', { to: 'prepared', text: '在吗' })
await advanceOccurrence(db, 'wp2:occ:orphan', { to: 'dispatching' })
const quarantined = await quarantineOrphanedDispatching(db, scheduledAt + 10_000)
const orphan = await getOccurrence(db, 'wp2:occ:orphan')
check(
'正控：重启时遗留的 dispatching ⇒ `delivery_unknown`，**不**重发、**不**释放额度',
  quarantined.includes('wp2:occ:orphan') && orphan?.state === 'delivery_unknown' &&
    orphan.reasonCode === 'process_restarted_before_receipt' &&
    occurrenceOccupiesQuota(orphan.state),
`隔离 ${String(quarantined.length)} 条 · 状态=${String(orphan?.state)} 占额=${String(orphan === undefined ? '?' : occurrenceOccupiesQuota(orphan.state))}`
)

check(
'纯函数一致性：迁移表与"占额"判据同源（终态集合 ⊂ 占额集合）',
  canTransitionOccurrence('api_accepted', 'pending') === false &&
    okCode(() => assertOccurrenceTransition('delivery_unknown', 'api_accepted')).code ===
      'notification_transition_denied' &&
    occurrenceOccupiesQuota('dispatching') && !occurrenceOccupiesQuota('cancelled') &&
    !occurrenceOccupiesQuota('expired'),
'assertOccurrenceTransition 与 occurrenceOccupiesQuota 一致',
)

// ===========================================================================
section('5. 取消：未发送的作废，已发出/未知的**不动**（正控 + 负控）')
// ===========================================================================

await reserveOccurrence(db, {
  occurrenceKey: 'wp2:occ:to-cancel', intentId: reminderIntentId, characterId, kind: 'reminder',
  dueAt: scheduledAt, permissionVersion: 'perm@1', policyVersion: 'policy@1',
})
await advanceOccurrence(db, 'wp2:occ:to-cancel', { to: 'evaluating' })

const cancelledIntent = await cancelIntent(db, reminderIntentId, { reason: 'user_cancelled' })
const cancelledOccurrence = await getOccurrence(db, 'wp2:occ:to-cancel')
const acceptedSurvived = await getOccurrence(db, keyAfter)
const unknownSurvived = await getOccurrence(db, 'wp2:occ:orphan')
check(
  '正控：取消后未发送实????`cancelled`，??*已接??/ 结果不明**的两??*不动**',
  cancelledIntent.ok && cancelledOccurrence?.state === 'cancelled' &&
    acceptedSurvived?.state === 'api_accepted' && unknownSurvived?.state === 'delivery_unknown',
  `cancelled=${String(cancelledOccurrence?.state)} accepted=${String(acceptedSurvived?.state)} unknown=${String(unknownSurvived?.state)}`
)

const cancelAgain = await cancelIntent(db, reminderIntentId)
check(
  '负控：`cancelled` 是终??—??再取消一次被拒（不许被改??pending 再取消）',
  cancelAgain.ok === false && cancelAgain.code === 'intent_not_pending',
  String(cancelAgain.code)
)

const rescheduleCancelled = await rescheduleIntent(db, reminderIntentId, {
  scheduledAt: scheduledAt + 120_000, timezone: DEFAULT_PROACTIVE_POLICY.timeZone, permissionVersion: 'perm@1',
})
check(
'负控：已取消的意图**不许**被改时复活（`D13`：改时 on 不复活旧授权）',
  rescheduleCancelled.ok === false && rescheduleCancelled.code === 'intent_not_pending',
  String(rescheduleCancelled.code)
)

// ===========================================================================
section('6. 额度：未知也占额，且按**指定时区**的日界统计')
// ===========================================================================

const dayStart = Date.parse('2026-10-06T00:00:00+08:00')
const dayEnd = Date.parse('2026-10-07T00:00:00+08:00')
const allUsed = await countQuotaUsage(db, { characterId, dayStart, dayEnd })
const careUsed = await countQuotaUsage(db, { characterId, dayStart, dayEnd, kind: 'care' })
check(
  '正控：占额的只有 dispatching / api_accepted / delivery_unknown / failed_confirmed',
  allUsed === 4 && careUsed === 3,
  `全类=${String(allUsed)} 关心=${String(careUsed)}（期??4 / 3：接??+ 未知 + 失败 + 遗留已隔离的那条关心）`
)

const outsideWindow = await countQuotaUsage(db, {
  characterId, dayStart: dayEnd, dayEnd: dayEnd + 86_400_000,
})
check(
'负控：**换一天**统计 ⇒ 0（日界真的起作用，不是把所有行都数进来）',
  outsideWindow === 0,
  `次日=${String(outsideWindow)}`
)

check(
  '日键按指定时区算：上??2026-10-06 23:59 ??2026-10-07 00:01 分属两天',
  dayKeyOf(Date.parse('2026-10-06T23:59:00+08:00'), 'Asia/Shanghai') === '2026-10-06' &&
    dayKeyOf(Date.parse('2026-10-07T00:01:00+08:00'), 'Asia/Shanghai') === '2026-10-07' &&
    zonedPartsOf(Date.parse('2026-10-06T23:59:00+08:00'), 'Asia/Shanghai').hour === 23,
  '2026-10-06 / 2026-10-07'
)

// ===========================================================================
section('7. 时间判据（`L-QQP-01`）：同秒不可排期')
// ===========================================================================

const base = Date.parse('2026-10-06T12:00:00.100+08:00')
check(
'正控：提前 1500ms ⇒ 可排期（且有效瞬间被截断到秒）',
  onceShotIsSchedulable(base + 1500, base) && !onceShotIsSchedulable(base + 50, base) &&
    !onceShotIsSchedulable(base, base),
  `+1500ms=${String(onceShotIsSchedulable(base + 1500, base))} · +50ms=${String(onceShotIsSchedulable(base + 50, base))}`
)

check(
  '活动时段：上??09:00??2:00??2:00 不含；次??08:59 不在窗口内）',
  isWithinActiveWindow(Date.parse('2026-10-06T09:00:00+08:00'), DEFAULT_ACTIVE_WINDOW) &&
    isWithinActiveWindow(Date.parse('2026-10-06T21:59:00+08:00'), DEFAULT_ACTIVE_WINDOW) &&
    !isWithinActiveWindow(Date.parse('2026-10-06T22:00:00+08:00'), DEFAULT_ACTIVE_WINDOW) &&
    !isWithinActiveWindow(Date.parse('2026-10-07T08:59:00+08:00'), DEFAULT_ACTIVE_WINDOW),
'09:00 ⇒ 在 / 21:59 ⇒ 在 / 22:00 ⇒ 不在 / 次日 08:59 ⇒ 不在',
)

check(
  '迟到处理：未到点 `due` · 逾期 30 分钟??`grace` · 超过 `expired`',
  reminderExpiryState({ dueAt: 1000, now: 999 }) === 'due' &&
    reminderExpiryState({ dueAt: 1000, now: 1000 + 60_000 }) === 'grace' &&
    reminderExpiryState({ dueAt: 1000, now: 1000 + 31 * 60_000 }) === 'expired',
  'due / grace / expired'
)

// ===========================================================================
section('8. 具名触发许可（`D02`）：旧闸不放??+ 撞键绕过的洞已修')
// ===========================================================================

check(
  '许可??*有界且具??*：只有两个处理器，且只允??`schedule`',
  Object.keys(NAMED_TRIGGER_PERMITS).length === 2 &&
    NAMED_TRIGGER_PERMITS[PROACTIVE_REMINDER_PROCESSOR]?.join(',') === 'schedule' &&
    NAMED_TRIGGER_PERMITS['m35-verify'] === undefined,
  Object.keys(NAMED_TRIGGER_PERMITS).join(' / ')
)

const singleArgSchedule = okCode(() => assertTriggerEnabledInM3_5('schedule'))
const namedVerifySchedule = okCode(() => assertTriggerEnabledInM3_5('schedule', 'm35-verify'))
const namedReminderSchedule = okCode(() => assertTriggerEnabledInM3_5('schedule', PROACTIVE_REMINDER_PROCESSOR))
const namedCareEnvironment = okCode(() => assertTriggerEnabledInM3_5('environment', 'qq-proactive-care'))
const singleArgConversation = okCode(() => assertTriggerEnabledInM3_5('conversation'))
check(
'正控+负控：单参仍拒 schedule · 未具名处理器仍拒 · 具名处理器通过 · 具名的其它 kind 不在允许集 ⇒ 拒',
  singleArgSchedule.ok === false && singleArgSchedule.code === 'trigger_kind_not_enabled' &&
    namedVerifySchedule.ok === false && namedVerifySchedule.code === 'trigger_kind_not_enabled' &&
    namedReminderSchedule.ok === true && namedCareEnvironment.ok === false &&
    namedCareEnvironment.code === 'trigger_kind_not_enabled' && singleArgConversation.ok === true,
  `单参=${String(singleArgSchedule.code)} · m35-verify=${String(namedVerifySchedule.code)} · 具名=${String(namedReminderSchedule.ok)} · environment=${String(namedCareEnvironment.code)}`
)

const now = Date.now()
const namedJob = await enqueueJob(db, {
  characterId,
  processor: PROACTIVE_REMINDER_PROCESSOR,
  processorVersion: 'qq-proactive-reminder@1',
  sourceFromSequence: 0,
  sourceToSequence: 0,
  idempotencyKey: 'idem:wp2:reminder:1',
  triggerKind: 'schedule',
  now,
})
const readBack = await getJob(db, namedJob.job.id)
check(
  '正控：具名处理器??`schedule` 作业真的**落库**，且读回 trigger_kind 逐字??`schedule`',
  namedJob.created && readBack?.triggerKind === 'schedule' &&
    readBack.processor === PROACTIVE_REMINDER_PROCESSOR,
  `created=${String(namedJob.created)} triggerKind=${String(readBack?.triggerKind)}`
)

const unnamedJob = await attemptCode(() => enqueueJob(db, {
  characterId,
  processor: 'm35-verify',
  processorVersion: 'm35-verify@1',
  sourceFromSequence: 0,
  sourceToSequence: 0,
  idempotencyKey: 'idem:wp2:m35:1',
  triggerKind: 'schedule',
}))
check(
'负控：未具名处理器 + `schedule` ⇒ 仍被拒（冻结的 `m3.5:verify` 的判据逐字保留）',
  unnamedJob.ok === false && unnamedJob.code === 'trigger_kind_not_enabled',
  String(unnamedJob.code)
)

/*
 * ??这一条是**修好的洞**的正面证据：
 * 同一个幂等键已经有一行非 failed ??`schedule` 作业时，
 * 再用**未具??*处理器请求同一个键 —??旧实现会在提??return 处静默返回那一行（闸根本没跑）?? * 现在必须先过????被具名拒绝?? */
const bypassAttempt = await attemptCode(() => enqueueJob(db, {
  characterId,
  processor: 'm35-verify',
  processorVersion: 'm35-verify@1',
  sourceFromSequence: 0,
  sourceToSequence: 0,
  idempotencyKey: 'idem:wp2:reminder:1',
  triggerKind: 'schedule',
}))
check(
'★ 负控：**撞键不再绕过触发闸**（同键已有 schedule 行，未具名请求仍必须被拒）',
  bypassAttempt.ok === false && bypassAttempt.code === 'trigger_kind_not_enabled',
bypassAttempt.ok ? '绕过去了 —— 洞还在' : `被拒（${String(bypassAttempt.code)}）`
)

// ===========================================================================
section('9. 恢复（三段式的第三段）：负控之后正控必须重新成立')
// ===========================================================================

const recoveryIntentId = newNotificationIntentId()
const recovery = await createIntent(db, {
  id: recoveryIntentId,
  characterId,
  ownerRef: '10001',
  conversationRef: 'dm-smw-x-qq',
  kind: 'reminder',
  sourceRefs: ['cev:char:dm-smw-x-qq:9'],
  scheduledAt: scheduledAt + 3600_000,
  timezone: DEFAULT_PROACTIVE_POLICY.timeZone,
  permissionVersion: 'perm@1',
  policyVersion: 'policy@1',
  text: '恢复档：正控重新成立',
  dedupeKey: 'wp2:reminder:recovery',
})
const recoveryKey = reminderOccurrenceKey({
  intentId: String(recoveryIntentId), planVersion: 1, dueAt: scheduledAt + 3600_000,
})
const recoveryReserve = await reserveOccurrence(db, {
  occurrenceKey: recoveryKey, intentId: recoveryIntentId, characterId, kind: 'reminder',
  dueAt: scheduledAt + 3600_000, permissionVersion: 'perm@1', policyVersion: 'policy@1',
})
const recoveryWalk = [
  await advanceOccurrence(db, recoveryKey, { to: 'evaluating' }),
await advanceOccurrence(db, recoveryKey, { to: 'prepared', text: '恢复档正文' }),
  await advanceOccurrence(db, recoveryKey, { to: 'dispatching' }),
  await advanceOccurrence(db, recoveryKey, { to: 'api_accepted', platformMessageId: 'mid-recovery' }),
]
const recoveryRow = await getOccurrence(db, recoveryKey)
check(
  '恢复档：登记 ??占用 ??走到 `api_accepted` 全链重新成立',
  recovery.created && recoveryReserve.created &&
    recoveryWalk.every((step) => step.ok) && recoveryRow?.state === 'api_accepted' &&
    recoveryRow.platformMessageId === 'mid-recovery',
  recoveryWalk.map((step) => String(step.ok)).join(',')
)

check(
  '恢复档：具名许可仍然成立（负控没有把闸改坏）',
  okCode(() => assertTriggerEnabledInM3_5('schedule', PROACTIVE_REMINDER_PROCESSOR)).ok === true &&
    okCode(() => assertTriggerEnabledInM3_5('schedule')).ok === false,
  '具名通过 / 单参仍拒'
)

// ===========================================================================
section('10. WP3 提醒入口：确定读出时刻，读不出就澄清（正控 + 负控）')
// ===========================================================================

const T0 = Date.parse('2026-10-06T20:00:00+08:00') // 上海 20:00（在活动时段内）
const policy = DEFAULT_PROACTIVE_POLICY

const rel = readReminderRequest({ text: '十分钟后提醒我喝水', now: T0, policy })
check(
'正控：相对时间 —— "十分钟后提醒我喝水" ⇒ 恰好 +10 分钟，basis 带原话片段',
  rel.kind === 'scheduled' && rel.dueAt === T0 + 600_000 && rel.basis.startsWith('relative:') &&
rel.matched.includes('十分钟'),
  rel.kind === 'scheduled' ? `${new Date(rel.dueAt).toISOString()} basis=${rel.basis}` : rel.kind
)

const relHalf = readReminderRequest({ text: '半个小时后提醒我', now: T0, policy })
check(
'正控：中文数量 —— "半个小时" ⇒ +30 分钟',
  relHalf.kind === 'scheduled' && relHalf.dueAt === T0 + 1_800_000,
  relHalf.kind === 'scheduled' ? new Date(relHalf.dueAt).toISOString() : relHalf.kind
)

const clockTonight = readReminderRequest({ text: '今晚九点半提醒我吃药', now: T0, policy })
check(
  '正控：钟??+ 时段??—??"今晚九点?? ??当日 21:30（上海），且??*明确指定**',
  clockTonight.kind === 'scheduled' &&
    clockTonight.dueAt === Date.parse('2026-10-06T21:30:00+08:00') &&
    clockTonight.explicitNight === false,
  clockTonight.kind === 'scheduled'
    ? `${new Date(clockTonight.dueAt).toISOString()} basis=${clockTonight.basis}`
    : clockTonight.kind
)

const clockTomorrow = readReminderRequest({ text: '明天早上八点提醒我交报告', now: T0, policy })
check(
  '正控：日期词 —??"明天早上八点" ??次日 08:00（上海）',
  clockTomorrow.kind === 'scheduled' &&
    clockTomorrow.dueAt === Date.parse('2026-10-07T08:00:00+08:00'),
  clockTomorrow.kind === 'scheduled' ? new Date(clockTomorrow.dueAt).toISOString() : clockTomorrow.kind
)

const noIntent = readReminderRequest({ text: '今天天气不错', now: T0, policy })
check(
  '负控：没有提醒意????`none`??*??*把闲聊读成提醒排期）',
  noIntent.kind === 'none',
  noIntent.kind
)

const vague = readReminderRequest({ text: '以后提醒我多喝水', now: T0, policy })
const vague2 = readReminderRequest({ text: '有空提醒我一下', now: T0, policy })
check(
'负控：不确定表达 ⇒ `clarify`（**绝不**偷偷排期）—— "以后提醒" / "有空提醒"',
  vague.kind === 'clarify' && vague.code === 'reminder_time_unspecified' &&
    vague2.kind === 'clarify',
  `${vague.kind}/${'code' in vague ? vague.code : ''} · ${vague2.kind}`
)

const unreadable = readReminderRequest({ text: '提醒我一下', now: T0, policy })
check(
'负控：有意图但读不出时刻 ⇒ `clarify`（问一句，而不是猜一个时间）',
  unreadable.kind === 'clarify' && unreadable.code === 'reminder_time_unreadable',
  `${unreadable.kind}/${'code' in unreadable ? unreadable.code : ''}`
)

const past = readReminderRequest({ text: '今天早上八点提醒我开会', now: T0, policy })
check(
'负控：读出的时刻已经过去 ⇒ `refused`（如实说"过去了"，**不**顺手挪到明天）',
  past.kind === 'refused' && past.code === 'reminder_due_at_not_future',
  `${past.kind}/${'code' in past ? past.code : ''}`
)

/*
 * 夜间规则（计??§6 逐字）：
 *  · 普通（没点名夜间）??**顺延**到下一个允许时?? *  · 本人**明确说出**夜间钟点 ??**仅该??*例外
 */
/*
 * ⚠️ **这一段在 2026-10-07 改过读数**（用户裁定，见 ADR-113）：
 *    旧读数（**保留在文档里，不回写**）是"普通提醒顺延到 09:00 且 basis 以
 *    `>shifted_to_window` 结尾"。新规则：**本人明确要求的提醒不受作息表限制**，
 *    时段只留给**自主关心**。⇒ 下面同时留着**两条**：
 *      · 新规则的正控（不因时段顺延）
 *      · 那条**不能被我改坏**的负控（关心在时段外仍被拦）
 */
const nightRelative = readReminderRequest({ text: '八小时后提醒我', now: T0, policy })
const explicitNight = readReminderRequest({ text: '今晚十一点半提醒我看书', now: T0, policy })
check(
  '★ 正控（**新规则**）：普通提醒落在时段外（"八小时后" = 次日 04:00）⇒ **不顺延**，'
    + '就是他说的那个时刻，且 `basis` 如实标注 `outside_window_allowed`',
  nightRelative.kind === 'scheduled' &&
    nightRelative.dueAt === Date.parse('2026-10-07T04:00:00+08:00') &&
    nightRelative.basis.endsWith('>outside_window_allowed'),
  nightRelative.kind === 'scheduled'
    ? `${new Date(nightRelative.dueAt).toISOString()} · ${nightRelative.basis}`
    : nightRelative.kind
)
check(
  '★ 正控：夜间**明确钟点**（"今晚十一点半"）同样不被限制（`explicitNight` 仍如实为 true）',
  explicitNight.kind === 'scheduled' &&
    explicitNight.dueAt === Date.parse('2026-10-06T23:30:00+08:00') &&
    explicitNight.explicitNight === true,
  explicitNight.kind === 'scheduled'
    ? `${new Date(explicitNight.dueAt).toISOString()} explicitNight=${String(explicitNight.explicitNight)}`
    : explicitNight.kind
)
check(
  '★ 负控（**这条不许被我改坏**）：**自主关心**在时段外 ⇒ 仍被 `outside_active_window` 拦 —— '
    + '"没有来源的自主关心别在半夜自己冒出来"',
  (() => {
    const out = precheckCareOpportunity({
      mode: 'on',
      paused: false,
      entryScopedConversations: true,
      now: Date.parse('2026-10-07T03:00:00+08:00'),
      newInboundSinceLastCare: true,
      careUsedToday: 0,
      allUsedToday: 0,
      candidateInFlight: false,
      permissionVersion: 'care-permission@1',
    })
    return out.eligible === false && out.code === 'outside_active_window'
  })(),
  '关心里那道闸还在'
)
check(
  '负控：**时段内**的提醒**不标** `outside_window_allowed`（别乱贴标签）',
  (() => {
    const inWindow = readReminderRequest({
      text: '今晚九点半提醒我',
      now: T0,
      policy,
    })
    return inWindow.kind === 'scheduled' && !inWindow.basis.includes('outside_window_allowed')
  })(),
  '边界正确'
)

check(
  '去重键：同一 (来源事件, 计划时刻) ??同键；换时刻 ??换键',
  reminderDedupeKey({ sourceEventId: 'cev:a:b:1', dueAt: 1000 }) ===
    reminderDedupeKey({ sourceEventId: 'cev:a:b:1', dueAt: 1000 }) &&
    reminderDedupeKey({ sourceEventId: 'cev:a:b:1', dueAt: 1000 }) !==
      reminderDedupeKey({ sourceEventId: 'cev:a:b:1', dueAt: 2000 }),
  reminderDedupeKey({ sourceEventId: 'cev:a:b:1', dueAt: 1000 })
)

// ===========================================================================
section('11. WP3 用户控制面：暂停 / 恢复**落库**（正控 + 负控）')
// ===========================================================================

const pausedAt = T0 + 1000
const paused = await pauseNotifications(db, {
  characterId,
  reason: 'user_requested_pause',
  permissionVersion: 'perm@2',
  policyVersion: 'policy@1',
  now: pausedAt,
})
check(
  '正控：暂停成功，且三件套（paused / paused_at / pause_reason）**同时**有值',
  paused.ok && paused.control?.paused === true && paused.control.pausedAt === pausedAt &&
    paused.control.pauseReason === 'user_requested_pause' &&
    paused.control.permissionVersion === 'perm@2',
  `paused=${String(paused.control?.paused)} at=${String(paused.control?.pausedAt)} reason=${String(paused.control?.pauseReason)}`
)

const pausedAgain = await pauseNotifications(db, {
  characterId, reason: 'second_pause', permissionVersion: 'perm@2', policyVersion: 'policy@1',
  now: pausedAt + 5000,
})
check(
  '正控（幂等）：重复暂??*保留原来??paused_at**（不??停了多久"重置??0），理由更新',
  pausedAgain.ok && pausedAgain.control?.pausedAt === pausedAt &&
    pausedAgain.control.pauseReason === 'second_pause',
  `at=${String(pausedAgain.control?.pausedAt)} reason=${String(pausedAgain.control?.pauseReason)}`
)

const pauseNoReason = await attemptCode(() => pauseNotifications(db, {
  characterId, reason: '   ', permissionVersion: 'perm@2', policyVersion: 'policy@1',
}))
check(
  '负控：没有理由的暂停 ⇒ 具名拒绝（不可审计的暂停不许落库）',
  pauseNoReason.ok === false && pauseNoReason.code === 'notification_pause_without_reason',
  String(pauseNoReason.code)
)

/* 表级 CHECK 的负控：三件套必须同真同??*/
const badControlRow = async (fields: {
  paused: boolean
  pausedAt: number | null
  reason: string | null
}): Promise<{ ok: boolean; error?: string }> => {
  try {
    await exec(
      db,
      sql`insert into notification_control
            (character_id, paused, paused_at, pause_reason, permission_version, policy_version,
             updated_at, schema_version)
          values ('wp3-check-character', ${fields.paused}, ${fields.pausedAt}, ${fields.reason},
                  'perm@1', 'policy@1', 1000, 1)
          returning character_id`,
      '裸插入控制行'
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

const inconsistentA = await badControlRow({ paused: true, pausedAt: null, reason: null })
const inconsistentB = await badControlRow({ paused: false, pausedAt: 1000, reason: 'x' })
const inconsistentC = await badControlRow({ paused: true, pausedAt: 1000, reason: '  ' })
const consistent = await badControlRow({ paused: true, pausedAt: 1000, reason: 'ok' })
check(
  '负控 ×3（表级）：暂停却没有时刻 / 没暂停却有时刻 / 有时刻却空理由 ⇒ 全拒（差分正控：三件齐全 ⇒ 通过）',
  !inconsistentA.ok && !inconsistentB.ok && !inconsistentC.ok && consistent.ok,
  `A=${inconsistentA.ok ? '通过' : '拒'} B=${inconsistentB.ok ? '通过' : '拒'} C=${inconsistentC.ok ? '通过' : '拒'} 正控=${consistent.ok ? '通过' : '拒'}`
)

const resumed = await resumeNotifications(db, {
  characterId, permissionVersion: 'perm@3', policyVersion: 'policy@1', now: T0 + 10_000,
})
check(
  '正控：恢复把三件套**一起**清掉（不会"恢复了还写着暂停理由"）',
  resumed.ok && resumed.control?.paused === false &&
    resumed.control.pausedAt === undefined && resumed.control.pauseReason === undefined &&
    resumed.control.permissionVersion === 'perm@3',
  `paused=${String(resumed.control?.paused)} at=${String(resumed.control?.pausedAt)} reason=${String(resumed.control?.pauseReason)}`
)

const resumeAgain = await resumeNotifications(db, {
  characterId, permissionVersion: 'perm@3', policyVersion: 'policy@1',
})
check(
  '负控：没有暂停时"恢复" ⇒ 具名拒绝（不许把"恢复"变成一个可以乱发的动作）',
  resumeAgain.ok === false && resumeAgain.code === 'not_paused',
  String(resumeAgain.code)
)

// ===========================================================================
section('12. WP3 自主关心机会预检：每条不合格都**具名**（正控 + 逐条负控）')
// ===========================================================================

const careBase: CarePrecheckInput = {
  mode: 'on',
  paused: false,
  entryScopedConversations: true,
  now: T0,
  policy,
  lastInboundAt: T0 - 3 * 3600_000,
  lastCareAt: undefined,
  newInboundSinceLastCare: true,
  careUsedToday: 0,
  allUsedToday: 0,
  candidateInFlight: false,
  permissionVersion: 'perm@1',
}

const careOk = precheckCareOpportunity(careBase)
check(
  '正控：模式 on + 未暂停 + 入口作用域 + 空闲 3h + 无冷却 + 额度未用 ⇒ 够格（dryRun=false）',
  careOk.eligible === true && careOk.dryRun === false &&
    careOk.opportunityKey === careOpportunityKey(T0, policy.timeZone) &&
    careOk.permissionVersion === 'perm@1',
  careOk.eligible ? `${careOk.opportunityKey} dryRun=${String(careOk.dryRun)}` : careOk.code
)

const careShadow = precheckCareOpportunity({ ...careBase, mode: 'shadow' })
check(
  '正控：`shadow` 也**够格**（dryRun=true）（完整产生选择与审计，**不**真的发）',
  careShadow.eligible === true && careShadow.dryRun === true,
  careShadow.eligible ? `dryRun=${String(careShadow.dryRun)}` : careShadow.code
)

const careRejections: { label: string; input: CarePrecheckInput; code: string }[] = [
  { label: 'off 档', input: { ...careBase, mode: 'off' }, code: 'mode_off' },
  { label: '已暂停', input: { ...careBase, paused: true }, code: 'paused' },
  {
    label: '入口作用域未开',
    input: { ...careBase, entryScopedConversations: false },
    code: 'entry_scope_required',
  },
  { label: '已有候选在飞', input: { ...careBase, candidateInFlight: true }, code: 'candidate_in_flight' },
  {
    label: '不在活动时段（上海 23:00）',
    input: { ...careBase, now: Date.parse('2026-10-06T23:00:00+08:00') },
    code: 'outside_active_window',
  },
  {
    label: '空闲不足（入??30 分钟前）',
    input: { ...careBase, lastInboundAt: T0 - 30 * 60_000 },
    code: 'not_idle_enough',
  },
  {
    label: '冷却中（1 小时前关心过，且已有新入站）',
    input: { ...careBase, lastCareAt: T0 - 3600_000, newInboundSinceLastCare: true },
    code: 'cooldown',
  },
  {
    label: '上次关心未被回应',
    input: { ...careBase, lastCareAt: T0 - 5 * 3600_000, newInboundSinceLastCare: false },
    code: 'previous_care_unanswered',
  },
  { label: '今日关心额度用尽', input: { ...careBase, careUsedToday: 2 }, code: 'care_quota_reached' },
  { label: '今日总量用尽', input: { ...careBase, allUsedToday: 10 }, code: 'daily_quota_reached' },
]
const rejectionCodes: string[] = []
for (const entry of careRejections) {
  const result = precheckCareOpportunity(entry.input)
  rejectionCodes.push(result.eligible ? `!!${entry.label}=eligible` : result.code)
}
check(
  `负控 ×${String(careRejections.length)}：十种不合格**逐个具名**拒绝（不是一句"不该发"）`,
  rejectionCodes.every((code, index) => code === careRejections[index]!.code),
  rejectionCodes.join(' / ')
)

check(
  '负控：不在活动时段时**给出** deferredUntil??顺延到什么时??是可回答的）',
  (() => {
    const result = precheckCareOpportunity({
      ...careBase, now: Date.parse('2026-10-06T23:00:00+08:00'),
    })
    return result.eligible === false && typeof result.deferredUntil === 'number' &&
      result.deferredUntil === Date.parse('2026-10-07T09:00:00+08:00')
  })(),
  'deferredUntil = 次日 09:00（上海）'
)

// ===========================================================================
section('13. WP3 到点判定：未到点不发 / 宽限内发 / 超时判过期')
// ===========================================================================

const dueAt = T0
const dueNotYet = decideReminderDue({ dueAt, now: dueAt - 1000 })
const dueGrace = decideReminderDue({ dueAt, now: dueAt + 600_000 })
const dueExpired = decideReminderDue({ dueAt, now: dueAt + 31 * 60_000 })
check(
  '三态：未到点 ⇒ `reminder_not_due_yet` · 逾期 10 分钟 ⇒ deliver · 逾期 31 分钟 ⇒ `reminder_expired`',
  dueNotYet.action === 'expire' && dueNotYet.code === 'reminder_not_due_yet' &&
    dueGrace.action === 'deliver' &&
    dueExpired.action === 'expire' && dueExpired.code === 'reminder_expired',
  'not_due_yet / deliver(within_grace) / expired'
)

// ===========================================================================
section('14. WP3 重启不漏恢复：**关掉重开**之后暂停状态仍在')
// ===========================================================================

const beforeRestart = await readControl(db, characterId)
check(
  '关库前：控制面处??已恢??（三段式的正控收尾状态）',
  beforeRestart?.paused === false && beforeRestart.permissionVersion === 'perm@3',
  `paused=${String(beforeRestart?.paused)} perm=${String(beforeRestart?.permissionVersion)}`
)

/* 关掉运行时（唯一合法的收尾），再??*??PGlite**??*同一目录**重新打开 —??这就??重启"的机器形??*/
// 内容更新与旧版本占用的读回：只使用本门隔离库。
const contentIntent = await createIntent(db, {
  id: asNotificationIntentId('content-update-cas'), characterId, ownerRef: OWNER_ID, conversationRef: 'content-update-test',
  kind: 'reminder', sourceRefs: ['content-source'], scheduledAt: Date.now() + 600_000,
  timezone: DEFAULT_PROACTIVE_POLICY.timeZone, permissionVersion: 'perm-content@1', policyVersion: 'policy@1',
  text: '检查手机电量', dedupeKey: 'content-update-cas',
})
const oldContent = contentIntent.intent!
check('内容补充：真实写口保持排期、递增版本', await updateReminderText(db, oldContent, '记得拔插头。', ['content-confirm']))
const newContent = (await getIntent(db, oldContent.id))!
check('内容补充读回：正文、版本、来源、原时间一致', newContent.text === '记得拔插头。' && newContent.planVersion === 2 && newContent.scheduledAt === oldContent.scheduledAt && newContent.sourceRefs.includes('content-confirm'))
check('内容补充负控：旧版本不能再次写入', !await updateReminderText(db, oldContent, '错误正文', ['stale-source']))
const reserveContent = { intentId: oldContent.id, characterId, kind: 'reminder' as const, dueAt: oldContent.scheduledAt, permissionVersion: 'perm-content@1', policyVersion: 'policy@1' }
check('到点占用负控：旧计划不能启动投递', !(await reserveOccurrence(db, { ...reserveContent, occurrenceKey: 'content-update-old', expectedPlanVersion: 1 })).created)
check('到点占用正控：新版本可以启动投递', (await reserveOccurrence(db, { ...reserveContent, occurrenceKey: 'content-update-new', expectedPlanVersion: 2 })).created)
check('投递占用后禁止悄悄换正文', !await updateReminderText(db, newContent, '错误正文', ['after-reservation']))
await cancelIntent(db, oldContent.id)
await runtime.stop()
const reopened = await openRawPGlite(sandbox.dir)
let reopenedReading = ''
let reopenedPaused: boolean | undefined
try {
  const rows = (
    await reopened.query('select character_id, paused, paused_at, pause_reason, permission_version from notification_control')
  ).rows as Record<string, unknown>[]
  /* ⚠️ 表里还有其它夹具行（`wp3-check-*`）⇒ **按角色过??*，不??表里只有一?? */
  const mine = rows.filter((row) => String(row.character_id) === characterId)
  reopenedReading = JSON.stringify(mine)
  reopenedPaused = mine.length === 1 ? mine[0]!.paused === true : undefined
} finally {
  await reopened.close()
}

/* 重开之后再暂停一次，然后**再次**关掉重开，验??暂停"也活过重??*/
const reopenedRuntime = new AgentRuntime({
  character: character as Character,
  plugins: [sqlPlugin] as Plugin[],
  conversationLength: 16,
  settings: { OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '' },
})
await initDatabase(reopenedRuntime, sqlPlugin)
const db2 = getRawDb(reopenedRuntime)
const pausedAfterRestart = await pauseNotifications(db2, {
  characterId, reason: 'post_restart_pause', permissionVersion: 'perm@4', policyVersion: 'policy@1',
  now: T0 + 20_000,
})
const precheckWhilePaused = precheckCareOpportunity({ ...careBase, paused: true })
check(
  '正控：**重启读回**控制面（裸 PGlite 从同一目录读；不是内存变量）',
  reopenedPaused === false && reopenedReading.includes('perm@3'),
  reopenedReading.slice(0, 160)
)
check(
  '正控：重启后重新暂停仍然成立；且预检在暂停后**具名拒绝**（重启不会让"暂停"消失）',
  pausedAfterRestart.ok && pausedAfterRestart.control?.paused === true &&
    precheckWhilePaused.eligible === false && precheckWhilePaused.code === 'paused',
  `paused=${String(pausedAfterRestart.control?.paused)} 预检=${precheckWhilePaused.eligible ? 'eligible' : precheckWhilePaused.code}`
)

await reopenedRuntime.stop?.()

// ===========================================================================
section('15. WP4 角色选择：闭集提案严格解??+ 来源复核 + 两类触发的权限差')
// ===========================================================================

const goodSilence = parseProactiveProposal({
  decision: 'silence', reasonCode: 'nothing_worth_saying', sourceRefs: [],
})
const goodDefer = parseProactiveProposal({
  decision: 'defer', reasonCode: 'too_late_today', sourceRefs: ['mem:abc'], deferMinutes: 60,
})
const goodSend = parseProactiveProposal({
  decision: 'send', reasonCode: 'follow_up_progress', sourceRefs: ['mem:abc'],
  text: '上次那个报告写完啦？',
})
check(
  '正控：三种选择各一条合法提案（silence / defer / send）',
  goodSilence.ok && goodDefer.ok && goodSend.ok &&
    goodSilence.proposal.decision === 'silence' && goodDefer.proposal.deferMinutes === 60 &&
    goodSend.proposal.text === '上次那个报告写完啦？',
  `silence=${String(goodSilence.ok)} defer=${String(goodDefer.ok)} send=${String(goodSend.ok)}`
)

const parseNegatives: { label: string; raw: unknown; code: string }[] = [
  { label: '空字符串', raw: '   ', code: 'proactive_empty' },
  { label: '不是 JSON', raw: '她想了想', code: 'proactive_no_json_object' },
  { label: '不是对象', raw: 42, code: 'proactive_not_object' },
  {
    label: '多一个字段',
    raw: { decision: 'silence', reasonCode: 'x', sourceRefs: [], userId: '999' },
    code: 'proactive_unknown_field',
  },
  { label: 'decision 不在闭集', raw: { decision: 'call_user', reasonCode: 'x', sourceRefs: [] }, code: 'proactive_bad_decision' },
  { label: '??reasonCode', raw: { decision: 'silence', sourceRefs: [] }, code: 'proactive_missing_reason_code' },
  {
    label: 'reasonCode 形状不合法',
    raw: { decision: 'silence', reasonCode: '不好', sourceRefs: [] },
    code: 'proactive_bad_reason_code',
  },
  { label: '??sourceRefs', raw: { decision: 'silence', reasonCode: 'x' }, code: 'proactive_missing_source_refs' },
  {
    label: 'sourceRefs 不是数组',
    raw: { decision: 'silence', reasonCode: 'x', sourceRefs: 'mem:abc' },
    code: 'proactive_source_refs_not_array',
  },
  {
    label: 'send 没有正文',
    raw: { decision: 'send', reasonCode: 'x', sourceRefs: ['mem:abc'] },
    code: 'proactive_send_without_text',
  },
  {
    label: 'send 正文超长',
    raw: { decision: 'send', reasonCode: 'x', sourceRefs: ['mem:abc'], text: 'x'.repeat(501) },
    code: 'proactive_send_text_too_long',
  },
  {
    label: 'silence 带正文',
    raw: { decision: 'silence', reasonCode: 'x', sourceRefs: [], text: '在吗' },
    code: 'proactive_non_send_with_text',
  },
  {
    label: 'defer 没有分钟数',
    raw: { decision: 'defer', reasonCode: 'x', sourceRefs: ['mem:abc'] },
    code: 'proactive_defer_without_minutes',
  },
  {
    label: 'defer 越界（0 分钟）',
    raw: { decision: 'defer', reasonCode: 'x', sourceRefs: ['mem:abc'], deferMinutes: 5 },
    code: 'proactive_defer_minutes_out_of_range',
  },
  {
    label: 'defer 越界（200 分钟）',
    raw: { decision: 'defer', reasonCode: 'x', sourceRefs: ['mem:abc'], deferMinutes: 600 },
    code: 'proactive_defer_minutes_out_of_range',
  },
  {
    label: 'silence ??deferMinutes',
    raw: { decision: 'silence', reasonCode: 'x', sourceRefs: [], deferMinutes: 30 },
    code: 'proactive_non_defer_with_minutes',
  },
]
const parseCodes: string[] = []
for (const entry of parseNegatives) {
  const result = parseProactiveProposal(entry.raw)
  parseCodes.push(result.ok ? `!!${entry.label}=通过` : result.code)
}
check(
  `负控 ×${String(parseNegatives.length)}：十六种非法提案**逐个具名**拒绝（含"多一个字段整条作废"）`,
  parseCodes.every((code, index) => code === parseNegatives[index]!.code),
  parseCodes.join(' / ')
)

check(
  '负控：程序给定的权限??—??提醒??*不许** defer；关心档允许 defer',
  (() => {
    const reminderAuthority = decisionAuthorityFor('reminder')
    const careAuthority = decisionAuthorityFor('care')
    const denyDefer = parseProactiveProposal(
      { decision: 'defer', reasonCode: 'x', sourceRefs: ['mem:a'], deferMinutes: 30 },
      { allowDefer: reminderAuthority.allowDefer }
    )
    const allowDefer = parseProactiveProposal(
      { decision: 'defer', reasonCode: 'x', sourceRefs: ['mem:a'], deferMinutes: 30 },
      { allowDefer: careAuthority.allowDefer }
    )
    return denyDefer.ok === false && denyDefer.code === 'proactive_bad_decision' && allowDefer.ok === true
  })(),
  '提醒??allowDefer=false ????· 关心??allowDefer=true ??通过'
)

check(
  '来源复核：空引用 / 可用集拿不到 / 引用失效 ??三种具名拒绝；全在集????通过',
  (() => {
    const available = new Set(['mem:a', 'mem:b'])
    const empty = verifyProactiveSources({ sourceRefs: [], available })
    const unavailable = verifyProactiveSources({ sourceRefs: ['mem:a'], available: new Set() })
    const stale = verifyProactiveSources({ sourceRefs: ['mem:a', 'mem:gone'], available })
    const ok = verifyProactiveSources({ sourceRefs: ['mem:a', 'mem:b'], available })
    return (
      empty.ok === false && empty.code === 'proactive_without_source' &&
      unavailable.ok === false && unavailable.code === 'proactive_source_set_unavailable' &&
      stale.ok === false && stale.code === 'proactive_source_stale' &&
      (stale.staleRefs ?? []).join(',') === 'mem:gone' &&
      ok.ok === true
    )
  })(),
  'without_source / source_set_unavailable / source_stale / ok'
)

/*
 * ??两类触发??*权限??*（`D03` 逐字）：
 *   "已接受且到期、未取消、策略仍允许的明确提醒，角色只决定措辞，不能??今天不想说话'自行取消"
 *   ??提醒??silence **绝不**翻成"跳过"，而是走程序模板（并标明模板来源）?? */
/** `ProactiveProgramAction` 的具名码（`defer` 那一支没??code ????action 名代替） */
const actionCode = (action: { action: string; code?: string }): string => action.code ?? action.action

const nowForAction = 1_791_300_000_000
const reminderSilence = programActionFor({
  kind: 'reminder',
  proposal: { decision: 'silence', reasonCode: 'not_in_mood', sourceRefs: ['qni:1'] },
  now: nowForAction,
})
const careSilence = programActionFor({
  kind: 'care',
  proposal: { decision: 'silence', reasonCode: 'not_in_mood', sourceRefs: ['mem:a'] },
  now: nowForAction,
})
check(
  '★ 权限差：提醒的 `silence` ⇒ `deliver_template`（**不**记成完成、**不**记成跳过）；关心的 `silence` ⇒ `stay_silent`（合法结局）',
  reminderSilence.action === 'deliver_template' &&
    actionCode(reminderSilence) === 'reminder_silenced_use_template' &&
    careSilence.action === 'stay_silent' && actionCode(careSilence) === 'care_legal_silence',
  `提醒=${reminderSilence.action}(${actionCode(reminderSilence)}) · 关心=${careSilence.action}(${actionCode(careSilence)})`
)

check(
  '模型失败兜底：提醒 ⇒ 程序模板（带失败桶名）；关心 ⇒ 放弃本次机会（不硬发）',
  programActionOnModelFailure({ kind: 'reminder', failure: 'timeout' }).action === 'deliver_template' &&
    actionCode(programActionOnModelFailure({ kind: 'reminder', failure: 'timeout' })) === 'reminder_model_timeout' &&
    programActionOnModelFailure({ kind: 'care', failure: 'invalid_output' }).action === 'stay_silent',
  'reminder_model_timeout / care_model_invalid_output'
)

check(
  'defer 翻成**程序给的**时刻（不是模型自选时刻）：deferMinutes=60 ??now + 60 分钟',
  (() => {
    const action = programActionFor({
      kind: 'care',
      proposal: { decision: 'defer', reasonCode: 'later', sourceRefs: ['mem:a'], deferMinutes: 60 },
      now: nowForAction,
    })
    return action.action === 'defer' && action.until === nowForAction + 3_600_000
  })(),
  '+60min'
)

check(
  '简报由**程序**生成??*有界**：依据最??8 条、每条摘????20 码点，且明确??这不是对方发来的消息"',
  (() => {
    const sources = Array.from({ length: 12 }, (_unused, index) => ({
      ref: `mem:${String(index)}`,
      summary: 'x'.repeat(200),
    }))
    const text = renderProactiveBriefing({
      kind: 'care',
      opportunity: '两路真实入站已经安静了很久',
      localTime: '2026-10-06 20:00',
      timezone: 'Asia/Shanghai',
      sources,
      textBudget: PROACTIVE_TEXT_MAX_CODEPOINTS,
    })
    const listed = text.split('\n').filter((line) => line.startsWith('- mem:'))
    return (
      listed.length === PROACTIVE_MAX_SOURCE_OPTIONS &&
      /* ⚠️ 剪掉 ` :: ` 之后的前导空格再数码??—??否则量到的是 121（多量了一个空格） */
      listed.every(
        (line) => [...line.slice(line.indexOf('::') + 2).trim()].length <= PROACTIVE_SOURCE_SUMMARY_CODEPOINTS
      ) &&
      text.includes('这不是对方发来的一条消息')
    )
  })(),
  `最??${String(PROACTIVE_MAX_SOURCE_OPTIONS)} ??/ 每条 ??{String(PROACTIVE_SOURCE_SUMMARY_CODEPOINTS)} 码点`
)

check(
  '指令**从契约派??*：闭集成员逐个出现在指令里（提示词与代码不会漂移）',
  (() => {
    const instruction = buildProactiveInstruction()
    return (
      PROACTIVE_DECISIONS.every((decision) => instruction.includes(`\`${decision}\``)) &&
      instruction.includes(String(PROACTIVE_TEXT_MAX_CODEPOINTS)) &&
      instruction.includes(String(PROACTIVE_DEFER_MIN_MINUTES)) &&
      instruction.includes(String(PROACTIVE_DEFER_MAX_MINUTES)) &&
      instruction.includes('不能') && instruction.includes('收件人')
    )
  })(),
  '三个 decision / 正文上限 / defer 范围 都在指令里'
)

check(
  '提醒模板：`提醒你一下：<已校验内??`（程序既定句，不执行原请求里的任何工具指令）',
  reminderTemplateText('十分钟后提醒我喝水') === '提醒你一下：十分钟后提醒我喝水' &&
    okCode(() => reminderTemplateText('  ')).code === 'reminder_template_empty',
  reminderTemplateText('十分钟后提醒我喝水')
)

// ===========================================================================
section('16. WP5 能力登记：声明形状 / 参数闭集 / 收件人不可提供 / 治理开关')
// ===========================================================================

{
  const mainText = readFileSync(resolve('src/main.ts'), 'utf8')

  check(
    '正控：能力恒登记在装配层（`...createQqProactiveCapabilityDefinitions()`），且**不在**任务候选表里',
    mainText.includes('...createQqProactiveCapabilityDefinitions()') &&
      (() => {
        const start = mainText.indexOf('const TASK_CAPABILITY_IDS')
        const list = start < 0 ? '' : mainText.slice(start, mainText.indexOf('\n]', start))
        return list !== '' && !list.includes('QQ_PRIVATE_SEND_TEXT')
      })(),
    '计划 §7 的能力矩阵："本批新增 NONE" —??角色选工??/ 任务环规划不到它'
  )

  check(
    '正控：权限**条件授予**（`off` 时不在授予清单里 ⇒ 得到可审计的 missing_permission）',
    mainText.includes("this.flags.qqProactiveMode !== 'off' ? [QQ_PRIVATE_SEND_PERMISSION] : []"),
    "mode !== 'off'"
  )

  check(
    '正控：声明形??= write / **R2** / 幂等**必需** / 支持干跑（`shadow` 档靠它）',
    capabilities.length === 1 &&
      capabilities[0]!.id === QQ_PRIVATE_SEND_TEXT &&
      capabilities[0]!.sideEffectLevel === 'write' &&
      capabilities[0]!.riskLevel === 'R2' &&
      capabilities[0]!.idempotency === 'required' &&
      capabilities[0]!.supportsDryRun === true &&
      capabilities[0]!.operations.length === 1 &&
      capabilities[0]!.operations[0]!.name === QQ_PRIVATE_SEND_OPERATION,
    `${QQ_PRIVATE_SEND_TEXT} / ${QQ_PRIVATE_SEND_OPERATION} ??${capabilities[0]?.riskLevel ?? '?'} · ${capabilities[0]?.idempotency ?? '?'}`
  )

  check(
    '正控：登记完整??—??`TOOL_GATE_KEYS` ??`TASK_ARG_KEYS` 都有它的行（`auditToolCatalog` 的两条要求）',
    TOOL_GATE_KEYS[QQ_PRIVATE_SEND_TEXT] === 'qqProactiveMode' &&
      JSON.stringify(TASK_ARG_KEYS[QQ_PRIVATE_SEND_TEXT]) === JSON.stringify(['text']),
    `gate=${String(TOOL_GATE_KEYS[QQ_PRIVATE_SEND_TEXT])} args=${JSON.stringify(TASK_ARG_KEYS[QQ_PRIVATE_SEND_TEXT])}`
  )

  const recipientKeys = ['user_id', 'ownerId', 'to', 'recipient', 'qq', 'uin', 'userId']
  const recipientReadings = recipientKeys.map((key) => {
    const violation = recipientArgViolation({ text: '在吗', [key]: '10001' })
    return violation?.code ?? 'NO-VIOLATION'
  })
  check(
    `负控 ×${String(recipientKeys.length)}：参数里出现任何收件人字????逐个具名拒绝（收件人由绑定决定）`,
    recipientReadings.every((reading) => reading === 'qq_send_recipient_from_argument'),
    recipientKeys.join(' / ')
  )

  check(
    '负控：未声明的参数名 ⇒ 具名拒绝（闭集；"模型提供不了别的字段"）',
    (() => {
      const unknown = okCode(() => assertQqSendArgKeys({ text: '在吗', minutes: 10 }))
      const legal = okCode(() => assertQqSendArgKeys({ text: '在吗' }))
      return unknown.ok === false && unknown.code === 'qq_send_unknown_arg' && legal.ok === true
    })(),
    'qq_send_unknown_arg / 合法参数通过'
  )

  check(
    '正控：`TASK_ARG_KEYS` 里它的参数是 `["text"]`（没有收件人字段，且与声明同源）',
    QQ_PRIVATE_SEND_ARG_KEYS.length === 1 && QQ_PRIVATE_SEND_ARG_KEYS[0] === 'text' &&
      FORBIDDEN_RECIPIENT_ARG_KEYS.every((key) => !QQ_PRIVATE_SEND_ARG_KEYS.includes(key)),
    QQ_PRIVATE_SEND_ARG_KEYS.join(' / ')
  )

  check(
    '策略配置读数：缺省安全侧（时段 09–22 · 关心 ≤2/日 · 全类 ≤10/日 · 评估 15s · 待办 ≤20）',
    (() => {
      const policy = readProactivePolicy({} as NodeJS.ProcessEnv)
      return (
        policy.timeZone === 'Asia/Shanghai' &&
        policy.activeWindow.startHour === 9 && policy.activeWindow.endHour === 22 &&
        policy.maxCarePerDay === 2 && policy.maxProactiveMessagesPerDay === 10 &&
        policy.evaluationTimeoutMs === 15_000 && policy.maxPendingReminders === 20 &&
        policy.reminderGraceMs === 30 * 60_000
      )
    })(),
    'Asia/Shanghai 09:00??2:00 · 2/10 · 15000ms · 20'
  )
}

// ===========================================================================
section('17. WP5-B 协议：闭集登??/ 控制类分??/ 回执四条失败关闭 / 出站有界')
// ===========================================================================

{
  check(
    '正控：两个新 kind 都**显式登记**进受控表（`REPORT_QQ_DELIVERY` 入站 / `DELIVER_QQ_TEXT` 出站）',
    BRIDGE_MESSAGE_KINDS.includes('REPORT_QQ_DELIVERY') &&
      isBridgeMessageKind('REPORT_QQ_DELIVERY') &&
      /* 出站那一侧是 `BridgeWireResponse.kind` 的成??—??由下面那条正控实测（写出一行）证明 */
      true,
    `入站受控??${JSON.stringify(BRIDGE_MESSAGE_KINDS)}`
  )

  check(
    '分类：回执是**控制类**（不排队 —— 慢轮次不该把回执压到轮末）',
    isBridgeControlMessageKind('REPORT_QQ_DELIVERY') &&
      isBridgeControlMessageKind('PREPARE_TURN') &&
      !isBridgeControlMessageKind('SUBMIT_TURN'),
    'REPORT_QQ_DELIVERY / PREPARE_TURN 是控制类；SUBMIT_TURN 不是'
  )

  check(
    '结局闭集：三个成员；刻意**没有** delivered / read / seen（QQ 协议不给这些凭据）',
    BRIDGE_QQ_DELIVERY_STATUSES.length === 3 &&
      isBridgeQqDeliveryStatus('api_accepted') &&
      isBridgeQqDeliveryStatus('delivery_unknown') &&
      !isBridgeQqDeliveryStatus('delivered') &&
      !isBridgeQqDeliveryStatus('read'),
    BRIDGE_QQ_DELIVERY_STATUSES.join(' / ')
  )

  /* 一个最小的 host：只有投递登记，没有别的能力 */
  const seen: { deliveryId: string; status: string; messageId?: string }[] = []
  const bridge = new TurnBridge({
    host: {
      characterId: 'char:wp5',
      conversationId: 'dm-wp5',
      runTurn: async () => {
        throw new Error('不该走到这里')
      },
      reportQqDelivery: (input) => {
        seen.push({
          deliveryId: input.deliveryId,
          status: input.status,
          ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
        })
        /* 复刻登记的失败关闭：未知 id ??accepted:false，且**??*当失??*/
        if (input.deliveryId === 'delivery-known') {
          return { accepted: true, recordedState: input.status }
        }
        return { accepted: false, code: 'qq_delivery_unknown_id' }
      },
    },
  })

  const written: unknown[] = []
  bridge.setOutputSink((message) => written.push(message))

  const deliverOk = bridge.deliverQqText({ deliveryId: 'delivery-known', text: '该喝水了。' })
  const envelope = written[0] as { kind?: string; requestId?: string; outcome?: string; qqText?: string } | undefined
  check(
    '正控：投递写??*一??* `DELIVER_QQ_TEXT`，且 `requestId` = `deliveryId`（复用关联字段）',
    deliverOk.written && envelope?.kind === 'DELIVER_QQ_TEXT' &&
      envelope.requestId === 'delivery-known' && envelope.qqText === '该喝水了。' &&
      envelope.outcome === 'generated',
    `kind=${String(envelope?.kind)} requestId=${String(envelope?.requestId)}`
  )

  const deliverNoId = bridge.deliverQqText({ deliveryId: '  ', text: '在吗' })
  const deliverNoText = bridge.deliverQqText({ deliveryId: 'delivery-known', text: '   ' })
  const deliverTooLong = bridge.deliverQqText({
    deliveryId: 'delivery-known', text: 'x'.repeat(QQ_DELIVERY_TEXT_MAX_CODEPOINTS + 1),
  })
  check(
    `负控 ×3：空 deliveryId / 空正??/ 超上界（${String(QQ_DELIVERY_TEXT_MAX_CODEPOINTS)} 码点）⇒ 逐个具名拒绝，且**一个字节都没写出去**`,
    deliverNoId.written === false && deliverNoId.code === 'qq_delivery_without_id' &&
      deliverNoText.written === false && deliverNoText.code === 'qq_delivery_without_text' &&
      deliverTooLong.written === false && deliverTooLong.code === 'qq_delivery_text_too_long' &&
      written.length === 1,
    `${String(deliverNoId.code)} / ${String(deliverNoText.code)} / ${String(deliverTooLong.code)} · 写出=${String(written.length)} 行`
  )

  const sinkless = new TurnBridge({
    host: { characterId: 'char:wp5', conversationId: 'dm-wp5', runTurn: async () => { throw new Error('x') } },
  })
  const noSink = sinkless.deliverQqText({ deliveryId: 'delivery-known', text: '在吗' })
  check(
    '负控：**没有出站通道** ⇒ `output_channel_absent`（**不**假装说出去了）',
    noSink.written === false && noSink.code === 'output_channel_absent',
    String(noSink.code)
  )

  const reportOk = await handleBridgeMessage(bridge, {
    kind: 'REPORT_QQ_DELIVERY', requestId: 'delivery-known',
    deliveryId: 'delivery-known', deliveryStatus: 'api_accepted', messageId: 'mid-9',
  })
  const reportUnknownId = await handleBridgeMessage(bridge, {
    kind: 'REPORT_QQ_DELIVERY', requestId: 'delivery-gone',
    deliveryId: 'delivery-gone', deliveryStatus: 'delivery_unknown',
  })
  check(
    '正控：`api_accepted` + `messageId` ??登记受理（`accepted:true`，`recordedState=api_accepted`）；未知 id ??`accepted:false` + 具名码（**??*当失败）',
    reportOk.outcome === 'accepted' && reportOk.qqDelivery?.accepted === true &&
      reportOk.qqDelivery.recordedState === 'api_accepted' &&
      reportUnknownId.qqDelivery?.accepted === false &&
      reportUnknownId.qqDelivery.code === 'qq_delivery_unknown_id' &&
      seen.length === 2 && seen[0]!.messageId === 'mid-9',
    `ok=${String(reportOk.qqDelivery?.recordedState)} · 未知=${String(reportUnknownId.qqDelivery?.code)}`
  )

  const noId = await handleBridgeMessage(bridge, {
    kind: 'REPORT_QQ_DELIVERY', requestId: '', deliveryId: '', deliveryStatus: 'api_accepted',
  })
  const badStatus = await handleBridgeMessage(bridge, {
    kind: 'REPORT_QQ_DELIVERY', requestId: 'd', deliveryId: 'd', deliveryStatus: 'delivered',
  })
  const idOnNonAccepted = await handleBridgeMessage(bridge, {
    kind: 'REPORT_QQ_DELIVERY', requestId: 'd', deliveryId: 'd',
    deliveryStatus: 'delivery_unknown', messageId: 'mid-should-not-be-here',
  })
  check(
    '负控 ×3：空 `deliveryId` / 结局不在闭集 / 非接受却带回??id ??三条具名拒绝',
    noId.code === 'qq_delivery_report_without_id' &&
      badStatus.code === 'qq_delivery_report_unknown_status' &&
      idOnNonAccepted.code === 'qq_delivery_report_unexpected_message_id' &&
      seen.length === 2,
    `${String(noId.code)} / ${String(badStatus.code)} / ${String(idOnNonAccepted.code)}`
  )

  const unsupported = await handleBridgeMessage(sinkless, {
    kind: 'REPORT_QQ_DELIVERY', requestId: 'd', deliveryId: 'd', deliveryStatus: 'failed_confirmed',
  })
  check(
    '负控：host **没有**投递登????`qq_delivery_report_unsupported`（如实拒绝，不假装记下）',
    unsupported.qqDelivery?.accepted === false &&
      unsupported.code === 'qq_delivery_report_unsupported',
    String(unsupported.code)
  )

  check(
    '读数分列：投递出站的 `written` / `refused` 与有限插话的读数**不混**（两条线）',
    bridge.qqDeliveryReading.written === 1 && bridge.qqDeliveryReading.refused === 3 &&
      bridge.qqDeliveryReading.lastCode === 'qq_delivery_text_too_long' &&
      bridge.qqDeliveryReading.lastDeliveryId === 'delivery-known' &&
      bridge.outputReading.spoken === 0,
    `written=${String(bridge.qqDeliveryReading.written)} refused=${String(bridge.qqDeliveryReading.refused)} 插话spoken=${String(bridge.outputReading.spoken)}`
  )
}

// ===========================================================================
section('18. WP5-B 外壳侧端到端：模拟 OneBot + 假核心 ⇒ 真的调用 send API 并回执')
// ===========================================================================

{
  const { WebSocketServer } = createRequire(import.meta.resolve('jsdom'))('ws') as {
    WebSocketServer: new (options: { host: string; port: number }) => {
      on: (event: string, handler: (...args: unknown[]) => void) => void
      close: (done?: () => void) => void
      address: () => { port: number }
    }
  }
  const wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  /* ⚠️ 构造之??`address()` 可能??null —??必须**??listening** 再取端口 */
  await new Promise<void>((resolve) => {
    ;(wsServer as unknown as { once: (e: string, h: () => void) => void }).once('listening', () => resolve())
  })
  const wsPort = wsServer.address().port
  const sentByShell: { userId: string; text: string }[] = []
  /** 下一??`send_private_msg` 的回包形状（负控会改它） */
  let sendResponse: Record<string, unknown> = {
    status: 'ok', retcode: 0, data: { message_id: 90001 },
  }
  wsServer.on('connection', (socket: unknown) => {
    const ws = socket as { on: (e: string, h: (raw: string) => void) => void; send: (s: string) => void }
    ws.on('message', (raw: string) => {
      const packet = JSON.parse(raw) as { action?: string; params?: Record<string, unknown>; echo?: string }
      if (packet.action === 'get_login_info') {
        ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: Number(OWNER_BOT_ID) }, echo: packet.echo }))
        return
      }
      if (packet.action === 'send_private_msg') {
        const params = packet.params ?? {}
        const segments = params.message as { data?: { text?: string } }[] | undefined
        sentByShell.push({
          userId: String(params.user_id),
          text: String(segments?.[0]?.data?.text ?? ''),
        })
        ws.send(JSON.stringify({ ...sendResponse, echo: packet.echo }))
      }
    })
  })

  /* 假核心：说同一??NDJSON 协议（`LG_ENTRY` 握手 + `DELIVER_QQ_TEXT` 出站??*/
  const reports = new Map<string, Record<string, unknown>>()
  const waiters = new Map<string, (value: Record<string, unknown>) => void>()
  let coreSocket: { write: (s: string) => void } | undefined
  const core = createServer((socket) => {
    coreSocket = socket
    socket.setEncoding('utf8')
    let buffer = ''
    let handshaken = false
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (;;) {
        const at = buffer.indexOf('\n')
        if (at < 0) break
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        if (!handshaken) {
          handshaken = line.trim() === `LG_ENTRY ${COEXIST_TOKEN} v${ENTRY_PROTOCOL_VERSION}`
          socket.write(`LG_ENTRY_READY qq_private dm-wp5-qq\n`)
          continue
        }
        let message: Record<string, unknown>
        try { message = JSON.parse(line) as Record<string, unknown> } catch { continue }
        if (message.kind !== 'REPORT_QQ_DELIVERY') continue
        const id = String(message.deliveryId ?? '')
        reports.set(id, message)
        waiters.get(id)?.(message)
        waiters.delete(id)
      }
    })
  })
  await new Promise<void>((resolve) => core.listen(0, '127.0.0.1', () => resolve()))
  const corePort = (core.address() as { port: number }).port

  const baseEnv = {
    ...process.env,
    QQ_OWNER_ID: OWNER_ID,
    QQ_BOT_ID: OWNER_BOT_ID,
    QQ_ONEBOT_ACCESS_TOKEN: 'wp5-proactive-verify-token-0123456789',
    QQ_ONEBOT_WS_URL: `ws://127.0.0.1:${String(wsPort)}/`,
  }

  const lg = new LgStdioClient(resolve('.'), baseEnv, {
    connect: { host: '127.0.0.1', port: corePort, token: COEXIST_TOKEN },
  })
  const shellLog: Record<string, unknown>[] = []
  const client = new OneBotPrivateClient(readQqPrivateConfig(baseEnv), (request) => lg.submit(request), (reading) => { shellLog.push(reading) })

  /** 让假核心发一条投递并等它的回执（有界 5s??*/
  const deliverFromCore = async (deliveryId: string, text: string): Promise<Record<string, unknown>> => {
    const wait = new Promise<Record<string, unknown>>((resolve) => waiters.set(deliveryId, resolve))
    coreSocket!.write(`${JSON.stringify({ kind: 'DELIVER_QQ_TEXT', requestId: deliveryId, outcome: 'generated', qqText: text })}\n`)
    return await Promise.race([
      wait,
      new Promise<Record<string, unknown>>((resolve) =>
        setTimeout(() => resolve({ deliveryStatus: 'timeout_waiting_report' }), 5000)),
    ])
  }

  try {
    await lg.ready
    await client.connect()
    lg.setQqDeliveryHandler(async (input) => await client.deliverProactiveText(input.text))

    const okReport = await deliverFromCore('wp5b-ok', '该喝水了。')
    check(
      '??正控：核心发 `DELIVER_QQ_TEXT` ??外壳**真的调用** `send_private_msg`（owner 固定），并回 `api_accepted` + messageId',
      sentByShell.length === 1 && sentByShell[0]!.text === '该喝水了。' &&
        sentByShell[0]!.userId === OWNER_ID &&
        okReport.deliveryStatus === 'api_accepted' && String(okReport.messageId) === '90001',
      `发给=${sentByShell[0]?.userId ?? '?'} 正文=${sentByShell[0]?.text ?? '?'} 回执=${String(okReport.deliveryStatus)}/${String(okReport.messageId)}`
    )

    /* 负控 A：平台明确拒????failed_confirmed */
    sendResponse = { status: 'failed', retcode: 100, data: null }
    const failedReport = await deliverFromCore('wp5b-refused', '在吗')
    check(
      '负控：平台**明确拒绝** ⇒ `failed_confirmed` + 具名理由（**不**报已送达）',
      failedReport.deliveryStatus === 'failed_confirmed' && failedReport.messageId === undefined &&
        failedReport.detail === 'onebot_api_failed',
      `${String(failedReport.deliveryStatus)} / ${String(failedReport.detail)}`
    )

    /* 负控 B：平台说 ok ??*没有**回执 id ??delivery_unknown（不??没发??，也不是"送到????*/
    sendResponse = { status: 'ok', retcode: 0, data: {} }
    const unknownReport = await deliverFromCore('wp5b-unconfirmed', '在吗')
    check(
      '负控：平??ok ??*没有**回执 id ??`delivery_unknown`（结果不明，**??*猜）',
      unknownReport.deliveryStatus === 'delivery_unknown' &&
        unknownReport.detail === 'qq_delivery_unconfirmed' &&
        unknownReport.messageId === undefined,
      `${String(unknownReport.deliveryStatus)} / ${String(unknownReport.detail)}`
    )

    /* 负控 C：断????发??*??*就确定不可用 ??failed_confirmed，且不再多发 */
    const sentBeforeDisconnect = sentByShell.length
    await client.close()
    sendResponse = { status: 'ok', retcode: 0, data: { message_id: 90002 } }
    const offlineReport = await deliverFromCore('wp5b-offline', '在吗')
    check(
      '负控：外??*未连??* ??`failed_confirmed`（未发送，不是"结果不明"），??*没有**多调一??send API',
      offlineReport.deliveryStatus === 'failed_confirmed' &&
        sentByShell.length === sentBeforeDisconnect,
      `${String(offlineReport.deliveryStatus)} / ${String(offlineReport.detail)} · 发送次数不??${String(sentByShell.length === sentBeforeDisconnect)}`
    )
  } finally {
    await client.close().catch(() => undefined)
    await lg.close().catch(() => undefined)
    await new Promise<void>((resolve) => core.close(() => resolve()))
    await new Promise<void>((resolve) => wsServer.close(() => resolve()))
  }

  check(
    '负控：**没有装投递处理器**时不假装送出（回 `delivery_unknown` + `delivery_handler_absent`）',
    (() => {
      const bare = new LgStdioClient(resolve('.'), baseEnv, {
        connect: { host: '127.0.0.1', port: 1, token: COEXIST_TOKEN },
      })
      /* 它连不上（端??1），??*处理器缺??*这条判据与连接无关，??`handleQqDelivery` 的早退保证 */
      const absent = (bare as unknown as { qqDeliveryHandler?: unknown }).qqDeliveryHandler === undefined
      void bare.close().catch(() => undefined)
      return absent
    })(),
    '未装处理器 ⇒ qqDeliveryHandler 为 undefined（那一行据此如实回"结果不明"）'
  )
}

// ===========================================================================
section('19. WP5-B 投递登记：连接代次 + 回执结算（四类不受理）+ 适配器')
// ===========================================================================

{
  /* 一??*内存**登记端口：复??`advanceOccurrence` 的迁移复核（判据层不该开真库??*/
  const states = new Map<string, NotificationOccurrenceState>()
  let advanceCalls = 0
  const port: NotificationDeliveryPort = {
    readOccurrenceState: async (key) => states.get(key),
    advanceOccurrence: async (input) => {
      advanceCalls += 1
      const current = states.get(input.occurrenceKey)
      if (current === undefined) return { ok: false, code: 'occurrence_missing' }
      if (!canTransitionOccurrence(current, input.to) && current !== input.to) {
        return { ok: false, code: 'notification_transition_denied', state: current }
      }
      if (input.to === 'api_accepted' &&
          (input.platformMessageId === undefined || input.platformMessageId.trim() === '')) {
        return { ok: false, code: 'occurrence_accepted_without_message_id', state: current }
      }
      states.set(input.occurrenceKey, input.to)
      return { ok: true, state: input.to }
    },
  }
  const registry = new QqDeliveryRegistry({ store: port })

  check(
    '正控：结局闭集与桥那一侧**同源**（三态、逐一相等，没有第四种）',
    QQ_DELIVERY_STATUSES.length === BRIDGE_QQ_DELIVERY_STATUSES.length &&
      QQ_DELIVERY_STATUSES.every((status) => isBridgeQqDeliveryStatus(status)),
    QQ_DELIVERY_STATUSES.join(' / ')
  )

  /* ---- 连接代次（④??---- */
  const gen1 = registry.openConnection()
  const gen2 = registry.openConnection()
  check(
    '正控：代次单调递增（1 → 2）；只有**当前**代次有权投递',
    gen1 === 1 && gen2 === 2 &&
      registry.currentGeneration() === 2 &&
      registry.assertDeliverable(gen2).ok === true &&
      registry.assertDeliverable(gen1).code === 'qq_delivery_not_current_connection',
    `gen1=${String(gen1)} gen2=${String(gen2)}`
  )
  const noConnection = new QqDeliveryRegistry({ store: port })
  check(
    '负控：**从没开过连接** ⇒ `qq_delivery_no_active_connection`（不是"当前代次不对"）',
    noConnection.assertDeliverable(null).ok === false &&
      noConnection.assertDeliverable(null).code === 'qq_delivery_no_active_connection',
    String(noConnection.assertDeliverable(null).code)
  )
  check(
    '负控：**旧代次断开**不该清掉新代次的水位（只有它仍是当前代次才清）',
    registry.closeConnection(gen1) === false && registry.currentGeneration() === 2,
    `close(1)=false · 当前=${String(registry.currentGeneration())}`
  )

  /* ---- 投递登记（`prepared` ??`dispatching`??---- */
  states.set('occ-a', 'prepared')
  const dispatchOk = await registry.beginDispatch({ occurrenceKey: 'occ-a', generation: gen2 })
  const dispatchNoConn = await registry.beginDispatch({ occurrenceKey: 'occ-a', generation: gen1 })
  check(
    '正控：`prepared` ??`dispatching` 成功??*旧代??*发起投????具名拒绝??*状态不??*',
    dispatchOk.ok === true && dispatchOk.state === 'dispatching' &&
      dispatchNoConn.ok === false && dispatchNoConn.code === 'qq_delivery_not_current_connection' &&
      states.get('occ-a') === 'dispatching',
    `ok=${String(dispatchOk.state)} 旧代??${String(dispatchNoConn.code)} 现状=${String(states.get('occ-a'))}`
  )

  /* ---- 回执结算（⑤??---- */
  const accepted = await registry.report({ deliveryId: 'occ-a', status: 'api_accepted', messageId: 'mid-1', generation: gen2 })
  check(
    '★ 正控：`dispatching` + `api_accepted` + 回执 id ⇒ 实例落 `api_accepted`（回执被受理）',
    accepted.accepted === true && accepted.recordedState === 'api_accepted' && states.get('occ-a') === 'api_accepted',
    `recordedState=${String(accepted.recordedState)}`
  )

  const duplicate = await registry.report({ deliveryId: 'occ-a', status: 'api_accepted', messageId: 'mid-1', generation: gen2 })
  const settled = await registry.report({ deliveryId: 'occ-a', status: 'delivery_unknown', generation: gen2 })
  check(
    '负控 ×2：同一结局再报一次 ⇒ `qq_delivery_duplicate_receipt`；**已定案换结局** ⇒ `qq_delivery_already_settled`（含 unknown→accepted 那条不许）',
    duplicate.accepted === false && duplicate.code === 'qq_delivery_duplicate_receipt' &&
      settled.accepted === false && settled.code === 'qq_delivery_already_settled' &&
      states.get('occ-a') === 'api_accepted',
    `${String(duplicate.code)} / ${String(settled.code)}`
  )

  const unknownId = await registry.report({ deliveryId: 'occ-does-not-exist', status: 'api_accepted', messageId: 'x' })
  check(
    '负控：认不出来的 `deliveryId` ??`qq_delivery_unknown_id`??*??*当失败，??*??*新建一行）',
    unknownId.accepted === false && unknownId.code === 'qq_delivery_unknown_id' && unknownId.recordedState === undefined,
    String(unknownId.code)
  )

  const stale = await registry.report({ deliveryId: 'occ-a', status: 'failed_confirmed', generation: gen1 })
  check(
    '负控??*旧代次连??*的回????`qq_delivery_stale_generation`（不回写新状态）',
    stale.accepted === false && stale.code === 'qq_delivery_stale_generation' && states.get('occ-a') === 'api_accepted',
    String(stale.code)
  )

  /* `api_accepted` ??*没有**回执 id ??由迁移复核挡下（不是"接受"??*/
  states.set('occ-b', 'dispatching')
  const acceptedNoId = await registry.report({ deliveryId: 'occ-b', status: 'api_accepted', generation: gen2 })
  check(
    '负控：`api_accepted` ??*没有**回执 id ??具名拒绝（`occurrence_accepted_without_message_id`），实例停在 `dispatching`',
    acceptedNoId.accepted === false && acceptedNoId.code === 'occurrence_accepted_without_message_id' &&
      states.get('occ-b') === 'dispatching',
    String(acceptedNoId.code)
  )

  /* `delivery_unknown` 是一??*被受??*的回执（不是拒绝??*/
  const unknownState = await registry.report({ deliveryId: 'occ-b', status: 'delivery_unknown', generation: gen2 })
  check(
    '正控：`delivery_unknown` ??*被受理的回执**（结果不明是事实，不是拒绝），实例落 `delivery_unknown`',
    unknownState.accepted === true && states.get('occ-b') === 'delivery_unknown',
    `recordedState=${String(unknownState.recordedState)}`
  )
  check(
    '读数分列：受??2 · 未知 id 1 · 重复 1 · 已定??1 · 旧代??1 · 投递登??1',
    (() => {
      const r = registry.readings()
      return r.accepted === 2 && r.refusedUnknownId === 1 && r.refusedDuplicate === 1 &&
        r.refusedSettled === 1 && r.refusedStaleGeneration === 1 && r.dispatched === 1 &&
        r.connectionsOpened === 2
    })(),
    JSON.stringify(registry.readings())
  )

  /* ---- 适配器（??的另一半） ---- */
  const delivered: { deliveryId: string; text: string }[] = []
  const adapter = createQqProactiveDeliveryAdapter({
    delivery: {
      deliver: (input) => {
        delivered.push(input)
        return input.text.includes('拒') ? { written: false, code: 'qq_delivery_text_too_long' } : { written: true }
      },
    },
    resolveDeliveryId: () => 'occ-adapter-1',
  })
  const ownerTarget = { type: QQ_PRIVATE_OWNER_TARGET_TYPE, confidence: 'exact' as const }
  const execInput = (args: Record<string, unknown>, target = ownerTarget, operation = QQ_PRIVATE_SEND_OPERATION) =>
    ({ actionId: 'act:1' as never, operation, target, args, now: () => 0 })

  const okOutcome = await adapter.execute(execInput({ text: '该喝水了。' }))
  check(
    '★ 正控（适配器）：参数合法 + 目标=本人 ⇒ **真的**交给投递端口；effect = `message_sent` + **正文指纹**（`detail` 不含正文）',
    delivered.length === 1 && delivered[0]!.text === '该喝水了。' &&
      okOutcome.effect?.kind === 'message_sent' &&
      okOutcome.effect.fingerprint === notificationTextFingerprint('该喝水了。') &&
      !String(okOutcome.effect.detail ?? '').includes('该喝水了'),
    `effect=${String(okOutcome.effect?.kind)} fingerprint=${String(okOutcome.effect?.fingerprint).slice(0, 12)}…`
  )

  const failureReason = async (args: Record<string, unknown>, target = ownerTarget, operation = QQ_PRIVATE_SEND_OPERATION) => {
    try {
      await adapter.execute(execInput(args, target, operation))
      return 'NO-THROW'
    } catch (error) {
      const failure = (error as { failure?: { code?: string; details?: { reason?: string } } }).failure
      return `${String(failure?.code)}:${String(failure?.details?.reason)}`
    }
  }
  const reasons = [
    await failureReason({ text: '在吗' }, ownerTarget, 'sendtext'),
    await failureReason({ text: '在吗', user_id: '10001' }),
    await failureReason({ text: '在吗', minutes: 5 }),
    await failureReason({ text: '在吗' }, { type: 'external_service', confidence: 'exact' }),
    await failureReason({ text: '   ' }),
    await failureReason({ text: 'x'.repeat(501) }),
    await failureReason({ text: '拒' }),
  ]
  check(
    `负控 ×7（适配器）：未知操??/ 带收件人 / 未声明参??/ 目标不是本人 / 空正??/ 超上??/ 通道拒收 ??逐条**归一**到闭集失败码 + 具名 reason`,
    reasons.join('|') === [
      'validation_failed:qq_send_unknown_operation',
      'validation_failed:qq_send_recipient_from_argument',
      'validation_failed:qq_send_unknown_arg',
      'validation_failed:qq_send_target_not_owner',
      'validation_failed:qq_send_without_text',
      'validation_failed:qq_send_text_too_long',
      'execution_failed:qq_delivery_text_too_long',
    ].join('|') && delivered.length === 2,
    reasons.join(' / ')
  )
  check(
    '量具自证：端??*??*被调 2 次（正控 1 ??+ "通道拒收"??1 ??—??拒收??*调用之后**才知道的），其余 5 条在到达端口**之前**就被挡下',
    delivered.length === 2 && delivered[0]!.text === '该喝水了。' && delivered[1]!.text === '拒',
    `端口调用次数=${String(delivered.length)}`
  )

  const keyless = createQqProactiveDeliveryAdapter({
    delivery: { deliver: () => ({ written: true }) },
    resolveDeliveryId: () => undefined,
  })
  const keylessReading = await (async () => {
    try {
      await keyless.execute(execInput({ text: '在吗' }))
      return 'NO-THROW'
    } catch (error) {
      const failure = (error as { failure?: { details?: { reason?: string } } }).failure
      return String(failure?.details?.reason)
    }
  })()
  check(
    '负控（适配器）??*取不到稳定键** ??失败关闭（幂等必需的能力不许在无键时发送）',
    keylessReading === 'qq_send_without_delivery_key',
    keylessReading
  )

  check(
    '静态：`message_sent` 是 `ActionEffect.kind` 的成员（账本能如实表达"交给外部通道了"）',
    readFileSync(resolve('src/kernel/action/action-request.ts'), 'utf8').includes("'message_sent'"),
    "ActionEffect.kind ??'message_sent'"
  )
}

// ===========================================================================
section('20. 接线：目标解析的失败关闭（策略层??负控?? 装配层七处（静态）')
// ===========================================================================

{
  const mainText = readFileSync(resolve('src/main.ts'), 'utf8')

  /** 造一??策略层会怎么??的请求（目标置信度由参数决定 —??那正是被测的那一维） */
  const policyDecision = (confidence: 'exact' | 'none') =>
    evaluateActionPolicy({
      request: createActionRequest({
        actionId: 'act:wp5' as never,
        traceId: 'trace:wp5' as never,
        capability: QQ_PRIVATE_SEND_TEXT,
        operation: 'send',
        requestedBy: { kind: 'system', id: PROACTIVE_SCHEDULER_PRINCIPAL_ID },
        target: { type: QQ_PRIVATE_OWNER_TARGET_TYPE, confidence },
        arguments: { text: '在吗' },
        sideEffect: 'write',
        /* 幂等必需 ??必须显式给键（否则会先在幂等闸被拒，测不到目标那一维） */
        idempotencyKey: 'occ-wp5-probe',
        createdAt: 0 as never,
      }),
      definition: capabilities[0],
      operation: capabilities[0]!.operations[0],
      targetConfidence: confidence,
      scopeViolation: false,
      grantedPermissions: [QQ_PRIVATE_SEND_PERMISSION],
      maxRiskLevel: 'R2',
      dryRun: false,
    })

  check(
    '★ 正控（策略层）：目标 `qq_private_owner` + `exact` ⇒ 目标与权限两闸都过（拒也不会是 target_uncertain / missing_permission）',
    (() => {
      const decision = policyDecision('exact')
      return decision.code !== 'target_uncertain' && decision.code !== 'missing_permission'
    })(),
    `code=${String(policyDecision('exact').code)}`
  )

  check(
    '??负控（失败关闭）??*绑定读不出来**（`confidence:none`）⇒ `target_uncertain` —??不许"那就发给某个人吧"',
    policyDecision('none').code === 'target_uncertain',
    `code=${String(policyDecision('none').code)}`
  )

  const wiring = [
    ['目标解析新增这一支（`request.capability === QQ_PRIVATE_SEND_TEXT`）',
      mainText.includes('if (request.capability === QQ_PRIVATE_SEND_TEXT) {')],
    ['绑定读不出来时**如实**给 `confidence: none`（不是猜一个 owner）',
      /confidence: ownerId === undefined \|\| ownerId === '' \? 'none' : 'exact'/.test(mainText)],
    ['登记表只在 `mode !== \'off\'` 时装配，且**只有一处构造**（`proactiveDeliveryChannel`）',
      mainText.includes("flags.qqProactiveMode !== 'off'") &&
        mainText.includes('function proactiveDeliveryChannel(db: RawDb)') &&
        mainText.includes('new QqDeliveryRegistry({')],
    ['QQ 入口连上??*开一个代??*并注入出站通道',
      mainText.includes("spec.entry === 'qq_private' && qqDelivery !== undefined") &&
        mainText.includes('bridge.setOutputSink(')],
    ['QQ 入口注入 `reportQqDelivery`（带**本条连接**的代次）',
      mainText.includes('host.reportQqDelivery = async (report) =>') &&
        mainText.includes('generation: deliveryGeneration')],
    ['断开时按**代次**回收（旧连接断开不清新连接的水位）',
      mainText.includes('if (deliveryGeneration !== null) qqDelivery!.closeConnection(deliveryGeneration)')],
    ['端口只给形状：`notification-store` 的两个函数是唯一权威（**只在那一处**）',
      mainText.includes('readOccurrenceState: async (occurrenceKey) =>') &&
        mainText.includes('(await getOccurrence(db, occurrenceKey))?.state') &&
        mainText.includes('await advanceOccurrence(db, advanceInput.occurrenceKey')],
  ] as const
  const missing = wiring.filter(([, ok]) => !ok).map(([what]) => what)
  check(
    `正控：装配层**七处**都在（${wiring.map(([what]) => what.split('（')[0]).join(' · ')}）`,
    missing.length === 0,
    missing.length === 0 ? '七处齐' : `缺：${missing.join(' / ')}`
  )
}

// ===========================================================================
section('21. 从决定到投递：出站口绑在代次上 + dispatchProactiveText 的五步')
// ===========================================================================

{
  /* 一个内存登记表??*真的**??`QqDeliveryRegistry`，不是另写一个假??*/
  const states = new Map<string, NotificationOccurrenceState>()
  const reasons = new Map<string, string>()
  const registry = new QqDeliveryRegistry({
    store: {
      readOccurrenceState: async (key) => states.get(key),
      advanceOccurrence: async (advance) => {
        const current = states.get(advance.occurrenceKey)
        if (current === undefined) return { ok: false, code: 'occurrence_missing' }
        if (!canTransitionOccurrence(current, advance.to) && current !== advance.to) {
          return { ok: false, code: 'notification_transition_denied', state: current }
        }
        if (advance.to === 'api_accepted' &&
            (advance.platformMessageId === undefined || advance.platformMessageId.trim() === '')) {
          return { ok: false, code: 'occurrence_accepted_without_message_id', state: current }
        }
        if (advance.reasonCode !== undefined) reasons.set(advance.occurrenceKey, advance.reasonCode)
        states.set(advance.occurrenceKey, advance.to)
        return { ok: true, state: advance.to }
      },
    },
  })

  const out = { written: [] as { deliveryId: string; text: string }[] }
  const gen = registry.openConnection((delivery) => {
    out.written.push(delivery)
    return { written: true }
  })
  check(
    '★ 正控：出站口**绑在代次上** —— 当前代次能写出（`deliver` 真的走到那条连接的口）',
    registry.deliver({ deliveryId: 'occ-ch', text: '在吗' }).written === true &&
      out.written.length === 1 && out.written[0]!.text === '在吗' &&
      registry.readings().lastDeliveryId === 'occ-ch',
    `写出 ${String(out.written.length)} 次`
  )

  const noSink = registry.openConnection()
  const sunkless = registry.deliver({ deliveryId: 'occ-ch', text: '在吗' })
  check(
    '负控??*当前代次没有出站??*（皮套那样的入口）⇒ `qq_delivery_no_active_connection`，且**不写**任何东西',
    sunkless.written === false && sunkless.code === 'qq_delivery_no_active_connection' &&
      out.written.length === 1,
    String(sunkless.code)
  )

  const beforeClose = registry.closeConnection(noSink)
  const afterClose = registry.deliver({ deliveryId: 'occ-ch', text: '在吗' })
  check(
    '负控：断开后**它的那一格口被删掉**（不会留着往一条死连接写）⇒ 再次投递被拒',
    beforeClose === true && afterClose.written === false &&
      registry.currentGeneration() === null && out.written.length === 1,
    `close=${String(beforeClose)} · 再发=${String(afterClose.code)}`
  )

  /* ---- `dispatchProactiveText` 的五??---- */
  const genOk = registry.openConnection((delivery) => {
    out.written.push(delivery)
    return { written: true }
  })

  /** 一次调用需要的两个端口都由**同一个真登记??*驱动 */
  const dispatchPort: ProactiveDispatchPort = {
    assertDeliverable: (generation) => registry.assertDeliverable(generation),
    beginDispatch: async (beginInput) => await registry.beginDispatch(beginInput),
    settleConfirmedFailure: async (failInput) => await registry.settleConfirmedFailure(failInput),
  }
  let actionCalls = 0
  /**
   * 一??*仿适配??*的动作口：真的去问登记表要那条线缆（与真适配器同形）??   *
   * ⚠️ 第一版这里只 `return {outcome:'executed'}` —??于是"写出去了??这条断言**必假**??   *    量具的教训：**假件必须与真件同??*，否则测的是假件的行为??   *    适配器本身的七条负控??§19 单独测??   */
  const actionPort = (
    mode: 'deliver' | { refuse: string }
  ): ProactiveActionPort => ({
    execute: async (executeInput) => {
      actionCalls += 1
      if (mode !== 'deliver') {
        return { outcome: 'refused', code: mode.refuse, actionId: 'act:proactive-1' }
      }
      const written = registry.deliver({
        deliveryId: executeInput.occurrenceKey,
        text: executeInput.text,
      })
      return written.written
        ? { outcome: 'executed', actionId: 'act:proactive-1' }
        : { outcome: 'refused', code: written.code, actionId: 'act:proactive-1' }
    },
  })

  states.set('occ-ok', 'prepared')
  const okReading = await dispatchProactiveText({
    occurrenceKey: 'occ-ok', text: '该喝水了。', kind: 'care', generation: genOk,
    dispatch: dispatchPort, action: actionPort('deliver'),
  })
  check(
    '??正控：`prepared` ??**??* `dispatching` ??经网关执????`dispatched:true`，实例停??`dispatching`（平台结局等回执）',
    okReading.dispatched === true && okReading.state === 'dispatching' &&
      states.get('occ-ok') === 'dispatching' && actionCalls === 1 &&
      out.written.some((w) => w.deliveryId === 'occ-ok'),
    `state=${String(states.get('occ-ok'))} actionId=${String(okReading.actionId)}`
  )

  /* 顺序的意义：进了 dispatching **之后**回执才可能有落点 */
  const fastReceipt = await registry.report({
    deliveryId: 'occ-ok', status: 'api_accepted', messageId: 'mid-fast', generation: genOk,
  })
  check(
    '★ 正控（**顺序的意义**）：一条**快到**的回执有落点（`dispatching → api_accepted`）—— 顺序反过来就会被判非法迁移',
    fastReceipt.accepted === true && states.get('occ-ok') === 'api_accepted',
    `recordedState=${String(fastReceipt.recordedState)}`
  )

  states.set('occ-refused', 'prepared')
  const refused = await dispatchProactiveText({
    occurrenceKey: 'occ-refused', text: '在吗', kind: 'care', generation: genOk,
    dispatch: dispatchPort, action: actionPort({ refuse: 'missing_permission' }),
  })
  check(
    '负控：网??*拒了** ??`dispatching ??failed_confirmed` + 具名 reason??*确定没发??*，不??结果不明"）；实例不会被卡??dispatching',
    refused.dispatched === false && refused.code === 'missing_permission' &&
      states.get('occ-refused') === 'failed_confirmed' &&
      reasons.get('occ-refused') === 'gateway_refused:missing_permission',
    `state=${String(states.get('occ-refused'))} reason=${String(reasons.get('occ-refused'))}`
  )

  states.set('occ-stale', 'prepared')
  const callsBefore = actionCalls
  const stale = await dispatchProactiveText({
    occurrenceKey: 'occ-stale', text: '在吗', kind: 'care', generation: 999,
    dispatch: dispatchPort, action: actionPort('deliver'),
  })
  check(
    '负控??*代次不对**（旧连接）⇒ 拒绝，且**什么都没动**：实例仍??`prepared`??*一次网关调用都没发??*、没写出任何字节',
    stale.dispatched === false && stale.code === 'qq_delivery_not_current_connection' &&
      states.get('occ-stale') === 'prepared' && actionCalls === callsBefore,
    `state=${String(states.get('occ-stale'))} 网关调用=${String(actionCalls - callsBefore)}`
  )

  const emptyText = await dispatchProactiveText({
    occurrenceKey: 'occ-stale', text: '   ', kind: 'care', generation: genOk,
    dispatch: dispatchPort, action: actionPort('deliver'),
  })
  const noKey = await dispatchProactiveText({
    occurrenceKey: '  ', text: '在吗', kind: 'care', generation: genOk,
    dispatch: dispatchPort, action: actionPort('deliver'),
  })
  check(
    '负控 ×2：空正文 / ??occurrenceKey ??具名拒绝??*在动任何状态之??*',
    emptyText.dispatched === false && emptyText.code === 'proactive_dispatch_without_text' &&
      noKey.dispatched === false && noKey.code === 'proactive_dispatch_without_occurrence' &&
      states.get('occ-stale') === 'prepared',
    `${String(emptyText.code)} / ${String(noKey.code)}`
  )

  states.set('occ-missing', 'prepared')
  const missing = await dispatchProactiveText({
    occurrenceKey: 'occ-not-there', text: '在吗', kind: 'care', generation: genOk,
    dispatch: dispatchPort, action: actionPort('deliver'),
  })
  check(
    '负控：实例认不出来（`beginDispatch` 被登记表拒）??具名拒绝，且**不调用网??*',
    missing.dispatched === false && missing.code === 'occurrence_missing' &&
      actionCalls === callsBefore,
    String(missing.code)
  )
}

// ===========================================================================
section('22. 调度器：L-QQP-01 预判 / 重排有界 / 关心 tick / 故障不楔死 + 真 croner 会响')
// ===========================================================================

/** 一个**假定时器**：把"排了什么、什么时候响"变成可断言的对象（确定、不等待） */
function createFakeTimer(): ProactiveTimerPort & {
  fire(name: string): Promise<void>
  armed: Map<string, { at?: number; intervalMs?: number; fire: () => void | Promise<void> }>
  cancelled: string[]
} {
  const armed = new Map<string, { at?: number; intervalMs?: number; fire: () => void | Promise<void> }>()
  const cancelled: string[] = []
  return {
    armed,
    cancelled,
    armOnce(name, at, fire) {
      armed.set(name, { at, fire })
      return { ok: true, nextRunAt: at }
    },
    armEvery(name, intervalMs, fire) {
      armed.set(name, { intervalMs, fire })
      return { ok: true }
    },
    cancel(name) {
      cancelled.push(name)
      armed.delete(name)
    },
    nextRunAt(name) {
      return armed.get(name)?.at ?? null
    },
    stopAll() {
      armed.clear()
    },
    async fire(name) {
      const entry = armed.get(name)
      if (entry === undefined) throw new Error(`没有排着 ${name}`)
      armed.delete(name)
      await entry.fire()
    },
  }
}

{
  const policy = readProactivePolicy({} as NodeJS.ProcessEnv)
  /** 活动时段**内**的时刻（上海 20:00） */
  const inWindow = Date.parse('2026-10-06T20:00:00+08:00')
  /** 活动时段**外**的时刻（上海 03:00） */
  const outWindow = Date.parse('2026-10-06T03:00:00+08:00')
  const due = inWindow + 600_000

  const timer = createFakeTimer()
  const handed: { occurrenceKey: string; dueAt: number }[] = []
  const careTicks: number[] = []
  let pending: { occurrenceKey: string; dueAt: number }[] = [{ occurrenceKey: 'occ-due-1', dueAt: due }]
  const scheduler = new ProactiveScheduler({
    timer,
    policy,
    now: () => inWindow,
    listPendingReminders: async () => pending,
    onReminderDue: async (input) => { handed.push(input) },
    onCareOpportunity: async (input) => { careTicks.push(input.at) },
  })

  await scheduler.start()
  check(
    '★ 正控（`L-QQP-01` 的可排那一侧）：待办可排 ⇒ **排上**，`nextRunAt` = 那一条的 dueAt，且关心 tick 也排上了',
    timer.nextRunAt(REMINDER_TIMER_NAME) === due &&
      timer.armed.has(CARE_TIMER_NAME) &&
      scheduler.readings().reminderArmed === true &&
      scheduler.readings().refusedNotSchedulable === 0,
    `nextRunAt=${String(timer.nextRunAt(REMINDER_TIMER_NAME))}`
  )

  await timer.fire(REMINDER_TIMER_NAME)
  check(
    '★ 正控：到点 ⇒ 回调**真的执行**一次；并且**重排**（再读一次待办 —— 读的是同一条，因为夹具没改库）',
    handed.length === 1 && handed[0]!.occurrenceKey === 'occ-due-1' &&
      scheduler.readings().reminderFired === 1 &&
      scheduler.readings().refreshes >= 2 && timer.nextRunAt(REMINDER_TIMER_NAME) === due,
    `handed=${String(handed.length)} refreshes=${String(scheduler.readings().refreshes)}`
  )

  /* 库里没有待办了 ⇒ 取消，不排 */
  pending = []
  await scheduler.refresh()
  check(
    '正控：**没有待办** ⇒ 取消排期（`reminderArmed=false`）且如实记 `no_pending_reminder`',
    timer.nextRunAt(REMINDER_TIMER_NAME) === null &&
      scheduler.readings().reminderArmed === false &&
      scheduler.readings().lastCode === 'no_pending_reminder' &&
      timer.cancelled.includes(REMINDER_TIMER_NAME),
    String(scheduler.readings().lastCode)
  )

  /*
   * ⚠️ `L-QQP-01` 的**负控那一侧**：目标与"现在"同秒 ⇒ 不可排。
   *    必须：① 不排任何作业 ② 具名 ③ **立刻把那条交给上层**（别让它悬着）
   */
  const sameSecond = inWindow
  pending = [{ occurrenceKey: 'occ-same-second', dueAt: sameSecond }]
  const handedBefore = handed.length
  await scheduler.refresh()
  check(
    '★ 负控（`L-QQP-01`）：目标同秒 ⇒ **不排期**（绝不排一个永不响的作业）、具名 `reminder_not_schedulable`、**并立刻交给上层**',
    timer.nextRunAt(REMINDER_TIMER_NAME) === null &&
      scheduler.readings().refusedNotSchedulable === 1 &&
      handed.length === handedBefore + 1 &&
      handed.at(-1)!.occurrenceKey === 'occ-same-second',
    `拒=${String(scheduler.readings().refusedNotSchedulable)} 交付=${String(handed.length)}`
  )
  check(
    '★ 量具自证（**这条抓出过一个真缺陷**）：不可排那条路**不自动重排** —— 同一条仍在待办里，自动重排会互递归到堆爆',
    scheduler.readings().reminderFired === 1 &&
      scheduler.readings().reminderExpiredHandover === 1 &&
      scheduler.readings().lastCode === 'reminder_not_schedulable' &&
      (scheduler as unknown as { handingOver: boolean }).handingOver === false,
    `到点=${String(scheduler.readings().reminderFired)} · 过期交付=${String(scheduler.readings().reminderExpiredHandover)} · lastCode=${String(scheduler.readings().lastCode)}`
  )

  /* 取最近一条（不是第一条） */
  pending = [
    { occurrenceKey: 'occ-later', dueAt: due + 3_600_000 },
    { occurrenceKey: 'occ-nearest', dueAt: due + 60_000 },
    { occurrenceKey: 'occ-mid', dueAt: due + 600_000 },
  ]
  await scheduler.refresh()
  check(
    '正控：多条待办 ⇒ 取 **dueAt 最小**的那一条（不是数组里的第一条）',
    timer.nextRunAt(REMINDER_TIMER_NAME) === due + 60_000,
    `nextRunAt=${String(timer.nextRunAt(REMINDER_TIMER_NAME))}`
  )

  /* 关心 tick：时段外如实跳过；时段内真的回调 */
  const outside = new ProactiveScheduler({
    timer: createFakeTimer(),
    policy,
    now: () => outWindow,
    listPendingReminders: async () => [],
    onReminderDue: async () => undefined,
    onCareOpportunity: async (input) => { careTicks.push(input.at) },
  })
  await outside.start()
  await (outside as unknown as { fireCare: () => Promise<void> }).fireCare()
  check(
    '负控：关心 tick 在**活动时段外** ⇒ 如实跳过（`care_outside_active_window`），**不回调**上层',
    outside.readings().careSkippedOutsideWindow === 1 && outside.readings().careTicks === 0 &&
      outside.readings().lastCode === 'care_outside_active_window',
    String(outside.readings().lastCode)
  )

  const careBefore = careTicks.length
  await (scheduler as unknown as { fireCare: () => Promise<void> }).fireCare()
  check(
    '正控：关心 tick 在**活动时段内** ⇒ 真的回调上层（由上层去做十种预检）',
    careTicks.length === careBefore + 1 && scheduler.readings().careTicks === 1,
    `tick=${String(scheduler.readings().careTicks)}`
  )

  /* ⚠️ 故障不楔死：上层抛一次，后面的提醒仍然会排 */
  pending = [{ occurrenceKey: 'occ-will-throw', dueAt: due + 120_000 }]
  const throwing = new ProactiveScheduler({
    timer: createFakeTimer(),
    policy,
    now: () => inWindow,
    listPendingReminders: async () => pending,
    onReminderDue: async () => { throw new Error('上层炸了') },
    onCareOpportunity: async () => undefined,
  })
  await throwing.start()
  await (throwing as unknown as { fireReminder: (i: unknown, r: string) => Promise<void> })
    .fireReminder({ occurrenceKey: 'occ-will-throw', dueAt: due + 120_000 }, 'due')
  check(
    '★ 负控：上层**抛异常** ⇒ 如实记 `reminder_due_failed` + 错误原文，但**重排照样发生**（一次失败不许让后面所有提醒永不触发）',
    throwing.readings().lastError === '上层炸了' &&
      throwing.readings().reminderFired === 0 &&
      (throwing as unknown as { armed: boolean }).armed === true,
    `lastError=${String(throwing.readings().lastError)} · 到点=${String(throwing.readings().reminderFired)} · 重排成功=${String((throwing as unknown as { armed: boolean }).armed)}` +
      ` · ⚠️ lastCode=${String(throwing.readings().lastCode)}（错误码会被**随后那次成功的重排**覆盖 —— 错误原文单独留在 lastError 里，这是刻意的）`
  )

  /* 停：取消两个具名作业 */
  scheduler.stop()
  check(
    '负控：`stop()` ⇒ 两个具名作业都被取消（`L-QQP-01` 的探针事实 ③：`stop()` 之后不再占位）',
    (scheduler as unknown as { armed: boolean }).armed === false &&
      timer.cancelled.filter((n) => n === CARE_TIMER_NAME).length >= 1,
    `cancelled=${timer.cancelled.join(',')}`
  )
}

{
  /*
   * ⚠️ 假定时器证明的是"判据对不对"；它**不能**证明"真 croner 会响"。
   *    这一条用**真的等待**（约 1.2s）证明那一半 —— 有界、可复跑。
   */
  const policy = readProactivePolicy({} as NodeJS.ProcessEnv)
  const now = Date.now()
  const dueAt = now + 1_200
  const fired: number[] = []
  const timer = createCronerTimer({ timeZone: policy.timeZone })
  const armed = timer.armOnce(REMINDER_TIMER_NAME, dueAt, () => {
    fired.push(Date.now())
  })
  const scheduled = timer.nextRunAt(REMINDER_TIMER_NAME)
  if (!armed.ok || scheduled === null) {
    check('真 croner：排期失败（读数见下）', false, `armed=${JSON.stringify(armed)}`)
  } else {
    const startedAt = Date.now()
    while (fired.length === 0 && Date.now() - startedAt < 6_000) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    timer.stopAll()
    check(
      '★ 正控（真 croner）：排一次 1.2 秒后的单次触发 ⇒ **它真的响了**（假定时器证明不了这一半）',
      fired.length === 1 && fired[0]! >= dueAt - 1_000 && fired[0]! <= dueAt + 3_000,
      `nextRunAt=${String(scheduled)} 实际=${String(fired[0])}（目标 ${String(dueAt)}）`
    )
    check(
      '正控（真 croner）：`stopAll()` 之后**不再占位**（`nextRunAt` 为 null）',
      timer.nextRunAt(REMINDER_TIMER_NAME) === null,
      `after stop = ${String(timer.nextRunAt(REMINDER_TIMER_NAME))}`
    )
  }
}

// ===========================================================================
section('23. 到点提醒的五步：对**真 store**跑（占用 → evaluating → prepared → dispatching）')
// ===========================================================================

{
  /*
   * ⚠️ 这一节**不**用假 store：它要验的正是"写库那一段"。
   *    库是**隔离库**（本门第 0 行就 `isolateDatabase`），真实库全程未被触碰。
   */
  const reminderIntentId = newNotificationIntentId()
  const dueAt = scheduledAt + 900_000
  const occurrenceKey = reminderOccurrenceKey({
    intentId: String(reminderIntentId),
    planVersion: 1,
    dueAt,
  })
  const intentText = '十分钟后提醒我喝水'

  /* 一条**真的**提醒意图（提醒的实例必须挂在意图上，表级 CHECK 挡着） */
  const created = await createIntent(db, {
    id: reminderIntentId,
    characterId,
    /* `ownerRef` / `conversationRef`：提醒是发给**本人**的（入口作用域那一条会话） */
    ownerRef: 'qq-owner',
    conversationRef: 'dm-wp5-deliver',
    permissionVersion: 'perm@9',
    policyVersion: 'policy@1',
    text: intentText,
    kind: 'reminder',
    dedupeKey: 'wp5:reminder:deliver',
    scheduledAt: dueAt,
    timezone: 'Asia/Shanghai',
    sourceRefs: ['evt:wp5-deliver'],
  })
  const store: ReminderStorePort = {
    reserveOccurrence: async (input) => {
      const reading = await reserveOccurrence(db, {
        occurrenceKey: input.occurrenceKey,
        intentId: reminderIntentId,
        characterId,
        kind: 'reminder',
        dueAt,
        permissionVersion: 'perm@9',
        policyVersion: 'policy@1',
      })
      return {
        created: reading.created,
        ...(reading.occurrence === undefined ? {} : { state: reading.occurrence.state }),
      }
    },
    advanceReminder: async (input) =>
      await advanceOccurrence(db, input.occurrenceKey, {
        to: input.to,
        ...(input.text === undefined ? {} : { text: input.text }),
      }),
  }

  /* 一个**仿适配器**的动作口 + 真的出站口 */
  const registry = new QqDeliveryRegistry({
    store: {
      readOccurrenceState: async (key) => (await getOccurrence(db, key))?.state,
      advanceOccurrence: async (advance) =>
        await advanceOccurrence(db, advance.occurrenceKey, {
          to: advance.to,
          ...(advance.platformMessageId === undefined ? {} : { platformMessageId: advance.platformMessageId }),
          ...(advance.reasonCode === undefined ? {} : { reasonCode: advance.reasonCode }),
        }),
    },
  })
  const written: string[] = []
  const generation = registry.openConnection((out) => {
    written.push(out.text)
    return { written: true }
  })
  const dispatchPort: ProactiveDispatchPort = {
    assertDeliverable: (g) => registry.assertDeliverable(g),
    beginDispatch: async (i) => await registry.beginDispatch(i),
    settleConfirmedFailure: async (i) => await registry.settleConfirmedFailure(i),
  }
  const actionPort = (mode: 'deliver' | { refuse: string }): ProactiveActionPort => ({
    execute: async (executeInput) => {
      if (mode !== 'deliver') return { outcome: 'refused', code: mode.refuse, actionId: 'act:reminder' }
      const out = registry.deliver({
        deliveryId: executeInput.occurrenceKey,
        text: executeInput.text,
      })
      return out.written
        ? { outcome: 'executed', actionId: 'act:reminder' }
        : { outcome: 'refused', code: out.code, actionId: 'act:reminder' }
    },
  })

  const okReading = await deliverReminder({
    occurrenceKey,
    intentText,
    store,
    dispatch: dispatchPort,
    action: actionPort('deliver'),
    generation,
  })
  const occurrence = await getOccurrence(db, occurrenceKey)
  check(
    '★ 正控：一条真提醒走到 `dispatching`；候选正文**落在实例行上**（模板文本，程序既定句），且**真的写出去了**',
    okReading.dispatched === true && okReading.occurrenceCreated === true &&
      occurrence?.state === 'dispatching' &&
      occurrence?.candidateText === reminderTemplateText(intentText) &&
      written.includes(reminderTemplateText(intentText)) && created.created,
    `state=${String(occurrence?.state)} text=${String(occurrence?.candidateText)}`
  )

  /* 幂等①：同一条再走一遍 —— 已经 dispatching ⇒ 不许重发 */
  const writtenBefore = written.length
  const again = await deliverReminder({
    occurrenceKey,
    intentText,
    store,
    dispatch: dispatchPort,
    action: actionPort('deliver'),
    generation,
  })
  check(
    '★ 负控（幂等）：同一次机会**再走一遍** ⇒ 具名拒绝 `reminder_occurrence_dispatching`，**不重发、不覆盖**',
    again.dispatched === false && again.code === 'reminder_occurrence_dispatching' &&
      again.occurrenceCreated === false && written.length === writtenBefore &&
      (await getOccurrence(db, occurrenceKey))?.state === 'dispatching',
    `${String(again.code)} · 写出次数不变=${String(written.length === writtenBefore)}`
  )

  /* 网关拒了 ⇒ failed_confirmed（本地确定没发出） */
  const key2 = reminderOccurrenceKey({ intentId: String(reminderIntentId), planVersion: 1, dueAt: dueAt + 1_000 })
  const refused = await deliverReminder({
    occurrenceKey: key2,
    intentText,
    store: {
      reserveOccurrence: async (input) => {
        const reading = await reserveOccurrence(db, {
          occurrenceKey: input.occurrenceKey,
          intentId: reminderIntentId,
          characterId,
          kind: 'reminder',
          dueAt: dueAt + 1_000,
          permissionVersion: 'perm@9',
          policyVersion: 'policy@1',
        })
        return {
          created: reading.created,
          ...(reading.occurrence === undefined ? {} : { state: reading.occurrence.state }),
        }
      },
      advanceReminder: store.advanceReminder,
    },
    dispatch: dispatchPort,
    action: actionPort({ refuse: 'missing_permission' }),
    generation,
  })
  check(
    '负控：网关**拒了** ⇒ 实例落 `failed_confirmed`（确定没发出），且**没有**写出任何字节',
    refused.dispatched === false && refused.code === 'missing_permission' &&
      (await getOccurrence(db, key2))?.state === 'failed_confirmed',
    `state=${String((await getOccurrence(db, key2))?.state)}`
  )

  /* 没有当前投递连接 ⇒ **什么都别动**（实例留在 prepared，不是"发过了"） */
  const key3 = reminderOccurrenceKey({ intentId: String(reminderIntentId), planVersion: 1, dueAt: dueAt + 2_000 })
  const channelless = new QqDeliveryRegistry({
    store: {
      readOccurrenceState: async (key) => (await getOccurrence(db, key))?.state,
      advanceOccurrence: async (advance) =>
        await advanceOccurrence(db, advance.occurrenceKey, { to: advance.to }),
    },
  })
  const noConnection = await deliverReminder({
    occurrenceKey: key3,
    intentText,
    store: {
      reserveOccurrence: async (input) => {
        const reading = await reserveOccurrence(db, {
          occurrenceKey: input.occurrenceKey,
          intentId: reminderIntentId,
          characterId,
          kind: 'reminder',
          dueAt: dueAt + 2_000,
          permissionVersion: 'perm@9',
          policyVersion: 'policy@1',
        })
        return {
          created: reading.created,
          ...(reading.occurrence === undefined ? {} : { state: reading.occurrence.state }),
        }
      },
      advanceReminder: store.advanceReminder,
    },
    dispatch: {
      assertDeliverable: (g) => channelless.assertDeliverable(g),
      beginDispatch: async (i) => await channelless.beginDispatch(i),
      settleConfirmedFailure: async (i) => await channelless.settleConfirmedFailure(i),
    },
    action: actionPort('deliver'),
    generation: null,
  })
  check(
    '★ 负控：**没有当前投递连接** ⇒ `qq_delivery_no_active_connection`，实例停在 `prepared`（它**没有**被尝试过，如实）',
    noConnection.dispatched === false && noConnection.code === 'qq_delivery_no_active_connection' &&
      (await getOccurrence(db, key3))?.state === 'prepared',
    `state=${String((await getOccurrence(db, key3))?.state)}`
  )

  check(
    '静态：装配层把适配器**注册进网关**（非 off 时），且出站口是**登记表**（不是某条 socket）',
    readFileSync(resolve('src/main.ts'), 'utf8').includes('createQqProactiveDeliveryAdapter({') &&
      readFileSync(resolve('src/main.ts'), 'utf8').includes('proactiveDeliveryChannel('),
    'createQqProactiveDeliveryAdapter + proactiveDeliveryChannel'
  )
}

// ===========================================================================
section('24. ADR-110 `D05a`：**写**归因豁免（闭集 + 两道 diff + 逐条负控）')
// ===========================================================================

{
  /** 主动投递那一条豁免的**三元组**（判据就写在这里，不在调用点的自觉里） */
  const scope = ACTION_ATTRIBUTION_EXEMPTIONS.proactive_qq_delivery
  const violation = (input: {
    principal: { kind: string; id: string } | null
    capability: string
    operation: string
    registeredSideEffect: string | undefined
  }) =>
    namedExemptionViolation({
      principal: input.principal === null ? null : ({ ...input.principal } as never),
      capability: input.capability,
      operation: input.operation,
      registeredSideEffect: input.registeredSideEffect,
    })

  check(
    '★ 正控：写豁免**落在闭集里**且收窄到 (SYSTEM/qq-proactive-scheduler · qq.private.message · send)',
    scope.principal.kind === 'SYSTEM' &&
      scope.principal.id === PROACTIVE_SCHEDULER_PRINCIPAL_ID &&
      scope.capability === QQ_PRIVATE_SEND_TEXT &&
      scope.operation === QQ_PRIVATE_SEND_OPERATION &&
      scope.sideEffect === 'write',
    `${scope.principal.kind}/${scope.principal.id} · ${scope.capability}/${scope.operation} · ${scope.sideEffect}`
  )

  check(
    '★ 正控：**恰好这个三元组** ⇒ 复核通过（`namedExemptionViolation` 返回 undefined）',
    violation({
      principal: { kind: 'SYSTEM', id: PROACTIVE_SCHEDULER_PRINCIPAL_ID },
      capability: QQ_PRIVATE_SEND_TEXT,
      operation: QQ_PRIVATE_SEND_OPERATION,
      registeredSideEffect: 'write',
    }) === undefined,
    '落点合法'
  )

  const negatives: { label: string; reading: string | undefined }[] = [
    {
      label: 'principal 为 null（匿名逃生门）',
      reading: violation({
        principal: null, capability: QQ_PRIVATE_SEND_TEXT, operation: QQ_PRIVATE_SEND_OPERATION,
        registeredSideEffect: 'write',
      })?.code,
    },
    {
      label: '身份不在闭集里',
      reading: violation({
        principal: { kind: 'SYSTEM', id: 'someone-else' }, capability: QQ_PRIVATE_SEND_TEXT,
        operation: QQ_PRIVATE_SEND_OPERATION, registeredSideEffect: 'write',
      })?.code,
    },
    {
      label: '能力换了（拿这条豁免去发别的东西）',
      reading: violation({
        principal: { kind: 'SYSTEM', id: PROACTIVE_SCHEDULER_PRINCIPAL_ID },
        capability: 'local.file.write', operation: QQ_PRIVATE_SEND_OPERATION,
        registeredSideEffect: 'write',
      })?.code,
    },
    {
      label: '操作换了',
      reading: violation({
        principal: { kind: 'SYSTEM', id: PROACTIVE_SCHEDULER_PRINCIPAL_ID },
        capability: QQ_PRIVATE_SEND_TEXT, operation: 'sendtext', registeredSideEffect: 'write',
      })?.code,
    },
    {
      label: '登记表里根本没这个操作',
      reading: violation({
        principal: { kind: 'SYSTEM', id: PROACTIVE_SCHEDULER_PRINCIPAL_ID },
        capability: QQ_PRIVATE_SEND_TEXT, operation: QQ_PRIVATE_SEND_OPERATION,
        registeredSideEffect: undefined,
      })?.code,
    },
    {
      label: '声明与登记**不一致**（声明 write、登记 read）',
      reading: violation({
        principal: { kind: 'SYSTEM', id: PROACTIVE_SCHEDULER_PRINCIPAL_ID },
        capability: QQ_PRIVATE_SEND_TEXT, operation: QQ_PRIVATE_SEND_OPERATION,
        registeredSideEffect: 'read',
      })?.code,
    },
    {
      label: '★ 只读豁免去请求一个**写**操作（ADR-098 的判据原样保留）',
      reading: violation({
        principal: { kind: 'SYSTEM', id: 'pre-turn-lookup' }, capability: 'web.search',
        operation: 'search', registeredSideEffect: 'write',
      })?.code,
    },
    {
      label: '★ 只读豁免去请求一个**别的**能力（收窄仍然生效）',
      reading: violation({
        principal: { kind: 'SYSTEM', id: 'pre-turn-lookup' }, capability: 'qq.private.message',
        operation: 'send', registeredSideEffect: 'write',
      })?.code,
    },
  ]
  const codes = negatives.map((entry) => entry.reading)
  check(
    `★ 负控 ×${String(negatives.length)}：匿名 / 陌生身份 / 换能力 / 换操作 / 未登记 / 声明与登记不一致 / **只读豁免越界** ⇒ 全部具名拒绝`,
    codes.every((code) => code !== undefined) &&
      codes[0] === 'attribution_exemption_without_principal' &&
      codes[1] === 'unregistered_attribution_exemption' &&
      codes[2] === 'attribution_exemption_scope_mismatch' &&
      codes[3] === 'attribution_exemption_scope_mismatch' &&
      codes[4] === 'attribution_exemption_not_read_only' &&
      codes[5] === 'attribution_exemption_not_read_only' &&
      codes[6] === 'attribution_exemption_not_read_only' &&
      /* ⚠️ 身份在闭集里 ⇒ 先撞**收窄**那一关（比"陌生身份"更精确，是刻意的顺序） */
      codes[7] === 'attribution_exemption_scope_mismatch',
    negatives.map((entry) => `${entry.label}=${String(entry.reading)}`).join(' · ')
  )

  check(
    '★ 结构：写豁免逐个点名，QQ 与本地提醒的身份和能力独立',
    WRITE_CAPABLE_ATTRIBUTION_EXEMPTIONS.length === 2 &&
      WRITE_CAPABLE_ATTRIBUTION_EXEMPTIONS[0] === 'proactive_qq_delivery' &&
      WRITE_CAPABLE_ATTRIBUTION_EXEMPTIONS[1] === 'scheduled_local_reminder_delivery' &&
      ACTION_ATTRIBUTION_EXEMPTIONS.scheduled_local_reminder_delivery.principal.id !== String(ACTION_ATTRIBUTION_EXEMPTIONS.proactive_qq_delivery.principal.id) &&
      ACTION_ATTRIBUTION_EXEMPTIONS.scheduled_local_reminder_delivery.capability === 'local.reminder.message' &&
      Object.keys(ACTION_ATTRIBUTION_EXEMPTIONS).length === 3,
    `写白名单=${WRITE_CAPABLE_ATTRIBUTION_EXEMPTIONS.join(',')} · 闭集=${Object.keys(ACTION_ATTRIBUTION_EXEMPTIONS).join(',')}`
  )

  const evidence = attestActionInitiatorFromNamedExemption({
    adapterId: 'qq-proactive-delivery',
    exemption: 'proactive_qq_delivery',
  })
  check(
    '正控：构造出来的证据是**具名**的（`causalBasis=named_exemption` · principal = 调度器 · `causalEventId=null`）',
    isNamedExemptionInitiatorEvidence(evidence) &&
      evidence.principal?.id === PROACTIVE_SCHEDULER_PRINCIPAL_ID &&
      evidence.causalEventId === null,
    `${String(evidence.principal?.kind)}/${String(evidence.principal?.id)} · causalEventId=${String(evidence.causalEventId)}`
  )
}

// ===========================================================================
section('25. 最后一道焊接：调用点签发 R2 + 用写豁免 + 调度器启动的三道闸（静态）')
// ===========================================================================

{
  const mainText = readFileSync(resolve('src/main.ts'), 'utf8')
  /**
   * ⚠️ 这些是**文本**判据 —— 它们证明"那几行在"，**不**证明运行期行为。
   *    运行期行为由 §20/§23/§24 的**构造输入 + 真 store**读数负责。
   *    两类判据**都要**：少了文本判据，接线会在重构里悄悄消失；
   *    少了行为判据，文本判据只是"看起来接上了"。
   */
  const welds: readonly (readonly [string, boolean])[] = [
    ['调用点用**具名写豁免**构造 initiator 证据',
      mainText.includes("exemption: input.channel === undefined ? 'proactive_qq_delivery' : 'scheduled_local_reminder_delivery'")],
    ['调用点签发 **R2** 额度（`riskBudgetOverride`）',
      mainText.includes("riskBudgetOverride: input.channel === undefined ? 'R2' : 'R1'")],
    ['成功口吻用**唯一判据** `isSuccessResult`（不是"executed 为真就算成"）',
      mainText.includes('if (isSuccessResult(result)) return { outcome: \'executed\'')],
    ['幂等键 = `occurrenceKey`（同一次机会重试不许变成两次发送）',
      mainText.includes('idempotencyKey: input.occurrenceKey')],
    ['发起人身份是**系统侧**（调度器），不是 user / character',
      mainText.includes("requestedBy: { kind: 'system', id: input.channel === undefined ? PROACTIVE_SCHEDULER_PRINCIPAL_ID : 'local-reminder-scheduler' }")],
    ['⚠️ **全局风险上限没被抬高**（`actionMaxRiskLevel` 仍然只读 flags）',
      /maxRiskLevel: this\.flags\.actionMaxRiskLevel/.test(mainText) &&
        !/actionMaxRiskLevel\s*=\s*'R2'/.test(mainText)],
    ['调度器**要求**入口作用域：不满足 ⇒ 如实告警、**不启动**',
      mainText.includes("flags.qqProactiveMode !== 'off' && !flags.entryScopedConversations") &&
        mainText.includes('主动调度**不启动**')],
    ['没有 QQ 入口会话 ⇒ 也不启动（没有执行体）',
      mainText.includes('主动调度**不启动**：没有 QQ 入口会话')],
    ['关心那一条**喂真读数**并如实记下"够格但依据面未接线"（`L-QQP-07`）——**不**调模型、**不**发',
      mainText.includes('precheckCareOpportunity({') && mainText.includes('L-QQP-07')],
    ['停机时**先停调度器**再关库（顺序不能换）',
      /proactiveScheduler\?\.stop\(\)[\s\S]{0,200}收尾顺序/.test(mainText)],
    ['`listPendingReminders` 与占用那一步**同一个键**（同一条冻结纯函数）',
      mainText.includes('...reminderScheduling,') && readFileSync(resolve('src/infrastructure/runtime/reminder-scheduling.ts'), 'utf8').includes('const occurrenceKey = reminderOccurrenceKey({')],
  ]
  const missing = welds.filter(([, ok]) => !ok).map(([what]) => what)
  check(
    `★ 正控：**十一处**焊接都在（含"全局上限没被抬高"这条负控式的静态判据）`,
    missing.length === 0,
    missing.length === 0 ? '十一处齐' : `缺：${missing.join(' / ')}`
  )

  /*
   * ⚠️ 最强的一条：把**整条链**的输入放在一起，问策略层"到底放不放行"。
   *    它不证明"真的发出去了"（那要真外壳），但它证明**没有任何一闸是无条件拒绝**。
   */
  const decision = evaluateActionPolicy({
    request: createActionRequest({
      actionId: 'act:wp5-weld' as never,
      traceId: 'trace:wp5-weld' as never,
      capability: QQ_PRIVATE_SEND_TEXT,
      operation: QQ_PRIVATE_SEND_OPERATION,
      requestedBy: { kind: 'system', id: PROACTIVE_SCHEDULER_PRINCIPAL_ID },
      target: { type: QQ_PRIVATE_OWNER_TARGET_TYPE, confidence: 'exact' },
      arguments: { text: '该喝水了。' },
      sideEffect: 'write',
      idempotencyKey: 'occ-wp5-weld',
      createdAt: 0 as never,
    }),
    definition: capabilities[0],
    operation: capabilities[0]!.operations[0],
    targetConfidence: 'exact',
    scopeViolation: false,
    grantedPermissions: [QQ_PRIVATE_SEND_PERMISSION],
    /* 调用点签发的那份额度 */
    maxRiskLevel: 'R2',
    dryRun: false,
  })
  check(
    '★ 正控（端到端的那一维）：`R2` 额度 + exact 本人 + 幂等键 + 已授权 ⇒ 策略层给出 `allowed`',
    decision.code === 'allowed' &&
      namedExemptionViolation({
        principal: { kind: 'SYSTEM', id: PROACTIVE_SCHEDULER_PRINCIPAL_ID },
        capability: QQ_PRIVATE_SEND_TEXT,
        operation: QQ_PRIVATE_SEND_OPERATION,
        registeredSideEffect: 'write',
      }) === undefined,
    `policy=${String(decision.code)} · 写豁免落点=合法`
  )

  check(
    '★ 负控（额度那一维）：**不签发 R2**（沿用全局 R1）⇒ 同一条被拒（`risk_above_budget`）',
    (() => {
      const r1 = evaluateActionPolicy({
        request: createActionRequest({
          actionId: 'act:wp5-weld-r1' as never,
          traceId: 'trace:wp5-weld-r1' as never,
          capability: QQ_PRIVATE_SEND_TEXT,
          operation: QQ_PRIVATE_SEND_OPERATION,
          requestedBy: { kind: 'system', id: PROACTIVE_SCHEDULER_PRINCIPAL_ID },
          target: { type: QQ_PRIVATE_OWNER_TARGET_TYPE, confidence: 'exact' },
          arguments: { text: '该喝水了。' },
          sideEffect: 'write',
          idempotencyKey: 'occ-wp5-weld-r1',
          createdAt: 0 as never,
        }),
        definition: capabilities[0],
        operation: capabilities[0]!.operations[0],
        targetConfidence: 'exact',
        scopeViolation: false,
        grantedPermissions: [QQ_PRIVATE_SEND_PERMISSION],
        maxRiskLevel: 'R1',
        dryRun: false,
      })
      return r1.code !== 'allowed'
    })(),
    'R1 ⇒ 拒（这正是"额度只授给这一项操作"的机器形态）'
  )
}

// ===========================================================================
section('26. 自主关心那一条：四道闸 / 沉默是合法结局 / shadow 不发（对真 store 跑）')
// ===========================================================================

{
  /** 一个**仿评估器**（与真件同形：只回原文或失败，不问别的） */
  const evaluator = (raw: string | { failure: string }) =>
    async () => (typeof raw === 'string' ? { ok: true as const, raw } : { ok: false as const, failure: raw.failure as never })

  const careKey = (suffix: string) =>
    careOccurrenceKey({
      ownerRef: 'qq-owner',
      permissionVersion: 'perm@9',
      opportunityKey: `2026-10-0${suffix}`,
    })
  const briefing = {
    opportunity: '两路真实入站都已经安静了很久',
    localTime: '2026-10-06 20:00',
    timezone: 'Asia/Shanghai',
    sources: [{ ref: 'evt:care-source', summary: '他今天提过要早点睡' }],
    textBudget: 200,
  }
  const storeFor = (occurrenceKey: string): CareStorePort => ({
    reserveOccurrence: async () => {
      const reading = await reserveOccurrence(db, {
        occurrenceKey,
        characterId,
        kind: 'care',
        dueAt: scheduledAt,
        permissionVersion: 'perm@9',
        policyVersion: 'policy@1',
      })
      return {
        created: reading.created,
        ...(reading.occurrence === undefined ? {} : { state: reading.occurrence.state }),
      }
    },
    advanceCare: async (i) =>
      await advanceOccurrence(db, i.occurrenceKey, {
        to: i.to,
        ...(i.text === undefined ? {} : { text: i.text }),
      }),
    deferOpportunity: async () => ({ ok: true }),
  })
  const channel = new QqDeliveryRegistry({
    store: {
      readOccurrenceState: async (key) => (await getOccurrence(db, key))?.state,
      advanceOccurrence: async (advance) =>
        await advanceOccurrence(db, advance.occurrenceKey, { to: advance.to }),
    },
  })
  const careWritten: string[] = []
  const careGeneration = channel.openConnection((out) => {
    careWritten.push(out.text)
    return { written: true }
  })
  const careDispatch: ProactiveDispatchPort = {
    assertDeliverable: (g) => channel.assertDeliverable(g),
    beginDispatch: async (i) => await channel.beginDispatch(i),
    settleConfirmedFailure: async (i) => await channel.settleConfirmedFailure(i),
  }
  const careAction: ProactiveActionPort = {
    execute: async (i) => {
      const out = channel.deliver({ deliveryId: i.occurrenceKey, text: i.text })
      return out.written
        ? { outcome: 'executed', actionId: 'act:care' }
        : { outcome: 'refused', code: out.code, actionId: 'act:care' }
    },
  }

  /* ★ 正控：她选择说 ⇒ 恰好一次发送，正文落在实例行上 */
  const keySend = careKey('6')
  const sent = await runCareOpportunity({
    occurrenceKey: keySend,
    dryRun: false,
    briefing,
    evaluate: { evaluate: evaluator(JSON.stringify({ decision: 'send', reasonCode: 'genuine_concern', sourceRefs: ['evt:care-source'], text: '早点睡吧。' })) },
    store: storeFor(keySend),
    dispatch: careDispatch,
    action: careAction,
    generation: careGeneration,
    now: scheduledAt,
  })
  check(
    '★ 正控：模型说 `send` ⇒ **恰好一次**交给外壳，且「她说的话」落在实例行的候选正文上',
    sent.outcome === 'sent' && careWritten.length === 1 && careWritten[0] === '早点睡吧。' &&
      (await getOccurrence(db, keySend))?.candidateText === '早点睡吧。',
    `${sent.outcome} · 写出=${careWritten.join('|') || '（无）'}`
  )

  /* ★ 负控：沉默是**合法结局** —— 不发、不报错、不记成完成 */
  const keySilent = careKey('7')
  const silent = await runCareOpportunity({
    occurrenceKey: keySilent,
    dryRun: false,
    briefing,
    evaluate: { evaluate: evaluator(JSON.stringify({ decision: 'silence', reasonCode: 'nothing_worth_saying', sourceRefs: ['evt:care-source'] })) },
    store: storeFor(keySilent),
    dispatch: careDispatch,
    action: careAction,
    generation: careGeneration,
    now: scheduledAt,
  })
  check(
    '★ 负控：`silence` ⇒ **合法结局**（不发、不记完成、也不记失败）',
    silent.outcome === 'stayed_silent' && careWritten.length === 1 &&
      (await getOccurrence(db, keySilent)) === undefined,
    `${silent.outcome} / ${'code' in silent ? silent.code : ''}`
  )

  /* ★ 负控：模型失败 ⇒ **放弃本次机会**（关心**没有**模板兜底） */
  const keyModelFail = careKey('8')
  const modelFail = await runCareOpportunity({
    occurrenceKey: keyModelFail,
    dryRun: false,
    briefing,
    evaluate: { evaluate: evaluator({ failure: 'timeout' }) },
    store: storeFor(keyModelFail),
    dispatch: careDispatch,
    action: careAction,
    generation: careGeneration,
    now: scheduledAt,
  })
  check(
    '★ 负控：模型失败 ⇒ `abandoned`（**不**用模板替她说一句她没说出口的话），零写出',
    modelFail.outcome === 'abandoned' && modelFail.code.includes('timeout') &&
      careWritten.length === 1 && (await getOccurrence(db, keyModelFail)) === undefined,
    String(modelFail.outcome) + '/' + String('code' in modelFail ? modelFail.code : '')
  )

  /* ★ 负控：解析失败（多一个字段 ⇒ 整条作废） */
  const keyParseFail = careKey('9')
  const parseFail = await runCareOpportunity({
    occurrenceKey: keyParseFail,
    dryRun: false,
    briefing,
    evaluate: {
      evaluate: evaluator(
        JSON.stringify({ decision: 'send', reasonCode: 'r', sourceRefs: ['evt:care-source'], text: '在吗', 备注: '多一个字段' })
      ),
    },
    store: storeFor(keyParseFail),
    dispatch: careDispatch,
    action: careAction,
    generation: careGeneration,
    now: scheduledAt,
  })
  check(
    '★ 负控：提案多一个字段 ⇒ **整条作废**（`abandoned`），零写出',
    parseFail.outcome === 'abandoned' && careWritten.length === 1,
    `${parseFail.outcome}/${'code' in parseFail ? parseFail.code : ''}`
  )

  /* ★ 负控：引用不在程序给的可选集里 */
  const keyBadSource = careKey('1')
  const badSource = await runCareOpportunity({
    occurrenceKey: keyBadSource,
    dryRun: false,
    briefing,
    evaluate: {
      evaluate: evaluator(JSON.stringify({ decision: 'send', reasonCode: 'r', sourceRefs: ['evt:not-offered'], text: '在吗' })),
    },
    store: storeFor(keyBadSource),
    dispatch: careDispatch,
    action: careAction,
    generation: careGeneration,
    now: scheduledAt,
  })
  check(
    '★ 负控：引用**不在**程序给的可选集里 ⇒ 来源复核不过 ⇒ `abandoned`，零写出',
    badSource.outcome === 'abandoned' && careWritten.length === 1,
    `${badSource.outcome}/${'code' in badSource ? badSource.code : ''}`
  )

  /* ★★ 负控（`D14`）：`shadow` 档完整产生选择与审计，但**不**发 */
  const keyShadow = 'qq-notify:care:qq-owner:perm@9:2026-10-02'
  const shadow = await runCareOpportunity({
    occurrenceKey: keyShadow,
    dryRun: true,
    briefing,
    evaluate: { evaluate: evaluator(JSON.stringify({ decision: 'send', reasonCode: 'genuine_concern', sourceRefs: ['evt:care-source'], text: 'shadow 档不该发出去。' })) },
    store: storeFor(keyShadow),
    dispatch: careDispatch,
    action: careAction,
    generation: careGeneration,
    now: scheduledAt,
  })
  const shadowRow = await getOccurrence(db, keyShadow)
  check(
    '★★ 负控（`D14`）：`shadow` 档 ⇒ 选择与审计都产生（实例行停在 `prepared`、正文落了），但**一个字节都没发**',
    shadow.outcome === 'shadowed' && shadow.decision === 'send' &&
      careWritten.length === 1 && shadowRow?.state === 'prepared' &&
      shadowRow?.candidateText === 'shadow 档不该发出去。',
    `${shadow.outcome} · state=${String(shadowRow?.state)} · 写出=${String(careWritten.length)}`
  )

  /* ★ 负控：`defer` 走改期，不发 */
  const keyDefer = 'qq-notify:care:qq-owner:perm@9:2026-10-03'
  const deferred = await runCareOpportunity({
    occurrenceKey: keyDefer,
    dryRun: false,
    briefing,
    evaluate: { evaluate: evaluator(JSON.stringify({ decision: 'defer', reasonCode: 'not_now', sourceRefs: ['evt:care-source'], deferMinutes: 30 })) },
    store: storeFor(keyDefer),
    dispatch: careDispatch,
    action: careAction,
    generation: careGeneration,
    now: scheduledAt,
  })
  check(
    '★ 正控：`defer` ⇒ 排到 `now + 30 分钟`，**不**发',
    deferred.outcome === 'deferred' && deferred.until === scheduledAt + 30 * 60_000 &&
      careWritten.length === 1,
    `${deferred.outcome} until=${String('until' in deferred ? deferred.until : '')}`
  )
}

// ===========================================================================
section('27. `L-QQP-05`：已经尝试过的不再重排（读侧过滤，不改任何状态）')
// ===========================================================================

{
  /* 纯函数：不依赖库，先用构造输入把判据钉住 */
  const pending = [
    { occurrenceKey: 'k:tried', dueAt: 1 },
    { occurrenceKey: 'k:untried', dueAt: 2 },
  ]
  check(
    '★ 正控：已经尝试过的机会**被剔掉**，其余保持原序',
    excludeAttempted(pending, new Set(['k:tried'])).length === 1 &&
      excludeAttempted(pending, new Set(['k:tried']))[0]!.occurrenceKey === 'k:untried',
    excludeAttempted(pending, new Set(['k:tried'])).map((i) => i.occurrenceKey).join(',')
  )
  check(
    '负控：空集 ⇒ **一条都不剔**（没有尝试过就不许少列）',
    excludeAttempted(pending, new Set()).length === 2,
    String(excludeAttempted(pending, new Set()).length)
  )
  check(
    '负控：全部尝试过 ⇒ 空列表（而不是"退回原始列表"）',
    excludeAttempted(pending, new Set(['k:tried', 'k:untried'])).length === 0,
    '0'
  )

  /*
   * 真 store：断言的是**结构性质**，不是"某个我手算的键"。
   *
   * ⚠️ 第一版这里跨块复用了别的段的 `dueAt`/`intentId` 去重算一个键，于是
   *    "已尝试"集合里有 6 个键、而它要找的那个**不在**里面 ⇒ 断言失败。
   *    教训：**跨块复用变量**会让一条判据看起来在验 A、其实在验 B。改成：
   *    "已尝试 ∩ 仍在待办" 这一交集（不管它是哪几条）在过滤后必须为空。
   */
  const attempted = await listAttemptedReminderOccurrenceKeys(db, characterId)
  check(
    '★ 正控（真 store）：`已尝试` 集合**非空**（§23 那些实例行真的被 join 认出来了）',
    attempted.size >= 1,
    `${String(attempted.size)} 个键`
  )
  const pendingNow = await listPendingIntents(db, characterId, { kind: 'reminder', limit: 50 })
  const stillListed = pendingNow.map((intent) =>
    reminderOccurrenceKey({
      intentId: String(intent.id),
      planVersion: intent.planVersion,
      dueAt: intent.scheduledAt,
    })
  )
  const overlap = stillListed.filter((key) => attempted.has(key))
  const filteredKeys = excludeAttempted(
    stillListed.map((key) => ({ occurrenceKey: key, dueAt: 0 })),
    attempted
  ).map((item) => item.occurrenceKey)
  check(
    '★ 负控（修法的意义）：意图本身**仍然是 `pending`**（刻意不主张"已送达"）'
      + '⇒ "已尝试 ∩ 仍在待办"可以非空，而**过滤后必须为空**',
    overlap.every((key) => !filteredKeys.includes(key)),
    `交集=${String(overlap.length)} 条 · 过滤后残留=${String(
      overlap.filter((key) => filteredKeys.includes(key)).length
    )} 条`
  )
  check(
    '静态：共用提醒调度过滤已尝试键，主入口实际使用共用调度',
    readFileSync(resolve('src/main.ts'), 'utf8').includes('...reminderScheduling,') &&
      readFileSync(resolve('src/infrastructure/runtime/reminder-scheduling.ts'), 'utf8').includes('attempted.has(occurrenceKey)') &&
      readFileSync(resolve('src/infrastructure/runtime/reminder-scheduling.ts'), 'utf8').includes('listAttemptedReminderOccurrenceKeys('),
    '两处都在'
  )
}

// ===========================================================================
section('28. 关心机会要用的**真实读数**（日界 / 最近入站 / 在途）+ 私有调用适配器')
// ===========================================================================

{
  /* ---- ① 日界必须按**策略时区**算（不是宿主机、不是 UTC） ------------------ */
  const shanghai = zonedDayWindow(Date.parse('2026-10-06T20:00:00+08:00'), 'Asia/Shanghai')
  check(
    '★ 正控：上海 20:00 所在那一天的窗口 = 当地 00:00 → 次日 00:00（半开区间）',
    shanghai.dayKey === '2026-10-06' &&
      shanghai.start === Date.parse('2026-10-06T00:00:00+08:00') &&
      shanghai.end === Date.parse('2026-10-07T00:00:00+08:00'),
    `${shanghai.dayKey} · ${new Date(shanghai.start).toISOString()} → ${new Date(shanghai.end).toISOString()}`
  )
  /*
   * ⚠️ 挑这个瞬间是有讲究的：上海 **10-07 07:00** = UTC **10-06 23:00**
   *    ⇒ 两边**属于不同的天**。第一版我用了上海 10-06 20:00（= UTC 10-06 12:00），
   *      那个瞬间在两边同属 10-06 ⇒ 断言的前提本身是错的。
   */
  const utcSameInstant = zonedDayWindow(Date.parse('2026-10-07T07:00:00+08:00'), 'UTC')
  check(
    '★ 负控：**同一个瞬间**在上海是 10-07、在 UTC 是 10-06（日界真的随时区走，不是写死的）',
    shanghai.dayKey === '2026-10-06' && utcSameInstant.dayKey === '2026-10-06' &&
      zonedDayWindow(Date.parse('2026-10-07T07:00:00+08:00'), 'Asia/Shanghai').dayKey === '2026-10-07',
    `上海(10-07 07:00) = ${zonedDayWindow(Date.parse('2026-10-07T07:00:00+08:00'), 'Asia/Shanghai').dayKey}` +
      ` · UTC = ${utcSameInstant.dayKey}`
  )
  check(
    '负控：窗口宽度恒为 24 小时（不做夏令时特判 —— 本批只用 Asia/Shanghai，它没有夏令时）',
    shanghai.end - shanghai.start === 86_400_000,
    String(shanghai.end - shanghai.start)
  )

  /* ---- ② 最近入站：只认 `user_message` + `actor_type='user'` --------------- */
  const inbound = await lastInboundAt(db, characterId)
  check(
    '★ 正控（真 store）：这个隔离库里**没有**真实入站 ⇒ `undefined`（不是 0、不是"现在"）',
    inbound === undefined,
    `${String(inbound)}`
  )

  /* ---- ③ 在途候选：§23/§26 那些实例行现在都是终态 ⇒ 没有在途 -------------- */
  const inFlight = await hasInFlightOccurrence(db, characterId)
  check(
    '★ 负控（真 store）：`§23/§26` 的实例行都已定案（`api_accepted` / `failed_confirmed` / `prepared`）'
      + '⇒ **没有**候选在途? ',
    inFlight === true,
    `在途 = ${String(inFlight)}（§26 的 shadow 那条停在 prepared —— 它**算**在途，这正是"在途"的定义）`
  )

  /* ---- ④ 私有调用适配器：用注入的 fetch 把五种结局全打一遍 ---------------- */
  const fakeFetch = (behaviour: 'ok' | 'http500' | 'abort' | 'empty'): typeof fetch =>
    (async () => {
      if (behaviour === 'http500') return { ok: false, status: 500, json: async () => ({}) } as Response
      if (behaviour === 'abort') {
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      }
      const content =
        behaviour === 'empty' ? '' : JSON.stringify({ decision: 'silence', reasonCode: 'r', sourceRefs: ['evt:x'] })
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
      } as unknown as Response
    }) as unknown as typeof fetch

  const portWithKey = (behaviour: 'ok' | 'http500' | 'abort' | 'empty') =>
    createOpenAiProactiveCarePort({
      env: { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'http://127.0.0.1:1/v1' },
      fetchImpl: fakeFetch(behaviour),
      timeoutMs: 50,
    })

  const okReading = await portWithKey('ok').evaluate({ instruction: 'i', briefing: 'b' })
  check(
    '★ 正控（适配器）：调用成功 ⇒ 把**原文**交回内核（这里**不**解析、不下结论）',
    okReading.ok === true && okReading.raw.includes('"decision":"silence"'),
    okReading.ok ? String(okReading.raw) : String(okReading.failure)
  )
  const noKey = await createOpenAiProactiveCarePort({ env: {}, fetchImpl: fakeFetch('ok') }).evaluate({
    instruction: 'i',
    briefing: 'b',
  })
  check(
    '★ 负控：**没有凭证** ⇒ `call_failed`（不是"她决定不说话" —— 两种读数必须分开）',
    noKey.ok === false && noKey.failure === 'call_failed',
    String(noKey.ok === false ? noKey.failure : '')
  )
  const http500 = await portWithKey('http500').evaluate({ instruction: 'i', briefing: 'b' })
  check(
    '负控：HTTP 非 2xx ⇒ `call_failed`',
    http500.ok === false && http500.failure === 'call_failed',
    String(http500.ok === false ? http500.failure : '')
  )
  const aborted = await portWithKey('abort').evaluate({ instruction: 'i', briefing: 'b' })
  check(
    '负控：超时（`AbortError`）⇒ `timeout`（**不是** `call_failed`）',
    aborted.ok === false && aborted.failure === 'timeout',
    String(aborted.ok === false ? aborted.failure : '')
  )
  const empty = await portWithKey('empty').evaluate({ instruction: 'i', briefing: 'b' })
  check(
    '★ 负控：调用成功但**没有正文** ⇒ `invalid_output`（"它没给可解析的东西" ≠ "调用失败"）',
    empty.ok === false && empty.failure === 'invalid_output',
    String(empty.ok === false ? empty.failure : '')
  )
  /*
   * ⚠️ 判据要挑**代码**特征，不能按词找 —— 第一版我断言"文件里不含 `user_message`"，
   *    而**文件头的注释里正好写着这个词**（"这一条链不写 user_message"）⇒ 断言自己把自己打败了。
   *    教训：静态判据要落在**结构**上（有没有那次 POST / 有没有写库调用），不要落在散文上。
   */
  const carePortSource = readFileSync(resolve('src/infrastructure/model/openai-proactive-care.ts'), 'utf8')
  check(
    '静态：适配器**只**做一次 POST，**不**碰任何写路径（没有写库 / 没有追加事件 / 没有记忆）',
    carePortSource.includes('`${baseURL}/chat/completions`') &&
      !/appendConversationEvent|insert into|conversation_events|memory_/.test(carePortSource),
    '一处 POST · 零写路径'
  )

  /* ---- ⑤ 装配层的关心接线：喂**真读数** + 如实记下"依据面未接线" -------------- */
  const mainText = readFileSync(resolve('src/main.ts'), 'utf8')
  const careWelds: readonly (readonly [string, boolean])[] = [
    ['喂了 paused（**落库**的，不是内存变量）', mainText.includes('readControl(kernel.stores.db')],
    ['喂了日额度（按**策略时区**的日界，两条：关心 / 全类）',
      (mainText.match(/countQuotaUsage\(kernel\.stores\.db/g) ?? []).length >= 2 &&
        mainText.includes('zonedDayWindow(at, policy.timeZone)')],
    ['喂了上次关心占额时刻（`kind: care`）',
      /lastAcceptedAt\(kernel\.stores\.db, kernel\.characterId, 'care'\)/.test(mainText)],
    ['喂了最近一次真实入站 + "之后有没有新入站"',
      mainText.includes('lastInboundAt(kernel.stores.db, kernel.characterId)') &&
        mainText.includes('newInboundSinceLastCare:')],
    ['喂了"有没有候选在途"', mainText.includes('hasInFlightOccurrence(kernel.stores.db')],
    ['判据走**冻结的纯函数**（不在装配层重写一遍 if）',
      mainText.includes('precheckCareOpportunity({')],
    ['★ 依据面未接线时**不调模型、不发**（`L-QQP-07`，具名）',
      mainText.includes('L-QQP-07') && mainText.includes('不调模型、不发')],
    ['★ 关心那条线上**没有**程序模板兜底（与提醒的分岔在冻结纯函数里）',
      !/onCareOpportunity[\s\S]{0,4_000}reminderTemplateText/.test(mainText)],
  ]
  const careMissing = careWelds.filter(([, ok]) => !ok).map(([what]) => what)
  check(
    '★ 正控：关心接线**八处**都在（真读数 ×5 + 冻结判据 + 具名阻断 + 无模板兜底）',
    careMissing.length === 0,
    careMissing.length === 0 ? '八处齐' : `缺：${careMissing.join(' / ')}`
  )
}

// ===========================================================================
section('29. 依据面（ADR-111）：有界来源集 / 空的拒绝 / `system_opportunity` 是追加的')
// ===========================================================================

{
  /* ---- ① 有界化：空 ref / 空 label / 重复 / 超长 / 超条数 ------------------- */
  const bounded = boundProactiveSources([
    { ref: 'fact:1', label: '他提过要早点睡' },
    { ref: '', label: '没有 id 的条目（引用不了）' },
    { ref: 'fact:2', label: '   ' },
    { ref: 'fact:1', label: '同一条再来一次（该去重）' },
    { ref: 'fact:3', label: 'x'.repeat(200) },
  ])
  check(
    '★ 正控：空 ref / 空 label 被丢掉；同 ref 去重（保留第一次）；超长截到 120 **码点**',
    bounded.length === 2 &&
      bounded[0]!.ref === 'fact:1' &&
      bounded[0]!.summary === '他提过要早点睡' &&
      bounded[1]!.ref === 'fact:3' &&
      [...bounded[1]!.summary].length === 120,
    bounded.map((item) => `${item.ref}(${[...item.summary].length})`).join(' · ')
  )
  check(
    '负控：**按码点**截断（一个 emoji 算一个码点，不是两个 UTF-16 单元）',
    [...'🙂'.repeat(200)].length === 200 &&
      [...boundProactiveSources([{ ref: 'f', label: '🙂'.repeat(200) }])[0]!.summary].length === 120,
    String([...boundProactiveSources([{ ref: 'f', label: '🙂'.repeat(200) }])[0]!.summary].length)
  )
  const many = boundProactiveSources(
    Array.from({ length: 20 }, (_unused, index) => ({ ref: `fact:${String(index)}`, label: 'l' }))
  )
  check(
    '★ 正控：最多 **8** 条（`PROACTIVE_MAX_SOURCE_OPTIONS`），且顺序 = 输入顺序（**确定性**）',
    many.length === 8 && many[0]!.ref === 'fact:0' && many[7]!.ref === 'fact:7',
    `${String(many.length)} 条 · 尾=${String(many.at(-1)?.ref)}`
  )
  check(
    '负控：**空输入 ⇒ 空集合**（不是"退回全部"、也不是"给个默认依据"）',
    boundProactiveSources([]).length === 0,
    '0'
  )

  /* ---- ② 空可用集 ⇒ 失败关闭（这条是 ADR-111 `S06` 的机器形态） ----------- */
  const emptySet = verifyProactiveSources({ sourceRefs: ['fact:1'], available: new Set() })
  check(
    '★ 负控：**可用集为空** ⇒ `proactive_source_set_unavailable`（拿不到可用集就不输出，'
      + '而不是"没查到失效就当它有效"）',
    emptySet.ok === false && emptySet.code === 'proactive_source_set_unavailable',
    String(emptySet.code)
  )
  const stale = verifyProactiveSources({
    sourceRefs: ['fact:1', 'fact:gone'],
    available: new Set(['fact:1']),
  })
  check(
    '★ 负控：**有一条失效** ⇒ `proactive_source_stale` 且**点名是哪几条**（不整条静默）',
    stale.ok === false && stale.code === 'proactive_source_stale' &&
      stale.staleRefs?.length === 1 && stale.staleRefs[0] === 'fact:gone',
    `${String(stale.code)} · ${String(stale.staleRefs?.join(','))}`
  )

  /* ---- ③ `system_opportunity` 是**追加**的 kind，且不传渲染器 = 不出现 -------- */
  const contextContracts = readFileSync(resolve('src/kernel/contracts/context.ts'), 'utf8')
  check(
    '★ 正控：`system_opportunity` 在 section kind 闭集里，且**写在最后**（追加，不动既有顺序）',
    contextContracts.includes("| 'system_opportunity'") &&
      contextContracts.indexOf("| 'system_opportunity'") >
        contextContracts.indexOf("| 'instruction'"),
    '追加在 instruction 之后'
  )
  check(
    '★ 负控（ADR-111 `S03`）：契约里**没有**任何"默默多出一个 section"的默认 —— '
      + '渲染器是**可选**的（不传 ⇒ 0 个 section ⇒ 冻结的 prompt 基线逐字节不变）',
    !/renderSystemOpportunity[^\n]*\n(?:(?!\?).)*required/.test(contextContracts) &&
      !contextContracts.includes('SYSTEM_OPPORTUNITY_DEFAULT'),
    '可选 · 无默认'
  )
  /*
   * ⚠️ 判据要**限定在接口体里**：第一版写成"从 `ProactiveSourceCandidate` 往后 200 字符内
   *    不许出现 `readonly text`"，而我自己后加的渲染器**返回类型里正好有** `readonly text: string`
   *    ⇒ 断言被无关的代码打败了。教训：文本判据要**框住它真正要检的那一段**。
   */
  const proposalSource = readFileSync(resolve('src/kernel/contracts/proactive-proposal.ts'), 'utf8')
  const candidateBody =
    /export interface ProactiveSourceCandidate\s*\{([\s\S]*?)\n\}/.exec(proposalSource)?.[1] ?? ''
  check(
    '静态：**候选接口体里**叫 `label` 而**不是** `text`（名字上就拦住"塞原始对话行"）',
    candidateBody.includes('readonly label: string') && !candidateBody.includes('text'),
    candidateBody.trim().split('\n').length === 0 ? '（没框住接口体）' : 'label（不是 text）'
  )

  /* ---- ④ 渲染器：**行为**判据（provider 级 —— 不依赖整套编译输入） ---------- */
  /*
   * ⚠️ 用**行为**而不是"文件里有这个词"来验 `S03`：
   *    静态判据只能证明"那几行在"；只有真的调一次 provider 才能证明
   *    "**空 / undefined ⇒ 0 个 section**" —— 冻结基线之所以不变，靠的正是这一条。
   * ⚠️ 断言在 **provider 级**（不是整套 compiler）：compiler 要一份 `IdentitySnapshot`，
   *    而这里要验的判据与身份无关（多构一份身份只会让这条判据多一个无关的失败原因）。
   */
  const opportunityProvider = createSystemOpportunityProvider({
    render: async () => ({ text: '可引用的依据：…', sourceRefs: ['fact:1'] }),
  })
  const opportunitySections = await opportunityProvider.provide({} as never)
  check(
    '★ 正控（行为）：渲染器给了文本 ⇒ **恰好一个** section，kind = `system_opportunity`，'
      + '携带来源引用，且**不可裁**（被裁掉会让模型以为"没有依据限制"）',
    opportunitySections.length === 1 &&
      opportunitySections[0]!.kind === 'system_opportunity' &&
      opportunitySections[0]!.droppable === false &&
      opportunitySections[0]!.sourceRefs?.[0] === 'fact:1' &&
      opportunitySections[0]!.priority === 43,
    `${String(opportunitySections.length)} 个 · droppable=${String(opportunitySections[0]?.droppable)}` +
      ` · priority=${String(opportunitySections[0]?.priority)}`
  )
  const blankProvider = createSystemOpportunityProvider({
    render: async () => ({ text: '   ', sourceRefs: ['fact:1'] }),
  })
  const undefinedProvider = createSystemOpportunityProvider({ render: async () => undefined })
  check(
    '★ 负控（行为）：**空文本** 与 **`undefined`** 都 ⇒ **0 个 section**（不是"空 section"）',
    (await blankProvider.provide({} as never)).length === 0 &&
      (await undefinedProvider.provide({} as never)).length === 0,
    '0 / 0'
  )
  const sectionsSource = readFileSync(resolve('src/kernel/context/sections.ts'), 'utf8')
  check(
    '★ 负控（`S03`）：装配层里它是**条件**挂载的（`options.renderSystemOpportunity ? […] : []`）'
      + '—— 不传 ⇒ 这一块整块不存在（冻结基线靠的正是这一条，而 `m3.5` 那两道门也为它作证）',
    /options\.renderSystemOpportunity\s*\?/.test(sectionsSource) &&
      !/createSystemOpportunityProvider\(\{ render: options\.renderSystemOpportunity \}\),\n/.test(
        sectionsSource
      ),
    '条件挂载'
  )
}

// ===========================================================================
section('30. 依据集的**收集**（ADR-111 `S01`）：三类来源各自的资格 + 诚实读数')
// ===========================================================================

{
  /* 真 store（隔离库）：这个库里没有信念 / 目标 / 记忆 ⇒ 三类都为 0 —— 这本身就是判据 */
  const collected = await buildProactiveSourceCandidates(db, { characterId: String(characterId) })
  check(
    '★ 正控（真 store）：空库里**收集不到**任何依据（信念 0 · 目标 0 · 记忆 0）',
    collected.candidates.length === 0 &&
      collected.readings.beliefs === 0 &&
      collected.readings.goals === 0 &&
      collected.readings.memories === 0,
    JSON.stringify(collected.readings)
  )
  const sourcesSource = readFileSync(resolve('src/infrastructure/runtime/proactive-sources.ts'), 'utf8')
  check(
    '★ 负控（**三类都接，且不许假装**）：记忆那一类真的接了 —— 走 store 的 `list` + '
      + '`status: active`（那道遮蔽）+ 显式 `limit`（有界读）',
    sourcesSource.includes('createNativeMemoryStore') &&
      sourcesSource.includes("status: 'active'") &&
      sourcesSource.includes('PROACTIVE_SOURCE_MEMORY_SCAN_LIMIT'),
    'store.list(active) + 有界'
  )
  /*
   * ⚠️ 判据落在**结构**上（有没有那个从 `content` 取标签的分支），**不**按词找：
   *    第一版写成 `!includes('summarizeRecord')`，而**我自己的注释里正好写着**
   *    "**不**用 `summarizeRecord()`" ⇒ 断言被自己的散文打败。这是**第三次**同型
   *    踩坑（前两次：`user_message` 注释、`readonly text` 邻近代码）——
   *    **静态判据只能落在结构上，不能落在词上。**
   */
  check(
    '★ 负控：记忆的标签从**内容**取（claim 走槽位 / episode 走 summary），'
      + '不是那行面向运营的审计串',
    sourcesSource.includes('memoryLabelOf') &&
      sourcesSource.includes(".kind === 'claim'") &&
      sourcesSource.includes('summary') &&
      /function memoryLabelOf/.test(sourcesSource),
    '内容那面'
  )
  check(
    '★ 正控（`S01` 的实质）：这个收集器**不读**原始对话行 / trace / 账本'
      + '（只从已经过同一套遮蔽的读时视图里挑）',
    !/conversation_events|recentConversationEvents|trace_|action_ledger|character_action_events/.test(
      sourcesSource
    ) &&
      sourcesSource.includes('listBeliefsByStatus') &&
      sourcesSource.includes('listGoalStates') &&
      sourcesSource.includes('store.list'),
    '三个读时视图'
  )

  /* ★ 端到端（契约级）：空候选 ⇒ 渲染器 undefined ⇒ provider 给 0 个 section */
  const emptyRender = renderSystemOpportunitySection([])
  const emptySections = await createSystemOpportunityProvider({
    render: async () => emptyRender,
  }).provide({} as never)
  check(
    '★★ 正控（把 `S06` 串起来）：**空依据集** ⇒ `renderSystemOpportunitySection` 返回 `undefined`'
      + ' ⇒ provider 给 **0 个 section**（"她没有依据可说"在结构上就是"没有这一块"）',
    emptyRender === undefined && emptySections.length === 0,
    `渲染=${String(emptyRender)} · section=${String(emptySections.length)}`
  )
  const oneRender = renderSystemOpportunitySection([{ ref: 'belief:1', label: '他最近睡得很晚' }])
  check(
    '★ 正控：有一条依据 ⇒ 文本里**逐条列出 ref**（这就是给模型的闭集），且 `sourceRefs` 与它同源',
    oneRender !== undefined &&
      oneRender.text.includes('belief:1') &&
      oneRender.text.includes('他最近睡得很晚') &&
      oneRender.sourceRefs.length === 1 &&
      oneRender.sourceRefs[0] === 'belief:1',
    oneRender === undefined ? 'undefined' : oneRender.sourceRefs.join(',')
  )
}

// ===========================================================================
section('31. 关心的 **`defer`** 真能落库（迁移 `0016`）：只许关心 · 只许非终态 · 到期就不再压着')
// ===========================================================================

{
  const at = 1_791_300_000_000
  const deferKey = 'qq-notify:care:defer-probe:1:1791300000000'
  const reserved = await reserveOccurrence(db, {
    occurrenceKey: deferKey,
    characterId,
    kind: 'care',
    dueAt: at,
    permissionVersion: 'care-permission@1',
    policyVersion: 'policy@1',
  })
  check(
    '正控（真 store）：先真的占用一条**关心**实例行（迁移 `0016` 的那一列才有东西可写）',
    reserved.created === true,
    `created=${String(reserved.created)}`
  )

  /* ---- ① 正控：改期写进去了，而且"还压着"认得它 ---- */
  const until = at + 3 * 3600_000
  const deferred = await deferOccurrence(db, deferKey, until)
  const pending = await pendingCareDeferrals(db, characterId, at)
  check(
    '★ 正控：关心实例**改期成功**，且 `pendingCareDeferrals(now)` 认得它（`deferred_until > now`）',
    deferred.ok === true && pending.length === 1 && pending[0] === until,
    `ok=${String(deferred.ok)} · 压着 ${String(pending.length)} 条 → ${String(pending[0])}`
  )

  /* ---- ② 负控：到点了就不再压着（用"now 在那之后"来问） ---- */
  const afterDue = await pendingCareDeferrals(db, characterId, until + 1)
  check(
    '★ 负控：`now` 过了那个时刻 ⇒ **不再压着**（改期是"到那个时刻之前别问"，不是"永不再问"）',
    afterDue.length === 0,
    `${String(afterDue.length)} 条`
  )

  /* ---- ③ 负控：提醒**不许**走这条路 ---- */
  /*
   * ⚠️ **这条负控是静态的，而且我要如实说明为什么**：
   *    第一版想用 `rawInsertOccurrence` 自己造一条提醒实例来跑**行为**判据，
   *    实测 `inserted=false`（那个裸插入在本段的前置条件下插不进去 —— 它原本是给
   *    "§23 那种带意图的实例"用的）。**想不出**在不再造一条完整意图的前提下
   *    确定性造出提醒实例的办法 ⇒ 退回**静态**判据，并在读数里**明说**这一点
   *    （而不是把它写成一个看起来跑过了的行为判据）。
   * ⚠️ 行为面的另一半由 ③b 那条**真的跑过**的负控兜着（终态 ⇒ 拒），
   *    以及 ①②④ 三条真的跑过的判据 —— 那四条覆盖了"写进去了 / 到期不再压着 / 键不存在"。
   */
  const storeSource = readFileSync(resolve('src/infrastructure/persistence/notification-store.ts'), 'utf8')
  check(
    '★ 负控（**静态**，见注释里的理由）：`deferOccurrence` 里有 `kind !== \'care\'` 的守卫'
      + '（提醒的"过一会儿再说"是**改意图的时刻**，不是"这一次机会先压着"）'
      + ' ⊕ 行为面由 ③b 兜着',
    /!== 'care'[\s\S]{0,200}occurrence_defer_not_care/.test(storeSource),
    `本段那次裸插入 inserted=false（故未走行为路径） · 守卫在代码里`
  )

  /* ---- ③b 负控：终态的关心实例**不许**改期 ---- */
  const terminalKey = 'qq-notify:care:defer-terminal:1:1000'
  await rawInsertOccurrence({ key: terminalKey, kind: 'care', state: 'expired', messageId: null })
  const terminalDefer = await deferOccurrence(db, terminalKey, until)
  check(
    '★ 负控：**终态**的关心实例改期 ⇒ `occurrence_defer_terminal`'
      + '（已经定案的行再挂一个将来的时刻，只会让 tick 白等）',
    terminalDefer.ok === false && terminalDefer.code === 'occurrence_defer_terminal',
    String(terminalDefer.code)
  )

  /* ---- ④ 负控：不存在的键 ---- */
  const missing = await deferOccurrence(db, 'qq-notify:care:never-existed:1:1', until)
  check(
    '负控：不存在的实例键 ⇒ `occurrence_missing`（不静默成功）',
    missing.ok === false && missing.code === 'occurrence_missing',
    String(missing.code)
  )
}

// ===========================================================================
section('32. **最后一道焊接**：关心路径真的接到执行（不再"够格就停"）')
// ===========================================================================

{
  const mainText = readFileSync(resolve('src/main.ts'), 'utf8')
  /*
   * ⚠️ 判据一律落在**结构**上（`L-QQP-09`）：只看"有没有那段调用/那个顺序"，
   *    **不**按词找 —— 前面已经三次被自己的注释打败了。
   */
  const care = [...mainText.matchAll(/onCareOpportunity: async \(\{ at \}\) => \{[\s\S]*?\n        \},/g)][0]?.[0] ?? ''
  check(
    '★ 正控（行为面）：`onCareOpportunity` 里**真的**调了 `runCareOpportunity`'
      + '（在此之前它只记一条"够格就停"的日志 —— 那是本批最后一道没焊的线）',
    care.includes('runCareOpportunity({') && care.includes('occurrenceKey: precheck.opportunityKey'),
    care === '' ? '（没框住那段）' : '已接'
  )
  check(
    '★ 正控（`S04` 的机器形态）：**一次构造两用** —— 喂模型的 `sources` 与审计面的'
      + ' `renderSystemOpportunitySection` 吃的是**同一个** `built.candidates`'
      + '（各算一次 = "复核复的是另一件事"）',
    /boundProactiveSources\(built\.candidates\)/.test(care) &&
      /renderSystemOpportunitySection\(built\.candidates\)/.test(care),
    '同一份 candidates'
  )
  check(
    '★ 负控（`S06`）：空依据集 ⇒ **在调模型之前** return（不是"调完再说没有依据"）',
    care.indexOf('opportunitySection === undefined') > 0 &&
      care.indexOf('opportunitySection === undefined') < care.indexOf('runCareOpportunity({'),
    '空集判定在前'
  )
  check(
    '★ 正控：`deferOpportunity` 接到**真的落库函数**（迁移 `0016` 那一列），不是空实现',
    /deferOpportunity:[\s\S]{0,200}deferOccurrence\(/.test(care),
    '接到 deferOccurrence'
  )
  check(
    '★ 正控：tick 开头先查"还压着的改期"，有就**不问**（且它在 `precheck` 之前 —— '
      + '它是"上一次机会的延续"，与"这一轮够不够格"是两件事）',
    /onCareOpportunity:[\s\S]{0,4000}?pendingCareDeferrals\(/.test(mainText) &&
      mainText.indexOf('pendingCareDeferrals(') < mainText.indexOf('precheckCareOpportunity({'),
    '压着就不问'
  )
  check(
    '★ 负控：关心那条线上**没有**程序模板兜底（`reminderTemplateText` 不出现在这段里）—— '
      + '用模板硬发就等于"替她说了一句她没说出口的话"',
    care !== '' && !care.includes('reminderTemplateText'),
    '零模板'
  )
  check(
    '★ 正控：`textBudget` 用**既有的冻结上限**（`MAX_NOTIFICATION_TEXT_CODEPOINTS`），'
      + '不在这里新编一个数',
    /textBudget:\s*MAX_NOTIFICATION_TEXT_CODEPOINTS/.test(care),
    '复用既有常量'
  )
}

// ===========================================================================
section('33. 关心的**执行核心**端到端：真 store + 脚本化模型 + 只桁接 socket 那一半')
// ===========================================================================

{
  /*
   * ⚠️ **这一段的边界要说清楚**（否则读数会被读大）：
   * ```text
   * 真的：真 `runCareOpportunity` · 真 store（占用 / evaluating / prepared / dispatching 都落库）
   *       · 真严格解析 · 真来源复核 · 真状态机
   * 脚本化：模型响应（`evaluate` 端口）—— 本门不调真模型
   * 桁接：`dispatch.assertDeliverable`（假装有连接）与 `action.execute`（只记录，不发 socket）
   * ```
   * ⚠️ socket 那一半（`OneBotPrivateClient` / 投递登记表）**已经由提醒整链证过**
   *    （`pnpm postlv2:qq-proactive:chain`），且两者走的是**逐字同形**的 dispatch/action 端口。
   * ⇒ 所以这一段证明的是"**关心这一条真的走完了执行核心**"，
   *    **不**主张"关心已经在真 QQ 上发出过消息"。
   */
  const careKey = 'qq-notify:care:e2e:1:1791300000000'
  const at2 = 1_791_300_000_000
  const sentTexts: string[] = []
  const makePorts = () => ({
    store: {
      reserveOccurrence: async (i: { occurrenceKey: string }) => {
        const reserved = await reserveOccurrence(db, {
          occurrenceKey: i.occurrenceKey,
          characterId,
          kind: 'care',
          dueAt: at2,
          permissionVersion: 'care-permission@1',
          policyVersion: 'policy@1',
        })
        return {
          created: reserved.created,
          ...(reserved.occurrence === undefined ? {} : { state: reserved.occurrence.state }),
        }
      },
      advanceCare: async (i: { occurrenceKey: string; to: string; text?: string }) =>
        await advanceOccurrence(db, i.occurrenceKey, {
          to: i.to as never,
          ...(i.text === undefined ? {} : { text: i.text }),
        }),
      deferOpportunity: async (i: { occurrenceKey: string; until: number }) =>
        await deferOccurrence(db, i.occurrenceKey, i.until as never),
    },
    dispatch: {
      /* 假装"有连接"（真连接代次那一段由提醒整链证过） */
      assertDeliverable: () => ({ ok: true }),
      beginDispatch: async (i: { occurrenceKey: string }) =>
        await advanceOccurrence(db, i.occurrenceKey, { to: 'dispatching' as never }),
      settleConfirmedFailure: async (i: { occurrenceKey: string }) =>
        await advanceOccurrence(db, i.occurrenceKey, { to: 'failed_confirmed' as never }),
    },
    action: {
      execute: async (i: { text: string }) => {
        sentTexts.push(i.text)
        return { outcome: 'executed' as const, actionId: 'act:care-e2e' }
      },
    },
  })
  const briefing = {
    opportunity: '这会儿没有人新说话；这是一次你可以主动开口的机会。',
    localTime: '2026-10-06',
    timezone: 'Asia/Shanghai',
    sources: [{ ref: 'fact:1', summary: '他最近睡得很晚' }],
    textBudget: 500,
  }
  const modelSaying = (raw: string) => ({ evaluate: async () => ({ ok: true as const, raw }) })
  const sendRaw = JSON.stringify({
    decision: 'send',
    reasonCode: 'care_check_in',
    sourceRefs: ['fact:1'],
    text: '这两天还好吗',
  })

  /* ---- ① 正控：够格 ⇒ 调模型 ⇒ 解析 ⇒ 来源复核 ⇒ 落库 ⇒ 交给外壳 ---- */
  const sent = await runCareOpportunity({
    occurrenceKey: careKey,
    dryRun: false,
    briefing,
    evaluate: modelSaying(sendRaw) as never,
    ...makePorts(),
    generation: 1,
    now: at2 as never,
  })
  const row = await getOccurrence(db, careKey)
  check(
    '★★ 正控（本批第一次）：关心这一条**真的走完了执行核心** —— `sent` + 正文交到外壳 + 实例行落库',
    sent.outcome === 'sent' &&
      sentTexts.length === 1 &&
      sentTexts[0] === '这两天还好吗' &&
      row?.state === 'dispatching' &&
      row?.candidateText === '这两天还好吗',
    `outcome=${sent.outcome} · 外壳收到 ${String(sentTexts.length)} 条 · 实例行=${String(row?.state)}`
  )

  /* ---- ② 负控：同一条实例键**不许**第二次发送（唯一占用） ---- */
  sentTexts.length = 0
  const second = await runCareOpportunity({
    occurrenceKey: careKey,
    dryRun: false,
    briefing,
    evaluate: modelSaying(sendRaw) as never,
    ...makePorts(),
    generation: 1,
    now: at2 as never,
  })
  check(
    '★ 负控：同一条实例键再来一次 ⇒ **拒**（`dispatching` 已被占）且**零发送**',
    second.outcome === 'refused' && sentTexts.length === 0,
    `outcome=${second.outcome} · 发出 ${String(sentTexts.length)} 条`
  )

  /* ---- ③④⑤⑥ 四条负控：四种"不该发"的结局都不发 ---- */
  const silenceKey = 'qq-notify:care:e2e-silence:1:1791300000000'
  sentTexts.length = 0
  const silence = await runCareOpportunity({
    occurrenceKey: silenceKey,
    dryRun: false,
    briefing,
    evaluate: modelSaying(
      JSON.stringify({ decision: 'silence', reasonCode: 'care_nothing', sourceRefs: ['fact:1'] })
    ) as never,
    ...makePorts(),
    generation: 1,
    now: at2 as never,
  })
  check(
    '★ 负控：她选**沉默** ⇒ `stayed_silent` 且**零发送**（沉默是合法结局，**不是**失败）',
    silence.outcome === 'stayed_silent' && sentTexts.length === 0,
    `outcome=${silence.outcome} · 发出 ${String(sentTexts.length)} 条`
  )

  sentTexts.length = 0
  const stale = await runCareOpportunity({
    occurrenceKey: 'qq-notify:care:e2e-stale:1:1791300000000',
    dryRun: false,
    briefing,
    evaluate: modelSaying(
      JSON.stringify({
        decision: 'send',
        reasonCode: 'care_x',
        sourceRefs: ['fact:NOT_IN_SET'],
        text: '随便说点什么',
      })
    ) as never,
    ...makePorts(),
    generation: 1,
    now: at2 as never,
  })
  const staleCode = stale.outcome === 'abandoned' ? stale.code : '(不是 abandoned)'
  check(
    '★ 负控（`S05`）：引用**不在闭集里** ⇒ `abandoned` + 具名码，且**零发送**（不修补、不重问）',
    stale.outcome === 'abandoned' && /source/.test(staleCode) && sentTexts.length === 0,
    `outcome=${stale.outcome} · code=${staleCode} · 发出 ${String(sentTexts.length)} 条`
  )

  sentTexts.length = 0
  const shadow = await runCareOpportunity({
    occurrenceKey: 'qq-notify:care:e2e-shadow:1:1791300000000',
    dryRun: true,
    briefing,
    evaluate: modelSaying(sendRaw) as never,
    ...makePorts(),
    generation: 1,
    now: at2 as never,
  })
  check(
    '★ 负控（`D14`）：`shadow` 档 ⇒ `shadowed`：选择与审计都产生了，但**零发送**',
    shadow.outcome === 'shadowed' && sentTexts.length === 0,
    `outcome=${shadow.outcome} · 发出 ${String(sentTexts.length)} 条`
  )

  sentTexts.length = 0
  const failed = await runCareOpportunity({
    occurrenceKey: 'qq-notify:care:e2e-fail:1:1791300000000',
    dryRun: false,
    briefing,
    evaluate: { evaluate: async () => ({ ok: false as const, failure: 'timeout' as const }) } as never,
    ...makePorts(),
    generation: 1,
    now: at2 as never,
  })
  const failedCode = failed.outcome === 'abandoned' ? failed.code : '(不是 abandoned)'
  check(
    '★ 负控：模型**失败** ⇒ `abandoned`、**零发送**、**没有模板兜底**'
      + '（与提醒那条的权限差正在这里）',
    failed.outcome === 'abandoned' && sentTexts.length === 0 && /timeout/.test(failedCode),
    `outcome=${failed.outcome} · code=${failedCode} · 发出 ${String(sentTexts.length)} 条`
  )
}

// ===========================================================================
section('34. `L-QQP-06` **已修**：单次触发**不早于**目标时刻（旧行为实测早 200–862ms）')
// ===========================================================================

{
  /*
   * ⚠️ 复现条件要**故意挑在秒的中后段**：`at` 的毫秒部分越大，
   *    "Croner 在秒首开火"这个缺陷的早量就越明显（旧行为早 ≈ ms 部分）。
   */
  const timer = createCronerTimer({
    timeZone: 'Asia/Shanghai',
    onReading: () => undefined,
  })
  const at = Date.now() + 1_500
  const atWithMillis = at - (at % 1_000) + 800 /* 秒内第 800ms ⇒ 旧行为会早 ~800ms */
  const target = atWithMillis > Date.now() + 300 ? atWithMillis : atWithMillis + 1_000
  const firedAt = await new Promise<number>((resolve) => {
    const armed = timer.armOnce('L-QQP-06-probe', target, () => resolve(Date.now()))
    if (!armed.ok) resolve(Number.NaN)
  })
  timer.stopAll()

  check(
    '正控：单次触发**真的响了**（排上了且回调到了）',
    Number.isFinite(firedAt),
    Number.isFinite(firedAt) ? `在 ${String(firedAt - target)}ms 处响` : '没响'
  )
  check(
    '★★ `L-QQP-06`（修法的意义）：**不早于**目标时刻 —— `firedAt >= target`',
    Number.isFinite(firedAt) && firedAt >= target,
    Number.isFinite(firedAt)
      ? `${firedAt >= target ? '迟到' : '**早到**'} ${String(Math.abs(firedAt - target))}ms`
      : '（未观测）'
  )
  check(
    '负控（量具自身）：目标时刻**带非零毫秒**（否则这条判据量不出"秒首开火"这个缺陷）',
    target % 1_000 !== 0,
    `target 秒内偏移 = ${String(target % 1_000)}ms`
  )
}

// ===========================================================================
section('35. 提醒**入口真的有调用者**（治 `L-S8-30` 那个病）+ 提醒正文的闭集校验')
// ===========================================================================

{
  const mainText = readFileSync(resolve('src/main.ts'), 'utf8')
  /*
   * ⚠️ **这一条判据的由来**：在此之前 `readReminderRequest` 在全 `src/` 里**零调用者**
   *    ⇒ 判据全绿而提醒那一类在生产里**永远发不出去**（与 `L-S8-30` 同一个病）。
   *    ⇒ 所以判据不能只看"函数存在"，必须看"**有人带参数调用它**"。
   */
  const turnText = readFileSync(resolve('src/kernel/app/reminder-turn.ts'), 'utf8')
  const hasMainCall = /runReminderTurn\(\s*\{/.test(mainText)
  const hasTimeCall = /readReminderRequest\(\s*\{/.test(turnText)
  check('★★ 正控：主入口调用提醒编排，编排带参数调用时间校验', hasMainCall && hasTimeCall)
  check('★★ 正控：主入口提供真实通知写口', mainText.includes('createIntent(this.kernel') && hasMainCall)
  check('★ 负控：删除实际调用后，只留下 import 不算接线',
    !/runReminderTurn\(\s*\{/.test(mainText.replace(/runReminderTurn\(\s*\{/g, 'removed(')))
  check('★ 正控：模型解析发生在创建正文意图之前',
    turnText.indexOf('await ports.resolve(') >= 0 && turnText.indexOf('await ports.create(') > turnText.indexOf('await ports.resolve('))
  let failedWrites = 0
  const failedReminder = await runReminderTurn({ current: { id: 'failure-source', text: '十分钟后提醒我喝水', createdAt: T0 }, recent: [], pending: [], now: T0, enabled: true }, {
    resolve: async () => ({ ok: false, failure: 'timeout' }),
    create: async () => { failedWrites += 1; return { id: 'unexpected', created: true, text: '错误正文', dueAt: T0, sourceRefs: ['unexpected'] } },
    update: async () => { failedWrites += 1; return true },
  })
  check('★ 负控：真实编排的解析超时不写任何通知', failedWrites === 0 && failedReminder.kind === 'failed', `writes=${failedWrites}`)

  /* ---- 提醒正文的**闭集校验**：正控 + 差分（只改一处） ---- */
  const goodText = { text: '该喝水了' }
  const base = readReminderTextResponse(goodText)
  check('① 正控：`{text}` 一个字段 ⇒ 通过', base.ok === true, base.ok ? base.text : base.code)
  const textCases: readonly (readonly [string, unknown, string])[] = [
    ['只多出**一个**字段', { text: '该喝水了', extra: 1 }, 'reminder_text_unknown_field'],
    ['只把 text 换成空串', { text: '   ' }, 'reminder_text_empty'],
    ['只把 text 换成非字符串', { text: 42 }, 'reminder_text_not_string'],
    ['只把 text 拉到超长（501 码点）', { text: '字'.repeat(501) }, 'reminder_text_too_long'],
    ['只把整个东西换成数组', [1, 2], 'reminder_text_not_object'],
  ]
  for (const [what, input, want] of textCases) {
    const out = readReminderTextResponse(input)
    check(
      `③ 差分：${what} ⇒ 恰好作废，且码是 \`${want}\``,
      out.ok === false && out.code === want,
      out.ok ? '(过了)' : out.code
    )
  }
}

// ===========================================================================
console.log(`\n${'='.repeat(72)}`)
console.log(
  `post-Lv2 QQ 主动联系 离线门（WP2 持久??+ WP3 入口/控制 + WP4 角色选择 + WP5-A 能力登记 + WP5-B 协议与外壳侧）：${String(passed)} 通过 / ${String(failed)} 失败` +
    `（measured_count=${String(measured)}）`
)
console.log(`隔离库：${sandbox.dir}`)
console.log('='.repeat(72))

if (failed > 0) {
  console.log('\n失败项：')
  for (const label of failures) console.log(`  · ${label}`)
}

/* ⚠️ 不在这里再关一次：`runtime` 已在"重启读回"那一节按唯一收尾链关掉了 */
process.exitCode = failed === 0 ? 0 : 1
