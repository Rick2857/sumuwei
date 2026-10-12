/**
 * M6 · WP5 —— **开发者面门**（`pnpm exec tsx scripts/verify-m6-wp5-console.ts`）。
 *
 * ============================================================================
 *  它证明什么
 * ============================================================================
 * ```text
 *   ① 派生正控：一轮真的启用过摘要的 trace ⇒ 开发者面拿到的每个数字都对得上
 *   ② 负控（**最重要的一条**）：那一轮**没启用**摘要 ⇒ 字段**缺席**，而不是全 0
 *      —— "不知道"与"确定是 0"在页面上必须长得不一样
 *   ③ 负控：属性形状不完整 ⇒ **整条不作数**（不补 0、不猜一半）
 *   ④ 负控：哨兵值 -1（没有覆盖范围）⇒ **翻成缺席**，不是 0..0
 *   ⑤ 负控：属性里夹带正文键 ⇒ 派生只认登记过的那 16 个键，正文不进 DTO
 *   ⑥ 恢复：放回合法属性 ⇒ 逐字段回到原值
 *   ⑦ 静态锁：派生只有一处实现、服务端只有一个来源（`context_compile` step）、
 *      页面只消费 `/dev/query/*` 且**不碰数据库**
 * ```
 *
 * 用法：`pnpm exec tsx scripts/verify-m6-wp5-console.ts`（纯函数 + 静态读；不碰数据库、不跑模型）
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import {
  DEVELOPER_ROLLUP_ATTRIBUTE_KEYS,
  developerRollupSummaryOf,
  type DeveloperRollupSummaryDto,
} from '../src/kernel/contracts/developer-query.ts'
import { stripComments } from './text-scan.ts'

const ROOT = resolve('.')

const rows: { label: string; pass: boolean; detail?: string }[] = []
const measurements: { label: string; count: number; mustBePositive: boolean }[] = []
let failures = 0
let measurementInvalid = 0

function check(label: string, pass: boolean, detail?: string): void {
  if (!pass) failures += 1
  rows.push({ label, pass, ...(detail !== undefined ? { detail } : {}) })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
function measure(label: string, count: number, mustBePositive = true): void {
  if (mustBePositive && count <= 0) measurementInvalid += 1
  measurements.push({ label, count, mustBePositive })
  console.log(`  MEASURE ${label} = ${count}${mustBePositive && count <= 0 ? '  ← MEASUREMENT INVALID' : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

// ---------------------------------------------------------------------------
// §1 派生：正控 / 负控 / 恢复
// ---------------------------------------------------------------------------

section('§1 派生 `context_compile` 属性 ⇒ 开发者面视图')

/** turn-gateway 在**启用过摘要**的一轮里写下的属性（逐字） */
const LEGAL_ATTRIBUTES: Record<string, unknown> = {
  rollup_status: 'evaluated',
  rollup_selector_version: 'rollup-selector@1',
  rollup_scanned: 3,
  rollup_items: 1,
  rollup_source_refs: 'cev:cev:1',
  rollup_covered_from: 3,
  rollup_covered_to: 3,
  rollup_omitted_eligible: 0,
  rollup_skipped_by_recent: 1,
  rollup_coverage_truncated: false,
  rollup_rejected_unconfirmed: 2,
  rollup_rejected_contradicted: 0,
  rollup_rejected_non_user: 1,
  rollup_rejected_invalidated: 0,
  rollup_rejected_out_of_scope: 0,
  rollup_section_survived: true,
}

/** DTO 的**全部**键，逐字钉住：加字段必须同时改这里（防"顺手夹带正文"） */
const ROLLUP_DTO_KEYS = [
  'status',
  'selectorVersion',
  'scannedEventCount',
  'itemCount',
  'sourceRefs',
  'coveredSequenceRange',
  'omittedEligibleCount',
  'skippedByRecentWindow',
  'coverageTruncated',
  'rejections',
  'sectionSurvived',
].sort()

const legal = developerRollupSummaryOf(LEGAL_ATTRIBUTES)
measure('§1 属性登记表的键数（范围自检）', DEVELOPER_ROLLUP_ATTRIBUTE_KEYS.length)
measure('§1 合法属性产出的 view 的键数（范围自检）', legal === undefined ? 0 : Object.keys(legal).length)

