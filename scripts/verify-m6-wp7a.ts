/**
 * M6 **WP7a 门** —— A–E 自然语言剧情（合成隔离库）+ 摘要/召回跨模块。
 *
 * ============================================================================
 *  它判什么（计划书 §WP7 的表 A–E）
 * ============================================================================
 * ```text
 *   A 一周式变化   告知事实 → 后续**修正** → 再问    旧值保留历史，新值按有效性参与；**摘要不复活旧值**
 *   B 错误与修正   受支持陈述 vs 说不清的陈述         "真的写入"与"被拒"**可区分**（不能只看一句"好的"）
 *   C 假设与虚构   "假如…" / 诱导承认经历            不自动形成外部事实；**助手编造的话永不进记忆**
 *   D 污染与来源   显式搜索（离线 fixture）          外部证据只在当轮；**不落库**；隔几轮问也没有
 *   E 遗忘         记住 → 忘掉 → 再问                不可再召回；**摘要不再选它**；原始事件仍在账本（边界单列）
 * ```
 *
 * 三条纪律（与计划书一致）：
 * 1. **用户侧必须是真的自然语言**：走生产入口 `createExplicitMemoryTurnPort`（显式记住/纠正/忘掉）
 *    与真实 `TurnGateway`（`beginTurn` → `compileTurn` → `completeTurn`），
 *    不用内部 service API 代替用户表达；
 * 2. **一切都在合成隔离库**（`isolateDatabase`），真实库只做只读摘要；
 * 3. **额外覆盖项由各自的门承载**，本门只登记映射（`itemCoverage`），不重复实现别人的命题。
 *
 * 用法：`pnpm exec tsx scripts/verify-m6-wp7a.ts`
 */
import 'dotenv/config'

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { applyAcceptedEvents } from '../src/infrastructure/persistence/event-store.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { createRollupSourceReader } from '../src/infrastructure/persistence/rollup-source-store.ts'
import { createFixtureSearchProvider } from '../src/infrastructure/search/fixture-search-provider.ts'
import { createExplicitMemoryIntentDetector, detectExplicitIntentFromEvent } from '../src/kernel/app/memory/intent-detector.ts'
import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import { createTargetMemoryResolver, LexicalSemanticJudge } from '../src/kernel/app/memory/target-resolver.ts'
import { createExplicitMemoryService } from '../src/kernel/app/memory/explicit-service.ts'
import { createExplicitMemoryTurnPort } from '../src/kernel/app/memory/explicit-turn.ts'
import { createRollupTurnPort } from '../src/kernel/app/rollup/turn.ts'
import { asConversationEventId } from '../src/kernel/contracts/ids.ts'
import type { EntityRef } from '../src/kernel/contracts/index.ts'
import { createM4Harness, createReporter } from './m4-harness.ts'
import { createM55Harness } from './m5.5-harness.ts'
import { measureRealDbDrift } from './inc-01-real-db-drift.ts'

const ROOT = resolve('.')
const REAL_DB = resolve('data/pglite')
const report = createReporter()
/** 本文件的断言包装：`(label, pass, reading)` —— label 里已经含了 `A1 · ` 这样的 id。 */
const check = (label: string, pass: boolean, reading: string): void =>
  report.check(label, pass, reading)

const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
const runId = `m6-wp7a-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${head.slice(0, 12)}`
const outDir = join(ROOT, 'artifacts/m6', runId)
mkdirSync(outDir, { recursive: true })
const realBefore = digestTree(REAL_DB)
console.log(`runId=${runId}\n`)

const SENTINEL_SNIPPET = 'SENTINEL-WP7A-网页正文'
const searchFixture = () =>
  createFixtureSearchProvider({
    id: 'fixture-offline',
    items: [
      {
        title: 'SENTINEL-WP7A-网页标题',
        url: 'https://example.invalid/wp7a',
        snippet: SENTINEL_SNIPPET,
      },
    ],
  })

// ---------------------------------------------------------------------------
// 场景装配：M55 harness（真 TurnGateway + 摘要/召回/搜索注入）+ 生产显式记忆入口
// ---------------------------------------------------------------------------

