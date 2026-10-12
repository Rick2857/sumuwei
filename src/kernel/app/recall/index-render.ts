/**
 * M9.5 **启用计划 / WP1** —— 派生索引的**两个冻结决定**（规范渲染 + 索引资格政策）。
 *
 * ============================================================================
 *  为什么这两个决定必须先于写侧（计划 §1 WP1 逐字）
 * ============================================================================
 * ```text
 * 「这两个决定目前**谁都没做**，而它们决定"索引里装什么"，做完就**改不动**
 *   （改了 = 换代）。」
 * ```
 * 在这之前：`renderer_version` 在 `src/**` **只有列定义**，渲染只存在于 M9.5 实验室脚本的
 * 内联拼串里（`` `${manifest.passagePrefix}${predicate} ${value}` ``）—— 而**索引资格政策
 * 今天没有任何人定义**，覆盖率却全靠它。
 *
 * ============================================================================
 *  两个"唯一实现"（不许在本文件里另写一份）
 * ============================================================================
 * ```text
 *   · 完整性：**注入**读数（与检索适配器注入的是同一个 `memoryIntegrityProblems()`）
 *   · 前缀：**逐字**来自冻结的编码清单 `evals/m9.5/embedding-manifest.json`
 *     （`passagePrefix = "passage: "` / `queryPrefix = "query: "`）
 * ⚠️ **状态 → 理由的映射刻意不在这里复用召回面那一份** —— 那是 M5 的静态锁 AT2.1 的要求，
 *    理由与"两个坑"写在下面 `statusReasonOf` 的注释里。
 * ```
 *
 * ============================================================================
 *  ⚠️ 本文件**刻意**保守的两处（都是"宁可少索引，也不索引一个没测过的表示"）
 * ============================================================================
 * ```text
 *  ① **Claim 与 Episode 的渲染形式**（`@2` 起 Episode 也进索引）：
 *     · Claim   → `passage: <predicate> <value>`（**自 `@1` 起一字未改**）
 *     · Episode → `passage: <summary>`（**`@2` 追加**，用已有字段，不构造文本）
 *     `@1` 曾把 Episode 具名排除（`content:episode`），理由是"没有 predicate、
 *     编一个形式等于发明没人测过的表示"。`@2` 的答复是：**不编** ——
 *     用已有摘要，且形式与 Claim 同一种。但**效果仍须测量**（用户要求），
 *     本条升级不主张"这样就召得回来"。
 *  ② **qualifiers 不进渲染文本**（与实验室那份内联拼串逐字一致）。后果：限定范围不同的两条
 *     记忆会渲染出**同一段文本**（向量也相同）⇒ 语义通道**分不开**它们，但词面通道与
 *     "qualifier 感知的选择"仍然分得开，且**不会产生错误主张**。⇒ 登记为局限，**不改形式**
 *     （改形式 = 新 `RENDERER_VERSION` + 重跑校准链）。
 * ```
 *
 * ⚠️ 纯函数、无数据库、无模型（与 `index-maintenance.ts` 同一条纪律）。
 */

import { createHash } from 'node:crypto'

import type { MemoryRecord, MemoryStatus } from '../../contracts/memory.ts'

/**
 * **渲染器版本** —— 列 `memory_semantic_index.renderer_version` /
 * `memory_semantic_generations.renderer_version` 已冻结，必须有实现与之对应。
 *
 * 改这个常量 = **换代**（同一代内不得混两种渲染）。
 */
/**
 * 渲染器版本。
 *
 * ============================================================================
 *  `@1` → `@2`（后 Lv2 · 用户 2026-10-03 裁定选项 a）
 * ============================================================================
 * ```text
 *   @1  只渲染 Claim：`passage: <predicate> <value>`
 *       Episode 具名排除（`content:episode`）—— 理由见下（当时是对的）
 *
 *   @2  **追加** Episode 的渲染：`passage: <summary>`
 *       Claim 的文本**一字未改**（升级是纯追加 ⇒ Claim 的向量与读数不受影响）
 * ```
 *
 * ⚠️ **为什么 `@2` 敢给 Episode 一个形式，而 `@1` 不敢**：
 * `@1` 的顾虑是"给 Episode 编一个形式等于发明一个没人测过的表示"。
 * 那个顾虑**仍然成立** —— 所以 `@2` **不是**随手编的：
 * ```text
 *   ① 用的是**已有字段**（`summary`），不构造新文本、不做模板拼接
 *   ② 形式与 Claim **同一种**：`passage: <自然语言>`
 *      （E5 系模型的官方用法就是 `passage: <文本>` / `query: <文本>` 前缀 ——
 *        两种前缀**必须成对**，写侧 `passage:` 配查询侧 `query:`）
 *   ③ 它的效果**仍然必须被测量**（用户明确要求"本地效果仍须测量"）——
 *      本条升级**不主张**"这样就召得回来"
 * ```
 * ⇒ 升版本号正是承认"这确实换了形式"：M9.5 的校准读数必须**按新版本重跑**，
 *    而不是让旧读数继续冒充描述当前渲染器。
 */
