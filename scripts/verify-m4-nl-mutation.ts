/**
 * M4.1 WP-09 / G12 —— **自然语言集成覆盖**（Layer C）。
 *
 * ============================================================================
 *  它为什么必须单独存在
 * ============================================================================
 * M4 有 939 项断言、五道新增门，而 D1 从它们中间穿了过去。原因只有一个：
 *
 *     它们几乎都**直接给 memoryId**，绕过了"从自然语言解析目标"这一层。
 *
 * 因此这一道门的纪律是硬的：
 *
 *     ❌ 禁止传 memoryId
 *     ❌ 禁止直接调 store / validator 来断言结果
 *     ✅ 只从**用户真实文本**进入
 *
 *        文本 → 意图判定 → 内容抽取 → 目标解析 → 显式服务 → 事件 → 投影
 *
 * ---------------------------------------------------------------------------
 *  与另外两道门的分工
 * ---------------------------------------------------------------------------
 *   `m4:mutation-safety:verify`（Layer B）—— **状态级**：错目标不得改库
 *   本文件（Layer C）              —— **链路级**：整条链在真实文本上跑通
 *   `m4:smoke:live`（Layer D）      —— 真实模型 + 真实库副本 + 真实回复
 *
 * Layer C 是**离线且确定性的**（规则抽取器 + 词面判别器），因此能进 `m4:ci`。
 * 它补的正是"装了没有"这一层：`m4:verify` §13 测服务、`m4:test` 测部件，
 * 而这里测的是**它们串起来之后，用户那句话说出去会发生什么**。
 *
 * 跑法：pnpm m4:nl-mutation:verify
 */

import 'dotenv/config'

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { countsOf, createM4Harness, createReporter, snapshotOf, M4_T0 } from './m4-harness.ts'
/*
 * M6.1 WP4 / ADR-055 §4.4 ②：误触发负控的**冻结集**。
 * 门只消费冻结集（不手抄文本），因此语料漂移会在门里立刻显形。
 */
import {
  loadCorrectionNegativeSet,
  validateCorrectionNegativeSet,
} from './m6.1-control-sets.ts'
import { applyAcceptedEvents } from '../src/infrastructure/persistence/event-store.ts'
import {
  createExplicitMemoryIntentDetector,
  detectExplicitIntentFromEvent,
  targetHintsFrom,
} from '../src/kernel/app/memory/intent-detector.ts'
import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import {
  LexicalSemanticJudge,
  createTargetMemoryResolver,
} from '../src/kernel/app/memory/target-resolver.ts'
import { createExplicitMemoryService } from '../src/kernel/app/memory/explicit-service.ts'
import { createExplicitMemoryTurnPort } from '../src/kernel/app/memory/explicit-turn.ts'
import type { EntityRef } from '../src/kernel/contracts/index.ts'

const report = createReporter()
const evidenceDir = join(process.cwd(), 'artifacts', 'm4.1')

/*
 * ⚠️ 门头横幅**不在这里打**：`--list-cases` 的 stdout 必须是**干净的场景 id 列表**
 *    （逐场景 harness 直接读 stdout，多一行横幅就会被当成一个"场景"）。
 *    ⇒ 横幅挪到文件末尾、场景执行之前。
 */

interface Scenario {
  h: Awaited<ReturnType<typeof createM4Harness>>
  seed: (predicate: string, value: string, type: 'person_fact' | 'preference') => Promise<void>
  turn: (text: string) => Promise<{ kind: string; reason?: string }>
  outcome: (text: string) => Promise<{ ok: boolean; reason?: string }>
  activeValues: () => Promise<string[]>
  hash: () => Promise<string>
  dispose: () => Promise<void>
}

/**
 * 一个干净场景：显式路径按**生产形状**装配（与 `main.ts` 同构）。
 *
 * 与生产一致的三处，缺一这条门就没有意义：
 *   · 抽取器 = 规则（生产缺省）
 *   · 目标解析 = `createTargetMemoryResolver` + 词面判别器
 *   · 轮次端口 = `createExplicitMemoryTurnPort`（生产就是从这里进的）
 */
