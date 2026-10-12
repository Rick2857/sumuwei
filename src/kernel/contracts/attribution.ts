/**
 * Attribution —— ADR-042 的**归因契约层**（M5.1.1 · WP1）。
 *
 * ============================================================================
 *  一句话：把"这是谁做的"拆成七个各自有归属的槽位，并且**允许说不知道**
 * ============================================================================
 *  `M5.1-D01` 的机制不是"少了一个字段"，而是**两个概念被合并**：
 *
 *     actor            谁**决定并执行**了这件事（她说话 → CHARACTER）
 *     contentOriginator 这条**内容是谁给的**（人类脚本代她写的 → 仍是那个提交者）
 *
 *  合并之后，"agent 用 user role 替用户发的话"与"用户亲手打的字"在账本里
 *  **完全不可区分**，于是 `EXPLICIT_USER_STATEMENT` 在技术上成立、对人却是误导的。
 *
 * ---------------------------------------------------------------------------
 *  三态：Known / Unknown / Absent（ADR-042 §5.2）
 * ---------------------------------------------------------------------------
 *      KNOWN   有具体位次
 *      UNKNOWN 概念适用，但不知道（必须带理由：历史没记 / 运行时定不下来）
 *      ABSENT  概念对此事件**不适用**（没有执行者，因为什么都没执行）
 *
 *  ｜Unknown ≠ Absent｜Known ≠ Unknown｜Known ≠ Absent｜
 *
 *  禁止"为了字段完整而填满"：把 `executor` 填成 `Known(USER)` 会把"不适用"
 *  伪装成一条断言；把 `Unknown` 填成一个默认位次会把"不知道"洗成"确定"。
 *  账本是 append-only 的 —— 一条错误的归因事后无法回收。
 *
 * ---------------------------------------------------------------------------
 *  本文件**不做**什么（WP1 的边界）
 * ---------------------------------------------------------------------------
 *  · 不碰 persistence / migration（列名只作为契约常量，DDL 属 WP2）
 *  · 不碰 Fact Firewall（`canEvidenceExternalFact` 行为零变化，属 Phase 4 / ADR-043）
 *  · 不建立 `PrincipalKind → ActorType` 的投影，也不建立
 *    `PrincipalKind → SourceKind` 的全函数（ADR-042 D8.1 已删除前者，U-08 禁止后者）
 *  · 不实现任何写入路径：本文件只有类型、受控词汇、矩阵与纯函数 validator
 */

import { KernelError } from './ids.ts'
import {
  PRINCIPAL_KINDS,
  UNKNOWN_REASONS,
  attributionAbsent,
  attributionKnown,
  attributionUnknown,
  principalRefEquals,
  type ActorType,
  type AttributionValue,
  type PrincipalKind,
  type PrincipalRef,
  type UnknownReason,
} from './actor.ts'
import {
  UNCONFIRMED_AXIS_B_VALUE,
  assertRecordedAxisB,
  classifyRecordedAxisB,
  defaultAuthorityForKind,
  epistemicSourceForKind,
  sourceKindForEventFamily,
  type EpistemicSource,
  type RecordedAxisBBranch,
  type SourceAuthority,
  type SourceKind,
} from './source-authority.ts'

// ---------------------------------------------------------------------------
// 槽位（ADR-042 D6）：七个名字，一个语义，一套三态
// ---------------------------------------------------------------------------

/**
 * 七个归因槽位的**规范名**（ADR-042 D6 的表格顺序）。
 *
 * ⚠️ 一个概念一个名字（ADR-042 L40–42 的命名纪律）：
 * Draft v1 的 `sourceAuthor` 已改名为 `contentOriginator`，**不得并行存在**。
 */
export const ATTRIBUTION_SLOTS = [
  'subject',
  'initiator',
  'actor',
  'executor',
  'authority',
  'recordedBy',
  'contentOriginator',
] as const

export type AttributionSlot = (typeof ATTRIBUTION_SLOTS)[number]

/** 除 `subject` 外，其余六个都是**可空槽位**（三态），`subject` 是派生语义 */
export const ATTRIBUTION_VALUE_SLOTS = [
  'initiator',
  'actor',
  'executor',
  'authority',
  'recordedBy',
  'contentOriginator',
] as const

export type AttributionValueSlot = (typeof ATTRIBUTION_VALUE_SLOTS)[number]

// ---------------------------------------------------------------------------
// AuthorityKind / AuthorityRef（ADR-042 D6 + §10）
// ---------------------------------------------------------------------------

/**
 * **许可的种类** —— 回答"凭什么可以做"，不是"谁"。
 *
 * ⚠️ 已删除 `DEVELOPER_SURFACE`（裁定 B5）：`cli` / `http` / `page` 是 **transport metadata**，
 *    不是许可。控制面自己的许可是 `CAPABILITY/<developer-control capability>` 或 `POLICY/<policy>`。
 * ⚠️ `Unknown` **不是**一种 AuthorityKind：不知道就写 `Unknown(reason)`，
 *    而不是造一个"未知的许可"（裁定 U-05 删除了 `UNKNOWN_LEGACY`）。
 */
export type AuthorityKind =
  | 'POLICY'
  | 'CAPABILITY'
  | 'SYSTEM_RULE'
  | 'USER_CONSENT'
  | 'BREAK_GLASS'

export const AUTHORITY_KINDS: readonly AuthorityKind[] = [
  'POLICY',
  'CAPABILITY',
  'SYSTEM_RULE',
  'USER_CONSENT',
  'BREAK_GLASS',
]

/**
 * 具体的许可引用：种类 + 标识。
 *
 * 与 schema 的列名对齐（`authority_kind` / `authority_ref` / `authority_unknown_reason`）：
 * 中间那列叫 `_ref` 而**不是** `_id` —— 它指向的是一条策略/一个能力，不是一个位次。
 */
export interface AuthorityRef {
  kind: AuthorityKind
  ref: string
}

/** authority 槽位的取值类型 */
export type AuthorityValue = AttributionValue<AuthorityRef>

// ---------------------------------------------------------------------------
// attribution_origin（ADR-042 §4）：整条归因是**怎么来的**
// ---------------------------------------------------------------------------

/**
 * `RECORDED`        写入时就记录了（新事件；必要时受必要性矩阵约束）
 * `MIGRATED_LEGACY` 历史回填出来的（阶段 1；受 D/P/U/N 回填规则约束）
 *
 * 与 `<slot>_unknown_reason` 的分工**不可互相替代**：
 *   origin        —— 整条 attribution 怎么来的
 *   unknown_reason —— **某个槽位**为什么不知道
 */
export type AttributionOrigin = 'RECORDED' | 'MIGRATED_LEGACY'

export const ATTRIBUTION_ORIGINS: readonly AttributionOrigin[] = ['RECORDED', 'MIGRATED_LEGACY']

// ---------------------------------------------------------------------------
// 事件族（必要性矩阵的行）与统一信封（ADR-042 D7）
// ---------------------------------------------------------------------------

/**
 * 必要性矩阵的行。
 *
 * 家族名刻意用**语义名**而不是事件类型名：`action_side_effect_execution` 覆盖
 * `ACTION_STARTED / SUCCEEDED / FAILED / PARTIAL / CANCELLED` 这一族执行侧事件，
 * 因为它们的必要性完全相同（ADR-042 §5 的四个行动行）。
 */
export type AttributionEventFamily =
  | 'user_message'
  | 'assistant_message'
  | 'system_event'
  | 'tool_event'
  | 'action_requested'
  | 'action_authorized'
  | 'action_side_effect_execution'
  | 'action_read_only_diagnostic'
  | 'developer_control'
  /**
   * `state_transition`（M5.1.1 / WP9-B1，R-45 = SELECTED B）—— 角色状态的转移。
   *
   * 它是**语义名**，与承载表 `state_events` 的名字刻意不同：族名**永远不是**
   * `SYSTEM` 的推导来源（见下方 NECESSITY_MATRIX 的注释与
   * `STATE_TRANSITION_SYSTEM_ORIGIN_RULE`）。
   */
  | 'state_transition'

export const ATTRIBUTION_EVENT_FAMILIES: readonly AttributionEventFamily[] = [
  'user_message',
  'assistant_message',
  'system_event',
  'tool_event',
  'action_requested',
  'action_authorized',
  'action_side_effect_execution',
  'action_read_only_diagnostic',
  'developer_control',
  'state_transition',
]

/**
 * 统一归因信封（ADR-042 D7）：**统一语义 + 差别必要性**。
 *
 * `subject` 的特别之处：它是 **canonical domain owner 的派生语义**，
 * 不是第二份存储（裁定 U-13）。所以它是 `PrincipalRef` 而不是三态值 ——
 * "这条事件记在谁的账上"永远有答案，但**不许**为它再加一对数据库列。
 */
export interface AttributionEnvelope {
  /** 这条事件记在谁的账上（由既有 canonical owner 派生，不新增存储） */
  subject: PrincipalRef
  initiator: AttributionValue<PrincipalRef>
  actor: AttributionValue<PrincipalRef>
  executor: AttributionValue<PrincipalRef>
  authority: AuthorityValue
  recordedBy: AttributionValue<PrincipalRef>
  contentOriginator: AttributionValue<PrincipalRef>
  /** 整条归因的来源（RECORDED / MIGRATED_LEGACY） */
  attributionOrigin: AttributionOrigin
}

// ---------------------------------------------------------------------------
// schema 列名（Proposed-Schema §0/§1）：契约与 DDL 的**唯一**桥
// ---------------------------------------------------------------------------

/**
 * 每个槽位的三个列名。**这是命名真相的唯一出处**（DDL 属 WP2，但名字在这里定）。
 *
 * 三态编码（Proposed-Schema §0）：
 *
 *     ABSENT  : kind IS NULL AND id IS NULL AND unknown_reason IS NULL
 *     KNOWN   : kind = <受控值> AND id IS NOT NULL AND unknown_reason IS NULL
 *     UNKNOWN : kind IS NULL AND id IS NULL AND unknown_reason = <UnknownReason>
 */
export const ATTRIBUTION_SLOT_COLUMNS: Readonly<
  Record<AttributionValueSlot, { kind: string; id: string; unknownReason: string }>
> = {
  initiator: {
    kind: 'initiator_kind',
    id: 'initiator_id',
    unknownReason: 'initiator_unknown_reason',
  },
  // ⚠️ `actor_ref_id` 而不是 `actor_id`：避免遮蔽既有的 legacy 列
  actor: { kind: 'actor_kind', id: 'actor_ref_id', unknownReason: 'actor_unknown_reason' },
  executor: {
    kind: 'executor_kind',
    id: 'executor_id',
    unknownReason: 'executor_unknown_reason',
  },
  // ⚠️ `authority_ref` 而不是 `authority_id`：它指向策略/能力，不是位次
  authority: {
    kind: 'authority_kind',
    id: 'authority_ref',
    unknownReason: 'authority_unknown_reason',
  },
  recordedBy: {
    kind: 'recorded_by_kind',
    id: 'recorded_by_id',
    unknownReason: 'recorded_by_unknown_reason',
  },
  contentOriginator: {
    kind: 'content_originator_kind',
    id: 'content_originator_id',
    unknownReason: 'content_originator_unknown_reason',
  },
}

/** 不参与槽位编码的四列：Axis B 三列 + origin（**Axis B 没有 Absent 态**） */
export const ATTRIBUTION_NON_SLOT_COLUMNS: readonly string[] = [
  'source_kind',
  'source_authority',
  'epistemic_source',
  'attribution_origin',
]

/** v7 追加列全集（18 个槽位列 + 4 个非槽位列 = **22 列/表**，Proposed-Schema §1.2） */
export const ATTRIBUTION_V7_COLUMNS: readonly string[] = [
  ...Object.values(ATTRIBUTION_SLOT_COLUMNS).flatMap((c) => [c.kind, c.id, c.unknownReason]),
  ...ATTRIBUTION_NON_SLOT_COLUMNS,
]

// ---------------------------------------------------------------------------
// 必要性矩阵（Proposed-Schema §3，Revision 2.1 冻结）
// ---------------------------------------------------------------------------

/**
 * 必要性矩阵的单元状态。
 *
 *     REQUIRED        ✓ 必需：必须被记录；`Absent` 违规，`Unknown(LEGACY_UNRECORDED)` 也违规
 *     ALLOWED_UNKNOWN ? 允许 Unknown：必须被"表态"，`Absent` 违规，Known / Unknown 都合法
 *     ABSENT          — 必须 Absent：**填具体值违规**（这是本设计的要害负控）
 *     DERIVED         派生：由 canonical owner 派生，不参与写入期必要性判定
 *
 * ⚠️ `REQUIRED` 允许 `Unknown(RUNTIME_UNRESOLVED)`（裁定 U-04：运行时确实定不下来时，
 *    如实说"定不下来"比填一个默认位次正确）。它**不允许** `Unknown(LEGACY_UNRECORDED)`
 *    —— "历史没记"是**回填行**的结论，不是一条新事件的合法状态。
 */
export type NecessityState = 'REQUIRED' | 'ALLOWED_UNKNOWN' | 'ABSENT' | 'DERIVED'

export const NECESSITY_STATES: readonly NecessityState[] = [
  'REQUIRED',
  'ALLOWED_UNKNOWN',
  'ABSENT',
  'DERIVED',
]

/** 一行矩阵（七个槽位各一格） */
export interface NecessityRow {
  subject: NecessityState
  initiator: NecessityState
  actor: NecessityState
  executor: NecessityState
  authority: NecessityState
  recordedBy: NecessityState
  contentOriginator: NecessityState
}

const row = (
  initiator: NecessityState,
  actor: NecessityState,
  executor: NecessityState,
  authority: NecessityState,
  recordedBy: NecessityState,
  contentOriginator: NecessityState
): NecessityRow => ({
  subject: 'DERIVED',
  initiator,
  actor,
  executor,
  authority,
  recordedBy,
  contentOriginator,
})

/**
 * **冻结矩阵**（`M5.1.1-Proposed-Schema.md` §3，Revision 2.1；含 §3.4 的两处修正）。
 *
 * 读法与要害：
 *   · `user_message.authority = ABSENT` —— 说话不需要许可
 *   · `user_message.executor  = ABSENT` —— 什么都没执行；填 `Known(USER)` 是**伪造**
 *   · `ACTION_REQUESTED.authority = ABSENT` —— **请求发生 ≠ 请求已获授权**（B5.1）
 *   · `ACTION_AUTHORIZED.authority = REQUIRED` —— 许可从请求事件搬到授权事件
 *     （`ACTION_AUTHORIZED` **已存在**于 `ActionEventType`，因此不需要新增生产事件）
 *   · 只读诊断 `authority = ABSENT`
 *   · 控制命令（U-03）：`initiator` / `actor` / `authority` / `recordedBy` 必需，
 *     `executor` / `contentOriginator` 不适用 —— 且**不得**伪装成普通角色行动
 */
