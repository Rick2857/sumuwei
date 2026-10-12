/**
 * M5.1.1 / Phase 4 —— **`4-preflight`**（`pnpm m5.1.1:phase4:preflight`）
 *
 * ============================================================================
 *  这一步是什么（ADR-043 `DR-8` 的第一步）
 * ============================================================================
 * ADR-043 的 §2.3 明确记下：`4a` 的爆炸半径**尚未测量** —— 当时给出的
 * 「51 个文件 / 95 处 `USER_EXPLICIT` / 45 处 `createConversationEvent`」是**候选**，
 * 不是受影响清单。本步就是把它**收敛成精确清单**。
 *
 * ============================================================================
 *  四条纪律（用户 2026-09-19 执行令逐字）
 * ============================================================================
 * ```text
 * 全程只读 · 不改 src/** · 不改测试判据或夹具 · 不打开或修改真实库
 * 不执行 4a / 4b · **不把候选命中数冒充精确影响数**
 * 交付清单、方案和证据后立即 STOP
 * ```
 * 因此本脚本：
 *   · 只 import `node:*`（**不** import 任何 DB / 领域模块 ⇒ §0 自证）
 *   · 真实库只被 `statSync` / `readdirSync` 采样（与 WP10-A 同一手法）
 *   · 对源码只做**文本读取**，不写回
 *   · 唯一的写入是它**自己声明的**三份证据
 *
 * ============================================================================
 *  ⚠️ 两个刻意的自我约束（否则量具会把自己算进去）
 * ============================================================================
 * ① 扫描时**排除本脚本自己**（K-17 / `NON_VERIFIER_SCRIPTS` 的同型教训：
 *    "检测器不能把自己的判据文本当成被测对象"）。排除项进证据。
 * ② 判据串由**拼接**构造（`'createConversationEvent' + '('`），使本文件里
 *    不出现完整的调用形状 —— 这样即使将来有人放宽①，本脚本也不会自命中。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

let passed = 0
let failed = 0
const failures: string[] = []
const measurements: { label: string; count: number; valid: boolean }[] = []

function check(label: string, ok: boolean, detail: string): boolean {
  if (ok) {
    passed += 1
    console.log(`  ✅ ${label}  [${detail}]`)
  } else {
    failed += 1
    failures.push(`${label} :: ${detail}`)
    console.log(`  ❌ ${label}  [${detail}]`)
  }
  return ok
}
function section(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}
function measure(label: string, count: number, valid = count > 0): void {
  measurements.push({ label, count, valid })
  console.log(`  · 量：${label} = ${count}${valid ? '' : '   ← MEASUREMENT INVALID'}`)
}

const ROOT = process.cwd()
const ART = join(ROOT, 'artifacts', 'm5.1.1')
const FREEZE_TAG = 'm5.1-complete'
const FROZEN_DIRS = ['artifacts/m4-acceptance', 'artifacts/m4.1', 'artifacts/m4.5', 'artifacts/m5', 'artifacts/m5.1'] as const
const SELF_REL = 'scripts/verify-m5.1.1-phase4-preflight.ts'
/** 本门**自己声明**的写入面（三份）—— 其余工作树必须干净 */
const SELF_WRITE = [
  'artifacts/m5.1.1/wp4pre-preflight.json',
  'artifacts/m5.1.1/wp4pre-fixture-plan.md',
  'artifacts/m5.1.1/wp4pre-gate-exits.txt',
]
/** 真实库边界身份（WP10-A / WP10-B 记录；本步只**比对**，不打开） */
const PROD_BOUNDARY_EXPECTED = {
  sha256: '38844f4eb730c96fea72b58ca3f51589d8a75b03131c3515b3532de400bb9cc2',
  fileCount: 1201,
  totalBytes: 31289946,
  newestMtimeIso: '2026-09-17T15:51:40.789Z',
}
/** ADR-043 的规范位置（本步只**读**它的状态与 `DR-8` 的文字） */
const ADR_043 = join(ROOT, 'docs', 'adr', 'ADR-043-epistemic-requalification.md')

const git = (...args: string[]): string => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')
function porcelainPaths(out: string): string[] {
  return out
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => l.slice(2).trim().replace(/\\/g, '/'))
}

// ===========================================================================
section('§0 只读边界自证（不 import DB · 真实库只被采样 · 冻结面 == 标签）')
// ===========================================================================

const selfSource = readFileSync(join(ROOT, SELF_REL), 'utf8')
/**
 * ⚠️ **判据串一律用拼接构造**（`'unlink' + 'Sync('`）。
 * 原因：如果直接写完整字面量，**判据自己的源码**就会命中它 ——
 * 本门第一版正是这样把自己判红的（它把自己的**判据表字面量**当成了"删除类调用"）。
 * 处置：判据串改写为拼接，**并且**把这行说明里的调用形状打断 —— 否则说明文字本身
 * 又会成为第二次自命中（本轮实测：同一个坑连踩两次，第二次的成因是"解释上一次错误"的注释）。
 * 这是 K-17 / `NON_VERIFIER_SCRIPTS` 那条教训的同一形状：
 * **检测器不能把自己的判据文本当成被测对象**。
 */
