/**
 * 浏览器 4 组（第二批计划 §6A / §3.4）。
 *
 * ```text
 * ①②③ 用**受控假 sidecar**（真 MCP JSON-RPC + 受控页面）—— 离线可判定
 * ④    **登录态继承与桌面焦点影响**：需要人工首连真实扩展 ⇒ 如实 `NOT RUN`／`PARTIAL`
 * ```
 *
 * ⚠️ 计划书 §6A 末段逐字："浏览器离线/组件测试使用受控页面；现有 profile 的登录态、
 *    桌面影响在 C 集中验证。" ⇒ 本文件的 ①②③ **不替代** ④。
 */

import { contentOf, resultOf } from './assembly.ts'
import { GroupRecorder } from './reading.ts'
import type { BedEntry, GroupRunner, Suite } from './groups.ts'
import type { GroupReading, VerifyContext } from './reading.ts'
import { isAllowedMcpTool, ALLOWED_MCP_TOOLS, BROWSER_ACTION_MAPPINGS } from '../../src/kernel/action/browser-operations.ts'
import { REAL_SIDECAR_TOOLS, REAL_SIDECAR_TOOLS_ALL_CAPS, REAL_SIDECAR_DANGEROUS } from './sidecar-tools.ts'
import { startFakeSidecar } from './browser-fixture.ts'

function browserOptions(
  entry: BedEntry,
  sidecarUrl: string
): Parameters<BedEntry['bed']['say']>[0]['options'] {
  return {
    switches: { browser: true, taskAutonomy: true },
    sandboxRoot: entry.bed.sandboxRoot,
    recoveryRoot: entry.bed.recoveryRoot,
    turnContentTokens: 2000,
    /*
     * ⚠️ 任务级风险额度 **R2**：`browser.operate` 声明 R2，而组装层缺省是 R1
     *    ⇒ 不抬高就过不了策略第 ④ 步。这不是"为了能跑而放松"：
     *    计划书 §4 要求浏览器 R2 **只在已授权的浏览器任务里**成立，
     *    而这里正是那个"已授权浏览器任务"。
     *    ⚠️ "没抬高时会被拒"那一条在 `common-07` 与 `browser-03` 里有独立读数。
     */
    taskRiskLevel: 'R2',
    browser: { sidecarUrl, timeoutMs: 10_000 },
  }
}

/** 造一个浏览器操作计划（离线确定性） */
function actPlanner(
  action: string,
  args: Record<string, unknown>
): Parameters<BedEntry['bed']['say']>[0]['options']['planner'] {
  return {
    id: 'fixture-browser-planner',
    endpointHost: 'fixture.local',
    async plan() {
      return {
        ok: true,
        plan: {
          goal: `浏览器操作 ${action}`,
          steps: [{ capability: 'browser.operate', operation: 'act', args: { action, ...args } }],
          done: true,
        },
        requestCount: 0,
      }
    },
  }
}

/** 造一个**全工具档**（`browser.mcp`）的操作计划（离线确定性） */
function mcpPlanner(
  tool: string,
  toolArgs: unknown
): Parameters<BedEntry['bed']['say']>[0]['options']['planner'] {
  return {
    id: 'fixture-browser-mcp-planner',
    endpointHost: 'fixture.local',
    async plan() {
      return {
        ok: true,
        plan: {
          goal: `全工具档调用 ${tool}`,
          steps: [{ capability: 'browser.mcp', operation: 'call', args: { tool, toolArgs } }],
          done: true,
        },
        requestCount: 0,
      }
    },
  }
}

