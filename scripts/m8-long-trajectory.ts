/**
 * M8 WP7 —— **1×500 长轨迹生成器**（纯函数，零 DB；`m8:long:verify` 的开跑闸）。
 *
 * 与 M7 的 `m7-long-trajectory.ts` 同构：冻结位置 + 冻结文本 + 不变量自证。
 * 轨迹版本：m8-long-corpus@1。
 *
 * 覆盖（计划 §11.5）：
 *   · 中性（casual 池零命中）/ 正向（感谢/修复/温暖/安慰）/ 负向（敌意/拒绝）/
 *     恢复（敌意块后的修复块）/ 长间隔（+12h 读时衰减）；
 *   · 重复消息（同类文本多次出现）与重启探针（restart_probe）；
 *   · 边界附近 delta（连续敌意块把 v 压向 −1、a 顶向 1；夹紧由 reducer 保证）；
 *   · 每轮最多一个 impact（主导规则族去重——构造性保证，自证闸再验一遍）；
 *   · 失败注入位（failure_retry：该轮注入 store 失败，恢复后恰一次应用）。
 *
 * 这里**只生成与自证**；跑轨迹的是 `m8-long-verify.ts`（隔离库 + 真网关）。
 * 长轨迹是稳定性/可重放证据，不是"情绪智能"的主观证明（计划 §11.5 原文）。
 */
import {
  dominantAffectRuleFamily,
  matchAffectPatterns,
} from '../src/kernel/app/affect/patterns.ts'

export const M8_TRAJECTORY_TURNS = 500
export const M8_LONG_CORPUS_VERSION = 'm8-long-corpus@1'

/** 检查点（跑轨迹时全量断言 + 落盘快照的位置） */
export const M8_CHECKPOINTS: readonly number[] = [
  1, 50, 100, 150, 200, 207, 209, 212, 250, 300, 350, 400, 450, 500,
]

// ---- 冻结文本（一个概念一处实现；与 e2e 语料同词形但独立冻结）----
export const GRATITUDE_TEXT = '谢谢你陪我聊这些。'
export const REPAIR_TEXT = '对不起，刚才是我说话太冲了。'
export const WARM_TEXT = '想你了，最近怎么样。'
export const COMFORT_TEXT = '别难过，事情会过去的。'
export const HOSTILE_TEXT = '我讨厌你，你真差劲。'
export const REJECTION_TEXT = '我们分手吧，不要联系了。'
export const URGENT_TEXT = '紧急情况，快点回复我。'

// ---- 冻结位置 ----
export const GRATITUDE_POSITIONS: readonly number[] = [30, 130, 210, 330, 430]
export const REPAIR_POSITIONS: readonly number[] = [45, 145, 211, 212, 345]
export const WARM_POSITIONS: readonly number[] = [60, 160, 260, 360]
export const COMFORT_POSITIONS: readonly number[] = [75, 175, 275, 375]
export const REJECTION_POSITIONS: readonly number[] = [90, 190, 290, 390]
export const URGENT_POSITIONS: readonly number[] = [95, 195, 395, 405, 415, 425, 435, 445, 455, 465]
/**
 * 边界块：连续敌意把 v 压向 −1、a 顶向 1（reducer 夹紧）。
 * 块前 v≈+0.31（前段正负相抵后余量）⇒ 10 连击 −0.15 在第 208 轮触底 −1.0；
 * a（紧急余量 0.10 + 每击 +0.12）在第 207 轮顶到 1.0——**真的碰到夹紧**，
 * 不是"在边界附近看看"。
 */
export const HOSTILE_POSITIONS: readonly number[] = [
  200, 201, 202, 203, 204, 205, 206, 207, 208, 209,
]
/** 长间隔：该轮前 +12h（读时衰减；域事件零增长） */
export const LONG_GAP_POSITIONS: readonly number[] = [100, 300]
/** 重启探针：该轮前再调度一次（no_tail + revision 不动） */
export const RESTART_PROBE_POSITIONS: readonly number[] = [150, 250, 350, 450]
/** 失败注入位：该轮同轮评估注入 store 写失败；轮后追赶恢复（恰一次） */
export const FAILURE_RETRY_POSITIONS: readonly number[] = [210]

