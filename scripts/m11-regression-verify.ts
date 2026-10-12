/**
 * M11 WP11 —— **回归证据消费门**（`m11:regression:verify`，计划 §12.1）。
 *
 * ============================================================================
 *  计划 §12.1 对它的要求
 * ============================================================================
 * ```text
 * 「`m11:regression:verify` | **已跑回归证据消费** | **受影响门** · **manifest** · **退出码**」
 * ```
 *
 * ============================================================================
 *  两种模式（**先记录、再消费**；判据与跑分离）
 * ============================================================================
 * ```text
 * `--record`  真的**跑**一遍受影响门清单，把每道门的 argv / 退出码 / 耗时 / 输出大小 /
 *             输出哈希写进**账本**（`artifacts/m11/local/regression-<head>.json`，gitignored）
 *             —— 它**不**下结论（跑与判分离：判据在下面那一半）。
 * （缺省）    **只读**账本 + 已落盘 manifest，逐条核对：
 *               ① 清单**齐全**（少跑一道 = NOT RUN，不是 PASS）
 *               ② 退出码为 0，**或**在显式"已知非零"白名单里（带具名理由，例如 `L-M11-13`）
 *               ③ 账本 head **等于当前 HEAD**（不等于 ⇒ 读数**过期** ⇒ INVALID）
 *               ④ 对**写证据**的 M11 门：manifest 的 head 与账本一致，且 counts 与退出码自洽
 *               ⑤ 账本形状是**机器写的**（schema + 逐条 argv/exitCode/durationMs + 输出哈希）
 *             —— "手写一张全绿表格"过不了这几条。
 * ```
 *
 * ⚠️ 本门**不**发明新门：清单里的每一道都是既有命令（AGENTS §5 的受影响面 + M11 各门）。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { config as loadTestEnv } from 'dotenv'

import { createM11RunId, openM11RunDir, writeM11Manifest, M11_MANIFEST_VERSION } from './m11-evidence.ts'

/*
 * ⚠️ **必须加载 `.env.test`**（AGENTS §8.1：测试端点）—— 原因是一条**实测出来的**环境依赖：
 *    `m4.5:measurement:verify` 会 spawn `src/main.ts` 当"生产 CLI"读回动作记录，
 *    而 `src/main.ts` 在**没有 `OPENAI_API_KEY`** 时直接拒绝启动
 *    （实测报「缺少 OPENAI_API_KEY…」）⇒ 子进程**空输出** ⇒ 该门报"读回 0 条"。
 *    ⚠️ 本工作树**没有 `.env`**（只有 `.env.test`）⇒ 不加载它就必然假红。
 *    实测对照：同一道门在**有 key** 的环境里 **8/8 PASS** ⇒ 判定它不是代码回归。
 */
loadTestEnv({ path: '.env.test', override: true })

const REPO_ROOT = resolve(process.cwd())
const TSX = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const LOCAL_DIR = join(REPO_ROOT, 'artifacts', 'm11', 'local')
const LOG_DIR = join(LOCAL_DIR, 'regression-logs')

interface GateEntry {
  /** 公开命令名（`package.json` 里应当有它；没有则记 entry 文件） */
  readonly command: string
  readonly entry: string
  /** 额外的命令行参数（例如 `tsc --noEmit`） */
  readonly args?: readonly string[]
  /** 用哪个 runner：`tsx`（缺省）或 `node`（例如 tsc 的 CLI） */
  readonly runner?: 'tsx' | 'node'
  /** 为什么它在"受影响面"里 */
  readonly reason: string
  /** 已知的非零退出码（必须带具名理由；不写 = 期望 0） */
  readonly acceptedNonZero?: { readonly code: number; readonly why: string }
  /** 该门写 M11 证据时的 wp 标识（用于与 manifest 对账） */
  readonly evidenceWp?: string
  /**
   * 该门是**基线捕获**（不是判决）：它的 `counts.failed` 记的是"开工前的断言现在不成立"
   * ⇒ 与退出码**不必**自洽（WP0 的 `before` 阶段按设计 exit 0 而 failed=4）。
   */
  readonly capture?: boolean
}

