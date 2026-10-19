/**
 * M3 Phoenix 验证 —— **真实观测后端回查**（WP8 Gate，计划书第 71/95/141 节）。
 *
 * ============================================================================
 *  为什么必须用真实后端，而不能只跑离线编码器测试
 * ============================================================================
 * M2.5 的验收报告里记着一条硬教训：手写 OTLP 编码器的**三个静默失效**
 * 只有在真实 Phoenix 启动后才暴露 —— 离线测试全绿也照样错：
 *
 *   · `/v1/traces` 只接受 protobuf（OTLP JSON 返回 HTTP 415）
 *   · `start_time_unix_nano` 是 `fixed64`（按 varint 写不报错，但解码器静默跳过）
 *   · `Status.code` 是 field 3（写 field 2 会让状态永远是 UNSET）
 *
 * 共同点：**编码器与自己的解码器互相自洽**，所以自测通过；
 * 只有官方实现才照出问题。因此"离线全绿"不足以证明 trace 真的能用。
 *
 * ---------------------------------------------------------------------------
 *  这个脚本验证的是 M3 新增的那部分
 * ---------------------------------------------------------------------------
 * `pnpm eval:telemetry` / `eval:phoenix-chat` 已经守着 M2.5 的
 * `character.turn` + `character.model_call`。本脚本守的是 M3 的
 * **八步 run tree**（计划书第 71 节）在真实 Phoenix 里逐节点可见：
 *
 *     message_normalize / actor_resolve / conversation_persist_input / identity_load
 *     context_compile / model_generate / output_validate / conversation_persist_output
 *
 * 以及计划书第 72 节要求**每一轮**都有的身份属性：
 *
 *     character.id / seed.version / seed.hash / conversation.id / user.id
 *     input.event_id / context.compiler_version / model.profile / output.event_id
 *
 * 跑法（需要 `pnpm phoenix:up`）：
 *   tsx scripts/verify-m3-phoenix.ts
 *
 * 全部使用**一次性副本库**（`isolateDatabase`），真实对话库绝不被碰。
 */

import type { Character, Plugin } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'

import { stringToUuid } from '../src/kernel/contracts/uuid.ts'





import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { openAiCompatiblePlugin } from '../src/providers/openai-compatible.ts'
import {
  createTelemetry,
  readTelemetryConfig,
  type TelemetryConfig,
} from '../src/infrastructure/telemetry/index.ts'
import { TelemetryRecorder } from '../src/infrastructure/telemetry/recorder.ts'
import {
  asConversationId,
  newRuntimeId,
  newTraceId,
  type CharacterRunTrace,
} from '../src/kernel/contracts/index.ts'

// ---------------------------------------------------------------------------
// 检查器
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
const failures: string[] = []

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

// ---------------------------------------------------------------------------
// Phoenix 配置
// ---------------------------------------------------------------------------

/*
 * ⚠️ 这里是**基址**，不是完整的 OTLP 路径。
 *
 * 实测踩到过：把默认值写成 `http://127.0.0.1:6006/v1/traces`，
 * 而 `phoenix.ts` 导出时会在基址后面**再拼一次** `/v1/traces` →
 * 变成 `/v1/traces/v1/traces` → Phoenix 返回 **HTTP 422**。
 *
 * 422 这个码很有误导性：它读起来像"我发的 protobuf 数据不对"，
 * 于是很容易去查编码器（M2.5 的三个静默失效就是这么查出来的），
 * 而实际上只是我自己把路径拼重了。
 */
const PHOENIX_UI = process.env.PHOENIX_COLLECTOR_ENDPOINT ?? 'http://127.0.0.1:6006'

section('0. Phoenix 可达性')
let reachable = false
try {
  const response = await fetch(PHOENIX_UI, { signal: AbortSignal.timeout(5000) })
  reachable = response.ok
} catch {
  reachable = false
}
check('Phoenix 可达', reachable, reachable ? PHOENIX_UI : `${PHOENIX_UI}（先跑 pnpm phoenix:up）`)

