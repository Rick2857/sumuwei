/**
 * Lv2 WP0 —— 当前基线（只读盘点）。
 *
 * ============================================================================
 *  这一份要回答什么（`docs/lv2/Lv2-Acceptance-Plan.md` §7 的 WP0 行）
 * ============================================================================
 *   「HEAD/工作树/共享文件、配置、现有命令、最新门与技术债接收表」
 *   「逐项区分 PASS/FAIL/INVALID/NOT RUN；指向当案来源，**无模型请求**」
 *
 * 于是本脚本**只做四件事**，每一件都落成机器可读读数：
 *
 *   ① 候选身份：HEAD / 分支 / 编制快照关系 / 工作树（含共享文件）与它们的指纹；
 *   ② 配置：`.env` 里每个 `CHARACTER_*` 开关的**文件值 / 生效值 / 代码缺省 / 声明值**，
 *      声明值逐条来自各阶段的激活载体（ADR / 激活记录）；不在白名单里的键 = 未声明差异；
 *   ③ 现有命令：`lv2:*` 入口登记状态（计划 §11.1 的五个候选**现在一个都不存在**，
 *      如实记为 NOT IMPLEMENTED，而不是"待补"）+ 三条发布命令是否在案；
 *   ④ 最新门：对**既有各阶段只读聚合门**跑一遍（它们各自会重算"当前适用性"），
 *      把 stdout 原文、退出码与它们自己写的汇总文件一并留档。
 *
 * ⚠️ **零模型请求**（`requests.planned = actual = 0`）· **零数据库打开**
 *    （不 import 任何 persistence / sandbox 模块；`cleanClose = null` 并给出具名理由）。
 * ⚠️ 聚合门会**重写它们自己的汇总文件**（这是它们的既有行为）。本脚本因此：
 *    运行前记录 `artifacts/**` 的 git 状态 → 运行后把**新变脏**的那些文件
 *    内容复制进本 run 目录（`summaries/`）→ 把白名单记进清单。
 *    「跑门 → 还原历史证据」的白名单还原本身由会话按 `AGENTS.md` §7 执行，
 *    本脚本不替会话做 `git checkout`。
 *
 * 用法：`pnpm lv2:baseline`（可选 `--skip-gates` 只做身份/配置/入口盘点）。
 */

import 'dotenv/config'

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readKernelFlags, type KernelFlags } from '../src/kernel/app/flags.ts'
import { createLv2RunId, openLv2RunDir, writeLv2Manifest } from './lv2-evidence.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const TSC_CLI = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

/** 本计划书的编制快照（计划书 §0 抬头逐字记录的那一个）。 */
const PLAN_SNAPSHOT = '58578f8c67eafea6c1efc7571f3efdf8b0935893'

const skipGates = process.argv.includes('--skip-gates')

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const sha256Hex = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const fileSha = (path: string): string => sha256Hex(readFileSync(path))
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
const toPosix = (path: string): string => path.split(/[\\/]/).join('/')
const slug = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, '-')

/**
 * 读出某个 git 命令的全部输出行（空输出 ⇒ 空数组）。
 *
 * ⚠️ **刻意不 trim 整个输出**：`git status --porcelain` 的第一行以状态码开头，
 *    其中一格可能是**空格**（例如 ` M .gitignore`）。对整个字符串 `.trim()` 会把
 *    这个前导空格吃掉 ⇒ 第一行的 `slice(3)` 少切一个字符 ⇒ 路径静默变成 `gitignore`。
 *    （这是本脚本开发时真踩到的坑：清单里出现了不存在的路径 `gitignore`。）
 */
function gitLines(...args: string[]): string[] {
  const out = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  return out.split(/\r?\n/).filter((line) => line.trim() !== '')
}

/**
 * `git status --porcelain --untracked-files=all` 的路径列表。
 *
 * ⚠️ **刻意排除 `artifacts/lv2/`**：那是本里程碑自己的证据目录，
 *    跑一次就会多一个未跟踪的 run 目录 —— 若把它算进来，
 *    ① "刷新前 artifacts 干净"这条自检从第二次起永远为假（自指），
 *    ② "本次新变脏的路径"会把 run 目录自己复制进自己（无限自指）。
 */
