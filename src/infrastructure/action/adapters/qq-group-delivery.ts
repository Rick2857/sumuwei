/**
 * `qq.group.message` / `send` 的适配器（post-Lv2 / 群任务 P2）。
 *
 * ============================================================================
 *  它做什么 / 不做什么
 * ============================================================================
 * ```text
 * 做：① 复核参数闭集（只有 text / media；**群号在载荷里出现就具名拒绝**）
 *     ② 复核目标**就是任务授权的那个群**（`qq_group_task` 且 exact，
 *        `canonicalId` 与授权事实里的群号逐字相同）
 *     ③ 复核正文有界（`GROUP_TASK_LIMITS.maxTextCodepoints`，与契约同源）
 *     ④ 从**注入的授权端口**（`resolveAuthorization`，不是参数）取任务授权事实；
 *        取不到/被拒 ⇒ 失败关闭（群号不来自载荷）
 *     ⑤ 复核"预留额度 ≥ 本次最坏情形"（`worstCaseOutgoingMessages`）
 *     ⑥ 把正文交给**注入的投递端口**（那一条线缆会把它送到外壳的群发送面）
 *     ⑦ 回一个 effect = `message_sent` + **正文指纹**（正文不进账本，与 `D09` 同一条纪律）
 * 不做：不决定该不该发（策略层 / 任务额度判定在调用方）、不认识谁请求的、
 *       **不**发现群号、**不**打开数据库、**不**判断正文写得好不好
 * ```
 *
 * ============================================================================
 *  ⚠️ 语音：**本批不假装支持**
 * ============================================================================
 * ```text
 * 适配器**只真的发文字**。`media === 'voice'` 这条支只有在调用方注入 `synthesize`
 * 端口时才成立；而**本批不提供任何真实合成实现**（真 TTS 不在本批范围）。
 * 因此：
 *   · 没注入合成端口 ⇒ `unsupported` + `qq_group_send_voice_synthesis_absent`
 *     （**不会**用文字假装发过语音）
 *   · 注入了**假**端口（只有门里这么干）⇒ 端口说"明确失败"时，兜底与否**只由**
 *     契约的 `decideVoiceFallback` 决定：
 *       只语音              ⇒ 如实失败，**零**文字兜底
 *       either + 允许回落    ⇒ **恰好一条**文字兜底（计 1 条对外消息）
 *       结果不明（unknown）  ⇒ **零**兜底（可能已经送达，不重发）
 * ⚠️ "语音真的发出去了 / 群成员听到了"**不在本门证据范围内**：门的 stdout 里那条
 *    `voice …` 检查名逐字写着"假合成端口 / 本批不真发语音"。
 * ```
 *
 * ⚠️ 成功**不等于**送达：`message_sent` 的逐字含义见 `ActionEffect` 的注释
 *    ——"已交给外壳投递"，`api_accepted` 只证明平台接受。
 *
 * ⚠️ 失败一律走**闭集**的 `ActionFailureCode`；我们自己的具名理由进 `details.reason`
 *    （与 `browser.ts` / `qq-proactive-delivery.ts` 同一条纪律）。
 */
import type { AdapterExecuteInput, AdapterOutcome, CapabilityAdapter } from '../../../kernel/action/executor-port.ts'
import { stringArg } from '../../../kernel/action/executor-port.ts'
import type { ActionFailureCode } from '../../../kernel/action/errors.ts'
import { actionFailure, ActionFailureError } from '../../../kernel/action/errors.ts'
import {
  QQ_GROUP_SEND_OPERATION,
  QQ_GROUP_MESSAGE,
  QQ_GROUP_TASK_TARGET_TYPE,
  assertQqGroupSendArgKeys,
  groupArgViolation,
} from '../../../kernel/action/qq-group-capability.ts'
import {
  GROUP_TASK_LIMITS,
  GROUP_TASK_MEDIA,
  decideVoiceFallback,
  isQqId,
  mediaAllowed,
  worstCaseOutgoingMessages,
  type GroupTaskMedia,
} from '../../../kernel/contracts/qq-group-task.ts'
import { notificationTextFingerprint } from '../../../kernel/contracts/notification.ts'

