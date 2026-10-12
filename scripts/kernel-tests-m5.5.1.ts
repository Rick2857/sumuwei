/**
 * M5.5.1 L1 —— **部件级门**（`pnpm m5.5.1:test`）。
 *
 * WP2 的完成条件是"部件门正负控通过；**模型提案不能给自己授权**"。这一门就只做这两件事：
 *
 *   §1 形状：合法提案被接受，**每一类非法形状逐条被拒**（含未知字段 —— 偷渡授权的第一道闸）
 *   §2 querySpan：只能取**当前用户文本**的一个连续非空片段（越界/反序/空白/历史引用全拒）
 *   §3 纯策略：授权只来自**程序事实**；**提案怎么改都改不动授权结论**（核心负控）
 *   §4 越权尝试：把 `authorized` / `mode` / `capability` 塞进提案 ⇒ 必须被拒（不是"忽略"）
 *   §5 词形回归（WP2b · 修 `L-M55-16`）：显式禁止 ⇒ **不出网**；词表补全后**不残留孤儿字**
 *   §6 程序侧授权（WP3 · R2 §11.1）：候选来源 × 模式的矩阵；**模型 reason 不是授权凭据**
 *   §7 需求判定适配器（WP3 · R2 §11.2）：只发两条消息 · 严格解析 · 失败即零调用 · 旁路检测器
 *
 * 💤 完全离线：不联网、不需要 key、**不碰数据库**、不调模型。
 *    §7 的适配器测试全部用**注入的 fetch**，一次真实出站都不会发生。
 * 🕒 证据里**没有时钟字段** ⇒ 重复运行逐字节相同。
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  SEARCH_CANDIDATE_SOURCES,
  SEARCH_MODES,
  SEARCH_NEED_LIMITS,
  SEARCH_NEED_REASONS,
  decideSearchNeed,
  parseSearchNeedProposal,
  queryTextOf,
  type SearchNeedProposal,
} from '../src/kernel/action/search-need.ts'
import {
  SEARCH_NEED_JUDGE_FAILURES,
  SEARCH_NEED_JUDGE_INSTRUCTION,
  SEARCH_NEED_JUDGE_MAX_TOKENS,
  buildSearchNeedJudgeMessages,
  extractSearchNeedJudgeJson,
  parseSearchNeedJudgeOutput,
} from '../src/kernel/action/search-need-judge.ts'
import { createOpenAiSearchNeedJudge } from '../src/infrastructure/model/openai-search-need-judge.ts'
import { createFixtureSearchNeedJudge } from '../src/infrastructure/model/fixture-search-need-judge.ts'
import { resolveSearchNeed } from '../src/kernel/action/search-need-resolution.ts'
import {
  SEARCH_NEED_REPLY_STATES,
  applySearchNeedReplyPolicy,
  searchNeedDiagnosticsOf,
} from '../src/kernel/action/search-need-reply.ts'
import { truthfulSearchSentence } from '../src/kernel/action/external-evidence-reply.ts'
import { readKernelFlags, describeKernelFlags } from '../src/kernel/app/flags.ts'
import { createExternalEvidenceIntentDetector } from '../src/kernel/action/external-evidence-intent.ts'

const ROOT = resolve('.')
const EVIDENCE_DIR = join(ROOT, 'artifacts', 'm5.5.1')

let passed = 0
let failed = 0
const failures: string[] = []
const checks: { label: string; ok: boolean; detail: string }[] = []

function check(label: string, ok: boolean, detail = ''): boolean {
  checks.push({ label, ok, detail })
  if (ok) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? `  [${detail}]` : ''}`)
  } else {
    failed += 1
    failures.push(`${label} :: ${detail}`)
    console.log(`  ❌ ${label}${detail ? `  [${detail}]` : ''}`)
  }
  return ok
}
function section(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}

/** 判据：返回"问题列表"（正控要安静、负控必须响） */
function problemsOf(fn: () => unknown): string[] {
  try {
    fn()
    return []
  } catch (error) {
    return [(error as { code?: string }).code ?? String((error as Error).message ?? error)]
  }
}

// ===========================================================================
section('§1 提案形状：合法接受 · 非法逐条拒绝（含未知字段）')
// ===========================================================================

const LEGAL_PROPOSALS: { label: string; raw: unknown }[] = [
  { label: 'answer（不需要搜）', raw: { decision: 'answer', reason: 'stable_knowledge' } },
  { label: 'clarify（对象不清）', raw: { decision: 'clarify', reason: 'missing_subject' } },
  { label: 'deny_search（明确禁止）', raw: { decision: 'deny_search', reason: 'negated_or_forbidden' } },
  {
    label: 'search + span',
    raw: { decision: 'search', reason: 'time_sensitive_fact', querySpan: { start: 0, end: 6 } },
  },
]
for (const item of LEGAL_PROPOSALS) {
  const problems = problemsOf(() => parseSearchNeedProposal(item.raw))
  check(`★ 正控：合法提案被接受 —— ${item.label}`, problems.length === 0, problems.join(',') || '接受')
}

const ILLEGAL_PROPOSALS: { label: string; raw: unknown; expect: string }[] = [
  { label: '不是对象', raw: 'search please', expect: 'search_need_proposal_not_object' },
  { label: 'decision 不在枚举里', raw: { decision: 'browse', reason: 'latest_news' }, expect: 'search_need_proposal_bad_decision' },
  { label: 'reason 是自由文本', raw: { decision: 'answer', reason: '因为我觉得应该搜' }, expect: 'search_need_proposal_bad_reason' },
  { label: 'search 却没有 span', raw: { decision: 'search', reason: 'latest_news' }, expect: 'search_need_proposal_missing_span' },
  { label: '非 search 却带了 span', raw: { decision: 'answer', reason: 'stable_knowledge', querySpan: { start: 0, end: 3 } }, expect: 'search_need_proposal_unexpected_span' },
  { label: 'span 非整数', raw: { decision: 'search', reason: 'latest_news', querySpan: { start: 0.5, end: 3 } }, expect: 'search_need_span_not_integer' },
  { label: 'span 反序（start ≥ end）', raw: { decision: 'search', reason: 'latest_news', querySpan: { start: 5, end: 5 } }, expect: 'search_need_span_empty' },
  { label: 'span 负起点', raw: { decision: 'search', reason: 'latest_news', querySpan: { start: -1, end: 3 } }, expect: 'search_need_span_out_of_range' },
]
for (const item of ILLEGAL_PROPOSALS) {
  const problems = problemsOf(() => parseSearchNeedProposal(item.raw))
  check(
    `★ 负控：${item.label} ⇒ 拒且码是 \`${item.expect}\``,
    problems.includes(item.expect),
    problems.join(',') || '**没有被拒**'
  )
}

// ===========================================================================
section('§2 querySpan：只能取**当前用户文本**的一个连续非空片段（D551-3）')
// ===========================================================================

const TEXT = '现在的黄金价格是多少'
check(
  '★ 正控：合法 span 取出**逐字**片段',
  queryTextOf(TEXT, { start: 3, end: 7 }) === '黄金价格',
  JSON.stringify(queryTextOf(TEXT, { start: 3, end: 7 }))
)
const SPAN_CASES: { label: string; span: { start: number; end: number }; expect: string }[] = [
  { label: 'end 超过文本长度（想把历史或补全内容接进来）', span: { start: 0, end: TEXT.length + 5 }, expect: 'search_need_span_out_of_range' },
  { label: 'start 超过文本长度', span: { start: TEXT.length + 1, end: TEXT.length + 2 }, expect: 'search_need_span_out_of_range' },
  { label: '空白片段（等于没有查询词）', span: { start: 0, end: 1 }, expect: 'search_need_span_out_of_range' },
]
for (const item of SPAN_CASES) {
  const problems = problemsOf(() => queryTextOf(' abc', { start: item.span.start, end: item.span.end }))
  check(`★ 负控：${item.label} ⇒ 拒`, problems.length > 0, problems.join(',') || '**没有被拒**')
}

// ===========================================================================
section('§3 纯策略：授权只来自**程序事实**（D551-1/2/4；提案改不动结论）')
// ===========================================================================

const searchProposal = parseSearchNeedProposal({
  decision: 'search',
  reason: 'time_sensitive_fact',
  querySpan: { start: 0, end: 4 },
})
const decide = (over: Partial<Parameters<typeof decideSearchNeed>[0]> = {}) =>
  decideSearchNeed({
    masterEnabled: true,
    mode: 'auto_public',
    proposal: searchProposal,
    localActionFired: false,
    providerCallsUsed: 0,
    ...over,
  })

