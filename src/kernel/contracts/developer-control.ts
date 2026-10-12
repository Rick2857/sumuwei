/**
 * Developer Control Contract —— **开发者控制面的命令契约**（M5.1 WP1 / AT1.2）。
 *
 * ============================================================================
 *  "控制"在这里是一个非常窄的东西
 * ============================================================================
 * 计划书 AT3 的标题就叫"建立统一 control skeleton，**而不是万能管理员 API**"。
 * 因此本文件的核心不是"能做什么"，而是**不能做什么**：
 *
 *   · 命令只能来自**显式白名单**（`CONTROL_COMMAND_FACTS`）；未知命令 fail closed（AT3.1）
 *   · 七个危险命令被**硬编码禁止**，且禁止清单与白名单的交集被断言为空（AT3.5）
 *   · M5.1 的两个命令都是**只读**的（`mutatesDomain === false`）。
 *     任何未来要改变领域状态的命令**必须**走既有
 *     Validation → Policy → Domain Command → **ActionGateway** → Event Ledger
 *     —— 否则触发计划的 STOP 条件 14（"需要绕过 Execution Gateway"）
 *
 * ---------------------------------------------------------------------------
 *  AT1.2 的那七个字段，逐个交代
 * ---------------------------------------------------------------------------
 *  commandId       命令自身的身份（**不是** actionId，也不是 traceId）
 *  idempotencyKey  **必填**。同一个 key 重放不得造成第二次副作用（AT3.3）
 *  accepted        策略/白名单是否允许做这件事
 *  attempted       执行路径是否被**真正进入**过
 *  executed        适配器/handler 是否真的被调用过
 *  verified        后置条件是否被**独立**核验通过
 *  traceId         贯穿一条 trace（与 M4.5 的 `actionIds` 同一条纪律：只记引用）
 *  error           失败语义**复用** `kernel/action/errors.ts` 的 `ActionFailure`，不另造一套
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 本文件里没有、也不许有 `success: boolean`
 * ---------------------------------------------------------------------------
 *  一个布尔无法区分五件不同的事（AT3.6）：
 *
 *      Rejected                        → 没被允许
 *      Accepted but not attempted      → 允许了，但执行路径没进去
 *      Attempted but failed            → 进去了，但失败了
 *      Executed but verification failed→ 做了，但后置条件核验不通过
 *      Verified                        → 做了且被独立核验
 *
 *  把它们压成一个布尔，代价是"HTTP 200 == executed"这种语义 —— 而 ADR-033
 *  的全部意义就是反对它。于是这里用**两个正交维度**表达：
 *
 *      outcome（阶梯：走到了哪一步）× disposition（终局：成了还是败了）
 *
 *  —— 这正是 M4.5 `ActionResult` 已有的做法（`status` 与 `accepted`/`executed` 分开），
 *     只是把 `attempted` / `verified` 补上（Authority Map 的 F-4）。
 *  `scripts/kernel-tests-dev-plane.ts` 里有一条**源码级静态锁**：
 *  本文件不得出现名为 `success` 的布尔成员。
 */

import {
  KernelError,
  asCharacterId,
  type CharacterId,
  type Timestamp,
  type TraceId,
} from './ids.ts'
import { memoryDigest, stableMaterial } from './memory.ts'
/**
 * 失败语义**复用**既有受控码（AT1.2 的 `error` 字段）。
 *
 * ⚠️ 这是 `src/kernel/contracts/**` 里**唯一**一处 import 到 `contracts/` 之外的模块，
 *    因此需要交代清楚为什么它是安全的、以及为什么它比"另造一套失败码"更好：
 *
 *   · `kernel/action/errors.ts` 是**领域层**，不是基础设施层 ——
 *     它不 import 任何框架 / SQL / `node:*`，所以不违反 "contracts 纯类型与纯函数" 这条纪律
 *     （纪律禁的是框架 / SQL / node:*，不是 kernel 内的兄弟模块）。
 *   · 运行时**不构成环**：`errors.ts` 只 import `type { ActionStatus }`（类型，编译后消失），
 *     `action-result.ts` 只 import `../contracts/ids.ts` —— 没有一条路径回到 `contracts/index.ts`。
 *   · 另造一套 `ControlFailureCode` 才是真正的代价：同一个 `permission_denied`
 *     会在两处定义，而这两处漂移的表现是"同一个失败在 CLI 与开发者面上是两种码"。
 *
 *  WP1 的契约测试里有一条静态锁把这条 import 显式列出来（多了别的跨模块 import 就失败）。
 */
import type { ActionFailure } from '../action/errors.ts'

export const CONTROL_SCHEMA_VERSION = 1

export const CONTROL_LIMITS = {
  /** 命令参数的键数上限（参数进 trace / 证据，必须受控） */
  maxParameterKeys: 32,
  /** 单个参数值的字符上限 */
  maxParameterValueLength: 256,
  /** `commandId` 的长度上限 */
  maxCommandIdLength: 128,
  /** `idempotencyKey` 的长度上限 */
  maxIdempotencyKeyLength: 256,
} as const

// ---------------------------------------------------------------------------
// AT3.1 / AT3.5 —— 白名单与禁止清单
// ---------------------------------------------------------------------------

/**
 * M5.1 允许的命令类型。
 *
 * 两个都是**只读**诊断。刻意只有两个：每多一个都要能说清"它由谁产出、它读什么权威"。
 */
export type ControlCommandType = 'RUN_DIAGNOSTIC' | 'RUN_AUDIT'

export const CONTROL_COMMAND_TYPES: readonly ControlCommandType[] = ['RUN_DIAGNOSTIC', 'RUN_AUDIT']

