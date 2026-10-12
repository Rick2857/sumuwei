/**
 * assembly —— 第二批验收的**共享装配**（`scripts/productivity-skills-verify.ts` 专用）。
 *
 * ============================================================================
 *  它照抄 `src/main.ts` 的第二批接线，一处不少
 * ============================================================================
 * ```text
 * ① 登记表    M4.5 三能力 + M5.5 外部证据 + 第一批四项 + **第二批七项**（全部恒登记）
 * ② 权限      只在对应开关打开时授予（关闭 ⇒ 可审计的 permission_denied）
 * ③ 适配器    只在对应开关打开时构造（关闭 ⇒ 构造上不存在执行器 / 出站 / 子进程）
 * ④ 检测器    M4.5 → 第一批四项 → **本机文件域** → **天气/资讯** → M5.5
 * ⑤ 目标解析  与 main.ts 同形（固定服务目标 + 本机绝对路径那一档 + 沙箱那一档）
 * ⑥ 任务环    真 `runTask` + 真 `ActionGateway`，规划器**注入**（离线确定性）
 * ⑦ 轮次      真 `TurnGateway`（beginTurn → compileTurn → completeTurn）
 * ⑧ 回复      五道守卫走**唯一实现** `runReplyGuardChain`
 * ```
 *
 * ⚠️ **离线只替换两样东西**：模型服务（规划器 / 回复文本由 fixture 给）与出站 IO
 *    （天气 fetch / 资讯 fetcher 注入夹具）。其余全是生产实现。
 *
 * ⚠️ **不碰真实库**：本模块不 `isolateDatabase()`（由主脚本在 import 之前调）。
 */

import { sql } from 'drizzle-orm'

import { rowsOf } from '../../src/infrastructure/persistence/db.ts'
import { createActionLedgerStore } from '../../src/infrastructure/action/action-ledger-store.ts'
import { createLearningCapabilityDefinitions } from '../../src/kernel/action/learning-capabilities.ts'
import { createEchoAdapter } from '../../src/infrastructure/action/adapters/echo.ts'
import {
  createSandboxReadAdapter,
  createSandboxWriteAdapter,
  listSandboxEntries,
} from '../../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import {
  createLocalListAdapter,
  createLocalReadAdapter,
  createLocalWriteAdapter,
  resolveLocalAbsolutePath,
} from '../../src/infrastructure/action/adapters/local-filesystem.ts'
import type { BrowserAdapterOptions } from '../../src/infrastructure/action/adapters/browser.ts'
import type { WebReadAdapterOptions } from '../../src/infrastructure/action/adapters/web-read.ts'
import { createWebReadAdapter } from '../../src/infrastructure/action/adapters/web-read.ts'
import { createDocumentReadAdapter } from '../../src/infrastructure/action/adapters/document-read.ts'
import { createImageOcrAdapter } from '../../src/infrastructure/action/adapters/image-ocr.ts'
import { createMathCalculateAdapter } from '../../src/infrastructure/action/adapters/math-calculate.ts'
import type { ImageOcrAdapterOptions } from '../../src/infrastructure/action/adapters/image-ocr.ts'
import { configuredOcrBackend } from '../../src/infrastructure/action/adapters/rapid-ocr-assets.ts'
import { createWebSearchAdapter } from '../../src/infrastructure/action/adapters/web-search.ts'
import { createSha256Fingerprinter } from '../../src/infrastructure/search/fingerprint.ts'
import { createBrowserAdapters } from '../../src/infrastructure/action/adapters/browser.ts'
import type { CapabilityAdapter } from '../../src/kernel/action/executor-port.ts'
import {
  DESKTOP_INSPECT,
  DESKTOP_INSPECT_PERMISSION,
  DESKTOP_OPERATE,
  DESKTOP_OPERATE_PERMISSION,
  createDesktopCapabilityDefinitions,
  isDesktopCapability,
} from '../../src/kernel/action/desktop-capability.ts'
import type { WeatherAdapterOptions } from '../../src/infrastructure/action/adapters/weather.ts'
import { createWeatherAdapter } from '../../src/infrastructure/action/adapters/weather.ts'
import type { NewsReadOptions } from '../../src/infrastructure/action/adapters/news-read.ts'
import { createNewsReadAdapter } from '../../src/infrastructure/action/adapters/news-read.ts'
import type { OfficeGenerateOptions } from '../../src/infrastructure/action/adapters/office-generate.ts'
import { createOfficeGenerateAdapter } from '../../src/infrastructure/action/adapters/office-generate.ts'
import {
  DEFAULT_GRANTED_PERMISSIONS,
  SANDBOX_FILE_READ,
  SANDBOX_FILE_WRITE,
  SYSTEM_ECHO,
  createCapabilityRegistry,
  createDefaultCapabilityDefinitions,
  type CapabilityRegistry,
} from '../../src/kernel/action/capability-registry.ts'
import {
  WEB_SEARCH,
  WEB_SEARCH_PERMISSION,
  createExternalEvidenceCapabilityDefinitions,
} from '../../src/kernel/action/external-evidence-capability.ts'
import {
  DOCUMENT_READ,
  IMAGE_OCR,
  MATH_CALCULATE,
  MATH_CALCULATE_PERMISSION,
  DOCUMENT_READ_PERMISSION,
  IMAGE_OCR_PERMISSION,
  WEB_READ_PERMISSION,
  WEB_READ,
  createUtilityCapabilityDefinitions,
} from '../../src/kernel/action/utility-capabilities.ts'
import {
  LOCAL_FILE_LIST,
  LOCAL_FILE_LIST_PERMISSION,
  LOCAL_FILE_READ,
  LOCAL_FILE_READ_PERMISSION,
  LOCAL_FILE_WRITE,
  LOCAL_FILE_WRITE_PERMISSION,
  createLocalFileCapabilityDefinitions,
  isLocalFileCapability,
} from '../../src/kernel/action/local-file-capabilities.ts'
/* 用户 2026-10-05 裁定（`L-RTD-18`）：文档 / 图片读取也按本机文件域判定 */
import { isDiskWideCapability } from '../../src/kernel/action/disk-wide-scope.ts'
import {
  WEATHER_QUERY,
  WEATHER_QUERY_PERMISSION,
  createWeatherCapabilityDefinitions,
} from '../../src/kernel/action/weather-capability.ts'
import {
  OFFICE_GENERATE,
  OFFICE_GENERATE_PERMISSION,
  createOfficeCapabilityDefinitions,
} from '../../src/kernel/action/office-capability.ts'
import {
  NEWS_READ,
  NEWS_READ_PERMISSION,
  createNewsCapabilityDefinitions,
} from '../../src/kernel/action/news-capability.ts'
import {
  BROWSER_MCP,
  BROWSER_MCP_PERMISSION,
  BROWSER_OPERATE,
  BROWSER_OPERATE_PERMISSION,
  BROWSER_READ,
  BROWSER_READ_PERMISSION,
  createBrowserCapabilityDefinitions,
  isBrowserCapability,
} from '../../src/kernel/action/browser-capability.ts'
import { createLocalFileIntentDetector } from '../../src/kernel/action/local-file-intent.ts'
import { createWeatherIntentDetector } from '../../src/kernel/action/weather-news-intent.ts'
import { createUtilityIntentDetector } from '../../src/kernel/action/utility-intent.ts'
import type { ToolDecisionPort } from '../../src/kernel/action/tool-decision.ts'
import { buildToolCatalog, renderToolCatalogForModel } from '../../src/kernel/action/tool-catalog.ts'
import { resolveLocalTarget } from '../../src/kernel/action/local-target.ts'
import { createInMemoryPayloadStaging, type PayloadStagingPort } from '../../src/kernel/action/payload-staging.ts'
import { createTaskAuthorizationRegistry } from '../../src/kernel/action/task-authorization.ts'
import type { TaskPlannerPort } from '../../src/kernel/action/task-plan.ts'
import { createActionGateway } from '../../src/kernel/action/gateway.ts'
import type { ActionGateway, ActionInvocationContext } from '../../src/kernel/action/gateway.ts'
import { attestActionInitiatorUnresolved } from '../../src/kernel/contracts/attribution.ts'
import type { ActionPolicyScopeWording } from '../../src/kernel/action/policy.ts'
import type { RiskLevel } from '../../src/kernel/action/action-request.ts'
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
import type {
  TurnContent,
  TurnContentContextReality,
  TurnContentSourceKind,
} from '../../src/kernel/contracts/turn-content.ts'
import type { ActionResult } from '../../src/kernel/action/action-result.ts'
import type { ExecutionRecordView, ExecutionLedgerPort } from '../../src/kernel/action/execution-ledger.ts'
import { createFixtureSearchProvider } from '../../src/infrastructure/search/fixture-search-provider.ts'

