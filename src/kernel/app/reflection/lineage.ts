/**
 * M11 WP2 —— **纯根解析器**（ADR-085 §4.4 / `D05` / `D31`）。
 *
 * ============================================================================
 *  它做什么（一句话）
 * ============================================================================
 * 把调用方给的一组 source handle **展开到原始经历（对话事件）**，按**真实 ID 去重**，
 * 并如实报出"追不到 / 成环 / 超限 / 悬空 / 跨角色"这几种不可用于采纳的理由。
 *
 * ============================================================================
 *  为什么这几条纪律是硬的，不是风格问题
 * ============================================================================
 * ```text
 * ① **按确切 ID 批量查**，不逐条 N+1，也**禁止**用检索排名/top-k 判断依赖是否存在
 *    （先例：`belief/eligibility.ts` 的逐字纪律 —— "旧来源掉出候选 ≠ 不存在"）。
 * ② **派生节点不参与增信**：同一个根经 Memory / Belief / Reflection 三条路进来，
 *    有效根**仍然只算 1**（`D05`）。这是 `INV-CI-03` 在代码里的落点。
 * ③ **缺根不可用于采纳**：追不到原始经历的节点**不是**"根为空"，而是具名拒收
 *    （`root_unresolvable`）——"没有证据"与"证据链断了"必须能被读出来。
 * ④ **超限不许截断假装齐全**（`D31`）：深度 16 / 节点 64 触顶 ⇒ 具名拒收，
 *    而不是"返回我们已经看到的那些"。
 * ⑤ **读不到就是不可用**：任一只读端口抛错 ⇒ 原样抛出（失败关闭），
 *    不把"查不了"当成"没有"（先例：`recheckGoalDependencies` 的 `unavailable`）。
 * ```
 *
 * ⚠️ 本模块是**纯的**：没有 SQL、没有 `node:*`、不调模型。取数一律走注入的 `LineageLookup`。
 */

import {
  LINEAGE_MAX_DEPTH,
  LINEAGE_MAX_NODES,
  LINEAGE_SOURCE_CLASSES,
  type LineageConversationReading,
  type LineageDomainEventReading,
  type LineageBeliefReading,
  type LineageHandle,
  type LineageHandleKind,
  type LineageLookup,
  type LineageMemoryReading,
  type LineageRejection,
  type LineageResolution,
  type LineageRoot,
  type LineageSourceClass,
  type LineageStoryEventReading,
} from '../../contracts/reflection-lineage.ts'

/** 节点身份：跨类型不撞号（`memory:abc` 与 `domain_event:abc` 是两条）。 */
type NodeKey = `${LineageHandleKind}:${string}`

function keyOf(kind: LineageHandleKind, id: string): NodeKey {
  return `${kind}:${id}`
}

/**
 * 因果身份键（ADR-093 `D05` + `R-4`）。
 *
 * ⚠️ 对话根与 `user_choice` 故事根**共用** `conversation:` 前缀：同一次选择的
 * 对话记录与故事提交是**一个**因果身份（`S8-C02`）。`system` 提交另起 `story-system:`，
 * 它**不合格**为习惯根（由 `story_root_not_interactive` 拒收）。
 */
function conversationCausalKey(conversationEventId: string): string {
  return `conversation:${conversationEventId}`
}

function systemStoryCausalKey(commitId: string): string {
  return `story-system:${commitId}`
}

interface Child {
  readonly kind: LineageHandleKind
  readonly id: string
}

interface Graph {
  readonly conversation: Map<string, LineageConversationReading>
  readonly domainEvent: Map<string, LineageDomainEventReading>
  readonly memory: Map<string, LineageMemoryReading>
  readonly belief: Map<string, LineageBeliefReading>
  /** **S8 追加**：故事账本读数（键 = 调用方给的引用 id，可能是观测 id 或提交 id） */
  readonly storyEvent: Map<string, LineageStoryEventReading>
  /** 真的从只读面读回来的记录条数（`measured_count` 的输入） */
  measuredCount: number
}

type ChildrenResult =
  | { readonly ok: true; readonly children: readonly Child[] }
  | { readonly ok: false; readonly problem: 'missing' | 'malformed' }