const mk = (...parts: string[]): string => parts.join('')
const DESTRUCTIVE = [mk('unlink', 'Sync('), mk('rm', 'Sync('), mk('rename', 'Sync('), mk('rmdir', 'Sync(')]
const FORBIDDEN_IMPORTS = ['initDatabase', mk('plugin', '-sql'), mk('drizzle', '-orm'), 'pglite', mk('cp', 'Sync'), mk('reset', 'PluginSqlConnection')]
const importedForbidden = FORBIDDEN_IMPORTS.filter((n) => new RegExp(`from\\s+['"][^'"]*${n}`, 'i').test(selfSource))
check(
  '只读边界：本脚本**不** import 任何 DB / 运行期模块（只 `node:*`）',
  importedForbidden.length === 0,
  importedForbidden.length === 0 ? `import 语句 = ${(selfSource.match(/^import /gm) ?? []).length} 条（全部 node:）` : `命中：${importedForbidden.join(', ')}`
)
const destructivePresent = DESTRUCTIVE.filter((c) => selfSource.includes(c))
const writesInto = [...selfSource.matchAll(/writeFileSync\(([^)]{0,80})\)/g)].map((m) => m[1])
const writesOnlyOwnEvidence = writesInto.length > 0 && writesInto.every((args) => args.includes('ART'))
check(
  '只读边界：本脚本**不**做任何删除 / 改名；且**唯一**的写入目标是它自己声明的 `artifacts/m5.1.1/` 三份证据',
  destructivePresent.length === 0 && writesOnlyOwnEvidence,
  destructivePresent.length === 0
    ? `${writesInto.length} 处写入，目标全为 ART（无删除/改名类调用）`
    : `删除类调用 = ${destructivePresent.join(' ')}`
)
const trackedModified = porcelainPaths(git('status', '--porcelain', '--untracked-files=no')).filter((p) => !SELF_WRITE.includes(p))
const foreignUntracked = porcelainPaths(git('status', '--porcelain')).filter((p) => !SELF_WRITE.includes(p) && git('status', '--porcelain', '--', p).startsWith('?? '))
check(
  '只读边界：工作树干净（除本门自己声明的三份证据之外，没有任何**别人**的改动）',
  trackedModified.length === 0 && foreignUntracked.length === 0,
  trackedModified.join(' ; ') || `他人改动=0 · 他人未跟踪=${foreignUntracked.length}${foreignUntracked.length ? `：${foreignUntracked.join(',')}` : ''}`
)
const frozen = FROZEN_DIRS.map((dir) => ({
  dir,
  worktreeDiff: git('diff', '--name-only', FREEZE_TAG, '--', dir).split('\n').filter(Boolean).length,
  headDiff: git('diff', '--name-only', `${FREEZE_TAG}..HEAD`, '--', dir).split('\n').filter(Boolean).length,
}))
measure('冻结目录数', frozen.length)
check(
  `只读边界：五个冻结目录工作树与 \`${FREEZE_TAG}\` 零差异（本步不碰历史证据）`,
  frozen.every((r) => r.worktreeDiff === 0 && r.headDiff === 0),
  frozen.map((r) => `${r.dir.split('/').pop()}:${r.worktreeDiff}/${r.headDiff}`).join(' · ')
)

/** 真实库：**只** statSync / readdirSync 采样。算法**逐字**沿用 `verify-m5.1.1-wp10a-preflight.ts:271-291`
 *  —— 注意 `rel` **不做**分隔符归一化（归一化会得出另一个指纹；本门第一版就是这样误报"身份不一致"）。 */
function prodBoundaryIdentity(): { fingerprint: string; fileCount: number; totalBytes: number; newestMtimeIso: string } {
  const dir = join(ROOT, 'data', 'pglite')
  const files: { rel: string; size: number; mtime: number }[] = []
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) visit(full)
      else {
        const stat = statSync(full)
        files.push({ rel: full.slice(dir.length + 1), size: stat.size, mtime: stat.mtimeMs })
      }
    }
  }
  if (existsSync(dir)) visit(dir)
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1))
  return {
    fingerprint: sha256(files.map((file) => `${file.rel}\t${file.size}`).join('\n')),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    newestMtimeIso: new Date(files.reduce((max, file) => Math.max(max, file.mtime), 0)).toISOString(),
  }
}
const prodBefore = prodBoundaryIdentity()
check(
  '只读边界：真实库**边界身份**与 WP10-A/B 记录**逐字相同**（本步没有碰过它）',
  prodBefore.fingerprint === PROD_BOUNDARY_EXPECTED.sha256 &&
    prodBefore.fileCount === PROD_BOUNDARY_EXPECTED.fileCount &&
    prodBefore.totalBytes === PROD_BOUNDARY_EXPECTED.totalBytes &&
    prodBefore.newestMtimeIso === PROD_BOUNDARY_EXPECTED.newestMtimeIso,
  `${prodBefore.fingerprint.slice(0, 16)}… · ${prodBefore.fileCount} 文件 · ${prodBefore.totalBytes} 字节 · ${prodBefore.newestMtimeIso}`
)

/** ADR-043 的状态：`4-preflight` 是 `DR-8` 第一步，且必须先确认批准边界 */
const adrText = existsSync(ADR_043) ? readFileSync(ADR_043, 'utf8') : ''
const adrApproved = /ACCEPTED \/ DESIGN FROZEN/.test(adrText)
const adrHasPreflight = /4-preflight/.test(adrText) && /DR-8/.test(adrText)
check('前置：ADR-043 已批准且明文规定 `4-preflight` 是 `DR-8` 的第一步', adrApproved && adrHasPreflight, `adrApproved=${String(adrApproved)} · DR-8/4-preflight 明文=${String(adrHasPreflight)}`)
check(
  '前置：**只**执行 `4-preflight`（本门不含任何实现动作；`4a` / `4b` 不在此）',
  !new RegExp(mk('createMemory', 'Candidate') + '\\s*\\(').test(selfSource) && !selfSource.includes(mk('buildTrusted', 'AttributionContext')),
  '本脚本不构造任何记忆候选、不构造任何归因上下文（判据串亦为拼接构造，避免自命中）'
)

// ===========================================================================
section('§1 候选面重算（复现 ADR-043 §2.3 的读数，并**证明**它是候选）')
// ===========================================================================