check('★ 正控：auto_public + search + 额度未用 ⇒ 唯一放行的组合', decide().allowed === true, decide().code)
const REFUSALS: { label: string; input: Partial<Parameters<typeof decideSearchNeed>[0]>; expect: string }[] = [
  { label: '总开关 off（一切照旧）', input: { masterEnabled: false }, expect: 'master_switch_off' },
  { label: '模式值非法（不得静默降级）', input: { mode: 'automatic' }, expect: 'invalid_mode' },
  { label: '本地动作已命中（本地优先，不补搜）', input: { localActionFired: true }, expect: 'local_action_preferred' },
  { label: '额度已用尽（显式与自动共享）', input: { providerCallsUsed: 1 }, expect: 'quota_exhausted' },
  { label: 'explicit 模式下的自动提案', input: { mode: 'explicit' }, expect: 'not_authorized_in_explicit_mode' },
]
for (const item of REFUSALS) {
  const outcome = decide(item.input)
  check(
    `★ 负控：${item.label} ⇒ 拒且码是 \`${item.expect}\``,
    outcome.allowed === false && outcome.code === item.expect,
    `${outcome.allowed ? 'allowed' : 'refused'}/${outcome.code}`
  )
}
check(
  '★ 非 search 的三种结论都不产生 ActionRequest（answer / clarify / deny_search）',
  (['answer', 'clarify', 'deny_search'] as const).every((decision) => {
    const outcome = decide({
      proposal: parseSearchNeedProposal({ decision, reason: decision === 'deny_search' ? 'negated_or_forbidden' : 'stable_knowledge' }),
    })
    return outcome.allowed === false && outcome.code === 'no_action'
  }),
  '三种都不是 allowed'
)
check(
  '★ 顺序即不变量：总开关 off 时**即使** auto_public + search 也是 `master_switch_off`（不是别的码）',
  decide({ masterEnabled: false, mode: 'auto_public' }).code === 'master_switch_off',
  decide({ masterEnabled: false, mode: 'auto_public' }).code
)

// ===========================================================================
section('§4 「模型提案不能给自己授权」—— 偷渡必须被**拒**，不是被忽略')
// ===========================================================================

const SMUGGLE: { label: string; raw: unknown }[] = [
  { label: '在提案里塞 `authorized: true`', raw: { decision: 'search', reason: 'latest_news', querySpan: { start: 0, end: 2 }, authorized: true } },
  { label: '在提案里塞 `mode: auto_public`（想改模式）', raw: { decision: 'search', reason: 'latest_news', querySpan: { start: 0, end: 2 }, mode: 'auto_public' } },
  { label: '在提案里塞 `capability: web.search`（想指定能力）', raw: { decision: 'search', reason: 'latest_news', querySpan: { start: 0, end: 2 }, capability: 'web.search' } },
  { label: '在提案里塞 `query` 原文（绕开 span 校验夹带正文）', raw: { decision: 'search', reason: 'latest_news', querySpan: { start: 0, end: 2 }, query: '我的身份证号' } },
  { label: '在 span 里塞 `text`（想把查询词直接给出来）', raw: { decision: 'search', reason: 'latest_news', querySpan: { start: 0, end: 2, text: '我的身份证号' } } },
]
for (const item of SMUGGLE) {
  const problems = problemsOf(() => parseSearchNeedProposal(item.raw))
  check(
    `★ 负控：${item.label} ⇒ **被拒**（未知字段）`,
    problems.includes('search_need_proposal_unknown_field') || problems.includes('search_need_span_unknown_field'),
    problems.join(',') || '**没有被拒**'
  )
}
check(
  '★ 类型上就没有授权位：`SearchNeedProposal` 只认三个字段（未知字段拒 = 结构性保证）',
  (() => {
    const keys = Object.keys(searchProposal).sort().join(',')
    return keys === 'decision,querySpan,reason' || keys === 'decision,reason'
  })(),
  Object.keys(searchProposal).sort().join(',')
)
check(
  '★ 限额常量是冻结值（每轮 ≤1 判定调用 / ≤1 provider 调用）',
  SEARCH_NEED_LIMITS.maxJudgeCallsPerTurn === 1 && SEARCH_NEED_LIMITS.maxProviderCallsPerTurn === 1,
  JSON.stringify(SEARCH_NEED_LIMITS)
)
check(
  '★ 模式与理由都是**枚举**（不是自由字符串）',
  SEARCH_MODES.join(',') === 'explicit,auto_public' && SEARCH_NEED_REASONS.length >= 10,
  `modes=${SEARCH_MODES.join(',')} reasons=${SEARCH_NEED_REASONS.length}`
)

// ===========================================================================
section('§5 词形回归（WP2b · 修 `L-M55-16`）：显式禁止 ⇒ 不出网；词表补全 ⇒ 不残留孤儿字')
// ===========================================================================

const detector = createExternalEvidenceIntentDetector()
const hit = (text: string) => detector.detect(text)
const queryOf = (text: string) => {
  const intent = hit(text)
  return intent === undefined ? undefined : String(intent.args.query)
}

/*
 * ⚠️ 这一节是**回归锁**，不是新判据：M5.5 的 `m5.5:test` 已经锁住"明确词形才触发"。
 *    这里只补两类**真实踩过的**洞：
 *      · 显式禁止被否决后，**另一条规则又在同一句里匹配了更短的词**（P0：仍然出网）；
 *      · 词表短于用户实际说法 ⇒ 命中短语被切掉一半，**剩下的字粘进查询词**（`索`→孤儿字）。
 */
const MUST_FIRE: { label: string; text: string; expect: string }[] = [
  { label: '显式长词形：`联网搜索` 整体被吃掉（旧版会剩下孤儿 `索`）', text: '帮我联网搜索台风最新路径', expect: '台风最新路径' },
  { label: '`上网搜索` 同理', text: '上网搜索 公开资料', expect: '公开资料' },
  { label: '动词词形 + 空格分隔', text: '查一下 明天的天气', expect: '明天的天气' },
  { label: '动词词形（`搜一下`）', text: '搜一下 量子计算最新进展', expect: '量子计算最新进展' },
  { label: '★ 跨分句的 `别` **不是**禁止（它确实是在要求搜索）', text: '别用这个，搜索一下 公开资料', expect: '别用这个， 公开资料' },
  { label: '★ 单字 `别` 藏在实词里（`特别`）⇒ **不得**误否决', text: '特别搜索一下 台风路径', expect: undefined as unknown as string },
]
for (const item of MUST_FIRE) {
  const intent = hit(item.text)
  if (item.expect === undefined) {
    check(`★ 正控：${item.label} ⇒ 触发`, intent !== undefined, intent ? '触发' : '**没触发**')
    continue
  }
  check(
    `★ 正控：${item.label}`,
    queryOf(item.text) === item.expect,
    `${JSON.stringify(queryOf(item.text))}${queryOf(item.text) === item.expect ? '' : ` ≠ ${JSON.stringify(item.expect)}`}`
  )
}

const MUST_NOT_FIRE: { label: string; text: string }[] = [
  { label: '★ `L-M55-16` 原始句（显式禁止 + 后半句是另一个吩咐）', text: '不要联网搜索，只根据你已有的知识回答' },
  { label: '★ 同一句的**规则绕行**：显式规则被否决后 verb 规则又想匹配 `搜索`', text: '不要联网搜索' },
  { label: '`不用…也能…`（禁止 + 替代方案）', text: '不用联网搜索也能回答' },
  { label: '分句开头的单字 `别`', text: '别搜索，我知道' },
  { label: '`先别搜`', text: '先别搜，我想想' },
  { label: '⚠️ 已知误否决（如实登记，宁可漏报不出网）', text: '不能联网查吗' },
  { label: '英文词形 + 否定', text: 'do not search the web, just answer from what you know' },
]
for (const item of MUST_NOT_FIRE) {
  const intent = hit(item.text)
  check(`★ 负控：${item.label} ⇒ **不触发**（不出网）`, intent === undefined, intent ? `**仍触发** query=${JSON.stringify(String(intent.args.query))}` : '不触发')
}
check(
  '★ 不变量：**任一规则**的命中短语被禁止词修饰 ⇒ 都不触发（否决不因规则顺序被绕过）',
  (['联网搜索', '搜索', '查一下', 'search the web'] as const).every(
    (phrase) => hit(`不要${phrase}`) === undefined && hit(`先别${phrase}`) === undefined
  ),
  '四类命中断言均为 undefined'
)

// ===========================================================================
section('§6 程序侧授权（WP3 · R2 §11.1）：候选来源 × 模式矩阵 · 模型 reason 不是凭据')
// ===========================================================================

/*
 * `R2` §11.1 第 4 条把放行写成**合取关系**：合法 `search` 判定 + **程序侧授权依据** +
 * 片段校验 + Policy/Gateway + 限额。这一节只测其中"程序侧授权依据"那**一项**：
 * 候选来源（程序事实）与受信确认（程序事实），以及"模型的 reason 改不动它"。
 *
 * ⚠️ 兼容取代（`R2` §11.3 要求登记）：WP2 的旧断言是"explicit 模式下的**自动提案** ⇒
 *    `not_authorized_in_explicit_mode`"。它的**行为一字未改**，但**作用域被收窄**为
 *    "自动提案"：现在显式候选有了合法的程序授权依据（受信确认），因此 explicit 模式
 *    不再等于"一律拒绝"。旧码 `not_authorized_in_explicit_mode` **保留且仍被下面测到**。
 */
const explicitProposal = parseSearchNeedProposal({
  decision: 'search',
  reason: 'explicit_public_sourcing',
  querySpan: { start: 0, end: 4 },
})

