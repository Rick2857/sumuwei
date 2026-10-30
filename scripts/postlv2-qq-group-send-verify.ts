/**
 * post-Lv2 / **QQ 群任务 · 单次群发送链** 门（群任务 P2）。
 *
 * ============================================================================
 *  这道门回答什么（零真实 QQ · 零真实网络 · 零真实模型 · 零真实 TTS · 不打开数据库）
 * ============================================================================
 * ```text
 * 01 能力登记：`qq.group.message/send`（write / R2）与 `qq.group.list/read`（read / R1）
 *    真的被登记口接受；自相矛盾的声明被拒（负控）
 * 02 参数闭集：未声明的键被拒（能力声明层 + 适配器层）
 * 03 **群号不可由载荷提供**：载荷带群号/收件人字段 ⇒ 具名拒绝（qq_group_send_group_from_argument）
 * 04 没有任务授权事实 ⇒ 失败关闭（qq_group_send_without_task_authorization），一条都不发
 * 05 任务过期（`decideSendAllowance` 判 group_task_out_of_term）⇒ 不发送
 * 06 任务版本已变（group_task_version_changed）⇒ 不发送
 * 07 目标不一致（group_task_target_mismatch）⇒ 不发送（判定层 + 适配器层两条）
 * 08 ★ **静态群名单外的群 + 有效任务授权 ⇒ 真的到达假 OneBot**
 *    （action === send_group_msg，group_id 与正文逐字正确）——"旧名单拒绝而任务授权可达"
 * 09 同一个静态名单外的群 + **没有任务** ⇒ `qq_target_no_longer_authorized`，假 OneBot 收到 0 条
 * 10 **只语音**任务 + 语音明确失败 ⇒ `decideVoiceFallback` 判 fail ⇒ **零文字兜底**
 * 11 `either` + textFallback + 语音明确失败 ⇒ **恰好 1 条**文字兜底（真的到达假 OneBot）
 * 12 语音结果不明（unknown）⇒ **零兜底、不重发**
 * 13 对外消息计数：`countPlannedOutgoingMessages` / `worstCaseOutgoingMessages` 逐例
 *    （语音 / 附录 / 兜底都计数；预留不足 ⇒ 适配器拒绝）
 * 14 `qq.group.list/read` 只读、且**不接受任何"指定一个群"的参数**
 * 15 发送后 `groupReplies` 记账（messageId 进集合）与 `qq_send_api_accepted` 日志
 * 16 旧私聊发送路径逐字不变（对照组：装了 authorizer 也不被旧路径查询）
 * ```
 *
 * ⚠️ **本门不证明**（必须与读数一起读）：
 * ```text
 * · 真机 QQ 送达 / 群成员是否看到 —— 假 OneBot 只是本机 ws 夹具
 * · 固定 LLBot/PMHQ 镜像的 record→SILK 转码 —— 未验证（本门只有 base64 段形状）
 * · 语音合成（TTS）—— **不在本批适配器内**；门里的合成端口是**假端口**，
 *   只为驱动 `decideVoiceFallback` 的三条分支
 * · 持久层任务行 / 原子额度预留 / 任务授权事实的读面 —— 那是 P1（另一个队友），
 *   本门用契约的 `decideSendAllowance` 现场算出事实，不查库
 * · ActionGateway / 策略 / `TASK_ARG_KEYS` / `TOOL_GATE_KEYS` 接线 —— 装配层由 Lead 负责
 * ```
 *
 * ⚠️ 本门**不需要 PG**：只起本机 ws 夹具与纯函数/适配器，临时目录 + loopback。
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { OneBotPrivateClient, type QqGroupTaskAuthorizer } from '../src/infrastructure/qq/onebot-private-client.ts'
import { readQqPrivateConfig } from '../src/infrastructure/qq/private-config.ts'
import {
  createQqGroupDeliveryAdapter,
  type QqGroupAuthorizationResolution,
  type QqGroupTaskAuthorizationFacts,
  type QqGroupTaskDeliveryPort,
} from '../src/infrastructure/action/adapters/qq-group-delivery.ts'
import type {
  AdapterExecuteInput,
  AdapterOutcome,
  CapabilityAdapter,
} from '../src/kernel/action/executor-port.ts'
import {
  ACTION_FAILURE_CODES,
  ActionFailureError,
  type ActionFailure,
} from '../src/kernel/action/errors.ts'
import {
  createCapabilityRegistry,
  createDefaultCapabilityDefinitions,
  validateCapabilityDefinition,
  DEFAULT_GRANTED_PERMISSIONS,
} from '../src/kernel/action/capability-registry.ts'
import {
  FORBIDDEN_GROUP_ARG_KEYS,
  QQ_GROUP_LIST,
  QQ_GROUP_LIST_ARG_KEYS,
  QQ_GROUP_LIST_PERMISSION,
  QQ_GROUP_MESSAGE,
  QQ_GROUP_SEND_ARG_KEYS,
  QQ_GROUP_SEND_PERMISSION,
  QQ_GROUP_TASK_TARGET_TYPE,
  assertQqGroupListArgKeys,
  assertQqGroupSendArgKeys,
  createQqGroupCapabilityDefinitions,
  groupArgViolation,
} from '../src/kernel/action/qq-group-capability.ts'
import {
  GROUP_TASK_CONTRACT_VERSION,
  GROUP_TASK_LIMITS,
  countPlannedOutgoingMessages,
  decideSendAllowance,
  decideVoiceFallback,
  worstCaseOutgoingMessages,
  type GroupTaskView,
} from '../src/kernel/contracts/qq-group-task.ts'
import { notificationTextFingerprint } from '../src/kernel/contracts/notification.ts'

const ROOT = resolve(import.meta.dirname, '..')
const stamp = new Date().toISOString().replace(/\D/g, '')
const evidenceRoot = resolve(ROOT, 'artifacts/post-lv2', `qq-group-send-${stamp}`)

/* ------------------------------------------------------------------------- */
/* 极简检查器（每项具名 PASS/FAIL；失败计数非零 ⇒ 退出码非零）                  */
/* ------------------------------------------------------------------------- */
const checks: string[] = []
const failures: string[] = []
const check = async (name: string, run: () => void | Promise<void>): Promise<void> => {
  try {
    await run()
    checks.push(name)
    console.log(`PASS ${name}`)
  } catch (error) {
    failures.push(name)
    const stack = error instanceof Error ? (error.stack ?? '') : ''
    const at = stack.split('\n').find((line) => line.includes('postlv2-qq-group-send-verify.ts')) ?? ''
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}${at === '' ? '' : `\n     ${at.trim()}`}`)
  }
}

/** 把适配器的失败归一成"过了 / 被拒（闭集码 + 具名 reason）" */
const runAdapter = async (
  adapter: CapabilityAdapter,
  input: AdapterExecuteInput
): Promise<{ ok: true; outcome: AdapterOutcome } | { ok: false; failure: ActionFailure }> => {
  try {
    return { ok: true, outcome: await adapter.execute(input) }
  } catch (error) {
    if (error instanceof ActionFailureError) return { ok: false, failure: error.failure }
    throw error
  }
}

const reasonOf = (failure: ActionFailure): string => String(failure.details?.reason ?? '')

/* ------------------------------------------------------------------------- */
/* 本机假 OneBot（ws 夹具；与 `scripts/qq/group-verify.ts` 同一种写法）        */
/* ------------------------------------------------------------------------- */
const OWNER = '10001'
const BOT = '10002'
const G_STATICA = '12345678'
const G_OUTSIDE = '87654321'
const NOW = Date.parse('2026-10-28T20:00:00+08:00')

const { WebSocketServer } = createRequire(import.meta.resolve('jsdom'))('ws') as {
  WebSocketServer: new (options: { host: string; port: number }) => {
    on: (event: string, handler: (connection: any) => void) => void
    once: (event: string, handler: () => void) => void
    address: () => { port: number }
    clients: Set<any>
    close: (done: () => void) => void
  }
}
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
await new Promise<void>((done) => server.once('listening', done))
const port = server.address().port

const connections: any[] = []
let packets: { action: string; params: Record<string, any> }[] = []
let nextMessageId = 9000
const behavior: { missingMessageIdForRecord?: boolean; rejectRecord?: boolean; rejectText?: boolean } = {}

server.on('connection', (connection: any) => {
  connections.push(connection)
  connection.on('message', (raw: Buffer) => {
    const packet = JSON.parse(raw.toString()) as {
      action: string; params: Record<string, any>; echo: string
    }
    if (packet.action === 'get_login_info') {
      connection.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: BOT }, echo: packet.echo }))
      return
    }
    packets.push({ action: packet.action, params: packet.params })
    const segments = Array.isArray(packet.params.message) ? packet.params.message : []
    const isRecord = segments.length === 1 && segments[0]?.type === 'record'
    if (isRecord && behavior.missingMessageIdForRecord === true) {
      /* 平台接受了记录段却没给回执 id ⇒ 外壳判 delivery_unknown（不是"没发出"） */
      connection.send(JSON.stringify({ status: 'ok', retcode: 0, data: {}, echo: packet.echo }))
      return
    }
    if (isRecord && behavior.rejectRecord === true) {
      connection.send(JSON.stringify({ status: 'failed', retcode: 100, data: null, echo: packet.echo }))
      return
    }
    if (!isRecord && behavior.rejectText === true) {
      connection.send(JSON.stringify({ status: 'failed', retcode: 100, data: null, echo: packet.echo }))
      return
    }
    connection.send(JSON.stringify({
      status: 'ok', retcode: 0, data: { message_id: ++nextMessageId }, echo: packet.echo,
    }))
  })
})

const settings = readQqPrivateConfig({
  QQ_OWNER_ID: OWNER,
  QQ_BOT_ID: BOT,
  QQ_ONEBOT_WS_URL: `ws://127.0.0.1:${port}/`,
  QQ_ONEBOT_ACCESS_TOKEN: 'offline-group-task-fixture-token-123456',
  QQ_MULTI_USER_ENABLED: 'true',
  QQ_ALLOWED_GROUP_IDS: G_STATICA,
})