/**
 * **受影响门清单**（AGENTS §5 对 M11 改动面的映射 + M11 自己的门）。
 *
 * ⚠️ 顺序 = 先旧链后新链：旧链红了就没必要再看新链。
 */
const GATE_SET: readonly GateEntry[] = [
  { command: 'kernel:test', entry: 'scripts/kernel-tests.ts', reason: 'contracts/policies/projections 改动' },
  { command: 'kernel:verify', entry: 'scripts/verify-phase-c.ts', reason: '内核边界与依赖方向' },
  { command: 'm4:test', entry: 'scripts/kernel-tests-memory.ts', reason: 'Memory Kernel 回归锁' },
  { command: 'm4:verify', entry: 'scripts/verify-m4-persistence.ts', reason: 'M4 持久化与投影' },
  { command: 'm4.5:test', entry: 'scripts/kernel-tests-action.ts', reason: 'flags.ts 改动（开关必须被真的消费）' },
  { command: 'm5:test', entry: 'scripts/kernel-tests-recall.ts', reason: 'recall/selector.ts 改动（预算分类）' },
  { command: 'm3.5:test', entry: 'scripts/future-compat-tests.ts', reason: 'turn-gateway.ts 改动（prompt 逐字节基线）' },
  { command: 'eval:dryrun', entry: 'scripts/verify-dry-run-silence.ts', reason: '干跑静默（prompt 相关）' },
  { command: 'm10:context:verify', entry: 'scripts/m10-context-verify.ts', reason: 'M10 预算字段被追加（判据已修订）' },
  { command: 'm10:m11:verify', entry: 'scripts/m10-m11-verify.ts', reason: 'M10 只读面边界' },
  { command: 'm11:wp0:verify', entry: 'scripts/m11-wp0-verify.ts', reason: 'M11 WP0 基线（**捕获**，非判决）', evidenceWp: 'wp0', capture: true },
  { command: 'm11:lineage:verify', entry: 'scripts/m11-lineage-verify.ts', reason: 'M11 派生链', evidenceWp: 'wp2' },
  { command: 'm11:inputs:verify', entry: 'scripts/m11-inputs-verify.ts', reason: 'M11 输入装配', evidenceWp: 'wp3' },
  { command: 'm11:policy:verify', entry: 'scripts/m11-policy-verify.ts', reason: 'M11 放行口', evidenceWp: 'wp4' },
  { command: 'm11:adaptive:verify', entry: 'scripts/m11-adaptive-verify.ts', reason: 'M11 行为调整', evidenceWp: 'wp5' },
  { command: 'm11:invalidation:verify', entry: 'scripts/m11-invalidation-verify.ts', reason: 'M11 失效与同轮阻断', evidenceWp: 'wp6' },
  { command: 'm11:recovery:verify', entry: 'scripts/m11-recovery-verify.ts', reason: 'M11 任务/水位/晚写闸门', evidenceWp: 'wp7' },
  { command: 'm11:context:verify', entry: 'scripts/m11-context-verify.ts', reason: 'M11 注入与事实包', evidenceWp: 'wp8' },
  { command: 'm11:measurement:verify', entry: 'scripts/m11-measurement-verify.ts', reason: 'M11 量具有效性 + 语料', evidenceWp: 'wp9-measurement' },
  { command: 'm11:observability:verify', entry: 'scripts/m11-observability-verify.ts', reason: 'M11 可观测性与隐私', evidenceWp: 'wp11-observability' },
  { command: 'm11:e2e:verify', entry: 'scripts/m11-e2e-verify.ts', reason: 'M11 端到端链', evidenceWp: 'wp9-e2e' },
  { command: 'm11:docs:verify', entry: 'scripts/m11-docs-verify.ts', reason: '文档与命令注册纪律', evidenceWp: 'wp11-docs' },
  {
    command: 'm11:gates',
    entry: 'scripts/m11-gates.ts',
    reason: '只读聚合（证据消费）',
    /*
     * ⚠️ **按设计非零**：聚合门对 FAIL/INVALID 非零，而当前聚合里**真的**有一道 FAIL
     *    （`wp10-smoke-live` 4/5 —— 门槛跑之前写下，看到 2/3 后不改）。
     *    ⇒ 这里声明的是"它非零是**因为**它如实报告了那个 FAIL"，**不是**"它的非零可以忽略"。
     */
    acceptedNonZero: {
      code: 1,
      why: '聚合门按设计对 FAIL 非零；当前那一 FAIL 是 wp10-smoke-live（已登记，非本门故障）',
    },
  },
  {
    command: 'm5:budget:verify',
    entry: 'scripts/verify-m5-budget.ts',
    reason: 'M5 预算门（**继承缺陷** `L-M11-13`：真实 recall 链路候选为空）',
    acceptedNonZero: { code: 1, why: 'L-M11-13：pre-WP8 实测复现同样的失败 ⇒ 归 M5/M9.5 线，非 M11 引入' },
  },
]

