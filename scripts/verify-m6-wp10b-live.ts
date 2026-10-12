/**
 * M6 **WP10b 门** —— 最终候选的 Live 验证（计划书 §WP10b L407–411；契约 M6-G11 的 Live 半边）。
 *
 * ============================================================================
 *  两类证据**不许互相假冒**（计划书明文）
 * ============================================================================
 * ```text
 *   production-copy Live（本门）   复制真实库 → 用**生产装配本尊** `src/main.ts` + 真模型跑真实轮次
 *                                  ⇒ 证明"当前受控生产形状"下 M6 的接线与默认行为
 *   合成隔离运行（WP7a/WP7b/WP9a/WP9b）  隔离库 + 真网关 + 真模型，显式接端口
 *                                  ⇒ 证明"激活之后"的摘要语义、预算竞争、长对话质量
 *   ⇒ 本门**不**替代那些门，也不主张"摘要已激活"。
 * ```
 *
 * ⚠️ 关键事实：生产的 `recallBudget` 走 `DEFAULT_CONTEXT_BUDGET`，其 `rollupTokens` **缺省 0**
 *    ⇒ 摘要端口虽然在生产装配里被构造，但**默认不读库、不产 section、不写 trace**。
 *    这与 M5.5 的搜索（先接线、缺省 0、激活另裁，见 ADR-048）是同一个形状。
 *    **生产激活需要一次独立裁定**；本门只证"接线就位 + 默认不激活 + 其余真实链路完好"。
 *
 * 跑法：`pnpm with-test-model pnpm exec tsx scripts/verify-m6-wp10b-live.ts`
 */
import 'dotenv/config'

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { AgentRuntime, type Character } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { PRODUCTION_DB_DIR, isProductionDir } from '../src/dev/sandbox.ts'
import { createDeveloperQueryService } from '../src/infrastructure/dev/query-service.ts'
import { getRawDb, rowsOf } from '../src/infrastructure/persistence/db.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { asCharacterId } from '../src/kernel/contracts/ids.ts'
import { createReporter } from './m4-harness.ts'

const ROOT = resolve('.')
const report = createReporter()
const check = (label: string, pass: boolean, reading: string): void => report.check(label, pass, reading)
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const sha256File = (path: string): string => sha256(readFileSync(path, 'utf8'))
const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
const runId = `m6-wp10b-${head.slice(0, 12)}`
const outDir = join(ROOT, 'artifacts/m6', runId)
const localDir = join(ROOT, 'artifacts/m6/local', runId)
mkdirSync(outDir, { recursive: true })
mkdirSync(localDir, { recursive: true })
console.log(`runId=${runId}`)

report.section('S 前置：真实库只**复制**，副本不是真实库')
if (!existsSync(PRODUCTION_DB_DIR)) {
  console.error(`找不到真实库：${PRODUCTION_DB_DIR}`)
  process.exit(2)
}
const sourceBefore = digestTree(PRODUCTION_DB_DIR)
const work = mkdtempSync(join(tmpdir(), 'project-lg-m6-live-'))
const dbDir = join(work, 'pglite')
writeFileSync(join(localDir, 'work-dir.txt'), `${dbDir}\n`, 'utf8')
cpSync(PRODUCTION_DB_DIR, dbDir, { recursive: true })
const copyBefore = digestTree(dbDir)
/*
 * ⚠️ **父进程也要**把库指向副本：`initDatabase` 的"拒绝写真实库"闸看的就是这两个变量
 *    （第一版只在子进程 env 里设了，于是父进程读 trace 时被闸拦下 —— 闸的行为本身是对的）。
 */
process.env.PGLITE_DATA_DIR = dbDir
process.env.PROJECT_LG_SANDBOX = dbDir
check(
  'S1 · 副本**不是**真实库（`isProductionDir` 逐路径校验）—— 之后所有读写只发生在副本上',
  !isProductionDir(dbDir) && isProductionDir(PRODUCTION_DB_DIR),
  `真实库 ${sourceBefore.measuredCount} 文件 · ${sourceBefore.treeSha256.slice(0, 16)}… ⇒ 副本 ${copyBefore.measuredCount} 文件（${dbDir}）`
)

// ---------------------------------------------------------------------------
// L 真实轮次：生产装配本尊 `src/main.ts` + 真模型（测试端点）
// ---------------------------------------------------------------------------

