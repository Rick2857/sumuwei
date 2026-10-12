/**
 * MemoryContentExtractor —— **"用户说的这句话，是一条什么样的记忆？"**
 *
 * ============================================================================
 *  它为什么在 M4 的**显式路径**上（而不是只在后台路径上）
 * ============================================================================
 * 计划书第 54 节把显式路径写成：
 *
 *     User Event → ExplicitMemoryIntentDetector → MemoryMutationProposal
 *                → Validation → Memory Domain Event → Commit → 然后才能确认成功
 *
 * 注意 `MemoryMutationProposal` 这一步：光知道"用户要求记住"是不够的，
 * 还必须知道**记住什么**、以及它在数据上长什么样（Claim 还是 Episode？
 * 哪个槽位键？讲的是谁？）。
 *
 * 后台路径由 `memory-extractor` 的 LLM 产出 `MemoryCandidate[]`（Phase 5）；
 * 显式路径**必须**有一个等价的产出方，否则"记住，我不吃香菜"会卡在
 * "有意图、但没有候选"上 —— 而那是一条**用户明确要求却被静默忽略**的路径，
 * 是 M4 最不该出现的行为。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 与意图检测同一个原则：**规则优先，模型兜底**
 * ---------------------------------------------------------------------------
 * 计划书第 60 节把"先走规则"用在意图检测上；这里沿用它，理由是同一个：
 *
 *   · 显式路径是**快路径**，而 CI 必须离线秒级（不能用 API Key）
 *   · 最常见的显式记忆（"我不吃香菜"、"我是大学生"）落在
 *     `memory-predicates.ts` 已登记的槽位上，规则能确定性覆盖
 *   · 规则命中是**可解释的**："这条记忆落在 food.preference.cilantro，
 *     因为用户说了『香菜』+『不吃』" —— 那种解释在审计时价值很高
 *
 * 而规则覆盖不到的说法（"我最近不太能喝奶了"）**不是丢掉了**：
 * 它返回 `undefined`，由调用方决定是走后台路径还是显式追问。
 * 静默丢事实与"如实说没解析出来"是两件事，M4 必须选后者。
 */

import {
  KernelError,
  normalizePredicate,
  registeredPredicates,
  type EntityRef,
  type MemoryContent,
  type MemoryType,
} from '../../contracts/index.ts'

// ---------------------------------------------------------------------------
// 结果
// ---------------------------------------------------------------------------

/**
 * ============================================================================
 *  **规则内容版本**（`content-rules@N`）
 * ============================================================================
 * 它跟着"中文线索词 → 槽位 / 取值边界"这套**解析知识**走：
 * 线索表、`priority`、`cueInValue`、取值前后缀剥法，**任一改动都必须升版本**。
 *
 * ⚠️ **`@2` → `@3`**（2026-09-30，M9.7 / WP1）：**只加线索词与一条新规则**，不动取值边界。
 *    依据是 [`Memory-Coverage-Baseline-Report.md`](../../../../docs/memory-coverage/Memory-Coverage-Baseline-Report.md) §4.3：
 *    登记表声明的 17 个 `examples` 里 **7 个抽不出**，本次补上其中 **5 个**
 *    （`health.sleep.duration` ×2 · `preferred.explanation.style` 的「简单说」·
 *     `education.status` 的「已经毕业」· `food.avoid.general` 的「海鲜过敏」）。
 *    剩下 2 个（`device.primary` 的「我平时用 Windows」· `tooling.preference.editor` 的「我用 VS Code」）
 *    **故意没做**，理由逐条写在 ADR-078 §5。
 *    ⚠️ 版本号进 `basis`（trace / 审计）⇒ "这条值是哪一版规则抽的"必须可回答。
 *
 * ⚠️ **`@3` → `@4`**（2026-09-30，M9.7 / WP1 **增量 2**）：**只加线索词与两条新规则**，
 *    仍然不动取值边界。补的是 `M5` `G1` 点名的两个方向
 *    （`person.birthday` / `person.hometown`，两个槽位本轮**新登记**进
 *    `memory-predicates.ts`）。⚠️ 同一批里的 `relationship` 与 `schedule` **被排除**，
 *    逐条理由见 [`ADR-079`](../../../../docs/adr/ADR-079-m9.7-person-slot-expansion.md) §5。
 *
 * ⚠️ **`@4` → `@5`**（2026-09-30，M9.7 / **取值边界线** · [`ADR-080`](../../../../docs/adr/ADR-080-value-boundary-round-1.md)）：
 *    这一次动的是**取值前后缀剥法**（它同样在那条"任一改动都必须升版本"的清单里）——
 *    ① `normalizeValuePhrase` 多剥一类**尾部填充语**（「就行」…）；
 *    ② 新增**整值级**拒绝 `VALUE_STOP_SET`（一个虚词/疑问词不是一个取值）。
 *    ⚠️ **没有**加任何线索词、**没有**改 `priority` / `cueInValue` —— 那是**另一条线**
 *    （扩覆盖），两处裁定都逐字禁止混着做。
 *
 * ⚠️ 它**不**替代 `processorVersion`：显式记忆落库时记的仍是 `explicit-memory@1`
 *    （见 `explicit-service.ts`）。改那个字段会改变**已落库记录**的来源语义，
 *    属更大的改动 —— 本次刻意不做，只把版本号写进 `basis`（进 trace 与审计读数）。
 *    理由：M6.1 WP5 产品发现② 修的就是"取值边界"，而"这条值是哪一版规则抽的"
 *    必须在下一次实测里可回答，否则复现与归因都无从下手。
 */
