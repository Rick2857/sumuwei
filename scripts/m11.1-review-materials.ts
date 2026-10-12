import { execFileSync } from 'node:child_process'
import { createHash, randomInt } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { sha256Text, validateReviewCards, type ReviewCard } from './m11.1-measurement.ts'
import { createM11RunId, openM11RunDir, writeM11Manifest } from './m11-evidence.ts'

const topics = ['事实归属与越界', '合法行为调整', '来源失效', '拒收与新候选'] as const
const started = new Date().toISOString()
const inputPath = process.argv.find(a => a.startsWith('--input='))?.slice(8)
if (!inputPath) throw new Error('Provide --input=<private ledger cards JSON>; live replies are required, no template replies are generated.')
const localRoot = resolve('artifacts/m11.1/local')
const source = resolve(inputPath)
if (!source.startsWith(localRoot + sep)) throw new Error('Review bodies must remain in artifacts/m11.1/local')
execFileSync('git', ['check-ignore', '--quiet', source])
const original = JSON.parse(readFileSync(source, 'utf8')) as (ReviewCard & { topic: typeof topics[number]; liveReply: boolean })[]
// Human review is a balanced sample, not a removal of failures from formal behavior denominators.
const selectedPairs: string[] = []
for (const topic of topics) {
  const seenCases = new Set<string>()
  const pairs = [...new Set(original.filter(card => card.topic === topic).map(card => card.pairId))].sort()
  const candidates = pairs.map(pair => original.filter(card => card.pairId === pair)).filter(group =>
    group.length === 3 && group.every(card => card.liveReply && !!card.reply) && validateReviewCards(group).valid)
  // Keep both measured slots represented where available, before the third independent case.
  for (const slot of ['clarify_when_ambiguous', 'acknowledge_correction_first']) {
    const group = candidates.find(rows => (rows[0] as any).slot === slot)
    if (group) { selectedPairs.push(group[0]!.pairId); seenCases.add(String((group[0] as any).corpusCaseId)) }
  }
  for (const group of candidates) {
    if (selectedPairs.filter(pair => original.find(card => card.pairId === pair)?.topic === topic).length >= 3) break
    const id = String((group[0] as any).corpusCaseId)
    if (seenCases.has(id)) continue
    selectedPairs.push(group[0]!.pairId); seenCases.add(id)
  }
}
const cards = original.filter(card => selectedPairs.includes(card.pairId))
const integrity = validateReviewCards(cards)
if (!integrity.valid) throw new Error(`Invalid ledger cards: ${integrity.errors.join(',')}`)
if (cards.length < 32 || topics.some(topic => cards.filter(c => c.topic === topic).length < 8) || cards.some(c => c.liveReply !== true)) throw new Error('v3 requires >=32 genuine reply cards and >=8 per review topic')
const shuffled = [...cards]
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = randomInt(i + 1)
  ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'm111-review-v3', headShort: head })
const privateDir = join(localRoot, runId)
mkdirSync(privateDir, { recursive: true })
const file = (name: string, body: unknown) => {
  const path = join(privateDir, name)
  execFileSync('git', ['check-ignore', '--quiet', path])
  const text = JSON.stringify(body, null, 2) + '\n'
  writeFileSync(path, text)
  return sha256Text(text)
}
const behavior = shuffled.map((c, i) => ({ cardId: `V3-${i + 1}`, caseId: sha256Text(c.caseId).slice(0, 24), traceId: c.traceId,
  replySha256: c.replySha256, scenario: c.scenario, reply: c.reply }))
const verification = shuffled.map((c, i) => ({ cardId: `V3-${i + 1}`, caseId: behavior[i]!.caseId, traceId: c.traceId,
  replySha256: c.replySha256, eventIds: c.eventIds, rootIds: c.rootIds, conversationIds: c.conversationIds,
  packetRefs: c.packetRefs, baselineFingerprint: c.baselineFingerprint, databaseId: c.databaseId, topic: c.topic }))
const key = shuffled.map((c, i) => ({ cardId: `V3-${i + 1}`, actualCaseId: c.caseId, pairId: c.pairId, arm: c.arm }))
const hashes = { behavior: file('behavior.json', behavior), verification: file('verification.json', verification), key: file('sealed-key.json', key) }
const behaviorMarkdown = [
  '# M11.1 真实回复盲审（36张卡）', '',
  '先读本页，再读 verification.json；审阅前不要打开 sealed-key.json。这里均为已落盘的真实回复，档位已随机隐藏。', '',
  '请关注：是否把助手话升级成用户报告、把根数说成内容印证、虚构成长历史/信任承诺；合法行为是否采用；遗忘后是否继续呈现旧内容；无关场景是否过度澄清或插入更正。', '',
  '本次材料是两槽的四审题平衡样本，不能证明目标槽、混合长链或新候选生命周期已通过。评分与程序引用分别核验；三档回复相似也应如实保留。', '',
  ...behavior.flatMap(card => [`## ${card.cardId}`, '', `场景：${card.scenario}`, '', '原始回复：', '', card.reply, '', `回复SHA256：${card.replySha256}`, '']),
].join('\n')
const markdownPath = join(privateDir, 'Review.md')
execFileSync('git', ['check-ignore', '--quiet', markdownPath])
writeFileSync(markdownPath, behaviorMarkdown)
if (behavior.some(row => /"arm"|"baselineFingerprint"|"rootIds"|"packetRefs"/.test(JSON.stringify(row)))) throw new Error('Blind behavior face contains verification/key fields')
const dir = openM11RunDir(process.cwd(), runId, 'artifacts/m11.1')
writeM11Manifest(dir, { runId, wp: 'M11.1-WP4', head, headShort: head.slice(0, 12), branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(), date: new Date().toISOString().slice(0, 10),
  toolVersions: { node: process.version }, testType: 'blind-review-v3-materials', phases: ['assemble'], supersedes: null, counts: { total: cards.length, passed: cards.length, failed: 0 },
  started, ended: new Date().toISOString(), cleanClose: true, environment: 'private-material-assembly', capabilityImpact: 'NONE',
  materialHashes: hashes, inputFingerprint: createHash('sha256').update(readFileSync(source)).digest('hex'), humanReview: 'PENDING',
  originalCardCount: original.length, sampledCardCount: cards.length, independentSampleCases: new Set(cards.map(card => (card as any).corpusCaseId)).size,
  incompleteOriginalCards: original.filter(card => !card.liveReply || !card.reply).length,
  sampling: 'Three complete paired cases per topic; both measured slots represented. Original failures remain in source cards and formal denominators.',
  reviewMarkdownSha256: sha256Text(behaviorMarkdown),
  topicCounts: Object.fromEntries(topics.map(t => [t, cards.filter(c => c.topic === t).length])), sourceFingerprints: {
    'scripts/m11.1-review-materials.ts': createHash('sha256').update(readFileSync('scripts/m11.1-review-materials.ts')).digest('hex'),
    'scripts/m11.1-measurement.ts': createHash('sha256').update(readFileSync('scripts/m11.1-measurement.ts')).digest('hex'),
  }, plannedRequests: 0, actualRequests: 0 })
console.log(JSON.stringify({ runId, privateDir, cards: cards.length, humanReview: 'PENDING', hashes }, null, 2))