function statusPaths(...pathspec: string[]): string[] {
  const lines = gitLines('status', '--porcelain', '--untracked-files=all', '--', ...pathspec)
  return lines
    .map((line) => toPosix(line.slice(3).trim()))
    .filter((path) => path !== '' && !path.startsWith('artifacts/lv2/'))
}

// ---------------------------------------------------------------------------
// ① 候选身份
// ---------------------------------------------------------------------------

interface Check {
  readonly id: string
  readonly ok: boolean
  readonly detail: string
}

const checks: Check[] = []

const head = git('rev-parse', 'HEAD')
const headShort = head.slice(0, 12)
const branch = git('branch', '--show-current')
const headSubject = git('log', '-1', '--pretty=%s')

const planSnapshotExists = (() => {
  try {
    git('cat-file', '-e', `${PLAN_SNAPSHOT}^{commit}`)
    return true
  } catch {
    return false
  }
})()
const planSnapshotIsAncestor = planSnapshotExists
  ? spawnSync('git', ['merge-base', '--is-ancestor', PLAN_SNAPSHOT, 'HEAD'], { cwd: ROOT }).status === 0
  : false
const commitsSincePlanSnapshot = planSnapshotIsAncestor
  ? Number(git('rev-list', '--count', `${PLAN_SNAPSHOT}..HEAD`))
  : null

checks.push({
  id: 'plan-snapshot-reachable',
  ok: planSnapshotExists,
  detail: planSnapshotExists
    ? `编制快照 ${PLAN_SNAPSHOT.slice(0, 12)} 在本库里；是 HEAD 的祖先：${String(planSnapshotIsAncestor)}；相距 ${String(commitsSincePlanSnapshot)} 个提交`
    : `编制快照 ${PLAN_SNAPSHOT.slice(0, 12)} 在本库里**不存在**`,
})

const allStatusLines = gitLines('status', '--porcelain', '--untracked-files=all')
const isLv2Evidence = (path: string): boolean => path.startsWith('artifacts/lv2/')
const untracked = allStatusLines
  .filter((line) => line.startsWith('?? '))
  .map((line) => toPosix(line.slice(3).trim()))
  .filter((path) => !isLv2Evidence(path))
const trackedModified = allStatusLines
  .filter((line) => !line.startsWith('?? '))
  .map((line) => toPosix(line.slice(3).trim()))
  .filter((path) => !isLv2Evidence(path))
const worktreeClean = trackedModified.length === 0 && untracked.length === 0

/**
 * 共享文件 —— 多会话共用同一工作树时最容易被别人整文件带走的那些。
 * 它们的指纹进 `sourceFingerprints`：读者据此判断"这份基线是在哪一棵树上量的"。
 */
const SHARED_FILES = [
  'package.json',
  'README.md',
  'AGENTS.md',
  'docs/Tech-Debt-Register.md',
  'docs/m6.5/M6.5-Lv2-Capability-Integration-Plan.md',
  'docs/research/Post-Lv2-Storyline-Embodiment-Realtime-Plan-2026-10-02.md',
  'docs/lv2/Lv2-Acceptance-Plan.md',
  'src/main.ts',
  'src/kernel/app/flags.ts',
] as const

const sharedFiles = SHARED_FILES.map((path) => ({
  path,
  present: existsSync(join(ROOT, path)),
  sha256: existsSync(join(ROOT, path)) ? fileSha(join(ROOT, path)) : null,
  dirtyInWorktree: statusPaths(path).length > 0,
}))
checks.push({
  id: 'shared-files-present',
  ok: sharedFiles.every((entry) => entry.present),
  detail: `${String(sharedFiles.filter((entry) => entry.present).length)}/${String(sharedFiles.length)} 个共享文件在案；改动中的：${
    sharedFiles
      .filter((entry) => entry.dirtyInWorktree)
      .map((entry) => entry.path)
      .join(' / ') || '无'
  }`,
})

const artifactsDirtyBefore = statusPaths('artifacts')
checks.push({
  id: 'artifacts-clean-before-refresh',
  ok: artifactsDirtyBefore.length === 0,
  detail:
    artifactsDirtyBefore.length === 0
      ? '刷新前 artifacts/**（不含 artifacts/lv2）无改动 ⇒ 本次新变脏的路径可归因于本脚本'
      : `刷新前 artifacts/** 已有 ${String(artifactsDirtyBefore.length)} 个改动（${artifactsDirtyBefore.slice(0, 5).join(' / ')}…）⇒ 新变脏的路径**不能**全部归因于本脚本`,
})

