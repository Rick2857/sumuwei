/**
 * 世界模型 → **任务环核对链**的接线（2026-10-21 · 认知能力建设计划 P2 第 3 步）
 *
 * ============================================================================
 *  它解决什么
 * ============================================================================
 *  集成架构 §5 记的那条差距：
 *
 *      「EBL 工具消费 …… 可用时记录 use 并返回 `predictionChanged`
 *        | 把实际可用规则送入世界模型构造与预测；
 *          **当前返回值只被任务循环计数，没有进入独立预测器输入**。」
 *
 *  ⇒ 本文件让**世界模型的预期**真正进入**既有的核对链**：
 *    它实现**既有的** `ActionForecastPort` ⇒ 任务环照旧取预测、照旧核对、
 *    照旧把"被反驳"记进 `comparisons` —— 但预测的**内容**换成了
 *    "受限转移模型算出来的预期"，而不是某个模型编的一句话。
 *
 * ============================================================================
 *  三条不许破的边界
 * ============================================================================
 * ① **预测不扩权**：本端口仍然只**读**（账本 + EBL 快照），
 *    仍然拿不到授权集合、参数与执行器 ⇒ 它**不能**让任何动作发生。
 * ② **端口的读面是它自己的**：「既有内容预算允许的读回事实」是契约明确允许的
 *    （见 `action-forecast.ts` 的边界 ②）⇒ 端口读账本是**合规**的，
 *    而**不是**把参数塞进预测输入面。
 * ③ **绑定材料必须跟着结论走**：模型版本 / 规则版本 / 规则依赖 / 参数绑定摘要
 *    全部进预测 ⇒ 比较结论才能说清"是哪一版模型、哪条规则、哪个对象"。
 * ============================================================================
 */

import type { ActionForecast, ActionForecastStep } from '../../kernel/contracts/world-model.ts'
import type {
  ActionForecastInput,
  ActionForecastOutcome,
  ActionForecastPort,
} from '../../kernel/action/action-forecast.ts'
import { parameterBindingDigestOf } from '../../kernel/action/action-forecast.ts'
import type { CharacterId } from '../../kernel/contracts/ids.ts'
import type { RawDb } from '../persistence/db.ts'
import { createActionLedgerStore } from '../action/action-ledger-store.ts'
import { createEblRuleSnapshotPort } from './ebl-rule-snapshot.ts'
import { selectUsableRules } from '../../kernel/contracts/cognitive-collaboration.ts'
import { buildTransitionRule } from './world-model-transition.ts'
import { interpretTransition, type ObservedActionFact, type ObservedTransitionState } from '../../kernel/contracts/world-model-transition.ts'

/** 读可见状态（动作事实）所需的最小读面 */
export interface WorldModelForecastOptions {
  db: RawDb
  characterId: CharacterId
  activeUserId: string
  /** **模型版本**（比较结论要能回答"比的是哪一版模型"） */
  modelVersion: string
  /** 可见状态里的环境事实（例：`{ encoding: 'utf8' }`）；**不知道就不要给** */
  facts?: Readonly<Record<string, string>>
  /** 读回事实的上限（预算纪律：端口只看得到有限的事实） */
  maxFacts?: number
}

/** 从账本读"真发生过的事"（路径 + 内容指纹） */
export async function readObservedState (
  db: RawDb,
  characterId: CharacterId,
  limit: number
): Promise<ObservedTransitionState> {
  const ledger = createActionLedgerStore(db)
  const records = await ledger.listRecords({ characterId, limit })
  const actions: ObservedActionFact[] = []
  for (const record of [...records].reverse()) {
    const path = record.target?.canonicalId
    const fingerprint = record.effect?.fingerprint
    actions.push({
      actionId: String(record.actionId),
      capability: record.capability,
      operation: record.operation,
      status: String(record.status),
      effects: {
        ...(path === undefined ? {} : { path }),
        ...(fingerprint === undefined ? {} : { contentFingerprint: fingerprint }),
      },
    })
  }
  return { actions, facts: {} }
}

/**
 * 建一个由**受限转移模型**驱动的预测端口。
 *
 * ⚠️ 它**只**为"读回"这一种动作产出预测（当前唯一的受信解释器）；
 *    其余动作 ⇒ **不产出预测**（⇒ 任务环照旧走，行为逐字不变）。
 */
