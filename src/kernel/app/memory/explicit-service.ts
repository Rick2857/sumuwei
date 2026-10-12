/**
 * ExplicitMemoryService —— **"记住 / 纠正 / 忘掉"的显式路径**（计划书第 54–59 节）。
 *
 * ============================================================================
 *  这个文件里最重要的一条产品规则（计划书第 55 节）
 * ============================================================================
 * 计划书把它写成一个**失败场景**：
 *
 *     系统不能在 Memory Commit 失败时回答：
 *         "记住了。"
 *     正确行为应该是：
 *         Memory 持久化成功以后，才能确认成功。
 *     如果持久化失败：
 *         应进入 retry / explicit failure，而不是假成功。
 *
 * 因此这个服务的方法**返回值本身**就是那条规则的落地：
 *
 *     { ok: true,  ... }   —— **只有**领域事件已经写入、投影已经折叠之后
 *     { ok: false, ... }   —— 其余一切情况，并且带上"为什么"
 *
 * 调用方（`TurnGateway` 或她的话术层）**只允许**在 `ok === true` 时说"记住了"。
 * 这条不靠自觉：`ExplicitMemoryOutcome` 是判别联合，读 `memoryId`
 * 必须先过 `ok` 检查（TypeScript 会拦住直接读）。
 *
 * ---------------------------------------------------------------------------
 *  与 `MemoryMutationValidator` 的分工
 * ---------------------------------------------------------------------------
 *   · 本服务负责**编排**：检测 → 解析目标 → 抽内容 → 造候选 → 调放行口 → 提交 → 回报
 *   · 放行口负责**放行**：权威、证据、幂等、payload 契约
 *   · `MemoryStorePort.apply` 负责**折叠**：把已落库的事件折进投影
 *
 * 事务边界严格按计划书第 159–160 节：
 *
 *     LLM / 用户文本解析（事务外）
 *     ─────────── transaction ───────────
 *     放行校验 → 领域事件 → 投影
 *     ─────────── commit ────────────────
 *
 * **注意**：内容抽取（可能调模型）发生在**事务之前**，
 * 与 `applyAcceptedEvents` 的调用之间隔着一次 `await` —— 这是刻意的，
 * 见计划书第 160 节"事务中不能调用 LLM"。
 */

import {
  KernelError,
  asMemoryId,
  conversationEvidence,
  createMemoryCandidate,
  type DomainEvent,
  type EntityRef,
  type MemoryCandidate,
  type MemoryId,
  type MemoryRecord,
} from '../../contracts/index.ts'
import { memoryIdOfEvent } from '../../projections/memory.ts'
import {
  createMemoryMutationValidator,
  type MemoryMutationValidator,
  type MemoryValidationOutcome,
} from '../../policies/memory-validator.ts'
import type { ExplicitMemoryIntent } from './intent-detector.ts'
import { mayMutate, type TargetResolution } from './target-resolver.ts'
import {
  RuleBasedContentExtractor,
  type MemoryContentExtractor,
  type ExtractedMemoryContent,
} from './content-extractor.ts'
/*
 * M6.1 WP4 / ADR-055 `D-55b`：显式写入路径要**消费**槽位冲突判定。
 *
 * ⚠️ 这里刻意**复用** `pipeline.ts` 的端口类型与 `conflict.ts` 的同一对纯函数 ——
 *    用户批准的 A 要求"同一实现、不得复制一份"；抄一份逻辑就等于造了第二个判据。
 * ⚠️ `MemoryConflictPort` 只作**类型**导入（`import type`），因此不引入运行时依赖，
 *    也不构成 `explicit-service → pipeline` 的运行时环。
 */
import { analyzeConflict, resolveConflict, slotOfCandidate } from './conflict.ts'
import type { MemoryConflictPort } from './pipeline.ts'
/*
 * M6.1 WP5 / B① / ADR-058：correct 的**目标层兜底**（纯函数在
 * `correction-fallback.ts`；读取端口见下方 `deps.recentExplicitWrites`）。
 */
import {
  extractCorrectionValue,
  slotRestrictedCorrectionValue,
  pickRecentExplicitWriteTarget,
} from './correction-fallback.ts'

// ---------------------------------------------------------------------------
// 依赖端口（**Application 层不认识持久化实现**）
// ---------------------------------------------------------------------------

/**
 * 折叠事件所需的最小能力。
 *
 * ⚠️ 刻意**不** `import { MemoryStorePort } from infrastructure/...`。
 *
 * `applyAcceptedEvents` 所在的 `event-store.ts` 确实 import 了
 * `kernel/policies/validator.ts`，因此同层互引是先例；
 * 但那条边是 **infrastructure → kernel**（仓储需要放行口的类型），
 * 而这里若 import 仓储，方向是 **kernel → infrastructure** ——
 * 那正是 `db.ts` 文件头写明的"依赖方向必须反过来"。
 *
 * 后果不是洁癖问题：一旦 kernel 认识 `MemoryStorePort`，
 * 就必然有人开始在这里直接写 SQL 或 `await db.execute`，
 * 而那时"领域层不碰 SQL"这条约束就只剩一句注释了。
 *
 * 因此这里只声明**本服务真正用到的两件事**（apply + get），
 * 由装配层把 `NativeMemoryStore` 适配进来（结构上它就是满足的）。
 */
export interface MemoryFoldPort {
  apply(event: DomainEvent): Promise<{ record: MemoryRecord | null }>
}

// ---------------------------------------------------------------------------
// 请求与结果
// ---------------------------------------------------------------------------

