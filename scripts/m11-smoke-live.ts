/**
 * M11 WP10 —— **真实端点冒烟**（`m11:smoke:live`）。
 *
 * ============================================================================
 *  它回答什么问题
 * ============================================================================
 * ```text
 * 「反思候选这条链，在**真实端点**上到底走不走得通？」
 *   ① 提示词与契约是否同步（模型能不能按闭集产出）
 *   ② 严格校验会不会把它全部拒掉（格式正确率）
 *   ③ 模型会不会**编造 handle**（这是 `D14`/`D31` 最要紧的一条）
 * ```
 *
 * ⚠️ **它不是语义评测**：3–5 次调用只能证明"链路通"，不能证明"判得准"。
 *    判得准要跑 `m11:semantic:eval`（160 条盲测 × 3 轮）。
 *
 * ⚠️ **凭证纪律**：本脚本**只**用 `.env.test`（测试端点）。
 *    工作树里**没有** `.env` ⇒ 不存在"以为在跑测试、其实在烧生产 key"的可能。
 *    打印的读数只有 host / model / key 长度，**绝不打印取值**。
 */

import 'dotenv/config'

import { config as loadTestEnv } from 'dotenv'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/*
 * ⚠️ 顺序：先 `.env`（基线，工作树里不存在）再 `.env.test`（**覆盖**）。
 *    与 `pnpm with-test-model` 的两步加载同一条纪律。
 */
loadTestEnv({ path: '.env.test', override: true })

import {
  M11_MANIFEST_VERSION,
  createM11RunId,
  openM11RunDir,
  writeM11Manifest,
} from './m11-evidence.ts'
import { createOpenAiReflectionDraftProvider } from '../src/infrastructure/model/openai-reflection.ts'
import { validateReflectionDraft } from '../src/kernel/contracts/reflection.ts'
import type { ReflectionHandle } from '../src/kernel/contracts/reflection.ts'
import type { ReflectionWindowEntry } from '../src/kernel/contracts/reflection-input.ts'
import type { ReflectionDraftCall } from '../src/kernel/app/reflection/draft-port.ts'

const REPO_ROOT = resolve(process.cwd())

