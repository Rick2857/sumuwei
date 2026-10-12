/**
 * `pnpm productivity:sidecar:check` —— **首连自检**。
 *
 * ============================================================================
 *  它回答一个问题：现在这台机器上，浏览器那一档能不能用
 * ============================================================================
 * 它**用生产适配器**（`createBrowserAdapter`）去打你的 sidecar，不另写一套请求。
 * 因此它绿 = "LG 走的那条路通"，而不是"我另写的一个探针能通"。
 *
 * 三个阶段，逐个给读数（失败在哪一段**直接说出来**，不留"看起来连上了"）：
 *
 * ```text
 * ① 传输层   initialize → notifications/initialized → tools/list
 *            ⇒ 上游认不认我们这四种头 / 地址是不是 localhost（127.0.0.1 会 403）
 * ② 工具表   真实工具名 vs LG 白名单
 *            ⇒ 白名单里每个名字是否真实存在（拼错会在这里红）
 * ③ 真浏览器 `browser_snapshot` —— **这一步才需要扩展与真实 profile**
 *            ⇒ ⚠️ 注意：它绿只说明"有个浏览器回答了"，**不等于**登录态继承
 * ```
 *
 * ⚠️ 它**只读**：只调 `browser_snapshot`（白名单里的只读工具），
 *    不点击、不填写、不导航、不改任何页面状态。
 *
 * ```bash
 * # 只验传输层与工具表（不需要扩展）
 * pnpm productivity:sidecar:check
 * # 验登录态继承（需要 --extension + 你自己的浏览器里先打开那个页面）
 * pnpm productivity:sidecar:check --expect-url github.com
 * # 或指定地址
 * pnpm productivity:sidecar:check --url http://localhost:8931/mcp
 * ```
 *
 * 退出码：`0` = 全通（含 --expect-url 命中）· `2` = PARTIAL（能读页面但**不构成**
 * 登录态证据）· `1` = 明确失败。**`2` 与 `0` 是两件事，不要合并。**
 */

import { existsSync, readdirSync } from 'node:fs'

import { ALLOWED_MCP_TOOLS } from '../../src/kernel/action/browser-operations.ts'
import { createBrowserAdapter } from '../../src/infrastructure/action/adapters/browser.ts'

/**
 * 从 sidecar 的 preflight 报错里认出"扩展不在那个 profile 里"，并**扫一遍磁盘**
 * 告诉用户扩展到底装在哪个 profile。
 *
 * ============================================================================
 *  为什么必须自动做这件事（2026-10-04 实测）
 * ============================================================================
 * 上游 preflight 的原话：
 * ```text
 * Playwright Extension not found in "C:\...\Chrome\User Data\Profile 1".
 * Install it from ... or set the PLAYWRIGHT_MCP_EXECUTABLE_PATH ...
 * ```
 * 它**已经把答案说了一半**（在哪个目录里没找到），但：
 * ```text
 * · 用户不一定知道"profile 名字"就是那个目录名（Default / Profile 1 / Profile 2 …）
 * · 更不一定知道扩展其实装在**另一个** profile 里 —— 本机实测就是：
 *   扩展装在 `Default`，而命令里写的是 `"Profile 1"`，而这台机器上**根本没有 Profile 1**
 * ```
 * ⇒ 这里把另外半个补完：纯读盘扫 Chrome/Edge 的 User Data，列出**哪个 profile 装了它**。
 *    不启动任何进程。
 */
const EXTENSION_ID = 'mmlmfjhmonkocbjadbfplnigmagldckm'

interface ProfileHit {
  browser: string
  profile: string
  version: string
}

function scanExtensionProfiles(localAppData: string): ProfileHit[] {
  const hits: ProfileHit[] = []
  const browsers = [
    { name: 'Chrome', root: `${localAppData}\\Google\\Chrome\\User Data` },
    { name: 'Edge', root: `${localAppData}\\Microsoft\\Edge\\User Data` },
  ]
  for (const browser of browsers) {
    if (!existsSync(browser.root)) continue
    let entries: string[]
    try {
      entries = readdirSync(browser.root)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry !== 'Default' && !entry.startsWith('Profile ')) continue
      const extensionDir = `${browser.root}\\${entry}\\Extensions\\${EXTENSION_ID}`
      if (!existsSync(extensionDir)) continue
      let version = '(版本读不到)'
      try {
        const versions = readdirSync(extensionDir)
        if (versions[0] !== undefined) version = versions[0]
      } catch {
        /* 版本读不到不影响"它在不在"这个判断 */
      }
      hits.push({ browser: browser.name, profile: entry, version })
    }
  }
  return hits
}

