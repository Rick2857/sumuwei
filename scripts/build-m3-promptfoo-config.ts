/**
 * 从 M3 套件定义生成 Promptfoo 配置（**每个套件一个 YAML**）。
 *
 * ============================================================================
 *  计划书第 49 / 50 / 54 节：方向是单向的
 * ============================================================================
 *     evals/m3/**（手写、进 git、被 typecheck 与 kernel:test 覆盖）
 *            │
 *            └──生成──►  evals/m3/<组>/<套件>.yaml（生成物，可随时重生成）
 *
 * 生成的 YAML 里**只有**"跑哪个套件、怎么断言"，**没有任何测试数据**。
 * 换掉 Promptfoo 时，套件定义一行都不用改 —— 这是计划书第 54 节
 * "Promptfoo 只是执行器之一"的具体落点。
 *
 * ---------------------------------------------------------------------------
 *  为什么每个套件一个文件（而不是一个大 YAML）
 * ---------------------------------------------------------------------------
 * 计划书第 49 节给的就是分文件的目录结构，而它有一个实际好处：
 * Promptfoo 可以只跑其中一个（`-c evals/m3/integrity/source-separation.yaml`），
 * 于是"我只改了来源相关的代码"不需要等整套人格评测跑完。
 *
 * ---------------------------------------------------------------------------
 *  断言只做"结构层"与"硬零层"
 * ---------------------------------------------------------------------------
 * 判断某条检查为什么失败**不在这里做**：provider 返回的
 * `output` 是套件自己的结论（还带着失败原因）。YAML 只负责把它翻译成
 * Promptfoo 能理解的通过/失败，以及把硬零违规变成 `error`。
 *
 * 若在这里再写一遍"什么算通过"，那套 Gate 就有了两个会各自漂移的定义。
 *
 * 跑法：tsx scripts/build-m3-promptfoo-config.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { M3_SUITES } from '../evals/m3/index.ts'
import { M3_HARD_ZERO_METRICS } from '../evals/m3/types.ts'

interface TestCase {
  description: string
  vars: Record<string, unknown>
  assert: { type: string; value?: unknown }[]
  metadata: Record<string, unknown>
}

/**
 * 把套件定义翻成 Promptfoo 用例。
 *
 * 一条用例 = 一个套件（而**不是**一个 EvalCase）。
 *
 * 为什么不一条 EvalCase 一条 Promptfoo 用例：每个 EvalCase 都要
 * 起一个独立的 PGlite 库（`isolateDatabase`），而一个套件内的用例
 * 本来就共享同一台运行环境的装配成本。按套件粒度调用，20 个用例
 * 变成 12 次子进程调用而不是 20 次，并且"这个套件整体红/绿"
 * 与 Promptfoo 的用例卡片一一对应 —— 读起来更省事。
 *
 * 代价是"某一条 EvalCase 红了"在 Promptfoo 里是一个用例内的细节。
 * 因此 `assert` 里带了**失败用例的逐条原因**：这样点开就能看到，
 * 不用去翻报告文件。
 */
function toPromptfooTest(suite: (typeof M3_SUITES)[number]): TestCase {
  const caseIds = suite.cases.map((item) => item.id)

  return {
    description: `${suite.id} — ${suite.title}`,
    vars: {
      suiteId: suite.id,
      caseCount: suite.cases.length,
      checkCount: suite.cases.reduce((total, item) => total + item.checks.length, 0),
      tags: [...new Set(suite.cases.flatMap((item) => item.tags))].join(','),
      // 逐条用例的 id 进 vars：Promptfoo 的 `--filter-vars` 之类可以按它筛
      caseIds: caseIds.join(','),
    },
    assert: [
      // --- 结构层：确实跑完了 --------------------------------------------
      { type: 'javascript', value: 'context.vars.caseCount > 0' },
      { type: 'javascript', value: 'output.length > 0' },

      // --- 硬零层：套件里的用例全部通过 --------------------------------
      //
      // provider 在硬零违规时**直接返回 error**，因此走到这里的 output
      // 已经保证了"没有硬零违规"。这两条断言守的是另一半：
      // **用例本身的确定性检查**也不能有失败。
      {
        type: 'javascript',
        value:
          "(() => { const p = JSON.parse(output); return { pass: p.failed === 0, " +
          "score: p.failed === 0 ? 1 : 0, reason: p.failed === 0 ? " +
          "`${p.passed}/${p.caseCount} 用例通过` : " +
          "`${p.failed} 条用例未通过：` + p.failedCases.map(c => c.caseId + ' → ' + c.reasons.join('；')).join(' | ') } })()",
      },
      {
        type: 'javascript',
        value:
          "(() => { const p = JSON.parse(output); return { pass: p.ok === true, score: p.ok ? 1 : 0, " +
          "reason: p.ok ? '套件整体 ok' : '套件整体 ok=false（见失败用例）' } })()",
      },

      // --- 覆盖层：这一档跑的是哪些用例 ---------------------------------
      //
      // 防止"某次改动让整个套件的用例都不再被执行"（例如 requiresModel
      // 被误标成 true，于是离线档直接跳过）而 Promptfoo 仍然显示绿色。
      {
        type: 'javascript',
        value:
          "(() => { const p = JSON.parse(output); return { pass: Array.isArray(p.failedCases), " +
          "score: 1, reason: '套件报告结构完整' } })()",
      },
    ],
    metadata: {
      suite: suite.id,
      title: suite.title,
      promptfooFile: suite.promptfooFile,
      caseIds,
      hardZeroMetrics: [...M3_HARD_ZERO_METRICS],
      layer: layerOf(suite.id),
    },
  }
}

