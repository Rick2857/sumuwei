/**
 * `S7` 相关性闸门 —— **经历类显式召回路径**（后 Lv2 · `S7` 修复的验收门）。
 *
 * ============================================================================
 *  它守**两个方向**（只守一个方向的量具与"什么都不检查"无法区分）
 * ============================================================================
 * ```text
 * 方向 A（召回）：**改述**的共同经历问句，必须能让那条经历过闸 ⇒ 进 ranked
 * 方向 B（精度）：**无关**问句，**不许**因为这条路而让经历类混进来
 *                （那是 ADR-084 花代价换来的东西，不许被这条修复抵消）
 * 方向 C（冻结面）：**声明类**记忆的行为**一字不改** ——
 *                  没有词面证据就照旧被拒（这条路只对经历类开放）
 * ```
 *
 * ⚠️ 这不是"诊断脚本"了：它现在是 `pnpm postlv2:s7:gate` 的实体。
 */

import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
const sandbox = isolateDatabase('postlv2-s7-gate', { keep: false })

const { createM4Harness } = await import('./m4-harness.ts')
const { stringToUuid } = await import('@elizaos/core')
const { entityRef } = await import('../src/kernel/contracts/entity.ts')
const { createMemoryRetrievalStore } = await import(
  '../src/infrastructure/persistence/memory-retrieval-store.ts'
)
const { createMemoryRecallService } = await import('../src/kernel/app/recall/retrieval.ts')
const { createRecallRequest } = await import('../src/kernel/contracts/recall.ts')
const { rootReadingsByMemory } = await import(
  '../src/infrastructure/persistence/qualification-read.ts'
)
const { memoryIntegrityProblems } = await import(
  '../src/infrastructure/persistence/memory-integrity.ts'
)
const { DEFAULT_CONTEXT_BUDGET } = await import('../src/kernel/recall/selector.ts')
const { rankCandidates, hasRelevanceEvidence, sharedExperienceEvidence, DEFAULT_RECALL_RANKING_POLICY } =
  await import('../src/kernel/recall/ranking.ts')
const { lexicalFragments } = await import('../src/kernel/app/memory/target-resolver.ts')

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

const h = await createM4Harness({ label: 'postlv2-s7-gate' })
const userId = stringToUuid('user-Alex')

const STORY_SOURCE_ID = 'story:jichuang-interview-two@v1#gate.s1_intro_met'
const SUMMARY = '我们一起准备极创工作室的二面：她看过我的简历，我们约好二面聊项目。'

/** 经历类记忆（本修复的服务对象） */
const episode = h.makeCandidate(
  'episode',
  {
    kind: 'episode',
    summary: SUMMARY,
    occurredAt: 1_800_000_000_000,
    participants: [{ kind: 'user', id: String(userId) }],
    eventRefs: [STORY_SOURCE_ID],
  } as never,
  {
    sourceRefs: [{ kind: 'observation', id: STORY_SOURCE_ID } as never],
    evidenceRootIds: [STORY_SOURCE_ID],
    authority: 'DIRECT_INTERACTION',
    epistemicStatus: 'asserted',
    subjects: [{ kind: 'user', id: String(userId) }],
    importance: 0.7,
    confidence: 0.7,
  } as never
)
await h.tryCommit(episode, 1)
const episodeId = String(episode.proposedId)

/** 声明类记忆（**对照组**：它的行为不许被这条路改变） */
const claim = h.makeCandidate(
  'person_fact',
  {
    kind: 'claim',
    subject: { kind: 'user', id: String(userId) },
    predicate: 'education.institution',
    value: '示例工程科技大学',
    occurredAt: 1_800_000_000_000,
  } as never,
  {
    sourceRefs: [{ kind: 'conversation_event', id: 'cev:gate:1' } as never],
    evidenceRootIds: ['cev:gate:1'],
    authority: 'EXPLICIT_USER_STATEMENT',
    epistemicStatus: 'asserted',
    subjects: [{ kind: 'user', id: String(userId) }],
    importance: 0.9,
    confidence: 0.9,
  } as never
)
await h.tryCommit(claim, 2)
const claimId = String(claim.proposedId)

const service = createMemoryRecallService({
  port: createMemoryRetrievalStore({
    store: h.store,
    integrity: (owner: unknown) => memoryIntegrityProblems(h.db, owner as never),
    rootReadings: (ids) => rootReadingsByMemory(h.db, ids),
  }),
})