import type { M4Harness } from '../m4-harness.ts'

// ---------------------------------------------------------------------------
// 开关（**与生产 flags 同名同义**）
// ---------------------------------------------------------------------------

export interface ProductivitySwitches {
  /** 第一批四项（本批只用于"旧能力逐字不变"那一条兼容断言） */
  readonly math?: boolean
  readonly document?: boolean
  readonly webRead?: boolean
  readonly ocr?: boolean
  /** 第二批：本机文件域 */
  readonly localFileRead?: boolean
  readonly localFileWrite?: boolean
  /** 第二批：任务执行环 */
  readonly taskAutonomy?: boolean
  /** 第二批：四项业务能力 */
  readonly weather?: boolean
  readonly office?: boolean
  readonly news?: boolean
  readonly browser?: boolean
  /**
   * ★ 2026-10-09 / `ADR-125`：全工具档（与 `main.ts` 的 `browserFullTools` 同形）。
   *
   * ⚠️ 与 `browser` **分开**：开着浏览器 ≠ 允许任意工具入口。
   *    床里 `browser-05` 用这两个开关的正负组合照 `browser.mcp` 那条路。
   */
  readonly browserFullTools?: boolean
  /**
   * ADR-106：桌面两档（**分开**：只看 ≠ 能动手）。
   *
   * ⚠️ 床里**不**接真 worker：桌面适配器由 `desktopAdapters` **注入**
   *    （离线门不该因为"这台机器现在有没有桌面元素"而变红，
   *     那是 `desktop-control:probe` 的职责）。
   */
  readonly desktopInspect?: boolean
  readonly desktopOperate?: boolean
}

