/**
 * TargetMemoryResolver —— **"用户说的那件事，指的是哪一条记忆？"**（计划书第 57 节）。
 *
 * ============================================================================
 *  计划书第 57 节给了一张明确的优先顺序表
 * ============================================================================
 *     明确 Memory ID
 *     ↓ Canonical key
 *     ↓ same subject + same predicate
 *     ↓ small candidate set
 *     ↓ LLM resolver if necessary
 *
 * 并且给了一句硬约束：
 *
 *     不要对整个 Memory Store 做一次模糊大搜索。那是 M5 的工作。
 *
 * 因此这个文件的每一步都必须**收窄**候选集，而不是扩大：
 *
 *     第 1 步：0 次查询（id 已经是答案）
 *     第 2 步：1 次查询（canonical key 是唯一的槽位键）
 *     第 3 步：1 次查询（subject 上的索引）
 *     第 4 步：只在**已经收窄过的集合**里做词面打分，绝不再去查库
 *     第 5 步：只在候选数 ≤ MAX_MODEL_CANDIDATES 时才允许问模型
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 关键设计：**解析不出来时必须说"解析不出来"**
 * ---------------------------------------------------------------------------
 * 这一层最容易做错的地方不是"找错了"，而是"找不到时随便挑一个"。
 * 一次"随便挑"会把用户的纠正应用到错误的记忆上 ——
 * 于是**正确的**那条还在、**错误的**那条被改得更错，而且全程没有任何信号。
 *
 * 因此 `resolve()` 的返回值是一组互斥的结果，`ambiguous` 与 `not_found`
 * 都是**一等结果**，不是异常、也不是"回落到最近的一条"。
 * 调用方（`ExplicitMemoryService`）必须对它们给出**不同的**用户可见行为。
 */

import {
  KernelError,
  canonicalKeyOf,
  entityLabel,
  type EntityRef,
  type MemoryId,
  type MemoryRecord,
} from '../../contracts/index.ts'
import { lookupPredicate, normalizePredicate } from '../../contracts/memory-predicates.ts'

// ---------------------------------------------------------------------------
// 结果形状
// ---------------------------------------------------------------------------

/**
 * 目标解析的置信度（M4.1 / INV-M41-01：**唯一候选 ≠ 相关候选**）。
 *
 *   exact  —— 调用方给了确定的结构化标识（显式 id / canonical 槽位键）
 *   strong —— 有**词面相关性证据**支撑（相关性命中 / 打分唯一 / 闭集内模型判别）
 *   weak   —— 目前**没有任何路径产出它**（见下）
 *   none   —— 未解析
 *
 * ⚠️ 诚实标注：`weak` 今天**没有生产者**。它的存在不是装饰，而是一个
 * **契约**：将来任何新增的模糊路径必须先声明自己的置信度，
 * 而不是悄悄地把 `resolved` 当成"可以改"。
 * 这与 `MEMORY_MERGED`"接口就位、驱动缺失"是同一类如实记录。
 *
 * M4.1 之前，第 3 步的 `active.length === 1 → resolved` 是这条契约的**反面**：
 * 它把"唯一"当成了"相关"，于是"忘掉鹦鹉"撤掉了"示例工程科技大学"（D1）。
 */
export type MutationConfidence = 'exact' | 'strong' | 'weak' | 'none'

export type TargetResolution =
  /** 唯一确定 */
  | {
      status: 'resolved'
      record: MemoryRecord
      via: ResolutionPath
      candidates: number
      confidence: MutationConfidence
    }
  /** 找到多条、无法判断是哪一条（**必须**报出来，不能挑一条） */
  | { status: 'ambiguous'; candidates: MemoryRecord[]; via: ResolutionPath }
  /** 一条都没找到 */
  | { status: 'not_found'; via: ResolutionPath; triedPaths: ResolutionPath[] }

export type ResolutionPath =
  | 'explicit_id'
  | 'canonical_key'
  /**
   * ⚠️ `subject_predicate` **只作为"尝试过的路径"**出现在 `triedPaths` 里，
   * **不再**是任何一种解析成功的 `via`。
   *
   * M4.1 之前它是"该 subject 下只有一条 active 就取它"的那条捷径的 via ——
   * 也就是 D1 本身。保留这个标签是为了让 `not_found` 的
   * "最后尝试的路径"仍然可读（"我们查了该 subject 的索引，没有相关命中"）。
   */
  | 'subject_predicate'
  | 'relevance_match'
  | 'hint_scoring'
  | 'model_resolver'

