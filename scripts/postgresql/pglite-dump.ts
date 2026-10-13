/**
 * PostgreSQL 迁移 WP4：**固定版导出工具**（PGlite 副本 → SQL）。
 *
 * ============================================================================
 *  工具版本为什么是 0.2.21（**不是** latest）
 * ============================================================================
 *  计划 §2 逐字："不能自动使用 latest"。这条在这里是**硬约束**，不是谨慎：
 *
 * ```text
 *   pglite-tools 的每个版本都对**一个精确的 pglite 版本**有 peer 要求：
 *     tools 0.2.21 → pglite **0.3.16**   ← 与本仓库安装的 pglite 完全一致
 *     tools 0.3.6  → pglite 0.4.6
 *     tools 0.4.9  → pglite 0.5.9        ← latest
 *   ⇒ 用 latest 会**倒逼把源库引擎从 0.3.16 升到 0.5.9** ——
 *     那是"同时升级框架"，研究 §3 明确要避免的。
 * ```
 *
 *  ⇒ 固定 **0.2.21**，并用官方 tarball **独立复算** integrity（见 WP4 Handoff）。
 *
 * ---------------------------------------------------------------------------
 *  它装在哪里（**不在项目的依赖树里**）
 * ---------------------------------------------------------------------------
 *  `artifacts/post-lv2/local/pg-migration/export-runtime/`（**gitignore**）。
 *  这是本仓库对"外部工具"的既有做法（同 desktop-runtime / ocr-runtime）：
 *  不把验证用工具塞进 `package.json`，避免扰动别人的在途改动与锁文件。
 *
 * ---------------------------------------------------------------------------
 *  纪律（与 WP0/WP4 的读取器同源）
 * ---------------------------------------------------------------------------
 *  · **只接受副本**：`sourceDir` 指向 `data/pglite` ⇒ 直接拒绝。
 *  · 先在 `%TEMP%` 做一次性副本，**只打开副本**；源目录逐字节不动（自证）。
 *  · 不写任何东西到源目录。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 导出工具运行时（独立、gitignore） */
export const EXPORT_RUNTIME_DIR = 'artifacts/post-lv2/local/pg-migration/export-runtime'
/** 固定版本（与 pglite 0.3.16 的 peer 一致） */
export const PINNED_TOOLS_VERSION = '0.2.21'
export const PINNED_PGLITE_VERSION = '0.3.16'

interface PgliteLike {
  waitReady: Promise<void>
  close: () => Promise<void>
}

interface PgDumpFile {
  text?: () => Promise<string>
  size?: number
  name?: string
}

function treeDigest(root: string): { files: number; bytes: number; digest: string } {
  const entries: string[] = []
  let bytes = 0
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(full, relPath)
      else {
        const size = statSync(full).size
        bytes += size
        entries.push(`${relPath}\u0000${size}`)
      }
    }
  }
  walk(root, '')
  entries.sort()
  return { files: entries.length, bytes, digest: createHash('sha256').update(entries.join('\n')).digest('hex') }
}

/** 从**独立运行时**解析 pglite 与 pglite-tools（项目依赖树里没有它们） */
function resolveExportRuntime(): { pglite: string; vector: string; pgDump: string; toolsVersion: string; pgliteVersion: string } {
  const runtimeDir = resolve(EXPORT_RUNTIME_DIR)
  const toolsPkg = join(runtimeDir, 'node_modules', '@electric-sql', 'pglite-tools', 'package.json')
  const pglitePkg = join(runtimeDir, 'node_modules', '@electric-sql', 'pglite', 'package.json')
  if (!existsSync(toolsPkg) || !existsSync(pglitePkg)) {
    throw new Error(
      `导出工具运行时未就绪：${runtimeDir}\n` +
        `  需要安装 @electric-sql/pglite-tools@${PINNED_TOOLS_VERSION} 与 @electric-sql/pglite@${PINNED_PGLITE_VERSION}（见 WP4 Handoff）`
    )
  }
  const requireFromRuntime = createRequire(toolsPkg)
  /** ⚠️ 版本**读自安装的包**，不是写死的常量 —— 否则"实际用的是哪个版本"就成了猜 */
  const readVersion = (file: string): string => {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: string }
    return parsed.version ?? '(unknown)'
  }
  return {
    pglite: requireFromRuntime.resolve('@electric-sql/pglite'),
    vector: requireFromRuntime.resolve('@electric-sql/pglite/vector'),
    pgDump: join(runtimeDir, 'node_modules', '@electric-sql', 'pglite-tools', 'dist', 'pg_dump.js'),
    toolsVersion: readVersion(toolsPkg),
    pgliteVersion: readVersion(pglitePkg),
  }
}