/** 把一条边字段读成 id 数组；非数组或含空元素 ⇒ `null`（⇒ `node_malformed`）。 */
function idArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') return null
    out.push(item)
  }
  return out
}

/** 一个节点的出边（**只**来自我们真的读回来的读数）。 */
function childrenOf(graph: Graph, kind: LineageHandleKind, id: string): ChildrenResult {
  if (kind === 'conversation_event') {
    // 叶子：它**就是**原始根
    return graph.conversation.has(id) ? { ok: true, children: [] } : { ok: false, problem: 'missing' }
  }
  if (kind === 'domain_event') {
    const row = graph.domainEvent.get(id)
    if (row === undefined) return { ok: false, problem: 'missing' }
    const parents = idArray(row.causedByDomainEventIds)
    const sources = idArray(row.sourceConversationEventIds)
    if (parents === null || sources === null) return { ok: false, problem: 'malformed' }
    /* S8：payload 里的故事来源引用作为**另一类**子节点（ADR-093 `D03`）。 */
    const storySources = idArray(row.sourceStoryEventIds ?? [])
    if (storySources === null) return { ok: false, problem: 'malformed' }
    return {
      ok: true,
      children: [
        ...parents.map((parent): Child => ({ kind: 'domain_event', id: parent })),
        ...sources.map((source): Child => ({ kind: 'conversation_event', id: source })),
        ...storySources.map((source): Child => ({ kind: 'story_event', id: source })),
      ],
    }
  }
  if (kind === 'memory') {
    const row = graph.memory.get(id)
    if (row === undefined) return { ok: false, problem: 'missing' }
    const evidences = idArray(row.evidenceConversationEventIds)
    if (evidences === null) return { ok: false, problem: 'malformed' }
    /*
     * **S8**：故事条目证据作为**另一类**子节点（来源类不同 ⇒ 不能混进对话数组）。
     * 缺字段（旧读数构造点）⇒ 读成"没有故事证据"，与 S8 之前逐字一致。
     */
    const storyEvidences = idArray(row.evidenceStoryEventIds ?? [])
    if (storyEvidences === null) return { ok: false, problem: 'malformed' }
    return {
      ok: true,
      children: [
        ...evidences.map((evidence): Child => ({ kind: 'conversation_event', id: evidence })),
        ...storyEvidences.map((evidence): Child => ({ kind: 'story_event', id: evidence })),
      ],
    }
  }
  if (kind === 'story_event') {
    const row = graph.storyEvent.get(id)
    if (row === undefined) return { ok: false, problem: 'missing' }
    /*
     * 故事提交的出边 = **触发它的真实对话事件**（若没有，它就是叶子，
     * 由 `walk` 的 `story_root_not_interactive` 拒收）。
     * 这条边就是 `S8-C02` 的机器形态：沿它走下去会得到一个**同因果键**的对话根，
     * 两者在汇总时按 `causalKey` 合成**一个**根。
     */
    const anchor = row.anchorConversationEventId
    return {
      ok: true,
      children:
        anchor === undefined || anchor.trim() === ''
          ? []
          : [{ kind: 'conversation_event', id: anchor }],
    }
  }
  const row = graph.belief.get(id)
  if (row === undefined) return { ok: false, problem: 'missing' }
  const evidenceRoots = idArray(row.evidenceRootIds)
  const memories = idArray(row.dependsOnMemoryIds)
  if (evidenceRoots === null || memories === null) return { ok: false, problem: 'malformed' }
  return {
    ok: true,
    children: [
      ...evidenceRoots.map((root): Child => ({ kind: 'conversation_event', id: root })),
      ...memories.map((memory): Child => ({ kind: 'memory', id: memory })),
    ],
  }
}

function characterOf(graph: Graph, kind: LineageHandleKind, id: string): string | undefined {
  if (kind === 'conversation_event') return graph.conversation.get(id)?.characterId
  if (kind === 'domain_event') return graph.domainEvent.get(id)?.characterId
  if (kind === 'memory') return graph.memory.get(id)?.characterId
  if (kind === 'story_event') return undefined // 故事账本行不带 character 列（归属由绑定表达）
  return graph.belief.get(id)?.characterId
}