/**
 * **Mutation Gate**（INV-M41-02：宁可不改，也不能猜着改）。
 *
 * 所有 destructive 操作（forget / retract / update / correction / restore / merge）
 * 都必须先过这一关：只有 `resolved` **且** 置信度是 `exact` / `strong` 才允许改动。
 *
 * `ambiguous` / `not_found` / `weak` / `none` 一律 `false`。
 */
export function mayMutate(resolution: TargetResolution): boolean {
  return (
    resolution.status === 'resolved' &&
    (resolution.confidence === 'exact' || resolution.confidence === 'strong')
  )
}

/** 允许送去模型的候选数上限（计划书第 57 节："small candidate set"） */
export const MAX_MODEL_CANDIDATES = 5

/** 允许直接返回的候选数上限（超过就必须报 ambiguous 或先打分收窄） */
export const MAX_UNIQUE_CANDIDATES = 1

// ---------------------------------------------------------------------------
// 依赖（全部是**只读**的窄口）
// ---------------------------------------------------------------------------

export interface TargetResolverDeps {
  /** 按 id 取（第 1 步） */
  get(id: MemoryId): Promise<MemoryRecord | null>
  /** 按 canonical key 取 ACTIVE 的那些（第 2 步） */
  getActiveByCanonicalKey(key: string): Promise<MemoryRecord[]>
  /** 按 subject 取（第 3 步） */
  listBySubject(owner: EntityRef, subject: EntityRef): Promise<MemoryRecord[]>
  /**
   * 可选：小候选集内的语义判别（第 5 步）。
   *
   * 缺省不提供 —— 那意味着"多条候选时报 ambiguous"，
   * 而这是一个**安全的**缺省：报 ambiguous 让人去管，
   * 猜错则是一次不可见的错误写入。
   */
  semanticJudge?: SemanticJudgePort
}

/**
 * 小候选集内的语义判别器。
 *
 * 与 `MemoryIntentClassifierPort` 同一个设计理由：可注入，
 * 因此离线段不需要 API Key，而判断逻辑仍只有一份。
 */
export interface SemanticJudgePort {
  readonly name: string
  /**
   * 在这些候选里挑出用户指的那一条。
   *
   * 返回 `undefined` 表示**判不出来** —— 与"没有意图"一样，
   * 这是一个正常结果，而不是失败。
   */
  choose(input: {
    text: string
    candidates: readonly MemoryRecord[]
  }): Promise<{ memoryId: MemoryId; reason: string } | undefined>
}

/**
 * 生产用的判别器：把小候选集交给模型，但**把输出关进闭集**。
 *
 * ============================================================================
 *  计划书第 57 节的第 5 级本来就允许它
 * ============================================================================
 * 计划书原文：
 *
 *     ↓ small candidate set
 *     ↓ LLM resolver if necessary
 *
 * 两个前置条件都由 `createTargetMemoryResolver` 保证：
 *   · 候选数 ≤ `MAX_MODEL_CANDIDATES`（5），因此这次调用是**有界的**
 *   · 只在第 4 步打分仍然分不出胜负时才调用，因此它**不是**每条消息的固定开销
 *
 * ⚠️ 模型只能返回候选集里的 id。返回别的值 → 抛错（不是"当作没判出来"）：
 * 那意味着它没有在选择，而是在**发明**一条记忆，而"凭空决定一条记忆"
 * 正是这个文件开头警告的那件事。
 */
export class LlmSemanticJudge implements SemanticJudgePort {
  readonly name = 'llm-semantic-judge'

  private readonly invokeModel: (prompt: string) => Promise<string>

  constructor(deps: { invokeModel: (prompt: string) => Promise<string> }) {
    this.invokeModel = deps.invokeModel
  }

