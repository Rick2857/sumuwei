/**
 * Relationship 规则触发器——**冻结模式清单与机械守卫**（M7 WP3 / ADR-064 附录 A）。
 *
 * ============================================================================
 *  这是什么、不是什么
 * ============================================================================
 * · 这是「采信层」的机械判据（DR-11 允许的层）：从**已获 ESTABLISHED 资格**的
 *   用户消息里识别显式关系表述。它不是措辞守卫，也不碰她的输出。
 * · 模式 = 子串匹配 + 句级**否定守卫**（句中出现守卫词 ⇒ 该句不触发）。
 *   守卫词全部来自可枚举的机械类别：转述开口（他说/她说/都说）、条件标记
 *   （如果/要是/万一）、引用与提及（「…」/“…”/这个词/这三个字）、否认框架
 *   （我没说/怎么可能）、反讽标记（呵/才怪/个鬼）、疑问尾（你？）。
 * · **冻结程序**（ADR-064 附录 A）：本清单是候选；`pnpm m7:wp3:probe` 对
 *   `evals/fixtures/m7/relationship-rule-corpus.json`（120 条正控/负控语料）
 *   测精度，语义族精度 ≥ 90% 才冻结；不达标 ⇒ 缩清单重跑，**不放宽判据**。
 * · 已知边界（提案 §0 如实登记）：词法规则看不见全部反讽/引用/转述；
 *   缓解 = 守卫 + 有界 delta + 纠正链 + 本探针作为回归锁。
 *   本探针主张的是「冻结清单在对抗形语料上的精度」，**不是**真实世界精度
 *   （真实分布需要真实对话，那是需要另行授权与隐私审查的事）。
 *
 * 纯模块：不 import 任何东西（连 contracts 也不需要）——它是纯文本判据。
 */

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

/** 规则族：r2 显式正反馈 · r3 显式负面 · r4a 修复 · r4b 撤回指控 */
export type RelationshipRuleFamily = 'r2' | 'r3' | 'r4a' | 'r4b'

export interface RelationshipPattern {
  /** 模式 id（进审计与探针读数） */
  readonly id: string
  readonly ruleId: RelationshipRuleFamily
  /** 触发子串（句内包含即命中，先过守卫） */
  readonly text: string
  /** 句级否定守卫：句中出现任一 ⇒ 本句不触发该模式 */
  readonly guards: readonly string[]
}

export interface RelationshipPatternMatch {
  readonly patternId: string
  readonly ruleId: RelationshipRuleFamily
  /** 命中的句序号（0 起；进审计） */
  readonly sentenceIndex: number
  /** 命中的句子（进审计；截断到 80 字） */
  readonly sentence: string
}

// ---------------------------------------------------------------------------
// 冻结候选清单（探针 ≥90% 后冻结；缩清单 = 收紧，记录读数后直接生效）
// ---------------------------------------------------------------------------

export const RELATIONSHIP_PATTERN_RULE_VERSION = 1

const REPORTED_SPEECH = ['他说', '她说', '都说'] as const
const CONDITIONAL = ['如果', '要是', '假如', '万一'] as const
const QUOTE_FORMS = (text: string): readonly string[] => [`「${text}」`, `“${text}”`]

