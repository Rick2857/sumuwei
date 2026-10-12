/**
 * `pnpm productivity:sidecar:autostart:verify` —— ADR-101 §5 的验收。
 *
 * ============================================================================
 *  ⚠️ 它用**替身 sidecar**（stub），不碰真浏览器
 * ============================================================================
 * 验收要反复"起 → 关 → 再起"。而真的 `@playwright/mcp --extension` **每次启动都会
 * 弹出一个浏览器页面**（上游 `_openConnectPageInBrowser`，见 ADR-101 §1）。
 * 拿真入口反复跑，就是往用户屏幕上反复弹窗口 —— 那不是验收，那是骚扰。
 *
 * ⇒ 这里造一个**形状相同**的替身：同一套目录结构（`node_modules/@playwright/mcp/`）、
 *    同一份 `package.json` 版本号、入口是一个**只回答 initialize 的小 HTTP 服务**。
 *    于是监管器的**全部判据**（健康检查、版本 pin、入口指纹、租约、有界等待、关闭）
 *    都真的被走到，而没有任何浏览器被打开。
 *
 * ⚠️ 真入口只被验一次：`--real` 模式（**必须人工看着跑**）。缺省不跑。
 *
 * 判据（ADR-101 §5）：
 * ```text
 * 正控   什么都没在跑 ⇒ 起了一个，健康，租约里的 pid 与真子进程一致
 * 负控①  已经有健康的 ⇒ **不重复起**（进程数不变）
 * 负控②  陈旧租约（pid 已死）⇒ 回收并起新的，不许卡住
 * 负控③a 版本不符 ⇒ 拒启动（version_mismatch），且**没有**新进程
 * 负控③b 入口被改一个字节 ⇒ 拒启动（entry_tampered），且**没有**新进程
 * 负控④  租约活着但不健康 ⇒ 如实报 lease_alive_but_unhealthy，且**不许 kill 它**
 * 恢复   正常配置 ⇒ 又起得来（证明上面几条不是"什么都不起"的假绿）
 * 泄漏   stop() 之后：子进程消失、租约被清
 * 量具   每条都断言"真的量到了"（进程数 / 租约读写次数不许是 0/0）
 * ```
 */

import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createBrowserSidecarSupervisor,
  type SidecarOutcome,
} from '../../src/infrastructure/action/browser-sidecar-supervisor.ts'

const VERSION = '0.0.83'

interface Check {
  name: string
  ok: boolean
  observed: string
}

const checks: Check[] = []
const check = (name: string, ok: boolean, observed: string): void => {
  checks.push({ name, ok, observed })
  process.stdout.write(`${ok ? '  ✅' : '  ❌'} ${name} — ${observed}\n`)
}

/**
 * 取一个**当前没人监听**的端口。
 *
 * ============================================================================
 *  ⚠️ 为什么每条判据都要自己的端口（2026-10-04 第一版验收**假绿**的教训）
 * ============================================================================
 * `ensure()` 的第一件事是健康检查。第一版验收里所有判据共用 8931，于是：
 * ```text
 * 上一条判据留下的替身还在监听 ⇒ 这一条的 ensure() 直接走 already-healthy
 * ⇒ preflight（版本 pin / 入口指纹 / 配置校验）**根本没被走到**
 * ⇒ 负控③a/③b 与四条装配期判据全部拿到 reason=undefined，
 *   而其中一条甚至被误报成"拒启动"（其实它起了个进程又没报原因）
 * ```
 * —— 这正是 AGENTS.md §6.9「数字对，但数字描述的不是你以为的东西」。
 * ⇒ 每条判据一个干净端口：**没有监听 ⇒ 才会走到 preflight**。
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => {
        resolve(port)
      })
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 造一个替身 sidecar 目录。
 *
 * ⚠️ 入口脚本**故意写成一个真会监听端口、并回答 initialize 的程序** ——
 *    否则"健康检查通过"这条判据就是假的（那正是 §6 说的"量具自己也要被验证"）。
 */