const browser01: GroupRunner = {
  id: 'browser-01',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('browser-01')
    const entry = await suite.openBed('browser-01')
    const sidecar = await suite.openSidecar()

    rec.countInput()
    const turn = await entry.bed.say({
      options: browserOptions(entry, sidecar.url),
      text: '帮我看一下当前页面',
      replyText: '（离线固定回复）',
    })
    /* 意图检测层不认"看页面"（那太泛）⇒ 这里直接用 gateway 发一次快照请求 */
    const gateway = entry.bed.gatewayOf(browserOptions(entry, sidecar.url))
    void turn

    const { createActionRequest } = await import('../../src/kernel/action/action-request.ts')
    const { newActionId, newTraceId } = await import('../../src/kernel/contracts/ids.ts')
    const { attestActionInitiatorUnresolved } = await import(
      '../../src/kernel/contracts/attribution.ts'
    )
    const snapshot = await gateway.execute(
      entry.bed.harness.kernel.characterId,
      createActionRequest({
        actionId: newActionId(),
        traceId: newTraceId(),
        capability: 'browser.read',
        operation: 'snapshot',
        requestedBy: { kind: 'user' },
        arguments: {},
        sideEffect: 'read',
      }),
      { initiatorEvidence: attestActionInitiatorUnresolved({ adapterId: 'productivity-verify' }) }
    )
    rec.check(
      '会话：快照成功（sidecar 的 initialize + tools/call 走通）',
      snapshot.status === 'success',
      `status=${snapshot.status} code=${snapshot.error?.code ?? '(无)'}`
    )
    rec.check(
      '会话：请求日志里出现了 initialize（真的建了会话，不是无状态瞎发）',
      sidecar.requestLog.some((item) => item.method === 'initialize'),
      JSON.stringify(sidecar.requestLog)
    )
    const content = snapshot.turnContent?.[0]
    rec.check(
      '标签范围：快照来自**受控页面**（PAGE-MARK-1 在正文里）',
      (content?.text ?? '').includes('PAGE-MARK-1'),
      (content?.text ?? '').slice(0, 160)
    )
    rec.check(
      '标签范围：快照里给出可交互元素引用（e1…e4）',
      ['e1', 'e2', 'e3', 'e4'].every((ref) => (content?.text ?? '').includes(ref)),
      (content?.text ?? '').slice(0, 240)
    )
    /*
     * ★ 2026-10-09 / ADR-125：这一条**换成了仍然成立的那一半**。
     *
     * 旧写法断言"白名单里没有 `browser_close`" —— 那是 C 档授权**之前**的事实，
     * 现在它是假的（`browser_close` 在名单里）。但本组真正要主张的事情没变：
     * **"读快照"这条路（页面操作闭集）不会关掉或切走用户在用的标签。**
     * ⇒ 判据从"白名单里没有"改成"**闭集映射到的工具里没有**"，
     *   并把"关闭能力现在到得了、但只经 `browser.mcp`"作为**读数**记下来。
     */
    const mappedTools = [...new Set(Object.values(BROWSER_ACTION_MAPPINGS).map((m) => m.tool))]
    rec.check(
      '标签范围：**页面操作闭集**里没有任何关闭类工具（这条路上动不了用户的标签）',
      isAllowedMcpTool('browser_tabs') && !mappedTools.some((tool) => tool.includes('close')),
      `闭集映射到：${mappedTools.join(',')}`
    )
    rec.note('全工具档下的关闭能力（ADR-125 授权留痕）', [
      `browser_close 在白名单里 = ${String(isAllowedMcpTool('browser_close'))}（C 档授权）`,
      '但它只能经 browser.mcp 到达（需要 browserFullTools + 任务级 R3）；',
      '本组这条判据管的是另一件事：闭集那条路仍然没有任何关闭类工具。',
    ])
    rec.note('sidecar 请求日志', sidecar.requestLog.map((item) => item.method))
    return rec.finish('已绑定会话 / 任务标签范围')
  },
}

const browser02: GroupRunner = {
  id: 'browser-02',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('browser-02')
    const entry = await suite.openBed('browser-02')
    const sidecar = await suite.openSidecar()

    // ① 填写 ⇒ 页面读回该值（**先填后点**：点击会导航，导航之后元素表就换了）
    rec.countInput()
    const typed = await entry.bed.say({
      options: {
        ...browserOptions(entry, sidecar.url),
        planner: actPlanner('type', { ref: 'e2', text: '验收备注 7.25' }),
      },
      text: '帮我在备注里写一句话',
      replyText: '（离线固定回复）',
    })
    const typeResult = resultOf(typed, 'browser.operate')
    rec.check(
      '填写：操作成功（ref 定位到一个真实存在的输入框）',
      typeResult?.status === 'success',
      `status=${typeResult?.status ?? '(无)'} code=${typeResult?.error?.code ?? '(无)'}`
    )
    rec.check(
      '填写：**页面读回**该值（从 sidecar 的页面状态读，不是看工具回话）',
      sidecar.valueOf('e2') === '验收备注 7.25',
      `value=${String(sidecar.valueOf('e2'))}`
    )

    // ② 操作之后的页面快照里能看到填入的值（进当轮内容）
    rec.countInput()
    const gatewayAfterType = entry.bed.gatewayOf(browserOptions(entry, sidecar.url))
    const { createActionRequest } = await import('../../src/kernel/action/action-request.ts')
    const { newActionId, newTraceId } = await import('../../src/kernel/contracts/ids.ts')
    const { attestActionInitiatorUnresolved } = await import(
      '../../src/kernel/contracts/attribution.ts'
    )
    const snapshot = await gatewayAfterType.execute(
      entry.bed.harness.kernel.characterId,
      createActionRequest({
        actionId: newActionId(),
        traceId: newTraceId(),
        capability: 'browser.read',
        operation: 'snapshot',
        requestedBy: { kind: 'user' },
        arguments: {},
        sideEffect: 'read',
      }),
      { initiatorEvidence: attestActionInitiatorUnresolved({ adapterId: 'productivity-verify' }) }
    )
    rec.check(
      '读回：操作之后的页面快照里能看到填入的值',
      (snapshot.turnContent?.[0]?.text ?? '').includes('验收备注 7.25'),
      (snapshot.turnContent?.[0]?.text ?? '').slice(0, 240)
    )
    suiteCheck(rec, suite, contentOf(typed, 'browser.operate'), '浏览器操作')

    // ③ 点击一个确定的元素引用 ⇒ 页面真的变了
    rec.countInput()
    const clicked = await entry.bed.say({
      options: {
        ...browserOptions(entry, sidecar.url),
        planner: actPlanner('click', { ref: 'e1' }),
      },
      text: '帮我打开报表页',
      replyText: '（离线固定回复）',
    })
    const clickResult = resultOf(clicked, 'browser.operate')
    rec.check(
      '点击：按快照给出的 ref 点击成功',
      clickResult?.status === 'success',
      `status=${clickResult?.status ?? '(无)'} code=${clickResult?.error?.code ?? '(无)'}`
    )
    rec.check(
      '点击：**页面真的变了**（sidecar 的当前 URL 变了，不是"工具说成功"）',
      sidecar.currentUrl().includes('/reports'),
      `currentUrl=${sidecar.currentUrl()}`
    )

    // ④ 过期引用 ⇒ 如实失败，不猜另一个元素（导航之后 e2 已经不在页面上了）
    rec.countInput()
    const stale = await entry.bed.say({
      options: {
        ...browserOptions(entry, sidecar.url),
        planner: actPlanner('click', { ref: 'e2' }),
      },
      text: '帮我点那个已经不在页面上的元素',
      replyText: '（离线固定回复）',
    })
    const staleResult = resultOf(stale, 'browser.operate')
    rec.check(
      '过期引用：如实失败（`execution_failed` + 提示重新取快照）',
      staleResult?.status === 'failed' &&
        (staleResult.error?.message ?? '').includes('快照'),
      `status=${staleResult?.status ?? '(无)'} message=${(staleResult?.error?.message ?? '').slice(0, 160)}`
    )
    rec.check(
      '过期引用：**没有**改成点别的元素（页面 URL 仍是点击之后的那一个）',
      sidecar.currentUrl().includes('/reports') && sidecar.currentUrl() !== '',
      `currentUrl=${sidecar.currentUrl()}`
    )
    return rec.finish('确定元素点击 / 填写及页面读回')
  },
}