/**
 * AT3.5 明令：M5.1 的开发者面**永不开放**这些命令。
 *
 * ⚠️ 它们不是"暂时没实现"，而是**禁止**。把它们做成"因为还没实现所以拒绝"，
 *    下一次有人实现它们时就顺手打开了 —— 所以这里是独立的禁止清单，
 *    并且有一条断言（`assertControlRegistryConsistent`）要求它与白名单不相交。
 *
 * 其中每一个都对应一条既有权威：
 *   RESET_KERNEL     → 只有 `--reset-kernel` 这个显式 CLI 动作能碰（并且它属于 M4 领地）
 *   RAW_SQL          → 绕过 Event Ledger 的第二条写路径（G-02）
 *   SHELL_EXEC       → 执行不可审计的外部命令
 *   MEMORY_EDIT      → 绕过 `memory-validator.ts` 这个唯一放行口（ADR-024）
 *   EVENT_REWRITE    → 事实账本 append-only，端口上根本没有 update/delete
 *   CHARACTER_EDIT   → 冻结区（Seed 是版本化数据，ADR-010）
 *   FILESYSTEM_EXEC  → 有副作用的动作必须走 ActionGateway（ADR-030）
 */
export const FORBIDDEN_CONTROL_COMMANDS = [
  'RESET_KERNEL',
  'RAW_SQL',
  'SHELL_EXEC',
  'MEMORY_EDIT',
  'EVENT_REWRITE',
  'CHARACTER_EDIT',
  'FILESYSTEM_EXEC',
] as const

export type ForbiddenControlCommand = (typeof FORBIDDEN_CONTROL_COMMANDS)[number]

export function isControlCommandType(value: unknown): value is ControlCommandType {
  return typeof value === 'string' && (CONTROL_COMMAND_TYPES as readonly string[]).includes(value)
}

export function isForbiddenControlCommand(value: unknown): value is ForbiddenControlCommand {
  return (
    typeof value === 'string' &&
    (FORBIDDEN_CONTROL_COMMANDS as readonly string[]).includes(value)
  )
}

// ---------------------------------------------------------------------------
// 理由码（受控枚举 + 每个码必须登记"谁产出它"）
// ---------------------------------------------------------------------------

export type ControlReasonCode =
  /** 命令不在白名单里（AT3.1 的 fail closed） */
  | 'command_not_allowed'
  /** 命令在 AT3.5 的禁止清单里 */
  | 'command_forbidden'
  /** 该命令没有声明支持 dryRun，但请求要 dryRun */
  | 'dry_run_not_supported'
  /** 该命令声明会改变领域状态 → 不许走开发者控制面（STOP 条件 14） */
  | 'would_mutate_domain'
  /** 幂等键缺失或非法（AT3.3） */
  | 'missing_idempotency_key'
  /** 命令形状非法（缺字段 / 越界） */
  | 'command_invalid'
  /** 调用方不在允许的开发者面（dev-only / loopback 闸） */
  | 'scope_denied'
  /** 诊断真的跑了但失败了 */
  | 'diagnostic_failed'
  /** 审计真的跑了但失败了 */
  | 'audit_failed'
  /** 后置条件核验不通过 */
  | 'verification_failed'

export const CONTROL_REASON_CODES: readonly ControlReasonCode[] = [
  'command_not_allowed',
  'command_forbidden',
  'dry_run_not_supported',
  'would_mutate_domain',
  'missing_idempotency_key',
  'command_invalid',
  'scope_denied',
  'diagnostic_failed',
  'audit_failed',
  'verification_failed',
]

export function isControlReasonCode(value: unknown): value is ControlReasonCode {
  return typeof value === 'string' && (CONTROL_REASON_CODES as readonly string[]).includes(value)
}

export interface ControlReasonCodeFact {
  code: ControlReasonCode
  /** 谁产出它。**空字符串被拒绝** —— 那是"表达得了但永远触发不了"的死值 */
  producer: string
  /** 它属于哪一段判定（便于 trace 与排查定位） */
  stage: 'registry' | 'preflight' | 'execution' | 'verification'
}

/**
 * 理由码登记表。
 *
 * 与 M5 的 `RECALL_EXCLUSION_REASON_FACTS` 完全同一个模式：
 * **每登记一个枚举值，就必须说清它由谁产出**。
 * 本项目最贵的缺陷形状之一是"看起来能表达、永远触发不了"的值；
 * 这里用"producer 必填 + 测试逐条断言非空"把它挡在契约层。
 *
 * ⚠️ `stage: 'registry'` 的五个码由**本文件自身**产出（白名单/形状判定），
 *    它们今天就可达；其余由 WP3 的 Control API 产出。
 */
export const CONTROL_REASON_CODE_FACTS: Readonly<Record<ControlReasonCode, ControlReasonCodeFact>> = {
  command_not_allowed: { code: 'command_not_allowed', producer: 'kernel/contracts/developer-control.ts（白名单判定）', stage: 'registry' },
  command_forbidden: { code: 'command_forbidden', producer: 'kernel/contracts/developer-control.ts（FORBIDDEN_CONTROL_COMMANDS）', stage: 'registry' },
  command_invalid: { code: 'command_invalid', producer: 'kernel/contracts/developer-control.ts（parseControlCommand）', stage: 'registry' },
  missing_idempotency_key: { code: 'missing_idempotency_key', producer: 'kernel/contracts/developer-control.ts（createControlCommand）', stage: 'registry' },
  dry_run_not_supported: { code: 'dry_run_not_supported', producer: 'WP3 Control API（preflight）', stage: 'preflight' },
  would_mutate_domain: { code: 'would_mutate_domain', producer: 'WP3 Control API（preflight，见 STOP 条件 14）', stage: 'preflight' },
  scope_denied: { code: 'scope_denied', producer: 'WP3 Control API（dev-only / loopback 闸，AT5.1）', stage: 'preflight' },
  diagnostic_failed: { code: 'diagnostic_failed', producer: 'WP3 Control API（RUN_DIAGNOSTIC 执行器）', stage: 'execution' },
  audit_failed: { code: 'audit_failed', producer: 'WP3 Control API（RUN_AUDIT 执行器）', stage: 'execution' },
  verification_failed: { code: 'verification_failed', producer: 'WP3 Control API（后置条件核验）', stage: 'verification' },
}