export interface PgliteDumpResult {
  /** 生成的 SQL 文本 */
  sql: string
  /** SQL 的字节数与摘要（用于"dump 摘要"这一项交付物） */
  bytes: number
  sqlDigest: string
  /** 实际使用的工具版本（**读自安装的包**，不是写死的常量） */
  tool: { toolsVersion: string; pgliteVersion: string; args: string[] }
  /** 源目录在导出前后是否逐字相同（本函数只打开副本） */
  sourceUnchanged: boolean
  copyMatchesSource: boolean
  closedClean: boolean
  elapsedMs: number
}

/**
 * 把一份 PGlite 副本导出成 SQL。
 *
 * @param args `pg_dump` 的参数（缺省 `['--schema-only']`？**不** —— 缺省导出**数据**，
 *             因为迁移要的是数据；要只看 schema 请显式传 `['--schema-only']`）
 */
export async function dumpPgliteSnapshot(options: {
  sourceDir: string
  args?: string[]
  /** 把 SQL 落到这个路径（可选；不写就只返回文本） */
  outFile?: string
  workDir?: string
}): Promise<PgliteDumpResult> {
  const source = resolve(options.sourceDir)
  if (!existsSync(join(source, 'PG_VERSION'))) {
    throw new Error(`不是 PGlite 数据目录（缺 PG_VERSION）：${source}`)
  }
  if (/[\\/]data[\\/]pglite$/.test(source)) {
    throw new Error(`拒绝：sourceDir 指向真实库 ${source}（导出工具只对副本工作）`)
  }

  const runtime = resolveExportRuntime()
  const args = options.args ?? []
  const before = treeDigest(source)

  const workDir = options.workDir ?? join(tmpdir(), `lg-pglite-dump-${Date.now().toString(36)}`)
  const copyDir = join(workDir, 'copy')
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  cpSync(source, copyDir, { recursive: true })
  const afterCopy = treeDigest(copyDir)
  const copyMatchesSource =
    afterCopy.files === before.files && afterCopy.bytes === before.bytes && afterCopy.digest === before.digest

  const started = Date.now()
  const { PGlite } = (await import(pathToFileURL(runtime.pglite).href)) as {
    PGlite: new (o: unknown) => PgliteLike
  }
  const { vector } = (await import(pathToFileURL(runtime.vector).href)) as { vector: unknown }
  const { pgDump } = (await import(pathToFileURL(runtime.pgDump).href)) as {
    pgDump: (o: { pg: unknown; args?: string[]; fileName?: string; verbose?: boolean }) => Promise<PgDumpFile>
  }

  const db = new PGlite({ dataDir: copyDir, extensions: { vector } })
  await db.waitReady

  let sql = ''
  let closedClean = false
  try {
    const file = await pgDump({ pg: db, args })
    if (typeof file?.text === 'function') {
      sql = await file.text()
    } else {
      throw new Error('pgDump 返回的对象没有 text() ⇒ 工具形状与预期不符')
    }
  } finally {
    await db.close()
    closedClean = true
    rmSync(workDir, { recursive: true, force: true })
  }

  if (options.outFile !== undefined) {
    mkdirSync(resolve(options.outFile, '..'), { recursive: true })
    writeFileSync(resolve(options.outFile), sql, 'utf8')
  }

  const after = treeDigest(source)
  return {
    sql,
    bytes: Buffer.byteLength(sql, 'utf8'),
    sqlDigest: createHash('sha256').update(sql).digest('hex'),
    tool: { toolsVersion: runtime.toolsVersion, pgliteVersion: runtime.pgliteVersion, args },
    sourceUnchanged: after.digest === before.digest,
    copyMatchesSource,
    closedClean,
    elapsedMs: Date.now() - started,
  }
}
