/**
 * Internal Scenario Harness —— M2.5 的行为回归执行器。
 *
 * ============================================================================
 *  plan 第 54 节：Canonical 定义在内部，Promptfoo 只是 Runner 之一
 * ============================================================================
 * 场景以**我们自己的 schema** 定义（`evals/scenarios/*.ts`），
 * 因此它既能被这里的内部 runner 跑，也能被 Promptfoo 跑
 * （`evals/promptfoo/build-config.ts` 把同一份定义翻成 YAML）。
 *
 * ⚠️ 绝不把测试数据写死在 Promptfoo 的 YAML 里 —— 那样
 * "场景是什么"就变成了某个外部工具的配置文件，换工具就得重写。
 *
 * 模型调用有三种模式（由 `--model` 选择）：
 *   · echo（默认）：deterministic，不联网。断言的是**上下文与链路**，
 *     不是"她答得好不好"。CI 用这个。
 *   · real：调真实模型，断言的是行为回归。需要 API Key，人工/主分支用。
 *
 * 安全：全部在一次性副本库上跑（`isolateDatabase`），真实对话库绝不被碰。
 */

import { createThinHostRuntime } from '../../src/infrastructure/runtime/thin-host-factory.ts'
import { stringToUuid } from '../../src/kernel/contracts/uuid.ts'
import type { Character } from '../../src/infrastructure/runtime/eliza-types.ts'

import { character } from '../../src/character/index.ts'
import { initDatabase } from '../../src/db/index.ts'
import { initCharacterState } from '../../src/state/init.ts'
import {
  createPersistentCharacterPlugin,
} from '../../src/plugin/persistent-character.ts'
import { openAiCompatiblePlugin } from '../../src/providers/openai-compatible.ts'
import type { AgentRuntime } from '../../src/infrastructure/runtime/eliza-types.ts'

import { initKernel, type KernelHandle } from '../../src/kernel/app/kernel.ts'
import { TurnGateway } from '../../src/kernel/app/turn-gateway.ts'
import { ConversationRecorder } from '../../src/infrastructure/runtime/conversation-recorder.ts'
import {
  callModelText,
  recentContextLinesFrom,
  renderCriticalStateSection,
} from '../../src/infrastructure/runtime/adapters.ts'
import {
  latestConversationSequence,
  recentConversationEvents,
} from '../../src/infrastructure/persistence/conversation-store.ts'
import {
  domainEventsFor,
  projectionRevisions,
  rebuildProjection,
} from '../../src/infrastructure/persistence/event-store.ts'
import { countTraces } from '../../src/infrastructure/persistence/trace-store.ts'
import {
  asConversationId,
  type CharacterId,
  type ConversationEvent,
  type ConversationId,
  type DomainEvent,
} from '../../src/kernel/contracts/index.ts'
import {
  createTelemetry,
  readTelemetryConfig,
  type TelemetryConfig,
} from '../../src/infrastructure/telemetry/index.ts'
import { TelemetryRecorder } from '../../src/infrastructure/telemetry/recorder.ts'
import { runDiagnosticProcessor } from '../../src/kernel/app/turn-gateway.ts'
import { characterDefinitionFromCharacter } from '../../src/infrastructure/runtime/seed-projection.ts'

import type { ContextPacket } from '../../src/kernel/contracts/index.ts'
import { assertInvariants, type InvariantViolation, type ScenarioRun } from './invariants.ts'

// ---------------------------------------------------------------------------
// 场景定义
// ---------------------------------------------------------------------------

/**
 * 场景 schema（plan 第 55 节）。
 *
 * `assertions` 拿到的是**原始记录**，因此断言可以任意深入
 * （看某一句 prompt、看投影版本、看 trace），而不需要 harness 预先
 * 暴露一堆便利字段。
 */