export function assertControlReasonCodeRegistered(code: ControlReasonCode): void {
  const fact = CONTROL_REASON_CODE_FACTS[code]
  if (fact === undefined) {
    throw new KernelError(
      'validation_error',
      'control_reason_code_unregistered',
      `理由码 ${String(code)} 未登记生产者`
    )
  }
  if (fact.producer.trim() === '') {
    throw new KernelError(
      'validation_error',
      'control_reason_code_without_producer',
      `理由码 ${code} 没有登记生产者：那它就是一个"表达得了但永远触发不了"的死值`
    )
  }
}

export function describeControlReason(code: ControlReasonCode): string {
  const fact = CONTROL_REASON_CODE_FACTS[code]
  return fact === undefined
    ? `未登记的理由码：${String(code)}`
    : `${code}（${fact.stage}，由 ${fact.producer} 产出）`
}

// ---------------------------------------------------------------------------
// 命令登记表
// ---------------------------------------------------------------------------

export interface ControlledCommandFact {
  type: ControlCommandType
  kind: 'read_only_diagnostic' | 'read_only_audit'
  /**
   * 是否会改变领域状态。
   *
   * M5.1 的两个命令**必须**是 `false`。断言函数
   * `assertNoDomainMutation` 会在它变成 true 时**抛错** ——
   * 那意味着这条命令不该走开发者控制面，而必须走 ActionGateway（STOP 条件 14）。
   */
  mutatesDomain: boolean
  supportsDryRun: boolean
  /** 谁产出它（**必填**，同 `ControlReasonCodeFact.producer`） */
  producer: string
  /** 它读哪些权威（"这个结果是谁说的"） */
  authority: string
  /** 该命令可能产出的理由码（全部必须在 `CONTROL_REASON_CODE_FACTS` 里登记过） */
  reasonCodes: readonly ControlReasonCode[]
}

/**
 * 命令白名单。
 *
 * `RUN_DIAGNOSTIC` / `RUN_AUDIT` 在 M5.1 里都是**只读**：
 * 它们把既有的诊断/审计视图跑一遍并把结果作为 `ControlResult` 的证据返回，
 * 不写库、不 append 事件、不改 memory、不调 executor、不调任何外部工具（G-03）。
 */
export const CONTROL_COMMAND_FACTS: Readonly<Record<ControlCommandType, ControlledCommandFact>> = {
  RUN_DIAGNOSTIC: {
    type: 'RUN_DIAGNOSTIC',
    kind: 'read_only_diagnostic',
    mutatesDomain: false,
    supportsDryRun: true,
    producer: 'WP3 Control API（复用 memoryIntegrityProblems / kernel:status / action:audit 的只读视图）',
    authority: 'memoryIntegrityProblems() + character_traces + character_action_events（只读）',
    reasonCodes: ['command_invalid', 'dry_run_not_supported', 'scope_denied', 'diagnostic_failed', 'verification_failed'],
  },
  RUN_AUDIT: {
    type: 'RUN_AUDIT',
    kind: 'read_only_audit',
    mutatesDomain: false,
    supportsDryRun: true,
    producer: 'WP3 Control API（复用 action:audit / memory:audit 的只读语料）',
    authority: 'audit-invariants + memoryIntegrityProblems（只读）',
    reasonCodes: ['command_invalid', 'dry_run_not_supported', 'scope_denied', 'audit_failed', 'verification_failed'],
  },
}

/** 登记表自洽性（**在模块加载与测试里都跑**）：白名单与禁止清单不相交，且每个事实自身合法 */
export function assertControlRegistryConsistent(): void {
  const overlap = (CONTROL_COMMAND_TYPES as readonly string[]).filter((type) =>
    (FORBIDDEN_CONTROL_COMMANDS as readonly string[]).includes(type)
  )
  if (overlap.length > 0) {
    throw new KernelError(
      'validation_error',
      'control_registry_overlap',
      `命令同时出现在白名单与禁止清单里：${overlap.join(', ')}。` +
        'AT3.5 的禁止清单与 AT3.1 的白名单必须互斥，否则"禁止"只是一个说法'
    )
  }
  for (const type of CONTROL_COMMAND_TYPES) {
    const fact = CONTROL_COMMAND_FACTS[type]
    if (fact === undefined) {
      throw new KernelError(
        'validation_error',
        'control_command_fact_missing',
        `命令 ${type} 出现在白名单里却没有登记事实`
      )
    }
    if (fact.producer.trim() === '' || fact.authority.trim() === '') {
      throw new KernelError(
        'validation_error',
        'control_command_fact_unattributed',
        `命令 ${type} 的 producer / authority 不能为空：说不出谁负责的能力不该存在`
      )
    }
    for (const code of fact.reasonCodes) {
      assertControlReasonCodeRegistered(code)
    }
  }
}

assertControlRegistryConsistent()

export function describeControlledCommand(fact: ControlledCommandFact): string {
  return (
    `${fact.type}（${fact.kind}，改变领域=${fact.mutatesDomain ? '是' : '否'}，` +
    `支持 dryRun=${fact.supportsDryRun ? '是' : '否'}；权威：${fact.authority}）`
  )
}

