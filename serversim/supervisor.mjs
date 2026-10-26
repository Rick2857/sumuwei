// ============================================================================
//  服务器仿真环境 · 进程监督器（2026-10-20）
// ============================================================================
//
//  它扮演的角色：**systemd**。
//  容器里没有 systemd（Docker 的 PID 1 不是 systemd），但服务器的
//  `lg-qq.service` 的三条策略恰恰是"会不会在服务器上出事"的关键，
//  所以这里按同样的语义实现一份：
//
//  | systemd 单元里的东西        | 本监督器的对应实现                |
//  | -------------------------- | --------------------------------- |
//  | ExecStart=…                | spawn（同样用 `node --import …`） |
//  | WorkingDirectory=仓库根     | cwd = /opt/project-lg            |
//  | Restart=always             | 子进程退出 ⇒ 重新拉起            |
//  | RestartSec=10              | 退出后等 10 秒再拉起              |
//  | KillSignal=SIGINT          | 收到 SIGTERM/SIGINT ⇒ 给子进程发 **SIGINT** |
//  | TimeoutStopSec=180         | 最多等 180 秒，之后才 SIGKILL     |
//  | Environment=TZ=…           | 继承容器的 TZ                     |
//
//  ⚠️ **为什么必须是 SIGINT 而不是 SIGTERM/SIGKILL**
//     `scripts/qq/chat.ts:68` 监听 SIGINT/SIGTERM 并在 finally 里
//     关 OneBot 连接、等核心收尾。SIGKILL 会跳过这一步 ⇒ 核心来不及
//     排空、更来不及关库（INC-01 的事故形态）。服务器的单元文件里
//     写着 `KillSignal=SIGINT` 就是为了这个。
//
//  ⚠️ **诚实边界**：这不是 systemd。
//     · 没有 cgroup、没有 `Restart=on-failure` 的区别（这里等同 always）。
//     · 没有 `ExecStartPre` 的失败关闭语义（入口脚本里手写了等价物）。
//     · 没有 journald。
//     ⇒ 能证明"进程会被正确地有序停掉"，**不能**证明"systemd 会怎么处理"。
// ============================================================================

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = '/opt/project-lg'
const STATE_DIR = process.env.SIM_STATE_DIR ?? '/opt/serversim/state'
const HEARTBEAT = resolve(STATE_DIR, 'heartbeat.json')
/** 暂停哨兵：存在 ⇒ 不起子进程（并把已在跑的子进程**有序**停掉） */
const PAUSE_FILE = resolve(STATE_DIR, 'pause')
const RESTART_SEC = Number(process.env.SIM_RESTART_SEC ?? 10)
const STOP_TIMEOUT_SEC = Number(process.env.SIM_STOP_TIMEOUT_SEC ?? 180)
const COMMAND = process.env.SIM_SERVICE_COMMAND
  ?? 'node --import ./node_modules/tsx/dist/loader.mjs scripts/qq/chat.ts'

const log = (event, extra = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), component: 'serversim-supervisor', event, ...extra }))

let child = null
let restarts = 0
let stopping = false
let startedAt = null
let pauseRequested = false

const paused = () => existsSync(PAUSE_FILE)

function heartbeat () {
  try {
    mkdirSync(dirname(HEARTBEAT), { recursive: true })
    writeFileSync(HEARTBEAT, JSON.stringify({
      at: new Date().toISOString(),
      childPid: child?.pid ?? null,
      childAlive: child !== null && child.exitCode === null && !child.killed,
      restarts,
      startedAt,
      paused: paused(),
      command: COMMAND,
      cwd: REPO,
    }))
  } catch { /* 心跳写不进去不该拖垮服务 */ }
}

function start () {
  if (stopping) return
  if (paused()) { log('start_skipped_paused'); return }
  const [command, ...args] = COMMAND.split(' ').filter(Boolean)
  log('starting', { command, args, cwd: REPO, restarts })
  child = spawn(command, args, {
    cwd: REPO,
    stdio: 'inherit',
    /*
     * ⚠️ `detached: true` ⇒ 子进程成为**进程组组长**。
     *    这是为了能按 systemd `KillMode=control-group` 的语义，
     *    把信号发给**整个组**（外壳 + 它 spawn 的核心），
     *    而不是只发给外壳。
     *
     *    为什么必须发到组：不发到组会**死锁** ——
     *    外壳 spawn 核心后，子进程句柄让外壳的事件循环一直活着（外壳不退出）；
     *    而核心在等外壳的 stdin 关闭（外壳不退出 ⇒ 管道不关 ⇒ 核心不退出）。
     *    ⇒ 只 SIGINT 外壳 ⇒ 两边都不退 ⇒ **PGlite 租约一直被占着**，
     *      下一个要开同一个库的人（迁移）必然拿到 `production_db_in_use`。
     *      实测踩过（2026-10-20）。
     */
    detached: true,
    env: { ...process.env, TZ: process.env.TZ ?? 'Asia/Shanghai' },
  })
  startedAt = new Date().toISOString()
  heartbeat()
  child.on('exit', (code, signal) => {
    log('child_exited', { code, signal })
    child = null
    heartbeat()
    if (stopping) return
    if (paused()) { log('restart_skipped_paused'); return }
    restarts += 1
    log('restart_scheduled', { inSec: RESTART_SEC, restarts })
    setTimeout(() => { if (!stopping && !paused()) start() }, RESTART_SEC * 1000)
  })
  child.on('error', (error) => { log('child_error', { message: error.message }) })
}