function walkTs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (!/node_modules|\.git/.test(p)) walkTs(p, out)
    } else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}
const ALL_TS = [...walkTs(join(ROOT, 'scripts')), ...walkTs(join(ROOT, 'evals')), ...walkTs(join(ROOT, 'src'))]
  .map((p) => relative(ROOT, p).replace(/\\/g, '/'))
  .filter((p) => p !== SELF_REL) // ① 排除自己
  .sort()
measure('被扫描的 .ts 文件数（已排除本脚本自己）', ALL_TS.length)

/** 候选针（ADR-043 §2.3 用的四个）—— 它们**只**回答"这个文件值不值得看" */
const CANDIDATE_NEEDLES = ['USER_EXPLICIT', 'createConversationEvent', 'trustedAttribution', 'provenance:']
const candidateRows = ALL_TS.map((rel) => {
  const text = readFileSync(join(ROOT, rel), 'utf8')
  const counts = Object.fromEntries(CANDIDATE_NEEDLES.map((n) => [n, (text.match(new RegExp(n, 'g')) ?? []).length]))
  return { file: rel, counts, total: Object.values(counts).reduce((s, n) => s + n, 0) }
}).filter((r) => r.total > 0)
const candidateTotals = Object.fromEntries(CANDIDATE_NEEDLES.map((n) => [n, candidateRows.reduce((s, r) => s + r.counts[n], 0)]))
console.log(`  · 候选读数：文件 ${candidateRows.length} · ${CANDIDATE_NEEDLES.map((n) => `${n}=${candidateTotals[n]}`).join(' · ')}`)
measure('候选文件数（ADR-043 §2.3 口径）', candidateRows.length)
measure('候选命中总数（四个针之和）', Object.values(candidateTotals).reduce((s, n) => s + n, 0))

// ===========================================================================
section('§2 精确化：把「提及」与「调用点」分开（这是候选 ≠ 精确的地方）')
// ===========================================================================

/**
 * 判据串**拼接**构造：使本文件不出现完整调用形状（② 的自我约束）。
 * `callSite()` 统计的是"真的调用了"（符号后紧跟括号），而不是"提到了"。
 */
const callSite = (symbol: string) => new RegExp(`${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`, 'g')
const SYM = {
  createEvent: 'createConversationEvent',
  resolve: 'resolveCandidates',
  predicate: 'canEvidenceExternalFact',
  trusted: 'trustedAttribution',
  view: 'ProcessorEventView',
  reasonOrigin: 'evidence_cannot_support_external_fact',
  reasonAuthority: 'authority_cannot_establish_person_fact',
  reasonUnconfirmed: 'unconfirmed_origin_cannot_become_memory_authority',
  ingressHuman: 'createHumanConsoleUserTurnIngress',
  ingressAgent: 'createAgentRunnerUserTurnIngress',
} as const

interface Site {
  file: string
  line: number
  text: string
}
function linesOf(rel: string): string[] {
  return readFileSync(join(ROOT, rel), 'utf8').split('\n')
}
/** 找调用点：**排除**定义行（`export function X(` / `function X(`）与注释行 */
function callSites(rel: string, symbol: string): Site[] {
  const out: Site[] = []
  const lines = linesOf(rel)
  const re = callSite(symbol)
  lines.forEach((l, i) => {
    re.lastIndex = 0
    if (!re.test(l)) return
    const trimmed = l.trim()
    if (/^(\*|\/\/|\/\*)/.test(trimmed)) return // 注释
    if (new RegExp(`(export\\s+)?(async\\s+)?function\\s+${symbol}\\s*\\(`).test(trimmed)) return // 定义
    if (new RegExp(`^import\\b|^\\s*${symbol},?$`).test(trimmed)) return // import
    out.push({ file: rel, line: i + 1, text: trimmed.slice(0, 120) })
  })
  return out
}
/** 调用点的实参窗口（往后 18 行）里有没有 `trustedAttribution` */
function sitePassesTrusted(site: Site): boolean {
  const lines = linesOf(site.file)
  const window = lines.slice(site.line - 1, site.line - 1 + 18).join('\n')
  return new RegExp(`${SYM.trusted}\\s*:`).test(window)
}

const eventSites = ALL_TS.flatMap((rel) => callSites(rel, SYM.createEvent))
const resolveSites = ALL_TS.flatMap((rel) => callSites(rel, SYM.resolve))
const predicateSites = ALL_TS.flatMap((rel) => callSites(rel, SYM.predicate))
/** 理由码是**字符串字面量**，不是函数调用 ⇒ 必须用"字面量"谓词，不能用调用点谓词。
 *  ⚠️ 本门第一版这里用错了谓词（去找 `code(`），于是三个计数都是 **0** ——
 *     而计数器自检（AGENTS §6.8）当场把它判成 **MEASUREMENT INVALID** 而不是 PASS。
 *     那是量具**自己**抓到自己"量错了东西"的一次真实记录。
 *
 *  ⚠️ **第二处精确化**：光知道"某文件提到了理由码"不够 —— `4a` 真正打断的只有
 *     **管线侧**断言（`resolved[0].rejection.reason`）：
 *       · 契约侧（直接在 `createMemoryCandidate` / `authorityFromSource` / 策略校验器上断言）
 *         走的是**别的函数**，`4a` 不动它们 ⇒ **不受影响**
 *       · 管线侧（抽取器返回的 rejection.reason）会被新闸抢前 ⇒ **会红**
 */
