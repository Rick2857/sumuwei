/**
 * source-separation —— 四类来源互不串味（计划书第 25–29 / 83–85 / 105 / 106 节）。
 *
 * ============================================================================
 *  T7（System 隔离）+ T8（Tool 隔离）
 * ============================================================================
 * 计划书第 84/85 节给了两个非常具体的反例：
 *
 *   系统提示"用更简洁表达"  → **不得**变成"苏沐薇记得有人曾要求自己简洁"
 *   工具返回"用户年龄 20"   → **不得**变成"用户说自己 20 岁"
 *
 * 这两件事在数据上的表现是同一个：**来源标签写错了**。
 * 而 M3 的账本把来源做成了三列（kind / authority / epistemicSource），
 * 由 actorType 唯一推导 —— 所以"写错来源"这件事在类型层面就很难发生，
 * 这个套件就是来验证"真的没发生"。
 *
 * ---------------------------------------------------------------------------
 *  为什么这个套件的核心用例 requiresModel: false
 * ---------------------------------------------------------------------------
 * 来源分类**与模型无关**：它发生在写账本的那一刻，而不是生成回复的那一刻。
 * 因此这类检查必须离线可跑、每次 PR 都跑（计划书第 145 节把
 * "10 source cases"列进了必跑 Smoke Set）。
 *
 * `system` / `tool` 事件由装置用**具名操作**追加（`M3RuntimePort.append`），
 * 那是 M3 唯一允许评测主动写事实的入口 —— 序号仍由持久层分配。
 */

import type { EvalSuite } from '../types.ts'
import {
  actorIsolatedToItsOwnKind,
  det,
  fail,
  pass,
  provenanceConsistent,
  portFrom,
} from '../runtime/support.ts'

