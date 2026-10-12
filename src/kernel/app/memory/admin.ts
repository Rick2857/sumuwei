/**
 * Memory Admin API —— **"系统现在究竟记住了什么？"**（计划书第 133–135 节）。
 *
 * ============================================================================
 *  计划书第 134 节把这条说得最清楚
 * ============================================================================
 *     没有可视化 / inspect 能力：长期 Memory 系统几乎无法调试。
 *     必须可以回答："系统现在究竟记住了什么？"
 *
 * 而计划书第 3 节还给了它一个更重要的用途：
 *
 *     M4 完成以后：苏沐薇已经"存得住"，但不代表"随时想得起来"。
 *     开发/测试环境可以提供 memory inspect / list / get / history，
 *     用于验证 Memory。但 Main Agent 的完整自动召回仍然在 M5 建设。
 *     这样我们可以分别判断：**记错了？** 还是 **记对了但没召回？**
 *
 * 也就是说：这一层不是"锦上添花的调试工具"，而是**把两个问题分开**的前提。
 * 少了它，M5 的召回一旦不准，我们无法判断是记忆本身错了还是检索错了。
 *
 * ---------------------------------------------------------------------------
 *  分层：本文件只做**解析**与**渲染**，不查库
 * ---------------------------------------------------------------------------
 * 查询由装配根（`src/main.ts`）做，因为只有它同时认识 store 与 Seed。
 * 这样本文件是**纯函数**，可以在内存里穷举测试 ——
 * 与 `provenance.ts` 同一条理由。
 *
 * 而且这避免了那个熟悉的失败：
 * 让 CLI 直接拿 store 会让它顺手开始写 SQL，而"M4 的读路径没有 SQL"
 * 就只剩一句注释。
 */

import {
  isClaimContent,
  type MemoryRecord,
  type Timestamp,
} from '../../contracts/index.ts'
import type { MemoryRetractedPayload } from '../../contracts/domain-event.ts'
import { describeProvenance, renderMemoryHistory } from './provenance.ts'

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

export type MemoryAdminCommand =
  | { kind: 'list'; status?: string; type?: string; subject?: string; limit: number }
  | { kind: 'get'; memoryId: string }
  | { kind: 'history'; memoryId?: string; predicate?: string }
  | { kind: 'sources'; memoryId: string }
  | { kind: 'stats' }
  | { kind: 'audit'; limit: number }
  | { kind: 'retract'; memoryId: string; reason: string }
  | { kind: 'replay'; memoryId?: string; all: boolean }
  | { kind: 'usage'; problem?: string }

/**
 * 解析 `memory <sub> [args]` 形式的参数。
 *
 * 支持两种写法，因为两种调用习惯都真实存在：
 *   `pnpm memory:list`               → 经 npm script 固定子命令
 *   `tsx src/main.ts memory list`    → 直接传 argv
 *
 * ⚠️ 解析失败时返回 `{ kind: 'usage', problem }` 而**不是**抛错：
 * 一个错的命令应当打印用法，而不是甩一个栈。这条与"M4 的失败要可解释"
 * 是同一条原则，只是面对的是人而不是程序。
 */
