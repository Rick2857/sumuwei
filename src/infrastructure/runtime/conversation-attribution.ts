/**
 * M5.1.1 WP6.1 —— **对话 ingress 的受信归因装配**（K-28 的唯一生产构造点）。
 *
 * ============================================================================
 *  这个文件回答的问题
 * ============================================================================
 *
 * ```text
 *   一条对话事件被写进账本时，谁**决定并产生**了它（actor）、
 *   这段语义内容**是谁提供的**（contentOriginator）？
 * ```
 *
 * WP4 把**写入路径**（受信上下文 → 18 个槽位列 + origin）做好了，WP6 把**读路径**
 * （存储列 → 三态 DTO）做好了，但全 `src/` 里**没有**任何生产代码调用
 * `buildTrustedAttributionContext()` ⇒ 生产里的 `conversation_events` 行
 * 一律是 legacy（`attribution_origin` 为 NULL），读到的是"由 `actor_type`
 * 推导出来的"值 —— 那正是 D01 的形状（**角色不是作者证明**）。
 * 本文件就是那个缺口（K-28）的接线点。
 *
 * ----------------------------------------------------------------------------
 *  为什么是**三个具名工厂**，而不是一个 `role` 参数
 * ----------------------------------------------------------------------------
 * ADR-042 §3.3 / K-25 §2：外部载荷**不得**凭一个枚举字段提权。
 * 因此这里**没有**、也不得出现这样的形状：
 *
 * ```text
 *   ✗ createConversationIngress({ role: 'human_console' })   // 谁都能填
 * ```
 *
 * 只有三个**角色专用**的工厂，各自绑定一个事件族与一个真实的装配位置：
 *
 * ```text
 *   createHumanConsoleUserTurnIngress()     交互式人类控制台（readline）
 *   createAgentRunnerUserTurnIngress()      程序化一次性入口（tsx src/main.ts "…"）
 *   createCharacterAssistantTurnIngress()   角色的输出边界（completeTurn → Resolver）
 * ```
 *
 * "谁可以调用这些工厂"仍然是一条**约定**（能 import 本模块并调用它的人就是受信
 * 装配点），但那条约定现在是**显式的、三个命名清楚的入口**，而不是一个谁都能填的
 * 枚举；而且每个工厂的产物只能说自己那一族，跨族调用失败关闭。
 *
 * ----------------------------------------------------------------------------
 *  与 `actor_type` 的关系（D01 的核心）
 * ----------------------------------------------------------------------------
 * `actor_type` 是**呈现角色**（用户界面上"谁在说话"），它与 `actor` /
 * `contentOriginator` **并列但不要求相等**：
 *
 * ```text
 *   人类控制台    actor_type=user       actor=Known(USER/<id>)            confirmed
 *   agent 一次性  actor_type=user       actor=Known(SERVICE/agent-runner)  unconfirmed
 *   她的输出      actor_type=character  actor=Known(CHARACTER/<canonical>) confirmed
 * ```
 *
 * 第二行就是 D01 的**生产控制**：程序化入口替用户提交的话，仍以 `user_message`
 * 呈现（legacy 表面不变），但**权威槽位**说清了它不是用户本人提供的，
 * 且 Axis B 是 **unconfirmed**（`UNCONFIRMED_ORIGIN` ×2）—— 表面身份本身
 * 不足以建立认知资格（K-24 / K-25 §4）。
 */

import {
  assertNoUntrustedAttributionFields,
  attestActorFromDecisionPoint,
  attestContentOriginatorFromIngress,
  attestEpistemicConfirmation,
  buildTrustedAttributionContext,
  type ConversationFamily,
  type TrustedAttributionContext,
} from '../../kernel/contracts/attribution.ts'
import { KernelError } from '../../kernel/contracts/ids.ts'

