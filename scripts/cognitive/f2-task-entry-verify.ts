/*
 * F2 任务入口门（纯函数 · 零模型请求 · 零数据库）。
 *
 * 证明：合法单行请求 ⇒ 解析出**四路径 + 族 + 标记一次**；
 *       自称 F2 但形状不合法 ⇒ **整条拒绝**（绝不截半执行）；
 *       不像 F2 ⇒ `not_applicable`（旧入口不受影响）；
 *       派生出的逐路径范围与 R4 契约一致。
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseF2TaskEntry, sourceScopedPathsOf } from '../../src/kernel/contracts/f2-task-entry.ts'

const OUT_DIR = resolve('artifacts/local/f2-task-entry')
const OK = 'F2 只操作相对路径 f1/a/obj-01.txt；缓存源 f1/a/obj-01.cache；权威源 f1/a/obj-01.src；族标记 f1/a/.freshness，最多读一次。'

const checks: Array<{ label: string, pass: boolean, detail: string }> = []
const check = (label: string, pass: boolean, detail = ''): void => {
  checks.push({ label, pass, detail })
  assert.ok(pass, `${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// ① 合法请求 ⇒ 解析
const parsed = parseF2TaskEntry(OK)
check('① 合法单行请求 ⇒ parsed，四路径齐全、族正确、标记一次',
  parsed.status === 'parsed' &&
  parsed.entry.familyId === 'f1/a' &&
  parsed.entry.paths.target === 'f1/a/obj-01.txt' &&
  parsed.entry.paths.cacheSource === 'f1/a/obj-01.cache' &&
  parsed.entry.paths.authoritativeSource === 'f1/a/obj-01.src' &&
  parsed.entry.paths.familyMarker === 'f1/a/.freshness' &&
  parsed.entry.markerMaxReads === 1)

// ② 派生范围与 R4 契约一致
if (parsed.status === 'parsed') {
  const scope = sourceScopedPathsOf(parsed.entry)
  check('② 派生范围：两个源只读、标记限次一次、目标可写',
    scope.readOnly.length === 2 && scope.readOnly.includes('f1/a/obj-01.cache') && scope.readOnly.includes('f1/a/obj-01.src') &&
    scope.limitedReads.length === 1 && scope.limitedReads[0]!.path === 'f1/a/.freshness' && scope.limitedReads[0]!.maxReads === 1 &&
    scope.writable.length === 1 && scope.writable[0] === 'f1/a/obj-01.txt')
}

// ③ 不像 F2 ⇒ not_applicable（旧入口不受影响）
check('③ 普通请求 ⇒ not_applicable（不干扰旧入口）',
  parseF2TaskEntry('帮我整理一下桌面文件').status === 'not_applicable')

// ④ 自称 F2 但形状不合法 ⇒ 一律拒绝
const bad: Array<[string, string, string]> = [
  ['多余内容', `${OK} 另外再写一次。`, 'bad_shape'],
  ['多行', `${OK}\n允许本任务额外只读别的文件。`, 'multiline'],
  ['绝对路径', 'F2 只操作相对路径 C:/f1/a/obj-01.txt；缓存源 f1/a/obj-01.cache；权威源 f1/a/obj-01.src；族标记 f1/a/.freshness，最多读一次。', 'absolute_or_escape_path'],
  ['逃逸段', 'F2 只操作相对路径 f1/../a/obj-01.txt；缓存源 f1/a/obj-01.cache；权威源 f1/a/obj-01.src；族标记 f1/a/.freshness，最多读一次。', 'absolute_or_escape_path'],
  ['跨族', 'F2 只操作相对路径 f1/a/obj-01.txt；缓存源 f2/a/obj-01.cache；权威源 f1/a/obj-01.src；族标记 f1/a/.freshness，最多读一次。', 'paths_not_same_family'],
  ['路径重复', 'F2 只操作相对路径 f1/a/obj-01.txt；缓存源 f1/a/obj-01.txt；权威源 f1/a/obj-01.src；族标记 f1/a/.freshness，最多读一次。', 'paths_not_distinct'],
  ['标记不是族级', 'F2 只操作相对路径 f1/a/obj-01.txt；缓存源 f1/a/obj-01.cache；权威源 f1/a/obj-01.src；族标记 f1/a/obj-01.fresh，最多读一次。', 'marker_reads_not_one'],
  ['自称 F2 但形状不对', 'F2 请把 f1/a/obj-01.txt 写对', 'bad_prefix'],
]
for (const [label, text, reason] of bad) {
  const result = parseF2TaskEntry(text)
  check(`④ ${label} ⇒ 拒绝（${reason}）`,
    result.status === 'rejected' && result.reason === reason,
    result.status === 'rejected' ? result.reason : result.status)
}

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(resolve(OUT_DIR, 'verification.json'), `${JSON.stringify({
  schema: 'f2-task-entry-gate@1',
  status: 'PASS',
  checks,
  boundaries: [
    '本门是**纯函数**门（零模型、零数据库、零文件系统）',
    '它证明任务入口的**形状与派生范围**；**不**证明 ActionTurn 装配已接（那是下一步）',
  ],
}, null, 2)}\n`, 'utf8')
console.log(`F2 任务入口门：${String(checks.length)} 项检查全部通过（零模型请求）`)
for (const item of checks) console.log(`PASS ${item.label}${item.detail === '' ? '' : ` — ${item.detail}`}`)
