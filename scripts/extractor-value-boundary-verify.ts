/**
 * M9.7 **取值边界线** / 第 1 轮 —— 取值边界量具（`pnpm extractor:value-boundary:verify`）
 *
 * ============================================================================
 *  它回答什么
 * ============================================================================
 * "**抽出来的那个值，本身是不是一个可用的取值**"。
 *
 * 与另外两道门的分工（**不重复**）：
 * ```text
 *   memory-coverage:verify   可达性：这句话能不能走到"抽出一个已登记槽位"
 *   memory-coverage:e2e      写读：抽出来之后有没有真的落库（Level 2）
 *   本门                     取值：落到槽位里的那个**值**像不像一个值
 * ```
 * ⚠️ **不判取值"正确性"的语义**（"这个专业名对不对"要人读）—— 本门判的是
 *    **结构性的取值边界**：虚词 / 疑问词不是取值、尾部填充语不属于值、线索词回接是**有意**的。
 *
 * ============================================================================
 *  三段式自证（`AGENTS.md` §6.7）+ 计数自检（§6.8）
 * ============================================================================
 * ```text
 *   正控   逐条比对"声明的取值"与"生产判据（wrapper）给出的取值"
 *   负控① **把这一层判据关掉**（直接调 `extractFreeTextValueRaw`）⇒
 *          那两条垃圾取值（「的」「什么时候」）必须**重新出现**
 *          ⇒ 证明这道判据是 load-bearing 的，不是"什么都不检查"
 *   负控② **把"精确等于"换成"包含"** ⇒ 结果集必须**不一样**
 *          ⇒ 证明"精确等于"这个选择是 load-bearing 的（"包含"会误杀合法取值）
 *   恢复   再跑一遍正控 ⇒ 逐字段相同
 * ```
 * ⚠️ **接线证明**：另有一条用例**走 `createRuleOnlyContentExtractor()`**
 *    （生产那一份），证明这层判据**真的接在生产路径上**，而不是一个没人调的纯函数。
 *
 * ⚠️ 本门**不打开数据库**、**不调模型**：它只 import 抽取器（纯函数）⇒
 *    退出码 0 = PASS · 3 = FAIL / MEASUREMENT INVALID。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  VALUE_STOP_SET,
  createRuleOnlyContentExtractor,
  createRuleOnlyContentExtractorWithoutQuestionGuard,
  extractFreeTextValue,
  extractFreeTextValueRaw,
  isQuestionLike,
} from '../src/kernel/app/memory/content-extractor.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import {
  DB_TOUCHED,
  MC_CONTRACT_VERSION,
  REPO_ROOT,
  dirtyPaths,
  gitOrNull,
  makeRunId,
  selfCheckMeasurement,
  sha256,
  sourceTreeReading,
  writeManifestAtomic,
  writePayload,
} from './memory-coverage-evidence.ts'

const STARTED_AT = new Date().toISOString()
const RUN_ID = makeRunId('extractor-value-boundary')
const INSTRUMENT_VERSION = 'extractor-value-boundary@1'
const CONTRACT_VERSION = 'value-boundary-contract@1'
const ARTIFACT_ROOT = join(REPO_ROOT, 'artifacts', 'extractor-value-boundary')

/* ⚠️ entityId 只允许字母数字与 `_ - :` */
const OWNER = entityRef('character', 'value-boundary-verify')
const SPEAKER = entityRef('user', 'value-boundary-verify')

// ---------------------------------------------------------------------------
// 用例（每条都带出处）
// ---------------------------------------------------------------------------

interface Case {
  readonly id: string
  /** 抽取器看到的文本（= 意图 payload，**不含**「记住，」那一段） */
  readonly payload: string
  readonly cue: string
  readonly cueInValue?: boolean
  /** `{ value }` = 期望得到一个值；`{ none: true }` = 期望**判定它不是取值** */
  readonly expect: { readonly value: string } | { readonly none: true }
  /** `fixed` = 本轮修好的；`control` = 正控（本来就对）；`known-unfixed` = 特征化（如实记下今天的行为） */
  readonly kind: 'fixed' | 'control' | 'known-unfixed'
  readonly provenance: string
  readonly note: string
}

