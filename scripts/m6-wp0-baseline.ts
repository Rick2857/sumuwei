/**
 * M6 WP0 —— 基线与前置核对量具。
 *
 * ============================================================================
 *  这份脚本要测的命题（计划书 §5：先写命题，再写量具）
 * ============================================================================
 *  「这份 baseline 描述的是**本 checkout 在当前 HEAD 上的真实状态**，
 *    而不是旧结果、别人的工作树或一次空扫描。」
 *
 *  正控 / 负控 / 恢复（三段式，缺一不可）：
 *    正控：向临时目录写 2 个已知文件 ⇒ `digestTree` 报 measuredCount === 2；
 *          改动其中一个字节 ⇒ treeSha256 **必须变**（证明它真的在量内容）。
 *    负控：空目录 ⇒ `digestTree` **必须抛** MeasurementInvalidError，
 *          不许返回"全部一致"。
 *    恢复：清空后重建 ⇒ 再次报 measuredCount === 2 且摘要回到原值（安静）。
 *    另加一条**证据归属负控**：指向不存在的路径 ⇒ 必须抛，不许静默记空串。
 *
 * ============================================================================
 *  硬边界（这些是判据，不是注释）
 * ============================================================================
 *  · **不 import dotenv**：`.env` 读数来自**文件文本**，不是 `process.env`。
 *    否则"这条读数是哪来的"就不可判（AGENTS §8.1 记录过这个坑）。
 *  · **不 import 任何数据库依赖**，不调 `initDatabase()`，不打开真实库。
 *    真实库只做一次**只读内容树摘要**（`data/pglite` 的字节）。
 *  · **不回显任何 key 取值**：白名单键只记"是否存在 + 值长度"。
 *  · 两个**不同对象**用两个**不同定义**的摘要，且都记录算法原文，禁止混用：
 *      · 真实库 `digestTree()`  —— INC-01 的冻结算法（唯一实现，本脚本不重写）
 *      · 源码树 `sourceTreeDigest()` —— 本脚本定义（git 工作树内容，含未跟踪未忽略文件）
 *
 * 用法：
 *   pnpm exec tsx scripts/m6-wp0-baseline.ts --out artifacts/m6/<runId>
 *   pnpm exec tsx scripts/m6-wp0-baseline.ts --out artifacts/m6/<runId> --phase after
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import {
  MeasurementInvalidError,
  VOLATILE_EXCLUDED_PATHS,
  digestTree,
  type TreeDigest,
} from '../src/infrastructure/persistence/production-db-safety.ts'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 源码树摘要的排除前缀（目录级；`digestTree` 只支持精确相对路径，故不复用它） */
const SOURCE_TREE_EXCLUDED_PREFIXES = [
  '.git/',
  'node_modules/',
  'data/',
  'dist/',
  'artifacts/m6/',
] as const

/** 真实库只读摘要的目标（`data/` 已被 gitignore，git 看不见它） */
const REAL_DB_DIR = 'data/pglite'

/** 允许进入证据的 `.env*` 键（**只记存在性与长度，永不记取值**） */
const ENV_KEYS = [
  'CHARACTER_WEB_SEARCH_ENABLED',
  'CHARACTER_WEB_SEARCH_EVIDENCE_TOKENS',
  'CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED',
  'CHARACTER_MEMORY_BACKGROUND_ENABLED',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
] as const

/** 允许记录的非机密端点标识（沿用 `scripts/run-with-test-model.ts` 的既有口径） */
const ENV_NON_SECRET_HOST_KEYS = ['OPENAI_BASE_URL', 'OPENAI_MODEL'] as const

/**
 * 并发窗口。
 *
 * 两个窗口**都要记**，因为它们回答的是两个不同问题：
 *   · 短窗（1.5h）回答"**现在**有没有别的任务在写这个 checkout"
 *   · 长窗（12h）回答"这个 checkout 最近被谁动过"（含昨夜已结束的批次）
 * 只用长窗会把"昨夜跑完的 R2 批次"误报成并发，只用短窗又会漏掉真实的共享边界。
 */
const RECENT_WINDOW_HOURS = 1.5
const LONG_WINDOW_HOURS = 12

/** 本量具**自己**建立的产物路径（源码树摘要里如出现差异，须能按此归类为 WP0 自产） */
const WP0_AUTHORED_PREFIXES = [
  'docs/m6/',
  'artifacts/m6/',
  'scripts/m6-wp0-baseline.ts',
] as const

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

interface CommandReading {
  cmd: string
  exitCode: number
  note?: string
}

const commands: CommandReading[] = []

/** 跑一条 git 命令并**记录它进证据**（异常时如实记非零退出码后再抛） */
function git(args: string[], note?: string): string {
  const cmd = `git ${args.join(' ')}`
  try {
    const out = execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    commands.push({ cmd, exitCode: 0, ...(note !== undefined ? { note } : {}) })
    return out
  } catch (error) {
    commands.push({ cmd, exitCode: 1, ...(note !== undefined ? { note } : {}) })
    throw error
  }
}

/** NUL 分隔版本：非 ASCII 路径不会被 `core.quotepath` 转义成一个带引号的"路径" */
function gitZ(args: string[], note?: string): string[] {
  return git([...args, '-z'], note).split('\0').filter((entry) => entry !== '')
}

function sha256OfFile(abs: string): string {
  if (!existsSync(abs)) {
    // 证据归属负控：绝不返回空串冒充"算过了"
    throw new MeasurementInvalidError(`MEASUREMENT INVALID：证据文件不存在 ${abs}`)
  }
  return createHash('sha256').update(readFileSync(abs)).digest('hex')
}

function sizeOfFile(abs: string): number {
  return statSync(abs).size
}

// ---------------------------------------------------------------------------
// 源码树摘要（本脚本定义；与真实库的 `digestTree` 是两个不同对象）
// ---------------------------------------------------------------------------

interface SourceTreeDigest {
  definition: string
  measuredCount: number
  totalBytes: number
  treeSha256: string
  excludedPrefixes: string[]
  /**
   * 摘要**原像**（就是算法定义里那些行）。
   *
   * 它落在 sidecar 文本文件里而不是内联进 `baseline.json`：
   * 1271 个文件内联会把 baseline 撑到 260KB+，人就没法复核了。
   * 而且这份原像本身就是"能从这里重算 treeSha256"的凭据。
   */
  lines: string[]
  perFile: Map<string, { size: number; sha256: string }>
}

