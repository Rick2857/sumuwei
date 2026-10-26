/**
 * F0 核心的**离线门**（零模型请求、零数据库、零文件系统）。
 *
 * 只验证纯函数：生成器的形状与确定性、三臂选择逻辑（A/B 静态、C 必须显式拒绝）、
 * 评分与"额外动作"差值的口径（达成数不同时不给差值）。
 */
import assert from 'node:assert/strict'
import {
  F0_FORMATS, F0_TASKS_PER_WORLD, F0_WORLD_COUNT,
  candidateStaticallySatisfies, extraActionsPerWorld, generateF0Tasks, listF0Worlds, phaseOfIndex,
  scoreF0Task, selectF0Candidate, type F0Candidate, type F0Goal,
} from './f0-learning-core.ts'

let checks = 0
const ok = (label: string, condition: boolean) => { assert.ok(condition, label); checks += 1 }

// —— 1. 世界与族 ——
const worlds = listF0Worlds()
ok('world_count', worlds.length === F0_WORLD_COUNT)
ok('world_ids_unique', new Set(worlds.map(w => w.id)).size === F0_WORLD_COUNT)
ok('family_ids_unique', new Set(worlds.map(w => w.familyId)).size === F0_WORLD_COUNT)
ok('prefixes_unique', new Set(worlds.map(w => w.pathPrefix)).size === F0_WORLD_COUNT)
// ⚠️ 族键必须**显式**：族 id 不等于路径前缀（防止"目录即族"的滑落）。
ok('family_is_not_the_directory', worlds.every(w => w.familyId !== w.pathPrefix))

// —— 2. 任务形状 ——
for (const world of worlds) {
  const tasks = generateF0Tasks(world)
  ok(`task_count:${world.id}`, tasks.length === F0_TASKS_PER_WORLD)
  ok(`phases:${world.id}`, tasks.filter(t => t.phase === 'early_contact').length === 3
    && tasks.filter(t => t.phase === 'new_binding').length === 3
    && tasks.filter(t => t.phase === 'scope_control').length === 2)
  ok(`paths_unique:${world.id}`, new Set(tasks.map(t => t.path)).size === tasks.length)
  ok(`contents_unique:${world.id}`, new Set(tasks.map(t => t.content)).size === tasks.length)
  ok(`family_carried:${world.id}`, tasks.every(t => t.familyId === world.familyId))
  ok(`formats_covered:${world.id}`, new Set(tasks.map(t => t.format)).size === F0_FORMATS.length)
  ok(`prefix_respected:${world.id}`, tasks.every(t => t.path.startsWith(`${world.pathPrefix}/`)))
  // 确定性：同一世界两次生成逐字相同。
  ok(`deterministic:${world.id}`, JSON.stringify(generateF0Tasks(world)) === JSON.stringify(tasks))
}
// 跨世界的任务不重叠（不同族不共用对象）。
const allPaths = worlds.flatMap(w => generateF0Tasks(w).map(t => t.path))
ok('paths_unique_across_worlds', new Set(allPaths).size === allPaths.length)
ok('phase_boundaries', phaseOfIndex(0) === 'early_contact' && phaseOfIndex(2) === 'early_contact'
  && phaseOfIndex(3) === 'new_binding' && phaseOfIndex(5) === 'new_binding'
  && phaseOfIndex(6) === 'scope_control' && phaseOfIndex(7) === 'scope_control')
assert.throws(() => phaseOfIndex(8), /f0_index_out_of_range/)
checks += 1

// —— 3. 静态候选判定 ——
const goal: F0Goal = { path: 'f0/a/task-4-json.txt', content: '{"tag":"f0-family-a#3","n":3,"ok":true}' }
const good: F0Candidate = { goal: 'g', done: true, steps: [
  { capability: 'sandbox.file.write', operation: 'write', args: { path: goal.path, content: goal.content } },
  { capability: 'sandbox.file.read', operation: 'read', args: { path: goal.path } },
] }
/** 写对了但**没读** */
const writeOnly: F0Candidate = { goal: 'g', done: true, steps: [
  { capability: 'sandbox.file.write', operation: 'write', args: { path: goal.path, content: goal.content } },
] }
/** 读在写**之前** */
const readBeforeWrite: F0Candidate = { goal: 'g', done: true, steps: [
  { capability: 'sandbox.file.read', operation: 'read', args: { path: goal.path } },
  { capability: 'sandbox.file.write', operation: 'write', args: { path: goal.path, content: goal.content } },
] }
/** 内容差一个字符 */
const wrongContent: F0Candidate = { goal: 'g', done: true, steps: [
  { capability: 'sandbox.file.write', operation: 'write', args: { path: goal.path, content: `${goal.content} ` } },
  { capability: 'sandbox.file.read', operation: 'read', args: { path: goal.path } },
] }
/** 路径不对 */
const wrongPath: F0Candidate = { goal: 'g', done: true, steps: [
  { capability: 'sandbox.file.write', operation: 'write', args: { path: 'f0/b/task-4-json.txt', content: goal.content } },
  { capability: 'sandbox.file.read', operation: 'read', args: { path: 'f0/b/task-4-json.txt' } },
] }

