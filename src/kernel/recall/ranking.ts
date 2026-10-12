/**
 * M5 WP4 —— **Ranking / Conflict / Dedup**。
 *
 * ============================================================================
 *  计划书对它的要求只有三条，但三条都很硬
 * ============================================================================
 *     Score 必须：**可解释** · **可测试** · **可配置**
 *     避免：隐藏在 Prompt 中让 LLM 自己选
 *
 * 因此这里是一个**纯函数**排序器：没有 LLM、没有时间（`now` 由调用方注入）、
 * 没有随机。同样的输入永远给同样的输出，而且**每个因子的分数都留在
 * `RecallScoreBreakdown` 里**（AT4.5）—— 于是"她为什么先想起这条"可以逐项回答，
 * 而不是"模型觉得这条更相关"。
 *
 * ---------------------------------------------------------------------------
 *  三条纪律
 * ---------------------------------------------------------------------------
 * 1. **不得伪造数据**（计划书 WP4 原文：允许部分因素暂时为 not available）。
 *    语义相关性今天**不可用**（M4 没有嵌入列，计划书禁止引入向量库）；
 *    它进 breakdown 时是 `available: false` + 原因，**不是 0 分**。
 *    "0 分"会被读成"这一维真的很低"，而"缺维度"是另一件事 ——
 *    两者的修法完全不同（补能力 vs 调权重）。
 *
 * 2. **只对通过资格的那一批排序**（WP2/WP3 的前置）。
 *    对全部候选排序再过滤，等于把 P0 层架空。
 *
 * 3. **冲突由数据决定，不由模型决定**（AT4.4）。
 *    同一个槽位（`canonicalKey`）上的多条记忆构成一个"冲突组"：
 *      · 问"现在" → 只留当前的（历史条在资格层已经出局）
 *      · 问"以前" → 允许保留一条历史 + 当前的（`maxPerSlot`）
 *    这个规则写在策略里，可配置、可测试。
 */

import {
  authorityRank,
  slotOfRecord,
  type MemoryAuthority,
} from '../contracts/memory.ts'
import { qualificationPenalizesAuthority } from './qualification.ts'
import {
  assertRecallDecision,
  defaultSemanticModeFor,
  type RecallCandidate,
  type RecallDecision,
  type RecallExclusionReason,
  type RecallRequest,
  type RecallScoreBreakdown,
  type RecallScoreComponent,
} from '../contracts/recall.ts'
import { isWithinTimeScope, type MemoryRetrievalCapabilities } from './ports.ts'

// ---------------------------------------------------------------------------
// 策略（可配置 = 计划书的第三条）
// ---------------------------------------------------------------------------

export interface RecallRankingWeights {
  lexical: number
  /** 仅 on 模式计入最终排序；未声明的历史策略仍取 0。 */
  semantic?: number
  entity: number
  temporal: number
  salience: number
  authority: number
  intentFit: number
}