function sourceTreeDigest(root: string): SourceTreeDigest {
  const tracked = gitZ(['ls-files'], '已跟踪文件清单（NUL 分隔，避免 core.quotepath 改写中文路径）')
  const untracked = gitZ(
    ['ls-files', '--others', '--exclude-standard'],
    '未跟踪但未被忽略的文件（M6 新产物在提交前属于这一类）'
  )
  const all = [...new Set([...tracked, ...untracked])].sort()

  const perFile = new Map<string, { size: number; sha256: string }>()
  let totalBytes = 0
  for (const rel of all) {
    if (SOURCE_TREE_EXCLUDED_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue
    const abs = join(root, rel)
    if (!existsSync(abs)) {
      throw new MeasurementInvalidError(`MEASUREMENT INVALID：git 报出但磁盘不存在 ${rel}`)
    }
    const content = readFileSync(abs)
    perFile.set(rel, {
      size: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    })
    totalBytes += content.length
  }

  if (perFile.size === 0) {
    throw new MeasurementInvalidError(
      'MEASUREMENT INVALID：源码树未测到任何文件（measured_count = 0）'
    )
  }

  const lines = [...perFile.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([rel, info]) => `${rel}\t${info.size}\t${info.sha256}\n`)

  return {
    definition:
      '源码树摘要（M6 WP0 定义，与真实库 digestTree 不同对象）：' +
      '文件集 = git ls-files ∪ git ls-files --others --exclude-standard，' +
      `排除前缀 ${SOURCE_TREE_EXCLUDED_PREFIXES.join(' / ')}；` +
      '按相对路径 ordinal 升序 → 每行 `${rel}\\t${size}\\t${sha256(内容)}\\n` → 整段 UTF-8 求 sha256。',
    measuredCount: perFile.size,
    totalBytes,
    treeSha256: createHash('sha256').update(lines.join(''), 'utf8').digest('hex'),
    excludedPrefixes: [...SOURCE_TREE_EXCLUDED_PREFIXES],
    lines,
    perFile,
  }
}

interface TreeDiffEntry {
  path: string
  kind: 'added' | 'removed' | 'changed'
  classification: 'wp0-authored' | 'unexpected'
}

type FileIndex = Map<string, { size: number; sha256: string }>

function diffSourceTree(
  before: FileIndex,
  after: FileIndex
): { changedFiles: TreeDiffEntry[]; unexpected: number } {
  const changedFiles: TreeDiffEntry[] = []
  const paths = new Set([...before.keys(), ...after.keys()])
  for (const path of [...paths].sort()) {
    const a = before.get(path)
    const b = after.get(path)
    let kind: TreeDiffEntry['kind'] | undefined
    if (a === undefined) kind = 'added'
    else if (b === undefined) kind = 'removed'
    else if (a.sha256 !== b.sha256 || a.size !== b.size) kind = 'changed'
    if (kind === undefined) continue
    const owned = WP0_AUTHORED_PREFIXES.some((prefix) => path.startsWith(prefix))
    changedFiles.push({ path, kind, classification: owned ? 'wp0-authored' : 'unexpected' })
  }
  return {
    changedFiles,
    unexpected: changedFiles.filter((entry) => entry.classification === 'unexpected').length,
  }
}

// ---------------------------------------------------------------------------
// 量具自证（正控 / 负控 / 恢复）
// ---------------------------------------------------------------------------

interface SelfTestCase {
  id: string
  kind: 'positive' | 'negative' | 'recovery' | 'negative-attribution'
  proposition: string
  observed: string
  pass: boolean
}

function writeProbeFiles(dir: string, second: string): void {
  writeFileSync(join(dir, 'a.txt'), 'alpha', 'utf8')
  writeFileSync(join(dir, 'b.txt'), second, 'utf8')
}

function runSelfTest(): { cases: SelfTestCase[]; pass: boolean } {
  const cases: SelfTestCase[] = []
  const dir = mkdtempSync(join(tmpdir(), 'm6-wp0-selftest-'))
  try {
    // 正控 A：2 个已知文件必须被数到
    writeProbeFiles(dir, 'beta')
    const first = digestTree(dir)
    cases.push({
      id: 'P1',
      kind: 'positive',
      proposition: '2 个已知文件 ⇒ measuredCount 恰为 2',
      observed: `measuredCount=${first.measuredCount}`,
      pass: first.measuredCount === 2,
    })

    // 正控 B：改一个字节 ⇒ 摘要必须变（否则它没在量内容）
    writeProbeFiles(dir, 'gamma')
    const mutated = digestTree(dir)
    cases.push({
      id: 'P2',
      kind: 'positive',
      proposition: '改动 1 个文件的内容 ⇒ treeSha256 必须变',
      observed: `${first.treeSha256.slice(0, 16)}… → ${mutated.treeSha256.slice(0, 16)}…`,
      pass: first.treeSha256 !== mutated.treeSha256,
    })

    // 恢复：回到原内容 ⇒ 摘要必须回到原值（"安静"）
    writeProbeFiles(dir, 'beta')
    const restored = digestTree(dir)
    cases.push({
      id: 'R1',
      kind: 'recovery',
      proposition: '内容还原 ⇒ treeSha256 回到原值（量具重新安静）',
      observed: `${restored.treeSha256.slice(0, 16)}…`,
      pass: restored.treeSha256 === first.treeSha256,
    })

    // 负控 A：空目录 ⇒ 必须抛 MeasurementInvalidError，不许 PASS
    const empty = mkdtempSync(join(tmpdir(), 'm6-wp0-empty-'))
    try {
      let threw = false
      let message = ''
      try {
        digestTree(empty)
      } catch (error) {
        threw = error instanceof MeasurementInvalidError
        message = error instanceof Error ? error.message : String(error)
      }
      cases.push({
        id: 'N1',
        kind: 'negative',
        proposition: '空目录 ⇒ 必须抛 MeasurementInvalidError（measured_count = 0 不是 PASS）',
        observed: threw ? `抛了：${message.slice(0, 60)}…` : '**没有抛**（这是假绿）',
        pass: threw,
      })
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }

    // 负控 B：证据归属 —— 不存在的路径不许静默记空串
    try {
      let threw = false
      try {
        sha256OfFile(join(dir, 'not-here.json'))
      } catch (error) {
        threw = error instanceof MeasurementInvalidError
      }
      cases.push({
        id: 'N2',
        kind: 'negative-attribution',
        proposition: '索引指向不存在的路径 ⇒ 必须抛，不许记空串冒充"算过了"',
        observed: threw ? '抛了' : '**没有抛**（这是假绿）',
        pass: threw,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    cases.push({
      id: 'X1',
      kind: 'negative',
      proposition: '自证过程本身不得抛异常',
      observed: error instanceof Error ? error.message : String(error),
      pass: false,
    })
  }
  return { cases, pass: cases.every((entry) => entry.pass) }
}

// ---------------------------------------------------------------------------
// 证据索引（§9.2：旧 FAIL 与新 PASS 都保留，必须写明取代关系）
// ---------------------------------------------------------------------------

interface EvidenceEntry {
  subject: string
  path: string | null
  status: 'historical' | 'current' | 'unverified' | 'superseded'
  supersededBy?: string
  appliesTo?: string
  note?: string
}

const EVIDENCE_INDEX: EvidenceEntry[] = [
  {
    subject: 'M5.5 收官复跑（最终代码）',
    path: 'docs/closure/M5.5-Closure-Record-Final-Code.md',
    status: 'historical',
    appliesTo: '48ec269 之后的最终代码；G1–G4 重跑，**G5 未重跑**',
    note: '本记录不主张"最终代码上真实出站链路已复验"；`m5.5-complete` 仍指 48ec269',
  },
  {
    subject: 'M5.1.1 收官复跑（最终代码）',
    path: 'docs/closure/M5.1.1-Closure-Record-Final-Code.md',
    status: 'historical',
    appliesTo: 'ADR-044（Phase 4 / D01 关闭）之后的最终代码',
  },
  {
    subject: 'M5.5.1 语义门权威记录（R2）',
    path: 'docs/m5.5.1/M5.5.1-WP7-R2-Execution-Record.md',
    status: 'current',
    appliesTo: 'v2 语料 · maxTokens 2400 · 判定超时 25000ms · explicit 模式',
  },
  {
    subject: 'M5.5.1 R2 原始观测（新批次依据）',
    path: 'artifacts/m5.5.1/wp7/r2-9-full-v2-timeout25000/observations.json',
    status: 'current',
    appliesTo: '348 次调用 · 形状 348/348 · transport 0/348 · verdict=PASS',
  },
  {
    subject: 'M5.5.1 早期语义证据（FAIL）',
    path: 'artifacts/m5.5.1/semantics-live.json',
    status: 'superseded',
    supersededBy: 'artifacts/m5.5.1/wp7/r2-9-full-v2-timeout25000/observations.json',
    note: '**保留不删**；不得按同名默认路径把 v1 旧门当成 v2 结论',
  },
  {
    subject: 'M5.5.1 真实搜索 Live Smoke',
    path: 'artifacts/m5.5.1/smoke/smoke-live.json',
    status: 'historical',
    appliesTo: 'explicit 模式（生产已激活）；**不代表 auto_public**，也不证明结果相关性',
  },
  {
    subject: 'INC-01 WP1 租约证据（已提交版本）',
    path: 'artifacts/incidents/inc-01/wp1-lease.json',
    status: 'historical',
    note: '工作树副本另有**他人未提交**改动（仅时间戳/管道样本），M6 不还原、不提交、不覆盖',
  },
  {
    subject: 'INC-01 WP2 快照证据',
    path: 'artifacts/incidents/inc-01/wp2-snapshot.json',
    status: 'historical',
  },
  {
    subject: 'INC-01 事故报告',
    path: 'docs/incidents/INC-01-Pglite-DataDir-Unrecoverable-Corruption.md',
    status: 'current',
    note: '根因部分未定；快照恢复造成的历史断档保留，不得由模型猜补',
  },
  {
    subject: 'ADR-043 重定向文件的状态段',
    path: 'docs/adr/ADR-043-legacy-cognitive-provenance-and-epistemic-requalification.md',
    status: 'superseded',
    supersededBy:
      'docs/adr/ADR-043-epistemic-requalification.md + docs/adr/ADR-044-m5.1.1-phase4-closure.md',
    note: '该文件状态段仍写 `Phase 4 NOT RUN / D01 OPEN / Final BLOCKED`，已被 ADR-044 取代；M6 不改冻结面，仅登记',
  },
  {
    subject: 'M5.5.1 收口记录（WP8/WP9）',
    path: null,
    status: 'unverified',
    note:
      '`docs/m5.5.1/` 无 WP8 记录 · `docs/closure/` 无 M5.5.1 收官记录 · 无 `m5.5.1-complete` 标签' +
      ' ⇒ 计划 §2.2 前置 1 未满足',
  },
  {
    subject: 'INC-01 生产接线证据（WP3/WP4/WP5）',
    path: null,
    status: 'unverified',
    note:
      '`docs/incidents/` 只有 WP0/WP1/WP2 handoff；`src/main.ts` 未引用 `production-db-safety`' +
      ' ⇒ 计划 §2.2 前置 2 未满足',
  },
]

interface EvidenceReading extends EvidenceEntry {
  sha256: string | null
  bytes: number | null
  missing: boolean
}

function readEvidenceIndex(root: string): EvidenceReading[] {
  return EVIDENCE_INDEX.map((entry) => {
    if (entry.path === null) {
      return { ...entry, sha256: null, bytes: null, missing: true }
    }
    const abs = join(root, entry.path)
    if (!existsSync(abs)) {
      return { ...entry, sha256: null, bytes: null, missing: true }
    }
    return {
      ...entry,
      sha256: sha256OfFile(abs),
      bytes: sizeOfFile(abs),
      missing: false,
    }
  })
}

// ---------------------------------------------------------------------------
// 链路地图（源 → turn → context → model → guard → ledger/trace → query/UI）
// ---------------------------------------------------------------------------

interface ChainSegment {
  id: string
  entryFiles: string[]
  currentBehavior: string
  plannedChange: string
  gates: string[]
}

const CHAIN_MAP: ChainSegment[] = [
  {
    id: 'source',
    entryFiles: ['src/infrastructure/persistence/memory-store.ts', 'src/infrastructure/persistence/conversation-store.ts'],
    currentBehavior: '对话事件与记忆记录的唯一持久层；`memory-store.list()` 自带 500 行上限',
    plannedChange: '新增**只读且显式有界**的摘取来源窗口查询（不绕过 owner / user / qualification 检查）',
    gates: ['pnpm m4:test', 'pnpm m4:verify'],
  },
  {
    id: 'turn',
    entryFiles: ['src/kernel/app/turn-gateway.ts'],
    currentBehavior: '`beginTurn` 之后、编译之前依次挂载召回 / 写入结果 / 动作结果 / 外部证据',
    plannedChange: '在同一位置派生 rollup 摘要（抽取式、有来源引用、失败即整段不注入）',
    gates: ['pnpm m3.5:test', 'pnpm eval:scenarios', 'pnpm eval:dryrun', 'pnpm eval:providers'],
  },
  {
    id: 'context',
    entryFiles: ['src/kernel/contracts/context.ts', 'src/kernel/context/sections.ts'],
    currentBehavior: '`createContextCompiler` 是唯一裁剪算法；两个工厂（v1/v2）都留 `extraProviders` 扩展点',
    plannedChange: '**必须走 `extraProviders`**：塞进 `buildContextCompilerV2` 默认 provider 列表会打红 prompt 逐字节基线',
    gates: ['pnpm typecheck', 'pnpm kernel:test', 'pnpm kernel:verify', 'pnpm m3.5:test'],
  },
  {
    id: 'budget',
    entryFiles: ['src/kernel/recall/selector.ts'],
    currentBehavior: '`ContextBudget` 4 个必填字段 + 6 类 `ContextCategory`；`planContextBudget()` / `assertContextBudget()` 按此写死',
    plannedChange: '新增摘要额度/类别会连锁打红 `m5:budget:verify` 与多处字面量 —— WP1 必须先裁定（R-3）',
    gates: ['pnpm m5:budget:verify', 'pnpm m5:test', 'pnpm m5:verify'],
  },
  {
    id: 'model',
    entryFiles: ['src/infrastructure/runtime/adapters.ts'],
    currentBehavior: '模型调用经唯一 provider 适配层',
    plannedChange: '抽取式摘要**新增模型调用数必须为 0**（这是它与"自由改写摘要"的关键分界）',
    gates: ['pnpm eval:providers', 'pnpm m4.5:smoke:live'],
  },
  {
    id: 'guard',
    entryFiles: ['src/kernel/app/turn-gateway.ts'],
    currentBehavior: '守卫链：记忆 → 动作 → 外部证据；回复五态与来源附录由程序生成',
    plannedChange: '摘要**不得插进守卫链** —— 它是派生上下文，不是事实，也不能变成第二个事实权威',
    gates: ['pnpm m4.5:test', 'pnpm m5.5:test'],
  },
  {
    id: 'ledger-trace',
    entryFiles: ['src/infrastructure/persistence/trace-store.ts', 'src/kernel/contracts/trace.ts'],
    currentBehavior: 'trace 记录 section 组成、裁剪与引用；**不记正文**',
    plannedChange: '只新增"引用与计数"，**不得写入摘要正文或搜索 snippet**',
    gates: ['pnpm m3:verify', 'pnpm m3.5:verify', 'pnpm eval:telemetry', 'pnpm eval:otlp'],
  },
  {
    id: 'query-ui',
    entryFiles: [
      'src/infrastructure/dev/query-service.ts',
      'src/infrastructure/dev/http-server.ts',
      'src/infrastructure/dev/page.html',
    ],
    currentBehavior: '开发者面只消费 `/dev/query/*`；两条受控命令（RUN_DIAGNOSTIC / RUN_AUDIT）',
    plannedChange: '按合法生产者登记表扩展 DTO；CLI 与页面复用服务能力，不新建直写数据库路径',
    gates: ['pnpm m5.1:test', 'pnpm m5.1:query:verify', 'pnpm m5.1:control:verify', 'pnpm m5.1:page:verify'],
  },
  {
    id: 'runtime-protection',
    entryFiles: ['src/infrastructure/persistence/production-db-safety.ts', 'src/main.ts'],
    currentBehavior: '租约/快照模块已存在且有 WP1/WP2 证据，但 **`src/main.ts` 零引用**，`session.close()` 只调 `runtime.stop()`',
    plannedChange: '**不由 M6 改**：属 INC-01 WP3（close 生命周期）/ WP4（生产接线）/ WP5（恢复演练）',
    gates: ['pnpm m4:isolation:verify', 'pnpm m4:restore:verify'],
  },
]

// ---------------------------------------------------------------------------
// 配置只读核对（白名单；永不回显取值）
// ---------------------------------------------------------------------------

interface EnvFileReading {
  path: string
  present: boolean
  bytes: number | null
  mtime: string | null
  sha256: string | null
}

interface EnvKeyReading {
  key: string
  presentIn: string[]
  /**
   * **逐文件**的长度。
   *
   * 早先的版本只留一个 `valueLength`（后读到的文件覆盖前一个），于是
   * "`.env` 与 `.env.test` 是不是指向同一个端点"这个问题**在证据里无法回答** ——
   * 读数看起来正常，描述的却是别的东西（AGENTS §6.9 的第二种形态）。
   */
  valueLengthByFile: Record<string, number>
  /** 只有白名单里的非机密键（endpoint / model）才留取值，且按文件分开 */
  nonSecretValueByFile?: Record<string, string>
}

const ENV_FILES = ['.env', '.env.test', '.env.example', '.env.test.example'] as const

function parseEnvText(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    map.set(key, value)
  }
  return map
}

function readEnvConfig(root: string): {
  files: EnvFileReading[]
  keys: EnvKeyReading[]
  note: string
} {
  const files: EnvFileReading[] = []
  const parsed = new Map<string, Map<string, string>>()
  for (const rel of ENV_FILES) {
    const abs = join(root, rel)
    if (!existsSync(abs)) {
      files.push({ path: rel, present: false, bytes: null, mtime: null, sha256: null })
      continue
    }
    const text = readFileSync(abs, 'utf8')
    parsed.set(rel, parseEnvText(text))
    files.push({
      path: rel,
      present: true,
      bytes: sizeOfFile(abs),
      mtime: statSync(abs).mtime.toISOString(),
      sha256: sha256OfFile(abs),
    })
  }

  const keys: EnvKeyReading[] = ENV_KEYS.map((key) => {
    const presentIn: string[] = []
    const valueLengthByFile: Record<string, number> = {}
    const nonSecretValueByFile: Record<string, string> = {}
    const keepValue = (ENV_NON_SECRET_HOST_KEYS as readonly string[]).includes(key)
    for (const rel of ['.env', '.env.test'] as const) {
      const value = parsed.get(rel)?.get(key)
      if (value === undefined) continue
      presentIn.push(rel)
      valueLengthByFile[rel] = value.length
      if (keepValue) nonSecretValueByFile[rel] = value
    }
    const reading: EnvKeyReading = { key, presentIn, valueLengthByFile }
    if (keepValue) reading.nonSecretValueByFile = nonSecretValueByFile
    return reading
  })

  return {
    files,
    keys,
    // 注意：键值一律**不进**证据；key 自身也不算机密（AGENTS §8.1 的既有口径）。
    note:
      '读数来自文件文本（**本脚本不 import dotenv**）；每键按文件分别记"是否存在 + 值长度"，不记取值。' +
      '只有 OPENAI_BASE_URL / OPENAI_MODEL 这两个非机密标识留取值（沿用 scripts/run-with-test-model.ts 的口径）。',
  }
}

// ---------------------------------------------------------------------------
// 并发与共享文件边界
// ---------------------------------------------------------------------------

interface ConcurrencyReading {
  status: 'clean' | 'unverified-writes'
  windows: { hours: number; files: { path: string; mtime: string }[] }[]
  incident01Mtimes: { path: string; mtime: string }[]
  note: string
}

/** WP0 期间允许出现的"新近改动"：README 里登记过的他人产物 + WP0 自产路径 */
function isExpectedRecentWrite(path: string): boolean {
  if (path === 'artifacts/incidents/inc-01/wp1-lease.json') return true
  return WP0_AUTHORED_PREFIXES.some((prefix) => path.startsWith(prefix))
}

function readConcurrency(root: string): ConcurrencyReading {
  const tracked = gitZ(['ls-files'])
  const untracked = gitZ(['ls-files', '--others', '--exclude-standard'])
  const candidates: { rel: string; mtimeMs: number; mtime: string }[] = []

  for (const rel of [...new Set([...tracked, ...untracked])].sort()) {
    if (SOURCE_TREE_EXCLUDED_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue
    const abs = join(root, rel)
    if (!existsSync(abs)) continue
    const stat = statSync(abs)
    candidates.push({ rel, mtimeMs: stat.mtimeMs, mtime: stat.mtime.toISOString() })
  }

  const windows = [RECENT_WINDOW_HOURS, LONG_WINDOW_HOURS].map((hours) => {
    const cutoff = Date.now() - hours * 3600 * 1000
    return {
      hours,
      files: candidates
        .filter((entry) => entry.mtimeMs >= cutoff)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .map((entry) => ({ path: entry.rel, mtime: entry.mtime })),
    }
  })

  const incidentDir = join(root, 'artifacts/incidents/inc-01')
  const incident01Mtimes: { path: string; mtime: string }[] = []
  if (existsSync(incidentDir)) {
    for (const name of ['baseline.json', 'wp1-lease.json', 'wp2-snapshot.json']) {
      const abs = join(incidentDir, name)
      if (existsSync(abs)) {
        incident01Mtimes.push({
          path: `artifacts/incidents/inc-01/${name}`,
          mtime: statSync(abs).mtime.toISOString(),
        })
      }
    }
  }

  const shortWindow = windows[0]?.files ?? []
  const unexplained = shortWindow.filter((entry) => !isExpectedRecentWrite(entry.path))

  return {
    status: unexplained.length === 0 ? 'clean' : 'unverified-writes',
    windows,
    incident01Mtimes,
    note:
      '短窗内出现**未登记**的改动才叫并发写入；已登记的他人产物（INC-01 证据）与 WP0 自产路径不算。' +
      `排除前缀 ${SOURCE_TREE_EXCLUDED_PREFIXES.join(' / ')}。`,
  }
}

// ---------------------------------------------------------------------------
// git 状态
// ---------------------------------------------------------------------------

interface DirtyPath {
  path: string
  status: string
  ownership: string
}

function classifyOwnership(path: string): string {
  if (path === 'artifacts/incidents/inc-01/wp1-lease.json') {
    return 'other-task（INC-01 WP1/WP2 证据重跑遗留；M6 不还原、不提交、不覆盖）'
  }
  if (WP0_AUTHORED_PREFIXES.some((prefix) => path.startsWith(prefix))) return 'm6-wp0'
  return 'unknown（需人工判定归属后再继续）'
}

interface GitState {
  branch: string
  head: string
  headShort: string
  mainSha: string
  aheadOfMain: number
  behindMain: number
  mainIsAncestor: boolean
  stashCount: number
  tags: { name: string; annotation: string }[]
  dirtyPaths: DirtyPath[]
  unknownDirtyPaths: number
}

function readGitState(): GitState {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  const head = git(['rev-parse', 'HEAD']).trim()
  const mainSha = git(['rev-parse', 'main']).trim()
  const aheadOfMain = Number(git(['rev-list', '--count', 'main..HEAD']).trim())
  const behindMain = Number(git(['rev-list', '--count', 'HEAD..main']).trim())

  let mainIsAncestor = true
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', 'main', 'HEAD'], { stdio: 'ignore' })
    commands.push({ cmd: 'git merge-base --is-ancestor main HEAD', exitCode: 0 })
  } catch {
    commands.push({ cmd: 'git merge-base --is-ancestor main HEAD', exitCode: 1 })
    mainIsAncestor = false
  }

  const stashCount = git(['stash', 'list']).split('\n').filter((line) => line.trim() !== '').length

  const tagLines = git(['tag', '--list', '-n1']).split('\n').filter((line) => line.trim() !== '')
  const tags = tagLines.map((line) => {
    const [name, ...rest] = line.trim().split(/\s+/)
    return { name: name ?? line.trim(), annotation: rest.join(' ') }
  })

  /*
   * ⚠️ 必须用 `-z`：默认的 `git status --porcelain` 会把非 ASCII 路径按
   * `core.quotepath` 转义成一个**带引号的假路径**（`"docs/\350\213..."`），
   * 于是 `existsSync` 全部落空、后面的摘要无法归类。
   * 同时加 `--no-renames`：重命名在 `-z` 模式下会把旧路径作为一个**额外的
   * NUL 字段**跟出来，禁用重命名后每条记录都只有一个路径，语义无歧义。
   */
  const dirtyPaths: DirtyPath[] = gitZ(['status', '--porcelain=v1', '--no-renames']).map(
    (line) => {
      const status = line.slice(0, 2)
      const rawPath = line.slice(3)
      const path = rawPath.includes(' -> ') ? (rawPath.split(' -> ')[1] ?? rawPath) : rawPath
      return { path, status, ownership: classifyOwnership(path) }
    }
  )

  return {
    branch,
    head,
    headShort: head.slice(0, 12),
    mainSha,
    aheadOfMain,
    behindMain,
    mainIsAncestor,
    stashCount,
    tags,
    dirtyPaths,
    unknownDirtyPaths: dirtyPaths.filter((entry) => entry.ownership.startsWith('unknown')).length,
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { out: string; phase: 'before' | 'after' | 'verify' } {
  let out: string | undefined
  let phase: 'before' | 'after' | 'verify' = 'before'
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--out') {
      out = argv[index + 1]
      index += 1
      continue
    }
    if (arg === '--phase') {
      const value = argv[index + 1]
      if (value !== 'before' && value !== 'after' && value !== 'verify') {
        throw new Error(`--phase 只能是 before / after / verify，收到 ${String(value)}`)
      }
      phase = value
      index += 1
    }
  }
  if (out === undefined || out.trim() === '') {
    throw new Error('必须给 --out <目录>，例如 --out artifacts/m6/m6-wp0-20260921-1165fedcdde2')
  }
  return { out: resolve(out), phase }
}

function main(): void {
  const root = resolve(process.cwd())
  const { out, phase } = parseArgs(process.argv.slice(2))
  const startedAt = new Date().toISOString()

  const selfTest = runSelfTest()
  if (!selfTest.pass) {
    console.error('[m6-wp0] 量具自证失败 —— MEASUREMENT INVALID，不产出 baseline')
    for (const entry of selfTest.cases) {
      console.error(`  ${entry.pass ? 'PASS' : 'FAIL'} ${entry.id} ${entry.proposition}`)
    }
    process.exit(2)
  }

  mkdirSync(out, { recursive: true })
  const baselinePath = join(out, 'baseline.json')
  const manifestPath = join(out, 'manifest.json')

  const gitState = readGitState()

  const realDbAbs = join(root, REAL_DB_DIR)
  // 不传第二个参数 = 沿用 INC-01 的默认排除（`postmaster.pid` 是易失运行态，不代表数据内容）
  const realDbDigest: TreeDigest = digestTree(realDbAbs)
  const sourceTree = sourceTreeDigest(root)
  const env = readEnvConfig(root)
  const concurrency = readConcurrency(root)

  if (phase === 'after') {
    if (!existsSync(baselinePath)) {
      console.error(`[m6-wp0] --phase after 需要先跑 before（缺 ${baselinePath}）`)
      process.exit(2)
    }
    const previous = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
      runId: string
      digests: {
        realDb: { before: TreeDigest }
        sourceTree: { before: SourceTreeDigestShape }
      }
      counters: Record<string, number>
    }
    /*
     * 先复核 sidecar 原像**没被事后改过**，再拿它做 diff。
     * 只信 baseline.json 里的 sha256 字段是不够的 —— 那也可能被一起改。
     */
    const beforeIndexRel = previous.digests.sourceTree.before.indexFile
    const beforeIndexAbs = join(out, beforeIndexRel)
    if (!existsSync(beforeIndexAbs)) {
      throw new MeasurementInvalidError(`MEASUREMENT INVALID：before 原像缺失 ${beforeIndexRel}`)
    }
    const beforeIndex = parseSourceTreeIndex(readFileSync(beforeIndexAbs, 'utf8'))
    const recomputedIndexSha = digestOfIndexLines(beforeIndex)
    if (recomputedIndexSha !== previous.digests.sourceTree.before.indexSha256) {
      throw new MeasurementInvalidError(
        'MEASUREMENT INVALID：before 原像与它记录的 sha256 不一致（索引被改过，或写入时截断）'
      )
    }
    if (beforeIndex.size !== previous.digests.sourceTree.before.measuredCount) {
      throw new MeasurementInvalidError(
        `MEASUREMENT INVALID：before 原像记录数 ${beforeIndex.size} ≠ 声明的 measuredCount ` +
          `${previous.digests.sourceTree.before.measuredCount}`
      )
    }

    const diff = diffSourceTree(beforeIndex, sourceTree.perFile)
    const realDbUnchanged = previous.digests.realDb.before.treeSha256 === realDbDigest.treeSha256
    const sourceUnchanged = previous.digests.sourceTree.before.treeSha256 === sourceTree.treeSha256

    const afterIndexFile = 'source-tree-index.after.txt'
    writeFileSync(join(out, afterIndexFile), sourceTree.lines.join(''), 'utf8')
    const afterShape = summarizeSourceTree(sourceTree, afterIndexFile)

    /*
     * ⚠️ after 阶段**只能否掉/确认** before 阶段的采样，**不能**把证据索引与链路图的
     * 计数清成 0 —— 那些是 before 阶段的事实，清掉会让 `computeVerdict` 把
     * "证据条目 < 10" 误判成 MEASUREMENT INVALID（一种假红）。
     * 因此这里是"继承 + 覆盖采样相关字段"，不是重算全表。
     */
    const freshCounters = buildAfterCounters({
      realDbDigest,
      sourceTree,
      gitState,
      concurrency,
      sourceTreeDiff: diff,
    })
    const countersAfter = {
      ...previous.counters,
      ...freshCounters,
      realDbStabilityUnchanged: realDbUnchanged ? 1 : 0,
      sourceTreeStabilityUnchanged: sourceUnchanged ? 1 : 0,
    }
    const verdictAfter = computeVerdict(countersAfter, realDbUnchanged, diff)

    const updated = {
      ...(JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, unknown>),
      phase: 'before+after',
      finishedAt: new Date().toISOString(),
      digests: {
        realDb: {
          definition: REAL_DB_DEFINITION,
          root: REAL_DB_DIR,
          before: previous.digests.realDb.before,
          after: realDbDigest,
          stability: realDbUnchanged ? 'unchanged' : 'changed',
          observation: readRealDbMtimes(root),
          note: realDbUnchanged
            ? '两次只读摘要逐字相同：本轮 WP0 没有改变真实库字节（**不等于**"真实库这段历史完整"）'
            : '两次摘要不同：按 openQuestions 的 OQ-1 处理，不得解释成"没被动过"',
        },
        sourceTree: {
          before: previous.digests.sourceTree.before,
          after: afterShape,
          stability: sourceUnchanged ? 'unchanged' : 'changed',
          changedFiles: diff.changedFiles,
          unexpectedChangedFiles: diff.unexpected,
          note: '差异只允许落在 WP0 自产路径（docs/m6、artifacts/m6、scripts/m6-wp0-baseline.ts）上',
        },
      },
      concurrencyAfter: concurrency,
      gitAfter: { branch: gitState.branch, head: gitState.head, dirtyPaths: gitState.dirtyPaths },
      counters: countersAfter,
      verdict: verdictAfter,
    }
    writeFileSync(baselinePath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          ...manifest,
          finishedAt: new Date().toISOString(),
          phases: [...((manifest.phases as unknown[]) ?? []), 'after'],
          counts: countersAfter,
          verdict: verdictAfter,
          codeCommitAfter: gitState.head,
          runRelevantTreeShaAfter: sourceTree.treeSha256,
          evidence: [
            ...((manifest.evidence as unknown[]) ?? []),
            {
              path: relative(root, baselinePath).split(/[\\/]/).join('/'),
              sha256: sha256OfFile(baselinePath),
            },
          ],
        },
        null,
        2
      )}\n`,
      'utf8'
    )

    console.log(`[m6-wp0] phase=after verdict=${verdictAfter}`)
    console.log(`  realDb      stability=${realDbUnchanged ? 'unchanged' : 'changed'}`)
    console.log(
      `  sourceTree  stability=${sourceUnchanged ? 'unchanged' : 'changed'} unexpected=${diff.unexpected}`
    )
    process.exit(verdictAfter === 'BASELINE CAPTURED' ? 0 : 2)
  }

  /*
   * ---- verify 阶段 ----
   *
   * 回答的是"**采样之后**工作树有没有再变，变的是不是只有 WP0 自产的纯文档"。
   * 这一步存在的理由：采样必然发生在最终一次文档编辑之前，如果只靠报告里写一句
   * "后来只改了文档"，那就是**不可机器判定的口头声明**（AGENTS §6.2）。
   */
  if (phase === 'verify') {
    if (!existsSync(baselinePath)) {
      console.error(`[m6-wp0] --phase verify 需要先跑 before + after（缺 ${baselinePath}）`)
      process.exit(2)
    }
    const previous = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
      digests: {
        realDb: { before: TreeDigest; after: TreeDigest | null }
        sourceTree: { before: SourceTreeDigestShape; after: SourceTreeDigestShape | null }
      }
    }
    const afterShape = previous.digests.sourceTree.after
    if (afterShape === null) {
      console.error('[m6-wp0] --phase verify 需要先跑 after（sourceTree.after 为空）')
      process.exit(2)
    }
    const afterIndex = parseSourceTreeIndex(readFileSync(join(out, afterShape.indexFile), 'utf8'))
    if (digestOfIndexLines(afterIndex) !== afterShape.indexSha256) {
      throw new MeasurementInvalidError('MEASUREMENT INVALID：after 原像与它记录的 sha256 不一致')
    }
    const diff = diffSourceTree(afterIndex, sourceTree.perFile)
    const realDbStable =
      previous.digests.realDb.after !== null &&
      previous.digests.realDb.after.treeSha256 === realDbDigest.treeSha256
    const verification = {
      verifiedAt: new Date().toISOString(),
      head: gitState.head,
      branch: gitState.branch,
      sampledTreeSha: afterShape.treeSha256,
      currentTreeSha: sourceTree.treeSha256,
      changedSinceAfterSample: diff.changedFiles,
      unexpectedChangedSinceAfterSample: diff.unexpected,
      realDbUnchangedSinceAfterSample: realDbStable,
      verdict: diff.unexpected === 0 ? 'OK' : 'RUN-RELEVANT-TREE-CHANGED',
      note:
        '`unexpectedChangedSinceAfterSample = 0` 表示采样之后**只有 WP0 自产的纯文档/证据**发生' +
        '变化 —— 这正是 §9.2 允许的"新的纯报告提交可以引用被测提交"。若 > 0，则运行相关树已变，' +
        '本次取样的运行读数失效，必须重采。',
    }

    const before = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, unknown>
    const downgraded =
      verification.verdict === 'OK'
        ? before.verdict
        : before.verdict === 'BASELINE CAPTURED'
          ? 'PARTIAL'
          : before.verdict
    writeFileSync(
      baselinePath,
      `${JSON.stringify({ ...before, verification, verdict: downgraded }, null, 2)}\n`,
      'utf8'
    )

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          ...manifest,
          verification,
          verdict: downgraded,
          phases: [...((manifest.phases as unknown[]) ?? []), 'verify'],
          evidence: [
            ...((manifest.evidence as unknown[]) ?? []),
            {
              path: relative(root, baselinePath).split(/[\\/]/).join('/'),
              sha256: sha256OfFile(baselinePath),
            },
          ],
        },
        null,
        2
      )}\n`,
      'utf8'
    )

    console.log(`[m6-wp0] phase=verify ${verification.verdict} verdict=${String(downgraded)}`)
    console.log(
      `  changedSinceAfterSample=${diff.changedFiles.length} unexpected=${diff.unexpected} realDbUnchanged=${realDbStable}`
    )
    for (const entry of diff.changedFiles) {
      console.log(`    ${entry.kind} ${entry.classification} ${entry.path}`)
    }
    process.exit(verification.verdict === 'OK' ? 0 : 2)
  }

  // ---- before 阶段 ----
  const evidence = readEvidenceIndex(root)
  const chainMissing = CHAIN_MAP.flatMap((segment) => segment.entryFiles).filter(
    (rel) => !existsSync(join(root, rel))
  ).length

  /*
   * 摘要**原像**落到 sidecar 文本文件；`baseline.json` 只留指针 + 原像的 sha256。
   * 这一步也让 "索引文件有没有被事后改过" 成为可判定的（见 after 阶段的复核）。
   */
  const sourceTreeIndexFile = 'source-tree-index.before.txt'
  writeFileSync(join(out, sourceTreeIndexFile), sourceTree.lines.join(''), 'utf8')
  const sourceTreeShape = summarizeSourceTree(sourceTree, sourceTreeIndexFile)
  const realDbObservation = readRealDbMtimes(root)

  const runId = `m6-wp0-${startedAt.slice(0, 10).replace(/-/g, '')}-${gitState.headShort}`
  const counters = buildCounters({
    evidence,
    realDbDigest,
    sourceTree,
    gitState,
    concurrency,
    envKeyCount: env.keys.length,
    chainMissing,
    selfTestFailures: 0,
    sourceTreeDiff: undefined,
  })

  const baseline = {
    schemaVersion: 'm6-wp0-baseline@1',
    runId,
    phase: 'before',
    collectedAt: { startedAt, finishedAt: new Date().toISOString(), timezone: 'Asia/Shanghai' },
    git: gitState,
    digests: {
      realDb: {
        definition: REAL_DB_DEFINITION,
        root: REAL_DB_DIR,
        before: realDbDigest,
        after: null,
        stability: 'pending-after-sample',
        observation: realDbObservation,
      },
      sourceTree: {
        before: sourceTreeShape,
        after: null,
        stability: 'pending-after-sample',
      },
    },
    evidenceIndex: evidence,
    evidenceIndexMissingPaths: evidence
      .filter((entry) => entry.missing && entry.path !== null)
      .map((entry) => entry.path),
    configReadout: env,
    chainMap: {
      segments: CHAIN_MAP.map((segment) => ({
        ...segment,
        entryFilesMissing: segment.entryFiles.filter((rel) => !existsSync(join(root, rel))),
      })),
      entryFilesMissing: CHAIN_MAP.flatMap((segment) => segment.entryFiles).filter(
        (rel) => !existsSync(join(root, rel))
      ),
    },
    concurrency,
    measurementSelfTest: {
      pass: selfTest.pass,
      cases: selfTest.cases,
      note: '正控（数到了、且改字节必变）/ 负控（空目录必须抛）/ 恢复（还原后重新安静）/ 证据归属负控',
    },
    openQuestions: [
      {
        id: 'OQ-1',
        question: `${REAL_DB_DIR} 的最新 mtime 是谁产生的写入？`,
        whyItMatters: '计划 §1.2 引用的是 M5.5 收尾时的"前后逐字相同"；本轮只能记录、不能解释',
        whoCanAnswer: '用户（是否在这段时间聊过天）/ 真实库账本（**需用户授权后**由 src/main.ts 读取）',
      },
      {
        id: 'OQ-2',
        question: 'M5.5.1 的 WP8 记录与 `m5.5.1-complete` 标签由哪个任务补齐？',
        whyItMatters: '计划 §2.2 前置 1：没有可引用的候选提交与收口结论，WP6b/WP9b/WP10b 无法解阻',
        whoCanAnswer: '用户（是否把 M5.5.1 收口作为独立任务立项）',
      },
      {
        id: 'OQ-3',
        question: 'INC-01 的 WP3（close 生命周期）/ WP4（生产接线）/ WP5（恢复演练）排在什么时候？',
        whyItMatters: '计划 §2.2 前置 2：组件 PASS 不等于运行期保护生效 ⇒ M6 的 WP6b 现在为 BLOCKED',
        whoCanAnswer: '用户 / INC-01 独立任务',
      },
      {
        id: 'OQ-4',
        question: 'ADR-043 重定向文件的状态段已过期（仍写 Phase 4 NOT RUN），要不要另开收口载体修订？',
        whyItMatters: '"同一概念两处权威"是本仓库明令禁止的；M6 不碰冻结面，只登记',
        whoCanAnswer: '用户（是否接受"仅登记、不修订"）',
      },
    ],
    counters,
    verdict: 'PENDING-AFTER-SAMPLE',
  }

  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')

  const manifest = {
    schemaVersion: 'm6-manifest@1',
    runId,
    testType: 'M6 WP0 基线与前置核对（**只读**：不跑模型、不跑搜索、不打开真实库、不迁移、不快照）',
    phases: ['before'],
    startedAt,
    finishedAt: new Date().toISOString(),
    timezone: 'Asia/Shanghai',
    codeCommit: gitState.head,
    branch: gitState.branch,
    baseBranch: { name: 'main', sha: gitState.mainSha, aheadOfMain: gitState.aheadOfMain },
    runRelevantTreeSha: sourceTree.treeSha256,
    workingTreeExceptions: gitState.dirtyPaths,
    commands,
    handoffCommands: [
      { cmd: 'pnpm exec tsx scripts/m6-wp0-baseline.ts --out artifacts/m6/<runId>', exitCode: 0 },
      { cmd: 'pnpm exec tsx scripts/m6-wp0-baseline.ts --out artifacts/m6/<runId> --phase after', exitCode: null, note: '退出码以 WP0-Handoff.md 记录为准' },
      { cmd: 'pnpm typecheck', exitCode: null, note: '退出码以 WP0-Handoff.md 记录为准' },
    ],
    toolVersions: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      git: safeVersion('git', ['--version']),
    },
    fixtureRubricThresholdHashes: {
      'evals/fixtures/m3.5/prompt-baseline.txt': safeHash(join(root, 'evals/fixtures/m3.5/prompt-baseline.txt')),
      'evals/m3/baseline.json': safeHash(join(root, 'evals/m3/baseline.json')),
      'scripts/m5.5.1-corpus-audit.ts': safeHash(join(root, 'scripts/m5.5.1-corpus-audit.ts')),
      'docs/adr/ADR-049-adaptive-search-verification.md': safeHash(
        join(root, 'docs/adr/ADR-049-adaptive-search-verification.md')
      ),
    },
    nonSecretConfigFingerprint: {
      note: env.note,
      files: env.files,
      keys: env.keys,
    },
    counts: counters,
    sandboxIdentity: {
      projectLgSandboxSet: process.env.PROJECT_LG_SANDBOX !== undefined,
      cwd: root,
    },
    realDbProtection: {
      definition: REAL_DB_DEFINITION,
      digestBefore: realDbDigest.treeSha256,
      measuredCount: realDbDigest.measuredCount,
      totalBytes: realDbDigest.totalBytes,
      excludedPaths: realDbDigest.excludedPaths,
      observationBefore: realDbObservation,
      note:
        '**只读**内容树摘要：本量具不打开 PGlite、不调 initDatabase；`data/` 被 gitignore，' +
        '故"没被动过"只能靠摘要/mtime 证明，不能靠 git。摘要与 mtime 回答的是两件事：' +
        '摘要回答"字节变没变"，mtime 回答"有没有人碰过"。',
    },
    exclusions: [...SOURCE_TREE_EXCLUDED_PREFIXES],
    measurementSelfTest: baseline.measurementSelfTest,
    verdict: baseline.verdict,
    evidence: [
      { path: relative(root, baselinePath).split(/[\\/]/).join('/'), sha256: sha256OfFile(baselinePath) },
      {
        path: relative(root, join(out, sourceTreeIndexFile)).split(/[\\/]/).join('/'),
        sha256: sha256OfFile(join(out, sourceTreeIndexFile)),
      },
    ],
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  console.log(`[m6-wp0] phase=before runId=${runId}`)
  console.log(
    `  realDb     measuredCount=${realDbDigest.measuredCount} bytes=${realDbDigest.totalBytes} sha=${realDbDigest.treeSha256.slice(0, 16)}…`
  )
  console.log(
    `  sourceTree measuredCount=${sourceTree.measuredCount} bytes=${sourceTree.totalBytes} sha=${sourceTree.treeSha256.slice(0, 16)}…`
  )
  console.log(
    `  evidence=${counters.evidenceEntries}（缺路径 ${counters.evidenceEntriesMissingPath}）· chainSegments=${counters.chainSegments}（缺文件 ${counters.chainEntryFilesMissing}）`
  )
  console.log(`  verdict=${baseline.verdict}（after 采样后再定案）`)
}