export interface ExplicitMemoryRequest {
  owner: EntityRef
  /** 用户的显式意图（由 `ExplicitMemoryIntentDetector` 产出） */
  intent: ExplicitMemoryIntent
  /**
   * 触发这次操作的**用户对话事件 id**。
   *
   * 它是所有副作用（领域事件）的来源：
   *   · `remember`  — 这条记忆的证据就是这句话
   *   · `correct` / `forget` / `dispute` — 「由哪句话引起的」就是这句话
   *
   * 计划书第 5 节：没有来源的变化不允许落库。
   * 类型上必填，因此"忘了传来源"在编译期就写不出来。
   */
  triggerEventId: string
  /** 这句话讲的是谁（通常是从事件解析出的用户） */
  speaker: EntityRef
  /**
   * 目标的 canonical key（若调用方在同轮内已经知道）。
   *
   * 它直接决定解析走第 2 步还是退化成模糊匹配 ——
   * 而"忘掉我关于香菜的偏好"这种说法**必须**靠它，
   * 因为中文"香菜"与 predicate `food.preference.cilantro` 没有词面重叠
   * （见 `target-resolver.ts` 的 `scoreByHints` 说明）。
   */
  targetCanonicalKey?: string
  /** 目标提示词（由 `targetHintsFrom()` 产出） */
  hints?: readonly string[]
}

export type ExplicitMemoryOutcome =
  | {
      ok: true
      intent: ExplicitMemoryIntentKindName
      memoryId: MemoryId
      record: MemoryRecord
      /** 领域事件 id（审计用） */
      domainEventId: string
      /** 放行口走的哪条路径 */
      authoritative: true
      /**
       * 本次成功**实际做了什么**（M9.1 / ADR-072 D09）。
       *
       * `performed: 'dispute'`：`ok:true` 只表示「存疑标记这个动作」生效了，
       * **不是**写入了新内容 —— 事件是 `MEMORY_DISPUTED`，库里没有任何新记忆。
       * 翻译层据此走 `not_written`（不得成功口吻），见 `explicit-turn.ts`。
       *
       * 缺席 = 普通写入（create/supersede/retract 各自的字面含义）。
       */
      performed?: 'dispute'
    }
  | {
      ok: false
      intent: ExplicitMemoryIntentKindName
      reason: ExplicitMemoryFailureReason
      /** 人类可读细节（进 trace；**不含**敏感内容） */
      detail: string
      /** 解析出的候选（`ambiguous` 时非空） */
      candidates?: { memoryId: string; summary: string }[]
      /**
       * 放行口的**拒绝码**（`rejected_by_policy` 时非空）。
       *
       * ⚠️ 为什么单独给码而不是让调用方去解析 `detail`：
       * `detail` 是"码 + 人类可读消息"拼起来的字符串，而消息里**可能含内容**
       * （例如 payload 契约违规的说明会把违规字段读出来）。
       * 调用方要往 trace 里记东西，就只能记**码** ——
       * 计划书第 110 节不允许记忆内容进 trace。
       *
       * 实测动机：显式写入在真库上被拒之后，trace 里只有
       * `rejected_by_policy` 一个词，而**具体是哪个闸拒的**看不出来，
       * 只能靠猜（我先猜了 `content_type_mismatch`，猜错了）。
       * 一份"只告诉你被拒了"的路径无法被排查。
       */
      codes?: readonly string[]
    }

type ExplicitMemoryIntentKindName = ExplicitMemoryIntent['kind']

/**
 * 失败的**分类**。
 *
 * 为什么不是自由字符串：调用方要对它们给出**不同的**用户可见行为
 * （计划书第 55 / 145 节要求"不能假成功"，而"不能假成功"的下一步
 * 是"那该说什么"）。自由字符串会让"每一种失败该怎么回应"
 * 散落在各个调用点，于是某天会有一个分支悄悄回落到"那就说记住了吧"。
 */
export type ExplicitMemoryFailureReason =
  /** 没能从用户那句话里解析出结构化的记忆（**不是失败，是没听懂**） */
  | 'content_unresolved'
  /** 只有指令没有内容（"记住"） */
  | 'content_empty'
  /** 找不到目标记忆 */
  | 'target_not_found'
  /** 找到多条，判不出是哪条 */
  | 'target_ambiguous'
  /** 放行口拒绝（权威 / 证据 / payload / 幂等等） */
  | 'rejected_by_policy'
  /** 持久化失败（数据库错误） */
  | 'persistence_failed'
  /** 幂等命中：这件事之前已经生效过 */
  | 'already_applied'
  /**
   * 事件提交了，但折叠结果不是 ACTIVE（M9.1 / ADR-072 D08）。
   *
   * F-4 的核心：确定性 id 撞上 retracted/superseded 记录时，`MEMORY_CREATED`
   * 照常提交、折叠却 no-op —— 「请求提交成功」被当成了「认知修改成功」
   * （INV-CI-13）。本原因把两者分开：**没有产生有效写入**，
   * 调用方不得使用成功口吻。复活开关（D12）只闸「要不要让它复活」，
   * 不闸「要不要诚实」。
   */
  | 'write_not_effective'

// ---------------------------------------------------------------------------
// 依赖
// ---------------------------------------------------------------------------