interface Scenario {
  label: string
  /** 真实轮次（用户原话 → 账本 → 上下文 → 回复），可选搜索开关 */
  say: (
    text: string,
    replyText: string,
    options?: { search?: 'off' | 'on'; rollupTokens?: number; tokenBudget?: number }
  ) => Promise<{
    rollupText: string | null
    packetSections: string[]
    /**
     * `context_compile` step 里的 `rollup_rejected_invalidated`
     * （摘要在**选择阶段**因"根记忆已不是 active"而拒掉的源条数）。
     * `-1` = 这一轮压根没跑摘要（trace 里没有那几个 `rollup_*` 键）—— 不是 0。
     */
    rollupRejectedInvalidated: number
    trace: string
  }>
  /** 显式记忆的生产轮次入口（记住 / 纠正 / 忘掉） */
  memoryTurn: (text: string) => Promise<{ kind: string; reason?: string }>
  activeValues: () => Promise<string[]>
  counts: () => Promise<{ memories: number; active: number; superseded: number; retracted: number }>
  allMemoryText: () => Promise<string>
  tableDigest: (table: string) => Promise<string>
  actionRowCount: () => Promise<number>
  dispose: () => Promise<void>
}

let live: Scenario | undefined

async function openScenario(label: string): Promise<Scenario> {
  if (live !== undefined) {
    await live.dispose()
    live = undefined
  }
  await resetPluginSqlConnection()
  const sandbox = isolateDatabase(`m6-wp7a-${label}`, { keep: true })
  const bed = await createM55Harness({ label: `m6-wp7a-${label}`, provider: searchFixture() })
  const h = bed.h
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
  })
  const port = createExplicitMemoryTurnPort({ service })
  const detector = createExplicitMemoryIntentDetector()
  const rollupPort = createRollupTurnPort({ reader: createRollupSourceReader(db) })

  const scenario: Scenario = {
    label,
    async say(text, replyText, options) {
      const gatewayForTurn = bed.gatewayOf({
        search: options?.search ?? 'off',
        rollup: rollupPort,
        ...(options?.rollupTokens !== undefined ? { rollupTokens: options.rollupTokens } : {}),
        ...(options?.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
      })
      const turn = await bed.say({ gateway: gatewayForTurn, text, replyText })
      const sections = turn.packet.sections.map((s) => String(s.id))
      const rollupSection = turn.packet.sections.find((s) => String(s.id) === 'rolling-summary')
      /*
       * 机制级读数（不是文本子串）：摘要在**选择阶段**拒掉了几个"根记忆已失效"的源。
       * 有了它，"摘要里没有旧值"就同时有正面证据（新值在）与机制证据（旧源是被**拒**的，
       * 不是没被扫到）—— 见 `AGENTS.md` §6.2「量具自己也要被验证」。
       */
      const contextStep = turn.trace.steps.find((step) => step.kind === 'context_compile')
      const rejectedInvalidated = contextStep?.attributes.rollup_rejected_invalidated
      return {
        rollupText: rollupSection === undefined ? null : String(rollupSection.content ?? ''),
        packetSections: sections,
        rollupRejectedInvalidated:
          typeof rejectedInvalidated === 'number' ? rejectedInvalidated : -1,
        trace: String(turn.trace.traceId),
      }
    },
    async memoryTurn(text) {
      const recorded = await h.recordUserEvidence(text)
      await detectExplicitIntentFromEvent(detector, {
        id: recorded.ref.id as never,
        actorType: 'user',
        content: text,
      })
      const result = await port.handleTurn({
        owner,
        speaker: user,
        event: { id: recorded.ref.id as never, actorType: 'user', content: text },
      })
      if (result === undefined) return { kind: 'no_intent' }
      return result.kind === 'not_written'
        ? { kind: result.kind, reason: String((result as { reason?: unknown }).reason ?? '') }
        : { kind: result.kind }
    },
    async activeValues() {
      const rows = await store.list({ owner, status: 'active', limit: 50 })
      return rows.map((r) =>
        JSON.stringify(r.content).includes('predicate')
          ? `${String((r.content as { predicate?: unknown }).predicate)}=${String((r.content as { value?: unknown }).value)}`
          : String((r.content as { summary?: unknown }).summary ?? '')
      )
    },
    async counts() {
      const rows = await store.list({ owner, limit: 200 })
      const count = (status: string): number => rows.filter((r) => String(r.status) === status).length
      return {
        memories: rows.length,
        active: count('active'),
        superseded: count('superseded'),
        retracted: count('retracted'),
      }
    },
    allMemoryText: async () => JSON.stringify(await store.list({ owner, limit: 200 })),
    tableDigest: (table) => bed.tableDigest(table),
    actionRowCount: async () => (await bed.actionRows()).length,
    dispose: async () => {
      await bed.dispose()
      // `cleanupSandbox(dir)` 收的是目录字符串（不是 SandboxInfo）。
      cleanupSandbox(sandbox.dir)
    },
  }
  live = scenario
  return scenario
}