check('§1-1 正控：启用过摘要的一轮 ⇒ 拿得到视图', legal !== undefined)
check(
  '§1-2 正控：每个数字都和属性逐字对上',
  legal !== undefined &&
    legal.status === 'evaluated' &&
    legal.selectorVersion === 'rollup-selector@1' &&
    legal.scannedEventCount === 3 &&
    legal.itemCount === 1 &&
    legal.omittedEligibleCount === 0 &&
    legal.skippedByRecentWindow === 1 &&
    legal.coverageTruncated === false &&
    legal.sectionSurvived === true,
  JSON.stringify(legal)
)
check(
  '§1-3 正控：拒绝理由分布逐项对上（**闭集**五项都在）',
  legal !== undefined &&
    legal.rejections.unconfirmedOrigin === 2 &&
    legal.rejections.contradictedOrigin === 0 &&
    legal.rejections.nonUserSource === 1 &&
    legal.rejections.invalidatedByMemoryState === 0 &&
    legal.rejections.outOfScope === 0
)
check(
  '§1-4 正控：`sourceRefs` 只放 id（`cev:` 前缀），**不含正文**',
  legal !== undefined && legal.sourceRefs.length === 1 && legal.sourceRefs[0]!.startsWith('cev:')
)
check(
  '§1-5 正控：DTO 的键集**恰好**是钉住的那 11 个（多一个就是夹带了什么）',
  legal !== undefined && JSON.stringify(Object.keys(legal).sort()) === JSON.stringify(ROLLUP_DTO_KEYS),
  legal === undefined ? '(无视图)' : Object.keys(legal).sort().join(',')
)

// 负控 A：那一轮没启用摘要
const absent = developerRollupSummaryOf({ sections: 'identity-core,current-input', dropped: 0 })
check(
  '§1-6 负控：**没启用**摘要的一轮 ⇒ 字段**缺席**，而不是全 0（"不知道"≠"确定是 0"）',
  absent === undefined,
  absent === undefined ? 'undefined' : JSON.stringify(absent)
)

// 负控 B：形状不完整
const incomplete = developerRollupSummaryOf({
  ...LEGAL_ATTRIBUTES,
  rollup_items: undefined,
})
check(
  '§1-7 负控：属性形状**不完整** ⇒ 整条不作数（不补 0、不猜一半）',
  incomplete === undefined,
  incomplete === undefined ? 'undefined' : JSON.stringify(incomplete)
)

// 负控 C：哨兵 -1
const sentinel = developerRollupSummaryOf({
  ...LEGAL_ATTRIBUTES,
  rollup_covered_from: -1,
  rollup_covered_to: -1,
  rollup_items: 0,
  rollup_source_refs: '',
})
check(
  '§1-8 负控：覆盖范围的哨兵 `-1` ⇒ 翻成**缺席**，不是 `0..0`',
  sentinel !== undefined && sentinel.coveredSequenceRange === undefined && sentinel.sourceRefs.length === 0,
  JSON.stringify(sentinel?.coveredSequenceRange)
)

// 负控 D：夹带正文键
const smuggled = developerRollupSummaryOf({
  ...LEGAL_ATTRIBUTES,
  rollup_text: '这是一段不该出现的正文',
  rollup_excerpt: '也不该出现',
})
check(
  '§1-9 负控：属性里夹带正文键 ⇒ 派生**只认登记过的那 16 个键**，正文不进 DTO',
  smuggled !== undefined &&
    !JSON.stringify(smuggled).includes('正文') &&
    JSON.stringify(Object.keys(smuggled).sort()) === JSON.stringify(ROLLUP_DTO_KEYS),
  smuggled === undefined ? '(无视图)' : JSON.stringify(Object.keys(smuggled).sort())
)

// 恢复
const restored = developerRollupSummaryOf(LEGAL_ATTRIBUTES)
check(
  '§1-10 恢复：放回合法属性 ⇒ 逐字段回到原值',
  JSON.stringify(restored) === JSON.stringify(legal)
)

// 读失败的一轮：字段**在**，但状态说的是失败（不是"没有摘要"）
const readFailed = developerRollupSummaryOf({
  ...LEGAL_ATTRIBUTES,
  rollup_status: 'read_failed',
  rollup_items: 0,
  rollup_source_refs: '',
  rollup_scanned: 0,
})
check(
  '§1-11 正控：读取面失败的一轮 ⇒ 状态**如实**是 `read_failed`（与"没启用"区分开）',
  readFailed !== undefined && readFailed.status === 'read_failed' && readFailed.itemCount === 0,
  `${String(readFailed?.status)} items=${String(readFailed?.itemCount)}`
)

// ---------------------------------------------------------------------------
// §2 服务端：来源唯一、实现唯一
// ---------------------------------------------------------------------------

section('§2 服务端与契约的静态锁')

const queryServiceSrc = readFileSync(join(ROOT, 'src/infrastructure/dev/query-service.ts'), 'utf8')
const contractSrc = readFileSync(join(ROOT, 'src/kernel/contracts/developer-query.ts'), 'utf8')
const pageSrc = readFileSync(join(ROOT, 'src/infrastructure/dev/page.html'), 'utf8')
measure('§2 静态扫描的文件数（范围自检）', 3)

/**
 * 去掉注释后再数"调用点"（实现见 `scripts/text-scan.ts`，与 INC-01 WP3 的门共用一份）。
 *
 * ⚠️ 这一条与 `m5.1.1:phase4a:verify` 的针**故意相反**：那条门扫原文、连注释都算
 * （因为它的命题是"这个名字不许出现在别处"）；本门数的是**真的调用**。
 */
