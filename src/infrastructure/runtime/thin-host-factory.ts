/**
 * 薄宿主接线 —— 让 `buildRuntime()` 能按开关选用薄宿主，而**调用点一行不改**。
 *
 * ============================================================================
 *  为什么是这个形状（而不是改 51 处类型标注）
 * ============================================================================
 * `AgentRuntime` / `IAgentRuntime` 两个上游类型散布在 51 处：
 *   adapters.ts 20 · state/repository.ts 11 · main.ts 8 · db/index.ts 2 …
 * 若按"换接口"做，就要动全部 51 处 —— 那不是换实现，是重写。
 *
 * 事实依据：这些模块**本来就不依赖具体类**：
 *   · `runtime-shutdown.ts` 全部按 `runtime: unknown` + 结构断言访问
 *     （`stopRuntimeServices` / `closeDatabaseConnection` / `isDatabaseClosed`）
 *   · `state/repository.ts:63` 的 `getRawDb()` 也是 `as unknown as {adapter:…}`
 * 而薄宿主的 `adapter` 形状（`{db, manager:{getConnection()}, close}`）与旧宿主**同形**
 * ⇒ 这些断言天然兼容，**一行都不用改**。
 *
 * ⚠️ 因此本文件只做一件事：**按开关造出结构兼容的宿主**。
 *    返回类型标注成 `AgentRuntime`（上游类型），靠**结构兼容**通过类型检查 ——
 *    这正是"换实现不换接口"的含义：类型契约由调用点共享，实现由我们换。
 */

import type { AgentRuntime } from './eliza-types.ts'
import pg from 'pg'
import { createRequire } from 'node:module'
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'

import { ThinHostRuntime, thinLogger } from './thin-host.ts'
import { setActiveHostKind, activeHostKind } from './thin-host-bridge.ts'
import { resolvePgliteEntry } from '../persistence/pglite-entry.ts'
import { stringToUuid } from '../../kernel/contracts/uuid.ts'

/**
 * 薄宿主开关 —— **缺省即薄宿主**（M12 · D2）。
 *
 * ============================================================================
 *  ⚠️⚠️ 语义已在 2026-10-19 **变更**（M12 计划 D2），且这是**有意的代价**
 * ============================================================================
 * **旧语义**（2026-10-18）：缺省 off ⇒ 未设变量就还用 ElizaOS 宿主。
 * **新语义**（D2，薄宿主是**唯一实现**）：
 *
 * | `CHARACTER_THIN_HOST` | 行为 |
 * | --- | --- |
 * | 未设 | **启动成功**（薄宿主）—— 缺省即唯一实现，不能让人无声失败 |
 * | `on` / `1` / `true` | **启动成功**（薄宿主）—— 兼容既有生产 `.env` |
 * | `off` / `0` / `false` | **拒绝启动**，报"薄宿主是唯一运行时，ElizaOS 宿主已退役" |
 * | 其它值 | **拒绝启动**，列出合法值 |
 *
 * ⚠️ **为什么 `off` 要拒绝启动而不是"回落到旧宿主"**：
 *   删包后 `@elizaos/core` **无法加载** ⇒ 旧分支不是"变慢"，而是**启动即失败**。
 *   静默改用薄宿主 = 让人以为配置生效了 ⇒ 必须**响亮地拒**。
 *
 * ⚠️ **代价（如实记）**：`off` 拒绝启动 = **生产回滚路径消失**。
 *   回滚不再靠"换宿主"，而是靠 `git checkout` 回到带 ElizaOS 的提交 + 恢复 lockfile
 *   （M12 计划 §7 第 4 条）。这是 D2 明写接受的代价。
 *
 * ⚠️ **影响面实测（2026-10-19）**：`scripts/` 里有 136 个脚本自己
 *   `new AgentRuntime(...)`（**不走本开关**）⇒ 翻转缺省**不影响**它们；
 *   真正走 `buildRuntime()` 的只有 4 个脚本。生产 `.env` 是 `=on` ⇒ **行为不变**。
 */
export const THIN_HOST_ENV = 'CHARACTER_THIN_HOST'

/** 合法值（`off` 系列**不在**其中 —— 它是"拒绝启动"，不是"另一个合法档"） */
export const THIN_HOST_LEGAL_VALUES: readonly string[] = ['on', '1', 'true']