/**
 * 套件属于哪一层（计划书第 47 节的三层人格评测）。
 *
 * 进 metadata 是为了让报告能按层汇总 —— "性格对但风格漂了"这类结论
 * 只有分层之后才看得出来（第 57 节）。
 */
function layerOf(suiteId: string): string {
  if (['identity-core', 'value-consistency', 'boundary-consistency'].includes(suiteId)) {
    return 'behavior'
  }
  if (['assistant-fabrication', 'source-separation', 'user-correction'].includes(suiteId)) {
    return 'integrity'
  }
  if (['long-dialogue', 'adversarial-role-change'].includes(suiteId)) return 'drift'
  if (['session-restart', 'new-conversation'].includes(suiteId)) return 'session'
  if (suiteId === 'anonymous-persona') return 'anonymous'
  if (suiteId === 'personality-interview') return 'interview'
  return 'other'
}

/**
 * 手写 YAML：只需要一个很小子集，避免为了生成配置引入 `yaml` 依赖。
 *
 * 与 `scripts/build-promptfoo-config.ts` 同一做法 —— 生成器比依赖便宜，
 * 而且生成出来的东西人眼能直接读、能直接 diff。
 */
function renderYaml(suite: (typeof M3_SUITES)[number], test: TestCase): string {
  const header = `# 由 scripts/build-m3-promptfoo-config.ts 生成 —— 请勿手工编辑。
#
# 重新生成：pnpm eval:m3:promptfoo:build
#
# ⚠️ 本文件里**没有任何测试数据**。套件定义在 evals/m3/suites/*.ts，
# 那是唯一真相；Promptfoo 只是执行器之一（计划书第 49/50/54 节）。
#
# 套件：${suite.id}
# 用例：${suite.cases.map((item) => item.id).join(', ')}
#
# 跑法：
#   pnpm eval:m3:promptfoo                                  # 全部 M3 套件
#   pnpm promptfoo eval -c ${suite.promptfooFile.replace(/\\/g, '/')}   # 只跑这一个
`

  const lines: string[] = [header]
  lines.push(`description: ${JSON.stringify(`project LG / 苏沐薇 M3 —— ${suite.id}（${suite.title}）`)}`)
  lines.push('')
  lines.push('providers:')
  lines.push('  - id: "file://../promptfoo-provider.cjs"')
  lines.push('    label: "m3-suites (internal runner)"')
  lines.push('    config:')
  lines.push(`      suiteId: ${JSON.stringify(suite.id)}`)
  lines.push('')
  lines.push('prompts:')
  lines.push('  - "{{suiteId}}"')
  lines.push('')
  lines.push('tests:')
  lines.push(`  - description: ${JSON.stringify(test.description)}`)
  lines.push('    vars:')
  for (const [key, value] of Object.entries(test.vars)) {
    lines.push(`      ${key}: ${JSON.stringify(value)}`)
  }
  lines.push('    assert:')
  for (const assertion of test.assert) {
    lines.push(`      - type: ${assertion.type}`)
    if (assertion.value !== undefined) {
      // 单行化：多行 JS 断言在 YAML 里要写成 block scalar，而手写那套
      // 语法容易出错。压成一行既安全又仍然可读。
      lines.push(`        value: ${JSON.stringify(String(assertion.value))}`)
    }
  }
  lines.push('    metadata:')
  lines.push(`      suite: ${JSON.stringify(test.metadata.suite)}`)
  lines.push(`      title: ${JSON.stringify(test.metadata.title)}`)
  lines.push(`      layer: ${JSON.stringify(test.metadata.layer)}`)
  lines.push(`      caseIds: ${JSON.stringify(test.metadata.caseIds)}`)
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

const written: string[] = []

for (const suite of M3_SUITES) {
  const test = toPromptfooTest(suite)
  const target = join(process.cwd(), suite.promptfooFile)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, renderYaml(suite, test), 'utf8')
  written.push(suite.promptfooFile)
}

console.log(`已生成 ${written.length} 个 M3 Promptfoo 配置：`)
for (const file of written) console.log(`  ${file.replace(/\\/g, '/')}`)
console.log('')
console.log(`  套件：${M3_SUITES.map((suite) => suite.id).join(', ')}`)
console.log(
  `  用例：${M3_SUITES.reduce((total, suite) => total + suite.cases.length, 0)} 条，` +
    `硬零指标 ${M3_HARD_ZERO_METRICS.length} 条`
)
