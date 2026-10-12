/**
 * M3 运行环境 —— 把 `EvalRuntimeFacade` **真的实现出来**。
 *
 * ============================================================================
 *  它站在哪里
 * ============================================================================
 *      evals/m3/suites/*.ts        用例与断言（canonical 定义，唯一真相）
 *              │  只认识 EvalRuntimeFacade 与 EvalObservation
 *              ▼
 *      evals/m3/runtime/host.ts    ← 本文件：把定义接到真实角色链路上
 *              │
 *              ▼
 *      TurnGateway / ConversationRecorder / Character Kernel（既有实现，不重写）
 *
 * 这样分层的意义与 M2.5 的场景完全一致：用例换成 Promptfoo 或未来的
 * HTTP test endpoint（计划书第 50/51 节）之后仍然一个字不改。
 *
 * ---------------------------------------------------------------------------
 *  三条不能商量的实现纪律
 * ---------------------------------------------------------------------------
 * 1. **一切都在一次性副本库上**。装配前先 `resetPluginSqlConnection()`
 *    （清掉 plugin-sql 的进程级单例）再 `isolateDatabase()`；
 *    `initDatabase()` 的写保护闸还会再拦一次。真实对话库碰不到。
 *
 * 2. **"重启"是真的重启**：关掉 runtime、清掉连接单例、在**同一个数据目录**上
 *    重新装配。若只重置几个内存变量，T1（CharacterId 稳定）测的就是
 *    "内存没被清掉"，那是假证据。
 *
 * 3. **追加事件只走账本**（计划书第 79/81 节）。评测要造出"她先猜、
 *    用户再确认"这种局面时，走的是 `appendConversationEvent` 并**显式声明
 *    来源**；序号由持久层分配，评测没有权力决定它。
 */

import { AgentRuntime, stringToUuid, type Character, type Plugin } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import bootstrapPlugin from '@elizaos/plugin-bootstrap'

import { character } from '../../../src/character/index.ts'
import { initDatabase } from '../../../src/db/index.ts'
import { createRuntimeShutdown, shutdownExitCode } from '../../../src/infrastructure/persistence/runtime-shutdown.ts'
import { initKernel, type KernelHandle } from '../../../src/kernel/app/kernel.ts'
import { TurnGateway } from '../../../src/kernel/app/turn-gateway.ts'
import { ConversationRecorder } from '../../../src/infrastructure/runtime/conversation-recorder.ts'
import { characterDefinitionFromCharacter } from '../../../src/infrastructure/runtime/seed-projection.ts'
import { openAiCompatiblePlugin } from '../../../src/providers/openai-compatible.ts'
import {
  asConversationId,
  type CharacterDefinition,
  type CharacterId,
  type ConversationEvent,
  type ConversationEventId,
  type ConversationId,
  type IdentitySnapshot,
} from '../../../src/kernel/contracts/index.ts'
import {
  appendConversationEvent,
  latestConversationSequence,
  recentConversationEvents,
} from '../../../src/infrastructure/persistence/conversation-store.ts'
import { getTrace } from '../../../src/infrastructure/persistence/trace-store.ts'
import { createTelemetry, readTelemetryConfig } from '../../../src/infrastructure/telemetry/index.ts'
import { TelemetryRecorder } from '../../../src/infrastructure/telemetry/recorder.ts'
import {
  cleanupSandbox,
  isolateDatabase,
  resetPluginSqlConnection,
} from '../../../src/dev/sandbox.ts'

import type { EvalObservation, EvalRuntimeFacade } from '../types.ts'
import {
  M3_RUNTIME_PORT,
  type CharacterModelInvoker,
  type M3RuntimePort,
} from './ports.ts'

// ---------------------------------------------------------------------------
// 观测构造
// ---------------------------------------------------------------------------