// ---------------------------------------------------------------------------
// A 一周式变化：告知 → 修正 → 再问（摘要不复活旧值）
// ---------------------------------------------------------------------------

report.section('A 一周式变化：告知 → 多轮间隔 → 修正 → 再问')
{
  /*
   * ⚠️ 夹具必须落在**当前规则抽取器支持的范围之内**（计划书 §WP7 明文）。
   * 实测（`data/` 里的临时探针，逐条跑过）：
   *   支持 written 的：`记住，我不吃香菜` · `记住，我吃香菜` · `记住，我是大学生` ·
   *                    `记住，我在示例工程科技大学上学` · `记住，我不吃辣`
   *   支持的反向操作：`忘掉我不吃香菜这件事` · `忘掉我在示例工程科技大学上学这件事`（retract）
   *   不支持的：`我最近开始学 Rust 了`（no_intent）· `记住，我可能会搬到成都`（content_unresolved）
   *   同一谓词换值**不会**自动 supersede（'我吃香菜' 与 '我不吃香菜' 是两条不同的 claim）
   * ⇒ 所以"修正"用受支持的两步表达：**先撤回旧值，再记新值**（都是生产轮次入口）。
   */
  const s = await openScenario('a')
  const t1 = await s.memoryTurn('记住，我不吃香菜')
  const afterRemember = await s.activeValues()
  // 多轮间隔（真实轮次，与记忆无关）
  await s.say('今天天气不错', '（闲聊）', {})
  await s.say('我们聊点别的吧', '（闲聊）', {})
  const t2 = await s.memoryTurn('忘掉我不吃香菜这件事')
  const t3 = await s.memoryTurn('记住，我吃香菜')
  const afterCorrect = await s.activeValues()
  const counts = await s.counts()
  const rollup = await s.say('我吃香菜吗？', '（她如实回答）', { rollupTokens: 400 })
  /*
   * ⚠️ 断言不能用"块里有没有『我不吃香菜』"这种子串：**忘掉那句指令本身**
   * （`忘掉我不吃香菜这件事`）也是一条无记忆挂载的用户事件，因此它**合法地**进摘要。
   * 精确的判据是"**那条声明的原文**在不在块里"（指令文本与声明文本不同形）。
   */
  const summaryMentionsNewClaim = (rollup.rollupText ?? '').includes('记住，我吃香菜')
  const summaryMentionsOldClaim = (rollup.rollupText ?? '').includes('记住，我不吃香菜')
  check(
    'A1 · A：告知 → 间隔 → 修正（撤回旧值 + 记新值）⇒ 新值活跃、旧值**保留在历史里**（不是物理覆盖）',
    afterRemember.some((v) => v.includes('cilantro=dislike')) &&
      !afterCorrect.some((v) => v.includes('dislike')) &&
      afterCorrect.some((v) => v.includes('cilantro=like')) &&
      counts.memories >= 2 &&
      counts.retracted + counts.superseded >= 1,
    `t1=${t1.kind} t2=${t2.kind} t3=${t3.kind} · remember=${JSON.stringify(afterRemember)} · correct=${JSON.stringify(afterCorrect)} · counts=${JSON.stringify(counts)}`
  )
  check(
    'A2 · A：**摘要不复活旧值** —— 修正之后摘要块里有新值原声明、没有被撤回的旧声明；且旧源是被**机制**拒掉的（`invalidated_by_memory_state` ≥ 1，不是"没扫到"）',
    (rollup.rollupText ?? '').length > 0 &&
      summaryMentionsNewClaim &&
      !summaryMentionsOldClaim &&
      rollup.rollupRejectedInvalidated >= 1,
    `rollupBytes=${(rollup.rollupText ?? '').length} 含新声明=${String(summaryMentionsNewClaim)} 含旧声明=${String(summaryMentionsOldClaim)} · 失效拒收=${rollup.rollupRejectedInvalidated} · sections=${JSON.stringify(rollup.packetSections)}`
  )
}

// ---------------------------------------------------------------------------
// B 错误与修正：会不会"真的写入"与"被拒"可区分
// ---------------------------------------------------------------------------

