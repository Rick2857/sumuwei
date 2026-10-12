/**
 * Promptfoo Provider（M4）—— 外层 Runner 与 **M4 抽取行为评测**的桥。
 *
 * ============================================================================
 *  它测什么：抽取行为，不是持久化
 * ============================================================================
 * 计划书第 187 节把 Promptfoo 在 M4 的职责划得很清楚：
 *
 *     Memory extraction behavior / authority classification /
 *     contamination cases / explicit intent understanding
 *
 * 而第 188 节明确把另一半排除在外：
 *
 *     DB persistence / idempotency / transaction / replay /
 *     status transition / unique index → **纯程序测试**
 *
 * 所以这里**只**跑 `scripts/eval-m4-extraction.ts`。持久化、重放、
 * 唯一索引那些在 `m4:verify`（142 项）与 `m4:test`（216 项）里 ——
 * 它们的判据是"库里的状态对不对"，交给 LLM Eval 只会把确定性结论
 * 变成概率结论。
 *
 * ---------------------------------------------------------------------------
 *  它不做任何判断
 * ---------------------------------------------------------------------------
 * provider 只做三件事：起子进程、把结果搬过来、把失败说清楚。
 * "什么算通过"**全部**在 `evals/m4/extraction-cases.ts` 与
 * `scripts/eval-m4-extraction.ts` 里 —— 那是 canonical test definition
 * （计划书第 113 节）。若外层再算一遍，那套 Gate 就有两个会各自漂移的定义。
 *
 * 走 `node:child_process` + `tsx` 而不是直接 import（与 M3 的 provider 同一理由）：
 *   · Promptfoo 用 CommonJS 加载本文件，而项目是 ESM + `.ts`
 *   · plugin-sql 的 PGlite 客户端是**进程级单例**，同进程内无法真正隔离
 *     两个库。每个套件一个子进程 = 一个干净的运行环境。
 *
 * 用例通过 vars 传入：
 *   vars.suiteId —— 要跑哪个 M4 套件（extraction / authority / contamination /
 *                   explicit-intent / failure）
 *   vars.live    —— true = 真实模型档；缺省 false = 离线档
 *   vars.filter  —— 可选：只跑该套件里 id 含这个子串的用例（可重复）
 */

const { spawnSync } = require('node:child_process')
const path = require('node:path')

/*
 * ⚠️ 加载 `.env`，否则下面的 Key 守卫会**误报**。
 *
 * Promptfoo 自己会尝试加载 `.env`，但那是它的行为、不是我们的保证：
 * 一旦它没加载（版本差异、cwd 不同、配置里关了），
 * "真实模型档"会变成"Provider 报错说缺 Key" ——
 * 而报错读起来像用户没配，实际是环境加载问题。
 *
 * 失败关闭：`dotenv` 缺失时**不**静默继续（那会让下面的守卫读到空 Key，
 * 把一个环境问题说成"你没设 API Key"）。
 */
try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') })
} catch (error) {
  throw new Error(
    `M4 provider 无法加载 dotenv（${String(error)}）。` +
      '不静默继续：缺少 .env 会让"真实模型档"误报成"没有 API Key"。'
  )
}

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

class M4ExtractionSuiteProvider {
  constructor(options) {
    this.providerId = options?.id || 'project-lg-m4-extraction'
    this.config = options?.config || {}
  }

  id() {
    return this.providerId
  }

