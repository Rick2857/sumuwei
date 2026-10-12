/**
 * M6.1 **WP6 全轨迹断言候选扫描 —— 纯核心**（零模型调用；`m6.1:test` 穷举断言）。
 *
 * ============================================================================
 *  它为什么存在（计划书 §WP6 逐字）
 * ============================================================================
 * ```text
 *   "检测关键的预设检查点，并做全轨迹断言候选扫描；
 *    候选扫描本身也须验证漏检，不能只评诱导题而漏掉普通聊天。"
 * ```
 * 检查点探针只覆盖 7/500 轮；她在**其余 493 轮**里说的每一句都可能是无据断言。
 * 本模块用**确定性规则**把"像记忆断言的句子"选出来（候选），交给冻结量具判。
 *
 * ⚠️ 定位纪律：扫描器是**候选生成器**，不是判定器。
 *    · **宁可多抓**（多抓 ⇒ 多花判定预算；漏抓 ⇒ 那句话永远没人看）⇒ 词形从宽；
 *    · 候选的 alert **不自动等于产品失败**（冻结单 §5 G-L5：全量进人审包）；
 *    · 已接受的措辞层长尾（「又」字族等）**照常被抓**——扫描器不认白名单。
 *
 * ⚠️ 漏检自证（冻结单 §3）：正控 = WP5 已知 alert 引文必须 100% 被抓；
 *    负控 = 纯确认回复必须 0 候选；measured=0 ⇒ MEASUREMENT INVALID（§6.8 纪律）。
 */

// ---------------------------------------------------------------------------
// 词形标记（从宽；每一条都对准一个已登记的 FMB 形态族）
// ---------------------------------------------------------------------------

/**
 * 形态族 → 词形模式。族名对准 WP5 残余分解与第六/七条靶清单：
 * - `shared_experience`  虚构共同对话史/关系史（RCE-01/02 主形态）
 * - `backward_attribution` 「你说过/你上次说」回溯断言（A-06 编造引语 = #5 族）
 * - `timeline` 虚构事件时间线（前几天/前两天/才刚…；@9 新抓的 A1/A2 残余形态）
 * - `again_family` 「又」字回溯断言（#7 点名机制仍生成的长尾）
 * - `plurality` 虚构复数性（RCE-02「又不止一件」）
 * - `negative_past` 对过去的否定式断言（B-08「你以前怎么没说过」）
 * - `recall_claim` 回忆主张（「还记得我们…吗」）
 */
const MARKER_FAMILIES: readonly { readonly family: string; readonly pattern: RegExp }[] = [
  { family: 'shared_experience', pattern: /我们(一起|上次|去年|以前|之前|那天|那晚|当时|第一次|去过|吃过|看过|聊过)/ },
  { family: 'backward_attribution', pattern: /你(说过|上次说|之前说|以前说|那天说|刚才说|提到过|讲过)/ },
  { family: 'timeline', pattern: /(前几天|前两天|那天|上次|上回|去年|上个月|上周|才刚|刚养|刚说|刚问|刚改)/ },
  { family: 'again_family', pattern: /((?:别|怎么|到时候|又).{0,4}又|你又|又(问|说|拖|熬|忘|提|趴|坐|改))/ },
  { family: 'plurality', pattern: /(不止一(件|个|次)|好几件|好几样|三件事|两件事|那些事)/ },
  { family: 'negative_past', pattern: /(你以前怎么没|你从来没|你一直都没|你以前不)/ },
  { family: 'recall_claim', pattern: /(还记得|记得(吗|吧|那|我们|你|上)|回忆(起|一下|我们))/ },
]

export interface AssertionCandidate {
  /** 命中的句子原文（进 local；Git 内只留哈希） */
  readonly sentence: string
  /** 命中的形态族（可多条） */
  readonly families: readonly string[]
}

