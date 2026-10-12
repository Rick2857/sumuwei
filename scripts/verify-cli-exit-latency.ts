/**
 * CLI 退出延迟门（`pnpm cli:exit:verify`）。
 *
 * ============================================================================
 *  它守的是什么
 * ============================================================================
 * 上游 `@elizaos/core@1.7.2` 的 `AgentRuntime.registerService` 会为**每个服务**
 * 建一个 30 秒的"初始化超时"守卫定时器却**从不清除**。这个孤儿定时器维持着
 * Node 的事件循环 ⇒ 每一次 `src/main.ts` 调用（哪怕只是 `--kernel-status`）
 * 在**命令跑完、库关好之后**还要白等 30 秒才退出。
 *
 * 实测代价：`--kernel-status` 墙钟 **31.4s**，而 CPU profile 里 29.85s/32.65s 是
 * `(idle)`；Live Smoke 一次约 spawn 40 次 `src/main.ts` ⇒ 约 1240s 的墙钟其实是
 * "40 × 31s 的退出税"，不是模型慢。
 *
 * 处理在 `src/infrastructure/runtime/guard-timers.ts`（unref，而不是 process.exit）。
 * **本门是这个处理方式的回归锁**：它不读代码，只看子进程**真的**多久退出。
 *
 * ---------------------------------------------------------------------------
 *  三段式（AGENTS.md §6.7）+ measured_count>0（§6.8）
 * ---------------------------------------------------------------------------
 *   正控：真跑 `main.ts --kernel-status` ⇒ 必须 < 15s 退出、退出码 0、
 *         且**输出完整**（关键行在，证明没有用 process.exit 截断 stdout）。
 *   负控：把**同一个检测器**对准一个复刻上游形状的子进程（`setTimeout(…, 30000)`
 *         且不 unref）⇒ 它必须报"超时"（证明这个检测器真的在量时间，
 *         而不是恒真）。
 *   恢复：同一个检测器对准"把那个定时器 unref 掉"的子进程 ⇒ 必须重新安静。
 *
 * 证据：`artifacts/.fast/cli-exit-latency.json`（该目录不进 git）。
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
/** 阈值刻意给足余量：修复后实测 1.8–3.8s，回归时是 31s+。 */
const BUDGET_MS = 15_000

