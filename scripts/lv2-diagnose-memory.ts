/**
 * Lv2 —— **显式记忆链的离线诊断**（`lv2:diagnose:memory`；**0 次模型调用**）。
 *
 * ============================================================================
 *  它回答什么（WP4 的读数把它逼出来的一个问题）
 * ============================================================================
 * WP4 的 144 份正式读数里，**C04（更正）是最差的一类**：`C04-01` / `C04-04` / `C02-02`
 * 三案两轮**都**红，红在 `active_memory_value_not`（"该槽位的当前值应当不再是旧值"）——
 * 即"**用自然语言改一条已有记忆**"这一步**没落库**。
 * 而同一个候选上 `C04-03`（问新值）✅✅ · `C04-05`（指代不明应当澄清）✅✅ ·
 * `lv2:core:verify` 的直构造路径 ✅ —— 说明读回 / 预置 / 放行口 / reducer 都在位。
 * ⇒ 缺的那一步只可能在四段里的一段：
 * ```text
 *   ① 意图检测   detectExplicitIntentFromEvent(detector, event)
 *   ② 内容抽取   extractor.extract({ text, owner, speaker })
 *   ③ 目标解析   resolver.resolve({ … })        （在 ④ 内部）
 *   ④ 放行与写   service.handle({ owner, intent, triggerEventId, speaker, hints })
 * ```
 *
 * 本脚本把**同样**的接线（`createLv2MemoryPath`，与运行器**同一处**）逐句喂进去，
 * 把每一段的结果**分别**打出来 —— 于是"哪一段没接上"是一个读数，而不是猜测。
 *
 * ⚠️ **每条探针各自一个隔离库**（并且按 `seed` 复刻 WP4 的初始状态）：
 *    第一版七条探针共用一个库 ⇒ 前一条的写入把后一条污染的（F1 变成 `already_applied`），
 *    读出来的结论是**假的**。隔离是这类诊断的**前提**，不是讲究。
 * ⚠️ 它是**量具，不是修法**：不改产品、不调模型、不放宽任何判据。
 * ⚠️ 正控必须会响、负控必须安静 —— 否则"全都没解析出来"与"检测器根本没跑"无法区分（`AGENTS.md` §6.7）。
 */

import 'dotenv/config'
import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createM4Harness } from './m4-harness.ts'
import { createLv2MemoryPath, createLv2CaseEnvironment } from './lv2-harness.ts'
import {
  detectExplicitIntentFromEvent,
  targetHintsFrom,
} from '../src/kernel/app/memory/intent-detector.ts'
import { createLv2RunId, openLv2RunDir, writeLv2Manifest } from './lv2-evidence.ts'
import { LV2_SHORT_CASES } from '../evals/lv2/short-cases.ts'

/** 命令行参数（本脚本**没有**全局 argv，历来按需在这里取）。 */
const DIAG_ARGV = process.argv.slice(2)

interface Probe {
  readonly id: string
  readonly role: 'positive_control' | 'negative_control' | 'wp4_failure'
  readonly text: string
  /** 开跑前用**程序侧**预置的槽位（复刻 WP4 的 `prep`） */
  readonly seed?: { readonly predicate: string; readonly value: string; readonly sourceText: string }
  /** 跑完之后该槽位的活跃值必须**不再是** `seed.value`（更正案） */
  readonly expectChanged?: boolean
  /**
   * **开跑前先把预置的那条遗忘掉**（Lv2 `LV2-D10` ③ 的探针形态）。
   *
   * 它测的是"**同内容重述复活**"（M9.1 `ADR-072` `D03`）：
   * 遗忘后用户重新明确告知同一内容 ⇒ 应当重新记住。
   * ⚠️ 这条路径在生产里由 `features: { restatementRevivalEnabled }` 注入放行口
   *    （`main.ts:1656`）；夹具缺这个字段时它是**关的** —— 那正是 `C05-04` 两轮皆红的候选原因。
   */
  readonly forgetBefore?: { readonly forgetText: string }
  /** 跑完之后该槽位的活跃值应当等于它（复活案） */
  readonly expectActiveAfter?: string
}

