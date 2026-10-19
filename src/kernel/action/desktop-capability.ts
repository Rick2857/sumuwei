/**
 * 桌面查看与操作能力的登记（[`ADR-106`](../../../docs/adr/ADR-106-desktop-control.md) `D01`/`D03`/`D04`）。
 *
 * ```text
 * desktop.inspect   desktop:inspect   R1  read   当前桌面的窗口与可交互元素（有界文本）
 * desktop.operate   desktop:operate   R2  write  click / right_click / double_click / type / switch_app / launch_app
 * ```
 *
 * ============================================================================
 *  只登记任务需要的动作，上游其余工具不代理
 * ============================================================================
 * 上游 `windows-mcp` 注册了 Snapshot / Screenshot / App / Powershell / Filesystem /
 * Process / Registry / Clipboard / Notification / Display / Scrape / Multi / Input …
 * LG 只登记桌面状态、应用目录与下列闭集动作（2026-10-09 用户批准扩展）。
 * 调研报告 §版本与具体差异 1 逐字：「未来只登记任务需要的桌面操作，可使用其现成白名单。」
 *
 * 动作闭集写死在 `DESKTOP_ACTION_KINDS`；worker 侧还有第二道同样的闭集
 * （`ACTION_WHITELIST`）—— 两处都在，任一处被改坏都不会静默放行。
 *
 * ============================================================================
 *  R2 是**任务级**的，不是全局的（与 `browser.operate` 同规）
 * ============================================================================
 * 组装层的 `CHARACTER_ACTION_MAX_RISK`（缺省 **R1**）**一个字都不改**：
 * 普通聊天里 `desktop.operate` 永远被策略第 ④ 步拒绝，只有在"任务执行环带着一份
 * 已授权的任务"时才拿到任务级风险额度。
 * ⚠️ 代价如实写在 ADR-106 `L-DC-05`：任务额度是**一个**数。
 */

import type { CapabilityDefinition } from './capability-registry.ts'

export const DESKTOP_INSPECT = 'desktop.inspect'
export const DESKTOP_INSPECT_OPERATION = 'state'
export const DESKTOP_APPS_OPERATION = 'apps'
export const DESKTOP_INSPECT_PERMISSION = 'desktop:inspect'

export const DESKTOP_OPERATE = 'desktop.operate'
export const DESKTOP_OPERATE_OPERATION = 'act'
export const DESKTOP_OPERATE_PERMISSION = 'desktop:operate'

export const DESKTOP_CAPABILITY_IDS: readonly string[] = [DESKTOP_INSPECT, DESKTOP_OPERATE]

/**
 * 允许的动作（**闭集**，`ADR-106` `D01`）。
 *
 * ```text
 * click  在它看到过的那个控件上点一次（左键、单击）
 * right_click  同一核对链上的**右键**单击（弹出上下文菜单；读回始终是整个桌面的新快照）
 * double_click  同一核对链上的左键双击
 * type   在它看到过的那个输入控件上输入一段正文（**不清空**既有内容）
 * switch_app  按快照里的窗口完整标题 + 句柄切换前台
 * launch_app  按系统应用目录中的完整名称启动，无自定义参数
 * ```
 * ⚠️ 刻意**没有**：scroll / drag / move / shortcut（快捷键）/
 *    clipboard / shell / registry / filesystem / process / notification。
 *    加一个动作 = 一次显式改动（登记表 + 参数白名单 + worker + 用例）。
 */
export const DESKTOP_ACTION_KINDS = ['click', 'right_click', 'double_click', 'type', 'switch_app', 'launch_app'] as const
export type DesktopActionKind = (typeof DESKTOP_ACTION_KINDS)[number]

/**
 * 程序侧的 **shell 文件夹闭集**（[`ADR-128`](../../../docs/adr/ADR-128-desktop-shell-folders.md)，2026-10-09 用户授权）。
 *
 * ```text
 * 回收站 / 此电脑 / 控制面板**不是应用**：它们不在开始菜单应用目录里
 *   （上游 `get_apps_from_start_menu()` = `Get-StartApps` → 快捷方式扫描 → `shell:AppsFolder` 显示名），
 *   所以 `launch_app` 以前打不开它们（实测 `query=回收/recycle/bin` 全 0 条）。
 * ```
 *
 * ⚠️ 这里是**程序常量表**：模型只能从这张表里挑一个**名字**，真正交给 ShellExecute 的 `target`
 *    由本文件给出 —— 模型给的路径 / CLSID / `shell:` 命令**永远不进目标**。
 * ⚠️ worker 里另有一份**同表**（`SHELL_FOLDERS`），门会核对两处逐字一致。
 */