interface Check {
  name: string
  pass: boolean
  detail: string
}
const checks: Check[] = []
let measured = 0
function check(name: string, pass: boolean, detail = ''): void {
  measured += 1
  checks.push({ name, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail === '' ? '' : `\n       ${detail}`}`)
}

interface RunReading {
  ms: number
  exitCode: number
  stdout: string
  stderr: string
}

function runChild(argv: readonly string[], env: NodeJS.ProcessEnv): RunReading {
  const started = Date.now()
  const r = spawnSync(argv[0] ?? 'node', argv.slice(1), {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    ms: Date.now() - started,
    exitCode: r.status ?? -1,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
  }
}

/** 检测器本体：同一个函数同时用于正控、负控与恢复段。 */
function verdictOf(reading: RunReading, budgetMs = BUDGET_MS): { ok: boolean; why: string } {
  if (reading.ms > budgetMs) {
    return { ok: false, why: `用时 ${(reading.ms / 1000).toFixed(1)}s > 预算 ${(budgetMs / 1000).toFixed(0)}s` }
  }
  return { ok: true, why: `用时 ${(reading.ms / 1000).toFixed(1)}s` }
}

console.log('='.repeat(74))
console.log('CLI 退出延迟门（守"上游孤儿 30s 定时器"不回来）')
console.log('='.repeat(74))

const sandbox = mkdtempSync(join(tmpdir(), 'cli-exit-latency-'))
const sandboxEnv: NodeJS.ProcessEnv = { PGLITE_DATA_DIR: sandbox, PROJECT_LG_SANDBOX: sandbox }

try {
  // ---- 正控：真的跑一次只读命令 ----
  const real = runChild([process.execPath, TSX_CLI, 'src/main.ts', '--kernel-status'], sandboxEnv)
  const verdict = verdictOf(real)
  check('正控：`--kernel-status` 必须在预算内退出（而不是收尾后再白等 30s）', verdict.ok, verdict.why)
  check(
    '正控：退出码 = 0（快不能靠"提前崩掉"换）',
    real.exitCode === 0,
    `exit=${real.exitCode}`
  )
  /*
   * 这一条是**输出完整性**：`process.exit()` 也能让进程立刻结束，但它会截断
   * 尚未落盘的 stdout —— 最后几行往往就是她的回复或一条 FAIL 明细。
   * 所以"快"必须和"尾巴还在"一起断言。
   */
  const hasBody = real.stdout.includes('Character Kernel 状态')
  const hasTail = real.stdout.includes('Stopped')
  check(
    '正控：输出完整（正文在 + 收尾日志在）—— 排除"用 process.exit 截断 stdout 换速度"',
    hasBody && hasTail,
    `正文=${hasBody ? '有' : '缺'} · 收尾日志=${hasTail ? '有' : '缺'} · stdout ${real.stdout.length} 字节`
  )
  check(
    '正控：修复的**机制**真的生效（日志里出现 unref 读数，且个数 > 0）',
    /守卫定时器已 unref：(\d+) 个/.test(real.stdout) &&
      Number(/守卫定时器已 unref：(\d+) 个/.exec(real.stdout)?.[1] ?? '0') > 0,
    (/(\[boot\] 上游守卫定时器已 unref：[^\n]*)/.exec(real.stdout)?.[1] ?? '（日志里没有这一行）')
  )

  // ---- 负控：同一个检测器对准"复刻上游形状"的子进程 ----
  const orphan = runChild(
    [process.execPath, '-e', 'setTimeout(() => {}, 30000)'],
    {}
  )
  const orphanVerdict = verdictOf(orphan)
  check(
    '负控：复刻上游形状（未 unref 的 30s 定时器）⇒ 同一个检测器**必须报超时**',
    orphanVerdict.ok === false && orphan.ms > 25_000,
    `实测 ${(orphan.ms / 1000).toFixed(1)}s · 检测器判定：${orphanVerdict.why}`
  )

  // ---- 恢复：把同一个定时器 unref 掉 ⇒ 检测器重新安静 ----
  const fixed = runChild(
    [process.execPath, '-e', 'const t = setTimeout(() => {}, 30000); t.unref();'],
    {}
  )
  const fixedVerdict = verdictOf(fixed)
  check(
    '恢复：同一个定时器 unref 之后 ⇒ 检测器必须重新安静（证明负控不是"永远报错"）',
    fixedVerdict.ok === true,
    `实测 ${(fixed.ms / 1000).toFixed(1)}s · 检测器判定：${fixedVerdict.why}`
  )
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

const failed = checks.filter((c) => !c.pass)
const verdict = measured === 0 ? 'MEASUREMENT INVALID' : failed.length === 0 ? 'PASS' : 'FAIL'
console.log(
  `\nCLI 退出延迟门：${verdict}（检查 ${measured} 项 · 失败 ${failed.length}）` +
    (measured === 0 ? '  ← 检查了 0 项 ⇒ **不是** PASS（§6.8）' : '')
)

const evidencePath = join(ROOT, 'artifacts', '.fast', 'cli-exit-latency.json')
mkdirSync(dirname(evidencePath), { recursive: true })
writeFileSync(
  evidencePath,
  `${JSON.stringify(
    {
      gate: 'cli:exit:verify',
      generatedAt: new Date().toISOString(),
      verdict,
      measuredCount: measured,
      budgetMs: BUDGET_MS,
      checks: checks.map((c) => ({ name: c.name, pass: c.pass, detail: c.detail })),
      note:
        '守上游 @elizaos/core@1.7.2 `registerService` 的孤儿 30s 定时器（不清除 ⇒ 每次 CLI 调用白等 30s）。' +
        '处理见 src/infrastructure/runtime/guard-timers.ts（unref，不是 process.exit）。' +
        '三段式：真 CLI / 复刻孤儿定时器 / unref 后的同一形状。',
    },
    null,
    2
  )}\n`,
  'utf8'
)
console.log(`证据：artifacts/.fast/cli-exit-latency.json`)

process.exit(verdict === 'PASS' ? 0 : 1)
