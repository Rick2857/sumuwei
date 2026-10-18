/**
 * 薄 Node 宿主 —— 换实现，不换接口。
 *
 * ============================================================================
 *  为什么要有它（依据 2026-10-18 的归因与稳态实测，不是"更现代"）
 * ============================================================================
 * 启动期归因（本机 + Linux 服务器，full/thin 配对）：
 *   · 换宿主的**内存**收益不成立（内存持平甚至更高）
 *   · 换宿主**不能**免掉启动 DDL（那是 plugin-sql 固有，与宿主无关）
 *   · 换宿主**能**消掉上游 30s 孤儿定时器：Timeout 2 → 0
 *
 * 稳态归因（服务器，180s 空闲窗）—— 这才是决定性的一组：
 *   full  空闲 CPU **1.019%** 单核 · Timeout=2 · 180s 内 RSS 漂移 **-85.3 MB**
 *   thin  空闲 CPU **0.009%** 单核 · Timeout=0 · 180s 内 RSS 漂移 **0 MB**
 *   根因：`@elizaos/plugin-bootstrap` 注册两个**没有 unref 的常驻 interval**
 *         TASK 每 1000ms 查一次 tasks 表（dist:7054）
 *         embedding-generation 每 100ms 唤醒一次事件循环（dist:7292）
 *
 * ⇒ 在 2 核 / 3623 MB 的生产机上，这 1.0% 常驻 CPU 与其它容器争抢的是**那两个逻辑核**。
 *
 * ============================================================================
 *  严格边界：这是**宿主**，不是 Kernel
 * ============================================================================
 * 本文件**不**拥有任何认知：人格、记忆、关系、情绪、信念、目标、权限判定
 * 全部仍在 Kernel / TurnGateway / ActionGateway。它只提供进程生命周期、
 * 数据库句柄、模型调用转发与最小日志。
 *
 * **不引入**任何"更重"的抽象：没有 LangGraph、没有事件溯源框架、没有新的模型 SDK。
 *
 * ============================================================================
 *  与 ElizaOS 的关系：同一组方法名，调用点不改
 * ============================================================================
 * 本类实现 LG 实际用到的 12 个方法：
 *   initialize / stop / adapter / agentId / events
 *   registerPlugin / runPluginMigrations
 *   useModel / getMemories / createMemory
 *   ensureEntity / ensureRoomExists / ensureParticipantInRoom
 * 外加 `composeState`（仅旧链路 M1 用；新链路走 ContextCompiler，不经过它）。
 *
 * ⚠️ **不实现** composeState 的 provider 体系：白名单 provider
 *    （CHARACTER / CHARACTER_STATE / RECENT_MESSAGES / TIME / ROLES）
 *    是 bootstrap 注册的，薄宿主下**不再存在**。
 *    ⇒ 旧链路（`CHARACTER_CONTEXT_COMPILER_V1=0`）在薄宿主下**不可用**，
 *    必须显式失败关闭，**绝不能**静默返回一个空 prompt 让模型自由发挥。
 *    见 `composeState()`：它抛具名错误，不是返回空串。
 */

import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'

import type { RawDb } from '../persistence/db.ts'
import { openAiCompatiblePlugin } from '../../providers/openai-compatible.ts'
import { KernelError } from '../../kernel/contracts/index.ts'

// ---------------------------------------------------------------------------
// 类型：与 ElizaOS 的同名概念保持结构一致，但**不 import 它的类型**
// ---------------------------------------------------------------------------
// ⚠️ 刻意不 `import type { IAgentRuntime } from '@elizaos/core'`：
//    那样只是把耦合从"值"搬到"类型"，仍然绑死上游版本。
//    这里定义**结构相同但自有的**类型，调用点靠结构兼容（见 thin-host-bridge.ts）。

export interface ThinMemory {
  id: string
  entityId: string
  agentId: string
  roomId: string
  worldId?: string
  content: { text?: string; [k: string]: unknown }
  createdAt?: number
  metadata?: Record<string, unknown>
}

export interface ThinDbAdapter {
  /** drizzle 包装层：LG 全部仓储都经它 */
  db: RawDb
  /** 供 runtime-shutdown.ts 判"是否真的关了" */
  manager: { getConnection: () => { end?: () => Promise<void>; ended?: boolean; ending?: boolean } }
  close: () => Promise<void>
}

