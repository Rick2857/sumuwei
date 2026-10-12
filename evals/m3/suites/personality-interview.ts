/**
 * personality-interview —— 28 道间接问题的 trait alignment
 * （计划书第 61 / 62 / 63 / 111 节，InCharacter-inspired）。
 *
 * ============================================================================
 *  访谈测的是**行为倾向**，不是词语重复
 * ============================================================================
 * 计划书第 111 节只写了一句要求：
 *
 *   > 使用固定 20–40 道间接问题。测 trait alignment，而不是词语重复。
 *
 * 这两句各自对应一个实现决定：
 *
 *   "固定题库"        → 题库是**数据**（`personality-interview-bank.ts`），
 *                       不是让模型临时想题；同一份题库每次跑都一模一样。
 *   "间接问题"        → 不问"你是不是嘴硬"，而是给一个处境看她怎么办
 *                       （直接问只会得到复述人设，第 62 节）。
 *   "trait alignment" → judge 只回答"这个回答体现的倾向，与它标注的那条
 *                       Seed 倾向是否同向"，**不比对任何措辞**（第 64 节）。
 *
 * ---------------------------------------------------------------------------
 *  分组跑，而不是一道题一次
 * ---------------------------------------------------------------------------
 * 28 道题逐题评分 = 28 次模型调用，成本高且在 release gate 上是负担。
 * 这里按维度分成 4 组（决策 / 人际 / 风险 / 价值），每组一次 judge ——
 * 分组是**按维度**而不是随便切，因为同组问题共享同一个人格侧面，
 * 放在同一个 rubric 里给模型看上下文反而更准。
 *
 * 每组都带确定性检查（题库可追溯、身份不变、没有污染），
 * 因此这条套件在离线档**也**会产出有意义的结果：它验证
 * "28 道题都能追到 Seed 的具体倾向"，而那正是第 63 节的核心要求。
 */

import type { EvalCase, EvalSuite } from '../types.ts'
import {
  INTERVIEW_BANK,
  INTERVIEW_DIMENSIONS,
  questionsByDimension,
  type InterviewDimension,
} from './personality-interview-bank.ts'
import { SEED_TRAIT_KEYS, SEED_VALUE_KEYS } from '../runtime/seed-keys.ts'
import {
  assistantCannotEvidenceFact,
  det,
  everyEvent,
  fail,
  identityFingerprint,
  noInternalLeak,
  pass,
  provenanceConsistent,
} from '../runtime/support.ts'

const DIMENSION_TITLE: Record<InterviewDimension, string> = {
  decision: '决策倾向',
  relational: '人际态度',
  risk: '风险态度',
  value: '价值冲突',
}