/**
 * 这个节点**有没有**可比对的角色归属。
 *
 * 与 `characterOf` 的区别是"读到了但没有该字段"与"读不到这个节点"：
 * 前者（memory / belief 的归属不由 character 表达）**不**触发 `node_foreign`，
 * 后者（节点根本不存在）由第 1 段记为 `node_missing`。
 */
function hasCharacterScope(graph: Graph, kind: LineageHandleKind, id: string): boolean {
  if (kind === 'conversation_event') return graph.conversation.has(id)
  if (kind === 'domain_event') return graph.domainEvent.has(id)
  if (kind === 'memory') return graph.memory.has(id)
  if (kind === 'story_event') return graph.storyEvent.has(id)
  return graph.belief.has(id)
}

/** 按节点自身可判的属性给出保守的来源类（调用方没给 hint 时用）。 */
function classOfConversation(row: LineageConversationReading): LineageSourceClass {
  if (row.actorType === 'character' || row.actorType === 'assistant') return 'assistant_speech'
  if (row.actorType === 'tool') return 'program_result'
  if (row.actorType === 'user') return 'user_statement'
  return 'internal_interpretation'
}

export interface ExpandLineageOptions {
  /** 归属：跨角色的节点一律拒收（`node_foreign`） */
  readonly characterId: string
}

/** 只读端口的**批量**取数（每种类型一轮；不做 N+1）。 */
async function fetchKind(
  lookup: LineageLookup,
  graph: Graph,
  kind: LineageHandleKind,
  ids: readonly string[]
): Promise<void> {
  if (ids.length === 0) return
  if (kind === 'conversation_event') {
    const rows = await lookup.findConversationEvents(ids)
    graph.measuredCount += rows.length
    for (const row of rows) graph.conversation.set(row.id, row)
    return
  }
  if (kind === 'domain_event') {
    const rows = await lookup.findDomainEvents(ids)
    graph.measuredCount += rows.length
    for (const row of rows) graph.domainEvent.set(row.id, row)
    return
  }
  if (kind === 'memory') {
    const rows = await lookup.findMemories(ids)
    graph.measuredCount += rows.length
    for (const row of rows) graph.memory.set(row.id, row)
    return
  }
  if (kind === 'story_event') {
    /*
     * ⚠️ 端口方法**可选**（ADR-093 `D04` 的兼容边界：S8 之前实现的 lookup 不改也照旧编译）。
     * 缺方法 ⇒ **不猜**：视为"一条都读不到"，于是任何故事 handle 都落到
     * `story_root_unconfirmed` 拒收（失败关闭）。真实实现必须提供它 ——
     * `postlv2:s8:roots:verify` 有正控断言这一点。
     */
    if (lookup.findStoryEvents === undefined) return
    const rows = await lookup.findStoryEvents(ids)
    graph.measuredCount += rows.length
    for (const row of rows) graph.storyEvent.set(row.requestedId, row)
    return
  }
  const rows = await lookup.findBeliefs(ids)
  graph.measuredCount += rows.length
  for (const row of rows) graph.belief.set(row.id, row)
}

/**
 * 展开一组 handle 到原始根。
 *
 * @throws 只读端口抛错时**原样抛出**（调用方必须判"不可用"，不得当成空结果）
 */