// ---------------------------------------------------------------------------
// ② 配置：文件值 / 生效值 / 代码缺省 / 声明值
// ---------------------------------------------------------------------------

/** 解析 `.env`（只做 KEY=VALUE，跳过注释与空行；**不**做变量展开 —— 本仓库不用）。 */
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const text = line.trim()
    if (text === '' || text.startsWith('#')) continue
    const eq = text.indexOf('=')
    if (eq <= 0) continue
    const key = text.slice(0, eq).trim()
    let value = text.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

const SECRET_KEY = /KEY|TOKEN|SECRET|PASSWORD/i
/** 密钥类字段**只报存在与长度**（按**键名**判定，不按取值 —— 取值里未必出现 KEY 这个词）。 */
const redact = (key: string, value: string | undefined): string =>
  value === undefined
    ? '<absent>'
    : SECRET_KEY.test(key)
      ? `<redacted len=${String(value.length)}>`
      : value

interface ConfigExpectation {
  readonly key: string
  /** 声明值（字符串比较；布尔写 'true'/'false'） */
  readonly expected: string
  /** 声明的载体（可追溯到具体 ADR / 激活记录） */
  readonly declaredBy: string
  readonly field: (flags: KernelFlags) => unknown
  /** 密钥类：只断言"存在"，不断言取值 */
  readonly secret?: boolean
}

/**
 * 声明配置白名单 —— **逐条来自各阶段的激活载体**，不是这里替用户决定的。
 * 任何一条对不上 ⇒ 基线不是"无未声明配置差异"（`LV2-G0` 的判据之一）。
 */
const CONFIG_WHITELIST: readonly ConfigExpectation[] = [
  { key: 'CHARACTER_WEB_SEARCH_ENABLED', expected: 'true', declaredBy: 'ADR-048（M5.5 生产激活）', field: (f) => f.webSearchEnabled },
  { key: 'CHARACTER_WEB_SEARCH_MODE', expected: 'auto_public', declaredBy: 'ADR-052（M5.5.1 auto_public 激活）', field: (f) => f.webSearchMode ?? 'INVALID' },
  { key: 'M55_TAVILY_SEARCH_API_KEY', expected: '<present>', declaredBy: 'ADR-054（provider 换代 Tavily）', field: () => '<not-a-flag>', secret: true },
  { key: 'CHARACTER_ROLLUP_TOKENS', expected: '400', declaredBy: 'ADR-052（M6 摘要激活）', field: (f) => f.rollupTokens },
  { key: 'CHARACTER_RELATIONSHIP_CONTEXT_ENABLED', expected: 'true', declaredBy: 'ADR-065（M7 生产激活）', field: (f) => f.relationshipContextEnabled },
  { key: 'CHARACTER_AFFECT_CONTEXT_ENABLED', expected: 'true', declaredBy: 'ADR-067（M8 生产激活）', field: (f) => f.affectContextEnabled },
  { key: 'CHARACTER_AFFECT_SEMANTIC_MODE', expected: 'semantic', declaredBy: 'ADR-069（M8.5 生产激活）', field: (f) => f.affectSemanticMode },
  { key: 'CHARACTER_BELIEF_ENABLED', expected: 'true', declaredBy: 'ADR-071（M9 生产激活）', field: (f) => f.beliefEnabled },
  { key: 'CHARACTER_MEMORY_RESTATEMENT_ENABLED', expected: 'true', declaredBy: 'ADR-073（M9.1 生产激活）', field: (f) => f.memoryRestatementRevivalEnabled },
  { key: 'CHARACTER_WITHDRAWN_CONTEXT_MASKING_ENABLED', expected: 'true', declaredBy: 'ADR-073（M9.1 生产激活）', field: (f) => f.withdrawnContextMaskingEnabled },
  { key: 'CHARACTER_MEMORY_SEMANTIC_ENABLED', expected: 'true', declaredBy: 'ADR-075（M9.5 生产激活）', field: (f) => f.memorySemanticRecallEnabled },
  { key: 'CHARACTER_MEMORY_SEMANTIC_MODE', expected: 'on', declaredBy: 'ADR-082（M9.5 切 on）', field: (f) => f.memorySemanticMode },
  { key: 'CHARACTER_GOALS_ENABLED', expected: 'true', declaredBy: 'ADR-077（M10 生产激活）', field: (f) => f.goalsEnabled },
  { key: 'CHARACTER_GOAL_TOKENS', expected: '300', declaredBy: 'M10.1-Activation-Record', field: (f) => f.goalTokens },
  { key: 'CHARACTER_COMMITMENT_TOKENS', expected: '300', declaredBy: 'M10.1-Activation-Record', field: (f) => f.commitmentTokens },
  { key: 'CHARACTER_REFLECTION_ENABLED', expected: 'true', declaredBy: 'M11-Activation-Record', field: (f) => f.reflectionEnabled },
  { key: 'CHARACTER_ADAPTIVE_SELF_ENABLED', expected: 'true', declaredBy: 'M11-Activation-Record', field: (f) => f.adaptiveSelfEnabled },
  { key: 'CHARACTER_ADAPTIVE_SELF_TOKENS', expected: '300', declaredBy: 'M11-Activation-Record', field: (f) => f.adaptiveSelfTokens },
  // 已接线但**未激活**（M10.1 WP2b 的慢路径；代码缺省 off）—— 声明值就是代码缺省。
  { key: 'CHARACTER_AGREEMENT_ENABLED', expected: 'false', declaredBy: 'ADR-086 WP2b（已接线、未激活）', field: (f) => f.agreementEnabled },
]