ok('static_good', candidateStaticallySatisfies(good, goal))
ok('static_write_only_rejected', candidateStaticallySatisfies(writeOnly, goal) === false)
ok('static_read_before_write_rejected', candidateStaticallySatisfies(readBeforeWrite, goal) === false)
ok('static_wrong_content_rejected', candidateStaticallySatisfies(wrongContent, goal) === false)
ok('static_wrong_path_rejected', candidateStaticallySatisfies(wrongPath, goal) === false)

// —— 4. 三臂选择 ——
const pool = [wrongPath, good, writeOnly]
const armA = selectF0Candidate('A', pool, goal)
ok('arm_a_takes_first', armA.index === 0 && armA.reason === 'first_ranked')
const armB = selectF0Candidate('B', pool, goal)
ok('arm_b_finds_static_goal', armB.index === 1 && armB.reason === 'static_goal_satisfied')
const noneQualifies = selectF0Candidate('B', [wrongPath, writeOnly], goal)
ok('arm_b_falls_back_to_first', noneQualifies.index === 0 && noneQualifies.reason === 'static_none_first_ranked')
// C 必须**显式拒绝**静态选择（不得被悄悄降级成 B）。
assert.throws(() => selectF0Candidate('C', pool, goal), /f0_arm_c_is_not_static/)
checks += 1
assert.throws(() => selectF0Candidate('A', [], goal), /f0_no_candidate/)
checks += 1

// —— 5. 评分（程序真值，不看自述） ——
const achieved = scoreF0Task({ bytesMatch: true, readMatched: true, stopped: 'done' })
ok('score_achieved', achieved.achieved && !achieved.falseCompletion)
const falseDone = scoreF0Task({ bytesMatch: true, readMatched: false, stopped: 'done' })
ok('score_false_completion', !falseDone.achieved && falseDone.falseCompletion)
const wroteNoRead = scoreF0Task({ bytesMatch: true, readMatched: false, stopped: 'action_failed' })
ok('score_no_read_not_achieved', !wroteNoRead.achieved && !wroteNoRead.falseCompletion)
const nothing = scoreF0Task({ bytesMatch: false, readMatched: true, stopped: 'done' })
ok('score_bytes_mismatch_not_achieved', !nothing.achieved)

// —— 6. "额外动作"差值口径 ——
const rows = [
  // world-a：三臂都达成 8 个，A 用 16 动作、B 用 16、C 用 20 ⇒ C 的差值 +4。
  ...Array.from({ length: 8 }, (_, i) => ({ worldId: 'f0-world-a', arm: 'A', achieved: true, actions: 2, task: i })),
  ...Array.from({ length: 8 }, (_, i) => ({ worldId: 'f0-world-a', arm: 'B', achieved: true, actions: 2, task: i })),
  ...Array.from({ length: 8 }, (_, i) => ({ worldId: 'f0-world-a', arm: 'C', achieved: true, actions: 2.5, task: i })),
  // world-b：C 少达成一个 ⇒ **不给差值**（达成率不同不能用动作数比）。
  ...Array.from({ length: 8 }, (_, i) => ({ worldId: 'f0-world-b', arm: 'A', achieved: true, actions: 2, task: i })),
  ...Array.from({ length: 7 }, (_, i) => ({ worldId: 'f0-world-b', arm: 'C', achieved: true, actions: 3, task: i })),
]
const deltas = extraActionsPerWorld(rows)
const aDelta = deltas.find(entry => entry.worldId === 'f0-world-a' && entry.arm === 'B')!
ok('delta_comparable', aDelta.extraVsA === 0 && aDelta.achievedTasks === 8)
const cDelta = deltas.find(entry => entry.worldId === 'f0-world-a' && entry.arm === 'C')!
ok('delta_c_plus_four', cDelta.extraVsA === 4)
const bWorldC = deltas.find(entry => entry.worldId === 'f0-world-b' && entry.arm === 'C')!
ok('delta_withheld_when_achievement_differs', bWorldC.extraVsA === null && bWorldC.achievedTasks === 7)

console.log(`F0 核心离线门：${String(checks)} 项检查全部通过（零模型请求、零数据库、零文件系统）。`)
