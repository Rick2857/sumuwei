/**
 * Lv4.5 / `P2` —— **小集合快反**（计划 §1「明确停止、呼唤苏沐薇等少量信号快速触发停止或可见回应；
 * 引用、否定和回声**不能**直接触发动作」）。
 *
 * ============================================================================
 *  它是什么，以及它为什么必须这么小
 * ============================================================================
 * 它是一个**纯函数**：给一段（可能是 partial 的）用户话，回答"要不要立刻做一件小事"。
 * 只有三个出口：
 *
 * ```text
 * stop   停止 —— 立刻停播 / 请求取消当前轮次（**不**撤销任何已提交的东西）
 * wake   呼唤 —— 她应给出一个**可见且已过守卫**的短回应（不是"直接播一句"）
 * none   什么都不做（**默认**，也是绝大多数情况）
 * ```
 *
 * ⚠️ 三个**不能**触发的情形是这一层的核心判据（计划 §1 明文）：
 * ```text
 * 引用：把词放在引号里（"她说'停一下'"）—— 那是在**谈论**这个词，不是在用它
 * 否定：词前面带否定（"你别停"）—— 意思正好相反
 * 回声：这个词出现在**她自己的**上文里（用户复述她刚说的话）—— 那不是用户的指令
 * ```
 *
 * ⚠️ 三条设计纪律：
 * ```text
 * ① 这个集合**小且封闭**：只有"停"类与"呼唤"类两组词，各有一个**显式登记表**。
 *    往表里加词是**改判据**（要配负控），不是顺手。
 * ② 它**不认识**"查一下""提醒我""帮我"这类意图 —— 那些进 LG 的正式轮次与放行链，
 *    在这里猜就等于开了一个绕过守卫的旁路。
 * ③ 它**不产生正文**：`wake` 只说"该回应"，回应由 LG 生成并过守卫
 *    （计划 §2 `P3` 同一条纪律：角色短句必须来自 LG 的检查后输出）。
 * ```
 */

import {
  WAKE_NAME_EXACT,
  WAKE_NAME_NEAR,
  WAKE_NAME_TABLE_PROVENANCE,
} from './wake-name-table.ts'

export type FastSignalKind = 'stop' | 'wake' | 'correction' | 'none'
export interface FastSignalReading {
  kind: FastSignalKind
  /** 具名理由码（**永远有值**，便于门逐条断言与线上排错） */
  code: string
  /** 命中的词（原样，仅供对账；**不含**任何其它正文） */
  matched?: string
  /**
   * 这个信号要求"多快"。
   *
   * ```text
   * immediate —— 立刻（本地就地生效：停播是把当前音频停掉，不必等 LG 回话）
   * checked   —— 要经 LG 检查后的可见回应（呼唤这一类）
   * ```
   */
  urgency: 'immediate' | 'checked' | 'none'
}

/**
 * `stop` 类：**直接祈使**才有资格。刻意短，且都是明确的动宾/祈使形。
 *
 * ⚠️ `停` / `安静` / `别` 单字刻意**不**入表：单字命中会把"停车""停课""别致"
 *    全拉进来。第一版就是因为没有裸 `停` 而让"你别停"从缝里漏过去了 ——
 *    修法**不是**加裸 `停`（那会打开更大的口子），而是把"别 + 停"作为**否定形态**
 *    显式识别（见 {@link BARE_STOP_WORDS} 与否定判定）。
 */
const STOP_PHRASES: readonly string[] = [
  '停一下',
  '停一停',
  '停下来',
  '停下',
  '先停',
  '别说了',
  '不要说了',
  '不用说了',
  '打住',
  '闭嘴',
  '等一下',
  '等等',
  '先别说',
  '安静',
]

/**
 * 裸动词：**只**用于"否定判定"（"别停"/"不要停"要说成否定，而不是无匹配）。
 *
 * ⚠️ 它**不能**单独触发 `stop` —— 只在 {@link NEGATIONS} 紧邻其前时被用到。
 */
const BARE_STOP_WORDS: readonly string[] = ['停', '说', '讲']

