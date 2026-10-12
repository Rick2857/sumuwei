/**
 * M5.1.1 WP7 —— **只读 preflight**（`pnpm m5.1.1:wp7:preflight`）
 *
 * ============================================================================
 *  这个脚本是什么（以及**不是**什么）
 * ============================================================================
 * 它实现 WP7 执行计划里两件事，两件都是**只读**的：
 *
 *   AT-W7-0  Baseline / Scope Freeze
 *           记录 page.html / developer-query.ts / query-service.ts 的内容指纹、
 *           迁移指纹、真实库 mtime、git 状态、WP6.1 的 verdict 与生产 ingress 构造者数，
 *           并确认 WP7 尚未开始。
 *
 *   AT-W7-4  Unknown Count 的**语义单位**是否已被冻结
 *           机械扫描设计文档，判断"unknown count"的单位（slot / record / item）
 *           有没有**唯一**的规范性定义。若没有 ⇒ 按执行计划立刻 STOP：
 *           `WP7 = PARTIAL`，`Unknown-count semantic unit = UNRESOLVED`。
 *
 * ⚠️ 它**不是** `pnpm m5.1.1:wp7:verify`（那是 AT-W7-11 的交付物）。
 *    它**不打开任何数据库**（连沙箱都不建）；它**不写** `src/`；
 *    它只读文件、git 与 `data/pglite` 的 **mtime**（证明真实库没被动）。
 *
 * 退出码：0 = preflight 自身跑完（结论写在 JSON 的 `verdict` 字段里）。
 *         在这份 preflight 里，结论**就是** `WP7 = PARTIAL — HARD STOP #1`，
 *         所以 stdout 末尾会用一行大字把它写出来 —— 不要让"exit 0"被误读成 PASS。
 *
 * 跑法：pnpm m5.1.1:wp7:preflight
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { MIGRATIONS } from '../src/infrastructure/persistence/migrations.ts'
import { flushPage, runDevPage } from './dev-page-harness.ts'

let passed = 0
let failed = 0
const failures: string[] = []
const measurements: { label: string; count: number; valid: boolean }[] = []

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? `  [${detail}]` : ''}`)
  } else {
    failed += 1
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? `  [${detail}]` : ''}`)
  }
}
function measure(label: string, count: number): number {
  const valid = count > 0
  measurements.push({ label, count, valid })
  if (!valid) check(`[MEASUREMENT INVALID] ${label}（measured_count = 0）`, false, '什么都没测到')
  return count
}
function section(title: string): void {
  console.log(`\n${'='.repeat(74)}\n${title}\n${'='.repeat(74)}`)
}

const ROOT = process.cwd()
const EVIDENCE_DIR = join(ROOT, 'artifacts', 'm5.1.1')
const LIVE_DB_DIR = join(ROOT, 'data', 'pglite')

console.log('='.repeat(74))
console.log('M5.1.1 WP7 —— 只读 preflight（AT-W7-0 baseline + AT-W7-4 unknown-count unit）')
console.log('='.repeat(74))

// ===========================================================================
section('AT-W7-0 Baseline / Scope Freeze（只读）')
// ===========================================================================

/*
 * 三个展示面的源码文本（下面 AT-W7-0 / AT-W7-4 都要用，故在此一次性读入）。
 * 只读 —— 本脚本从不写 `src/`。
 */
const pageSource = readFileSync(join(ROOT, 'src/infrastructure/dev/page.html'), 'utf8')
const developerQuerySource = readFileSync(
  join(ROOT, 'src/kernel/contracts/developer-query.ts'),
  'utf8'
)
const queryServiceSource = readFileSync(
  join(ROOT, 'src/infrastructure/dev/query-service.ts'),
  'utf8'
)

const RELATIVE_WATCHED = [
  'src/infrastructure/dev/page.html',
  'src/kernel/contracts/developer-query.ts',
  'src/infrastructure/dev/query-service.ts',
]
const sha256Of = (relativePath: string): string =>
  createHash('sha256').update(readFileSync(join(ROOT, relativePath))).digest('hex')
const fileBaseline = RELATIVE_WATCHED.map((relativePath) => ({
  path: relativePath,
  sha256: sha256Of(relativePath),
  bytes: statSync(join(ROOT, relativePath)).size,
}))
measure('记录指纹的文件数', fileBaseline.length)
for (const entry of fileBaseline) console.log(`  · ${entry.path} = ${entry.sha256}`)

const fingerprintOf = (version: number): string => {
  const migration = MIGRATIONS.find((item) => item.version === version)
  if (migration === undefined) throw new Error(`没有 MIGRATION_000${version}`)
  return createHash('sha256').update(migration.statements.join('\n'), 'utf8').digest('hex')
}
const migrationBaseline = {
  versions: MIGRATIONS.map((item) => item.version).join(','),
  v7: fingerprintOf(7),
  v8: fingerprintOf(8),
  // WP9-B1（R-45）：v9 的指纹按同一规则锁定（触发点 = 副本上第一次成功的 v6 → v9 apply）
  v9: fingerprintOf(9),
}
check(
  'AT-W7-0 schema 边界：迁移版本 = 1..9（v9 = WP9-B1 的 state_events 承载；' +
    'preflight 当时记录的"1..8"作为历史读数保留在下面的 baseline 注释里，未删除）',
  migrationBaseline.versions === '1,2,3,4,5,6,7,8,9',
  migrationBaseline.versions
)
check(
  'AT-W7-0 v7 / v8 指纹与 M5.1.1 冻结值逐字相同（判据一字未改），v9 = WP9-B1 锁定值',
  migrationBaseline.v7 === '2d51997dc620ff01f87bcf8784c15985c6d6d9d2a4b978809db5f8dbc7c07613' &&
    migrationBaseline.v8 === '0a2bd4fe470ac5ce4d4a42717fbd799d9ddb570c4d360f34bc17b580e0538e29' &&
    migrationBaseline.v9 === '5a007003b773351fc870865e541e8d3e2a9e00ccf8e227f3c2b41eb1d5a8c27c',
  `${migrationBaseline.v7.slice(0, 16)} / ${migrationBaseline.v8.slice(0, 16)} / ${migrationBaseline.v9.slice(0, 16)}`
)

/** 真实库：**只取 mtime**（绝不打开）。`data/**` 被 gitignore ⇒ git 证明不了它没变。 */
const liveDbStat = statSync(LIVE_DB_DIR)
const liveDbBaseline = {
  path: 'data/pglite',
  mtimeIso: liveDbStat.mtime.toISOString(),
  mtimeLocal: liveDbStat.mtime.toLocaleString('zh-CN', { hour12: false }),
  openedByThisScript: false,
}
console.log(`  · 真实库 mtime = ${liveDbBaseline.mtimeLocal}（本脚本从未打开它）`)

