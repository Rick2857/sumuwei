/**
 * QQ 正式回复的**出站媒介选择**（文字 / 语音）—— 同一次生成里由她自己选。
 *
 * ============================================================================
 *  这是什么 / 这不是什么
 * ============================================================================
 * ```text
 * 是    ：回复正文旁路的一条**呈现元数据**（文字或语音），带版本号
 * 不是  ：第二条 SPEECH、独立会话、通用外部行动 intent、发送权限
 * 不是  ：程序按关键词/情绪分数/概率/频次替她做的选择（那正是本契约要挡住的）
 * ```
 *
 * ⚠️ **只解码完整封套**：`<lg-qq-media>{json}</lg-qq-media>` 必须是整段回复
 *    （trim 之后首尾正好是这两个标记）。正文里恰好提到 `<lg-qq-media>` 字样不算，
 *    而**出现了标记却没有完整封套**一律**失败关闭** —— 宁可这一轮如实失败，
 *    也不能把半个协议念给用户，或把它合成音频。
 *
 * ⚠️ **不产生任何权限**：目标 QQ、群、API 地址、文件路径、密钥、音色都不在这里；
 *    选 `voice` 不会多出"能往别处发"的能力（选什么只影响这条回复怎么呈现）。
 *
 * ⚠️ 缺省未启用时（调用方不传 / 开关关）本模块**一次都不被调用** ⇒
 *    旧行为逐字不变；启用后**无封套的旧式正文**按文字兼容并记 `missing_metadata`。
 */
import { KernelError } from './ids.ts'

/** 保留封套标记（闭集；版本化协议名的一部分，不再是自然语言） */
export const QQ_MEDIA_ENVELOPE_TAG = 'lg-qq-media'
/** 封套版本（版本号不同 ⇒ 整轮拒绝；不"猜一个兼容版本"） */
export const QQ_MEDIA_ENVELOPE_VERSION = 1
/** 媒介闭集 —— 只有两个值，且都只是呈现方式 */
export const QQ_MEDIA_MODES = ['text', 'voice'] as const
export type QqMediaMode = (typeof QQ_MEDIA_MODES)[number]
export interface QqReplyDeliveryFact {
  replyId: string
  status: 'reserved' | 'api_accepted' | 'failed_confirmed' | 'delivery_unknown' | 'fallback_text' | 'unknown_after_restart'
  requested?: QqMediaMode
  effective?: QqMediaMode
}
/** 封套正文的字符上界（防"把整段资料塞进一条语音消息"） */
export const QQ_MEDIA_TEXT_MAX_CHARS = 8000

/**
 * 线上承载的媒介选择（`TURN_RESULT.media`）。
 *
 * ⚠️ 只有这三个字段；**没有**目标、音色、文件、URL —— 那些由受信配置决定。
 */
export interface QqMediaSelection {
  version: typeof QQ_MEDIA_ENVELOPE_VERSION
  mode: QqMediaMode
  /**
   * 这一轮的正文**没有**携带封套（旧式正文 / 模型没按协议输出）。
   *
   * ⚠️ 它如实说明"这不是她显式选了文字"，而不是把她没说的话记成她的选择。
   */
  fallback?: 'missing_metadata'
}

/** 封套解码结果（只在**确实是完整封套**时返回） */
export interface QqMediaDraft {
  version: typeof QQ_MEDIA_ENVELOPE_VERSION
  mode: QqMediaMode
  /** 最终要表达的正文字面（后续仍要过回复守卫，可能被改写） */
  text: string
}

/** 一轮回复的解析结果：正文 + （可选）媒介选择 */
export interface QqMediaResolved {
  /** 要交给既有正文处理链的文本 */
  text: string
  /** 未启用 / 语音不可用 / 非 QQ 入口 ⇒ `undefined`（旧行为逐字不变） */
  media?: QqMediaSelection
}

/** 封套的必需字段（闭集：任何额外字段都拒绝，表达式从这里溜不进来） */
const QQ_MEDIA_KEYS: readonly string[] = ['version', 'mode', 'text']

export function qqMediaEnvelopeOpen(): string {
  return `<${QQ_MEDIA_ENVELOPE_TAG}>`
}

export function qqMediaEnvelopeClose(): string {
  return `</${QQ_MEDIA_ENVELOPE_TAG}>`
}

/**
 * 渲染一条封套（**只给程序/夹具用**；模型由 prompt section 告知格式）。
 *
 * ⚠️ 这里不做"风格改写"：`text` 原样进入 JSON，不截断、不清洗。
 */
export function renderQqMediaEnvelope(mode: QqMediaMode, text: string): string {
  return `${qqMediaEnvelopeOpen()}${JSON.stringify({ version: QQ_MEDIA_ENVELOPE_VERSION, mode, text })}${qqMediaEnvelopeClose()}`
}

function invalid(code: string, message: string): KernelError {
  /* 只带字段名 / 上限 / 计数，不带正文 —— 失败信息同样受"正文不落日志"的纪律约束 */
  return new KernelError('validation_error', code, message)
}

function envelopeProblem(raw: string): KernelError | undefined {
  const open = qqMediaEnvelopeOpen()
  const close = qqMediaEnvelopeClose()
  const trimmed = raw.trim()
  /* 只允许**整段**是封套；首尾之外出现内容（前后加字）同样算坏封套 */
  if (!trimmed.startsWith(open) || !trimmed.endsWith(close)) {
    return invalid('qq_media_envelope_not_whole', 'QQ 媒介封套必须独占整段回复（前后不得有其它内容）')
  }
  /* 内层不得再出现标记（不嵌套、不拼接两段） */
  const inner = trimmed.slice(open.length, trimmed.length - close.length)
  if (inner.includes(open) || inner.includes(close)) {
    return invalid('qq_media_envelope_nested', 'QQ 媒介封套内不得再出现封套标记')
  }
  return undefined
}