  async choose(input: {
    text: string
    candidates: readonly MemoryRecord[]
  }): Promise<{ memoryId: MemoryId; reason: string } | undefined> {
    const lines = input.candidates.map((record, index) => {
      const value =
        record.content.kind === 'claim'
          ? `${record.content.predicate} = ${String(record.content.value)}`
          : record.content.summary
      return `${index + 1}. ${value}`
    })

    const prompt = [
      '用户在说一件关于自己的事，下面是他可能指的那几条已有记忆。',
      '请选出他指的那一条。',
      '',
      '只输出那个编号（数字），或者输出 0 表示判不出来。不要解释。',
      '',
      `用户的话：${input.text}`,
      '',
      '已有记忆：',
      ...lines,
    ].join('\n')

    let raw: string
    try {
      raw = await this.invokeModel(prompt)
    } catch (error) {
      /*
       * 判别失败 → **当作判不出来**，向上报 ambiguous。
       *
       * 这里可以吞的理由与意图分类器一致：这次失败不该影响聊天，
       * 而代价是"如实报歧义"（用户被追问一次），不是"改错记忆"。
       * 反过来，若在这里 Throwing，一次模型超时就会让整个
       * "忘掉"操作变成一次异常，而那是更差的用户体验。
       */
      if (process.env.M4_DEBUG_MEMORY === '1') {
        console.warn('[m4] semantic judge swallowed error:', error)
      }
      return undefined
    }

    const chosen = parseChoiceIndex(raw, input.candidates.length)
    if (chosen === undefined) return undefined

    const record = input.candidates[chosen]
    return { memoryId: record.id, reason: `模型在第 ${chosen + 1} 条候选里选中` }
  }
}

// ---------------------------------------------------------------------------
// 词面相关性（M4.1 的相关性闸；`LexicalSemanticJudge` 与第 3 步共用同一份实现）
// ---------------------------------------------------------------------------

/**
 * 把一句话切成"可能被提到的片段"。
 *
 *   · **CJK 连续段** → **三字片段（trigram）**。中文没有空格，三字片段既能匹配
 *     「示例工程科技大学」里的「本科在」这类实质重合，又**不再**把
 *     「她念过一首诗」与「她念的是哪所学校」之间那个 **2 字的偶然重叠**算成命中
 *   · **拉丁字母/数字连续段** → **整段**（≥2 字符），**不**切 trigram。
 *     切了会得到 `od` 这种片段，而它出现在 `food` 里 ——
 *     于是"忘掉我用 Code"会莫名其妙地命中一条 food 记忆
 *
 * 长度 1 的孤立片段（前后被标点隔开）保留：它是一次真实的话题重合。
 * 长度 2 的 CJK 段**整段保留**（切不出 trigram）。
 *
 * ============================================================================
 *  ⚠️ **M9.5 / `D-5`：2 字 → 3 字**（`ADR-084`，**冻结区语义变更**，用户 2026-10-01 同意）
 * ============================================================================
 * ```text
 * 为什么改：2 字粒度下，"**偶然重叠**"与"**实质命中**"**同为 2 字** ⇒ 无法区分 ⇒
 *   `D-5` 的 A1（词面命中要压过语义 0.99 诱饵）与 A5（改述不能被弱重叠压过）**无交集** ✗
 * 3 字实测（假设对照 → 现在成为**系统行为**）：
 *   A1 目标 0.000→**1.000** · A4 无关项 1.000→**0.000** · A5 噪声 1.000→**0.000** ✓
 * ⚠️ **代价（如实登记）**："命中"变**严** ⇒ **召回面收窄** ⇒ 由 `memory-coverage:verify`
 *    给出"哪些原本能召回的话召不回了"的前后对照 ✓（那是本改动的**主证据**）
 * ⚠️ 它**同时**改变 `lexicalOverlapHits` 与 `lexicalOverlapStrength`（同源 ✓）
 * ```
 */
export function lexicalFragments(text: string): string[] {
  const out = new Set<string>()
  for (const match of text.toLowerCase().matchAll(/[\p{Script=Han}]+|[a-z0-9]+/gu)) {
    const chunk = match[0]
    if (/^[\p{Script=Han}]+$/u.test(chunk)) {
      if (chunk.length === 1) out.add(chunk)
      /* ⚠️ 长度 2 的 CJK 段整段保留（切不出 trigram ⇒ 不许静默丢掉它） */
      else if (chunk.length === 2) out.add(chunk)
      for (let i = 0; i + 2 < chunk.length; i += 1) out.add(chunk.slice(i, i + 3))
    } else if (chunk.length >= 2) {
      out.add(chunk)
    }
  }
  return [...out]
}