/**
 * 判定宿主档位。**永远返回 true 或抛错** —— 没有"第三个答案"。
 *
 * ⚠️ 返回类型仍是 `boolean` 是为了不惊动既有调用点；语义上它恒为 `true`。
 *    真正的判据是**它有没有抛错**。
 */
export function thinHostEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[THIN_HOST_ENV] ?? '').trim().toLowerCase()
  if (raw === '' || raw === 'on' || raw === '1' || raw === 'true') return true
  if (raw === 'off' || raw === '0' || raw === 'false') {
    throw new Error(
      '[thin-host] 薄宿主是唯一运行时，ElizaOS 宿主已退役。\n' +
        `  ${THIN_HOST_ENV}="${raw}" 是在要求使用一个**已不存在**的运行时。\n` +
        '  （删包后 @elizaos/core 无法加载 ⇒ 那不是"变慢"，而是启动即失败。）\n' +
        '  要回退请用 git checkout 回到带 ElizaOS 的提交并恢复 lockfile，\n' +
        '  不要靠这个开关。\n' +
        '  （本次没有改动任何数据。）'
    )
  }
  // ⚠️ 非法值**拒绝启动**并列出合法值：不让一个拼错的变量把生产带进不可判定状态。
  throw new Error(
    `[thin-host] ${THIN_HOST_ENV}="${raw}" 不是合法值。\n` +
      `  合法值：${THIN_HOST_LEGAL_VALUES.join(' / ')}（不设即薄宿主，缺省即唯一实现）。\n` +
      '  （本次没有改动任何数据。）'
  )
}

export interface ThinHostFactoryOptions {
  character: { name: string; id?: string; system?: string }
  /**
   * 角色 id —— **可省**（省了就按**上游同款规则**推导，见 `resolveAgentId`）。
   *
   * ⚠️⚠️ **上游的优先级是 `character.id` 优先于显式 `agentId`**
   *   （`opts.character?.id ?? opts?.agentId ?? stringToUuid(name)`，core dist:48921）。
   *   ⇒ 这里**照抄**，否则薄宿主的 `runtime.agentId` 会与旧宿主**不同**
   *   ⇒ 而 `agent_id` 是 `entities`/`rooms`/`memories`/`participants` 的外键
   *   ⇒ 不同就意味着**数据分裂**（生产已实测到一次，见 `resolveAgentId` 的说明）。
   */
  agentId?: string
  settings: Record<string, string>
  conversationLength?: number
}

/**
 * 推导 `runtime.agentId` —— **逐字照抄上游**（`@elizaos/core@1.7.2` dist:48921）：
 *
 * ```text
 *   this.agentId = opts.character?.id ?? opts?.agentId ?? stringToUuid(opts.character?.name ?? v4())
 * ```
 *
 * ⚠️⚠️ **为什么必须逐字照抄**（2026-10-19 生产实测发现的真问题）：
 *   薄宿主最初传的是 `stringToUuid('agent-' + character.name)`
 *   ⇒ `11111111-2222-4333-8444-555555555555`
 *   而**旧宿主**用的是 `character.id`
 *   ⇒ `00000000-0000-4000-8000-000000000001`
 *
 *   而 `agent_id` 是 `entities`(4 行) / `rooms`(4) / `memories`(197) / `participants`(7)
 *   的**外键** ⇒ 两种 id 会把**同一个角色**的数据劈成两半。
 *   实测：`agents` 表因此**多出一行**薄宿主建的苏沐薇（旧那行在 2026-09-15）。
 *
 * ⇒ 改成照抄后，薄宿主会**复用**已有那行（`ensureAgentRow` 是按 id upsert）
 *   ⇒ 与历史 197 条**同一个 id** ⇒ 分裂被**预防**。
 * ⚠️ 那行多出来的 `agents` 行会变成**孤儿行**（无引用）——**不删**
 *   （生产数据删除需逐字授权），只如实登记。
 */
export function resolveAgentId(
  character: { name: string; id?: string },
  explicitAgentId?: string
): string {
  return character.id ?? explicitAgentId ?? stringToUuid(`agent-${character.name}`)
}

