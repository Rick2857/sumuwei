/**
 * Memory predicate 登记表 —— **事实槽位的名字**。
 *
 * ============================================================================
 *  计划书第 18 / 19 / 34 节：为什么必须有 predicate
 * ============================================================================
 * 计划书第 18 节给了最有说服力的理由：
 *
 *     如果全部只是自然语言字符串，冲突检测会完全依赖 LLM。
 *
 * 也就是：没有槽位键，"我喜欢咖啡"与"我不喝咖啡了"之间
 * **无法确定地说**它们是关于同一件事的。而有了
 *
 *     subject + predicate + qualifier scope
 *
 * 之后，"同一事实槽位的当前记忆"变成一次**确定性查表**，
 * 而不是一次模型调用。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 但计划书第 19 节同时禁止另一件事：不要建立巨大的 ontology
 * ---------------------------------------------------------------------------
 * 原话是：
 *
 *     predicate 不做复杂知识图谱
 *     第一版允许 normalized string key
 *     足够稳定即可，不追求世界知识图谱
 *
 * 因此这里**不是**一份封闭枚举。它是一个**登记表**：
 *
 *   · 已登记的键 → 有说明、有取值形状、有示例，进文档、进新手指引
 *   · 未登记的键 → **仍然允许写入**（Extractor 不该因为词表没收录就丢弃事实），
 *                  但会被 `kindOf()` 标成 `unregistered`，
 *                  并被 `m4:stats` / `memory:audit` 统计出来
 *
 * ---------------------------------------------------------------------------
 *  为什么"允许未登记但计数"，而不是二选一
 * ---------------------------------------------------------------------------
 * 两个极端都不好，而且失败方式相反：
 *
 *   · **严格封闭**（未登记就 REJECT）：真实对话里大量合理事实会被拒，
 *     系统会显得"记不住"。更糟的是它会**静默**丢掉本该记住的东西，
 *     而"她忘了"比"她记错了"更难发现。
 *   · **完全自由**：`prefers_detailed` / `preference.detail` /
 *     `explanation_style` 会各自成键，同一件事分散在三个槽位，
 *     冲突检测退化 —— 那正是计划书第 18 节要避免的。
 *
 * 因此取中间：**允许写入，但让"没归类的键"变成可见的数字**。
 * 于是"要不要把它收进登记表"是一个**看着数据做的决定**，
 * 而不是一个猜测。
 */

import { KernelError } from './ids.ts'

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

/** predicate 取值形状（**只做提示与轻校验**，不是强类型系统） */
export type PredicateValueShape =
  /** 布尔：`education.status` → `'undergraduate'` 之类 */
  | 'boolean'
  /** 枚举串：取值必须在一小组里（登记表给出 `allowed`） */
  | 'enum'
  /** 自由文本：一段可能很短的说明 */
  | 'text'
  /** 数值：带可选单位 */
  | 'number'
  /** 有序量：`detailed` / `brief` 这类可比较但非数值的档位 */
  | 'scale'

export interface PredicateSpec {
  /** 规范化后的键（点分隔小写，见 `normalizePredicate`） */
  key: string
  /** 人类可读说明 —— 会进文档与审计报告 */
  description: string
  /** 取值形状提示 */
  valueShape: PredicateValueShape
  /** `valueShape === 'enum' / 'scale'` 时的合法取值（可选） */
  allowed?: readonly string[]
  /** 几条例句。**不是**给模型看的 few-shot，是给人看的"这个键是什么意思" */
  examples: readonly string[]
  /**
   * ==========================================================================
   *  **已证实问法**（词面覆盖）—— M6.1 WP5 / B② / ADR-059
   * ==========================================================================
   * 相关性的词面闸（`relevanceHaystack` + `lexicalOverlapHits`）会把**登记表说明与例子**
   * 也算进候选的"可搜索文本"。于是出现这样一种确定性缺口：
   *
   * ```text
   *   库里确实有  project.background.active = 毕业论文
   *   用户问「我现在在写什么？」——问句的 2 字片段是
   *     [我现, 现在, 在在, 在写, 写什, 什么]
   *   而该槽位的说明（「正在做的长期项目…」）与例子（「我在做一个角色 Agent 的项目」）
   *   与这些片段**零重叠** ⇒ 词面 0 命中 ⇒ 总分 < `minTotal` ⇒ `LOW_RELEVANCE`
   *   ⇒ 那条**存在且合格**的记忆根本进不了上下文（四轮实测，逐条相同）。
   * ```
   *
   * 这里每条都必须是**经过实测的问法片段**（不是同义词词典）：
   *   · 只有**已证实**的问法能进来（证据：冻结条文 + `pnpm m6.1:recall-coverage` 的 pre/post 读数）
   *   · 片段里**不得**含 `什么` / `怎么` 这类通用词 —— 闸是 **2 字滑窗**，
   *     通用词会让**无关问题**（「我平时喜欢什么运动？」）也命中 ⇒ 直接打破负控
   *   · 它**不是**"降低阈值"：`minTotal` 一个字没动；这里只补**词面覆盖**
   *   · 也**不是**语义通道：没有向量/嵌入参与（既有裁定：M4 无嵌入列）
   */
  surfaceForms?: readonly string[]
}