/** 从 preflight 报错里取出它找的那个 profile 目录名 */
function profileFromPreflightError(message: string): string | undefined {
  const matched = /Playwright Extension not found in "([^"]+)"/.exec(message)
  const path = matched?.[1]
  if (path === undefined) return undefined
  return path.split(/[\\/]/).filter((part) => part !== '').pop()
}

/**
 * 把 URL 里的**凭据**打掉再输出。
 *
 * ============================================================================
 *  为什么（2026-10-04 实测：本工具自己泄露过一次）
 * ============================================================================
 * 扩展刚连上、还没分享目标标签时，`browser_snapshot` 读到的**就是那个 connect 页面**：
 * ```text
 * chrome-extension://mmlm…/connect.html?mcpRelayUrl=ws%3A%2F%2F…&token=PxsgbPTG…
 *                                                                           ^^^^^^^^^^
 * ```
 * 第一版本命令把 `页面 URL` **原样打印** ⇒ 凭据进了终端输出 / JSON 证据 / 工单记录。
 * 这与本批自己的隐私边界直接冲突："连接凭据不进任何证据"。
 *
 * ⇒ 现在：查询串里凡名字像凭据的（token / key / secret / password / auth）一律打码，
 *    只留前 4 位用于辨认"是哪一个"。**其余部分照原样**（否则诊断价值就没了）。
 */
function maskCredentialQuery(url: string): string {
  return url.replace(
    /([?&](?:token|key|secret|password|auth)[^=]*=)([^&\s]*)/gi,
    (_whole: string, prefix: string, value: string) =>
      `${prefix}${value.length <= 4 ? '***' : `${value.slice(0, 4)}***(${String(value.length)} 位)`}`
  )
}

interface ParsedArgs {
  url: string
  json: boolean
  /** 期望在快照里看到的 URL 片段（**证明"读到的就是你那个页面"**的唯一办法） */
  expectUrl?: string
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let url = process.env.CHARACTER_BROWSER_SIDECAR_URL ?? 'http://localhost:8931/mcp'
  let json = false
  let expectUrl: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--url') {
      const next = argv[index + 1]
      if (next !== undefined) {
        url = next
        index += 1
      }
    } else if (arg === '--expect-url') {
      const next = argv[index + 1]
      if (next !== undefined) {
        expectUrl = next
        index += 1
      }
    } else if (arg === '--json') {
      json = true
    }
  }
  return { url, json, ...(expectUrl !== undefined ? { expectUrl } : {}) }
}

const HEADERS = {
  'Content-Type': 'application/json',
  /*
   * ⚠️ 这四个字是官方 Streamable HTTP 传输的硬要求：**每一个 POST** 都要同时接受
   *    application/json 与 text/event-stream，否则 406。
   *    生产适配器发的就是这一份（见 `browser.ts` 的 `rpc`/通知）。
   */
  Accept: 'application/json, text/event-stream',
} as const

async function post(
  url: string,
  body: unknown,
  extra: Record<string, string> = {}
): Promise<{ status: number; session?: string; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...HEADERS, ...extra },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  const session = response.headers.get('mcp-session-id')
  return { status: response.status, ...(session !== null ? { session } : {}), text }
}

