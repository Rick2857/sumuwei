/**
 * M6 —— **命令面的纯判定**（不含 CLI 外壳）。
 *
 * ============================================================================
 *  为什么它必须与 CLI 分开
 * ============================================================================
 * `m6:measurement:verify` 要**断言这些守卫会拒绝**（正控/负控/恢复），因此它必须
 * `import` 这些判定。而一个"进口即执行"的 CLI 文件被 import 时会在模块顶层
 * `process.exit` —— 量具门会**在 import 阶段就死掉**，且死因与它要测的东西无关。
 *
 * 本仓库既有惯例是同一个形状：`scripts/m3.5-prompt-baseline.ts` 只有库、没有外壳，
 * 外壳单独放在 `scripts/snapshot-m3.5-prompt-baseline.ts`。
 *
 * 本文件**不读 `process.argv`、不读 `process.env`、不 spawn、不 exit**：
 * 所有输入都是参数，所有输出都是返回值 —— 于是它可以被穷举断言。
 */

import { stripStringsAndComments } from './text-scan.ts'

// ---------------------------------------------------------------------------
// 离线套件（`m6:verify`）
// ---------------------------------------------------------------------------

/** 套件登记表：**唯一**决定 `--suite` 能选什么 */
export const M6_SUITES = [
  { name: 'parts', label: '摘要纯逻辑部件门', script: 'scripts/verify-m6-wp2-rollup.ts' },
  { name: 'wiring', label: '接线门（packet 级 R-2 负控）', script: 'scripts/verify-m6-wp3-wiring.ts' },
  { name: 'reader', label: '只读来源读取面门（隔离库）', script: 'scripts/verify-m6-wp3-reader.ts' },
  { name: 'console', label: '开发者面门（摘要事实的派生与页面纪律）', script: 'scripts/verify-m6-wp5-console.ts' },
  { name: 'faults', label: '降级与动作真相门（隔离库 + 真实网关）', script: 'scripts/verify-m6-wp6a-faults.ts' },
] as const

export type M6SuiteName = (typeof M6_SUITES)[number]['name']

export type SuiteSelection =
  | { ok: true; suites: readonly M6SuiteName[] }
  | { ok: false; code: string; message: string }

/**
 * 套件选择。
 *
 * ⚠️ 第一版把这段逻辑写在 `process.exit` **之后**的顶层代码里，于是
 * "它会不会拒绝"这件事只能靠人读代码 —— 而"默认一口气全跑"恰恰是
 * 一个不该靠自觉维持的纪律。现在它是纯函数，量具门逐条注入并断言。
 */
export function resolveSuiteSelection(argv: readonly string[]): SuiteSelection {
  const index = argv.indexOf('--suite')
  const value = index === -1 ? undefined : argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    return {
      ok: false,
      code: 'suite_required',
      message:
        '必须显式给出 --suite <' +
        `${M6_SUITES.map((s) => s.name).join('|')}|all>：默认一口气全跑会让"跑一下看看"变成真实开销`,
    }
  }
  if (value === 'all') return { ok: true, suites: M6_SUITES.map((s) => s.name) }
  if (!M6_SUITES.some((s) => s.name === value)) {
    return {
      ok: false,
      code: 'suite_unknown',
      message: `未知套件 ${value}（可选：${M6_SUITES.map((s) => s.name).join('|')}|all）`,
    }
  }
  return { ok: true, suites: [value as M6SuiteName] }
}

/**
 * "不偷偷调用模型或搜索"的**机器形式**。
 *
 * ⚠️ 两套清单，判据不同（第一版只有一套，于是被自己的新套件抓了一次假红）：
 *
 * ```text
 *   ① 原始文本里**提到就不行**：模型端点 / 测试包装器 / 搜索 provider 的名字。
 *      它们出现在脚本里（哪怕只是注释）都说明这个脚本与那条链路有牵连，
 *      值得人工看一眼。
 *   ② **代码里**才不行：`fetch(`。一个门完全可能**读**另一个文件里的 `fetch(`
 *      （例如 M6 的开发者面门要检查页面只往 /dev/query 发请求）——
 *      那是字符串，不是调用。因此这一条先剥掉字符串与注释再数。
 * ```
 */
export const M6_SUITE_FORBIDDEN_TOKENS: readonly string[] = [
  'with-test-model',
  'OPENAI_API_KEY',
  'searxng',
  'SearXNG',
]