/**
 * 生产入口模式 —— 由**真实进程事实**（有没有位置参数）决定。
 *
 * ⚠️ 它**不是**一个可以从外部载荷里读的字段：调用方（`main.ts`）从 `argv`
 * 推导它，推导规则只此一处（`conversationEntryModeOf`）。
 */
export type ConversationEntryMode = 'interactive_human_console' | 'scripted_agent_runner' | 'interactive_human_qq_private'

/** 程序化一次性入口的 `SERVICE` 位次 id */
export const AGENT_RUNNER_SERVICE_ID = 'agent-runner'

/**
 * 生产 ingress 的事实输入。
 *
 * ⚠️ 它是**受信事实**，不是 DTO：`characterId` 来自 kernel，`userId` 来自
 * 身份解析路径（`ConversationRecorder.ensureIdentity`），`presenterActorId`
 * 来自写入路径自己填的呈现位次。**没有任何一个**能用来选"角色"或"权威等级"。
 */
export interface ConversationIngressFacts {
  /** 本事件的 canonical 角色（受信：来自 kernel / 存储） */
  readonly characterId: string
  /** 本条事件**呈现**出来的位次（user_message ⇒ 用户 id；assistant_message ⇒ 角色 id） */
  readonly presenterActorId: string
  /** 已解析好的**用户领域身份**（不是 transport 身份、不是 DTO 字段） */
  readonly userId?: string
}

/** 一个生产 ingress 角色：一个族、一个 adapterId、一套自己的证据规则 */
export interface ConversationAttributionProducer {
  /** 人可读的生产者标识（进证据） */
  readonly producerId: string
  /** 它只能鉴证这一族（跨族失败关闭） */
  readonly family: ConversationFamily
  /** 产出本条事件的受信归因上下文（失败关闭：证据形状不对就抛） */
  attest(facts: ConversationIngressFacts): TrustedAttributionContext
}

/** 装配结果：入口模式 + 该模式下的生产 ingress */
export interface ConversationAttributionWiring {
  readonly entryMode: ConversationEntryMode
  readonly producers: readonly ConversationAttributionProducer[]
}

/**
 * 入口模式的**唯一**推导规则。
 *
 * ```text
 *   argv 里有位置参数（`tsx src/main.ts "…"`）⇒ scripted_agent_runner
 *   否则（交互式 readline）                  ⇒ interactive_human_console
 * ```
 *
 * 这正是 AGENTS.md「常见坑」表里那条 D01 事故的入口形状：agent 用一次性入口
 * 替用户发的话，落进账本是**不可区分**的 `[user]` 发言。现在它可区分了。
 */
export function conversationEntryModeOf(argv: readonly string[]): ConversationEntryMode {
  if (argv.includes('--qq-private')) {
    if (!argv.includes('--bridge') || argv.some((argument) => !argument.startsWith('--'))) {
      throw new Error('--qq-private requires --bridge without positional messages')
    }
    return 'interactive_human_qq_private'
  }
  return argv.some((argument) => !argument.startsWith('--'))
    ? 'scripted_agent_runner'
    : 'interactive_human_console'
}

/**
 * 受信边界的公共守卫。
 *
 * 传入的 `facts` 若夹带了归因字段（`contentOriginator` / `authority` / `executor`），
 * 直接**拒绝**而不是忽略 —— "静默忽略"与"信任"在账本上看起来一样（ADR-042 §3.3）。
 */
function guardFacts(facts: ConversationIngressFacts): void {
  assertNoUntrustedAttributionFields(facts as unknown as Record<string, unknown>)
}

/** 呈现位次必须存在（D01 的形状里，它正是那个"看起来像用户"的位置） */
function requirePresenter(facts: ConversationIngressFacts, producerId: string): void {
  if (facts.presenterActorId === '') {
    throw new KernelError(
      'validation_error',
      'attribution_presenter_missing',
      `${producerId}：呈现位次缺失（presenterActorId 为空）—— ` +
        '没有呈现位次的对话事件不是一条可归因的事件'
    )
  }
}