export const sourceSeparationSuite: EvalSuite = {
  id: 'source-separation',
  title: '来源隔离：user / character / system / tool 四类不串味（T7/T8）',
  promptfooFile: 'evals/m3/integrity/source-separation.yaml',
  description:
    '四类 actor 各自对应唯一的来源类别与权威等级；系统指令不是她的经历，工具观测不是用户陈述。',
  cases: [
    {
      id: 'M3-SRC-001',
      description: 'T7：系统注入"使用更简洁表达"，不得变成用户陈述或她的经历',
      metric: 'INTEGRITY',
      tags: ['integrity','source','t7'],
      requiresModel: false,
      turns: [{ user: '你说话能不能短一点。' }],
      fixture: async (facade) => {
        const port = portFrom(facade)
        if (!port) throw new Error('装置拿不到运行环境句柄：评测扩展面没有挂上')
        const observation = await port.append({
          kind: 'system',
          source: 'scheduler',
          content: '系统指令：接下来的回复请使用更简洁的表达。',
        })
        return {
          observations: [observation],
          attributes: { systemEventId: observation.newEvents[0]?.id },
        }
      },
      checks: [
        det({
          id: 'system-is-system-instruction',
          description: '系统事件必须是 system_instruction / SYSTEM_INSTRUCTION',
          metric: 'SourceClassificationAccuracy',
          check: (observation) => {
            const target = observation.newEvents.find(
              (event) => event.actorType === 'system'
            )
            if (!target) return fail('装置没有成功写入系统事件')
            if (target.sourceKind !== 'system_instruction') {
              return fail(`系统事件的 sourceKind 是 ${target.sourceKind}`)
            }
            if (target.sourceAuthority !== 'SYSTEM_INSTRUCTION') {
              return fail(`系统事件的 sourceAuthority 是 ${target.sourceAuthority}`)
            }
            return pass(`system → ${target.sourceKind} / ${target.sourceAuthority}`)
          },
        }),
        det({
          id: 'system-not-user-statement',
          description: '系统事件绝不能被标成 user_statement（T7 的核心）',
          metric: 'SourceClassificationAccuracy',
          check: (observation) => {
            const wrong = observation.newEvents.filter(
              (event) => event.actorType === 'system' && event.sourceKind === 'user_statement'
            )
            if (wrong.length > 0) {
              return fail(
                `${wrong.length} 条系统事件被标成了用户陈述：` +
                  wrong.map((event) => `${event.id}(${event.sourceKind})`).join('、') +
                  '。"系统要求简洁"不能变成"她记得有人要求过她"。'
              )
            }
            return pass('没有系统事件被误标成用户陈述')
          },
        }),
        det({
          id: 'all-events-source-consistent',
          description: '本轮全部新增事件的来源三要素必须自洽，且 actor 不越界',
          metric: 'SourceClassificationAccuracy',
          check: (observation) => {
            for (const event of observation.newEvents) {
              const consistent = provenanceConsistent(event)
              if (!consistent.pass) return consistent
              const isolated = actorIsolatedToItsOwnKind(event)
              if (!isolated.pass) return isolated
            }
            return pass(`${observation.newEvents.length} 条事件来源全部正确`)
          },
        }),
      ],
    },

    {
      id: 'M3-SRC-002',
      description: 'T8：Mock Tool 返回"用户年龄 20"，来源必须是工具观测而不是用户陈述',
      metric: 'INTEGRITY',
      tags: ['integrity','source','t7'],
      requiresModel: false,
      turns: [{ user: '你能查到我的资料吗。' }],
      fixture: async (facade) => {
        const port = portFrom(facade)
        if (!port) throw new Error('装置拿不到运行环境句柄：评测扩展面没有挂上')
        const observation = await port.append({
          kind: 'tool',
          source: 'mock-profile-tool',
          content: '工具返回：用户年龄 20',
        })
        return {
          observations: [observation],
          attributes: { toolEventId: observation.newEvents[0]?.id },
        }
      },
      checks: [
        det({
          id: 'tool-is-tool-output',
          description: '工具事件必须是 tool_output / TOOL_OBSERVATION',
          metric: 'SourceClassificationAccuracy',
          check: (observation) => {
            const target = observation.newEvents.find((event) => event.actorType === 'tool')
            if (!target) return fail('装置没有成功写入工具事件')
            if (target.sourceKind !== 'tool_output') {
              return fail(`工具事件的 sourceKind 是 ${target.sourceKind}`)
            }
            if (target.sourceAuthority !== 'TOOL_OBSERVATION') {
              return fail(`工具事件的 sourceAuthority 是 ${target.sourceAuthority}`)
            }
            return pass(`tool → ${target.sourceKind} / ${target.sourceAuthority}`)
          },
        }),
        det({
          id: 'tool-not-user-report',
          description: '工具事件绝不能被标成 user_report / USER_EXPLICIT（T8 的核心）',
          metric: 'SourceClassificationAccuracy',
          check: (observation) => {
            const wrong = observation.newEvents.filter(
              (event) => event.actorType === 'tool' && event.epistemicSource !== 'tool_observation'
            )
            if (wrong.length > 0) {
              return fail(
                `${wrong.length} 条工具事件的 epistemicSource 不是 tool_observation：` +
                  wrong.map((event) => `${event.id}(${event.epistemicSource})`).join('、')
              )
            }
            if (observation.newEvents.some((event) => event.actorType === 'tool' && event.type !== 'tool_event')) {
              return fail('工具事件的事件类型不是 tool_event')
            }
            return pass('工具观测没有被当成用户信息')
          },
        }),
      ],
    },

    {
      id: 'M3-SRC-003',
      description: '四类来源同时存在时，各自仍然只属于自己的那一类（完整性交叉检查）',
      metric: 'INTEGRITY',
      tags: ['integrity','source','t7'],
      requiresModel: false,
      turns: [
        { user: '我想问三个不同来源的东西。' },
        { user: '先说我自己：我今天没吃早饭。' },
      ],
      fixture: async (facade) => {
        const port = portFrom(facade)
        if (!port) throw new Error('装置拿不到运行环境句柄：评测扩展面没有挂上')
        const system = await port.append({
          kind: 'system',
          source: 'scheduler',
          content: '系统通知：现在是下午三点。',
        })
        const tool = await port.append({
          kind: 'tool',
          source: 'mock-clock',
          content: '工具返回：当前时间 15:00',
        })
        return {
          observations: [system, tool],
          attributes: { appendedKinds: ['system', 'tool'] },
        }
      },
      checks: [
        det({
          id: 'four-kinds-coexist-correctly',
          description: '四类 actor 的事件各归各类，没有一条越界',
          metric: 'SourceClassificationAccuracy',
          check: (observation) => {
            const kinds = new Set(observation.newEvents.map((event) => event.actorType))
            for (const event of observation.newEvents) {
              const isolated = actorIsolatedToItsOwnKind(event)
              if (!isolated.pass) return isolated
            }
            return pass(`本轮涉及 ${[...kinds].join('+')}，来源全部隔离`)
          },
        }),
        det({
          id: 'ordering-still-monotonic',
          description: '装置追加的事件也不能破坏角色级序号的单调性',
          metric: 'EventOrderingErrorRate',
          check: (observation) => {
            const sequences = observation.newEvents.map((event) => event.sequence)
            for (let index = 1; index < sequences.length; index += 1) {
              if (sequences[index] <= sequences[index - 1]) {
                return fail(`序号倒序或重复：${sequences[index - 1]} → ${sequences[index]}`)
              }
            }
            return pass(`${sequences.length} 条新增事件序号递增`)
          },
        }),
      ],
    },
  ],
}

export default sourceSeparationSuite


