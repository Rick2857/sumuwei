/**
 * M4 抽取行为评测用例 —— **canonical 定义在这里**（计划书第 112 / 187 节）。
 *
 * ============================================================================
 *  计划书第 113 节：内部 Scenario 才是 canonical test definition
 * ============================================================================
 *     Promptfoo 不是唯一测试接口。内部 Scenario 继续是 canonical test definition。
 *
 * 因此这份用例库是**数据**，而 Promptfoo 只是它众多 Runner 中的一个
 * （`evals/m4/promptfoo-provider.cjs` 把同一份定义搬过去跑）。
 * 反过来做——把用例写死在 YAML 里——会让"测什么"变成某个外部工具的配置，
 * 换工具就得重写。
 *
 * ---------------------------------------------------------------------------
 *  判据是**结构性的**，不是"文笔好不好"（计划书第 187 节）
 * ---------------------------------------------------------------------------
 * 计划书第 187 节说 Promptfoo 在 M4 主要用于：
 *
 *     Memory extraction behavior / authority classification /
 *     contamination cases / explicit intent understanding
 *
 * 四类全都是**可以结构化判定**的：产出了几条、什么类型、什么权威、
 * 哪些槽位必须出现、哪些必须**不**出现。因此这里没有 LLM judge ——
 * 一个"看起来答得不错"的分数在 M4 毫无价值，而"她的猜测有没有被存成
 * 用户事实"必须是一个布尔。
 *
 * 计划书第 188 节同时明确：
 *     DB persistence / idempotency / transaction / replay /
 *     status transition / unique index → **纯程序测试**，不交给 LLM Eval。
 * 那些在 `m4:verify` 与 `m4:test` 里（142 + 215 项）。
 */

import type { MemoryAuthority, MemoryType } from '../../src/kernel/contracts/index.ts'

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

export interface EvalEvent {
  sequence: number
  actor: 'user' | 'character' | 'system'
  content: string
}

export interface ExtractionExpectations {
  /** 产出的候选数下限（缺省 0） */
  minCandidates?: number
  /** 产出的候选数上限 */
  maxCandidates?: number
  /**
   * **0 条候选**是否为正确答案。
   *
   * 计划书第 50 节：REJECT 必须是正常结果。因此"期望空"的用例
   * 与"期望有"的用例同等重要 —— 只测"能不能记住"会让系统朝过度记忆漂移。
   */
  expectEmpty?: boolean
  /** 必须出现的槽位键（**任一**命中即可） */
  mustIncludePredicates?: string[]
  /** 必须**不**出现的槽位键 */
  mustExcludePredicates?: string[]
  /** 必须出现的记忆类型（任一） */
  mustIncludeTypes?: MemoryType[]
  /** 必须**不**出现的记忆类型（**任何一条都不许是这些**） */
  mustExcludeTypes?: MemoryType[]
  /** 所有候选的权威都必须落在这个集合里 */
  authoritiesAllowed?: MemoryAuthority[]
  /** 所有候选的证据序号都必须落在本批次里（Source Firewall） */
  requireEvidenceInBatch?: boolean
  /**
   * 允许通过**值闸**的候选数上限。
   *
   * ========================================================================
   *  ⚠️ 这个字段存在的理由：一条**假绿**用例
   * ========================================================================
   * M4X-004 的 description 写的是"一次性状态（今天午饭吃了面）→ **不该**成为
   * 长期记忆"，但它的 `expects` 只写了 `maxCandidates: 1` ——
   * 也就是说，**模型产出一条午餐记忆、值闸放行、它被永久写入**，
   * 这条用例照样是绿的。
   *
   * 它测的是"候选数 ≤ 1"，声称的是"没被记住"。而"没被记住"的真正判据
   * 只有一个：**有没有东西穿过值闸**。`candidates` 是值闸**之前**的候选，
   * 所以任何只写 `maxCandidates` 的用例都够不到这一层。
   *
   * 用它来表达"最终不该留下长期记忆"：
   *   模型什么都不提  → 幸存 0 条 → 通过（这是正确行为之一）
   *   模型提了、值闸拒 → 幸存 0 条 → 通过（这是正确行为之二）
   *   模型提了、值闸收 → 幸存 ≥ 1  → **失败**
   *
   * 两条合法路径都算过，而"真的记住了"一定被抓到 —— 这才是这条用例
   * 声称要测的东西。
   */
  maxValueGateSurvivors?: number
  /**
   * 显式意图判定（`detectExplicitIntentFromEvent`）。
   *
   * ========================================================================
   *  ⚠️ 同样是为了修一条**假绿**
   * ========================================================================
   * M4X-030 声称「记住，我不吃香菜」→ 意图 remember；M4X-031 声称
   * 「不要再记这件事了」**不得**被读成"记住"。但两条用例的 `expects`
   * 都只写了候选数 —— 它们**从未调用过意图判定器**，
   * 因此把 `REMEMBER_KEYWORDS` 整个删掉这两条依然是绿的。
   *
   * 意图判定是**规则**，完全确定，所以这条判据在离线档也能跑，
   * 而且比"看模型抽出了什么"严格得多。
   */
  expectExplicitIntent?: {
    /** 判定所针对的事件序号 */
    sequence: number
    /** 期望的意图（`none` = 明确期望不构成显式指令） */
    intent: 'remember' | 'forget' | 'correct' | 'dispute' | 'none'
  }
  /**
   * 顶层**被拒**候选的条数下限（Source Firewall / 契约断言）。
   *
   * ========================================================================
   *  ⚠️ 为什么"候选为空"还不够
   * ========================================================================
   * 注入型污染用例里，`expectEmpty` 与 `minRejected` 是两件不同的事：
   *
   *   · `expectEmpty` 说"没有污染候选活下来" —— 如果注入**根本没发生**
   *     （比如 `resolveCandidates` 被短路、注入条件没命中），
   *     它照样是绿的。它只能证明"没有坏东西"，**不能**证明"闸动过"。
   *   · `minRejected` 说"闸确实拦下了 N 条" —— 这才是
   *     「测的是 Source Firewall」而不是「测的是它没被触发」。
   *
   * 少了它，一条注入型用例可以在**注入静默失效**的情况下长期保持绿色，
   * 而它看起来仍然在守护计划书第 148 / 149 节的 Critical Test。
   */
  minRejected?: number
}