/**
 * 造一个薄宿主。
 *
 * ⚠️ **只支持 PostgreSQL 后端**：薄宿主直接持有 `pg.Pool`，不经过 plugin-sql，
 * 因此 PGlite 分支**不被支持**（那是开发/沙箱用的嵌入式库）。
 * 有人用 PGlite + 薄宿主时**明确报错**，而不是静默退化 ——
 * 静默退化会让"这次到底跑在哪"变得不可判定。
 */
export function createThinHostRuntime(options: ThinHostFactoryOptions): AgentRuntime {
  /*
   * ⚠️ **先做档位校验，再造宿主**（M12 · D2）。
   *   `CHARACTER_THIN_HOST=off` / 非法值 ⇒ 这里**抛错** ⇒ 进程**拒绝启动**。
   *   放在这里而不是调用点，是因为"造宿主"是唯一真正需要档位的地方 ——
   *   放调用点会漏掉别的入口（这正是 D2 要消除的"可选替换"）。
   */
  thinHostEnabled()

  const url = options.settings.POSTGRES_URL ?? process.env.POSTGRES_URL ?? ''
  const dataDir = options.settings.PGLITE_DATA_DIR ?? process.env.PGLITE_DATA_DIR ?? ''
  const backend = options.settings.CHARACTER_DB_BACKEND ?? process.env.CHARACTER_DB_BACKEND ?? ''

  /*
   * ⚠️⚠️ 2026-10-18 **修正一个过严的判断**。
   *
   * 第一版这里写的是"薄宿主只支持 PostgreSQL，PGlite 一律拒绝"，理由是
   * 「PGlite 是 plugin-sql 的嵌入式库，薄宿主不经它」。
   *
   * 那个理由**站不住**：`getRawDb()` 需要的只是 `{ execute(query) }` 形状的句柄，
   * 而 drizzle 的 `drizzle-orm/pglite` 与 `drizzle-orm/node-postgres` **提供的是同一个接口**。
   * 真正不能做的是"偷偷回落"——那会让"这次到底跑在哪个库上"不可判定。
   *
   * 代价是实测出来的：`pnpm cli:exit:verify`（只读门，跑在 PGlite 沙箱上）
   * 在薄宿主下**起不来** ⇒ 报「薄宿主只支持 PostgreSQL 后端」。
   * ⇒ 只读命令 / 沙箱实验被迫留在旧宿主上，那等于**没有换干净**。
   *
   * 现在的做法：按后端显式二选一，**两个都给真句柄，不做回落**；
   * 两个都不成立时**具名失败**（不说"不支持 PGlite"这种半真话）。
   */
  let pool: { query: (t: string, v?: unknown[]) => Promise<unknown>; end?: () => Promise<void>; ended?: boolean }
  /*
   * ⚠️ 驱动**按后端选**（2026-10-19 实测修）：之前两种后端都走
   *    `drizzle-orm/node-postgres` ⇒ PGlite 分支**必然**炸
   *    （`Cannot read properties of undefined (reading 'dialect')`）。
   *    ⚠️ 这个洞之前一直藏着：**所有薄宿主门都跑在 PostgreSQL 上**，
   *    PGlite 分支从来没有被真的连过一次。
   */
  let makeDb: ((handle: unknown) => unknown) | undefined
  if (url !== '') {
    // 生产 PG 池：与旧宿主同量级（plugin-sql 的 pg.Pool 缺省 max=10）
    pool = new pg.Pool({ connectionString: url, max: 10 })
    makeDb = (handle) => drizzlePg(handle as never)
  } else if (backend === 'pglite' && dataDir !== '') {
    // PGlite：与旧宿主同一条路径（plugin-sql 也是这么建 PGlite 的）
    const pglite = new PglitePool(dataDir)
    pool = pglite
    // ⚠️ `drizzle-orm/pglite` 要的是**原始 PGlite 客户端**（不是池包装）
    makeDb = (handle) => drizzlePglite((handle as PglitePool).rawClient() as never)
  } else {
    throw new Error(
      '[thin-host] 没有可用的数据库连接。\n' +
        `  CHARACTER_DB_BACKEND=${backend === '' ? '(未设置)' : backend}` +
        ` · POSTGRES_URL=${url === '' ? '(空)' : '(有)'}` +
        ` · PGLITE_DATA_DIR=${dataDir === '' ? '(空)' : '(有)'}\n` +
        '  需要二者之一：postgres（给 POSTGRES_URL）或 pglite（给 PGLITE_DATA_DIR）。\n' +
        '  （本次没有改动任何数据。）'
    )
  }

  const host = new ThinHostRuntime({
    character: options.character,
    // ⚠️ **按上游同款规则推导**（`character.id` 优先）—— 见 `resolveAgentId` 的说明：
    //   传不同的值会与历史 197 条 memories 的 `agent_id` 分裂。
    agentId: resolveAgentId(options.character, options.agentId),
    settings: options.settings,
    pool: pool as never,
    logger: thinLogger(),
    makeDb: makeDb as never,
  })
  setActiveHostKind('thin')
  // ⚠️ 类型标注是上游 `AgentRuntime`，靠**结构兼容**通过 —— 这就是"换实现不换接口"。
  //    调用点（51 处）因此一行不改。
  return host as unknown as AgentRuntime
}

