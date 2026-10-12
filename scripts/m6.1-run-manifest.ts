/**
 * M6.1 —— **标准契约清单（`m6.1-manifest@1`）的公共字段装配**（L-M61-14 的修复件）。
 *
 * ============================================================================
 *  它修的是什么
 * ============================================================================
 * `m6.1:gates` 只读**字段齐全**的清单：`M6_1_MANIFEST_REQUIRED_FIELDS`
 * （M6 通用 16 + M6.1 追加 6 = 22 个）。而三个运行器
 * （`m6.1-live-short` / `m6.1-baseline` / `m6.1-wp3-judge`）此前只写了**子集**
 * —— 它们产出的新读数在聚合器眼里是"缺字段"，只能靠旧 run 顶替。
 * 那就是登记在册的 **L-M61-14**（"m6.1 live 运行器 manifest 早于聚合器契约"）。
 *
 * 本模块把"每次运行都一样"的那批字段**收成一处**：
 *
 * ```text
 *   git 身份（codeCommit / head / branch）
 *   源码树摘要（runRelevantTreeSha + 定义）
 *   工作树例外（workingTreeExceptions，真实脏路径）
 *   工具版本（node / platform / arch / git）
 *   冻结输入指纹（fixtureRubricThresholdHashes）
 *   非机密配置指纹（nonSecretConfigFingerprint，**只记存在与长度，绝不记取值**）
 *   沙箱身份（sandboxIdentity）
 *   契约 / 语料 / 量具版本 + supersedes
 * ```
 *
 * ⇒ "统一 emit 全字段"是**一处实现**，而不是三处各写一遍再各自漂移（TD-15 的教训同型）。
 *
 * ⚠️ 与 `m6.1-evidence.ts` 的分工：那一份是**纯**的（不读 argv/env、不 spawn、不 exit）；
 *    本模块专门做那些**必须**读环境的事，但输入仍是显式参数、不读 `process.argv`。
 *
 * ⚠️ 本模块**不**决定清单是否合法：落盘前的失败关闭闸在
 *    `assertStandardManifestComplete()`（`m6.1-evidence.ts`），由 `writeManifestAtomic()` 调用。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  M6_1_CONTRACT_VERSION,
  M6_1_CORPUS_VERSION,
  M6_1_INSTRUMENT_VERSION,
} from './m6.1-contract.ts'

/** 源码树摘要的排除前缀（与 `m6.1-wp0-baseline.ts` 同一口径）。 */
const SOURCE_TREE_EXCLUDED_PREFIXES = [
  '.git/',
  'node_modules/',
  'data/',
  'dist/',
  'artifacts/m6/',
  'artifacts/m6.1/',
  'artifacts/.fast/',
] as const

/** 冻结输入：存在就记指纹，缺失就如实跳过（不假装算过）。 */
const FROZEN_INPUTS = [
  'evals/fixtures/m3.5/prompt-baseline.txt',
  'evals/m6.1/manifest.json',
  'evals/m6.1/annotations/labels.json',
  'docs/m6.1/M6.1-WP6-Freeze-Sheet.md',
  'docs/m6/M6-Acceptance-Contract.md',
] as const

/** 只记"存在 + 值长度"的键（**绝不**记取值）。 */
const SECRET_KEYS = ['OPENAI_API_KEY'] as const

/** 非机密的配置键：同样**只记存在与长度**（本模块比 wp0 更保守，一处都不留取值）。 */
const CONFIG_KEYS = [
  'CHARACTER_WEB_SEARCH_ENABLED',
  'CHARACTER_WEB_SEARCH_MODE',
  'CHARACTER_WEB_SEARCH_EVIDENCE_TOKENS',
  'CHARACTER_ROLLUP_TOKENS',
  'CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED',
  'CHARACTER_MEMORY_BACKGROUND_ENABLED',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_API_KEY',
] as const

const ENV_FILES = ['.env', '.env.test', '.env.example', '.env.test.example'] as const

function gitOrNull(root: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/** `git status --porcelain -z` 的路径清单（NUL 分隔，避免 core.quotepath 改写中文路径）。 */
export function dirtyPaths(root: string): string[] {
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

/**
 * 源码树摘要（与 `m6.1-wp0-baseline.ts` 的 `sourceTreeDigest()` 同一定义）。
 *
 * ```text
 *   文件集 = git ls-files ∪ git ls-files --others --exclude-standard
 *   排除前缀（见上）；按相对路径 ordinal 升序 →
 *   每行 `${rel}\t${size}\t${sha256(内容)}\n` → 整段 UTF-8 求 sha256
 * ```
 */
export function sourceTreeReading(root: string): SourceTreeReading {
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
    lines.push(`${rel}\t${content.length}\t${createHash('sha256').update(content).digest('hex')}\n`)
  }

  return {
    definition:
      '源码树摘要（M6.1 定义，与真实库 `digestTree` 不同对象）：' +
      '文件集 = git ls-files ∪ git ls-files --others --exclude-standard，' +
      `排除前缀 ${SOURCE_TREE_EXCLUDED_PREFIXES.join(' / ')}；` +
      '按相对路径 ordinal 升序 → 每行 `${rel}\\t${size}\\t${sha256(内容)}\\n` → 整段 UTF-8 求 sha256。',
    measuredCount: lines.length,
    totalBytes,
    treeSha256: createHash('sha256').update(lines.join(''), 'utf8').digest('hex'),
  }
}

/** 冻结输入指纹（缺失的显式记为 `(缺失)`，不是"算过了但是空"）。 */
export function frozenInputHashes(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rel of FROZEN_INPUTS) {
    const abs = join(root, rel)
    out[rel] = existsSync(abs)
      ? createHash('sha256').update(readFileSync(abs)).digest('hex')
      : '(缺失)'
  }
  return out
}