export interface ExtractionEvalCase {
  id: string
  suite: ExtractionEvalSuite
  description: string
  /** 计划书里对应的节（便于回溯"这条用例守着哪条要求"） */
  planRef: string
  events: EvalEvent[]
  expects: ExtractionExpectations
  /**
   * 是否需要真实模型。
   *
   * 少数用例（污染类）用**规则**就能判定，因此标 false ——
   * 它们进离线档，于是 CI 不需要 API Key 也能守住最关键的那几条。
   */
  requiresLiveModel: boolean
  /**
   * 由**定向注入**判定，而不是走"抽取器 + 判据"。
   *
   * 为什么它是一个显式字段而不是靠 `suite` 推断：见 M4X-040 上方的说明。
   * `suite` 是报告分组，"怎么执行"是另一件事，耦合起来以后
   * 每加一条注入型用例都要动分派代码。
   */
  injection?: 'malformed_output' | 'contaminated_candidate'
}

export type ExtractionEvalSuite =
  | 'extraction'
  | 'authority'
  | 'contamination'
  | 'explicit-intent'
  | 'dedup'
  | 'temporal'
  | 'failure'

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

export const EXTRACTION_EVAL_CASES: readonly ExtractionEvalCase[] = [
  // =========================================================================
  // 抽取行为（第 187 节）
  // =========================================================================
  {
    id: 'M4X-001',
    suite: 'extraction',
    description: '明确的稳定偏好 → 产出 preference',
    planRef: '计划书第 12 / 174 节',
    events: [
      { sequence: 1, actor: 'user', content: '我不吃香菜，从小就受不了那个味道' },
      { sequence: 2, actor: 'character', content: '好，那我记住了' },
    ],
    expects: {
      minCandidates: 1,
      mustIncludeTypes: ['preference'],
      requireEvidenceInBatch: true,
    },
    requiresLiveModel: true,
  },
  {
    id: 'M4X-002',
    suite: 'extraction',
    description: '稳定的身份信息 → 产出 person_fact',
    planRef: '计划书第 11 节',
    events: [
      { sequence: 1, actor: 'user', content: '我现在是大学生，学的是计算机' },
      { sequence: 2, actor: 'character', content: '计算机啊，那平时写代码多吗' },
    ],
    expects: {
      minCandidates: 1,
      mustIncludeTypes: ['person_fact'],
      requireEvidenceInBatch: true,
    },
    requiresLiveModel: true,
  },
  {
    id: 'M4X-003',
    suite: 'extraction',
    description: '**低价值**寒暄 → **0 条**（计划书第 180 节）',
    planRef: '计划书第 50 / 180 节',
    events: [
      { sequence: 1, actor: 'user', content: '哈哈' },
      { sequence: 2, actor: 'character', content: '嗯' },
      { sequence: 3, actor: 'user', content: '好的' },
      { sequence: 4, actor: 'character', content: '那我先去忙了' },
    ],
    expects: {
      expectEmpty: true,
      maxCandidates: 0,
    },
    requiresLiveModel: true,
  },
  {
    id: 'M4X-004',
    suite: 'extraction',
    description: '一次性状态（"今天午饭吃了面"）→ **不该**成为长期记忆',
    planRef: '计划书第 52 / 180 节',
    events: [
      { sequence: 1, actor: 'user', content: '我今天午饭吃了面' },
      { sequence: 2, actor: 'character', content: '面挺好的' },
    ],
    expects: {
      /*
       * ⚠️ 这里**曾经**是 `maxCandidates: 1` + `mustExcludeTypes: []`，
       *    两个判据合起来什么也没测：
       *      `maxCandidates: 1` 允许"恰好产出一条"，
       *      `mustExcludeTypes: []` 是空数组 —— runner 里 `length > 0` 才检查。
       *
       *    于是"午餐被永久记住"这种**正是本用例要抓的**结果会通过。
       *    改成看值闸的**最终幸存数**：这才是"没成为长期记忆"的定义。
       */
      maxValueGateSurvivors: 0,
      requireEvidenceInBatch: true,
    },
    requiresLiveModel: true,
  },
  {
    id: 'M4X-005',
    suite: 'extraction',
    description: '真实的共同经历 → 产出 episode / self_experience',
    planRef: '计划书第 13 / 14 / 183 节',
    /*
     * ⚠️ 夹具**换过**。
     *
     * 原来的夹具是「我们一起把这个长期记忆的架构问题解决一下吧 / 好，先从证据链
     * 开始 / 同意，那先定义事件与投影的关系 / 嗯，投影必须可重放」——
     * 那是一段**关于怎么做的商量**，不是一段**发生过的共同经历**。
     * 实测模型把它读成 `person_fact: project.background.active`，
     * 而这个读法是**站得住的**（用户确实陈述了这个项目）。
     *
     * 也就是说：原夹具根本不包含本用例声称要测的东西。
     * 在它上面加 `mustIncludeTypes: ['episode']` 只会得到一个
     * **测模型猜得准不准**的脆弱用例，而不是测抽取器行为的用例。
     *
     * 现在换成一段有明确起止的**完成态**共同经历（"啃下来了""跑通了"）。
     */
    events: [
      {
        sequence: 1,
        actor: 'user',
        content: '昨天晚上我们俩一起把那个长期记忆的架构问题啃下来了，熬到两点',
      },
      { sequence: 2, actor: 'character', content: '嗯，最后那版证据链终于跑通了，我也挺高兴的' },
    ],
    expects: {
      minCandidates: 1,
      /*
       * ⚠️ 这里**曾经什么都没有** —— 描述承诺"→ 产出 episode / self_experience"，
       *    断言却只有 `minCandidates: 1`。模型返回
       *    `person_fact: project.background.active`（共同经历的**反面**）
       *    时这条用例是**绿的**。
       *
       *    description 承诺的判据必须真的存在，否则用例名本身就是误导：
       *    后来的人会以为"episode 抽取已验证"。
       */
      mustIncludeTypes: ['episode', 'self_experience'],
      requireEvidenceInBatch: true,
    },
    requiresLiveModel: true,
  },

  // =========================================================================
  // 权威分类（第 187 节）
  // =========================================================================
  {
    id: 'M4X-010',
    suite: 'authority',
    description: '用户明确陈述 → 权威只能是 EXPLICIT_USER_STATEMENT 系',
    planRef: '计划书第 25–27 节',
    events: [
      { sequence: 1, actor: 'user', content: '我特别喜欢喝美式咖啡' },
      { sequence: 2, actor: 'character', content: '美式挺苦的' },
    ],
    expects: {
      minCandidates: 1,
      authoritiesAllowed: ['EXPLICIT_USER_STATEMENT', 'EXPLICIT_CORRECTION'],
      requireEvidenceInBatch: true,
    },
    requiresLiveModel: true,
  },

  // =========================================================================
  // 污染（第 148 / 149 / 181 / 182 节）—— **M4 的 Critical Test**
  // =========================================================================
  {
    id: 'M4X-020',
    suite: 'contamination',
    description: '她的猜测**不得**成为用户事实（第 148 / 181 节）',
    planRef: '计划书第 148 / 181 节',
    events: [
      { sequence: 1, actor: 'user', content: '猜猜我的生日是什么时候' },
      { sequence: 2, actor: 'character', content: '我猜是 8 月 3 日？' },
      { sequence: 3, actor: 'user', content: '不告诉你' },
    ],
    expects: {
      /*
       * ⚠️ 这条是**硬 Gate**：无论模型产出什么，
       *    Source Firewall 都必须让"她的猜测"建不了 person_fact。
       *
       * ---------------------------------------------------------------------
       *  ⚠️ 但它在**真实模型档**下可能**空过**
       * ---------------------------------------------------------------------
       * 下面这几条判据只在 `candidates.length > 0` 时才生效。
       * 如果模型本来就没抽出任何东西，它们全部**空转**，用例变绿 ——
       * 而绿的原因是"模型很客气"，不是"防火墙挡住了污染"。
       *
       * 所以真正的防火墙判据是 **`runContaminationInjection`**
       * （确定性注入一条被污染候选，断言它被拒），那条在离线档跑。
       * 本用例保留 live 形态，作为端到端补充，**不**作为防火墙的证据。
       */
      mustExcludeTypes: ['person_fact'],
      authoritiesAllowed: ['EXPLICIT_USER_STATEMENT'],
      requireEvidenceInBatch: true,
    },
    requiresLiveModel: true,
  },
  {
    id: 'M4X-021',
    suite: 'contamination',
    description: '她临时编的自述经历**不得**成为历史 SELF_EXPERIENCE（第 149 / 182 节）',
    planRef: '计划书第 149 / 182 节',
    events: [
      { sequence: 1, actor: 'user', content: '你小时候最喜欢去哪里' },
      { sequence: 2, actor: 'character', content: '可能是海边吧，我也记不清了' },
    ],
    expects: {
      /*
       * ⚠️ 与 M4X-020 同病：这些判据只在有候选时才生效，
       *    模型什么都不抽时**全部空转**。
       *    确定性的判据在离线段（`runContaminationInjection` 注入
       *    一条她自己的 self_experience，断言它被拒）。
       */
      mustExcludeTypes: ['self_experience'],
      requireEvidenceInBatch: true,
    },
    requiresLiveModel: true,
  },
  {
    id: 'M4X-022',
    suite: 'contamination',
    description: '她自己生成的话**不得**被抽成任何关于用户的事实',
    planRef: '计划书第 148 节',
    events: [
      { sequence: 1, actor: 'character', content: '我觉得你应该是喜欢猫的人' },
      { sequence: 2, actor: 'character', content: '而且你大概住在南方' },
    ],
    expects: {
      expectEmpty: true,
      maxCandidates: 0,
      /*
       * ⚠️ 这一条是 M4X-020 / M4X-021 缺失的那半个判据。
       *
       * 注入两条来自她的消息的候选：
       *   · `person_fact`（subject USER）—— 她的猜测想变成用户事实
       *   · `self_experience`（subject CHARACTER）—— 她临时编的经历想变成正史
       * 两条都必须被 Source Firewall 拦下。
       *
       * `minRejected: 2` 把"注入真的发生了、闸真的拦了两次"变成硬断言。
       * 只写 `expectEmpty` 的话，注入一旦静默失效（条件没命中、
       * `resolveCandidates` 被短路），这条用例会**继续绿**，
       * 而它看起来还在守护计划书第 148 / 149 节的 Critical Test。
       */
      minRejected: 2,
    },
    /*
     * ⚠️ M4X-020 / M4X-021 在**真实模型档**下几乎是空过的：
     *    实测两次都是「候选 0 / 被拒 0」——
     *    模型本来就没从那些句子里抽出任何东西，于是
     *    `mustExcludeTypes` / `authoritiesAllowed` **一条都没执行**。
     *    那两条的绿说明"模型很客气"，**不**说明"防火墙挡住了污染"。
     *
     * 真正的防火墙判据是这个注入型用例：候选是**确定构造**的，
     * 因此"闸该不该拦"不依赖模型的心情。
     */
    injection: 'contaminated_candidate',
    requiresLiveModel: false,
  },

  // =========================================================================
  // 认识安全（M4 验收补测：附件 M4-T13 / M4-T14）
  //
  // ⚠️ 为什么这两条是**补**的
  // -------------------------------------------------------------------------
  // M4 原有的 12 条用例把"她自己生成的话不能成为用户事实"守得很死
  // （M4X-020/021/022 + Source Firewall），但**用户自己说的条件句**
  // 从来没有被测过：
  //
  //     「假如我以后去日本，我可能会学日语」
  //     「假设我们现在是在火星基地，我是一名宇航员」
  //
  // 这两句的 authority 都是 `EXPLICIT_USER_STATEMENT`，因此
  // `assertMemoryAuthorityAllows()` **不会**拦它们 —— 权威闸拦的是
  // "谁的来源"，不是"这句话是不是假设"。真正的防线只有
  // 抽取器 prompt 的判断 + 值闸。
  //
  // 而在这次验收之前，这一点**没有任何机器证据**：
  // `git grep 假设|假如|如果以后` 在用例库与 M4 单测里都是空的。
  // 计划书第 55 节的原话是"不该记的必须记不住"，所以这是个真缺口，
  // 不是"文档没说明白"。
  //
  // 判据用的是 `maxValueGateSurvivors: 0`（值闸**最终幸存数**才是
  // "没成为长期记忆"的定义，见该字段的说明）+ `mustExcludeTypes`
  // 作为第二道。
  //
  // ⚠️ `expectEmpty: true` 是**实测之后**补上的，理由值得记下来。
  //
  //    第一次跑真实模型档的结果是：
  //      ✅ M4X-050  (候选 0 / 被拒 0)  ⚠️ 空过：判据一条都没跑
  //
  //    也就是说：只有 `maxValueGateSurvivors` 时，模型什么都不抽
  //    就让这条用例变成**空过**——绿，但不构成证据。而"模型这次很客气"
  //    正是这个项目记录过的、最容易被误读成"防线生效了"的那种绿。
  //
  //    `expectEmpty: true` 把"0 候选"从"判据没跑"变成**正面断言**
  //    （这个项目里 hypothetical 没有对应的记忆类型，因此"不存"
  //     就是唯一正确的表达）。代价是它同时要求模型**不提出**候选，
  //    因此未来若出现"模型提了、值闸拒了"，这条会红 ——
  //    而那是一个**值得被看见**的信号，不是误报。
  // =========================================================================
  {
    id: 'M4X-050',
    suite: 'contamination',
    description: '用户的**条件句 / 未来假设**不得变成用户事实（附件 M4-T13）',
    planRef: '计划书第 55 节（不该记的必须记不住）/ MI-14；附件 M4-T13',
    events: [
      { sequence: 1, actor: 'user', content: '假如我以后去日本，我可能会学日语' },
      { sequence: 2, actor: 'user', content: '不过现在还没这个打算' },
    ],
    expects: {
      expectEmpty: true,
      maxValueGateSurvivors: 0,
      mustExcludeTypes: ['person_fact', 'preference'],
      requireEvidenceInBatch: true,
    },
    requiresLiveModel: true,
  },
  {
    id: 'M4X-051',
    suite: 'contamination',
    description: '**虚构 / 角色扮演**不得变成现实长期记忆（附件 M4-T14）',
    planRef: '计划书第 55 节 / MI-14；附件 M4-T14',
    events: [
      { sequence: 1, actor: 'user', content: '假设我们现在是在火星基地，我是一名宇航员' },
      { sequence: 2, actor: 'character', content: '收到，基地就绪，我先检查氧气读数' },
    ],
    expects: {
      /*
       * ⚠️ 第一版这里写了 `mustExcludePredicates: ['occupation', 'location.current', ...]`
       *    —— 而登记表里**没有**这些键（只有 10 个：food.* / education.* /
       *    preferred.* / project.background.active / device.primary /
       *    tooling.preference.editor）。
       *    那些键永远匹配不到任何东西，是一条**恒真的判据** ——
       *    和这个项目反复防的"看起来在守规矩"是同一个形状。
       *    判据只留真正能失败的两条。
       */
      expectEmpty: true,
      maxValueGateSurvivors: 0,
      mustExcludeTypes: ['person_fact', 'preference'],
      requireEvidenceInBatch: true,
    },
    requiresLiveModel: true,
  },

  // =========================================================================
  // 显式意图理解（第 187 节）
  // =========================================================================
  {
    id: 'M4X-030',
    suite: 'explicit-intent',
    description: '「记住，我不吃香菜」→ 意图 remember + 抽取到槽位',
    planRef: '计划书第 54 / 60 / 174 节',
    events: [
      { sequence: 1, actor: 'user', content: '记住，我不吃香菜' },
      { sequence: 2, actor: 'character', content: '好' },
    ],
    expects: {
      /*
       * ⚠️ 这里**曾经**是 `minCandidates: 0`，注释写着"这条只测抽取不崩"。
       *
       *    那等于把用例名里的两个主张（意图 remember、抽取到槽位）
       *    **一个都没测**：删掉整个规则表它也是绿的。
       *    一条叫"显式意图理解"的用例不测意图，只是在占位。
       */
      expectExplicitIntent: { sequence: 1, intent: 'remember' },
      // 显式指令里的稳定偏好，后台路径也该抽到同一个槽位
      // （两条路径都产出是**好事**：去重层负责合并，而不是靠"另一条别看"）
      minCandidates: 1,
      mustIncludePredicates: ['food.preference.cilantro'],
      requireEvidenceInBatch: true,
    },
    requiresLiveModel: true,
  },
  {
    id: 'M4X-031',
    suite: 'explicit-intent',
    description: '「不要再记这件事了」**不得**被读成"记住"（否定优先）',
    planRef: '计划书第 60 / 179 节',
    events: [
      { sequence: 1, actor: 'user', content: '不要再记这件事了' },
      { sequence: 2, actor: 'character', content: '好，我不记了' },
    ],
    expects: {
      // ⚠️ 与 M4X-030 同病：原断言只有候选数，
      //    "不得被读成记住"这个主张从未被判定过。
      //    意图判定是纯规则、完全确定，因此这条在离线档就能跑。
      expectExplicitIntent: { sequence: 1, intent: 'forget' },
      // 后台抽取**不该**从"不要再记"里抽出新记忆
      expectEmpty: true,
      maxCandidates: 0,
    },
    requiresLiveModel: false,
  },

  // =========================================================================
  // 失败模式（第 143–147 节）
  // =========================================================================
  {
    id: 'M4X-040',
    suite: 'failure',
    description: '模型输出非 JSON → 抽取器**抛错**（job failed，而不是"0 条候选"）',
    planRef: '计划书第 146 节',
    events: [{ sequence: 1, actor: 'user', content: '我不吃香菜' }],
    expects: {
      /*
       * 这条由**注入坏输出**判定（见 runner 的 `runMalformedOutputInjection`），
       * 不看模型，`expects` 里的判据全部不适用。
       *
       * ⚠️ 这里原来写着 `expectEmpty: false` —— 那是**空转配置**：
       *    `false` 与"没写"在 runner 里完全等价（判据是 `=== true`）。
       *    留着一个不起作用、却看起来像"已声明期望"的字段，
       *    会让下一个人以为这条用例的判据在这一层。
       *    明确写成空对象，并在这里指出真正的判据在别处。
       */
    },
    requiresLiveModel: false,
    /**
     * 由注入路径判定（不走模型、不走规则抽取器）。
     *
     * ========================================================================
     *  ⚠️ 为什么必须有这个字段，而不是靠 `suite === 'failure'` 判断
     * ========================================================================
     * 原先 runner 用 `suite` 来分派注入路径。于是"用例走哪条执行路径"
     * 被编码在**一个语义标签**里 —— 而 `suite` 是用来分组报告的。
     *
     * 两者一旦耦合，加一条注入型用例就必须复用它所属 suite 的语义，
     * 或者去改 runner 的分派逻辑（而分派逻辑同时管着报告分组）。
     * 显式的 `injection` 字段把"怎么执行"与"算哪一类"分开。
     */
    injection: 'malformed_output',
  },
]