export interface Scenario {
  id: string
  description: string
  /** 初始状态：目前只需要说明它是不是"全新角色" */
  initial_state: { freshCharacter: boolean }
  /** 预设对话（跑在断言前，用于制造"已经聊了很久"的处境） */
  presetTurns?: string[]
  /** 本次真正要观察的轮次 */
  turns: string[]
  assertions: Assertion[]
  tags: string[]
  version: number
}

export interface Assertion {
  id: string
  description: string
  check: (run: ScenarioRun, ctx: HarnessContext) => Promise<void> | void
}

export class ScenarioFailure extends Error {
  readonly scenarioId: string
  readonly assertionId: string
  readonly detail: string
  constructor(scenarioId: string, assertionId: string, detail: string) {
    super(`[${scenarioId}] ${assertionId} 失败：${detail}`)
    this.name = 'ScenarioFailure'
    this.scenarioId = scenarioId
    this.assertionId = assertionId
    this.detail = detail
  }
}

export class InvariantFailure extends Error {
  readonly scenarioId: string
  readonly violations: InvariantViolation[]
  constructor(scenarioId: string, violations: InvariantViolation[]) {
    super(
      `[${scenarioId}] 跨场景不变量被破坏：\n` +
        violations.map((v) => `  · [${v.code}] ${v.message}`).join('\n')
    )
    this.name = 'InvariantFailure'
    this.scenarioId = scenarioId
    this.violations = violations
  }
}

// ---------------------------------------------------------------------------
// Harness 上下文
// ---------------------------------------------------------------------------

export interface HarnessContext {
  scenarioId: string
  kernel: KernelHandle
  agent: ScriptedAgent
  characterId: CharacterId
  conversationId: ConversationId
}

export type ModelMode = 'echo' | 'real'

export interface RunScenarioOptions {
  modelMode?: ModelMode
  /** 需要跨进程/跨"重启"复用的数据目录（SC-001 的持久化验证用） */
  dataDir?: string
  /** 自定义遥测配置（SC-007 用） */
  telemetryConfig?: Partial<TelemetryConfig>
  /** 人为注入的故障（如让某轮模型调用抛错） */
  failModelOnTurn?: number
}

// ---------------------------------------------------------------------------
// 脚本化 Agent
// ---------------------------------------------------------------------------

export interface CapturedTurn {
  input: string
  packet: ContextPacket
  prompt: string
  reply: string
  userEvent?: ConversationEvent
  assistantEvent?: ConversationEvent
  /** 这一轮调用 useModel 的耗时（real 模式下有值） */
  modelDurationMs: number
}

export class ScriptedAgent {
  readonly captured: CapturedTurn[] = []
  readonly conversationEvents: ConversationEvent[] = []
  /** 每轮结束时的投影 revision */
  readonly revisionHistory: number[] = []

  private readonly gateway: TurnGateway
  private readonly kernel: KernelHandle
  private readonly runtime: AgentRuntime
  private readonly modelMode: ModelMode
  private readonly recorder: ConversationRecorder
  private readonly conversationId: ConversationId
  private readonly telemetry: TelemetryRecorder
  private nextSequence = 1
  private failOnTurn: number | undefined
  private turnCounter = 0
  /** 状态按「角色 × 用户」维度存，因此渲染状态需要用户 id */
  readonly userId: string
  /** 本次运行独占的数据目录（用于"重启后还在吗"这类验证） */
  readonly dataDir: string | undefined

  constructor(options: {
    runtime: AgentRuntime
    kernel: KernelHandle
    recorder: ConversationRecorder
    gateway: TurnGateway
    conversationId: ConversationId
    modelMode: ModelMode
    telemetry: TelemetryRecorder
    userId: string
    dataDir?: string
  }) {
    this.runtime = options.runtime
    this.kernel = options.kernel
    this.recorder = options.recorder
    this.gateway = options.gateway
    this.conversationId = options.conversationId
    this.modelMode = options.modelMode
    this.telemetry = options.telemetry
    this.userId = options.userId
    this.dataDir = options.dataDir
  }