/**
 * **完整收口清单**（计划 §13：`pnpm m4.5:ci` 的**扁平展开** + M11 各门）。
 *
 * ⚠️ 为什么扁平展开而不是 `pnpm m4.5:ci`：本机的 `pnpm` 被供应链校验阻塞
 *    （`L-M11-08`）⇒ 逐条直接跑入口文件；**逐条**也便于把退出码逐条落进账本。
 * ⚠️ `m4.5:gates`（只读汇总）排在最后：它读的就是前面那些门刚落的证据。
 */
const GATE_SET_FULL: readonly GateEntry[] = [
  { command: 'typecheck', entry: 'node_modules/typescript/bin/tsc', args: ['--noEmit'], runner: 'node', reason: 'AGENTS §5 第一条' },
  { command: 'kernel:test', entry: 'scripts/kernel-tests.ts', reason: 'm3:ci' },
  { command: 'kernel:test:identity', entry: 'scripts/kernel-tests-identity.ts', reason: 'm3:ci' },
  { command: 'kernel:test:conversation', entry: 'scripts/kernel-tests-conversation.ts', reason: 'm3:ci' },
  { command: 'kernel:verify', entry: 'scripts/verify-phase-c.ts', reason: 'm3:ci' },
  { command: 'm3:verify', entry: 'scripts/verify-m3-persistence.ts', reason: 'm3:ci' },
  { command: 'm3:migrate-gate', entry: 'scripts/verify-migrate-gate.ts', reason: 'm3:ci' },
  { command: 'm3:seed-check', entry: 'scripts/seed-check.ts', reason: 'm3:ci' },
  { command: 'eval:scenarios', entry: 'scripts/eval-scenarios.ts', reason: 'm3:ci' },
  { command: 'eval:m3', entry: 'scripts/eval-m3.ts', reason: 'm3:ci' },
  { command: 'eval:telemetry', entry: 'scripts/verify-telemetry.ts', reason: 'm3:ci' },
  { command: 'eval:otlp', entry: 'scripts/verify-otlp-compat.ts', reason: 'm3:ci' },
  { command: 'eval:dryrun', entry: 'scripts/verify-dry-run-silence.ts', reason: 'm3:ci' },
  { command: 'eval:providers', entry: 'scripts/verify-provider-whitelist.ts', reason: 'm3:ci' },
  { command: 'm3.5:test', entry: 'scripts/future-compat-tests.ts', reason: 'm3.5:ci（prompt 逐字节）' },
  { command: 'm3.5:verify', entry: 'scripts/verify-m3.5-persistence.ts', reason: 'm3.5:ci' },
  { command: 'm4:test', entry: 'scripts/kernel-tests-memory.ts', reason: 'm4:ci' },
  { command: 'm4:verify', entry: 'scripts/verify-m4-persistence.ts', reason: 'm4:ci' },
  { command: 'm4:faults', entry: 'scripts/verify-m4-faults.ts', reason: 'm4:ci' },
  { command: 'm4:restart:verify', entry: 'scripts/verify-m4-restart.ts', reason: 'm4:ci' },
  { command: 'm4:isolation:verify', entry: 'scripts/verify-m4-isolation.ts', reason: 'm4:ci' },
  { command: 'm4:restore:verify', entry: 'scripts/verify-m4-restore.ts', reason: 'm4:ci' },
  { command: 'm4:mutation-safety:verify', entry: 'scripts/verify-m4-mutation-safety.ts', reason: 'm4:ci' },
  { command: 'm4:nl-mutation:verify', entry: 'scripts/verify-m4-nl-mutation.ts', reason: 'm4:ci' },
  { command: 'eval:m4', entry: 'scripts/eval-m4.ts', reason: 'm4:ci' },
  { command: 'eval:m4:promptfoo:build', entry: 'scripts/build-m4-promptfoo-config.ts', reason: 'm4:ci（promptfoo 三步之一）' },
  { command: 'eval:m4:promptfoo:assertions', entry: 'scripts/verify-m4-promptfoo-assertions.ts', reason: 'm4:ci（promptfoo 三步之二）' },
  { command: 'eval:m4:promptfoo:run', entry: 'scripts/run-m4-promptfoo.ts', reason: 'm4:ci（promptfoo 三步之三）' },
  { command: 'm4.5:test', entry: 'scripts/kernel-tests-action.ts', reason: 'm4.5:ci' },
  { command: 'm4.5:verify', entry: 'scripts/verify-m4.5-pipeline.ts', reason: 'm4.5:ci' },
  { command: 'm4.5:measurement:verify', entry: 'scripts/verify-m4.5-measurement.ts', reason: 'm4.5:ci' },
  { command: 'm4.5:nl-action:verify', entry: 'scripts/verify-m4.5-nl-action.ts', reason: 'm4.5:ci' },
  { command: 'm4.5:audit', entry: 'scripts/m4.5-audit.ts', reason: 'm4.5:ci' },
  { command: 'm4.5:gates', entry: 'scripts/m4.5-gate-results.ts', reason: 'm4.5:ci（只读汇总，排最后）' },
  // M11 自己的门（离线）
  { command: 'm11:wp0:verify', entry: 'scripts/m11-wp0-verify.ts', reason: 'M11 WP0 基线（**捕获**，非判决）', evidenceWp: 'wp0', capture: true },
  { command: 'm11:lineage:verify', entry: 'scripts/m11-lineage-verify.ts', reason: 'M11 派生链', evidenceWp: 'wp2' },
  { command: 'm11:inputs:verify', entry: 'scripts/m11-inputs-verify.ts', reason: 'M11 输入装配', evidenceWp: 'wp3' },
  { command: 'm11:policy:verify', entry: 'scripts/m11-policy-verify.ts', reason: 'M11 放行口', evidenceWp: 'wp4' },
  { command: 'm11:adaptive:verify', entry: 'scripts/m11-adaptive-verify.ts', reason: 'M11 行为调整', evidenceWp: 'wp5' },
  { command: 'm11:invalidation:verify', entry: 'scripts/m11-invalidation-verify.ts', reason: 'M11 失效与同轮阻断', evidenceWp: 'wp6' },
  { command: 'm11:recovery:verify', entry: 'scripts/m11-recovery-verify.ts', reason: 'M11 任务/水位/晚写闸门', evidenceWp: 'wp7' },
  { command: 'm11:context:verify', entry: 'scripts/m11-context-verify.ts', reason: 'M11 注入与事实包', evidenceWp: 'wp8' },
  { command: 'm11:measurement:verify', entry: 'scripts/m11-measurement-verify.ts', reason: 'M11 量具有效性 + 语料', evidenceWp: 'wp9-measurement' },
  { command: 'm11:observability:verify', entry: 'scripts/m11-observability-verify.ts', reason: 'M11 可观测性与隐私', evidenceWp: 'wp11-observability' },
  { command: 'm11:e2e:verify', entry: 'scripts/m11-e2e-verify.ts', reason: 'M11 端到端链', evidenceWp: 'wp9-e2e' },
  { command: 'm11:long:verify', entry: 'scripts/m11-long-verify.ts', reason: 'M11 离线长轨迹（200 轮）', evidenceWp: 'wp9-long-200' },
  { command: 'm11:docs:verify', entry: 'scripts/m11-docs-verify.ts', reason: '文档与命令注册纪律', evidenceWp: 'wp11-docs' },
  { command: 'm11:gates', entry: 'scripts/m11-gates.ts', reason: '只读聚合（证据消费）', acceptedNonZero: { code: 1, why: '聚合门按设计对 FAIL 非零；当前那一 FAIL 是 wp10-smoke-live（已登记）' } },
  {
    command: 'm5:budget:verify',
    entry: 'scripts/verify-m5-budget.ts',
    reason: 'M5 预算门（**继承缺陷** `L-M11-13`）',
    acceptedNonZero: { code: 1, why: 'L-M11-13：pre-WP8 实测复现同样的失败 ⇒ 归 M5/M9.5 线，非 M11 引入' },
  },
]