/** PGlite 客户端的最小形状（我们只用到这几个成员） */
interface PgliteClient {
  query: (t: string, v?: unknown[]) => Promise<unknown>
  waitReady: Promise<void>
  close: () => Promise<void>
}

/**
 * PGlite 连接池 —— 与 `getRawDb()` 需要的形状对齐。
 *
 * ⚠️ **不用** `@electric-sql/pglite` 直接 import：它只是 `plugin-sql` 的传递依赖，
 *    本仓库没有直接声明（pnpm 严格依赖隔离 ⇒ 直接 import 会 ERR_MODULE_NOT_FOUND）。
 *    因此这里用**全仓唯一一份**的解析逻辑（内部按 plugin-sql 的**同一份**解析），
 *    避免装出第二个 PGlite 实例
 *    （两个实例指向同一个目录会互相损坏 —— 这正是 `src/dev/sandbox.ts` 记的进程级单例坑）。
 *
 * ⚠️⚠️ **这里曾经是一个真 bug**（2026-10-19 实测发现并修）：
 *   旧写法是 `createRequire(import.meta.url).resolve('@electric-sql/pglite')` ——
 *   它的注释声称"按 plugin-sql 的**同一份**解析"，**但代码并没有**那么做。
 *   实测：`@electric-sql/pglite` 不是本仓库的直接依赖（pnpm 严格隔离）
 *   ⇒ 那条解析**必然** MODULE_NOT_FOUND ⇒ 薄宿主的 PGlite 分支**根本起不来**。
 *   之前没暴露，是因为所有薄宿主门都跑在 **PostgreSQL** 后端上。
 */
class PglitePool {
  private raw: PgliteClient | undefined
  private clientPromise: Promise<unknown> | undefined
  private closed = false

  constructor(private readonly dataDir: string) {}

  /**
   * **原始** PGlite 客户端 —— `drizzle-orm/pglite` 要的是它（不是池包装）。
   *
   * ⚠️ 同步创建：PGlite 的构造器是同步的，`waitReady` 只在**查询**前需要等。
   *   drizzle 的 pglite 驱动会自己调 `client.query(...)`，由那条路径等 ready。
   */
  rawClient(): PgliteClient {
    if (this.raw === undefined) {
      const requireFromHere = createRequire(import.meta.url)
      const resolved = resolvePgliteEntry()
      const mod = (requireFromHere(resolved) as { PGlite: new (d: string) => unknown }).PGlite
      this.raw = new mod(this.dataDir) as PgliteClient
    }
    return this.raw
  }

  private async client(): Promise<{
    query: (t: string, v?: unknown[]) => Promise<unknown>
    close: () => Promise<void>
  }> {
    if (this.clientPromise === undefined) {
      const c = this.rawClient()
      this.clientPromise = (async () => {
        await c.waitReady
        return c
      })()
    }
    return this.clientPromise as Promise<{
      query: (t: string, v?: unknown[]) => Promise<unknown>
      close: () => Promise<void>
    }>
  }

  async query(text: string, values?: unknown[]): Promise<unknown> {
    const c = await this.client()
    return c.query(text, values as never[])
  }

  async end(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const c = await this.client()
    await c.close()
  }

  get ended(): boolean {
    return this.closed
  }
}

/** 当前进程实际在用的宿主（日志与读数都要靠它，不能猜） */
export function currentHostLabel(): string {
  return activeHostKind() === 'thin' ? 'thin-host' : 'elizaos'
}
