/**
 * M4.5 验收脚本的**共享装配**（L2 / L0 / L3 共用）。
 *
 * ============================================================================
 *  为什么要有这个文件
 * ============================================================================
 * L2（子系统）、L0（量具）、L3（自然语言集成）都需要同一套东西：
 *
 *     隔离库 + characterId + Execution Ledger + Capability Registry + Gateway
 *     + 真实文件系统沙箱（临时目录）
 *
 * 抄三遍的代价不是"多打几个字"，而是**三份装配会漂移** ——
 * 某一份忘了传 `grantedPermissions`，它测出来的就是另一个系统
 * （M4 的 §5.6 缺口② 正是这么发生的：生产内核没注册 MEMORY_*）。
 *
 * 因此装配**只写一遍**，且**照抄生产装配**（`src/main.ts` 的
 * `buildActionWriter` / `buildActionGateway`）：
 * registry 是登记表、权限是显式授予、沙箱根由这里注入。
 *
 * ⚠️ 它**不是**生产代码：只被 `scripts/verify-m4.5-*.ts` 引用。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { AgentRuntime, type Character, type Plugin } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import openaiPlugin from '@elizaos/plugin-openai'
import bootstrapPlugin from '@elizaos/plugin-bootstrap'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { getRawDb, type RawDb } from '../src/infrastructure/persistence/db.ts'
import { asCharacterId, asTraceId, newActionId, type CharacterId } from '../src/kernel/contracts/ids.ts'
import { createActionLedgerStore } from '../src/infrastructure/action/action-ledger-store.ts'
import {
  createSandboxReadAdapter,
  createSandboxWriteAdapter,
  listSandboxEntries,
} from '../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import { createEchoAdapter } from '../src/infrastructure/action/adapters/echo.ts'
import {
  DEFAULT_GRANTED_PERMISSIONS,
  SANDBOX_FILE_WRITE,
  createCapabilityRegistry,
  createDefaultCapabilityDefinitions,
  type CapabilityDefinition,
  type CapabilityRegistry,
} from '../src/kernel/action/capability-registry.ts'
import type { CapabilityAdapter } from '../src/kernel/action/executor-port.ts'
import { createActionGateway, type ActionGateway, type ActionGatewayOptions } from '../src/kernel/action/gateway.ts'
import { createActionIntentDetector } from '../src/kernel/action/intent-detector.ts'
import { createActionTurnPort, type ActionTurnPort } from '../src/kernel/action/action-turn.ts'
import { createActionRequest, hasSideEffect, type ActionRequest, type RiskLevel } from '../src/kernel/action/action-request.ts'
import { resolveActionTarget, type SandboxEntry } from '../src/kernel/action/target-resolver.ts'
import type { ActionResult } from '../src/kernel/action/action-result.ts'
import type { ExecutionLedgerPort, ExecutionRecordView } from '../src/kernel/action/execution-ledger.ts'

// ---------------------------------------------------------------------------
// 报告器
// ---------------------------------------------------------------------------

export interface Reporter {
  check: (label: string, condition: boolean, detail?: string) => void
  section: (title: string) => void
  readonly passed: number
  readonly failed: number
  readonly failures: readonly string[]
  finish: (title: string, evidence?: Record<string, unknown>) => never
}

export function createReporter(): Reporter {
  let passed = 0
  let failed = 0
  const failures: string[] = []

  return {
    check(label, condition, detail = '') {
      if (condition) {
        passed += 1
        console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`)
      } else {
        failed += 1
        failures.push(label)
        console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
      }
    },
    section(title) {
      console.log(`\n=== ${title} ===`)
    },
    get passed() {
      return passed
    },
    get failed() {
      return failed
    },
    get failures() {
      return failures
    },
    finish(title) {
      console.log(`\n${'='.repeat(72)}`)
      console.log(`${title}：${passed} 通过 / ${failed} 失败`)
      if (failures.length > 0) console.log(`失败项：${failures.join(' | ')}`)
      console.log('='.repeat(72))
      process.exit(failed === 0 ? 0 : 1)
    },
  }
}

// ---------------------------------------------------------------------------
// 测试台
// ---------------------------------------------------------------------------

export interface ActionTestBedOptions {
  label: string
  /** 额外登记的能力（故障注入 / 部分成功用） */
  extraCapabilities?: readonly CapabilityDefinition[]
  extraAdapters?: readonly CapabilityAdapter[]
  grantedPermissions?: readonly string[]
  maxRiskLevel?: RiskLevel
  dryRun?: boolean
  /** 沙箱根绝对路径（缺省是本测试台自己的临时目录） */
  sandboxRoot?: string
  /**
   * **覆盖**目标解析（缺省 = 沙箱梯子，逐字不变）。
   *
   * 用途：非沙箱能力族（例如 `qq_private_owner`）需要装配层给出自己那一支 resolver；
   * 缺省不传 ⇒ 本测试台的行为与既有 M4.5 验收脚本**完全一致**。
   */
  resolveTarget?: ActionGatewayOptions['resolveTarget']
}