const envFile = readEnvFile(join(ROOT, '.env'))
const envTestFile = readEnvFile(join(ROOT, '.env.test'))
const effectiveFlags = readKernelFlags(process.env)
const defaultFlags = readKernelFlags({})

const configRows = CONFIG_WHITELIST.map((entry) => {
  const fileValue = envFile[entry.key]
  const presence = (value: string | undefined): string =>
    value === undefined || value === '' ? '<absent>' : '<present>'
  const effective = entry.secret ? presence(fileValue) : String(entry.field(effectiveFlags))
  const codeDefault = entry.secret ? null : String(entry.field(defaultFlags))
  const fileReading = entry.secret ? presence(fileValue) : (fileValue ?? null)
  // 未写进 `.env` 的键：只有当"声明值 = 代码缺省"时才不算差异（否则就是未声明的激活缺失）。
  const absentIsAcceptable = codeDefault !== null && codeDefault === entry.expected
  const matchesDeclaration =
    fileValue === undefined
      ? absentIsAcceptable
      : entry.secret
        ? presence(fileValue) === entry.expected
        : fileValue === entry.expected
  const effectiveMatchesDeclaration = entry.secret
    ? presence(fileValue) === entry.expected
    : effective === entry.expected
  return {
    key: entry.key,
    declaredBy: entry.declaredBy,
    expected: entry.expected,
    envFile: entry.secret ? redact(entry.key, fileValue) : fileReading,
    effective: entry.secret ? redact(entry.key, fileValue) : effective,
    codeDefault,
    matchesDeclaration,
    effectiveMatchesDeclaration,
  }
})

const configMismatches = configRows.filter((row) => !row.matchesDeclaration)
checks.push({
  id: 'config-matches-declarations',
  ok: configMismatches.length === 0,
  detail:
    configMismatches.length === 0
      ? `${String(configRows.length)} 个声明开关逐条与激活载体一致`
      : `${String(configMismatches.length)} 个开关与声明不符：${configMismatches
          .map((row) => `${row.key}(期望 ${row.expected}，文件 ${String(row.envFile)}，生效 ${row.effective})`)
          .join('；')}`,
})

const undeclaredCharacterKeys = Object.keys(envFile)
  .filter((key) => key.startsWith('CHARACTER_'))
  .filter((key) => !CONFIG_WHITELIST.some((entry) => entry.key === key))
checks.push({
  id: 'no-undeclared-character-keys',
  ok: undeclaredCharacterKeys.length === 0,
  detail:
    undeclaredCharacterKeys.length === 0
      ? '`.env` 里没有白名单之外的 CHARACTER_* 键'
      : `.env 里有 ${String(undeclaredCharacterKeys.length)} 个未声明键：${undeclaredCharacterKeys.join(' / ')}`,
})

