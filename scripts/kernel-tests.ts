/**
 * Kernel 契约测试 —— 领域纯函数层。
 *
 * 这些测试**不碰数据库、不碰 ElizaOS、不调模型**，全部 deterministic、毫秒级。
 * 它们保护的是最容易悄悄退化、又最难在运行期发现的东西：
 * ID 的稳定性、上下文排序的确定性、Reducer 的纯粹性、Validator 的失败关闭、
 * 以及**依赖方向**（领域层不许 import 基础设施）。
 *
 * 跑法：
 *   node_modules/.bin/tsx scripts/kernel-tests.ts            # 全部
 *   node_modules/.bin/tsx scripts/kernel-tests.ts Context    # 只跑名字含 Context 的
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  DIAGNOSTIC_SIGNAL,
  KernelError,
  ReducerRegistry,
  applyEvent,
  asCharacterId,
  asConversationEventId,
  asConversationId,
  canEvidenceExternalFact,
  createContextCompiler,
  createConversationEvent,
  conversationObservationFrom,
  createDefaultDomainEventRegistry,
  createProposal,
  emptyProjection,
  idempotencyKeyFor,
  isSelfExpressionOnly,
  makeConversationEventId,
  makeObservationId,
  renderSeedIdentity,
  seedFingerprint,
  sortSections,
  type ContextSection,
  type ContextSectionProvider,
  type DomainEvent,
} from '../src/kernel/contracts/index.ts'
import { buildCharacterDefinition } from '../src/kernel/identity/seed.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { createDiagnosticReducer } from '../src/kernel/projections/diagnostic.ts'
import { createDomainPolicyValidator } from '../src/kernel/policies/validator.ts'
import { character } from '../src/character/index.ts'
import { SCENARIOS } from '../evals/scenarios/index.ts'
import type { Scenario } from '../evals/harness/runner.ts'

import { expect, group, printSummary, runAll, test } from './kernel-test-kit.ts'

// ===========================================================================
group('领域契约')
// ===========================================================================

test('事件 ID 对同一 (角色, 会话, 序号) 恒定', () => {
  const characterId = asCharacterId('char_test')
  const conversationId = asConversationId('dm-test')
  const a = makeConversationEventId(characterId, conversationId, 7)
  const b = makeConversationEventId(characterId, conversationId, 7)
  expect.equal(a, b, '同一坐标必须得到同一个事件 id，否则幂等与重放都做不了')
  expect.notOk(
    String(a) === String(makeConversationEventId(characterId, conversationId, 8)),
    '不同序号不能撞 id'
  )
})

test('非法 ID 片段被拒绝（而不是静默产出坏 id）', () => {
  let threw = false
  try {
    makeConversationEventId(asCharacterId('char_test'), asConversationId('has space'), 1)
  } catch {
    threw = true
  }
  expect.ok(threw, '含空格/非法字符的片段应当抛错（否则 id 会在日志与 SQL 里不可读）')

  let badSequenceThrew = false
  try {
    makeConversationEventId(asCharacterId('char_test'), asConversationId('dm-test'), 0)
  } catch {
    badSequenceThrew = true
  }
  expect.ok(badSequenceThrew, '序号 0 不是合法坐标，应当被拒绝')
})

test('复合事件 ID：长群会话在三位及四位序号后仍可转换为观测', () => {
  const characterId = asCharacterId('00000000-0000-4000-8000-000000000001')
  const conversationId = asConversationId(`qq-${'a'.repeat(36)}-${'b'.repeat(36)}`)
  for (const sequence of [1, 99, 100, 999, 1000, 1043, Number.MAX_SAFE_INTEGER]) {
    const event = createConversationEvent({ characterId, conversationId,
      conversationSequence: 1, sequence, type: 'user_message', actorType: 'user',
      actorId: 'synthetic-user', content: '合成群聊输入' })
    const observation = conversationObservationFrom(event)
    assert.equal(observation.id, `obs:${event.id}`)
    assert.deepEqual(observation.sourceEventIds, [event.id])
  }
})

test('复合事件 ID：完整长度有界，片段上限与非法字符拒绝保持不变', () => {
  const id = makeConversationEventId(asCharacterId('c'.repeat(120)),
    asConversationId('r'.repeat(120)), Number.MAX_SAFE_INTEGER)
  assert.equal(id.length, 262)
  assert.equal(makeObservationId(id), `obs:${id}`)
  for (const value of ['', 'x'.repeat(263), `${id} `, 'unsafe/path', 'unsafe\npath']) {
    assert.throws(() => makeObservationId(value))
  }
  assert.throws(() => asCharacterId('c'.repeat(121)))
  assert.throws(() => asConversationId('r'.repeat(121)))
  assert.equal(makeObservationId('cev:old:dm:1'), 'obs:cev:old:dm:1')
})

test('来源一致性：type 与 actorType 必须匹配', () => {
  let error: KernelError | undefined
  try {
    createConversationEvent({
      characterId: asCharacterId('char_test'),
      conversationId: asConversationId('dm-test'),
      conversationSequence: 1,
      type: 'user_message',
      actorType: 'character',
      content: '她冒充用户说了句话',
      sequence: 1,
    })
  } catch (e) {
    error = e as KernelError
  }
  expect.ok(error, '伪造来源应当抛错（铁律 5 的第一道闸）')
  expect.equal(error!.code, 'actor_type_mismatch')
})

test('只有 user 事件能作为外部事实证据', () => {
  const base = {
    characterId: asCharacterId('char_test'),
    conversationId: asConversationId('dm-test'),
    sequence: 1,
    conversationSequence: 1,
    schemaVersion: 1,
    createdAt: 0,
  }
  const userEvent = {
    ...base,
    id: asConversationEventId('cev:a:b:1'),
    type: 'user_message' as const,
    actorType: 'user' as const,
    content: '我喜欢咖啡',
  }
  const assistantEvent = {
    ...base,
    id: asConversationEventId('cev:a:b:2'),
    type: 'assistant_message' as const,
    actorType: 'character' as const,
    content: '我小时候喜欢下雨',
  }

  expect.ok(canEvidenceExternalFact(userEvent), '用户说的话可以成为外部事实')
  expect.notOk(canEvidenceExternalFact(assistantEvent), '她自己说的话**不能**成为外部事实')
  expect.ok(isSelfExpressionOnly(assistantEvent), '她自己的话只构成自我表达证据')
})

test('Seed 渲染是确定性的，且带版本号', () => {
  const definition = buildCharacterDefinition(
    {
      id: '00000000-0000-4000-8000-000000000001',
      name: '苏沐薇',
      identityLines: ['和用户从小一起长大。'],
      traits: ['外冷内热'],
      styleLines: ['话多，短句。'],
    },
    { now: 0 },
  )
  const first = renderSeedIdentity(definition)
  const second = renderSeedIdentity(definition)
  expect.equal(first, second, '同一 Seed 必须渲染出逐字节相同的文本（SC-001 的判定基础）')
  expect.includes(first, '苏沐薇')
  expect.includes(first, `Seed 版本 v${definition.seedVersion}`)
  expect.equal(seedFingerprint(definition), seedFingerprint(definition), '指纹必须稳定')
})

test('真实角色定义能投影成 Seed（不缺字段、不抛错）', () => {
  const definition = characterDefinitionFromCharacter(character as never, { now: 0 })
  expect.equal(definition.name, '苏沐薇')
  expect.atLeast(definition.identity.selfDescription.length, 20, 'Seed 身份不能是空的')
  expect.atLeast(
    definition.communicationStyle.tone.length,
    1,
    'Seed 语言风格不能是空的（tone 至少一条）'
  )
  expect.includes(renderSeedIdentity(definition), '人格倾向')
})

// ===========================================================================
group('Context Compiler')
// ===========================================================================

const fixedProvider = (id: string, priority: number, content: string): ContextSectionProvider => ({
  name: id,
  async provide(): Promise<ContextSection[]> {
    return [{ id, kind: 'instruction', priority, content, estimatedTokens: content.length }]
  },
})

test('排序确定性：priority 降序，同 priority 按 id 升序', () => {
  const sections: ContextSection[] = [
    { id: 'b', kind: 'instruction', priority: 50, content: 'B' },
    { id: 'a', kind: 'instruction', priority: 50, content: 'A' },
    { id: 'z', kind: 'instruction', priority: 90, content: 'Z' },
  ]
  const sorted = sortSections(sections).map((s) => s.id)
  expect.deepEqual(sorted, ['z', 'a', 'b'], '同优先级必须按 id 决定顺序（否则 prompt 不可复现）')
})

test('同 id 的 section 只保留先注册者', async () => {
  const compiler = createContextCompiler({
    providers: [fixedProvider('dup', 50, '第一个'), fixedProvider('dup', 60, '第二个')],
  })
  const packet = await compiler.compile({
    characterId: asCharacterId('char_test'),
    currentInput: '你好',
    now: 0,
  })
  expect.equal(packet.sections.length, 1)
  expect.includes(packet.text, '第一个')
  expect.notIncludes(packet.text, '第二个')
})

test('预算裁剪：droppable=false 无条件保留，其余按优先级装填', async () => {
  const compiler = createContextCompiler({
    providers: [
      {
        name: 'mixed',
        async provide(): Promise<ContextSection[]> {
          return [
            { id: 'must', kind: 'seed-identity', priority: 10, content: 'x'.repeat(100), droppable: false },
            { id: 'small-high', kind: 'instruction', priority: 90, content: 'y'.repeat(10) },
            { id: 'big-low', kind: 'rollup', priority: 20, content: 'z'.repeat(500) },
          ]
        },
      },
    ],
  })
  const packet = await compiler.compile({
    characterId: asCharacterId('char_test'),
    currentInput: '你好',
    tokenBudget: 60,
    now: 0,
  })
  const kept = packet.sections.map((s) => s.id)
  expect.ok(kept.includes('must'), '绝不能被裁的 section 必须保留（哪怕超预算）')
  expect.ok(kept.includes('small-high'), '高优先级的小 section 应当装得下')
  expect.ok(!kept.includes('big-low'), '装不下的低优先级 section 应当被裁')
  expect.deepEqual(packet.droppedSectionIds, ['big-low'], '被裁的要如实记录（"她是忘了还是没进去"）')
})

test('编译结果可复现：同输入两次编译得到同一 packet', async () => {
  const compiler = createContextCompiler({ providers: [fixedProvider('stable', 50, '固定内容')] })
  const input = { characterId: asCharacterId('char_test'), currentInput: '你好', now: 12345 }
  const a = await compiler.compile(input)
  const b = await compiler.compile(input)
  expect.equal(a.text, b.text)
  expect.deepEqual(
    a.sections.map((s) => s.id),
    b.sections.map((s) => s.id),
  )
})

test('非法预算被拒绝（而不是静默忽略裁剪）', async () => {
  const compiler = createContextCompiler({ providers: [fixedProvider('x', 50, 'x')] })
  await expect.rejects(
    () =>
      compiler.compile({
        characterId: asCharacterId('char_test'),
        currentInput: 'x',
        tokenBudget: -1,
        now: 0,
      }),
    'bad_token_budget',
  )
})

// ===========================================================================
group('Reducer / Projection')
// ===========================================================================

const diagnosticEvent = (sequence: number, delta: number): DomainEvent => ({
  id: `dev:char_test:${sequence}` as DomainEvent['id'],
  characterId: asCharacterId('char_test'),
  sequence,
  type: DIAGNOSTIC_SIGNAL,
  sourceConversationEventIds: [asConversationEventId(`cev:char_test:dm-test:${sequence}`)],
  payload: { counterDelta: delta },
  processor: 'test',
  processorVersion: 'test@1',
  idempotencyKey: `idem-${sequence}`,
  schemaVersion: 1,
  createdAt: 0,
})

test('Reducer 是纯函数：同一输入两次折叠结果相同且不改原状态', () => {
  const reducer = createDiagnosticReducer()
  const state = reducer.initialState()
  const a = reducer.reduce(state, diagnosticEvent(1, 1))
  const b = reducer.reduce(state, diagnosticEvent(1, 1))
  expect.deepEqual(a, b)
  expect.deepEqual(state, reducer.initialState(), '原状态对象不能被改动（纯函数）')
})

test('Replay：从零重放得到与增量折叠相同的状态', () => {
  const reducer = createDiagnosticReducer()
  const events = [diagnosticEvent(1, 1), diagnosticEvent(2, 1), diagnosticEvent(3, 2)]

  let incremental = emptyProjection(reducer, asCharacterId('char_test'), 0)
  for (const event of events) {
    incremental = applyEvent(reducer, incremental, event, 0).projection
  }

  let replayed = emptyProjection(reducer, asCharacterId('char_test'), 0)
  for (const event of events) {
    replayed = applyEvent(reducer, replayed, event, 0).projection
  }

  expect.deepEqual(replayed.state, incremental.state)
  expect.equal(replayed.revision, incremental.revision)
})

test('乱序事件被判定为过时（不覆盖更新状态）', () => {
  const reducer = createDiagnosticReducer()
  let projection = emptyProjection(reducer, asCharacterId('char_test'), 0)
  projection = applyEvent(reducer, projection, diagnosticEvent(5, 1), 0).projection

  const stale = applyEvent(reducer, projection, diagnosticEvent(3, 99), 0)
  expect.ok(stale.stale, '序号更小的事件必须被判为过时（旧 Worker 不许覆盖新 Worker）')
  expect.deepEqual(stale.projection.state, projection.state, '过时事件不得改变状态')
})

test('reducer 版本不一致时拒绝继续追加（强制走 rebuild）', () => {
  const reducer = createDiagnosticReducer()
  const projection = {
    ...emptyProjection(reducer, asCharacterId('char_test'), 0),
    reducerVersion: 'diagnostic-reducer@0',
  }
  let error: KernelError | undefined
  try {
    applyEvent(reducer, projection, diagnosticEvent(1, 1), 0)
  } catch (e) {
    error = e as KernelError
  }
  expect.ok(error, '版本不匹配必须抛错，而不是用新算法继续算旧状态')
  expect.equal(error!.code, 'reducer_version_mismatch')
})

test('ReducerRegistry 检测 (投影, 事件类型) 冲突', () => {
  const registry = new ReducerRegistry()
  registry.register(createDiagnosticReducer())
  expect.notOk(
    (() => {
      try {
        registry.register({ ...createDiagnosticReducer(), projectionType: 'other' })
        return false
      } catch {
        return true
      }
    })(),
    '同一个事件类型被两个 reducer 认领应当启动即失败',
  )
})

// ===========================================================================
group('Validator（失败关闭）')
// ===========================================================================

const registry = createDefaultDomainEventRegistry()

const makeProposal = (overrides: Partial<Parameters<typeof createProposal>[0]> = {}) =>
  createProposal({
    characterId: asCharacterId('char_test'),
    proposalType: 'diagnostic-signal',
    sourceConversationEventIds: [asConversationEventId('cev:char_test:dm-test:1')],
    payload: { note: 'test' },
    targetEvents: [{ type: DIAGNOSTIC_SIGNAL, operation: 'signal', payload: { counterDelta: 1 } }],
    processor: 'test-processor',
    processorVersion: 'test-processor@1',
    ...overrides,
  })

const validatorWith = (sources: { id: string; characterId: string; sequence: number }[]) =>
  createDomainPolicyValidator({
    registry,
    sources: {
      async findEvents(ids: readonly string[]) {
        return sources
          .filter((s) => ids.includes(s.id))
          .map((s) => ({
            id: asConversationEventId(s.id),
            characterId: asCharacterId(s.characterId),
            sequence: s.sequence,
          }))
      },
    },
    processed: {
      async hasProcessed() {
        return false
      },
    },
  })

test('来源事件不存在 → 拒绝（不忽略、不续写）', async () => {
  const outcome = await validatorWith([]).validate(makeProposal())
  expect.notOk(outcome.accepted, 'provenance 缺失必须失败关闭')
  expect.equal(outcome.rejected[0].code, 'source_event_missing')
})

test('来源事件属于别的角色 → 拒绝', async () => {
  const outcome = await validatorWith([
    { id: 'cev:char_test:dm-test:1', characterId: 'char_other', sequence: 1 },
  ]).validate(makeProposal())
  expect.notOk(outcome.accepted)
  expect.equal(outcome.rejected[0].code, 'source_event_foreign')
})

test('未登记的 Domain Event 类型 → 拒绝', async () => {
  const outcome = await validatorWith([
    { id: 'cev:char_test:dm-test:1', characterId: 'char_test', sequence: 1 },
  ]).validate(
    makeProposal({
      targetEvents: [{ type: 'TOTALLY_NEW_EVENT', operation: 'create', payload: {} }],
    }),
  )
  expect.notOk(outcome.accepted)
  expect.equal(outcome.rejected[0].code, 'domain_event_type_not_allowed')
})

test('payload 不合法 → 拒绝', async () => {
  const outcome = await validatorWith([
    { id: 'cev:char_test:dm-test:1', characterId: 'char_test', sequence: 1 },
  ]).validate(
    makeProposal({
      targetEvents: [
        { type: DIAGNOSTIC_SIGNAL, operation: 'signal', payload: { counterDelta: 'not-a-number' } },
      ],
    }),
  )
  expect.notOk(outcome.accepted)
  expect.equal(outcome.rejected[0].code, 'payload_schema_invalid')
})

test('payload 超限 → 拒绝（用按类型声明的上限，而不是兜底值）', async () => {
  // 诊断信号的 payload 契约会**丢弃**契约外字段，因此要测"超限"
  // 必须把上限压到比合法 payload 还小 —— 这也正是 M4 的 Memory 候选
  // （可能带一小段原文）会遇到的真实情形。
  const base = createDefaultDomainEventRegistry()
  const baseSpec = base.get(DIAGNOSTIC_SIGNAL)!

  // 一个只把该类型上限改成 4 字节的 registry（不重复登记，只覆盖 get）
  const cappedRegistry = {
    get: (type: string) =>
      type === DIAGNOSTIC_SIGNAL ? { ...baseSpec, maxPayloadBytes: 4 } : base.get(type),
    has: (type: string) => base.has(type),
    types: () => base.types(),
    register: () => {
      throw new Error('本测试不允许登记新类型')
    },
  }

  const validator = createDomainPolicyValidator({
    registry: cappedRegistry as never,
    sources: {
      async findEvents(ids: readonly string[]) {
        return ids.map((id, index) => ({
          id: asConversationEventId(id),
          characterId: asCharacterId('char_test'),
          sequence: index + 1,
        }))
      },
    },
    processed: {
      async hasProcessed() {
        return false
      },
    },
  })

  const outcome = await validator.validate(
    makeProposal({
      targetEvents: [
        { type: DIAGNOSTIC_SIGNAL, operation: 'signal', payload: { counterDelta: 1 } },
      ],
    }),
  )
  expect.notOk(outcome.accepted, 'payload 超过该类型声明的上限时必须拒绝')
  expect.equal(outcome.rejected[0].code, 'payload_too_large')
})

test('payload 契约外的字段会被丢弃，而不是让整条提案失败', async () => {
  const outcome = await validatorWith([
    { id: 'cev:char_test:dm-test:1', characterId: 'char_test', sequence: 1 },
  ]).validate(
    makeProposal({
      targetEvents: [
        {
          type: DIAGNOSTIC_SIGNAL,
          operation: 'signal',
          payload: { counterDelta: 1, extraField: 'LLM 随手多给的字段' },
        },
      ],
    }),
  )
  expect.ok(outcome.accepted, '多出来的字段应当被契约丢弃，而不是让提案失败')
  expect.deepEqual(
    outcome.acceptedEvents[0].payload,
    { counterDelta: 1 },
    '入库的 payload 必须只剩契约内字段',
  )
})

test('合法提案被接受，且幂等键稳定可复算', async () => {
  const validator = validatorWith([
    { id: 'cev:char_test:dm-test:1', characterId: 'char_test', sequence: 1 },
  ])
  const proposal = makeProposal()
  const outcome = await validator.validate(proposal)
  expect.ok(outcome.accepted, `应当被接受，实际：${JSON.stringify(outcome.rejected)}`)
  expect.equal(outcome.acceptedEvents.length, 1)
  expect.equal(
    idempotencyKeyFor(proposal)[0],
    outcome.acceptedEvents[0].idempotencyKey,
    '幂等键必须由契约层唯一计算，处理器与校验器不能各算一套',
  )
})

// ===========================================================================
group('Kernel 边界（依赖方向）')
// ===========================================================================

test('领域层不 import 任何基础设施 / Runtime / SQL / 观测后端', () => {
  const kernelDir = join(process.cwd(), 'src', 'kernel')
  const forbidden = ['@elizaos/', 'drizzle-orm', 'node:fs', 'node:path', 'node:child_process', 'phoenix', 'opentelemetry']
  const offenders: string[] = []

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        // app/ 是 Application Layer，允许依赖 infrastructure（它本来就是装配层）
        if (full.split(/[\\/]/).includes('app')) continue
        walk(full)
        continue
      }
      if (!entry.endsWith('.ts')) continue
      const text = readFileSync(full, 'utf8')
      const importLines = text
        .split('\n')
        .filter((line) => /^\s*import\b/.test(line) || /^\s*export\b.*\bfrom\b/.test(line))
        .join('\n')
      for (const pattern of forbidden) {
        if (importLines.includes(`'${pattern}`) || importLines.includes(`"${pattern}`)) {
          offenders.push(`${full.replace(process.cwd(), '')} → ${pattern}`)
        }
      }
    }
  }
  walk(kernelDir)

  expect.deepEqual(offenders, [], '依赖方向必须单向：infrastructure → domain，绝不能反向')
})

/**
 * Lv4.5 / `P3`：**入口桥那一层也不许自己伸手到基础设施**。
 *
 * ============================================================================
 *  为什么需要**单独**一条（上面那条盖不住）
 * ============================================================================
 * 上面那条的 walk 会把任何叫 `app` 的目录整段跳过 —— 对装配层是**对的**
 * （`app/turn-gateway.ts` 本来就持有端口），但对 `app/bridge/**` **太宽**：
 * 桥的整个存在理由就是"它拿不到 prompt、也拿不到模型"（`INV-PL2-09`）。
 *
 * 实测过的教训就在这个仓库里：R3 那版桥"照着重写一遍轮次"，**漏掉了全部五道回复守卫
 * 而门照旧 PASS**。Lv4.5 的 `P2`/`P3` 正在往这一层加东西（只读准备、快反、有限插话），
 * 而"插话"最容易被实现成一条**旁路**：直接调模型、直接写库、直接播一句话。
 *
 * 因此这里钉住：`app/bridge/**` **只能**依赖 `contracts/`（纯类型与纯函数）。
 *
 * ⚠️ 计数型自检（`INV-M45-06` / 计划 §6 第 8 条）：检查了 **0 个**文件时必须判失败 ——
 *    "0 个文件、0 处违规"与"全部合规"在输出上一模一样。
 */