const runQuestion = async (
  question: string
): Promise<{
  question: string
  episodeChannels: string[]
  episodeInRanked: boolean
  episodeReason: string | null
  episodeVia: string
  claimChannels: string[]
  claimInRanked: boolean
  claimReason: string | null
  fragments: string[]
  matched: string[]
}> => {
  const request = createRecallRequest({
    traceId: `trace:gate:${question.length}` as never,
    characterId: String(h.characterId),
    user: entityRef('user', String(userId)),
    query: { text: question },
    intent: 'current_fact',
    contextBudget: { memoryTokens: DEFAULT_CONTEXT_BUDGET.memoryTokens },
  })
  const recalled = await service.recall({ request })
  const ranked = rankCandidates({
    request,
    candidates: recalled.eligibility.eligible,
    capabilities: recalled.capabilities,
    now: Date.now(),
  })
  const ep = recalled.eligibility.eligible.find((item) => String(item.memoryId) === episodeId)
  const cl = recalled.eligibility.eligible.find((item) => String(item.memoryId) === claimId)
  const epDecision = ranked.decisions.find((item) => String(item.memoryId) === episodeId)
  const clDecision = ranked.decisions.find((item) => String(item.memoryId) === claimId)
  const fragments = lexicalFragments(question)
  return {
    question,
    episodeChannels: ep !== undefined ? [...(ep.retrievedBy ?? [])] : [],
    episodeInRanked: ranked.ranked.some((item) => String(item.candidate.memoryId) === episodeId),
    episodeReason: epDecision?.reason ?? null,
    episodeVia: ep !== undefined ? hasRelevanceEvidence({ request, candidate: ep }).via : 'not_eligible',
    claimChannels: cl !== undefined ? [...(cl.retrievedBy ?? [])] : [],
    claimInRanked: ranked.ranked.some((item) => String(item.candidate.memoryId) === claimId),
    claimReason: clDecision?.reason ?? null,
    fragments,
    matched: fragments.filter((fragment) => SUMMARY.includes(fragment)),
  }
}

const PARAPHRASES = [
  '对了，我们之前是不是聊过我找工作的事？',
  '我找工作的事你还记得吗',
  '之前跟你提过的那件事，你还记得吗',
]
const UNRELATED = [
  '今天天气怎么样',
  '帮我算一下 3 加 5 等于几',
  '推荐一部科幻电影',
]

/**
 * ⚠️ 本门**同时**测两个策略档，而且**两档都要如实报**：
 *
 * ```text
 *   档「关」（当前缺省）：改述过不了闸（这是 ADR-084 登记的代价，如实红着）
 *   档「开」（机制可用）  ：改述过得了，但**无关问句也过得了** ⇒ 精度失守
 * ```
 * 这就是为什么缺省是**关**：**这条路单独上不够** —— 它能召回，但守不住精度。
 * 门把两档并列，是为了让"为什么不上"成为**读数**而不是我的说辞。
 */
async function runQuestionWithPolicy(
  question: string,
  policy: { sharedExperienceRecall: boolean }
): Promise<Awaited<ReturnType<typeof runQuestion>>> {
  const request = createRecallRequest({
    traceId: `trace:gate:${question.length}:${String(policy.sharedExperienceRecall)}` as never,
    characterId: String(h.characterId),
    user: entityRef('user', String(userId)),
    query: { text: question },
    intent: 'current_fact',
    contextBudget: { memoryTokens: DEFAULT_CONTEXT_BUDGET.memoryTokens },
  })
  const recalled = await service.recall({ request })
  const ranked = rankCandidates({
    request,
    candidates: recalled.eligibility.eligible,
    capabilities: recalled.capabilities,
    now: Date.now(),
    policy: { ...DEFAULT_RECALL_RANKING_POLICY, ...policy },
  })
  const ep = recalled.eligibility.eligible.find((item) => String(item.memoryId) === episodeId)
  const cl = recalled.eligibility.eligible.find((item) => String(item.memoryId) === claimId)
  const epDecision = ranked.decisions.find((item) => String(item.memoryId) === episodeId)
  const fragments = lexicalFragments(question)
  return {
    question,
    episodeChannels: ep !== undefined ? [...(ep.retrievedBy ?? [])] : [],
    episodeInRanked: ranked.ranked.some((item) => String(item.candidate.memoryId) === episodeId),
    episodeReason: epDecision?.reason ?? null,
    episodeVia:
      ep !== undefined
        ? hasRelevanceEvidence({
            request,
            candidate: ep,
            sharedExperienceRecall: policy.sharedExperienceRecall,
          }).via
        : 'not_eligible',
    claimChannels: cl !== undefined ? [...(cl.retrievedBy ?? [])] : [],
    claimInRanked: ranked.ranked.some((item) => String(item.candidate.memoryId) === claimId),
    claimReason: null,
    fragments,
    matched: fragments.filter((fragment) => SUMMARY.includes(fragment)),
  }
}

