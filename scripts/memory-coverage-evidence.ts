/**
 * 「记忆体量」线 —— **证据装配**（`memory-coverage-evidence@1`）。
 *
 * ============================================================================
 *  它为什么单独一个文件
 * ============================================================================
 * 本仓库每个里程碑都有一份自己的证据模块（`m6-evidence.ts` / `m6.1-evidence.ts` /
 * `m7-evidence.ts` / `m8-evidence.ts` / `m9-evidence.ts` / `m9.5-evidence.ts` /
 * `m10-evidence.ts`）。本模块与它们同形：把"每次运行都一样"的那批字段收成一处，
 * 免得每个门各写一遍再各自漂移（TD-15 的教训）。
 *
 * ⚠️ 它**刻意不 import 任何里程碑专属模块**（例如 `m9.5-evidence.ts`）：
 *    跨里程碑借版本号会让"这条读数属于哪个里程碑"变得不可判。
 *
 * ⚠️ 本模块**不打开任何数据库、不读 `data/`**：这一条是构造属性（见下 `DB_TOUCHED`）。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 仓库根（本文件在 `scripts/`）。 */
export const REPO_ROOT = resolve(HERE, '..')

/** 契约 / 语料 / 量具版本（进证据；改任何一个都要**有意**改这里）。 */
export const MC_CONTRACT_VERSION = 'memory-coverage-contract@1'
export const MC_CORPUS_VERSION = 'memory-coverage-corpus@1'
/**
 * ⚠️ **`@1` → `@2`**（2026-09-30，本门第一次运行之后）：第一版把**非 `remember` 意图**的说法
 * 也按 `remember` 的抽取流程跑，于是「更正一下，我的专业是历史学。」（意图 = `correct`）
 * 被判成"抽得出" —— 那量的是一个**不是本门要判的东西**（`AGENTS.md` §6.2）。
 * 修法：非 `remember` 意图如实记为 `not_remember_intent`，**不跑抽取器**。
 * ⇒ 行为变了，版本号必须跟着变，否则 `@1` 那一次失败档与 `@2` 的读数在证据里**不可分辨**。
 */
export const MC_INSTRUMENT_VERSION = 'memory-coverage-instrument@2'

/**
 * 本门**不碰数据库** —— 这是构造属性，不是观察结论。
 *
 * 依据：本门只 import `src/kernel/app/memory/{intent-detector,content-extractor}.ts`
 * 与 `src/kernel/contracts/memory-predicates.ts`（都是纯函数 / 纯数据），
 * **不** import `src/db/**`、`src/infrastructure/persistence/**`、`src/dev/sandbox.ts`。
 * ⇒ 它没有能力打开库，因此"真实库未被触碰"不需要靠摘要来证明（`m9.5:test` 同款立场）。
 */
export const DB_TOUCHED = false as const

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

