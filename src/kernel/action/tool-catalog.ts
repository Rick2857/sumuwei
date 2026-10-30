/**
 * ToolCatalog —— **角色自行选择工具**所需的完整工具 / 操作 / 参数目录（WP0）。
 *
 * ============================================================================
 *  载体
 * ============================================================================
 * `docs/post-lv2/Role-Tool-Decision-Plan-2026-10-05.md` §6 WP0：
 * ```text
 * 交付 = 完整工具/操作/参数目录、当前权限、来源指纹、新旧入口关系
 * 验证 = 登记表非空；每项工具均有覆盖；无遗漏或通用绕过接口
 * ```
 *
 * ============================================================================
 *  它**不**新建一个"能力清单"，而是把已有的三处权威**聚成一张可渲染的表**
 * ============================================================================
 * ```text
 * ① 能力存在吗         → `CapabilityRegistry`（ADR-031：未登记 = 不存在）
 * ② 参数能带什么       → `task-plan.ts` 的 `TASK_ARG_KEYS`（闭集，唯一一份）
 * ③ 谁会产出当轮正文   → `turn-content-capabilities.ts`（回复守卫的同一条清单）
 * ```
 * 本文件**只**补两样别处没有的东西：
 * ```text
 * ④ 谁治理它（gate 键名）—— 装配层按哪个开关放行；本文件**不读环境、不读开关**
 * ⑤ 四态呈现 —— 已登记 / 已开启 / 已授权 / 已连接 **分别呈现**（计划书 §3 逐字）
 * ```
 * ⚠️ 第 ④ 条刻意只写**键名**，不写值：`main.ts` 是唯一决定"这次开了什么"的地方
 *    （与 `task-intent.ts` 的"判据"与"授权"分开是同一条纪律）。
 *    因此本模块在 kernel 里保持**纯函数**：给它一个 registry 与一份"gate 求值函数"，
 *    它返回目录；真假由调用方给。
 *
 * ============================================================================
 *  为什么"无通用绕过接口"是一条机器判据，而不是一句承诺
 * ============================================================================
 * 计划书 §3 逐字："参数名单仍是闭集，不暴露任意 Shell、JavaScript 或 MCP 调用入口。"
 * 这句话在代码里的**唯一**可判定形态是："任何能力的任何参数名都**不是**一个通用执行入口"。
 * 因此 `auditToolCatalog()` 按一张具名黑名单拒收（见 `FORBIDDEN_ARG_KEY_PATTERN`）。
 * ⚠️ 它**不**假装能证明"没有别的绕过方式"：它只保证**这张目录里**没有通用的
 *    shell / eval / 任意调用参数 —— 这是能被复核的那一半，也是报告里要如实写清的那一半。
 */

import type {
  CapabilityDefinition,
  CapabilityRegistry,
  OperationDefinition,
} from './capability-registry.ts'
import { TASK_ARG_KEYS, TASK_STAGED_ARG_KEYS } from './task-plan.ts'
import { producesTurnContent } from './turn-content-capabilities.ts'
import type { CurrentCapabilityView, CurrentCapabilityFact } from './capability-facts.ts'

// ---------------------------------------------------------------------------
// 谁治理它
// ---------------------------------------------------------------------------

/**
 * 治理一个能力的**装配层键名**（`KernelFlags` 的字段名）。
 *
 * ⚠️ 这些是**键名**，不是值：本文件从不读 `process.env`、从不读 flags 对象。
 *    "这次真的开了吗"只有 `main.ts` 能回答（先例 `D3`：开关必须被真的消费）。
 */
