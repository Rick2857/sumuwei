/**
 * M10.1 WP8 —— **只读聚合门**（`m10.1:gates`）。
 *
 * ============================================================================
 *  它做什么（**只读已落盘证据**，不重跑任何门）
 * ============================================================================
 * ```text
 * · 每道必选门取 `artifacts/m10.1/**` 里**最新的一份读数** —— 选档**只按身份 / 正式结束时间**
 *   （`scripts/m10.1-gate-select.ts`：自报时间 → 清单 `date` → **该证据文件的 git 提交时刻** →
 *    都没有时按 `runId` 并**具名降级**），**mtime 永不参与**（登记册 §0m `R-34` / `TD-23`）。
 * · **文件不存在 = NOT RUN**，不是 PASS（`AGENTS §6.4`）。
 * · 聚合结论只在"**每道必选门的最新读数都是 PASS**"时为 `PASS`；否则如实 `NOT PASS` 并列出红项。
 * · ⚠️ **两代规则**（同 `m10:evidence:verify` 的 A8）：同一道门更晚的 PASS **取代**更早的 FAIL；
 *   本门按"最新一份"取，因此这条规则是**自动**满足的 —— 而更早的 FAIL 档**仍然留在库里**。
 * ```
 *
 * ⚠️ 零模型 / 零数据库 / 零出网：只读文件（与 `git log` 取证据文件的提交时刻）。
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM11RunId, openM11RunDir, writeM11Manifest, M11_MANIFEST_VERSION } from './m11-evidence.ts'
import { selectLatestReading, type SelectionBasis } from './m10.1-gate-select.ts'

const REPO_ROOT = resolve(process.cwd())
const ROOT = join(REPO_ROOT, 'artifacts/m10.1')

interface GateSpec {
  readonly id: string
  /** 目录名前缀 */
  readonly prefix: string
  /** 读数文件名 */
  readonly file: string
  /** 这道门回答什么问题（一句话） */
  readonly what: string
}

const GATES: readonly GateSpec[] = [
  { id: 'm10.1:wp0:verify', prefix: 'm11-m10-1-wp0-', file: 'wp0-verify.json', what: '计划书不可改 + 文件齐全 + 命令存在 + 归属完整' },
  { id: 'm10.1:inputs:verify', prefix: 'm11-m10-1-wp1-', file: 'inputs-verify.json', what: '约定识别契约：有界 · 遮蔽 · 出处在场 · 负例拒绝' },
  { id: 'm10.1:policy:verify', prefix: 'm11-m10-1-wp2-', file: 'policy-verify.json', what: '提案与同意 + 承诺的提案侧 + 兑现的窄规则' },
  { id: 'm10.1:expiry:verify', prefix: 'm11-m10-1-wp3-expiry-', file: 'expiry-verify.json', what: '到期：确定性 · 幂等 · 措辞不含指控' },
  { id: 'm10.1:context:verify', prefix: 'm11-m10-1-wp4-context-', file: 'context-verify.json', what: '事实块 + 两个额度互不顶替 + 注入接线' },
  { id: 'm10.1:e2e:verify', prefix: 'm11-m10-1-wp5-e2e-', file: 'e2e-verify.json', what: '端到端：约定→承诺→结清/到期→块' },
  { id: 'm10.1:assembly:verify', prefix: 'm11-m10-1-wp6b-assembly-', file: 'assembly-verify.json', what: '装配三跳（L-M10.1-05）' },
  { id: 'm10.1:agreement:verify', prefix: 'm11-m10-1-wp2b-agreement-', file: 'agreement-verify.json', what: 'WP2b 慢路径：有界窗口+一次模型调用+两道闸+水位/失败/幂等/晚写（L-M10.1-11）' },
  { id: 'm10.1:long:verify (200)', prefix: 'm11-m10-1-wp6-long-200-', file: 'long-verify.json', what: '200 轮：结清后块里"不要再提" + 窗口已忘' },
  { id: 'm10.1:long:live (200·真模型)', prefix: 'm11-m10-1-wp6-long-live-200-', file: 'long-verify.json', what: '真模型 200 轮：链路不崩 + 零越界 + 重建一致（识别/结清类判据是**读数**）' },
  { id: 'm10.1:long:verify (500)', prefix: 'm11-m10-1-wp6-long-500-', file: 'long-verify.json', what: '500 轮：同上（规模）' },
  { id: 'm10.1:smoke:live', prefix: 'm11-m10-1-wp6-smoke-live-', file: 'smoke-live.json', what: '真模型短链：链跑通 + 识别读数分列' },
  { id: 'm10.1:review:materials', prefix: 'm11-m10-1-wp7-review-', file: 'review-materials.json', what: '人审材料（泄漏探测 + 不代签；人审本身 PENDING）' },
  { id: 'm10.1:a11:behavior（读数门）', prefix: 'm11-m10-1-a11-behavior-', file: 'a11-behavior.json', what: 'A11 行为级对照：**判据 PASS 不等于行为主张成立**（读数在 payload 的 verdictReading）' },
  { id: 'm10.1:measurement:verify', prefix: 'm11-m10-1-wp8-measurement-', file: 'measurement-verify.json', what: '量具有效性（4 检测器 × 三段式）' },
  { id: 'm10.1:docs:verify', prefix: 'm11-m10-1-wp8-docs-', file: 'docs-verify.json', what: '文档自洽 + A13 只追加' },
  { id: 'm10.1:activation:readback', prefix: 'm11-m10-1-activation-readback-', file: 'activation-readback.json', what: '激活读回（配置 / 装配 / 首次行为）' },
  { id: 'm10.1:activate', prefix: 'm11-m10-1-wp6b-activate-', file: 'activate.json', what: '受控生产激活（只追加 .env）' },
]