export const NECESSITY_MATRIX: Readonly<Record<AttributionEventFamily, NecessityRow>> = {
  // 对话：说一句话不需要许可，也没有执行者
  user_message: row('ABSENT', 'REQUIRED', 'ABSENT', 'ABSENT', 'REQUIRED', 'ALLOWED_UNKNOWN'),
  assistant_message: row(
    'ABSENT',
    'REQUIRED',
    'ABSENT',
    'ABSENT',
    'REQUIRED',
    'ALLOWED_UNKNOWN'
  ),
  // K-21 / R-19（2026-09-18）：contentOriginator 由 ABSENT 改为 ALLOWED_UNKNOWN ——
  // 与回填分类的 `U` 对齐（`N ⟺ ABSENT` 必须**全局**成立，见 K-20 门的自洽性检查）。
  // "系统事件也可能有人提供内容"是必须能表达的；但**历史**没记 ⇒ 回填一律 Unknown(LEGACY_UNRECORDED)。
  system_event: row('REQUIRED', 'REQUIRED', 'ABSENT', 'ABSENT', 'REQUIRED', 'ALLOWED_UNKNOWN'),
  /*
   * 工具事件（K-3 FINAL，2026-09-18 裁定；WP2.1 同步）。
   *
   *     actor             = REQUIRED  谁**产生了这条 tool event**（TOOL/<tool-id>）
   *     contentOriginator = REQUIRED  谁**产生了这段工具输出内容**（TOOL/<tool-id>）
   *     executor          = ABSENT    conversations 里的工具事件**不是一次执行**
   *
   * 为什么 executor 是 Absent：真正的执行者身份由 **Action / Execution Ledger** 承担。
   * 在 conversation 的 tool_event 上再存一份 authoritative executor，会形成**第二个
   * Execution Truth 来源**。需要关联时走
   * `tool_event → actionId / executionId / traceId → 权威行动账本`，而不是复制 executor。
   * （K-3 裁定前，矩阵这里记的是 actor=ABSENT / executor=ALLOWED_UNKNOWN / contentOriginator=ABSENT，
   *  那与 ADR-042 D7 把 actor 与 contentOriginator 列为 conversation_events 必需槽位相冲突。）
   */
  tool_event: row('REQUIRED', 'REQUIRED', 'ABSENT', 'ABSENT', 'REQUIRED', 'REQUIRED'),
  // 行动：请求 ≠ 授权 ≠ 执行
  action_requested: row('REQUIRED', 'REQUIRED', 'ABSENT', 'ABSENT', 'REQUIRED', 'ABSENT'),
  action_authorized: row('REQUIRED', 'REQUIRED', 'ABSENT', 'REQUIRED', 'REQUIRED', 'ABSENT'),
  action_side_effect_execution: row(
    'REQUIRED',
    'REQUIRED',
    'ALLOWED_UNKNOWN',
    'REQUIRED',
    'REQUIRED',
    'ABSENT'
  ),
  action_read_only_diagnostic: row(
    'REQUIRED',
    'REQUIRED',
    'ABSENT',
    'ABSENT',
    'REQUIRED',
    'ABSENT'
  ),
  // 控制面（U-03）：必须进 durable authoritative audit ledger
  developer_control: row('REQUIRED', 'REQUIRED', 'ABSENT', 'REQUIRED', 'REQUIRED', 'ABSENT'),
  /*
   * 状态转移（M5.1.1 / WP9-B1，2026-09-18 用户裁定 **R-45 = SELECTED B**）。
   *
   *   initiator         = REQUIRED   系统自己发起了这次状态转移
   *   actor             = REQUIRED   谁**决定并施加**了这次转移（必须来自受信组件证据）
   *   executor          = ABSENT     今天不存在独立的执行者（"决定/施加"是同一个位次）
   *   authority         = REQUIRED   这是**真实的系统规则**（`SYSTEM_RULE/<state-bootstrap-rule>`，
   *                                  具体 ref 由 WP9-B2 冻结）
   *   recordedBy        = REQUIRED   canonical ledger recorder（`SYSTEM/kernel`）
   *   contentOriginator = ABSENT     状态转移**不是内容主张**（它不产生"谁说了这段话"）
   *
   * ⚠️ `executor = ABSENT` 是**结论**，不是占位：今天 `src/state/**` 里没有
   *    决定者/施加者的分离（`initCharacterState` 在一个函数里决定、施加、记账），
   *    所以独立执行者**不适用** —— **不许**为了"看起来完整"而填一个。
   *
   * ⚠️ 这条行的存在**不**授权任何槽位从"事件长什么样"推导出来：
   *    `SYSTEM` 只能来自**状态引导组件自己的受信身份**（见
   *    `STATE_TRANSITION_SYSTEM_ORIGIN_RULE`）。
   */
  state_transition: row('REQUIRED', 'REQUIRED', 'ABSENT', 'REQUIRED', 'REQUIRED', 'ABSENT'),
}

/**
 * **`state_transition` 的 SYSTEM 溯源规则**（R-45 的冻结语义；WP9-B1 写进契约，B2 接线）。
 *
 *     `Known(SYSTEM/<component>)` **只能**来自状态引导组件**自己的受信身份**。
 *
 * 明确**禁止**的推导来源（每一条都必须在 WP9-B1 的门里被负控覆盖）：
 *
 *     `trigger = 'init'`            ✗ "首启" 不是 "系统是谁"
 *     `state_event` / `state_transition` 族名（或表名）  ✗ 名字不是证据
 *     payload（before/delta/after/reason）  ✗ 数据不是发起者
 *     `actor_type`（legacy 列）      ✗ 归属**声明**不是作者**证明**（M5.1-D01）
 *     `requestedBy`                 ✗ 请求方自报
 *     transport（CLI / HTTP / 进程内）  ✗ 通道不是身份
 *
 * B1（本步）落地的是**能力**与**边界**：写入路径只接受**已受信**的可选信封
 * （`TrustedAttribution`，带 `TRUSTED_INGRESS_MARK`），并复用canonical 必要性校验；
 * 真正的生产者（把组件身份装进信封的那一半）是 **WP9-B2** 的 `src/state/init.ts` 接线。
 */
export const STATE_TRANSITION_SYSTEM_ORIGIN_RULE =
  'Known(SYSTEM/<component>) 只能来自状态引导组件的受信身份；不得由 trigger / 族名 / payload / ' +
  'actor_type / requestedBy / transport 推导（R-45，WP9-B1）'

/** 矩阵的出处（写进证据，免得日后有人以为它是随手写的） */
export const NECESSITY_MATRIX_SOURCE =
  'M5.1.1-Proposed-Schema.md §3（Revision 2.1 冻结矩阵；§3.4 的两处修正已含）'

/**
 * **矩阵的裁定记录**（不是"差异"，是"已经裁定的历史冲突"）。
 *
 * 每一条都记：哪个族 / 哪个槽位 / 旧值 / 新值 / 为什么 / 谁裁的。
 * 保留它是因为**旧矩阵曾经是文档里的事实**——不记下来，下一个人会重新发现这个冲突，
 * 或者更糟：从旧文档里读到旧值，然后把它当实现真相（用户原话："不得让旧的冲突矩阵
 * 静默变成实现真相"）。
 */
export const NECESSITY_MATRIX_RULINGS: readonly {
  family: AttributionEventFamily
  slot: AttributionValueSlot
  before: NecessityState
  after: NecessityState
  reason: string
  decidedBy: string
}[] = [
  {
    family: 'tool_event',
    slot: 'actor',
    before: 'ABSENT',
    after: 'REQUIRED',
    reason:
      'actor 回答"谁产生了这条 tool event"——那是 TOOL 自己，是结构事实，不是可选的',
    decidedBy: 'K-3 FINAL（用户 2026-09-18 裁定）',
  },
  {
    family: 'tool_event',
    slot: 'contentOriginator',
    before: 'ABSENT',
    after: 'REQUIRED',
    reason:
      'contentOriginator 回答"这段工具输出内容是谁产生的"——同样是 TOOL；' +
      '它与 actor 相同是**合法**的（ADR-042 B6：值相等不是违规，无证据推导才是）',
    decidedBy: 'K-3 FINAL（用户 2026-09-18 裁定）',
  },
  {
    family: 'tool_event',
    slot: 'executor',
    before: 'ALLOWED_UNKNOWN',
    after: 'ABSENT',
    reason:
      'conversation 里的工具事件**不是一次执行**；执行者身份归 Action / Execution Ledger，' +
      '在这里再存一份会形成第二个 Execution Truth 来源（关联走 actionId/executionId/traceId）',
    decidedBy: 'K-3 FINAL（用户 2026-09-18 裁定）',
  },
]

// ---------------------------------------------------------------------------
// K-22（WP4.1）—— Action attribution **不是** Cognitive Axis B（物理落地的语义侧）
// ---------------------------------------------------------------------------

/**
 * **`character_action_events` 的 Cognitive Axis B 不适用（N/A）** —— K-22 冻结语义。
 *
 * ============================================================================
 *  这是什么、不是什么
 * ============================================================================
 *   · 它是**全局**适用性判定：行动表上的 Axis B 三列**唯一**允许的取值是 NULL。
 *     （不是"逐行选择"，因此不需要第二个 marker 列。）
 *   · 它是**成文契约**：NULL 在本表上的含义被**显式定义**为"不适用"，
 *     而不是"还没记"/"未回填"/conversation 意义上的 `Absent`。
 *     物理侧由 `MIGRATION_0008` 的 `*_axis_b_not_applicable` CHECK **穷尽** ——
 *     没有第二种合法形状，所以 NULL 不可能有第二种读法。
 *   · 行动侧归因**照样**记：六个槽位（initiator / actor / executor / authority /
 *     recordedBy / contentOriginator）+ `attribution_origin` 全部照常可写可查，
 *     只是**不假装**自己是认知来源。
 *
 * ============================================================================
 *  禁止的方向（K-22 §2）
 * ============================================================================
 *  下列槽位**不得**推出 `SourceKind`：
 *
 *     initiator · actor · executor · authority · requestedBy
 *
 *  反例（每条都必须被检测器抓住，见 `FORBIDDEN_ACTION_AXIS_B_DERIVATIONS`）：
 *
 *     USER initiator   → user_statement      ✗
 *     CHARACTER actor  → character_output    ✗
 *     TOOL executor    → tool_output         ✗
 *
 *  `SourceKind` 的四个取值全部是**对话内容类别**；"一次行动"不在其中，
 *  而 `SOURCE_KIND_BY_EVENT_FAMILY` 的键**只有**对话四族（R-21 §2 已经冻结）。
 */
export const ACTION_AXIS_B_SEMANTICS = 'NOT_APPLICABLE' as const

/** 该语义的出处（写进证据，免得日后有人以为它是随手写的） */
export const ACTION_AXIS_B_SEMANTICS_SOURCE =
  'K-22（Action attribution is NOT Cognitive Axis B）+ MIGRATION_0008 ' +
  '(m5.1.1-k22-action-axis-b-not-applicable)；WP4.1 physical landing'

/**
 * **有** Cognitive Axis B 的事件族 —— 只有对话四族。
 *
 * ⚠️ 这不是"当前实现"，而是**边界本身**：行动族与 `developer_control`
 * 都不在这个列表里（`developer_control_events` 连 Axis B 列都没有）。
 */
export const COGNITIVE_AXIS_B_FAMILIES: readonly AttributionEventFamily[] = [
  'user_message',
  'assistant_message',
  'system_event',
  'tool_event',
]

/** 某个事件族是否有 Cognitive Axis B（行动族一律 `false`） */
export function isCognitiveAxisBApplicable(family: AttributionEventFamily): boolean {
  return (COGNITIVE_AXIS_B_FAMILIES as readonly string[]).includes(family)
}

/**
 * K-22 §2 的**禁止推导表**（机读）。
 *
 * 它记录的是"如果有人这样推导，检测器必须响"的三个具体反例。
 * ⚠️ 表里**没有**任何"允许的推导" —— 因为不存在：
 * 行动侧的 `SourceKind` 不是"推不出来"，而是**不适用**。
 */
export const FORBIDDEN_ACTION_AXIS_B_DERIVATIONS: readonly {
  readonly slot: AttributionValueSlot
  readonly principalKind: PrincipalKind
  readonly forbiddenSourceKind: SourceKind
  readonly note: string
}[] = [
  {
    slot: 'initiator',
    principalKind: 'USER',
    forbiddenSourceKind: 'user_statement',
    note: '"某人发起了这个动作"不等于"这是一条用户陈述"',
  },
  {
    slot: 'actor',
    principalKind: 'CHARACTER',
    forbiddenSourceKind: 'character_output',
    note: '"角色决定并产生了这条事件"不等于"这是角色输出内容"',
  },
  {
    slot: 'executor',
    principalKind: 'TOOL',
    forbiddenSourceKind: 'tool_output',
    note: '"工具执行了这个动作"不等于"这是一段工具观测输出"',
  },
]

/** 行动表的 Axis B 三格（物理列）；`null` = NULL */
export interface ActionAxisBCells {
  readonly sourceKind: string | null
  readonly sourceAuthority: string | null
  readonly epistemicSource: string | null
}

/** 行动行 Axis B 的违规（**不是** `NecessityViolation`：Axis B 不是七个槽位之一） */
export interface ActionAxisBViolation {
  column: 'source_kind' | 'source_authority' | 'epistemic_source'
  code: 'action_axis_b_must_be_not_applicable'
  detail: string
}

/**
 * 行动行 Axis B 的**双向**校验（纯函数）：
 *
 *   ① 不适用列被填了值 ⇒ 违规（"假装自己是认知来源"）
 *   ② 三列半填 ⇒ 违规（连"看起来像 Axis B"都不该存在）
 *
 * 正控：三列全 NULL（唯一合法形状）⇒ 0 违规。
 */
export function validateActionAxisB(cells: ActionAxisBCells): ActionAxisBViolation[] {
  const filled = (
    [
      ['source_kind', cells.sourceKind],
      ['source_authority', cells.sourceAuthority],
      ['epistemic_source', cells.epistemicSource],
    ] as const
  ).filter(([, value]) => value !== null && value !== undefined)

  if (filled.length === 0) return []
  return filled.map(([column, value]) => ({
    column,
    code: 'action_axis_b_must_be_not_applicable' as const,
    detail:
      `character_action_events 的 Cognitive Axis B 不适用（K-22）：'${column}' 必须为 NULL，` +
      `实际是 '${String(value)}'。行动侧的 initiator/actor/executor/authority/requestedBy ` +
      '不得推出任何 SourceKind（ACTION_AXIS_B_SEMANTICS = NOT_APPLICABLE）',
  }))
}

/** 失败关闭版本 */
export function assertActionAxisBNotApplicable(cells: ActionAxisBCells): void {
  const violations = validateActionAxisB(cells)
  if (violations.length === 0) return
  throw new KernelError(
    'validation_error',
    'action_axis_b_not_applicable',
    `行动行的 Cognitive Axis B 违规（K-22）：${violations.map((v) => v.detail).join(' · ')}`,
    { violations: violations.map((v) => v.detail) }
  )
}

// ---------------------------------------------------------------------------
// WP5（Action & Execution Attribution）—— 行动侧的受信归因
// ---------------------------------------------------------------------------
//
// 与对话侧（K-25 / K-26）**同一套纪律**，但四个槽位各有**独立的**受信来源：
//
//     initiator        ← 受信 ingress（这一次请求是怎么进来的）
//     actor            ← 决策点自己（gateway / policy：它对**这条事件**负责）
//     executor         ← 执行器适配器边界（**真的**被交给执行时才产出）
//     authority        ← 策略结论（这一次执行凭的是什么）
//     recordedBy       ← canonical ledger writer（构造器自己写，调用方给不了）
//     contentOriginator→ 恒 Absent（行动不是内容断言）
//
// 五者**不互相推导**：一次调用同时给五份证据，缺一份不会用另一份顶上
// （必要性矩阵会直接判违规 —— 见 `buildTrustedActionAttribution`）。

/**
 * 九个动作事件类型 → **冻结的必要性族**（`NECESSITY_MATRIX` 的行）。
 *
 * ⚠️ 这不是"第二张必要性矩阵"：这里**没有**任何 REQUIRED / ABSENT 判定，
 * 只有"这个事件类型属于哪一行"。真正的判据仍然只有一处 —— `NECESSITY_MATRIX`。
 * 本表的每一条都能被 §3.3 的 D/P/U/N 分类**机器核对**（`N ⟺ ABSENT`）：
 * `pnpm m5.1.1:wp5:verify` 逐格断言这件事。
 *
 * 三处不显然的对应（都有 §3.3 的依据）：
 *   · `ACTION_TARGET_RESOLVED` → `action_requested`：它仍属"请求阶段"
 *     （§3.3：initiator P / actor U / executor N / authority N）
 *   · `ACTION_REJECTED` → `action_requested`：**被拒 = 未获授权**
 *     （§3.3：authority = **N**；WP5 任务书 §WP5-6 原文："ACTION_REJECTED.authority = Absent"）
 *   · `ACTION_STARTED` 及全部执行终态 → `action_side_effect_execution`
 *     （§3.3：executor U / authority U）
 */
export const ACTION_ATTRIBUTION_FAMILY_BY_EVENT_TYPE: Readonly<
  Record<string, AttributionEventFamily>
> = {
  ACTION_REQUESTED: 'action_requested',
  ACTION_TARGET_RESOLVED: 'action_requested',
  ACTION_AUTHORIZED: 'action_authorized',
  ACTION_REJECTED: 'action_requested',
  ACTION_STARTED: 'action_side_effect_execution',
  ACTION_SUCCEEDED: 'action_side_effect_execution',
  ACTION_FAILED: 'action_side_effect_execution',
  ACTION_PARTIAL: 'action_side_effect_execution',
  ACTION_CANCELLED: 'action_side_effect_execution',
}