const effectiveDiverges = configRows.filter(
  (row) => !row.effectiveMatchesDeclaration && row.matchesDeclaration,
)
checks.push({
  id: 'no-shell-override-of-declared-config',
  ok: effectiveDiverges.length === 0,
  detail:
    effectiveDiverges.length === 0
      ? '声明值与进程生效值一致（没有 shell 覆盖 .env）'
      : `进程里生效值与 .env 声明不一致：${effectiveDiverges.map((row) => row.key).join(' / ')}`,
})

// ---------------------------------------------------------------------------
// ③ 现有命令（入口登记状态）
// ---------------------------------------------------------------------------

interface PackageJson {
  readonly scripts: Record<string, string>
}
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as PackageJson
const scriptNames = Object.keys(pkg.scripts)

const lv2Entries = scriptNames.filter((name) => name.startsWith('lv2:')).sort()
/** 计划 §11.1 逐字登记的五个候选入口（**现在未实现、未注册** —— 不预造空脚本）。 */
const PLANNED_LV2_ENTRIES = [
  'lv2:measurement:verify',
  'lv2:core:verify',
  'lv2:smoke:live',
  'lv2:long:live',
  'lv2:gates',
] as const
checks.push({
  id: 'lv2-entry-registration',
  ok: lv2Entries.length > 0,
  detail: `已登记 ${String(lv2Entries.length)} 个 lv2:* 入口：${lv2Entries.join(' / ') || '无'}；计划 §11.1 的候选入口状态：${PLANNED_LV2_ENTRIES.map(
    (name) => `${name}=${scriptNames.includes(name) ? 'REGISTERED' : 'NOT IMPLEMENTED'}`,
  ).join(' · ')}`,
})

const RELEASE_COMMANDS = ['typecheck', 'm4.5:ci', 'm4.5:ci:full'] as const
checks.push({
  id: 'release-commands-present',
  ok: RELEASE_COMMANDS.every((name) => scriptNames.includes(name)),
  detail: `发布命令：${RELEASE_COMMANDS.map((name) => `${name}=${scriptNames.includes(name) ? 'present' : 'MISSING'}`).join(' · ')}`,
})

// ---------------------------------------------------------------------------
// ④ 权威输入（计划 §2 的表）
// ---------------------------------------------------------------------------

const PLAN_INPUTS = [
  'docs/architecture/invariants.md',
  'docs/architecture/memory-invariants.md',
  'docs/architecture/future-compatibility.md',
  'docs/m10.1/M10.1-Acceptance-Contract.md',
  'docs/m10.1/M10.1-Gate-Decision.md',
  'docs/m11.1/M11.1-Acceptance-Contract.md',
  'docs/m11.1/M11.1-Deferred-Issues-and-Repair-Guide.md',
  'docs/m11.1/M11.1-Debt-and-Decision-Audit.md',
  'docs/Tech-Debt-Register.md',
  'docs/research/Post-Lv2-Storyline-Embodiment-Realtime-Plan-2026-10-02.md',
  'docs/lv2/Lv2-Acceptance-Plan.md',
] as const

const planInputs = PLAN_INPUTS.map((path) => ({
  path,
  present: existsSync(join(ROOT, path)),
  sha256: existsSync(join(ROOT, path)) ? fileSha(join(ROOT, path)) : null,
}))
checks.push({
  id: 'plan-inputs-present',
  ok: planInputs.every((entry) => entry.present),
  detail: `${String(planInputs.filter((entry) => entry.present).length)}/${String(planInputs.length)} 份权威输入在案`,
})

// ---------------------------------------------------------------------------
// ⑤ 最新门：既有只读聚合门重跑（各门自己重算"当前适用性"）
// ---------------------------------------------------------------------------

interface AggregatorSpec {
  readonly id: string
  readonly entry: string | null
  readonly note: string
}

