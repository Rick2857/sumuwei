/**
 * 浏览器能力的登记（第二批计划 §3.4 / §4 能力影响矩阵）。
 *
 * ```text
 * browser.read      browser:read      R1  read   快照 / 读取当前页面资料
 * browser.operate   browser:operate   R2  write  导航、点击、填写、任务标签操作
 * ```
 *
 * ============================================================================
 *  R2 是**任务级**的，不是全局的（计划书 §4 末段逐字）
 * ============================================================================
 * 「浏览器 R2 仅在已授权浏览器任务中使用；**不为运行浏览器把所有聊天的风险上限
 * 统一升为 R2/R3**」。
 *
 * 组装层的 `maxRiskLevel`（`CHARACTER_ACTION_MAX_RISK`，缺省 **R1**）因此
 * **一个字都不改**：`browser.operate` 在普通聊天里**永远**被策略第 ④ 步拒绝，
 * 只有在"任务执行环带着一份已授权的浏览器任务"时才拿到一个
 * **任务级的风险额度**（`ActionInvocationContext.riskBudgetOverride`）。
 * 于是：
 * ```text
 * 普通聊天说"帮我点一下那个按钮"     ⇒ R2 > R1 ⇒ 拒绝（可审计的 risk_exceeds_limit）
 * 已授权任务里的同一句话              ⇒ 任务额度 R2 ⇒ 才可能被允许
 * ```
 * ⚠️ 这不是"为了能跑而放松上限"：它把"谁有权把上限升到 R2"收敛到**一处**
 *    （任务授权对象），而不是散落在装配层。
 *
 * ============================================================================
 *  它不暴露任意 MCP 工具入口（计划书 §3.4）—— **已于 2026-10-09 被 ADR-125 部分推翻**
 * ============================================================================
 * 「LG 专用适配器只连接这个固定 sidecar、只允许已映射的操作和参数；
 *  不向模型暴露任意 MCP 工具入口。禁用任意 JavaScript/服务器代码执行、
 *  网络头正文抓取、无约束文件访问和全浏览器关闭等非必要工具。」
 *
 * ⚠️ **修订（2026-10-09，用户「启用所有工具」授权，载体 `ADR-125`）**：
 *    上面那句对 `browser.read` / `browser.operate` **逐字仍然有效**
 *    （它们的参数仍是闭集，`browser-operations.ts` 的映射表没有被放宽）；
 *    但**新增了第三条能力 `browser.mcp`**，它按名字调用上游工具表里的任意工具
 *    —— 那正是 §3.4 禁止的"任意 MCP 工具入口"。它被单列成一条能力，正是为了让
 *    "开了没有"是一个**开关**（`CHARACTER_BROWSER_FULL_TOOLS`，代码缺省 false），
 *    而不是散落进闭集里的几个新 action。
 *    风险与不主张逐条记在 ADR-125；本文件里它声明为 **destructive / R3**。
 */

import type { CapabilityDefinition } from './capability-registry.ts'

export const BROWSER_READ = 'browser.read'
export const BROWSER_READ_OPERATION = 'snapshot'
export const BROWSER_READ_PERMISSION = 'browser:read'

export const BROWSER_OPERATE = 'browser.operate'
export const BROWSER_OPERATE_OPERATION = 'act'
export const BROWSER_OPERATE_PERMISSION = 'browser:operate'

/**
 * ★ 2026-10-09 / `ADR-125`：**任意工具入口**（用户 C 档授权，部分推翻计划书 §3.4）。
 *
 * ```text
 * browser.mcp   browser:mcp   R3  destructive  按名字调用 sidecar 工具表里的任意工具
 * ```
 * ⚠️ 与上面两条**刻意分列**的理由：它的参数里有一格是"上游工具名"。
 *    单列成一条能力 ⇒ "开了没有"永远是一个可以一行关掉
 *    （`CHARACTER_BROWSER_FULL_TOOLS`）、可以离线断言、可以按能力审计的开关。
 */
export const BROWSER_MCP = 'browser.mcp'
export const BROWSER_MCP_OPERATION = 'call'
export const BROWSER_MCP_PERMISSION = 'browser:mcp'

export const BROWSER_CAPABILITY_IDS: readonly string[] = [
  BROWSER_READ,
  BROWSER_OPERATE,
  BROWSER_MCP,
]

/**
 * 页面操作的**闭集**（白名单在 `browser-operations.ts` —— 那里有唯一映射表）。
 * 放在这里是为了让"能力声明"与"允许的操作"在同一个地方可读。
 */