console.log('='.repeat(74))
console.log('S7 相关性闸门：经历类显式召回路径 —— **两档并列**')
console.log('='.repeat(74))

/* 档「开」：机制可用（看它能召回多少，以及它放进来多少不该放的） */
const paraphraseOn = []
for (const question of PARAPHRASES) {
  paraphraseOn.push(await runQuestionWithPolicy(question, { sharedExperienceRecall: true }))
}
const unrelatedOn = []
for (const question of UNRELATED) {
  unrelatedOn.push(await runQuestionWithPolicy(question, { sharedExperienceRecall: true }))
}
/* 档「关」：当前缺省（看代价，也看精度是否守住） */
const paraphraseOff = []
for (const question of PARAPHRASES) {
  paraphraseOff.push(await runQuestionWithPolicy(question, { sharedExperienceRecall: false }))
}
const unrelatedOff = []
for (const question of UNRELATED) {
  unrelatedOff.push(await runQuestionWithPolicy(question, { sharedExperienceRecall: false }))
}

const paraphraseRows = paraphraseOn
const unrelatedRows = unrelatedOn

console.log('\n--- 方向 A（档「开」）：改述的共同经历（**应过闸**）---')
for (const row of paraphraseOn) {
  console.log(
    `  ${row.episodeInRanked ? '✅' : '❌'} ${row.question}\n` +
      `      通道=${JSON.stringify(row.episodeChannels)} · via=${row.episodeVia} · 共同三字片段=${row.matched.length}`
  )
}
record(
  'A',
  '方向 A（档「开」的**召回**）：零共同三字片段的改述问句**能**过闸 ⇒ 进 ranked',
  paraphraseOn.every((row) => row.episodeInRanked) && paraphraseOn.every((row) => row.matched.length === 0),
  paraphraseOn.map((row) => `${row.episodeInRanked ? 'ok' : 'BAD'}(via=${row.episodeVia},片段=${row.matched.length})`).join(' · '),
  paraphraseOn.length * 2
)

console.log('\n--- 方向 B（档「开」）：无关问句（**必须**被挡住）---')
for (const row of unrelatedOn) {
  console.log(
    `  ${row.episodeInRanked ? '❌ 混入' : '✅ 挡住'} ${row.question} · 通道=${JSON.stringify(row.episodeChannels)}`
  )
}
record(
  'B',
  '方向 B（档「开」的**精度**）：无关问句下经历类**仍然过不了闸** —— 这一条**判的是缺省该不该开**',
  unrelatedOn.every((row) => !row.episodeInRanked),
  unrelatedOn.map((row) => `${row.episodeInRanked ? 'BAD(混入)' : 'ok'}`).join(' · '),
  unrelatedOn.length * 2
)

console.log('\n--- 方向 D（档「关」，即**当前缺省**）：代价与精度分列 ---')
for (const row of [...paraphraseOff, ...unrelatedOff]) {
  console.log(`  ${row.episodeInRanked ? '混入' : '挡住'} ${row.question}`)
}
record(
  'D',
  '方向 D（档「关」＝**当前缺省**）：改述被挡（`ADR-084` 登记的代价）· 无关问句被挡（精度守住）—— 两件都如实记录',
  paraphraseOff.every((row) => !row.episodeInRanked) && unrelatedOff.every((row) => !row.episodeInRanked),
  `改述过闸=${String(paraphraseOff.filter((r) => r.episodeInRanked).length)}/${paraphraseOff.length} · 无关混入=${String(unrelatedOff.filter((r) => r.episodeInRanked).length)}/${unrelatedOff.length}`,
  paraphraseOff.length + unrelatedOff.length
)

