/**
 * 第二批实用能力（全盘文件 / 任务执行环 / 天气 / 办公 / 资讯 / 浏览器）—— WP0 基线采集。
 *
 * ============================================================================
 *  载体
 * ============================================================================
 * `docs/post-lv2/Productivity-Skills-and-Local-File-Execution-Plan-2026-10-04.md`
 *   · §5 WP0「基线及固定输入 … 非空基线与真实版本；不覆盖已有脏文件；没有新依赖时不重复安装」
 *
 * ============================================================================
 *  它**只读**，而且刻意只读这几样
 * ============================================================================
 * ```text
 * git 状态 / HEAD              "这次改动从哪一版开始"（事后可回答）
 * 关键文件 SHA-256              同上（只读源码字节，不解析、不执行）
 * node / pnpm / python 版本      环境基线
 * .env 的**非凭据**字段          四个实用能力开关 + 当轮内容额度 + 沙箱根
 * 已装 Python 库的元数据          python-docx / python-pptx / openpyxl（既有 venv）
 * 既有 / 待装 Node 依赖           mathjs 等既有；rss-parser / @playwright/mcp 现状
 * ```
 * ⚠️ **不打开**生产库（`data/pglite`）、**不修改** `.env`、**不安装**任何依赖、
 *    **不写** `src/**` 一个字节。这与 WP0 的退出条件一字一致。
 *
 * ```bash
 * node node_modules/tsx/dist/cli.mjs scripts/productivity-skills/wp0-baseline.ts
 * ```
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(process.cwd())

/** raw 读数（含完整 .env 非凭据字段列表）只放这里 —— 已 gitignore */
export const LOCAL_PARENT = 'artifacts/post-lv2/local/productivity-skills-preparation'
/** 公开证据（进仓库）：指纹与读数，不含任何凭据 */
export const EVIDENCE_PARENT = 'artifacts/post-lv2/productivity-skills'

/**
 * 既有 Python 环境（**第一批**建的专属 venv；本批**复用**，不新建）。
 *
 * ⚠️ 它属于第一批的目录（`utility-skills-preparation`），**不是**本批的
 *    `productivity-skills-preparation` —— 计划书 §1 的选型就是"复用已安装的三个库"。
 * ⚠️ 刻意**不复制**这个 venv：复制会产生第二份事实来源，而"到底用的是哪一个解释器"
 *    事后必须只有一个答案。
 */
export const EXISTING_PYTHON_VENV =
  'artifacts/post-lv2/local/utility-skills-preparation/python/venv/Scripts/python.exe'

/**
 * 本批的**相关源文件**（改动前指纹）。
 *
 * ⚠️ 这张表**不是断言**：本批后续会有意改动其中多个文件。它存在的意义只有一个 ——
 *    事后能回答"这次改动从哪一版开始"（先例 `Utility-Skills-WP0-Baseline.md` §1.2）。
 */
export const BASELINE_SOURCE_FILES: readonly string[] = [
  'package.json',
  'pnpm-lock.yaml',
  '.npmrc',
  'pnpm-workspace.yaml',
  '.env',
  'src/main.ts',
  'src/kernel/app/flags.ts',
  'src/kernel/app/turn-gateway.ts',
  'src/kernel/app/reply-guard-chain.ts',
  'src/kernel/action/capability-registry.ts',
  'src/kernel/action/target-resolver.ts',
  'src/kernel/action/action-turn.ts',
  'src/kernel/action/action-result.ts',
  'src/kernel/action/executor-port.ts',
  'src/kernel/action/policy.ts',
  'src/kernel/action/gateway.ts',
  'src/kernel/action/intent-detector.ts',
  'src/kernel/action/utility-capabilities.ts',
  'src/kernel/action/utility-intent.ts',
  'src/kernel/action/turn-content-reply.ts',
  'src/kernel/contracts/turn-content.ts',
  'src/kernel/contracts/context.ts',
  'src/kernel/context/sections.ts',
  'src/infrastructure/action/adapters/sandbox-filesystem.ts',
  'src/infrastructure/action/adapters/document-read.ts',
  'src/infrastructure/action/adapters/image-ocr.ts',
  'src/infrastructure/action/adapters/web-read.ts',
  'src/infrastructure/model/openai-search-need-judge.ts',
  'src/db/index.ts',
  'src/dev/sandbox.ts',
]

