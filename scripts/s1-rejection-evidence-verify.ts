/**
 * S1 · 证据面归属门（`s1:rejection-evidence:verify`）
 *
 * 归属：多用户补充计划 S1（[ADR-134](../../docs/adr/ADR-134-rejection-contract-and-zero-failure-gate.md) §5 的 E-1…E-4）。
 *
 * **纯进程内**：只读 `evals/s1/rejection-suite.json`、`evals/s1/rejection-evidence-plan.json`
 * 与 `scripts/gates/manifest.ts` 的 `ALL_GATES`；
 * 零数据库 / 零模型 / 零出网 / 不占端口 / 不写证据 / 不改工作树。
 *
 * 它回答的唯一问题：**每个拒绝用例都有人负责给读数吗？**
 * 判据：① 套件的每个用例在计划里恰好一条；② 计划里不许多出用例；
 *       ③ 每个用例的证据面非空且落在 E-1…E-4 内；④ 声称 E-1 的必须**指名**至少一道**真实存在**的门；
 *       ⑤ `e1Complete=true` 的用例必须只靠 E-1（离线程序侧真的能独立判定）。
 *
 * ⚠️ 它**不**执行任何用例、**不**主张任何面已有读数。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_GATES } from './gates/manifest.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SUITE_PATH = join(REPO_ROOT, 'evals', 's1', 'rejection-suite.json')
const PLAN_PATH = join(REPO_ROOT, 'evals', 's1', 'rejection-evidence-plan.json')

const FACES = ['E-1', 'E-2', 'E-3', 'E-4'] as const
type Face = (typeof FACES)[number]

interface Entry {
  readonly caseId: string
  readonly faces: readonly string[]
  readonly programGates: readonly string[]
  readonly programScripts?: readonly string[]
  readonly e1Complete: boolean
  readonly note: string
}

interface Plan {
  readonly planId: string
  readonly entries: readonly Entry[]
  readonly positiveControlFaces: readonly string[]
  readonly faceApplicability?: Readonly<Record<string, { readonly applicable: boolean; readonly reason: string }>>
}

interface Suite {
  readonly cases: readonly { readonly id: string }[]
  readonly positiveControls: readonly { readonly id: string }[]
}

const checks: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail: string): void => {
  checks.push({ name, ok, detail })
}

const gateIds = new Set(ALL_GATES.map((g) => g.id))

function validatePlan(
  plan: unknown,
  suiteCaseIds: ReadonlySet<string>,
  pcIds: ReadonlySet<string>,
  scriptNames: ReadonlySet<string>
): string[] {
  const problems: string[] = []
  if (plan === null || typeof plan !== 'object') return ['计划不是对象']
  const p = plan as Partial<Plan>
  if (p.planId !== 's1-rejection-evidence-plan') problems.push(`planId 不符：${String(p.planId)}`)
  const entries = Array.isArray(p.entries) ? (p.entries as Entry[]) : []
  if (entries.length === 0) problems.push('entries 为空')

  const ids = entries.map((e) => e.caseId)
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (dupes.length > 0) problems.push(`重复条目：${[...new Set(dupes)].join(', ')}`)

  for (const e of entries) {
    if (!suiteCaseIds.has(e.caseId)) problems.push(`${e.caseId} 不在套件里（计划不能自造用例）`)
    if (!Array.isArray(e.faces) || e.faces.length === 0) problems.push(`${e.caseId} 没有任何证据面`)
    else {
      for (const f of e.faces) if (!FACES.includes(f as Face)) problems.push(`${e.caseId} 的证据面非法：${f}`)
      if (new Set(e.faces).size !== e.faces.length) problems.push(`${e.caseId} 的证据面有重复`)
    }
    const gates = Array.isArray(e.programGates) ? e.programGates : []
    if (e.faces.includes('E-1') && gates.length === 0 && (e.programScripts ?? []).length === 0) {
      problems.push(`${e.caseId} 声称有 E-1 却没指名任何门/脚本`)
    }
    for (const g of gates) {
      if (!gateIds.has(g)) problems.push(`${e.caseId} 指名的门不存在：${g}`)
    }
    for (const s of e.programScripts ?? []) {
      if (!scriptNames.has(s)) problems.push(`${e.caseId} 指名的脚本不在 package.json 里：${s}`)
    }
    if (e.e1Complete === true) {
      if (!e.faces.includes('E-1')) problems.push(`${e.caseId} 标了 e1Complete 却不含 E-1`)
      if (e.faces.length !== 1) problems.push(`${e.caseId} 标了 e1Complete 却还依赖别的面（${e.faces.join(',')}）`)
      if (gates.length === 0) problems.push(`${e.caseId} 标了 e1Complete 却没指名承担的门`)
    }
    if (typeof e.note !== 'string' || e.note.trim() === '') problems.push(`${e.caseId} 缺 note（要写清哪个面还没做）`)
  }

  const missing = [...suiteCaseIds].filter((id) => !ids.includes(id))
  if (missing.length > 0) problems.push(`套件里有但计划缺失：${missing.join(', ')}`)

  const pcFaces = Array.isArray(p.positiveControlFaces) ? p.positiveControlFaces : []
  if (pcFaces.length === 0) problems.push('positiveControlFaces 为空')
  for (const f of pcFaces) if (!FACES.includes(f as Face)) problems.push(`positiveControlFaces 非法：${f}`)
  if (pcIds.size === 0) problems.push('套件里没有正控')

  /*
   * 每个证据面必须**要么**被至少一个用例依赖、**要么**显式声明"今天不适用"并给出理由。
   * ⚠️ 沉默不算：禁止"没人提 E-4"就当作它不存在。
   */
  const applicability = p.faceApplicability ?? {}
  for (const face of FACES) {
    const used = entries.some((e) => (e.faces ?? []).includes(face)) || pcFaces.includes(face)
    if (used) continue
    const declared = applicability[face]
    if (declared === undefined) {
      problems.push(`证据面 ${face} 既没被任何用例/正控依赖，也没有 faceApplicability 声明`)
    } else if (declared.applicable !== false) {
      problems.push(`证据面 ${face} 没被依赖，却被声明为 applicable=true`)
    } else if (typeof declared.reason !== 'string' || declared.reason.trim() === '') {
      problems.push(`证据面 ${face} 声明不适用但没给理由`)
    }
  }

  return problems
}

