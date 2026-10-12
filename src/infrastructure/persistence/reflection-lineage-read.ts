/**
 * M11 WP2 —— `LineageLookup` 的**只读适配**（ADR-085 `D25`）。
 *
 * ============================================================================
 *  这一层为什么单独一个文件
 * ============================================================================
 * 根解析的**逻辑**（去重、环检测、超限、五类标签）全部在
 * [`kernel/app/reflection/lineage.ts`](../../kernel/app/reflection/lineage.ts) —— 那里是纯的。
 * SQL **只**出现在这里，且**只读**：没有 insert / update / delete / 事务。
 * 形状照既有的薄适配层（先例：`withdrawn-evidence.ts` 把纯语义与 SQL 分开）。
 *
 * ============================================================================
 *  批量读的确切形状（不是 N+1）
 * ============================================================================
 * ```text
 * · 对话事件 / 领域事件 / 记忆证据：一条 `where … in (<ids>)` 查询拿一批
 *   （字符串字面量的转义沿用 `qualification-read.ts:99-126` 的既有做法）。
 * · 信念：`listBeliefRows(db, characterId)` **按角色作用域**读出后在内存里按 id 过滤 ——
 *   与 `listActiveBeliefs` / `listBeliefsByStatus` 同一形状。
 *   ⚠️ 这是一条**已知代价**（族读取随投影行数线性增长），
 *      登记在 M11 的 Known-Limitations 候选里，不在本文件里偷偷优化。
 * ```
 *
 * ⚠️ **本适配器不判资格**：它只回答"这个节点的来源长什么样"。
 *    被遗忘 / 被撤回 / 不可用由调用方按各域的既有资格链判断（`D13`：不绕过领域归属）。
 */

import type { CharacterId } from '../../kernel/contracts/ids.ts'
import type {
  LineageBeliefReading,
  LineageConversationReading,
  LineageDomainEventReading,
  LineageLookup,
  LineageMemoryReading,
  LineageStoryEventReading,
} from '../../kernel/contracts/reflection-lineage.ts'
import { parseStorySourceId } from '../../kernel/contracts/source-authority.ts'
import {
  STORY_EXPERIENCE_RETRACTED,
  withdrawnStoryCommitIdsOf,
} from '../../kernel/contracts/story-events.ts'
import { listBeliefRows } from './belief-store.ts'
import { exec, type RawDb } from './db.ts'
import { sql } from 'drizzle-orm'

/** 把一批 id 渲染成 SQL 字面量列表（**只**用于我们已经从库里读出来的 id，仍是转义过的）。 */
function literalList(ids: readonly string[]): string {
  return ids.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(', ')
}

/** 只取 id 数组的列（`jsonb` 列可能是 NULL ⇒ 读成空数组）。 */
function idArrayOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '') out.push(item)
  }
  return out
}

/**
 * **S8 / ADR-093 `D03`**：从内部事件 payload 里取出 `sourceStoryRefs[].sourceId`。
 *
 * ⚠️ 读的是 payload（**没有**独立列）—— 因为 `character_domain_events` 的列是
 * append-only 的既有形状，S8 **不**改它（只追加能力，不加列）。
 * 形状不认识（不是数组 / 元素没有 sourceId）⇒ 返回空数组：**不猜**。
 * 真正的"引用坏了"由根解析侧按 `story_root_unconfirmed` 拒收。
 */
function storyRefsOfPayload(payload: unknown): string[] {
  const container = payload as { sourceStoryRefs?: unknown } | null | undefined
  const refs = container?.sourceStoryRefs
  if (!Array.isArray(refs)) return []
  const out: string[] = []
  for (const item of refs) {
    const sourceId = (item as { sourceId?: unknown } | null | undefined)?.sourceId
    if (typeof sourceId === 'string' && sourceId.trim() !== '') out.push(sourceId)
  }
  return out
}

export interface ReflectionLineageLookupOptions {
  readonly characterId: CharacterId
}

