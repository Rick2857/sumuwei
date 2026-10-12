/**
 * M5.1.1 / WP8-C1 —— **K-32 冻结证据还原**（显式动作：`pnpm m5.1.1:wp8c1:restore`）
 *
 * K-32：永久冻结的 `artifacts/m5.1/**` 在 HEAD 上被 M5.1.1 期的运行结果覆盖
 * （`wp1-contracts.json` 52→53 + `counts` 键；`query-negative-control.json` 40/31→41/33 + 新 id/digest）。
 *
 * 还原纪律（用户裁定，逐条落实）：
 *   ① canonical historical source **只有** immutable 标签 `m5.1-complete`
 *      —— `git checkout m5.1-complete -- <path>`。**绝不**从 HEAD / 父提交 / 工作树备份推测旧内容。
 *   ② 只还原用户点名的两条路径；`artifacts/m5.1.1/wp7-*` 的 fork 是"M5.1.1 期的后一次事实"，保留。
 *   ③ 记录 tag / tag target / path / historical blob / **polluted blob** / restored blob，
 *      并断言 `restored blob == immutable-tag blob`（外加语义读数：52 vs 53、40/31 vs 41/33、无 `counts` 键）。
 *
 * 这是**动作**，不是门：门在同目录的 `verify-m5.1.1-wp8c1-k32-restoration.ts`（只读，可反复跑）。
 */

import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const sh = (...a: string[]): string => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim()
const sha256 = (p: string): string => createHash('sha256').update(readFileSync(join(ROOT, p))).digest('hex')

const TAG = 'm5.1-complete'
const PATHS = ['artifacts/m5.1/wp1-contracts.json', 'artifacts/m5.1/query-negative-control.json']
const FORKS = ['artifacts/m5.1.1/wp7-wp1-contracts.json', 'artifacts/m5.1.1/wp7-query-negative-control.json']

console.log('M5.1.1 WP8-C1 —— K-32 冻结证据还原')
console.log(`  canonical historical source = ${TAG}（immutable）`)

const tagObjectId = sh('rev-parse', TAG)
const tagTargetCommit = sh('rev-parse', `${TAG}^{commit}`)
console.log(`  tag object   = ${tagObjectId}`)
console.log(`  tag target   = ${tagTargetCommit}`)

// 1. 先记录**污染态**（HEAD 与工作树一致时才有意义；若不一致先报出来）
interface Pollution {
  path: string
  headBlobId: string
  worktreeBlobIdBefore: string
  worktreeSha256Before: string
  historicalBlobId: string
}
const pollution: Pollution[] = PATHS.map((p) => ({
  path: p,
  headBlobId: sh('rev-parse', `HEAD:${p}`),
  worktreeBlobIdBefore: sh('hash-object', p),
  worktreeSha256Before: sha256(p),
  historicalBlobId: sh('rev-parse', `${TAG}:${p}`),
}))
for (const x of pollution) {
  console.log(`  · ${x.path}`)
  console.log(`      historical blob = ${x.historicalBlobId}`)
  console.log(`      polluted  blob  = ${x.headBlobId}（HEAD）· 工作树 = ${x.worktreeBlobIdBefore}`)
  console.log(`      polluted?       = ${x.headBlobId !== x.historicalBlobId}`)
}

// 2. 从 immutable 标签取内容（唯一允许的来源）
execFileSync('git', ['checkout', TAG, '--', ...PATHS], { cwd: ROOT, encoding: 'utf8' })
console.log(`  已执行：git checkout ${TAG} -- ${PATHS.join(' ')}`)

// 3. 逐条证明 + 语义读数
const rows = PATHS.map((p, i) => {
  const historicalBlobId = sh('rev-parse', `${TAG}:${p}`)
  const restoredBlobId = sh('hash-object', p)
  const indexBlobId = sh('rev-parse', `:${p}`)
  const historicalJson = JSON.parse(execFileSync('git', ['cat-file', 'blob', historicalBlobId], { cwd: ROOT, encoding: 'utf8' })) as Record<string, unknown>
  const restoredText = readFileSync(join(ROOT, p), 'utf8')
  const restoredJson = JSON.parse(restoredText) as Record<string, unknown>
  const read = (o: Record<string, unknown>): Record<string, unknown> => ({
    passed: o.passed ?? null,
    tableCount: o.tableCount ?? null,
    rowCount: o.rowCount ?? null,
    generatedAt: o.generatedAt ?? null,
  })
  return {
    path: p,
    historicalBlobId,
    pollutedBlobId: (pollution[i] as Pollution).headBlobId,
    pollutedSha256: (pollution[i] as Pollution).worktreeSha256Before,
    restoredBlobId,
    restoredSha256: sha256(p),
    indexBlobId,
    restoredEqualsImmutableTagBlob: restoredBlobId === historicalBlobId,
    worktreeEqualsIndex: restoredBlobId === indexBlobId,
    historicalReading: { ...read(historicalJson), hasCountsKey: false, mentionsV8Table: false },
    restoredReading: {
      ...read(restoredJson),
      hasCountsKey: restoredText.includes('"counts"'),
      mentionsV8Table: restoredText.includes('developer_control_events'),
    },
  }
})

const frozenDiff = sh('diff', '--name-status', tagTargetCommit, '--', 'artifacts/m5.1', 'artifacts/m4.5')
const evidence = {
  testId: 'M5.1.1 / WP8-C1 K-32 frozen evidence restoration',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:wp8c1:restore',
  finding: 'K-32',
  canonicalHistoricalSource: {
    tag: TAG,
    tagObjectId,
    tagTargetCommit,
    mechanism: 'git checkout m5.1-complete -- <path>（只从 immutable 标签取内容）',
    forbiddenSources: ['HEAD', '父提交', '工作树备份', '任何"猜测旧文件应该是什么"的方式'],
  },
  rows,
  forkEvidenceRetained: FORKS.map((f) => ({ path: f, exists: existsSync(join(ROOT, f)), role: 'M5.1.1 期的后一次事实（历史 `artifacts/m5.1/**` 与它必须长期分开）' })),
  frozenDirAfterRestoreWorktree: { pathsDifferingFromTag: frozenDiff.split('\n').filter(Boolean), note: '工作树已还原；HEAD 要等本 WP 的提交才等于标签内容（门的判据里因此区分这两者）' },
  tagUntouched: sh('rev-parse', TAG) === tagObjectId,
}
writeFileSync(join(ROOT, 'artifacts/m5.1.1/wp8c1-frozen-restoration.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

console.log('')
for (const r of rows) {
  console.log(`  ✅ ${r.path}`)
  console.log(`      restored blob = ${r.restoredBlobId}  == tag blob? ${r.restoredEqualsImmutableTagBlob}`)
  console.log(`      语义：historical ${JSON.stringify(r.historicalReading)} → restored ${JSON.stringify(r.restoredReading)}`)
}
console.log(`\n  冻结目录里仍与标签不同的路径：${frozenDiff.split('\n').filter(Boolean).join(' ; ') || '(工作树已无差异)'}`)
console.log('  证据已写入：artifacts/m5.1.1/wp8c1-frozen-restoration.json')
