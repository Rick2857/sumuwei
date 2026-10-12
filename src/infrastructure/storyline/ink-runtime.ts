/**
 * Storyline —— **inkjs 运行器适配**（基础设施层；后 Lv2 · S1 / Lv2.5）。
 *
 * ============================================================================
 *  载体：ADR-091 §1（权威分层）· §2（模块边界）· 计划 §3（世界线首选 = Ink / inkjs）
 * ============================================================================
 * 职责边界（**这是本文件存在的全部理由**）：
 *
 *     inkjs 负责：叙事文本、选项文本、当前节点标签、变量读回
 *     LG  负责：**能不能推进**（世界状态机判定）、来源身份、事件提交、可见性、认知接线
 *
 * 因此这里**不做任何判定**：它把 inkjs 的当前 frontier 读出来，
 * 交给 `advanceFromProposal()`；判定不通过时**原样返回拒收**，不"试着改一下再提交"。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 选项身份为什么按**位置**锚定（WP0 实测结论，不是设计偏好）
 * ---------------------------------------------------------------------------
 * ink 的 `# choice:<id>` 标签在**选项行**上**不会**进入 inkjs 2.4.0 的运行期
 * `Choice.tags`（实测为空数组：inkjs 的 `currentTags` 只从**输出流**收集标签，
 * 选项行的标签不在其中）。因此本适配器**不依赖**运行期选项标签，改用两条**独立**判据：
 *
 *   ① **位置锚定**：第 i 个选项 ↔ `story-pack.ts` 里该节点 `choices[i]`。
 *      选项数量与 pack 声明不一致 ⇒ 立刻失败关闭（多一个少一个都不行）。
 *   ② **静态交叉核对**（在 `scripts/postlv2-story-verify.ts`）：解析 `.ink` 源里的
 *      `# node:` / `# stage:` / `# visible:` / `# choice:` 与迁移表**逐条**比对。
 *
 * 两条合起来等价于"缺键即拒收"，而且更强：它连"选项文本被改写"都能发现
 * （位置对不上就是图漂移）。**只认文本**仍然是禁止的 —— 文本从不参与判定。
 */

import { Story } from 'inkjs'
import { Compiler } from 'inkjs/full'

import { KernelError } from '../../kernel/contracts/ids.ts'
import type { StoryStageId } from '../../kernel/storyline/story-types.ts'

/** 一个选项：**文本**给人看，**位置**给状态机用 */
export interface InkChoice {
  /** 选项在 ink 当前 frontier 里的下标（`ChooseChoiceIndex` 需要它） */
  index: number
  /** 该节点 `choices[i]` 的机器键（来自内容包；**不来自**选项文本） */
  choiceId: string
  /** 选项文本（给人看；**从不**参与判定） */
  text: string
}

export interface InkFrontier {
  /** 当前节点（来自 `# node:<id>`） */
  nodeId: string
  /** 当前阶段（来自 `# stage:<id>`） */
  stage: StoryStageId
  /** 本次续播产出的叙事文本（给人看；**不是**事实） */
  text: string
  /** 她已经看到的剧情事件（来自 `# visible:<id>`；本步累积） */
  visibleEvents: readonly string[]
  /** 当前合法选项（**唯一**可提交的集合；身份来自内容包的位置锚定） */
  choices: readonly InkChoice[]
  /** 是否已到 `DONE`（终局） */
  done: boolean
  /** 变量读回（用于与状态机的值对账） */
  variables: Readonly<Record<string, number | boolean | string>>
}

export interface CreateInkRuntimeOptions {
  /**
   * 每个节点的**有序**选项键（= `StoryContentPack.nodes[i].choices`）。
   *
   * ⚠️ 这是位置锚定的来源；缺它**不构造**运行器（宁可不跑，也不让选项身份变成文本）。
   */
  choiceIdsByNode: Readonly<Record<string, readonly string[]>>
}

