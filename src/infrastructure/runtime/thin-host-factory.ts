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
  if (url === '') {
    throw new Error(
      '[thin-host] 薄宿主只支持 PostgreSQL 后端，但 POSTGRES_URL 为空。\n' +
        '（PGlite 是 plugin-sql 的嵌入式库，薄宿主不经它 —— 请用真实 PostgreSQL。）'
    )
  }
  // 生产 PG 池：与旧宿主同量级（plugin-sql 的 pg.Pool 缺省 max=10）
  const pool = new pg.Pool({ connectionString: url, max: 10 })
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

/** 当前进程实际在用的宿主（日志与读数都要靠它，不能猜） */
export function currentHostLabel(): string {
  return activeHostKind() === 'thin' ? 'thin-host' : 'elizaos'
}