export interface RecallRankingPolicy {
  /** ADR-123: relevance must come from semantic scores, without target/lexical shortcuts. */
  semanticOnly?: boolean
  weights: RecallRankingWeights
  /**
   * 是否要求"有相关性证据"（**绝对存在性**，缺省 true）。
   *
   * 这是 M4.1 那条修的召回侧对偶。M4.1 的原话（`target-resolver.ts:312-326`）：
   *
   *     判据：用户那句话的任意一个片段出现在某条记录的谓词或取值里 → 相关。
   *     **零命中就是零命中。**
   *
   * 为什么它必须存在：用户 2026-09-17 对 G3 的裁定写着 ——
   * "**没有任何当前机制能建立 relevance 的未登记事实，不得为了满足 Recall
   * 强行选出来**"。而"只靠 entity/temporal/salience/authority"打出来的分
   * 是**人人都有**的分：它衡量的是"这条记忆重不重要"，不是"它和这句话有没有关系"。
   * 没有这道闸，任何一条记忆都能靠 salience 混进上下文 ——
   * 那正是"为了满足召回而硬取一条差不多的"。
   *
   * 关掉它（false）只用于对照实验：让"不设闸会怎样"可被测量。
   */
  requireRelevanceEvidence: boolean
  /**
   * **经历类记忆（`episode` / `self_experience`）的显式召回路径**（后 Lv2 · `S7`）。
   *
   * ============================================================================
   *  它解决什么，以及它**不**推翻什么
   * ============================================================================
   * `ADR-084`（M9.5 `D-5`，用户 2026-10-01 同意）把中文片段从 **2 字改成 3 字**，
   * 换来精度（A1/A4/A5 三锚点全绿），**并如实登记了代价：命中变严 ⇒ 召回面收窄**。
   *
   * 实测到的那个代价（后 Lv2 R19）：
   * ```text
   *   记忆：「我们一起准备极创工作室的二面……我们约好二面聊项目」
   *   问句：「对了，我们之前是不是聊过我找工作的事？」
   *   问句片段：我们之 / 们之前 / … （**三字**）
   *   记忆里是：我们一起 / 我们约好 ⇒ **零共同三字片段**
   *   ⇒ 相关性闸零命中 ⇒ 连打分都没到就被丢
   * ```
   * ⚠️ 关键：这时 `lexicalOverlapStrength` **也是 0**（同源）⇒
   *    **"放宽阈值"救不了它**，只能换一条**不依赖词面**的路。
   *
   * 本开关就是那条路，且**只对经历类开放**：
   * ```text
   *   声明类（person_fact / preference …）→ 仍需词面或 target 证据（**一字不改**）
   *   经历类（episode / self_experience）→ 改由**它自己的总分**过闸（`minTotal` 照旧）
   * ```
   * ⚠️ **不推翻 ADR-084**：片段粒度（trigram）、`lexicalOverlapHits`、
   *    `lexicalOverlapStrength`、`minTotal` **全部未动**。
   *    改的只是"**经历类**必须拿到词面证据才算相关"这一条。
   *
   * ⚠️ 为什么经历类可以不同：G3 的裁定逐字是"**没有任何当前机制能建立 relevance
   *    的未登记事实**，不得强行选出来"。而一条经历记忆**不需要**靠词面与当前问句
   *    建立关系 —— 它由 `recency` + `subject` 两个**真实通道**命中，
   *    并且它答的是"我们之间发生过什么"，不是"这个词在不在库里"。
   *    但**"重不重要"仍然不等于"有没有关系"** ⇒ 所以它**必须**靠总分过 `minTotal`，
   *    而不是无门槛放行（见 `sharedExperienceEvidence`）。
   */
  sharedExperienceRecall: boolean
  /**
   * 经历类过闸所需的**额外**条件（在 `minTotal` 之上）。
   *
   * ⚠️ 为什么还要加一条：只靠 `minTotal = 1.5`，一条**完全无关**的 episode
   *    靠"recency + entity"就能到 2.0 而混进来 —— 那就是 G3 禁止的"硬取一条"。
   *    因此要求它**同时**被 `subject` **与** `recency` 两个通道命中：
   *    那是"关于这个用户的、最近发生的事"这条最弱的真实相关性，
   *    足以把"人人都有分"的抱怨挡在门外。
   */
  sharedExperienceChannels: readonly string[]
  /**
   * **语义相关性下限**（后 Lv2 · 用户 2026-10-03 选项 a 步骤 2）。
   * 见 {@link DEFAULT_RECALL_RANKING_POLICY.semanticRelevanceFloor} 的注释。
   */
  semanticRelevanceFloor: number
  /** 多候选时，纯语义命中必须领先次名；单候选只检查分数。ADR-096。 */
  semanticRelevanceMinMargin: number
  /**
   * 低于这个总分就不进上下文（理由 `LOW_RELEVANCE`）。
   *
   * 它是**策略**而不是魔法数：调它等于回答"多不相关才算不相关"，
   * 而那是一个产品判断，必须能被 Gold Dataset 检验。
   */
  minTotal: number
  /** 同一个槽位最多留几条（historical 允许 2：当前的 + 一条历史） */
  maxPerSlot: number
  /** 内容指纹相同（同一句话）只留一条 */
  collapseIdenticalContent: boolean
  /** 语义维度不可用时，是否照旧把它写进 breakdown（**必须**是 true —— 见文件头纪律 1） */
  reportUnavailableFactors: boolean
}

