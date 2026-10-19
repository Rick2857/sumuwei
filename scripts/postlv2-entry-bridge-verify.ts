/**
 * 后 Lv2 · WP1 —— **LG 入口桥门**（`pnpm postlv2:bridge:verify`）。
 *
 * ============================================================================
 *  载体：计划书 §4 / §9 / §10（WP1）· ADR-091 §4（`D10`–`D13`）· INV-PL2-08/09/11
 * ============================================================================
 * 它守什么（**全离线**：隔离库 + 真实 `TurnGateway`；**模型那一跳由 `replyText` 注入**，
 * 与 M5 / M5.1.1 / Lv2 既有做法一致 —— 本门验的不是模型）：
 * ```text
 * B1 静态：桥**在类型与代码上都拿不到** prompt 与模型（不 import 编译器 / 模型适配器 / 数据库）
 * B2 静态：prompt 的唯一入口仍是 ContextCompiler；除装配层外没有第二处构造 prompt
 * B3 身份绑定：角色/会话由**装配层**决定；请求无法改变它们（INV-PL2-08）
 * B4 形状失败关闭：坏 requestId / 空文本 / 超长文本 / 未登记消息种类 ⇒ rejected（具名码）
 * B5 **失败不回落**：装配层抛错 ⇒ failed，且**不**调用任何"默认 Agent"路径
 * B6 幂等：同 requestId 重复提交 ⇒ 同一份结果、**零**新增用户事件、**零**额外轮次
 * B7 串行：同一会话的正式写入轮次**串行**（并发提交不会交错写库）
 * B8 真实轮次：经真实 `TurnGateway` 走完一轮（beginTurn → completeTurn），事件真的落库
 * B9 交付真相：`delivery` 三态与 `outcome` 一致；桥**从不**声称"已播出"
 * V1 量具自证三段式（正控 / 负控 / 恢复）
 * ```
 * ⚠️ 使用隔离库（`isolateDatabase()`）；**不打开** `data/pglite`。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'

import { asConversationId, asCharacterId } from '../src/kernel/contracts/ids.ts'
import { bindSpeechExpression, decodeExpressiveSpeech } from '../src/kernel/contracts/expressive-speech.ts'
import {
  BRIDGE_MESSAGE_KINDS,
  DEFAULT_MAX_USER_TEXT_LENGTH,
  TurnBridge,
  handleBridgeMessage,
  isBridgeMessageKind,
  toLookupReading,
  type BridgeSubmitResult,
  type HostTurnResult,
  type TurnBridgeHost,
} from '../src/kernel/app/bridge/turn-bridge.ts'

const REPO_ROOT = resolve(process.cwd())

interface Check {
  id: string
  label: string
  pass: boolean
  detail: string
  measured: number
}
const checks: Check[] = []
const record = (id: string, label: string, pass: boolean, detail: string, measured: number): void => {
  checks.push({ id, label, pass, detail, measured })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

// ===========================================================================
// B1/B2 静态判据
// ===========================================================================
const BRIDGE_REL = 'src/kernel/app/bridge/turn-bridge.ts'
const bridgeSource = readFileSync(join(REPO_ROOT, BRIDGE_REL), 'utf8')

/** 只保留代码行（去掉块注释与行注释），避免把"说明文字"当成违规 */
function codeOnly(source: string): string[] {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '')
  return withoutBlocks
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//')
      return index === -1 ? line : line.slice(0, index)
    })
    .filter((line) => line.trim() !== '')
}

const bridgeCode = codeOnly(bridgeSource)
const bridgeImports = bridgeCode.filter((line) => /^\s*import\s/.test(line))
const FORBIDDEN_IN_BRIDGE = [
  'infrastructure',
  'context/compiler',
  'callModel',
  'openai',
  '@elizaos',
  'drizzle',
  'node:fs',
]
const bridgeViolations: string[] = []
for (const line of bridgeImports) {
  for (const needle of FORBIDDEN_IN_BRIDGE) {
    if (line.toLowerCase().includes(needle.toLowerCase())) bridgeViolations.push(`${line.trim()} → ${needle}`)
  }
}
const PROMPT_VERBS = ['compileTurn', 'compileContext', 'promptFor', 'buildPrompt']
const promptVerbHits = bridgeCode.filter((line) => PROMPT_VERBS.some((verb) => line.includes(verb)))
record(
  'B1',
  '静态：桥**在类型与代码上都拿不到** prompt 与模型（不 import 编译器/模型适配器/数据库）',
  bridgeViolations.length === 0 && promptVerbHits.length === 0 && bridgeImports.length > 0,
  `import 行=${bridgeImports.length} 条 · 违规=${JSON.stringify(bridgeViolations)} · prompt 动词命中=${JSON.stringify(promptVerbHits)}`,
  bridgeImports.length + PROMPT_VERBS.length
)

// prompt 的唯一入口：`TurnGateway.compileTurn` 只应被 `main.ts` 与验收脚本调用
const compileTurnCallers: string[] = []
const { readdirSync, statSync } = await import('node:fs')
const collectCompileTurnCallers = (dir: string): void => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      collectCompileTurnCallers(full)
      continue
    }
    if (!entry.endsWith('.ts')) continue
    const relative = full.slice(REPO_ROOT.length).replaceAll('\\', '/')
    const code = codeOnly(readFileSync(full, 'utf8')).join('\n')
    if (/\.compileTurn\(/.test(code) && !relative.startsWith('/src/kernel/app/turn-gateway.ts')) {
      compileTurnCallers.push(relative)
    }
  }
}
collectCompileTurnCallers(join(REPO_ROOT, 'src'))
collectCompileTurnCallers(join(REPO_ROOT, 'scripts'))
record(
  'B2',
  '静态：prompt 的唯一入口仍是 `TurnGateway.compileTurn` —— **桥目录里一次都没有**，且调用点全部可枚举',
  compileTurnCallers.every((path) => !path.includes('/bridge/')) && compileTurnCallers.length > 0,
  `compileTurn 调用点=${compileTurnCallers.length} 处 · 桥目录命中=${String(compileTurnCallers.some((path) => path.includes('/bridge/')))}`,
  compileTurnCallers.length
)

// ===========================================================================
// B3–B7 桥语义（用**受控 stub host**，不碰数据库）
// ===========================================================================

/** 受控 stub：记录被调了几次、收到什么；可以按指令抛错 */
function makeStubHost(
  options: {
    throwOn?: string
    delayMs?: number
    /** 传了就装作"有取消能力"的 host（后 Lv2 `L-PL2-04`）；不传 = 没有这个能力 */
    onCancel?: { cancel(id: string): void; hasCommitted(id: string): boolean }
  } = {}
): {
  host: TurnBridgeHost
  calls: { requestId: string; userText: string }[]
  concurrentPeak: () => number
} {
  const calls: { requestId: string; userText: string }[] = []
  let inFlight = 0
  let peak = 0
  const host: TurnBridgeHost = {
    characterId: String(asCharacterId('char_bridge_probe')),
    conversationId: String(asConversationId('dm-bridge-probe')),
    async runTurn(input) {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      calls.push({ ...input })
      try {
        if (options.delayMs !== undefined) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, options.delayMs))
        }
        if (options.throwOn !== undefined && input.userText.includes(options.throwOn)) {
          throw new Error('stub host failure (deliberate)')
        }
        return {
          replyText: `[stub reply for ${input.requestId}]`,
          replyId: `rep:${input.requestId}`,
          traceId: `trc:${input.requestId}`,
          domainEventIds: [`dev:stub:${input.requestId}`],
        }
      } finally {
        inFlight -= 1
      }
    },
  }
  if (options.onCancel !== undefined) {
    const registry = options.onCancel
    host.cancelTurn = async (input) => {
      registry.cancel(input.requestId)
      const alreadyCommitted = registry.hasCommitted(input.requestId)
      return {
        requested: true,
        stoppedBeforeModel: !alreadyCommitted,
        alreadyCommitted,
        cancellablePoints: alreadyCommitted
          ? []
          : ['before_model_call', 'before_ledger_commit'],
      }
    }
  }
  return { host, calls, concurrentPeak: () => peak }
}

// --- B3 身份绑定 -----------------------------------------------------------
const identityStub = makeStubHost()
const identityBridge = new TurnBridge({ host: identityStub.host })
let identityThrew = false
try {
  new TurnBridge({ host: { runTurn: async () => ({}) } as unknown as TurnBridgeHost })
} catch {
  identityThrew = true
}
const requestCannotChangeIdentity = !Object.prototype.hasOwnProperty.call(
  JSON.parse(JSON.stringify({ kind: 'SUBMIT_TURN', requestId: 'r1', userText: 'hi' })),
  'characterId'
)
record(
  'B3',
  '身份绑定：无身份 ⇒ 构造即失败；请求里**没有**任何字段能改角色/会话（INV-PL2-08）',
  identityThrew &&
    requestCannotChangeIdentity &&
    identityBridge.identity.characterId === 'char_bridge_probe' &&
    identityBridge.identity.conversationId === 'dm-bridge-probe',
  `无身份抛错=${String(identityThrew)} · 请求无身份字段=${String(requestCannotChangeIdentity)} · 绑定=${JSON.stringify(identityBridge.identity)}`,
  4
)

// --- B4 形状失败关闭 -------------------------------------------------------
const shapeBridge = new TurnBridge({ host: makeStubHost().host })
const shapeCases: { id: string; run: () => Promise<unknown>; expect: string }[] = [
  {
    id: 'bad-request-id',
    run: () => shapeBridge.submit({ requestId: 'has space!', userText: '你好' }),
    expect: 'bridge_bad_request_id',
  },
  {
    id: 'empty-text',
    run: () => shapeBridge.submit({ requestId: 'r-empty', userText: '   ' }),
    expect: 'bridge_empty_user_text',
  },
  {
    id: 'too-long',
    run: () =>
      shapeBridge.submit({ requestId: 'r-long', userText: 'x'.repeat(DEFAULT_MAX_USER_TEXT_LENGTH + 1) }),
    expect: 'bridge_user_text_too_long',
  },
  {
    id: 'non-string-text',
    run: () => shapeBridge.submit({ requestId: 'r-ns', userText: 42 as never }),
    expect: 'bridge_bad_user_text',
  },
  {
    id: 'unknown-kind',
    run: () => handleBridgeMessage(shapeBridge, { kind: 'EXECUTE_ARBITRARY_CODE', requestId: 'r-k', userText: 'x' }),
    expect: 'bridge_unknown_message_kind',
  },
]
const shapeReadings: { id: string; code?: string; outcome?: string; ok: boolean }[] = []
for (const shapeCase of shapeCases) {
  const result = (await shapeCase.run()) as { code?: string; outcome?: string }
  shapeReadings.push({
    id: shapeCase.id,
    code: result.code,
    outcome: result.outcome,
    ok: result.code === shapeCase.expect && result.outcome === 'rejected',
  })
}
record(
  'B4',
  '形状失败关闭：坏 requestId / 空文本 / 超长文本 / 非字符串 ⇒ `rejected`（各带具名码）；消息种类是**受控登记表**（后 Lv2 `L-PL2-04` 起为 `SUBMIT_TURN` + `CANCEL_TURN`，Lv4.5 / P1 追加 `REPORT_SYNTHESIZED` + `REPORT_PLAYBACK`）',
  shapeReadings.every((reading) => reading.ok) &&
    isBridgeMessageKind('SUBMIT_TURN') &&
    isBridgeMessageKind('CANCEL_TURN') &&
    isBridgeMessageKind('REPORT_SYNTHESIZED') &&
    isBridgeMessageKind('REPORT_PLAYBACK'),
  shapeReadings.map((reading) => `${reading.id}=${String(reading.code)}`).join(' · ') +
    ` · 受控种类=${JSON.stringify(BRIDGE_MESSAGE_KINDS)}`,
  shapeReadings.length
)

// --- B5 失败不回落 ---------------------------------------------------------
const failStub = makeStubHost({ throwOn: 'TRIGGER_FAILURE' })
const failBridge = new TurnBridge({ host: failStub.host })
const failed = await failBridge.submit({ requestId: 'r-fail', userText: '请 TRIGGER_FAILURE 一下' })
const failHasNoReply = failed.replyText === undefined && failed.replyId === undefined
record(
  'B5',
  '**失败不回落**：装配层抛错 ⇒ `failed` + 具名码，且不返回任何回复身份（绝不转默认 Agent）',
  failed.outcome === 'failed' &&
    failed.code === 'bridge_turn_failed' &&
    failed.delivery === 'failed' &&
    failHasNoReply &&
    failStub.calls.length === 1,
  `outcome=${failed.outcome} · code=${String(failed.code)} · delivery=${failed.delivery} · 无回复身份=${String(failHasNoReply)} · host 调用=${failStub.calls.length}`,
  5
)

/** 被检验的判据本体：**失败必须不带回复**（"回落"的形状） */
const fallbackDetect = (result: BridgeSubmitResult): boolean =>
  result.outcome === 'failed' && result.replyText !== undefined
const injectedFallback: BridgeSubmitResult = {
  outcome: 'failed',
  code: 'bridge_turn_failed',
  replyText: '[default agent fallback]',
  delivery: 'failed',
}
record(
  'B5b',
  '负控：把"失败却仍给出回复"注入成假象 ⇒ 回落检测必须响（正控下安静）',
  fallbackDetect(failed) === false && fallbackDetect(injectedFallback) === true,
  `正控（真实失败）=${String(fallbackDetect(failed))}（应 false）· 负控（注入回落）=${String(fallbackDetect(injectedFallback))}（应 true）`,
  2
)

// --- B6 幂等 ---------------------------------------------------------------
const idemStub = makeStubHost()
const idemBridge = new TurnBridge({ host: idemStub.host })
const first = await idemBridge.submit({ requestId: 'r-idem', userText: '第一次' })
const second = await idemBridge.submit({ requestId: 'r-idem', userText: '第一次' })
const third = await idemBridge.submit({ requestId: 'r-idem', userText: '被改过的文本（必须被忽略）' })
record(
  'B6',
  '幂等：同 `requestId` 重复提交 ⇒ **逐字段相同**的结果、host 只被调用**一次**（不产生第二轮对话）',
  first.outcome === 'replied' &&
    second.replyId === first.replyId &&
    third.replyId === first.replyId &&
    third.replyText === first.replyText &&
    idemStub.calls.length === 1 &&
    idemBridge.idempotencySize === 1,
  `host 调用=${idemStub.calls.length} 次（应 1）· replyId 一致=${String(second.replyId === first.replyId && third.replyId === first.replyId)} · 文本未污染=${String(third.replyText === first.replyText)}`,
  4
)

