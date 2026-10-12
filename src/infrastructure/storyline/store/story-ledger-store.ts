/**
 * Storyline —— **世界提交账本的 SQL 适配**（基础设施层；后 Lv2 · S8 / WP2）。
 *
 * ============================================================================
 *  载体：ADR-093 `D01` · `D05`（`R-4`）· `D13` · `D15`
 *       验收契约 `S8-A01` / `S8-A02` / `S8-A03` / `S8-A11` / `S8-A31` / `S8-A32`
 * ============================================================================
 * 依赖方向：`infrastructure → kernel`（本文件实现 `StoryLedgerPort`），**绝不反向**。
 * Kernel 侧看不到任何 SQL（端口在 `src/kernel/storyline/story-ledger-port.ts`）。
 *
 * ---------------------------------------------------------------------------
 *  三条实现纪律
 * ---------------------------------------------------------------------------
 * ```text
 * ① **原子**：提交行与它的观测行在同一个事务里（`inTransaction`）—— 不许有半条世界记录
 * ② **幂等**：`on conflict ... do nothing` + 回读。命中任一条唯一约束 ⇒ `already_committed`，
 *    既有的观测集合**原样**返回（不从内存里编）
 * ③ **不编造**：读不到就返回 `undefined`。没有"回落到快照""回落到当前文本"这种路径
 *    —— 旧来源没有账本时按 `story_root_unconfirmed` 拒收（ADR-093 `D14`）
 * ```
 */

import { sql } from 'drizzle-orm'

import { KernelError, type Timestamp } from '../../../kernel/contracts/ids.ts'
import type {
  StoryLedgerPort,
  StoryCommitAppendInput,
  StoryCommitAppendResult,
} from '../../../kernel/storyline/story-ledger-port.ts'
import {
  assertStoryCommitIdReadback,
  storyObservationRecordsOf,
  type StoryCommitBinding,
  type StoryCommitRecord,
  type StoryObservationRecord,
} from '../../../kernel/storyline/story-ledger.ts'
import type {
  StoryEndingId,
  StorylineEventType,
  StoryStageId,
} from '../../../kernel/storyline/story-types.ts'
import type { StoryVariableValues } from '../../../kernel/storyline/world-machine.ts'
import { exec, firstRow, inTransaction, type RawDb } from '../../persistence/db.ts'

interface CommitRow {
  commit_id: string
  story_id: string
  story_version: number
  run_id: string
  revision: number
  event_id: string
  event_type: string
  choice_id: string | null
  from_node_id: string
  to_node_id: string
  stage: string
  variables_after: unknown
  new_visible_events: unknown
  ending: string | null
  ending_rule: string | null
  content_digest: string
  committed_at: string | number
  recorded_at: string | number
  interaction_kind: string
  interaction_ref: string | null
  anchor_conversation_event_id: string | null
  actor_kind: string
  actor_id: string | null
  idempotency_key: string
  schema_version: number
}

interface ObservationRow {
  observation_id: string
  parent_commit_id: string
  story_id: string
  story_version: number
  run_id: string
  event_id: string
  created_at: string | number
}

/**
 * jsonb 读回。
 *
 * ⚠️ PGlite 通常直接给出已解析的对象，但**不能假设**：不同驱动/版本对 jsonb 的读回
 * 形状不一致（AGENTS.md §7 的"数字对 ≠ 数字描述的是你以为的东西"）。
 * 这里两种都接住，且**坏形状当场抛错**（失败关闭），不静默变成 `{}` ——
 * 静默变 `{}` 会让"这次提交改了什么变量"变成一条假读数。
 */
function jsonOf(value: unknown, what: string, commitId: string): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      throw new KernelError(
        'persistence_error',
        'story_ledger_bad_json',
        `${what} 不是合法 JSON（commit=${commitId}）：拒绝把它当成空对象`
      )
    }
  }
  if (value === null || value === undefined) {
    throw new KernelError(
      'persistence_error',
      'story_ledger_missing_json',
      `${what} 为空（commit=${commitId}）：该列 NOT NULL，空值说明账本坏了`
    )
  }
  return value
}

