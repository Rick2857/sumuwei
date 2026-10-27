import type { ContextSectionProvider } from '../contracts/context.ts'
import type { QqReplyDeliveryFact } from '../contracts/qq-media-reply.ts'

/**
 * QQ 出站媒介选择（P1）——**只壳给 QQ 入口**的一条指令 section。
 *
 * ============================================================================
 *  它告诉她的 / 它不告诉她的
 * ============================================================================
 * ```text
 * 告诉：这一轮可以用文字或语音；封套格式；语音的**技术上限**（一条完整气泡）
 * 不告诉：什么时候必须用语音、多久用一次、哪些词触发 —— 那是**她**按对话决定的事
 * ```
 *
 * ⚠️ 不挂这条 section 时（开关关 / 非 QQ 入口 / 语音输出不可用），
 *    prompt 与改动前**逐字节相同**（与 `expressive-speech` 同一条纪律）。
 * ⚠️ 它**不**改写正文、**不**选媒介：真正的解析在 `qq-media-reply` 契约里，
 *    且只解码**完整封套**（正文里出现"语音"二字不算）。
 */
export function createQqMediaReplyProvider(delivery?: QqReplyDeliveryFact): ContextSectionProvider {
  return {
    name: 'qq-media-reply',
    async provide() {
      return [{
        id: 'qq-media-reply',
        kind: 'instruction',
        priority: 85,
        droppable: false,
        sourceRefs: ['qq-media@1'],
        content:
          '【本轮 QQ 出站媒介】这一条 QQ 回复可以由你决定用文字还是语音发出。' +
          '当前 QQ 语音输出已配置：你选择 mode=voice 后，由 QQ 外壳合成并发送 text，不需要调用其它工具。' +
          '过去对话中“只能文字、没有语音接口”的说法不代表当前能力；想用文字是你的选择，不能把这种选择说成接口不存在。' +
          '只在回复的最外层输出**一个完整封套**，封套之外不要写任何别的文字：' +
          '<lg-qq-media>{"version":1,"mode":"text","text":"这轮要说的正文"}</lg-qq-media>。' +
          'mode 只有 text 和 voice 两个值：text = 直接发文字；voice = 把 text 合成为一条完整语音消息' +
          '（QQ 里的一条语音气泡，最长约 60 秒、不超过 4 MiB）。' +
          'voice 的 text 要短到能在 60 秒内自然说完，不要放网址、代码、表格或大段资料——这类内容用 text。' +
          'text 与 voice 里的正文都应当是你这一轮真正要表达的内容：不要为了发语音而概括、分句或另写一份"更口语的版本"。' +
          '对方此刻说想听你说、不方便听、或让你打字，都是你在对话里理解的当前要求，程序不会按关键词替你判断；' +
          '你也不必每轮都用语音。没有封套的旧式正文会按文字发出。' +
          '封套之外不要写说明、标签或舞台提示。' +
          (delivery === undefined ? '' : '\n【上一条 QQ 回复交付事实】' + JSON.stringify(delivery) +
            '\nrequested 是你原先选择的媒介，effective 是实际尝试的媒介。api_accepted 只表示平台接受，不代表对方已听或已读；' +
            'delivery_unknown/unknown_after_restart 表示结果不明，reserved/fallback_text 不是已发送。结合实际结果理解后续对话，不补造成功。'),
      }]
    },
  }
}
