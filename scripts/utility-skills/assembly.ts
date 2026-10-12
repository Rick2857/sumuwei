/**
 * assembly —— 实用能力验收的**共享装配**（`scripts/utility-skills-verify.ts` 专用）。
 *
 * ============================================================================
 *  为什么要有这个文件
 * ============================================================================
 * 计划书 §4B 逐字要求：「运行**真实组件**和**实际 `TurnGateway`**，离线 provider
 * 只替换模型服务；不能只测一个直接调用函数就宣称聊天已接入。」
 *
 * 因此这里照抄 `src/main.ts` 的**实用能力接线**（三处，缺一不可）：
 *
 * ```text
 * ① 登记表      createUtilityCapabilityDefinitions()        —— 四项能力恒登记
 * ② 权限        MATH/DOCUMENT/WEB/OCR_*_PERMISSION          —— 只在开关打开时授予
 * ③ 适配器      只在开关打开时构造（关闭 ⇒ 构造上不存在执行器/出站/重依赖）
 * ④ 检测器      createUtilityIntentDetector({ math, document, web, ocr })
 * ⑤ 目标解析    与 main.ts 逐字同形（math → local_executor；web → remote_url；
 *                document/ocr → sandbox_file 的 resolveActionTarget）
 * ⑥ 轮次        真实 `TurnGateway`（beginTurn → compileTurn → completeTurn）
 * ⑦ 回复        五道守卫走**唯一实现** `runReplyGuardChain`
 * ```
 *
 * ⚠️ **离线 provider 只替换模型服务**：本模块里没有模型调用 —— 回复文本由调用方
 *    （fixture）给出，正是计划书 §4B「离线 provider 只替换模型服务」的形状。
 *    `--live` 走的是**另一个**入口（真 `src/main.ts` + `with-test-model`）。
 *
 * ⚠️ **不碰真实库**：本模块不 `isolateDatabase()`（由主脚本在 import 之前调），
 *    也不派生 `data/**` 下的任何沙箱根（调用方给）。
 *
 * ⚠️ 本文件在 `scripts/utility-skills/` 下、**不导出任何东西给 `src/`**
 *    （与 `scripts/m5.5-harness.ts` 同一条纪律）。
 */

import { sql } from 'drizzle-orm'