  /** 下一个会话内序号（gateway 的 conversationSequence 回调用它） */
  nextSequenceValue(): number {
    return this.nextSequence
  }

  get telemetryRecorder(): TelemetryRecorder {
    return this.telemetry
  }

  setFailOnTurn(turn: number | undefined): void {
    this.failOnTurn = turn
  }

  /** 从数据库续上会话内序号（模拟"重启后继续"） */
  async resumeSequence(): Promise<number> {
    const last = await latestConversationSequence(
      this.kernel.stores.db,
      this.kernel.characterId,
      this.conversationId
    )
    this.nextSequence = last + 1
    return this.nextSequence
  }

  async say(text: string): Promise<CapturedTurn> {
    this.turnCounter += 1
    const shouldFail = this.failOnTurn === this.turnCounter

    const turn = await this.gateway.beginTurn(text)
    this.nextSequence = turn.conversationSequence + 2

    const stateSection = await renderCriticalStateSection(
      this.runtime,
      String(this.kernel.characterId),
      this.userId
    )
    const recentLines = await recentContextLinesFrom(this.runtime, {
      characterId: this.kernel.characterId,
      userName: 'Alex',
      characterName: character.name,
      limit: 20,
    })

    const packet = await this.gateway.compileTurn({
      turn,
      currentInput: text,
      recentLines,
      stateSection,
    })
    const prompt = this.gateway.promptFor(packet)

    let reply: string
    let modelDurationMs = 0
    try {
      if (shouldFail) {
        throw new Error('注入故障：模型调用失败')
      }
      if (this.modelMode === 'real') {
        const call = await callModelText(this.runtime, prompt)
        reply = call.text
        modelDurationMs = call.durationMs
      } else {
        // echo 模式：确定性回显"我看到了什么"。
        // 它让断言可以检查 Context 的内容，而不依赖模型措辞。
        reply = echoReply(packet)
      }
    } catch (error) {
      await this.gateway.failTurn(turn, error)
      throw error
    }

    const outgoing = await this.gateway.completeTurn({
      turn,
      replyText: reply,
      modelDurationMs,
    })

    if (turn.userEvent) this.conversationEvents.push(turn.userEvent)
    if (outgoing.assistantEvent) this.conversationEvents.push(outgoing.assistantEvent)

    const revisions = await projectionRevisions(
      this.kernel.stores.db,
      this.kernel.characterId
    )
    this.revisionHistory.push(
      Object.values(revisions).reduce((max, value) => Math.max(max, value), 0)
    )

    const captured: CapturedTurn = {
      input: text,
      packet,
      prompt,
      reply,
      userEvent: turn.userEvent,
      assistantEvent: outgoing.assistantEvent,
      modelDurationMs,
    }
    this.captured.push(captured)
    return captured
  }

  /**
   * 把"记录"整理成断言读得懂的结构。
   *
   * ⚠️ 对话事件与领域事件**都必须从数据库读**，不能用内存里累积的那份：
   * 只读内存会导致"跨场景不变量"拿库里全量的领域事件去比对
   * 本次运行才有的事件列表，从而把正常的旧事件当成"来源不存在"。
   * 从同一个持久层读两边，才能做真正一致的溯源检查。
   */
  async buildRun(scenarioId: string, durationMs: number): Promise<ScenarioRun> {
    const conversationEvents = await recentConversationEvents(this.kernel.stores.db, {
      characterId: this.kernel.characterId,
      conversationId: this.conversationId,
      limit: 5000,
    })
    const domainEvents: DomainEvent[] = await domainEventsFor(
      this.kernel.stores.db,
      this.kernel.characterId
    )
    return {
      scenarioId,
      characterId: this.kernel.characterId,
      prompts: this.captured.map((c) => c.prompt),
      packets: this.captured.map((c) => c.packet),
      conversationEvents,
      domainEvents,
      replies: this.captured.map((c) => c.reply),
      projectionRevisions: this.revisionHistory,
      injectedFailures: [],
      durationMs,
    }
  }
}