test('入口桥只能依赖 contracts（P2/P3 的新增项不许绕过端口伸手到模型或数据库）', () => {
  const bridgeDir = join(process.cwd(), 'src', 'kernel', 'app', 'bridge')
  const forbidden = ['@elizaos/', 'drizzle-orm', 'node:', 'phoenix', 'opentelemetry', 'src/infrastructure', '../infrastructure', '../../infrastructure']
  const offenders: string[] = []
  let checked = 0

  for (const entry of readdirSync(bridgeDir)) {
    if (!entry.endsWith('.ts')) continue
    checked += 1
    const full = join(bridgeDir, entry)
    const text = readFileSync(full, 'utf8')
    const importLines = text
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line) || /^\s*export\b.*\bfrom\b/.test(line))
      .join('\n')
    for (const pattern of forbidden) {
      if (importLines.includes(`'${pattern}`) || importLines.includes(`"${pattern}`)) {
        offenders.push(`${entry} → ${pattern}`)
      }
    }
  }

  expect.ok(checked > 0, '桥目录里一个 .ts 都没检查到 ⇒ MEASUREMENT INVALID（不是 PASS）')
  expect.deepEqual(
    offenders,
    [],
    '入口桥不许绕过 TurnBridgeHost 直接依赖模型/数据库/文件系统：那正是"第二个说话入口"的形状'
  )
})