  async callApi(prompt, context) {
    const vars = context?.vars ?? {}
    const suiteId = vars.suiteId || this.config.suiteId
    if (!suiteId) {
      return { error: '缺少 vars.suiteId：Promptfoo 用例必须指明要跑哪个 M4 套件' }
    }

    const live = vars.live === true || vars.live === 'true' || this.config.live === true

    /*
     * ⚠️ 真实模型档必须有 API Key，否则**报错**而不是悄悄退化成离线档。
     *
     * `scripts/eval-m4-extraction.ts` 在缺 Key 时的处理是"全部跳过，
     * 摘要 `skippedAll: true`，退出码 0"。对直接跑脚本的人来说那是对的
     * （明说了"没假装跑"）。但在 Promptfoo 里，一个 `skippedAll` 的
     * 结果是**空的通过** —— 它会显示成绿色，而"真实模型档"的结论
     * 一条都没有。这里把它挡在门外。
     */
    if (live && (process.env.OPENAI_API_KEY ?? '') === '') {
      return {
        error:
          'M4 真实模型档需要 OPENAI_API_KEY，但它没有设置。\n' +
          '  · 离线档：pnpm eval:m4:promptfoo\n' +
          '  · 真实模型档：设置 OPENAI_API_KEY 后再跑 pnpm eval:m4:promptfoo:live\n' +
          '不在这里静默降级成离线档：那会得到一个空的绿色，' +
          '而报告上看起来像"真实模型档已验证"。',
      }
    }

    // Windows 上 npm 的 bin 垫片是 `.cmd`，而 `shell: true` 下两者都能跑。
    const tsx = process.platform === 'win32' ? 'node_modules\\.bin\\tsx.cmd' : 'node_modules/.bin/tsx'

    const args = ['scripts/eval-m4-extraction.ts', '--suite', suiteId, '--quiet']
    if (live) args.push('--live')
    const filters = Array.isArray(vars.filter) ? vars.filter : vars.filter ? [vars.filter] : []
    for (const value of filters) args.push('--filter', String(value))

    const started = Date.now()
    const result = spawnSync(tsx, args, {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      shell: true,
      env: { ...process.env },
      maxBuffer: 32 * 1024 * 1024,
    })
    const durationMs = Date.now() - started

    // 脚本把摘要以**单行 JSON** 打到 stdout；其余日志走 console.log（--quiet 时压掉）。
    const line = String(result.stdout || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('{'))
      .pop()

    /*
     * 退出码 2 = **配置错误**（`--suite` 没匹配到用例、用例表里有空转用例、
     * 或空转判据的门自检失败）。它不是"某条用例红了"，而是"这次根本没测到
     * 它声称要测的东西"—— 因此必须以 `error` 返回，而不是一个失败的断言：
     * 前者在 Promptfoo 里是"目标系统出错"（红），语义上更准确。
     *
     * 实测踩到过：生成了 `--suite dedup` 的配置，而 dedup 套件
     * **一条用例都没有**（类型里预留了，表里还没写）。那时脚本退 2、
     * 没有 JSON，如果只按"没有失败"来判断就会是绿的。
     */
    if (result.status === 2) {
      return {
        error:
          `M4 套件 ${suiteId} 无法执行（退出码 2，配置错误）。\n` +
          `stderr 末尾：\n${String(result.stderr || '').slice(-1500)}`,
      }
    }

    if (!line) {
      return {
        error:
          `M4 套件 ${suiteId} 没有产出可解析的 JSON（退出码 ${result.status}）。\n` +
          `stderr 末尾：\n${String(result.stderr || '').slice(-1500)}`,
      }
    }

    let payload
    try {
      payload = JSON.parse(line)
    } catch (error) {
      return { error: `M4 套件 ${suiteId} 的 JSON 解析失败：${String(error)}` }
    }

    /*
     * `skippedAll` 是**空的通过**：脚本明说了"用例全部跳过（不假装跑了）"。
     * 那对命令行是诚实的，但对 Promptfoo 是一个"什么都没测"的绿色，
     * 因此在这里升级成 error。
     */
    if (payload.skippedAll === true) {
      return {
        error:
          `M4 套件 ${suiteId} 声明 skippedAll —— 一条用例都没跑。\n` +
          '空的绿色比失败更危险：它会在报告里显示成"这一档已验证"。',
      }
    }

    const cases = payload.cases ?? []
    const failed = cases.filter((c) => !c.passed)
    const vacuous = cases.filter((c) => c.vacuous === true)

    return {
      output: JSON.stringify({
        suiteId,
        live: payload.live,
        caseCount: payload.caseCount,
        passed: payload.passed,
        failed: payload.failed,
        ok: payload.ok,
        vacuous: payload.vacuous,
        vacuousCases: payload.vacuousCases,
        failedCases: failed.map((c) => ({
          caseId: c.caseId,
          reasons: c.failedChecks.map((f) => `[${f.id}] ${f.detail}`),
        })),
      }),
      metadata: {
        suiteId,
        live: Boolean(payload.live),
        caseCount: payload.caseCount ?? 0,
        passed: payload.passed ?? 0,
        failed: payload.failed ?? 0,
        ok: Boolean(payload.ok),
        /*
         * 空过的绿进 metadata：它们**不**是失败，但也不能算覆盖。
         * 放在这里，Promptfoo 的报告里能一眼看到"这个套件有几条绿是空的"。
         */
        vacuous: payload.vacuous ?? 0,
        vacuousCases: (payload.vacuousCases ?? []).join(', '),
        // 逐条用例：Promptfoo 的 UI 里能直接看到是哪一条红了
        cases: cases.map((c) => `${c.passed ? '✅' : '❌'}${c.vacuous ? '(空过)' : ''} ${c.caseId}`),
      },
      // token 用量由评测脚本内部调用模型产生，这里拿不到拆分；
      // 报 0 而不是编一个数（与 M3 的 provider 同一处理）。
      tokenUsage: { total: 0 },
      cost: 0,
      raw: JSON.stringify(payload).slice(0, 20000),
      latencyMs: durationMs,
    }
  }
}

module.exports = M4ExtractionSuiteProvider