// ---------------------------------------------------------------------------
// 命令本体
// ---------------------------------------------------------------------------

export interface ControlCommand {
  schemaVersion: number
  /** 命令自身的身份（与 actionId / traceId 都是不同的东西） */
  commandId: string
  /** **必填**：同一 key 重放不得造成第二次副作用（AT3.3） */
  idempotencyKey: string
  type: ControlCommandType
  dryRun: boolean
  requestedBy: { kind: 'developer'; surface: 'cli' | 'http' | 'page' }
  createdAt: Timestamp
  /** 参数只允许标量：它们会进 trace / 证据文件，受控形状才有隐私保证 */
  parameters?: Readonly<Record<string, string | number | boolean>>
  /** 作用对象（缺省 = 当前角色） */
  characterId?: CharacterId
}

export interface NewControlCommand {
  commandId: string
  idempotencyKey?: string
  type: ControlCommandType
  dryRun?: boolean
  surface?: 'cli' | 'http' | 'page'
  createdAt?: Timestamp
  parameters?: Readonly<Record<string, string | number | boolean>>
  characterId?: string
}

function requireNonEmpty(value: unknown, what: string, code: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new KernelError('validation_error', code, `${what} 必须是非空字符串`)
  }
  return value
}

function assertParameterShape(parameters: Readonly<Record<string, unknown>>): void {
  const keys = Object.keys(parameters)
  if (keys.length > CONTROL_LIMITS.maxParameterKeys) {
    throw new KernelError(
      'validation_error',
      'control_parameters_too_many',
      `命令参数键数超过上限 ${CONTROL_LIMITS.maxParameterKeys}（收到 ${keys.length}）`
    )
  }
  for (const key of keys) {
    const value = parameters[key]
    if (typeof value === 'string') {
      if (value.length > CONTROL_LIMITS.maxParameterValueLength) {
        throw new KernelError(
          'validation_error',
          'control_parameter_too_long',
          `参数 ${key} 超过 ${CONTROL_LIMITS.maxParameterValueLength} 字符上限 —— ` +
            '命令参数会进 trace 与证据文件，长文本会让"没有正文进 trace"这条纪律失效'
        )
      }
      continue
    }
    if (typeof value === 'number' || typeof value === 'boolean') continue
    throw new KernelError(
      'validation_error',
      'control_parameter_not_scalar',
      `参数 ${key} 必须是 string / number / boolean（收到 ${typeof value}）：` +
        '嵌套对象无法被稳定序列化，也让隐私形态无法被断言'
    )
  }
}

/**
 * 构造命令。
 *
 * `idempotencyKey` **缺省即拒绝**（而不是"由系统推导"）：
 * 开发者面的命令不携带角色语义，系统推导不出"这两次是同一次操作"。
 * 对比：M4.5 的 `actionIdempotencyKey` 能从 capability+operation+target+args 推出来，
 * 那是因为动作有明确的目标与参数语义。
 */
export function createControlCommand(input: NewControlCommand): ControlCommand {
  const commandId = requireNonEmpty(
    input.commandId,
    'ControlCommand.commandId',
    'control_missing_command_id'
  )
  if (commandId.length > CONTROL_LIMITS.maxCommandIdLength) {
    throw new KernelError(
      'validation_error',
      'control_command_id_too_long',
      `commandId 超过 ${CONTROL_LIMITS.maxCommandIdLength} 字符上限`
    )
  }

  const idempotencyKey = requireNonEmpty(
    input.idempotencyKey,
    'ControlCommand.idempotencyKey',
    'control_missing_idempotency_key'
  )
  if (idempotencyKey.length > CONTROL_LIMITS.maxIdempotencyKeyLength) {
    throw new KernelError(
      'validation_error',
      'control_idempotency_key_too_long',
      `idempotencyKey 超过 ${CONTROL_LIMITS.maxIdempotencyKeyLength} 字符上限`
    )
  }

  assertControlCommandAllowed(input.type)

  const parameters = input.parameters ?? {}
  assertParameterShape(parameters)

  const createdAt = input.createdAt ?? Date.now()
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new KernelError(
      'validation_error',
      'control_bad_created_at',
      `ControlCommand.createdAt 必须是安全的非负整型毫秒时间戳，收到 ${String(createdAt)}`
    )
  }

  return {
    schemaVersion: CONTROL_SCHEMA_VERSION,
    commandId,
    idempotencyKey,
    type: input.type,
    dryRun: input.dryRun === true,
    requestedBy: { kind: 'developer', surface: input.surface ?? 'cli' },
    createdAt,
    ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
    ...(input.characterId !== undefined
      ? { characterId: asCharacterId(input.characterId) }
      : {}),
  }
}

/**
 * 白名单判定（AT3.1 的 fail closed）。
 *
 * 三种拒绝各有独立的理由码：**"不在白名单"与"被明令禁止"不是同一件事** ——
 * 混在一起之后，"有人试图执行 RESET_KERNEL"这件事在审计里就看不见了。
 */
export function assertControlCommandAllowed(type: unknown): asserts type is ControlCommandType {
  if (isForbiddenControlCommand(type)) {
    const reason: ControlReasonCode = 'command_forbidden'
    assertControlReasonCodeRegistered(reason)
    throw new KernelError(
      'validation_error',
      reason,
      `${String(type)} 属于 AT3.5 的禁止清单（${FORBIDDEN_CONTROL_COMMANDS.join(' / ')}），` +
        '开发者控制面永不开放它'
    )
  }
  if (!isControlCommandType(type)) {
    const reason: ControlReasonCode = 'command_not_allowed'
    assertControlReasonCodeRegistered(reason)
    throw new KernelError(
      'validation_error',
      reason,
      `未知命令 ${String(type)}：命令只能来自白名单 ${CONTROL_COMMAND_TYPES.join(' / ')}（fail closed）`
    )
  }
}