import { rowsOf } from '../../src/infrastructure/persistence/db.ts'
import { createActionLedgerStore } from '../../src/infrastructure/action/action-ledger-store.ts'
import { createEchoAdapter } from '../../src/infrastructure/action/adapters/echo.ts'
import {
  createSandboxReadAdapter,
  createSandboxWriteAdapter,
  listSandboxEntries,
} from '../../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import { createMathCalculateAdapter } from '../../src/infrastructure/action/adapters/math-calculate.ts'
import { createDocumentReadAdapter } from '../../src/infrastructure/action/adapters/document-read.ts'
import { createWebReadAdapter } from '../../src/infrastructure/action/adapters/web-read.ts'
import { createImageOcrAdapter } from '../../src/infrastructure/action/adapters/image-ocr.ts'
import { configuredOcrBackend } from '../../src/infrastructure/action/adapters/rapid-ocr-assets.ts'
import type { ImageOcrAdapterOptions } from '../../src/infrastructure/action/adapters/image-ocr.ts'
import type { DocumentReadOptions } from '../../src/infrastructure/action/adapters/document-read.ts'
import type { WebReadAdapterOptions } from '../../src/infrastructure/action/adapters/web-read.ts'
import {
  DEFAULT_GRANTED_PERMISSIONS,
  createCapabilityRegistry,
  createDefaultCapabilityDefinitions,
} from '../../src/kernel/action/capability-registry.ts'
import {
  WEB_SEARCH,
  WEB_SEARCH_PERMISSION,
  createExternalEvidenceCapabilityDefinitions,
} from '../../src/kernel/action/external-evidence-capability.ts'
import {
  DOCUMENT_READ,
  DOCUMENT_READ_PERMISSION,
  IMAGE_OCR,
  IMAGE_OCR_PERMISSION,
  MATH_CALCULATE,
  MATH_CALCULATE_PERMISSION,
  WEB_READ,
  WEB_READ_PERMISSION,
  createUtilityCapabilityDefinitions,
} from '../../src/kernel/action/utility-capabilities.ts'
import { createUtilityIntentDetector } from '../../src/kernel/action/utility-intent.ts'
import { createActionGateway } from '../../src/kernel/action/gateway.ts'
import { createActionTurnPort } from '../../src/kernel/action/action-turn.ts'
import type { ActionTurnResult } from '../../src/kernel/action/action-turn.ts'
import { createActionIntentDetector } from '../../src/kernel/action/intent-detector.ts'
import { chainIntentDetectors } from '../../src/kernel/action/external-evidence-intent.ts'
import { resolveActionTarget } from '../../src/kernel/action/target-resolver.ts'
import { hasSideEffect } from '../../src/kernel/action/action-request.ts'
import { runReplyGuardChain } from '../../src/kernel/app/reply-guard-chain.ts'
import type { ReplyGuardChainOutcome } from '../../src/kernel/app/reply-guard-chain.ts'
import { TurnGateway } from '../../src/kernel/app/turn-gateway.ts'
import type { IncomingTurn } from '../../src/kernel/app/turn-gateway.ts'
import { DEFAULT_CONTEXT_BUDGET, type ContextBudget } from '../../src/kernel/recall/selector.ts'
import type { ContextPacket } from '../../src/kernel/contracts/context.ts'
import type { CharacterRunTrace } from '../../src/kernel/contracts/trace.ts'
import type { TurnContent, TurnContentContextReality } from '../../src/kernel/contracts/turn-content.ts'
import type { ActionResult } from '../../src/kernel/action/action-result.ts'
import type { ExecutionRecordView, ExecutionLedgerPort } from '../../src/kernel/action/execution-ledger.ts'
import { createFixtureSearchProvider } from '../../src/infrastructure/search/fixture-search-provider.ts'

import type { M4Harness } from '../m4-harness.ts'

// ---------------------------------------------------------------------------
// 装配选项
// ---------------------------------------------------------------------------

/** 四项能力的开关（**与生产 flags 同名同义**：关闭 ⇒ 不授予权限、不构造适配器） */
export interface UtilityCapabilitySwitches {
  math?: boolean
  document?: boolean
  web?: boolean
  ocr?: boolean
}

export interface UtilityTurnOptions {
  /** 哪些能力被打开（= 生产 flags 的四个开关；缺省全关） */
  readonly switches: UtilityCapabilitySwitches
  /**
   * 权限是否跟着开关授予。
   *
   * `false` = 计划书 §4A 公共第 ① 组的"权限拒绝"半边：**检测器开着**
   * （所以用户显式要求会产生一条请求），但能力恒登记而**权限不授予**
   * ⇒ 一条可审计的 `permission_denied`。
   */
  readonly grantPermissions?: boolean
  /** 网页搜索（M5.5）是否打开；缺省 false（本批不测搜索回归） */
  readonly search?: boolean
  /** 是否接搜索判定器（缺省同 `search`） */
  readonly searchJudge?: boolean
  /** 当轮内容额度（缺省 2000 —— 计划书 §2 第 3 点给隔离验收定的值） */
  readonly turnContentTokens?: number
  /** 沙箱根（document / image.ocr / 旧文件能力都用它） */
  readonly sandboxRoot: string
  /** 可终止计算器的注入点（缺省 = 生产执行器） */
  readonly mathRunWorker?: (input: {
    expression: string
    timeoutMs: number
  }) => Promise<import('../../src/kernel/action/restricted-math.ts').RestrictedMathOutcome>
  /** 数学超时（缺省 = 生产 2000ms） */
  readonly mathTimeoutMs?: number
  /** 文档转换器的注入点（缺省 = 生产 Python 环境） */
  readonly documentConvert?: DocumentReadOptions['convert']
  readonly documentTimeoutMs?: number
  /** 网页读取的注入点（缺省 = 生产 HTTPS 获取器） */
  readonly web?: Pick<
    WebReadAdapterOptions,
    'fetchHtml' | 'resolve' | 'connect' | 'connectorOptions' | 'maxRedirects' | 'now' | 'maxBytes' | 'maxDomElements' | 'totalTimeoutMs'
  >
  /** OCR 资产与执行器（缺省 = 生产本地路径 + 生产子进程） */
  readonly ocr?: Omit<ImageOcrAdapterOptions, 'root'> & { readonly enabled?: boolean }
}

