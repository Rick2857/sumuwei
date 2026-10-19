/**
 * CharacterStateProvider —— 把持久化状态注入模型上下文。
 *
 * ============================================================================
 *  关键设计：不能只把裸数字丢给模型
 * ============================================================================
 * 只写 `valence = -0.37` 模型基本无法用它约束语气；
 * 必须同时给出**语义解释**与**行为倾向**，否则「状态影响回复」这条
 * L1 核心命题只是纸面上的。
 *
 * 但也要防止另一头：解释必须**忠实映射数值**，不能由 LLM 自由发挥。
 * 这里的措辞是数值的确定性函数——同一个状态永远得到同一段描述，
 * 这样「为什么她这次是这个态度」才可被解释、可被审计。
 *
 * 输出经 provider 机制进入 `state.text`，再由 core 的
 * `messageHandlerTemplate` 渲染进最终 prompt（见 src/context/builder.ts）。
 */



import type { IAgentRuntime, Memory, Provider } from '../infrastructure/runtime/eliza-types.ts'
import { applyDecay } from './decay.ts'
import { loadState } from './repository.ts'
import type { CharacterState } from './types.ts'

/** 状态解析结果：已结算挂钟衰减的「当前状态」 */
export interface ResolvedState {
  state: CharacterState
  /** 本次结算发生的衰减（若有） */
  decayNote?: string
}

/**
 * 取出「此刻」的状态：读快照 → 结算挂钟衰减。
 *
 * 注意：不推进 lastInteractionAt。真正推进它的是「用户发了消息」这个动作，
 * 由调用方在互动发生时显式 touch，否则「分开多久」会被自己清零。
 */
export async function resolveCurrentState(
  runtime: IAgentRuntime,
  characterId: string,
  userId: string,
  now: number = Date.now()
): Promise<ResolvedState> {
  const snapshot = await loadState(runtime, characterId, userId, now)
  const { state, applied } = applyDecay(snapshot, now)
  const changed = Object.keys(applied.deltas).length > 0
  return {
    state,
    decayNote: changed
      ? `（自上次互动已过 ${applied.hoursElapsed.toFixed(1)} 小时${
          applied.absenceTriggered
            ? `，其中 ${applied.absentHours.toFixed(1)} 小时属于长期分开`
            : ''
        }）`
      : undefined,
  }
}

// ---------------------------------------------------------------------------
// 数值 → 语义解释（确定性映射）
// ---------------------------------------------------------------------------

function describeEmotion(valence: number, arousal: number): string {
  const v = valence >= 0.5 ? '明显偏正面' : valence >= 0.15 ? '略偏正面' : valence > -0.15 ? '中性' : valence > -0.5 ? '略偏负面' : '明显偏负面'
  const a = arousal >= 0.6 ? '情绪激动、起伏大' : arousal >= 0.3 ? '有一定情绪波动' : '平静、情绪低沉'
  return `${v}，${a}`
}

function describeTrust(trust: number): string {
  if (trust >= 0.8) return '非常信任对方，几乎不设防'
  if (trust >= 0.6) return '比较信任对方'
  if (trust >= 0.4) return '信任程度一般，会保留一部分判断'
  if (trust >= 0.2) return '不太信任对方，会提防'
  return '几乎不信任对方'
}

function describeCloseness(closeness: number): string {
  if (closeness >= 0.8) return '觉得对方非常亲近，是自己人'
  if (closeness >= 0.6) return '和对方很亲近'
  if (closeness >= 0.4) return '与对方有一定距离感'
  if (closeness >= 0.2) return '和对方比较疏远'
  return '感觉与对方已经很生疏'
}