/**
 * `wake` 类：呼唤她。用**名字**而不是"喂/在吗"这类泛称（泛称噪声太大）。
 *
 * ============================================================================
 *  ⚠️ 名字按**从词典生成的同音类**匹配（这是用户提出的现实难题 + 真实读数）
 * ============================================================================
 * 第一版是字面量 `['苏沐薇', '沐薇']`，结果在真实链路上**一次都没触发**：
 * 用系统中文语音合成「苏沐薇，你在吗」喂进生产在用的那一档流式识别器，逐块读数是：
 *
 * ```text
 * fed= 816ms rev=1 苏
 * fed=1043ms rev=2 苏慕          ← 「沐」被听成「慕」
 * fed=1270ms rev=3 苏慕微        ← 「薇」被听成「微」
 * fed=2494ms rev=6 苏慕微你在马   ← 「吗」被听成「马」
 * ```
 *
 * 也就是说：**字面量匹配在真实 ASR 上等于没接**；而"名字被听错"不是异常，
 * 是中文语音识别的常态。手写同音字表同样不行（会漏，且说不清覆盖了多少），
 * 所以同音类**从词典生成**并冻结进 {@link WAKE_NAME_EXACT}。
 *
 * ⚠️ 近音（`WAKE_NAME_NEAR`）**至多**用一个音节：实测"三个音节各自都能偏"会把
 *    「舒服」（舒 = sh u，与首音节只差一个 s↔sh）拉成一次呼唤。
 */
const WAKE_NAME_ORDER: readonly string[] = ['su', 'mu', 'uei']

/** 把一个字符集合串转成 Set（模块加载时算一次；表是冻结数据） */
const asSet = (chars: string): ReadonlySet<string> => new Set([...chars])

const WAKE_NAME_EXACT_SETS: readonly ReadonlySet<string>[] = WAKE_NAME_ORDER.map((key) =>
  asSet(WAKE_NAME_EXACT[key] ?? '')
)
const WAKE_NAME_NEAR_SETS: readonly ReadonlySet<string>[] = WAKE_NAME_ORDER.map((key) =>
  asSet(WAKE_NAME_NEAR[key] ?? '')
)

/**
 * 在 `text` 里找出"像她的名字"的片段。
 *
 * ```text
 * 形态一（三字全名）：苏 + 沐类 + 薇类
 *   命中条件：三个位置都在同音类里；**或者**恰好一个位置落在近音类里
 * 形态二（两字名）：沐类 + 薇类 —— 但**收紧**：
 *   ⚠️ 实测："沐类+薇类"完全按同音类匹配会命中「木卫二」「素未谋面」这类真实词组
 *      （木 = m u ✓，卫 = ^ uei ✓）⇒ 因此要求这片段**在句首**且其后紧邻的字符
 *      只能是"称呼语/停顿"（你在啊呀呢吗 + 标点 + 结尾）。
 *      这样「沐薇」「沐薇你在吗」成立，而「木卫二」「素未谋面」不成立。
 *   ⚠️ 而且这一形态**只收精确同音类**，不吃近音 —— 这是**量过**的取舍：
 *      实测离线识别把单独的「沐薇」听成「莫薇」（莫 = `m o`）。若把 `m o` 也放进
 *      这一形态的近音，会**新增**「末位」「莫为」「抹为」这些**常用词**作为呼唤。
 *      对比之下，"单独两声听错时才漏一次"是更小的代价 ⇒ 保持精确。
 *      （未命中在证据里**分类**上报，见 `scripts/postlv2-wake-coverage.ts`。）
 * ```
 */