/** 从可能带 SSE 帧的响应体里取出 JSON-RPC 对象 */
function parseRpc(text: string): { result?: { tools?: { name?: string }[] }; error?: { message?: string } } | undefined {
  const candidate = text.match(/\{[\s\S]*\}/)
  if (candidate === null) return undefined
  try {
    return JSON.parse(candidate[0]) as ReturnType<typeof parseRpc>
  } catch {
    return undefined
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const report: Record<string, unknown> = { sidecarUrl: args.url, steps: {} }
  const steps = report.steps as Record<string, unknown>

  process.stdout.write(`sidecar = ${args.url}\n`)

  // ── ① 传输层 ──────────────────────────────────────────────────────────
  let session: string | undefined
  try {
    const init = await post(args.url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'project-lg', version: '2.0.0' },
      },
    })
    steps.initializeStatus = init.status
    session = init.session
    if (init.status === 403 && init.text.includes('Access is only allowed at')) {
      steps.initializeFailure = 'host_not_allowed'
      process.stdout.write(
        `① 传输层：**403** —— ${init.text.trim()}\n` +
          '   ⇒ 地址里的主机名不在 sidecar 的允许名单里。\n' +
          '   ⚠️ 上游把回环规范化成 `localhost` ⇒ **把 URL 换成 http://localhost:8931/mcp**（不要用 127.0.0.1）。\n'
      )
      writeJson(args.json, report)
      return 1
    }
    if (init.status !== 200) {
      steps.initializeFailure = `status_${String(init.status)}`
      process.stdout.write(
        `① 传输层：**失败** status=${String(init.status)} body=${maskCredentialQuery(init.text).slice(0, 200)}\n`
      )
      writeJson(args.json, report)
      return 1
    }

    const notify = await post(
      args.url,
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      session !== undefined ? { 'Mcp-Session-Id': session } : {}
    )
    steps.notifyStatus = notify.status

    const listed = await post(
      args.url,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      session !== undefined ? { 'Mcp-Session-Id': session } : {}
    )
    steps.toolsListStatus = listed.status
    const parsed = parseRpc(listed.text)
    const realTools = (parsed?.result?.tools ?? [])
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === 'string')
    steps.realToolCount = realTools.length
    steps.realTools = realTools

    if (init.status === 200 && notify.status === 202 && listed.status === 200) {
      process.stdout.write(
        `① 传输层：**通**（initialize=${String(init.status)} · notify=${String(notify.status)} · tools/list=${String(listed.status)}）\n`
      )
    } else {
      process.stdout.write(
        `① 传输层：**部分失败**（initialize=${String(init.status)} · notify=${String(notify.status)} · tools/list=${String(listed.status)}）\n` +
          '   ⚠️ 若 notify=406：说明少发了 Accept: text/event-stream（本项目已修，见 ADR 记录）。\n'
      )
    }

    // ── ② 工具表 vs 白名单 ───────────────────────────────────────────────
    const missing = ALLOWED_MCP_TOOLS.filter((tool) => !realTools.includes(tool))
    const extraAllowed = realTools.filter((tool) => ALLOWED_MCP_TOOLS.includes(tool))
    steps.whitelistMissing = missing
    steps.whitelistMatched = extraAllowed
    if (missing.length === 0) {
      process.stdout.write(
        `② 工具表：**一致**（真实 ${String(realTools.length)} 个 · 白名单 ${String(ALLOWED_MCP_TOOLS.length)} 个全部存在）\n`
      )
    } else {
      process.stdout.write(`② 工具表：**白名单里有真实表没有的名字**：${missing.join(', ')}\n`)
    }
  } catch (error) {
    steps.transportError = error instanceof Error ? error.message : String(error)
    process.stdout.write(
      `① 传输层：**连不上** —— ${String(steps.transportError)}\n` +
        '   ⇒ 确认 sidecar 正在运行，且 --port 与上面这个地址的端口一致。\n'
    )
    writeJson(args.json, report)
    return 1
  }

  // ── ③ 真浏览器（这一步才需要扩展 + 真实 profile）─────────────────────
  const adapter = createBrowserAdapter({ sidecarUrl: args.url })
  const snapshot = adapter.snapshot
  try {
    const outcome = await snapshot.execute({
      actionId: 'act:sidecar-check',
      operation: 'read',
      target: { type: 'browser_page', confidence: 'exact' },
      args: {},
      now: () => Date.now(),
    } as never)
    const text = outcome.turnContent?.[0]?.text ?? ''
    /*
     * ⚠️ **一切要打印 / 存证据的 URL 都先过 `maskCredentialQuery`**（见它的注释：
     *    本工具曾在 connect 页面上把 `token=` 原样打出来）。
     *    快照正文本身也可能夹着那条 URL ⇒ 正文里也要打码，不能只打 `pageUrl` 那一行。
     */
    const rawPageUrl = /URL:\s*(\S+)/.exec(text)?.[1] ?? '(未取到 URL)'
    const pageUrl = maskCredentialQuery(rawPageUrl)
    const safeText = maskCredentialQuery(text)
    const isConnectPage = rawPageUrl.includes('/connect.html')
    /*
     * ⚠️ 这里**必须**区分"有个浏览器回答了"与"读到的是你那个页面"。
     *
     * 2026-10-04 实测：**没有**扩展在跑时，sidecar 会**自己开一个 Chrome**，
     * 用它自己的 profile（`%LOCALAPPDATA%\ms-playwright-mcp\mcp-chrome-<hash>`）
     * ⇒ 快照拿到的是 `about:blank`（58 字符）。
     * 第一版本命令把这种情况判成"通"，并打印"扩展已连上、profile 里有登录态" ——
     * **那是在说一件没有发生过的事**（与本批 D-9 / D-11 同型的度量缺陷）。
     * ⇒ 现在：空白页 = `PARTIAL`，且只有 `--expect-url` 命中才算真证据。
     */
    const blank = pageUrl === 'about:blank' || text.trim().length < 80
    const matched =
      args.expectUrl !== undefined &&
      pageUrl.toLowerCase().includes(args.expectUrl.toLowerCase())
    steps.snapshotOk = true
    steps.pageUrl = pageUrl
    steps.snapshotChars = text.length
    steps.blank = blank
    steps.connectPage = isConnectPage
    if (args.expectUrl !== undefined) steps.expectUrl = args.expectUrl
    steps.expectUrlMatched = matched

    /*
     * ★ 扩展**连上了但分享的是 connect 页面自己** —— 这是最容易误判成"成功"的一种
     *   （URL 是 `chrome-extension://…`，快照有几百字符 ⇒ 既不空白、也不报错）。
     *   实测就是这一步：relay 说 `Extension connection established`，
     *   而 LG 读到的是那个 connect 页面。**单列出来**，别让它混进"读到了页面"。
     */
    if (isConnectPage && !matched) {
      process.stdout.write(
        '③ 真浏览器：**扩展连上了，但它分享的是 connect 页面自己**（不是你那个页面）\n' +
          `   页面 URL：${pageUrl}\n` +
          '   ⇒ 扩展已经把浏览器接上了（relay 那边会打 `Extension connection established`），\n' +
          '     但 relay 现在盯着的是 sidecar 自己打开的那个连接页。\n' +
          '   ⇒ 在这个**连接页**上把目标标签选给它（页面若有"分享/选择标签"就照做）；\n' +
          '     若页面上没有选择器，就直接**在这个标签里打开你要给她看的网址**\n' +
          '     （扩展盯着的就是这个标签，导航过去即可）。\n' +
          '   ⇒ 然后重跑：pnpm productivity:sidecar:check --expect-url <那个页面的域名>\n'
      )
      writeJson(args.json, report)
      return 2
    }

    if (args.expectUrl !== undefined && matched) {
      process.stdout.write(
        '③ 真浏览器：**通过 —— 这就是登录态继承的证据**\n' +
          `   页面 URL：${pageUrl}\n` +
          `   快照 ${String(text.length)} 字符；命中你给的 --expect-url "${args.expectUrl}"\n` +
          '   ⇒ 读到的**确实是你在自己浏览器里打开的那个页面**。\n'
      )
      writeJson(args.json, report)
      return 0
    }

    if (args.expectUrl !== undefined && !matched) {
      steps.expectUrlMismatch = true
      process.stdout.write(
        `③ 真浏览器：**失败 —— 读到的不是你给的那个页面**\n` +
          `   期望 URL 含 "${args.expectUrl}"，实际读到：${pageUrl}\n` +
          (blank
            ? '   （而且它是个空白页 ⇒ sidecar 开的是它**自己**的浏览器）\n'
            : '   ⇒ 扩展连上了，但**分享的标签不是你要的那个**：请在浏览器里切到那个标签再分享一次。\n')
      )
      writeJson(args.json, report)
      return 1
    }

    if (blank) {
      process.stdout.write(
        '③ 真浏览器：**PARTIAL —— 有个浏览器回答了，但这不证明登录态继承**\n' +
          `   页面 URL：${pageUrl}（空白页 · 快照 ${String(text.length)} 字符）\n` +
          '   ⇒ 这是 sidecar **自己开的一个浏览器**，用着它自己的 profile\n' +
          '     （%LOCALAPPDATA%\\ms-playwright-mcp\\mcp-chrome-<hash>）—— **不是你在用的那个**。\n' +
          '   ⇒ 要拿到登录态的真证据，按这三步：\n' +
          '     1) sidecar 必须用 --extension 启动（扩展已装、token 已设）\n' +
          '     2) 在**你自己的浏览器**里打开一个已登录的页面\n' +
          '     3) 再跑：pnpm productivity:sidecar:check --expect-url <那个页面的域名>\n'
      )
      writeJson(args.json, report)
      return 2
    }

    process.stdout.write(
      '③ 真浏览器：**读到了页面，但没给 --expect-url，无法判定是不是你要的那个**\n' +
        `   页面 URL：${pageUrl}\n` +
        `   快照 ${String(text.length)} 字符 · 开头：${safeText.slice(0, 160).replace(/\s+/g, ' ')}\n` +
        '   ⇒ 想证明"登录态继承"，重跑并加 --expect-url <你那个页面的域名片段>。\n'
    )
    writeJson(args.json, report)
    return 2
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    steps.snapshotOk = false
    steps.snapshotError = message

    /*
     * ★ 最常见的那一条，单独给一份**能直接照做**的诊断。
     *   上游 preflight 只说"那个目录里没有"；我们把它找过的 profile 与
     *   **真正装了扩展的 profile** 并排打出来。
     */
    const lookedIn = profileFromPreflightError(message)
    if (lookedIn !== undefined) {
      steps.preflightProfile = lookedIn
      const localAppData = process.env.LOCALAPPDATA ?? ''
      const hits = localAppData === '' ? [] : scanExtensionProfiles(localAppData)
      steps.extensionFoundIn = hits.map((hit) => `${hit.browser}/${hit.profile}`)
      const lines: string[] = [
        '③ 真浏览器：**失败 —— 扩展没装在你让它找的那个 profile 里**\n',
        `   sidecar 找的是：\`${lookedIn}\`\n`,
      ]
      if (hits.length === 0) {
        lines.push(
          '   ⚠️ 磁盘上**任何一个** profile 里都没找到这个扩展（ID ' + EXTENSION_ID + '）\n',
          '   ⇒ 先按下面的地址把它装上，装完**回到本页重跑**：\n',
          '     https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm\n'
        )
      } else {
        lines.push('   磁盘上**装了**它的 profile：\n')
        for (const hit of hits) {
          lines.push(`     · ${hit.browser} / \`${hit.profile}\`（版本 ${hit.version}）\n`)
        }
        const usable = hits.find((hit) => hit.profile !== lookedIn)
        if (usable !== undefined && !hits.some((hit) => hit.profile === lookedIn)) {
          lines.push(
            '   ⇒ 两个修法（挑一个）：\n',
            `     ① 重启 sidecar 时把 --profile-dir-name 改成 \`"${usable.profile}"\`\n`,
            '     ② 或者**直接去掉** --profile-dir-name（它会自动挑"最后用过且装了扩展"的那个）\n',
            '   ⚠️ profile 名字就是 User Data 下的**目录名**（`Default` / `Profile 1` / …），\n',
            '      不是 Chrome 界面上显示的名字。`chrome://version` 的「配置文件路径」最后一段就是它。\n'
          )
        } else if (hits.some((hit) => hit.profile === lookedIn)) {
          lines.push(
            '   ⚠️ 扩展**在**那个目录里，但 sidecar 说没找到 ⇒ 可能是：\n',
            '     · 它被**禁用**了（chrome://extensions 里看开关）\n',
            '     · 或那个 profile 的目录名/大小写与传参不一致\n'
          )
        }
      }
      process.stdout.write(lines.join(''))
      writeJson(args.json, report)
      return 1
    }

    process.stdout.write(
      `③ 真浏览器：**失败** —— ${message}\n` +
        '   ⇒ 传输层通、工具在，但页面读不到。逐条查：\n' +
        (message.includes('Browser is already in use')
          ? '     ⚠️ 这条"Browser is already in use"= sidecar **自己那个浏览器**还开着\n' +
            '        （profile 在 %LOCALAPPDATA%\\ms-playwright-mcp\\mcp-chrome-<hash>，是持久的）。\n' +
            '        关掉那个窗口、或重启 sidecar 再跑；**不要**为了绕开它去加 --isolated。\n'
          : '') +
        '     · 扩展装了吗？（ID 必须是 mmlmfjhmonkocbjadbfplnigmagldckm）\n' +
        '     · 装在你传 --profile-dir-name 的那个 profile 里吗？\n' +
        '     · PLAYWRIGHT_MCP_EXTENSION_TOKEN 与扩展页面上显示的一致吗？\n' +
        '     · sidecar 的窗口里有没有出现连接页 / 报超时？\n'
    )
    writeJson(args.json, report)
    return 1
  }
}

function writeJson(enabled: boolean, report: unknown): void {
  if (enabled) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stderr.write(`sidecar check 自身出错：${String(error)}\n`)
    process.exitCode = 1
  })