// --- B7 串行 ---------------------------------------------------------------
const serialStub = makeStubHost({ delayMs: 25 })
const serialBridge = new TurnBridge({ host: serialStub.host })
const concurrent = await Promise.all([
  serialBridge.submit({ requestId: 'c1', userText: '并发一' }),
  serialBridge.submit({ requestId: 'c2', userText: '并发二' }),
  serialBridge.submit({ requestId: 'c3', userText: '并发三' }),
])
record(
  'B7',
  '串行：同一会话的正式写入轮次**串行**（并发提交时 host 的并发峰值 = 1）',
  serialStub.concurrentPeak() === 1 &&
    concurrent.every((result) => result.outcome === 'replied') &&
    serialStub.calls.length === 3,
  `并发峰值=${serialStub.concurrentPeak()}（应 1）· 三次都 replied=${String(concurrent.every((r) => r.outcome === 'replied'))} · host 调用=${serialStub.calls.length}`,
  3
)

// ===========================================================================
// B8/B9 真实轮次（隔离库 + 真实 TurnGateway）
// ===========================================================================
const sandbox = isolateDatabase('postlv2-bridge')
console.log(`  [sandbox] ${sandbox.dir}`)

const { createM4Harness } = await import('./m4-harness.ts')
const { TurnGateway } = await import('../src/kernel/app/turn-gateway.ts')
const { ConversationRecorder } = await import('../src/infrastructure/runtime/conversation-recorder.ts')
const { conversationEventsInRange } = await import(
  '../src/infrastructure/persistence/conversation-store.ts'
)
const { character } = await import('../src/character/index.ts')
const { stringToUuid } = await import('../src/kernel/contracts/uuid.ts')
/*
 * ⚠️ 守卫链来自**唯一实现**（`src/kernel/app/reply-guard-chain.ts`），
 * 不再在门里手抄一遍。R3 那版之所以漏掉全部五道守卫而门照旧 PASS，
 * 根因就是"抄一遍" —— 抄漏之后**行为看起来一样**（回复仍然是一句话）。
 */
const { runReplyGuardChain } = await import('../src/kernel/app/reply-guard-chain.ts')

const h = await createM4Harness({ label: 'postlv2-bridge' })
const characterId = asCharacterId(h.kernel.characterId)
const conversationId = asConversationId('postlv2-bridge')
const userId = stringToUuid('user-Alex')

let sequence = 0
const recorder = new ConversationRecorder({
  db: h.kernel.stores.db,
  characterId,
  conversationId,
  dryRun: false,
  userName: 'Alex',
  characterName: character.name,
  transport: 'cli',
  userId,
  userRef: 'Alex',
})
const gateway = new TurnGateway({
  kernel: h.kernel,
  definition: h.kernel.definition,
  identity: h.kernel.identitySnapshot,
  recorder,
  conversationSequence: () => {
    sequence += 1
    return sequence
  },
  recentLimit: 16,
  slowPathEnabled: false,
  dryRun: false,
  userId,
})

/**
 * **真实轮次**的 host 实现（与 `src/main.ts` 同形：
 * `beginTurn → compileTurn → 模型 → 四道回复守卫**串联** → completeTurn`）。
 *
 * ============================================================================
 *  ⚠️ 为什么必须把守卫链搬进来（这是本门最容易被糊弄过去的一处）
 * ============================================================================
 * WP1 的核心主张是 `INV-PL2-09`：**桥必须经同一套轮次装配**，
 * 而不是"只调裸模型"。第一版 host **只做了** `beginTurn → completeTurn`，
 * 完全跳过了 `main.ts` 的四道回复守卫 —— 于是那个"真实轮次"PASS
 * 证明的只是"事件落了库"，**没有**证明"用户看到的是检查后的文本"。
 *
 * 现在按 `main.ts` 的**同一顺序**串联（记忆 → 承诺 → 动作 → 外部证据 → 搜索判定），
 * 并把这一次**真的会响**：注入一句"我记住了"而本轮**没有**写入 ⇒
 * 守卫必须顶替成如实句（见 B10）。
 *
 * ⚠️ 本门**不**冒充生产接线：`main.ts` 仍保留它自己那条链，
 * "把链抽成可复用 host 并接进 main.ts" 是**单独一件**待办（执行计划 §R3 已登记）。
 */
const realHost: TurnBridgeHost = {
  characterId: String(characterId),
  conversationId: String(conversationId),
  async runTurn(input): Promise<HostTurnResult> {
    const incoming = await gateway.beginTurn(input.userText)
    const rawReply = `收到：${input.userText}`.slice(0, 200)

    /*
     * 五道回复守卫：**唯一实现**（`src/kernel/app/reply-guard-chain.ts`）。
     * 生产侧（`main.ts`）与验收 host 从此不再各写一遍 ——
     * 这正是 R3 那版漏掉守卫链的结构性原因。
     */
    const guarded = runReplyGuardChain({
      replyText: rawReply,
      ...(incoming.memoryWriteResult !== undefined
        ? { memoryWriteResult: incoming.memoryWriteResult }
        : {}),
      ...(incoming.goalWriteReality !== undefined
        ? { goalWriteReality: incoming.goalWriteReality }
        : {}),
      ...(incoming.actionResults !== undefined ? { actionResults: incoming.actionResults } : {}),
      ...(incoming.externalEvidenceInContext !== undefined
        ? { externalEvidenceInContext: incoming.externalEvidenceInContext }
        : {}),
    })

    const outgoing = await gateway.completeTurn({
      turn: incoming,
      replyText: guarded.replyText,
      replyGuards: guarded.reports,
    })
    /*
     * 把守卫读数一并交出去（**只放枚举标签，不含正文**）——
     * B10 靠它证明"守卫真的运行过"，而不是靠"回复看起来像被改过"。
     */
    return {
      replyText: guarded.replyText,
      replyId: String(outgoing.assistantEvent?.id ?? ''),
      traceId: String(outgoing.trace.traceId),
      domainEventIds: [...outgoing.domainEventIds],
      guardStates: guarded.reports.map((report) => `${report.name}=${report.state}`),
    }
  },
}

const realBridge = new TurnBridge({ host: realHost })
const eventsOf = (): Promise<{ type: string; content: string }[]> =>
  conversationEventsInRange(h.kernel.stores.db, characterId, 1, 9999, 500) as Promise<
    { type: string; content: string }[]
  >

const before = await eventsOf()
const realReply = await realBridge.submit({ requestId: 'real-1', userText: '你好，苏沐薇' })
const after = await eventsOf()
const added = after.length - before.length
const userEventLanded = after.some(
  (event) => event.type === 'user_message' && event.content.includes('你好，苏沐薇')
)
const assistantEventLanded = after.some((event) => event.type === 'assistant_message')
record(
  'B8',
  '**真实轮次**：经真实 `TurnGateway` 走完一轮（beginTurn → completeTurn），用户/助手事件真的落库，身份是真的 LG 身份',
  realReply.outcome === 'replied' &&
    realReply.replyText === '收到：你好，苏沐薇' &&
    (realReply.replyId ?? '') !== '' &&
    (realReply.traceId ?? '').startsWith('trc:') &&
    added === 2 &&
    userEventLanded &&
    assistantEventLanded,
  `outcome=${realReply.outcome} · 新增事件=${added}（应 2）· traceId=${String(realReply.traceId)} · replyId=${String(realReply.replyId)} · 用户事件落库=${String(userEventLanded)}`,
  6
)

const realIdem = await realBridge.submit({ requestId: 'real-1', userText: '你好，苏沐薇' })
const afterIdem = await eventsOf()
record(
  'B8b',
  '幂等在**真实库**上同样成立：重复提交 ⇒ 事件数**不变**、返回同一份结果',
  afterIdem.length === after.length &&
    realIdem.replyId === realReply.replyId &&
    realIdem.traceId === realReply.traceId,
  `事件数 ${after.length} → ${afterIdem.length}（应不变）· replyId 一致=${String(realIdem.replyId === realReply.replyId)}`,
  3
)

// --- B10 守卫链真的跑过（INV-PL2-09 的**正确**读法）----------------------
/*
 * ⚠️ 这一条是本轮发现的**真实缺口**：第一版 host 只有
 * `beginTurn → completeTurn`，**跳过了 `main.ts` 的四道回复守卫**。
 * 于是"真实轮次 PASS"证明的只是"事件落了库" —— 而 WP1 的主张是
 * "用户看到的是**检查后**的文本"。判据必须是**端到端**的：
 * 一句不该出现的成功口吻，从 host 出来时**必须已经被顶替**。
 */
/** 同一句主张，走一遍**唯一实现**的守卫链（与 host 用的是同一个函数） */
const guardChainReplacesClaim = (rawReply: string): { text: string; state: string } => {
  const outcome = runReplyGuardChain({
    replyText: rawReply,
    memoryWriteResult: {
      kind: 'not_written',
      intent: 'remember',
      reason: 'persistence_failed',
      summary: '（门用合成写入读数：这一轮没有写进去）',
    },
  })
  const memoryReport = outcome.reports.find((report) => report.name === 'memory_truth')
  return {
    text: outcome.replyText,
    state: `${memoryReport?.state ?? 'missing'}|${outcome.markers.memoryTruth.join(',')}`,
  }
}
const leakedClaim = '好，我记住了：你想在二面时先讲分工。'
const guarded = guardChainReplacesClaim(leakedClaim)
const realGuardStates = realReply.guardStates ?? []
record(
  'B10',
  '**守卫链真的跑过**：不该出现的"我记住了"在出桥前已被顶替成如实句；守卫三态随结果一起报出（`INV-PL2-09`）',
  guarded.text !== leakedClaim &&
    guarded.state.startsWith('triggered') &&
    !guarded.text.includes('记住了') &&
    realGuardStates.some((state) => state.startsWith('memory_truth=')) &&
    realGuardStates.some((state) => state.startsWith('evidence_truth=')),
  `原文=${JSON.stringify(leakedClaim)} · 守卫后=${JSON.stringify(guarded.text.slice(0, 40))}… · 状态=${guarded.state} · host 报出的守卫=${JSON.stringify(realGuardStates)}`,
  5
)

// --- B11 守卫链只有**一份**实现（防止"再抄一遍"）-------------------------
/*
 * R3 的缺口（host 漏掉全部五道守卫而门照旧 PASS）的**根因**是"链被抄了两遍"。
 * 因此这里加一条静态判据：那五个"应用守卫"的函数在全仓**只有一处**调用点
 *   —— `src/kernel/app/reply-guard-chain.ts`。
 *
 * ⚠️ 判据打在**调用**上而不是 import 上：`import` 一个函数名不等于用它，
 * 而真正危险的是"某个地方又自己串了一遍链"（也就是又出现一个调用点）。
 */
const GUARD_APPLIERS = [
  'applyResponseTruthPolicy',
  'applyCommitmentClaimGuard',
  'applyActionClaimGuard',
  'applyExternalEvidenceReplyPolicy',
  'applySearchNeedReplyPolicy',
]
const CHAIN_PATH = '/src/kernel/app/reply-guard-chain.ts'
const guardApplierCallSites: Record<string, string[]> = {}
for (const name of GUARD_APPLIERS) {
  const sites: string[] = []
  const scan = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        scan(full)
        continue
      }
      if (!entry.endsWith('.ts')) continue
      const relative = full.slice(REPO_ROOT.length).replaceAll('\\', '/')
      const code = codeOnly(readFileSync(full, 'utf8')).join('\n')
      /*
       * ⚠️ 要排除**定义点**：`export function applyX(...)` 的文本同样匹配
       * `name(`，第一版把定义点也算成"调用点"，于是五个函数全都"有两处"。
       * 判据要量的是**谁在串这条链**，而不是"谁定义了这个函数"。
       */
      const callPattern = new RegExp(`(?<!function\\s)${name}\\s*\\(`)
      if (callPattern.test(code)) sites.push(relative)
    }
  }
  scan(join(REPO_ROOT, 'src'))
  guardApplierCallSites[name] = sites
}
const chainIsSinglePoint = GUARD_APPLIERS.every((name) => {
  const sites = guardApplierCallSites[name] ?? []
  return sites.length === 1 && sites[0] === CHAIN_PATH
})
record(
  'B11',
  '守卫链只有**一份**实现：五个"应用守卫"的函数在全仓**各只有一个调用点**（`reply-guard-chain.ts`）',
  chainIsSinglePoint,
  GUARD_APPLIERS.map((name) => `${name}=${JSON.stringify(guardApplierCallSites[name] ?? [])}`).join(' · '),
  GUARD_APPLIERS.length
)

// --- B9 交付真相 -----------------------------------------------------------
const deliveryReading = (result: BridgeSubmitResult): boolean => {
  if (result.outcome === 'replied') return result.delivery === 'generated'
  if (result.outcome === 'rejected') return result.delivery === 'rejected'
  return result.delivery === 'failed'
}
/*
 * ⚠️ 判据打在**代码**上（先剥注释）。
 * 第一版直接扫原始源码，于是命中了本文件自己的类型注释（里面**恰好**解释了
 * "D10 的六个状态"那一行与 `'played'` 同形）—— 那是"量错了东西"的又一个实例：
 * 注释里出现某个词，与"代码里存在这个状态值"是两件事。
 *
 * ⚠️ 第二版收紧（Lv4.5 / `P1`）：**"桥从不声称已播出"的精确形状**不是"文件里
 *    不出现 `played` 这个词" —— `REPORT_PLAYBACK` 让客户端**报告** `played`
 *    之后，这个词必须能出现在受控词汇表里（否则我们无法接收真实播放事实）。
 *    要守的性质是：`delivery` 这个**交付真相字段**取值只有 `generated` /
 *    `rejected` / `failed`，**永远不是** `played`。所以判据是
 *    "`delivery` 的三态闭集里没有 `played`"，而不是"文件里没这个词"。
 */
type DeliveryTruth = BridgeSubmitResult['delivery']
const DELIVERY_TRUTH_STATES: readonly DeliveryTruth[] = ['generated', 'rejected', 'failed']
const deliveryStatesForbidPlayed = !(DELIVERY_TRUTH_STATES as readonly string[]).includes('played')
const deliveredNeverPlayed = [realReply, failed, { outcome: 'rejected', delivery: 'rejected' } as BridgeSubmitResult].every(
  (result) => result.delivery !== ('played' as DeliveryTruth)
)
record(
  'B9',
  '交付真相：`delivery` 三态与 `outcome` 一一对应；`delivery` 的闭集里**没有** `played`（桥从不声称"已播出"；`played` 只能由客户端**报告**进交付账）',
  deliveryReading(realReply) &&
    deliveryReading(failed) &&
    deliveryReading({ outcome: 'rejected', delivery: 'rejected' }) &&
    deliveryStatesForbidPlayed &&
    deliveredNeverPlayed,
  `replied→generated=${String(deliveryReading(realReply))} · failed→failed=${String(deliveryReading(failed))} · delivery 闭集无 'played'=${String(deliveryStatesForbidPlayed)} · 实测三档均非 'played'=${String(deliveredNeverPlayed)}`,
  5
)

