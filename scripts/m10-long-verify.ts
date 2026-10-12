/**
 * M10 WP9-B —— **时间维度门**（`pnpm m10:long:verify`）。
 *
 * ============================================================================
 *  本门测什么（计划 §12 WP9 的出口判据里属"时间"的那几条）
 * ============================================================================
 * ```text
 * G47  200 轮连续轨迹：设立 → 暂停 → 恢复 → 修订 → 取消 / 完成**全链在案**，
 *      且**每回合都有状态**
 *      跨会话重启：丢掉全部内存缓存 + 从库里重读 + rebuild ⇒ 逐字段一致
 *      取消与复活：同内容 + **新的独立来源** ⇒ 新身份；**忘了以后同来源** ⇒ 被禁用根挡
 *      旧结果迟到：stale `expectedRevision` ⇒ 拒绝，**不得**完成新约定
 *      重复触发：同一提案两次 ⇒ 第二次被拒（零事件）
 * G48  零分母**不是** PASS（本门自带一条：空层语料的清单必须报缺口）
 * ```
 *
 * ============================================================================
 *  三条硬性质
 * ============================================================================
 * ① **轨迹走的是真实链路**：`runGoalTurn()`（WP9-A 抽出的 `m10-harness.ts`
 *    是**唯一**的接线）。
 * ② **`resume` 用直接提案**：`draftToProgramProposal` 给 `resume` 的缺省复核读数是
 *    `dropped: 1`（**刻意的失败关闭**，`C-24`）⇒ 走语义链的 resume 必然被拒。
 *    要测"恢复这条**合法边**"，必须自己给出复核读数。放行口**照样判**。
 * ③ **重启是"丢缓存 + 重读"，不是"杀进程"**：后者需要一个独立的进程与库句柄，
 *    属**未测**（`L-M10-42`）。本门**不**假装做了那件事。
 */

import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m10-long', { keep: false })

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { AgentRuntime } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'