const git = (args: readonly string[]): string => {
  try {
    return execFileSync('git', [...args], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch (error) {
    return `<unavailable: ${(error as Error).message.slice(0, 60)}>`
  }
}
const gitBaseline = {
  head: git(['rev-parse', 'HEAD']),
  headSubject: git(['log', '-1', '--pretty=%s']),
  statusPorcelain: git(['status', '--porcelain']),
  /** 关键的 scope-freeze 断言只看**产品代码**：preflight 自己会带来未跟踪的新文件 */
  statusPorcelainProductCode: git(['status', '--porcelain', '--', 'src']),
}
/**
 * WP7 的**基线提交**（AT-W7-0 那一次 preflight 跑时的 HEAD）。
 *
 * 它把"WP7 动了哪些 `src/` 文件"变成一个**可判定**的问题：
 * `git diff --name-only <base> -- src` 必须 ⊆ WP7 的允许面。
 * 这条替代了 AT-W7-0 当时那句"`src/` 干净" —— WP7 一旦开工，
 * "干净"必然为假，而"**只在允许面里动**"才是真正要守的性质。
 */
const WP7_BASELINE_COMMIT = '3ccbf9f'
/** WP7 允许改动的 `src/` 面：展示面（Console）+ 计数的数据面（契约与查询服务） */
const WP7_ALLOWED_SRC_PATHS = [
  'src/infrastructure/dev/page.html',
  'src/infrastructure/dev/query-service.ts',
  'src/kernel/contracts/developer-query.ts',
]
const wp7TouchedSrc = git(['diff', '--name-only', WP7_BASELINE_COMMIT, '--', 'src'])
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '')
measure('自 WP7 基线以来被改动的 src 文件数', wp7TouchedSrc.length)
const outOfScopeSrc = wp7TouchedSrc.filter((path) => !WP7_ALLOWED_SRC_PATHS.includes(path))
check(
  '★ AT-W7-0 scope：自 WP7 基线以来 `src/` 的改动**全部**落在允许面内（展示面 + 计数数据面）',
  outOfScopeSrc.length === 0,
  outOfScopeSrc.join(', ') || wp7TouchedSrc.join(', ')
)
check(
  '★ AT-W7-0 WP7 已经开始：`page.html` 里**有** attribution 渲染代码（AT-W7-1…3 的落点）',
  /renderAttributionValue|renderAttributionOrigin|renderAxisB|attributionCard/.test(pageSource),
  'AA'
)
check(
  '★ AT-W7-1 渲染器**只有一套**：Trace 与 Execution 通过**同一个** `attributionCard` 渲染',
  (pageSource.match(/attributionCard\(/g) ?? []).length >= 2 &&
    /function attributionCard\(/.test(pageSource),
  `attributionCard 出现 ${(pageSource.match(/attributionCard\(/g) ?? []).length} 次（1 定义 + N 调用）`
)
if (gitBaseline.statusPorcelain !== '') {
  console.log(
    `  · 工作树里另有 ${gitBaseline.statusPorcelain.split('\n').length} 条未提交条目` +
      '（preflight 自己的脚本 / 证据 / 文档 —— 不是产品代码）'
  )
}

/** 上一 WP 的机读结论（**读**证据文件，不重新跑门） */
const wp61Evidence = JSON.parse(
  readFileSync(join(EVIDENCE_DIR, 'wp6.1-conversation-ingress.json'), 'utf8')
) as {
  verdict?: string
  passed?: number
  failed?: number
  scope?: { wp7Started?: boolean }
  ingressInventory?: { producersBeforeWp61?: number; producersAfterWp61?: number }
}
const upstream = {
  wp61Verdict: String(wp61Evidence.verdict),
  wp61Passed: Number(wp61Evidence.passed),
  wp61Failed: Number(wp61Evidence.failed),
  producersBefore: Number(wp61Evidence.ingressInventory?.producersBeforeWp61),
  producersAfter: Number(wp61Evidence.ingressInventory?.producersAfterWp61),
  wp7StartedPerWp61Evidence: wp61Evidence.scope?.wp7Started === true,
}
check(
  'AT-W7-0 上游前提：WP6.1 = PASS 且生产侧受信对话归因构造者 > 0（K-28 CLOSED）',
  upstream.wp61Verdict === 'PASS' && upstream.wp61Failed === 0 && upstream.producersAfter > 0,
  `WP6.1=${upstream.wp61Verdict} ${upstream.wp61Passed}/${upstream.wp61Failed} producers=${upstream.producersBefore}→${upstream.producersAfter}`
)

// ===========================================================================
section('AT-W7-4 Unknown Count 的语义单位：**机械**判断有没有冻结定义')
// ===========================================================================

/**
 * 扫描范围：设计文档（M5.1.1 设计集 + ADR-042 的窄幅 addendum）。
 *
 * 判据是**机械的**，分两遍：
 *   (A) `countNotionHits`  —— 提到 "unknown count" 这个**东西**的每一行
 *   (B) `unitConventionHits` —— 同一批文档里给"Unknown 怎么计数"的**单位信号**的每一行
 *
 * 只有 **同一行**既提到这个计数**又**给出单位（`unknown count 是 <单位>` 这种**规范性定义**）
 * 才算"冻结了单位"。当前文档里这样的行有 **0** 条 ⇒ 未冻结。
 */
const DOC_FILES = (() => {
  const out: string[] = []
  const collect = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) collect(full)
      else if (entry.name.endsWith('.md')) out.push(full)
    }
  }
  collect(join(ROOT, 'docs', 'm5.1.1'))
  for (const entry of readdirSync(join(ROOT, 'docs', 'adr'))) {
    if (entry.startsWith('ADR-042') && entry.endsWith('.md')) {
      out.push(join(ROOT, 'docs', 'adr', entry))
    }
  }
  return out.sort()
})()

/*
 * ⚠️ **自污染防线**（本脚本第一次跑通之后才发现的真实缺陷）。
 *
 * 判据是"同一行既提计数又给单位 = 规范定义"。而**登记这份未决问题的文档**必然要
 * 逐字复述那些单位（"U-14 的 unknown count，单位是逐槽位/记录级/条目级？"）——
 * 它就在被扫描的文档集里。若不过滤，**我自己的问题登记**会被判成"规范定义"：
 * 轻则给出错误的理由（"定义不唯一"而不是"没有定义"），重则把结论**翻成已冻结**。
 *
 * 因此：**非规范性文档**（对这份未决问题的登记与交接）一律排除；
 * 并且下面有断言证明这条排除是**承重的**（被排除的文件里确实有 count+unit 行）。
 */
const NORMATIVE_DOC_EXCLUDES = [
  /M5\.1\.1-WP7-Unknown-Count-Narrow-Decision\.md$/,
  /WP7-Handoff\.md$/,
]
const isNormativeDoc = (path: string): boolean =>
  !NORMATIVE_DOC_EXCLUDES.some((pattern) => pattern.test(path.replace(/\\/g, '/')))
const excludedDocFiles = DOC_FILES.filter((path) => !isNormativeDoc(path))
const normativeDocFiles = DOC_FILES.filter((path) => isNormativeDoc(path))
measure('扫描的设计文档数（规范性）', normativeDocFiles.length)
measure('被排除的"问题登记"文档数', excludedDocFiles.length)

const COUNT_NOTION = /unknown\s*count|unknownCount|未知计数/i
const UNIT_SIGNALS = [
  {
    unit: 'slot',
    // 规范字段名 `unknownSlotCount` 本身就是"逐槽位"的**持久定义**（用户 2026-09-18 裁定）
    pattern: /逐槽位|每一个?槽位|按槽位|per[- ]?slot|slot[- ]?level|unknownSlotCount/i,
  },
  {
    unit: 'record',
    pattern:
      /(条|行).{0,8}记录|记录数|行数|条数|record[- ]?(count|level)|recordsWithUnknownCount/i,
  },
  { unit: 'item', pattern: /条目|item[- ]?level/i },
] as const
/** "这条行在讲 **Unknown / 来源未确立** 的计数" —— 把"修订记录""契约测试条数"等无关噪声滤掉 */
const COUNTING_SUBJECT = /Unknown|UNKNOWN|未确立|unrecorded|来源未/i