const SETS: Readonly<Record<string, readonly GateEntry[]>> = {
  affected: GATE_SET,
  full: GATE_SET_FULL,
}

interface LedgerEntry {
  command: string
  entry: string
  reason: string
  argv: readonly string[]
  exitCode: number | null
  durationMs: number
  stdoutBytes: number
  logHash: string
  logPath: string
}

interface Ledger {
  schema: 'm11-regression-ledger@1'
  /** 用的是哪一份清单（`affected` / `full`）—— 消费时必须用**同一份** */
  set: string
  head: string
  recordedAt: string
  gates: readonly LedgerEntry[]
}

function ledgerPath(head: string): string {
  return join(LOCAL_DIR, `regression-${head.slice(0, 12)}.json`)
}

function headOf(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
}

/** 用哪一份清单：`--set=affected`（缺省）或 `--set=full` */
function setOf(): { name: string; gates: readonly GateEntry[] } {
  const name = (process.argv.find((item) => item.startsWith('--set=')) ?? '--set=affected').slice(6)
  const gates = SETS[name]
  if (gates === undefined) throw new Error(`未知清单：${name}（只允许 ${Object.keys(SETS).join(' / ')}）`)
  return { name, gates }
}

/** 把一条门声明变成真正的 argv（tsx 入口 / node 入口 + 额外参数） */
function argvOf(gate: GateEntry): string[] {
  if (gate.runner === 'node') return [gate.entry, ...(gate.args ?? [])]
  return [TSX, gate.entry, ...(gate.args ?? [])]
}