export function gitOrNull(args: readonly string[], root: string = REPO_ROOT): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/** `git status --porcelain -z` 的路径清单（NUL 分隔，避免 core.quotepath 改写中文路径）。 */
export function dirtyPaths(root: string = REPO_ROOT): string[] {
  try {
    const raw = execFileSync('git', ['-C', root, 'status', '--porcelain', '-z'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
    return raw
      .split('\u0000')
      .filter((entry) => entry.length > 3)
      .map((entry) => entry.slice(3))
      .sort()
  } catch {
    return []
  }
}

export interface SourceTreeReading {
  readonly treeSha256: string
  readonly measuredCount: number
  readonly totalBytes: number
  readonly definition: string
}

const SOURCE_TREE_EXCLUDED_PREFIXES = ['.git/', 'node_modules/', 'data/', 'dist/', 'artifacts/'] as const

/**
 * 源码树摘要（与 `m6.1-run-manifest.ts` 的 `sourceTreeReading` 同一定义，便于横向对照）。
 *
 * ⚠️ 它**不是**真实库的 `digestTree` —— 两者是不同对象，别把这里的数字当成"库没被动"的证据。
 */
export function sourceTreeReading(root: string = REPO_ROOT): SourceTreeReading {
  const gitZ = (args: readonly string[]): string[] => {
    try {
      return execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
        .split('\u0000')
        .filter((entry) => entry.length > 0)
    } catch {
      return []
    }
  }
  const all = [
    ...new Set([
      ...gitZ(['ls-files', '-z']),
      ...gitZ(['ls-files', '--others', '--exclude-standard', '-z']),
    ]),
  ].sort()

  const lines: string[] = []
  let totalBytes = 0
  for (const rel of all) {
    if (SOURCE_TREE_EXCLUDED_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue
    const abs = join(root, rel)
    if (!existsSync(abs)) continue
    const content = readFileSync(abs)
    totalBytes += content.length
    lines.push(`${rel}\t${content.length}\t${sha256(content)}\n`)
  }

  return {
    definition:
      '源码树摘要：文件集 = git ls-files ∪ git ls-files --others --exclude-standard，' +
      `排除前缀 ${SOURCE_TREE_EXCLUDED_PREFIXES.join(' / ')}；按相对路径 ordinal 升序 → ` +
      '每行 `${rel}\\t${size}\\t${sha256(内容)}\\n` → 整段 UTF-8 求 sha256。',
    measuredCount: lines.length,
    totalBytes,
    treeSha256: sha256(lines.join('')),
  }
}

/**
 * 计数自检（`AGENTS.md` §6.8 的形态）。
 *
 * 「检查了 0 项、发现 0 处不一致」与「全部一致」在输出上长得一样 ——
 * 所以量具在给出 PASS 之前必须过这一关。
 */
export interface MeasurementSelfCheck {
  readonly measuredCount: number
  readonly notRunCount: number
  readonly verdict: 'PASS' | 'FAIL' | 'MEASUREMENT INVALID'
  readonly reason: string
}

export function selfCheckMeasurement(input: {
  readonly measuredCount: number
  readonly notRunCount: number
  readonly failedCount: number
}): MeasurementSelfCheck {
  const { measuredCount, notRunCount, failedCount } = input
  if (measuredCount <= 0) {
    return {
      measuredCount,
      notRunCount,
      verdict: 'MEASUREMENT INVALID',
      reason: 'measuredCount=0 —— 0 检查 0 失败与「全部一致」在输出上无法区分（AGENTS §6.8），不是 PASS',
    }
  }
  if (notRunCount > 0) {
    return {
      measuredCount,
      notRunCount,
      verdict: 'FAIL',
      reason: `notRunCount=${String(notRunCount)} —— 声明了却没跑的档位使本 run 不完整`,
    }
  }
  if (failedCount > 0) {
    return {
      measuredCount,
      notRunCount,
      verdict: 'FAIL',
      reason: `failedCount=${String(failedCount)}（分母 measuredCount=${String(measuredCount)}）`,
    }
  }
  return {
    measuredCount,
    notRunCount,
    verdict: 'PASS',
    reason: `${String(measuredCount)} 项全部符合期望`,
  }
}

/** 本次运行的 runId（时间 + head 短号 + 进程内随机后缀，跨进程唯一）。 */
export function makeRunId(prefix: string): string {
  /* ⚠️ 小数点也要剥掉：`toISOString()` 是 `…T16:05:20.123Z`，只剥 `-:T` 会在末尾留一个 `.`
     （实测第一版 runId 长这样：`memory-coverage-20260930160520.-…` —— 目录名里带点很别扭，
     而且点号在 `entityId` 一类的地方是**非法的**，别把这种形状传下去）。 */
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
  const head = (gitOrNull(['rev-parse', 'HEAD']) ?? 'nohead').slice(0, 12)
  const salt = Math.random().toString(16).slice(2, 6)
  return `${prefix}-${stamp}-${head}-${salt}`
}

/**
 * 原子落盘：**清单最后写**。
 *
 * 判定"这一档是完整的"= **目录 + `manifest.json` 都在**（`AGENTS.md` §5.1 ③ 对快照的同一条纪律，
 * 这里用在证据档上）。先写载荷、最后写清单 ⇒ 半途崩掉留下的是"没有清单的目录"，
 * 而读取方（聚合门 / 人）按"缺清单 = not-run"处理。
 */
export function writeManifestAtomic(runDir: string, payload: Record<string, unknown>): string {
  mkdirSync(runDir, { recursive: true })
  const manifestPath = join(runDir, 'manifest.json')
  writeFileSync(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return manifestPath
}

/** 写一份载荷（`<name>.json`），返回它的 sha256（进清单的 `artifactHashes`）。 */
export function writePayload(runDir: string, name: string, payload: unknown): string {
  mkdirSync(runDir, { recursive: true })
  const path = join(runDir, name)
  const text = `${JSON.stringify(payload, null, 2)}\n`
  writeFileSync(path, text, 'utf8')
  return sha256(text)
}