const CASES: readonly Case[] = [
  {
    id: 'vb-01-tail-filler',
    payload: '叫我 Alex 就行',
    cue: '叫我',
    expect: { value: 'Alex' },
    kind: 'fixed',
    provenance: 'registry-example:preferred.address（「叫我 Alex 就行」）',
    note: '✅ 本轮修好：尾部填充语「就行」不再属于取值（原先取值是「Alex 就行」）',
  },
  {
    id: 'vb-02-stop-particle',
    payload: '我不是计算机专业的',
    cue: '专业',
    expect: { none: true },
    kind: 'fixed',
    provenance: 'registry-example:education.major 的第 2 个例子',
    note: '✅ 本轮修好：原先记下的是**虚词取值**「的」⇒ 现在**终止**抽取、如实回未解析。⚠️ **有意的覆盖损失**（根因：线索表表达不了 qualifier / 否定）',
  },
  {
    id: 'vb-03-stop-question-word',
    payload: '我的生日是什么时候',
    cue: '生日',
    expect: { none: true },
    kind: 'fixed',
    provenance: '语料探针 mc-probe-0001（问句假阳）',
    note: '✅ 本轮修好：疑问词「什么时候」不是一个取值 ⇒ 那条问句假阳**不再落库**（`L-M97-02` 收窄，未关闭）',
  },
  {
    id: 'vb-04-major-after-cue',
    payload: '我学的是计算机',
    cue: '学的是',
    expect: { value: '计算机' },
    kind: 'control',
    provenance: 'registry-example:education.major 的第 1 个例子',
    note: '正控：往后的形式里线索词是**引导词**，不属于取值',
  },
  {
    id: 'vb-05-institution-before-cue',
    payload: '我在示例工程科技大学',
    cue: '大学',
    cueInValue: true,
    expect: { value: '示例工程科技大学' },
    kind: 'control',
    provenance: 'ADR-056 §4 的实测清单',
    note: '正控：往前的形式里线索词是**值的一部分**（`beforeCueValue` **有意**把线索词接回来）',
  },
  {
    id: 'vb-06-device-adr056-value',
    payload: '我平时用的是 Windows 笔记本',
    cue: '用的是',
    expect: { value: 'Windows 笔记本' },
    kind: 'control',
    provenance: 'ADR-056 §4 的实测清单',
    note: '正控：ADR-056 修好的那一条；本门守着它不被后续改动弄坏',
  },
  {
    id: 'vb-07-known-unfixed-segmentation',
    payload: '我在做一个角色 Agent 的项目',
    cue: '项目',
    expect: { value: '的项目' },
    kind: 'known-unfixed',
    provenance: 'registry-example:project.background.active 的第 1 个例子',
    note: '⚠️ **特征化（未修）**：`beforeCueValue` 只取**最后一个空白段** ⇒ 中文+拉丁混排时把「的」当成了名字。修它要改**分段**逻辑（本 ADR 明确不做）⇒ 修好之后本门**会报红**，强制回来更新',
  },
  {
    id: 'vb-08-known-unfixed-cue-is-value',
    payload: '我用的编辑器是 neovim',
    cue: 'neovim',
    expect: { value: '用的编辑器是neovim' },
    kind: 'known-unfixed',
    provenance: '语料 mc-supported-0012（槽位 tooling.preference.editor）',
    note: '⚠️ **特征化（未修）**：取值本身（`neovim`）**也在线索表里** ⇒ `best` 取最长线索词把它当线索词 ⇒ "往前"那一支把整句粘回来。**同一个机制**造成了实测的「Windows 笔记本 → 笔记本」回归（`L-M97-14`）',
  },
]

// ---------------------------------------------------------------------------
// 读数
// ---------------------------------------------------------------------------

type Verdict = { readonly kind: 'value'; readonly value: string } | { readonly kind: 'none' }

function readWith(caseItem: Case, useRaw: boolean, substringVariant = false): Verdict {
  const raw = useRaw
    ? extractFreeTextValueRaw(caseItem.payload, caseItem.cue, caseItem.cueInValue === true)
    : extractFreeTextValue(caseItem.payload, caseItem.cue, caseItem.cueInValue === true)
  if (raw === undefined) return { kind: 'none' }
  if (substringVariant) {
    /* 负控②：把"精确等于"换成"**包含**" */
    for (const stop of VALUE_STOP_SET) {
      if (raw.includes(stop)) return { kind: 'none' }
    }
  }
  return { kind: 'value', value: raw }
}

