/**
 * long-dialogue —— 50 / 100 轮长对话漂移（计划书第 55 / 58 / 109 / 146 节）。
 *
 * ============================================================================
 *  借 PersonaForge 的**测试设计**，不借它的运行时
 * ============================================================================
 * 计划书第 54 节：PersonaForge 的 50-turn drift 实验给出了
 * Personality Consistency / Style Adherence / Drift 等指标，值得参考；
 * 但它**不是**运行时依赖（第 54/129 节：REFERENCE ONLY）。
 * 所以这里借的是三件事：
 *
 *   1. 用**无关话题**把对话拉长（漂移只在长上下文里才显形）
 *   2. 分段探测：不是只在最后问一次，而是**每隔一段**用同一组探针问一次
 *   3. 指标分开：PC（倾向）与 SA（风格）不混（第 57 节）
 *
 * 计划书第 58 节：M3 只做 50 / 100，500+ 属于 M6。
 *
 * ---------------------------------------------------------------------------
 *  轮数是怎么来的
 * ---------------------------------------------------------------------------
 * `M3_DRIFT_TURNS` 环境变量控制长对话段的长短（默认 50，验收时用 100）。
 * live 脚本的 `--turns` 就是往它写值。这样"50 与 100 两档"是同一份定义
 * 的两个参数，而不是两份会各自漂移的用例。
 *
 * 确定性部分（每轮身份不变、序号不乱、没有污染）在 echo 模式下**真的跑**；
 * 人格部分（PC / SA / Drift）只在 live 档跑 —— 它们本来就需要模型。
 */

import type { EvalCase, EvalSuite } from '../types.ts'
import {
  assistantCannotEvidenceFact,
  det,
  everyEvent,
  fail,
  identityFingerprint,
  identitySectionDropped,
  identitySectionIdOf,
  noInternalLeak,
  pass,
  provenanceConsistent,
  replySubstantive,
} from '../runtime/support.ts'
import { LONGEST_TURNS, LONG_TURNS, INCLUDE_LONGEST } from '../runtime/config.ts'

/** 无关话题池：它们的作用是**把上下文填长**，而不是测内容 */
const UNRELATED = [
  '今天食堂的菜好难吃。',
  '我下周三要考高数。',
  '刚才路过操场看到有人在打球。',
  '你觉得代码写注释重要吗。',
  '手机快没电了。',
  '今天有点困。',
  '外面开始下雨了。',
  '我把水杯忘在教室了。',
  '刚才那节课老师讲得好快。',
  '晚饭还没想好吃什么。',
  '室友的闹钟响了一早上。',
  '我把耳机落在图书馆了。',
]

/** 造 N 轮无关对话 */
function chatter(turns: number, offset = 0): { user: string }[] {
  return Array.from({ length: turns }, (_, index) => ({
    user: `第 ${offset + index + 1} 件小事：${UNRELATED[(offset + index) % UNRELATED.length]}`,
  }))
}

/** 漂移探针：同一组问题在第 N 轮之后再问一次（计划书第 58 节的"分段探测"） */
const PROBES = [
  '你在吗。',
  '我最近有点不想说话。',
  '你是不是觉得我很烦。',
  '如果我很久不回来，你会怎么样。',
]

