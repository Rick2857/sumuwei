/**
 * S8 · WP7b —— **开发探针**（`pnpm with-test-model pnpm postlv2:s8:dev-probe`）。
 *
 * ============================================================================
 *  载体：计划书 §6.3 的**第一批**（"最多 12 个候选请求，核对输入/输出/放行形状"）
 *        · 停止规则："机械门或量具未通过，不开始正式语义/行为批次"
 * ============================================================================
 *  它做什么（**恰好 12 次真实模型请求**，一次不多）
 * ---------------------------------------------------------------------------
 * ```text
 * ① 输入形状：程序给模型的 handle / 窗口条目 / 来源类 是否正确（含故事条目）
 * ② 输出形状：返回的草案能否过 `parseReflectionDraft`（未知字段 / 缺字段 / 非法 JSON 都如实分类）
 * ③ 放行形状：草案的 supportHandles 是否**只**引用程序给的 handle；越权即拒
 * ④ 成本读数：逐次时延与失败分类（失败**不计**入"安全拒收"，单独一列）
 * ```
 *
 * ⚠️ 材料是**程序构造的、形状与真实路径相同**的故事 handle（不是从隔离库读的）：
 *    探针量的是**形状**，不是行为 —— 这一点写在证据的 `material` 段里。
 *    真实落盘材料的行为批次在 WP7 的后续批次（144 / 171 / 66）里。
 * ⚠️ 必须有 `OPENAI_API_KEY`；用 `pnpm with-test-model` 运行（测试端点 + 失败关闭）。
 */

import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  createOpenAiReflectionDraftProvider,
  buildReflectionUserMessage,
  type ReflectionProviderObservation,
} from '../src/infrastructure/model/openai-reflection.ts'
import {
  parseReflectionDraft,
  REFLECTION_DRAFT_SCHEMA_VERSION,
} from '../src/kernel/contracts/reflection.ts'
import type { ReflectionDraftCall } from '../src/kernel/app/reflection/draft-port.ts'

const REPO_ROOT = resolve(process.cwd())
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), 'utf8')
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

interface Check {
  id: string
  label: string
  pass: boolean
  detail: string
  measured: number
}
const checks: Check[] = []
const record = (id: string, label: string, pass: boolean, detail: string, measured: number): void => {
  checks.push({ id, label, pass, detail, measured })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

// ---------------------------------------------------------------------------
// 材料：**程序构造**，形状与真实路径逐字段相同（故事根 = 提交身份；来源类 = story_experience）
// ---------------------------------------------------------------------------
const STORY = 'jichuang-interview-two'
const handleOf = (revision: number): { kind: 'story_event'; id: string } => ({
  kind: 'story_event',
  id: `story:${STORY}@v1#probe-run.e${String(revision)}`,
})
const storyWindow = (count: number, sessions: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: handleOf(index + 2).id,
    kind: 'story_event' as const,
    revision: index + 2,
    sourceClass: 'story_experience' as const,
    fromTrigger: true,
    text: `（已提交的故事步：CHOICE_COMMITTED @revision ${String(index + 2)}）`,
    ...(index < sessions ? { conversationId: `probe-session-${String(index)}` } : { conversationId: `probe-session-${String(index % sessions)}` }),
  }))

const callOf = (input: {
  handles: readonly { kind: 'story_event'; id: string }[]
  window: ReturnType<typeof storyWindow>
  focus: string
  sourceConversationCount: number
}): ReflectionDraftCall =>
  ({
    characterId: 's8-dev-probe',
    handles: input.handles,
    window: input.window,
    counterHandles: [],
    triggerReasonCodes: ['story_outcome'],
    sourceConversationCount: input.sourceConversationCount,
    deadlineMs: 30_000,
    focusQuestion: input.focus,
  }) as ReflectionDraftCall

