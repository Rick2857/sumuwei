/**
 * M5.1.1 / WP9-B2 —— **生产状态引导（state bootstrap）组件自己的受信身份**
 * 与 `state_transition` 归因信封的唯一生产者。
 *
 * ============================================================================
 *  这个文件回答的问题（用户裁定的 WP9-B2 授权范围）
 * ============================================================================
 *
 * ```text
 *   首次建档这条状态转移，是**系统自己发起**的 —— 那么，"系统"是谁？
 * ```
 *
 * WP9-B1 落地的是**能力 + 边界**：`recordStateEvent` 只接受带
 * `TRUSTED_INGRESS_MARK` 的信封（手写同形对象 / 结构克隆 / JSON 往返一律拒绝），
 * 但 `src/state/init.ts` **没有**接线 ⇒ 今天生产里没有任何一条 `state_events`
 * 带信封（`attribution_origin` 恒为 NULL），`E4-A = OPEN`（`WP9-GAP-1`）。
 * 本文件就是那个缺口的**受信身份**来源。
 *
 * ============================================================================
 *  冻结的身份（用户裁定，不得增改）
 * ============================================================================
 *
 * ```text
 *   SYSTEM component : SYSTEM/state-bootstrap
 *   SYSTEM_RULE      : SYSTEM_RULE/state-bootstrap-rule
 * ```
 *
 * 口径逐格对应契约里冻结的矩阵行
 * （`attribution.ts` 的 `state_transition: row('REQUIRED','REQUIRED','ABSENT','REQUIRED','REQUIRED','ABSENT')`）：
 *
 * ```text
 *   subject           ← DERIVED（canonical owner）⇒ CHARACTER/<character_id>；不落列
 *   initiator         ← 受信证据：Known(SYSTEM/state-bootstrap)；**没有证据**就 Unknown(RUNTIME_UNRESOLVED)
 *   actor             ← 与 initiator 同一份受信证据（两者相等是**合法**的：ADR-042 B6
 *                       —— "值相等不是违规，无证据推导才是"；`src/state/**` 今天没有
 *                       决定者/施加者的分离，所以它们是同一个位次）
 *   executor          ← Absent（矩阵要求；**这是结论不是占位**：没有独立的执行者）
 *   authority         ← 受信证据：Known(SYSTEM_RULE/state-bootstrap-rule)；无证据则 Unknown(RUNTIME_UNRESOLVED)
 *   recordedBy        ← canonical ledger recorder：Known(SYSTEM/kernel)
 *                       （**唯一**值提供者是 `CANONICAL_LEDGER_RECORDER`，本模块不新增第二个 recorder）
 *   contentOriginator ← Absent（状态转移**不是内容主张**）
 *   attributionOrigin ← RECORDED
 * ```
 *
 * ============================================================================
 *  Hard Gate：**普通 `initCharacterState` 调用本身不构成鉴证**
 * ============================================================================
 * 用户裁定的硬门原文：
 *
 * > Only the trusted production bootstrap may establish this SYSTEM identity and
 * > SYSTEM_RULE authority. The ordinary initCharacterState call must not itself
 * > be sufficient attestation.
 *
 * 因此本文件**没有**、也不得出现这样的形状：
 *
 * ```text
 *   ✗ new PrincipalRefBuilder({ component: 'state-bootstrap' })   // 谁都能填
 *   ✗ stateTransitionAttributionOf({ initiator: { kind: 'SYSTEM', id: '…' } })
 *   ✗ function attest(componentId: string)                        // 调用方自报组件名
 * ```
 *
 * 只有**一个**具名工厂 `attestStateBootstrapComponentIdentity()`，它：
 *   · **不接受任何参数**（调用方无法指定 principal / authority，
 *     也无法把身份重定向到 `SYSTEM/<别的 id>`）；
 *   · 产出的是**不透明证据 token**（品牌类型 + 运行期 `WeakSet` 登记）——
 *     手写同形对象、`{...evidence}`、`JSON.parse(JSON.stringify(evidence))`
 *     全部**不是**证据，`isTrustedStateBootstrapEvidence()` 会让它们失败关闭；
 *   · 与 `conversation-attribution.ts`（K-28）同一套纪律：
 *     "谁可以调这个工厂"仍然是一条**约定**（能 import 本模块并被装配根调用的人
 *     就是受信装配点），但那条约约定现在是**一个命名清楚、无参数的入口**，
 *     而不是一个谁都能填的枚举。本 WP 的门用**静态判据**钉住它：
 *     该工厂在生产代码里**恰好一个**调用点，且必须位于装配根 `src/main.ts`。
 *
 * ============================================================================
 *  E4-B：**没有**受信因果证据时如实 Unknown，绝不从"事件长什么样"反推
 * ============================================================================
 * `state_transition` 的矩阵行是 `REQUIRED`，而 `REQUIRED` **允许**
 * `Unknown(RUNTIME_UNRESOLVED)`、**不允许** `Absent`（裁定 U-04）。
 * 所以"这次状态转移没有受信的发起者证据"必须被**表达**出来，而不是折叠成
 * `Absent`、也不是从下面的东西**猜**一个 `Known(SYSTEM/*)`：
 *
 * ```text
 *   trigger = 'init'                       ✗ "首启" 不是 "系统是谁"
 *   state_event / state_transition 族名/表名  ✗ 名字不是证据
 *   payload（before/delta/after/reason）    ✗ 数据不是发起者
 *   actor_type                             ✗ 归属**声明**不是作者**证明**（M5.1-D01）
 *   requestedBy / transport                ✗ 请求方自报 / 通道不是身份
 * ```
 *
 * 见契约的 `STATE_TRANSITION_SYSTEM_ORIGIN_RULE`（R-45 冻结语义）。
 */

