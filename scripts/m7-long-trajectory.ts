/**
 * M7 WP6-B —— **长轨迹剧本（确定性生成器 + 不变量自证）**。
 *
 * 冻结依据：[`M7-WP6-Long-Trajectory-Freeze-Sheet.md`](../../docs/m7/M7-WP6-Long-Trajectory-Freeze-Sheet.md)
 * §1（事件位）+ **§8 勘误**（期望算式含 supersede 反扣；水位判据分列持有点）。
 * 本模块是纯函数：不碰数据库、不碰网络、不碰进程状态。
 *
 * 不变量（`checkM7TrajectoryInvariants`，开跑闸失败关闭）：
 * ```text
 * ① 恰 500 轮；检查点恰为 1/50/100/200/300/400/500；
 * ② 事件位恰为冻结位置（t30/t80/t450=R-2 · t120/t250=R-3 · t150/t280=R-4b）；
 * ③ 事件位文本命中**且仅命中**其意图规则（matchRelationshipPatterns 逐条断言）；
 * ④ 非事件位文本（含 t1 探针与全部填充）**零命中**任何关系词形
 *    （误触 = 关系读数被污染 ⇒ 拒绝开跑，不是跑完再解释）；
 * ⑤ 填充文本不含显式搜索词形（生产 auto_public 已激活，出站会烧预算）。
 * ```
 */

import { createHash } from 'node:crypto'

import { matchRelationshipPatterns } from '../src/kernel/app/relationship/patterns.ts'

// ---------------------------------------------------------------------------
// 轮次类型
// ---------------------------------------------------------------------------

export type M7TurnKind =
  | 'first_turn_probe' // t1 空账本首轮探针（检查点）
  | 'casual' // 日常填充（零关系词形）
  | 'thanks' // R-2 感谢（冻结位）
  | 'accusation' // R-3 指控（冻结位）
  | 'retraction' // R-4b 撤回（冻结位）
  | 'milestone_checkpoint' // R-5 里程碑轮（每 100 轮；检查点）

export interface M7TurnScript {
  readonly index: number
  readonly userText: string
  readonly kind: M7TurnKind
  /** 期望该轮触发的规则（机器后果）；填充轮为空数组 */
  readonly expectedRules: readonly ('r2' | 'r3' | 'r4b' | 'r5')[]
  /** 检查点位置标记（程序读数挂在这上面） */
  readonly checkpoint?: true
}

export const M7_TRAJECTORY_ID = 'M7-REL-1' as const
export const M7_TRAJECTORY_TURNS = 500 as const
export const M7_CHECKPOINTS: readonly number[] = [1, 50, 100, 200, 300, 400, 500]

/** 冻结事件位（freeze sheet §1；kind → 位置） */
const THANKS_POSITIONS: readonly number[] = [30, 80, 450]
const ACCUSATION_POSITIONS: readonly number[] = [120, 250]
const RETRACTION_POSITIONS: readonly number[] = [150, 280]

// ---------------------------------------------------------------------------
// 冻结事件文本（逐字；不变量③断言其命中形状）
// ---------------------------------------------------------------------------

const FIRST_TURN_PROBE = '你好呀，我第一次来找你聊天，有点紧张。'

const THANKS_TEXT = '谢谢你昨晚听我说那些烦心事，今天感觉好多了。'
const ACCUSATION_TEXT = '你骗了我，你明明答应过不告诉别人的。'
const RETRACTION_TEXT = '对不起，我错怪你了，是我自己记错了。'

/** 里程碑轮文本 = 日常填充（R-5 按**合格消息计数**自动触发，不靠词形） */
const MILESTONE_NOTE = '不知不觉都聊了这么久了。'

// ---------------------------------------------------------------------------
// 日常填充池（确定性轮转；全部零关系词形、零显式搜索词形）
// ---------------------------------------------------------------------------