function matches(verdict: Verdict, expect: Case['expect']): boolean {
  if ('none' in expect) return verdict.kind === 'none'
  return verdict.kind === 'value' && verdict.value === expect.value
}

function describe(verdict: Verdict): string {
  return verdict.kind === 'none' ? '(判定：不是一个取值)' : JSON.stringify(verdict.value)
}

function section(title: string): void {
  process.stdout.write(`\n=== ${title} ===\n`)
}

function main(): void {
  const failures: string[] = []
  const notes: string[] = []

  // ---- 1. 正控 -----------------------------------------------------------
  section('1. 正控（生产判据给出的取值 vs 声明的取值）')
  const readings = CASES.map((caseItem) => {
    const verdict = readWith(caseItem, false)
    return { caseItem, verdict, agree: matches(verdict, caseItem.expect) }
  })
  const mismatches = readings.filter((reading) => !reading.agree)
  for (const reading of readings) {
    process.stdout.write(
      `  ${reading.agree ? '✅' : '❌'} ${reading.caseItem.id.padEnd(34)} ${reading.caseItem.kind.padEnd(14)} ${describe(reading.verdict)}\n`
    )
  }
  process.stdout.write(
    `  一致 ${String(readings.length - mismatches.length)} / 不一致 ${String(mismatches.length)}\n`
  )
  for (const reading of mismatches) {
    failures.push(
      `${reading.caseItem.id}：期望 ${describe({ kind: 'value', value: 'none' in reading.caseItem.expect ? '' : reading.caseItem.expect.value } as Verdict)}，实测 ${describe(reading.verdict)}`
    )
  }
  const knownUnfixed = readings.filter((reading) => reading.caseItem.kind === 'known-unfixed').length
  if (knownUnfixed > 0) {
    notes.push(
      `本门**如实特征化**了 ${String(knownUnfixed)} 条**未修**的机制（` + readings
        .filter((reading) => reading.caseItem.kind === 'known-unfixed')
        .map((reading) => reading.caseItem.id)
        .join(', ') + '）—— 它们今天就是这个行为；修好之后本门**会报红**'
    )
  }

  // ---- 2. 负控①：关掉判据 ⇒ 垃圾取值必须重新出现 ------------------------
  section('2. 负控①（关掉这层判据 ⇒ 那两条垃圾取值必须重新出现）')
  const judgementOff = readings.filter((reading) => {
    const rawVerdict = readWith(reading.caseItem, true)
    return reading.verdict.kind === 'none' && rawVerdict.kind === 'value'
  })
  const controlOneOk = judgementOff.length >= 2
  process.stdout.write(
    `  关掉判据后"重新变成有值"的用例：${String(judgementOff.length)} 条` +
      `（${judgementOff.map((reading) => reading.caseItem.id).join(', ') || '无'}）⇒ ` +
      `${controlOneOk ? '✅ 判据是 load-bearing 的' : '⛔ **不足 2 条**'}\n`
  )
  for (const reading of judgementOff) {
    process.stdout.write(`     · ${reading.caseItem.id} ⇒ raw 给出 ${describe(readWith(reading.caseItem, true))}\n`)
  }
  if (!controlOneOk) {
    failures.push(
      'negative_control_1_did_not_fire：关掉判据之后，垃圾取值**没有**重新出现 ⇒ ' +
        '本门分不清"判据在起作用"与"本来就没有垃圾取值"'
    )
  }

  // ---- 3. 负控②：换成"包含" ⇒ 结果必须不一样 ---------------------------
  section('3. 负控②（"精确等于" vs "包含" ⇒ 结果集必须不同）')
  const substringReadings = CASES.map((caseItem) => readWith(caseItem, false, true))
  const exactReadings = readings.map((reading) => reading.verdict)
  const differing = CASES.filter(
    (_caseItem, index) => JSON.stringify(substringReadings[index]) !== JSON.stringify(exactReadings[index])
  )
  const controlTwoOk = differing.length > 0
  process.stdout.write(
    `  两种判法读数不同的用例：${String(differing.length)} 条` +
      `（${differing.map((caseItem) => caseItem.id).join(', ') || '无'}）⇒ ` +
      `${controlTwoOk ? '✅ "精确等于"这个选择是 load-bearing 的' : '⛔ **两种判法完全一样**'}\n`
  )
  for (const caseItem of differing) {
    const index = CASES.indexOf(caseItem)
    process.stdout.write(
      `     · ${caseItem.id}：精确=${describe(exactReadings[index])} · 包含=${describe(substringReadings[index])}\n`
    )
  }
  if (!controlTwoOk) {
    failures.push(
      'negative_control_2_did_not_fire："精确等于"与"包含"给出**完全相同**的结果 ⇒ ' +
        '本门无法证明"精确等于"是经过选择的（"包含"会误杀合法取值）'
    )
  }

  // ---- 4. 接线证明（在 async 段里跑，见 `mainAsync`）----------------------
  /* ⚠️ 抽取器是 async ⇒ 那一段放在 `mainAsync`；本函数只做同步的正控与两个负控。 */

  // ---- 5. 计数自检 -------------------------------------------------------
  section('5. 计数自检（measuredCount > 0）')
  const selfCheck = selfCheckMeasurement({
    measuredCount: readings.length,
    notRunCount: 0,
    failedCount: mismatches.length,
  })
  process.stdout.write(`  ${selfCheck.verdict} —— ${selfCheck.reason}\n`)
  if (selfCheck.verdict !== 'PASS') {
    failures.push(`self_check_${selfCheck.verdict}：${selfCheck.reason}`)
  }

  /* 落盘与退出码由 async 的 mainAsync 完成 —— 本函数把中间结果交回去 */
  lastRun = { failures, notes, readings, mismatches, controlOneOk, controlTwoOk, differing, wiringOk: true, selfCheck }
}