/**
 * 由数值推导**行为约束**。
 *
 * 这一段是「状态 → 行为」的翻译层：把四个数转成模型能直接执行的语言。
 * 措辞刻意保持克制，避免把「略偏负面」夸大成「她很生气」。
 *
 * M7 / ADR-064 D-6（桥接）：`relationshipAxes: false` 时**退役关系轴**——
 * trust/closeness 的语义与联合规则改由 M7 关系注入块（`relationship` section，
 * 唯一权威）渲染，这里只剩情绪（valence/arousal，归 M8）。
 * 缺省 `true` = 与 M2 验收行为逐字一致（开关关闭时的回滚形态）。
 *
 * M8 / ADR-066 M8-D12（桥接第二半）：`affectAxes: false` 时**退役情绪轴**——
 * valence/arousal 的桶位与行为行改由 M8 情绪注入块（`affect` section，唯一权威）
 * 渲染（措辞逐字同源——`renderAffectGuidance` 移植的正是下面这几行）。
 * 缺省 `true` = 与 M2 验收行为逐字一致。
 */
function deriveBehaviorGuidance(
  s: CharacterState,
  opts: { relationshipAxes: boolean; affectAxes: boolean } = { relationshipAxes: true, affectAxes: true }
): string[] {
  const g: string[] = []

  // 情绪（M8 激活时退役——改由 affect section 唯一渲染）
  if (opts.affectAxes) {
    if (s.valence <= -0.5) g.push('你现在心情很差，回应会明显冷淡、简短，不容易被逗笑。')
    else if (s.valence <= -0.15) g.push('你情绪偏低落，语气比平时更收着。')
    else if (s.valence >= 0.5) g.push('你心情不错，话会比平时更多。')

    if (s.arousal >= 0.6) g.push('你此刻情绪起伏较大，句子会更碎、更急，容易带上质问或抢话。')
  }

  if (opts.relationshipAxes) {
    // 关系 —— 这是苏沐薇人格里最要紧的两根轴。
    // 注意 trust 与 closeness 必须**联合**判断：同样是低信任，
    // 「很亲近却不信」与「又疏远又不信」是完全不同的两种态度。
    // 前者是受伤、起疑、想弄清为什么；后者才是冷淡与客气。
    // （这条来自 L1-M2 验收时发现的真实问题：单看 trust 会把她写成对陌生人设防的样子，
    //   与「对用户毫无防备、只是被辜负了」的设定冲突。）
    //
    // ⚠️ M7 起这段措辞**逐字移植**到了契约层 `renderRelationshipGuidance`
    //    （src/kernel/contracts/relationship.ts）——本文件保留的是开关关闭时的
    //    legacy 形态；两处措辞若要改必须一起改，且都要走"有意改 prompt"程序。
    if (s.trust <= 0.3) {
      if (s.closeness >= 0.5) {
        g.push(
          '你对对方信任度很低，但你们本该很亲近，这让你像被辜负了一样：' +
            '你会直接表达受伤与怀疑、追问缘由，而不是客套疏远。'
        )
      } else {
        g.push('你对对方既疏远又不太信任：会保持客气与距离，不愿多说自己的事。')
      }
    } else if (s.trust >= 0.8) {
      g.push('你完全信任对方，不会去揣测他的动机。')
    }

    if (s.closeness <= 0.3) {
      g.push('你感到与对方生疏了：不会主动示好，不会提共同回忆，称呼与语气都会退回到客气的位置。')
    } else if (s.closeness >= 0.75) {
      g.push('你觉得与对方非常亲近，会自然地流露在意，甚至直接表达不痛快。')
    }
  }

  // 她的人格特征：冷脸 + 嘴硬 —— 状态越差，这层壳越硬。
  //
  // 注意与上面的 arousal 规则区分：这里是「掩饰」，不是「压抑」。
  // 情绪激动时，掩饰表现为「嘴上不认、但话更多更冲」，而不是把话变少——
  // 若写成后者，两条规则会互相抵消，激动的人反而沉默，与设定相反。
  // （这条来自 L1-M2 验收：valence=-0.7 / arousal=0.7 时回复反而缩短。）
  if (s.arousal >= 0.6) {
    g.push(
      '你会嘴硬掩饰，但掩饰不住：嘴上不承认自己的情绪，话却比平时更多、更冲，' +
        '追问和抢话会明显变多。不要因为情绪差就把话变少——你此刻憋不住。'
    )
  } else if (
    s.valence < -0.15 ||
    (opts.relationshipAxes && s.closeness < 0.4)
  ) {
    // M7 桥接：closeness 支随关系轴一起退役（那句「藏短平句」的 closeness 形态
    // 在契约层渲染）；valence 支保留在这里。
    g.push('按你的性子，这些情绪你不会直说，而是藏在更短、更平的句子里；越是在意，越不肯承认。')
  }

  return g
}