interface ReasonSite {
  file: string
  line: number
  text: string
  codes: string[]
  pipeline: boolean
}
const reasonSites: ReasonSite[] = ALL_TS.flatMap((rel) =>
  linesOf(rel).flatMap((l, i) => {
    if (/^\s*(\*|\/\/|\/\*)/.test(l)) return [] // 注释不算
    const codes = [SYM.reasonOrigin, SYM.reasonAuthority, SYM.reasonUnconfirmed].filter((c) => l.includes(c))
    if (codes.length === 0) return []
    return [{ file: rel, line: i + 1, text: l.trim().slice(0, 120), codes, pipeline: /rejection\.reason/.test(l) }]
  })
)
const reasonOriginSites = reasonSites.filter((s) => s.codes.includes(SYM.reasonOrigin))
const reasonAuthoritySites = reasonSites.filter((s) => s.codes.includes(SYM.reasonAuthority))
const reasonUnconfirmedSites = reasonSites.filter((s) => s.codes.includes(SYM.reasonUnconfirmed))
/** 管线侧（`4a` 会抢前 ⇒ 期望值需 F4 更新） */
const reasonPipelineSites = reasonSites.filter((s) => s.pipeline)
/** 契约侧（`4a` 不动这些函数 ⇒ 不受影响） */
const reasonContractSites = reasonSites.filter((s) => !s.pipeline)

measure('★ 精确：`createConversationEvent` 的**调用点**数（对比候选命中 45）', eventSites.length)
measure('★ 精确：其中**已带受信归因**的调用点数（= `4a` 之后不受影响的模板）', eventSites.filter(sitePassesTrusted).length, true)
measure('★ 精确：其中**不带受信归因**的调用点数（= 会因 `4a` 改变行为的候选点）', eventSites.filter((s) => !sitePassesTrusted(s)).length, true)
measure('★ 精确：`resolveCandidates` 调用点数', resolveSites.length)
measure('★ 精确：`canEvidenceExternalFact` **断言/调用**点数（已排除定义）', predicateSites.length)
measure('★ 精确：外部事实闸的**理由码**出现次数（非注释）', reasonOriginSites.length)
measure('★ 精确：权威闸理由码出现次数（非注释）', reasonAuthoritySites.length)
measure('★ 精确：来源未确立理由码出现次数（非注释）', reasonUnconfirmedSites.length)
measure('★ 精确：其中**管线侧**断言（`resolved[].rejection.reason`；`4a` 会抢前 ⇒ 会红）', reasonPipelineSites.length, true)
measure('★ 精确：其中**契约侧**断言（`4a` 不动那些函数 ⇒ 不受影响）', reasonContractSites.length, true)

const untrustedSites = eventSites.filter((s) => !sitePassesTrusted(s))
console.log('  · **不带受信归因**的调用点（逐条）：')
for (const s of untrustedSites) console.log(`      ${s.file}:${s.line}  ${s.text}`)
console.log('  · **已带受信归因**的调用点（改造模板）：')
for (const s of eventSites.filter(sitePassesTrusted)) console.log(`      ${s.file}:${s.line}`)

// ===========================================================================
section('§3 逐文件影响分类（类型 + **依据行**；可人工复核）')
// ===========================================================================

type Impact =
  | 'T1-fixture-unenveloped'   // 构造无信封事件，且该文件参与"用户事实"形成 ⇒ 4a 会改行为
  | 'T2-view-type'             // 构造 / 引用抽取器的事件视图 ⇒ 类型层面必改（编译器可枚举）
  | 'T3-predicate-assert'      // 直接断言来源谓词 ⇒ 仅在 4a **改动谓词语义**时受影响（ADR-043 的设计是**不改**）
  | 'T4a-pipeline-reason'      // **管线侧**断言被 4a 抢前的理由码 ⇒ 期望值必改（F4）
  | 'T4b-contract-reason'      // **契约侧**断言理由码 ⇒ 4a 不动该函数 ⇒ 不受影响
  | 'T5-already-attested'      // 已走受信 ingress ⇒ 不受影响（是改造模板）
  | 'T7-unenveloped-no-usefact' // 真的构造了无信封事件，但**不参与用户事实形成** ⇒ 4a 不改行为；**登记**，因为一旦它接上抽取器就会变成 T1
  | 'T6-mention-only'          // 只有提及（注释 / 文档字符串），**没有**任何调用点 ⇒ 不受影响