/**
 * Trace 读取的**兼容层**。
 *
 * M3 的 Trace 会带 `seedVersion` / `seedHash` / `identitySourceRefs`，
 * 但 WP8 之前的 trace 行没有这些字段。评测不能因此炸掉，
 * 也不能假装它们有值 —— 于是这里**如实返回 undefined**，
 * 由检查去判定"这一轮的 Trace 里有没有身份信息"（那本身就是 T3 的考点）。
 */
async function readTraceFields(
  kernel: KernelHandle,
  traceId: string
): Promise<EvalObservation['trace']> {
  const trace = await getTrace(kernel.stores.db, traceId as never)
  if (!trace) {
    return {
      traceId,
      compilerVersion: 'missing',
      sectionIds: [],
      droppedSectionIds: [],
      identitySourceRefs: [],
    }
  }
  return {
    traceId,
    compilerVersion: trace.contextCompilerVersion ?? 'unknown',
    sectionIds: trace.contextSectionIds,
    droppedSectionIds: trace.droppedSectionIds,
    identitySourceRefs: trace.identitySourceRefs ?? [],
    ...(trace.seedVersion === undefined ? {} : { seedVersion: trace.seedVersion }),
    ...(trace.seedHash === undefined ? {} : { seedHash: trace.seedHash }),
    ...(trace.outputEventId === undefined ? {} : { outputEventId: String(trace.outputEventId) }),
  }
}

/**
 * 取当前身份快照。
 *
 * ⚠️ M3（WP3）之后**不再**由评测自己算 hash：
 * `KernelHandle.identitySnapshot` 是 `CharacterIdentityService` 的产出，
 * 它内部会重新计算 hash 并与库里记录比对（`seed_hash_mismatch`）。
 * 评测自己再算一遍只会多出第二份"什么算身份"的定义 —— 那正是
 * 「单一真源」要避免的事（计划书第 127 节）。
 */
