import type { CapabilityRegistry } from '../../kernel/action/capability-registry.ts'
import { buildToolCatalog } from '../../kernel/action/tool-catalog.ts'
import { buildCurrentCapabilityFacts, type GatewayCapabilityFacts, type CapabilityDependencyFact,
  type CapabilityConnectionFact } from '../../kernel/action/capability-facts.ts'
import type { KernelFlags } from '../../kernel/app/flags.ts'
import type { GroupSendState, GroupTaskMedia, GroupTaskStatus,
  GroupTaskTerm } from '../../kernel/contracts/qq-group-task.ts'
import { capabilityHealth, type CapabilityHealth } from '../action/capability-health.ts'

/**
 * 群消息**底层**是否支持收发 —— **代码常量，恒为 `true`**。
 *
 * ============================================================================
 *  为什么它必须是一个显式常量，而不是"装配层说有就有"
 * ============================================================================
 * ```text
 * 底层支持   ⇔ 本机 OneBot 客户端实现了 `send_group_msg` / 群事件接收（代码事实）
 * 适配器装配 ⇔ 这一次装配真的把群任务端口接上了（装配事实，缺省 false）
 * 任务授权   ⇔ 此刻有没有主人授权、还在生效的群任务（存储事实）
 * 目标可验证 ⇔ 群号是否已解析且机器人**实际在群**（绑定事实）
 * ```
 * 这四件事**互相不能替代**：把它们压成一个"支持/不支持"，就会出现
 * "没有当前任务授权 ⇒ 说成系统永远只支持私聊" 与 "已有授权 ⇒ 说成已经送到群里"
 * 这两种**事故级**的错误说法（2026-10-28 的口径裁定）。
 *
 * ⚠️ 常量不是声明"这次能用"：能用要看上面第 2/3/4 条与开关 `qqGroupTasksEnabled`。
 */
export const QQ_GROUP_TRANSPORT_SUPPORTED = true

/** 最近一条群任务的事实（只读；**不含**正文 / 授权来源 / 凭据） */
export interface GroupTaskFactsLatest {
  readonly id: string
  readonly status: GroupTaskStatus
  readonly media: GroupTaskMedia
  readonly term: GroupTaskTerm
  /** 剩余额度（对外消息条数；已占用含 `unknown`） */
  readonly remainingMessages: number | null
  /** 最近一次发送的**结局**；`null` = 这条任务还没有任何发送记录 */
  readonly lastSendState: GroupSendState | null
  readonly lastSendAt: number | null
}

/**
 * 群任务事实视图（**只读、不写库、不授权任何动作**）。
 *
 * 全部字段可选：缺省不传 ⇒ 事实输出**逐字不变**（旧调用点零改动、零行为变化）。
 * ⚠️ 它只回答"事实是什么"，不回答"能不能发"：能不能发仍由任务判定与适配器决定。
 */
export interface GroupTaskFactsView {
  /** 这一次装配是否把群任务端口真的接上了（缺省 false ⇒ 未装配） */
  readonly adapterAssembled?: boolean
  /** 此刻生效（`active`）的群任务条数（缺省 0） */
  readonly activeTasks?: number
  /** 此刻暂停（`paused`）的群任务条数（缺省 0；暂停≠撤销，也≠没有授权过） */
  readonly pausedTasks?: number
  /** 最近一条任务（`null` = 还没有任何任务记录） */
  readonly latestTask?: GroupTaskFactsLatest | null
  /** 目标群是否可验证：群号已由程序解析**且**机器人实际在群（缺省 false = 未验证） */
  readonly targetVerifiable?: boolean
}

/** 时间戳 → 稳定可读的 UTC 文本（事实文本里不写本地时区，避免"看起来像本地时间"） */
function factTime(at: number): string {
  return Number.isSafeInteger(at) && at > 0 ? new Date(at).toISOString() : '未知'
}

function factCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

function mediaText(media: GroupTaskMedia): string {
  if (media === 'text') return '只文字'
  if (media === 'voice') return '只语音（语音失败不改文字）'
  return '文字或语音由她选择'
}

function termText(term: GroupTaskTerm): string {
  if (term.kind === 'long_term') return `长期有效（自 ${factTime(term.startAt)}，主人明确授予）`
  return `窗口 ${factTime(term.startAt)} → ${factTime(term.endAt)}`
}

function sendOutcomeText(state: GroupSendState | null): string {
  if (state === null) return '无发送记录（没有记录 ≠ 已经送到，也 ≠ 失败）'
  if (state === 'queued') return '已受理、尚未发出'
  if (state === 'in_flight') return '已发出请求、结局未定'
  if (state === 'api_accepted') return '平台已受理（**不等于**群成员已经看到或听到，也不等于任务成功）'
  if (state === 'failed_confirmed') return '明确失败（平台/通道拒绝；不会自动重试）'
  return '结果不明（可能已经送出；按纪律不重播，额度保守占用）'
}