export interface InkRuntime {
  /** 读当前 frontier（不改变状态） */
  frontier(): InkFrontier
  /** 提交一个选项下标（**调用方必须先经状态机判定**） */
  choose(index: number): void
  /**
   * 序列化**自描述**快照（**只是快照**；权威仍是事件流）。
   *
   * ⚠️ 为什么不能只用 `story.state.ToJson()`：ink 的 knot 标签只在**进入**该 knot 时
   * 出现在输出流里（WP0 实测）。在"正在等选择"的位置保存、再恢复时，
   * 输出流是脏的 ⇒ 不会重新产出 `# node:` ⇒ 恢复出来的运行器**不知道自己在哪个节点**。
   * 因此快照必须把节点身份一起带上（否则"重启后当前节点一致"这条判据根本无法验证）。
   */
  saveState(): InkSnapshot
}

/** 自描述快照：ink 引擎状态 + 节点身份（恢复后无需重放） */
export interface InkSnapshot {
  /** `story.state.ToJson()` 的原样输出 */
  inkState: string
  /** 保存时的当前节点（来自 `# node:`） */
  nodeId: string
  /** 保存时的当前阶段 */
  stage: StoryStageId
  /** 到保存时为止**累积**的可见事件（只增不减） */
  visibleEventIds: readonly string[]
}

const STAGE_IDS: readonly StoryStageId[] = [
  'confirm_goal',
  'prepare_and_drill',
  'attend_interview',
  'result_and_review',
]

/**
 * 编译 ink 源 → 故事 JSON。
 *
 * ⚠️ 编译失败**必须抛错**，不能"跳过编译用旧 JSON"：那会让"改了剧情但没重编"
 * 变成静默的版本漂移，而来源身份里带着 `storyVersion`，漂移之后无法回答
 * "这条记忆读的是哪一版剧情"。
 */
export function compileInkSource(source: string): string {
  const compiler = new Compiler(source)
  const story = compiler.Compile()
  const errors = compiler.errors
  if (errors && errors.length > 0) {
    throw new KernelError(
      'validation_error',
      'ink_compile_error',
      `ink 编译失败（${errors.length} 条）：${JSON.stringify(errors.slice(0, 5))}`
    )
  }
  // ⚠️ inkjs 的类型是 `ToJson(writer?) : string | void`；不传 writer 时运行期恒为 string。
  // 显式收窄而不是 `as string`：如果哪天它真的返回 undefined，这里要**当场**发现。
  const json = story.ToJson()
  if (typeof json !== 'string' || json.length === 0) {
    throw new KernelError(
      'validation_error',
      'ink_compile_empty_output',
      'ink 编译成功但没有产出故事 JSON：拒绝继续（空的编译产物会让运行期静默空转）'
    )
  }
  return json
}

/** 存在且仅存在这四种机器标签（多一个就是登记表外的契约扩展） */
export const INK_MACHINE_TAGS = ['node', 'stage', 'visible', 'choice'] as const

