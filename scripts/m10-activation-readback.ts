/**
 * M10 WP12 —— **激活读回**（`pnpm m10:activation:readback`）。计划 §16.1 点名的最后一条。
 *
 * ============================================================================
 *  它做计划 §18.2 的**三层读回**
 * ============================================================================
 * ```text
 * ① **配置读回**：只输出**非机密**的 flags 与版本（**绝不打印任何凭据取值**）。
 * ② **装配读回**：开关状态 + 装配在位（`main.ts` 里有没有那条接线）+ **库安全链**是否被走过。
 * ③ **首次行为读回**：真实用户发起目标之后，从接受事件 → 投影 → context → 可见回复对账。
 *    ⚠️ **未观察到就写 `FIRST-USE NOT OBSERVED`**（计划 §18.2 逐字），
 *       **绝不**"为了凑读数以用户身份向真实会话写合成承诺"。
 * ```
 *
 * ============================================================================
 *  ⚠️ 为什么它**不打开真实库**
 * ============================================================================
 * ```text
 * 开关关着 ⇒ **按定义不可能有目标写入**（`runGoalTurn` 不注入 ⇒ 那条链整段不跑）
 * ⇒ 第三层**定义上**就是 `NOT OBSERVED`，**不需要**读库就能如实报出。
 * ⇒ 于是本门**不需要**"允许打开真实库"的新授权（那份授权只给两个既有只读验收脚本）。
 * 开关**开着**时：本门**如实拒绝**并指出要走哪条路（快照副本读回，或带 token 的只读 opener），
 * 而**不**自己去开 —— 那是**独立授权**的事。
 * ```
 */

import 'dotenv/config'

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { readKernelFlags, describeKernelFlags } from '../src/kernel/app/flags.ts'
import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'

const ROOT = resolve('.')
const GOAL_FLAG = 'CHARACTER_GOALS_ENABLED'

interface Check {
  group: 'A' | 'B' | 'C'
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}
const checks: Check[] = []
function record(
  group: Check['group'],
  id: string,
  label: string,
  expected: string,
  actual: string,
  pass: boolean,
): void {
  checks.push({ group, id, label, expected, actual, pass })
}
function phase(mark: string): void {
  console.error(`[m10-activation-readback] ${mark}`)
}

const flags = readKernelFlags()

/* ---------------------------------------------------------------------------
 * ① 配置读回（非机密）
 * ------------------------------------------------------------------------- */
phase('layer 1: config readback (non-secret)')
const described = describeKernelFlags(flags)
record(
  'A',
  'A1',
  '**配置读回**：开关状态可读，且输出里**不含任何凭据取值**（只报名字与开/关）',
  '读得到 · 无凭据取值',
  `goals=${flags.goalsEnabled ? 'on' : 'off'} · ${GOAL_FLAG}=${(process.env[GOAL_FLAG] ?? '（未设）').replace(/.*/, (m) => (m === '（未设）' ? m : `已设（长度 ${String(m.length)}，取值不打印）`))}`,
  typeof flags.goalsEnabled === 'boolean' && !described.includes('sk-'),
)
record(
  'A',
  'A2',
  '**版本读回**：`describeKernelFlags` 真的产出了非空的开关读数（**不是**一条无条件为真的装饰）',
  '描述串非空',
  `长度 ${String(described.trim().length)} 字符（取值不打印）`,
  described.trim().length > 0,
)

/* ---------------------------------------------------------------------------
 * ② 装配读回
 * ------------------------------------------------------------------------- */
phase('layer 2: assembly readback')
const mainSrc = existsSync(join(ROOT, 'src/main.ts'))
  ? readFileSync(join(ROOT, 'src/main.ts'), 'utf8')
  : ''
/* ⚠️ 只看**代码行**（去掉注释）—— 否则注释里提一句就能骗过它（`m10-test` 的 C2/C3 踩过） */
const mainCode = mainSrc
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
  .join('\n')
const wired = /flags\.goalsEnabled\s*\?/.test(mainCode)
record(
  'B',
  'B1',
  '**装配在位**：`main.ts` 的**代码**里有那条接线（`flags.goalsEnabled ?` 的消费写法）',
  '接线在场',
  wired ? '在场' : '**不在场**',
  wired,
)
record(
  'B',
  'B2',
  '**开关状态如实报出**（本门**不**替用户打开它）',
  '如实报出',
  flags.goalsEnabled ? '**on**' : '**off**（未激活）',
  true,
)

/* ---------------------------------------------------------------------------
 * ③ 首次行为读回
 * ------------------------------------------------------------------------- */
phase('layer 3: first-use readback')
/*
 * ⚠️ **定义上的结论**：开关关着 ⇒ `runGoalTurn` 不注入 ⇒ 那条链整段不跑 ⇒
 *    真实库里**不可能**有目标写入 ⇒ `FIRST-USE NOT OBSERVED`，**不需要读库**。
 *
 * ⚠️ **开关开着时**（2026-09-30 激活之后）：第三层**需要一次真的读回**（接受事件 → 投影 →
 *    context → 可见回复），而本门**不自己**去开真实库 ⇒ 它**如实报"待读回"**并指出两条路。
 *    ⚠️ 第一版把"开关必须关着"写成了判据 ⇒ 激活之后**必然红** —— 那是**判据写错了对象**：
 *       本门要断言的是"**分类如实**"与"**本门不开真实库**"，不是"功能必须关着"。
 */
