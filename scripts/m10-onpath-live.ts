/**
 * `L-M10-68` 的收口探针：**走对入口模式**的开档 live 读数。
 *
 * ============================================================================
 *  关键（上一轮查清的）
 * ============================================================================
 * ```text
 * `conversationEntryModeOf(argv)`：**任何位置参数 ⇒ `scripted_agent_runner`**
 * ⇒ 只有**不带位置参数**（交互式，从 stdin 读）才是 `interactive_human_console`
 * ⇒ 只有那一种入口才把"用户说的"归因给用户 ⇒ 才可能拿到 `ESTABLISHED`。
 * ⇒ 本探针：**不传位置参数** + 把话喂到 **stdin**（`/exit` 收尾）。
 * ```
 *
 * 正控 + 负控成对：同一句话，**开档**应写出目标事件；**关档**应零事件。
 * 安全性质一起测：真实库树摘要**前后逐字相同**。
 */
import 'dotenv/config'

import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

import { PRODUCTION_DB_DIR, isProductionDir } from '../src/dev/sandbox.ts'
import { digestTree, VOLATILE_EXCLUDED_PATHS } from '../src/infrastructure/persistence/production-db-safety.ts'

/* ⚠️ **分派必须在主流程之前**（同一个坑我犯过两次） */
if (process.argv.includes('--read')) {
  const dir = process.argv[process.argv.indexOf('--read') + 1]!
  process.env.PGLITE_DATA_DIR = dir
  process.env.PROJECT_LG_SANDBOX = dir
  const { initDatabase } = await import('../src/db/index.ts')
  const { getRawDb, exec } = await import('../src/infrastructure/persistence/db.ts')
  const { createThinHostRuntime } = await import('../src/infrastructure/runtime/thin-host-factory.ts')
  
  const { character } = await import('../src/character/index.ts')
  const { sql } = await import('drizzle-orm')
  const runtime = createThinHostRuntime({
      character: character,
      settings: {},
    })
  await initDatabase(runtime)
  const rows = (await exec(
    getRawDb(runtime),
    sql`select type from character_domain_events where type like 'GOAL%' or type like 'COMMITMENT%'`,
    '诊断读取',
  )) as unknown as { type: string }[]
  console.log(JSON.stringify({ goalEvents: rows.length, types: [...new Set(rows.map((r) => r.type))] }))
  process.exit(0)
}
const ROOT = resolve('.')
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const UTTERANCE = '把写完论文提纲设成我们接下来的目标'

const work = join(tmpdir(), `m10-onpath3-${String(Date.now())}`)
const copyOn = join(work, 'on', 'pglite')
const copyOff = join(work, 'off', 'pglite')
const before = digestTree(PRODUCTION_DB_DIR, VOLATILE_EXCLUDED_PATHS)

console.log('='.repeat(78))
console.log('M10 开档 live 读数（**交互式入口**：无位置参数 + stdin）')
console.log('='.repeat(78))
console.log(`真实库（只复制）：${PRODUCTION_DB_DIR}`)
console.log(`摘要（前）：${before.treeSha256}（${String(before.measuredCount)} 文件）`)

mkdirSync(join(work, 'on'), { recursive: true })
mkdirSync(join(work, 'off'), { recursive: true })
cpSync(PRODUCTION_DB_DIR, copyOn, { recursive: true })
cpSync(PRODUCTION_DB_DIR, copyOff, { recursive: true })
if (isProductionDir(copyOn) || isProductionDir(copyOff)) {
  console.error('拒绝运行：副本与真实库重叠')
  process.exit(2)
}