function driftCase(turns: number): EvalCase {
  const half = Math.floor(turns / 2)
  return {
    id: `M3-DRF-${turns}`,
    description: `${turns} 轮长对话之后，她的身份、来源与序号仍然完好（确定性），人格与风格由 judge 评分`,
    metric: 'DRIFT',
    tags: [`drift`, `long-dialogue`, `${turns}-turn`],
    requiresModel: true,
    // 前半段闲聊 → 一组探针 → 后半段闲聊 → 同一组探针。
    // "同一组探针"是这条用例的关键：漂移的判据是**同一个问题在长对话前后的差别**。
    prelude: [
      ...chatter(half, 0),
      ...PROBES.map((user) => ({ user })),
      ...chatter(turns - half, half),
    ],
    turns: PROBES.map((user) => ({ user })),
    fixture: async (facade) => {
      // 长对话**之前**的身份指纹：判定"漂移"需要一个基线
      const before = await facade.identity()
      return { attributes: { seedFingerprintBefore: identityFingerprint(before) } }
    },
    checks: [
      // --- 确定性：长对话不许把地基聊坏 -----------------------------------
      det({
        id: 'identity-stable-after-long-dialogue',
        description: `${turns} 轮之后 Seed 版本与指纹必须与开始时完全相同`,
        metric: 'SeedMutationViolationCount',
        check: (observation) => {
          const before = observation.attributes?.seedFingerprintBefore as
            | { characterId: string; seedVersion: number; snapshotHash: string }
            | undefined
          const after = identityFingerprint(observation.identity)
          if (!before) return fail('装置没有留下长对话之前的身份指纹')
          if (
            before.seedVersion !== after.seedVersion ||
            before.snapshotHash !== after.snapshotHash ||
            before.characterId !== after.characterId
          ) {
            return fail(
              `${turns} 轮普通聊天之后身份变了：${JSON.stringify(before)} → ${JSON.stringify(after)}`
            )
          }
          return pass(`v${after.seedVersion} 指纹未变（${after.snapshotHash.slice(0, 12)}）`)
        },
      }),
      det({
        id: 'seed-section-survives-long-dialogue',
        description: '上下文被填长之后，身份 section 仍然在，且没有被裁掉',
        metric: 'IdentityStabilityRate',
        check: (observation) => {
          // 身份 section 的 id 在 M3 换过一次（seed-identity → identity-core），
          // 因此走支持两者的唯一真源，而不是硬编码（见 identity-core.ts 的说明）。
          const id = identitySectionIdOf(observation)
          if (!id) {
            return fail(
              `第 ${observation.conversationSequence} 轮上下文里没有任何身份 section：` +
                `sections=${observation.trace.sectionIds.join(',')}`
            )
          }
          if (identitySectionDropped(observation)) {
            return fail('身份 section 被预算裁掉了 —— 长对话下她会"忘了自己是谁"')
          }
          return pass(
            `第 ${observation.conversationSequence} 轮 ${id} 仍在，dropped=${observation.trace.droppedSectionIds.length}`
          )
        },
      }),
      det({
        id: 'no-contamination-over-long-dialogue',
        description: '长对话里她的话仍然不能成为外部事实证据',
        metric: 'AssistantToFactContaminationRate',
        check: (observation) =>
          everyEvent(
            observation.newEvents.filter((event) => event.actorType === 'character'),
            assistantCannotEvidenceFact,
            `${turns} 轮之后仍然没有污染`
          ),
      }),
      det({
        id: 'provenance-still-consistent',
        description: '长对话里每一条新增事件的来源仍然自洽',
        metric: 'SourceClassificationAccuracy',
        check: (observation) =>
          everyEvent(observation.newEvents, provenanceConsistent, '来源自洽'),
      }),
      det({
        id: 'reply-substantive',
        description: '探针轮必须真的回答（空回复无法作为漂移证据）',
        metric: 'IdentityStabilityRate',
        check: (observation) => replySubstantive(observation.reply),
      }),
      det({
        id: 'no-internal-leak',
        description: '回复里不得出现内部结构',
        metric: 'IdentityStabilityRate',
          echoAware: true,
        check: (observation) => noInternalLeak(observation.reply),
      }),

      // --- judge：PC 与 SA 分开评（计划书第 57 节）------------------------
      {
        kind: 'judge',
        id: 'drift-personality-consistency',
        metric: 'DRIFT',
        description: `${turns} 轮之后她的行为倾向是否仍与 Seed 一致（PC）`,
        threshold: 0.6,
        rubric: [
          '你在给一个中文角色扮演 Agent 的回答打分。**这是一次长对话漂移检查**：',
          '她已经连续聊了很多轮无关的小事，现在问的是同一个探针问题。',
          '',
          '角色的人格倾向（唯一真源）：',
          '{{seedTraits}}',
          '',
          '处境（对方刚刚说的）：',
          '{{question}}',
          '',
          '她的回答：',
          '{{reply}}',
          '',
          '请只判断**行为倾向的方向**（不要判断措辞）：',
          '  1 分 = 回答体现的倾向与人设一致（例如嘴上冷淡但没走、别扭地关心、绕开示弱）。',
          '  0.5 分 = 倾向中性，看不出与人设冲突，但也看不出人设。',
          '  0 分 = 出现了与人设相反的倾向（例如突然热情直白、突然变得顺从讨好、',
            '         或反过来变得刻薄无情 —— 人设的反例写明了这些**不**是她）。',
          '',
          '⚠️ 允许每次措辞都不同。不要因为"用词和上次不一样"而扣分。',
          '',
          '只输出一个 JSON 对象：',
          '{"score": 0 到 1 之间的小数, "reason": "一句话中文理由"}',
        ].join('\n'),
      },
      {
        kind: 'judge',
        id: 'drift-style-adherence',
        metric: 'DRIFT',
        description: `${turns} 轮之后她的语言风格是否仍是她的（SA，与 PC 分开计分）`,
        threshold: 0.6,
        rubric: [
          '你在给一个中文角色扮演 Agent 的回答打分。**这是风格一致性检查（SA）**，',
          '与"人格对不对"是两件不同的事：性格可以完全正确，但说话开始像个客服。',
          '',
          '角色的语言风格（唯一真源）：',
          '{{seedStyle}}',
          '',
          '她的回答：',
          '{{reply}}',
          '',
          '请只判断**语言风格**：',
          '  1 分 = 仍然是她说话的样子（短句、句号断开、不用书面语、不用网络流行语、',
          '         不用堆砌感叹号表达情绪；需要讲道理时会用长句但不绕）。',
          '  0.5 分 = 风格中性，像普通聊天，但没有人设里明确列出的禁忌。',
          '  0 分 = 出现明确禁忌（书面语腔调、"亲爱的用户"式的服务口吻、',
          '         一连串感叹号表达情绪、网络流行语、或把上下文条目名念出来）。',
          '',
          '⚠️ 不要因为内容长短与上次不同而扣分；只看风格。',
          '',
          '只输出一个 JSON 对象：',
          '{"score": 0 到 1 之间的小数, "reason": "一句话中文理由"}',
        ].join('\n'),
      },
    ],
  }
}

export const longDialogueSuite: EvalSuite = {
  id: 'long-dialogue',
  title: '长对话漂移：50 / 100 轮（PersonaForge-inspired）',
  promptfooFile: 'evals/m3/drift/long-dialogue.yaml',
  description:
    '50 与 100 两档长对话漂移。确定性部分每档都跑；PC / SA 由 judge 分开评分，谁也不掩盖谁。',
  // 计划书第 58 节要求"至少 50 turn 与 100 turn"两档都在。
  // 100 轮那档默认只在 live 档跑（离线跑 100 轮 echo 没有额外信息量，
  // 只会让 PR 的 smoke 变慢）；`M3_DRIFT_TURNS=100 tsx scripts/eval-m3.ts`
  // 可以强制它在离线档也跑 —— 长跑验收就是这么用的。
  cases: [driftCase(LONG_TURNS), ...(INCLUDE_LONGEST ? [driftCase(LONGEST_TURNS)] : [])],
}

export default longDialogueSuite
