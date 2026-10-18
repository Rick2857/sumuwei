/**
 * S1 · 拒绝套件完整性门（`s1:rejection-suite:verify`）
 *
 * 归属：多用户补充计划 S1（[ADR-134](../../docs/adr/ADR-134-rejection-contract-and-zero-failure-gate.md)；
 *       契约 [Rejection-Safety-Contract.md](../../docs/post-lv2/Rejection-Safety-Contract.md) §2/§4）。
 *
 * **纯进程内**：只读 `evals/s1/*.json` 与 `docs/post-lv2/Rejection-Safety-Contract.md`；
 * 零数据库 / 零模型 / 零出网 / 不占端口 / 不写证据 / 不改工作树。
 *
 * ⚠️ 本门只冻结**套件形状**（哪些用例、什么类别、覆盖哪些输入面、是否必选、有无被悄悄改动）。
 *    **不**执行任何用例、**不**主张拒绝能力已通过 —— 那是 S1 的执行门（E-1…E-4）。
 *
 * 三段式：
 *   正控  套件自检（id 唯一 / 类别闭集 / 回复面闭集 / 必选 / 覆盖 7 类 8 面 / 6 条正控）
 *   负控  故意坏掉的套件**每一条都必须被判红**（删一类 / 重复 id / 未知字段 /
 *         契约里没有的 id / 哈希不符 / 摘掉必选）
 *   恢复  真实套件重新通过
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SUITE_PATH = join(REPO_ROOT, 'evals', 's1', 'rejection-suite.json')
const FREEZE_PATH = join(REPO_ROOT, 'evals', 's1', 'rejection-suite.freeze.json')
const CONTRACT_PATH = join(REPO_ROOT, 'docs', 'post-lv2', 'Rejection-Safety-Contract.md')

interface Case {
  readonly id: string
  readonly class: string
  readonly replySide: string
  readonly inputFaces: readonly string[]
  readonly mandatory: boolean
  readonly input: string
  readonly sideEffect: string
}

interface Suite {
  readonly schemaVersion: number
  readonly suiteId: string
  readonly faces: readonly string[]
  readonly classes: readonly string[]
  readonly cases: readonly Case[]
  readonly positiveControls: readonly { readonly id: string; readonly mandatory: boolean }[]
  readonly releaseRule: Readonly<Record<string, unknown>>
}

interface Freeze {
  readonly suiteId: string
  readonly suiteFile: string
  readonly sha256: string
  readonly bytes: number
  readonly frozenAt: string
  readonly counts: {
    readonly rejectionCases: number
    readonly positiveControls: number
    readonly classes: number
    readonly faces: number
  }
  readonly history: readonly unknown[]
}

const checks: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail: string): void => {
  checks.push({ name, ok, detail })
}

const REPLY_SIDES = ['R', 'A', 'A/R']
const ALLOWED_CASE_KEYS = ['id', 'class', 'replySide', 'inputFaces', 'mandatory', 'input', 'sideEffect']

/**
 * 唯一的套件校验器。**故意**做成"吃一个对象"，好让负控能在内存里喂坏掉的副本
 * （不必写临时文件、更不必改真套件）。
 */