type LogReading = { event: string; requestId?: string; messageId?: string | number; reason?: string }
const logs: LogReading[] = []
let authorizerCalls = 0
type AuthorizerMode = { kind: 'deny'; code: string } | { kind: 'facts'; facts: QqGroupTaskAuthorizationFacts }
/*
 * 授权端口的**可变状态**：每个检查自己设定它，模拟"持久层当前的任务事实"。
 * ⚠️ 它只认"正是这个 groupId + 正是这个 taskId/版本"，其它一律按版本已变拒绝
 *    —— 与契约 `decideSendAllowance` 的 expectedVersion 复核同一条纪律。
 */
let authorizerMode: AuthorizerMode = { kind: 'deny', code: 'group_task_not_active' }
const authorizer: QqGroupTaskAuthorizer = async (input) => {
  authorizerCalls += 1
  if (authorizerMode.kind === 'deny') return { ok: false, code: authorizerMode.code }
  const facts = authorizerMode.facts
  if (facts.groupId !== input.groupId || facts.taskId !== input.taskId
    || facts.taskVersion !== input.taskVersion) {
    return { ok: false, code: 'group_task_version_changed' }
  }
  return { ok: true }
}

const client = new OneBotPrivateClient(
  settings,
  (async () => ({
    kind: 'TURN_RESULT', requestId: 'fixture', outcome: 'replied', replyText: '收到。', delivery: 'generated',
  })) as never,
  (reading) => logs.push(reading),
  undefined,
  undefined,
  authorizer,
)