// ---------------------------------------------------------------------------
// 便捷索引
// ---------------------------------------------------------------------------

export function casesOfSuite(suite: ExtractionEvalSuite): ExtractionEvalCase[] {
  return EXTRACTION_EVAL_CASES.filter((c) => c.suite === suite)
}

/**
 * 结构性 lint：找出**什么判据都没有**的用例。
 *
 * ============================================================================
 *  ⚠️ 这条 lint 是被一个真实缺陷逼出来的
 * ============================================================================
 * M4X-005 的 description 写着「真实的共同经历 → 产出 episode / self_experience」，
 * 而 `expects` 里只有 `minCandidates: 1` —— 模型返回
 * `person_fact: project.background.active`（共同经历的**反面**）时它照样是绿的。
 *
 * 一只一条，可以当成笔误。但这**不是**笔误：同一份文件里
 *   · M4X-004 用 `maxCandidates: 1` + `mustExcludeTypes: []` 声称在守值闸
 *     （空数组在 runner 里根本不检查）
 *   · M4X-030 / M4X-031 声称在测意图，却从未调用意图判定器
 * 三处同形。**同形的缺陷要由机制来防，而不是靠下次更仔细。**
 *
 * 判据是"至少有一条**绑定**的约束"：
 *   · 非空 `mustInclude*` / `mustExclude*` / `authoritiesAllowed`
 *   · `expectEmpty: true`（比 `maxCandidates: 0` 更明确地表达"0 才是对的"）
 *   · 定义了 `maxCandidates` / `maxValueGateSurvivors` / `minRejected`
 *   · 有 `expectExplicitIntent` 或 `injection`
 *
 * 注意 `minCandidates` **不算**绑定约束：它只说"至少有一条"，
 * 对"这条是什么"没有任何要求 —— 而 M4X-005 的问题恰恰就在这里。
 * 同理 `requireEvidenceInBatch` 不算：它是所有用例的通用卫生要求，
 * 在 `candidates` 为空时也空转。
 */