function rowToCommit(row: CommitRow): StoryCommitRecord {
  // 读回自检：库里的 commit_id 必须能解析回规范形（S8-A01）
  assertStoryCommitIdReadback(String(row.commit_id))
  const interactionKind = String(row.interaction_kind)
  if (interactionKind !== 'user_choice' && interactionKind !== 'system') {
    throw new KernelError(
      'persistence_error',
      'story_ledger_bad_interaction_kind',
      `未知 interaction_kind：${interactionKind}（commit=${String(row.commit_id)}）`
    )
  }
  const binding: StoryCommitBinding = {
    interactionKind,
    ...(row.interaction_ref !== null ? { interactionRef: String(row.interaction_ref) } : {}),
    ...(row.anchor_conversation_event_id !== null
      ? { anchorConversationEventId: String(row.anchor_conversation_event_id) }
      : {}),
    actorKind: String(row.actor_kind) === 'user' ? 'user' : 'system',
    ...(row.actor_id !== null ? { actorId: String(row.actor_id) } : {}),
  }
  return {
    commitId: String(row.commit_id),
    storyId: String(row.story_id),
    storyVersion: Number(row.story_version),
    runId: String(row.run_id),
    revision: Number(row.revision),
    eventId: String(row.event_id),
    eventType: String(row.event_type) as StorylineEventType,
    ...(row.choice_id !== null ? { choiceId: String(row.choice_id) } : {}),
    fromNodeId: String(row.from_node_id),
    toNodeId: String(row.to_node_id),
    stage: String(row.stage) as StoryStageId,
    variablesAfter: jsonOf(row.variables_after, 'variables_after', String(row.commit_id)) as StoryVariableValues,
    newVisibleEvents: (jsonOf(
      row.new_visible_events,
      'new_visible_events',
      String(row.commit_id)
    ) as unknown[]).map((item) => String(item)),
    ...(row.ending !== null ? { ending: String(row.ending) as StoryEndingId } : {}),
    ...(row.ending_rule !== null ? { endingRule: String(row.ending_rule) } : {}),
    contentDigest: String(row.content_digest),
    committedAt: Number(row.committed_at),
    recordedAt: Number(row.recorded_at),
    binding,
    idempotencyKey: String(row.idempotency_key),
    schemaVersion: Number(row.schema_version),
  }
}

function rowToObservation(row: ObservationRow): StoryObservationRecord {
  return {
    observationId: String(row.observation_id),
    parentCommitId: String(row.parent_commit_id),
    storyId: String(row.story_id),
    storyVersion: Number(row.story_version),
    runId: String(row.run_id),
    eventId: String(row.event_id),
    createdAt: Number(row.created_at),
  }
}

const COMMIT_COLUMNS = `commit_id, story_id, story_version, run_id, revision, event_id, event_type,
  choice_id, from_node_id, to_node_id, stage, variables_after, new_visible_events, ending,
  ending_rule, content_digest, committed_at, recorded_at, interaction_kind, interaction_ref,
  anchor_conversation_event_id, actor_kind, actor_id, idempotency_key, schema_version`

async function insertCommit(db: RawDb, commit: StoryCommitRecord): Promise<number> {
  const inserted = await exec(
    db,
    sql`insert into storyline_commits (${sql.raw(COMMIT_COLUMNS)})
        values (${commit.commitId}, ${commit.storyId}, ${commit.storyVersion}, ${commit.runId},
                ${commit.revision}, ${commit.eventId}, ${commit.eventType},
                ${commit.choiceId ?? null}, ${commit.fromNodeId}, ${commit.toNodeId},
                ${commit.stage}, ${JSON.stringify(commit.variablesAfter)}::jsonb,
                ${JSON.stringify(commit.newVisibleEvents)}::jsonb,
                ${commit.ending ?? null}, ${commit.endingRule ?? null}, ${commit.contentDigest},
                ${commit.committedAt}, ${commit.recordedAt}, ${commit.binding.interactionKind},
                ${commit.binding.interactionRef ?? null},
                ${commit.binding.anchorConversationEventId ?? null},
                ${commit.binding.actorKind}, ${commit.binding.actorId ?? null},
                ${commit.idempotencyKey}, ${commit.schemaVersion})
        on conflict do nothing
        returning *`,
    `写入世界提交 ${commit.commitId}`
  )
  return inserted.length
}

/**
 * 写一条观测。
 *
 * ⚠️ **故意不写 `on conflict do nothing`**（第一版写了，是个真缺陷）：
 * 观测表上有 `(story_id, story_version, run_id, event_id)` 唯一约束与 `observation_id` 主键。
 * 若某次写入与**另一条提交**的观测撞上，`do nothing` 会**静默跳过**这一行 ——
 * 于是那条提交会以"N 个可见条目、N-1 条观测"的样子落盘（半条世界记录），
 * 而这正是 `S8-A03`/完整性探针要拦的形状。
 * 幂等**已经**由提交行的唯一约束处理（命中即整段返回 `already_committed`，根本走不到这里），
 * 所以这里的冲突只可能是**真实的账本损坏** ⇒ 让它抛错、让事务回滚。
 */
async function insertObservation(db: RawDb, observation: StoryObservationRecord): Promise<number> {
  const inserted = await exec(
    db,
    sql`insert into storyline_observations
          (observation_id, parent_commit_id, story_id, story_version, run_id, event_id, created_at)
        values (${observation.observationId}, ${observation.parentCommitId}, ${observation.storyId},
                ${observation.storyVersion}, ${observation.runId}, ${observation.eventId},
                ${observation.createdAt})
        returning observation_id`,
    `写入世界观测 ${observation.observationId}`
  )
  return inserted.length
}

