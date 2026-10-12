/**
 * M10.1 WP2b —— **装配好的约定慢路径**（`main.ts` 只调这一个函数）。
 *
 * ============================================================================
 *  为什么要有这一层（照 M11 的 `reflection-runtime.ts`）
 * ============================================================================
 * ```text
 * 调度器要三个端口（账本边界 / 窗口读 / 真正干活）—— 把它们的**接线**写在这里一次，
 * 于是 `main.ts` 只负责"在对的时机调一次"，而 `m10.1:agreement:verify` 可以传**自己的端口**
 * 去驱动**同一个**调度器。
 * ⚠️ 两个调用点各接一遍 = 迟早漂移的一处。
 * ```
 */

import type { CharacterId } from '../../kernel/contracts/ids.ts'
import type { LateWriteFence } from '../../kernel/app/reflection/late-write-fence.ts'
import { latestAgreementSequence, readAgreementWindowEntries } from '../persistence/agreement-input-source.ts'
import { AGREEMENT_PROCESSOR_VERSION, maybeRunAgreementEvaluation, recoverRunningAgreementJobs, type AgreementSchedulerOutcome } from './agreement-scheduler.ts'
import { runAgreementWindow } from './agreement-runner.ts'
import type { AgreementDraftProvider } from '../model/openai-agreement-understanding.ts'
import type { RawDb } from '../persistence/db.ts'
import { AGREEMENT_MAX_WINDOW_INPUTS } from '../../kernel/contracts/agreement-input.ts'

export interface RunConfiguredAgreementInput {
  readonly characterId: CharacterId
  readonly activeUserId: string
  readonly enabled: boolean
  readonly provider: AgreementDraftProvider
  readonly fence: LateWriteFence
  readonly signal: AbortSignal
  /** 撤销集（被遗忘的正文不进模型）；缺省空集 */
  readonly withdrawnEventIds?: ReadonlySet<string>
  readonly now?: number
  readonly recover?: boolean
}

export async function runConfiguredAgreementTail(
  db: RawDb,
  input: RunConfiguredAgreementInput
): Promise<AgreementSchedulerOutcome> {
  if (input.fence.closed || input.signal.aborted) return { kind: 'cancelled', watermark: 0 }
  /* ⚠️ **开关关 ⇒ 一个端口都不动**（与 M11 的"关着时什么都不发生"同一条纪律） */
  if (!input.enabled) return { kind: 'disabled' }
  if (input.recover) await recoverRunningAgreementJobs(db, input.characterId, input.now, input.fence)

  const withdrawn = input.withdrawnEventIds ?? new Set<string>()
  return maybeRunAgreementEvaluation(db, {
    characterId: input.characterId,
    processorVersion: AGREEMENT_PROCESSOR_VERSION,
    /* 首次 cutover：把边界预置成**此刻**的账本序号（`D33`：不回判历史） */
    cutoverSequence: await latestAgreementSequence(db, input.characterId),
    fence: input.fence,
    ...(input.now === undefined ? {} : { now: input.now }),
    ports: {
      latestSequence: () => latestAgreementSequence(db, input.characterId),
      readWindow: (from, latest) =>
        readAgreementWindowEntries(
          db,
          input.characterId,
          from,
          latest,
          AGREEMENT_MAX_WINDOW_INPUTS,
          withdrawn
        ),
      run: (window) =>
        runAgreementWindow(db, {
          characterId: input.characterId,
          activeUserId: input.activeUserId,
          entries: window.entries,
          provider: input.provider,
          signal: input.signal,
          fence: input.fence,
          now: input.now ?? Date.now(),
          proposalIdPrefix: 'agreement-worker',
        }),
    },
  })
}