export function parseMemoryAdminArgs(args: readonly string[]): MemoryAdminCommand {
  // args 形如 ['list', '--status', 'active'] 或 ['--memory-list']
  const normalized = args.filter((a) => a.trim() !== '')

  // npm script 形式的别名
  const aliasMap: Record<string, string> = {
    '--memory-list': 'list',
    '--memory-get': 'get',
    '--memory-history': 'history',
    '--memory-sources': 'sources',
    '--memory-stats': 'stats',
    '--memory-audit': 'audit',
    '--memory-retract': 'retract',
    '--memory-replay': 'replay',
  }

  let sub: string | undefined
  const rest: string[] = []
  for (const arg of normalized) {
    if (sub === undefined && aliasMap[arg] !== undefined) {
      sub = aliasMap[arg]
      continue
    }
    if (sub === undefined && !arg.startsWith('-')) {
      sub = arg
      continue
    }
    rest.push(arg)
  }

  if (sub === undefined) return { kind: 'usage' }

  const flag = (name: string): string | undefined => {
    const index = rest.indexOf(name)
    return index >= 0 ? rest[index + 1] : undefined
  }
  const positional = rest.filter((a, i) => {
    if (a.startsWith('-')) return false
    // 跳过"作为某个 flag 的值"的位置
    const prev = rest[i - 1]
    return !(prev !== undefined && prev.startsWith('-'))
  })
  const limit = Number(flag('--limit') ?? '20')

  switch (sub) {
    case 'list':
      return {
        kind: 'list',
        ...(flag('--status') !== undefined ? { status: flag('--status') } : {}),
        ...(flag('--type') !== undefined ? { type: flag('--type') } : {}),
        ...(flag('--subject') !== undefined ? { subject: flag('--subject') } : {}),
        limit: Number.isSafeInteger(limit) && limit > 0 ? Math.min(500, limit) : 20,
      }

    case 'get': {
      const id = positional[0]
      if (id === undefined) return { kind: 'usage', problem: 'memory get 需要 <memoryId>' }
      return { kind: 'get', memoryId: id }
    }

    case 'history': {
      const target = positional[0]
      if (target === undefined) {
        return { kind: 'usage', problem: 'memory history 需要 <memoryId> 或 --predicate <key>' }
      }
      // 以 `mem:` 开头的当 id，否则当 predicate
      return target.startsWith('mem:')
        ? { kind: 'history', memoryId: target }
        : { kind: 'history', predicate: target }
    }

    case 'sources': {
      const id = positional[0]
      if (id === undefined) return { kind: 'usage', problem: 'memory sources 需要 <memoryId>' }
      return { kind: 'sources', memoryId: id }
    }

    case 'stats':
      return { kind: 'stats' }

    case 'audit':
      return {
        kind: 'audit',
        limit: Number.isSafeInteger(limit) && limit > 0 ? Math.min(500, limit) : 30,
      }

    case 'retract': {
      const id = positional[0]
      if (id === undefined) return { kind: 'usage', problem: 'memory retract 需要 <memoryId>' }
      return {
        kind: 'retract',
        memoryId: id,
        reason: flag('--reason') ?? '（未说明原因）',
      }
    }

    case 'replay': {
      const id = positional[0]
      const all = rest.includes('--all')
      if (id === undefined && !all) {
        return { kind: 'usage', problem: 'memory replay 需要 <memoryId> 或 --all' }
      }
      return { kind: 'replay', ...(id !== undefined ? { memoryId: id } : {}), all }
    }

    default:
      return { kind: 'usage', problem: `未知的 memory 子命令：${sub}` }
  }
}