/**
 * 一条记录的"可被词面命中的文本"。
 *
 * ============================================================================
 *  ⚠️ M4.1 修：**必须把登记表里的中文说法也算进来**
 * ============================================================================
 * 第一版只用了 `predicate + value`，于是出现了这个缺陷：
 *
 *     用户说「忘掉我不吃香菜这件事」
 *     记录是 `food.preference.cilantro = dislike`
 *     → haystack 里**没有"香菜"这两个字**（它只存在于英文键 `cilantro`
 *       与登记表的中文说明里）
 *     → 相关性闸判成"零命中" → `not_found`
 *     → **用户明确要求忘掉的那条，系统说找不到**
 *
 * 这个缺陷是 **Layer D（真实多轮冒烟）** 抓到的：当时离线的 Layer A/B/C
 * 用的夹具恰好都是"值里含中文"的形状（示例工程科技大学 / VS Code），
 * 所以三道离线门全绿 —— **又一次证明"部件全绿 ≠ 装起来可用"**。
 *
 * 修法用的是本项目自己的教条（`memory-predicates.ts` 的原文）：
 *
 *     同义词归并的正确位置是**登记表**
 *
 * 因此把登记项的 `description` 与 `examples` 一并算进 haystack ——
 * 那正是"中文说法 → 槽位键"的映射所在，而不是在这里再写一张对照表。
 */
function relevanceHaystack(record: MemoryRecord, includeRegistry: boolean): string {
  const parts: string[] = []

  if (record.content.kind === 'claim') {
    parts.push(record.content.predicate, String(record.content.value))
    if (includeRegistry) {
      const lookup = lookupPredicate(record.content.predicate)
      if (lookup.spec !== undefined) {
        parts.push(lookup.spec.description, ...lookup.spec.examples)
        /*
         * M6.1 WP5 / B② / ADR-059：**已证实问法**同样是可搜索表面。
         *
         * 为什么必须进这里：词面闸问的是"用户那句话的 2 字片段是否出现在候选的可搜索文本里"，
         * 而冻结条文的两条问句（「我现在在写什么？」）与该槽位的说明/例子**零重叠** ⇒
         * 一条**存在且合格**的记忆被判 `LOW_RELEVANCE`、进不了上下文（四轮实测）。
         * `surfaceForms` 是登记表里的**数据**（逐条登记、可审计），不是同义词词典；
         * `minTotal` 没动、语义通道也没加（既有裁定：M4 无嵌入列）。
         */
        parts.push(...(lookup.spec.surfaceForms ?? []))
      }
    }
  } else {
    parts.push(record.content.summary, ...(record.content.topicTags ?? []))
  }

  return parts.join(' ').toLowerCase()
}

/**
 * **词面相关性匹配**（M4.1 / INV-M41-01 的落地）。
 *
 * 判据：用户那句话的**任意一个片段**出现在某条记录的谓词或取值里 →
 * 那条记录算"相关"。零命中就是零命中。
 *
 * ⚠️ 它与 `scoreByHints` 的分工必须说清，混用会**修不动 D1**：
 *
 *   · `scoreByHints` 回答"**哪一条更像**"（相对排序）——
 *     而它在一分都没打上时会**返回全部候选**（刻意的，让上层报 ambiguous）。
 *     于是单条无关候选在那里得到的是 `[那一条]`，"长度 1"又被读成唯一命中。
 *   · 本函数回答"**有没有相关性证据**"（绝对存在性）。零命中 → 空数组。
 *
 * D1 的根因正是把前者当成了后者。
 */
export function lexicalOverlapHits(
  text: string,
  candidates: readonly MemoryRecord[],
  options: {
    /**
     * 是否把登记表里的中文说法（`description` / `examples`）算进候选的文本。
     *
     * ========================================================================
     *  ⚠️ 两个调用方**刻意用不同的值**，因为它们的任务不同
     * ========================================================================
     *   · **相关性闸**（第 3 步）：`true` —— 要的是**召回**。
     *     "忘掉我不吃香菜这件事"必须能对上 `food.preference.cilantro`，
     *     而"香菜"只存在于登记表里（不在英文键或 value 里）。
     *
     *   · **词面判别器**（第 5 步，`LexicalSemanticJudge`）：`false` —— 要的是**精度**。
     *     它的职责是"在多条候选里挑出唯一那条"，因此只能依据**记录自己的内容**。
     *     把登记表算进来会让"同一批登记描述里都有某个词"的多条候选同时命中，
     *     判别器于是**总是弃权**（虽然安全，但等于这一步失效）。
     */
    includeRegistrySurfaceForms?: boolean
  } = {}
): MemoryRecord[] {
  const fragments = lexicalFragments(text)
  if (fragments.length === 0) return []
  const includeRegistry = options.includeRegistrySurfaceForms ?? true
  return candidates.filter((record) => {
    const haystack = relevanceHaystack(record, includeRegistry)
    return fragments.some((fragment) => haystack.includes(fragment))
  })
}