function validateSuite(suite: unknown, contractRejectionIds: ReadonlySet<string>, contractPcIds: ReadonlySet<string>): string[] {
  const problems: string[] = []
  if (suite === null || typeof suite !== 'object') return ['套件不是对象']
  const s = suite as Partial<Suite>

  if (s.schemaVersion !== 1) problems.push(`schemaVersion 必须是 1，收到 ${String(s.schemaVersion)}`)
  if (s.suiteId !== 's1-rejection-suite') problems.push(`suiteId 不符：${String(s.suiteId)}`)

  const faces = Array.isArray(s.faces) ? (s.faces as string[]) : []
  const classes = Array.isArray(s.classes) ? (s.classes as string[]) : []
  if (faces.length === 0) problems.push('faces 为空')
  if (classes.length === 0) problems.push('classes 为空')
  if (new Set(faces).size !== faces.length) problems.push('faces 有重复')
  if (new Set(classes).size !== classes.length) problems.push('classes 有重复')

  const cases = Array.isArray(s.cases) ? (s.cases as Case[]) : []
  if (cases.length === 0) problems.push('cases 为空')

  const ids = cases.map((c) => c.id)
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (dupes.length > 0) problems.push(`用例 id 重复：${[...new Set(dupes)].join(', ')}`)

  for (const c of cases) {
    const keys = Object.keys(c as unknown as Record<string, unknown>)
    const unknown = keys.filter((k) => !ALLOWED_CASE_KEYS.includes(k))
    if (unknown.length > 0) problems.push(`${c.id} 有未知字段：${unknown.join(', ')}`)
    if (!classes.includes(c.class)) problems.push(`${c.id} 的类别不在闭集：${c.class}`)
    if (!REPLY_SIDES.includes(c.replySide)) problems.push(`${c.id} 的 replySide 非法：${c.replySide}`)
    if (!Array.isArray(c.inputFaces) || c.inputFaces.length === 0) problems.push(`${c.id} 缺 inputFaces`)
    else {
      for (const f of c.inputFaces) if (!faces.includes(f)) problems.push(`${c.id} 的输入面不在闭集：${f}`)
    }
    if (c.mandatory !== true) problems.push(`${c.id} 必须是必选（零失败口径不允许"可选"用例）`)
    if (typeof c.input !== 'string' || c.input.trim() === '') problems.push(`${c.id} 缺 input`)
    if (typeof c.sideEffect !== 'string' || c.sideEffect.trim() === '') problems.push(`${c.id} 缺 sideEffect`)
    // 与契约的**双向**对账（只对拒绝用例）
    if (!contractRejectionIds.has(c.id)) problems.push(`${c.id} 在契约 §2 里找不到（套件不能自造用例）`)
  }

  // 覆盖：每个类别至少一条；每个输入面至少被用到一次
  for (const cls of classes) {
    if (!cases.some((c) => c.class === cls)) problems.push(`类别 ${cls} 没有任何用例`)
  }
  for (const face of faces) {
    if (!cases.some((c) => c.inputFaces.includes(face))) problems.push(`输入面 ${face} 没有被任何用例覆盖`)
  }

  // 契约里有、套件里没有 ⇒ 漏用例
  const missing = [...contractRejectionIds].filter((id) => !ids.includes(id))
  if (missing.length > 0) problems.push(`契约里有但套件缺失：${missing.join(', ')}`)

  const pcs = Array.isArray(s.positiveControls) ? (s.positiveControls as { id: string; mandatory: boolean }[]) : []
  if (pcs.length !== contractPcIds.size) problems.push(`正控数量必须是 ${contractPcIds.size}，收到 ${pcs.length}`)
  for (const pc of pcs) {
    if (pc.mandatory !== true) problems.push(`正控 ${pc.id} 必须是必选`)
    if (!contractPcIds.has(pc.id)) problems.push(`正控 ${pc.id} 在契约里找不到`)
  }
  const missingPc = [...contractPcIds].filter((id) => !pcs.some((pc) => pc.id === id))
  if (missingPc.length > 0) problems.push(`契约里有但正控缺失：${missingPc.join(', ')}`)

  const rule = (s.releaseRule ?? {}) as Record<string, unknown>
  if (rule.zeroFailure !== true) problems.push('releaseRule.zeroFailure 必须是 true')
  if (rule.failedMustEqual !== 0) problems.push('releaseRule.failedMustEqual 必须是 0')
  if (rule.notRunMustEqual !== 0) problems.push('releaseRule.notRunMustEqual 必须是 0')
  if (rule.undecidableMustEqual !== 0) problems.push('releaseRule.undecidableMustEqual 必须是 0')
  if (rule.measuredCountMustExceedZero !== true) problems.push('releaseRule.measuredCountMustExceedZero 必须是 true')

  return problems
}

// ---------------------------------------------------------------------------
// 读真套件 + 冻结档 + 契约
// ---------------------------------------------------------------------------
const suiteBytes = readFileSync(SUITE_PATH)
const suiteHash = createHash('sha256').update(suiteBytes).digest('hex')
const suite = JSON.parse(suiteBytes.toString('utf8')) as Suite
const freeze = JSON.parse(readFileSync(FREEZE_PATH, 'utf8')) as Freeze
const contractText = readFileSync(CONTRACT_PATH, 'utf8')

/** 契约 §2 两张表里的用例 id（只认 `T-RJ#-##` / `T-PC-##`，不认 `T-RJ7-*` 这种通配写法） */
const contractIds = new Set<string>()
for (const m of contractText.matchAll(/`(T-(?:RJ\d|PC)-\d\d)`/g)) contractIds.add(m[1]!)
/** 拒绝用例 id（T-RJ*）与正控 id（T-PC*）**必须分开**：前者进 cases，后者进 positiveControls。 */
const contractRejectionIds = new Set([...contractIds].filter((id) => id.startsWith('T-RJ')))
const contractPcIds = new Set([...contractIds].filter((id) => id.startsWith('T-PC')))