export interface UtilityTurnReading {
  readonly text: string
  /** fixture 给的"模型原文"（守卫之前） */
  readonly rawReplyText: string
  /** 守卫之后的正文（写在账本里的那一句） */
  readonly replyText: string
  readonly turn: IncomingTurn
  readonly packet: ContextPacket
  readonly trace: CharacterRunTrace
  readonly actionResults: readonly ActionTurnResult[]
  /** 这一轮动作结果里的**当轮内容**（内存载体，**含正文**） */
  readonly turnContent: readonly TurnContent[]
  readonly turnContentInContext?: TurnContentContextReality
  readonly guard: ReplyGuardChainOutcome
  readonly sectionIds: readonly string[]
  readonly sectionOf: (id: string) => string
  readonly stepKinds: readonly string[]
  readonly stepOf: (kind: string) => CharacterRunTrace['steps'][number] | undefined
}

export interface UtilityBedOptions {
  readonly harness: M4Harness
  readonly label: string
  readonly sandboxRoot: string
}

export interface UtilityBed {
  readonly harness: M4Harness
  readonly label: string
  readonly sandboxRoot: string
  readonly ledger: ExecutionLedgerPort
  /** 按需造一个真实轮次网关（每次调用都**新建** —— 与 `main.ts` 每次装配同形） */
  readonly turnGatewayOf: (options: UtilityTurnOptions) => TurnGateway
  /**
   * 跑一轮：真实网关（`beginTurn` → `compileTurn` → 回复守卫 → `completeTurn`）。
   *
   * ⚠️ **必须走 `beginTurn`**：动作段在那里面（`turn-gateway.ts:1150`），
   *    手搓一个 `IncomingTurn` 等于把"能力真的被调用过"整个跳过。
   * ⚠️ **回复守卫在 `completeTurn` 之前**：账本里不能留着一句没被检查的话
   *    （`main.ts:2577` 的现场纪律）。
   */
  readonly say: (input: {
    options: UtilityTurnOptions
    text: string
    replyText: string
  }) => Promise<UtilityTurnReading>
  readonly actionRows: () => Promise<readonly ExecutionRecordView[]>
  /** 逐表的原始 JSON（**用于隐私扫描**：这些表里不允许出现正文） */
  readonly tableTexts: (tables: readonly string[]) => Promise<Record<string, string>>
  readonly tableDigest: (table: string) => Promise<string>
  readonly dispose: () => Promise<void>
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

export function createUtilityBed(options: UtilityBedOptions): UtilityBed {
  const { harness: h } = options
  const sandboxOptions = { root: options.sandboxRoot }
  const searchProvider = createFixtureSearchProvider({ id: 'fixture-offline' })

  const registry = createCapabilityRegistry([
    ...createDefaultCapabilityDefinitions(),
    ...createExternalEvidenceCapabilityDefinitions(),
    /* 实用能力加装：四项能力**恒登记**（与 main.ts:1402 逐字同形） */
    ...createUtilityCapabilityDefinitions(),
  ])
  const ledger = createActionLedgerStore(h.kernel.stores.db)

  const turnGatewayOf = (turnOptions: UtilityTurnOptions): TurnGateway => {
    const switches = turnOptions.switches
    const grantPermissions = turnOptions.grantPermissions !== false

    const mathAdapter =
      switches.math === true
        ? createMathCalculateAdapter({
            ...(turnOptions.mathTimeoutMs !== undefined
              ? { timeoutMs: turnOptions.mathTimeoutMs }
              : {}),
            ...(turnOptions.mathRunWorker !== undefined
              ? { runWorker: turnOptions.mathRunWorker }
              : {}),
          })
        : undefined
    const documentAdapter =
      switches.document === true
        ? createDocumentReadAdapter({
            ...sandboxOptions,
            ...(turnOptions.documentConvert !== undefined
              ? { convert: turnOptions.documentConvert }
              : {}),
            ...(turnOptions.documentTimeoutMs !== undefined
              ? { timeoutMs: turnOptions.documentTimeoutMs }
              : {}),
          })
        : undefined
    const webReadAdapter =
      switches.web === true ? createWebReadAdapter(turnOptions.web ?? {}) : undefined
    const ocrOptions = turnOptions.ocr
    const ocrAdapter =
      switches.ocr === true
        ? createImageOcrAdapter({
            backend: ocrOptions?.backend ?? configuredOcrBackend(),
            ...(ocrOptions?.pythonPath !== undefined ? { pythonPath: ocrOptions.pythonPath } : {}),
            ...(ocrOptions?.modelDir !== undefined ? { modelDir: ocrOptions.modelDir } : {}),
            ...sandboxOptions,
            ...(ocrOptions?.workerScript !== undefined
              ? { workerScript: ocrOptions.workerScript }
              : {}),
            ...(ocrOptions?.languages !== undefined ? { languages: ocrOptions.languages } : {}),
            ...(ocrOptions?.timeoutMs !== undefined ? { timeoutMs: ocrOptions.timeoutMs } : {}),
            ...(ocrOptions?.maxImageBytes !== undefined
              ? { maxImageBytes: ocrOptions.maxImageBytes }
              : {}),
            ...(ocrOptions?.maxPixels !== undefined ? { maxPixels: ocrOptions.maxPixels } : {}),
            ...(ocrOptions?.env !== undefined ? { env: ocrOptions.env } : {}),
            ...(ocrOptions?.langPath !== undefined ? { langPath: ocrOptions.langPath } : {}),
            ...(ocrOptions?.cachePath !== undefined ? { cachePath: ocrOptions.cachePath } : {}),
            ...(ocrOptions?.corePath !== undefined ? { corePath: ocrOptions.corePath } : {}),
            ...(ocrOptions?.tesseractWorkerScript !== undefined
              ? { tesseractWorkerScript: ocrOptions.tesseractWorkerScript }
              : {}),
            ...(ocrOptions?.tesseractEntry !== undefined
              ? { tesseractEntry: ocrOptions.tesseractEntry }
              : {}),
          })
        : undefined

    const utilityPermissions = grantPermissions
      ? [
          ...(switches.math === true ? [MATH_CALCULATE_PERMISSION] : []),
          ...(switches.document === true ? [DOCUMENT_READ_PERMISSION] : []),
          ...(switches.web === true ? [WEB_READ_PERMISSION] : []),
          ...(switches.ocr === true ? [IMAGE_OCR_PERMISSION] : []),
        ]
      : []

    const gateway = createActionGateway({
      registry,
      ledger,
      adapters: [
        createEchoAdapter(),
        createSandboxReadAdapter(sandboxOptions),
        createSandboxWriteAdapter(sandboxOptions),
        ...(mathAdapter !== undefined ? [mathAdapter] : []),
        ...(documentAdapter !== undefined ? [documentAdapter] : []),
        ...(webReadAdapter !== undefined ? [webReadAdapter] : []),
        ...(ocrAdapter !== undefined ? [ocrAdapter] : []),
      ],
      grantedPermissions: [
        ...DEFAULT_GRANTED_PERMISSIONS,
        ...(turnOptions.search === true ? [WEB_SEARCH_PERMISSION] : []),
        ...utilityPermissions,
      ],
      maxRiskLevel: 'R1',
      /*
       * ⚠️ `dryRun: false` 是必须的：干跑时动作段整段跳过（`turn-gateway.ts:1152`），
       *    "能力真的被调用过"这件事在干跑里根本不存在。本装配跑在**隔离库**上。
       */
      dryRun: false,
      now: () => Date.now(),
      resolveTarget: async ({ request, operation }) => {
        /*
         * 与 `main.ts` 逐字同形（三档固定目标 + 沙箱文件那一档）。
         * 目标解析**不做**可达性判定：那是适配器执行前的准入检查。
         */
        if (request.capability === WEB_SEARCH) {
          return {
            target: {
              type: 'external_service',
              canonicalId: searchProvider.id,
              displayName: `离线 fixture 搜索服务（${searchProvider.endpointHost}）`,
              confidence: 'exact',
            },
            scopeViolation: false,
          }
        }
        if (request.capability === MATH_CALCULATE) {
          return {
            target: {
              type: 'local_executor',
              canonicalId: 'restricted-math',
              displayName: '本地受限计算器（BigNumber，白名单 AST）',
              confidence: 'exact',
            },
            scopeViolation: false,
          }
        }
        if (request.capability === WEB_READ) {
          const url = typeof request.arguments.url === 'string' ? request.arguments.url : ''
          return {
            target: {
              type: 'remote_url',
              canonicalId: url,
              displayName: url,
              confidence: url === '' ? 'none' : 'exact',
            },
            scopeViolation: false,
          }
        }
        return await resolveActionTarget({
          targetType: 'sandbox_file',
          ...(request.target !== undefined ? { declared: request.target } : {}),
          hints: typeof request.arguments.path === 'string' ? [request.arguments.path] : [],
          listEntries: () => listSandboxEntries(sandboxOptions),
          allowMissing: operation !== undefined && hasSideEffect(operation.sideEffect),
        })
      },
    })

    const actionPort = createActionTurnPort({
      gateway,
      detector: chainIntentDetectors([
        createActionIntentDetector(),
        createUtilityIntentDetector({
          math: switches.math === true,
          document: switches.document === true,
          web: switches.web === true,
          ocr: switches.ocr === true,
        }),
      ]),
      registry,
    })

    const budget: ContextBudget = {
      ...DEFAULT_CONTEXT_BUDGET,
      turnContentTokens: turnOptions.turnContentTokens ?? 2000,
      externalEvidenceTokens: turnOptions.search === true ? 800 : 0,
    }

    return new TurnGateway({
      kernel: h.kernel,
      definition: h.kernel.definition,
      identity: h.kernel.identitySnapshot,
      recorder: h.recorder,
      /* ⚠️ 传函数本身，不要包一层（包一层会让序号双跳） */
      conversationSequence: h.nextTurnSequence,
      recentLimit: 16,
      slowPathEnabled: false,
      dryRun: false,
      userId: h.userId,
      actionWriter: actionPort,
      actionEnabled: true,
      recallBudget: budget,
    })
  }

  const say: UtilityBed['say'] = async (input) => {
    const gateway = turnGatewayOf(input.options)
    const turn = await gateway.beginTurn(input.text)
    const packet = await gateway.compileTurn({ turn, currentInput: input.text, recentLines: [] })

    /*
     * 回复守卫链 —— 与 `main.ts:2577` 同一条顺序、同一个实现。
     * ⚠️ 它跑在 `completeTurn` **之前**：写账本的那句话必须是检查过的那句。
     */
    const guard = runReplyGuardChain({
      replyText: input.replyText,
      ...(turn.actionResults !== undefined ? { actionResults: turn.actionResults } : {}),
      ...(turn.turnContentInContext !== undefined
        ? { turnContentInContext: turn.turnContentInContext }
        : {}),
      ...(turn.externalEvidenceInContext !== undefined
        ? { externalEvidenceInContext: turn.externalEvidenceInContext }
        : {}),
    })

    const outgoing = await gateway.completeTurn({ turn, replyText: guard.replyText })

    const sectionOf = (id: string): string =>
      packet.sections.find((section) => String(section.id) === id)?.content ?? ''
    const stepOf = (kind: string): CharacterRunTrace['steps'][number] | undefined =>
      outgoing.trace.steps.find((step) => String(step.kind) === kind)

    return {
      text: input.text,
      rawReplyText: input.replyText,
      replyText: guard.replyText,
      turn,
      packet,
      trace: outgoing.trace,
      actionResults: turn.actionResults ?? [],
      turnContent: turn.turnContent ?? [],
      ...(turn.turnContentInContext !== undefined
        ? { turnContentInContext: turn.turnContentInContext }
        : {}),
      guard,
      sectionIds: packet.sections.map((section) => String(section.id)),
      sectionOf,
      stepKinds: outgoing.trace.steps.map((step) => String(step.kind)),
      stepOf,
    }
  }

  return {
    harness: h,
    label: options.label,
    sandboxRoot: options.sandboxRoot,
    ledger,
    turnGatewayOf,
    say,
    async actionRows() {
      return await ledger.listRecords({ characterId: h.kernel.characterId, limit: 100 })
    },
    async tableTexts(tables) {
      const out: Record<string, string> = {}
      for (const table of tables) {
        const rows = rowsOf(await h.kernel.stores.db.execute(sql.raw(`select * from "${table}"`)))
        out[table] = JSON.stringify(rows)
      }
      return out
    },
    async tableDigest(table) {
      const rows = rowsOf(await h.kernel.stores.db.execute(sql.raw(`select * from "${table}"`)))
      return JSON.stringify(
        rows
          .map((row) =>
            Object.keys(row)
              .sort()
              .map((key) => [key, row[key] ?? null])
          )
          .sort()
      )
    },
    async dispose() {
      await h.stop()
    },
  }
}

// ---------------------------------------------------------------------------
// 小工具（组运行器共用）
// ---------------------------------------------------------------------------

/** 这一轮里第一个动作结果（没有动作时 undefined） */
export function firstResult(reading: UtilityTurnReading): ActionResult | undefined {
  for (const item of reading.actionResults) {
    if (item.result !== undefined) return item.result
  }
  return undefined
}

/** 这一轮里某个能力的动作结果 */
export function resultOf(reading: UtilityTurnReading, capability: string): ActionResult | undefined {
  for (const item of reading.actionResults) {
    if (item.result !== undefined && String(item.result.capability) === capability) return item.result
  }
  return undefined
}

/** 这一轮动作结果的终态摘要（进 run.json 的观察值；**不含正文**） */
export function summarizeActions(
  reading: UtilityTurnReading
): readonly { capability: string; status: string; accepted: boolean; executed: boolean; failureCode?: string; rule?: string }[] {
  return reading.actionResults.map((item) => ({
    capability: String(item.result?.capability ?? '(无结果)'),
    status: String(item.result?.status ?? '(未执行)'),
    accepted: item.result?.accepted === true,
    executed: item.result?.executed === true,
    ...(item.result?.error?.code !== undefined ? { failureCode: item.result.error.code } : {}),
    ...(item.rule !== undefined ? { rule: item.rule } : {}),
  }))
}

/** 隐私扫描：给定表集合，找出**第一个**出现 `sentinel` 的表（没有就 undefined） */
export function findSentinelInTables(
  tableTexts: Record<string, string>,
  sentinel: string
): string | undefined {
  for (const [table, text] of Object.entries(tableTexts)) {
    if (text.includes(sentinel)) return table
  }
  return undefined
}
