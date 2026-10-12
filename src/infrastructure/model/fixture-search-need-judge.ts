/**
 * **fixture 判定器**（M5.5.1 WP3/WP4/WP6）—— 离线、确定、可注入故障。
 *
 * ============================================================================
 *  它是什么 / 它不是什么
 * ============================================================================
 * 它是 `SearchNeedJudgePort` 的一个**确定性实现**：给一段文本，返回一段**逐字的
 * "模型原始输出"**。因此它测的是**适配器与解析链**（JSON 提取 → 形状校验 → 策略），
 * **不是**判定器的语义准确率 —— 后者只能由真实模型在 WP7 的语料上测。
 *
 * ⚠️ 这一点必须写在文件头上，否则很容易被读成"系统已经能识别私人查询了"。
 *    本 fixture 能证明的是：**当判定说 answer/clarify/deny_search 时，出站调用为 0**；
 *    它不能证明"判定每次都说得对"。
 *
 * ---------------------------------------------------------------------------
 *  为什么返回"原始输出"而不是直接返回提案
 * ---------------------------------------------------------------------------
 * 如果 fixture 直接给出 `SearchNeedProposal`，它就把**解析链**整段跳过了 ——
 * 而"模型塞了 `authorized: true` 会不会被放过""围栏代码块能不能认"正是这里最容易坏的地方。
 * 因此 fixture 返回字符串，测试跑**与生产同一条** `parseSearchNeedJudgeOutput`。
 */

import type {
  SearchNeedJudgeFailure,
  SearchNeedJudgeOutcome,
  SearchNeedJudgePort,
} from '../../kernel/action/search-need-judge.ts'
import { parseSearchNeedJudgeOutput } from '../../kernel/action/search-need-judge.ts'

/** 一行"判定输出"（原始字符串，逐字走解析链） */
function raw(decision: string, reason: string, span?: { start: number; end: number }): string {
  return JSON.stringify(span === undefined ? { decision, reason } : { decision, reason, querySpan: span })
}

/**
 * 冻结的默认语料（计划 §7.2 的**形式**；条数与阈值在 WP6 落盘）。
 *
 * ⚠️ 键是**完整用户发言**，值是**固定的判定输出** —— 两者都是数据，不是断言。
 *    断言在门里：例如 `我查一下我的笔记` 这一行的用意是"判定说私人对象 ⇒ 出站 0"。
 */
export const DEFAULT_FIXTURE_JUDGE_OUTPUTS: Readonly<Record<string, string>> = {
  // 合法公开请求（正控）
  现在黄金价格是多少: raw('search', 'time_sensitive_fact', { start: 2, end: 6 }),
  帮我联网搜索台风最新路径: raw('search', 'explicit_public_sourcing', { start: 6, end: 12 }),
  今天有什么重要新闻: raw('search', 'latest_news', { start: 0, end: 8 }),
  // 私人对象 / 自述 / 引用 / 禁止 / 范围不明（负控：一律不出站）
  我查一下我的笔记: raw('answer', 'private_object'),
  我要查一下银行余额: raw('answer', 'private_object'),
  我昨天跟你说过我住在哪: raw('answer', 'self_reported'),
  '「据说黄金会涨」这句话是什么意思': raw('answer', 'quoted_or_metalinguistic'),
  不要联网搜索: raw('deny_search', 'negated_or_forbidden'),
  查一下那个: raw('clarify', 'missing_subject'),
  今天天气不错: raw('answer', 'chitchat_or_creative'),
}

export interface FixtureSearchNeedJudgeOptions {
  /** 文本 → 原始输出；缺省用 `DEFAULT_FIXTURE_JUDGE_OUTPUTS` */
  outputs?: Readonly<Record<string, string>>
  /** 文本 → 直接注入的失败（优先于 `outputs`） */
  failures?: Readonly<Record<string, SearchNeedJudgeFailure>>
  /** 命中不了任何一条时的原始输出（缺省 `answer/stable_knowledge`） */
  fallback?: string
  id?: string
}

export interface FixtureSearchNeedJudge extends SearchNeedJudgePort {
  /** 判定调用次数（**量具用**：证明"判定失败 ⇒ 搜索调用 0"时判定确实被问过） */
  calls(): number
  /** 被问过的文本（逐字；顺序即调用顺序） */
  texts(): readonly string[]
}

export function createFixtureSearchNeedJudge(
  options: FixtureSearchNeedJudgeOptions = {}
): FixtureSearchNeedJudge {
  /*
   * ⚠️ `outputs` 必须与默认语料**合并**，不是整体替换。
   *    真实踩过：第一版写成 `options.outputs ?? DEFAULT`，于是"只想覆盖一行坏 JSON"的调用
   *    把整份默认语料丢掉了 ⇒ 所有文本都落到 fallback（`answer`）⇒ 两条**正控**变成 0 调用。
   *    门当时就把它抓住了（放行 0 行 / 共 17 行）—— 这类缺陷只会表现成"看起来更安全"，
   *    永远不会自己冒出来。
   */
  const outputs = { ...DEFAULT_FIXTURE_JUDGE_OUTPUTS, ...(options.outputs ?? {}) }
  const failures = options.failures ?? {}
  const fallback = options.fallback ?? raw('answer', 'stable_knowledge')
  let calls = 0
  const texts: string[] = []

  return {
    id: options.id ?? 'fixture-judge',
    endpointHost: 'fixture.invalid',
    calls: () => calls,
    texts: () => texts,

    async judge(input): Promise<SearchNeedJudgeOutcome> {
      calls += 1
      texts.push(input.text)
      const injected = failures[input.text]
      if (injected !== undefined) return { ok: false, failure: injected, requestCount: 1 }
      const rawOutput = outputs[input.text] ?? fallback
      try {
        return { ok: true, proposal: parseSearchNeedJudgeOutput(rawOutput), requestCount: 1 }
      } catch {
        return { ok: false, failure: 'invalid_output', requestCount: 1 }
      }
    },
  }
}
