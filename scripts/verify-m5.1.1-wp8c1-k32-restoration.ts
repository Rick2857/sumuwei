/**
 * M5.1.1 / WP8-C1 —— **K-32 门**（`pnpm m5.1.1:wp8c1:verify`，**只读、可反复跑**）
 *
 * 断言：永久冻结的 `artifacts/m5.1/**` 与 immutable 标签 `m5.1-complete` **逐字节一致**。
 *
 * 判据（全部机械可判）：
 *   ① 用户点名的两条路径：工作树 blob == 索引 blob == `m5.1-complete:<path>` 的 blob
 *   ② `artifacts/m5.1/**` 与 `artifacts/m4.5/**` 整体与标签无差异（**变更集为空**）
 *   ③ M5.1.1 期的 fork 证据仍在（后一次事实有正式落脚点）
 *   ④ 标签本身未被移动
 *   ⑤ 真实库 `data/pglite` 的指纹（mtime / 文件数 / 字节数）与基线一致
 *   ⑥ 语义读数：历史文件里 **没有** M5.1.1 期才出现的东西（`counts` 键、v8 期的表名）
 *
 * 三段式：
 *   正控（安静）—— 当前仓库状态 ⇒ 0 违规
 *   负控（必响）—— 把 K-32 实测到的**污染 blob id** 作为观测值注入检查器 ⇒ 必响
 *   恢复（安静）—— 去掉注入 ⇒ 重新安静
 */

import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const ART = join(ROOT, 'artifacts', 'm5.1.1')
const sh = (...a: string[]): string => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim()
const sha256 = (p: string): string => createHash('sha256').update(readFileSync(join(ROOT, p))).digest('hex')

const TAG = 'm5.1-complete'
const NAMED_PATHS = ['artifacts/m5.1/wp1-contracts.json', 'artifacts/m5.1/query-negative-control.json']
const FORKS = ['artifacts/m5.1.1/wp7-wp1-contracts.json', 'artifacts/m5.1.1/wp7-query-negative-control.json']
/** K-32 取证时实测到的污染 blob id（负控用它，而不是人造字符串） */
const KNOWN_POLLUTED: Record<string, string> = {
  'artifacts/m5.1/wp1-contracts.json': '9e8a293bee63f15bd1f669e03cfd5d1f9d3e4266',
  'artifacts/m5.1/query-negative-control.json': 'd4c3511e0df543aa6628ad004b14d30c5ddc308c',
}

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
function measure(label: string, count: number, valid = count > 0): void {
  measurements.push({ label, count, valid })
  console.log(`  · 量：${label} = ${count}${valid ? '' : '  ← MEASUREMENT INVALID'}`)
}
function dbFingerprint(dir: string): { mtime: string; files: number; bytes: number } {
  const root = join(ROOT, dir)
  const st = statSync(root)
  let files = 0
  let bytes = 0
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        files += 1
        bytes += statSync(p).size
      }
    }
  }
  walk(root)
  return { mtime: st.mtime.toISOString(), files, bytes }
}

/** 检查器（纯函数）—— 允许注入"观测到的 blob"，负控靠它 */
interface Violation {
  path: string
  observedBlobId: string
  expectedBlobId: string
  kind: 'blob-mismatch' | 'semantic-drift'
}
function findFrozenDrift(overrideObserved?: Record<string, string>): Violation[] {
  const out: Violation[] = []
  for (const p of NAMED_PATHS) {
    const expected = sh('rev-parse', `${TAG}:${p}`)
    const observed = overrideObserved?.[p] ?? sh('hash-object', p)
    if (observed !== expected) out.push({ path: p, observedBlobId: observed, expectedBlobId: expected, kind: 'blob-mismatch' })
  }
  for (const p of NAMED_PATHS) {
    if (overrideObserved?.[p] !== undefined) continue
    const text = readFileSync(join(ROOT, p), 'utf8')
    const hasCounts = text.includes('"counts"')
    const v8Table = text.includes('developer_control_events')
    if (hasCounts || v8Table) out.push({ path: p, observedBlobId: sh('hash-object', p), expectedBlobId: sh('rev-parse', `${TAG}:${p}`), kind: 'semantic-drift' })
  }
  return out
}

console.log('M5.1.1 WP8-C1 —— K-32 门：冻结证据与 immutable 标签逐字节一致')
console.log(`  canonical source = ${TAG}（tag object ${sh('rev-parse', TAG).slice(0, 8)} → commit ${sh('rev-parse', `${TAG}^{commit}`).slice(0, 8)}）`)
const dbBefore = dbFingerprint('data/pglite')

// ① 逐条 blob 相等
const rows = NAMED_PATHS.map((p) => {
  const historicalBlobId = sh('rev-parse', `${TAG}:${p}`)
  const worktreeBlobId = sh('hash-object', p)
  const indexBlobId = sh('rev-parse', `:${p}`)
  const headBlobId = sh('rev-parse', `HEAD:${p}`)
  return { path: p, historicalBlobId, worktreeBlobId, indexBlobId, headBlobId, worktreeSha256: sha256(p), equals: worktreeBlobId === historicalBlobId, indexEquals: indexBlobId === historicalBlobId, headEquals: headBlobId === historicalBlobId }
})
measure('被点名的冻结路径数', rows.length, rows.length === 2)
for (const r of rows) {
  check(`① ${r.path} 的工作树 blob == ${TAG} 的 blob`, r.equals, `worktree ${r.worktreeBlobId.slice(0, 12)}… vs tag ${r.historicalBlobId.slice(0, 12)}…`)
  check(`① ${r.path} 的索引 blob 也 == 标签 blob`, r.indexEquals, `index ${r.indexBlobId.slice(0, 12)}…`)
  check(`① ${r.path} **已提交的 HEAD** blob 也 == 标签 blob（"冻结"是仓库属性，不只是工作树）`, r.headEquals, `HEAD ${r.headBlobId.slice(0, 12)}… vs tag ${r.historicalBlobId.slice(0, 12)}…`)
}

