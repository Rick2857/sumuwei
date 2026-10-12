/**
 * M9.1 WP0 —— F-4 / F-1 基线复现（`pnpm m9.1:wp0:repro`）。
 *
 * ============================================================================
 *  这是什么（先读这个再改判据）
 * ============================================================================
 * **基线量具**，不是验收门：它断言的是「缺陷按 M9 live 门取证所述**存在**」，
 * 即 2026-09-27 裁定移交 M9.1 的两个发现（登记册 R-20 / R-21；
 * `docs/m9/M9-Gate-Decision.md` §F-1 / §F-4）在**当前代码**上的确定性读数。
 *
 *  - F-4（R-21 / L-M9-19）：忘掉/更正后**逐字重述**同一内容 ⇒
 *    ① `MEMORY_CREATED` 事件真的提交（L1 事件层）；
 *    ② 折叠器 `applyCreated`（`projections/memory.ts:193`）对已存在 id 无条件
 *      no-op ⇒ 投影仍 retracted/superseded（L2 投影层）；
 *    ③ 该 id 永不可召回（L3 资格层）；
 *    ④ 显式服务仍报 `ok: true` ⇒ 翻译层给 `written` ⇒ 回复真话策略放行
 *      「记住了」（L4 回复真话层）—— **四层读数互相矛盾**，这就是缺陷本体。
 *  - F-1（R-20 / L-M9-13）：遗忘后，被撤取值仍以**原始对话行**形式进入
 *    最终 prompt（上下文装配层）—— 状态层 7/7 全绿（M9 已证），泄漏通道
 *    只在装配层。本脚本离线机械演示该通道（不调模型）。
 *
 * 修复后（WP3/WP4），**本脚本的缺陷断言会翻红** —— 那是预期行为，不是回归：
 * 届时验收读数由 WP2 的确定性反例夹具（断言修复后语义）接管。本脚本的价值
 * 是把「修复前」钉成可复核的分层读数（计划书 §6 WP0：非空测量）。
 *
 * ============================================================================
 *  场景（每个场景独立隔离库 —— correct 的目标解析对无关 active 记录敏感，
 *  跨场景共库会让 C 撞 target_ambiguous，那不是 F-4 是 B29 既有行为）
 * ============================================================================
 * A. 遗忘后逐字重述（F-4 主场景）：remember → forget → verbatim remember。
 *    读四层 + rebuild A==B + rollup 资格闸（真实 reader，D-2）。
 * B. ACTIVE 同内容重复（R01 对照）：去重层 1 应拦 ⇒ already_applied。
 *    这是**正确**的既有行为（D2），修复不得动它 —— 基线先钉住。
 * C. 更正后逐字重述旧值（R03 前置读数）：remember v1 → correct v2 →
 *    verbatim remember v1。读冲突路径的实际去向（现状基线，不预设结论）。
 * D. F-1 Recent 通道演示：被撤原话作为历史行 ⇒ 最终 packet.text 含被撤取值。
 *
 * ⚠️ 执行形状：每句话**只经生产 turn 端口执行一次**（`createExplicitMemoryTurnPort`），
 *    服务层 outcome 用包装捕获 —— 不直调 `service.handle` 再走一遍端口
 *    （第一版这么写，第二次执行撞幂等键，L4 读数被伪影污染）。
 *
 * 证据：`artifacts/m9.1/wp0-repro-<date>-<head12>/readings.json`（每场景独立
 * 隔离库 `keep: false`；真实库以 `digestTree` 前后摘要证明从未被打开写入）。
 */