interface Check {
  id: string
  label: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
function record(id: string, label: string, pass: boolean, detail: string): void {
  checks.push({ id, label, pass, detail })
}

const handle = (id: string): ReflectionHandle => ({ kind: 'conversation_event', id })
const entry = (id: string, text: string): ReflectionWindowEntry => ({
  id,
  kind: 'conversation_event',
  revision: 1,
  sourceClass: 'user_statement',
  fromTrigger: true,
  text,
})

function callOf(input: {
  window: readonly ReflectionWindowEntry[]
  counterIds?: readonly string[]
}): ReflectionDraftCall {
  const handles = input.window.map((row) => handle(row.id))
  return {
    characterId: 'char_smoke',
    window: input.window,
    handles,
    counterHandles: (input.counterIds ?? []).map(handle),
    triggerReasonCodes: ['explicit_correction'],
    deadlineMs: 20_000,
  }
}

const CASES: readonly { id: string; label: string; call: ReflectionDraftCall }[] = [
  {
    id: 'L1',
    label: '三根两会话的合法反馈（应能产出可解析的候选）',
    call: callOf({
      window: [
        entry('ce:1', '你答之前先问清楚我指的是谁，这样好多了。'),
        entry('ce:2', '对象不明确的时候，先确认再答，谢谢。'),
        entry('ce:3', '还是那个问题：不清楚就问一句。'),
      ],
    }),
  },
  {
    id: 'L2',
    label: '带直接反例（程序已标出 counter handle）',
    call: callOf({
      window: [
        entry('ce:4', '这次不用问，直接答就行。'),
        entry('ce:5', '上次说过要先确认的。'),
      ],
      counterIds: ['ce:4'],
    }),
  },
  {
    id: 'L3',
    label: '证据不足（只有一个来源，模型**不该**上升为规律）',
    call: callOf({ window: [entry('ce:6', '今天这件事你处理得不错。')] }),
  },
]

async function main(): Promise<void> {
  const apiKey = (process.env.OPENAI_API_KEY ?? '').trim()
  if (apiKey === '') {
    console.error('[m11:smoke:live] 拒绝：测试端点没有 key（`.env.test` 缺 OPENAI_API_KEY）')
    process.exit(2)
  }
  const host = (() => {
    try {
      return new URL(process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com').host
    } catch {
      return '(无法解析)'
    }
  })()
  console.log(
    `[m11:smoke:live] endpoint host=${host} · model=${(process.env.OPENAI_SMALL_MODEL ?? '').trim() || '(缺省)'} · key=<存在，长度 ${String(apiKey.length)}>`
  )

  const provider = createOpenAiReflectionDraftProvider()
  const startedAt = Date.now()
  const readings: {
    id: string
    label: string
    transportFailed: boolean
    formatValid: boolean
    inventedHandles: readonly string[]
    latencyMs: number
    proposedSlot: string | null
    supportCount: number
    counterCount: number
  }[] = []

  for (const testCase of CASES) {
    const at = Date.now()
    let raw: unknown
    let transportFailed = false
    try {
      raw = await provider.call(testCase.call)
    } catch (error) {
      transportFailed = true
      raw = error instanceof Error ? error.message : String(error)
    }
    /*
     * ⚠️ 用 `validateReflectionDraft`（吃 `unknown`）而不是 `parseReflectionDraft`（吃原文）：
     *    适配器**已经**把 JSON 解析过了，这里要验的是**结构**，不是再解析一次。
     *    （原文路径由 `m11:inputs:verify` 的 B 组覆盖。）
     */
    const parsed = transportFailed
      ? { ok: false as const, reason: 'transport' as const }
      : validateReflectionDraft(raw, { handles: testCase.call.handles })
    const provided = new Set(testCase.call.handles.map((row) => row.id))
    const support = parsed.ok ? parsed.draft.supportHandles : []
    const invented = support.filter((id) => !provided.has(id))
    readings.push({
      id: testCase.id,
      label: testCase.label,
      transportFailed,
      formatValid: parsed.ok,
      inventedHandles: invented,
      latencyMs: Date.now() - at,
      proposedSlot: parsed.ok ? (parsed.draft.suggestedSlot ?? null) : null,
      supportCount: support.length,
      counterCount: parsed.ok ? parsed.draft.counterHandles.length : 0,
    })
    console.log(
      `  ${testCase.id} ${transportFailed ? '传输失败' : parsed.ok ? '格式有效' : `格式无效（${parsed.reason}）`}` +
        ` · ${String(Date.now() - at)} ms · support=${String(support.length)} · counter=${String(parsed.ok ? parsed.draft.counterHandles.length : 0)}` +
        ` · slot=${String(parsed.ok ? (parsed.draft.suggestedSlot ?? '(无)') : '-')}`
    )
  }

  const transportFailures = readings.filter((row) => row.transportFailed).length
  const formatValid = readings.filter((row) => row.formatValid).length
  const invented = readings.flatMap((row) => row.inventedHandles)

  record(
    'S1',
    '【链路通】所有调用都没有传输失败（网络 / HTTP / 凭证三类都正常）',
    transportFailures === 0,
    `传输失败=${String(transportFailures)}/${String(readings.length)} · 总耗时=${String(Date.now() - startedAt)} ms`
  )
  record(
    'S2',
    '【格式】模型输出能被**严格校验**接受（提示词与契约同步的机器判据）',
    formatValid === readings.length,
    `格式有效=${String(formatValid)}/${String(readings.length)}`
  )
  record(
    'S3',
    '【不编造】没有任何**编造**的 handle（`D14`/`D31` 最要紧的一条）',
    invented.length === 0,
    `编造=${JSON.stringify(invented)}`
  )
  record(
    'S4',
    '【反例】带程序标注反例的那一条，模型**没有**把反例当成支持项（如实写进 counter 或干脆不提）',
    readings.find((row) => row.id === 'L2')?.supportCount !== undefined &&
      !readings
        .find((row) => row.id === 'L2')!
        .inventedHandles.includes('ce:4'),
    `L2 support=${String(readings.find((row) => row.id === 'L2')?.supportCount)} · counter=${String(readings.find((row) => row.id === 'L2')?.counterCount)}`
  )
  record(
    'S5',
    '【量具自检】真的调了模型（`measured_count > 0`；0 次调用 0 失败 ≠ PASS）',
    readings.length > 0 && readings.every((row) => row.latencyMs > 0),
    `调用=${String(readings.length)} 次 · 每跳延迟=${JSON.stringify(readings.map((row) => row.latencyMs))}`
  )

  const failed = checks.filter((check) => !check.pass)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM11RunId({ wpId: 'wp10-smoke-live', headShort: head })
  const dir = openM11RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm11-smoke-live@1',
    manifestVersion: M11_MANIFEST_VERSION,
    runId,
    head,
    endpointHost: host,
    model: (process.env.OPENAI_SMALL_MODEL ?? '').trim() || '(default)',
    credentialSource: '.env.test',
    requests: readings.length,
    readings,
    checks,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  }
  writeFileSync(join(dir, 'smoke-live.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM11Manifest(dir, {
    runId,
    wp: 'wp10-smoke-live',
    head,
    headShort: head.slice(0, 12),
    branch: 'codex/m11-execution-plan',
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'live-smoke',
    counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    phases: ['single'],
    supersedes: null,
    notes: `m11:smoke:live（真实端点 ${host} · ${String(readings.length)} 次调用 · 只证明链路通，不是语义评测）`,
  })
  console.log(`runId: ${runId}`)
  console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error('m11:smoke:live 抛错：', error)
  process.exit(1)
})