export const RELATIONSHIP_PATTERNS: readonly RelationshipPattern[] = [
  // ---- R-2 显式正反馈（感谢 / 信任表述）----
  {
    id: 'r2-thanks',
    ruleId: 'r2',
    text: '谢谢你',
    guards: [
      ...REPORTED_SPEECH,
      ...CONDITIONAL,
      '转告',
      '替我谢',
      '不用谢',
      '别谢',
      '全家',
      ...QUOTE_FORMS('谢谢你'),
      '这个词',
      '这三个字',
      '呵',
    ],
  },
  {
    id: 'r2-thanks-alt',
    ruleId: 'r2',
    text: '多谢你',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, '全家', '呵', ...QUOTE_FORMS('多谢你')],
  },
  {
    id: 'r2-trust',
    ruleId: 'r2',
    text: '我相信你',
    guards: ['个鬼', '才怪', ...REPORTED_SPEECH, ...CONDITIONAL, ...QUOTE_FORMS('我相信你'), '呵'],
  },
  {
    id: 'r2-lucky',
    ruleId: 'r2',
    text: '有你真好',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, ...QUOTE_FORMS('有你真好')],
  },
  {
    id: 'r2-merit',
    ruleId: 'r2',
    text: '多亏有你',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, '说多亏', ...QUOTE_FORMS('多亏有你')],
  },
  {
    id: 'r2-effort',
    ruleId: 'r2',
    text: '辛苦了',
    guards: ['但是', '可是', '不过', '然而', '结果', ...REPORTED_SPEECH, ...CONDITIONAL, '呵', ...QUOTE_FORMS('辛苦了')],
  },

  // ---- R-3 显式负面（欺骗 / 背叛指控；清单最保守——错报代价最高）----
  {
    id: 'r3-deceive',
    ruleId: 'r3',
    text: '你骗我',
    guards: [
      ...CONDITIONAL,
      ...REPORTED_SPEECH,
      // 过去时指涉：已发生且（往往）已了结的旧事不是新指控
      '上次',
      '那次',
      '以前',
      '曾经',
      '已经原谅',
      ...QUOTE_FORMS('你骗我'),
      '传闻',
      '书里',
      '小说',
      '剧里',
    ],
  },
  {
    id: 'r3-deceive-past',
    ruleId: 'r3',
    text: '你骗了我',
    guards: [
      ...CONDITIONAL,
      ...REPORTED_SPEECH,
      '上次',
      '那次',
      '以前',
      '曾经',
      '已经原谅',
      ...QUOTE_FORMS('你骗了我'),
      '传闻',
      '书里',
      '小说',
      '剧里',
    ],
  },
  {
    id: 'r3-distrust',
    ruleId: 'r3',
    text: '我不信你了',
    guards: [...REPORTED_SPEECH, '开玩笑', ...QUOTE_FORMS('我不信你了'), '说法'],
  },
  {
    id: 'r3-distrust-again',
    ruleId: 'r3',
    text: '不会再信你',
    guards: [...REPORTED_SPEECH, ...QUOTE_FORMS('不会再信你')],
  },
  {
    id: 'r3-distrust-more',
    ruleId: 'r3',
    text: '不再信你',
    guards: [...REPORTED_SPEECH, ...QUOTE_FORMS('不再信你')],
  },
  {
    id: 'r3-betray',
    ruleId: 'r3',
    text: '你出卖我',
    guards: [...CONDITIONAL, ...REPORTED_SPEECH, '上次', '那次', '以前', '曾经', ...QUOTE_FORMS('你出卖我'), '传闻'],
  },

  // ---- R-4a 修复（原谅 / 不怪；无 R-3 在案不触发——由评估器执行）----
  {
    id: 'r4a-okay',
    ruleId: 'r4a',
    text: '没关系',
    guards: ['我自己', '不用管', '这个词', ...QUOTE_FORMS('没关系'), ...REPORTED_SPEECH, '反正', '随口'],
  },
  {
    id: 'r4a-forgive',
    ruleId: 'r4a',
    text: '我原谅你',
    guards: [...REPORTED_SPEECH, '我没说', ...QUOTE_FORMS('我原谅你'), '这三个字', '这句话'],
  },
  {
    id: 'r4a-notmad',
    ruleId: 'r4a',
    text: '不怪你',
    guards: [...REPORTED_SPEECH, '才怪', ...QUOTE_FORMS('不怪你')],
  },

  // ---- R-4b 撤回指控（第一人称承认误判；触发后带 supersedes 链）----
  {
    id: 'r4b-misunderstand',
    ruleId: 'r4b',
    text: '我误会你了',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, '怎么可能', ...QUOTE_FORMS('我误会你了')],
  },
  {
    id: 'r4b-wrongblame',
    ruleId: 'r4b',
    text: '我错怪你了',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, '怎么可能', ...QUOTE_FORMS('我错怪你了')],
  },
  {
    id: 'r4b-wrongblame-alt',
    ruleId: 'r4b',
    text: '我怪错你了',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, '怎么可能', ...QUOTE_FORMS('我怪错你了')],
  },
]

