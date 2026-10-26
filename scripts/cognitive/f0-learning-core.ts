/**
 * F0 学习轨的**可离线验证核心**（2026-10-23）
 *
 * 依据 [协议 §4 L](docs/architecture/Cognitive-Capability-Experiment-Protocol-2026-10-23.md) 与
 * [F0 执行清单](docs/architecture/Cognitive-Capability-F0-Execution-List-2026-10-23.md)。
 *
 * ============================================================================
 *  这个文件**只做纯函数**：不碰数据库、不碰文件系统、**不发任何模型请求**。
 * ============================================================================
 *  · 生成器：3 世界 × 8 任务（3 早期接触 / 3 新绑定迁移 / 2 范围稳定控制），每世界一个**显式 `familyId`**。
 *  · 三臂的**选择逻辑**：A 取模型第一候选；B 取"**静态**满足明确目标"的第一候选（不满足则保持原顺序）；
 *    **C 不在这里**——它由模拟选路核心（`createSimulationTaskPlanner`）在运行器里产生，
 *    本文件只保留 `C` 这个 id 以便拒绝静态选择。
 *  · 评分：**程序真值**（字节匹配 + 最后一次真实读回指纹 + 自报完成但未达成），不看候选自述。
 *
 * ⚠️ 纪律：族范围用**显式 `familyId`**，**不得**把任意目录天然当成一个规律族；
 *    成功/失败对只能提出假设，不能证明某属性是必要条件（那是 F1 的事，本文件不涉及）。
 */

/** 每世界 8 个任务：3 早期接触 + 3 新绑定迁移 + 2 范围/稳定控制。 */
export const F0_PHASES = ['early_contact', 'new_binding', 'scope_control'] as const
export type F0Phase = (typeof F0_PHASES)[number]

/** 四个已声明的格式族（沿用文件选择器协议），每世界每任务用**不同**实例。 */
export const F0_FORMATS = ['multiline-zh', 'json', 'quotes-backslash', 'whitespace-eof'] as const
export type F0Format = (typeof F0_FORMATS)[number]

export const F0_TASKS_PER_WORLD = 8
export const F0_WORLD_COUNT = 3

export interface F0World {
  /** 世界 id */
  readonly id: string
  /** **显式族键**（不是"目录就等于族"） */
  readonly familyId: string
  /** 该世界的路径前缀（实例不同路径由它派生） */
  readonly pathPrefix: string
}

export interface F0Task {
  readonly id: string
  readonly worldId: string
  readonly familyId: string
  readonly index: number
  readonly phase: F0Phase
  readonly format: F0Format
  /** 相对路径（每任务不同） */
  readonly path: string
  /** 用户逐字给定的内容（每任务不同） */
  readonly content: string
}

/** 任务序号 → 阶段（0-2 早期接触、3-5 新绑定、6-7 范围控制）。 */
export function phaseOfIndex(index: number): F0Phase {
  if (!Number.isInteger(index) || index < 0 || index >= F0_TASKS_PER_WORLD) throw new Error(`f0_index_out_of_range:${String(index)}`)
  return index < 3 ? 'early_contact' : index < 6 ? 'new_binding' : 'scope_control'
}

/** 3 个世界：各自**不同的 familyId 与前缀**（不是同一族的三个副本）。 */
export function listF0Worlds(): readonly F0World[] {
  return [
    { id: 'f0-world-a', familyId: 'f0-family-a', pathPrefix: 'f0/a' },
    { id: 'f0-world-b', familyId: 'f0-family-b', pathPrefix: 'f0/b' },
    { id: 'f0-world-c', familyId: 'f0-family-c', pathPrefix: 'f0/c' },
  ]
}

/** 内容模板：四种格式族，每族给**不同**实例（同一世界内不重复）。 */
function contentFor(format: F0Format, world: F0World, index: number): string {
  const tag = `${world.familyId}#${String(index)}`
  switch (format) {
    case 'multiline-zh':
      return `第一行 ${tag}\n第二行 中文内容\n第三行 结束\n`
    case 'json':
      return `{"tag":"${tag}","n":${String(index)},"ok":true}`
    case 'quotes-backslash':
      return `引号"${tag}" 反斜线\\ 与 '单引号' 及 emoji 🙂`
    case 'whitespace-eof':
      return `  前后空白 ${tag}  \n\n`
    default:
      throw new Error(`f0_unknown_format:${String(format)}`)
  }
}