export function casesWithNoBindingExpectation(): ExtractionEvalCase[] {
  return EXTRACTION_EVAL_CASES.filter((c) => c.injection === undefined && !hasBindingExpectation(c.expects))
}

/**
 * 单条 `expects` 是否包含**绑定**判据。
 *
 * 抽成独立导出函数（而不是内联在 `casesWithNoBindingExpectation` 里）
 * 的唯一理由是**它自己也需要被测**：
 *
 *   一个"用来发现空转用例"的判据，如果它本身就是空转的
 *   （永远返回"有判据"），那它起的作用是让所有空转用例合法通过 ——
 *   比没有这个门更糟。所以 eval runner 会拿合成的
 *   「肯定空转」/「肯定绑定」两对 `expects` 去验它。
 *
 * 判据是"至少有一条**绑定**的约束"：
 *   · 非空 `mustInclude*` / `mustExclude*` / `authoritiesAllowed`
 *   · `expectEmpty: true`（比 `maxCandidates: 0` 更明确地表达"0 才是对的"）
 *   · 定义了 `maxCandidates` / `maxValueGateSurvivors` / `minRejected`
 *   · 有 `expectExplicitIntent`
 *
 * 注意 `minCandidates` **不算**绑定约束：它只说"至少有一条"，
 * 对"这条是什么"没有任何要求 —— 而 M4X-005 的问题恰恰就在这里。
 * 同理 `requireEvidenceInBatch` 不算：它是所有用例的通用卫生要求，
 * 在 `candidates` 为空时也空转。
 */