/**
 * 解码一条 QQ 媒介封套。
 *
 * @returns `undefined` —— 回复里**根本没有**这个封套 ⇒ 调用方按文字兼容处理
 * @throws  `KernelError` —— 出现了标记但封套不合法 ⇒ **整轮拒绝**（不截半执行）
 */
export function decodeQqMediaReply(raw: string): QqMediaDraft | undefined {
  if (!raw.includes(qqMediaEnvelopeOpen()) && !raw.includes(`<${QQ_MEDIA_ENVELOPE_TAG}`)) return undefined
  const problem = envelopeProblem(raw)
  if (problem !== undefined) throw problem
  const open = qqMediaEnvelopeOpen()
  const close = qqMediaEnvelopeClose()
  const trimmed = raw.trim()
  const body = trimmed.slice(open.length, trimmed.length - close.length)

  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    throw invalid('qq_media_bad_json', `QQ 媒介封套不是合法 JSON（${body.length} 字符）`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('qq_media_not_object', 'QQ 媒介封套的 JSON 必须是对象')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.some((key) => !QQ_MEDIA_KEYS.includes(key))) {
    throw invalid('qq_media_unexpected_field', `QQ 媒介封套只允许 ${QQ_MEDIA_KEYS.join('/')} 三个字段`)
  }
  if (keys.length !== QQ_MEDIA_KEYS.length) {
    throw invalid('qq_media_missing_field', `QQ 媒介封套缺少字段（收到 ${keys.length} 个，需要 ${QQ_MEDIA_KEYS.length} 个）`)
  }
  if (record.version !== QQ_MEDIA_ENVELOPE_VERSION) {
    throw invalid('qq_media_bad_version', `QQ 媒介封套版本不受支持（本端为 ${QQ_MEDIA_ENVELOPE_VERSION}）`)
  }
  const mode = record.mode
  if (typeof mode !== 'string' || !(QQ_MEDIA_MODES as readonly string[]).includes(mode)) {
    throw invalid('qq_media_bad_mode', `QQ 媒介 mode 只能是 ${QQ_MEDIA_MODES.join(' / ')}`)
  }
  const text = record.text
  if (typeof text !== 'string' || text.trim() === '') {
    throw invalid('qq_media_empty_text', 'QQ 媒介封套的 text 必须是非空字符串')
  }
  if ([...text].length > QQ_MEDIA_TEXT_MAX_CHARS) {
    throw invalid('qq_media_text_too_long', `QQ 媒介封套的 text 超过 ${QQ_MEDIA_TEXT_MAX_CHARS} 字符`)
  }
  return { version: QQ_MEDIA_ENVELOPE_VERSION, mode: mode as QqMediaMode, text }
}

/**
 * 一轮 QQ 回复的解析入口（**纯函数，唯一实现**；`main.ts` 只调用它）。
 *
 * ```text
 * 开关关 / 语音不可用 / 非 QQ 入口  ⇒ { text: raw }            （旧行为逐字不变）
 * 启用 + 有完整封套                ⇒ { text: 封套正文, media }  （mode 由她选）
 * 启用 + 无封套                    ⇒ { text: raw, media: text + missing_metadata }
 * 启用 + 坏封套                    ⇒ 抛（整轮失败，绝不把协议念出去）
 * ```
 */
export function resolveQqMediaReply(input: {
  raw: string
  enabled: boolean
  /** 这个出口此刻**真的**能合成并发送语音吗（由受信配置决定，不由模型决定） */
  voiceAvailable: boolean
}): QqMediaResolved {
  if (!input.enabled || !input.voiceAvailable) return { text: input.raw }
  const draft = decodeQqMediaReply(input.raw)
  if (draft === undefined) {
    return {
      text: input.raw,
      media: { version: QQ_MEDIA_ENVELOPE_VERSION, mode: 'text', fallback: 'missing_metadata' },
    }
  }
  return {
    text: draft.text,
    media: { version: QQ_MEDIA_ENVELOPE_VERSION, mode: draft.mode },
  }
}

/**
 * 线上媒介选择的形状判读（**失败关闭**，返回 `undefined` 而不是抛）。
 *
 * ⚠️ 它用于 QQ 外壳：外壳**不信任**对端一定送来了合法形状（也可能是旧核心）
 *    ⇒ 形状不合法 = "这一轮没有可用的媒介选择" = 走既有文字路径，**不**猜。
 */
export function qqMediaSelectionOf(value: unknown): QqMediaSelection | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.version !== QQ_MEDIA_ENVELOPE_VERSION) return undefined
  const mode = record.mode
  if (typeof mode !== 'string' || !(QQ_MEDIA_MODES as readonly string[]).includes(mode)) return undefined
  const fallback = record.fallback
  if (fallback !== undefined && fallback !== 'missing_metadata') return undefined
  if (Object.keys(record).some((key) => !['version', 'mode', 'fallback'].includes(key))) return undefined
  return {
    version: QQ_MEDIA_ENVELOPE_VERSION,
    mode: mode as QqMediaMode,
    ...(fallback === 'missing_metadata' ? { fallback: 'missing_metadata' as const } : {}),
  }
}