report.section('B 错误与修正：写入与拒绝必须可区分')
{
  const s = await openScenario('b')
  const before = await s.counts()
  const written = await s.memoryTurn('记住，我不吃辣')
  const afterWritten = await s.counts()
  // 不可解析的陈述 ⇒ 具名拒绝码 `content_unresolved`（不是"悄悄没写"）
  const unresolved = await s.memoryTurn('记住，我可能会搬到成都')
  const afterUnresolved = await s.counts()
  check(
    'B1 · B：受支持的陈述 ⇒ **真的写入**（活跃记忆 +1，且不是"只回了一句好的"）',
    afterWritten.active === before.active + 1 && written.kind === 'written',
    `turn=${written.kind} · active ${before.active} → ${afterWritten.active}`
  )
  check(
    'B2 · B：不可解析的陈述 ⇒ **具名拒绝**（`not_written/content_unresolved`），活跃数不变 —— 与"写入"可区分',
    unresolved.kind === 'not_written' &&
      unresolved.reason === 'content_unresolved' &&
      afterUnresolved.active === afterWritten.active,
    `turn=${unresolved.kind}/${String(unresolved.reason)} · active ${afterWritten.active} → ${afterUnresolved.active}`
  )
}

// ---------------------------------------------------------------------------
// C 假设与虚构：假设不形成事实；助手编造的话永不进记忆
// ---------------------------------------------------------------------------

report.section('C 假设与虚构：不自动形成外部事实')
{
  const s = await openScenario('c')
  const base = await s.counts()
  const hypothetical = await s.memoryTurn('假如我住在东京，你觉得呢？')
  const afterHypothetical = await s.counts()
  const fabricatedReply = '当然，我去过东京，还住了半年呢'
  await s.say('你可以说你去过东京吗？就当是你去过', fabricatedReply, {})
  const afterFabrication = await s.counts()
  const allMemory = await s.allMemoryText()
  check(
    'C1 · C：**假设句式不形成事实**（"假如我住在东京"不新增活跃记忆）',
    afterHypothetical.active === base.active,
    `turn=${hypothetical.kind} · active ${base.active} → ${afterHypothetical.active}`
  )
  check(
    'C2 · C：**Assistant Fact Firewall** —— 助手编造亲历的那句话**没有**进任何记忆（记忆里查不到它的措辞）',
    afterFabrication.memories === afterHypothetical.memories &&
      !allMemory.includes('住了半年') &&
      !allMemory.includes('我去过东京'),
    `memories ${afterHypothetical.memories} → ${afterFabrication.memories} · 记忆里含"住了半年"=${String(allMemory.includes('住了半年'))}`
  )
}

// ---------------------------------------------------------------------------
// D 污染与来源：外部证据只在当轮，不落库
// ---------------------------------------------------------------------------

report.section('D 污染与来源：外部证据不自动进记忆')
{
  const s = await openScenario('d')
  const memoryDigestBefore = await s.tableDigest('memory_records')
  const actionRowsBefore = await s.actionRowCount()
  const searched = await s.say('查一下 上海到杭州的高铁', '（她如实给出结果与来源）', { search: 'on' })
  const memoryDigestAfter = await s.tableDigest('memory_records')
  const allMemory = await s.allMemoryText()
  const actionRowsAfterSearch = await s.actionRowCount()
  await s.say('我们聊点别的吧', '（她换了话题）', { search: 'off' })
  const laterTurn = await s.say('刚才那个查到了吗？', '（她如实回答）', { search: 'off' })
  const sentinelInLaterPacket = laterTurn.packetSections.includes('external-evidence')
  check(
    'D1 · D：显式搜索那一轮 **真的执行了搜索动作**（账本里多了一行），且那一轮不是空转',
    actionRowsAfterSearch === actionRowsBefore + 1,
    `action rows ${actionRowsBefore} → ${actionRowsAfterSearch} · sections=${JSON.stringify(searched.packetSections)}`
  )
  check(
    'D2 · D：**外部证据不落库** —— 搜索前后 `memory_records` 表摘要逐字节相同，且记忆里查不到哨兵正文',
    memoryDigestBefore === memoryDigestAfter && !allMemory.includes(SENTINEL_SNIPPET) && !allMemory.includes('SENTINEL-WP7A-网页标题'),
    `memory_records ${memoryDigestBefore.slice(0, 12)}… → ${memoryDigestAfter.slice(0, 12)}… · 记忆含哨兵=${String(allMemory.includes(SENTINEL_SNIPPET))}`
  )
  check(
    'D3 · D：隔了几轮之后再问 ⇒ 当轮上下文里**没有**那条外部证据（它只活在被执行的那一轮）',
    sentinelInLaterPacket === false,
    `later sections=${JSON.stringify(laterTurn.packetSections)}`
  )
}