function suiteCheck(
  rec: GroupRecorder,
  suite: Suite,
  content: Parameters<Suite['checkTurnContent']>[1],
  label: string
): void {
  suite.checkTurnContent(rec, content, label)
}

const browser03: GroupRunner = {
  id: 'browser-03',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('browser-03')
    const entry = await suite.openBed('browser-03')
    const sidecar = await suite.openSidecar()

    /*
     * ① 白名单 vs **真实工具表**（2026-10-04 改成对着实测读数判）
     *
     * ⚠️ 第一版这里手写了 7 个"禁用名字"，其中 `browser_run_code` /
     *    `browser_download` / `browser_close_all` 在真 sidecar 上**根本不存在**
     *    （真名是 `browser_run_code_unsafe`；另两个没有对应工具）。
     *    于是那条"负控"有一半在测空气 —— 而它**看起来**是绿的。
     * ⇒ 现在对着 `REAL_SIDECAR_TOOLS`（从真 sidecar `tools/list` 拿回来的 25 个原名）判：
     *    · 白名单必须**全是真实存在的名字**（拼错一个名字 ⇒ 运行时才发现 ⇒ 这里先红）
     *    · 真实表里**除白名单那 7 个之外**，一个都不许放行
     *    · 高危名字逐一具名（含实测才发现的 `browser_run_code_unsafe`）
     */
    rec.countInput()
    const notReal = ALLOWED_MCP_TOOLS.filter((tool) => !REAL_SIDECAR_TOOLS_ALL_CAPS.includes(tool))
    rec.check(
      '白名单里的每个名字都**真实存在**于 sidecar 的全工具表里（拼错会在这里红，而不是首连时才红）',
      notReal.length === 0,
      notReal.length === 0
        ? `${String(ALLOWED_MCP_TOOLS.length)} 个名字全部命中全工具表（全表 ${String(REAL_SIDECAR_TOOLS_ALL_CAPS.length)} 个）`
        : `这些名字全工具表里没有：${notReal.join(',')}`
    )

    /*
     * ⚠️ 这一条是**双向**的（ADR-125 加的）：
     *    上面那句只挡"白名单里有假名字"，挡不住"上游有而白名单漏了"。
     *    而本档的主张恰恰是"**全部**工具都放行" ⇒ 漏一个就是主张不成立。
     *    两份名单是**各自独立抄写**的（白名单在 `src/`，读数在 `scripts/`），
     *    所以"同集合"不是同义反复，而是一次真的交叉核对。
     */
    rec.countInput()
    const missingFromWhitelist = REAL_SIDECAR_TOOLS_ALL_CAPS.filter(
      (tool) => !ALLOWED_MCP_TOOLS.includes(tool)
    )
    rec.check(
      '反向：全工具表里**一个都没有被漏掉**（"全部放行"这句话在这里被机器核对）',
      missingFromWhitelist.length === 0,
      missingFromWhitelist.length === 0
        ? `双向一致：${String(ALLOWED_MCP_TOOLS.length)} 个`
        : `这些上游有而白名单没有：${missingFromWhitelist.join(',')}`
    )

    rec.countInput()
    /*
     * ⚠️ 这一条在 ADR-125 之后**换了方向**，但**没有被删掉**：
     *    老版本是"真实表里除白名单那 7 个之外全部拒绝"；
     *    现在是"白名单之外的名字**仍然**一个都不放行"
     *    （构造一个真实表里根本没有的名字）。
     *    ⇒ 判据从"只有 7 个可用"变成"名单之外依然一律不可用"：
     *      授权放开的是**名单内的 72 个**，不是"什么名字都行"。
     */
    const notInWhitelist = [
      'browser_not_a_real_tool',
      'browser_download',
      'browser_run_code',
      'browser_screen_click',
    ].filter((tool) => isAllowedMcpTool(tool))
    rec.check(
      '白名单之外（含历史文档里出现过的错名字）**一个都不放行**',
      notInWhitelist.length === 0,
      notInWhitelist.length === 0
        ? `4 个名字逐一验过：全部拒绝（白名单 ${String(ALLOWED_MCP_TOOLS.length)} 个）`
        : `竟然放行了 ${notInWhitelist.join(',')}`
    )

    rec.countInput()
    /*
     * ★ 2026-10-09 / ADR-125：这 8 个高危名字现在**在名单里** —— 这是本次授权的
     *    **核心事实**，所以它必须是一条**被机器断言的读数**（而不是一句注释）。
     *    仍要断言的另一半：它们**都真实存在**（不许出现"授权了一个不存在的名字"）。
     */
    const dangerousLeaked = REAL_SIDECAR_DANGEROUS.filter((tool) => isAllowedMcpTool(tool))
    const dangerousMissing = REAL_SIDECAR_DANGEROUS.filter(
      (tool) => !REAL_SIDECAR_TOOLS_ALL_CAPS.includes(tool)
    )
    rec.check(
      '授权留痕：8 个高危工具（任意代码 / 网络体 / 文件上传 / 关浏览器 / 对话框）现在**都在名单里**',
      dangerousLeaked.length === REAL_SIDECAR_DANGEROUS.length && dangerousMissing.length === 0,
      dangerousLeaked.length === REAL_SIDECAR_DANGEROUS.length
        ? `${String(REAL_SIDECAR_DANGEROUS.length)} 个高危名字全部放行（ADR-125 授权）`
        : `没有被放行的高危名字：${REAL_SIDECAR_DANGEROUS.filter((tool) => !dangerousLeaked.includes(tool)).join(',')}` +
          (dangerousMissing.length > 0 ? ` · 且这些名字全表里没有：${dangerousMissing.join(',')}` : '')
    )

    /*
     * 正控（**必须有**）：白名单那 7 个名字**必须被放行**。
     *
     * ⚠️ 没有这一条，上面三条断言可以被一个"永远返回 false"的 `isAllowedMcpTool`
     *    全部骗过 —— 那正是"0/0 与全对长得一样"（AGENTS.md §6.8）。
     *    这三条 + 这条合起来才是一个完整判据：
     *      白名单 ⊂ 真实表 · 真实表里除白名单外全拒 · 高危全拒 · **白名单自己全放行**
     */
    rec.countInput()
    const allowedRejected = ALLOWED_MCP_TOOLS.filter((tool) => !isAllowedMcpTool(tool))
    rec.check(
      '正控：白名单里**每一个**名字都必须被放行（否则上面几条会被"永远拒绝"骗过）',
      allowedRejected.length === 0 && ALLOWED_MCP_TOOLS.length === 72,
      allowedRejected.length === 0
        ? `72 个全部放行（正控成立）`
        : `竟然拒了白名单里的：${allowedRejected.join(',')}`
    )

    // ② 闭集之外的动作 ⇒ 适配器在**发出请求之前**就拒（因此 sidecar 零日志）
    const before = sidecar.requestLog.length
    rec.countInput()
    const outOfSet = await entry.bed.say({
      options: {
        ...browserOptions(entry, sidecar.url),
        planner: actPlanner('evaluate', { value: 'document.cookie' }),
      },
      text: '帮我在页面上跑一段脚本',
      replyText: '（离线固定回复）',
    })
    const outResult = resultOf(outOfSet, 'browser.operate')
    rec.check(
      '默认禁用：闭集之外的动作 ⇒ `validation_failed`（不暴露任意工具入口）',
      outResult?.status === 'rejected' && outResult.error?.code === 'validation_failed',
      `status=${outResult?.status ?? '(无)'} code=${outResult?.error?.code ?? '(无)'}`
    )
    rec.check(
      '默认禁用：这条请求**一个包都没发**（白名单闸在发请求之前）',
      sidecar.requestLog.length === before,
      `请求数 ${String(before)} → ${String(sidecar.requestLog.length)}`
    )

    // ③ 白名单外工具名：直接调适配器也发不出去
    const { createBrowserAdapter } = await import(
      '../../src/infrastructure/action/adapters/browser.ts'
    )
    const runtime = createBrowserAdapter({ sidecarUrl: sidecar.url, timeoutMs: 5_000 })
    let whitelistError = ''
    try {
      await runtime.snapshot.execute({
        actionId: (await import('../../src/kernel/contracts/ids.ts')).newActionId(),
        operation: 'snapshot',
        target: { type: 'browser_session', confidence: 'exact' },
        args: {},
        now: () => Date.now(),
      })
      whitelistError = '(没有报错)'
    } catch (error) {
      whitelistError = error instanceof Error ? error.message : String(error)
    }
    rec.countInput()
    rec.check(
      '白名单正控：快照工具**是**允许的（上一条不是"什么都拒绝"）',
      !whitelistError.includes('不在白名单里'),
      whitelistError.slice(0, 120)
    )

    // ④ 断连 ⇒ 如实失败且**点名** sidecar 地址
    await sidecar.close()
    rec.countInput()
    const disconnected = await entry.bed.say({
      options: browserOptions(entry, sidecar.url),
      text: '帮我看一下当前页面',
      replyText: '（离线固定回复）',
    })
    const { createActionRequest } = await import('../../src/kernel/action/action-request.ts')
    const { newActionId, newTraceId } = await import('../../src/kernel/contracts/ids.ts')
    const { attestActionInitiatorUnresolved } = await import(
      '../../src/kernel/contracts/attribution.ts'
    )
    const gateway = entry.bed.gatewayOf(browserOptions(entry, sidecar.url))
    const offline = await gateway.execute(
      entry.bed.harness.kernel.characterId,
      createActionRequest({
        actionId: newActionId(),
        traceId: newTraceId(),
        capability: 'browser.read',
        operation: 'snapshot',
        requestedBy: { kind: 'user' },
        arguments: {},
        sideEffect: 'read',
      }),
      { initiatorEvidence: attestActionInitiatorUnresolved({ adapterId: 'productivity-verify' }) }
    )
    void disconnected
    rec.check(
      '断连：如实失败（`execution_failed`）',
      offline.status === 'failed' && offline.error?.code === 'execution_failed',
      `status=${offline.status} code=${offline.error?.code ?? '(无)'}`
    )
    rec.check(
      '断连：失败话术**点名** sidecar 地址（"哪里错了"可回答）',
      (offline.error?.message ?? '').includes(sidecar.url),
      (offline.error?.message ?? '').slice(0, 200)
    )
    rec.check(
      '断连：**没有**产出当轮内容（没拿到页面就不给"页面内容"）',
      offline.turnContent === undefined,
      '竟然产出了内容'
    )
    return rec.finish('默认禁用工具 / 超范围导航 / 断连')
  },
}