/**
 * **交互式人类控制台**（`pnpm chat` 的 readline 循环）。
 *
 * 判据（三条**同时**成立才算 Known(USER)）：
 *   ① 进程进入的是交互式控制台（由装配层用 `conversationEntryModeOf` 决定）
 *   ② 身份解析路径给出一个**具体的用户领域身份**
 *   ③ 事件呈现的位次**就是**那个人（不一致 ⇒ 抛，不猜）
 *
 * 有了这三条，再加上 `authenticated_human_input` 鉴证，Axis B 才是 **confirmed**。
 * ⚠️ **不得**因为 `actor_type === 'user'` 就确认 USER：那正是 D01 的错误形状。
 */
export function createHumanConsoleUserTurnIngress(): ConversationAttributionProducer {
  const adapterId = 'human-console'
  return Object.freeze({
    producerId: 'human-console-user-turn',
    family: 'user_message' as ConversationFamily,
    attest(facts: ConversationIngressFacts): TrustedAttributionContext {
      guardFacts(facts)
      requirePresenter(facts, adapterId)

      const userId = facts.userId !== undefined && facts.userId !== '' ? facts.userId : undefined

      /*
       * 身份解析不出来 ⇒ **如实 Unknown**，而不是"猜一个人"。
       * 这一支是 fail-closed 的语义证明：没有用户位次时，这里不会编出 Known(USER/*)。
       */
      if (userId === undefined) {
        return buildTrustedAttributionContext({
          family: 'user_message',
          characterId: facts.characterId,
          actorEvidence: attestActorFromDecisionPoint({
            adapterId,
            principal: null,
            unresolvedReason: 'RUNTIME_UNRESOLVED',
          }),
          contentOriginatorEvidence: attestContentOriginatorFromIngress({
            adapterId,
            principal: null,
            unresolvedReason: 'RUNTIME_UNRESOLVED',
          }),
        })
      }

      if (userId !== facts.presenterActorId) {
        throw new KernelError(
          'validation_error',
          'attribution_presenter_mismatch',
          `${adapterId}：呈现位次（${facts.presenterActorId}）与解析出来的用户身份（${userId}）` +
            '不一致 —— 受信边界拒绝为一条自相矛盾的事件建立归因'
        )
      }

      const principal = { kind: 'USER', id: userId } as const
      return buildTrustedAttributionContext({
        family: 'user_message',
        characterId: facts.characterId,
        actorEvidence: attestActorFromDecisionPoint({ adapterId, principal }),
        contentOriginatorEvidence: attestContentOriginatorFromIngress({ adapterId, principal }),
        // 直接、已认证的人类输入：本族唯一能建立 confirmed 的鉴证
        epistemicEvidence: attestEpistemicConfirmation({
          adapterId,
          kind: 'authenticated_human_input',
        }),
      })
    },
  })
}

/**
 * **程序化一次性入口**（`tsx src/main.ts "…"` / 脚本 / 自动化）。
 *
 * 这是 **D01 的生产控制**（§4）：内容由 `SERVICE/agent-runner` 提供，
 * **没有**任何认知鉴证 ⇒ Axis B 成对 `UNCONFIRMED_ORIGIN`。
 *
 * ⚠️ 两个刻意的"不做"：
 *   · 不把 `facts.userId` 写进任何槽位 —— 被替用户提交的**目标**不是作者
 *   · 不给认知鉴证 —— 程序化提交永远不得洗成 `USER_EXPLICIT`
 */
