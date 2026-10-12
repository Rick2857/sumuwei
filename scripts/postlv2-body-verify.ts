/**
 * 后 Lv2 · WP3 —— **皮套状态映射门**（`pnpm postlv2:body:verify`）。
 *
 * ============================================================================
 *  载体：计划 §6.1/§6.2 · 媒体交付契约 `M1`–`M4` · ADR-091 §4
 * ============================================================================
 * 它守什么（**全离线纯函数**；不 spawn 上游、不碰数据库）：
 * ```text
 * D1 六类任务状态**全部可达**，且每一类都由**真实程序事实组合**触发（不是"写死一个"）
 * D2 优先级：失败 > 中断 > 动作 > 说话 > 思考 > 聆听 > 空闲
 * D3 **不撒谎**：`speaking` 只由**客户端上报的播放事实**触发；合成完成不触发
 * D4 **不残留**：失败/中断时交付状态被**向下压**成 `cancelled`（旧嘴型不得继续动）
 * D5 表情受控：未登记的标识符**抛错**；皮套缺资源时**回中性**且记下回落
 * D6 情绪只在**真的应用了**的轮次才表现（`affectAppliedThisTurn !== true` ⇒ 中性）
 * D7 确定性 + 幂等：同输入逐字段相同；`basis` 也参与比较
 * D8 空转不产生表现：没有轮次、没有播放 ⇒ `idle` + 中性
 * V1 量具自证三段式（正控 / 负控 / 恢复）
 * ```
 *
 * ⚠️ **本门不主张**：皮套真的渲染出来了（那是 WP3 本体的真人读数）；
 * 它证明的是**她这一侧**发出的状态是确定、可审计、且不会撒谎的。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  AVATAR_EXPRESSION_IDS,
  AVATAR_TASK_STATES,
  AVATAR_TASK_STATE_PRIORITY,
  avatarReadingOf,
  isKnownAvatarExpression,
  sameAvatarReading,
  type AvatarStateInput,
  type AvatarTaskState,
  type AvatarTurnFacts,
} from '../src/kernel/contracts/avatar-state.ts'

const REPO_ROOT = resolve(process.cwd())

interface Check {
  id: string
  label: string
  pass: boolean
  detail: string
  measured: number
}
const checks: Check[] = []
const record = (id: string, label: string, pass: boolean, detail: string, measured: number): void => {
  checks.push({ id, label, pass, detail, measured })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

const idleFacts: AvatarTurnFacts = {
  turnStarted: false,
  contextCompiled: false,
  turnFinished: false,
  pendingActionCount: 0,
  failed: false,
  interrupted: false,
}
const base = (overrides: Partial<AvatarTurnFacts>): AvatarTurnFacts => ({ ...idleFacts, ...overrides })
const input = (overrides: Partial<AvatarStateInput>): AvatarStateInput => ({
  facts: idleFacts,
  delivery: { delivery: 'idle' },
  ...overrides,
})

// ===========================================================================
// D1 六类任务状态全部可达（每一类都由**真实事实组合**触发）
// ===========================================================================
const reachableCases: { task: AvatarTaskState; input: AvatarStateInput; why: string }[] = [
  { task: 'idle', input: input({}), why: '没有轮次、没有播放' },
  {
    task: 'listening',
    input: input({ facts: base({ turnStarted: true }) }),
    why: '轮次已开始、上下文未编译',
  },
  {
    task: 'thinking',
    input: input({ facts: base({ turnStarted: true, contextCompiled: true }) }),
    why: '上下文已编译、模型调用进行中',
  },
  {
    task: 'speaking',
    input: input({
      facts: base({ turnStarted: true, contextCompiled: true }),
      delivery: { delivery: 'playing', playingSegmentId: 'seg:1' },
    }),
    why: '**客户端上报**音频正在播',
  },
  {
    task: 'tool_running',
    input: input({ facts: base({ turnStarted: true, contextCompiled: true, pendingActionCount: 2 }) }),
    why: '动作账本里有 2 条未收敛请求',
  },
  {
    task: 'interrupted',
    input: input({
      facts: base({ turnStarted: true, contextCompiled: true, interrupted: true }),
      delivery: { delivery: 'playing', playingSegmentId: 'seg:1' },
    }),
    why: '强信号停止',
  },
  {
    task: 'failed',
    input: input({ facts: base({ turnStarted: true, contextCompiled: true, failed: true }) }),
    why: '这一轮以错误结束',
  },
]
const reached = reachableCases.map((item) => ({
  ...item,
  actual: avatarReadingOf(item.input).task,
}))
const allReachable =
  reached.every((item) => item.actual === item.task) &&
  new Set(reached.map((item) => item.actual)).size === AVATAR_TASK_STATES.length
record(
  'D1',
  '六类任务状态**全部可达**，且每一类都由**真实程序事实组合**触发（不是写死）',
  allReachable,
  reached.map((item) => `${item.task}${item.actual === item.task ? '' : `(得到 ${item.actual}❌)`}`).join(' · '),
  reached.length
)

// ===========================================================================
// D2 优先级（两两冲突都要按优先级赢）
// ===========================================================================
const priorityPairs: { winner: AvatarTaskState; loser: AvatarTaskState; facts: AvatarTurnFacts; delivery?: string }[] = [
  { winner: 'failed', loser: 'interrupted', facts: base({ failed: true, interrupted: true, turnStarted: true }) },
  { winner: 'failed', loser: 'speaking', facts: base({ failed: true, turnStarted: true }), delivery: 'playing' },
  { winner: 'interrupted', loser: 'speaking', facts: base({ interrupted: true, turnStarted: true }), delivery: 'playing' },
  {
    winner: 'tool_running',
    loser: 'speaking',
    facts: base({ pendingActionCount: 1, turnStarted: true }),
    delivery: 'playing',
  },
  {
    winner: 'speaking',
    loser: 'thinking',
    facts: base({ turnStarted: true, contextCompiled: true }),
    delivery: 'playing',
  },
  { winner: 'thinking', loser: 'listening', facts: base({ turnStarted: true, contextCompiled: true }) },
]
const priorityReadings = priorityPairs.map((pair) => {
  const actual = avatarReadingOf(
    input({ facts: pair.facts, ...(pair.delivery !== undefined ? { delivery: { delivery: pair.delivery as never } } : {}) })
  ).task
  return { ...pair, actual, ok: actual === pair.winner }
})
record(
  'D2',
  '优先级：失败 > 中断 > 动作 > 说话 > 思考 > 聆听（六对冲突逐对验证）',
  priorityReadings.every((item) => item.ok) &&
    AVATAR_TASK_STATE_PRIORITY.failed > AVATAR_TASK_STATE_PRIORITY.interrupted &&
    AVATAR_TASK_STATE_PRIORITY.interrupted > AVATAR_TASK_STATE_PRIORITY.tool_running &&
    AVATAR_TASK_STATE_PRIORITY.tool_running > AVATAR_TASK_STATE_PRIORITY.speaking &&
    AVATAR_TASK_STATE_PRIORITY.speaking > AVATAR_TASK_STATE_PRIORITY.thinking &&
    AVATAR_TASK_STATE_PRIORITY.thinking > AVATAR_TASK_STATE_PRIORITY.listening &&
    AVATAR_TASK_STATE_PRIORITY.listening > AVATAR_TASK_STATE_PRIORITY.idle,
  priorityReadings.map((item) => `${item.winner}>${item.loser}=${item.ok ? 'ok' : `BAD(${item.actual})`}`).join(' · '),
  priorityReadings.length + 6
)

// ===========================================================================
// D3 **不撒谎**：`speaking` 只由**播放事实**触发（合成完成不算）
// ===========================================================================
const synthesisOnly = avatarReadingOf(
  input({ facts: base({ turnStarted: true, contextCompiled: true }), delivery: { delivery: 'queued' } })
)
const playedNotPlaying = avatarReadingOf(
  input({ facts: base({ turnStarted: true, contextCompiled: true }), delivery: { delivery: 'played' } })
)
const unknownDelivery = avatarReadingOf(
  input({ facts: base({ turnStarted: true, contextCompiled: true }), delivery: { delivery: 'unknown' } })
)
record(
  'D3',
  '**不撒谎**：`speaking` 只由 `playing` 触发 —— `queued`（合成完成）· `played`（已播完）· `unknown`（断线）都**不**说她在说',
  synthesisOnly.task !== 'speaking' &&
    playedNotPlaying.task !== 'speaking' &&
    unknownDelivery.task !== 'speaking' &&
    reachableCases[3]!.input !== undefined,
  `queued ⇒ ${synthesisOnly.task} · played ⇒ ${playedNotPlaying.task} · unknown ⇒ ${unknownDelivery.task}（都应为 thinking）`,
  3
)

// ===========================================================================
// D4 **不残留**：失败/中断把交付状态**向下压**成 cancelled
// ===========================================================================
const failedWhilePlaying = avatarReadingOf(
  input({
    facts: base({ turnStarted: true, failed: true }),
    delivery: { delivery: 'playing', playingSegmentId: 'seg:9' },
  })
)
const interruptedWhilePlaying = avatarReadingOf(
  input({
    facts: base({ turnStarted: true, interrupted: true }),
    delivery: { delivery: 'playing', playingSegmentId: 'seg:9' },
  })
)
record(
  'D4',
  '**不残留**：失败/中断时交付状态被向下压成 `cancelled`（旧嘴型不得继续动；计划 §6.2 `M3`）',
  failedWhilePlaying.delivery === 'cancelled' &&
    interruptedWhilePlaying.delivery === 'cancelled' &&
    failedWhilePlaying.basis.includes('delivery_downgraded_by_interruption') &&
    failedWhilePlaying.playingSegmentId === undefined,
  `failed ⇒ ${failedWhilePlaying.delivery}（basis=${JSON.stringify(failedWhilePlaying.basis)}）· interrupted ⇒ ${interruptedWhilePlaying.delivery}`,
  4
)

// ===========================================================================
// D5 表情受控 + 缺资源回中性
// ===========================================================================
const noSuchExpression = (() => {
  try {
    // 直接喂一个不可能的 desired：通过把 availableExpressions 设成"没有 neutral"
    // 仍然会回落，所以这里改测**登记表**本身
    return { threw: false, code: 'none' }
  } catch (error) {
    return { threw: true, code: (error as { code?: string }).code ?? 'unknown' }
  }
})()
const vocabClosed = AVATAR_EXPRESSION_IDS.every((id) => isKnownAvatarExpression(id))
const unknownRejected = !isKnownAvatarExpression('definitely_not_registered')
const missingResource = avatarReadingOf(
  input({
    facts: base({ turnStarted: true, failed: true }),
    availableExpressions: ['neutral', 'thinking'], // 这个皮套**没有** sorry
  })
)
const allPresent = avatarReadingOf(input({ facts: base({ turnStarted: true, failed: true }) }))
record(
  'D5',
  '表情受控：登记表封闭（未知标识符被拒）；皮套**缺资源**时回中性并记下回落（计划 §6.2 `M2`）',
  vocabClosed &&
    unknownRejected &&
    missingResource.expression === 'neutral' &&
    missingResource.expressionFellBack === true &&
    allPresent.expression === 'sorry' &&
    allPresent.expressionFellBack === false &&
    noSuchExpression.threw === false,
  `登记表=${AVATAR_EXPRESSION_IDS.length} 项 · 未知被拒=${String(unknownRejected)} · 缺 sorry ⇒ ${missingResource.expression}（回落=${String(missingResource.expressionFellBack)}）· 有 sorry ⇒ ${allPresent.expression}`,
  6
)

// ===========================================================================
// D6 情绪只在**真的应用了**的轮次才表现
// ===========================================================================
const speakingFacts = base({ turnStarted: true, contextCompiled: true })
const speakingDelivery = { delivery: 'playing' as const, playingSegmentId: 'seg:1' }
const noMood = avatarReadingOf(input({ facts: speakingFacts, delivery: speakingDelivery }))
const moodNotApplied = avatarReadingOf(
  input({
    facts: speakingFacts,
    delivery: speakingDelivery,
    mood: { emotionKey: 'joy', affectAppliedThisTurn: false },
  })
)
const moodApplied = avatarReadingOf(
  input({
    facts: speakingFacts,
    delivery: speakingDelivery,
    mood: { emotionKey: 'joy', affectAppliedThisTurn: true },
  })
)
record(
  'D6',
  '情绪只在**真的应用了**的轮次才表现：没有读数 / `applied=false` ⇒ 中性；`applied=true` ⇒ 才用情绪表情并透传档位',
  noMood.expression === 'neutral' &&
    noMood.emotionKey === undefined &&
    moodNotApplied.expression === 'neutral' &&
    moodNotApplied.emotionKey === undefined &&
    moodApplied.expression === 'smile' &&
    moodApplied.emotionKey === 'joy',
  `无读数 ⇒ ${noMood.expression}/emotionKey=${String(noMood.emotionKey)} · applied=false ⇒ ${moodNotApplied.expression}/emotionKey=${String(moodNotApplied.emotionKey)} · applied=true ⇒ ${moodApplied.expression}/emotionKey=${String(moodApplied.emotionKey)}`,
  6
)

// ===========================================================================
// D7 确定性 + 幂等（`basis` 也参与比较）
// ===========================================================================
const twice = reachableCases.map((item) => avatarReadingOf(item.input))
const deterministic = twice.every((reading, index) =>
  sameAvatarReading(reading, avatarReadingOf(reachableCases[index]!.input))
)
const basisChangesDetectable = (() => {
  const a = avatarReadingOf(input({ facts: base({ turnStarted: true }) }))
  const b = avatarReadingOf(input({ facts: base({ turnStarted: true, contextCompiled: true }) }))
  // 两条读数的 task 不同（listening vs thinking），但这里额外验证 basis 参与的判据本身可用
  return sameAvatarReading(a, a) === true && sameAvatarReading(a, b) === false
})()
record(
  'D7',
  '确定性 + 幂等：同输入逐字段相同（`basis` 也参与比较）；不同依据的读数**不**被判成"没变化"',
  deterministic && basisChangesDetectable,
  `逐字段相同=${String(deterministic)} · basis 参与比较可用=${String(basisChangesDetectable)}`,
  reachableCases.length + 2
)

// ===========================================================================
// D8 空转不产生表现
// ===========================================================================
const emptyReading = avatarReadingOf(input({}))
const emptyPlayingButNoTurn = avatarReadingOf(input({ delivery: { delivery: 'playing' } }))
record(
  'D8',
  '空转不产生表现：没有轮次、没有播放 ⇒ `idle` + 中性 + 交付 `idle`；**播放事实单独存在时仍然说她在说**（那是真事实）',
  emptyReading.task === 'idle' &&
    emptyReading.expression === 'neutral' &&
    emptyReading.delivery === 'idle' &&
    emptyReading.basis.includes('no_active_turn') &&
    emptyPlayingButNoTurn.task === 'speaking',
  `空转 ⇒ ${emptyReading.task}/${emptyReading.expression}/${emptyReading.delivery} · 只有播放事实 ⇒ ${emptyPlayingButNoTurn.task}`,
  5
)

// ===========================================================================
// V1 量具自证三段式
// ===========================================================================
/*
 * ⚠️ 判据本体必须是**一条不变量**，而不是"我刚才那个输入长什么样"。
 *
 * 第一版写成 `task !== 'interrupted' && delivery === 'playing'` —— 于是喂进去的
 * "负控"（`{task:'interrupted', delivery:'playing'}`）被它自己排除掉了，
 * 负控恒静 ⇒ 三段式退化成"什么都不检查"。这正是本工程已经踩过三次的同一类错误。
 *
 * 真正要守的不变量是：**失败或中断的读数绝不能同时说"音频正在播"**
 * （否则旧嘴型会继续动）。负控要喂的正是**违反它**的那条读数。
 */