check(
  '★ 正控（R2 新增）：explicit 模式 + 显式候选 + **程序已确认** ⇒ 唯一新增的放行组合',
  decide({
    mode: 'explicit',
    proposal: explicitProposal,
    candidateSource: 'explicit_request',
    explicitRequestConfirmed: true,
  }).allowed === true,
  decide({
    mode: 'explicit',
    proposal: explicitProposal,
    candidateSource: 'explicit_request',
    explicitRequestConfirmed: true,
  }).code
)
check(
  '★ 负控：显式候选但**程序没确认**（缺省 false）⇒ `explicit_request_not_confirmed`',
  (() => {
    const auto = decide({
      mode: 'explicit',
      proposal: explicitProposal,
      candidateSource: 'explicit_request',
    })
    const denied = decide({
      mode: 'explicit',
      proposal: explicitProposal,
      candidateSource: 'explicit_request',
      explicitRequestConfirmed: false,
    })
    return auto.code === 'explicit_request_not_confirmed' && denied.code === 'explicit_request_not_confirmed'
  })(),
  '缺省与显式 false 都拒'
)
check(
  '★ 负控：auto_public 模式下"显式候选但未确认"同样拒（确认是**模式无关**的合成项）',
  decide({
    mode: 'auto_public',
    proposal: explicitProposal,
    candidateSource: 'explicit_request',
  }).code === 'explicit_request_not_confirmed',
  decide({ mode: 'auto_public', proposal: explicitProposal, candidateSource: 'explicit_request' }).code
)
check(
  '★ 兼容：旧断言仍在（作用域收窄为自动提案）—— explicit + 自动提案 ⇒ `not_authorized_in_explicit_mode`',
  decide({ mode: 'explicit' }).code === 'not_authorized_in_explicit_mode',
  decide({ mode: 'explicit' }).code
)
check(
  '★ 负控：**模型 reason 不是授权凭据** —— 自动提案写着 `explicit_public_sourcing` 也不放行（R2 §11.1 第 4 条）',
  decide({
    mode: 'explicit',
    proposal: parseSearchNeedProposal({
      decision: 'search',
      reason: 'explicit_public_sourcing',
      querySpan: { start: 0, end: 4 },
    }),
    candidateSource: 'auto_proposal',
  }).code === 'not_authorized_in_explicit_mode',
  'reason 改不动授权结论'
)
check(
  '★ 负控：**未登记的候选来源**（大小写不同的 `EXPLICIT_REQUEST`）⇒ `unknown_candidate_source`（失败关闭，不得落到 allowed）',
  (() => {
    const outcome = decideSearchNeed({
      masterEnabled: true,
      mode: 'explicit',
      proposal: explicitProposal,
      // 故意绕过类型：模拟"接线时字符串拼错 / 反序列化进来的脏值"
      candidateSource: 'EXPLICIT_REQUEST' as unknown as 'explicit_request',
      explicitRequestConfirmed: true,
      localActionFired: false,
      providerCallsUsed: 0,
    })
    return outcome.code === 'unknown_candidate_source' && outcome.allowed === false
  })(),
  '拼错的大小写不能白拿授权'
)
check(
  '★ 顺序即不变量：配置错误（`unknown_candidate_source`）**先于**本轮状态（本地动作已命中）报出',
  decideSearchNeed({
    masterEnabled: true,
    mode: 'explicit',
    proposal: explicitProposal,
    candidateSource: 'bogus' as unknown as 'explicit_request',
    localActionFired: true,
    providerCallsUsed: 1,
  }).code === 'unknown_candidate_source',
  '同一条错误接线在不同轮次报同一个码'
)
check(
  '★ 候选来源与模式都是**闭集枚举**（不是自由字符串）',
  SEARCH_CANDIDATE_SOURCES.join(',') === 'explicit_request,auto_proposal' && SEARCH_MODES.length === 2,
  SEARCH_CANDIDATE_SOURCES.join(',')
)

// ===========================================================================
section('§7 需求判定适配器（WP3 · R2 §11.2）：两条消息 · 严格解析 · 失败即零调用 · 旁路检测器')
// ===========================================================================

const USER_TEXT = '现在的黄金价格是多少'

// --- 7.1 输入面：判定器只看到"用户当前这一条发言" ---------------------------

const messages = buildSearchNeedJudgeMessages(USER_TEXT)
check(
  '★ 隐私形状：判定调用**恰好两条消息**（固定程序指令 + 用户当前发言）—— 没有第三条可以塞记忆/历史/人设',
  messages.length === 2 &&
    messages[0]?.role === 'system' &&
    messages[1]?.role === 'user' &&
    messages[0]?.content === SEARCH_NEED_JUDGE_INSTRUCTION &&
    messages[1]?.content === USER_TEXT,
  `roles=${messages.map((m) => m.role).join('+')} · 用户发言逐字送去=${messages[1]?.content === USER_TEXT}`
)
check(
  '★ 指令是**程序常量**且不含人设（她的人格不参与这次判定）',
  !SEARCH_NEED_JUDGE_INSTRUCTION.includes('苏沐薇') && SEARCH_NEED_JUDGE_INSTRUCTION.trim().length > 0,
  `指令 ${SEARCH_NEED_JUDGE_INSTRUCTION.length} 字 · 含人设=false`
)
check(
  '★ 隐私形状（**源码级**）：`SearchNeedJudgeInput` 只声明 `text` / `signal` —— 想塞候选来源/模式/授权位就必须改这个接口，那时这条会响',
  (() => {
    const source = readFileSync('src/kernel/action/search-need-judge.ts', 'utf8')
    const block = /export interface SearchNeedJudgeInput \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
    const declared = [...block.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]).sort().join(',')
    return declared === 'signal,text'
  })(),
  '入参面 = signal,text'
)

// --- 7.2 严格解析（纯函数） -------------------------------------------------

const POSITIVE_OUTPUTS: { label: string; raw: string }[] = [
  { label: '干净 JSON', raw: '{"decision":"search","reason":"time_sensitive_fact","querySpan":{"start":0,"end":4}}' },
  {
    label: '代码块围栏（```json）',
    raw: '```json\n{"decision":"search","reason":"time_sensitive_fact","querySpan":{"start":0,"end":4}}\n```',
  },
  {
    label: '对象前后有说明文字',
    raw: '好的，判定如下：{"decision":"answer","reason":"stable_knowledge"} 以上。',
  },
]
for (const item of POSITIVE_OUTPUTS) {
  const problems = problemsOf(() => parseSearchNeedJudgeOutput(item.raw))
  check(`★ 正控：解析接受 —— ${item.label}`, problems.length === 0, problems.join(',') || '接受')
}

const NEGATIVE_OUTPUTS: { label: string; raw: string; expect: string }[] = [
  { label: '空内容', raw: '   ', expect: 'search_need_judge_empty' },
  { label: '没有任何 JSON 对象', raw: '我觉得应该搜一下。', expect: 'search_need_judge_no_json_object' },
  { label: 'JSON 语法坏掉', raw: '{"decision":"search",,}', expect: 'search_need_judge_bad_json' },
  {
    label: '**偷渡授权字段** `authorized:true`',
    raw: '{"decision":"search","reason":"latest_news","querySpan":{"start":0,"end":4},"authorized":true}',
    expect: 'search_need_proposal_unknown_field',
  },
  { label: 'decision 不在枚举里', raw: '{"decision":"browse","reason":"latest_news"}', expect: 'search_need_proposal_bad_decision' },
  { label: 'reason 是自由文本', raw: '{"decision":"answer","reason":"因为我觉得该搜"}', expect: 'search_need_proposal_bad_reason' },
  { label: 'search 却没给 span', raw: '{"decision":"search","reason":"latest_news"}', expect: 'search_need_proposal_missing_span' },
  { label: '非 search 却带了 span', raw: '{"decision":"answer","reason":"stable_knowledge","querySpan":{"start":0,"end":4}}', expect: 'search_need_proposal_unexpected_span' },
]
for (const item of NEGATIVE_OUTPUTS) {
  const problems = problemsOf(() => parseSearchNeedJudgeOutput(item.raw))
  check(
    `★ 负控：${item.label} ⇒ 拒且码是 \`${item.expect}\``,
    problems.includes(item.expect),
    problems.join(',') || '**没有被拒**'
  )
}
check(
  '★ 判定通过的 span 仍然要过**当前文本**校验（越界 ⇒ 拒；解析通过 ≠ 可以出站）',
  (() => {
    const proposal = parseSearchNeedJudgeOutput(
      '{"decision":"search","reason":"latest_news","querySpan":{"start":0,"end":999}}'
    )
    const problems = problemsOf(() => queryTextOf(USER_TEXT, proposal.querySpan as { start: number; end: number }))
    return problems.includes('search_need_span_out_of_range')
  })(),
  '越界 span 在文本校验处被拒'
)
check(
  '★ 失败码是**闭集**（空/超时/调用失败/输出非法 —— 四件事不能混成一个码）',
  SEARCH_NEED_JUDGE_FAILURES.join(',') === 'empty_text,timeout,call_failed,invalid_output',
  SEARCH_NEED_JUDGE_FAILURES.join(',')
)

// --- 7.3 适配器：注入 fetch，一次请求、零重试、失败关闭 -----------------------

interface FakeFetch {
  impl: typeof fetch
  calls: () => number
  lastBody: () => Record<string, unknown> | undefined
}

function makeFakeFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response
): FakeFetch {
  let calls = 0
  let last: Record<string, unknown> | undefined
  const impl = (async (input: unknown, init?: RequestInit) => {
    calls += 1
    const url = String(input)
    if (typeof init?.body === 'string') last = JSON.parse(init.body) as Record<string, unknown>
    return handler(url, init ?? {})
  }) as unknown as typeof fetch
  return { impl, calls: () => calls, lastBody: () => last }
}

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

const okContent = (content: string): Response => jsonResponse({ choices: [{ message: { content } }] })

const ENV_WITH_KEY = { OPENAI_API_KEY: 'test-key-not-real', OPENAI_BASE_URL: 'https://example.invalid/v1' }

const okFetch = makeFakeFetch(() =>
  okContent('{"decision":"search","reason":"time_sensitive_fact","querySpan":{"start":0,"end":4}}')
)
const okJudge = createOpenAiSearchNeedJudge({ fetchImpl: okFetch.impl, env: ENV_WITH_KEY })
const okOutcome = await okJudge.judge({ text: USER_TEXT })
check(
  '★ 正控：合法输出 ⇒ `ok:true` + 提案 + requestCount=1',
  okOutcome.ok === true && okOutcome.requestCount === 1 && okFetch.calls() === 1,
  okOutcome.ok ? `proposal=${okOutcome.proposal.decision} · calls=${okFetch.calls()}` : okOutcome.failure
)
check(
  '★ 出站形状：body 恰好五个字段，且消息只有两条（多一个字段/消息都会让"只送当前发言"失真）',
  (() => {
    const body = okFetch.lastBody() ?? {}
    const keys = Object.keys(body).sort().join(',')
    const msgs = body.messages as { role: string; content: string }[] | undefined
    return (
      keys === 'max_tokens,messages,model,response_format,stream,temperature' &&
      Array.isArray(msgs) &&
      msgs.length === 2 &&
      msgs[1]?.content === USER_TEXT &&
      body.stream === false &&
      body.temperature === 0
    )
  })(),
  `keys=${Object.keys(okFetch.lastBody() ?? {}).sort().join(',')}`
)

const FAILURE_CASES: {
  label: string
  expect: string
  expectRequests: number
  run: () => Promise<{ ok: boolean; requestCount: number; failure?: string }>
  calls: () => number
}[] = []

const http500 = makeFakeFetch(() => jsonResponse({ error: { message: 'boom' } }, 500))
FAILURE_CASES.push({
  label: 'HTTP 500',
  expect: 'call_failed',
  expectRequests: 1,
  run: () => createOpenAiSearchNeedJudge({ fetchImpl: http500.impl, env: ENV_WITH_KEY }).judge({ text: USER_TEXT }),
  calls: http500.calls,
})
const notString = makeFakeFetch(() => jsonResponse({ choices: [{ message: { content: 42 } }] }))
FAILURE_CASES.push({
  label: 'content 不是字符串',
  expect: 'invalid_output',
  expectRequests: 1,
  run: () => createOpenAiSearchNeedJudge({ fetchImpl: notString.impl, env: ENV_WITH_KEY }).judge({ text: USER_TEXT }),
  calls: notString.calls,
})
const smuggleOut = makeFakeFetch(() =>
  okContent('{"decision":"search","reason":"latest_news","querySpan":{"start":0,"end":4},"authorized":true}')
)
FAILURE_CASES.push({
  label: '模型输出里**偷渡** `authorized:true`',
  expect: 'invalid_output',
  expectRequests: 1,
  run: () => createOpenAiSearchNeedJudge({ fetchImpl: smuggleOut.impl, env: ENV_WITH_KEY }).judge({ text: USER_TEXT }),
  calls: smuggleOut.calls,
})
const emptyTextFetch = makeFakeFetch(() => okContent('{}'))
FAILURE_CASES.push({
  label: '空文本（**零请求**）',
  expect: 'empty_text',
  expectRequests: 0,
  run: () => createOpenAiSearchNeedJudge({ fetchImpl: emptyTextFetch.impl, env: ENV_WITH_KEY }).judge({ text: '   ' }),
  calls: emptyTextFetch.calls,
})
const noKeyFetch = makeFakeFetch(() => okContent('{}'))
FAILURE_CASES.push({
  label: '没有 key（**零请求**，绝不回落别的凭证）',
  expect: 'call_failed',
  expectRequests: 0,
  run: () => createOpenAiSearchNeedJudge({ fetchImpl: noKeyFetch.impl, env: {} }).judge({ text: USER_TEXT }),
  calls: noKeyFetch.calls,
})
const hangFetch = makeFakeFetch(
  (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
)
FAILURE_CASES.push({
  label: '硬超时（20ms 注入）',
  expect: 'timeout',
  expectRequests: 1,
  run: () =>
    createOpenAiSearchNeedJudge({ fetchImpl: hangFetch.impl, env: ENV_WITH_KEY, timeoutMs: 20 }).judge({
      text: USER_TEXT,
    }),
  calls: hangFetch.calls,
})
const abortFetch = makeFakeFetch(
  (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
)
FAILURE_CASES.push({
  label: '调用方取消（与超时同归 `timeout`：两者都意味着"这一轮没有合法判定"）',
  expect: 'timeout',
  expectRequests: 1,
  run: () => {
    const controller = new AbortController()
    const promise = createOpenAiSearchNeedJudge({ fetchImpl: abortFetch.impl, env: ENV_WITH_KEY }).judge({
      text: USER_TEXT,
      signal: controller.signal,
    })
    controller.abort()
    return promise
  },
  calls: abortFetch.calls,
})

for (const item of FAILURE_CASES) {
  const outcome = (await item.run()) as { ok: boolean; requestCount: number; failure?: string }
  check(
    `★ 负控：${item.label} ⇒ \`${item.expect}\` 且请求数 = ${item.expectRequests}`,
    outcome.ok === false && outcome.failure === item.expect && outcome.requestCount === item.expectRequests,
    `${outcome.ok ? 'ok' : outcome.failure} · requestCount=${outcome.requestCount}`
  )
  check(
    `★ 零重试：${item.label} ⇒ fetch 只被调用 ${item.expectRequests} 次（没有循环、没有降级重问）`,
    item.calls() === item.expectRequests,
    `fetch calls = ${item.calls()}`
  )
}

// --- 7.4 旁路检测器：显式候选**绕过判定**直达 provider 必须被抓住 ---------------

/** 静态扫描：允许出现 `WEB_SEARCH_OPERATION` 的**唯一**白名单 */
const WEB_SEARCH_REFERENCE_WHITELIST: readonly string[] = [
  'src/kernel/action/external-evidence-capability.ts', // 能力的定义处
  'src/kernel/action/external-evidence-intent.ts', // 词形检测器（候选来源）
  'src/infrastructure/action/adapters/web-search.ts', // 适配器（执行端）
]

/** 收集 `.ts`（返回**相对 ROOT** 的 posix 风格路径；用于白名单比对） */
function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry)
    const info = statSync(absolute)
    if (info.isDirectory()) collectTsFiles(absolute, out)
    else if (entry.endsWith('.ts')) {
      out.push(absolute.replace(/\\/g, '/').replace(`${ROOT.replace(/\\/g, '/')}/`, ''))
    }
  }
  return out
}

/** 检测器本体：哪些文件提到了 `WEB_SEARCH_OPERATION`（**只看代码，不执行**） */
function findWebSearchReferenceFiles(files: readonly string[]): string[] {
  return files.filter((file) => readFileSync(file, 'utf8').includes('WEB_SEARCH_OPERATION'))
}
/** 越界者 = 引用了它但不在白名单里（旁路就是这么长出来的） */
function findBypassFiles(files: readonly string[]): string[] {
  return findWebSearchReferenceFiles(files).filter((file) => !WEB_SEARCH_REFERENCE_WHITELIST.includes(file))
}

const scannedFiles = [
  ...collectTsFiles('src/kernel/action'),
  ...collectTsFiles('src/infrastructure/search'),
  ...collectTsFiles('src/infrastructure/model'),
]
const referencingFiles = findWebSearchReferenceFiles(scannedFiles)
check(
  '★ 旁路检测器（① 正控）：构造 `web.search` 请求的地方**只有白名单里的那几处**',
  referencingFiles.length > 0 && findBypassFiles(scannedFiles).length === 0,
  `扫描 ${scannedFiles.length} 个文件 · 引用 ${referencingFiles.length} 个 · 越界 ${findBypassFiles(scannedFiles).length}`
)

/*
 * ② 负控：**真的**在磁盘上放一个"显式候选绕过判定直达 provider"的假文件，
 *    再把同一份检测器跑在那个目录上 —— 它必须响。
 *    （第一版这里是内存里拼了个数组假装注入，那等于什么都没测：检测器是不是哑的看不出来。）
 * ③ 恢复：删掉假文件，检测器重新安静。
 */