export const ACTION_ATTRIBUTION_FAMILY_SOURCE =
  'WP5 §WP5-6 + Migration-Strategy §3.3（逐事件类型 D/P/U/N 的 N ⟺ ABSENT 交叉核对）'

/** 事件类型 → 必要性族（未知类型 fail closed，不猜） */
export function actionAttributionFamilyOf(eventType: string): AttributionEventFamily {
  const family = ACTION_ATTRIBUTION_FAMILY_BY_EVENT_TYPE[eventType]
  if (family === undefined) {
    throw new KernelError(
      'validation_error',
      'unknown_action_event_type',
      `动作事件类型 ${eventType} 没有冻结的必要性族 —— 不猜（ACTION_ATTRIBUTION_FAMILY_BY_EVENT_TYPE）`
    )
  }
  return family
}

/** 行动侧位次证据（initiator / actor / executor 同一形状，但**各自独立构造**） */
export interface TrustedActionPrincipalEvidence extends TrustedEvidenceBase {
  readonly principal: PrincipalRef | null
  readonly unresolvedReason?: UnknownReason
}

/** 行动侧许可证据（authority 是 `AuthorityRef`，**不是**位次） */
export interface TrustedActionAuthorityEvidence extends TrustedEvidenceBase {
  readonly authority: AuthorityRef | null
  readonly unresolvedReason?: UnknownReason
}

/**
 * ============================================================================
 *  K-27（WP5.1）—— initiator 是**因果来源**，不是**呈现角色**
 * ============================================================================
 *
 * `initiator` = **真正提出 / 造成 / 触发**这次动作的那个位次。
 *
 * ```text
 *   speaker / presented role（ActionTurnInput.speaker、actor_type、requestedBy payload）
 *     ⇒ 只够做：legacy 行为 / 呈现 / 兼容 / 路由
 *     ⇒ **不**够做：Known(USER/…) / Known(CHARACTER/…) / Known(SYSTEM/…) / Known(TOOL/…)
 * ```
 *
 * 因此本模块**没有**"从呈现角色构造 initiator"的构造器（WP5 的
 * `attestActionInitiatorFromIngress` 已在 WP5.1 被**删除**）。
 * 只有两个入口，而且它们都不能凭"呈现角色"给出一个具体位次：
 *
 *   ① `attestActionInitiatorFromCausalOrigin()` —— 从**因果上下文**：
 *      一条**已经受信**的触发事件（由账本受信读者读回来的那一行）的权威归因。
 *   ② `attestActionInitiatorUnresolved()` —— ingress 如实说"我没有因果上下文"。
 *
 * `TriggeringConversationEvent` 是**关联边界**（correlation boundary）的形状：
 * 它只搬运触发事件**当时记录的**事实，不做任何推导。
 */
export interface TriggeringConversationEvent {
  /** 触发这次动作的那条 conversation event 的 id（受信读者给出的那一行） */
  readonly eventId: string
  readonly type: ConversationFamily
  /** 那一行的 `attribution_origin`；没有信封时是 `null`（历史行） */
  readonly attributionOrigin: 'RECORDED' | 'MIGRATED_LEGACY' | null
  /** **RECORDED 行**才有；逐字来自读回的信封（不去推断、不去补默认值） */
  readonly actor?: AttributionValue<PrincipalRef>
  readonly contentOriginator?: AttributionValue<PrincipalRef>
}

/** 唯一允许的关联边界（不是"任意两个账本之间的通用换算"） */
export const CAUSAL_CORRELATION_BOUNDARY = 'conversation_turn_triggered_action' as const
export type CausalCorrelationBoundary = typeof CAUSAL_CORRELATION_BOUNDARY

/**
 * 受信读者产出的**因果来源**句柄（不透明 token）。
 *
 * ⚠️ 它**不是**"conversation 的 attribution 到 action 的通用投影"：
 *    它只描述"这一次动作是被**哪一条** conversation event 触发的"，
 *    并且把那条事件当时记录的 `actor` / `contentOriginator` 原样带过来。
 */
export interface TrustedCausalSource extends TrustedEvidenceBase {
  readonly correlation: CausalCorrelationBoundary
  readonly eventId: string
  readonly eventFamily: ConversationFamily
  readonly attributionOrigin: string | null
  readonly actor: AttributionValue<PrincipalRef> | null
  readonly contentOriginator: AttributionValue<PrincipalRef> | null
}

/**
 * 从一条**受信读者读回来的** conversation event 取因果上下文。
 *
 * 这是 WP5.1 §3 要求的"显式关联边界"：只搬运事实，**不**做 `contentOriginator → initiator`
 * 的通用映射（映射发生在下一步的构造器里，而且是带条件的）。
 */
export function triggeringConversationEventOf(input: {
  readonly id: string
  readonly type: string
  readonly attribution?: {
    readonly attributionOrigin: 'RECORDED'
    readonly slots: Readonly<Record<string, unknown>>
  }
}): TriggeringConversationEvent {
  const slots = input.attribution?.slots
  const actor = slots?.actor as AttributionValue<PrincipalRef> | undefined
  const contentOriginator = slots?.contentOriginator as AttributionValue<PrincipalRef> | undefined
  return {
    eventId: input.id,
    type: input.type as ConversationFamily,
    attributionOrigin: input.attribution?.attributionOrigin ?? null,
    ...(actor !== undefined ? { actor } : {}),
    ...(contentOriginator !== undefined ? { contentOriginator } : {}),
  }
}

/** 因果来源的证据 token（只有本模块能产出） */
export function correlationSourceFromConversationEvent(input: {
  adapterId: string
  triggeringEvent: TriggeringConversationEvent
}): TrustedCausalSource {
  return registerEvidence({
    [TRUSTED_EVIDENCE_BRAND]: 'trusted-attestation-evidence',
    adapterId: input.adapterId,
    correlation: CAUSAL_CORRELATION_BOUNDARY,
    eventId: input.triggeringEvent.eventId,
    eventFamily: input.triggeringEvent.type,
    attributionOrigin: input.triggeringEvent.attributionOrigin,
    actor: input.triggeringEvent.actor ?? null,
    contentOriginator: input.triggeringEvent.contentOriginator ?? null,
  })
}

/**
 * initiator 的**因果判据**（写进证据，便于事后回答"凭什么说是他"）。
 *
 *   recorded_actor_and_content_originator_agree  两个权威槽位**同时**指向同一位次
 *   not_recorded                                 触发事件没有权威归因（历史行 / 没记）
 *   slots_disagree                               两个槽位指向不同的位次 ⇒ 有歧义
 *   slot_not_known                               至少一个槽位不是 Known（Unknown / Absent）
 */
export type ActionInitiatorCausalBasis =
  | 'recorded_actor_and_content_originator_agree'
  | 'not_recorded'
  | 'slots_disagree'
  | 'slot_not_known'
  /*
   * ADR-098（Lv4.5 `P3` 选项 B）：**具名豁免**（用户 2026-10-05 裁定）。
   *
   * ⚠️ **只追加**：既有四个成员的语义一个字节都没改。这一档的含义是
   *    "这次动作**没有**因果上下文，但它属于一条**具名**的、闭集的、被判定点收窄的豁免"。
   *    它与 `not_recorded` 的区别是**有名字**；与因果证据的区别是**没有触发事件**。
   */
  | 'named_exemption'

export interface TrustedActionInitiatorEvidence extends TrustedActionPrincipalEvidence {
  readonly causalBasis: ActionInitiatorCausalBasis
  readonly causalEventId: string | null
}

/**
 * **从因果上下文**构造 initiator 证据（K-27 的唯一"能给 Known"的入口）。
 *
 * 它回答的问题只有一个：
 *
 * ```text
 *   "我们有没有证据表明**这个位次真的造成/触发了**这次动作请求？"
 *     YES  ⇒ Known(principal)
 *     NO / 有歧义 ⇒ Unknown(RUNTIME_UNRESOLVED)
 * ```
 *
 * 判据是**两个权威槽位的合取**（不是把某一个槽位映射过来）：
 * 触发事件必须是 `attribution_origin = 'RECORDED'`，而且它当时记录的
 * `actor` 与 `contentOriginator` **都是 Known、且指向同一个位次**。
 * 任一条件不满足 ⇒ 如实返回 `Unknown(RUNTIME_UNRESOLVED)`，**绝不**退回呈现角色。
 */
export function attestActionInitiatorFromCausalOrigin(input: {
  adapterId: string
  causalSource: TrustedCausalSource
}): TrustedActionInitiatorEvidence {
  if (!isTrustedAttestationEvidence(input.causalSource)) {
    throw new KernelError(
      'validation_error',
      'untrusted_causal_source',
      'causalSource 不是受信证据（手写对象 / 结构克隆 / JSON 往返都不算 —— WP5.1 §6）'
    )
  }
  if (input.causalSource.correlation !== CAUSAL_CORRELATION_BOUNDARY) {
    throw new KernelError(
      'validation_error',
      'unknown_correlation_boundary',
      `未知的关联边界：${String(input.causalSource.correlation)}`
    )
  }

  const actor = input.causalSource.actor
  const originator = input.causalSource.contentOriginator
  const recorded = input.causalSource.attributionOrigin === 'RECORDED'
  const actorValue = actor !== null && actor.state === 'KNOWN' ? actor.value : null
  const originatorValue = originator !== null && originator.state === 'KNOWN' ? originator.value : null

  let causalBasis: ActionInitiatorCausalBasis
  if (!recorded || actor === null || originator === null) causalBasis = 'not_recorded'
  else if (actorValue === null || originatorValue === null) causalBasis = 'slot_not_known'
  else if (!principalRefEquals(actorValue, originatorValue)) causalBasis = 'slots_disagree'
  else causalBasis = 'recorded_actor_and_content_originator_agree'

  const principal =
    causalBasis === 'recorded_actor_and_content_originator_agree' ? actorValue : null

  return registerEvidence({
    [TRUSTED_EVIDENCE_BRAND]: 'trusted-attestation-evidence',
    adapterId: input.adapterId,
    principal,
    causalBasis,
    causalEventId: input.causalSource.eventId,
    ...(principal === null ? { unresolvedReason: 'RUNTIME_UNRESOLVED' as UnknownReason } : {}),
  })
}

/**
 * ingress 如实说"这次没有因果上下文"（例如动作不是由某一轮对话触发的）。
 *
 * 它**不**接受任何位次参数 —— 因此它在结构上不可能把呈现角色洗成权威 initiator。
 */
export function attestActionInitiatorUnresolved(input: {
  adapterId: string
  reason?: UnknownReason
}): TrustedActionInitiatorEvidence {
  return registerEvidence({
    [TRUSTED_EVIDENCE_BRAND]: 'trusted-attestation-evidence',
    adapterId: input.adapterId,
    principal: null,
    unresolvedReason: input.reason ?? ('RUNTIME_UNRESOLVED' as UnknownReason),
    causalBasis: 'not_recorded' as ActionInitiatorCausalBasis,
    causalEventId: null,
  })
}

/** **决策点**对这条事件负责（gateway / policy）—— 与 initiator 是两份独立证据 */
export function attestActionActorFromDecisionPoint(input: {
  adapterId: string
  principal: PrincipalRef | null
  unresolvedReason?: UnknownReason
}): TrustedActionPrincipalEvidence {
  return registerEvidence({
    [TRUSTED_EVIDENCE_BRAND]: 'trusted-attestation-evidence',
    adapterId: input.adapterId,
    principal: input.principal,
    ...(input.unresolvedReason !== undefined ? { unresolvedReason: input.unresolvedReason } : {}),
  })
}

/**
 * ============================================================================
 *  ADR-098 —— **具名**归因豁免的**闭集**（Lv4.5 `P3` 选项 B）
 * ============================================================================
 * 用户 2026-10-05 裁定"给它一个具名的归因豁免"。设计要点**全在这个表里**：
 *
 * ```text
 * ① 闭集：再加一条豁免 = 改这张表 = 一处**可见的 diff**（不是加个参数就能绕过）
 * ② 每一条都声明：身份（principal）· 能力 · 操作 · 副作级别 · 依据（basis）
 * ③ 判定点（gateway）按这张表**复核**请求 —— 收窄不是调用点的自觉
 * ```
 *
 * ⚠️ `principal` 记的是**系统侧**具名身份，**不是**"他就是用户"：
 *    用户要求是这条豁免的 `basis`（依据），**不**洗成受信用户位次。
 */
export const ACTION_ATTRIBUTION_EXEMPTIONS = {
  pre_turn_lookup: {
    /** 账本里记的发起人就是这个身份（可查、可审计，而不是"未知") */
    principal: { kind: 'SYSTEM', id: 'pre-turn-lookup' },
    capability: 'web.search',
    operation: 'search',
    /**
     * ⚠️ **只读**是这条豁免能被接受的前提之一，且由判定点**复核**（见 gateway）。
     *    写/破坏性操作**一律**不接受这条豁免。
     */
    sideEffect: 'read',
    /** 依据：用户原话里**显式**要求联网查证（只读、推测性） */
    basis: 'user_explicit_request_read_only_speculative',
  },
  /**
   * ==========================================================================
   *  post-Lv2 / ADR-110 `D05a`：**主动投递**（这是闭集里第一条**写**豁免）
   * ==========================================================================
   * 为什么必须有它：主动联系**没有因果轮次上下文**（它是定时器到点触发的），
   * 老实说就是"没有因果上下文" ⇒ 网关失败关闭（`action_attribution_evidence_missing`）。
   * 而它又是一件**写**的事，所以 ADR-098 那条只读豁免**结构上**用不了。
   *
   * ⚠️ 收窄到**一个三元组**（主体 / 能力 / 操作），且必须由判定点复核：
   * ```text
   * 主体   SYSTEM/qq-proactive-scheduler   —— 调度器，不是用户、不是模型
   * 能力   qq.private.message              —— 只发文字给已绑定的本人
   * 操作   send
   * 副作   write                           —— ⚠️ 见 WRITE_CAPABLE_EXEMPTIONS 的说明
   * ```
   * ⚠️ 它**不**把"用户以前要求过"洗成受信用户位次：`basis` 说的是
   *    "系统排的一条提醒到点了"，这条豁免给的是**系统侧具名身份**。
   */
  proactive_qq_delivery: {
    principal: { kind: 'SYSTEM', id: 'qq-proactive-scheduler' },
    capability: 'qq.private.message',
    operation: 'send',
    sideEffect: 'write',
    basis: 'system_scheduled_reminder_due',
  },
  scheduled_local_reminder_delivery: {
    principal: { kind: 'SYSTEM', id: 'local-reminder-scheduler' },
    capability: 'local.reminder.message', operation: 'send', sideEffect: 'write', basis: 'system_scheduled_reminder_due',
  },
} as const satisfies Record<
  string,
  {
    principal: PrincipalRef
    capability: string
    operation: string
    sideEffect: string
    basis: string
  }
>

/**
 * ⚠️ **允许声明写副作用的豁免名字**（`ADR-110` `D05a`）。
 *
 * ```text
 * 加一条豁免 = 改 ACTION_ATTRIBUTION_EXEMPTIONS   —— 一处 diff
 * 让豁免能写 = 还要把名字加进**这张表**           —— 第二处 diff（**刻意**的两道）
 * ```
 * 这样"声明 `sideEffect: 'write'`"本身**不构成**许可：默认仍是只读，
 * 写豁免必须被**逐个点名**。ADR-098 的"收窄不是调用点的自觉"因此原样成立。
 */
export const WRITE_CAPABLE_ATTRIBUTION_EXEMPTIONS: readonly string[] = ['proactive_qq_delivery', 'scheduled_local_reminder_delivery']

/** 具名豁免的名字（闭集的键） */
export type ActionAttributionExemptionName = keyof typeof ACTION_ATTRIBUTION_EXEMPTIONS

/** 这条名字在不在闭集里（判定点用；`false` ⇒ 具名拒绝） */
export function isActionAttributionExemptionName(value: unknown): value is ActionAttributionExemptionName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ACTION_ATTRIBUTION_EXEMPTIONS, value)
}

/**
 * **具名豁免**构造 initiator 证据（ADR-098 的第三个入口）。
 *
 * ⚠️ 它**只**接受闭集里的名字 —— 传一个自由字符串是**具名拒绝**，
 *    而不是"造一条没有名字的匿名豁免"（那正好会把这条设计的意义抹掉）。
 * ⚠️ 它给的是 `SYSTEM/<名>`：**具名**，但**不是**受信用户；`causalEventId` 为 `null`
 *    （确实没有触发事件，不伪造一个 id）。
 */