export async function expandLineage(
  lookup: LineageLookup,
  handles: readonly LineageHandle[],
  options: ExpandLineageOptions
): Promise<LineageResolution> {
  const graph: Graph = {
    conversation: new Map(),
    domainEvent: new Map(),
    memory: new Map(),
    belief: new Map(),
    storyEvent: new Map(),
    measuredCount: 0,
  }
  const rejections: LineageRejection[] = []
  const reject = (reason: LineageRejection['reason'], at: string, detail: string): void => {
    if (rejections.some((r) => r.reason === reason && r.at === at)) return
    rejections.push({ reason, at, detail })
  }

  // -------------------------------------------------------------------------
  // 第 1 段：**有界**展开（节点上限在取数之前生效 ⇒ 不会为了超限图去读上千条）
  // -------------------------------------------------------------------------
  const visited = new Set<NodeKey>()
  let frontier: Child[] = handles.map((handle) => ({ kind: handle.kind, id: handle.id }))
  let nodeCount = 0
  let limitHit = false

  while (frontier.length > 0 && !limitHit) {
    const byKind: Record<LineageHandleKind, string[]> = {
      conversation_event: [],
      domain_event: [],
      memory: [],
      belief: [],
      story_event: [],
    }
    const pending: Child[] = []
    for (const node of frontier) {
      const key = keyOf(node.kind, node.id)
      if (visited.has(key)) continue
      if (nodeCount >= LINEAGE_MAX_NODES) {
        reject(
          'lineage_limit_exceeded',
          node.id,
          `展开节点超过上限 ${String(LINEAGE_MAX_NODES)}（ADR D30）—— **不截断假装根已齐全**`
        )
        limitHit = true
        break
      }
      visited.add(key)
      nodeCount += 1
      byKind[node.kind].push(node.id)
      pending.push(node)
    }
    if (limitHit) break

    for (const kind of Object.keys(byKind) as LineageHandleKind[]) {
      await fetchKind(lookup, graph, kind, byKind[kind])
    }

    const next: Child[] = []
    for (const node of pending) {
      const children = childrenOf(graph, node.kind, node.id)
      if (!children.ok) {
        /*
         * ⚠️ **S8 / ADR-093 `D14`**：故事节点取不到时**不**报 `node_missing`。
         * 两者的含义不同，而 `S8-A10` 要求"不存在提交"有它自己的具名码：
         * ```text
         * node_missing             某条边指向的节点在只读面里取不到（悬空引用）
         * story_root_unconfirmed   这条**故事引用**在账本里没有可验证的提交记录
         *                          （旧来源没有账本 ⇒ 拒收，禁止用快照/当前文本回填）
         * ```
         * 实测：第一版把它记成 `node_missing`，`S8-A10` 的"不存在 ≠ 其它原因"当场失败。
         */
        reject(
          children.problem === 'missing'
            ? node.kind === 'story_event'
              ? 'story_root_unconfirmed'
              : 'node_missing'
            : 'node_malformed',
          node.id,
          children.problem === 'missing'
            ? node.kind === 'story_event'
              ? `故事引用 ${node.id} 在账本里没有可验证的提交记录（ADR-093 D14：不回填）`
              : `${node.kind} ${node.id} 在只读面里取不到（悬空引用）—— 追不到来源不可用于采纳`
            : `${node.kind} ${node.id} 的边字段不是 id 数组（形状非法）`
        )
        continue
      }
      for (const child of children.children) next.push(child)
    }
    frontier = next
  }

  // -------------------------------------------------------------------------
  // 第 2 段：从 handle 出发收根（深度上限 + 环检测 + 去重）
  // -------------------------------------------------------------------------
  const roots = new Map<string, LineageRoot>()
  const derived = new Set<NodeKey>()
  const onPath = new Set<NodeKey>()

  /**
   * 记一个根（**按 `causalKey` 去重**；ADR-093 `D05`/`R-4`）。
   *
   * 合并规则（确定性）：
   * ```text
   * ① 一条是**故事根**、另一条不是 ⇒ 合成一个**两边都对**的根：
   *      · `id` / `depth` 取**对话侧**   ← M11 的只读面（reflection-source-read）要求
   *        根 id 必须能落在 `conversation_events` 里（它按根 id 反查 actor/序号/归因）
   *      · `sourceClass` 取**故事侧**    ← `S8-C02` 逐字："来源 kind 保持各自身份"，
   *        且 `story_experience` 是**更保守**的标签（永不支持外部事实）
   *    实测教训：第一版让整个根（含 id）都取故事侧 ⇒ 根 id 是提交身份、
   *    在 `conversation_events` 里查不到 ⇒ M11 的 `readReflectionSourceSnapshot`
   *    判 `usable:false`，故事→反思这一跳**整段不通**（`postlv2:s8:reflection:verify` 的 R4 抓到）。
   * ② 两条同类 ⇒ 保留 `depth` 更小的那条
   * ③ `sessionKey` 取任一侧的非空值：`user_choice` 故事根与它的 anchor 对话事件
   *    属于**同一个**会话，因此合并**不会**让会话数变多
   * ```
   */
  const addRoot = (candidate: LineageRoot): void => {
    const existing = roots.get(candidate.causalKey)
    if (existing === undefined) {
      roots.set(candidate.causalKey, candidate)
      return
    }
    const existingIsStory = existing.sourceClass === 'story_experience'
    const candidateIsStory = candidate.sourceClass === 'story_experience'
    const sessionKey = existing.sessionKey ?? candidate.sessionKey
    const withSession = (root: LineageRoot): LineageRoot =>
      sessionKey === undefined ? root : { ...root, sessionKey }

    if (existingIsStory !== candidateIsStory) {
      const conversationSide = existingIsStory ? candidate : existing
      const storySide = existingIsStory ? existing : candidate
      roots.set(
        candidate.causalKey,
        withSession({
          id: conversationSide.id,
          sourceClass: 'story_experience',
          depth: Math.min(conversationSide.depth, storySide.depth),
          causalKey: candidate.causalKey,
        })
      )
      return
    }
    if (candidate.depth < existing.depth) roots.set(candidate.causalKey, withSession(candidate))
    else roots.set(candidate.causalKey, withSession(existing))
  }

  const walk = (
    kind: LineageHandleKind,
    id: string,
    depth: number,
    hint?: LineageSourceClass
  ): void => {
    const key = keyOf(kind, id)
    if (onPath.has(key)) {
      reject('lineage_cycle', id, `派生链成环：${key} 出现在自己的祖先路径上（旧数据的环）`)
      return
    }
    if (depth > LINEAGE_MAX_DEPTH) {
      reject(
        'lineage_limit_exceeded',
        id,
        `深度超过上限 ${String(LINEAGE_MAX_DEPTH)}（ADR D30）—— **不截断假装根已齐全**`
      )
      return
    }
    const character = characterOf(graph, kind, id)
    if (!hasCharacterScope(graph, kind, id)) return // 第 1 段已记过 missing/malformed，不重复记
    if (character !== undefined && character !== options.characterId) {
      reject('node_foreign', id, `${key} 属于别的角色（${character}）—— 跨角色引用不可用于采纳`)
      return
    }

    if (kind === 'conversation_event') {
      const row = graph.conversation.get(id)
      const sourceClass =
        hint ?? (row === undefined ? 'internal_interpretation' : classOfConversation(row))
      addRoot({
        id,
        sourceClass,
        depth,
        causalKey: conversationCausalKey(id),
        ...(row?.conversationId !== undefined ? { sessionKey: row.conversationId } : {}),
      })
      return
    }

    /*
     * =======================================================================
     *  S8：故事提交作为**根**
     * =======================================================================
     * 五道闸（顺序即优先级，每道都有具名拒收码）：
     *   ① 与账本行的版本不一致        ⇒ story_root_version_mismatch（绝不静默换剧情）
     *   ② 认知使用资格已撤回          ⇒ story_root_withdrawn（**读时**判定，replay 不能绕过）
     *   ③ 该条目从来没可见过          ⇒ story_root_invisible
     *   ④ 不是真实用户交互            ⇒ story_root_not_interactive（system 提交）
     *   ⑤ user_choice 却缺 anchor      ⇒ story_root_unconfirmed（账本行损坏，失败关闭）
     * 通过之后：**记一个故事根**，并沿 anchor 继续走 ⇒ 得到同因果键的对话根，
     * 由 `addRoot` 合成**一个**根（`S8-C02`）。
     */
    if (kind === 'story_event') {
      const row = graph.storyEvent.get(id)
      if (row === undefined) return // 第 1 段已记为 missing
      if (row.versionMismatch) {
        reject('story_root_version_mismatch', id, `引用里的 storyVersion 与账本行不一致（${row.id}）`)
        return
      }
      if (row.withdrawn) {
        reject('story_root_withdrawn', id, `认知使用资格已撤回：${row.id}（读时判定，replay 不能绕过）`)
        return
      }
      if (!row.visible) {
        reject('story_root_invisible', id, `${row.id} 从来没进入过可见集合（未选分支 / 隐藏节点 / 作者设定）`)
        return
      }
      if (row.interactionKind !== 'user_choice') {
        reject(
          'story_root_not_interactive',
          id,
          `${row.id} 是 system 提交（开场 / 后台推进）：可作经历，但**不**为习惯制造合格反馈（D05/D06）`
        )
        return
      }
      const anchor = row.anchorConversationEventId
      if (anchor === undefined || anchor.trim() === '') {
        reject('story_root_unconfirmed', id, `${row.id} 声明 user_choice 却没有触发对话事件（账本行损坏）`)
        return
      }
      addRoot({
        id: row.id,
        sourceClass: 'story_experience',
        depth,
        causalKey: conversationCausalKey(anchor),
        ...(row.interactionRef !== undefined ? { sessionKey: row.interactionRef } : {}),
      })
      derived.add(key)
      walk('conversation_event', anchor, depth + 1, hint)
      return
    }

    derived.add(key)
    const children = childrenOf(graph, kind, id)
    const kids = children.ok ? children.children : []
    if (kids.length === 0) {
      reject(
        'root_unresolvable',
        id,
        `${key} 既没有对话来源、也没有父事件 ⇒ 追不到原始经历（不可用于采纳）`
      )
      return
    }
    onPath.add(key)
    for (const child of kids) walk(child.kind, child.id, depth + 1, hint)
    onPath.delete(key)
  }

  for (const handle of handles) {
    if (!visited.has(keyOf(handle.kind, handle.id))) {
      /*
       * ⚠️ **S8 / ADR-093 `D14`**：故事 handle 读不到时**不**报 `handle_unknown`。
       * 两者的含义不同，而 `S8-A10` 要求"不存在提交"有它自己的具名码：
       * ```text
       * handle_unknown          调用方给了一个**类型/形状上**不存在的 handle
       * story_root_unconfirmed   这条故事引用在账本里**没有可验证的提交记录**
       *                          （旧来源没有账本 ⇒ 拒收，**禁止**用快照/当前文本回填）
       * ```
       */
      reject(
        handle.kind === 'story_event' ? 'story_root_unconfirmed' : 'handle_unknown',
        handle.id,
        handle.kind === 'story_event'
          ? `故事引用 ${handle.id} 在账本里没有可验证的提交记录（ADR-093 D14：不回填）`
          : `handle ${handle.kind} ${handle.id} 不在只读面里`
      )
      continue
    }
    walk(handle.kind, handle.id, 0, handle.classHint)
  }

  // -------------------------------------------------------------------------
  // 汇总（确定性：按 causalKey 升序）
  // -------------------------------------------------------------------------
  const rootList = [...roots.values()].sort((a, b) =>
    a.causalKey < b.causalKey ? -1 : a.causalKey > b.causalKey ? 1 : 0
  )
  const classCounts = Object.fromEntries(
    LINEAGE_SOURCE_CLASSES.map((cls) => [cls, rootList.filter((r) => r.sourceClass === cls).length])
  ) as Record<LineageSourceClass, number>
  /*
   * 会话数按 `sessionKey` 去重（ADR-093 `D06`）：
   *   · 对话根 → 该对话事件的 `conversationId`（与 S8 之前逐字一致）
   *   · `user_choice` 故事根 → 服务端绑定的 `interactionRef`
   *   · `system` 故事根 → 无（且它已被拒收，进不了这里）
   * 两个 `runId` / 两次 replay / 两个节点都**不会**让这里 +1。
   */
  const sessionKeys = new Set<string>()
  for (const root of rootList) {
    if (root.sessionKey !== undefined) sessionKeys.add(root.sessionKey)
  }

  return {
    roots: rootList,
    rootCount: rootList.length,
    derivedNodeCount: derived.size,
    classCounts,
    conversationCount: sessionKeys.size,
    storyRootCount: rootList.filter((root) => root.sourceClass === 'story_experience').length,
    rejections: rejections.sort((a, b) =>
      a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : a.at < b.at ? -1 : a.at > b.at ? 1 : 0
    ),
    usable: rejections.length === 0 && rootList.length > 0,
    measuredCount: graph.measuredCount,
  }
}