/** 只在**代码**里查的记号（字符串/注释里的出现不算——参见上面的区分） */
export const M6_SUITE_FORBIDDEN_CODE_TOKENS: readonly string[] = ['fetch(']

/**
 * 剥掉字符串字面量、模板串与注释，只留下**代码形状**（实现见 `scripts/text-scan.ts`）。
 *
 * ⚠️ 它被提到共用模块里，是因为已有三道门各自因为"扫原文"而假红过 ——
 *    理由与边界写在那个模块的头部注释里。
 */
export { stripStringsAndComments } from './text-scan.ts'

export function auditSuiteScripts(
  root: string,
  read: (path: string) => string
): { script: string; offenders: string[] }[] {
  return M6_SUITES.map((suite) => {
    const text = read(`${root}/${suite.script}`.replace(/\\/g, '/'))
    const code = stripStringsAndComments(text)
    return {
      script: suite.script,
      offenders: [
        ...M6_SUITE_FORBIDDEN_TOKENS.filter((token) => text.includes(token)).map(
          (token) => `${token}（原文提及）`
        ),
        ...M6_SUITE_FORBIDDEN_CODE_TOKENS.filter((token) => code.includes(token)).map(
          (token) => `${token}（代码里出现）`
        ),
      ],
    }
  })
}

// ---------------------------------------------------------------------------
// Live 套件（`m6:live`）
// ---------------------------------------------------------------------------

/** 测试包装器注入的标记（唯一来源：`scripts/run-with-test-model.ts`） */
export const TEST_MODEL_WRAPPER_MARKER = 'DSH_TEST_MODEL_WRAPPER'

/** Live 套件登记表。`implemented: false` = 尚未实现，`plannedIn` 写明归属工作包 */
export const M6_LIVE_SUITES = [
  { name: 'smoke', label: '短 Smoke（少量真实轮次）', implemented: false, plannedIn: 'WP10b' },
  { name: 'calibration', label: '质量校准（50 / 100 轮）', implemented: false, plannedIn: 'WP9a' },
  { name: 'long-dialogue', label: '长对话（3 × 500 轮）', implemented: false, plannedIn: 'WP9b' },
] as const

export type M6LiveSuiteName = (typeof M6_LIVE_SUITES)[number]['name']

export type LiveGuardDecision =
  | { ok: false; code: string; message: string }
  | { ok: true; suite: M6LiveSuiteName }

/**
 * 三条 Live 守卫（**纯函数**：只读 argv 与一个布尔标记）。
 *
 * 顺序刻意：先问"选了哪个套件"，再问"经不经过包装器"，最后才问"实现了没有"。
 * 前两条与套件内容无关 —— 它们是**入口纪律**，不该等到套件实现之后才生效。
 */
export function evaluateLiveGuard(input: {
  argv: readonly string[]
  wrapperMarkerPresent: boolean
}): LiveGuardDecision {
  const index = input.argv.indexOf('--suite')
  const value = index === -1 ? undefined : input.argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    return {
      ok: false,
      code: 'suite_required',
      message:
        '必须显式给出 --suite <' +
        `${M6_LIVE_SUITES.map((s) => s.name).join('|')}>：` +
        '默认一口气跑三条长轨迹是一次真实开销（计划书 §9.1）',
    }
  }
  if (!M6_LIVE_SUITES.some((s) => s.name === value)) {
    return {
      ok: false,
      code: 'suite_unknown',
      message: `未知套件 ${value}（可选：${M6_LIVE_SUITES.map((s) => s.name).join('|')}）`,
    }
  }
  if (!input.wrapperMarkerPresent) {
    return {
      ok: false,
      code: 'wrapper_required',
      message:
        `必须经测试包装器运行（pnpm with-test-model pnpm m6:live --suite ${value}）：` +
        `缺少 ${TEST_MODEL_WRAPPER_MARKER} 标记 ⇒ 拒绝，**绝不**回落到 .env 的原 key`,
    }
  }
  const suite = M6_LIVE_SUITES.find((s) => s.name === value)
  if (suite === undefined || !suite.implemented) {
    return {
      ok: false,
      code: 'suite_not_implemented',
      message:
        `套件 ${value} 尚未实现（归属 ${suite?.plannedIn ?? '未登记'}）—— 如实拒绝，不假装跑过。` +
        '真实可跑的真模型入口由 M6.1 交付：' +
        '`pnpm with-test-model pnpm m6.1:live --suite short|long`（本入口只留守卫，不转发）',
    }
  }
  return { ok: true, suite: value as M6LiveSuiteName }
}
