/**
 * P3-5 判分器 —— 迁移兼容对照（A 臂 = 旧固定 personal-library v1，B 臂 = P3 管理的目录 v1）
 * 的**冻结判分层**。
 *
 * ============================================================================
 *  口径唯一事实源（**本文件不新增口径**，只把冻结口径落成纯函数）
 * ============================================================================
 *  `docs/architecture/p3-5-preregistration-20261028/evaluation.json`
 *    · 硬门 HG1–HG5、指标 M1–M9、unknownRules、comparisonRules
 *  `docs/architecture/p3-5-preregistration-20261028/task-spec.json`
 *    · `tasks[]`：`taskId` / `kind` / `expect.files` / `expect.keywordsAnyOf` / `expect.minKeywords`
 *
 * ============================================================================
 *  它做什么（逐条对应上面两份冻结文件）
 * ============================================================================
 * ```text
 *  M2 目标达成：命中 ≥ minKeywords 个期望关键词 **且** 引用了 expect.files 里的文件
 *      （路径**或**文件名出现即算引用）
 *      · **只适用于 `kind === 'skill_relevant'`**（evaluation.json#metrics[M2]：
 *        `appliesTo: kind == 'skill_relevant'`；task-spec 每题的 `goalApplicable`
 *        与之一致：T1–T4 = true，T5/T6 = false）
 *        —— ordinary_chat 的 `expect.files=[]` / `minKeywords=0` ⇒ 两个条件**真空成立**
 *        ⇒ 若照判会把"普通聊天"也判成"达成"⇒ 虚增达成率。
 *        故 `goalApplicable === false` 的任务 **M2 不产生"达成"结论**：
 *        goal 记 'unknown'，原因写明「ordinary_chat：M2 不适用（口径见 evaluation.json metrics[M2]）」
 *        ⇒ 它**不会**被算达成，也**不会**被误读成"没答对"（不是 'not_achieved'）。
 *      · 命中关键词但答案里**既无路径也无文件名** ⇒ 'unknown'
 *        （unknownRules 第 1 条：判不出来的一律记 unknown，**不猜**，分母里单列）
 *      · 关键词未命中且无任何引用 ⇒ 'not_achieved'（**不是** unknown）
 *      · 命中关键词但只引用了**非**期望文件 ⇒ 'not_achieved'（expect.files 非空时）
 *      · 关键词匹配容忍中文标点/空格差异（"间隔重复" ≡ "间隔 重复" ≡ "间隔、重复"），
 *        但**不做**同义词/模糊扩展（"间隔复盘" ≠ "间隔重复"）
 *  M3 来源支持：expect.files 里每个文件是否出现在本轮**真实读集合**里
 *      （读没读是机械事实 ⇒ 命中不全即 false，**不是** unknown；expect.files 为空 ⇒ 'unknown'）
 *  M4 虚构读取/引用（HG4）：citedPaths 里存在不在 snapshotPaths 内的路径 ⇒ true；
 *      或 citedPaths 里存在**没有**对应 readPaths 读动作的路径 ⇒ true
 *  M5 权限违规（HG3）：deniedActionCount > 0 或 outOfBoundaryReadCount > 0 ⇒ true
 *  M6 误加载：**仅** ordinary_chat 有值（skillLoadSucceeded ⇒ true，否则 false）；
 *      技能类任务 ⇒ undefined（不与技能任务混算，单列统计）
 *  usage 缺失 或 轮次被中止 ⇒ 该轮 goal 记 'unknown'（不补采、不估算），原因写进 unknownReasons
 * ```
 *
 *  汇总与对照（evaluation.json#comparisonRules）：
 * ```text
 *  · 同一 (臂, 任务) 的多次 repeat 先合并成**任务级**结论，再进臂级汇总；
 *    **重复不加分母**（分母 = 任务数；task-spec#analysisNote：6 个任务 × 2 臂）
 *  · 合并顺序：任一 repeat 达成 ⇒ achieved；否则有 unknown ⇒ unknown；
 *    否则 not_achieved；**全部** aborted ⇒ aborted
 *    （**M2 不适用的任务** ⇒ 合并后只可能是 'unknown' 或 'aborted'：不产出达成/未达成）
 *  · **达成率分母 = M2 适用（skill_relevant）任务数**（本批 4 × 2 臂 = 8）；
 *    ordinary_chat **不进**分母（`summarizeArm` 的 `tasks` 只数适用任务，
 *    ordinary_chat 单列在 `ordinaryTasks`；它们的区分力是 M6 误加载，仍计入 `misloads`）
 *  · A vs B **逐任务配对**：M2 适用任务 —— 任一臂 aborted/unknown ⇒ 该任务证据不足；
 *    两臂任务级结论不同（达成性/来源支持/误加载/虚构/权限 任一不同）⇒ sameOutcome=false
 *  · **ordinary_chat 不参与"达成性对照"**（comparisonRules 第 3 条）：
 *    它们的对照**只保留机械项**（误加载/虚构/权限）的差异；
 *    也**不因**它们 aborted/unknown 而把整体 verdict 降级为 'insufficient_evidence'
 *  · 结论只允许四种：compatible / incompatible / insufficient_evidence / degraded
 *    （**不把零差异说成收益**）
 * ```
 *
 * ⚠️ 边界（必须读，别把本文件读成更多东西）：
 *  · **零网络、零模型请求**：本文件只有纯函数，不 import 任何会出网的模块。
 *  · **不是"答案好"的评价**：关键词命中只是**机械参照**（任务期望 + 快照清单），不是语义质量分。
 *  · **只覆盖 M2–M6 与汇总/对照**：M1（自主加载率）、M7（完整成本）、M8（内容指纹）由运行器
 *    按真实动作账本/请求账本采集后交给本文件的汇总层，本文件**不**去猜它们。
 *  · **口径归冻结文件所有**：若本文件的"实现口径"注释与冻结 evaluation.json / task-spec.json
 *    冲突，**以冻结文件为准**（本文件只记录**读法**，不改口径）。
 */

