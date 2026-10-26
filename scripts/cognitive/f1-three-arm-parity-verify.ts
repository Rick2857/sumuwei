/**
 * **G1 共同三臂装配：输入同形性验收**（零模型 · 每臂独立库/角色/文件根 · 真实 ActionTurn）。
 *
 * ============================================================================
 *  结构
 * ============================================================================
 * ```text
 * 本文件（父）── runPgScenarioGate ──▶ 子进程 × 3（A / B / C）
 *     每个子进程：**独立数据库 + 独立角色 + 独立文件根**（三臂不共享任何状态）
 *     子进程：跑完 8 题 → 写自己的 report.json（含**实际会送给模型的输入**快照）
 * 本文件（父）再读三份 report.json ⇒ **逐字段**比同形性 ⇒ 写 summary json
 * ```
 * ⚠️ 同形性比对**不能**在一个进程里跑三个臂：那样它们会共用同一个库 ⇒ 后一个臂
 *    会看见前一个臂的资格（实测踩过：`B` 的第 1 题就"已有资格"）。
 * ⚠️ 零模型请求：候选端口是**离线夹具**，不是真实模型，也不产生 token 费用。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runPgScenarioGate } from '../postgresql/scenario-gate.ts'
import { createM4Harness } from '../m4-harness.ts'
import { createArmBed, ensureWorldDirectories, loadPreregData, type ArmRun, type F1Arm, type F1TaskSpec, type PlannerInputSnapshot } from './f1-three-arm-factory.ts'

const ARMS: readonly F1Arm[] = ['A', 'B', 'C']
const { worlds, tasks, oracle } = loadPreregData()
const worldId = process.argv.includes('--world') ? process.argv[process.argv.indexOf('--world') + 1]! : worlds[0]!.worldId

if (process.argv.includes('--case')) {
  // ---------------------------------------------------------------- 子进程
  const arm = process.argv[process.argv.indexOf('--case') + 1] as F1Arm
  assert.ok(ARMS.includes(arm), 'unknown_arm')
  const world = worlds.find(item => item.worldId === worldId)!
  const worldTasks = tasks.filter(task => task.worldId === worldId)
  const schedule = oracle.find(item => item.worldId === worldId)!.schedule
  const output = resolve('artifacts/local/f1-three-arm-parity', `${worldId}-${arm}`)
  mkdirSync(output, { recursive: true })
  const root = mkdtempSync(resolve(output, 'files-'))
  ensureWorldDirectories(root, world.knownDirectories)
  const h = await createM4Harness({ label: `f1-three-arm-${worldId}-${arm}`, userId: 'Alex' })
  try {
    const bed = createArmBed({
      arm, h, world, tasks: worldTasks, oracle: schedule, db: h.db, characterId: h.kernel.characterId, userId: h.userId, root,
      /*
       * 离线候选夹具：**先读标记** → 写 → 读回（**不是**真实模型请求）。
       * ⚠️ "先读标记"是**夹具自己的选择**（真实模型跑时由模型决定要不要读）；
       *    不先读就**永远形成不出族规则**（C2 要求"先读到条件、再那次写"）。
       * ⚠️ A/B 拿到**同一份**标记读能力 ⇒ 差异**只在**否决与自动观察。
       */
      candidatePlans: (task: F1TaskSpec) => [{
        goal: 'offline-candidate', done: true, steps: [
          { capability: 'sandbox.file.read', operation: 'read', args: { path: task.conditionPath } },
          { capability: 'sandbox.file.write', operation: 'write', args: { path: task.targetPath, content: task.content } },
          { capability: 'sandbox.file.read', operation: 'read', args: { path: task.targetPath } },
        ],
      }],

    })
    const run = await bed.run()
    assert.equal(bed.observerErrors.length, 0, `observer_errors:${bed.observerErrors.join('|')}`)
    writeFileSync(resolve(output, 'report.json'), JSON.stringify({ status: 'PASS', kind: 'g1_arm_run_not_benefit',
      worldId, arm, run, observerErrors: bed.observerErrors, modelRequests: 0, productionOpened: false }, null, 2))
    console.log(`ARM ${arm} done: rows=${String(run.rows.length)} actions=${String(run.totalActions)} plans=${String(run.totalPlans)} achieved=${String(run.achieved)}`)
  } finally { await h.stop() }
  process.exit(0)
}

// Each unit has a fresh migrated database/role and its own continuous eight-task history.
assert.ok(process.env.LG_SIM_PGTEST_ADMIN_URL, 'serversim_pgtest_required')
const outcomes = await runPgScenarioGate({ label: 'f1-three-arm-parity', script: 'scripts/cognitive/f1-three-arm-parity-verify.ts',
  scenarios: worlds.flatMap(world => ARMS.map(arm => ({ id: `${world.worldId}-${arm}`, argv: ['--case', arm, '--world', world.worldId] }))) })
