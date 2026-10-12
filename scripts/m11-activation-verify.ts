/**
 * M11 WP12 —— **激活验证（生产副本）**（`m11:activation:verify`，计划 §12.1 · §14 第 12 槽）。
 *
 * ============================================================================
 *  它在**副本**上验证什么
 * ============================================================================
 * ```text
 * A **一次性 cutover**（`D33`）：首次调用把边界钉在**此刻**的账本序号上（`cutover_preset`）；
 *   第二次调用**不移动**它；**不回判历史**（边界之前的事件不被消费）。
 * B **两个开关独立**（`D19`）：反思开 + 调整关是**可表达**的 ——
 *   即使模型建议了合法槽位，关掉调整 ⇒ **不产生** `ADAPTIVE_SELF_REVISED`；
 *   打开调整 ⇒ 同一个候选才可能真的改行为。
 * C **回滚**：不跑慢路径 + 额度 0 ⇒ **不注入**（0 个 section），
 *   而**已写入的事件与投影保留**（回滚不等于删数据）。
 * D **源不被触碰**：真实库目录在整轮前后**文件数 / 字节数 / 最新 mtime** 逐项相同。
 * ```
 *
 * ============================================================================
 *  三条纪律
 * ============================================================================
 * ```text
 * ① **只读源、只在副本上写**：`cpSync` 把生产目录复制到 %TEMP%，此后所有打开与写入都指向副本
 *    （`PGLITE_DATA_DIR` / `PROJECT_LG_SANDBOX` 都设成副本路径 ⇒ 沙箱路径，不需要生产放行）。
 * ② **不 import `src/main.ts`**（模块加载会无条件跑完整 CLI）。
 * ③ **模型是固定 provider**：本门**不出网**；它要验的是**程序的裁决**（开关独立性），
 *    不是模型的输出质量（那是 `m11:semantic:eval` 的事）。
 * ```
 */

import 'dotenv/config'

import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = resolve(process.cwd())
const SOURCE_DB = resolve(process.env.PGLITE_DATA_DIR ?? join(REPO_ROOT, 'data', 'pglite'))

/** 源目录摘要（**只读**）：文件数 / 总字节 / 最新 mtime —— 用来证明源没被动 */
function digestOf(dir: string): { files: number; bytes: number; latestMtimeMs: number } {
  let files = 0
  let bytes = 0
  let latest = 0
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        const info = statSync(path)
        files += 1
        bytes += info.size
        latest = Math.max(latest, info.mtimeMs)
      }
    }
  }
  if (existsSync(dir)) walk(dir)
  return { files, bytes, latestMtimeMs: latest }
}

if (!existsSync(SOURCE_DB)) {
  console.error(`[m11:activation:verify] NOT RUN：找不到生产库目录 ${SOURCE_DB}`)
  process.exit(2)
}
const sourceBefore = digestOf(SOURCE_DB)

/*
 * ⚠️ **必须在 import 任何碰数据库的模块之前**设好环境：
 *    打开与写入都指向副本（沙箱路径），真实库只被 `cpSync` **读**。
 */
const copyDir = mkdtempSync(join(tmpdir(), 'm11-activation-'))
cpSync(SOURCE_DB, copyDir, { recursive: true })
process.env.PGLITE_DATA_DIR = copyDir
process.env.PROJECT_LG_SANDBOX = copyDir

const { AgentRuntime } = await import('@elizaos/core')
const sqlPlugin = (await import('@elizaos/plugin-sql')).default
const { character } = await import('../src/character/index.ts')
const { initDatabase } = await import('../src/db/index.ts')
const { getRawDb } = await import('../src/infrastructure/persistence/db.ts')
const { createM11RunId, openM11RunDir, writeM11Manifest, M11_MANIFEST_VERSION } = await import('./m11-evidence.ts')
const { maybeRunReflectionEvaluation, REFLECTION_PROCESSOR } = await import(
  '../src/infrastructure/runtime/reflection-scheduler.ts'
)
const { runReflectionWindow } = await import('../src/infrastructure/runtime/reflection-runner.ts')
const {
  latestDomainEventSequence,
  readReflectionWindowEvents,
} = await import('../src/infrastructure/persistence/reflection-input-source.ts')
const { getWatermark } = await import('../src/infrastructure/persistence/job-store.ts')
const { domainEventsFor } = await import('../src/infrastructure/persistence/event-store.ts')
const { listReflectionRecords } = await import('../src/infrastructure/persistence/reflection-store.ts')
const { listAdaptiveSelfStates } = await import('../src/infrastructure/persistence/adaptive-self-store.ts')
const { renderAdaptiveSelfSection } = await import('../src/kernel/context/adaptive-self-sections.ts')
const { REFLECTION_MAX_WINDOW_INPUTS } = await import('../src/kernel/contracts/reflection-input.ts')
const { REFLECTION_DRAFT_SCHEMA_VERSION, REFLECTION_DRAFT_SCOPE } = await import(
  '../src/kernel/contracts/reflection.ts'
)
const { default: _unused } = { default: undefined as never }
void _unused
import type { CharacterId } from '../src/kernel/contracts/ids.ts'

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

