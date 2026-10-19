/**
 * M11 WP12 —— **受控生产激活**（`m11:activate`，计划 §14 第 12 槽 · Activation-Candidate §6）。
 *
 * ============================================================================
 *  用户授权
 * ============================================================================
 * ```text
 * 2026-10-01：用户逐字授权「**允许生产激活**」（此前已授权 activation:verify / readback 两条命令）。
 * ```
 *
 * ============================================================================
 *  它做什么（**顺序是判据**）
 * ============================================================================
 * ```text
 * ① **先在真实库上预置 cutover**（`cutover_preset`）：水位行 = 此刻账本最大序号 ⇒ 不回判历史（`D33`）
 * ② **再写 `.env`** 三个键（`REFLECTION_ENABLED=true` / `ADAPTIVE_SELF_ENABLED=true` / `TOKENS=300`）
 * ③ 干净关闭（INC-01：租约 → pre-open 快照 → token → 开 → cleanClose → post-close 快照）
 *
 * ⚠️ **顺序与候选文件写的相反，这是刻意的**：候选文件写"先改 `.env` 再启动"，
 *    而"先预置、后开开关"是**失败关闭**——预置若失败，`.env` **一个字都不改**，
 *    绝不会出现"开关开了、边界没钉"的状态（那种状态下第一次真实对话会回判历史）。
 * ```
 *
 * ============================================================================
 *  四条硬边界
 * ============================================================================
 * ```text
 * ① **一次性**：水位行已存在 ⇒ **拒绝**（exit 2），不回退、不覆盖、不"再钉一次"。
 * ② **不调模型**：激活只钉边界；端口里的 `run()` 被替换成**拒绝执行**（若真被调用 ⇒ 报错退出），
 *    因此激活过程**一次出站都没有**。
 * ③ **只写一行**：整轮唯一的写入是 `processor_watermarks` 的**一行**（走 `advanceWatermark` 领域路径）；
 *    断言"反思事件 0 条"（激活≠开始反思）。
 * ④ **`.env` 只追加**：三个键**不存在**才追加；已存在且值不同 ⇒ 拒绝（不静默改写既有配置）。
 * ```
 *
 * 用法：`tsx scripts/m11-activate.ts [--dry-run]`
 */

import 'dotenv/config'

import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import { stringToUuid } from '../src/kernel/contracts/uuid.ts'
import type { Character, Plugin } from '../src/infrastructure/runtime/eliza-types.ts'