export type ToolGateKey =
  | 'always'
  | 'workflowSkillsEnabled'
  | 'personalLibraryEnabled'
  | 'projectKnowledgeEnabled'
  | 'selfCapabilitiesEnabled'
  | 'arxivResearchEnabled'
  | 'mathCalculateEnabled'
  | 'documentReadEnabled'
  | 'documentRecoveryEnabled'
  | 'epistemicBeliefEnabled'
  | 'webReadEnabled'
  | 'imageOcrEnabled'
  | 'localFileReadEnabled'
  | 'localFileWriteEnabled'
  | 'webSearchEnabled'
  | 'weatherEnabled'
  | 'xidianTimetableEnabled'
  | 'officeGenerateEnabled'
  | 'newsReadEnabled'
  | 'browserEnabled'
  /**
   * ★ 2026-10-09 / `ADR-125`：全工具档（`CHARACTER_BROWSER_FULL_TOOLS`）。
   *
   * ⚠️ 与 `browserEnabled` **刻意分列**：开着浏览器 ≠ 允许"任意工具入口"。
   *    这一格就是 `browser.mcp`（destructive / R3）的治理来源。
   */
  | 'browserFullTools'
  | 'desktopInspectEnabled'
  | 'desktopOperateEnabled'
  /**
   * post-Lv2 / ADR-110 `D05`：QQ 主动联系的**模式**（`off` / `shadow` / `on`）。
   *
   * ⚠️ 它的值不是布尔而是一个三档模式；目录只问"这次它算不算开"
   *    （`on` 与 `shadow` 都算"开"：`shadow` 要**完整产生选择与审计**，只是不真的发）。
   */
  | 'qqProactiveMode'
  /**
   * post-Lv2 / ADR-156：主人授权群任务（`CHARACTER_QQ_GROUP_TASKS_ENABLED`，代码缺省 false）。
   *
   * ⚠️ 两个群能力（`qq.group.message` 写 / `qq.group.list` 读）**共用这一格**：
   *    `qq.group.list` 是 `qq.group.message` 的**从属能力**（只用于把主人的群名提示
   *    消歧成真实群号），不单独设开关 —— 单独设一格会让"群任务关着、群查询开着"
   *    成为可达状态，而那个状态没有任何使用场景。
   * ⚠️ 它的值仍然是**布尔**（本批没有 `shadow` 档，与 `qqProactiveMode` 的三档不同）。
   */
  | 'qqGroupTasksEnabled'

/**
 * 能力 → 治理它的开关。
 *
 * ⚠️ **`always` 是诚实的**：M4.5 的 `system.echo` / `sandbox.file.*` 由
 *    `DEFAULT_GRANTED_PERMISSIONS` 在装配层恒授予，**没有**独立开关
 *    （M4.5 的门锁着这三条，本目录不改它）。
 * ⚠️ 这张表**必须**覆盖每个被登记的能力 —— `auditToolCatalog()` 有一条专门查它
 *    （漏一个 = 那个能力在目录里没有治理来源，于是"为什么它不可用"查不出来）。
 */
export const TOOL_GATE_KEYS: Readonly<Record<string, ToolGateKey>> = {
  'workflow.skill': 'workflowSkillsEnabled',
  'library.search': 'personalLibraryEnabled',
  'project.search': 'projectKnowledgeEnabled',
  'self.capabilities': 'selfCapabilitiesEnabled',
  'research.arxiv': 'arxivResearchEnabled',
  'system.echo': 'always',
  'sandbox.file.read': 'always',
  'sandbox.file.write': 'always',
  'math.calculate': 'mathCalculateEnabled',
  'document.read': 'documentReadEnabled',
  'document.extract': 'documentRecoveryEnabled',
  'document.profile': 'documentRecoveryEnabled',
  'document.pages': 'documentRecoveryEnabled',
  'image.ocr': 'imageOcrEnabled',
  'web.read': 'webReadEnabled',
  'web.search': 'webSearchEnabled',
  'local.file.list': 'localFileReadEnabled',
  'local.file.read': 'localFileReadEnabled',
  'local.file.write': 'localFileWriteEnabled',
  'weather.query': 'weatherEnabled',
  'xidian.timetable': 'xidianTimetableEnabled',
  'office.generate': 'officeGenerateEnabled',
  'news.read': 'newsReadEnabled',
  'browser.read': 'browserEnabled',
  'browser.operate': 'browserEnabled',
  'browser.mcp': 'browserFullTools',
  'desktop.inspect': 'desktopInspectEnabled',
  'desktop.operate': 'desktopOperateEnabled',
  /*
   * post-Lv2 / ADR-110 `D05`：QQ 主动联系的目标发送能力。
   *
   * ⚠️ 它**不在** `TASK_CAPABILITY_IDS` 里（计划 §7 的能力矩阵："本批新增 NONE"）——
   *    也就是说：角色自行选择工具与任务执行环**永远规划不到它**。
   *    而这里那一行仍然必须有（`auditToolCatalog()` 的"每个已登记能力都要有治理开关"）。
   */
  'qq.private.message': 'qqProactiveMode',
  'local.reminder.message': 'qqProactiveMode',
  /*
   * post-Lv2 / ADR-156：主人授权群任务（**群任务 P2**）。
   *
   * ⚠️ 两个能力**共用同一个开关**：`qqGroupTasksEnabled`（`CHARACTER_QQ_GROUP_TASKS_ENABLED`，
   *    代码缺省 false）。`qq.group.list` 是从属能力（精确消歧真实群号），
   *    不单独设开关 —— 否则会出现"群任务没开、群查询开着"这种没有使用场景的可达状态。
   * ⚠️ 与 `qq.private.message` 同一条纪律：**恒登记**但**不在** `TASK_CAPABILITY_IDS` 里
   *    （角色自行选择工具与任务执行环都规划不到它们；群号不经模型参数）。
   *    这两行仍然是**必须**的：`auditToolCatalog()` 要求每个已登记能力都有治理开关，
   *    否则"它为什么不可用"查不出来。
   */
  'qq.group.message': 'qqGroupTasksEnabled',
  'qq.group.list': 'qqGroupTasksEnabled',
}