/**
 * ============================================================================
 *  **问句守卫**（`L-M97-02`，2026-10-04）—— 一句**问句**不得被抽成一条事实
 * ============================================================================
 * 实测形态（`mc-probe-0001` 与 `L-M97-02`）：一句问句只要**同时**带上抽取意图词，
 * 就会被记成事实 —— 最刺眼的一条是「记住，我实验室在**哪个楼**」这种：
 * 它的取值形态**不在** `VALUE_STOP_SET` 里（那个集合只挡**精确等于**的「什么/哪/几号」），
 * 于是"哪个楼"会被当成一个取值写进去。
 *
 * ---------------------------------------------------------------------------
 *  判据：**两级**，任一级成立即判"像问句"（宁可漏，不要误杀）
 * ---------------------------------------------------------------------------
 * ```text
 * ① 句尾形式：剥掉尾部空白与成对引号后，末字符是 `？` / `?`；
 *    或者末字符是 `吗` / `呢`（且整句不是以 `什么/怎么/那么/多么` 收尾的疑问词本身）
 * ② 疑问词 + **非任指语境**：出现下面 QUESTION_WORDS 之一，且**不**落在任一豁免语境里：
 *    · 前面邻接 `都/也/随便/无论/不管/任何`（任指：「随便哪个都行」）
 *    · 前面邻接 `没/不/别`（否定：「没什么精神」「不觉得我有什么错」）
 *    · 疑问词落在**成对引号内**（引用 / 转述）
 *    · 整句以 `！` 收尾（祈使 / 急迫：「快告诉我总闸在哪！」）
 * ```
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 三条不许踩的线（都是实测/裁定来的，不是风格）
 * ---------------------------------------------------------------------------
 * ```text
 * · **不复用 `VALUE_STOP_SET` 当语气词表**：那个集合含 `了 吧 呢 吗 啊 嘛`，而
 *   「还是叫我阿林吧。」「还是记一下吧：我的实验室在 A 楼 302。」这类**合法陈述**里就有「吧」
 *   ⇒ 拿它当"问句词表"会**误杀**（`L-M97-02` 的反例组逐条记着）。
 * · **不用 `negativeGuards` 表达"问句不命中"**：ADR-088 §6.4 实测两次打回 —— 它只决定取值极性，
 *   **不阻止命中**（`N2`「我实验室在哪来着？」照样抽出）。
 * · **不放宽 `requiresLeading`**：那是 `LV2-D11` 的冻结裁定。
 * ```
 *
 * ⚠️ **这是收窄，不是关闭**（`L-M97-02` 的残余仍在）：它只挡"**整句是一个问句**"这一种形状；
 *    引用、否定、qualifier 表达不了的那部分、以及"陈述句里夹一个问句片段"都在**残留范围**里
 *    （`DR-11`：措辞层没有启发式守卫，本守卫也不主张"她不会再记错"）。
 */
export const QUESTION_WORDS: readonly string[] = [
  '什么时候',
  '什么时候呢',
  '什么',
  '哪个',
  '哪儿',
  '哪里',
  '哪',
  '怎么',
  '为什么',
  '多少',
  '几号',
  '几月几号',
  '几时',
  '何时',
]