/**
 * dryRun 闸（AT3.2）：命令没声明支持 dryRun，就不许假装跑了一次 dryRun。
 *
 * 拆成"接受事实"与"接受类型"两层（与 `assertDeveloperSurfaceAllowed` 同一理由）：
 * 前者是**可被直接断言**的纯谓词，后者只是查表。
 */
export function assertDryRunSupportedByFact(fact: ControlledCommandFact, dryRun: boolean): void {
  if (!dryRun) return
  if (!fact.supportsDryRun) {
    throw new KernelError(
      'validation_error',
      'dry_run_not_supported',
      `命令 ${fact.type} 没有声明支持 dryRun —— ` +
        '声称"跑了一次 dryRun"而没有预检能力，与谎报一次执行是同一件事'
    )
  }
}

export function assertControlDryRunSupported(type: ControlCommandType, dryRun: boolean): void {
  assertDryRunSupportedByFact(CONTROL_COMMAND_FACTS[type], dryRun)
}

/**
 * 领域 mutation 闸（G-02 / STOP 条件 14）。
 *
 * 它拦的是"某天有人给白名单加了一个会改变领域状态的命令"。
 * 那种情况下正确的做法**不是**在这里执行它，而是让它走
 * Validation → Policy → Domain Command → **ActionGateway** → Event Ledger。
 *
 * ⚠️ 与 `assertDryRunSupportedByFact` 一样拆成两层：接受事实的那一层才是
 *    **能被负控直接验证**的东西 —— 否则"这条闸真的会响吗"只能靠读代码相信。
 */
export function assertDeveloperSurfaceAllowed(fact: ControlledCommandFact): void {
  if (fact.mutatesDomain) {
    throw new KernelError(
      'validation_error',
      'would_mutate_domain',
      `命令 ${fact.type} 声明会改变领域状态 → 不允许经开发者控制面执行。` +
        '它必须走既有的 Validation → Policy → Domain Command → ActionGateway → Event Ledger ' +
        '（计划书 STOP 条件 14）'
    )
  }
}

export function assertNoDomainMutation(type: ControlCommandType): void {
  assertDeveloperSurfaceAllowed(CONTROL_COMMAND_FACTS[type])
}

/** 一行式摘要（进 trace / 日志；**不含参数取值**） */
export function describeControlCommand(command: ControlCommand): string {
  return (
    `${command.type}${command.dryRun ? ' [dry-run]' : ''} ` +
    `commandId=${command.commandId} surface=${command.requestedBy.surface}` +
    `${command.parameters !== undefined ? ` params=${Object.keys(command.parameters).sort().join(',')}` : ''}`
  )
}

// ---------------------------------------------------------------------------
// 序列化与摘要
// ---------------------------------------------------------------------------

/**
 * `undefined` 一律**省略**（与 JSON 一致），从而 `serialize → parse` 是幂等的。
 *
 * 与 `contracts/recall.ts:674` 的 `canonicalMaterial` 同一个做法 ——
 * 契约层已经有共享的稳定材料实现（`stableMaterial` / `memoryDigest`），
 * 这里**不新增第五个序列化器**（见 Repository Map F-8）。
 */
function canonicalMaterial(value: unknown): unknown {
  if (value === null) return null
  if (Array.isArray(value)) return value.map(canonicalMaterial)
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      const item = record[key]
      if (item === undefined) continue
      out[key] = canonicalMaterial(item)
    }
    return out
  }
  return value
}

/** 命令的规范 JSON 文本（进 trace / 进证据文件的形态） */
export function serializeControlCommand(command: ControlCommand): string {
  return JSON.stringify(canonicalMaterial(command))
}

/**
 * 命令的稳定摘要。
 *
 * ⚠️ 材料是**对象**的稳定材料（`stableMaterial(canonicalMaterial(cmd))`），
 *    **不是** `serializeControlCommand(cmd)` 再套一层引号 ——
 *    与 `contracts/recall.ts:697` 的 `recallRequestDigest` 逐字同一个写法。
 *    这个区别看着微不足道，但它会让摘要整整差一位：复核摘要时请用
 *    `pnpm m5.1:test` 里那个**硬编码期望值**，不要手算。
 *
 * 用途：证据文件里比对"两次执行的是不是同一条命令"。
 * ⚠️ 与 `memoryDigest` 共享同一条局限说明：**FNV-1a 不是抗碰撞哈希**，
 *    它在这里只是"把长键压短"，不是安全边界。
 */
export function controlCommandDigest(command: ControlCommand): string {
  return memoryDigest(stableMaterial(canonicalMaterial(command)))
}