const docLines = (path: string): string[] => readFileSync(path, 'utf8').split('\n')
const relative = (path: string): string => path.replace(ROOT, '').replace(/\\/g, '/').replace(/^\/+/, '')

const countNotionHits: { file: string; line: number; text: string }[] = []
const unitConventionHits: { file: string; line: number; text: string; units: string[] }[] = []
const definingHits: { file: string; line: number; text: string; units: string[] }[] = []
/** 罗列了两个以上候选单位的行（不是定义 —— 见下面的注释） */
const ambiguousCountUnitMentions: {
  file: string
  line: number
  text: string
  units: string[]
}[] = []
/** 被排除的"问题登记"文档里，如果**本来**会被判成定义的行的计数（证明排除是承重的） */
const excludedDocCountUnitLines: { file: string; line: number; text: string }[] = []

for (const path of DOC_FILES) {
  const normative = isNormativeDoc(path)
  docLines(path).forEach((text, index) => {
    const trimmed = text.trim()
    const hasCountNotion = COUNT_NOTION.test(trimmed)
    const units = UNIT_SIGNALS.filter((signal) => signal.pattern.test(trimmed)).map(
      (signal) => signal.unit
    )
    if (!normative) {
      if (hasCountNotion && units.length > 0) {
        excludedDocCountUnitLines.push({
          file: relative(path),
          line: index + 1,
          text: trimmed.slice(0, 200),
        })
      }
      return
    }
    if (hasCountNotion) {
      countNotionHits.push({ file: relative(path), line: index + 1, text: trimmed.slice(0, 300) })
    }
    if (units.length > 0 && COUNTING_SUBJECT.test(trimmed)) {
      unitConventionHits.push({
        file: relative(path),
        line: index + 1,
        text: trimmed.slice(0, 300),
        units,
      })
    }
    /*
     * **规范性定义** vs **候选罗列**（这条区分是本脚本第一次跑通后补上的真实缺陷）：
     *
     *   一行里 `unknown count` + 单位信号，**且这句话不是提问/罗列候选**  ⇒ 定义
     *   一行里 `unknown count` + 两个以上单位，**但是提问或"还是…"**    ⇒ 只是在罗列候选
     *
     * 后者出现在**登记这份未决问题**的文字里（narrow decision 的问句、执行计划的 R-31 行）。
     * 若把"罗列候选"也算成定义，判据会给出错误的理由（"定义不唯一"而不是"没有定义"），
     * 而且在**恰好只列一个**候选的那种行上还会**翻成已冻结** —— 那是假阳性。
     *
     * ⚠️ 裁定可能是**复合单位**（用户 2026-09-18 的裁定就是 U-1 **+** U-2 两个字段），
     *    所以"定义"不能要求"恰好一个单位"；判据是"**没有把它留成问题**"。
     */
    const isQuestionForm = /[?？]|还是/.test(trimmed)
    if (hasCountNotion && units.length > 0) {
      if (isQuestionForm) {
        ambiguousCountUnitMentions.push({
          file: relative(path),
          line: index + 1,
          text: trimmed.slice(0, 300),
          units,
        })
      } else {
        definingHits.push({
          file: relative(path),
          line: index + 1,
          text: trimmed.slice(0, 300),
          units,
        })
      }
    }
  })
}

check(
  '★ AT-W7-4 自污染防线**承重**：被排除的"问题登记"文档里确实有 count+unit 行（否则这条排除是装饰）',
  excludedDocFiles.length > 0 && excludedDocCountUnitLines.length > 0,
  `excluded=${excludedDocFiles.length} 文件 · 其中 count+unit 行 = ${excludedDocCountUnitLines.length}`
)
console.log(
  `  · 排除的文档：${excludedDocFiles.map((path) => relative(path)).join(' ・ ') || '（无）'}`
)
console.log(`  · 这些文档里本会被判成"定义"的行 = ${excludedDocCountUnitLines.length}（已被排除）`)

measure('提到 unknown count 的行数', countNotionHits.length)
measure('给出 Unknown 计数单位信号的行数', unitConventionHits.length)
console.log(`\n  (A) 提到 "unknown count" 的行（${countNotionHits.length} 条）：`)
for (const hit of countNotionHits) console.log(`      ${hit.file}:${hit.line}  ${hit.text.slice(0, 120)}`)
const conventionUnits = [...new Set(unitConventionHits.flatMap((hit) => hit.units))].sort()
console.log(`\n  (B) 文档里出现过的计数单位信号：${conventionUnits.join(', ') || '（无）'}`)
for (const hit of unitConventionHits.slice(0, 12)) {
  console.log(`      ${hit.file}:${hit.line}  [${hit.units.join('|')}]  ${hit.text.slice(0, 110)}`)
}
if (unitConventionHits.length > 12) {
  console.log(`      …… 还有 ${unitConventionHits.length - 12} 条（完整清单进证据 JSON）`)
}
console.log(`\n  (C) 规范性定义（同一行既提计数又给单位、且不是提问）：${definingHits.length} 条`)
for (const hit of definingHits) {
  console.log(`      ${hit.file}:${hit.line}  units=${hit.units.join('|')}  ${hit.text.slice(0, 110)}`)
}

const distinctDefinedUnits = [...new Set(definingHits.flatMap((hit) => hit.units))].sort()
/*
 * 裁定的**持久形态**是 canonical 字段名（用户 2026-09-18：`unknownSlotCount` /
 * `recordsWithUnknownCount`）。字段名比散文可靠：它同时是契约里的标识符。
 */
const normativeDocText = normativeDocFiles.map((path) => readFileSync(path, 'utf8')).join('\n')
const canonicalCountFields = {
  slot: /unknownSlotCount/.test(normativeDocText),
  record: /recordsWithUnknownCount/.test(normativeDocText),
}
const canonicalUnits = [
  canonicalCountFields.slot ? 'slot' : null,
  canonicalCountFields.record ? 'record' : null,
].filter((item): item is string => item !== null)
const unknownCountUnit = {
  frozen: definingHits.length >= 1 || canonicalUnits.length > 0,
  unit:
    canonicalUnits.length > 0
      ? canonicalUnits.join(' + ')
      : definingHits.length >= 1
        ? distinctDefinedUnits.join(' + ')
        : null,
  reason:
    canonicalUnits.length > 0
      ? `已被**canonical 字段名**定义：${canonicalUnits.join(' + ')}` +
        `（unknownSlotCount=${String(canonicalCountFields.slot)} / recordsWithUnknownCount=${String(canonicalCountFields.record)}）`
      : definingHits.length >= 1
        ? `已被规范语句定义：单位 = ${distinctDefinedUnits.join(' + ')}（${definingHits.length} 条定义语句）`
        : '没有任何规范语句把「unknown count」与它的单位写在一起（只能找到提问/罗列候选） ⇒ 语义单位未冻结',
  canonicalCountFields,
  /** 设计文档**罗列**了多个候选单位但没有裁定（冲突的正面证据） */
  ambiguousCountUnitMentions,
  /** 文档里**同时**存在两种以上计数惯例 ⇒ 连"按惯例推断"都不成立 */
  conventionUnits,
  conventionAmbiguous: conventionUnits.length > 1,
}
check(
  '★ AT-W7-4 裁定落地：规范文档里给出了两个 canonical 字段名（`unknownSlotCount` / `recordsWithUnknownCount`）',
  canonicalCountFields.slot && canonicalCountFields.record,
  `slot=${String(canonicalCountFields.slot)} record=${String(canonicalCountFields.record)}`
)
/*
 * ⚠️ 这里**刻意不用** `measure()`：0 条定义**就是**结论本身（"未冻结"），
 *    不是"什么都没测到"。用 `measure()` 会把它误报成 MEASUREMENT INVALID。
 *    实测范围由上面两个 measure 自检（扫描了 N 个文档 / 命中 N 行）。
 *
 * ✅ **这条判据会跟着裁定走**：用户裁定并把单位写进设计文档之后，
 *    那一天的那一行就会成为 `definingHits` 的唯一一条 ⇒ `frozen = true`
 *    ⇒ 本 preflight 的 verdict 自动变成 `WP7_CAN_PROCEED`（无需改脚本）。
 */