export const DEFAULT_RECALL_RANKING_POLICY: RecallRankingPolicy = {
  weights: {
    // 词面命中是最强的信号（它是唯一"与这句话直接相关"的证据）……
    lexical: 4,
    semantic: 1,
    // ……但只给 1 分给"关于这个人"：几乎所有候选都满足，它区分度低
    entity: 1,
    temporal: 1,
    salience: 1,
    authority: 1,
    // 与当前问法的契合（问"现在"→active；问"以前"→superseded）值 2 分
    intentFit: 2,
  },
  requireRelevanceEvidence: true,
  /*
   * 后 Lv2 · `S7` 的显式经历路径：**缺省关**。
   *
   * ============================================================================
   *  ⚠️ 为什么缺省是关：**实测证明这条路的判据不够**（`postlv2:s7:gate` 方向 B）
   * ============================================================================
   * 开了它之后，"关于这个用户的 + 最近发生"**就能让一条经历记忆过闸**，
   * 而实测（三条**无关**问句：今天天气 / 3+5 / 推荐科幻电影）**全部混了进来**。
   * 那正是 G3 逐字禁止的"为了满足召回而硬取一条差不多的"，
   * 也正是 `ADR-084` 花精度代价换掉的东西。
   *
   * ⇒ 机制**留着**（可用、有开关、有门），但**默认不启用**：
   *    在能给出**真正判据**（语义 / 显式指称）之前，不许把相关性闸放宽。
   *    门 `postlv2:s7:gate` 会一直红着如实记录这一点。
   */
  sharedExperienceRecall: false,
  sharedExperienceChannels: ['subject', 'recency'],
  /**
   * **语义相关性下限**（后 Lv2 · 用户 2026-10-03 选项 a 步骤 2）。
   *
   * ```text
   * 一条候选的 `semanticScore >= semanticRelevanceFloor` ⇒ 语义**单独**可以证明相关性
   * ```
   * ⚠️ **它是策略，不是魔法数**：与 `minTotal` 同一条纪律 —— 调它等于回答
   *    "多像才算相关"，而那是一个**产品判断，必须被 Gold Dataset 检验**。
   *
   * ADR-096：用户 2026-10-04 授权在整个对话链启用纯语义命中。
   * 本地 E5 q8 / semantic-render@2 混合样本采用 0.87 + 领先间隔 0.01；
   * 仅 on 模式消费，off / shadow 保留原有相关性口径。
   */
  semanticRelevanceFloor: 0.87,
  semanticRelevanceMinMargin: 0.01,
  minTotal: 1.5,
  maxPerSlot: 2,
  collapseIdenticalContent: true,
  reportUnavailableFactors: true,
}

/**
 * 有没有**任何机制**能证明"这条记忆与这句话有关"（绝对判据，不是相对排序）。
 *
 * 三条相关性路径：
 *   ① 词面通道命中（WP3 的 `lexical`，内部用的就是 M4.1 的匹配，含登记表中文说明）
 *   ② 目标解析成功且这条记忆讲的就是那个实体（"关于 X 的那条"是明确的指称）
 *   ③ on 模式的语义分数与领先间隔通过当前策略（ADR-096）
 *
 * ⚠️ "关于本次请求的用户"**不算**证据：几乎所有长期事实都是关于他的，
 *    它区分不了"他想问的"与"他记得的其他事"。
 */