async function readCommitRow(db: RawDb, commitId: string): Promise<StoryCommitRecord | undefined> {
  const rows = await exec(
    db,
    sql`select ${sql.raw(COMMIT_COLUMNS)} from storyline_commits where commit_id = ${commitId} limit 1`,
    `读取世界提交 ${commitId}`
  )
  const row = firstRow<CommitRow>(rows)
  return row === undefined ? undefined : rowToCommit(row)
}

async function readObservationsOfCommit(
  db: RawDb,
  commitId: string
): Promise<readonly StoryObservationRecord[]> {
  const rows = await exec(
    db,
    sql`select * from storyline_observations
         where parent_commit_id = ${commitId}
         order by observation_id asc`,
    `读取提交 ${commitId} 的观测`
  )
  return rows.map((row) => rowToObservation(row as unknown as ObservationRow))
}

/**
 * 创建账本适配器（`StoryLedgerPort` 的唯一 SQL 实现）。
 *
 * ⚠️ 调用方传进来的是 `getRawDb(holder)` 的结果（与其它仓储同一条入口），
 * 因此实验脚本**仍然**必须先 `isolateDatabase()` —— 三层防护不受影响。
 */
export function createStoryLedgerStore(db: RawDb): StoryLedgerPort {
  return {
    async appendCommit(input: StoryCommitAppendInput): Promise<StoryCommitAppendResult> {
      const { commit } = input
      /*
       * 观测行**由提交行派生**（而不是信任调用方传进来的那一份）：
       * 调用方给的 `observations` 只用于"数量与内容是否与派生结果一致"的自检，
       * 真正的落盘内容来自 `storyObservationRecordsOf(commit)`。
       * 这样"一个提交的多个观测必须指向同一个父提交"就是**构造上成立**（S8-A03）。
       */
      const derived = storyObservationRecordsOf(commit)
      if (input.observations.length !== derived.length) {
        throw new KernelError(
          'validation_error',
          'story_observations_not_derivable',
          `提交 ${commit.commitId} 的观测数与派生结果不一致：传入 ${input.observations.length} / 派生 ${derived.length}`
        )
      }
      const derivedIds = new Set(derived.map((item) => item.observationId))
      for (const item of input.observations) {
        if (!derivedIds.has(item.observationId)) {
          throw new KernelError(
            'validation_error',
            'story_observation_not_derivable',
            `观测 ${item.observationId} 不是提交 ${commit.commitId} 派生的：拒绝写入（失败关闭）`
          )
        }
      }

      return inTransaction(db, async (tx) => {
        const insertedCommit = await insertCommit(tx, commit)
        if (insertedCommit === 0) {
          // 幂等命中：既有行原样读回，观测集合也来自库里（不从内存编）
          const existing = await readCommitRow(tx, commit.commitId)
          if (existing === undefined) {
            /*
             * 冲突但读不回：可能是 `idempotencyKey` 撞了**另一条**提交
             * （同 revision 但不同 run 的情况已被唯一键挡住，这里是幂等键被复用）。
             * 这**不是**"已经提交过"，而是真实冲突 ⇒ 明确报错，不猜。
             */
            throw new KernelError(
              'persistence_error',
              'story_commit_conflict_but_unreadable',
              `世界提交写入冲突但按 commitId 读不回：commitId=${commit.commitId} · ` +
                `idempotencyKey=${commit.idempotencyKey}（幂等键可能被另一条提交复用）`
            )
          }
          const existingObservations = await readObservationsOfCommit(tx, existing.commitId)
          return {
            status: 'already_committed',
            commitId: existing.commitId,
            observationIds: existingObservations.map((item) => item.observationId),
            existing,
          }
        }

        for (const observation of derived) await insertObservation(tx, observation)

        return {
          status: 'appended',
          commitId: commit.commitId,
          observationIds: derived.map((item) => item.observationId),
        }
      })
    },

    readCommit: (commitId) => readCommitRow(db, commitId),

    async readCommitByIdempotencyKey(idempotencyKey): Promise<StoryCommitRecord | undefined> {
      const rows = await exec(
        db,
        sql`select ${sql.raw(COMMIT_COLUMNS)} from storyline_commits
             where idempotency_key = ${idempotencyKey} limit 1`,
        `按幂等键读取世界提交 ${idempotencyKey}`
      )
      const row = firstRow<CommitRow>(rows)
      return row === undefined ? undefined : rowToCommit(row)
    },

    async readObservation(observationId): Promise<StoryObservationRecord | undefined> {
      const rows = await exec(
        db,
        sql`select * from storyline_observations where observation_id = ${observationId} limit 1`,
        `读取世界观测 ${observationId}`
      )
      const row = firstRow<ObservationRow>(rows)
      return row === undefined ? undefined : rowToObservation(row)
    },

    async listCommits({ storyId, runId }): Promise<readonly StoryCommitRecord[]> {
      const rows = await exec(
        db,
        sql`select ${sql.raw(COMMIT_COLUMNS)} from storyline_commits
             where story_id = ${storyId} and run_id = ${runId}
             order by revision asc`,
        `列出 run ${runId} 的世界提交`
      )
      return rows.map((row) => rowToCommit(row as unknown as CommitRow))
    },

    async listRuns(storyId): Promise<readonly string[]> {
      const rows = await exec(
        db,
        sql`select distinct run_id from storyline_commits where story_id = ${storyId} order by run_id asc`,
        `列出故事 ${storyId} 的 run`
      )
      return rows.map((row) => String(row.run_id))
    },

    async latestRevision({ storyId, storyVersion, runId }): Promise<number> {
      const rows = await exec(
        db,
        sql`select coalesce(max(revision), 0) as latest from storyline_commits
             where story_id = ${storyId} and story_version = ${storyVersion} and run_id = ${runId}`,
        `读取 run ${runId} 的最高 revision`
      )
      return Number(rows[0]?.latest ?? 0)
    },
  }
}