/** 登记项的分类（用于审计分组，不影响语义） */
export type PredicateKind = 'registered' | 'unregistered'

export interface PredicateLookup {
  kind: PredicateKind
  /** 登记时才有的规格 */
  spec?: PredicateSpec
}

// ---------------------------------------------------------------------------
// 规范化
// ---------------------------------------------------------------------------

/**
 * 规范化 predicate。
 *
 * 规则刻意**只有三条**（计划书第 19 节"足够稳定即可"）：
 *   1. trim
 *   2. 转小写（`Food.Preference` 与 `food.preference` 是同一个槽位）
 *   3. 连续的分隔符折叠成单个 `.`，并去掉首尾的 `.`
 *      （模型经常吐 `food..preference` 或 `food.preference.` 这类形状）
 *
 * **不做**同义词归并、不做词干化、不做翻译。
 * 那些需要一份人工维护的映射表，而"任何一张手工对照表都会在某天被漏写一个分支"
 * —— 这正是 `entity.ts` 里拒绝大写/小写对照表的同一条理由。
 * 同义词归并的正确位置是**登记表**（把 `food.avoid.cilantro` 与
 * `food.preference.cilantro` 都登记上，并在说明里写清它们的关系），
 * 而不是藏在归一化函数里。
 */
export function normalizePredicate(raw: string): string {
  if (typeof raw !== 'string') {
    throw new KernelError(
      'validation_error',
      'bad_predicate',
      `predicate 必须是字符串，收到 ${typeof raw}`
    )
  }
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.+|\.+$/g, '')
  if (normalized === '') {
    throw new KernelError(
      'validation_error',
      'empty_predicate',
      'predicate 规范化后为空：Claim 型记忆没有槽位键就无法做冲突检测（计划书第 18 节）'
    )
  }
  return normalized
}

// ---------------------------------------------------------------------------
// 登记表
// ---------------------------------------------------------------------------

/**
 * 第一版登记的事实槽位。
 *
 * ============================================================================
 *  收纳标准（只在**够得着**的证据上登记）
 * ============================================================================
 * 一个键值得进这张表，必须同时满足：
 *   1. M4 的四类记忆里**真的会出现**它（PERSON_FACT / PREFERENCE 的槽位）
 *   2. 它的取值形状是**稳定的**（"喜欢/不喜欢"是，"今天心情还行"不是）
 *   3. 计划书或真实对话里**已经出现过**对应的说法
 *
 * 因此这里**没有**情绪、没有人际关系、没有目标 ——
 * 那些在 M4 不是 Claim（计划书第 11 / 12 / 51 节）。
 *
 * ⚠️ 登记表是**只增**的。删一个键会让已经用它写下的记忆变成"未登记"，
 * 而那是历史污染。真要废弃，做法是把 `description` 标成
 * `（已废弃，改用 X）` 并保留 key。
 */