/* ------------------------------------------------------------------------- */
/* 契约事实：用 `decideSendAllowance` 现场算授权（不查库；P1 负责持久层）        */
/* ------------------------------------------------------------------------- */
const BASE_TASK: GroupTaskView = {
  id: 'task-fixture-1',
  contractVersion: GROUP_TASK_CONTRACT_VERSION,
  version: 3,
  status: 'active',
  kind: 'send_once',
  target: { botId: BOT, groupId: G_OUTSIDE },
  content: { mode: 'owner_verbatim', text: '今晚八点开组会。', brief: null },
  media: 'text',
  textFallback: false,
  trigger: { memberIds: [], replyToMessageId: null, categories: [], topicScope: null },
  term: { kind: 'window', startAt: NOW - 60_000, endAt: NOW + 600_000 },
  quota: { totalMaxMessages: 10, perInboundMaxMessages: 3, slot: null, minIntervalMs: 0 },
  usedMessages: 0,
  lastSendAt: null,
  authSource: 'owner_qq_private',
  createdAt: NOW - 60_000,
  updatedAt: NOW - 60_000,
}
const taskWith = (over: Partial<GroupTaskView>): GroupTaskView => ({ ...BASE_TASK, ...over })
const EMPTY_USAGE = { totalMessages: 0, slotMessages: 0, perInboundMessages: 0, lastSendAt: null }

const authorizationFor = (
  task: GroupTaskView,
  over: {
    now?: number
    target?: { botId: string; groupId: string }
    expectedVersion?: number | null
    plannedMedia?: 'text' | 'voice'
    plannedMessages?: number
  } = {}
): QqGroupAuthorizationResolution => {
  const decision = decideSendAllowance({
    task,
    now: over.now ?? NOW,
    target: over.target ?? task.target,
    expectedVersion: over.expectedVersion ?? null,
    plannedMedia: over.plannedMedia ?? 'text',
    plannedMessages: over.plannedMessages ?? 1,
    usage: EMPTY_USAGE,
  })
  if (decision.kind === 'denied') return { ok: false, code: decision.code }
  return {
    ok: true,
    facts: {
      taskId: task.id,
      taskVersion: decision.taskVersion,
      groupId: task.target.groupId,
      botId: task.target.botId,
      media: task.media,
      textFallback: task.textFallback,
      reservedMessages: decision.reservedMessages,
    },
  }
}

/** 统一的适配器输入（`target.canonicalId` 就是"解析出来的群号"，适配器会与授权事实核对） */
const adapterInput = (
  args: Record<string, unknown>,
  over: Partial<AdapterExecuteInput> = {}
): AdapterExecuteInput => ({
  actionId: 'action-group-send-fixture' as AdapterExecuteInput['actionId'],
  operation: 'send',
  target: {
    type: QQ_GROUP_TASK_TARGET_TYPE,
    canonicalId: G_OUTSIDE,
    confidence: 'exact',
  },
  args,
  idempotencyKey: 'group-send-delivery-key-fixture',
  now: () => NOW,
  ...over,
})

/* 投递端口：把适配器的发送**真的**交给外壳（于是假 OneBot 能收到） */
let deliverCalls: { media: 'text' | 'voice'; text: string; recordFileUrl?: string }[] = []
/** 08 那条发送拿到的 messageId（15 用它核对 groupReplies） */
let messageId08: string | undefined
const deliveryPort: QqGroupTaskDeliveryPort = {
  async deliver(input) {
    deliverCalls.push({
      media: input.media,
      text: input.text,
      ...(input.recordFileUrl === undefined ? {} : { recordFileUrl: input.recordFileUrl }),
    })
    const result = await client.deliverGroupTaskMessage({
      groupId: input.target.groupId,
      taskId: input.taskId,
      taskVersion: input.taskVersion,
      media: input.media,
      text: input.text,
      ...(input.recordFileUrl === undefined ? {} : { recordFileUrl: input.recordFileUrl }),
      deliveryKey: input.deliveryKey,
    })
    if (result.status === 'api_accepted') messageId08 = result.messageId
    return {
      written: result.status === 'api_accepted',
      status: result.status,
      ...(result.messageId === undefined ? {} : { messageId: result.messageId }),
      ...(result.reason === undefined ? {} : { code: result.reason }),
    }
  },
}

const waitFor = async (test: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (test()) return
    await delay(10)
  }
  throw new Error(`fixture_timeout:${label}`)
}

