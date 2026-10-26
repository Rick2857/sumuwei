/**
 * 认知能力建设 · **混合树源码指纹**（2026-10-21 · 计划 P0 §3.1）
 *
 * ============================================================================
 *  为什么需要它
 * ============================================================================
 *  计划 §3.1 逐字要求：
 *
 *      「记录当前工作树、在途改动归属、依赖锁文件与待测源码指纹。
 *        共享工作树只提交本批拥有的路径，镜像记录实际内容，
 *        **不用 HEAD 代替混合树指纹**。」
 *
 *  为什么 HEAD 不够：本工作区是**混合树**（多批在途改动共存），
 *  `git log -1` 给出的是**最后一次提交**，与"镜像里跑的那份代码"可能毫无关系。
 *  ⇒ 验收记录里写的"源码版本"如果只写 HEAD sha，等于**没有记录**。
 *
 * ============================================================================
 *  它算什么
 * ============================================================================
 *  指纹 = 对**待测范围内的每个文件**（相对路径 + 内容 sha256）排序后，
 *  拼成一行行 `path\tsha256` 再做一次 sha256。
 *
 *  · **不含** `node_modules/` / `artifacts/` / `data/` / `.git/` / `docs/`
 *    （前三个不是源码；docs 是论述，不进"待测代码"指纹）。
 *  · **含** `src/` `scripts/` `evals/` `tools/` `serversim/` 与根配置文件。
 *  · 改动**任何一个字节** ⇒ 指纹变。
 *  · 在途改动（未提交）**照样计入** —— 这正是"混合树指纹"与 HEAD 的区别。
 *
 * ============================================================================
 *  用法
 * ============================================================================
 *  ```bash
 *  pnpm cognitive:fingerprint                     # 打到终端
 *  pnpm cognitive:fingerprint -- --out <path>     # 另存一份 JSON
 *  pnpm cognitive:fingerprint -- --own a/b.ts c/d.ts   # 登记"本批拥有的路径"
 *  ```
 * ============================================================================
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)))

/** 计入指纹的目录（相对仓库根） */
const SOURCE_DIRS = ['src', 'scripts', 'evals', 'tools', 'serversim']
/** 计入指纹的根文件 */
const SOURCE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json']
/** 永远排除的目录名（任何层级） */
const EXCLUDED_DIRS = new Set(['node_modules', 'artifacts', 'data', '.git', 'dist', 'coverage'])

function sha256 (buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function collect (dir: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries.sort()) {
    const full = join(dir, entry)
    let stats
    try {
      stats = statSync(full)
    } catch {
      continue
    }
    if (stats.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue
      collect(full, out)
      continue
    }
    if (!stats.isFile()) continue
    out.push(full)
  }
}

/** git 读数（读不到就如实留空，不猜） */
function git (args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

const files: string[] = []
for (const dir of SOURCE_DIRS) {
  const full = join(REPO, dir)
  if (existsSync(full)) collect(full, files)
}
for (const file of SOURCE_FILES) {
  const full = join(REPO, file)
  if (existsSync(full)) files.push(full)
}

const entries = files
  .map(full => {
    const rel = relative(REPO, full).split('\\').join('/')
    return { path: rel, sha256: sha256(readFileSync(full)) }
  })
  .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

const fingerprint = sha256(Buffer.from(entries.map(e => `${e.path}\t${e.sha256}`).join('\n'), 'utf8'))

const statusLines = (git(['status', '--porcelain=v1']) ?? '').split(/\r?\n/).filter(line => line !== '')
const counts = { modified: 0, deleted: 0, added: 0, renamed: 0, untracked: 0, other: 0 }
for (const line of statusLines) {
  const code = line.slice(0, 2)
  if (code === '??') { counts.untracked += 1; continue }
  if (code.includes('D')) { counts.deleted += 1; continue }
  if (code.includes('M')) { counts.modified += 1; continue }
  if (code.includes('A')) { counts.added += 1; continue }
  if (code.includes('R')) { counts.renamed += 1; continue }
  counts.other += 1
}

const ownIndex = process.argv.indexOf('--own')
const own = ownIndex >= 0 ? process.argv.slice(ownIndex + 1).filter(arg => !arg.startsWith('--')) : []
const outIndex = process.argv.indexOf('--out')
const outPath = outIndex >= 0 ? process.argv[outIndex + 1] : undefined

const record = {
  generatedAt: new Date().toISOString(),
  head: git(['rev-parse', 'HEAD']) ?? null,
  headSubject: git(['log', '-1', '--format=%s']) ?? null,
  branch: git(['branch', '--show-current']) ?? null,
  /** ⚠️ 混合树指纹：覆盖**未提交**的在途改动 */
  sourceFingerprint: fingerprint,
  sourceFileCount: entries.length,
  scope: { dirs: SOURCE_DIRS, files: SOURCE_FILES, excludedDirs: [...EXCLUDED_DIRS] },
  lockfileSha256: existsSync(join(REPO, 'pnpm-lock.yaml'))
    ? sha256(readFileSync(join(REPO, 'pnpm-lock.yaml')))
    : null,
  workingTree: { total: statusLines.length, ...counts },
  /** 本批拥有的路径（计划 §3.1：共享工作树只提交本批拥有的路径） */
  ownedByBatch: own,
}

if (outPath !== undefined) {
  writeFileSync(resolve(outPath), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}

console.log('─'.repeat(78))
console.log('认知能力建设 · 混合树源码指纹')
console.log('─'.repeat(78))
console.log(`  HEAD            : ${record.head ?? '(读不到)'}  ${record.headSubject ?? ''}`)
console.log(`  分支            : ${record.branch ?? '(读不到)'}`)
console.log(`  工作树          : 共 ${String(record.workingTree.total)} 条在途改动` +
  `（M ${String(record.workingTree.modified)} · D ${String(record.workingTree.deleted)} · ?? ${String(record.workingTree.untracked)}）`)
console.log(`  锁文件 sha256   : ${record.lockfileSha256 ?? '(无)'}`)
console.log(`  待测文件数      : ${String(record.sourceFileCount)}`)
console.log(`  源码指纹        : ${record.sourceFingerprint}`)
console.log(`  本批拥有路径    : ${own.length === 0 ? '(未登记)' : own.join(', ')}`)
console.log('  ⚠️ 这个指纹覆盖**未提交**的在途改动 ⇒ 它与 HEAD 是两件事。')
console.log('─'.repeat(78))