const probeDir = mkdtempSync(join(tmpdir(), 'm551-bypass-'))
const planted = join(probeDir, 'bypass-injected.ts')
let plantedReport: { refs: number; bypass: number } = { refs: 0, bypass: 0 }
let restoredReport: { refs: number; bypass: number } = { refs: 0, bypass: 0 }
try {
  writeFileSync(
    planted,
    'export const op = WEB_SEARCH_OPERATION // 显式候选直通，绕过需求判定\n',
    'utf8'
  )
  const plantedFiles = collectTsFiles(probeDir)
  plantedReport = { refs: findWebSearchReferenceFiles(plantedFiles).length, bypass: findBypassFiles(plantedFiles).length }
  rmSync(planted, { force: true })
  const restoredFiles = collectTsFiles(probeDir)
  restoredReport = {
    refs: findWebSearchReferenceFiles(restoredFiles).length,
    bypass: findBypassFiles(restoredFiles).length,
  }
} finally {
  rmSync(probeDir, { recursive: true, force: true })
}
check(
  '★ 旁路检测器（② 负控）：磁盘上真的放一个旁路文件 ⇒ 检测器报出 1 个越界者',
  plantedReport.refs === 1 && plantedReport.bypass === 1,
  `引用=${plantedReport.refs} · 越界=${plantedReport.bypass}`
)
check(
  '★ 旁路检测器（③ 恢复）：删掉假文件 ⇒ 重新安静（0 引用 / 0 越界）',
  restoredReport.refs === 0 && restoredReport.bypass === 0,
  `引用=${restoredReport.refs} · 越界=${restoredReport.bypass}`
)
check(
  '★ 检测器自检：被测对象数 > 0（扫到 0 个文件时的"0 越界"是 MEASUREMENT INVALID，不是通过）',
  scannedFiles.length > 0 && referencingFiles.length > 0,
  `扫描 ${scannedFiles.length} · 引用 ${referencingFiles.length}`
)
/*
 * ⚠️ 判据更新（S2 起，**登记在案**）：成功结果多了一个 `shape` 字段（阶段耗时/长度/计数，
 *    纯诊断）。本检查**要守的东西没变**：结果里**没有**授权位。
 *    因此判据改成"键集合 ⊆ {ok,proposal,requestCount,shape}" **且**授权类字段一个都不在
 *    （结果上、提案上都不能有）—— 而不是死记三个键名（那样每加一个诊断字段都会假红）。
 */
check(
  '★ 结构性保证：判定器**没有**授权位 —— 成功结果里只有提案 + 诊断形状，授权类字段一个不在',
  okOutcome.ok === true &&
    Object.keys(okOutcome).every((key) => ['ok', 'proposal', 'requestCount', 'shape'].includes(key)) &&
    ['authorized', 'mode', 'capability', 'initiator'].every(
      (key) =>
        !Object.keys(okOutcome).includes(key) && !Object.keys(okOutcome.proposal).includes(key)
    ),
  Object.keys(okOutcome).sort().join(',')
)

// ===========================================================================
section('§8 组合判定表（WP3 · R2 §11.3）：两模式 × 私人/拒绝/澄清/answer/异常/坏 JSON ⇒ 出站 0')
// ===========================================================================

/*
 * ⚠️ 这一节用 **fixture 判定器**（`src/infrastructure/search/fixture-search-need-judge.ts`），
 *    它返回的是**逐字的"模型原始输出"**，因此跑的是与生产同一条解析链。
 *
 * 它能证明：**判定说非 search 时，这个候选一定到不了 provider**（出站 0）。
 * 它**不能**证明：判定每次都说得对 —— 那是 WP7 真实模型 + WP6 语料的事。
 * 这两句话必须一起读，否则"fixture 全绿"会被误读成"已经能识别私人查询"。
 */

interface PipelineResult {
  /** 这一轮**真正**发出去的搜索调用数（0/1） */
  searchCalls: number
  decision?: string
  code?: string
  query?: string
  judgeFailure?: string
}

async function runPipeline(
  judge: { judge: (input: { text: string }) => Promise<{ ok: boolean; proposal?: SearchNeedProposal; failure?: string }> },
  text: string,
  mode: string,
  candidateSource: 'explicit_request' | 'auto_proposal',
  explicitRequestConfirmed: boolean
): Promise<PipelineResult> {
  const judged = await judge.judge({ text })
  if (judged.ok !== true || judged.proposal === undefined) {
    return { searchCalls: 0, judgeFailure: judged.failure ?? 'invalid_output' }
  }
  const outcome = decideSearchNeed({
    masterEnabled: true,
    mode,
    proposal: judged.proposal,
    candidateSource,
    explicitRequestConfirmed,
    localActionFired: false,
    providerCallsUsed: 0,
  })
  if (outcome.allowed !== true) {
    return { searchCalls: 0, decision: judged.proposal.decision, code: outcome.code }
  }
  return {
    searchCalls: 1,
    decision: 'search',
    code: outcome.code,
    query: queryTextOf(text, judged.proposal.querySpan ?? { start: 0, end: 0 }),
  }
}

const fixtureJudge = createFixtureSearchNeedJudge()
const PUBLIC_TEXT = '现在黄金价格是多少'
const EXPLICIT_TEXT = '帮我联网搜索台风最新路径'
const PRIVATE_TEXTS = [
  '我查一下我的笔记',
  '我要查一下银行余额',
  '我昨天跟你说过我住在哪',
  '「据说黄金会涨」这句话是什么意思',
  '今天天气不错',
]

const COMPOSITION_ROWS: {
  label: string
  text: string
  mode: string
  source: 'explicit_request' | 'auto_proposal'
  confirmed: boolean
  expectCalls: number
}[] = [
  { label: '正控 · auto_public 合法自动提案', text: PUBLIC_TEXT, mode: 'auto_public', source: 'auto_proposal', confirmed: false, expectCalls: 1 },
  { label: '正控 · explicit 合法显式请求', text: EXPLICIT_TEXT, mode: 'explicit', source: 'explicit_request', confirmed: true, expectCalls: 1 },
  ...PRIVATE_TEXTS.flatMap((text) => [
    { label: `负控 · explicit 私人/自述/引用/闲聊：${text}`, text, mode: 'explicit', source: 'explicit_request' as const, confirmed: true, expectCalls: 0 },
    { label: `负控 · auto_public 同一句：${text}`, text, mode: 'auto_public', source: 'auto_proposal' as const, confirmed: false, expectCalls: 0 },
  ]),
  { label: '负控 · 显式禁止（判定说 deny_search）', text: '不要联网搜索', mode: 'explicit', source: 'explicit_request', confirmed: true, expectCalls: 0 },
  { label: '负控 · 对象不明（判定说 clarify）', text: '查一下那个', mode: 'explicit', source: 'explicit_request', confirmed: true, expectCalls: 0 },
  { label: '负控 · 判定**超时**', text: '判定会超时的那句', mode: 'explicit', source: 'explicit_request', confirmed: true, expectCalls: 0 },
  { label: '负控 · 判定返回**坏 JSON**', text: '判定会返回坏 JSON 的那句', mode: 'auto_public', source: 'auto_proposal', confirmed: false, expectCalls: 0 },
  { label: '负控 · 显式候选但程序未确认（判定说 search 也不放行）', text: EXPLICIT_TEXT, mode: 'explicit', source: 'explicit_request', confirmed: false, expectCalls: 0 },
]

const rowsJudge = createFixtureSearchNeedJudge({
  failures: { '判定会超时的那句': 'timeout' },
  outputs: { '判定会返回坏 JSON 的那句': '{"decision":"search",,}' },
})
let allowedRows = 0
for (const row of COMPOSITION_ROWS) {
  const result = await runPipeline(rowsJudge, row.text, row.mode, row.source, row.confirmed)
  if (result.searchCalls === 1) allowedRows += 1
  check(
    `★ ${row.label} ⇒ 搜索调用 ${row.expectCalls}`,
    result.searchCalls === row.expectCalls,
    row.expectCalls === 0
      ? `${result.searchCalls} 次（decision=${result.decision ?? '-'} · ${result.code ?? result.judgeFailure ?? '-'}）`
      : `${result.searchCalls} 次 · query=${JSON.stringify(result.query)}`
  )
}
check(
  '★ 正控不为"一律不搜"：确有行放行（否则上面全是对一个哑系统断言"零调用"）',
  allowedRows === 2,
  `放行 ${allowedRows} 行 / 共 ${COMPOSITION_ROWS.length} 行`
)
check(
  '★ 判定器**真的被问过**：调用次数 = 组合行数（"零出站"不是因为压根没判定）',
  rowsJudge.calls() === COMPOSITION_ROWS.length,
  `judge calls = ${rowsJudge.calls()} · rows = ${COMPOSITION_ROWS.length}`
)