/**
 * 非机密配置指纹：**只**记"每个键在哪些文件里出现 + 该处值的长度"。
 * 取值一个都不进证据（本模块比 wp0 更保守）。
 */
export function nonSecretConfigFingerprint(root: string): Record<string, unknown> {
  const files = ENV_FILES.map((name) => {
    const abs = join(root, name)
    if (!existsSync(abs)) return { file: name, present: false as const }
    const text = readFileSync(abs, 'utf8')
    const keys: { key: string; valueLength: number }[] = []
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      if (!(CONFIG_KEYS as readonly string[]).includes(key) && !(SECRET_KEYS as readonly string[]).includes(key)) {
        continue
      }
      keys.push({ key, valueLength: trimmed.slice(eq + 1).trim().length })
    }
    return { file: name, present: true as const, keys }
  })
  return {
    note:
      '只记"键出现在哪些文件 + 该处值的长度"，**任何取值（含非机密端点）都不进证据**；' +
      '与 wp0 的 `nonSecretConfigFingerprint` 是同一目的（说明"测试档有没有被覆盖"），口径更保守。',
    files,
  }
}

export interface StandardManifestFieldsInput {
  /** 仓库根（缺省 = `process.cwd()`）。 */
  readonly root?: string
  /** 本次运行的开始时刻（调用方在脚本开头取一次）。 */
  readonly startedAt: string
  /**
   * 实际执行的命令（缺省 = `[{ cmd: '(未提供)', exitCode: null }]`）。
   * ⚠️ 本模块**不读 `process.argv`**：命令字符串由调用方给出。
   */
  readonly commands?: readonly { cmd: string; exitCode: number | null }[]
  /** 本运行器声明的排除项（缺省 = 只排除本地逐字正文目录）。 */
  readonly exclusions?: readonly string[]
  /** 清单要记的"语料版本"——由调用方声明它**实际**读的是什么。 */
  readonly corpusVersion?: string
  /** 与 `corpusVersion` 配套的定义说明（避免"版本号描述的不是那个东西"）。 */
  readonly corpusVersionDefinition?: string
  /** 取代关系（缺省空数组；省略等于"没有取代任何旧读数"，不得省略字段本身）。 */
  readonly supersedes?: readonly string[]
}

/**
 * 标准契约清单的公共字段。调用方把它展开进 `writeManifestAtomic()` 的 payload：
 *
 * ```ts
 * writeManifestAtomic(runDir, {
 *   schemaVersion: 'm6.1-manifest@1',
 *   runId, testType, phases, counts, evidence, realDbProtection,
 *   ...standardManifestFields({ startedAt: STARTED_AT, commands: [...] }),
 * })
 * ```
 */
export function standardManifestFields(
  input: StandardManifestFieldsInput
): Record<string, unknown> {
  const root = resolve(input.root ?? process.cwd())
  const head = gitOrNull(root, ['rev-parse', 'HEAD'])
  const tree = sourceTreeReading(root)
  return {
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
    codeCommit: head,
    head,
    branch: gitOrNull(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    runRelevantTreeSha: tree.treeSha256,
    runRelevantTreeShaDefinition:
      tree.definition + `（本次 measuredCount=${tree.measuredCount} / ${tree.totalBytes} 字节）`,
    workingTreeExceptions: dirtyPaths(root),
    commands: input.commands ?? [{ cmd: '(未提供)', exitCode: null }],
    toolVersions: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      git: gitOrNull(root, ['--version']),
    },
    fixtureRubricThresholdHashes: frozenInputHashes(root),
    nonSecretConfigFingerprint: nonSecretConfigFingerprint(root),
    sandboxIdentity: {
      projectLgSandboxSet: process.env.PROJECT_LG_SANDBOX !== undefined,
      cwd: root,
    },
    exclusions: [...(input.exclusions ?? ['artifacts/m6.1/local/'])],
    contractVersion: M6_1_CONTRACT_VERSION,
    corpusVersion: input.corpusVersion ?? M6_1_CORPUS_VERSION,
    ...(input.corpusVersionDefinition !== undefined
      ? { corpusVersionDefinition: input.corpusVersionDefinition }
      : {}),
    instrumentVersion: M6_1_INSTRUMENT_VERSION,
    supersedes: [...(input.supersedes ?? [])],
  }
}