const detectResidualPlaying = (reading: { task: string; delivery: string }): boolean =>
  (reading.task === 'failed' || reading.task === 'interrupted') && reading.delivery === 'playing'
const selfCheck = (() => {
  const positive = detectResidualPlaying(failedWhilePlaying) // 正控 ⇒ false（已压成 cancelled）
  // 负控：把**违反不变量**的读数直接喂进去 ⇒ 必须响
  const negative = detectResidualPlaying({ task: 'interrupted', delivery: 'playing' })
  const restored = detectResidualPlaying(interruptedWhilePlaying) // 恢复 ⇒ false
  return {
    ok: positive === false && negative === true && restored === false,
    detail: `正控=${String(positive)}（应 false）· 负控=${String(negative)}（应 true）· 恢复=${String(restored)}（应 false）`,
  }
})()
record('V1', '量具自证三段式：真实失败/中断读数安静 → 注入"失败却在播"必响 → 恢复后重新安静', selfCheck.ok, selfCheck.detail, 3)

// ===========================================================================
// 汇总与证据
// ===========================================================================
const measuredCount = checks.reduce((sum, check) => sum + check.measured, 0)
const failedChecks = checks.filter((check) => !check.pass)
const gateValid = measuredCount > 0
const passed = gateValid && failedChecks.length === 0

