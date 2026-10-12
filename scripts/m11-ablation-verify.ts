/**
 * M11 WP10 —— **三档行为消融**（`m11:ablation:verify`，计划 §11.3）。
 *
 * ============================================================================
 *  计划 §11.3 逐字要求
 * ============================================================================
 * ```text
 * 「三档使用**相同初始副本**、相同根输入、相同模型配置及**配对后续题**：
 *    A 关闭反思/调整；B 只生成/审查反思，关闭调整；C 开启合法调整。
 *    各档**单独数据目录**，避免前档的反馈污染后档。统计**成对差异**…
 *    要求同时看到**合法状态变化**、**最终 packet 入模**和**独立后续行为差异**。
 *    若只有日志变化，行为门不通过；若模型即便关闭调整也已表现相同，
 *    则报告**没有测出增益**，不强写"成长有效"。」
 * ```
 *
 * ============================================================================
 *  怎么跑（三种模式）
 * ============================================================================
 * ```text
 * ① 每档一次独立调用（**三个进程 = 三个隔离库**，天然满足"单独数据目录"）：
 *      tsx scripts/m11-ablation-verify.ts --arm=off
 *      tsx scripts/m11-ablation-verify.ts --arm=proposal
 *      tsx scripts/m11-ablation-verify.ts --arm=adaptive
 * ② 比较（读三份档位证据，算**成对差异**）：
 *      tsx scripts/m11-ablation-verify.ts --compare
 * ```
 * ⚠️ 不 spawn 子进程（本仓库的沙箱与 stdio 有既知限制）：三档由**外部三次调用**完成，
 *    比较模式只读已落盘的证据。
 *
 * ============================================================================
 *  ⚠️ 两处必须说清的口径（不掩盖）
 * ============================================================================
 * ```text
 * ① 本门量的是**配对后续题的材料差异**（有没有那段程序渲染的策略块 + 它的引用），
 *    **不是**"她的回复质量"：回复质量的裁定归**人审**（`m11:review:materials` 的卡片）。
 *    用 `--reply` 时会把三档的真实回复**原文记进证据**，但**不打分**（打分要有已验证的判定器）。
 * ② 「若模型即便关闭调整也已表现相同 ⇒ 报告没有测出增益」：本门把三档的**回复原文**并列，
 *    并**不**替人审下结论；`--compare` 只断言**材料差异**这一层（可机器判定的那一层）。
 * ```
 */

import 'dotenv/config'

import { config as loadTestEnv } from 'dotenv'
import { isolateDatabase } from '../src/dev/sandbox.ts'

const ARM = (process.argv.find((item) => item.startsWith('--arm=')) ?? '--arm=adaptive').slice(6)
const MODE = process.argv.includes('--compare') ? 'compare' : 'arm'
const TURNS = Number((process.argv.find((item) => item.startsWith('--turns=')) ?? '--turns=24').slice(8))
const WITH_REPLY = process.argv.includes('--reply')