/** 生成一个世界的 8 个任务（纯函数、确定性：同样的世界总得到同样的任务）。 */
export function generateF0Tasks(world: F0World): readonly F0Task[] {
  const tasks: F0Task[] = []
  for (let index = 0; index < F0_TASKS_PER_WORLD; index += 1) {
    const format = F0_FORMATS[index % F0_FORMATS.length]!
    tasks.push({
      id: `${world.id}-t${String(index + 1)}`,
      worldId: world.id,
      familyId: world.familyId,
      index,
      phase: phaseOfIndex(index),
      format,
      // ⚠️ 每任务**不同路径**：新绑定迁移与范围控制都必须换对象。
      // ⚠️ 路径必须是**生产目标语法**能解析的：`explicitFileGoal` 的正则是
      //    `^只操作相对路径 ([A-Za-z0-9_-]+\.txt)。写入以下 JSON 字符串…`
      //    ⇒ **不能带目录分隔符**，否则目标解析不出来 ⇒ 模拟与普通规划都拿不到目标。
      //    世界的区分靠**显式 `familyId`** 与各自的隔离库/文件根，**不靠路径**。
      path: `f0-t${String(index + 1)}-${format}.txt`,
      content: contentFor(format, world, index),
    })
  }
  return tasks
}

// ---------------------------------------------------------------------------
// 候选与三臂选择
// ---------------------------------------------------------------------------

export interface F0Step {
  readonly capability: string
  readonly operation: string
  readonly args: Readonly<Record<string, string>>
}

export interface F0Candidate {
  readonly goal: string
  readonly done: boolean
  readonly steps: readonly F0Step[]
}

export interface F0Goal {
  readonly path: string
  readonly content: string
}

export type F0StaticArm = 'A' | 'B'

export interface F0Selection {
  readonly index: number
  readonly reason: string
}

/**
 * **静态**判断：候选是否"静态满足明确目标"——写目标路径且内容逐字等于目标内容，
 * 并且**在该写之后**存在对该路径的读取。
 *
 * ⚠️ 这是**纯语法检查**，不模拟、不查询规则库、不调用模型。
 * ⚠️ **不接受"只写不读"**：明确目标的达成要求**存在真实的最后读回**（见文件选择器协议），
 *    所以写了正确字节但**没有**后续读取的候选**不算**静态满足——`candidate.done` 更不能替代读回。
 */
export function candidateStaticallySatisfies(candidate: F0Candidate, goal: F0Goal): boolean {
  let written = false
  for (const step of candidate.steps) {
    if (step.args.path !== goal.path) continue
    if (step.capability === 'sandbox.file.write' && step.operation === 'write') {
      if (step.args.content === goal.content) written = true
      continue
    }
    // 只认**写之后**的读；读在写之前的候选不满足。
    if (step.capability === 'sandbox.file.read' && step.operation === 'read' && written) return true
  }
  return false
}

/**
 * A / B 两臂的选择。
 *
 * · **A｜LG 强基线**：取模型排第一的候选（`first_ranked`）。
 * · **B｜简单条件策略**：取**首个**静态满足明确目标的候选；没有就**保持原顺序**
 *   （`static_none_first_ranked`）——**不**重试、**不**猜测。
 *
 * ⚠️ **C 臂不在这里**：它由模拟选路核心产生（规则合格才选，不合格走默认），
 *    静态选择无法替代它；传 'C' 会显式报错，避免把 C 悄悄降级成 B。
 */
export function selectF0Candidate(arm: F0StaticArm | 'C', candidates: readonly F0Candidate[], goal: F0Goal): F0Selection {
  if (candidates.length === 0) throw new Error('f0_no_candidate')
  if (arm === 'C') throw new Error('f0_arm_c_is_not_static:use_simulation_planner')
  if (arm === 'A') return { index: 0, reason: 'first_ranked' }
  const index = candidates.findIndex(candidate => candidateStaticallySatisfies(candidate, goal))
  return index < 0 ? { index: 0, reason: 'static_none_first_ranked' } : { index, reason: 'static_goal_satisfied' }
}