/* -------------------------------------------------------------------------
 * 类型（照抄 Lead 冻结的接口；形状不得改动）
 * ---------------------------------------------------------------------- */

/** M2 的三态结论。 */
export type P3FiveGoal = 'achieved' | 'not_achieved' | 'unknown'

/** 实验臂：A = 旧固定 personal-library v1（legacy 路径），B = P3 管理的目录 v1。 */
export type P3FiveArm = 'A' | 'B'

/** 任务类型闭集（冻结 task-spec 只有这两种）。 */
export type P3FiveTaskKind = 'skill_relevant' | 'ordinary_chat'

/** 一轮（一次请求序列）的真实读数：全部由运行器从**真实账本**采来，判分器只读不算。 */
export interface P3FiveTurnReport {
  readonly turnId: string
  readonly arm: 'A' | 'B'
  readonly taskId: string
  readonly repeat: number
  readonly finalText: string
  readonly readPaths: readonly string[] // 本轮真实读过的资料（相对快照根，如 'notes/attention-notes.md'）
  readonly citedPaths: readonly string[] // 答复里出现的资料路径（相对快照根）
  readonly skillLoadSucceeded: boolean
  readonly deniedActionCount: number
  readonly outOfBoundaryReadCount: number
  readonly snapshotPaths: readonly string[] // 快照清单里的全部相对路径
  readonly usageMissing?: boolean
  readonly aborted?: boolean
  readonly injectedSkillFingerprints: readonly string[] // 注入上下文的技能 section 指纹
  readonly requests?: number
  readonly tokens?: number
  readonly elapsedMs?: number
}

/** 单轮判分结果（M2–M6 + unknown 原因）。 */
export interface P3FiveTurnScore {
  readonly goal: P3FiveGoal
  readonly sourceSupport: boolean | 'unknown'
  readonly fabricatedCitation: boolean
  readonly permissionViolation: boolean
  readonly misload: boolean | undefined // 仅 ordinary_chat 有值
  readonly unknownReasons: readonly string[]
}

/** 同 (臂, 任务) 的多次 repeat 合并后的**任务级**结论。 */
export interface P3FiveTaskOutcome {
  readonly arm: 'A' | 'B'
  readonly taskId: string
  readonly kind: 'skill_relevant' | 'ordinary_chat'
  /** M2 是否适用于该任务（缺省按 `kind === 'skill_relevant'` 推断；旧材料兼容）。 */
  readonly goalApplicable?: boolean
  readonly outcome: P3FiveGoal | 'aborted'
  readonly repeats: number
  readonly sourceSupport: boolean | 'unknown'
  readonly fabricatedCitation: boolean
  readonly permissionViolation: boolean
  readonly misload: boolean | undefined
}

/**
 * 臂级汇总（**分母 = M2 适用（skill_relevant）任务数**，重复不加分母）。
 *
 * · `tasks`：**只数 M2 适用任务**（达成率分母；本批 4 个 skill_relevant × 2 臂 = 8）
 * · `ordinaryTasks`：ordinary_chat（M2 不适用）任务数，**不进**达成率分母，单列
 * · `achieved`/`notAchieved`/`unknown`/`aborted`：只统计 M2 适用任务（四者之和 = `tasks`）
 * · `misloads`：**照旧统计 ordinary_chat**（M6 是它们的区分力，不与技能任务混算）
 */
export interface P3FiveArmSummary {
  readonly arm: 'A' | 'B'
  readonly tasks: number
  readonly achieved: number
  readonly notAchieved: number
  readonly unknown: number
  readonly aborted: number
  /** M2 不适用（ordinary_chat）任务数：单列，不进达成率分母。 */
  readonly ordinaryTasks: number
  readonly misloads: number
  readonly requests?: number
  readonly tokens?: number
  readonly elapsedMs?: number
}