/** 本批将要复用 / 追加的依赖（现状核实，**不安装**） */
const NODE_DEPENDENCIES: readonly { name: string; role: string; expected: string }[] = [
  { name: 'mathjs', role: '第一批-精确计算', expected: '15.2.0' },
  { name: 'jsdom', role: '第一批-网页深读', expected: '30.1.2' },
  { name: '@mozilla/readability', role: '第一批-网页深读', expected: '0.6.0' },
  { name: 'tesseract.js', role: '第一批-OCR', expected: '7.0.0' },
  { name: 'rss-parser', role: '本批-资讯（待装）', expected: '3.13.0' },
  { name: '@playwright/mcp', role: '本批-浏览器（sidecar，独立目录）', expected: '0.0.83' },
]

/** 本批要复用的 Python 库（读**既有 venv** 的元数据，不安装） */
const PYTHON_PACKAGES: readonly { name: string; role: string; expected: string }[] = [
  { name: 'python-docx', role: 'DOCX 生成', expected: '1.2.0' },
  { name: 'python-pptx', role: 'PPTX 生成', expected: '1.0.2' },
  { name: 'openpyxl', role: 'XLSX 生成', expected: '3.1.5' },
]

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function sha256File(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function git(args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function safeRun(command: string, args: readonly string[]): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync(command, [...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      // Windows 上 `pnpm` 是 .cmd ⇒ 不走 shell 会 ENOENT（本机实测）。
      // ⚠️ 含空格的绝对路径（venv 里的 python.exe）**不能**走 shell —— cmd 会在空格处断句。
      shell: process.platform === 'win32' && !command.includes(' '),
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    return { ok: true, stdout }
  } catch (error) {
    return { ok: false, stdout: (error as Error).message }
  }
}

/**
 * 读 `.env` 的**非凭据字段**。
 *
 * ⚠️ 刻意用**白名单**（只读我们关心的键），而不是"把 .env 整个读进来再删掉像 key 的行"
 *    —— 后者的失败方向是泄漏，白名单的失败方向是"少读一个键"。先例：第一批的同一做法。
 */
export function readEnvSubset(path: string, keys: readonly string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const key of keys) out[key] = null
  if (!existsSync(path)) return out
  const text = readFileSync(path, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (!(key in out)) continue
    out[key] = trimmed.slice(eq + 1).trim()
  }
  return out
}

const ENV_KEYS: readonly string[] = [
  'ACTION_SANDBOX_ROOT',
  'CHARACTER_ACTION_ENABLED',
  'CHARACTER_ACTION_MAX_RISK',
  'CHARACTER_MATH_CALCULATE_ENABLED',
  'CHARACTER_DOCUMENT_READ_ENABLED',
  'CHARACTER_WEB_READ_ENABLED',
  'CHARACTER_IMAGE_OCR_ENABLED',
  'CHARACTER_TURN_CONTENT_TOKENS',
  'CHARACTER_WEB_SEARCH_ENABLED',
  'CHARACTER_WEB_SEARCH_MODE',
  // 本批将新增（现在**应该**全为 null —— 这本身就是一条读数）
  'CHARACTER_LOCAL_FILE_READ_ENABLED',
  'CHARACTER_LOCAL_FILE_WRITE_ENABLED',
  'CHARACTER_TASK_AUTONOMY_ENABLED',
  'CHARACTER_WEATHER_ENABLED',
  'CHARACTER_OFFICE_GENERATE_ENABLED',
  'CHARACTER_NEWS_READ_ENABLED',
  'CHARACTER_BROWSER_ENABLED',
]

// ---------------------------------------------------------------------------
// 采集
// ---------------------------------------------------------------------------

export interface BaselineReading {
  schemaVersion: string
  runId: string
  observedAtUtc: string
  git: {
    branch: string
    head: string
    headShort: string
    /** `git status --porcelain` 的条目数（**混合树**：不代表本批改动） */
    dirtyEntries: number
  }
  environment: {
    node: string
    pnpm: string
    python: string
    platform: string
    cwd: string
    sandboxDefaultRoot: string
    sandboxDefaultRootExists: boolean
  }
  sourceHashes: Record<string, string | null>
  envSubset: Record<string, string | null>
  nodeDependencies: readonly {
    name: string
    role: string
    expected: string
    installed: string | null
    status: 'PRESENT' | 'ABSENT' | 'MISSING'
  }[]
  pythonInterpreter: { path: string; exists: boolean }
  pythonPackages: readonly {
    name: string
    role: string
    expected: string
    installed: string | null
    status: 'MATCH' | 'MISMATCH' | 'NOT_RUN'
  }[]
  firstBatchReuse: {
    fixturesDir: boolean
    pythonVenv: boolean
    ocrAssetsDir: boolean
  }
  notes: readonly string[]
}

function installedVersionOf(name: string): string | null {
  try {
    const pkg = join(REPO_ROOT, 'node_modules', ...name.split('/'), 'package.json')
    if (!existsSync(pkg)) return null
    const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string }
    return parsed.version ?? null
  } catch {
    return null
  }
}