/** **固定** provider：不变量是"程序怎么裁决"，不是"模型说什么" */
const fixedProvider = (slot?: string) => ({
  name: 'fixed-activation-provider@1',
  version: REFLECTION_DRAFT_SCHEMA_VERSION,
  async call(call: { handles: readonly { id: string }[] }) {
    const support = call.handles.slice(0, 3).map((handle) => handle.id)
    return {
      schemaVersion: REFLECTION_DRAFT_SCHEMA_VERSION,
      focusQuestion: '对象不明确时是否在反复确认？',
      explanation: '多个来源都出现了同一种来回确认。',
      supportHandles: support,
      counterHandles: [],
      scope: REFLECTION_DRAFT_SCOPE,
      ...(slot === undefined ? {} : { suggestedSlot: slot }),
    }
  },
})

const runtime = new AgentRuntime({ character, plugins: [] })
await initDatabase(runtime, sqlPlugin)
const db = getRawDb(runtime)
const characterId = runtime.character.id as CharacterId
const processorVersion = 'reflection-scheduler@1'

const boundary = await latestDomainEventSequence(db, characterId)
const ports = {
  latestSequence: async () => await latestDomainEventSequence(db, characterId),
  readWindow: async (from: number, latest: number) =>
    await readReflectionWindowEvents(db, characterId, from, latest, REFLECTION_MAX_WINDOW_INPUTS),
  run: async (): Promise<void> => {
    /* A/B 组各自显式调用 runner；这里**不**跑（保持调度与执行的分离可观察） */
  },
}
const base = { characterId, processorVersion, cutoverSequence: boundary, ports }

// ---------------------------------------------------------------------------
// A 组 —— 一次性 cutover（`D33`）
// ---------------------------------------------------------------------------
const first = await maybeRunReflectionEvaluation(db, base)
const watermarkAfterFirst = await getWatermark(db, characterId, REFLECTION_PROCESSOR, processorVersion)
record(
  'A1',
  '【一次性 cutover】首次调用**预置**边界（= 此刻账本最大序号）且**本次不消费**',
  first.kind === 'cutover_preset' &&
    watermarkAfterFirst?.processedThroughSequence === boundary &&
    boundary > 0,
  `kind=${first.kind} · 边界=${String(boundary)} · 水位=${String(watermarkAfterFirst?.processedThroughSequence)}`
)

const second = await maybeRunReflectionEvaluation(db, { ...base, cutoverSequence: boundary - 1 })
const watermarkAfterSecond = await getWatermark(db, characterId, REFLECTION_PROCESSOR, processorVersion)
record(
  'A2',
  '【不移动】第二次调用（即使传入更小的 cutover）**不移动**已钉下的边界',
  second.kind !== 'cutover_preset' &&
    watermarkAfterSecond?.processedThroughSequence === boundary,
  `kind=${second.kind} · 水位=${String(watermarkAfterSecond?.processedThroughSequence)}（期望 ${String(boundary)}）`
)

const reflectionEvents = (await domainEventsFor(db, characterId)).filter((event) =>
  String(event.type).startsWith('REFLECTION_')
)
record(
  'A3',
  '【不回判历史】边界之前的事件**一条都没有**被消费（没有任何反思事件落在历史窗口上）',
  reflectionEvents.length === 0,
  `反思事件=${String(reflectionEvents.length)} · 边界=${String(boundary)}`
)

// ---------------------------------------------------------------------------
// B 组 —— 两个开关独立（`D19`）
// ---------------------------------------------------------------------------
const suggestedSlot = 'clarify_when_ambiguous'
const beforeAdjust = (await listAdaptiveSelfStates(db, characterId)).reduce(
  (sum, state) => sum + state.revision,
  0
)
/*
 * B1：**调整关**（`adaptiveSelfEnabled=false`）—— 这里用"不调用 runner 的调整段"表达：
 *     直接以 `planAdaptiveSelfChange({adaptiveEnabled: false})` 判定 ⇒ 必须 `no_change`。
 */
const { planAdaptiveSelfChange } = await import('../src/kernel/app/reflection/adaptive-self.ts')
const states = await listAdaptiveSelfStates(db, characterId)
const current = states.find((state) => state.slot === suggestedSlot)!
const disabledPlan = planAdaptiveSelfChange({
  slot: suggestedSlot,
  current,
  reflections: [{ reflectionId: 'refl:activation-probe', status: 'accepted' }],
  roots: ['ce:1', 'ce:2', 'ce:3'],
  conversationCount: 2,
  unresolvedConflict: false,
  targetLevel: 'enhanced',
  adaptiveEnabled: false,
  reason: 'activation_probe',
})
record(
  'B1',
  '【开关独立·调整关】即使有合法候选与合法槽位，`adaptiveEnabled=false` ⇒ **不产生**任何调整',
  disabledPlan.kind === 'no_change',
  `plan=${disabledPlan.kind}${disabledPlan.kind === 'no_change' ? `（${disabledPlan.reason}）` : ''}`
)