/** 用法文本（解析失败与 `--help` 都用它） */
export function memoryAdminUsage(): string {
  return [
    'Memory Admin API（M4，计划书第 133 节）',
    '',
    '  pnpm memory:list [--status active|superseded|retracted|disputed] [--type <t>] [--limit N]',
    '  pnpm memory:get <memoryId>',
    '  pnpm memory:history <memoryId>            按 id 看一条记忆的时间线',
    '  pnpm memory:history <predicate>           按槽位键看整个槽位的历史',
    '  pnpm memory:sources <memoryId>            反查它的证据事件',
    '  pnpm memory:stats                         计数与各项率',
    '  pnpm memory:audit [--limit N]             随机抽取供人工审计（计划书第 217 节）',
    '  pnpm memory:retract <memoryId> --reason <text>   （**写操作**）',
    '  pnpm memory:replay <memoryId> | --all      （**写操作**：删投影后重放）',
    '',
    '⚠️ M4 的 Admin API **不做自动召回**（那是 M5）。',
    '   它的用途是把"记错了"与"记对了但没召回"两个问题分开。',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 渲染（纯函数）
// ---------------------------------------------------------------------------

export interface MemoryListRow {
  id: string
  type: string
  status: string
  content: string
  authority: string
  confidence: string
  importance: string
  recordedAt: string
}

/**
 * 计划书第 135 节列的字段：
 *   Memory ID / Type / Status / Content / Authority / Confidence / Source / Valid Time / Processor Version
 *
 * ⚠️ 正文**只在本地 CLI 打印**（人可以看），不进 trace、不外发
 * （计划书第 110 节）。这个区别很重要：开发入口与遥测的隐私边界不同。
 */
export function memoryListRow(record: MemoryRecord): MemoryListRow {
  return {
    id: String(record.id),
    type: record.type,
    status: record.status,
    content: summarizeContent(record),
    authority: record.authority,
    confidence: record.confidence.toFixed(2),
    importance: record.importance.toFixed(2),
    recordedAt: formatTime(record.recordedAt),
  }
}

export function renderMemoryList(records: readonly MemoryRecord[], title: string): string {
  const lines: string[] = ['='.repeat(72), title, '='.repeat(72)]

  if (records.length === 0) {
    lines.push('')
    lines.push('（没有匹配的记忆）')
    lines.push('')
    lines.push('⚠️ 这是**正常结果**，不是故障：')
    lines.push('   · 后台抽取默认关闭（CHARACTER_MEMORY_BACKGROUND_ENABLED）')
    lines.push('   · 大量普通对话本来就不值得长期记（计划书第 50 节）')
    lines.push('   · 想主动让她记住，用「记住，……」这类显式说法')
    return lines.join('\n')
  }

  const rows = records.map(memoryListRow)
  const idWidth = Math.min(52, Math.max(...rows.map((r) => r.id.length)))

  lines.push('')
  for (const [index, row] of rows.entries()) {
    lines.push(`${String(index + 1).padStart(3, ' ')}. ${row.id}`)
    lines.push(
      `     ${row.type.padEnd(15, ' ')} ${row.status.padEnd(11, ' ')} ` +
        `${row.authority.padEnd(22, ' ')} imp=${row.importance} conf=${row.confidence}`
    )
    lines.push(`     ${row.content}`)
    lines.push(`     记于 ${row.recordedAt}`)
  }
  void idWidth
  lines.push('')
  lines.push(`共 ${rows.length} 条。`)
  return lines.join('\n')
}

export function renderMemoryDetail(record: MemoryRecord): string {
  const lines: string[] = ['='.repeat(72), `Memory ${String(record.id)}`, '='.repeat(72), '']

  lines.push(`  类型      : ${record.type}`)
  lines.push(`  状态      : ${record.status}`)
  lines.push(`  认知状态  : ${record.epistemicStatus}`)
  lines.push(`  权威      : ${record.authority}`)
  lines.push(`  置信度    : ${record.confidence}`)
  lines.push(`  重要度    : ${record.importance}`)
  lines.push(`  owner     : ${record.owner.kind}:${String(record.owner.id)}`)
  lines.push(
    `  subjects  : ${record.subjects.map((s) => `${s.kind}:${String(s.id)}`).join(', ') || '(无)'}`
  )
  lines.push('')
  lines.push('  内容：')
  if (isClaimContent(record.content)) {
    lines.push(`    槽位键 : ${record.content.predicate}`)
    lines.push(`    取值   : ${stringify(record.content.value)}`)
    if (record.content.qualifiers !== undefined) {
      lines.push(`    限定   : ${stringify(record.content.qualifiers)}`)
    }
  } else {
    lines.push(`    摘要   : ${record.content.summary}`)
    lines.push(`    参与者 : ${record.content.participants.length} 个`)
    lines.push(`    事件   : ${record.content.eventRefs.join(', ')}`)
    if (record.content.topicTags !== undefined) {
      lines.push(`    话题   : ${record.content.topicTags.join(', ')}`)
    }
  }

  const validity = describeProvenance(record)
  lines.push('')
  lines.push('  时间：')
  lines.push(`    recordedAt（系统何时记下）: ${formatTime(record.recordedAt)}`)
  lines.push(
    `    occurredAt（事情何时发生）: ${
      record.occurredAt !== undefined ? formatTime(record.occurredAt) : '(不知道)'
    }`
  )
  lines.push(
    `    validFrom : ${record.validFrom !== undefined ? formatTime(record.validFrom) : '(不知道)'}`
  )
  lines.push(
    `    validUntil: ${
      record.validUntil === null
        ? '（没有终点 —— 当前有效）'
        : record.validUntil !== undefined
          ? formatTime(record.validUntil)
          : '(不知道)'
    }`
  )
  lines.push('')
  lines.push('  溯源：')
  lines.push(`    证据     : ${validity.sourceRefs.map((r) => `${r.kind}:${r.id}`).join(', ')}`)
  lines.push(`    根证据   : ${validity.evidenceRootIds.join(', ')}`)
  lines.push(`    产生者   : ${validity.processor ?? '(未知)'}@${validity.processorVersion ?? '?'}`)
  if (validity.supersedes.length > 0) {
    lines.push(`    取代了   : ${validity.supersedes.join(', ')}`)
  }
  if (validity.supersededBy !== undefined) {
    lines.push(`    被取代   : ${validity.supersededBy}`)
  }
  lines.push(`    指纹     : ${record.contentFingerprint}`)
  if (record.canonicalKey !== undefined) {
    lines.push(`    槽位键   : ${record.canonicalKey}`)
  }
  lines.push(`    reducer  : ${record.reducerVersion}（revision ${record.revision}）`)

  return lines.join('\n')
}

/** 时间线：复用 `provenance.ts` 的渲染（**同一处实现**，避免两处格式漂移） */
export function renderMemoryTimeline(records: readonly MemoryRecord[], title: string): string {
  return ['='.repeat(72), title, '='.repeat(72), '', renderMemoryHistory(records)].join('\n')
}

export interface EvidenceEventView {
  id: string
  sequence: number
  actorType: string
  content: string
  createdAt: Timestamp
}

/**
 * 反查证据（计划书第 157 节：从 Memory 反查到真实对话）。
 *
 * 这是"凭什么是真的"的最终答案：一条记忆的证据必须能落到
 * **具体那次对话的原文**上。若某个证据 id 查不到对应的对话事件，
 * 那必须被**显式**报出来 —— 它意味着来源是编的或者是被删的。
 */
export function renderMemorySources(
  record: MemoryRecord,
  events: readonly EvidenceEventView[]
): string {
  const lines: string[] = [
    '='.repeat(72),
    `Memory ${String(record.id)} 的证据来源`,
    '='.repeat(72),
    '',
  ]

  const byId = new Map(events.map((e) => [e.id, e]))
  const roots = new Set(record.evidenceRootIds)

  for (const ref of record.sourceRefs) {
    const marker = roots.has(ref.id) ? ' [根证据]' : ''
    lines.push(`  ${ref.kind}:${ref.id}${marker}`)
    const event = byId.get(ref.id)
    if (event === undefined) {
      lines.push('      ⚠️ 查不到对应的事件 —— 来源存疑（可能是编的，或者原始数据被删了）')
      continue
    }
    lines.push(`      #${event.sequence} [${event.actorType}] ${formatTime(event.createdAt)}`)
    lines.push(`      「${event.content.replace(/\n/g, ' / ').slice(0, 200)}」`)
  }

  if (record.sourceRefs.length === 0) {
    lines.push('  ⚠️ 这条记忆**没有任何证据** —— 而 MI-03 要求每条正式记忆都必须有')
  }

  return lines.join('\n')
}

export interface MemoryStatsView {
  total: number
  active: number
  superseded: number
  retracted: number
  disputed: number
  /** 按 processor 版本的产物分布（计划书第 67 节） */
  byProcessor: { processor: string; version: string; count: number }[]
  /** 没有合法证据根的（计划书第 170 节：目标 0） */
  unsupported: number
  /** 被污染的用户事实（计划书第 169 节：目标 0） */
  contaminated: number
  /** 未登记 predicate 的条数（计划书第 19 节的可观测落地点） */
  unregisteredPredicate: number
}

export function renderMemoryStats(view: MemoryStatsView): string {
  const lines: string[] = ['='.repeat(72), 'Memory 统计（计划书第 164–170 节）', '='.repeat(72), '']

  lines.push('  计数：')
  lines.push(`    total      : ${view.total}`)
  lines.push(`    active     : ${view.active}`)
  lines.push(`    superseded : ${view.superseded}`)
  lines.push(`    retracted  : ${view.retracted}`)
  lines.push(`    disputed   : ${view.disputed}`)
  lines.push('')

  lines.push('  ⚠️ 目标为 **0** 的两项（计划书第 169 / 170 节）：')
  const zero = (label: string, value: number) =>
    `    ${label.padEnd(12, ' ')}: ${value} ${value === 0 ? '✅' : '❌ 需要排查'}`
  lines.push(zero('unsupported', view.unsupported))
  lines.push(zero('contaminated', view.contaminated))
  lines.push('')

  lines.push(`  未登记 predicate 的条数：${view.unregisteredPredicate}`)
  lines.push('    （计划书第 19 节：未登记**允许**存在，这个数字是"要不要收进登记表"的输入）')
  lines.push('')

  lines.push('  按 processor 版本（计划书第 67 节：能找出所有旧版本的产物）：')
  if (view.byProcessor.length === 0) lines.push('    （无）')
  for (const row of view.byProcessor) {
    lines.push(`    ${row.processor}@${row.version}: ${row.count}`)
  }

  lines.push('')
  lines.push('  各"率"（计划书第 165–168 节）需要按轮次数算，因此由')
  lines.push('  `memory:audit` 与 trace 的累计属性给出，不在这里凭空计算。')

  return lines.join('\n')
}

/**
 * 人工审计清单（计划书第 217 节）。
 *
 * 计划书把这件事写成了**进入 M5 前的 Gate**：
 *
 *     在进入 M5 前随机抽取至少数十条正式 Memory，人工审计：
 *       这条东西真的值得记吗？来源正确吗？谁说的？
 *       是不是模型猜的？当前还有效吗？有没有重复？旧版本在哪里？为什么建立？
 *     如果这些问题不能快速回答：M4 不通过。
 *
 * 因此这个函数的作用不是"打印一堆数据"，而是**把人要回答的问题写出来**，
 * 并把对应字段摆在旁边。审计者不该自己去翻代码找字段。
 */
/**
 * 审计问题 ⑤「当前还有效吗」的**唯一**判据。
 *
 * ============================================================================
 *  ⚠️ 这个函数是被一次真实的误导输出逼出来的
 * ============================================================================
 * 真库抽审时，一条 **`status = retracted`** 的记忆被渲染成：
 *
 *     ⑤ 当前还有效吗？  → status = retracted, validity = 当前有效
 *
 * 两半互相矛盾，而读它的人正在回答"这条还算不算数"。
 *
 * 根因是那行**只用有效期窗口**回答，完全忽略 `status`：
 * 那条记忆的 `validUntil` 是 `null`（= 窗口开放，
 * 因为它是被**撤回**的，不是被时间终止的）。
 * 于是"窗口开放"被当成了"当前有效"。
 *
 * 抽审的全部价值就在这八个问题能被人信任。一个问题给出
 * **自相矛盾的答案**，比不给出答案更糟 —— 它会让人以为
 * 是自己看错了，而不是让系统看起来有问题。
 *
 * 判据刻意按 `status` 主导（它才是"还算不算现状"的权威），
 * 有效期窗口作为附注保留：窗口与状态不一致本身是**异常**，
 * 值得被看见（例如 active 但窗口已结束）。
 */
/** `MEMORY_RETRACTED` 的原因分类（S4-1：审计渲染按它区分，不再一律说"用户要求忘掉"） */
export type MemoryRetractReason = MemoryRetractedPayload['reason']

/**
 * 撤回原因 → 审计文案。
 *
 * ============================================================================
 *  ⚠️ 这是 M4 技术债 S4-1 的修复（2026-09-26）
 * ============================================================================
 * 真库有一条因**缺陷修复**（processor@1 已知缺陷）被撤回的记录，旧渲染一律写
 * "用户要求忘掉"——审计者会误以为存在一次用户 forget 请求。
 * `reason` 的三个值在 `domain-event.ts` 里各有不同的后续治理语义
 * （forget 不许再记 / correction 可以重新提案 / audit 是系统自纠），
 * 渲染必须如实区分；**不知道原因时宁可说不知道**，不得断言。
 */
function retractLabel(reason: MemoryRetractReason | undefined): string {
  switch (reason) {
    case 'explicit_forget':
      return '用户要求忘掉'
    case 'explicit_correction':
      return '用户说之前记错了，撤回旧记录'
    case 'audit':
      return '系统审计撤回（这条不该存在）'
    default:
      return '撤回原因未提供——用 memory:history / memory:sources 查触发事件'
  }
}

function currentVerdict(record: MemoryRecord, retractReason?: MemoryRetractReason): string {
  const window =
    record.validUntil === null
      ? '有效期开放'
      : record.validUntil !== undefined
        ? `有效期结束于 ${formatTime(record.validUntil)}`
        : '不知道何时失效'

  switch (record.status) {
    case 'active':
      // active 但窗口已结束 = 两个字段不一致，如实标出而不是二选一
      return record.validUntil !== undefined && record.validUntil !== null
        ? `**有效期已过**（${window}）—— 但仍标记为 active，需要复核`
        : `当前有效（${window}）`
    case 'superseded':
      return `**不再是现状**（已被更新的记忆取代；${window}）`
    case 'retracted':
      return `**已撤回**（${retractLabel(retractReason)}；历史保留，${window}）`
    case 'disputed':
      return `**存疑**（有矛盾陈述，尚未定论；${window}）`
    default:
      return `未知状态 ${String(record.status)}`
  }
}

/**
 * 渲染人工审计清单（计划书第 217 节）。
 *
 * @param retractReasons 可选：每条 retracted 记忆的撤回原因（key = memoryId 字符串）。
 *   不提供时，⑤ 的答案会如实写"撤回原因未提供"——**不会**退回"用户要求忘掉"的
 *   旧误导文案（S4-1）。装配层（`src/main.ts` 的 `memory:audit` 与 `m4-audit.ts`）
 *   从领域事件流里取 `MEMORY_RETRACTED.payload.reason` 填充。
 */
export function renderMemoryAudit(
  records: readonly MemoryRecord[],
  retractReasons?: ReadonlyMap<string, MemoryRetractReason>
): string {
  const lines: string[] = [
    '='.repeat(72),
    'Memory 人工审计清单（计划书第 217 节的 Gate）',
    '='.repeat(72),
    '',
    `共抽取 ${records.length} 条。每条下面八个问题都必须能快速回答。`,
    '',
  ]

  if (records.length === 0) {
    lines.push('（没有可审计的记忆）')
    lines.push('')
    lines.push('⚠️ 计划书第 217 节要求"至少数十条"。若这里为空或很少，')
    lines.push('   说明记忆规模还不足以做这个 Gate —— 那是**如实的状态**，')
    lines.push('   不应当用沙箱里的测试数据冒充真实库的审计对象。')
    return lines.join('\n')
  }

  for (const [index, record] of records.entries()) {
    const validity = describeProvenance(record)
    lines.push(`─── ${index + 1}/${records.length} ─────────────────────────────────`)
    lines.push(`  ${String(record.id)}`)
    lines.push(`  type=${record.type}  status=${record.status}  authority=${record.authority}`)
    lines.push(`  内容：${summarizeContent(record)}`)
    lines.push('')
    lines.push('  ① 这条东西真的值得记吗？    → importance = ' + record.importance.toFixed(2))
    lines.push(
      `  ② 来源正确吗？              → ${validity.sourceRefs
        .map((r) => `${r.kind}:${r.id}`)
        .join(', ')}`
    )
    lines.push(`      （用 pnpm memory:sources ${String(record.id)} 看原文）`)
    lines.push(`  ③ 谁说的？                  → authority = ${record.authority}`)
    lines.push(
      `  ④ 是不是模型猜的？          → epistemic = ${record.epistemicStatus}` +
        (record.authority === 'CHARACTER_GENERATION' || record.authority === 'MODEL_INFERENCE'
          ? '  ⚠️ 这两类权威**不该**出现在 person_fact / preference 上'
          : '')
    )
    lines.push(
      `  ⑤ 当前还有效吗？            → ${currentVerdict(record, retractReasons?.get(String(record.id)))}`
    )
    lines.push(`      （用 pnpm memory:history ${String(record.id)} 看有没有重复）`)
    lines.push(
      `  ⑥ 有没有重复？              → fingerprint = ${record.contentFingerprint}`
    )
    lines.push(
      `  ⑦ 旧版本在哪里？            → supersedes = ${
        validity.supersedes.length > 0 ? validity.supersedes.join(', ') : '(无)'
      }`
    )
    lines.push(
      `  ⑧ 为什么建立？              → ${validity.processor ?? '?'}@${
        validity.processorVersion ?? '?'
      }`
    )
    lines.push('')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function summarizeContent(record: MemoryRecord): string {
  if (isClaimContent(record.content)) {
    const qualifiers =
      record.content.qualifiers !== undefined && Object.keys(record.content.qualifiers).length > 0
        ? ` ${stringify(record.content.qualifiers)}`
        : ''
    return `${record.content.predicate} = ${stringify(record.content.value)}${qualifiers}`
  }
  return record.content.summary
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatTime(ts: Timestamp | undefined): string {
  if (ts === undefined) return '(未知)'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return `(非法时间戳 ${ts})`
  return d.toISOString().replace('T', ' ').slice(0, 19)
}