/**
 * **词面覆盖强度**（M9.5 / `D-5`，`ADR-083`）—— `0..1`，**与"命中与否"同源**。
 *
 * ```text
 * 判据（逐字与 `lexicalOverlapHits` 同一份实现）：命中 = 该片段出现在 `relevanceHaystack` 里
 *   强度 = **命中的片段数 / 片段总数**（片段来自同一个 `lexicalFragments(text)`）
 * ⇒ 于是"判为命中"与"强度 > 0"**必然一致**（不会出现"命中但强度 0"的自相矛盾）✓
 * ```
 *
 * ⚠️ **为什么要它**（用户 2026-10-01 裁定 **(乙)**）：词面通道原来是**二值**，
 *    于是"精确命中"与"偶然弱重叠"分数**完全一样** ⇒ 提高词面权重会同时抬高两者 ⇒
 *    `A1`（要压过语义 0.99 诱饵）与 `A5`（改述不能被弱重叠压过）**无交集**。
 *    带强度后两者可分（实测：最小达标权重 **1.5**，且 A5 不再牺牲）。
 * ⚠️ **本函数只回答"像不像"**，不改"谁进索引"（那是资格政策的事，`ADR-081`）。
 */
export function lexicalOverlapStrength(
  text: string,
  record: MemoryRecord,
  options: { includeRegistrySurfaceForms?: boolean } = {}
): number {
  const fragments = lexicalFragments(text)
  if (fragments.length === 0) return 0
  const haystack = relevanceHaystack(record, options.includeRegistrySurfaceForms ?? true)
  const matched = fragments.filter((fragment) => haystack.includes(fragment))
  if (matched.length === 0) return 0
  /*
   * ★ **定义（用户 2026-10-01 裁定 `(戊)`）**：**最长命中片段长度 / 最长查询片段长度**。
   *
   * ```text
   * 为什么不用"命中数/总数"（原定义）：`lexicalFragments` 给的是**逐字 2 字滑窗**
   *   ⇒ 分母里混进了跨词边界的片段（`我本`/`科在`/`哪读`）⇒ 真实精确命中也只能中一半
   *   ⇒ 实测上限被压到 **0.5** ⇒ 词面权重那个杠杆只有一半强。
   * 本定义：**只看最长的那一处匹配** ⇒ 精确命中可到 1.0 ✓（无新依赖、不碰 `lexicalFragments`）
   * ```
   *
   * ⚠️ **已知代价（如实登记，未粉饰）**：它**忽略"多处命中"**，而且
   *    **一个 2 字的偶然重叠与一个 2 字的实质命中同分** ⇒ 语料的 `A5`（改述 vs 弱重叠噪声）
   *    预期会**红**（噪声"她念"命中 2/2 = 1.0）⇒ 由扫描器读数**证实或推翻**，不在这里预设结论。
   * ⚠️ **同源不变**：仍用同一个 `fragments` + 同一个 `relevanceHaystack`
   *    ⇒ "强度 > 0" ⇔ "在 `lexicalOverlapHits` 里" ✓（判据已加进 `m9.5:test`）。
   */
  const longestQuery = Math.max(...fragments.map((fragment) => fragment.length))
  const longestMatch = Math.max(...matched.map((fragment) => fragment.length))
  return longestMatch / longestQuery
}

/**
 * 离线 / CI 用的判别器：**只做词面包含**，永远不调模型。
 *
 * ============================================================================
 *  它为什么不是"一个没用的桩"
 * ============================================================================
 * 它把"这条路径在 CI 里不依赖模型"变成**装配层的一个选择**，
 * 而不是一句文档承诺（与 `RuleOnlyMemoryIntentClassifier` 同一个理由）。
 *
 * 它的判据刻意做得**很迟钝**：只在"用户那句话里的某个 2 字以上片段
 * 出现在候选的内容里"时才选中，且**有且只有一条**候选被命中时才返回。
 * 两条都命中 → 判不出来（返回 undefined）→ 上层报 ambiguous。
 *
 * 换成一个"随便挑第一条"的桩会让测试永远绿，而那是**假的绿色**
 * （见 `kernel-tests-memory.ts` 里"只测桩的测试会给出假的绿色"那条注释）。
 */
export class LexicalSemanticJudge implements SemanticJudgePort {
  readonly name = 'lexical-semantic-judge'