report.section('L 真实轮次（`src/main.ts` 本尊 · 副本库 · 真模型）')
const tsxCli = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const childEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PGLITE_DATA_DIR: dbDir,
  PROJECT_LG_SANDBOX: dbDir,
})
const say = (input: string): { status: number; reply: string; stdout: string; stderr: string } => {
  const result = spawnSync(process.execPath, [tsxCli, 'src/main.ts', input], {
    cwd: ROOT,
    env: childEnv(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const stdout = String(result.stdout ?? '')
  /*
   * ⚠️ **stderr 必须留下**：第一版只留 stdout，于是"子进程 exit 1 且回复为空"这种红
   *    在证据里**完全不可归因**（2026-09-22 本轮实测踩到：一次瞬时失败让 L1 与 M5.5 的 S1 同时变红，
   *    而日志里连一句错误都没有）。这里只留**尾部若干行**并做长度截断 —— 不摘对话正文。
   */
  const stderr = String(result.stderr ?? '')
  const marker = '苏沐薇:'
  const at = stdout.lastIndexOf(marker)
  const reply = at === -1 ? '' : stdout.slice(at + marker.length).split('\n')[0]!.trim()
  return { status: result.status ?? 1, reply, stdout, stderr }
}

const TURN_INPUT = '今天食堂的土豆丝好难吃。'
const turn = say(TURN_INPUT)
console.log(`   真实一轮：status=${turn.status} · 回复 ${turn.reply.length} 字`)
if (turn.status !== 0) {
  const tail = turn.stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(-6)
    .map((line) => line.slice(0, 200))
  console.log(`   子进程 stderr 尾部（${tail.length} 行）：`)
  for (const line of tail) console.log(`     | ${line}`)
}
check(
  'L1 · 生产装配本尊跑得通：`tsx src/main.ts` 退出码 0，且她**真的说了话**（回复非空）',
  turn.status === 0 && turn.reply.length > 0,
  `status=${turn.status} · reply=${JSON.stringify(turn.reply.slice(0, 40))}` +
    (turn.status === 0
      ? ''
      : ` · stderr 尾部=${JSON.stringify(
          turn.stderr
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '')
            .slice(-3)
            .join(' / ')
            .slice(0, 300)
        )}`)
)

// ---------------------------------------------------------------------------
// G 从**副本**读回现实（Level 2）
// ---------------------------------------------------------------------------

report.section('G 从副本读回 trace / 账本（Level 2）')
const characterId = asCharacterId(character.id ?? character.name)
const owner = entityRef('character', String(characterId))
const runtime = new AgentRuntime({
  character: character as Character,
  plugins: [sqlPlugin],
  conversationLength: 16,
  settings: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'placeholder',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? '',
  },
} as never)
await initDatabase(runtime, sqlPlugin)
const db = getRawDb(runtime)
const service = createDeveloperQueryService({ db, characterId, owner, runtimeId: 'm6-wp10b-live' })

const conversationEvents = Number(
  (
    rowsOf(await db.execute(sql`select count(*)::int as c from conversation_events`))[0] as
      | { c?: number }
      | undefined
  )?.c ?? -1
)
check(
  'G1 · 真实写入链完好：这一轮的用户/助手事件**都**进了副本库的账本',
  conversationEvents >= 2,
  `conversation_events=${conversationEvents}`
)

const tracePage = await service.listTraces({ characterId, limit: 10 })
const newest = tracePage.items[0]
const detail = newest === undefined ? undefined : await service.getTrace({ characterId, traceId: newest.traceId })
const steps = detail?.found === true ? detail.value.steps : []
const contextStep = steps.find((step) => String(step.kind) === 'context_compile')
const attributes = (contextStep?.attributes ?? {}) as Record<string, unknown>
const rollupKeys = Object.keys(attributes).filter((key) => key.startsWith('rollup_'))
const rollupSurvived = attributes.rollup_section_survived

/*
 * ── G2 判据修正（2026-09-22，用户裁定激活摘要）：从"**默认**不激活"改成"**配置与实际一致**" ──
 * 旧判据断言"这一轮一个 `rollup_*` 键都没有"——它证的是**缺省不激活**这一个状态。
 * 用户 2026-09-22 批准激活（`CHARACTER_ROLLUP_TOKENS=400`）后，这条断言在**新**运行里
 * 必然为假，于是它会开始说假话（=判据过期，不是产品坏了）。
 * 修正后的判据在**两种状态**下都成立，且都真的有牙：
 *   额度 = 0 ⇒ 不许有任何 `rollup_*` 键、不许有 `rolling-summary`（缺省不激活，与旧判据同义）
 *   额度 > 0 ⇒ **必须**有 `rollup_*` 键（通电真的生效），且 section 与实际入模一致
 * ⚠️ 这是**判据修正**（不是放宽）：它把"部署状态"从判据里拿掉，换成"配置与行为必须互相印证"。
 *    旧证据（额度 0 时的 PASS）作为历史保留，不覆盖。
 */
const rollupBudgetTokens = Number((process.env.CHARACTER_ROLLUP_TOKENS ?? '0').trim() || '0')
const rollupActivated = Number.isFinite(rollupBudgetTokens) && rollupBudgetTokens > 0
const rollupConsistent = rollupActivated
  ? rollupKeys.length > 0
  : rollupKeys.length === 0 && rollupSurvived === undefined
check(
  'G2 · **配置与实际一致**（行为面）：额度 0 ⇒ 一个 `rollup_*` 键都没有；额度 > 0 ⇒ 必须有 `rollup_*` 键（且无 `rolling-summary` 时不得声称入模）',
  contextStep !== undefined && rollupConsistent,
  `额度=${rollupBudgetTokens}（${rollupActivated ? '已激活' : '未激活'}）· trace=${newest?.traceId ?? '(无)'} · rollup 键=${JSON.stringify(rollupKeys)} · sections=${String(attributes.sections ?? '(无)')}`
)
const mainSource = readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8')
check(
  'G3 · **接线就位**（静态面）：生产装配里**确实**构造了摘要端口（`rollup: this.buildRollupTurnPort()`），只是额度缺省 0 ⇒ 不激活',
  mainSource.includes('rollup: this.buildRollupTurnPort()') &&
    mainSource.includes('recallBudget'),
  '`src/main.ts`：`rollup: this.buildRollupTurnPort()` 在 · 额度来自 `recallBudget`（缺省 `DEFAULT_CONTEXT_BUDGET.rollupTokens = 0`）'
)
const traceJson = JSON.stringify(detail?.found === true ? detail.value : {})
check(
  'G4 · 真实链路隐私边界：trace 里**没有**用户那句原话（正文不进遥测；账本可以记，trace 不行）',
  detail?.found === true && !traceJson.includes(TURN_INPUT),
  `trace 字节=${traceJson.length} · 含原话=${String(traceJson.includes(TURN_INPUT))}`
)

// ---------------------------------------------------------------------------
// X 受影响的 Live 复验（M5.5 / M5.5.1 —— M6 改了 prompt 与上下文）
// ---------------------------------------------------------------------------

report.section('X 受影响的 Live 复验（M5.5 / M5.5.1）')
const liveSpecs: { id: string; cmd: string; covers: string }[] = [
  {
    id: 'm5.5:smoke:live',
    cmd: 'pnpm m5.5:smoke:live',
    covers: 'M5.5 production-copy Live（真实搜索 + 真模型 + `src/main.ts` 本尊）—— 受 M6 的 prompt/上下文改动影响',
  },
  {
    id: 'm5.5.1:smoke:live',
    cmd: 'pnpm m5.5.1:smoke:live',
    covers: 'M5.5.1 语义/归因 Live —— 同样读 M6 改过的上下文装配',
  },
]
const liveReadings: {
  id: string
  cmd: string
  exitCode: number
  seconds: number
  logPath: string
  /** 它自己**具名拒绝**了（外部前置缺失）⇒ 这是 NOT RUN，不是 FAIL */
  refusedByPrerequisite: boolean
  refusalReason: string
  /** 它自己写下的判决行（`N 通过 / M 失败`）—— 让"红"在证据里**可归因**，而不是只有一行 exit code */
  verdictLine: string
  /** 它自己标红的断言标签（只取标签，**不含任何对话正文**） */
  failedLabels: string[]
}[] = []
/**
 * 这两道门在"本机 SearXNG 不可达"时会**具名拒绝**（它们的设计就是失败关闭：
 * 把"服务没起"读成"链路通了"是最坏的假绿）。本门因此必须区分两件事：
 *   · **NOT RUN（外部前置缺失）** —— 它拒绝了，并说出理由
 *   · **FAIL（真的跑了而且红了）**
 * 两者都不算过，但报告里必须**分列**，否则"没测"与"测坏了"会混成一个数。
 */
const PREREQUISITE_REFUSALS = ['provider 不可达', 'SearXNG 不可达']
for (const spec of liveSpecs) {
  const started = Date.now()
  const logPath = join(localDir, `${spec.id.replace(/[:/]/g, '_')}.log`)
  const child = spawnSync(spec.cmd, {
    cwd: ROOT,
    shell: true,
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024,
    env: process.env,
  })
  writeFileSync(logPath, Buffer.concat([child.stdout ?? Buffer.alloc(0), child.stderr ?? Buffer.alloc(0)]))
  const seconds = Math.round((Date.now() - started) / 1000)
  const exitCode = child.status ?? -1
  const logText = readFileSync(logPath, 'utf8')
  const refusalLine = logText
    .split('\n')
    .map((line) => line.trim())
    .find((line) => PREREQUISITE_REFUSALS.some((needle) => line.includes(needle)))
  const refusedByPrerequisite = exitCode !== 0 && refusalLine !== undefined
  /*
   * 红了要**可归因**：记下它自己写的那行判决与它自己标红的断言标签。
   * 只看标签（`❌` 行的前半段），**不摘任何对话正文** —— 与"正文不进遥测"同一条纪律。
   */
  const verdictLine =
    logText
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /通过\s*\/\s*\d+\s*失败/.test(line)) ?? ''
  const failedLabels = logText
    .split('\n')
    .filter((line) => line.includes('❌'))
    .map((line) => line.replace(/^\s*❌\s*/, '').split('  [')[0]!.trim().slice(0, 110))
  liveReadings.push({
    id: spec.id,
    cmd: spec.cmd,
    exitCode,
    seconds,
    logPath: relative(ROOT, logPath),
    refusedByPrerequisite,
    refusalReason: refusalLine ?? '',
    verdictLine,
    failedLabels,
  })
  console.log(
    `   ${exitCode === 0 ? '✅' : refusedByPrerequisite ? '⏭️ ' : '❌'} ${spec.id.padEnd(22)} ` +
      `exit=${exitCode} (${seconds}s)${refusedByPrerequisite ? ` · 外部前置缺失：${refusalLine?.slice(0, 60)}` : ''}` +
      `${exitCode !== 0 && !refusedByPrerequisite ? ` · ${verdictLine} · 红=${failedLabels.length} 项` : ''}`
  )
}
for (const reading of liveReadings) {
  const spec = liveSpecs.find((item) => item.id === reading.id)!
  check(
    `X-${reading.id} · 受影响的 Live 复验：**要么 EXIT 0，要么它自己具名拒绝**（外部前置缺失 = NOT RUN，不是 FAIL）—— ${spec.covers}`,
    reading.exitCode === 0 || reading.refusedByPrerequisite,
    `exit=${reading.exitCode} (${reading.seconds}s) · ${
      reading.refusedByPrerequisite ? `NOT RUN：${reading.refusalReason.slice(0, 80)}` : 'PASS'
    } · 日志=${reading.logPath.split(/[\\/]/).join('/')}`
  )
}

// ---------------------------------------------------------------------------
// C `m4.5:ci:full`：同一冻结候选上已经跑过（WP10a 的回归里），这里只引用它的读数
// ---------------------------------------------------------------------------

report.section('C `m4.5:ci:full` 的读数（引用同一冻结候选上已落盘的回归快照）')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
void pkg
const snapshotCandidates = [
  'artifacts/m6/local/m6-wp10a-866f2fba5f27/readings/inc-01_regression_verify.evidence-snapshot.json',
  'artifacts/m6/local/m6-wp10a-976eeb302fc0/readings/inc-01_regression_verify.evidence-snapshot.json',
]
const snapshotPath = snapshotCandidates.map((p) => resolve(p)).find((p) => existsSync(p))
const snapshot = ((): { head?: string; verdict?: string; steps?: { id: string; exitCode: number }[] } | null => {
  if (snapshotPath === undefined) return null
  try {
    return JSON.parse(readFileSync(snapshotPath, 'utf8')) as never
  } catch {
    return null
  }
})()
const ciFull = (snapshot?.steps ?? []).find((step) => step.id === 'm4.5-ci-full')
check(
  'C1 · `pnpm with-test-model pnpm m4.5:ci:full`（含 Live Smoke）在**同一冻结候选**上 EXIT 0 —— 读数取自回归自己写下的快照',
  ciFull?.exitCode === 0 && snapshot?.verdict === 'PASS',
  `快照=${snapshotPath === undefined ? '(缺)' : relative(ROOT, snapshotPath).split(/[\\/]/).join('/')} · head=${String(snapshot?.head ?? '(缺)').slice(0, 12)} · m4.5-ci-full=${String(ciFull?.exitCode ?? 'NOT RUN')} · 回归 verdict=${String(snapshot?.verdict ?? '(缺)')}`
)

// ---------------------------------------------------------------------------
// R 候选演进后的**受影响重跑**（新增本门文件改变了运行相关树，必须证明影响范围）
// ---------------------------------------------------------------------------

report.section('R 候选演进后的受影响重跑（`git diff` 证明影响范围）')
const diffStat = ((): string => {
  // WP10a 冻结的候选 = 866f2fb；本门是其后新增的一个门脚本 + 一行登记
  const result = spawnSync('git', ['diff', '--stat', '866f2fb..HEAD'], { cwd: ROOT, encoding: 'utf8' })
  return String(result.stdout ?? '').trim()
})()
const diffNames = ((): string[] => {
  const result = spawnSync('git', ['diff', '--name-only', '866f2fb..HEAD'], { cwd: ROOT, encoding: 'utf8' })
  return String(result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
})()
/*
 * ── R1 判据重新基线（2026-09-22）────────────────────────────────────────────
 * 旧判据："相对 WP10a 的冻结候选（`866f2fb`），运行相关树**只动了 `scripts/`**"。
 * 它的**前提**是"M6 收口那一刻的那棵树"。`m6-complete` 打上之后，用户又批准了两件改代码的事：
 *   · `6a3ea3c` 判定指令澄清（`src/kernel/action/search-need-judge.ts`）
 *   · `19b394a` 摘要额度旋钮（`src/kernel/app/flags.ts` + `src/main.ts`）
 *   （另有 `package.json` 的门入口登记）
 * ⇒ 旧判据在**新**运行里必然为假 —— 这不是产品坏了，是**判据过期**。
 * 新判据把"笼统的只动 scripts/"换成**逐文件枚举白名单**：相对 `m6-complete` 以来，
 * 运行相关的改动必须逐条落在白名单里，白名单外的任何一条都要报出来。
 * ⚠️ 这是**判据修正**（更精确），不是放宽：白名单是逐文件枚举的，比前缀判断更严。
 */
const M6_COMPLETE_REF = 'm6-complete'
const POST_M6_ALLOWED: Record<string, string> = {
  'package.json': '门入口登记（m5.5.1:gates / m5.5.1:e2e:verify）',
  'src/kernel/action/search-need-judge.ts': '6a3ea3c 判定指令：分清"可检索性"与"可答性"',
  'src/kernel/app/flags.ts': '19b394a 摘要额度旋钮 CHARACTER_ROLLUP_TOKENS（缺省 0）',
  'src/main.ts': '19b394a 把旋钮喂给 recallBudget.rollupTokens',
  /*
   * ADR-053（2026-09-22，用户显式批准）：冻结上游引擎组 duckduckgo → brave。
   * ⚠️ 这一条是**用户裁定的接收方变更**，不是"为了过 R1 而登记"：
   *    旧组的通用引擎已持续不可用（秒级 `暂停服务: 超时`）⇒ 每次搜索必然 5000ms 超时，
   *    用户看到的永远是"没查到"。带外实测旧组 8010ms/0 条、新组 1188ms/20 条。
   * ⚠️ 登记它**不等于** WP10b 已经 PASS：R1 只是"白名单外零改动"那一条，
   *    X 段的 Live 读数仍须重跑并单独判定。
   */
  /*
   * ADR-054（2026-09-22，用户显式批准）：provider 由本地 SearXNG 换成 Tavily。
   * ⚠️ 这一条同样是**用户裁定的接收方变更**：出站从"本机 127.0.0.1:8080 转发给三个引擎"
   *    变成"直接发给 api.tavily.com"，并**第一次引入凭证**（`M55_TAVILY_SEARCH_API_KEY`）。
   * ⚠️ 旧的两个文件（`search-config.ts` / `searxng-search-provider.ts`）**是删除**，
   *    不是"未登记的改动" —— 它们在 `git diff --name-only` 里以 D 出现，所以**不能**留在
   *    白名单里（第一版留着，于是 R1 把"删掉旧 provider"读成了"白名单外有改动"）。
   * ⚠️ 登记这些**不等于** WP10b 已经 PASS：R1 只是"白名单外零改动"那一条。
   */
  'src/infrastructure/search/tavily-config.ts': 'ADR-054 Tavily provider 的配置与凭证（新增）',
  'src/infrastructure/search/tavily-search-provider.ts': 'ADR-054 Tavily provider 实现（新增）',
  'src/infrastructure/search/recording-fetch.ts': 'ADR-054 记录器只读 body 键名（POST 支持）',
  'src/kernel/contracts/external-evidence.ts':
    'f85fe15 选择器选完**重编号**引用标签（修复"跳过中间条目 ⇒ 标签 E1,E2,E4 ⇒ 契约校验抛错 ⇒ 进程 exit 1"）',
}
/**
 * **预期删除**（2026-09-22 新增的一类，`ADR-054`）。
 *
 * ⚠️ 为什么要单列而不是"把删除也塞进上面的白名单"：
 *    `git diff --name-only m6-complete..HEAD` 对**被删的文件**同样会列出路径
 *    （它以 `D` 状态出现），而上面那张表是"**当前存在**且被允许改动"的清单 ——
 *    一个已经不存在的路径放进去是**自相矛盾**的（第一版就是照抄在那里，
 *    于是判据把"删掉旧 provider"读成了"白名单外有改动"，而它其实是**有意**的删除）。
 *    ⇒ 删除**可以**被允许，但必须**逐个具名**并写明理由：不静默放行，也不冤枉。
 *    任何**不在本表**里的删除仍然会让 R1 变红（这是"没人悄悄删东西"的保证）。
 */
const POST_M6_DELETED: Record<string, string> = {
  'src/infrastructure/search/search-config.ts':
    'ADR-054：本地 SearXNG 的配置模块随 provider 换代删除（单一 provider，不许并存 —— ADR-046 V-2）',
  'src/infrastructure/search/searxng-search-provider.ts':
    'ADR-054：SearXNG provider 实现随换代删除（同上）',
}
const runRelevantPrefixes = ['src', 'scripts', 'evals', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json']
const isRunRelevant = (path: string): boolean =>
  runRelevantPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
const postM6Names = ((): string[] => {
  const result = spawnSync('git', ['diff', '--name-only', `${M6_COMPLETE_REF}..HEAD`], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return String(result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
})()
/*
 * ⚠️ 这里要区分**改动**与**删除**：`--name-only` 两者都会列出来，
 *    而"允许改动"与"允许删除"是两件事（删除少了文件，改动没有）。
 *    用 `--diff-filter=D` 单独取删除集，各自对各自的表。
 */
const deletedNames = new Set(
  String(
    spawnSync('git', ['diff', '--name-only', '--diff-filter=D', `${M6_COMPLETE_REF}..HEAD`], {
      cwd: ROOT,
      encoding: 'utf8',
    }).stdout ?? ''
  )
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
)
const postM6Relevant = postM6Names.filter(
  (path) => isRunRelevant(path) && !path.startsWith('scripts/')
)
const unregisteredDeletions = postM6Relevant.filter(
  (path) => deletedNames.has(path) && POST_M6_DELETED[path] === undefined
)
const nonScriptChanges = postM6Relevant.filter(
  (path) => !deletedNames.has(path) && POST_M6_ALLOWED[path] === undefined
)
check(
  `R1 · 相对 \`m6-complete\` 以来，运行相关的非 scripts/ 改动逐条落在白名单（${Object.keys(POST_M6_ALLOWED).length} 条），` +
    `删除逐条落在预期删除表（${Object.keys(POST_M6_DELETED).length} 条）——两张表之外为零`,
  nonScriptChanges.length === 0 && unregisteredDeletions.length === 0,
  `m6-complete..HEAD 改动=${postM6Names.length} 个 · 运行相关非 scripts/=${postM6Relevant.length} 个 · ` +
    `改动白名单外=${nonScriptChanges.length} 个 · 预期外的删除=${unregisteredDeletions.length} 个` +
    `${nonScriptChanges.length > 0 ? ` · ⚠️ 未登记改动：${nonScriptChanges.join(',')}` : ''}` +
    `${unregisteredDeletions.length > 0 ? ` · ⚠️ 未登记删除：${unregisteredDeletions.join(',')}` : ''}` +
    `（白名单=${Object.keys(POST_M6_ALLOWED).join(' · ')}）`
)
const affectedSteps: { id: string; cmd: string; selfReferenceExempt?: boolean }[] = [
  { id: 'typecheck', cmd: 'pnpm typecheck' },
  { id: 'm6:measurement:verify', cmd: 'pnpm m6:measurement:verify' },
  { id: 'm6:gates', cmd: 'pnpm m6:gates', selfReferenceExempt: true },
]
const affectedReadings: {
  id: string
  exitCode: number
  seconds: number
  logPath: string
  logSha256: string
  /** `m6:gates` 的**自指豁免**是否被证明（见下方 R2 的注释） */
  selfReferenceProven: boolean
  selfReferenceReading: string
}[] = []
for (const step of affectedSteps) {
  const started = Date.now()
  const logPath = join(localDir, `rerun-${step.id.replace(/[:/]/g, '_')}.log`)
  const child = spawnSync(step.cmd, {
    cwd: ROOT,
    shell: true,
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
    env: process.env,
  })
  writeFileSync(logPath, Buffer.concat([child.stdout ?? Buffer.alloc(0), child.stderr ?? Buffer.alloc(0)]))
  const exitCode = child.status ?? -1
  /*
   * ── `m6:gates` 的**自指**问题（判据修正，2026-09-22；不是放宽）────────────────────
   * `wp10b-live` 已被登记为**必选门**，于是 `m6:gates` 的读数里**包含本门自己**；
   * 而本门这一轮的证据（`live.json`）要等**本门跑完**才落盘 ⇒ 运行中的聚合门**不可能**
   * 把它算成通过。第一版判据要求"三步都 EXIT 0"，于是在一个**正确**的聚合读数上永久报假红。
   * 修正后的判据保留原意（"所有**其它**必选门仍然被接受"），并把豁免写成**可证伪的证明义务**：
   *   必须同时满足 ①聚合门确实非 0 ②未运行 = 0 ③未通过 = 1 ④唯一那个具名门**就是** `wp10b-live`。
   * 解析不到具名清单 ⇒ 豁免**不成立**（失败关闭），仍然报红。
   */
  const logText = readFileSync(logPath, 'utf8')
  const unrun = /未运行\s*(\d+)\s*个/.exec(logText)
  const unpassed = /未通过\s*(\d+)\s*个/.exec(logText)
  const namedRaw = /未通过：([^）\n]*)/.exec(logText)?.[1] ?? ''
  const namedList = namedRaw
    .split(/[、,，\s]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
  const selfReferenceProven =
    step.selfReferenceExempt === true &&
    exitCode !== 0 &&
    unrun?.[1] === '0' &&
    unpassed?.[1] === '1' &&
    namedList.length === 1 &&
    namedList[0] === 'wp10b-live'
  affectedReadings.push({
    id: step.id,
    exitCode,
    seconds: Math.round((Date.now() - started) / 1000),
    logPath: relative(ROOT, logPath).split(/[\\/]/).join('/'),
    logSha256: sha256File(logPath),
    selfReferenceProven,
    selfReferenceReading: selfReferenceProven
      ? '未运行 0 个 · 未通过 1 个（唯一 = `wp10b-live` = 本门自己：本门证据在本门跑完之后才落盘）'
      : `未运行=${unrun?.[1] ?? '未解析'} 未通过=${unpassed?.[1] ?? '未解析'} 具名=[${namedList.join(',') || '未解析'}]`,
  })
  console.log(
    `   ${exitCode === 0 ? '✅' : selfReferenceProven ? '➖' : '❌'} ${step.id.padEnd(24)} exit=${exitCode}` +
      `${selfReferenceProven ? '（自指豁免：唯一未通过 = 本门自己）' : ''}`
  )
}
check(
  'R2 · 受影响的三步重跑：`typecheck` / `m6:measurement:verify` 必须 EXIT 0；`m6:gates` 必须 EXIT 0，或**自指豁免被证明**（未运行 0 个且唯一未通过的具名门就是本门自己）',
  affectedReadings.every((reading) => reading.exitCode === 0 || reading.selfReferenceProven),
  affectedReadings
    .map(
      (reading) =>
        `${reading.id}=${reading.exitCode}${reading.selfReferenceProven ? '（自指豁免已证明）' : ''}`
    )
    .join(' · ')
)

// ---------------------------------------------------------------------------
// Z 真实库**只复制**：源摘要前后逐字不变
// ---------------------------------------------------------------------------

report.section('Z 真实库只复制')
const sourceAfter = digestTree(PRODUCTION_DB_DIR)
check(
  'Z1 · 真实 `data/pglite` 在本门前后**逐字不变**（全部读写都在副本上；`isProductionDir` 两道闸都过了）',
  sourceAfter.treeSha256 === sourceBefore.treeSha256 && sourceAfter.measuredCount > 0,
  `${sourceBefore.measuredCount} 文件 · ${sourceBefore.treeSha256.slice(0, 16)}… → ${sourceAfter.treeSha256.slice(0, 16)}…`
)

// ---------------------------------------------------------------------------
// 证据
// ---------------------------------------------------------------------------

const blockedLive = liveReadings.filter((reading) => reading.refusedByPrerequisite)
const failedLive = liveReadings.filter((reading) => reading.exitCode !== 0 && !reading.refusedByPrerequisite)
/**
 * 判定三态（**不许把"没测"写成 PASS**）：
 *   · `PASS`    —— 本门自己的 Live 全绿，且两道受影响复验**都真的跑过并通过**
 *   · `PARTIAL` —— 本门自己的 Live 全绿，但有的复验因**外部前置缺失**而 NOT RUN
 *   · `FAIL`    —— 有复验真的跑了并红了，或本门自身的断言有红
 */
const verdict = report.failed > 0 ? 'FAIL' : failedLive.length > 0 ? 'FAIL' : blockedLive.length > 0 ? 'PARTIAL' : 'PASS'
const payload = {
  schemaVersion: 'm6-wp10b-live@1',
  runId,
  generatedAt: new Date().toISOString(),
  head,
  verdict,
  passed: report.passed,
  failed: report.failed,
  measurementInvalid: 0,
  wp: 'M6 WP10b — 最终候选 Live（production-copy + 受影响 Live 复验）',
  scope:
    '本门证"**当前受控生产形状**"下 M6 的接线就位与默认不激活；"激活之后"的摘要语义由 WP7a/WP7b/WP9a/WP9b 的合成隔离证据承载 —— 两类证据不互相假冒',
  productionActivation: {
    rollup: 'NOT ACTIVATED（`recallBudget.rollupTokens` 缺省 0；激活需要独立裁定，与 M5.5 搜索的 ADR-048 同构）',
    note: '生产装配**已构造**摘要端口（见 G3 静态面），因此激活只需裁定额度，不需要再改接线',
  },
  modelProfile: process.env.OPENAI_LARGE_MODEL ?? '(未知)',
  baseUrlHost: ((): string => {
    try {
      return new URL(process.env.OPENAI_BASE_URL ?? '').host
    } catch {
      return '(无法解析)'
    }
  })(),
  realTurn: { inputChars: TURN_INPUT.length, status: turn.status, replyChars: turn.reply.length },
  trace: { traceId: newest?.traceId ?? null, stepKinds: steps.map((step) => String(step.kind)), rollupKeys },
  containerEvents: conversationEvents,
  liveReverification: liveReadings.map((reading) => ({
    id: reading.id,
    exitCode: reading.exitCode,
    seconds: reading.seconds,
    /** `PASS` / `NOT RUN（外部前置缺失）` / `FAIL` —— 三者分列，不许合成一个数 */
    disposition:
      reading.exitCode === 0
        ? 'PASS'
        : reading.refusedByPrerequisite
          ? 'NOT RUN（外部前置缺失：受影响的 Live 按设计具名拒绝，没有发出任何请求）'
          : 'FAIL（真的跑了而且红了 —— 归因看 verdictLine / failedLabels 与 handoff 里的 provider 诊断）',
    refusalReason: reading.refusalReason,
    /** 真实的红要留下**它自己的判决与它自己标红的断言**（只有标签，没有正文） */
    verdictLine: reading.verdictLine,
    failedLabels: reading.failedLabels,
    logPath: reading.logPath.split(/[\\/]/).join('/'),
    logSha256: sha256File(resolve(reading.logPath)),
  })),
  blockedByPrerequisite: blockedLive.map((reading) => ({
    id: reading.id,
    reason: reading.refusalReason,
    unblock:
      '在本机起 SearXNG（`127.0.0.1:8080`，ADR-047 的 endpoint）后重跑本门的 X 段。' +
      '⚠️ 只"起得来"不够：本门的判据是**证据真的入了模**，因此还要确认**冻结的三个引擎真的返回候选**' +
      '（直连 `/search` 看 `results` 数量与 `unresponsive_engines`；' +
      '本机实例上通用网页引擎返回 `验证码` / `暂停服务: 超时` 时三者合计为 0。' +
      '⚠️ 冻结引擎组已于 2026-09-22 由 ADR-053 改为 `brave,wikipedia,wikidata`）',
  })),
  candidateEvolution: {
    wp10aFrozen: '866f2fb',
    changedFiles: diffNames,
    nonScriptChanges,
    proof:
      '相对 **`m6-complete`**（M6 收口点）：运行相关的非 scripts/ 改动**逐条**落在已登记白名单里' +
      `（${Object.keys(POST_M6_ALLOWED).join(' · ')}）⇒ 白名单外零改动。` +
      '⚠️ 旧口径"相对 WP10a 冻结候选只动 scripts/"的前提是 M6 收口那一刻的树，`m6-complete` 之后已过期（见判据注释）。',
    affectedReruns: affectedReadings,
    diffStat,
  },
  ciFullReference: {
    snapshot: snapshotPath === undefined ? null : relative(ROOT, snapshotPath).split(/[\\/]/).join('/'),
    head: snapshot?.head ?? null,
    verdict: snapshot?.verdict ?? null,
    stepExitCode: ciFull?.exitCode ?? null,
  },
  realDb: {
    before: sourceBefore.treeSha256,
    after: sourceAfter.treeSha256,
    unchanged: sourceAfter.treeSha256 === sourceBefore.treeSha256,
    copyDir: dbDir,
    note: '真实库只被**复制**；所有读写都在副本上（本门没有打开真实库）',
  },
  checks: { passed: report.passed, failed: report.failed, failures: report.failures },
  totals: { checks: report.passed + report.failed, passed: report.passed, failed: report.failed },
}
writeFileSync(join(outDir, 'live.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
console.log(
  `\nM6 WP10b 门：${report.passed} 通过 / ${report.failed} 失败 · 判定=${verdict}` +
    (blockedLive.length > 0
      ? `\n⏭️  外部前置缺失（NOT RUN）：${blockedLive.map((reading) => reading.id).join(', ')}` +
        `\n    解除办法：在本机起 SearXNG（127.0.0.1:8080）后重跑本门的 X 段`
      : '') +
    (failedLive.length > 0
      ? `\n❌ 真的红了的复验（FAIL，不是 NOT RUN）：` +
        failedLive
          .map((reading) => `${reading.id} · ${reading.verdictLine} · 红=${reading.failedLabels.length} 项`)
          .join(' ; ')
      : '') +
    (report.failures.length > 0 ? `\n失败项：${report.failures.join(' | ')}` : '')
)
console.log(`证据：${relative(ROOT, join(outDir, 'live.json')).split(/[\\/]/).join('/')}`)
/*
 * 退出码也**不许把 PARTIAL 装成成功**（本仓库既有惯例：`m6:live` 与 M5.5.1 的失败关闭都用 2）：
 *   0 = PASS · 2 = PARTIAL（有外部前置缺失 ⇒ 没测完）· 1 = FAIL
 */
process.exit(verdict === 'PASS' ? 0 : verdict === 'PARTIAL' ? 2 : 1)