async function openScenario(label: string, options: { url?: string } = {}): Promise<Scenario> {
  const sandbox = isolateDatabase(`m41-nl-${label}`, {
    keep: true,
    /*
     * ⚠️ 显式给出目标：**只有**"这个场景自己要在第二个独立库上跑"时才用
     *    （L3-07）。其余场景一律走默认路径（`LG_TEST_PG_URL` 指向 harness
     *    为**本场景**准备的那个空白库）⇒ 场景之间**不共享库**。
     */
    ...(options.url === undefined ? {} : { postgres: { url: options.url } }),
  })
  await resetPluginSqlConnection()
  const h = await createM4Harness({ label: `m41-nl-${label}` })
  const { owner, user, db, store } = h

  const resolver = createTargetMemoryResolver({
    get: (id) => store.get(id),
    getActiveByCanonicalKey: (key) => store.getActiveByCanonicalKey(key),
    listBySubject: (o: EntityRef, s: EntityRef) => store.listBySubject(o, s),
    semanticJudge: new LexicalSemanticJudge(),
  })

  const service = createExplicitMemoryService({
    store,
    validator: h.validator,
    extractor: createRuleOnlyContentExtractor(),
    resolveTarget: (input) =>
      resolver.resolve({
        owner: input.owner,
        text: input.text,
        ...(input.canonicalKey !== undefined ? { canonicalKey: input.canonicalKey } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.hints !== undefined ? { hints: input.hints } : {}),
      }),
    commitEvents: async (accepted, now) =>
      (await applyAcceptedEvents(db, h.characterId as never, accepted, [], now)).domainEvents,
    /*
     * ==========================================================================
     *  M6.1 WP4 / ADR-055 `D-55b`：本门必须按**生产形状**装配
     * ==========================================================================
     * 生产已经把冲突端口接进显式写入路径（`main.ts` 的 `buildMemoryWriter`）。
     * 本门若少接这一个依赖，就会出现"**门里的显式路径没有冲突分析**" ——
     * 正是 §4.6 ① 要防的那种不一致（共用入口必要不充分：依赖集也必须一致）。
     * 读法与生产**逐字相同**（active + disputed），不另造一套。
     */
    conflict: {
      recordsInCanonicalSlot: async ({ canonicalKey }) => {
        const active = await store.getActiveByCanonicalKey(canonicalKey)
        const disputed = (await store.list({ owner, status: 'disputed', limit: 500 })).filter(
          (record) => record.canonicalKey === canonicalKey
        )
        return [...active, ...disputed]
      },
    },
  })

  // 生产就是从这里进的（轮次级端口），而不是直接调 service
  const port = createExplicitMemoryTurnPort({ service })
  const detector = createExplicitMemoryIntentDetector()

  const intentOf = async (text: string) => {
    const recorded = await h.recordUserEvidence(text)
    const intent = await detectExplicitIntentFromEvent(detector, {
      id: recorded.ref.id as never,
      actorType: 'user',
      content: text,
    })
    return { recorded, intent }
  }

  return {
    h,
    async seed(predicate, value, type) {
      const evidence = await h.recordUserEvidence(`${predicate} 是 ${value}`)
      const record = await h.commitAndFold(
        h.makeCandidate(
          type,
          { kind: 'claim', subject: user, predicate, value } as never,
          { sourceRefs: [evidence.ref] }
        ),
        M4_T0 + 50
      )
      if (record === null) throw new Error(`夹具建立失败：${predicate}`)
    },
    async turn(text) {
      const { recorded, intent } = await intentOf(text)
      const result = await port.handleTurn({
        owner,
        speaker: user,
        event: { id: recorded.ref.id as never, actorType: 'user', content: text },
      })
      if (result === undefined) return { kind: 'no_intent' }
      void intent
      return {
        kind: result.kind,
        ...(result.kind === 'not_written' ? { reason: result.reason } : {}),
      }
    },
    async outcome(text) {
      const { recorded, intent } = await intentOf(text)
      if (intent === undefined) return { ok: false, reason: 'no_intent' }
      const out = await service.handle({
        owner,
        intent,
        triggerEventId: recorded.ref.id as never,
        speaker: user,
        hints: targetHintsFrom(intent),
      })
      return out.ok ? { ok: true } : { ok: false, reason: out.reason }
    },
    async activeValues() {
      const rows = await store.list({ owner, status: 'active', limit: 50 })
      return rows.map((r) =>
        r.content.kind === 'claim' ? `${r.content.predicate}=${String(r.content.value)}` : r.content.summary
      )
    },
    hash: async () => (await snapshotOf(store, owner)).hash,
    async dispose() {
      await h.stop()
      await resetPluginSqlConnection()
      cleanupSandbox(sandbox.dir)
    },
  }
}


