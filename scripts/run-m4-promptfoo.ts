/**
 * 用 Promptfoo 跑**全部** M4 抽取评测配置（每套件 × 每档一个 YAML）。
 *
 * ============================================================================
 *  两档分开跑，因为两档的失败含义完全不同（计划书第 187 / 188 节）
 * ============================================================================
 *   离线档（`*.yaml`）    = **确定性判据**：注入、意图规则、解析器。
 *                          红了就是坏了，必须立刻修。不需要 API Key。
 *   真实模型档（`*.live.yaml`）= 模型行为 / prompt 质量。
 *                          红了需要判断"是不是抽样方差"。
 *
 * 因此它们是两组文件、两个命令：
 *   pnpm eval:m4:promptfoo         # 离线档（进不需 Key 的 CI）
 *   pnpm eval:m4:promptfoo:live    # 真实模型档
 *
 * ---------------------------------------------------------------------------
 *  为什么需要一个脚本，而不是一条 `&&` 串起来的命令
 * ---------------------------------------------------------------------------
 * 与 M3 的 runner 同一理由：
 *   1. **第一个失败就停**：而"这一轮整套的结论"才是要的东西 ——
 *      一个套件红之后，其余套件的结果同样有价值。
 *   2. **汇总要靠人看**：7 段输出里到底几个红，得自己数。
 *   3. **退出码语义丢了**：`&&` 只能表达"有没有红"，
 *      无法区分"某条用例红了"与"这一档根本没跑"（后者更严重）。
 *
 * ---------------------------------------------------------------------------
 *  它不做任何判断
 * ---------------------------------------------------------------------------
 * 每个配置的通过与否**由 provider 判定**（它读的是
 * `scripts/eval-m4-extraction.ts` 的机器可读摘要，而那是用例表自己的结论）。
 * 本脚本只负责：跑、汇总、报。
 *
 * 跑法：
 *   tsx scripts/run-m4-promptfoo.ts             全部离线档
 *   tsx scripts/run-m4-promptfoo.ts --live      全部真实模型档
 *   tsx scripts/run-m4-promptfoo.ts extraction  只跑匹配的（可重复，子串匹配）
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * ⚠️ 必须加载 `.env`，否则下面的 Key 守卫会**误报**。
 *
 * 实测踩到过：直接跑 `tsx scripts/eval-m4-extraction.ts --live` 能成功
 * （那个脚本自己 `import 'dotenv/config'`），但经由本 runner 跑
 * `pnpm eval:m4:promptfoo:live` 却报"需要 OPENAI_API_KEY"。
 * 原因是 Key 在 `.env` 里，而本脚本没加载它 ——
 * 守卫读 `process.env` 读到空，于是拒绝执行。
 *
 * 结果是：守卫本身是对的（它拒绝产出一个空的绿），
 * 但它拦下的是**自己的环境缺陷**，而报错读起来像"你没配 Key"。
 * 一个把自身缺陷说成用户配置问题的报错，会让人往错的方向查。
 *
 * 注意脚本子进程拿到的 `env` 是此时的 `process.env`，
 * 因此 Key 也会一并传下去（子进程另外还会自己加载一次，无副作用）。
 */
import 'dotenv/config'

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const live = argv.includes('--live')
const wanted = argv.filter((arg) => !arg.startsWith('-'))

/** Windows 上 npm 的 bin 垫片是 `.cmd`；`shell: true` 下两者都能跑 */
const promptfoo =
  process.platform === 'win32' ? 'node_modules\\.bin\\promptfoo.cmd' : 'node_modules/.bin/promptfoo'

const CONFIG_DIR = join(process.cwd(), 'evals', 'm4', 'promptfoo')

if (!existsSync(CONFIG_DIR)) {
  console.error(`❌ 配置目录不存在：${CONFIG_DIR}`)
  console.error('   先跑：pnpm eval:m4:promptfoo:build')
  process.exit(2)
}