/**
 * **S8 / ADR-093 `D12`**：该角色**已撤回认知使用资格**的故事提交身份集合。
 *
 * ```text
 * 读   character_domain_events（type = STORY_EXPERIENCE_RETRACTED，按 character 作用域）
 * 不读 storyline_*（撤回**不**改世界账本）
 * 不写 任何表
 * ```
 *
 * ⚠️ 形状坏掉的行**抛错**（`withdrawnStoryCommitIdsOf` 里），不静默跳过 ——
 * 静默跳过的后果是"用户撤回了，但她还在用"。
 */
async function withdrawnStoryCommitIds(
  db: RawDb,
  characterId: CharacterId
): Promise<ReadonlySet<string>> {
  const rows = await exec(
    db,
    sql`select payload from character_domain_events
         where character_id = ${String(characterId)} and type = ${STORY_EXPERIENCE_RETRACTED}`,
    'S8：读取故事体验撤回事件（只读）'
  )
  return withdrawnStoryCommitIdsOf(rows.map((row) => row.payload))
}

/**
 * **S8 / ADR-093 `D12`**：被撤回的故事经历所对应的**触发对话事件 id** 集合。
 *
 * ⚠️ 为什么需要这一跳（`postlv2:s8:lifecycle:verify` 的 L3/L4 实测发现）：
 * 采纳之后，槽位里存的**根**是**对话事件 id**（`R-10`：合并时 id 取对话侧）。
 * 于是消费端重算资格时只看那些对话事件 —— 它们本身**完全健康**，
 * 撤回挂在**故事提交**上，消费端**看不见** ⇒ "撤回了却还在用"。
 *
 * 这一跳把撤回传播到消费端能看见的那把键上：
 * ```text
 * 撤回集合（提交身份） → storyline_commits.anchor_conversation_event_id → 对话事件 id 集合
 * ```
 * 于是根解析与消费端资格**用同一份事实**判"这段经历还能不能用"。
 */
export async function withdrawnStoryAnchorIds(
  db: RawDb,
  characterId: CharacterId
): Promise<ReadonlySet<string>> {
  const commitIds = [...(await withdrawnStoryCommitIds(db, characterId))]
  if (commitIds.length === 0) return new Set<string>()
  const rows = await exec(
    db,
    sql.raw(
      `select anchor_conversation_event_id from storyline_commits
        where commit_id in (${literalList(commitIds)}) and anchor_conversation_event_id is not null`
    ),
    'S8：把撤回的故事提交映射到它的触发对话事件（只读）'
  )
  return new Set(rows.map((row) => String(row.anchor_conversation_event_id)))
}

/**
 * 构造只读口。
 *
 * @param db 原始库句柄（读适配**不**持有它以外的任何状态）
 */