/** 一次群发送实际要用的**形态**（`either` 由调用方/模型二选一，进入适配器后必须已经确定） */
export type QqGroupPlannedMedia = 'text' | 'voice'

/**
 * 任务授权事实（**唯一**的群号来源）。
 *
 * ⚠️ 它由调用方从**持久层的任务行 + 原子额度预留**派生，经注入端口给进来；
 *    适配器**不**接受参数里的群号，也不自己去查群。
 */
export interface QqGroupTaskAuthorizationFacts {
  readonly taskId: string
  readonly taskVersion: number
  readonly groupId: string
  readonly botId: string
  /** 任务声明的形态（`text` / `voice` / `either`） */
  readonly media: GroupTaskMedia
  /** 任务是否允许"语音明确失败 ⇒ 一条文字兜底"（只有 `either` 才可能为 true） */
  readonly textFallback: boolean
  /** 持久层**已经原子占用**的对外消息数（必须 ≥ 本次最坏情形） */
  readonly reservedMessages: number
}

/**
 * 授权端口的解析结果。
 *
 * ```text
 * {ok:true}    授权成立（`facts` 是任务事实）
 * {ok:false}   授权不成立（`code` 是**判定层**给的原因，如 `group_task_out_of_term`）
 * undefined    **取不到**授权事实（没有任务 / 任务不适用）⇒ 适配器失败关闭
 * ```
 */
export type QqGroupAuthorizationResolution =
  | { readonly ok: true; readonly facts: QqGroupTaskAuthorizationFacts }
  | { readonly ok: false; readonly code: string }

export type ResolveQqGroupAuthorization = (
  input: AdapterExecuteInput
) => QqGroupAuthorizationResolution | undefined

/** 交给投递端口的一次发送（正文只在这里出现；账本只收指纹） */
export interface QqGroupTaskDeliverInput {
  readonly taskId: string
  readonly taskVersion: number
  readonly target: { readonly botId: string; readonly groupId: string }
  readonly media: QqGroupPlannedMedia
  readonly text: string
  /** 只有 `media === 'voice'` 时才可能有：已经合成好的 `base64://` 音频 */
  readonly recordFileUrl?: string
  /** 幂等稳定键（`ActionRequest.idempotencyKey`；模型没有任何路径能写它） */
  readonly deliveryKey: string
  readonly reservedMessages: number
}

/** 投递结局三态（与外壳的 `deliverGroupTaskMessage` 同形） */
export type QqGroupDeliveryStatus = 'api_accepted' | 'failed_confirmed' | 'delivery_unknown'

/**
 * 投递端口的返回。
 *
 * ⚠️ `written === true` ⇒ 已交给外壳（不等于群成员看到）。
 * ⚠️ `written === false` 时必须看 `status`：**缺省**按 `delivery_unknown` 处理
 *    （保守：不重发、不兜底），绝不把"不明"当"明确失败"。
 */
export interface QqGroupTaskDeliverResult {
  readonly written: boolean
  readonly status?: QqGroupDeliveryStatus
  readonly code?: string
  readonly messageId?: string
}

export interface QqGroupTaskDeliveryPort {
  deliver(input: QqGroupTaskDeliverInput): Promise<QqGroupTaskDeliverResult> | QqGroupTaskDeliverResult
}

/**
 * 语音合成端口（**本批不提供任何真实实现**）。
 *
 * ⚠️ 它只回一个**已经合成好的** `base64://` record 文件；真实 TTS / 编解码
 *    不在本批范围（见文件头"语音：本批不假装支持"）。
 */