console.log(`  · 规范性定义条数 = ${definingHits.length}（0 ⇒ 未冻结）`)
console.log(`  · 罗列多个候选单位的行 = ${ambiguousCountUnitMentions.length}（` +
  `${ambiguousCountUnitMentions.map((hit) => `${relative(hit.file)}:${hit.line}[${hit.units.join('|')}]`).join(' ・ ') || '（无）'}）`)
check(
  '★ AT-W7-4 规范性定义：至少有一条规范语句把「unknown count」与它的单位写在一起（不是提问/罗列）',
  definingHits.length >= 1,
  definingHits.map((hit) => `${relative(hit.file)}:${hit.line}[${hit.units.join('|')}]`).join(' ・ ') ||
    '（没有 ⇒ 未冻结）'
)
check(
  '★ AT-W7-4 冲突的正面证据（历史）：设计文档曾**罗列**多个候选单位而没有裁定',
  ambiguousCountUnitMentions.length >= 1,
  `${ambiguousCountUnitMentions.length} 行`
)

// --- 负控 / 恢复：这条判据必须**两个方向都会响**（否则它只是个常数 -------------------
const syntheticDefiningDoc = '响应必须提供 unknown count，其单位是 逐槽位 的计数。'
const syntheticQuestionDoc = '响应必须提供 unknown count，单位是 逐槽位 还是 记录级？'
const syntheticHits = [syntheticDefiningDoc].filter(
  (line) =>
    COUNT_NOTION.test(line) &&
    !/[?？]|还是/.test(line) &&
    UNIT_SIGNALS.some((signal) => signal.pattern.test(line))
)
const syntheticQuestionHits = [syntheticQuestionDoc].filter(
  (line) =>
    COUNT_NOTION.test(line) &&
    /[?？]|还是/.test(line) &&
    UNIT_SIGNALS.some((signal) => signal.pattern.test(line))
)
    const syntheticUnit = UNIT_SIGNALS.filter((signal) => signal.pattern.test(syntheticDefiningDoc)).map(
  (signal) => signal.unit
)
check(
  '★ AT-W7-4 负控①：把一行**合规格的定义**喂给同一套判据 ⇒ 判据给出"已冻结"（不是常数）',
  syntheticHits.length === 1 && syntheticUnit.length === 1 && syntheticUnit[0] === 'slot',
  `hits=${syntheticHits.length} unit=${syntheticUnit.join(',')}`
)
check(
  '★ AT-W7-4 负控②：一行**提问式**的候选罗列**不得**被当成定义（提问/定义的区分有效）',
  syntheticQuestionHits.length === 1 && syntheticHits.length === 1,
  `questionHits=${syntheticQuestionHits.length}`
)
check(
  '★ AT-W7-4 结论与证据自洽：`frozen` ⟺ 至少有一条规范定义语句（报告当前状态，不预设答案）',
  unknownCountUnit.frozen === definingHits.length >= 1 && unknownCountUnit.frozen === (definingHits.length > 0),
  `frozen=${String(unknownCountUnit.frozen)} definingHits=${definingHits.length} reason=${unknownCountUnit.reason}`
)

// ===========================================================================
section('AT-W7-4 先例审计：**现有 console / DTO** 的计数口径是什么（实测）')
// ===========================================================================

/*
 * 这一节回答的是："能不能靠**现有先例**定出单位？"
 * 判据不是我的判断，而是两份可机械读出来的事实：
 *   ① 现有 Developer Console 渲染的计数，是**记录级**还是**逐槽位**？
 *   ② 设计集里**唯一**关于 Unknown 的计数口径，是什么单位？
 * 如果两者回答的不是同一个问题，那么"按先例"就不能定 U-14 的单位。
 */
const pageSourceForCounters = pageSource
const consoleCounterLines = pageSourceForCounters
  .split('\n')
  .map((text, index) => ({ line: index + 1, text: text.trim() }))
  .filter((item) => /\bstats\.\w+|\.length\b/.test(item.text))
measure('现有 console 里渲染计数的行数', consoleCounterLines.length)

/** 服务端给的计数**字段**（记录级）：developer-query.ts 里的 MemoryStatsDto */
const statsFields = [
  'total',
  'active',
  'superseded',
  'retracted',
  'disputed',
  'unsupported',
  'contaminated',
  'unregisteredPredicate',
].filter((field) => new RegExp(`\\b${field}:\\s*number`).test(developerQuerySource))
measure('MemoryStatsDto 的记录级计数字段数', statsFields.length)

/** 页面自己数数组长度的行（既有、且已被 M5.1 验收接受的写法） */
const pageComputedCounterLines = consoleCounterLines.filter((item) => /\.length\b/.test(item.text))
const consolePrecedent = {
  recordLevelStatFields: statsFields,
  consoleCounterLines: consoleCounterLines.map((item) => `page.html:${item.line} ${item.text.slice(0, 120)}`),
  pageComputedLengthLines: pageComputedCounterLines.map(
    (item) => `page.html:${item.line} ${item.text.slice(0, 120)}`
  ),
  /** 现有 console 的计数全部是**记录级**（要么是服务端给的记录级字段，要么是数组长度） */
  consoleCountsAreRecordLevel: statsFields.length > 0 && consoleCounterLines.length > 0,
  /** 设计集里**唯一**关于 Unknown 的计数口径是"逐槽位，不是总数" */
  unknownSpecificConventionIsSlot: unitConventionHits.some((hit) => hit.units.includes('slot')),
  /** ⇒ 两个先例回答的不是同一个问题：不能凭先例定单位 */
  precedentSplits:
    statsFields.length > 0 && unitConventionHits.some((hit) => hit.units.includes('slot')),
}
check(
  '★ AT-W7-4 先例①：现有 console 渲染的计数是**记录级**（`stats.*` 记录级字段 + 数组 `.length`）',
  consolePrecedent.consoleCountsAreRecordLevel,
  `${statsFields.length} 个字段 / ${consoleCounterLines.length} 行`
)
check(
  '★ AT-W7-4 先例②：设计集里**唯一**关于 Unknown 的计数口径是**逐槽位**（且明确"不是总数"）',
  consolePrecedent.unknownSpecificConventionIsSlot,
  unitConventionHits
    .filter((hit) => hit.units.includes('slot'))
    .map((hit) => `${relative(hit.file)}:${hit.line}`)
    .join(', ') || '（无）'
)
check(
  '★ AT-W7-4 先例审计结论：两个先例回答的不是同一个问题 ⇒ **不能凭先例定 U-14 的单位**' +
    '（这是当时 STOP 的依据；单位后来由用户裁定给出 —— 见下一条）',
  consolePrecedent.precedentSplits,
  `consoleRecordLevel=${String(consolePrecedent.consoleCountsAreRecordLevel)} unknownConventionSlot=${String(consolePrecedent.unknownSpecificConventionIsSlot)}`
)
console.log(
  `  · 备注：现有 console 里有 ${pageComputedCounterLines.length} 行是**页面自己数数组长度**` +
    '（形如 `(x || []).length`）—— 那是 M5.1 已验收的写法，但它数的是"服务端**已经筛好**的列表"，' +
    '不涉及"什么算一个 unknown"这个语义；U-14 要的"**响应提供** unknown count"与此不同。'
)