const suite = JSON.parse(readFileSync(SUITE_PATH, 'utf8')) as Suite
const plan = JSON.parse(readFileSync(PLAN_PATH, 'utf8')) as Plan
const suiteCaseIds = new Set(suite.cases.map((c) => c.id))
const pcIds = new Set(suite.positiveControls.map((c) => c.id))
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
const scriptNames = new Set(Object.keys(pkg.scripts ?? {}))

// ---------------------------------------------------------------------------
// 正控
// ---------------------------------------------------------------------------
const realProblems = validatePlan(plan, suiteCaseIds, pcIds, scriptNames)
check(
  '正控 · 真计划通过校验',
  realProblems.length === 0,
  realProblems.length === 0 ? `${plan.entries.length} 条归属` : realProblems.slice(0, 3).join('；')
)
check('正控 · 与套件用例数一致', suiteCaseIds.size === plan.entries.length, `suite=${suiteCaseIds.size} · plan=${plan.entries.length}`)
check('正控 · 门表可读（指名门要能在 ALL_GATES 里找到）', gateIds.size > 100, `ALL_GATES=${gateIds.size}`)

const faceUse = Object.fromEntries(FACES.map((f) => [f, plan.entries.filter((e) => e.faces.includes(f)).length]))
const applicability = plan.faceApplicability ?? {}
check(
  '正控 · 每个证据面要么有用例依赖、要么显式声明"今天不适用"并给出理由',
  FACES.every((f) => {
    const used = (faceUse[f] ?? 0) > 0 || plan.positiveControlFaces.includes(f)
    if (used) return true
    const d = applicability[f]
    return d !== undefined && d.applicable === false && d.reason.trim() !== ''
  }),
  FACES.map((f) => `${f}=${faceUse[f]}${applicability[f]?.applicable === false ? '(不适用)' : ''}`).join(' · ')
)
check(
  '正控 · E-4 今天**不适用**且写清了理由（群/多用户入口未接线）',
  applicability['E-4']?.applicable === false && (faceUse['E-4'] ?? 0) === 0,
  applicability['E-4']?.reason.slice(0, 40) ?? '（缺声明）'
)
const e1Complete = plan.entries.filter((e) => e.e1Complete)
check(
  '正控 · e1Complete 的用例**只有** T-RJ1-04（离线可独立判定的仅此一条）',
  e1Complete.length === 1 && e1Complete[0]!.caseId === 'T-RJ1-04',
  e1Complete.map((e) => e.caseId).join(',')
)
const namedGates = [...new Set(plan.entries.flatMap((e) => e.programGates))]
check(
  '正控 · 被指名的门都是已登记真实门',
  namedGates.every((g) => gateIds.has(g)),
  namedGates.join(' · ')
)

// ---------------------------------------------------------------------------
// 负控：坏掉的计划逐条必须判红
// ---------------------------------------------------------------------------
const clone = (): Plan => JSON.parse(JSON.stringify(plan)) as Plan