const browser04: GroupRunner = {
  id: 'browser-04',
  async run(_ctx: VerifyContext, _suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('browser-04')
    /*
     * ========================================================================
     *  本组**离线不可判定**，如实 `NOT RUN`（计划书 §6A 末段逐字）
     * ========================================================================
     * 它的三条判据都要求**真实已登录的浏览器**：
     * ```text
     * ① 登录态继承：官方扩展连接既有 profile（cookie / 登录状态真的在）
     * ② 焦点影响：首连与正常动作是否触发 `chrome.tabs.update(active:true)` /
     *    `chrome.windows.update(focused:true)`
     * ③ 标签组隔离：用户正在用的标签是否被保留
     * ```
     * 三条都需要**人工首连**（安装扩展 + 选择 profile + 允许连接）。
     * ⚠️ 用受控页面顶替它们 = 用一个假读数换掉一个真读数（本仓库最忌讳的形状）。
     */
    return rec.finish('登录态继承与焦点 / 窗口影响', {
      notRunReason:
        '需要人工首连真实 Chrome/Edge profile 与官方扩展：登录态继承、桌面焦点影响、' +
        '用户标签保留三条都只能对**真实已登录会话**判定。' +
        '受控假 sidecar（browser-01/02/03）**不替代**本组。' +
        '计划书 §3.4 已登记上游 background.ts 含 active:true / focused:true 的具体影响面，' +
        '需在首连后实测。',
    })
  },
}

