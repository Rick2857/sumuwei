/**
 * 自检：M4 Promptfoo 的**断言本身**是不是空转的。
 *
 * ============================================================================
 *  ⚠️ 这个脚本存在的理由
 * ============================================================================
 * `evals/m4/promptfoo/*.yaml` 里的 javascript 断言是**字符串**。
 * 字符串不会被 typecheck 看见，也不会在生成配置时报错 ——
 * 一个把 `p.failed === 0` 误写成 `p.failed >= 0` 的断言，
 * 会让那个配置**永远绿**，而报告上看不出任何异常。
 *
 * 本项目已经因为同一族的缺陷返工过多次：
 *   · 用例 description 声称验证 X，`expects` 只写了候选数下限
 *   · `maxCandidates: 1` 配 `mustExcludeTypes: []`（空数组在 runner 里不检查）
 *   · `--filter` 传两次时第二个静默覆盖第一个，范围被缩小到 1 条
 *   · `suitesWithoutCases()` 用 `allSuites()` 推导，**恒为空**
 *
 * 所以这里把生成出来的断言**取出来、喂合成 payload、断言它能红**。
 * 一条只能通过、不能失败的断言不是判据。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 本脚本自己也被自检抓过三次（第一版）
 * ---------------------------------------------------------------------------
 * 第一版报了 10 项失败，其中**全部**都是本脚本的错，不是配置的错：
 *   1. 用一份固定的"全绿"载荷去喂所有配置 —— 而每个配置期望的
 *      `caseCount` / `live` 不同，于是它在多数配置上"本来就是红的"
 *   2. "档位错"变异体写成 `live: 该文件是否 live`，那恰好**等于**期望值，
 *      什么都没改 —— 于是它反过来指控所有配置"抓不到档位错"
 *   3. "整档空过"变异体硬编码 `vacuous: 1`，对 2 条用例的配置
 *      还剩 1 条非空过，按设计**本来就该通过**
 *
 * 教训：一个用来验证"判据不空转"的脚本，它自己的构造逻辑同样会空转 ——
 * 所以它对每个配置都要用**该配置的期望值**去构造 payload，
 * 而不是一份全局常量。
 *
 * 跑法：tsx scripts/verify-m4-promptfoo-assertions.ts
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const CONFIG_DIR = join(process.cwd(), 'evals', 'm4', 'promptfoo')

interface Assertion {
  source: string
  fn: (output: string, context: unknown) => { pass: boolean; score: number; reason: string }
}

interface ConfigExpectation {
  file: string
  /** 该配置声明的档位 */
  live: boolean
  /** 该配置声明的用例数 */
  caseCount: number
  assertions: Assertion[]
}

/**
 * 从 YAML 里抠断言与声明的期望值。
 *
 * 只做手写解析（与生成器同一取舍：不为一个很小的子集引入 `yaml` 依赖）。
 */
function loadConfigs(): ConfigExpectation[] {
  const files = readdirSync(CONFIG_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
  const configs: ConfigExpectation[] = []

  for (const file of files) {
    const text = readFileSync(join(CONFIG_DIR, file), 'utf8')
    const assertions: Assertion[] = []

    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('value:')) continue
      const raw = trimmed.slice('value:'.length).trim()
      let source: string
      try {
        source = JSON.parse(raw) as string
      } catch {
        throw new Error(`${file} 里有一行 value: 不是合法 JSON 字符串：${raw.slice(0, 120)}`)
      }
      if (!source.includes('JSON.parse(output)')) continue
      assertions.push({
        source,
        fn: new Function('output', 'context', `return (${source})`) as Assertion['fn'],
      })
    }

    const liveMatch = /^\s*live:\s*(true|false)\s*$/m.exec(text)
    const caseCountMatch = /^\s*caseCount:\s*(\d+)\s*$/m.exec(text)
    if (liveMatch === null || caseCountMatch === null) {
      throw new Error(`${file} 里读不到 live / caseCount —— 生成器的 vars 格式变了？`)
    }

    configs.push({
      file,
      live: liveMatch[1] === 'true',
      caseCount: Number(caseCountMatch[1]),
      assertions,
    })
  }

  return configs
}