import { character } from '../src/character/index.ts'
import { allowProductionDatabase, initDatabase } from '../src/db/index.ts'
import { isProductionDir } from '../src/dev/sandbox.ts'
import {
  lastVerifiedSnapshotId,
  prepareProductionOpen,
  productionDataDirOf,
  productionSnapshotRootOf,
  type ProductionOpenHandle,
} from '../src/infrastructure/persistence/production-open-guard.ts'
import {
  closeDatabaseConnection,
  createRuntimeShutdown,
  isDatabaseClosed,
  stopRuntimeServices,
} from '../src/infrastructure/persistence/runtime-shutdown.ts'
import { getRawDb } from '../src/infrastructure/persistence/db.ts'
import { createPersistentCharacterPlugin } from '../src/plugin/persistent-character.ts'
import { openAiCompatiblePlugin } from '../src/providers/openai-compatible.ts'
import type { CharacterId } from '../src/kernel/contracts/ids.ts'
import { createM11RunId, openM11RunDir, writeM11Manifest, M11_MANIFEST_VERSION } from './m11-evidence.ts'
import { maybeRunReflectionEvaluation, REFLECTION_PROCESSOR } from '../src/infrastructure/runtime/reflection-scheduler.ts'
import { latestDomainEventSequence } from '../src/infrastructure/persistence/reflection-input-source.ts'
import { getWatermark } from '../src/infrastructure/persistence/job-store.ts'
import { domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'

const REPO_ROOT = resolve(process.cwd())
const PROCESSOR_VERSION = 'reflection-scheduler@1'

/** `.env` 要追加的三个键（**值**是 Activation-Candidate §1 冻结的那三个） */
const ENV_LINES = [
  'CHARACTER_REFLECTION_ENABLED=true',
  'CHARACTER_ADAPTIVE_SELF_ENABLED=true',
  'CHARACTER_ADAPTIVE_SELF_TOKENS=300',
] as const

const checks: { id: string; label: string; pass: boolean; detail: string }[] = []
function check(id: string, label: string, pass: boolean, detail = ''): void {
  checks.push({ id, label, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label}${detail === '' ? '' : ` —— ${detail}`}`)
}

const dryRun = process.argv.includes('--dry-run')

allowProductionDatabase()
console.log('='.repeat(72))
console.log(`M11 受控生产激活${dryRun ? '（**干跑**：不写库、不改 .env）' : ''}`)
console.log('='.repeat(72))

const characterId = (character.id ?? character.name) as CharacterId
const userId = stringToUuid('user-Alex')
const runtime = createThinHostRuntime({
  character: character,
  conversationLength: 16,
  settings: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
  },
})

const realDataDir = productionDataDirOf()
const realSnapshotRoot = productionSnapshotRootOf()
if (!isProductionDir(realDataDir) || process.env.PROJECT_LG_SANDBOX !== undefined) {
  console.error(`[m11:activate] 拒绝：目标不是生产目录（${realDataDir}）—— 激活只能在真实库上做`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 生产打开（INC-01 状态机）
// ---------------------------------------------------------------------------
const openHandle: ProductionOpenHandle = await prepareProductionOpen({
  dataDir: realDataDir,
  snapshotRoot: realSnapshotRoot,
  operationKind: 'real_db_verify',
  deps: {
    openDatabase: async () => {
      await initDatabase(runtime)
    },
    stopServices: () => stopRuntimeServices(runtime),
    closeDatabase: async () => await closeDatabaseConnection(runtime),
    isDatabaseClosed: () => isDatabaseClosed(runtime),
    lastVerifiedSnapshotId: () => lastVerifiedSnapshotId(realSnapshotRoot),
  },
})
await openHandle.open()
console.log(
  `   生产状态机：${openHandle.reading.states.join(' → ')}（pre-open 快照 ${openHandle.reading.preOpenSnapshotId ?? '未记录'}）`
)
const db = getRawDb(runtime)

// ---------------------------------------------------------------------------
// ① 预置 cutover（**先钉边界，后开开关**）
// ---------------------------------------------------------------------------
const boundary = await latestDomainEventSequence(db, characterId)
const existing = await getWatermark(db, characterId, REFLECTION_PROCESSOR, PROCESSOR_VERSION)
check(
  'A1',
  '【一次性】水位行**尚不存在**（已存在 ⇒ 拒绝，不覆盖、不"再钉一次"）',
  existing === undefined,
  existing === undefined ? '无水位行 ✓' : `**已有水位行**（processedThrough=${String(existing.processedThroughSequence)}）⇒ 拒绝`
)
if (existing !== undefined) {
  console.error('[m11:activate] 拒绝：本里程碑已经激活过（水位行在案）⇒ 不重复钉边界。')
  await createRuntimeShutdown(runtime, {}).shutdown()
  process.exit(2)
}

let schedulingKind = '(干跑未执行)'
if (!dryRun) {
  const scheduling = await maybeRunReflectionEvaluation(db, {
    characterId,
    processorVersion: PROCESSOR_VERSION,
    cutoverSequence: boundary,
    ports: {
      latestSequence: async () => boundary,
      readWindow: async () => [],
      /*
       * ⚠️ 激活过程**不跑模型**：端口里的 `run()` 一旦被调用就报错退出
       *    （`cutover_preset` 路径在它之前就返回 ⇒ 正常情况下永远不会被调用）。
       */
      run: async () => {
        throw new Error('激活过程不应执行窗口 —— 若到这步说明预置没生效（失败关闭）')
      },
    },
  })
  schedulingKind = scheduling.kind
}
const after = await getWatermark(db, characterId, REFLECTION_PROCESSOR, PROCESSOR_VERSION)
const reflectionEvents = (await domainEventsFor(db, characterId)).filter((event) =>
  String(event.type).startsWith('REFLECTION_') || String(event.type).startsWith('ADAPTIVE_SELF_')
)
check(
  'A2',
  '【钉边界】首次调用是 `cutover_preset`，水位 = **此刻**账本最大序号（`D33`：不回判历史）',
  dryRun ? true : schedulingKind === 'cutover_preset' && after?.processedThroughSequence === boundary,
  `kind=${schedulingKind} · 边界=${String(boundary)} · 水位=${String(after?.processedThroughSequence)}`
)
check(
  'A3',
  '【激活 ≠ 开始反思】整轮**唯一**的写入是那一行水位；本域事件 **0** 条（不调模型、不写事件）',
  reflectionEvents.length === 0,
  `本域事件=${String(reflectionEvents.length)}`
)

// ---------------------------------------------------------------------------
// ② 写 `.env`（**只追加**；已存在且值不同 ⇒ 拒绝）
// ---------------------------------------------------------------------------
const envPath = join(REPO_ROOT, '.env')
const envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
const alreadySet = ENV_LINES.filter((line) => {
  const key = line.split('=')[0]!
  return new RegExp(`^\\s*${key}\\s*=`, 'm').test(envText)
})
const conflicting = alreadySet.filter((line) => {
  const [key, value] = line.split('=')
  return !new RegExp(`^\\s*${key}\\s*=\\s*${value}\\s*$`, 'm').test(envText)
})
check(
  'B1',
  '【`.env` 只追加】三个键要么**不存在**（追加），要么已存在且**值一致**（幂等）；值不同 ⇒ 拒绝',
  conflicting.length === 0,
  `已存在=${String(alreadySet.length)} 个 · 值冲突=${JSON.stringify(conflicting)}`
)
if (conflicting.length > 0) {
  console.error('[m11:activate] 拒绝：`.env` 里已有同名键但值不同 ⇒ 不静默改写既有配置。')
  await createRuntimeShutdown(runtime, {}).shutdown()
  process.exit(2)
}
let envAdded: string[] = []
if (!dryRun && alreadySet.length < ENV_LINES.length) {
  const toAdd = ENV_LINES.filter((line) => !alreadySet.includes(line))
  const prefix = envText.endsWith('\n') || envText === '' ? '' : '\n'
  appendFileSync(envPath, `${prefix}# M11 / ADR-085：反思与有限行为调整（2026-10-01 用户授权激活）\n${toAdd.join('\n')}\n`, 'utf8')
  envAdded = [...toAdd]
}
check(
  'B2',
  '【写入结果】`.env` 里三个键都在（本轮的追加行数如实记录；**不打印任何 key**）',
  dryRun ? true : ENV_LINES.every((line) => readFileSync(envPath, 'utf8').includes(line.split('=')[0]!)),
  dryRun ? '(干跑未写)' : `追加 ${String(envAdded.length)} 行`
)

// ---------------------------------------------------------------------------
// ③ 干净关闭
// ---------------------------------------------------------------------------
let cleanClose = false
await createRuntimeShutdown(runtime, {
  afterRun: async (reading) => {
    cleanClose = reading.closed
    const result = await openHandle.finish({ closed: reading.closed, detail: reading.note, afterClose: true })
    console.log(
      `   生产状态机收尾：${result.states.join(' → ')}（cleanClose=${String(result.cleanClose)}，post-close 快照 ${result.postCloseSnapshotId ?? '未记录'}）`
    )
  },
}).shutdown()
check('C1', '【干净关闭】`closed === true`（收尾是问出来的）', cleanClose, `closed=${String(cleanClose)}`)

// ---------------------------------------------------------------------------
// 证据
// ---------------------------------------------------------------------------
const failed = checks.filter((item) => !item.pass)
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'wp12-activate', headShort: head })
const dir = openM11RunDir(REPO_ROOT, runId)
const payload = {
  schema: 'm11-activate@1',
  manifestVersion: M11_MANIFEST_VERSION,
  runId,
  head,
  dryRun,
  authorizedBy: 'R-M11-03（用户 2026-10-01 逐字：允许生产激活）',
  dataDir: realDataDir,
  preOpenSnapshotId: openHandle.reading.preOpenSnapshotId ?? null,
  boundary,
  schedulingKind,
  watermark: after?.processedThroughSequence ?? null,
  reflectionEvents: reflectionEvents.length,
  envAdded,
  envTotalM11Keys: ENV_LINES.length,
  checks,
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  rollback: '删除 .env 里那三行即可（注入与慢路径即停；水位行与已写事件保留，无需回滚数据）',
  firstUse: 'NOT OBSERVED（真实首聊之后才允许改；**不凭配置宣布**）',
}
writeFileSync(join(dir, 'activate.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
writeM11Manifest(dir, {
  runId,
  wp: 'wp12-activate',
  head,
  headShort: head.slice(0, 12),
  branch: 'codex/m11-execution-plan',
  date: new Date().toISOString().slice(0, 10),
  toolVersions: { node: process.version },
  testType: 'activation',
  counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  phases: dryRun ? ['dry-run'] : ['preset', 'env', 'close'],
  supersedes: null,
  notes: `m11:activate（边界=${String(boundary)} · 水位已钉 · .env 追加 ${String(envAdded.length)} 行 · cleanClose=${String(cleanClose)}）`,
})
console.log(`runId: ${runId}`)
console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
process.exit(failed.length === 0 ? 0 : 1)