export function attestActionInitiatorFromNamedExemption(input: {
  adapterId: string
  exemption: ActionAttributionExemptionName
}): TrustedActionInitiatorEvidence {
  if (!isActionAttributionExemptionName(input.exemption)) {
    throw new KernelError(
      'validation_error',
      'unknown_attribution_exemption',
      `未知的归因豁免：${String(input.exemption)}（豁免是**闭集**，见 ADR-098）`
    )
  }
  const entry = ACTION_ATTRIBUTION_EXEMPTIONS[input.exemption]
  return registerEvidence({
    [TRUSTED_EVIDENCE_BRAND]: 'trusted-attestation-evidence',
    adapterId: input.adapterId,
    principal: entry.principal,
    causalBasis: 'named_exemption' as ActionInitiatorCausalBasis,
    causalEventId: null,
  })
}

/**
 * ADR-098 §3：**具名豁免的收窄判据**（纯函数 ⇒ 可以拿构造输入做正控/负控）。
 *
 * 判定点（gateway）在归因解析处调用它；返回 `undefined` = 这条豁免**落点合法**。
 *
 * ```text
 * ① principal 必须在闭集里（`null` 也不行 —— 那就是匿名逃生门）
 * ② 能力 + 操作必须与声明**逐字相同**
 * ③ 声明的副作级别必须是 `read`，且**实际登记**的那个操作也必须是 `read`
 * ```
 * ⚠️ 它只**判定**、不抛错：抛错留给调用点（判定点要保持"失败关闭"的一致形状），
 *    而纯函数才可以被门用**构造输入**逐条验证。
 */
export function namedExemptionViolation(input: {
  principal: PrincipalRef | null
  capability: string
  operation: string
  /** 实际登记表里那个操作的副作级别（`undefined` = 没登记） */
  registeredSideEffect: string | undefined
}): { code: string; detail: string } | undefined {
  if (input.principal === null) {
    return {
      code: 'attribution_exemption_without_principal',
      detail: '具名豁免必须带一个具名身份（principal 为 null 的"豁免"就是匿名逃生门，ADR-098）',
    }
  }
  const matched = Object.entries(ACTION_ATTRIBUTION_EXEMPTIONS).find(
    ([, scope]) => scope.principal.kind === input.principal?.kind && scope.principal.id === input.principal?.id
  )
  if (matched === undefined) {
    return {
      code: 'unregistered_attribution_exemption',
      detail: `身份 ${input.principal.kind}/${input.principal.id} 不在归因豁免闭集里（ADR-098）`,
    }
  }
  const [name, scope] = matched
  if (scope.capability !== input.capability || scope.operation !== input.operation) {
    return {
      code: 'attribution_exemption_scope_mismatch',
      detail:
        `豁免 ${name} 只对 ${scope.capability}/${scope.operation} 有效，` +
        `本次是 ${input.capability}/${input.operation}`,
    }
  }
  if (input.registeredSideEffect === undefined || input.registeredSideEffect !== scope.sideEffect) {
    return {
      code: 'attribution_exemption_not_read_only',
      detail: `豁免 ${name} 声明 ${scope.sideEffect}，登记 ${String(input.registeredSideEffect)} —— 两者必须逐字相同`,
    }
  }
  /*
   * ⚠️ 默认**只读**（ADR-098 原样）；写豁免必须**逐个点名**（ADR-110 `D05a`）。
   *    于是"自己声明一个 write 豁免"这条捷径在结构上不存在 ——
   *    它需要**两次**可见的 diff（登记表 + 这张白名单）。
   */
  if (scope.sideEffect !== 'read' && !WRITE_CAPABLE_ATTRIBUTION_EXEMPTIONS.includes(name)) {
    return {
      code: 'attribution_exemption_not_read_only',
      detail: `豁免 ${name} 声明了 ${scope.sideEffect}，但它不在写豁免白名单里（ADR-098 默认只读）`,
    }
  }
  return undefined
}

/**
 * 这条证据是不是**具名豁免**（ADR-098 §3 的收窄复核入口）。
 *
 * ⚠️ 为什么要有这个守卫、而不是把 `ActionInvocationContext.initiatorEvidence` 改窄成
 *    `TrustedActionInitiatorEvidence`：后者会波及 M5.1.1 **已冻结**的门脚本
 *    （它们按基类型构造夹具）。守卫把唯一一处断言收在本模块里，
 *    判定点因此不需要散落 `as`。
 */
export function isNamedExemptionInitiatorEvidence(
  evidence: TrustedActionPrincipalEvidence
): evidence is TrustedActionInitiatorEvidence & { readonly causalBasis: 'named_exemption' } {
  return (evidence as { causalBasis?: unknown }).causalBasis === 'named_exemption'
}

/**
 * **执行器边界**的鉴证：只有当适配器**真的**被交给执行时才产出。
 *
 * WP5-9：它的存在**不**证明"执行成功了" —— 执行真相仍然只由事件类型与状态表达。
 */
export function attestActionExecutorFromAdapter(input: {
  adapterId: string
  principal: PrincipalRef | null
  unresolvedReason?: UnknownReason
}): TrustedActionPrincipalEvidence {
  return registerEvidence({
    [TRUSTED_EVIDENCE_BRAND]: 'trusted-attestation-evidence',
    adapterId: input.adapterId,
    principal: input.principal,
    ...(input.unresolvedReason !== undefined ? { unresolvedReason: input.unresolvedReason } : {}),
  })
}

/** **策略结论**提供的许可依据（capability / policy / system rule / consent / break-glass） */
export function attestActionAuthorityFromPolicy(input: {
  adapterId: string
  authority: AuthorityRef | null
  unresolvedReason?: UnknownReason
}): TrustedActionAuthorityEvidence {
  return registerEvidence({
    [TRUSTED_EVIDENCE_BRAND]: 'trusted-attestation-evidence',
    adapterId: input.adapterId,
    authority: input.authority,
    ...(input.unresolvedReason !== undefined ? { unresolvedReason: input.unresolvedReason } : {}),
  })
}

/**
 * 一次动作事件**在当时**已确立的归因快照（WP5-5：阶段不可变）。
 *
 * 它**不**携带 Axis B（行动侧恒不适用，K-22），也**不**携带 `contentOriginator`
 * 的取值（恒 `Absent`）—— 这两个"恒定的东西"由构造器与 store 各自断言，
 * 不给调用方任何传入口。
 */
export interface TrustedActionAttributionContext {
  readonly eventType: string
  readonly family: AttributionEventFamily
  readonly subject: PrincipalRef
  readonly initiator: AttributionValue<PrincipalRef>
  readonly actor: AttributionValue<PrincipalRef>
  readonly executor: AttributionValue<PrincipalRef>
  readonly authority: AuthorityValue
  readonly recordedBy: AttributionValue<PrincipalRef>
  /** 恒 `Absent`（行动不是内容断言）—— 写出来是为了让读侧不用猜 */
  readonly contentOriginator: AttributionValue<PrincipalRef>
  readonly attributionOrigin: 'RECORDED'
  readonly evidence: {
    initiatorAdapterId: string
    actorAdapterId: string
    executorAdapterId: string | null
    authorityAdapterId: string | null
  }
}

/** 上下文 → 统一信封（六个槽位 + origin），供必要性校验与持久化使用 */
export function actionAttributionEnvelopeOf(
  context: TrustedActionAttributionContext
): AttributionEnvelope {
  return {
    subject: context.subject,
    initiator: context.initiator,
    actor: context.actor,
    executor: context.executor,
    authority: context.authority,
    recordedBy: context.recordedBy,
    contentOriginator: context.contentOriginator,
    attributionOrigin: context.attributionOrigin,
  }
}

const REGISTERED_ACTION_CONTEXTS = new WeakSet<object>()

/** 只有本模块 `buildTrustedActionAttribution()` 产出过的上下文才算数（WP5-2） */
export function isTrustedActionAttributionContext(value: unknown): boolean {
  return typeof value === 'object' && value !== null && REGISTERED_ACTION_CONTEXTS.has(value)
}

function freezeOptionalPrincipal(
  value: AttributionValue<PrincipalRef>
): AttributionValue<PrincipalRef> {
  if (value.state === 'KNOWN') Object.freeze(value.value)
  return Object.freeze(value)
}

/**
 * 构造**受信行动归因**（WP5 §WP5-1 / §WP5-2 / §WP5-5）。
 *
 * 入参里**没有** `recordedBy` / `contentOriginator` / `attributionOrigin` /
 * `sourceKind` 一类字段 ⇒ 调用方在类型层就**无法**自报它们（K-25 的同一形状）。
 *
 * `executorEvidence` / `authorityEvidence` 是**可选**的，但"可选"不等于"可以乱给"：
 * 该给而不给 ⇒ 矩阵判 `required_slot_absent`；不该给却给了 ⇒ 判
 * `absent_slot_filled_concrete`。**两个方向都失败关闭**。
 */
export function buildTrustedActionAttribution(input: {
  eventType: string
  characterId: string
  initiatorEvidence: TrustedActionPrincipalEvidence
  actorEvidence: TrustedActionPrincipalEvidence
  executorEvidence?: TrustedActionPrincipalEvidence
  authorityEvidence?: TrustedActionAuthorityEvidence
}): TrustedActionAttributionContext {
  for (const [role, evidence] of [
    ['initiatorEvidence', input.initiatorEvidence],
    ['actorEvidence', input.actorEvidence],
    ['executorEvidence', input.executorEvidence],
    ['authorityEvidence', input.authorityEvidence],
  ] as const) {
    if (evidence !== undefined && !isTrustedAttestationEvidence(evidence)) {
      throw new KernelError(
        'validation_error',
        'untrusted_attestation_evidence',
        `${role} 不是受信证据（手写对象 / 结构克隆 / JSON 往返都不算 —— WP5-2）`
      )
    }
  }
  if (input.initiatorEvidence === undefined || input.actorEvidence === undefined) {
    throw new KernelError(
      'validation_error',
      'action_attribution_evidence_missing',
      'initiator 与 actor 的证据**都必须**由受信来源产出（不得由同一份证据兼任 —— WP5-1）'
    )
  }

  const family = actionAttributionFamilyOf(input.eventType)
  const initiator = principalToValue(
    input.initiatorEvidence.principal,
    input.initiatorEvidence.unresolvedReason
  )
  const actor = principalToValue(input.actorEvidence.principal, input.actorEvidence.unresolvedReason)
  const executor =
    input.executorEvidence === undefined
      ? attributionAbsent<PrincipalRef>()
      : principalToValue(input.executorEvidence.principal, input.executorEvidence.unresolvedReason)
  const authority =
    input.authorityEvidence === undefined
      ? attributionAbsent<AuthorityRef>()
      : input.authorityEvidence.authority !== null
        ? attributionKnown<AuthorityRef>(input.authorityEvidence.authority)
        : input.authorityEvidence.unresolvedReason === undefined
          ? attributionAbsent<AuthorityRef>()
          : attributionUnknown<AuthorityRef>(input.authorityEvidence.unresolvedReason)

  const envelope: AttributionEnvelope = {
    subject: { kind: 'CHARACTER', id: input.characterId } as PrincipalRef,
    initiator,
    actor,
    executor,
    authority,
    recordedBy: attributionKnown<PrincipalRef>({
      kind: CANONICAL_LEDGER_RECORDER.kind as PrincipalRef['kind'],
      id: CANONICAL_LEDGER_RECORDER.id,
    }),
    contentOriginator: attributionAbsent<PrincipalRef>(),
    attributionOrigin: 'RECORDED',
  }

  // 冻结的必要性矩阵是**唯一**判据（WP5 §WP5-6）
  assertAttributionNecessity({ family, envelope })

  const context: TrustedActionAttributionContext = Object.freeze({
    eventType: input.eventType,
    family,
    subject: Object.freeze(envelope.subject),
    initiator: freezeOptionalPrincipal(initiator),
    actor: freezeOptionalPrincipal(actor),
    executor: freezeOptionalPrincipal(executor),
    authority: Object.freeze(authority),
    recordedBy: freezeOptionalPrincipal(envelope.recordedBy),
    contentOriginator: Object.freeze(envelope.contentOriginator),
    attributionOrigin: 'RECORDED' as const,
    evidence: Object.freeze({
      initiatorAdapterId: input.initiatorEvidence.adapterId,
      actorAdapterId: input.actorEvidence.adapterId,
      executorAdapterId: input.executorEvidence?.adapterId ?? null,
      authorityAdapterId: input.authorityEvidence?.adapterId ?? null,
    }),
  })
  REGISTERED_ACTION_CONTEXTS.add(context)
  return context
}

/** 上下文必须描述的**就是**这条事件（失败关闭；与对话侧的族校验同形） */
export function assertActionAttributionMatchesEvent(
  context: TrustedActionAttributionContext,
  input: { eventType: string; characterId: string }
): void {
  if (!isTrustedActionAttributionContext(context)) {
    throw new KernelError(
      'validation_error',
      'untrusted_action_attribution_context',
      'attribution 不是受信构造器产出的上下文（手写对象 / 结构克隆 / JSON 往返都不算 —— WP5-2）'
    )
  }
  if (context.eventType !== input.eventType) {
    throw new KernelError(
      'validation_error',
      'action_attribution_event_type_mismatch',
      `受信行动归因描述的是 ${context.eventType}，但事件类型是 ${input.eventType}`
    )
  }
  if (context.subject.id !== input.characterId) {
    throw new KernelError(
      'validation_error',
      'action_attribution_subject_mismatch',
      '受信行动归因的 subject 必须由本事件的 canonical domain context 派生（characterId 不一致）'
    )
  }
}

// ---------------------------------------------------------------------------
// 契约级 validator（纯函数，失败关闭）
// ---------------------------------------------------------------------------

export type NecessityViolationCode =
  /** 必需槽位缺失（Absent） */
  | 'required_slot_absent'
  /** 必需槽位写成了"历史没记" —— 新事件不允许这个理由 */
  | 'required_slot_legacy_unrecorded'
  /** **不适用槽位被填了具体值**（要害负控） */
  | 'absent_slot_filled_concrete'
  /** 不适用槽位被填了 Unknown（"这个概念不适用"却给它记了个未知） */
  | 'absent_slot_filled_unknown'
  /** 派生槽位（subject）缺失或形状非法 */
  | 'subject_missing'
  /** 位次种类不在受控词汇里（类型擦除后的运行时兜底） */
  | 'unknown_principal_kind'
  /** 许可种类不在受控词汇里 */
  | 'unknown_authority_kind'
  /** unknown_reason 不在受控词汇里 */
  | 'unknown_unknown_reason'
  /** 三态被写成了"既像 A 又像 B"的混合形状 */
  | 'invalid_mixed_state'
  /** 回填行出现具体 contentOriginator（伪造检测，Proposed-Schema §7 ⑦） */
  | 'migrated_legacy_fabricated_content_originator'
  /** 回填分类 N（不适用）的槽位被填了值（K-20 / R-18） */
  | 'migrated_legacy_n_slot_not_absent'
  /** 回填分类 D/P/U（适用）的槽位没有表态（Absent ⇒ 丢信息，K-20 / R-18） */
  | 'migrated_legacy_applicable_slot_absent'
  /** 回填分类 U 的槽位出现具体值（具体值计数必须为 0，K-20 / R-18） */
  | 'migrated_legacy_u_slot_fabricated'
  /** 回填行的 recordedBy 不是 canonical ledger recorder（K-23 / R-20） */
  | 'migrated_legacy_recorder_not_canonical'

export interface NecessityViolation {
  slot: AttributionSlot
  code: NecessityViolationCode
  detail: string
}

interface SlotReading {
  state: 'KNOWN' | 'UNKNOWN' | 'ABSENT'
  /** KNOWN 时：`PrincipalRef` 或 `AuthorityRef`（运行时可能是任意形状） */
  known?: unknown
  reason?: UnknownReason
}

function readValue(value: AttributionValue<unknown>): SlotReading | undefined {
  switch (value.state) {
    case 'KNOWN':
      return { state: 'KNOWN', known: value.value }
    case 'UNKNOWN':
      return { state: 'UNKNOWN', reason: value.reason }
    case 'ABSENT':
      return { state: 'ABSENT' }
    default:
      // 运行时的非法三态标记：由 mixedStateViolations 报出，这里不猜它像哪一种
      return undefined
  }
}