function findWakeName(text: string): { at: number; text: string; nearUsed: number } | undefined {
  const addressing = new Set(['你', '在', '啊', '呀', '呢', '吗', '吧', '喂', '，', '。', '？', '！', '?', '!', ',', ' ', '　'])
  /* 形态一：从每个可能是"苏"的位置试三字窗口 */
  for (let at = 0; at + 3 <= text.length; at += 1) {
    const window = [text[at]!, text[at + 1]!, text[at + 2]!]
    let nearUsed = 0
    let ok = true
    for (let index = 0; index < 3; index += 1) {
      const char = window[index]!
      if (WAKE_NAME_EXACT_SETS[index]!.has(char)) continue
      if (WAKE_NAME_NEAR_SETS[index]!.has(char)) {
        nearUsed += 1
        continue
      }
      ok = false
      break
    }
    if (ok && nearUsed <= 1) return { at, text: window.join(''), nearUsed }
  }
  /* 形态二：两字名（句首 + 紧邻只能是称呼语） */
  if (text.length >= 2) {
    const window = [text[0]!, text[1]!]
    const exactTwo = WAKE_NAME_EXACT_SETS[1]!.has(window[0]!) && WAKE_NAME_EXACT_SETS[2]!.has(window[1]!)
    const tail = text.length > 2 ? text[2]! : ''
    if (exactTwo && (tail === '' || addressing.has(tail))) {
      return { at: 0, text: window.join(''), nearUsed: 0 }
    }
  }
  return undefined
}
/**
 * 兼容既有读面的字面量表。
 *
 * ⚠️ 它**只**用于诊断展示（`/lg/status` 与门打印"登记表里有什么"），
 *    **不**参与判定 —— 判定走 {@link findWakeName}（生成的同音类 + 至多一个近音）。
 */
const WAKE_PHRASES: readonly string[] = ['苏沐薇', '沐薇']

/** 否定词：出现在命中词**之前**的短窗口里 ⇒ 整句不成立 */
const NEGATIONS: readonly string[] = ['别', '不要', '不用', '不准', '不许', '不是', '没有', '甭', '勿']

/**
 * 疑问标记（句尾）与疑问开头 —— 疑问句**不是**指令。
 *
 * ⚠️ 这是第一版实测踩到的真缺陷：「不用说了吗」被判成了 `stop`。
 *    它是一个**反问**（用户没有让她停），而"停"类词出现在疑问句里时，
 *    正确的反应是**不触发**（宁可漏一次，也不要在用户提问时把话掐掉）。
 *
 * ⚠️ `能不能` / `可以吗` **刻意不算疑问词头**：「能不能停一下」是**礼貌请求**，
 *    意思与"停一下"完全一致。把它们当疑问会让用户礼貌地说停时**停不下来** ——
 *    那是把判据用反了（见 {@link POLITE_PREFIXES}）。
 */
const QUESTION_TAILS: readonly string[] = ['吗', '呢', '吧', '么', '？', '?']
const QUESTION_HEADS: readonly string[] = ['为什么', '怎么', '是不是', '有没有', '难道', '凭什么']

/**
 * 礼貌前缀：它们含"不"，但**不是否定**（"能不能"= 请）。
 *
 * ⚠️ 第一版把它们当否定 ⇒「能不能停一下」被报成 `signal_stop_negated` ⇒ 停不下来。
 */
const POLITE_PREFIXES: readonly string[] = ['能不能', '可以吗', '可不可以', '好不好', '行不行']

/**
 * `correction` 类（`P3` 中途纠正）：**用户明确表示"这条不对"**。
 *
 * ============================================================================
 *  为什么它必须是一个**独立的闭集**，而不是复用 stop
 * ============================================================================
 * ```text
 * stop        —— "停下"：用户要她**闭嘴**（她自己说的话不算数了）
 * correction  —— "不对"：用户要她**改正**（先废掉未播余句，再给一条纠正段）
 * ```
 * 两者都让用户拿到话权，但**后果不同**：把 correction 当成 stop，用户永远得不到纠正；
 * 把 stop 当成 correction，用户说"别说了"会换来她**又说一句**（更糟）。
 *
 * ⚠️ 词形表刻意**短且明确**：只收"直接指出不对"的说法。
 *    边界（已知代价，与呼唤同一条纪律）：`这个方案不对，我们换一个` 这类
 *    **她不是被纠正对象**的句子也会命中 —— 这类误触发由"她正在说"这条前提
 *    与闸门（引用/否定/疑问负控）一起收窄，**不**声称零误触发。
 */
const CORRECTION_PHRASES: readonly string[] = [
  '不是这个意思',
  '不是这样',
  '不是那么回事',
  '你搞错了',
  '说反了',
  '不对',
]