export function hasRelevanceEvidence(input: {
  request: RecallRequest
  candidate: RecallCandidate
  /** 策略里的开关（缺省 false ⇒ 与改动前逐字相同） */
  sharedExperienceRecall?: boolean
  /** 经历类过闸所需的通道（缺省见 {@link sharedExperienceEvidence}） */
  sharedExperienceChannels?: readonly string[]
  /**
   * **语义相关性下限**（选项 a 步骤 2）。
   *
   * ⚠️ 缺省 `Number.POSITIVE_INFINITY` ⇒ **语义路径不生效**（与改动前逐字相同）。
   *    传一个有限值（例如 `0.82`）才让语义**单独**成为相关性证据。
   *    这样"忘了传策略"的表现是"语义不放行"，而不是"语义悄悄放行了"。
   */
  semanticRelevanceFloor?: number
  semanticRelevanceMinMargin?: number
  /** 本候选减去最强的其它候选；null 表示本轮只有一个语义候选。 */
  semanticMargin?: number | null
  semanticOnly?: boolean
}): { ok: boolean; via: 'lexical' | 'target' | 'shared_experience' | 'semantic' | 'none' } {
  if (!input.semanticOnly && input.candidate.retrievedBy.includes('lexical')) {
    return { ok: true, via: 'lexical' }
  }
  const target = input.request.target
  if (!input.semanticOnly && target.status === 'resolved') {
    const matches = input.candidate.subjects.some(
      (subject) =>
        subject.kind === target.subject.kind && String(subject.id) === String(target.subject.id)
    )
    if (matches) return { ok: true, via: 'target' }
  }
  /*
   * ---------------------------------------------------------------------------
   * **语义路径**（后 Lv2 · 用户 2026-10-03 选项 a 步骤 2）
   * ---------------------------------------------------------------------------
   * ⚠️ 判据是**数值**，不是 `retrievedBy` 里的 `'semantic'` 标签。
   *    用户逐字点名了这个陷阱：
   * ```text
   *   "不能只凭 `retrievedBy` 包含 `semantic` 就放行 ——
   *    当前这个标签仅表示拿到了分数，不能证明内容相关。"
   * ```
   * ⇒ 必须 `semanticScore >= semanticRelevanceFloor`，且阈值**经校准**。
   *    缺省阈值是 `Infinity`（见策略注释）⇒ **语义路径缺省不生效**。
   */
  const floor = input.semanticRelevanceFloor ?? Number.POSITIVE_INFINITY
  if (Number.isFinite(floor)) {
    const score = input.candidate.semanticScore
    const margin = input.semanticMargin
    const minMargin = input.semanticRelevanceMinMargin ?? 0
    if (
      typeof score === 'number' && Number.isFinite(score) && score >= floor && score <= 1 &&
      (minMargin === 0 || margin === null || (typeof margin === 'number' && margin >= minMargin))
    ) {
      return { ok: true, via: 'semantic' }
    }
  }
  /*
   * 后 Lv2 · `S7`：**经历类**的显式路径（见 `RecallRankingPolicy.sharedExperienceRecall` 的注释）。
   * ⚠️ 放在**最后**：词面与 target 两条原有路径**优先级不变**，
   *    因此"有词面证据"的候选拿到的 `via` 与改动前逐字相同。
   */
  if (!input.semanticOnly && input.sharedExperienceRecall === true) {
    const shared = sharedExperienceEvidence({
      candidate: input.candidate,
      channels: input.sharedExperienceChannels ?? ['subject', 'recency'],
    })
    if (shared.ok) return { ok: true, via: 'shared_experience' }
  }
  return { ok: false, via: 'none' }
}

/**
 * 一条**经历类**记忆是否具备"最弱的真实相关性"。
 *
 * ```text
 * 判据（两条都要）：
 *   ① 记忆类型是经历类（episode / self_experience）
 *   ② 它**同时**被 `subject` 与 `recency` 两个通道命中
 *      —— "关于这个用户的、最近发生的事"，而不是"人人都有分"
 * ```
 * ⚠️ 声明类（`person_fact` / `preference` / …）**一律返回 false**：
 *    它们仍然必须走词面或 target 证据，一个字都不放宽。
 */
