/**
 * 从 M4 抽取评测用例生成 Promptfoo 配置（**每个套件 × 每档一个 YAML**）。
 *
 * ============================================================================
 *  计划书第 49 / 50 / 54 / 113 节：方向是单向的
 * ============================================================================
 *     evals/m4/extraction-cases.ts（手写、进 git、被 typecheck 覆盖）
 *            │
 *            └──生成──►  evals/m4/promptfoo/<套件>[.live].yaml（生成物，可重生成）
 *
 * 生成的 YAML 里**只有**"跑哪个套件、怎么断言"，**没有任何测试数据**。
 * 换掉 Promptfoo 时，用例定义一行都不用改 —— 这是第 54 节
 * "Promptfoo 只是执行器之一"的具体落点，也是第 113 节
 * "内部 Scenario 继续是 canonical test definition"的落点。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 为什么离线档与真实模型档是**两个文件**，不是一个文件里的两条用例
 * ---------------------------------------------------------------------------
 * 两档的失败含义完全不同：
 *   · 离线档红了 = **确定性判据**坏了（注入、意图规则、解析器）→ 必须立刻修
 *   · 真实模型档红了 = 模型行为退化 / prompt 退化 → 需要判断是不是抽样方差
 *
 * 混在一个文件里，"这一轮红的是哪一档"就得从输出里读；分成两个文件，
 * 文件名就是答案。而且离线档可以进不需要 Key 的 CI 门，
 * 真实模型档单独跑 —— 这一条对"评测能不能天天跑"是决定性的。
 *
 * ---------------------------------------------------------------------------
 *  为什么某个套件可能只生成一个文件
 * ---------------------------------------------------------------------------
 * `extraction` / `authority` 套件的用例**全部**需要真实模型（它们测的
 * 就是模型抽得对不对），因此没有离线配置。反过来 `failure` 套件
 * 全部是注入型用例，因此没有真实模型配置。
 *
 * 这个划分是**从用例表算出来的**（`suiteInfos()`），不是人手写的常量 ——
 * 手写的常量和用例表漂移时，漂移方向总是"配置声称覆盖了，实际一条都没跑"。
 *
 * 跑法：tsx scripts/build-m4-promptfoo-config.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  promptfooConfigPlan,
  suiteInfos,
  suitesWithoutCases,
  type ExtractionSuiteInfo,
} from '../evals/m4/extraction-cases.ts'

interface GeneratedFile {
  path: string
  suiteId: string
  live: boolean
  caseIds: string[]
}

/**
 * 断言：把评测脚本的机器可读摘要翻译成 Promptfoo 的通过/失败。
 *
 * ⚠️ 这里**不重新计算**"什么算通过" —— 只读 `passed` / `failed` / `ok`。
 *    若在这里再写一遍判据，那套 Gate 就有两个会各自漂移的定义
 *    （与 M3 的配置生成器同一条理由）。
 */