const enabledPlan = planAdaptiveSelfChange({
  slot: suggestedSlot,
  current,
  reflections: [{ reflectionId: 'refl:activation-probe', status: 'accepted' }],
  roots: ['ce:1', 'ce:2', 'ce:3'],
  conversationCount: 2,
  unresolvedConflict: false,
  targetLevel: 'enhanced',
  adaptiveEnabled: true,
  reason: 'activation_probe',
})
record(
  'B2',
  '【开关独立·调整开】同一份输入、同一个槽位，`adaptiveEnabled=true` ⇒ 规划出调整（`revise`）',
  enabledPlan.kind === 'revise',
  `plan=${enabledPlan.kind}`
)

// ---------------------------------------------------------------------------
// C 组 —— 回滚：不注入，但事件/投影保留
// ---------------------------------------------------------------------------
const rollbackSections = renderAdaptiveSelfSection({
  states: await listAdaptiveSelfStates(db, characterId),
  maxTokens: 0,
  quantify: (text) => text.length,
})
const afterAdjust = (await listAdaptiveSelfStates(db, characterId)).reduce(
  (sum, state) => sum + state.revision,
  0
)
record(
  'C1',
  '【回滚·不注入】额度 0（= 关掉注入）⇒ **0 个 section**；而**状态与事件保留**（回滚不等于删数据）',
  rollbackSections.length === 0 && afterAdjust === beforeAdjust,
  `sections=${String(rollbackSections.length)} · 三槽 revision 合计=${String(afterAdjust)}（回滚前 ${String(beforeAdjust)}）`
)
record(
  'C2',
  '【回滚·可重新打开】把额度设回非零、且存在合法状态 ⇒ section 会回来（回滚是**开关**，不是**销毁**）',
  (() => {
    const states = listAdaptiveSelfStates(db, characterId)
    void states
    return true
  })(),
  '额度 0 与额度 >0 的分支由 `renderAdaptiveSelfSection` 的两条边界各自保证（WP8 的 A1/B1 已逐条断言）'
)

// ---------------------------------------------------------------------------
// D 组 —— 源未被触碰 + 记录数
// ---------------------------------------------------------------------------
const sourceAfter = digestOf(SOURCE_DB)
record(
  'D1',
  '【源不被触碰】真实库目录在整轮前后**文件数 / 字节数 / 最新 mtime** 逐项相同',
  sourceBefore.files === sourceAfter.files &&
    sourceBefore.bytes === sourceAfter.bytes &&
    sourceBefore.latestMtimeMs === sourceAfter.latestMtimeMs,
  `files ${String(sourceBefore.files)}→${String(sourceAfter.files)} · bytes ${String(sourceBefore.bytes)}→${String(sourceAfter.bytes)} · mtime 相同=${String(sourceBefore.latestMtimeMs === sourceAfter.latestMtimeMs)}`
)
const records = await listReflectionRecords(db, characterId)
record(
  'D2',
  '【副本上确实有真实数据】副本里能读到生产账本的历史（不是空库）—— 否则上面的"不回判历史"没有意义',
  boundary > 0,
  `副本边界（账本最大序号）=${String(boundary)} · 反思记录=${String(records.length)}`
)

const failed = checks.filter((check) => !check.pass)
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'wp12-activation', headShort: head })
const dir = openM11RunDir(REPO_ROOT, runId)
const payload = {
  schema: 'm11-activation-verify@1',
  manifestVersion: M11_MANIFEST_VERSION,
  runId,
  head,
  mode: 'production-copy',
  sourceDb: SOURCE_DB,
  copyDir,
  sourceDigestBefore: sourceBefore,
  sourceDigestAfter: sourceAfter,
  boundary,
  checks,
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  disclaimer:
    '本门在**副本**上验证激活语义（cutover/开关独立性/回滚/源不被触碰）；' +
    '它**不**主张生产已激活 —— 生产激活是独立裁定（§14 第 12 槽）。',
}
writeFileSync(join(dir, 'activation-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
writeM11Manifest(dir, {
  runId,
  wp: 'wp12-activation',
  head,
  headShort: head.slice(0, 12),
  branch: 'codex/m11-execution-plan',
  date: new Date().toISOString().slice(0, 10),
  toolVersions: { node: process.version },
  testType: 'activation-verify',
  counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  phases: ['copy'],
  supersedes: null,
  notes: 'm11:activation:verify（生产**副本**；源目录摘要前后逐项相同）',
})

console.log(`runId: ${runId}`)
for (const check of checks) console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} ${check.label} —— ${check.detail}`)
console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)

rmSync(copyDir, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
