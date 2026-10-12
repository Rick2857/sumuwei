/**
 * Developer Control Service —— **统一控制壳**（M5.1 WP3 / AT3.1–AT3.6）。
 *
 * ============================================================================
 *  计划书 AT3 的标题就把范围收窄了
 * ============================================================================
 *     建立统一 control skeleton，**而不是万能管理员 API**
 *
 * 因此这个文件的重点不是"能做什么"，而是**三件不能做的事**：
 *
 *   ① **不能执行白名单之外的东西**（AT3.1）：命令只能来自 `CONTROL_COMMAND_FACTS`；
 *      未知命令 fail closed，而且**被拒绝的尝试本身要留下结果**
 *      （`ControlResult.commandType` 因此是 `string` —— 见契约里的说明）。
 *   ② **不能开出 AT3.5 的七个禁止命令**：`FORBIDDEN_CONTROL_COMMANDS` 是
 *      **禁止清单**，不是"还没实现的清单"。两者用不同的理由码区分
 *      （`command_forbidden` vs `command_not_allowed`），因为
 *      "有人试图执行 RESET_KERNEL"与"有人拼错了命令"不是同一件事。
 *   ③ **不能绕开既有的执行入口**：M5.1 的两个命令都是**只读**的
 *      （`mutatesDomain === false`），所以它们不经过 `ActionGateway`。
 *      将来若有命令会改变领域状态，**必须**走
 *      Validation → Policy → Domain Command → `ActionGateway` → Event Ledger，
 *      否则触发计划的 STOP 条件 14。
 *
 * ---------------------------------------------------------------------------
 *  AT3.6 的五个档**全部有真实生产者**（没有一个是"表达得了但停在那里"的）
 * ---------------------------------------------------------------------------
 *      rejected                     ← 未知命令 / 七个禁止命令 / 形状非法 / 策略不许
 *      accepted（未进入执行路径）    ← `dryRun = true`（AT3.2 的真实落点）
 *      attempted（进入但失败）       ← handler 抛错
 *      executed（核验失败）          ← handler 返回，但**重读权威状态**不一致
 *      verified                     ← handler 返回，且重读权威状态一致
 *
 *  `dryRun` 那一档尤其重要：它让"允许了但没做"**不是**一个理论状态，
 *  而是每次 dry run 都会真实产生的结论。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 今天**没有**持久化的控制账本，而且这是有理由的
 * ---------------------------------------------------------------------------
 * 最自然的落点是 `character_traces`，但它的 `input_event_id` 是 **NOT NULL**
 * 且语义上指向"触发这一轮的真实对话事件"（`migrations.ts:205`）。
 * 给一条开发者命令编一个假的 `input_event_id`，就会造出
 * **指向不存在的行**的 trace —— 那正是 D-7 那次事故的形状。
 * 因此：
 *   · `ControlResult.traceId` 今天**恒为缺省**（不是忘了填）
 *   · 幂等记录放在 `ControlIdempotencyStore` 这个**端口**后面（默认内存实现）
 *   · 持久账本需要一条新迁移 —— 按 F-11 与 G-05，M5.1 **不做**
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ AT3.4 今天**不适用**（这是一个有内容的结论，不是省略）
 * ---------------------------------------------------------------------------
 * AT3.4 说"**若**需要暴露已有 mutation command，必须调用现有
 * Validation → Policy → Domain Command → Gateway → Event Ledger"。
 * M5.1 的两个命令都不改变领域状态，因此这条**没有被触发**。
 * 一旦触发，正确做法是在 `ControlCommandHandler` 里调 `ActionGateway`，
 * 而**不是**在这里写一条新的写路径（G-02）。
 */

import {
  CONTROL_COMMAND_FACTS,
  CONTROL_COMMAND_TYPES,
  CONTROL_SCHEMA_VERSION,
  assertControlReasonCodeRegistered,
  assertControlResult,
  assertDryRunSupportedByFact,
  assertDeveloperSurfaceAllowed,
  controlLadderBooleansOf,
  describeControlResult,
  isControlCommandType,
  isForbiddenControlCommand,
  parseControlCommand,
  type ControlCommand,
  type ControlCommandType,
  type ControlReasonCode,
  type ControlResult,
  type ControlledCommandFact,
} from '../../kernel/contracts/developer-control.ts'
import { KernelError, isKernelError, type CharacterId, type Timestamp } from '../../kernel/contracts/index.ts'
// WP9-A / U-03：durable authoritative audit 的**唯一**生产写入口（本文件只在权威执行链上调用它）
import type { DeveloperControlAuditWriter } from './control-audit.ts'
import { actionFailure } from '../../kernel/action/errors.ts'
import type { DeveloperQueryService } from '../../kernel/contracts/developer-query.ts'