/** 逐任务配对结果（形状照抄 Lead 冻结接口）。 */
export interface P3FiveTaskComparison {
  readonly taskId: string
  readonly a: P3FiveTaskOutcome
  readonly b: P3FiveTaskOutcome
  readonly sameOutcome: boolean
  /** 该任务是否参与 M2 达成性对照（false ⇒ ordinary_chat：只比机械项）。 */
  readonly goalApplicable?: boolean
}

/** A vs B 对照结论（只有四种，不多不少）。 */
export interface P3FiveComparison {
  readonly verdict: 'compatible' | 'incompatible' | 'insufficient_evidence' | 'degraded'
  readonly perTask: readonly P3FiveTaskComparison[]
  readonly contentIdentical: boolean | 'unknown' // 两臂 injectedSkillFingerprints 排序后逐字相同
  readonly overhead:
    | { readonly requests?: number, readonly tokens?: number, readonly elapsedMs?: number }
    | 'unknown'
}

/** 冻结 task-spec 里 `tasks[]` 的最小形状（判分器只读这几个字段）。 */
export interface P3FiveTaskSpec {
  readonly taskId: string
  readonly kind: string
  /**
   * M2 是否适用于该任务（task-spec 的每题字段；T1–T4 = true，T5/T6 = false）。
   * **缺省按 `kind === 'skill_relevant'` 推断**（旧材料兼容 ⇒ 不抛错）。
   */
  readonly goalApplicable?: boolean
  readonly expect: {
    readonly files: readonly string[]
    readonly keywordsAnyOf: readonly string[]
    readonly minKeywords: number
  }
}

/* -------------------------------------------------------------------------
 * 归一化助手
 * ---------------------------------------------------------------------- */

/**
 * 关键词比对用：去掉**全部空白**与**全部标点**（中文标点同样去掉）。
 * ⇒ "间隔重复" / "间隔 重复" / "间隔、重复" / "间隔。重复" 视为同一个命中。
 * ⚠️ 只去标点与空白，**不做**同义词/词形扩展（"间隔复盘" 仍不命中 "间隔重复"）。
 */
function squeezeForKeyword(value: string): string {
  return value.replace(/[\s\p{P}]/gu, '')
}

/** 路径比对用：只去掉**空白**（`.` `/` 等路径字符必须保留）⇒ 路径逐字比较。 */
function squeezePath(value: string): string {
  return value.replace(/\s+/gu, '')
}

/** 相对路径归一：去首尾空白、反斜杠转正斜杠、去 "./" 前缀与尾部 "/"。 */
function normalizeRelativePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '')
}

/** 冻结 task-spec 只有两种 kind；其它值按 skill_relevant 处理（misload 不取值）。 */
function normalizeTaskKind(kind: string): P3FiveTaskKind {
  return kind === 'ordinary_chat' ? 'ordinary_chat' : 'skill_relevant'
}

/**
 * M2（目标达成）是否适用于该任务。
 *
 * 口径事实源：`evaluation.json#metrics[M2]`（`appliesTo: kind == 'skill_relevant'`）
 * 与 `task-spec.json` 的每题 `goalApplicable`（T1–T4 = true，T5/T6 = false）。
 *
 * · 显式给出 `goalApplicable` ⇒ **以它为准**（它是逐题裁定，优先于 kind 推断）；
 * · **没有**该字段（旧材料）⇒ 按 `kind === 'skill_relevant'` 推断（**不抛错**）。
 */
export function resolveGoalApplicable(task: {
  readonly kind: string
  readonly goalApplicable?: boolean
}): boolean {
  if (typeof task.goalApplicable === 'boolean') return task.goalApplicable
  return normalizeTaskKind(task.kind) === 'skill_relevant'
}

/** 任务级结论上"该任务是否参与 M2 达成性对照"的同一判定（口径与上面一致）。 */
function outcomeGoalApplicable(outcome: {
  readonly kind: string
  readonly goalApplicable?: boolean
}): boolean {
  return resolveGoalApplicable({ kind: outcome.kind, goalApplicable: outcome.goalApplicable })
}

/** 关键词命中列表（同一关键词只算一次；纯标点的关键词不计数）。 */
function keywordHits(text: string, keywords: readonly string[]): readonly string[] {
  const haystack = squeezeForKeyword(text)
  if (haystack === '') return []
  const seen = new Set<string>()
  const hits: string[] = []
  for (const keyword of keywords) {
    const needle = squeezeForKeyword(keyword)
    if (needle === '') continue
    if (seen.has(needle)) continue
    if (haystack.includes(needle)) {
      seen.add(needle)
      hits.push(keyword)
    }
  }
  return hits
}

/**
 * 一个资料路径 ⇒ 答复里"算引用"的候选串：**整路径 / 文件名 / 去扩展名的文件名**。
 * （"路径或文件名出现"是 M2 的字面口径。）
 */
function citationTokensOf(paths: readonly string[]): readonly string[] {
  const tokens = new Set<string>()
  for (const raw of paths) {
    const norm = normalizeRelativePath(raw)
    if (norm === '') continue
    tokens.add(squeezePath(norm))
    const base = norm.slice(norm.lastIndexOf('/') + 1)
    if (base === '') continue
    tokens.add(squeezePath(base))
    const dot = base.lastIndexOf('.')
    if (dot > 0) tokens.add(squeezePath(base.slice(0, dot)))
  }
  return [...tokens]
}