interface Reading {
  readonly id: string
  readonly what: string
  readonly runDir: string
  readonly verdict: string
  readonly passed: number
  readonly total: number
  readonly head: string
  /** 这一份是**按哪一段**选出来的（具名，见 `scripts/m10.1-gate-select.ts`） */
  readonly selectionBasis: SelectionBasis
  /** 与它**时间并列**的其它档（空数组 = 无并列） */
  readonly tiedWith: readonly string[]
  /** 被滤掉的**非权威档**（干跑 / 显式声明非权威） */
  readonly skipped: readonly string[]
  /** 并列组里判定不同 ⇒ 失败关闭 */
  readonly ambiguous: boolean
}

/** 选档：**身份 / 正式结束时间**优先，mtime 永不参与（`R-34` / `TD-23`）。 */
const latest = (prefix: string, file: string): ReturnType<typeof selectLatestReading> =>
  selectLatestReading(ROOT, prefix, file)

const readings: Reading[] = []
const notRun: string[] = []
for (const gate of GATES) {
  const found = latest(gate.prefix, gate.file)
  if (found === undefined) {
    notRun.push(gate.id)
    continue
  }
  const parsed = JSON.parse(found.json) as {
    verdict?: string
    summary?: { passed?: number; total?: number }
    head?: string
  }
  readings.push({
    id: gate.id,
    what: gate.what,
    runDir: found.dir.replace(`${REPO_ROOT}\\`, '').replace(`${REPO_ROOT}/`, ''),
    /*
     * ⚠️ 并列档**判定不同**时不许"挑一份"：报 `AMBIGUOUS` 并失败关闭 —— 这与"刻意不优先取 PASS"
     * 是同一条纪律的两面（`R-34` / `TD-23`）。
     */
    verdict: found.conflictingVerdicts
      ? 'AMBIGUOUS（并列档判定不同）'
      : String(parsed.verdict ?? '(无 verdict)'),
    passed: Number(parsed.summary?.passed ?? -1),
    total: Number(parsed.summary?.total ?? -1),
    head: String(parsed.head ?? '').slice(0, 12),
    selectionBasis: found.basis,
    tiedWith: found.tiedWith,
    skipped: found.skipped,
    ambiguous: found.conflictingVerdicts,
  })
}

/** ⚠️ **明示的 NOT RUN**（不是"缺文件"，是"已裁定为不跑"） */
const DECLARED_NOT_RUN = [
  {
    id: 'M10.1 语义评测（逐案）',
    why: '快路径"承诺识别"没有独立语料与金标（`L-M10.1-09`/`L-M10.1-11` 的读数来自短链与长链 live 档）',
    howToRun: '建语义语料 + 量具验证，再跑逐案读数（属后续工作包）',
  },
  {
    id: '`m10.1:long:live` 的 500 轮档',
    why: '用户 2026-10-02 裁定「200 轮够了」⇒ 只跑 200 轮；离线档仍跑 200 与 500 两档',
    howToRun: '`tsx scripts/m10.1-long-verify.ts --turns 500 --live`',
  },
]