/** `digestTree` 的算法原文 —— 两个不同对象必须各带各的定义，禁止混用 */
const REAL_DB_DEFINITION =
  '真实库内容树摘要（INC-01 冻结算法，唯一实现 `digestTree()`）：相对路径 ordinal 升序 → ' +
  '每行 `${rel}\\t${size}\\t${sha256(内容)}\\n` → 整段 UTF-8 求 sha256；默认排除 postmaster.pid；' +
  'measuredCount = 0 ⇒ 抛 MeasurementInvalidError。'

/** `baseline.json` 里指向 sidecar 原像文件的形状（**不含** perFile，避免 260KB 内联） */
interface SourceTreeDigestShape {
  definition: string
  measuredCount: number
  totalBytes: number
  treeSha256: string
  excludedPrefixes: string[]
  indexFile: string
  indexSha256: string
}

function summarizeSourceTree(digest: SourceTreeDigest, indexFile: string): SourceTreeDigestShape {
  return {
    definition: digest.definition,
    measuredCount: digest.measuredCount,
    totalBytes: digest.totalBytes,
    treeSha256: digest.treeSha256,
    excludedPrefixes: digest.excludedPrefixes,
    indexFile,
    indexSha256: createHash('sha256').update(digest.lines.join(''), 'utf8').digest('hex'),
  }
}