const PROBES: readonly Probe[] = [
  /* ---- 正控：带触发词（`记住`）—— P2 与 F1 只差**触发词**，这是刻意的对照 ---- */
  { id: 'P1-remember-fact', role: 'positive_control', text: '记住，我不吃香菜。' },
  {
    id: 'P2-remember-correct',
    role: 'positive_control',
    text: '记住，我现在能吃香菜了。',
    seed: { predicate: 'food.preference.cilantro', value: 'dislike', sourceText: '记住，我不吃香菜。' },
    expectChanged: true,
  },
  /* ---- 负控：不应当有显式记忆意图 ---- */
  { id: 'N1-chitchat', role: 'negative_control', text: '今天天气不错。' },
  { id: 'N2-question', role: 'negative_control', text: '我实验室在哪来着？' },
  /*
   * `LV2-D11` 的负控：这三个都含"记"字，但**没有一个是用户在要求记住** ——
   * 它们是自述（`我记住了`）· 反问（`你记住了吗`）· 陈述（`我早就记住了`）。
   * ⚠️ 它们正是"**放宽 `requiresLeading`**"那条备选会误伤的句子（所以选了加短语、不动守卫）。
   */
  { id: 'N3-self-report', role: 'negative_control', text: '我记住了。' },
  { id: 'N4-question-back', role: 'negative_control', text: '你记住了吗？' },
  { id: 'N5-past-statement', role: 'negative_control', text: '我早就记住了。' },
  /* ---- WP4 里两轮都红的三句（**读数**：复刻初始状态，看离线路径能不能改）---- */
  {
    id: 'F1-c04-01',
    role: 'wp4_failure',
    text: '那个改一下，我现在能吃香菜了。',
    seed: { predicate: 'food.preference.cilantro', value: 'dislike', sourceText: '记住，我不吃香菜。' },
    expectChanged: true,
  },
  {
    id: 'F2-c04-04',
    role: 'wp4_failure',
    text: '我刚才说错了，还是 Windows。',
    seed: { predicate: 'device.primary', value: 'Linux', sourceText: '我换 Linux 了。' },
    expectChanged: true,
  },
  {
    id: 'F3-c02-02',
    role: 'wp4_failure',
    text: '唉，其实我早就能吃香菜了。',
    seed: { predicate: 'food.preference.cilantro', value: 'dislike', sourceText: '记住，我不吃香菜。' },
    expectChanged: true,
  },
  {
    id: 'F4-c05-04',
    role: 'wp4_failure',
    text: '还是记一下吧：我的实验室在 A 楼 302。',
    seed: { predicate: 'education.lab', value: 'A 楼 302', sourceText: '记住，我的实验室在 A 楼 302。' },
    forgetBefore: { forgetText: '忘掉我实验室在哪这件事。' },
    expectActiveAfter: 'A 楼 302',
  },
]

interface ProbeReading {
  readonly id: string
  readonly role: Probe['role']
  readonly text: string
  readonly intent: { readonly kind: string | null; readonly detail?: string } | null
  readonly extracted:
    | { readonly type: string; readonly predicate: string | null; readonly value: string | null }
    | null
  readonly outcome:
    | { readonly ok: true; readonly intent: string; readonly performed: string | null }
    | { readonly ok: false; readonly intent: string; readonly reason: string; readonly codes: readonly string[] }
    | null
  readonly verdictLine: string
  /** 全部活跃取值（`谓词=取值`）—— 用来回答"新值是不是落到了**别的**槽位" */
  readonly activeAll: readonly string[]
  /** 预置槽位在开跑前 / 跑完后的活跃值 */
  readonly beforeValue: string | null
  readonly afterValue: string | null
  readonly changed: boolean
  readonly pass: boolean
}

const checks: { id: string; pass: boolean; expected: string; observed: unknown }[] = []

