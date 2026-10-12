/**
 * Promptfoo Provider —— 外层回归 Runner 与内部场景定义的桥。
 *
 * ============================================================================
 *  它**不是**第二条执行路径
 * ============================================================================
 * 它自己不实现任何角色逻辑：只是调用 `scripts/scenario-json.ts`，
 * 而那支脚本读的是 `evals/scenarios/*.ts`（canonical 定义）。
 * 因此：
 *   · 换掉 Promptfoo，场景不会丢（定义在内部）
 *   · Promptfoo 里**没有**任何写死的测试数据
 *
 * 用 `node:child_process` + `tsx` 而不是直接 import：
 * Promptfoo 是 CommonJS 加载本文件的，而项目是 ESM + `.ts`，
 * 走子进程最稳，也顺便让每个场景拥有独立的数据库进程
 * （plugin-sql 的 PGlite 客户端是**进程级单例**，同进程内无法真正隔离两个库）。
 *
 * 测试用例通过 vars 传入：
 *   vars.scenarioId  —— 要跑哪个场景（SC-001 … SC-007）
 *   vars.modelMode   —— echo（默认，离线）/ real（真实模型）
 * prompt 本身只承载"这是哪个场景 + 想问什么"，不是被喂给模型的内容。
 */

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

class CharacterKernelProvider {
  constructor(options) {
    this.providerId = options?.id || 'project-lg-character-kernel'
    this.config = options?.config || {}
  }

  id() {
    return this.providerId
  }

  async callApi(prompt, context) {
    const vars = context?.vars ?? {}
    const scenarioId = vars.scenarioId
    if (!scenarioId) {
      return { error: '缺少 vars.scenarioId：Promptfoo 用例必须指明要跑哪个场景' }
    }

    const modelMode = vars.modelMode || this.config.modelMode || 'echo'
    const tsx = process.platform === 'win32' ? 'node_modules\\.bin\\tsx.cmd' : 'node_modules/.bin/tsx'

    const started = Date.now()
    const result = spawnSync(
      tsx,
      ['scripts/scenario-json.ts', scenarioId],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        shell: true,
        env: { ...process.env, EVAL_MODEL_MODE: modelMode },
        maxBuffer: 32 * 1024 * 1024,
      },
    )

    const durationMs = Date.now() - started

    // 场景脚本把结果以单行 JSON 打到 stdout；其它日志走 stderr / logger
    const line = String(result.stdout || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('{'))
      .pop()

    if (!line) {
      return {
        error:
          `场景 ${scenarioId} 没有产出可解析的 JSON（退出码 ${result.status}）。\n` +
          `stderr 末尾：${String(result.stderr || '').slice(-600)}`,
      }
    }

    let payload
    try {
      payload = JSON.parse(line)
    } catch (error) {
      return { error: `场景 ${scenarioId} 的 JSON 解析失败：${String(error)}` }
    }

    if (payload.error) {
      return { error: `场景 ${scenarioId} 执行失败：${payload.error}` }
    }

    const turns = payload.turns ?? []
    const replies = turns.map((t) => t.reply)
    const sections = [...new Set(turns.flatMap((t) => t.sections ?? []))]

    // 跨场景不变量被破坏 = 结构性失败：直接以 error 返回，
    // 让 Promptfoo 把它算成"目标系统报错"，而不是"回答质量不好"。
    if (payload.ok === false) {
      const violations = (payload.violations ?? [])
        .map((v) => `[${v.code}] ${v.message}`)
        .join('\n  ')
      return { error: `场景 ${scenarioId} 破坏了跨场景不变量：\n  ${violations}` }
    }

    return {
      output: replies.join('\n---\n'),
      // 结构化事实随 metadata 一起上报，方便在 Promptfoo 的 UI / JSON 里查
      metadata: {
        scenarioId,
        modelMode,
        turnCount: turns.length,
        sections,
        conversationEvents: payload.counts?.conversationEvents ?? 0,
        domainEvents: payload.counts?.domainEvents ?? 0,
        assertions: payload.counts?.assertions ?? 0,
        scenarioDurationMs: payload.durationMs ?? 0,
      },
      tokenUsage: { total: turns.reduce((sum, t) => sum + (t.estimatedTokens ?? 0), 0) },
      cost: 0,
      raw: JSON.stringify(payload).slice(0, 20000),
      latencyMs: durationMs,
    }
  }
}

module.exports = CharacterKernelProvider