/** 把 sidecar 原像解析回 perFile（`rel\tsize\tsha256` + `\n`，就是摘要算法的输入格式） */
function parseSourceTreeIndex(text: string): Map<string, { size: number; sha256: string }> {
  const map = new Map<string, { size: number; sha256: string }>()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const parts = line.split('\t')
    if (parts.length !== 3) {
      throw new MeasurementInvalidError(
        `MEASUREMENT INVALID：源码树索引行格式坏了（期望 3 段，收到 ${parts.length}）：${line.slice(0, 80)}`
      )
    }
    const [rel, size, sha256] = parts as [string, string, string]
    map.set(rel, { size: Number(size), sha256 })
  }
  if (map.size === 0) {
    // 这正是 AGENTS §6.8 记录过的真实事故形态：清单格式坏掉 ⇒ 解析出 0 条 ⇒ 看起来"全部一致"
    throw new MeasurementInvalidError('MEASUREMENT INVALID：源码树索引解析出 0 条记录')
  }
  return map
}

/** 重算 sidecar 原像的摘要，用来证明"索引文件本身没被改过" */
function digestOfIndexLines(map: Map<string, { size: number; sha256: string }>): string {
  const lines = [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([rel, info]) => `${rel}\t${info.size}\t${info.sha256}\n`)
  return createHash('sha256').update(lines.join(''), 'utf8').digest('hex')
}

