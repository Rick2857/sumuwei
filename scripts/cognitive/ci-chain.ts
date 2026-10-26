/**
 * 完整 CI 链的展开与分类（2026-10-21 · 认知能力建设计划 P0 续）
 *
 * ============================================================================
 *  它解决什么
 * ============================================================================
 *  计划 §5 末段要求：「完整收口保持项目 `pnpm m4.5:ci` 的**全部原有断言和必选门**，
 *  在仿真内串联退出 0」。
 *
 *  `m4.5:ci` 在 package.json 里是一串 `pnpm <脚本> && pnpm <脚本> && …`，
 *  而那些脚本里又有一层（`m4.5:ci` → `m4:ci` → `m3.5:ci` → `m3:ci` → …）。
 *  ⇒ 需要**递归展开**成一条**有序的门清单**。
 *
 *  ⚠️ 展开**不重新定义**这条链：它只读 package.json，
 *     所以"链上有什么"永远以 package.json 为准（改链 ⇒ 展开跟着变）。
 *
 * ============================================================================
 *  分类：哪些门会碰数据库
 * ============================================================================
 *  判据 = 该门的脚本（或它**静态 import** 的脚本）里出现了
 *  `isolateDatabase(` / `initDatabase(` / `createThinHostRuntime(` 之一。
 *
 *  ⚠️ 为什么要**静态**追 import：很多门本身只是调用一个 helper，
 *     而 helper 才开库（例如 `scripts/m4-harness.ts` 里就有 `initDatabase`）。
 *     只看入口文件会把它判成"不碰库" ⇒ 那道门就会在**没有隔离目标**的情况下
 *     去开库 ⇒ 撞上 `postgres_isolation_not_provided`（失败关闭，这是对的，
 *     但那时读数会变成"门坏了"而不是"没给隔离目标"）。
 * ============================================================================
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)))

export interface CiGate {
  /** 链上那个 pnpm 脚本名（一个脚本名可能展开出**多道**门） */
  name: string
  /** 这一步的命令（逐字，来自 package.json 的一段） */
  command: string
  /** 门体脚本（相对仓库根）；`tsc` 这类没有脚本文件的用 undefined */
  script?: string
  /** 该门会碰数据库吗 */
  touchesDatabase: boolean
  /** 命中"碰库"判据的位置（可追溯） */
  evidence: string[]
}

/**
 * 必须**逐场景**跑的门（按门体脚本路径）。
 *
 * ⚠️ 判据 = 这道门在一个进程里跑**多个场景**，并假设**每个场景从空白库开始**
 *    ⇒ PostgreSQL 下必须逐场景子进程（见 `scripts/postgresql/scenario-gate.ts`）。
 *
 * ⚠️ 这份清单是**显式**的（不是自动探测）：自动探测要对每道门跑一次
 *    `--list-cases`，而**不认这个参数的门会把整道门跑一遍**（白跑一次，
 *    还可能顺手开一次库）⇒ 不划算，也不安全。
 */
export const SCENARIO_GATES: readonly string[] = [
  'scripts/eval-m3.ts',
  'scripts/eval-scenarios.ts',
  'scripts/verify-m4-mutation-safety.ts',
  'scripts/verify-m4-nl-mutation.ts',
  'scripts/verify-m4-restore.ts',
]

const scripts = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {}

/** 门体脚本路径（`tsx scripts/x.ts` 形状）；取不到就是 undefined */
function scriptOf (command: string): string | undefined {
  const match = /^tsx\s+(scripts\/[A-Za-z0-9._\/-]+\.ts)$/.exec(command.trim())
  return match?.[1]
}

/**
 * 展开一条链（递归）。
 *
 * ⚠️ **按 `&&` 切段**：一条脚本条目可能是复合的
 *    （`m4.5:audit` = `tsx scripts/m4.5-audit.ts && pnpm capability:audit`），
 *    而**两段的底座不一样**（前者碰库、后者不碰）⇒ 必须切开逐段处理。
 *    只看整条命令会把其中一段**静默丢掉**。
 *
 * ⚠️ **去重但保序**：同一个脚本名在链上出现两次只展开一次（第一次）。
 */
export function expandChain (entry: string, seen = new Set<string>(), out: CiGate[] = []): CiGate[] {
  if (seen.has(entry)) return out
  seen.add(entry)
  const command = scripts[entry]
  if (command === undefined) return out
  for (const segment of command.split('&&').map(part => part.trim()).filter(part => part !== '')) {
    const reference = /^pnpm\s+([A-Za-z0-9:._-]+)$/.exec(segment)
    if (reference !== null) {
      expandChain(reference[1]!, seen, out)
      continue
    }
    const script = scriptOf(segment)
    const { touchesDatabase, evidence } = script === undefined
      ? { touchesDatabase: false, evidence: [] as string[] }
      : inspectDatabaseUsage(script)
    out.push({
      name: entry,
      command: segment,
      ...(script === undefined ? {} : { script }),
      touchesDatabase,
      evidence,
    })
  }
  return out
}

const DB_MARKERS = ['isolateDatabase(', 'initDatabase(', 'createThinHostRuntime(']

/** 静态追 import，找出会碰库的门 */
export function inspectDatabaseUsage (entryScript: string): { touchesDatabase: boolean; evidence: string[] } {
  const evidence: string[] = []
  const visited = new Set<string>()
  const queue: string[] = [entryScript]
  const repoPrefix = REPO.replace(/\\/g, '/') + '/'
  while (queue.length > 0) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)
    const path = join(REPO, current)
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    for (const marker of DB_MARKERS) {
      if (text.includes(marker)) evidence.push(`${current}: ${marker}`)
    }
    // 追本仓库内的相对 import（`'./x.ts'` / `'../y/z.ts'`）—— 按**导入文件自己的目录**解析
    const base = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : ''
    for (const match of text.matchAll(/from\s+'(\.\.?\/[^']+)\.ts'/g)) {
      const resolved = resolve(REPO, base, `${match[1]!}.ts`).split('\\').join('/')
      const relative = resolved.startsWith(repoPrefix) ? resolved.slice(repoPrefix.length) : ''
      if (relative.startsWith('src/') || relative.startsWith('scripts/') || relative.startsWith('evals/')) {
        queue.push(relative)
      }
    }
  }
  return { touchesDatabase: evidence.length > 0, evidence }
}

/** 完整链（默认 `m4.5:ci`） */
export function fullCiChain (entry = 'm4.5:ci'): CiGate[] {
  return expandChain(entry)
}