/**
 * **结构完整性探针**（只读；与"语义资格"分工，先例 `memory-integrity.ts`）。
 *
 * 它回答的是"账本结构坏没坏"，**不**回答"这条来源够不够格"：
 * ```text
 * ① 悬挂观测   ：观测指向一条不存在的提交
 * ② 观测缺口   ：提交声称新引入了 N 个条目，库里却只有 M 条（M < N）
 * ③ revision 缺口：run 内 revision 不连续
 * ```
 * ⚠️ **它不修任何东西**：发现问题就如实报出来（`INCIDENT HOLD` 的姿态，先例 `INV-DB-07`）。
 */
export interface StoryLedgerIntegrityReport {
  orphanObservations: string[]
  observationsMissing: { commitId: string; expected: number; found: number }[]
  revisionGaps: { storyId: string; runId: string; missing: number[] }[]
  scannedCommits: number
  scannedObservations: number
}

export async function storyLedgerIntegrityProblems(db: RawDb): Promise<StoryLedgerIntegrityReport> {
  const commits = await exec(
    db,
    sql`select ${sql.raw(COMMIT_COLUMNS)} from storyline_commits order by story_id asc, run_id asc, revision asc`,
    '完整性探针：读取全部世界提交'
  )
  const observations = await exec(db, sql`select * from storyline_observations`, '完整性探针：读取全部观测')

  const commitIds = new Set(commits.map((row) => String(row.commit_id)))
  const orphanObservations = observations
    .filter((row) => !commitIds.has(String(row.parent_commit_id)))
    .map((row) => String(row.observation_id))

  const countByParent = new Map<string, number>()
  for (const row of observations) {
    const key = String(row.parent_commit_id)
    countByParent.set(key, (countByParent.get(key) ?? 0) + 1)
  }

  const observationsMissing: StoryLedgerIntegrityReport['observationsMissing'] = []
  for (const row of commits) {
    const record = rowToCommit(row as unknown as CommitRow)
    const expected = record.newVisibleEvents.length
    const found = countByParent.get(record.commitId) ?? 0
    if (found < expected) observationsMissing.push({ commitId: record.commitId, expected, found })
  }

  const byRun = new Map<string, number[]>()
  for (const row of commits) {
    const key = `${String(row.story_id)}\u0000${String(row.run_id)}`
    const list = byRun.get(key) ?? []
    list.push(Number(row.revision))
    byRun.set(key, list)
  }
  const revisionGaps: StoryLedgerIntegrityReport['revisionGaps'] = []
  for (const [key, revisions] of byRun) {
    const [storyId, runId] = key.split('\u0000')
    const missing: number[] = []
    let expected = 1
    for (const revision of revisions.sort((a, b) => a - b)) {
      for (let value = expected; value < revision; value += 1) missing.push(value)
      expected = revision + 1
    }
    if (missing.length > 0) revisionGaps.push({ storyId: storyId!, runId: runId!, missing })
  }

  return {
    orphanObservations,
    observationsMissing,
    revisionGaps,
    scannedCommits: commits.length,
    scannedObservations: observations.length,
  }
}

/** 供门使用的只读常量（避免门自己拼表名） */
export const STORY_LEDGER_TABLES = ['storyline_commits', 'storyline_observations'] as const

/** 时间戳便捷函数（与 `db.ts` 的 `nowTs` 同义；本文件不引入时钟副作用） */
export type StoryLedgerTimestamp = Timestamp