/**
 * 渲染**给模型看**的群消息 / 群任务事实（纯函数；不读环境、不读时钟、不查库）。
 *
 * 四条纪律（每条都被门断言）：
 * ```text
 * ① 四件事分开说：底层支持 / 适配器装配 / 任务授权 / 目标群可验证
 * ② "没有当前任务授权"只是"此刻没有生效任务"，**不能**说成"系统永远只支持私聊"
 * ③ "已有授权"只证明任务已登记，**不能**说成"消息已经送到群里"
 * ④ 发送结局按闭集如实说；`api_accepted` / `unknown` 各带自己的限定语
 * ```
 */
export function renderGroupTaskFacts(view: GroupTaskFactsView): string {
  const active = factCount(view.activeTasks)
  const paused = factCount(view.pausedTasks)
  const assembled = view.adapterAssembled === true
  const latest = view.latestTask ?? null
  const lines: string[] = []
  lines.push('【群消息与群任务事实（程序给出；四件事分开看）】')
  lines.push(`· 底层群收发：${QQ_GROUP_TRANSPORT_SUPPORTED ? '支持' : '不支持'}`
    + '（本机 OneBot 客户端已实现 send_group_msg；这是**代码事实**，不代表这一次装好了）')
  lines.push(`· 群任务适配器：${assembled ? '已装配' : '未装配'}`
    + `（装配层${assembled ? '已经' : '没有'}把群任务端口接上；底层支持不等于这一次可用）`)
  if (active + paused === 0) {
    lines.push('· 当前任务授权：无生效任务（**只表示**此刻没有主人授权的群任务；'
      + '底层支持与适配器状态各见上一行，不代表群消息能力不存在）')
  } else {
    lines.push(`· 当前任务授权：生效 ${String(active)} 条 · 暂停 ${String(paused)} 条`
      + '（有授权**只表示**主人已授权、任务已登记；不表示任何消息已经送出）')
  }
  lines.push(`· 目标群可验证：${view.targetVerifiable === true
    ? '是（群号已由程序解析，且机器人实际在群）'
    : '否（群号未解析或机器人不在群；"未验证"不等于"群不存在"，也不等于"永远发不出去"）'}`)
  if (latest === null) {
    /*
     * ⚠️ 有任务却拿不到"最近一条"时**不能**说"还没有任何任务记录"（那是另一句事实断言）：
     *    这里只报"本次没有带出单条任务事实"。
     */
    lines.push(active + paused > 0
      ? '· 最近一条任务：未提供（本次没有带出单条任务事实；这不表示没有任务记录）'
      : '· 最近一条任务：无（还没有任何群任务记录）')
  } else {
    lines.push(`· 最近一条任务：id=${latest.id} · 状态=${latest.status}`
      + ` · 形式=${mediaText(latest.media)} · 生效期=${termText(latest.term)}`
      + ` · 剩余额度=${latest.remainingMessages === null ? '无限（未设总量上限）' : `${String(factCount(latest.remainingMessages))} 条`}`
      + ` · 最近发送结局=${sendOutcomeText(latest.lastSendState)}`
      + (latest.lastSendAt === null ? '' : ` · 最近一次发送尝试=${factTime(latest.lastSendAt)}`))
  }
  lines.push('（这四件事互相不能替代：有授权不等于消息已经到了群里；'
    + '没有授权也不等于群消息能力不存在。是否真的发出，只看发送结局与平台回执。）')
  return lines.join('\n')
}

/** 机器可读的同一份事实（字段名不暗示"已送达"；`text` 是给人/模型读的同一段原文） */
function groupTaskFactsProjection(view: GroupTaskFactsView) {
  const active = factCount(view.activeTasks)
  const paused = factCount(view.pausedTasks)
  return {
    transportSupported: QQ_GROUP_TRANSPORT_SUPPORTED,
    adapterAssembled: view.adapterAssembled === true,
    authorization: {
      active, paused, hasCurrent: active + paused > 0,
      latestTaskId: view.latestTask?.id ?? null,
      latestTaskStatus: view.latestTask?.status ?? null,
    },
    targetVerifiable: view.targetVerifiable === true,
    latestTask: view.latestTask ?? null,
    text: renderGroupTaskFacts(view),
  }
}

