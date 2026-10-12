/**
 * M5.5 —— 共用的**验收装配**（`pnpm m5.5:verify` / `pnpm m5.5:e2e:verify` 都用它）。
 *
 * ============================================================================
 *  它为什么存在：门必须走**真实链路**，而不是"部件单独工作"
 * ============================================================================
 * M4 的 D1 穿过了 939 项断言，原因只有一个：那些断言几乎都**直接给 id**，
 * 绕过了"从自然语言解析目标"这一层。M5.5 有一个等价的风险面：
 *
 *     直接调 adapter.execute() → 断言证据形状 → 宣称"搜索链路通了"
 *
 * 那会证明适配器工作正常，却完全测不到
 *
 *     用户原话 → 意图判定 → 目标解析 → 策略 → 适配器 → 证据 → 上下文 → 回复
 *
 * 因此这份装配**照抄 main.ts 的搜索接线**（ADR-045 `D-11`/`D-12` 的两处消费：
 * 授予 `web:search` + 构造适配器），只把 provider 换成**离线 fixture**：
 * 门必须离线、必须可重复、**绝不真的出站**。
 *
 * ---------------------------------------------------------------------------
 *  三条纪律
 * ---------------------------------------------------------------------------
 * 1. **调用方先隔离库**（AGENTS §7）：本模块**不**调 `isolateDatabase`，
 *    由脚本在 `import` 之后、碰库之前自己调（与 `verify-m5-runtime.ts` 同形）。
 * 2. **同一进程只有一个库**：换库前必须 `resetPluginSqlConnection()`。
 * 3. **两个 action 装配 = 两个 flag 值**：`actionOff`（无授权、**无适配器**）
 *    与 `actionOn`（有授权、有适配器）。ADR-045 `D-12` 说的两件事少一件都不算打开，
 *    因此它们是两份**真实**的装配，而不是同一个装配读一个布尔值。
 * 4. **一个隔离库配一个 harness**：`nextTurnSequence` 是 **harness 局部**计数器
 *    （一轮前进 2，与 `completeTurn` 的"助手占 +1"配对）。两个 harness 共用一个库
 *    会让第二份从 1 重新数 ⇒ `会话内序号出现空洞`。而且**每一轮都必须走完**
 *    （`beginTurn` 开了序号却不 `completeTurn` 同样留空洞）。
 *    因此本模块**不**提供"只编译"的入口 —— 那种写法只在 `dryRun: true` 的网关上是安全的。
 */

import { sql } from 'drizzle-orm'

import { cleanupSandbox } from '../src/dev/sandbox.ts'

import {
  createM4Harness,
  countsOf,
  snapshotOf,
  type CanonicalSnapshot,
  type Counts,
  type M4Harness,
} from './m4-harness.ts'
import { rowsOf } from '../src/infrastructure/persistence/db.ts'
import {
  createFixtureSearchProvider,
  type FixtureSearchProvider,
} from '../src/infrastructure/search/fixture-search-provider.ts'
import { createSha256Fingerprinter } from '../src/infrastructure/search/fingerprint.ts'
import { createWebSearchAdapter } from '../src/infrastructure/action/adapters/web-search.ts'
import { createEchoAdapter } from '../src/infrastructure/action/adapters/echo.ts'
import {
  createSandboxReadAdapter,
  createSandboxWriteAdapter,
  listSandboxEntries,
} from '../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import { createActionLedgerStore } from '../src/infrastructure/action/action-ledger-store.ts'
import { DEFAULT_GRANTED_PERMISSIONS, createCapabilityRegistry, createDefaultCapabilityDefinitions } from '../src/kernel/action/capability-registry.ts'
import {
  WEB_SEARCH,
  WEB_SEARCH_PERMISSION,
  createExternalEvidenceCapabilityDefinitions,
} from '../src/kernel/action/external-evidence-capability.ts'
import { createActionGateway, type ActionGateway } from '../src/kernel/action/gateway.ts'
import { createActionTurnPort, type ActionTurnPort } from '../src/kernel/action/action-turn.ts'
import { createActionIntentDetector } from '../src/kernel/action/intent-detector.ts'
import {
  chainIntentDetectors,
  createExternalEvidenceIntentDetector,
} from '../src/kernel/action/external-evidence-intent.ts'
import { resolveActionTarget } from '../src/kernel/action/target-resolver.ts'
import { hasSideEffect } from '../src/kernel/action/action-request.ts'
import { searchFactOf } from '../src/kernel/action/external-evidence-reply.ts'
import { newTraceId } from '../src/kernel/contracts/ids.ts'
import { DEFAULT_CONTEXT_BUDGET, type ContextBudget } from '../src/kernel/recall/selector.ts'
import { TurnGateway, type IncomingTurn } from '../src/kernel/app/turn-gateway.ts'
import type { CharacterRunTrace } from '../src/kernel/contracts/trace.ts'
import type { ContextPacket } from '../src/kernel/contracts/context.ts'
import type { ExternalEvidence } from '../src/kernel/contracts/external-evidence.ts'
import type { ExternalEvidenceTurnReality } from '../src/kernel/contracts/external-evidence.ts'
import type { ExecutionRecordView, ExecutionLedgerPort } from '../src/kernel/action/execution-ledger.ts'
import type { RecallTurnPort } from '../src/kernel/app/recall/turn.ts'
import type { RetrievalPolicyVersion, SemanticMode } from '../src/kernel/contracts/recall.ts'
import type { RollupTurnPort } from '../src/kernel/app/rollup/turn.ts'