const configs = loadConfigs()
if (configs.length === 0) {
  console.error('❌ 一个配置都没读到 —— 生成器或本解析器坏了')
  process.exit(2)
}
if (configs.some((c) => c.assertions.length === 0)) {
  console.error('❌ 有配置一条 JS 断言都没有 —— 那个配置永远不会红')
  process.exit(2)
}

console.log(
  `读到 ${configs.reduce((t, c) => t + c.assertions.length, 0)} 条 JS 断言` +
    `（来自 ${configs.length} 个配置）`
)
console.log('')

let failures = 0

/** 该配置下**应该全绿**的载荷 —— 用该配置自己的期望值构造 */
function greenOf(config: ConfigExpectation): Record<string, unknown> {
  return {
    suiteId: config.file.split('.')[0],
    live: config.live,
    caseCount: config.caseCount,
    passed: config.caseCount,
    failed: 0,
    ok: true,
    vacuous: 0,
    vacuousCases: [],
    failedCases: [],
  }
}

/**
 * 变异体：每个都对应一个**真实可能发生**的坏世界。
 *
 * 它是 `(green) => payload` 而不是一个常量补丁 —— 因为"坏"总是相对
 * 该配置的期望而言的（第一版就是把这个搞错了，见文件头）。
 */
const MUTANTS: { name: string; mutate: (green: Record<string, unknown>) => Record<string, unknown>; why: string }[] =
  [
    {
      name: '有用例失败',
      mutate: (g) => ({ ...g, passed: Math.max(0, (g.caseCount as number) - 1), failed: 1, ok: false }),
      why: '抽取器真的退化了',
    },
    { name: 'ok=false', mutate: (g) => ({ ...g, ok: false }), why: '套件自评未通过' },
    {
      name: '档位错',
      mutate: (g) => ({ ...g, live: !g.live }),
      why: 'provider 把 --live 弄丢了（或反过来多加了），量的是另一档',
    },
    {
      name: '用例数漂移',
      mutate: (g) => ({ ...g, caseCount: (g.caseCount as number) + 1 }),
      why: '用例表加了用例但配置没重新生成',
    },
    {
      name: '整档空过',
      mutate: (g) => ({ ...g, vacuous: g.caseCount }),
      why: '所有判据都没执行，这一档什么都没验证到',
    },
  ]

for (const config of configs) {
  const green = greenOf(config)

  // --- ① 基线：在该配置自己的全绿载荷上，每条断言都必须通过 ------------
  for (const a of config.assertions) {
    const verdict = a.fn(JSON.stringify(green), { vars: { suiteId: green.suiteId } })
    if (verdict.pass !== true) {
      failures += 1
      console.error(`❌ ${config.file}：在全绿载荷上竟然是红的 → ${verdict.reason}`)
    }
  }

  // --- ② 变异体：每个坏世界都必须被**至少一条**断言抓到 ----------------
  for (const mutant of MUTANTS) {
    const payload = mutant.mutate(green)
    const caught = config.assertions.some((a) => {
      const verdict = a.fn(JSON.stringify(payload), { vars: { suiteId: green.suiteId } })
      return verdict.pass !== true
    })

    if (!caught) {
      failures += 1
      console.error(
        `❌ ${config.file}：没有任何断言能抓到「${mutant.name}」（${mutant.why}）—— ` +
          '那个世界发生时这个配置仍然是绿的'
      )
    }
  }
}

console.log('')
console.log('='.repeat(72))
if (failures > 0) {
  console.log(`M4 Promptfoo 断言自检：**${failures} 项失败**`)
  console.log('='.repeat(72))
  process.exit(1)
}

console.log(
  `M4 Promptfoo 断言自检：${configs.reduce((t, c) => t + c.assertions.length, 0)} 条断言全部非空转`
)
console.log(`  ${configs.length} 个配置 × ${MUTANTS.length} 个坏世界，全部被至少一条断言抓到`)
console.log('='.repeat(72))