/**
 * 混合形状守卫：三态**不可互相折叠**，也不允许"既像 Known 又像 Unknown"。
 *
 *     KNOWN  不得带 reason（"知道是谁"却顺手写一个未知理由）
 *     UNKNOWN 不得带 value（"不知道"却顺手填一个默认位次 —— D01 的手感）
 *     ABSENT 不得带 value / reason
 *
 * 这些形状在 TypeScript 里写不出来，但**运行时的输入**（JSON、旧行、外部 DTO）
 * 可以带进来，所以它必须在运行时失败关闭。
 */
function mixedStateViolations(slot: AttributionSlot, raw: unknown): NecessityViolation[] {
  if (typeof raw !== 'object' || raw === null) {
    return [{ slot, code: 'invalid_mixed_state', detail: `${slot} 必须是三态对象` }]
  }
  const value = raw as Record<string, unknown>
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)
  switch (value.state) {
    case 'KNOWN':
      return has('reason')
        ? [{ slot, code: 'invalid_mixed_state', detail: 'KNOWN 不得带 reason' }]
        : []
    case 'UNKNOWN':
      return has('value')
        ? [
            {
              slot,
              code: 'invalid_mixed_state',
              detail: 'UNKNOWN 不得带 value（不得"未知但顺手填一个默认位次"）',
            },
          ]
        : []
    case 'ABSENT': {
      const extra = ['value', 'reason'].filter(has)
      return extra.length > 0
        ? [{ slot, code: 'invalid_mixed_state', detail: `ABSENT 不得带 ${extra.join(' / ')}` }]
        : []
    }
    default:
      return [
        { slot, code: 'invalid_mixed_state', detail: `未知的三态标记：${String(value.state)}` },
      ]
  }
}

function structuralViolations(
  slot: AttributionSlot,
  reading: SlotReading,
  expectsAuthority: boolean
): NecessityViolation[] {
  const out: NecessityViolation[] = []
  if (reading.state === 'UNKNOWN') {
    if (reading.reason === undefined || !UNKNOWN_REASONS.includes(reading.reason)) {
      out.push({
        slot,
        code: 'unknown_unknown_reason',
        detail: `unknown_reason 不在受控词汇里：${String(reading.reason)}`,
      })
    }
    return out
  }
  if (reading.state !== 'KNOWN') return out

  const ref = reading.known as { kind?: unknown; id?: unknown; ref?: unknown } | undefined
  const kind = ref?.kind
  if (expectsAuthority) {
    if (typeof kind !== 'string' || !(AUTHORITY_KINDS as readonly string[]).includes(kind)) {
      out.push({
        slot,
        code: 'unknown_authority_kind',
        detail: `authority.kind 不在受控词汇里：${String(kind)}（DEVELOPER_SURFACE 已被删除）`,
      })
    }
    if (typeof ref?.ref !== 'string' || ref.ref.trim() === '') {
      out.push({
        slot,
        code: 'unknown_authority_kind',
        detail: 'authority.ref 必须是非空字符串',
      })
    }
  } else {
    if (typeof kind !== 'string' || !(PRINCIPAL_KINDS as readonly string[]).includes(kind)) {
      out.push({
        slot,
        code: 'unknown_principal_kind',
        detail: `principal.kind 不在受控词汇里：${String(kind)}（没有 UNKNOWN* / DEVELOPER）`,
      })
    }
    if (typeof ref?.id !== 'string' || ref.id.trim() === '') {
      out.push({
        slot,
        code: 'unknown_principal_kind',
        detail: 'principal.id 必须是非空字符串',
      })
    }
  }
  return out
}

function checkCell(
  slot: AttributionSlot,
  cell: NecessityState,
  reading: SlotReading
): NecessityViolation[] {
  if (cell === 'DERIVED') return []
  if (cell === 'ABSENT') {
    if (reading.state === 'KNOWN') {
      return [
        {
          slot,
          code: 'absent_slot_filled_concrete',
          detail: `${slot} 对此事件族不适用，却被填了具体值 —— 把"不适用"伪装成一条断言`,
        },
      ]
    }
    if (reading.state === 'UNKNOWN') {
      return [
        {
          slot,
          code: 'absent_slot_filled_unknown',
          detail: `${slot} 对此事件族不适用；给它记一个 Unknown 等于宣称这个概念适用`,
        },
      ]
    }
    return []
  }
  // REQUIRED / ALLOWED_UNKNOWN：两者都要求"被表态"
  if (reading.state === 'ABSENT') {
    return [
      {
        slot,
        code: 'required_slot_absent',
        detail: `${slot} 对 ${String(cell)} 单元是必需的，却是 Absent`,
      },
    ]
  }
  if (cell === 'REQUIRED' && reading.state === 'UNKNOWN' && reading.reason === 'LEGACY_UNRECORDED') {
    return [
      {
        slot,
        code: 'required_slot_legacy_unrecorded',
        detail:
          `${slot} 是必需槽位，但被写成 Unknown(LEGACY_UNRECORDED) —— ` +
          '"历史没记"是回填行的结论，不是新事件的合法状态',
      },
    ]
  }
  return []
}

// ---------------------------------------------------------------------------
// WP4 step 1/3b —— K-25 / R-22 Trusted Attestation Decoupling
// ---------------------------------------------------------------------------

/**
 * **受信证据是不透明的**（K-25 §2）。
 *
 * 三个**角色专用**的证据 token 只能由本模块里对应的构造函数产出；
 * `TRUSTED_EVIDENCE_BRAND` **不导出**，因此外部代码**无法构造**出满足类型的值
 * （TypeScript 的名义类型技巧）；运行期再用 `WeakSet` 挡一次结构克隆
 * （`{...evidence}` / `JSON.parse(JSON.stringify(evidence))` 都不通过）。
 *
 * ⚠️ 诚实说明这条防线的**边界**：它挡的是"**不可信载荷**夹带一个 enum 字段就提权"
 * （例如 HTTP body / 模型输出里写 `ingress:'human_console'`）。
 * 它**不是**密码学证明 —— 能 import 本模块并调用构造函数的人就是受信调用点。
 * 因此"谁可以调这些构造函数"仍然是一条**约定**，只是现在它变成了
 * **显式的、命名清楚的三个角色**，而不是一个谁都能填的枚举。
 */
const TRUSTED_EVIDENCE_BRAND: unique symbol = Symbol('m5.1.1.trusted-attestation-evidence')
const REGISTERED_EVIDENCE = new WeakSet<object>()

/** 本模块 `buildTrustedAttributionContext()` 产出过的**上下文对象**（AT-W4-7 的运行期守卫） */
const REGISTERED_CONTEXTS = new WeakSet<object>()

interface TrustedEvidenceBase {
  readonly [TRUSTED_EVIDENCE_BRAND]: 'trusted-attestation-evidence'
  /** 产出它的**受信适配器**标识（证据里可查：谁做的鉴证） */
  readonly adapterId: string
}

/** 谁**决定并产生了**这条事件（权威网关 / 决策点） */
export interface TrustedActorEvidence extends TrustedEvidenceBase {
  readonly principal: PrincipalRef | null
  /**
   * WP6.1：运行时**确实定不下来**时如实说明（`RUNTIME_UNRESOLVED`）。
   *
   * 与动作侧同形（`attestActionActorFromDecisionPoint` 一直有这个字段）：
   * 对话侧的 `actor` 在必要性矩阵里是 `REQUIRED`，而 `REQUIRED` **允许**
   * `Unknown(RUNTIME_UNRESOLVED)`、**不允许** `Absent`（裁定 U-04）。
   * 缺了它，"这条事件的 actor 定不下来"就只能被表达成 `Absent` —— 那是一条
   * 违反冻结矩阵的行（正是 WP6.1 要避免的形状）。
   */
  readonly unresolvedReason?: UnknownReason
}

/** 这段**语义内容是谁提供的**（受信 ingress） */
export interface TrustedContentOriginatorEvidence extends TrustedEvidenceBase {
  readonly principal: PrincipalRef | null
  readonly unresolvedReason?: UnknownReason
}

/**
 * 认知资格**已被鉴证**的证据（K-25 §3）。
 *
 * `kind` 说明"到底证明了什么"；**它不是**"主体类型"的同义词：
 *   authenticated_human_input   直接、已认证的人类输入（唯一可给 `USER_EXPLICIT` 的）
 *   character_self_generation   角色自己生成
 *   system_instruction_source   来自系统指令面
 *   tool_observation_source     来自工具观测
 */
export const EPISTEMIC_ATTESTATION_KINDS = [
  'authenticated_human_input',
  'character_self_generation',
  'system_instruction_source',
  'tool_observation_source',
] as const
export type EpistemicAttestationKind = (typeof EPISTEMIC_ATTESTATION_KINDS)[number]

export interface TrustedEpistemicEvidence extends TrustedEvidenceBase {
  readonly kind: EpistemicAttestationKind
}

function registerEvidence<T extends TrustedEvidenceBase>(evidence: T): T {
  REGISTERED_EVIDENCE.add(evidence)
  return evidence
}

/** 运行期守卫：只有**本模块构造过**的 token 才通过（结构克隆挡在外面） */
export function isTrustedAttestationEvidence(value: unknown): boolean {
  return typeof value === 'object' && value !== null && REGISTERED_EVIDENCE.has(value)
}

export function attestActorFromDecisionPoint(input: {
  adapterId: string
  principal: PrincipalRef | null
  /** WP6.1：运行时定不下来时如实说明（见 `TrustedActorEvidence`） */
  unresolvedReason?: UnknownReason
}): TrustedActorEvidence {
  return registerEvidence({
    [TRUSTED_EVIDENCE_BRAND]: 'trusted-attestation-evidence',
    adapterId: input.adapterId,
    principal: input.principal,
    ...(input.unresolvedReason !== undefined ? { unresolvedReason: input.unresolvedReason } : {}),
  })
}

export function attestContentOriginatorFromIngress(input: {
  adapterId: string
  principal: PrincipalRef | null
  unresolvedReason?: UnknownReason
}): TrustedContentOriginatorEvidence {
  return registerEvidence({
    [TRUSTED_EVIDENCE_BRAND]: 'trusted-attestation-evidence',
    adapterId: input.adapterId,
    principal: input.principal,
    ...(input.unresolvedReason !== undefined ? { unresolvedReason: input.unresolvedReason } : {}),
  })
}

export function attestEpistemicConfirmation(input: {
  adapterId: string
  kind: EpistemicAttestationKind
}): TrustedEpistemicEvidence {
  return registerEvidence({
    [TRUSTED_EVIDENCE_BRAND]: 'trusted-attestation-evidence',
    adapterId: input.adapterId,
    kind: input.kind,
  })
}

/** 每一族**唯一**能建立 confirmed 的鉴证种类（K-25 §3/§4：主体类型**不等于**认知资格） */
export const CONFIRMING_ATTESTATION_BY_FAMILY: Readonly<
  Record<ConversationFamily, EpistemicAttestationKind>
> = {
  user_message: 'authenticated_human_input',
  assistant_message: 'character_self_generation',
  system_event: 'system_instruction_source',
  tool_event: 'tool_observation_source',
}

/** 对话四族各自的 legacy `actor_type`（AT-W4-2：**唯一**允许的一致性） */
export const LEGACY_ACTOR_TYPE_BY_FAMILY: Readonly<Record<ConversationFamily, ActorType>> = {
  user_message: 'user',
  assistant_message: 'character',
  system_event: 'system',
  tool_event: 'tool',
}

export type ConversationFamily = 'user_message' | 'assistant_message' | 'system_event' | 'tool_event'

export interface TrustedAttributionContext {
  readonly attributionOrigin: 'RECORDED'
  readonly family: ConversationFamily
  /** legacy 呈现角色：**由事件族决定**；与 actor / contentOriginator **并列但不要求相等** */
  readonly presenterActorType: ActorType
  /** 由 canonical domain context 派生（不新增存储） */
  readonly subject: PrincipalRef
  readonly actor: AttributionValue<PrincipalRef>
  readonly contentOriginator: AttributionValue<PrincipalRef>
  /** 永远由受信写入器构造；调用方无法提供（K-23 / AT-W4-3） */
  readonly recordedBy: AttributionValue<PrincipalRef>
  readonly axisB: {
    readonly sourceKind: SourceKind
    readonly sourceAuthority: SourceAuthority
    readonly epistemicSource: EpistemicSource
    readonly branch: RecordedAxisBBranch
    /** confirmed 时：是哪一条鉴证建立的；unconfirmed 时为 null */
    readonly attestedBy: EpistemicAttestationKind | null
  }
  /** 证据可追溯性（写进证据，便于事后回答"谁鉴证的"） */
  readonly evidence: {
    actorAdapterId: string
    originatorAdapterId: string
    epistemicAdapterId: string | null
  }
}

function principalToValue(
  principal: PrincipalRef | null,
  unresolvedReason?: UnknownReason
): AttributionValue<PrincipalRef> {
  if (principal !== null) return attributionKnown<PrincipalRef>(principal)
  return unresolvedReason === undefined
    ? attributionAbsent<PrincipalRef>()
    : attributionUnknown<PrincipalRef>(unresolvedReason)
}

/**
 * 从**三份互相独立的受信证据**构造归因上下文（K-25 的核心修正）。
 *
 * 与上一版的区别（三处都是**真缺陷**）：
 *   ① 上一版用一个 `ingressRef` 同时推出 `actor` 与 `contentOriginator`
 *      ⇒ **两个槽位永远绑死**，`actor ≠ contentOriginator` 表达不出来。
 *      现在它们是**两份独立证据**（合法地可以相同，但一个**不**从另一个推导）。
 *   ② 上一版用 `contentOriginator.kind === 该族 canonical 主体 ⇒ confirmed`
 *      当确认判据 —— 那等于让"主体类型"重新变成认知资格的证据，
 *      正是 R-21 明确禁止的方向。现在 confirmed **必须**有受信的**认知鉴证证据**；
 *      没有证据时，即使 `contentOriginator = Known(USER/…)` 也只能是 **unconfirmed**。
 *   ③ 上一版把 `ingress` 做成一个**调用方可填的枚举** ⇒ 一个普通 DTO 字段就能提权。
 *      现在是**不透明的证据 token**（品牌类型 + 运行期 WeakSet）。
 */