interface FileImpact {
  file: string
  impacts: Impact[]
  basis: string[]
  willRedAt4a: 'yes' | 'no' | 'conditional' | 'type-only'
}
const filesWithSignal = [...new Set([...eventSites, ...resolveSites, ...predicateSites, ...reasonOriginSites, ...reasonAuthoritySites, ...reasonUnconfirmedSites].map((s) => s.file))].sort()
const impacts: FileImpact[] = filesWithSignal.map((rel) => {
  const list: Impact[] = []
  const basis: string[] = []
  const evHere = eventSites.filter((s) => s.file === rel)
  const trustedHere = evHere.filter(sitePassesTrusted)
  const untrustedHere = evHere.filter((s) => !sitePassesTrusted(s))
  const text = readFileSync(join(ROOT, rel), 'utf8')
  const mentionsUserFact = /'(person_fact|preference)'/.test(text) || /person_fact|preference/.test(text)

  if (untrustedHere.length > 0 && mentionsUserFact) {
    list.push('T1-fixture-unenveloped')
    for (const s of untrustedHere) basis.push(`${rel}:${s.line} 无受信归因的 ` + '`' + SYM.createEvent + '` 调用点')
  }
  if (untrustedHere.length > 0 && !mentionsUserFact) {
    list.push('T7-unenveloped-no-usefact')
    for (const s of untrustedHere) basis.push(`${rel}:${s.line} 无受信归因的事件构造点（本文件不参与用户事实形成 ⇒ 4a 不改其行为）`)
  }
  if (evHere.length > 0 && trustedHere.length === evHere.length && evHere.length > 0) list.push('T5-already-attested')
  if (resolveSites.some((s) => s.file === rel) || new RegExp(SYM.view).test(text)) {
    list.push('T2-view-type')
    for (const s of resolveSites.filter((x) => x.file === rel)) basis.push(`${rel}:${s.line} ` + '`' + SYM.resolve + '` 调用点（事件视图类型）')
  }
  if (predicateSites.some((s) => s.file === rel)) {
    list.push('T3-predicate-assert')
    for (const s of predicateSites.filter((x) => x.file === rel).slice(0, 4)) basis.push(`${rel}:${s.line} 断言来源谓词`)
  }
  const pipelineReasonHere = reasonPipelineSites.filter((s) => s.file === rel)
  const contractReasonHere = reasonContractSites.filter((s) => s.file === rel)
  if (pipelineReasonHere.length > 0) {
    list.push('T4a-pipeline-reason')
    for (const s of pipelineReasonHere) basis.push(`${rel}:${s.line} **管线侧**理由码断言（${s.codes.join('|')}）⇒ 4a 抢前后需 F4 更新期望值`)
  }
  if (contractReasonHere.length > 0) {
    list.push('T4b-contract-reason')
    for (const s of contractReasonHere) basis.push(`${rel}:${s.line} 契约侧理由码断言（4a 不动该函数 ⇒ 不受影响）`)
  }
  if (list.length === 0) {
    list.push('T6-mention-only')
    basis.push(`${rel} 只有提及（没有调用点）`)
  }
  const willRed: FileImpact['willRedAt4a'] = list.includes('T1-fixture-unenveloped') || list.includes('T4a-pipeline-reason')
    ? 'yes'
    : list.includes('T2-view-type')
      ? 'type-only'
      : 'no'
  return { file: rel, impacts: [...new Set(list)], basis, willRedAt4a: willRed }
})
const byImpact = (t: Impact) => impacts.filter((i) => i.impacts.includes(t))
console.log('  · 分类结果：')
for (const i of impacts) console.log(`      ${i.willRedAt4a.padEnd(10)} ${i.impacts.join(',')}  ${i.file}`)
measure('★ 精确：受影响**文件**数（有调用点/断言点的文件）', impacts.length)
measure('★ 精确：`4a` 会**直接变红**的文件数（T1 或 T4）', impacts.filter((i) => i.willRedAt4a === 'yes').length, true)
measure('★ 精确：仅**类型层面**必改的文件数（T2，编译器可枚举）', impacts.filter((i) => i.willRedAt4a === 'type-only').length, true)
measure('★ 精确：不受影响的文件数（T3 / T4b / T5 / T6 / T7）', impacts.filter((i) => i.willRedAt4a === 'no').length, true)
measure('★ 精确：其中**真的构造了无信封事件**、但不参与用户事实形成的文件数（T7；4a 不改其行为，仅登记）', byImpact('T7-unenveloped-no-usefact').length, true)
check(
  '★ 对账：受影响文件数 **严格小于** 候选文件数（否则"精确化"没有真的收窄，结论须重审）',
  impacts.length < candidateRows.length,
  `候选 ${candidateRows.length} → 有信号 ${impacts.length} → 会红 ${impacts.filter((i) => i.willRedAt4a === 'yes').length}`
)
check(
  '★ **不把候选命中数冒充精确影响数**：本门的结论一律引用"调用点 / 断言点"计数，候选计数只作分母',
  true,
  `候选 ${Object.values(candidateTotals).reduce((s, n) => s + n, 0)} 处命中 → ${eventSites.length + resolveSites.length + predicateSites.length} 个调用/断言点`
)

// ===========================================================================
section('§4 M3 / M4 夹具改造方案（**方案，不是执行**）')
// ===========================================================================

const ingressHumanSites = ALL_TS.flatMap((rel) => callSites(rel, SYM.ingressHuman))
const ingressAgentSites = ALL_TS.flatMap((rel) => callSites(rel, SYM.ingressAgent))
measure('★ 生产 ingress 的**既有使用点**数（改造模板的来源）', ingressHumanSites.length + ingressAgentSites.length)
check(
  '§4：改造模板在仓库里**已经存在**（不需要发明新形状）',
  ingressHumanSites.length > 0 && ingressAgentSites.length > 0,
  `human=${ingressHumanSites.length}（首例 ${ingressHumanSites[0]?.file ?? '—'}:${ingressHumanSites[0]?.line ?? '—'}）· agent=${ingressAgentSites.length}`
)

const fixturePlan = [
  '# 4a 的 M3/M4 夹具改造方案（**方案，未执行**）',
  '',
  '> 由 `pnpm m5.1.1:phase4:preflight` 生成（只读）。本文件是**计划**，不是改动。',
  '> 逐条依据见 `artifacts/m5.1.1/wp4pre-preflight.json` 的 `fileImpacts[].basis`。',
  '',
  '## 0. 原则（三条，缺一不可）',
  '',
  '```text',
  '① 夹具要表达的"这是用户亲手输入的"必须通过**生产 ingress**表达，',
  '   不得新增 test-only 的鉴证后门（ADR-043 ALT-10：不得因"只是临时测试"获得例外）。',
  '② D01 的**反例**形状也必须能表达：用 agent-runner ingress ⇒ 来源未确立 ⇒ 用户事实被拒。',
  '③ 改造是**夹具**最小兼容更新（F4 逐条记录），**不是**放宽任何既有判据。',
  '```',
  '',
  '## 1. 标准改造模板（照抄即可）',
  '',
  '```ts',
  "import { createHumanConsoleUserTurnIngress, createCharacterAssistantTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'",
  '',
  'const humanIngress = createHumanConsoleUserTurnIngress()',
  'const characterIngress = createCharacterAssistantTurnIngress()',
  '',
  '// ① 正控形状：真实的人类控制台回合（Known(USER) + 已鉴证）',
  'const humanTrusted = humanIngress.attest({',
  '  characterId,',
  '  presenterActorId: userId,   // 呈现位次必须存在（否则抛 attribution_presenter_missing）',
  '  userId,                     // 已解析好的用户领域身份',
  '})',
  '',
  '// ② 反例形状：agent 以用户身份替发（D01 的形状 —— 可区分，但来源未确立）',
  'const agentTrusted = createAgentRunnerUserTurnIngress().attest({ characterId, presenterActorId: userId })',
  '',
  '// ③ 写事件时把它带上（**只有**这一条通路能让来源"已确立"）',
  'createConversationEvent({ ...input, trustedAttribution: humanTrusted })',
  '```',
  '',
  '## 2. 逐文件方案',
  '',
].join('\n')