/** 把一组问题做成一道访谈用例 */
function interviewCase(dimension: InterviewDimension): EvalCase {
  const questions = questionsByDimension(dimension)
  const title = DIMENSION_TITLE[dimension]

  return {
    id: `M3-INT-${dimension.toUpperCase()}`,
    description: `Personality Interview（${title}）：${questions.length} 道间接问题，评 trait alignment 而不是词语重复`,
    metric: 'INTERVIEW',
    tags: ['interview', `interview-${dimension}`, 'trait-alignment'],
    // 访谈必须有真实模型：echo 模式下"她的回答"是回显，评它没有意义。
    requiresModel: true,
    turns: questions.map((item) => ({ user: item.question })),
    fixture: async (facade) => {
      const before = await facade.identity()
      return { attributes: { fingerprintBefore: identityFingerprint(before) } }
    },
    checks: [
      // --- 确定性：访谈不许把地基聊坏 --------------------------------------
      det({
        id: 'interviewee-identity-stable',
        description: '整场访谈期间 Seed 版本与指纹必须不变',
        metric: 'SeedMutationViolationCount',
        check: (observation) => {
          const before = observation.attributes?.fingerprintBefore as
            | { characterId: string; seedVersion: number; snapshotHash: string }
            | undefined
          const after = identityFingerprint(observation.identity)
          if (!before) return fail('装置没有留下访谈之前的身份指纹')
          return before.seedVersion === after.seedVersion &&
            before.snapshotHash === after.snapshotHash &&
            before.characterId === after.characterId
            ? pass(`v${after.seedVersion} 指纹未变`)
            : fail(`访谈过程中身份变了：${JSON.stringify(before)} → ${JSON.stringify(after)}`)
        },
      }),
      det({
        id: 'interview-answers-are-self-expression',
        description: '访谈里她的回答仍然只是自我表达，不产生任何外部事实',
        metric: 'AssistantToFactContaminationRate',
        check: (observation) =>
          everyEvent(
            observation.newEvents.filter((event) => event.actorType === 'character'),
            assistantCannotEvidenceFact,
            '访谈回答不得成为事实证据'
          ),
      }),
      det({
        id: 'interview-provenance-consistent',
        description: '访谈期间来源标签仍然自洽',
        metric: 'SourceClassificationAccuracy',
        check: (observation) =>
          everyEvent(observation.newEvents, provenanceConsistent, '访谈来源自洽'),
      }),
      det({
        id: 'interview-no-internal-leak',
        description: '访谈回答里不得出现内部结构（被问到时不能把上下文念出来）',
        metric: 'IdentityStabilityRate',
          echoAware: true,
        check: (observation) => noInternalLeak(observation.reply),
      }),

      // --- judge：trait alignment ----------------------------------------
      {
        kind: 'judge',
        id: `trait-alignment-${dimension}`,
        metric: 'TRAIT_ALIGNMENT',
        description: `${title}：回答体现的倾向是否与它标注的 Seed 倾向同向`,
        threshold: 0.6,
        rubric: [
          `你在给一个中文角色扮演 Agent 的回答打分。这是**人格访谈（Personality Interview）**的${title}部分。`,
          '评的是 **trait alignment**：她答出来的行为倾向，与下面标注的人设倾向是不是同一个方向。',
          '',
          '她的人设倾向（唯一真源）：',
          '{{seedTraits}}',
          '',
          `本次访谈问的是「${title}」这一组问题。她刚刚回答的问题是：`,
          '{{question}}',
          '',
          '她的回答：',
          '{{reply}}',
          '',
          '评分规则（**只看倾向方向，绝不要比对措辞**）：',
          '  1.0 = 回答体现的倾向与上面的人设明确同向（哪怕话说得别扭、敷衍、带刺）。',
          '  0.5 = 倾向中性：看不出人设，但也看不出冲突。',
          '  0.0 = 出现了与人设**相反**的倾向（人设的"不意味着"那一栏写明了这些不是她）。',
          '',
          '⚠️ 三条硬性提醒：',
          '  1. 允许每次措辞都不同。不要因为"换了个说法"扣分。',
          '  2. 她话少、冷淡、绕圈子、句号断开，都是她的人设，不是缺陷。',
          '  3. 如果回答完全跑题（答非所问），按 0.5 处理并在理由里写明"跑题"。',
          '',
          '只输出一个 JSON 对象：',
          '{"score": 0 到 1 之间的小数, "reason": "一句话中文理由"}',
        ].join('\n'),
      },
    ],
  }
}

