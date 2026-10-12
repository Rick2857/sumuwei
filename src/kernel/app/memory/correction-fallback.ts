/**
 * CorrectionTargetFallback —— **B① 的目标层兜底（M6.1 WP5 / ADR-058）**。
 *
 * ============================================================================
 *  它解决的是哪一步（先读 explicit-service.ts 的 correct() 顺序）
 * ============================================================================
 * correct() 的顺序是：**先解析目标、再抽内容**。而 SRP-C-04 / SRP-C-09 的失败
 * 发生在第一步：
 *
 *     「更正一下，我转到历史学了。」  vs  库里 education.major = 汉语言文学
 *     「更正一下，我换成 Mac 了。」    vs  库里 device.primary  = Windows 笔记本
 *
 * 解析器第 3 步的相关性闸（`lexicalOverlapHits`）是**词面存在性**判定——
 * 这两句话与旧值**零词面重叠** ⇒ `not_found` ⇒ 短路返回，抽取器根本没被调用。
 * （正控「我的专业是历史学」之所以成功，是因为「专业」命中了登记表的中文说法。）
 *
 * ---------------------------------------------------------------------------
 *  兜底的形状（用户 2026-09-25 裁定 R1；ADR-058 §1）
 * ---------------------------------------------------------------------------
 *   ① 只对 intent=correct 生效，且只在正常解析失败（not_found）时尝试；
 *   ② 目标 = "与触发事件**同一会话**内、该用户**最近一次显式写入**"——
 *      候选覆盖 ≥2 个不同槽位 ⇒ **拒绝**（target_ambiguous），维持诚实失败；
 *   ③ 更正句必须对**那一个槽位**抽出过守卫的值（本文件的 `extractCorrectionValue`，
 *      **不经过**全局抽取器）⇒ ②③ 同时成立才用；
 *   ④ 否则什么都不做（不猜、不写、不撤）。
 *
 * ⚠️ 本文件**全是纯函数**：读库的端口在 `ExplicitMemoryServiceDeps.recentExplicitWrites`
 *    （装配层接线，缺省不注入 ⇒ 行为与今天逐字相同）。
 * ⚠️ 转换标记「换成/转到/改成/改为」是**闭集**（ADR-058 D-58c 冻结）——
 *    它们**不进** `content-extractor.ts` 的任何全局线索表；扩充 = 新 ADR。
 */

import type { MemoryRecord } from '../../contracts/index.ts'
import type { ExtractedMemoryContent } from './content-extractor.ts'
import { lexicalOverlapHits } from './target-resolver.ts'

// ---------------------------------------------------------------------------
// 版本
// ---------------------------------------------------------------------------

/**
 * **兜底规则版本**（`correction-fallback@N`）。
 *
 * 它跟着"转换标记表 + 指代前缀表 + 把字句守卫 + B② 槽位限定抽取闸"这套**解析知识**走
 * ——任一改动都必须升版本（与 `CONTENT_RULE_VERSION` 同一条纪律）。
 * ⚠️ 它**不**替代 `processorVersion`：落库仍记 `explicit-memory@1`（D-58g，与 D-56f 同理）。
 *
 * @2（2026-09-25，用户裁定 B② / ADR-063）：新增**槽位限定抽取闸**——
 *   B① 标记取值失败后，用**规则抽取器**跑更正句，仅当恰好抽出**目标槽位**的
 *   claim 才采用（实测缺口：SRP-C-05「更正一下，我读研究生了。」——无转换标记，
 *   B① 四道守卫全过不了；抽取器对「研究生」有 education.status=graduate 规则）。
 *   B① 的行为逐字不变，只是不再是"抽不出就到此为止"。
 */
export const CORRECTION_FALLBACK_VERSION = 'correction-fallback@2'

// ---------------------------------------------------------------------------
// ① 选靶：会话内最近一次显式写入
// ---------------------------------------------------------------------------

/**
 * 从"会话内该用户的显式写入（由端口给出，**最近在前**）"里选出兜底目标。
 *
 * 返回值三种，对应三种**必须不同**的后续行为：
 *   `undefined`                —— 没有候选 ⇒ 调用方维持今天的 `target_not_found`
 *   `{ status: 'ambiguous' }`  —— 候选覆盖 ≥2 个不同槽位 ⇒ 调用方回报 `target_ambiguous`
 *                                 （诚实失败换了一种：她该问"哪一件？"，而不是"没找到"）
 *   `{ status: 'targeted' }`   —— 恰好 1 个槽位 ⇒ 取该槽位**最近**的一条
 *
 * ⚠️ **归组按 `canonicalKey`**（槽位身份；qualifier scope 不同的断言是两个槽位），
 *    但 `slot` / `slots` 返回的是**可读 predicate**——canonicalKey 是摘要哈希，
 *    把它拼进用户可见的失败详情等于给她一串十六进制。
 * ⚠️ 只数**有槽位**（canonicalKey ≠ undefined，即 Claim 型）的候选：
 *    Episode 没有"值"可言，对它做"换成 X"既抽不出值也无处可写。
 *    （实践中显式路径只产 Claim——规则与模型抽取器的输出都是 claim——这条过滤是防御。）
 * ⚠️ 只数 **ACTIVE** 的候选：superseded / retracted 的记录不是"现在的值"，
 *    对它们做更正既无意义也会造出错误的历史链。
 */