import { KernelError } from '../kernel/contracts/ids.ts'
import {
  attributionAbsent,
  attributionKnown,
  attributionUnknown,
  type AttributionValue,
  type PrincipalRef,
} from '../kernel/contracts/actor.ts'
import {
  CANONICAL_LEDGER_RECORDER,
  assertNoUntrustedAttributionFields,
  constructTrustedAttribution,
  type AuthorityRef,
  type AttributionEnvelope,
  type TrustedAttribution,
} from '../kernel/contracts/attribution.ts'

// ---------------------------------------------------------------------------
// 冻结的身份（用户裁定；B2 不得增改这两个常量）
// ---------------------------------------------------------------------------

/** 冻结的 SYSTEM 组件 id（用户裁定：`SYSTEM/state-bootstrap`） */
export const STATE_BOOTSTRAP_COMPONENT_ID = 'state-bootstrap' as const

/** 冻结的 SYSTEM_RULE ref（用户裁定：`SYSTEM_RULE/state-bootstrap-rule`） */
export const STATE_BOOTSTRAP_RULE_REF = 'state-bootstrap-rule' as const

/**
 * 状态引导组件**自己**的位次。
 *
 * ⚠️ 只有本模块能把它装进信封。`src/state/init.ts` **不**出现这个字面量
 * （门的静态判据之一）—— 那正是"普通 `initCharacterState` 调用本身不构成鉴证"
 * 的可测形式。
 */
export const STATE_BOOTSTRAP_COMPONENT: PrincipalRef = Object.freeze({
  kind: 'SYSTEM' as const,
  id: STATE_BOOTSTRAP_COMPONENT_ID,
})

/**
 * 状态引导的**真实系统规则**：首次建档按初始值建档，是这条规则授权的。
 * 它不是"能力白名单"，也不是调用方可填的字段。
 */
export const STATE_BOOTSTRAP_AUTHORITY: AuthorityRef = Object.freeze({
  kind: 'SYSTEM_RULE' as const,
  ref: STATE_BOOTSTRAP_RULE_REF,
})

/** `state_transition` 族名（本模块只产这一族） */
export const STATE_BOOTSTRAP_FAMILY = 'state_transition' as const

// ---------------------------------------------------------------------------
// 受信证据 token（不透明；品牌类型 + 运行期 WeakSet）
// ---------------------------------------------------------------------------