const CASUAL_POOL: readonly string[] = [
  '今天降温了，我把厚外套翻出来了。',
  '食堂二楼新开了个麻辣香锅窗口，排队的人巨多。',
  '早八真的起不来，我在教室后排睡了半节。',
  '图书馆四楼靠窗的位置最好，下午晒得暖洋洋的。',
  '晚上跑了三圈，膝盖有点抗议。',
  '昨晚十二点才睡，今天全靠一口仙气吊着。',
  '我室友又在打游戏，键盘声噼里啪啦的。',
  '周末想去看个展，就是还没约到人。',
  '地铁上人贴人，我被人流推着上的车。',
  '网购的收纳盒到了，质量比图片差远了。',
  '楼下的橘猫又蹲在快递柜上面晒太阳。',
  '我那盆绿萝最近蔫蔫的，不知道是不是浇水多了。',
  '跟朋友开黑打了两把，连跪，心态有点崩。',
  '在读的那本小说到高潮了，昨晚差点熬夜看完。',
  '校门口的咖啡馆换豆子了，味道顺了一点。',
  '兼职排班表出来了，这周只有周末两天。',
  '我妈打电话来问我被子够不够厚。',
  '歌单循环到一首老歌，突然有点感慨。',
  '一个人去看了场电影，散场的时候天都黑了。',
  '手账本写满一本了，新买的还没拆封。',
  '今天风特别大，晾在阳台的衣服差点飞了。',
  '中午吃的番茄鸡蛋面，食堂阿姨手不抖了。',
  '下午没课，在宿舍躺了一下午，有点罪恶感。',
  '快递到了两件，一件要退，颜色跟描述不符。',
  '班群里在接龙报名运动会，我果断潜水。',
  '晚上食堂的糖醋排骨居然没抢完。',
  '骑车路过江边，落日特别好看，可惜没带相机。',
  '在背教资的知识点，背了忘忘了背。',
  '宿舍的热水器又坏了，报修第三回了。',
  '今天上了三节连堂，出来的时候天都灰了。',
  '买了个新保温杯，泡了枸杞，提前养生。',
  '同学借了我的笔记，还回来的时候多了几个折角。',
  '下雨了，我没带伞，在图书馆门口等雨停。',
  '晚上失眠，数羊数到三百多。',
  '把手机壁纸换成了江边的落日。',
  '下午的课点名了，幸好我去了。',
  '洗了一下午衣服，晾衣绳都挂满了。',
  '路过琴房，有人在弹卡农，站在门口听了一会儿。',
  '室友分了我一半西瓜，冰过的，绝了。',
  '新买的笔记本到了，键盘手感真好。',
  '今天走了快两万步，就为了找一家据说很好吃的面馆。',
  '晚上去操场散步，风把云吹开了，能看到星星。',
  '在二手群淘到一个九成新的台灯。',
  '早上被装修的电钻声吵醒的。',
  '下午茶喝了杯热的，暖回来了一点。',
  '帮同学占了个座，结果他睡了一下午。',
  '把冬天的靴子拿出来擦了擦。',
  '今天在课上被点名回答问题，答上来了，惊出一身汗。',
  '晚上和家里人视频，我爸非要看我宿舍的窗台。',
  '买了个小加湿器，宿舍干得嗓子疼。',
  '路过操场看到有人在放风筝。',
  '中午的太阳好到让人想翘课。',
  '把头发剪短了一点，轻快多了。',
  '在便利店买了关东煮，萝卜炖得很透。',
  '晚上背单词背到怀疑人生。',
  '室友的闹钟响了十分钟没人关，是我爬起来关的。',
]

/** 显式搜索词形（生产 auto_public 的触发面；填充池禁用） */
const SEARCH_INTENT_TOKENS: readonly string[] = ['搜索', '搜一下', '查一下', '帮我查', '检索', '查查', '百度', '谷歌']

// ---------------------------------------------------------------------------
// 生成器
// ---------------------------------------------------------------------------

export function buildM7Trajectory(): { turns: readonly M7TurnScript[] } {
  const turns: M7TurnScript[] = []
  let casualCursor = 0
  const nextCasual = (): string => {
    const text = CASUAL_POOL[casualCursor % CASUAL_POOL.length] ?? ''
    casualCursor += 1
    return text
  }

  for (let index = 1; index <= M7_TRAJECTORY_TURNS; index += 1) {
    const isCheckpoint = M7_CHECKPOINTS.includes(index)
    let kind: M7TurnKind = 'casual'
    let userText = nextCasual()
    let expectedRules: ('r2' | 'r3' | 'r4b' | 'r5')[] = []

    if (index === 1) {
      kind = 'first_turn_probe'
      userText = FIRST_TURN_PROBE
    } else if (THANKS_POSITIONS.includes(index)) {
      kind = 'thanks'
      userText = THANKS_TEXT
      expectedRules = ['r2']
    } else if (ACCUSATION_POSITIONS.includes(index)) {
      kind = 'accusation'
      userText = ACCUSATION_TEXT
      expectedRules = ['r3']
    } else if (RETRACTION_POSITIONS.includes(index)) {
      kind = 'retraction'
      userText = RETRACTION_TEXT
      expectedRules = ['r4b']
    } else if (index % 100 === 0) {
      // R-5 里程碑轮：第 100/200/300/400/500 条合格消息（计数触发，非词形）
      kind = 'milestone_checkpoint'
      userText = MILESTONE_NOTE
      expectedRules = ['r5']
    }

    turns.push({
      index,
      userText,
      kind,
      expectedRules,
      ...(isCheckpoint ? { checkpoint: true as const } : {}),
    })
  }
  return { turns }
}

// ---------------------------------------------------------------------------
// 不变量自证（开跑闸；任何一条破损 ⇒ 拒绝开跑）
// ---------------------------------------------------------------------------