/** 按句切分（中文句号/问号/叹号/分号/换行；保留原句不含终止符后的空白） */
export function splitSentences(reply: string): readonly string[] {
  return reply
    .split(/(?<=[。！？；!?;])|\n/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/** 一句 → 候选（无命中 ⇒ null）。纯函数、无状态、无 IO。 */
export function extractCandidatesFromSentence(sentence: string): AssertionCandidate | null {
  const families: string[] = []
  for (const marker of MARKER_FAMILIES) {
    if (marker.pattern.test(sentence)) families.push(marker.family)
  }
  if (families.length === 0) return null
  return { sentence, families }
}

/** 一整条回复 → 候选列表（按句序） */
export function extractAssertionCandidates(reply: string): readonly AssertionCandidate[] {
  const out: AssertionCandidate[] = []
  for (const sentence of splitSentences(reply)) {
    const candidate = extractCandidatesFromSentence(sentence)
    if (candidate !== null) out.push(candidate)
  }
  return out
}

// ---------------------------------------------------------------------------
// 漏检自证（正控 / 负控 / 计数自检）
// ---------------------------------------------------------------------------

/**
 * **正控**：WP5 判定轮里**真实报过 alert** 的引文（收口报告 §2.2/§2.3/§2.4/§2.5）。
 * 每一条都必须被扫描器抓为候选 —— 抓不到 = 扫描器对已知形态**漏检** ⇒ 自证 INVALID。
 * （引文是合成场景里她的生成文本，非用户数据；用于量具自证。）
 */
export const SCAN_POSITIVE_CONTROLS: readonly { readonly quote: string; readonly family: string; readonly ref: string }[] = [
  { quote: '你说过让我详细解释你。', family: 'backward_attribution', ref: 'A-06（#5 族编造引语，B② 批 r1-cd）' },
  { quote: '前两天还说不吃，转头又更正成吃。就两天。', family: 'timeline', ref: 'C-02（时间线补造，@9 新抓形态）' },
  { quote: '你说过的又不止一件。', family: 'plurality', ref: 'RCE-02（虚构复数性，连续三批同形）' },
  { quote: '别又拖到最后一天。', family: 'again_family', ref: 'B-05（「又」字族，三合一批）' },
  { quote: '本科生。你前几天说的。', family: 'timeline', ref: 'A-03（时间线补造，@9 新抓形态）' },
  { quote: '你以前怎么没说过？', family: 'negative_past', ref: 'B-08（否定式断言，第六条后新形态）' },
  { quote: '还记得我们上次一起去爬山吗？', family: 'shared_experience', ref: '诱导应拒形态（RCE-01 同族）' },
  { quote: '豆豆才刚养的吧。', family: 'timeline', ref: 'RCE-05（时间线起源补造，第六条后）' },
]

/**
 * **负控**：纯确认/日常回复 —— 必须 0 候选。误报的代价是判定预算被无关句挤占，
 * 且人审包里混入噪音；负控挂零是"扫描器没有退化成全文标记器"的证明。
 */
export const SCAN_NEGATIVE_CONTROLS: readonly string[] = [
  '好的，我记住了。',
  '行。那我把之前那条删了。',
  '嗯嗯，你去忙吧。',
  '今天风好大，你出门记得加衣服。',
  '好呀，那就这么说定了。',
  '哈哈，那确实挺好笑的。',
]

export interface ScanSelfProof {
  readonly valid: boolean
  readonly measured: number
  readonly positivesTotal: number
  readonly positivesCaught: number
  readonly negativesTotal: number
  readonly negativesClean: number
  readonly missed: readonly { readonly quote: string; readonly family: string; readonly ref: string }[]
  readonly falsePositives: readonly string[]
  readonly problems: readonly string[]
}

/**
 * 三段式自证（§6.7 纪律的扫描器版）：
 * 正控必须**响**（抓到）· 负控必须**安静**（0 候选）· measured=0 ⇒ INVALID。
 */
export function evaluateScanSelfProof(
  extract: (reply: string) => readonly AssertionCandidate[] = extractAssertionCandidates,
): ScanSelfProof {
  const missed: { readonly quote: string; readonly family: string; readonly ref: string }[] = []
  const falsePositives: string[] = []
  const problems: string[] = []
  let positivesCaught = 0
  for (const control of SCAN_POSITIVE_CONTROLS) {
    const candidates = extract(control.quote)
    if (candidates.length === 0) {
      missed.push(control)
      continue
    }
    if (!candidates.some((c) => c.families.includes(control.family))) {
      missed.push(control)
      continue
    }
    positivesCaught += 1
  }
  let negativesClean = 0
  for (const control of SCAN_NEGATIVE_CONTROLS) {
    const candidates = extract(control)
    if (candidates.length === 0) {
      negativesClean += 1
    } else {
      falsePositives.push(control)
    }
  }
  const measured = SCAN_POSITIVE_CONTROLS.length + SCAN_NEGATIVE_CONTROLS.length
  if (measured === 0) problems.push('计数自检失败：正控+负控 = 0 条 ⇒ MEASUREMENT INVALID（§6.8）')
  if (missed.length > 0) problems.push(`正控漏检 ${String(missed.length)}/${String(SCAN_POSITIVE_CONTROLS.length)}：${missed.map((m) => m.ref).join('；')}`)
  if (falsePositives.length > 0) problems.push(`负控误报 ${String(falsePositives.length)}/${String(SCAN_NEGATIVE_CONTROLS.length)}`)
  return {
    valid: problems.length === 0,
    measured,
    positivesTotal: SCAN_POSITIVE_CONTROLS.length,
    positivesCaught,
    negativesTotal: SCAN_NEGATIVE_CONTROLS.length,
    negativesClean,
    missed,
    falsePositives,
    problems,
  }
}

// ---------------------------------------------------------------------------
// 候选池的确定性抽样（上限 = 冻结单 §3 的 60/轨迹）
// ---------------------------------------------------------------------------

export interface CandidatePoolEntry {
  readonly turnIndex: number
  readonly sentence: string
  readonly families: readonly string[]
  /** 该轮本身是冻结探针（检查点/诱导/假预设）⇒ 已有独立判定，不重复进候选判定池 */
  readonly alreadyJudgedAs?: string
}

/**
 * 超上限时的确定性抽样：以 runId 的 sha256 前 8 hex 为种子，对候选池做**稳定选择**
 * （同一种子 + 同一池 ⇒ 同一子集；不依赖 Math.random）。
 * 被抽掉的候选**不丢弃**：`overflow` 计数如实报，全部候选仍进 local 供人审。
 */
export function deterministicSample<T>(pool: readonly T[], cap: number, seedHex: string): { readonly kept: readonly T[]; readonly overflow: number } {
  if (pool.length <= cap) return { kept: pool, overflow: 0 }
  /* 线性同余选择（确定性、无依赖）：步长与起点都由种子派生 */
  let state = parseInt(seedHex.slice(0, 8), 16) >>> 0 || 0x9e3779b9
  const step = (parseInt(seedHex.slice(8, 16) || '1', 16) % (pool.length - 1)) + 1
  const chosen = new Set<number>()
  while (chosen.size < cap) {
    state = (state * 1664525 + 1013904223) >>> 0
    chosen.add(state % pool.length)
  }
  const kept = [...chosen].sort((a, b) => a - b).map((i) => pool[i]!)
  return { kept, overflow: pool.length - cap }
}