// ===========================================================================
group('场景清单')
// ===========================================================================

test('每个场景结构完整且带断言', () => {
  expect.atLeast(SCENARIOS.length, 7, 'M2.5 至少要覆盖 SC-001 ~ SC-007')
  for (const scenario of SCENARIOS as readonly Scenario[]) {
    expect.atLeast(scenario.assertions.length, 1, `${scenario.id} 必须带断言，否则它只是"跑过了"`)
    expect.atLeast(scenario.turns.length + (scenario.presetTurns?.length ?? 0), 1, `${scenario.id} 没有任何轮次`)
    expect.atLeast(scenario.tags.length, 1, `${scenario.id} 没有 tag，无法按主题筛选`)
  }
  const ids = SCENARIOS.map((s) => s.id)
  expect.equal(new Set(ids).size, ids.length, '场景 id 不能重复')
})

test('场景清单锁定：SC-001 ~ SC-007 都在（且顺序稳定）', () => {
  expect.deepEqual(
    SCENARIOS.map((s) => s.id),
    ['SC-001', 'SC-002', 'SC-003', 'SC-004', 'SC-005', 'SC-006', 'SC-007'],
    'plan 第 56 节列出的场景必须逐个存在',
  )
})

// ---------------------------------------------------------------------------
const summary = await runAll({ filter: process.argv[2] })
printSummary(summary, 'Kernel 契约测试')
process.exit(summary.failed === 0 ? 0 : 1)
