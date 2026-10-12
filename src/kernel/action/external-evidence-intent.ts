/**
 * 外部证据的**意图检测**（M5.5 / ADR-045 `D-5`·`D-6`）。
 *
 * ============================================================================
 *  四条纪律（每一条都对应一次真实教训或一条裁定）
 * ============================================================================
 * 1. **只有明确词形才触发**（`D-5`）：不猜、不做同义词扩展、不做"语义上像是想搜"。
 *    误触发的代价是**真实出站请求**（把用户的查询送给上游搜索引擎），
 *    而漏触发只是"她没去查"—— 后者用户再说一次即可。
 * 2. **模型不决定执行**（`D-6`）：与 M4.5 的 `intent-detector.ts` 同一套做法：
 *    规则、确定性、可打印命中原因。
 * 3. **不改 M4.5 的检测器**：这里是 M5.5 自己的检测器，装配层用
 *    `chainIntentDetectors()` 把两个串起来 —— 于是 M4.5 的 §8 断言（"你好 → 没有意图"等）
 *    逐条不受影响。
 * 4. **本地动作优先**：链的顺序是 `[M4.5 检测器, 本检测器]`。理由是**代价不对称**：
 *    文件读写是本机、可回滚的；联网搜索是出站、不可撤回的。
 *    因此"读一下 a.txt 顺便搜一下"这类混合指令只会做**本地**那一件（已知边界，见下）。
 *
 * ⚠️ 已知边界（如实登记，不掩饰）：
 *    · `搜索` / `查一下` 这类词**天然含混**（"查一下这个文件"）。本实现只保证
 *      "没有明确词形就不触发"，**不保证**"有明确词形就是用户想上网"。
 *    · 查询词是**用户原话里去掉触发词之后的那一段**，不做改写、不做翻译、
 *      不补全 —— 改写过的查询会变成"系统替用户问了别的问题"。
 *    · `limit` / `locale` 用常量（见 `external-evidence-capability.ts` 的说明）。
 */

import type { ActionIntent, ActionIntentDetector } from './intent-detector.ts'
import {
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SEARCH_LOCALE,
  WEB_SEARCH,
  WEB_SEARCH_OPERATION,
} from './external-evidence-capability.ts'
import { EVIDENCE_LIMITS } from '../contracts/external-evidence.ts'

interface SearchPhraseRule {
  rule: string
  pattern: RegExp
}

/**
 * 明确词形（`D-5` 点名的那些）。
 *
 * ⚠️ **长的在前**：`联网查一下` 必须比 `联网查` 先匹配，否则会剩下一个 `一下`
 *    粘在查询词前面（量具把这叫"查询词抽取"并逐条断言）。
 */
const SEARCH_PHRASE_RULES: readonly SearchPhraseRule[] = [
  {
    rule: 'web_search_zh_explicit',
    pattern: /(上网搜索一下|联网搜索一下|上网搜索|联网搜索|网上搜索|上网查一下|联网查一下|上网搜一下|联网搜一下|上网查一查|联网查一查|上网查|联网查|上网搜|联网搜|网上查|网上搜|帮我查一下|帮我搜一下|帮我查查|帮我搜搜)/,
  },
  {
    rule: 'web_search_zh_verb',
    pattern: /(搜索一下|搜索|搜一下|搜一搜|搜搜|查一下|查一查|查查)/,
  },
  {
    rule: 'web_search_en',
    pattern: /\b(please\s+)?(web\s*search|search\s+the\s+web|search\s+online|google\s+it|look\s+it\s+up)\b/i,
  },
]

/**
 * 查询词两端的**语气噪声**（去掉命中短语之后残留的客气话与虚词）。
 *
 * ⚠️ 这**不是**内容停用词表（M5 明文禁止手工词表）：它只收"语气"，
 *    而且刻意短 —— 多收一个词，就多一分"系统替用户改写了问题"的风险。
 *    任何实词都不在这里。
 */