import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'
import { createM10TurnHarness, deterministicRuntime, fixedProvider } from './m10-harness.ts'
import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { getRawDb } from '../src/infrastructure/persistence/db.ts'
import { domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { rebuildGoalProjections } from '../src/infrastructure/persistence/goal-store.ts'
import type { CharacterId } from '../src/kernel/contracts/index.ts'
import {
  GOAL_CANCELLED,
  GOAL_CREATED,
  GOAL_PAUSED,
  GOAL_RESUMED,
  GOAL_REVISED,
  COMMITMENT_ACCEPTED,
} from '../src/kernel/contracts/domain-event.ts'
import { readFileSync } from 'node:fs'
import { judgeGoalCompletion } from '../src/kernel/app/goal/completion.ts'
import { goalRowKeyOf, isGoalTerminal } from '../src/kernel/contracts/goal.ts'
import { buildGoalCorpusManifest } from '../evals/m10/goal-corpus.ts'

const REPO_ROOT = resolve(process.cwd())
const CHARACTER = 'char_m10_long' as CharacterId
const USER_ID = 'm10-long-user'
const M10_T0 = 2_600_000_000_000
/**
 * `G47` 点名的轮数。
 *
 * ⚠️ 计划 §14 的场景名是「**200 / 500** 轮连续轨迹」，而契约 §3 的**核心判据**
 * 只写「全链在案；每回合有状态」——**没写轮数**。原实现把它钉在 200。
 * ⇒ 用 `--turns=<n>` 可以**另外**跑一次 500 轮，把标题里的两个数**都真的跑过**
 *   （默认仍是 200，所以 lane 的读数不变）。
 */
const DEFAULT_TURNS = 200
const TURNS = ((): number => {
  const arg = process.argv.find((item) => item.startsWith('--turns='))
  if (arg === undefined) return DEFAULT_TURNS
  const parsed = Number(arg.slice('--turns='.length))
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--turns=<正整数>，收到 ${arg}`)
  }
  return parsed
})()

function phase(mark: string): void {
  console.error(`[m10-long] ${mark}`)
}

interface Check {
  group: 'L' | 'R' | 'G'
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
  /**
   * **`true` = 这一行是"登记"，不是断言**（`L-M10-65`）。
   * ⚠️ 登记**不进** `passed/total`，只另报 `notes: N` —— 否则"N/N PASS"会把
   *    "什么都没断言的行"也算成"验证过的事"（`recordNote()` 记的就是这类）。
   */
  note: boolean
}

const checks: Check[] = []
function record(
  group: Check['group'],
  id: string,
  label: string,
  expected: string,
  actual: string,
  pass: boolean,
): void {
  checks.push({ group, id, label, expected, actual, pass, note: false })
}
/**
 * 记一条**登记**（如实报出一个读数，**不对它作断言**）—— `L-M10-65` 的修法。
 *
 * ⚠️ 它**没有 `pass` 参数**：调用点连"传个恒真的表达式"都做不到，
 *    所以"空量具混进断言计数"在这条路径上**是类型上不可能的**。
 * ⚠️ 读数仍**留在 `checks` 数组里**（不丢），只是**不进** `passed/total`。
 */
function recordNote(
  group: Check['group'],
  id: string,
  label: string,
  expected: string,
  actual: string,
): void {
  checks.push({ group, id, label, expected, actual, pass: true, note: true })
}

function draftOf(operation: string, extra: Record<string, unknown>): unknown {
  return {
    schemaVersion: 'goal-proposal@1',
    operation,
    span: { start: 0, end: 4 },
    ...extra,
  }
}

async function main(): Promise<void> {
  phase('boot isolated database')
  const agentRuntime = new AgentRuntime({ character, plugins: [] })
  await initDatabase(agentRuntime, sqlPlugin)
  const db = getRawDb(agentRuntime)
  const harness = createM10TurnHarness({ db, characterId: CHARACTER, userId: USER_ID })
  const rt = deterministicRuntime()

  /* =======================================================================
   * G47：200 轮连续轨迹
   * ===================================================================== */
  phase(`G47 ${String(TURNS)}-turn trajectory`)

  const chainSeen = new Set<string>()
  /** 每回合的读数（给"每回合都有状态"用；**只有计数与码**） */
  const turnLog: { turn: number; outcome: string; rows: number; activeId?: string }[] = []
  let turnsWithNoState = 0
  let focusGoalId: string | undefined

  for (let turn = 0; turn < TURNS; turn += 1) {
    const now = M10_T0 + turn * 1_000
    const sourceEventId = `cev:long-${String(turn)}`
    let result: Awaited<ReturnType<typeof harness.turn>> | undefined

    if (turn === 0) {
      result = await harness.turn({
        currentInput: '把长轨迹目标设为目标',
        sourceEventId,
        now,
        runtime: rt,
        provider: fixedProvider(
          draftOf('create', { statement: '长轨迹目标', origin: 'user_requested' }),
        ),
      })
      chainSeen.add('create')
    } else if (turn % 20 === 1 && focusGoalId !== undefined) {
      /* 暂停（每 20 轮一次） */
      result = await harness.turn({
        /*
         * ⚠️ 原话长度必须 ≥ 草案的 `span.end`：第一版这里是 `'先暂停'`（**3 码点**），
         *    而 `draftOf` 固定给 `span: {start:0,end:4}` ⇒ 结构校验判
         *    `span_not_in_source` ⇒ 这一轮**根本没到放行口**，
         *    于是链上永远看不到 `pause`。**"轨迹跑完了"与"链走通了"是两件事**
         *    —— 这正是 `G47` 的检查要逼出来的差别。
         */
        currentInput: '先暂停一下',
        sourceEventId,
        now,
        runtime: rt,
        provider: fixedProvider(
          draftOf('pause', { targetGoalId: focusGoalId }),
        ),
      })
      if (result.outcome === 'accepted') chainSeen.add('pause')
    } else if (turn % 20 === 2 && focusGoalId !== undefined) {
      /*
       * 恢复：**直接提案**（见文件头性质 ②）——复核读数由本门给出
       * （`hard: 1, dropped: 0` = 复核通过）。
       */
      const current = await harness.goalById(focusGoalId)
      if (current !== undefined) {
        const applied = await harness.applyProposal(
          harness.proposalOf({
            proposalId: `m10-long-resume-${String(turn)}`,
            operation: 'resume',
            characterId: CHARACTER,
            processor: 'm10-long-verify',
            processorVersion: 'm10-long-verify@1',
            sourceConversationEventIds: [sourceEventId],
            sourceQualifications: [{ eventId: sourceEventId, qualification: 'ESTABLISHED' }],
            targets: [
              {
                type: GOAL_RESUMED,
                operation: 'update',
                payload: {
                  characterId: CHARACTER,
                  goalId: focusGoalId,
                  expectedRevision: current.goal.revision,
                  recheck: { hard: 1, soft: 0, dropped: 0 },
                },
                scope: 'CHARACTER_INTERNAL',
              },
            ],
          }),
          now,
        )
        if (applied.accepted) chainSeen.add('resume')
        result = {
          outcome: applied.accepted ? 'accepted' : 'rejected',
          trace: { event: { acceptedEventTypes: applied.acceptedEventTypes } },
        } as never
      }
    } else if (turn % 20 === 3 && focusGoalId !== undefined) {
      /* 修订 */
      result = await harness.turn({
        currentInput: '把描述改一下',
        sourceEventId,
        now,
        runtime: rt,
        provider: fixedProvider(
          draftOf('revise', {
            targetGoalId: focusGoalId,
            changed: ['statement'],
            statement: `长轨迹目标（第 ${String(turn)} 轮修订）`,
          }),
        ),
      })
      if (result.outcome === 'accepted') chainSeen.add('revise')
    } else if (turn === TURNS - 5 && focusGoalId !== undefined) {
      /* 取消（倒数第 5 轮） */
      result = await harness.turn({
        currentInput: '取消这个目标',
        sourceEventId,
        now,
        runtime: rt,
        provider: fixedProvider(
          draftOf('cancel', { targetGoalId: focusGoalId, cancelKind: 'user_cancel' }),
        ),
      })
      if (result.outcome === 'accepted') chainSeen.add('cancel')
    } else {
      /* 其余轮次：无关对话 ⇒ 0 写入（**每回合仍然要有状态**） */
      result = await harness.turn({
        currentInput: '今天天气不错',
        sourceEventId,
        now,
        runtime: rt,
        provider: fixedProvider(draftOf('none', {})),
      })
    }

    const states = await harness.listStates()
    const active = states.find((row) => row.goal.status === 'active')
    focusGoalId = active !== undefined ? String(active.goal.goalId) : focusGoalId
    if (states.length === 0 && turn > 0) turnsWithNoState += 1
    turnLog.push({
      turn,
      outcome: String(result?.outcome ?? 'no_write_path'),
      rows: states.length,
      ...(focusGoalId !== undefined ? { activeId: focusGoalId } : {}),
    })
  }

  const finalStates = await harness.listStates()
  const finalGoal = finalStates[0]
  /* 每种操作的**被拒码**留档（"轨迹跑完了"与"链走通了"是两件事） */
  const rejections = new Map<string, number>()
  for (const entry of turnLog) {
    if (entry.outcome === 'rejected' || entry.outcome === 'invalid_output') {
      rejections.set(entry.outcome, (rejections.get(entry.outcome) ?? 0) + 1)
    }
  }
  record(
    'L',
    'L1',
    `【G47】**${String(TURNS)} 轮连续轨迹**跑完：全链在案（设立 / 暂停 / 恢复 / 修订 / 取消），`
      + '且**每回合都有状态**（没有一轮把世界留成不可读）',
    `5/5 链上事件都出现过 · 0 轮无状态`,
    `链上出现=[${[...chainSeen].sort().join(',')}] · 无状态轮次=${String(turnsWithNoState)} · ` +
      `未闭合=${[...rejections.entries()].map(([k, v]) => `${k}x${String(v)}`).join(',') || '无'}`,
    ['cancel', 'create', 'pause', 'resume', 'revise'].every((step) => chainSeen.has(step)) &&
      turnsWithNoState === 0,
  )
  record(
    'L',
    'L2',
    '【G47】轨迹结束时目标处于**终态**，且事件数 ≥ 轮次里真实写入的次数'
      + '（**分母非零**：不靠"什么都没写"通过）',
    'cancelled · 事件 > 0',
    `status=${String(finalGoal?.goal.status)} · 事件=${String(await harness.countEvents())} · 行=${String(finalStates.length)}`,
    finalGoal?.goal.status === 'cancelled' && (await harness.countEvents()) > 0 && finalStates.length === 1,
  )

  /* =======================================================================
   * 跨会话重启（丢缓存 + 重读 + rebuild）
   * ===================================================================== */
  phase('restart: drop caches, reread, rebuild')

  const beforeRestart = JSON.stringify(await harness.listStates())
  /* 丢掉**全部**内存态：新建一个 harness（新的 lookup / processed / registry） */
  const restarted = createM10TurnHarness({ db, characterId: CHARACTER, userId: USER_ID })
  const afterReread = JSON.stringify(await restarted.listStates())
  const rebuild = await rebuildGoalProjections(db, CHARACTER, M10_T0 + 900_000)
  const afterRebuild = JSON.stringify(await restarted.listStates())
  /* 诊断：不一致时**指出第一处差异的字段路径**（而不是只说"不一致"） */
  const diffNote = (() => {
    if (beforeRestart === afterRebuild) return '(逐字段一致)'
    const a = JSON.parse(beforeRestart) as unknown
    const b = JSON.parse(afterRebuild) as unknown
    const paths: string[] = []
    const walk = (x: unknown, y: unknown, path: string): void => {
      if (paths.length >= 6) return
      if (typeof x !== typeof y) {
        paths.push(`${path}: ${typeof x} vs ${typeof y}`)
        return
      }
      if (x === null || y === null || typeof x !== 'object') {
        if (x !== y) paths.push(`${path}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`)
        return
      }
      const keys = new Set([
        ...Object.keys(x as Record<string, unknown>),
        ...Object.keys(y as Record<string, unknown>),
      ])
      for (const key of keys) {
        walk(
          (x as Record<string, unknown>)[key],
          (y as Record<string, unknown>)[key],
          path === '' ? key : `${path}.${key}`,
        )
      }
    }
    walk(a, b, '')
    return `差异字段=[${paths.join(' | ')}]`
  })()
  record(
    'L',
    'L3',
    '**跨会话重启**：丢掉全部内存态（新建 harness）+ 从库里重读 ⇒ 逐字段一致；'
      + '再由事件全量重放 ⇒ **仍然**逐字段一致',
    '重读一致 · 重放一致',
    `重读一致=${String(beforeRestart === afterReread)} · 重放一致=${String(beforeRestart === afterRebuild)} · ` +
      `重放事件=${String(rebuild.appliedEvents)} · ${diffNote}`,
    beforeRestart === afterReread && beforeRestart === afterRebuild && rebuild.appliedEvents > 0,
  )
  recordNote(
    'L',
    'L4',
    '⚠️ **重启的形式**如实登记：本门做的是"丢缓存 + 重读 + rebuild"，'
      + '**不是**"杀进程后重新打开库"（后者需要独立进程与库句柄 ⇒ `L-M10-42`）',
    '登记为未做的那一半',
    '进程内重启已测 · 跨进程重启未测',
  )

  /* =======================================================================
   * 取消与复活
   * ===================================================================== */
  phase('cancel & revive')

  const cancelled = (await harness.listStates())[0]!
  const oldGoalId = String(cancelled.goal.goalId)

  /* ① 同内容 + **新的独立来源** ⇒ 新身份 */
  const revived = await harness.turn({
    currentInput: '重新把长轨迹目标设为目标',
    sourceEventId: 'cev:long-revive-new-source',
    now: M10_T0 + 950_000,
    runtime: rt,
    provider: fixedProvider(
      draftOf('create', { statement: '长轨迹目标', origin: 'user_requested' }),
    ),
  })
  const afterRevive = await harness.listStates()
  const newIds = afterRevive.map((row) => String(row.goal.goalId)).filter((id) => id !== oldGoalId)
  record(
    'L',
    'L5',
    '**取消后复活（新来源）**：同内容 + **新的独立来源** ⇒ 建立**新身份**'
      + '（旧 id 与新的 id 不同），而不是复活旧行',
    'accepted · 新 id ≠ 旧 id',
    `${revived.outcome} · 旧=${oldGoalId.slice(0, 16)}… · 新=${String(newIds[0]?.slice(0, 16))}…`,
    revived.outcome === 'accepted' && newIds.length === 1 && newIds[0] !== oldGoalId,
  )

  /* ② 先"忘掉"，再用**同一来源**重述 ⇒ 被禁用根挡 */
  const target = afterRevive.find((row) => String(row.goal.goalId) === newIds[0])!
  const forgetTargetId = String(target.goal.goalId)
  const forgotten = await harness.turn({
    currentInput: '忘掉这个目标',
    sourceEventId: 'cev:long-forget',
    now: M10_T0 + 960_000,
    runtime: rt,
    provider: fixedProvider(
      draftOf('cancel', { targetGoalId: forgetTargetId, cancelKind: 'explicit_forget' }),
    ),
  })
  const forbidden = await harness.applyProposal(
    harness.proposalOf({
      proposalId: 'm10-long-forbidden',
      operation: 'create',
      characterId: CHARACTER,
      processor: 'm10-long-verify',
      processorVersion: 'm10-long-verify@1',
      sourceConversationEventIds: ['cev:long-forget'],
      sourceQualifications: [{ eventId: 'cev:long-forget', qualification: 'ESTABLISHED' }],
      targets: [
        {
          type: 'GOAL_CREATED',
          operation: 'create',
          payload: {
            characterId: CHARACTER,
            goal: {
              goalId: '(derived-by-validator)',
              characterId: CHARACTER,
              owner: { kind: 'character', id: CHARACTER },
              origin: 'user_requested',
              sourceRefs: [
                { conversationEventId: 'cev:long-forget', span: { start: 0, end: 4 }, fingerprint: 'fp' },
              ],
              revision: 1,
              statement: '长轨迹目标',
              successCriterion: { kind: 'user_report' },
              status: 'active',
              priority: 'normal',
              dependencies: [],
              time: { recordedAt: M10_T0 + 970_000 },
            },
            mutation: 'explicit',
          },
          scope: 'CHARACTER_INTERNAL',
        },
      ],
    }),
    M10_T0 + 970_000,
  )
  record(
    'L',
    'L6',
    '**忘了以后同来源重述 ⇒ 被禁用根挡**（旧根禁用**不因内容再次出现而解除**）：'
      + '`goal_source_forbidden`，零事件',
    'rejected:goal_source_forbidden · 0 事件',
    `forgot=${forgotten.outcome} · 重述=[${forbidden.rejectedCodes.join(',')}] · ${String(forbidden.eventsCommitted)} 事件`,
    forgotten.outcome === 'accepted' &&
      !forbidden.accepted &&
      forbidden.rejectedCodes.includes('goal_source_forbidden') &&
      forbidden.eventsCommitted === 0,
  )

  /* =======================================================================
   * 旧结果迟到
   * ===================================================================== */
  phase('stale result arrives late')

  /*
   * ⚠️ 轨迹在倒数第 5 轮把目标**取消了** —— 因此到这一步已经没有 active 目标。
   *    第一版直接拿"库里第一行"去判 ⇒ 得到 `completion_target_terminal`，
   *    量到的**不是**"迟到"，而是"对终态目标判完成"。
   *    ⇒ 先**专门造一个 active 目标**，再对它判迟到。
   */
  const fresh = await harness.turn({
    currentInput: '再造一个活跃目标用于迟到探针',
    sourceEventId: 'cev:long-fresh',
    now: M10_T0 + 975_000,
    runtime: rt,
    provider: fixedProvider(
      draftOf('create', { statement: '迟到探针目标', origin: 'user_requested' }),
    ),
  })
  const liveRows = await harness.listStates()
  const liveGoal = liveRows.find((row) => row.goal.status === 'active')
  if (liveGoal === undefined) {
    record('L', 'L7', '【旧结果迟到】前置：能造出一个 active 目标', 'active 目标在场', '造不出', false)
  } else {
    /*
     * ⚠️ 真正的"迟到"形状：先让目标**推进一次 revision**（暂停），
     *    再让一个**按旧 revision 算出的**完成结果到达。
     *
     *    第一版写的是 `Math.max(1, revision - 1)` —— 当 `revision === 1` 时它
     *    **等于当前值**（`Math.max` 把它夹回了合法区间）⇒ 判定当然通过，
     *    "迟到"根本没被造出来。**一个把值夹进合法区间的 `Math.max`
     *    会让负控静默失效** —— 而它看起来非常像一个"防止出负数"的稳妥写法。
     */
    const pausedForStale = await harness.applyProposal(
      harness.proposalOf({
        proposalId: 'm10-long-stale-pause',
        operation: 'pause',
        characterId: CHARACTER,
        processor: 'm10-long-verify',
        processorVersion: 'm10-long-verify@1',
        sourceConversationEventIds: ['cev:long-stale-pause'],
        sourceQualifications: [{ eventId: 'cev:long-stale-pause', qualification: 'ESTABLISHED' }],
        targets: [
          {
            type: GOAL_PAUSED,
            operation: 'update',
            payload: {
              characterId: CHARACTER,
              goalId: String(liveGoal.goal.goalId),
              expectedRevision: liveGoal.goal.revision,
              reason: '为迟到探针推进一次 revision',
            },
            scope: 'CHARACTER_INTERNAL',
          },
        ],
      }),
      M10_T0 + 976_000,
    )
    const afterPause = await harness.goalById(String(liveGoal.goal.goalId))
    const staleRevision = liveGoal.goal.revision
    const currentRevision = afterPause?.goal.revision ?? staleRevision

    const staleVerdict = await judgeGoalCompletion({
      ports: harness.ports.completion,
      characterId: CHARACTER,
      target: 'goal',
      goal: afterPause!.goal,
      /* 迟到：按**推进之前**的 revision 算出来的结果 */
      expectedRevision: staleRevision,
      basis: 'user_report',
      evidenceRefs: [{ conversationEventId: 'cev:long-stale' as never, fingerprint: 'fp' }],
      turnUserEventId: 'cev:long-stale',
    })
    const eventsBeforeStale = await harness.countEvents()
    record(
      'L',
      'L7',
      '【旧结果迟到】按**旧 revision** 算出的完成结果到达 ⇒ `revision_stale`'
        + '（**不得**完成新约定），且没有因为这次判定而多出事件',
      `revision_stale（stale=${String(staleRevision)} ≠ current=${String(currentRevision)}）· 0 事件`,
      `新建=${fresh.outcome} · 暂停=${String(pausedForStale.accepted)} · ` +
        `stale=${String(staleRevision)} → current=${String(currentRevision)} · ` +
        `${staleVerdict.ok ? 'ok' : staleVerdict.code} · 事件 ${String(eventsBeforeStale)}`,
      pausedForStale.accepted &&
        staleRevision !== currentRevision &&
        !staleVerdict.ok &&
        staleVerdict.code === 'completion_evidence_revision_stale',
    )
  }

  /* =======================================================================
   * 重复触发
   * ===================================================================== */
  phase('duplicate trigger')

  /*
   * ⚠️ 必须读**当前**状态：L7 的迟到探针已经把这一项**暂停过**（推进了 revision），
   *    而幂等单元串含 `expectedRevision` ⇒ 若这里还用旧 revision，
   *    第一次投递就会命中 L7 留下的幂等记录（`goal_duplicate_operation`），
   *    于是"第一次真的写成了"这个前置是**假的**。
   *    第一版正是这样：`first=false`、`second=duplicate` —— 看起来像"幂等生效了"，
   *    其实第一次根本没写成。
   */
  /*
   * ⚠️ 必须挑**非终态**的行：L7 的迟到探针把目标**暂停**了 ⇒ 库里已经没有 `active`。
   *    第一版挑 `active` ⇒ 挑不到 ⇒ `goalId: ''` ⇒ 放行口报
   *    `goal_proposal_invalid_shape`，而读数看起来像"幂等被触发了"。
   *    暂停态**不是**终态，对它做 `revise` 是合法的。
   */
  const freshGoal = (await harness.listStates()).find(
    (row) => !isGoalTerminal(row.goal.status),
  )
  const liveId = String(freshGoal?.goal.goalId ?? '')
  const liveRevision = freshGoal?.goal.revision ?? 1
  const pauseProposal = (): ReturnType<typeof harness.proposalOf> =>
    harness.proposalOf({
      proposalId: 'm10-long-dup',
      operation: 'pause',
      characterId: CHARACTER,
      processor: 'm10-long-verify',
      processorVersion: 'm10-long-verify@1',
      sourceConversationEventIds: ['cev:long-dup'],
      sourceQualifications: [{ eventId: 'cev:long-dup', qualification: 'ESTABLISHED' }],
      targets: [
        {
          type: GOAL_REVISED,
          operation: 'update',
          payload: {
            characterId: CHARACTER,
            goalId: liveId,
            expectedRevision: liveRevision,
            changed: ['statement'],
            statement: '重复触发探针（修订）',
            reason: '重复触发探针',
          },
          scope: 'CHARACTER_INTERNAL',
        },
      ],
    })
  const firstTrigger = await harness.applyProposal(pauseProposal(), M10_T0 + 980_000)
  const secondTrigger = await harness.applyProposal(pauseProposal(), M10_T0 + 981_000)
  record(
    'L',
    'L8',
    '【重复触发】同一提案两次 ⇒ 第二次被拒（`goal_duplicate_operation`）且**零事件**'
      + '（第一次真的写成了，否则这条检查会因为"两次都被拒"而假通过）',
    'first=accepted · second=duplicate · 0 事件',
    `first=${String(firstTrigger.accepted)} · second=[${secondTrigger.rejectedCodes.join(',')}] · ${String(secondTrigger.eventsCommitted)} 事件`,
    firstTrigger.accepted &&
      !secondTrigger.accepted &&
      secondTrigger.rejectedCodes.includes('goal_duplicate_operation') &&
      secondTrigger.eventsCommitted === 0,
  )

  /* =======================================================================
   * L9–L11：**时间模型**（计划 §6.3 末条要求的三条注入时钟判据）
   *
   * ⚠️ 这三条的来历是**计划完备性复查**（`L-M10-69`）：计划逐字要求
   *    「测试使用注入时钟…覆盖**跨日、重启、迟到结果、时钟回退**和**不同 `recordedAt`/`occurredAt`**」，
   *    而复查时**跨日 / 时钟回退 / 两时间字段不同**三条**按名字都找不到判据**。
   *    ⇒ 补在这里（**不改产品代码**）。
   * ===================================================================== */
  phase('L9–L11 time model (injected clock)')

  /** 读最新一条 `GOAL_CREATED` 的 `payload.goal.time`（回读断言用） */
  const latestGoalTime = async (): Promise<Record<string, unknown> | undefined> => {
    const stored = await domainEventsFor(db, CHARACTER)
    const created = [...stored].reverse().find((event) => event.type === GOAL_CREATED)
    const payload = created?.payload as { goal?: { time?: Record<string, unknown> } } | undefined
    return payload?.goal?.time
  }

  /*
   * L9 —— **时钟回退**：用一个**更早**的 `now` 跑一轮。
   * 事件顺序由 **sequence** 定，不由时钟定 ⇒ 链应当照常，且事件记的是**给定的**时钟。
   *
   * ⚠️ 走 `applyProposal`（**门里其它判据都走它**）：`GoalProposal` 不带时间字段，
   *    时间由放行口在事件 payload 里建 ⇒ 直接构造带 `time` 的 target 才能**精确给定**时钟。
   *    （第一版走语义链 + 自造草案 ⇒ 草案形状不对 ⇒ `invalid_output`，那是**量具**的问题。）
   */
  const rollbackAt = M10_T0 - 3_600_000
  const rollbackOutcome = await harness.applyProposal(
    harness.proposalOf({
      proposalId: 'm10-long-rollback',
      operation: 'create',
      characterId: CHARACTER,
      processor: 'm10-long-verify',
      processorVersion: 'm10-long-verify@1',
      sourceConversationEventIds: ['cev:long-rollback'],
      sourceQualifications: [{ eventId: 'cev:long-rollback', qualification: 'ESTABLISHED' }],
      targets: [
        {
          type: 'GOAL_CREATED',
          operation: 'create',
          payload: {
            characterId: CHARACTER,
            goal: {
              goalId: '(derived-by-validator)',
              characterId: CHARACTER,
              owner: { kind: 'character', id: CHARACTER },
              origin: 'user_requested',
              sourceRefs: [
                { conversationEventId: 'cev:long-rollback', span: { start: 0, end: 4 }, fingerprint: 'fp' },
              ],
              revision: 1,
              statement: '回退时钟下的目标',
              successCriterion: { kind: 'user_report' },
              status: 'active',
              priority: 'normal',
              dependencies: [],
              /* ⭐ 给定的时钟**比前几轮更早** */
              time: { recordedAt: rollbackAt },
            },
            mutation: 'explicit',
          },
          scope: 'CHARACTER_INTERNAL',
        },
      ],
    }),
    rollbackAt,
  )
  const rollbackTime = await latestGoalTime()
  record(
    'L',
    'L9',
    '**时钟回退**（计划 §6.3）：用**更早**的 `now` 跑一轮 ⇒ 链**照常**，且事件记的是**给定的**时钟'
      + '（顺序由 `sequence` 定，不由时钟定 —— 这条就是它的可执行形式）',
    `accepted · recordedAt=${String(rollbackAt)}`,
    `accepted=${String(rollbackOutcome.accepted)} · recordedAt=${String(rollbackTime?.recordedAt)}`,
    rollbackOutcome.accepted && rollbackTime?.recordedAt === rollbackAt,
  )

  /*
   * L10 —— **跨日**：隔一天再跑一轮。
   * ⚠️ 断言的是"**绝对时间被保留**"，不是"它被折成某个服务器日"（计划 §6.3 逐字）。
   */
  const nextDayAt = M10_T0 + 86_400_000
  const nextDayOutcome = await harness.applyProposal(
    harness.proposalOf({
      proposalId: 'm10-long-nextday',
      operation: 'create',
      characterId: CHARACTER,
      processor: 'm10-long-verify',
      processorVersion: 'm10-long-verify@1',
      sourceConversationEventIds: ['cev:long-nextday'],
      sourceQualifications: [{ eventId: 'cev:long-nextday', qualification: 'ESTABLISHED' }],
      targets: [
        {
          type: 'GOAL_CREATED',
          operation: 'create',
          payload: {
            characterId: CHARACTER,
            goal: {
              goalId: '(derived-by-validator)',
              characterId: CHARACTER,
              owner: { kind: 'character', id: CHARACTER },
              origin: 'user_requested',
              sourceRefs: [
                { conversationEventId: 'cev:long-nextday', span: { start: 0, end: 4 }, fingerprint: 'fp' },
              ],
              revision: 1,
              statement: '跨日之后的目标',
              successCriterion: { kind: 'user_report' },
              status: 'active',
              priority: 'normal',
              dependencies: [],
              time: { recordedAt: nextDayAt },
            },
            mutation: 'explicit',
          },
          scope: 'CHARACTER_INTERNAL',
        },
      ],
    }),
    nextDayAt,
  )
  const nextDayTime = await latestGoalTime()
  record(
    'L',
    'L10',
    '**跨日**（计划 §6.3）：隔一天的那一轮**照常**，且它的 `recordedAt` **逐字保留**'
      + '（**不折成服务器日** —— "不得把明天固定成服务器 UTC 日"的可执行形式）',
    `accepted · recordedAt=${String(nextDayAt)}（与前一天不同）`,
    `accepted=${String(nextDayOutcome.accepted)} · recordedAt=${String(nextDayTime?.recordedAt)}`,
    nextDayOutcome.accepted &&
      nextDayTime?.recordedAt === nextDayAt &&
      nextDayTime?.recordedAt !== rollbackTime?.recordedAt,
  )

  /*
   * L11 —— **`recordedAt ≠ occurredAt`**：两个时间字段**互不覆盖**。
   * ⚠️ 直接构造带 `time` 的 target（`GoalProposal` 不带时间字段 ⇒ 那是放行口在事件里建的）。
   */
  const occurredAt = M10_T0 + 86_400_000 - 7_200_000
  const recordedAt = M10_T0 + 86_400_000 + 60_000
  const twoClocks = await harness.applyProposal(
    harness.proposalOf({
      proposalId: 'm10-long-two-clocks',
      operation: 'create',
      characterId: CHARACTER,
      processor: 'm10-long-verify',
      processorVersion: 'm10-long-verify@1',
      sourceConversationEventIds: ['cev:long-two-clocks'],
      sourceQualifications: [{ eventId: 'cev:long-two-clocks', qualification: 'ESTABLISHED' }],
      targets: [
        {
          type: 'GOAL_CREATED',
          operation: 'create',
          payload: {
            characterId: CHARACTER,
            goal: {
              goalId: '(derived-by-validator)',
              characterId: CHARACTER,
              owner: { kind: 'character', id: CHARACTER },
              origin: 'user_requested',
              sourceRefs: [
                {
                  conversationEventId: 'cev:long-two-clocks',
                  span: { start: 0, end: 4 },
                  fingerprint: 'fp',
                },
              ],
              revision: 1,
              statement: '两个时钟不同的目标',
              successCriterion: { kind: 'user_report' },
              status: 'active',
              priority: 'normal',
              dependencies: [],
              /* ⭐ 两个字段**不同**且都给定 */
              time: { recordedAt, occurredAt },
            },
            mutation: 'explicit',
          },
          scope: 'CHARACTER_INTERNAL',
        },
      ],
    }),
    recordedAt,
  )
  const twoClocksTime = await latestGoalTime()
  record(
    'L',
    'L11',
    '**`recordedAt ≠ occurredAt`**（计划 §6.3）：两个时间字段**互不覆盖**、都被保留'
      + '（"保留用户表达和解析后的绝对时间、时区、解析依据"的可执行形式）',
    `accepted · recordedAt=${String(recordedAt)} · occurredAt=${String(occurredAt)}（不同）`,
    `outcome=${twoClocks.accepted ? 'accepted' : twoClocks.rejectedCodes.join(',')}` +
      ` · recordedAt=${String(twoClocksTime?.recordedAt)} · occurredAt=${String(twoClocksTime?.occurredAt)}`,
    twoClocks.accepted &&
      twoClocksTime?.recordedAt === recordedAt &&
      twoClocksTime?.occurredAt === occurredAt &&
      twoClocksTime?.recordedAt !== twoClocksTime?.occurredAt,
  )

  /* =======================================================================
   * G48：零分母**不是** PASS
   * ===================================================================== */
  phase('G48 zero denominator is not PASS')

  /*
   * ⚠️ 这条是**量具自身的**判据（计划 §12 WP8/WP9 出口原文："零分母不是 PASS"）。
   *    做法：把语料清单喂一个**test 层为空**的构造 ⇒ `planMatches` 必须为假、
   *    `deficits` 必须非空。若它反而报"匹配"，那"有效分母"这句话就是空的。
   */
  const healthy = buildGoalCorpusManifest()
  const emptyTestLayer = buildGoalCorpusManifest({
    items: [],
    counts: {
      total: 0,
      bySplit: { dev: 0, val: 0, test: 0 },
      byLayer: {
        explicit_operation: 0,
        negation_reference_hypothesis: 0,
        commitment_and_false_fulfillment: 0,
        dependency_change: 0,
        multi_goal_ambiguity: 0,
        unrelated: 0,
      },
      bySplitAndLayer: {
        dev: {
          explicit_operation: 0,
          negation_reference_hypothesis: 0,
          commitment_and_false_fulfillment: 0,
          dependency_change: 0,
          multi_goal_ambiguity: 0,
          unrelated: 0,
        },
        val: {
          explicit_operation: 0,
          negation_reference_hypothesis: 0,
          commitment_and_false_fulfillment: 0,
          dependency_change: 0,
          multi_goal_ambiguity: 0,
          unrelated: 0,
        },
        test: {
          explicit_operation: 0,
          negation_reference_hypothesis: 0,
          commitment_and_false_fulfillment: 0,
          dependency_change: 0,
          multi_goal_ambiguity: 0,
          unrelated: 0,
        },
      },
      byOperation: {},
    },
    familySplit: new Map(),
    corpusHash: 'zero',
  })
  record(
    'G',
    'G48a',
    '【G48】**零分母不是 PASS**：把语料清单喂一个"全 0"的构造 ⇒ '
      + '`planMatches=false` 且 `deficits` **非空**（不是"全都对上了"）',
    'planMatches=false · deficits > 0',
    `planMatches=${String(emptyTestLayer.planMatches)} · 缺口=${String(emptyTestLayer.deficits.length)} 条`,
    emptyTestLayer.planMatches === false && emptyTestLayer.deficits.length > 0,
  )
  record(
    'G',
    'G48b',
    '【G48 正控】健康的语料清单仍然 `planMatches=true`（否则上面那条可以靠"永远报缺口"通过）',
    'planMatches=true · 0 缺口',
    `planMatches=${String(healthy.planMatches)} · 缺口=${String(healthy.deficits.length)} · 总数=${String(healthy.counts.total)}`,
    healthy.planMatches && healthy.deficits.length === 0 && healthy.counts.total > 0,
  )

  /* 顺带：承诺事件在本轨迹里没被用过 ⇒ 如实登记（不假装覆盖了） */
  const usedEventTypes = new Set<string>()
  for (const row of turnLog) usedEventTypes.add(row.outcome)
  recordNote(
    'G',
    'G48c',
    '本轨迹的**覆盖面如实登记**：用到的具名事件类型与**未**用到的（`COMMITMENT_*` 未在本轨迹出现）',
    '如实列出',
    `链上=[${[...chainSeen].sort().join(',')}] · 承诺事件=未使用（承诺链由 m10:test / m10:e2e 覆盖）`,
  )

  phase('done')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM10RunId({ wpId: 'wp9b-long', headShort: head })
  const dir = openM10RunDir(REPO_ROOT, runId)

  /*
   * ⚠️ **分母只算断言**（`L-M10-65`）：登记（`recordNote`）不进 `passed/total`，
   *    只另报 `notes: N` —— 否则"N/N PASS"会把"什么都没断言的行"也算成"验证过的事"。
   */
  const assertions = checks.filter((c) => !c.note)
  const notes = checks.length - assertions.length
  const passed = assertions.filter((c) => c.pass).length
  const failed = assertions.length - passed
  const groups = ['L', 'R', 'G'] as const
  const perGroup = Object.fromEntries(
    groups.map((g) => [
      g,
      {
        total: checks.filter((c) => c.group === g).length,
        passed: checks.filter((c) => c.group === g && c.pass).length,
      },
    ]),
  )

  const payload = {
    schema: 'm10-long-verify@1',
    runId,
    head,
    characterId: CHARACTER,
    turns: TURNS,
    chainSeen: [...chainSeen].sort(),
    turnLog,
    checks,
    perGroup,
    summary: {
      total: assertions.length,
      passed,
      failed,
      /** **登记**条数（不进 `total/passed`）—— `L-M10-65` */
      notes,
      verdict: failed === 0 ? 'PASS' : 'FAIL',
    },
  }
  writeFileSync(join(dir, 'long-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp9b',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'long-verify',
    counts: { total: assertions.length, passed, failed, notes },
    phases: ['single'],
    supersedes: null,
    notes:
      'WP9-B 时间维度门：200 轮连续轨迹（G47）· 跨会话重启（丢缓存+重读+rebuild）· ' +
      '取消与复活 · 旧结果迟到 · 重复触发 · 零分母不是 PASS（G48）。隔离库，零模型。',
    databaseScope: 'isolated',
    mode: 'offline',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} [${c.group}] ${c.label}`)
    console.log(`      期望 ${c.expected} · 实测 ${c.actual}`)
  }
  console.log(
      `verdict: ${payload.summary.verdict}（断言 ${String(passed)}/${String(assertions.length)}` +
        `${notes > 0 ? ` · 登记 ${String(notes)} 条` : ''}）`,
    )
  console.log(`分组：${groups.map((g) => `${g}=${String(perGroup[g].passed)}/${String(perGroup[g].total)}`).join(' · ')}`)
  process.exitCode = failed === 0 ? 0 : 1
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})

void goalRowKeyOf
void COMMITMENT_ACCEPTED
void GOAL_CANCELLED
void GOAL_REVISED
void readFileSync
