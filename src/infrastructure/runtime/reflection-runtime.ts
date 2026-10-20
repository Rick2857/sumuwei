import type { CharacterId } from '../../kernel/contracts/ids.ts'
import type { ReflectionDraftProvider } from '../../kernel/app/reflection/draft-port.ts'
import type { LateWriteFence } from '../../kernel/app/reflection/late-write-fence.ts'
import { REFLECTION_MAX_WINDOW_INPUTS } from '../../kernel/contracts/reflection-input.ts'
import type { RawDb } from '../persistence/db.ts'
import { latestDomainEventSequence, readReflectionWindowEvents } from '../persistence/reflection-input-source.ts'
import { createReflectionComparisonSource } from '../persistence/reflection-comparison-source.ts'
import { invalidateReflectionSources } from './reflection-invalidation.ts'
import { REFLECTION_PROCESSOR_VERSION, runReflectionWindow } from './reflection-runner.ts'
import { maybeRunReflectionEvaluation, recoverRunningReflectionJobs } from './reflection-scheduler.ts'

/** Shared by the application's open/turn hooks and isolated acceptance runs. */
export async function runConfiguredReflectionTail(db: RawDb, input: {
  characterId: CharacterId; activeUserId: string; reflectionEnabled: boolean; adaptiveEnabled: boolean
  provider: ReflectionDraftProvider; fence: LateWriteFence; signal: AbortSignal; recover?: boolean; now?: number
  /**
   * 三域应用方案 §4：**比较材料**（缺省 ⇒ 没有；关着时输入与 prompt **逐字节**与今天相同）。
   */
  outcomeComparisonEnabled?: boolean
}) {
  if (input.fence.closed || input.signal.aborted || (!input.reflectionEnabled && !input.adaptiveEnabled)) return null
  if (input.recover) await recoverRunningReflectionJobs(db, input.characterId, input.now, input.fence)
  const invalidated = await invalidateReflectionSources(db, input.characterId, input.fence, input.activeUserId)
  if (!input.reflectionEnabled || input.fence.closed) return { invalidated, scheduling: null }
  const scheduling = await maybeRunReflectionEvaluation(db, {
    characterId: input.characterId, processorVersion: REFLECTION_PROCESSOR_VERSION,
    cutoverSequence: await latestDomainEventSequence(db, input.characterId), fence: input.fence, now: input.now,
    ports: {
      latestSequence: () => latestDomainEventSequence(db, input.characterId),
      readWindow: (from, latest) => readReflectionWindowEvents(db, input.characterId, from, latest, REFLECTION_MAX_WINDOW_INPUTS),
      run: window => runReflectionWindow(db, {
        characterId: input.characterId, activeUserId: input.activeUserId, watermark: window.fromSequence, throughSequence: window.toSequence,
        eligibleDomainEventIds: window.eligible.map(event => event.id),
        provider: input.provider, adaptiveEnabled: input.adaptiveEnabled, fence: input.fence, signal: input.signal,
        /*
         * 三域应用方案 §4：比较材料（**辅助解释**，不是证据）。
         * ⚠️ 缺省 ⇒ 这一行不存在 ⇒ 反思的输入与 prompt 逐字节与今天相同。
         * ⚠️ 给的是**工厂**：二次来源复核发生在事务内，必须绑到**那一笔事务**的句柄
         *    （用事务外的句柄 ⇒ 单连接后端上死锁，见 reflection-runner.ts 的说明）。
         */
        ...(input.outcomeComparisonEnabled === true
          ? {
              comparisonSource: (db: RawDb) =>
                createReflectionComparisonSource(db, {
                  characterId: input.characterId,
                  activeUserId: input.activeUserId,
                }),
            }
          : {}),
      }),
    },
  })
  return { invalidated, scheduling }
}