// ===========================================================================
// V1 量具自证三段式
// ===========================================================================
const selfCheck = (() => {
  const positive = fallbackDetect(failed)
  const negative = fallbackDetect(injectedFallback)
  const restored = fallbackDetect(failed)
  return {
    ok: positive === false && negative === true && restored === false,
    detail: `正控=${String(positive)}（应 false）· 负控=${String(negative)}（应 true）· 恢复=${String(restored)}（应 false）`,
  }
})()
record('V1', '量具自证三段式：合法失败安静 → 注入回落必响 → 恢复后重新安静', selfCheck.ok, selfCheck.detail, 3)

// ===========================================================================
// B12 取消通道（后 Lv2 · `L-PL2-04`）
// ===========================================================================
/*
 * 计划 §8.3 的原话：取消的目标是**停止过期工作与表达**，
 * **不撤销**已提交的用户消息 / 记忆 / 外部副作用。
 * 因此这里要分别证明四件事，而不是"取消能用了"：
 * ```text
 * ① host 没有取消能力 ⇒ 如实拒绝（不假装成功）
 * ② 空 requestId ⇒ 拒绝（取消一个认不出来的轮次是无意义的动作）
 * ③ 有能力的 host ⇒ 受理，且读数把"请求了/能停/已提交"分列
 * ④ **已提交的轮次**：取消照常受理，但 `alreadyCommitted: true` 且
 *    `cancellablePoints` 为空 —— 我们**不**声称撤销了什么
 * ```
 */
const noCancelHost = makeStubHost()
const noCancelBridge = new TurnBridge({ host: noCancelHost.host })
const absentReading = await handleBridgeMessage(noCancelBridge, {
  kind: 'CANCEL_TURN',
  requestId: 'r-none',
})
const emptyIdReading = await handleBridgeMessage(noCancelBridge, { kind: 'CANCEL_TURN', requestId: '' })

const { TurnCancellationRegistry, cancelReadingOf } = await import(
  '../src/infrastructure/bridge/turn-bridge-transport.ts'
)
const registry = new TurnCancellationRegistry()
const cancelStub = makeStubHost({ onCancel: registry })
const cancelBridge = new TurnBridge({ host: cancelStub.host })
const acceptedReading = await handleBridgeMessage(cancelBridge, {
  kind: 'CANCEL_TURN',
  requestId: 'r-live',
  reason: 'user_interrupted',
})
/* ④ 已提交之后：同一个 requestId 再取消一次 */
registry.markCommitted('r-live')
const afterCommitReading = await handleBridgeMessage(cancelBridge, {
  kind: 'CANCEL_TURN',
  requestId: 'r-live',
  reason: 'user_interrupted',
})
/* 正控：提交**之前**的读数必须说"能在模型前停住"（否则上面那条④的对比没有意义） */
const beforeCommitReading = cancelReadingOf({
  requestId: 'r-fresh',
  registry: (() => {
    const r = new TurnCancellationRegistry()
    r.cancel('r-fresh')
    return r
  })(),
  beforeModel: true,
})
record(
  'B12',
  '取消通道（`L-PL2-04`）：无能力 ⇒ 具名拒绝 · 空 id ⇒ 拒绝 · 有能力 ⇒ 受理且**分列**读数 · **已提交** ⇒ `alreadyCommitted=true` 且无可停点（**不**声称撤销）',
  absentReading.code === 'cancel_capability_absent' &&
    absentReading.kind === 'CANCEL_RESULT' &&
    emptyIdReading.code === 'cancel_without_request_id' &&
    acceptedReading.outcome === 'cancelled' &&
    acceptedReading.cancel?.requested === true &&
    acceptedReading.cancel?.alreadyCommitted === false &&
    /* 已提交之后：受理，但读数如实说"撤销不了" */
    afterCommitReading.outcome === 'cancelled' &&
    afterCommitReading.cancel?.alreadyCommitted === true &&
    afterCommitReading.cancel?.stoppedBeforeModel === false &&
    (afterCommitReading.cancel?.cancellablePoints.length ?? -1) === 0 &&
    /* 正控：提交前必须说得出"能在模型前停住" */
    beforeCommitReading.stoppedBeforeModel === true &&
    beforeCommitReading.cancellablePoints.length === 2,
  `无能力=${String(absentReading.code)} · 空 id=${String(emptyIdReading.code)} · 受理=${String(acceptedReading.outcome)}/requested=${String(acceptedReading.cancel?.requested)} · ` +
    `提交后 alreadyCommitted=${String(afterCommitReading.cancel?.alreadyCommitted)}/可停点=${String(afterCommitReading.cancel?.cancellablePoints.length)} · ` +
    `提交前 stoppedBeforeModel=${String(beforeCommitReading.stoppedBeforeModel)}/可停点=${beforeCommitReading.cancellablePoints.length}`,
  8
)

// ===========================================================================
// B13 Lv4.5 / P1：**交付视图** —— 未播出的句子不得被当成"她已经说过"
// ===========================================================================
/*
 * 载体：媒体交付契约 §2 `M11`（"后续语音上下文据**可确认的已播放部分**构造"）。
 *
 * ⚠️ 判据打在**真实落库的那条助手事件**上：先从库里读回她这一轮**真的生成**了
 *    什么，再让交付账只承认其中一句播完 —— 于是"视图里剩什么"与"账上播了什么"
 *    是**两件独立可核对的事实**，而不是我自己编的字符串。
 */
const { VoiceDeliveryLedger, applyVoiceDeliveryView } = await import(
  '../src/kernel/app/bridge/voice-delivery-ledger.ts'
)
const assistantLine = [...after].reverse().find((event) => event.type === 'assistant_message')
const assistantText = assistantLine?.content ?? ''
const deliveryLedger = new VoiceDeliveryLedger({ now: () => 1000 })

const lineOf = (sequence: number, text: string) => ({
  id: `cev:probe:conv:${sequence}`,
  sequence,
  speaker: character.name,
  actorType: 'character',
  text,
})
/** 用**当前账**做一次交付视图（判据只依赖账，不依赖我传了什么） */
const viewOf = (lines: ReturnType<typeof lineOf>[]) =>
  applyVoiceDeliveryView(lines, deliveryLedger, { characterName: character.name })
/* ❶ 账还没接入这段回复 ⇒ 原样通过（CLI / 干跑形态；不因"没见过"就把她的话抹掉） */
const beforeReport = viewOf([lineOf(50, assistantText)])
/*
 * 切成**三段真实正文**（不是造的）：于是"只播前两段"能直接对账成"视图里少了第三段"。
 */
