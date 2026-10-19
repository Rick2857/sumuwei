/**
 * "重新打开同一个库" —— 用于验证**跨进程连续性**。
 *
 * ============================================================================
 *  为什么这不是普通的重启
 * ============================================================================
 * SC-001 与 SC-005 都要问同一个问题："换一个进程，她还在吗？"
 *
 * 这里刻意**复用当前进程已经隔离好的数据目录**（`PGLITE_DATA_DIR`），
 * 而不是新建一个沙箱：只有真正打开同一个目录，才能证明
 * "状态是落库的"而不是"在内存里活着"。
 *
 * 安全：数据目录来自 `isolateDatabase()` 的沙箱，不是真实对话库；
 * 且本文件只做只读查询，不写任何事件。
 */

import type { Character } from '../../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../../src/infrastructure/runtime/thin-host-factory.ts'




import { character } from '../../src/character/index.ts'
import { initDatabase } from '../../src/db/index.ts'
import { initKernel, type KernelHandle } from '../../src/kernel/app/kernel.ts'
import { countConversationEvents } from '../../src/infrastructure/persistence/conversation-store.ts'
import { getProjection } from '../../src/infrastructure/persistence/event-store.ts'
import { DIAGNOSTIC_PROJECTION_TYPE, type DiagnosticState } from '../../src/kernel/projections/diagnostic.ts'
import { characterDefinitionFromCharacter } from '../../src/infrastructure/runtime/seed-projection.ts'
import { isProductionDir } from '../../src/dev/sandbox.ts'

export interface ReopenedKernel {
  kernel: KernelHandle
  countConversationEvents: () => Promise<number>
  diagnosticProjection: () => Promise<DiagnosticState | undefined>
  close: () => Promise<void>
}

export async function openKernelOnExistingDir(dataDirOverride?: string): Promise<ReopenedKernel> {
  const dir = dataDirOverride ?? process.env.PGLITE_DATA_DIR
  if (!dir) {
    throw new Error('没有可复用的数据目录：请先调用 isolateDatabase()')
  }
  if (isProductionDir(dir)) {
    throw new Error(`拒绝在真实对话库上做连续性实验：${dir}`)
  }

  const runtime = createThinHostRuntime({
    character: character,
    settings: {},
  })
  await initDatabase(runtime)
  await runtime.initialize()

  const kernel = await initKernel(runtime, { definition: characterDefinitionFromCharacter(character) })

  return {
    kernel,
    countConversationEvents: () => countConversationEvents(kernel.stores.db, kernel.characterId),
    diagnosticProjection: async () => {
      const projection = await getProjection<DiagnosticState>(
        kernel.stores.db,
        kernel.characterId,
        DIAGNOSTIC_PROJECTION_TYPE
      )
      return projection?.state
    },
    close: async () => {
      await runtime.stop()
    },
  }
}