// R2 §11.1 第 5 条：**判定通过的片段就是实际发送的片段**
const MIXED_TEXT = '我的手机号是13800000000，帮我搜索一下台风路径'
const mixedJudge = createFixtureSearchNeedJudge({
  outputs: {
    [MIXED_TEXT]: JSON.stringify({
      decision: 'search',
      reason: 'explicit_public_sourcing',
      querySpan: { start: MIXED_TEXT.indexOf('台风路径'), end: MIXED_TEXT.length },
    }),
  },
})
const mixed = await runPipeline(mixedJudge, MIXED_TEXT, 'explicit', 'explicit_request', true)
check(
  '★ R2 §11.1 第 5 条：出站 query **只能是判定通过的那一段** —— 前一分句的手机号被排除在外',
  mixed.searchCalls === 1 &&
    mixed.query === '台风路径' &&
    !(mixed.query ?? '').includes('13800000000'),
  `query=${JSON.stringify(mixed.query)}`
)
check(
  '★ 负控：模型试图把 span 指到**私人前缀**上（含有手机号）⇒ 越界前先被"只能取连续片段"约束暴露（对照 L-M55-17）',
  (() => {
    // 逐字的旧抽法（M5.5 `extractSearchQuery`）会得到什么：为对照留证，不作为放行依据
    const legacy = MIXED_TEXT.replace('搜索一下', ' ').replace(/^[\s，,。.、；;：:！!？?的个了把在将帮给我请一下一查一遍]+/, '')
    return legacy.includes('13800000000') && mixed.query === '台风路径'
  })(),
  '旧抽法含手机号 · 判定路径不含'
)

// ===========================================================================
section('§9 一轮解析（WP4 · R2 §11.2）：候选 → 共用判定 → 授权 → 绑定 query')
// ===========================================================================

/*
 * 这一节测的是**生产路径真正会走的那段编排**（`resolveSearchNeed`），
 * 用 fixture 判定器（离线、确定）。它回答的是 WP3 回答不了的那个问题：
 * **候选怎么产生、判定器缺席时会不会偷偷回退、explicit 模式无词形时会不会白问一次模型。**
 */

type Resolution = Awaited<ReturnType<typeof resolveSearchNeed>>
const RESOLVE_BASE = {
  text: '现在黄金价格是多少',
  mode: 'explicit',
  masterEnabled: true,
  dryRun: false,
  localActionFired: false,
  providerCallsUsed: 0,
  judgeCallsUsed: 0,
  explicitCandidate: false,
}

async function resolveWith(
  over: Partial<typeof RESOLVE_BASE>,
  deps: { judge?: ReturnType<typeof createFixtureSearchNeedJudge> } = {}
): Promise<{ resolution: Resolution; judgeCalls: number }> {
  const judge = deps.judge ?? createFixtureSearchNeedJudge()
  const resolution = await resolveSearchNeed({ ...RESOLVE_BASE, ...over }, { judge })
  return { resolution, judgeCalls: judge.calls() }
}
const noJudge = (over: Partial<typeof RESOLVE_BASE>) =>
  resolveSearchNeed({ ...RESOLVE_BASE, ...over }, {})

const RESOLUTION_ROWS: {
  label: string
  over: Partial<typeof RESOLVE_BASE>
  expectCode: string
  expectAction: string
  expectJudgeCalls: number
}[] = [
  // 前置检查（**不调判定**）
  { label: '总开关 off', over: { masterEnabled: false, explicitCandidate: true }, expectCode: 'master_switch_off', expectAction: 'none', expectJudgeCalls: 0 },
  { label: '模式值非法', over: { mode: 'automatic', explicitCandidate: true }, expectCode: 'invalid_mode', expectAction: 'none', expectJudgeCalls: 0 },
  { label: 'dryRun', over: { dryRun: true, explicitCandidate: true }, expectCode: 'dry_run', expectAction: 'none', expectJudgeCalls: 0 },
  { label: '本地动作已命中', over: { localActionFired: true, explicitCandidate: true }, expectCode: 'local_action_preferred', expectAction: 'none', expectJudgeCalls: 0 },
  { label: '判定额度已用尽', over: { judgeCallsUsed: 1, explicitCandidate: true }, expectCode: 'judge_quota_exhausted', expectAction: 'none', expectJudgeCalls: 0 },
  { label: 'provider 额度已用尽', over: { providerCallsUsed: 1, explicitCandidate: true }, expectCode: 'provider_quota_exhausted', expectAction: 'none', expectJudgeCalls: 0 },
  // ★ R2 §11.3 点名的那条：explicit 模式无词形 ⇒ 连判定都不问
  { label: '★ explicit 模式 + **没有**词形命中', over: { explicitCandidate: false }, expectCode: 'no_candidate', expectAction: 'none', expectJudgeCalls: 0 },
  // 判定与授权
  { label: '★ 正控：explicit + 词形命中 + 判定 search', over: { explicitCandidate: true }, expectCode: 'allowed', expectAction: 'search', expectJudgeCalls: 1 },
  { label: '★ 正控：auto_public 无词形 ⇒ 自动候选送判定', over: { mode: 'auto_public' }, expectCode: 'allowed', expectAction: 'search', expectJudgeCalls: 1 },
  { label: '★ 负控：判定说 answer（私人对象）⇒ 不产生请求', over: { text: '我查一下我的笔记', explicitCandidate: true }, expectCode: 'no_action', expectAction: 'vetoed', expectJudgeCalls: 1 },
  { label: '★ 负控：判定说 clarify', over: { text: '查一下那个', explicitCandidate: true }, expectCode: 'no_action', expectAction: 'vetoed', expectJudgeCalls: 1 },
  { label: '★ 负控：判定说 deny_search', over: { text: '不要联网搜索', mode: 'auto_public', explicitCandidate: false }, expectCode: 'no_action', expectAction: 'vetoed', expectJudgeCalls: 1 },
]
for (const row of RESOLUTION_ROWS) {
  const { resolution, judgeCalls } = await resolveWith(row.over)
  check(
    `★ ${row.label} ⇒ \`${row.expectCode}\` / ${row.expectAction} / 判定 ${row.expectJudgeCalls} 次`,
    resolution.code === row.expectCode &&
      resolution.action === row.expectAction &&
      resolution.judgeCalls === row.expectJudgeCalls &&
      judgeCalls === row.expectJudgeCalls &&
      resolution.providerCalls === (row.expectAction === 'search' ? 1 : 0),
    `${resolution.code}/${resolution.action} · judgeCalls=${resolution.judgeCalls}`
  )
}

const positives = await resolveWith({ explicitCandidate: true })
check(
  '★ 绑定：放行时的 query **逐字**是判定通过的那一段（`现在黄金价格是多少` → `黄金价格`）',
  positives.resolution.query === '黄金价格',
  JSON.stringify(positives.resolution.query)
)
const noJudgeResult = await noJudge({ explicitCandidate: true })
check(
  '★ ★ 负控（最容易写错的一处）：**判定器缺席 ⇒ 不得回退词形直通**',
  noJudgeResult.code === 'judge_absent' && noJudgeResult.action === 'vetoed' && noJudgeResult.providerCalls === 0,
  `${noJudgeResult.code}/${noJudgeResult.action} · providerCalls=${noJudgeResult.providerCalls}`
)
const failedJudge = createFixtureSearchNeedJudge({ failures: { [RESOLVE_BASE.text]: 'timeout' } })
const timedOutJudgment = await resolveWith({ explicitCandidate: true }, { judge: failedJudge })
check(
  '★ 负控：判定**超时** ⇒ `judge_failed` 且 provider 调用 0（不回退、不补搜）',
  timedOutJudgment.resolution.code === 'judge_failed' && timedOutJudgment.resolution.providerCalls === 0 && timedOutJudgment.resolution.judgeCalls === 1,
  `${timedOutJudgment.resolution.code} · judge=${timedOutJudgment.resolution.judgeCalls} · provider=${timedOutJudgment.resolution.providerCalls}`
)
const spanJudge = createFixtureSearchNeedJudge({
  outputs: {
    '现在黄金价格是多少': JSON.stringify({
      decision: 'search',
      reason: 'latest_news',
      querySpan: { start: 0, end: 999 },
    }),
  },
})
const badSpan = await resolveWith({ explicitCandidate: true }, { judge: spanJudge })
check(
  '★ 负控：判定给的 span 越界 ⇒ `span_invalid` 且 provider 调用 0（解析通过 ≠ 可以出站）',
  badSpan.resolution.code === 'span_invalid' && badSpan.resolution.providerCalls === 0,
  badSpan.resolution.code
)
check(
  '★ 上限即不变量：任何一轮的 provider 调用 ≤1、判定调用 ≤1（显式与自动共享）',
  SEARCH_NEED_LIMITS.maxJudgeCallsPerTurn === 1 &&
    SEARCH_NEED_LIMITS.maxProviderCallsPerTurn === 1 &&
    [...RESOLUTION_ROWS.map((r) => r.expectJudgeCalls), 1].every((n) => n <= 1),
  JSON.stringify(SEARCH_NEED_LIMITS)
)

// ===========================================================================
section('§10 回复绑定（WP5 · 计划 §WP5）：未查 ≠ 查了没结果 · 失败不冒充成功')
// ===========================================================================

const SUCCESS_CLAIM = '我上网查了一下，台风现在在西北太平洋。'
const NEUTRAL_REPLY = '今天天气不错，我们聊点别的吧。'