/**
 * 真实库的 mtime 观测（**只读 stat，不打开 PGlite**）。
 *
 * 内容树摘要回答"字节变没变"，mtime 回答"有没有人碰过" —— 两件事都必须记，
 * 因为"mtime 变了但摘要没变"与"摘要变了"是不同的处置路径（见 OQ-1）。
 */
function readRealDbMtimes(root: string): {
  newestMtime: string | null
  oldestMtime: string | null
  newestFiles: { path: string; mtime: string }[]
  filesNewerThanShortWindow: number
  filesNewerThanLongWindow: number
  volatileExcluded: string[]
} {
  const base = join(root, REAL_DB_DIR)
  if (!existsSync(base)) {
    return {
      newestMtime: null,
      oldestMtime: null,
      newestFiles: [],
      filesNewerThanShortWindow: 0,
      filesNewerThanLongWindow: 0,
      volatileExcluded: [],
    }
  }
  const entries: { rel: string; mtimeMs: number; mtime: string }[] = []
  const walk = (dir: string): void => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, dirent.name)
      if (dirent.isDirectory()) {
        walk(abs)
        continue
      }
      if (!dirent.isFile()) continue
      const stat = statSync(abs)
      entries.push({
        rel: relative(base, abs).split(/[\\/]/).join('/'),
        mtimeMs: stat.mtimeMs,
        mtime: stat.mtime.toISOString(),
      })
    }
  }
  walk(base)
  const volatile = entries.filter((entry) => VOLATILE_REAL_DB_PATHS.includes(entry.rel))
  const stable = entries.filter((entry) => !VOLATILE_REAL_DB_PATHS.includes(entry.rel))
  const sorted = [...stable].sort((a, b) => b.mtimeMs - a.mtimeMs)
  const shortCutoff = Date.now() - RECENT_WINDOW_HOURS * 3600 * 1000
  const longCutoff = Date.now() - LONG_WINDOW_HOURS * 3600 * 1000
  return {
    newestMtime: sorted[0]?.mtime ?? null,
    oldestMtime: sorted[sorted.length - 1]?.mtime ?? null,
    newestFiles: sorted.slice(0, 5).map((entry) => ({ path: entry.rel, mtime: entry.mtime })),
    filesNewerThanShortWindow: stable.filter((entry) => entry.mtimeMs >= shortCutoff).length,
    filesNewerThanLongWindow: stable.filter((entry) => entry.mtimeMs >= longCutoff).length,
    volatileExcluded: volatile.map((entry) => `${entry.rel}（易失运行态，摘要已排除）`),
  }
}

