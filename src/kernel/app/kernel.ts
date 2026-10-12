/**
 * Character Kernel 的组装入口。
 *
 * ============================================================================
 *  "谁拥有苏沐薇的状态"在这里被回答
 * ============================================================================
 * 上层（CLI / 未来的网关 / 测试）只通过这个对象访问角色长期状态，
 * 因此**没有第二条路**可以绕过 Proposal→Validator→DomainEvent→Reducer→Projection。
 *
 * 注意本文件属于"Application Layer"：
 *   · 它**可以** import kernel（领域）与 infrastructure（持久化）
 *   · 它**不** import ElizaOS 的任何东西
 *     适配器（runtime-adapter）负责把我们的契约接到 ElizaOS 上，
 *     依赖方向永远是 runtime → application → domain ← infrastructure
 *
 * ============================================================================
 *  M3：身份读取也收敛到这里
 * ============================================================================
 * WP3 Gate：**所有 Character Main Agent 调用都由 IdentityProvider 得到 Seed，
 * 不存在第二人格来源。**
 *
 * 落地点就是本文件里的 `identity`：它是 `CharacterIdentityService` 的实例，
 * 而 Context Compiler / Turn Gateway / Trace 都只认它给出的
 * `IdentitySnapshot`。装配层**不再**各自去读 `character_definitions` 表。
 */

import {
  createDefaultDomainEventRegistry,
  seedSourceRef,
  type CharacterDefinition,
  type CharacterId,
  type DomainEventRegistry,
  type IdentitySnapshot,
  type ProjectionReducer,
  type TraceWriter,
  asCharacterId,
} from '../contracts/index.ts'
import { createDiagnosticReducer, type DiagnosticState } from '../projections/diagnostic.ts'
import {
  createDomainPolicyValidator,
  type DomainPolicyValidator,
} from '../policies/validator.ts'
import {
  CharacterIdentityService,
  SeedAdminPath,
  type CharacterIdentityStore,
  type SeedHasher,
} from './identity-service.ts'
import { getRawDb, type RawDb } from '../../infrastructure/persistence/db.ts'
import {
  getCharacterDefinition,
  getStoredSeedHash,
  listSeedVersions,
  upsertCharacterDefinition,
} from '../../infrastructure/persistence/character-store.ts'
import { hashSeed } from '../../infrastructure/persistence/seed-hash.ts'
import { createTraceWriter } from '../../infrastructure/persistence/trace-store.ts'
import { hasProcessedOperation } from '../../infrastructure/persistence/job-store.ts'
import { findEventRefs } from '../../infrastructure/persistence/conversation-store.ts'

export interface KernelStores {
  db: RawDb
  traceWriter: TraceWriter
}

export interface KernelHandle {
  characterId: CharacterId
  definition: CharacterDefinition
  /** Seed 是否为本次新建 */
  seedCreated: boolean
  /** M3：身份的唯一读取入口（WP3 Gate 的落地点） */
  identity: CharacterIdentityService
  /** M3：本轮身份快照（`seedVersion` / `seedHash` / `identitySourceRefs` 的来源） */
  identitySnapshot: IdentitySnapshot
  /** M3：Seed 的**唯一**写入口。主对话链路拿不到它。 */
  seedAdmin: SeedAdminPath
  registry: DomainEventRegistry
  /** 当前登记的全部 reducer（M2.5：只有诊断投影） */
  reducers: readonly ProjectionReducer<unknown>[]
  validator: DomainPolicyValidator
  stores: KernelStores
  /** 便于测试与 `--kernel-status` 直接断言投影状态 */
  diagnosticReducer: ProjectionReducer<DiagnosticState>
}

export interface InitKernelOptions {
  /**
   * Seed Identity（由**适配器**从运行时角色定义投影而来，
   * 见 `src/infrastructure/runtime/seed-projection.ts`）。
   *
   * 刻意做成必填：Application 层不该知道"角色定义长什么样"，
   * 那是运行时的事；它只接受已经成形的领域对象。
   */
  definition: CharacterDefinition
  /**
   * 领域事件类型登记表（M4 新增，计划书第 70 节）。
   *
   * ============================================================================
   *  为什么是**注入**而不是直接往默认表里加
   * ============================================================================
   * 缺省 = `createDefaultDomainEventRegistry()`，即 M2.5 的最小诊断集。
   * 因此**不传这个字段时，行为与 M2.5 逐字节一致** ——
   * 既有调用点（`src/main.ts`、`evals/harness/runner.ts`、若干 scripts）
   * 一个都不用改，而 M2.5/M3 的 267 项基线正建立在那份最小集上。
   *
   * M4 的装配层传入 `createFullDomainEventRegistry()`（诊断 + Memory）。
   * 判定见 `docs/m4/compatibility-audit.md` §3 A1。
   */
  registry?: DomainEventRegistry
  /** 运行时追加的 reducer（测试常用；生产只有诊断投影） */
  extraReducers?: ProjectionReducer<never>[]
  /**
   * 指纹算法注入点。
   *
   * 默认用基础设施的 sha256；测试可以注入确定性实现，
   * 这样"渲染与指纹是否稳定"可以在不碰 crypto 的情况下断言。
   */
  hash?: SeedHasher
  /**
   * 跳过 Seed 写入（**只读模式**）。
   *
   * 用途：`--kernel-status` / `--dump-prompt` 这类只读命令不该因为
   * "写了一次 Seed"而改变数据库。它们需要身份，但不需要建档。
   */
  readOnly?: boolean
}