export interface QqGroupVoiceSynthesisPort {
  synthesize(input: { readonly text: string }): Promise<
    { readonly ok: true; readonly recordFileUrl: string } | { readonly ok: false; readonly reason: string }
  >
}

export interface QqGroupDeliveryAdapterOptions {
  readonly deliver: QqGroupTaskDeliveryPort
  /**
   * 任务授权事实的**注入端口**。
   *
   * ⚠️ 它**不是**参数：模型写的 `args` 里没有、也永远不会有群号。
   */
  readonly resolveAuthorization: ResolveQqGroupAuthorization
  /** 可选：语音合成端口（本批不实现；见 `QqGroupVoiceSynthesisPort`） */
  readonly synthesize?: QqGroupVoiceSynthesisPort
}

function fail(
  code: ActionFailureCode,
  reason: string,
  message: string,
  extra?: Record<string, unknown>
): never {
  throw new ActionFailureError(actionFailure(code, message, { reason, ...(extra ?? {}) }))
}

/** 成功 effect：**只有正文指纹**（正文不进账本，先例 `qq-proactive-delivery.ts` 的 `D09`） */
function sentEffect(text: string): AdapterOutcome {
  return {
    effect: {
      kind: 'message_sent',
      detail: '已交给 QQ 外壳投递到任务授权的群（平台结局待回执；不是群成员已看到）',
      fingerprint: notificationTextFingerprint(text),
      bytes: new TextEncoder().encode(text).length,
    },
  }
}