/** 反序列化 + 校验（**唯一**接受外部形状的入口） */
export function parseControlCommand(value: unknown): ControlCommand {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new KernelError(
      'validation_error',
      'control_command_not_object',
      'ControlCommand 必须是对象'
    )
  }
  const raw = value as Record<string, unknown>
  assertControlCommandAllowed(raw.type)

  const requestedBy = raw.requestedBy
  if (requestedBy === null || typeof requestedBy !== 'object' || Array.isArray(requestedBy)) {
    throw new KernelError(
      'validation_error',
      'control_command_missing_requested_by',
      'ControlCommand.requestedBy 缺失'
    )
  }
  const surface = (requestedBy as Record<string, unknown>).surface
  if (surface !== 'cli' && surface !== 'http' && surface !== 'page') {
    throw new KernelError(
      'validation_error',
      'control_command_bad_surface',
      `requestedBy.surface 必须是 cli / http / page，收到 ${String(surface)}`
    )
  }
  if ((requestedBy as Record<string, unknown>).kind !== 'developer') {
    throw new KernelError(
      'validation_error',
      'control_command_bad_requester',
      'requestedBy.kind 必须是 developer：命令来自开发者面，不是角色，也不是用户'
    )
  }

  if (raw.dryRun !== true && raw.dryRun !== false) {
    throw new KernelError(
      'validation_error',
      'control_command_bad_dry_run',
      `ControlCommand.dryRun 必须是布尔，收到 ${String(raw.dryRun)}`
    )
  }

  const parameters = raw.parameters
  if (parameters !== undefined) {
    if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
      throw new KernelError(
        'validation_error',
        'control_command_bad_parameters',
        'ControlCommand.parameters 必须是标量映射'
      )
    }
    assertParameterShape(parameters as Record<string, unknown>)
  }

  const parsed = createControlCommand({
    commandId: raw.commandId as string,
    idempotencyKey: raw.idempotencyKey as string,
    type: raw.type,
    dryRun: raw.dryRun,
    surface,
    createdAt: raw.createdAt as number,
    ...(parameters !== undefined
      ? { parameters: parameters as Record<string, string | number | boolean> }
      : {}),
    ...(raw.characterId !== undefined ? { characterId: String(raw.characterId) } : {}),
  })

  if (raw.schemaVersion !== undefined && raw.schemaVersion !== CONTROL_SCHEMA_VERSION) {
    throw new KernelError(
      'validation_error',
      'control_schema_version_mismatch',
      `ControlCommand.schemaVersion 期望 ${CONTROL_SCHEMA_VERSION}，收到 ${String(raw.schemaVersion)}`
    )
  }
  return parsed
}

// ---------------------------------------------------------------------------
// 结果：阶梯（outcome）× 终局（disposition）
// ---------------------------------------------------------------------------

/**
 * 阶梯：**走到了哪一步**。它是一个全序（每一步都蕴含前一步）。
 *
 * ⚠️ 它与 AT1.2 的四个布尔是**同一个信息**的两种写法，
 *    因此只能有一处映射（`controlLadderBooleansOf`）—— 两处定义迟早漂移，
 *    而漂移的表现是"结果是 verified，但 executed=false"，那是一种不会报错的错。
 */
export type ControlLadderStage =
  /** 白名单 / 形状 / 作用域拒绝 —— 未获准 */
  | 'rejected'
  /** 获准，但执行路径未进入（例如 dryRun 只做预检） */
  | 'accepted'
  /** 进入执行路径，但 handler 未被调用 */
  | 'attempted'
  /** handler 被调用并返回 */
  | 'executed'
  /** 后置条件被**独立**核验通过 */
  | 'verified'

export const CONTROL_LADDER_STAGES: readonly ControlLadderStage[] = [
  'rejected',
  'accepted',
  'attempted',
  'executed',
  'verified',
]

/**
 * 终局：**成了还是败了**。
 *
 * `none` 是刻意的：没进入执行路径的（rejected / accepted）**没有终局**，
 * 用 `failed` 表达"被拒绝"会把两种完全不同的处置混在一起
 * （前者要改请求，后者要排查执行环境）。
 */
export type ControlDisposition = 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'none'

export const CONTROL_DISPOSITIONS: readonly ControlDisposition[] = [
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'none',
]

export type ControlVerification =
  /** 被独立核验通过 */
  | 'verified'
  /** 核验了，但不通过（"执行了但核验失败"就是这一档） */
  | 'failed'
  /** **没有核验过**。它与 `failed` 是两件事（AT3.6 的核心） */
  | 'not_attempted'
  /** 该命令没有可核验的后置条件（如纯预检） */
  | 'not_applicable'

export const CONTROL_VERIFICATIONS: readonly ControlVerification[] = [
  'verified',
  'failed',
  'not_attempted',
  'not_applicable',
]

/**
 * **唯一**的阶梯 → 布尔映射。
 *
 * 任何地方都不许自己写 `{ accepted: true, executed: ... }`：那会把"全序"
 * 降级成三个可以互相矛盾的布尔。与 `actionStatusOfFailure` / `exclusionReasonForStatus`
 * 是同一条纪律（一个映射只有一处实现）。
 */
export function controlLadderBooleansOf(stage: ControlLadderStage): {
  accepted: boolean
  attempted: boolean
  executed: boolean
} {
  switch (stage) {
    case 'rejected':
      return { accepted: false, attempted: false, executed: false }
    case 'accepted':
      return { accepted: true, attempted: false, executed: false }
    case 'attempted':
      return { accepted: true, attempted: true, executed: false }
    case 'executed':
      return { accepted: true, attempted: true, executed: true }
    case 'verified':
      return { accepted: true, attempted: true, executed: true }
  }
}

export interface ControlResultEvidenceOf {
  /** `accepted` 的证据来源（如 `control_registry`） */
  accepted: string
  /** `attempted` 的证据来源（如 `developer_control_trace`） */
  attempted: string
  /** `executed` 的证据来源（如 `diagnostic_executor`） */
  executed: string
  /** `verification` 的证据来源（如 `diagnostic_report`） */
  verification: string
}

/**
 * 开发者控制面的执行真相。
 *
 * 与 M4.5 的 `ActionResult` 的关系（**刻意不合并**）：
 *   · `ActionResult` 是"角色对世界做了什么"，权威是 `character_action_events`
 *   · `ControlResult` 是"开发者对系统做了什么诊断/审计"，权威是它自己的证据
 *   两者若合成一个类型，会出现"一个开发者跑了诊断"被记成"她说她做了某事"。
 *
 * 共用的部分是**失败语义**（`ActionFailure`）：那是既有的一套受控码，不另造。
 */