/** 一次"真实的轮次"跑完之后，门需要读到的全部东西 */
export interface M55Turn {
  text: string
  replyText: string
  /** 这一轮的 `IncomingTurn`（**唯一**插入点上的那些字段都在这上面） */
  turn: IncomingTurn
  packet: ContextPacket
  trace: CharacterRunTrace
  /** 这一轮**动作结果里**的外部证据（内存载体，**含摘要正文**） */
  externalEvidence: readonly ExternalEvidence[]
  /** 这一轮"搜索那一次"的终态（没有搜索动作时为 undefined） */
  search: ReturnType<typeof searchFactOf>
  /** WP5 写下的"实际入模"现实（没有尝试过搜索时为 undefined） */
  inContext?: ExternalEvidenceTurnReality
}

export interface M55HarnessOptions {
  label: string
  /** 搜索结果由谁给（缺省：两条合成 HTTPS 结果）。**离线**，绝不出站 */
  provider?: FixtureSearchProvider
  /** 证据额度（仅 `actionOn` 那一份装配使用；缺省 800） */
  evidenceTokens?: number
  /** 召回端口（不传 = 不接召回，与 M5 的既有纪律一致） */
  recall?: RecallTurnPort
  recallEnabled?: boolean
  sandboxRoot?: string
  /**
   * M6 / WP6a：**会话摘要端口**（不传 = 不接摘要）。
   *
   * ⚠️ 这是**追加**的一个可选端口，不是生产绕过参数：它与 `recall` 一样是
   * `TurnGatewayOptions` 上本来就有的注入点，只是 harness 之前没有把它透出来。
   * 不传时 `rollupTokens` 仍是 `DEFAULT_CONTEXT_BUDGET` 的 **0** ⇒ 所有既有
   * 调用方的行为逐字节不变。
   */
  rollup?: RollupTurnPort
  /**
   * M6.1 WP5：**干跑装配**（网关 + 记录器**都**干跑）。
   *
   * 生产里 `main.ts --test` 两个都设；只设网关那个，
   * `conversation_events` 仍会被记录器写进去（WP5 的 P5 判据实测到了这一点）。
   */
  dryRun?: boolean
}

export interface M55Harness {
  h: M4Harness
  provider: FixtureSearchProvider
  ledger: ExecutionLedgerPort
  /** flag **off** 的装配：无 `web:search` 授权、**没有**搜索适配器 */
  actionOff: ActionTurnPort
  /** flag **on** 的装配：有授权、有适配器（指向 fixture provider） */
  actionOn: ActionTurnPort
  actionGateway: ActionGateway
  /** 造一个 TurnGateway。`search` 选哪一份 action 装配，决定这一轮"联网开没开" */
  gatewayOf(options?: {
    search?: 'off' | 'on'
    actionEnabled?: boolean
    evidenceTokens?: number
    recall?: RecallTurnPort
    recallEnabled?: boolean
    /**
     * **M9.5 / WP6（D25）**：检索策略版本（**追加项**；不传 ⇒ 请求不带该字段 ⇒ 行为不变）。
     * M9.5 的 `e2e` 门需要它来在**真网关**上对照"旧路径 / 混合排序"。
     */
    recallPolicyVersion?: RetrievalPolicyVersion
    /** **M9.5 / WP8**：语义模式（追加项；不传 ⇒ 由策略版本推导） */
    recallSemanticMode?: SemanticMode
    /** M6 / WP6a：摘要端口（不传 = 这一轮不接摘要） */
    rollup?: RollupTurnPort
    /** M6：摘要额度（缺省：接了端口就是 400，没接就是 0） */
    rollupTokens?: number
    /** M6：**编译器总预算**（用于注入"摘要被裁掉"那一类故障） */
    tokenBudget?: number
    /**
     * M6.1 WP5：**干跑**（`--test` 的网关层形态）。
     *
     * ⚠️ 追加项，缺省 `false` ⇒ 既有调用方的行为**逐字节不变**。
     * 需要它是因为 WP5 的 P5 判据是"干跑一轮、九张表零变化"，
     * 而那件事在**网关**这一层发生（`dryRun` 时 trace / 事件 / 动作整段跳过）。
     */
    dryRun?: boolean
  }): TurnGateway
  /**
   * 从**用户真实原话**进入：真实轮次（`beginTurn` + `compileTurn` + `completeTurn`），不是合成轮次。
   *
   * `clockEpochMs`（M6 / WP7b，**可选、追加**）：这一轮"她以为现在是几点"。
   * 不传 = 不注入时钟 section ⇒ 既有调用方的 packet 逐字节不变
   * （与 `TurnGateway` 的 `clockEpochMs` 同一条纪律：领域层不读时钟）。
   */
  say(input: {
    gateway: TurnGateway
    text: string
    replyText: string
    clockEpochMs?: number
  }): Promise<M55Turn>
  counts(): Promise<Counts>
  snapshot(): Promise<CanonicalSnapshot>
  actionRows(): Promise<readonly ExecutionRecordView[]>
  /** 一张表的**内容摘要**（顺序无关；用于"这件事到底动没动那张表"） */
  tableDigest(table: string): Promise<string>
  dispose(): Promise<void>
}