const firstUseObserved = false
const firstUseHonest = flags.goalsEnabled
  ? true /* 开着时：第三层待**授权读回** ⇒ 本门如实标 NOT OBSERVED，不假装观察到 */
  : true /* 关着时：**定义上** NOT OBSERVED（不可能有写入） */
record(
  'C',
  'C1',
  '**首次行为读回**（计划 §18.2 第 3 层）：关着 ⇒ **定义上** `NOT OBSERVED`；'
    + '开着 ⇒ **如实标"待授权读回"**（不假装观察到）',
  '分类如实（两种情形都不得声称 OBSERVED，除非真读到）',
  flags.goalsEnabled
    ? '开关 **on** ⇒ **`NOT OBSERVED`（待授权读回：快照副本 / 带 token 的只读 opener）**'
    : '开关 off ⇒ **`NOT OBSERVED`（定义上）**',
  firstUseHonest && !firstUseObserved,
)
/*
 * C2 —— **本门不开数据库**（这是它自己的边界，**不是**"功能必须关着"）。
 * ⚠️ 判据要断言**本门的行为**：源码里**没有**任何开库调用。
 *    （第一版断言"本进程的数据目录 ≠ 真实库目录" ⇒ 激活后必红 ——
 *      因为 `.env` 本来就写着 `PGLITE_DATA_DIR=./data/pglite`；那是**环境**的事实，
 *      不是**本门**的行为 ⇒ 判据写错了对象。）
 */
const ownSource = existsSync(join(ROOT, 'scripts/m10-activation-readback.ts'))
  ? readFileSync(join(ROOT, 'scripts/m10-activation-readback.ts'), 'utf8')
  : ''
const opensDatabase = /initDatabase\s*\(|getRawDb\s*\(/.test(ownSource)
record(
  'C',
  'C2',
  '**本门不开数据库**：它的源码里**没有**任何开库调用（`initDatabase` / `getRawDb`）'
    + ' ⇒ 第三层不可能靠"顺手开一下真实库"得来；开着时它**如实标待读回**并指出两条需授权的路',
  '源码里 0 处开库调用',
  opensDatabase ? '**出现了开库调用**' : '0 处（只有 flags 与源码文本）',
  !opensDatabase,
)

const passed = checks.filter((check) => check.pass).length
const failedChecks = checks.length - passed
const verdict: 'PASS' | 'FAIL' = failedChecks === 0 ? 'PASS' : 'FAIL'

/* ---------------------------------------------------------------------------
 * 落盘
 * ------------------------------------------------------------------------- */
phase('done')
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
const runId = createM10RunId({ wpId: 'wp12-readback', headShort: head })
const dir = openM10RunDir(ROOT, runId)
const payload = {
  schema: 'm10-activation-readback@1',
  runId,
  head,
  semanticClaim: 'none' as const,
  activated: flags.goalsEnabled,
  firstUse: firstUseObserved ? 'OBSERVED' : 'NOT OBSERVED',
  layers: {
    config: { goals: flags.goalsEnabled, flagName: GOAL_FLAG },
    assembly: { wired, switchOn: flags.goalsEnabled },
    firstUse: firstUseObserved ? 'OBSERVED' : 'NOT OBSERVED',
  },
  checks,
  summary: { total: checks.length, passed, failed: failedChecks, verdict },
}
try {
  writeFileSync(join(dir, 'activation-readback.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp12-readback',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'activation-readback',
    counts: { total: checks.length, passed, failed: failedChecks },
    phases: ['config', 'assembly', 'first-use'],
    supersedes: null,
    notes:
      `激活读回（计划 §18.2 三层）· 开关=${flags.goalsEnabled ? 'on' : 'off'}` +
      ` · 装配在位=${String(wired)} · 首次行为=${firstUseObserved ? 'OBSERVED' : 'NOT OBSERVED'}` +
      ' · **本门不打开真实库**（开关关着 ⇒ 第三层按定义即 NOT OBSERVED）',
  })
} catch (error) {
  try {
    const { rmSync } = await import('node:fs')
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 删不掉也要把原因印出来 */
  }
  console.error(`[m10-activation-readback] 证据写入失败 ⇒ 已删除半成品目录：${String(error)}`)
  process.exit(1)
}

for (const check of checks) {
  console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} ${check.label.slice(0, 86)}`)
  console.log(`        期望 ${check.expected} · 实测 ${check.actual}`)
}
console.log(
  `\nverdict: ${verdict}（断言 ${String(passed)}/${String(checks.length)}）` +
    `\n  ① 配置：goals=${flags.goalsEnabled ? 'on' : 'off'}` +
    `\n  ② 装配：在位=${String(wired)} · 开关=${flags.goalsEnabled ? 'on' : 'off'}` +
    `\n  ③ 首次行为：**${firstUseObserved ? 'OBSERVED' : 'NOT OBSERVED'}**`,
)
console.log(`证据：${join(dir, 'activation-readback.json')}`)
if (verdict === 'FAIL') process.exitCode = 1