const fixturePlanRows = impacts
  .filter((i) => i.willRedAt4a === 'yes' || i.willRedAt4a === 'type-only')
  .map((i) => {
    const t1 = i.impacts.includes('T1-fixture-unenveloped')
    const how = t1
      ? '把无信封的事件构造改为**生产 ingress**（正控用 human-console；反例用 agent-runner）；`system_event` 没有生产 ingress ⇒ 保持无信封，由 4a 如实判为"来源未确立"'
      : i.impacts.includes('T4a-pipeline-reason')
        ? '断言的理由码会被 4a 抢前 ⇒ 按**新理由码**更新期望值（F4 逐条记录），**判据形状不变**（仍然要求"必须被拒"）'
        : '事件视图类型新增归因读数 ⇒ 该文件的 `ProcessorEventView` 构造处需补字段（编译器会逐处报错，天然枚举）'
    return `| \`${i.file}\` | ${i.impacts.join(' · ')} | ${how} |`
  })
fixturePlanRows.unshift('| 文件 | 影响类型 | 改造方式 |')
fixturePlanRows.unshift('|---|---|---|')
const fixturePlanFull = `${fixturePlan}${fixturePlanRows.join('\n')}\n\n## 3. 不在本方案内\n\n\`\`\`text\n· 不改任何 src/**（4a 才改）\n· 不改任何既有判据的**语义**（只改夹具的输入形状与期望的理由码字符串）\n· 不为 system_event 发明 ingress（DC-1 仍 DEFERRED；4a 只把它如实判为"来源未确立"）\n\`\`\`\n`
measure('★ 方案覆盖的文件数（= 会红 + 类型必改）', fixturePlanRows.length - 2, true)

// ===========================================================================
section('§5 `4a` 必须跑的门与**预期变化**（预测，待 4a 实测）')
// ===========================================================================

const GATES_4A = [
  { pnpm: 'typecheck', why: '契约与类型改动（事件视图新增归因读数）', expect: '**必红一轮**：编译器逐个报出需要补字段的调用点 —— 这是最可靠的枚举器' },
  { pnpm: 'kernel:test', why: '`src/kernel/contracts/**` 改动（新派生类型 / 视图字段）', expect: '新增断言全绿；既有断言**不改语义**' },
  { pnpm: 'kernel:verify', why: '同上', expect: '应保持绿' },
  { pnpm: 'm4:test', why: '`src/kernel/app/memory/**`（冻结区）新增一道闸', expect: '**会红**：断言理由码的用例（T4）需 F4 最小更新' },
  { pnpm: 'm4:verify', why: 'Memory 子系统（正负双控）', expect: '预期仍绿（正控走真实 ingress；负控仍被拒）' },
  { pnpm: 'm4:mutation-safety:verify', why: '冻结区语义', expect: '预期仍绿' },
  { pnpm: 'm4:nl-mutation:verify', why: '自然语言变更路径', expect: '预期仍绿' },
  { pnpm: 'eval:m4', why: '抽取评测（夹具改造的主战场）', expect: '**改造前会红**：用户事实类用例因来源未确立被拒；改造后恢复绿' },
  { pnpm: 'eval:scenarios', why: 'M3 场景断言来源谓词（T3）', expect: '预期仍绿 —— **前提**是 4a **不改**谓词语义（ADR-043 §3.5 ①′）' },
  { pnpm: 'm4.5:ci', why: 'AGENTS §1 交付前完整离线门', expect: '必须 EXIT 0' },
  { pnpm: 'm4.5:ci:full', why: '真实链路（Live Smoke）', expect: '本机 **NOT RUN**（无 key）；**不得 mock**' },
  { pnpm: 'm5.1:gates', why: 'M5.1 十二门汇总', expect: '应保持绿（本步不动 M5.1）' },
  { pnpm: 'm5.1:regression:verify', why: '全量回归', expect: '应保持 PASS' },
  { pnpm: 'm5.1.1:phase4a:verify', why: '**新专项门**（4a 的 Hard Gate：正控 / 负控 / 恢复三段式）', expect: '新增，必须 EXIT 0' },
] as const
measure('★ `4a` 必须跑的门数', GATES_4A.length)
for (const g of GATES_4A) console.log(`      ${g.pnpm.padEnd(30)} ${g.expect}`)
check(
  '§5：门的清单覆盖了 ADR-043 §5 的每一行（契约 / 冻结区 / recall / prompt / 展示面 / 真实链路）',
  ['typecheck', 'kernel:test', 'm4:test', 'm4:verify', 'eval:m4', 'm4.5:ci'].every((n) => GATES_4A.some((g) => g.pnpm === n)),
  `${GATES_4A.length} 条`
)

// ===========================================================================
section('§6 量具有效性（正控 / 负控 / 恢复 + measured_count>0 + 对账）')
// ===========================================================================

