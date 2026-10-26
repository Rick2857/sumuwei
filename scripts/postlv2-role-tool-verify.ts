/**
 * 角色自选工具（Role-Tool-Decision）验收 —— **WP0：目录与基线**。
 *
 * ============================================================================
 *  载体
 * ============================================================================
 * `docs/post-lv2/Role-Tool-Decision-Plan-2026-10-05.md` §6：
 * ```text
 * WP0  交付 = 完整工具/操作/参数目录、当前权限、来源指纹、新旧入口关系
 *      验证 = 登记表非空；每项工具均有覆盖；无遗漏或通用绕过接口
 * ```
 * 本脚本把 WP0 的验证做成**机器判据**（`src/kernel/action/tool-catalog.ts`），
 * 并把目录本身落成证据（同一份 JSON 也是 WP1 决策提示词的来源）。
 *
 * ```bash
 * pnpm postlv2:role-tool:verify                 # 跑全部门（默认写证据）
 * pnpm postlv2:role-tool:verify --print-catalog # 只打印 Markdown 目录表（不写证据）
 * pnpm postlv2:role-tool:verify --no-evidence   # 跑门但不落盘（开发中）
 * ```
 *
 * ⚠️ 三条纪律（AGENTS.md §6）：
 * ```text
 * ① 未运行 = NOT RUN，不是 PASS；本脚本没有 NOT RUN 档 —— 每条判据都必须真的跑
 * ② 计数型判据必须自检 measured_count > 0（"检查了 0 项、发现 0 处" ⇒ MEASUREMENT INVALID）
 * ③ 新量具一律走**正控 / 负控 / 恢复**三段式（只做正控与"什么都不检查"在输出上无法区分）
 * ```
 * ⚠️ 真实库 `data/pglite` **一次都不打开**：本脚本只做纯函数建表与静态检查，
 *    不需要数据库、不需要模型、不需要网络。
 */

import 'dotenv/config'

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createDocumentExtractionDefinitions } from '../src/kernel/contracts/document-reading.ts'
import {
  DEFAULT_GRANTED_PERMISSIONS,
  createCapabilityRegistry,
  createDefaultCapabilityDefinitions,
  type CapabilityDefinition,
  type CapabilityRegistry,
} from '../src/kernel/action/capability-registry.ts'
import {
  WEB_SEARCH_PERMISSION,
  createExternalEvidenceCapabilityDefinitions,
} from '../src/kernel/action/external-evidence-capability.ts'
import {
  DOCUMENT_READ_PERMISSION,
  IMAGE_OCR_PERMISSION,
  MATH_CALCULATE_PERMISSION,
  WEB_READ_PERMISSION,
  createUtilityCapabilityDefinitions,
} from '../src/kernel/action/utility-capabilities.ts'
import {
  LOCAL_FILE_LIST_PERMISSION,
  LOCAL_FILE_READ_PERMISSION,
  LOCAL_FILE_WRITE_PERMISSION,
  createLocalFileCapabilityDefinitions,
} from '../src/kernel/action/local-file-capabilities.ts'
import {
  WEATHER_QUERY_PERMISSION,
  createWeatherCapabilityDefinitions,
} from '../src/kernel/action/weather-capability.ts'
import { XIDIAN_PERMISSION, createXidianCapabilityDefinitions } from '../src/kernel/action/xidian-capability.ts'
import {
  OFFICE_GENERATE_PERMISSION,
  createOfficeCapabilityDefinitions,
} from '../src/kernel/action/office-capability.ts'
import {
  NEWS_READ_PERMISSION,
  createNewsCapabilityDefinitions,
} from '../src/kernel/action/news-capability.ts'
import {
  BROWSER_OPERATE_PERMISSION,
  BROWSER_READ_PERMISSION,
  createBrowserCapabilityDefinitions,
} from '../src/kernel/action/browser-capability.ts'
/*
 * ADR-106：桌面两件也进本门的登记表 —— 本门的"与 `main.ts` 同形"那条判据要求
 * **每个**工厂都在这里出现过（少一个 ⇒ 这里的目录就不是完整目录，
 * 而"不完整"与"全绿"在输出上长得一样）。
 */
import {
  DESKTOP_INSPECT_PERMISSION,
  DESKTOP_OPERATE_PERMISSION,
  createDesktopCapabilityDefinitions,
} from '../src/kernel/action/desktop-capability.ts'
/* post-Lv2 / ADR-110 `D05`：与本文件夹具同源（见 `buildRegistry` 与 `factories` 的注释） */
import { createQqProactiveCapabilityDefinitions } from '../src/kernel/action/qq-proactive-capability.ts'
import { createLearningCapabilityDefinitions, WORKFLOW_SKILL_PERMISSION, PERSONAL_LIBRARY_PERMISSION, ARXIV_PERMISSION } from '../src/kernel/action/learning-capabilities.ts'
import { TASK_ARG_KEYS } from '../src/kernel/action/task-plan.ts'
import { TURN_CONTENT_CAPABILITY_IDS } from '../src/kernel/action/turn-content-capabilities.ts'
import {
  FORBIDDEN_ARG_KEY_PATTERN,
  TOOL_GATE_KEYS,
  auditToolCatalog,
  buildToolCatalog,
  describeToolCatalog,
  renderToolCatalogForModel,
  toolAvailabilityLabel,
  type ToolCatalogEntry,
  type ToolGateKey,
} from '../src/kernel/action/tool-catalog.ts'
import {
  TOOL_DECISION_BRANCHES,
  TOOL_DECISION_MAX_QUESTION_CODEPOINTS,
  actionOfToolDecision,
  parseToolDecisionProposal,
  toSafeToolDecisionParseCode,
  validateToolDecisionProposal,
  type ToolDecisionParseCode,
} from '../src/kernel/action/tool-decision.ts'
import { readKernelFlags } from '../src/kernel/app/flags.ts'