if (!reachable) {
  console.log('\n  Phoenix 不在，验证无法进行。')
  console.log('  这不是"通过"，也不是"失败" —— 是**没测**。因此以退出码 2 结束，')
  console.log('  好让 CI 与本脚本的调用者能区分这三种状态。')
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 装配（一次性副本库）
// ---------------------------------------------------------------------------

const sandbox = isolateDatabase('m3-phoenix-verify', { keep: true })
const characterId = character.id ?? character.name
const userId = stringToUuid('user-Alex')

const runtime = createThinHostRuntime({
    character: character,
    settings: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
  },
    conversationLength: 16,
  })

await initDatabase(runtime)
await runtime.initialize()

const kernel = await initKernel(runtime, {
  definition: characterDefinitionFromCharacter(character as never),
})

const telemetryConfig: TelemetryConfig = {
  ...readTelemetryConfig({} as NodeJS.ProcessEnv),
  // ⚠️ 覆盖必须写在 spread **之后**，否则会被默认值盖掉。
  // 而且它是**基址**：`phoenix.ts` 自己会拼 `/v1/traces`
  // （写全路径会变成 `/v1/traces/v1/traces` → HTTP 422，
  //   而 422 读起来像是在说"数据不对"，很容易查错方向）。
  endpoint: PHOENIX_UI,
  enabled: true,
  adapter: 'phoenix',
  timeoutMs: 5000,
  sessionId: `m3-phoenix-verify-${Date.now()}`,
}
const telemetryPort = createTelemetry(telemetryConfig)
const telemetry = new TelemetryRecorder(telemetryPort)

const conversationId = asConversationId(`dm-m3-phoenix-${String(userId).slice(0, 8)}`)
const recorder = new ConversationRecorder({
  db: kernel.stores.db,
  characterId: kernel.characterId,
  conversationId,
  dryRun: false,
  userName: 'Alex',
  characterName: character.name,
  transport: 'phoenix-verify',
  userId: String(userId),
})

const runtimeId = newRuntimeId()
const gateway = new TurnGateway({
  kernel,
  definition: kernel.definition,
  identity: kernel.identitySnapshot,
  recorder,
  conversationSequence: () => nextSequence,
  modelProfile: 'phoenix-verify',
  recentLimit: 16,
  telemetry,
  runtimeId,
  userId: String(userId),
})
let nextSequence = 1

// ---------------------------------------------------------------------------
// 跑一轮真实对话（**不调模型**：我们验的是 trace 树，不是她的措辞）
// ---------------------------------------------------------------------------

section('1. 产生一轮完整 trace')

const turn = await gateway.beginTurn('Phoenix 验证：这一轮的 run tree 应该完整。')
nextSequence = turn.conversationSequence + 1

const { renderCriticalStateSection, recentContextLinesFrom } = await import(
  '../src/infrastructure/runtime/adapters.ts'
)
const stateSection = await renderCriticalStateSection(runtime, String(characterId), String(userId))
const recentLines = await recentContextLinesFrom(runtime, {
  characterId: kernel.characterId,
  userName: 'Alex',
  characterName: character.name,
  limit: 16,
})

const packet = await gateway.compileTurn({
  turn,
  currentInput: 'Phoenix 验证：这一轮的 run tree 应该完整。',
  recentLines,
  stateSection,
})

const outgoing = await gateway.completeTurn({
  turn,
  replyText: '（Phoenix 验证用的回复）',
  modelDurationMs: 42,
})

const trace: CharacterRunTrace = outgoing.trace
check('一轮产生了 trace', trace.traceId !== undefined, String(trace.traceId))
check(
  'trace 里的编译器版本是 context-compiler@2',
  trace.contextCompilerVersion === 'context-compiler@2',
  String(trace.contextCompilerVersion)
)

// ---------------------------------------------------------------------------
// 身份属性（计划书第 72 / 122 节）
// ---------------------------------------------------------------------------

section('2. 身份属性（每一轮都必须能查到用了哪版人格）')