/*
 * 配置集合从**目录实际内容**读取，而不是从用例表推导。
 *
 * 理由：本脚本要能发现"生成器该生成却没生成"的情况。
 * 如果我从用例表算出"应该有 4 个 live 配置"，然后只跑那 4 个，
 * 那么生成器少生成了一个时，我这边也**正好不会去找它** ——
 * 两个地方用同一个错误假设，谁都不会报错。
 *
 * 反过来读目录：目录里有什么就跑什么；再用用例表核对数量（见下面的一致性子检查）。
 */
const allConfigs = readdirSync(CONFIG_DIR)
  .filter((name) => name.endsWith('.yaml'))
  .filter((name) => name.endsWith('.live.yaml') === live)
  .sort()

const configs = allConfigs.filter((name) => {
  if (wanted.length === 0) return true
  return wanted.some((w) => name.includes(w))
})

if (configs.length === 0) {
  console.error(`没有匹配的配置（档位：${live ? '真实模型档' : '离线档'}，过滤：${wanted.join(', ') || '无'}）`)
  console.error(`目录里该档共有 ${allConfigs.length} 个：${allConfigs.join(', ') || '（无）'}`)
  console.error('若目录是空的，先跑：pnpm eval:m4:promptfoo:build')
  process.exit(2)
}

/*
 * ⚠️ 真实模型档缺 Key 时**直接失败**，不跑出一堆 error 再让人猜。
 *
 * provider 也会挡（它返回 error），但在这里先挡一次更好：
 * 报错能说清"是环境没配好"，而不是 4 个配置分别报 4 次同样的错。
 */
if (live && (process.env.OPENAI_API_KEY ?? '') === '') {
  console.error('❌ 真实模型档需要 OPENAI_API_KEY，但它没有设置。')
  console.error('   离线档：pnpm eval:m4:promptfoo')
  console.error('   不静默降级成离线档：那会得到一个空的绿色，看起来像"真实模型档已验证"。')
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 逐个跑
// ---------------------------------------------------------------------------

interface ConfigOutcome {
  name: string
  exitCode: number
  passed?: number
  failed?: number
  errors?: number
  /**
   * 失败原因（逐条断言）。
   *
   * ⚠️ 这一项是本脚本**重写过一次**的原因。
   *
   * 第一版照搬 M3 的做法：正则抓 Promptfoo 的摘要三行，只打印
   * "我们的错误语义"匹配到的行。结果是三个 live 配置报 ❌ 而
   * **一个字的原因都没有** —— 你只看到 0 passed / 1 failed，
   * 想知道为什么只能自己去手动跑一遍 promptfoo。
   *
   * 那正是本项目反复修的同一族缺陷：**输出把失败原因藏起来**。
   * 现在改用 `--output <json>` 读 Promptfoo 的结构化结果 ——
   * 每条断言的 `reason` 就在里面（断言本来就是为"说清为什么"写的）。
   */
  reasons: string[]
  durationMs: number
}

const outcomes: ConfigOutcome[] = []
const tmpDir = mkdtempSync(join(tmpdir(), 'm4-promptfoo-'))

console.log('='.repeat(72))
console.log(`M4 Promptfoo 外层回归 —— ${live ? '真实模型档' : '离线档'}，${configs.length} 个配置`)
console.log('='.repeat(72))

try {
  for (const name of configs) {
    const configFile = join(CONFIG_DIR, name)
    const resultFile = join(tmpDir, `${name}.json`)

    process.stdout.write(`\n⏳ ${name} … `)
    const started = Date.now()
    /*
     * ⚠️ `shell: true` 下参数是**字符串拼进命令行**的，因此含空格的路径必须自己加引号。
     *
     * 实测踩到过：本仓库路径是 `…\Desktop\project LG`（**含空格**），
     * 不加引号时 cmd.exe 把它切成两个参数，promptfoo 收到的是
     * `…\Desktop\project`，于是报
     * "No configuration file found at C:\Users\user\Desktop\project" ——
     * 而那句报错读起来像是"配置文件没生成"，很容易往错的方向查。
     */
    const result = spawnSync(
      promptfoo,
      ['eval', '-c', `"${configFile}"`, '--no-cache', '--no-progress-bar', '--output', `"${resultFile}"`],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        shell: true,
        env: { ...process.env },
        maxBuffer: 64 * 1024 * 1024,
      }
    )
    const durationMs = Date.now() - started

    const parsed = readPromptfooResult(resultFile)
    const combined = stripAnsi(`${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`)

    let passed: number | undefined
    let failed: number | undefined
    let errors: number | undefined
    let reasons: string[] = []

    if (parsed !== undefined) {
      // 结构化结果优先：计数与原因都来自 Promptfoo 自己的结论
      passed = parsed.passed
      failed = parsed.failed
      errors = parsed.errors
      reasons = parsed.reasons
    } else {
      /*
       * 兜底：读不到 JSON 时退回摘要行。
       *
       * Promptfoo 的摘要块形如：
       *     Results:
       *       ✓ 1 passed (100%)
       *       0 failed (0%)
       *       0 errors (0%)
       * 三行**各自独立**，因此要分别抓 —— M3 的 runner 第一版用
       * `/(\d+) passed, (\d+) failed, (\d+) errors/` 匹配一行，
       * 永远匹配不到，于是每个套件都显示"0 passed / 0 failed"
       * 却又是绿的。
       */
      const passedMatch = /(\d+)\s+passed\b/i.exec(combined)
      const failedMatch = /(\d+)\s+failed\b/i.exec(combined)
      const errorsMatch = /(\d+)\s+errors?\b/i.exec(combined)
      passed = passedMatch ? Number(passedMatch[1]) : undefined
      failed = failedMatch ? Number(failedMatch[1]) : undefined
      errors = errorsMatch ? Number(errorsMatch[1]) : undefined
    }

    /*
     * ⚠️ 读不到结果时**不能当作 0 failed**。
     *
     * 那正是"报告看起来正常、实际上什么都没量到"。
     * 这里明确记成一次错误。
     */
    if (passed === undefined) {
      reasons = [
        `无法从 Promptfoo 的输出判定结果（退出码 ${result.status}）。` +
          `stdout/stderr 末尾：${combined.slice(-600)}`,
      ]
      errors = 1
      failed = 0
      passed = 0
    }

    outcomes.push({
      name,
      exitCode: result.status ?? 1,
      passed,
      failed,
      errors,
      reasons,
      durationMs,
    })

    const critical = reasons.length > 0
    const green = failed === 0 && errors === 0 && passed > 0 && !critical
    console.log(
      `${green ? '✅' : '❌'} ` +
        `${passed} passed / ${failed} failed / ${errors} errors（${(durationMs / 1000).toFixed(1)}s）`
    )
    for (const reason of reasons) console.log(`      ${reason.slice(0, 300)}`)
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true })
}