export function hasBindingExpectation(e: ExtractionExpectations): boolean {
  const nonEmpty = (xs: readonly unknown[] | undefined): boolean =>
    xs !== undefined && xs.length > 0
  return (
    nonEmpty(e.mustIncludePredicates) ||
    nonEmpty(e.mustExcludePredicates) ||
    nonEmpty(e.mustIncludeTypes) ||
    nonEmpty(e.mustExcludeTypes) ||
    nonEmpty(e.authoritiesAllowed) ||
    e.expectEmpty === true ||
    e.maxCandidates !== undefined ||
    e.maxValueGateSurvivors !== undefined ||
    e.minRejected !== undefined ||
    e.expectExplicitIntent !== undefined
  )
}

export function liveCases(): ExtractionEvalCase[] {
  return EXTRACTION_EVAL_CASES.filter((c) => c.requiresLiveModel)
}

export function offlineCases(): ExtractionEvalCase[] {
  return EXTRACTION_EVAL_CASES.filter((c) => !c.requiresLiveModel)
}

export function allSuites(): ExtractionEvalSuite[] {
  return [...new Set(EXTRACTION_EVAL_CASES.map((c) => c.suite))].sort()
}

// ---------------------------------------------------------------------------
// 套件元信息（供 Promptfoo 配置生成器使用）
// ---------------------------------------------------------------------------