const AGGREGATORS: readonly AggregatorSpec[] = [
  { id: 'm4.5:gates', entry: 'scripts/m4.5-gate-results.ts', note: 'M4.5 行动链门汇总' },
  { id: 'm5:gates', entry: 'scripts/m5-gate-results.ts', note: 'M5 召回门汇总' },
  { id: 'm5.1:gates', entry: 'scripts/m5.1-gate-results.ts', note: 'M5.1 开发者平面十二门' },
  { id: 'm5.1.1:gates', entry: 'scripts/m5.1.1-gate-results.ts', note: 'M5.1.1 归因九门' },
  { id: 'm5.5:gates', entry: 'scripts/m5.5-gate-results.ts', note: 'M5.5 联网查证五门' },
  { id: 'm5.5.1:gates', entry: 'scripts/m5.5.1-gates.ts', note: 'M5.5.1 搜索触发六门' },
  { id: 'm6:gates', entry: 'scripts/m6-gates.ts', note: 'M6 摘要来源边界' },
  { id: 'm6.1:gates', entry: 'scripts/m6.1-gates.ts', note: 'M6.1 假记忆边界' },
  { id: 'm7:gates', entry: 'scripts/m7-gates.ts', note: 'M7 关系状态' },
  { id: 'm8:gates', entry: 'scripts/m8-gates.ts', note: 'M8 情绪状态' },
  { id: 'm8.5:gates', entry: 'scripts/m8.5-gates.ts', note: 'M8.5 语义情绪' },
  { id: 'm9:gates', entry: 'scripts/m9-gates.ts', note: 'M9 信念与视角' },
  { id: 'm9.1:gates', entry: 'scripts/m9.1-gates.ts', note: 'M9.1 复活与遗忘遮蔽' },
  { id: 'm9.5:gates', entry: 'scripts/m9.5-gates.ts', note: 'M9.5 语义记忆召回' },
  { id: 'm9.6:gates', entry: 'scripts/m9.6-gates.ts', note: 'M9.6 语义判定' },
  { id: 'm10:gates', entry: 'scripts/m10-gates.ts', note: 'M10 目标与承诺' },
  { id: 'm10.1:gates', entry: 'scripts/m10.1-gates.ts', note: 'M10.1 约定桥与结清' },
  { id: 'm11:gates', entry: 'scripts/m11-gates.ts', note: 'M11 反思与有限行为调整' },
  { id: 'm11.1:gates', entry: 'scripts/m11.1-gates.ts', note: 'M11.1 来源生命周期与联调' },
  { id: 'inc-01:gates', entry: 'scripts/inc-01-gates.ts', note: 'INC-01 预防控制' },
  { id: 'typecheck', entry: null, note: 'tsc --noEmit（当前源码可编译性）' },
]

interface GateReading {
  readonly id: string
  readonly note: string
  readonly argv: string[]
  readonly exitCode: number | null
  readonly startedAt: string
  readonly endedAt: string
  readonly stdoutPath: string
  readonly stdoutSha256: string
  readonly lastLine: string
  readonly machineSummary: unknown
}

const runDir = openLv2RunDir(ROOT, createLv2RunId({ wpId: 'wp0', headShort }))
mkdirSync(join(runDir, 'logs'), { recursive: true })
mkdirSync(join(runDir, 'summaries'), { recursive: true })

const startedAt = new Date().toISOString()
const readings: GateReading[] = []

if (!skipGates) {
  for (const spec of AGGREGATORS) {
    const argv =
      spec.entry === null
        ? [process.execPath, TSC_CLI, '--noEmit']
        : [process.execPath, TSX_CLI, spec.entry]
    const gateStart = new Date().toISOString()
    const result = spawnSync(argv[0]!, argv.slice(1), {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
      env: process.env,
    })
    const gateEnd = new Date().toISOString()
    const stdout = `${result.stdout ?? ''}${result.stderr ?? ''}`
    const stdoutPath = `logs/${slug(spec.id)}.txt`
    writeFileSync(
      join(runDir, stdoutPath),
      `# ${spec.id}  (${spec.note})\n# argv: ${argv.join(' ')}\n# exit: ${String(result.status)}\n\n${stdout}`,
      'utf8',
    )
    const nonEmpty = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
    let machineSummary: unknown = null
    try {
      machineSummary = JSON.parse(stdout) as unknown
    } catch {
      machineSummary = null
    }
    readings.push({
      id: spec.id,
      note: spec.note,
      argv,
      exitCode: result.status,
      startedAt: gateStart,
      endedAt: gateEnd,
      stdoutPath,
      stdoutSha256: sha256Hex(stdout),
      lastLine: nonEmpty.length > 0 ? (nonEmpty[nonEmpty.length - 1] ?? '') : '',
      machineSummary,
    })
    checks.push({
      id: `aggregator-ran:${spec.id}`,
      ok: result.status !== null,
      detail:
        result.status === null
          ? `没能跑起来（signal=${String(result.signal)}，error=${String(result.error?.message)}）`
          : `退出码 ${String(result.status)}；stdout 原文见 ${stdoutPath}`,
    })
    console.log(
      `[lv2:baseline] ${spec.id.padEnd(16)} exit=${String(result.status)}  ${nonEmpty[nonEmpty.length - 1] ?? ''}`.slice(
        0,
        200,
      ),
    )
  }
}

