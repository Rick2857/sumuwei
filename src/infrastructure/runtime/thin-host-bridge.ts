/**
 * 宿主桥 —— 让"换实现不换接口"这件事**可执行**。
 *
 * ============================================================================
 *  为什么需要它
 * ============================================================================
 * `src/main.ts` 等调用点拿到的类型是 `AgentRuntime`（来自 `@elizaos/core`）。
 * 如果直接把 `ThinHostRuntime` 塞进去，TypeScript 会因为类型不兼容而
 * 要求改**每一个**调用点 —— 那就不是"换实现"了，是重写。
 *
 * 桥的职责只有一个：**在类型边界上做结构兼容**，让调用点一行不改。
 * 它不新增行为、不吞错误、不做 fallback（fallback 到 ElizaOS 会让
 * "这次到底跑的是哪个宿主"变得不可判定 —— 那是更难查的问题）。
 *
 * ⚠️ 刻意**不**做自动回退：如果薄宿主抛错，就让它抛。
 *    "出问题时静默换回旧宿主"会让线上读数无法归因，也会掩盖真实缺陷。
 */

import { ThinHostRuntime, type ThinHostOptions } from './thin-host.ts'

/**
 * 薄宿主对调用点呈现的最小面。
 *
 * 只列 LG **实际**用到的方法 —— 每多列一个，就多一份"将来上游加了方法时
 * 这里会静默失效"的风险。
 */
export interface HostLike {
  readonly agentId: string
  readonly events: Record<string, ((payload: unknown) => void)[]>
  adapter: unknown
  settings: Record<string, string>
  logger: ThinHostOptions['logger']
  character: { name: string; id?: string }

  initialize(): Promise<unknown>
  stop(): Promise<void>
  registerPlugin(plugin: unknown): Promise<void>
  runPluginMigrations(): Promise<never>
  useModel(modelType: string, params: Record<string, unknown>): Promise<unknown>
  getMemories(options: {
    tableName?: string
    roomId?: string
    entityId?: string
    agentId?: string
    count?: number
  }): Promise<unknown[]>
  createMemory(memory: unknown, tableName: string, unique?: boolean): Promise<unknown>
  ensureEntity(input: { id: string; names?: string[]; agentId?: string; metadata?: unknown }): Promise<void>
  ensureRoomExists(input: {
    id: string
    name?: string
    source?: string
    type?: string
    worldId?: string
  }): Promise<void>
  ensureParticipantInRoom(entityId: string, roomId: string): Promise<void>
  composeState(input: unknown): Promise<never>
}

/** 当前进程用的是哪个宿主 —— 读数与告警都要靠它，不能靠"猜" */
export type HostKind = 'elizaos' | 'thin'

let activeHost: HostKind = 'elizaos'

export function activeHostKind(): HostKind {
  return activeHost
}

export function setActiveHostKind(kind: HostKind): void {
  activeHost = kind
}

/** 构造一个满足 `HostLike` 的薄宿主 */
export function createThinHost(options: ThinHostOptions): ThinHostRuntime {
  setActiveHostKind('thin')
  return new ThinHostRuntime(options)
}