/** 中性填充池（零命中——由不变量自证闸证明，不靠目测） */
export const CASUAL_POOL: readonly string[] = [
  '今天课排得满满的。',
  '食堂新出了番茄牛腩，排队的人超多。',
  '下午在图书馆占了靠窗的位置。',
  '晚风很舒服，绕操场走了两圈。',
  '把宿舍的绿萝换了个大盆。',
  '早上差点睡过头，跑着去的教学楼。',
  '同学借了我的笔记，说好明天还。',
  '晚上煮了碗面，加了个蛋。',
  '路过琴房，有人在弹久石让。',
  '把下周的作业提前写完了。',
  '手机膜碎了，去换了一张。',
  '在阳台晒了被子，晚上睡觉都是太阳味。',
  '奶茶店的新品太甜了，下次要三分糖。',
  '帮室友带了一份炒饭。',
  '晚上去操场跑了三圈，累瘫。',
  '图书馆闭馆音乐响了才走。',
  '把桌面收拾干净了，心情也清爽。',
  '下午的课老师拖堂了十分钟。',
  '在二手群淘到一个书架。',
  '睡前看了两章小说。',
]

export type M8TurnKind =
  | 'casual'
  | 'gratitude'
  | 'repair'
  | 'warm'
  | 'comfort'
  | 'hostile'
  | 'rejection'
  | 'urgent'
  | 'long_gap'
  | 'restart_probe'
  | 'failure_retry'

export interface M8TurnScript {
  readonly index: number
  readonly userText: string
  readonly kind: M8TurnKind
  /** 期望命中的主导规则族（casual/long_gap/restart_probe 为空） */
  readonly expectedRule: string | undefined
  readonly checkpoint: boolean
  /** 该轮前的时间跳变（ms；长间隔位 = 12h） */
  readonly timeJumpMs: number
}

/** 生成 500 轮脚本（纯函数：同输入同输出，可指纹） */
export function buildM8Trajectory(): { turns: readonly M8TurnScript[] } {
  const turns: M8TurnScript[] = []
  let casualCursor = 0
  const nextCasual = (): string => {
    const text = CASUAL_POOL[casualCursor % CASUAL_POOL.length] ?? ''
    casualCursor += 1
    return text
  }

  for (let index = 1; index <= M8_TRAJECTORY_TURNS; index += 1) {
    let kind: M8TurnKind = 'casual'
    let userText = nextCasual()
    let expectedRule: string | undefined
    let timeJumpMs = 0

    if (GRATITUDE_POSITIONS.includes(index)) {
      kind = index === 210 ? 'failure_retry' : 'gratitude'
      userText = GRATITUDE_TEXT
      expectedRule = 'A-GRATITUDE'
    } else if (REPAIR_POSITIONS.includes(index)) {
      kind = 'repair'
      userText = REPAIR_TEXT
      expectedRule = 'A-REPAIR'
    } else if (WARM_POSITIONS.includes(index)) {
      kind = 'warm'
      userText = WARM_TEXT
      expectedRule = 'A-WARM-CONTACT'
    } else if (COMFORT_POSITIONS.includes(index)) {
      kind = 'comfort'
      userText = COMFORT_TEXT
      expectedRule = 'A-COMFORT'
    } else if (HOSTILE_POSITIONS.includes(index)) {
      kind = 'hostile'
      userText = HOSTILE_TEXT
      expectedRule = 'A-HOSTILE'
    } else if (REJECTION_POSITIONS.includes(index)) {
      kind = 'rejection'
      userText = REJECTION_TEXT
      expectedRule = 'A-REJECTION'
    } else if (URGENT_POSITIONS.includes(index)) {
      kind = 'urgent'
      userText = URGENT_TEXT
      expectedRule = 'A-URGENT'
    }

    // 修饰位（不改变上面的词形/规则期望，只叠加时间/调度行为）
    if (LONG_GAP_POSITIONS.includes(index)) {
      timeJumpMs = 12 * 3_600_000
      if (kind === 'casual') kind = 'long_gap'
    } else if (RESTART_PROBE_POSITIONS.includes(index)) {
      if (kind === 'casual') kind = 'restart_probe'
    }

    turns.push({
      index,
      userText,
      kind,
      expectedRule,
      checkpoint: M8_CHECKPOINTS.includes(index),
      timeJumpMs,
    })
  }
  return { turns }
}