function makeStub(root: string, options: { version?: string; tamper?: boolean } = {}): string {
  const dir = join(root, 'sidecar')
  const pkgDir = join(dir, 'node_modules', '@playwright', 'mcp')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(
    join(pkgDir, 'package.json'),
    `${JSON.stringify({ name: '@playwright/mcp', version: options.version ?? VERSION }, null, 2)}\n`,
    'utf8'
  )
  const port = Number(process.env.STUB_PORT ?? '0')
  const entry = [
    "const { createServer } = require('node:http')",
    `const port = Number(process.argv[process.argv.indexOf('--port') + 1] ?? ${String(port)})`,
    'const server = createServer((req, res) => {',
    '  let body = ""',
    '  req.on("data", (c) => { body += c })',
    '  req.on("end", () => {',
    '    res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "stub-1" })',
    '    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "stub" } } }))',
    '  })',
    '})',
    'server.listen(port, "127.0.0.1")',
  ].join('\n')
  const finalEntry = options.tamper === true ? `${entry}\n// tampered\n` : `${entry}\n`
  writeFileSync(join(pkgDir, 'cli.js'), finalEntry, 'utf8')
  return dir
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function stubEntryHash(dir: string, tamper: boolean): string {
  const base = readFileSync(join(dir, 'node_modules', '@playwright', 'mcp', 'cli.js'), 'utf8')
  return sha256(tamper ? base : base)
}

/** 起一个"占住端口假装健康"的服务，用于负控①与负控④ */
function startFakeHealth(port: number): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))
    })
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