export function createReflectionLineageLookup(
  db: RawDb,
  options: ReflectionLineageLookupOptions
): LineageLookup {
  const characterId = String(options.characterId)

  return {
    async findConversationEvents(ids): Promise<LineageConversationReading[]> {
      if (ids.length === 0) return []
      const rows = await exec(
        db,
        sql.raw(
          `select id, character_id, conversation_id, actor_type
             from conversation_events
            where id in (${literalList(ids)})`
        ),
        'M11 派生链：读对话事件（只读）'
      )
      return rows.map((row) => ({
        id: String(row.id),
        characterId: String(row.character_id),
        conversationId: String(row.conversation_id),
        actorType: String(row.actor_type),
      }))
    },

    async findDomainEvents(ids): Promise<LineageDomainEventReading[]> {
      if (ids.length === 0) return []
      const rows = await exec(
        db,
        sql.raw(
          `select id, character_id, caused_by_domain_event_ids, source_conversation_event_ids, payload
             from character_domain_events
            where id in (${literalList(ids)})`
        ),
        'M11 派生链：读领域事件（只读）'
      )
      return rows.map((row) => ({
        id: String(row.id),
        characterId: String(row.character_id),
        // ⚠️ NULL = "这一列在 M11 之前从未被写过"的旧形状 ⇒ 读成"没有父"，
        //    而**不是** `node_malformed`：两者在库里长得不同
        //    （`null` vs 非数组），`idArrayOf` 对 `null` 返回空数组。
        causedByDomainEventIds: idArrayOf(row.caused_by_domain_event_ids),
        sourceConversationEventIds: idArrayOf(row.source_conversation_event_ids),
        sourceStoryEventIds: storyRefsOfPayload(row.payload),
      }))
    },

    async findMemories(ids): Promise<LineageMemoryReading[]> {
      if (ids.length === 0) return []
      const list = literalList(ids)
      // 归属：只有 `owner_kind = 'character'` 的记忆才填 characterId
      //（user 归属的记忆不是"别的角色"，而是**另一种归属规则** —— 不触发 node_foreign）。
      const owners = await exec(
        db,
        sql.raw(
          `select id, owner_kind, owner_id from memory_records where id in (${list})`
        ),
        'M11 派生链：读记忆归属（只读）'
      )
      const ownerById = new Map<string, string | undefined>()
      for (const row of owners) {
        ownerById.set(
          String(row.id),
          String(row.owner_kind) === 'character' ? String(row.owner_id) : undefined
        )
      }
      const links = await exec(
        db,
        sql.raw(
          `select memory_id, evidence_kind, evidence_id
             from memory_evidence_links
            where memory_id in (${list})
              and is_root
              and evidence_kind in ('conversation_event', 'story_event')`
        ),
        'M11 派生链：读记忆的根证据（只读）'
      )
      const byMemory = new Map<string, string[]>()
      /*
       * ⚠️ **S8**：故事证据单独一列（来源类不同，见 `LineageMemoryReading` 的说明）。
       * `evidence_kind` 是自由 text（没有 check 约束），因此这里**显式**分流，
       * 不靠"看起来像不像故事 id"来猜 —— 猜错就是把用户陈述读成她自己的经历。
       */
      const storyByMemory = new Map<string, string[]>()
      for (const row of links) {
        const key = String(row.memory_id)
        const kind = String(row.evidence_kind)
        const bucket = kind === 'story_event' ? storyByMemory : byMemory
        const list0 = bucket.get(key) ?? []
        list0.push(String(row.evidence_id))
        bucket.set(key, list0)
      }
      const out: LineageMemoryReading[] = []
      for (const id of ids) {
        if (!ownerById.has(id)) continue // 库里没有这条记忆 ⇒ 不进读数（调用方判 missing）
        out.push({
          id,
          ...(ownerById.get(id) === undefined ? {} : { characterId: ownerById.get(id) }),
          evidenceConversationEventIds: byMemory.get(id) ?? [],
          evidenceStoryEventIds: storyByMemory.get(id) ?? [],
        })
      }
      return out
    },

    async findBeliefs(ids): Promise<LineageBeliefReading[]> {
      if (ids.length === 0) return []
      const wanted = new Set(ids.map(String))
      // 按角色作用域读（与 listActiveBeliefs / listBeliefsByStatus 同一形状）
      const rows = await listBeliefRows(db, options.characterId)
      const out: LineageBeliefReading[] = []
      for (const row of rows) {
        const type = String(row.projectionType)
        if (type.startsWith('belief:evidence:')) continue
        const state = row.state as
          | { beliefId?: unknown; evidenceRootIds?: unknown; dependsOnMemoryIds?: unknown }
          | undefined
        if (state === undefined) continue
        const id = String(state.beliefId ?? '')
        if (id === '' || !wanted.has(id)) continue
        out.push({
          id,
          // 行本身已按 `characterId` 作用域读出 ⇒ 不需要再带归属字段
          evidenceRootIds: idArrayOf(state.evidenceRootIds),
          dependsOnMemoryIds: idArrayOf(state.dependsOnMemoryIds),
        })
      }
      void characterId
      return out
    },

    /**
     * **S8 追加**（ADR-093 `D04`）：按引用 id 取故事账本读数。
     *
     * ```text
     * 入参 id 可能是两种形状：
     *   · 观测 id   story:<storyId>@v<ver>#<runId>.<eventId>   → 经 storyline_observations 找父提交
     *   · 提交 id   story:<storyId>@v<ver>#<runId>.e<revision> → 直接命中 storyline_commits
     * 两者都解析到**同一条提交**，读数以 `requestedId` 为键返回（S8-A02）。
     * ```
     *
     * ⚠️ **不猜**：查不到就是查不到（调用方按 `story_root_unconfirmed` 拒收，
     *    ADR-093 `D14`：旧来源不回填）。
     * ⚠️ **只读**：两条 `select`，没有写、没有事务。
     * ⚠️ `withdrawn` 现在**恒为 false** —— 读时撤回属 WP6（ADR-093 `D12`），
     *    这一事实由 `postlv2:s8:roots:verify` 的读数如实记下，不在这里假装已实现。
     */
    async findStoryEvents(ids): Promise<LineageStoryEventReading[]> {
      if (ids.length === 0) return []
      /*
       * **S8 / ADR-093 `D12`**：撤回是**读时**判定 —— 每次取数都先算撤回集合。
       * 这样 replay / rebuild / 换进程都绕不过去（删行做不到这一点：事件流还在，
       * 重建会把它们复活）。撤回集合按**角色作用域**读（本 lookup 只服务一个角色）。
       */
      const withdrawnCommitIds = await withdrawnStoryCommitIds(db, options.characterId)
      const wanted = ids.map(String)
      const list = literalList(wanted)
      const commitColumns = `commit_id, story_id, story_version, run_id, revision,
        interaction_kind, interaction_ref, anchor_conversation_event_id, new_visible_events`

      const direct = await exec(
        db,
        sql.raw(`select ${commitColumns} from storyline_commits where commit_id in (${list})`),
        'S8 派生链：按提交身份读故事账本（只读）'
      )
      const observations = await exec(
        db,
        sql.raw(
          `select observation_id, parent_commit_id
             from storyline_observations
            where observation_id in (${list})`
        ),
        'S8 派生链：按观测 id 读故事账本（只读）'
      )
      const parentIds = [...new Set(observations.map((row) => String(row.parent_commit_id)))]
      const parents =
        parentIds.length === 0
          ? []
          : await exec(
              db,
              sql.raw(
                `select ${commitColumns} from storyline_commits
                  where commit_id in (${literalList(parentIds)})`
              ),
              'S8 派生链：读观测的父提交（只读）'
            )

      const commitById = new Map<string, Record<string, unknown>>()
      for (const row of [...direct, ...parents]) commitById.set(String(row.commit_id), row)

      const readingOf = (
        requestedId: string,
        commitId: string,
        row: Record<string, unknown>,
        versionMismatch: boolean
      ): LineageStoryEventReading => {
        /*
         * `visible` = 这一次提交**真的引入了可见条目**。
         * 账本只为"变得可见"的条目落行 ⇒ 没有可见条目的提交（例如 `RUN_EXITED`）
         * 不能当作经历根 —— 这是 `story_root_invisible` **可达**的那一支。
         */
        const visibleEvents = Array.isArray(row.new_visible_events)
          ? (row.new_visible_events as unknown[])
          : typeof row.new_visible_events === 'string'
            ? (JSON.parse(String(row.new_visible_events)) as unknown[])
            : []
        const parsed = parseStorySourceId(requestedId)
        const interactionKind = String(row.interaction_kind) === 'user_choice' ? 'user_choice' : 'system'
        return {
          id: commitId,
          requestedId,
          storyId: String(row.story_id),
          storyVersion: Number(row.story_version),
          runId: String(row.run_id),
          revision: Number(row.revision),
          interactionKind,
          ...(row.anchor_conversation_event_id === null
            ? {}
            : { anchorConversationEventId: String(row.anchor_conversation_event_id) }),
          ...(row.interaction_ref === null ? {} : { interactionRef: String(row.interaction_ref) }),
          visible: visibleEvents.length > 0,
          withdrawn: withdrawnCommitIds.has(commitId),
          versionMismatch:
            versionMismatch ||
            (parsed !== undefined && parsed.storyVersion !== Number(row.story_version)),
        }
      }

      const out: LineageStoryEventReading[] = []
      for (const id of wanted) {
        const directRow = commitById.get(id)
        if (directRow !== undefined && String(directRow.commit_id) === id) {
          out.push(readingOf(id, id, directRow, false))
          continue
        }
        const observation = observations.find((row) => String(row.observation_id) === id)
        if (observation === undefined) continue
        const parentId = String(observation.parent_commit_id)
        const parentRow = commitById.get(parentId)
        if (parentRow === undefined) continue
        out.push(readingOf(id, parentId, parentRow, false))
      }

      /*
       * -----------------------------------------------------------------------
       *  S8-A10 的第二跳：**同一事件在不同 storyVersion 下存在** ⇒ 具名区分
       * -----------------------------------------------------------------------
       * ⚠️ 为什么必须有这一跳：引用的 id 里编着 `storyVersion`，所以"版本错了"的引用
       * 与"根本不存在的引用"在**按 id 直查**时都查不到 —— 两者会塌成同一个拒收码，
       * 而 `S8-A10` 明确要求"错版本 / 跨 run / 不存在"**分别**得到具名拒收且不互相混同。
       *
       * 做法：对没直查到的引用，按 `(storyId, runId, eventId)`（**去掉版本**）再查一次。
       * 命中 ⇒ 那条事件确实在账本里，只是版本不同 ⇒ `versionMismatch = true`
       * ⇒ 根解析报 `story_root_version_mismatch`（而不是 `story_root_unconfirmed`）。
       */
      const unresolved = wanted
        .filter((id) => !out.some((item) => item.requestedId === id))
        .map((id) => ({ id, parts: parseStorySourceId(id) }))
        .filter((item): item is { id: string; parts: NonNullable<ReturnType<typeof parseStorySourceId>> } =>
          item.parts !== undefined
        )
      if (unresolved.length > 0) {
        const tuples = unresolved
          .map((item) => `('${item.parts.storyId}', '${item.parts.runId}', '${item.parts.eventId}')`)
          .join(', ')
        const changedObservations = await exec(
          db,
          sql.raw(
            `select observation_id, parent_commit_id, story_version
               from storyline_observations
              where (story_id, run_id, event_id) in (${tuples})`
          ),
          'S8 派生链：按（无版本）事件身份复查观测（只读）'
        )
        const changedCommits = await exec(
          db,
          sql.raw(
            `select ${commitColumns} from storyline_commits
              where (story_id, run_id, event_id) in (${tuples})`
          ),
          'S8 派生链：按（无版本）事件身份复查提交（只读）'
        )
        const needParents = [
          ...new Set(changedObservations.map((row) => String(row.parent_commit_id))),
        ].filter((commitId) => !commitById.has(commitId))
        const extraParents =
          needParents.length === 0
            ? []
            : await exec(
                db,
                sql.raw(
                  `select ${commitColumns} from storyline_commits
                    where commit_id in (${literalList(needParents)})`
                ),
                'S8 派生链：读复查观测的父提交（只读）'
              )
        for (const row of extraParents) commitById.set(String(row.commit_id), row)

        for (const item of unresolved) {
          const observationRow = changedObservations.find(
            (row) =>
              String(row.observation_id).endsWith(`.${item.parts.eventId}`) &&
              String(row.observation_id) === item.id.replace(/@v\d+/, `@v${String(row.story_version)}`)
          )
          if (observationRow !== undefined) {
            const parentRow = commitById.get(String(observationRow.parent_commit_id))
            if (parentRow !== undefined) out.push(readingOf(item.id, String(parentRow.commit_id), parentRow, true))
            continue
          }
          const commitRow = changedCommits.find(
            (row) => String(row.commit_id) === item.id.replace(/@v\d+/, `@v${String(row.story_version)}`)
          )
          if (commitRow !== undefined) {
            out.push(readingOf(item.id, String(commitRow.commit_id), commitRow, true))
          }
        }
      }
      return out
    },
  }
}