/**
 * **组合前提**（除了主开关之外还必须成立的）。
 *
 * ⚠️ `office.generate` 逐字来自 `main.ts` 的 `isTaskCapabilityEnabled()`：
 *    "生成 + 本机落盘，两条权限都要"。把它写在这里而不是散在装配层，
 *    是为了让目录能**如实**回答"它现在为什么不可用"。
 */
export const TOOL_GATE_ALSO_REQUIRES: Readonly<Record<string, readonly ToolGateKey[]>> = {
  'office.generate': ['localFileWriteEnabled'],
  'document.extract': ['documentReadEnabled', 'epistemicBeliefEnabled'],
  'document.profile': ['documentReadEnabled', 'epistemicBeliefEnabled'],
  'document.pages': ['documentReadEnabled', 'epistemicBeliefEnabled'],
}

/**
 * 参数白名单里的**载荷字段**（不进 `ActionRequest.arguments`，由任务环改写成暂存引用）。
 *
 * 它们仍然**出现在目录里**（模型可以产），但必须被标成 `staged`
 * —— 否则"模型能给这个参数"与"这个参数会进账本"会被读成同一件事
 * （先例：`task-loop.ts` 的暂存改写，2026-10-04 的 `spec_not_staged` 生产缺陷）。
 */
export const TOOL_ARG_KEYS_STAGED: readonly string[] = TASK_STAGED_ARG_KEYS

// ---------------------------------------------------------------------------
// 四态
// ---------------------------------------------------------------------------

/**
 * 连通态（**只对需要外部连接的能力有意义**）。
 *
 * ```text
 * not-applicable  本地能力：不存在"连上了没有"这个问题
 * unknown         需要连接、但装配层没给读数（**不是**"连上了"）
 * connected       装配层真的探到了
 * disconnected    装配层真的探过、没连上
 * ```
 * ⚠️ 缺省 `unknown` 而不是 `connected`：计划书 §3 逐字要求
 *    "不能把浏览器安装/连接状态猜成可用"。
 */
export type ToolConnectionState = 'not-applicable' | 'unknown' | 'connected' | 'disconnected'

/**
 * 需要连接才能用的能力（目录里其余能力一律 `not-applicable`）
 *
 * ⚠️ ADR-106 把 `desktop.*` 也放进来了，但这里的"连接"指的是**本机运行时是否就位**
 *    （独立 venv + 固定版本的 `windows-mcp`），不是网络连接 ——
 *    两件事在四态里的形状是同一个（"没探到就不许说可用"），因此共用这一档。
 *    判据只有一处：`verifyDesktopRuntimeSync()`（读 dist-info 的 `Version:`）。
 */