const LEADING_NOISE =
  /^[\s，,。.、；;：:！!？?~～"'“”‘’（）()【】\[\]的个了把在将帮给我请一下一查一遍]+/i
const LEADING_POLITE = /^(please|can you|could you|for me|thanks|thank you)[\s,]+/i
const TRAILING_NOISE =
  /[\s，,。.、；;：:！!？?~～]*(谢谢|多谢|感谢|thanks|thank you|please)[\s，,。.、；;：:！!？?~～]*$/i

/**
 * 从原话里抽出**查询词**。
 *
 * 只做三件事：去掉命中的触发短语、去掉两端的语气噪声、去掉末尾的客气话。
 * **不**改写、**不**翻译、**不**补全（见文件头"已知边界"）。
 * 空串是**合法返回值**：它表示"用户说了要搜，但没说要搜什么"——
 * 那种情况必须变成一次**可审计的失败**（适配器会以 `validation_failed` 拒绝），
 * 而不是"什么都没发生"。
 */
export function extractSearchQuery(text: string, matchedPhrase: string): string {
  let rest = text.replace(matchedPhrase, ' ')
  // 客气话最多剥两层（"please web search ... thanks"）
  for (let pass = 0; pass < 2; pass += 1) {
    rest = rest.replace(LEADING_NOISE, '').replace(LEADING_POLITE, '')
  }
  rest = rest.replace(TRAILING_NOISE, '')
  return rest
    .replace(LEADING_NOISE, '')
    .replace(/[\s，,。.、；;：:！!？?~～]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, EVIDENCE_LIMITS.maxQueryLength)
}

/**
 * **否定否决**（M5.5.1 WP2b · 修 `L-M55-16`）：命中短语紧邻左侧出现禁止词 ⇒ **不触发**。
 *
 * ⚠️ 为什么必须有它：`不要联网搜索，只根据你已有的知识回答` 在 M5.5 会**真的出网**
 *    （`L-M55-16`，P0），而且把"不要…只根据你已有的知识回答"整句当查询词送出去。
 *    用户**显式表达的禁止**不是"意图不明确"，它是**明确的否定指令**。
 *
 * 判据刻意**窄**（宁可漏报否定，也不要把"不要"当成万能否决）：
 *   · 只看命中短语**左侧**的一小段窗口（默认 6 字）里的**结尾**；
 *   · 只收明确的禁止词，不收"可能/也许/看情况"这类模糊表达（那些交给 WP3 的判定模型）；
 *   · 双否定（`不要不查`）**不在**本判据范围：那种句子今天也不会命中任何词形。
 */
const NEGATION_WINDOW = 6
/** 多字禁止词：出现在**同一分句内任意位置**即算否决 */
const NEGATION_TOKEN = /(不要|不用|不必|无需|不需要|不想|先别|禁止|不许|不能)/
/**
 * 单字 `别` **只在分句开头**才算禁止词。
 *
 * ⚠️ 真实踩过：把裸 `别` 放进任意位置匹配，`特别搜索一下` / `分别搜索一下` /
 *    用别的搜索一下 都会被判成"禁止" —— 那是**误否决**（用户明明是在要求搜索）。
 *    分句开头判据同时保住了 `别搜索` / `别搜了`。
 */
const NEGATION_CLAUSE_INITIAL = /^别/
/**
 * 英文词形的禁止词（`web_search_en` 是 `/i` 匹配，所以这里也 `/i`）。
 *
 * ⚠️ 必须带词边界：裸 `no` 会命中 `know` / `now` / `nothing`，把
 *    `search the web, now tell me…` 这类**真正的搜索请求**误否决。
 */
const NEGATION_TOKEN_EN = /\b(not|never|without|no)\b/i
/** 分句边界：**只算标点**。空白是词间隔不是分句 —— 把空白也算成边界会让
 *  `do not search the web` 的窗口切出一个空串，否决失效（实测踩过）。 */
const CLAUSE_BOUNDARY = /[，,。.、；;：:！!？?]/

export function isNegatedExplicitRequest(text: string, phrase: string): boolean {
  const at = text.indexOf(phrase)
  if (at <= 0) return false
  const before = text.slice(Math.max(0, at - NEGATION_WINDOW), at)
  /*
   * ⚠️ 判据是"**同一分句内**出现禁止词"，不是"紧邻结尾"。
   *
   * 真实踩过：`不要联网搜索，只根据你已有的知识回答` —— 显式规则（`联网搜索`）被正确否决后，
   * **verb 规则又在同一句里匹配了 `搜索`**；那时命中短语左侧是 `不要联网`（以「联网」结尾），
   * "紧邻结尾"的判据放它过去了 ⇒ **仍然出网**。按分句判就同时覆盖两种匹配位置。
   *
   * 代价（如实）：`别用这个，搜索一下` 这类**跨分句**的句子不再被否决 —— 那是对的（它确实是在要求搜索）；
   * 而 `不能联网查吗` 这类**看起来像请求的否定疑问句**会被当成禁止（漏报，宁可漏报不出网）。
   *
   * ⚠️ **残留缺口（如实登记，未修）**：`不要，联网搜索` —— 禁止词与命中短语之间隔着一个分句标点、
   *    且标点后没有别的词，于是被判成"新分句"而放行。它与 `别用这个，搜索一下` 在词形上同构，
   *    而两者语义相反；本判据选了常见读法。**语义级的否定一律归 WP3**，本函数只处理显式禁止词形。
   */
  const lastClause = before.split(CLAUSE_BOUNDARY).at(-1) ?? ''
  // 短语紧跟在分句标点之后 ⇒ **这是一个新分句**，前面那个分句里的禁止词管不到它
  // （`别用这个，搜索一下 公开资料` 确实是在**要求**搜索）。
  if (lastClause.trim() === '') return false
  return (
    NEGATION_TOKEN.test(lastClause) ||
    NEGATION_CLAUSE_INITIAL.test(lastClause) ||
    NEGATION_TOKEN_EN.test(lastClause)
  )
}

export function createExternalEvidenceIntentDetector(): ActionIntentDetector {
  return {
    detect(text: string): ActionIntent | undefined {
      const trimmed = text.trim()
      if (trimmed === '') return undefined

      for (const { rule, pattern } of SEARCH_PHRASE_RULES) {
        const matched = pattern.exec(trimmed)
        const phrase = matched?.[0]
        if (phrase === undefined) continue
        // 显式禁止 ⇒ **不触发**（`L-M55-16`：说了不要联网仍然出网是 P0）
        if (isNegatedExplicitRequest(trimmed, phrase)) continue
        const query = extractSearchQuery(trimmed, phrase)
        return {
          capability: WEB_SEARCH,
          operation: WEB_SEARCH_OPERATION,
          /*
           * ⚠️ 空 query 也照样产生**请求**：让账本记下"有人要求搜索"，
           *    再让适配器以 `validation_failed` 如实拒绝。
           *    在这里"装作没有意图"会让模型自由地编一句"我查过了"。
           */
          args: {
            query,
            limit: DEFAULT_SEARCH_LIMIT,
            locale: DEFAULT_SEARCH_LOCALE,
          },
          hints: [],
          rule,
          phrase: trimmed.slice(0, 60),
        }
      }
      return undefined
    },
  }
}

/**
 * 把多个检测器按顺序串起来（**第一个命中者胜**）。
 *
 * 刻意放在这里而不是改 M4.5 的检测器：换顺序只动装配层一行，
 * 而 M4.5 的行为与它的断言一个字节都不会变。
 */
export function chainIntentDetectors(
  detectors: readonly ActionIntentDetector[]
): ActionIntentDetector {
  return {
    detect(text: string): ActionIntent | undefined {
      for (const detector of detectors) {
        const intent = detector.detect(text)
        if (intent !== undefined) return intent
      }
      return undefined
    },
  }
}