/**
 * ★ 2026-10-09 / `ADR-125`：**全工具档**（`browser.mcp`）的正负控。
 *
 * ```text
 * 正控①  browser_evaluate   ⇒ 真的调用、且上游返回值进了当轮内容（EVAL-MARK-1）
 * 正控②  browser_cookie_list ⇒ caps 组工具同样可达（FIXTURE-COOKIE-1）
 * 正控③  默认 25 个工具仍在全表里（本档**没有**把老能力挤掉）
 * 负控①  任务额度只有 R2    ⇒ R3 的能力被策略拒（**额度没抬到 R3 就到不了**）
 * 负控②  开关关着           ⇒ 这一步在**计划层**就被丢（连提出都不成立）
 * 负控③  tool 名字不在名单  ⇒ `unsupported` 且**一个包都没发**
 * 负控④  toolArgs 不是对象  ⇒ `validation_failed` 且**一个包都没发**
 * ```
 *
 * ⚠️ 本组**不**验证"真实浏览器里真的能读到你站点的 cookie"——那需要真实已登录
 *    profile（`browser-04` 的 C 集）。这里验的是 **LG 侧这条路通不通、闸门对不对**。
 */
const browser05: GroupRunner = {
  id: 'browser-05',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('browser-05')
    const entry = await suite.openBed('browser-05')
    /*
     * ⚠️ **不用 `suite.openSidecar()`**（2026-10-09 踩到）：那是**全 suite 共享**的实例，
     *    而 `browser-03` 的"断连如实失败"检查会把它 `close()` 掉且**不重启**
     *    ⇒ 排在它之后的组一律 `fetch failed`（本组第一次跑就是这个形态，全部判据都不产生结果）。
     *    ⇒ 新组一律**自建夹具、用完关掉**：既不污染别人，也不被别人污染。
     */
    const sidecar = await startFakeSidecar()

    const fullOptions = (
      risk: 'R2' | 'R3'
    ): Parameters<BedEntry['bed']['say']>[0]['options'] => ({
      ...browserOptions(entry, sidecar.url),
      switches: { browser: true, taskAutonomy: true, browserFullTools: true },
      taskRiskLevel: risk,
    })

    // ① 正控：任意 JS（browser_evaluate）真的被调用，且返回值进了当轮内容
    rec.countInput()
    const evaluated = await entry.bed.say({
      options: {
        ...fullOptions('R3'),
        planner: mcpPlanner('browser_evaluate', '{"expression":"document.title"}'),
      },
      text: '帮我在当前页面上执行一段 JavaScript 表达式',
      replyText: '（离线固定回复）',
    })
    const evalResult = resultOf(evaluated, 'browser.mcp')
    rec.check(
      '正控①：全工具档调 browser_evaluate **成功**（额度 R3）',
      evalResult?.status === 'success',
      `status=${evalResult?.status ?? '(无)'} code=${evalResult?.error?.code ?? '(无)'} ` +
        `msg=${(evalResult?.error?.message ?? '(无)').slice(0, 160)} ` +
        `结果条数=${String(evaluated.actionResults.length)}`
    )
    rec.check(
      '正控①：上游返回值**真的进了当轮内容**（`EVAL-MARK-1` 在正文里）',
      (contentOf(evaluated, 'browser.mcp')?.text ?? '').includes('EVAL-MARK-1'),
      (contentOf(evaluated, 'browser.mcp')?.text ?? '').slice(0, 160)
    )
    rec.check(
      '正控①：sidecar **真的收到了**这次调用（不是"我们以为发了"）',
      sidecar.requestLog.some((item) => item.tool === 'browser_evaluate'),
      JSON.stringify(sidecar.requestLog.filter((item) => item.tool !== undefined).map((i) => i.tool))
    )

    // ② 正控：caps 组（storage）工具同样可达
    rec.countInput()
    const cookies = await entry.bed.say({
      options: {
        ...fullOptions('R3'),
        planner: mcpPlanner('browser_cookie_list', '{}'),
      },
      text: '帮我列出当前站点的 cookie',
      replyText: '（离线固定回复）',
    })
    const cookieResult = resultOf(cookies, 'browser.mcp')
    rec.check(
      '正控②：caps 组工具（browser_cookie_list）同样可达，且结果进当轮内容',
      cookieResult?.status === 'success' &&
        (contentOf(cookies, 'browser.mcp')?.text ?? '').includes('FIXTURE-COOKIE-1'),
      `status=${cookieResult?.status ?? '(无)'} · ${(contentOf(cookies, 'browser.mcp')?.text ?? '').slice(0, 120)}`
    )

    // ③ 正控：默认那 25 个工具**仍在**全表里（本档没有把老能力挤掉）
    rec.countInput()
    const droppedDefaults = REAL_SIDECAR_TOOLS.filter(
      (tool) => !REAL_SIDECAR_TOOLS_ALL_CAPS.includes(tool)
    )
    rec.check(
      '正控③：默认 caps 下的 25 个工具**全部仍在**全工具表里（本档是"加法"，不是"换一套"）',
      droppedDefaults.length === 0,
      droppedDefaults.length === 0 ? '25 个全部包含' : `丢掉了：${droppedDefaults.join(',')}`
    )

    // ④ 负控：额度只有 R2 ⇒ R3 的能力被策略拒（**额度没抬到 R3 就到不了**）
    const beforeR2 = sidecar.requestLog.length
    rec.countInput()
    const underBudget = await entry.bed.say({
      options: {
        ...fullOptions('R2'),
        planner: mcpPlanner('browser_evaluate', '{"expression":"document.title"}'),
      },
      text: '帮我在当前页面上执行一段 JavaScript 表达式',
      replyText: '（离线固定回复）',
    })
    const r2Result = resultOf(underBudget, 'browser.mcp')
    rec.check(
      '负控①：任务额度只有 R2 时，R3 的 browser.mcp 被**策略拒绝**（不是"能跑但没人看"）',
      r2Result?.status === 'rejected',
      `status=${r2Result?.status ?? '(无)'} code=${r2Result?.error?.code ?? '(无)'}`
    )
    rec.check(
      '负控①：被拒时**一个包都没发**（白名单与风险闸都在发请求之前）',
      sidecar.requestLog.length === beforeR2,
      `请求数 ${String(beforeR2)} → ${String(sidecar.requestLog.length)}`
    )

    // ⑤ 负控：开关关着 ⇒ 在**计划层**就被丢（能力不在本轮清单里）
    const beforeOff = sidecar.requestLog.length
    rec.countInput()
    const switchedOff = await entry.bed.say({
      options: {
        ...browserOptions(entry, sidecar.url),
        switches: { browser: true, taskAutonomy: true },
        planner: mcpPlanner('browser_evaluate', '{"expression":"document.title"}'),
      },
      text: '帮我在当前页面上执行一段 JavaScript 表达式',
      replyText: '（离线固定回复）',
    })
    rec.check(
      '负控②：`browserFullTools` 关着时，这一步**不产生任何结果**（能力不在清单里）',
      resultOf(switchedOff, 'browser.mcp') === undefined,
      `status=${resultOf(switchedOff, 'browser.mcp')?.status ?? '(没有这一步)'}`
    )
    rec.check(
      '负控②：关着时 sidecar **一个包都没收到**',
      sidecar.requestLog.length === beforeOff,
      `请求数 ${String(beforeOff)} → ${String(sidecar.requestLog.length)}`
    )

    // ⑥ 负控：tool 名字不在名单 ⇒ `unsupported` 且零请求
    const beforeBadName = sidecar.requestLog.length
    rec.countInput()
    const badName = await entry.bed.say({
      options: {
        ...fullOptions('R3'),
        planner: mcpPlanner('browser_not_a_real_tool', '{}'),
      },
      text: '帮我调用一个不存在的浏览器工具',
      replyText: '（离线固定回复）',
    })
    const badNameResult = resultOf(badName, 'browser.mcp')
    rec.check(
      '负控③：不在名单里的工具名 ⇒ `unsupported`（白名单闸在发请求之前）',
      badNameResult?.status === 'rejected' && badNameResult.error?.code === 'unsupported',
      `status=${badNameResult?.status ?? '(无)'} code=${badNameResult?.error?.code ?? '(无)'}`
    )
    rec.check(
      '负控③：名字不对时**一个包都没发**',
      sidecar.requestLog.length === beforeBadName,
      `请求数 ${String(beforeBadName)} → ${String(sidecar.requestLog.length)}`
    )

    // ⑦ 负控：toolArgs 不是对象 ⇒ `validation_failed` 且零请求
    const beforeBadArgs = sidecar.requestLog.length
    rec.countInput()
    /*
     * ⚠️ 这一条**不能**用计划器造：`task-plan.ts` 的 `toolArgs` 是对象，
     *    规划器只会产合法形状。要照"坏形状"必须**经网关直发**（先例：browser-01/03
     *    直接 `gateway.execute(...)` 那两处）。
     */
    const { createActionRequest } = await import('../../src/kernel/action/action-request.ts')
    const { newActionId, newTraceId } = await import('../../src/kernel/contracts/ids.ts')
    const { attestActionInitiatorUnresolved } = await import(
      '../../src/kernel/contracts/attribution.ts'
    )
    const badArgsResult = await entry.bed
      .gatewayOf(fullOptions('R3'))
      .execute(
        entry.bed.harness.kernel.characterId,
        createActionRequest({
          actionId: newActionId(),
          traceId: newTraceId(),
          capability: 'browser.mcp',
          operation: 'call',
          requestedBy: { kind: 'user' },
          arguments: { tool: 'browser_evaluate', toolArgs: 'document.title' },
          sideEffect: 'destructive',
        }),
        { initiatorEvidence: attestActionInitiatorUnresolved({ adapterId: 'productivity-verify' }) }
      )
    /*
     * ★ 2026-10-09 修正（第一次跑时这里判错了）：经 `gatewayOf` **直发**（不是任务路径）时，
     *    门床的上限是写死的 `maxRiskLevel: 'R1'`（`taskRiskLevel` 只经 `riskLevelFor()` 对
     *    **任务**路径生效）⇒ R3 的 `browser.mcp` 在这里**必然**被风险闸拒。
     *    这不是缺陷，而是"额度没抬到 R3 就到不了"的**第二条证据**（另一条是任务路径那条负控）。
     */
    rec.check(
      '负控④：**直发**那条路的上限是 R1 ⇒ R3 的 browser.mcp 被风险闸拒',
      badArgsResult.status === 'rejected' &&
        (badArgsResult.error?.message ?? '').includes('超过'),
      `status=${badArgsResult.status} code=${badArgsResult.error?.code ?? '(无)'} ` +
        `msg=${(badArgsResult.error?.message ?? '(无)').slice(0, 160)}`
    )
    rec.check(
      '负控④：被拒时**一个包都没发**',
      sidecar.requestLog.length === beforeBadArgs,
      `请求数 ${String(beforeBadArgs)} → ${String(sidecar.requestLog.length)}`
    )

    /*
     * ⑧ 负控⑤：**坏形状的 `toolArgs`**（字符串而不是对象）—— 只能经**计划**造，
     *    因为 `gatewayOf` 直发那条路先在风险闸就被拒了（上一条），到不了适配器的参数校验。
     *    判据只主张一件事：**它不会变成一次成功的调用，也不会产生出站请求**。
     */
    const beforeBadShape = sidecar.requestLog.length
    rec.countInput()
    const badShape = await entry.bed.say({
      options: {
        ...fullOptions('R3'),
        planner: mcpPlanner('browser_evaluate', '{not-json'),
      },
      text: '帮我带着一个坏参数调用那个工具',
      replyText: '（离线固定回复）',
    })
    rec.check(
      '负控⑤：坏形状的 `toolArgs` **不会成功**（计划层或适配器拒收）',
      resultOf(badShape, 'browser.mcp')?.status !== 'success',
      `status=${resultOf(badShape, 'browser.mcp')?.status ?? '(没有这一步)'}`
    )
    rec.check(
      '负控⑤：坏形状时**一个包都没发**',
      sidecar.requestLog.length === beforeBadShape,
      `请求数 ${String(beforeBadShape)} → ${String(sidecar.requestLog.length)}`
    )

    await sidecar.close()
    return rec.finish('全工具档（任意工具入口）：能调用 / 有闸门')
  },
}