export const TOOL_CONNECTION_REQUIRED: readonly string[] = [
  'project.search',
  'research.arxiv',
  'browser.read',
  'browser.operate',
  'browser.mcp',
  'desktop.inspect',
  'desktop.operate',
]

export interface ToolOperationView {
  readonly name: string
  readonly description: string
  readonly sideEffect: OperationDefinition['sideEffect']
  readonly riskLevel: OperationDefinition['riskLevel']
  /** 该操作接受的参数名（**闭集**，来自 `TASK_ARG_KEYS` 的这一行） */
  readonly argKeys: readonly string[]
  /** 其中哪些是**载荷**字段（会被改写成暂存引用） */
  readonly stagedArgKeys: readonly string[]
}

export interface ToolCatalogEntry {
  readonly currentFact?: CurrentCapabilityFact
  readonly capability: string
  readonly version: string
  readonly description: string
  readonly sideEffectLevel: CapabilityDefinition['sideEffectLevel']
  readonly riskLevel: CapabilityDefinition['riskLevel']
  readonly permissions: readonly string[]
  readonly idempotency: CapabilityDefinition['idempotency']
  readonly supportsDryRun: boolean
  readonly operations: readonly ToolOperationView[]
  /** 会产出当轮正文（回复守卫同样按这条清单兜底） */
  readonly producesTurnContent: boolean
  /** 治理它的主开关（键名；`always` = M4.5 恒授予的那三项） */
  readonly gateKey: ToolGateKey
  /** 除主开关外还必须有前提的键名 */
  readonly alsoRequires: readonly ToolGateKey[]
  /** 四态之一：**恒真**（在登记表里 = 存在，ADR-031） */
  readonly registered: true
  /** 装配层按开关算出来的"这次启用了吗" */
  readonly enabled: boolean
  /** 该能力的**全部**权限都被授予了吗 */
  readonly authorized: boolean
  readonly connection: ToolConnectionState
}

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

export interface ToolCatalogProblem {
  readonly code: string
  readonly message: string
}

/**
 * 通用执行入口的**具名黑名单**（大小写不敏感，整键匹配或下划线分段匹配）。
 *
 * ⚠️ 它刻意是**保守**的：这些名字一旦出现在参数白名单里，就意味着
 *    "模型可以在这张目录里指名一段代码 / 一条命令"。它们一个都不该存在。
 *    反过来，它**不**声称穷举了所有绕过方式 —— 报告里只主张它能主张的那一半。
 */
export const FORBIDDEN_ARG_KEY_PATTERN =
  /^(shell|sh|bash|powershell|cmd|command|exec|execute|spawn|eval|code|script|source|import|require|argv|program|expression_source|mcp|tool|tools|function)$/i

/**
 * 目录的**结构审计**（纯函数，失败关闭）。
 *
 * 四条判据，缺任何一条这张目录就不能用来让模型选工具：
 * ```text
 * ① registry 非空
 * ② 每个被登记的能力都有参数行与 gate 键（**无遗漏**）
 * ③ 参数白名单里没有通用执行入口（**无绕过**）
 * ④ 参数白名单里没有"已登记能力之外"的行（无漂移：写了却不存在的参数行）
 * ```
 * ⚠️ 判据 ② 与 ④ **互为反向**：只有两边都在，才说明"表"与"登记表"是同一份东西。
 */
export function auditToolCatalog(registry: CapabilityRegistry): readonly ToolCatalogProblem[] {
  const problems: ToolCatalogProblem[] = []
  const registered = registry.list()

  if (registered.length === 0) {
    problems.push({ code: 'empty_registry', message: '登记表是空的 —— 目录无从谈起' })
  }

  const ids = new Set(registered.map((item) => item.id))
  for (const definition of registered) {
    const argKeys = TASK_ARG_KEYS[definition.id]
    if (argKeys === undefined) {
      problems.push({
        code: 'missing_arg_keys',
        message: `${definition.id} 没有参数白名单（TASK_ARG_KEYS 里没有这一行）`,
      })
    }
    if (TOOL_GATE_KEYS[definition.id] === undefined) {
      problems.push({
        code: 'missing_gate_key',
        message: `${definition.id} 没有治理开关（TOOL_GATE_KEYS 里没有这一行）⇒ "它为什么不可用"查不出来`,
      })
    }
  }

  for (const [capability, keys] of Object.entries(TASK_ARG_KEYS)) {
    if (!ids.has(capability)) {
      problems.push({
        code: 'stale_arg_keys',
        message: `TASK_ARG_KEYS 里有一行 ${capability}，但它没有被登记 —— 表与登记表漂移了`,
      })
    }
    for (const key of keys) {
      if (FORBIDDEN_ARG_KEY_PATTERN.test(key)) {
        problems.push({
          code: 'generic_bypass_arg',
          message: `${capability} 的参数白名单里有通用执行入口：${key}`,
        })
      }
    }
  }

  return problems
}