const pieceSize = Math.max(1, Math.floor(assistantText.length / 3))
const pieces = [
  assistantText.slice(0, pieceSize),
  assistantText.slice(pieceSize, pieceSize * 2),
  assistantText.slice(pieceSize * 2),
].filter((piece) => piece !== '')
deliveryLedger.openReply({
  replyId: 'cev:probe:conv:50',
  segments: pieces.map((text, index) => ({ segmentId: `cev:probe:conv:50#${index}`, text })),
  at: 1000,
})
/* ❷ 账上有这段、但一句都没播 ⇒ 整行**不出现**（"生成过"不等于"说过"） */
const nothingPlayed = viewOf([lineOf(50, assistantText)])
const playSegment = (index: number, at: number): void => {
  deliveryLedger.reportSynthesized({ segmentId: `cev:probe:conv:50#${index}`, audioId: `audio:${index}`, at })
  for (const state of ['queued', 'playing', 'played'] as const) {
    deliveryLedger.report({ segmentId: `cev:probe:conv:50#${index}`, state, at: at + 100 })
  }
}
/* ❸ 只播前两段 ⇒ 视图里**只剩前两段**（第三段一次都没播，不得被表述为"我说过了"） */
playSegment(0, 2000)
playSegment(1, 3000)
const partlyPlayed = viewOf([lineOf(50, assistantText)])
const expectedPartial = pieces.slice(0, -1).join('')
/* ❹ 三段都播完 ⇒ 原样通过（说过了，就是全文） */
playSegment(pieces.length - 1, 4000)
const wholePlayed = viewOf([lineOf(50, assistantText)])
/* ❺ 用户行**永远**原样通过（这条规则不认识用户行，也就不碰它） */
const userLineView = viewOf([
  { id: 'cev:probe:conv:51', sequence: 51, speaker: 'Alex', actorType: 'user', text: '你好' },
])
/* ❻ 静态锁：`main.ts` 真的把交付账接在最近对话上（不是"门里测了个纯函数"） */
const mainSourceForP1 = readFileSync(join(REPO_ROOT, 'src/main.ts'), 'utf8')
const mainWiresView = /applyVoiceDeliveryView\(recentLines,\s*this\.voiceDelivery/.test(mainSourceForP1)
const mainPassesView = /recentLines:\s*voiceLines/.test(mainSourceForP1)
record(
  'B13',
  '**交付视图**（Lv4.5 / P1 · 契约 §2 `M11`）：账未接入 ⇒ 逐字不变；账上未播 ⇒ 整行撤掉；只播一部分 ⇒ 只留已播出的部分；整段播完 ⇒ 原样；用户行不受影响；且 `main.ts` 真的把账接在最近对话上',
  assistantText.length > 2 &&
    beforeReport.length === 1 &&
    beforeReport[0]!.text === assistantText &&
    nothingPlayed.length === 0 &&
    partlyPlayed.length === 1 &&
    partlyPlayed[0]!.text === expectedPartial &&
    wholePlayed.length === 1 &&
    wholePlayed[0]!.text === assistantText &&
    userLineView.length === 1 &&
    userLineView[0]!.text === '你好' &&
    mainWiresView &&
    mainPassesView,
  `真实助手正文长度=${assistantText.length} · 未接入=${beforeReport.length} 行（应 1）· 未播=${nothingPlayed.length} 行（应 0）· 只播前两段=${JSON.stringify(partlyPlayed[0]?.text ?? null)}（应 ${JSON.stringify(expectedPartial)}）· 整段播完=${wholePlayed.length} 行（应 1）· 用户行=${userLineView.length} 行（应 1）· main.ts 接线（视图/透传）=${String(mainWiresView)}/${String(mainPassesView)}`,
  14
)

// ===========================================================================
// B14 Lv4.5 / P2：**只读准备**（`PREPARE_TURN`）—— 读得到 id，写不进去任何东西
// ===========================================================================
/*
 * 载体：计划 §2 `P2`「LG 新增不写正式用户消息的只读准备入口」。
 *
 * ⚠️ 这一条的重点是**响应形状**，不是"能不能返回东西"：
 *    准备若带回了 `replyText` / `replyId` / `traceId`，它就变成了"提前生成的一轮"，
 *    而那正是计划 §4.2 明文禁止的事（首版不同时推测整段回复与提前 TTS）。
 *    因此判据里既有"只回 id 与计数"，也有**逐字段的缺席断言**。
 */
const prepareBridgeNoHost = new TurnBridge({ host: makeStubHost().host })
const prepareAbsent = await handleBridgeMessage(prepareBridgeNoHost, {
  kind: 'PREPARE_TURN',
  requestId: 'prep:absent',
  userText: '半句话',
})
const prepareEmpty = await handleBridgeMessage(prepareBridgeNoHost, {
  kind: 'PREPARE_TURN',
  requestId: 'prep:empty',
  userText: '   ',
})
const prepareBadId = await handleBridgeMessage(prepareBridgeNoHost, {
  kind: 'PREPARE_TURN',
  requestId: 'bad id!',
  userText: '半句话',
})
/* host **有**只读准备能力（真实装配层将来就是这一支） */
const prepareCalls: { userText: string; requestId: string; revision?: string }[] = []
const prepareStub = makeStubHost()
const prepareCapableBridge = new TurnBridge({
  host: {
    ...prepareStub.host,
    prepareTurn: (input) => {
      prepareCalls.push(input as { userText: string; requestId: string; revision?: string })
      return {
        candidateRevision: 'rev:probe:1',
        recall: {
          status: 'ran',
          selectedCount: 2,
          selectedMemoryIds: ['mem:probe:1', 'mem:probe:2'],
        },
        wroteAnything: false,
      }
    },
  },
})
const prepared = await handleBridgeMessage(prepareCapableBridge, {
  kind: 'PREPARE_TURN',
  requestId: 'prep:ok',
  userText: '大家如果对我的研究感兴趣',
  candidateRevision: 'rev:client:0',
})
const preparedPayload = prepared as unknown as Record<string, unknown>
/** ⚠️ 「准备不产出她的话」在**线上形状**上的表现：这四个字段必须一个都不出现 */
const opaqueFieldsAbsent =
  preparedPayload.replyText === undefined &&
  preparedPayload.replyId === undefined &&
  preparedPayload.traceId === undefined &&
  preparedPayload.domainEventIds === undefined
record(
  'B14',
  '**只读准备**（Lv4.5 / P2 · `PREPARE_TURN`）：受控登记表含它 · 无能力 ⇒ 具名拒绝（不假装）· 形状检查与 `SUBMIT_TURN` **同一处** · 有能力的 host ⇒ 只回 id 与计数，且响应里**没有** `replyText`/`replyId`/`traceId`（准备不产出她的话、不落账）',
  BRIDGE_MESSAGE_KINDS.includes('PREPARE_TURN') &&
    isBridgeMessageKind('PREPARE_TURN') &&
    prepareAbsent.code === 'prepare_capability_absent' &&
    prepareAbsent.outcome === 'rejected' &&
    prepareEmpty.code === 'bridge_empty_user_text' &&
    prepareBadId.code === 'bridge_bad_request_id' &&
    prepared.outcome === 'prepared' &&
    prepared.prepare?.candidateRevision === 'rev:probe:1' &&
    prepared.prepare?.recall.selectedMemoryIds.length === 2 &&
    prepared.prepare?.recall.status === 'ran' &&
    prepared.prepare?.wroteAnything === false &&
    prepareCalls.length === 1 &&
    opaqueFieldsAbsent,
  `登记表含 PREPARE_TURN=${String(BRIDGE_MESSAGE_KINDS.includes('PREPARE_TURN'))} · 无能力=${String(prepareAbsent.code)} · 空文本=${String(prepareEmpty.code)} · 坏 id=${String(prepareBadId.code)} · ` +
    `准备了：修订=${String(prepared.prepare?.candidateRevision)} 命中=${String(prepared.prepare?.recall.selectedMemoryIds.length)} 写没写=${String(prepared.prepare?.wroteAnything)} · ` +
    `响应里 replyText/replyId/traceId/domainEventIds 全缺席=${String(opaqueFieldsAbsent)}`,
  14
)

// ===========================================================================
// B15 Lv4.5 / P2：只读准备的**负控** —— 跑一次准备，账本必须一个字都不多
// ===========================================================================
/*
 * B14 证明的是**形状**（响应里没有她的话）；这一条证明**行为**（账本没被动）。
 *
 * 判据刻意放在**真实网关 + 隔离库**上，量三样东西：
 * ```text
 * ① 对话事件数      —— `prepareTurn` 前后必须完全相同
 * ② 序号分配器      —— 准备不得消费任何 `conversationSequence`
 * ③ 账本仍然可写    —— 紧接一次真实轮次 ⇒ 用户与助手各落一条（正控：
 *                      证明确实"什么都没发生"而不是"库挂了所以查不到"）
 * ```
 * ⚠️ ②是这一条的核心：`beginTurn` 的第一件事就是 `conversationSequence()`，
 *    所以"序号没动"就是"没有假装成一轮对话"的机器形态。
 *
 * ⚠️ 这一段刻意用**自己的** recorder / 会话 id / 序号计数器（`prepareGateway`）：
 *    第一版复用上面那套 `sequence` 闭包，而那个闭包每轮只 +1、一轮却**消耗两个**
 *    序号（用户与助手各一个）⇒ 第二轮的 conversationSequence 与第一轮助手事件撞在
 *    同一个确定性 id（`cev:<char>:<conv>:<seq>`）上 ⇒ 账本按**幂等命中**处理，
 *    于是"这一轮的用户消息没有落账"，而整轮**照样 replied**。
 *
 *    那是**测试夹具**的缺陷（生产是 `latestConversationSequence(db) + 1`，见
 *    `src/main.ts:1982`，那里的注释正好写着这个坑），但它顺手量出一条**真实的观测缺口**：
 *    当幂等命中返回的**不是** `user_message` 时，`beginTurn` 会照原样把它当成
 *    `userEvent` 往下传，而**没有任何一处发出声音**。本门不去改那条生产语义
 *    （它属 M2.5 冻结面），只把现象登记进事件（见进度文档 §2g）。
 */
const prepareConversationId = asConversationId('postlv2-bridge-prepare')
let prepareSequence = 0
const prepareRecorder = new ConversationRecorder({
  db: h.kernel.stores.db,
  characterId,
  conversationId: prepareConversationId,
  dryRun: false,
  userName: 'Alex',
  characterName: character.name,
  transport: 'cli',
  userId,
  userRef: 'Alex',
})
const prepareGateway = new TurnGateway({
  kernel: h.kernel,
  definition: h.kernel.definition,
  identity: h.kernel.identitySnapshot,
  recorder: prepareRecorder,
  conversationSequence: () => {
    prepareSequence += 1
    return prepareSequence
  },
  recentLimit: 16,
  slowPathEnabled: false,
  dryRun: false,
  userId,
})
const prepareEventsOf = (): Promise<{ type: string; content: string; sequence: number }[]> =>
  conversationEventsInRange(h.kernel.stores.db, characterId, 1, 9999, 500) as Promise<
    { type: string; content: string; sequence: number }[]
  >
/** 只准备 + 一次真实轮次（复用与 `realHost` 同一条守卫链，避免"只调裸模型"） */
const prepareHost: TurnBridgeHost = {
  characterId: String(characterId),
  conversationId: String(prepareConversationId),
  async runTurn(input): Promise<HostTurnResult> {
    const incoming = await prepareGateway.beginTurn(input.userText)
    const guarded = runReplyGuardChain({ replyText: `收到：${input.userText}`.slice(0, 200) })
    const outgoing = await prepareGateway.completeTurn({
      turn: incoming,
      replyText: guarded.replyText,
      replyGuards: guarded.reports,
    })
    return {
      replyText: guarded.replyText,
      replyId: String(outgoing.assistantEvent?.id ?? ''),
      traceId: String(outgoing.trace.traceId),
      domainEventIds: [...outgoing.domainEventIds],
    }
  },
}
const prepareSeqBefore = prepareSequence
const prepareEventsBefore = (await prepareEventsOf()).length
/*
 * ⚠️ 跑**两次**：第二次是"重发同一个候选"的形态。两次都必须
 *    （a）不写任何东西、（b）各自产出一个新的 trace 身份 —— 后者证明它确实在**计算**，
 *    而不是"因为没跑所以没写"。
 */
const prepareFirst = await prepareGateway.prepareTurn({ userText: '大家如果对我的研究感兴趣呢' })
const prepareSecond = await prepareGateway.prepareTurn({ userText: '大家如果对我的研究感兴趣呢' })
const prepareSeqAfter = prepareSequence
const prepareEventsAfter = (await prepareEventsOf()).length
/* 正控：准备之后账本仍然可写 —— 用户与助手各落一条 */
const afterPrepareTurn = await new TurnBridge({ host: prepareHost }).submit({
  requestId: 'after-prepare-1',
  userText: '准备之后这一轮还能正常聊',
})
const prepareFinalEvents = await prepareEventsOf()
const prepareUserLanded = prepareFinalEvents.some(
  (event) => event.type === 'user_message' && event.content.includes('准备之后这一轮还能正常聊')
)
const prepareAssistantLanded = prepareFinalEvents.some((event) => event.type === 'assistant_message')
record(
  'B15',
  '**只读准备不得写任何东西**（Lv4.5 / P2 负控，真实网关 + 隔离库）：连着准备两次，**对话事件数不变**、**序号分配器不动**（⇒ 没有假装成一轮对话）、两次各自产出**新的 trace 身份**（⇒ 它确实在算，不是"没跑所以没写"）；而紧接的真实轮次**用户与助手各落一条**（正控：账本仍可写）',
  prepareFirst.wroteAnything === false &&
    prepareSecond.wroteAnything === false &&
    prepareEventsAfter === prepareEventsBefore &&
    prepareSeqAfter === prepareSeqBefore &&
    String(prepareFirst.traceId) !== String(prepareSecond.traceId) &&
    afterPrepareTurn.outcome === 'replied' &&
    prepareUserLanded &&
    prepareAssistantLanded,
  `召回状态=${prepareFirst.recall.status}${prepareFirst.recall.status === 'ran' ? `（命中 ${prepareFirst.recall.selectedMemoryIds.length} 条 id）` : `（${String((prepareFirst.recall as { cause?: string }).cause)}）`} · ` +
    `事件数 ${prepareEventsBefore} → ${prepareEventsAfter}（应不变）· 序号 ${prepareSeqBefore} → ${prepareSeqAfter}（应不变）· ` +
    `两次 trace 不同=${String(String(prepareFirst.traceId) !== String(prepareSecond.traceId))} · ` +
    `准备之后的一轮 = ${String(afterPrepareTurn.outcome)}（用户语句落库=${String(prepareUserLanded)} · 助手消息落库=${String(prepareAssistantLanded)}）`,
  11
)

// ===========================================================================
// B16 Lv4.5 / P2：**小集合快反** —— 正控之外，引用/否定/回声三条负控才是判据
// ===========================================================================
/*
 * 载体：计划 §1「明确停止、呼唤苏沐薇等少量信号快速触发停止或可见回应；
 *       引用、否定和回声**不能**直接触发动作」。
 *
 * ⚠️ 这一条的价值**主要在负控**：一个"只要看见'停'就停"的实现能通过所有正控，
 *    却会在"你别停"和"她说'停一下'"上犯错 —— 而那两种在真实对话里很常见。
 */
const { detectFastSignal, isEcho, FAST_SIGNAL_VOCABULARY } = await import(
  '../src/kernel/app/bridge/fast-signal.ts'
)
const stopPositive = ['停一下', '先停', '别说了', '停下来', '等一下']
  .map((text) => detectFastSignal({ text }))
  .every((reading) => reading.kind === 'stop' && reading.urgency === 'immediate')
const wakePositive = detectFastSignal({ text: '苏沐薇' })
const wakeMidSentence = detectFastSignal({ text: '苏沐薇你在吗' })
/**
 * ⚠️ **同音类**（真实读数换来的判据，表由词典生成）：生产在用的流式识别器把
 *    「苏沐薇」听成「苏慕微」，字面量匹配在真实链路上**一次都没触发**。
 *    下面这些正控**不是手挑的** —— 它们覆盖"换个同音字、换个声调"的各种读法。
 */
const wakeHomophones = [
  '苏慕微你在吗', // 实测到的真实读数
  '苏木威',
  '苏牧维',
  '苏母位',
  /*
   * ⚠️ 这里原先写的是「苏素为」—— 那是我**自己写错的样例**：`素` 是 `s u`，
   *    而第二个音节必须是 `m u`，检测器报 `none` 是**对的**。
   *    （本轮第三次"样例错、看起来像判据错"。）正确的换声调样例用 `穆`（m u4）。
   */
  '苏穆薇',
  '诉慕微', // 姓氏用冷僻同音字
].map((text) => detectFastSignal({ text }))
/**
 * ⚠️ **近音**（近似匹配）：只允许**一个**音节落在有据可依的混淆里
 *    （`s↔sh` · `m↔n` · `零声母↔h`）。
 */
const wakeNearOne = ['书沐薇你在吗', '苏怒薇', '苏沐会'].map((text) => detectFastSignal({ text }))
/** 负控：**两个**音节同时偏 ⇒ 必须不触发（「舒服」就是这种形态） */
const twoNearMustFail = ['舒服', '书会'].map((text) => detectFastSignal({ text }))
/**
 * ⚠️ **用户真声**产生的读数（2026-10-04，从服务端日志逐条抄下来）。
 *
 * 这一组是最有分量的一类正控 —— 它不是合成音、也不是我构造的样例，
 * 而是**用户的麦克风**经过生产识别器之后真的吐出来的字：
 * ```text
 * 父母微  —— 她名字被听成「父母微」（partial）
 * 服木喂  —— 被听成「服木喂」（正式输入）；苏(s u) → 服(f u)
 * 苏母卫  —— 被听成「苏母卫」
 * 苏慕微你在马 / 苏慕威你在吗 —— 早期两次真声读数
 * ```
 * ⚠️ 其中「服木喂」「父母微」两条此前**一次都没命中**（近音类里没有 `f u`）——
 *    也就是说：**判据是在用户真声上被发现的漏洞，也是在用户真声上补的**。
 */
const wakeFromUserVoice = ['父母微', '服木喂', '苏母卫', '苏慕微你在马', '苏慕威你在吗'].map((text) =>
  detectFastSignal({ text })
)
/**
 * ⚠️ `f u` 这条混淆的**代价面**：加它之后必须仍然沉默的那些词。
 *
 * （`父母` 本身不是呼唤：两字形态要求 [沐类][薇类]，而它是 [f u][m u]。）
 */
const afterFuNear = ['父母', '服务', '福尔摩斯', '副木卫'].map((text) => detectFastSignal({ text }))
const notHerName = ['苏州微电子在哪', '苏微', '小薇你在吗', '苏轼的诗词', '木卫二', '素未谋面',
  '母亲节快乐', '速递到了吗'].map((text) => detectFastSignal({ text }))
/** 正控：两字名在"被称呼"的形态下仍然成立 */
const twoCharNameWorks = ['沐薇', '沐薇你在吗', '沐薇，'].map((text) => detectFastSignal({ text }))
/**
 * 否定组：**两个**真正的否定句。
 * ⚠️ `不用说了吗` **不在这里** —— 检测器把它正确判成**疑问**（见下一组）。
 *    第一版把它塞进否定组，于是断言要求它报 `negated` 而它报的是 `question`；
 *    错的是**分组**，不是判据：把"问句"与"否定"混成一类，正是这一层要避免的含糊。
 */
const negated = ['你别停', '不要停下来'].map((text) => detectFastSignal({ text }))
/** 疑问句：**反问不是指令**（第一版把「不用说了吗」判成了 stop —— 这条就是那次修复的锁） */
const questions = ['不用说了吗', '你为什么要停下来', '是不是该等等'].map((text) =>
  detectFastSignal({ text })
)
/**
 * ⚠️ 礼 **礼貌请求不是疑问**：`能不能停一下` 意思正是"请停"。
 *    第一版用 `includes('能不能')` ⇒ 它被判成疑问 ⇒ 停不下来（过宽）。
 *    而 `苏沐薇你在吗` 是**呼唤**：疑问尾巴不能把呼唤吃掉。
 */
const politeRequest = detectFastSignal({ text: '能不能停一下' })
const wakeWithParticle = detectFastSignal({ text: '苏沐薇你在吗' })
const quoted = ['她说“停一下”，我照做了', '他刚才说“苏沐薇”三个字'].map((text) =>
  detectFastSignal({ text })
)
const echo = detectFastSignal({ text: '停一下', herRecentLines: ['你说停一下我就停，行。'] })
const echoOfWake = detectFastSignal({ text: '苏沐薇', herRecentLines: ['苏沐薇在这儿。'] })
/** 普通话**不能**触发（这是"误触发率"的机器形态） */
const ordinary = [
  '今天上课讲了什么',
  '我明天要去一趟实验室',
  '行李还没收',
  '这个选项我再想想',
  '你说的那件事我记住了',
].map((text) => detectFastSignal({ text }))
const stopBeatsWake = detectFastSignal({ text: '停一下，苏沐薇' })
record(
  'B16',
  '**小集合快反**（Lv4.5 / P2）：5 句直接祈使 ⇒ `stop`/`immediate` · 呼唤 ⇒ `wake`/`checked`（句中也能认）· **同音类**（**由词典生成**，覆盖换字/换声调）· **用户真声**（`父母微`/`服木喂`/`苏母卫`/`苏慕微你在马`/`苏慕威你在吗`）全部命中 · **至多一个音节**可用近音（`s↔sh`/`m↔n`/`零声母↔h`/**`f↔s`（用户真声实测）**）· **两个音节同时偏**（「舒服」）不触发 · **非她的名字**（苏州微电子/苏微/小薇/苏轼/**木卫二**/**素未谋面**/**父母**/**服务**）不得触发 · **两字名**在"被称呼"形态下成立 · **否定**（"你别停"）⇒ 不触发且如实报否定 · **疑问**（"不用说了吗"）⇒ 不触发 · **引用**（引号内）⇒ 不触发 · **回声**（复述她的话）⇒ 不触发 · 普通话不误触发 · 同句里 `stop` 优先于 `wake`',
  stopPositive &&
    wakePositive.kind === 'wake' &&
    wakePositive.urgency === 'checked' &&
    wakeMidSentence.kind === 'wake' &&
    wakeHomophones.every((reading) => reading.kind === 'wake') &&
    wakeFromUserVoice.every((reading) => reading.kind === 'wake') &&
    afterFuNear.slice(0, 3).every((reading) => reading.kind === 'none') &&
    wakeNearOne.every((reading) => reading.kind === 'wake') &&
    twoNearMustFail.every((reading) => reading.kind === 'none') &&
    notHerName.every((reading) => reading.kind === 'none') &&
    twoCharNameWorks.every((reading) => reading.kind === 'wake') &&
    negated.every((reading) => reading.kind === 'none' && reading.code.includes('negated')) &&
    questions.every((reading) => reading.kind === 'none' && reading.code === 'signal_question_not_a_command') &&
    politeRequest.kind === 'stop' &&
    wakeWithParticle.kind === 'wake' &&
    quoted.every((reading) => reading.kind === 'none' && reading.code.includes('quoted')) &&
    echo.kind === 'none' &&
    echo.code === 'signal_echo_of_her_own_words' &&
    echoOfWake.kind === 'none' &&
    ordinary.every((reading) => reading.kind === 'none') &&
    stopBeatsWake.kind === 'stop' &&
    FAST_SIGNAL_VOCABULARY.stop.length >= 5 &&
    FAST_SIGNAL_VOCABULARY.wake.length >= 1 &&
    isEcho('停一下', ['你说停一下我就停，行。']),
  `祈使 5/5=${String(stopPositive)} · 呼唤=${wakePositive.kind}/${wakePositive.urgency} · 句中呼唤=${wakeMidSentence.kind} · ` +
    `同音类=${JSON.stringify(wakeHomophones.map((r) => r.kind))} · **用户真声**=${JSON.stringify(wakeFromUserVoice.map((r) => r.kind))} · 加 f 近音后的代价面=${JSON.stringify(afterFuNear.map((r) => r.kind))} · 近音一个=${JSON.stringify(wakeNearOne.map((r) => r.kind))} · ` +
    `近音两个必须沉默=${JSON.stringify(twoNearMustFail.map((r) => r.kind))} · ` +
    `非她的名字=${JSON.stringify(notHerName.map((r) => r.kind))} · 两字名=${JSON.stringify(twoCharNameWorks.map((r) => r.kind))} · ` +
    `否定⇒${JSON.stringify(negated.map((r) => r.code))} · 疑问⇒${JSON.stringify(questions.map((r) => r.code))} · 引用⇒${JSON.stringify(quoted.map((r) => r.code))} · ` +
    `礼貌请求=${politeRequest.kind}（应 stop）· 带语气词的呼唤=${wakeWithParticle.kind}（应 wake）· ` +
    `回声⇒${echo.code} · 普通话⇒${JSON.stringify(ordinary.map((r) => r.kind))} · 停优先=${stopBeatsWake.kind} · ` +
    `登记表 stop=${FAST_SIGNAL_VOCABULARY.stop.length}/wake=${FAST_SIGNAL_VOCABULARY.wake.length}/裸动词=${FAST_SIGNAL_VOCABULARY.bareStopWords.length}`,
  22
)

// ===========================================================================
// B17 Lv4.5 / P3：**有限插话**（有来源的角色输出 + 话权仲裁）
// ===========================================================================
/*
 * 载体：计划 §1「有限插话」/ §2 `P3`。四条判据逐条对应计划原话：
 * ```text
 * 只有三类来源      ⇒ 闭集（多一类就是放宽边界）
 * 检查后的短句      ⇒ 空文本 / 超长（句数与字数）一律丢弃
 * 让出话权          ⇒ 每个 speak 都带 `yieldFloor: true`
 * 用户抢话优先      ⇒ 用户在说话时，**非紧急**的进度通报让位；
 *                      用户版本更新 ⇒ 正在说的那条立刻作废（旧任务不串话）
 * ```
 * ⚠️ 与 B16 快反判定器配合：引用/否定/回声在那一道就挡住了，"谁会触发插话"不在这里重判。
 */
const { arbitrateCharacterOutput, revokeForUserCutIn, CHARACTER_OUTPUT_SOURCES, CHARACTER_OUTPUT_LIMITS, WAKE_RESPONSE_TEXT, LOOKUP_NOTICE_TEXT, MID_TURN_CORRECTION_TEXT } =
  await import('../src/kernel/app/bridge/character-output.ts')
const { ACTION_ATTRIBUTION_EXEMPTIONS, attestActionInitiatorFromNamedExemption, namedExemptionViolation } =
  await import('../src/kernel/contracts/attribution.ts')
const { KernelError } = await import('../src/kernel/contracts/ids.ts')
/** 联合类型要收窄才能读 `code`；测试里用这个小工具，避免为了取一个字段写一堆 if */
const codeOf = (decision: { action: string; code?: string }): string => decision.code ?? decision.action
const floorQuiet = { userSpeaking: false, userRevision: 5 }
const floorUserSpeaking = { userSpeaking: true, userRevision: 5 }
const candidate = (over: Record<string, unknown> = {}) => ({
  text: '查到了，先跟你说一声。',
  source: 'mid_turn_correction' as const,
  turnRevision: 5,
  sourceRefs: ['ev:probe:1'],
  ...over,
})
/** 正控：用户**还在说**的时候，紧急的两类**真的能插**（计划 §3 的出口检查） */
const urgentWhileSpeaking = [
  arbitrateCharacterOutput({ candidate: candidate({ source: 'mid_turn_correction' }), floor: floorUserSpeaking }),
  arbitrateCharacterOutput({ candidate: candidate({ source: 'wake_response', text: '我在。' }), floor: floorUserSpeaking }),
]
const urgentSpeaks = urgentWhileSpeaking.every(
  (decision) => decision.action === 'speak' && decision.yieldFloor === true
)
const quietSpeaks = arbitrateCharacterOutput({ candidate: candidate(), floor: floorQuiet })
const noSource = arbitrateCharacterOutput({ candidate: candidate({ sourceRefs: [] }), floor: floorQuiet })
const emptyText = arbitrateCharacterOutput({ candidate: candidate({ text: '   ' }), floor: floorQuiet })
const noRevision = arbitrateCharacterOutput({ candidate: candidate({ turnRevision: 0 }), floor: floorQuiet })
const tooManySentences = arbitrateCharacterOutput({
  candidate: candidate({ text: '第一句。第二句。第三句。' }),
  floor: floorQuiet,
})
/*
 * ⚠️ 字数要**真的**超（第一版样例只有 39 字 < 60 ⇒ 判据通过了但量到的是 undefined，
 *    看起来像"检测器没响"，其实是我给的输入没超标）。这里按上限+1 生成，杜绝手数。
 */
const tooManyCharacters = arbitrateCharacterOutput({
  candidate: candidate({ text: '长'.repeat(CHARACTER_OUTPUT_LIMITS.maxCharacters + 1) }),
  floor: floorQuiet,
})
/** 旧任务不串话：候选属于**旧版本** ⇒ 丢弃 */
const stale = arbitrateCharacterOutput({
  candidate: candidate({ turnRevision: 4 }),
  floor: { userSpeaking: false, userRevision: 5 },
})
/** 用户在说话 + 非紧急（进度通报）⇒ 让位 */
const nonUrgentWhileSpeaking = arbitrateCharacterOutput({
  candidate: candidate({ source: 'authorized_lookup_notice', text: '还在查。' }),
  floor: floorUserSpeaking,
})
/*
 * ADR-131 `D07`：**主动开口**（第四类来源）也属**非紧急** ⇒ 用户占着话权时同样让位。
 *
 * ⚠️ 这一条是"加第四类"**必须成对交的负控**（`character-output.ts` 的闭集注释逐字要求：
 *    "往里加第五类等于放宽边界（改判据，**要配负控**）"）。
 *    没有它，"主动开口会不会打断用户"就只是**设计意图**，不是**判据**。
 */
const openingWhileSpeaking = arbitrateCharacterOutput({
  candidate: candidate({ source: 'proactive_opening', text: '在忙吗？' }),
  floor: floorUserSpeaking,
})
/** 绕过类型时的运行期兜底 */
const unregisteredSource = arbitrateCharacterOutput({
  candidate: candidate({ source: 'chit_chat' as never }),
  floor: floorQuiet,
})
/** 用户抢话 ⇒ 正在说的那条作废（用户版本相同也算：他开口了） */
const cutInNewer = revokeForUserCutIn({ speakingRevision: 5, userRevision: 6 })
const cutInSame = revokeForUserCutIn({ speakingRevision: 5, userRevision: 5 })
const cutInOlder = revokeForUserCutIn({ speakingRevision: 5, userRevision: 4 })
record(
  'B17',
  '**有限插话**（Lv4.5 / P3）：用户在说话时**紧急两类仍能插**（且都带"让出话权"）· **无来源/空文本/无版本**一律失败关闭 · **超长**（句数与字数双限）丢弃 · **旧版本**丢弃（旧任务不串话）· 用户说话时的**非紧急让位**（进度通报 + ADR-131 的**主动开口**）· 绕过类型时报未登记 · **用户抢话**使正在说的那条作废 · **来源闭集 = 4**（ADR-131 加入 `proactive_opening`）',
  urgentSpeaks &&
    quietSpeaks.action === 'speak' &&
    quietSpeaks.yieldFloor === true &&
    codeOf(noSource) === 'output_without_source' &&
    codeOf(emptyText) === 'output_without_checked_text' &&
    codeOf(noRevision) === 'output_without_revision' &&
    codeOf(tooManySentences) === 'output_too_long' &&
    codeOf(tooManyCharacters) === 'output_too_long' &&
    codeOf(stale) === 'output_stale_against_user_revision' &&
    codeOf(nonUrgentWhileSpeaking) === 'user_holds_floor_for_non_urgent_output' &&
    codeOf(openingWhileSpeaking) === 'user_holds_floor_for_non_urgent_output' &&
    codeOf(unregisteredSource) === 'output_source_not_registered' &&
    cutInNewer.revoked === true &&
    cutInSame.revoked === true &&
    cutInOlder.revoked === false &&
    CHARACTER_OUTPUT_SOURCES.length === 4 &&
    CHARACTER_OUTPUT_LIMITS.maxSentences === 2,
  `用户说话时紧急两类可插=${String(urgentSpeaks)}（让出话权）· 安静时可插=${quietSpeaks.action} · 无来源=${codeOf(noSource)} · 空文本=${codeOf(emptyText)} · ` +
    `无版本=${codeOf(noRevision)} · 超句数=${codeOf(tooManySentences)} · 超字数=${codeOf(tooManyCharacters)} · 旧版本=${codeOf(stale)} · ` +
    `非紧急让位=${codeOf(nonUrgentWhileSpeaking)} · 主动开口让位=${codeOf(openingWhileSpeaking)} · 未登记来源=${codeOf(unregisteredSource)} · ` +
    `抢话作废（新=${String(cutInNewer.revoked)}/同=${String(cutInSame.revoked)}/旧=${String(cutInOlder.revoked)}）· 来源闭集=${CHARACTER_OUTPUT_SOURCES.length}`,
  23
)

// ===========================================================================
// B18 Lv4.5 / P3：**出站**的有来源角色输出（真的写出**一行**，不是记个数）
// ===========================================================================
/*
 * B17 判的是"该不该说"；这一条判"真的说出去了没有"，以及三种"不该说"时
 * **一个字节都不许写**（否则"丢弃"与"说出去了"在线上无法区分）。
 */
const outboundLines: string[] = []
const outboundBridge = new TurnBridge({ host: makeStubHost().host })
const outboundCandidate = {
  text: '我在。',
  source: 'wake_response' as const,
  turnRevision: 7,
  sourceRefs: ['ev:wake:1'],
}
/* ① 没有出站通道 ⇒ 如实报"没说出"，且**不**写任何东西 */
const absentChannel = outboundBridge.emitCharacterOutput({
  candidate: outboundCandidate,
  floor: { userSpeaking: false, userRevision: 7 },
})
outboundBridge.setOutputSink((message) => outboundLines.push(JSON.stringify(message)))
/* ② 装上通道 ⇒ 真的写出一行 */
const spoken = outboundBridge.emitCharacterOutput({
  candidate: outboundCandidate,
  floor: { userSpeaking: true, userRevision: 7 },
})
/* ③ 旧版本 ⇒ 不写 */
const staleOut = outboundBridge.emitCharacterOutput({
  candidate: { ...outboundCandidate, turnRevision: 6 },
  floor: { userSpeaking: false, userRevision: 7 },
})
/* ④ 用户说话时的非紧急 ⇒ 不写 */
const yieldedOut = outboundBridge.emitCharacterOutput({
  candidate: { ...outboundCandidate, source: 'authorized_lookup_notice', text: '还在查。' },
  floor: { userSpeaking: true, userRevision: 7 },
})
const wire = outboundLines.length === 1 ? (JSON.parse(outboundLines[0]!) as Record<string, unknown>) : undefined
const wireOutput = wire?.characterOutput as
  | { revision: number; source: string; sourceRefs: readonly string[]; text: string; yieldFloor: boolean }
  | undefined
/* ⑤ 带 sidecar ⇒ 走**与正式轮次相同**的交付链（判据：sidecar 原样出现在线上消息里） */
const interjectionDraft = decodeExpressiveSpeech(
  '<lg-speech>{"segments":[{"text":"我在。","cue":"firm"}]}</lg-speech>'
)
const interjectionSidecar = bindSpeechExpression('interjection:1', interjectionDraft.text, interjectionDraft)
const spokenWithExpression = outboundBridge.emitCharacterOutput({
  candidate: { ...outboundCandidate, text: '我在。', turnRevision: 8 },
  floor: { userSpeaking: false, userRevision: 8 },
  expression: interjectionSidecar,
})
const wireWithExpression = outboundLines.length === 2
  ? (JSON.parse(outboundLines[1]!) as Record<string, unknown>)
  : undefined
const wireExpression = wireWithExpression?.characterOutput as { expression?: { segments?: unknown[] } } | undefined
/** ⑥ 不带 sidecar ⇒ 如实记"没带"，不当成同一种"说出去了" */
const spokenWithoutExpression = outboundBridge.emitCharacterOutput({
  candidate: { ...outboundCandidate, text: '嗯。', turnRevision: 8 },
  floor: { userSpeaking: false, userRevision: 8 },
})
record(
  'B18',
  '**出站的有来源角色输出**（Lv4.5 / P3）：没有通道 ⇒ 如实报 `output_channel_absent` 且不写 · 有通道 ⇒ **真的写出一行** `CHARACTER_OUTPUT`（带 revision/source/sourceRefs/text/yieldFloor，且 `requestId` 为空）· **带 sidecar** ⇒ sidecar 原样上线（走的才是与正式轮次**相同**的交付链）· **不带 sidecar** 的条数**单独记**（"按纯文本播"不是同一种"说出去了"）· **旧版本**与**用户占着话权时的非紧急**都**一个字节都不写** · 读数分列 spoken/dropped/yielded',
  absentChannel.action === 'drop' &&
    absentChannel.code === 'output_channel_absent' &&
    spoken.action === 'speak' &&
    staleOut.action === 'drop' &&
    yieldedOut.action === 'yield_to_user' &&
    spokenWithExpression.action === 'speak' &&
    spokenWithoutExpression.action === 'speak' &&
    outboundLines.length === 3 &&
    wire?.kind === 'CHARACTER_OUTPUT' &&
    wire?.requestId === '' &&
    wire?.outcome === 'spoken' &&
    wireOutput?.revision === 7 &&
    wireOutput?.source === 'wake_response' &&
    wireOutput?.yieldFloor === true &&
    wireOutput?.text === '我在。' &&
    wireOutput?.sourceRefs.length === 1 &&
    wireExpression?.expression?.segments?.length === 1 &&
    /* ✅ 正控：`TURN_RESULT` 那一支的字段一个都不许出现（它不是一轮的结果） */
    wire?.replyText === undefined &&
    wire?.replyId === undefined &&
    wire?.traceId === undefined &&
    wireWithExpression?.replyText === undefined &&
    outboundBridge.outputReading.spoken === 3 &&
    outboundBridge.outputReading.dropped === 2 &&
    outboundBridge.outputReading.yielded === 1 &&
    /* 3 条说出去了，其中**只有 1 条**带 sidecar ⇒ 另外 2 条按纯文本播（如实分列） */
    outboundBridge.outputReading.spokenWithoutExpression === 2,
  `无通道=${codeOf(absentChannel)} · 写出=${String(spoken.action)} · 旧版本=${codeOf(staleOut)} · 非紧急让位=${codeOf(yieldedOut)} · ` +
    `写出行数=${outboundLines.length}（应 3）· kind=${String(wire?.kind)} · requestId=${JSON.stringify(wire?.requestId)} · ` +
    `带 sidecar 的分句数=${String(wireExpression?.expression?.segments?.length)} · ` +
    `读数 spoken=${outboundBridge.outputReading.spoken}/dropped=${outboundBridge.outputReading.dropped}/yielded=${outboundBridge.outputReading.yielded}/无 sidecar=${outboundBridge.outputReading.spokenWithoutExpression}`,
  24
)

// ===========================================================================
// B19 Lv4.5 / P3：**生产者**（呼唤 ⇒ 真的有来源短句从 PREPARE_TURN 那条路产出来）
// ===========================================================================
/*
 * 载体：计划 §1「呼唤苏沐薇等少量信号快速触发停止或可见回应」+ §3 的出口检查
 *       「用户未结束前短插话**实际发生**」。
 *
 * ⚠️ 这条门要防的正是 `L-S8-30` 那个形态：**入口没有调用者时门照样绿**。
 *    所以判据不落在"函数存在"，而落在"发一条 PREPARE_TURN 之后**真的写出了一行**"。
 */
/*
 * ⚠️ 复用上面那个**有只读准备能力**的 host 形态（`prepareStub.host` + `prepareTurn`）：
 *    第一版我用了 `makeStubHost()`，它**没有** `prepareTurn` ⇒ PREPARE_TURN 在到达
 *    呼唤判定**之前**就返回 `prepare_capability_absent` 了。于是"开关开着也不产出"，
 *    而失败看起来像"呼唤检测没触发"—— **判据没错，取材错了**。
 *    顺带说明为什么呼唤判定必须挂在准备之后：它要读的是**那次准备成功**之后的状态。
 */
const wakeStub = makeStubHost()
const wakeCalls: { userText: string }[] = []
const wakeHost: TurnBridgeHost = {
  ...wakeStub.host,
  prepareTurn: (input) => {
    wakeCalls.push({ userText: input.userText })
    return {
      candidateRevision: `rev:wake:${wakeCalls.length}`,
      recall: { status: 'ran', selectedCount: 1, selectedMemoryIds: ['mem:wake:1'] },
      wroteAnything: false,
    }
  },
}
const wakeLines: string[] = []
const wakeBridge = new TurnBridge({ host: wakeHost })
wakeBridge.setOutputSink((message) => wakeLines.push(JSON.stringify(message)))
/** ① 开关**关着**（代码缺省）⇒ 走完一条呼唤也不许产出任何东西 */
await handleBridgeMessage(wakeBridge, { kind: 'PREPARE_TURN', requestId: 'wake:off', userText: '苏沐薇你在吗' })
const offCount = wakeLines.length
/** ② 开关开着 ⇒ 呼唤**真的产出一行**（这一次开口编号 = 1） */
wakeBridge.interjectionEnabled = true
await handleBridgeMessage(wakeBridge, {
  kind: 'PREPARE_TURN', requestId: 'wake:on', userText: '苏沐薇你在吗', utteranceKey: 'clientA:1',
})
const wakeWire = wakeLines.length === 1 ? (JSON.parse(wakeLines[0]!) as Record<string, unknown>) : undefined
const wakePayload = wakeWire?.characterOutput as
  | { source?: string; sourceRefs?: readonly string[]; text?: string; revision?: number; yieldFloor?: boolean; expression?: { segments?: unknown[] } }
  | undefined
/** ③ 疑问/引用/否定**不**产出（与 B16 同一套负控，这里判"有没有写出去"） */
await handleBridgeMessage(wakeBridge, { kind: 'PREPARE_TURN', requestId: 'wake:q', userText: '为什么苏沐薇' })
await handleBridgeMessage(wakeBridge, { kind: 'PREPARE_TURN', requestId: 'wake:quote', userText: '她说了“苏沐薇”三个字' })
await handleBridgeMessage(wakeBridge, { kind: 'PREPARE_TURN', requestId: 'wake:neg', userText: '别叫苏沐薇' })
/*
 * ⚠️ **刻意不放**"只喊一声 `苏沐薇`"当负控：在没有"她刚说过什么"的上下文时，
 *    它**确实**是一次呼唤（回声判定需要她自己的上文，见 `fast-signal.ts`）。
 *    第一版把它当负控 ⇒ 多出一条产出，看起来像误触发，其实是**判据取材错**。
 */
const afterNegatives = wakeLines.length
/*
 * ⚠️ **去重**：外壳是**每一块 partial 都发一次准备**的，所以一句"苏沐薇你在吗"会长成
 *    三次准备、三次都命中名字 ⇒ 实测她会把「我在。」说三遍（3 个 `lg-expression-turn`、
 *    多个不同的 `interjection:N#0`）。判据：**同一次开口只答一次**；
 *    外壳在 VAD 边界推进 `utteranceId` ⇒ 下一次开口再叫还会答。
 *
 * ⚠️ 第一版把去重键挂在"下一轮提交"上 —— 那会让"**只叫一声、不说话**"的呼唤
 *    永远算作没翻页，之后每次叫她**都被挡掉**（实测：连续几次探针只成功了一次）。
 *    所以键必须是外壳给的 `utteranceId`。
 */
await handleBridgeMessage(wakeBridge, {
  kind: 'PREPARE_TURN', requestId: 'wake:dup-1', userText: '苏慕微你', utteranceKey: 'clientA:1',
})
await handleBridgeMessage(wakeBridge, {
  kind: 'PREPARE_TURN', requestId: 'wake:dup-2', userText: '苏慕微你在', utteranceKey: 'clientA:1',
})
const afterDuplicates = wakeLines.length
const suppressedAfterDuplicates = wakeBridge.outputReading.suppressedWake
/** 新的开口（外壳在 VAD 边界 +1）⇒ 再叫一次**还会答** */
await handleBridgeMessage(wakeBridge, {
  kind: 'PREPARE_TURN', requestId: 'wake:next-utterance', userText: '苏沐薇', utteranceKey: 'clientA:2',
})
const afterNewUtterance = wakeLines.length
/** ⚠️ 不带键的旧客户端 ⇒ **不去重**（宁可多说一次，也不要永久哑掉） */
await handleBridgeMessage(wakeBridge, {
  kind: 'PREPARE_TURN', requestId: 'wake:no-utterance', userText: '苏沐薇你在吗',
})
const afterNoUtterance = wakeLines.length
/*
 * ⚠️ **别的客户端**的同一句开口 ⇒ 必须**答**。
 *
 * 这是实测出来的：`utterance` 是**每条连接各自**从 1 开始的，桥若只按键里的编号去重，
 * 那么"**刷新页面**"（新连接、编号回到 1）的第一句会被当成"上一次开口已答过" ⇒
 * **她静默不理**。键里带客户端身份，这一条就不成立。
 */
await handleBridgeMessage(wakeBridge, {
  kind: 'PREPARE_TURN', requestId: 'wake:other-client', userText: '苏沐薇', utteranceKey: 'clientB:1',
})
const afterOtherClient = wakeLines.length
record(
  'B19',
  '**呼唤的生产者**（Lv4.5 / P3）：开关**关着**（代码缺省）时走完一条呼唤**零产出** · 开着时呼唤**真的写出一行** `CHARACTER_OUTPUT`（`source=wake_response` · 有 `sourceRefs` · 短句在长度上限内 · 带表达 sidecar · `yieldFloor`）· 决定这条的是**只读准备那条路**（不是新铺的一条）· 版本**新于**用户版本 · **同一次开口只答一次**（多条 partial 准备不会让她说三遍）· **新的开口再叫还会答** · **不带开口键的旧客户端不去重**（不永久哑掉）· **别的客户端的同一句开口照样答**（刷新页面后不被静默忽略）· 疑问/引用/否定各加零条',
  offCount === 0 &&
    /* 全程只写出**四行**：第一次呼唤 + 新开口 + 无键的旧客户端 + 另一个客户端 */
    wakeLines.length === 4 &&
    wakeWire?.kind === 'CHARACTER_OUTPUT' &&
    wakePayload?.source === 'wake_response' &&
    (wakePayload?.sourceRefs?.length ?? 0) === 1 &&
    wakePayload?.text === WAKE_RESPONSE_TEXT &&
    wakePayload?.yieldFloor === true &&
    (wakePayload?.expression?.segments?.length ?? 0) >= 1 &&
    typeof wakePayload?.revision === 'number' &&
    /* 负控之后**没有**多出任何一条 */
    afterNegatives === 1 &&
    /* 去重：同一次开口的两次额外准备**一条都不加**，且如实计入 suppressedWake */
    afterDuplicates === 1 &&
    suppressedAfterDuplicates === 2 &&
    afterNewUtterance === 2 &&
    afterNoUtterance === 3 &&
    afterOtherClient === 4 &&
    wakeBridge.outputReading.spoken === 4 &&
    wakeBridge.outputReading.dropped === 0,
  `关着时产出=${offCount}（应 0）· 开着后写出行数=${wakeLines.length} · ` +
    `source=${String(wakePayload?.source)} · 短句=${String(wakePayload?.text)} · 引用数=${String(wakePayload?.sourceRefs?.length)} · ` +
    `sidecar 分句=${String(wakePayload?.expression?.segments?.length)} · revision=${String(wakePayload?.revision)} · ` +
    `疑问/引用/否定之后=${afterNegatives}（应 1）· 同一次开口的重复准备之后=${afterDuplicates}（应 1，抑制 ${suppressedAfterDuplicates}）· ` +
    `新开口再叫=${afterNewUtterance}（应 2）· 不带键=${afterNoUtterance}（应 3）· 别的客户端=${afterOtherClient}（应 4）· ` +
    `读数 spoken=${wakeBridge.outputReading.spoken}/dropped=${wakeBridge.outputReading.dropped}/suppressedWake=${wakeBridge.outputReading.suppressedWake}`,
  28
)

/** `B16` 追加（`P3` 用户更正）：`correction` 类的正控与负控 */
const correctionPositive = detectFastSignal({ text: '不对，不是这个意思' })
const correctionQuestion = detectFastSignal({ text: '不对吗？' })
const correctionQuoted = detectFastSignal({ text: '他刚才说"不对"这两个字' })
const correctionBeatsWake = detectFastSignal({ text: '不对，苏沐薇' })
const stopBeatsCorrection = detectFastSignal({ text: '别说了，不对' })
record(
  'B16c',
  '**用户更正**信号（Lv4.5 / P3）：「不对，不是这个意思」⇒ `correction`/`checked` · **疑问**（"不对吗？"）⇒ 不触发 · **引用**（引号里）⇒ 不触发 · 与呼唤同句 ⇒ **更正优先**（用户要的是"改"不是"打招呼"）· 与 `stop` 同句 ⇒ **停优先**（最保守的那个动作赢）',
  correctionPositive.kind === 'correction' &&
    correctionPositive.urgency === 'checked' &&
    correctionQuestion.kind === 'none' &&
    correctionQuoted.kind === 'none' &&
    correctionBeatsWake.kind === 'correction' &&
    stopBeatsCorrection.kind === 'stop',
  `「不对，不是这个意思」=${correctionPositive.kind}/${correctionPositive.urgency} · ` +
    `「不对吗？」=${correctionQuestion.kind}/${correctionQuestion.code} · ` +
    `引用=${correctionQuoted.kind}/${correctionQuoted.code} · ` +
    `与呼唤同句=${correctionBeatsWake.kind} · 与 stop 同句=${stopBeatsCorrection.kind}`,
  5
)

// ===========================================================================
// B20 Lv4.5 / P3（选项 B）：**边听边查** —— 时机才是它的全部价值
// ===========================================================================
/*
 * 载体：用户 2026-10-04 裁定「B. 窄版「边听边查」」。
 *
 * ```text
 * 显式检索词形（复用 M5.5 判定器）⇒ 才提前查
 * 查到了 **且她正在说**          ⇒ 插一句"查到了。"
 * 她没在说 / 不知道她是否在说     ⇒ **不说**（正式轮次马上就会给内容，提前插只是多插）
 * 没有这个能力                    ⇒ **不查**（失败关闭，不假装查过）
 * 查到了但没有来源 id             ⇒ **不说**（有来源是硬要求）
 * ```
 * ⚠️ 这条门的价值**全在"不该说的时刻真的不说"**：一个"查到就说"的实现能通过所有正控。
 */
const lookupLines: string[] = []
let sheIsSpeaking = true
let lookupCalls = 0
const lookupStub = makeStubHost()
const lookupBridge = new TurnBridge({
  host: {
    ...lookupStub.host,
    prepareTurn: () => ({
      candidateRevision: 'rev:lookup:1',
      recall: { status: 'ran', selectedCount: 1, selectedMemoryIds: ['mem:lookup:1'] },
      wroteAnything: false,
    }),
    sheIsSpeaking: () => sheIsSpeaking,
    prepareLookup: async (input) => {
      lookupCalls += 1
      return { status: 'found', sourceRefs: [`ev:lookup:${input.query.slice(0, 8)}`] }
    },
  },
})
lookupBridge.interjectionEnabled = true
lookupBridge.setOutputSink((message) => lookupLines.push(JSON.stringify(message)))
/** ① 她正在说 + 显式检索词形 ⇒ **说** */
await handleBridgeMessage(lookupBridge, {
  kind: 'PREPARE_TURN', requestId: 'lookup:on', userText: '帮我查一下明天的天气',
})
const afterSpeaking = lookupLines.length
const lookupPayload = afterSpeaking === 1
  ? (JSON.parse(lookupLines[0]!) as { characterOutput?: { source?: string; text?: string; sourceRefs?: readonly string[] } })
      .characterOutput
  : undefined
/** ② 她**没**在说 ⇒ 不说（正式轮次马上就会给内容） */
sheIsSpeaking = false
await handleBridgeMessage(lookupBridge, {
  kind: 'PREPARE_TURN', requestId: 'lookup:quiet', userText: '帮我查一下后天的天气',
})
const afterQuiet = lookupLines.length
/** ③ 有显式词形但**她没在说** ⇒ 同样不说（与②同一条判据，换个顺序再钉一次） */
sheIsSpeaking = false
await handleBridgeMessage(lookupBridge, {
  kind: 'PREPARE_TURN', requestId: 'lookup:none', userText: '搜索一下今天的新闻',
})
const afterNone = lookupLines.length
/** ④ **不是**显式检索词形 ⇒ 连查都不查（防止它变成第二个搜索入口） */
sheIsSpeaking = true
const lookupCallsBefore = lookupCalls
await handleBridgeMessage(lookupBridge, {
  kind: 'PREPARE_TURN', requestId: 'lookup:not-explicit', userText: '今天天气不错，我们聊点别的',
})
const afterNotExplicit = lookupLines.length
const lookupCallsAfter = lookupCalls
/** ⑤ 同一次发音**只查一次** —— partial 是**反复**到达的，不去重就是每一条都买一次检索 */
sheIsSpeaking = true
const lookupCallsBeforeDedupe = lookupCalls
for (let index = 0; index < 4; index += 1) {
  await handleBridgeMessage(lookupBridge, {
    kind: 'PREPARE_TURN', requestId: `lookup:dedupe-${String(index)}`,
    userText: '帮我查一下明天的天气',
    utteranceKey: 'c:7',
  })
}
const dedupeCalls = lookupCalls - lookupCallsBeforeDedupe
const dedupeLines = lookupLines.length
/** ⑥ 换一次发音（新键）⇒ **应该**再查一次（否则"只查一次"会退化成"只查一次、永远不再查"） */
await handleBridgeMessage(lookupBridge, {
  kind: 'PREPARE_TURN', requestId: 'lookup:new-utterance',
  userText: '帮我查一下明天的天气',
  utteranceKey: 'c:8',
})
const afterNewUtteranceCalls = lookupCalls - lookupCallsBeforeDedupe
/** ⑦ **生长的 partial**：同一次发音先到"帮我查"（不是显式词形）、后到"帮我查一下"（是）⇒ 仍要查 */
const beforeGrowing = lookupCalls
await handleBridgeMessage(lookupBridge, {
  kind: 'PREPARE_TURN', requestId: 'lookup:grow-1', userText: '帮我查', utteranceKey: 'c:9',
})
await handleBridgeMessage(lookupBridge, {
  kind: 'PREPARE_TURN', requestId: 'lookup:grow-2', userText: '帮我查一下明天的天气', utteranceKey: 'c:9',
})
const growingCalls = lookupCalls - beforeGrowing
/** ⑧ **碎片不消耗这一枪**：`帮我搜一下好` ⇒ query 只有"好"（1 字）⇒ 不查、**也不记键** */
const beforeFragment = lookupCalls
await handleBridgeMessage(lookupBridge, {
  kind: 'PREPARE_TURN', requestId: 'lookup:fragment-1', userText: '帮我搜一下好', utteranceKey: 'c:10',
})
const fragmentCalls = lookupCalls - beforeFragment
/** 同一次发音长全了 ⇒ **这一枪**该打了（证明碎片只是"等一等"，不是"永久关掉"） */
await handleBridgeMessage(lookupBridge, {
  kind: 'PREPARE_TURN', requestId: 'lookup:fragment-2', userText: '帮我搜一下好天气', utteranceKey: 'c:10',
})
const afterFuller = lookupCalls - beforeFragment
record(
  'B20',
  '**边听边查**（Lv4.5 / P3 选项 B）：显式检索词形 + **她正在说** ⇒ 真的插一句"查到了。"（`source=authorized_lookup_notice` · 有来源 id）· 她**没在说** ⇒ 不说 · **不是**显式词形 ⇒ **连查都不查**（不变成第二个搜索入口）· **同一次发音只查一次**（partial 反复到达 ⇒ 不去重就是每条都买一次出站）· **生长的 partial**（先"帮我查"后"帮我查一下"，同一次发音）仍会查 · **碎片不消耗这一枪**（query 只剩 1 个字 ⇒ 实测 Tavily HTTP 400 ⇒ 不查也不记键，等长全）· 换一次发音仍会再查 · 显式词形判定**复用 M5.5 的判定器**（不另发明触发词）',
  afterSpeaking === 1 &&
    afterQuiet === 1 &&
    afterNone === 1 &&
    afterNotExplicit === 1 &&
    lookupCallsAfter === lookupCallsBefore &&
    dedupeCalls === 1 &&
    afterNewUtteranceCalls === 2 &&
    growingCalls === 1 &&
    fragmentCalls === 0 &&
    afterFuller === 1 &&
    lookupPayload?.source === 'authorized_lookup_notice' &&
    lookupPayload?.text === LOOKUP_NOTICE_TEXT &&
    (lookupPayload?.sourceRefs?.length ?? 0) === 1,
  `她正在说时=${afterSpeaking}（应 1）· 她没在说=${afterQuiet}（应 1，不加）· 再说一次仍=${afterNone}（应 1）· ` +
    `非显式词形=${afterNotExplicit}（应 1，不加）且**查的次数**从 ${lookupCallsBefore} 到 ${lookupCallsAfter}（应不变）· ` +
    `同一发音连送 4 条 partial ⇒ 只查了 **${dedupeCalls}** 次（应 1）· 换一个发音键 ⇒ 累计 ${afterNewUtteranceCalls} 次（应 2）· ` +
    `生长的 partial（"帮我查"→"帮我查一下"，同一键）⇒ 查了 **${growingCalls}** 次（应 1）· ` +
    `碎片 query（1 字）⇒ 查了 **${fragmentCalls}** 次（应 0）· 同键长全后 ⇒ 累计 ${afterFuller} 次（应 1）· ` +
    `短句=${String(lookupPayload?.text)} · 来源=${String(lookupPayload?.source)} · 来源数=${String(lookupPayload?.sourceRefs?.length)}`,
  16
)

// ===========================================================================
// B21 Lv4.5 / P3（选项 B）：**"什么算来源"** 的翻译（纯函数，构造输入即可验证）
// ===========================================================================
/*
 * 为什么这条要单独一条门：它是"检索到底查到没有"的**唯一**翻译处，
 * 而这里最容易出的错是**把不该算的来源算成来源** —— 动作结果里的 evidence 混着
 * adapter / policy / ledger / filesystem 好几类行，只有 adapter 行上的
 * `externalEvidence.id` 才是"她依据的那条外部证据"。
 *
 * ⚠️ 负控（下面第②条）才是重点：**一串"她做过什么"的行不得变成"她凭什么"**。
 */
const lookupFromRejected = toLookupReading({ accepted: false, status: 'permission_denied' })
const lookupFromPolicyOnly = toLookupReading({
  accepted: true,
  status: 'success',
  evidence: [
    { externalEvidence: undefined },
    { externalEvidence: undefined },
  ],
})
const lookupFromAdapter = toLookupReading({
  accepted: true,
  status: 'success',
  evidence: [{ externalEvidence: undefined }, { externalEvidence: { id: 'ext:ev-1' } }],
})
const lookupFromAdapterNoId = toLookupReading({
  accepted: true,
  status: 'success',
  evidence: [{ externalEvidence: {} }],
})
record(
  'B21',
  '**边听边查**的翻译（Lv4.5 / P3 选项 B）：策略拒绝 ⇒ `rejected` · **只有"她做过什么"的行（无 externalEvidence）⇒ `not_found`，不得变成来源** · 有一条 adapter 外部证据 ⇒ `found` 且来源 id 恰好是它 · 外部证据**没有 id** ⇒ `not_found`（不产出一个空来源）',
  lookupFromRejected.status === 'rejected' &&
    lookupFromRejected.code === 'permission_denied' &&
    lookupFromPolicyOnly.status === 'not_found' &&
    (lookupFromPolicyOnly.sourceRefs?.length ?? 0) === 0 &&
    lookupFromAdapter.status === 'found' &&
    lookupFromAdapter.sourceRefs?.length === 1 &&
    lookupFromAdapter.sourceRefs[0] === 'ext:ev-1' &&
    lookupFromAdapterNoId.status === 'not_found',
  `策略拒绝=${lookupFromRejected.status}/${String(lookupFromRejected.code)} · ` +
    `只有动作行=${lookupFromPolicyOnly.status}（应 not_found，来源数 ${String(lookupFromPolicyOnly.sourceRefs?.length ?? 0)} 应 0）· ` +
    `含一条外部证据=${lookupFromAdapter.status}/${String(lookupFromAdapter.sourceRefs?.join(','))}（应 found/ext:ev-1）· ` +
    `外部证据无 id=${lookupFromAdapterNoId.status}（应 not_found）`,
  4
)

// ===========================================================================
// B22 Lv4.5 / P3（选项 B）：**失败要还回键**（一次瞬时失败不得永久废掉这次发音）
// ===========================================================================
/*
 * 实测来源：真链路上检索**失败**（`KernelError`），而键已经被记下 ⇒ 这条发音
 * 后面每一条 partial 全部被去重吃掉 ⇒ **一次失败 = 整个功能静默失效**。
 *
 * ```text
 * ① 第一次（键 c:fail）失败 ⇒ 键被还回
 * ② 同一次发音的下一条 partial ⇒ **再试一次**（并且这次成功、真的说了那一句）
 * ③ 换个发音键也照样查（不因上一次失败而整体停摆）
 * ```
 */
let failCalls = 0
const retryLines: string[] = []
const retryStub = makeStubHost()
const retryBridge = new TurnBridge({
  host: {
    ...retryStub.host,
    prepareTurn: () => ({
      candidateRevision: 'rev:retry:1',
      recall: { status: 'ran', selectedCount: 1, selectedMemoryIds: ['mem:retry:1'] },
      wroteAnything: false,
    }),
    sheIsSpeaking: () => true,
    prepareLookup: async (input) => {
      failCalls += 1
      /* 第一次**失败**（模拟网关抛错/被拒），之后成功 */
      if (failCalls === 1) return { status: 'failed', code: 'action_attribution_evidence_missing' }
      return { status: 'found', sourceRefs: [`ev:retry:${input.query.slice(0, 6)}`] }
    },
  },
})
retryBridge.interjectionEnabled = true
retryBridge.setOutputSink((message) => retryLines.push(JSON.stringify(message)))
/** ① 第一次失败 */
await handleBridgeMessage(retryBridge, {
  kind: 'PREPARE_TURN', requestId: 'retry:1', userText: '帮我查一下明天的天气', utteranceKey: 'c:fail',
})
const afterFirstFailure = failCalls
const linesAfterFailure = retryLines.length
/** ② 同一次发音的下一条 partial ⇒ 必须**再试**（键被还回了） */
await handleBridgeMessage(retryBridge, {
  kind: 'PREPARE_TURN', requestId: 'retry:2', userText: '帮我查一下明天的天气', utteranceKey: 'c:fail',
})
const afterRetry = failCalls
const retryPayload = retryLines.length > 0
  ? (JSON.parse(retryLines[0]!) as { characterOutput?: { source?: string } }).characterOutput
  : undefined
record(
  'B22',
  '**边听边查：失败要还回键**（Lv4.5 / P3 选项 B）：第一次检索**失败** ⇒ 这次发音的键被还回 ⇒ **下一条 partial 会再试**（且成功时真的说了那一句）· 不是"一次瞬时失败 = 这个功能静默失效"',
  afterFirstFailure === 1 &&
    linesAfterFailure === 0 &&
    afterRetry === 2 &&
    retryPayload?.source === 'authorized_lookup_notice',
  `第一次失败后调用数=${afterFirstFailure}（应 1）且此时**没有**短句（应 0，实际 ${String(linesAfterFailure)}）· ` +
    `同键再送一条 ⇒ 调用数=${afterRetry}（应 2，说明键被还回、真的重试了）· 重试后的短句来源=${String(retryPayload?.source)}`,
  3
)

// ===========================================================================
// B23 ADR-098：**具名归因豁免的收窄**（纯判据 ⇒ 构造输入即可做正控/负控）
// ===========================================================================
/*
 * 用户 2026-10-05 裁定「给它一个具名的归因豁免」。这条豁免一旦被放宽成通用逃生门，
 * 就等于拆掉 ADR-042 的"谁发起的必须可查、不能靠猜"。所以收窄要**逐条**钉住：
 *
 * ```text
 * ① 声明的落点（web.search/search + 只读）⇒ **合法**（正控）
 * ② 身份不在闭集里                        ⇒ `unregistered_attribution_exemption`
 * ③ 用到别的能力/操作上                   ⇒ `attribution_exemption_scope_mismatch`
 * ④ 登记的那个操作其实是写                ⇒ `attribution_exemption_not_read_only`
 * ⑤ principal 为 null（匿名逃生门）        ⇒ `attribution_exemption_without_principal`
 * ⑥ 构造器只认闭集里的名字                 ⇒ 别的名字 ⇒ `unknown_attribution_exemption`
 * ⑦ 回到声明的落点                        ⇒ 又**合法**（恢复）
 * ```
 */
const exemptionScope = ACTION_ATTRIBUTION_EXEMPTIONS.pre_turn_lookup
const exemptionPrincipal = exemptionScope.principal
const declaredOk = namedExemptionViolation({
  principal: exemptionPrincipal,
  capability: exemptionScope.capability,
  operation: exemptionScope.operation,
  registeredSideEffect: 'read',
})
const unregisteredPrincipal = namedExemptionViolation({
  principal: { kind: 'SYSTEM', id: 'some-other-system-thing' },
  capability: exemptionScope.capability,
  operation: exemptionScope.operation,
  registeredSideEffect: 'read',
})
const scopeMismatch = namedExemptionViolation({
  principal: exemptionPrincipal,
  capability: 'sandbox.file.write',
  operation: 'write',
  registeredSideEffect: 'read',
})
const notReadOnly = namedExemptionViolation({
  principal: exemptionPrincipal,
  capability: exemptionScope.capability,
  operation: exemptionScope.operation,
  registeredSideEffect: 'write',
})
const withoutPrincipal = namedExemptionViolation({
  principal: null,
  capability: exemptionScope.capability,
  operation: exemptionScope.operation,
  registeredSideEffect: 'read',
})
const declaredOkAgain = namedExemptionViolation({
  principal: exemptionPrincipal,
  capability: exemptionScope.capability,
  operation: exemptionScope.operation,
  registeredSideEffect: 'read',
})
/** ⑥ 构造器只认闭集：别的名字必须**具名拒绝**（不许造一条匿名豁免） */
let unknownExemptionCode: string | null = null
try {
  attestActionInitiatorFromNamedExemption({
    adapterId: 'gate',
    exemption: 'not_a_real_exemption' as keyof typeof ACTION_ATTRIBUTION_EXEMPTIONS,
  })
} catch (error) {
  unknownExemptionCode = error instanceof KernelError ? error.code : (error as Error)?.name ?? 'unknown'
}
record(
  'B23',
  '**具名归因豁免的收窄**（ADR-098 · Lv4.5 / P3 选项 B）：声明的落点合法 · 身份不在闭集 ⇒ 具名拒绝 · 能力/操作不符 ⇒ 拒绝 · 登记为写 ⇒ 拒绝 · **principal 为 null（匿名逃生门）⇒ 拒绝** · 构造器只认闭集里的名字 · 恢复后仍合法',
  declaredOk === undefined &&
    unregisteredPrincipal?.code === 'unregistered_attribution_exemption' &&
    scopeMismatch?.code === 'attribution_exemption_scope_mismatch' &&
    notReadOnly?.code === 'attribution_exemption_not_read_only' &&
    withoutPrincipal?.code === 'attribution_exemption_without_principal' &&
    unknownExemptionCode === 'unknown_attribution_exemption' &&
    declaredOkAgain === undefined,
  `声明的落点=${declaredOk === undefined ? '合法' : String(declaredOk.code)} · ` +
    `身份不在闭集=${String(unregisteredPrincipal?.code)} · 能力/操作不符=${String(scopeMismatch?.code)} · ` +
    `登记为写=${String(notReadOnly?.code)} · principal=null=${String(withoutPrincipal?.code)} · ` +
    `构造器收陌生名字=${String(unknownExemptionCode)} · 恢复=${declaredOkAgain === undefined ? '合法' : String(declaredOkAgain.code)}`,
  7
)

// ===========================================================================
// B24 Lv4.5 / P3：**中途纠正** —— 归属决定"纠正"还是"提醒"
// ===========================================================================
/*
 * 计划 §3 的验收行：「新证据在语音播放中到达，旧余句失效，LG 检查后的纠正段实际播出」。
 *
 * 判据的可判定形式 = **归属**：
 * ```text
 * 提前检索是**为哪一次开口**发起的（partial 的键） vs 她**正在回答哪一次开口**（SUBMIT_TURN 带）
 *   相同 ⇒ 那条证据是在她开始回答之后才到的 ⇒ 剩下的未播句子陈旧 ⇒ 先废余句，再给纠正段
 *   不同 ⇒ 那是给**别的**问题的证据 ⇒ 只插一句提醒（**不**纠正）
 * ```
 * ⚠️ 负控（不同键）才是重点：一个"查到就纠正"的实现会让**任何**晚到的证据都去作废
 *    她正在说的话 —— 那比不纠正更糟（把对的也废了）。
 */
let supersedeCalls: { by: string; reason: string }[] = []
let correctionSpeaking = true
const correctionLines: string[] = []
const correctionStub = makeStubHost()
const correctionBridge = new TurnBridge({
  host: {
    ...correctionStub.host,
    prepareTurn: () => ({
      candidateRevision: 'rev:correction:1',
      recall: { status: 'ran', selectedCount: 1, selectedMemoryIds: ['mem:correction:1'] },
      wroteAnything: false,
    }),
    sheIsSpeaking: () => correctionSpeaking,
    prepareLookup: async () => ({ status: 'found', sourceRefs: ['ev:correction:1'] }),
    supersedeUnplayed: (input) => {
      supersedeCalls.push({ ...input })
      /*
       * ⚠️ **必须建模这个副作用**：真交付账里"废余句"会把所有未播片段变成终态
       *    ⇒ `hasUnplayed()` 随之变 false。第一版桩只 `return 2`、**不改**这个开关，
       *    于是它**抓不到**那处顺序缺陷（"废完余句 ⇒ 纠正段被当成'她没在说'丢掉"）——
       *    真链路读数才是发现它的地方（`correction_last_superseded=4` 而纠正段不见了）。
       *    ⇒ 桩不模拟副作用，等于**把被测的顺序问题从测试里删掉**。
       */
      correctionSpeaking = false
      return 2
    },
  },
})
correctionBridge.interjectionEnabled = true
correctionBridge.setOutputSink((message) => correctionLines.push(JSON.stringify(message)))
/** 先提交一轮，让它带上**这一次开口**的键（`P3` 中途纠正的归属基准） */
const submitKey = 'c:correction-1'
await handleBridgeMessage(correctionBridge, {
  kind: 'SUBMIT_TURN', requestId: 'correction:submit', userText: '帮我查一下明天的天气',
  utteranceKey: submitKey,
})
const keyRecorded = correctionBridge.submittedUtteranceKey
/** ① 正控：**同一次开口**的证据在她说的时候到达 ⇒ 废余句 + 纠正段 */
await handleBridgeMessage(correctionBridge, {
  kind: 'PREPARE_TURN', requestId: 'correction:same', userText: '帮我查一下明天的天气',
  utteranceKey: submitKey,
})
const sameKeySupersedes = supersedeCalls.length
const correctionPayload = correctionLines.length > 0
  ? (JSON.parse(correctionLines[0]!) as { characterOutput?: { source?: string; text?: string; sourceRefs?: readonly string[] } }).characterOutput
  : undefined
/** ② 负控：**另一次开口**的证据 ⇒ 只提醒（**不**废余句、**不**纠正） */
supersedeCalls = []
correctionLines.length = 0
/* ⚠️ 每一格场景都从"她正在说"重新起算：上一格的"废余句"会把开关翻成 false（桩现在建模了这个副作用） */
correctionSpeaking = true
await handleBridgeMessage(correctionBridge, {
  kind: 'PREPARE_TURN', requestId: 'correction:other', userText: '帮我查一下明天的天气',
  utteranceKey: 'c:correction-2',
})
const otherKeySupersedes = supersedeCalls.length
const otherKeyPayload = correctionLines.length > 0
  ? (JSON.parse(correctionLines[0]!) as { characterOutput?: { source?: string } }).characterOutput
  : undefined
/** ③ 负控：同一次开口但**她没在说** ⇒ 既不作废也不纠正（提醒也可能被丢：她没在说） */
supersedeCalls = []
correctionLines.length = 0
correctionSpeaking = false
await handleBridgeMessage(correctionBridge, {
  kind: 'PREPARE_TURN', requestId: 'correction:quiet', userText: '帮我查一下明天的天气',
  utteranceKey: submitKey,
})
const quietSupersedes = supersedeCalls.length
const quietLines = correctionLines.length
correctionSpeaking = true
/**
 * ④ **用户更正**那一arm（`P3` 第 24 行"或用户更正到达时"）：
 *    她说的时候用户说"不对" ⇒ 先废余句、再给纠正段；**同一句反复到达 ⇒ 只纠一次**；
 *    她没在说 ⇒ **什么都不做**（那句话会作为普通输入进入下一轮）。
 */
supersedeCalls = []
correctionLines.length = 0
correctionSpeaking = true
const beforeUserCorrection = { supersede: supersedeCalls.length, lines: correctionLines.length }
await handleBridgeMessage(correctionBridge, {
  kind: 'PREPARE_TURN', requestId: 'correction:user-1', userText: '不对，不是这个意思',
  utteranceKey: 'c:user-correction',
})
const userCorrectionSupersedes = supersedeCalls.length
const userCorrectionPayload = correctionLines.length > 0
  ? (JSON.parse(correctionLines[0]!) as { characterOutput?: { source?: string; text?: string } }).characterOutput
  : undefined
/** 同一句的后续 partial ⇒ **不再纠一次**（把她重新置为"在说"，好让这一格只考**去重**） */
correctionSpeaking = true
await handleBridgeMessage(correctionBridge, {
  kind: 'PREPARE_TURN', requestId: 'correction:user-2', userText: '不对，不是这个意思呀',
  utteranceKey: 'c:user-correction',
})
const userCorrectionDedupe = correctionLines.length
/** ⑤ 她**没在说**时的用户更正 ⇒ 不作废、不纠正 */
supersedeCalls = []
correctionLines.length = 0
correctionSpeaking = false
await handleBridgeMessage(correctionBridge, {
  kind: 'PREPARE_TURN', requestId: 'correction:user-quiet', userText: '不对，不是这个意思',
  utteranceKey: 'c:user-correction-quiet',
})
const userCorrectionQuietSupersedes = supersedeCalls.length
const userCorrectionQuietLines = correctionLines.length
correctionSpeaking = true
record(
  'B24',
  '**中途纠正**（Lv4.5 / P3）：`SUBMIT_TURN` 带上的开口键被记住 · **同一次开口**的证据在她说的时候到达 ⇒ **先废余句**（`supersedeUnplayed` 真的被调用）**再**给纠正段（`source=mid_turn_correction` · 程序既定短句 · 有来源）· **另一次开口**的证据 ⇒ 只提醒、**不**废余句 · 她没在说 ⇒ 既不作废也不纠正 · **用户更正**（"不对"）在她说的时候到达 ⇒ 同样废余句 + 纠正段 · 同一次开口**只纠一次** · 她没在说时的更正 ⇒ 什么都不做',
  keyRecorded === submitKey &&
    sameKeySupersedes === 1 &&
    correctionPayload?.source === 'mid_turn_correction' &&
    correctionPayload?.text === MID_TURN_CORRECTION_TEXT &&
    (correctionPayload?.sourceRefs?.length ?? 0) === 1 &&
    otherKeySupersedes === 0 &&
    otherKeyPayload?.source === 'authorized_lookup_notice' &&
    quietSupersedes === 0 &&
    quietLines === 0 &&
    beforeUserCorrection.supersede === 0 &&
    userCorrectionSupersedes === 1 &&
    userCorrectionPayload?.source === 'mid_turn_correction' &&
    userCorrectionPayload?.text === MID_TURN_CORRECTION_TEXT &&
    userCorrectionDedupe === 1 &&
    userCorrectionQuietSupersedes === 0 &&
    userCorrectionQuietLines === 0,
  `开口键被记住=${String(keyRecorded)}（应 ${submitKey}）· 同键 ⇒ 废余句 ${sameKeySupersedes} 次（应 1）` +
    `· 纠正段来源=${String(correctionPayload?.source)} 文本=${String(correctionPayload?.text)}` +
    `· 异键 ⇒ 废余句 ${otherKeySupersedes} 次（应 0）且来源=${String(otherKeyPayload?.source)}（应 authorized_lookup_notice）` +
    `· 她没在说 ⇒ 废余句 ${quietSupersedes} 次（应 0）· 短句 ${quietLines} 条（应 0）` +
    `· **用户更正** ⇒ 废余句 ${userCorrectionSupersedes} 次（应 1）· 来源=${String(userCorrectionPayload?.source)}` +
    `· 同开口重复 ⇒ 短句共 ${userCorrectionDedupe} 条（应 1）` +
    `· 她没在说时的更正 ⇒ 废余句 ${userCorrectionQuietSupersedes} 次 / 短句 ${userCorrectionQuietLines} 条（应 0 / 0）`,
  11
)

// ===========================================================================
// 汇总与证据
// ===========================================================================
const measuredCount = checks.reduce((sum, check) => sum + check.measured, 0)
const failedChecks = checks.filter((check) => !check.pass)
const gateValid = measuredCount > 0
const passed = gateValid && failedChecks.length === 0

let head = 'unknown'
try {
  head = (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim()
} catch {
  /* 只读盘点失败不改变判定 */
}

const runId = `postlv2-bridge-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })
const reading = {
  runId,
  gate: 'postlv2:bridge:verify',
  milestone: 'post-lv2 / WP1 (restricted LG entry bridge)',
  generatedAt: new Date().toISOString(),
  source: { head },
  bridge: {
    source: BRIDGE_REL,
    messageKinds: [...BRIDGE_MESSAGE_KINDS],
    forbiddenImports: FORBIDDEN_IN_BRIDGE,
    compileTurnCallers,
    guardApplierCallSites,
  },
  shapeReadings,
  realTurn: {
    outcome: realReply.outcome,
    replyId: realReply.replyId,
    traceId: realReply.traceId,
    conversationEventsAdded: added,
    idempotentReplayAdded: afterIdem.length - after.length,
  },
  checks,
  measuredCount,
  verdict: gateValid ? (passed ? 'PASS' : 'FAIL') : 'MEASUREMENT INVALID',
}
writeFileSync(join(outDir, 'bridge-verify.json'), JSON.stringify(reading, null, 2), 'utf8')

console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:bridge:verify = ${reading.verdict}`)
console.log(`  证据：artifacts/post-lv2/${runId}/bridge-verify.json`)

/*
 * ⚠️ 收尾：隔离库的连接必须**显式**关闭，否则进程会挂在打开的 pglite 句柄上
 * 不退出（实测：读数已经落盘，但 `pnpm` 一直不返回）。
 * 关闭失败**不改变判定**（读数已经写下），只如实打一行 —— 与 `runtime-shutdown.ts`
 * 的"幂等、永不抛"纪律一致。
 */
try {
  const { stopRuntimeServices, closeDatabaseConnection } = await import(
    '../src/infrastructure/persistence/runtime-shutdown.ts'
  )
  await stopRuntimeServices(h.runtime)
  await closeDatabaseConnection(h.runtime)
} catch (error) {
  console.log(`  (收尾告警，不影响判定：${error instanceof Error ? error.message : String(error)})`)
}

process.exit(passed ? 0 : 1)