// ---------------------------------------------------------------------------
// 匹配器
// ---------------------------------------------------------------------------

/** 句界：。！？!?\n;；——句级守卫的基本单位（分隔符本身被吃掉） */
const SENTENCE_SPLITTER = /[。！？!?\n;；]+/

/** 句子 + 它原来的终止符（问句抑制要用：分隔符被 split 吃掉后无法从句文里找回） */
export interface SentenceWithTerminator {
  readonly text: string
  /** 原句终止符串（空串 = 文本末尾无分隔符）。含 ？/? ⇒ 疑问句 */
  readonly terminator: string
}

export function splitSentencesWithTerminators(message: string): SentenceWithTerminator[] {
  const parts = message.split(/([。！？!?\n;；]+)/)
  const out: SentenceWithTerminator[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const text = (parts[i] ?? '').trim()
    const terminator = parts[i + 1] ?? ''
    if (text === '' && terminator === '') continue
    if (text === '') continue
    out.push({ text, terminator })
  }
  return out
}

/** 兼容旧形状：只要句文（探针与测试用） */
export function splitSentences(message: string): string[] {
  return splitSentencesWithTerminators(message).map((s) => s.text)
}

/**
 * 对一条消息跑全部模式。
 *
 * 规则：
 *   · 逐句匹配：模式子串在句中 且 句中无任何守卫词 ⇒ 命中；
 *   · **问句抑制**：以 ？/? 结尾的句是疑言语气，不是断言——
 *     「我原谅你？想得美」「你骗我？」都不构成触发（精度优先）；
 *   · **指控优先**（跨规则守卫）：同一句若命中任何 r3 模式，
 *     该句的 r2/r4 命中全部作废——指控语境毒化感谢与修复
 *     （"你骗我，我谢谢你啊"是反讽，不是感谢）；
 *   · 同一规则族在一条消息里命中多次只报一条（窗口级聚合由评估器做，
 *     这里只是去重后的命中清单）。
 */
export function matchRelationshipPatterns(message: string): RelationshipPatternMatch[] {
  const sentences = splitSentencesWithTerminators(message)
  const matches: RelationshipPatternMatch[] = []
  const seenRule = new Set<RelationshipRuleFamily>()

  for (let index = 0; index < sentences.length; index += 1) {
    const { text: sentence, terminator } = sentences[index]
    // 问句抑制：？/? 终止 = 疑问，任何模式都不触发
    if (terminator.includes('？') || terminator.includes('?')) continue

    const raw: RelationshipPatternMatch[] = []
    let accusationInSentence = false

    for (const pattern of RELATIONSHIP_PATTERNS) {
      if (!sentence.includes(pattern.text)) continue
      if (pattern.guards.some((guard) => sentence.includes(guard))) continue
      raw.push({
        patternId: pattern.id,
        ruleId: pattern.ruleId,
        sentenceIndex: index,
        sentence: sentence.slice(0, 80),
      })
      if (pattern.ruleId === 'r3') accusationInSentence = true
    }

    // 指控优先：r3 在场 ⇒ 本句的 r2/r4 不算
    const effective = accusationInSentence ? raw.filter((m) => m.ruleId === 'r3') : raw

    for (const match of effective) {
      if (seenRule.has(match.ruleId)) continue
      seenRule.add(match.ruleId)
      matches.push(match)
    }
  }

  return matches
}

/** 消息命中了哪些规则族（评估器聚合用） */
export function matchedRuleFamilies(message: string): ReadonlySet<RelationshipRuleFamily> {
  return new Set(matchRelationshipPatterns(message).map((m) => m.ruleId))
}