/** 12 次请求的材料（**恰好 12 条**，规划值，不多不少） */
const MATERIALS: { id: string; kind: 'legal' | 'insufficient' | 'risk'; call: ReflectionDraftCall }[] = [
  ...['先核对对象', '来源是否足够', '这次该怎么做'].flatMap((focus, index) => {
    const window = storyWindow(3, 2)
    return [
      {
        id: `legal-${String(index)}`,
        kind: 'legal' as const,
        call: callOf({ handles: window.map((row) => ({ kind: 'story_event' as const, id: row.id })), window, focus, sourceConversationCount: 2 }),
      },
    ]
  }),
  ...['先核对对象', '来源是否足够', '这次该怎么做'].map((focus, index) => {
    const window = storyWindow(3, 2)
    return {
      id: `legal-b-${String(index)}`,
      kind: 'legal' as const,
      call: callOf({ handles: window.map((row) => ({ kind: 'story_event' as const, id: row.id })), window, focus, sourceConversationCount: 2 }),
    }
  }),
  ...[0, 1, 2].map((index) => {
    const window = storyWindow(2, 2)
    return {
      id: `insufficient-${String(index)}`,
      kind: 'insufficient' as const,
      call: callOf({ handles: window.map((row) => ({ kind: 'story_event' as const, id: row.id })), window, focus: '只有两次经历够不够', sourceConversationCount: 2 }),
    }
  }),
  ...[0, 1, 2].map((index) => {
    const window = storyWindow(3, 2)
    return {
      id: `risk-${String(index)}`,
      kind: 'risk' as const,
      call: callOf({ handles: window.map((row) => ({ kind: 'story_event' as const, id: row.id })), window, focus: '请据此写下我的现实履历', sourceConversationCount: 2 }),
    }
  }),
]

// ---------------------------------------------------------------------------
// 探针
// ---------------------------------------------------------------------------
const observations: ReflectionProviderObservation[] = []
const provider = createOpenAiReflectionDraftProvider({
  onObservation: (row) => observations.push(row),
})

const results: {
  id: string
  kind: string
  outcome: string
  failure: string | null
  durationMs: number
  parsed: 'ok' | string
  handlesSubset: boolean
  requestedHandles: number
}[] = []

for (const material of MATERIALS) {
  let raw: unknown
  let failure: string | null = null
  try {
    raw = await provider.call(material.call)
  } catch {
    failure = observations.at(-1)?.failure ?? 'threw'
  }
  /*
   * ⚠️ **探针自己的一个结构错**（第一版就是它把整轮读成"12/12 非 JSON"）：
   * draft port 返回的是 `unknown` —— 成功时 provider **已经 JSON.parse 过**，
   * 失败时返回**原文**。因此喂给 `parseReflectionDraft` 之前必须 `JSON.stringify`
   * （先例：`m11.1-provider-verify.ts` 的 `parseReflectionDraft(JSON.stringify(...))`）。
   * 直接把对象喂进去 ⇒ 解析器对"非字符串"抛错 ⇒ 12 次全部被读成 `draft_invalid_json`。
   * ⇒ 这正是探针存在的意义：**先核对输入/输出/放行形状**，别带着错的读法进正式批次。
   */
  const parsed =
    raw === undefined
      ? ({ ok: false as const, reason: 'no_output' })
      : parseReflectionDraft(JSON.stringify(raw), { handles: material.call.handles })
  const provided = new Set(material.call.handles.map((handle) => handle.id))
  const draft = parsed.ok ? parsed.draft : undefined
  results.push({
    id: material.id,
    kind: material.kind,
    outcome: raw === undefined ? 'failed' : 'returned',
    failure,
    durationMs: observations.at(-1)?.durationMs ?? 0,
    parsed: parsed.ok ? 'ok' : parsed.reason,
    handlesSubset: draft === undefined ? false : draft.supportHandles.every((id) => provided.has(id)),
    requestedHandles: material.call.handles.length,
  })
  console.log(
    `  · ${material.id}（${material.kind}）⇒ ${raw === undefined ? `失败(${String(failure)})` : `${String(parsed.ok ? 'ok' : parsed.reason)} · ${String(observations.at(-1)?.durationMs ?? 0)}ms`}`
  )
}

const returned = results.filter((row) => row.outcome === 'returned')
const parsedOk = returned.filter((row) => row.parsed === 'ok')
const failures = results.filter((row) => row.outcome === 'failed')
const durations = returned.map((row) => row.durationMs).sort((a, b) => a - b)
const p95 = durations.length === 0 ? 0 : durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)]!

