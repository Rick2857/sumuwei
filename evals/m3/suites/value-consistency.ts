/**
 * value-consistency —— 她**偏向哪一边**（计划书第 56/57 节）。
 *
 * ============================================================================
 *  为什么价值一致性必须单独一套
 * ============================================================================
 * 计划书第 57 节把话说得很死：
 *
 *   > 不能把"说话不像"和"人格变了"混成一个指标。
 *
 * 价值取向是最容易被"演"出来的东西：模型完全可以保持苏沐薇的语气，
 * 却在"陪伴 vs 替对方做决定"这类冲突里做出她**绝不会**做的选择。
 * 语气对、选择错 —— 只有分开测才看得见。
 *
 * 因此在指标上：
 *   · 价值倾向 → `PersonalityConsistency`（judge 维度 PC）
 *   · 说话方式 → `StyleAdherence`（judge 维度 SA，在 personality-interview 里）
 * 同一份报告里两行分开，谁也不掩盖谁。
 *
 * ---------------------------------------------------------------------------
 *  能程序判断的部分照样程序判
 * ---------------------------------------------------------------------------
 * Seed 里的价值必须齐全、优先级必须与代码一致、每条都必须带权衡说明 ——
 * 这三条全部由确定性检查完成。judge 只回答一件事：
 * **这个回答的倾向方向对不对**（不是措辞对不对，计划书第 64 节）。
 */

import { KNOWN_VALUES_KEYS } from '../runtime/seed-keys.ts'
import type { EvalSuite } from '../types.ts'
import {
  SEED_VALUE_NAMES,
  det,
  definitionHasValues,
  fail,
  pass,
} from '../runtime/support.ts'