// ---------------------------------------------------------------------------
// 幂等（AT3.3）
// ---------------------------------------------------------------------------

export interface ControlIdempotencyRecord {
  idempotencyKey: string
  commandId: string
  commandType: string
  result: ControlResult
  /** 与首次执行一起记下的报告（重放时原样回放，**不重跑**） */
  report?: ControlCommandReport
  recordedAt: Timestamp
}

/**
 * 幂等记录端口。
 *
 * 定义在基础设施层（不是 `kernel/contracts/`）有一个现成先例：
 * `MemoryStorePort` 也在 `infrastructure/persistence/memory-store.ts` 里。
 * 这样 WP1 的三份**已冻结**契约文件一个字都不用动。
 *
 * ⚠️ 默认实现是**进程内**的：重启之后同一个 key 会再次执行。
 *    对 M5.1 的两个只读命令，这意味着"多跑一次诊断"，不产生领域副作用；
 *    但它**不是**一条可以拿去做"重放安全"承诺的机制 ——
 *    持久化需要一条新迁移（F-11：M5.1 不做）。见 `Known Issues`。
 */
export interface ControlIdempotencyStore {
  get(idempotencyKey: string): Promise<ControlIdempotencyRecord | undefined>
  put(record: ControlIdempotencyRecord): Promise<void>
  /** 已记录的键数（门用它断言"真的记了"） */
  size(): Promise<number>
}