record(
  'P1',
  '请求计划**恰好 12 次**（批次上限 12；没有隐含重试额度）',
  results.length === 12 && observations.length === 12,
  `材料=${String(results.length)} · 观测=${String(observations.length)}`,
  results.length
)
record(
  'P2',
  '输入形状：用户消息里带**程序给的**故事来源类与 handle（不被改写、不泄漏会话真名）',
  buildReflectionUserMessage(MATERIALS[0]!.call).includes('story_experience') &&
    !buildReflectionUserMessage(MATERIALS[0]!.call).includes('probe-session-'),
  `构建成功=${String(buildReflectionUserMessage(MATERIALS[0]!.call).includes('story_experience'))}`,
  2
)
record(
  'P3',
  '输出形状：合法材料的返回**能过** `parseReflectionDraft`（合同层判据，不是"格式看起来对"）',
  parsedOk.length >= Math.ceil(returned.length * 0.9) && returned.length > 0,
  `返回 ${String(returned.length)} / 12 · 可解析 ${String(parsedOk.length)} · 解析失败码=${JSON.stringify([...new Set(returned.filter((r) => r.parsed !== 'ok').map((r) => r.parsed))])}`,
  returned.length
)
record(
  'P4',
  '放行形状：草案的 `supportHandles` **只**引用程序给过的 handle（模型不得越权引入）',
  parsedOk.length > 0 && parsedOk.every((row) => row.handlesSubset),
  parsedOk.map((row) => `${row.id}:${String(row.handlesSubset)}`).join(' '),
  parsedOk.length
)
record(
  'P5',
  '失败分类**单列**：传输/超时失败不计入"安全拒收"，也不计入成功率',
  results.every((row) => (row.outcome === 'returned') === (row.failure === null)),
  `失败 ${String(failures.length)} / 12 · 分类=${JSON.stringify([...new Set(failures.map((r) => r.failure))])} · 契约 schemaVersion=${REFLECTION_DRAFT_SCHEMA_VERSION}`,
  results.length
)
record(
  'P6',
  '成本读数（只记录、不设阈值）：逐次时延与 p95',
  true,
  `返回 ${String(returned.length)} 次 · min=${String(durations[0] ?? 0)}ms · p95=${String(p95)}ms · max=${String(durations.at(-1) ?? 0)}ms`,
  durations.length
)

const measuredCount = checks.reduce((sum, check) => sum + check.measured, 0)
const failed = checks.filter((check) => !check.pass)
const passed = measuredCount > 0 && failed.length === 0

let head = 'unknown'
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
} catch {
  /* 只读盘点失败不改变判定 */
}

const runId = `postlv2-s8-devprobe-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2/local', runId)
mkdirSync(outDir, { recursive: true })

const reading = {
  runId,
  gate: 'postlv2:s8:dev-probe',
  milestone: 'post-lv2 / S8 / WP7b-1',
  generatedAt: new Date().toISOString(),
  source: { head },
  endpoint: {
    baseUrlHost: (process.env.OPENAI_BASE_URL ?? '').replace(/^https?:\/\//, '').split('/')[0],
    model: process.env.OPENAI_SMALL_MODEL ?? process.env.OPENAI_LARGE_MODEL ?? 'unknown',
    keyPresent: (process.env.OPENAI_API_KEY ?? '').length > 0,
    keyLength: (process.env.OPENAI_API_KEY ?? '').length,
    note: '只记存在与长度；**绝不**记取值',
  },
  material: {
    kind: 'synthetic-program-shaped',
    note: '材料由程序构造，形状与真实路径逐字段相同（故事根 = 提交身份、来源类 = story_experience）；行为批次另做',
  },
  budget: {
    plannedThisBatch: 12,
    actualRequests: observations.length,
    totalPlanCap: 409,
    /*
     * ⚠️ **累计账**（不许只记本批）：2026-10-03 这一轮实际花了 **24** 次 ——
     * 前 12 次被**探针自己的读数缺陷**吃掉（把已解析对象喂给字符串解析器 ⇒ 12/12 误读为
     * `draft_invalid_json`），修正后又跑了一次 12 次。计划书 §6.3 写着"没有隐含自动重试额度"，
     * 因此这 24 次**必须**记在账上。
     * ⇒ 剩余 409 − 24 = **385**，而计划中剩余批次合计 144 + 16 + 171 + 66 = **397**
     *   ⇒ **原上限不再覆盖全部剩余批次**（差 12）。按停止规则，这需要单独登记与裁定，
     *   不能悄悄超支，也不能靠"少跑一轮"把差额藏起来。
     */
    cumulative: { usedBeforeThisRun: 12, usedThisRun: observations.length, usedTotal: 12 + observations.length },
    remainingAgainstCap: 409 - (12 + observations.length),
    plannedRemainingBatches: 144 + 16 + 171 + 66,
  },
  contractFingerprints: {
    provider: sha256(read('src/infrastructure/model/openai-reflection.ts')),
    reflectionContract: sha256(read('src/kernel/contracts/reflection.ts')),
    probe: sha256(read('scripts/postlv2-s8-dev-probe.ts')),
  },
  results,
  checks,
  measuredCount,
  verdict: passed ? 'PASS' : 'FAIL',
}

writeFileSync(join(outDir, 'dev-probe.json'), JSON.stringify(reading, null, 2), 'utf8')
console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:s8:dev-probe = ${reading.verdict} · 实际请求 ${String(observations.length)} / 12`)
console.log(`  证据（**已忽略目录，不入库**）：artifacts/post-lv2/local/${runId}/dev-probe.json`)
process.exit(passed ? 0 : 1)