function assertionsFor(info: ExtractionSuiteInfo, live: boolean): { type: string; value: string }[] {
  /*
   * ⚠️ 真实模型档的用例数是**该套件全部用例**，不是"需要模型的那几条"。
   *
   * 实测踩到过：`explicit-intent.live.yaml` 声明 `caseCount: 1`
   * （只数 M4X-030），而 `--suite explicit-intent --live` 实际跑了
   * **2** 条 —— 因为 `scripts/eval-m4-extraction.ts` 的筛选是
   * "离线档时排除需要模型的用例"，反过来 live 档**不排除**任何用例：
   * 注入型 / 意图规则型的用例不需要模型，因此两档都跑。
   *
   * 那个复用是**对的**（它们本来就是确定性的，多跑一次是好事），
   * 错的是这里去数 `liveCases`。声明与实际不符时这条
   * 覆盖层断言会红 —— 而它红得对：它抓出了声明与事实不一致。
   */
  const cases = live ? [...info.offlineCases, ...info.liveCases] : info.offlineCases
  const caseIds = cases.map((c) => c.id)

  return [
    // --- 结构层：确实跑完了 ------------------------------------------------
    { type: 'javascript', value: 'output.length > 0' },

    /*
     * --- 档位层：证明 `--live` 真的生效了 ---------------------------------
     *
     * ⚠️ 这条不是形式主义。如果 provider 把 `--live` 弄丢了（拼错参数、
     *    vars 没传进去），真实模型档就会**悄悄**跑成离线档 ——
     *    用的是规则抽取器，而规则抽取器在一批用例上天然通过。
     *
     *    那会得到一个绿色的"真实模型档已验证"，而实际上一次模型都没调。
     *    实测过同形的缺陷：`--filter` 传两次时第二个静默覆盖第一个，
     *    范围被缩小到 1 条，输出仍然是"1 通过 / 0 失败"。
     *
     *    所以"这一档真的跑的是这一档"必须是一条断言，而不是一个假设。
     */
    {
      type: 'javascript',
      value:
        `(() => { const p = JSON.parse(output); return { pass: p.live === ${live}, ` +
        `score: p.live === ${live} ? 1 : 0, reason: ` +
        `p.live === ${live} ? '档位正确' : \`档位错：期望 live=${live}，实际 \${p.live}（这一轮量的不是它声称的那一档）\` } })()`,
    },

    // --- 覆盖层：这一档到底跑了哪几条 -------------------------------------
    {
      type: 'javascript',
      value:
        `(() => { const p = JSON.parse(output); const want = ${caseIds.length}; ` +
        `return { pass: p.caseCount === want, score: p.caseCount === want ? 1 : 0, ` +
        `reason: p.caseCount === want ? \`\${want} 条用例\` : ` +
        `\`期望 \${want} 条用例，实际 \${p.caseCount} 条（用例表与配置漂移了）\` } })()`,
    },

    /*
     * --- 空过层：这一档**不能整档都是空的绿** ------------------------------
     *
     * 实测：真实模型档里 M4X-020 / M4X-021 是"候选 0 / 被拒 0"——
     * 它们的判据只在有候选时才执行，模型什么都没抽时**一条都没跑**，
     * 用例是绿的。那个绿说明"模型这次很客气"，**不**说明
     * "防火墙挡住了污染"（而用例名写的正是后者）。
     *
     * 单条空过可以接受（它是真实世界的一种结果）；但一个套件
     * **整档**都空过就毫无意义了 —— 它会在报告里显示成
     * "污染用例全部通过"。
     */
    {
      type: 'javascript',
      value:
        '(() => { const p = JSON.parse(output); const real = p.caseCount - (p.vacuous || 0); ' +
        'return { pass: real > 0, score: real > 0 ? 1 : 0, ' +
        "reason: real > 0 ? `${real}/${p.caseCount} 条有实际判据（${p.vacuous || 0} 条空过）` : " +
        '`整档都是空的绿：${p.caseCount} 条用例全部空过，这一档什么都没验证到` } })()',
    },

    // --- 结论层：用例全部通过 ---------------------------------------------
    {
      type: 'javascript',
      value:
        '(() => { const p = JSON.parse(output); return { pass: p.failed === 0, ' +
        'score: p.failed === 0 ? 1 : 0, reason: p.failed === 0 ? ' +
        '`${p.passed}/${p.caseCount} 用例通过` : ' +
        "`${p.failed} 条用例未通过：` + p.failedCases.map(c => c.caseId + ' → ' + c.reasons.join('；')).join(' | ') } })()",
    },
    {
      type: 'javascript',
      value:
        "(() => { const p = JSON.parse(output); return { pass: p.ok === true, score: p.ok ? 1 : 0, " +
        "reason: p.ok ? '套件整体 ok' : '套件整体 ok=false（见失败用例）' } })()",
    },
  ]
}

/**
 * 手写 YAML：只需要一个很小子集，避免为了生成配置引入 `yaml` 依赖。
 *
 * 与 `scripts/build-m3-promptfoo-config.ts` 同一做法 —— 生成器比依赖便宜，
 * 而且生成出来的东西人眼能直接读、能直接 diff。
 */