interface RunState {
  failures: string[]
  notes: string[]
  readings: { caseItem: Case; verdict: Verdict; agree: boolean }[]
  mismatches: { caseItem: Case; verdict: Verdict; agree: boolean }[]
  controlOneOk: boolean
  controlTwoOk: boolean
  differing: readonly Case[]
  wiringOk: boolean
  selfCheck: ReturnType<typeof selfCheckMeasurement>
  /** ⏩ `L-M97-02`（2026-10-04）：问句守卫的三段式读数 */
  questionGuard?: {
    questions: number
    blocked: number
    counterExamples: number
    notKilled: number
    readings: { id: string; kind: string; ok: boolean; detail: string }[]
  }
}

let lastRun: RunState | undefined

async function mainAsync(): Promise<void> {
  main()
  const state = lastRun
  if (state === undefined) throw new Error('内部错误：main() 没有交出读数')

  // ---- 4（续）. 接线证明（async）-----------------------------------------
  section('4. 接线证明（走 `createRuleOnlyContentExtractor()` ⇒ 判据真的接在生产路径上）')
  const extractor = createRuleOnlyContentExtractor()
  const wiringCases: readonly { id: string; text: string; expectExtracted: boolean }[] = [
    { id: 'wire-reject-stop-particle', text: '记住，我不是计算机专业的', expectExtracted: false },
    { id: 'wire-reject-stop-question', text: '记住，我的生日是什么时候', expectExtracted: false },
    { id: 'wire-accept-good', text: '记住，我学的是计算机', expectExtracted: true },
    { id: 'wire-accept-filler-fixed', text: '记住，叫我 Alex 就行', expectExtracted: true },
  ]
  const wiring: { id: string; ok: boolean; detail: string }[] = []
  for (const item of wiringCases) {
    const result = await extractor.extract({ text: item.text, owner: OWNER, speaker: SPEAKER })
    const extracted = result !== undefined
    const value =
      result === undefined ? null : JSON.stringify((result.content as { value?: unknown }).value)
    const ok = extracted === item.expectExtracted
    wiring.push({
      id: item.id,
      ok,
      detail: `抽到=${String(extracted)} 取值=${String(value)} 期望抽到=${String(item.expectExtracted)}`,
    })
    process.stdout.write(`  ${ok ? '✅' : '❌'} ${item.id.padEnd(30)} ${wiring.at(-1)?.detail ?? ''}\n`)
    if (!ok) {
      state.failures.push(`wiring_${item.id}：生产抽取器的行为与期望不符（${wiring.at(-1)?.detail ?? ''}）`)
    }
  }
  state.wiringOk = wiring.every((entry) => entry.ok)

  // ---- 6. 问句守卫（`L-M97-02`，2026-10-04）三段式 ----------------------
  section('6. 问句守卫（`L-M97-02`）：问句不得被抽成事实 · 反例组不得被误杀')
  const guarded = createRuleOnlyContentExtractor()
  const unguarded = createRuleOnlyContentExtractorWithoutQuestionGuard()
  const questionCases: readonly { id: string; text: string; expectRevival: boolean }[] = [
    /* 判别性正控：取值形态**不在** `VALUE_STOP_SET` 里 ⇒ 旧代码真的会写坏值 */
    { id: 'q-lou', text: '记住，我实验室在哪个楼', expectRevival: true },
    { id: 'q-shihou-ne', text: '记住，我生日是什么时候呢', expectRevival: true },
    { id: 'q-zhuanye-ya', text: '记住，我的专业是什么呀', expectRevival: true },
    { id: 'q-university', text: '记住，我在哪所大学读书？', expectRevival: true },
    /*
     * ⚠️ 这一条今天**已被 `VALUE_STOP_SET` 挡住**（取值恰是「什么时候」）⇒ 摘掉问句守卫它也抽不到
     * ⇒ 对"问句守卫"**零分辨力**。列在这里只为**如实记一笔**（不许拿它当新守卫的证词）。
     */
    { id: 'q-probe-known-无分辨力', text: '记住，我的生日是什么时候', expectRevival: false },
  ]
  const counterCases: readonly { id: string; text: string; expectExtracted: boolean }[] = [
    /* 语气助词「吧」「了」在**合法陈述**里（拿 VALUE_STOP_SET 当问句词表就会误杀这几条） */
    { id: 'c-ba-address', text: '更正一下，还是叫我阿林吧。', expectExtracted: true },
    { id: 'c-ba-lab', text: '还是记一下吧：我的实验室在 A 楼 302。', expectExtracted: true },
    { id: 'c-le-like', text: '记住，我现在能吃香菜了', expectExtracted: true },
    { id: 'c-le-school', text: '更正一下，我转学到明德大学了。', expectExtracted: true },
    /* 任指 / 否定 / 祈使 / 引用（审计逐字要求：不能为拦问句误拒合法引用） */
    { id: 'c-renzhi', text: '随便哪个都行', expectExtracted: false },
    { id: 'c-fou-ding', text: '你今天好像没什么精神，别太勉强自己。', expectExtracted: false },
    { id: 'c-jishi', text: '救命！我家里漏水了，快告诉我总闸在哪！', expectExtracted: false },
    { id: 'c-quote', text: '我同事说"这个方案太保守" —— 我觉得他说得对。', expectExtracted: false },
  ]
  const guardReadings: { id: string; kind: string; ok: boolean; detail: string }[] = []
  for (const item of questionCases) {
    const blocked = (await guarded.extract({ text: item.text, owner: OWNER, speaker: SPEAKER })) === undefined
    /* 负控：**摘掉守卫**之后必须**又**被抽出来（`AGENTS §6.7` 的负控②） */
    const withoutGuard = await unguarded.extract({ text: item.text, owner: OWNER, speaker: SPEAKER })
    const revived = withoutGuard !== undefined
    const ok = blocked && revived === item.expectRevival
    guardReadings.push({
      id: item.id,
      kind: 'question',
      ok,
      detail: `守卫下抽到=${String(!blocked)} · 摘掉守卫后抽到=${String(revived)}（期望 ${String(item.expectRevival)}）`,
    })
    process.stdout.write(`  ${ok ? '✅' : '❌'} ${item.id.padEnd(30)} ${guardReadings.at(-1)?.detail ?? ''}\n`)
    if (!ok) {
      state.failures.push(
        `question_guard_${item.id}：问句守卫读数不符（${guardReadings.at(-1)?.detail ?? ''}；期望：守卫下不抽、摘掉守卫后${item.expectRevival ? '抽到' : '仍不抽'}）`
      )
    }
  }
  for (const item of counterCases) {
    const extracted = (await guarded.extract({ text: item.text, owner: OWNER, speaker: SPEAKER })) !== undefined
    /*
     * 反例组的判据是**两条一起**（审计 :62 逐字："不能为拦问句误拒合法引用"）：
     *   ① 这句话**不得**被判成问句（守卫不是它被挡的原因）；
     *   ② 它的**行为与守卫前一致**（该抽的照样抽得到）。
     */
    const classifiedAsQuestion = isQuestionLike(item.text)
    const ok = !classifiedAsQuestion && extracted === item.expectExtracted
    guardReadings.push({
      id: item.id,
      kind: 'counter-example',
      ok,
      detail: `被判成问句=${String(classifiedAsQuestion)} · 抽到=${String(extracted)}（期望 ${String(item.expectExtracted)}）`,
    })
    process.stdout.write(`  ${ok ? '✅' : '❌'} ${item.id.padEnd(30)} ${guardReadings.at(-1)?.detail ?? ''}\n`)
    if (!ok) {
      state.failures.push(
        `question_guard_${item.id}：反例组被**误杀**或行为改变（被判成问句=${String(classifiedAsQuestion)} · 抽到=${String(extracted)} · 期望抽到=${String(item.expectExtracted)}）`
      )
    }
  }
  const questionBlocked = guardReadings.filter((r) => r.kind === 'question' && r.ok).length
  const counterKept = guardReadings.filter((r) => r.kind === 'counter-example' && r.ok).length
  process.stdout.write(
    `  正控（问句沉默）${String(questionBlocked)}/${String(questionCases.length)} · ` +
      `反例组（不得被误杀）${String(counterKept)}/${String(counterCases.length)}\n`
  )
  /* 计数自检：`AGENTS §6.8` —— 反例组的分母必须 > 0，否则"没误杀"与"什么都没量"同形 */
  if (counterCases.length === 0) {
    state.failures.push('question_guard：反例组为空（MEASUREMENT INVALID：什么都没量）')
  }
  state.questionGuard = {
    questions: questionCases.length,
    blocked: questionBlocked,
    counterExamples: counterCases.length,
    notKilled: counterKept,
    readings: guardReadings,
  }

  // ---- 落盘 -------------------------------------------------------------
  const runDir = join(ARTIFACT_ROOT, RUN_ID)
  const payload = {
    schemaVersion: 'extractor-value-boundary@1',
    runId: RUN_ID,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies:
        '取值这一层：一个虚词 / 疑问词不是一个取值（`VALUE_STOP_SET`，**精确等于**）· ' +
        '尾部填充语不属于值（`normalizeValuePhrase`）· "线索词回接"是**有意**的（正控）。',
      notVerifies:
        '不判取值**语义**正确性（要人读）· 不判可达性（`memory-coverage:verify`）· ' +
        '不判写读（`memory-coverage:e2e`）。' +
        '⏩ 2026-10-04（`L-M97-02`）：**问句守卫已做**（`isQuestionLike()`，`content-rules@7`）⇒ ' +
        '本节从"不判语气/问句"改为**判它**（§6：正控 = 问句沉默 · 负控 = 摘掉守卫必须又抽出来 · ' +
        '反例组 = 含「吧」「了」/任指/祈使/引用的**合法陈述不得被误杀**）。' +
        '**仍不判**：引用/否定/qualifier 表达不了的那部分仍在 `L-M97-02` 的残余里（`DR-11`）。',
      contractVersion: CONTRACT_VERSION,
      mcContractVersion: MC_CONTRACT_VERSION,
      instrumentVersion: INSTRUMENT_VERSION,
      division:
        '与 `memory-coverage:verify`（可达性）和 `memory-coverage:e2e`（写读）**分工不重叠**：本门只管**值**。',
    },
    counts: {
      cases: state.readings.length,
      agree: state.readings.length - state.mismatches.length,
      mismatched: state.mismatches.length,
      fixed: state.readings.filter((r) => r.caseItem.kind === 'fixed').length,
      control: state.readings.filter((r) => r.caseItem.kind === 'control').length,
      knownUnfixed: state.readings.filter((r) => r.caseItem.kind === 'known-unfixed').length,
    },
    selfProof: {
      positiveControl: { cases: state.readings.length, mismatched: state.mismatches.length },
      negativeControl1_judgementOff: {
        ok: state.controlOneOk,
        reappeared: state.readings
          .filter((r) => r.verdict.kind === 'none' && readWith(r.caseItem, true).kind === 'value')
          .map((r) => r.caseItem.id),
      },
      negativeControl2_exactVsSubstring: {
        ok: state.controlTwoOk,
        differing: state.differing.map((caseItem) => caseItem.id),
      },
      wiring: { ok: state.wiringOk, cases: wiring.map((entry) => ({ id: entry.id, ok: entry.ok })) },
    },
    readings: state.readings.map((reading) => ({
      id: reading.caseItem.id,
      kind: reading.caseItem.kind,
      payload: reading.caseItem.payload,
      cue: reading.caseItem.cue,
      cueInValue: reading.caseItem.cueInValue === true,
      expect: reading.caseItem.expect,
      actual: reading.verdict,
      withJudgementOff: readWith(reading.caseItem, true),
      agree: reading.agree,
      provenance: reading.caseItem.provenance,
      note: reading.caseItem.note,
    })),
    failures: state.failures,
    notes: state.notes,
    dbProtection: {
      dbTouched: DB_TOUCHED,
      method: '**构造属性**：本门只 import 抽取器（纯函数）—— 不 import 任何数据库入口、不调模型',
    },
  }
  const payloadHash = writePayload(runDir, 'value-boundary.json', payload)

  const tree = sourceTreeReading(REPO_ROOT)
  const verdict =
    state.failures.length === 0
      ? 'PASS'
      : state.selfCheck.verdict === 'MEASUREMENT INVALID'
        ? 'MEASUREMENT INVALID'
        : 'FAIL'
  const manifestPath = writeManifestAtomic(runDir, {
    schemaVersion: 'extractor-value-boundary-manifest@1',
    runId: RUN_ID,
    stage: 'value-boundary-1',
    lane: 'offline',
    gateVersion: INSTRUMENT_VERSION,
    startedAt: STARTED_AT,
    completedAt: new Date().toISOString(),
    head: gitOrNull(['rev-parse', 'HEAD']),
    headShort: (gitOrNull(['rev-parse', 'HEAD']) ?? '').slice(0, 12),
    branch: gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyPaths: dirtyPaths(),
    sourceTreeHash: tree.treeSha256,
    sourceTreeHashDefinition: tree.definition,
    dbKind: 'not-applicable',
    isolationProof: { dbTouched: false, method: payload.dbProtection.method },
    contractVersion: CONTRACT_VERSION,
    instrumentVersion: INSTRUMENT_VERSION,
    command: [{ cmd: 'pnpm extractor:value-boundary:verify', exitCode: state.failures.length === 0 ? 0 : 3 }],
    exitCode: state.failures.length === 0 ? 0 : 3,
    completion: 'complete',
    usable: verdict === 'PASS',
    verdict,
    measuredCount: state.readings.length,
    notRunCount: 0,
    counts: payload.counts,
    selfProof: payload.selfProof,
    toolVersions: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      git: gitOrNull(['--version']),
    },
    artifactHashes: { 'value-boundary.json': payloadHash },
    supersedes: null,
  })

  process.stdout.write(
    [
      '',
      '──────────────────────────────────────────────────────────────',
      `M9.7 取值边界线 / 第 1 轮：${verdict}`,
      `  用例 ${String(state.readings.length)} 条 · 一致 ${String(state.readings.length - state.mismatches.length)} · 不一致 ${String(state.mismatches.length)}` +
        `（修好 ${String(payload.counts.fixed)} · 正控 ${String(payload.counts.control)} · 特征化未修 ${String(payload.counts.knownUnfixed)}）`,
      ...state.failures.map((line) => `  ✗ ${line}`),
      ...state.notes.map((line) => `  · ${line}`),
      `  自检：${state.selfCheck.verdict} —— ${state.selfCheck.reason}`,
      `  清单：${manifestPath}`,
      '',
    ].join('\n')
  )

  if (state.failures.length > 0) process.exitCode = 3
}

await mainAsync()