check('character.id 在 trace 里', String(trace.characterId) === String(characterId), String(trace.characterId))
check('seed.version 在 trace 里', typeof trace.seedVersion === 'number', `v${trace.seedVersion}`)
check('seed.hash 在 trace 里', (trace.seedHash ?? '').length === 64, (trace.seedHash ?? '').slice(0, 12))
check(
  'identity_source_refs 在 trace 里',
  (trace.identitySourceRefs ?? []).length > 0,
  (trace.identitySourceRefs ?? []).join(', ')
)
check('conversation.id 在 trace 里', trace.conversationId === String(conversationId), String(trace.conversationId))
check('user.id 在 trace 里', trace.userId === String(userId), String(trace.userId))
check('runtime.id 在 trace 里（只用于诊断）', trace.runtimeId === String(runtimeId), String(trace.runtimeId))
check('input.event_id 在 trace 里', trace.inputEventId !== undefined, String(trace.inputEventId))
check('output.event_id 在 trace 里', trace.outputEventId !== undefined, String(trace.outputEventId))
check(
  'context.compiler_version 在 trace 里',
  trace.contextCompilerVersion === 'context-compiler@2',
  String(trace.contextCompilerVersion)
)
check(
  '身份 section 进了这一轮的上下文',
  trace.contextSectionIds.includes('identity-core'),
  trace.contextSectionIds.join(', ')
)

// ---------------------------------------------------------------------------
// 八步 run tree（计划书第 71 节）
// ---------------------------------------------------------------------------

section('3. 八步 run tree 逐节点存在')

const REQUIRED_STEPS = [
  'message_normalize',
  'actor_resolve',
  'conversation_persist_input',
  'identity_load',
  'context_compile',
  'model_generate',
  'output_validate',
  'conversation_persist_output',
] as const

const stepKinds = trace.steps.map((step) => step.kind)
for (const kind of REQUIRED_STEPS) {
  check(`run tree 含 ${kind}`, stepKinds.includes(kind), stepKinds.join(' → '))
}

check(
  '每个 step 都带时间（可算耗时）',
  trace.steps.every((step) => typeof step.startedAt === 'number'),
  `${trace.steps.length} 个 step`
)
check(
  'step 的 attributes 里不含对话正文（隐私原则，计划书第 73 节）',
  !JSON.stringify(trace.steps).includes('run tree 应该完整'),
  '正文没有进 trace'
)
check(
  'identity_load 的 attributes 带 seed 版本与指纹前缀',
  (() => {
    const step = trace.steps.find((s) => s.kind === 'identity_load')
    return step !== undefined && step.attributes.seedVersion === trace.seedVersion
  })(),
  String(trace.steps.find((s) => s.kind === 'identity_load')?.attributes.seedVersion)
)

// ---------------------------------------------------------------------------
// 真的导出了吗（等 flush）
// ---------------------------------------------------------------------------

section('4. 导出到 Phoenix')

await telemetry.shutdown()
const summary = telemetry.exportSummary()
check('至少尝试导出一次', summary.attempts > 0, `attempts=${summary.attempts}`)
check('导出全部成功（HTTP 2xx）', summary.failures === 0, `failures=${summary.failures}`)
check(
  '导出的 span 数 > 0',
  telemetry.exportedSpanCount() > 0,
  `${telemetry.exportedSpanCount()} 个 span`
)

// ---------------------------------------------------------------------------
// 真实后端回查（关键一步：证明 Phoenix 真的收下并解出来了）
// ---------------------------------------------------------------------------

section('5. Phoenix 后端回查（按 seed 指纹与 event id）')

/**
 * 从 Phoenix 的 spans API 拉 span。
 *
 * ⚠️ 三个实测踩到的坑（都写在这里，因为它们看起来都像"数据没发出去"）：
 *
 * 1. **路径必须带 project**：`/v1/spans` 返回 **HTTP 422**（不是 404），
 *    而 422 读起来像"我发的数据不对"，很容易去查编码器。
 *    既有脚本用的是 `/v1/projects/default/spans`。
 *
 * 2. **`session.id` 是 resource 级属性**，而这个 API 只返回 span 级
 *    attributes —— 按它过滤会查到 0 条（M2.5 的验收记录里也有这一条）。
 *
 * 3. **子 span 的名字也以父 span 名开头**。M3 的八个 step 被导出成
 *    `character.turn.<step_kind>`，因此 `condition=name == 'character.turn'`
 *    会同时匹配父 span **与全部子 span**。要判断"某一步在不在"，
 *    看的是**子 span 的名字**，而不是父 span 上的某个属性。
 */
async function fetchSpans(condition?: string): Promise<
  { name: string; attributes: Record<string, unknown> }[]