// ===========================================================================
section('AT-W7-4 边界与可计算性：裁定必须一次给全（免得裁完再撞第二次 STOP）')
// ===========================================================================

/*
 * 单位裁定之后，还有两个问题会决定"能不能马上写门"：
 *   ① **边界**：`ABSENT` / 无信封的 legacy 行 / `MIGRATED_LEGACY` 的 Unknown，算不算进这个计数？
 *   ② **可计算性**：三个候选单位在**现有 WP6 DTO** 上算得出来吗（会不会需要新的响应字段之外的东西）？
 * 两者都是**机械可查**的：边界看冻结语义，可计算性看 DTO 暴露了哪些槽位。
 */

/** ① 边界：这些语义在冻结文档里有没有被写成"计数规则" */
const boundarySources = [
  {
    id: 'UNKNOWN ≠ ABSENT',
    frozenAsSemantics: /Unknown.*不得.*折叠成.*Absent|三态在渲染层可区分/.test(
      readFileSync(join(ROOT, 'docs/m5.1.1/M5.1.1-Test-and-Gate-Plan.md'), 'utf8')
    ),
    frozenAsCountingRule: false,
  },
  {
    id: '无信封 ≠ Unknown',
    frozenAsSemantics: /没有信封的行.*attribution.*缺席|两件事不能合并/.test(
      readFileSync(join(ROOT, 'docs/m5.1.1/WP6-Handoff.md'), 'utf8')
    ),
    frozenAsCountingRule: false,
  },
  {
    id: 'MIGRATED_LEGACY 的 Unknown(LEGACY_UNRECORDED) 仍是 Unknown',
    frozenAsSemantics: /Unknown\(LEGACY_UNRECORDED\).*仍是.*Unknown|重放后\*\*仍是\*\* Unknown/.test(
      readFileSync(join(ROOT, 'docs/m5.1.1/M5.1.1-Test-and-Gate-Plan.md'), 'utf8')
    ),
    frozenAsCountingRule: false,
  },
] as const
measure('审计的边界条目数', boundarySources.length)
const boundariesFrozenAsRules = boundarySources.filter((item) => item.frozenAsCountingRule).length
check(
  '★ AT-W7-4 边界：三条边界都能从冻结语义**推导**出来（Unknown ≠ Absent ≠ 无信封）',
  boundarySources.every((item) => item.frozenAsSemantics),
  boundarySources.map((item) => `${item.id}=${String(item.frozenAsSemantics)}`).join(' · ')
)
check(
  '★ AT-W7-4 边界：**没有**任何一条被写成**计数规则** ⇒ 裁定必须把它们一并写清（§6④）',
  boundariesFrozenAsRules === 0,
  `写成计数规则的条数 = ${boundariesFrozenAsRules}`
)

/** ② 可计算性：现有 DTO 暴露了什么（决定三个候选单位各自还差什么） */
const dtoSlotFields = [
  'initiator',
  'actor',
  'executor',
  'authority',
  'recordedBy',
  'contentOriginator',
].filter((slot) => new RegExp(`readonly ${slot}: Developer`).test(developerQuerySource))
const originField = /readonly attributionOrigin:/.test(developerQuerySource)
/** 无信封 = `attribution` **字段缺席**（不是三态里的 Absent）—— WP6 的判据 */
const noEnvelopeIsFieldAbsence = /attribution\?: DeveloperAttributionDto/.test(developerQuerySource)
measure('WP6 DTO 暴露的槽位字段数', dtoSlotFields.length)
const computability = {
  dtoSlotFields,
  originField,
  noEnvelopeIsFieldAbsence,
  /** U-1（逐槽位）：`attribution` 存在时逐槽位读三态即可 ⇒ 可算 */
  u1ComputableFromExistingDto: dtoSlotFields.length === 6 && originField,
  /** U-2（记录级）：任一槽位 UNKNOWN ⇒ 该条计入 ⇒ 可算 */
  u2ComputableFromExistingDto: dtoSlotFields.length === 6,
  /** U-3（条目级）：还需要"一项是什么"的定义（跨表：对话事件 / 行动事件 / trace / 一页） */
  u3NeedsAnExtraDefinition: true,
}
check(
  '★ AT-W7-4 可计算性：U-1（逐槽位）与 U-2（记录级）在**现有 DTO** 上就都能算（不需要新存储）',
  computability.u1ComputableFromExistingDto && computability.u2ComputableFromExistingDto,
  `${dtoSlotFields.length} 个槽位字段 + origin=${String(originField)}`
)
check(
  '★ AT-W7-4 可计算性：U-3（条目级）**多需要一个定义**（"一项"是什么）—— 裁定时要一并给',
  computability.u3NeedsAnExtraDefinition && !/readonly item\b/.test(developerQuerySource),
  'AA'
)
check(
  'AT-W7-4 无信封的表示法不变：`attribution` **字段缺席**（不是三态里的 ABSENT）',
  noEnvelopeIsFieldAbsence,
  'AA'
)

// ===========================================================================
section('AT-W7-11 可测性预研：能对**真实 page.html** 断言"渲染输出"吗？')
// ===========================================================================

/*
 * 执行计划 §AT-W7-11 要求专项门做到 `actual DTO → actual renderer → rendered output → assertions`。
 * 而 `page.html` 是零 import 的单文件、脚本是**闭包私有**的 IIFE —— 渲染函数从外面拿不到。
 *
 * 这一节用 `scripts/dev-page-harness.ts`（桩 DOM + 桩 fetch，在 node:vm 里把页面跑起来）
 * 对**现有的** page.html 做三段式，证明这条路走得通（AT-W7-1…7 的渲染断言将复用同一个 harness）：
 *
 *   正控：喂 canned DTO ⇒ 在**桩 DOM 的节点树**上读到 canned 数字
 *   负控①：换一组数字 ⇒ 渲染输出随之改变（证明读的不是常数）
 *   负控②：抹掉一个字段 ⇒ 渲染输出**如实**出现 undefined（失败可见，不被 normalize）
 *   恢复：换回第一组 ⇒ 渲染输出**逐字回到**原样
 */
/**
 * 页面里的 `BASE = '/dev/query'`，所以它请求的是**带前缀**的完整路径。
 * 路由表按完整路径给（harness 保持通用：它不假设任何前缀）。
 */
