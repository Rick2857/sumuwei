/**
 * Promptfoo Provider（M3）—— 外层 Runner 与 **M3 评测套件**的桥。
 *
 * ============================================================================
 *  它与 `evals/promptfoo/provider.cjs` 的分工
 * ============================================================================
 * 那一个是 M2.5 的：跑 `evals/scenarios/*.ts`（SC-001 ~ SC-007 行为回归）。
 * 这一个是 M3 的：跑 `evals/m3/**`（身份 / 完整性 / 会话 / 漂移 / 匿名 / 访谈）。
 *
 * 两者形状相同、职责不同，因此**刻意不合并**：
 *   · M2.5 那套测的是"她还照不照旧规矩说话"
 *   · M3 这套测的是"她是谁、谁说了什么、来源对不对"
 * 混成一份配置之后，"哪条回归红了"会变得难以定位。
 *
 * ---------------------------------------------------------------------------
 *  它不做任何判断
 * ---------------------------------------------------------------------------
 * provider 只做三件事：起子进程、把结果搬过来、把失败说清楚。
 * "什么算通过"**全部**在 `evals/m3` 里（`M3_HARD_ZERO_METRICS` 与各检查），
 * 因为若外层 Runner 自己算一遍，那套 Gate 就有了两个会各自漂移的定义。
 *
 * 走 `node:child_process` + `tsx` 而不是直接 import：
 *   · Promptfoo 用 CommonJS 加载本文件，而项目是 ESM + `.ts`
 *   · 更重要的是：plugin-sql 的 PGlite 客户端是**进程级单例**，
 *     同进程内无法真正隔离两个库（M2.5 的验收报告里记着这次事故）。
 *     每个套件一个子进程 = 每个套件一个干净的库。
 *
 * 用例通过 vars 传入：
 *   vars.suiteId     —— 要跑哪个 M3 套件（identity-core / source-separation / …）
 *   vars.caseFilter  —— 可选：只跑该套件里匹配这个子串的用例
 */

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

class M3SuiteProvider {
  constructor(options) {
    this.providerId = options?.id || 'project-lg-m3-suites'
    this.config = options?.config || {}
  }

  id() {
    return this.providerId
  }

  async callApi(prompt, context) {
    const vars = context?.vars ?? {}
    const suiteId = vars.suiteId || this.config.suiteId
    if (!suiteId) {
      return { error: '缺少 vars.suiteId：Promptfoo 用例必须指明要跑哪个 M3 套件' }
    }

    const caseFilter = vars.caseFilter || this.config.caseFilter

    // Windows 上 npm 的 bin 垫片是 `.cmd`，而 `shell: true` 下两者都能跑。
    // 与既有 provider 保持一致，避免"某台机器上只有一边能跑"。
    const tsx = process.platform === 'win32' ? 'node_modules\\.bin\\tsx.cmd' : 'node_modules/.bin/tsx'

    const args = ['scripts/eval-m3.ts', '--suite', suiteId, '--stdout', '--quiet']
    if (caseFilter) args.push('--filter', caseFilter)

    const started = Date.now()
    const result = spawnSync(tsx, args, {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      shell: true,
      env: { ...process.env },
      maxBuffer: 32 * 1024 * 1024,
    })
    const durationMs = Date.now() - started

    // 脚本把摘要以**单行 JSON** 打到 stdout；其余日志走 stderr / logger。
    // （与 `scripts/scenario-json.ts` 同一约定。）
    const line = String(result.stdout || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('{'))
      .pop()

    if (!line) {
      return {
        error:
          `M3 套件 ${suiteId} 没有产出可解析的 JSON（退出码 ${result.status}）。\n` +
          `stderr 末尾：\n${String(result.stderr || '').slice(-1200)}`,
      }
    }

    let payload
    try {
      payload = JSON.parse(line)
    } catch (error) {
      return { error: `M3 套件 ${suiteId} 的 JSON 解析失败：${String(error)}` }
    }

    /*
     * 硬零指标违规 = **结构性失败**，因此以 `error` 返回而不是"输出不好"。
     *
     * 这个区别很重要：Promptfoo 会把 error 算成"目标系统报错"（红），
     * 而把低分算成"质量不好"（也是红，但语义不同）。
     * 账本里留下错误的事实属于前者 —— 它不是"这次答得不够好"，
     * 而是"这台机器现在不可信"。
     */
    if (payload.hardZeroViolations && payload.hardZeroViolations.length > 0) {
      const lines = payload.hardZeroViolations
        .map((v) => `  · ${v.metric} @ ${v.caseId}：${v.detail}`)
        .join('\n')
      return {
        error:
          `M3 硬零指标不为 0（计划书第 115–118 节）—— 账本里留下了错误的事实：\n${lines}`,
      }
    }

    const cases = payload.cases ?? []
    const failed = cases.filter((c) => !c.passed)

    return {
      output: JSON.stringify({
        suiteId,
        caseCount: payload.caseCount,
        passed: payload.passed,
        failed: payload.failed,
        ok: payload.ok,
        live: payload.live,
        failedCases: failed.map((c) => ({
          caseId: c.caseId,
          reasons: c.failedChecks.map((f) => `[${f.id}] ${f.detail}`),
        })),
      }),
      metadata: {
        suiteId,
        caseCount: payload.caseCount ?? 0,
        passed: payload.passed ?? 0,
        failed: payload.failed ?? 0,
        ok: Boolean(payload.ok),
        live: Boolean(payload.live),
        hardZeroViolations: 0,
        metrics: payload.metrics ?? {},
        // 逐条用例：Promptfoo 的 UI 里能直接看到是哪一条红了
        cases: cases.map((c) => `${c.passed ? '✅' : '❌'} ${c.caseId}`),
      },
      // 没有 token 成本：离线档不调模型（judge 检查一律 skipped）
      tokenUsage: { total: 0 },
      cost: 0,
      raw: JSON.stringify(payload).slice(0, 20000),
      latencyMs: durationMs,
    }
  }
}

module.exports = M3SuiteProvider