  async choose(input: {
    text: string
    candidates: readonly MemoryRecord[]
  }): Promise<{ memoryId: MemoryId; reason: string } | undefined> {
    /*
     * M4.1：改用与第 3 步**同一份**实现（`lexicalOverlapHits`）。
     *
     * 之前这里自己写了一遍切片逻辑 —— 于是"什么算词面命中"有**两个实现**，
     * 而两个实现迟早会漂移。现在只有一个实现、两种配置。
     *
     * ⚠️ 这里刻意 `includeRegistrySurfaceForms: false`：
     *    判别器要的是**精度**（在候选里挑唯一那条），只能依据记录自己的内容。
     *    详见该选项的说明。
     */
    const hits = lexicalOverlapHits(input.text, input.candidates, {
      includeRegistrySurfaceForms: false,
    })

    if (hits.length !== 1) return undefined
    return { memoryId: hits[0].id, reason: '词面唯一命中' }
  }
}

/**
 * 解析模型输出的编号（1-based）。越界、非数字、0、负数 → `undefined`（判不出来）。
 *
 * ⚠️ 正则必须**带可选负号**（`-?\d+`）。
 *
 * 实测踩到过：第一版写的是 `/\d+/`，于是 `'-1'` 被抠出 `'1'` →
 * 解析成"选了第 1 条"。也就是说**模型明确说"不是"时，代码读成了"是"**。
 * 这类"否定被读成肯定"的缺陷与 `intent-detector` 里
 * "不要再记"被读成"记住"是同一个形状，而且同样不报错。
 */
export function parseChoiceIndex(raw: string, candidateCount: number): number | undefined {
  const match = /-?\d+/.exec(raw)
  if (match === null) return undefined
  const n = Number(match[0])
  if (!Number.isSafeInteger(n) || n <= 0) return undefined
  if (n > candidateCount) return undefined
  return n - 1
}

export interface TargetResolverRequest {
  owner: EntityRef
  /** 用户那句话（原始措辞，进打分与 judge） */
  text: string
  /** 用户**显式**给出的 id（"忘掉 mem:char_sumuwei:xyz"这种罕见但存在的情况） */
  explicitId?: MemoryId
  /**
   * 调用方已经能确定的 canonical key。
   *
   * 什么时候会给它：显式路径在**同一轮**刚建立/刚看到过那条记忆
   * （例如"记住，我不吃香菜" → 紧接着"改成我现在能吃了"），
   * 那时槽位键已经在手上，不必再做一轮模糊匹配。
   */
  canonicalKey?: string
  /** 已经确定的 subject（通常是从事件解析出的用户） */
  subject?: EntityRef
  /** 目标提示词（由 `targetHintsFrom()` 产出） */
  hints?: readonly string[]
}