import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m9.1-wp0-repro-a', { keep: false })

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { applyAcceptedEvents } from '../src/infrastructure/persistence/event-store.ts'
import { domainEventsForMemory, rebuildMemory } from '../src/infrastructure/persistence/memory-store.ts'
import { createRollupSourceReader } from '../src/infrastructure/persistence/rollup-source-store.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { createRecallTurnPort } from '../src/kernel/app/recall/turn.ts'
import {
  createExplicitMemoryService,
  type ExplicitMemoryOutcome,
  type ExplicitMemoryService,
} from '../src/kernel/app/memory/explicit-service.ts'
import { createExplicitMemoryTurnPort, type ExplicitMemoryTurnResult } from '../src/kernel/app/memory/explicit-turn.ts'
import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import { createTargetMemoryResolver, LexicalSemanticJudge } from '../src/kernel/app/memory/target-resolver.ts'
import { applyResponseTruthPolicy } from '../src/kernel/app/memory/response-truth.ts'
import { buildContextCompilerV2 } from '../src/kernel/context/sections.ts'
import { classifyRollupSource } from '../src/kernel/contracts/rollup.ts'
import { createRecallRequest } from '../src/kernel/contracts/recall.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { asCharacterId, newTraceId } from '../src/kernel/contracts/ids.ts'
import { createM4Harness, M4_T0, type M4Harness } from './m4-harness.ts'

const PRODUCTION_DB_DIR = join(process.cwd(), 'data', 'pglite')

/** 一条分层读数 */
interface Reading {
  id: string
  name: string
  /** 缺陷读数是否按基线预期出现（本脚本的「通过」= 缺陷被复现） */
  asExpected: boolean
  detail: string
}
const readings: Reading[] = []
function reading(id: string, name: string, asExpected: boolean, detail: string): void {
  readings.push({ id, name, asExpected, detail })
  console.log(`  ${asExpected ? '📌' : '⚠️'} ${name} :: ${detail}`)
}

const outcomeKind = (o: ExplicitMemoryOutcome | undefined) =>
  o === undefined ? 'no-intent' : o.ok ? `ok:${o.intent}` : `fail:${o.reason}`

/** 一个场景的完整装配：隔离库 + 生产同形服务 + turn 端口 + 召回端口 */
interface Rig {
  h: M4Harness
  say(text: string): Promise<{ turn?: ExplicitMemoryTurnResult; outcome?: ExplicitMemoryOutcome; eventId: string }>
  recall(query: string): Promise<{ selected: string[]; candidates: number; eligible: number }>
  trail(id: string): Promise<{ types: string[]; created: number }>
  dispose(): Promise<void>
}