async function main(): Promise<number> {
  const realMode = process.argv.includes('--real')
  const root = mkdtempSync(join(tmpdir(), 'lg-sidecar-autostart-'))
  const realDir =
    'artifacts/post-lv2/local/productivity-skills-preparation/browser-sidecar'

  process.stdout.write(`替身根目录：${root}\n`)
  process.stdout.write(realMode ? '模式：--real（会开真浏览器，必须人工看着）\n' : '模式：替身（不会开任何浏览器）\n\n')

  // ── 装配：替身目录 + token 文件 + 端口 ────────────────────────────────
  const dir = realMode ? realDir : makeStub(root)
  const tokenFile = join(root, 'extension-token.txt')
  writeFileSync(tokenFile, 'STUB-TOKEN-0123456789\n', 'utf8')
  const leasePath = join(root, 'browser-sidecar.lease')

  const entryPath = join(dir, 'node_modules', '@playwright', 'mcp', 'cli.js')
  const expectedHash = sha256(readFileSync(entryPath, 'utf8'))

  const make = (
    port: number,
    overrides: Partial<Parameters<typeof createBrowserSidecarSupervisor>[0]> = {}
  ): ReturnType<typeof createBrowserSidecarSupervisor> =>
    createBrowserSidecarSupervisor({
      url: `http://localhost:${String(port)}/mcp`,
      dir,
      tokenFile,
      browser: 'chrome',
      profile: '',
      /*
       * ⚠️ ADR-125 之后这一项是**必填**。本门刻意用空串：它验的是"自启动能不能起、
       *    租约与指纹对不对"，**不**验 caps 的效果 —— caps 的真读数由
       *    `pnpm productivity:sidecar:check`（对着真 sidecar 的 tools/list）与
       *    生产 `tools/list` 计数给出，那是另一条链，不在这里冒充。
       */
      caps: '',
      expectedVersion: VERSION,
      expectedEntrySha256: realMode
        ? '70dab09ab9a5bc1943fb78e2655f00af7349f9931073833919f19c5d7d786ad6'
        : expectedHash,
      leasePath,
      ...overrides,
    })

  /** 用**一个干净的端口**造一个监管器（ADR-101 §5 的隔离要求，见 `freePort` 注释） */
  const makeFresh = async (
    overrides: Partial<Parameters<typeof createBrowserSidecarSupervisor>[0]> = {}
  ): Promise<ReturnType<typeof createBrowserSidecarSupervisor>> =>
    make(await freePort(), overrides)

  /** 正控/负控① 共用一个专用端口（它们**故意**要看到"端口上有没有东西"的变化） */
  const mainPort = await freePort()

  // ── 正控：什么都没在跑 ⇒ 应当起一个 ──────────────────────────────────
  process.stdout.write('=== 正控：什么都没在跑 ===\n')
  const first = make(mainPort)
  const outcome = await first.ensure()
  check(
    '正控：起了一个 sidecar 且健康',
    outcome.action === 'started' && (await first.isHealthy()),
    `action=${outcome.action} pid=${String(outcome.pid)} waited=${String(outcome.waitedMs)}ms`
  )
  check(
    '正控：租约里记的是**真子进程**的 pid',
    existsSync(leasePath) &&
      JSON.parse(readFileSync(leasePath, 'utf8')).pid === outcome.pid,
    `lease pid=${String(JSON.parse(readFileSync(leasePath, 'utf8')).pid ?? 'n/a')}`
  )
  check('量具自检：确实起了进程（pid > 0）', (outcome.pid ?? 0) > 0, `pid=${String(outcome.pid)}`)

  // ── 负控①：已经有健康的 ⇒ 不许重复起 ────────────────────────────────
  process.stdout.write('\n=== 负控①：已经有一个健康的 ===\n')
  const second = make(mainPort)
  const reused = await second.ensure()
  check(
    '负控①：不重复启动（复用已有的）',
    reused.action === 'already-healthy' && second.startedPid() === undefined,
    `action=${reused.action} · 本次没有新 pid=${String(second.startedPid())}`
  )

  // ── 泄漏：stop() 之后子进程消失、租约被清 ────────────────────────────
  process.stdout.write('\n=== 关闭：谁起的谁关 ===\n')
  await first.stop()
  await sleep(500)
  check(
    '关闭：stop() 之后它不再健康（子进程真的没了）',
    !(await first.isHealthy()),
    `healthy=${String(await first.isHealthy())}`
  )
  check('关闭：租约被清掉', !existsSync(leasePath), `lease exists=${String(existsSync(leasePath))}`)

  // ── 恢复：正常配置又起得来（证明上面不是"什么都不起"的假绿）──────────
  process.stdout.write('\n=== 恢复：正常配置应当又起得来 ===\n')
  const third = await makeFresh()
  const restarted = await third.ensure()
  check(
    '恢复：又起得来（排除"永远拒绝"的假绿）',
    restarted.action === 'started' && (await third.isHealthy()),
    `action=${restarted.action} pid=${String(restarted.pid)}`
  )
  await third.stop()
  await sleep(400)

  // ── 负控②：陈旧租约（pid 已死）⇒ 回收并起新的 ───────────────────────
  process.stdout.write('\n=== 负控②：陈旧租约 ===\n')
  mkdirSync(leasePath.substring(0, leasePath.lastIndexOf('\\')), { recursive: true })
  writeFileSync(
    leasePath,
    `${JSON.stringify({ pid: 999999, url: 'http://localhost:1/mcp', startedAt: '2000-01-01T00:00:00.000Z' }, null, 2)}\n`,
    'utf8'
  )
  const fourth = await makeFresh()
  const reclaimed = await fourth.ensure()
  check(
    '负控②：陈旧租约被回收，并起了新的',
    reclaimed.action === 'started' && (reclaimed.pid ?? 0) > 0 && reclaimed.pid !== 999999,
    `action=${reclaimed.action} pid=${String(reclaimed.pid)}`
  )
  await fourth.stop()
  await sleep(400)

  // ── 负控④：租约活着但不健康 ⇒ 如实报，且**不许 kill** ───────────────
  process.stdout.write('\n=== 负控④：租约里的进程活着但不健康 ===\n')
  const liveButUnhealthy = await makeFresh()
  writeFileSync(
    leasePath,
    `${JSON.stringify({ pid: process.pid, url: 'http://localhost:1/mcp', startedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8'
  )
  const guarded = await liveButUnhealthy.ensure()
  check(
    '负控④：如实报 lease_alive_but_unhealthy，且没有去 kill 别人',
    guarded.action === 'failed' && guarded.reason === 'lease_alive_but_unhealthy',
    `action=${guarded.action} reason=${String(guarded.reason)} · 本进程仍存活=${String(true)}`
  )

  // ── 负控③a：版本不符 ⇒ 拒启动 ───────────────────────────────────────
  process.stdout.write('\n=== 负控③a：版本不符 ===\n')
  rmSync(leasePath, { force: true })
  const wrongVersionDir = makeStub(join(root, 'wrongver'), { version: '9.9.9' })
  const badVersion = make(await freePort(), {
    dir: wrongVersionDir,
    expectedVersion: VERSION,
    expectedEntrySha256: sha256(
      readFileSync(join(wrongVersionDir, 'node_modules', '@playwright', 'mcp', 'cli.js'), 'utf8')
    ),
  })
  const wrongVersion = await badVersion.ensure()
  check(
    '负控③a：版本不符 ⇒ 拒启动',
    wrongVersion.action === 'failed' && wrongVersion.reason === 'version_mismatch',
    `reason=${String(wrongVersion.reason)}`
  )
  check(
    '负控③a：**没有**起任何进程',
    badVersion.startedPid() === undefined && !(await badVersion.isHealthy()),
    `startedPid=${String(badVersion.startedPid())}`
  )

  // ── 负控③b：入口被改一个字节 ⇒ 拒启动 ───────────────────────────────
  process.stdout.write('\n=== 负控③b：入口被改 ===\n')
  const tamperedDir = makeStub(join(root, 'tampered'), { tamper: true })
  const tampered = make(await freePort(), {
    dir: tamperedDir,
    expectedVersion: VERSION,
    /*
     * 故意把期望指纹的**最后一位**改掉 ⇒ 与磁盘上那份不符。
     * ⚠️ 不改文件、只改期望：这样测的是"指纹比对真的在跑"，
     *    而不是"我把文件写坏了所以起不来"。
     */
    expectedEntrySha256: sha256(
      readFileSync(join(tamperedDir, 'node_modules', '@playwright', 'mcp', 'cli.js'), 'utf8')
    ).replace(/.$/, (c) => (c === '0' ? '1' : '0')),
  })
  const tamperOutcome = await tampered.ensure()
  check(
    '负控③b：入口指纹不符 ⇒ 拒启动',
    tamperOutcome.action === 'failed' && tamperOutcome.reason === 'entry_tampered',
    `reason=${String(tamperOutcome.reason)}`
  )
  check(
    '负控③b：**没有**起任何进程',
    tampered.startedPid() === undefined && !(await tampered.isHealthy()),
    `startedPid=${String(tampered.startedPid())}`
  )

  // ── 装配期判据：配错了要在启动时就说 ─────────────────────────────────
  process.stdout.write('\n=== 装配期：配错要在启动时就说 ===\n')
  const notLocalhostPort = await freePort()
  const badUrl = make(notLocalhostPort, {
    url: `http://127.0.0.1:${String(notLocalhostPort)}/mcp`,
  })
  const badUrlOutcome = await badUrl.ensure()
  check(
    '装配期：地址不是 localhost ⇒ 直接拒（不给 403 的机会）',
    badUrlOutcome.reason === 'url_not_localhost',
    `reason=${String(badUrlOutcome.reason)}`
  )
  const badBrowser = make(await freePort(), { browser: 'firefox' })
  const badBrowserOutcome = await badBrowser.ensure()
  check(
    '装配期：--browser 不在闭集里 ⇒ 直接拒',
    badBrowserOutcome.reason === 'browser_not_allowed',
    `reason=${String(badBrowserOutcome.reason)}`
  )
  const noToken = make(await freePort(), { tokenFile: join(root, 'nope.txt') })
  const noTokenOutcome = await noToken.ensure()
  check(
    '装配期：token 文件不存在 ⇒ 直接拒（不等到用时才发现）',
    noTokenOutcome.reason === 'token_file_missing',
    `reason=${String(noTokenOutcome.reason)}`
  )
  const emptyTokenFile = join(root, 'empty.txt')
  writeFileSync(emptyTokenFile, '   \n', 'utf8')
  const emptyToken = make(await freePort(), { tokenFile: emptyTokenFile })
  const emptyTokenOutcome = await emptyToken.ensure()
  check(
    '装配期：token 文件是空的 ⇒ 直接拒',
    emptyTokenOutcome.reason === 'token_file_empty',
    `reason=${String(emptyTokenOutcome.reason)}`
  )

  /*
   * ⚠️ 清理要**等文件句柄真的放开**再删：替身进程刚被 kill 时 Windows 上
   *    目录还可能被占（第一版就撞过 `EBUSY ... rmdir`，把一次验收变成了异常退出）。
   *    重试几次即可；删不掉也不该让验收判成失败。
   */
  let cleaned = false
  for (let attempt = 0; attempt < 6 && !cleaned; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true })
      cleaned = true
    } catch {
      await sleep(400)
    }
  }
  process.stdout.write(`\n临时目录清理：${cleaned ? '已删除' : '未能删除（不影响判据）'}\n`)

  const passed = checks.filter((item) => item.ok).length
  process.stdout.write(`\nADR-101 自启动验收：${String(passed)} 通过 / ${String(checks.length - passed)} 失败\n`)
  const measured = checks.length
  process.stdout.write(`量具自检：断言 ${String(measured)} 条${measured > 0 ? '' : '（0 条 = MEASUREMENT INVALID）'}\n`)
  if (measured === 0) return 1
  return passed === checks.length ? 0 : 1
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stderr.write(`自启动验收自身出错：${String(error)}\n`)
    process.exitCode = 1
  })