// ② 冻结目录整体无差异
const frozenDiff = sh('diff', '--name-status', TAG, '--', 'artifacts/m5.1', 'artifacts/m4.5').split('\n').filter(Boolean)
measure('冻结目录里与标签不同的路径数', frozenDiff.length, true)
check('② `artifacts/m5.1/**` 与 `artifacts/m4.5/**` 整体与标签逐字节一致（变更集为空）', frozenDiff.length === 0, frozenDiff.join(' ; ') || '0')
const frozenFileCount = readdirSync(join(ROOT, 'artifacts/m5.1')).length + readdirSync(join(ROOT, 'artifacts/m4.5')).length
measure('冻结目录里的顶层条目数（范围自检）', frozenFileCount)

// ③ fork 证据仍在
const forks = FORKS.map((f) => ({ path: f, exists: existsSync(join(ROOT, f)), bytes: existsSync(join(ROOT, f)) ? statSync(join(ROOT, f)).size : 0 }))
measure('仍保留的 M5.1.1 期 fork 证据数', forks.filter((f) => f.exists).length, forks.filter((f) => f.exists).length === 2)
check('③ M5.1.1 期的后一次事实有正式落脚点（`wp7-*` fork 仍在）', forks.every((f) => f.exists && f.bytes > 0), forks.map((f) => `${f.path}=${String(f.bytes)}B`).join(' · '))

// ④ 标签未移动
check('④ immutable 标签未被移动', sh('rev-parse', TAG) === '2e718f38a6256330d1a72af960702f64f570efff', `rev-parse ${TAG} = ${sh('rev-parse', TAG).slice(0, 12)}…`)

// ⑤ 语义读数（历史文件里没有 M5.1.1 期才出现的东西）
const semantics = rows.map((r) => {
  const text = readFileSync(join(ROOT, r.path), 'utf8')
  const j = JSON.parse(text) as Record<string, unknown>
  return { path: r.path, passed: j.passed ?? null, tableCount: j.tableCount ?? null, rowCount: j.rowCount ?? null, generatedAt: j.generatedAt ?? null, hasCountsKey: text.includes('"counts"'), mentionsV8Table: text.includes('developer_control_events') }
})
measure('做语义读数的历史文件数', semantics.length, semantics.length === 2)
check('⑥ 历史文件里没有 `counts` 键（M5.1.1 期 DTO 才有的东西）', semantics.every((s) => !s.hasCountsKey), semantics.map((s) => `${s.path}:${String(s.hasCountsKey)}`).join(' · '))
check('⑥ 历史文件里没有 v8 期的表名（`developer_control_events`）', semantics.every((s) => !s.mentionsV8Table), semantics.map((s) => `${s.path}:${String(s.mentionsV8Table)}`).join(' · '))

// 三段式：正控 / 负控（用 K-32 实测的污染 blob） / 恢复
const positive = findFrozenDrift()
measure('正控：当前状态下的违规数', positive.length, true)
check('三段式正控：当前仓库 ⇒ 安静（0 违规）', positive.length === 0, positive.map((v) => v.path).join(', ') || '0')
const negative = findFrozenDrift(KNOWN_POLLUTED)
measure('负控：注入观测值时检出的违规数', negative.length)
check('三段式负控：注入 K-32 实测的污染 blob ⇒ 检查器**必响**', negative.length === 2 && negative.every((v) => v.kind === 'blob-mismatch'), negative.map((v) => `${v.path}(${v.kind})`).join(' ; ') || '0')
const restored = findFrozenDrift()
check('三段式恢复：去掉注入 ⇒ 重新安静', restored.length === 0, restored.map((v) => v.path).join(', ') || '0')

// ⑤ 真实库
const dbAfter = dbFingerprint('data/pglite')
check('⑤ 真实库 `data/pglite` 指纹与运行前一致（只读）', dbBefore.mtime === dbAfter.mtime && dbBefore.files === dbAfter.files && dbBefore.bytes === dbAfter.bytes, `mtime ${dbBefore.mtime} files ${dbBefore.files} bytes ${dbBefore.bytes}`)

const verdict = failed === 0 && negative.length === 2 && measurements.every((m) => m.valid) ? 'PASS' : 'FAIL'
mkdirSync(ART, { recursive: true })
writeFileSync(
  join(ART, 'wp8c1-k32-verify.json'),
  `${JSON.stringify({ testId: 'M5.1.1 / WP8-C1 K-32 gate', generatedAt: new Date().toISOString(), command: 'pnpm m5.1.1:wp8c1:verify', finding: 'K-32', verdict, passed, failed, failures, namedPaths: rows, frozenDiff, forks, semantics, threeStage: { positiveQuiet: positive.length === 0, negativeFired: negative.length, restoredQuiet: restored.length === 0 }, measurements, measurementInvalid: measurements.filter((m) => !m.valid).length, liveDb: { before: dbBefore, after: dbAfter } }, null, 2)}\n`,
  'utf8',
)
console.log(`\n${'='.repeat(78)}`)
console.log(`WP8-C1 K-32 门：${passed} 通过 / ${failed} 失败｜K-32 = ${verdict}`)
console.log('证据已写入：artifacts/m5.1.1/wp8c1-k32-verify.json')
console.log('='.repeat(78))
process.exit(verdict === 'PASS' ? 0 : 1)