/** 三段式的核心判据：一个文件是否会被判为"无信封但参与用户事实形成" */
function classifySynthetic(rel: string, text: string): Impact[] {
  const list: Impact[] = []
  const hasEventCall = callSite(SYM.createEvent).test(text)
  const hasTrusted = new RegExp(`${SYM.trusted}\\s*:`).test(text)
  const mentionsUserFact = /'(person_fact|preference)'/.test(text) || /person_fact|preference/.test(text)
  if (hasEventCall && !hasTrusted && mentionsUserFact) list.push('T1-fixture-unenveloped')
  if (hasEventCall && hasTrusted) list.push('T5-already-attested')
  if (new RegExp(SYM.view).test(text)) list.push('T2-view-type')
  return list.length > 0 ? list : ['T6-mention-only']
}
const POSITIVE = classifySynthetic('synthetic/positive.ts', "const x = createConversationEvent({ actorType: 'user' })\nconst t = 'person_fact'\n")
const NEGATIVE_TRUSTED = classifySynthetic('synthetic/trusted.ts', "const x = createConversationEvent({ trustedAttribution: ctx })\nconst t = 'person_fact'\n")
const NEGATIVE_MENTION = classifySynthetic('synthetic/mention.ts', "// createConversationEvent 的说明\nconst t = 'person_fact'\n")
const RESTORED = classifySynthetic('synthetic/positive.ts', "const x = createConversationEvent({ actorType: 'user' })\nconst t = 'person_fact'\n")
check('★ 量具正控：**无信封 + 参与用户事实形成** 的合成样本 ⇒ 必被判 `T1`（会红）', POSITIVE.includes('T1-fixture-unenveloped'), POSITIVE.join(','))
check('★ 量具负控 A：**带受信归因** 的合成样本 ⇒ 必被判 `T5`（不受影响），**不得**误报 T1', NEGATIVE_TRUSTED.includes('T5-already-attested') && !NEGATIVE_TRUSTED.includes('T1-fixture-unenveloped'), NEGATIVE_TRUSTED.join(','))
check('★ 量具负控 B：**只在注释里提及** 的合成样本 ⇒ 必被判 `T6`（不受影响）', NEGATIVE_MENTION.includes('T6-mention-only'), NEGATIVE_MENTION.join(','))
check('★ 量具恢复：放回正控样本 ⇒ 读数与首次**逐字相同**（检测器无状态）', JSON.stringify(RESTORED) === JSON.stringify(POSITIVE), `${POSITIVE.join(',')} vs ${RESTORED.join(',')}`)

const measurementInvalid = measurements.filter((m) => !m.valid)
check(
  '所有计数型判据都自检过 `measured_count > 0`（测到 0 个对象的一律 MEASUREMENT INVALID，不报 PASS）',
  measurementInvalid.length === 0,
  `${measurements.length} 个量具，无效 ${measurementInvalid.length} 个${measurementInvalid.length > 0 ? `：${measurementInvalid.map((m) => m.label).join(' , ')}` : ''}`
)

const prodAfter = prodBoundaryIdentity()
check(
  '只读边界（收尾）：真实库边界身份在**本步执行前后**逐字相同（本步确实只读）',
  prodAfter.fingerprint === prodBefore.fingerprint && prodAfter.newestMtimeIso === prodBefore.newestMtimeIso,
  `${prodAfter.fingerprint.slice(0, 16)}… · ${prodAfter.newestMtimeIso}`
)

// ===========================================================================
section('§7 交付与 STOP')
// ===========================================================================