const failedGates = readings.filter((reading) => reading.verdict !== 'PASS')
const verdict =
  failedGates.length === 0 && notRun.length === 0 && readings.length === GATES.length
    ? 'PASS'
    : 'NOT PASS'

for (const reading of readings) {
  console.log(
    `  ${reading.verdict === 'PASS' ? '✅' : '❌'} ${reading.id.padEnd(30)} ${String(reading.passed).padStart(3)}/${String(
      reading.total
    ).padEnd(3)} head=${reading.head}  ${reading.runDir}`
  )
}
/*
 * 选档依据**具名**（`R-34` / `TD-23`）：`none` = 什么时间戳都没有、只按 runId —— 那是降级，必须看得见；
 * 时间并列也要列出来（并列时靠 runId 裁决，读者有权知道自己看的是哪一份）。
 */
const degraded = readings.filter((reading) => reading.selectionBasis === 'none')
const tied = readings.filter((reading) => reading.tiedWith.length > 0)
for (const reading of degraded) {
  console.log(
    `  ⚠️ 选档降级 ${reading.id}：**四个时间层全取不到**（自报时间 / head 提交时刻 / 证据提交时刻 / 清单日期）⇒ 只按 runId 字典序取 ${reading.runDir}`
  )
}
for (const reading of tied) {
  console.log(
    `  ⚠️ 选档并列 ${reading.id}：与 ${String(reading.tiedWith.length)} 份档**时间相同** ⇒ 按 runId 降序取 ${reading.runDir}${reading.ambiguous ? ' —— ⚠️ **并列档判定不同 ⇒ 报 AMBIGUOUS（失败关闭）**' : '（并列档判定相同，取哪一份都不改变结论）'}`
  )
}
const skippedAny = readings.filter((reading) => reading.skipped.length > 0)
for (const reading of skippedAny) {
  console.log(
    `  ⚠️ 已滤掉非权威档 ${reading.id}：${String(reading.skipped.length)} 份（干跑 / 显式声明非权威）—— 见 scripts/m10.1-gate-select.ts`
  )
}
for (const id of notRun) console.log(`  ⏭  ${id.padEnd(30)} **NOT RUN**（库里没有读数文件 —— 不是 PASS）`)
for (const item of DECLARED_NOT_RUN) console.log(`  ⏭  ${item.id} —— 已裁定不跑：${item.why}`)
console.log(`\n必选门 ${String(GATES.length)} 道 · 有读数 ${String(readings.length)} · 未运行 ${String(notRun.length)} · 未通过 ${String(failedGates.length)}`)
console.log(`overall = ${verdict}`)

/* ---------------------------------------------------------------------------
 * 证据
 * ------------------------------------------------------------------------- */
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'm10-1-wp8-gates', headShort: head })
const dir = openM11RunDir(REPO_ROOT, runId, 'artifacts/m10.1')
const payload = {
  schema: 'm10.1-gates@1',
  manifestVersion: M11_MANIFEST_VERSION,
  runId,
  head,
  requiredGates: GATES.map((gate) => ({ id: gate.id, what: gate.what })),
  readings,
  notRun,
  declaredNotRun: DECLARED_NOT_RUN,
  summary: {
    required: GATES.length,
    withReading: readings.length,
    notRun: notRun.length,
    failed: failedGates.length,
  },
  verdict,
  disclaimer:
    '本门**只读已落盘证据**，按"每道门最新一份"汇总；它**不**重跑任何门，也**不**替代 [`M10.1-Gate-Decision.md`](../../docs/m10.1/M10.1-Gate-Decision.md) 的分槽判定。',
}
writeFileSync(join(dir, 'gates.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
writeM11Manifest(dir, {
  runId,
  wp: 'm10-1-wp8-gates',
  head,
  headShort: head.slice(0, 12),
  branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
  date: new Date().toISOString().slice(0, 10),
  toolVersions: { node: process.version },
  testType: 'gates',
  counts: { total: readings.length, passed: readings.length - failedGates.length, failed: failedGates.length },
  phases: ['read-only'],
  supersedes: null,
  notes: `m10.1:gates（必选 ${String(GATES.length)} · 有读数 ${String(readings.length)} · 未运行 ${String(
    notRun.length
  )} · overall=${verdict}）`,
})
process.exit(verdict === 'PASS' ? 0 : 1)
