/**
 * 浏览器 sidecar 的**进程监管**（ADR-101）。
 *
 * ============================================================================
 *  它是什么 / 它不是什么
 * ============================================================================
 * ```text
 * 是   在 autostart 打开时，把 sidecar 这个**进程**管起来：
 *        健康检查（已有健康的就不重复起）→ 租约 → 起 → 有界等待 → 退出时关掉
 * 不是 它**不**装扩展、**不**选标签、**不**动用户 profile、**不**代理任意 MCP 工具。
 *      "看哪一页"永远是人的决定（ADR-101 §1 的事实①）。
 * ```
 *
 * ⚠️ 缺省路径（autostart=false）下这个模块**根本不会被调用** ——
 *    `main.ts` 只在开关打开时才构造它，因此"只连固定地址"那条路逐字不变。
 *
 * ============================================================================
 *  两个安全判据（都写死在这里，不接受外部传入）
 * ============================================================================
 * ```text
 * ① **只执行固定路径的 cli.js**：目录由配置给，入口名写死
 *    （不查 PATH、不用 npx、不装任何东西、不透传任何来自用户/模型的参数）
 * ② **版本必须与登记的完全一致**：读 `@playwright/mcp/package.json` 的 version 比对；
 *    不一致 ⇒ 拒绝启动（**不是**"反正跑起来了"）—— 与计划书 §3.4
 *    "固定版本 sidecar，不用 npx ...@latest"同一条纪律。
 * ```
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 允许的浏览器通道（闭集；写死，不接受任意字符串） */
const ALLOWED_BROWSERS: readonly string[] = ['chrome', 'msedge']

/** 健康检查的单次预算（毫秒）：它只问"在不在监听、认不认这套协议" */
const HEALTH_TIMEOUT_MS = 3_000

/** 起进程之后等它变健康的总预算（毫秒） */
const START_WAIT_MS = 25_000

/** 轮询间隔 */
const POLL_MS = 750