function pythonPackageVersions(pythonPath: string): Record<string, string | null> | 'NOT_RUN' {
  if (!existsSync(pythonPath)) return 'NOT_RUN'
  const script = [
    'import json,sys',
    'import importlib.metadata as m',
    'names=' + JSON.stringify(PYTHON_PACKAGES.map((p) => p.name)),
    'out={}',
    'for n in names:',
    '    try: out[n]=m.version(n)',
    '    except Exception: out[n]=None',
    'print(json.dumps(out))',
  ].join('\n')
  const result = safeRun(pythonPath, ['-c', script])
  if (!result.ok) return 'NOT_RUN'
  try {
    return JSON.parse(result.stdout) as Record<string, string | null>
  } catch {
    return 'NOT_RUN'
  }
}

export function collectBaseline(): BaselineReading {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
  const headShort = git(['rev-parse', '--short=8', 'HEAD']) || 'unknown'
  const runId = `productivity-wp0-${stamp}-${headShort}`

  const sourceHashes: Record<string, string | null> = {}
  for (const file of BASELINE_SOURCE_FILES) {
    sourceHashes[file] = sha256File(join(REPO_ROOT, file)) ?? null
  }

  const sandboxRoot = readEnvSubset(join(REPO_ROOT, '.env'), ['ACTION_SANDBOX_ROOT'])
    .ACTION_SANDBOX_ROOT
  const defaultRoot = sandboxRoot ?? 'data/action-sandbox'

  const nodeDependencies = NODE_DEPENDENCIES.map((dep) => {
    const installed = installedVersionOf(dep.name)
    return {
      ...dep,
      installed,
      status: (installed === null
        ? 'ABSENT'
        : installed === dep.expected
          ? 'PRESENT'
          : 'MISSING') as 'PRESENT' | 'ABSENT' | 'MISSING',
    }
  })

  const pythonPath = join(REPO_ROOT, EXISTING_PYTHON_VENV)
  const versions = pythonPackageVersions(pythonPath)
  const pythonPackages = PYTHON_PACKAGES.map((pkg) => {
    if (versions === 'NOT_RUN') {
      return { ...pkg, installed: null, status: 'NOT_RUN' as const }
    }
    const installed = versions[pkg.name] ?? null
    return {
      ...pkg,
      installed,
      status: (installed === null ? 'NOT_RUN' : installed === pkg.expected ? 'MATCH' : 'MISMATCH') as
        | 'MATCH'
        | 'MISMATCH'
        | 'NOT_RUN',
    }
  })

  return {
    schemaVersion: 'productivity-skills-wp0@1',
    runId,
    observedAtUtc: new Date().toISOString(),
    git: {
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      head: git(['rev-parse', 'HEAD']),
      headShort,
      dirtyEntries: git(['status', '--porcelain'])
        .split('\n')
        .filter((line) => line !== '').length,
    },
    environment: {
      node: process.version,
      pnpm: safeRun('pnpm', ['--version']).stdout,
      python: safeRun(pythonPath, ['--version']).stdout,
      platform: `${process.platform} ${process.arch}`,
      cwd: REPO_ROOT,
      sandboxDefaultRoot: defaultRoot,
      sandboxDefaultRootExists: existsSync(resolve(REPO_ROOT, defaultRoot)),
    },
    sourceHashes,
    envSubset: readEnvSubset(join(REPO_ROOT, '.env'), ENV_KEYS),
    nodeDependencies,
    pythonInterpreter: { path: EXISTING_PYTHON_VENV, exists: existsSync(pythonPath) },
    pythonPackages,
    firstBatchReuse: {
      fixturesDir: existsSync(join(REPO_ROOT, LOCAL_PARENT, 'fixtures')),
      pythonVenv: existsSync(pythonPath),
      ocrAssetsDir: existsSync(join(REPO_ROOT, LOCAL_PARENT, 'ocr-data')),
    },
    notes: [
      '工作树是**混合树**：dirtyEntries 里绝大多数条目不是本批产生的（AGENTS.md §8）。',
      '本表只读；没有安装依赖、没有修改 .env、没有打开 data/pglite。',
      'CHARACTER_LOCAL_FILE_* / CHARACTER_TASK_AUTONOMY_ENABLED / 四项业务开关现在应为 null —— ' +
        '它们在本批接线时才会存在。',
    ],
  }
}