export function createAgentRunnerUserTurnIngress(): ConversationAttributionProducer {
  const adapterId = 'agent-runner'
  return Object.freeze({
    producerId: 'agent-runner-user-turn',
    family: 'user_message' as ConversationFamily,
    attest(facts: ConversationIngressFacts): TrustedAttributionContext {
      guardFacts(facts)
      requirePresenter(facts, adapterId)

      const principal = { kind: 'SERVICE', id: AGENT_RUNNER_SERVICE_ID } as const
      return buildTrustedAttributionContext({
        family: 'user_message',
        characterId: facts.characterId,
        actorEvidence: attestActorFromDecisionPoint({ adapterId, principal }),
        contentOriginatorEvidence: attestContentOriginatorFromIngress({ adapterId, principal }),
        // 刻意**没有** epistemicEvidence：confirmed 需要鉴证，而这里没有
      })
    },
  })
}

/** QQ private ingress: only the locally authenticated, allowlisted owner reaches this producer. */
export function createHumanQqPrivateUserTurnIngress(): ConversationAttributionProducer {
  const adapterId = 'qq-private-owner'
  return Object.freeze({
    producerId: 'qq-private-owner-user-turn',
    family: 'user_message' as ConversationFamily,
    attest(facts: ConversationIngressFacts): TrustedAttributionContext {
      guardFacts(facts)
      requirePresenter(facts, adapterId)
      if (!facts.userId || facts.userId !== facts.presenterActorId) {
        throw new KernelError('validation_error', 'attribution_presenter_mismatch',
          'QQ owner must be bound to the resolved domain user')
      }
      const principal = { kind: 'USER', id: facts.userId } as const
      return buildTrustedAttributionContext({
        family: 'user_message',
        characterId: facts.characterId,
        actorEvidence: attestActorFromDecisionPoint({ adapterId, principal }),
        contentOriginatorEvidence: attestContentOriginatorFromIngress({ adapterId, principal }),
        epistemicEvidence: attestEpistemicConfirmation({ adapterId, kind: 'authenticated_human_input' }),
      })
    },
  })
}

/** Authenticated QQ member ingress. The caller has already checked account and membership. */
export function createHumanQqMemberUserTurnIngress(roomKind: 'private' | 'group'): ConversationAttributionProducer {
  return createHumanPlatformMemberIngress(`qq-${roomKind}-member`)
}

/** Only the independently verified, group-only WeChat path may construct this producer. */
export function createHumanWechatGroupUserTurnIngress(): ConversationAttributionProducer {
  return createHumanPlatformMemberIngress('wechat-group-member')
}

function createHumanPlatformMemberIngress(adapterId: string): ConversationAttributionProducer {
  return Object.freeze({ producerId: `${adapterId}-user-turn`, family: 'user_message' as ConversationFamily,
    attest(facts: ConversationIngressFacts): TrustedAttributionContext {
      guardFacts(facts); requirePresenter(facts, adapterId)
      if (!facts.userId || facts.userId !== facts.presenterActorId) throw new KernelError('validation_error',
        'attribution_presenter_mismatch', 'Platform speaker must match the resolved domain user')
      const principal = { kind: 'USER', id: facts.userId } as const
      return buildTrustedAttributionContext({ family: 'user_message', characterId: facts.characterId,
        actorEvidence: attestActorFromDecisionPoint({ adapterId, principal }),
        contentOriginatorEvidence: attestContentOriginatorFromIngress({ adapterId, principal }),
        epistemicEvidence: attestEpistemicConfirmation({ adapterId, kind: 'authenticated_human_input' }) })
    } })
}

/**
 * **角色的输出边界**（`turn-gateway.completeTurn` → `CharacterIntent` → Resolver）。
 *
 * 判据（§5）：**只有当**事件呈现的位次就是本会话的 canonical 角色时，
 * `actor` / `contentOriginator` 才是 `Known(CHARACTER/<canonical>)` +
 * `character_self_generation`（confirmed）。三种情况分别处置：
 *
 * ```text
 *   呈现位次 = canonical 角色   ⇒ Known(CHARACTER) + confirmed
 *   呈现位次为空                ⇒ Unknown(RUNTIME_UNRESOLVED)（如实说"定不下来"）
 *   呈现位次 ≠ canonical 角色   ⇒ 抛（自相矛盾的写入，不猜）
 * ```
 *
 * ⚠️ **不得**从 `family === 'assistant_message'` 推出 CHARACTER 位次：
 * 位次来自 canonical 角色 id，而**呈现位次必须与它逐字相等**才会被采信。
 */