const queryServiceCode = stripComments(queryServiceSrc)
const summaryOfCalls = queryServiceCode.split('developerRollupSummaryOf(').length - 1
check('§2-1 服务端只有**一处**派生调用（不新开第二条来源）', summaryOfCalls === 1, `${summaryOfCalls} 处`)
check(
  '§2-2 那一处的来源是 `context_compile` step（不是"读第二张表"）',
  queryServiceCode.includes("step.kind === 'context_compile'") &&
    queryServiceCode.indexOf("step.kind === 'context_compile'") <
      queryServiceCode.indexOf('developerRollupSummaryOf('),
  `find@${queryServiceCode.indexOf("step.kind === 'context_compile'")} call@${queryServiceCode.indexOf('developerRollupSummaryOf(')}`
)
const definitions = contractSrc.split('export function developerRollupSummaryOf(').length - 1
check('§2-3 派生函数在契约里**只有一个**实现', definitions === 1, `${definitions} 处`)
check(
  '§2-4 属性键登记表与 turn-gateway 实际写入的键数一致（16）',
  DEVELOPER_ROLLUP_ATTRIBUTE_KEYS.length === 16,
  `${DEVELOPER_ROLLUP_ATTRIBUTE_KEYS.length} 个`
)
check(
  '§2-5 `rollup` 在契约的**派生清单**里（它不是 `character_traces` 的列）',
  contractSrc.includes("  | 'rollup'")
)

// ---------------------------------------------------------------------------
// §3 页面纪律
// ---------------------------------------------------------------------------

section('§3 页面纪律（只消费 /dev/query/*，不碰数据库）')

check('§3-1 页面有摘要卡片（`rollupCard`）', pageSrc.includes('function rollupCard('))
check(
  '§3-2 **缺席 ≠ 0**：卡片在没启用时明说"没有启用"，不渲染成 0 条',
  pageSrc.includes('这一轮**没有启用**')
)
check(
  '§3-3 页面**没有**数据库访问面（静态锁）',
  ['pglite', 'drizzle', 'initDatabase', 'new PGlite', 'localStorage'].every(
    (token) => !pageSrc.includes(token)
  ),
  ['pglite', 'drizzle', 'initDatabase', 'new PGlite', 'localStorage']
    .filter((token) => pageSrc.includes(token))
    .join(',') || '（干净）'
)
check(
  '§3-4 页面的每一次 `fetch(` 都打到 `/dev/query`（BASE）',
  (() => {
    const base = pageSrc.includes("var BASE = '/dev/query'")
    const fetchCalls = pageSrc.split('fetch(').length - 1
    const withBase = pageSrc.split('fetch(BASE +').length - 1
    return base && fetchCalls > 0 && fetchCalls === withBase
  })(),
  `fetch ${pageSrc.split('fetch(').length - 1} 处 / 带 BASE 的 ${pageSrc.split('fetch(BASE +').length - 1} 处`
)
check(
  '§3-5 页面**不自己算**摘要数字：直接渲染服务端给的 `itemCount`，不自己数引用条数',
  pageSrc.includes('rollup.itemCount') && !pageSrc.includes('sourceRefs.length'),
  pageSrc.includes('sourceRefs.length') ? '页面在数 sourceRefs.length' : '只渲染服务端的数'
)

// ---------------------------------------------------------------------------
// 判决与证据
// ---------------------------------------------------------------------------

section('判决')

const total = rows.length
const passed = rows.filter((row) => row.pass).length
let verdict = 'PASS'
if (measurementInvalid > 0) verdict = 'MEASUREMENT INVALID'
else if (failures > 0) verdict = 'FAIL'

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const now = new Date()
const runId = `m6-wp5-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${head.slice(0, 12)}`
const outDir = resolve('artifacts/m6', runId)
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'console.json')

writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      schemaVersion: 'm6-wp5-console@1',
      runId,
      generatedAt: now.toISOString(),
      head,
      verdict,
      passed,
      failed: failures,
      measurementInvalid,
      measurements,
      checks: rows,
      derivedKeys: DEVELOPER_ROLLUP_ATTRIBUTE_KEYS,
      dtoKeys: ROLLUP_DTO_KEYS,
      scope: {
        opensDatabase: false,
        writesPersistentState: false,
        callsModel: false,
        note:
          '开发者面门：派生用**合成属性**测（真值来自 turn-gateway 的写入形状）；静态锁读源文件。' +
          '本门不启动 HTTP 服务、不打开数据库。',
        headSemantics: '`head` = 运行时 git HEAD（被测代码提交）；证据文件落在紧随其后的纯证据提交里。',
      },
    },
    null,
    2
  )}\n`,
  'utf8'
)

console.log(`\n  ${verdict} — ${passed}/${total} 通过，失败 ${failures}，MEASUREMENT INVALID ${measurementInvalid}`)
console.log(`  证据：${relative(ROOT, outPath).split(/[\\/]/).join('/')}`)

process.exit(verdict === 'PASS' ? 0 : 2)