export function buildTrustedAttributionContext(input: {
  family: ConversationFamily
  characterId: string
  actorEvidence: TrustedActorEvidence
  contentOriginatorEvidence: TrustedContentOriginatorEvidence
  /** 认知资格鉴证；**不给** ⇒ unconfirmed（这是默认，也是最安全的） */
  epistemicEvidence?: TrustedEpistemicEvidence
}): TrustedAttributionContext {
  for (const [slot, evidence] of [
    ['actorEvidence', input.actorEvidence],
    ['contentOriginatorEvidence', input.contentOriginatorEvidence],
  ] as const) {
    if (!isTrustedAttestationEvidence(evidence)) {
      throw new KernelError(
        'validation_error',
        'untrusted_attestation_evidence',
        `${slot} 不是受信证据（不可伪造的 token 之外一律拒绝：` +
          '普通 DTO 字段 / 结构克隆 / JSON 往返都不算证据 —— K-25 §2）'
      )
    }
  }
  if (input.epistemicEvidence !== undefined && !isTrustedAttestationEvidence(input.epistemicEvidence)) {
    throw new KernelError(
      'validation_error',
      'untrusted_attestation_evidence',
      'epistemicEvidence 不是受信证据（K-25 §2）'
    )
  }

  const actor = principalToValue(input.actorEvidence.principal, input.actorEvidence.unresolvedReason)
  const contentOriginator = principalToValue(
    input.contentOriginatorEvidence.principal,
    input.contentOriginatorEvidence.unresolvedReason
  )

  const sourceKind = sourceKindForEventFamily(input.family)
  const requiredAttestation = CONFIRMING_ATTESTATION_BY_FAMILY[input.family]
  const attestedBy = input.epistemicEvidence?.kind ?? null

  /*
   * confirmed 的条件（**三条都要**，缺一即 unconfirmed）：
   *   ① 有受信的认知鉴证证据，且它的 kind **正是这一族**要求的那一种；
   *   ② contentOriginator 是**已知**的（不知道来源就谈不上"来源已确立"）；
   *   ③ 鉴证的种类与内容来源**相容**：`authenticated_human_input` 只对 Known(USER) 成立 ——
   *      这正是"服务 / 自动化也走同一个表面时，表面身份本身不足以证明人类来源"（K-25 §4）。
   */
  const originatorPrincipal = contentOriginator.state === 'KNOWN' ? contentOriginator.value : null
  const attestationCompatible =
    attestedBy === null
      ? false
      : attestedBy === 'authenticated_human_input'
        ? originatorPrincipal?.kind === 'USER'
        : attestedBy === 'character_self_generation'
          ? originatorPrincipal?.kind === 'CHARACTER'
          : attestedBy === 'system_instruction_source'
            ? originatorPrincipal?.kind === 'SYSTEM'
            : originatorPrincipal?.kind === 'TOOL'
  const confirmed =
    attestedBy === requiredAttestation && originatorPrincipal !== null && attestationCompatible

  const axisB = {
    sourceKind,
    sourceAuthority: (confirmed
      ? defaultAuthorityForKind(sourceKind)
      : UNCONFIRMED_AXIS_B_VALUE) as SourceAuthority,
    epistemicSource: (confirmed
      ? epistemicSourceForKind(sourceKind)
      : UNCONFIRMED_AXIS_B_VALUE) as EpistemicSource,
    branch: (confirmed ? 'confirmed' : 'unconfirmed') as RecordedAxisBBranch,
    attestedBy: confirmed ? attestedBy : null,
  }
  // AT-W4-5：**每次** RECORDED 写入前都必须过这条（混合形态失败关闭）
  assertRecordedAxisB(axisB)

  /*
   * AT-W4-7：返回前做两件事 —— 冻结 + 登记。
   *
   *   冻结 ⇒ "构造后篡改受信 contentOriginator" 在严格模式下**抛**（值不会变），
   *          非严格模式下是静默无效（值同样不会变）—— 两条路径都改不动它。
   *   登记 ⇒ 手写对象 / 结构克隆 / JSON 往返出来的**同形对象**不是受信上下文，
   *          写入路径（`createConversationEvent`）会拒绝它们。
   */
  const context: TrustedAttributionContext = Object.freeze({
    attributionOrigin: 'RECORDED' as const,
    family: input.family,
    presenterActorType: LEGACY_ACTOR_TYPE_BY_FAMILY[input.family],
    subject: Object.freeze({ kind: 'CHARACTER', id: input.characterId }) as PrincipalRef,
    actor: freezeAttributionValue(actor),
    contentOriginator: freezeAttributionValue(contentOriginator),
    recordedBy: freezeAttributionValue(
      attributionKnown<PrincipalRef>({
        kind: CANONICAL_LEDGER_RECORDER.kind as PrincipalRef['kind'],
        id: CANONICAL_LEDGER_RECORDER.id,
      })
    ),
    axisB: Object.freeze(axisB),
    evidence: Object.freeze({
      actorAdapterId: input.actorEvidence.adapterId,
      originatorAdapterId: input.contentOriginatorEvidence.adapterId,
      epistemicAdapterId: input.epistemicEvidence?.adapterId ?? null,
    }),
  })

  /*
   * ==========================================================================
   *  K-29 —— **必要性矩阵是这个构造器的出闸判据**（fail closed）
   * ==========================================================================
   * 在这之前，`buildTrustedAttributionContext()` 只过 `assertRecordedAxisB()`：
   * 它能构造出一份 Axis B 合法、但**违反冻结必要性矩阵**的 RECORDED 信封 ——
   * 例如 `user_message.actor = Absent`（矩阵要求 REQUIRED，而 REQUIRED 允许
   * `Unknown(RUNTIME_UNRESOLVED)`、**不允许** `Absent`，裁定 U-04）。
   *
   * 现在它在**返回之前**必须过 `assertAttributionNecessity()`（canonical 判据，
   * 与本文件下面那个函数是**同一份**实现 —— 不另写一张表）。
   *
   * ⚠️ 这里**不补任何 principal**：证据不足时的合法形态是
   *    `Unknown(RUNTIME_UNRESOLVED)`（由调用方在证据里写明），
   *    而不是让构造器替它猜一个位次（那正是 D01 的错误形状）。
   */
  assertConversationAttributionNecessity(context)
  REGISTERED_CONTEXTS.add(context)
  return context
}

/** 把一个受信上下文摊成**统一信封**（七个槽位 + origin）—— 只为过 canonical 判据，不新增存储 */
export function conversationAttributionEnvelopeOf(
  context: TrustedAttributionContext
): AttributionEnvelope {
  const slots = attributionSlotsOfContext(context)
  return {
    subject: context.subject,
    initiator: slots.initiator as AttributionValue<PrincipalRef>,
    actor: slots.actor as AttributionValue<PrincipalRef>,
    executor: slots.executor as AttributionValue<PrincipalRef>,
    authority: slots.authority as AuthorityValue,
    recordedBy: slots.recordedBy as AttributionValue<PrincipalRef>,
    contentOriginator: slots.contentOriginator as AttributionValue<PrincipalRef>,
    attributionOrigin: context.attributionOrigin,
  }
}

/**
 * **K-29 的唯一出闸判据**（对话侧）。
 *
 * 两个调用点，**同一份**实现（defense in depth，不是第二套语义）：
 *
 * ```text
 *   buildTrustedAttributionContext()   ← 构造期（#1）
 *   createConversationEvent()          ← 消费期（#2）
 * ```
 *
 * 消费期那一道主要防的是：将来重构、陈旧的内部生产者、上下文登记表出问题、
 * 或者某条没预料到的内部构造路径 —— 那时它仍然会在**写入之前**失败关闭。
 */
export function assertConversationAttributionNecessity(context: TrustedAttributionContext): void {
  assertAttributionNecessity({
    family: context.family,
    envelope: conversationAttributionEnvelopeOf(context),
  })
}

/**
 * **构造器自己填**、而不是由证据决定的三个槽位（`initiator` / `executor` / `authority`）。
 *
 * ============================================================================
 *  K-29：它们的形态**由冻结矩阵的那一格决定**，不是硬编码 Absent
 * ============================================================================
 * 在这之前这里写死 `attributionAbsent()`。那对 `user_message` / `assistant_message`
 * 是对的（矩阵那两格是 `ABSENT`），但对 `system_event` / `tool_event` 是**错的**：
 * 矩阵要求 `initiator = REQUIRED`（裁定 U-04 允许 `Unknown(RUNTIME_UNRESOLVED)`、
 * **不允许** `Absent`）—— 于是那两族的 RECORDED 信封**在结构上不可能合法**，
 * 而这一点直到 K-29 把必要性判据接到构造器上才暴露出来（继承门 K-25 / WP4 当场变红）。
 *
 * 现在的取值规则（**读的是同一张 canonical 矩阵**，不是第二张表）：
 *
 * ```text
 *   矩阵那一格 = ABSENT                      ⇒ Absent（概念不适用）
 *   矩阵那一格 = REQUIRED / ALLOWED_UNKNOWN  ⇒ Unknown(RUNTIME_UNRESOLVED)
 *                                              （构造器**确实**没有拿到这个槽位的证据；
 *                                               这与"猜一个位次"是两件事 —— 后者才是伪造）
 * ```
 *
 * ⚠️ `contentOriginator` **不在这里**：它有独立的受信证据，由调用方决定 Known / Unknown / Absent。
 * ⚠️ 生产链路只接 `user_message` / `assistant_message` 两族（WP6.1），
 *    而那两族的这三格全是 `ABSENT` ⇒ **生产行为零变化**。
 */
function unevidencedSlotValue(cell: NecessityState): AttributionValue<unknown> {
  return cell === 'ABSENT' ? attributionAbsent<unknown>() : attributionUnknown<unknown>('RUNTIME_UNRESOLVED')
}

/** 上下文的 6 个槽位（物理列的值），供 store 持久化 */
export function attributionSlotsOfContext(
  context: TrustedAttributionContext
): Record<AttributionValueSlot, AttributionValue<unknown>> {
  const matrix = NECESSITY_MATRIX[context.family]
  return {
    initiator: unevidencedSlotValue(matrix.initiator),
    actor: context.actor as AttributionValue<unknown>,
    executor: unevidencedSlotValue(matrix.executor),
    authority: unevidencedSlotValue(matrix.authority),
    recordedBy: context.recordedBy as AttributionValue<unknown>,
    contentOriginator: context.contentOriginator as AttributionValue<unknown>,
  }
}

// ---------------------------------------------------------------------------
// WP4 step 3/3-fix —— 读路径：列 → 三态值的唯一解码器（**不推断、不补默认值**）
// ---------------------------------------------------------------------------

/**
 * 一个槽位在库里的三个格：`<slot>_kind` / `<slot>_id`（authority 是 `_ref`）/
 * `<slot>_unknown_reason`。
 *
 * 三个格就是三态的**唯一**物理编码（Proposed-Schema §0；DDL 侧由
 * `*_tri_state` CHECK 钉住，见 `migrations.ts` 的 `v7AttributionCheckStatements`）。
 */
export interface AttributionSlotCells {
  readonly kind: string | null
  readonly id: string | null
  readonly unknownReason: string | null
}

/** 物理格 → 字符串（`undefined` / 空串一律当作 NULL，与 DDL 的 `is null` 对齐） */
const cellText = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

/**
 * 三个格 → 一个三态值（**读取期**）。
 *
 * 三条纪律（WP4 任务书 §1/§2）：
 *   ① 只读这三个格。**不得**从 `actor_type` / `actor_id` / `source_kind` /
 *      `transport` / conversation id / runtime id 推出任何一个槽位。
 *   ② 落不进三态之一的行**一律拒绝**（fail closed）—— 它既不是 Known、
 *      也不是 Unknown、也不是 Absent，而"猜它像哪一种"正是 D01 的错误形状。
 *   ③ 词汇与形状用**写入期同一套判据**（`mixedStateViolations` /
 *      `structuralViolations`）复核；读取期只拒绝，**永不修值**。
 */
export function decodeAttributionSlot(
  slot: AttributionValueSlot,
  cells: AttributionSlotCells
): AttributionValue<PrincipalRef | AuthorityRef> {
  const kind = cellText(cells.kind)
  const id = cellText(cells.id)
  const reason = cellText(cells.unknownReason)

  let value: AttributionValue<PrincipalRef | AuthorityRef>
  if (kind === null && id === null && reason === null) {
    value = attributionAbsent<PrincipalRef | AuthorityRef>()
  } else if (kind === null && id === null && reason !== null) {
    value = attributionUnknown<PrincipalRef | AuthorityRef>(reason as UnknownReason)
  } else if (kind !== null && id !== null && reason === null) {
    value = attributionKnown<PrincipalRef | AuthorityRef>(
      slot === 'authority'
        ? ({ kind, ref: id } as AuthorityRef)
        : ({ kind, id } as PrincipalRef)
    )
  } else {
    throw new KernelError(
      'persistence_error',
      'attribution_slot_shape_invalid',
      `${slot} 的物理三格落不进 Known / Unknown / Absent 中的任何一态` +
        `（kind=${String(kind)} id=${String(id)} unknown_reason=${String(reason)}）—— ` +
        '读取期不猜、不补默认值（WP4 §1）',
      { slot, kind, id, reason }
    )
  }

  const reading = readValue(value)
  const violations = [
    ...mixedStateViolations(slot, value),
    ...(reading === undefined ? [] : structuralViolations(slot, reading, slot === 'authority')),
  ]
  if (violations.length > 0) {
    throw new KernelError(
      'persistence_error',
      'attribution_slot_value_invalid',
      `${slot} 的存储值不在受控词汇 / 合法形状之内：` +
        violations.map((violation) => `${violation.code}（${violation.detail}）`).join(' · '),
      { slot, violations: violations.map((violation) => violation.code) }
    )
  }
  return value
}

/**
 * 六个槽位一起解码（读路径的入口）。
 *
 * ⚠️ 它**只**接受这六个槽位的三个格；调用方负责"这一行到底有没有权威归因"
 * 的判断（`attribution_origin = 'RECORDED'`），解码器本身不做那个判断 ——
 * 否则"要不要解码"这件事会被藏进一个工具函数里。
 */
export function decodeAttributionSlots(
  cells: Readonly<Record<AttributionValueSlot, AttributionSlotCells>>
): Record<AttributionValueSlot, AttributionValue<unknown>> {
  const slots = {} as Record<AttributionValueSlot, AttributionValue<unknown>>
  for (const slot of ATTRIBUTION_VALUE_SLOTS) {
    slots[slot] = decodeAttributionSlot(slot, cells[slot]) as AttributionValue<unknown>
  }
  return slots
}

/**
 * WP6 —— **查询/审计读侧**的"一行 → 存储归因"（RECORDED 与 MIGRATED_LEGACY **都**解码）。
 *
 * 与 `rowToEvent` 的分工（**刻意的**，不是重复实现）：
 *   · `rowToEvent`（WP4）是**事件对象**的语义：只有 RECORDED 才有
 *     `event.attribution` 信封；`MIGRATED_LEGACY` / 无 origin 走兼容路径。
 *   · 本函数是**读侧表示**的语义（WP6-1 / WP6-2）：历史行也**必须**如实展示成
 *     `MIGRATED_LEGACY`（三态逐字），**不**允许被静默升格成 RECORDED、也**不**允许
 *     把 Unknown 折叠成 Absent。
 *
 * 没有 `attribution_origin` 的行 ⇒ `undefined`（"这条行没有记录过归因"本身就是要
 * 如实表达的事实，不是"三态全 Absent"）。
 *
 * 两张事件表的归因列名**完全相同**（v7 的设计），因此这一个函数对两者通用。
 */
export interface StoredAttributionReadback {
  readonly attributionOrigin: AttributionOrigin
  readonly slots: Record<AttributionValueSlot, AttributionValue<unknown>>
  /** Axis B 三列的**原样**读数（行动表按 K-22 恒为 null；由调用方按表判定适用性） */
  readonly axisB: {
    readonly sourceKind: string | null
    readonly sourceAuthority: string | null
    readonly epistemicSource: string | null
  }
}

/** `attribution_origin` 的列名（Proposed-Schema §1；在 ATTRIBUTION_NON_SLOT_COLUMNS 里） */
export const ATTRIBUTION_ORIGIN_COLUMN = 'attribution_origin' as const

export function storedAttributionOfRow(
  row: Readonly<Record<string, unknown>>
): StoredAttributionReadback | undefined {
  const rawOrigin = row[ATTRIBUTION_ORIGIN_COLUMN]
  if (rawOrigin === null || rawOrigin === undefined) return undefined
  const attributionOrigin = String(rawOrigin) as AttributionOrigin
  if (!(ATTRIBUTION_ORIGINS as readonly string[]).includes(attributionOrigin)) {
    throw new KernelError(
      'persistence_error',
      'attribution_origin_invalid',
      `attribution_origin 不在受控词汇里：${String(rawOrigin)}`
    )
  }
  const cells = {} as Record<AttributionValueSlot, AttributionSlotCells>
  for (const slot of ATTRIBUTION_VALUE_SLOTS) {
    const columns = ATTRIBUTION_SLOT_COLUMNS[slot]
    cells[slot] = {
      kind: cellText(row[columns.kind]),
      id: cellText(row[columns.id]),
      unknownReason: cellText(row[columns.unknownReason]),
    }
  }
  return {
    attributionOrigin,
    slots: decodeAttributionSlots(cells),
    axisB: {
      sourceKind: cellText(row[ATTRIBUTION_NON_SLOT_COLUMNS[0]!]),
      sourceAuthority: cellText(row[ATTRIBUTION_NON_SLOT_COLUMNS[1]!]),
      epistemicSource: cellText(row[ATTRIBUTION_NON_SLOT_COLUMNS[2]!]),
    },
  }
}

// ---------------------------------------------------------------------------
// 受信上下文的运行期登记（AT-W4-7）：手写对象 / 结构克隆 / JSON 往返都不算
// ---------------------------------------------------------------------------

/**
 * `TrustedAttributionContext` 本身**也**是不透明的（K-25 §2 的同一形状）。
 *
 * 为什么需要它：证据 token 的牌子只保护 `buildTrustedAttributionContext()` 的**入参**；
 * 上下文是普通对象，一个调用方**手写**一份同形对象（或 `{...ctx}` / JSON 往返）
 * 就能把 `actor=SERVICE/agent` + `contentOriginator=Known(USER)` +
 * `sourceAuthority=USER_EXPLICIT` 直接塞进写入路径 —— 那正是 D01 的伪造本身。
 * 因此上下文与证据用**同一套**运行期守卫：只有本模块构造过的那一个对象算数。
 *
 * ⚠️ 与 `isTrustedAttribution`（WP1 的 `TrustedAttribution` **信封** DTO）不是一回事：
 *    那个判的是"带 `TRUSTED_INGRESS_MARK` 的信封"，本函数判的是
 *    **本模块 `buildTrustedAttributionContext()` 的返回值**。
 */