/** `--record`：真的跑一遍，写账本（**不下结论**） */
function record(): void {
  const { name, gates } = setOf()
  const head = headOf()
  mkdirSync(LOG_DIR, { recursive: true })
  const entries: LedgerEntry[] = []
  console.log(
    `[m11:regression:verify] 记录模式：清单=${name} · ${String(gates.length)} 道门 · head=${head.slice(0, 12)}`
  )
  for (const gate of gates) {
    const argv = argvOf(gate)
    const at = Date.now()
    const result = spawnSync(process.execPath, argv, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 20 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    })
    const durationMs = Date.now() - at
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    const logName = `${gate.command.replace(/[:]/g, '_')}-${head.slice(0, 8)}.log`
    const logPath = join(LOG_DIR, logName)
    writeFileSync(logPath, output, 'utf8')
    entries.push({
      command: gate.command,
      entry: gate.entry,
      reason: gate.reason,
      argv,
      exitCode: result.status,
      durationMs,
      stdoutBytes: Buffer.byteLength(output, 'utf8'),
      logHash: createHash('sha256').update(output).digest('hex').slice(0, 16),
      logPath: `artifacts/m11/local/regression-logs/${logName}`,
    })
    const mark = result.status === 0 ? '✅' : '❌'
    console.log(`  ${mark} ${gate.command.padEnd(28)} exit=${String(result.status)} ${String(durationMs)} ms`)
  }
  const ledger: Ledger = {
    schema: 'm11-regression-ledger@1',
    set: name,
    head,
    recordedAt: new Date().toISOString(),
    gates: entries,
  }
  mkdirSync(LOCAL_DIR, { recursive: true })
  writeFileSync(ledgerPath(head), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
  console.log(`账本（**gitignored**）：${ledgerPath(head)}`)
  console.log(`→ 现在跑缺省模式（只读消费，**同一份清单**）：tsx scripts/m11-regression-verify.ts --set=${name}`)
}

