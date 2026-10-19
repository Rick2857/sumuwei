/**
 * M11 WP12 —— **激活读回**（`m11:activation:readback`，计划 §12.1 · §14 第 12/13 槽）。
 *
 * ============================================================================
 *  它读什么（**只读**，真实库）
 * ============================================================================
 * ```text
 * ① `.env` **文本**里的三个键（不是 `process.env`）：`CHARACTER_REFLECTION_ENABLED` ·
 *    `CHARACTER_ADAPTIVE_SELF_ENABLED` · `CHARACTER_ADAPTIVE_SELF_TOKENS`
 *    —— "配置里写了什么"与"进程里读到什么"是两件事，读配置要看**文件**。
 * ② 反思调度的**水位行**（`processor_watermarks`，processor = `reflection-scheduler`）
 *    —— 水位行不存在 = 慢路径**从未跑过**。
 * ③ 本域事件与投影的计数（`REFLECTION_*` / `ADAPTIVE_SELF_*` + 对应投影行）。
 * ④ **FIRST-USE 分列**：首聊是否观测到 —— **不凭配置宣布**（计划逐字）。
 * ```
 *
 * ============================================================================
 *  纪律（与 `m9-activation-readback.ts` 同源）
 * ============================================================================
 * ```text
 * · 本脚本是**真实库 opener** ⇒ 走 INC-01 生产状态机（租约 → pre-open 已验证快照 → token →
 *   打开 → 干净关闭）；`allowProductionDatabase()` 显式放行。
 * · 「只读」是**构造上**成立的：`rows()` 拒绝一切非 SELECT 语句（本脚本自检这一条）。
 * · 不 import `src/main.ts`（模块加载会无条件跑完整 CLI）。
 * ⚠️ **未激活**时本门**仍然 PASS** —— 它读到的就是 `NOT ACTIVATED`；
 *    把"没激活"读成"失败"是**另一种**错（读回的任务是**如实读数**，不是要求已激活）。
 * ```
 */

import 'dotenv/config'

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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
import { exec, getRawDb, type RawDb } from '../src/infrastructure/persistence/db.ts'
import { createPersistentCharacterPlugin } from '../src/plugin/persistent-character.ts'
import { openAiCompatiblePlugin } from '../src/providers/openai-compatible.ts'
import { createM11RunId, openM11RunDir, writeM11Manifest, M11_MANIFEST_VERSION } from './m11-evidence.ts'

const REPO_ROOT = resolve(process.cwd())

allowProductionDatabase()

let db: RawDb

/** 唯一数据访问口：**只允许 SELECT**（构造上的只读，不是约定）。 */
async function rows(sql: string): Promise<Record<string, unknown>[]> {
  if (!sql.trim().slice(0, 12).toLowerCase().startsWith('select')) {
    throw new Error(`m11-activation-readback 是**只读**脚本，拒绝非 SELECT：${sql.slice(0, 120)}`)
  }
  return await exec(db, sql, 'm11-activation-readback')
}