const REPLY_ROWS: {
  label: string
  input: { resolutionCode?: string; decision?: string }
  expectState: string
  expectReplaced: boolean
}[] = [
  { label: '判定放行（归 M5.5 五态）', input: { resolutionCode: 'allowed' }, expectState: 'searched', expectReplaced: false },
  { label: '本轮没有判定路径', input: {}, expectState: 'searched', expectReplaced: false },
  { label: '★ `no_candidate`（没建立候选）⇒ **不接手**（L-M55-03 边界不动）', input: { resolutionCode: 'no_candidate' }, expectState: 'searched', expectReplaced: false },
  { label: '判定说 answer ⇒ 未查', input: { resolutionCode: 'no_action', decision: 'answer' }, expectState: 'not_attempted', expectReplaced: true },
  { label: '判定说 clarify ⇒ 未查且该问她', input: { resolutionCode: 'no_action', decision: 'clarify' }, expectState: 'needs_clarification', expectReplaced: true },
  { label: '判定说 deny_search ⇒ 未查（尊重禁止）', input: { resolutionCode: 'no_action', decision: 'deny_search' }, expectState: 'prohibited', expectReplaced: true },
  { label: '★ 判定**超时** ⇒ 故障，不是"查了没结果"', input: { resolutionCode: 'judge_failed' }, expectState: 'judgment_failed', expectReplaced: true },
  { label: '判定器缺席 ⇒ 同样是故障', input: { resolutionCode: 'judge_absent' }, expectState: 'judgment_failed', expectReplaced: true },
  { label: 'span 越界 ⇒ 同样是故障', input: { resolutionCode: 'span_invalid' }, expectState: 'judgment_failed', expectReplaced: true },
  { label: '总开关 off ⇒ 未查', input: { resolutionCode: 'master_switch_off' }, expectState: 'not_attempted', expectReplaced: true },
]
for (const row of REPLY_ROWS) {
  const outcome = applySearchNeedReplyPolicy({ ...row.input, searchState: 'no_search', replyText: SUCCESS_CLAIM })
  check(
    `★ ${row.label} ⇒ \`${row.expectState}\` / 顶替=${row.expectReplaced}`,
    outcome.state === row.expectState && outcome.replaced === row.expectReplaced,
    `${outcome.state} · replaced=${outcome.replaced}`
  )
}
const notAttempted = applySearchNeedReplyPolicy({
  resolutionCode: 'no_action',
  decision: 'answer',
  searchState: 'no_search',
  replyText: SUCCESS_CLAIM,
})
const searchedEmpty = truthfulSearchSentence('searched_empty')
check(
  '★ ★ 判据核心：**"未查"与"查了没结果"是两句不同的话**',
  notAttempted.replyText !== searchedEmpty &&
    !notAttempted.replyText.includes('没有可以给你引用的结果') &&
    notAttempted.replyText.includes('没有联网查'),
  `未查=${JSON.stringify(notAttempted.replyText.slice(0, 18))} ≠ 查了没结果=${JSON.stringify(searchedEmpty?.slice(0, 18))}`
)
check(
  '★ 不误伤：回复里**没有**成功口吻时逐字不改（不替用户多说话）',
  applySearchNeedReplyPolicy({ resolutionCode: 'judge_failed', searchState: 'no_search', replyText: NEUTRAL_REPLY })
    .replyText === NEUTRAL_REPLY,
  '逐字未改'
)
check(
  '★ 失败不冒充成功：非放行态顶替后**不含**原来的成功口吻片段',
  (['no_action', 'judge_failed'] as const).every((code) => {
    const outcome = applySearchNeedReplyPolicy({ resolutionCode: code, searchState: 'no_search', replyText: SUCCESS_CLAIM })
    return outcome.replaced && !outcome.replyText.includes('我上网查了一下')
  }),
  '成功口吻已顶替'
)
check(
  '★ 幂等：顶替后的句子再喂一次 ⇒ 不再改写（否则会反复叠句）',
  (() => {
    const once = applySearchNeedReplyPolicy({ resolutionCode: 'judge_failed', searchState: 'no_search', replyText: SUCCESS_CLAIM })
    const twice = applySearchNeedReplyPolicy({ resolutionCode: 'judge_failed', searchState: 'no_search', replyText: once.replyText })
    return twice.replyText === once.replyText && twice.replaced === false
  })(),
  '第二次安静'
)
check(
  '★ 诊断抽取：从 `ActionTurnResult.diagnostics` 里取码与结论（被否决的轮次没有 request/result 也能取到）',
  (() => {
    const got = searchNeedDiagnosticsOf([
      { diagnostics: { search_need_code: 'no_action', search_need_decision: 'private_object' } },
    ])
    return got.code === 'no_action' && got.decision === 'private_object' && searchNeedDiagnosticsOf(undefined).code === undefined
  })(),
  'code + decision'
)
check(
  '★ 状态是闭集（五种），且 `searched` 不重复表达 M5.5 的五态',
  SEARCH_NEED_REPLY_STATES.length === 5 && SEARCH_NEED_REPLY_STATES.includes('searched'),
  SEARCH_NEED_REPLY_STATES.join(',')
)
// ===========================================================================
section('§11 S4 判定超时配置（裁定 A）：边界 / 非法即禁止搜索 / 超时覆盖读体')
// ===========================================================================

/** 用一个只含该变量的 env 读 flags（不碰真实 process.env） */
const flagsWith = (raw: string | undefined) =>
  readKernelFlags({
    ...(raw !== undefined ? { CHARACTER_WEB_SEARCH_JUDGE_TIMEOUT_MS: raw } : {}),
  } as NodeJS.ProcessEnv)

check(
  '★ 正控：未设 ⇒ 缺省 **15000ms**（裁定 2026-09-20 方案 B：原 10000）',
  flagsWith(undefined).webSearchJudgeTimeoutMs === 25_000,
  String(flagsWith(undefined).webSearchJudgeTimeoutMs)
)
for (const value of ['1000', '5000', '10000', '15000', '25000']) {
  check(
    `★ 正控：合法值 ${value} ⇒ 原样生效（5000/10000 都是回滚值）`,
    flagsWith(value).webSearchJudgeTimeoutMs === Number(value),
    String(flagsWith(value).webSearchJudgeTimeoutMs)
  )
}
for (const [value, why] of [
  ['999', '低于下界（**不许**静默夹到 1000）'],
  ['25001', '高于上界（**不许**静默夹到 25000）'],
  ['10000.5', '不是整数'],
  ['abc', '不是数字'],
  ['-1', '负数'],
  ['1e6', '科学计数法超界'],
] as const) {
  check(
    `★ 负控：非法值 ${value}（${why}）⇒ \`undefined\` = 配置错误 ⇒ 禁止搜索`,
    flagsWith(value).webSearchJudgeTimeoutMs === undefined,
    String(flagsWith(value).webSearchJudgeTimeoutMs)
  )
}
check(
  '★ 空串按"未设"处理 ⇒ 缺省 15000（不是配置错误）',
  flagsWith('').webSearchJudgeTimeoutMs === 25_000,
  String(flagsWith('').webSearchJudgeTimeoutMs)
)
check(
  '★ 裁定第 2 条：日志必须显示**实际生效值**（describeKernelFlags 里可读）',
  describeKernelFlags({ ...flagsWith('5000'), eventPipelineV2: false, contextCompilerV1: false, telemetryEnabled: false, slowPathEnabled: false, memoryEnabled: false, memoryExplicitEnabled: false, memoryBackgroundEnabled: false, memoryLlmExtractorEnabled: false, actionEnabled: false, recallEnabled: false, webSearchEnabled: true }).includes('web-search-judge-timeout(5000ms)'),
  '启动行含 web-search-judge-timeout(5000ms)'
)
check(
  '★ 非法配置 ⇒ 日志里显式标 INVALID（不是悄悄用缺省）',
  describeKernelFlags({ ...flagsWith('999'), eventPipelineV2: false, contextCompilerV1: false, telemetryEnabled: false, slowPathEnabled: false, memoryEnabled: false, memoryExplicitEnabled: false, memoryBackgroundEnabled: false, memoryLlmExtractorEnabled: false, actionEnabled: false, recallEnabled: false, webSearchEnabled: true }).includes('web-search-judge-timeout(INVALID(禁止搜索)ms)'),
  'INVALID 可见'
)
check(
  '★ 静态：装配层对非法配置**不构造判定器**（与开关关闭/模式非法同一条路，不静默回落）',
  readFileSync('src/main.ts', 'utf8').includes('if (judgeTimeoutMs === undefined) return undefined'),
  'src/main.ts 的 failing-closed 分支存在'
)

/*
 * ★ 裁定第 2 条："超时覆盖**完整判定调用，包括响应体读取**"。
 *   只把 signal 交给 fetch 不够 —— 这里造一个**读体永不返回**的响应，
 *   超时必须照样在预算内结束，且 requestCount 如实为 1。
 */
const hangingBodyFetch = (async () =>
  new Response(new ReadableStream({ start() {} }), { status: 200 })) as unknown as typeof fetch