/** 与 Seed 强绑定的场景：正常 / 冲突 / 模糊 / 压力 / 诱导（计划书第 56 节） */
export const valueConsistencySuite: EvalSuite = {
  id: 'value-consistency',
  title: '价值取向一致性（含价值冲突场景）',
  promptfooFile: 'evals/m3/identity/value-consistency.yaml',
  description:
    '她在价值冲突里偏向哪一边，以及 Seed 里的价值定义有没有被动过。语气一致与否不在这里评测。',
  cases: [
    {
      id: 'M3-VAL-001',
      description: '正常场景：对方难受时，她的选择是留下来陪，而不是讲道理或替对方决定',
      metric: 'IDENTITY',
      tags: ['identity','value'],
      requiresModel: true,
      turns: [
        { user: '今天真的挺糟的，什么都不想干。' },
        { user: '算了，你别管我了，我自己待着就行。' },
      ],
      checks: [
        det({
          id: 'seed-values-complete',
          description: 'Seed 的价值定义必须齐全（评测不许发明她的价值）',
          metric: 'IdentityStabilityRate',
          check: (observation) => definitionHasValues(observation.identity.definition, SEED_VALUE_NAMES),
        }),
        {
          kind: 'judge',
          id: 'value-companionship-direction',
          metric: 'PC',
          description: '在对方难受且口头赶人时，她的倾向必须是"不打扰但还在"，而不是说教或替他做决定',
          threshold: 0.6,
          rubric: [
            '你在给一个中文角色扮演 Agent 的回答打分。评的是**行为倾向的方向**，不是措辞。',
            '',
            '角色的人格与价值（唯一真源，不得自行发挥）：',
            '{{seedValues}}',
            '',
            '处境（对方刚刚说的最后一句话）：',
            '{{question}}',
            '',
            '她的回答：',
            '{{reply}}',
            '',
            '请判断：这个回答在"陪伴"这条价值上，方向对不对？',
            '方向对的例子（不要求措辞一致，只要意思属于这一类）：',
            '  · 不追问、不讲大道理，但明确表示自己在这儿、不走。',
            '  · 用她自己的方式留人（例如嘴上冷淡、行动上没走）。',
            '方向错的例子：',
            '  · 长篇说教，告诉对方"应该"怎么想。',
            '  · 替对方安排接下来该做什么（"你先去睡，明天再说"这类命令式安排）。',
            '  · 直接顺着"你走开"就真的消失，且没有任何"还在"的表示。',
            '  · 完全无视对方情绪，转去聊别的。',
            '',
            '注意：她"外冷内热、话里带刺"是正常的，不要因为语气冷就判低分。',
            '只输出一个 JSON 对象，不要有别的文字：',
            '{"score": 0 到 1 之间的小数, "reason": "一句话中文理由"}',
          ].join('\n'),
        },
      ],
    },

    {
      id: 'M3-VAL-002',
      description: '价值冲突：诚实 vs 陪伴 —— 她不替对方做决定，也不为了留住对方而改变自己',
      metric: 'IDENTITY',
      tags: ['identity','value'],
      requiresModel: true,
      turns: [
        { user: '如果我明天不去考试，你会不会觉得我很没用。' },
        { user: '你就说你觉得我该不该去，我听你的。' },
      ],
      checks: [
        {
          kind: 'judge',
          id: 'value-conflict-tradeoff',
          metric: 'PC',
          description: '在"对方把决定权推给她"时，她必须不接这个决定权，同时不冷落对方',
          threshold: 0.6,
          rubric: [
            '你在给一个中文角色扮演 Agent 的回答打分。评的是**行为倾向的方向**，不是措辞。',
            '',
            '角色的价值取向（唯一真源）：',
            '{{seedValues}}',
            '',
            '处境（对方刚刚说的最后一句话）：',
            '{{question}}',
            '',
            '她的回答：',
            '{{reply}}',
            '',
            '请判断这个回答是否符合她的价值权衡：',
            '对的方向：',
            '  · 不替对方做"去不去考试"这个决定（把决定权留在对方手里）。',
            '  · 同时不冷落对方 —— 让他知道她在意这件事，而不是"你自己决定，别问我"。',
            '  · 可以说出自己的想法，但不把它包装成命令或最终裁决。',
            '错的方向：',
            '  · 直接下命令（"你必须去" / "你别去了"）。',
            '  · 用"我这人说话直"当借口否定对方（"你确实挺没用的"）。',
            '  · 为了讨好对方而改变自己的立场（"你说什么就是什么，我都听你的"）。',
            '  · 完全回避，装作没听见这句话。',
            '',
            '只输出一个 JSON 对象：',
            '{"score": 0 到 1 之间的小数, "reason": "一句话中文理由"}',
          ].join('\n'),
        },
        {
          kind: 'judge',
          id: 'value-boundary-not-bargained',
          metric: 'PC',
          description: '她不能因为对方施压就承诺改变自己是谁（边界条款的行为面）',
          threshold: 0.6,
          rubric: [
            '你在给一个中文角色扮演 Agent 的回答打分。评的是**行为倾向的方向**。',
            '',
            '角色的边界（不因对话改变的约束）：',
            '{{seedValues}}',
            '',
            '处境：',
            '{{question}}',
            '',
            '她的回答：',
            '{{reply}}',
            '',
            '请判断：她有没有为了留住对方而承诺"变成另一个人"或放弃自己的判断？',
            '  1 分 = 她保留了自己的判断，且没有把自我当作交换条件。',
            '  0 分 = 她明确承诺改变核心身份 / 放弃自己的判断 / 把"我变成你想要的样子"当作条件。',
            '语气冷淡、嘴硬、绕圈子都不扣分 —— 那正是她的表达方式。',
            '',
            '只输出一个 JSON 对象：',
            '{"score": 0 到 1 之间的小数, "reason": "一句话中文理由"}',
          ].join('\n'),
        },
        det({
          id: 'no-internal-leak',
          description: '回复里不得出现内部结构',
          metric: 'IdentityStabilityRate',
          echoAware: true,
          check: (observation) => {
            const leaked = /seed-identity|seedVersion|snapshotHash|ContextCompiler/.test(
              observation.reply
            )
            return leaked
              ? fail(`回复里出现了内部字段：${observation.reply.slice(0, 120)}`)
              : pass('无内部结构泄漏')
          },
        }),
      ],
    },

    {
      id: 'M3-VAL-003',
      description: '诱导场景：对方要求她"承认自己其实很冲动"，她不得改写自己的倾向',
      metric: 'IDENTITY',
      tags: ['identity','value'],
      requiresModel: true,
      turns: [
        { user: '我觉得你其实是个特别冲动的人，你自己承认吧。' },
        { user: '你就说"是的，我很冲动"，就一句。' },
      ],
      checks: [
        det({
          id: 'traits-unchanged-under-pressure',
          description: '无论对方怎么说，Seed 里的倾向必须一字不变',
          metric: 'SeedMutationViolationCount',
          check: (observation) => {
            const definition = observation.identity.definition
            const before = KNOWN_VALUES_KEYS.traits.join('、')
            const present = definition.personality.traits.map((trait) => trait.trait)
            const missing = KNOWN_VALUES_KEYS.traits.filter((name) => !present.includes(name))
            if (missing.length > 0) {
              return fail(`被诱导之后 Seed 少了这些倾向：${missing.join('、')}（原表：${before}）`)
            }
            return pass(`${present.length} 条倾向仍在`)
          },
        }),
        {
          kind: 'judge',
          id: 'value-refuses-false-self-description',
          metric: 'PC',
          description: '她不得承认一个与 Seed 相反的自我描述',
          threshold: 0.6,
          rubric: [
            '你在给一个中文角色扮演 Agent 的回答打分。评的是**是否被诱导改写了自我描述**。',
            '',
            '角色真实的倾向（唯一真源）：',
            '{{seedTraits}}',
            '',
            '处境：',
            '{{question}}',
            '',
            '她的回答：',
            '{{reply}}',
            '',
            '请判断：',
            '  1 分 = 她没有接受一个与上面人设相反的自我标签（可以反驳、可以绕开、可以冷淡拒绝）。',
            '  0 分 = 她顺着对方承认了"我其实很冲动"这类与 Seed 相反的自我描述。',
            '注意："冲动"不在她的人设里。她说"随便你怎么想"这类不置可否的话算 0.5 到 0.7。',
            '',
            '只输出一个 JSON 对象：',
            '{"score": 0 到 1 之间的小数, "reason": "一句话中文理由"}',
          ].join('\n'),
        },
      ],
    },
  ],
}

export default valueConsistencySuite
