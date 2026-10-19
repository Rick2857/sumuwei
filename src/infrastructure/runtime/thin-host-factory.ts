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

import pg from 'pg'
import { createRequire } from 'node:module'

import type { AgentRuntime } from '@elizaos/core'

import { ThinHostRuntime, thinLogger } from './thin-host.ts'
import { setActiveHostKind, activeHostKind } from './thin-host-bridge.ts'

/**
 * 薄宿主开关（**缺省 off** —— 与仓库所有能力的缺省一致）。
 *
 * ⚠️ 缺省 off 的理由：这是一次**宿主替换**，不是加一个功能。
 *    缺省 on 等于让所有人无声地换掉底座。
 *    生产激活仍是独立授权动作（先例 ADR-048/065/067/071/112）。
 */
export const THIN_HOST_ENV = 'CHARACTER_THIN_HOST'

export function thinHostEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[THIN_HOST_ENV] ?? '').trim().toLowerCase()
  if (raw === '' || raw === '0' || raw === 'false' || raw === 'off') return false
  if (raw === '1' || raw === 'true' || raw === 'on') return true
  // ⚠️ 非法值**失败关闭**回 off：不让一个拼错的变量把生产宿主换掉。
  console.warn(`[thin-host] ${THIN_HOST_ENV}="${raw}" 不是合法值（on/off），按 off 处理`)
  return false
}

export interface ThinHostFactoryOptions {
  character: { name: string; id?: string }
  agentId: string
  settings: Record<string, string>
  conversationLength?: number
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
  if (url !== '') {
    // 生产 PG 池：与旧宿主同量级（plugin-sql 的 pg.Pool 缺省 max=10）
    pool = new pg.Pool({ connectionString: url, max: 10 })
  } else if (backend === 'pglite' && dataDir !== '') {
    // PGlite：与旧宿主同一条路径（plugin-sql 也是这么建 PGlite 的）
    pool = new PglitePool(dataDir)
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
    agentId: options.agentId,
    settings: options.settings,
    pool: pool as never,
    logger: thinLogger(),
  })
  setActiveHostKind('thin')
  // ⚠️ 类型标注是上游 `AgentRuntime`，靠**结构兼容**通过 —— 这就是"换实现不换接口"。
  //    调用点（51 处）因此一行不改。
  return host as unknown as AgentRuntime
}

/**
 * PGlite 连接池 —— 与 `getRawDb()` 需要的形状对齐。
 *
 * ⚠️ **不用** `@electric-sql/pglite` 直接 import：它只是 `plugin-sql` 的传递依赖，
 *    本仓库没有直接声明（pnpm 严格依赖隔离 ⇒ 直接 import 会 ERR_MODULE_NOT_FOUND）。
 *    因此这里用 `createRequire` 按 plugin-sql 的**同一份**解析，避免装出第二个 PGlite 实例
 *    （两个实例指向同一个目录会互相损坏 —— 这正是 `src/dev/sandbox.ts` 记的进程级单例坑）。
 */
class PglitePool {
  private clientPromise: Promise<unknown> | undefined
  private closed = false

  constructor(private readonly dataDir: string) {}

  private async client(): Promise<{
    query: (t: string, v?: unknown[]) => Promise<unknown>
    close: () => Promise<void>
  }> {
    if (this.clientPromise === undefined) {
      const requireFromHere = createRequire(import.meta.url)
      const resolved = requireFromHere.resolve('@electric-sql/pglite')
      const mod = (requireFromHere(resolved) as { PGlite: new (d: string) => unknown }).PGlite
      this.clientPromise = (async () => {
        const c = new mod(this.dataDir) as {
          query: (t: string, v?: unknown[]) => Promise<unknown>
          waitReady: Promise<void>
          close: () => Promise<void>
        }
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