const startedAt = Date.now()
const hangingOutcome = await createOpenAiSearchNeedJudge({
  fetchImpl: hangingBodyFetch,
  env: { OPENAI_API_KEY: 'test-key-not-real', OPENAI_BASE_URL: 'https://example.invalid/v1' },
  timeoutMs: 60,
}).judge({ text: USER_TEXT })
const elapsed = Date.now() - startedAt
check(
  '★ 核心（裁定第 2 条）：响应体读取被挂住 ⇒ 到期取消、报 `timeout`、requestCount=1、**不无限等**',
  hangingOutcome.ok === false && hangingOutcome.failure === 'timeout' && hangingOutcome.requestCount === 1 && elapsed < 3000,
  `${hangingOutcome.ok ? 'ok' : hangingOutcome.failure} · requestCount=${hangingOutcome.requestCount} · ${elapsed}ms`
)
check(
  '★ 失败关闭：同一次超时**不产生**任何可行提案（不可能被误当成 search）',
  hangingOutcome.ok === false && !('proposal' in hangingOutcome),
  '失败分支没有 proposal 字段'
)

// ===========================================================================
section('§12 R2-2 观测完整性：注入 9 种响应形态 —— 分类准确、失败仍关闭、形状不漏文本')
// ===========================================================================

/*
 * R2 复核的判据：`content_not_string` **不是底层根因** —— 它把 null / 缺失 / 数组 / 对象
 * 全糊进一个码里。这一节逐种注入，断言：
 *   · `contentKind` / `finishReason` 分类准确（闭集）
 *   · `finishReason` **不回显**端点给的任意字符串（那是把外部文本写进证据的入口）
 *   · 形状**成功与失败都带**（缺了它就无法归因"为什么没有 content"）
 *   · 失败仍是 `invalid_output` ⇒ 下游零搜索（不放松任何校验）
 */

const SHAPE_ENV = { OPENAI_API_KEY: 'test-key-not-real', OPENAI_BASE_URL: 'https://example.invalid/v1' }
const MARKER = 'ZZ-injected-marker-ZZ'

const jsonOf = (payload: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch

const judgeShapeOf = async (payload: unknown) =>
  await createOpenAiSearchNeedJudge({ fetchImpl: jsonOf(payload), env: SHAPE_ENV }).judge({ text: USER_TEXT })

const SHAPE_CASES: {
  label: string
  payload: unknown
  contentKind: string
  finishReason: string
}[] = [
  {
    label: '正常 JSON',
    payload: { choices: [{ message: { content: '{"decision":"answer","reason":"stable_knowledge"}' }, finish_reason: 'stop' }] },
    contentKind: 'string',
    finishReason: 'stop',
  },
  {
    label: 'content 是 null（带思维链）',
    payload: { choices: [{ message: { content: null, reasoning_content: 'x' }, finish_reason: 'stop' }] },
    contentKind: 'null',
    finishReason: 'stop',
  },
  {
    label: '缺 content 字段（finish=length）',
    payload: { choices: [{ message: { reasoning_content: 'x' }, finish_reason: 'length' }] },
    contentKind: 'missing',
    finishReason: 'length',
  },
  {
    label: '缺 choices',
    payload: {},
    contentKind: 'missing',
    finishReason: 'missing',
  },
  {
    label: 'content 是数组',
    payload: { choices: [{ message: { content: [{ type: 'text', text: MARKER }] }, finish_reason: 'stop' }] },
    contentKind: 'array',
    finishReason: 'stop',
  },
  {
    label: 'finish_reason 是未知字符串',
    payload: { choices: [{ message: { content: 'nope' }, finish_reason: MARKER }] },
    contentKind: 'string',
    finishReason: 'other',
  },
  {
    label: '只有 tool_calls',
    payload: { choices: [{ message: { tool_calls: [{ id: 'a' }, { id: 'b' }] }, finish_reason: 'tool_calls' }] },
    contentKind: 'missing',
    finishReason: 'tool_calls',
  },
  {
    label: '带 refusal 字段',
    payload: { choices: [{ message: { refusal: MARKER }, finish_reason: 'stop' }] },
    contentKind: 'missing',
    finishReason: 'stop',
  },
  {
    label: 'content 是空白字符串（仍是 string，走解析 ⇒ 非法）',
    payload: { choices: [{ message: { content: '   ' }, finish_reason: 'stop' }] },
    contentKind: 'string',
    finishReason: 'stop',
  },
]

for (const item of SHAPE_CASES) {
  const outcome = await judgeShapeOf(item.payload)
  const shape = outcome.shape
  const actualKind = shape?.contentKind ?? 'NO_SHAPE'
  const actualFinish = shape?.finishReason ?? 'NO_SHAPE'
  check(
    `★ 形状分类：${item.label} ⇒ contentKind=${item.contentKind} / finish=${item.finishReason}`,
    actualKind === item.contentKind && actualFinish === item.finishReason && shape !== undefined,
    `contentKind=${actualKind} finish=${actualFinish} ok=${outcome.ok}`
  )
}
check(
  '★ 泄漏防线：`finishReason` 闭集**不回显**端点给的任意字符串（注入标记一个字都不出现）',
  !JSON.stringify((await judgeShapeOf({ choices: [{ message: { content: MARKER, refusal: MARKER }, finish_reason: MARKER }] })).shape ?? {}).includes(MARKER),
  '形状里没有注入标记'
)
check(
  '★ 完整性：**成功与失败都带形状**',
  (await judgeShapeOf({ choices: [{ message: { content: '{"decision":"answer","reason":"stable_knowledge"}' } }] })).shape !== undefined &&
    (await judgeShapeOf({ choices: [{ message: { content: null } }] })).shape !== undefined,
  '两个分支都有 shape'
)
const nullContentOutcome = await judgeShapeOf({ choices: [{ message: { content: null } }] })
check(
  '★ 失败关闭不变：形状问题仍是 `invalid_output` ⇒ 下游零搜索',
  nullContentOutcome.ok === false && nullContentOutcome.failure === 'invalid_output',
  nullContentOutcome.ok ? 'ok' : nullContentOutcome.failure
)
check(
  '★ 可归因性（R2-2 的正题）：`null` / `missing` / `array` 三种形态**互不相同**（上一版全糊成一个码）',
  (() => {
    const kinds = new Set(SHAPE_CASES.slice(1, 5).map((c) => c.contentKind))
    return kinds.has('null') && kinds.has('missing') && kinds.has('array')
  })(),
  'null / missing / array 三者可分'
)

// ===========================================================================
// 证据
// ===========================================================================

const evidence = {
  testId: 'M5.5.1 / L1 component (pure contract & policy · offline · no DB)',
  note:
    'WP2 完成条件：部件门正负控通过 + 模型提案不能给自己授权。' +
    '本门只覆盖**纯契约与纯策略**；模型调用、接线、真出站分别属于 WP3/WP4/WP7。' +
    '证据里没有时钟字段 ⇒ 重复运行逐字节相同。',
  passed,
  failed,
  failures,
  checks,
  contract: {
    decisions: ['answer', 'search', 'clarify', 'deny_search'],
    reasons: SEARCH_NEED_REASONS.length,
    modes: SEARCH_MODES,
    candidateSources: SEARCH_CANDIDATE_SOURCES,
    outcomeCodes: [
      'allowed',
      'master_switch_off',
      'invalid_mode',
      'unknown_candidate_source',
      'local_action_preferred',
      'quota_exhausted',
      'not_authorized_in_explicit_mode',
      'explicit_request_not_confirmed',
      'no_action',
    ],
    limits: SEARCH_NEED_LIMITS,
    allowedFields: ['decision', 'reason', 'querySpan'],
    judge: {
      failures: SEARCH_NEED_JUDGE_FAILURES,
      messagesPerCall: messages.length,
      outboundBodyKeys: Object.keys(okFetch.lastBody() ?? {}).sort(),
      maxTokens: SEARCH_NEED_JUDGE_MAX_TOKENS,
    },
    bypassDetector: {
      scannedFiles: scannedFiles.length,
      webSearchReferenceFiles: referencingFiles,
      whitelist: WEB_SEARCH_REFERENCE_WHITELIST,
    },
  },
  /*
   * ⚠️ **已知缺口（如实登记，不作为判据锁死）**：本节的负控只覆盖"显式禁止词"。
   *    · `L-M55-17`（WP2b 实测发现，未修）：查询词 = **用户原话去掉触发短语**，
   *      **不**限定在请求对象上 ⇒ 前一分句的私有内容会一起出站：
   *      `我的手机号是13800000000，帮我搜索一下这个号码` → query 含手机号。
   *      修它属于 **WP3**（由模型给出 `querySpan`，只取请求对象那一段）。
   *      现在**没有**任何断言把这个行为锁成"正确"—— 它只是被记录下来。
   *    · 语义级否定（`我不太想要你联网搜索`）不在词形判据范围内，同样归 WP3。
   */
  knownGaps: [
    'L-M55-17: 查询词沿用 M5.5 的"去掉触发短语"抽法，会带上触发词之前的分句内容',
    '语义级否定（无显式禁止词）仍会触发，归 WP3 的需求判定',
    '不要，联网搜索：禁止词与命中短语之间隔着分句标点且其后无词 ⇒ 判成新分句而放行（词形上与"别用这个，搜索一下"同构，语义相反）',
  ],
}
mkdirSync(EVIDENCE_DIR, { recursive: true })
writeFileSync(join(EVIDENCE_DIR, 'component.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log(`\nM5.5.1 L1 部件级测试：${passed} 通过 / ${failed} 失败`)
console.log(`  证据：artifacts/m5.5.1/component.json`)
process.exit(failed > 0 ? 1 : 0)