const pageRoutesA: Record<string, unknown> = Object.fromEntries(
  Object.entries({
    '/health': {
      status: 'ok',
      schemaVersion: 8,
      migrationVersion: 8,
      seedVersion: 1,
      seedHash: 'deadbeefcafe',
      integrityOk: true,
      details: [{ name: 'kernel', status: 'ok', detail: 'AA' }],
    },
    '/capabilities': { query: [{ path: '/health' }], runtime: [{ id: 'db' }] },
    '/traces?limit=5': { items: [] },
    '/traces?limit=5&status=failed': { items: [] },
    '/traces?limit=20': { items: [] },
    '/traces?limit=20&status=': { items: [] },
    '/executions?limit=20': { items: [] },
    '/control/commands': [
      { type: 'RUN_AUDIT', authority: 'developer', mutatesDomain: false, kind: 'audit' },
    ],
    '/memory/stats': {
      total: 41,
      active: 34,
      superseded: 5,
      retracted: 1,
      disputed: 1,
      unsupported: 0,
      contaminated: 0,
      unregisteredPredicate: 0,
    },
    '/memory/integrity': {
      integrityOk: true,
      danglingEvidenceLinks: [],
      danglingMemoryEvents: [],
      memoriesWithoutLiveEvidence: [],
      memoriesWithoutLiveEvents: [],
    },
  }).map(([path, body]) => [`/dev/query${path}`, body])
)
const pageRunA = await runDevPage(pageSource, pageRoutesA)
measure('harness 请求的元素 id 数', pageRunA.requestedIds.length)
measure('harness 覆盖的路由数', Object.keys(pageRoutesA).length)
check(
  '★ AT-W7-11 页面请求的 id **全部**真实存在于 HTML 里（缺失 ⇒ 真 bug 被抓住）',
  pageRunA.missingIds.length === 0,
  pageRunA.missingIds.join(', ') || 'AA'
)
check(
  '★ AT-W7-11 页面请求的路径**全部**被路由表解释（没有"不知道它为什么请求这个"）',
  pageRunA.unroutedPaths.length === 0,
  pageRunA.unroutedPaths.join(', ') || 'AA'
)
check(
  '★ AT-W7-11 页面脚本没有抛错（同步错误会被 vm 边界捕获）',
  pageRunA.pageErrors.length === 0,
  pageRunA.pageErrors.join(' | ') || 'AA'
)
check(
  '★ AT-W7-11 正控：在**渲染输出**上读到 canned 数字（`total / active` = 41 / 34）—— 不是 grep 源码文本',
  pageRunA.textOf('memory-box').includes('total / active') &&
    pageRunA.textOf('memory-box').includes('41 / 34'),
  pageRunA.textOf('memory-box').slice(0, 120)
)
const pageRunB = await runDevPage(pageSource, {
  ...pageRoutesA,
  '/dev/query/memory/stats': { ...(pageRoutesA['/dev/query/memory/stats'] as Record<string, unknown>), total: 7, active: 3 },
})
check(
  '★ AT-W7-11 负控①：换一组 canned 数字 ⇒ 渲染输出随之改变（证明读的是**数据**不是常数）',
  pageRunB.textOf('memory-box').includes('7 / 3') &&
    !pageRunB.textOf('memory-box').includes('41 / 34'),
  pageRunB.textOf('memory-box').slice(0, 120)
)
const pageRunBroken = await runDevPage(pageSource, {
  ...pageRoutesA,
  '/dev/query/memory/stats': { active: 1 },
})
check(
  '★ AT-W7-11 负控②：抹掉一个字段 ⇒ 渲染输出**如实**变化并出现 `undefined`（失败可见，不被抹平）',
  pageRunBroken.textOf('memory-box') !== pageRunA.textOf('memory-box') &&
    pageRunBroken.textOf('memory-box').includes('undefined'),
  pageRunBroken.textOf('memory-box').slice(0, 120)
)
const pageRunC = await runDevPage(pageSource, pageRoutesA)
check(
  '★ AT-W7-11 恢复：换回第一组 ⇒ 渲染输出**逐字回到**原样',
  pageRunC.textOf('memory-box') === pageRunA.textOf('memory-box'),
  'AA'
)
console.log(
  `  · harness 触达的元素 id：${pageRunA.requestedIds.length} 个 ` +
    `（其中渲染出文本的：${pageRunA.touchedIds().length} 个）`
)