export function isTrustedAttributionContext(value: unknown): boolean {
  return typeof value === 'object' && value !== null && REGISTERED_CONTEXTS.has(value)
}

/** 三态值连同它内部的位次一起冻结（构造后篡改 ⇒ 抛 / 值不变） */
function freezeAttributionValue<T>(value: AttributionValue<T>): AttributionValue<T> {
  if (value.state === 'KNOWN' && typeof value.value === 'object' && value.value !== null) {
    Object.freeze(value.value)
  }
  return Object.freeze(value)
}

/**
 * K-25 §2/§6 的**不可信载荷守卫**：调用方若夹带权威承载字段（含任何"表面身份"枚举，
 * 例如一个凭空写上的 `ingress` / `ingressRef`），一律**拒绝**。
 *
 * 为什么是拒绝而不是静默忽略：静默忽略会让"我声明过了"变成一种错觉 ——
 * 而本设计的全部要点就是**声明不等于证据**。
 */
export function assertNoCallerSuppliedAttribution(input: Record<string, unknown>): void {
  const forbidden = [
    'contentOriginator',
    'actor',
    'recordedBy',
    'sourceAuthority',
    'epistemicSource',
    'attributionOrigin',
    'ingress',
    'ingressRef',
    'trustedAttribution',
  ].filter((key) => input[key] !== undefined)
  if (forbidden.length > 0) {
    throw new KernelError(
      'validation_error',
      'caller_supplied_attribution_rejected',
      `不可信载荷不得自带权威承载字段：${forbidden.join(', ')}。` +
        '它们只能由受信适配器产出的**不透明证据**建立（K-25 §2 / AT-W4-1 / AT-W4-7）'
    )
  }
}

// ---------------------------------------------------------------------------
// K-23 / R-20 —— canonical ledger recorder principal（**冻结**）
// ---------------------------------------------------------------------------

/**
 * **权威 kernel 账本写入器**的 principal。
 *
 * 它表达的是**这一行账本是谁物理写下的** —— 仅此而已。
 * 它**不**说明、也**不得**被用来推断：
 *
 *     actor · initiator · contentOriginator · executor
 *
 * （"谁写下了这一行"与"这一行讲的是谁做的"是两件事；把其中一个推成另一个
 *   正是 M5.1-D01 的病根。）
 *
 * 为什么能确定：全 `src/` 里**只有** `conversation-store.ts` 会
 * `insert into conversation_events`（K-23 门的静态锁会断言这一点）⇒
 * 历史行在结构上**都是**这个写入器写下的。
 */
export const CANONICAL_LEDGER_RECORDER = { kind: 'SYSTEM', id: 'kernel' } as const

/** 该常量的出处（写进证据，免得日后有人以为它是随手写的） */
export const CANONICAL_LEDGER_RECORDER_SOURCE =
  'K-23 / R-20（用户 2026-09-18 裁定：historical recordedBy = Known(SYSTEM, "kernel")）'

/**
 * **受信写入器登记表**。
 *
 * 现在只有**一个**：权威 kernel 账本写入器。
 * ⚠️ 将来的写入器必须**显式登记**在这里才能拥有 recorder 位次 ——
 *    **不要**为了"看起来更通用"就顺手发明 `SERVICE/*` 之类的 principal。
 */
export interface TrustedLedgerWriter {
  writerId: string
  principal: { kind: string; id: string }
}

export const TRUSTED_LEDGER_WRITERS: readonly TrustedLedgerWriter[] = [
  { writerId: 'kernel-ledger-writer', principal: CANONICAL_LEDGER_RECORDER },
]

/** 某个值是否**恰好**是 canonical recorder（用于写入期与迁移门的证据一致性判据） */
export function isCanonicalRecorder(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as { kind?: unknown; id?: unknown }
  return candidate.kind === CANONICAL_LEDGER_RECORDER.kind && candidate.id === CANONICAL_LEDGER_RECORDER.id
}

// ---------------------------------------------------------------------------
// 回填分类 D/P/U/N（Migration-Strategy §3.2 / §3.3 冻结）—— K-20 / R-18
// ---------------------------------------------------------------------------

/**
 * 回填分类（**不是**写入期必要性；两者是不同的轴）。
 *
 *     D  deterministic   确定性证据**存在**；记录下来的 Known 值必须与它一致
 *     P  partial         只有在存在**独立的行级证据**时才允许 Known；否则 `Unknown(LEGACY_UNRECORDED)`
 *     U  unknown         具体值计数必须为 **0**；适用行一律 `Unknown(LEGACY_UNRECORDED)`
 *     N  not-applicable  槽位必须 **Absent**
 *
 * 与写入期必要性矩阵的关系（**可机检**）：`N ⟺ ABSENT`；其余三格都对应
 * "这个槽位适用"（写入期 `REQUIRED` / `ALLOWED_UNKNOWN`）。
 */
export type BackfillClass = 'D' | 'P' | 'U' | 'N'

export interface BackfillClassRow {
  subject: BackfillClass
  initiator: BackfillClass
  actor: BackfillClass
  executor: BackfillClass
  authority: BackfillClass
  recordedBy: BackfillClass
  contentOriginator: BackfillClass
}

/** 分类矩阵的出处（写进证据，免得日后有人以为它是随手写的） */
export const BACKFILL_CLASS_SOURCE =
  'M5.1.1-Migration-Strategy.md §3.2（conversation_events 逐族）/ §3.3（character_action_events 逐事件类型）'

const backfillRow = (
  initiator: BackfillClass,
  actor: BackfillClass,
  executor: BackfillClass,
  authority: BackfillClass,
  recordedBy: BackfillClass,
  contentOriginator: BackfillClass
): BackfillClassRow => ({
  subject: 'D',
  initiator,
  actor,
  executor,
  authority,
  recordedBy,
  contentOriginator,
})

/**
 * §3.2 —— `conversation_events` **逐 event family**。
 * 四族与族名 **1:1**（`type` 就是族名），因此这里**没有**任何映射推断。
 */
export const CONVERSATION_BACKFILL_CLASSIFICATION: Readonly<
  Record<'user_message' | 'assistant_message' | 'tool_event' | 'system_event', BackfillClassRow>
> = {
  user_message: backfillRow('N', 'U', 'N', 'N', 'D', 'U'),
  assistant_message: backfillRow('N', 'D', 'N', 'N', 'D', 'U'),
  tool_event: backfillRow('U', 'D', 'N', 'N', 'D', 'D'),
  /*
   * system_event（K-21 / R-19，2026-09-18 用户裁定）：
   *   contentOriginator 从 `P` **收敛为 `U`** —— `actor_id` **不得**当作
   *   "这段内容是谁提供的"的充分证据（系统事件里的 actor_id 常是组件名，
   *   它说明"谁自发了这条事件"，不说明"内容来源"）。
   *   历史值一律 `Unknown(LEGACY_UNRECORDED)`；同时把写入期必要性矩阵那一格
   *   从 `ABSENT` 改成 `ALLOWED_UNKNOWN`，让 `N ⟺ ABSENT` 重新**全局**成立。
   */
  system_event: backfillRow('P', 'P', 'N', 'N', 'D', 'U'),
}

/**
 * §3.3 —— `character_action_events` **逐 event type**。
 *
 * 文档就是按事件类型列的，而契约信封是按**语义族**收的（§3.3 的六个事件类型
 * 塌缩进 5 个语义族），两者**不是** 1:1 ⇒ 这里只做**逐字转录**，不替文档做映射推断。
 * 事件类型的**全集**由 K-20 门与 `ACTION_EVENT_TYPES` 逐项比对（多一个少一个都会红）。
 */
export const ACTION_BACKFILL_CLASSIFICATION: Readonly<Record<string, BackfillClassRow>> = {
  ACTION_REQUESTED: backfillRow('P', 'P', 'N', 'N', 'D', 'N'),
  ACTION_TARGET_RESOLVED: backfillRow('P', 'U', 'N', 'N', 'D', 'N'),
  ACTION_AUTHORIZED: backfillRow('P', 'U', 'N', 'U', 'D', 'N'),
  ACTION_REJECTED: backfillRow('P', 'U', 'N', 'N', 'D', 'N'),
  ACTION_STARTED: backfillRow('P', 'U', 'U', 'U', 'D', 'N'),
  ACTION_SUCCEEDED: backfillRow('P', 'U', 'U', 'U', 'D', 'N'),
  ACTION_FAILED: backfillRow('P', 'U', 'U', 'U', 'D', 'N'),
  ACTION_PARTIAL: backfillRow('P', 'U', 'U', 'U', 'D', 'N'),
  ACTION_CANCELLED: backfillRow('P', 'U', 'U', 'U', 'D', 'N'),
}

/**
 * **契约层拿不到 U 分类的族**（如实列出，不装作有）。
 *
 * 原因：§3.3 是**逐事件类型**冻结的，而 `AttributionEnvelope` 是按**语义族**构造的
 * （一个族覆盖多个类型，且这些类型的 U 格并不一致）。所以对这些族，契约层只能执行
 * 可判定的那部分（`N` 由写入期 `ABSENT` 精确等价推出 + 值级禁止），
 * **U 的限制交给库级门** `pnpm m5.1.1:k20:verify`（它看得到行上的具体 `event_type`）。
 *
 * 这个列表是**机读**的：K-20 门断言它恰好等于"分类表覆盖不到的族"，
 * 免得将来新增一个族却**静默**没有回填规则。
 */
export const BACKFILL_CONTRACT_DEFERRED_FAMILIES: readonly AttributionEventFamily[] = [
  'action_requested',
  'action_authorized',
  'action_side_effect_execution',
  'action_read_only_diagnostic',
  'developer_control',
  /*
   * WP9-B1（R-45）：`state_transition` 是**新族**，契约层同样拿不到它的 U 分类
   * （§3.2 的对话四族分类表里没有它）。K-20 门断言本列表**恰好**等于
   * "`CONVERSATION_BACKFILL_CLASSIFICATION` 覆盖不到的族" —— 因此新族必须登记在这里，
   * 且**不得**被塞进对话分类表（那会假装它有冻结的回填规则）。
   */
  'state_transition',
]

const BACKFILL_CHECKED_SLOTS: readonly AttributionValueSlot[] = [
  'initiator',
  'actor',
  'executor',
  'authority',
  'recordedBy',
  'contentOriginator',
]

/** 取该族该槽位的分类：有冻结分类就用它；没有的族按"可判定部分"降级（N 由 ABSENT 推出） */
function backfillClassFor(family: AttributionEventFamily, slot: AttributionValueSlot): BackfillClass {
  const frozen = CONVERSATION_BACKFILL_CLASSIFICATION[
    family as keyof typeof CONVERSATION_BACKFILL_CLASSIFICATION
  ]
  if (frozen !== undefined) return frozen[slot]
  // 未冻结到族粒度的族：写入期 ABSENT ⟺ N（精确等价）；其余一律按 P 处理（Known/Unknown 都合法，
  // 但 Absent 违规）。**不**放宽任何 anti-fabrication 判据。
  return NECESSITY_MATRIX[family][slot] === 'ABSENT' ? 'N' : 'P'
}

/**
 * 回填行（`MIGRATED_LEGACY`）的**形状**校验（K-20 / R-18）。
 *
 * ⚠️ 这里**不再**是过去那条 blanket 规则：
 *
 *     「回填行只要出现具体 contentOriginator 就是伪造」   ← **已删除**
 *
 * 它和冻结的 D/P/U/N 矩阵、以及 K-3 FINAL 直接冲突：
 * `tool_event.contentOriginator = D`，对确定性的工具行记录 `Known(TOOL/<tool-id>)`
 * 是**正确结果**，不是伪造。K-3 的裁定原文就是"新事件 `Known(TOOL/<tool-id>)`；
 * 历史迁移 = **D**"。
 *
 * 现在按分类判：
 *
 *     N → 必须 `Absent`（填任何东西都违规）
 *     U → 必须 `Unknown(LEGACY_UNRECORDED)`；`Known` 即伪造
 *     其它（D / P） → `Known` 或 `Unknown(LEGACY_UNRECORDED)` 都合法，
 *                     **Absent 违规**（这些槽位是适用的；D/P 都要求"表态"）
 *
 * 另有一条**值级**禁止（与分类无关，来自 Migration-Strategy §3.7 / M5.1-D01，
 * 保留原来的理由码以免历史证据失去可比性）：
 *
 *     `contentOriginator` 在回填行上**永不**可以是 `Known(USER)` / `Known(CHARACTER)`
 *
 * "记录的 `Known` 是否与确定性证据**逐字对上**"这一条**不在这里判** ——
 * 形状层拿不到行的确定性证据（例如工具行的 tool-id ⇒ `TOOL/<tool-id>`）。
 * 那条判据属于库级门 `pnpm m5.1.1:k20:verify`（R-18 的正面要求：
 * 它必须**正面证明**确定性的工具行 `Known(TOOL/<tool-id>)` 是**合法**的）。
 */
function validateMigratedLegacyEnvelope(
  family: AttributionEventFamily,
  envelope: AttributionEnvelope
): NecessityViolation[] {
  const out: NecessityViolation[] = []

  for (const slot of BACKFILL_CHECKED_SLOTS) {
    const cls = backfillClassFor(family, slot)
    const reading = readValue(envelope[slot] as AttributionValue<unknown>)
    // 非法三态标记的形状由写入期那条路径负责报；这里不猜它像哪一种
    if (reading === undefined) continue

    if (cls === 'N') {
      if (reading.state !== 'ABSENT') {
        out.push({
          slot,
          code: 'migrated_legacy_n_slot_not_absent',
          detail:
            `${slot} 的回填分类是 **N（不适用）** ⇒ 必须是 Absent；` +
            `填了值就是伪造（D/P/U/N 矩阵：Migration-Strategy §3.2）`,
        })
      }
      continue
    }

    if (cls === 'U') {
      // U：具体值计数必须为 0；适用行一律 Unknown(LEGACY_UNRECORDED)
      if (reading.state === 'KNOWN') {
        out.push({
          slot,
          code: 'migrated_legacy_u_slot_fabricated',
          detail:
            `${slot} 的回填分类是 **U（历史从未记录）** ⇒ 具体值计数必须为 0；` +
            `填一个具体的位次就是伪造（D/P/U/N 矩阵：Migration-Strategy §3.2）`,
        })
      } else if (reading.state === 'ABSENT') {
        out.push({
          slot,
          code: 'migrated_legacy_applicable_slot_absent',
          detail: `${slot} 是 U（适用）⇒ 必须表态成 Unknown(LEGACY_UNRECORDED)，不能 Absent`,
        })
      }
      continue
    }

    if (cls === 'P' && reading.state === 'ABSENT') {
      // P：只有在存在独立行级证据时才允许 Known，否则 Unknown(LEGACY_UNRECORDED) —— 但不许 Absent
      out.push({
        slot,
        code: 'migrated_legacy_applicable_slot_absent',
        detail: `${slot} 是 P（适用）⇒ 必须表态成 Known 或 Unknown(LEGACY_UNRECORDED)，不能 Absent`,
      })
      continue
    }

    // D：**Absent 不算伪造**（还没回填 ≠ 编造）。
    // D 的判据是"记了 Known 就必须与确定性证据逐字一致"——那条在库级门
    // `pnpm m5.1.1:k20:verify` 里判（形状层拿不到确定性证据）。
  }

  if (envelope.contentOriginator.state === 'KNOWN') {
    const known = envelope.contentOriginator.value as { kind?: string }
    if (known.kind === 'USER' || known.kind === 'CHARACTER') {
      out.push({
        slot: 'contentOriginator',
        code: 'migrated_legacy_fabricated_content_originator',
        detail:
          `回填行不得把 contentOriginator 说成 Known(${known.kind})：` +
          '历史没有记录"这段语义内容是谁提供的"，推断出一个人类/角色位次就是伪造' +
          '（Migration-Strategy §3.7 / Proposed-Schema §7 ⑦ / M5.1-D01）',
      })
    }
  }

  /*
   * K-23 / R-20：`recordedBy` 在回填行上**必须恰好**是 canonical ledger recorder。
   *
   *   · 它是**可判定的**（不需要行的其它信息）⇒ 契约层就能判，不必等库级门；
   *   · `Absent` 也算违规：**适用行的 recordedBy 缺失 = 迁移完整性失败**（不是"还没填"）；
   *   · 任何"调用方自己带一个 recorder"的形状（别的 kind / 别的 id）**一律失败关闭** ——
   *     这就是"recordedBy MUST NOT be caller supplied"的可执行形式。
   *
   * ⚠️ 这条只谈"谁写下这一行"，**不**对 actor / initiator / contentOriginator /
   *    executor 说任何话（一个不推另一个）。
   */
  if (envelope.recordedBy.state !== 'KNOWN' || !isCanonicalRecorder(envelope.recordedBy.value)) {
    const observed =
      envelope.recordedBy.state === 'KNOWN'
        ? `${(envelope.recordedBy.value as { kind?: string }).kind}/${(envelope.recordedBy.value as { id?: string }).id}`
        : envelope.recordedBy.state
    out.push({
      slot: 'recordedBy',
      code: 'migrated_legacy_recorder_not_canonical',
      detail:
        `回填行的 recordedBy 必须是 Known(${CANONICAL_LEDGER_RECORDER.kind}/${CANONICAL_LEDGER_RECORDER.id})，` +
        `实际是 ${observed}。recordedBy 是**账本写入器**的位次，不得由调用方自报，` +
        '也不得缺失（适用行缺它 = 迁移完整性失败）—— K-23 / R-20',
    })
  }

  return out
}