export interface ExplicitMemoryServiceDeps {
  /** 折叠端口（见 `MemoryFoldPort` 的说明：Application 层不认识持久化实现） */
  store: MemoryFoldPort
  validator: MemoryMutationValidator
  /** 内容抽取器。缺省 = 只走规则（离线安全） */
  extractor?: MemoryContentExtractor
  /**
   * 目标解析器。
   *
   * 直接复用 `target-resolver.ts` 的 `TargetResolution`，**不另造一个最小面**。
   * 第一版造过一个（`ResolvedTargetLike`），而它的 `candidates` 字段
   * 与 `TargetResolution` 的同名字段语义冲突（一个是数量、一个是记录数组），
   * 于是类型检查报错 —— 那个错误的根因是**用一个新类型去近似一个既有类型**，
   * 而近似总会漏掉某个字段的语义。同层文件直接共用类型。
   */
  resolveTarget: (input: {
    owner: EntityRef
    text: string
    canonicalKey?: string
    subject?: EntityRef
    hints?: readonly string[]
  }) => Promise<TargetResolution>
  /**
   * 提交已放行的领域事件（写 `character_domain_events`）。
   *
   * 由装配层注入（生产是 `applyAcceptedEvents`）。
   * 抽成端口是为了让这个服务**不 import 持久化实现** ——
   * 它是 Application 层，只该认识契约与端口。
   */
  commitEvents: (accepted: MemoryValidationOutcome['accepted'], now: number) => Promise<DomainEvent[]>
  /**
   * **槽位冲突分析的读取端口**（M6.1 WP4 / ADR-055 `D-55b`）。
   *
   * 用户批准的 A 要求：写入路径在**提交前**也要消费冲突判定，而且必须
   * 「与 `pipeline.ts` **同一实现**，不得复制一份」 ⇒ 这里直接复用它的端口类型。
   *
   * ⚠️ **可选**，缺省时行为与今天**逐字相同**（这正是 `pipeline.ts` 既有的
   *    "`deps.conflict === undefined` ⇒ 全部候选照常走"语义）⇒ 回退不需要数据迁移。
   */
  conflict?: MemoryConflictPort
  /**
   * **B① 目标层兜底的读取端口**（M6.1 WP5 / ADR-058，用户裁定 R1）。
   *
   * 契约：返回"与 `triggerEventId` **同一会话**（`conversation_events.conversation_id`
   * 相同）内、`speaker` 经**显式路径**写入（`processor = 'explicit-memory'`）的
   * **ACTIVE** 记录，按 `recordedAt` **降序**"（最近的在前；上限由装配层定）。
   *
   * ⚠️ **可选**，缺省 `undefined` ⇒ 兜底整段不启用，行为与今天**逐字相同**
   *    （与 `conflict` 端口同一条纪律：回退不需要数据迁移）。
   * ⚠️ 生产（`main.ts buildMemoryWriter`）与复现器接**同一个**实现
   *    （`memory-store.ts` 的 `listRecentExplicitWrites`）⇒ 复现与生产接线逐字一致。
   * ⚠️ 本端口**只被 `correct` 的兜底读取**：`remember` / `forget` / `dispute`
   *    不经过它（D-58a）。
   */
  recentExplicitWrites?: (input: {
    owner: EntityRef
    speaker: EntityRef
    triggerEventId: string
  }) => Promise<MemoryRecord[]>
  /**
   * 用户的**原话**（判断"有没有状态变化标记"，见 `conflict.ts`）。
   *
   * 只有把原话交给冲突判定，才能区分：
   *   「记住，我**现在**吃辣了」⇒ `TEMPORAL_UPDATE` ⇒ `SUPERSEDE`
   *   「记住，我吃辣」          ⇒ `CONTRADICTION`   ⇒ `MARK_DISPUTED`
   */
  utterance?: string
}