export interface TargetMemoryResolver {
  resolve(request: TargetResolverRequest): Promise<TargetResolution>
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

export function createTargetMemoryResolver(deps: TargetResolverDeps): TargetMemoryResolver {
  return {
    async resolve(request): Promise<TargetResolution> {
      const tried: ResolutionPath[] = []

      // ---------------------------------------------------------------------
      // 第 1 步：明确 Memory ID（0 次查询之外的查询，最可靠）
      // ---------------------------------------------------------------------
      if (request.explicitId !== undefined) {
        tried.push('explicit_id')
        const record = await deps.get(request.explicitId)
        if (record !== null) {
          if (!isOwnedBy(record, request.owner)) {
            // 找到了但**不属于这个 owner** —— 这必须是一次显式失败，
            // 而不是"没找到"。前者说明调用方传错了 id，后者说明记忆不存在。
            throw new KernelError(
              'validation_error',
              'target_owner_mismatch',
              `记忆 ${String(record.id)} 的 owner 是 ${entityLabel(record.owner)}，` +
                `而本次操作的 owner 是 ${entityLabel(request.owner)}（Memory Space 隔离）`,
              { memoryId: String(record.id), owner: entityLabel(request.owner) }
            )
          }
          return { status: 'resolved', record, via: 'explicit_id', candidates: 1, confidence: 'exact' }
        }
        // 显式 id 找不到 → **不继续往下猜**。
        // 用户/调用方明确给了一个 id 而它不存在，这是一个需要被看见的事实，
        // 而不是"那我们帮你找一条像的"。继续往下猜正是"随便挑一个"的变体。
        return { status: 'not_found', via: 'explicit_id', triedPaths: tried }
      }

      // ---------------------------------------------------------------------
      // 第 2 步：canonical key（唯一槽位键）
      // ---------------------------------------------------------------------
      if (request.canonicalKey !== undefined && request.canonicalKey.trim() !== '') {
        tried.push('canonical_key')
        const records = await deps.getActiveByCanonicalKey(request.canonicalKey)
        const owned = records.filter((r) => isOwnedBy(r, request.owner))
        if (owned.length === 1) {
          return { status: 'resolved', record: owned[0], via: 'canonical_key', candidates: 1, confidence: 'exact' }
        }
        if (owned.length > 1) {
          // 同一个槽位有多条 ACTIVE —— 这本身是一个**需要被看见的健康问题**
          // （正常流程下 supersede 会让旧条离开 active）。因此报 ambiguous 而不是挑一条。
          return { status: 'ambiguous', candidates: owned, via: 'canonical_key' }
        }
      }

      // ---------------------------------------------------------------------
      // 第 3 步：same subject **+ 相关性闸**（M4.1 的 D1 修复点）
      // ---------------------------------------------------------------------
      /*
       * ============================================================================
       *  ⚠️ M4.1 之前这里是：`if (active.length === 1) return resolved`
       * ============================================================================
       * 那等于**用"唯一"替代"相关"**：
       *
       *     用户说"忘掉我养过一只鹦鹉这件事"
       *     库里唯一 active 是 education.institution = 示例工程科技大学
       *     → 候选数为 1 → 判定为"唯一命中" → 把示科那条撤了（S1 = D1）
       *
       * 现在流程是：先取候选（只有一次查询），再做**相关性判定**，
       * 最后才决定 resolved / not_found。候选数**不再**参与判定。
       *
       * 相关性用的是 `lexicalOverlapHits`（与离线语义判别器**同一份**实现）。
       * 它的判据是绝对存在性：用户那句话的任一片段出现在候选的谓词/取值里。
       *
       * 为什么换掉 `scoreByHints`：它在**一条都没打上分时返回全部候选**
       * （刻意的，让上层报 ambiguous）。单条无关候选在那里会得到 `[那一条]`，
       * 于是"长度 1"又被读成唯一命中 —— **修不动 D1**。
       */
      if (request.subject !== undefined) {
        tried.push('subject_predicate')
        const records = await deps.listBySubject(request.owner, request.subject)
        const active = records.filter((r) => r.status === 'active')

        const relevant = lexicalOverlapHits(request.text, active)

        if (relevant.length === 1) {
          return {
            status: 'resolved',
            record: relevant[0],
            via: 'relevance_match',
            candidates: 1,
            confidence: 'strong',
          }
        }

        if (relevant.length > 1) {
          // 第 4 步：只在**已经收窄过的**集合里打分（绝不再查库）
          tried.push('hint_scoring')
          const scored = scoreByHints(relevant, request.hints ?? [], request.text)

          if (scored.length === 1) {
            return {
              status: 'resolved',
              record: scored[0],
              via: 'hint_scoring',
              candidates: 1,
              confidence: 'strong',
            }
          }

          const top = scored.slice(0, MAX_MODEL_CANDIDATES)

          // 第 5 步：小候选集内允许问一次模型。
          //
          // ⚠️ M4.1 起它**只在相关性已经收窄之后**才被调用 ——
          //    因此模型是在"多条都相关、分不出是哪一条"里选，
          //    而不是在"整个 subject 的全部记忆"里选。
          //    这正是 `LlmSemanticJudge` 的注释里说的"把输出关进闭集"的前提。
          if (deps.semanticJudge !== undefined && top.length <= MAX_MODEL_CANDIDATES) {
            tried.push('model_resolver')
            const picked = await deps.semanticJudge.choose({ text: request.text, candidates: top })
            if (picked !== undefined) {
              const found = top.find((r) => String(r.id) === String(picked.memoryId))
              if (found !== undefined) {
                return {
                  status: 'resolved',
                  record: found,
                  via: 'model_resolver',
                  candidates: top.length,
                  confidence: 'strong',
                }
              }
              // 模型给了一个不在候选集里的 id —— **不接受**。
              // 这正是"把模型输出关进闭集"：它只能在给定的这几个里选。
              throw new KernelError(
                'validation_error',
                'semantic_judge_out_of_candidates',
                `语义判别器返回了不在候选集里的 memoryId（${String(picked.memoryId)}）：` +
                  '判别器只能在给定的候选里选，越界的选择等于让它凭空决定一条记忆',
                { memoryId: String(picked.memoryId), candidates: top.map((r) => String(r.id)) }
              )
            }
          }

          // 判不出来 → **报 ambiguous**，不挑一条
          return { status: 'ambiguous', candidates: top, via: 'hint_scoring' }
        }
      }

      // ---------------------------------------------------------------------
      // 什么线索都没有，或者线索都用完了
      // ---------------------------------------------------------------------
      return {
        status: 'not_found',
        via: tried[tried.length - 1] ?? 'subject_predicate',
        triedPaths: tried,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 打分（纯函数，可单测）
// ---------------------------------------------------------------------------

/**
 * 按提示词给候选打分，返回**降序**列表。
 *
 * ============================================================================
 *  打分故意做得"迟钝"
 * ============================================================================
 * 它只做两件确定性的事：
 *   ① `predicate` 的**末段**匹配提示词（"food.preference.cilantro" 对 "香菜" 不匹配，
 *      但对提示里出现 "cilantro" 就匹配）
 *   ② `content` 的**序列化文本**包含提示词
 *
 * **不做**同义词、不做翻译、不做词干化 —— 那些需要词表，
 * 而"任何一张手工词表都会在某天漏一个分支"（`entity.ts` 的同一条理由）。
 *
 * ⚠️ 一个必须说清的后果：**中文用户说"香菜"时，predicate
 * `food.preference.cilantro` 是英文的，因此打分为 0。**
 * 这意味着"忘掉我关于香菜的偏好"在只有 hints 的情况下会走到 ambiguous。
 *
 * 这不是缺陷，而是**边界**：把中文"香菜"映射到 `cilantro` 需要词表或模型，
 * 而计划书第 57 节把那一级明确交给了 LLM resolver。
 * M4 的正确行为是**报 ambiguous 并让人看见**，
 * 而不是悄悄挑一条（那正是这个文件开头警告的那件事）。
 * 真正的解法是显式路径**携带 canonical key**（第 2 步），
 * 而那要求用户那句话说出了槽位 —— 或者由 §Phase 4 的服务层
 * 在同一轮内把刚建立的记忆的 key 带上。
 */
export function scoreByHints(
  candidates: readonly MemoryRecord[],
  hints: readonly string[],
  text: string
): MemoryRecord[] {
  const normalizedHints = hints.map((h) => h.toLowerCase()).filter((h) => h.trim() !== '')
  const haystackText = text.toLowerCase()

  const scored = candidates.map((record) => {
    let score = 0

    if (record.canonicalKey !== undefined) {
      // predicate 的末段（"cilantro"）与小段（"preference.cilantro"）都算
      const predicate =
        record.content.kind === 'claim' ? normalizePredicate(record.content.predicate) : ''
      const segments = predicate.split('.').filter((s) => s !== '')
      for (const hint of normalizedHints) {
        if (segments.includes(hint)) score += 3
        else if (segments.some((s) => s.includes(hint))) score += 2
      }
    }

    // 内容文本包含提示词（Episode 的 summary、Claim 的 value）
    const contentText = serializedContent(record).toLowerCase()
    for (const hint of normalizedHints) {
      if (contentText.includes(hint)) score += 2
    }

    // 用户那句话整体在内容里出现（"我记得你说过 XX" 里 XX 原样出现）
    if (haystackText.length >= 4 && contentText.includes(haystackText)) score += 5

    return { record, score }
  })

  const positive = scored.filter((s) => s.score > 0)
  if (positive.length === 0) {
    // 一条都没打上分 → **返回全部候选**（让上层报 ambiguous），
    // 而不是返回空数组（那会被上层读成 not_found，而两者是不同的处境）
    return [...candidates]
  }

  positive.sort((a, b) => b.score - a.score)
  const best = positive[0].score
  // 只保留并列最高的那些：第二名明显低时不把它算进"并列"
  return positive.filter((s) => s.score === best).map((s) => s.record)
}

function serializedContent(record: MemoryRecord): string {
  if (record.content.kind === 'claim') {
    return `${String(record.content.value)} ${record.content.predicate}`
  }
  return `${record.content.summary} ${(record.content.topicTags ?? []).join(' ')}`
}

function isOwnedBy(record: MemoryRecord, owner: EntityRef): boolean {
  return record.owner.kind === owner.kind && String(record.owner.id) === String(owner.id)
}

/**
 * 便捷：由一条记录算出它的槽位键（供服务层在"刚建立了一条"时缓存）。
 *
 * 单独导出而不是让调用方自己拼 `canonicalKeyOf`：
 * 参数形状（owner + type + content）容易被拼错，而拼错的后果是
 * "第 2 步永远查不到"，于是每次都退化成模糊匹配 —— 一个**静默**的降级。
 */
export function canonicalKeyOfRecord(record: MemoryRecord): string | undefined {
  return canonicalKeyOf({ owner: record.owner, type: record.type, content: record.content })
}