export function isQuestionLike(text: string): boolean {
  const trimmed = text
    .trim()
    .replace(/^["'“”「」『』]+/u, '')
    .replace(/["'“”「」『』]+$/u, '')
    .trim()
  if (trimmed === '') return false

  /* ① 句尾形式 */
  if (/[？?]$/u.test(trimmed)) return true
  if (/(吗|呢)$/u.test(trimmed) && !/(什么|怎么|那么|多么)$/u.test(trimmed)) return true

  /* ② 疑问词 + 非任指语境 */
  const hitIndex = trimmed.search(new RegExp(QUESTION_WORDS.join('|'), 'u'))
  if (hitIndex < 0) return false
  const before = trimmed.slice(0, hitIndex)

  if (/[！!]$/u.test(trimmed)) return false // 祈使 / 急迫句
  if (/(都|也|随便|无论|不管|任何)\s*$/u.test(before.slice(-4))) return false // 任指
  if (/(没|不|别)[^，。；！？]{0,3}$/u.test(before)) return false // 否定
  /* 疑问词落在成对引号内 ⇒ 引用 / 转述 */
  const quotePairs: readonly [string, string][] = [
    ['"', '"'],
    ['“', '”'],
    ['「', '」'],
    ['『', '』'],
  ]
  for (const [open, close] of quotePairs) {
    const openAt = trimmed.lastIndexOf(open, hitIndex)
    const closeAt = trimmed.indexOf(close, hitIndex)
    if (openAt >= 0 && closeAt > hitIndex) return false
  }
  return true
}

/**
 * 线索表 / 判据的版本（进 `basis`、进 trace；**任一改动都必须升版本**，见文件头的那条纪律）。
 *
 * ⏩ `@6 → @7`（2026-10-04，`L-M97-02`）：**新增问句守卫**（`isQuestionLike()`）。
 *    它不改线索表、不改 `priority`/`cueInValue`、不改取值前后缀剥法，但**改的是"哪句话会被抽"**
 *    ⇒ 按上面那条纪律必须升版本（不是可选项）。
 */
export const CONTENT_RULE_VERSION = 'content-rules@8'

/** “叫我做事”不表示希望被叫作某个名字。 */
export function isAddressActionRequest(text: string): boolean {
  return !text.includes('称呼我') && /提醒|发消息|叫我(?:去|把|拔|喝|吃|睡|起床|记得|看|做|交|打开|关闭)/u.test(text)
}

export interface ExtractedMemoryContent {
  type: MemoryType
  content: MemoryContent
  subjects: EntityRef[]
  /** 0..1：这个解析有多可信。进候选的 `confidence` */
  confidence: number
  /** 人类可读的解析依据（进 trace 与审计） */
  basis: string
  /** 命中的登记槽位（未命中时为 undefined） */
  predicate?: string
}

export interface MemoryContentExtractor {
  readonly name: string
  /**
   * 从用户那句话里抽出一条记忆内容。
   *
   * 返回 `undefined` = **没能解析成结构化的记忆**（正常结果，不是失败）。
   * 调用方对这种情况的正确反应是"如实告诉用户我没抓住"或者走后台路径，
   * **不是**"随便造一条"。
   */
  extract(input: {
    text: string
    owner: EntityRef
    /** 这句话讲的是谁 —— 通常是从事件解析出的用户 */
    speaker: EntityRef
    /** 更正意图剥离触发词后，仍保留同一事件的完整原话。 */
    correctionSourceText?: string
  }): Promise<ExtractedMemoryContent | undefined>
}

// ---------------------------------------------------------------------------
// 规则实现
// ---------------------------------------------------------------------------

/**
 * 槽位 → 中文线索词。
 *
 * ============================================================================
 *  为什么这张表住在**抽取器**里，而不进 `memory-predicates.ts`
 * ============================================================================
 * `memory-predicates.ts` 的登记表回答的是"这个槽位键合法吗、取值形状是什么"
 * （领域契约）。而"用户说『香菜』就指 `cilantro`"是一条**中文解析知识** ——
 * 它随语言与措辞变化，且只被这一个抽取器使用。
 * 把两者混在一起会让领域登记表变成一本中文同义词词典，
 * 而那份词典的不完整会**静默降低召回**（没有任何测试能守住"词典全不全"）。
 *
 * 因此这里明确标注：**它是不完整的，而且它的不完整是被设计允许的** ——
 * 未命中的说法会落到 `undefined` 并走模型或后台路径，不会丢事实。
 */
interface PredicateRule {
  /**
   * 具体度优先级：**数字大的先判**。
   *
   * `orderedRules()` 会按它排序，因此"哪条规则更专门"是**写在数据里**的，
   * 不是靠表的书写顺序让人去推。用线索词长度当代理是不行的：
   * `education.institution` 与 `education.status` 的线索词都含 '大学'，
   * 长度相同，因此长度排序决不出平局 —— 而平局靠表序决定，
   * 就是"靠巧合运行"。
   */
  priority: number
  /** 必须出现在句中的线索词（任一） */
  cues: readonly string[]
  /** 命中的槽位键 */
  predicate: string
  /**
   * ============================================================================
   *  **线索词本身通常是取值的一部分**（取值在线索词**之前**）
   * ============================================================================
   * 中文机构名一般**以线索词结尾**：
   *
   * ```text
   *   我在**江城大学**读书      ← 「大学」是名字的一部分，不是引导词
   *   我在**示例工程科技大学**   ← 同上
   * ```
   * 而 `education.major` / `device.primary` 那一类恰恰相反，线索词是**引导词**：
   *
   * ```text
   *   我的专业**是**汉语言文学   ← 「专业」引入取值，取值在它之后
   *   我平时用的是 Windows 笔记本
   * ```
   *
   * 这个区别**必须写在数据里**，不能让"先往后、再往前"这一条统一顺序去猜 ——
   * 真实缺陷（M6.1 WP5 产品发现②，2026-09-24）：
   *
   * ```text
   *   记住：我在江城大学读书。        ⇒ education.institution = 「书」   （应为「江城大学」）
   *   更正一下，我转学到明德大学了。  ⇒ education.institution = 「了」   （应为「明德大学」）
   * ```
   * 「往后」那一支把线索词**后面那一句的动词**（读书 / 了）当成了取值，
   * 再经 `normalizeValuePhrase` 剥掉前导系词表里的「读」，剩下一个「书」。
   * 它不报错、长度也合理 ⇒ 只能靠"值内容对不对"发现。
   *
   * 因此：`true` ⇒ 先试"往前"（值 + 线索词），往后**只作兜底**；
   *      缺省（`false`/未填）⇒ 保持原来的"先往后、再往前"。
   */
  cueInValue?: boolean
  /**
   * ============================================================================
   *  这条规则产出的记忆**类型**
   * ============================================================================
   * ⚠️ **必填**，而且是被一个真实缺陷逼出来的。
   *
   * 第一版这里没有这个字段，`extract()` 里写死 `type: 'preference'`。
   * 后果在真库上实测到了：
   *
   *     记住，我现在上的大学是示例工程科技大学
   *     → education.institution = 是示例工程科技大学
   *       类型却是 **preference**（应为 person_fact）
   *
   * 这不是"标签不好看"。`type` 参与 `canonicalKey` 的计算
   * （类型 + subject + predicate），因此：
   *
   *   · 同一件事实经**规则**抽取得到 `preference`，
   *     经**模型**抽取得到 `person_fact` →
   *     两个 canonicalKey → 去重层认不出它们是同一件事
   *   · 值闸的 `DURABILITY` 按类型给分 → 权重错
   *   · 按类型聚合的审计视图把它们分到两组
   *
   * 与 `food.avoid.general` 那次是**同一个形状**的缺陷：
   * 同一事实落到两个槽位，而去重与冲突检测都建立在"落同一槽位"上。
   *
   * 做成必填而不是给默认值：给默认值就等于允许"忘了写"，
   * 而忘了写的表现正是这个缺陷 —— 静默地全算成 preference。
   */
  memoryType: MemoryType
  /** 正向线索（判定取值） */
  positive: Readonly<Record<string, unknown>>
  /** 负向线索 */
  negative: Readonly<Record<string, unknown>>
  /** 该负向线索必须与哪些词共现（避免"我喜欢香菜"被当成"不吃香菜"） */
  negativeGuards?: readonly string[]
}

/**
 * 第一版规则表。
 *
 * ⚠️ **`priority` 是数据，不是注释**：数字大的先判。
 * 更专门的槽位给更高的优先级（"哪所大学"比"什么学历"更专门）。
 * 靠表的书写顺序表达层级是行不通的 —— 那会变成"靠巧合运行"，
 * 而巧合在别人调整表序时会**静默**失效（见 `orderedRules()` 的说明）。
 */
const PREDICATE_RULES: readonly PredicateRule[] = [
  {
    // 5 = 最专门：机构名。⚠️ 它的 cue 表含 '大学'，与下面的
    // `education.status` 的 '大学生' 会同时命中 —— 因此这个优先级
    // 不是锦上添花，而是"我在示例工程科技大学"不被记成
    // "我在读本科"的**唯一**保证。
    priority: 5,
    cues: ['学校', '大学', '院校', '学院', '就读'],
    predicate: 'education.institution',
    /*
     * ⚠️ **必须为 true**：机构名的线索词是名字的一部分（「江城**大学**」），
     *    而它后面常常紧跟下一句的动词（「…大学**读书**」）—— 见 `cueInValue` 上的实测记录。
     */
    cueInValue: true,
    memoryType: 'person_fact',
    positive: {},
    negative: {},
  },
  // --- 饮食偏好 -----------------------------------------------------------
  {
    priority: 4,
    cues: ['香菜', '芫荽', 'cilantro'],
    predicate: 'food.preference.cilantro',
    memoryType: 'preference',
    positive: { value: 'like' },
    negative: { value: 'dislike' },
    negativeGuards: ['不吃', '不喜欢', '受不了', '讨厌', '别放', '不要'],
  },
  {
    priority: 4,
    /*
     * ⚠️ M9.7 / WP1（2026-09-30）：登记表第 2 个例子「海鲜过敏」**故意没补**，理由**不是**省事：
     *    这条规则的取值是**短语专属**的（`positive: '喜欢辣'` / `negative: '回避辣'`），
     *    把「海鲜过敏」挂进来 ⇒ 它不含任何 `negativeGuards` ⇒ 会落到 `positive`
     *    ⇒ 系统记下 **`food.avoid.general = 喜欢辣`**。
     *    那是**语义错误**（不报错、不丢事实、只是记错了）—— 正是本文件 `:523-525` 记下的
     *    那类最坏的缺陷（"第一版只有 A，于是『我是大学生』被记成『学校 = 大学生』"）。
     *    ⇒ 要补它，**先要裁定这个槽位的取值语义**（新规则 + 自己的取值，属 WP1 增量 2）。
     *    ⚠️ 这条教训一般化：**往一条已有规则上挂线索词，只有在该规则的取值不是短语专属时才安全。**
     */
    cues: ['辣', '辣椒'],
    predicate: 'food.avoid.general',
    memoryType: 'preference',
    positive: { value: '喜欢辣' },
    negative: { value: '回避辣' },
    negativeGuards: ['不吃', '不喜欢', '受不了', '讨厌', '别放', '不要'],
  },
  // --- 学历 ---------------------------------------------------------------
  {
    priority: 3,
    cues: ['研究生', '硕士'],
    predicate: 'education.status',
    memoryType: 'person_fact',
    positive: { value: 'graduate' },
    negative: {},
  },
  {
    priority: 3,
    cues: ['大学生', '本科', '在读生'],
    predicate: 'education.status',
    memoryType: 'person_fact',
    positive: { value: 'undergraduate' },
    negative: {},
  },
  {
    /*
     * ⚠️ M9.7 / WP1（2026-09-30）：补上登记表自己声明的例子「我已经毕业了」。
     *    该槽位的 `allowed` 枚举里**本来就有** `graduated`，但线索表里没有任何说法指向它
     *    ⇒ 登记了也抽不出（基线报告 §4.3）。
     * ⚠️ 线索词**故意收窄**到「已经毕业 / 已毕业」，**不**收裸的「毕业」：
     *    · 「还没毕业」不该被记成"已毕业"（假阳）
     *    · 「快毕业了」同上
     *    · 「我毕业于 X 大学」由 `education.institution`（priority 5 的 '大学'）接走
     *    ⇒ 覆盖面小一点可以接受，记错不可以（任务书 §19 的既有立场）。
     */
    priority: 3,
    cues: ['已经毕业', '已毕业'],
    predicate: 'education.status',
    memoryType: 'person_fact',
    positive: { value: 'graduated' },
    negative: {},
  },
  // --- 专业 ---------------------------------------------------------------
  {
    priority: 3,
    cues: ['专业', '学的是', '学的'],
    predicate: 'education.major',
    memoryType: 'person_fact',
    positive: {},
    negative: {},
  },
  // --- 交互偏好 -----------------------------------------------------------
  {
    priority: 3,
    cues: ['详细解释', '详细说', '展开讲', '详细一点'],
    predicate: 'preferred.explanation.style',
    memoryType: 'preference',
    positive: { value: 'detailed' },
    negative: { value: 'brief' },
    negativeGuards: ['简洁', '简短', '简单点', '简略', '不要太长'],
  },
  {
    priority: 3,
    /*
     * ⚠️ M9.7 / WP1（2026-09-30）：补上登记表自己声明的第 2 个例子「现在简单说就行」。
     *    它原先抽不出，因为 brief 这一支的 cues 是 ['简洁','简短','简单点','简略','不要太长']
     *    ——「简单说」一个都不命中（基线报告 §4.3）。
     *    ⚠️ **不**把它加进上面 detailed 那一支的 `negativeGuards`：那会让
     *    「详细解释，别简单说」被翻成 brief。两句同时命中时，`best` 取**更长的线索词**
     *    （'详细解释' 4 字 > '简单说' 3 字）⇒ detailed 仍然胜出。
     */
    cues: ['简洁', '简短', '简单点', '简略', '不要太长', '简单说'],
    predicate: 'preferred.explanation.style',
    memoryType: 'preference',
    positive: { value: 'brief' },
    negative: {},
  },
  {
    priority: 3,
    cues: ['叫我', '称呼我', '可以叫我'],
    predicate: 'preferred.address',
    memoryType: 'preference',
    positive: {},
    negative: {},
  },
  // --- 项目 / 设备 / 工具 --------------------------------------------------
  {
    priority: 3,
    cues: ['项目', '在做', '在搞', '在写'],
    predicate: 'project.background.active',
    memoryType: 'person_fact',
    positive: {},
    negative: {},
  },
  {
    /*
     * `ADR-088`（Lv2 `LV2-D13`；用户 2026-10-02 批准冻结）· `D-88a`：**新增** `education.lab`。
     *
     * 出身：Lv2 的 `C05-04` 两轮皆红，离线诊断 `F4` 量到「还是记一下吧：我的实验室在 A 楼 302。」
     *   **意图已通但抽取读不出槽位** ⇒ `content_unresolved` ⇒ 链走不到"复活"那一步
     *   （所以该案现读**不能**当"复活失败"的证据，`D-88d`）。
     *
     * ⚠️ **已知边界的正确说法**（实测 + 读码之后，见 `ADR-088` §6.4）：
     *   · `negativeGuards`（:216）**不阻止命中** —— 它在 :775-779 只决定"取负面值"。
     *     所以"问句不得命中"**不能**用那个字段表达（第一版试过，负控 `N2` 照样命中）。
     *   · **真正的门在意图层**：问句（「我实验室在哪来着？」）拿不到 `remember` 意图
     *     ⇒ 服务根本不会被调用 ⇒ **不会写入**。诊断的 `N2` 判定正是这一条（`intent=—` 且无写入）。
     *   · 仍存的边界：若出现"**问句 + remember 意图**"的组合（例如"记住我实验室在哪"），
     *     抽取器会从线索词后取自由文本 ⇒ 可能写下不合适的取值。
     *     ⇒ 按 `D-88c` **如实登记**，不为它放宽或发明启发式。
     */
    priority: 3,
    cues: ['实验室'],
    predicate: 'education.lab',
    memoryType: 'person_fact',
    positive: {},
    negative: {},
  },
  {
    priority: 3,
    cues: [
      '电脑',
      '设备',
      '系统',
      '用的是',
      /*
       * `ADR-088` · `D-88a`：补**有标记**的更正/陈述说法。
       * ⚠️ **裸的「还是 X」本次不加**（`ADR-088` §6.2③）：它在非更正语境里大量出现
       *    （"还是算了"/"还是不要了"），而本抽取器"命中线索词后取其后文本"
       *    ⇒ 会把"算了"读成取值 = **假阳**。需复合条件 ⇒ 按 `D-88e` 另案。
       */
      '换成',
      '改成了',
      '我换',
    ],
    predicate: 'device.primary',
    memoryType: 'person_fact',
    positive: {},
    negative: {},
  },
  {
    priority: 3,
    cues: ['编辑器', 'ide', 'vscode', 'neovim', 'idea'],
    predicate: 'tooling.preference.editor',
    memoryType: 'preference',
    positive: {},
    negative: {},
  },
  {
    /*
     * ⚠️ M9.7 / WP1（2026-09-30）：这是**整条槽位一条规则都没有**的那一个。
     *    `health.sleep.duration` 是 M9.5 为"数字/单位"难例**追加**进登记表的
     *    （`memory-predicates.ts:219-232`），它的两个 `examples`
     *    （「我每天睡 7 小时」/「我每天睡 420 分钟」）在基线里**都抽不出**（基线报告 §4.3）。
     * ⚠️ 线索词**故意收窄**到「每天睡」：裸的「睡」会把「我睡不着」「我睡不好」
     *    也记成一条"睡眠时长"——那是**假阳**（`Coverage 不完美可以接受，
     *    False Success 不可接受`；任务书 §19 的既有立场）。
     * ⚠️ 取值形状是 `text`（登记表如此）⇒ 走**自由文本**那一支：
     *    `positive` 为空 ⇒ 由 `extractFreeTextValue` 从线索词之后取（「每天睡 **7 小时**」）。
     * ⚠️ `memoryType: 'person_fact'`：它是"关于用户的一个事实"，不是偏好。
     *    ⚠️ 这个选择会影响 `canonicalKey` 与去重 ⇒ 必须与登记表的意图一致。
     */
    priority: 3,
    cues: ['每天睡'],
    predicate: 'health.sleep.duration',
    memoryType: 'person_fact',
    positive: {},
    negative: {},
  },
  {
    /*
     * M9.7 / WP1 **增量 2**（2026-09-30）：`person.birthday` —— 登记表本轮新增的槽位。
     * 依据：`M5` 的 `G1` 逐字点名 birthday / hometown 是"将来要扩覆盖面时的**独立阶段**"。
     *
     * ⚠️ **一条已知的假阳路径，如实登记、并已被量出来**：本抽取器**没有问句守卫**
     *    （全仓 grep 无 `isQuestion` 一类实现）⇒「我的生日是**什么时候**」也会命中，
     *    取值会变成「什么时候」。语料里有一条专门的探针（`mc-probe-0001`）把它量出来。
     *    ⚠️ 今天这条路径**够不到生产**：唯一接线的显式路径要求用户先说「记住」，
     *    而后台路径（`CHARACTER_MEMORY_BACKGROUND_ENABLED`）是 **NOT-WIRED**。
     *    真要修它需要**问句守卫** —— 那是**行为变更**，不在"只扩线索表"的授权内（见 ADR-079 §5）。
     */
    priority: 3,
    cues: ['生日'],
    predicate: 'person.birthday',
    memoryType: 'person_fact',
    positive: {},
    negative: {},
  },
  {
    /*
     * M9.7 / WP1 **增量 2**（2026-09-30）：`person.hometown` —— 登记表本轮新增的槽位。
     * 取值走自由文本那一支：`normalizeValuePhrase` 会剥掉**紧贴值首**的系词/介词
     * （`(是|在|叫|为|有|于|读)`，见 `:414`）⇒「我老家**在**成都」得到「成都」。
     */
    priority: 3,
    cues: ['老家', '家乡', '故乡'],
    predicate: 'person.hometown',
    memoryType: 'person_fact',
    positive: {},
    negative: {},
  },
]

/**
 * 从 payload 里剥掉"关于 / 这件事 / 的偏好"这类外壳，得到可当取值用的短语。
 *
 * ⚠️ **前导系词也必须剥掉**（实测踩到过）。
 *
 * 真库上的实际结果：
 *
 *     记住，我现在上的大学是示例工程科技大学
 *     → education.institution = **是**示例工程科技大学
 *
 * 那个"是"从"往后"那一支漏进来的：线索词「大学」之后是
 * "是示例工程科技大学"，而第一版只剥 `关于|我|我的`，于是系词留在了值里。
 *
 * 它不报错、长度也合理、**看起来像个正常的字符串** ——
 * 只是每一条自由文本取值都可能带一个多余的系词，
 * 而那个值会参与 `canonicalKey`（于是同一事实写成
 * "示例工程科技大学"与"是示例工程科技大学"算两个槽位）。
 *
 * 剥的是**紧贴值首的一个**系词/介词，不是全文替换：
 * "是示例工程科技大学"里的"是"要去掉，而"西安"里的字一个都不能动。
 */
function normalizeValuePhrase(text: string): string {
  return text
    .replace(/^[\s，,。.：:；;]+/, '')
    .replace(/[。.！!？?~～]+$/, '')
    .replace(/^(关于|我|我的)/, '')
    // 前导系词 / 介词：「大学**是**示例工程科技大学」的"是"不属于值
    .replace(/^(是|在|叫|为|有|于|读)/, '')
    .replace(/(这件事|这个事情|的偏好|这个偏好|的这件事)$/, '')
    /*
     * ⚠️ M9.7 / ADR-080（2026-09-30）：**尾部的填充语**也不属于值。
     * 实测：「叫我 Alex 就行」⇒ 原取值「Alex 就行」（尾部「就行」留着）⇒ 现在剥成「Alex」。
     * ⚠️ 只收**明确的填充语**，不收裸的「吧/呢/吗」—— 那几个是**整值级**的拒绝，
     *    由 `VALUE_STOP_SET` 承担（两者分工：这里剥尾巴，那里否掉整个值）。
     */
    .replace(/(就行|就好了|就好|就可以了|可以了)$/, '')
    .trim()
}

/**
 * 取值前缀里的**引导成分**（取值在线索词之前时，紧贴在名字前面的那一小段）。
 *
 * 与线索词表同一条立场：**它不完整，而且它的不完整是被设计允许的** ——
 * 没命中的形式会留下一个带引导词的取值（可审计、难看），而不是静默丢掉事实。
 *
 * ⚠️ 顺序无关紧要（这里按长度降序扫，最长命中优先），但**粒度**要紧：
 *    只用单字「在」「是」会把地名首字吃掉 ——
 *
 * ```text
 *   我在**上海**交通大学   ← 若按"最后一个单字标记"切，会把「上」当边界 ⇒ 值变成「海交通大学」
 * ```
 *    按**词组**匹配就不会：`我在` 是最长命中，切出来是「上海交通」+「大学」。
 */
const VALUE_PREFIX_GUIDES: readonly string[] = [
  '我就读于',
  '我转学到了',
  '我毕业于',
  '我考上了',
  '我搬到了',
  '我换到了',
  '我在读',
  '我转学到',
  '转学到了',
  '转学到',
  '我转到了',
  '我转到',
  '转到了',
  '转到',
  '毕业于',
  '考上了',
  '搬到了',
  '换到了',
  '我在',
  '我是',
  '我叫',
  '我读',
  '我不在',
  '不在',
  '来自',
  '我的',
  '我',
]

/**
 * 取值前缀**看起来不像名字**时的收尾字符（这些字符说明前面那段是修饰语/动词短语，不是名字）。
 *
 * 用途只有一个：**"取值在线索词之前"这一支的接受判定**。
 * 例：「**我现在上的**大学是示例工程科技大学」—— 往前切会得到「我现在上的大学」，
 * 它以一个「的」收尾 ⇒ 判成"不像名字" ⇒ 交给"往后"那一支（那里有系词「是」）。
 */
const VALUE_PREFIX_REJECT_TAIL = /[的地得了个是在到从把被所中上下着过]$/

/**
 * ============================================================================
 *  **一个虚词 / 疑问词不是一个取值**（M9.7 / ADR-080，2026-09-30）
 * ============================================================================
 * 判据：**精确等于**下面这些串 ⇒ 这条规则的抽取**终止**（如实返回 `undefined` ⇒
 * 服务回 `content_unresolved`），而**不是**"换另一支再试试"。
 *
 * 为什么宁可**少记**也不记：任务书 §19 的既有立场是
 * **Coverage 不完美可以接受，False Success 不可接受** —— 记下
 * `education.major = 「的」`、`person.birthday = 「什么时候」` 这类值，
 * 是一条**会被召回、会被展示给模型**的错记忆，比"她如实说没抓住"更坏。
 *
 * ⚠️ **逐条出处**（不许凭空加）：
 *   · **实测**：「的」（`mc-registry-0006`「我不是计算机专业的」）·
 *     「什么时候」（`mc-probe-0001`「我的生日是什么时候」）
 *   · **同类的推断扩展**（与上面两条同一词类，未逐条单独实测）：
 *     结构/语气助词「了 吧 呢 吗 啊 嘛」· 疑问词「什么 哪 哪个 哪儿 哪里 几号 几月几号 多少 怎么 为什么」
 *
 * ⚠️ **它不判句子的语气**（那是"问句守卫"的事，**未做**，见 `L-M97-02`）：
 *    这里只看**取值本身**是不是一个可用的取值。副作用：问句里那种"取值是疑问词"的
 *    假阳**在取值这一层被挡住了**（`L-M97-02` 因此收窄，但**没有**关闭）。
 *
 * ⚠️ **与 `VALUE_PREFIX_REJECT_TAIL` 的分工**：那一条判"前缀像不像名字"（只作用于"往前"那一支）；
 *    这一条判"最终取值本身是不是一个值"（对两支都生效）。
 *
 * ⚠️ **导出它是给量具用的**（`pnpm extractor:value-boundary:verify` 的负控②：证明
 *    "**精确等于**"这个选择是 load-bearing 的 —— 换成"包含"会误杀合法取值）。
 */
export const VALUE_STOP_SET: ReadonlySet<string> = new Set([
  // —— 实测（两条）——
  '的',
  '什么时候',
  // —— 同类的推断扩展：结构 / 语气助词 ——
  '了',
  '吧',
  '呢',
  '吗',
  '啊',
  '嘛',
  // —— 同类的推断扩展：疑问词 ——
  '什么',
  '哪',
  '哪个',
  '哪儿',
  '哪里',
  '几号',
  '几月几号',
  '多少',
  '怎么',
  '为什么',
])

/**
 * "取值在线索词之前"这一支：`[引导成分] + 名字 + 线索词`。
 *
 * 返回 `undefined` = 这一支给不出值（前缀为空）。
 * 返回 `looksLikeName` = 前缀是否**看起来像名字**（不以修饰语收尾）；**调用方**决定是否据此拒绝。
 */
function beforeCueValue(text: string, cue: string): { value: string; looksLikeName: boolean } | undefined {
  const index = text.indexOf(cue)
  if (index < 0) return undefined
  const before = text.slice(0, index)
  /* 只取**最后一段**（用标点、空白切开），否则会把"我在"也吃进机构名里 */
  const lastSegment = before
    .split(/[\s，,。.：:；;！!？?~～]+/)
    .filter((s) => s !== '')
    .pop()
  if (lastSegment === undefined) return undefined

  /* 剥掉紧贴在名字前面的引导成分（取**最长**命中） */
  const guide = [...VALUE_PREFIX_GUIDES]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => lastSegment.startsWith(candidate))
  const cleaned = guide === undefined ? lastSegment : lastSegment.slice(guide.length)
  if (cleaned === '') return undefined

  /*
   * ⚠️ 必须把**线索词本身接回来**（实测踩到过）。
   *
   * 取值在线索词之前时，线索词通常是那个值的**组成部分**：
   *
   *     我在示例工程科技大学
   *          └──── 值 ────┘
   *                    └ 线索词 '大学' 也是名字的一部分
   *
   * 第一版只取 `before` 的最后一段，于是返回值是 **'示例工程科技'**
   * —— 少了"大学"两个字，写进库里的机构名是错的。
   * 它不报错、长度也合理，只是**学校的名字不对**。
   *
   * 为什么只对"往前"这一支接回来（"往后"那一支不接）：
   *   · 往后的形式是 "学的是 **计算机**" —— 线索词是**引导词**，不属于值
   *   · 往前的形式是 "**示例工程科技大学**" —— 线索词是值的一部分
   * 这个区别来自中文的语序，不是约定的选择。
   */
  const value = normalizeValuePhrase(`${cleaned}${cue}`)
  if (value === '' || value.length > 60) return undefined
  return { value, looksLikeName: !VALUE_PREFIX_REJECT_TAIL.test(cleaned) }
}

/**
 * 抽出自由文本槽位的取值。
 *
 * ============================================================================
 *  必须**双向**找（实测踩到过）
 * ============================================================================
 * 中文机构名一般在线索词**之前**：
 *
 *     我在示例工程科技大学     ← 值在线索词 '大学' **之前**
 *     我学的是计算机           ← 值在线索词 '学的是' **之后**
 *
 * 第一版只往后找，于是 `education.institution` 永远抽不出值
 * （"示例工程科技大学"恰好以 '大学' 结尾，往后是空串）。
 * 而那个缺陷的症状是**静默丢弃**：抽取器返回 undefined，
 * 服务回报 `content_unresolved` —— 用户明确要求记住却被忽略。
 *
 * ============================================================================
 *  ⚠️ 顺序**不能**统一：由 `cueInValue` 决定先试哪一支（2026-09-24 实测换来的）
 * ============================================================================
 * 统一的"先往后、再往前"会把**线索词后面那一句的动词**当成取值：
 * 「我在江城大学读书。」⇒「书」·「我转学到明德大学了。」⇒「了」。
 * 因此：
 * ```text
 *   cueInValue = true   先"往前"（值 + 线索词），且**只在它看起来像名字时**才接受；
 *                       否则落到"往后"（那里通常是系词：「大学**是**示例工程科技大学」）
 *   cueInValue = false  保持原来的"先往后、再往前"
 * ```
 *
 * ⚠️ **导出它是给量具用的**（`pnpm extractor:value-boundary:verify` 的**负控①**：
 *    把这一层判据**关掉**（直接调 raw）⇒ 那两条垃圾取值必须**重新出现**
 *    ⇒ 证明这道判据是 load-bearing 的，而不是"什么都不检查"）。
 */
export function extractFreeTextValueRaw(text: string, cue: string, cueInValue = false): string | undefined {
  const afterCueValue = (): string | undefined => {
    const index = text.indexOf(cue)
    if (index < 0) return undefined
    const after = normalizeValuePhrase(text.slice(index + cue.length))
    return after !== '' && after.length <= 60 ? after : undefined
  }

  if (cueInValue) {
    const before = beforeCueValue(text, cue)
    /* 往前这一支只在"前缀看起来像名字"时胜出 —— 否则它多半切到了修饰语 */
    if (before !== undefined && before.looksLikeName) return before.value
    const after = afterCueValue()
    if (after !== undefined) return after
    return before?.value
  }

  /* ① 往后：值在线索词之后（"我学的是计算机"） */
  const after = afterCueValue()
  if (after !== undefined) return after

  /* ② 往前：值在线索词之前（"我在示例工程科技大学"） */
  return beforeCueValue(text, cue)?.value
}

/**
 * 自由文本槽位的取值 —— **对外的那一个**（`extractFreeTextValueRaw` 外面的一层判据）。
 *
 * ⚠️ M9.7 / ADR-080（2026-09-30）：**终止**语义在这里。
 *
 * ```text
 *   raw 返回 undefined  = 两支都给不出 ⇒ 本来就没抓住（正常）
 *   raw 返回一个虚词/疑问词 = **判定它不是一个取值** ⇒ 这里改成 undefined（如实"没抓住"）
 * ```
 *
 * ⚠️ 关键区别：**不**回退去试另一支。理由是实测出来的 ——
 *    对「我不是计算机专业的」，"往后"那一支给出「的」（虚词），而"往前"那一支会给出
 *    「不是计算机专业」（**把否定也当成取值**）⇒ 回退只会换一个错值，
 *    并不会得到一个对值。⇒ 如实说没抓住，比记一个错值好（`False Success 不可接受`）。
 *
 * ⚠️ **它不判语气**：这里只看取值本身（见 `VALUE_STOP_SET` 的说明）。
 *
 * ⚠️ **导出它是给量具用的**（`pnpm extractor:value-boundary:verify` 的**正控**：
 *    逐条比对"生产判据给出的取值"与"声明的取值"）。
 */
export function extractFreeTextValue(text: string, cue: string, cueInValue = false): string | undefined {
  const value = extractFreeTextValueRaw(text, cue, cueInValue)
  if (value === undefined) return undefined
  if (VALUE_STOP_SET.has(value)) return undefined
  return value
}

export class RuleBasedContentExtractor implements MemoryContentExtractor {
  readonly name = 'rule-content-extractor'

  /**
   * ⚠️ `questionGuard = false` **只给量具的负控用**（"摘掉守卫 ⇒ 那句话必须**又**被抽出来"），
   *    生产入口一律走缺省的 `true`（`createRuleOnlyContentExtractor()` 与 `ChainedContentExtractor` 都是）。
   */
  constructor(private readonly questionGuard: boolean = true) {}

  /**
   * 取出**所有**命中规则，再按"具体度"决出胜者。
   *
   * ============================================================================
   *  ⚠️ 两条判据缺一不可（都是实测踩出来的）
   * ============================================================================
   * 判据 A（`priority` 大的先判）：解决**线索词不同**的遮蔽。
   *   例：'示例工程科技大学' 里 institution 的 '大学' 与 status 的
   *   '大学生' —— 后者不命中，因此这一条不涉及 A。
   *
   * 判据 B（**命中线索词更长者胜**）：解决**线索词互相包含**的遮蔽。
   *   例：'我现在是大学生' 里 institution 的 '大学' 与 status 的
   *   '大学生' **都命中**，而 B 让更长的 '大学生' 胜出 → 落到 status。
   *
   * 第一版只有 A（当时还是"表序"），于是 '大学生' 被 institution 的
   * '大学' 抢走 —— "我是大学生"会被记成「学校 = 大学生」。
   * 那是一个**语义错误**：不报错、不丢事实，只是记错了。
   *
   * 顺序：先按 priority 降序（A），同一 priority 内按命中的线索词长度降序（B）。
   * 两者都相同时保持表序（`Array.prototype.sort` 稳定）。
   */
  private static orderedRules(): readonly PredicateRule[] {
    return [...PREDICATE_RULES].sort((a, b) => b.priority - a.priority)
  }

  async extract(input: {
    text: string
    owner: EntityRef
    speaker: EntityRef
    correctionSourceText?: string
  }): Promise<ExtractedMemoryContent | undefined> {
    const text = input.text.trim()
    if (text === '') return undefined
    // ADR-089：自我更正与单个设备名缺一不可；「还是算了」与裸省略语不成为事实。
    const deviceReversion = /^(?:我(?:刚才)?说错了|我(?:刚才)?记错了|更正一下)[，,：:\s]*还是\s*(Windows|Linux|macOS)[。！!\s]*$/i.exec(input.correctionSourceText?.trim() ?? text)
    if (deviceReversion !== null) {
      const value = ({ windows: 'Windows', linux: 'Linux', macos: 'macOS' } as const)[deviceReversion[1]!.toLowerCase() as 'windows' | 'linux' | 'macos']
      return { type: 'person_fact', content: { kind: 'claim', subject: input.speaker, predicate: 'device.primary', value },
        subjects: [input.speaker], confidence: 0.8, predicate: 'device.primary',
        basis: `明确自我更正与设备名 → device.primary（规则 ${CONTENT_RULE_VERSION}）` }
    }

    // --- ① 收集所有命中，记下**实际命中的那个线索词**（判据 B 需要它）------
    /*
     * `L-M97-02` **问句守卫**（2026-10-04）：整句是一个问句 ⇒ **如实不抽取**
     * （返回 `undefined` ⇒ 服务回 `content_unresolved`，**不新增失败码**、不改回复真话链）。
     * 位置刻意在**设备更正白名单之后**：那一条是正则确证的窄特例（ADR-089），不动它。
     */
    const questionTarget = input.correctionSourceText?.trim() || text
    if (this.questionGuard && isQuestionLike(questionTarget)) return undefined

    const hits = RuleBasedContentExtractor.orderedRules()
      .map((rule) => {
        // “叫我拔插头/提醒我”是行动请求，不是称呼偏好；明确“称呼我”仍可记。
        if (rule.predicate === 'preferred.address' && isAddressActionRequest(text)) return undefined
        // 同一规则内取**最长**的命中线索词：
        // institution 的 cues 里有 '学校'/'大学'/'院校'/'学院'/'就读'，
        // 对"我在示例工程科技大学"只有 '大学' 命中；对"我在学校"只有 '学校'。
        const matched = rule.cues
          .filter((cue) => text.includes(cue))
          .sort((a, b) => b.length - a.length)[0]
        return matched === undefined ? undefined : { rule, matched }
      })
      .filter((hit): hit is { rule: PredicateRule; matched: string } => hit !== undefined)

    if (hits.length === 0) return undefined

    // --- ② 判据 B：命中的线索词是另一个命中线索词的子串时，长的那条胜 -----
    const best = hits.find(
      (candidate) =>
        !hits.some(
          (other) =>
            other.matched.length > candidate.matched.length &&
            other.matched.includes(candidate.matched)
        )
    )
    if (best === undefined) return undefined

    const rule = best.rule
    const cue = best.matched

    // --- ③ 判定取值 -------------------------------------------------------
    {
      // 负向线索优先：用户说"不吃香菜"时，"不吃"比"香菜"更能定取值
      const guardHit = rule.negativeGuards?.find((guard) => text.includes(guard)) ?? undefined

      let value: unknown
      if (guardHit !== undefined) {
        value = rule.negative.value
      } else if (Object.keys(rule.positive).length > 0) {
        value = rule.positive.value
      } else {
        // 自由文本槽位：从线索词前后取（顺序由规则的 `cueInValue` 决定）
        value = extractFreeTextValue(text, cue, rule.cueInValue === true)
        if (value === undefined) return undefined
      }

      const predicate = normalizePredicate(rule.predicate)

      return {
        /*
         * ⚠️ 类型取自**规则**，不是写死的 `'preference'`。
         *
         * 第一版在这里写死 `type: 'preference'`，于是
         * `education.institution`（机构名，应为 person_fact）被记成
         * 偏好 —— 而 type 参与 `canonicalKey`，所以同一件事实经规则抽取
         * 与经模型抽取会落到**两个槽位**，去重层认不出它们是一件事。
         *
         * 见 `PredicateRule.memoryType` 上的说明。
         */
        type: rule.memoryType,
        content: {
          kind: 'claim',
          subject: input.speaker,
          predicate,
          value,
        },
        subjects: [input.speaker],
        // 规则命中给 0.8：它确定性很高，但"线索词 → 槽位"这一步是启发式的，
        // 不该给满分（满分应当留给"用户明确说出了槽位"的情况）
        confidence: 0.8,
        basis: `线索词「${cue}」→ 槽位 ${predicate}（规则 ${CONTENT_RULE_VERSION}）${
          guardHit !== undefined ? `（负向线索「${guardHit}」定取值）` : ''
        }`,
        predicate,
      }
    }
  }
}

/**
 * 生产用的实现：交给模型，但**把输出关进契约**。
 *
 * ⚠️ 它当前**没有**被接上（Phase 5 会接）。
 * 现在写出来是因为显式路径的装配点需要它存在，
 * 而"先有一个明确未接上的实现"比"留一个 TODO"更容易被审阅发现。
 */
export class LlmContentExtractor implements MemoryContentExtractor {
  readonly name = 'llm-content-extractor'

  private readonly invokeModel: (prompt: string) => Promise<string>

  constructor(deps: { invokeModel: (prompt: string) => Promise<string> }) {
    this.invokeModel = deps.invokeModel
  }

  async extract(input: {
    text: string
    owner: EntityRef
    speaker: EntityRef
  }): Promise<ExtractedMemoryContent | undefined> {
    /*
     * `L-M97-02` **问句守卫**（2026-10-04）：与规则抽取器同一道判据，位置在**构造 prompt 之前**
     * ⇒ 既不改模型行为、也不再多花一次调用（问句根本不会进模型）。
     */
    if (isQuestionLike(input.text)) return undefined
    const known = registeredPredicates().map(({ key, description, allowed }) => ({ key, description, allowed }))
    const prompt = [
      '把下面这句话抽成一条结构化记忆。只输出 JSON，不要解释。',
      '只提取说话人明确陈述的事实或偏好，保留否定；不要把引用、假设、疑问或要求执行的指令当事实。',
      '',
      '形状：',
      '{"predicate":"<槽位键>","value":<任意 JSON>,"type":"preference"|"person_fact"}',
      '',
      `已登记的槽位规格（优先用它们，枚举取值使用 allowed；确实没有合适的才自造一个点分隔小写键）：${JSON.stringify(known)}`,
      '',
      `句子：${input.text}`,
    ].join('\n')

    let raw: string
    try {
      raw = await this.invokeModel(prompt)
    } catch {
      // 模型调用失败 → 如实返回"没抽出来"，由调用方决定怎么办。
      // 这里是**分类/抽取**失败，不是记忆写入失败，因此可以吞
      // （与 `LlmMemoryIntentClassifier` 同一条理由）。
      return undefined
    }

    const parsed = parseExtractionJson(raw)
    if (parsed === undefined) return undefined

    // 模型自造的 predicate 也要过规范化与登记查询 —— 但**未登记也允许**
    // （计划书第 19 节："足够稳定即可，不追求世界知识图谱"）。
    let predicate: string
    try {
      predicate = normalizePredicate(parsed.predicate)
    } catch {
      return undefined
    }

    const registered = registeredPredicates().some((s) => s.key === predicate)
    if (predicate === 'preferred.address' && isAddressActionRequest(input.text)) return undefined

    return {
      type: parsed.type === 'person_fact' ? 'person_fact' : 'preference',
      content: {
        kind: 'claim',
        subject: input.speaker,
        predicate,
        value: parsed.value,
        ...(parsed.qualifiers !== undefined ? { qualifiers: parsed.qualifiers } : {}),
      },
      subjects: [input.speaker],
      confidence: registered ? 0.75 : 0.6,
      basis: `模型抽取 → 槽位 ${predicate}${registered ? '（已登记）' : '（未登记）'}`,
      predicate,
    }
  }
}

function parseExtractionJson(
  raw: string
): { predicate: string; value: unknown; type?: string; qualifiers?: Record<string, unknown> } | undefined {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    // ⚠️ 失败时**不尝试修复 JSON**（计划书第 146 节：
    // "不能自动尝试猜 JSON"）。猜出来的东西会被当成一条真实记忆写下去。
    return undefined
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.predicate !== 'string' || record.predicate.trim() === '') return undefined
  if (!('value' in record)) return undefined

  return {
    predicate: record.predicate,
    value: record.value,
    ...(typeof record.type === 'string' ? { type: record.type } : {}),
    ...(typeof record.qualifiers === 'object' && record.qualifiers !== null
      ? { qualifiers: record.qualifiers as Record<string, unknown> }
      : {}),
  }
}

/**
 * 组合抽取器：先规则，规则未命中才问模型。
 *
 * 与意图检测同一个形状（计划书第 60 节的"先走规则"）。
 * 离线装配时只传规则那一个。
 */
export class ChainedContentExtractor implements MemoryContentExtractor {
  readonly name: string

  private readonly chain: readonly MemoryContentExtractor[]

  constructor(chain: readonly MemoryContentExtractor[]) {
    if (chain.length === 0) {
      throw new KernelError(
        'validation_error',
        'empty_extractor_chain',
        '抽取器链不能为空：空链会让每一条显式记忆都"解析不出来"，而那是用户明确要求记住却被忽略'
      )
    }
    this.chain = chain
    this.name = chain.map((e) => e.name).join('+')
  }

  async extract(input: {
    text: string
    owner: EntityRef
    speaker: EntityRef
  }): Promise<ExtractedMemoryContent | undefined> {
    for (const extractor of this.chain) {
      const result = await extractor.extract(input)
      if (result !== undefined) return result
    }
    return undefined
  }
}

/** 便于装配层：只规则的抽取器（离线 / CI 用） */
export function createRuleOnlyContentExtractor(): MemoryContentExtractor {
  return new RuleBasedContentExtractor()
}

/**
 * **具名测试缝**：与 `createRuleOnlyContentExtractor()` **逐字相同**，只把**问句守卫摘掉**。
 *
 * 照 ADR-080 `D-80f` 的 `extractFreeTextValueRaw` 先例 —— 量具需要能回答
 * "**把那道守卫摘掉之后，那句话是不是又被抽出来了**"（`AGENTS §6.7` 的负控②：
 * 只做正控的量具与"什么都不检查"在输出上无法区分）。
 *
 * ⚠️ **生产代码不得使用它**（`src/**` 里除本文件外零调用；`extractor-question-guard` 组会断言这一点）。
 */
export function createRuleOnlyContentExtractorWithoutQuestionGuard(): MemoryContentExtractor {
  return new RuleBasedContentExtractor(false)
}