export type RecentExplicitWriteTarget =
  | { status: 'targeted'; record: MemoryRecord; slot: string }
  | { status: 'ambiguous'; records: MemoryRecord[]; slots: string[] }

/** 可读槽位名（claim 的 predicate；防御性兜底到 canonicalKey） */
function readableSlotOf(record: MemoryRecord): string {
  return record.content.kind === 'claim' ? record.content.predicate : String(record.canonicalKey)
}

export function pickRecentExplicitWriteTarget(
  records: readonly MemoryRecord[]
): RecentExplicitWriteTarget | undefined {
  const candidates = records.filter(
    (record) => record.status === 'active' && record.canonicalKey !== undefined
  )
  if (candidates.length === 0) return undefined

  const distinctKeys = new Set(candidates.map((record) => record.canonicalKey!))
  if (distinctKeys.size >= 2) {
    /*
     * 会话里显式写过 ≥2 个不同槽位 ⇒ "最近一次写入"不再是确定性的答案
     * （这句更正可能指任何一件）。按 D-58b 拒绝，绝不挑一条。
     */
    const slots = [...new Set(candidates.map((record) => readableSlotOf(record)))]
    return { status: 'ambiguous', records: candidates, slots }
  }

  // 端口契约保证"最近在前"；同一槽位若有多条（理论上是 supersede 链的残留），
  // 取最近的那条——它才是"现在的值"。
  const record = candidates[0]!
  return { status: 'targeted', record, slot: readableSlotOf(record) }
}

// ---------------------------------------------------------------------------
// ② 槽位限定的取值（不经过全局抽取器）
// ---------------------------------------------------------------------------

/**
 * 转换标记（闭集 · ADR-058 D-58c 冻结）。
 *
 * ⚠️ 为什么是闭集、且不进 `content-extractor.ts` 的线索表：
 *    用户裁定 19.2 逐字——「不得把『换成』『转到』无条件变成全局记忆指令」。
 *    它们只在"目标槽位已可确定"的兜底里被读，永远不参与"这句话是不是记忆指令"
 *    或"这句话落在哪个槽位"的全局判定 ⇒ 抽取器层那条 ★负控继续成立。
 */
const TRANSITION_MARKERS: readonly string[] = ['换成', '转到', '改成', '改为']

/**
 * 取值**不得以指代/量词开头**（闭集；扩充 = 升版本 + 新 ADR）。
 *
 * 「换成另一首了」「换成这台了」这一类取值说的是"换掉的那个东西的同类"，
 * 不是新值本身——把它写进槽位等于把一句没说清的话存成长期事实。
 * 用户裁定的原始清单是「这/那/另/同/几/一」，这里补上同类的量词/指代字
 * （某/每/个/各/本/其），仍是**确定性**判据。
 */
const REFERENTIAL_VALUE_PREFIX = /^[这那另同几一某每个各本其]/

/** 小句边界（取值只取标记之后的**同一个小句**） */
const CLAUSE_BOUNDARY = /[。！？；，,、\n]/

/** 句末语气词（「历史学**了**」「Mac **了**」——"了"不属于值） */
const TRAILING_MODAL = /(了|啦|咯)$/

/** 取值长度上限（与 `content-extractor.ts` 的 extractFreeTextValue 同界） */
const MAX_VALUE_LENGTH = 60

/**
 * 从更正句里为**指定的目标槽位**抽出新值。
 *
 * 返回 `undefined` = 抽不出**过守卫的**值 ⇒ 调用方什么都不做（不猜、不写、不撤）。
 *
 * ============================================================================
 *  四道守卫（D-58d；全部确定性，失败方向安全）
 * ============================================================================
 *   ① 非空；② ≤60 字；③ 不得以指代/量词开头；
 *   ④ **把字句守卫**：「把X<标记>」且 X 与目标记录**词面相关**才接受。
 *
 * ④ 的理由（负控 `neg-alarm-prior` 的形状）：
 *
 *     前置：device.primary = Windows 笔记本
 *     「更正一下，我把闹钟换成七点了。」
 *     —— 「七点」本身过得了 ①②③！挡住它的是"这句话在说**闹钟**，不在说设备"。
 *
 * 判"在说什么"用的是与解析器第 3 步**同一份**实现（`lexicalOverlapHits`，
 * `includeRegistrySurfaceForms: true`——要的是召回：「电脑」要能对上 device.primary）。
 * 不在这里新造一张词表：任何手工词表都会在某天漏一个分支（`entity.ts` 的同一条理由）。
 *
 * ⚠️ 只在「把」与标记**同小句**时才施加守卫：「我先把手机放下了，后来换成 Mac 了」
 *    里的「把」属于另一个小句，不是被换的对象。
 */