const REPO_ROOT = resolve(process.cwd())
/** 公开证据（进仓库） */
const EVIDENCE_PARENT = 'artifacts/post-lv2/role-tool-decision'

/**
 * 来源指纹清单 —— "这份目录是从哪一版代码算出来的"。
 *
 * ⚠️ 只列**目录形状的真正来源**（BOM 三类 + 参数表 + 开关 + 本脚本）。
 *    加文件就要保证它真的参与了这个形状，否则指纹只是噪声。
 */
const SOURCE_FILES: readonly string[] = [
  'src/kernel/action/tool-catalog.ts',
  'src/kernel/action/tool-decision.ts',
  'src/kernel/action/capability-registry.ts',
  'src/kernel/action/task-plan.ts',
  'src/kernel/action/turn-content-capabilities.ts',
  'src/kernel/action/external-evidence-capability.ts',
  'src/kernel/action/utility-capabilities.ts',
  'src/kernel/action/learning-capabilities.ts',
  'src/kernel/action/local-file-capabilities.ts',
  'src/kernel/action/weather-capability.ts',
  'src/kernel/action/xidian-capability.ts',
  'src/kernel/action/office-capability.ts',
  'src/kernel/action/news-capability.ts',
  'src/kernel/action/browser-capability.ts',
  /* ADR-106：桌面能力（登记 + 开关在 flags.ts，适配器与 worker 属于它的"所有权"面） */
  'src/kernel/action/desktop-capability.ts',
  'src/infrastructure/action/adapters/desktop-control-assets.ts',
  'src/kernel/app/flags.ts',
  'src/main.ts',
  'scripts/postlv2-role-tool-verify.ts',
]

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function git(args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function sha256File(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function nowIso(): string {
  return new Date().toISOString()
}

function runIdOf(label: string): string {
  const stamp = nowIso().replace(/[-:]/g, '').replace(/\..+$/, '')
  const head = git(['rev-parse', '--short=8', 'HEAD']) || 'unknown'
  const suffix = createHash('sha256')
    .update(`${label}${stamp}${String(process.pid)}`)
    .digest('hex')
    .slice(0, 4)
  return `${label}-${stamp}-${head}-${suffix}`
}

/**
 * **与 `src/main.ts` 同形**的登记表（八个工厂，一处不少）。
 *
 * ⚠️ 这里重建而不是 import `main.ts`：`main.ts` 在模块顶层就
 *    `allowProductionDatabase()`（唯一允许打开真实库的入口），
 *    一个只做静态检查的脚本**绝不能**把它求值。
 *    "同形"由一条判据守着（`wp0-main-assembly-parity`：文本上核对八个工厂都出现过）。
 */
function buildRegistry(): CapabilityRegistry {
  return createCapabilityRegistry([
    ...createDefaultCapabilityDefinitions(),
    ...createLearningCapabilityDefinitions(),
    ...createExternalEvidenceCapabilityDefinitions(),
    ...createUtilityCapabilityDefinitions(),
    ...createDocumentExtractionDefinitions(),
    ...createLocalFileCapabilityDefinitions(),
    ...createWeatherCapabilityDefinitions(),
    ...createXidianCapabilityDefinitions(),
    ...createOfficeCapabilityDefinitions(),
    ...createNewsCapabilityDefinitions(),
    ...createBrowserCapabilityDefinitions(),
    ...createDesktopCapabilityDefinitions(),
    /*
     * post-Lv2 / ADR-110 `D05`：QQ 主动联系的目标发送能力。
     *
     * ⚠️ 它**必须**出现在这里，哪怕它不在任务候选表里：`auditToolCatalog()` 的判据 ④
     *    （"参数白名单里没有已登记能力之外的行"）是**反向**的 ——
     *    `TASK_ARG_KEYS` 里有了它这一行、而这个登记表里没有它，就会被如实报成
     *    `stale_arg_keys` 漂移。先例：ADR-106 的桌面两件也是加进这个夹具的。
     */
    ...createQqProactiveCapabilityDefinitions(),
  ])
}

/** 与 `main.ts` 的 `isTaskCapabilityEnabled()` 同名的 gate 求值（只吃 flags 对象，不读环境） */
function gateEnabledOf(flags: Record<string, unknown>): (key: ToolGateKey) => boolean {
  return (key: ToolGateKey): boolean => {
    if (key === 'always') return true
    return flags[key] === true
  }
}

/**
 * **当前**授权清单（与 `main.ts` 的 `buildActionGateway` 同形）。
 *
 * ⚠️ 它只回答"这一次装配会授予哪些权限"。这里刻意把每个能力的权限**逐个**对照，
 *    而不是"按开关列表推"—— 后者会在新增能力时静默漏掉一项。
 */
function grantedPermissionsOf(
  flags: ReturnType<typeof readKernelFlags>,
  options: { searchResolutionAvailable: boolean }
): readonly string[] {
  const granted: string[] = [...DEFAULT_GRANTED_PERMISSIONS]
  if (flags.workflowSkillsEnabled) granted.push(WORKFLOW_SKILL_PERMISSION)
  if (flags.personalLibraryEnabled) granted.push(PERSONAL_LIBRARY_PERMISSION)
  if (flags.arxivResearchEnabled) granted.push(ARXIV_PERMISSION)
  if (options.searchResolutionAvailable) granted.push(WEB_SEARCH_PERMISSION)
  if (flags.mathCalculateEnabled) granted.push(MATH_CALCULATE_PERMISSION)
  if (flags.documentReadEnabled) granted.push(DOCUMENT_READ_PERMISSION)
  if (flags.webReadEnabled) granted.push(WEB_READ_PERMISSION)
  if (flags.imageOcrEnabled) granted.push(IMAGE_OCR_PERMISSION)
  if (flags.localFileReadEnabled) granted.push(LOCAL_FILE_LIST_PERMISSION, LOCAL_FILE_READ_PERMISSION)
  if (flags.localFileWriteEnabled) granted.push(LOCAL_FILE_WRITE_PERMISSION)
  if (flags.weatherEnabled) granted.push(WEATHER_QUERY_PERMISSION)
  if (flags.xidianTimetableEnabled) granted.push(XIDIAN_PERMISSION)
  if (flags.newsReadEnabled) granted.push(NEWS_READ_PERMISSION)
  if (flags.officeGenerateEnabled && flags.localFileWriteEnabled) granted.push(OFFICE_GENERATE_PERMISSION)
  if (flags.browserEnabled) granted.push(BROWSER_READ_PERMISSION, BROWSER_OPERATE_PERMISSION)
  /* ADR-106：桌面**两档分开**判（只看 ≠ 能动手）—— 与 `main.ts` 的 desktopPermissions 同形 */
  if (flags.desktopInspectEnabled) granted.push(DESKTOP_INSPECT_PERMISSION)
  if (flags.desktopOperateEnabled) granted.push(DESKTOP_OPERATE_PERMISSION)
  return granted
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

type CaseStatus = 'PASS' | 'FAIL'

interface CaseReading {
  readonly caseId: string
  readonly title: string
  readonly status: CaseStatus
  readonly observed: unknown
}

function reading(caseId: string, title: string, ok: boolean, observed: unknown): CaseReading {
  return { caseId, title, status: ok ? 'PASS' : 'FAIL', observed }
}

interface GroupReading {
  readonly id: string
  readonly title: string
  readonly status: 'PASS' | 'FAIL' | 'MEASUREMENT INVALID'
  readonly measuredCount: number
  readonly cases: readonly CaseReading[]
  readonly reason?: string
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

interface Cli {
  readonly printCatalog: boolean
  readonly writeEvidence: boolean
  readonly label: string
}

function parseArgv(argv: readonly string[]): Cli {
  let printCatalog = false
  let writeEvidence = true
  let label = 'role-tool'
  for (const arg of argv) {
    if (arg === '--print-catalog') {
      printCatalog = true
      continue
    }
    if (arg === '--no-evidence') {
      writeEvidence = false
      continue
    }
    if (arg.startsWith('--label=')) {
      label = arg.slice('--label='.length)
      continue
    }
    throw new Error(`不认识的参数：${arg}`)
  }
  return { printCatalog, writeEvidence, label }
}

function markdownCatalog(entries: readonly ToolCatalogEntry[]): string {
  const lines: string[] = [
    '| 能力 | 操作 | 参数（闭集） | 风险/副作用 | 权限 | 治理开关 | 可用性 |',
    '|---|---|---|---|---|---|---|',
  ]
  for (const entry of entries) {
    const operations = entry.operations
      .map((operation) => `${operation.name}(${operation.argKeys.join(',') || '—'})`)
      .join(' ')
    lines.push(
      `| \`${entry.capability}\` | ${operations} | ${entry.operations[0]?.argKeys.join(', ') || '—'} | ` +
        `${entry.riskLevel}/${entry.sideEffectLevel} | ${entry.permissions.join(', ')} | ` +
        `\`${entry.gateKey}\`${entry.alsoRequires.length > 0 ? ` + \`${entry.alsoRequires.join('` + `')}\`` : ''} | ` +
        `${toolAvailabilityLabel(entry)} |`
    )
  }
  return lines.join('\n')
}

function main(): number {
  const cli = parseArgv(process.argv.slice(2))
  const registry = buildRegistry()
  const flagDefaults = readKernelFlags({})
  const flagCurrent = readKernelFlags()

  const searchResolutionAvailable = flagCurrent.webSearchEnabled && flagCurrent.webSearchMode !== undefined

  /** 缺省形态（代码缺省 = 全部 off）：目录的"没开任何东西"基线 */
  const defaultEntries = buildToolCatalog(registry, {
    isGateEnabled: gateEnabledOf(flagDefaults as unknown as Record<string, unknown>),
    grantedPermissions: DEFAULT_GRANTED_PERMISSIONS,
  })
  /** 当前形态（用户 `.env` 的真实读数）：WP0 要的"当前权限" */
  const currentEntries = buildToolCatalog(registry, {
    isGateEnabled: gateEnabledOf(flagCurrent as unknown as Record<string, unknown>),
    grantedPermissions: grantedPermissionsOf(flagCurrent, { searchResolutionAvailable }),
  })

  if (cli.printCatalog) {
    process.stdout.write(`${markdownCatalog(currentEntries)}\n\n`)
    process.stdout.write('```text\n' + describeToolCatalog(currentEntries) + '\n```\n')
    return 0
  }

  const cases: CaseReading[] = []
  let measuredInputs = 0
  /*
   * WP1 的输入单独计数：两个工作包的读数**分开报**（合成的总分说明不了
   * "哪一半真的跑过"—— 这是本仓库一以贯之的分列纪律）。
   */
  let wp1Inputs = 0

  // ---- ① 登记表非空（计数型判据：measured_count 必须 > 0）--------------------
  measuredInputs += registry.list().length
  cases.push(
    reading(
      'wp0-registry-nonempty',
      '登记表非空（计数型判据自检：读到的能力数必须 > 0）',
      registry.list().length > 0,
      { capabilities: registry.list().length }
    )
  )

  // ---- ② 覆盖：每个被登记的能力都有参数行与 gate 键 --------------------------
  const audit = auditToolCatalog(registry)
  measuredInputs += registry.list().length
  cases.push(
    reading(
      'wp0-coverage',
      '每项工具均有覆盖（参数白名单 + 治理开关；无遗漏）',
      audit.filter((problem) => problem.code === 'missing_arg_keys' || problem.code === 'missing_gate_key')
        .length === 0,
      { problems: audit }
    )
  )

  // ---- ③ 无通用绕过接口 ------------------------------------------------------
  cases.push(
    reading(
      'wp0-no-generic-bypass',
      '参数白名单里没有通用执行入口（shell / exec / eval / 任意调用）',
      audit.filter((problem) => problem.code === 'generic_bypass_arg').length === 0,
      { pattern: String(FORBIDDEN_ARG_KEY_PATTERN) }
    )
  )

  // ---- ④ 无漂移：参数表里没有"没登记的能力" ---------------------------------
  cases.push(
    reading(
      'wp0-no-stale-arg-rows',
      '参数白名单与登记表同源（没有"写了却不存在"的漂移行）',
      audit.filter((problem) => problem.code === 'stale_arg_keys').length === 0,
      { argKeyRows: Object.keys(TASK_ARG_KEYS).length }
    )
  )

  // ---- ⑤ 当轮内容清单 ⊆ 登记表（回复守卫的兜底清单不许指向不存在的能力）------
  const registeredIds = new Set(registry.list().map((item) => item.id))
  const orphanTurnContent = TURN_CONTENT_CAPABILITY_IDS.filter((id) => !registeredIds.has(id))
  measuredInputs += TURN_CONTENT_CAPABILITY_IDS.length
  cases.push(
    reading(
      'wp0-turn-content-registered',
      '会产出当轮正文的能力清单全部已登记（否则回复守卫为不存在的能力兜底）',
      orphanTurnContent.length === 0,
      { orphan: orphanTurnContent }
    )
  )

  // ---- ⑥ 四态呈现：缺省形态与当前形态必须**分别**呈现 ------------------------
  const defaultEnabled = defaultEntries.filter((entry) => entry.enabled).map((entry) => entry.capability)
  const currentEnabled = currentEntries.filter((entry) => entry.enabled).map((entry) => entry.capability)
  const unexpectedDefault = defaultEnabled.filter(
    (capability) => !['system.echo', 'sandbox.file.read', 'sandbox.file.write'].includes(capability)
  )
  measuredInputs += defaultEntries.length
  cases.push(
    reading(
      'wp0-four-states',
      '已登记 / 已开启 / 已授权 / 已连接**分别**呈现；代码缺省只开 M4.5 那三项',
      unexpectedDefault.length === 0 && defaultEntries.length === registry.list().length,
      {
        defaultEnabled,
        currentEnabled,
        unavailableReasons: currentEntries
          .filter((entry) => !entry.enabled)
          .map((entry) => `${entry.capability}:${entry.gateKey}`),
      }
    )
  )

  // ---- ⑦ 渲染：目录文本含每个能力、且不含绕过入口词 --------------------------
  const rendered = renderToolCatalogForModel(currentEntries)
  /*
   * ⚠️ 泄漏扫描**只扫条目**（`header: ''` 渲染一次）：header 里
   *    "不要用任意 Shell / 脚本"这句话本身就含 "shell" ——
   *    把禁止语算成泄漏就是量具在量错的东西（§6.9 的第二种形态）。
   */
  const entryLines = renderToolCatalogForModel(currentEntries, { header: '' })
  const missingInRender = currentEntries
    .map((entry) => entry.capability)
    .filter((capability) => !rendered.includes(capability))
  const leaked = ['shell', 'eval(', 'exec(', 'child_process'].filter((token) =>
    entryLines.toLowerCase().includes(token)
  )
  measuredInputs += currentEntries.length
  cases.push(
    reading(
      'wp0-render',
      '给模型看的目录文本包含每个能力，且不提供任何绕过入口',
      missingInRender.length === 0 && leaked.length === 0,
      { missingInRender, leaked, bytes: Buffer.byteLength(rendered, 'utf8') }
    )
  )

  /*
   * ---- ⑧ 连接态：**不许猜成可用** ------------------------------------------
   * 计划书 §3 逐字："不能把浏览器安装/连接状态猜成可用"。
   * 本脚本**不**去连 sidecar（那是一次真实出站/子进程，属 WP2/WP3）；
   * 它断言的是**如实**那一半：没有探过就是 `unknown`，而不是 `connected`。
   */
  const connectionEntries = currentEntries.filter((entry) => entry.connection !== 'not-applicable')
  measuredInputs += Math.max(1, connectionEntries.length)
  cases.push(
    reading(
      'wp0-connection-not-guessed',
      '需要连接的能力在没有探针读数时如实报"连接未知"（不猜成可用）',
      connectionEntries.length > 0 &&
        connectionEntries.every((entry) => entry.connection === 'unknown') &&
        connectionEntries.every((entry) => toolAvailabilityLabel(entry).includes('连接未知')),
      {
        entries: connectionEntries.map((entry) => `${entry.capability}:${entry.connection}`),
      }
    )
  )

  // ---- ⑨ 装配同形（文本锁：本床的登记表 = main.ts 的八个工厂）---------------
  const mainText = readFileSync(join(REPO_ROOT, 'src/main.ts'), 'utf8')
  const factories = [
    'createDefaultCapabilityDefinitions',
    'createLearningCapabilityDefinitions',
    'createExternalEvidenceCapabilityDefinitions',
    'createUtilityCapabilityDefinitions',
    'createDocumentExtractionDefinitions',
    'createLocalFileCapabilityDefinitions',
    'createWeatherCapabilityDefinitions',
    'createXidianCapabilityDefinitions',
    'createOfficeCapabilityDefinitions',
    'createNewsCapabilityDefinitions',
    'createBrowserCapabilityDefinitions',
    'createDesktopCapabilityDefinitions',
    /* ADR-110 `D05`：QQ 主动发送能力也必须在 main.ts 的登记表装配里出现 */
    'createQqProactiveCapabilityDefinitions',
  ]
  const missingFactories = factories.filter((name) => !mainText.includes(name))
  measuredInputs += factories.length
  cases.push(
    reading(
      'wp0-main-assembly-parity',
      '本脚本的登记表与 main.ts 的八个能力工厂同形（少一个 ⇒ 目录就不是完整的）',
      missingFactories.length === 0,
      { missingFactories }
    )
  )

  /*
   * ==========================================================================
   *  负控：**注入假象 ⇒ 检测器必须响**
   * ==========================================================================
   * 三条注入，各自正对一个判据；每条都在 `finally` 里放回原状。
   * ⚠️ 只做正控的量具与"什么都不检查"在输出上无法区分（AGENTS.md §6.7）。
   */
  const negative: CaseReading[] = []

  // 注入 ①：给一个已登记能力加一个 `shell` 参数 ⇒ 必须报 generic_bypass_arg
  const argTable = TASK_ARG_KEYS as unknown as Record<string, readonly string[]>
  try {
    argTable['system.echo'] = ['text', 'shell']
    const problems = auditToolCatalog(registry)
    negative.push(
      reading(
        'neg-generic-bypass',
        '注入：system.echo 的参数白名单里出现 shell ⇒ 必须响',
        problems.some((problem) => problem.code === 'generic_bypass_arg'),
        { problems: problems.map((problem) => problem.code) }
      )
    )
  } finally {
    argTable['system.echo'] = ['text']
  }

  // 注入 ②：注册一个"表里没有"的能力 ⇒ 必须报 missing_arg_keys + missing_gate_key
  const ghost: CapabilityDefinition = {
    id: 'ghost.tool',
    version: 'ghost.tool@1',
    description: '（负控用的幽灵能力：只在这一次审计里存在）',
    operations: [{ name: 'run', description: '（负控）', sideEffect: 'none', riskLevel: 'R0' }],
    sideEffectLevel: 'none',
    riskLevel: 'R0',
    permissions: ['ghost:run'],
    supportsDryRun: true,
    idempotency: 'none',
  }
  {
    const ghostRegistry = createCapabilityRegistry([...createDefaultCapabilityDefinitions(), ghost])
    const problems = auditToolCatalog(ghostRegistry)
    negative.push(
      reading(
        'neg-ghost-capability',
        '注入：登记一个参数表与开关表里都没有的能力 ⇒ 必须报"无覆盖"',
        problems.some((problem) => problem.code === 'missing_arg_keys') &&
          problems.some((problem) => problem.code === 'missing_gate_key'),
        { problems: problems.map((problem) => problem.code) }
      )
    )
  }

  // 注入 ③：参数表里加一行"没登记的能力" ⇒ 必须报 stale_arg_keys
  try {
    argTable['ghost.tool'] = ['x']
    const problems = auditToolCatalog(registry)
    negative.push(
      reading(
        'neg-stale-row',
        '注入：参数表里出现一行没登记的能力 ⇒ 必须报"漂移"',
        problems.some((problem) => problem.code === 'stale_arg_keys'),
        { problems: problems.map((problem) => problem.code) }
      )
    )
  } finally {
    delete argTable['ghost.tool']
  }

  // 恢复：放回真实实现 ⇒ 必须重新安静
  const recovered = auditToolCatalog(registry)
  negative.push(
    reading(
      'rec-audit-quiet',
      '恢复：放回真实登记表 ⇒ 审计重新安静（0 处问题）',
      recovered.length === 0,
      { problems: recovered }
    )
  )

  const drift = auditToolCatalog(registry)
  cases.push(...negative)
  cases.push(
    reading('rec-no-drift-after-probes', '负控跑完之后登记表仍然与真实实现一致', drift.length === 0, {
      problems: drift,
    })
  )

  /*
   * ==========================================================================
   *  WP1（决策契约）：离线判定 —— **不调模型**
   * ==========================================================================
   * 这一段量的是"**提案怎么被解析**"，不是"模型会不会好好提案"。
   * 后者只能在固定样本上跑真模型（W1 的语义评估），不在本门里。
   */
  const allowed = currentEntries.map((entry) => entry.capability)
  const parseOptions = { registry, allowedCapabilities: allowed }

  const parseOf = (
    raw: string
  ): { readonly branch?: string; readonly code?: ToolDecisionParseCode } => {
    try {
      const proposal = parseToolDecisionProposal(raw, parseOptions)
      return { branch: proposal.branch }
    } catch (error) {
      return { code: toSafeToolDecisionParseCode(error) }
    }
  }

  /** 样本表：`expect` 是分支名或解析失败码（**两个方向都要有**） */
  const fixtures: readonly {
    readonly caseId: string
    readonly raw: string
    readonly expect: string
  }[] = [
    { caseId: 'answer', raw: '{"branch":"answer"}', expect: 'answer' },
    {
      caseId: 'answer-fenced',
      raw: '```json\n{"branch":"answer"}\n```',
      expect: 'answer',
    },
    { caseId: 'clarify', raw: '{"branch":"clarify","question":"你说的是哪一个桌面？"}', expect: 'clarify' },
    {
      caseId: 'tools-list',
      raw: '{"branch":"tools","goal":"数桌面快捷方式","steps":[{"capability":"local.file.list","operation":"list","args":{"path":"C:\\\\Users\\\\user\\\\Desktop"},"purpose":"列出个人桌面"}],"done":true}',
      expect: 'tools',
    },
    { caseId: 'bad-branch', raw: '{"branch":"maybe"}', expect: 'tool_decision_bad_branch' },
    { caseId: 'answer-with-goal', raw: '{"branch":"answer","goal":"g"}', expect: 'tool_decision_answer_has_payload' },
    { caseId: 'clarify-no-question', raw: '{"branch":"clarify"}', expect: 'tool_decision_clarify_missing_question' },
    {
      caseId: 'clarify-with-steps',
      raw: '{"branch":"clarify","question":"哪一个？","steps":[]}',
      expect: 'tool_decision_clarify_missing_question',
    },
    {
      caseId: 'clarify-too-long',
      raw: `{"branch":"clarify","question":"${'问'.repeat(TOOL_DECISION_MAX_QUESTION_CODEPOINTS + 1)}"}`,
      expect: 'tool_decision_clarify_question_too_long',
    },
    { caseId: 'tools-missing-goal', raw: '{"branch":"tools","steps":[],"done":true}', expect: 'tool_decision_tools_missing_plan' },
    { caseId: 'extra-field', raw: '{"branch":"answer","shell":"rm -rf /"}', expect: 'tool_decision_unknown_field' },
    /* ⚠️ 裸数组里**没有** JSON 对象 ⇒ 取 JSON 那一步就失败（不是"不是对象"） */
    { caseId: 'bare-array', raw: '[1,2,3]', expect: 'tool_decision_no_json_object' },
    { caseId: 'empty', raw: '   ', expect: 'tool_decision_empty' },
    { caseId: 'no-json', raw: '我想我不需要工具。', expect: 'tool_decision_no_json_object' },
    {
      caseId: 'unauthorized-capability',
      raw: '{"branch":"tools","goal":"g","steps":[{"capability":"system.shell","operation":"run","args":{}}],"done":true}',
      expect: 'task_plan_step_capability_not_authorized',
    },
    {
      caseId: 'unknown-operation',
      raw: '{"branch":"tools","goal":"g","steps":[{"capability":"local.file.list","operation":"delete","args":{"path":"C:\\\\x"}}],"done":true}',
      expect: 'task_plan_step_operation_unknown',
    },
    {
      caseId: 'arg-not-allowed',
      raw: '{"branch":"tools","goal":"g","steps":[{"capability":"local.file.list","operation":"list","args":{"path":"C:\\\\x","shell":"dir"}}],"done":true}',
      expect: 'task_plan_step_arg_key_not_allowed',
    },
    {
      caseId: 'too-many-steps',
      raw: `{"branch":"tools","goal":"g","steps":${JSON.stringify(
        Array.from({ length: 9 }, () => ({
          capability: 'local.file.list',
          operation: 'list',
          args: { path: 'C:\\x' },
        }))
      )},"done":true}`,
      expect: 'task_plan_too_many_steps',
    },
  ]

  const parseResults = fixtures.map((item) => {
    const observed = parseOf(item.raw)
    const got = observed.branch ?? observed.code ?? '(未知)'
    return { caseId: item.caseId, expect: item.expect, got, ok: got === item.expect }
  })
  wp1Inputs += fixtures.length
  cases.push(
    reading(
      'wp1-parse-fixtures',
      `决策提案的严格解析（${String(fixtures.length)} 条样本：合法分支 + 非法形状 + 越权参数）`,
      parseResults.every((item) => item.ok),
      { failed: parseResults.filter((item) => !item.ok) }
    )
  )

  /*
   * "非法提案 ⇒ 零动作"与"answer/clarify ⇒ 零动作"必须能被**离线**判定
   * （计划书 §6 WP1 逐字：非法提案拒绝且零动作）。
   */
  const actionSamples: readonly { readonly caseId: string; readonly raw: string; readonly kind: string; readonly reason?: string }[] = [
    { caseId: 'answer-no-action', raw: '{"branch":"answer"}', kind: 'no_action', reason: 'answered' },
    { caseId: 'clarify-no-action', raw: '{"branch":"clarify","question":"哪一个？"}', kind: 'no_action', reason: 'clarified' },
    {
      caseId: 'empty-plan-no-action',
      raw: '{"branch":"tools","goal":"g","steps":[],"done":true}',
      kind: 'no_action',
      reason: 'empty_plan',
    },
    {
      caseId: 'tools-produces-plan',
      raw: '{"branch":"tools","goal":"g","steps":[{"capability":"local.file.list","operation":"list","args":{"path":"C:\\\\x"}}],"done":true}',
      kind: 'tools',
    },
  ]
  const actionResults = actionSamples.map((item) => {
    const proposal = parseToolDecisionProposal(item.raw, parseOptions)
    const action = actionOfToolDecision(proposal)
    return {
      caseId: item.caseId,
      ok: action.kind === item.kind && (item.reason === undefined || (action as { reason?: string }).reason === item.reason),
      got: action.kind + ((action as { reason?: string }).reason !== undefined ? `:${String((action as { reason?: string }).reason)}` : ''),
    }
  })
  /* 非法提案：解析就失败 ⇒ 根本没走到动作层（这一条与上面那条互为反面） */
  const illegalZero = (() => {
    try {
      actionOfToolDecision(
        parseToolDecisionProposal('{"branch":"tools","goal":"g","steps":[{"capability":"system.shell","operation":"run","args":{}}],"done":true}', parseOptions)
      )
      return false
    } catch {
      return true
    }
  })()
  wp1Inputs += actionSamples.length + 1
  cases.push(
    reading(
      'wp1-no-action-is-decidable',
      'answer / clarify / 空计划 ⇒ 零动作；tools ⇒ 交给执行环；非法提案 ⇒ 根本到不了动作层',
      actionResults.every((item) => item.ok) && illegalZero,
      { actionResults, illegalZero }
    )
  )

  /*
   * 结构性锁：决策层**不许**出现第二份参数白名单 / 第二份能力校验。
   * 这是 D04 的机器形态 —— 文案承诺容易被忘掉，一条 import 断言不会。
   *
   * ⚠️ 先**去掉注释**再查：本文件的文件头**说明**里就写着 `TASK_ARG_KEYS` 这个词
   *    （"参数 ∈ TASK_ARG_KEYS 闭集"）。直接查原文会把说明当成违规
   *    （第一次跑本门就是这样 FAIL 的）。
   * ⚠️ 去注释这件事本身也要有**正控**：去完之后 `validateTaskPlan` 必须还在 ——
   *    否则"什么都没查到"与"注释被删光了"在输出上无法区分（§6.8 的同型陷阱）。
   */
  const decisionRaw = readFileSync(join(REPO_ROOT, 'src/kernel/action/tool-decision.ts'), 'utf8')
  const decisionCode = decisionRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const decisionProblems: string[] = []
  if (!decisionCode.includes('validateTaskPlan')) {
    decisionProblems.push('去注释之后找不到 validateTaskPlan（正控失败 ⇒ 本次扫描无效）')
  }
  if (!decisionCode.includes("from './task-plan.ts'")) decisionProblems.push('没有从 task-plan.ts 取校验器')
  if (/TASK_ARG_KEYS/.test(decisionCode)) decisionProblems.push('决策层的**代码**引用了参数白名单（第二份权威）')
  if (/const\s+\w*ARG_KEYS/.test(decisionCode)) decisionProblems.push('决策层自己声明了参数表')
  wp1Inputs += 4
  cases.push(
    reading(
      'wp1-single-validation-authority',
      '决策层没有第二份参数白名单 / 能力校验（复用 validateTaskPlan；去注释后仍看得到它）',
      decisionProblems.length === 0,
      {
        problems: decisionProblems,
        branches: TOOL_DECISION_BRANCHES,
        strippedBytes: Buffer.byteLength(decisionCode, 'utf8'),
      }
    )
  )

  /*
   * `parse` 的取 JSON 那一步够不到"不是对象"这一档（裸数组里根本没有 `{`），
   * 因此这一档**直接**喂给校验器 —— 两条路都要有读数，否则那条分支其实是没量过的。
   */
  const notObjectCode = (() => {
    try {
      validateToolDecisionProposal(null, parseOptions)
      return '(未拒绝)'
    } catch (error) {
      return toSafeToolDecisionParseCode(error)
    }
  })()
  wp1Inputs += 1
  cases.push(
    reading(
      'wp1-not-object',
      '直接喂给校验器一个非对象 ⇒ 拒绝（`parse` 那一步够不到这一档）',
      notObjectCode === 'tool_decision_not_object',
      { notObjectCode }
    )
  )

  const failed = cases.filter((item) => item.status === 'FAIL')
  const wp0Cases = cases.filter((item) => !item.caseId.startsWith('wp1-'))
  const wp1Cases = cases.filter((item) => item.caseId.startsWith('wp1-'))
  const groupOf = (
    id: string,
    title: string,
    groupCases: readonly CaseReading[],
    inputs: number
  ): GroupReading => {
    if (inputs === 0) {
      return {
        id,
        title,
        status: 'MEASUREMENT INVALID',
        measuredCount: 0,
        cases: groupCases,
        reason: 'measured_count = 0 —— 一条输入都没读到，"全绿"在这里没有意义',
      }
    }
    const bad = groupCases.filter((item) => item.status === 'FAIL').length
    return {
      id,
      title,
      status: bad === 0 ? 'PASS' : 'FAIL',
      measuredCount: inputs,
      cases: groupCases,
      ...(bad > 0 ? { reason: `${String(bad)} 条判据未通过` } : {}),
    }
  }
  const groups: GroupReading[] = [
    groupOf('wp0-catalog', 'WP0 工具目录与基线', wp0Cases, measuredInputs),
    groupOf('wp1-decision-contract', 'WP1 决策契约（解析 · 零动作 · 单一校验权威）', wp1Cases, wp1Inputs),
  ]
  const overallPass = failed.length === 0 && groups.every((item) => item.status === 'PASS')

  for (const item of groups) {
    process.stdout.write(
      `[role-tool:verify] ${item.id} ${item.status}（${String(item.measuredCount)} 条输入）\n`
    )
    for (const one of item.cases) {
      process.stdout.write(
        `[role-tool:verify]   ${one.status === 'PASS' ? '·' : '×'} ${one.caseId} ${one.title}\n`
      )
      if (one.status === 'FAIL') {
        process.stdout.write(
          `[role-tool:verify]     observed = ${JSON.stringify(one.observed).slice(0, 400)}\n`
        )
      }
    }
  }
  process.stdout.write(
    `[role-tool:verify] 目录：${String(currentEntries.length)} 项能力 · 当前启用 ` +
      `${String(currentEntries.filter((entry) => entry.enabled).length)} 项 · 已授权 ` +
      `${String(currentEntries.filter((entry) => entry.authorized).length)} 项\n`
  )

  let runDir = ''
  if (cli.writeEvidence) {
    const runId = runIdOf(cli.label)
    runDir = join(REPO_ROOT, EVIDENCE_PARENT, runId)
    if (existsSync(runDir)) throw new Error(`runId 目录已存在，拒绝覆盖：${runDir}`)
    mkdirSync(runDir, { recursive: true })
    const sourceHashes: Record<string, string> = {}
    for (const file of SOURCE_FILES) {
      const hash = sha256File(join(REPO_ROOT, file))
      if (hash !== undefined) sourceHashes[file] = hash
    }
    const evidence = {
      schemaVersion: 'role-tool-decision-run@1',
      runId,
      label: cli.label,
      wp: ['WP0', 'WP1-contract'],
      head: git(['rev-parse', 'HEAD']),
      headShort: git(['rev-parse', '--short=12', 'HEAD']),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      startedAt: nowIso(),
      sourceHashes,
      gates: {
        mode: 'role-tool-decision',
        // ⚠️ 决策入口（WP1 的接线）**尚未实现**；本轮只交付目录与决策契约。
        implemented: false,
        note: 'WP0 = 目录与基线；WP1 = 决策契约（解析/零动作/单一校验权威）。接线与真模型样本未做。',
      },
      codeDefaults: {
        enabled: defaultEnabled,
      },
      current: {
        enabled: currentEnabled,
        searchResolutionAvailable,
      },
      catalog: currentEntries,
      catalogDefaults: defaultEntries,
      auditProblems: audit,
      groups,
    }
    writeFileSync(join(runDir, 'wp0-catalog.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    writeFileSync(join(runDir, 'wp0-catalog.md'), `${markdownCatalog(currentEntries)}\n`, 'utf8')
    writeFileSync(
      join(runDir, 'wp0-catalog-summary.txt'),
      `${describeToolCatalog(currentEntries)}\n`,
      'utf8'
    )
    process.stdout.write(`[role-tool:verify] runId = ${runId}\n`)
    process.stdout.write(`[role-tool:verify] 证据 = ${EVIDENCE_PARENT}/${runId}/wp0-catalog.json\n`)
  }

  process.stdout.write(`[role-tool:verify] overall = ${overallPass ? 'PASS' : 'NOT PASS'}\n`)
  return overallPass ? 0 : 1
}

process.exit(main())