// ===========================================================================
// L3-01 受支持的 remember：必须真的写进去
// ===========================================================================
const scenarioL301 = async (): Promise<void> => {
  report.section('L3-01 受支持的 remember（记住，我不吃香菜）')
  const s = await openScenario('supported-remember')
  try {
    const before = await countsOf(s.h.db, s.h.owner)
    const r = await s.turn('记住，我不吃香菜')
    const after = await countsOf(s.h.db, s.h.owner)
    const values = await s.activeValues()
    report.check(
      'L3-01：受支持的说法**真的**写入了（active +1）',
      after.active === before.active + 1,
      `active ${before.active} → ${after.active}｜turn=${r.kind}`
    )
    report.check(
      'L3-01：落进了登记槽位 food.preference.cilantro',
      values.some((v) => v.startsWith('food.preference.cilantro')),
      values.join(' | ')
    )
    report.check(
      'L3-01：这一轮的 turn 结果是 written / already_applied（不是 not_written）',
      r.kind === 'written' || r.kind === 'already_applied',
      r.kind
    )
  } finally {
    await s.dispose()
  }
}

// ===========================================================================
// L3-02 不受支持的 remember：**无写入**，且事实是 not_written
// ===========================================================================
const scenarioL302 = async (): Promise<void> => {
  report.section('L3-02 不受支持的说法（记住，我平时主要用 VS Code）')
  const s = await openScenario('unsupported-remember')
  try {
    const before = await countsOf(s.h.db, s.h.owner)
    const r = await s.turn('记住，我平时主要用 VS Code')
    const after = await countsOf(s.h.db, s.h.owner)
    report.check(
      'L3-02：不受支持的说法**没有**写入任何东西（不是假成功）',
      after.memories === before.memories && after.active === before.active,
      `total ${before.memories} → ${after.memories}｜active ${before.active} → ${after.active}`
    )
    report.check(
      'L3-02：turn 结果如实是 not_written，原因是 content_unresolved',
      r.kind === 'not_written' && r.reason === 'content_unresolved',
      `kind=${r.kind} reason=${String(r.reason)}`
    )
  } finally {
    await s.dispose()
  }
}

// ===========================================================================
// L3-03 正确 forget：只撤那条
// ===========================================================================
const scenarioL303 = async (): Promise<void> => {
  report.section('L3-03 正确 forget（目标真的存在）')
  const s = await openScenario('correct-forget')
  try {
    await s.seed('education.institution', '示例工程科技大学', 'person_fact')
    const before = await countsOf(s.h.db, s.h.owner)
    const r = await s.turn('忘掉我在示例工程科技大学上学这件事')
    const after = await countsOf(s.h.db, s.h.owner)
    report.check(
      'L3-03：真的产生 retract',
      after.retracted === before.retracted + 1,
      `retracted ${before.retracted} → ${after.retracted}｜turn=${r.kind}`
    )
    report.check('L3-03：turn 结果是 written', r.kind === 'written', r.kind)
  } finally {
    await s.dispose()
  }
}