export function extractCorrectionValue(
  text: string,
  target: MemoryRecord
): { value: string; basis: string } | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined

  // --- 找最靠前的转换标记（多个标记时，最靠前的那个最可能是"真正的转换"）------
  let markerIndex = -1
  let marker = ''
  for (const candidate of TRANSITION_MARKERS) {
    const index = trimmed.indexOf(candidate)
    if (index >= 0 && (markerIndex < 0 || index < markerIndex)) {
      markerIndex = index
      marker = candidate
    }
  }
  if (markerIndex < 0) return undefined

  // --- 守卫④：把字句（同小句的「把X<标记>」）--------------------------------
  const baIndex = trimmed.lastIndexOf('把', markerIndex)
  if (baIndex >= 0) {
    const objectPhrase = trimmed.slice(baIndex + 1, markerIndex)
    const sameClause = !CLAUSE_BOUNDARY.test(objectPhrase)
    if (sameClause && objectPhrase.trim() !== '') {
      const hits = lexicalOverlapHits(objectPhrase, [target], {
        includeRegistrySurfaceForms: true,
      })
      if (hits.length === 0) {
        // 「把闹钟换成…」「把这首歌换成…」——这句话说的不是那个槽位。
        // 拒绝 ⇒ 调用方维持今天的诚实失败。
        return undefined
      }
    }
  }

  // --- 取值：标记之后的同一个小句，剥句末语气词 ------------------------------
  const after = trimmed.slice(markerIndex + marker.length)
  const clause = after.split(CLAUSE_BOUNDARY)[0] ?? ''
  const value = clause
    .replace(/^[\s：:]+/, '')
    .replace(TRAILING_MODAL, '')
    .trim()

  // --- 守卫①②③ -----------------------------------------------------------
  if (value === '') return undefined
  if (value.length > MAX_VALUE_LENGTH) return undefined
  if (REFERENTIAL_VALUE_PREFIX.test(value)) return undefined

  const slot =
    target.content.kind === 'claim' ? target.content.predicate : String(target.canonicalKey)
  return {
    value,
    /*
     * basis 进 trace/审计读数：只含**标记与槽位**，不含取值正文
     * （计划书第 110 节：记忆内容不进 trace）。
     */
    basis:
      `B① 兜底（${CORRECTION_FALLBACK_VERSION}）：转换标记「${marker}」⇒ 同小句取值；` +
      `目标 = 会话内最近一次显式写入（${slot}）`,
  }
}

// ---------------------------------------------------------------------------
// ③ B② 槽位限定抽取闸（2026-09-25 用户裁定 / ADR-063）
// ---------------------------------------------------------------------------

/**
 * B②：把**已经抽好的**内容交给这里判——抽取本身由调用方用它绑定的抽取器做
 * （本文件保持纯函数，不 import 抽取器）。
 *
 * 接受的**充要条件**：内容是 claim ∧ `predicate === 目标槽位`。
 * 任何其他形状（episode / 别的槽位 / predicate 缺失）⇒ `undefined` ⇒ 调用方
 * 维持诚实失败（不猜、不写、不撤）。
 *
 * ============================================================================
 *  为什么这样是安全的（ADR-063 §2；对照 B① 的四道守卫）
 * ============================================================================
 *   · **槽位闸就是全部语义**：目标槽位已经由 B① 的选靶确定（会话内恰好一个），
 *     这里只接受"抽取器也认为这句话在说**那个槽位**"的读数——
 *     「更正一下，我把闹钟换成七点了。」对 device.primary 抽不出任何 claim
 *     （闹钟/七点不在任何规则表里）⇒ 照旧失败；
 *   · **不经过全局写入**：抽取结果只贡献"值"，槽位仍来自目标记录（与 B① 同构）；
 *   · **负向守卫继承**：抽取器自己的 negativeGuards（「不吃辣」⇒ 回避辣 而非 喜欢辣）
 *     在 extract() 里已经跑过，B② 不重复也不绕过；
 *   · **失败方向安全**：extract() 抛错 / 返回 undefined / 槽位不匹配 ⇒ 一律 undefined。
 */
export function slotRestrictedCorrectionValue(
  extracted: ExtractedMemoryContent | undefined,
  target: MemoryRecord
): { value: string; basis: string } | undefined {
  if (extracted === undefined) return undefined
  if (extracted.content.kind !== 'claim') return undefined // 防御：episode 无值可言
  if (target.content.kind !== 'claim') return undefined // 防御：目标无槽位（端口契约已保证）

  const targetSlot = target.content.predicate
  if (extracted.content.predicate !== targetSlot) return undefined // 不是那个槽位 ⇒ 不猜

  if (typeof extracted.content.value !== 'string' || extracted.content.value === '') {
    return undefined
  }

  return {
    value: extracted.content.value,
    /*
     * basis 只含**路径与槽位**，不含取值正文（与 B① 同一条纪律）。
     */
    basis:
      `B② 兜底（${CORRECTION_FALLBACK_VERSION}）：规则抽取器命中目标槽位；` +
      `目标 = 会话内最近一次显式写入（${targetSlot}）`,
  }
}