export interface ProductivityTurnOptions {
  readonly switches: ProductivitySwitches
  /** `false` = 公共第 ① 组的"权限拒绝"半边（检测器开、权限不授予） */
  readonly grantPermissions?: boolean
  readonly search?: boolean
  /** 当轮内容额度 */
  readonly turnContentTokens?: number
  /** 沙箱根（旧能力 + 第一批文档/OCR 用） */
  readonly sandboxRoot: string
  /** 恢复副本根 */
  readonly recoveryRoot: string
  /** 载荷暂存（缺省每次新建；任务环与写入适配器必须共用同一个） */
  readonly staging?: PayloadStagingPort
  /** 离线规划器（缺省 = 一个"什么都不做"的规划器） */
  readonly planner?: TaskPlannerPort
  /** 任务级风险额度（缺省 R1 → 浏览器 operate 会被策略第 ④ 步拒绝） */
  readonly taskRiskLevel?: RiskLevel
  readonly taskMaxActions?: number
  readonly taskMaxPlans?: number
  /** 天气出站夹具 */
  readonly weatherFetch?: WeatherAdapterOptions['fetchImpl']
  /** 资讯出站夹具 */
  readonly news?: Pick<NewsReadOptions, 'fetcher' | 'parse'>
  /** 办公生成器注入点 */
  readonly office?: Pick<OfficeGenerateOptions, 'pythonPath' | 'generatorPath' | 'timeoutMs'>
  /** 浏览器 sidecar 地址与 fetch */
  readonly browser?: Pick<BrowserAdapterOptions, 'sidecarUrl' | 'fetchImpl' | 'timeoutMs'>
  /**
   * ADR-106：**注入**的桌面适配器（缺省 = 一个都不装）。
   *
   * ⚠️ 装的是适配器而不是"worker 路径"，理由是让离线门与"这台机器此刻的桌面"解耦：
   *    真 worker 的读数在 `desktop-control:probe`（实机只读门）。
   */
  readonly desktopAdapters?: readonly CapabilityAdapter[]
  /** 目标解析的注入点（只给"沙箱那一档"用；缺省 = 真沙箱枚举） */
  readonly listEntriesError?: boolean
  /**
   * WP3：**故意不授予**的权限（缺省空）。
   *
   * ⚠️ 它存在的唯一理由是让"**提案 ≠ 权限**"可被离线构造：让一个能力**留在任务授权集合里**
   *    （开关开着），但把它的权限从网关的授予清单里拿掉 —— 那是真实世界里
   *    "配置漏了一条"的形态。缺省空 ⇒ 与生产同形（每一项权限都由对应开关授予）。
   */
  readonly omitPermissions?: readonly string[]
  /**
   * WP1 / ADR-104：**角色自行选择工具**的决策端口（配了 ⇒ 这一轮走 role 路径）。
   *
   * ⚠️ 目录文本**缺省由本床按开关现算**（与 `main.ts` 同形：同一份能力清单 +
   *    同一份已授予权限），因此"目录说有 / 授权说没有"这类分歧会在这里就被照到。
   */
  readonly toolDecision?: { readonly port: ToolDecisionPort; readonly catalog?: string }
  /**
   * WP2：**程序给出的已知目录事实**（**已渲染**；缺省 ⇒ 决策器与规划器都看不到它们）。
   *
   * ⚠️ 生产里这一份由 `readKnownDesktopDirectories` 探测产出，
   *    床里由用例注入（离线可复现；真实探测在另一条只读门上）。
   */
  readonly knownDirectories?: readonly string[]
  /** WP2：给规划器的**内容额度**（token；缺省 0 ⇒ 重新规划不带实际内容） */
  readonly plannerContentTokens?: number
  /**
   * WP3：给规划器的**外部证据额度**（token；缺省 0 ⇒ 规划器看不到搜索命中）。
   *
   * ⚠️ 与 `plannerContentTokens` 独立：一条是"读到的正文"，一条是"搜索命中的来源行"。
   */
  readonly plannerEvidenceTokens?: number
  /**
   * WP3：`web.read` 的**测试缝**（整段"获取"可替换；准入 / 上限 / 正文提取仍在适配器里）。
   * 缺省不注入 ⇒ 走真实出站（离线门**必须**注入，否则会真的联网）。
   */
  readonly webRead?: Pick<WebReadAdapterOptions, 'fetchHtml'>
  /** WP3：image.ocr 的注入点（缺省 = 真实后端；后端不在时如实失败） */
  readonly ocrOptions?: Omit<ImageOcrAdapterOptions, 'root'>
}

export interface ProductivityReading {
  readonly text: string
  readonly rawReplyText: string
  readonly replyText: string
  readonly turn: IncomingTurn
  readonly packet: ContextPacket
  readonly trace: CharacterRunTrace
  readonly actionResults: readonly ActionTurnResult[]
  readonly turnContent: readonly TurnContent[]
  readonly turnContentInContext?: TurnContentContextReality
  readonly guard: ReplyGuardChainOutcome
  readonly sectionIds: readonly string[]
  readonly sectionOf: (id: string) => string
  readonly stepKinds: readonly string[]
}

export interface ProductivityBed {
  readonly harness: M4Harness
  readonly label: string
  readonly sandboxRoot: string
  readonly recoveryRoot: string
  readonly ledger: ExecutionLedgerPort
  readonly sharedStaging: PayloadStagingPort
  readonly gatewayOf: (options: ProductivityTurnOptions) => ActionGateway
  readonly turnGatewayOf: (options: ProductivityTurnOptions) => TurnGateway
  readonly say: (input: {
    options: ProductivityTurnOptions
    text: string
    replyText: string
    conversationKey?: string
    /** WP1：决策阶段的**有界上下文**（不传 ⇒ 决策只看原话与目录） */
    decisionLines?: readonly string[]
  }) => Promise<ProductivityReading>
  readonly actionRows: () => Promise<readonly ExecutionRecordView[]>
  readonly tableTexts: (tables: readonly string[]) => Promise<Record<string, string>>
  readonly dispose: () => Promise<void>
}