// ===========================================================================
// L3-08 中文说法必须经**登记表**命中槽位（Layer D 抓到的缺口的离线复现）
// ===========================================================================
const scenarioL308 = async (): Promise<void> => {
  report.section('L3-08 中文说法经登记表命中（香菜 → food.preference.cilantro）')
  /*
   * 这一条补的是一个**真实发生过**的缺口，而且是 Layer D 抓到的：
   *
   *   第一版相关性闸只拿 `predicate + value` 当 haystack，于是
   *   「忘掉我不吃香菜这件事」匹配不到 `food.preference.cilantro = dislike`
   *   （"香菜"只存在于英文键与登记表的中文说明里）→ not_found
   *   → **用户明确要求忘掉的那条，系统说找不到**。
   *
   * 当时离线的 A/B/C 三层全绿 —— 因为它们的夹具恰好都是
   * "值里含中文"的形状（示例工程科技大学 / VS Code）。
   *
   * 现在把它钉在离线：以后同类缺口不必再等真实冒烟。
   */
  const s = await openScenario('registry-surface')
  try {
    await s.seed('food.preference.cilantro', 'dislike', 'preference')
    const before = await countsOf(s.h.db, s.h.owner)
    const r = await s.turn('忘掉我不吃香菜这件事')
    const after = await countsOf(s.h.db, s.h.owner)
    report.check(
      'L3-08：用户说的"香菜"能命中 `food.preference.cilantro`（真的 retract）',
      after.retracted === before.retracted + 1,
      `retracted ${before.retracted} → ${after.retracted}｜turn=${r.kind}/${String(r.reason)}`
    )
    report.check(
      'L3-08：那一槽位不再 active',
      !(await s.activeValues()).some((v) => v.includes('cilantro')),
      (await s.activeValues()).join(' | ')
    )
  } finally {
    await s.dispose()
  }
}

// ===========================================================================
// L3-04 无关 forget：**一个字都不能改**
// ===========================================================================
const scenarioL304 = async (): Promise<void> => {
  report.section('L3-04 无关 forget（D1 的原形）')
  const s = await openScenario('unrelated-forget')
  try {
    await s.seed('education.institution', '示例工程科技大学', 'person_fact')
    const beforeHash = await s.hash()
    const before = await countsOf(s.h.db, s.h.owner)
    const r = await s.turn('忘掉我养过一只鹦鹉这件事')
    const afterHash = await s.hash()
    const after = await countsOf(s.h.db, s.h.owner)
    report.check(
      'L3-04：库**一个字段都没变**（这是 D1 的正面复现）',
      beforeHash === afterHash,
      beforeHash === afterHash ? `哈希 ${afterHash.slice(0, 12)}…` : '哈希变了 —— D1 回归！'
    )
    report.check(
      'L3-04：没有新增任何领域事件',
      after.domainEvents === before.domainEvents,
      `${before.domainEvents} → ${after.domainEvents}`
    )
    report.check(
      'L3-04：她如实说"没找到"（target_not_found），而不是声称删了',
      r.kind === 'not_written' && r.reason === 'target_not_found',
      `kind=${r.kind} reason=${String(r.reason)}`
    )
    report.check(
      'L3-04：那条示科记忆仍然 active',
      (await s.activeValues()).some((v) => v.includes('示例工程科技大学')),
      (await s.activeValues()).join(' | ')
    )
  } finally {
    await s.dispose()
  }
}

