/**
 * post-Lv2 / **QQ 群任务 · 工具键表 + 能力事实 + 决策解析器** 门（群任务 P2.1-C）。
 *
 * ============================================================================
 *  这道门回答什么（零真实网络 · 零模型请求 · 不打开数据库 · 不读时钟做判断）
 * ============================================================================
 * ```text
 * 01 工具键表：`TASK_ARG_KEYS` 有 `qq.group.message`（['text','media']）与
 *    `qq.group.list`（[]），且与能力声明里的参数闭集**逐字同源**
 * 02 闭集真的挡得住：`validateTaskPlan` 接受合法参数、拒绝 `group_id` 之类越界参数
 *    （两个能力各一条正控 + 一条负控）
 * 03 治理开关：`TOOL_GATE_KEYS` 两行都指向 `qqGroupTasksEnabled`；这个键在
 *    `KernelFlags` 里真实存在且**代码缺省 false**；开关关/开分别让目录里的
 *    `enabled` 为 false/true
 * 04 `auditToolCatalog()` 不再为这两个能力报 `missing_arg_keys` / `missing_gate_key`
 *    / `stale_arg_keys` / `generic_bypass_arg`
 * 05 能力事实：底层支持 / 适配器装配 / 任务授权 / 目标群可验证 **四件事分开呈现**
 * 06 口径纪律：未装配/无授权/未验证 三种说法里**没有**"永远只支持私聊"；
 *    有授权时**没有**"已经送达"；`api_accepted` 带"不等于群成员已经看到"的限定语
 * 07 发送结局闭集逐项（api_accepted / failed_confirmed / unknown / 无记录）
 * 08 形式 / 生效期 / 剩余额度 都被渲染（text·voice·either，window·long_term）
 * 09 缺省不传 `groupTasks` ⇒ 快照输出**逐字不变**（键不出现；去掉新键后深相等；
 *    两次调用字符串相同）
 * 10 `currentCapabilityFacts` **忽略**该字段 ⇒ 它的输出也逐字不变
 * 11 底层常量不是一句空话：`onebot-private-client.ts` 里真的有 `send_group_msg`
 * 12 决策解析器（照 `openai-relay.ts` 的形状）：无 key ⇒ unavailable 且**零请求**；
 *    指令**逐字**取自冻结契约 `GROUP_TASK_INSTRUCTION`；合法 JSON ⇒ `readGroupTaskDraft`
 *    能解析（**解析在调用方**）；非 JSON / HTTP 5xx / 网络抛错 / 截断 / 超时 各有闭集码；
 *    **任何路径都不抛**；简报有界（近期条数 / 单条码点）
 * ```
 *
 * ⚠️ **本门不证明**（必须与读数一起读）：
 * ```text
 * · 真实 QQ 群收发 —— 只断言代码里有 `send_group_msg`，没有连真机、没有假 ws 夹具
 * · 群任务适配器真的被装配 —— 事实视图只呈现"调用方说装没装"，装配由 Lead 接线
 * · 任务授权 / 目标群验证的真实来源 —— 本门注入的是**事实视图**，不查库、不解析群
 * · 真实模型输出 —— 解析器门用假 fetch（零模型请求）；"模型会不会给出合法草稿"未观察
 * · ActionGateway / 策略 / 开关消费点接线 —— 归 Lead（`src/main.ts`）
 * ```
 *
 * ⚠️ 零 PG、零出网、零模型请求：假 fetch + 已加载的纯函数。
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  createCapabilityRegistry,
  createDefaultCapabilityDefinitions,
} from '../src/kernel/action/capability-registry.ts'
import {
  FORBIDDEN_GROUP_ARG_KEYS,
  QQ_GROUP_LIST,
  QQ_GROUP_LIST_ARG_KEYS,
  QQ_GROUP_MESSAGE,
  QQ_GROUP_SEND_ARG_KEYS,
  createQqGroupCapabilityDefinitions,
} from '../src/kernel/action/qq-group-capability.ts'
import { TASK_ARG_KEYS, validateTaskPlan } from '../src/kernel/action/task-plan.ts'
import {
  TOOL_GATE_KEYS,
  auditToolCatalog,
  buildToolCatalog,
  type ToolGateKey,
} from '../src/kernel/action/tool-catalog.ts'
import { readKernelFlags } from '../src/kernel/app/flags.ts'
import {
  GROUP_TASK_INSTRUCTION,
  readGroupTaskDraft,
  type GroupTaskTurnInput,
  type GroupTaskView,
} from '../src/kernel/contracts/qq-group-task.ts'
import {
  currentCapabilityFacts,
  renderGroupTaskFacts,
  selfCapabilitySnapshot,
  QQ_GROUP_TRANSPORT_SUPPORTED,
  type GroupTaskFactsView,
} from '../src/infrastructure/project-knowledge/self-capabilities.ts'
import {
  GROUP_TASK_RESOLVER_FAILURES,
  MAX_MESSAGE_CODEPOINTS_IN_PROMPT,
  MAX_RECENT_MESSAGES_IN_PROMPT,
  buildGroupTaskMessages,
  createOpenAiGroupTaskResolver,
} from '../src/infrastructure/model/openai-group-task.ts'

const ROOT = resolve(import.meta.dirname, '..')
const stamp = new Date().toISOString().replace(/\D/g, '')
const evidenceRoot = resolve(ROOT, 'artifacts/post-lv2', `qq-group-facts-${stamp}`)
const GROUP_SWITCH: ToolGateKey = 'qqGroupTasksEnabled'

/* ------------------------------------------------------------------------- */
/* 极简检查器（每项具名 PASS/FAIL；失败计数非零 ⇒ 退出码非零）                  */
/* ------------------------------------------------------------------------- */
const checks: string[] = []
const failures: string[] = []
const readings: Record<string, unknown> = {}
const check = (name: string, run: () => void | Promise<void>): Promise<void> =>
  (async () => {
    try {
      await run()
      checks.push(name)
      console.log(`PASS ${name}`)
    } catch (error) {
      failures.push(name)
      const stack = error instanceof Error ? (error.stack ?? '') : ''
      const at = stack.split('\n').find((line) => line.includes('postlv2-qq-group-facts-verify.ts')) ?? ''
      console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}${at === '' ? '' : `\n     ${at.trim()}`}`)
    }
  })()

const section = (title: string): void => {
  console.log('')
  console.log(`== ${title} ==`)
}

const read = (relative: string): string => readFileSync(resolve(ROOT, relative), 'utf8')

/** 闭集里的一条失败：断言"结局是失败且码在闭集里" */
const expectFailure = (
  outcome: { ok: true } | { ok: false; failure: string },
  expected: string
): void => {
  assert.equal(outcome.ok, false, `期望失败 ${expected}，实际成功`)
  if (outcome.ok) throw new Error('unreachable')
  assert.equal(outcome.failure, expected)
  assert.ok(
    (GROUP_TASK_RESOLVER_FAILURES as readonly string[]).includes(outcome.failure),
    `失败码 ${outcome.failure} 不在闭集里`
  )
}

/* ------------------------------------------------------------------------- */
/* 夹具：登记表 / flags / 任务视图 / 事实视图                                   */
/* ------------------------------------------------------------------------- */
const registry = createCapabilityRegistry([
  ...createDefaultCapabilityDefinitions(),
  ...createQqGroupCapabilityDefinitions(),
])
const flagDefaults = readKernelFlags({})
const gateOn = (key: ToolGateKey): boolean => key === 'always' || key === GROUP_SWITCH
const gateOff = (key: ToolGateKey): boolean => key === 'always'

const GROUP = '12345678'
const BOT = '10002'

function taskView(): GroupTaskView {
  return {
    id: 'gtask-1',
    contractVersion: 1,
    version: 3,
    status: 'active',
    kind: 'reply_window',
    target: { botId: BOT, groupId: GROUP },
    content: { mode: 'model_generated', text: null, brief: '按主人要求接话' },
    media: 'either',
    textFallback: true,
    trigger: { memberIds: [], replyToMessageId: null, categories: [], topicScope: null },
    term: { kind: 'window', startAt: 1_760_000_000_000, endAt: 1_760_003_600_000 },
    quota: { totalMaxMessages: 10, perInboundMaxMessages: 1, slot: null, minIntervalMs: 0 },
    usedMessages: 3,
    lastSendAt: 1_760_000_500_000,
    authSource: 'owner_qq_private',
    createdAt: 1_759_999_000_000,
    updatedAt: 1_760_000_500_000,
  }
}

const turnInput = (): GroupTaskTurnInput => ({
  current: { id: 'm-owner-1', text: '在群里发一条今晚八点开组会的通知', actor: 'user' },
  recent: [{ id: 'm-owner-0', text: '晚点帮我发个通知', actor: 'user' }],
  tasks: [taskView()],
  authSource: 'owner_qq_private',
  boundTarget: { botId: BOT, groupId: GROUP },
})

const snapshotBase = {
  registry,
  flags: flagDefaults,
  entry: 'qq_private',
  wechat: false,
  now: 1_760_000_600_000,
}

/** 三态事实视图：未装配 / 无授权 / 未解析（最容易被说错的那一态） */
const viewUnassembled = (): GroupTaskFactsView => ({
  adapterAssembled: false,
  activeTasks: 0,
  pausedTasks: 0,
  latestTask: null,
  targetVerifiable: false,
})
/** 装配 + 有授权 + 目标可验证（"有授权≠已送达"要被断言的那一态） */
const viewAuthorized = (): GroupTaskFactsView => ({
  adapterAssembled: true,
  activeTasks: 1,
  pausedTasks: 0,
  latestTask: {
    id: 'gtask-1',
    status: 'active',
    media: 'either',
    term: { kind: 'window', startAt: 1_760_000_000_000, endAt: 1_760_003_600_000 },
    remainingMessages: 7,
    lastSendState: 'api_accepted',
    lastSendAt: 1_760_000_500_000,
  },
  targetVerifiable: true,
})

/** 说法纪律的禁用短语（**断言不存在**）：把"能力不存在"或"已送达"说死的措辞 */
const FORBIDDEN_PHRASES: readonly string[] = [
  '永远只支持私聊',
  '只支持私聊',
  '永远只能私聊',
  '只能私聊',
  '已经送达',
  '已送达',
  '成功送达',
]

const assertNoForbiddenPhrase = (text: string, where: string): void => {
  for (const phrase of FORBIDDEN_PHRASES) {
    assert.equal(text.includes(phrase), false, `${where} 里出现了禁用说法：${phrase}`)
  }
}

/* ------------------------------------------------------------------------- */
/* 01–02 工具键表 + 闭集真的挡得住                                             */
/* ------------------------------------------------------------------------- */
section('01. 工具键表：两行存在、闭集正确、与能力声明同源')
await check('正控：`TASK_ARG_KEYS` 有 `qq.group.message` = ["text","media"]（存在且闭集正确）', () => {
  const row = TASK_ARG_KEYS[QQ_GROUP_MESSAGE]
  assert.deepEqual(row, ['text', 'media'])
})
await check('正控：`TASK_ARG_KEYS` 有 `qq.group.list` = []（一个参数都不接受）', () => {
  assert.deepEqual(TASK_ARG_KEYS[QQ_GROUP_LIST], [])
})
await check('正控：两行与能力声明的参数闭集**逐字同源**（QQ_GROUP_SEND_ARG_KEYS / QQ_GROUP_LIST_ARG_KEYS）', () => {
  assert.deepEqual(TASK_ARG_KEYS[QQ_GROUP_MESSAGE], [...QQ_GROUP_SEND_ARG_KEYS])
  assert.deepEqual(TASK_ARG_KEYS[QQ_GROUP_LIST], [...QQ_GROUP_LIST_ARG_KEYS])
})
await check('负控：两行里**没有**任何群号/收件人字段（FORBIDDEN_GROUP_ARG_KEYS 逐键扫描）', () => {
  for (const capability of [QQ_GROUP_MESSAGE, QQ_GROUP_LIST]) {
    for (const key of TASK_ARG_KEYS[capability] ?? []) {
      assert.equal(
        FORBIDDEN_GROUP_ARG_KEYS.includes(key),
        false,
        `${capability} 的参数白名单里出现了收件人字段：${key}`
      )
    }
  }
  readings.groupArgKeys = [...FORBIDDEN_GROUP_ARG_KEYS]
})

section('02. 闭集真的挡得住：validateTaskPlan 正控/负控')
await check('正控：`qq.group.message/send` 的 {text, media} 通过计划校验', () => {
  const plan = validateTaskPlan({
    goal: '往授权群发一条通知',
    steps: [{ capability: QQ_GROUP_MESSAGE, operation: 'send', args: { text: '今晚八点开组会', media: 'text' } }],
    done: false,
  }, { registry, allowedCapabilities: [QQ_GROUP_MESSAGE] })
  assert.equal(plan.steps.length, 1)
  assert.deepEqual(plan.steps[0]!.args, { text: '今晚八点开组会', media: 'text' })
})
await check('负控：`qq.group.message/send` 带 `group_id` ⇒ `task_plan_step_arg_key_not_allowed`', () => {
  let code = ''
  try {
    validateTaskPlan({
      goal: '指定群发一条',
      steps: [{ capability: QQ_GROUP_MESSAGE, operation: 'send', args: { text: '在吗', group_id: GROUP } }],
      done: false,
    }, { registry, allowedCapabilities: [QQ_GROUP_MESSAGE] })
  } catch (error) {
    code = String((error as { code?: unknown }).code ?? '')
  }
  assert.equal(code, 'task_plan_step_arg_key_not_allowed')
})
await check('正控：`qq.group.list/read` 的空参数通过；负控：带 `group_id` 被拒', () => {
  const plan = validateTaskPlan({
    goal: '列出机器人所在群',
    steps: [{ capability: QQ_GROUP_LIST, operation: 'read', args: {} }],
    done: false,
  }, { registry, allowedCapabilities: [QQ_GROUP_LIST] })
  assert.deepEqual(plan.steps[0]!.args, {})
  let code = ''
  try {
    validateTaskPlan({
      goal: '列出指定群',
      steps: [{ capability: QQ_GROUP_LIST, operation: 'read', args: { group_id: GROUP } }],
      done: false,
    }, { registry, allowedCapabilities: [QQ_GROUP_LIST] })
  } catch (error) {
    code = String((error as { code?: unknown }).code ?? '')
  }
  assert.equal(code, 'task_plan_step_arg_key_not_allowed')
})

/* ------------------------------------------------------------------------- */
/* 03–04 治理开关 + auditToolCatalog                                           */
/* ------------------------------------------------------------------------- */
section('03. 治理开关：两行共用 `qqGroupTasksEnabled`，且这个键真实存在、缺省 false')
await check('正控：`TOOL_GATE_KEYS` 两行都是 `qqGroupTasksEnabled`（list 是 message 的从属能力）', () => {
  assert.equal(TOOL_GATE_KEYS[QQ_GROUP_MESSAGE], GROUP_SWITCH)
  assert.equal(TOOL_GATE_KEYS[QQ_GROUP_LIST], GROUP_SWITCH)
})
await check('正控：`KernelFlags` 里真有 `qqGroupTasksEnabled`，且**代码缺省 false**', () => {
  assert.equal(
    Object.prototype.hasOwnProperty.call(flagDefaults, GROUP_SWITCH),
    true,
    'KernelFlags 里没有 qqGroupTasksEnabled（治理键名会指向一个不存在的开关）'
  )
  assert.equal((flagDefaults as unknown as Record<string, unknown>)[GROUP_SWITCH], false)
  readings.flagDefault = (flagDefaults as unknown as Record<string, unknown>)[GROUP_SWITCH]
})
await check('正控：开关关 ⇒ 目录里两个能力 enabled=false；开关开 ⇒ true（同一处判据）', () => {
  const off = buildToolCatalog(registry, { isGateEnabled: gateOff })
  const on = buildToolCatalog(registry, { isGateEnabled: gateOn })
  for (const capability of [QQ_GROUP_MESSAGE, QQ_GROUP_LIST]) {
    assert.equal(off.find(entry => entry.capability === capability)?.enabled, false, `${capability} 关着时不该启用`)
    assert.equal(on.find(entry => entry.capability === capability)?.enabled, true, `${capability} 开着时该启用`)
  }
})

section('04. `auditToolCatalog()` 对这两个能力不再报问题')
await check('正控：没有 missing_arg_keys / missing_gate_key / stale_arg_keys / generic_bypass_arg 指向这两个能力', () => {
  const problems = auditToolCatalog(registry)
  readings.auditProblemCodes = problems.map((problem) => problem.code).sort()
  const relevant = problems.filter((problem) => {
    if (![QQ_GROUP_MESSAGE, QQ_GROUP_LIST].some((capability) => problem.message.includes(capability))) return false
    return ['missing_arg_keys', 'missing_gate_key', 'stale_arg_keys', 'generic_bypass_arg'].includes(problem.code)
  })
  assert.deepEqual(relevant, [])
})
await check('结构锁：两个能力**不在** `src/main.ts` 的 `TASK_CAPABILITY_IDS` 候选表里（群号不经模型参数）', () => {
  const mainText = read('src/main.ts')
  const start = mainText.indexOf('const TASK_CAPABILITY_IDS')
  assert.ok(start >= 0, 'main.ts 里找不到 TASK_CAPABILITY_IDS')
  const block = mainText.slice(start, mainText.indexOf('\n]', start))
  assert.ok(block.length > 0, 'TASK_CAPABILITY_IDS 的块没有被解析出来')
  assert.equal(block.includes('qq.group.'), false, '候选表里出现了 qq.group.* — 群发送不该由模型挑')
  assert.equal(block.includes('QQ_GROUP_MESSAGE'), false)
  assert.equal(block.includes('QQ_GROUP_LIST'), false)
})

/* ------------------------------------------------------------------------- */
/* 05–08 能力事实：四件事分开 + 口径纪律 + 结局闭集 + 形式/生效期/额度           */
/* ------------------------------------------------------------------------- */
section('05. 能力事实：底层支持 / 适配器装配 / 任务授权 / 目标群可验证 四件事分开')
const textUnassembled = renderGroupTaskFacts(viewUnassembled())
const textAuthorized = renderGroupTaskFacts(viewAuthorized())
readings.textUnassembled = textUnassembled
readings.textAuthorized = textAuthorized

await check('正控：未装配 / 无授权 / 未解析 三件事**分别**说出来（不被压成一个"不支持"）', () => {
  assert.ok(textUnassembled.includes('底层群收发：支持'), '底层支持没被说出来')
  assert.ok(textUnassembled.includes('群任务适配器：未装配'), '适配器未装配没被说出来')
  assert.ok(textUnassembled.includes('当前任务授权：无生效任务'), '无授权没被说出来')
  assert.ok(textUnassembled.includes('目标群可验证：否'), '目标群未验证没被说出来')
})
await check('口径：未装配/无授权/未验证 的说法里**没有**"永远只支持私聊"这类断言', () => {
  assertNoForbiddenPhrase(textUnassembled, '未装配态事实文本')
})
await check('口径：装配+有授权+可验证时**没有**"已经送达"，且自带"不等于群成员已经看到"的限定语', () => {
  assertNoForbiddenPhrase(textAuthorized, '已授权态事实文本')
  assert.ok(textAuthorized.includes('有授权**只表示**'), '缺"有授权只表示任务已登记"的限定')
  assert.ok(textAuthorized.includes('不等于'), '缺"不等于…"的限定语')
  assert.ok(textAuthorized.includes('群成员已经看到'), '`api_accepted` 缺"不等于群成员已经看到"的限定')
})
await check('结构锁：底层常量为 true，且 `onebot-private-client.ts` 里真的有 `send_group_msg`（常量不是空话）', () => {
  assert.equal(QQ_GROUP_TRANSPORT_SUPPORTED, true)
  const client = read('src/infrastructure/qq/onebot-private-client.ts')
  assert.ok(/send_group_msg/.test(client), 'OneBot 客户端里没有 send_group_msg —— 底层支持将是假话')
})

section('06–08. 发送结局闭集 / 形式 / 生效期 / 剩余额度 都被渲染')
const latestOf = (state: 'api_accepted' | 'failed_confirmed' | 'unknown' | null): string =>
  renderGroupTaskFacts({
    adapterAssembled: true,
    activeTasks: 1,
    latestTask: {
      id: 'gtask-1', status: 'active', media: 'either',
      term: { kind: 'long_term', startAt: 1_760_000_000_000 },
      remainingMessages: 0, lastSendState: state, lastSendAt: null,
    },
    targetVerifiable: true,
  })

await check('正控：`api_accepted` 的文本写明"平台已受理（不等于群成员已经看到或听到）"', () => {
  const text = latestOf('api_accepted')
  assert.ok(text.includes('平台已受理'))
  assert.ok(text.includes('不等于'))
  assertNoForbiddenPhrase(text, 'api_accepted 事实文本')
})
await check('正控：`failed_confirmed` = 明确失败（不会自动重试）；`unknown` = 结果不明（不重播）', () => {
  assert.ok(latestOf('failed_confirmed').includes('明确失败'))
  const unknown = latestOf('unknown')
  assert.ok(unknown.includes('结果不明'))
  assert.ok(unknown.includes('不重播'))
  assertNoForbiddenPhrase(unknown, 'unknown 事实文本')
})
await check('正控：没有发送记录 ⇒ "无发送记录（没有记录 ≠ 已经送到，也 ≠ 失败）"', () => {
  const text = latestOf(null)
  assert.ok(text.includes('无发送记录'))
  assert.ok(text.includes('≠ 已经送到'))
})
await check('正控：形式（text / voice / either）三种措辞都被渲染', () => {
  const withMedia = (media: 'text' | 'voice' | 'either'): string =>
    renderGroupTaskFacts({
      adapterAssembled: true, activeTasks: 1, targetVerifiable: true,
      latestTask: { id: 'gtask-1', status: 'active', media,
        term: { kind: 'long_term', startAt: 1_760_000_000_000 },
        remainingMessages: 1, lastSendState: null, lastSendAt: null },
    })
  assert.ok(withMedia('text').includes('只文字'))
  assert.ok(withMedia('voice').includes('只语音'))
  assert.ok(withMedia('either').includes('文字或语音由她选择'))
})
await check('正控：生效期（window / long_term）与剩余额度都被渲染', () => {
  const window = renderGroupTaskFacts(viewAuthorized())
  assert.ok(window.includes('窗口 2025-'))
  assert.ok(window.includes('剩余额度=7 条'))
  const longTerm = latestOf('api_accepted')
  assert.ok(longTerm.includes('长期有效'))
})
await check('正控：暂停不等于没有授权（paused>0 时也走"有授权"分支，且不断言"没有任何任务记录"）', () => {
  const paused = renderGroupTaskFacts({ adapterAssembled: true, activeTasks: 0, pausedTasks: 2, targetVerifiable: true })
  assert.ok(paused.includes('生效 0 条 · 暂停 2 条'))
  assert.ok(paused.includes('有授权**只表示**'))
  assert.ok(paused.includes('最近一条任务：未提供'), '拿不到单条事实时应如实说"未提供"')
  assert.equal(paused.includes('还没有任何群任务记录'), false, '有任务时不能断言"没有任何任务记录"')
})

/* ------------------------------------------------------------------------- */
/* 09–10 缺省不传 ⇒ 逐字不变                                                   */
/* ------------------------------------------------------------------------- */
section('09. 缺省不传 `groupTasks` ⇒ 快照输出逐字不变')
await check('正控：不传时快照里**没有** `groupTasks` 键（新段落是纯附加）', () => {
  const snapshot = selfCapabilitySnapshot({ ...snapshotBase })
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'groupTasks'), false)
})
await check('正控：传了与不传的差异**只在** `groupTasks` 一段（去掉它后深相等）', () => {
  const without = selfCapabilitySnapshot({ ...snapshotBase })
  const withFacts = selfCapabilitySnapshot({ ...snapshotBase, groupTasks: viewAuthorized() })
  const { groupTasks: added, ...rest } = withFacts as unknown as Record<string, unknown>
  assert.ok(added !== undefined, '传了 groupTasks 却没有这一段')
  assert.deepEqual(rest, without)
})
await check('正控：同一输入两次调用字符串相同（确定性；`now` 由调用方给）', () => {
  const first = JSON.stringify(selfCapabilitySnapshot({ ...snapshotBase }))
  const second = JSON.stringify(selfCapabilitySnapshot({ ...snapshotBase }))
  assert.equal(first, second)
})
await check('正控：`groupTasks` 段的机器字段四件事分开（transportSupported / adapterAssembled / authorization / targetVerifiable）', () => {
  const snapshot = selfCapabilitySnapshot({ ...snapshotBase, groupTasks: viewAuthorized() }) as unknown as {
    groupTasks: Record<string, unknown>
  }
  const facts = snapshot.groupTasks
  assert.equal(facts.transportSupported, true)
  assert.equal(facts.adapterAssembled, true)
  assert.equal(facts.targetVerifiable, true)
  const authorization = facts.authorization as Record<string, unknown>
  assert.equal(authorization.hasCurrent, true)
  assert.equal(authorization.active, 1)
  assert.equal(authorization.latestTaskId, 'gtask-1')
  assert.equal(typeof facts.text, 'string')
})

section('10. `currentCapabilityFacts` 忽略该字段 ⇒ 输出逐字不变')
await check('正控：`currentCapabilityFacts` 传/不传 `groupTasks` 输出相同（kernel 视图形状未变）', () => {
  const without = currentCapabilityFacts({ ...snapshotBase })
  const withFacts = currentCapabilityFacts({ ...snapshotBase, groupTasks: viewAuthorized() })
  assert.equal(JSON.stringify(withFacts), JSON.stringify(without))
})

/* ------------------------------------------------------------------------- */
/* 11–12 决策解析器（假 fetch；零真实网络 / 零模型请求）                        */
/* ------------------------------------------------------------------------- */
section('11–12. 群任务决策解析器：指令从契约派生 / 失败分桶 / 绝不抛 / 简报有界')

type FetchCall = { url: string; init: RequestInit }

const makeFetch = (handler: (call: FetchCall) => Promise<Response>) => {
  const calls: FetchCall[] = []
  const fetchImpl = (async (url: string, init: RequestInit): Promise<Response> => {
    const call = { url, init }
    calls.push(call)
    return handler(call)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

const completion = (content: string, finishReason = 'stop'): Response =>
  jsonResponse({ choices: [{ finish_reason: finishReason, message: { content } }] })

const ENV = { OPENAI_API_KEY: 'group-task-fixture-key', OPENAI_BASE_URL: 'https://api.example.invalid/v1', OPENAI_SMALL_MODEL: 'fixture-model' }

const VALID_CREATE_DRAFT = JSON.stringify({
  kind: 'create',
  groupId: GROUP,
  groupNameHint: '测试群',
  taskKind: 'send_once',
  contentMode: 'owner_verbatim',
  text: '今晚八点开组会',
  brief: null,
  media: 'text',
  textFallback: false,
  memberIds: [],
  replyToMessageId: null,
  categories: [],
  topicScope: null,
  startAt: 1_760_000_000_000,
  endAt: 1_760_003_600_000,
  longTerm: false,
  totalMaxMessages: 1,
  perInboundMaxMessages: 1,
  slot: null,
  minIntervalMs: 0,
})

await check('负控：没有 API key ⇒ `group_task_model_unavailable`，且**一个请求都不发**', async () => {
  const { fetchImpl, calls } = makeFetch(async () => completion(VALID_CREATE_DRAFT))
  const resolver = createOpenAiGroupTaskResolver({ env: {}, fetchImpl })
  const result = await resolver.resolve(turnInput())
  expectFailure(result, 'group_task_model_unavailable')
  assert.equal(calls.length, 0)
})
await check('正控：合法 JSON ⇒ `{ok:true}`，且调用方的 `readGroupTaskDraft` 能解析（解析不在解析器里做）', async () => {
  const { fetchImpl } = makeFetch(async () => completion(VALID_CREATE_DRAFT))
  const resolver = createOpenAiGroupTaskResolver({ env: ENV, fetchImpl })
  const result = await resolver.resolve(turnInput())
  assert.equal(result.ok, true, JSON.stringify(result))
  if (!result.ok) return
  const draft = readGroupTaskDraft(result.draft)
  assert.ok(draft !== undefined, '合法草稿被契约整条作废')
  assert.equal(draft?.kind, 'create')
})
await check('正控：系统提示**逐字**取自冻结契约 `GROUP_TASK_INSTRUCTION`（不在这里重写指令）', async () => {
  const { fetchImpl, calls } = makeFetch(async () => completion(VALID_CREATE_DRAFT))
  const resolver = createOpenAiGroupTaskResolver({ env: ENV, fetchImpl })
  await resolver.resolve(turnInput())
  assert.equal(calls.length, 1)
  const body = JSON.parse(String(calls[0]!.init.body)) as {
    messages: { role: string; content: string }[]
    response_format?: { type?: string }
    model?: string
  }
  assert.equal(body.messages[0]!.role, 'system')
  assert.equal(body.messages[0]!.content, GROUP_TASK_INSTRUCTION)
  assert.equal(body.messages[1]!.role, 'user')
  assert.ok(body.messages[1]!.content.includes('在群里发一条今晚八点开组会的通知'), '简报里没有当前消息')
  assert.equal(body.response_format?.type, 'json_object')
  assert.equal(body.model, 'fixture-model')
  assert.ok(calls[0]!.url.endsWith('/chat/completions'))
})
await check('负控：模型给了**不是 JSON** 的正文 ⇒ `group_task_model_invalid_output`（不是 call_failed）', async () => {
  const { fetchImpl } = makeFetch(async () => completion('我想想……这个任务大概是这样的：{'))
  const resolver = createOpenAiGroupTaskResolver({ env: ENV, fetchImpl })
  expectFailure(await resolver.resolve(turnInput()), 'group_task_model_invalid_output')
})
await check('负控：HTTP 500 ⇒ `group_task_model_call_failed`', async () => {
  const { fetchImpl } = makeFetch(async () => jsonResponse({ error: 'boom' }, 500))
  const resolver = createOpenAiGroupTaskResolver({ env: ENV, fetchImpl })
  expectFailure(await resolver.resolve(turnInput()), 'group_task_model_call_failed')
})
await check('负控：fetch 抛错（网络失败）⇒ `group_task_model_call_failed`（不抛给调用方）', async () => {
  const { fetchImpl } = makeFetch(async () => {
    throw new Error('ECONNREFUSED')
  })
  const resolver = createOpenAiGroupTaskResolver({ env: ENV, fetchImpl })
  expectFailure(await resolver.resolve(turnInput()), 'group_task_model_call_failed')
})
await check('负控：`finish_reason=length` ⇒ `group_task_model_output_truncated`', async () => {
  const { fetchImpl } = makeFetch(async () => completion('{"kind":"none"}', 'length'))
  const resolver = createOpenAiGroupTaskResolver({ env: ENV, fetchImpl })
  expectFailure(await resolver.resolve(turnInput()), 'group_task_model_output_truncated')
})
await check('负控：fetch 永不返回（且不遵守 signal）⇒ 墙钟超时 ⇒ `group_task_model_timeout`（不挂住调用方）', async () => {
  const { fetchImpl } = makeFetch(() => new Promise<Response>(() => {}))
  const resolver = createOpenAiGroupTaskResolver({ env: ENV, fetchImpl, timeoutMs: 30 })
  expectFailure(await resolver.resolve(turnInput()), 'group_task_model_timeout')
})
await check('正控：简报**有界**（近期只带最后 8 条；单条截断到 1000 码点）', () => {
  const long = '啊'.repeat(MAX_MESSAGE_CODEPOINTS_IN_PROMPT + 500)
  const messages = buildGroupTaskMessages({
    ...turnInput(),
    recent: Array.from({ length: 50 }, (_, index) => ({ id: `m-${String(index)}`, text: `第${String(index)}条`, actor: 'user' as const })),
    current: { id: 'm-owner-1', text: long, actor: 'user' },
  })
  const briefing = messages[1]!.content
  assert.ok(briefing.includes(`最近 ${String(MAX_RECENT_MESSAGES_IN_PROMPT)} 条`), '近期上下文没有按上限裁剪')
  assert.equal(briefing.includes('第0条'), false, '超过上限的旧消息仍被带进简报')
  assert.ok(briefing.includes('第49条'), '最新的消息被裁掉了')
  assert.ok(briefing.includes('…'), '超长正文没有被截断')
  assert.equal(briefing.includes('啊'.repeat(MAX_MESSAGE_CODEPOINTS_IN_PROMPT + 1)), false, '超长正文没有被截断')
})

/* ------------------------------------------------------------------------- */
/* 证据 + 退出码（失败计数非零 ⇒ 非零退出）                                     */
/* ------------------------------------------------------------------------- */
const passed = checks.length
const total = passed + failures.length
mkdirSync(evidenceRoot, { recursive: true })
/*
 * 三态事实文本**原文**落盘：读数之外还要能被人直接读一遍措辞
 * （"没有授权 ≠ 永远只支持私聊" / "有授权 ≠ 已经送到" 这两条只能靠读原文复核）。
 */
writeFileSync(resolve(evidenceRoot, 'fact-texts.md'), [
  '# 群任务能力事实文本（三种状态的原文）',
  '',
  '## ① 未装配 / 无授权 / 目标群未验证',
  '',
  '```text',
  renderGroupTaskFacts(viewUnassembled()),
  '```',
  '',
  '## ② 已装配 / 有 1 条生效授权 / 目标群可验证 / 最近结局 api_accepted',
  '',
  '```text',
  renderGroupTaskFacts(viewAuthorized()),
  '```',
  '',
  '## ③ 已装配 / 生效 0 条但暂停 2 条（暂停 ≠ 没有授权过）',
  '',
  '```text',
  renderGroupTaskFacts({ adapterAssembled: true, activeTasks: 0, pausedTasks: 2, targetVerifiable: true }),
  '```',
  '',
  `禁用短语（逐条断言**不出现**）：${FORBIDDEN_PHRASES.join(' / ')}`,
  '',
].join('\n'))
writeFileSync(resolve(evidenceRoot, 'result.json'), `${JSON.stringify({
  status: failures.length === 0 ? 'PASS' : 'FAIL',
  checks: total,
  passed,
  failed: failures.length,
  failures,
  controls: checks,
  readings,
  ranAt: new Date().toISOString(),
  node: process.version,
  boundary: {
    database: 'NOT_OPENED',
    network: 'NONE',
    realModel: 'NONE',
    realQq: 'NOT RUN',
    modelCalls: 'FAKE_FETCH_FIXTURE_ONLY',
    notProven: '真实 QQ 群收发；群任务适配器是否真的被装配（归 Lead）；任务授权/目标群验证的真实来源；'
      + '真实模型草稿质量；ActionGateway/策略/开关消费点接线（归 Lead）',
  },
}, null, 2)}\n`)

console.log('')
if (failures.length === 0) {
  console.log(`PASS: QQ 群任务工具键表 / 能力事实 / 决策解析器（P2.1-C，${String(passed)}/${String(total)} 项）\n${evidenceRoot}`)
} else {
  console.log(`FAIL: QQ 群任务工具键表 / 能力事实 / 决策解析器（P2.1-C，${String(passed)}/${String(total)} 项通过）`)
  console.log(`未通过：\n${failures.map((name) => `  · ${name}`).join('\n')}`)
  console.log(evidenceRoot)
  process.exitCode = 1
}
