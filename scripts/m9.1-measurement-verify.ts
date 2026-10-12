/**
 * M9.1 WP2 —— 量具与负控集中门（`pnpm m9.1:measurement:verify`）。
 *
 * ============================================================================
 *  为什么必须单独做一遍（沿 `verify-m5.1-measurement.ts` 范式，AGENTS §6.7）
 * ============================================================================
 * R/P 矩阵的每行断言都由检测器承载。检测器没被验证过 = 验收读数不可信：
 *
 *      ① 正控：合法输入 → 检测器必须**安静**（否则它是噪音源）
 *      ② 负控：注入缺陷现象 → 检测器必须**响**（否则它是橡皮图章）
 *      ③ 恢复：放回合法输入 → 检测器必须**重新安静**
 *
 * M9.1 的特殊性：**缺陷现在就在**（WP0 基线 14/14）——所以「负控」不需要人为
 * 制造缺陷现象，直接用真实缺陷状态（F-4 四层分歧 / F-1 Recent 泄漏）就是最硬的
 * 负控；「正控」用既有正确路径（首次 remember / ACTIVE 重复的诚实拒绝 / 无被撤值的
 * packet）。修复（WP3/WP4）之后，本门的负控段改由「故意去掉遮蔽/投影变更」模拟
 * （契约 §4 measurement 行的破坏段），正控段不变。
 *
 * 覆盖的检测器（契约 §0 判定分层）：
 *   · `detectResponseTruthDivergence`  —— F-4 四层 oracle
 *   · `detectWithdrawnLeak`            —— F-1 最终 prompt oracle
 *   · `withdrawnSetCore`               —— D16/D17 撤销集参考语义（含失败关闭分级）
 *   · `detectReplayDivergence`         —— R07/R08 A==B oracle
 *
 * 计数自检（AGENTS §6.8）：每个计数型检测器断言 `measured_count > 0`——
 * 「检查了 0 项、发现 0 处不一致」必须是 INVALID，不是 PASS。
 *
 * 证据：`artifacts/m9.1/<runId>/measurement.json`；隔离库，真实库从未被打开。
 */
import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m9.1-measurement', { keep: false })

import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'
import { rebuildMemory } from '../src/infrastructure/persistence/memory-store.ts'
import { buildContextCompilerV2 } from '../src/kernel/context/sections.ts'
import { asCharacterId } from '../src/kernel/contracts/ids.ts'
import { M4_T0 } from './m4-harness.ts'
import {
  computeWithdrawnSet,
  detectReplayDivergence,
  detectResponseTruthDivergence,
  detectWithdrawnLeak,
  openScenario,
  withdrawnSetCore,
  type FourLayerReadings,
  type WithdrawnRecordInput,
} from './m9.1-fixtures.ts'

/** 一条三段式读数 */
interface Probe {
  id: string
  part: 'positive' | 'negative' | 'restore'
  name: string
  /** 本段预期：正控/恢复 = 检测器安静；负控 = 检测器必响 */
  expectQuiet: boolean
  findings: string[]
  ok: boolean
  detail: string
}
const probes: Probe[] = []
function probe(id: string, part: Probe['part'], name: string, expectQuiet: boolean, findings: string[], detail: string): void {
  const ok = expectQuiet ? findings.length === 0 : findings.length > 0
  probes.push({ id, part, name, expectQuiet, findings, ok, detail })
  console.log(`  ${ok ? '✅' : '❌'} [${part}] ${name} :: ${detail}`)
}