export type BrowserActionKind =
  | 'navigate'
  | 'click'
  | 'type'
  | 'select'
  | 'wait'
  | 'tab_list'
  | 'tab_new'
  | 'tab_select'

export function isBrowserCapability(capabilityId: string): boolean {
  return BROWSER_CAPABILITY_IDS.includes(capabilityId)
}

export function browserCapabilityLabel(capabilityId: string): string {
  switch (capabilityId) {
    case BROWSER_READ:
      return '浏览器页面读取'
    case BROWSER_OPERATE:
      return '浏览器操作'
    case BROWSER_MCP:
      return '浏览器任意工具调用（全工具档）'
    default:
      return capabilityId
  }
}

export function createBrowserCapabilityDefinitions(): readonly CapabilityDefinition[] {
  return [
    {
      id: BROWSER_READ,
      version: `${BROWSER_READ}@1`,
      description:
        '读取**已绑定标签页**的当前页面快照（可见文字与可交互元素引用）。' +
        '不执行任意脚本、不抓网络响应头正文；登录页正文与连接 token 保持私有。',
      operations: [
        {
          name: BROWSER_READ_OPERATION,
          description: '取回当前任务标签组的页面快照',
          sideEffect: 'read',
          riskLevel: 'R1',
        },
      ],
      sideEffectLevel: 'read',
      riskLevel: 'R1',
      permissions: [BROWSER_READ_PERMISSION],
      supportsDryRun: true,
      idempotency: 'none',
    },
    {
      id: BROWSER_OPERATE,
      version: `${BROWSER_OPERATE}@1`,
      description:
        '在**已授权任务**的标签组里做一次受控操作：导航 / 点击 / 填写 / 等待结果。' +
        '引用过期即刷新重判，多匹配不猜；URL 与域名由 LG 任务范围校验。',
      operations: [
        {
          name: BROWSER_OPERATE_OPERATION,
          description: '按闭集的 action 做一次页面操作',
          sideEffect: 'write',
          riskLevel: 'R2',
        },
      ],
      sideEffectLevel: 'write',
      riskLevel: 'R2',
      permissions: [BROWSER_OPERATE_PERMISSION],
      supportsDryRun: true,
      idempotency: 'none',
    },
    {
      id: BROWSER_MCP,
      version: `${BROWSER_MCP}@1`,
      description:
        '（**全工具档**）按名字调用 sidecar 工具表里的任意一个工具，参数原样转交。' +
        '⚠️ 这就是计划书 §3.4 禁止的"任意 MCP 工具入口"：它可以执行任意 JavaScript' +
        '（browser_evaluate / browser_run_code_unsafe）、读写站点 cookie 与本地存储' +
        '（--caps=storage）、抓网络响应正文、上传任意路径的文件、关闭整个浏览器。' +
        '声明 destructive / R3；只在 `CHARACTER_BROWSER_FULL_TOOLS=true` 且' +
        '任务额度被抬到 R3 时可达（见 ADR-125）。',
      operations: [
        {
          name: BROWSER_MCP_OPERATION,
          description: '按 tool 名调用一个上游工具（toolArgs 原样转交）',
          sideEffect: 'destructive',
          riskLevel: 'R3',
        },
      ],
      sideEffectLevel: 'destructive',
      riskLevel: 'R3',
      permissions: [BROWSER_MCP_PERMISSION],
      /*
       * ⚠️ 刻意 **不支持 dryRun**：一个"什么都可能做"的入口没有诚实的干跑语义
       *    —— 声称支持就等于给调用方一个假的"先看看"。
       */
      supportsDryRun: false,
      /*
       * 幂等声明：**`supported`**（登记口拒收 `destructive + none`，而这条不能声明 `none`）。
       *
       * 它在这里**不是空话**：`shouldCheckIdempotency('supported') === true`
       * ⇒ 网关会按 `{capability, operation, target, args}` 推导幂等键
       *   （`args` 就是这里的 `tool` + `toolArgs`），并在执行**之前**查账本：
       *   同一个"工具 + 参数"成功过一次，第二次**重放而不执行**。
       *
       * ⚠️ 由此产生的**真后果**（ADR-125 已登记，不许被读成"没有代价"）：
       *    同一个 tool + 同一份 toolArgs 在**之后的另一轮**再出现时，拿到的会是
       *    **账本里那一次的结果**（`idempotentReplay`），而不是一次新的执行。
       *    对读类工具这意味"可能不是最新的"，对写类工具这正是我们要的保护。
       *    ⇒ 需要新读数时，调用方必须让参数**真的不同**（例如换一个表达式）。
       */
      idempotency: 'supported',
    },
  ]
}