// ---------------------------------------------------------------------------
// 建表
// ---------------------------------------------------------------------------

export interface BuildToolCatalogOptions {
  /** Same current-instance facts used by self.capabilities; absent preserves legacy catalogue. */
  readonly currentFacts?: CurrentCapabilityView
  /**
   * "这个开关这次是开的吗"（**装配层给值**；缺省全 `false` = 什么都没开）。
   *
   * ⚠️ 缺省**不是** `true`：目录的缺省形态必须是"只有恒授予的那三项可用"，
   *    与 `DEFAULT_GRANTED_PERMISSIONS` 的失败关闭方向一致。
   */
  readonly isGateEnabled?: (key: ToolGateKey) => boolean
  /**
   * "这个**能力**这次能用吗"（**优先于** `isGateEnabled`，给了就用它）。
   *
   * ⚠️ 它存在的理由是"一处判据"：装配层已经有一个按开关算能力集合的函数
   *    （`main.ts` 的 `isTaskCapabilityEnabled`，同一份清单决定任务授权里能有什么）。
   *    目录若自己按 gate 键再算一遍，就出现了第二份"哪一项能用"的判据 ——
   *    而两份判据迟早分叉，分叉那天目录会告诉模型一个它其实没有的能力。
   */
  readonly isCapabilityEnabled?: (capability: string) => boolean
  /** 这次装配层**实际授予**的权限（缺省空集 ⇒ 全部 `authorized: false`） */
  readonly grantedPermissions?: readonly string[]
  /** 需要连接的能力的实际读数（缺省 = `unknown`，**不猜**成 connected） */
  readonly connectionStates?: Readonly<Record<string, ToolConnectionState>>
}

/** 建一张**可渲染、可审计**的工具目录（纯函数；不读环境、不读开关） */
export function buildToolCatalog(
  registry: CapabilityRegistry,
  options: BuildToolCatalogOptions = {}
): readonly ToolCatalogEntry[] {
  const isGateEnabled = options.isGateEnabled ?? ((): boolean => false)
  const granted = new Set(options.grantedPermissions ?? [])
  const connections = options.connectionStates ?? {}

  return registry.list().map((definition) => {
    const gateKey = TOOL_GATE_KEYS[definition.id] ?? 'always'
    const alsoRequires = TOOL_GATE_ALSO_REQUIRES[definition.id] ?? []
    const fact = options.currentFacts?.tools.find(item => item.id === definition.id)
    const enabled = fact ? fact.taskCandidate === true :
      options.isCapabilityEnabled !== undefined
        ? options.isCapabilityEnabled(definition.id)
        : (gateKey === 'always' || isGateEnabled(gateKey)) &&
          alsoRequires.every((key) => isGateEnabled(key))
    const authorized = fact ? fact.permissionGranted === true
      : definition.permissions.every((permission) => granted.has(permission))
    const requiresConnection = TOOL_CONNECTION_REQUIRED.includes(definition.id)
    const connection: ToolConnectionState = requiresConnection
      ? fact ? fact.connection.state : (connections[definition.id] ?? 'unknown')
      : 'not-applicable'
    const argKeys = TASK_ARG_KEYS[definition.id] ?? []
    const stagedArgKeys = argKeys.filter((key) => TOOL_ARG_KEYS_STAGED.includes(key))

    return {
      capability: definition.id,
      ...(fact ? { currentFact: fact } : {}),
      version: definition.version,
      description: definition.description,
      sideEffectLevel: definition.sideEffectLevel,
      riskLevel: definition.riskLevel,
      permissions: definition.permissions,
      idempotency: definition.idempotency,
      supportsDryRun: definition.supportsDryRun,
      operations: definition.operations.map((operation) => ({
        name: operation.name,
        description: operation.description,
        sideEffect: operation.sideEffect,
        riskLevel: operation.riskLevel,
        argKeys,
        stagedArgKeys,
      })),
      producesTurnContent: producesTurnContent(definition.id),
      gateKey,
      alsoRequires,
      registered: true,
      enabled,
      authorized,
      connection,
    }
  })
}