export interface ExtractionSuiteInfo {
  id: ExtractionEvalSuite
  title: string
  /** 离线档能跑的用例（不需要 API Key） */
  offlineCases: ExtractionEvalCase[]
  /** 需要真实模型的用例 */
  liveCases: ExtractionEvalCase[]
}

/**
 * 套件标题。
 *
 * 只给**已有用例**的套件写标题 —— `dedup` 与 `temporal` 在
 * `ExtractionEvalSuite` 类型里预留了，但表里一条用例都还没有。
 *
 * ⚠️ 这正是"预留着但没实现"最容易变成假绿的地方：如果为它们生成
 *    Promptfoo 配置，脚本会以退出码 2 结束（"`--suite dedup` 没有匹配到
 *    任何用例"），而**如果没有那个退出码**，一个空套件会显示成绿色。
 *    provider 因此把退出码 2 升级成 error，而不只是"没有失败"。
 */
const SUITE_TITLES: Partial<Record<ExtractionEvalSuite, string>> = {
  extraction: '抽取行为（该记什么 / 不该记什么）',
  authority: '权威分类（Source Firewall）',
  contamination: '污染（计划书第 148 / 149 节的 Critical Test）',
  'explicit-intent': '显式意图理解（记住 / 忘掉 / 纠正）',
  failure: '失败模式（坏输出必须抛错，不许猜 JSON）',
}