export interface ActionTestBed {
  characterId: CharacterId
  db: RawDb
  ledger: ExecutionLedgerPort
  registry: CapabilityRegistry
  gateway: ActionGateway
  turnPort: ActionTurnPort
  sandboxRoot: string
  /** 直接发一个请求（用于 L2 的请求级断言） */
  execute(input: {
    capability: string
    operation: string
    args?: Record<string, unknown>
    idempotencyKey?: string
    requestedBy?: ActionRequest['requestedBy']
    target?: ActionRequest['target']
    traceId?: string
  }): Promise<ActionResult>
  /** 从**用户真实文本**进入（用于 L3） */
  say(text: string): Promise<ActionResult | undefined>
  records(query?: { status?: ExecutionRecordView['status']; capability?: string; limit?: number }): Promise<ExecutionRecordView[]>
  sandboxFiles(): Promise<readonly SandboxEntry[]>
  sandboxFile(relativePath: string): string | undefined
  writeSandboxFile(relativePath: string, content: string): void
  dirBlocked(relativePath: string): void
  stop(): Promise<void>
}

/**
 * 建一个测试台。
 *
 * ⚠️ 同一进程里只有一个库生效（plugin-sql 的进程级单例）。
 *    需要第二个库时必须先 `resetPluginSqlConnection()` ——
 *    见 `src/dev/sandbox.ts` 的说明与 `verify-m4.5-nl-action.ts` 的做法。
 */
export async function createActionTestBed(options: ActionTestBedOptions): Promise<ActionTestBed> {
  const runtime = new AgentRuntime({
    character: character as Character,
    plugins: [
      openaiPlugin,
      bootstrapPlugin,
      sqlPlugin,
      // 刻意不装 persistent-character plugin：动作链路不需要它，
      // 而少一个 plugin 意味着少一份可能与生产不同的行为。
    ] as Plugin[],
    conversationLength: 16,
    settings: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'placeholder',
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
      OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
      OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
    },
  })

  await initDatabase(runtime, sqlPlugin)
  const db = getRawDb(runtime)
  const characterId = asCharacterId(character.id ?? character.name)

  const sandboxRoot =
    options.sandboxRoot ?? join(mkdtempSync(join(tmpdir(), 'project-lg-m45-fs-')), 'sandbox')
  mkdirSync(sandboxRoot, { recursive: true })

  const registry = createCapabilityRegistry([
    ...createDefaultCapabilityDefinitions(),
    ...(options.extraCapabilities ?? []),
  ])

  const ledger = createActionLedgerStore(db)
  const sandboxOptions = { root: sandboxRoot }

  const gateway = createActionGateway({
    registry,
    ledger,
    adapters: [
      createEchoAdapter(),
      createSandboxReadAdapter(sandboxOptions),
      createSandboxWriteAdapter(sandboxOptions),
      ...(options.extraAdapters ?? []),
    ],
    grantedPermissions: options.grantedPermissions ?? DEFAULT_GRANTED_PERMISSIONS,
    maxRiskLevel: options.maxRiskLevel ?? 'R1',
    dryRun: options.dryRun === true,
    now: () => Date.now(),
    resolveTarget:
      options.resolveTarget ??
      (async ({ request, operation }) =>
        resolveActionTarget({
          targetType: 'sandbox_file',
          ...(request.target !== undefined ? { declared: request.target } : {}),
          hints: typeof request.arguments.path === 'string' ? [request.arguments.path] : [],
          listEntries: () => listSandboxEntries(sandboxOptions),
          allowMissing: operation !== undefined && hasSideEffect(operation.sideEffect),
        })),
  })

  const turnPort = createActionTurnPort({
    gateway,
    detector: createActionIntentDetector(),
    registry,
  })

  const bed: ActionTestBed = {
    characterId,
    db,
    ledger,
    registry,
    gateway,
    turnPort,
    sandboxRoot,

    async execute(input) {
      const definition = registry.get(input.capability)
      const operation = registry.getOperation(input.capability, input.operation)
      const request = createActionRequest({
        actionId: newActionId(),
        traceId: asTraceId(input.traceId ?? `trc:bed-${options.label}`),
        capability: input.capability,
        operation: input.operation,
        requestedBy: input.requestedBy ?? { kind: 'user', id: 'user-bed' },
        ...(input.target !== undefined ? { target: input.target } : {}),
        arguments: input.args ?? {},
        sideEffect: operation?.sideEffect ?? definition?.sideEffectLevel ?? 'none',
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      })
      return gateway.execute(characterId, request)
    },

    async say(text) {
      const outcome = await turnPort.handleTurn({
        characterId,
        traceId: asTraceId(`trc:bed-say-${options.label}-${Date.now()}`),
        text,
        eventId: 'cev:bed-synthetic',
        speaker: { kind: 'user', id: 'user-bed' },
      })
      return outcome.result
    },

    async records(query = {}) {
      return ledger.listRecords({
        characterId,
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.capability !== undefined ? { capability: query.capability } : {}),
        limit: query.limit ?? 50,
      })
    },

    async sandboxFiles() {
      return listSandboxEntries(sandboxOptions)
    },

    sandboxFile(relativePath) {
      const absolute = resolve(sandboxRoot, relativePath)
      if (!existsSync(absolute)) return undefined
      return readFileSync(absolute, 'utf8')
    },

    writeSandboxFile(relativePath, content) {
      const absolute = resolve(sandboxRoot, relativePath)
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, content, 'utf8')
    },

    dirBlocked(relativePath) {
      // 造一个**同名目录**：写一个文件到它上面会失败，而这不是破坏性操作
      mkdirSync(resolve(sandboxRoot, relativePath), { recursive: true })
    },

    async stop() {
      await runtime.stop()
      rmSync(sandboxRoot, { recursive: true, force: true })
    },
  }

  return bed
}