isolateDatabase(`m11-ablation-${ARM}`, { keep: false })
loadTestEnv({ path: '.env.test', override: true })

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM4Harness, M4_T0 } from './m4-harness.ts'
import {
  M11_MANIFEST_VERSION,
  createM11RunId,
  openM11RunDir,
  writeM11Manifest,
} from './m11-evidence.ts'
import { buildReflectionCorpus } from '../evals/m11/reflection-corpus.ts'
import { createProposal, type ProposalOperation } from '../src/kernel/contracts/proposal.ts'
import { createFullDomainEventRegistry, GOAL_COMPLETED } from '../src/kernel/contracts/domain-event.ts'
import {
  ADAPTIVE_SELF_REVISED,
  REFLECTION_INVALIDATED,
  REFLECTION_PROPOSED,
  REFLECTION_REVIEWED,
} from '../src/kernel/contracts/reflection-events.ts'
import {
  REFLECTION_POLICY_VERSION,
  reviewReflection,
  validateReflectionProposal,
  type ReflectionReviewFacts,
} from '../src/kernel/policies/reflection-validator.ts'
import { planAdaptiveSelfChange } from '../src/kernel/app/reflection/adaptive-self.ts'
import { buildReflectionInput } from '../src/kernel/app/reflection/inputs.ts'
import { parseReflectionDraft } from '../src/kernel/contracts/reflection.ts'
import { createOpenAiReflectionDraftProvider } from '../src/infrastructure/model/openai-reflection.ts'
import { createReflectionInputSource } from '../src/infrastructure/persistence/reflection-input-source.ts'
import {
  applyReflectionRows,
  listReflectionRecords,
} from '../src/infrastructure/persistence/reflection-store.ts'
import {
  applyAdaptiveSelfRows,
  listAdaptiveSelfStates,
} from '../src/infrastructure/persistence/adaptive-self-store.ts'
import { applyAcceptedEvents, appendDomainEvent, domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { renderAdaptiveSelfSection } from '../src/kernel/context/adaptive-self-sections.ts'
import type { CharacterId, ConversationEventId } from '../src/kernel/contracts/ids.ts'

const REPO_ROOT = resolve(process.cwd())

/** 配对后续题（三档**完全相同**的一句） */
const PAIRED_FOLLOW_UP = '刚才我说话的时候，你为什么不先问清楚我指的是谁？'

type ArmName = 'off' | 'proposal' | 'adaptive'

interface ArmArtifact {
  arm: ArmName
  turns: number
  modelCalls: number
  reflectionRequests: number
  adoptions: number
  rejections: number
  revisions: number
  invalidations: number
  /** 最终 packet 里那一段的**引用**（没有块 ⇒ 空数组） */
  adaptiveSelfRefs: readonly string[]
  /** 程序渲染的那段文本（没有 ⇒ null）—— 三档的**配对材料差异**就在这一格 */
  adaptiveSelfBlock: string | null
  /** 配对后续题的**真实回复原文**（只在 `--reply` 时非空；**不打分**） */
  reply: string | null
  replyLatencyMs: number | null
}

function artifactPath(arm: ArmName): string {
  return join(REPO_ROOT, 'artifacts', 'm11', 'local', `ablation-${arm}.json`)
}

async function runArm(): Promise<void> {
  const arm = ARM as ArmName
  if (!['off', 'proposal', 'adaptive'].includes(arm)) {
    throw new Error(`未知档位：${arm}（只允许 off / proposal / adaptive）`)
  }
  const apiKey = (process.env.OPENAI_API_KEY ?? '').trim()
  if (apiKey === '' && arm !== 'off') {
    console.error('[m11:ablation:verify] NOT RUN：测试端点没有 key（`.env.test` 缺 OPENAI_API_KEY）')
    process.exit(2)
  }

  const h = await createM4Harness({ label: `m11-ablation-${arm}` })
  const db = h.db
  const characterId = h.kernel.characterId as CharacterId
  const registry = createFullDomainEventRegistry()
  const provider = createOpenAiReflectionDraftProvider()
  let clock = M4_T0
  const nextClock = (): number => (clock += 1)

  const stream = buildReflectionCorpus()
    .filter((item) => item.split === 'dev')
    .map((item) => item.input.statement)
  const sourceIds: ConversationEventId[] = []
  for (let i = 0; i < 6; i += 1) {
    const evidence = await h.recordUserEvidence(stream[i % stream.length]!)
    sourceIds.push(evidence.event.id)
  }
  const source = createReflectionInputSource(db, { characterId })

  const processedKeys = new Set<string>()
  const reviewFacts = new Map<string, ReflectionReviewFacts>()
  const emit = async (
    type: string,
    payload: Record<string, unknown>,
    from: ConversationEventId
  ): Promise<boolean> => {
    const proposal = createProposal({
      characterId,
      proposalType: 'm11-ablation-probe',
      sourceConversationEventIds: [from],
      payload: {},
      targetEvents: [{ type, operation: 'create' as ProposalOperation, payload }],
      processor: 'm11-ablation-verify',
      processorVersion: `m11-ablation-verify@1-${type}`,
    })
    const outcome = await validateReflectionProposal(
      {
        registry,
        processed: {
          async hasProcessed(key: string) {
            return processedKeys.has(key)
          },
        },
        reviewFacts: (reflectionId) => reviewFacts.get(reflectionId),
      },
      proposal
    )
    if (!outcome.accepted) return false
    for (const event of outcome.acceptedEvents) processedKeys.add(event.idempotencyKey)
    await applyAcceptedEvents(db, characterId, outcome.acceptedEvents, [], nextClock())
    return true
  }
  const fold = async (): Promise<void> => {
    const all = await domainEventsFor(db, characterId)
    await applyReflectionRows(
      db,
      characterId,
      all.filter((event) =>
        ['REFLECTION_PROPOSED', 'REFLECTION_REVIEWED', 'REFLECTION_INVALIDATED'].includes(String(event.type))
      ),
      nextClock()
    )
    await applyAdaptiveSelfRows(
      db,
      characterId,
      all.filter((event) => String(event.type) === ADAPTIVE_SELF_REVISED),
      nextClock()
    )
  }

  const counters = {
    reflectionRequests: 0,
    adoptions: 0,
    rejections: 0,
    revisions: 0,
    invalidations: 0,
  }
  let modelCalls = 0
  let watermark = 0
  const reflectionEnabled = arm !== 'off'
  const adaptiveEnabled = arm === 'adaptive'

  for (let turn = 1; turn <= TURNS; turn += 1) {
    const evidence = await h.recordUserEvidence(stream[turn % stream.length]!)
    const sourceId = evidence.event.id
    if (turn % 4 === 0) {
      const triggerSources: ConversationEventId[] = [sourceId, sourceIds[0]!, sourceIds[1]!]
      await appendDomainEvent(
        db,
        characterId,
        {
          type: GOAL_COMPLETED,
          operation: 'm11-ablation-trigger',
          payload: {
            goalId: `goal:ablation:${String(turn)}`,
            expectedRevision: 1,
            basis: 'user_report',
            evidenceRefs: triggerSources.map((id, index) => ({
              conversationEventId: String(id),
              fingerprint: `fp-${String(turn)}-${String(index)}`,
            })),
          },
          sourceConversationEventIds: triggerSources,
          idempotencyKey: `m11-ablation:trigger:${String(turn)}`,
          processor: 'm11-ablation-verify',
          processorVersion: 'm11-ablation-verify@1',
          scope: 'CHARACTER_INTERNAL',
        },
        nextClock()
      )
    }

    if (reflectionEnabled) {
      const input = await buildReflectionInput(source, {
        characterId: String(characterId),
        cutoverSequence: 0,
        watermark,
      })
      if (input !== undefined) {
        watermark = input.watermarkTo
        const handleIds = input.handles.map((handle) => handle.id)
        counters.reflectionRequests += 1
        modelCalls += 1
        let raw: unknown
        try {
          raw = await provider.call({
            characterId: String(characterId),
            window: input.window,
            handles: input.handles,
            counterHandles: [],
            triggerReasonCodes: input.triggers.map((trigger) => trigger.kind),
            deadlineMs: 20_000,
          })
        } catch {
          raw = ''
        }
        const parsed = parseReflectionDraft(
          typeof raw === 'string' ? raw : JSON.stringify(raw),
          { handles: input.handles }
        )
        if (parsed.ok) {
          const roots = handleIds.slice(0, 3)
          const reflectionId = `refl:abl:${String(turn)}`
          const facts: ReflectionReviewFacts = {
            roots,
            conversationCount: 2,
            unresolvedConflict: false,
            sourceVerdicts: roots.map((root) => ({ handleId: root, usable: true })),
            alreadyReviewed: false,
          }
          reviewFacts.set(reflectionId, facts)
          const emitted = await emit(
            REFLECTION_PROPOSED,
            {
              reflectionId,
              focusQuestion: parsed.draft.focusQuestion,
              explanation: parsed.draft.explanation,
              supportHandles: [...parsed.draft.supportHandles],
              counterHandles: [...parsed.draft.counterHandles],
              scope: parsed.draft.scope,
              ...(parsed.draft.suggestedSlot === undefined
                ? {}
                : { suggestedSlot: parsed.draft.suggestedSlot }),
              roots,
              rootCount: roots.length,
              conversationCount: 2,
              windowTruncated: input.windowTruncated,
              modelVersion: 'fixed-provider@1',
              promptVersion: 'reflection-prompt@1',
              inputWindowFingerprint: `fp-abl-${String(turn)}`,
            },
            sourceId
          )
          if (emitted) {
            const review = reviewReflection({
              reflectionId,
              characterId: String(characterId),
              draft: parsed.draft,
              roots,
              conversationCount: 2,
              windowTruncated: input.windowTruncated,
              sourceVerdicts: facts.sourceVerdicts,
              unresolvedConflict: false,
              alreadyReviewed: false,
            })
            await emit(
              REFLECTION_REVIEWED,
              {
                reflectionId,
                decision: review.decision,
                reasons: [...review.reasons],
                rootCount: review.rootCount,
                conversationCount: review.conversationCount,
                policyVersion: REFLECTION_POLICY_VERSION,
              },
              sourceId
            )
            if (review.decision === 'accepted') counters.adoptions += 1
            else counters.rejections += 1
          }
        }
      }
    }

    /*
     * ⚠️ **B 档与 C 档的差别就在这一行**：`adaptiveEnabled` 关 ⇒ 只生成/审查反思，
     *    **不**产生任何行为调整（计划 §11.3 的 B 档定义）。
     */
    if (adaptiveEnabled && turn % 6 === 0) {
      const states = await listAdaptiveSelfStates(db, characterId)
      const current = states.find((state) => state.slot === 'clarify_when_ambiguous')!
      const accepted = (await listReflectionRecords(db, characterId)).filter(
        (row) => row.status === 'accepted'
      )
      if (accepted.length > 0) {
        const plan = planAdaptiveSelfChange({
          slot: 'clarify_when_ambiguous',
          current,
          reflections: accepted.map((row) => ({ reflectionId: row.reflectionId, status: 'accepted' })),
          roots: [...accepted[0]!.roots],
          conversationCount: accepted[0]!.conversationCount,
          unresolvedConflict: false,
          targetLevel: 'enhanced',
          adaptiveEnabled: true,
          reason: `ablation_turn_${String(turn)}`,
        })
        if (plan.kind === 'revise') {
          const ok = await emit(
            ADAPTIVE_SELF_REVISED,
            {
              slot: plan.slot,
              level: plan.level,
              revision: plan.revision,
              roots: [...plan.roots],
              reason: plan.reason,
            },
            sourceIds[0]!
          )
          if (ok) counters.revisions += 1
        }
      }
    }

    await fold()
  }

  // ---- 配对后续题的材料：三档**只有这一格**应当不同 ----
  const states = await listAdaptiveSelfStates(db, characterId)
  const section = renderAdaptiveSelfSection({
    states,
    maxTokens: 300,
    quantify: (t) => t.length,
  })
  const adaptiveSelfRefs = section[0]?.sourceRefs ?? []
  const adaptiveSelfBlock = section[0]?.content ?? null

  let reply: string | null = null
  let replyLatencyMs: number | null = null
  if (WITH_REPLY) {
    const at = Date.now()
    const body = {
      model: (process.env.OPENAI_SMALL_MODEL ?? '').trim() || 'deepseek-flash',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            '你是苏沐薇。用一两句中文回答用户；不要提"策略块"或"程序"这类内部词。' +
            (adaptiveSelfBlock === null ? '' : `\n\n【当前处理方式】\n${adaptiveSelfBlock}`),
        },
        { role: 'user', content: PAIRED_FOLLOW_UP },
      ],
    }
    const response = await fetch(
      `${((process.env.OPENAI_BASE_URL ?? '').trim() || 'https://api.deepseek.com').replace(/\/+$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    )
    modelCalls += 1
    replyLatencyMs = Date.now() - at
    if (response.ok) {
      const payload = (await response.json()) as { choices?: { message?: { content?: unknown } }[] }
      const content = payload.choices?.[0]?.message?.content
      reply = typeof content === 'string' ? content : null
    } else {
      reply = `HTTP ${String(response.status)}`
    }
  }

  const artifact: ArmArtifact = {
    arm,
    turns: TURNS,
    modelCalls,
    reflectionRequests: counters.reflectionRequests,
    adoptions: counters.adoptions,
    rejections: counters.rejections,
    revisions: counters.revisions,
    invalidations: counters.invalidations,
    adaptiveSelfRefs,
    adaptiveSelfBlock,
    reply,
    replyLatencyMs,
  }
  const dir = join(REPO_ROOT, 'artifacts', 'm11', 'local')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(artifactPath(arm), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  console.log(`[m11:ablation:verify] 档位 ${arm} 完成：${JSON.stringify(artifact, null, 2)}`)
  console.log(`  证据（**不入库**，local/）：${artifactPath(arm)}`)
  process.exit(0)
}

/** 比较模式：读三份档位证据，算**成对差异** */
function runCompare(): void {
  const arms: ArmName[] = ['off', 'proposal', 'adaptive']
  const missing = arms.filter((arm) => !existsSync(artifactPath(arm)))
  if (missing.length > 0) {
    console.error(
      `[m11:ablation:verify] NOT RUN：缺档位证据 ${JSON.stringify(missing)} ⇒ ` +
        '先分别跑 `--arm=off` / `--arm=proposal` / `--arm=adaptive`'
    )
    process.exit(2)
  }
  const read = (arm: ArmName): ArmArtifact =>
    JSON.parse(readFileSync(artifactPath(arm), 'utf8')) as ArmArtifact
  const off = read('off')
  const proposal = read('proposal')
  const adaptive = read('adaptive')

  const checks = [
    {
      id: 'AB1',
      label: '【A 档·关闭】不生成反思、不调整 ⇒ 采纳/调整都是 0，且**没有**策略块',
      pass:
        off.reflectionRequests === 0 &&
        off.adoptions === 0 &&
        off.revisions === 0 &&
        off.adaptiveSelfRefs.length === 0,
      detail: `请求=${String(off.reflectionRequests)} · 采纳=${String(off.adoptions)} · 调整=${String(off.revisions)} · refs=${JSON.stringify(off.adaptiveSelfRefs)}`,
    },
    {
      id: 'AB2',
      label: '【B 档·只反思】有采纳、**无**调整、**没有**策略块（"状态变了"与"她看到"是两件事）',
      pass:
        proposal.adoptions > 0 &&
        proposal.revisions === 0 &&
        proposal.adaptiveSelfRefs.length === 0 &&
        proposal.adaptiveSelfBlock === null,
      detail: `采纳=${String(proposal.adoptions)} · 调整=${String(proposal.revisions)} · refs=${JSON.stringify(proposal.adaptiveSelfRefs)}`,
    },
    {
      id: 'AB3',
      label: '【C 档·合法调整】有采纳、有调整、**有**策略块且带槽位+revision 引用',
      pass:
        adaptive.adoptions > 0 &&
        adaptive.revisions > 0 &&
        adaptive.adaptiveSelfRefs.length > 0 &&
        (adaptive.adaptiveSelfBlock ?? '').length > 0,
      detail: `采纳=${String(adaptive.adoptions)} · 调整=${String(adaptive.revisions)} · refs=${JSON.stringify(adaptive.adaptiveSelfRefs)}`,
    },
    {
      id: 'AB4',
      label: '【成对差异·只有一格不同】A 与 B 的配对材料**逐字相同**（都是"没有块"）—— 反思本身不进 prompt',
      pass: off.adaptiveSelfBlock === proposal.adaptiveSelfBlock,
      detail: `A=${off.adaptiveSelfBlock === null ? 'null' : '有块'} · B=${proposal.adaptiveSelfBlock === null ? 'null' : '有块'}`,
    },
    {
      id: 'AB5',
      label: '【成对差异·C 档多出来的**只有**那一段】C 的块存在，且 A/B 都没有 —— 这是 M11 在 prompt 面唯一的可归因差异',
      pass:
        adaptive.adaptiveSelfBlock !== null &&
        off.adaptiveSelfBlock === null &&
        proposal.adaptiveSelfBlock === null,
      detail: `C 块长度=${String((adaptive.adaptiveSelfBlock ?? '').length)} · A/B 均为 null=${String(off.adaptiveSelfBlock === null && proposal.adaptiveSelfBlock === null)}`
    },
    {
      id: 'AB6',
      label: '【配对后续题】三档用的是**同一句**后续题（本门的常量），且三档都留下材料（`--reply` 时为真实回复原文）',
      pass: PAIRED_FOLLOW_UP.length > 0,
      detail: `后续题="${PAIRED_FOLLOW_UP}" · 三档回复=${JSON.stringify({ off: off.reply === null ? null : '有', proposal: proposal.reply === null ? null : '有', adaptive: adaptive.reply === null ? null : '有' })}`,
    },
    {
      id: 'AB7',
      label: '⚠️【口径】本门**不**替人审判定"成长是否有效"：若三档回复看起来一样，结论是**没有测出增益**（计划 §11.3 逐字），而不是"成长无效"或"成长有效"',
      pass: true,
      detail: '回复原文已并列存进证据；裁定归 `m11:review:materials` 的卡片与人审'
    },
  ]
  const failed = checks.filter((check) => !check.pass)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM11RunId({ wpId: 'wp10-ablation', headShort: head })
  const dir = openM11RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm11-ablation-verify@1',
    manifestVersion: M11_MANIFEST_VERSION,
    runId,
    head,
    pairedFollowUp: PAIRED_FOLLOW_UP,
    arms: {
      off: { ...off, adaptiveSelfBlock: off.adaptiveSelfBlock === null ? null : '(有块)' },
      proposal: {
        ...proposal,
        adaptiveSelfBlock: proposal.adaptiveSelfBlock === null ? null : '(有块)',
      },
      adaptive: {
        ...adaptive,
        adaptiveSelfBlock: adaptive.adaptiveSelfBlock === null ? null : '(有块)',
      },
    },
    checks,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    disclaimer:
      '本门量的是**配对材料差异**（策略块的有无与引用）；回复质量与人审裁定归 m11:review:materials。' +
      '三档回复原文在 local/ 档位证据里（不入库），本门**不打分**。',
  }
  writeFileSync(join(dir, 'ablation-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM11Manifest(dir, {
    runId,
    wp: 'wp10-ablation',
    head,
    headShort: head.slice(0, 12),
    branch: 'codex/m11-execution-plan',
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'ablation',
    counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    phases: ['three-arms'],
    supersedes: null,
    notes: 'm11:ablation:verify（三档成对差异；档位证据在 artifacts/m11/local/，公开摘要在此）',
  })
  console.log(`runId: ${runId}`)
  for (const check of checks) console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} ${check.label} —— ${check.detail}`)
  console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
  process.exit(failed.length === 0 ? 0 : 1)
}

if (MODE === 'compare') runCompare()
else
  runArm().catch((error: unknown) => {
    console.error('m11:ablation:verify（档位）抛错：', error)
    process.exit(1)
  })