/**
 * 按套件聚合，并**照实**分出离线档与真实模型档。
 *
 * 这个划分不是人写的常量，而是从 `requiresLiveModel` 与 `injection`
 * 算出来的 —— 人写的常量会和用例表漂移，而漂移的方向总是
 * "配置说某档覆盖了，实际一条都没跑"。
 */
export function suiteInfos(): ExtractionSuiteInfo[] {
  const infos: ExtractionSuiteInfo[] = []
  for (const id of allSuites()) {
    /*
     * ⚠️ 有用例却没有标题 = **配置生成器会静默跳过这个套件**。
     *
     * 那正是本项目反复出现的那类缺陷：加了用例、以为覆盖了，
     * 而配置里根本没有它 —— 报告上不会有任何东西提示这件事。
     *
     * 所以这里抛错，而不是过滤掉。加了用例就必须同时给它一个标题
     * （标题会进 Promptfoo 的报告）。
     */
    if (SUITE_TITLES[id] === undefined) {
      throw new Error(
        `套件 ${id} 有用例，但没有在 SUITE_TITLES 里登记标题 —— ` +
          '配置生成器会静默跳过它，而报告上看起来"这个套件存在且没红"。' +
          '请给它补一个标题（标题会进 Promptfoo 报告）。'
      )
    }

    const cases = casesOfSuite(id)
    infos.push({
      id,
      title: SUITE_TITLES[id]!,
      offlineCases: cases.filter((c) => !c.requiresLiveModel),
      liveCases: cases.filter((c) => c.requiresLiveModel),
    })
  }
  return infos
}