/**
 * 读 Promptfoo 的 `--output` JSON，抽出计数与**失败原因**。
 *
 * 形状（v0.11x 实测）：
 *   { results: { results: [ { success, gradingResult: { componentResults: [
 *       { pass, reason, assertion } ] } } ] } }
 *
 * 读不到时返回 `undefined`（调用方兜底），而不是编一个"0 failed"。
 */
function readPromptfooResult(file: string): { passed: number; failed: number; errors: number; reasons: string[] } | undefined {
  if (!existsSync(file)) return undefined
  let document: {
    results?: {
      results?: {
        success?: boolean
        error?: string
        gradingResult?: {
          componentResults?: { pass?: boolean; reason?: string }[]
        }
      }[]
    }
  }
  try {
    document = JSON.parse(readFileSync(file, 'utf8')) as typeof document
  } catch {
    return undefined
  }

  const rows = document.results?.results
  if (!Array.isArray(rows) || rows.length === 0) return undefined

  let passed = 0
  let failed = 0
  let errors = 0
  const reasons: string[] = []

  for (const row of rows) {
    if (row.error !== undefined && row.error !== '') {
      errors += 1
      reasons.push(`provider 错误：${row.error.slice(0, 200)}`)
      continue
    }
    if (row.success === true) {
      passed += 1
      continue
    }
    failed += 1
    /*
     * 逐条断言的原因都要打出来 —— 一条配置有 6 条断言，
     * 只报"未通过"等于让人去猜是哪一条、为什么。
     */
    const components = row.gradingResult?.componentResults ?? []
    const bad = components.filter((c) => c.pass !== true)
    if (bad.length === 0) {
      reasons.push('未通过，但 Promptfoo 没有给出失败断言的说明')
    }
    for (const component of bad) {
      reasons.push(component.reason ?? '（断言没有给出 reason）')
    }
  }

  return { passed, failed, errors, reasons }
}