export function createCharacterAssistantTurnIngress(): ConversationAttributionProducer {
  const adapterId = 'character-turn'
  return Object.freeze({
    producerId: 'character-assistant-turn',
    family: 'assistant_message' as ConversationFamily,
    attest(facts: ConversationIngressFacts): TrustedAttributionContext {
      guardFacts(facts)

      if (facts.presenterActorId === '') {
        return buildTrustedAttributionContext({
          family: 'assistant_message',
          characterId: facts.characterId,
          actorEvidence: attestActorFromDecisionPoint({
            adapterId,
            principal: null,
            unresolvedReason: 'RUNTIME_UNRESOLVED',
          }),
          contentOriginatorEvidence: attestContentOriginatorFromIngress({
            adapterId,
            principal: null,
            unresolvedReason: 'RUNTIME_UNRESOLVED',
          }),
        })
      }

      if (facts.presenterActorId !== facts.characterId) {
        throw new KernelError(
          'validation_error',
          'attribution_presenter_mismatch',
          `${adapterId}：呈现位次（${facts.presenterActorId}）不是本会话的 canonical 角色` +
            `（${facts.characterId}）—— 拒绝为一条来源对不上的输出建立角色归因`
        )
      }

      const principal = { kind: 'CHARACTER', id: facts.characterId } as const
      return buildTrustedAttributionContext({
        family: 'assistant_message',
        characterId: facts.characterId,
        actorEvidence: attestActorFromDecisionPoint({ adapterId, principal }),
        contentOriginatorEvidence: attestContentOriginatorFromIngress({ adapterId, principal }),
        epistemicEvidence: attestEpistemicConfirmation({
          adapterId,
          kind: 'character_self_generation',
        }),
      })
    },
  })
}

/**
 * 按**入口模式**装配生产 ingress（`main.ts` 唯一该调的地方）。
 *
 * 两个模式**都**装上"她的输出"那条通道：助手事件的生产者与入口模式无关
 * （它走的是 Resolver，不是控制台）。
 */
export function conversationAttributionForEntryMode(
  entryMode: ConversationEntryMode
): ConversationAttributionWiring {
  const userIngress =
    entryMode === 'interactive_human_qq_private'
      ? createHumanQqPrivateUserTurnIngress()
      : entryMode === 'interactive_human_console'
      ? createHumanConsoleUserTurnIngress()
      : createAgentRunnerUserTurnIngress()
  return Object.freeze({
    entryMode,
    producers: Object.freeze([userIngress, createCharacterAssistantTurnIngress()]),
  })
}

/**
 * 索引：把 wiring 变成"族 → producer"的查表，并拒绝**歧义**。
 *
 * 两个 producer 声称同一族 ⇒ 抛。理由：归因的歧义（"到底是谁提供的"）正是
 * D01 那个缺口的形状，不能靠"取第一个"悄悄消解。
 */
export function indexConversationIngress(
  producers: readonly ConversationAttributionProducer[]
): ReadonlyMap<ConversationFamily, ConversationAttributionProducer> {
  const byFamily = new Map<ConversationFamily, ConversationAttributionProducer>()
  for (const producer of producers) {
    const existing = byFamily.get(producer.family)
    if (existing !== undefined) {
      throw new KernelError(
        'validation_error',
        'ambiguous_attribution_ingress',
        `对话 ingress 歧义：族 ${producer.family} 同时被 ${existing.producerId} 与 ` +
          `${producer.producerId} 声称 —— 一个族只能有一个生产 ingress`
      )
    }
    byFamily.set(producer.family, producer)
  }
  return byFamily
}