export const LOCAL_FILE_SCOPE_WORDING: ActionPolicyScopeWording = {
  inScope: '在已授权的本机文件域内（**不是**沙箱：这是本机真实路径）',
  outOfScope: '目标在本机文件域之外（网络共享 / 设备路径 / 备用数据流）：未触碰真实文件系统',
  outOfScopeMessage: '这个目标不在我能碰的本机文件域里，拒绝执行',
}

/** 什么都不做的规划器（默认注入点：任务环**一步都不执行**，用于"未授权/未启用"的负控） */
export function idlePlanner(): TaskPlannerPort {
  return {
    id: 'fixture-idle',
    endpointHost: 'fixture.local',
    async plan() {
      return { ok: true, plan: { goal: '（无计划）', steps: [], done: true }, requestCount: 0 }
    },
  }
}

/**
 * 按**脚本**出计划的规划器（离线确定性：不调模型）。
 *
 * ⚠️ 它**不是**一个"假模型"：它产出的就是 `TaskPlannerPort` 的返回形状，
 *    而且要过 `runTask` 里那条与生产完全相同的校验路径 —— 因此它测的
 *    仍然是"计划被执行环怎么处理"，而不是"模型会不会出好计划"。
 */
export function scriptedPlanner(
  scripts: readonly { goal: string; steps: readonly { capability: string; operation: string; args: Record<string, unknown>; purpose?: string }[]; done: boolean }[],
  options: { id?: string } = {}
): TaskPlannerPort {
  let index = 0
  return {
    id: options.id ?? 'fixture-scripted',
    endpointHost: 'fixture.local',
    async plan() {
      const script = scripts[Math.min(index, scripts.length - 1)]
      index += 1
      if (script === undefined) {
        return { ok: true, plan: { goal: '（没有更多计划）', steps: [], done: true }, requestCount: 0 }
      }
      return { ok: true, plan: script, requestCount: 0 }
    },
  }
}

/** 会失败的规划器（用于"规划失败 ⇒ 如实停止且保留已做过的事"） */
export function failingPlanner(code = 'timeout'): TaskPlannerPort {
  return {
    id: 'fixture-failing',
    endpointHost: 'fixture.local',
    async plan() {
      return { ok: false, failure: code as 'timeout', requestCount: 1 }
    },
  }
}