const BUILT_IN_SPECS: readonly PredicateSpec[] = [
  // --- 饮食指 -------------------------------------------------------------
  {
    key: 'food.preference.cilantro',
    description: '对香菜的偏好。计划书第 174 / 175 节的 M4-001 / M4-002 用的就是这个槽位',
    valueShape: 'enum',
    allowed: ['like', 'dislike', 'neutral'],
    examples: ['我不吃香菜', '我现在能吃香菜了'],
  },
  {
    key: 'food.avoid.general',
    description: '其他明确表达的食物回避（**宽泛槽位**：多个具体食物时会与 qualifier 区分）',
    valueShape: 'text',
    examples: ['我不吃辣', '海鲜过敏'],
  },
  // --- 教育 / 身份 --------------------------------------------------------
  {
    key: 'education.lab',
    description: '用户的实验室位置', valueShape: 'text',
    examples: ['我的实验室在 A 楼 302'], surfaceForms: ['实验室在哪里', '实验室在哪'],
  },
  {
    key: 'education.status',
    description: '当前受教育阶段。稳定的身份信息，不是短期状态',
    valueShape: 'enum',
    allowed: ['high_school', 'undergraduate', 'graduate', 'doctorate', 'graduated', 'other'],
    examples: ['我现在是大学生', '我已经毕业了'],
  },
  {
    key: 'education.major',
    description: '所学专业。计划书第 159 / 120 节的纠正场景用的就是这一类',
    valueShape: 'text',
    examples: ['我学的是计算机', '我不是计算机专业的'],
    // 三字词面下已复现的问句片段：M5 runtime「我读的是什么专业？」。
    surfaceForms: ['什么专业'],
  },
  {
    key: 'education.institution',
    description: '就读 / 毕业院校',
    valueShape: 'text',
    examples: ['我在 XX 大学'],
    // 三字词面下已复现的问句片段：M9.1 P05「我上的什么大学」。
    surfaceForms: ['什么大学'],
  },
  // --- 数量类（M9.5 语料：数字/单位难例的唯一承载槽位） ---------------------
  {
    /*
     * ⚠️ 为什么要新登记这一条：M9.5 的语料里有 `数字/单位` 与 `单位/口径变化`
     *    两个难例子层，而**原有 10 个槽位没有一个承载数量/单位**
     *    ⇒ 事实池里含数字/单位的取值恒为 0，那两类的"覆盖"是**空的**
     *    （首轮人审据此指出统计失真，记 `L-M95-11`/（新）`L-M95-13`）。
     * ⇒ 这里按注册表的**追加**方式补一个承载槽位；取值同时用**小时**与**分钟**
     *    两种口径表达，于是"换个单位说是多少"有真实材料可依。
     */
    key: 'health.sleep.duration',
    description: '每天睡眠时长',
    valueShape: 'text',
    examples: ['我每天睡 7 小时', '我每天睡 420 分钟'],
  },
  // --- 交互偏好 -----------------------------------------------------------
  {
    // ⚠️ 这个键**必须**写成点分隔形式。写 `preferred_explanation_style` 是错的：
    // `normalizePredicate` 会把下划线转成点号，于是"登记的键"与"查表的键"
    // 永远不相等 —— 这个槽位会永远查不到，而那种缺陷**不报错**。
    // 实测踩到过一次（`kernel-tests-memory.ts` 的"登记键必须是规范化形式"那条抓的）。
    key: 'preferred.explanation.style',
    description:
      '期望的回答详细度。⚠️ 它的语义**依赖 qualifier**（计划书第 152 节）：' +
      '「技术问题要详细、闲聊要简短」必须落成两条 qualifier 不同的记忆，不能合并成一条',
    valueShape: 'scale',
    allowed: ['detailed', 'balanced', 'brief'],
    examples: ['技术问题我喜欢详细解释', '现在简单说就行'],
  },
  {
    key: 'preferred.address',
    description: '希望被怎么称呼',
    valueShape: 'text',
    examples: ['叫我 Alex 就行'],
  },
  // --- 长期项目背景 -------------------------------------------------------
  {
    key: 'project.background.active',
    description: '正在做的长期项目（"长期项目背景"是计划书第 11 节点名适合 PERSON_FACT 的一类）',
    valueShape: 'text',
    examples: ['我在做一个角色 Agent 的项目'],
    /*
     * M6.1 WP5 / B② / ADR-059：冻结条文 SRP-A-08 / SRP-C-08 的问句是「我现在在写什么？」。
     * ⚠️ 只放「我现在在写」这一段：若放「在写什么」「写什么」，其中的通用片段「什么」
     *    会让无关问题（「我平时喜欢什么运动？」）也命中 ⇒ 负控当场被打破。
     */
    surfaceForms: ['我现在在写'],
  },
  // --- 设备 / 工具 --------------------------------------------------------
  {
    key: 'device.secondary',
    description: '备用或便携设备', valueShape: 'text',
    examples: ['出门用 Mac 笔记本'], surfaceForms: ['出门带哪台', '便携设备'],
  },
  {
    key: 'device.primary',
    description: '常用设备（计划书第 11 节点名的"常用设备"）',
    valueShape: 'text',
    examples: ['我平时用 Windows'],
  },
  {
    key: 'tooling.preference.editor',
    description: '偏好的编辑器 / 开发工具',
    valueShape: 'text',
    examples: ['我用 VS Code'],
  },
  { key: 'preference.tea', description: '当前喝茶偏好', valueShape: 'text', examples: ['我改喝绿茶了'], surfaceForms: ['喝什么茶'] },
  { key: 'preference.coffee', description: '当前喝咖啡偏好', valueShape: 'text', examples: ['我戒咖啡了'], surfaceForms: ['能喝咖啡吗'] },
  { key: 'preference.color.favorite', description: '当前最喜欢的颜色', valueShape: 'text', examples: ['我最喜欢绿色'], surfaceForms: ['喜欢什么颜色'] },
  // --- 个人事实（M9.7 / WP1 增量 2，2026-09-30）-----------------------------
  {
    /*
     * ⚠️ **为什么这两条现在才登记**：`M5` 的 `G1`（`M5-Execution-Plan.md:57`）把它们
     *    点名成"将来要扩覆盖面时，做成**独立阶段**（birthday / hometown / relationship /
     *    schedule …）"—— 本里程碑（M9.7）就是那个独立阶段。
     *
     * ⚠️ **收纳标准逐条对上**（见本表头部那三条）：
     *    ① M4 的四类记忆里真的会出现：生日与老家都是 PERSON_FACT
     *    ② 取值形状**稳定**：生日是一个日期短语、老家是一个地名（不是"今天心情还行"）
     *    ③ 计划书或真实对话里已经出现过对应说法：G1 逐字点名 birthday / hometown
     *
     * ⚠️ **同一批方向里有两个被排除**，理由记在 `ADR-079` §5：
     *    · `relationship`（人际关系）—— 本表头部逐字写着"因此这里**没有**情绪、**没有人际关系**、
     *      没有目标 —— 那些在 M4 不是 Claim"；且 M7 已经为关系**另建了独立模块**（不是扩线索表）
     *    · `schedule`（日程 / 一次性事件）—— 它过不了上面第 ② 条：一次性事件**不是稳定取值**，
     *      而且 M10 已经有完整的 **goal / commitment 域**（`contracts/goal.ts`，带受理证据与生命周期）
     *      ⇒ 在记忆里再放一份"日程"会造出**第二套弱表示**（正是本表头部警告的"同一件事分散在
     *      三个槽位，冲突检测退化"）
     */
    key: 'person.birthday',
    description: '出生日期（生日）',
    /*
     * 形状是 `text` 而不是 `number`：真实说法是「3 月 14 日」「10 月」这类**日期短语**，
     * 不是可比较的数值（本表没有 `date` 这一档，而 `number` 会误导下游以为能排序）。
     */
    valueShape: 'text',
    examples: ['我生日是 3 月 14 日', '我的生日在 10 月'],
    /*
     * ⚠️ **刻意不给 `surfaceForms`**：那一栏的纪律是"只有**已证实**的问法能进来
     *    （证据：冻结条文 + `pnpm m6.1:recall-coverage` 的 pre/post 读数）"（见 `PredicateSpec`）。
     *    本增量**没有**跑过那条读数 ⇒ 一个片段都不放（宁可词面覆盖不足，也不塞没证据的东西）。
     */
  },
  {
    key: 'person.hometown',
    description: '老家 / 故乡',
    valueShape: 'text',
    examples: ['我老家在成都', '我家乡是西安'],
  },
]

