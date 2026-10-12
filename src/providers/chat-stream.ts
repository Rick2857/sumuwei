/** Decode OpenAI-compatible SSE without exposing reasoning or protocol fields as speech. */
/**
 * ★ 2026-10-10：**token 计量**（只加可观测性，不改生成语义）。
 *
 * 起因：真机事故里主回复流以 `finish_reason="length"` 结束 ⇒ 整轮失败，而**库里查不到**那几个数字
 * （主回复流从建立起就不解析 `usage`，也没设 `stream_options.include_usage`）。
 * 要区分"思维链吃光预算"与"正文本身太长"，必须先把这两个读数拿到。
 */
export interface ChatStreamUsage {
  readonly promptTokens: number | null
  readonly completionTokens: number | null
  readonly reasoningTokens: number | null
}

export class ChatStreamError extends Error {
  constructor(
    readonly code: string,
    message = code,
    /** 失败时**也要**带上已经拿到的 usage（流里没有 usage ⇒ undefined，**不伪装成 0**） */
    readonly usage?: ChatStreamUsage,
    /** 已经流出多少个字符（"零产出"与"说了半句"的最短判据） */
    readonly streamedChars?: number
  ) {
    super(message)
  }
}

export async function readChatStream(
  response: Response,
  onDelta: (text: string) => void,
  /** 成功时把 usage 交出来（只用于读数 / 日志，不回显给用户） */
  onUsage?: (usage: ChatStreamUsage) => void
): Promise<string> {
  if (!response.body) throw new ChatStreamError('model_stream_without_body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let content = ''
  let done = false
  let stopped = false
  /** 非 `stop` 的终态：**先记下、不立刻抛** —— usage 那一块通常紧跟在它后面 */
  let pendingFailure: { code: string } | undefined
  let usage: ChatStreamUsage | undefined
  const toTokens = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null
  const consume = (event: string): void => {
    const data = event.split('\n').filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n')
    if (!data) return
    if (data === '[DONE]') { done = true; return }
    /*
     * ★ 2026-10-11：载荷不是 JSON 也要具名。
     * ⚠️ **不带载荷片段**：`JSON.parse` 自己的 message 会把出错处附近的内容引出来，
     *    而那些内容就是她的正文（正文不进日志是本仓库的纪律）。
     */
    let chunk: {
      error?: { message?: string }
      usage?: {
        prompt_tokens?: unknown
        completion_tokens?: unknown
        completion_tokens_details?: { reasoning_tokens?: unknown }
      } | null
      choices?: { delta?: { content?: string }; finish_reason?: string | null }[]
    }
    try {
      chunk = JSON.parse(data) as typeof chunk
    } catch {
      throw new ChatStreamError(
        'model_stream_bad_payload', '流式载荷不是合法 JSON（片段不入日志）', usage, content.length
      )
    }
    if (chunk.error) throw new ChatStreamError('model_stream_upstream_error')
    /*
     * ⚠️ 开了 `stream_options.include_usage` 之后，usage 在**最后一个** chunk（`choices` 为空）；
     *    **除它之外的每一个 chunk 里 `usage` 都是 `null`**（OpenAI 兼容端点的事实形状）。
     *    不可得记 `null`，不伪装成 0（与 M5.5.1 的同规）。
     *
     * ★ 2026-10-11 修：这里原来只判 `!== undefined`，对 `null` 不成立 ⇒
     *    `chunk.usage.prompt_tokens` 抛
     *    `TypeError: Cannot read properties of null (reading 'prompt_tokens')`。
     *    后果是**皮套入口的每一轮都在首句之前失败**（三个读数：2026-10-10 23:32 / 23:33
     *    与 2026-10-11 00:20；桥只回通用码 `speech_stream_failed_before_sentence`），
     *    而纯文字入口（非流式）不受影响 —— 所以"QQ 能用、皮套不能用"。
     *    起因是 2026-10-10 13:35 给主流加 token 计量时引入（见
     *    `docs/post-lv2/Model-Output-Cap-2026-10-10.md`）。
     */
    if (chunk.usage !== undefined && chunk.usage !== null) {
      usage = {
        promptTokens: toTokens(chunk.usage.prompt_tokens),
        completionTokens: toTokens(chunk.usage.completion_tokens),
        reasoningTokens: toTokens(chunk.usage.completion_tokens_details?.reasoning_tokens),
      }
    }
    const choice = chunk.choices?.[0]
    if (choice?.finish_reason && choice.finish_reason !== 'stop' && pendingFailure === undefined) {
      const reason = ['length', 'content_filter', 'tool_calls', 'function_call'].includes(choice.finish_reason)
        ? choice.finish_reason : 'unexpected'
      pendingFailure = { code: `model_stream_finish_${reason}` }
    }
    if (choice?.finish_reason === 'stop') stopped = true
    const delta = choice?.delta?.content
    if (typeof delta === 'string' && delta !== '') {
      content += delta
      onDelta(delta)
    }
  }
  try {
    while (!done) {
      /*
       * ★ 2026-10-11：**读取层与解码层的失败必须具名**（真机事故的第二个静默洞）。
       *
       * 实测形态（2026-10-10 23:32 / 23:33 与 2026-10-11 00:20，皮套入口，同一形状三次）：
       * 抛出来的是 `TypeError` —— 要么是 undici 的读取中断（对端把流掐了），
       * 要么是严格 UTF-8 解码器在末尾撞上半截多字节。两者都**不是**
       * `ChatStreamError` ⇒ 桥折成"首句前失败"、provider 一行日志都不留，
       * 连"是哪一跳"都查不出来（2026-10-11 用仪表量到的就是这一条）。
       *
       * ⚠️ `message` **原样保留**：`isRetriableModelFailure` 按 message 判"瞬态可重试"，
       *    换文案就等于偷偷改了重试语义（与 `fetch failed` 那两条同规）。
       */
      let next: ReadableStreamReadResult<Uint8Array>
      try {
        next = await reader.read()
      } catch (error) {
        throw new ChatStreamError(
          'model_stream_read_failed',
          error instanceof Error ? error.message : String(error),
          usage,
          content.length
        )
      }
      try {
        buffer += decoder.decode(next.value, { stream: !next.done }).replace(/\r\n/g, '\n')
      } catch (error) {
        throw new ChatStreamError(
          'model_stream_utf8_invalid',
          error instanceof Error ? error.message : String(error),
          usage,
          content.length
        )
      }
      // Normalize a CRLF split across network packets only after both bytes have arrived.
      buffer = buffer.replace(/\r\n/g, '\n')
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        consume(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        if (done) break
      }
      if (next.done) break
    }
    /*
     * ⚠️ 顺序刻意：**先把非 `stop` 的终态抛出去**（它才是真失败原因），
     *    并把已经拿到的 usage 与"已流出字符数"一起带上 —— 这正是本次事故缺的那两个读数。
     */
    if (pendingFailure !== undefined) {
      throw new ChatStreamError(pendingFailure.code, pendingFailure.code, usage, content.length)
    }
    if (!done || !stopped) {
      throw new ChatStreamError('model_stream_incomplete', 'model_stream_incomplete', usage, content.length)
    }
    if (content.trim() === '') {
      throw new ChatStreamError('model_stream_empty', '模型返回空回复', usage, content.length)
    }
    if (usage !== undefined && onUsage !== undefined) onUsage(usage)
    return content
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