export function currentIdentitySnapshot(kernel: KernelHandle): IdentitySnapshot {
  return kernel.identitySnapshot
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export interface M3Host {
  facade: EvalRuntimeFacade
  /** 跑完一个用例后的兜底：删掉一次性数据库目录 */
  dispose(): Promise<void>
}

/**
 * 建一个 M3 运行环境。
 *
 * `displayName` 用于匿名模式（计划书第 66 节）：换显示名，**Seed 一字不改**。
 * 必须在第一轮之前生效，否则第一轮就已经带着真名进去了。
 */
export async function createM3Host(
  label: string,
  options: {
    displayName?: string
    /**
     * **角色自己**的模型调用口。
     *
     * 不传 = 离线（echo）模式：`sayOnce()` 返回合成的机器可读串，
     * 那对**结构性检查**是合适的（它们要看的是"她看到了什么"），
     * 对**人格检查**毫无意义（judge 会诚实地说"回答没有任何实际内容"）。
     *
     * 传了 = 真实模型模式：她真的说话，judge 评的是她的话。
     */
    invokeCharacterModel?: CharacterModelInvoker
  } = {}
): Promise<M3Host> {
  const state = await assemble(`m3-${label}`)
  if (options.displayName) renameDisplayName(state, options.displayName)
  state.invokeCharacterModel = options.invokeCharacterModel

  const port: M3RuntimePort = {
    append: (input) => appendNamedOperation(state, input),
    ledgerWatermark: () => latestCharacterSequence(state),
  }
  attachPort(state, port)

  /**
   * 评测的**扩展面**必须能被装置与检查同时拿到。
   *
   * 通道就是类型里已有的 `attributes`（自由元数据）：
   *   · 装置：`portFrom(facade)`
   *   · 检查：`runtimePortOf(observation)`（引擎在建立观测时把它带过去）
   * 这样 `EvalRuntimeFacade` 一个方法都不用加。
   */
  const attributes: Record<string, unknown> = {
    [M3_RUNTIME_PORT]: port,
  }
  state.portHost = attributes

  const facade: EvalRuntimeFacade = {
    async say(text: string): Promise<EvalObservation> {
      return sayOnce(state, text)
    },
    async identity(): Promise<IdentitySnapshot> {
      return currentIdentitySnapshot(state.kernel)
    },
    conversationId: () => String(state.conversationId),
    characterId: () => String(state.kernel.characterId),
    async ledger(limit?: number): Promise<ConversationEvent[]> {
      return recentConversationEvents(state.kernel.stores.db, {
        characterId: state.kernel.characterId,
        limit: limit ?? 5000,
      })
    },
    async openNewConversation(): Promise<string> {
      state.conversationIndex += 1
      state.conversationId = conversationIdFor(state.kernel, state.conversationIndex)
      rebindConversation(state)
      return String(state.conversationId)
    },
    async seedVersions(): Promise<{ seedVersion: number; seedHash: string }[]> {
      // 走身份服务（WP3）而不是直接读表：这样"Seed 历史是什么"只有一处定义
      const records = await state.kernel.identity.listSeedVersions()
      return records.map((r) => ({ seedVersion: r.seedVersion, seedHash: r.seedHash }))
    },
    async applySeedVersion(input: {
      seedVersion: number
      author: string
      reason: string
      mutate?: (draft: unknown) => unknown
    }): Promise<{ seedVersion: number; seedHash: string }> {
      // 装置拿到的**只有** `EvalRuntimeFacade`，它是普通聊天路径。
      // 改 Seed 必须走 `SeedAdminPath`（kernel.seedAdmin）—— 这正是
      // 计划书第 19/77 节的"显式管理路径"，评测装置扮演的是管理员，
      // 而她自己（对话路径）永远拿不到它。
      const current = state.kernel.identitySnapshot.definition
      const draft = input.mutate
        ? (input.mutate(structuredClone(current)) as CharacterDefinition)
        : current
      const next: CharacterDefinition = { ...draft, seedVersion: input.seedVersion }

      const result = await state.kernel.seedAdmin.apply(next, {
        author: input.author,
        reason: input.reason,
      })

      // 换 Seed 是**管理路径**：运行环境必须跟着换，否则后续几轮还在用旧定义
      // 编译上下文 —— 那样评测就在测一个不存在的角色。
      const snapshot = await state.kernel.identity.buildIdentitySnapshot()
      state.kernel.identitySnapshot = snapshot
      state.kernel.definition = snapshot.definition
      rebindConversation(state)

      return { seedVersion: result.seedVersion, seedHash: result.seedHash }
    },
    async restart(): Promise<void> {
      await restartOnSameDir(state)
    },
    attributes,
  }

  return {
    facade,
    dispose: async () => {
      await closeHostRuntime(state)
      if (state.dataDir) cleanupSandbox(state.dataDir)
    },
  }
}

// ---------------------------------------------------------------------------
// 内部状态
// ---------------------------------------------------------------------------

interface HostState {
  runtime: AgentRuntime
  kernel: KernelHandle
  conversationId: ConversationId
  conversationIndex: number
  recorder: ConversationRecorder
  gateway: TurnGateway
  telemetry: TelemetryRecorder
  userId: string
  dataDir: string | undefined
  displayName: string
  /** 会话内下一个序号（每次写之前从库里刷新，因此重启后不会撞号） */
  nextSequence: number
  /** 由账本预分配的"本轮助手序号" */
  assistantSequence: number | undefined
  port: M3RuntimePort
  /** 挂到 facade.attributes 上的那份自由字典（重启不需要换，port 是稳定的） */
  portHost: Record<string, unknown> | undefined
  /**
   * 角色自己的模型调用口（undefined = 离线 echo 模式）。
   *
   * 它决定 `sayOnce()` 产出的"回复"是**她会说出口的话**，
   * 还是**引擎合成的机器可读串**。这个区别决定了人格评测有没有意义。
   */
  invokeCharacterModel: CharacterModelInvoker | undefined
  /** 本用例里她的回复是否来自真实模型（进观测，供报告与检查区分） */
  repliedByModel: boolean
}

function attachPort(state: HostState, port: M3RuntimePort): void {
  state.port = port
}

/** 每个会话一个稳定的会话 id（同用户 + 同角色，只是编号不同） */
function conversationIdFor(kernel: KernelHandle, index: number): ConversationId {
  return asConversationId(`dm-m3-${kernel.definition.slug}-${index}`)
}

/**
 * 装配一台运行环境。
 *
 * ⚠️ 前两步的顺序不能反（`src/dev/sandbox.ts` 里记着这次事故）：
 *   1. `resetPluginSqlConnection()` —— 关掉**上一个**库的进程级单例
 *   2. `isolateDatabase()`         —— 为本次运行指定新的数据目录
 * 少第 1 步，第二次装配会读到上一次的库，而且失败方式是"看起来在正常工作"。
 */
async function assemble(label: string, runId?: string): Promise<HostState> {
  await resetPluginSqlConnection()
  const sandbox = isolateDatabase(label, {
    ...(runId ? { runId, keep: true } : {}),
  })

  const userId = stringToUuid('user-Alex')
  const runtime = new AgentRuntime({
    character: character as Character,
    plugins: [
      bootstrapPlugin,
      openAiCompatiblePlugin,
    ] as Plugin[],
    conversationLength: 16,
    settings: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
      OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
      OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
    },
  })

  await initDatabase(runtime, sqlPlugin)
  await runtime.initialize()
  const kernel = await initKernel(runtime, {
    definition: characterDefinitionFromCharacter(character),
  })

  const telemetry = new TelemetryRecorder(
    createTelemetry({
      ...readTelemetryConfig({} as NodeJS.ProcessEnv),
      // 评测不导出遥测：Phoenix 离线不该影响人格评测（计划书第 49/149 节）
      enabled: false,
      adapter: 'noop',
      endpoint: '',
      timeoutMs: 1,
      sessionId: label,
    })
  )

  const state: HostState = {
    runtime,
    kernel,
    conversationId: conversationIdFor(kernel, 1),
    conversationIndex: 1,
    recorder: undefined as unknown as ConversationRecorder,
    gateway: undefined as unknown as TurnGateway,
    telemetry,
    userId,
    dataDir: sandbox.dir,
    displayName: character.name,
    nextSequence: 1,
    assistantSequence: undefined,
    port: undefined as unknown as M3RuntimePort,
  invokeCharacterModel: undefined,
  repliedByModel: false,
    portHost: undefined,
  }
  rebindConversation(state)
  return state
}

