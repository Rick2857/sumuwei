/**
 * CharacterState 的启动初始化。
 *
 * 必须在**数据库迁移完成之后**调用，原因见 src/plugin/persistent-character.ts
 * 顶部注释：插件的 init 早于插件迁移执行，那时我们的表还不存在。
 *
 * ============================================================================
 *  WP9-B2 —— 首启这条 `state_transition` 的**受信归因**（R-45）
 * ============================================================================
 * 首次建档是一次**系统自己发起**的状态转移，落进 `state_events`
 * （`trigger = 'init'`）。它的归因信封由**状态引导组件自己的受信身份**
 * （`./bootstrap-attestation.ts`）构造，再由 B1 已经在位的受信边界
 * （`recordStateEvent` 只收带 `TRUSTED_INGRESS_MARK` 的信封）写进权威槽位。
 *
 * ⚠️ **Hard Gate**：本文件**不得**自己建立 SYSTEM 身份或 SYSTEM_RULE 授权。
 * 它只**消费**证据 token：
 *
 * ```text
 *   生产装配根（src/main.ts）── attestStateBootstrapComponentIdentity() ──▶ 证据 token
 *                                                                              │
 *                                        initCharacterState(…, { bootstrapEvidence })
 *                                                                              ▼
 *                                             stateTransitionAttributionOf(…)
 *                                                                              ▼
 *                                     TrustedAttribution（带 TRUSTED_INGRESS_MARK）
 * ```
 *
 * 因此：
 *   · 普通调用 `initCharacterState(runtime, characterId, userId)` **不构成鉴证** ——
 *     它写出的信封如实记 `Unknown(RUNTIME_UNRESOLVED)`（E4-B），而**不是**
 *     `Known(SYSTEM/state-bootstrap)`；
 *   · 本文件里**没有** `'SYSTEM'` / `'SYSTEM_RULE'` / `'state-bootstrap'` 字面量
 *     （门的静态判据之一）；
 *   · `trigger = 'init'` 是**呈现事实**，绝不是身份证据
 *     （`STATE_TRANSITION_SYSTEM_ORIGIN_RULE`）。
 */

import { logger, type IAgentRuntime } from '@elizaos/core'

import type { TrustedAttribution } from '../kernel/contracts/attribution.ts'

import {
  stateTransitionAttributionOf,
  type StateBootstrapEvidence,
} from './bootstrap-attestation.ts'
import { resolveCurrentState } from './provider.ts'
import {
  ensureStateTables,
  loadState,
  recordStateEvent,
  saveState,
} from './repository.ts'
import { createInitialState, type CharacterState } from './types.ts'

export interface StateInitResult {
  state: CharacterState
  /** 本次是否为首次建档 */
  created: boolean
  /**
   * 本次首启写出的 `state_events` 行的**真实 id**（非首启时为 `undefined`）。
   *
   * 存在的理由（WP9-B2 §"Next WP Preconditions" 第 5 条）：L1（写入路径的返回值）
   * 与 L2（物理账本行）必须用**真实键**关联，而不是文本对应。
   */
  stateEventId?: string
}

/** `initCharacterState` 的可选输入（B2 新增；缺省 = 今天的所有既有调用点） */
export interface StateInitOptions {
  /**
   * 状态引导组件**自己的受信身份证据**（`./bootstrap-attestation.ts` 的工厂产出）。
   *
   * 只有生产装配根 `src/main.ts` 会传它。**不传**（或传一个不是该工厂产出的
   * 同形对象）时的语义：
   *   · 不传 ⇒ 信封如实记 `Unknown(RUNTIME_UNRESOLVED)`（E4-B）；
   *   · 传了但不是受信 token ⇒ 失败关闭抛错（调用方不得自报身份）。
   */
  bootstrapEvidence?: StateBootstrapEvidence
}

/**
 * 建表 + 首次建档。
 *
 * 首次建档会写一条 `trigger = 'init'` 的 state_event，
 * 这样「她为什么一开始是信任 0.85」在审计里是**有出处的**，
 * 而不是数据库里凭空出现的一个数字。
 */
export async function initCharacterState(
  runtime: IAgentRuntime,
  characterId: string,
  userId: string,
  options: StateInitOptions = {}
): Promise<StateInitResult> {
  await ensureStateTables(runtime)

  const existing = await loadState(runtime, characterId, userId)
  const isFirstRun = await isFreshRow(runtime, characterId, userId, existing)

  if (!isFirstRun) {
    const { state } = await resolveCurrentState(runtime, characterId, userId)
    logger.info(
      `[character-state] 载入状态 v${state.version}：` +
        `valence=${state.valence.toFixed(3)} arousal=${state.arousal.toFixed(3)} ` +
        `trust=${state.trust.toFixed(3)} closeness=${state.closeness.toFixed(3)}`
    )
    return { state, created: false }
  }

  // 首次：显式写入初始状态 + 审计事件
  const initial = createInitialState(characterId, userId)
  await saveState(runtime, initial, { touchInteraction: false })
  const attribution: TrustedAttribution = stateTransitionAttributionOf({
    characterId,
    ...(options.bootstrapEvidence !== undefined
      ? { evidence: options.bootstrapEvidence }
      : {}),
  })
  const { id: stateEventId } = await recordStateEvent(runtime, {
    before: initial,
    delta: {
      trust: initial.trust,
      closeness: initial.closeness,
      valence: initial.valence,
      arousal: initial.arousal,
    },
    after: initial,
    reason:
      '首次建档：trust 依据「从小一起长大、对我很信赖」给 0.85；' +
      'closeness 依据「同校、日常能见面」给 0.60（刻意不拉满，为长期分开的下行留空间）',
    trigger: 'init',
    attribution,
  })

  logger.info(
    `[character-state] 首次建档完成：trust=${initial.trust} closeness=${initial.closeness} ` +
      `valence=${initial.valence} arousal=${initial.arousal} ` +
      `（state_event=${stateEventId}）`
  )
  return { state: initial, created: true, stateEventId }
}

/**
 * 判断这一行是不是刚被建出来的空行。
 *
 * `loadState` 在查不到时会顺手建档（保证状态真实存在），
 * 所以无法只看「有没有行」；用 version 与 updatedAt===createdAt 判断更可靠。
 */
async function isFreshRow(
  _runtime: IAgentRuntime,
  _characterId: string,
  _userId: string,
  state: CharacterState
): Promise<boolean> {
  return state.version === 0 && state.updatedAt === state.createdAt
}