function main(): void {
  const reading = collectBaseline()

  const localDir = join(REPO_ROOT, LOCAL_PARENT, 'wp0')
  mkdirSync(localDir, { recursive: true })
  writeFileSync(join(localDir, `${reading.runId}.json`), `${JSON.stringify(reading, null, 2)}\n`, 'utf8')

  const publicDir = join(REPO_ROOT, EVIDENCE_PARENT, reading.runId)
  mkdirSync(publicDir, { recursive: true })
  writeFileSync(join(publicDir, 'wp0-baseline.json'), `${JSON.stringify(reading, null, 2)}\n`, 'utf8')

  const out = [
    `[productivity:wp0] runId = ${reading.runId}`,
    `[productivity:wp0] head = ${reading.git.headShort} · branch = ${reading.git.branch} · dirty = ${String(reading.git.dirtyEntries)}`,
    `[productivity:wp0] node = ${reading.environment.node} · pnpm = ${reading.environment.pnpm} · python = ${reading.environment.python}`,
    `[productivity:wp0] 沙箱缺省根 = ${reading.environment.sandboxDefaultRoot}（存在=${String(reading.environment.sandboxDefaultRootExists)}）`,
    `[productivity:wp0] 公开证据 = ${EVIDENCE_PARENT}/${reading.runId}/wp0-baseline.json`,
    '',
    '[productivity:wp0] Node 依赖现状：',
    ...reading.nodeDependencies.map(
      (dep) =>
        `[productivity:wp0]   ${dep.name.padEnd(24)} ${String(dep.installed ?? '(未安装)').padEnd(12)} ${dep.status}  ${dep.role}`
    ),
    '',
    '[productivity:wp0] Python 库现状（既有 venv）：',
    ...reading.pythonPackages.map(
      (pkg) =>
        `[productivity:wp0]   ${pkg.name.padEnd(16)} ${String(pkg.installed ?? '(未读到)').padEnd(10)} ${pkg.status}`
    ),
    '',
    '[productivity:wp0] .env 非凭据字段（null = 未设置）：',
    ...Object.entries(reading.envSubset).map(
      ([key, value]) => `[productivity:wp0]   ${key} = ${value ?? 'null'}`
    ),
  ].join('\n')
  process.stdout.write(`${out}\n`)
}

const isMain =
  process.argv[1] !== undefined &&
  /wp0-baseline\.ts$/.test(process.argv[1].replace(/\\/g, '/'))

if (isMain) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`[productivity:wp0] 失败：${(error as Error).message}\n`)
    process.exit(2)
  }
}

export { sha256File, statSync }