export function createInMemoryControlIdempotencyStore(): ControlIdempotencyStore {
  const records = new Map<string, ControlIdempotencyRecord>()
  return {
    async get(key) {
      return records.get(key)
    },
    async put(record) {
      records.set(record.idempotencyKey, record)
    },
    async size() {
      return records.size
    },
  }
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------

export interface ControlCommandReport {
  /**
   * 只允许**标量**指标（计数 / 状态 / 版本 / 布尔）。
   *
   * ⚠️ 不许放正文：这份报告会进 HTTP 响应与证据文件，而那条路径是外发的。
   *    形状本身就把"顺手把内容塞进来"堵住了。
   */
  metrics: Record<string, string | number | boolean>
  /** 人类可读的说明（**不含正文**） */
  notes: string[]
}

export interface ControlVerificationOutcome {
  ok: boolean
  /** 凭什么这么说（"重读了什么、看到什么"）。**必填** */
  evidence: string
}

export interface ControlCommandHandlerResult {
  report: ControlCommandReport
  /**
   * 核验：把报告里的结论**重读一遍**。
   *
   * 对只读命令，"核验"就是"我说的数现在还是这个数吗"（TOCTOU 检查）。
   * 将来若有 mutating 命令，它必须变成"重读**后置条件**"——
   * 接口不变，语义变强。
   */
  verify: () => Promise<ControlVerificationOutcome>
}

export interface ControlCommandHandler {
  type: ControlCommandType
  run: (input: { characterId: CharacterId; command: ControlCommand }) => Promise<ControlCommandHandlerResult>
}

/**
 * `RUN_DIAGNOSTIC`：把既有的只读诊断视图跑一遍并回报。
 *
 * ⚠️ 它**复用 Query 面**（`DeveloperQueryService`），因此：
 *   · 不新增任何读取逻辑（AT2.1 的纪律在控制面同样成立）
 *   · 核验 = 重读同两个探针并逐项比对
 */
export function createDiagnosticControlHandler(
  query: DeveloperQueryService
): ControlCommandHandler {
  return {
    type: 'RUN_DIAGNOSTIC',
    async run({ characterId }) {
      const health = await query.getHealth({ characterId })
      const integrity = await query.getMemoryIntegrity({ characterId })
      const metrics: Record<string, string | number | boolean> = {
        health_status: health.status,
        migration_version: health.migrationVersion ?? -1,
        integrity_ok: health.integrityOk === true,
        dangling_evidence: integrity.danglingEvidenceLinks.length,
        dangling_events: integrity.danglingMemoryEvents.length,
        orphan_memories: integrity.memoriesWithoutLiveEvidence.length,
        memories_without_live_events: integrity.memoriesWithoutLiveEvents.length,
        detail_count: health.details.length,
      }
      return {
        report: {
          metrics,
          notes: [`health=${health.status}`, `integrity_ok=${String(metrics.integrity_ok)}`],
        },
        verify: async () => {
          const again = await query.getMemoryIntegrity({ characterId })
          const ok =
            again.danglingEvidenceLinks.length === metrics.dangling_evidence &&
            again.danglingMemoryEvents.length === metrics.dangling_events &&
            again.memoriesWithoutLiveEvidence.length === metrics.orphan_memories &&
            again.memoriesWithoutLiveEvents.length === metrics.memories_without_live_events
          return {
            ok,
            evidence:
              `重读完整性探针：dangling_evidence=${again.danglingEvidenceLinks.length} / ` +
              `dangling_events=${again.danglingMemoryEvents.length} / ` +
              `orphan=${again.memoriesWithoutLiveEvidence.length} / ` +
              `no_live_events=${again.memoriesWithoutLiveEvents.length}` +
              `（报告时为 ${metrics.dangling_evidence}/${metrics.dangling_events}/` +
              `${metrics.orphan_memories}/${metrics.memories_without_live_events}）`,
          }
        },
      }
    },
  }
}

/**
 * `RUN_AUDIT`：把既有的只读审计语料跑一遍并回报。
 *
 * "审计"在这里 = Memory 统计 + 执行账本计数（两级证据各取一类），
 * 核验同样是重读。
 */
export function createAuditControlHandler(query: DeveloperQueryService): ControlCommandHandler {
  return {
    type: 'RUN_AUDIT',
    async run({ characterId }) {
      const stats = await query.getMemoryStats({ characterId })
      const executions = await query.listExecutions({ characterId, limit: 100 })
      const metrics: Record<string, string | number | boolean> = {
        memory_total: stats.total,
        memory_active: stats.active,
        memory_superseded: stats.superseded,
        memory_retracted: stats.retracted,
        memory_disputed: stats.disputed,
        memory_unsupported: stats.unsupported,
        memory_contaminated: stats.contaminated,
        unregistered_predicate: stats.unregisteredPredicate,
        integrity_ok: stats.integrity.integrityOk,
        execution_count: executions.items.length,
        execution_page_has_more: executions.hasMore,
      }
      return {
        report: {
          metrics,
          notes: [
            `memory_total=${stats.total}`,
            `executions=${executions.items.length}`,
            '（unsupported / contaminated 目标为 0）',
          ],
        },
        verify: async () => {
          const again = await query.getMemoryStats({ characterId })
          const ok =
            again.total === metrics.memory_total &&
            again.active === metrics.memory_active &&
            again.retracted === metrics.memory_retracted &&
            again.unsupported === metrics.memory_unsupported &&
            again.contaminated === metrics.memory_contaminated &&
            again.unregisteredPredicate === metrics.unregistered_predicate
          return {
            ok,
            evidence:
              `重读 Memory 统计：total=${again.total} active=${again.active} ` +
              `retracted=${again.retracted} unsupported=${again.unsupported} ` +
              `contaminated=${again.contaminated}` +
              `（报告时为 ${metrics.memory_total}/${metrics.memory_active}/` +
              `${metrics.memory_retracted}/${metrics.memory_unsupported}/${metrics.memory_contaminated}）`,
          }
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface DeveloperControlServiceOptions {
  characterId: CharacterId
  /** 命令实现。缺省 = 用 query 面构造的两个只读命令（显式传入 `query` 时） */
  handlers: readonly ControlCommandHandler[]
  idempotency?: ControlIdempotencyStore
  now?: () => number
  /** 观察钩子：handler 真的被调了几次（门用它证明 dryRun / 重放都没有再调） */
  onHandlerRun?: (type: ControlCommandType) => void
  /**
   * WP9-A / U-03：**durable authoritative audit** 的写入口。
   *
   * 只在**权威执行链**（本服务内部）被调用；HTTP handler / 页面层**不得**调用它。
   * 它拿到的 `command.requestedBy.surface` 只会进 `transport` 列，**永远**不参与 principal / authority。
   * 缺省 = 不写审计（既是向后兼容，也是"writer 被拆掉时门必须变红"的负控入口）。
   */
  audit?: DeveloperControlAuditWriter
}

export interface DeveloperControlService {
  /** 白名单（只读；AT3.1 的"显式白名单"从此可被查询，而不是只写在代码里） */
  listCommands: () => readonly ControlledCommandFact[]
  /** 执行一条命令。**不抛错**：任何失败都以一个 `ControlExecution` 回来 */
  execute: (raw: unknown) => Promise<ControlExecution>
  /** 只读：已记录多少条幂等记录（门与排查用） */
  idempotencySize: () => Promise<number>
}

/**
 * 一次控制命令的**完整**结果。
 *
 * `result` 回答"走到了哪一步、成了没有"（AT3.6 的五档）；
 * `report` 回答"它看到了什么"（只读命令的产出）。
 * 两者**刻意分开**：把报告塞进 `ControlResult` 会让"执行真相"与"业务产出"
 * 混成一个东西，而 AT3.6 的判据只该看前者。
 */
export interface ControlExecution {
  result: ControlResult
  /** 只读命令的指标与说明；`rejected` / dryRun 时**没有**（没有执行就没有产出） */
  report?: ControlCommandReport
  /**
   * 这次是不是幂等重放（命中了之前的记录，**没有**再次执行）。
   *
   * ⚠️ 它是这个属性的**唯一**来源：`evidenceOf` 里的那几行说明由它派生，
   *    而不是反过来从字符串里解析出来。
   */
  replayed: boolean
}

export function createDeveloperControlService(
  options: DeveloperControlServiceOptions
): DeveloperControlService {
  const now = options.now ?? (() => Date.now())
  const idempotency = options.idempotency ?? createInMemoryControlIdempotencyStore()
  const audit = options.audit

  /**
   * WP9-A：把一次**有权威身份**的终态写进 durable audit；重放（`replayed: true`）**不**写第二行。
   * 形状层就失败的命令（没有 `ControlCommand`、也没有合法白名单 kind）**没有**权威身份可审计 ——
   * 而且 `developer_control_events.command_type` 的 CHECK 只允许白名单取值，物理上也放不进去。
   */
  const recordControlAudit = async (command: ControlCommand, result: ControlResult): Promise<void> => {
    if (audit === undefined) return
    await audit.record({ command, result, characterId: String(options.characterId) })
  }

  const handlerByType = new Map<ControlCommandType, ControlCommandHandler>()
  for (const handler of options.handlers) {
    if (handlerByType.has(handler.type)) {
      throw new KernelError(
        'validation_error',
        'control_handler_duplicate',
        `命令 ${handler.type} 注册了多个 handler`
      )
    }
    if (!isControlCommandType(handler.type)) {
      throw new KernelError(
        'validation_error',
        'control_handler_not_whitelisted',
        `handler 的 type ${String(handler.type)} 不在白名单里（AT3.1）`
      )
    }
    handlerByType.set(handler.type, handler)
  }

  /** 白名单里的每个命令都**必须**有实现，否则它就是一个"看得见点不动"的按钮 */
  const missing = CONTROL_COMMAND_TYPES.filter((type) => !handlerByType.has(type))
  if (missing.length > 0) {
    throw new KernelError(
      'validation_error',
      'control_handler_missing',
      `白名单里的命令没有实现：${missing.join(', ')} —— ` +
        '登记了一条命令却没有产出者，与"表达得了但永远触发不了"是同一种形状'
    )
  }

  function reasonOf(error: unknown): ControlReasonCode {
    if (isKernelError(error)) {
      const code = (error as KernelError).code
      if (
        code === 'command_forbidden' ||
        code === 'command_not_allowed' ||
        code === 'dry_run_not_supported' ||
        code === 'would_mutate_domain' ||
        code === 'missing_idempotency_key' ||
        code === 'command_invalid' ||
        code === 'scope_denied'
      ) {
        return code
      }
    }
    return 'command_invalid'
  }

  /**
   * 被拒绝的结果。
   *
   * ⚠️ 它**没有** `accepted` / `attempted` / `executed`：那三个布尔全部由
   *    `controlLadderBooleansOf('rejected')` 派生（唯一映射）。
   *    这里不写死它们，正是为了让"阶梯到布尔只有一处映射"这条纪律在代码里可见。
   */
  function rejected(options: {
    commandId: string
    idempotencyKey: string
    commandType: string
    reasonCode: ControlReasonCode
    message: string
    dryRun: boolean
  }): ControlResult {
    assertControlReasonCodeRegistered(options.reasonCode)
    const ladder = controlLadderBooleansOf('rejected')
    const result: ControlResult = {
      schemaVersion: CONTROL_SCHEMA_VERSION,
      commandId: options.commandId,
      idempotencyKey: options.idempotencyKey,
      commandType: options.commandType,
      outcome: 'rejected',
      disposition: 'none',
      ...ladder,
      verification: 'not_attempted',
      evidenceOf: {
        accepted: `control_registry（${options.reasonCode}）`,
        attempted: '未进入执行路径',
        executed: '未进入执行路径',
        verification: '未核验（没有执行过）',
      },
      reasonCode: options.reasonCode,
      dryRun: options.dryRun,
      startedAt: now(),
    }
    assertControlResult(result)
    return result
  }

  /** 从任意输入里尽力取出 id / key（为了让"被拒绝"也能被追溯）；取不到就用占位符 */
  function identify(raw: unknown): { commandId: string; idempotencyKey: string; type: string; dryRun: boolean } {
    const record = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const str = (value: unknown, fallback: string): string =>
      typeof value === 'string' && value.trim() !== '' ? value : fallback
    return {
      commandId: str(record.commandId, '(missing-command-id)'),
      idempotencyKey: str(record.idempotencyKey, '(missing-idempotency-key)'),
      type: str(record.type, '(missing-type)'),
      dryRun: record.dryRun === true,
    }
  }

  async function execute(raw: unknown): Promise<ControlExecution> {
    // ---- ① 形状（含白名单与禁止清单，全部 fail closed） --------------------
    let command: ControlCommand
    try {
      command = parseControlCommand(raw)
    } catch (error) {
      const identity = identify(raw)
      /*
       * 未知命令与禁止命令走**不同**的理由码：
       * "有人试图执行 RESET_KERNEL"必须与"有人拼错了"区分开（AT3.5）。
       */
      const reasonCode: ControlReasonCode = isForbiddenControlCommand(identity.type)
        ? 'command_forbidden'
        : reasonOf(error)
      return {
        result: rejected({
          commandId: identity.commandId,
          idempotencyKey: identity.idempotencyKey,
          commandType: identity.type,
          reasonCode,
          message: error instanceof Error ? error.message : String(error),
          dryRun: identity.dryRun,
        }),
        replayed: false,
      }
    }

    const fact = CONTROL_COMMAND_FACTS[command.type]

    // ---- ② 策略闸（AT3.2 / G-02 / STOP 条件 14） ---------------------------
    try {
      assertDeveloperSurfaceAllowed(fact)
      assertDryRunSupportedByFact(fact, command.dryRun)
    } catch (error) {
      const policyRejected = rejected({
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        commandType: command.type,
        reasonCode: reasonOf(error),
        message: error instanceof Error ? error.message : String(error),
        dryRun: command.dryRun,
      })
      await recordControlAudit(command, policyRejected)
      return {
        result: policyRejected,
        replayed: false,
      }
    }

    // ---- ③ 幂等（AT3.3）：命中就回**记录下来的那一条**，不再执行 ----------
    const recorded = await idempotency.get(command.idempotencyKey)
    if (recorded !== undefined) {
      /*
       * 重放**改变证据字符串**，而不是改变结论：
       *   · 结论必须与第一次逐字相同（否则"幂等"就没有意义）
       *   · 但 `evidenceOf` 必须说清"这次没有真的再跑一遍" ——
       *     否则读的人会以为又执行了一次（那正是 AT3.6 反对的那种含糊）
       */
      const replayMarker = 'control_idempotency_store（重放：本次没有再次执行）'
      const replay: ControlResult = {
        ...recorded.result,
        evidenceOf: {
          accepted: replayMarker,
          attempted: replayMarker,
          executed: replayMarker,
          verification: replayMarker,
        },
      }
      assertControlResult(replay)
      return { result: replay, ...(recorded.report !== undefined ? { report: recorded.report } : {}), replayed: true }
    }

    // ---- ④ dryRun（AT3.2）：允许，但**不进入执行路径** ---------------------
    if (command.dryRun) {
      const ladder = controlLadderBooleansOf('accepted')
      const result: ControlResult = {
        schemaVersion: CONTROL_SCHEMA_VERSION,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        commandType: command.type,
        outcome: 'accepted',
        disposition: 'none',
        ...ladder,
        verification: 'not_attempted',
        evidenceOf: {
          accepted: 'control_registry + preflight（dryRun）',
          attempted: 'dry_run：未进入执行路径',
          executed: 'dry_run：未进入执行路径',
          verification: 'dry_run：未核验（没有执行过）',
        },
        dryRun: true,
        startedAt: now(),
      }
      assertControlResult(result)
      await idempotency.put({
        idempotencyKey: command.idempotencyKey,
        commandId: command.commandId,
        commandType: command.type,
        result,
        recordedAt: now(),
      })
      await recordControlAudit(command, result)
      return { result, replayed: false }
    }

    // ---- ⑤ 真的执行 --------------------------------------------------------
    const handler = handlerByType.get(command.type)!
    const startedAt = now()
    options.onHandlerRun?.(command.type)

    let outcome: ControlCommandHandlerResult
    try {
      outcome = await handler.run({ characterId: options.characterId, command })
    } catch (error) {
      /*
       * 进入了执行路径但失败：`attempted` + `failed`。
       * 失败语义**复用** M4.5 的受控码（AT1.2 的 `error` 字段），不另造一套。
       */
      const reasonCode: ControlReasonCode =
        command.type === 'RUN_AUDIT' ? 'audit_failed' : 'diagnostic_failed'
      const ladder = controlLadderBooleansOf('attempted')
      const result: ControlResult = {
        schemaVersion: CONTROL_SCHEMA_VERSION,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        commandType: command.type,
        outcome: 'attempted',
        disposition: 'failed',
        ...ladder,
        verification: 'not_attempted',
        evidenceOf: {
          accepted: 'control_registry + preflight',
          attempted: `${command.type} handler 已被调用（本次失败）`,
          executed: 'handler 抛错，未返回结果',
          verification: '未核验（执行未完成）',
        },
        reasonCode,
        error: actionFailure(
          'execution_failed',
          error instanceof Error ? error.message : String(error)
        ),
        dryRun: false,
        startedAt,
        finishedAt: now(),
      }
      assertControlResult(result)
      await idempotency.put({
        idempotencyKey: command.idempotencyKey,
        commandId: command.commandId,
        commandType: command.type,
        result,
        recordedAt: now(),
      })
      await recordControlAudit(command, result)
      return { result, replayed: false }
    }

    // ---- ⑥ 核验：重读权威状态（AT3.6 的 verified / verification failed） ---
    const verification = await outcome.verify()
    const ladder = controlLadderBooleansOf(verification.ok ? 'verified' : 'executed')
    const report: ControlCommandReport = {
      metrics: {
        ...outcome.report.metrics,
        verification_ok: verification.ok,
      },
      notes: [
        ...outcome.report.notes,
        verification.ok ? '核验：重读一致' : '核验：重读不一致',
      ],
    }
    const result: ControlResult = {
      schemaVersion: CONTROL_SCHEMA_VERSION,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      commandType: command.type,
      outcome: verification.ok ? 'verified' : 'executed',
      disposition: 'succeeded',
      ...ladder,
      verification: verification.ok ? 'verified' : 'failed',
      evidenceOf: {
        accepted: 'control_registry + preflight',
        attempted: `${command.type} handler 已被调用`,
        executed: `${command.type} handler 已返回（${Object.keys(report.metrics).length} 项指标）`,
        verification: verification.ok
          ? '重读权威状态一致'
          : '重读权威状态不一致（报告的数与现在读到的数不同）',
      },
      ...(verification.ok ? { verificationEvidence: verification.evidence } : {}),
      dryRun: false,
      startedAt,
      finishedAt: now(),
    }
    assertControlResult(result)
    await idempotency.put({
      idempotencyKey: command.idempotencyKey,
      commandId: command.commandId,
      commandType: command.type,
      result,
      report,
      recordedAt: now(),
    })
    await recordControlAudit(command, result)
    return { result, report, replayed: false }
  }

  return {
    listCommands: () => CONTROL_COMMAND_TYPES.map((type) => ({ ...CONTROL_COMMAND_FACTS[type] })),
    execute,
    idempotencySize: () => idempotency.size(),
  }
}

/** 供日志与门共用的一行摘要（**不含参数**） */
export function describeControlOutcome(result: ControlResult): string {
  return describeControlResult(result)
}