// 聚合门会重写它们自己的汇总文件 —— 把"新变脏"的路径内容复制进本 run 目录
const artifactsDirtyAfter = statusPaths('artifacts')
const beforeSet = new Set(artifactsDirtyBefore)
const newlyTouched = artifactsDirtyAfter.filter((path) => !beforeSet.has(path))
const summaries: {
  path: string
  copiedTo: string | null
  sha256: string | null
  bytes: number | null
}[] = []
for (const path of newlyTouched) {
  const abs = join(ROOT, path)
  const entry: { path: string; copiedTo: string | null; sha256: string | null; bytes: number | null } = {
    path,
    copiedTo: null,
    sha256: null,
    bytes: null,
  }
  if (existsSync(abs) && statSync(abs).isFile()) {
    const size = statSync(abs).size
    entry.bytes = size
    entry.sha256 = fileSha(abs)
    if (size <= 2 * 1024 * 1024) {
      const target = `summaries/${toPosix(relative(ROOT, abs)).replace(/[\\/]/g, '__')}`
      copyFileSync(abs, join(runDir, target))
      entry.copiedTo = target
    }
  }
  summaries.push(entry)
}

const endedAt = new Date().toISOString()

// ---------------------------------------------------------------------------
// 清单
// ---------------------------------------------------------------------------

const failed = checks.filter((check) => !check.ok)
const sourceFingerprints: Record<string, string> = {}
for (const entry of sharedFiles) {
  if (entry.sha256 !== null) sourceFingerprints[entry.path] = entry.sha256
}
for (const entry of planInputs) {
  if (entry.sha256 !== null) sourceFingerprints[entry.path] = entry.sha256
}

const verdict = failed.length === 0 ? 'BASELINE CAPTURED' : 'BASELINE MISMATCH'
const runId = runDir.split(/[\\/]/).pop()!