function renderYaml(info: ExtractionSuiteInfo, live: boolean): string {
  /*
   * 真实模型档跑**全部**用例（见 `assertionsFor` 上的说明）：
   * 离线档的注入 / 意图用例不需要模型，因此两档都跑。
   */
  const cases = live ? [...info.offlineCases, ...info.liveCases] : info.offlineCases
  const caseIds = cases.map((c) => c.id)
  const fileName = live ? `${info.id}.live.yaml` : `${info.id}.yaml`

  const header = `# 由 scripts/build-m4-promptfoo-config.ts 生成 —— 请勿手工编辑。
#
# 重新生成：pnpm eval:m4:promptfoo:build
#
# ⚠️ 本文件里**没有任何测试数据**。用例定义在 evals/m4/extraction-cases.ts，
# 那是唯一真相；Promptfoo 只是执行器之一（计划书第 49/50/54/113 节）。
#
# 套件：${info.id}（${info.title}）
# 档位：${live ? '真实模型档（需要 OPENAI_API_KEY）' : '离线档（不需要 API Key，确定性判据）'}
# 用例：${caseIds.join(', ')}
#
# 跑法：
#   pnpm eval:m4:promptfoo                                  # 全部离线档
#   pnpm eval:m4:promptfoo:live                             # 全部真实模型档
#   pnpm promptfoo eval -c evals/m4/promptfoo/${fileName}   # 只跑这一个
`
  const line: string[] = [header]
  line.push(`description: ${JSON.stringify(`project LG / 苏沐薇 M4 —— ${info.id}（${info.title}）${live ? ' · 真实模型档' : ' · 离线档'}`)}`)
  line.push('')
  line.push('providers:')
  line.push('  - id: "file://../promptfoo-provider.cjs"')
  line.push(`    label: "m4-extraction (${live ? 'live' : 'offline'})"`)
  line.push('    config:')
  line.push(`      suiteId: ${JSON.stringify(info.id)}`)
  line.push('')
  line.push('prompts:')
  line.push('  - "{{suiteId}}"')
  line.push('')
  line.push('tests:')
  line.push(`  - description: ${JSON.stringify(`${info.id}${live ? ' · live' : ' · offline'} — ${info.title}`)}`)
  line.push('    vars:')
  line.push(`      suiteId: ${JSON.stringify(info.id)}`)
  line.push(`      live: ${live}`)
  line.push(`      caseCount: ${caseIds.length}`)
  line.push(`      caseIds: ${JSON.stringify(caseIds.join(','))}`)
  line.push('    assert:')
  for (const assertion of assertionsFor(info, live)) {
    line.push(`      - type: ${assertion.type}`)
    // 单行化：多行 JS 断言在 YAML 里要写成 block scalar，而手写那套
    // 语法容易出错。压成一行既安全又仍然可读。
    line.push(`        value: ${JSON.stringify(assertion.value)}`)
  }
  line.push('    metadata:')
  line.push(`      suite: ${JSON.stringify(info.id)}`)
  line.push(`      title: ${JSON.stringify(info.title)}`)
  line.push(`      layer: ${JSON.stringify(live ? 'live-model' : 'deterministic')}`)
  line.push(`      caseIds: ${JSON.stringify(caseIds.join(','))}`)
  line.push('')
  return line.join('\n')
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

const infos = suiteInfos()
const generated: GeneratedFile[] = []

/*
 * ⚠️ "应该生成哪些配置"来自 `promptfooConfigPlan()`（用例表里的**唯一定义**），
 *    不是在这里再算一遍。
 *
 * 之前这里与 `run-m4-promptfoo.ts` 各写了一遍同样的规则，然后漂移了：
 * 生成器为 `failure` 也生成了 live 配置（live 档不排除注入型用例），
 * 而 runner 的核对以为只有 4 个 —— 核对报了两处不一致，但指错了方向
 * （真实缺陷是"同一条规则有两个实现"）。
 */
for (const plan of promptfooConfigPlan()) {
  const info = infos.find((i) => i.id === plan.suiteId)
  if (info === undefined) {
    throw new Error(`配置计划里的套件 ${plan.suiteId} 在套件表里找不到 —— 两处定义漂移了`)
  }

  const target = join(process.cwd(), plan.file)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, renderYaml(info, plan.live), 'utf8')
  generated.push({
    path: plan.file,
    suiteId: plan.suiteId,
    live: plan.live,
    caseIds: [...plan.caseIds],
  })
}

// ---------------------------------------------------------------------------
// 汇总（把"没有覆盖到的"也打出来，而不是只报生成成功的）
// ---------------------------------------------------------------------------

console.log(`已生成 ${generated.length} 个 M4 Promptfoo 配置：`)
for (const file of generated) {
  const tag = file.live ? '真实模型档' : '离线档    '
  console.log(`  [${tag}] ${file.path.replace(/\\/g, '/')}  （${file.caseIds.join(', ')}）`)
}

const offline = generated.filter((g) => !g.live)
const live = generated.filter((g) => g.live)
const offlineCases = infos.reduce((total, i) => total + i.offlineCases.length, 0)
const liveCases = infos.reduce((total, i) => total + i.liveCases.length, 0)

console.log('')
console.log(`  套件：${infos.map((i) => i.id).join(', ')}`)
console.log(`  离线档：${offline.length} 个配置 / ${offlineCases} 条用例（不需要 API Key）`)
console.log(`  真实模型档：${live.length} 个配置 / ${liveCases} 条用例（需要 OPENAI_API_KEY）`)

/*
 * ⚠️ 把"类型里预留了、用例表里还没有"的套件**打出来**。
 *
 * 一个存在但不覆盖任何东西的套件必须被看见：否则它会安静地留在那里，
 * 让人以为覆盖率比实际大。`dedup` / `temporal` 当前就是这种状态
 * （M4-014 重启持久化与去重场景还没写进这份表）。
 */
const empty = suitesWithoutCases()
if (empty.length > 0) {
  console.log('')
  console.log(`  ⚠️ 以下套件在用例表里**还没有任何用例**，因此没有配置：${empty.join(', ')}`)
  console.log('     它们不是"通过"，是"未覆盖"—— 不要读成绿色。')
}

const notCovered = infos.filter((i) => i.offlineCases.length === 0).map((i) => i.id)
if (notCovered.length > 0) {
  console.log('')
  console.log(`  说明：以下套件的用例**全部**需要真实模型，因此没有离线档：${notCovered.join(', ')}`)
  console.log('      CI 里它们的覆盖依赖 pnpm eval:m4:promptfoo:live。')
}
