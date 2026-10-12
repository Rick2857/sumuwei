/**
 * 内容键缓存（Tier 3）—— **只在快车道使用**，发布档一律拒绝。
 *
 * ============================================================================
 *  为什么缓存是这套改造里**最危险**的一件东西
 * ============================================================================
 * 这个仓库已经写死了一条教训（`AGENTS.md` §6.8 / §6.9）：
 * **"检查了 0 项、发现 0 处不一致"与"全部一致"在输出上长得一样。**
 * 缓存是同一类失败模式的最坏形态：**键漏掉了一个输入 ⇒ 一个真红的门被报成绿**，
 * 而且它看起来完全正常。
 *
 * 所以这里的设计原则是**失败关闭 + 只覆盖"确定没变"的部分**：
 *   ① 只有快车道（`--mode fast`）才会读缓存；发布档**拒绝** `--cache`（在 CLI 层校验）。
 *   ② 只有 `parallel: 'safe'` 且不碰真实库、不碰 `data/` 的门才可缓存。
 *   ③ 键 = **近似输入闭包的内容哈希**（不是"文件 mtime"、不是"git HEAD"）：
 *      从入口脚本出发，沿**相对 import** 递归收集，再叠加：
 *        · 脚本里字面出现的 `evals/` / `docs/` ⇒ 把整棵目录纳入（宁可粗，不可漏）
 *        · 配置盐：`package.json` / `pnpm-lock.yaml` / `tsconfig.json` / node 版本 / tsx 版本
 *      出现**非字面量动态 import** ⇒ 闭包不可信 ⇒ 退化为"全仓输入"。
 *   ④ 只复用**成功**的读数（`exitCode === 0`）。失败从不入缓存：
 *      否则"改了代码把红的修绿"会被缓存的旧红挡住，或者更糟——旧绿挡住新的红。
 *   ⑤ 复用在报告里永远标成 `CACHED`（并写出被复用的那次运行时间），
 *      这样"这一格是这次真跑的"与"这一格是复用的"在人眼下不可混淆。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import type { GateSpec } from './types.ts'

export interface CacheEntry {
  gateId: string
  key: string
  exitCode: number
  seconds: number
  /** 这条读数是什么时候、以什么档位产生的（复用时要如实转述）。 */
  recordedAt: string
  recordedMode: 'fast'
  scope: InputScope
  filesHashed: number
}

export type InputScope = 'closure' | 'repo'

export interface InputKey {
  key: string
  filesHashed: number
  scope: InputScope
  /** 人读的来源说明（进 run.json，便于复核"这个键到底覆盖了什么"）。 */
  detail: string
}

const CONFIG_SALT_FILES = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json']

/** 配置盐：与包管理器/编译器的行为有关、但不在入口闭包里的东西。 */
export function configSalt(root: string): string {
  const hash = createHash('sha256')
  for (const rel of CONFIG_SALT_FILES) {
    const p = join(root, rel)
    hash.update(rel)
    hash.update(existsSync(p) ? readFileSync(p) : Buffer.from('<missing>'))
  }
  hash.update(`node=${readNodeVersion()}`)
  hash.update(`tsx=${readTsxVersion(root)}`)
  return hash.digest('hex')
}

function readNodeVersion(): string {
  return process.version
}

function readTsxVersion(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'node_modules', 'tsx', 'package.json'), 'utf8')) as {
      version?: string
    }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unreadable'
  }
}