/**
 * 品牌**不导出** ⇒ 外部代码在类型层造不出满足类型标注的值；
 * 运行期再用 `WeakSet` 挡一次结构克隆。
 */
const BOOTSTRAP_EVIDENCE_BRAND: unique symbol = Symbol('m5.1.1.state-bootstrap-evidence')
const REGISTERED_BOOTSTRAP_EVIDENCE = new WeakSet<object>()

/**
 * 状态引导组件**自己的受信身份证据**。
 *
 * ⚠️ 它**不是**一个 DTO：没有任何字段能让调用方改写 principal 或 authority。
 * 两个引用字段都直接来自上面的冻结常量。
 */
export interface StateBootstrapEvidence {
  readonly [BOOTSTRAP_EVIDENCE_BRAND]: 'state-bootstrap-evidence'
  /** 组件的规范化 id（= 冻结常量；用于证据可追溯性） */
  readonly componentId: typeof STATE_BOOTSTRAP_COMPONENT_ID
  /** 由组件自己建立的身份：`SYSTEM/state-bootstrap` */
  readonly principal: PrincipalRef
  /** 由组件自己建立的授权：`SYSTEM_RULE/state-bootstrap-rule` */
  readonly authority: AuthorityRef
  /** 谁鉴证的（与 K-25 的证据 token 同形；写进门的证据） */
  readonly attestedBy: 'state-bootstrap-component'
}

/**
 * **生产状态引导组件自己的受信身份** —— 唯一能建立
 * `Known(SYSTEM/state-bootstrap)` + `Known(SYSTEM_RULE/state-bootstrap-rule)` 的入口。
 *
 * 无参数（这是本 WP 硬门的形状：调用方**无法**指定身份，也**无法**把组件名
 * 重定向到 `SYSTEM/<别的 id>`）。生产装配根 `src/main.ts` 是它唯一的调用点。
 */
export function attestStateBootstrapComponentIdentity(): StateBootstrapEvidence {
  const evidence: StateBootstrapEvidence = {
    [BOOTSTRAP_EVIDENCE_BRAND]: 'state-bootstrap-evidence',
    componentId: STATE_BOOTSTRAP_COMPONENT_ID,
    principal: STATE_BOOTSTRAP_COMPONENT,
    authority: STATE_BOOTSTRAP_AUTHORITY,
    attestedBy: 'state-bootstrap-component',
  }
  REGISTERED_BOOTSTRAP_EVIDENCE.add(evidence)
  return Object.freeze(evidence)
}

/**
 * 运行期守卫：只有**本模块工厂产出过**的 token 才通过。
 *
 * 手写同形对象 / 结构克隆 / JSON 往返 ⇐ `false`（与
 * `isTrustedAttestationEvidence` / `isTrustedAttribution` 同一纪律）。
 */
export function isTrustedStateBootstrapEvidence(value: unknown): value is StateBootstrapEvidence {
  return typeof value === 'object' && value !== null && REGISTERED_BOOTSTRAP_EVIDENCE.has(value)
}

// ---------------------------------------------------------------------------
// `state_transition` 信封（唯一生产构造点）
// ---------------------------------------------------------------------------

/** 生产者的事实输入 —— **只有** canonical domain owner 的派生输入，没有任何身份字段 */
export interface StateTransitionFacts {
  /** canonical 角色 id（由 kernel 给出；envelope 的 `subject` 由它派生为 `CHARACTER/<id>`） */
  readonly characterId: string
  /**
   * 组件的受信身份证据。
   *
   * ⚠️ **不给**是合法且诚实的一种形状（E4-B）：矩阵里 `initiator` / `authority`
   * 是 `REQUIRED`，而 `REQUIRED` 允许 `Unknown(RUNTIME_UNRESOLVED)` ——
   * 于是"这次转移没有受信的发起者证据"被**如实记录**，而不是被折叠成 `Absent`，
   * 更不是从 `trigger='init'` / payload / 族名**推断**一个 `Known(SYSTEM/*)`。
   */
  readonly evidence?: StateBootstrapEvidence
}