for (const outcome of outcomes) assert.equal(outcome.ok, true, `${outcome.id}: ${outcome.tail}`)
const checks: string[] = []
const check = (label: string, pass: unknown) => { assert.ok(pass, label); checks.push(label); console.log(`PASS ${label}`) }
const reports: ArmRun[] = []
for (const world of worlds) {
  const runs = ARMS.map(arm => (JSON.parse(readFileSync(resolve('artifacts/local/f1-three-arm-parity', `${world.worldId}-${arm}`, 'report.json'), 'utf8')) as { run: ArmRun }).run)
  for (const run of runs) {
    reports.push(run)
    const label = `${world.worldId}/${run.arm}`
    check(`${label}: eight tasks and native observer has no hidden failures`, run.rows.length === 8 && run.rows.every(row => row.epistemicFailures === 0))
    check(`${label}: no gifted qualifications`, !run.rows[0]!.before.readback && !run.rows[0]!.before.precondition)
    check(`${label}: actual production planner request messages were captured`, run.plannerInputs.length > 0
      && run.plannerInputs.every(row => row.messages.length === 3 && row.messages[1]!.content.length > 0))
    check(`${label}: compiler sections and native recall/reflection ports wired`, run.baseline.recall && run.baseline.reflection
      && run.reflectionRuns.length === 8 && run.plannerInputs.every(row => row.contextSections.length > 0))
    check(`${label}: post-turn memory receives each original task and commits through native validator`, run.memoryPrompts.length === 8
      && run.memoryReadings.every(reading => reading.status !== 'failed' && reading.status !== 'retry_exhausted'))
    check(`${label}: own earlier dialogue/feedback reaches later planning`, run.plannerInputs.some(row => row.ordinal > 1
      && row.messages[1]!.content.includes('stopped') && row.messages[1]!.content.includes('sandbox.file')))
    check(`${label}: no oracle schedule, world truth or arm labels in actual messages`, run.plannerInputs.every(row => {
      const text = JSON.stringify(row.messages)
      return !['guardApplied', 'markerValue', 'expectedDirectWrite', 'oracle.json', 'EXECUTOR_AND_INDEPENDENT_SCORER', 'f1-arm-'].some(secret => text.includes(secret))
    }))
    check(`${label}: no wrong completion credit for veto`, run.rows.every(row => row.veto?.decision !== 'veto' || (!row.goalAchieved && row.stopped !== 'done')))
  }
  check(`${world.worldId}: common baseline configuration/permissions/budget`, runs.every(run => JSON.stringify(run.baseline) === JSON.stringify(runs[0]!.baseline)))
  check(`${world.worldId}: all arms receive the same explicitly unvalidated condition declarations`, runs.every(run => run.plannerInputs.every(row => row.messages[1]!.content.includes('仅为待验证假设形状，不表示规律成立') && row.messages[1]!.content.includes(JSON.stringify(world.declarations)))))
  const first = runs.map(run => run.plannerInputs[0]!)
  check(`${world.worldId}: first untrained model messages are equal`, first.every(row => JSON.stringify(row.messages) === JSON.stringify(first[0]!.messages)))
  check(`${world.worldId}: same tools, facts and observation authorization`, runs.every(run => run.plannerInputs.every(row =>
    JSON.stringify(row.allowedCapabilities) === JSON.stringify(first[0]!.allowedCapabilities)
      && JSON.stringify(row.knownDirectories) === JSON.stringify(first[0]!.knownDirectories)
      && row.observation?.conditionPath === first[0]!.observation?.conditionPath)))
  check(`${world.worldId}: only C consumes qualified veto rules`, runs.filter(run => run.arm !== 'C').every(run => run.rows.every(row => !row.consumed && !row.observationScheduled)))
  check(`${world.worldId}: C actually reaches automatic observation and veto`, runs[2]!.rows.some(row => row.observationScheduled && row.veto?.decision === 'veto'))
}
const output = resolve('artifacts/local/f1-three-arm-parity/verification.json')
writeFileSync(output, JSON.stringify({ status: 'PASS', kind: 'offline_common_assembly_not_live_baseline_acceptance', checks,
  units: reports.map(run => ({ world: run.worldId, arm: run.arm, achieved: run.achieved, actions: run.totalActions, plans: run.totalPlans,
    firstJoint: run.firstJointQualification, firstConsumption: run.firstConsumption, reflectionRuns: run.reflectionRuns })),
  modelRequests: 0, productionOpened: false, limitations: ['offline response fixture; no model behavior or reflection quality assessed',
    'no live runner, seal or benefit claim', 'diverged histories must remain independent, not forced byte-equal'] }, null, 2))
console.log(`F1 offline common assembly: ${checks.length}/${checks.length}; ${output}`)