export interface CurrentCapabilityInput {
  registry: CapabilityRegistry; flags?: KernelFlags; gateway?: GatewayCapabilityFacts
  candidates?: readonly string[]; entry: string; runtimeId?: string; sandboxRoot?: string
  capability?: string; now?: number; probe?: (id: string) => CapabilityHealth
  connections?: Readonly<Record<string, CapabilityConnectionFact>>
  /*
   * 群任务事实（**可选**；只有 `selfCapabilitySnapshot` 消费它）。
   *
   * ⚠️ `currentCapabilityFacts` **忽略**它：那一个视图的形状是 kernel 的
   *    `CurrentCapabilityView`（本批不改那个契约）。要注入就放在
   *    `capabilityFactInput()` 的返回值里，两处调用点都能拿到。
   * ⚠️ 缺省不传 ⇒ `selfCapabilitySnapshot` 的输出**逐字不变**。
   */
  groupTasks?: GroupTaskFactsView
}
/** Shared by chat, catalogue projection and developer reads. Never run tools or infer remote connectivity. */
export function currentCapabilityFacts(input: CurrentCapabilityInput) {
  const values = input.flags as unknown as Record<string, unknown> | undefined
  const on = (key: string) => key === 'always' || values?.[key] === true
    || (key === 'qqProactiveMode' && ['on', 'shadow'].includes(String(values?.[key])))
  const catalog = buildToolCatalog(input.registry, { isGateEnabled: on })
  const dependencies: Record<string, CapabilityDependencyFact> = {}
  const row = catalog.find(item => item.capability === input.capability)
  if (row?.enabled && input.flags) {
    const health = input.probe?.(row.capability) ?? capabilityHealth(row.capability,
      { sandboxRoot: input.sandboxRoot, fresh: true })
    dependencies[row.capability] = { state: health.reason === 'no_local_dependency_probe' ? 'unknown' : health.ready ? 'ready' : 'failed',
      reason: health.reason, checkedAt: health.checkedAt }
  }
  return buildCurrentCapabilityFacts({ catalog, observedAt: input.now ?? Date.now(), runtimeId: input.runtimeId,
    entry: input.entry, configurationObserved: input.flags !== undefined, gateway: input.gateway,
    candidates: input.candidates === undefined ? undefined
      : input.flags && (!input.flags.actionEnabled || !input.flags.taskAutonomyEnabled) ? [] : input.candidates,
    dependencies, connections: input.connections })
}
/** Bounded chat projection of the exact same view; default overview does not probe all dependencies. */
export function selfCapabilitySnapshot(input: CurrentCapabilityInput & { flags: KernelFlags; wechat: boolean }) {
  const view = currentCapabilityFacts(input)
  const values = input.flags as unknown as Record<string, unknown>
  const detail = input.capability ? view.tools.filter(tool => tool.id === input.capability) : []
  const candidates = view.tools.filter(tool => tool.taskCandidate === true).map(tool => tool.id)
  return { version: 'self-capabilities@2', factViewVersion: view.version, observedAt: view.observedAt,
    runtimeId: view.runtimeId, entry: view.entry, authority: view.authority, sourceRefs: view.sourceRefs,
    execution: { actionEnabled: input.flags.actionEnabled, taskAutonomyEnabled: input.flags.taskAutonomyEnabled,
      globalRiskLimit: input.flags.actionMaxRiskLevel },
    tools: detail.map(tool => ({ ...tool, remoteConnection: tool.connection.state,
      executionResult: tool.lastObservedResult?.status ?? 'not_queried' })),
    found: input.capability ? detail.length > 0 : true,
    summary: { registered: view.tools.length, configured: view.tools.filter(tool => tool.configured === true).length,
      assembled: view.authority === 'runtime-gateway' ? view.tools.filter(tool => tool.assembled === true).length : 'unknown',
      permissionGranted: view.authority === 'runtime-gateway' ? view.tools.filter(tool => tool.permissionGranted === true).length : 'unknown',
      taskCandidates: candidates.slice(0, 12), taskCandidateCount: input.candidates ? candidates.length : 'unknown',
      candidateListTruncated: candidates.length > 12,
      detail: input.capability ? '已返回指定能力详情；计数仍覆盖完整登记表' : '仅返回概览；按目录中的 capability ID 再查详情。未检查全部依赖。' },
    remoteConnection: 'unknown', executionResult: 'not_queried',
    features: { memory: input.flags.memoryEnabled, recall: input.flags.recallEnabled,
      qqReplyMedia: { requestedByFlags: typeof values.qqVoiceReplyEnabled === 'boolean' && typeof values.qqVoiceOutputEnabled === 'boolean'
        ? values.qqVoiceReplyEnabled && values.qqVoiceOutputEnabled : null,
        qqEntry: input.entry === 'qq_private' && !input.wechat, synthesisAndDelivery: 'not_probed_by_core' } },
    /* 缺省不传 ⇒ 这个键**不出现**（旧输出逐字不变）；传了才多这一段，且四件事分开呈现 */
    ...(input.groupTasks === undefined ? {} : { groupTasks: groupTaskFactsProjection(input.groupTasks) }),
    limits: '登记、配置、装配、授权、候选和依赖分别呈现，不是单次动作授权。连接未知不代表不可用；历史回执不保证下次成功。仅记录本进程网关观测；重启后无观测即未知。' }
}