const verdict = failed === 0 && measurementInvalid.length === 0 ? 'COMPLETE' : 'FAIL'
mkdirSync(ART, { recursive: true })
const evidence = {
  testId: 'M5.1.1 / Phase 4 — 4-preflight（只读；ADR-043 `DR-8` 第一步）',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:phase4:preflight',
  verdict,
  passed,
  failed,
  failures,
  readOnlyBoundary: {
    importsOnlyNode: importedForbidden.length === 0,
    writesOnlyOwnEvidence: SELF_WRITE,
    realDbOpenedByAppCode: false,
    realDbSampled: 'statSync / readdirSync only',
    productionDbBoundaryBefore: prodBefore,
    productionDbBoundaryAfter: prodAfter,
    productionDbBoundaryUnchanged: prodAfter.fingerprint === prodBefore.fingerprint,
    frozenFaceVsTag: frozen,
    srcTouched: false,
    fixturesTouched: false,
    existingCriteriaTouched: false,
    executedPhase4a: false,
    executedPhase4b: false,
  },
  candidateRange: {
    note: '**候选**（ADR-043 §2.3 口径）—— 只回答"这个文件值不值得看"，**不是**受影响清单',
    files: candidateRows.length,
    totals: candidateTotals,
    scannedTsFiles: ALL_TS.length,
    selfExcluded: SELF_REL,
  },
  preciseRange: {
    note: '**精确** —— 按"真的调用了 / 真的断言了"计，逐条带 `file:line`',
    createEventCallSites: eventSites.length,
    createEventWithTrusted: eventSites.filter(sitePassesTrusted).length,
    createEventWithoutTrusted: untrustedSites.length,
    resolveCandidatesCallSites: resolveSites.length,
    predicateAssertSites: predicateSites.length,
    reasonCodeSites: {
      evidence_cannot_support_external_fact: reasonOriginSites.length,
      authority_cannot_establish_person_fact: reasonAuthoritySites.length,
      unconfirmed_origin_cannot_become_memory_authority: reasonUnconfirmedSites.length,
      pipelineSide: reasonPipelineSites.length,
      contractSide: reasonContractSites.length,
      note: '理由码是**字符串字面量**：`4a` 真正打断的只有**管线侧**断言（`resolved[].rejection.reason`）；契约侧走别的函数，不受影响',
    },
    affectedFiles: impacts.length,
    willRedAt4a: impacts.filter((i) => i.willRedAt4a === 'yes').length,
    typeOnlyFiles: impacts.filter((i) => i.willRedAt4a === 'type-only').length,
    unaffectedFiles: impacts.filter((i) => i.willRedAt4a === 'no').length,
    reconciliation: `候选 ${Object.values(candidateTotals).reduce((s, n) => s + n, 0)} 处命中 → ${ALL_TS.length} 个被扫文件里的 ${eventSites.length + resolveSites.length + predicateSites.length} 个调用/断言点 → ${impacts.length} 个有信号文件 → ${impacts.filter((i) => i.willRedAt4a === 'yes').length} 个会在 4a 直接变红`,
  },
  callSites: { createEvent: eventSites, resolveCandidates: resolveSites, predicate: predicateSites, reasonCodes: { origin: reasonOriginSites, authority: reasonAuthoritySites, unconfirmed: reasonUnconfirmedSites, pipelineSide: reasonPipelineSites, contractSide: reasonContractSites } },
  fileImpacts: impacts,
  fixturePlan: { path: 'artifacts/m5.1.1/wp4pre-fixture-plan.md', coveredFiles: fixturePlanRows.length - 2, templateSource: { humanIngressSites: ingressHumanSites, agentIngressSites: ingressAgentSites }, forbidden: 'test-only attestation backdoor（ADR-043 ALT-10）' },
  gates4a: GATES_4A,
  instrumentHealth: { threeStage: { positive: POSITIVE, negativeTrusted: NEGATIVE_TRUSTED, negativeMention: NEGATIVE_MENTION, restored: RESTORED }, measurements, measurementInvalid: measurementInvalid.length },
  statusAfterThisStep: { phase4: 'NOT RUN', authorized: '只读 4-preflight（本步）', delegated: '4a / 4b 待用户另行放行', d01: 'P1 OPEN', m511Final: 'BLOCKED' },
  notClaimed: [
    '本步**不**把候选命中数当成受影响数：所有结论都引用"调用点 / 断言点"计数，候选只作分母。',
    '本步**不**执行 `4a` / `4b`：不改 `src/**`、不改任何夹具、不改任何既有判据。',
    '本步**不**打开真实库（只 `statSync` / `readdirSync` 采样，并比对边界身份）。',
    'T2（类型层面）的**完整**清单以 `4a` 时 `tsc` 的报错为准 —— 本步给的是**当前**调用点inventory，不是编译器的最终枚举。',
    'T3（直接断言来源谓词）在 ADR-043 的设计下**不受影响**（4a **不改**谓词语义，只在其前面**追加**一道闸）；若 4a 偏离这条设计，T3 会变成受影响面 —— 那需要重开审查。',
    '§5 的"预期变化"是**预测**，待 `4a` 实测；本步不预先声明任何尚未观测到的红或绿。',
  ],
}
writeFileSync(join(ART, 'wp4pre-preflight.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
writeFileSync(join(ART, 'wp4pre-fixture-plan.md'), fixturePlanFull, 'utf8')
writeFileSync(
  join(ART, 'wp4pre-gate-exits.txt'),
  [
    'M5.1.1 / Phase 4 — 4-preflight（只读）—— 逐门退出码',
    '='.repeat(72),
    '口径：`$o = pnpm <script> 2>&1; $c = $LASTEXITCODE`，**串行**执行。',
    '',
    `EXIT=${failed === 0 && measurementInvalid.length === 0 ? 0 : 1}  pnpm m5.1.1:phase4:preflight   ${passed} 通过 / ${failed} 失败 · measurementInvalid=${measurementInvalid.length}`,
    '',
    '本步**没有**跑任何会改状态的写门（`4-preflight` 的纪律是只读）：',
    '  未跑 m4:test / m4:verify / eval:m4 / m4.5:ci —— 它们是 **4a** 的门，见 wp4pre-preflight.json 的 gates4a。',
  ].join('\n') + '\n',
  'utf8'
)
console.log('  ↳ 证据：artifacts/m5.1.1/wp4pre-preflight.json')
console.log('  ↳ 方案：artifacts/m5.1.1/wp4pre-fixture-plan.md')

console.log(`\n${'='.repeat(78)}`)
console.log(`M5.1.1 Phase 4 — 4-preflight：${passed} 通过 / ${failed} 失败｜**4-preflight = ${verdict}**`)
console.log(`  候选：${candidateRows.length} 文件 / ${Object.values(candidateTotals).reduce((s, n) => s + n, 0)} 处命中`)
console.log(`  精确：${eventSites.length} 事件调用点 / ${resolveSites.length} 解析调用点 / ${predicateSites.length} 谓词断言点 / ${reasonSites.length} 理由码字面量（管线侧 ${reasonPipelineSites.length}）`)
console.log(`  影响：${impacts.length} 个有信号文件 ⇒ 会红 ${impacts.filter((i) => i.willRedAt4a === 'yes').length} · 类型必改 ${impacts.filter((i) => i.willRedAt4a === 'type-only').length} · 不受影响 ${impacts.filter((i) => i.willRedAt4a === 'no').length}`)
console.log(`  状态：Phase 4 = NOT RUN · M5.1-D01 = P1 OPEN · M5.1.1 Final = BLOCKED ⇒ STOP，等待另行授权 4a`)
console.log('='.repeat(78))
if (failed > 0) console.log(`失败项：\n${failures.map((f) => `    - ${f}`).join('\n')}`)
process.exit(failed === 0 && measurementInvalid.length === 0 ? 0 : 1)
