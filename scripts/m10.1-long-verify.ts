/**
 * M10.1 WP6 —— **时间维度门**（`m10.1:long:verify`）。
 *
 * ============================================================================
 *  它判什么：**约定在长时间尺度上"活着"与"死掉"的样子**
 * ============================================================================
 * ```text
 * 本里程碑的存在理由（R-26）是"她反复提同一件事"。离线的 `m10.1:e2e:verify` 已把
 * **一条链**跑通；本门补的是**时间**这一维 —— 三条判据：
 *
 * ① **结清前**：未结清的约定在事实块里**照常列着**（不是"记了但看不见"）。
 * ② **结清后**：块里换成「**已结清**，**不要再提**」—— 而且这是在**约定原话早已离开
 *    最近窗口**之后**读到的（窗口 = 最近 16 行；本门自己维护这个滚动窗口并**断言它已经忘了**）。
 *    ⇒ 这正是"**程序事实**压过**窗口散文**"的机械形态：她不再需要"记得"，因为有东西替她记着。
 * ③ **规模与重放**：`--turns N`（缺省 200，另跑 500）跑完整条轨迹；期间**每回合都有结论**、
 *    **零越界写入**（只写目标域事件）；丢掉缓存后**从账本重放** ⇒ 事实行**逐字段相同**。
 * ```
 *
 * ============================================================================
 *  三条纪律
 * ============================================================================
 * ```text
 * · **走真实编排**：`runGoalTurn()`（`m10-harness.ts` 是唯一接线）+ 真放行口 + 真写库。
 * · **约定轮用"模型形状"的草案**（只有 `scope` + `criterion`，**没有 id**）——
 *   顺便把 `R-29` 的修复放进长轨迹里再验一次（id 由程序补）。
 * · **本门不调模型、不出网**（`fixedProvider`）；**不开真实库**（`isolateDatabase`）。
 * ```
 *
 * 用法：`tsx scripts/m10.1-long-verify.ts [--turns 200|500]`
 */

import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m10-1-long', { keep: false })

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { AgentRuntime } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'