export const RENDERER_VERSION = 'semantic-render@2'

/**
 * 两侧前缀 —— **逐字**来自冻结清单（`evals/m9.5/embedding-manifest.json`）。
 *
 * ⚠️ 写错前缀会**静默降质**（M9.5 / WP3 的 E5 约定）：多语言 E5 靠前缀区分
 * "这段话是被检索的"与"这段话是查询"，两者用反了不会报错，只会变差。
 */
export const PASSAGE_PREFIX = 'passage: '
export const QUERY_PREFIX = 'query: '

/** 渲染结果（进向量的那段文本 + 它的内容 hash） */
export interface RenderedPassage {
  readonly text: string
  /** `sha256(text)` 十六进制。⚠️ 列设计如此：**只存 hash，不存明文副本**（计划 §8.1） */
  readonly contentHash: string
}

/** 排除理由（**具名、可审计**）—— `excluded_by_policy_count` 按它分列 */
export type IndexExclusionReason =
  | 'status:retracted'
  | 'status:superseded'
  | 'status:disputed'
  | 'status:not-active'
  | `integrity:${string}`
  | 'content:episode'
  | 'content:empty'

export type IndexEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: IndexExclusionReason }

/** 资格判定需要的输入（**注入读数**，本模块不读库） */
export interface IndexEligibilityInput {
  readonly record: MemoryRecord
  /**
   * 完整性读数（空数组 = 无问题）。
   *
   * ⚠️ 与检索适配器注入的是**同一个** `memoryIntegrityProblems()` ⇒
   * "链断了 / 证据悬空"在两处是同一个判定（`integrity_orphaned`）。
   */
  readonly integrityProblems: readonly string[]
}

/** 渲染的结果：成功、或**具名拒绝** */
export type RenderOutcome =
  | { readonly ok: true; readonly rendered: RenderedPassage }
  | { readonly ok: false; readonly reason: IndexExclusionReason }

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 把一条记忆渲染成**进向量的那一段文本**（`RENDERER_VERSION = semantic-render@1`）。
 *
 * 形式（与 M9.5 实验室那份内联拼串**逐字一致** —— 这是刻意的：换形式会让那些校准读数
 * 不再描述生产渲染器）：
 *
 * ```text
 *   passage: <predicate> <value>
 * ```
 */
export function renderMemoryForIndex(record: MemoryRecord): RenderOutcome {
  /*
   * ---------------------------------------------------------------------------
   * Episode（`semantic-render@2` 追加；后 Lv2 · 用户裁定选项 a）
   * ---------------------------------------------------------------------------
   * 形式：`passage: <summary>` —— **直接用已有摘要**，不构造、不拼接。
   * ⚠️ 摘要为空 ⇒ 排除（`content:empty`），与 Claim 取值空同一条纪律：
   *    没有内容可检索的东西不该进索引。
   */
  if (record.content.kind === 'episode') {
    /*
     * ⚠️ 取值要**防御性**：形状坏的记录（`summary` 缺失 / 不是字符串）必须走
     * "具名排除"这条路，**不许**抛 —— 索引政策遇到一条坏记录时的正确反应是
     * 把它排除并记理由，而不是让整趟索引崩掉。
     * （实测：本门第一次跑就有一条 `kind: 'episode'` 但没有 `summary` 的夹具。）
     */
    const summary = typeof record.content.summary === 'string' ? record.content.summary : ''
    if (summary.trim() === '') {
      return { ok: false, reason: 'content:empty' }
    }
    const text = `${PASSAGE_PREFIX}${summary}`.trimEnd()
    return { ok: true, rendered: { text, contentHash: sha256Hex(text) } }
  }
  if (record.content.kind !== 'claim') {
    /* 其余种类（今天没有生产者）仍**具名排除**，不发明形式 */
    return { ok: false, reason: 'content:episode' }
  }
  const value = record.content.value
  if (stringifyValue(value).trim() === '') {
    /* ⚠️ 取值为空 ⇒ 这条 Claim 没有内容可检索（只剩一个槽位键）⇒ 不进索引 */
    return { ok: false, reason: 'content:empty' }
  }
  const text = `${PASSAGE_PREFIX}${record.content.predicate} ${stringifyValue(value)}`.trimEnd()
  return { ok: true, rendered: { text, contentHash: sha256Hex(text) } }
}

/**
 * 查询侧的渲染 —— **同一处**决定前缀（避免"写侧一个、查询侧另一个"的漂移）。
 *
 * ⚠️ 查询侧的文本**不进任何表**：它只在一次检索里存在（隐私边界）。
 */
export function renderQueryForIndex(queryText: string): string {
  return `${QUERY_PREFIX}${queryText.trim()}`
}

