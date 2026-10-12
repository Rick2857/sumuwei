/**
 * 浏览器操作的**闭集白名单**（第二批计划 §3.4）。
 *
 * ============================================================================
 *  为什么闭集要写在 kernel，而不是写在适配器里
 * ============================================================================
 * 计划书 §3.4 逐字：「LG 专用适配器只连接这个固定 sidecar、只允许**已映射的操作和参数**；
 * **不向模型暴露任意 MCP 工具入口**。禁用任意 JavaScript/服务器代码执行、
 * 网络头正文抓取、无约束文件访问和全浏览器关闭等非必要工具。」
 *
 * 因此"允许哪些操作"必须是一条**可离线断言**的规则（本文件），
 * 而不是适配器内部一个 `if` 链：
 * ```text
 * 离线可断言  ⇒ "模型能不能让浏览器跑一段 JS"可以有一条机器判据
 * 写在适配器里 ⇒ 它只是"我们记得没写那一条"
 * ```
 *
 * ============================================================================
 *  三条被**刻意排除**的能力（每条都有理由）—— 2026-10-09 由 ADR-125 推翻
 * ============================================================================
 * ```text
 * 任意 JS 求值（browser_evaluate / run_code_unsafe）  模型拿到它就等于拿到任意代码执行
 * 网络响应体抓取（browser_network_requests 全量）      会绕过 `web.read` 的准入与上限
 * 无约束文件访问（browser_file_upload 任意路径）        需要具名的文件与网站任务接线
 * 全浏览器关闭（browser_close）                        会关掉**用户正在用**的浏览器
 * ```
 * ⇒ 上游 MCP 自己支持这些工具，第一版 LG 适配器**只调白名单里的 7 个名字**。
 *
 * ⚠️ **2026-10-09 修订（用户「启用所有工具」= C 档，载体 `ADR-125`）**：
 *    `ALLOWED_MCP_TOOLS` 扩到 **72 个**（core 全量 + config/devtools/network/pdf/
 *    storage/testing/vision 六组 caps 下的全部工具，已剔除 `skillOnly`）。
 *    上面那四条"刻意排除"因此**对 `browser.mcp` 这条路不再成立** ——
 *    排除它们的判断没有被推翻，被推翻的是"LG 永不接线"这个结果。
 *    ⚠️ **两个老 action 的参数闭集一个字都没改**：`browser.operate` 仍然只有
 *    那 8 个 action，`evaluate` 这类名字**依然**不在闭集里（负控仍在，见
 *    `groups-browser.ts` 的 `browser-03`）。危险工具只能经 `browser.mcp`
 *    这条单独登记、单独开关（`CHARACTER_BROWSER_FULL_TOOLS`）、单独声明
 *    destructive/R3 的路走 —— 那条路见 `browser-capability.ts` 与 ADR-125。
 */

import type { BrowserActionKind } from './browser-capability.ts'

/** 允许的页面操作（**闭集**） */
export const BROWSER_ACTIONS = [
  'navigate',
  'click',
  'type',
  'select',
  'wait',
  'tab_list',
  'tab_new',
  'tab_select',
] as const

export function isBrowserAction(value: string): value is BrowserActionKind {
  return (BROWSER_ACTIONS as readonly string[]).includes(value)
}

/** 决策器与后续规划器共用的浏览器参数说明，取值从执行白名单派生。 */
export function browserPlanningInstructions(): string {
  return [
    `浏览器 browser.operate 的 action 只能是：${BROWSER_ACTIONS.join(' / ')}。`,
    '填写输入框用 action=type + ref + text；选择下拉框用 action=select + ref + value（option 的真实 value）；点击用 action=click + ref。',
  '导航用 action=navigate + url；等待用 action=wait + waitMs。可用操作与参数以本轮目录为准。',
    'ref 必须逐字来自实际页面快照的 [ref=…]，不能用控件名或占位文字冒充。',
    '还没看到快照时只规划 browser.read/snapshot，done=false；等程序返回快照后再规划填写、选择、点击。',
    '每次操作会返回新快照；下一份计划用最新快照，结果已出现就结束，无需重复操作。',
  ].join('\n')
}

/**
 * 允许的 MCP 工具名（**闭集**）。
 *
 * ⚠️ 这张表是"LG 会不会调用某个上游工具"的**唯一**来源。
 *    加一个名字 = 显式的一次改动（要同时回答"它的参数是什么、风险判据在哪"）。
 *
 * ============================================================================
 *  2026-10-09 / ADR-125：**全工具档**（用户 C 档授权）
 * ============================================================================
 * 这 72 个名字**不是手写的**，是从装好的 `@playwright/mcp@0.0.83` 的
 * `playwright-core/lib/coreBundle.js` 里按上游自己的过滤规则算出来的：
 * ```text
 * 上游：filteredTools = 能力以 "core" 开头 ∪ 被 caps 打开的能力，且**剔除 skillOnly**
 * 本档：caps = config, devtools, network, pdf, storage, testing, vision（core 恒开）
 * ```
 *
 * 三方交叉核对（都指向同一份事实，缺一不可）：
 * ```text
 * ① 默认 caps 下真 sidecar 的 tools/list 实测 = 25 个 = 本表里 core* 那 25 个
 * ② 上游定义块里共 83 个工具定义，skillOnly 掉 11 个 ⇒ 全 caps 下 72 个
 * ③ 上游 CLI 的 --caps 只白名单 vision/pdf/devtools，而**配置文件/传参没有枚举校验**
 *    ⇒ storage / network / testing / config 这几组只能靠 `CHARACTER_BROWSER_SIDECAR_CAPS`
 *      传进去（同一个参数，语义由上游的 filteredTools 决定）
 * ```
 *
 * ⚠️ 过期必须表现为**失败**而不是静默：`sidecar-connect-check` ② 段断言
 *    "白名单 ⊆ 真实工具表"，`groups-browser` 的 `browser-03/05` 断言两个方向。
 */