/**
 * 从基础设施的仓储拼出领域侧的身份存储口。
 *
 * 单独一个函数是为了让"领域服务需要什么"与"SQL 怎么实现"之间的
 * 映射只有一处 —— 加一个字段时不会漏掉某个构造点。
 */
export function identityStoreFor(db: RawDb): CharacterIdentityStore {
  return {
    getDefinition: (characterId) => getCharacterDefinition(db, characterId),
    getStoredHash: (characterId) => getStoredSeedHash(db, characterId),
    listVersions: (characterId, limit) => listSeedVersions(db, characterId, limit),
    upsert: (definition, options) => upsertCharacterDefinition(db, definition, options),
  }
}

/**
 * 初始化 Kernel。
 *
 * 迁移已经在 `initDatabase()` 里跑过（所有入口共用），因此这里只做：
 *   1. 写入 / 校验 Seed Identity
 *   2. 构造身份服务并取一次快照（**一轮一次**，见 identity-service.ts）
 *   3. 组装 registry / validator / reducer / store
 *
 * **幂等**：反复调用不会产生第二条 Seed、不会重复建表。
 */
export async function initKernel(
  runtime: unknown,
  options: InitKernelOptions
): Promise<KernelHandle> {
  const db = getRawDb(runtime)
  const hash = options.hash ?? hashSeed

  // --- Seed Identity ------------------------------------------------------
  // 刻意不覆盖已存在的 Seed：写入必须通过 upsertCharacterDefinition 的版本校验
  // （内容变了必须升版本，内容与指纹不符必须报警）。
  const store = identityStoreFor(db)
  let definition: CharacterDefinition
  let seedCreated = false

  if (options.readOnly) {
    const existing = await store.getDefinition(options.definition.id)
    if (!existing) {
      // 只读模式下**不建档**：但也不能假装她有 Seed。
      // 用代码里的定义继续（这样 `--dump-prompt` 仍然能看到真实人格），
      // 只是不写库 —— 并在调用方那一层打印提示。
      definition = options.definition
    } else {
      definition = existing
    }
  } else {
    const result = await store.upsert(options.definition)
    definition = result.definition
    seedCreated = result.created
  }

  // --- 身份服务（M3 的唯一身份读取入口）-----------------------------------
  const identity = new CharacterIdentityService({
    store,
    hash,
    characterId: definition.id,
  })
  const identitySnapshot = await identity.buildIdentitySnapshot()
  const seedAdmin = new SeedAdminPath({ store, hash })

  // --- Registry / Reducer -------------------------------------------------
  // M4：缺省仍是 M2.5 的最小诊断集，因此不传 registry 时行为逐字节不变
  const registry = options.registry ?? createDefaultDomainEventRegistry()
  const diagnosticReducer = createDiagnosticReducer()
  const reducers: ProjectionReducer<unknown>[] = [
    diagnosticReducer as unknown as ProjectionReducer<unknown>,
    ...((options.extraReducers ?? []) as unknown as ProjectionReducer<unknown>[]),
  ]

  // --- Validator ----------------------------------------------------------
  const validator = createDomainPolicyValidator({
    registry,
    sources: {
      findEvents: (ids) => findEventRefs(db, ids),
    },
    processed: {
      hasProcessed: (key) => hasProcessedOperation(db, key),
    },
  })

  // --- Trace --------------------------------------------------------------
  const traceWriter = createTraceWriter(db)

  return {
    characterId: definition.id,
    definition,
    seedCreated,
    identity,
    identitySnapshot,
    seedAdmin,
    registry,
    reducers,
    validator,
    stores: { db, traceWriter },
    diagnosticReducer,
  }
}

/** 只读地读取已存在的 Seed（不写库；Seed 不存在时返回 undefined） */
export async function readKernelSeed(
  runtime: unknown,
  characterId: string
): Promise<CharacterDefinition | undefined> {
  return getCharacterDefinition(getRawDb(runtime), asCharacterId(characterId))
}

/**
 * 身份快照的 Trace 字段（**一处生成，处处一致**）。
 *
 * Turn Gateway、评测、诊断命令都要把这三样写进 trace。
 * 各写一遍就会有一天不一致，而不一致的 trace 比没有 trace 更糟
 * （它会让人得出错误的结论）。
 */
export function identityTraceFields(snapshot: IdentitySnapshot): {
  seedVersion: number
  seedHash: string
  identitySourceRefs: string[]
} {
  return {
    seedVersion: snapshot.seedVersion,
    seedHash: snapshot.snapshotHash,
    identitySourceRefs: [seedSourceRef(snapshot.definition.slug, snapshot.seedVersion)],
  }
}