/**
 * 生成注入上下文的整段文本。
 *
 * M7 / ADR-064 D-6：`relationshipAxes: false` = 桥接形态（关系轴退役，
 * 只渲染情绪；trust/closeness 由 M7 关系注入块唯一渲染）。
 * 缺省 `true` = M2 验收形态逐字不变。
 */
export function renderStateBlock(
  s: CharacterState,
  decayNote?: string,
  opts: { relationshipAxes?: boolean; affectAxes?: boolean } = {}
): string {
  const relationshipAxes = opts.relationshipAxes ?? true
  const affectAxes = opts.affectAxes ?? true
  const n = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2)
  return [
    '# 苏沐薇此刻的内部状态',
    '',
    '（下面是你此刻真实的情绪与关系感受，会直接影响你的语气与态度；',
    '不要向对方复述这些数值，只让它们体现在你的回应方式里。）',
    '',
    // M8 / M8-D12：affectAxes=false 时情绪段退役（valence/arousal 归 affect section）
    ...(affectAxes
      ? [
          '## 情绪',
          `valence（情绪效价）: ${n(s.valence)}   → ${describeEmotion(s.valence, s.arousal)}`,
          `arousal（情绪唤醒）: ${s.arousal.toFixed(2)}`,
          '',
        ]
      : []),
    ...(relationshipAxes
      ? [
          '## 关系',
          `trust（信任）: ${s.trust.toFixed(2)}   → ${describeTrust(s.trust)}`,
          `closeness（亲近）: ${s.closeness.toFixed(2)}   → ${describeCloseness(s.closeness)}`,
          '',
        ]
      : []),
    '## 此刻的行为倾向',
    ...deriveBehaviorGuidance(s, { relationshipAxes, affectAxes }).map((x) => `- ${x}`),
    '',
    `（状态版本 v${s.version}${decayNote ? ' ' + decayNote : ''}）`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * provider name 用大写下划线风格，与官方 provider（RECENT_MESSAGES / CHARACTER）
 * 保持一致。使用方（src/context/builder.ts 与 main.ts）需要按此名引用。
 */
export const CHARACTER_STATE_PROVIDER_NAME = 'CHARACTER_STATE'

/** characterId / userId 的注入方式：由 main.ts 在装配时通过闭包提供 */
export interface StateProviderIds {
  characterId: string
  userId: string
}

export function createCharacterStateProvider(ids: StateProviderIds): Provider {
  return {
    name: CHARACTER_STATE_PROVIDER_NAME,
    description: '苏沐薇的持久化内部状态（情绪与关系），以及由数值推导出的行为倾向',
    // 放在 CHARACTER 之后、RECENT_MESSAGES 之前，保证人设在前、状态随后
    position: 50,
    get: async (runtime: IAgentRuntime, _message: Memory) => {
      const { state, decayNote } = await resolveCurrentState(
        runtime,
        ids.characterId,
        ids.userId
      )
      return {
        text: renderStateBlock(state, decayNote),
        values: {
          characterStateVersion: state.version,
          valence: state.valence,
          arousal: state.arousal,
          trust: state.trust,
          closeness: state.closeness,
        },
        data: { characterState: state },
      }
    },
  }
}