export interface ControlResult {
  schemaVersion: number
  commandId: string
  idempotencyKey: string
  /**
   * 命令类型。
   *
   * ⚠️ 类型是 `string` 而**不是** `ControlCommandType`（M5.1 WP3 的补强）：
   *    一条**被拒绝**的结果必须能说出"它试图执行什么"。
   *    把未知命令硬塞进 `ControlCommandType` 会让
   *    「有人试图执行 `RESET_KERNEL`」这件事**在类型层面就表达不出来** ——
   *    而 AT3.5 的全部意义就是让那次尝试**被记下来**。
   *
   *    非 `rejected` 的结果仍必须通过白名单校验（见 `assertControlResult`）。
   */
  commandType: string
  /** 贯穿一条 trace（只是引用；命令本身也有自己的 id） */
  traceId?: TraceId
  characterId?: CharacterId
  /** 走到了哪一步（**唯一**阶梯） */
  outcome: ControlLadderStage
  /** 终局。`none` = 没进入执行路径 */
  disposition: ControlDisposition
  accepted: boolean
  attempted: boolean
  executed: boolean
  verification: ControlVerification
  /** 每个布尔的**证据来源**。禁止自报 —— "executed 是从哪读出来的"必须能被回答 */
  evidenceOf: ControlResultEvidenceOf
  /** 核验说明（`verification === 'verified'` 时必填） */
  verificationEvidence?: string
  reasonCode?: ControlReasonCode
  /** 失败语义**复用**既有受控码（不另造一套） */
  error?: ActionFailure
  dryRun: boolean
  startedAt: Timestamp
  finishedAt?: Timestamp
}

/**
 * 结果一致性断言（AT1.1 / AT1.2 的 execution-state distinction）。
 *
 * 它守的十件事，每一条都对应一个**不会报错**的错：
 *   ① 三个布尔必须与 `outcome` 的阶梯映射**逐字相等**（不许各写一套）
 *   ② `outcome === 'verified'` ⇒ `verification === 'verified'`
 *   ③ `verification === 'verified'` ⇒ `executed === true`
 *   ④ `verification === 'failed'` ⇒ `executed === true`（没执行就无从核验失败）
 *   ⑤ `rejected` ⇒ `disposition === 'none'` 且有 `reasonCode` 或 `error`
 *   ⑥ `accepted` ⇒ `disposition === 'none'` 且 `verification === 'not_attempted'`
 *   ⑦ `attempted` ⇒ `disposition ∈ {failed, timed_out, cancelled}` 且有 `error`
 *   ⑧ `executed` / `verified` ⇒ `disposition ∈ {succeeded, failed}`
 *   ⑨ `outcome !== 'rejected'` ⇒ 不得出现 `command_forbidden` / `command_not_allowed` 这类登记期理由码
 *      （它们只能出现在 `rejected` 上；出现在别处说明结果是手工拼的）
 *   ⑩ `evidenceOf` 四个字段都非空（自报的执行真相不是证据）
 */