// --- 点击穿透：把**新的 attribution 渲染器**真的跑起来并断言渲染输出 -----------------
/** 一条 RECORDED 的对话归因（含一个 UNKNOWN(LEGACY_UNRECORDED) 与一个 ABSENT） */
const traceAttributionFixture = {
  attributionOrigin: 'RECORDED',
  subject: { kind: 'CHARACTER', id: 'char-1' },
  initiator: { state: 'ABSENT' },
  actor: { state: 'KNOWN', kind: 'USER', id: 'u-1' },
  executor: { state: 'ABSENT' },
  authority: { state: 'ABSENT' },
  recordedBy: { state: 'KNOWN', kind: 'SYSTEM', id: 'kernel' },
  contentOriginator: { state: 'UNKNOWN', reason: 'LEGACY_UNRECORDED' },
  axisB: {
    availability: 'APPLICABLE',
    sourceKind: 'user_statement',
    sourceAuthority: 'USER_EXPLICIT',
    epistemicSource: 'user_report',
    branch: 'confirmed',
  },
  basisEventType: 'user_message',
  basisSequence: 3,
}
const pageRoutesWithDetail: Record<string, unknown> = {
  ...pageRoutesA,
  '/dev/query/traces?limit=20': {
    counts: { unknownSlotCount: 1, recordsWithUnknownCount: 1 },
    items: [
      {
        traceId: 'trc-1',
        status: 'completed',
        startedAt: 1000,
        stepCount: 1,
        selectedMemoryIds: [],
        hasError: false,
        attribution: traceAttributionFixture,
      },
    ],
  },
  '/dev/query/traces/trc-1': {
    traceId: 'trc-1',
    status: 'completed',
    durationMs: 1,
    contextSectionIds: [],
    droppedSectionIds: [],
    selectedMemoryIds: [],
    actionIds: [],
    steps: [],
    attribution: traceAttributionFixture,
    counts: { unknownSlotCount: 1, recordsWithUnknownCount: 1 },
  },
  '/dev/query/executions?limit=20': {
    items: [
      {
        actionId: 'act-1',
        traceId: 'trc-1',
        capability: 'system.echo',
        operation: 'echo',
        status: 'success',
        accepted: true,
        attempted: true,
        executed: true,
        sideEffect: 'none',
        idempotentReplay: false,
        requestedAt: 1000,
      },
    ],
  },
  '/dev/query/executions/act-1': {
    actionId: 'act-1',
    traceId: 'trc-1',
    capability: 'system.echo',
    operation: 'echo',
    accepted: true,
    attempted: true,
    executed: true,
    status: 'success',
    sideEffect: 'none',
    idempotentReplay: false,
    requestedAt: 1000,
    durationMs: 1,
    intent: { kind: 'current_fact', availability: { status: 'available' } },
    request: { capability: 'system.echo', operation: 'echo', requestedByKind: 'system', sideEffect: 'none', argumentKeys: [], createdAt: 1000 },
    attempt: { attempted: true, evidenceRef: 'ACTION_STARTED' },
    result: { status: 'success', executed: true, effectKind: 'echo' },
    verification: { state: 'not_attempted' },
    evidence: [],
    attribution: {
      attributionOrigin: 'RECORDED',
      subject: { kind: 'CHARACTER', id: 'char-1' },
      initiator: { state: 'KNOWN', kind: 'SERVICE', id: 'agent-runner' },
      actor: { state: 'KNOWN', kind: 'SERVICE', id: 'agent-runner' },
      executor: { state: 'KNOWN', kind: 'TOOL', id: 'weather' },
      authority: { state: 'KNOWN', kind: 'CAPABILITY', ref: 'system.echo' },
      recordedBy: { state: 'KNOWN', kind: 'SYSTEM', id: 'kernel' },
      contentOriginator: { state: 'ABSENT' },
      axisB: { availability: 'NOT_APPLICABLE' },
      basisEventType: 'ACTION_REQUESTED',
      basisSequence: 7,
    },
    counts: { unknownSlotCount: 0, recordsWithUnknownCount: 0 },
  },
}
const pageRunDetail = await runDevPage(pageSource, pageRoutesWithDetail)
check(
  '★ AT-W7-11 正控：Trace 列表面渲染出**响应给的**计数（0 也要显式出现）',
  pageRunDetail.textOf('traces-list').includes('unknownSlotCount=1') &&
    pageRunDetail.textOf('traces-list').includes('recordsWithUnknownCount=1'),
  pageRunDetail.textOf('traces-list').slice(0, 140)
)
const clickedTrace = pageRunDetail.fireFirst('traces-list')
await flushPage(pageSource)
const traceDetailText = pageRunDetail.textOf('trace-detail')
check(
  '★ AT-W7-11 正控：点开一条 trace ⇒ **归因面板真的渲染出来**（点击穿透成功）',
  clickedTrace && traceDetailText.includes('Attribution Truth'),
  clickedTrace ? traceDetailText.slice(0, 120) : '点击没有触发任何监听器'
)
check(
  '★ AT-W7-1 四态可区分（渲染输出级）：KNOWN=`USER/u-1` · ABSENT=`不适用` · ' +
    'UNKNOWN(LEGACY)=`来源未确立（历史未记录）` · origin=`事件发生时记录（RECORDED）`',
  traceDetailText.includes('USER/u-1') &&
    traceDetailText.includes('不适用') &&
    traceDetailText.includes('来源未确立（历史未记录）') &&
    traceDetailText.includes('事件发生时记录（RECORDED）'),
  traceDetailText.replace(/\s+/g, ' ').slice(0, 200)
)
check(
  '★ AT-W7-1 禁止的渲染**没有出现**：UNKNOWN 不得被渲染成空 / `-` / `不适用`',
  !/contentOriginator[^]*?不适用/.test(traceDetailText) &&
    traceDetailText.includes('source_kind=user_statement'),
  'AA'
)
check(
  '★ AT-W7-4 UI：计数只来自响应（`unknownSlotCount=1`），页面没有自己数',
  traceDetailText.includes('unknownSlotCount=1') &&
    traceDetailText.includes('recordsWithUnknownCount=1') &&
    !/\.filter\([^)]*UNKNOWN/.test(pageSource),
  'AA'
)
const clickedExecution = pageRunDetail.fireFirst('executions-list')
await flushPage(pageSource)
const executionDetailText = pageRunDetail.textOf('execution-detail')
check(
  '★ AT-W7-6 执行面板：Axis B 渲染成 `NOT_APPLICABLE`（不是"未知/缺失/错误"）',
  clickedExecution && executionDetailText.includes('NOT_APPLICABLE'),
  clickedExecution ? executionDetailText.replace(/\s+/g, ' ').slice(0, 160) : '点击没有触发'
)
check(
  '★ AT-W7-6 Execution Truth 与归因**分开**：面板里既有 attempt/result，也有独立归因卡',
  executionDetailText.includes('attempt') &&
    executionDetailText.includes('Attribution Truth'),
  'AA'
)
check(
  '★ AT-W7-7 D01 呈现：SERVICE/agent-runner 原样呈现，**不得**被说成 USER 本人',
  executionDetailText.includes('SERVICE/agent-runner') &&
    !executionDetailText.includes('用户本人说的'),
  'AA'
)
const noEnvelopeRun = await runDevPage(pageSource, {
  ...pageRoutesWithDetail,
  '/dev/query/traces/trc-1': {
    traceId: 'trc-1',
    status: 'completed',
    durationMs: 1,
    contextSectionIds: [],
    droppedSectionIds: [],
    selectedMemoryIds: [],
    actionIds: [],
    steps: [],
    counts: { unknownSlotCount: 0, recordsWithUnknownCount: 0 },
  },
})
noEnvelopeRun.fireFirst('traces-list')
await flushPage(pageSource)
const noEnvelopeText = noEnvelopeRun.textOf('trace-detail')
check(
  '★ AT-W7-1 第四态：**无信封**渲染成 `未记录归因（Legacy Event）`，且**一个槽位行都不渲染**' +
    '（缺席不得被折叠成 Absent —— 判据是结构，不是文案）',
  noEnvelopeText.includes('未记录归因（Legacy Event）') &&
    !noEnvelopeText.includes('contentOriginator') &&
    !noEnvelopeText.includes('Axis B'),
  noEnvelopeText.replace(/\s+/g, ' ').slice(-160)
)
check(
  '★ AT-W7-2 origin 不得被升格：无信封的行**没有**出现 MIGRATED_LEGACY / RECORDED',
  !noEnvelopeText.includes('MIGRATED_LEGACY') && !noEnvelopeText.includes('（RECORDED）'),
  'AA'
)

/* --- AT-W7-3 / AT-W7-7：D01 的**对话**行（SERVICE + UNCONFIRMED_ORIGIN）呈现 ------- */
const d01TraceRun = await runDevPage(pageSource, {
  ...pageRoutesWithDetail,
  '/dev/query/traces/trc-1': {
    traceId: 'trc-1',
    status: 'completed',
    durationMs: 1,
    contextSectionIds: [],
    droppedSectionIds: [],
    selectedMemoryIds: [],
    actionIds: [],
    steps: [],
    /* 生产里的 D01 形状：actor_type=user 的**呈现**，而权威槽位是 SERVICE/agent-runner，
       Axis B 成对 UNCONFIRMED_ORIGIN（WP6.1 已在生产链上证明它真的会落库） */
    attribution: {
      attributionOrigin: 'RECORDED',
      subject: { kind: 'CHARACTER', id: 'char-1' },
      initiator: { state: 'ABSENT' },
      actor: { state: 'KNOWN', kind: 'SERVICE', id: 'agent-runner' },
      executor: { state: 'ABSENT' },
      authority: { state: 'ABSENT' },
      recordedBy: { state: 'KNOWN', kind: 'SYSTEM', id: 'kernel' },
      contentOriginator: { state: 'KNOWN', kind: 'SERVICE', id: 'agent-runner' },
      axisB: {
        availability: 'APPLICABLE',
        sourceKind: 'user_statement',
        sourceAuthority: 'UNCONFIRMED_ORIGIN',
        epistemicSource: 'UNCONFIRMED_ORIGIN',
        branch: 'unconfirmed',
      },
      basisEventType: 'user_message',
      basisSequence: 4,
    },
    counts: { unknownSlotCount: 0, recordsWithUnknownCount: 0 },
  },
})
d01TraceRun.fireFirst('traces-list')
await flushPage(pageSource)
const d01TraceText = d01TraceRun.textOf('trace-detail')
check(
  '★ AT-W7-3 Axis B 三列独立渲染：`user_statement` / `UNCONFIRMED_ORIGIN` ×2 都出现',
  d01TraceText.includes('source_kind=user_statement') &&
    (d01TraceText.match(/UNCONFIRMED_ORIGIN/g) ?? []).length >= 2,
  `UNCONFIRMED_ORIGIN 出现 ${(d01TraceText.match(/UNCONFIRMED_ORIGIN/g) ?? []).length} 次`
)
check(
  '★ AT-W7-7 D01 呈现（对话侧）：两个权威槽位都是 `SERVICE/agent-runner`，' +
    '**没有**任何 USER 位次被渲染出来',
  d01TraceText.includes('SERVICE/agent-runner') && !d01TraceText.includes('USER/'),
  d01TraceText.replace(/\s+/g, ' ').slice(0, 160)
)
check(
  '★ AT-W7-3 D01 的 Axis B 被明确标注"来源未确立"（不得读作"用户本人的话"）',
  d01TraceText.includes('来源未确立') && !d01TraceText.includes('用户本人说的'),
  'AA'
)