/** 去掉 ANSI 颜色码（Promptfoo 的表格输出带颜色，会干扰正则与肉眼核对） */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log('')
console.log('='.repeat(72))
console.log(`M4 Promptfoo 汇总（${live ? '真实模型档' : '离线档'}）`)
console.log('='.repeat(72))

const width = Math.max(...outcomes.map((outcome) => outcome.name.length))
for (const outcome of outcomes) {
  const passed = outcome.passed ?? 0
  const failed = outcome.failed ?? 0
  const errors = outcome.errors ?? 0
  const bad = outcome.reasons.length > 0
  const mark = failed === 0 && errors === 0 && passed > 0 && !bad ? '✅' : '❌'
  console.log(
    `  ${outcome.name.padEnd(width)}  ${String(passed).padStart(2)} passed / ` +
      `${String(failed).padStart(2)} failed / ${String(errors).padStart(2)} errors  ${mark}`
  )
  for (const reason of outcome.reasons) console.log(`      ${reason.slice(0, 300)}`)
}

/*
 * 一致性核对：目录里该档的配置，与用例表算出来的配置计划是否一致。
 *
 * ⚠️ 这个检查存在的理由：本脚本读的是**目录**，因此它能发现
 *    "生成器该生成却没生成"。少了这一步，生成器少写一个文件时，
 *    我这边也正好不会去找它 —— 两边用同一个错误假设，谁都不报错。
 *
 * ⚠️ 判据来自 `promptfooConfigPlan()`（用例表里的唯一定义），
 *    **不是**在这里再算一遍。第一版就是在这里又算了一遍，
 *    结果与生成器漂移，核对报红却指错了方向
 *    （真实缺陷是"同一条规则有两个实现"）。
 */
const { promptfooConfigPlan } = await import('../evals/m4/extraction-cases.ts')
const planned = promptfooConfigPlan().filter((p) => p.live === live)
const expectedNames = planned.map((p) => p.file.split('/').pop()!).sort()

const missing = expectedNames.filter((n) => !allConfigs.includes(n))
const extra = allConfigs.filter((n) => !expectedNames.includes(n))
const inconsistent = missing.length > 0 || extra.length > 0

if (inconsistent) {
  console.log('')
  console.log(
    `  🔴 配置与用例表的计划**不一致**：目录里 ${allConfigs.length} 个，` +
      `按计划应有 ${expectedNames.length} 个。`
  )
  for (const name of missing) console.log(`     · 缺少：${name}（计划里有，目录里没有）`)
  for (const name of extra) console.log(`     · 多余：${name}（目录里有，计划里没有）`)
  console.log('     请重跑 pnpm eval:m4:promptfoo:build，并检查生成器。')
}

const red = outcomes.filter(
  (outcome) =>
    outcome.reasons.length > 0 ||
    (outcome.failed ?? 0) > 0 ||
    (outcome.errors ?? 0) > 0 ||
    (outcome.passed ?? 0) === 0
)

console.log('')
console.log(
  `  配置：${outcomes.length - red.length}/${outcomes.length} 全绿｜` +
    `断言：${outcomes.reduce((total, outcome) => total + (outcome.passed ?? 0), 0)} passed / ` +
    `${outcomes.reduce((total, outcome) => total + (outcome.failed ?? 0), 0)} failed / ` +
    `${outcomes.reduce((total, outcome) => total + (outcome.errors ?? 0), 0)} errors`
)
if (red.length > 0) {
  console.log('')
  console.log('  未全绿的配置：')
  for (const outcome of red) console.log(`    · ${outcome.name}（exit ${outcome.exitCode}）`)
}
console.log('='.repeat(72))

process.exit(red.length === 0 && !inconsistent ? 0 : 1)