/** 一眼可读的可用性标签（**四态分列**，不合并成一个"可用/不可用"） */
export function toolAvailabilityLabel(entry: ToolCatalogEntry): string {
  const parts: string[] = ['已登记']
  parts.push(entry.enabled ? '已开启' : '未开启')
  parts.push(entry.authorized ? '已授权' : '未授权')
  if (entry.connection !== 'not-applicable') {
    parts.push(
      entry.connection === 'connected'
        ? '已连接'
        : entry.connection === 'disconnected'
          ? '未连接'
          : '连接未知'
    )
  }
  if (entry.currentFact) {
    const fact = entry.currentFact
    parts.push(fact.assembled === 'unknown' ? '本地装配未知' : fact.assembled ? '本地适配器已装配' : '本地适配器未装配')
    parts.push('本地依赖=' + fact.dependency.state)
    parts.push(fact.lastObservedResult ? '上次本进程回执=' + fact.lastObservedResult.status
      + (fact.lastObservedResult.executed ? '/已调用适配器' : '/未执行') : '本进程无执行回执')
  }
  return parts.join(' · ')
}

/**
 * 渲染成**给模型看的**工具目录（WP1 的 `instruction` 里那一块）。
 *
 * 三条纪律：
 * ```text
 * ① 只写**闭集**：能力 / 操作 / 参数名 / 风险 / 可用性 —— 不写"怎么绕过"
 * ② 不可用的能力**也要列出来**（并标明状态）：否则模型无从知道"这件事我做不到"
 *    （先例：`openai-goal-understanding.ts` 的 `F2` —— 不写能力边界，模型只会合理地猜错）
 * ③ 参数名是闭集，**越界的参数一律不合法** —— 这句话必须由程序说出来，
 *    而不是靠模型自觉
 * ```
 */
export function renderToolCatalogForModel(
  entries: readonly ToolCatalogEntry[],
  options: { readonly header?: string } = {}
): string {
  const lines: string[] = []
  lines.push(
    options.header ??
      '# 你可以使用的工具（程序给出的**闭集**目录）\n' +
        '\n' +
        '下面每一行都是程序登记过的工具。**只能**使用这里列出的能力名、操作名与参数名；\n' +
        '本轮只能调用此目录提供且已授权的能力；未列出不代表产品永远没有该能力。执行是否成功依据程序结果。'
  )
  for (const entry of entries) {
    const operations = entry.operations
      .map(
        (operation) =>
          `${operation.name}(${operation.sideEffect}/${operation.riskLevel}` +
          `${operation.argKeys.length === 0 ? '' : ` 参数：${operation.argKeys.join(',')}`})`
      )
      .join(' ')
    lines.push(
      `- ${entry.capability}：${entry.description}\n` +
        `  操作：${operations}\n` +
        `  状态：${toolAvailabilityLabel(entry)}`
    )
  }
  return lines.join('\n')
}

/**
 * 机器证据用的一行摘要（顺序稳定 ⇒ 可以直接进 JSON 证据）。
 *
 * ⚠️ 它**不含**任何用户内容：全是登记表里的声明与开关读数。
 */
export function describeToolCatalog(entries: readonly ToolCatalogEntry[]): string {
  return entries
    .map(
      (entry) =>
        `${entry.capability}[${entry.riskLevel}/${entry.sideEffectLevel}] ` +
        `gate=${entry.gateKey}${entry.alsoRequires.length > 0 ? `+${entry.alsoRequires.join('+')}` : ''} ` +
        `enabled=${String(entry.enabled)} authorized=${String(entry.authorized)} ` +
        `connection=${entry.connection}`
    )
    .join('\n')
}