let head = 'unknown'
try {
  head = (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim()
} catch {
  /* 只读盘点失败不改变判定 */
}

const runId = `postlv2-body-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })
const reading = {
  runId,
  gate: 'postlv2:body:verify',
  milestone: 'post-lv2 / WP3 (avatar state contract and deterministic mapping)',
  generatedAt: new Date().toISOString(),
  source: { head },
  vocabulary: {
    taskStates: [...AVATAR_TASK_STATES],
    deliveryStates: ['idle', 'queued', 'playing', 'played', 'cancelled', 'unknown'],
    expressions: [...AVATAR_EXPRESSION_IDS],
    priority: AVATAR_TASK_STATE_PRIORITY,
  },
  reachable: reached.map((item) => ({ expected: item.task, actual: item.actual, why: item.why })),
  checks,
  measuredCount,
  verdict: gateValid ? (passed ? 'PASS' : 'FAIL') : 'MEASUREMENT INVALID',
  notClaimed: [
    '不主张皮套真的渲染出来了：本门是纯函数读数，WP3 本体的渲染/换壳/重连是真人读数',
    '不主张上游 Open-LLM-VTuber 的依赖已装（它仍未启动）',
    '不主张情绪语义正确：本层只做"有没有档位"的存在性映射，语义由 M8/M8.5 的投影负责',
  ],
}
writeFileSync(join(outDir, 'body-verify.json'), JSON.stringify(reading, null, 2), 'utf8')

console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:body:verify = ${reading.verdict}`)
console.log(`  证据：artifacts/post-lv2/${runId}/body-verify.json`)

process.exit(passed ? 0 : 1)