export function createWorldModelForecastPort (options: WorldModelForecastOptions): ActionForecastPort {
  const limit = options.maxFacts ?? 50
  return {
    id: 'world-model-transition',
    endpointHost: 'offline',
    async forecast (input: ActionForecastInput): Promise<ActionForecastOutcome> {
      const observed = await readObservedState(options.db, options.characterId, limit)
      const withFacts: ObservedTransitionState = { actions: observed.actions, facts: options.facts ?? {} }

      // 规则：只从**当前合格**的命题里选
      const snapshotPort = createEblRuleSnapshotPort(options.db, options.characterId, options.activeUserId)
      const snapshots = await snapshotPort.list()
      const selection = selectUsableRules({
        snapshots,
        visible: {
          subjectId: options.activeUserId,
          scope: 'sandbox_readback',
          environment: 'sandbox-filesystem@1',
          conditions: options.facts ?? {},
        },
      })

      const steps: ActionForecastStep[] = []
      const planStepIndices: number[] = []
      /*
       * 候选对象：账本里**有写入效果**的那些（路径 + 内容指纹）。
       * ⇒ 端口先按**摘要**挑出"这次要绑定的是哪个对象"，再让解释器算预期。
       */
      const writtenPaths = [...new Set(
        withFacts.actions
          .filter(action => action.capability === 'sandbox.file.write' && action.operation === 'write' && action.status === 'success' && action.effects.path !== undefined && action.effects.contentFingerprint !== undefined)
          .map(action => String(action.effects.path)),
      )]
      for (const [planStepIndex, candidate] of input.candidateSteps.entries()) {
        if (candidate.capability !== 'sandbox.file.read') continue
        /*
         * ⚠️ **绑定**：这一轮预测绑定的是**哪个对象**？
         *    任务环给的是**摘要**（哈希）⇒ 端口按**同一口径**重算账本里各次写入的摘要，
         *    挑出**对得上**的那一个 ⇒ 预期就不会套到别的对象上。
         */
        const wanted = input.targetBindings?.[planStepIndex]
        if (wanted === undefined || wanted.capability !== candidate.capability || wanted.operation !== candidate.operation) continue
        const stepsBefore = steps.length
        for (const path of writtenPaths) {
          const bindingDigest = parameterBindingDigestOf(candidate.capability, candidate.operation, `path=${path}`)
          // 任务环要的摘要与端口重算的摘要必须**一致**（同一口径）⇒ 对不上就不给预测
          if (wanted.bindingDigest !== bindingDigest) continue
          for (const snapshot of selection.selected) {
            const translation = buildTransitionRule(snapshot)
            if (!('rule' in translation)) continue
            const rule = translation.rule
            const outcome = interpretTransition({
              rule,
              observed: withFacts,
              action: {
                capability: candidate.capability,
                operation: candidate.operation,
                arguments: { path },
                subjectId: options.activeUserId,
              },
            })
            if (outcome.kind !== 'expected' || outcome.expectation === undefined) continue
            steps.push({
              capability: candidate.capability,
              operation: candidate.operation,
              expectedVisibleOutcome: `读回的内容与写入的一致（指纹 ${outcome.expectation.expectedFingerprint.slice(0, 12)}…）`,
              check: { kind: 'effect_fingerprint_matches', expectedFingerprint: outcome.expectation.expectedFingerprint },
              uncertainty: 'low',
              dependsOn: [],
              parameterBindingDigest: bindingDigest,
              /*
               * ⚠️ 依赖带**版本与指纹**（不只命题 id）：规则失效后要能认出
               *    「失效的是不是同一条规则的同一版」⇒ 派生模型与待执行计划才拒用得了。
               */
              ruleDependencies: [{
                claimId: snapshot.claimId,
                ruleVersion: snapshot.ruleVersion,
                evidenceFingerprint: snapshot.evidenceFingerprint,
              }],
              ruleVersion: snapshot.ruleVersion,
            })
            /*
             * ⚠️ **计划步下标**必须一起给：预测的步骤可以只是计划的一个**子集**
             *    （这里只预测"读"这一步）⇒ 任务环靠它把预测对齐回计划。
             */
            planStepIndices.push(planStepIndex)
            break
          }
          if (steps.length > stepsBefore) break
        }
      }
      if (steps.length === 0) {
        /*
         * ⚠️ 「没有适用的规则」**不是**故障：任务照旧走（行为逐字不变），
         *    只是这一轮**没有**核对 ⇒ 用具名的失败码说出来，
         *    别混进 `call_failed`（那会像"模型坏了"）。
         */
        return { ok: false, failure: 'no_applicable_rule', requestCount: 1 }
      }
      const forecast: ActionForecast = {
        producedAt: Date.now(),
        inputRevision: input.inputRevision,
        modelVersion: options.modelVersion,
        budgetCost: 1,
        steps,
        planStepIndices,
      }
      return { ok: true, forecast, requestCount: 1 }
    },
  }
}