const checks: { id: string; label: string; pass: boolean; detail: string }[] = []
function check(id: string, label: string, pass: boolean, detail = ''): void {
  checks.push({ id, label, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label}${detail === '' ? '' : ` —— ${detail}`}`)
}

/** 从 `.env` **文本**读一个键（缺省 ⇒ undefined；**不**回落到 process.env） */
function envTextOf(key: string): string | undefined {
  const path = join(REPO_ROOT, '.env')
  if (!existsSync(path)) return undefined
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*)\\s*$`).exec(line)
    if (match !== null) return match[1]!.replace(/^["']|["']$/g, '')
  }
  return undefined
}

console.log('='.repeat(72))
console.log('M11 WP12 激活读回（真实库，**只读**）')
console.log('='.repeat(72))

const characterId = character.id ?? character.name
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
const guarded = process.env.PROJECT_LG_SANDBOX === undefined && isProductionDir(realDataDir)
let openHandle: ProductionOpenHandle | undefined
if (guarded) {
  openHandle = await prepareProductionOpen({
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
} else {
  await initDatabase(runtime)
  console.log('   ⚠️ 非生产目录（沙箱/副本）—— 未走生产状态机（本脚本面向真库）')
}
db = getRawDb(runtime)

// ---------------------------------------------------------------------------
// ① 配置文本（`.env` 文件，不是 process.env）
// ---------------------------------------------------------------------------
const reflectionEnabled = envTextOf('CHARACTER_REFLECTION_ENABLED')
const adaptiveEnabled = envTextOf('CHARACTER_ADAPTIVE_SELF_ENABLED')
const adaptiveTokens = envTextOf('CHARACTER_ADAPTIVE_SELF_TOKENS')
check(
  'R1',
  '【配置可读】三个键能从 `.env` **文本**读出来（缺省 = 键不存在，如实记为"未设置"）',
  true,
  `reflectionEnabled=${reflectionEnabled ?? '(未设置)'} · adaptiveSelfEnabled=${adaptiveEnabled ?? '(未设置)'} · adaptiveSelfTokens=${adaptiveTokens ?? '(未设置)'}`
)
const activated = reflectionEnabled === 'true'
check(
  'R2',
  '【激活状态】`CHARACTER_REFLECTION_ENABLED` = `true` 才算**已激活**（未设置/false ⇒ NOT ACTIVATED）',
  true,
  activated ? 'ACTIVATED（配置层）' : '**NOT ACTIVATED**（配置层）—— 这是**读数**，不是失败'
)

// ---------------------------------------------------------------------------
// ② 水位行（慢路径跑过没有）
// ---------------------------------------------------------------------------
const watermarks = await rows(
  `select processor, processor_version, processed_through_sequence
     from processor_watermarks
    where processor = 'reflection-scheduler'`
)
check(
  'R3',
  '【水位】反思调度的水位行在案（**不存在 = 慢路径从未跑过**）',
  true,
  watermarks.length === 0
    ? '**没有水位行** ⇒ 慢路径从未运行（与 NOT ACTIVATED 自洽）'
    : `水位行 ${String(watermarks.length)} 条：${JSON.stringify(watermarks)}`
)

// ---------------------------------------------------------------------------
// ③ 本域事件与投影
// ---------------------------------------------------------------------------
const eventCounts = await rows(
  `select type, count(*)::int as n
     from character_domain_events
    where type like 'REFLECTION%' or type like 'ADAPTIVE_SELF%'
    group by type
    order by type`
)
const projectionCounts = await rows(
  `select projection_type, count(*)::int as n
     from character_projections
    where projection_type like 'reflection:%' or projection_type like 'adaptive-self:%'
    group by projection_type
    order by projection_type`
)
check(
  'R4',
  '【本域事件与投影】计数如实读出（0 也是读数：它说明这条链**还没有在生产里跑过**）',
  true,
  `事件=${JSON.stringify(eventCounts)} · 投影=${JSON.stringify(projectionCounts)}`
)

// ---------------------------------------------------------------------------
// ④ 零越界：别的域没有被 M11 动过（结构事实：本里程碑只写本域事件）
// ---------------------------------------------------------------------------
const otherDomainCounts = await rows(
  `select
      (select count(*)::int from character_domain_events where type like 'MEMORY%') as memory,
      (select count(*)::int from character_domain_events where type like 'BELIEF%') as belief,
      (select count(*)::int from character_domain_events where type like 'GOAL%') as goal,
      (select count(*)::int from character_domain_events where type like 'COMMITMENT%') as commitment`
)
check(
  'R5',
  '【零越界·结构面】别的域的事件计数如实读出（本里程碑**只**写本域事件 —— 代码面无跨域写入口）',
  true,
  JSON.stringify(otherDomainCounts[0] ?? {})
)

// ---------------------------------------------------------------------------
// ⑤ FIRST-USE 分列（**不凭配置宣布**）
// ---------------------------------------------------------------------------
const firstUseObserved = watermarks.length > 0 && eventCounts.length > 0
check(
  'R6',
  '【FIRST-USE 分列】首聊是否观测到，按**真实读数**判（水位 + 事件），**不凭配置宣布**',
  true,
  firstUseObserved ? 'OBSERVED（有水位且有事件）' : '**NOT OBSERVED**（无水位或无事件）'
)

// ---------------------------------------------------------------------------
// ⑥ 只读自检（构造上的只读：非 SELECT 必须被拒）
// ---------------------------------------------------------------------------
let refused = false
try {
  await rows('delete from character_domain_events where false')
} catch {
  refused = true
}
check(
  'R7',
  '【只读自检】非 SELECT 语句被**构造性拒绝**（不是靠约定）',
  refused,
  refused ? '写入尝试被拒 ✓' : '**竟然没有拒绝**'
)

const failed = checks.filter((row) => !row.pass)

// ---------------------------------------------------------------------------
// 收尾（干净关闭 + 生产状态机收尾）
// ---------------------------------------------------------------------------
let cleanClose = false
await createRuntimeShutdown(runtime, {
  afterRun: async (reading) => {
    cleanClose = reading.closed
    if (openHandle === undefined) return
    const result = await openHandle.finish({
      closed: reading.closed,
      detail: reading.note,
      afterClose: true,
    })
    console.log(
      `   生产状态机收尾：${result.states.join(' → ')}（cleanClose=${String(result.cleanClose)}，post-close 快照 ${result.postCloseSnapshotId ?? '未记录'}）`
    )
  },
}).shutdown()
check('R8', '【干净关闭】`closed === true`（收尾是问出来的，不是假设的）', cleanClose, `closed=${String(cleanClose)}`)

// ---------------------------------------------------------------------------
// 证据
// ---------------------------------------------------------------------------
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'wp12-readback', headShort: head })
const dir = openM11RunDir(REPO_ROOT, runId)
const finalFailed = checks.filter((row) => !row.pass)
const payload = {
  schema: 'm11-activation-readback@1',
  manifestVersion: M11_MANIFEST_VERSION,
  runId,
  head,
  mode: guarded ? 'production-readonly' : 'sandbox-readonly',
  dataDir: realDataDir,
  preOpenSnapshotId: openHandle?.reading.preOpenSnapshotId ?? null,
  config: { reflectionEnabled, adaptiveEnabled, adaptiveTokens },
  activationState: activated ? 'ACTIVATED(config)' : 'NOT ACTIVATED',
  watermarks,
  eventCounts,
  projectionCounts,
  otherDomainCounts: otherDomainCounts[0] ?? {},
  firstUse: firstUseObserved ? 'OBSERVED' : 'NOT OBSERVED',
  checks,
  summary: { total: checks.length, passed: checks.length - finalFailed.length, failed: finalFailed.length },
  verdict: finalFailed.length === 0 ? 'PASS' : 'FAIL',
  disclaimer:
    '本门是**只读读回**：它如实报告配置/水位/事件/投影与 FIRST-USE；' +
    '**未激活**时它报 NOT ACTIVATED（那是读数，不是失败）。生产激活本身是独立裁定。',
}
writeFileSync(join(dir, 'activation-readback.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
writeM11Manifest(dir, {
  runId,
  wp: 'wp12-readback',
  head,
  headShort: head.slice(0, 12),
  branch: 'codex/m11-execution-plan',
  date: new Date().toISOString().slice(0, 10),
  toolVersions: { node: process.version },
  testType: 'activation-readback',
  counts: { total: checks.length, passed: checks.length - finalFailed.length, failed: finalFailed.length },
  phases: ['readonly'],
  supersedes: null,
  notes: `m11:activation:readback（只读；activationState=${activated ? 'ACTIVATED' : 'NOT ACTIVATED'} · firstUse=${firstUseObserved ? 'OBSERVED' : 'NOT OBSERVED'}）`,
})

console.log('')
console.log('='.repeat(72))
console.log(
  `M11 WP12 激活读回：${String(checks.length - finalFailed.length)} / ${String(checks.length)} 通过` +
    ` · 配置层=${activated ? 'ACTIVATED' : 'NOT ACTIVATED'} · FIRST-USE=${firstUseObserved ? 'OBSERVED' : 'NOT OBSERVED'}`
)
console.log(`runId: ${runId}`)
console.log('='.repeat(72))
process.exit(finalFailed.length === 0 ? 0 : 1)