export interface BrowserSidecarConfig {
  /** MCP 地址，例如 http://localhost:8931/mcp（**主机名必须是 localhost**，见 ADR-100 D-10） */
  readonly url: string
  /** sidecar 目录（其下应有 node_modules/@playwright/mcp） */
  readonly dir: string
  /** token 文件路径（凭据；只读，不进日志） */
  readonly tokenFile: string
  /** `--browser` 的值 */
  readonly browser: string
  /** `--profile-dir-name`；空串 = 不传 */
  readonly profile: string
  /**
   * ★ 2026-10-09 / `ADR-125`：`--caps=` 的取值（逗号分隔）；空串 = 不传。
   *
   * ⚠️ 上游的 `filteredTools` = `能力以 "core" 开头 ∪ caps 里的能力`（再剔除 `skillOnly`）
   *    ⇒ 这一项决定 sidecar **工具表里有几个工具**（默认 25 个；全 caps 下 72 个）。
   *    它**不**决定 LG 允不允许调用（那一层是 `ALLOWED_MCP_TOOLS` + `browserFullTools`）。
   */
  readonly caps: string
  /** 允许的 `@playwright/mcp` 版本 */
  readonly expectedVersion: string
  /**
   * 允许的入口文件指纹（sha256，小写十六进制）。
   *
   * ⚠️ 它是**绊线**，不是完整性的全部：`cli.js` 只有 32 行，真正的实现在
   *    `playwright-core` 里。但"有人换掉了入口"这件事必须能被机器发现
   *    （ADR-101 §5 负控③），而版本 pin 只覆盖"换了一个版本"、不覆盖"同一个版本被改过"。
   *    两条判据一起才闭合：**版本说"是哪个版本"，指纹说"是不是那一份文件"**。
   */
  readonly expectedEntrySha256: string
  /** 租约文件路径（PID · 端口 · 入口指纹） */
  readonly leasePath: string
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

export type SidecarAction = 'already-healthy' | 'started' | 'failed'

export interface SidecarOutcome {
  readonly action: SidecarAction
  /** 闭集原因码（进诊断面；不含凭据） */
  readonly reason?:
    | 'not_configured'
    | 'dir_missing'
    | 'entry_missing'
    | 'package_missing'
    | 'version_mismatch'
    | 'entry_tampered'
    | 'browser_not_allowed'
    | 'token_file_missing'
    | 'token_file_empty'
    | 'url_not_localhost'
    | 'lease_alive_but_unhealthy'
    | 'spawn_failed'
    | 'start_timeout'
  readonly detail?: string
  readonly pid?: number
  readonly waitedMs?: number
  /**
   * ⚠️ **复用**一个已经健康的 sidecar 时，如果**我们自己的配置其实是坏的**，
   *    这里带上那条闭集原因。
   *
   * 理由（2026-10-04 验收时逼出来的）：健康检查排在 preflight 之前，
   * 于是"端口上正好有别人起的 sidecar"会让一个**配错的自启动**看起来完全正常 ——
   * 用户以为自启动在工作，其实它从来没起过任何东西。
   * ⇒ 判据不变（能复用就复用：它确实能用），但**配错这件事必须被说出来**。
   */
  readonly configWarning?: SidecarOutcome['reason']
}

export interface BrowserSidecarSupervisor {
  /** 幂等：已经有健康的就不重复起；**不自动重试**（一次调用一次尝试） */
  ensure: () => Promise<SidecarOutcome>
  /** 关掉**本进程自己起的**那个（没起过 ⇒ 安全 no-op）；幂等 */
  stop: () => Promise<void>
  /** 只问"现在通不通"（不 spawn） */
  isHealthy: () => Promise<boolean>
  /** 本进程是否起过（用于测试与诊断） */
  startedPid: () => number | undefined
}

interface Lease {
  pid: number
  url: string
  startedAt: string
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 端口从 URL 里取；取不到 ⇒ undefined */
function portOf(url: string): number | undefined {
  try {
    const parsed = new URL(url)
    return parsed.port === '' ? undefined : Number(parsed.port)
  } catch {
    return undefined
  }
}

/**
 * 这个 PID 还活着吗。
 *
 * ⚠️ **只回答"活着"，不回答"是我起的那个"**。因此调用方**绝不允许**据此去 kill ——
 *    PID 会被复用。我们只在**持有子进程句柄**时才 kill（见 `stop()`）。
 *    ADR-101 §3.3 原本写的是"PID + 启动时刻双匹配"，本实现**有意收窄**为
 *    "PID 存活 + 端口健康"，并把"租约活着但不健康"如实报成
 *    `lease_alive_but_unhealthy`（**不动它**）——
 *    在 Windows 上从 Node 取别的进程的启动时刻要么 shell 出去解析本地化输出、
 *    要么用原生模块；两者都比这条收窄规则更容易出错，而收窄的方向是**更安全**的。
 */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 表示"存在但没权限" —— 也算活着
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function createBrowserSidecarSupervisor(
  config: BrowserSidecarConfig
): BrowserSidecarSupervisor {
  const now = config.now ?? (() => Date.now())
  const sleep = config.sleep ?? defaultSleep
  let child: ChildProcess | undefined
  let outcome: SidecarOutcome | undefined

  const health = async (): Promise<boolean> => {
    try {
      const response = await fetch(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          /*
           * ⚠️ 这两个值**必须**同时出现（ADR-101 引 ADR-100 D-12）：
           *    官方 Streamable HTTP 传输对每一个 POST 都要求 Accept 同时含
           *    application/json 与 text/event-stream，否则 406。
           */
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'project-lg-supervisor', version: '1.0.0' },
          },
        }),
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      })
      return response.status === 200
    } catch {
      return false
    }
  }

  const readLease = (): Lease | undefined => {
    if (!existsSync(config.leasePath)) return undefined
    try {
      const raw = JSON.parse(readFileSync(config.leasePath, 'utf8')) as Partial<Lease>
      if (typeof raw.pid !== 'number' || typeof raw.url !== 'string') return undefined
      return { pid: raw.pid, url: raw.url, startedAt: String(raw.startedAt ?? '') }
    } catch {
      return undefined
    }
  }

  const writeLease = (pid: number): void => {
    try {
      mkdirSync(dirname(config.leasePath), { recursive: true })
      const lease: Lease = { pid, url: config.url, startedAt: new Date(now()).toISOString() }
      writeFileSync(config.leasePath, `${JSON.stringify(lease, null, 2)}\n`, 'utf8')
    } catch {
      /* 租约写不进去不影响"这一次能不能用"；下次会当成没有租约 */
    }
  }

  /** 装配期检查：这些错了就该在**启动时**说清楚，而不是等用户第一次用浏览器 */
  const preflight = (): SidecarOutcome | undefined => {
    const shared = (reason: SidecarOutcome['reason'], detail: string): SidecarOutcome => ({
      action: 'failed',
      reason,
      detail,
    })
    if (config.dir === '' || config.tokenFile === '') {
      return shared(
        'not_configured',
        '自启动开着，但 CHARACTER_BROWSER_SIDECAR_DIR / _TOKEN_FILE 没配齐'
      )
    }
    // ADR-100 D-10：上游把回环规范化成 localhost 再比对 Host 头 ⇒ 127.0.0.1 会 403
    if (!config.url.includes('//localhost')) {
      return shared('url_not_localhost', `地址必须是 localhost（收到 ${config.url}）`)
    }
    if (portOf(config.url) === undefined) {
      return shared('url_not_localhost', `地址里必须带端口（收到 ${config.url}）`)
    }
    if (!ALLOWED_BROWSERS.includes(config.browser)) {
      return shared(
        'browser_not_allowed',
        `--browser 只允许 ${ALLOWED_BROWSERS.join(' / ')}（收到「${config.browser}」）`
      )
    }
    if (!existsSync(config.dir)) return shared('dir_missing', `目录不存在：${config.dir}`)
    if (!existsSync(entryPath())) {
      return shared('entry_missing', `入口不存在：${entryPath()}`)
    }
    const pkg = packageVersion()
    if (pkg === undefined) {
      return shared('package_missing', '读不到 @playwright/mcp/package.json')
    }
    if (pkg !== config.expectedVersion) {
      return shared(
        'version_mismatch',
        `只允许 ${config.expectedVersion}，装的是 ${pkg}（计划书 §3.4：固定版本，不用 @latest）`
      )
    }
    const actualHash = entrySha256()
    if (actualHash === undefined) {
      return shared('entry_missing', `入口读不出来：${entryPath()}`)
    }
    if (actualHash !== config.expectedEntrySha256.toLowerCase()) {
      return shared(
        'entry_tampered',
        `入口指纹不符（期望 ${config.expectedEntrySha256.slice(0, 12)}…，实际 ${actualHash.slice(0, 12)}…）`
      )
    }
    if (!existsSync(config.tokenFile)) {
      return shared('token_file_missing', `token 文件不存在：${config.tokenFile}`)
    }
    if (readToken() === undefined) {
      return shared('token_file_empty', `token 文件是空的：${config.tokenFile}`)
    }
    return undefined
  }

  const entryPath = (): string =>
    `${config.dir}\\node_modules\\@playwright\\mcp\\cli.js`

  const entrySha256 = (): string | undefined => {
    const path = entryPath()
    if (!existsSync(path)) return undefined
    try {
      return createHash('sha256').update(readFileSync(path)).digest('hex')
    } catch {
      return undefined
    }
  }

  const packageVersion = (): string | undefined => {
    const path = `${config.dir}\\node_modules\\@playwright\\mcp\\package.json`
    if (!existsSync(path)) return undefined
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
      return typeof parsed.version === 'string' ? parsed.version : undefined
    } catch {
      return undefined
    }
  }

  const readToken = (): string | undefined => {
    try {
      const value = readFileSync(config.tokenFile, 'utf8').trim()
      return value === '' ? undefined : value
    } catch {
      return undefined
    }
  }

  const ensure = async (): Promise<SidecarOutcome> => {
    if (await health()) {
      /*
       * 已经有一个健康的 ⇒ **不重复起**（判据不变：它确实能用）。
       * ⚠️ 但配置本身有问题时必须**说出来** —— 否则"端口上正好有别人起的 sidecar"
       *    会让一个配错的自启动看起来完全正常（见 `configWarning` 的注释）。
       */
      const warning = preflight()
      outcome =
        warning === undefined
          ? { action: 'already-healthy' }
          : {
              action: 'already-healthy',
              configWarning: warning.reason,
              detail: warning.detail,
            }
      return outcome
    }
    const preflightFailure = preflight()
    if (preflightFailure !== undefined) {
      outcome = preflightFailure
      return outcome
    }

    const lease = readLease()
    if (lease !== undefined && isPidAlive(lease.pid)) {
      /*
       * ⚠️ 租约里的进程**活着但不健康** ⇒ **不去动它**。
       *    可能是别的实例正在起、也可能 PID 被复用 —— 两种情况下 kill 都是错的。
       *    如实报出来，让人看一眼。
       */
      outcome = {
        action: 'failed',
        reason: 'lease_alive_but_unhealthy',
        detail: `租约里的进程 pid=${String(lease.pid)} 还活着，但 ${config.url} 不健康`,
        pid: lease.pid,
      }
      return outcome
    }
    if (lease !== undefined) {
      // 陈旧租约：进程已经没了 ⇒ 清掉它（**不需要** kill 任何东西），再起一个新的
      try {
        rmSync(config.leasePath, { force: true })
      } catch {
        /* 清不掉也不阻塞启动 */
      }
    }

    const token = readToken()
    if (token === undefined) {
      outcome = { action: 'failed', reason: 'token_file_empty', detail: config.tokenFile }
      return outcome
    }

    const port = portOf(config.url)
    const args = [
      entryPath(),
      '--extension',
      '--port',
      String(port),
      '--browser',
      config.browser,
      ...(config.profile === '' ? [] : ['--profile-dir-name', config.profile]),
      ...(config.caps === '' ? [] : ['--caps', config.caps]),
    ]
    const started = now()
    try {
      child = spawn(process.execPath, args, {
        cwd: config.dir,
        /*
         * ⚠️ token 只经**环境变量**交给子进程；它不进命令行（命令行在进程列表里对
         *    同机其它用户可见），也不进我们任何日志 / 证据。
         * ⚠️ `DEBUG` 刻意**不**透传：relay 的调试日志会打出含 token 的连接页 URL
         *    （ADR-100 D-15 就是这么泄露的）。
         */
        env: { ...process.env, DEBUG: '', PLAYWRIGHT_MCP_EXTENSION_TOKEN: token },
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (error) {
      outcome = {
        action: 'failed',
        reason: 'spawn_failed',
        detail: error instanceof Error ? error.message : String(error),
      }
      return outcome
    }

    const pid = child.pid
    if (pid === undefined) {
      outcome = { action: 'failed', reason: 'spawn_failed', detail: '子进程没有 pid' }
      return outcome
    }
    writeLease(pid)

    // 有界等待：只等 START_WAIT_MS，**不无限等、不重试**
    while (now() - started < START_WAIT_MS) {
      if (await health()) {
        outcome = { action: 'started', pid, waitedMs: now() - started }
        return outcome
      }
      await sleep(POLL_MS)
    }
    // 起不来 ⇒ 关掉我们刚起的那个（**只关我们持有句柄的这个**），并如实报
    await stop()
    outcome = {
      action: 'failed',
      reason: 'start_timeout',
      detail: `等了 ${String(START_WAIT_MS)}ms 仍不健康（pid ${String(pid)} 已关掉）`,
      pid,
      waitedMs: now() - started,
    }
    return outcome
  }

  const stop = async (): Promise<void> => {
    const current = child
    child = undefined
    if (current === undefined) {
      // 没起过 ⇒ 安全 no-op。**不清**租约：那份租约可能是**别的实例**的有效租约。
      return
    }
    try {
      current.kill()
    } catch {
      /* 已经退出 */
    }
    // 有界等待它真的消失；到点还没走就强杀（我们持有句柄，杀错的风险为 0）
    const deadline = now() + 5_000
    while (current.exitCode === null && current.signalCode === null && now() < deadline) {
      await sleep(100)
    }
    if (current.exitCode === null && current.signalCode === null) {
      try {
        current.kill('SIGKILL')
      } catch {
        /* 已经退出 */
      }
    }
    try {
      rmSync(config.leasePath, { force: true })
    } catch {
      /* 清不掉不阻塞收尾 */
    }
  }

  return {
    ensure,
    stop,
    isHealthy: health,
    startedPid: () => child?.pid,
  }
}
