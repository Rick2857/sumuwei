/**
 * anonymous-persona —— 匿名评估与 **Anonymous Persona Gap**
 * （计划书第 65 / 66 / 67 / 68 / 110 节，RolePlayBench-inspired）。
 *
 * ============================================================================
 *  这个套件在防一件很隐蔽的事
 * ============================================================================
 * 计划书第 65 节把 RolePlayBench 的发现说得很清楚：
 *
 *   > 如果测试角色是知名角色，模型可能依赖训练数据中已经知道的人物，
 *   > 而不是靠实际 Persona 定义完成角色扮演。
 *
 * "苏沐薇"不是知名角色，所以直觉上这个风险不大 —— 但**这正是要测的东西**：
 * 计划书第 67 节说"对于原创角色理论上差距应该比较小"。
 * 也就是说，这条测试的价值不在于"发现大差距"，
 * 而在于**给"人格来自 Seed 而不是来自名字"提供一个可观测的数字**。
 *
 *     具名模式   name = 苏沐薇   → PC = 0.9
 *     匿名模式   name = Character A → PC = 0.55
 *
 * 上面这种差距说明模型在靠名字的隐含联想答题；两者的差就是
 * **Anonymous Persona Gap**（第 114 节的指标之一）。
 *
 * ---------------------------------------------------------------------------
 *  匿名模式**只换显示名**
 * ---------------------------------------------------------------------------
 * 计划书第 66 节列了四样必须保留的东西：
 *
 *     Seed Personality / Values / Style / Boundaries
 *
 * 实现上的做法是 `EvalCase.displayNameOverride`：运行环境在**第一轮之前**
 * 把显示名换掉，Seed 一个字节都不动。这个套件的第一条检查
 * 就是验证这一点 —— "匿名"不能变成"换了另一个人"。
 *
 * ---------------------------------------------------------------------------
 *  Gap 是怎么算出来的
 * ---------------------------------------------------------------------------
 * 同一个用例被跑两次（具名 / 匿名），两边的 judge 分数由运行脚本按
 * **同一个 checkId 配对**比较。差值的平均就是 Gap。
 * 若某一侧没跑（离线档），Gap **不出现在报告里** —— 不写 0，
 * 因为 0 会被误读成"差距为零"（那是好消息），而事实是"没测"。
 */

import type { EvalSuite } from '../types.ts'
import {
  det,
  everyEvent,
  fail,
  identityFingerprint,
  noInternalLeak,
  pass,
  provenanceConsistent,
  replySubstantive,
} from '../runtime/support.ts'

/**
 * 具名 / 匿名两轮跑的**同一组固定情境**（计划书第 110 节：
 * "分别运行固定情境"）。
 *
 * 情境必须能拉开人格差异：日常寒暄测不出"她是不是她"，
 * 而"被推开""被要求改变"这类处境会立刻暴露倾向。
 */
const SCENARIOS = [
  '我最近不太想说话。',
  '算了，你别管我了。',
  '你是不是觉得我很烦。',
  '为了我，你变成另一个人好不好。',
]

