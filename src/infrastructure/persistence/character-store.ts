/**
 * CharacterDefinition（Seed Identity）的仓储。
 *
 * ============================================================================
 *  计划书第 19 / 77 / 124 节：Seed 的写入只能走显式管理路径
 * ============================================================================
 * 本文件的写路径**只有两个函数**，而且都不接受来自模型的输入：
 *
 *   `upsertCharacterDefinition` —— 由 Seed 装载流程（启动投影）调用
 *   `character_definition_versions` 的写入是它的副产物（自动保留历史）
 *
 * 领域层根本没有拿到这个仓储的入口 —— 这从**类型层面**堵住了
 * "某个 Processor 顺手改了人设"的可能。
 *
 * ---------------------------------------------------------------------------
 *  M3 的三道写闸（全部失败关闭）
 * ---------------------------------------------------------------------------
 *   1. 版本回退        → 拒绝（`seed_version_regression`）
 *   2. 内容变了不升版本 → 拒绝（`seed_changed_without_version_bump`）
 *   3. **hash 与内容不一致** → 拒绝（`seed_hash_mismatch`）
 *
 * 第 3 条是 M3 新加的，也是最容易被忽略的一条：前两条只能防"经过代码的写入"，
 * 而 hash 校验让**库被直接改过**这件事在下次启动时被发现
 * （计划书第 76 节："配置文件被偷偷修改但版本没更新，可以检测出来"）。
 */

import { sql } from 'drizzle-orm'

import {
  CHARACTER_DEFINITION_SCHEMA_VERSION,
  KernelError,
  canonicalizeSeed,
  seedSourceRef,
  type CharacterDefinition,
  type CharacterId,
  type SeedVersionRecord,
  asCharacterId,
} from '../../kernel/contracts/index.ts'
import { exec, firstRow, type RawDb } from './db.ts'
import { hashSeed, shortHash } from './seed-hash.ts'

interface DefinitionRow {
  id: string
  slug: string
  name: string
  seed_version: number
  identity: string
  personality_baseline: string
  communication_style: string
  seed_extras: unknown
  schema_version: number
  created_at: number
  updated_at: number
  definition_json?: unknown
  seed_hash?: string | null
  definition_schema_version?: number | null
}

/**
 * 行 → 领域定义。
 *
 * ⚠️ 刻意**不做**"从旧列反推新结构"的兜底还原：
 * 那样会造出一份"看起来像 v2、实际是从散文猜的"Seed，
 * 而它还会带上一个看似合法的 hash —— 这是最坏的结果
 * （数据看起来对，实际上是编的）。
 *
 * 因此 `definition_json` 缺失时直接报错，并指明该跑哪一个迁移/装载流程。
 */