/** 引号（中英）：命中词落在引号内 ⇒ 那是在**引用**这个词 */
const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ['“', '”'],
  ['‘', '’'],
  ["'", "'"],
  ['《', '》'],
  ['「', '」'],
]

/** 命中词之前允许被否定的窗口（字符数）—— 只在紧邻处判否定，避免误杀 */
const NEGATION_WINDOW = 4

function isInsideQuotes(text: string, start: number, end: number): boolean {
  for (const [open, close] of QUOTE_PAIRS) {
    /* 找到包含 [start,end) 的那一对引号 */
    let from = 0
    for (;;) {
      const openAt = text.indexOf(open, from)
      if (openAt < 0 || openAt > start) break
      const closeAt = text.indexOf(close, openAt + open.length)
      if (closeAt < 0) {
        /* 引号未闭合：保守认为命中词在引号内（宁可少触发） */
        if (openAt <= start) return true
        break
      }
      if (openAt <= start && end <= closeAt + close.length) return true
      from = closeAt + close.length
    }
  }
  return false
}

function isNegated(text: string, start: number): boolean {
  const window = text.slice(Math.max(0, start - NEGATION_WINDOW), start)
  /*
   * ⚠️ 先剥掉"**疑问**词"再判否定：`是不是该等等` 里"等等"前面是"是不是"，
   *    而"是不是"含"不是" —— 于是整句被误报成"否定"。
   *    可它既不是否定也不是指令，它是一个**问句**。
   * ⚠️ 再剥掉"礼貌前缀"："能不能停一下"里的"不能"不是否定（= 请停）。
   */
  const stripped = [...QUESTION_HEADS, ...POLITE_PREFIXES].reduce(
    (carry, marker) => carry.split(marker).join(''),
    window
  )
  return NEGATIONS.some((negation) => stripped.includes(negation))
}

/**
 * 疑问句的**两种**形态 —— 它们的强度不同，混成一个布尔正是上一版判错的原因。
 *
 * ```text
 * explicit —— 句首就是显式疑问词（"为什么…" / "是不是…"）⇒ **永远**不是指令
 * particle —— 只是句尾带语气词（"…吗" / "…吧"），句首没有疑问词
 *              ⇒ 要看命中词在哪：句首命中（"苏沐薇你在吗"）仍是最强呼唤；
 *                句中/句尾命中（"不用说了吗"）则被语气词问住 ⇒ 不是指令
 * none     —— 不是疑问
 * ```
 *
 * ⚠️ 为什么必须分开：`苏沐薇你在吗` 与 `不用说了吗` 都以"吗"结尾，
 *    但前者用户**确实在叫她**。用一个布尔处理，必然错一个。
 */
export function questionForm(text: string): 'explicit' | 'particle' | 'none' {
  const trimmed = text.trim()
  if (trimmed === '') return 'none'
  /*
   * ⚠️ 显式疑问词允许出现在**开头附近**而不是严格第一个字：实测
   *    「你为什么要停下来」以"你"开头，严格 startsWith 会漏掉它，
   *    于是用户的一个**反问**被当成指令（把话掐掉）。
   *    窗口取前 4 个字符 —— 足够容纳"你到底/你为什么/你是不是"，又不会把
   *    句中的疑问词（"她问我为什么停下"）算进来。
   */
  const head = trimmed.slice(0, 4)
  if (QUESTION_HEADS.some((marker) => head.includes(marker))) return 'explicit'
  return QUESTION_TAILS.some((tail) => trimmed.endsWith(tail)) ? 'particle' : 'none'
}

/** 兼容旧读面：只要"是疑问形态"就为真（判据细节走 {@link questionForm}） */
export function isQuestionLike(text: string): boolean {
  return questionForm(text) !== 'none'
}

/**
 * "否定 + 裸动词"形态（"别停" / "不要停" / "别说"）。
 *
 * ⚠️ 它**不是**一个触发口，而是"如实报否定"的口：返回值一律被当成 `none`。
 *    存在的理由：否则"你别停"会被报成 `signal_no_match`，而那是**另一个意思**
 *    （"没听懂"而不是"听懂了但意思相反"）。两者在排错时完全不同。
 */