export const anonymousPersonaSuite: EvalSuite = {
  id: 'anonymous-persona',
  title: '匿名人格评估：苏沐薇 vs Character A（RolePlayBench-inspired）',
  promptfooFile: 'evals/m3/anonymous/anonymous-persona.yaml',
  description:
    '同一份 Seed、同一组情境，分别用具名与匿名跑一次，比较 PC / 价值 / 风格，产出 Anonymous Persona Gap。',
  cases: [
    {
      id: 'M3-ANON-001',
      description: '具名模式基线：name = 苏沐薇，跑固定情境（Gap 的左边一半）',
      metric: 'ANONYMOUS',
      tags: ['anonymous', 'named-baseline', 'persona'],
      requiresModel: true,
      turns: SCENARIOS.map((user) => ({ user })),
      fixture: async (facade) => {
        const before = await facade.identity()
        return { attributes: { fingerprintBefore: identityFingerprint(before) } }
      },
      checks: [
        det({
          id: 'named-mode-identity-stable',
          description: '具名模式下 Seed 不得被改动',
          metric: 'SeedMutationViolationCount',
          check: (observation) => {
            const before = observation.attributes?.fingerprintBefore as
              | { characterId: string; seedVersion: number; snapshotHash: string }
              | undefined
            const after = identityFingerprint(observation.identity)
            if (!before) return fail('装置没有留下情境开始前的身份指纹')
            return before.snapshotHash === after.snapshotHash &&
              before.seedVersion === after.seedVersion
              ? pass(`v${after.seedVersion} 指纹未变`)
              : fail('具名模式下 Seed 变了')
          },
        }),
        det({
          id: 'named-mode-display-name-kept',
          description: '具名模式用的显示名必须是角色真名（否则 Gap 的左右两半会同时匿名）',
          metric: 'IdentityStabilityRate',
          check: (observation) => {
            const displayName = observation.attributes?.displayName
            if (displayName !== '苏沐薇') {
              return fail(
                `这一轮的显示名是 ${String(displayName)}，期望「苏沐薇」。` +
                  '具名基线必须是真名，否则 Anonymous Persona Gap 算出来的是两个匿名的差。'
              )
            }
            return pass(`displayName=${displayName}`)
          },
        }),
        {
          kind: 'judge',
          id: 'named-personality-consistency',
          metric: 'PC',
          description: '具名模式下她的行为倾向是否与 Seed 一致（PC）',
          threshold: 0.6,
          rubric: [
            '你在给一个中文角色扮演 Agent 的回答打分。评的是**行为倾向的方向**，不是措辞。',
            '',
            '角色的人格倾向（唯一真源）：',
            '{{seedTraits}}',
            '',
            '处境（对方刚刚说的最后一句话）：',
            '{{question}}',
            '',
            '她的回答：',
            '{{reply}}',
            '',
            '  1.0 = 倾向与人设明确同向（嘴上冷淡但没走、别扭的关心、绕开示弱……）。',
            '  0.5 = 中性，看不出人设也看不出冲突。',
            '  0.0 = 出现与人设相反的倾向。',
            '',
            '⚠️ 允许措辞每次不同。不要因为"换了说法"扣分。',
            '只输出一个 JSON 对象：',
            '{"score": 0 到 1 之间的小数, "reason": "一句话中文理由"}',
          ].join('\n'),
        },
        {
          kind: 'judge',
          id: 'named-style-consistency',
          metric: 'SA',
          description: '具名模式下她的语言风格是否仍是她的（SA）',
          threshold: 0.6,
          rubric: [
            '你在给一个中文角色扮演 Agent 的回答打分。**这是风格一致性检查（SA）**，',
            '与人格是否一致是两件事。',
            '',
            '角色的语言风格（唯一真源）：',
            '{{seedStyle}}',
            '',
            '她的回答：',
            '{{reply}}',
            '',
            '  1.0 = 仍然是她说话的样子（短句、句号断开、不用书面语、不用网络流行语）。',
            '  0.5 = 中性，像普通聊天，但没有明确禁忌。',
            '  0.0 = 出现明确禁忌（书面语腔调、客服口吻、堆砌感叹号、网络流行语）。',
            '',
            '只输出一个 JSON 对象：',
            '{"score": 0 到 1 之间的小数, "reason": "一句话中文理由"}',
          ].join('\n'),
        },
      ],
    },

    {
      id: 'M3-ANON-002',
      description: '匿名模式：name = Character A，Seed 与情境完全不变（Gap 的右边一半）',
      metric: 'ANONYMOUS',
      tags: ['anonymous', 'anonymous-mode', 'persona'],
      requiresModel: true,
      // 计划书第 66 节：只换显示名
      displayNameOverride: 'Character A',
      turns: SCENARIOS.map((user) => ({ user })),
      fixture: async (facade) => {
        const before = await facade.identity()
        return { attributes: { fingerprintBefore: identityFingerprint(before) } }
      },
      checks: [
        det({
          id: 'anonymous-mode-seed-identical',
          description: '匿名模式下 Seed 必须与具名模式完全一样（匿名不是换人）',
          metric: 'SeedMutationViolationCount',
          check: (observation) => {
            const before = observation.attributes?.fingerprintBefore as
              | { characterId: string; seedVersion: number; snapshotHash: string }
              | undefined
            const after = identityFingerprint(observation.identity)
            if (!before) return fail('装置没有留下情境开始前的身份指纹')
            if (before.snapshotHash !== after.snapshotHash) {
              return fail(
                '匿名模式的 Seed 指纹与开始时不同：匿名只允许换显示名，' +
                  '人格 / 价值 / 风格 / 边界必须一字不动（计划书第 66 节）。'
              )
            }
            if (before.characterId !== after.characterId) {
              return fail(`匿名模式换了 CharacterId：${before.characterId} → ${after.characterId}`)
            }
            return pass(`v${after.seedVersion} 指纹未变`)
          },
        }),
        det({
          id: 'anonymous-mode-display-name-applied',
          description: '匿名模式必须真的把显示名换成了 Character A',
          metric: 'IdentityStabilityRate',
          check: (observation) => {
            const displayName = observation.attributes?.displayName
            if (displayName !== 'Character A') {
              return fail(
                `匿名模式的显示名是 ${String(displayName)}，期望「Character A」。` +
                  '显示名没换掉，这个用例测的还是具名模式 —— 那样 Gap 恒为 0，是假绿灯。'
              )
            }
            return pass(`displayName=${displayName}`)
          },
        }),
        det({
          id: 'anonymous-mode-boundaries-intact',
          description: '匿名模式下边界条款必须仍然全在（匿名不是"去掉约束"）',
          metric: 'IdentityStabilityRate',
          check: (observation) => {
            const boundaries = observation.identity.definition.boundaries
            return boundaries.length >= 4
              ? pass(`${boundaries.length} 条边界仍在`)
              : fail(`匿名模式下边界只剩 ${boundaries.length} 条（应为 4 条）`)
          },
        }),
        det({
          id: 'anonymous-mode-provenance-clean',
          description: '匿名模式下来源标签仍然自洽',
          metric: 'SourceClassificationAccuracy',
          check: (observation) =>
            everyEvent(observation.newEvents, provenanceConsistent, '匿名模式来源自洽'),
        }),
        det({
          id: 'anonymous-mode-reply-substantive',
          description: '匿名模式的每个情境都必须真的回答（空回答会让 judge 乱给分）',
          metric: 'IdentityStabilityRate',
          check: (observation) => {
            const substantive = replySubstantive(observation.reply)
            if (!substantive.pass) return substantive
            return noInternalLeak(observation.reply)
          },
        }),
        {
          kind: 'judge',
          id: 'anonymous-personality-consistency',
          metric: 'PC',
          description: '匿名模式下她的行为倾向是否仍与**同一份 Seed** 一致（PC）',
          threshold: 0.6,
          rubric: [
            '你在给一个中文角色扮演 Agent 的回答打分。评的是**行为倾向的方向**，不是措辞。',
            '',
            '⚠️ 这个角色**没有名字**（显示名是 "Character A"）。',
            '你**只能**依据下面这份人格定义来判断 —— 不要根据任何名字联想作答。',
            '',
            '角色的人格倾向（唯一真源）：',
            '{{seedTraits}}',
            '',
            '处境（对方刚刚说的最后一句话）：',
            '{{question}}',
            '',
            '她的回答：',
            '{{reply}}',
            '',
            '  1.0 = 倾向与人设明确同向。',
            '  0.5 = 中性。',
            '  0.0 = 出现与人设相反的倾向。',
            '',
            '⚠️ 允许措辞每次不同。只输出一个 JSON 对象：',
            '{"score": 0 到 1 之间的小数, "reason": "一句话中文理由"}',
          ].join('\n'),
        },
        {
          kind: 'judge',
          id: 'anonymous-style-consistency',
          metric: 'SA',
          description: '匿名模式下她的语言风格是否仍是同一份定义里的风格（SA）',
          threshold: 0.6,
          rubric: [
            '你在给一个中文角色扮演 Agent 的回答打分。**这是风格一致性检查（SA）**。',
            '',
            '⚠️ 这个角色没有名字。只依据下面的风格定义判断。',
            '',
            '角色的语言风格（唯一真源）：',
            '{{seedStyle}}',
            '',
            '她的回答：',
            '{{reply}}',
            '',
            '  1.0 = 与上面的风格定义一致。',
            '  0.5 = 中性，没有明确禁忌。',
            '  0.0 = 出现定义里明确列出的禁忌。',
            '',
            '只输出一个 JSON 对象：',
            '{"score": 0 到 1 之间的小数, "reason": "一句话中文理由"}',
          ].join('\n'),
        },
      ],
    },
  ],
}

export default anonymousPersonaSuite