// ---------------------------------------------------------------------------
// 候选覆盖写检查（纯函数；运行器与离线门共用）
// ---------------------------------------------------------------------------

/** 把模型给的计划规整成核心的 F0Candidate（args 的值统一成字符串）。 */
export function toCandidate(plan: { goal?: unknown; done?: unknown; steps?: ReadonlyArray<{ capability?: unknown; operation?: unknown; args?: Readonly<Record<string, unknown>> }> }): F0Candidate {
  const steps = (plan.steps ?? []).map(step => ({
    capability: String(step.capability), operation: String(step.operation),
    args: Object.fromEntries(Object.entries(step.args ?? {}).map(([key, value]) => [key, String(value)])),
  }))
  return { goal: String(plan.goal ?? ''), done: plan.done === true, steps }
}

/**
 * **候选覆盖写检查**：候选池里必须有一条**真的覆盖目标写入**的候选
 * （写目标路径 + 内容逐字相等 + 其后有该路径的读取）。
 *
 * ⚠️ 缺这一步时，"模型给的候选整体没覆盖目标"会被算成**臂没选对** ⇒ 归因错位。
 * ⚠️ "只写不读"**不算**覆盖：明确目标的达成要求存在真实的最后读回。
 */
export function poolCoversGoal(
  candidates: ReadonlyArray<{ goal?: unknown; done?: unknown; steps?: ReadonlyArray<{ capability?: unknown; operation?: unknown; args?: Readonly<Record<string, unknown>> }> }>,
  goal: { path: string; content: string },
): boolean {
  return candidates.some(plan => {
    const candidate = toCandidate(plan)
    let written = false
    for (const step of candidate.steps) {
      if (step.args.path !== goal.path) continue
      if (step.capability === 'sandbox.file.write' && step.operation === 'write') {
        if (step.args.content === goal.content) written = true
        continue
      }
      if (step.capability === 'sandbox.file.read' && step.operation === 'read' && written) return true
    }
    return false
  })
}

// ---------------------------------------------------------------------------
// 评分（程序真值，不看自述）
// ---------------------------------------------------------------------------

export interface F0Observation {
  /** 该任务是否写出目标字节（由真值侧读回文件判断） */
  readonly bytesMatch: boolean
  /** 最后一次真实读回是否成功且指纹匹配目标内容 */
  readonly readMatched: boolean
  /** 运行器自报的结束原因 */
  readonly stopped: string
}

export interface F0Score {
  readonly achieved: boolean
  readonly falseCompletion: boolean
}

/** 达成 = 字节匹配 **且** 存在成功的最后真实读回；自报 done 但未达成 ⇒ 假完成。 */
export function scoreF0Task(observation: F0Observation): F0Score {
  const achieved = observation.bytesMatch && observation.readMatched
  return { achieved, falseCompletion: observation.stopped === 'done' && !achieved }
}

/** 每个世界的主读数：**达成相同目标所增加的**真实动作数（C/B 相对 A）。 */
export function extraActionsPerWorld(
  rows: ReadonlyArray<{ worldId: string; arm: string; achieved: boolean; actions: number }>,
): ReadonlyArray<{ worldId: string; arm: string; achievedTasks: number; actionsOnAchieved: number; extraVsA: number | null }> {
  const worlds = [...new Set(rows.map(row => row.worldId))]
  return worlds.flatMap((worldId) => rows
    .filter(row => row.worldId === worldId)
    .map(row => {
      const group = rows.filter(item => item.worldId === worldId)
      const baseline = group.filter(item => item.arm === 'A')
      const mine = group.filter(item => item.arm === row.arm)
      const actions = (items: typeof rows) => items.filter(item => item.achieved).reduce((sum, item) => sum + item.actions, 0)
      return {
        worldId, arm: row.arm,
        achievedTasks: mine.filter(item => item.achieved).length,
        actionsOnAchieved: actions(mine),
        // 只在**达成任务数相同**时才给差值，否则不可比（达成率不同不能用动作数比较）。
        extraVsA: mine.filter(item => item.achieved).length === baseline.filter(item => item.achieved).length && baseline.length > 0
          ? actions(mine) - actions(baseline) : null,
      }
    }))
    .filter((entry, index, all) => all.findIndex(item => item.worldId === entry.worldId && item.arm === entry.arm) === index)
}
