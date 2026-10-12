/**
 * Affect 规则触发器——**冻结模式清单与机械守卫**（M8 WP2 / ADR-066 §4）。
 *
 * ============================================================================
 *  这是什么、不是什么（与 M7 patterns.ts 同一纪律）
 * ============================================================================
 * · 这是「采信层」的机械判据：从**已获 ESTABLISHED 资格**的 active user
 *   消息里识别显式情绪性表述。它不是措辞守卫，也不碰她的输出。
 * · 模式 = 句内子串匹配 + 句级**否定守卫**（句中出现守卫词 ⇒ 该句不触发）。
 *   守卫词全部来自可枚举的机械类别：转述开口（他说/她说/都说）、条件标记
 *   （如果/要是/万一）、引用形式（「…」/“…”）、否认前缀（不/别——按词形
 *   逐模式登记，如 不喜欢/不讨厌/不在乎）、反讽标记（呵/才怪/个鬼/开玩笑）、
 *   疑问尾（？/? ⇒ 整句抑制）。
 * · **冻结程序**（ADR-066 §4.3）：本清单是 affect-rules@1 的词形判据；
 *   扩展 = 升 affect-rules@2，不允许"顺手加词"。覆盖面外的表述不触发——
 *   漏判的代价是"只 touch 不 impact"（诚实的中性），误判的代价是伪造情绪
 *   事件（不可接受）。精度优先。
 * · **明确不做的推断**（ADR-066 §4.3 / 计划 §5.2）：不做心理判断、不推断
 *   用户真实情绪、不从工具失败/她的语气/不回复推断任何情绪事件。
 *
 * 纯模块：只 import contracts 的规则标识类型（依赖方向单向：app → contracts）。
 */

import type { AffectRuleFamily } from '../../contracts/affect.ts'

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

/**
 * 规则族（contracts/affect.ts 的冻结标识；这里只做词形判据）。
 *
 * `A-NEUTRAL-TOUCH`（无命中时的 touch）与 `A-UNCERTAIN`（无法判定时的具名
 * 回退，v1 恒不产生 impact——M8-D09 全序可判定）**不是模式族**：
 * 它们不进本清单，也永远不会出现在 IMPACT 事件的 ruleId 里。
 */

export interface AffectPattern {
  /** 模式 id（进审计与探针读数） */
  readonly id: string
  readonly ruleId: AffectRuleFamily
  /** 触发子串（句内包含即命中，先过守卫） */
  readonly text: string
  /** 句级否定守卫：句中出现任一 ⇒ 本句不触发该模式 */
  readonly guards: readonly string[]
}

export interface AffectPatternMatch {
  readonly patternId: string
  readonly ruleId: AffectRuleFamily
  /** 命中的句序号（0 起；进审计） */
  readonly sentenceIndex: number
  /** 命中的句子（进审计；截断到 80 字） */
  readonly sentence: string
}

// ---------------------------------------------------------------------------
// 冻结清单（affect-rules@1；ADR-066 §4.1/§4.3）
// ---------------------------------------------------------------------------

export const AFFECT_PATTERN_RULE_VERSION = 1

const REPORTED_SPEECH = ['他说', '她说', '都说'] as const
const CONDITIONAL = ['如果', '要是', '假如', '万一'] as const
const QUOTE_FORMS = (text: string): readonly string[] => [`「${text}」`, `“${text}”`]
const SARCASM = ['呵', '才怪', '个鬼', '开玩笑'] as const