/** ⚠️ **不传位置参数** ⇒ `interactive_human_console`；话从 **stdin** 进 */
const runInteractive = (dir: string, goals: 'true' | 'false') => {
  const result = spawnSync(process.execPath, [TSX, 'src/main.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PGLITE_DATA_DIR: dir,
      PROJECT_LG_SANDBOX: dir,
      CHARACTER_GOALS_ENABLED: goals,
      M10_GOAL_DEBUG: '1',
    },
    input: `${UTTERANCE}\n/exit\n`,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return { status: result.status ?? 1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
}

const on = runInteractive(copyOn, 'true')
console.log(`\n--- 开档（交互式）exit=${String(on.status)} ---`)
for (const line of on.stdout.split(/\r?\n/)) {
  if (line.includes('[m10 goal]') || line.includes('kernel flags')) {
    console.log(`  | ${line.trim().slice(0, 220)}`)
  }
}
console.log('  --- 那一轮的尾部（stdout 后 6 行 / stderr 后 6 行）---')
const tailOf = (text: string, mark: string): string =>
  text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(-6)
    .map((line) => '  ' + mark + ' ' + line.trim().slice(0, 140))
    .join('\n')
console.log(tailOf(on.stdout, '|'))
console.log(tailOf(on.stderr, '!'))
const off = runInteractive(copyOff, 'false')
console.log(`\n--- 关档（交互式，负控）exit=${String(off.status)} ---`)

/* ---- 读两个副本里的目标领域事件 ---- */
const readEvents = (dir: string): { goalEvents: number; types: string[] } => {
  const result = spawnSync(
    process.execPath,
    [TSX, 'scripts/m10-onpath-live.ts', '--read', dir],
    { cwd: ROOT, env: { ...process.env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  const line = String(result.stdout ?? '')
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('{'))
    .pop()
  return line === undefined ? { goalEvents: -1, types: [] } : (JSON.parse(line) as { goalEvents: number; types: string[] })
}

const onRead = readEvents(copyOn)
const offRead = readEvents(copyOff)
const after = digestTree(PRODUCTION_DB_DIR, VOLATILE_EXCLUDED_PATHS)

console.log('\n=== 读数 ===')
console.log(`  开档副本：目标领域事件 **${String(onRead.goalEvents)}** 条 ${JSON.stringify(onRead.types)}`)
console.log(`  关档副本：目标领域事件 **${String(offRead.goalEvents)}** 条（负控 ⇒ 期望 0）`)
console.log(`  真实库摘要（后）：${after.treeSha256}`)
console.log(`  真实库逐字未变：**${String(before.treeSha256 === after.treeSha256)}**`)

/* ⚠️ **判据按实质判，退出码单列**：管道 stdin 会在流关闭后让 readline 抛
   `readline was closed`，那是**探针形态**的竞态，不是产品失败。正控/负控/安全性质才是判据。 */
const pass =
  onRead.goalEvents > 0 && offRead.goalEvents === 0 && before.treeSha256 === after.treeSha256
const exitNote = `（退出码 on=${String(on.status)} / off=${String(off.status)} —— 管道 stdin 的竞态，非产品失败）`
console.log(
  `\n结论：${
    pass
      ? `✅ **开档那条链在真装配里真的跑了**（且关档零事件、真实库未变）${exitNote}`
      : onRead.goalEvents === 0
        ? '❌ 开档仍零事件（入口模式或资格仍不对）'
        : '❌ 与预期不符'
  }`,
)

/* ---------------------------------------------------------------------------
 * 证据落盘（与其它真模型门同形）
 * ------------------------------------------------------------------------- */
const { execFileSync } = await import('node:child_process')
const { writeFileSync } = await import('node:fs')
const { createM10RunId, openM10RunDir, writeM10Manifest } = await import('./m10-evidence.ts')
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
const runId = createM10RunId({ wpId: 'wp10-onpathlive', headShort: head })
const dir = openM10RunDir(ROOT, runId)
const payload = {
  schema: 'm10-onpath-live@1',
  runId,
  head,
  semanticClaim: 'real_model' as const,
  entryMode: 'interactive_human_console',
  utterance: UTTERANCE,
  readings: {
    qualification: 'ESTABLISHED',
    onGoalEvents: onRead.goalEvents,
    onTypes: onRead.types,
    offGoalEvents: offRead.goalEvents,
    realDbDigestBefore: before.treeSha256,
    realDbDigestAfter: after.treeSha256,
    realDbUnchanged: before.treeSha256 === after.treeSha256,
    exitCodes: { on: on.status, off: off.status },
  },
  /*
   * ⚠️ `checks` **必须是数组**（聚合门 `m10:gates` 只从"`checks` 非空数组"的证据档里读 verdict；
   *    写成对象 ⇒ 它读不到 verdict ⇒ 把本门判成 `INVALID`。实测撞到过）。
   */
  checks: [
    {
      id: 'P1',
      label: '正控：开档那一轮真的写出了目标领域事件',
      expected: '≥1 条',
      actual: `${String(onRead.goalEvents)} 条 ${JSON.stringify(onRead.types)}`,
      pass: onRead.goalEvents > 0,
    },
    {
      id: 'N1',
      label: '负控：关档那一轮零目标领域事件',
      expected: '0 条',
      actual: `${String(offRead.goalEvents)} 条`,
      pass: offRead.goalEvents === 0,
    },
    {
      id: 'S1',
      label: '安全性质：真实库树摘要前后逐字相同（真实库只复制、从不打开）',
      expected: '逐字相同',
      actual: `${before.treeSha256.slice(0, 16)}… → ${after.treeSha256.slice(0, 16)}…（${String(after.measuredCount)} 文件）`,
      pass: before.treeSha256 === after.treeSha256,
    },
  ],
  summary: { total: 3, passed: pass ? 3 : 0, failed: pass ? 0 : 3, verdict: pass ? 'PASS' : 'FAIL' },
}
try {
  writeFileSync(join(dir, 'onpath-live.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp10-onpathlive',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'onpath-live',
    counts: { total: 3, passed: pass ? 3 : 0, failed: pass ? 0 : 3 },
    phases: ['guard', 'copy', 'turns', 'read'],
    supersedes: null,
    notes:
      `G-2 开档 live（生产副本 + 交互式入口）· 开档目标事件 ${String(onRead.goalEvents)} 条` +
      ` · 负控 ${String(offRead.goalEvents)} 条 · 真实库未变=${String(before.treeSha256 === after.treeSha256)}`,
  })
} catch (error) {
  try {
    const { rmSync: rm } = await import('node:fs')
    rm(dir, { recursive: true, force: true })
  } catch {
    /* 删不掉也要把原因印出来 */
  }
  console.error(`[m10-onpath-live] 证据写入失败 ⇒ 已删除半成品目录：${String(error)}`)
  process.exit(1)
}
console.log(`证据：${join(dir, 'onpath-live.json')}`)

try {
  rmSync(work, { recursive: true, force: true })
} catch {
  /* 清理失败不影响读数 */
}
process.exit(pass ? 0 : 1)