// ===========================================================================
// L3-05 模糊 forget（多候选）：不得挑一条
// ===========================================================================
const scenarioL305 = async (): Promise<void> => {
  report.section('L3-05 模糊 forget（两条候选都不明确）')
  const s = await openScenario('ambiguous-forget')
  try {
    await s.seed('tooling.preference.editor', 'VS Code', 'preference')
    await s.seed('project.background.active', 'Rust', 'person_fact')
    const beforeHash = await s.hash()
    const before = await countsOf(s.h.db, s.h.owner)
    const r = await s.turn('忘掉刚才说的那件事')
    const afterHash = await s.hash()
    const after = await countsOf(s.h.db, s.h.owner)
    report.check('L3-05：库没有变化', beforeHash === afterHash, beforeHash === afterHash ? '未变' : '变了')
    report.check(
      'L3-05：如实报 not_written（找不到 / 判不出），而不是猜着删',
      r.kind === 'not_written',
      `kind=${r.kind} reason=${String(r.reason)}`
    )
    report.check(
      'L3-05：两条候选都还在',
      after.active === before.active && after.active === 2,
      `active ${before.active} → ${after.active}`
    )
  } finally {
    await s.dispose()
  }
}

// ===========================================================================
// L3-06 端到端：一句含糊的话之后，库与"执行结果"一致
// ===========================================================================
const scenarioL306 = async (): Promise<void> => {
  report.section('L3-06 执行结果与库状态一致（C23 的离线半边）')
  const s = await openScenario('consistency')
  try {
    await s.seed('education.institution', '示例工程科技大学', 'person_fact')
    const beforeHash = await s.hash()

    const r = await s.outcome('忘掉我养过一只鹦鹉这件事')
    const afterHash = await s.hash()

    report.check(
      'L3-06：服务如实报 ok=false（不是 ok=true 而库里没动）',
      r.ok === false,
      `ok=${String(r.ok)} reason=${String(r.reason)}`
    )
    report.check(
      'L3-06：报失败时，库**确实**没有被改动 —— 声明与事实一致',
      beforeHash === afterHash,
      beforeHash === afterHash ? '未变' : '变了'
    )
  } finally {
    await s.dispose()
  }
}

// ===========================================================================
// L3-07 确定性：同一句话跑两次结论相同
// ===========================================================================
/*
 * ⚠️⚠️ **为什么拆成两个场景**（2026-10-21 实测改）
 *
 * 原来的写法是：**同一个进程**里顺序跑两个库，然后比较两次的结论。
 *
 * 在 PostgreSQL 后端下这**撞上产品不变量**：
 *   「本进程已经打开过另一个 PostgreSQL 目标，不能再换一个」
 *   ⇒ `second_postgres_target_in_process`（实测 2026-10-21）。
 * 而这条不变量**不许放松**（计划 §3 P0.4：多空库场景用独立子进程）。
 *
 * ⇒ 拆成两个**场景**（= 两个进程 = 两个独立库）：
 *   · `L3-07a`：在库 A 上跑一次，把结论写进 `artifacts/m4.1/determinism-a.json`；
 *   · `L3-07b`：在库 B 上跑一次，读 A 的结论**对照**，然后把 A 的文件删掉。
 *
 * ⚠️ 删掉 A 的文件是刻意的：这样"只跑 L3-07b"时**不会**拿上一轮的旧文件当对照
 *    （那会让一个**过期的绿**冒充确定性成立）—— 缺对照就如实报"对照组缺失"。
 */