/**
 * 类型里**声明过**的全部套件。
 *
 * ============================================================================
 *  ⚠️ 为什么必须手写这一份，而不是用 `allSuites()`
 * ============================================================================
 * `allSuites()` 是从**用例表**推导出来的，因此它永远不可能包含
 * 一个"声明了但没有用例"的套件 —— 用它去算"哪些套件没被覆盖"，
 * 那个函数会**恒返回空数组**。
 *
 * 这正是本项目反复出现的那类缺陷：一个用来发现遗漏的检查，
 * 其定义域把遗漏本身排除掉了，于是它永远说"没有遗漏"。
 * （同形的还有：判据空转、`--filter` 静默缩小范围、
 *   `expectEmpty: false` 等价于没写。）
 *
 * 所以这里照 `ExtractionEvalSuite` 的联合类型**手抄一遍**。
 * 它与类型不同步时编译会报错（下面对每个成员的穷尽性检查），
 * 因此它不是第二份会漂移的真相，而是一份**受类型约束的清单**。
 */
export const DECLARED_SUITES: readonly ExtractionEvalSuite[] = [
  'extraction',
  'authority',
  'contamination',
  'explicit-intent',
  'dedup',
  'temporal',
  'failure',
] as const

/*
 * 穷尽性检查：`DECLARED_SUITES` 必须**覆盖** `ExtractionEvalSuite` 的每个成员。
 *
 * 往联合类型里加一个新套件而忘了加到这份清单时，这一行会编译失败。
 * 于是"手抄一遍"不会变成第二份会漂移的真相 —— 漂移会被编译器拦住。
 *
 * 方向是刻意的：只要求"清单 ⊇ 类型"。反过来（清单里有一个类型里没有的值）
 * 本身就是类型错误，不需要额外检查。
 */
type MissingFromDeclared = Exclude<ExtractionEvalSuite, (typeof DECLARED_SUITES)[number]>
const _declaredSuitesAreExhaustive: MissingFromDeclared extends never ? true : never = true
void _declaredSuitesAreExhaustive

/**
 * 类型里预留、但用例表里**还没有**用例的套件。
 *
 * 显式导出让配置生成器把这件事**打出来**：一个"存在但不覆盖任何东西"
 * 的套件必须被看见，否则它会安静地留在那里，让人以为覆盖率比实际大。
 */
export function suitesWithoutCases(): ExtractionEvalSuite[] {
  const covered = new Set(EXTRACTION_EVAL_CASES.map((c) => c.suite))
  return DECLARED_SUITES.filter((id) => !covered.has(id))
}

// ---------------------------------------------------------------------------
// Promptfoo 配置计划（生成器与 runner **共用这一份**）
// ---------------------------------------------------------------------------

export interface PromptfooConfigPlan {
  /** 相对仓库根的路径 */
  file: string
  suiteId: ExtractionEvalSuite
  live: boolean
  /** 该档实际会跑的用例 id（顺序 = 先离线后真实模型） */
  caseIds: readonly string[]
}

/**
 * "应该存在哪些 Promptfoo 配置" —— **唯一定义**。
 *
 * ============================================================================
 *  ⚠️ 为什么必须抽出来共用：生成器与 runner 曾经各写了一遍，然后漂移了
 * ============================================================================
 * 生成器按"真实模型档的用例 = 离线用例 + 需要模型的用例"生成，
 * 因此 `failure` 套件**也有**一个 live 配置（它只有注入型用例，
 * 但那些用例在 live 档下同样会跑 —— 而且"live 档不跳过注入路径"
 * 本身是值得验证的性质）。
 *
 * 而 runner 的核对写的是"有 `liveCases` 的套件数"，于是它算成 4，
 * 目录里却有 5 —— 核对报红说"配置数与用例表不一致"。
 *
 * 核对**红得对**（两处确实不一致），但它指错了方向：真实的缺陷是
 * "同一条规则有两个实现"。所以修法不是把 runner 的数字改成 5，
 * 而是让两边调**同一个函数**。
 *
 * 规则：
 *   离线配置  —— 有离线用例时生成（真实模型用例在离线档被排除）
 *   真实模型档 —— 该套件**有任何用例**就生成（live 档不排除任何用例：
 *                 注入 / 意图规则这些不需要模型的用例两档都跑）
 */
export function promptfooConfigPlan(): PromptfooConfigPlan[] {
  const plan: PromptfooConfigPlan[] = []

  for (const info of suiteInfos()) {
    if (info.offlineCases.length > 0) {
      plan.push({
        file: `evals/m4/promptfoo/${info.id}.yaml`,
        suiteId: info.id,
        live: false,
        caseIds: info.offlineCases.map((c) => c.id),
      })
    }

    const liveRun = [...info.offlineCases, ...info.liveCases]
    if (liveRun.length > 0) {
      plan.push({
        file: `evals/m4/promptfoo/${info.id}.live.yaml`,
        suiteId: info.id,
        live: true,
        caseIds: liveRun.map((c) => c.id),
      })
    }
  }

  return plan
}