/**
 * 用当前的 (kernel, conversationId, definition) 重建 recorder + gateway。
 *
 * 四种情况都要重建：换会话（T2）、换 Seed（T14/T15）、重启（T1）、换显示名（T12）。
 * 每次重建都从库里续上会话内序号 —— 这正是"重启后接着聊"该有的行为。
 */
function rebindConversation(state: HostState): void {
  state.recorder = new ConversationRecorder({
    db: state.kernel.stores.db,
    characterId: state.kernel.characterId,
    conversationId: state.conversationId,
    dryRun: false,
    userName: 'Alex',
    characterName: state.displayName,
    // WP3 起这个选项叫 transport（`source` 已被 sourceKind 占用）
    transport: 'm3-eval',
    userId: state.userId,
  })

  state.gateway = new TurnGateway({
    kernel: state.kernel,
    definition: state.kernel.definition,
    // M3（WP3/WP7）：一轮一次的身份快照由装配层传入 —— 网关自己不读 Seed，
    // 否则"这一轮用的是哪一版人格"就会有两个答案。
    identity: currentIdentitySnapshot(state.kernel),
    recorder: state.recorder,
    conversationSequence: () => state.nextSequence,
    recentLimit: 16,
    telemetry: state.telemetry,
    modelProfile: 'echo',
  })
}

// ---------------------------------------------------------------------------
// 真·重启
// ---------------------------------------------------------------------------