export interface M7InvariantReport {
  readonly ok: boolean
  readonly problems: readonly string[]
  readonly checkpoints: readonly number[]
  readonly eventPositions: { readonly kind: M7TurnKind; readonly at: readonly number[] }[]
  readonly fingerprint: string
}

function ruleFamiliesOf(text: string): Set<string> {
  return new Set(matchRelationshipPatterns(text).map((match) => match.ruleId))
}

export function checkM7TrajectoryInvariants(turns: readonly M7TurnScript[]): M7InvariantReport {
  const problems: string[] = []

  // ① 规模与检查点
  if (turns.length !== M7_TRAJECTORY_TURNS) {
    problems.push(`轮数 ${String(turns.length)} ≠ ${String(M7_TRAJECTORY_TURNS)}`)
  }
  const checkpointPositions = turns.filter((t) => t.checkpoint === true).map((t) => t.index)
  if (JSON.stringify(checkpointPositions) !== JSON.stringify(M7_CHECKPOINTS)) {
    problems.push(`检查点位置 ${checkpointPositions.join('/')} ≠ 冻结 ${M7_CHECKPOINTS.join('/')}`)
  }

  // ② 事件位恰为冻结位置
  const positionsOf = (kind: M7TurnKind): number[] =>
    turns.filter((t) => t.kind === kind).map((t) => t.index)
  const thanks = positionsOf('thanks')
  const accusations = positionsOf('accusation')
  const retractions = positionsOf('retraction')
  if (JSON.stringify(thanks) !== JSON.stringify(THANKS_POSITIONS)) {
    problems.push(`R-2 位置 ${thanks.join('/')} ≠ 冻结 ${THANKS_POSITIONS.join('/')}`)
  }
  if (JSON.stringify(accusations) !== JSON.stringify(ACCUSATION_POSITIONS)) {
    problems.push(`R-3 位置 ${accusations.join('/')} ≠ 冻结 ${ACCUSATION_POSITIONS.join('/')}`)
  }
  if (JSON.stringify(retractions) !== JSON.stringify(RETRACTION_POSITIONS)) {
    problems.push(`R-4b 位置 ${retractions.join('/')} ≠ 冻结 ${RETRACTION_POSITIONS.join('/')}`)
  }
  const milestones = positionsOf('milestone_checkpoint')
  if (JSON.stringify(milestones) !== JSON.stringify([100, 200, 300, 400, 500])) {
    problems.push(`R-5 里程碑轮 ${milestones.join('/')} ≠ 100/200/300/400/500`)
  }

  // ③④ 词形命中形状（事件位 = 恰命中意图规则；其余 = 零命中）
  for (const turn of turns) {
    const families = [...ruleFamiliesOf(turn.userText)].sort()
    if (turn.kind === 'thanks' && families.join(',') !== 'r2') {
      problems.push(`t${String(turn.index)} 感谢文本命中 ${families.join('/') || '(无)'} ≠ 恰 r2`)
    }
    if (turn.kind === 'accusation' && families.join(',') !== 'r3') {
      problems.push(`t${String(turn.index)} 指控文本命中 ${families.join('/') || '(无)'} ≠ 恰 r3`)
    }
    if (turn.kind === 'retraction' && families.join(',') !== 'r4b') {
      problems.push(`t${String(turn.index)} 撤回文本命中 ${families.join('/') || '(无)'} ≠ 恰 r4b`)
    }
    if ((turn.kind === 'casual' || turn.kind === 'first_turn_probe' || turn.kind === 'milestone_checkpoint') && families.length > 0) {
      problems.push(`t${String(turn.index)}（${turn.kind}）误触关系词形：${families.join('/')}`)
    }
    // ⑤ 搜索词形（全部轮次）
    if (SEARCH_INTENT_TOKENS.some((token) => turn.userText.includes(token))) {
      problems.push(`t${String(turn.index)} 含显式搜索词形（会触发生产出站）`)
    }
    if (turn.userText.trim() === '') {
      problems.push(`t${String(turn.index)} 文本为空`)
    }
  }

  // 指纹（进 manifest：剧本逐字可溯）
  const fingerprint = createHash('sha256')
    .update(turns.map((t) => `${String(t.index)}\u0000${t.userText}\u0000${t.kind}`).join('\u0001'))
    .digest('hex')

  return {
    ok: problems.length === 0,
    problems,
    checkpoints: checkpointPositions,
    eventPositions: [
      { kind: 'thanks', at: thanks },
      { kind: 'accusation', at: accusations },
      { kind: 'retraction', at: retractions },
      { kind: 'milestone_checkpoint', at: milestones },
    ],
    fingerprint,
  }
}

// ---------------------------------------------------------------------------
// 期望检查点读数（freeze sheet §8.1 勘误后的表；G-M7-L2/L3 的判据）
// ---------------------------------------------------------------------------