export const ALLOWED_MCP_TOOLS: readonly string[] = [
  // core*（恒开的能力；默认 caps 下就是这 25 个）
  'browser_snapshot',
  'browser_navigate',
  'browser_navigate_back',
  'browser_click',
  'browser_drag',
  'browser_drop',
  'browser_hover',
  'browser_type',
  'browser_press_key',
  'browser_select_option',
  'browser_wait_for',
  'browser_tabs',
  'browser_fill_form',
  'browser_find',
  'browser_take_screenshot',
  'browser_handle_dialog',
  'browser_resize',
  'browser_emulate_media',
  'browser_evaluate',
  'browser_file_upload',
  'browser_console_messages',
  'browser_network_requests',
  'browser_network_request',
  'browser_close',
  'browser_run_code_unsafe',
  // --caps=storage（17）
  'browser_cookie_list',
  'browser_cookie_get',
  'browser_cookie_set',
  'browser_cookie_delete',
  'browser_cookie_clear',
  'browser_localstorage_list',
  'browser_localstorage_get',
  'browser_localstorage_set',
  'browser_localstorage_delete',
  'browser_localstorage_clear',
  'browser_sessionstorage_list',
  'browser_sessionstorage_get',
  'browser_sessionstorage_set',
  'browser_sessionstorage_delete',
  'browser_sessionstorage_clear',
  'browser_storage_state',
  'browser_set_storage_state',
  // --caps=network（4）
  'browser_route',
  'browser_route_list',
  'browser_unroute',
  'browser_network_state_set',
  // --caps=testing（5）
  'browser_generate_locator',
  'browser_verify_element_visible',
  'browser_verify_text_visible',
  'browser_verify_list_visible',
  'browser_verify_value',
  // --caps=devtools（13）
  'browser_resume',
  'browser_highlight',
  'browser_hide_highlight',
  'browser_annotate',
  'browser_start_recording',
  'browser_stop_recording',
  'browser_start_tracing',
  'browser_stop_tracing',
  'browser_start_video',
  'browser_stop_video',
  'browser_video_chapter',
  'browser_video_show_actions',
  'browser_video_hide_actions',
  // --caps=pdf（1）
  'browser_pdf_save',
  // --caps=config（1）
  'browser_get_config',
  // --caps=vision（6）
  'browser_mouse_move_xy',
  'browser_mouse_down',
  'browser_mouse_up',
  'browser_mouse_wheel',
  'browser_mouse_click_xy',
  'browser_mouse_drag_xy',
]

export interface BrowserActionMapping {
  tool: string
  /** 从 LG 的闭集参数里构造 MCP 参数（**只读白名单键**） */
  args: (input: BrowserActionInput) => Record<string, unknown>
}

export interface BrowserActionInput {
  action: BrowserActionKind
  url?: string
  /** 快照里的元素引用（如 `e12`）——过期引用由 sidecar 报错，我方如实转达 */
  ref?: string
  text?: string
  value?: string
  waitMs?: number
  tabAction?: 'list' | 'new' | 'select'
  tabIndex?: number
}

function requireUrl(input: BrowserActionInput): string {
  if (input.url === undefined || input.url === '') {
    throw new Error('navigate 需要 url')
  }
  return input.url
}

function requireRef(input: BrowserActionInput): string {
  if (input.ref === undefined || input.ref === '') {
    throw new Error('这一步需要快照里给出的元素引用（ref）—— 没有引用就不知道点哪一个')
  }
  return input.ref
}

/** 闭集操作 → MCP 工具 + 参数（**唯一**的映射表） */
export const BROWSER_ACTION_MAPPINGS: Readonly<Record<BrowserActionKind, BrowserActionMapping>> = {
  navigate: {
    tool: 'browser_navigate',
    args: (input) => ({ url: requireUrl(input) }),
  },
  click: {
    tool: 'browser_click',
    args: (input) => ({
      element: 'element',
      target: requireRef(input),
    }),
  },
  type: {
    tool: 'browser_type',
    args: (input) => ({
      element: 'element',
      target: requireRef(input),
      text: input.text ?? input.value ?? '',
    }),
  },
  select: {
    tool: 'browser_select_option',
    args: (input) => ({
      element: 'element',
      target: requireRef(input),
      values: [input.value ?? input.text ?? ''],
    }),
  },
  wait: {
    tool: 'browser_wait_for',
    args: (input) => ({ time: Math.min(Math.max(Math.trunc(input.waitMs ?? 1000), 0), 30_000) / 1000 }),
  },
  tab_list: { tool: 'browser_tabs', args: () => ({ action: 'list' }) },
  tab_new: { tool: 'browser_tabs', args: () => ({ action: 'new' }) },
  tab_select: {
    tool: 'browser_tabs',
    args: (input) => ({
      action: 'select',
      index: typeof input.tabIndex === 'number' ? Math.max(0, Math.trunc(input.tabIndex)) : 0,
    }),
  },
}

export function isAllowedMcpTool(tool: string): boolean {
  return ALLOWED_MCP_TOOLS.includes(tool)
}