async function main(): Promise<void> {
  console.log('\n=== M9.1 量具三段式验证（正控安静 / 负控必响 / 恢复再安静） ===')

  // =========================================================================
  console.log('\n--- 检测器①：F-4 四层分歧（detectResponseTruthDivergence） ---')
  // =========================================================================
  /*
   * ⚠️ 槽位事实（本门开发期实测）：「技术问题我喜欢详细解释」与「闲聊的时候我喜欢
   * 简短回答」在规则抽取器下是**同一 canonical 槽**（同 subject+predicate，qualifier
   * 不进槽位键）⇒ 同库时 B1 会把 A1 标 disputed（D-55c 矛盾），污染整条 A 链。
   * A 序列与 B 序列必须各用独立 rig（WP0 基线正是这么躲开的）。
   */
  {
    const rig = await openScenario('measurement-f4a')
    try {
      /* 正控：首次 remember —— 四层全一致（ok + active + 可召回） */
      const A1 = await rig.say('记住，技术问题我喜欢详细解释')
      const a1id = A1.outcome?.ok ? String(A1.outcome.memoryId) : '(none)'
      const recordA1 = await rig.h.store.get(a1id as never)
      const recallA1 = await rig.recall('技术问题你喜欢怎么解释')
      const readingsA1: FourLayerReadings = {
        outcomeOk: A1.outcome?.ok === true,
        foldedStatus: recordA1 == null ? undefined : String(recordA1.status),
        recallable: recallA1.selected.includes(a1id),
        turnKind: A1.turn?.kind,
      }
      probe(
        'F4-P1',
        'positive',
        '正控：首次 remember 四层一致 → 检测器安静',
        true,
        detectResponseTruthDivergence(readingsA1),
        `ok=${String(readingsA1.outcomeOk)} status=${String(readingsA1.foldedStatus)} recallable=${String(readingsA1.recallable)} turn=${String(readingsA1.turnKind)}`
      )

      /*
       * 负控（合成注入）：检测器是**纯函数**（四层读数 → 分歧），假象的正确
       * 注入方式是直接构造缺陷形状的读数——「ok:true + retracted + written」
       * （WP0 场景 A 实测到的预修复形状）。
       * ⚠️ 不能再用真实 rig 流注（WP2 时的做法）：WP3 的 D08 修复让 off 档
       * 重述**诚实报** write_not_effective（ok=false + not_written）——预修复
       * 的「假成功」缺陷已无法通过开关复现（这是修复的设计内行为变化，
       * 见验收契约 §6 修正记录）。检测器对诚实失败安静是**正确**的。
       */
      const defectReadings: FourLayerReadings = {
        outcomeOk: true,
        foldedStatus: 'retracted',
        recallable: false,
        turnKind: 'written',
      }
      const f4Findings = detectResponseTruthDivergence(defectReadings)
      probe(
        'F4-N1',
        'negative',
        '负控（合成注入）：缺陷形状读数（ok+retracted+written）→ 检测器必响',
        false,
        f4Findings,
        `合成读数 ok=true status=retracted recallable=false turn=written ⇒ ${String(f4Findings.length)} 条分歧`
      )

      /* 正控（真实 rig，WP3 之后的语义）：off 档重述诚实失败 → 检测器安静（D08 钉住） */
      const A2 = await rig.say('忘掉技术问题详细解释那个偏好')
      const A3 = await rig.say('记住，技术问题我喜欢详细解释')
      const recordA3 = await rig.h.store.get(a1id as never)
      const recallA3 = await rig.recall('技术问题你喜欢怎么解释')
      const readingsA3: FourLayerReadings = {
        outcomeOk: A3.outcome?.ok === true,
        foldedStatus: recordA3 == null ? undefined : String(recordA3.status),
        recallable: recallA3.selected.includes(a1id),
        turnKind: A3.turn?.kind,
      }
      probe(
        'F4-P3',
        'positive',
        '正控：off 档重述诚实失败（write_not_effective，D08）→ 检测器安静',
        true,
        detectResponseTruthDivergence(readingsA3),
        `ok=${String(readingsA3.outcomeOk)} status=${String(readingsA3.foldedStatus)} recallable=${String(readingsA3.recallable)} turn=${String(readingsA3.turnKind)}（诚实失败不是假成功——R02⑤ 契约行为）`
      )

      /* 恢复：换一条全新记忆（不同槽位；合法输入回来）→ 重新安静 */
      const C1 = await rig.say('记住，我不吃香菜')
      const c1id = C1.outcome?.ok ? String(C1.outcome.memoryId) : '(none)'
      const recordC1 = await rig.h.store.get(c1id as never)
      const recallC1 = await rig.recall('我吃不吃香菜')
      const readingsC1: FourLayerReadings = {
        outcomeOk: C1.outcome?.ok === true,
        foldedStatus: recordC1 == null ? undefined : String(recordC1.status),
        recallable: recallC1.selected.includes(c1id),
        turnKind: C1.turn?.kind,
      }
      probe(
        'F4-R1',
        'restore',
        '恢复：全新合法 remember（不同槽位）→ 检测器重新安静',
        true,
        detectResponseTruthDivergence(readingsC1),
        `ok=${String(readingsC1.outcomeOk)} status=${String(readingsC1.foldedStatus)} recallable=${String(readingsC1.recallable)} turn=${String(readingsC1.turnKind)}`
      )

      /* 计数自检：检测器确实量到了东西（不是空转） */
      const measured = probes.filter((p) => p.id.startsWith('F4-')).length
      probe(
        'F4-M1',
        'positive',
        '计数自检：四层检测器 measured_count > 0',
        true,
        measured > 0 ? [] : ['measured_count=0：四层检测器没有量到任何输入'],
        `measured_count=${String(measured)}`
      )

      /*
       * 撤销集正控（真实 DB）：场景 A 的 retracted 记录 ⇒ 撤销集含其来源事件
       * （这是 F-1 纯核在真实数据上的正控，也是 WP4 端口的对照读数）
       */
      const withdrawn = await computeWithdrawnSet(rig.h)
      const a1Sources = (await rig.h.store.get(a1id as never))?.sourceRefs.map((r) => r.id) ?? []
      const containsA1Sources = a1Sources.every((id) => withdrawn.withdrawnEventIds.includes(id))
      probe(
        'WS-P1',
        'positive',
        '正控：真实 DB 撤销集含 retracted 记录的来源事件（measured_count>0）',
        true,
        withdrawn.measuredCount > 0 && containsA1Sources
          ? []
          : [`measuredCount=${String(withdrawn.measuredCount)} containsA1Sources=${String(containsA1Sources)}`],
        `measured=${String(withdrawn.measuredCount)} 被撤事件=${String(withdrawn.withdrawnEventIds.length)} 缺口=[${withdrawn.gaps.join(';')}]`
      )
    } finally {
      await rig.dispose()
    }
  }
  {
    /* B 序列独立库：ACTIVE 重复的诚实拒绝（与 A 槽隔离——见上 ⚠️） */
    const rig = await openScenario('measurement-f4b')
    try {
      const B1 = await rig.say('记住，闲聊的时候我喜欢简短回答')
      const B2 = await rig.say('记住，闲聊的时候我喜欢简短回答')
      const b1id = B1.outcome?.ok ? String(B1.outcome.memoryId) : '(none)'
      const recordB = await rig.h.store.get(b1id as never)
      const readingsB: FourLayerReadings = {
        outcomeOk: B2.outcome?.ok === true,
        foldedStatus: recordB == null ? undefined : String(recordB.status),
        recallable: true,
        turnKind: B2.turn?.kind,
      }
      probe(
        'F4-P2',
        'positive',
        '正控：ACTIVE 重复 already_applied（诚实拒绝）→ 检测器安静',
        true,
        detectResponseTruthDivergence(readingsB),
        `ok=${String(readingsB.outcomeOk)} turn=${String(readingsB.turnKind)}（already_applied 是如实表达，不是假成功）`
      )
    } finally {
      await rig.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- 检测器②：F-1 泄漏（detectWithdrawnLeak）+ 撤销集纯核（withdrawnSetCore） ---')
  // =========================================================================
  {
    const rig = await openScenario('measurement-f1')
    try {
      const compiler = buildContextCompilerV2({
        identity: rig.h.kernel.identitySnapshot,
        definition: rig.h.kernel.definition,
      })
      const withdrawnValue = '技术问题我喜欢详细解释'
      const withdrawnLine = {
        id: 'cev_w_1' as never,
        sequence: 41,
        speaker: '用户',
        text: `记住，${withdrawnValue}`,
        actorType: 'user' as const,
      }
      const forgetLine = {
        id: 'cev_f_1' as never,
        sequence: 42,
        speaker: '用户',
        text: '忘掉技术问题详细解释那个偏好',
        actorType: 'user' as const,
      }
      const unrelatedLine = {
        id: 'cev_u_1' as never,
        sequence: 43,
        speaker: '用户',
        text: '记住，我周三体检',
        actorType: 'user' as const,
      }

      /* 正控：无被撤行的 packet → 泄漏检测器安静 */
      const cleanPacket = await compiler.compile({
        characterId: asCharacterId(rig.h.characterId),
        currentInput: '我周三干什么？',
        currentEventId: 'cev_q_1' as never,
        recentEvents: [unrelatedLine],
        now: M4_T0 + 30_000,
      })
      probe(
        'LK-P1',
        'positive',
        '正控：无被撤值的 packet → 泄漏检测器安静',
        true,
        detectWithdrawnLeak(cleanPacket.text, [withdrawnValue]),
        `packet 含被撤值=false（无关内容「我周三体检」仍在=${String(cleanPacket.text.includes('我周三体检'))}）`
      )

      /* 负控：被撤行在场（真实泄漏通道，WP0 D-1 同构）→ 必响 */
      const leakPacket = await compiler.compile({
        characterId: asCharacterId(rig.h.characterId),
        currentInput: '让我忘的具体是什么？',
        currentEventId: 'cev_q_2' as never,
        recentEvents: [withdrawnLine, forgetLine],
        now: M4_T0 + 30_000,
      })
      const leakFindings = detectWithdrawnLeak(leakPacket.text, [withdrawnValue])
      probe(
        'LK-N1',
        'negative',
        '负控：被撤行在场（真实泄漏）→ 泄漏检测器必响',
        false,
        leakFindings,
        `packet 含被撤值=${String(leakFindings.length > 0)}（这就是 F-1 的机械通道）`
      )

      /* 恢复：去掉被撤行 → 重新安静 */
      const restoredPacket = await compiler.compile({
        characterId: asCharacterId(rig.h.characterId),
        currentInput: '让我忘的具体是什么？',
        currentEventId: 'cev_q_3' as never,
        recentEvents: [unrelatedLine, forgetLine],
        now: M4_T0 + 30_000,
      })
      probe(
        'LK-R1',
        'restore',
        '恢复：去掉被撤行 → 检测器重新安静',
        true,
        detectWithdrawnLeak(restoredPacket.text, [withdrawnValue]),
        `遗忘行本身仍在=${String(restoredPacket.text.includes('忘掉技术问题'))}（遗忘指令可见是正常的——被撤的是取值内容）`
      )

      /* 撤销集纯核负控①：reason 不可得 ⇒ 最宽遮蔽 + 具名缺口（不静默） */
      const orphanRefs = [{ kind: 'conversation_event' as const, id: 'cev_orphan_1' }]
      const coreNoReason = withdrawnSetCore({
        retracted: [{ id: 'mem_x1', canonicalKey: 'slot_x', sourceRefs: orphanRefs }],
        reasonById: new Map([['mem_x1', undefined]]),
        supersededBySlot: new Map(),
      })
      probe(
        'WS-N1',
        'negative',
        '负控：reason 不可得 ⇒ 按 forget 最宽处理 + 缺口具名（失败关闭分级）',
        false,
        coreNoReason.gaps,
        `gaps=${String(coreNoReason.gaps.length)} 被撤事件=${String(coreNoReason.withdrawnEventIds.length)}（cev_orphan_1 在集=${String(coreNoReason.withdrawnEventIds.includes('cev_orphan_1'))}）`
      )

      /* 撤销集纯核负控②：孤儿（零 sourceRefs）⇒ 零贡献 + 具名缺口，不伪装覆盖 */
      const coreOrphan = withdrawnSetCore({
        retracted: [{ id: 'mem_x2', canonicalKey: 'slot_y', sourceRefs: [] }],
        reasonById: new Map([['mem_x2', 'explicit_forget']]),
        supersededBySlot: new Map(),
      })
      probe(
        'WS-N2',
        'negative',
        '负控：孤儿记录（零来源）⇒ 缺口具名，不伪装已覆盖',
        false,
        coreOrphan.gaps,
        `gaps=[${coreOrphan.gaps.join(';')}] 被撤事件=${String(coreOrphan.withdrawnEventIds.length)}（零贡献如实可见）`
      )

      /* 撤销集正控②：forget ⇒ 同槽 superseded 链并入（T11 整段偏好史） */
      const forgetRefs = [{ kind: 'conversation_event' as const, id: 'cev_fg_1' }]
      const chainRefs = [{ kind: 'conversation_event' as const, id: 'cev_ch_1' }]
      const coreChain = withdrawnSetCore({
        retracted: [{ id: 'mem_fg', canonicalKey: 'slot_z', sourceRefs: forgetRefs }],
        reasonById: new Map([['mem_fg', 'explicit_forget']]),
        supersededBySlot: new Map([['slot_z', [{ id: 'mem_ch', canonicalKey: 'slot_z', sourceRefs: chainRefs }]]]),
      })
      probe(
        'WS-P2',
        'positive',
        '正控：explicit_forget ⇒ 同槽 superseded 链来源并入撤销集（T11）',
        true,
        coreChain.withdrawnEventIds.includes('cev_fg_1') && coreChain.withdrawnEventIds.includes('cev_ch_1') && coreChain.ok
          ? []
          : [`fg=${String(coreChain.withdrawnEventIds.includes('cev_fg_1'))} chain=${String(coreChain.withdrawnEventIds.includes('cev_ch_1'))} ok=${String(coreChain.ok)}`],
        `被撤事件=${String(coreChain.withdrawnEventIds.length)}（含链来源 cev_ch_1）`
      )

      /* 撤销集正控③：explicit_correction ⇒ 仅自身来源（T17 更正史保留） */
      const coreCorrection = withdrawnSetCore({
        retracted: [{ id: 'mem_cr', canonicalKey: 'slot_z', sourceRefs: forgetRefs }],
        reasonById: new Map([['mem_cr', 'explicit_correction']]),
        supersededBySlot: new Map([['slot_z', [{ id: 'mem_ch', canonicalKey: 'slot_z', sourceRefs: chainRefs }]]]),
      })
      probe(
        'WS-P3',
        'positive',
        '正控：explicit_correction ⇒ 仅自身来源，链不并入（T17/P07）',
        true,
        coreCorrection.withdrawnEventIds.includes('cev_fg_1') && !coreCorrection.withdrawnEventIds.includes('cev_ch_1')
          ? []
          : [`自身=${String(coreCorrection.withdrawnEventIds.includes('cev_fg_1'))} 链被并入=${String(coreCorrection.withdrawnEventIds.includes('cev_ch_1'))}`],
        `被撤事件=${String(coreCorrection.withdrawnEventIds.length)}（链来源 cev_ch_1 不在集 = 更正史保留）`
      )

      /*
       * 计数自检说明：撤销集纯核的 measured_count>0 已由 WS-P1 在 F4a 库（真实
       * retracted 记录）证明；本库（F1 组）没有遗忘流，measured=0 是**如实读数**，
       * 不在此重复断言（恒真断言 = 空转，AGENTS §6.8 明令禁止）。
       */
    } finally {
      await rig.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- 检测器③：重放分歧（detectReplayDivergence，R07/R08 oracle） ---')
  // =========================================================================
  {
    const rig = await openScenario('measurement-replay')
    try {
      const A1 = await rig.say('记住，技术问题我喜欢详细解释')
      const a1id = A1.outcome?.ok ? String(A1.outcome.memoryId) : '(none)'
      await rig.say('忘掉技术问题详细解释那个偏好')

      /* 正控：retracted 记录的 A==B（在线 == 重放）→ 安静 */
      const rebuilt = await rebuildMemory(rig.h.db, a1id as never)
      probe(
        'RP-P1',
        'positive',
        '正控：retracted 记录 rebuild A==B → 检测器安静',
        true,
        detectReplayDivergence(rebuilt, 'retracted'),
        `equal=${String(rebuilt.equal)} status=${String(rebuilt.after?.status)}`
      )

      /* 负控：直接篡改投影行（模拟「在线 ≠ 重放」）→ 必响 */
      await rig.h.db.execute(sql`update memory_records set status = 'active' where id = ${a1id}`)
      const corrupted = await rebuildMemory(rig.h.db, a1id as never)
      const rpFindings = detectReplayDivergence(corrupted, 'retracted')
      probe(
        'RP-N1',
        'negative',
        '负控：篡改投影行（注入在线≠重放）→ 检测器必响',
        false,
        rpFindings,
        `equal=${String(corrupted.equal)} findings=${String(rpFindings.length)}（rebuild 比对非空转的证明）`
      )

      /*
       * 恢复：把篡改行修回合法状态（rebuild 只在 equal 时对齐写回，修不回来），
       * 再 rebuild → 重新安静。这才是真「恢复」——上一版用另一条记录冒充恢复，
       * 结果篡改行（active）污染了后续 remember 的冲突判定（MARK_DISPUTED）。
       */
      await rig.h.db.execute(sql`update memory_records set status = 'retracted' where id = ${a1id}`)
      const repaired = await rebuildMemory(rig.h.db, a1id as never)
      probe(
        'RP-R1',
        'restore',
        '恢复：修复篡改行后 rebuild → 检测器重新安静',
        true,
        detectReplayDivergence(repaired, 'retracted'),
        `equal=${String(repaired.equal)} status=${String(repaired.after?.status)}（投影回到与事件流一致）`
      )
    } finally {
      await rig.dispose()
    }
  }

  // =========================================================================
  // 汇总 + 证据落盘
  // =========================================================================
  const { resetPluginSqlConnection } = await import('../src/dev/sandbox.ts')
  await resetPluginSqlConnection()

  const byPart = (part: Probe['part']) => probes.filter((p) => p.part === part)
  const positiveOk = byPart('positive').every((p) => p.ok)
  const negativeOk = byPart('negative').every((p) => p.ok)
  const restoreOk = byPart('restore').every((p) => p.ok)
  const allOk = positiveOk && negativeOk && restoreOk

  const head = execSync('git rev-parse --short=12 HEAD', { encoding: 'utf8' }).trim()
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const dir = join(process.cwd(), 'artifacts', 'm9.1', `measurement-${date}-${head}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'measurement.json'),
    JSON.stringify(
      {
        instrument: 'm9.1-measurement-verify@1',
        kind: 'instrument-three-part-validation',
        head,
        date,
        isolation: '每检测器组独立 isolateDatabase(keep:false)',
        parts: {
          positive: { total: byPart('positive').length, ok: byPart('positive').filter((p) => p.ok).length },
          negative: { total: byPart('negative').length, ok: byPart('negative').filter((p) => p.ok).length },
          restore: { total: byPart('restore').length, ok: byPart('restore').filter((p) => p.ok).length },
        },
        probes,
        verdict: allOk ? 'MEASUREMENT VALID' : 'MEASUREMENT INVALID',
      },
      null,
      2
    ),
    'utf8'
  )

  console.log(`\n=== 汇总 ===`)
  console.log(`正控 ${String(byPart('positive').filter((p) => p.ok).length)}/${String(byPart('positive').length)} 安静 · 负控 ${String(byPart('negative').filter((p) => p.ok).length)}/${String(byPart('negative').length)} 必响 · 恢复 ${String(byPart('restore').filter((p) => p.ok).length)}/${String(byPart('restore').length)} 再安静`)
  console.log(`证据：${join('artifacts', 'm9.1', `measurement-${date}-${head}`, 'measurement.json')}`)
  console.log(allOk ? '\n量具有效（MEASUREMENT VALID）：检测器非噪音源、非橡皮图章、可恢复。' : '\n⚠️ 量具无效（MEASUREMENT INVALID）：有检测器未通过三段式——先修量具再测系统。')
  process.exitCode = allOk ? 0 : 1
}

await main()