function negatedBareVerb(text: string): string | undefined {
  for (const verb of BARE_STOP_WORDS) {
    let from = 0
    for (;;) {
      const at = text.indexOf(verb, from)
      if (at < 0) break
      if (isNegated(text, at)) return verb
      from = at + verb.length
    }
  }
  return undefined
}

/** 常见回声形态：整句几乎就是我方上文的复述（用"她刚说过"的片段做包含判定） */
export function isEcho(text: string, herRecentLines: readonly string[]): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return true
  for (const line of herRecentLines) {
    const herLine = line.trim()
    if (herLine === '') continue
    /* 她自己说过这条 —— 用户把它复述回来 */
    if (herLine.includes(trimmed)) return true
    /*
     * ⚠️ 反向**不**算回声：用户说的话**包含**她说过的一句（例如"你刚才说停一下，
     *    现在真的停一下"）里可能有真的指令。只判"整句被她的话包含"这一种。
     */
  }
  return false
}

/**
 * 判一次快反。
 *
 * ⚠️ 顺序是判据的一部分，不是实现细节：
 * ```text
 * ① 空句 ⇒ none
 * ② 回声 ⇒ none（**先**于命中判定：她自己的话被复述回来不该触发任何东西）
 * ③ 逐词找命中（引号内跳过；前面有否定则跳过）
 * ④ 什么都没命中 ⇒ none
 * ```
 */