// ---------------------------------------------------------------------------
// 正控：真套件必须干净
// ---------------------------------------------------------------------------
const realProblems = validateSuite(suite, contractRejectionIds, contractPcIds)
check('正控 · 真套件通过校验', realProblems.length === 0, realProblems.length === 0 ? `${suite.cases.length} 条拒绝用例 + ${suite.positiveControls.length} 条正控` : realProblems.slice(0, 3).join('；'))
check('正控 · 契约里识别到用例 id', contractIds.size >= 25, `contractIds=${contractIds.size}`)
check(
  '正控 · 冻结哈希一致',
  freeze.sha256 === suiteHash && freeze.bytes === suiteBytes.length,
  `freeze=${freeze.sha256.slice(0, 12)}… · 实际=${suiteHash.slice(0, 12)}… · bytes=${suiteBytes.length}`
)
check(
  '正控 · 冻结档的计数与套件一致',
  freeze.counts.rejectionCases === suite.cases.length &&
    freeze.counts.positiveControls === suite.positiveControls.length &&
    freeze.counts.classes === suite.classes.length &&
    freeze.counts.faces === suite.faces.length,
  `${JSON.stringify(freeze.counts)}`
)
const classesCovered = suite.classes.filter((c) => suite.cases.some((x) => x.class === c))
const facesCovered = suite.faces.filter((f) => suite.cases.some((x) => x.inputFaces.includes(f)))
check('正控 · 7 类全覆盖', classesCovered.length === suite.classes.length, `${classesCovered.length}/${suite.classes.length}`)
check('正控 · 8 个输入面全覆盖', facesCovered.length === suite.faces.length, `${facesCovered.length}/${suite.faces.length}`)

// ---------------------------------------------------------------------------
// 负控：每一条坏掉的套件都必须被判红（三段式的第二段）
// ---------------------------------------------------------------------------
const clone = (): Suite => JSON.parse(JSON.stringify(suite)) as Suite

function expectRejected(name: string, mutate: (s: Suite) => void, needle: string): void {
  const broken = clone()
  mutate(broken)
  const problems = validateSuite(broken, contractRejectionIds, contractPcIds)
  const hit = problems.some((p) => p.includes(needle))
  check(`负控 · ${name}`, hit, hit ? `捕获（${problems.length} 条）` : `**没捕获**（期望含「${needle}」）`)
}

expectRejected('删掉一整类用例（RJ-6）', (s) => {
  ;(s as unknown as { cases: Case[] }).cases = (s.cases as Case[]).filter((c) => c.class !== 'RJ-6')
}, 'RJ-6')

expectRejected('重复一个用例 id', (s) => {
  const list = s.cases as Case[]
  ;(s as unknown as { cases: Case[] }).cases = [...list, list[0]!]
}, '重复')

expectRejected('塞入一个未知字段', (s) => {
  const list = JSON.parse(JSON.stringify(s.cases)) as Record<string, unknown>[]
  list[0]!['sneaky'] = true
  ;(s as unknown as { cases: unknown }).cases = list
}, '未知字段')

expectRejected('自造一个契约里没有的用例', (s) => {
  const list = JSON.parse(JSON.stringify(s.cases)) as Case[]
  list.push({ ...list[0]!, id: 'T-RJ9-99' })
  ;(s as unknown as { cases: Case[] }).cases = list
}, 'T-RJ9-99')

expectRejected('把必选摘掉（改成可选）', (s) => {
  const list = JSON.parse(JSON.stringify(s.cases)) as Record<string, unknown>[]
  list[0]!['mandatory'] = false
  ;(s as unknown as { cases: unknown }).cases = list
}, '必选')

expectRejected('契约里有但套件缺失', (s) => {
  ;(s as unknown as { cases: Case[] }).cases = (s.cases as Case[]).slice(1)
}, '缺失')

expectRejected('输入面没被覆盖', (s) => {
  ;(s as unknown as { cases: Case[] }).cases = (s.cases as Case[]).map((c) => ({ ...c, inputFaces: ['IN-1'] }))
}, '没有被任何用例覆盖')

expectRejected('零失败口径被改写', (s) => {
  ;(s as unknown as { releaseRule: Record<string, unknown> }).releaseRule = {
    ...(s.releaseRule as Record<string, unknown>),
    failedMustEqual: 1,
  }
}, 'failedMustEqual')

// 哈希漂移（不靠 validateSuite，而是靠冻结档比对）
{
  const drifted = `${suiteBytes.toString('utf8')}\n`
  const driftedHash = createHash('sha256').update(Buffer.from(drifted, 'utf8')).digest('hex')
  check(
    '负控 · 套件改动一字节 ⇒ 冻结哈希不符（必须显式更新冻结档）',
    driftedHash !== freeze.sha256,
    `drift=${driftedHash.slice(0, 12)}… ≠ freeze=${freeze.sha256.slice(0, 12)}…`
  )
}

// ---------------------------------------------------------------------------
// 恢复：真套件再次通过
// ---------------------------------------------------------------------------
check('恢复 · 真套件重新通过校验', validateSuite(suite, contractRejectionIds, contractPcIds).length === 0, '干净')

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok)
for (const c of checks) console.log(`${c.ok ? '  ok  ' : ' FAIL '} ${c.name} —— ${c.detail}`)
console.log('')
console.log(`measured_count=${checks.length} · passed=${checks.length - failed.length} · failed=${failed.length}`)
console.log(`suite=${suite.suiteId} · cases=${suite.cases.length} · positiveControls=${suite.positiveControls.length} · sha256=${suiteHash.slice(0, 16)}…`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const c of failed) console.log(`  - ${c.name}：${c.detail}`)
}
process.exitCode = failed.length === 0 ? 0 : 1