export const AFFECT_PATTERNS: readonly AffectPattern[] = [
  // ---- A-GRATITUDE 感谢、认可、温和肯定（Δv +0.08 / Δa −0.03）----
  {
    id: 'ag-thanks',
    ruleId: 'A-GRATITUDE',
    text: '谢谢你',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, '不用谢', '别谢', '替我谢', '转告', ...SARCASM, ...QUOTE_FORMS('谢谢你')],
  },
  {
    id: 'ag-thanks-alt',
    ruleId: 'A-GRATITUDE',
    text: '多谢',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, '不用谢', ...SARCASM, ...QUOTE_FORMS('多谢')],
  },
  {
    id: 'ag-effort',
    ruleId: 'A-GRATITUDE',
    text: '辛苦了',
    guards: ['但是', '可是', '不过', '然而', '结果', ...REPORTED_SPEECH, ...CONDITIONAL, ...SARCASM, ...QUOTE_FORMS('辛苦了')],
  },
  {
    id: 'ag-good',
    ruleId: 'A-GRATITUDE',
    text: '有你真好',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, ...SARCASM, ...QUOTE_FORMS('有你真好')],
  },
  {
    id: 'ag-merit',
    ruleId: 'A-GRATITUDE',
    text: '多亏有你',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, '说多亏', ...QUOTE_FORMS('多亏有你')],
  },

  // ---- A-REPAIR 道歉、修复、承认造成影响（Δv +0.12 / Δa −0.08）----
  {
    id: 'ar-sorry',
    ruleId: 'A-REPAIR',
    text: '对不起',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, ...SARCASM, ...QUOTE_FORMS('对不起'), '这三个字', '这个词'],
  },
  {
    id: 'ar-apology',
    ruleId: 'A-REPAIR',
    text: '抱歉',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, ...SARCASM, ...QUOTE_FORMS('抱歉')],
  },
  {
    id: 'ar-mybad',
    ruleId: 'A-REPAIR',
    text: '我错了',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, ...SARCASM, ...QUOTE_FORMS('我错了')],
  },
  {
    id: 'ar-myfault',
    ruleId: 'A-REPAIR',
    text: '是我不对',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, ...SARCASM, ...QUOTE_FORMS('是我不对')],
  },
  {
    id: 'ar-forgiveme',
    ruleId: 'A-REPAIR',
    text: '原谅我',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, ...SARCASM, ...QUOTE_FORMS('原谅我')],
  },

  // ---- A-WARM-CONTACT 温暖关心、亲近表达（Δv +0.08 / Δa +0.03）----
  {
    id: 'aw-missyou',
    ruleId: 'A-WARM-CONTACT',
    text: '想你了',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, ...SARCASM, ...QUOTE_FORMS('想你了')],
  },
  {
    id: 'aw-likeyou',
    ruleId: 'A-WARM-CONTACT',
    text: '喜欢你',
    guards: ['不喜欢', ...REPORTED_SPEECH, ...CONDITIONAL, ...SARCASM, ...QUOTE_FORMS('喜欢你')],
  },
  {
    id: 'aw-loveyou',
    ruleId: 'A-WARM-CONTACT',
    text: '爱你',
    guards: ['不爱', ...REPORTED_SPEECH, ...CONDITIONAL, ...SARCASM, ...QUOTE_FORMS('爱你')],
  },
  {
    id: 'aw-hug',
    ruleId: 'A-WARM-CONTACT',
    text: '抱抱',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, ...SARCASM, ...QUOTE_FORMS('抱抱')],
  },
  {
    id: 'aw-care',
    ruleId: 'A-WARM-CONTACT',
    text: '在乎你',
    guards: ['不在乎', ...REPORTED_SPEECH, ...CONDITIONAL, ...SARCASM, ...QUOTE_FORMS('在乎你')],
  },

  // ---- A-COMFORT 安慰、平复、缓和（Δv +0.10 / Δa −0.08）----
  {
    id: 'ac-dontbesad',
    ruleId: 'A-COMFORT',
    text: '别难过',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, ...QUOTE_FORMS('别难过')],
  },
  {
    id: 'ac-dontcry',
    ruleId: 'A-COMFORT',
    text: '别哭',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, ...QUOTE_FORMS('别哭')],
  },
  {
    id: 'ac-okay',
    ruleId: 'A-COMFORT',
    text: '没事的',
    guards: [...SARCASM, ...QUOTE_FORMS('没事的')],
  },
  {
    id: 'ac-willbeok',
    ruleId: 'A-COMFORT',
    text: '会好的',
    guards: ['不会', '怎么可能', ...REPORTED_SPEECH, ...CONDITIONAL, ...QUOTE_FORMS('会好的')],
  },
  {
    id: 'ac-taketime',
    ruleId: 'A-COMFORT',
    text: '慢慢来',
    guards: [...REPORTED_SPEECH, ...QUOTE_FORMS('慢慢来')],
  },
  {
    id: 'ac-dontangry',
    ruleId: 'A-COMFORT',
    text: '别生气',
    guards: [...REPORTED_SPEECH, ...QUOTE_FORMS('别生气')],
  },

  // ---- A-HOSTILE 明确攻击、侮辱、敌意（Δv −0.15 / Δa +0.12；清单最保守——错报代价最高）----
  {
    id: 'ah-hateyou',
    ruleId: 'A-HOSTILE',
    text: '讨厌你',
    guards: ['不讨厌', ...REPORTED_SPEECH, ...CONDITIONAL, ...SARCASM, ...QUOTE_FORMS('讨厌你')],
  },
  {
    id: 'ah-goaway',
    ruleId: 'A-HOSTILE',
    text: '滚开',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, ...QUOTE_FORMS('滚开')],
  },
  {
    id: 'ah-shutup',
    ruleId: 'A-HOSTILE',
    text: '闭嘴',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, ...QUOTE_FORMS('闭嘴')],
  },
  {
    id: 'ah-useless',
    ruleId: 'A-HOSTILE',
    text: '你真没用',
    guards: [...SARCASM, ...REPORTED_SPEECH, ...QUOTE_FORMS('你真没用')],
  },
  {
    id: 'ah-lousy',
    ruleId: 'A-HOSTILE',
    text: '你真差劲',
    guards: [...SARCASM, ...REPORTED_SPEECH, ...QUOTE_FORMS('你真差劲')],
  },
  {
    id: 'ah-fedup',
    ruleId: 'A-HOSTILE',
    text: '烦死你',
    guards: [...REPORTED_SPEECH, ...QUOTE_FORMS('烦死你')],
  },
  {
    id: 'ah-hateword',
    ruleId: 'A-HOSTILE',
    text: '我恨你',
    guards: ['不恨', ...REPORTED_SPEECH, ...CONDITIONAL, ...SARCASM, ...QUOTE_FORMS('我恨你')],
  },

  // ---- A-REJECTION 明确拒绝、关系撤回表达（Δv −0.10 / Δa +0.08；普通"不同意"不触发）----
  {
    id: 'aj-nocontact',
    ruleId: 'A-REJECTION',
    text: '不要联系了',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, ...QUOTE_FORMS('不要联系了')],
  },
  {
    id: 'aj-leaveme',
    ruleId: 'A-REJECTION',
    text: '别找我了',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, ...QUOTE_FORMS('别找我了')],
  },
  {
    id: 'aj-breakoff',
    ruleId: 'A-REJECTION',
    text: '绝交',
    guards: ['和好', ...REPORTED_SPEECH, ...CONDITIONAL, ...SARCASM, ...QUOTE_FORMS('绝交')],
  },
  {
    id: 'aj-ignoreyou',
    ruleId: 'A-REJECTION',
    text: '不想理你',
    guards: ['又想', '还想', ...REPORTED_SPEECH, ...CONDITIONAL, ...QUOTE_FORMS('不想理你')],
  },
  {
    id: 'aj-breakup',
    ruleId: 'A-REJECTION',
    text: '我们分手',
    guards: [...REPORTED_SPEECH, ...CONDITIONAL, ...SARCASM, ...QUOTE_FORMS('我们分手')],
  },

  // ---- A-URGENT 明确紧急、强烈催促（Δv 0 / Δa +0.10；只影响激活，不动效价）----
  {
    id: 'au-hurry',
    ruleId: 'A-URGENT',
    text: '快点',
    guards: ['不急', ...REPORTED_SPEECH, ...QUOTE_FORMS('快点')],
  },
  {
    id: 'au-quick',
    ruleId: 'A-URGENT',
    text: '赶紧',
    guards: [...REPORTED_SPEECH, ...QUOTE_FORMS('赶紧')],
  },
  {
    id: 'au-emergency',
    ruleId: 'A-URGENT',
    text: '紧急',
    guards: ['不紧急', ...REPORTED_SPEECH, ...QUOTE_FORMS('紧急')],
  },
  {
    id: 'au-rightnow',
    ruleId: 'A-URGENT',
    text: '立刻',
    guards: [...REPORTED_SPEECH, ...QUOTE_FORMS('立刻')],
  },
  {
    id: 'au-help',
    ruleId: 'A-URGENT',
    text: '救命',
    guards: [...REPORTED_SPEECH, '书里', '小说', '剧里', '游戏', ...QUOTE_FORMS('救命')],
  },
]