async function restartOnSameDir(state: HostState): Promise<void> {
  const dir = state.dataDir
  if (!dir) throw new Error('这台运行环境没有独立数据目录，拒绝执行"重启"')

  await closeHostRuntime(state)

  // 同一台运行环境原地重开：runId 复用原目录名，因此打开的是**同一个库**
  const revived = await assemble('m3-restart', basenameOf(dir))
  state.runtime = revived.runtime
  state.kernel = revived.kernel
  state.telemetry = revived.telemetry
  state.dataDir = dir // 保住原目录，dispose 时才删得掉
  rebindConversation(state)
}

async function closeHostRuntime(state: HostState): Promise<void> {
  const reading = await createRuntimeShutdown(state.runtime).shutdown()
  if (shutdownExitCode(reading) !== 0) throw new Error(`m3_host_close_not_verified: ${reading.note}`)
}

// ---------------------------------------------------------------------------
// 一轮对话
// ---------------------------------------------------------------------------

async function sayOnce(state: HostState, text: string): Promise<EvalObservation> {
  const started = Date.now()
  const before = await latestCharacterSequence(state)
  state.nextSequence = (await latestConversationSequence(
    state.kernel.stores.db,
    state.kernel.characterId,
    state.conversationId
  )) + 1

  const turn = await state.gateway.beginTurn(text)
  state.assistantSequence = turn.assistantSequence

  // ⚠️ 这里刻意**不**调用模型：echo 模式的回复必须确定性，
  // 离线路径上出现任何模型调用都会让"秒级完成"这个前提失效。
  const { renderCriticalStateSection, recentContextLinesFrom } = await import(
    '../../../src/infrastructure/runtime/adapters.ts'
  )

  const stateSection = await renderCriticalStateSection(
    state.runtime,
    String(state.kernel.characterId),
    state.userId
  )
  const recentLines = await recentContextLinesFrom(state.runtime, {
    characterId: state.kernel.characterId,
    userName: 'Alex',
    characterName: state.displayName,
    limit: 20,
  })

  const packet = await state.gateway.compileTurn({
    turn,
    currentInput: text,
    recentLines,
    stateSection,
  })

  // echo 模式：确定性回显"她看到了什么"。
  // 格式与 M2.5 的 `echoReply` 同思路（机器可读），因此上下文内容可以被断言。
  const echoReply = `<m3-echo compiler=${packet.compilerVersion} sections=${packet.sections
    .map((s) => s.id)
    .join('+')} dropped=${packet.droppedSectionIds.length}>`

  /*
   * ⚠️ 这里是她**真的说话**与"回显她看到了什么"的分岔点。
   *
   * 实测踩到过的严重缺陷：第一版在**任何**模式下都返回上面那个合成串。
   * 于是 live 档把合成串交给 judge，judge 给出 0.05 并说明
   * "回答只有一段系统编译标记，没有任何实际内容" —— 它是诚实的，
   * 而报告里那个 0.05 看起来像"她价值取向不对"这个真实结论。
   *
   * 人格评测的全部意义就在这一步：她要真的说话，judge 才有东西可评。
   *
   * 提示词走 `state.gateway.promptFor(packet)` —— 与主链路**同一个函数**。
   * 自己再拼一遍 prompt 就等于把"上下文单入口"（铁律 11）在评测里破掉：
   * 那时评测测的就不是她真正看到的上下文了。
   */
  let reply: string
  if (state.invokeCharacterModel) {
    const call = await state.invokeCharacterModel(state.gateway.promptFor(packet))
    reply = call.raw.trim()
    state.repliedByModel = true
    if (reply === '') {
      // 空回复不能进账本（`createConversationEvent` 会拒绝空正文），
      // 而且它会让 judge 去评一个空串。用显式占位而不是静默丢弃。
      reply = '（本轮模型返回了空文本）'
    }
  } else {
    reply = echoReply
  }

  const outgoing = await state.gateway.completeTurn({ turn, replyText: reply })
  void outgoing

  const after = await latestCharacterSequence(state)
  const newEvents = await eventsInRange(state, before + 1, after)

  return {
    caseId: '',
    reply,
    identity: currentIdentitySnapshot(state.kernel),
    trace: await readTraceFields(state.kernel, String(turn.traceId)),
    newEvents,
    conversationSequence: turn.conversationSequence,
    attributes: { [M3_RUNTIME_PORT]: state.port },
    durationMs: Date.now() - started,
  }
}