function rowToDefinition(row: DefinitionRow | undefined): CharacterDefinition | undefined {
  if (!row) return undefined
  if (row.definition_json === null || row.definition_json === undefined) {
    throw new KernelError(
      'persistence_error',
      'seed_definition_json_missing',
      `Seed ${String(row.id)} 缺少 definition_json（迁移 0003 之后的 Seed 必须有）。` +
        '请运行一次启动装载（它会用代码里的 Seed 补写结构化表示），' +
        '而不是让系统凭旧的自由文本反推一份"看起来像新结构"的 Seed。'
    )
  }
  const raw = row.definition_json as Record<string, unknown>
  return {
    ...(raw as unknown as CharacterDefinition),
    id: asCharacterId(String(row.id)),
    // 版本以**列**为准：列是持久层的事实，jsonb 里的可能是渲染物
    seedVersion: Number(row.seed_version),
    schemaVersion: Number(row.definition_schema_version ?? raw.schemaVersion ?? 1),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

export async function getCharacterDefinition(
  db: RawDb,
  characterId: CharacterId
): Promise<CharacterDefinition | undefined> {
  const rows = await exec(
    db,
    sql`select * from character_definitions where id = ${characterId} limit 1`,
    '读取 CharacterDefinition'
  )
  return rowToDefinition(firstRow<DefinitionRow>(rows))
}

/** 库里存的 Seed hash（未记录时 undefined） */
export async function getStoredSeedHash(
  db: RawDb,
  characterId: CharacterId
): Promise<string | undefined> {
  const rows = await exec(
    db,
    sql`select seed_hash from character_definitions where id = ${characterId} limit 1`,
    '读取 Seed hash'
  )
  const value = firstRow<{ seed_hash: string | null }>(rows)?.seed_hash
  return value ?? undefined
}

/**
 * 这一行的 `definition_json` 是否还空着（= 迁移 0003 之前的旧行）。
 *
 * ============================================================================
 *  这个函数是为了修一个**会让生产启动失败**的缺陷
 * ============================================================================
 * 迁移 0003 给 `character_definitions` 加了 `definition_json` 列，但
 * **已经存在的那一行不会因此拥有它** —— 它仍是 `null`。
 *
 * 而 `rowToDefinition` 刻意拒绝"凭旧的自由文本反推一份看起来像新结构的 Seed"，
 * 于是：**真实库一升级到迁移 3，任何命令都会在启动时抛
 * `seed_definition_json_missing`**。实测就是这样（干跑 `--test` 复现）。
 *
 * 为什么全部测试都没抓到它：**每个夹具都是全新库**（先跑迁移、再建档），
 * 因此"迁移一个**已有** Seed 的库"这条路径**从来没有被测过**。
 * 这是迁移类改动最典型的盲区 —— 测的是"新建"，坏的是"升级"。
 *
 * 修法：把"旧行需要装载"变成一个**可查询的事实**，然后由装配层
 * 用代码里的 Seed 补写（`upsert` 的写入闸允许同版本覆盖空结构，
 * 见下面 `definition_json is null` 的那条分支）。
 */
export async function needsDefinitionBackfill(
  db: RawDb,
  characterId: CharacterId
): Promise<boolean> {
  const rows = await exec(
    db,
    sql`select definition_json is null as missing from character_definitions
        where id = ${characterId} limit 1`,
    '检查 Seed 是否需要装载结构化表示'
  )
  const row = firstRow<{ missing: boolean }>(rows)
  // 行不存在（全新角色）也返回 false —— 那种情况走正常的首次建档
  return row?.missing === true
}

export interface UpsertSeedOptions {
  now?: number
  /**
   * 明确声明"我知道自己在覆盖一份被改坏/不一致的 Seed"。
   *
   * 两个合法的取值，各自对应一种真实处境：
   *
   *   `'legacy-backfill'` —— 第一次把旧库升级到结构化 Seed。
   *       旧行没有 `seed_hash`，因此谈不上"不一致"，只是缺指纹。
   *
   *   `'repair'` —— 库里的内容与记录的指纹**已经不一致**
   *       （有人绕过了写入闸）。这种情况下第 2 道闸"内容变了不升版本"
   *       也一定成立，因此必须显式说明意图，否则会陷入
   *       "既不能读也不能写"的死锁。
   *       用它意味着：把库内容**覆盖回**代码里的那份。
   *
   * 刻意做成字符串而不是 boolean：调用点必须写出**为什么**，
   * 而 `skipHashCheck: true` 读起来像是"顺手关掉一个检查"。
   */
  acknowledge?: false | 'legacy-backfill' | 'repair'
}

export interface UpsertSeedResult {
  created: boolean
  definition: CharacterDefinition
  /** 本次写入后的指纹 */
  seedHash: string
  /** 是否真的产生了新版本行（内容有变化） */
  versioned: boolean
}

/**
 * 写入 / 更新 Seed。
 *
 * 语义（与 M2.5 一致，M3 补第 3 道闸）：
 *   · 已存在时**不覆盖** created_at（她的"出生时间"不变）
 *   · seedVersion 由调用方决定（代码里的常量）；低于库里 → 直接报错
 *   · 同版本 + 不同内容 → 直接报错（"她怎么悄悄变了"）
 *   · 真正的写入一定同时更新 version / updated_at / hash（计划书第 77 节）
 *   · 每次写入都在 `character_definition_versions` 留一份快照
 */
export async function upsertCharacterDefinition(
  db: RawDb,
  definition: CharacterDefinition,
  options: UpsertSeedOptions = {}
): Promise<UpsertSeedResult> {
  const now = options.now ?? Date.now()

  /*
   * ⚠️ 迁移 0003 之后的**旧行**：它可能是"有行、但没有结构化表示"。
   *
   * 必须先判这一件事，再决定怎么读 —— 因为 `getCharacterDefinition`
   * 对这样的行会**抛错**（它刻意拒绝凭旧自由文本反推一份 Seed）。
   * 直接调它会让"升级一个已有库"变成启动失败（实测踩到过）。
   */
  const legacyRow = await needsDefinitionBackfill(db, definition.id)
  const existing = legacyRow ? undefined : await getCharacterDefinition(db, definition.id)

  const incomingHash = hashSeed(definition)
  const storedHash = existing ? await getStoredSeedHash(db, definition.id) : undefined

  /*
   * 旧行的分支：结构缺失时**允许同版本覆盖**。
   *
   * 为什么这不是"绕过升版本规矩"：`seedVersion` 描述的是**人设内容**，
   * 而这个旧行的版本号本来就没变（v1 就是 v1）。缺的是**结构**，
   * 不是内容 —— 因此这不是一次"她变了"，而是一次"装载"。
   *
   * 装载用的定义来自**代码**（`characterDefinitionFromCharacter`），
   * 不是从旧自由文本反推的，所以不存在"编一个人设"的风险。
   */
  if (legacyRow) {
    return await writeSeedRow(db, definition, {
      existing: undefined,
      incomingHash,
      now,
      backfill: true,
    })
  }

  if (existing && definition.seedVersion < existing.seedVersion) {
    throw new KernelError(
      'validation_error',
      'seed_version_regression',
      `Seed 版本不允许回退：库里是 v${existing.seedVersion}，代码里是 v${definition.seedVersion}`
    )
  }

  // --- 第三道闸：库里的 hash 与库里的内容是否自洽 -------------------------
  // 走到这里说明我们**拿到了一份读得出来的定义**；那么它的 hash 必须与
  // 记录一致。不一致只有两种可能：库被人直接改过，或者有人绕过本函数写入。
  // 两者都必须**报警**（计划书第 77 节），而不是继续跑。
  if (existing && storedHash && options.acknowledge === undefined) {
    const recomputed = hashSeed(existing)
    if (recomputed !== storedHash) {
      throw new KernelError(
        'validation_error',
        'seed_hash_mismatch',
        `Seed 内容与记录的指纹不一致：库里 hash=${shortHash(storedHash)}，` +
          `重算得 ${shortHash(recomputed)}。这说明 Seed 被**绕过写入闸**改过。` +
          '请先用 `pnpm m3:seed-status` 对照代码里的 Seed，' +
          "确认后用 acknowledge: 'repair' 显式覆盖回代码定义。"
      )
    }
  }

  if (existing && definition.seedVersion === existing.seedVersion) {
    // "内容是否变了"以**库里记录的内容**与**代码里的内容**比较为准。
    // ⚠️ 注意：当库被绕过改过时，`hashSeed(existing)` 与 incomingHash 会不同，
    // 于是这里会报"内容变了不升版本"。那其实是对的 —— 但（故意）无法自愈：
    // 修复必须走 `acknowledge: 'repair'`，因为"要不要丢掉库里的版本"
    // 是一个需要人明确决定的事情，不该由一次启动悄悄完成。
    const same = hashSeed(existing) === incomingHash
    if (same) {
      return { created: false, definition: existing, seedHash: incomingHash, versioned: false }
    }

    if (options.acknowledge !== 'repair') {
      throw new KernelError(
        'validation_error',
        'seed_changed_without_version_bump',
        `Seed 内容发生变化但 seedVersion 未递增（v${definition.seedVersion}）：` +
          `库里 ${shortHash(storedHash ?? '')} vs 代码 ${shortHash(incomingHash)}。` +
          '请升级 SEED_VERSION 并记录 ADR（计划书铁律 2 / 第 18 节）。'
      )
    }
    // acknowledge: 'repair' —— 明确授权把库内容覆盖回代码定义（同版本）
  }

  return await writeSeedRow(db, definition, {
    existing,
    incomingHash,
    now,
  })
}

/**
 * 真正把 Seed 写进去（INSERT ... ON CONFLICT + 历史快照 + 回读）。
 *
 * 抽成独立函数是因为现在有**两条**写入路径：
 *   · 正常的 upsert（过了三道闸之后）
 *   · 迁移 0003 之后的**旧行装载**（`backfill: true`）
 *
 * 两者的 SQL 必须完全一致 —— 否则"装载出来的行"与"正常写入的行"
 * 会在某天悄悄长得不一样，而那是最难查的一类不一致。
 */
async function writeSeedRow(
  db: RawDb,
  definition: CharacterDefinition,
  context: {
    existing: CharacterDefinition | undefined
    incomingHash: string
    now: number
    /** true = 这是一次结构装载（旧行补 definition_json），不是内容变更 */
    backfill?: boolean
  }
): Promise<UpsertSeedResult> {
  const { existing, incomingHash, now } = context
  const canonicalJson = JSON.stringify(canonicalizeSeed(definition))

  await exec(
    db,
    sql`insert into character_definitions
          (id, slug, name, seed_version, identity, personality_baseline,
           communication_style, seed_extras, schema_version, created_at, updated_at,
           definition_json, seed_hash, definition_schema_version)
        values (${definition.id}, ${definition.slug}, ${definition.name}, ${definition.seedVersion},
                ${definition.identity.selfDescription},
                ${renderPersonalityForLegacyColumn(definition)},
                ${renderStyleForLegacyColumn(definition)},
                ${JSON.stringify(legacyExtras(definition))}::jsonb,
                ${existing?.schemaVersion ?? CHARACTER_DEFINITION_SCHEMA_VERSION},
                ${existing?.createdAt ?? definition.createdAt}, ${now},
                ${canonicalJson}::jsonb, ${incomingHash},
                ${definition.schemaVersion || CHARACTER_DEFINITION_SCHEMA_VERSION})
        on conflict (id) do update set
          slug                 = excluded.slug,
          name                 = excluded.name,
          seed_version         = excluded.seed_version,
          identity             = excluded.identity,
          personality_baseline = excluded.personality_baseline,
          communication_style  = excluded.communication_style,
          seed_extras          = excluded.seed_extras,
          schema_version       = excluded.schema_version,
          updated_at           = excluded.updated_at,
          definition_json      = excluded.definition_json,
          seed_hash            = excluded.seed_hash,
          definition_schema_version = excluded.definition_schema_version`,
    context.backfill ? '装载旧行的结构化 Seed' : '写入 CharacterDefinition'
  )

  // --- Seed 历史：每次真正的写入都留一份快照（计划书第 124 节）----------
  await exec(
    db,
    sql`insert into character_definition_versions
          (character_id, seed_version, seed_hash, definition_json, author, reason, effective_at)
        values (${definition.id}, ${definition.seedVersion}, ${incomingHash},
                ${canonicalJson}::jsonb,
                ${definition.provenance?.author ?? null},
                ${definition.provenance?.reason ?? null},
                ${definition.provenance?.effectiveAt ?? now})
        on conflict (character_id, seed_version) do nothing`,
    '记录 Seed 版本历史'
  )

  const stored = await getCharacterDefinition(db, definition.id)
  if (!stored) {
    throw new KernelError(
      'persistence_error',
      'definition_readback_failed',
      'CharacterDefinition 写入后读不回来'
    )
  }
  return { created: !existing, definition: stored, seedHash: incomingHash, versioned: true }
}

/**
 * Seed 版本历史（新的在前）。
 *
 * 计划书第 125 节：这是"她变了"的三种可能里区分"开发者改 Seed"的唯一依据。
 */
export async function listSeedVersions(
  db: RawDb,
  characterId: CharacterId,
  limit = 50
): Promise<SeedVersionRecord[]> {
  const rows = await exec(
    db,
    sql`select * from character_definition_versions
        where character_id = ${characterId}
        order by seed_version desc
        limit ${Math.max(1, Math.min(500, limit))}`,
    '读取 Seed 版本历史'
  )
  return rows.map((row) => {
    const definition = row.definition_json as CharacterDefinition
    return {
      characterId: asCharacterId(String(row.character_id)),
      seedVersion: Number(row.seed_version),
      seedHash: String(row.seed_hash),
      definition: { ...definition, id: asCharacterId(String(row.character_id)) },
      effectiveAt: Number(row.effective_at),
      ...(row.author ? { author: String(row.author) } : {}),
      ...(row.reason ? { reason: String(row.reason) } : {}),
    }
  })
}

/** Seed 的引用串（进 Trace 与日志），形如 `character-definition:sumuwei@3` */
export function seedRefOf(definition: CharacterDefinition): string {
  return seedSourceRef(definition.slug, definition.seedVersion)
}

// ---------------------------------------------------------------------------
// 旧列的投影（**派生**，不是第二真源）
// ---------------------------------------------------------------------------

/**
 * 旧列 `personality_baseline` 的填充。
 *
 * ⚠️ 这不是"又维护一份人设"：它是**从结构化 Seed 派生**的摘要，
 * 由本函数唯一生成。存在它的唯一理由是 M2.5 时代的查询/诊断脚本
 * 仍然在 select 这些列（以及旧库的可读性）。
 * 真正的真源是 `definition_json`。
 */
function renderPersonalityForLegacyColumn(def: CharacterDefinition): string {
  const traits = def.personality?.traits ?? []
  const tendencies = def.personality?.tendencies ?? []
  const lines: string[] = []
  if (traits.length > 0) {
    lines.push(`稳定倾向：${traits.map((t) => t.trait).join('、')}。`)
  }
  if (tendencies.length > 0) {
    lines.push('', '习惯：')
    for (const tendency of tendencies) lines.push(`- ${tendency.tendency}：${tendency.description}`)
  }
  return lines.join('\n')
}

function renderStyleForLegacyColumn(def: CharacterDefinition): string {
  const style = def.communicationStyle
  const lines: string[] = []
  if (style?.tone?.length) lines.push(`- 语气：${style.tone.join('、')}`)
  if (style?.verbosity) lines.push(`- 详略：${style.verbosity}`)
  if (style?.vocabulary?.length) lines.push(`- 用词：${style.vocabulary.join('、')}`)
  for (const habit of style?.habits ?? []) lines.push(`- 习惯：${habit}`)
  for (const avoidance of style?.avoidances ?? []) lines.push(`- 不用：${avoidance}`)
  return lines.join('\n')
}

function legacyExtras(def: CharacterDefinition): Record<string, string> | null {
  const extras: Record<string, string> = {}
  if (def.identity.roleDescription) extras['关系'] = def.identity.roleDescription
  if ((def.values ?? []).length > 0) {
    extras['价值取向'] = def.values.map((v) => v.value).join('、')
  }
  return Object.keys(extras).length > 0 ? extras : null
}