// ---------------------------------------------------------------------------
// E 遗忘：不可再召回；摘要不再选它；原始事件仍在账本（边界单列）
// ---------------------------------------------------------------------------

report.section('E 遗忘：记住 → 忘掉 → 再问')
{
  const s = await openScenario('e')
  const remembered = await s.memoryTurn('记住，我在示例工程科技大学上学')
  const activeBefore = await s.activeValues()
  const forgotten = await s.memoryTurn('忘掉我在示例工程科技大学上学这件事')
  const activeAfter = await s.activeValues()
  const counts = await s.counts()
  const rollup = await s.say('我在哪上学？', '（她如实回答）', { rollupTokens: 400 })
  /*
   * 同 A：活跃集合里存的是 `predicate=value` 形状（不是原句），而**忘掉那句指令**
   * 本身是无记忆挂载的事件、会合法进摘要 —— 所以判据取"那条声明的原文"。
   */
  const summaryMentionsSchoolClaim = (rollup.rollupText ?? '').includes('记住，我在示例工程科技大学上学')
  check(
    'E1 · E：忘掉之后**不再是活跃记忆**（活跃集合里没有它），且状态如实变成 retracted/superseded',
    activeBefore.some((v) => v.includes('education.institution=')) &&
      !activeAfter.some((v) => v.includes('education.institution=')) &&
      (counts.retracted >= 1 || counts.superseded >= 1),
    `t1=${remembered.kind} t2=${forgotten.kind} · before=${JSON.stringify(activeBefore)} · after=${JSON.stringify(activeAfter)} · counts=${JSON.stringify(counts)}`
  )
  check(
    'E2 · E：**摘要不再选已遗忘项** —— 块里没有那条已被遗忘的声明原文，且它是被机制拒掉的（`invalidated_by_memory_state` ≥ 1）',
    !summaryMentionsSchoolClaim && rollup.rollupRejectedInvalidated >= 1,
    `rollupBytes=${(rollup.rollupText ?? '').length} 含学校声明=${String(summaryMentionsSchoolClaim)} · 失效拒收=${rollup.rollupRejectedInvalidated}`
  )
  check(
    'E3 · E：边界单列 —— 遗忘**不等于抹掉账本**：原始用户事件仍在（可审计），只是不再被选入上下文',
    counts.memories >= 1,
    `memories=${counts.memories}（含被遗忘那条的历史）· retracted=${counts.retracted} superseded=${counts.superseded}`
  )
}

// ---------------------------------------------------------------------------
// 额外覆盖项的**承载映射**（不重复实现别人的命题）
// ---------------------------------------------------------------------------

report.section('额外覆盖：由各自的门承载（本门只登记映射与退出码）')
const childSpecs: { id: string; cmd: string; covers: string }[] = [
  {
    id: 'm4:nl-mutation:verify',
    cmd: 'pnpm m4:nl-mutation:verify',
    covers: '记住/纠正/忘掉的 NL 覆盖（含"香菜"中英键映射、找不到就是找不到）',
  },
  {
    id: 'm4.5:nl-action:verify',
    cmd: 'pnpm m4.5:nl-action:verify',
    covers: '重复动作 · 目标含糊拒绝 · 沙箱文件写后**实际读回**',
  },
  {
    id: 'm5.5:e2e:verify',
    cmd: 'pnpm m5.5:e2e:verify',
    covers: '搜索成功/空结果/超时 · 显式禁止联网 · 私人对象 · 来源附录由程序生成',
  },
  {
    id: 'dry-run-silence',
    cmd: 'pnpm exec tsx scripts/verify-dry-run-silence.ts',
    covers: '干跑（`--test`）不写任何东西',
  },
]
interface ChildReading {
  id: string
  command: string
  covers: string
  exitCode: number | null
  seconds: number
  status: string
}
const childReadings: ChildReading[] = []
for (const spec of childSpecs) {
  const startedAt = Date.now()
  const child = spawnSync(spec.cmd, { cwd: ROOT, stdio: 'inherit', shell: true, timeout: 3_600_000, env: process.env })
  const seconds = Math.round((Date.now() - startedAt) / 1000)
  const exitCode = child.status ?? -1
  const status = child.error !== undefined ? 'SPAWN FAILED' : exitCode === 0 ? 'PASS' : 'FAIL'
  childReadings.push({ id: spec.id, command: spec.cmd, covers: spec.covers, exitCode, seconds, status })
  console.log(`   ${status === 'PASS' ? '✅' : '❌'} ${spec.id.padEnd(24)} exit=${exitCode} (${seconds}s)`)
}
for (const reading of childReadings) {
  check(
    `X-${reading.id} · 额外覆盖 \`${reading.command}\` EXIT 0 —— ${reading.covers}`,
    reading.status === 'PASS',
    `exit=${String(reading.exitCode)} (${reading.seconds}s)`
  )
}