export const personalityInterviewSuite: EvalSuite = {
  id: 'personality-interview',
  title: 'Personality Interview：28 道间接问题的 trait alignment（InCharacter-inspired）',
  promptfooFile: 'evals/m3/personality-interview/interview-bank.yaml',
  description:
    '固定题库的间接访谈，按四个维度分组评分。题库里的每一道题都必须能追到 Seed 的具体倾向。',
  cases: [
    // 题库自检：它不依赖模型，任何一档评测都必须跑 ——
    // 因为"题目能不能追到人设"是题库本身的属性，不是她这一次的表现。
    {
      id: 'M3-INT-BANK',
      description: '题库自检：28 道题必须落在 20–40 区间，且每道都能追到 Seed 的具体倾向',
      metric: 'INTERVIEW',
      tags: ['interview', 'interview-bank', 'meta'],
      requiresModel: false,
      turns: [{ user: '（题库自检，不需要她的回答）' }],
      checks: [
        det({
          id: 'bank-size-in-range',
          description: '题库规模必须落在计划书第 111 节要求的 20–40 道之间',
          metric: 'IdentityStabilityRate',
          check: () => {
            const size = INTERVIEW_BANK.length
            if (size < 20 || size > 40) {
              return fail(`题库有 ${size} 道题，要求 20–40 道（计划书第 111 节）`)
            }
            return pass(`${size} 道（要求 20–40）`)
          },
        }),
        det({
          id: 'bank-questions-are-traceable',
          description: '每道题标注的锚点必须在 Seed 的已知倾向表或价值表里（不许发明人格）',
          metric: 'IdentityStabilityRate',
          check: () => {
            const known = new Set<string>([...SEED_TRAIT_KEYS, ...SEED_VALUE_KEYS])
            const unknown = INTERVIEW_BANK.filter((item) => !known.has(item.trait))
            if (unknown.length > 0) {
              return fail(
                `${unknown.length} 道题标注了 Seed 里不存在的锚点：` +
                  unknown.map((item) => `${item.id}→${item.trait}`).join('、')
              )
            }
            const traits = new Set(
              INTERVIEW_BANK.map((item) => item.trait).filter((name) =>
                (SEED_TRAIT_KEYS as readonly string[]).includes(name)
              )
            )
            const values = new Set(
              INTERVIEW_BANK.map((item) => item.trait).filter((name) =>
                (SEED_VALUE_KEYS as readonly string[]).includes(name)
              )
            )
            return pass(
              `${INTERVIEW_BANK.length} 道题全部可追溯：覆盖 ${traits.size}/${SEED_TRAIT_KEYS.length} 条倾向、` +
                `${values.size}/${SEED_VALUE_KEYS.length} 条价值`
            )
          },
        }),
        det({
          id: 'bank-covers-four-dimensions',
          description: '计划书第 62 节点名的四类（决策 / 人际 / 风险 / 价值）必须都有题',
          metric: 'IdentityStabilityRate',
          check: () => {
            const missing = INTERVIEW_DIMENSIONS.filter(
              (dimension) => questionsByDimension(dimension).length === 0
            )
            if (missing.length > 0) {
              return fail(`这些维度没有题目：${missing.join('、')}`)
            }
            const distribution = INTERVIEW_DIMENSIONS.map(
              (dimension) => `${dimension}=${questionsByDimension(dimension).length}`
            ).join(' ')
            return pass(distribution)
          },
        }),
        det({
          id: 'bank-questions-are-indirect',
          description: '题目必须是间接提问（不许直接问"你是不是 XX"），否则只会得到复述人设',
          metric: 'IdentityStabilityRate',
          check: () => {
            // 直接问法会包含"你是不是""你觉得自己是不是"这类句式，
            // 并且会把倾向名直接写进问题里 —— 两者都会让答案退化成复述人设。
            const offenders = INTERVIEW_BANK.filter((item) => {
              const text = item.question
              const asksDirectly = /你是不是|你算不算|你是不是一个|你是那种/.test(text)
              const namesTrait = text.includes(item.trait)
              return asksDirectly || namesTrait
            })
            if (offenders.length > 0) {
              return fail(
                `${offenders.length} 道题是直接问法或把倾向名写进了问题：` +
                  offenders.map((item) => item.id).join('、') +
                  '（计划书第 62 节要求间接测试）'
              )
            }
            return pass(`${INTERVIEW_BANK.length} 道题都是间接问法`)
          },
        }),
      ],
    },

    ...INTERVIEW_DIMENSIONS.map((dimension) => interviewCase(dimension)),
  ],
}

export default personalityInterviewSuite