/** 缺省模式：只读账本 + manifest，逐条核对 */
function verify(): void {
  const { name: setName, gates } = setOf()
  const head = headOf()
  const path = ledgerPath(head)
  const checks: { id: string; label: string; pass: boolean; detail: string }[] = []

  if (!existsSync(path)) {
    console.log(
      `[m11:regression:verify] NOT RUN：没有本 head 的账本（${path}）\n` +
        '  ⇒ 先跑 `--record`（本门**不**自己跑门：跑与判分离）。'
    )
    process.exit(2)
  }
  const ledger = JSON.parse(readFileSync(path, 'utf8')) as Ledger
  const byCommand = new Map(ledger.gates.map((entry) => [entry.command, entry]))

  // ① 清单齐全
  const missing = gates.filter((gate) => !byCommand.has(gate.command)).map((gate) => gate.command)
  checks.push({
    id: 'G1',
    label: '【清单齐全】受影响门清单里每一道都在账本里（少跑一道 = NOT RUN，**不是** PASS）',
    pass: missing.length === 0,
    detail: `清单=${String(gates.length)}（${setName}）道 · 账本=${String(ledger.gates.length)} 道 · 缺=${JSON.stringify(missing)}`,
  })

  // ② 退出码（0 或显式白名单）
  const badExits = gates.filter((gate) => {
    const entry = byCommand.get(gate.command)
    if (entry === undefined) return false
    if (entry.exitCode === 0) return false
    return gate.acceptedNonZero?.code !== entry.exitCode
  }).map((gate) => `${gate.command}=${String(byCommand.get(gate.command)?.exitCode)}`)
  const accepted = gates.filter((gate) => {
    const entry = byCommand.get(gate.command)
    return gate.acceptedNonZero !== undefined && entry?.exitCode === gate.acceptedNonZero.code
  }).map((gate) => `${gate.command}（${gate.acceptedNonZero!.why}）`)
  checks.push({
    id: 'G2',
    label: '【退出码】每道门要么 exit 0，要么命中**显式已知非零**白名单（带具名理由）',
    pass: badExits.length === 0,
    detail: `非零且未声明=${JSON.stringify(badExits)} · 已声明=${JSON.stringify(accepted)}`
  })

  // ③ 账本 head = 当前 HEAD（过期读数 ⇒ INVALID）
  checks.push({
    id: 'G3',
    label: '【不过期】账本的 head 等于**当前** HEAD（不等 ⇒ 读数过期 ⇒ INVALID，不是 PASS）',
    pass: ledger.head === head,
    detail: `账本=${ledger.head.slice(0, 12)} · 当前=${head.slice(0, 12)}`,
  })

  // ④ 与 manifest 对账（写证据的 M11 门）
  const ARTIFACTS = join(REPO_ROOT, 'artifacts', 'm11')
  const mismatch: string[] = []
  let reconciled = 0
  for (const gate of gates) {
    if (gate.evidenceWp === undefined) continue
    /*
     * ⚠️ **捕获类门跳过 counts 对账**：WP0 的 `before` 阶段按设计 exit 0，而 `counts.failed`
     *    记的是"开工前的断言现在不成立"（实测 4 条）—— 两者**不必**自洽。
     *    第一版把"退出码"与"counts.failed"当成同一件事 ⇒ 报了一条假的"不一致"。
     *    （判据的"对象"又错一次：退出码说的是"这次跑完了"，counts 说的是"断言成立几条"。）
     */
    if (gate.capture === true) continue
    const entry = byCommand.get(gate.command)
    if (entry === undefined || entry.exitCode !== 0) continue
    const dirs = readdirSync(ARTIFACTS, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => join(ARTIFACTS, item.name, 'manifest.json'))
      .filter((manifestPath) => existsSync(manifestPath))
      .map((manifestPath) => ({ manifestPath, mtimeMs: statSync(manifestPath).mtimeMs }))
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
    const latest = dirs
      .map((item) => JSON.parse(readFileSync(item.manifestPath, 'utf8')) as {
        wp?: string
        head?: string
        counts?: { failed?: number }
      })
      .filter((manifest) => manifest.wp === gate.evidenceWp)
      .pop()
    if (latest === undefined) {
      mismatch.push(`${gate.command}: 找不到 wp=${gate.evidenceWp} 的 manifest`)
      continue
    }
    if (latest.head !== head) {
      mismatch.push(`${gate.command}: manifest head=${String(latest.head).slice(0, 8)} ≠ 账本 head`)
      continue
    }
    if ((latest.counts?.failed ?? 1) !== 0) {
      mismatch.push(`${gate.command}: manifest 说 failed=${String(latest.counts?.failed)} 而账本 exit=0`)
      continue
    }
    reconciled += 1
  }
  checks.push({
    id: 'G4',
    label: '【与 manifest 对账】写证据的 M11 门：manifest 的 head 与账本一致，且 counts 与退出码自洽',
    pass: mismatch.length === 0 && reconciled > 0,
    detail: `对账通过=${String(reconciled)} 道 · 不一致=${JSON.stringify(mismatch)}`,
  })

  // ⑤ 账本是机器写的（形状判据）
  const shapeOk =
    ledger.schema === 'm11-regression-ledger@1' &&
    ledger.gates.length > 0 &&
    ledger.gates.every(
      (entry) =>
        Array.isArray(entry.argv) &&
        entry.argv.length >= 2 &&
        typeof entry.exitCode === 'number' &&
        typeof entry.durationMs === 'number' &&
        typeof entry.logHash === 'string' &&
        entry.logHash.length === 16 &&
        typeof entry.stdoutBytes === 'number'
    )
  checks.push({
    id: 'G5',
    label: '【账本形状】schema + 逐条 argv / exitCode / durationMs / 输出哈希 都在（**手写一张全绿表格**过不了这条）',
    pass: shapeOk,
    detail: `schema=${ledger.schema} · 条数=${String(ledger.gates.length)} · 形状=${String(shapeOk)}`,
  })

  // 性能读数（如实记录，不与模型延迟混算）
  const durations = ledger.gates.map((entry) => entry.durationMs).sort((a, b) => a - b)
  const total = durations.reduce((sum, value) => sum + value, 0)
  checks.push({
    id: 'G6',
    label: '【性能读数】受影响门总耗时与最慢三道（**如实记录**，不与模型延迟混算）',
    pass: total > 0,
    detail:
      `总 ${String(Math.round(total / 1000))} s · ` +
      `最慢三道=${JSON.stringify(
        ledger.gates
          .slice()
          .sort((a, b) => b.durationMs - a.durationMs)
          .slice(0, 3)
          .map((entry) => `${entry.command}=${String(Math.round(entry.durationMs / 1000))}s`)
      )}`,
  })

  const failed = checks.filter((check) => !check.pass)
  const runId = createM11RunId({ wpId: 'wp11-regression', headShort: head })
  const dir = openM11RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm11-regression-verify@1',
    manifestVersion: M11_MANIFEST_VERSION,
    runId,
    head,
    ledgerPath: `artifacts/m11/local/regression-${head.slice(0, 12)}.json`,
    ledgerHash: createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex').slice(0, 16),
    gatesRecorded: ledger.gates.length,
    acceptedNonZero: gates.filter((gate) => gate.acceptedNonZero !== undefined).map((gate) => ({
      command: gate.command,
      why: gate.acceptedNonZero!.why,
    })),
    checks,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  }
  writeFileSync(join(dir, 'regression-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM11Manifest(dir, {
    runId,
    wp: 'wp11-regression',
    head,
    headShort: head.slice(0, 12),
    branch: 'codex/m11-execution-plan',
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'regression-consume',
    counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    phases: ['consume'],
    supersedes: null,
    notes: `m11:regression:verify（只读消费 ${String(ledger.gates.length)} 道门的账本；账本 gitignored）`,
  })

  console.log(`runId: ${runId}`)
  for (const check of checks) console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} ${check.label} —— ${check.detail}`)
  console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
  process.exit(failed.length === 0 ? 0 : 1)
}

if (process.argv.includes('--record')) record()
else verify()