const REGISTRY = new Map<string, PredicateSpec>()

for (const spec of BUILT_IN_SPECS) {
  // 登记项自己也要过规范化：否则 `Food.Preference` 这类写法会登记成
  // 一个永远查不到的键，而那种缺陷**不会报错**，只会让"已登记"变成谎话。
  const key = normalizePredicate(spec.key)

  /*
   * ⚠️ 这里**不是"顺手纠正一下"**，而是**失败关闭**。
   *
   * 纠正（`REGISTRY.set(normalizePredicate(spec.key), ...)`）会让
   * `registeredPredicates()` 返回的 `spec.key` 与实际键不一致 ——
   * 而审计报告、文档与"已登记键清单"全都读那个 `key`。
   * 于是清单上写着 `preferred_explanation_style`、实际查的是
   * `preferred.explanation.style`，两者都"看起来对"。
   *
   * 实测踩到过一次：`preferred_explanation_style` 因为下划线被规范化成点号，
   * 这个槽位**永远查不到**。它没有报错、没有告警，只是静静地不生效。
   *
   * 因此改为在**模块加载时**就抛错：写错一个键会让整个进程起不来，
   * 而那是这个缺陷应得的代价。
   */
  if (key !== spec.key) {
    throw new Error(
      `predicate 登记表里有非规范化键：${JSON.stringify(spec.key)} → 规范化后是 ${JSON.stringify(key)}。` +
        '登记键必须写成规范化形式（小写、点分隔），否则它会永远查不到 —— ' +
        '而那种缺陷不会报错，只会让"已登记"变成谎话'
    )
  }
  if (REGISTRY.has(key)) {
    throw new Error(`predicate 登记表里有重复键：${key}（登记表是只增的，重复会让"已登记"失去唯一答案）`)
  }
  REGISTRY.set(key, { ...spec, key })
}