/** 与 `VOLATILE_EXCLUDED_PATHS` 是**同一个常量**（import 进来，不另抄一份） */
const VOLATILE_REAL_DB_PATHS: readonly string[] = VOLATILE_EXCLUDED_PATHS

interface CounterInput {
  evidence: EvidenceReading[] | undefined
  realDbDigest: TreeDigest
  sourceTree: SourceTreeDigest
  gitState: GitState
  concurrency: ConcurrencyReading
  envKeyCount: number
  chainMissing: number
  selfTestFailures: number
  sourceTreeDiff: { changedFiles: TreeDiffEntry[]; unexpected: number } | undefined
}

function buildCounters(input: CounterInput): Record<string, number> {
  const evidence = input.evidence ?? []
  const shortWindow = input.concurrency.windows.find((w) => w.hours === RECENT_WINDOW_HOURS)
  const longWindow = input.concurrency.windows.find((w) => w.hours === LONG_WINDOW_HOURS)
  return {
    evidenceEntries: evidence.length,
    evidenceEntriesWithPath: evidence.filter((entry) => entry.path !== null).length,
    evidenceEntriesMissingPath: evidence.filter((entry) => entry.missing && entry.path !== null).length,
    supersededEntries: evidence.filter((entry) => entry.status === 'superseded').length,
    unverifiedEntries: evidence.filter((entry) => entry.status === 'unverified').length,
    digestRealDbFiles: input.realDbDigest.measuredCount,
    digestRealDbBytes: input.realDbDigest.totalBytes,
    digestSourceTreeFiles: input.sourceTree.measuredCount,
    digestSourceTreeBytes: input.sourceTree.totalBytes,
    chainSegments: CHAIN_MAP.length,
    chainEntryFiles: CHAIN_MAP.flatMap((segment) => segment.entryFiles).length,
    chainEntryFilesMissing: input.chainMissing,
    envKeysRead: input.envKeyCount,
    dirtyPaths: input.gitState.dirtyPaths.length,
    unknownDirtyPaths: input.gitState.unknownDirtyPaths,
    stashCount: input.gitState.stashCount,
    recentModifiedFilesShortWindow: shortWindow?.files.length ?? 0,
    recentModifiedFilesLongWindow: longWindow?.files.length ?? 0,
    sourceTreeUnexpectedChanges: input.sourceTreeDiff?.unexpected ?? 0,
    measurementSelfTestFailures: input.selfTestFailures,
  }
}