/** 从编译产物创建运行器（可选：从**自描述**快照恢复） */
export function createInkRuntime(
  storyJson: string,
  options: CreateInkRuntimeOptions,
  snapshot?: InkSnapshot
): InkRuntime {
  const story = new Story(storyJson)
  if (snapshot !== undefined) {
    story.state.LoadJson(snapshot.inkState)
  }
  /** 恢复时节点身份来自快照（见 `InkSnapshot` 的说明）；首次创建时为 undefined */
  let savedNodeId: string | undefined = snapshot?.nodeId
  let savedStage: StoryStageId | undefined = snapshot?.stage
  const accumulatedVisible: string[] = [...(snapshot?.visibleEventIds ?? [])]

  const readVariables = (): Record<string, number | boolean | string> => {
    const values: Record<string, number | boolean | string> = {}
    const state = (story as unknown as {
      variablesState?: { _globalVariables?: Record<string, unknown> }
    }).variablesState
    const globals = state?._globalVariables
    if (!globals) return values
    for (const name of Object.keys(globals)) {
      const value = globals[name]
      if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
        values[name] = value
      }
    }
    return values
  }

  const drain = (): InkFrontier => {
    const textLines: string[] = []
    const visibleEvents: string[] = []
    let nodeId: string | undefined
    let stage: StoryStageId | undefined

    while (story.canContinue) {
      const line = story.Continue() ?? ''
      if (line.trim() !== '') textLines.push(line.trim())
      for (const tag of story.currentTags ?? []) {
        const parsed = parseTag(tag)
        if (!parsed) continue
        if (parsed.key === 'node') nodeId = parsed.value
        else if (parsed.key === 'stage') {
          if (!STAGE_IDS.includes(parsed.value as StoryStageId)) {
            throw new KernelError(
              'validation_error',
              'ink_unknown_stage',
              `ink 声明了未登记的阶段：${parsed.value}（受控登记表在 story-types.ts）`
            )
          }
          stage = parsed.value as StoryStageId
        } else if (parsed.key === 'visible') visibleEvents.push(parsed.value)
        else if (parsed.key !== 'choice') {
          throw new KernelError(
            'validation_error',
            'ink_unknown_tag',
            `ink 出现未登记的机器标签：# ${tag}（登记表：${INK_MACHINE_TAGS.join(' / ')}）`
          )
        }
        /*
         * ⚠️ `choice:` 标签在这里被**刻意忽略**（WP0 实测）：
         * inkjs 会在"刚提交完一个选择"的那次 `Continue()` 的 `currentTags` 里
         * 回放那条选择行的标签（`choice:<id>`）。它不是**当前节点**的声明，
         * 而是**上一步**的痕迹。选项身份因此按位置锚定（见文件头说明），
         * `choice:` 只在 `scripts/postlv2-story-build.ts` 的**静态**扫描里使用。
         */
      }
    }

    const resolvedNode = nodeId ?? savedNodeId ?? ''
    const resolvedStage = stage ?? savedStage ?? 'confirm_goal'
    const declared = options.choiceIdsByNode[resolvedNode]

    /*
     * 终局（`-> DONE` 或节点没有作者选项）时 ink 可能留着一个**不可见默认选项**
     * （`isInvisibleDefault`），它不是作者声明的 frontier，因此**不计入**候选。
     * 把它当选项会让"终局后还能推进一步"变成可能 —— 那正是要拦的形状。
     */
    const rawChoices = story.currentChoices
      .filter((choice) => (choice as unknown as { isInvisibleDefault?: boolean }).isInvisibleDefault !== true)
      .map((choice) => ({ index: choice.index, text: choice.text.trim() }))

    if (rawChoices.length > 0 && declared === undefined) {
      throw new KernelError(
        'validation_error',
        'ink_node_not_in_content_pack',
        `ink 节点 ${resolvedNode} 有 ${rawChoices.length} 个选项，但内容包里没有这个节点：` +
          '图漂移必须当场失败，不能靠运行期猜'
      )
    }
    if (declared !== undefined && declared.length !== rawChoices.length) {
      throw new KernelError(
        'validation_error',
        'ink_choice_count_mismatch',
        `节点 ${resolvedNode} 的选项数不一致：ink=${rawChoices.length} / 内容包=${declared.length}` +
          '（位置锚定要求一一对应）'
      )
    }
    if (rawChoices.length === 0 && resolvedNode !== '' && declared === undefined) {
      throw new KernelError(
        'validation_error',
        'ink_node_not_in_content_pack',
        `ink 停在节点 ${resolvedNode}，但内容包里没有这个节点：图漂移必须当场失败`
      )
    }
    if (rawChoices.length === 0 && resolvedNode === '') {
      throw new KernelError(
        'validation_error',
        'ink_node_unknown_at_terminal',
        'ink 已到终局但读不出 # node: 标签：无法回答"停在哪里"（失败关闭）'
      )
    }

    const choices: InkChoice[] = rawChoices.map((choice, position) => ({
      index: choice.index,
      choiceId: declared![position],
      text: choice.text,
    }))

    // 本次续播的可见事件累积进运行期集合（只增不减：同一事件重复出现不重复计入）
    for (const event of visibleEvents) {
      if (!accumulatedVisible.includes(event)) accumulatedVisible.push(event)
    }
    savedNodeId = resolvedNode === '' ? undefined : resolvedNode
    savedStage = resolvedStage

    return {
      nodeId: resolvedNode,
      stage: resolvedStage,
      text: textLines.join('\n'),
      visibleEvents: [...accumulatedVisible],
      choices,
      done: !story.canContinue && story.currentChoices.length === 0,
      variables: readVariables(),
    }
  }

  let cached = drain()

  return {
    frontier: () => cached,
    choose: (index: number) => {
      const target = cached.choices.find((choice) => choice.index === index)
      if (!target) {
        throw new KernelError(
          'validation_error',
          'ink_choice_index_out_of_frontier',
          `选项下标 ${index} 不在当前 frontier：${JSON.stringify(cached.choices.map((c) => c.index))}`
        )
      }
      story.ChooseChoiceIndex(index)
      cached = drain()
    },
    saveState: () => ({
      inkState: story.state.ToJson(),
      nodeId: cached.nodeId,
      stage: cached.stage,
      visibleEventIds: cached.visibleEvents,
    }),
  }
}