export function assertControlResult(result: ControlResult): void {
  assertControlRegistryConsistent()

  /*
   * 白名单校验**只对非 rejected 的结果**生效。
   *
   * 理由与 `ControlResult.commandType` 的类型选择是同一条：
   * 一条被拒绝的结果**必须**能带上"它试图执行什么"（可能是 `RESET_KERNEL`、
   * 也可能是一个拼错的命令）。要求它必须已在白名单里，等于要求
   * "只有合法命令才能被记录为被拒绝" —— 那正是 AT3.5 想避免的事。
   * 反过来，**声称执行过**的结果必须真的是白名单里的命令。
   */
  if (result.outcome !== 'rejected') {
    assertControlCommandAllowed(result.commandType)
  } else if (result.commandType.trim() === '') {
    throw new KernelError(
      'validation_error',
      'control_rejected_without_type',
      `命令 ${result.commandId}：被拒绝的结果必须说出它试图执行什么（commandType 不能为空）`
    )
  }

  if (!(CONTROL_VERIFICATIONS as readonly string[]).includes(result.verification)) {
    throw new KernelError(
      'validation_error',
      'control_bad_verification',
      `命令 ${result.commandId}：verification 必须是四态之一（${CONTROL_VERIFICATIONS.join(
        ' / '
      )}），收到 ${String(result.verification)}。` +
        '它刻意不是 boolean —— "核验了但失败"与"根本没核验"必须能被区分'
    )
  }

  const expected = controlLadderBooleansOf(result.outcome)
  if (
    expected.accepted !== result.accepted ||
    expected.attempted !== result.attempted ||
    expected.executed !== result.executed
  ) {
    throw new KernelError(
      'validation_error',
      'control_result_ladder_inconsistent',
      `命令 ${result.commandId}：outcome=${result.outcome} 要求 ` +
        `accepted=${expected.accepted} / attempted=${expected.attempted} / executed=${expected.executed}，` +
        `但结果是 ${result.accepted} / ${result.attempted} / ${result.executed}。` +
        '阶梯到布尔只能有一处映射（controlLadderBooleansOf）'
    )
  }

  for (const [field, source] of Object.entries(result.evidenceOf)) {
    if (String(source).trim() === '') {
      throw new KernelError(
        'validation_error',
        'control_result_evidence_missing',
        `命令 ${result.commandId}：evidenceOf.${field} 为空 —— 自报的执行真相不是证据`
      )
    }
  }

  if (result.verification === 'verified' && !result.executed) {
    throw new KernelError(
      'validation_error',
      'control_verified_without_execution',
      `命令 ${result.commandId}：verification=verified 但 executed=false`
    )
  }
  if (result.verification === 'failed' && !result.executed) {
    throw new KernelError(
      'validation_error',
      'control_verification_failed_without_execution',
      `命令 ${result.commandId}：verification=failed 但 executed=false —— ` +
        '没执行过就不存在"核验失败"，只有"没核验"'
    )
  }
  if (result.verification === 'verified') {
    if (result.outcome !== 'verified') {
      throw new KernelError(
        'validation_error',
        'control_verified_but_ladder_behind',
        `命令 ${result.commandId}：verification=verified 但 outcome=${result.outcome}`
      )
    }
    if ((result.verificationEvidence ?? '').trim() === '') {
      throw new KernelError(
        'validation_error',
        'control_verified_without_evidence',
        `命令 ${result.commandId}：verification=verified 却没有 verificationEvidence —— ` +
          '没有证据的"已核验"就是自报'
      )
    }
  }

  switch (result.outcome) {
    case 'rejected':
      if (result.disposition !== 'none') {
        throw new KernelError(
          'validation_error',
          'control_rejected_with_disposition',
          `命令 ${result.commandId}：outcome=rejected 却带着 disposition=${result.disposition}`
        )
      }
      if (result.reasonCode === undefined && result.error === undefined) {
        throw new KernelError(
          'validation_error',
          'control_rejected_without_reason',
          `命令 ${result.commandId}：被拒绝却没有 reasonCode / error —— 拒绝必须能说出理由`
        )
      }
      if (result.verification !== 'not_attempted') {
        throw new KernelError(
          'validation_error',
          'control_rejected_with_verification',
          `命令 ${result.commandId}：被拒绝的命令不可能有核验态 ${result.verification}`
        )
      }
      break
    case 'accepted':
      if (result.disposition !== 'none') {
        throw new KernelError(
          'validation_error',
          'control_accepted_with_disposition',
          `命令 ${result.commandId}：outcome=accepted（执行路径未进入）却带着 disposition=${result.disposition}`
        )
      }
      if (result.verification !== 'not_attempted') {
        throw new KernelError(
          'validation_error',
          'control_accepted_with_verification',
          `命令 ${result.commandId}：未进入执行路径不可能有核验态 ${result.verification}`
        )
      }
      break
    case 'attempted':
      if (!['failed', 'timed_out', 'cancelled'].includes(result.disposition)) {
        throw new KernelError(
          'validation_error',
          'control_attempted_bad_disposition',
          `命令 ${result.commandId}：outcome=attempted 的 disposition 只能是 failed / timed_out / cancelled，` +
            `收到 ${result.disposition}`
        )
      }
      if (result.error === undefined) {
        throw new KernelError(
          'validation_error',
          'control_attempted_without_error',
          `命令 ${result.commandId}：进入了执行路径却失败，必须有 error（失败语义不是可选项）`
        )
      }
      if (result.verification !== 'not_attempted') {
        throw new KernelError(
          'validation_error',
          'control_attempted_with_verification',
          `命令 ${result.commandId}：handler 没被调用过，不可能有核验态 ${result.verification}`
        )
      }
      break
    case 'executed':
    case 'verified':
      if (!['succeeded', 'failed'].includes(result.disposition)) {
        throw new KernelError(
          'validation_error',
          'control_executed_bad_disposition',
          `命令 ${result.commandId}：outcome=${result.outcome} 的 disposition 只能是 succeeded / failed，` +
            `收到 ${result.disposition}`
        )
      }
      if (result.disposition === 'failed' && result.error === undefined) {
        throw new KernelError(
          'validation_error',
          'control_executed_failed_without_error',
          `命令 ${result.commandId}：disposition=failed 必须有 error`
        )
      }
      break
  }

  if (result.outcome !== 'rejected') {
    const registryCodes: ControlReasonCode[] = ['command_forbidden', 'command_not_allowed']
    if (result.reasonCode !== undefined && registryCodes.includes(result.reasonCode)) {
      throw new KernelError(
        'validation_error',
        'control_result_bad_reason_stage',
        `命令 ${result.commandId}：${
          result.reasonCode
        } 只在登记/形状判定阶段产出（outcome 应为 rejected），却出现在 ${result.outcome} 上`
      )
    }
  }

  /*
   * dryRun 闸只对**白名单命令**查表：被拒绝的未知命令没有事实可查，
   * 而它已经在上面被拦下了（这里不能因此炸成"内部错误"）。
   */
  if (isControlCommandType(result.commandType)) {
    assertControlDryRunSupported(result.commandType, result.dryRun)
  }
}

/**
 * 五个 AT3.6 场景的**可区分性**判据（供测试与文档共用）。
 *
 * 它回答的是"这两个结果看起来一样吗"。**一条判据只取真实字段** ——
 * 不看 id、不看时间戳，否则任意两个结果都"可区分"，这条断言就什么也没守。
 */
export function controlResultFingerprint(result: ControlResult): string {
  return stableMaterial({
    outcome: result.outcome,
    disposition: result.disposition,
    accepted: result.accepted,
    attempted: result.attempted,
    executed: result.executed,
    verification: result.verification,
    reasonCode: result.reasonCode ?? null,
    errorCode: result.error?.code ?? null,
  })
}

/** 一行式摘要（进日志 / 证据文件；**不含参数**） */
export function describeControlResult(result: ControlResult): string {
  return (
    `${result.commandType} ${result.outcome}/${result.disposition}` +
    `${result.dryRun ? ' [dry-run]' : ''}` +
    ` accepted=${result.accepted} attempted=${result.attempted} executed=${result.executed}` +
    ` verification=${result.verification}` +
    `${result.reasonCode !== undefined ? ` reason=${result.reasonCode}` : ''}` +
    `${result.error !== undefined ? ` error=${result.error.code}` : ''}`
  )
}
