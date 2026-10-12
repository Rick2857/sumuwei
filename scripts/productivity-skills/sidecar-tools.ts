/**
 * 真实 sidecar 的**工具表读数**（2026-10-04 实测，非记忆）。
 *
 * ============================================================================
 *  它为什么必须是一份**存下来的读数**而不是测试里手写的名字
 * ============================================================================
 * `ALLOWED_MCP_TOOLS` 是"LG 会不会调用某个上游工具"的**唯一**来源。
 * 第一版那张表是**照计划书写**的，而它的"负控"也是照计划书列的名字 ——
 * 等于用同一个来源验证自己。
 *
 * ⇒ 这里存的是**从真 sidecar 上 `tools/list` 拿回来的原名**（25 个），
 *    于是负控变成"这 25 个里，除了白名单那 7 个，其余**一个都不许被调用**"。
 *
 * ⚠️ 实测方式（可复现）：起真 sidecar（`--port 8931 --host 127.0.0.1`），
 *    POST `initialize` → `notifications/initialized` → `tools/list`。
 *    ⚠️ **必须用 `localhost` 而不是 `127.0.0.1`**：上游把回环地址规范化成
 *    `localhost` 之后做 Host 允许名单比对 ⇒ 用 `127.0.0.1` 会拿到 **403**。
 *
 * ⚠️ 版本锁：`@playwright/mcp@0.0.83` / `playwright-core@1.64.0-alpha-1790635538000`。
 *    上游加/改工具名时这份读数**会过期**，而过期必须表现为**失败**而不是静默：
 *    所以下面的断言是"白名单 ⊆ 真实表"+"真实表里除白名单外一个都不放行"。
 */

export const REAL_SIDECAR_TOOLS: readonly string[] = [
  'browser_close',
  'browser_resize',
  'browser_console_messages',
  'browser_handle_dialog',
  'browser_emulate_media',
  'browser_evaluate',
  'browser_file_upload',
  'browser_drop',
  'browser_find',
  'browser_fill_form',
  'browser_press_key',
  'browser_type',
  'browser_navigate',
  'browser_navigate_back',
  'browser_network_requests',
  'browser_network_request',
  'browser_run_code_unsafe',
  'browser_take_screenshot',
  'browser_snapshot',
  'browser_click',
  'browser_drag',
  'browser_hover',
  'browser_select_option',
  'browser_tabs',
  'browser_wait_for',
]

/**
 * ============================================================================
 *  ★ 2026-10-09 / `ADR-125`：**全工具档**下真实表是 72 个（同一份代码算出来的）
 * ============================================================================
 * 上面那 25 个是**默认 caps** 下的实测读数；下面这 72 个是**全 caps**
 * （`config,devtools,network,pdf,storage,testing,vision`）下上游会暴露的全集。
 *
 * ⚠️ 它是**独立抄写**的一份读数，不是 `import` 白名单 —— 否则"用同一个来源验证自己"
 *    那个坑会原样回来（本文件顶上的注释就是为那件事写的）。
 * ⚠️ 来源与算法（可复现）：`playwright-core/lib/coreBundle.js` 的工具定义块里，
 *    按上游自己的 `filteredTools` 规则取 `能力以 "core" 开头 ∪ caps 里的能力`
 *    再剔除 `skillOnly`（全表 83 个定义，skillOnly 掉 11 个 ⇒ 72 个）。
 */
export const REAL_SIDECAR_TOOLS_ALL_CAPS: readonly string[] = [
  // core*（恒开）
  'browser_click',
  'browser_close',
  'browser_console_messages',
  'browser_drag',
  'browser_drop',
  'browser_emulate_media',
  'browser_evaluate',
  'browser_file_upload',
  'browser_fill_form',
  'browser_find',
  'browser_handle_dialog',
  'browser_hover',
  'browser_navigate',
  'browser_navigate_back',
  'browser_network_request',
  'browser_network_requests',
  'browser_press_key',
  'browser_resize',
  'browser_run_code_unsafe',
  'browser_select_option',
  'browser_snapshot',
  'browser_tabs',
  'browser_take_screenshot',
  'browser_type',
  'browser_wait_for',
  // --caps=storage
  'browser_cookie_clear',
  'browser_cookie_delete',
  'browser_cookie_get',
  'browser_cookie_list',
  'browser_cookie_set',
  'browser_localstorage_clear',
  'browser_localstorage_delete',
  'browser_localstorage_get',
  'browser_localstorage_list',
  'browser_localstorage_set',
  'browser_sessionstorage_clear',
  'browser_sessionstorage_delete',
  'browser_sessionstorage_get',
  'browser_sessionstorage_list',
  'browser_sessionstorage_set',
  'browser_set_storage_state',
  'browser_storage_state',
  // --caps=network
  'browser_network_state_set',
  'browser_route',
  'browser_route_list',
  'browser_unroute',
  // --caps=testing
  'browser_generate_locator',
  'browser_verify_element_visible',
  'browser_verify_list_visible',
  'browser_verify_text_visible',
  'browser_verify_value',
  // --caps=devtools
  'browser_annotate',
  'browser_hide_highlight',
  'browser_highlight',
  'browser_resume',
  'browser_start_recording',
  'browser_start_tracing',
  'browser_start_video',
  'browser_stop_recording',
  'browser_stop_tracing',
  'browser_stop_video',
  'browser_video_chapter',
  'browser_video_hide_actions',
  'browser_video_show_actions',
  // --caps=pdf
  'browser_pdf_save',
  // --caps=config
  'browser_get_config',
  // --caps=vision
  'browser_mouse_click_xy',
  'browser_mouse_down',
  'browser_mouse_drag_xy',
  'browser_mouse_move_xy',
  'browser_mouse_up',
  'browser_mouse_wheel',
]

/**
 * 真实表里**有**、第一版 LG **刻意不接线**的高危工具（逐一具名）。
 *
 * ⚠️ 与第一版的差别：这些名字是**从真实表里读出来的**。
 *    第一版只写了 `browser_evaluate` / `browser_network_requests` / `browser_file_upload` /
 *    `browser_close` —— 漏掉了实测存在的 **`browser_run_code_unsafe`**（任意代码）
 *    与 **`browser_network_request`**（单条网络请求体）。
 *
 * ★ 2026-10-09（ADR-125）：**这 8 个现在在授权档下是可达的**（只经 `browser.mcp`）。
 *   本常量保留原名与原语义 —— 它现在的作用是"具名列出**被授权放开**了哪 8 个"，
 *   而不再是"这 8 个必须被拒"。判据随授权一起改，见 `groups-browser.ts` 的
 *   `browser-03`（老 action 闭集**没有**被放宽）与 `browser-05`（新路可达）。
 */
export const REAL_SIDECAR_DANGEROUS: readonly string[] = [
  'browser_run_code_unsafe',
  'browser_evaluate',
  'browser_network_requests',
  'browser_network_request',
  'browser_file_upload',
  'browser_drop',
  'browser_close',
  'browser_handle_dialog',
]