export async function createM55Harness(options: M55HarnessOptions): Promise<M55Harness> {
  /*
   * ⚠️ 标签会进 `conversationId`，而 ID 只允许字母数字与 `_ - :`（长度 1..120）。
   *    `m5.5-runtime` 里的那个点会让 `asConversationId` 直接抛 —— 真实踩过。
   *    这里统一把非法字符换成 `-`，调用方仍然可以写可读的标签。
   */
  const h = await createM4Harness({
    label: options.label.replace(/[^A-Za-z0-9_-]/g, '-'),
    ...(options.dryRun === true ? { recorderDryRun: true } : {}),
  })
  const provider = options.provider ?? createFixtureSearchProvider({ id: 'fixture-offline' })
  const evidenceTokens = options.evidenceTokens ?? 800
  const sandboxRoot = options.sandboxRoot ?? `${process.cwd()}/data/action-sandbox-m55-${options.label}`
  const sandboxOptions = { root: sandboxRoot }

  /*
   * 登记表**只建一次**，同时交给端口与 Gateway（ADR-031：能力存在只有一个来源）。
   * 与 main.ts 逐字同形：默认三能力 + **追加**外部证据能力（D-11）。
   */
  const registry = createCapabilityRegistry([
    ...createDefaultCapabilityDefinitions(),
    ...createExternalEvidenceCapabilityDefinitions(),
  ])
  const ledger = createActionLedgerStore(h.kernel.stores.db)

  const resolveTarget: NonNullable<Parameters<typeof createActionGateway>[0]['resolveTarget']> = async ({
    request,
    operation,
  }) => {
    if (request.capability === WEB_SEARCH) {
      return {
        target: {
          type: 'external_service',
          canonicalId: provider.id,
          displayName: `离线 fixture 搜索服务（${provider.endpointHost}）`,
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
  }

  const gatewayWith = (searchEnabled: boolean): ActionGateway =>
    createActionGateway({
      registry,
      ledger,
      adapters: [
        createEchoAdapter(),
        createSandboxReadAdapter(sandboxOptions),
        createSandboxWriteAdapter(sandboxOptions),
        /*
         * ⚠️ 这一行就是 `D-12` 的第 ② 件事：flag off 时**构造上**没有出站能力
         *    （不是"有适配器但被拦住"）。
         */
        ...(searchEnabled
          ? [
              createWebSearchAdapter({
                provider,
                fingerprint: createSha256Fingerprinter(),
              }),
            ]
          : []),
      ],
      /* `D-12` 的第 ① 件事：flag off 时没有 `web:search` ⇒ 策略第 ③ 步拒绝 */
      grantedPermissions: searchEnabled
        ? [...DEFAULT_GRANTED_PERMISSIONS, WEB_SEARCH_PERMISSION]
        : DEFAULT_GRANTED_PERMISSIONS,
      maxRiskLevel: 'R1',
      /*
       * ⚠️ `dryRun: false` 是**必须**的：干跑时动作段整段跳过（turn-gateway 的
       *    三条刻意行为之一），于是"搜索真的发生过"这件事在干跑里根本不存在。
       *    本装配跑在**隔离库**上，写入是安全的。
       */
      dryRun: false,
      now: () => Date.now(),
      resolveTarget,
    })

  const turnPortOf = (searchEnabled: boolean): ActionTurnPort =>
    createActionTurnPort({
      gateway: gatewayWith(searchEnabled),
      detector: chainIntentDetectors([
        createActionIntentDetector(),
        createExternalEvidenceIntentDetector(),
      ]),
      registry,
    })

  const actionOff = turnPortOf(false)
  const actionOn = turnPortOf(true)
  const actionGateway = gatewayWith(true)

  const budgetWith = (tokens: number): ContextBudget => ({
    ...DEFAULT_CONTEXT_BUDGET,
    externalEvidenceTokens: tokens,
  })

  const gatewayOf: M55Harness['gatewayOf'] = (input = {}) => {
    const search = input.search ?? 'on'
    const tokens =
      input.evidenceTokens ?? (search === 'on' ? evidenceTokens : 0)
    /*
     * M6：摘要额度。缺省与既有行为一致 —— **没接端口就是 0**（不做摘要）。
     * 接了端口给 400（够放下几行逐字摘录，与 `DEFAULT_CONTEXT_BUDGET` 的
     * `reservedTokens` 相比很小，因此它永远是"先被裁"的那一段）。
     */
    const rollupTokens = input.rollupTokens ?? (input.rollup === undefined ? 0 : 400)
    return new TurnGateway({
      kernel: h.kernel,
      definition: h.kernel.definition,
      identity: h.kernel.identitySnapshot,
      recorder: h.recorder,
      /*
       * ⚠️ 传**函数本身**，不要包一层 `() => h.nextTurnSequence()`。
       *    `beginTurn` 与 `completeTurn` 各自会调用它，包一层会让序号
       *    双跳 ⇒ `会话内序号出现空洞：当前最大 5，收到 7`（真实踩过）。
       *    与 `verify-m5-e2e.ts` 的写法逐字一致。
       */
      conversationSequence: h.nextTurnSequence,
      recentLimit: 16,
      slowPathEnabled: false,
      dryRun: input.dryRun === true,
      userId: h.userId,
      actionWriter: search === 'on' ? actionOn : actionOff,
      actionEnabled: input.actionEnabled !== false,
      recallBudget: { ...budgetWith(tokens), rollupTokens },
      ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
      ...(input.recall !== undefined ? { recall: input.recall } : {}),
      ...(input.recallEnabled !== undefined ? { recallEnabled: input.recallEnabled } : {}),
      /* M9.5 / WP6·WP8：追加透传（不传 ⇒ 字段不出现 ⇒ 既有调用方逐字节不变） */
      ...(input.recallPolicyVersion !== undefined ? { recallPolicyVersion: input.recallPolicyVersion } : {}),
      ...(input.recallSemanticMode !== undefined ? { recallSemanticMode: input.recallSemanticMode } : {}),
      ...(input.rollup !== undefined ? { rollup: input.rollup } : {}),
    })
  }

  const readTurn = (input: {
    turn: IncomingTurn
    packet: ContextPacket
    trace: CharacterRunTrace
    text: string
    replyText: string
  }): M55Turn => {
    const results = input.turn.actionResults
    const externalEvidence = (results ?? []).flatMap((item) => item.result?.externalEvidence ?? [])
    return {
      text: input.text,
      replyText: input.replyText,
      turn: input.turn,
      packet: input.packet,
      trace: input.trace,
      externalEvidence,
      search: searchFactOf(results),
      ...(input.turn.externalEvidenceInContext !== undefined
        ? { inContext: input.turn.externalEvidenceInContext }
        : {}),
    }
  }

  return {
    h,
    provider,
    ledger,
    actionOff,
    actionOn,
    actionGateway,

    gatewayOf,

    async say(input) {
      /*
       * ⚠️ 必须走 `beginTurn`，**不能**手搓一个 `IncomingTurn`。
       *
       * 真实踩过：手搓的轮次（照 `verify-m5-runtime.ts` 的干跑写法）在
       * `dryRun:false` 下会直接抛 `Trace ... 不存在，无法更新` —— 因为
       * trace 行是 `beginTurn` 开的；而且**动作段也在 `beginTurn` 里**，
       * 手搓轮次等于把"搜索真的发生过"这件事整个跳过。
       */
      const turn = await input.gateway.beginTurn(input.text)
      const packet = await input.gateway.compileTurn({
        turn,
        currentInput: input.text,
        recentLines: [],
        ...(input.clockEpochMs !== undefined ? { clockEpochMs: input.clockEpochMs } : {}),
      })
      const outgoing = await input.gateway.completeTurn({
        turn,
        replyText: input.replyText,
      })
      return readTurn({
        turn,
        packet,
        trace: outgoing.trace,
        text: input.text,
        replyText: input.replyText,
      })
    },

    async counts() {
      return await countsOf(h.kernel.stores.db, h.owner)
    },

    async snapshot() {
      return await snapshotOf(h.store, h.owner)
    },

    async actionRows() {
      return await ledger.listRecords({
        characterId: h.kernel.characterId,
        limit: 50,
      })
    },

    async tableDigest(table) {
      const rows = rowsOf(
        await h.kernel.stores.db.execute(sql.raw(`select * from "${table}"`))
      )
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
      cleanupSandbox(sandboxRoot)
    },
  }
}
