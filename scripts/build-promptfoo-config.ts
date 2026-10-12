/**
 * 从内部场景定义生成 Promptfoo 配置。
 *
 * ============================================================================
 *  plan 第 87 节：场景的 canonical 定义不能绑定 Promptfoo 格式
 * ============================================================================
 * 所以方向是**单向**的：
 *
 *     evals/scenarios/*.ts   ──生成──►  evals/promptfoo/promptfooconfig.yaml
 *        （手写、进 git、单测覆盖）          （生成物，可随时重生成）
 *
 * 生成的 YAML 里只有"跑哪个场景、怎么断言"，**没有**任何测试数据。
 * 因此 Promptfoo 换成别的 Runner 时，场景定义一行都不用改。
 *
 * 跑法：node_modules/.bin/tsx scripts/build-promptfoo-config.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { SCENARIOS } from '../evals/scenarios/index.ts'

const OUT = join(process.cwd(), 'evals', 'promptfoo', 'promptfooconfig.yaml')

interface TestCase {
  description: string
  vars: Record<string, unknown>
  assert: { type: string; value?: unknown }[]
  metadata: Record<string, unknown>
}

const tests: TestCase[] = SCENARIOS.map((scenario) => {
  const turnCount = scenario.turns.length
  return {
    description: `${scenario.id} ${scenario.description}`,
    vars: {
      scenarioId: scenario.id,
      modelMode: 'echo',
      turnCount,
      tags: scenario.tags.join(','),
      assertionCount: scenario.assertions.length,
    },
    assert: [
      // 结构层：确实跑完了
      { type: 'javascript', value: 'context.vars.turnCount > 0' },
      { type: 'javascript', value: 'output.length > 0' },
      /*
       * 行为层的浅断言**只在 real 模式生效**。
       *
       * 原因：echo 模式下的"回复"本身就是为了让断言看见上下文而设计的
       * （`<m2.5-echo sections=current-input+seed-identity ...>`），
       * 它当然"包含 XML 与 section 名"——那是它的用途，不是缺陷。
       * 因此这两条检查必须按 modelMode 分流，否则回归集会出现
       * "测试通过但语义错误"的假失败（实测踩到过）。
       */
      {
        type: 'javascript',
        value:
          "context.vars.modelMode !== 'real' ? { pass: true, score: 1, reason: 'echo 模式不适用' } : " +
          "{ pass: !/<response>|<thought>|<actions>/i.test(output), score: /<response>|<thought>|<actions>/i.test(output) ? 0 : 1, " +
          "reason: '回复里不应出现 XML 结构' }",
      },
      {
        type: 'javascript',
        value:
          "context.vars.modelMode !== 'real' ? { pass: true, score: 1, reason: 'echo 模式不适用' } : " +
          "{ pass: !/seed-identity|critical-state|recent-conversation|ContextCompiler/.test(output), score: 1, " +
          "reason: '回复里不应复述上下文条目名' }",
      },
    ],
    metadata: {
      tags: scenario.tags,
      version: scenario.version,
      assertions: scenario.assertions.map((a) => `${a.id}: ${a.description}`),
    },
  }
})

const header = `# 由 scripts/build-promptfoo-config.ts 生成 —— 请勿手工编辑。
#
# 重新生成：node_modules/.bin/tsx scripts/build-promptfoo-config.ts
#
# 注意：本文件里**没有**任何测试数据。场景定义在 evals/scenarios/*.ts，
# 那是唯一真相；Promptfoo 只是执行器之一（plan 第 54 / 87 节）。
#
# 跑法：
#   完整集：node_modules/.bin/promptfoo eval -c evals/promptfoo/promptfooconfig.yaml
#   单个场景：... --filter-metadata scenarioId=SC-004
#   真实模型：把下面 vars.modelMode 改成 real（需要 OPENAI_API_KEY）
`

const config = {
  description: 'project LG / 苏沐薇 Character Kernel —— M2.5 行为回归（外层 Runner）',
  // exec/js provider：调用内部 canonical 场景执行器，不重复实现角色逻辑
  providers: [
    {
      id: 'file://provider.cjs',
      label: 'character-kernel (internal harness)',
      config: { modelMode: 'echo' },
    },
  ],
  prompts: ['{{scenarioId}}'],
  defaultTest: {
    options: {
      // 中文输出，关闭无关的相似度/模型评分断言
      provider: undefined,
    },
  },
  tests,
}

// 手写 YAML：只需要一个很小子集，避免为了生成配置引入 yaml 依赖
const yaml: string[] = [header, `description: ${JSON.stringify(config.description)}`, '', 'providers:']
for (const provider of config.providers) {
  yaml.push(`  - id: ${JSON.stringify(provider.id)}`)
  yaml.push(`    label: ${JSON.stringify(provider.label)}`)
  yaml.push('    config:')
  yaml.push(`      modelMode: ${JSON.stringify(provider.config.modelMode)}`)
}
yaml.push('')
yaml.push('prompts:')
for (const prompt of config.prompts) yaml.push(`  - ${JSON.stringify(prompt)}`)
yaml.push('')
yaml.push('tests:')
for (const test of tests) {
  yaml.push(`  - description: ${JSON.stringify(test.description)}`)
  yaml.push('    vars:')
  for (const [key, value] of Object.entries(test.vars)) {
    yaml.push(`      ${key}: ${JSON.stringify(value)}`)
  }
  yaml.push('    assert:')
  for (const assertion of test.assert) {
    if (assertion.value === undefined) yaml.push(`      - type: ${assertion.type}`)
    else yaml.push(`      - type: ${assertion.type}`)
    if (assertion.value !== undefined) yaml.push(`        value: ${JSON.stringify(assertion.value)}`)
  }
  yaml.push('    metadata:')
  yaml.push(`      tags: ${JSON.stringify(test.metadata.tags)}`)
  yaml.push(`      version: ${JSON.stringify(test.metadata.version)}`)
  yaml.push(`      assertions:`)
  for (const assertion of test.metadata.assertions as string[]) {
    yaml.push(`        - ${JSON.stringify(assertion)}`)
  }
  yaml.push('')
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${yaml.join('\n')}\n`, 'utf8')

console.log(`已生成 ${OUT.replace(process.cwd(), '')}`)
console.log(`  ${tests.length} 个用例（来自 evals/scenarios 的 canonical 定义）`)
console.log(`  用例：${tests.map((t) => t.vars.scenarioId).join(', ')}`)