/**
 * after 阶段**只能**改变这些计数。
 *
 * 证据索引 / 链路图 / env / git 身份是 before 阶段已经落盘的事实，重算会把它们
 * 清成 0，进而让 `computeVerdict` 报出假的 `MEASUREMENT INVALID`。
 */
function buildAfterCounters(input: {
  realDbDigest: TreeDigest
  sourceTree: SourceTreeDigest
  gitState: GitState
  concurrency: ConcurrencyReading
  sourceTreeDiff: { changedFiles: TreeDiffEntry[]; unexpected: number }
}): Record<string, number> {
  const full = buildCounters({
    evidence: undefined,
    realDbDigest: input.realDbDigest,
    sourceTree: input.sourceTree,
    gitState: input.gitState,
    concurrency: input.concurrency,
    envKeyCount: 0,
    chainMissing: 0,
    selfTestFailures: 0,
    sourceTreeDiff: input.sourceTreeDiff,
  })
  const keys = [
    'digestRealDbFiles',
    'digestRealDbBytes',
    'digestSourceTreeFiles',
    'digestSourceTreeBytes',
    'sourceTreeUnexpectedChanges',
    'recentModifiedFilesShortWindow',
    'recentModifiedFilesLongWindow',
    'dirtyPaths',
    'unknownDirtyPaths',
    'stashCount',
    'measurementSelfTestFailures',
  ] as const
  const out: Record<string, number> = {}
  for (const key of keys) out[key] = full[key] ?? 0
  return out
}