const initiatorOf = (
  evidence: StateBootstrapEvidence | undefined
): AttributionValue<PrincipalRef> =>
  evidence === undefined
    ? attributionUnknown<PrincipalRef>('RUNTIME_UNRESOLVED')
    : attributionKnown<PrincipalRef>(evidence.principal)

const authorityOf = (
  evidence: StateBootstrapEvidence | undefined
): AttributionValue<AuthorityRef> =>
  evidence === undefined
    ? attributionUnknown<AuthorityRef>('RUNTIME_UNRESOLVED')
    : attributionKnown<AuthorityRef>(evidence.authority)

/**
 * 构造首启 `state_transition` 的**可信归因信封**（`src/state/init.ts` 唯一的调用点）。
 *
 * 失败关闭的三条（都在 `constructTrustedAttribution` 之前发生，或由它强加）：
 *   ① `facts` 里夹带 `contentOriginator` / `authority` / `executor` ⇒ 抛
 *      （`assertNoUntrustedAttributionFields`，与对话 ingress 同一守卫）；
 *   ② `evidence` 给了但不是**本模块工厂**产出的 token ⇒ 抛
 *      （`untrusted_state_bootstrap_evidence`）—— 这就是"调用方自报
 *      `SYSTEM/<id>` 不得进入权威槽位"的执行点；
 *   ③ 信封过 **canonical** `assertAttributionNecessity`（由
 *      `constructTrustedAttribution` 内部调用）—— 判据只有一份，不在这里新造。
 */
export function stateTransitionAttributionOf(facts: StateTransitionFacts): TrustedAttribution {
  // ① 外部字段守卫（"静默忽略"与"信任"在账本上看起来一样，ADR-042 §3.3）
  assertNoUntrustedAttributionFields(facts as unknown as Record<string, unknown>)

  if (facts.characterId === '') {
    throw new KernelError(
      'validation_error',
      'state_transition_subject_missing',
      'state_transition 的 subject 必须由 canonical domain owner 派生（CHARACTER/<character_id>）——' +
        'characterId 为空 ⇒ 没有可派生的主体，拒绝构造信封'
    )
  }

  // ② 身份证据必须是本模块工厂产出的 token（结构克隆 / 手写同形对象失败关闭）
  const evidence = facts.evidence
  if (evidence !== undefined && !isTrustedStateBootstrapEvidence(evidence)) {
    throw new KernelError(
      'validation_error',
      'untrusted_state_bootstrap_evidence',
      'state_transition 的 SYSTEM 身份只能来自状态引导组件**自己的**受信身份证据' +
        '（attestStateBootstrapComponentIdentity() 产出的 token）；手写同形对象 / 结构克隆 / ' +
        'JSON 往返一律拒绝 —— 调用方不得自报 SYSTEM/<id>，也不得自报 SYSTEM_RULE/<ref>' +
        '（R-45 的 STATE_TRANSITION_SYSTEM_ORIGIN_RULE）'
    )
  }

  const envelope: AttributionEnvelope = {
    // subject = DERIVED（canonical owner）；**不落列**（U-13）：
    // `user_id` 是关系维度，留在行上，不进信封。
    subject: { kind: 'CHARACTER', id: facts.characterId },
    initiator: initiatorOf(evidence),
    actor: initiatorOf(evidence),
    executor: attributionAbsent<PrincipalRef>(),
    authority: authorityOf(evidence),
    recordedBy: attributionKnown<PrincipalRef>({
      kind: CANONICAL_LEDGER_RECORDER.kind as PrincipalRef['kind'],
      id: CANONICAL_LEDGER_RECORDER.id,
    }),
    contentOriginator: attributionAbsent<PrincipalRef>(),
    attributionOrigin: 'RECORDED' as const,
  }

  // ③ canonical 必要性判据 + 受信标记（`TRUSTED_INGRESS_MARK` 只能由它盖）
  return constructTrustedAttribution({ family: STATE_BOOTSTRAP_FAMILY, envelope })
}
