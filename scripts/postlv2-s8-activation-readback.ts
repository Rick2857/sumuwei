/**
 * **S8 / ADR-094 `D08`** —— 生产激活读回（`pnpm postlv2:s8:activation-readback`）。
 *
 * ============================================================================
 *  它核对什么（**配置层**：不打开数据库）
 * ============================================================================
 * ```text
 * ① 正控：真实 `.env` ⇒ `CHARACTER_STORY_COGNITION_ENABLED` ⇒ flags.storyCognitionEnabled === true
 * ② 负控：环境副本**删掉该变量** ⇒ 必须回到 false（代码缺省 = false）
 * ③ 消费锁：`src/main.ts` 必须**同时**出现开关名与 `consumeOnce`
 *    （只加开关不消费 = `CHARACTER_MEMORY_BACKGROUND_ENABLED` 那个 NOT-WIRED 形态）
 * ```
 *
 * ⚠️ **诚实边界（不许读成"活库读回已完成"）**：
 * ```text
 * 本脚本**不打开真实库**。ADR-094 D08 要求的活库侧核对
 * （`storyline_commits` / `storyline_observations` / `storyline_consumer_watermarks`
 *   三张表在、schema = v13、行数与水位可查）**尚未实现** —— 它需要真实库 opener
 * （INC-01 状态机：租约 → pre-open verified snapshot → token → 只读打开 → 干净关闭），
 * 属独立一步。⇒ `L-S8-26` 的活库半边仍 OPEN。
 * ```
 * ⚠️ 只读：本脚本不写任何文件、不写库、不改 `.env`。
 */

import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { readKernelFlags } from '../src/kernel/app/flags.ts'

const ROOT = resolve(process.cwd())
const ENV_KEY = 'CHARACTER_STORY_COGNITION_ENABLED'
const FIELD = 'storyCognitionEnabled'

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

const date = new Date().toISOString()
let head = 'unknown'
let branch = 'unknown'
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
} catch {
  /* 只读盘点失败不改变判定 */
}

console.log('')
console.log('=== S8 生产激活读回（配置层；**不打开数据库**）===')
console.log(`  head=${head.slice(0, 8)} branch=${branch} date=${date}`)

/* ① 正控：真实 .env */
const positive = readKernelFlags(process.env)
/* ② 负控：环境副本删掉该变量（纯函数，不碰 .env 文件） */
const negativeEnv: NodeJS.ProcessEnv = { ...process.env }
delete negativeEnv[ENV_KEY]
const negative = readKernelFlags(negativeEnv)
/* ③ 对照：显式置 false 也必须 false（防"读了变量但恒真"） */
const explicitFalse = readKernelFlags({ ...process.env, [ENV_KEY]: 'false' } as NodeJS.ProcessEnv)

record(
  'R1',
  `正控：真实 \`.env\` 的 ${ENV_KEY}=true ⇒ \`${FIELD}\` 真的为 true（开关**被读到**）`,
  positive[FIELD] === true,
  `${ENV_KEY} ⇒ ${FIELD}=${String(positive[FIELD])}`,
  1
)
record(
  'R2',
  `负控：删掉 ${ENV_KEY} ⇒ 必须回到 **false**（代码缺省 false）；显式 ='false' 也必须 false`,
  negative[FIELD] === false && explicitFalse[FIELD] === false,
  `删变量 ⇒ ${String(negative[FIELD])} · 显式 'false' ⇒ ${String(explicitFalse[FIELD])}`,
  2
)

const main = readFileSync(join(ROOT, 'src/main.ts'), 'utf8')
record(
  'R3',
  '消费锁（读回侧复核）：`src/main.ts` 同时出现开关名与 `consumeOnce` ⇒ 开关有**真的消费者**',
  /storyCognitionEnabled/.test(main) && /consumeOnce/.test(main),
  `main.ts 含开关名=${String(/storyCognitionEnabled/.test(main))} · 含 consumeOnce=${String(/consumeOnce/.test(main))}`,
  2
)

/*
 * ---------------------------------------------------------------------------
 * D · 回滚演练（**dry-run**：只做文本级与纯函数级核对，**不动 `.env`**）
 * ---------------------------------------------------------------------------
 * ADR-094 `D07` 的回滚口径是"删掉 `.env` 里那一行 ⇒ 消费与注入即停"。
 * 本段证明**回滚目标可识别且恰好是一行**，并证明"删掉之后开关确实回到 false"；
 * ⚠️ 它**不执行**删除（dry-run）—— 真删是状态切换，需要独立授权。
 */
const envText = (() => {
  try {
    return readFileSync(join(ROOT, '.env'), 'utf8')
  } catch {
    return ''
  }
})()
const envLines = envText.split(/\r?\n/)
const storyLines = envLines.filter((line) => line.startsWith(`${ENV_KEY}=`))
const removedText = envLines.filter((line) => !line.startsWith(`${ENV_KEY}=`)).join('\n')
const removedStillHasKey = removedText.split(/\r?\n/).some((line) => line.startsWith(`${ENV_KEY}=`))

record(
  'D1',
  `回滚目标可识别：\`.env\` 里形如 \`${ENV_KEY}=\` 的行**恰好 1 行**（删一行就是回滚的全部动作）`,
  storyLines.length === 1,
  `命中行数=${String(storyLines.length)} · 该行=${storyLines[0] === undefined ? '(无)' : storyLines[0].replace(/=.*/, '=<已省略值>')}`,
  1
)
record(
  'D2',
  'dry-run：把该行从文本里**去掉**之后，文本中不再有该键（文本级证明"删掉即没有"）',
  removedStillHasKey === false && removedText.length > 0,
  `去掉后仍含该键=${String(removedStillHasKey)} · 剩余行数=${String(removedText.split(/\n/).length)}`,
  2
)
const mainGuard = /if \(this\.flags\.storyCognitionEnabled && this\.kernel && !this\.dryRun\)/.test(main)
record(
  'D3',
  '回滚后**代码路径确为惰性**：`main.ts` 的守卫是 `storyCognitionEnabled && … && !dryRun` ⇒ 开关为 false 时整块不执行（连账本端口都不构造）',
  mainGuard,
  `守卫形状匹配=${String(mainGuard)}（匹配失败说明守卫被改写，回滚结论需要重新核对）`,
  1
)
console.log('  ⚠️ dry-run：**没有**修改 `.env`（真删是状态切换，需独立授权）')

const measuredCount = checks.reduce((sum, check) => sum + check.measured, 0)
const failed = checks.filter((check) => !check.pass)
const passed = measuredCount > 0 && failed.length === 0

console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:s8:activation-readback（**配置层**）= ${passed ? 'PASS' : 'FAIL'}`)
console.log('  ⚠️ 活库侧读回（三张表 / schema v13 / 水位）**尚未实现** ⇒ `L-S8-26` 活性半边仍 OPEN')
console.log(`  证据：artifacts/post-lv2/local/<runId>/（**本脚本不写仓库文件**）`)

process.exit(passed ? 0 : 1)