export function createQqGroupDeliveryAdapter(
  options: QqGroupDeliveryAdapterOptions
): CapabilityAdapter {
  return {
    capabilityId: QQ_GROUP_MESSAGE,
    async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
      if (input.operation !== QQ_GROUP_SEND_OPERATION) {
        fail('validation_failed', 'qq_group_send_unknown_operation',
          `qq.group.message 只有 ${QQ_GROUP_SEND_OPERATION} 这一个操作，收到 ${input.operation}`)
      }

      /* ① 参数闭集 + 群号/收件人黑名单（与声明同源的两条复核函数） */
      const violation = groupArgViolation(input.args)
      if (violation !== undefined) fail('validation_failed', violation.code, violation.detail)
      try {
        assertQqGroupSendArgKeys(input.args)
      } catch (error) {
        /* `assertQqGroupSendArgKeys` 抛的是 KernelError；适配器的失败必须归一 */
        const reason = (error as { code?: string }).code ?? 'qq_group_send_unknown_arg'
        fail('validation_failed', reason, error instanceof Error ? error.message : '参数闭集复核失败')
      }

      /* ② 目标**必须**是任务授权的那个群（`resolveTarget` 那一支给 exact 置信度） */
      if (input.target.type !== QQ_GROUP_TASK_TARGET_TYPE || input.target.confidence !== 'exact') {
        fail('validation_failed', 'qq_group_send_target_not_task',
          `目标必须是任务授权事实给出的群（${QQ_GROUP_TASK_TARGET_TYPE} / exact），收到 ${input.target.type} / ${input.target.confidence}`)
      }

      /* ③ 正文有界（与契约的 `GROUP_TASK_LIMITS` 同源） */
      const text = stringArg(input.args, 'text') ?? ''
      const codepoints = [...text].length
      if (text.trim() === '') fail('validation_failed', 'qq_group_send_without_text', '正文是空的')
      if (codepoints > GROUP_TASK_LIMITS.maxTextCodepoints) {
        fail('validation_failed', 'qq_group_send_text_too_long',
          `正文 ${String(codepoints)} 码点，上界 ${String(GROUP_TASK_LIMITS.maxTextCodepoints)}`)
      }
      const rawMedia = input.args.media
      if (rawMedia !== undefined && rawMedia !== 'text' && rawMedia !== 'voice') {
        fail('validation_failed', 'qq_group_send_media_invalid',
          `media 只能是 text / voice，收到 ${String(rawMedia)}`)
      }
      const requestedMedia = rawMedia as QqGroupPlannedMedia | undefined

      /* ④ 稳定键（拿不到就**不发**：一次无法幂等的发送不该发生） */
      const deliveryKey = String(input.idempotencyKey ?? '').trim()
      if (deliveryKey === '') {
        fail('validation_failed', 'qq_group_send_without_delivery_key',
          '取不到本次投递的稳定键（idempotencyKey）—— 幂等必需的能力不许在没有键的情况下发送')
      }

      /* ⑤ 任务授权事实（**注入端口**；取不到 ⇒ 失败关闭，群号绝不从载荷来） */
      let resolution: QqGroupAuthorizationResolution | undefined
      try {
        resolution = options.resolveAuthorization(input)
      } catch {
        fail('permission_denied', 'qq_group_send_authorization_unavailable',
          '任务授权端口不可用 —— 拿不到任务事实就不发送')
      }
      if (resolution === undefined) {
        fail('permission_denied', 'qq_group_send_without_task_authorization',
          '本次调用没有任务授权事实：群消息只能在主人授权任务的范围内发送')
      }
      if (!resolution.ok) {
        fail('permission_denied', resolution.code,
          '任务授权复核不通过（额度 / 生效期 / 版本 / 目标）—— 不发送',
          { upstream: resolution.code })
      }
      const facts = resolution.facts
      if (facts.taskId.trim() === '' || !Number.isSafeInteger(facts.taskVersion) || facts.taskVersion < 1
        || !isQqId(facts.groupId) || !isQqId(facts.botId) || facts.groupId === facts.botId
        || !GROUP_TASK_MEDIA.includes(facts.media) || typeof facts.textFallback !== 'boolean'
        || !Number.isSafeInteger(facts.reservedMessages) || facts.reservedMessages < 1) {
        fail('permission_denied', 'qq_group_send_authorization_invalid',
          '任务授权事实自相矛盾（缺任务/版本/真实群号/形态/预留额度）—— 失败关闭')
      }

      /* ⑥ 解析出来的目标与授权事实必须逐字相同（不同就一定不发） */
      if (input.target.canonicalId === undefined || input.target.canonicalId !== facts.groupId) {
        fail('validation_failed', 'group_task_target_mismatch',
          `目标群 ${String(input.target.canonicalId)} 与任务授权的群 ${facts.groupId} 不一致 —— 不发送`)
      }

      /* ⑦ 实际形态必须在任务允许范围内（`either` 才允许二次选择） */
      const plannedMedia: QqGroupPlannedMedia =
        requestedMedia ?? (facts.media === 'voice' ? 'voice' : 'text')
      if (!mediaAllowed({ media: facts.media }, plannedMedia)) {
        fail('permission_denied', 'group_task_media_not_allowed',
          `任务只允许 ${facts.media}，本次要发 ${plannedMedia} —— 不改形态、不发送`)
      }

      /* ⑧ 预留额度必须覆盖**最坏情形**（语音 / 附录 / 兜底都计数） */
      const worstCase = worstCaseOutgoingMessages({
        media: facts.media,
        appendices: 0,
        allowTextFallback: facts.textFallback,
      })
      if (facts.reservedMessages < worstCase) {
        fail('validation_failed', 'qq_group_send_reserved_messages_insufficient',
          `已预留 ${String(facts.reservedMessages)} 条，本次最坏情形 ${String(worstCase)} 条 —— 不许少占多发`)
      }

      const runDeliver = async (
        media: QqGroupPlannedMedia,
        body: string,
        recordFileUrl?: string
      ): Promise<QqGroupTaskDeliverResult> => {
        try {
          return await options.deliver.deliver({
            taskId: facts.taskId,
            taskVersion: facts.taskVersion,
            target: { botId: facts.botId, groupId: facts.groupId },
            media,
            text: body,
            ...(recordFileUrl === undefined ? {} : { recordFileUrl }),
            deliveryKey,
            reservedMessages: facts.reservedMessages,
          })
        } catch {
          fail('execution_failed', 'qq_group_send_port_failed',
            '投递端口抛错 —— 这一条没有确认发出，也不重试')
        }
      }

      /**
       * 语音**明确失败**后的处置：**只由**契约的 `decideVoiceFallback` 决定。
       *
       * ⚠️ 这条是"只语音 + TTS 失败 ⇒ 零文字兜底"在**代码里**的落点；
       *    门里读的就是它（以及返回的具名失败），不是"假装发过语音"的痕迹。
       */
      const voiceFallback = async (upstream?: string): Promise<AdapterOutcome> => {
        const decision = decideVoiceFallback({
          task: { media: facts.media, textFallback: facts.textFallback },
          voiceDelivery: 'failed_confirmed',
        })
        if (decision.kind === 'fail') {
          fail('execution_failed', decision.code,
            '只语音任务：语音明确失败，契约禁止改成文字（零兜底）',
            { upstream: upstream ?? 'voice_synthesis_or_delivery_failed' })
        }
        if (decision.kind !== 'send_text_fallback') {
          fail('execution_failed', 'qq_group_send_voice_fallback_undecided',
            '语音失败后的兜底判定不可达（任务形态与投递结局不自洽）—— 不发送')
        }
        const result = await runDeliver('text', text)
        if (result.written) return sentEffect(text)
        if (result.status === 'failed_confirmed') {
          fail('execution_failed', result.code ?? 'qq_group_send_not_written',
            '文字兜底也被通道明确拒收')
        }
        fail('timeout', 'qq_group_send_delivery_unknown',
          '文字兜底结果不明：不重发（可能已经送达）', { fallbackSuppressed: true })
      }

      /* ⑨ 语音形态：本批**没有**真实合成实现 ⇒ 没注入端口就如实失败 */
      if (plannedMedia === 'voice') {
        const synthesize = options.synthesize
        if (synthesize === undefined) {
          fail('unsupported', 'qq_group_send_voice_synthesis_absent',
            '语音合成不在本批适配器内：没有注入合成端口，语音发送不成立（不会用文字假装）')
        }
        let synthesized: Awaited<ReturnType<QqGroupVoiceSynthesisPort['synthesize']>>
        try {
          synthesized = await synthesize.synthesize({ text })
        } catch {
          synthesized = { ok: false, reason: 'qq_group_send_voice_synthesis_failed' }
        }
        if (!synthesized.ok) return await voiceFallback(synthesized.reason)
        if (!synthesized.recordFileUrl.startsWith('base64://')) {
          /* 端口回了个非法记录 ⇒ 当作合成明确失败（是"没合成出来"，不是"可能已发出"） */
          return await voiceFallback('qq_group_send_voice_record_invalid')
        }
        const result = await runDeliver('voice', text, synthesized.recordFileUrl)
        if (result.written) return sentEffect(text)
        if (result.status === 'failed_confirmed') return await voiceFallback(result.code)
        /* 结果不明 ⇒ **零兜底**（可能已经送达；不重发、不发同内容文字） */
        fail('timeout', 'group_task_voice_delivery_unknown',
          '语音投递结果不明：不重发、不发文字兜底（可能已经送达）',
          { fallbackSuppressed: true, upstream: result.code ?? '' })
      }

      /* ⑩ 文字形态 */
      const result = await runDeliver('text', text)
      if (result.written) return sentEffect(text)
      if (result.status === 'failed_confirmed') {
        fail('execution_failed', result.code ?? 'qq_group_send_not_written',
          '投递端口明确拒收这一条群消息')
      }
      fail('timeout', 'qq_group_send_delivery_unknown',
        '文本投递结果不明：不重发（可能已经送达）', { fallbackSuppressed: true })
    },
  }
}