function walkFiles(abs: string, out: string[], cap = 20000): void {
  if (out.length >= cap) return
  let entries: string[]
  try {
    entries = readdirSync(abs)
  } catch {
    return
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git') continue
    const p = join(abs, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walkFiles(p, out, cap)
    else if (st.isFile()) out.push(p)
    if (out.length >= cap) return
  }
}

/** 沿**相对 import** 递归收集输入文件（近似闭包）。 */
export function inputClosure(
  root: string,
  entryRel: string
): { files: string[]; scope: InputScope; reason: string } {
  const entry = resolve(root, entryRel)
  if (!existsSync(entry)) {
    return { files: [], scope: 'repo', reason: `入口不存在：${entryRel} ⇒ 退化为全仓输入` }
  }
  const seen = new Set<string>([entry])
  const queue = [entry]
  /** 已经整棵纳入的目录（同一目录只走一次：否则 `files.length` 会被重复 push 灌水）。 */
  const extrasWalked = new Set<string>()
  const extras: string[] = []
  let dynamic = false

  while (queue.length > 0) {
    const file = queue.shift()
    if (file === undefined) break
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    // 非字面量动态 import ⇒ 闭包不可信。
    if (/\bimport\s*\(\s*[^'"\s)]/.test(text)) dynamic = true
    const specs: string[] = []
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      if (m[1] !== undefined) specs.push(m[1])
    }
    for (const s of specs) {
      const resolved = resolveImport(file, s)
      if (resolved !== undefined && !seen.has(resolved)) {
        seen.add(resolved)
        queue.push(resolved)
      }
    }
    // 脚本里字面提到 evals/ 或 docs/ ⇒ 把整棵目录纳入（fixture 常是拼路径读的，
    // 靠正则提不干净）。宁可粗，不可漏。同一目录只走一次。
    if (/(['"`]|\/)evals\//.test(text)) extras.push(join(root, 'evals'))
    if (/(['"`]|\/)docs\//.test(text)) extras.push(join(root, 'docs'))
  }

  const files = [...seen]
  for (const dir of extras) {
    if (extrasWalked.has(dir)) continue
    extrasWalked.add(dir)
    walkFiles(dir, files)
  }
  const unique = new Set(files).size
  const scope: InputScope = dynamic ? 'repo' : 'closure'
  return {
    files,
    scope,
    reason: dynamic
      ? '入口闭包里出现非字面量 import() ⇒ 闭包不可信，退化为全仓输入'
      : `相对 import 闭包（去重后 ${unique} 个文件${extrasWalked.size > 0 ? '，含 evals/ 或 docs/ 整棵' : ''}）`,
  }
}

function resolveImport(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined
  const base = resolve(dirname(fromFile), spec)
  for (const cand of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand
  }
  return undefined
}

function hashFileSet(root: string, files: readonly string[]): { digest: string; count: number } {
  const sorted = [...new Set(files)].map((f) => resolve(f)).sort()
  const hash = createHash('sha256')
  let count = 0
  for (const abs of sorted) {
    const rel = relative(root, abs).replace(/\\/g, '/')
    hash.update(rel)
    try {
      hash.update(readFileSync(abs))
      count += 1
    } catch {
      hash.update('<unreadable>')
    }
  }
  return { digest: hash.digest('hex'), count }
}

function repoFiles(root: string): string[] {
  const files: string[] = []
  for (const rel of ['src', 'scripts', 'evals', 'docs']) walkFiles(join(root, rel), files)
  for (const rel of CONFIG_SALT_FILES) {
    const p = join(root, rel)
    if (existsSync(p)) files.push(p)
  }
  return files
}

/**
 * 离线链的**输入指纹** —— "这一段跑门期间源码有没有被改过"的机器判据。
 *
 * 用途见 `scripts/inc-01-regression.ts` 的 Tier 1 复用：只有"源码树逐字没变"
 * 才允许把 `m4.5:ci` 的离线段复用给后面的 `m4.5:ci:full`。
 *
 * 覆盖：`src/**`、`scripts/**`、`evals/**`（**去掉**生成物目录）+ 配置文件。
 *   · 为什么去掉 `evals/m4/promptfoo/`：那是 `build-m4-promptfoo-config` **每一步都会重写**
 *     的生成物；把它算进去会让指纹"每次都变"，复用判定永远失效
 *     （第一版实测踩到：指纹在两次采样之间稳定地变了，原因就是这个目录）。
 *   · 为什么**不含** `artifacts/**`、`docs/**`、`data/**`：前两者不是本链的输入
 *     （`data/**` 更敏感——它连 git 都看不见，见 AGENTS.md §7）。
 */
export const OFFLINE_INPUT_EXCLUDES: readonly string[] = ['evals/m4/promptfoo/']

export function sourceTreeKey(root: string): { key: string; files: number; detail: string } {
  const collected: string[] = []
  for (const rel of ['src', 'scripts', 'evals']) walkFiles(join(root, rel), collected)
  const kept = collected.filter((abs) => {
    const rel = relative(root, abs).replace(/\\/g, '/')
    return !OFFLINE_INPUT_EXCLUDES.some((ex) => rel.startsWith(ex))
  })
  for (const rel of CONFIG_SALT_FILES) {
    const p = join(root, rel)
    if (existsSync(p)) kept.push(p)
  }
  const { digest, count } = hashFileSet(root, kept)
  const key = createHash('sha256').update('offline-source-tree-v1').update(digest).digest('hex')
  return {
    key,
    files: count,
    detail: `src/scripts/evals（去掉 ${OFFLINE_INPUT_EXCLUDES.join(', ')}）+ 配置，共 ${count} 个文件`,
  }
}

/** 这道门**能不能**被缓存（失败关闭：默认不能）。 */
export function cacheability(spec: GateSpec, scriptText: string): { ok: true } | { ok: false; why: string } {
  if (spec.resources.parallel !== 'safe') {
    return { ok: false, why: '声明了 parallel=serial ⇒ 不可缓存（失败关闭）' }
  }
  if (spec.resources.realDb === true) {
    return { ok: false, why: '真实库相关 ⇒ 不可缓存（INV-DB-01）' }
  }
  if (/(['"`]|\/)data\//.test(scriptText)) {
    return { ok: false, why: '脚本直接引用 data/ ⇒ 输入不在键的覆盖范围内，不可缓存' }
  }
  return { ok: true }
}

export function gateInputKey(root: string, spec: GateSpec, salt: string): InputKey {
  const entry = spec.entry
  let files: string[]
  let scope: InputScope
  let reason: string
  if (entry === undefined) {
    files = repoFiles(root)
    scope = 'repo'
    reason = '未声明入口脚本 ⇒ 按全仓输入（src/scripts/evals/docs + 配置）'
  } else {
    const closure = inputClosure(root, entry)
    files = closure.files
    scope = closure.scope
    reason = closure.reason
    if (scope === 'repo') files = repoFiles(root)
  }
  const { digest, count } = hashFileSet(root, files)
  const key = createHash('sha256')
    .update('gate-input-v1')
    .update(spec.id)
    .update(spec.argv.join('\u0000'))
    .update(digest)
    .update(salt)
    .digest('hex')
  return { key, filesHashed: count, scope, detail: reason }
}

/** 读缓存条目（不存在 / 读坏 ⇒ undefined，绝不抛）。 */
export function readCacheEntry(cacheDir: string, gateId: string): CacheEntry | undefined {
  const p = join(cacheDir, `${sanitize(gateId)}.json`)
  if (!existsSync(p)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as CacheEntry
    if (typeof parsed.key !== 'string' || typeof parsed.exitCode !== 'number') return undefined
    return parsed
  } catch {
    return undefined
  }
}

export function writeCacheEntry(cacheDir: string, entry: CacheEntry): void {
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(join(cacheDir, `${sanitize(entry.gateId)}.json`), `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_')
}