export function sharedExperienceEvidence(input: {
  candidate: RecallCandidate
  channels: readonly string[]
}): { ok: boolean; reason: string } {
  const type = input.candidate.type
  const isExperience = type === 'episode' || type === 'self_experience'
  if (!isExperience) return { ok: false, reason: `not_experience:${String(type)}` }
  const retrieved = new Set(input.candidate.retrievedBy.map(String))
  const missing = input.channels.filter((channel) => !retrieved.has(channel))
  if (missing.length > 0) return { ok: false, reason: `missing_channels:${missing.join(',')}` }
  return { ok: true, reason: `shared_experience:${input.channels.join('+')}` }
}

// ---------------------------------------------------------------------------
// 打分
// ---------------------------------------------------------------------------

export interface ScoreCandidateInput {
  request: RecallRequest
  candidate: RecallCandidate
  capabilities: MemoryRetrievalCapabilities
  /** 由调用方注入（排序器不读时钟 —— 否则不可复现） */
  now: number
  policy?: RecallRankingPolicy
}

/**
 * 给一条候选打分（**纯函数**）。
 *
 * 六个因子里有三个今天注定 `available: false` 或弱：
 *   · `semantic`   —— 能力报告说不可用 → 如实标注
 *   · `continuity` —— 需要"最近对话话题"，今天没有那条输入 → 如实标注
 *   · `lexical`    —— **二值**（WP3 只在通道里给"命中/未命中"）
 */