console.log('\n--- 方向 C：声明类记忆（**一字不改**）---')/*
 * ⚠️ 这条是"这条路只对经历类开放"的机器形态：
 *    同一批问句下，**声明类**记忆的行为必须与改动前一致 ——
 *    没有词面证据就照旧被拒（`LOW_RELEVANCE`）。
 */
const claimRejectedWhenNoLexical = unrelatedRows.every((row) => !row.claimInRanked)
const claimRejectedOnParaphraseToo = paraphraseRows.every((row) => !row.claimInRanked)
const sharedEvidenceRejectsClaims = paraphraseRows.every(
  (row) =>
    row.claimChannels.length === 0 ||
    sharedExperienceEvidence({ candidate: { type: 'person_fact' } as never, channels: ['subject', 'recency'] }).ok ===
      false
)
record(
  'C',
  '方向 C（**冻结面**）：声明类记忆**没有**获得这条路径 —— 无词面/无 target 证据时照旧被拒（`sharedExperienceEvidence` 对 `person_fact` 一律 false）',
  claimRejectedWhenNoLexical && claimRejectedOnParaphraseToo && sharedEvidenceRejectsClaims,
  `无关问句下声明类被拒=${String(claimRejectedWhenNoLexical)} · 改述问句下也被拒=${String(claimRejectedOnParaphraseToo)} · 声明类不适用该路径=${String(sharedEvidenceRejectsClaims)}`,
  4
)

await h.stop()

/* ===========================================================================
 * V1 量具自证三段式
 * =========================================================================== */
/** 被检验的判据本体：**"这条经历记忆被闸挡住了"** */
const detectGateBlocked = (inRanked: boolean): boolean => !inRanked
const selfCheck = (() => {
  /* 正控：档「开」下面的**无关**问句**真的被挡住**（这一档下它确实为 true） */
  const positive = detectGateBlocked(unrelatedOff[0]!.episodeInRanked)
  const negative = detectGateBlocked(false) // 负控：喂"进了 ranked"必须响
  const restored = detectGateBlocked(unrelatedOff[0]!.episodeInRanked)
  return {
    ok: positive === true && negative === true && restored === true,
    detail: `正控（档「关」下无关问句被挡）=${String(positive)}（应 true）· 负控（"进了 ranked"必响）=${String(negative)}（应 true）· 恢复=${String(restored)}（应 true）`,
  }
})()
record('V1', '量具自证三段式：被挡 → 把"进了 ranked"喂进去必响 → 恢复后重新被挡', selfCheck.ok, selfCheck.detail, 3)

/* ===========================================================================
 * 方向 E：**语义路径的判据是数值，不是标签**
 * ===========================================================================
 * ⚠️ 这一组直接对着用户点名的那个陷阱：
 * ```text
 *   "不能只凭 `retrievedBy` 包含 `semantic` 就放行 ——
 *    当前这个标签仅表示拿到了分数，不能证明内容相关。"
 * ```
 * 判据必须**拒绝"只有标签"**、**按阈值放行真实分数**。
 */
const mkCandidate = (over: Record<string, unknown>): never =>
  ({
    memoryId: 'mem:probe',
    owner: { kind: 'character', id: String(h.characterId) },
    type: 'episode',
    status: 'active',
    authority: 'DIRECT_INTERACTION',
    epistemicStatus: 'asserted',
    subjects: [{ kind: 'user', id: String(userId) }],
    importance: 0.5,
    confidence: 0.5,
    recordedAt: 1,
    contentFingerprint: 'fp',
    searchable: '',
    dataText: '',
    sourceRefs: [],
    retrievedBy: [],
    integrityOk: true,
    ...over,
  }) as never