// ---------------------------------------------------------------------------
// 具名操作（T6/T7/T8 的装置）
// ---------------------------------------------------------------------------

/**
 * 以具名操作往账本追加一条事件。
 *
 * 这是评测唯一"能主动写事实"的地方，因此它刻意保守：序号由持久层分配、
 * `actorType` 由 `kind` 决定、`sourceKind` 由 actorType 推导。
 * 评测因此**写不出**来源错误的事件。
 */
async function appendNamedOperation(
  state: HostState,
  input: {
    kind: 'user' | 'character' | 'system' | 'tool'
    content: string
    replyToEventId?: string
    source?: string
  }
): Promise<EvalObservation> {
  const before = await latestCharacterSequence(state)
  const conversationSequence = (await latestConversationSequence(
    state.kernel.stores.db,
    state.kernel.characterId,
    state.conversationId
  )) + 1

  const actorId =
    input.kind === 'character'
      ? String(state.kernel.characterId)
      : input.kind === 'system'
        ? (input.source ?? 'system')
        : input.kind === 'tool'
          ? (input.source ?? 'tool')
          : state.userId

  // 用户确认（T6）的关键：回复一条 **character_output** 时，
  // 权威等级会被提升为 USER_REPLY_CONFIRMATION（计划书第 33 节）。
  // 这里把"被回复的事件的来源类别"显式告诉账本 —— 因为记账口不接受猜测。
  const repliedToSourceKind =
    input.kind === 'user' && input.replyToEventId ? ('character_output' as const) : undefined

  const type =
    input.kind === 'user'
      ? 'user_message'
      : input.kind === 'character'
        ? 'assistant_message'
        : input.kind === 'tool'
          ? 'tool_event'
          : 'system_event'

  await appendConversationEvent(state.kernel.stores.db, {
    characterId: state.kernel.characterId,
    conversationId: state.conversationId,
    conversationSequence,
    type,
    actorType: input.kind,
    actorId,
    content: input.content,
    ...(input.replyToEventId
      ? { replyToEventId: input.replyToEventId as ConversationEventId }
      : {}),
    ...(repliedToSourceKind ? { repliedToSourceKind } : {}),
    metadata: { source: 'm3-eval-append' },
  })

  const after = await latestCharacterSequence(state)
  const newEvents = await eventsInRange(state, before + 1, after)

  return {
    caseId: '',
    reply: input.content,
    identity: currentIdentitySnapshot(state.kernel),
    trace: {
      traceId: 'append-only',
      compilerVersion: 'not-applicable',
      sectionIds: [],
      droppedSectionIds: [],
      identitySourceRefs: [],
    },
    newEvents,
    conversationSequence,
    attributes: { [M3_RUNTIME_PORT]: state.port },
    durationMs: 0,
  }
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

async function latestCharacterSequence(state: HostState): Promise<number> {
  const events = await recentConversationEvents(state.kernel.stores.db, {
    characterId: state.kernel.characterId,
    limit: 1,
  })
  return events.length > 0 ? events[events.length - 1].sequence : 0
}

async function eventsInRange(
  state: HostState,
  fromSequence: number,
  toSequence: number
): Promise<ConversationEvent[]> {
  if (toSequence < fromSequence) return []
  const events = await recentConversationEvents(state.kernel.stores.db, {
    characterId: state.kernel.characterId,
    limit: 5000,
  })
  return events.filter((e) => e.sequence >= fromSequence && e.sequence <= toSequence)
}

/** 把显示名换成匿名（计划书第 66 节）：只改名字，Seed 一个字节都不动 */
function renameDisplayName(state: HostState, displayName: string): void {
  state.displayName = displayName
  rebindConversation(state)
}

/** 目录名（用于把沙箱目录原样复用给 `isolateDatabase` 的 runId） */
function basenameOf(dir: string): string {
  const parts = dir.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? 'restart'
}