export function scoreCandidate(input: ScoreCandidateInput): RecallScoreBreakdown {
  const policy = input.policy ?? DEFAULT_RECALL_RANKING_POLICY
  const { request, candidate, capabilities } = input
  const components: RecallScoreComponent[] = []

  // --- lexical：二值（WP3 的通道信号）-------------------------------------
  const lexicalHit = candidate.retrievedBy.includes('lexical')
  components.push({
    name: 'lexical',
    value: lexicalHit ? 1 : 0,
    available: true,
    note: '二值：WP3 的通道只给"命中/未命中"。要更细需要回契约加 lexicalHits（见 WP3 交接单）',
  })

  // --- semantic：**真实分数**（后 Lv2 · 用户选项 a 步骤 2 修掉了硬编码 0）--------
  /*
   * ⚠️ **这里曾经是把 `value: 0` 写死的** —— 于是语义通道**永远不会影响排序**，
   *    即使后端真的给了分数（"装了但没接线"的教科书形态）。
   *    现在：有真实分数就用它；没有就**如实**记 `available: false`。
   */
  const semanticUnavailable = capabilities.unavailable.find((item) => item.dimension === 'semantic')
  const semanticScore = input.candidate.semanticScore
  components.push({
    name: 'semantic',
    value: semanticScore ?? 0,
    available: semanticScore !== undefined,
    ...(semanticScore !== undefined
      ? { note: `本次后端给出的相似度 ${semanticScore.toFixed(3)}` }
      : semanticUnavailable !== undefined
        ? { note: `不可用：${semanticUnavailable.reason}` }
        : { note: '后端可用，但**这一条没有分数**（不在索引里 / 未评分）' }),
  })

  // --- entity：这条讲的是不是本次解析到的那个实体 --------------------------
  const target = request.target
  if (target.status === 'resolved') {
    const matches = candidate.subjects.some(
      (subject) =>
        subject.kind === target.subject.kind && String(subject.id) === String(target.subject.id)
    )
    components.push({
      name: 'entity',
      value: matches ? 1 : 0,
      available: true,
      note: '目标解析到实体时，看 subjects 里有没有它',
    })
  } else {
    components.push({
      name: 'entity',
      value: candidate.subjects.some(
        (subject) =>
          subject.kind === request.user.kind && String(subject.id) === String(request.user.id)
      )
        ? 1
        : 0,
      available: true,
      note: '没有实体目标时，退化成"这条是不是关于本次请求的用户"（区分度低，权重也低）',
    })
  }

  // --- temporal：在时间窗内 + 新鲜度 --------------------------------------
  const at = candidate.occurredAt ?? candidate.recordedAt
  const withinScope = isWithinTimeScope({
    timeScope: request.timeScope,
    recordedAt: candidate.recordedAt,
    ...(candidate.occurredAt !== undefined ? { occurredAt: candidate.occurredAt } : {}),
  })
  /*
   * 新鲜度用**半衰期**而不是线性衰减：线性会让"很久以前"变成大负数，
   * 而它其实只是"不太新鲜"。半衰期是 30 天（可配置的下一步）。
   */
  const ageDays = Math.max(0, (input.now - at) / 86_400_000)
  const freshness = 1 / (1 + ageDays / 30)
  components.push({
    name: 'temporal',
    value: withinScope ? freshness : 0,
    available: true,
    note: withinScope ? '在时间窗内，按新鲜度（30 天半衰期）' : '不在时间窗内',
  })

  // --- salience：M4 的 importance（值得长期记住的程度）---------------------
  components.push({
    name: 'salience',
    value: clamp01(candidate.importance),
    available: true,
    note: '直接用 M4 的 importance（不用 confidence —— 那是"多确定"而不是"多重要"）',
  })

  // --- authority：由证据推导的权威等级 ------------------------------------
  //
  // M5.1.1 / Phase 4b（ADR-043 §3.3 ⑥）：**当前资格**会把它**降档**（不改库值）。
  //
  // ```text
  // 资格 = ESTABLISHED（或 Episode 面"不适用"）  → 不降
  // 资格 ≠ ESTABLISHED                            → 降**一档**
  // status = disputed                             → 再多降一档
  // ```
  // ⚠️ 只降**排序分**，`memory_records.authority` 一个字不动（`DR-1`）。
  //    "降一档"的方向：秩越小权威越高（见 `authorityRank`），因此是 `rank + 1`。
  const rank = authorityRank(candidate.authority as MemoryAuthority)
  const maxRank = 5 // MODEL_INFERENCE 的秩（见 contracts/memory.ts 的顺序）
  const qualificationPenalty = qualificationPenalizesAuthority(candidate.qualification) ? 1 : 0
  const disputedPenalty = candidate.status === 'disputed' ? 1 : 0
  const effectiveRank = Math.min(maxRank, rank + qualificationPenalty + disputedPenalty)
  components.push({
    name: 'authority',
    value: (maxRank - effectiveRank) / maxRank,
    available: true,
    note:
      '规范化的权威秩（EXPLICIT_CORRECTION 最高，MODEL_INFERENCE 最低）' +
      (qualificationPenalty > 0
        ? `；资格 = ${String(candidate.qualification)} ⇒ **降一档**（不改库值）`
        : '') +
      (disputedPenalty > 0 ? '；status = disputed ⇒ 再降一档' : ''),
  })

  // --- intentFit：与当前问法的契合 ----------------------------------------
  components.push({
    name: 'intentFit',
    value: intentFit(request, candidate),
    available: true,
    note:
      request.intent === 'historical'
        ? '问"以前"：superseded 的情境契合更高'
        : '问"现在"：active 的契合更高，disputed 取中',
  })

  // --- continuity：今天没有输入，**如实**不可用 ---------------------------
  if (policy.reportUnavailableFactors) {
    components.push({
      name: 'continuity',
      value: 0,
      available: false,
      note:
        '不可用：需要"最近几轮对话的话题/实体"作为输入，而 M5 还没有那条信号' +
        '（它属于 WP6/WP7 的上下文侧）。如实标注，不给 0 分',
    })
  }

  const total = components
    .filter((component) => component.available)
    .reduce((sum, component) => sum + component.value *
      (component.name === 'semantic' && effectiveSemanticMode(request) !== 'on'
        ? 0 : weightOf(component.name, policy.weights)), 0)

  return { total: round6(total), components }
}