export function detectFastSignal(input: {
  text: string
  /** 她最近说过的完整句子（用于回声判定；**只**用于判定，不参与输出） */
  herRecentLines?: readonly string[]
}): FastSignalReading {
  const text = String(input.text ?? '')
  if (text.trim() === '') return { kind: 'none', code: 'signal_empty', urgency: 'none' }
  if (isEcho(text, input.herRecentLines ?? [])) {
    return { kind: 'none', code: 'signal_echo_of_her_own_words', urgency: 'none' }
  }
  /*
   * ⚠️ 疑问句**先**于命中判定：实测踩到「不用说了吗」被当成 `stop`（反问不是指令）。
   *
   * ⚠️ 但要看**哪一种**疑问（见 {@link questionForm}）：
   * ```text
   * explicit（"为什么…"）      ⇒ 命中词在哪都不是指令
   * particle（"…吗"，句首无疑问词）⇒ 命中词在**句中/句尾**时才不是指令；
   *                            句首命中（"苏沐薇你在吗"）仍是最强呼唤
   * ```
   * 并且**引号与否定优先于疑问**：`她说"停一下"，我照做了` 该报"引用"而不是"疑问"，
   * 否则线上排错时看到的理由码是错的（理由码也是读数）。
   */
  const form = questionForm(text)
  /** 统一的命中形态：`stop`/`correction` 走字面量，`wake` 走**同音类**正则（见 `wakeNamePatterns`） */
  type Hit = { kind: 'stop' | 'wake' | 'correction'; at: number; length: number; matched: string }
  const hits: Hit[] = []
  for (const phrase of STOP_PHRASES) {
    const at = text.indexOf(phrase)
    if (at >= 0) hits.push({ kind: 'stop', at, length: phrase.length, matched: phrase })
  }
  for (const phrase of CORRECTION_PHRASES) {
    const at = text.indexOf(phrase)
    if (at >= 0) hits.push({ kind: 'correction', at, length: phrase.length, matched: phrase })
  }
  for (const pattern of [findWakeName(text)]) {
    if (pattern !== undefined) {
      hits.push({ kind: 'wake', at: pattern.at, length: pattern.text.length, matched: pattern.text })
    }
  }
  /*
   * ⚠️ 优先级：`stop` > `correction` > `wake`。
   * ```text
   * stop       最保守 —— 用户要她"停"，那就停（不要顺手再给她派活）
   * correction 次之 —— 用户要她"改"（比"停"多说一句，但比"打招呼"重要）
   * wake       最后 —— 那是**问候**，前两者都是**纠正/制止**
   * ```
   * ⚠️ 加入 `correction` **没有改动**既有 `stop`/`wake` 的相对顺序 ——
   *    所以既有的判据（含"停优先于呼唤"）逐条不变。
   */
  const rank = (kind: Hit['kind']): number => (kind === 'stop' ? 0 : kind === 'correction' ? 1 : 2)
  hits.sort((left, right) => (left.kind === right.kind ? left.at - right.at : rank(left.kind) - rank(right.kind)))
  for (const hit of hits) {
    const { kind, at, matched } = hit
    const end = at + hit.length
    if (isInsideQuotes(text, at, end)) {
      return { kind: 'none', code: `signal_${kind}_quoted_not_a_command`, matched, urgency: 'none' }
    }
    if (isNegated(text, at)) {
      return { kind: 'none', code: `signal_${kind}_negated`, matched, urgency: 'none' }
    }
    /*
     * ⚠️ 句尾语气词（"…吗/吧/呢"）把命中句问住的条件**按种类不同**：
     * ```text
     * stop  —— 一律问住。命令句不会以"吗/吧"收尾（"停一下吗""不用说了吗"都是问句）
     * wake  —— 只有**非句首**命中才问住；句首的名字是最强呼唤
     *          （"苏沐薇你在吗"用户确实在叫她）
     * ```
     * 第一版对两者一视同仁（都看 `at > 0`），于是"不用说了吗"（"不用说了"恰好
     * 从第 0 字开始）被当成了命令 —— 那是拿一个规则套两种信号。
     */
    const askedAway = form === 'explicit' || (form === 'particle' && (kind === 'stop' || kind === 'correction' || at > 0))
    if (askedAway) {
      return { kind: 'none', code: 'signal_question_not_a_command', matched, urgency: 'none' }
    }
    return {
      kind,
      code: kind === 'stop' ? 'signal_stop' : kind === 'correction' ? 'signal_correction' : 'signal_wake',
      matched,
      /*
       * ⚠️ `correction` 是 `checked`（不是 `immediate`）：它要的不是"就地静音"，
       *    而是一条**过 LG 检查与仲裁**的纠正段（还要先废掉未播余句）。
       *    "immediate" 的含义是"本地就地生效、不必等 LG" —— 那只属于 `stop`。
       */
      urgency: kind === 'stop' ? 'immediate' : 'checked',
    }
  }
  /* 否定 + 裸动词：如实报"否定了"，而不是含混的"没匹配" */
  const bareVerb = negatedBareVerb(text)
  if (bareVerb !== undefined) {
    return { kind: 'none', code: 'signal_stop_negated', matched: bareVerb, urgency: 'none' }
  }
  return { kind: 'none', code: 'signal_no_match', urgency: 'none' }
}

/** 供门与线上排错读的**受控登记表**（唯一答案；加词就是改判据） */
export const FAST_SIGNAL_VOCABULARY = {
  stop: [...STOP_PHRASES],
  /** ⚠️ 裸动词**不可**单独触发；列在这里只为让门看清"否定判定会用到哪些字" */
  bareStopWords: [...BARE_STOP_WORDS],
  wake: [...WAKE_PHRASES],
  /**
   * ⚠️ 判定真正用的是**生成的同音类**（`wake-name-table.ts`，见其 provenance），
   *    不是上面那份字面量表。这里报的是**覆盖规模**，便于一眼看出表是不是空的。
   */
  wakeName: {
    source: WAKE_NAME_TABLE_PROVENANCE.lexicon,
    sha256: WAKE_NAME_TABLE_PROVENANCE.sha256,
    sizes: {
      exact: WAKE_NAME_ORDER.map((key) => (WAKE_NAME_EXACT[key] ?? '').length),
      near: WAKE_NAME_ORDER.map((key) => (WAKE_NAME_NEAR[key] ?? '').length),
    },
  },
  negations: [...NEGATIONS],
  questionTails: [...QUESTION_TAILS],
  questionHeads: [...QUESTION_HEADS],
  politePrefixes: [...POLITE_PREFIXES],
} as const