async function openScenario(label: string): Promise<Rig> {
  const { resetPluginSqlConnection } = await import('../src/dev/sandbox.ts')
  await resetPluginSqlConnection()
  isolateDatabase(`m9.1-wp0-repro-${label}`, { keep: false })
  const h = await createM4Harness({ label: `m91-wp0-${label}` })
  const { owner, user, db, store } = h

  const resolver = createTargetMemoryResolver({
    get: (id) => store.get(id),
    getActiveByCanonicalKey: (key) => store.getActiveByCanonicalKey(key),
    listBySubject: (o, s) => store.listBySubject(o, s),
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

  /* 服务层 outcome 捕获：每句话只经 turn 端口执行一次（见文件头 ⚠️） */
  const captured: { outcome?: ExplicitMemoryOutcome } = {}
  const capturingService: ExplicitMemoryService = {
    remember: (request) => service.remember(request),
    correct: (request) => service.correct(request),
    forget: (request) => service.forget(request),
    dispute: (request) => service.dispute(request),
    handle: async (request) => {
      const outcome = await service.handle(request)
      captured.outcome = outcome
      return outcome
    },
  }
  const turnPort = createExplicitMemoryTurnPort({ service: capturingService })

  const recallPort = createRecallTurnPort({
    service: createMemoryRecallService({
      port: createMemoryRetrievalStore({
        store,
        integrity: (o) => memoryIntegrityProblems(db, o),
        rootReadings: (ids) => rootReadingsByMemory(db, ids),
      }),
    }),
    budget: DEFAULT_CONTEXT_BUDGET,
    now: () => M4_T0 + 20_000,
  })

  return {
    h,
    async say(text) {
      captured.outcome = undefined
      const recorded = await h.recordUserEvidence(text)
      const turn = await turnPort.handleTurn({
        owner,
        speaker: user,
        event: { id: recorded.ref.id as never, actorType: 'user', content: text },
      })
      return { turn, outcome: captured.outcome, eventId: recorded.ref.id }
    },
    async recall(query) {
      const outcome = await recallPort.run(
        createRecallRequest({
          traceId: newTraceId(),
          characterId: asCharacterId(h.characterId),
          user: entityRef('user', String(user.id)),
          query: { text: query, source: 'user_message' },
          intent: 'current_fact',
          contextBudget: { memoryTokens: DEFAULT_CONTEXT_BUDGET.memoryTokens },
        })
      )
      return {
        selected: outcome.record.selectedIds.map(String),
        candidates: outcome.record.metrics.candidateCount,
        eligible: outcome.record.metrics.eligibleCount,
      }
    },
    async trail(id) {
      const events = await domainEventsForMemory(db, id as never)
      return {
        types: events.map((e) => e.type.replace('MEMORY_', '')),
        created: events.filter((e) => e.type === 'MEMORY_CREATED').length,
      }
    },
    async dispose() {
      await h.stop()
    },
  }
}

async function main(): Promise<void> {
  const realDbBefore = digestTree(PRODUCTION_DB_DIR)

  // =========================================================================
  console.log('\n=== 场景 A：遗忘后逐字重述（F-4 主场景；预期缺陷四层读数） ===')
  // =========================================================================
  {
    const rig = await openScenario('a')
    try {
      const A1 = await rig.say('记住，技术问题我喜欢详细解释')
      const A2 = await rig.say('忘掉技术问题详细解释那个偏好')
      const A3 = await rig.say('记住，技术问题我喜欢详细解释')

      const a1id = A1.outcome?.ok ? String(A1.outcome.memoryId) : '(none)'
      const a3id = A3.outcome?.ok ? String(A3.outcome.memoryId) : '(none)'
      reading('A-0', '前置：三次意图都命中（remember/forget/remember）', A1.outcome !== undefined && A2.outcome !== undefined && A3.outcome !== undefined, `A1=${outcomeKind(A1.outcome)} A2=${outcomeKind(A2.outcome)} A3=${outcomeKind(A3.outcome)}`)
      reading('A-1', '确定性 id 撞线：重述的 memoryId 与原记录相同', a1id === a3id && a1id !== '(none)', `id1=${a1id.slice(0, 18)}… id3=${a3id.slice(0, 18)}… same=${String(a1id === a3id)}`)

      // L1 事件层：MEMORY_CREATED 是否真的提交了第二次
      const trailA = await rig.trail(a1id)
      reading('A-L1', 'L1 事件层：重述的 MEMORY_CREATED 真的提交（≥2 条 CREATE）', trailA.created >= 2, `MEMORY_CREATED 事件数=${String(trailA.created)}（事件类型序：${trailA.types.join(' → ')}）`)

      // L2 投影层：折叠后状态
      const recordA = await rig.h.store.get(a1id as never)
      reading('A-L2', 'L2 投影层：applyCreated no-op ⇒ 投影仍 retracted', recordA?.status === 'retracted', `status=${String(recordA?.status)} revision=${String(recordA?.revision)}（no-op 折叠仍推 revision —— store 已知行为）`)

      // L3 资格层：召回不可见
      const recallA = await rig.recall('技术问题你喜欢怎么解释')
      const aSelected = recallA.selected.filter((id) => id === a1id).length
      reading('A-L3', 'L3 资格层：该 id 不被召回（selected=0）', aSelected === 0, `selected 含该 id=${String(aSelected)} · 候选=${String(recallA.candidates)} 合格=${String(recallA.eligible)}`)

      // L4 回复真话层：ok:true + written + 成功口吻放行
      const replyText = '记住了，技术问题你喜欢详细解释，这事我记下了。'
      const truthA = applyResponseTruthPolicy({ result: A3.turn ?? undefined, replyText })
      reading(
        'A-L4',
        'L4 回复真话层：ok:true ⇒ written ⇒ 「记住了」不被纠正（假成功）',
        A3.outcome?.ok === true && A3.turn?.kind === 'written' && truthA.corrected === false && truthA.executed === true,
        `outcome=${outcomeKind(A3.outcome)} turn.kind=${String(A3.turn?.kind)} executed=${String(truthA.executed)} corrected=${String(truthA.corrected)}`
      )

      // rebuild A==B：语义缺口、非账本分歧
      const rebuilt = await rebuildMemory(rig.h.db, a1id as never)
      const rebuiltStatus = rebuilt.after === null ? '(null)' : String(rebuilt.after.status)
      reading('A-RB', 'rebuild A==B：从零重放与在线折叠一致（都停在 retracted）', rebuilt.equal && rebuiltStatus === String(recordA?.status), `rebuild.status=${rebuiltStatus} 在线=${String(recordA?.status)} equal=${String(rebuilt.equal)} 差异=[${rebuilt.differences.join(',')}]`)

      /*
       * D-2（在 A 库内跑：需要 A 的真实事件 + 真实 retracted 根）：
       * rollup 资格闸 ④ 用**真实 reader** 读 ⇒ 被撤行被拒。
       * 受信读数形状被 R-59 锁钉死，脚本造不出同形读数 —— 必须走真读取面。
       */
      const reader = createRollupSourceReader(rig.h.db)
      const sources = await reader.read({
        characterId: asCharacterId(rig.h.characterId),
        conversationId: `dm-${rig.h.characterId}-m91-wp0-a`,
        beforeSequence: Number.MAX_SAFE_INTEGER,
        scanCeiling: 200,
      })
      const withdrawnSource = sources.find((s) => s.content.includes('技术问题我喜欢详细解释'))
      const d2Verdict =
        withdrawnSource === undefined
          ? { eligible: false, code: 'source_not_found_in_conversation' }
          : classifyRollupSource(withdrawnSource, { sameConversation: true, sameOwner: true })
      reading(
        'D-2',
        'F-1 rollup 通道（对照）：真实 reader ⇒ retracted 根 ⇒ invalidated_by_memory_state（已闭合）',
        d2Verdict.eligible === false && d2Verdict.code === 'invalidated_by_memory_state',
        `来源条数=${String(sources.length)} · 被撤行 verdict=${JSON.stringify(d2Verdict)} · rootStatuses=${JSON.stringify(withdrawnSource?.rootMemoryStatuses ?? [])}`
      )
    } finally {
      await rig.dispose()
    }
  }

  // =========================================================================
  console.log('\n=== 场景 B：ACTIVE 同内容重复（R01 对照；预期既有去重正常） ===')
  // =========================================================================
  {
    const rig = await openScenario('b')
    try {
      const B1 = await rig.say('记住，闲聊的时候我喜欢简短回答')
      const B2 = await rig.say('记住，闲聊的时候我喜欢简短回答')
      const b1id = B1.outcome?.ok ? String(B1.outcome.memoryId) : '(none)'
      const recordB = await rig.h.store.get(b1id as never)
      const trailB = await rig.trail(b1id)
      reading(
        'B-1',
        'ACTIVE 重复：去重层拦截 ⇒ already_applied（或等价拒绝），不产生第二条 CREATE',
        B1.outcome?.ok === true && recordB?.status === 'active' && B2.turn?.kind === 'already_applied' && trailB.created === 1,
        `B1=${outcomeKind(B1.outcome)} B2=${outcomeKind(B2.outcome)} turn2=${String(B2.turn?.kind)} status=${String(recordB?.status)} CREATE数=${String(trailB.created)}`
      )
    } finally {
      await rig.dispose()
    }
  }

  // =========================================================================
  console.log('\n=== 场景 C：更正后逐字重述旧值（R03 前置；只读现状，不预设结论） ===')
  // =========================================================================
  {
    const rig = await openScenario('c')
    try {
      const C1 = await rig.say('记住，我不吃香菜')
      const C2 = await rig.say('香菜那个改一下，我现在能吃香菜了')
      const C3 = await rig.say('记住，我不吃香菜')
      reading(
        'C-0',
        '前置读数：C1/C2/C3 的服务层结局（不预设结论）',
        C1.outcome?.ok === true && C2.outcome?.ok === true,
        `C1=${outcomeKind(C1.outcome)} C2=${outcomeKind(C2.outcome)}${C2.outcome?.ok === false ? `（detail=${C2.outcome.detail.slice(0, 60)}）` : ''} C3=${outcomeKind(C3.outcome)}`
      )
      /*
       * ⚠️ outcome.memoryId 语义：correct/supersede 返回**被操作的旧记录** id，
       *    dispute 返回**被标争议的目标** id —— 不能拿它当「新记录」读。
       *    地面真值以全库 dump 为准（C-3）。
       */
      const allC = await rig.h.store.list({ owner: rig.h.owner, limit: 50 })
      const dumpC = allC.map((r) => `${String(r.id).slice(4, 14)}:${String(r.status)}:${String((r.content as { predicate?: string }).predicate ?? '?')}=${String((r.content as { value?: unknown }).value ?? '?')}→${r.supersededBy ? String(r.supersededBy).slice(4, 14) : '-'}`)
      const dislike = allC.find((r) => String((r.content as { value?: unknown }).value) === 'dislike')
      const like = allC.find((r) => String((r.content as { value?: unknown }).value) === 'like')
      const activeInSlotC = (await rig.h.store.getActiveByCanonicalKey(String(dislike?.canonicalKey ?? ''))).length
      const trailDislike = dislike ? await rig.trail(String(dislike.id)) : { types: [], created: 0 }
      reading(
        'C-1',
        '更正后重述旧值：D-55c 冲突政策正确生效 —— 无时间标记的矛盾 ⇒ MARK_DISPUTED（不擅自选边、不未经授权覆盖）',
        dislike?.status === 'superseded' && like?.status === 'disputed' && activeInSlotC === 0,
        `不吃香菜(v1)=${String(dislike?.status)}(by like) 能吃香菜(v2)=${String(like?.status)} · 槽内 active=${String(activeInSlotC)} · C3=${outcomeKind(C3.outcome)}`
      )
      reading(
        'C-2',
        'F-4 同型缺口（superseded 面 + 回复真话）：重述的旧值**没有**被记录（v1 无新 CREATE、槽内零 active ⇒ 「不吃香菜」不可召回），但 translate 给 written ⇒ 她会说「记住了」',
        trailDislike.created === 1 && activeInSlotC === 0 && C3.turn?.kind === 'written',
        `v1 CREATE数=${String(trailDislike.created)}（事件序：${trailDislike.types.join(' → ')}）· 槽内 active=${String(activeInSlotC)} · turn3=${String(C3.turn?.kind)}（实际执行的是 dispute，不是 remember）`
      )
      reading('C-3', '全库读数（id:状态:槽位=取值→被谁顶）', true, `[${dumpC.join(' | ')}]`)
    } finally {
      await rig.dispose()
    }
  }

  // =========================================================================
  console.log('\n=== 场景 D：F-1 Recent 通道演示（离线；不调模型） ===')
  // =========================================================================
  {
    const rig = await openScenario('d')
    try {
      /*
       * 被撤原话作为历史行进 recentEvents ⇒ 最终 packet.text 含被撤取值。
       * 这就是 F-1 的机械泄漏通道（M9 live 2/7 的程序面成因）。
       */
      const withdrawnLine = {
        id: 'cev_withdrawn_1' as never,
        sequence: 41,
        speaker: '用户',
        text: '记住，技术问题我喜欢详细解释',
        actorType: 'user' as const,
      }
      const probeLine = {
        id: 'cev_forget_1' as never,
        sequence: 42,
        speaker: '用户',
        text: '忘掉技术问题详细解释那个偏好',
        actorType: 'user' as const,
      }
      const compiler = buildContextCompilerV2({
        identity: rig.h.kernel.identitySnapshot,
        definition: rig.h.kernel.definition,
      })
      const packet = await compiler.compile({
        characterId: asCharacterId(rig.h.characterId),
        currentInput: '让我忘的具体是什么？',
        currentEventId: 'cev_probe_1' as never,
        recentEvents: [withdrawnLine, probeLine],
        now: M4_T0 + 30_000,
      })
      const leaked = packet.text.includes('技术问题我喜欢详细解释')
      reading('D-1', 'F-1 Recent 通道：被撤原话逐字进入最终 prompt（泄漏通道在装配层）', leaked, `packet.text 含被撤取值=${String(leaked)} · recent section 在=${String(packet.sections.some((s) => s.id === 'recent-conversation'))}`)
    } finally {
      await rig.dispose()
    }
  }

  // =========================================================================
  // 汇总 + 证据落盘
  // =========================================================================
  const { resetPluginSqlConnection } = await import('../src/dev/sandbox.ts')
  await resetPluginSqlConnection()
  const realDbAfter = digestTree(PRODUCTION_DB_DIR)
  const realDbUntouched = realDbBefore.treeSha256 === realDbAfter.treeSha256

  const allAsExpected = readings.every((r) => r.asExpected)
  const head = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim()
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const dir = join(process.cwd(), 'artifacts', 'm9.1', `wp0-repro-${date}-${head}`)
  mkdirSync(dir, { recursive: true })
  const payload = {
    instrument: 'm9.1-wp0-repro@1',
    kind: 'baseline-defect-reproduction',
    note: '缺陷按基线预期复现 = 通过；修复（WP3/WP4）后本脚本缺陷断言翻红属预期，验收由 WP2 夹具接管',
    head,
    date,
    isolation: '每场景独立 isolateDatabase(keep:false) + resetPluginSqlConnection；真实库 digestTree 前后摘要证明未动',
    realDbUntouched,
    realDbDigestBefore: realDbBefore.treeSha256.slice(0, 16),
    realDbDigestAfter: realDbAfter.treeSha256.slice(0, 16),
    realDbMeasuredCount: realDbAfter.measuredCount,
    scenarios: { A: '遗忘后逐字重述（含 D-2 rollup 对照）', B: 'ACTIVE 同内容重复（对照）', C: '更正后逐字重述旧值', D: 'F-1 Recent 通道演示' },
    readings,
    summary: { total: readings.length, asExpected: readings.filter((r) => r.asExpected).length, allAsExpected, realDbUntouched },
  }
  writeFileSync(join(dir, 'readings.json'), JSON.stringify(payload, null, 2), 'utf8')

  console.log(`\n=== 汇总 ===`)
  console.log(`读数 ${String(readings.length)} 条 · 按基线预期 ${String(payload.summary.asExpected)} 条 · 真实库未动=${String(realDbUntouched)}`)
  console.log(`证据：${join('artifacts', 'm9.1', `wp0-repro-${date}-${head}`, 'readings.json')}`)
  console.log(allAsExpected && realDbUntouched ? '\n基线复现成立：F-4 四层矛盾与 F-1 Recent 通道均按 M9 live 取证复现。' : '\n⚠️ 有读数偏离基线预期 —— 复现不成立或行为已变，先调查再继续。')
  process.exitCode = allAsExpected && realDbUntouched ? 0 : 1
}

await main()