function weightOf(name: string, weights: RecallRankingWeights): number {
  const table: Record<string, number> = {
    lexical: weights.lexical,
    semantic: weights.semantic ?? 0,
    entity: weights.entity,
    temporal: weights.temporal,
    salience: weights.salience,
    authority: weights.authority,
    intentFit: weights.intentFit,
    continuity: 0,
  }
  return table[name] ?? 0
}

function intentFit(request: RecallRequest, candidate: RecallCandidate): number {
  if (request.intent === 'historical') {
    // 问"以前"时，被取代过的旧条反而是最贴合问题的
    return candidate.status === 'superseded' ? 1 : 0.5
  }
  if (candidate.status === 'active') return 1
  if (candidate.status === 'disputed') return 0.5
  return 0.2
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function round6(value: number): number {
  // 浮点误差会让"完全相同的输入"产出看起来不同的分数 —— 取 6 位消除它
  return Math.round(value * 1e6) / 1e6
}

// ---------------------------------------------------------------------------
// 排序 + 去重 + 冲突
// ---------------------------------------------------------------------------

export interface RankedCandidate {
  candidate: RecallCandidate
  score: RecallScoreBreakdown
}

export interface RankCandidatesInput {
  request: RecallRequest
  /** **只**传通过资格的那一批（WP2 的 `eligibility.eligible`） */
  candidates: readonly RecallCandidate[]
  capabilities: MemoryRetrievalCapabilities
  now: number
  policy?: RecallRankingPolicy
}

export interface RankCandidatesResult {
  /** 已排序、已去重、已按冲突规则裁剪 —— 交给 WP5 做预算选择 */
  ranked: RankedCandidate[]
  /** 在排序阶段就被**终局淘汰**的候选（低于阈值 / 重复 / 同槽位超出上限） */
  decisions: RecallDecision[]
  collapsed: { memoryId: string; duplicateOf?: string; reason: RecallExclusionReason }[]
}

function effectiveSemanticMode(request: RecallRequest) {
  return request.semanticMode ?? defaultSemanticModeFor(request.retrievalPolicyVersion ?? 'lexical-recency@1')
}

/**
 * 排序 → 去重 → 冲突裁剪。
 *
 * 顺序很讲究：
 *   ① 打分（每条候选一份可解释的 breakdown）
 *   ② **稳定排序**（总分 → recordedAt 降序 → id 升序）
 *   ③ 去重与冲突裁剪（在**有序**列表上做，于是"留下哪一条"总是一致的）
 *   ④ 低于阈值的终局淘汰（`LOW_RELEVANCE`）
 */
export function rankCandidates(input: RankCandidatesInput): RankCandidatesResult {
  const policy = input.policy ?? DEFAULT_RECALL_RANKING_POLICY
  const collapsed: RankCandidatesResult['collapsed'] = []
  const semanticMode = effectiveSemanticMode(input.request)
  const semanticScores = semanticMode === 'on'
    ? input.candidates.map((candidate) => candidate.semanticScore)
        .filter((score): score is number => typeof score === 'number' && Number.isFinite(score))
        .sort((a, b) => b - a)
    : []

  const scored: RankedCandidate[] = input.candidates.map((candidate) => ({
    candidate,
    score: scoreCandidate({
      request: input.request,
      candidate,
      capabilities: input.capabilities,
      now: input.now,
      policy,
    }),
  }))

  scored.sort(compareRanked)

  const kept: RankedCandidate[] = []
  const byFingerprint = new Map<string, string>()
  const bySlot = new Map<string, string>()
  const slotCount = new Map<string, number>()

  for (const item of scored) {
    const memoryId = String(item.candidate.memoryId)

    /*
     * ① **相关性闸**（绝对存在性，先于一切相对判断）。
     *
     * 它是 G3 裁定的机制落点：没有任何机制能建立 relevance 的记忆，
     * **不得**为了满足召回硬取一条 —— 即使它的 salience/authority 很高。
     * 这一条与 WP2 的资格层是两件事：资格回答"能不能用"，
     * 这里回答"与这句话有没有关系"。
     */
    if (policy.requireRelevanceEvidence) {
      const evidence = hasRelevanceEvidence({
        request: input.request,
        candidate: item.candidate,
        ...(policy.semanticOnly ? { semanticOnly: true } : {}),
        sharedExperienceRecall: policy.sharedExperienceRecall,
        sharedExperienceChannels: policy.sharedExperienceChannels,
        semanticRelevanceFloor: semanticMode === 'on' ? policy.semanticRelevanceFloor : Number.POSITIVE_INFINITY,
        semanticRelevanceMinMargin: policy.semanticRelevanceMinMargin,
        semanticMargin: semanticScores.length <= 1 ? null :
          (item.candidate.semanticScore ?? 0) -
            (item.candidate.semanticScore === semanticScores[0] ? semanticScores[1]! : semanticScores[0]!),
      })
      if (!evidence.ok) {
        collapsed.push({ memoryId, reason: 'LOW_RELEVANCE' })
        continue
      }
    }

    // ② 阈值：有相关性证据，但总分仍然太低（例如只靠 target 指称而没有词面命中）
    if (item.score.total < policy.minTotal) {
      collapsed.push({ memoryId, reason: 'LOW_RELEVANCE' })
      continue
    }

    // ③ 完全同内容（同一句话）：只留排在最前的那条
    if (policy.collapseIdenticalContent) {
      const existing = byFingerprint.get(item.candidate.contentFingerprint)
      if (existing !== undefined) {
        collapsed.push({ memoryId, duplicateOf: existing, reason: 'DUPLICATE' })
        continue
      }
    }

    /*
     * ④ 同槽位冲突（AT4.4）：以 `canonicalKey` 分组 —— 它含 qualifier scope，
     *    因此"技术问题要详细"与"闲聊要简短"是**两个槽位**，不会被误合并
     *    （M4 已经为这件事踩过一次，见 `canonicalKeyOf` 的注释）。
     *
     *    `maxPerSlot` 由策略给：问"现在"时历史条在资格层已出局，留下 1 条；
     *    问"以前"时允许"当前的 + 一条历史"同时进上下文。
     */
    const slotKey = item.candidate.canonicalKey
    if (slotKey !== undefined) {
      const count = slotCount.get(slotKey) ?? 0
      if (count >= policy.maxPerSlot) {
        collapsed.push({
          memoryId,
          duplicateOf: bySlot.get(slotKey),
          reason: 'DUPLICATE',
        })
        continue
      }
      slotCount.set(slotKey, count + 1)
      if (!bySlot.has(slotKey)) bySlot.set(slotKey, memoryId)
    }

    byFingerprint.set(item.candidate.contentFingerprint, memoryId)
    kept.push(item)
  }

  const decisions: RecallDecision[] = collapsed.map((item) => {
    const decision: RecallDecision = {
      memoryId: item.memoryId as unknown as RecallDecision['memoryId'],
      // DUPLICATE / LOW_RELEVANCE 都属于 ranking 阶段（见契约里的 stage）
      eligible: true,
      reason: item.reason,
      selected: false,
    }
    assertRecallDecision(decision)
    return decision
  })

  return { ranked: kept, decisions, collapsed }
}

/**
 * 稳定 tie-break（AT4.2）。
 *
 * 三个关键字，缺一个都会让"同样的输入"在某些批次下给出不同顺序：
 *   ① 总分降序
 *   ② `recordedAt` 降序（更新的事实优先 —— 可解释，不是随机）
 *   ③ memoryId 升序（最后的确定性兜底）
 */
function compareRanked(a: RankedCandidate, b: RankedCandidate): number {
  if (b.score.total !== a.score.total) return b.score.total - a.score.total
  if (b.candidate.recordedAt !== a.candidate.recordedAt) {
    return b.candidate.recordedAt - a.candidate.recordedAt
  }
  return String(a.candidate.memoryId) < String(b.candidate.memoryId) ? -1 : 1
}