/**
 * ★ 2026-10-09 / `L-PS-63`：**会话失效的自愈与它的边界**。
 *
 * ```text
 * 正控①  会话失效（夹具照上游回 404）⇒ 适配器**重建一次并重试** ⇒ 成功，且 initialize 恰好 +1
 * 正控②  结果里**如实**带出程序附注（"旧的标签绑定随旧 sidecar 一起没了"）
 * 负控①  **非会话类**失败（工具级 isError）⇒ **不**重建（不拿重试掩盖真故障）
 * 负控②  连续两次失效 ⇒ **只重建一次**，第二次如实失败（不无限重试）
 * ```
 *
 * ⚠️ 这条缺陷的真实形态（2026-10-09 真机事故）：sidecar 重启后服务端会话已不存在，
 *    而适配器缓存着旧的 `mcp-session-id` 、`ensureSession()` 非空即返回 ⇒
 *    此后**每一次**浏览器调用都拿 404，用户看到的是"她一直说访问不了"。
 */
const browser06: GroupRunner = {
  id: 'browser-06',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('browser-06')
    const entry = await suite.openBed('browser-06')
    /* 同上：自建夹具，不用被 `browser-03` 关掉的那个共享实例 */
    const sidecar = await startFakeSidecar()
    sidecar.setErrorMode(undefined)
    sidecar.expireSession(0)
    const { createActionRequest } = await import('../../src/kernel/action/action-request.ts')
    const { newActionId, newTraceId } = await import('../../src/kernel/contracts/ids.ts')
    const { attestActionInitiatorUnresolved } = await import(
      '../../src/kernel/contracts/attribution.ts'
    )
    const gateway = entry.bed.gatewayOf(browserOptions(entry, sidecar.url))
    const readSnapshot = async (): Promise<Awaited<ReturnType<typeof gateway.execute>>> =>
      gateway.execute(
        entry.bed.harness.kernel.characterId,
        createActionRequest({
          actionId: newActionId(),
          traceId: newTraceId(),
          capability: 'browser.read',
          operation: 'snapshot',
          requestedBy: { kind: 'user' },
          arguments: {},
          sideEffect: 'read',
        }),
        { initiatorEvidence: attestActionInitiatorUnresolved({ adapterId: 'productivity-verify' }) }
      )
    const initializeCount = (): number =>
      sidecar.requestLog.filter((item) => item.method === 'initialize').length

    // 正控① / ②：会话失效 ⇒ 重建一次并重试成功，且结果里如实带出附注
    rec.countInput()
    const first = await readSnapshot()
    const before = initializeCount()
    sidecar.expireSession(1)
    const second = await readSnapshot()
    const after = initializeCount()
    const secondText = (second.turnContent ?? []).map((item) => item.text).join('\n')
    rec.check(
      '正控①：会话失效后**自愈**（重建一次并重试成功）',
      first.status === 'success' && second.status === 'success' && after === before + 1,
      `first=${first.status}/${first.error?.code ?? '-'}(${(first.error?.message ?? '').slice(0, 90)}) ` +
        `second=${second.status}/${second.error?.code ?? '-'}(${(second.error?.message ?? '').slice(0, 90)}) ` +
        `· initialize ${String(before)}→${String(after)}`
    )
    rec.check(
      '正控②：结果里**如实**带出程序附注（不是把新连接页当成原页面）',
      secondText.includes('[程序附注]'),
      secondText.slice(-140)
    )

    // 负控①：工具级失败**不**触发重建
    const beforeToolFail = initializeCount()
    rec.countInput()
    sidecar.setErrorMode('夹具注入的页面错误')
    const failed = await readSnapshot()
    sidecar.setErrorMode(undefined)
    const afterToolFail = initializeCount()
    rec.check(
      '负控①：**非会话类**失败（工具级错误）⇒ 不重建会话（不拿重试掩盖真故障）',
      failed.status === 'failed' &&
        failed.error?.code === 'execution_failed' &&
        afterToolFail === beforeToolFail,
      `status=${failed.status} code=${failed.error?.code ?? '(无)'} · initialize ${String(beforeToolFail)}→${String(afterToolFail)}`
    )

    // 负控②：连续两次失效 ⇒ 只重建一次，第二次如实失败
    const beforeTwice = initializeCount()
    rec.countInput()
    sidecar.expireSession(2)
    const twice = await readSnapshot()
    const afterTwice = initializeCount()
    rec.check(
      '负控②：**每次动作最多重建一次**（连续失效不会被无限重试掩盖）',
      twice.status === 'failed' && afterTwice === beforeTwice + 1,
      `status=${twice.status} code=${twice.error?.code ?? '(无)'} · initialize ${String(beforeTwice)}→${String(afterTwice)}`
    )

    await sidecar.close()
    return rec.finish('浏览器会话失效：自愈一次 + 边界')
  },
}

export const BROWSER_GROUPS: readonly GroupRunner[] = [
  browser01,
  browser02,
  browser03,
  browser04,
  browser05,
  browser06,
]