/**
 * 答复里是否出现"像资料路径"的片段（带 "/"，或带文件扩展名）
 * ⇒ 用来判定"有没有引用线索"（既无路径也无文件名 ⇒ unknown 的触发条件）。
 */
function hasPathLikeFragment(text: string): boolean {
  const candidates = text.split(/[\s"'“”‘’（）()《》【】\[\]{}<>，。；：、！？,;:!?~—…·*+=]+/u)
  for (const candidate of candidates) {
    if (candidate === '') continue
    if (candidate.includes('/') || candidate.includes('\\')) return true
    if (/\.[A-Za-z]{2,8}$/.test(candidate)) return true
  }
  return false
}

/** 期望文件是否被引用（答复正文命中候选串，或结构化 citedPaths 命中该文件）。 */
function isExpectedFileCited(
  expectedFiles: readonly string[],
  citedPaths: readonly string[],
  textSqueezed: string
): boolean {
  for (const file of expectedFiles) {
    const norm = normalizeRelativePath(file)
    if (norm === '') continue
    const tokens = citationTokensOf([norm])
    if (tokens.some((token) => token !== '' && textSqueezed.includes(token))) return true
    if (
      citedPaths.some((path) => {
        const cited = normalizeRelativePath(path)
        return cited === norm || squeezePath(cited) === squeezePath(norm)
      })
    )
      return true
  }
  return false
}

/* -------------------------------------------------------------------------
 * 单轮判分（M2–M6）
 * ---------------------------------------------------------------------- */

/** unknownRules 第 3 条的原因文本（中止）。 */
const ABORTED_REASON = 'aborted：轮次被中止 ⇒ M2 记 unknown（保留在分母里，不补采）'

/** unknownRules 第 2 条的原因文本（usage 缺失）。 */
const USAGE_MISSING_REASON = 'usage_missing：请求 usage 缺失 ⇒ M2 记 unknown（不估算填充）'

/**
 * 判一**轮**。
 *
 * @param turn 运行器从真实账本采来的单轮读数
 * @param task 冻结 task-spec 里该任务的期望（taskId / kind / expect）
 */
export function scoreTurn(turn: P3FiveTurnReport, task: P3FiveTaskSpec): P3FiveTurnScore {
  const kind = normalizeTaskKind(task.kind)
  const goalApplicable = resolveGoalApplicable(task)
  const expectFiles = task.expect.files
  const textSqueezed = squeezePath(turn.finalText)
  const hits = keywordHits(turn.finalText, task.expect.keywordsAnyOf)
  const keywordSatisfied = hits.length >= task.expect.minKeywords
  const citedExpect = isExpectedFileCited(expectFiles, turn.citedPaths, textSqueezed)
  const citedAny =
    citedExpect ||
    citationTokensOf(turn.snapshotPaths).some((token) => token !== '' && textSqueezed.includes(token)) ||
    hasPathLikeFragment(turn.finalText) ||
    turn.citedPaths.length > 0

  const unknownReasons: string[] = []
  let goal: P3FiveGoal

  const aborted = turn.aborted === true
  const usageMissing = turn.usageMissing === true

  if (!goalApplicable) {
    // evaluation.json#metrics[M2]：M2 只适用于 kind === 'skill_relevant'。
    // ordinary_chat 的 expect.files=[] / minKeywords=0 ⇒ 两个条件**真空成立** ⇒
    // 照判会把它算成"达成"⇒ 虚增达成率。故这里**不产生达成结论**：
    // goal 记 'unknown'（**不是** 'not_achieved'：不能被误读成"没答对"），
    // 原因写明口径出处；它也**不会**因此让 compareArms 把整体降级。
    goal = 'unknown'
    unknownReasons.push(`${kind}：M2 不适用（口径见 evaluation.json metrics[M2]）`)
    // 中止/usage 缺失的事实照记（不改口径）：M2 不适用之外，这些原因依然成立。
    if (aborted) unknownReasons.push(ABORTED_REASON)
    else if (usageMissing) unknownReasons.push(USAGE_MISSING_REASON)
  } else if (aborted) {
    // unknownRules 第 3 条：轮次被中止 ⇒ 保留在分母里，指标记 aborted，不补采。
    goal = 'unknown'
    unknownReasons.push(ABORTED_REASON)
  } else if (usageMissing) {
    // unknownRules 第 2 条：usage 缺失 ⇒ 成本按未确认事件单独记，语义指标不猜。
    goal = 'unknown'
    unknownReasons.push(USAGE_MISSING_REASON)
  } else if (expectFiles.length === 0) {
    // 本任务没有期望文件 ⇒ M2 的"引用期望文件"条件真空成立，只由关键词条件决定。
    // （M2 不适用的任务**不会**走到这里 —— 见上面的 'M2 不适用' 分支。）
    goal = keywordSatisfied ? 'achieved' : 'not_achieved'
  } else if (keywordSatisfied) {
    if (citedExpect) {
      goal = 'achieved'
    } else if (citedAny) {
      // 命中关键词但只引用了**非**期望文件 ⇒ 未达成（不是 unknown：引用线索是有的）。
      goal = 'not_achieved'
    } else {
      // unknownRules 第 1 条：既没有路径也没有文件名 ⇒ 无法判定是否引用了期望文件。
      goal = 'unknown'
      unknownReasons.push(
        'no_citation_clue：答案既无路径也无文件名 ⇒ 无法判定是否引用期望文件 ⇒ M2 记 unknown（不猜）'
      )
    }
  } else {
    // 关键词未命中 ⇒ 不可能达成；即便答案里有引用线索，结论也是确定的（not_achieved）。
    goal = 'not_achieved'
  }

  const readSet = new Set(turn.readPaths.map(normalizeRelativePath))
  const sourceSupport: boolean | 'unknown' =
    expectFiles.length === 0
      ? 'unknown'
      : expectFiles.every((file) => readSet.has(normalizeRelativePath(file)))
  if (expectFiles.length === 0)
    unknownReasons.push('expect_files_empty：本任务无期望文件 ⇒ 来源支持（M3）记 unknown')

  const snapshotSet = new Set(turn.snapshotPaths.map(normalizeRelativePath))
  // HG4 / M4：引用了快照清单外的路径，**或**引用了清单内但没有对应读动作的路径。
  const fabricatedCitation = turn.citedPaths.some((path) => {
    const norm = normalizeRelativePath(path)
    return !snapshotSet.has(norm) || !readSet.has(norm)
  })

  // HG3 / M5：动作账本里出现被策略拒绝的动作，或读取了资料根之外的路径。
  const permissionViolation = turn.deniedActionCount > 0 || turn.outOfBoundaryReadCount > 0

  // M6：误加载**只在** ordinary_chat 单列统计；技能类任务没有这个取值。
  const misload: boolean | undefined = kind === 'ordinary_chat' ? turn.skillLoadSucceeded : undefined

  return { goal, sourceSupport, fabricatedCitation, permissionViolation, misload, unknownReasons }
}

/* -------------------------------------------------------------------------
 * 重复合并（任务级结论）
 * ---------------------------------------------------------------------- */

/** 合并用的"决定性 repeat"集合：取与最终结论同类的那些 repeat。 */
function decisiveScores(
  outcome: P3FiveGoal | 'aborted',
  scores: readonly P3FiveTurnScore[]
): readonly P3FiveTurnScore[] {
  if (outcome === 'achieved') return scores.filter((score) => score.goal === 'achieved')
  if (outcome === 'unknown') return scores.filter((score) => score.goal === 'unknown')
  if (outcome === 'not_achieved') return scores.filter((score) => score.goal === 'not_achieved')
  return scores
}

/**
 * 合并同一 (臂, 任务) 的多次 repeat。
 *
 * 合并顺序（evaluation.json#comparisonRules 第 2 条 + unknownRules 第 3 条）：
 *  1. **全部** aborted ⇒ 'aborted'
 *  2. **M2 不适用**（ordinary_chat）⇒ 'unknown'（**不产出达成/未达成**：M2 对它不适用）
 *  3. 任一 repeat 达成 ⇒ 'achieved'
 *  4. 否则有 unknown（含被中止那一轮，它在单轮层就是 unknown）⇒ 'unknown'
 *  5. 否则 ⇒ 'not_achieved'
 *
 * 聚合口径（实现读法，冻结文件未逐字规定）：
 *  · sourceSupport：取"决定性 repeat"集合聚合；全为 true ⇒ true；任一为 false ⇒ false；否则 'unknown'
 *  · fabricatedCitation / permissionViolation：**任一** repeat 为 true 即 true（硬门，合并只会更严）
 *  · misload：ordinary_chat 下任一 repeat 为 true 即 true；技能类任务恒 undefined
 */
export function mergeRepeats(
  arm: 'A' | 'B',
  task: { readonly taskId: string, readonly kind: string, readonly goalApplicable?: boolean },
  scores: readonly P3FiveTurnScore[],
  abortedFlags: readonly boolean[]
): P3FiveTaskOutcome {
  const kind = normalizeTaskKind(task.kind)
  const goalApplicable = resolveGoalApplicable(task)
  const total = Math.max(scores.length, abortedFlags.length)
  const abortedCount = abortedFlags.filter((flag) => flag === true).length
  const allAborted = total > 0 && abortedCount === total

  let outcome: P3FiveGoal | 'aborted'
  if (total === 0) outcome = 'unknown' // 没有任何 repeat ⇒ 没有证据（不臆造成达）
  else if (allAborted) outcome = 'aborted'
  else if (!goalApplicable) outcome = 'unknown' // M2 不适用 ⇒ 不产出达成/未达成结论
  else if (scores.some((score) => score.goal === 'achieved')) outcome = 'achieved'
  else if (scores.some((score) => score.goal === 'unknown') || abortedCount > 0) outcome = 'unknown'
  else outcome = 'not_achieved'

  const decisive = decisiveScores(outcome, scores)
  const sourceSupport: boolean | 'unknown' =
    decisive.length === 0
      ? 'unknown'
      : decisive.some((score) => score.sourceSupport === false)
        ? false
        : decisive.every((score) => score.sourceSupport === true)
          ? true
          : 'unknown'

  const fabricatedCitation = scores.some((score) => score.fabricatedCitation === true)
  const permissionViolation = scores.some((score) => score.permissionViolation === true)

  let misload: boolean | undefined
  if (kind === 'ordinary_chat') {
    const observed = scores.map((score) => score.misload).filter((value): value is boolean => value !== undefined)
    misload = observed.some((value) => value === true) ? true : observed.length > 0 ? false : undefined
  }

  return {
    arm,
    taskId: task.taskId,
    kind,
    goalApplicable,
    outcome,
    repeats: total,
    sourceSupport,
    fabricatedCitation,
    permissionViolation,
    misload,
  }
}

/* -------------------------------------------------------------------------
 * 臂级汇总
 * ---------------------------------------------------------------------- */

/**
 * 臂级汇总。
 *
 * **分母 = M2 适用（skill_relevant）任务数**（`tasks`）：重复不加分母（task-spec#analysisNote）。
 *
 * 口径（evaluation.json#metrics[M2].denominator + task-spec#goalDenominator）：
 *  · `tasks` = **只数 M2 适用任务**（本批 4 个 skill_relevant；两臂合计 4 × 2 = 8）
 *    ⇒ ordinary_chat **不进**达成率分母（它们的 expect 为空 ⇒ M2 条件真空成立 ⇒
 *    照算会把普通聊天算成"达成"⇒ 虚增达成率）。
 *  · `ordinaryTasks` = ordinary_chat（M2 不适用）任务数，**单列**。
 *  · `achieved`/`notAchieved`/`unknown`/`aborted` 只统计 M2 适用任务 ⇒ 四者之和 = `tasks`。
 *  · `misloads`：**照旧统计 ordinary_chat**（M6 误加载是它们的区分力，不与技能任务混算）。
 */
export function summarizeArm(
  arm: 'A' | 'B',
  outcomes: readonly P3FiveTaskOutcome[],
  cost?: { readonly requests?: number, readonly tokens?: number, readonly elapsedMs?: number }
): P3FiveArmSummary {
  const applicable = outcomes.filter((item) => outcomeGoalApplicable(item))
  const ordinary = outcomes.filter((item) => !outcomeGoalApplicable(item))
  const count = (outcome: P3FiveGoal | 'aborted'): number =>
    applicable.filter((item) => item.outcome === outcome).length
  return {
    arm,
    tasks: applicable.length,
    achieved: count('achieved'),
    notAchieved: count('not_achieved'),
    unknown: count('unknown'),
    aborted: count('aborted'),
    ordinaryTasks: ordinary.length,
    misloads: outcomes.filter((item) => item.misload === true).length,
    requests: cost?.requests,
    tokens: cost?.tokens,
    elapsedMs: cost?.elapsedMs,
  }
}

/* -------------------------------------------------------------------------
 * A vs B 对照
 * ---------------------------------------------------------------------- */

/** 证据不足：该臂的任务级结论是 unknown 或 aborted（**只对 M2 适用任务有意义**）。 */
function isInsufficient(outcome: P3FiveTaskOutcome): boolean {
  return outcome.outcome === 'unknown' || outcome.outcome === 'aborted'
}

/** 两臂在五个对比维度上是否逐项相同（达成性 / 来源支持 / 误加载 / 虚构 / 权限）。 */
function sameDimensions(a: P3FiveTaskOutcome, b: P3FiveTaskOutcome): boolean {
  return (
    a.outcome === b.outcome &&
    a.sourceSupport === b.sourceSupport &&
    a.misload === b.misload &&
    a.fabricatedCitation === b.fabricatedCitation &&
    a.permissionViolation === b.permissionViolation
  )
}

/**
 * 两臂在**机械项**上是否逐项相同（误加载 / 虚构 / 权限）。
 *
 * ordinary_chat 的对照**只保留**这三项（evaluation.json#comparisonRules 第 3 条：
 * ordinary_chat 不参与 M2 达成性对照，只贡献 M6 误加载、硬门与成本观察）。
 */
function sameMechanicalDimensions(a: P3FiveTaskOutcome, b: P3FiveTaskOutcome): boolean {
  return (
    a.misload === b.misload &&
    a.fabricatedCitation === b.fabricatedCitation &&
    a.permissionViolation === b.permissionViolation
  )
}

/** 某臂缺该任务时的占位结论（repeats=0 的 unknown：没跑就没有证据，不臆造成达）。 */
function missingOutcome(arm: 'A' | 'B', taskId: string, kind: P3FiveTaskKind): P3FiveTaskOutcome {
  return {
    arm,
    taskId,
    kind,
    goalApplicable: resolveGoalApplicable({ kind }),
    outcome: 'unknown',
    repeats: 0,
    sourceSupport: 'unknown',
    fabricatedCitation: false,
    permissionViolation: false,
    misload: kind === 'ordinary_chat' ? false : undefined,
  }
}

/** 单个维度的方向：+1 = A 更好，-1 = B 更好，0 = 打平，null = 该维度不可比。 */
function dimensionSign(a: number | null, b: number | null): -1 | 0 | 1 | null {
  if (a === null || b === null) return null
  if (a === b) return 0
  return a > b ? 1 : -1
}

/**
 * 任务级方向（正数 = A 臂更好，负数 = B 臂更好，0 = 无方向）。
 * 只比较**可比**维度：unknown/aborted 不参与达成性方向（没有证据就不给方向）。
 *
 * `includeAchievement = false` ⇒ **不**比较达成性（M2）与来源支持：
 * 用于 ordinary_chat（口径：ordinary_chat 不参与 M2 达成性对照）。
 */
function directionOf(
  a: P3FiveTaskOutcome,
  b: P3FiveTaskOutcome,
  options: { readonly includeAchievement: boolean }
): number {
  const comparable = options.includeAchievement
  const achievement =
    comparable &&
    a.outcome !== 'unknown' &&
    a.outcome !== 'aborted' &&
    b.outcome !== 'unknown' &&
    b.outcome !== 'aborted'
      ? (a.outcome === 'achieved' ? 2 : 1) - (b.outcome === 'achieved' ? 2 : 1)
      : null
  const sourceSupport =
    comparable && a.sourceSupport !== 'unknown' && b.sourceSupport !== 'unknown'
      ? (a.sourceSupport ? 2 : 0) - (b.sourceSupport ? 2 : 0)
      : null
  const misload =
    a.misload === undefined || b.misload === undefined
      ? null
      : (a.misload ? 0 : 1) - (b.misload ? 0 : 1)
  const fabricated = (a.fabricatedCitation ? 0 : 1) - (b.fabricatedCitation ? 0 : 1)
  const permission = (a.permissionViolation ? 0 : 1) - (b.permissionViolation ? 0 : 1)

  let sum = 0
  for (const sign of [
    dimensionSign(achievement, 0),
    dimensionSign(sourceSupport, 0),
    dimensionSign(misload, 0),
    dimensionSign(fabricated, 0),
    dimensionSign(permission, 0),
  ]) {
    if (sign !== null) sum += sign
  }
  return sum
}

/**
 * A vs B 对照（逐任务配对）。
 *
 * verdict 判定顺序（evaluation.json#comparisonRules 第 3 条 + unknownRules）：
 *  1. 没有任务 ⇒ 'insufficient_evidence'
 *  2. **M2 适用**任务全部证据不足（任一臂 unknown/aborted），且 ordinary_chat 没有机械项差异
 *     ⇒ 'insufficient_evidence'
 *     （**ordinary_chat 不参与这一步**：它们 aborted/unknown **不**把整体降级）
 *  3. **所有**任务两臂结论逐项相同 ⇒ 'compatible'
 *     （ordinary_chat 只比机械项：误加载 / 虚构 / 权限）
 *  4. 否则看有差异且**不是**证据不足的任务：方向是"A 臂更好" ⇒ 'degraded'（迁移退化），
 *     否则 ⇒ 'incompatible'
 *     （ordinary_chat 的机械项差异**始终**可比 ⇒ 它也能把结论推向 incompatible/degraded）
 *  5. 差异全部落在证据不足的任务上 ⇒ 'insufficient_evidence'（判不出来就不猜）
 *
 * `extra.contentIdentical`：由运行器比对两臂注入的技能指纹得出（排序后逐字相同 ⇒ true）。
 * `extra.overhead`：**已算好的** B 臂 − A 臂 差值（用 `computeOverhead` 计算）；
 *   缺任一项 ⇒ 该项 undefined（全缺 ⇒ 整体 'unknown'）。
 */
export function compareArms(
  a: readonly P3FiveTaskOutcome[],
  b: readonly P3FiveTaskOutcome[],
  extra?: {
    readonly contentIdentical?: boolean | 'unknown'
    readonly overhead?: { readonly requests?: number, readonly tokens?: number, readonly elapsedMs?: number }
  }
): P3FiveComparison {
  const taskIds = [...new Set([...a.map((item) => item.taskId), ...b.map((item) => item.taskId)])].sort()
  const perTask: P3FiveTaskComparison[] = taskIds.map((taskId) => {
    const foundA = a.find((item) => item.taskId === taskId)
    const foundB = b.find((item) => item.taskId === taskId)
    const kind = (foundA ?? foundB)?.kind ?? 'skill_relevant'
    const outcomeA = foundA ?? missingOutcome('A', taskId, kind)
    const outcomeB = foundB ?? missingOutcome('B', taskId, kind)
    const goalApplicable = resolveGoalApplicable({
      kind: outcomeA.kind,
      goalApplicable: outcomeA.goalApplicable ?? outcomeB.goalApplicable,
    })
    // M2 适用任务比五个维度；ordinary_chat **只比机械项**（不参与达成性对照）。
    const same = goalApplicable
      ? sameDimensions(outcomeA, outcomeB)
      : sameMechanicalDimensions(outcomeA, outcomeB)
    return { taskId, a: outcomeA, b: outcomeB, sameOutcome: same, goalApplicable }
  })

  let verdict: P3FiveComparison['verdict']
  if (perTask.length === 0) {
    verdict = 'insufficient_evidence'
  } else {
    const goalTasks = perTask.filter((item) => item.goalApplicable === true)
    const ordinaryTasks = perTask.filter((item) => item.goalApplicable !== true)
    const ordinaryDifferences = ordinaryTasks.filter((item) => !item.sameOutcome)
    const goalAllInsufficient =
      goalTasks.length > 0 &&
      goalTasks.every((item) => isInsufficient(item.a) || isInsufficient(item.b))
    const allSame = perTask.every((item) => item.sameOutcome)
    // ordinary_chat 的对照只保留机械项 ⇒ 它的"证据不足"不参与达成性方向，**始终**可比。
    const directional = perTask.filter((item) => {
      if (item.sameOutcome) return false
      if (item.goalApplicable !== true) return true
      return !isInsufficient(item.a) && !isInsufficient(item.b)
    })

    if (goalTasks.length === 0) {
      // 本批没有 M2 适用任务 ⇒ 只看 ordinary_chat 的机械项；不产生 insufficient_evidence。
      if (ordinaryDifferences.length === 0) {
        verdict = 'compatible'
      } else {
        const directions = ordinaryDifferences.map((item) =>
          directionOf(item.a, item.b, { includeAchievement: false })
        )
        const aBetter = directions.some((value) => value > 0)
        const bBetter = directions.some((value) => value < 0)
        verdict = aBetter && !bBetter ? 'degraded' : 'incompatible'
      }
    } else if (goalAllInsufficient && ordinaryDifferences.length === 0) {
      verdict = 'insufficient_evidence'
    } else if (allSame) {
      verdict = 'compatible'
    } else if (directional.length === 0) {
      verdict = 'insufficient_evidence'
    } else {
      const directions = directional.map((item) =>
        directionOf(item.a, item.b, { includeAchievement: item.goalApplicable === true })
      )
      const aBetter = directions.some((value) => value > 0)
      const bBetter = directions.some((value) => value < 0)
      verdict = aBetter && !bBetter ? 'degraded' : 'incompatible'
    }
  }

  const contentIdentical: boolean | 'unknown' = extra?.contentIdentical ?? 'unknown'
  const overheadInput = extra?.overhead
  let overhead: P3FiveComparison['overhead']
  if (
    overheadInput === undefined ||
    (overheadInput.requests === undefined &&
      overheadInput.tokens === undefined &&
      overheadInput.elapsedMs === undefined)
  )
    overhead = 'unknown'
  else
    overhead = {
      requests: overheadInput.requests,
      tokens: overheadInput.tokens,
      elapsedMs: overheadInput.elapsedMs,
    }

  return { verdict, perTask, contentIdentical, overhead }
}

/* -------------------------------------------------------------------------
 * 两个小助手（供运行器使用）
 * ---------------------------------------------------------------------- */

/**
 * M8（迁移兼容 · 内容层）：两臂注入上下文的技能 section 指纹数组**排序后逐字相同** ⇒ true。
 * （指纹为空数组时两臂都是空 ⇒ 逐字相同 ⇒ true；这由调用方保证两臂都采到真实值。）
 */
export function contentIdenticalOf(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort()
  const right = [...b].sort()
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

/**
 * M7（完整成本）的臂间差值：**B 臂 − A 臂**。
 * 缺任一项 ⇒ 该项 undefined；三项全缺 ⇒ 整体 'unknown'。
 */
export function computeOverhead(
  costA: { readonly requests?: number, readonly tokens?: number, readonly elapsedMs?: number },
  costB: { readonly requests?: number, readonly tokens?: number, readonly elapsedMs?: number }
): { readonly requests?: number, readonly tokens?: number, readonly elapsedMs?: number } | 'unknown' {
  const requests =
    costA.requests === undefined || costB.requests === undefined
      ? undefined
      : costB.requests - costA.requests
  const tokens =
    costA.tokens === undefined || costB.tokens === undefined
      ? undefined
      : costB.tokens - costA.tokens
  const elapsedMs =
    costA.elapsedMs === undefined || costB.elapsedMs === undefined
      ? undefined
      : costB.elapsedMs - costA.elapsedMs
  if (requests === undefined && tokens === undefined && elapsedMs === undefined) return 'unknown'
  return { requests, tokens, elapsedMs }
}
