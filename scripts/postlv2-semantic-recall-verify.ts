/** ADR-096：本地编码校准 + 真实召回/网关链；只操作 isolateDatabase 的库。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isolateDatabase } from '../src/dev/sandbox.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { createEncoderClient } from '../src/infrastructure/semantic/encoder-client.ts'
import { embeddingFingerprintOf, loadEmbeddingManifest } from '../src/infrastructure/semantic/embedding-manifest.ts'
import { DEFAULT_RECALL_RANKING_POLICY, hasRelevanceEvidence, rankCandidates, scoreCandidate } from '../src/kernel/recall/ranking.ts'
import { createRecallRequest, type RecallCandidate, type SemanticMode } from '../src/kernel/contracts/recall.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { filterEligible } from '../src/kernel/recall/eligibility.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import { renderMemoryForIndex, RENDERER_VERSION } from '../src/kernel/app/recall/index-render.ts'
import type { MemoryRecord } from '../src/kernel/contracts/memory.ts'

const root = resolve(process.cwd())
const startedAt = new Date().toISOString()
const before = digestTree(join(root, 'data/pglite'))
const manifest = loadEmbeddingManifest(join(root, 'evals/m9.5/embedding-manifest.json'))
const encoder = createEncoderClient({ manifest, repoRoot: root,
  localModelPath: join(root, 'artifacts/m9.5/local/embedding-lab/models'),
  deadlineMs: 120_000, readyTimeoutMs: 180_000 })
const readings: { name: string; pass: boolean; detail: unknown }[] = []
function check(name: string, pass: boolean, detail: unknown = null) {
  readings.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`)
}

interface Scene {
  split: 'dev' | 'val'
  passages: string[]
  queries: [string, number | null][]
}
// 先声明判据：每组至少 4/6 相关问句过闸，6/6 无关问句不放行。
// dev 使用前序探索样本；val 是参数确定后新建的不同事实/经历，不冒称真人盲测。
const scenes: Scene[] = [
  { split: 'dev', passages: [
    'education.institution 示例工程科技大学', 'food.avoid.general 香菜', 'person.birthday 五月二十日',
    '我们一起准备极创工作室的二面：她看过我的简历，我们约好二面聊项目。',
    '我们昨晚在湖边散步，看到一只走丢的白猫，后来一起把它送还给邻居。',
    '上周五下雨，我忘带伞，她陪我在便利店等到雨停。',
  ], queries: [
    ['你还记得我是在哪个高校读书的吗？', 0], ['我吃东西时最不愿意碰什么蔬菜？', 1],
    ['我每年哪一天庆生？', 2], ['对了，我们之前是不是聊过我找工作的事？', 3],
    ['你还记得咱们之前帮邻居找到宠物的事吗？', 4], ['那次被雨困住的时候，我们在哪里等天晴？', 5],
    ['你觉得足球世界杯的比赛好看吗？', null], ['我对哪种药物过敏？', null],
    ['太阳为什么会发光？', null], ['我们之前一起去过东京吗？', null],
    ['你知道我的电话号码吗？', null], ['现在外面的温度是多少？', null],
  ] },
  { split: 'val', passages: [
    'work.role 软件工程师', 'food.avoid.general 苦瓜', 'project.background.active 给虚拟角色实现长期记忆与自然对话',
    '去年冬天我和她去山里看日出，出发太早，在车上喝了热豆浆。',
    '我们在美术馆看了印象派画展，我最喜欢那幅睡莲，她和我一起拍了合照。',
    '昨天我准备搬家，她帮我整理书箱和清点书本，我们把书分了三箱。',
  ], queries: [
    ['我从事什么职业？', 0], ['我不愿意吃哪种蔬菜？', 1],
    ['我正在做的东西是不是智能聊天伙伴？', 2], ['我们是不是曾经清晨去登高看太阳升起来？', 3],
    ['你记得咱们去欣赏绘画展览的那回吗？', 4], ['你还记得帮我为换住处收拾书籍的那件事吗？', 5],
    ['我的银行卡号码是什么？', null], ['我对哪种抗生素过敏？', null],
    ['明天的股票价格是多少？', null], ['我们一起在沙漠骑过骆驼吗？', null],
    ['你知道我的结婚纪念日吗？', null], ['我上次考驾照得了多少分？', null],
  ] },
]

const calibration: { split: string; target: number | null; top: number; score: number; margin: number; accepted: boolean }[] = []
const calibrationPasses = (rows: typeof calibration) =>
  rows.filter((row) => row.target !== null).length === 6 &&
  rows.filter((row) => row.target === null).length === 6 &&
  rows.filter((row) => row.accepted && row.top === row.target).length >= 4 &&
  rows.every((row) => !row.accepted || row.top === row.target)
let stopHarness: (() => Promise<void>) | undefined
try {
  for (const scene of scenes) {
    const passageTexts = scene.passages.map((text, index) => {
      const record = { content: index < 3
        ? { kind: 'claim', predicate: text.slice(0, text.indexOf(' ')), value: text.slice(text.indexOf(' ') + 1) }
        : { kind: 'episode', summary: text } } as MemoryRecord
      const rendered = renderMemoryForIndex(record)
      assert(rendered.ok)
      return rendered.rendered.text
    })
    const encoded = await encoder.encode([...passageTexts, ...scene.queries.map(([q]) => `${manifest.queryPrefix}${q}`)])
    assert(encoded.ok, encoded.ok ? '' : encoded.detail)
    const vectors = encoded.vectors.slice(0, passageTexts.length)
    for (let index = 0; index < scene.queries.length; index += 1) {
      const query = encoded.vectors[passageTexts.length + index]!
      const scores = vectors.map((v, target) => ({ target, score: v.reduce((sum, x, k) => sum + x * query[k]!, 0) }))
        .sort((a, b) => b.score - a.score)
      const top = scores[0]!
      const margin = top.score - scores[1]!.score
      const accepted = hasRelevanceEvidence({ request: { target: { status: 'none' } } as never,
        candidate: { retrievedBy: ['semantic'], semanticScore: top.score } as never,
        semanticRelevanceFloor: DEFAULT_RECALL_RANKING_POLICY.semanticRelevanceFloor,
        semanticRelevanceMinMargin: DEFAULT_RECALL_RANKING_POLICY.semanticRelevanceMinMargin, semanticMargin: margin }).ok
      calibration.push({ split: scene.split, target: scene.queries[index]![1], top: top.target, score: top.score, margin, accepted })
    }
    const rows = calibration.filter((row) => row.split === scene.split)
    const hits = rows.filter((row) => row.target !== null && row.accepted && row.top === row.target).length
    const falseHits = rows.filter((row) => row.accepted && row.top !== row.target).length
    check(`${scene.split}: 相关 >=4/6，无关误放行 0/6`, calibrationPasses(rows), { hits, falseHits })
  }

  const dev = calibration.filter((row) => row.split === 'dev')
  check('校准量具三段式：真实档通过、误放行/空档拒绝、恢复通过',
    calibrationPasses(dev) && !calibrationPasses(dev.map((row) => ({ ...row, accepted: true }))) &&
    !calibrationPasses([]) && calibrationPasses(dev))

  const user = entityRef('user', 'semantic-recall-user')
  const owner = entityRef('character', 'semantic-recall-character')
  const request = (mode: SemanticMode) => createRecallRequest({ traceId: 'semantic-recall-test', characterId: String(owner.id),
    user, query: { text: '对了，我们之前是不是聊过我找工作的事？' }, intent: 'experience',
    contextBudget: { memoryTokens: 500 }, retrievalPolicyVersion: 'hybrid-relevance@1', semanticMode: mode })
  const candidate: RecallCandidate = { memoryId: 'semantic-test-memory' as never, owner, type: 'episode', status: 'active',
    authority: 'EXPLICIT_USER_STATEMENT', epistemicStatus: 'reported', subjects: [user], importance: 0.7, confidence: 0.8,
    recordedAt: Date.now(), contentFingerprint: 'semantic-test', searchable: '', dataText: '经历测试', sourceRefs: [],
    retrievedBy: ['semantic'], integrityOk: true, semanticScore: 0.91 }
  const capabilities = { supported: ['semantic'], unavailable: [], degraded: false } as never
  const ranked = (mode: SemanticMode, candidates = [candidate]) => rankCandidates({ request: request(mode), candidates, capabilities, now: candidate.recordedAt })
  check('on: 单候选纯语义进最终排名', ranked('on').ranked.length === 1)
  check('off / shadow: 纯语义不改变选择', ranked('off').ranked.length === 0 && ranked('shadow').ranked.length === 0)
  check('高分但无领先间隔不放行', ranked('on', [candidate, { ...candidate, memoryId: 'semantic-tie' as never, semanticScore: 0.905 }]).ranked.length === 0)
  check('只有标签、NaN、低分不放行', [undefined, NaN, 0.86].every((semanticScore) => ranked('on', [{ ...candidate, semanticScore }]).ranked.length === 0))
  for (const [name, override] of [
    ['撤回', { status: 'retracted' }], ['其它用户', { subjects: [entityRef('user', 'other')] }],
    ['其它角色', { owner: entityRef('character', 'other') }], ['来源链断', { integrityOk: false }],
  ] as const) {
    check(`纯语义不绕过${name}`, filterEligible({ request: request('on'), candidates: [{ ...candidate, ...override } as RecallCandidate] }).eligible.length === 0)
  }
  const score = (mode: SemanticMode, c = candidate) => scoreCandidate({ request: request(mode), candidate: c, capabilities, now: candidate.recordedAt })
  check('语义分数在 on 中影响最终总分', Math.abs(score('on').total - score('off').total - 0.91) < 0.000001)
  const authority = (c: RecallCandidate) => score('on', c).components.find((part) => part.name === 'authority')!.value
  check('来源降档仍独立生效', authority({ ...candidate, qualification: 'ESTABLISHED' }) > authority({ ...candidate, qualification: 'UNCONFIRMED_ORIGIN' }))

  isolateDatabase('postlv2-semantic-recall', { keep: false })
  const { createM55Harness } = await import('./m5.5-harness.ts')
  const { createSemanticProbe } = await import('../src/infrastructure/semantic/semantic-probe.ts')
  const { createMemoryRetrievalStore } = await import('../src/infrastructure/persistence/memory-retrieval-store.ts')
  const { createMemoryRecallService } = await import('../src/kernel/app/recall/retrieval.ts')
  const { createRecallTurnPort } = await import('../src/kernel/app/recall/turn.ts')
  const { memoryIntegrityProblems } = await import('../src/infrastructure/persistence/memory-integrity.ts')
  const { rootReadingsByMemory } = await import('../src/infrastructure/persistence/qualification-read.ts')
  const { createProductionMaintenanceRunner, integrityProblemsByMemory, resolveMaintenanceGenerationId } = await import('../src/infrastructure/persistence/semantic-index-production-runner.ts')
  const { createEncoderIndexPort } = await import('../src/infrastructure/persistence/semantic-index-encoder-port.ts')
  const { ensureSemanticIndexSchema } = await import('../src/infrastructure/persistence/memory-semantic-index.ts')
  const bed = await createM55Harness({ label: 'postlv2-semantic-recall' })
  const h = bed.h
  stopHarness = () => h.stop()
  await ensureSemanticIndexSchema(h.db, { now: Date.now() })
  let storyId = ''
  for (const [index, summary] of scenes[0]!.passages.slice(3).entries()) {
    const evidence = await h.recordUserEvidence(`记住这次经历：${summary}`)
    const memory = await h.commitAndFold(h.makeCandidate('episode', { kind: 'episode', summary,
      occurredAt: Date.now(), participants: [h.user], eventRefs: [evidence.ref.id] } as never,
    { sourceRefs: [evidence.ref], importance: 0.7 }), Date.now() + index)
    assert(memory, '正式 Memory 链必须写入经历')
    if (index === 0) storyId = String(memory.id)
  }
  const namespace = String(h.characterId)
  await h.db.execute(sql`insert into memory_semantic_generations
    (generation_id, namespace, model_fingerprint, renderer_version, dimension, index_schema_version, build_state, created_at)
    values ('legacy-renderer', ${namespace}, ${embeddingFingerprintOf(manifest)}, 'semantic-render@1', 384, 2, 'published', 1)`)
  const generationId = await resolveMaintenanceGenerationId(h.db, namespace)
  check('渲染器升级不复用旧 published 代', generationId !== 'legacy-renderer')
  const maintain = createProductionMaintenanceRunner({ db: h.db, namespace, generationId,
    rendererVersion: RENDERER_VERSION, encoder: createEncoderIndexPort(encoder, { modelFingerprint: embeddingFingerprintOf(manifest) }),
    tokenizerFingerprint: 'tokenizer@frozen-manifest', pooling: manifest.pooling, normalize: manifest.normalize,
    dtype: manifest.dtype, dimension: manifest.dimension,
    integrityProblemsOf: integrityProblemsByMemory(await memoryIntegrityProblems(h.db, h.owner)) })
  const maintained = await maintain()
  check('正式维护入口发布 @2 的经历索引', maintained?.build.buildState === 'published', maintained)
  const maintainedAgain = await maintain()
  check('失效检查保留有效经历向量', maintainedAgain?.reconcile.kept === 3 && maintainedAgain.reconcile.removedIneligible === 0, maintainedAgain)
  const service = createMemoryRecallService({ port: createMemoryRetrievalStore({ store: h.store,
    integrity: (o) => memoryIntegrityProblems(h.db, o), rootReadings: (ids) => rootReadingsByMemory(h.db, ids),
    semanticProbe: createSemanticProbe({ db: h.db, manifest, encoder }) }) })
  const recall = createRecallTurnPort({ service, budget: DEFAULT_CONTEXT_BUDGET, now: () => Date.now() })
  const text = scenes[0]!.queries[3]![0]
  const actualRequest = createRecallRequest({ traceId: 'semantic-recall-real', characterId: namespace, user: h.user,
    query: { text }, intent: 'experience', contextBudget: { memoryTokens: 500 }, retrievalPolicyVersion: 'hybrid-relevance@1', semanticMode: 'on' })
  const retrieved = await service.retrieveCandidates(actualRequest)
  const actualCandidate = retrieved.candidates.find((c) => String(c.memoryId) === storyId)
  check('真实编码命中，词面零命中', actualCandidate?.retrievedBy.includes('semantic') === true && !actualCandidate.retrievedBy.includes('lexical'), actualCandidate?.semanticScore)
  const selected = await recall.run(actualRequest)
  check('纯语义经历进入预算选择后的上下文', selected.trace.selectedIds.includes(storyId) && selected.selection.blockText.includes('极创'))
  for (const mode of ['off', 'shadow', 'on'] as const) {
    const gateway = bed.gatewayOf({ search: 'off', recall, recallEnabled: true, recallPolicyVersion: 'hybrid-relevance@1', recallSemanticMode: mode })
    const turn = await bed.say({ gateway, text, replyText: '本轮回复使用隔离离线 provider。' })
    const inPacket = JSON.stringify(turn.packet).includes(scenes[0]!.passages[3]!)
    check(`真实 TurnGateway ${mode}: 经历${mode === 'on' ? '进入' : '不进入'} prompt`, inPacket === (mode === 'on'))
    check(`${mode}: trace 不包含经历正文`, !JSON.stringify(turn.trace).includes(scenes[0]!.passages[3]!))
  }
  const unrelated = await recall.run({ ...actualRequest, query: { text: '我的银行卡号码是什么？', source: 'user_message' } })
  check('真实召回链拦住无关问句', unrelated.trace.selectedIds.length === 0, unrelated.trace.exclusionHistogram)
  const dryGateway = bed.gatewayOf({ search: 'off', recall, recallEnabled: true, recallPolicyVersion: 'hybrid-relevance@1', recallSemanticMode: 'on', dryRun: true })
  const dryTurn = await bed.say({ gateway: dryGateway, text, replyText: '只读入口。' })
  check('只读网关也消费纯语义结果', JSON.stringify(dryTurn.packet).includes(scenes[0]!.passages[3]!))
  const main = readFileSync(join(root, 'src/main.ts'), 'utf8')
  check('CLI / bridge 共用带语义模式的生产网关', main.includes('recall: this.buildRecallTurnPort()') && main.includes('recallSemanticMode: this.flags.memorySemanticMode') && main.includes('sessionHost(session,'))
} catch (error) {
  check('验证链执行完成', false, error instanceof Error ? error.message : String(error))
} finally {
  await stopHarness?.()
  await encoder.close()
  const after = digestTree(join(root, 'data/pglite'))
  check('本轮真实库摘要未变', before.treeSha256 === after.treeSha256)
  const out = join(root, 'artifacts/post-lv2', `semantic-recall-${startedAt.replace(/[:.]/g, '-')}`)
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'result.json'), JSON.stringify({ startedAt, completedAt: new Date().toISOString(),
    verdict: readings.length > 0 && readings.every((r) => r.pass) ? 'PASS' : 'FAIL',
    policyVersion: 'semantic-relevance@1', rendererVersion: RENDERER_VERSION,
    floor: DEFAULT_RECALL_RANKING_POLICY.semanticRelevanceFloor, minMargin: DEFAULT_RECALL_RANKING_POLICY.semanticRelevanceMinMargin,
    model: manifest.modelId, measuredCount: readings.length, passed: readings.filter((r) => r.pass).length,
    failures: readings.filter((r) => !r.pass), calibration, readings,
    sourceHashes: Object.fromEntries([
      'src/kernel/recall/ranking.ts',
      'src/infrastructure/persistence/semantic-index-source.ts',
      'src/infrastructure/persistence/semantic-index-builder.ts',
      'src/infrastructure/persistence/semantic-index-reconcile.ts',
      'src/infrastructure/persistence/semantic-index-production-runner.ts',
      'scripts/postlv2-semantic-recall-verify.ts',
    ].map((path) => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')])),
    realDb: { opened: false, unchanged: before.treeSha256 === after.treeSha256 } }, null, 2) + '\n')
  console.log(`证据：${out}`)
  if (readings.some((r) => !r.pass)) process.exitCode = 1
}