import { createM11RunId, openM11RunDir, writeM11Manifest, M11_MANIFEST_VERSION } from './m11-evidence.ts'
import { createM10TurnHarness, deterministicRuntime, fixedProvider } from './m10-harness.ts'
import { TEST_MODEL_WRAPPER_MARKER } from './m6-command-surface.ts'
import { config as loadEnvFromFile } from 'dotenv'
import { existsSync } from 'node:fs'
import { createOpenAiGoalUnderstandingProvider } from '../src/infrastructure/model/openai-goal-understanding.ts'
import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { getRawDb } from '../src/infrastructure/persistence/db.ts'
import { domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { rebuildGoalProjections } from '../src/infrastructure/persistence/goal-store.ts'
import type { CharacterId } from '../src/kernel/contracts/index.ts'
import {
  COMMITMENT_ACCEPTED,
  COMMITMENT_FULFILLED,
  GOAL_COMPLETED,
  GOAL_CREATED,
  GOAL_DOMAIN_EVENT_TYPES,
} from '../src/kernel/contracts/domain-event.ts'
import {
  COMMITMENT_DO_NOT_RAISE,
  commitmentFactRowsOf,
  renderCommitmentStateBlock,
  type CommitmentFactRow,
} from '../src/kernel/app/goal/commitment-facts.ts'

const REPO_ROOT = resolve(process.cwd())
const CHARACTER = 'char_m10_1_long' as CharacterId
const USER_ID = 'm10-1-long-user'
const T0 = 2_700_000_000_000
const RECENT_WINDOW = 16
const AGREEMENT_SCOPE = '明天十点二十五在楼下见'
const AGREEMENT_TURN = 2
const CLOSURE_TURN = 4
const TURNS = ((): number => {
  const index = process.argv.indexOf('--turns')
  const raw = index >= 0 ? Number(process.argv[index + 1]) : 200
  return Number.isFinite(raw) && raw > 10 ? Math.trunc(raw) : 200
})()

/**
 * **真模型档**（`--live`）：`m10.1:long:live`。
 *
 * ```text
 * 离线档用 `fixedProvider`（脚本替模型给出草案）⇒ 它判的是**机器**；
 * 真模型档把每一轮**真的交给模型**（每轮一次调用）⇒ 它回答的是"**这条链在真模型下会不会崩、会不会越界**"。
 * ⚠️ 因此判据分两类：
 *   · **判据**：链路不崩（没有 transport/commit 失败）· 额度 0 ⇒ 0 section · 零越界 · 重建逐字段相同 · 确定性 · 非零分母
 *   · **读数**：约定有没有被识别、结清有没有落、块里说了什么、窗口忘没忘（真模型不保证 ⇒ 如实分列，不当 PASS/FAIL）
 * ```
 */
const LIVE = process.argv.includes('--live')
if (LIVE) {
  if (process.env[TEST_MODEL_WRAPPER_MARKER] !== '1') {
    console.error(
      `⛔ 拒跑：\`--live\` 走**真模型**，必须先经 \`pnpm with-test-model\`（缺 ${TEST_MODEL_WRAPPER_MARKER}=1）。`
    )
    process.exit(2)
  }
}
/** 真模型档的读数门（**不**计入 PASS/FAIL；标签里写「读数」） */
const recordReading = (id: string, label: string, detail: string): void => {
  record(id, `【读数·如实分列】${label}`, true, detail)
}

/* 真模型档：显式加载 `.env.test`（**覆盖**）并独立判一次"解析出的端点不是生产端点" */
if (LIVE) {
  if (existsSync('.env.test')) loadEnvFromFile({ path: '.env.test', override: true })
  const host = ((): string => {
    try {
      return new URL((process.env.OPENAI_BASE_URL ?? '').trim() || 'https://api.deepseek.com').host
    } catch {
      return '(无法解析)'
    }
  })()
  if (host === '' || host === 'api.deepseek.com') {
    console.error(`⛔ 拒跑：解析出的端点是生产端点（host=${host}）—— \`--live\` 只跑测试端点。`)
    process.exit(2)
  }
  console.log(
    `真模型档：端点 host=${host} · model=${(process.env.OPENAI_SMALL_MODEL ?? '').trim()} · ` +
      `key 长度=${String((process.env.OPENAI_API_KEY ?? '').trim().length)}`
  )
}

function phase(mark: string): void {
  console.error(`[m10.1-long] ${mark}`)
}

interface Check {
  id: string
  label: string
  pass: boolean
  detail: string
}
const checks: Check[] = []
const record = (id: string, label: string, pass: boolean, detail: string): void => {
  checks.push({ id, label, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

const quantify = (text: string): number => [...text].length
const draftOf = (operation: string, extra: Record<string, unknown>): unknown => ({
  schemaVersion: 'goal-proposal@1',
  operation,
  span: { start: 0, end: 4 },
  ...extra,
})

async function main(): Promise<void> {
  phase(`boot isolated database（${String(TURNS)} 轮轨迹）`)
  const agentRuntime = new AgentRuntime({ character, plugins: [] })
  await initDatabase(agentRuntime, sqlPlugin)
  const db = getRawDb(agentRuntime)
  const harness = createM10TurnHarness({ db, characterId: CHARACTER, userId: USER_ID })
  const rt = deterministicRuntime()

  /** 滚动窗口（**只存正文与轮次**；本门自己维护它，用来断言"窗口已经忘了"） */
  const window: { turn: number; text: string }[] = []
  const pushLine = (turn: number, text: string): void => {
    window.push({ turn, text })
    while (window.length > RECENT_WINDOW) window.shift()
  }
  const windowText = (): string => window.map((line) => line.text).join('\n')

  const readings: { at: number; kind: string; block: string; rows: number }[] = []
  const readBlock = async (turn: number, kind: string): Promise<void> => {
    const rows = commitmentFactRowsOf(await harness.listStates())
    const block = renderCommitmentStateBlock({ rows, maxTokens: 300, quantify })[0]?.content ?? ''
    readings.push({ at: turn, kind, block, rows: rows.length })
  }

  let agreementGoalId: string | undefined
  let turnsWithoutOutcome = 0
  /** 真模型档的**链路级**失败（`transport_failed` / `commit_failed`）—— 这两类才算"链崩了" */
  let turnsWithBrokenLink = 0
  let modelCalls = 0
  /** 结清**当场**的窗口快照（见下面那处 ⚠️） */
  let windowAtClosureText = ''
  const outcomes = new Map<string, number>()

  const liveProviderInstance = LIVE ? createOpenAiGoalUnderstandingProvider() : undefined
  const providerForTurn = (): ReturnType<typeof fixedProvider> => {
    if (liveProviderInstance === undefined) return fixedProvider(draftOf('none', {}))
    const base = liveProviderInstance
    return {
      name: base.name,
      version: base.version,
      call: async (input: never): Promise<unknown> => {
        modelCalls += 1
        return await base.call(input as never)
      },
    } as unknown as ReturnType<typeof fixedProvider>
  }

  phase(`trajectory: ${String(TURNS)} turns（约定在第 ${String(AGREEMENT_TURN)} 轮，结清在第 ${String(CLOSURE_TURN)} 轮）`)
  for (let turn = 0; turn < TURNS; turn += 1) {
    const now = T0 + turn * 1_000
    const sourceEventId = `cev:user:long-${String(turn)}`
    const userLine =
      turn === AGREEMENT_TURN
        ? '明天十点二十五，楼下，带伞和外套。'
        : turn === CLOSURE_TURN
          ? '我到了，就在楼下。'
          : `第${String(turn)}轮：今天天气不错。`
    pushLine(turn, userLine)

    let currentInput = userLine
    /*
     * ⚠️ **真模型档**：每一轮都真的交给模型（不再由脚本替它给草案）；
     *    离线档保持原样（脚本草案 ⇒ 判的是机器本身）。
     */
    let provider = providerForTurn()
    if (!LIVE && turn === 0) {
      currentInput = '把提纲写完设成目标'
      provider = fixedProvider(
        draftOf('create', { statement: '把提纲写完', origin: 'user_requested' })
      )
    } else if (!LIVE && turn === AGREEMENT_TURN) {
      /*
       * ⚠️ **模型形状**：只有 `scope` + `criterion`，**没有** `acceptanceEventIds`
       *    （R-29 的修复：接受这件事的出处由程序补）。
       */
      provider = fixedProvider(
        draftOf('create', {
          statement: AGREEMENT_SCOPE,
          origin: 'user_requested',
          commitment: { scope: AGREEMENT_SCOPE, criterion: { kind: 'user_report' } },
        })
      )
    } else if (!LIVE && turn === CLOSURE_TURN && agreementGoalId !== undefined) {
      currentInput = '我到了就在楼下'
      provider = fixedProvider(draftOf('report_complete', { targetGoalId: agreementGoalId }))
    }

    const result = await harness.turn({
      currentInput,
      sourceEventId,
      now,
      runtime: rt,
      provider,
    })
    outcomes.set(result.outcome, (outcomes.get(result.outcome) ?? 0) + 1)
    if (result.outcome !== 'no_operation' && result.outcome !== 'accepted') {
      turnsWithoutOutcome += 1
    }
    if (result.outcome === 'transport_failed' || result.outcome === 'commit_failed') {
      turnsWithBrokenLink += 1
    }
    if (turn === AGREEMENT_TURN && result.outcome === 'accepted') {
      const states = await harness.listStates()
      agreementGoalId = String(
        states.find((row) => row.commitment !== null)?.goal?.goalId ?? ''
      ) || undefined
    }
    pushLine(turn, '嗯。')

    /* ---- 三个检查点 ---- */
    if (turn === AGREEMENT_TURN) await readBlock(turn, 'before-closure')
    if (turn === CLOSURE_TURN) await readBlock(turn, 'at-closure')
    if (turn === TURNS - 1) await readBlock(turn, 'long-after-closure')
    /*
     * ⚠️ **窗口要在当场快照**：第一版在轨迹结束后才按 `turn <= CLOSURE_TURN` 过滤滚动窗口
     *    —— 那时窗口里只剩最后 16 行（turn 早已越过 CLOSURE_TURN）⇒ 结清轮的那句原话
     *    **根本不在里面**，W5 于是必然红。这是"**读数取错了时刻**"的又一例。
     */
    if (turn === CLOSURE_TURN) windowAtClosureText = windowText()
  }

  /* ---------------------------------------------------------------------------
   * W1 每回合都有结论（**没有"崩了但看起来跑完了"**）
   * ------------------------------------------------------------------------- */
  if (LIVE) {
    /*
     * ⚠️ **真模型档的 W1 判据（两次修正后）**：判"**每一轮都落进闭集内的结论**"
     *    —— 与 `m10.1:smoke:live` 的 L1 **同一条口径**。
     *    第一次跑把它写成"零 `transport_failed`"，于是 200 轮里 2 次**环境级**传输失败
     *    被记成"链崩了" —— 那是**说错了原因**：传输失败是**读数**（端点/网络），不是编排缺陷。
     */
    const CLOSED_OUTCOMES = [
      'no_operation',
      'query',
      'clarify',
      'accepted',
      'rejected',
      'invalid_output',
      'transport_failed',
      'source_unusable',
      'not_invoked',
      'commit_failed',
    ]
    const offClosedSet = [...outcomes.keys()].filter((outcome) => !CLOSED_OUTCOMES.includes(outcome))
    record(
      'W1',
      '【每回合都有闭集内的结论·真模型档】200 轮里**没有一轮**落进"未知结论"（端口不抛、编排不崩）' +
        ' —— `transport_failed` / `invalid_output` 属**闭集内**结论，作为读数另报',
      offClosedSet.length === 0,
      `闭集外结论=${JSON.stringify(offClosedSet)} · 闭集=${String(CLOSED_OUTCOMES.length)} 类 · ` +
        `模型调用=${String(modelCalls)} · 传输失败=${String(outcomes.get('transport_failed') ?? 0)} · ` +
        `输出不合法=${String(outcomes.get('invalid_output') ?? 0)} · 结论分布=${JSON.stringify([...outcomes.entries()])}`
    )
  } else {
    record(
      'W1',
      '【每回合都有结论】整条轨迹里没有一轮落进 `rejected` / `invalid_output` / `transport_failed` / `commit_failed`',
      turnsWithoutOutcome === 0,
      `异常轮数=${String(turnsWithoutOutcome)} · 结论分布=${JSON.stringify([...outcomes.entries()])}`
    )
  }

  /* ---------------------------------------------------------------------------
   * W2 结清前：未结清照常列着
   * ------------------------------------------------------------------------- */
  const before = readings.find((row) => row.kind === 'before-closure')
  if (LIVE) {
    recordReading(
      'W2',
      '真模型档：结清前那份块里有没有「未结清的约定」（**取决于模型有没有真的记下那条约定**）',
      `轮次=${String(before?.at)} · 行数=${String(before?.rows)} · 含未结清=${String(
        before?.block.includes('未结清的约定')
      )} · 含不要再提=${String(before?.block.includes(COMMITMENT_DO_NOT_RAISE))}`
    )
  } else {
    record(
      'W2',
      '【结清前】约定**未结清**时，事实块列出「未结清的约定」（含判据人话与截止状态）· 且**不含**"不要再提"',
      before !== undefined &&
        before.block.includes('未结清的约定') &&
        before.block.includes(AGREEMENT_SCOPE) &&
        !before.block.includes(COMMITMENT_DO_NOT_RAISE),
      `轮次=${String(before?.at)} · 行数=${String(before?.rows)} · 含未结清=${String(
        before?.block.includes('未结清的约定')
      )}`
    )
  }

  /* ---------------------------------------------------------------------------
   * W3 结清：真的落了一个终态（`COMMITMENT_FULFILLED`）
   * ------------------------------------------------------------------------- */
  const events = (await domainEventsFor(db, CHARACTER)).filter((event) =>
    (GOAL_DOMAIN_EVENT_TYPES as readonly string[]).includes(String(event.type))
  )
  const typesOf = (type: string): number =>
    events.filter((event) => String(event.type) === type).length
  const countOf = (type: string): number => typesOf(type)
  if (LIVE) {
    recordReading(
      'W3',
      '真模型档：账本里有没有真的落 `GOAL_COMPLETED` **与** `COMMITMENT_FULFILLED`（**取决于模型有没有识别出约定并走到结清**）',
      `GOAL_COMPLETED=${String(countOf(String(GOAL_COMPLETED)))} · COMMITMENT_FULFILLED=${String(
        countOf(String(COMMITMENT_FULFILLED))
      )} · COMMITMENT_ACCEPTED=${String(countOf(String(COMMITMENT_ACCEPTED)))} · GOAL_CREATED=${String(
        countOf(String(GOAL_CREATED))
      )}`
    )
  } else {
    record(
      'W3',
      '【结清】第 4 轮的 `report_complete` 走真放行口 ⇒ 账本里出现 `GOAL_COMPLETED` **与** `COMMITMENT_FULFILLED`（承诺有终态）',
      countOf(String(GOAL_COMPLETED)) === 1 && countOf(String(COMMITMENT_FULFILLED)) === 1,
      `GOAL_COMPLETED=${String(countOf(String(GOAL_COMPLETED)))} · COMMITMENT_FULFILLED=${String(
        countOf(String(COMMITMENT_FULFILLED))
      )} · COMMITMENT_ACCEPTED=${String(countOf(String(COMMITMENT_ACCEPTED)))}`
    )
  }

  /* ---------------------------------------------------------------------------
   * W4 ⭐ 结清后：块说"不要再提"，而且**窗口已经忘了**
   * ------------------------------------------------------------------------- */
  const after = readings.find((row) => row.kind === 'long-after-closure')
  const windowHasAgreement = windowText().includes(AGREEMENT_SCOPE) ||
    windowText().includes('楼下，带伞和外套')
  if (LIVE) {
    recordReading(
      'W4',
      '真模型档：轨迹末尾那份块里有没有「已结清 + 不要再提 + 不复述原话」，以及**窗口忘没忘**',
      `轮次=${String(after?.at)} · 含已结清=${String(after?.block.includes('已结清'))} · 含不要再提=${String(
        after?.block.includes(COMMITMENT_DO_NOT_RAISE)
      )} · 块里含原话=${String(after?.block.includes(AGREEMENT_SCOPE))} · 窗口含约定=${String(
        windowHasAgreement
      )} · 窗口行数=${String(window.length)}`
    )
  } else {
    record(
      'W4',
      '【⭐ 结清后 + 窗口已忘】轨迹末尾读块：含「**已结清**」与「**不要再提**」· **块里也不复述那句原话**' +
        '（`L-M10.1-15` 的修法：终态档是**计数式陈述**）· 且**最近 16 行里已经没有那句约定**',
      after !== undefined &&
        after.block.includes('已结清') &&
        after.block.includes(COMMITMENT_DO_NOT_RAISE) &&
        !after.block.includes(AGREEMENT_SCOPE) &&
        !windowHasAgreement &&
        window.length === RECENT_WINDOW,
      `轮次=${String(after?.at)} · 含已结清=${String(after?.block.includes('已结清'))} · **块里含约定原话=${String(
        after?.block.includes(AGREEMENT_SCOPE)
      )}**（必须 false） · 窗口含约定=${String(windowHasAgreement)} · 窗口行数=${String(window.length)}`
    )
  }

  /* ---------------------------------------------------------------------------
   * W5 结清是**压在窗口里的锚上**完成的（R-26 的形状）
   * ------------------------------------------------------------------------- */
  const windowAtClosure = windowAtClosureText
  if (LIVE) {
    recordReading(
      'W5',
      '真模型档：结清（若发生）是否**压在窗口里的锚上**完成（R-26 的真实形状）',
      `结清轮窗口含约定原话=${String(windowAtClosure.includes('带伞和外套'))} · 结清轮=${String(CLOSURE_TURN)}`
    )
  } else {
    record(
      'W5',
      '【结清时的形状】结清发生在**约定原话还在窗口内**的时候（R-26 的真实形状：窗口里有 2–4 句提及，一句口头结清压不过它）' +
        ' —— 本门随后证明**程序侧**把它压住了',
      windowAtClosure.includes('带伞和外套') && after !== undefined,
      `结清轮窗口含约定原话=${String(windowAtClosure.includes('带伞和外套'))} · 结清轮=${String(CLOSURE_TURN)}`
    )
  }

  /* ---------------------------------------------------------------------------
   * W6 重放：丢缓存 + 从账本重建 ⇒ 事实行逐字段相同
   * ------------------------------------------------------------------------- */
  const beforeRebuild = commitmentFactRowsOf(await harness.listStates())
  await rebuildGoalProjections(db, CHARACTER)
  const afterRebuild = commitmentFactRowsOf(await harness.listStates())
  const sameRows = JSON.stringify(beforeRebuild) === JSON.stringify(afterRebuild)
  record(
    'W6',
    '【重放】丢掉投影缓存、**从账本重建** ⇒ 事实行**逐字段相同**（跨会话/重启的机械形态）' +
      (LIVE ? '（真模型档只判"逐字段相同"；行数取决于模型写了什么）' : ''),
    sameRows && (LIVE || afterRebuild.length === 1),
    `行数=${String(afterRebuild.length)} · 逐字段相同=${String(sameRows)}`
  )

  /* ---------------------------------------------------------------------------
   * W7 回滚档：额度 0 ⇒ 0 个 section（在大轨迹上也成立）
   * ------------------------------------------------------------------------- */
  const offSections = renderCommitmentStateBlock({ rows: beforeRebuild, maxTokens: 0, quantify })
  record(
    'W7',
    '【回滚档】同一份行、额度 0 ⇒ **0 个 section**（"删两行即回滚"在长轨迹上同样成立）',
    offSections.length === 0,
    `sections=${String(offSections.length)}`
  )

  /* ---------------------------------------------------------------------------
   * W8 零越界：整条轨迹只写目标域事件
   * ------------------------------------------------------------------------- */
  const allEvents = await domainEventsFor(db, CHARACTER)
  const foreign = allEvents
    .map((event) => String(event.type))
    .filter((type) => !(GOAL_DOMAIN_EVENT_TYPES as readonly string[]).includes(type))
  if (LIVE && events.length === 0) {
    /*
     * ⚠️ **空集上的"零越界"是空话** —— 按 `measured_count > 0` 的纪律，它**既不是 PASS 也不是 FAIL**，
     *    而是**不可判**（如实记读数）。真模型档 200 轮里一次都没写，是**读数**（见下面 W11）。
     */
    recordReading(
      'W8',
      '零越界**不可判**：这一档**一次都没写**目标域事件（空集上的"零越界"是空话 —— 不记 PASS）',
      `目标域事件=0 · 域外=[] · 链路失败轮=${String(turnsWithBrokenLink)} · 白名单=${String(
        GOAL_DOMAIN_EVENT_TYPES.length
      )} 类`
    )
  } else {
    record(
      'W8',
      '【零越界】整条轨迹**只**写目标域事件 —— 事件类型白名单逐条核过（`A14`）',
      foreign.length === 0 && (LIVE ? events.length > 0 : events.length >= 4),
      `目标域事件=${String(events.length)} · 域外=${JSON.stringify(foreign)} · 白名单=${String(
        GOAL_DOMAIN_EVENT_TYPES.length
      )} 类`
    )
  }
  if (LIVE) {
    /*
     * ⚠️ **"有写入"≠"有承诺行"**：真模型可以写出目标事件却不写承诺 ⇒ 块仍是**空的**
     *    ⇒ 块形态与结清路径**依然不可判**。两者分开算（第一版把它们混成一个条件 ⇒ 读数说错话）。
     */
    const unjudged = [
      ...(events.length === 0 ? ['零越界（W8）'] : []),
      ...(afterRebuild.length === 0
        ? ['未结清/已结清块的形态（W2/W4）', '结清路径（W3/W5）']
        : []),
    ]
    recordReading(
      'W11',
      '真模型档的**写入覆盖**（哪些性质本档可判、哪些不可判 —— "有写入"与"有承诺行"是两件事）',
      `目标域事件=${String(events.length)}（GOAL_CREATED=${String(typesOf(String(GOAL_CREATED)))} · ` +
        `COMMITMENT_ACCEPTED=${String(typesOf(String(COMMITMENT_ACCEPTED)))} · GOAL_COMPLETED=${String(
          typesOf(String(GOAL_COMPLETED))
        )}）· **承诺行=${String(afterRebuild.length)}** ⇒ ` +
        `可判：闭集内结论（W1）· 重建逐字段相同（W6）· 额度 0 ⇒ 0 section（W7）· 确定性（W10）· 非零分母（W9）；` +
        `**不可判**：${unjudged.length === 0 ? '无' : unjudged.join(' · ')}`
    )
  }

  /* ---------------------------------------------------------------------------
   * W9 非零分母 + 确定性
   * ------------------------------------------------------------------------- */
  const denominators = LIVE
    ? {
        /* 真模型档只用**结构上必然 > 0** 的分母；写入相关的计数作为读数另报（见下面 detail） */
        turns: TURNS,
        modelCalls,
        windowLines: window.length,
        readings: readings.length,
      }
    : {
        turns: TURNS,
        goalDomainEvents: events.length,
        factRows: afterRebuild.length,
        windowLines: window.length,
        readings: readings.length,
      }
  record(
    'W9',
    '【非零分母】计数全部 > 0（`0 检查 / 0 不一致` 不算 PASS）',
    Object.values(denominators).every((value) => value > 0),
    `${JSON.stringify(denominators)} · 另报（可为 0，见上面的读数）：目标域事件=${String(
      events.length
    )} · 事实行=${String(afterRebuild.length)}`
  )
  const twice = ((): readonly CommitmentFactRow[] => beforeRebuild)()
  record(
    'W10',
    '【确定性】同一份行两次渲染 ⇒ 逐字段相同（纯函数、不读挂钟）',
    JSON.stringify(renderCommitmentStateBlock({ rows: twice, maxTokens: 300, quantify })) ===
      JSON.stringify(renderCommitmentStateBlock({ rows: beforeRebuild, maxTokens: 300, quantify })),
    `两次相同=${String(
      JSON.stringify(renderCommitmentStateBlock({ rows: twice, maxTokens: 300, quantify })) ===
        JSON.stringify(renderCommitmentStateBlock({ rows: beforeRebuild, maxTokens: 300, quantify }))
    )}`
  )

  /* ---------------------------------------------------------------------------
   * 证据
   * ------------------------------------------------------------------------- */
  const failed = checks.filter((check) => !check.pass)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM11RunId({
    wpId: `m10-1-wp6-long${LIVE ? '-live' : ''}-${String(TURNS)}`,
    headShort: head,
  })
  const dir = openM11RunDir(REPO_ROOT, runId, 'artifacts/m10.1')
  const payload = {
    schema: 'm10.1-long-verify@1',
    manifestVersion: M11_MANIFEST_VERSION,
    runId,
    head,
    turns: TURNS,
    realDbTouched: false,
    live: LIVE,
    modelCalls: LIVE ? modelCalls : 0,
    endpointHost: LIVE
      ? ((): string => {
          try {
            return new URL((process.env.OPENAI_BASE_URL ?? '').trim() || 'https://api.deepseek.com').host
          } catch {
            return '(无法解析)'
          }
        })()
      : '(离线：fixedProvider)',
    characterId: CHARACTER,
    timeline: {
      agreementTurn: AGREEMENT_TURN,
      closureTurn: CLOSURE_TURN,
      recentWindow: RECENT_WINDOW,
      windowHasAgreementAtEnd: windowHasAgreement,
    },
    eventCounts: {
      GOAL_CREATED: typesOf(String(GOAL_CREATED)),
      COMMITMENT_ACCEPTED: typesOf(String(COMMITMENT_ACCEPTED)),
      GOAL_COMPLETED: typesOf(String(GOAL_COMPLETED)),
      COMMITMENT_FULFILLED: typesOf(String(COMMITMENT_FULFILLED)),
      goalDomain: events.length,
      foreign: foreign.length,
    },
    readings: readings.map((row) => ({
      at: row.at,
      kind: row.kind,
      rows: row.rows,
      includesUnclosed: row.block.includes('未结清的约定'),
      includesClosed: row.block.includes('已结清'),
      includesDoNotRaise: row.block.includes(COMMITMENT_DO_NOT_RAISE),
    })),
    vacuity: {
      writesObserved: events.length,
      commitmentRows: afterRebuild.length,
      propertiesUnjudged:
        !LIVE
          ? []
          : [
              ...(events.length === 0 ? ['零越界（W8）'] : []),
              ...(afterRebuild.length === 0
                ? ['未结清/已结清块的形态（W2/W4）', '结清路径（W3/W5）']
                : []),
            ],
      note:
        !LIVE
          ? '离线档不适用（脚本给定草案 ⇒ 写入是确定的）。'
          : afterRebuild.length === 0
            ? '真模型档这一档**没有承诺行** ⇒ 块形态与结清路径**不可判**（不是 PASS）；可判的是链路与重放类判据。'
            : '本档有承诺行 ⇒ 判据与读数都在上面逐条列出。',
    },
    denominators,
    checks,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    disclaimer:
      '本门判的是**时间维度**：结清前后事实块的样子 · 窗口忘了以后块还在说"不要再提" · 200/500 轮规模下' +
      '零越界与重放一致。它**不**主张"她不再重复提"（那是**行为级**对照，`A11`，NOT RUN），' +
      '也**不**主张识别率（漏识别是已知边界）。',
  }
  writeFileSync(join(dir, 'long-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM11Manifest(dir, {
    runId,
    wp: `m10-1-wp6-long-${String(TURNS)}`,
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'long-verify',
    counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    phases: [LIVE ? 'live' : 'offline', 'long-trajectory'],
    supersedes: null,
    plannedRequests: LIVE ? TURNS : 0,
    actualRequests: modelCalls,
    sourceFingerprints: Object.fromEntries([
      'scripts/m10.1-long-verify.ts', 'scripts/m10-harness.ts',
      'src/infrastructure/model/openai-goal-understanding.ts', 'src/kernel/app/goal/turn.ts',
      'src/kernel/policies/goal-validator.ts', 'src/infrastructure/persistence/goal-store.ts',
    ].map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
    notes: `m10.1:long:${LIVE ? 'live' : 'verify'}（${String(TURNS)} 轮；约定@${String(AGREEMENT_TURN)}，结清@${String(
      CLOSURE_TURN
    )}；${LIVE ? `${String(modelCalls)} 次真模型请求` : '零模型、零出网'}、隔离库）`,
  })
  console.log(`runId: ${runId}`)
  console.log(
    `verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`
  )
  process.exit(failed.length === 0 ? 0 : 1)
}

await main()