const requestWith = { target: { status: 'none' as const } } as never
/** ① 只有 `semantic` 标签、**没有分数** ⇒ 必须被拒 */
const labelOnly = hasRelevanceEvidence({
  request: requestWith,
  candidate: mkCandidate({ retrievedBy: ['semantic'] }),
  semanticRelevanceFloor: 0.8,
})
/** ② 有分数但**低于阈值** ⇒ 必须被拒 */
const belowFloor = hasRelevanceEvidence({
  request: requestWith,
  candidate: mkCandidate({ retrievedBy: ['semantic'], semanticScore: 0.31 }),
  semanticRelevanceFloor: 0.8,
})
/** ③ 有分数且**达到阈值** ⇒ 放行，且 `via='semantic'` */
const atFloor = hasRelevanceEvidence({
  request: requestWith,
  candidate: mkCandidate({ retrievedBy: ['semantic'], semanticScore: 0.86 }),
  semanticRelevanceFloor: 0.8,
})
/** ④ **缺省阈值（Infinity）** ⇒ 即使分数很高也**不放行**（未校准就不启用的机器形态） */
const defaultFloor = hasRelevanceEvidence({
  request: requestWith,
  candidate: mkCandidate({ retrievedBy: ['semantic'], semanticScore: 0.99 }),
})
record(
  'E1',
  '**语义路径的判据是数值不是标签**：只有 `semantic` 标签 ⇒ 拒 · 低于阈值 ⇒ 拒 · 达到阈值 ⇒ 放行 `via=semantic` · **缺省阈值（未校准）⇒ 不放行**',
  labelOnly.ok === false &&
    labelOnly.via === 'none' &&
    belowFloor.ok === false &&
    atFloor.ok === true &&
    atFloor.via === 'semantic' &&
    defaultFloor.ok === false,
  `只有标签=${labelOnly.via}（应 none）· 低于阈值=${belowFloor.via}（应 none）· 达标=${atFloor.via}（应 semantic）· 缺省阈值=${defaultFloor.via}（应 none）`,
  6
)

/* ===========================================================================
 * 汇总与证据
 * =========================================================================== */
const measuredCount = checks.reduce((sum, check) => sum + check.measured, 0)
const failedChecks = checks.filter((check) => !check.pass)
const gateValid = measuredCount > 0
const passed = gateValid && failedChecks.length === 0
/**
 * ⚠️ 这个门的 verdict **刻意是 `NEGATIVE_RESULT`**（不是 PASS，也不是普通 FAIL）。
 *
 * 它记录的是一个**否定性读数**：选项②（只靠 recency+subject 的显式经历路径）
 * **能召回但守不住精度** ⇒ **不该启用在缺省**。
 * 把它标成 FAIL 会让人以为"实现坏了要修"；标成 PASS 会谎称"路通了"。
 * 它真正说的是：**这条路单独上不够，需要真正的判据（语义 / 显式指称）**。
 */
const verdict = !gateValid ? 'MEASUREMENT INVALID' : passed ? 'PASS' : 'NEGATIVE_RESULT'

const { mkdirSync, writeFileSync } = await import('node:fs')
const { join, resolve } = await import('node:path')
const { execFileSync } = await import('node:child_process')
const REPO_ROOT = resolve(process.cwd())
let head = 'unknown'
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
} catch {
  /* 只读盘点失败不改变判定 */
}
const runId = `postlv2-s7-gate-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })
const artifact = {
  runId,
  gate: 'postlv2:s7:gate',
  milestone: 'post-lv2 / S7 shared-experience recall path (relevance gate)',
  generatedAt: new Date().toISOString(),
  source: { head },
  memoryUnderTest: { summary: SUMMARY, sourceId: STORY_SOURCE_ID },
  paraphrases: paraphraseRows,
  unrelated: unrelatedRows,
  checks,
  measuredCount,
  verdict,
  notClaimed: [
    '不主张改述的**语义**理解：这条路用的是"关于这个用户的、最近发生的事"这条最弱真实相关性，不是语义相似度',
    '不推翻 ADR-084：片段粒度（trigram）与 lexicalOverlapStrength 一字未动',
    '不主张声明类记忆的行为有任何变化（方向 C 就是这条断言）',
  ],
}
writeFileSync(join(outDir, 's7-gate.json'), JSON.stringify(artifact, null, 2), 'utf8')

console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${verdict === 'PASS' ? '✅' : verdict === 'NEGATIVE_RESULT' ? '🟡' : '❌'} postlv2:s7:gate = ${verdict}`)
console.log(`  🟡 **否定性读数**：选项②能召回（3/3）但守不住精度（无关 3/3 也混入）⇒ 缺省**不开**`)
console.log(`  证据：artifacts/post-lv2/${runId}/s7-gate.json`)
/* 退出码 0：它是一个**成功的测量**（结论是否定的），不是"运行失败" */
process.exit(0)