> {
  const query = new URL(`${PHOENIX_UI}/v1/projects/default/spans`)
  if (condition) query.searchParams.set('condition', condition)
  query.searchParams.set('limit', '200')
  const response = await fetch(query, { signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const payload = (await response.json()) as {
    data?: { name?: string; attributes?: Record<string, unknown> }[]
  }
  return (payload.data ?? []).map((span) => ({
    name: String(span.name ?? ''),
    attributes: span.attributes ?? {},
  }))
}

let spans: { name: string; attributes: Record<string, unknown> }[] = []
/*
 * Phoenix 的写入是异步的，因此轮询几次而不是等一个固定时长。
 * 等固定时长要么慢（保守），要么不稳（激进）—— 轮询两者都不是。
 */
for (let attempt = 0; attempt < 8; attempt += 1) {
  try {
    spans = await fetchSpans("name like 'character.turn%'")
    if (spans.length > 0) break
  } catch (error) {
    if (attempt === 7) {
      check('能从 Phoenix 回查 span', false, `${(error as Error).message}`)
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1500))
}
if (spans.length > 0) {
  check('能从 Phoenix 回查 span', true, `${spans.length} 个 character.turn* span`)
} else if (!failures.includes('能从 Phoenix 回查 span')) {
  check('能从 Phoenix 回查 span', false, '轮询 8 次仍未查到 character.turn*')
}

if (spans.length > 0) {
  const inputEventId = String(trace.inputEventId)

  /** 属性比较宽松：Phoenix 可能把值放在一层包装里 */
  const attributeOf = (span: { attributes: Record<string, unknown> }, key: string): unknown => {
    const direct = span.attributes[key]
    if (direct !== undefined) return direct
    // 有些版本把属性包成 { key: { stringValue } } 之类
    const wrapped = span.attributes[key] as { stringValue?: unknown; intValue?: unknown } | undefined
    return wrapped?.stringValue ?? wrapped?.intValue
  }

  /*
   * 用 input event id 找到**本次**那一轮 trace（而不是猜时间）。
   *
   * ⚠️ 属性名是**驼峰**而不是点号：M3 的 step attributes 走的是
   * `TraceStep.attributes` 那个自由字典，导出时按原样写成
   * `input.event.id` 之外的名字 —— 实测 Phoenix 里存的是
   * 父 span 上的 `input.event.id`（点号）与 step span 上的
   * `seedVersion` / `seedHash`（驼峰）。
   *
   * 因此这里**两种都试**，并把"到底查到了哪个名字"写进细节里 ——
   * 只报"匹配 0 个"会让人以为是数据没发出去，而实际可能只是名字不对。
   */
  const valueOf = (span: { attributes: Record<string, unknown> }, ...keys: string[]): unknown => {
    for (const key of keys) {
      const value = attributeOf(span, key)
      if (value !== undefined) return value
    }
    return undefined
  }

  const suffix = inputEventId.slice(-12)
  const mine = spans.filter((span) => {
    const value = valueOf(span, 'input.event.id', 'input.event_id', 'eventId')
    return typeof value === 'string' && value.includes(suffix)
  })

  check(
    '按 input event id 指纹能定位到本次这一轮',
    mine.length > 0,
    `匹配 ${mine.length} 个 span（共 ${spans.length} 个；指纹 …${suffix}）`
  )

  /*
   * 父 span 恰好叫 `character.turn`；子 span 是 `character.turn.<step>`。
   * 因此"根 span 在不在"用**精确相等**判断，而不是 includes ——
   * 后者会被任意一个子 span 满足，于是这条检查永远通过（等于没检）。
   */
  const roots = mine.filter((span) => span.name === 'character.turn')
  check(
    '这一轮在 Phoenix 里有 character.turn 根 span',
    roots.length > 0,
    roots.length > 0
      ? `找到 ${roots.length} 条根 span`
      : `本次 span 名字：${[...new Set(mine.map((s) => s.name))].join(', ')}`
  )

  /*
   * M3 的八个 step 是否作为**子 span** 出现。
   *
   * ⚠️ 子 span 的命名是 `character.<step_kind>`（见 `phoenix.ts` 的
   * `name: \`character.${step.kind}\``），而**不是** `character.turn.<kind>`；
   * 父 span 才叫 `character.turn`。
   *
   * 一开始我按 `character.turn.<kind>` 去查，得到 0/8 —— 而那个结果
   * 看起来像"step 根本没导出"。实际原因只是命名前缀。这类"名字猜错"
   * 是接手别人写的可观测性时最常踩的一类；因此这里的判据写成
   * "**去掉 `character.` 前缀后等于 step kind**"，而不是拼一个我没验过的字符串。
   */
  const stepSpanNames = new Set(
    spans
      .map((span) => span.name)
      .filter((name) => name.startsWith('character.'))
      .map((name) => name.slice('character.'.length))
  )
  const presentSteps = REQUIRED_STEPS.filter((kind) => stepSpanNames.has(kind))
  check(
    'M3 的八步 run tree 在 Phoenix 里逐节点可见',
    presentSteps.length === REQUIRED_STEPS.length,
    `${presentSteps.length}/${REQUIRED_STEPS.length}：${presentSteps.join(', ')}` +
      (presentSteps.length < REQUIRED_STEPS.length
        ? `（缺失：${REQUIRED_STEPS.filter((k) => !presentSteps.includes(k)).join(', ')}）`
        : '')
  )

  /*
   * 身份属性回查：M3 的关键承诺是"每一轮都能查到用了哪版人格"。
   *
   * `seedVersion` / `seedHash` 在 `character.identity_load` 那个子 span 上
   * （它们属于那个 step 的 attributes）。因此按子 span 名字去取。
   */
  const identitySpan = spans.find((span) => span.name === 'character.identity_load')
  const seedVersion = identitySpan ? attributeOf(identitySpan, 'seedVersion') : undefined
  check(
    'Phoenix 里能查到 seedVersion（回答"她当时用的是哪版人格"）',
    seedVersion !== undefined,
    seedVersion !== undefined
      ? `seedVersion=${String(seedVersion)}（在 character.identity_load 上）`
      : identitySpan
        ? `identity_load span 存在，但没有 seedVersion 属性（属性有：${Object.keys(identitySpan.attributes).join(', ')}）`
        : 'identity_load 子 span 不存在'
  )
}

// ---------------------------------------------------------------------------
// Phoenix 离线时角色仍能工作（计划书第 141 节的后半句）
// ---------------------------------------------------------------------------

section('6. Phoenix 离线时角色仍能工作')

const offlineTelemetry = new TelemetryRecorder(
  createTelemetry({
    ...telemetryConfig,
    // 指向一个必然不可达的端口
    endpoint: 'http://127.0.0.1:1',
    timeoutMs: 200,
    sessionId: `m3-phoenix-offline-${Date.now()}`,
  })
)

let offlineError: string | undefined
try {
  const offlineGateway = new TurnGateway({
    kernel,
    definition: kernel.definition,
    identity: kernel.identitySnapshot,
    recorder,
    conversationSequence: () => nextSequence,
    modelProfile: 'phoenix-offline-verify',
    recentLimit: 16,
    telemetry: offlineTelemetry,
    dryRun: true, // 不写库：这一节只验"遥测挂掉不影响业务"
  })
  const offlineTurn = await offlineGateway.beginTurn('Phoenix 离线时我也该能说话。')
  const offlinePacket = await offlineGateway.compileTurn({
    turn: offlineTurn,
    currentInput: 'Phoenix 离线时我也该能说话。',
    recentLines: [],
  })
  await offlineGateway.completeTurn({ turn: offlineTurn, replyText: '在的。', modelDurationMs: 10 })
  check('Phoenix 不可达时整轮不抛异常', true, `packet=${offlinePacket.compilerVersion}`)
  await offlineTelemetry.shutdown()
} catch (error) {
  offlineError = error instanceof Error ? error.message : String(error)
  check('Phoenix 不可达时整轮不抛异常', false, offlineError)
}

const offlineSummary = offlineTelemetry.exportSummary()
check(
  '离线导出失败被记在遥测侧（而不是污染业务）',
  offlineSummary.failures > 0 || offlineSummary.attempts === 0,
  `attempts=${offlineSummary.attempts} failures=${offlineSummary.failures}`
)

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(72)}`)
console.log(`M3 Phoenix 验证：${passed} 通过 / ${failed} 失败`)
if (failures.length > 0) {
  console.log('失败项：')
  for (const failure of failures) console.log(`  - ${failure}`)
}
console.log(`实验库：${sandbox.dir}`)
console.log(`Phoenix UI：${PHOENIX_UI}（可在浏览器里核对这一轮的 run tree）`)
console.log('='.repeat(72))

await runtime.stop()
process.exit(failed === 0 ? 0 : 1)