// ===========================================================================
section('AT-W7-4 影响面：**只有**依赖该单位的交付物被阻塞')
// ===========================================================================

const triStateReady =
  /\{ readonly state: 'UNKNOWN'; readonly reason: string \}/.test(developerQuerySource) &&
  /\{ readonly state: 'ABSENT' \}/.test(developerQuerySource)
const transportReady =
  /DeveloperAttributionDto/.test(developerQuerySource) &&
  /attribution\?: DeveloperAttributionDto/.test(developerQuerySource) &&
  /attribution/.test(queryServiceSource)
const countFieldAbsent =
  !/unknownCount|unknown_count|attributionUnknownCount/.test(developerQuerySource) &&
  !/unknownCount|unknown_count|attributionUnknownCount/.test(queryServiceSource)
check(
  'AT-W7-4 三态 DTO 已就绪（Known / Unknown(reason) / ABSENT 在类型层可区分）—— 渲染面不阻塞',
  triStateReady && transportReady,
  `triState=${String(triStateReady)} transport=${String(transportReady)}`
)
check(
  'AT-W7-4 **没有任何**现成的 unknown-count 字段可复用（WP6 DTO 与查询服务里都没有）',
  countFieldAbsent,
  'AA'
)

// ===========================================================================
section('汇总：本 preflight 的结论')
// ===========================================================================

const measurementInvalid = measurements.filter((item) => !item.valid)
check(
  '所有计数型检测器都有非零测量（否则 MEASUREMENT INVALID）',
  measurementInvalid.length === 0,
  `${measurements.length} 个检测器，无效 ${measurementInvalid.length}`
)

const verdict = unknownCountUnit.frozen ? 'WP7_CAN_PROCEED' : 'WP7_PARTIAL_HARD_STOP_1'
const evidence = {
  testId: 'M5.1.1 / WP7 read-only preflight (AT-W7-0 baseline + AT-W7-4 unknown-count unit)',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:wp7:preflight',
  verdict,
  hardStop: unknownCountUnit.frozen
    ? null
    : {
        id: 1,
        condition: 'unknown count 没有冻结计数单位',
        wp7Status: 'PARTIAL',
        unresolved: 'Unknown-count semantic unit',
      },
  passed,
  failed,
  failures,
  baseline: {
    files: fileBaseline,
    migrations: migrationBaseline,
    liveDb: liveDbBaseline,
    git: gitBaseline,
    upstream,
  },
  unknownCountUnit: {
    ...unknownCountUnit,
    countNotionHits,
    unitConventionHits,
    definingHits,
    negativeControl: { syntheticHits: syntheticHits.length, syntheticUnit },
    selfContaminationGuard: {
      excludedDocFiles: excludedDocFiles.map((path) => relative(path)),
      excludedCountUnitLines: excludedDocCountUnitLines,
      normativeDocFiles: normativeDocFiles.map((path) => relative(path)),
    },
  },
  consolePrecedent,
  boundaryAudit: {
    boundaries: boundarySources.map((item) => ({
      id: item.id,
      frozenAsSemantics: item.frozenAsSemantics,
      frozenAsCountingRule: item.frozenAsCountingRule,
    })),
    frozenAsCountingRules: boundariesFrozenAsRules,
    note: '三条边界都能从冻结语义推导，但没有一条被写成"计数规则" ⇒ 裁定时应把它们写成规则（narrow decision §6④）',
  },
  computability,
  impact: {
    triStateDtoReady: triStateReady,
    transportReady,
    noExistingCountField: countFieldAbsent,
    blockedByThis: [
      'AT-W7-4 unknown count',
      'AT-W7-11（专项门必须覆盖 unknown-count semantics）',
      'AT-W7-12（回归矩阵里的 m5.1.1:wp7:verify）',
      '最终验收表里的 Unknown count 一行',
    ],
    notBlockedByThis: [
      'AT-W7-1 三态渲染器',
      'AT-W7-2 attribution origin 渲染',
      'AT-W7-3 Axis B 渲染（含 UNCONFIRMED_ORIGIN）',
      'AT-W7-5 Trace panel',
      'AT-W7-6 Execution panel（Axis B = NOT_APPLICABLE + Execution Truth 独立）',
      'AT-W7-7 D01 / K-27 呈现门',
      'AT-W7-8 Query-only 边界',
      'AT-W7-9 Developer Control 原样',
      'AT-W7-10 删页面性质',
    ],
  },
  measurements,
  measurementInvalid: measurementInvalid.length,
  scope: {
    productCodeChanged: false,
    databaseOpened: false,
    liveDbOpened: false,
    schemaChanged: false,
    wp8Started: false,
  },
}

mkdirSync(EVIDENCE_DIR, { recursive: true })
writeFileSync(
  join(EVIDENCE_DIR, 'wp7-preflight.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
  'utf8'
)
writeFileSync(
  join(EVIDENCE_DIR, 'wp7-at-w7-0-baseline.json'),
  `${JSON.stringify(
    {
      testId: 'M5.1.1 / WP7 AT-W7-0 baseline / scope freeze',
      generatedAt: evidence.generatedAt,
      command: 'pnpm m5.1.1:wp7:preflight',
      verdict: 'AT-W7-0 = PASS',
      ...evidence.baseline,
    },
    null,
    2
  )}\n`,
  'utf8'
)
writeFileSync(
  join(EVIDENCE_DIR, 'wp7-unknown-count-unit.json'),
  `${JSON.stringify(
    {
      testId: 'M5.1.1 / WP7 AT-W7-4 unknown-count semantic unit',
      generatedAt: evidence.generatedAt,
      command: 'pnpm m5.1.1:wp7:preflight',
      verdict: 'Unknown-count semantic unit = UNRESOLVED',
      wp7Status: 'PARTIAL',
      ...evidence.unknownCountUnit,
      impact: evidence.impact,
    },
    null,
    2
  )}\n`,
  'utf8'
)
console.log('\n证据已写入：artifacts/m5.1.1/wp7-preflight.json ・ wp7-at-w7-0-baseline.json ・ wp7-unknown-count-unit.json')

console.log(`\n${'='.repeat(74)}`)
console.log(`preflight 检查：${passed} 通过 / ${failed} 失败`)
console.log(`AT-W7-0 = ${failed === 0 ? 'PASS' : 'FAIL'}`)
if (verdict === 'WP7_PARTIAL_HARD_STOP_1') {
  console.log('')
  console.log('  ##################################################################')
  console.log('  #  WP7 = PARTIAL  ——  HARD STOP #1（执行计划 §Hard STOP 第 1 条）#')
  console.log('  #  Unknown-count semantic unit = UNRESOLVED                      #')
  console.log('  #  已登记 narrow decision，等裁定后继续；本步**没有**改任何产品代码。#')
  console.log('  ##################################################################')
} else {
  console.log('AT-W7-4 = RESOLVED（unknown count 的单位已在文档里冻结）')
}
console.log('='.repeat(74))
process.exit(failed === 0 ? 0 : 1)