/**
 * echo 模式下的确定性回复。
 *
 * 它把"这一轮她看到了什么"编码进回复里，于是断言可以检查
 * "Seed 在里面吗""被裁掉了哪些 section"这些问题，
 * 完全不需要调用模型。格式刻意保持机器可读。
 */
export function echoReply(packet: ContextPacket): string {
  const sections = packet.sections.map((s) => s.id).join('+')
  return `<m2.5-echo compiler=${packet.compilerVersion} sections=${sections} dropped=${packet.droppedSectionIds.length}>`
}

// ---------------------------------------------------------------------------
// 运行一个场景
// ---------------------------------------------------------------------------

export async function runScenario(
  scenario: Scenario,
  options: RunScenarioOptions = {}
): Promise<{ run: ScenarioRun; agent: ScriptedAgent; kernel: KernelHandle }> {
  const started = Date.now()
  const { agent, kernel, conversationId } = await bootHarness(scenario.id, options)

  // 预设轮次：制造"已经聊了很久"的处境（SC-001 的 100 轮就靠它）
  for (const text of scenario.presetTurns ?? []) {
    await agent.say(text)
  }

  const beforeTurns = agent.captured.length
  for (const text of scenario.turns) {
    await agent.say(text)
  }

  // 只保留"本次真正要观察"的轮次？不 —— 保持全量，
  // 但把预设轮次的数量交给断言（ctx 里能算出来）。
  const run = await agent.buildRun(scenario.id, Date.now() - started)
  run.prompts = run.prompts.slice(beforeTurns)
  run.packets = run.packets.slice(beforeTurns)
  run.replies = run.replies.slice(beforeTurns)

  const context: HarnessContext = {
    scenarioId: scenario.id,
    kernel,
    agent,
    characterId: kernel.characterId,
    conversationId,
  }

  // --- 跨场景不变量（无条件检查）------------------------------------------
  const fullRun = await agent.buildRun(scenario.id, Date.now() - started)
  const violations = assertInvariants(fullRun)
  if (violations.length > 0) {
    throw new InvariantFailure(scenario.id, violations)
  }

  // --- 场景自己的断言 -----------------------------------------------------
  for (const assertion of scenario.assertions) {
    try {
      await assertion.check(run, context)
    } catch (error) {
      if (error instanceof ScenarioFailure) throw error
      throw new ScenarioFailure(
        scenario.id,
        assertion.id,
        error instanceof Error ? `${error.message}` : String(error)
      )
    }
  }

  return { run, agent, kernel }
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

export async function bootHarness(
  label: string,
  options: RunScenarioOptions = {}
): Promise<{ agent: ScriptedAgent; kernel: KernelHandle; conversationId: ConversationId }> {
  const { isolateDatabase, resetPluginSqlConnection } = await import('../../src/dev/sandbox.ts')

  // ⚠️ 顺序不能反：
  //   1. reset —— 清掉**上一个场景**留在 globalThis 上的 PGlite 单例
  //      （plugin-sql 把客户端缓存成进程级单例，不清就会继续读旧库）
  //   2. isolate —— 为本次运行指定新的数据目录
  // 少了第 1 步，SC-002 会读到 SC-001 的对话事件（实测：2 轮读到 86 条事件）。
  await resetPluginSqlConnection()
  const sandbox = isolateDatabase(
    `harness-${label}`,
    options.dataDir ? { runId: options.dataDir, keep: true } : {}
  )

  const userId = stringToUuid('user-Alex')
  const runtime = createThinHostRuntime({
    character: character,
    conversationLength: 16,
    settings: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
      OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
      OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
    },
  })

  await initDatabase(runtime)
  await runtime.initialize()
  const kernel = await initKernel(runtime, { definition: characterDefinitionFromCharacter(character) })

  const conversationId = asConversationId(
    `dm-${kernel.definition.slug}-${stringToUuid('user-Alex').slice(0, 8)}`
  )

  const recorder = new ConversationRecorder({
    db: kernel.stores.db,
    characterId: kernel.characterId,
    conversationId,
    dryRun: false,
    userName: 'Alex',
    characterName: character.name,
    transport: 'harness',
  })

  const telemetryConfig: TelemetryConfig = {
    ...readTelemetryConfig({} as NodeJS.ProcessEnv),
    enabled: true,
    adapter: 'phoenix',
    endpoint: 'http://127.0.0.1:1',
    timeoutMs: 200,
    sessionId: `harness-${label}`,
    ...options.telemetryConfig,
  }
  const telemetry = new TelemetryRecorder(createTelemetry(telemetryConfig))

  // agent 必须先构造（gateway 的回调要读它的序号），因此这里用 let + 后置赋值
  let agent!: ScriptedAgent

  const gateway = new TurnGateway({
    kernel,
    definition: kernel.definition,
    // M3 WP3：身份来自快照（一轮一次），网关自己不读 Seed
    identity: kernel.identitySnapshot,
    recorder,
    // 每次 beginTurn 都取 agent 自己的下一个序号：harness 与 CLI 走同一条路径
    conversationSequence: () => agent.nextSequenceValue(),
    recentLimit: 16,
    telemetry,
  })

  agent = new ScriptedAgent({
    runtime,
    kernel,
    recorder,
    gateway,
    conversationId,
    modelMode: options.modelMode ?? 'echo',
    telemetry,
    userId,
    dataDir: sandbox.dir,
  })
  await agent.resumeSequence()
  if (options.failModelOnTurn !== undefined) agent.setFailOnTurn(options.failModelOnTurn)

  return { agent, kernel, conversationId }
}

