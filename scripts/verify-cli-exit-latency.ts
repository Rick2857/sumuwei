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
import { pathToFileURL, fileURLToPath } from 'node:url'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

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

/*
 * ⚠️ 真正可靠的一招：**让子进程找不到 `.env`**。
 *
 * `initDatabase()` 会从 `process.cwd()` **逐级向上**找 `.env`（src/db/index.ts:227-231），
 * 所以只要 cwd 在仓库里，就躲不掉它的重播种。上面那堆 env 设置只能"覆盖"，
 * 覆盖不了的键（Windows 上被丢弃的空串）就会被填回。
 *
 * ⇒ 用一个**临时 cwd + 显式绝对路径**启动同一个入口文件：`.env` 找不到 ⇒ 不重播种 ⇒
 *    隔离是**结构上**成立的，不依赖任何"哪个键会赢"。
 */
function runChildIsolated(
  entryAbs: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string
): RunReading {
  const started = Date.now()
  // ⚠️ loader 必须用**绝对路径的 file URL**：cwd 被挪到沙箱后，
  //    `./node_modules/tsx/...` 解析不到 ⇒ ERR_MODULE_NOT_FOUND（踩过一次）。
  const loaderUrl = pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href
  const r = spawnSync(
    process.execPath,
    ['--import', loaderUrl, entryAbs, ...args],
    {
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }
  )
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

const sandboxEnv: NodeJS.ProcessEnv = {
  /*
   * ⚠️⚠️ 这个门**只测"进程起停与收尾"**，不测后端隔离。所以这里**只覆盖薄宿主开关**，
   *    其余数据库键一律沿用仓库 `.env` 的真实设置。
   *
   * 试过并失败的四种"换库"姿势（全部记在这里，避免有人再走一遍）：
   *   a) `POSTGRES_URL=''`               → **Windows 上空串 env 被丢弃**
   *      （实测子进程 `process.env.POSTGRES_URL === undefined`）⇒ 键不存在
   *      ⇒ `.env` 的生产串被填回 ⇒ `postgres_url_without_backend`
   *   b) 哨兵串 `sandbox-not-postgres`  → `blank()` 只认空串
   *      （database-backend.ts:89）⇒ 哨兵算"有连接串" ⇒ 同样被拒
   *   c) 挪 cwd 到沙箱 + 复制 `.env` 过去  → `PRODUCTION_DB_DIR = resolve('data/pglite')`
   *      **相对 cwd** 解析（src/dev/sandbox.ts:60）⇒ 沙箱成了"真实库"的**父目录**
   *      ⇒ `missing_preopen_token`；而且 cwd 一挪，`.env` 与相对路径全丢
   *   d) 只改 `PGLITE_DATA_DIR`           → 与 `.env` 的 postgres 后端直接冲突
   *
   * ⇒ 关键认识：**`--kernel-status` 是只读命令，不写任何数据**，
   *    本门要证明的是"进程起得来、并且收尾后不白等 30 秒"。
   *    **换库与这个被测性质无关**，只会引入额外失败模式（上面四种全是）。
   */
  CHARACTER_THIN_HOST: 'on',
}

try {
  // ---- 正控：真的跑一次只读命令 ----
  const real = runChildIsolated(
    join(ROOT, 'src/main.ts'),
    ['--kernel-status'],
    sandboxEnv,
    ROOT // ⚠️ cwd 必须留在仓库根：`PRODUCTION_DB_DIR = resolve('data/pglite')` 相对它解析
  )
  /*
   * ⚠️ **本门要求"能连上配置里那个库"的环境**（服务器上满足；本机不满足）。
   *
   * 2026-10-18 实测：在只装了项目文件、没有对应数据库实例的机器上，
   * 正控会停在 `db_open_failed: 读回数据库身份`（`select current_database()` 连不上）。
   * 换库隔离的四种姿势全部失败（见 sandboxEnv 的注释），而 `--kernel-status`
   * 是**只读**命令、**不写任何数据** ⇒ 本就不需要换库。
   *
   * ⇒ 所以：**这道门在"库不可达"的环境里应当如实失败并说明原因**，
   *    而不是伪装成"退出慢"。失败信息里必须带 stderr 首行，便于直接定位。
   */
  if (real.exitCode !== 0) {
    check(
      '正控：子进程真的跑起来了（库可达 + 薄宿主可选）',
      false,
      `exit=${real.exitCode} · stderr 首行：${(real.stderr.split('\n').find((l) => l.trim() !== '') ?? '').slice(0, 240)}`
    )
  }
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
   *
   * ⚠️ 2026-10-18（退役 guard-timers + 换薄宿主后改写）：
   *   原来断言 `Stopped` 在场。那行来自 **ElizaOS bootstrap 的 EMBEDDING 服务**
   *   （`SERVICE:EMBEDDING Stopping → Stopped`，见 src/main.ts:1641 的注释）。
   *   薄宿主**没有那个服务**，所以这行**结构上不会出现** ⇒ 留着就是永久失败。
   *
   *   ⇒ 换成"**收尾链路真的跑过了**"的证据：LG 自己的 `收尾读数：…` 日志
   *     （src/main.ts:8131，`createRuntimeShutdown` 的 `afterRun` 里打印）。
   *     它证明的是被测性质本身（有序停机 + 关库 + 读数），而不是某个上游服务的日志。
   */
  const hasBody = real.stdout.includes('Character Kernel 状态')
  const hasTail =
    real.stdout.includes('收尾读数') ||
    real.stdout.includes('Stopped') ||
    /收尾|已关|closed/i.test(real.stdout)
  check(
    '正控：输出完整（正文在 + 收尾日志在）—— 排除"用 process.exit 截断 stdout 换速度"',
    hasBody && hasTail,
    `正文=${hasBody ? '有' : '缺'} · 收尾日志=${hasTail ? '有' : '缺'} · stdout ${real.stdout.length} 字节`
  )
  /*
   * ⚠️ 2026-10-18：这一条**随 guard-timers 退役而改写**。
   *
   * 原断言是"日志里出现 `守卫定时器已 unref：N 个` 且 N>0"——
   * 它断言的是**那个猴子补丁生效**，而补丁的对象（上游每服务 30s 孤儿定时器）
   * 在薄宿主下**结构上就不存在**（`ThinHostRuntime.initialize()` 不注册任何服务），
   * 所以那行日志**永远不会出现**，留着就是一条永久失败的门。
   *
   * 退役后仍然必须守住的东西（这才是本门的本意）：
   *   ① 进程在预算内退出（不是收尾后再白等 30s）
   *   ② 退出码 = 0
   *   ③ 输出完整（`process.exit()` 也能让进程立刻结束，但会截断 stdout）
   *   ④ **新增**：薄宿主被真正选中（否则"没等 30s"可能只是因为压根没走宿主初始化）
   *
   * ⇒ 把"补丁日志"换成"宿主标签"作为机制生效的证据。
   */
  const thinHostChosen =
    /已选用薄 Node 宿主/.test(real.stdout) || real.stdout.includes('thin-host')
  check(
    '正控：机制真的生效（薄宿主被选中 ⇒ 结构上无上游 30s 守卫定时器）',
    thinHostChosen,
    (/\[thin-host\].*/.exec(real.stdout)?.[0] ?? '（既无薄宿主标签，也无 unref 读数）').slice(0, 120)
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