export const DESKTOP_SHELL_FOLDERS = [
  { id: 'recycle_bin', label: '回收站', aliases: ['Recycle Bin', 'recycle_bin'], target: 'shell:RecycleBinFolder' },
  { id: 'this_pc', label: '此电脑', aliases: ['This PC', 'My Computer', 'this_pc'], target: 'shell:MyComputerFolder' },
  { id: 'control_panel', label: '控制面板', aliases: ['Control Panel', 'control_panel'], target: 'shell:ControlPanelFolder' },
] as const

/** 给模型看的那三个名字（别名只是容错，不列进协议正文） */
export function desktopShellFolderLabels(): readonly string[] {
  return DESKTOP_SHELL_FOLDERS.map((entry) => entry.label)
}

export function isDesktopActionKind(value: unknown): value is DesktopActionKind {
  return typeof value === 'string' && (DESKTOP_ACTION_KINDS as readonly string[]).includes(value)
}

/** 单次查看最多列出多少个可交互元素（**程序上限**；模型只能通过参数下调） */
export const DESKTOP_ELEMENT_LIMIT = 120
/** 单次输入的正文上限（字符） */
export const DESKTOP_TYPE_MAX_CHARS = 2000
/** worker 交回来的状态文本上限（字符；超出在适配器里截断并如实标记） */
export const DESKTOP_STATE_MAX_CHARS = 4000
/** 窗口名 / 控件名的单字段上限（字符） */
export const DESKTOP_NAME_MAX_CHARS = 200
/** 一次动作的缺省超时（毫秒）—— 含"重新取快照 + 动作 + 读回"三段 */
export const DESKTOP_ACTION_TIMEOUT_MS = 30_000
/** 一次查看的缺省超时（毫秒）—— 含 1.2–2.4s 的 Python import */
export const DESKTOP_INSPECT_TIMEOUT_MS = 20_000

export function isDesktopCapability(capabilityId: string): boolean {
  return DESKTOP_CAPABILITY_IDS.includes(capabilityId)
}

/** 与登记表相同的能力事实，供决策、规划与最终回复共用。 */
const DESKTOP_LAUNCH_SCOPE =
  '支持右键单击 right_click、左键双击 double_click、切换窗口 switch_app 和启动应用 launch_app。' +
  'right_click 在同一条核对链上按右键并弹出上下文菜单；它的读回**始终是整个桌面的新快照**，' +
  '点菜单项要用那份快照里的窗口名与 index（右键之前那份快照里的控件引用会全部作废）。' +
  'switch_app 使用桌面快照里的完整 window 标题与数字整数 handle；切换成功后重新查看控件。' +
  'launch_app 使用 desktop.inspect.apps（可传 query）查到的完整应用 name，无需 window/index。' +
  '那份目录**同时列出三个系统文件夹**（' + DESKTOP_SHELL_FOLDERS.map((entry) => entry.label).join(' / ') +
  '，英文名也认）；它们同样用 launch_app 按名字打开，**不要**自己拼路径、CLSID 或 shell: 命令。' +
  '启动请求提交不等于窗口已经出现，必须依据读回说明结果。快捷键、拖拽与滚动仍未接入。'

/** 决策器与后续规划器使用同一份桌面协议，避免猜 operation 或控件参数。 */
export function desktopPlanningInstructions(): string {
  return [
    `${DESKTOP_INSPECT}=${DESKTOP_INSPECT_OPERATION}（另支持 apps）；${DESKTOP_OPERATE}=${DESKTOP_OPERATE_OPERATION}。desktop.operate 的 operation 不得写 click、type、launch 或其它值。`,
    `${DESKTOP_INSPECT}.${DESKTOP_APPS_OPERATION} 只读系统应用目录；operation=apps，args.query 可按名称过滤。打开 Edge 优先查应用目录后 launch_app，不必寻找前台图标。` +
      `**系统文件夹**（${DESKTOP_SHELL_FOLDERS.map((entry) => entry.label).join(' / ')}）也在那份目录里，按同样的 name 用 launch_app 打开；不得自己拼路径或 shell: 命令。`,
    `desktop.operate 的 args.action 只能是 ${DESKTOP_ACTION_KINDS.join(' / ')}；click 是左键单击，right_click 是右键（会弹出上下文菜单，菜单出现后必须重新查看快照再点菜单项），type 的正文放 args.content。`,
    'click / right_click / double_click / type 必须带 window / index / name：使用实际快照里的逐字名称，index 必须是数字整数，不能是字符串。',
    '控件操作先 desktop.inspect.state 查看；操作前用同一个 window 过滤再查看，按该窗口快照里的 index 操作（过滤会重新编号，不能沿用全局序号）。',
    '控件必须属于当前前台窗口；非前台目标先 switch_app 再重新查看，不得编造引用。' + DESKTOP_LAUNCH_SCOPE,
    '需要下一次快照才能确定参数时，只提出查看步骤并 done=false；参数失败、找不到控件或预算耗尽只说明本次任务未完成，不能推断整个桌面能力不存在。',
  ].join('\n')
}

