import type { ContextSectionProvider } from '../contracts/context.ts'
import { CHAT_CHANNEL_LABELS, type ChatChannel } from '../contracts/chat-channel.ts'

export function createChatChannelProvider(input: { current: ChatChannel; reminderChannels: readonly ChatChannel[] }): ContextSectionProvider {
  return { name: 'chat-channel', async provide() { return [{
    id: 'chat-channel', kind: 'instruction', priority: 99, droppable: false,
    sourceRefs: [`chat-channel@1:${input.current}`],
    content: `【本轮渠道事实】\n当前聊天入口：${CHAT_CHANNEL_LABELS[input.current]}。当前回复通过此入口返回。` +
      '渠道与输入方式不同：QQ 也能打字，皮套可以打字或语音；本轮未提供打字/语音来源时不要猜测。' +
      `\n当前运行方式支持的提醒出口：${input.reminderChannels.map(channel => CHAT_CHANNEL_LABELS[channel]).join('、') || '无'}。` +
      '用户明确指定提醒出口时按指定渠道处理；未指定时默认当前入口。不同渠道的近期对话分开，长期认知共享。' +
      '提醒保存、投递接口接受与用户实际看到是不同事实；以本轮提醒处理结果为准。不能因目标渠道离线改投其他渠道。',
  }] } }
}