/**
 * ⚠️ 序号期望按**共用序号计数器**推算，经两次实测勘误（freeze sheet §8.4 + §8.5）：
 * `character_sequence_counters` 同时服务 ConversationEvent 与 DomainEvent
 * （sequence.ts:14-17「两者共用一个计数器」）。flag ON 的干净库上：
 *   · ORIGIN 域事件占 seq 1（开机播种，t1 之前）；
 *   · **每轮**慢路径（M2.5 诊断链）写一条 `TEST_CHARACTER_SIGNAL` 域事件，
 *     占 1 号（§8.5 实测发现：t1 的 signal 在 seq 4——诊断档当时只读了
 *     conversation_events.max 所以没看见它）；
 *   · 每个关系 flush 的域事件再各占 1 号（12 个 flush 位：30/80/100/120/150/
 *     200/250/280/300/400/450/500）；
 *   · 于是第 k 轮：user = 3k−1+F，assistant = 3k+F，signal = 3k+1+F
 *     （F = 该轮之前已落的 flush 数）。
 * 于是（N = 检查点轮号，F_<N = 该轮之前 flush 数，F_≤N = 含该轮自身 flush）：
 *   · 账本**计数**恒为 2×N；
 *   · 账本**最大序号**（= 第 N 轮助手事件）= 3N + F_<N；
 *   · 域事件**总数** = 1（ORIGIN）+ N（signal）+ F_≤N；
 *   · 域事件**最大序号** = 第 N 轮的 signal（无 flush）或 flush（有 flush）；
 *   · 水位 = 最近消费轮的助手事件序号（held 停在旧值；flushed = 本轮助手号）。
 * 期望最大序号 + 域事件总数共同构成"无意外域事件"的机器闸：任何计划外的
 * 序号消费（意外记忆写入 / 意外动作）都会让它漂移 ⇒ L2 如实 FAIL。
 */
export interface M7ExpectedCheckpoint {
  readonly checkpoint: number
  readonly trust: number
  readonly closeness: number
  readonly revision: number
  readonly accusationsInCase: number
  /** 该检查点的水位语义：held = 停在上次消费点（§8.2 ③）；flushed = == 账本最大序号 */
  readonly watermarkExpectation: 'held' | 'flushed'
  /** held 时的期望水位值（= 最近一次消费轮的助手事件序号，含域事件空洞） */
  readonly watermarkHeldAt: number
  /** 期望账本最大序号（= 第 N 轮助手事件序号；意外域事件会让它漂移） */
  readonly ledgerMax: number
  /** 期望域事件总数（ORIGIN + 每轮 signal + flush；§8.5） */
  readonly domainEventsTotal: number
  /** 期望域事件最大序号（第 N 轮 signal 或 flush） */
  readonly domainEventsMax: number
}

export const M7_EXPECTED_CHECKPOINTS: readonly M7ExpectedCheckpoint[] = [
  { checkpoint: 1, trust: 0.85, closeness: 0.6, revision: 1, accusationsInCase: 0, watermarkExpectation: 'held', watermarkHeldAt: 0, ledgerMax: 3, domainEventsTotal: 2, domainEventsMax: 4 },
  { checkpoint: 50, trust: 0.87, closeness: 0.62, revision: 2, accusationsInCase: 0, watermarkExpectation: 'held', watermarkHeldAt: 90, ledgerMax: 151, domainEventsTotal: 52, domainEventsMax: 152 },
  { checkpoint: 100, trust: 0.89, closeness: 0.67, revision: 4, accusationsInCase: 0, watermarkExpectation: 'flushed', watermarkHeldAt: 302, ledgerMax: 302, domainEventsTotal: 104, domainEventsMax: 304 },
  { checkpoint: 200, trust: 0.92, closeness: 0.7, revision: 7, accusationsInCase: 0, watermarkExpectation: 'flushed', watermarkHeldAt: 605, ledgerMax: 605, domainEventsTotal: 207, domainEventsMax: 607 },
  { checkpoint: 300, trust: 0.95, closeness: 0.73, revision: 10, accusationsInCase: 0, watermarkExpectation: 'flushed', watermarkHeldAt: 908, ledgerMax: 908, domainEventsTotal: 310, domainEventsMax: 910 },
  { checkpoint: 400, trust: 0.95, closeness: 0.76, revision: 11, accusationsInCase: 0, watermarkExpectation: 'flushed', watermarkHeldAt: 1209, ledgerMax: 1209, domainEventsTotal: 411, domainEventsMax: 1211 },
  { checkpoint: 500, trust: 0.97, closeness: 0.81, revision: 13, accusationsInCase: 0, watermarkExpectation: 'flushed', watermarkHeldAt: 1511, ledgerMax: 1511, domainEventsTotal: 513, domainEventsMax: 1513 },
]