export interface DesktopCapabilityAvailability {
  inspect: boolean
  operate: boolean
  connected: boolean
  /** Remote operation readiness is independent of the local inspection runtime. */
  operateConnected?: boolean
}

/** 回复使用程序给出的当前状态，不把历史自述或一次失败当成能力边界。 */
export function renderDesktopCapabilityFacts(state: DesktopCapabilityAvailability): string | undefined {
  if (!state.inspect && !state.operate) return undefined
  return [
    '# 当前桌面能力（程序事实）',
    `桌面查看 desktop.inspect.state：${state.inspect ? '已启用' : '未启用'}。`,
    `桌面操作 desktop.operate.act：${state.operate ? '已启用' : '未启用'}，动作 ${DESKTOP_ACTION_KINDS.join(' / ')}。`,
    `本机桌面运行时：${state.connected ? '就绪' : '未连接，当前不能调用'}。只有已启用且运行时就绪的能力可用。`,
    ...(state.operateConnected === undefined ? [] : [
      `桌面操作使用 PC 执行端：${state.operateConnected ? '已连接' : '未连接，当前不可操作'}；本机运行时的状态不代表 PC 执行端就绪。`]),
    '单击、右键、双击、输入仅操作实际观察到且仍在前台窗口中的控件。' + DESKTOP_LAUNCH_SCOPE,
    '依据本轮动作结果与实际内容说明做过什么。参数校验失败、目标未找到、前台改变或预算耗尽，只表示本次操作未完成，不能据此否认已启用且就绪的能力；确实未启用或未连接时按上面状态说明。',
    '若桌面查看可用，不可说完全够不着桌面；若桌面操作可用，不可说不能点击或只有浏览器能力。',
    '历史回复中的能力自述不是程序事实。启用也不等于操作成功；没有成功结果不能说已点击、已输入或已打开程序。',
  ].join('\n')
}

/** 用户可读的能力名（开发者面与回复层共用一处） */
export function desktopCapabilityLabel(capabilityId: string): string {
  switch (capabilityId) {
    case DESKTOP_INSPECT:
      return '桌面查看'
    case DESKTOP_OPERATE:
      return '桌面操作'
    default:
      return capabilityId
  }
}

export function createDesktopCapabilityDefinitions(): readonly CapabilityDefinition[] {
  return [
    {
      id: DESKTOP_INSPECT,
      version: `${DESKTOP_INSPECT}@2`,
      description:
        '读取**当前用户桌面**的窗口与可交互元素（控件类型 / 名字 / 位置 / 所属窗口），' +
        '或只读系统应用目录（含三个可启动的系统文件夹），作为当轮内容返回。不截图、不点击、不输入；密码字段不取名也不取值。',
      operations: [
        {
          name: DESKTOP_INSPECT_OPERATION,
          description: '取一次桌面状态（窗口 + 可交互元素，有界）',
          sideEffect: 'read',
          riskLevel: 'R1',
        },
        { name: DESKTOP_APPS_OPERATION, description: '只读系统应用目录与三个系统文件夹，按 query 过滤名称（启动前查完整名称）',
          sideEffect: 'read', riskLevel: 'R1' },
      ],
      sideEffectLevel: 'read',
      riskLevel: 'R1',
      permissions: [DESKTOP_INSPECT_PERMISSION],
      supportsDryRun: true,
      idempotency: 'none',
    },
    {
      id: DESKTOP_OPERATE,
      version: `${DESKTOP_OPERATE}@2`,
      description:
        '在**已授权任务**里单击/右键/双击/输入，或切换已观察到的窗口、启动应用目录中的应用或三个系统文件夹。' +
        '控件核对索引/名称/前台，切窗核对完整标题/句柄，启动核对实际应用名称；' +
        '输入的正文经私有暂存传递，不进参数与账本。',
      operations: [
        {
          name: DESKTOP_OPERATE_OPERATION,
          description: '按闭集的 action 在已观察到的控件上做一次操作',
          sideEffect: 'write',
          riskLevel: 'R2',
        },
      ],
      sideEffectLevel: 'write',
      riskLevel: 'R2',
      permissions: [DESKTOP_OPERATE_PERMISSION],
      supportsDryRun: true,
      idempotency: 'none',
    },
  ]
}