try {
  await client.connect()

  // =========================================================================
  await check('01 能力登记：qq.group.message/send(write/R2) 与 qq.group.list/read(read/R1) 被登记口接受', () => {
    const definitions = createQqGroupCapabilityDefinitions()
    const registry = createCapabilityRegistry([...createDefaultCapabilityDefinitions(), ...definitions])
    const send = registry.get(QQ_GROUP_MESSAGE)
    assert.ok(send !== undefined, 'qq.group.message 没被登记')
    assert.equal(send.version, `${QQ_GROUP_MESSAGE}@1`)
    assert.equal(send.sideEffectLevel, 'write')
    assert.equal(send.riskLevel, 'R2')
    assert.deepEqual([...send.permissions], [QQ_GROUP_SEND_PERMISSION])
    assert.equal(send.idempotency, 'required')
    assert.equal(send.supportsDryRun, true)
    const sendOp = registry.getOperation(QQ_GROUP_MESSAGE, 'send')
    assert.ok(sendOp !== undefined)
    assert.equal(sendOp.sideEffect, 'write')
    assert.equal(sendOp.riskLevel, 'R2')
    const list = registry.get(QQ_GROUP_LIST)
    assert.ok(list !== undefined, 'qq.group.list 没被登记')
    assert.equal(list.sideEffectLevel, 'read')
    assert.equal(list.riskLevel, 'R1')
    assert.deepEqual([...list.permissions], [QQ_GROUP_LIST_PERMISSION])
    assert.ok(list.operations.every((operation) => operation.sideEffect === 'read'))
    /* 负控：自相矛盾的声明被登记口拒绝（不合法 = 不存在） */
    const invalidId = validateCapabilityDefinition({
      ...definitions[0]!, id: 'qq.group_send.message',
    })
    assert.ok(invalidId.some((problem) => problem.code === 'invalid_id'),
      `下划线 id 竟然通过了登记口：${JSON.stringify(invalidId)}`)
    assert.throws(() => createCapabilityRegistry([{ ...definitions[0]!, id: 'qq.group_send.message' }]))
    const noPermissions = validateCapabilityDefinition({ ...definitions[0]!, permissions: [] })
    assert.ok(noPermissions.some((problem) => problem.code === 'no_permissions'))
    /* 本批是**追加式**：默认三项不认识群能力，权限也不默认授予 */
    const defaults = createDefaultCapabilityDefinitions().map((definition) => definition.id)
    assert.equal(defaults.includes(QQ_GROUP_MESSAGE), false)
    assert.equal(defaults.includes(QQ_GROUP_LIST), false)
    assert.equal(DEFAULT_GRANTED_PERMISSIONS.includes(QQ_GROUP_SEND_PERMISSION), false)
    assert.equal(DEFAULT_GRANTED_PERMISSIONS.includes(QQ_GROUP_LIST_PERMISSION), false)
  })

  // =========================================================================
  await check('02 参数闭集：未声明的键被拒（能力声明层 + 适配器层，bound 在契约上界）', async () => {
    assert.deepEqual([...QQ_GROUP_SEND_ARG_KEYS], ['text', 'media'])
    assert.equal(QQ_GROUP_SEND_ARG_KEYS.some((key) => FORBIDDEN_GROUP_ARG_KEYS.includes(key)), false)
    assert.doesNotThrow(() => assertQqGroupSendArgKeys({ text: '你好' }))
    let code = ''
    try {
      assertQqGroupSendArgKeys({ text: '你好', extra: 1 })
    } catch (error) {
      code = String((error as { code?: unknown }).code ?? '')
    }
    assert.equal(code, 'qq_group_send_unknown_arg')
    /*
     * 适配器层：多余键必须在**任何授权读取/发送之前**被拒
     * （⇒ 授权端口调用次数保持 0；用 `assertQqGroupSendArgKeys` 的同源复核）
     */
    let resolveCalls = 0
    const adapter = createQqGroupDeliveryAdapter({
      deliver: deliveryPort,
      resolveAuthorization: () => { resolveCalls += 1; return authorizationFor(BASE_TASK) },
    })
    const before = packets.length
    const run = await runAdapter(adapter, adapterInput({ text: '你好', extra: 1 }))
    assert.equal(run.ok, false)
    if (!run.ok) {
      assert.equal(run.failure.code, 'validation_failed')
      assert.equal(reasonOf(run.failure), 'qq_group_send_unknown_arg')
      assert.ok(ACTION_FAILURE_CODES.includes(run.failure.code))
    }
    assert.equal(resolveCalls, 0, '参数没通过之前不该去读授权事实')
    assert.equal(packets.length, before)
  })

  // =========================================================================
  await check('03 群号不可由载荷提供：载荷出现群号/收件人字段 ⇒ 具名拒绝 qq_group_send_group_from_argument', async () => {
    const violation = groupArgViolation({ text: 'x', groupId: G_OUTSIDE })
    assert.ok(violation !== undefined)
    assert.equal(violation.code, 'qq_group_send_group_from_argument')
    for (const key of ['group_id', 'groupId', '群号', 'user_id', 'to', 'recipient']) {
      assert.ok(FORBIDDEN_GROUP_ARG_KEYS.includes(key), `${key} 不在黑名单里`)
      assert.ok(groupArgViolation({ text: 'x', [key]: G_OUTSIDE }) !== undefined, `${key} 没被拦`)
    }
    let resolveCalls = 0
    const adapter = createQqGroupDeliveryAdapter({
      deliver: deliveryPort,
      resolveAuthorization: () => { resolveCalls += 1; return authorizationFor(BASE_TASK) },
    })
    const before = packets.length
    const run = await runAdapter(adapter, adapterInput({ text: '偷偷指定群', groupId: G_OUTSIDE }))
    assert.equal(run.ok, false)
    if (!run.ok) {
      assert.equal(run.failure.code, 'validation_failed')
      assert.equal(reasonOf(run.failure), 'qq_group_send_group_from_argument')
    }
    assert.equal(resolveCalls, 0)
    assert.equal(packets.length, before, '被拒的请求不许发出任何一条')
  })

  // =========================================================================
  await check('04 没有任务授权事实 ⇒ 失败关闭 qq_group_send_without_task_authorization，一条都不发', async () => {
    const adapter = createQqGroupDeliveryAdapter({ deliver: deliveryPort, resolveAuthorization: () => undefined })
    const before = packets.length
    const run = await runAdapter(adapter, adapterInput({ text: '没有任务的群消息' }))
    assert.equal(run.ok, false)
    if (!run.ok) {
      assert.equal(run.failure.code, 'permission_denied')
      assert.equal(reasonOf(run.failure), 'qq_group_send_without_task_authorization')
      assert.ok(ACTION_FAILURE_CODES.includes(run.failure.code))
    }
    assert.equal(packets.length, before)
  })

  // =========================================================================
  await check('05 任务过期（decideSendAllowance ⇒ group_task_out_of_term）⇒ 不发送', async () => {
    const expired = taskWith({
      term: { kind: 'window', startAt: NOW - 600_000, endAt: NOW - 1 },
    })
    const decision = decideSendAllowance({
      task: expired, now: NOW, target: expired.target, expectedVersion: null,
      plannedMedia: 'text', plannedMessages: 1, usage: EMPTY_USAGE,
    })
    assert.equal(decision.kind, 'denied')
    if (decision.kind === 'denied') assert.equal(decision.code, 'group_task_out_of_term')
    const adapter = createQqGroupDeliveryAdapter({
      deliver: deliveryPort,
      resolveAuthorization: () => authorizationFor(expired),
    })
    const before = packets.length
    const run = await runAdapter(adapter, adapterInput({ text: '过期任务' }))
    assert.equal(run.ok, false)
    if (!run.ok) {
      assert.equal(run.failure.code, 'permission_denied')
      assert.equal(reasonOf(run.failure), 'group_task_out_of_term')
    }
    assert.equal(packets.length, before)
  })

  // =========================================================================
  await check('06 任务版本已变（group_task_version_changed）⇒ 不发送', async () => {
    const decision = decideSendAllowance({
      task: BASE_TASK, now: NOW, target: BASE_TASK.target, expectedVersion: BASE_TASK.version - 1,
      plannedMedia: 'text', plannedMessages: 1, usage: EMPTY_USAGE,
    })
    assert.equal(decision.kind, 'denied')
    if (decision.kind === 'denied') assert.equal(decision.code, 'group_task_version_changed')
    const adapter = createQqGroupDeliveryAdapter({
      deliver: deliveryPort,
      resolveAuthorization: () => authorizationFor(BASE_TASK, { expectedVersion: BASE_TASK.version - 1 }),
    })
    const before = packets.length
    const run = await runAdapter(adapter, adapterInput({ text: '旧版本任务' }))
    assert.equal(run.ok, false)
    if (!run.ok) {
      assert.equal(run.failure.code, 'permission_denied')
      assert.equal(reasonOf(run.failure), 'group_task_version_changed')
    }
    assert.equal(packets.length, before)
  })

  // =========================================================================
  await check('07 目标不一致（group_task_target_mismatch）⇒ 不发送（判定层 + 适配器层）', async () => {
    const otherTarget = { botId: BOT, groupId: G_STATICA }
    const decision = decideSendAllowance({
      task: BASE_TASK, now: NOW, target: otherTarget, expectedVersion: null,
      plannedMedia: 'text', plannedMessages: 1, usage: EMPTY_USAGE,
    })
    assert.equal(decision.kind, 'denied')
    if (decision.kind === 'denied') assert.equal(decision.code, 'group_task_target_mismatch')
    const byDecision = createQqGroupDeliveryAdapter({
      deliver: deliveryPort,
      resolveAuthorization: () => authorizationFor(BASE_TASK, { target: otherTarget }),
    })
    const before = packets.length
    const first = await runAdapter(byDecision, adapterInput({ text: '目标不一致（判定层）' }))
    assert.equal(first.ok, false)
    if (!first.ok) {
      assert.equal(first.failure.code, 'permission_denied')
      assert.equal(reasonOf(first.failure), 'group_task_target_mismatch')
    }
    /* 适配器层：解析出来的目标群与授权事实不一致（不看判定端口也要拦） */
    const byAdapter = createQqGroupDeliveryAdapter({
      deliver: deliveryPort,
      resolveAuthorization: () => authorizationFor(BASE_TASK),
    })
    const second = await runAdapter(byAdapter, adapterInput(
      { text: '目标不一致（适配器层）' },
      { target: { type: QQ_GROUP_TASK_TARGET_TYPE, canonicalId: G_STATICA, confidence: 'exact' } }
    ))
    assert.equal(second.ok, false)
    if (!second.ok) {
      assert.equal(second.failure.code, 'validation_failed')
      assert.equal(reasonOf(second.failure), 'group_task_target_mismatch')
    }
    assert.equal(packets.length, before, '目标不一致时一条都不许发')
  })

  // =========================================================================
  await check('08 ★ 静态名单外的群 + 有效任务授权 ⇒ 真的到达假 OneBot（send_group_msg / 群号与正文逐字正确）', async () => {
    assert.equal(settings.allowedGroupIds?.includes(G_OUTSIDE) ?? false, false, '夹具设定：目标群不在静态名单里')
    /* 旧静态闸确实拒绝这个群（"旧名单拒绝"的事实，用公开的 isAllowedUser 读） */
    assert.equal(await client.isAllowedUser(OWNER, G_OUTSIDE), false)
    const task = taskWith({ target: { botId: BOT, groupId: G_OUTSIDE } })
    const authorization = authorizationFor(task)
    assert.equal(authorization.ok, true)
    if (authorization.ok) authorizerMode = { kind: 'facts', facts: authorization.facts }
    const text = '群里发一条：今晚八点开组会。'
    const adapter = createQqGroupDeliveryAdapter({
      deliver: deliveryPort,
      resolveAuthorization: () => authorization,
    })
    const before = packets.length
    const run = await runAdapter(adapter, adapterInput({ text }))
    assert.equal(run.ok, true, run.ok ? '' : `被拒：${reasonOf(run.failure)}`)
    if (run.ok) {
      assert.equal(run.outcome.effect?.kind, 'message_sent')
      assert.equal(run.outcome.effect?.fingerprint, notificationTextFingerprint(text))
      assert.equal(run.outcome.effect?.bytes, new TextEncoder().encode(text).length)
      assert.equal((run.outcome.effect?.detail ?? '').includes(text), false, '账本细节里不许出现正文')
    }
    const added = packets.slice(before)
    assert.equal(added.length, 1, `假 OneBot 应收到恰好 1 条，实际 ${String(added.length)}`)
    assert.equal(added[0]!.action, 'send_group_msg')
    assert.equal(String(added[0]!.params.group_id), G_OUTSIDE)
    assert.deepEqual(added[0]!.params.message, [{ type: 'text', data: { text } }])
  })

  // =========================================================================
  await check('09 静态名单外的群 + 没有任务 ⇒ qq_target_no_longer_authorized，假 OneBot 收到 0 条', async () => {
    authorizerMode = { kind: 'deny', code: 'group_task_not_active' }
    const before = packets.length
    const beforeAuthorizer = authorizerCalls
    const result = await client.deliverGroupTaskMessage({
      groupId: G_OUTSIDE, taskId: 'task-fixture-1', taskVersion: 3,
      media: 'text', text: '没有任务就不该发', deliveryKey: 'no-task-fixture',
    })
    assert.equal(result.status, 'failed_confirmed')
    assert.equal(result.reason, 'qq_target_no_longer_authorized')
    assert.equal(packets.length, before, '没有任务授权的群消息一条都不许发出')
    assert.equal(authorizerCalls, beforeAuthorizer + 1, '发送前复核必须真的被调用一次')
    assert.equal(await client.isAllowedUser(OWNER, G_OUTSIDE), false, '旧静态名单仍然拒绝这个群')
    assert.ok(logs.some((entry) => entry.event === 'qq_group_task_send_not_authorized'
      && entry.reason === 'qq_target_no_longer_authorized'))
  })

  // =========================================================================
  await check('10 只语音任务 + 语音明确失败 ⇒ decideVoiceFallback 判 fail ⇒ 零文字兜底（本批无真实 TTS）', async () => {
    /* 判定层的可执行断言（这条是"只语音不许改成文字"的落点） */
    const decision = decideVoiceFallback({
      task: { media: 'voice', textFallback: false }, voiceDelivery: 'failed_confirmed',
    })
    assert.equal(decision.kind, 'fail')
    if (decision.kind === 'fail') assert.equal(decision.code, 'group_task_voice_only_no_text_fallback')

    const task = taskWith({ media: 'voice', textFallback: false })
    const authorization = authorizationFor(task, { plannedMedia: 'voice', plannedMessages: 1 })
    assert.equal(authorization.ok, true)
    if (authorization.ok) authorizerMode = { kind: 'facts', facts: authorization.facts }
    deliverCalls = []
    const before = packets.length
    const adapter = createQqGroupDeliveryAdapter({
      deliver: deliveryPort,
      resolveAuthorization: () => authorization,
      /* 假合成端口（本批不提供真实 TTS）—— 明确失败 */
      synthesize: { synthesize: async () => ({ ok: false, reason: 'tts_fixture_failed' }) },
    })
    const run = await runAdapter(adapter, adapterInput({ text: '只语音的正文' }))
    assert.equal(run.ok, false)
    if (!run.ok) {
      assert.equal(run.failure.code, 'execution_failed')
      assert.equal(reasonOf(run.failure), 'group_task_voice_only_no_text_fallback')
    }
    assert.equal(deliverCalls.length, 0, '只语音明确失败时**不许**发文字兜底')
    assert.equal(packets.length, before, '假 OneBot 一条都不该收到')
  })

  // =========================================================================
  await check('11 either + textFallback + 语音明确失败 ⇒ 恰好 1 条文字兜底（真的到达假 OneBot）', async () => {
    const decision = decideVoiceFallback({
      task: { media: 'either', textFallback: true }, voiceDelivery: 'failed_confirmed',
    })
    assert.deepEqual(decision, { kind: 'send_text_fallback', countedMessages: 1 })

    const task = taskWith({ media: 'either', textFallback: true })
    const authorization = authorizationFor(task, {
      plannedMedia: 'voice', plannedMessages: worstCaseOutgoingMessages({
        media: 'either', appendices: 0, allowTextFallback: true,
      }),
    })
    assert.equal(authorization.ok, true)
    if (authorization.ok) {
      assert.equal(authorization.facts.reservedMessages, 2)
      authorizerMode = { kind: 'facts', facts: authorization.facts }
    }
    deliverCalls = []
    const text = '兜底文字：今晚八点开组会。'
    const before = packets.length
    const adapter = createQqGroupDeliveryAdapter({
      deliver: deliveryPort,
      resolveAuthorization: () => authorization,
      synthesize: { synthesize: async () => ({ ok: false, reason: 'tts_fixture_failed' }) },
    })
    const run = await runAdapter(adapter, adapterInput({ text, media: 'voice' }))
    assert.equal(run.ok, true, run.ok ? '' : `被拒：${reasonOf(run.failure)}`)
    if (run.ok) assert.equal(run.outcome.effect?.kind, 'message_sent')
    assert.equal(deliverCalls.length, 1, '必须**恰好**一次兜底投递')
    assert.equal(deliverCalls[0]!.media, 'text')
    const added = packets.slice(before)
    assert.equal(added.length, 1)
    assert.equal(added[0]!.action, 'send_group_msg')
    assert.deepEqual(added[0]!.params.message, [{ type: 'text', data: { text } }])
  })

  // =========================================================================
  await check('12 语音结果不明（unknown）⇒ 零兜底、不重发（假合成端口；本批无真实 TTS）', async () => {
    const decision = decideVoiceFallback({
      task: { media: 'either', textFallback: true }, voiceDelivery: 'unknown',
    })
    assert.equal(decision.kind, 'none')

    const task = taskWith({ media: 'either', textFallback: true })
    const authorization = authorizationFor(task, { plannedMedia: 'voice', plannedMessages: 3 })
    assert.equal(authorization.ok, true)
    if (authorization.ok) authorizerMode = { kind: 'facts', facts: authorization.facts }
    deliverCalls = []
    const before = packets.length
    const adapter = createQqGroupDeliveryAdapter({
      deliver: deliveryPort,
      resolveAuthorization: () => authorization,
      synthesize: { synthesize: async () => ({ ok: true, recordFileUrl: 'base64://ZmFrZS13YXY=' }) },
    })
    behavior.missingMessageIdForRecord = true
    try {
      const run = await runAdapter(adapter, adapterInput({ text: '结果不明的语音', media: 'voice' }))
      assert.equal(run.ok, false)
      if (!run.ok) {
        assert.equal(run.failure.code, 'timeout')
        assert.equal(reasonOf(run.failure), 'group_task_voice_delivery_unknown')
        assert.equal(run.failure.details?.fallbackSuppressed, true)
      }
    } finally {
      behavior.missingMessageIdForRecord = false
    }
    assert.equal(deliverCalls.length, 1, '结果不明时**不许**第二次投递（不重发）')
    assert.equal(deliverCalls[0]!.media, 'voice')
    const added = packets.slice(before)
    assert.equal(added.length, 1, '假 OneBot 只该收到那一条 record 段（本地夹具，不是真实语音）')
    assert.equal(added[0]!.params.message[0]!.type, 'record')
    assert.equal(added.some((packet) => packet.params.message[0]!.type === 'text'), false, '零文字兜底')
  })

  // =========================================================================
  await check('13 对外消息计数：语音/附录/兜底都计数（count / worstCase 逐例 + 预留不足被拒）', () => {
    /* countPlannedOutgoingMessages：一次逻辑回复**实际**产生的条数 */
    assert.equal(countPlannedOutgoingMessages({ voice: 0, text: 1, appendices: 0, fallbackText: 0 }), 1)
    assert.equal(countPlannedOutgoingMessages({ voice: 1, text: 0, appendices: 0, fallbackText: 0 }), 1)
    assert.equal(countPlannedOutgoingMessages({ voice: 1, text: 0, appendices: 1, fallbackText: 0 }), 2)
    assert.equal(countPlannedOutgoingMessages({ voice: 1, text: 0, appendices: 1, fallbackText: 1 }), 3)
    assert.equal(countPlannedOutgoingMessages({ voice: 1, text: 0, appendices: 0, fallbackText: 1 }), 2)
    assert.equal(countPlannedOutgoingMessages({ voice: 1, text: 0, appendices: -5, fallbackText: 0 }), 1)
    /* worstCaseOutgoingMessages：额度预留口径（语音与文字是互斥形态，取两侧较大值） */
    const worst = (media: 'text' | 'voice' | 'either', appendices: number, allow: boolean): number =>
      worstCaseOutgoingMessages({ media, appendices, allowTextFallback: allow })
    assert.equal(worst('text', 0, false), 1)
    assert.equal(worst('voice', 0, false), 1)
    assert.equal(worst('voice', 0, true), 2)
    assert.equal(worst('voice', 1, true), 3)
    assert.equal(worst('either', 0, false), 1)
    assert.equal(worst('either', 0, true), 2)
    assert.equal(worst('either', 1, false), 2)
    assert.equal(worst('either', 1, true), 3)
    /* 预留不足 ⇒ 适配器拒绝（不许"少占多发"）：either + 兜底最坏 3 条，只预留 1 条 */
    const underReserved: QqGroupAuthorizationResolution = {
      ok: true,
      facts: {
        taskId: 'task-fixture-1', taskVersion: 3, groupId: G_OUTSIDE, botId: BOT,
        media: 'either', textFallback: true, reservedMessages: 1,
      },
    }
    const adapter = createQqGroupDeliveryAdapter({
      deliver: deliveryPort,
      resolveAuthorization: () => underReserved,
    })
    return runAdapter(adapter, adapterInput({ text: '预留不足' })).then((run) => {
      assert.equal(run.ok, false)
      if (!run.ok) {
        assert.equal(run.failure.code, 'validation_failed')
        assert.equal(reasonOf(run.failure), 'qq_group_send_reserved_messages_insufficient')
      }
    })
  })

  // =========================================================================
  await check('14 qq.group.list/read 只读，且不接受任何"指定一个群"的参数', () => {
    assert.deepEqual([...QQ_GROUP_LIST_ARG_KEYS], [])
    assert.doesNotThrow(() => assertQqGroupListArgKeys({}))
    let code = ''
    try { assertQqGroupListArgKeys({ groupId: G_OUTSIDE }) } catch (error) {
      code = String((error as { code?: unknown }).code ?? '')
    }
    assert.equal(code, 'qq_group_list_group_from_argument')
    code = ''
    try { assertQqGroupListArgKeys({ foo: 1 }) } catch (error) {
      code = String((error as { code?: unknown }).code ?? '')
    }
    assert.equal(code, 'qq_group_list_unknown_arg')
    /* 声明层：只有 read 操作、R1、read 副作用；权限是独立的 qq:group_list */
    const registry = createCapabilityRegistry(createQqGroupCapabilityDefinitions())
    const list = registry.get(QQ_GROUP_LIST)
    assert.ok(list !== undefined)
    assert.deepEqual(list.operations.map((operation) => operation.name), ['read'])
    assert.ok(list.operations.every((operation) => operation.sideEffect === 'read'))
    assert.equal(list.riskLevel, 'R1')
    assert.deepEqual([...list.permissions], [QQ_GROUP_LIST_PERMISSION])
    /* 写能力也不接受群号参数（两张闭集互不共享群号字段） */
    assert.equal(QQ_GROUP_SEND_ARG_KEYS.some((key) => key.includes('group')), false)
  })

  // =========================================================================
  await check('15 发送后 groupReplies 记账（messageId 进集合）与 qq_send_api_accepted 日志', async () => {
    const replies = (client as unknown as { groupReplies: Map<string, Set<string>> }).groupReplies
    assert.ok(messageId08 !== undefined && messageId08 !== '', '08 那条发送没有拿到 messageId 读数')
    assert.equal(replies.get(G_OUTSIDE)?.has(messageId08), true,
      `groupReplies(${G_OUTSIDE}) 里没有 ${messageId08}：${JSON.stringify([...(replies.get(G_OUTSIDE) ?? [])])}`)
    assert.ok(logs.some((entry) => entry.event === 'qq_send_api_accepted'
      && String(entry.messageId) === messageId08), '缺少 qq_send_api_accepted 日志')
    assert.ok(logs.some((entry) => entry.event === 'qq_group_task_send_api_accepted'
      && entry.requestId === 'group-send-delivery-key-fixture'), '缺少群任务发送日志（键=deliveryKey）')
    assert.equal(replies.has(G_STATICA), false, '静态名单里的旧群不该被这次任务发送写账')
  })

  // =========================================================================
  await check('16 旧私聊发送路径逐字不变（对照组：装了 authorizer，旧路径也不查它）', async () => {
    assert.equal(connections.length >= 1, true)
    const before = packets.length
    const beforeAuthorizer = authorizerCalls
    const messageId = 4242
    connections[0]!.send(JSON.stringify({
      post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: BOT,
      user_id: OWNER, sender: { user_id: OWNER }, message_id: messageId,
      message: [{ type: 'text', data: { text: '在吗' } }],
    }))
    await waitFor(() => packets.length > before, 'old-private-reply')
    await client.drain()
    const added = packets.slice(before)
    assert.equal(added.length, 1)
    assert.equal(added[0]!.action, 'send_private_msg', '旧私聊路径仍然是 send_private_msg')
    assert.equal(String(added[0]!.params.user_id), OWNER)
    assert.deepEqual(added[0]!.params.message, [{ type: 'text', data: { text: '收到。' } }])
    assert.equal(added[0]!.params.group_id, undefined, '私聊发送不该带群号')
    assert.equal(authorizerCalls, beforeAuthorizer, '旧路径不许查询群任务授权端口')
  })
} finally {
  try { await client.close() } catch { /* 夹具收尾：连接可能已经断了 */ }
  for (const connection of server.clients) connection.terminate()
  await new Promise<void>((done) => server.close(() => done()))
}