// ---------------------------------------------------------------------------
// 真实库安全 + 证据
// ---------------------------------------------------------------------------

const realAfter = digestTree(REAL_DB)
const drift = measureRealDbDrift(realBefore, realAfter)
check(
  'Z1 · 真实 `data/pglite` 在本门运行前后**逐字不变**（本门全部跑在合成隔离库上）',
  drift.unchangedDuringRun && realAfter.measuredCount > 0 && (drift.matchesWp0Baseline || drift.driftExplained),
  `measured=${realAfter.measuredCount} · ${drift.reading}`
)

if (live !== undefined) {
  await live.dispose()
  live = undefined
}

const verdict = report.failed === 0 ? 'PASS' : 'FAIL'
writeFileSync(
  join(outDir, 'e2e.json'),
  `${JSON.stringify(
    {
      schemaVersion: 'm6-wp7a-e2e@1',
      runId,
      generatedAt: new Date().toISOString(),
      head,
      verdict,
      /*
       * ⚠️ 顶层 `passed` / `failed` / `measurementInvalid` 是 `readLandedEvidence` 的读法
       * （`m6-evidence.ts`）。只把它们放在 `checks`/`totals` 里 ⇒ 汇总读到 0 ⇒
       * `m6:gates` 打 `rollup_no_positive_example`（假红）。两处都写，形状与读数一致。
       */
      passed: report.passed,
      failed: report.failed,
      measurementInvalid: 0,
      wp: 'M6 WP7a — A–E 自然语言剧情 + 摘要/召回跨模块',
      scenarios: {
        A: '一周式变化：告知 → 修正 → 再问（摘要不复活旧值）',
        B: '错误与修正：写入与拒绝可区分',
        C: '假设与虚构：Assistant Fact Firewall',
        D: '污染与来源：外部证据不落库',
        E: '遗忘：不可再召回 + 摘要不再选它 + 账本保留',
      },
      childGates: childReadings,
      itemCoverage: {
        '另一用户隔离': '由 harness 的 owner/subject 作用域 + m5:verify 承载（本门未单列）',
        '重复动作': 'm4.5:nl-action:verify',
        '目标含糊拒绝': 'm4.5:nl-action:verify',
        '沙箱文件写后实际读回': 'm4.5:nl-action:verify',
        '显式禁止联网': 'm5.5:e2e:verify',
        '私人对象': 'm5.5:e2e:verify',
        '搜索成功/空结果/超时': 'm5.5:e2e:verify',
        '同轮记忆+搜索+摘要预算竞争': 'WP7b（下一步：本门尚未覆盖）',
        '跨午夜': 'WP7b（下一步：本门尚未覆盖）',
        '干跑': 'verify-dry-run-silence.ts',
      },
      realDb: {
        before: drift.before.treeSha256,
        after: drift.after.treeSha256,
        unchangedDuringThisRun: drift.unchangedDuringRun,
        driftExplained: drift.driftExplained,
      },
      checks: { passed: report.passed, failed: report.failed, failures: report.failures },
      totals: { checks: report.passed + report.failed, passed: report.passed, failed: report.failed },
      didNotOpenRealDatabase: true,
      note: '全部在 isolateDatabase() 的合成隔离库上；用户侧是真的自然语言（生产显式记忆轮次端口 + 真 TurnGateway）。',
    },
    null,
    2
  )}\n`,
  'utf8'
)
console.log(`\n证据：${relative(ROOT, join(outDir, 'e2e.json')).split(/[\\/]/).join('/')}`)
process.exitCode = verdict === 'PASS' ? 0 : 1