function computeVerdict(
  counters: Record<string, number>,
  realDbUnchanged: boolean,
  diff: { changedFiles: TreeDiffEntry[]; unexpected: number }
): string {
  if (counters.evidenceEntries === undefined || counters.evidenceEntries < 10) {
    return 'MEASUREMENT INVALID'
  }
  if (counters.digestRealDbFiles === 0) return 'MEASUREMENT INVALID'
  if (counters.digestSourceTreeFiles === 0) return 'MEASUREMENT INVALID'
  if ((counters.measurementSelfTestFailures ?? 0) > 0) return 'MEASUREMENT INVALID'
  if (diff.unexpected > 0) return 'PARTIAL'
  if (!realDbUnchanged) return 'PARTIAL'
  return 'BASELINE CAPTURED'
}

function safeHash(abs: string): string | null {
  return existsSync(abs) ? sha256OfFile(abs) : null
}

function safeVersion(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/*
 * 顶层失败关闭：任何异常都以**非零退出码**收场并打印干净的错误行，
 * 不留一个"看起来跑完了"的半成品证据目录。
 */
try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[m6-wp0] 失败关闭：${message}`)
  if (error instanceof MeasurementInvalidError) {
    console.error('[m6-wp0] 这是 MEASUREMENT INVALID，不是 PASS')
  }
  process.exit(2)
}