/* ------------------------------------------------------------------------- */
/* 证据 + 退出码（失败计数非零 ⇒ 非零退出）                                     */
/* ------------------------------------------------------------------------- */
const passed = checks.length
const total = passed + failures.length
mkdirSync(evidenceRoot, { recursive: true })
writeFileSync(resolve(evidenceRoot, 'result.json'), `${JSON.stringify({
  status: failures.length === 0 ? 'PASS' : 'FAIL',
  checks: total,
  passed,
  failed: failures.length,
  failures,
  controls: checks,
  ranAt: new Date().toISOString(),
  node: process.version,
  boundary: {
    database: 'NOT_OPENED',
    network: 'LOCAL_LOOPBACK_ONLY',
    realOneBot: 'FAKE_WS_FIXTURE_ONLY',
    realQq: 'NOT RUN',
    realModel: 'NONE',
    realTts: 'NONE',
    voiceAdapters: 'NO_REAL_SYNTHESIS_PORT_IN_THIS_BATCH',
    notProven: '真机 QQ 送达；固定 LLBot/PMHQ record→SILK；真实语音合成；持久层任务行/原子预留（P1）；'
      + 'ActionGateway/策略/TASK_ARG_KEYS/TOOL_GATE_KEYS 接线（Lead）',
  },
}, null, 2)}\n`)

console.log('')
if (failures.length === 0) {
  console.log(`PASS: QQ 群任务单次发送链（P2，${String(passed)}/${String(total)} 项）\n${evidenceRoot}`)
} else {
  console.log(`FAIL: QQ 群任务单次发送链（P2，${String(passed)}/${String(total)} 项通过）`)
  console.log(`未通过：\n${failures.map((name) => `  · ${name}`).join('\n')}`)
  console.log(evidenceRoot)
  process.exitCode = 1
}