/** 全部已登记的 predicate（供文档生成、审计与测试使用） */
export function registeredPredicates(): PredicateSpec[] {
  return [...REGISTRY.values()].sort((a, b) => a.key.localeCompare(b.key))
}

/**
 * 查一个 predicate 是否已登记。
 *
 * ⚠️ 它**不抛错、也不拒绝**未登记的键 —— 决策权在调用方：
 *   · Policy/Extractor：允许写入，但把 `kind: 'unregistered'` 记进 trace 与统计
 *   · 审计工具：把未登记的键按出现次数排序，作为"要不要收进登记表"的输入
 */
export function lookupPredicate(raw: string): PredicateLookup {
  const key = normalizePredicate(raw)
  const spec = REGISTRY.get(key)
  return spec ? { kind: 'registered', spec } : { kind: 'unregistered' }
}

/** 便捷判定：这个键已登记吗 */
export function isRegisteredPredicate(raw: string): boolean {
  return lookupPredicate(raw).kind === 'registered'
}

/**
 * 注册一个 predicate（**只用于测试注入**）。
 *
 * 生产代码不使用它：登记表是编译期常量，运行时改它会让
 * "有哪些槽位"取决于"进程里跑过什么"。
 * 这里导出它是为了让测试能验证**枚举校验**的分支
 * （例如"valueShape 是 enum 时非法取值被拒"）而不必往生产表里塞假键 ——
 * 那正是 M3.5 审计里拒绝的"为一个测试在生产枚举里塞假值"。
 */
export function registerPredicateForTest(spec: PredicateSpec): () => void {
  const key = normalizePredicate(spec.key)
  const existed = REGISTRY.get(key)
  REGISTRY.set(key, { ...spec, key })
  return () => {
    if (existed) REGISTRY.set(key, existed)
    else REGISTRY.delete(key)
  }
}

/**
 * 取值是否与已登记的形状相容。
 *
 * **只在已登记且 `valueShape === 'enum' | 'scale'` 时检查**，
 * 且**只返回判定结果，不做拒绝**：
 * 调用方（`MemoryMutationValidator`）决定是拒绝还是仅告警。
 *
 * 为什么不让登记表直接抛错：取值形状是**提示**，不是知识图谱。
 * 一个真实用户说"我最近不太能喝奶了"落到 enum 槽位时，
 * 硬拒会丢事实，而记下来 + 计数才是正确的处理
 * （计划书第 50 节："REJECT 必须是正常结果"，但**丢事实不是**）。
 */
export function valueFitsShape(
  spec: PredicateSpec,
  value: unknown
): { fits: boolean; reason?: string } {
  if (spec.allowed === undefined || spec.allowed.length === 0) return { fits: true }

  // 枚举 / 档位：取值必须是自己或它的规范化形式
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (spec.allowed.includes(normalized)) return { fits: true }
    return {
      fits: false,
      reason: `取值 ${JSON.stringify(value)} 不在 ${spec.key} 的合法集合 [${spec.allowed.join(', ')}] 内`,
    }
  }

  // 允许 `{ value: string }` 这类带限定词的形状
  if (value !== null && typeof value === 'object' && 'value' in value) {
    return valueFitsShape(spec, (value as { value: unknown }).value)
  }

  return { fits: false, reason: `取值不是字符串，无法与 ${spec.key} 的枚举集合比较` }
}
