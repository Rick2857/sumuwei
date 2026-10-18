/**
 * A1 / **WP6：聚合读数 runner**（`pnpm a1:gates`）。
 *
 * ============================================================================
 *  它做什么、不做什么
 * ============================================================================
 * ```text
 * 做：读 `evals/a1/gate-map.json`（契约六门 ↔ 切片门），**按契约门分组**逐门跑，
 *     逐门打印「EXIT 码 + 判据数/失败数」，并把 **NOT RUN（exit 2）/ 未通过（exit 1）/ 通过** 分列。
 * 不做：**不合成总分**（本仓库对"一个分数盖住分列事实"零容忍）；不代替各门自己的读数；
 *     不主张 A1 已交付（生产激活需独立授权）。
 * ⚠️ `A1-G6`（核心停机窗口）在映射里**如实留空** ⇒ 本 runner 会照实打印"0 道"。
 * ⚠️ 个别门需要**无 `.env` 的 cwd**（目录沙箱门）：在下面的 `NEEDS_ENV_FREE_CWD` 里**具名列出**，
 *    它们会用「临时 cwd + 钉死后端」跑；**不**把它们报成红（那是环境要求，不是失败）。
 * ```
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_GATES } from './gates/manifest.ts'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const TSX = resolve(ROOT, 'node_modules/tsx/dist/cli.mjs')

/** 需要**无 `.env` 的 cwd**（目录沙箱门）——具名列出，不靠猜 */
const NEEDS_ENV_FREE_CWD: readonly string[] = ['a1:jobs-store:verify']

interface ContractGate { id: string; title: string; servedBy: readonly string[]; emptyReason?: string }
const gateMap = JSON.parse(readFileSync(resolve(ROOT, 'evals/a1/gate-map.json'), 'utf8')) as { contractGates: ContractGate[] }

const entryOf = (id: string): string | undefined => ALL_GATES.find((gate) => gate.id === id)?.entry

const runGate = (id: string): { exit: number | null; summary: string } => {
  const entry = entryOf(id)
  if (entry === undefined) return { exit: null, summary: '(不在门表里)' }
  const needsFree = NEEDS_ENV_FREE_CWD.includes(id)
  const cwd = needsFree ? mkdtempSync(join(tmpdir(), 'a1-gates-')) : ROOT
  const env = needsFree
    ? {
        ...process.env,
        CHARACTER_DB_BACKEND: 'pglite',
        POSTGRES_URL: '',
        DATABASE_URL: '',
        PGLITE_DATA_DIR: '',
        PROJECT_LG_SANDBOX: '',
        LG_PG_EXPECT_DATABASE: '',
      }
    : process.env
  const result = spawnSync(process.execPath, [TSX, resolve(ROOT, entry)], {
    cwd, env, encoding: 'utf8', timeout: 900_000, windowsHide: true,
  })
  const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const summary = /判据 (\d+) · 失败 (\d+)/.exec(out)?.[0] ?? (result.status === 2 ? '(具名 NOT RUN)' : '')
  return { exit: result.status ?? null, summary }
}

let passed = 0
let failed = 0
let notRun = 0
console.log('A1 聚合读数（按契约 §7 的六个门分组 · **分列，不合成总分**）\n')
for (const gate of gateMap.contractGates) {
  if (gate.servedBy.length === 0) {
    console.log(`== ${gate.id} ${gate.title} ==`)
    console.log(`   0 道 —— **如实留空**：${gate.emptyReason ?? '(未写理由)'}`)
    continue
  }
  console.log(`== ${gate.id} ${gate.title} ==`)
  for (const id of gate.servedBy) {
    const { exit, summary } = runGate(id)
    const mark = exit === 0 ? 'PASS' : exit === 2 ? 'NOT RUN' : exit === null ? '未登记' : 'FAIL'
    if (exit === 0) passed += 1
    else if (exit === 2) notRun += 1
    else failed += 1
    console.log(`   ${mark.padEnd(8)} ${id.padEnd(32)} exit=${String(exit)}  ${summary}`)
  }
}
console.log(
  `\n合计：**通过 ${passed} · 未运行 ${notRun} · 未通过 ${failed}**（另有 A1-G6 无机器判据，不计入）`
)
console.log('⚠️ 本 runner **不**主张 A1 已交付：生产激活需独立授权；live 档（`a1:serve:db:live:verify`）另计。')
if (failed > 0) process.exit(1)