/**
 * 给**整个进程组**发信号（systemd `KillMode=control-group` 的语义）。
 * ⚠️ 必须是组：只发给外壳会与核心死锁（见 start() 里的说明）。
 */
function signalChild (signal) {
  if (child === null) return
  const pid = child.pid
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
    log('signaled_process_group', { pid, signal, target: 'group' })
    return
  } catch (error) {
    log('group_signal_failed', { pid, signal, message: error.message })
  }
  try {
    child.kill(signal)
    log('signaled_process', { pid, signal, target: 'child' })
  } catch (error) {
    log('child_signal_failed', { pid, signal, message: error.message })
  }
}

async function stop (signal) {
  if (stopping) return
  stopping = true
  log('stopping', { signal, timeoutSec: STOP_TIMEOUT_SEC })
  if (child === null) { log('stopped', { note: 'no child' }); process.exit(0) }
  // ⚠️ 给的是 SIGINT（与服务器单元的 KillSignal 一致），不是 SIGTERM。
  signalChild('SIGINT')
  const deadline = Date.now() + STOP_TIMEOUT_SEC * 1000
  await new Promise(resolve2 => {
    const timer = setInterval(() => {
      if (child === null || child.exitCode !== null || Date.now() > deadline) { clearInterval(timer); resolve2() }
    }, 250)
  })
  if (child !== null && child.exitCode === null) {
    log('stop_timeout_sigkill', { pid: child.pid })
    child.kill('SIGKILL')
  }
  log('stopped')
  process.exit(0)
}

process.on('SIGTERM', () => { void stop('SIGTERM') })
process.on('SIGINT', () => { void stop('SIGINT') })

/*
 * 心跳兼**暂停哨兵**的观察者。
 *
 * ⚠️ 为什么需要暂停：核心持有 PGlite 的**租约**（同一时刻只允许一个访问者）。
 *    迁移要在同一个库上跑 ⇒ 必须先让核心**有序退出**把租约放掉。
 *    而 supervisor 默认会 10 秒后把它拉回来 ⇒ 迁移会被 `production_db_in_use` 挡。
 *
 * ⇒ 运维序列（与服务器上"停服 → 迁移 → 起服"同形）：
 *    touch /opt/serversim/state/pause   ⇒ 监督器停掉子进程（**SIGINT**，有序）
 *    …跑迁移…
 *    rm /opt/serversim/state/pause      ⇒ 监督器把子进程拉回来
 */
const beat = setInterval(() => {
  heartbeat()
  if (paused() && !stopping && child !== null && !pauseRequested) {
    pauseRequested = true
    log('pause_requested_signaling_child', { pid: child.pid, signal: 'SIGINT' })
    signalChild('SIGINT')
  }
  if (!paused()) {
    pauseRequested = false
    // 解除暂停 ⇒ 把服务拉回来。
    // ⚠️ 这一条**必须**有：暂停期间子进程已经退出，而子进程的 exit 处理
    //    明确"暂停时不重启" ⇒ 没人再拉它，服务就永远起不来了。
    if (!stopping && child === null) start()
  }
}, 2000)
/*
 * ⚠️ 刻意**不** `unref()` 这个定时器。
 *    实测踩过（2026-10-20）：`unref` 之后，暂停期间事件循环里**没有任何活句柄**
 *    （子进程不在、定时器不保活）⇒ Node 立刻退出 ⇒ 容器进入重启循环
 *    ⇒ 正在跑的迁移被 SIGKILL（退出码 137），症状与"迁移本身有问题"极像。
 */

log('supervisor_started', { command: COMMAND, cwd: REPO, restartSec: RESTART_SEC, stopTimeoutSec: STOP_TIMEOUT_SEC, version: fileURLToPath(import.meta.url) })
start()