function valueOf(
  records: readonly { status: unknown; content: unknown }[],
  predicate: string,
): string | null {
  for (const record of records) {
    if (String(record.status) !== 'active') continue
    const content = record.content as { predicate?: unknown; value?: unknown } | undefined
    if (content?.predicate === predicate) return typeof content.value === 'string' ? content.value : null
  }
  return null
}

async function main(): Promise<void> {
  const started = new Date().toISOString()
  const root = process.cwd()
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const readings: ProbeReading[] = []
  let cleanClose = true

  for (const probe of PROBES) {
    isolateDatabase(`lv2-diag-${probe.id}`, { keep: true })
    await resetPluginSqlConnection()
    const h = await createM4Harness({ label: `lv2-diag-${probe.id}` })
    const path = createLv2MemoryPath(h)
    let beforeValue: string | null = null
    let afterValue: string | null = null
    try {
      /* --- 预置（复刻 WP4 的 prep：**程序侧**构造，不走自然语言） --- */
      if (probe.seed !== undefined) {
        const evidence = await h.recordUserEvidence(probe.seed.sourceText)
        const record = await h.commitAndFold(
          h.makeCandidate(
            'preference',
            { kind: 'claim', subject: h.user, predicate: probe.seed.predicate, value: probe.seed.value } as never,
            { sourceRefs: [evidence.ref] },
          ),
          1_800_000_000_001,
        )
        if (record === null) throw new Error(`预置未被放行：${probe.seed.sourceText}`)
      }
      const beforeRecords = await h.store.list({ owner: h.owner, limit: 200 })
      beforeValue = probe.seed === undefined ? null : valueOf(beforeRecords, probe.seed.predicate)

      /* --- 开跑前先遗忘（复活案的初始状态） --- */
      if (probe.forgetBefore !== undefined) {
        if (probe.seed === undefined) throw new Error('forgetBefore 需要先 seed')
        const target = (await h.store.listBySubject(h.owner, h.user)).find(
          (record) => record.status === 'active' && String((record.content as { predicate?: unknown }).predicate) === probe.seed!.predicate,
        )
        if (target === undefined) throw new Error(`遗忘前找不到目标：${probe.seed.predicate}`)
        const forget = await h.recordUserEvidence(probe.forgetBefore.forgetText)
        await h.applyStateChange(
          'retract',
          String(forget.event.id),
          { memoryId: target.id, reason: 'explicit_forget', note: probe.forgetBefore.forgetText },
          1_800_000_000_002,
        )
        beforeValue = valueOf(await h.store.list({ owner: h.owner, limit: 200 }), probe.seed.predicate)
      }

      /* --- 探针这一句 --- */
      const evidence = await h.recordUserEvidence(probe.text)
      const event = evidence.event
      let detectedIntent: Awaited<ReturnType<typeof detectExplicitIntentFromEvent>> = undefined
      let intent: { kind: string | null; detail?: string } | null = null
      try {
        detectedIntent = await detectExplicitIntentFromEvent(path.detector, event)
        intent = detectedIntent === undefined ? null : { kind: String(detectedIntent.kind) }
      } catch (error) {
        intent = { kind: null, detail: (error as Error).message }
      }
      let extracted: ProbeReading['extracted'] = null
      try {
        const result = await path.extractor.extract({ text: probe.text, owner: h.owner, speaker: h.user })
        if (result !== undefined) {
          const content = result.content as { predicate?: unknown; value?: unknown }
          extracted = {
            type: String(result.type),
            predicate: typeof content.predicate === 'string' ? content.predicate : null,
            value: typeof content.value === 'string' ? content.value : null,
          }
        }
      } catch (error) {
        extracted = { type: `throw:${(error as Error).message}`, predicate: null, value: null }
      }
      /*
       * ③④ 走**服务本体**（生产入口 `createExplicitMemoryTurnPort` 只是"检测 + 翻译"两层薄壳）。
       * ⚠️ 只调一次；且 intent 必须是**检测器给的完整对象** —— 第一版手搓 `{kind}` ⇒
       *    服务在 remember 里读不到正文，`trim` 抛错（真踩到）。
       */
      let verdictLine = '这一轮没有显式记忆指令（intent = undefined）'
      let outcome: ProbeReading['outcome'] = null
      if (detectedIntent !== undefined) {
        try {
          const serviceOutcome = await path.service.handle({
            owner: h.owner,
            intent: detectedIntent,
            triggerEventId: event.id,
            speaker: h.user,
            hints: targetHintsFrom(detectedIntent),
          } as never)
          verdictLine = serviceOutcome.ok === true ? '服务写入成功' : `服务拒绝：${String(serviceOutcome.reason)}`
          outcome =
            serviceOutcome.ok === true
              ? { ok: true, intent: String(serviceOutcome.intent), performed: serviceOutcome.performed ?? null }
              : {
                  ok: false,
                  intent: String(serviceOutcome.intent),
                  reason: String(serviceOutcome.reason),
                  codes: (serviceOutcome.codes ?? []).map((code) => String(code)),
                }
        } catch (error) {
          verdictLine = `服务抛错：${(error as Error).message}`
        }
      }
      const afterRecords = await h.store.list({ owner: h.owner, limit: 200 })
      const activeAll = afterRecords
        .filter((record) => String(record.status) === 'active')
        .map((record) => {
          const content = record.content as { predicate?: unknown; value?: unknown }
          return `${String(content.predicate ?? '?')}=${String(content.value ?? '?')}`
        })
      afterValue = probe.seed === undefined ? null : valueOf(afterRecords, probe.seed.predicate)
      const changed = probe.seed !== undefined && afterValue !== probe.seed.value

      /*
       * 判定：**只判探针自身的有效性**（正控会响、负控安静）——
       * `wp4_failure` 三句是**读数**（"该不该被解析"是金标问题，属 WP1 语料 / `M4 D2-A` 那条线）。
       */
      const produced = extracted !== null || outcome?.ok === true
      const judged = probe.role !== 'wp4_failure'
      const pass = !judged
        ? true
        : probe.role === 'positive_control'
          ? produced && (probe.expectChanged !== true || changed)
          : intent === null && outcome === null && !changed
      readings.push({
        id: probe.id,
        role: probe.role,
        text: probe.text,
        intent,
        extracted,
        outcome,
        verdictLine,
        activeAll,
        beforeValue,
        afterValue,
        changed,
        pass,
      })
      if (judged) {
        checks.push({
          id: probe.id,
          pass,
          expected:
            probe.role === 'positive_control'
              ? `正控：必须解析出内容${probe.expectChanged === true ? '且槽位真的改了' : ''}`
              : '负控：不得有显式记忆意图、不得改动状态',
          observed: { intent: intent?.kind ?? null, extracted, verdictLine, activeAll, beforeValue, afterValue, changed },
        })
      }
      console.log(`       ↳ 全部活跃：${activeAll.join(' · ') || '（空）'}`)
    } finally {
      try {
        await h.stop()
      } catch {
        cleanClose = false
      }
    }
  }

  /*
   * `--case-shape <caseId>`：**按批次的装配**跑一个语料案（**0 次模型调用**）。
   *
   * 出身：第五代读数里 `C05-04` 仍红（没有 `education.lab` 记忆），而**同样形状**的探针 `F4`
   *   （直调 `service.handle`）**写成功了**；两条更早的候选（遗忘实现、抽取器）已逐字排除
   *   ⇒ 只剩"写入链的**装配**"这一条。
   * ⚠️ 关键杠杆：控制档**只换回复**，**写入链照跑** ⇒ 所以这是**不花调用**的判决性实验。
   */
  const shapeIndex = DIAG_ARGV.indexOf('--case-shape')
  let caseShapeReading: Record<string, unknown> | null = null
  if (shapeIndex >= 0) {
    const caseId = String(DIAG_ARGV[shapeIndex + 1] ?? 'C05-04')
    const target = LV2_SHORT_CASES.find((one) => one.caseId === caseId)
    if (target === undefined) throw new Error(`--case-shape 找不到案：${caseId}`)
    isolateDatabase(`lv2-diagnose-shape-${caseId}`, { keep: true })
    await resetPluginSqlConnection()
    const env = await createLv2CaseEnvironment({
      label: `lv2-shape-${caseId}`,
      conversationId: `shape-${caseId}`,
      control: true,
    })
    try {
      if (target.prep.length > 0) await env.prepare(target.prep)
      const beforeState = await env.snapshot()
      const shapeTurn = await env.runTurn(target.turns[0] ?? '', { control: true, turnIndex: 1 })
      const afterState = await env.snapshot()
      const labRows = (state: typeof beforeState): string[] =>
        state.memories.filter((row) => row.predicate === 'education.lab').map((row) => `${row.status}:${String(row.value)}`)
      const wrote = afterState.memories.some(
        (row) => row.predicate === 'education.lab' && row.status === 'active' && row.value === 'A 楼 302',
      )
      /*
       * 二分：**同一句话**分别走"端口"与"直调服务"，把两者的结论并排打出来。
       * ⚠️ 端口那条要一个**真实的用户事件** ⇒ 这里自己记一条（与批次同形：那轮的用户事件）。
       */
      const path2 = createLv2MemoryPath(env.h)
      const evidence = await env.h.recordUserEvidence(target.turns[0] ?? '')
      const detected = await detectExplicitIntentFromEvent(path2.detector, evidence.event)
      let viaPort = 'undefined（端口判"这轮没有显式记忆指令"）'
      try {
        const portResult = await path2.port.handleTurn({
          event: evidence.event,
          owner: env.h.owner,
          speaker: env.h.user,
        } as never)
        viaPort = portResult === undefined ? viaPort : `handled：${JSON.stringify(portResult).slice(0, 120)}`
      } catch (error) {
        viaPort = `throw：${(error as Error).message}`
      }
      let viaService = '（未检测到意图 ⇒ 不调服务）'
      if (detected !== undefined) {
        try {
          const outcome = await path2.service.handle({
            owner: env.h.owner,
            intent: detected,
            triggerEventId: evidence.event.id,
            speaker: env.h.user,
            hints: targetHintsFrom(detected),
          } as never)
          viaService =
            outcome.ok === true
              ? `ok（performed=${String(outcome.performed ?? 'write')}）`
              : `拒绝：${String(outcome.reason)}`
        } catch (error) {
          viaService = `throw：${(error as Error).message}`
        }
      }
      const afterBoth = await env.snapshot()
      console.log(
        `[lv2:diagnose] case-shape 二分：意图=${String(detected?.kind ?? '—')} · ` +
          `端口=${viaPort} · 直调服务=${viaService} · ` +
          `事后活跃=[${afterBoth.memories
            .filter((row) => row.status === 'active' && row.predicate === 'education.lab')
            .map((row) => String(row.value))
            .join(',')}]`,
      )
      caseShapeReading = {
        caseId,
        turnText: target.turns[0] ?? '',
        beforeLab: labRows(beforeState),
        afterLab: labRows(afterState),
        wrote,
        completed: shapeTurn.completed,
        bisect: { intent: detected?.kind ?? null, viaPort, viaService },
      }
      console.log(
        `[lv2:diagnose] case-shape ${caseId}：前=${JSON.stringify(labRows(beforeState))} · ` +
          `后=${JSON.stringify(labRows(afterState))} · 写入=${wrote ? '**有**' : '**没有**'}`,
      )
    } finally {
      await env.close()
    }
  }

  const failed = checks.filter((check) => !check.pass)
  const verdict = failed.length === 0 ? 'PASS' : 'FAIL'
  const runId = createLv2RunId({ wpId: 'wp4-diagnose-memory', headShort: head })
  const dir = openLv2RunDir(root, runId)
  writeFileSync(
    join(dir, 'readings.json'),
    `${JSON.stringify({ runId, readings, checks, caseShapeReading }, null, 2)}\n`,
    'utf8',
  )
  const manifestPath = writeLv2Manifest(dir, {
    runId,
    wp: 'wp4-diagnose-memory',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    toolVersions: { node: process.version },
    testType: 'offline-memory-path-diagnosis',
    counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    phases: ['single'],
    supersedes: null,
    started,
    ended: new Date().toISOString(),
    worktree: { clean: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() === '', note: '本脚本自己的 run 目录按白名单不计入' },
    sourceFingerprints: Object.fromEntries(
      (
        [
          'scripts/lv2-diagnose-memory.ts',
          'scripts/lv2-harness.ts',
          'src/kernel/app/memory/explicit-turn.ts',
          'src/kernel/app/memory/explicit-service.ts',
          'src/kernel/app/memory/content-extractor.ts',
          'src/kernel/app/memory/target-resolver.ts',
          'src/kernel/app/memory/intent-detector.ts',
        ] as const
      ).map((path2) => [path2, createHash('sha256').update(readFileSync(join(root, path2))).digest('hex')]),
    ),
    config: { mode: 'offline（0 次模型调用）', extractor: 'createRuleOnlyContentExtractor()（生产缺省）', isolation: '每条探针各自一个隔离库' },
    model: { providerKind: 'none', note: '零模型请求' },
    requests: { planned: 0, actual: 0, note: '零模型请求' },
    denominators: {
      probes: readings.length,
      positives: readings.filter((row) => row.role === 'positive_control').length,
      negatives: readings.filter((row) => row.role === 'negative_control').length,
      wp4Failures: readings.filter((row) => row.role === 'wp4_failure').length,
      wp4FailuresReproduced: readings.filter((row) => row.role === 'wp4_failure' && !row.changed).length,
    },
    correlations: { cases: readings.length, conversations: readings.length, requests: 0, traces: 0 },
    faultInjection: null,
    cleanClose,
    realDb: { opened: false, summaryBefore: null, summaryAfter: null, note: '隔离库；`data/pglite` 未被打开' },
    verdict,
    limitation:
      '本脚本只回答"四段里哪一段没接上"（意图检测 / 内容抽取 / 目标解析 / 放行与写）。' +
      '它**不**判"哪句话该被解析"（金标问题），也**不**修任何东西；`wp4_failure` 三句是**读数**，不进判定。',
  })

  console.log(`[lv2:diagnose] runId = ${runId}（每条探针一个隔离库 · 0 次模型调用）`)
  for (const reading of readings) {
    const badge = reading.role === 'wp4_failure' ? '📖' : reading.pass ? '✅' : '❌'
    console.log(
      `  ${badge} ${reading.id.padEnd(20)} 意图=${String(reading.intent?.kind ?? '—').padEnd(9)} 抽取=${
        reading.extracted === null ? '—' : String(reading.extracted.predicate)
      } 结论=${reading.verdictLine.padEnd(24)} 槽位 ${String(reading.beforeValue ?? '—')} → ${String(reading.afterValue ?? '—')}${reading.changed ? ' ✅改了' : ''}`,
    )
  }
  console.log(`[lv2:diagnose] 判定项 ${String(checks.length)} · 通过 ${String(checks.length - failed.length)} · 未通过 ${String(failed.length)} ⇒ ${verdict}`)
  console.log(`[lv2:diagnose] WP4 三案离线复现（没改动槽位）= ${String(readings.filter((row) => row.role === 'wp4_failure' && !row.changed).length)}/${String(readings.filter((row) => row.role === 'wp4_failure').length)}`)
  console.log(`[lv2:diagnose] cleanClose=${String(cleanClose)} · manifest = ${manifestPath.replace(`${root}\\`, '').replace(/\\/g, '/')}`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
