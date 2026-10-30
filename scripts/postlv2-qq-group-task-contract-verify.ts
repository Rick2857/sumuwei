/**
 * post-Lv2 / ADR-156 P0 —— QQ 群任务**契约门**（纯函数 · 不打开数据库 · 不出网）。
 *
 * ============================================================================
 *  这道门回答什么
 * ============================================================================
 * ```text
 * ① 闭集完整性：任务/状态/形式/类别/授权来源/发送实例状态 都是封闭枚举
 * ② 静态准入例外：**任务优先于旧名单**、任务生效时豁免 @、没有任务且不在名单 ⇒ 拒
 * ③ 入站路由：default / task_candidate / suppress 三分支与四条抑制理由逐条正负例
 * ④ 发送额度：总量 / 单入站 / 时间段 / 最小间隔 / 版本 / 目标 / 媒介 各一拒一过
 * ⑤ 语音失败回落：只语音不得改文字；either+fallback 才发 1 条；unknown 零兜底
 * ⑥ 条数口径：语音 / 附录 / 兜底各自计数，最坏情形预留
 * ⑦ 草稿解析：闭集键、跨字段规则、上限（7 天窗口 / 16 成员 / 3 条 / 200 码点）
 * ⑧ 建单 / 修改 / 状态迁移 / 停止读回 / 重启恢复 / 结算后处置 的判定表
 * ```
 *
 * ⚠️ 这道门**不证明**：真实群送达、真实模型类别判断、语音听感、生产迁移。
 *    它是 P0 的"测试材料"：把方案的每一条规则变成可执行正负例。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  GROUP_SEND_STATES, GROUP_TASK_AUTH_SOURCES, GROUP_TASK_CATEGORIES, GROUP_TASK_CONTRACT_VERSION,
  GROUP_TASK_KINDS, GROUP_TASK_LIMITS, GROUP_TASK_MEDIA, GROUP_TASK_STATUSES, GROUP_TASK_TERMINAL_STATUSES,
  assertGroupTaskView, countPlannedOutgoingMessages, decideGroupAdmission, decideInboundRouting,
  decideSendAllowance, decideTaskAfterSendSettlement, decideTaskCreation, decideTaskModification,
  decideTaskStop, decideTaskTransition, decideVoiceFallback, groupTaskFactText, groupTaskWaivesMention,
  readGroupTaskDraft, recoverSendStateOnRestart, worstCaseOutgoingMessages,
  type GroupTaskAuthSource, type GroupTaskView,
} from '../src/kernel/contracts/qq-group-task.ts'

const ROOT = resolve(import.meta.dirname, '..')
const stamp = new Date().toISOString().replace(/\D/g, '')
const evidenceRoot = resolve(ROOT, 'artifacts/post-lv2', `qq-group-task-contract-${stamp}`)
const checks: string[] = []
const check = (name: string, run: () => void): void => { run(); checks.push(name) }

const BOT = '987654321'
const GROUP = '123456789'
const MEMBER_A = '111111111'
const MEMBER_B = '222222222'

/** 基线任务：窗口内、有效、文字、无附加限制 */
const task = (over: Partial<GroupTaskView> = {}): GroupTaskView => ({
  id: 'gt-1',
  contractVersion: GROUP_TASK_CONTRACT_VERSION,
  version: 3,
  status: 'active',
  kind: 'reply_window',
  target: { botId: BOT, groupId: GROUP },
  content: { mode: 'owner_verbatim', text: '今晚八点开会', brief: null },
  media: 'text',
  textFallback: false,
  trigger: { memberIds: [], replyToMessageId: null, categories: [], topicScope: null },
  term: { kind: 'window', startAt: 1_000, endAt: 100_000 },
  quota: { totalMaxMessages: 3, perInboundMaxMessages: 1, slot: null, minIntervalMs: 0 },
  usedMessages: 0,
  lastSendAt: null,
  authSource: 'owner_qq_private',
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

const NOW = 50_000

const zeroUsage = { totalMessages: 0, slotMessages: 0, perInboundMessages: 0, lastSendAt: null as number | null }

/** 一条合法的建单草稿（原文模式、只文字、窗口 10 分钟、总量 3） */
const draftBase = (): Record<string, unknown> => ({
  kind: 'create',
  groupId: GROUP,
  taskKind: 'reply_window',
  contentMode: 'owner_verbatim',
  text: '今晚八点开会',
  media: 'text',
  startAt: 1_000,
  endAt: 600_000,
  totalMaxMessages: 3,
})

/* ------------------------------------------------------------------------- */
/* ① 闭集完整性                                                                */
/* ------------------------------------------------------------------------- */
check('01 closed sets: task kinds / statuses / media / categories / auth source', () => {
  assert.deepEqual([...GROUP_TASK_KINDS], ['send_once', 'reply_window'])
  assert.equal(GROUP_TASK_STATUSES.length, 7)
  assert.deepEqual([...GROUP_TASK_STATUSES], [
    'clarifying', 'active', 'paused', 'completed', 'exhausted', 'expired', 'revoked'])
  assert.deepEqual([...GROUP_TASK_TERMINAL_STATUSES], ['completed', 'exhausted', 'expired', 'revoked'])
  assert.deepEqual([...GROUP_TASK_MEDIA], ['text', 'voice', 'either'])
  assert.deepEqual([...GROUP_TASK_CATEGORIES], ['notice', 'learning_qa', 'discussion'])
  /* ⚠️ 授权来源**只有一项**：加第二项就等于放开伪造面 */
  assert.deepEqual([...GROUP_TASK_AUTH_SOURCES], ['owner_qq_private'])
  assert.deepEqual([...GROUP_SEND_STATES], ['queued', 'in_flight', 'api_accepted', 'failed_confirmed', 'unknown'])
})

check('02 bounds: 7-day window cap / 1..3 planned messages / 200 codepoints', () => {
  assert.equal(GROUP_TASK_LIMITS.maxWindowMs, 7 * 24 * 60 * 60 * 1000)
  assert.equal(GROUP_TASK_LIMITS.maxPlannedMessages, 3)
  assert.equal(GROUP_TASK_LIMITS.maxTextCodepoints, 500)
  assert.equal(GROUP_TASK_LIMITS.maxMemberIds, 16)
})

/* ------------------------------------------------------------------------- */
/* ② 静态准入例外（方案 §5 / §7）                                              */
/* ------------------------------------------------------------------------- */
check('03 admission: task wins over legacy deny (basis=group_task, scope=task_only, waives @)', () => {
  const decision = decideGroupAdmission({
    groupId: GROUP, legacyGroupAllowed: false,
    activeReplyTask: { taskId: 'gt-1', taskVersion: 3 },
  })
  assert.equal(decision.allowed, true)
  assert.equal(decision.basis, 'group_task')
  assert.equal(decision.scope, 'task_only')
  assert.equal(decision.taskId, 'gt-1')
  assert.equal(groupTaskWaivesMention(decision), true)
})

check('04 admission: legacy allowlist still works when no task (旧行为逐字不变)', () => {
  const decision = decideGroupAdmission({ groupId: GROUP, legacyGroupAllowed: true })
  assert.equal(decision.allowed, true)
  assert.equal(decision.basis, 'legacy_allowlist')
  assert.equal(decision.scope, 'legacy')
  assert.equal(groupTaskWaivesMention(decision), false)
})

check('05 admission: neither task nor legacy ⇒ denied', () => {
  const decision = decideGroupAdmission({ groupId: GROUP, legacyGroupAllowed: false })
  assert.equal(decision.allowed, false)
  assert.equal(decision.basis, 'denied')
  assert.equal(decision.scope, 'none')
})

/* ------------------------------------------------------------------------- */
/* ③ 入站路由                                                                  */
/* ------------------------------------------------------------------------- */
const inbound = (over: Partial<{
  messageId: string; senderId: string; at: number; addressesBot: boolean
}> = {}) => ({
  messageId: 'm-1', senderId: MEMBER_A, at: NOW, addressesBot: false, ...over,
})

check('06 routing: no reply task ⇒ default (and send_once never takes over)', () => {
  assert.equal(decideInboundRouting({ groupId: GROUP, inbound: inbound(), replyTasks: [], now: NOW, usage: zeroUsage }).route, 'default')
  const sendOnce = task({ kind: 'send_once' })
  assert.equal(
    decideInboundRouting({ groupId: GROUP, inbound: inbound(), replyTasks: [sendOnce], now: NOW, usage: zeroUsage }).route,
    'default')
})

check('07 routing: structurally eligible ⇒ task_candidate carries version/categories/topic', () => {
  const withScope = task({
    trigger: { memberIds: [MEMBER_A], replyToMessageId: null, categories: ['learning_qa'], topicScope: '数学作业' },
  })
  const decision = decideInboundRouting({
    groupId: GROUP, inbound: inbound(), replyTasks: [withScope], now: NOW, usage: zeroUsage,
  })
  assert.equal(decision.route, 'task_candidate')
  if (decision.route !== 'task_candidate') throw new Error('unreachable')
  assert.equal(decision.taskId, 'gt-1')
  assert.equal(decision.taskVersion, 3)
  assert.deepEqual([...decision.categories], ['learning_qa'])
  assert.equal(decision.topicScope, '数学作业')
})

check('08 routing: member out of scope ⇒ suppress (默认路线不许兜底)', () => {
  const onlyA = task({ trigger: { memberIds: [MEMBER_A], replyToMessageId: null, categories: [], topicScope: null } })
  const decision = decideInboundRouting({
    groupId: GROUP, inbound: inbound({ senderId: MEMBER_B }), replyTasks: [onlyA], now: NOW, usage: zeroUsage,
  })
  assert.equal(decision.route, 'suppress')
  if (decision.route !== 'suppress') throw new Error('unreachable')
  assert.equal(decision.code, 'group_task_member_out_of_scope')
})

check('09 routing: out of term (before start / after end) ⇒ suppress', () => {
  const windowed = task()
  const early = decideInboundRouting({
    groupId: GROUP, inbound: inbound({ at: 500 }), replyTasks: [windowed], now: 500, usage: zeroUsage,
  })
  assert.equal(early.route, 'suppress')
  const late = decideInboundRouting({
    groupId: GROUP, inbound: inbound({ at: 100_000 }), replyTasks: [windowed], now: 100_000, usage: zeroUsage,
  })
  assert.equal(late.route, 'suppress')
  if (late.route !== 'suppress') throw new Error('unreachable')
  assert.equal(late.code, 'group_task_out_of_term')
})

check('10 routing: replyToMessageId must match exactly', () => {
  const pinned = task({ trigger: { memberIds: [], replyToMessageId: 'm-9', categories: [], topicScope: null } })
  const decision = decideInboundRouting({
    groupId: GROUP, inbound: inbound(), replyTasks: [pinned], now: NOW, usage: zeroUsage,
  })
  assert.equal(decision.route, 'suppress')
  if (decision.route !== 'suppress') throw new Error('unreachable')
  assert.equal(decision.code, 'group_task_reply_target_mismatch')
})

check('11 routing: paused / exhausted quota / min interval / slot quota ⇒ suppress', () => {
  assert.equal(
    decideInboundRouting({ groupId: GROUP, inbound: inbound(), replyTasks: [task({ status: 'paused' })], now: NOW, usage: zeroUsage }).route,
    'suppress')
  const full = decideInboundRouting({
    groupId: GROUP, inbound: inbound(), replyTasks: [task()], now: NOW,
    usage: { totalMessages: 3, slotMessages: 0, lastSendAt: null },
  })
  assert.equal(full.route, 'suppress')
  if (full.route !== 'suppress') throw new Error('unreachable')
  assert.equal(full.code, 'group_task_total_budget_exhausted')

  const interval = decideInboundRouting({
    groupId: GROUP, inbound: inbound(), replyTasks: [task({ quota: { ...task().quota, minIntervalMs: 10_000 } })],
    now: NOW, usage: { totalMessages: 1, slotMessages: 0, lastSendAt: NOW - 1_000 },
  })
  assert.equal(interval.route, 'suppress')
  if (interval.route !== 'suppress') throw new Error('unreachable')
  assert.equal(interval.code, 'group_task_min_interval')

  const slot = decideInboundRouting({
    groupId: GROUP, inbound: inbound(),
    replyTasks: [task({ quota: { ...task().quota, slot: { windowMs: 60_000, maxMessages: 2 } } })],
    now: NOW, usage: { totalMessages: 2, slotMessages: 2, lastSendAt: null },
  })
  assert.equal(slot.route, 'suppress')
  if (slot.route !== 'suppress') throw new Error('unreachable')
  assert.equal(slot.code, 'group_task_slot_budget_exhausted')
})

check('12 routing: two non-terminal reply tasks in one group ⇒ fail closed (conflict)', () => {
  const decision = decideInboundRouting({
    groupId: GROUP, inbound: inbound(),
    replyTasks: [task({ id: 'gt-1' }), task({ id: 'gt-2' })], now: NOW, usage: zeroUsage,
  })
  assert.equal(decision.route, 'suppress')
  if (decision.route !== 'suppress') throw new Error('unreachable')
  assert.equal(decision.code, 'group_task_conflict_multiple_active')
})

check('13 routing: terminal tasks never take over (default resumes per original rules)', () => {
  for (const status of GROUP_TASK_TERMINAL_STATUSES) {
    const decision = decideInboundRouting({
      groupId: GROUP, inbound: inbound(), replyTasks: [task({ status })], now: NOW, usage: zeroUsage,
    })
    assert.equal(decision.route, 'default', status)
  }
})

/* ------------------------------------------------------------------------- */
/* ④ 发送额度                                                                  */
/* ------------------------------------------------------------------------- */
const allowance = (over: Partial<Parameters<typeof decideSendAllowance>[0]> = {}) => decideSendAllowance({
  task: task(), now: NOW, target: { botId: BOT, groupId: GROUP }, expectedVersion: null,
  plannedMessages: 1, plannedMedia: 'text', usage: zeroUsage, ...over,
})

check('14 allowance: happy path grants 1 message with the task version', () => {
  const decision = allowance()
  assert.equal(decision.kind, 'granted')
  if (decision.kind !== 'granted') throw new Error('unreachable')
  assert.equal(decision.reservedMessages, 1)
  assert.equal(decision.taskVersion, 3)
})

check('15 allowance: every denial code reachable and named', () => {
  const denials: [string, unknown][] = [
    ['group_task_terminal', allowance({ task: task({ status: 'revoked' }) })],
    ['group_task_not_active', allowance({ task: task({ status: 'paused' }) })],
    ['group_task_version_changed', allowance({ expectedVersion: 2 })],
    ['group_task_target_mismatch', allowance({ target: { botId: BOT, groupId: '987654321' } })],
    ['group_task_media_not_allowed', allowance({ task: task({ media: 'text' }), plannedMedia: 'voice' })],
    ['group_task_planned_messages_invalid', allowance({ plannedMessages: 0 })],
    ['group_task_planned_messages_invalid', allowance({ plannedMessages: 4 })],
    ['group_task_total_budget_exhausted', allowance({ usage: { ...zeroUsage, totalMessages: 3 } })],
    ['group_task_per_inbound_exhausted', allowance({ usage: { ...zeroUsage, perInboundMessages: 1 } })],
    ['group_task_out_of_term', allowance({ now: 100_000 })],
    ['group_task_slot_budget_exhausted', allowance({
      task: task({ quota: { ...task().quota, slot: { windowMs: 60_000, maxMessages: 2 } } }),
      usage: { ...zeroUsage, slotMessages: 2 },
    })],
    ['group_task_min_interval', allowance({
      task: task({ quota: { ...task().quota, minIntervalMs: 5_000 } }),
      usage: { ...zeroUsage, lastSendAt: NOW - 100 },
    })],
  ]
  for (const [code, decision] of denials) {
    const value = decision as { kind: string; code?: string }
    assert.equal(value.kind, 'denied', code)
    assert.equal(value.code, code)
  }
})

check('16 allowance: pre-send recheck uses the same function (version pinning)', () => {
  const first = allowance({ expectedVersion: 3 })
  assert.equal(first.kind, 'granted')
  const afterEdit = allowance({ expectedVersion: 3, task: task({ version: 4 }) })
  assert.equal(afterEdit.kind, 'denied')
  if (afterEdit.kind !== 'denied') throw new Error('unreachable')
  assert.equal(afterEdit.code, 'group_task_version_changed')
})

/* ------------------------------------------------------------------------- */
/* ⑤ 语音失败回落（方案 §7）                                                   */
/* ------------------------------------------------------------------------- */
check('17 voice fallback: confirmed ⇒ none / unknown ⇒ none (never duplicate)', () => {
  assert.deepEqual(decideVoiceFallback({ task: { media: 'voice', textFallback: false }, voiceDelivery: 'confirmed_sent' }), { kind: 'none' })
  assert.deepEqual(decideVoiceFallback({ task: { media: 'either', textFallback: true }, voiceDelivery: 'unknown' }), { kind: 'none' })
})

check('18 voice fallback: voice-only failure ⇒ named fail, NOT text', () => {
  const decision = decideVoiceFallback({ task: { media: 'voice', textFallback: false }, voiceDelivery: 'failed_confirmed' })
  assert.equal(decision.kind, 'fail')
  if (decision.kind !== 'fail') throw new Error('unreachable')
  assert.equal(decision.code, 'group_task_voice_only_no_text_fallback')
})

check('19 voice fallback: either + textFallback ⇒ exactly one counted text', () => {
  const decision = decideVoiceFallback({ task: { media: 'either', textFallback: true }, voiceDelivery: 'failed_confirmed' })
  assert.deepEqual(decision, { kind: 'send_text_fallback', countedMessages: 1 })
  /* either 但**没**给回落许可 ⇒ 也只如实失败 */
  const noPermission = decideVoiceFallback({ task: { media: 'either', textFallback: false }, voiceDelivery: 'failed_confirmed' })
  assert.equal(noPermission.kind, 'none')
})

/* ------------------------------------------------------------------------- */
/* ⑥ 条数口径（语音 / 附录 / 兜底都计数）                                      */
/* ------------------------------------------------------------------------- */
check('20 counting: voice + appendix + fallback all count as separate QQ messages', () => {
  assert.equal(countPlannedOutgoingMessages({ voice: 0, text: 1, appendices: 0, fallbackText: 0 }), 1)
  assert.equal(countPlannedOutgoingMessages({ voice: 1, text: 0, appendices: 1, fallbackText: 0 }), 2)
  assert.equal(countPlannedOutgoingMessages({ voice: 1, text: 0, appendices: 1, fallbackText: 1 }), 3)
  /* 文字模式的附录不单列（没有语音就没有"伴随"） */
  assert.equal(countPlannedOutgoingMessages({ voice: 0, text: 1, appendices: 2, fallbackText: 0 }), 1)
})

check('21 counting: worst case reserves fallback up front (voice/text are mutually exclusive forms)', () => {
  assert.equal(worstCaseOutgoingMessages({ media: 'text', appendices: 0, allowTextFallback: false }), 1)
  assert.equal(worstCaseOutgoingMessages({ media: 'voice', appendices: 0, allowTextFallback: true }), 2)
  /* either：语音侧 1+附录 1+兜底 1 = 3，文字侧 1 ⇒ 取 3（**不**把两侧相加成 4） */
  assert.equal(worstCaseOutgoingMessages({ media: 'either', appendices: 1, allowTextFallback: true }), 3)
  assert.equal(worstCaseOutgoingMessages({ media: 'either', appendices: 1, allowTextFallback: false }), 2)
  /* 文字模式的"附录"无意义，不计数 */
  assert.equal(worstCaseOutgoingMessages({ media: 'text', appendices: 2, allowTextFallback: false }), 1)
})

/* ------------------------------------------------------------------------- */
/* ⑦ 草稿解析                                                                  */
/* ------------------------------------------------------------------------- */
check('22 parse: minimal valid create draft round-trips', () => {
  const draft = readGroupTaskDraft(draftBase())
  assert.ok(draft !== undefined)
  if (draft === undefined || draft.kind !== 'create') throw new Error('unreachable')
  assert.equal(draft.spec.groupId, GROUP)
  assert.equal(draft.spec.taskKind, 'reply_window')
  assert.equal(draft.spec.contentMode, 'owner_verbatim')
  assert.equal(draft.spec.text, '今晚八点开会')
  assert.equal(draft.spec.totalMaxMessages, 3)
  assert.equal(draft.spec.perInboundMaxMessages, 1)
  assert.equal(draft.spec.minIntervalMs, 0)
  assert.equal(draft.spec.longTerm, false)
})

check('23 parse: kind shapes are closed (none/list/clarify/decline/modify/status)', () => {
  assert.deepEqual(readGroupTaskDraft({ kind: 'none' }), { kind: 'none' })
  assert.deepEqual(readGroupTaskDraft({ kind: 'list' }), { kind: 'list' })
  assert.deepEqual(readGroupTaskDraft({ kind: 'clarify', reason: '需要澄清' }), { kind: 'clarify', reason: '需要澄清' })
  assert.equal(readGroupTaskDraft({ kind: 'clarify' }), undefined)
  assert.equal(readGroupTaskDraft({ kind: 'none', extra: 1 }), undefined)
  const modify = readGroupTaskDraft({
    kind: 'modify', taskId: 'gt-1', expectedVersion: 3, patch: { media: 'either', textFallback: true },
  })
  assert.ok(modify !== undefined && modify.kind === 'modify')
  assert.equal(readGroupTaskDraft({
    kind: 'modify', taskId: 'gt-1', expectedVersion: 3, patch: { media: 'voice', textFallback: true },
  }), undefined)
  assert.ok(readGroupTaskDraft({ kind: 'status', action: 'stop', taskId: 'gt-1', expectedVersion: 3 }) !== undefined)
  assert.equal(readGroupTaskDraft({ kind: 'status', action: 'delete', taskId: 'gt-1', expectedVersion: 3 }), undefined)
})

check('24 parse: create rejections (extra key / missing key / voice fallback / text+brief / 7-day cap)', () => {
  const withExtra = { ...draftBase(), ownerAuthorized: true }
  assert.equal(readGroupTaskDraft(withExtra), undefined)
  const missingTotal = draftBase()
  delete missingTotal.totalMaxMessages
  assert.equal(readGroupTaskDraft(missingTotal), undefined)
  /* ⚠️ 只语音不得带文字回落 */
  assert.equal(readGroupTaskDraft({ ...draftBase(), media: 'voice', textFallback: true }), undefined)
  /* 原文模式不许同时给 brief */
  assert.equal(readGroupTaskDraft({ ...draftBase(), brief: '随便写' }), undefined)
  /* 生成模式必须有 brief、且不许给 text */
  assert.equal(readGroupTaskDraft({ ...draftBase(), contentMode: 'model_generated' }), undefined)
  assert.ok(readGroupTaskDraft({
    ...draftBase(), contentMode: 'model_generated', text: null, brief: '提醒带计算器',
  }) !== undefined)
  /* 窗口 > 7 天 ⇒ 作废 */
  assert.equal(readGroupTaskDraft({ ...draftBase(), endAt: 1_000 + GROUP_TASK_LIMITS.maxWindowMs + 1 }), undefined)
  /* 长期 + endAt 同时给 ⇒ 作废；都不给 ⇒ 作废 */
  assert.equal(readGroupTaskDraft({ ...draftBase(), longTerm: true }), undefined)
  const noWindow = draftBase()
  delete noWindow.endAt
  assert.equal(readGroupTaskDraft(noWindow), undefined)
  /* send_once 不需要长期授权 */
  assert.equal(readGroupTaskDraft({ ...draftBase(), taskKind: 'send_once', longTerm: true }), undefined)
  /* 成员号非数字 ⇒ 作废 */
  assert.equal(readGroupTaskDraft({ ...draftBase(), memberIds: ['alice'] }), undefined)
  /* 数量越界 ⇒ 作废 */
  assert.equal(readGroupTaskDraft({ ...draftBase(), totalMaxMessages: 201 }), undefined)
  assert.equal(readGroupTaskDraft({ ...draftBase(), perInboundMaxMessages: 4 }), undefined)
})

check('25 parse: long-term is explicit; owner_verbatim requires text', () => {
  const longTerm = readGroupTaskDraft({ ...draftBase(), endAt: null, longTerm: true })
  assert.ok(longTerm !== undefined)
  if (longTerm === undefined || longTerm.kind !== 'create') throw new Error('unreachable')
  assert.equal(longTerm.spec.longTerm, true)
  assert.equal(longTerm.spec.endAt, null)
  assert.equal(readGroupTaskDraft({ ...draftBase(), text: null }), undefined)
})

/* ------------------------------------------------------------------------- */
/* ⑧ 建单 / 修改 / 迁移 / 停止 / 恢复                                          */
/* ------------------------------------------------------------------------- */
const specOf = () => {
  const draft = readGroupTaskDraft(draftBase())
  if (draft === undefined || draft.kind !== 'create') throw new Error('fixture broken')
  return draft.spec
}

check('26 creation: non-owner source / group mismatch / overlapping reply task all denied', () => {
  assert.deepEqual(
    decideTaskCreation({
      spec: specOf(), authSource: 'owner_qq_private', boundTarget: { botId: BOT, groupId: GROUP },
      activeReplyTask: undefined, now: NOW,
    }),
    { ok: true })
  const forged = decideTaskCreation({
    spec: specOf(), authSource: 'group_member_claims' as unknown as GroupTaskAuthSource,
    boundTarget: { botId: BOT, groupId: GROUP }, activeReplyTask: undefined, now: NOW,
  })
  assert.equal(forged.ok, false)
  if (forged.ok) throw new Error('unreachable')
  assert.equal(forged.code, 'group_task_source_not_owner')

  const wrongGroup = decideTaskCreation({
    spec: specOf(), authSource: 'owner_qq_private', boundTarget: { botId: BOT, groupId: '555555555' },
    activeReplyTask: undefined, now: NOW,
  })
  assert.equal(wrongGroup.ok, false)
  if (wrongGroup.ok) throw new Error('unreachable')
  assert.equal(wrongGroup.code, 'group_task_target_mismatch')

  const conflict = decideTaskCreation({
    spec: specOf(), authSource: 'owner_qq_private', boundTarget: { botId: BOT, groupId: GROUP },
    activeReplyTask: { taskId: 'gt-0', taskVersion: 1 }, now: NOW,
  })
  assert.equal(conflict.ok, false)
  if (conflict.ok) throw new Error('unreachable')
  assert.equal(conflict.code, 'group_task_conflict_requires_decision')
})

check('27 modification: CAS conflict / voice-only fallback / usage above new cap denied; happy path bumps version', () => {
  const current = task()
  const conflict = decideTaskModification({ task: current, expectedVersion: 2, patch: { media: 'either' } })
  assert.equal(conflict.ok, false)
  if (conflict.ok) throw new Error('unreachable')
  assert.equal(conflict.code, 'group_task_version_conflict')

  const voiceOnly = decideTaskModification({
    task: current, expectedVersion: 3, patch: { media: 'voice', textFallback: true },
  })
  assert.equal(voiceOnly.ok, false)
  if (voiceOnly.ok) throw new Error('unreachable')
  assert.equal(voiceOnly.code, 'group_task_voice_only_no_text_fallback')

  const used = task({ usedMessages: 3 })
  const shrink = decideTaskModification({ task: used, expectedVersion: 3, patch: { totalMaxMessages: 2 } })
  assert.equal(shrink.ok, false)
  if (shrink.ok) throw new Error('unreachable')
  assert.equal(shrink.code, 'group_task_patch_invalid')

  assert.deepEqual(decideTaskModification({ task: current, expectedVersion: 3, patch: { media: 'either', textFallback: true } }),
    { ok: true, nextVersion: 4 })
  /* 终态不可改 */
  const terminal = decideTaskModification({ task: task({ status: 'revoked' }), expectedVersion: 3, patch: { media: 'either' } })
  assert.equal(terminal.ok, false)
  if (terminal.ok) throw new Error('unreachable')
  assert.equal(terminal.code, 'group_task_not_modifiable')
})

check('28 transitions: legal table / illegal pairs / terminal states are sinks', () => {
  assert.deepEqual(decideTaskTransition('active', 'paused'), { ok: true })
  assert.deepEqual(decideTaskTransition('paused', 'active'), { ok: true })
  assert.deepEqual(decideTaskTransition('active', 'revoked'), { ok: true })
  assert.deepEqual(decideTaskTransition('clarifying', 'active'), { ok: true })
  const illegal = decideTaskTransition('completed', 'active')
  assert.equal(illegal.ok, false)
  if (illegal.ok) throw new Error('unreachable')
  assert.equal(illegal.code, 'group_task_transition_invalid')
  for (const status of GROUP_TASK_TERMINAL_STATUSES) {
    /* 同态是幂等（`from===to` 放行），**跨到别的终态**必须全拒 */
    const allowed = GROUP_TASK_STATUSES
      .filter(next => next !== status)
      .filter(next => decideTaskTransition(status, next).ok)
    assert.deepEqual(allowed, [], status)
  }
})

check('29 stop report: subsequent blocked, in-flight counted, delivered cannot be revoked', () => {
  const report = decideTaskStop({ inFlightInstances: 2, maybeDeliveredInstances: 5 })
  assert.equal(report.stoppedSubsequent, true)
  assert.equal(report.inFlightRemaining, 2)
  assert.equal(report.maybeDelivered, 5)
  assert.equal(report.canRevokeDelivered, false)
  assert.equal(decideTaskStop({ inFlightInstances: -1, maybeDeliveredInstances: -1 }).inFlightRemaining, 0)
})

check('30 restart recovery + settlement consequences (unknown pauses, exhausted closes)', () => {
  assert.equal(recoverSendStateOnRestart('in_flight'), 'unknown')
  assert.equal(recoverSendStateOnRestart('queued'), 'failed_confirmed')
  assert.equal(recoverSendStateOnRestart('api_accepted'), 'api_accepted')
  assert.equal(recoverSendStateOnRestart('unknown'), 'unknown')

  const unknown = decideTaskAfterSendSettlement({ task: task(), usedMessages: 1, settlement: 'unknown' })
  assert.equal(unknown.pauseTask, true)
  assert.equal(unknown.markExhausted, false)
  assert.equal(unknown.code, 'group_send_result_unknown')

  const exhausted = decideTaskAfterSendSettlement({ task: task(), usedMessages: 3, settlement: 'api_accepted' })
  assert.equal(exhausted.markExhausted, true)
  assert.equal(exhausted.pauseTask, false)
})

/* ------------------------------------------------------------------------- */
/* ⑨ 读回纪律与事实回执                                                        */
/* ------------------------------------------------------------------------- */
check('31 read-back: wrong contract version throws a named error (never a default)', () => {
  const codeOf = (run: () => void): string | undefined => {
    try { run(); return undefined } catch (error) { return (error as { code?: string }).code }
  }
  assert.equal(codeOf(() => assertGroupTaskView({ contractVersion: 99 })), 'group_task_contract_version_mismatch')
  assert.equal(codeOf(() => assertGroupTaskView(null)), 'group_task_row_invalid')
  assert.equal(codeOf(() => assertGroupTaskView(task())), undefined)
})

check('32 fact text: created does not mean sent; api_accepted does not mean seen', () => {
  const text = groupTaskFactText({ kind: 'created', task: { id: 'gt-1' } })
  assert.ok(text.includes('不能说已经发送'))
  assert.ok(text.includes('不能说群成员已看到或听到'))
  assert.equal(groupTaskFactText({ kind: 'none' }), '')
  assert.equal(groupTaskFactText(undefined), '')
})

check('33 decision instruction: no keyword rules, no model-supplied authorization field', () => {
  /* 指令文本本身是产品面：这几条约束必须在里面（结构断言，不是语义证明） */
  const source = readFileSync(resolve(ROOT, 'src/kernel/contracts/qq-group-task.ts'), 'utf8')
  assert.ok(source.includes('GROUP_TASK_INSTRUCTION'))
  assert.ok(source.includes('不依赖关键词'))
  assert.ok(source.includes('不能生成授权来源') || source.includes('禁止生成授权来源'))
  /* 群号不得由模型自由给：建单判定要求与绑定目标逐字相同 */
  assert.ok(source.includes('input.spec.groupId !== input.boundTarget.groupId'))
})

/* ------------------------------------------------------------------------- */
/* 证据                                                                        */
/* ------------------------------------------------------------------------- */
const sources = [
  'src/kernel/contracts/qq-group-task.ts',
  'docs/adr/ADR-156-owner-authorized-qq-group-tasks.md',
]
mkdirSync(evidenceRoot, { recursive: true })
writeFileSync(resolve(evidenceRoot, 'result.json'), `${JSON.stringify({
  status: 'PASS',
  gate: 'postlv2:qq-group-task-contract:verify',
  checks: checks.length,
  controls: checks,
  ranAt: new Date().toISOString(),
  node: process.version,
  sources: Object.fromEntries(sources.map(path => [path, createHash('sha256')
    .update(readFileSync(resolve(ROOT, path))).digest('hex')])),
  boundary: {
    database: 'NOT_OPENED',
    network: 'NONE',
    realModel: 'NONE',
    realQq: 'NOT RUN',
    scope: 'pure contract decisions (admission / routing / allowance / media / counting / parsing / transitions)',
    notProven: '真实群送达、真实模型类别判断、语音听感、生产迁移 0027 —— 本门是纯函数测试材料',
  },
}, null, 2)}\n`)
console.log(`PASS: QQ 群任务契约（P0 · 纯函数）${checks.length} 项\n${evidenceRoot}`)
