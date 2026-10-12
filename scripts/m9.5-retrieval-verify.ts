/**
 * M9.5 WP6（可判定前置）—— **通道登记、R3 伪启用、D26 相对间隔门**（`pnpm m9.5:retrieval:verify`）。
 *
 * ============================================================================
 *  它先把 WP6 的**三条硬边界**变成机器判据（实现接线之前就该有的那部分）
 * ============================================================================
 * ```text
 * ① **通道登记**：`semantic` 已是一等通道，且登记表**如实**说它今天没有生产者
 *    （`produced: false` + `blocker` 写明缺什么）。既有 5 个通道的含义与 produced 状态**一字未改**。
 * ② **R3 / D26-④ 伪启用**：`available === true` 而**没有真实分数** ⇒ 判 `missing_score`（不可用）。
 *    这条堵的是"永不参与、却在 trace 里看起来已启用"的通道 —— 正负控都测不出来的那种。
 * ③ **D26 禁止绝对阈值**：模块里**不存在**绝对余弦阈值常量；
 *    并用 WP1 的实测余弦**演示**为什么：负控头名 0.8284 会被 "≥0.8" 接受，
 *    而"头名−次名"这个量在负控上只有 **0.0004**（几乎并排）⇒ 相对间隔才分得开。
 * ```
 * 全部是**纯函数**判据（无数据库、无模型、无网络）。
 *
 * 用法：`pnpm m9.5:retrieval:verify`
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  RECALL_CHANNELS,
  RECALL_CHANNEL_FACTS,
  RESERVED_RECALL_CHANNELS,
  isRecallChannel,
} from '../src/kernel/contracts/recall.ts'
import {
  DEFAULT_RETRIEVAL_POLICY_VERSION,
  RETRIEVAL_POLICY_VERSIONS,
  WP1_BRIDGE_READINGS,
  absoluteThresholdWouldAccept,
  isRetrievalPolicyVersion,
  relativeMarginOf,
  semanticParticipates,
  semanticSignalOf,
} from '../src/kernel/app/recall/semantic-signal.ts'
import {
  PROVISIONAL_HYBRID_POLICY,
  mergeChannelHits,
  orderCandidates,
  truncateCandidates,
  type OrderableCandidate,
} from '../src/kernel/app/recall/hybrid-candidates.ts'

import { sha256 } from './m4-harness.ts'
import { dirtyPaths, sourceTreeReading } from './m6.1-run-manifest.ts'
import {
  createM95RunId,
  openM95RunDir,
  runIdFromM95OutPath,
  selfCheckMeasurement,
  writeM95Manifest,
} from './m9.5-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const STARTED_AT = new Date().toISOString()
const GATE_VERSION = 'm9.5-retrieval@1'

interface Probe {
  readonly id: string
  readonly question: string
  readonly verdict: 'ok' | 'unexpected'
  readonly reading: Record<string, unknown>
  readonly error: string | null
}

function probe(input: {
  readonly id: string
  readonly question: string
  readonly run: () => Record<string, unknown>
  readonly judge?: (reading: Record<string, unknown>) => string[]
}): Probe {
  try {
    const reading = input.run()
    const problems = input.judge?.(reading) ?? []
    return {
      id: input.id,
      question: input.question,
      verdict: problems.length > 0 ? 'unexpected' : 'ok',
      reading,
      error: problems.length > 0 ? problems.join('; ') : null,
    }
  } catch (error) {
    return {
      id: input.id,
      question: input.question,
      verdict: 'unexpected',
      reading: {},
      error: (error as Error).message.replace(/\s+/g, ' ').slice(0, 240),
    }
  }
}

function gitOrNull(args: readonly string[]): string | null {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function main(): void {
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: 'wp6-retrieval', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const probes: Probe[] = []

  /* ---- ① 通道登记 ---- */
  probes.push(
    probe({
      id: 'semantic-channel-registered',
      question: '`semantic` 是一等通道，且登记表**如实**说它今天没有生产者',
      run: () => ({
        channels: [...RECALL_CHANNELS],
        isChannel: isRecallChannel('semantic'),
        fact: RECALL_CHANNEL_FACTS.semantic,
        reserved: [...RESERVED_RECALL_CHANNELS],
        channelCount: RECALL_CHANNELS.length,
      }),
      judge: (reading) => {
        const problems: string[] = []
        if (reading.isChannel !== true) problems.push('semantic 未被识别为通道')
        if (Number(reading.channelCount) !== 6) problems.push(`通道数应为 6，实际 ${String(reading.channelCount)}`)
        const fact = reading.fact as { produced?: boolean; producer?: string; blocker?: string; semantics?: string }
        if (fact.produced !== false) {
          problems.push('semantic 的 produced 应为 false（WP6 未接线；登记表必须如实）')
        }
        if (typeof fact.blocker !== 'string' || fact.blocker.length === 0) {
          problems.push('produced=false 时必须写明 blocker（缺什么）')
        }
        /* D25 第 ④ 条必须出现在 blocker 里 —— 否则接线时最容易漏掉那条 */
        if (typeof fact.blocker === 'string' && !fact.blocker.includes('未实现')) {
          problems.push('blocker 必须包含 D25 第 ④ 条（"只标 available 视为未实现"）')
        }
        return problems
      },
    })
  )

  probes.push(
    probe({
      id: 'legacy-channels-unchanged',
      question: '纯追加：既有 5 个通道含义与 produced 状态**一字未改**（off 等价的前提）',
      run: () => ({
        produced: RECALL_CHANNELS.filter((channel) => RECALL_CHANNEL_FACTS[channel].produced),
        reserved: [...RESERVED_RECALL_CHANNELS],
      }),
      judge: (reading) => {
        const problems: string[] = []
        const produced = reading.produced as string[]
        if (JSON.stringify(produced) !== JSON.stringify(['subject', 'recency', 'lexical'])) {
          problems.push(`仍应只有 subject/recency/lexical 有生产者，实际 ${JSON.stringify(produced)}`)
        }
        const reserved = reading.reserved as string[]
        if (!reserved.includes('explicit_id') || !reserved.includes('canonical_key')) {
          problems.push('既有保留通道不得因本次追加而变化')
        }
        if (!reserved.includes('semantic')) problems.push('semantic 无生产者 ⇒ 应进保留清单')
        return problems
      },
    })
  )

  /* ---- ② R3：available 为真必须有真实分数 ---- */
  probes.push(
    probe({
      id: 'r3-available-requires-real-score',
      question: 'R3/D26-④：`available:true` 而没有真实分数 ⇒ 判 `missing_score`（堵住伪启用）',
      run: () => ({
        flagTrueNoScore: semanticSignalOf({ available: true }),
        flagTrueNan: semanticSignalOf({ available: true, score: Number.NaN }),
        flagTrueInfinity: semanticSignalOf({ available: true, score: Number.POSITIVE_INFINITY }),
        flagTrueRealScore: semanticSignalOf({ available: true, score: 0.87 }),
        flagFalseWithScore: semanticSignalOf({ available: false, score: 0.87 }),
      }),
      judge: (reading) => {
        const problems: string[] = []
        const noScore = reading.flagTrueNoScore as { kind: string; reason?: string }
        if (noScore.kind !== 'unavailable' || noScore.reason !== 'missing_score') {
          problems.push(`★ available=true 无分数必须判 missing_score，实际 ${JSON.stringify(noScore)}`)
        }
        for (const key of ['flagTrueNan', 'flagTrueInfinity']) {
          const item = reading[key] as { kind: string; reason?: string }
          if (item.kind !== 'unavailable' || item.reason !== 'non_finite_score') {
            problems.push(`${key} 应判 non_finite_score，实际 ${JSON.stringify(item)}`)
          }
        }
        const ok = reading.flagTrueRealScore as { kind: string; score?: number }
        if (ok.kind !== 'available' || ok.score !== 0.87) problems.push('有真实分数时应可用')
        const falseFlag = reading.flagFalseWithScore as { kind: string; reason?: string }
        if (falseFlag.kind !== 'unavailable') problems.push('available=false 时应不可用')
        return problems
      },
    })
  )

  probes.push(
    probe({
      id: 'r3-named-unavailable-reasons',
      question: 'D26-④：`not_indexed / model_missing / dimension_mismatch / timeout / generation_mismatch` **各自具名**',
      run: () => ({
        notIndexed: semanticSignalOf({ available: false }),
        modelMissing: semanticSignalOf({ available: true, score: 0.9, modelPresent: false }),
        dimensionMismatch: semanticSignalOf({ available: true, score: 0.9, indexDimension: 383, modelDimension: 384 }),
        timeout: semanticSignalOf({ available: true, score: 0.9, timedOut: true }),
        generationMismatch: semanticSignalOf({ available: true, score: 0.9, generationMatches: false }),
      }),
      judge: (reading) => {
        const problems: string[] = []
        const expected: Record<string, string> = {
          notIndexed: 'not_indexed',
          modelMissing: 'model_missing',
          dimensionMismatch: 'dimension_mismatch',
          timeout: 'timeout',
          generationMismatch: 'generation_mismatch',
        }
        for (const [key, reason] of Object.entries(expected)) {
          const item = reading[key] as { kind: string; reason?: string }
          if (item.kind !== 'unavailable' || item.reason !== reason) {
            problems.push(`${key} 应判 ${reason}，实际 ${JSON.stringify(item)}`)
          }
        }
        return problems
      },
    })
  )

  /* ---- ③ D26：禁止绝对阈值 + 相对间隔才是信号 ---- */
  probes.push(
    probe({
      id: 'd26-no-absolute-threshold-constant',
      question: 'D26：模块里**不存在**绝对余弦阈值常量（免得将来被"顺手加一个"）',
      run: () => {
        const source = readFileSync(join(REPO_ROOT, 'src/kernel/app/recall/semantic-signal.ts'), 'utf8')
        /* 找出所有"像阈值"的常量声明 */
        const suspicious = [...source.matchAll(/(?:const|export const)\s+([A-Z0-9_]*THRESHOLD[A-Z0-9_]*)/g)].map(
          (match) => match[1] as string
        )
        const cosineConstants = [...source.matchAll(/(?:const|export const)\s+([A-Za-z0-9_]*COSINE[A-Za-z0-9_]*)/g)].map(
          (match) => match[1] as string
        )
        return { suspiciousThresholdConstants: suspicious, cosineConstants }
      },
      judge: (reading) => {
        const problems: string[] = []
        if ((reading.suspiciousThresholdConstants as string[]).length > 0) {
          problems.push(`出现阈值常量：${(reading.suspiciousThresholdConstants as string[]).join(',')}（D26 禁止绝对阈值）`)
        }
        if ((reading.cosineConstants as string[]).length > 0) {
          problems.push(`出现余弦常量：${(reading.cosineConstants as string[]).join(',')}`)
        }
        return problems
      },
    })
  )

  probes.push(
    probe({
      id: 'd26-absolute-threshold-would-misfire',
      question: 'D26 的必要性演示：用 WP1 实测余弦，"≥0.8" 会接受负控，而"头名−次名"分得开',
      run: () => {
        const perQuery = Object.fromEntries(
          Object.entries(WP1_BRIDGE_READINGS).map(([id, scores]) => [id, relativeMarginOf(scores)])
        )
        const negative = perQuery['q-e-negative-control'] as { margin: number; topScore: number }
        const targets = ['q-a', 'q-b', 'q-c', 'q-d'].map(
          (id) => (perQuery[id] as { margin: number; topScore: number }).margin
        )
        return {
          perQuery,
          negativeMargin: negative.margin,
          negativeTopScore: negative.topScore,
          targetMargins: targets,
          acceptedByAbsolute08: {
            'q-e-negative-control': absoluteThresholdWouldAccept(WP1_BRIDGE_READINGS['q-e-negative-control'] as never, 0.8),
          },
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        /* 负控：几乎并排 ⇒ margin 极小 */
        if (!(Number(reading.negativeMargin) < 0.01)) {
          problems.push(`负控的 margin 应极小（几乎并排），实际 ${String(reading.negativeMargin)}`)
        }
        /* 有目标的四条：margin 明显更大 */
        const targets = reading.targetMargins as number[]
        if (!targets.every((margin) => margin > 0.01)) {
          problems.push(`有目标问句的 margin 应 > 0.01，实际 ${JSON.stringify(targets)}`)
        }
        /* "≥0.8" 会把负控全部接受进来 —— 这正是 D26 存在的理由 */
        const accepted = (reading.acceptedByAbsolute08 as Record<string, string[]>)['q-e-negative-control'] as string[]
        if (accepted.length !== 3) {
          problems.push(`演示失效：绝对阈值 0.8 本应接受负控的全部 3 个候选，实际 ${JSON.stringify(accepted)}`)
        }
        /* 负控头名 0.8284 > 0.8 —— 数字本身要在案 */
        if (!(Number(reading.negativeTopScore) > 0.8)) {
          problems.push('负控头名应高于 0.8（这正是"绝对阈值会误触发"的证据）')
        }
        return problems
      },
    })
  )

  /* ---- ④ 策略版本与 off 等价 ---- */
  probes.push(
    probe({
      id: 'policy-versioning-and-off-equivalence',
      question: 'D25-③：策略版本化；缺省 = 现状；`off`/legacy 下语义**不参与**',
      run: () => ({
        versions: [...RETRIEVAL_POLICY_VERSIONS],
        defaultVersion: DEFAULT_RETRIEVAL_POLICY_VERSION,
        participates: {
          'lexical-recency@1': semanticParticipates('lexical-recency@1'),
          'hybrid-relevance@1': semanticParticipates('hybrid-relevance@1'),
        },
        rejectsUnknown: {
          on: isRetrievalPolicyVersion('on'),
          empty: isRetrievalPolicyVersion(''),
          good: isRetrievalPolicyVersion('hybrid-relevance@1'),
        },
      }),
      judge: (reading) => {
        const problems: string[] = []
        if (reading.defaultVersion !== 'lexical-recency@1') {
          problems.push(`缺省策略必须是现状（lexical-recency@1），实际 ${String(reading.defaultVersion)}`)
        }
        const participates = reading.participates as Record<string, boolean>
        if (participates['lexical-recency@1'] !== false) problems.push('legacy 策略下语义不得参与')
        if (participates['hybrid-relevance@1'] !== true) problems.push('新策略下语义应参与')
        const rejects = reading.rejectsUnknown as Record<string, boolean>
        if (rejects.on !== false || rejects.empty !== false) problems.push('未知策略名必须被拒（不得默认 on）')
        if (rejects.good !== true) problems.push('合法策略名应被接受')
        return problems
      },
    })
  )

  /* ---- ⑤ 合并 / 排序 / 截断（WP6 的机制，D25 的落地） ---- */
  probes.push(
    probe({
      id: 'merge-by-memory-id',
      question: '多通道命中**按 Memory ID 合并**（不是多条记忆、也不是多份证据）',
      run: () => {
        const merged = mergeChannelHits([
          { memoryId: 'mem:A', channel: 'subject' },
          { memoryId: 'mem:A', channel: 'lexical', score: 2 },
          { memoryId: 'mem:A', channel: 'recency' },
          { memoryId: 'mem:B', channel: 'subject' },
          { memoryId: 'mem:B', channel: 'lexical', score: 1 },
        ])
        return { count: merged.length, ids: merged.map((item) => item.memoryId), aChannels: merged[0]?.channels, aLexical: merged[0]?.channelScores.lexical }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (Number(reading.count) !== 2) problems.push(`5 次命中应合并成 2 条，实际 ${String(reading.count)}`)
        const channels = reading.aChannels as string[]
        if (JSON.stringify(channels) !== JSON.stringify(['lexical', 'recency', 'subject'])) {
          problems.push(`通道集合应去重且稳定，实际 ${JSON.stringify(channels)}`)
        }
        if (reading.aLexical !== 2) problems.push('同通道多次出现应取最大值')
        return problems
      },
    })
  )

  probes.push(
    probe({
      id: 'legacy-order-ignores-semantic',
      question: 'legacy 策略：只按新近度排序、**完全无视**语义分数（off 等价的前提）',
      run: () => {
        const candidates: OrderableCandidate[] = [
          { memoryId: 'mem:old', recency: 1, lexical: 9, semantic: 0.99 },
          { memoryId: 'mem:new', recency: 2, lexical: 0, semantic: 0.01 },
        ]
        const withSemantic = orderCandidates({ candidates, policyVersion: 'lexical-recency@1' })
        const withoutSemantic = orderCandidates({
          candidates: candidates.map((candidate) => ({ ...candidate, semantic: null })),
          policyVersion: 'lexical-recency@1',
        })
        return {
          order: withSemantic.map((item) => item.memoryId),
          orderWithoutSemantic: withoutSemantic.map((item) => item.memoryId),
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (JSON.stringify(reading.order) !== JSON.stringify(['mem:new', 'mem:old'])) {
          problems.push(`legacy 应按新近度降序，实际 ${JSON.stringify(reading.order)}`)
        }
        /* ★ 把语义分数从 0.99/0.01 换成 null，顺序必须**一字不变** */
        if (JSON.stringify(reading.order) !== JSON.stringify(reading.orderWithoutSemantic)) {
          problems.push('legacy 顺序受了语义分数影响 ⇒ off 不再等价')
        }
        return problems
      },
    })
  )

  probes.push(
    probe({
      id: 'wp0-gap-fixed-by-relevance-order',
      question:
        '★ WP0 的层④缺口：51 条候选、limit 50、目标**最旧但相关性最高** ⇒ legacy 丢掉目标、hybrid 保住目标',
      run: () => {
        const limit = 50
        /* mem:0000 最旧（recency 最小），但它词面 5 + 语义 0.9（其余 50 条词面 0、语义 0.1） */
        const candidates: OrderableCandidate[] = Array.from({ length: 51 }, (_, i) =>
          i === 0
            ? { memoryId: 'mem:0000', recency: 1, lexical: 5, semantic: 0.9 }
            : { memoryId: `mem:${String(i).padStart(4, '0')}`, recency: i + 1, lexical: 0, semantic: 0.1 }
        )
        const legacy = truncateCandidates(orderCandidates({ candidates, policyVersion: 'lexical-recency@1' }), limit)
        const hybrid = truncateCandidates(
          orderCandidates({ candidates, policyVersion: 'hybrid-relevance@1', hybridPolicy: PROVISIONAL_HYBRID_POLICY }),
          limit
        )
        return {
          candidateCount: candidates.length,
          limit,
          legacyKeptTarget: legacy.kept.some((item) => item.memoryId === 'mem:0000'),
          hybridKeptTarget: hybrid.kept.some((item) => item.memoryId === 'mem:0000'),
          hybridRankOfTarget: hybrid.kept.findIndex((item) => item.memoryId === 'mem:0000'),
          legacyDropped: legacy.dropped.map((item) => item.memoryId),
          hybridDroppedCount: hybrid.dropped.length,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        /* ⚠️ 这一侧是**必要的**：证明缺口在 legacy 下**真的存在**（否则探针是空的） */
        if (reading.legacyKeptTarget !== false) {
          problems.push('★ legacy 本应丢掉最旧的命中 ⇒ 探针失去意义（缺口没被复现）')
        }
        if (JSON.stringify(reading.legacyDropped) !== JSON.stringify(['mem:0000'])) {
          problems.push(`legacy 应恰好丢掉目标，实际丢掉 ${JSON.stringify(reading.legacyDropped)}`)
        }
        if (reading.hybridKeptTarget !== true) problems.push('★ hybrid 没有保住相关性最高的目标 ⇒ 缺口未修')
        if (reading.hybridRankOfTarget !== 0) problems.push('目标应排在保留集首位（相关性最高）')
        if (Number(reading.hybridDroppedCount) !== 1) problems.push('hybrid 也应只丢 1 条（limit 仍生效）')
        return problems
      },
    })
  )

  probes.push(
    probe({
      id: 'hybrid-truncation-is-not-recency-first',
      question: 'hybrid 截断：丢掉的是**相关性最低**的，不是最旧的（并自查是否退回新近度优先）',
      run: () => {
        const candidates: OrderableCandidate[] = [
          { memoryId: 'mem:high-old', recency: 1, lexical: 4, semantic: 0.8 },
          { memoryId: 'mem:mid', recency: 50, lexical: 1, semantic: 0.3 },
          { memoryId: 'mem:low-new', recency: 99, lexical: 0, semantic: 0.05 },
        ]
        const result = truncateCandidates(
          orderCandidates({ candidates, policyVersion: 'hybrid-relevance@1', hybridPolicy: PROVISIONAL_HYBRID_POLICY }),
          2
        )
        return {
          kept: result.kept.map((item) => item.memoryId),
          dropped: result.dropped.map((item) => item.memoryId),
          droppedOldestKeptNewest: result.droppedOldestKeptNewest,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.droppedOldestKeptNewest !== false) {
          problems.push('★ 被丢掉的比留下的都新 ⇒ 退回"新近度优先"了')
        }
        if (JSON.stringify(reading.dropped) !== JSON.stringify(['mem:low-new'])) {
          problems.push(`应丢掉相关性最低的那条，实际 ${JSON.stringify(reading.dropped)}`)
        }
        return problems
      },
    })
  )

  probes.push(
    probe({
      id: 'semantic-null-is-not-zero-and-policy-provisional',
      question:
        'D26-④：`semantic: null` 不当作 0 参与（无分数即不可用）；且出厂策略**必须**标未校准',
      run: () => {
        const candidates: OrderableCandidate[] = [
          { memoryId: 'mem:lex', recency: 5, lexical: 3, semantic: null },
          { memoryId: 'mem:sem', recency: 1, lexical: 0, semantic: 0.9 },
        ]
        const ordered = orderCandidates({
          candidates,
          policyVersion: 'hybrid-relevance@1',
          hybridPolicy: PROVISIONAL_HYBRID_POLICY,
        })
        return {
          order: ordered.map((item) => item.memoryId),
          parts: ordered.map((item) => item.parts),
          calibrated: PROVISIONAL_HYBRID_POLICY.calibrated,
          weights: PROVISIONAL_HYBRID_POLICY.weights,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        /*
         * ⚠️ **2026-09-28 翻转**：用户裁定 **甲**（维持等权即冻结）⇒ `calibrated` 转 `true`。
         *    本断言**同时**守住两件事，使"翻标志"与"改权重"**都**不可能静默：
         *      ① 标志必须为 `true`（冻结已裁定）
         *      ② 权重必须**逐字等于冻结值**（甲 = 维持等权）
         *    依据：`docs/m9.5/M9.5-Lexical-Calibration-Bar.md` + `M9.5-Gate-Decision.md`。
         *
         * ★★ **2026-10-01 更新（走的是本断言自己要求的那条路："改权重须走新裁定" ✓）**：
         * ```text
         * 新裁定：用户逐字「**乙**：增加词面强度信息，同时保留 A5 的改述召回要求」+
         *         「**同意改片段粒度**」+ 「D-5 是走冻结区程序改片段粒度」
         *   ⇒ `ADR-083`（词面强度）· `ADR-084`（CJK 片段 **2 字 → 3 字**，冻结区程序，全套 `m4:*` 绿）
         *   ⇒ 扫描（**真实函数现算强度**、判定看**截断后的实际选择**）：
         *        w=1 ❌ · w=1.25 ❌ · **w=1.5 ✅ 全部满足** · w=2 ✅
         *   ⇒ 按用户规则"取**最小**达标值" ⇒ 冻结值 = `{lexical: **1.5**, semantic: 1, margin: 0.5}`
         * ⚠️ **锁本身不撤** ✓ —— 它继续拦住**日后任何**静默改权重 ✓（只是期望值随裁定更新 ✓）
         * ⚠️ 顺带：这个取值**修掉了 `L-M95-18`**（等权下语义可压过字面命中 ⇒ 现在不再成立 ✓）
         * ```
         */
        if (reading.calibrated !== true) {
          problems.push('★ 冻结已裁定（甲）⇒ `calibrated` 必须为 true')
        }
        const frozen = reading.weights as { lexical?: number; semantic?: number; margin?: number }
        if (frozen.lexical !== 1.5 || frozen.semantic !== 1 || frozen.margin !== 0.5) {
          problems.push(
            `★ **冻结权重被改动**：期望 {lexical:1.5, semantic:1, margin:0.5}，实际 ${JSON.stringify(frozen)}` +
              '（`ADR-083`+`ADR-084` 的新裁定 = 片段 3 字下取最小达标值 1.5；**再改须再走新裁定**）'
          )
        }
        const parts = reading.parts as { memoryId?: string; semantic: number | null; margin: number | null }[]
        if (parts[0]?.semantic !== null && parts[1]?.semantic !== null) {
          /* 至少有一条 semantic=null 存在；它的 margin 必须是 null（不因"没有分数"而拿到间隔加成） */
          const nullOne = parts.find((item) => item.semantic === null)
          if (nullOne === undefined) problems.push('构造里本应有一条 semantic=null')
          else if (nullOne.margin !== null) problems.push('semantic=null 的条目不应有 margin')
        }
        return problems
      },
    })
  )

  probes.push(
    probe({
      id: 'no-absolute-cosine-threshold-in-hybrid',
      question: 'D26：混合候选中**不存在**绝对余弦阈值常量（与 semantic-signal 同一纪律）',
      run: () => {
        const source = readFileSync(join(REPO_ROOT, 'src/kernel/app/recall/hybrid-candidates.ts'), 'utf8')
        const cosine = [...source.matchAll(/(?:const|export const)\s+([A-Za-z0-9_]*COSINE[A-Za-z0-9_]*)/g)].map((m) => m[1])
        const thresholds = [...source.matchAll(/(?:const|export const)\s+([A-Za-z0-9_]*THRESHOLD[A-Za-z0-9_]*)/g)].map((m) => m[1])
        return { cosine, thresholds }
      },
      judge: (reading) => {
        const problems: string[] = []
        if ((reading.cosine as string[]).length > 0) problems.push(`出现余弦常量：${(reading.cosine as string[]).join(',')}`)
        if ((reading.thresholds as string[]).length > 0) {
          problems.push(`出现阈值常量：${(reading.thresholds as string[]).join(',')}（门槛必须是可注入的策略字段）`)
        }
        return problems
      },
    })
  )

  probes.push(
    probe({
      id: 'ordering-stability-and-permutation',
      question: '稳定排序：同分按 id 升序；且排序/截断**不丢不重**（是输入的排列）',
      run: () => {
        const candidates: OrderableCandidate[] = Array.from({ length: 12 }, (_, i) => ({
          memoryId: `mem:${String(i).padStart(3, '0')}`,
          recency: 1,
          lexical: i % 3,
          semantic: 0.5,
        }))
        const ordered = orderCandidates({
          candidates,
          policyVersion: 'hybrid-relevance:1' as never,
          hybridPolicy: PROVISIONAL_HYBRID_POLICY,
        })
        const ids = ordered.map((item) => item.memoryId)
        const unique = new Set(ids)
        const equalGroup = ordered.filter((item) => item.relevance === (ordered[0] as { relevance: number }).relevance).map((item) => item.memoryId)
        const result = truncateCandidates(ordered, candidates.length)
        return {
          throwsOnUnknownVersion: (() => {
            try {
              orderCandidates({ candidates, policyVersion: 'hybrid-relevance:1' as never })
              return false
            } catch {
              return true
            }
          })(),
          isPermutation: unique.size === candidates.length,
          count: ids.length,
          equalRelevanceIds: equalGroup,
          keptAll: result.kept.length === candidates.length,
          droppedNone: result.dropped.length === 0,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.isPermutation !== true) problems.push('排序丢了或重复了条目')
        if (Number(reading.count) !== 12) problems.push('排序后条数不对')
        if (reading.keptAll !== true || reading.droppedNone !== true) problems.push('limit 等于总数时不应丢任何条目')
        const group = reading.equalRelevanceIds as string[]
        const sorted = [...group].sort()
        if (JSON.stringify(group) !== JSON.stringify(sorted)) problems.push('同分条目未按 id 升序（stable tie-break 失效）')
        return problems
      },
    })
  )

  const unexpected = probes.filter((item) => item.verdict === 'unexpected').length
  const selfCheck = selfCheckMeasurement({ measuredCount: probes.length, notRunCount: 0, failedCount: unexpected })

  const payload = {
    schemaVersion: 'm9.5-retrieval@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies:
        '通道登记如实性 / R3 伪启用（available 无分数）/ D26 禁绝对阈值与相对间隔信号 / D25 策略版本化与 off 等价',
      pure: '全部纯函数判据（无数据库、无模型、无网络）',
      notProves:
        '**不**证明混合召回已接线（WP6 实现未做）；也**不**证明任何质量阈值（阈值由契约 §2 在盲测前冻结）',
    },
    probes,
    measurement: { selfCheck, measuredCount: probes.length, unexpectedVerdictCount: unexpected },
  }
  const evidencePath = join(runDir, 'retrieval-verify.json')
  writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const tree = sourceTreeReading(REPO_ROOT)
  const manifestPath = writeM95Manifest(runDir, {
    runId,
    stage: 'wp6',
    lane: 'offline',
    startedAt: STARTED_AT,
    completedAt: new Date().toISOString(),
    head: gitOrNull(['rev-parse', 'HEAD']),
    headShort,
    branch: gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyPaths: dirtyPaths(REPO_ROOT),
    sourceTreeHash: tree.treeSha256,
    sourceTreeHashDefinition: tree.definition,
    gateVersion: GATE_VERSION,
    dbKind: 'not-applicable',
    isolationProof: {
      dbTouched: false,
      method: '**构造属性**：本门只测纯函数；不 import 数据库、不 import 编码器',
    },
    configHash: { defaultPolicyVersion: DEFAULT_RETRIEVAL_POLICY_VERSION, gate: GATE_VERSION },
    command: [{ cmd: 'pnpm m9.5:retrieval:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: probes.length,
    notRunCount: 0,
    counts: { total: probes.length, passed: probes.length - unexpected, failed: unexpected },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    retrievalPolicyVersion: DEFAULT_RETRIEVAL_POLICY_VERSION,
    artifactHashes: { 'retrieval-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 WP6 前置门：${runId}`,
      ...probes.map((item) => `  [${item.verdict}] ${item.id}${item.error === null ? '' : ` ⇒ ${item.error}`}`),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

main()