export interface ThinHostOptions {
  /** 与旧 `new AgentRuntime({ character, ... })` 的形状对齐 */
  character: { name: string; id?: string }
  agentId: string
  settings: Record<string, string>
  /** 由调用方注入的 pg Pool（**薄宿主不自己 new Pool**：连接策略归部署层） */
  pool: { query: (q: unknown) => Promise<unknown>; end?: () => Promise<void>; ended?: boolean }
  logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void; debug: (m: string) => void }
}

/** 薄宿主自己的一份日志（不引 ElizaOS 的 logger） */
export function thinLogger(): ThinHostOptions['logger'] {
  const emit = (level: string) => (message: string) => {
    const line = `[thin-host:${level}] ${message}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }
  return { info: emit('info'), warn: emit('warn'), error: emit('error'), debug: () => {} }
}

export class ThinHostRuntime {
  readonly agentId: string
  readonly character: { name: string; id?: string }
  readonly settings: Record<string, string>
  readonly logger: ThinHostOptions['logger']
  readonly events: Record<string, ((payload: unknown) => void)[]> = {}

  adapter!: ThinDbAdapter

  private readonly pool: ThinHostOptions['pool']
  private stopped = false
  private initialized = false

  constructor(options: ThinHostOptions) {
    this.character = options.character
    this.agentId = options.agentId
    this.settings = options.settings
    this.pool = options.pool
    this.logger = options.logger
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------
  /**
   * `initialize()` —— 对应 ElizaOS 的 `runtime.initialize()`。
   *
   * ⚠️ **这里没有 30 秒守卫定时器，也没有 TASK / embedding 两个常驻 interval。**
   *    这正是稳态 CPU 从 1.019% 降到 0.009% 的原因（见文件头实测）。
   *    旧宿主需要 `withGuardTimersUnrefed()` 这个猴子补丁才能退出干净，
   *    薄宿主**从结构上就没有那个问题**，因此该补丁可以退役。
   */
  async initialize(): Promise<{ services: string[] }> {
    if (this.initialized) return { services: [] }
    this.initialized = true
    this.logger.info('薄宿主就绪：无常驻轮询服务、无上游守卫定时器')
    return { services: [] }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.initialized = false
    await this.closeDatabase()
    this.logger.info('薄宿主已停止（连接已关）')
  }

  // -------------------------------------------------------------------------
  // 数据库
  // -------------------------------------------------------------------------
  /**
   * `registerPlugin(sqlPlugin)` 的等价物：把注入的连接包成 LG 认识的 `adapter`。
   *
   * ⚠️ 与旧宿主的关键差别：旧宿主在这里**连带跑了上游 plugin-sql 的建表 DDL**，
   *    因此启动就需要 CREATE 权限。薄宿主**不跑任何 DDL** ——
   *    schema 安装属于显式维护入口（`pnpm migrate:apply`）。
   */
  async registerPlugin(_plugin: unknown): Promise<void> {
    const db = drizzle(this.pool as never)
    this.adapter = {
      db: db as unknown as RawDb,
      manager: { getConnection: () => this.pool as never },
      close: async () => {
        await this.closeDatabase()
      },
    }
    this.logger.info('数据库适配器已就绪（未执行任何 DDL）')
  }

  /**
   * `runPluginMigrations()` 的等价物 —— **失败关闭**。
   *
   * 旧宿主靠它在启动时建表；薄宿主不建表，所以调用它意味着
   * "有人想在启动期改 schema"，而这是我们明确禁止的。
   * ⇒ 抛具名错误，而不是静默 no-op（静默会让调用方以为迁移过了）。
   */
  async runPluginMigrations(): Promise<never> {
    throw new KernelError(
      'persistence_error',
      'thin_host_refuses_startup_ddl',
      '薄宿主不在启动期执行任何 DDL。\n' +
        'schema 安装/升级请走显式维护入口：`pnpm migrate:apply`（或 `--migrate`）。\n' +
        '（本次没有改动任何数据。）'
    )
  }

  async closeDatabase(): Promise<void> {
    if (this.adapter === undefined) return
    if (typeof this.pool.end === 'function') {
      if (this.pool.ended !== true) await this.pool.end()
    }
  }

  /** 供 runtime-shutdown.ts 判"是否真的关了" */
  isDatabaseClosed(): boolean {
    return this.pool.ended === true
  }

  // -------------------------------------------------------------------------
  // 模型调用：转发给 LG 自己已验证的 provider
  // -------------------------------------------------------------------------
  /**
   * `useModel()` —— 直接调 LG 的 `openai-compatible` 处理器。
   *
   * ⚠️ 旧宿主这里经过一层"按 priority 查表"的注册中心；薄宿主直接转发，
   *    少一次分派，也就不存在"谁覆盖了谁"的问题
   *    （`src/providers/openai-compatible.ts:10-19` 记的就是当初为什么要用 priority 压过插件）。
   */
  async useModel(modelType: string, params: Record<string, unknown>): Promise<unknown> {
    const models = openAiCompatiblePlugin.models as unknown as Record<
      string,
      (runtime: unknown, p: unknown) => Promise<unknown>
    >
    const handler = models[modelType] ?? models.TEXT_LARGE
    if (typeof handler !== 'function') {
      throw new KernelError('persistence_error', 'thin_host_no_model_handler', `没有可用的处理器：${modelType}`)
    }
    const shim = { logger: this.logger, getSetting: (k: string) => this.settings[k] }
    return handler(shim, params)
  }

  // -------------------------------------------------------------------------
  // ElizaOS 表的最小实现（消息镜像 / world / entity / room / participant）
  // -------------------------------------------------------------------------
  // ⚠️ 这些表**仍然要写**：`src/main.ts:4873/5311/5468` 的 createMemory 与
  //    `nextTurn()` 的轮次号都依赖它们。退场是**另一个迁移切片**（评估 §5 S3），
  //    不在本次替换范围内 —— 先保证行为等价。

  private async exec(query: unknown): Promise<Record<string, unknown>[]> {
    const result = await this.adapter.db.execute(query)
    const rows = (result as { rows?: unknown[] })?.rows ?? result
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
  }

  /**
   * 带参数的原生查询。
   *
   * ⚠️ `pool` 的类型只声明了单参数 `query(text)`（pg 的 `query(config, values)`
   *    是重载，结构类型接不住）。这里集中封一个薄封装，
   *    **所有**值都走 `$n` 参数，绝不拼进 SQL 文本。
   */
  private async exec2(text: string, values: unknown[]): Promise<Record<string, unknown>[]> {
    const runner = this.pool as unknown as {
      query: (t: string, v?: unknown[]) => Promise<unknown>
    }
    const result = await runner.query(text, values)
    return ((result as { rows?: Record<string, unknown>[] })?.rows ?? []) as Record<string, unknown>[]
  }

  /** 消息表在 1.7.2 里就是 `memories`，按 `type='messages'` 区分 */
  private get messageTable(): string {
    return 'memories'
  }

  async getMemories(options: {
    tableName?: string
    roomId?: string
    entityId?: string
    agentId?: string
    count?: number
  }): Promise<ThinMemory[]> {
    const where: string[] = []
    const params: unknown[] = []
    if (options.roomId !== undefined) {
      where.push('room_id = $1')
      params.push(options.roomId)
    }
    if (options.entityId !== undefined) {
      where.push('entity_id = $2')
      params.push(options.entityId)
    }
    if (this.messageTable === 'memories') {
      // ⚠️ 与 createMemory 同源：消息行在 1.7.2 里就是 memories 表的 `type='messages'`。
      //    不过滤会把 embedding / fact 等其它 type 的行一起读出来。
      where.push("type = 'messages'")
    }
    const limit = options.count ?? 100
    const clause = where.length > 0 ? `where ${where.join(' and ')}` : ''
    const rows = await this.exec2(
      `select id, entity_id, agent_id, room_id, content, created_at, metadata
         from ${this.messageTable} ${clause} order by created_at asc limit ${String(limit)}`,
      params
    )
    return rows.map((r) => ({
      id: String(r.id),
      entityId: String(r.entity_id),
      agentId: String(r.agent_id),
      roomId: String(r.room_id),
      content: (r.content ?? {}) as { text?: string },
      // ⚠️ `created_at` 是 **timestamp**，pg 返回的是 Date（不是毫秒整数）。
      //    旧宿主（plugin-sql/drizzle）同样返回 Date ⇒ 这里保持 Date 原样透传，
      //    调用点的 `Number(m.createdAt)` 语义不变（旧宿主也是这么被消化的）。
      createdAt: r.created_at as unknown as number,
      metadata: (r.metadata ?? undefined) as Record<string, unknown> | undefined,
    }))
  }

  async createMemory(
    memory: ThinMemory,
    tableName: string,
    unique = false
  ): Promise<{ id?: string }> {
    const table = tableName === 'messages' ? this.messageTable : tableName
    // unique=true ⇒ onConflictDoNothing（**旧宿主同形**：重复 id 被静默丢弃）
    const conflict = unique ? ' on conflict (id) do nothing' : ''
    // ⚠️ `memories.type` 是 **NOT NULL**：plugin-sql 的 `createMemory(mem,'messages')`
    //    会写 `type='messages'`。漏掉这一列 ⇒ 真 PG 报
    //    `null value in column "type" ... violates not-null constraint`。
    //    （这是跑**真实 PostgreSQL** 才暴露的第二个缺陷；PGlite 上不一定拦得住。）
    const typeColumn = table === 'memories' ? `, type` : ''
    // ⚠️ metadata 恒占 $6（undefined 时也传 null 占位），因此 type 恒为 $7。
    //    不要按 "metadata 是否有值" 动态算下标 —— 那样在 undefined 分支下
    //    会把 type 绑到 $6，与实际参数数组错位（第一版就写错过一次）。
    const typeValue = table === 'memories' ? `, $7` : ''
    // ⚠️ `memories.metadata` 也是 **NOT NULL**（catalog: jsonb）。
    //    第一版传 null ⇒ `null value in column "metadata" ... violates not-null constraint`。
    //    ⇒ 缺省给空对象 `{}`，与 plugin-sql 的行为同形（它写 `'{}'`）。
    const metadataJson = JSON.stringify(memory.metadata ?? {})
    // ⚠️ `created_at` 是 **timestamp without time zone**，默认 `now()`
    //    （服务器 catalog 实读）。第一版显式塞**毫秒整数** ⇒ SQLSTATE 22008。
    //    ⇒ 不传该列，交给数据库默认值 —— 与旧宿主同形。
    await this.exec2(
      `insert into ${table} (id, entity_id, agent_id, room_id, content, metadata${typeColumn})
       values ($1,$2,$3,$4,$5,$6${typeValue})${conflict}`,
      [
        memory.id,
        memory.entityId,
        memory.agentId,
        memory.roomId,
        JSON.stringify(memory.content ?? {}),
        metadataJson,
        ...(table === 'memories' ? ['messages'] : []),
      ]
    )
    return { id: memory.id }
  }

  // -------------------------------------------------------------------------
  // world / entity / room / participant（`ensure*` 的幂等等价物）
  // -------------------------------------------------------------------------
  private async ensureRow(
    table: string,
    columns: Record<string, unknown>,
    conflictTarget: string
  ): Promise<void> {
    const keys = Object.keys(columns)
    // 全部内联成**单参数** SQL：值一律当文本参数经 pg 转义，不做字符串拼接。
    const values = keys.map((k) => columns[k])
    const placeholders = keys.map((_, i) => `$${String(i + 1)}`)
    await this.exec2(
      `insert into ${table} (${keys.join(', ')}) values (${placeholders.join(', ')})
       on conflict (${conflictTarget}) do nothing`,
      values
    )
  }

  /**
   * `ensureWorldExists()` —— 与旧宿主同形（幂等）。
   *
   * ⚠️ **这是第三次启用时才暴露的缺口**：前两次我按"预估"挑方法（12 个），
   *    漏了它 ⇒ 生产报 `this.runtime.ensureWorldExists is not a function`。
   *    ⇒ 现在改为**穷举** `src/**` 里所有 `runtime.<方法>(` 调用来确定接口面。
   */
  async ensureWorldExists(input: {
    id: string
    name?: string
    agentId?: string
    metadata?: unknown
  }): Promise<void> {
    await this.ensureAgentRow(this.agentId)
    await this.ensureRow(
      'worlds',
      {
        id: input.id,
        agent_id: input.agentId ?? this.agentId,
        name: input.name ?? input.id,
        metadata: JSON.stringify(input.metadata ?? {}),
      },
      'id'
    )
  }

  /**
   * `getSetting()` —— 与旧宿主同形：读内部设置，**不回落** process.env。
   *
   * ⚠️ 穷举才发现的第二个缺口（`src/providers/openai-compatible.ts:63` 调它）。
   *    薄宿主没有 plugin-sql 那张 settings 表，所以读构造时播种的那份 ——
   *    这是**等价**的：唯一的调用方拿到的正是它自己传进来的值。
   */
  getSetting(key: string): string | undefined {
    const v = this.settings[key]
    return v === undefined || v === '' ? undefined : v
  }

  async ensureEntity(input: { id: string; names?: string[]; agentId?: string; metadata?: unknown }): Promise<void> {
    // ⚠️ **FK 前置**：`entities.agent_id → agents.id`
    //    （服务器 catalog 实读：entities_agent_id_agents_id_fk）。
    //    旧宿主由 core 的 `ensureAgentExists()` 在 initialize() 里建那一行；
    //    薄宿主没有服务注册，所以必须自己保证它存在。
    await this.ensureAgentRow(this.agentId)
    // ⚠️ 列名是 **`names`（text[]）**，不是 `name`：第一版写 `name` ⇒
    //    `column "name" of relation "entities" does not exist`。
    //    （catalog：entities.names :: ARRAY NOT NULL default '{}'）
    const names = input.names ?? []
    const metadata = {
      ...(input.metadata as Record<string, unknown> | undefined),
    }
    await this.ensureRow(
      'entities',
      {
        id: input.id,
        agent_id: input.agentId ?? this.agentId,
        names: `{${names.map((n) => `"${n.replace(/"/g, '""')}"`).join(',')}}`,
        metadata: JSON.stringify(metadata),
      },
      'id'
    )
  }

  /**
   * 确保 `agents` 里有一行本宿主代表的角色（`entities`/`rooms`/`memories` 的 FK 目标）。
   *
   * ⚠️ `agents` 的 NOT NULL 且**无默认**的列：name / message_examples / post_examples /
   *    topics / adjectives / knowledge / plugins / settings / style
   *    （catalog 实读）。jsonb 类都有默认值，所以只补 `name` 即可。
   */
  async ensureAgentRow(agentId: string): Promise<void> {
    await this.ensureRow('agents', { id: agentId, name: this.character.name }, 'id')
  }

  async ensureRoomExists(input: {
    id: string
    name?: string
    source?: string
    type?: string
    worldId?: string
  }): Promise<void> {
    // ⚠️ `rooms.agent_id → agents.id`（FK），必须先有 agents 行。
    await this.ensureAgentRow(this.agentId)
    // ⚠️ `source` / `type` 是 NOT NULL 且**无默认**（catalog 实读）⇒ 必须显式给。
    await this.ensureRow(
      'rooms',
      {
        id: input.id,
        source: input.source ?? 'cli',
        type: input.type ?? 'DM',
        name: input.name ?? null,
        world_id: input.worldId ?? null,
        metadata: '{}',
      },
      'id'
    )
  }

  async ensureParticipantInRoom(entityId: string, roomId: string): Promise<void> {
    // ⚠️ `participants` 的主键是**自增 uuid `id`**，没有 (entity_id, room_id) 唯一约束
    //    （catalog 实读），所以"同一人同一房间只有一行"必须**由我们**保证。
    //    ⇒ 先查后插；直接 insert 会每次多一行。
    const existing = await this.exec2(
      'select id from participants where entity_id = $1 and room_id = $2 limit 1',
      [entityId, roomId]
    )
    if (existing.length > 0) return
    await this.ensureRow(
      'participants',
      { id: randomUUID(), entity_id: entityId, room_id: roomId },
      'id'
    )
  }

  // -------------------------------------------------------------------------
  // composeState：旧链路专用，薄宿主下**失败关闭**
  // -------------------------------------------------------------------------
  /**
   * ⚠️ 刻意**不**实现 provider 体系。
   *
   * 薄宿主下 bootstrap 不再注册 CHARACTER / RECENT_MESSAGES / TIME / ROLES
   * 等 provider，所以 `composeState()` 拿不到任何东西。
   *
   * **为什么必须抛错而不是返回空串**：旧链路（`CHARACTER_CONTEXT_COMPILER_V1=0`）
   * 若拿到一个空 prompt，模型就会在没有人格、没有历史的条件下自由发挥，
   * 而**对话照常进行、错误照常返回 0** —— 那是最坏的失败形态
   * （她会变成另一个人，而且没有任何告警）。
   *
   * ⇒ 具名错误 + 明确的处置指引，让它**响亮地**失败。
   *    新链路（默认）根本不经过这里，所以这不影响正常对话。
   */
  async composeState(_input: unknown): Promise<never> {
    throw new KernelError(
      'persistence_error',
      'thin_host_no_legacy_providers',
      '薄宿主不提供 ElizaOS 的 provider 体系，旧链路（composeState + 模板）不可用。\n' +
        '请使用新链路 ContextCompiler（CHARACTER_CONTEXT_COMPILER_V1=1，缺省即开）。\n' +
        '（本次没有改动任何数据。）'
    )
  }
}