export function createProductivityBed(options: {
  harness: M4Harness
  label: string
  sandboxRoot: string
  recoveryRoot: string
}): ProductivityBed {
  const { harness: h } = options
  const sandboxOptions = { root: options.sandboxRoot }
  const searchProvider = createFixtureSearchProvider({ id: 'fixture-offline' })

  const registry: CapabilityRegistry = createCapabilityRegistry([
    ...createDefaultCapabilityDefinitions(),
    ...createLearningCapabilityDefinitions(),
    ...createExternalEvidenceCapabilityDefinitions(),
    ...createUtilityCapabilityDefinitions(),
    ...createLocalFileCapabilityDefinitions(),
    ...createWeatherCapabilityDefinitions(),
    ...createOfficeCapabilityDefinitions(),
    ...createNewsCapabilityDefinitions(),
    ...createBrowserCapabilityDefinitions(),
    /* ADR-106：桌面两件也恒登记（开关关着时得到可审计的 permission_denied） */
    ...createDesktopCapabilityDefinitions(),
  ])
  const ledger = createActionLedgerStore(h.kernel.stores.db)
  const sharedStaging = createInMemoryPayloadStaging()

  const buildRuntime = (
    turnOptions: ProductivityTurnOptions
  ): { gateway: ActionGateway; actionPort: ReturnType<typeof createActionTurnPort> } => {
    const switches = turnOptions.switches
    const grantPermissions = turnOptions.grantPermissions !== false
    /*
     * ⚠️ **与生产同形**：写入/办公适配器与任务环必须拿到**同一个**暂存实例。
     *    第一版验收床给两处传了同一个值（恰好掩盖了生产的"两个实例"缺陷，
     *    见 `main.ts` 里那条注释）—— 现在这里是**显式**的一句话，
     *    谁改动它都会被这一段旁边的断言（`office-*` 的 `spec_not_staged`）照到。
     */
    const staging = turnOptions.staging ?? sharedStaging

    /*
     * 文档 / OCR 的跨域入口：与 `main.ts` 同一条（只在全盘读打开时存在）。
     */
    const localFileResolver =
      switches.localFileRead === true || switches.document === true || switches.ocr === true
        ? async (
            rawPath: string
          ): Promise<{ absolutePath: string; resourceRef: string; sourceKind: TurnContentSourceKind }> => {
            const { absolutePath } = await resolveLocalAbsolutePath(rawPath)
            return { absolutePath, resourceRef: absolutePath, sourceKind: 'local-disk' }
          }
        : undefined

    const localAdapters = [
      ...(switches.localFileRead === true ? [createLocalListAdapter(), createLocalReadAdapter()] : []),
      ...(switches.localFileWrite === true
        ? [createLocalWriteAdapter({ recoveryRoot: options.recoveryRoot, staging })]
        : []),
    ]
    const localPermissions = grantPermissions
      ? [
          ...(switches.localFileRead === true
            ? [LOCAL_FILE_LIST_PERMISSION, LOCAL_FILE_READ_PERMISSION]
            : []),
          ...(switches.localFileWrite === true ? [LOCAL_FILE_WRITE_PERMISSION] : []),
        ]
      : []

    const weatherAdapter =
      switches.weather === true
        ? createWeatherAdapter(
            turnOptions.weatherFetch !== undefined ? { fetchImpl: turnOptions.weatherFetch } : {}
          )
        : undefined
    const newsAdapter =
      switches.news === true
        ? createNewsReadAdapter({
            ...(turnOptions.news?.fetcher !== undefined ? { fetcher: turnOptions.news.fetcher } : {}),
            ...(turnOptions.news?.parse !== undefined ? { parse: turnOptions.news.parse } : {}),
          })
        : undefined
    /*
     * WP3：`image.ocr` 的适配器（与 `main.ts` 同形）。
     *
     * ⚠️ 后端（rapidocr venv + 三个 ONNX 模型）**本机没有** ⇒ 这一档能给出的读数就是
     *    "**后端不在时如实失败**"（不谎报识别结果）。"真的识别成功"那一档见 NOT RUN 登记。
     */
    const ocrAdapter =
      switches.ocr === true
        ? createImageOcrAdapter({
            backend: configuredOcrBackend(),
            ...sandboxOptions,
            ...(localFileResolver !== undefined ? { resolveTarget: localFileResolver } : {}),
            ...(turnOptions.ocrOptions !== undefined ? { ...turnOptions.ocrOptions } : {}),
          })
        : undefined
    /*
     * WP3：`document.read` 的**适配器**（第一版床里也没有它 —— 于是 A12 的读回那一半
     * 得到 `unsupported：能力 document.read 已登记但没有适配器`。
     * 又一次"床与生产不同形"；生产在 `main.ts` 里是构造的。）
     * ⚠️ 跨域入口只在文档/图片/本机读**任一**开关打开时注入（用户 2026-10-05 裁定）。
     */
    const documentAdapter =
      switches.document === true
        ? createDocumentReadAdapter({
            ...sandboxOptions,
            ...(localFileResolver !== undefined ? { resolveTarget: localFileResolver } : {}),
          })
        : undefined
    /*
     * WP3：`web.search` 的**适配器**（第一版床里根本没有它 —— 只建了 fixture provider 用来
     * 做目标解析，于是 role 档下"搜索"这一步被如实拒成
     * `unsupported：能力 web.search 已登记但没有适配器`。又一次"床与生产不同形"。）
     */
    const webSearchAdapter =
      turnOptions.search === true
        ? createWebSearchAdapter({
            provider: searchProvider,
            fingerprint: createSha256Fingerprinter(),
          })
        : undefined
    /*
     * WP3：`web.read`（离线门**必须**注入测试缝，否则它真的会联网）。
     * ⚠️ 与其它能力同一条纪律：开关关着 ⇒ **不构造适配器**（构造上没有出站路径）。
     */
    const webReadAdapter =
      switches.webRead === true
        ? createWebReadAdapter(
            turnOptions.webRead !== undefined ? { ...turnOptions.webRead } : {}
          )
        : undefined
    const officeEnabled = switches.office === true && switches.localFileWrite === true
    const officeAdapter = officeEnabled
      ? createOfficeGenerateAdapter({
          recoveryRoot: options.recoveryRoot,
          staging,
          ...(turnOptions.office?.pythonPath !== undefined ? { pythonPath: turnOptions.office.pythonPath } : {}),
          ...(turnOptions.office?.generatorPath !== undefined
            ? { generatorPath: turnOptions.office.generatorPath }
            : {}),
          ...(turnOptions.office?.timeoutMs !== undefined ? { timeoutMs: turnOptions.office.timeoutMs } : {}),
        })
      : undefined
    const browserAdapters =
      switches.browser === true && turnOptions.browser !== undefined
        ? createBrowserAdapters(turnOptions.browser)
        : []

    /*
     * WP1 / ADR-104：**权限清单与能力清单各算一次**，网关、任务环与工具目录共用。
     * ⚠️ 与生产（`main.ts`）同形的理由与那条 `staging` 缺陷同源：
     *    床若自己另算一份，它照到的就不是生产那条路。
     * ⚠️ role 档（配了决策端口）**追加旧沙箱三件**，逐字对应 `main.ts` 的
     *    `toolCapabilitiesForTurn()`：计划书 §3 的能力矩阵要求它们进完整工具清单。
     */
    /*
     * ⚠️ 第一批四项的权限**也按开关授予**（与 `main.ts` 的 `utilityPermissions` 逐项对应）。
     *    第一版这里**漏了这一行**，于是床里 `math.calculate` / `document.read` 会以
     *    `permission_denied` 结束 —— 那是**床与生产不同形**（先例：`spec_not_staged'）。
     *    本轮由 WP3 的全工具组合门逮到（"生成 Office 后读回"的第二只脚走不过去）。
     */
    const utilityPermissions = grantPermissions
      ? [
          ...(switches.math === true ? [MATH_CALCULATE_PERMISSION] : []),
          ...(switches.document === true ? [DOCUMENT_READ_PERMISSION] : []),
          ...(switches.webRead === true ? [WEB_READ_PERMISSION] : []),
          ...(switches.ocr === true ? [IMAGE_OCR_PERMISSION] : []),
        ]
      : []
    const omitted = new Set(turnOptions.omitPermissions ?? [])
    const grantedPermissions: readonly string[] = [
      ...DEFAULT_GRANTED_PERMISSIONS,
      ...(turnOptions.search === true ? [WEB_SEARCH_PERMISSION] : []),
      ...(grantPermissions && switches.weather === true ? [WEATHER_QUERY_PERMISSION] : []),
      ...(grantPermissions && switches.news === true ? [NEWS_READ_PERMISSION] : []),
      ...(grantPermissions && officeEnabled ? [OFFICE_GENERATE_PERMISSION] : []),
      ...(grantPermissions && switches.browser === true
        ? [
            BROWSER_READ_PERMISSION,
            BROWSER_OPERATE_PERMISSION,
            /* ADR-125：全工具档的权限**只在它自己开着时**授予（与 main.ts 同形） */
            ...(switches.browserFullTools === true ? [BROWSER_MCP_PERMISSION] : []),
          ]
        : []),
      /* ADR-106：桌面两档**分开**授（只看 ≠ 能动手）—— 与 `main.ts` 同形 */
      ...(grantPermissions && switches.desktopInspect === true ? [DESKTOP_INSPECT_PERMISSION] : []),
      ...(grantPermissions && switches.desktopOperate === true ? [DESKTOP_OPERATE_PERMISSION] : []),
      ...localPermissions,
      ...utilityPermissions,
    ].filter((permission) => !omitted.has(permission))
    const enabledCapabilities: readonly string[] = [
      ...taskCapabilitiesFor(switches, grantPermissions),
      /*
       * ⚠️ WP3 又逮到一处**床与生产不同形**：`web.search` 在 `main.ts` 的
       *    `TASK_CAPABILITY_IDS` 里，而床的 `taskCapabilitiesFor()` **没有它**
       *    （搜索在床里是独立的 `search` 开关）⇒ role 档下"搜索"这一步会被
       *    `task_plan_step_capability_not_authorized` 拒掉（A15 第一次读数就是这么红的）。
       */
      ...(turnOptions.search === true ? [WEB_SEARCH] : []),
      ...(turnOptions.toolDecision === undefined
        ? []
        : [SYSTEM_ECHO, SANDBOX_FILE_READ, SANDBOX_FILE_WRITE]),
    ]
    const toolCatalog =
      turnOptions.toolDecision === undefined
        ? undefined
        : (turnOptions.toolDecision.catalog ??
          renderToolCatalogForModel(
            buildToolCatalog(registry, {
              isCapabilityEnabled: (capability) => enabledCapabilities.includes(capability),
              grantedPermissions,
            })
          ))

    const gateway = createActionGateway({
      registry,
      ledger,
      adapters: [
        createEchoAdapter(),
        createSandboxReadAdapter(sandboxOptions),
        createSandboxWriteAdapter({ ...sandboxOptions, staging }),
        ...localAdapters,
        ...(switches.math === true ? [createMathCalculateAdapter()] : []),
        ...(weatherAdapter !== undefined ? [weatherAdapter] : []),
        ...(officeAdapter !== undefined ? [officeAdapter] : []),
        ...(newsAdapter !== undefined ? [newsAdapter] : []),
        ...(documentAdapter !== undefined ? [documentAdapter] : []),
        ...(ocrAdapter !== undefined ? [ocrAdapter] : []),
        ...(webSearchAdapter !== undefined ? [webSearchAdapter] : []),
        ...(webReadAdapter !== undefined ? [webReadAdapter] : []),
        ...browserAdapters,
        /* ADR-106：桌面适配器由**注入**（缺省一个都不装；离线门与真机解耦） */
        ...(turnOptions.desktopAdapters ?? []),
      ],
      grantedPermissions: grantedPermissions,
      maxRiskLevel: 'R1',
      dryRun: false,
      now: () => Date.now(),
      /*
       * ⚠️ **与生产同形**：受信归因开着（先例 K-27 / WP5）。
       *    于是每一次 `gateway.execute` **必须**带 invocation —— 缺就失败关闭。
       *    验收入口用 `unresolvedInvocation()` 给出"如实未定"的证据。
       */
      attribution: {
        decisionPointAdapterId: 'action-gateway',
        policyAdapterId: 'action-policy',
        executorAdapterId: 'action-adapter',
      },
      scopeWordingFor: (capability) =>
        isDiskWideCapability(capability) ? LOCAL_FILE_SCOPE_WORDING : undefined,
      resolveTarget: async ({ request, operation }) => {
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
        if (isDiskWideCapability(request.capability)) {
          return resolveLocalTarget({
            targetType: 'local_file',
            ...(request.target !== undefined ? { declared: request.target } : {}),
            ...(typeof request.arguments.path === 'string' ? { rawPath: request.arguments.path } : {}),
          })
        }
        if (request.capability === WEATHER_QUERY) {
          const city = typeof request.arguments.city === 'string' ? request.arguments.city : ''
          return {
            target: {
              type: 'external_service',
              canonicalId: 'open-meteo',
              displayName: `天气服务（open-meteo，城市：${city === '' ? '(未给出)' : city}）`,
              confidence: city === '' ? 'none' : 'exact',
            },
            scopeViolation: false,
          }
        }
        if (request.capability === NEWS_READ) {
          const feeds = Array.isArray(request.arguments.feeds) ? request.arguments.feeds : []
          return {
            target: {
              type: 'external_service',
              canonicalId: 'rss-atom',
              displayName: `订阅源（${String(feeds.length)} 个）`,
              confidence: feeds.length === 0 ? 'none' : 'exact',
            },
            scopeViolation: false,
          }
        }
        if (request.capability === OFFICE_GENERATE) {
          const path = typeof request.arguments.path === 'string' ? request.arguments.path : ''
          return resolveLocalTarget({ targetType: 'local_file', rawPath: path })
        }
        if (isBrowserCapability(request.capability)) {
          const url = turnOptions.browser?.sidecarUrl ?? 'http://127.0.0.1:8931/mcp'
          return {
            target: {
              type: 'browser_session',
              canonicalId: url,
              displayName: `浏览器 sidecar（${url}）`,
              confidence: 'exact',
            },
            scopeViolation: false,
          }
        }
        /*
         * ADR-106：桌面能力的目标是**这台机器的当前桌面**（代码常量）——
         * ⚠️ 床里**必须**与 `main.ts` 逐字同形：少了这一支，桌面能力会掉进
         *    下面的沙箱文件解析 ⇒ `target_not_found`（A18 第一版读数就是这样红的，
         *    看起来像"能力不工作"，其实是床没接目标）。
         */
        if (isDesktopCapability(request.capability)) {
          return {
            target: {
              type: 'local_executor',
              canonicalId: 'windows-desktop',
              displayName: '当前用户桌面（UI Automation 读取；共用用户的鼠标与键盘）',
              confidence: 'exact',
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

    /*
     * 任务环的接线（与 `main.ts` 同形；规划器按测试注入）。
     */
    const taskPort: NonNullable<Parameters<typeof createActionTurnPort>[0]['task']> | undefined =
      switches.taskAutonomy === true
        ? {
            authorizations: createTaskAuthorizationRegistry({
              budget: {
                maxActions: turnOptions.taskMaxActions ?? 30,
                maxPlans: turnOptions.taskMaxPlans ?? 6,
                deadlineMs: 10 * 60 * 1000,
              },
            }),
            planner: turnOptions.planner ?? idlePlanner(),
            staging,
            capabilitiesFor: (): readonly string[] => enabledCapabilities,
            riskLevelFor: (): RiskLevel => turnOptions.taskRiskLevel ?? 'R1',
            resolveTarget: (input) => gateway.resolveTargetFor(input),
            /*
             * WP2 / ADR-104 `D14`：**重新规划**时的程序事实与内容额度。
             * ⚠️ 只在 role 档（配了决策端口）接线 —— `rules` 档的规划器输入逐字不变。
             * ⚠️ 内容额度缺省 **0**（= 不带内容），与生产"接线就位、激活另裁"同一条纪律。
             */
            ...(turnOptions.toolDecision !== undefined
              ? {
                  replanContext: {
                    knownDirectories: (): readonly string[] => turnOptions.knownDirectories ?? [],
                    contentTokens: turnOptions.plannerContentTokens ?? 0,
                    /* WP3：外部证据的独立额度（缺省 0 ⇒ 规划器看不到搜索命中） */
                    evidenceTokens: turnOptions.plannerEvidenceTokens ?? 0,
                  },
                }
              : {}),
          }
        : undefined

    const actionPort = createActionTurnPort({
      gateway,
      detector: chainIntentDetectors([
        /*
         * 与 `main.ts` **逐字同序**（理由见那里）：具体压过泛化 ——
         *   本机文件域（显式绝对路径）→ 天气/资讯（显式词 + 显式来源）
         *   → M4.5（沙箱相对路径）→ 第一批四项 → M5.5 搜索（本床不接搜索）
         */
        createLocalFileIntentDetector(),
        createWeatherIntentDetector({
          weather: switches.weather === true,
          news: switches.news === true,
        }),
        createActionIntentDetector(),
        createUtilityIntentDetector({
          math: switches.math === true,
          document: switches.document === true,
          web: switches.webRead === true,
          ocr: switches.ocr === true,
        }),
      ]),
      registry,
      attribution: { adapterId: 'action-turn' },
      ...(taskPort !== undefined ? { task: taskPort } : {}),
      /* WP1：配了决策端口 ⇒ `action-turn` 走 role 路径（关键词整段不参战） */
      ...(turnOptions.toolDecision !== undefined && toolCatalog !== undefined
        ? { toolDecision: { port: turnOptions.toolDecision.port, catalog: toolCatalog } }
        : {}),
    })
    return { gateway, actionPort }
  }

  const turnGatewayOf = (turnOptions: ProductivityTurnOptions): TurnGateway => {
    const switches = turnOptions.switches
    const { actionPort } = buildRuntime(turnOptions)
    const budget: ContextBudget = {
      ...DEFAULT_CONTEXT_BUDGET,
      turnContentTokens: turnOptions.turnContentTokens ?? 2000,
      externalEvidenceTokens: turnOptions.search === true ? 800 : 0,
    }
    void switches
    return new TurnGateway({
      kernel: h.kernel,
      definition: h.kernel.definition,
      identity: h.kernel.identitySnapshot,
      recorder: h.recorder,
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

  const say: ProductivityBed['say'] = async (input) => {
    const gateway = turnGatewayOf(input.options)
    /*
     * ⚠️ **必须走 `beginTurn`**：动作段在那里面（含任务执行环）。
     *    手搓一个 `IncomingTurn` 等于把"能力真的被调用过"整个跳过。
     * ⚠️ 会话键由 `turn-gateway` 自己从 `recorder.conversationId` 取 ——
     *    同一张床里的多轮因此共享同一个会话（这正是"任务绑定当前会话"的语义）。
     * ⚠️ **混合树交接的窄化桥**（见 `docs/post-lv2/Role-Tool-Decision-WP1-Record.md` §1.2）：
     *    `beginTurn` 的两参形态（决策阶段的有界上下文）住在 `turn-gateway.ts` 里，
     *    而那个文件与另一个会话的在途改动**还没入库**。已入库的床因此对
     *    "一参 / 两参"两种签名都必须能编译 ⇒ 这里显式窄化一次。
     *    ⚠️ 它**不会**静默降级：参数被忽略时，本仓库那条判据
     *    "决策输入：最近对话行原样送到"会**响亮地**失败（不是悄悄少一次上下文）。
     */
    const beginTurn = (context?: { decisionLines: readonly string[] }): Promise<IncomingTurn> =>
      context === undefined
        ? gateway.beginTurn(input.text)
        : /*
           * ⚠️ `this` 必须**绑回网关**（`.call`）：`beginTurn` 是类方法，
           *    把它摘下来单独调用会让 `this.options` 变成 undefined
           *    —— 门里第一次跑就撞到了这个（"Cannot read properties of undefined"）。
           */
          (
            gateway.beginTurn as (
              text: string,
              ctx: { decisionLines: readonly string[] }
            ) => Promise<IncomingTurn>
          ).call(gateway, input.text, context)
    const turn = await beginTurn(
      input.decisionLines === undefined ? undefined : { decisionLines: input.decisionLines }
    )
    const packet = await gateway.compileTurn({ turn, currentInput: input.text, recentLines: [] })
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
    }
  }

  return {
    harness: h,
    label: options.label,
    sandboxRoot: options.sandboxRoot,
    recoveryRoot: options.recoveryRoot,
    ledger,
    sharedStaging,
    gatewayOf: (turnOptions) => buildRuntime(turnOptions).gateway,
    turnGatewayOf,
    say,
    async actionRows() {
      return await ledger.listRecords({ characterId: h.kernel.characterId, limit: 200 })
    },
    async tableTexts(tables) {
      const out: Record<string, string> = {}
      for (const table of tables) {
        try {
          const rows = rowsOf(await h.kernel.stores.db.execute(sql.raw(`select * from "${table}"`)))
          out[table] = JSON.stringify(rows)
        } catch (error) {
          /*
           * ⚠️ 表不存在**不是**"扫过了、没命中"：如实记成一条**扫不到**的读数
           *    （否则 0 命中会被读成"隐私没问题"）。
           */
          out[table] = `(表不存在或读不到：${error instanceof Error ? error.message.slice(0, 80) : String(error)})`
        }
      }
      return out
    },
    async dispose() {
      await h.stop()
    },
  }
}

/** 任务环允许的能力（与 `main.ts` 的 `isTaskCapabilityEnabled` 逐字同源） */export function taskCapabilitiesFor(
  switches: ProductivitySwitches,
  grantPermissions: boolean
): readonly string[] {
  if (!grantPermissions) return []
  const out: string[] = []
  if (switches.localFileRead === true) out.push(LOCAL_FILE_LIST, LOCAL_FILE_READ)
  if (switches.localFileWrite === true) out.push(LOCAL_FILE_WRITE)
  if (switches.document === true) out.push(DOCUMENT_READ)
  if (switches.ocr === true) out.push(IMAGE_OCR)
  if (switches.math === true) out.push(MATH_CALCULATE)
  if (switches.webRead === true) out.push(WEB_READ)
  if (switches.weather === true) out.push(WEATHER_QUERY)
  if (switches.office === true && switches.localFileWrite === true) out.push(OFFICE_GENERATE)
  if (switches.news === true) out.push(NEWS_READ)
  if (switches.browser === true) out.push(BROWSER_READ, BROWSER_OPERATE)
  /* ADR-125：全工具档 —— 与 main.ts 的 `BROWSER_MCP` 支同形（两条都要成立） */
  if (switches.browser === true && switches.browserFullTools === true) out.push(BROWSER_MCP)
  if (switches.desktopInspect === true) out.push(DESKTOP_INSPECT)
  if (switches.desktopOperate === true) out.push(DESKTOP_OPERATE)
  return out
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * "如实未定"的 invocation（验收里直接调 gateway 时用）。
 *
 * ⚠️ 它**不是**在伪造归因：`attestActionInitiatorUnresolved()` 的语义就是
 *    "这个 ingress 没有因果上下文" —— 而那正是"从验收脚本直接发一个请求"的真实情况。
 */
export function unresolvedInvocation(): ActionInvocationContext {
  return { initiatorEvidence: attestActionInitiatorUnresolved({ adapterId: 'productivity-verify' }) }
}

export function firstResult(reading: ProductivityReading): ActionResult | undefined {
  for (const item of reading.actionResults) if (item.result !== undefined) return item.result
  return undefined
}

export function resultOf(reading: ProductivityReading, capability: string): ActionResult | undefined {
  for (const item of reading.actionResults) {
    if (item.result !== undefined && String(item.result.capability) === capability) return item.result
  }
  return undefined
}

export function contentOf(
  reading: ProductivityReading,
  capability: string
): TurnContent | undefined {
  return reading.turnContent.find((item) => item.capability === capability)
}

export function summarizeActions(
  reading: ProductivityReading
): readonly {
  capability: string
  status: string
  accepted: boolean
  executed: boolean
  failureCode?: string
  rule?: string
}[] {
  return reading.actionResults.map((item) => ({
    capability: String(item.result?.capability ?? '(无结果)'),
    status: String(item.result?.status ?? '(未执行)'),
    accepted: item.result?.accepted === true,
    executed: item.result?.executed === true,
    ...(item.result?.error?.code !== undefined ? { failureCode: item.result.error.code } : {}),
    ...(item.rule !== undefined ? { rule: item.rule } : {}),
  }))
}