/**
 * **索引资格政策**（计划 §1 WP1-B 的三个问题，逐条回答）。
 *
 * ```text
 *   ① 只 active？（撤回 / 被取代 / 在审 / 归因降档 怎么算）
 *        ⇒ **只 active**。其余一律**排除**并记具名理由：
 *          retracted → 'status:retracted' · superseded → 'status:superseded'
 *          disputed（在审） → 'status:disputed' · 其它非 active → 'status:not-active'
 *        ⚠️ 状态 → 理由的映射由**本模块自己拥有**（索引政策自己的词汇 `status:*`）——
 *           见 `statusReasonOf` 的注释（AT2.1 的静态锁）。
 *        ⚠️ **"归因降档"的落实范围（如实登记）**：本政策把**链断了**（完整性读数非空，
 *           即 `integrity_orphaned`）算作排除；而 M5.1.1 的**排序级降档**
 *           （epistemic requalification —— 降的是排名与 prompt 标签，**不是**资格）
 *           **不**排除记忆。理由：那一层的语义是"降档"而不是"排除"，
 *           把降档件从索引里剔掉会让"她仍然记得、只是排得低"变成"语义通道完全看不见"
 *           ⇒ 属**另一条裁定**，见 ADR-081 §5。
 *   ② 与"遗忘"（retracted）的关系：**排除**（记 'status:retracted'），
 *      与召回面同一条状态语义（但**理由词汇**是本政策自己的，见上）。
 *   ③ `excluded_by_policy_count` 的具名理由：见 `IndexExclusionReason`（可审计）。
 * ```
 */
export function indexEligibility(input: IndexEligibilityInput): IndexEligibility {
  const status: MemoryStatus = input.record.status
  if (status !== 'active') {
    return { eligible: false, reason: statusReasonOf(status) }
  }
  for (const problem of input.integrityProblems) {
    if (problem !== '') return { eligible: false, reason: `integrity:${problem}` }
  }
  const rendered = renderMemoryForIndex(input.record)
  if (!rendered.ok) return { eligible: false, reason: rendered.reason }
  return { eligible: true }
}

/**
 * 状态 → **索引政策**的具名排除理由。
 *
 * ============================================================================
 *  ⚠️ 为什么这里**不**复用召回面的状态映射（2026-09-30 实测）
 * ============================================================================
 * 第一版复用了它（并把 `FORGOTTEN` / `SUPERSEDED` 翻译成本政策的理由串），
 * 结果被 **M5 的静态锁 AT2.1 当场判红**：
 *
 * ```text
 * ⑥ 静态锁：判断只有一处（AT2.1 / AT2.2）
 *   ✗ 状态 → 理由的映射只有一个消费者
 *       实际: ["src/kernel/app/recall/index-render.ts", "src/kernel/recall/eligibility.ts"]
 *   ✗ 排除理由的字符串不许出现在**判定层**
 *       实际: ["…index-render.ts → FORGOTTEN", "…index-render.ts → SUPERSEDED"]
 * ```
 *
 * **那条锁是对的**：召回面的状态映射，它的消费者只许有一处；多一个消费者就是"判断散落"
 * 的开始。而本模块要的不是召回面的理由，是**索引政策**的理由 —— 那是**另一张映射表**
 * （`status → IndexExclusionReason`），本来就该由本模块拥有。
 *
 * ⇒ 于是这里**直接看 `status`**（`D-1` 的政策就是"只 active"）。
 *
 * ⚠️ **两个坑，写给下一个改这里的人**：
 *   ① 锁的检测器是**字面量**匹配 —— 它连**注释**里出现那个"函数名 + 左括号"都算一个消费者
 *      （`scripts/verify-m5-eligibility.ts:640-651` 用 `readSource` 而**不** `stripComments`）
 *      ⇒ 本注释因此**刻意**不写出那个调用形状。别"顺手"把它补回去。
 *   ② 理由串也不许出现在判定层 ⇒ 本模块用的是自己的 `status:*` 词汇，不是召回面那两个。
 */
function statusReasonOf(status: MemoryStatus): IndexExclusionReason {
  switch (status) {
    case 'retracted':
      return 'status:retracted'
    case 'superseded':
      return 'status:superseded'
    case 'disputed':
      return 'status:disputed'
    case 'active':
      /* 调用方已先挡掉 active ⇒ 走到这里说明两处判据不再自洽 */
      return 'status:not-active'
  }
}

/**
 * 取值 → 文本。
 *
 * ⚠️ **确定性**是硬要求：同一个取值必须永远渲染出同一段文本，否则 `content_hash`
 * 会无故变化 ⇒ 触发无意义的重编码（甚至让"没变"看起来像"变了"）。
 * 因此这里对对象做**按键排序**的稳定序列化，而不是 `JSON.stringify` 的插入序。
 */
function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map((entry) => stringifyValue(entry)).join(', ')
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    )
    return entries.map(([key, entry]) => `${key}=${stringifyValue(entry)}`).join(' ')
  }
  return String(value)
}
