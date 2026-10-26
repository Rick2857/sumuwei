/**
 * 写内容的**来源归属**（纯函数 · 零 IO）。
 *
 * 动机（F2 协议 §3.4 / 小修订 R1）：规则要"只约束**从某个源派生**的写"，
 * 但"**读过哪个源**"**不能**证明"**写进去的内容来自哪个源**" ⇒ 必须把两者分开。
 *
 * 设计要点（**保守优先**）：
 *  · 归属不明 ⇒ `unknown`，**绝不**猜成"可靠来源"（否则会用规则去否决一个其实无所谓的写）。
 *  · 只认**当前任务范围内**的成功读回执；跨任务的旧读、失败的读、未执行候选（无回执）都不算数。
 *  · 读后源内容变了 ⇒ 归属不明（回执指向的内容已经不是现在的源）。
 *  · 两个源内容相同 ⇒ 归属**不明**（内容无法区分来源；此时守卫按内容真值判定即可）。
 *  · 归属只用于**规则作用域**；真正的放行/拒绝由**内容真值守卫**负责。
 */

/** 一次**成功**的读回执（内容指纹来自受信读面，不是模型自述）。 */
export interface WriteSourceReadReceipt {
  /** 读到的路径（绝对或相对都行，调用方负责归一）。 */
  readonly path: string
  /** 读到内容的指纹（与写候选的内容指纹同一算法）。 */
  readonly contentFingerprint: string
  /** 该读所属的**任务 id**（跨任务的读不算数）。 */
  readonly taskId: string
  /** 读成功？失败的读**不**提供回执（这里只收录成功的）。 */
  readonly ok: true
}

/** 域里声明的**源**（谁可以被读、内容指哪一路策略）。 */
export interface WriteSourceDeclaration {
  /** 源的种类：缓存源 / 权威源（**闭集语义**，但取值由域声明）。 */
  readonly kind: 'cache' | 'authoritative'
  /** 源路径。 */
  readonly path: string
}

/** 一次**待判定**的写（内容指纹来自候选内容）。 */
export interface WriteSourceCandidate {
  readonly contentFingerprint: string
  /** 候选所在任务（只有**同任务**的读回执算数）。 */
  readonly taskId: string
}

export type WriteSourceAttribution = 'cache' | 'authoritative' | 'unknown'

export interface WriteSourceAttributionResult {
  readonly attribution: WriteSourceAttribution
  /** 不明/已知的原因（**闭集**，便于门里逐条断言）。 */
  readonly reason:
    | 'traced_to_cache_read'
    | 'traced_to_authoritative_read'
    | 'no_read_receipt'
    | 'content_not_traced_to_any_read'
    | 'ambiguous_multiple_sources'
    | 'sources_have_identical_content'
    | 'read_out_of_task_scope'
    | 'source_changed_after_read'
  /** 参与判定的回执数（可核对）。 */
  readonly receiptsConsidered: number
}

/**
 * 判定一次写的**来源归属**。
 *
 * @param declarations 域声明的源（可为空 ⇒ 一律 unknown）
 * @param receipts 当前任务范围内的**成功**读回执
 * @param candidate 待判定的写
 * @param currentSourceFingerprints 源**当前**的内容指纹（用于发现"读后源变了"）
 */
export function attributeWriteSource (input: {
  readonly declarations: readonly WriteSourceDeclaration[]
  readonly receipts: readonly WriteSourceReadReceipt[]
  readonly candidate: WriteSourceCandidate
  readonly currentSourceFingerprints?: Readonly<Record<string, string>>
}): WriteSourceAttributionResult {
  const { declarations, receipts, candidate } = input
  const inScope = receipts.filter(receipt => receipt.taskId === candidate.taskId)
  if (inScope.length === 0) {
    return { attribution: 'unknown', reason: receipts.length === 0 ? 'no_read_receipt' : 'read_out_of_task_scope', receiptsConsidered: 0 }
  }
  // 读后源内容变了 ⇒ 回执指向的内容已经不是现在的源 ⇒ 归属不明
  const current = input.currentSourceFingerprints ?? {}
  const changed = inScope.some(receipt => {
    const fingerprint = current[receipt.path]
    return fingerprint !== undefined && fingerprint !== receipt.contentFingerprint
  })
  if (changed) {
    return { attribution: 'unknown', reason: 'source_changed_after_read', receiptsConsidered: inScope.length }
  }
  // 内容匹配到哪些源（同内容的两个源无法区分）
  const matched = declarations.filter(declaration =>
    inScope.some(receipt => receipt.path === declaration.path && receipt.contentFingerprint === candidate.contentFingerprint))
  if (matched.length === 0) {
    return { attribution: 'unknown', reason: 'content_not_traced_to_any_read', receiptsConsidered: inScope.length }
  }
  const kinds = [...new Set(matched.map(declaration => declaration.kind))]
  if (kinds.length > 1) {
    const contents = new Set(matched.map(declaration => {
      const receipt = inScope.find(item => item.path === declaration.path)
      return receipt?.contentFingerprint ?? ''
    }))
    return {
      attribution: 'unknown',
      reason: contents.size === 1 ? 'sources_have_identical_content' : 'ambiguous_multiple_sources',
      receiptsConsidered: inScope.length,
    }
  }
  const kind = kinds[0]!
  return {
    attribution: kind,
    reason: kind === 'cache' ? 'traced_to_cache_read' : 'traced_to_authoritative_read',
    receiptsConsidered: inScope.length,
  }
}