/**
 * 从**自描述**快照恢复运行器（**只用于快照对账与真实重启**；权威仍是事件流）。
 *
 * ⚠️ 契约 S5：快照重建**不**重发世界观测、不重复写记忆、不重复推动情绪/关系。
 * 因此恢复出来的运行器只用于"当前节点/变量/可见集合是否逐字段一致"的对账，
 * **不得**被当作认知事件的来源。
 */
export function createInkRuntimeFromState(
  storyJson: string,
  options: CreateInkRuntimeOptions,
  snapshot: InkSnapshot
): InkRuntime {
  return createInkRuntime(storyJson, options, snapshot)
}

/** 由内容包生成位置锚定表（运行器与门的**唯一**来源） */
export function choiceIdsByNodeOf(
  nodes: readonly { id: string; choices: readonly string[] }[]
): Record<string, readonly string[]> {
  const result: Record<string, readonly string[]> = {}
  for (const node of nodes) result[node.id] = node.choices
  return result
}

function parseTag(tag: string): { key: string; value: string } | undefined {
  const trimmed = tag.trim()
  const separator = trimmed.indexOf(':')
  if (separator <= 0) return undefined
  const key = trimmed.slice(0, separator).trim()
  const value = trimmed.slice(separator + 1).trim()
  if (value === '') return undefined
  return { key, value }
}

// ---------------------------------------------------------------------------
// 依赖探针（供 `pnpm postlv2:baseline` 的 B5 使用）
// ---------------------------------------------------------------------------

export interface InkDependencyProbe {
  ok: boolean
  /** 编译是否成功 */
  compiledOk: boolean
  /** 运行期是否读到了正确的内容与变量 */
  runtimeOk: boolean
  /** 读回的文本（探针断言用） */
  text: string
  /** 读回的变量值 */
  variable: number | string
  detail: string
}

/**
 * **编译器 + 运行器**双面探针。
 *
 * ⚠️ 它在**同一个进程**里跑（而不是 spawn 一个子进程写脚本文件）：
 * 子进程方案在 Windows 下踩过两次坑 —— `node -e` 的引号/花括号会被 PowerShell 转义，
 * 而把脚本写到 `%TEMP%` 又会让 `require('inkjs')` 解析不到（脚本位置决定模块解析根）。
 * 同进程探针没有这些问题，而且测的仍然是**真实依赖**（不是 mock）。
 */
export function probeInkDependency(): InkDependencyProbe {
  try {
    const compiled = new Compiler('VAR probe_var = 3\nPROBE\n-> DONE').Compile()
    const errors = (compiled as unknown as { errors?: string[] }).errors ?? []
    if (errors.length > 0) {
      return {
        ok: false,
        compiledOk: false,
        runtimeOk: false,
        text: '',
        variable: 'n/a',
        detail: `编译报错（${errors.length}）：${JSON.stringify(errors.slice(0, 3))}`,
      }
    }
    const json = compiled.ToJson()
    if (typeof json !== 'string' || json.length === 0) {
      return { ok: false, compiledOk: false, runtimeOk: false, text: '', variable: 'n/a', detail: '编译产物为空' }
    }
    const story = new Story(json)
    const lines: string[] = []
    while (story.canContinue) {
      const line = story.Continue() ?? ''
      if (line.trim() !== '') lines.push(line.trim())
    }
    const variable = story.variablesState.$('probe_var') as number | string
    const text = lines.join('|')
    const runtimeOk = text === 'PROBE' && variable === 3
    return {
      ok: runtimeOk,
      compiledOk: true,
      runtimeOk,
      text,
      variable,
      detail: runtimeOk
        ? `编译器通过 · 运行器读出 text=${text} / probe_var=${String(variable)}`
        : `运行器读回不符：text=${JSON.stringify(text)} / probe_var=${String(variable)}`,
    }
  } catch (error) {
    return {
      ok: false,
      compiledOk: false,
      runtimeOk: false,
      text: '',
      variable: 'n/a',
      detail: `探针抛错：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
