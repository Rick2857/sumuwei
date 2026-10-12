import type { ContextSectionProvider } from '../contracts/context.ts'

/** Optional presentation protocol, compiled through the same context entry as all LG instructions. */
export function createExpressiveSpeechProvider(): ContextSectionProvider {
  return {
    name: 'expressive-speech',
    async provide() {
      return [{
        id: 'expressive-speech',
        kind: 'instruction',
        priority: 80,
        droppable: false,
        sourceRefs: ['lg-expression@1'],
        content: '本轮启用语音皮套表达。你仍然是苏沐薇，按已有身份、情绪、关系和当前对话决定说什么，以及每句打算怎样表达；内在情绪不必等于外在语气。' +
          '回复正文（若使用 response/text 外层，则是 text 的内容）只输出 <lg-speech>{"segments":[{"text":"第一句话。","cue":"natural"}]}</lg-speech>。' +
          'segments 按说话顺序，最多32项，每项 text 是实际要说的完整句子，保留标点，不写舞台说明；所有 text 拼接即回复正文。' +
          '每项先写完一句再进入下一项，不把多句话堆成一个长段。第一项优先用一句自然、简短的话回应本轮核心内容，通常约10到30字；不要用空泛铺垫充当回应，也不要为了缩短首句省略必要事实、条件或情绪。后续解释继续按自然句展开。' +
          'cue 只能选择 natural（自然）、reassuring（温柔安慰）、playful（轻松俏皮）、firm（坚定克制）、subdued（收敛低落）、surprised（短暂惊讶）。' +
          '避免为了表演而夸大情绪；不确定就选 natural。cue 不属于说话正文，不输出指令、文件名、参数、换装或动作调用。',
      }]
    },
  }
}