export interface ExplicitMemoryService {
  remember(request: ExplicitMemoryRequest): Promise<ExplicitMemoryOutcome>
  correct(request: ExplicitMemoryRequest): Promise<ExplicitMemoryOutcome>
  forget(request: ExplicitMemoryRequest): Promise<ExplicitMemoryOutcome>
  dispute(request: ExplicitMemoryRequest): Promise<ExplicitMemoryOutcome>
  /** 按意图种类分派（`TurnGateway` 用这个） */
  handle(request: ExplicitMemoryRequest): Promise<ExplicitMemoryOutcome>
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

export function createExplicitMemoryService(
  deps: ExplicitMemoryServiceDeps
): ExplicitMemoryService {
  const extractor = deps.extractor ?? new RuleBasedContentExtractor()

  async function remember(request: ExplicitMemoryRequest): Promise<ExplicitMemoryOutcome> {
    const text = request.intent.payload.trim()

    if (text === '') {
      // 用户只说了"记住" —— 这是一个**真实存在**的说法，
      // 而正确行为是追问"记住什么"，不是静默忽略、也不是记一条空记忆。
      return {
        ok: false,
        intent: 'remember',
        reason: 'content_empty',
        detail: '用户表达了"要记住"但没说记住什么（"记住。"这种句子没有可记录的内容）',
      }
    }

    // ---- 事务外：抽取内容（可能调模型）----------------------------------
    let extracted: ExtractedMemoryContent | undefined
    try {
      extracted = await extractor.extract({
        text,
        owner: request.owner,
        speaker: request.speaker,
      })
    } catch (error) {
      captureError(error)
      return {
        ok: false,
        intent: 'remember',
        reason: 'content_unresolved',
        detail: `内容抽取器抛错：${error instanceof Error ? error.message : String(error)}`,
      }
    }

    if (extracted === undefined) {
      /*
       * ⚠️ 这是显式路径上**最重要的一次诚实**。
       *
       * 用户明确说"记住"，而系统没能把它变成结构化记忆。
       * 三条可能的错误反应：
       *   ① 说"记住了"（假成功 —— 计划书第 55 节明令禁止）
       *   ② 静默忽略（用户以为记下了，半年后发现没有）
       *   ③ 随便造一条（污染，且不可回溯修正）
       *
       * 正确反应是**如实说没抓住**，并让调用方去追问或走后台路径。
       */
      return {
        ok: false,
        intent: 'remember',
        reason: 'content_unresolved',
        detail:
          `没能把「${truncate(text)}」解析成结构化记忆（槽位未识别）。` +
          '显式路径不允许"随便造一条"，因此如实回报未解析',
      }
    }

    // ---- 造候选（纯计算）-----------------------------------------------
    const candidate = buildCandidate({
      owner: request.owner,
      extracted,
      triggerEventId: request.triggerEventId,
    })

    /*
     * ==========================================================================
     *  冲突分析（M6.1 WP4 / ADR-055 `D-55b`）—— 提交**之前**消费槽位冲突判定
     * ==========================================================================
     *
     * 为什么必须有这一段：实测（设计文档 §2.6 / §1.17）同槽位的第二次 `remember` 会**再建一条**，
     * 于是库里两条都 `active`，而用户看不出区别。
     *
     * 判据**不新造**：`analyzeConflict` + `resolveConflict` 与提取管线**同一对纯函数**，
     * 动作表也逐条同构（`pipeline.ts` 的冲突段）：
     *
     *     CREATE            → 照常建条
     *     REJECT_DUPLICATE  → **不建**（"已经记着了"，不是"记下了"）
     *     SUPERSEDE         → 建新条（带 `validFrom`）+ 作废旧条
     *     MARK_DISPUTED     → **只把旧条标争议、不建新条**（"不擅自选一个"）
     *     NEEDS_REVIEW      → 不建、如实回报（不猜、不挑、不覆盖）
     *
     * ⚠️ `deps.conflict === undefined` ⇒ **整段跳过**，行为与今天**逐字相同**。
     *    这正是回退路径：不注入就回到旧行为，不需要数据迁移。
     * ⚠️ 没有槽位的家族（Episode / SELF_EXPERIENCE）走 `slotOfCandidate === undefined`
     *    ⇒ 与管线一致地交给第三层去重，本段不处理。
     */
    if (deps.conflict !== undefined) {
      const slot = slotOfCandidate(candidate)
      if (slot !== undefined) {
        const activeInSlot = await deps.conflict.recordsInCanonicalSlot({
          owner: request.owner,
          canonicalKey: slot.canonicalKey,
        })
        const analysis = analyzeConflict({
          candidate,
          activeInSlot,
          /*
           * ⚠️ 原话**必须逐轮取**：`deps.utterance` 是构造期注入的，一个服务实例跨多轮，
           *    拿它当默认会让"状态变化标记"永远取自同一句。所以默认用**本次请求的原话**
           *    （`request.intent.sourceText`），`deps.utterance` 只作测试用的显式覆盖。
           */
          utterance: deps.utterance ?? request.intent.sourceText,
        })
        const resolution = resolveConflict(analysis)

        if (resolution.action === 'REJECT_DUPLICATE') {
          return {
            ok: false,
            intent: 'remember',
            reason: 'already_applied',
            detail: `该槽位上已经有一条一模一样的记录，未新建：${resolution.reason}`,
          }
        }

        if (resolution.action === 'NEEDS_REVIEW') {
          return {
            ok: false,
            intent: 'remember',
            reason: 'rejected_by_policy',
            detail: `槽位冲突判不了，未写入（不猜、不挑、不覆盖）：${resolution.reason}`,
          }
        }

        if (resolution.action === 'MARK_DISPUTED') {
          /*
           * ⚠️ 这里**不建新条**（与 `pipeline.ts` 的 `MARK_DISPUTED` 分支同构）：
           * 判不出"是更新还是矛盾"时，正确行为是**保持现状待澄清**，
           * 而不是先把新值写成现状、再把旧值标争议 —— 那等于**擅自选了新值**。
           */
          return runMutation({
            deps,
            request,
            operation: 'dispute',
            candidates: [],
            intent: 'remember',
            target: {
              memoryId: resolution.target.id,
              conflictingMemoryIds: [],
              reason: truncate(resolution.reason),
            },
          })
        }

        if (resolution.action === 'SUPERSEDE') {
          /*
           * 与 `correct` 的 supersede 分支同样的**顺序**：先建新条、再作废旧条
           * （`MEMORY_SUPERSEDED` 的 payload 需要新条的 id，而它由新条的事件确定）。
           * `proposedValidFrom = now` 也必须带上（计划书第 36 节：两个时间边界都要写）。
           */
          const nowMs = Date.now()
          const created = await runMutation({
            deps,
            request,
            operation: 'create',
            candidates: [{ ...candidate, proposedValidFrom: nowMs }],
            intent: 'remember',
          })
          if (!created.ok) return created

          const superseded = await runMutation({
            deps,
            request,
            operation: 'supersede',
            candidates: [],
            intent: 'remember',
            target: {
              memoryId: resolution.target.id,
              supersededBy: created.memoryId,
              validUntil: nowMs,
              reason: truncate(resolution.reason),
            },
          })
          if (!superseded.ok) {
            // 新条建好、作废失败 ⇒ 如实回报：现在是**可检测的中间态**（同槽位两条 active），
            // 不能让她以为更新完成了。
            return {
              ok: false,
              intent: 'remember',
              reason: superseded.reason,
              detail:
                `新记忆（${String(created.memoryId)}）已建立，但对旧记忆的 supersede 失败：` +
                superseded.detail,
              candidates: [{ memoryId: String(created.memoryId), summary: '已建立的新记忆' }],
            }
          }
          return superseded
        }
      }
    }

    // ---- 放行 + 提交 + 折叠 ---------------------------------------------
    return runMutation({
      deps,
      request,
      operation: 'create',
      candidates: [candidate],
      intent: 'remember',
    })
  }

  async function correct(request: ExplicitMemoryRequest): Promise<ExplicitMemoryOutcome> {
    const resolved = await resolveFor(deps, request)
    if (resolved.status !== 'resolved' || !mayMutate(resolved)) {
      /*
       * ========================================================================
       *  M6.1 WP5 / B① / ADR-058：目标层兜底（只在 `not_found` 时尝试）
       * ========================================================================
       * 复现证明这两条的失败在**目标解析**这一步（「转到历史学了 / 换成 Mac 了」
       * 与旧值零词面重叠 ⇒ 相关性闸判 not_found ⇒ 抽取器根本没被调用）。
       *
       * 兜底的闸门（D-58a/58b/58d，全部不满足 ⇒ `undefined` ⇒ 维持今天的诚实失败）：
       *   ① 端口已接线（缺省不注入 ⇒ 本段整段跳过，行为与今天逐字相同）；
       *   ② 只在 `not_found`（零词面证据）时——`ambiguous` 是"话已命中多条"，
       *      用近因去挑一条正是 INV-M41-02 禁止的"猜着改"，不兜底；
       *   ③ 会话内显式写入恰好覆盖 1 个槽位（≥2 ⇒ target_ambiguous；0 ⇒ not_found）；
       *   ④ 更正句对那一个槽位抽出**过守卫的**值（不经过全局抽取器）。
       */
      if (resolved.status === 'not_found' && deps.recentExplicitWrites !== undefined) {
        const fallback = await correctViaRecentWrite(deps, request, extractor)
        if (fallback !== undefined) return fallback
      }
      return targetFailure('correct', resolved, request)
    }

    const target = resolved.record!

    /*
     * 纠正有**两种语义**（计划书第 56 / 83 / 84 节）：
     *
     *   · 旧条本身是错的、不该存在 → RETRACTED
     *   · 旧条当时是真的，但现在有新状态 → SUPERSEDED + 新条
     *
     * 怎么区分？计划书第 83 节给的方向是"明确说明旧 Memory 错"时
     * 走 RETRACTED。落到实现上，判据是**能不能抽出一条新的事实内容**：
     *   · 能抽出来 → 用户说的是"现在不一样了" → SUPERSEDE + 新条
     *   · 抽不出来 → 用户说的是"那条是错的"，而且没说新的是什么 → RETRACT
     *
     * 这个判据是**可解释的**，而且它的失败方向是安全的：
     * 抽不出内容时我们不去猜一条新的，只是把旧的标为错。
     */
    const text = request.intent.payload.trim()
    let extracted: ExtractedMemoryContent | undefined
    if (text !== '') {
      try {
        extracted = await extractor.extract({
          text,
          owner: request.owner,
          speaker: request.speaker,
          correctionSourceText: request.intent.sourceText,
        })
      } catch (error) {
        captureError(error)
        extracted = undefined
      }
    }

    if (extracted === undefined) {
      return runMutation({
        deps,
        request,
        operation: 'retract',
        candidates: [],
        intent: 'correct',
        target: {
          memoryId: target.id,
          reason: 'explicit_correction',
          note: truncate(request.intent.sourceText),
        },
      })
    }

    /*
     * 主路径与 B① 兜底（ADR-058）**共用**同一个替换序列：
     * 同一个 `buildCandidate`、同一对 runMutation、同一份失败回报 ——
     * 两处行为由构造保证同形，而不是靠"写了两遍但记得保持一致"。
     */
    return supersedeWithReplacement(deps, request, target, extracted)
  }

  async function forget(request: ExplicitMemoryRequest): Promise<ExplicitMemoryOutcome> {
    const resolved = await resolveFor(deps, request)
    if (resolved.status !== 'resolved' || !mayMutate(resolved)) {
      return targetFailure('forget', resolved, request)
    }

    /*
     * 计划书第 58–59 节：默认语义是 **cognitive forget**（→ RETRACTED），
     * 而**不是**删除原始 Conversation data。
     *
     *     Memory → RETRACTED，以后不再 Recall
     *     原始 Conversation Ledger 仍然保留（用于 audit / event consistency）
     *
     * 这条在实现上不需要额外代码 —— 因为 `MEMORY_RETRACTED` 本来就只改状态，
     * 而本服务**没有**任何删 `conversation_events` 的路径。
     * 但正因如此，它需要一句**断言级**的说明：
     * 未来若有人给这里加"顺便删掉原始对话"，那是一次数据治理决策，
     * 不是"遗忘"的顺带行为。
     */
    return runMutation({
      deps,
      request,
      operation: 'retract',
      candidates: [],
      intent: 'forget',
      target: {
        memoryId: resolved.record!.id,
        reason: 'explicit_forget',
        note: truncate(request.intent.sourceText),
      },
    })
  }

  async function dispute(request: ExplicitMemoryRequest): Promise<ExplicitMemoryOutcome> {
    const resolved = await resolveFor(deps, request)
    if (resolved.status !== 'resolved' || !mayMutate(resolved)) {
      return targetFailure('dispute', resolved, request)
    }
    return runMutation({
      deps,
      request,
      operation: 'dispute',
      candidates: [],
      intent: 'dispute',
      target: {
        memoryId: resolved.record!.id,
        conflictingMemoryIds: [],
        reason: truncate(request.intent.sourceText),
      },
    })
  }

  return {
    remember,
    correct,
    forget,
    dispute,
    async handle(request) {
      switch (request.intent.kind) {
        case 'remember':
          return remember(request)
        case 'correct':
          return correct(request)
        case 'forget':
          return forget(request)
        case 'dispute':
          return dispute(request)
        default:
          throw new KernelError(
            'validation_error',
            'unknown_explicit_intent',
            `未登记的显式意图种类：${String(request.intent.kind)}`
          )
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 公共步骤
// ---------------------------------------------------------------------------

async function resolveFor(
  deps: ExplicitMemoryServiceDeps,
  request: ExplicitMemoryRequest
): Promise<TargetResolution> {
  return deps.resolveTarget({
    owner: request.owner,
    text: `${request.intent.payload} ${request.intent.sourceText}`,
    ...(request.targetCanonicalKey !== undefined
      ? { canonicalKey: request.targetCanonicalKey }
      : {}),
    subject: request.speaker,
    ...(request.hints !== undefined ? { hints: request.hints } : {}),
  })
}

function targetFailure(
  intent: ExplicitMemoryIntentKindName,
  resolved: TargetResolution,
  request: ExplicitMemoryRequest
): ExplicitMemoryOutcome {
  if (resolved.status === 'ambiguous') {
    return {
      ok: false,
      intent,
      reason: 'target_ambiguous',
      detail:
        `找到 ${resolved.candidates.length} 条可能的记忆，判不出用户指的是哪一条。` +
        '计划书第 57 节禁止"对整个 Memory Store 做模糊大搜索"，' +
        '因此这里如实回报歧义，而不是挑一条',
      candidates: resolved.candidates.map((r) => ({
        memoryId: String(r.id),
        summary: summarize(r),
      })),
    }
  }
  return {
    ok: false,
    intent,
    reason: 'target_not_found',
    detail:
      `没有找到与「${truncate(request.intent.payload || request.intent.sourceText)}」匹配的现有记忆` +
      `（最后尝试的路径：${resolved.via ?? '(无)'}）`,
  }
}

/**
 * **先建新条、再 supersede 旧条** —— correct 的主路径与 B① 兜底（ADR-058）共用的
 * 替换序列。抽成一个函数而不是两处各写一遍：两处的顺序、payload 与失败回报
 * 由构造保证**逐字同形**（"写了两遍但记得保持一致"在这里是不可接受的）。
 */
async function supersedeWithReplacement(
  deps: ExplicitMemoryServiceDeps,
  request: ExplicitMemoryRequest,
  target: MemoryRecord,
  extracted: ExtractedMemoryContent
): Promise<ExplicitMemoryOutcome> {
  const replacement = buildCandidate({
    owner: request.owner,
    extracted,
    triggerEventId: request.triggerEventId,
  })

  /*
   * ⚠️ 顺序很重要：**先建新条、再 supersede 旧条**。
   *
   * 因为 `MEMORY_SUPERSEDED` 的 payload 需要 `supersededBy`（新条的 id），
   * 而那个 id 由新条的领域事件确定。若反过来（先 supersede），
   * 就只能凭空编一个新 id —— 而那个 id 未必真的会被建立，
   * 于是库里留下一条 `supersededBy` 指向不存在的记忆（悬空引用）。
   *
   * 两步各自是一个工作单元（各有自己的幂等键），因此"新条建好、
   * supersede 失败"会留下一条并存的新条而不是半个状态 ——
   * 那是一个**可检测**的中间态（同一槽位两条 ACTIVE），
   * 由 `m4:verify` 的审计探针报出来，而不是静默不一致。
   */
  const created = await runMutation({
    deps,
    request,
    operation: 'create',
    candidates: [replacement],
    intent: 'correct',
  })
  if (!created.ok) return created

  const superseded = await runMutation({
    deps,
    request,
    operation: 'supersede',
    candidates: [],
    intent: 'correct',
    target: {
      memoryId: target.id,
      supersededBy: created.memoryId,
      validUntil: Date.now(),
      reason: truncate(request.intent.sourceText),
    },
  })

  if (!superseded.ok) {
    // 新条建好了、supersede 失败。**如实回报**：调用方必须知道
    // 现在同一槽位上有两条（可检测的中间态），而不是以为纠正完成了。
    return {
      ok: false,
      intent: 'correct',
      reason: superseded.reason,
      detail:
        `新记忆（${String(created.memoryId)}）已建立，但对旧记忆的 supersede 失败：` +
        superseded.detail,
      candidates: [{ memoryId: String(created.memoryId), summary: '已建立的新记忆' }],
    }
  }

  return superseded
}

/**
 * **B① 目标层兜底**（M6.1 WP5 / ADR-058；只在 `correct` 的正常解析
 * `not_found` 且端口已接线时被调用 —— 闸门见 `correct()` 里那段注释）。
 *
 * 返回 `undefined` = 兜底不成立 ⇒ 调用方**维持今天的诚实失败**（不猜、不写、不撤）。
 * 返回 outcome = 兜底成立（`target_ambiguous` 的诚实拒绝，或 create+supersede 的结果）。
 *
 * ⚠️ 与主路径的一个**刻意**差异：兜底抽不出值时**绝不 RETRACT**。
 *    主路径的"抽不出 ⇒ 撤旧条"语义前提是"目标由用户的话确定"；
 *    兜底的目标本来就是**推断**出来的，此时撤旧条比什么都不做危险得多
 *    （D-58e）。
 */
async function correctViaRecentWrite(
  deps: ExplicitMemoryServiceDeps,
  request: ExplicitMemoryRequest,
  extractor: MemoryContentExtractor
): Promise<ExplicitMemoryOutcome | undefined> {
  let writes: MemoryRecord[]
  try {
    writes = await deps.recentExplicitWrites!({
      owner: request.owner,
      speaker: request.speaker,
      triggerEventId: request.triggerEventId,
    })
  } catch (error) {
    // 兜底的读取失败 ⇒ 回到今天的诚实失败。绝不因为"兜底坏了"就变得更激进。
    captureError(error)
    return undefined
  }

  const target = pickRecentExplicitWriteTarget(writes)
  if (target === undefined) return undefined // 0 个候选 ⇒ not_found（今天的行为）

  if (target.status === 'ambiguous') {
    /*
     * 会话内显式写入覆盖 ≥2 个槽位 ⇒ "最近一次写入"给不出确定答案。
     * 诚实拒绝（D-58b）：她该问"你说的是哪一件？"，而不是我们替她挑一条。
     */
    return {
      ok: false,
      intent: 'correct',
      reason: 'target_ambiguous',
      detail:
        `这句话没有点名要更正哪一件（词面上找不到），而本次会话里你让我记过 ` +
        `${target.slots.length} 个不同的事（${target.slots.join('、')}），判不出这次指哪一个。` +
        '按裁定不猜、不挑——告诉我你说的是哪一件，我再来改',
      candidates: target.records.map((record) => ({
        memoryId: String(record.id),
        summary: summarize(record),
      })),
    }
  }

  const record = target.record
  if (record.content.kind !== 'claim') return undefined // 防御：无槽位记录不兜底（端口契约已保证）

  const correctionText = request.intent.payload.trim() || request.intent.sourceText

  let extractedValue = extractCorrectionValue(correctionText, record)

  /*
   * B② 槽位限定抽取闸（2026-09-25 用户裁定 / ADR-063；correction-fallback@2）：
   * B① 标记取值失败 ≠ 到此为止——用**本服务绑定的抽取器**（生产 = 规则抽取器，
   * 确定性）跑一遍更正句，只接受"恰好抽出目标槽位 claim"的读数
   * （`slotRestrictedCorrectionValue` 的闸在纯函数模块里，正负控锁在 kernel-tests-memory）。
   * 实测缺口：SRP-C-05「更正一下，我读研究生了。」——无转换标记，B① 全过不了；
   * 抽取器对「研究生」有 education.status=graduate 规则 ⇒ B② 接住。
   * 抽取抛错 / 槽位不匹配 / 抽不出 ⇒ 一律 undefined ⇒ 维持诚实失败（不猜、不写、不撤）。
   */
  if (extractedValue === undefined) {
    try {
      const slotExtracted = await extractor.extract({
        text: correctionText,
        owner: request.owner,
        speaker: request.speaker,
        correctionSourceText: request.intent.sourceText,
      })
      extractedValue = slotRestrictedCorrectionValue(slotExtracted, record)
    } catch (error) {
      // B② 的抽取失败 ⇒ 回到诚实失败。绝不因为"兜底坏了"就变得更激进（与读取端口同一条理由）。
      captureError(error)
      extractedValue = undefined
    }
  }

  if (extractedValue === undefined) return undefined // 抽不出过守卫的值 ⇒ 不猜、不写

  /*
   * 替换候选：**同 type、同 predicate（槽位）、新值** —— 槽位来自目标记录，
   * 不来自这句话（这句话只贡献"值"）。confidence 给 0.7：低于规则命中的 0.8，
   * 因为"目标由近因推断"这一步是启发式的（ADR-058 §1.1 的 weak 级目标证据）。
   */
  const extracted: ExtractedMemoryContent = {
    type: record.type,
    content: {
      kind: 'claim',
      subject: request.speaker,
      predicate: record.content.predicate,
      value: extractedValue.value,
    },
    subjects: [request.speaker],
    confidence: 0.7,
    basis: extractedValue.basis,
    predicate: record.content.predicate,
  }

  return supersedeWithReplacement(deps, request, record, extracted)
}

/**
 * 放行 → 提交 → 折叠。**唯一**的写入路径。
 *
 * 返回 `ok: true` 的**充要条件**是：
 *   1. 放行口接受（权威、证据、幂等、payload 都过）
 *   2. 领域事件已写入 `character_domain_events`
 *   3. 投影已折叠（`store.apply` 返回）
 *
 * 三者缺一都返回 `ok: false`。这就是计划书第 55 节那条产品规则的形状化。
 */
async function runMutation(input: {
  deps: ExplicitMemoryServiceDeps
  request: ExplicitMemoryRequest
  operation: 'create' | 'supersede' | 'retract' | 'dispute'
  candidates: readonly ReturnType<typeof buildCandidate>[]
  intent: ExplicitMemoryIntentKindName
  target?: {
    memoryId: MemoryId
    supersededBy?: MemoryId
    validUntil?: number
    reason?: string
    note?: string
    conflictingMemoryIds?: MemoryId[]
  }
}): Promise<ExplicitMemoryOutcome> {
  const { deps, request, operation, intent } = input

  // --- 1. 放行（事务外；纯校验 + 只读查询）--------------------------------
  let outcome: MemoryValidationOutcome
  try {
    outcome = await deps.validator.validate({
      characterId: characterIdOf(request.owner),
      owner: request.owner,
      candidates: input.candidates,
      mutation: 'explicit',
      operation,
      triggeredByEventId: request.triggerEventId,
      ...(input.target !== undefined ? { target: input.target } : {}),
    })
  } catch (error) {
    captureError(error)
    return {
      ok: false,
      intent,
      reason: 'persistence_failed',
      detail: `放行校验期间发生故障：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (outcome.accepted.length === 0) {
    const codes = outcome.rejected.map((r) => r.code)

    /*
     * ⚠️ 幂等命中是**失败**而不是成功 —— 这个区分很关键。
     *
     * "这件事之前已经生效过"从**系统**的角度是一次安静的成功，
     * 但从**这次请求**的角度，我们没有做任何事。
     *
     * 如果把它当成 `ok: true`，那么"用户再说一次『记住我不吃香菜』"
     * 会让调用方回答"记住了。好，我记住了。"
     * —— 而系统其实**没有**新建任何东西。那是一句**不准确的确认**。
     *
     * 计划书第 55 节要求的是"持久化成功以后才能确认成功"。
     * 幂等命中时持久化**没有发生**，因此它的正确回报是
     * "这条我已经记着了"（`already_applied`），
     * 而不是"记住了"（`ok: true`）。
     */
    if (codes.includes('duplicate_operation') || codes.includes('duplicate_content')) {
      return {
        ok: false,
        intent,
        reason: 'already_applied',
        detail:
          `这条记忆已经存在（拒绝码：${codes.join(',')}）。` +
          '这不是失败，但也不是"这次记下了" —— 调用方应当说"这条我已经记着了"，' +
          '而不是重复一次"记住了"',
      }
    }

    return {
      ok: false,
      intent,
      reason: 'rejected_by_policy',
      detail: outcome.rejected.map((r) => `${r.code}: ${r.message}`).join('; '),
      // 只把**码**交给调用方（消息可能含内容，见 `codes` 的说明）
      codes: outcome.rejected.map((r) => r.code),
    }
  }

  // --- 2. 提交领域事件（**唯一**的持久化动作）----------------------------
  let events: DomainEvent[]
  try {
    events = await deps.commitEvents(outcome.accepted, Date.now())
  } catch (error) {
    captureError(error)
    return {
      ok: false,
      intent,
      reason: 'persistence_failed',
      detail:
        `写入领域事件失败：${error instanceof Error ? error.message : String(error)}。` +
        '**没有**任何记忆被建立 —— 绝不允许在这里回报"记住了"（计划书第 55 节）',
    }
  }

  if (events.length === 0) {
    return {
      ok: false,
      intent,
      reason: 'persistence_failed',
      detail:
        '放行口接受了提案，但提交没有产出任何领域事件（内部不一致）。' +
        '不允许回报成功 —— 那种"成功"没有任何数据支持',
    }
  }

  // --- 3. 折叠进投影 ------------------------------------------------------
  let last: MemoryRecord | null = null
  try {
    for (const event of events) {
      const applied = await deps.store.apply(event)
      if (applied.record !== null) last = applied.record
    }
  } catch (error) {
    captureError(error)
    return {
      ok: false,
      intent,
      reason: 'persistence_failed',
      detail:
        `事件已写入，但折叠进投影失败：${error instanceof Error ? error.message : String(error)}。` +
        '领域事件在库里（重放可以恢复），因此这是一次**可修复**的失败，' +
        '但本次请求**不能**回报成功',
    }
  }

  if (last === null) {
    // 对已存在记忆的变更（supersede / retract / dispute）走 store.apply 时也返回记录，
    // 因此这里为 null 意味着 reducer 把它变成了"不存在" —— M4 不该出现。
    const memoryId =
      memoryIdOfEvent(events[0]) ?? input.target?.memoryId ?? asMemoryId('mem:unknown:unknown')
    return {
      ok: false,
      intent,
      reason: 'persistence_failed',
      detail: `事件已处理，但折叠后没有得到记录（memoryId=${String(memoryId)}）`,
    }
  }

  /*
   * --- 3.5 写入生效检查（M9.1 / ADR-072 D08，**不受开关控制**）----------------
   *
   * create 的折叠结果必须 `status === 'active'` 才算「这次记下了」。
   *
   * F-4 的机制：忘掉/更正后逐字重述 ⇒ 确定性 id 撞上 retracted/superseded 记录
   * ⇒ `MEMORY_CREATED` 提交成功、折叠 no-op ⇒ `last` 是**旧状态**的记录。
   * 若在这里放行 `ok:true`，调用方就会说「记住了」—— 而认知**没有**被修改
   * （INV-CI-13「请求提交成功 ≠ 认知修改成功」）。
   *
   * 开关（D12）只决定这条 CREATE **要不要带上复活标记**（让折叠真正生效）；
   * 折叠没生效时的诚实回报是本条，与开关无关。
   *
   * R01（首次 remember / SUPERSEDE 的新条）不受影响：它们的折叠必然 active
   * —— 新 id 无碰撞，`applyCreated` 走首次创建分支。
   */
  if (operation === 'create' && String(last.status) !== 'active') {
    return {
      ok: false,
      intent,
      reason: 'write_not_effective',
      detail:
        `事件已提交，但折叠结果不是 ACTIVE（status=${String(last.status)}，memoryId=${String(last.id)}）。` +
        '这条内容此前被撤销/更正过，本次重述没有产生有效写入（同 id 折叠 no-op）。' +
        '**不允许**回报"记住了"——那是 INV-CI-13 禁止的假成功',
    }
  }

  return {
    ok: true,
    intent,
    memoryId: last.id,
    record: last,
    domainEventId: String(events[events.length - 1].id),
    authoritative: true,
    /*
     * D09：dispute 的 ok:true 只表示「存疑标记」生效 —— 没有写入任何新内容。
     * 翻译层据此走 not_written（不得成功口吻）。
     */
    ...(operation === 'dispute' ? { performed: 'dispute' as const } : {}),
  }
}

// ---------------------------------------------------------------------------
// 候选构造
// ---------------------------------------------------------------------------

function buildCandidate(input: {
  owner: EntityRef
  extracted: ExtractedMemoryContent
  triggerEventId: string
}): MemoryCandidate {
  const evidence = conversationEvidence(input.triggerEventId)
  /*
   * 走 `createMemoryCandidate()` 而不是手搓一个对象字面量。
   *
   * 理由是**它承担三条失败关闭的断言**（内容与类型匹配 / 权威是否够建这类记忆 /
   * 证据与根）。手搓一个字面量会让这三条**被绕过** ——
   * 而那正是 M4 最不该绕过的地方（计划书第 27 / 148 节）。
   */
  return createMemoryCandidate({
    owner: input.owner,
    type: input.extracted.type,
    content: input.extracted.content,
    subjects: input.extracted.subjects,
    sourceRefs: [evidence],
    evidenceRootIds: [evidence.id],
    epistemicStatus: 'reported',
    /*
     * 显式路径的权威是 `EXPLICIT_USER_STATEMENT`，**不是** `EXPLICIT_CORRECTION`。
     *
     * 理由（审计 §4 D1 的硬规则 1）：纠正级权威只能由**纠正意图**授予，
     * 而不是"这句话来自用户"。一个 `correct` 请求会走 `retract` / `supersede`
     * 两种操作 —— 而它们各自需要的是**用户在指出旧条错了**这个事实，
     * 不是"新条有纠正级权威"。
     *
     * 把 correct 建立的那条替换内容标成 EXPLICIT_USER_STATEMENT 是对的：
     * 用户确实明确陈述了新的状态。
     */
    authority: 'EXPLICIT_USER_STATEMENT',
    /*
     * importance：显式要求记住 → 计划书第 53 节明确"可以覆盖普通 importance policy"。
     *
     * ⚠️ 但覆盖的是**阈值**，不是**字段**。这里给的仍然是 0.8 而不是 1.0：
     * `importance` 的语义是"值得长期记住的程度"，
     * 而"用户要求记"只说明它在**当下**重要 ——
     * 写成 1.0 会让"这条比所有其它记忆都重要"变成事实，
     * 而那是用户没说过的话。
     */
    importance: 0.8,
    confidence: input.extracted.confidence,
    processor: 'explicit-memory',
    processorVersion: 'explicit-memory@1',
  })
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * owner → characterId。
 *
 * 与 `memory.ts` 的 `ownerCharacterId` 同义，但这里刻意**不 import 它**：
 * 那个函数在"不是 character"时抛的是领域错误，而本层需要的是
 * 一个能进 `MemoryValidationOutcome` 的字符串。
 * 放行口会自己再校验一次 owner 的 kind（`memory_owner_not_character`），
 * 因此这里只需要一个不会崩的转换。
 */
function characterIdOf(owner: EntityRef) {
  return owner.id as unknown as Parameters<MemoryMutationValidator['validate']>[0]['characterId']
}

function truncate(text: string, max = 60): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

/** 一行摘要（**不含正文**，可以安全进 trace 与回报） */
function summarize(record: MemoryRecord): string {
  const value =
    record.content.kind === 'claim'
      ? String(record.content.value)
      : record.content.summary
  return `${record.type}/${record.status} ${truncate(value, 40)}`
}

/**
 * 捕获被吞掉的错误。
 *
 * 显式路径上有若干"可以吞"的失败（内容抽取失败、分类失败）——
 * 它们不该影响聊天。但**吞掉不等于看不见**：这里把它记进 trace，
 * 以便回答"为什么这次没记住"。
 *
 * 真正的写入失败**不经过这里**：它们一律返回 `ok: false`
 * （计划书第 55 / 145 节）。
 */
function captureError(error: unknown): void {
  // 目前只进 console（trace 由 TurnGateway 在 slow path 层收集）。
  // 不用 throw：这些是"这次没抽出来"，与"聊天坏了"是两件事。
  if (process.env.M4_DEBUG_MEMORY === '1') {
    console.warn('[m4] explicit memory swallowed error:', error)
  }
}