function expectRejected(name: string, mutate: (p: Plan) => void, needle: string): void {
  const broken = clone()
  mutate(broken)
  const problems = validatePlan(broken, suiteCaseIds, pcIds, scriptNames)
  const hit = problems.some((x) => x.includes(needle))
  check(`负控 · ${name}`, hit, hit ? `捕获（${problems.length} 条）` : `**没捕获**（期望含「${needle}」）`)
}

expectRejected('删掉一个用例的归属（漏覆盖）', (p) => {
  ;(p as unknown as { entries: Entry[] }).entries = p.entries.slice(1)
}, '缺失')

expectRejected('多出一个套件里没有的用例', (p) => {
  const list = JSON.parse(JSON.stringify(p.entries)) as Entry[]
  list.push({ ...list[0]!, caseId: 'T-RJ9-99' })
  ;(p as unknown as { entries: Entry[] }).entries = list
}, 'T-RJ9-99')

expectRejected('把一个用例的证据面清空', (p) => {
  const list = JSON.parse(JSON.stringify(p.entries)) as Entry[]
  ;(list[0] as unknown as { faces: string[] }).faces = []
  ;(p as unknown as { entries: Entry[] }).entries = list
}, '没有任何证据面')

expectRejected('声称 E-1 却不指名门', (p) => {
  const list = JSON.parse(JSON.stringify(p.entries)) as Entry[]
  ;(list[0] as unknown as { programGates: string[] }).programGates = []
  ;(p as unknown as { entries: Entry[] }).entries = list
}, '没指名任何门')

expectRejected('指一个不存在的门', (p) => {
  const list = JSON.parse(JSON.stringify(p.entries)) as Entry[]
  ;(list[0] as unknown as { programGates: string[] }).programGates = ['u1:does:not:exist']
  ;(p as unknown as { entries: Entry[] }).entries = list
}, '门不存在')

expectRejected('谎报 e1Complete（其实还依赖 E-3）', (p) => {
  const list = JSON.parse(JSON.stringify(p.entries)) as Entry[]
  ;(list[0] as unknown as { e1Complete: boolean }).e1Complete = true
  ;(p as unknown as { entries: Entry[] }).entries = list
}, '还依赖别的面')

expectRejected('重复条目', (p) => {
  const list = JSON.parse(JSON.stringify(p.entries)) as Entry[]
  list.push(list[0]!)
  ;(p as unknown as { entries: Entry[] }).entries = list
}, '重复条目')

expectRejected('证据面写错（E-9）', (p) => {
  const list = JSON.parse(JSON.stringify(p.entries)) as Entry[]
  ;(list[0] as unknown as { faces: string[] }).faces = ['E-9']
  ;(p as unknown as { entries: Entry[] }).entries = list
}, '非法')

expectRejected('指一个 package.json 里不存在的脚本', (p) => {
  const list = JSON.parse(JSON.stringify(p.entries)) as Entry[]
  ;(list.find((e) => (e.programScripts ?? []).length > 0) as unknown as { programScripts: string[] }).programScripts = [
    'no:such:script',
  ]
  ;(p as unknown as { entries: Entry[] }).entries = list
}, '不在 package.json')

expectRejected('一个证据面既没人依赖、也没声明不适用（沉默不算）', (p) => {
  const list = JSON.parse(JSON.stringify(p.entries)) as Entry[]
  for (const e of list) (e as unknown as { faces: string[] }).faces = ['E-1']
  ;(p as unknown as { entries: Entry[] }).entries = list
  ;(p as unknown as { faceApplicability: Record<string, unknown> }).faceApplicability = {}
}, '既没被任何用例')

// ---------------------------------------------------------------------------
// 恢复
// ---------------------------------------------------------------------------
check('恢复 · 真计划重新通过校验', validatePlan(plan, suiteCaseIds, pcIds, scriptNames).length === 0, '干净')

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok)
for (const c of checks) console.log(`${c.ok ? '  ok  ' : ' FAIL '} ${c.name} —— ${c.detail}`)
console.log('')
console.log(`measured_count=${checks.length} · passed=${checks.length - failed.length} · failed=${failed.length}`)
console.log(
  `plan=${plan.planId} · entries=${plan.entries.length} · ` +
    FACES.map((f) => `${f}=${faceUse[f]}`).join(' ') +
    ` · e1Complete=${e1Complete.length}`
)
if (failed.length > 0) {
  console.log('失败项：')
  for (const c of failed) console.log(`  - ${c.name}：${c.detail}`)
}
process.exitCode = failed.length === 0 ? 0 : 1