const DETERMINISM_DIR = join(process.cwd(), 'artifacts', 'm4.1')
interface DeterminismReading {
  kind: string
  reason?: string
}
function writeDeterminism (file: string, value: DeterminismReading): void {
  mkdirSync(DETERMINISM_DIR, { recursive: true })
  writeFileSync(join(DETERMINISM_DIR, file), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
function readDeterminism (file: string): DeterminismReading | undefined {
  const path = join(DETERMINISM_DIR, file)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DeterminismReading
  } catch {
    return undefined
  }
}

const runDeterminismOnce = async (label: string): Promise<DeterminismReading> => {
  const s = await openScenario(label)
  try {
    await s.seed('education.institution', '示例工程科技大学', 'person_fact')
    const result = await s.turn('忘掉我养过一只鹦鹉这件事')
    return { kind: result.kind, ...(result.reason === undefined ? {} : { reason: result.reason }) }
  } finally {
    await s.dispose()
  }
}

const scenarioL307a = async (): Promise<void> => {
  report.section('L3-07a 确定性（第一次：独立库 A）')
  const reading = await runDeterminismOnce('determinism-a')
  writeDeterminism('determinism-a.json', reading)
  // 上一轮留下的 B 读数作废（否则下一次只跑 B 会拿到过期对照）
  rmSync(join(DETERMINISM_DIR, 'determinism-b.json'), { force: true })
  report.check(
    'L3-07a：第一次的结论已记录（独立库 A）',
    true,
    `${reading.kind}/${String(reading.reason)}`
  )
}

const scenarioL307b = async (): Promise<void> => {
  report.section('L3-07b 确定性（第二次：独立库 B）+ 与 A 对照')
  const reading = await runDeterminismOnce('determinism-b')
  writeDeterminism('determinism-b.json', reading)
  const a = readDeterminism('determinism-a.json')
  if (a === undefined) {
    report.check(
      'L3-07：对照组（A）缺失 —— **无法判定**确定性（不是通过）',
      false,
      '先跑 L3-07a（逐场景 harness 会按清单顺序跑）'
    )
    return
  }
  report.check(
    'L3-07：两个独立库上得到**同一个**结论',
    a.kind === reading.kind && a.reason === reading.reason,
    `${a.kind}/${String(a.reason)} vs ${reading.kind}/${String(reading.reason)}`
  )
  // 对照用过即焚 ⇒ 下一轮不会拿到过期对照
  rmSync(join(DETERMINISM_DIR, 'determinism-a.json'), { force: true })
}

// ===========================================================================
// L3-09 / L3-10 / L3-11（M6.1 WP4 / ADR-055）：冲突分析真的接上了吗
// ===========================================================================
/*
 * 这三条是 A（`D-55b`）的**行为判据**。注意它们与生产装配的关系：
 * `openScenario` 上面的服务构造已经按生产形状注入了冲突端口 —— 少接它，
 * 这三条会全部退回"又建一条"的旧行为（那正是修复前实测到的样子）。
 */
const scenarioL309 = async (): Promise<void> => {
  report.section('L3-09 无标记的矛盾（记住，我吃辣）：旧条转 disputed，且**不新建**')
  const s = await openScenario('nomarker-conflict')
  try {
    await s.seed('food.avoid.general', '回避辣', 'preference')
    const r = await s.turn('记住，我吃辣')
    const active = await s.h.store.list({ owner: s.h.owner, status: 'active', limit: 50 })
    const disputed = await s.h.store.list({ owner: s.h.owner, status: 'disputed', limit: 50 })
    /*
     * ⚠️ 槽位的 `canonicalKey` 是**哈希**（例如 `2588b1bb882feba6`），不是谓词字符串
     * —— 第一版这里直接传了 `'food.avoid.general'`，于是数出 0 条，把"没有新建"
     * 误报成失败。正确做法是**用记录自己的 canonicalKey** 去数它所在的槽位。
     */
    const slotKey = (disputed[0] ?? active[0])?.canonicalKey
    const inSlot =
      slotKey === undefined ? [] : await s.h.store.listByCanonicalKey(String(slotKey))
    report.check(
      'L3-09：该槽位**没有** active 值（判不出是更新还是矛盾时，不擅自选一个）',
      active.length === 0,
      `active=${String(active.length)} turn=${r.kind}`
    )
    report.check('L3-09：旧条已转 `disputed`', disputed.length === 1, `disputed=${String(disputed.length)}`)
    report.check(
      'L3-09：**没有新建第二条**（这正是修复前"两条 active"的反面）',
      inSlot.length === 1,
      `槽位内记录数=${String(inSlot.length)}`
    )
  } finally {
    await s.dispose()
  }
}

const scenarioL310 = async (): Promise<void> => {
  report.section('L3-10 有标记的更正（记住，我现在吃辣了）：新建 + 旧条 superseded')
  const s = await openScenario('marker-supersede')
  try {
    await s.seed('food.avoid.general', '回避辣', 'preference')
    const r = await s.turn('记住，我现在吃辣了')
    const active = await s.h.store.list({ owner: s.h.owner, status: 'active', limit: 50 })
    const superseded = await s.h.store.list({ owner: s.h.owner, status: 'superseded', limit: 50 })
    /* 同 L3-09：`canonicalKey` 是哈希，必须用记录自己的键去数槽位 */
    const slotKey = (active[0] ?? superseded[0])?.canonicalKey
    const inSlot =
      slotKey === undefined ? [] : await s.h.store.listByCanonicalKey(String(slotKey))
    report.check(
      'L3-10：新值成为**唯一** active',
      active.length === 1 &&
        active[0]?.content.kind === 'claim' &&
        String((active[0].content as { value?: unknown }).value) === '喜欢辣',
      active.map((x) => JSON.stringify(x.content)).join(' | ')
    )
    report.check(
      'L3-10：旧条转 `superseded`（不是删除、也不是仍 active）',
      superseded.length === 1,
      `superseded=${String(superseded.length)} turn=${r.kind}`
    )
    report.check(
      'L3-10：取代链两头都在（同一槽位两条记录）',
      inSlot.length === 2,
      `槽位内记录数=${String(inSlot.length)}`
    )
  } finally {
    await s.dispose()
  }
}

const scenarioL311 = async (): Promise<void> => {
  report.section(
    'L3-11 误触发负控（冻结集 correction_intent_negative_v1：12 条 = 6 类 × 2）⇒ 库零变化'
  )
  const s = await openScenario('false-trigger')
  try {
    await s.seed('food.avoid.general', '回避辣', 'preference')
    /*
     * ==========================================================================
     *  M6.1 WP4 / ADR-055 §4.4 ②（用户冻结）：5 条 → **12 条**
     * ==========================================================================
     * 判据是 **mutation 级**：逐条断言**库摘要不变**（0 次未经请求的记忆变更）；
     * 「检测器是否命中」**不作**判据 —— 这是 §18.5 那条边界的落点：
     * 例如「帮我把这段文字改一下。」仍会命中既有的「改一下」子串线索，
     * 但目标解析不出来 ⇒ 服务如实回报、一个字节都没改。
     *
     * ⚠️ 文本**从冻结集读**，不在这里手抄：手抄一份就等于造了第二个语料来源
     *    （而"门读的语料"与"冻结的语料"漂移时，门会绿得没有意义）。
     * ⚠️ 集自身的合格性也要判，且必须有**非零分母**：条目为 0 / 某类少一条 /
     *    漏了 `mustNotChangeMemory` 都要红 —— 否则"没测到"会显示成"全合格"（AGENTS §6.8）。
     */
    const items = loadCorrectionNegativeSet(process.cwd())
    const problems = validateCorrectionNegativeSet(items)
    report.check(
      'L3-11 前置：冻结集自身合格（12 条 · 6 类 × 2 · 每条声明 mustNotChangeMemory）',
      problems.length === 0,
      problems.length === 0 ? `${String(items.length)} 条，全部合格` : problems.join('; ')
    )
    if (problems.length > 0) {
      /*
       * 集不合格 ⇒ 逐条读数**没有意义**。如实标成"没测到"，不拿它冒充读数
       * （这正是 `MEASUREMENT INVALID` 与"全过"必须分开的那条纪律）。
       */
      report.check(
        'L3-11：集不合格 ⇒ 本段读数无效（MEASUREMENT INVALID，不是 PASS）',
        false,
        '冻结集未通过自检，见上一条'
      )
    } else {
      for (const item of items) {
        const before = await s.hash()
        await s.turn(item.text)
        const after = await s.hash()
        report.check(
          `L3-11：[${item.category}] ${item.id}「${item.text}」⇒ **0 次未经请求的记忆变更**`,
          before === after,
          before === after ? '未变' : '**变了**'
        )
      }
    }
  } finally {
    await s.dispose()
  }
}

// ===========================================================================
// 场景清单（2026-10-21 · 逐场景子进程）
// ===========================================================================
/**
 * 每个场景 = 一条用例，**各自需要一个空白库**。
 *
 * ⚠️ 为什么要有这个清单：PostgreSQL 后端下 `isolateDatabase()` **给不出空白库**
 *    （它只把 URL 再指一次）⇒ 场景之间会互相污染（实测：`duplicate_content`）。
 *    ⇒ 逐场景**子进程**是唯一的干净解法（进程边界 + 库边界；
 *      产品那条"同进程只允许一个 PostgreSQL 目标"的不变量**一字未动**）。
 *
 * ⇒ 场景 id 的**唯一事实源在这里**；`--list-cases` 就是它对外的读面。
 */
const SCENARIOS: Array<{ id: string; run: () => Promise<void>; extraDatabases?: number }> = [
  { id: 'L3-01', run: scenarioL301 },
  { id: 'L3-02', run: scenarioL302 },
  { id: 'L3-03', run: scenarioL303 },
  { id: 'L3-08', run: scenarioL308 },
  { id: 'L3-04', run: scenarioL304 },
  { id: 'L3-05', run: scenarioL305 },
  { id: 'L3-06', run: scenarioL306 },
  { id: 'L3-07a', run: scenarioL307a },
  { id: 'L3-07b', run: scenarioL307b },
  { id: 'L3-09', run: scenarioL309 },
  { id: 'L3-10', run: scenarioL310 },
  { id: 'L3-11', run: scenarioL311 },
]

const argv = process.argv.slice(2)
if (argv.includes('--list-cases')) {
  /*
   * 每行：`id<TAB>额外独立库数`
   * ⇒ 逐场景 harness 只读这一份，不用在别处复述场景清单。
   */
  for (const scenario of SCENARIOS) {
    console.log(`${scenario.id}\t${String(scenario.extraDatabases ?? 0)}`)
  }
  process.exit(0)
}
const caseIndex = argv.indexOf('--case')
const onlyCase = caseIndex >= 0 ? argv[caseIndex + 1] : undefined
if (onlyCase !== undefined && !SCENARIOS.some(s => s.id === onlyCase)) {
  console.error(`❌ 没有这个场景：${onlyCase}`)
  console.error(`   可用：${SCENARIOS.map(s => s.id).join(' / ')}`)
  process.exit(2)
}
console.log('='.repeat(72))
console.log('M4.1 自然语言集成覆盖（Layer C / G12）')
console.log('='.repeat(72))
for (const scenario of SCENARIOS) {
  if (onlyCase !== undefined && scenario.id !== onlyCase) continue
  await scenario.run()
}

mkdirSync(evidenceDir, { recursive: true })
writeFileSync(
  join(evidenceDir, onlyCase === undefined ? 'nl-mutation.json' : `nl-mutation.${onlyCase}.json`),
  `${JSON.stringify(
    {
      testId: 'M4.1 / Layer C / G12',
      name: 'Natural-Language Mutation Integration',
      priority: 'P0',
      status: report.failed === 0 ? 'PASS' : 'FAIL',
      discipline: '禁止传 memoryId；只从用户真实文本进入；生产同构装配',
      scenario: onlyCase ?? '(全部场景)',
      checks: { passed: report.passed, failed: report.failed, failures: report.failures },
    },
    null,
    2
  )}\n`,
  'utf8'
)

report.finish(onlyCase === undefined ? 'M4.1 自然语言集成覆盖' : `M4.1 自然语言集成覆盖 · ${onlyCase}`)