// ---------------------------------------------------------------------------
// 不变量自证（开跑闸；任何一条破损 ⇒ 拒绝开跑——量具有效性先于读数）
// ---------------------------------------------------------------------------

export interface M8InvariantReport {
  readonly ok: boolean
  readonly problems: readonly string[]
  readonly fingerprint: string
}

export function checkM8TrajectoryInvariants(turns: readonly M8TurnScript[]): M8InvariantReport {
  const problems: string[] = []

  // ① 规模
  if (turns.length !== M8_TRAJECTORY_TURNS) {
    problems.push(`轮数 ${String(turns.length)} ≠ ${String(M8_TRAJECTORY_TURNS)}`)
  }

  // ② 事件位恰为冻结位置
  const positionsOf = (kind: M8TurnKind): number[] =>
    turns.filter((t) => t.kind === kind).map((t) => t.index)
  const expectPositions = (kind: M8TurnKind, frozen: readonly number[]): void => {
    const actual = positionsOf(kind)
    if (JSON.stringify(actual) !== JSON.stringify([...frozen].sort((a, b) => a - b))) {
      problems.push(`${kind} 位置 ${actual.join('/')} ≠ 冻结 ${[...frozen].sort((a, b) => a - b).join('/')}`)
    }
  }
  expectPositions('gratitude', GRATITUDE_POSITIONS.filter((p) => p !== 210))
  expectPositions('repair', REPAIR_POSITIONS)
  expectPositions('warm', WARM_POSITIONS)
  expectPositions('comfort', COMFORT_POSITIONS)
  expectPositions('hostile', HOSTILE_POSITIONS)
  expectPositions('rejection', REJECTION_POSITIONS)
  expectPositions('urgent', URGENT_POSITIONS)
  expectPositions('long_gap', LONG_GAP_POSITIONS)
  expectPositions('restart_probe', RESTART_PROBE_POSITIONS)
  expectPositions('failure_retry', FAILURE_RETRY_POSITIONS)

  // ③ 词形命中形状：事件位 = 恰命中期望规则族；中性位 = 零命中
  for (const turn of turns) {
    const matches = matchAffectPatterns(turn.userText)
    const dominant = dominantAffectRuleFamily(turn.userText)
    if (turn.expectedRule !== undefined) {
      if (dominant?.ruleId !== turn.expectedRule) {
        problems.push(
          `t${String(turn.index)}（${turn.kind}）主导规则 ${String(dominant?.ruleId)} ≠ 期望 ${turn.expectedRule}`
        )
      }
      // 每轮最多一个 impact 的构造性前提：所有命中同属一个规则族
      const families = new Set(matches.map((m) => m.ruleId))
      if (families.size > 1) {
        problems.push(`t${String(turn.index)} 跨族命中 ${[...families].join('/')}（违反单 impact 前提）`)
      }
    } else if (matches.length > 0) {
      problems.push(
        `t${String(turn.index)}（${turn.kind}）中性文本命中 ${matches.map((m) => m.patternId).join(',')}`
      )
    }
  }

  // ④ 长间隔/重启/失败位不与事件位重叠（行为修饰不吞掉词形事件）
  for (const p of LONG_GAP_POSITIONS) {
    const turn = turns.find((t) => t.index === p)
    if (turn !== undefined && turn.timeJumpMs !== 12 * 3_600_000) {
      problems.push(`t${String(p)} 长间隔位缺 12h 跳变`)
    }
  }
  for (const t of turns) {
    if (!LONG_GAP_POSITIONS.includes(t.index) && t.timeJumpMs !== 0) {
      problems.push(`t${String(t.index)} 非长间隔位带时间跳变`)
    }
  }

  // 指纹（冻结语料的可复核性）
  const fingerprintSource = turns
    .map((t) => `${String(t.index)}:${t.kind}:${t.userText}`)
    .join('|')
  let hash = 0
  for (let i = 0; i < fingerprintSource.length; i += 1) {
    hash = (hash * 31 + fingerprintSource.charCodeAt(i)) | 0
  }
  const fingerprint = `m8-long@${(hash >>> 0).toString(16)}`

  return { ok: problems.length === 0, problems, fingerprint }
}
