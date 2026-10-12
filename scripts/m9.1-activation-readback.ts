/**
 * M9.1 生产激活读回（`pnpm m9.1:activation:readback`）——**配置层**读回，不打开任何数据库。
 *
 * 为什么 M9.1 的读回停在配置层（与 M9 的 ADR-071 §4「SELECT-only 真库读回」不同）：
 *   · **F-4 复活**只在**未来的**一次重述时才发射（无回填、无播种、无投影重建）；
 *   · **F-1 遮蔽**是**读侧**逐轮计算（撤销集从既有表推导，无预计算表、无缓存表）；
 *   · **F-5/WP8** 只改「形成时的身份推导」：身份分量并入 Memory revision。
 *     现存生产记忆若要参与**新形成**，只会在**复活**（`revision>1`）时发生，而复活在
 *     M9.1 之前**从未成功过**（F-4 的确定性 id 撞线）⇒ 没有既存信念需要重新推导身份。
 *   ⇒ 激活 = 纯配置变更；**没有**任何需要在激活时对真库执行的动作
 *     （与 M9 的「origin 自播种 + 双流追赶」不同）。
 *
 * 因此本量具做两件事（纯函数，无 DB、无网络、无模型）：
 *   ① **正控**：真实 `.env` 下两个 M9.1 开关解析为 `true`（证明「开关被真的消费」）；
 *   ② **负控**：把两个变量从环境副本里删掉后解析为 `false`（证明读数不是恒真）。
 * 构造性质：本文件**只** import `src/kernel/app/flags.ts`（其自身只依赖 contracts 纯模块），
 * 不 import 任何 persistence / runtime / plugin-sql ⇒ **不可能打开数据库**。
 */
import 'dotenv/config'

import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { readKernelFlags } from '../src/kernel/app/flags.ts'

const ROOT = process.cwd()
const OUT_DIR = join(ROOT, 'artifacts', 'm9.1', 'activation-readback')

/** M9.1 的两个开关：字段名 ↔ 环境变量名 */
const M91_FLAGS = [
  { field: 'memoryRestatementRevivalEnabled', env: 'CHARACTER_MEMORY_RESTATEMENT_ENABLED' },
  { field: 'withdrawnContextMaskingEnabled', env: 'CHARACTER_WITHDRAWN_CONTEXT_MASKING_ENABLED' },
] as const

/** 既有激活（只读对照，不判定）——用于证明「M9.1 开关与既有开关并存」 */
const CONTEXT_FLAGS = [
  { field: 'beliefEnabled', env: 'CHARACTER_BELIEF_ENABLED' },
  { field: 'relationshipContextEnabled', env: 'CHARACTER_RELATIONSHIP_CONTEXT_ENABLED' },
  { field: 'affectContextEnabled', env: 'CHARACTER_AFFECT_CONTEXT_ENABLED' },
  { field: 'webSearchEnabled', env: 'CHARACTER_WEB_SEARCH_ENABLED' },
] as const

function main(): void {
  const date = new Date().toISOString()
  const head = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()
  const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()

  /* ① 正控：真实 .env */
  const positive = readKernelFlags(process.env)
  /* ② 负控：环境副本删掉两个 M9.1 变量（纯函数） */
  const negEnv: NodeJS.ProcessEnv = { ...process.env }
  for (const f of M91_FLAGS) delete negEnv[f.env]
  const negative = readKernelFlags(negEnv)

  const rows = M91_FLAGS.map((f) => ({
    env: f.env,
    field: f.field,
    activated: positive[f.field],
    withoutEnvVar: negative[f.field],
  }))
  const context = CONTEXT_FLAGS.map((f) => ({ env: f.env, field: f.field, value: positive[f.field] }))

  console.log('\n=== M9.1 生产激活读回（配置层；不打开数据库）===')
  console.log(`head=${head.slice(0, 7)} branch=${branch} date=${date}`)
  for (const r of rows) {
    console.log(
      `  ${r.activated === true ? '✅' : '❌'} ${r.env} ⇒ ${String(r.activated)}（负控删该变量 ⇒ ${String(r.withoutEnvVar)}）`,
    )
  }
  console.log('  对照（既有激活，只读）：')
  for (const c of context) console.log(`    · ${c.env} = ${String(c.value)}`)

  /* 判据：两个开关都 true（正控）**且**删掉变量后都 false（负控）——两者缺一 ⇒ FAIL */
  const posOk = rows.every((r) => r.activated === true)
  const negOk = rows.every((r) => r.withoutEnvVar === false)
  const verdict = posOk && negOk ? 'PASS' : 'FAIL'
  console.log(
    `\n正控=${String(posOk)}（两个开关均 true）· 负控=${String(negOk)}（删变量后均 false）⇒ ${verdict}`,
  )
  if (!posOk) {
    console.error('⇒ 激活未生效：`CHARACTER_MEMORY_RESTATEMENT_ENABLED` / `CHARACTER_WITHDRAWN_CONTEXT_MASKING_ENABLED` 至少一个未解析为 true')
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const out = join(OUT_DIR, 'activation-readback.json')
  writeFileSync(
    out,
    JSON.stringify(
      {
        gate: 'm9.1:activation:readback',
        kind: 'config-layer-readback',
        date,
        head,
        branch,
        databaseOpened: false,
        constructionNote:
          '本量具只 import src/kernel/app/flags.ts（纯函数，仅依赖 contracts）——不 import persistence/runtime/plugin-sql ⇒ 构造上不打开数据库',
        whyNoDbReadback:
          'F-4 只在未来重述时发射（无回填）· F-1 为读侧逐轮计算（无预计算表）· F-5 只改形成期身份推导且复活此前从未成功 ⇒ 无既存信念需重新推导',
        rows,
        context,
        positiveControlOk: posOk,
        negativeControlOk: negOk,
        verdict,
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`证据：${out}`)
  process.exit(verdict === 'PASS' ? 0 : 1)
}

main()