/**
 * 必要性校验（纯函数，**双向**）。
 *
 * 只测"必需槽位缺失 → 拒绝"是不够的：系统可以靠"把所有槽位都填上"通过。
 * 因此这里同时必须能回答：
 *
 *     不适用槽位被填具体值 → **拒绝**
 *     （user_message.executor = Known(USER) / read-only diagnostic.authority = Known(...) /
 *       ACTION_REQUESTED.authority = Known(...) 都必须 FAIL）
 */
export function validateAttributionNecessity(input: {
  family: AttributionEventFamily
  envelope: AttributionEnvelope
}): NecessityViolation[] {
  const { family, envelope } = input
  const out: NecessityViolation[] = []

  if (envelope.subject === undefined || typeof envelope.subject.id !== 'string') {
    out.push({
      slot: 'subject',
      code: 'subject_missing',
      detail: 'subject 必须由 canonical domain owner 派生出来（不能缺、不能是空壳）',
    })
  }

  if (envelope.attributionOrigin === 'MIGRATED_LEGACY') {
    return [...out, ...validateMigratedLegacyEnvelope(family, envelope)]
  }

  const matrix = NECESSITY_MATRIX[family]
  const slots: { slot: AttributionValueSlot; cell: NecessityState; authority: boolean }[] = [
    { slot: 'initiator', cell: matrix.initiator, authority: false },
    { slot: 'actor', cell: matrix.actor, authority: false },
    { slot: 'executor', cell: matrix.executor, authority: false },
    { slot: 'authority', cell: matrix.authority, authority: true },
    { slot: 'recordedBy', cell: matrix.recordedBy, authority: false },
    { slot: 'contentOriginator', cell: matrix.contentOriginator, authority: false },
  ]

  for (const item of slots) {
    const raw = envelope[item.slot]
    out.push(...mixedStateViolations(item.slot, raw))
    const reading = readValue(raw as AttributionValue<unknown>)
    // 非法形状只报 invalid_mixed_state，**不**再猜它像哪一种三态（否则会多报一条误导性的违规）
    if (reading !== undefined) {
      out.push(...structuralViolations(item.slot, reading, item.authority))
      out.push(...checkCell(item.slot, item.cell, reading))
    }
  }

  return out
}

/** 失败关闭版本：有违规就抛（写入路径只能调它，不能只调 validator 然后忘记判断） */
export function assertAttributionNecessity(input: {
  family: AttributionEventFamily
  envelope: AttributionEnvelope
}): void {
  const violations = validateAttributionNecessity(input)
  if (violations.length === 0) return
  throw new KernelError(
    'validation_error',
    'attribution_necessity_violation',
    `归因必要性校验失败（${input.family}）：` +
      violations.map((v) => `${v.slot}/${v.code}`).join(' · '),
    {
      family: input.family,
      violations: violations.map((v) => ({ slot: v.slot, code: v.code, detail: v.detail })),
    }
  )
}

// ---------------------------------------------------------------------------
// Attestation 边界（ADR-042 §3.2 / §3.3）：authority-bearing 字段不得由不可信调用方自报
// ---------------------------------------------------------------------------

/**
 * **外部调用方不得直接决定**的三个槽位（`G-AT-4`）。
 *
 * 它们只能由 trusted ingress 依据**可信来源**建立：
 *   · `contentOriginator` —— Fact Firewall 唯一的晋级依据
 *   · `authority`         —— 有副作用就必须有许可
 *   · `executor`          —— "谁真的执行了"不能被请求方自称
 */
export const UNTRUSTED_ATTRIBUTION_FIELDS = ['contentOriginator', 'authority', 'executor'] as const

export type UntrustedAttributionField = (typeof UNTRUSTED_ATTRIBUTION_FIELDS)[number]

/**
 * 外部输入 DTO **不得携带同名归因字段**（ADR-042 §3.3）。
 *
 * 三种合法处置：拒绝 / 由可信来源覆盖 / 让字段根本传不进来。
 * 这里实现的是第一种（fail closed）—— 其余两种属于 WP4 的写入路径。
 */
export function assertNoUntrustedAttributionFields(dto: Record<string, unknown>): void {
  const hits = UNTRUSTED_ATTRIBUTION_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(dto, field)
  )
  if (hits.length === 0) return
  throw new KernelError(
    'validation_error',
    'untrusted_attribution_field',
    `外部输入里不允许出现归因字段：${hits.join(' / ')}` +
      '（这些槽位只能由 trusted ingress 建立，ADR-042 §3.3）',
    { fields: [...hits] }
  )
}

/** trusted ingress 的标记（类型层：外部 DTO 不可能"顺手"长成这个形状） */
export const TRUSTED_INGRESS_MARK = 'M5.1.1/trusted-ingress'

/** 只有经过 trusted ingress 构造的归因才带这个标记 */
export type TrustedAttribution = AttributionEnvelope & {
  readonly trustedIngress: typeof TRUSTED_INGRESS_MARK
}

/**
 * 构造**可信归因**（WP4 的写入路径会用它）。
 *
 * 边界形状（ADR-042 §3.2）：
 *
 *     Untrusted DTO → Trusted Ingress → Attribution Construction → Ledger
 *
 * 调用方如果自报 `contentOriginator` / `authority` / `executor`，直接**拒绝**
 * （不是"忽略后照用"）—— 因为"静默覆盖"与"信任"在账本上看起来一样。
 */
export function constructTrustedAttribution(input: {
  family: AttributionEventFamily
  envelope: AttributionEnvelope
  /** 调用方**自称**提供过的字段名（含 untrusted DTO 的键） */
  callerSuppliedFields?: readonly string[]
  /** 原始外部输入（若还在手上）：直接扫描同名键 */
  untrustedDto?: Record<string, unknown>
}): TrustedAttribution {
  if (input.untrustedDto !== undefined) {
    assertNoUntrustedAttributionFields(input.untrustedDto)
  }
  const declared = input.callerSuppliedFields ?? []
  const illegal = declared.filter((field) =>
    (UNTRUSTED_ATTRIBUTION_FIELDS as readonly string[]).includes(field)
  )
  if (illegal.length > 0) {
    throw new KernelError(
      'validation_error',
      'untrusted_attribution_field',
      `调用方不得自报归因字段：${illegal.join(' / ')}（ADR-042 §3.2）`,
      { fields: illegal }
    )
  }
  assertAttributionNecessity({ family: input.family, envelope: input.envelope })
  return { ...input.envelope, trustedIngress: TRUSTED_INGRESS_MARK }
}

/** 该值是否已经过 trusted ingress */
export function isTrustedAttribution(value: unknown): value is TrustedAttribution {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { trustedIngress?: unknown }).trustedIngress === TRUSTED_INGRESS_MARK
  )
}

// ---------------------------------------------------------------------------
// 便利构造（测试与 WP4 的夹具都读这里，避免各写一份）
// ---------------------------------------------------------------------------

/** 从一个三态值取"人可读的结论"（三态必须渲染得**不一样**，U-14 / R6） */
export function describeAttributionValue(value: AttributionValue<PrincipalRef | AuthorityRef>): string {
  switch (value.state) {
    case 'KNOWN': {
      const kind = value.value.kind
      const id = 'id' in value.value ? value.value.id : value.value.ref
      return `Known(${kind}/${id})`
    }
    case 'UNKNOWN':
      return value.reason === 'LEGACY_UNRECORDED'
        ? 'Unknown(历史未记录)'
        : 'Unknown(运行时未确定)'
    case 'ABSENT':
      return 'Absent(不适用)'
  }
}

// ---------------------------------------------------------------------------
// M5.1.1 / Phase 4a —— **来源资格**（`SourceQualification`）
// ---------------------------------------------------------------------------

/**
 * **当前来源资格** —— ADR-043 `DR-2` / `DR-3`。
 *
 * ============================================================================
 *  ⚠️ 它**不是** `MemoryAuthority` 的一档（ADR-043 §3.5 的三条理由）
 * ============================================================================
 * ```text
 * `MemoryAuthority`   回答"这条**证据**有多强"（证据的属性，写入时判定、落库、不可变）
 * `SourceQualification` 回答"我们**知不知道**这条内容从哪来"（知识的属性，读时派生）
 * ```
 * 把后者塞进前者的阶梯，会让"不知道怎么归类"退化成"权威低一点" ——
 * 而那正是 `authorityFromSource()` 里两段注释**明令拒绝**的回落。
 *
 * 三值不可互相折叠（`DR-3`）：
 * ```text
 * ESTABLISHED          来源已确立，且指向有资格支持该类结论的来源
 * UNCONFIRMED_ORIGIN   来源**未确立**（不知道）
 * CONTRADICTED_ORIGIN  来源**已确立，但它不是人类**，而这条记忆却声称是用户事实（**知道不是他**）
 * ```
 * 后两者对"能不能建立用户事实"的答案是**一样**的（都不能），
 * 但对"该怎么说"是不同的 —— 所以**不合并**。
 */
export type SourceQualification = 'ESTABLISHED' | 'UNCONFIRMED_ORIGIN' | 'CONTRADICTED_ORIGIN'

export const SOURCE_QUALIFICATIONS: readonly SourceQualification[] = [
  'ESTABLISHED',
  'UNCONFIRMED_ORIGIN',
  'CONTRADICTED_ORIGIN',
]

export function isSourceQualification(value: unknown): value is SourceQualification {
  return typeof value === 'string' && (SOURCE_QUALIFICATIONS as readonly string[]).includes(value)
}

/**
 * **两个结构化拒绝理由码**（ADR-043 §4.1 / 4a）。
 *
 * 它们与既有的 `evidence_cannot_support_external_fact` **并存**：
 * 新闸在**权威推导之前**判"来源够不够格"，既有闸在**之后**判"证据能不能支持外部事实"。
 * 两者是**追加**关系，不是替换关系 —— 既有判据的语义一个字未改（用户 4a 执行令）。
 */
export const EVIDENCE_ORIGIN_NOT_ESTABLISHED = 'evidence_origin_not_established' as const
export const EVIDENCE_ORIGIN_CONTRADICTS_CLAIM = 'evidence_origin_contradicts_claim' as const
export const SOURCE_QUALIFICATION_REJECTION_CODES = [
  EVIDENCE_ORIGIN_NOT_ESTABLISHED,
  EVIDENCE_ORIGIN_CONTRADICTS_CLAIM,
] as const

/**
 * **受信**来源读数。
 *
 * ⚠️ `attributionOrigin` 只可能是 `'RECORDED'` —— 这个类型本身就是"只装受信行"的证据：
 *    `MIGRATED_LEGACY` 与"没有信封"都**不配**构成本结构（它们一律是 `UNCONFIRMED_ORIGIN`）。
 *    这不是风格问题：`DR-6` 要求"已确立"只认**受信归因**，调用方自报的 `provenance` 不算。
 */
export interface TrustedOriginReading {
  readonly attributionOrigin: 'RECORDED'
  readonly contentOriginator: AttributionValue<PrincipalRef>
  /** 该行 Axis B 是否落在 **confirmed** 分支（`classifyRecordedAxisB` 的结论） */
  readonly axisBConfirmed: boolean
}

/** `AttributionValue<unknown>` → `AttributionValue<PrincipalRef>`（窄化；失败 → `undefined`，**不猜**） */
export function principalValueOf(value: AttributionValue<unknown>): AttributionValue<PrincipalRef> | undefined {
  if (value.state === 'ABSENT') return { state: 'ABSENT' }
  if (value.state === 'UNKNOWN') return { state: 'UNKNOWN', reason: value.reason }
  const raw = value.value
  if (typeof raw !== 'object' || raw === null) return undefined
  const candidate = raw as { kind?: unknown; id?: unknown }
  if (
    typeof candidate.kind !== 'string' ||
    typeof candidate.id !== 'string' ||
    !(PRINCIPAL_KINDS as readonly string[]).includes(candidate.kind)
  ) {
    return undefined
  }
  return { state: 'KNOWN', value: { kind: candidate.kind as PrincipalKind, id: candidate.id } }
}

/**
 * 从**事件面**的读数组装 `TrustedOriginReading`。
 *
 * 三条"不成立"的路径都返回 `undefined`（= 来源未确立，**失败关闭**）：
 * ```text
 * · `attribution_origin !== 'RECORDED'`（MIGRATED_LEGACY / 无信封 / 非法值）
 * · 没有 `contentOriginator` 槽位
 * · 槽位值不是合法的 `PrincipalRef`（形状坏了 —— 不猜一个位次出来）
 * ```
 */
export function trustedOriginReadingOf(input: {
  attributionOrigin: string | undefined
  contentOriginator: AttributionValue<unknown> | undefined
  axisB: { sourceKind: SourceKind; sourceAuthority: SourceAuthority; epistemicSource: EpistemicSource }
}): TrustedOriginReading | undefined {
  if (input.attributionOrigin !== 'RECORDED') return undefined
  if (input.contentOriginator === undefined) return undefined
  const contentOriginator = principalValueOf(input.contentOriginator)
  if (contentOriginator === undefined) return undefined
  const verdict = classifyRecordedAxisB(input.axisB)
  return {
    attributionOrigin: 'RECORDED',
    contentOriginator,
    axisBConfirmed: verdict.ok && verdict.branch === 'confirmed',
  }
}

/**
 * `SourceQualification` 的**唯一**派生（ADR-043 §3.2；`COGNITIVE_QUALIFICATION_RULE_VERSION = 1`）。
 *
 * ```text
 * 1. 没有受信读数（无信封 / MIGRATED_LEGACY / 形状坏了）      → UNCONFIRMED_ORIGIN
 * 2. 有受信读数，但 Axis B 不在 confirmed 分支                → UNCONFIRMED_ORIGIN（失败关闭）
 * 3. 有受信读数，contentOriginator = Known(USER)              → ESTABLISHED
 * 4. 有受信读数，contentOriginator = Known(其它位次)           → CONTRADICTED_ORIGIN
 * 5. 有受信读数，contentOriginator = Unknown / Absent          → UNCONFIRMED_ORIGIN
 * ```
 *
 * ⚠️ 它**只**回答"来源资格"，**不**回答"这条证据能不能支持外部事实"
 *    （那是 `canSupportExternalFact` / 既有闸 4 的语义，本 ADR **不许**动它）。
 */
export const COGNITIVE_QUALIFICATION_RULE_VERSION = 1

export function sourceQualificationOf(reading: TrustedOriginReading | undefined): SourceQualification {
  if (reading === undefined) return 'UNCONFIRMED_ORIGIN'
  if (!reading.axisBConfirmed) return 'UNCONFIRMED_ORIGIN'
  const contentOriginator = reading.contentOriginator
  if (contentOriginator.state !== 'KNOWN') return 'UNCONFIRMED_ORIGIN'
  return contentOriginator.value.kind === 'USER' ? 'ESTABLISHED' : 'CONTRADICTED_ORIGIN'
}

/** 该资格是否**够格**建立"关于用户个人的事实"（`person_fact` / `preference`） */
export function qualificationEstablishesUserFact(qualification: SourceQualification): boolean {
  return qualification === 'ESTABLISHED'
}