// ---------------------------------------------------------------------------
// 便捷工具（场景断言常用）
// ---------------------------------------------------------------------------

/** 某轮上下文里是否包含某个 section */
export function hasSection(packet: ContextPacket, id: string): boolean {
  return packet.sections.some((s) => s.id === id)
}

/**
 * 身份 section 的所有合法 id。
 *
 * M3 起身份锚点的 id 从 `seed-identity` 改为 `identity-core`
 * （v2 编译器），而 v1 编译器仍会产出 `seed-identity`。
 * 断言要检的是"**人格锚点必须在**"，而不是"必须叫那个名字" ——
 * 所以这两个 id 在这里被当作同一个语义。
 */
export const IDENTITY_SECTION_IDS = ['identity-core', 'seed-identity'] as const

/** 取某轮的身份 section（M3 与 M2.5 的 id 都认） */
export function identitySectionOf(packet: ContextPacket) {
  return packet.sections.find((s) => (IDENTITY_SECTION_IDS as readonly string[]).includes(s.id))
}

/** 统计某个 Domain Event 类型的条数 */
export function countDomainEventsOfType(run: ScenarioRun, type: string): number {
  return run.domainEvents.filter((e) => e.type === type).length
}

/** 把领域事件折叠成当前投影（用于验证"事件 → 状态"的一致性） */
export async function rebuildDiagnostic(
  kernel: KernelHandle
): Promise<{ counter: number; revision: number }> {
  const rebuilt = await rebuildProjection(
    kernel.stores.db,
    kernel.characterId,
    kernel.diagnosticReducer
  )
  const state = rebuilt.projection.state as { counter: number }
  return { counter: state.counter, revision: rebuilt.projection.revision }
}

export { countTraces, recentConversationEvents, runDiagnosticProcessor }

/**
 * 重新导出跨场景不变量检查。
 *
 * 存在的意义：任何"跑了一轮真实交互"的地方（内部 runner、真实模型 smoke、
 * 未来的 M3 长跑）都应该顺手检查一遍同样的不变量，
 * 而不是各自写一套"我觉得这样应该没问题"。
 */
export { assertInvariants } from './invariants.ts'
export type { InvariantViolation, ScenarioRun } from './invariants.ts'