// ---------------------------------------------------------------------------
// 冻结规则表（ADR-066 §4.1 的 delta；评估器产 proposal 的唯一数值来源）
// ---------------------------------------------------------------------------

/** 冻结优先级全序（M8-D09；高 → 低） */
export const AFFECT_RULE_PRIORITY: readonly AffectRuleFamily[] = [
  'A-HOSTILE',
  'A-REJECTION',
  'A-URGENT',
  'A-REPAIR',
  'A-COMFORT',
  'A-GRATITUDE',
  'A-WARM-CONTACT',
]

// 冻结 delta 表已上移 contracts/affect.ts（M8.5 WP7：放行口的精确增量判据需要
// 从 policies/ 读到它——policies 不许 import app/）。此处 re-export 保持
// 既有导入面（evaluator / semantic-evaluator / 各门脚本）不变。
export { AFFECT_RULE_DELTAS } from '../../contracts/affect.ts'

// ---------------------------------------------------------------------------
// 匹配器
// ---------------------------------------------------------------------------

/** 句界：。！？!?\n;；——句级守卫的基本单位（与 M7 同一切分器） */
const SENTENCE_SPLITTER = /[。！？!?\n;；]+/

/** 句子 + 它原来的终止符（问句抑制要用：分隔符被 split 吃掉后无法从句文里找回） */
export interface AffectSentenceWithTerminator {
  readonly text: string
  /** 原句终止符串（空串 = 文本末尾无分隔符）。含 ？/? ⇒ 疑问句 */
  readonly terminator: string
}