const manifest: Record<string, unknown> = {
  runId,
  wp: 'wp0',
  head,
  headShort,
  branch,
  date: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
  toolVersions: {
    node: process.version,
    platform: process.platform,
    tsx: existsSync(TSX_CLI) ? 'present' : 'MISSING',
    git: git('--version'),
  },
  testType: 'wp0-baseline',
  counts: {
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
  },
  phases: ['single'],
  supersedes: null,
  started: startedAt,
  ended: endedAt,
  worktree: {
    clean: worktreeClean,
    headSubject,
    trackedModified,
    untracked,
    artifactsDirtyBefore,
    artifactsDirtyAfter,
    attribution:
      '本次新变脏的 artifacts 路径见 summaries[]；历史证据的还原按 AGENTS.md §7 的白名单纪律由会话执行',
  },
  planSnapshot: {
    commit: PLAN_SNAPSHOT,
    exists: planSnapshotExists,
    isAncestorOfHead: planSnapshotIsAncestor,
    commitsSince: commitsSincePlanSnapshot,
  },
  sharedFiles,
  sourceFingerprints,
  config: {
    envFile: '.env',
    envTestFilePresent: existsSync(join(ROOT, '.env.test')),
    rows: configRows,
    undeclaredCharacterKeys,
    informational: {
      USER_NAME: envFile.USER_NAME ?? null,
      CONVERSATION_LENGTH: envFile.CONVERSATION_LENGTH ?? null,
      DEBUG_CONTEXT: envFile.DEBUG_CONTEXT ?? null,
      PGLITE_DATA_DIR: envFile.PGLITE_DATA_DIR ?? null,
      LOG_LEVEL: envFile.LOG_LEVEL ?? null,
    },
  },
  model: {
    chatBaseUrlHost: hostOf(envFile.OPENAI_BASE_URL),
    chatLargeModel: envFile.OPENAI_LARGE_MODEL ?? null,
    chatSmallModel: envFile.OPENAI_SMALL_MODEL ?? null,
    chatKey: redact('OPENAI_API_KEY', envFile.OPENAI_API_KEY),
    testEndpointPresent: Object.keys(envTestFile).length > 0,
    testBaseUrlHost: hostOf(envTestFile.OPENAI_BASE_URL),
    testLargeModel: envTestFile.OPENAI_LARGE_MODEL ?? null,
    testSmallModel: envTestFile.OPENAI_SMALL_MODEL ?? null,
    testKey: redact('OPENAI_API_KEY', envTestFile.OPENAI_API_KEY),
  },
  requests: {
    planned: 0,
    actual: 0,
    note: 'WP0 是只读盘点：不发任何模型请求（计划 §7 WP0 出口逐字要求）',
  },
  denominators: {
    inventoryChecks: checks.length,
    configKeysDeclared: configRows.length,
    sharedFiles: sharedFiles.length,
    planInputs: planInputs.length,
    aggregatorsPlanned: AGGREGATORS.length,
    aggregatorsRan: readings.filter((reading) => reading.exitCode !== null).length,
    aggregatorsSkipped: skipGates ? AGGREGATORS.length : 0,
    realConversationTurns: 0,
    cases: 0,
  },
  correlations: { cases: 0, conversations: 0, requests: 0, traces: 0 },
  faultInjection: null,
  cleanClose: null,
  realDb: {
    opened: false,
    summaryBefore: null,
    summaryAfter: null,
    note: '本脚本不 import 任何 persistence / sandbox 模块，也没有打开真实库 ⇒ 没有可关闭的连接（cleanClose=null 是这一条的具名理由，不是缺省省略）',
  },
  checks,
  findings: failed.map((check) => ({ id: check.id, detail: check.detail })),
  gateReadings: readings,
  summaries,
  verdict,
  notes: [
    '聚合门会重写它们自己的汇总文件；本 run 目录里的 summaries/ 是那些文件在**本次刷新后**的内容副本。',
    '历史证据的还原（白名单还原）由会话按 AGENTS.md §7 执行，本脚本不替会话做 git checkout。',
    '本清单不含任何密钥取值：密钥类字段只报存在与长度。',
  ],
}

const manifestPath = writeLv2Manifest(runDir, manifest)

console.log('')
console.log(`[lv2:baseline] runId       = ${runId}`)
console.log(`[lv2:baseline] head        = ${head}`)
console.log(
  `[lv2:baseline] 盘点项      = ${String(checks.length)}（通过 ${String(checks.length - failed.length)} · 不符 ${String(failed.length)}）`,
)
console.log('[lv2:baseline] 模型请求    = 0（只读盘点）')
console.log('[lv2:baseline] 真实库打开  = false')
console.log(`[lv2:baseline] verdict     = ${verdict}`)
console.log(`[lv2:baseline] manifest    = ${toPosix(relative(ROOT, manifestPath))}`)
if (failed.length > 0) {
  console.log('[lv2:baseline] 不符项：')
  for (const check of failed) console.log(`  · ${check.id}: ${check.detail}`)
}
if (newlyTouched.length > 0) {
  console.log(
    `[lv2:baseline] 本次新变脏的 artifacts 路径 ${String(newlyTouched.length)} 个（内容已复制进 summaries/）：`,
  )
  for (const path of newlyTouched.slice(0, 20)) console.log(`  · ${path}`)
}
process.exitCode = failed.length === 0 ? 0 : 1

/** 从 URL 里取 host（拿不到就回 null）—— 配置读数里只放 host，不放完整 URL 的查询串。 */
function hostOf(url: string | undefined): string | null {
  if (url === undefined || url.trim() === '') return null
  try {
    return new URL(url).host
  } catch {
    return '<unparsable>'
  }
}