// ---------------------------------------------------------------------------
// 故障注入 / 部分成功（§28 / S6）
// ---------------------------------------------------------------------------

export const FAULTY_WRITE = 'test.faulty.write'
export const PARTIAL_WRITE = 'test.partial.write'

/** 一个"总是失败"的适配器：用来验证 failed 不会被渲染成成功 */
export function faultyWriteCapability(): CapabilityDefinition {
  return {
    id: FAULTY_WRITE,
    version: 'test.faulty.write@1',
    description: '总是失败的写能力（故障注入；只在验收脚本里登记）',
    operations: [{ name: 'write', description: '总是抛错', sideEffect: 'write', riskLevel: 'R1' }],
    sideEffectLevel: 'write',
    riskLevel: 'R1',
    permissions: ['sandbox:write'],
    supportsDryRun: true,
    idempotency: 'supported',
  }
}

export function createFaultyWriteAdapter(counter: { calls: number }): CapabilityAdapter {
  return {
    capabilityId: FAULTY_WRITE,
    async execute() {
      counter.calls += 1
      throw new Error('注入的失败：磁盘满了')
    },
  }
}

/** 一个"部分成功"的适配器：3 个里成功 2 个（§28） */
export function partialWriteCapability(): CapabilityDefinition {
  return {
    id: PARTIAL_WRITE,
    version: 'test.partial.write@1',
    description: '部分成功的写能力（只在验收脚本里登记）',
    operations: [{ name: 'write', description: '3 个里成功 2 个', sideEffect: 'write', riskLevel: 'R1' }],
    sideEffectLevel: 'write',
    riskLevel: 'R1',
    permissions: ['sandbox:write'],
    supportsDryRun: true,
    idempotency: 'supported',
  }
}

export function createPartialWriteAdapter(): CapabilityAdapter {
  return {
    capabilityId: PARTIAL_WRITE,
    async execute() {
      return {
        effect: {
          kind: 'file_created' as const,
          detail: '2/3 个文件写入成功',
        },
        evidence: [
          { kind: 'filesystem' as const, detail: 'a.txt 写入成功' },
          { kind: 'filesystem' as const, detail: 'b.txt 写入成功' },
          { kind: 'filesystem' as const, detail: 'c.txt 失败' },
        ],
        partial: { completed: 2, total: 3, detail: '3 个文件里成功 2 个' },
      }
    },
  }
}

export { SANDBOX_FILE_WRITE }