export function splitAffectSentencesWithTerminators(message: string): AffectSentenceWithTerminator[] {
  const parts = message.split(/([。！？!?\n;；]+)/)
  const out: AffectSentenceWithTerminator[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const text = (parts[i] ?? '').trim()
    const terminator = parts[i + 1] ?? ''
    if (text === '') continue
    out.push({ text, terminator })
  }
  return out
}

/** 兼容旧形状：只要句文（探针与测试用） */
export function splitAffectSentences(message: string): string[] {
  return splitAffectSentencesWithTerminators(message).map((s) => s.text)
}

/**
 * 对一条消息跑全部模式。
 *
 * 规则（ADR-066 §4.3 冻结）：
 *   · 逐句匹配：模式子串在句中 且 句中无任何守卫词 ⇒ 命中；
 *   · **问句抑制**：以 ？/? 结尾的句是疑言语气，不是断言——
 *     「你讨厌我吗？」「喜欢你？」都不构成触发（精度优先）；
 *   · **敌意/拒绝毒化**（句级跨族守卫，M7 指控优先的同构）：
 *     同一句若命中 A-HOSTILE / A-REJECTION，该句的正面族命中全部作废——
 *     敌意语境毒化感谢与安慰（"我讨厌你，谢谢你啊"是反讽，不是感谢）；
 *   · 同一规则族在一条消息里命中多次只报一条（消息级主导裁定由
 *     `dominantAffectRuleFamily` 做，这里只是去重后的命中清单）。
 */
export function matchAffectPatterns(message: string): AffectPatternMatch[] {
  const sentences = splitAffectSentencesWithTerminators(message)
  const matches: AffectPatternMatch[] = []
  const seenRule = new Set<AffectRuleFamily>()

  for (let index = 0; index < sentences.length; index += 1) {
    const { text: sentence, terminator } = sentences[index]
    // 问句抑制：？/? 终止 = 疑问，任何模式都不触发
    if (terminator.includes('？') || terminator.includes('?')) continue

    const raw: AffectPatternMatch[] = []
    let hostileInSentence = false

    for (const pattern of AFFECT_PATTERNS) {
      if (!sentence.includes(pattern.text)) continue
      if (pattern.guards.some((guard) => sentence.includes(guard))) continue
      raw.push({
        patternId: pattern.id,
        ruleId: pattern.ruleId,
        sentenceIndex: index,
        sentence: sentence.slice(0, 80),
      })
      if (pattern.ruleId === 'A-HOSTILE' || pattern.ruleId === 'A-REJECTION') hostileInSentence = true
    }

    // 敌意/拒绝毒化：负面族在场 ⇒ 本句的正面族不算
    const effective = hostileInSentence
      ? raw.filter((m) => m.ruleId === 'A-HOSTILE' || m.ruleId === 'A-REJECTION')
      : raw

    for (const match of effective) {
      if (seenRule.has(match.ruleId)) continue
      seenRule.add(match.ruleId)
      matches.push(match)
    }
  }

  return matches
}

/** 消息命中了哪些规则族（评估器聚合用） */
export function matchedAffectRuleFamilies(message: string): ReadonlySet<AffectRuleFamily> {
  return new Set(matchAffectPatterns(message).map((m) => m.ruleId))
}

/**
 * 消息级主导裁定（M8-D08/D09）：命中多族时按冻结全序取**最高一条**。
 *
 * 返回 undefined ⇒ 无主导规则 ⇒ 只 touch 不 impact（A-NEUTRAL-TOUCH 语义）。
 * 全序是全的，因此不存在"无法裁定"；A-UNCERTAIN 是为未来语义评估器
 * 预留的具名回退，v1 恒不产生 impact。
 */
export function dominantAffectRuleFamily(message: string): AffectPatternMatch | undefined {
  const matches = matchAffectPatterns(message)
  if (matches.length === 0) return undefined
  const byPriority = [...matches].sort(
    (a, b) => AFFECT_RULE_PRIORITY.indexOf(a.ruleId) - AFFECT_RULE_PRIORITY.indexOf(b.ruleId),
  )
  return byPriority[0]
}
