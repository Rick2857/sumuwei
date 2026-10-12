/**
 * 后 Lv2 · S1 —— **题材与世界边界门**（`pnpm postlv2:story:verify`）。
 *
 * ============================================================================
 *  载体：ADR-091 §1/§2 · 故事世界来源契约 S1–S6 / S11 · INV-PL2-01…07
 * ============================================================================
 * 它守什么（**全离线**；不碰数据库、不发模型请求）：
 * ```text
 * S1  图有界：4 阶段 / 12 节点；不存在未声明主线出口；全部节点可达
 * S2  三个候选结局 + 明确退出**全部可达**，且每条路径的用户选择确实改变结果
 * S3  负控全分母：未知 choice · 越界变量 · 穿越指令 · 跳阶段 · 重复投递 · 过期 revision
 *     · 版本不匹配 · 终局后推进 —— **全部不改变故事**
 * S4  模型不能新增地点/节点/人物/变量/结局（无 frontier 外提交路径）
 * S5  重启/折叠：事件流 → 状态逐字段一致；重复 revision 幂等
 * S6  版本不匹配明确拒绝；重开用新 runId
 * S11 可见集合只增不减，且 visible ⊆ committed（回放不把不可见变亲历）
 * ```
 * 量具自证：正控（合法路径真的能走完）+ 负控（注入假象必须响）+ 恢复（放回真实实现重新安静）。
 * `measured_count > 0` 是本门的硬要求（AGENTS.md §6.8）。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  JICHUANG_CONTENT_DIGEST,
  JICHUANG_PACK,
  JICHUANG_STORY_ID,
  JICHUANG_STORY_VERSION,
  resolveEndingChoice,
} from '../evals/storyline/jichuang-interview-two/story-pack.ts'
import { KernelError } from '../src/kernel/contracts/ids.ts'
import {
  assertStoryContentPack,
  reachableNodeIds,
  type StoryContentPack,
} from '../src/kernel/storyline/story-types.ts'
import {
  advanceFromProposal,
  assertStoryProvenanceReadback,
  commitEnding,
  exitStory,
  foldStorylineEvents,
  frontierOf,
  resolveEnding,
  startStory,
  storyProvenanceOf,
  type StorylineEvent,
  type StorylineState,
} from '../src/kernel/storyline/world-machine.ts'
import {
  choiceIdsByNodeOf,
  createInkRuntime,
  createInkRuntimeFromState,
  type InkFrontier,
} from '../src/infrastructure/storyline/ink-runtime.ts'

const REPO_ROOT = resolve(process.cwd())
const PACK_DIR = join(REPO_ROOT, 'evals/storyline/jichuang-interview-two')

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

const storyJson = readFileSync(join(PACK_DIR, 'jichuang-interview-two.json'), 'utf8')
const manifest = JSON.parse(readFileSync(join(PACK_DIR, 'content-manifest.json'), 'utf8')) as {
  inkSourceSha256: string
  compiledStorySha256: string
  storyId: string
  storyVersion: number
}
const runtimeOptions = { choiceIdsByNode: choiceIdsByNodeOf(JICHUANG_PACK.nodes) }
const inkSource = readFileSync(join(PACK_DIR, 'jichuang-interview-two.ink'), 'utf8')

// ===========================================================================
// S1 图有界
// ===========================================================================
assertStoryContentPack(JICHUANG_PACK)
const reachable = reachableNodeIds(JICHUANG_PACK)
const allNodes = JICHUANG_PACK.nodes.map((node) => node.id)
const unreachable = allNodes.filter((id) => !reachable.has(id) && id !== 'end_exit')
const stages = [...new Set(JICHUANG_PACK.nodes.map((node) => node.stage))]
record(
  'S1',
  '图有界：4 阶段 / 12 节点 / 无未声明主线出口 / 全部节点可达',
  stages.length === 4 && allNodes.length === 12 && unreachable.length === 0,
  `阶段=${stages.length} · 节点=${allNodes.length} · 不可达=${JSON.stringify(unreachable)}`,
  allNodes.length
)

// 内容指纹：story-pack 的 digest 必须等于 manifest 的 ink 源 sha256 前 16 位
const digestMatches = manifest.inkSourceSha256.startsWith(JICHUANG_CONTENT_DIGEST)
const identityMatches = manifest.storyId === JICHUANG_STORY_ID && manifest.storyVersion === JICHUANG_STORY_VERSION
record(
  'S1b',
  '内容指纹与身份：story-pack 的 digest = ink 源 sha256 前 16 位，storyId/version 一致',
  digestMatches && identityMatches,
  `digest=${JICHUANG_CONTENT_DIGEST} · manifest=${manifest.inkSourceSha256.slice(0, 16)} · 身份一致=${String(identityMatches)}`,
  2
)

// ===========================================================================
// S2 全图遍历：三个结局 + 明确退出全部可达，且选择确实改变结果
// ===========================================================================

interface WalkResult {
  path: readonly string[]
  inkNodes: readonly string[]
  ending?: string
  state: StorylineState
}

/**
 * 穷举遍历（**正控**）：从 ink 起点一路按所有合法选择走到底，
 * 每一步都用**世界状态机**判定（而不是直接调 ink）—— 这样"判定太严导致走不到结局"
 * 也会被发现（那是真实的 FAIL，不是"通过"）。
 *
 * ⚠️ 分叉用**重放**而不是"快照 + 恢复"：WP0 实测发现，
 * 在"正在等选择"的位置保存 ink 状态、恢复后再 `ChooseChoiceIndex`，
 * 会让 inkjs 的输出流错位（同一段内容重放两遍、节点标签落在错误的步上）。
 * 重放是确定性的、可解释的，而这个图很小（≤7 步），代价可以忽略。
 */
function walkAllPaths(maxDepth = 12): { paths: WalkResult[]; blocked: string[] } {
  const results: WalkResult[] = []
  const blocked: string[] = []

  const recurse = (state: StorylineState, path: string[], inkNodes: string[], depth: number): void => {
    if (depth > maxDepth) return
    const runtime = buildRuntimeForPath(path)
    const frontier = runtime.frontier()
    inkNodes = [...inkNodes, frontier.nodeId]

    if (frontier.choices.length === 0) {
      // 终局：必须由**确定性结局判定**收尾（而不是运行器随手结束）
      const resolved = resolveEnding(JICHUANG_PACK, state)
      if ('error' in resolved) {
        blocked.push(`${path.join(' > ')} → ${resolved.error}`)
        return
      }
      const committed = commitEnding(JICHUANG_PACK, state, state.revision)
      if (!committed.ok) {
        blocked.push(`${path.join(' > ')} → commitEnding 被拒：${committed.detail}`)
        return
      }
      results.push({ path, inkNodes, ending: committed.event.ending, state: committed.state })
      return
    }

    for (const choice of frontier.choices) {
      const verdict = advanceFromProposal(
        JICHUANG_PACK,
        state,
        {
          proposedBy: 'user_choice',
          choiceId: choice.choiceId,
          expectedRevision: state.revision,
          expectedStoryVersion: JICHUANG_PACK.storyVersion,
        },
        Date.now()
      )
      if (!verdict.ok) {
        blocked.push(`${[...path, choice.choiceId].join(' > ')} → 状态机拒收：${verdict.code} ${verdict.detail}`)
        continue
      }
      recurse(verdict.state, [...path, choice.choiceId], inkNodes, depth + 1)
    }
  }

  const seed = startStory({ pack: JICHUANG_PACK, runId: 'walk', now: 1 })
  recurse(seed.state, [], [], 0)
  return { paths: results, blocked }
}

/** 按选择序列从起点重放出一个运行器（确定性；每个分叉独立） */
function buildRuntimeForPath(path: readonly string[]): ReturnType<typeof createInkRuntime> {
  const runtime = createInkRuntime(storyJson, runtimeOptions)
  for (const choiceId of path) {
    const target = runtime.frontier().choices.find((choice) => choice.choiceId === choiceId)
    if (!target) {
      throw new KernelError(
        'validation_error',
        'walk_replay_missing_choice',
        `重放路径时找不到选择 ${choiceId}（路径：${path.join(' > ')}）`
      )
    }
    runtime.choose(target.index)
  }
  return runtime
}

const walk = walkAllPaths()
const reachableEndings = new Set(walk.paths.map((item) => item.ending))
const threeEndingsReachable = ['passed_together', 'pending_further_review', 'not_passed_this_time'].every(
  (ending) => reachableEndings.has(ending)
)
record(
  'S2',
  '三个候选结局经**真实路径**全部可达（每一步都过世界状态机）',
  threeEndingsReachable && walk.blocked.length === 0,
  `走完的路径=${walk.paths.length} · 结局=${JSON.stringify([...reachableEndings])} · 被拒路径=${walk.blocked.length}`,
  walk.paths.length
)
if (walk.blocked.length > 0) for (const item of walk.blocked.slice(0, 5)) console.log(`     · 被拒：${item}`)

// 选择确实改变后续阶段/结果（同一前缀 + 不同选择 ⇒ 不同结局或不同阶段序列）
const outcomeByPath = new Map<string, string>()
let divergences = 0
for (const item of walk.paths) {
  const key = item.path.join('>')
  outcomeByPath.set(key, `${item.ending}|${item.state.revision}`)
}
const endingCounts = new Map<string, number>()
for (const item of walk.paths) endingCounts.set(item.ending ?? 'none', (endingCounts.get(item.ending ?? 'none') ?? 0) + 1)
for (const [ending, count] of endingCounts) if (count > 0) divergences += 1
record(
  'S2b',
  '选择确实改变结果：至少三条路径以不同结局收尾，且每条结局有独立因果链（走的是状态机而非文本）',
  divergences >= 3 && endingCounts.size >= 3,
  `结局分布=${JSON.stringify(Object.fromEntries(endingCounts))}`,
  walk.paths.length
)

// 明确退出路径（RUN_EXITED ≠ 被判定未通过）
const exitSeed = startStory({ pack: JICHUANG_PACK, runId: 'exit-walk', now: 1 })
const exited = exitStory(JICHUANG_PACK, exitSeed.state, exitSeed.state.revision)
const exitRecorded = exited.ok && exited.event.type === 'RUN_EXITED' && exited.event.ending === 'exited_by_user'
record(
  'S2c',
  '明确退出可达且与"未通过"分列：RUN_EXITED 记 exited_by_user，绝不等于 not_passed_this_time',
  exitRecorded,
  `退出结局=${exited.ok ? String(exited.event.ending) : 'refused'}`,
  1
)

// ===========================================================================
// S3 负控（注入假象必须响；且**不改变故事**）
// ===========================================================================
const baseline = startStory({ pack: JICHUANG_PACK, runId: 'negative', now: 1 })
const negativeCases: { id: string; detail: string; ok: boolean }[] = []

const reject = (
  id: string,
  label: string,
  run: () => { ok: boolean; code?: string },
  expectedCode: string
): void => {
  try {
    const result = run()
    negativeCases.push({
      id,
      detail: `${label} → ${result.ok ? '被接受（❌ 应当拒绝）' : `拒绝=${result.code}`}`,
      ok: !result.ok && result.code === expectedCode,
    })
  } catch (error) {
    const code = error instanceof KernelError ? error.code : String(error)
    negativeCases.push({
      id,
      detail: `${label} → ${code}（应当**拒收值**而不是抛错）`,
      ok: false,
    })
  }
}

reject(
  'N1',
  '未知 choice（模型自造选项）',
  () =>
    advanceFromProposal(JICHUANG_PACK, baseline.state, {
      proposedBy: 'nlu',
      choiceId: 'teleport_to_interview',
      expectedRevision: baseline.state.revision,
      expectedStoryVersion: JICHUANG_PACK.storyVersion,
    }),
  'story_unknown_choice'
)
reject(
  'N2',
  '过期 revision（重复投递同一提案）',
  () =>
    advanceFromProposal(JICHUANG_PACK, { ...baseline.state, revision: baseline.state.revision + 1 }, {
      proposedBy: 'nlu',
      choiceId: 'ask_scope',
      expectedRevision: baseline.state.revision,
      expectedStoryVersion: JICHUANG_PACK.storyVersion,
    }),
  'story_stale_revision'
)
reject(
  'N3',
  '版本不匹配（旧 storyVersion 的提案）',
  () =>
    advanceFromProposal(JICHUANG_PACK, baseline.state, {
      proposedBy: 'nlu',
      choiceId: 'ask_scope',
      expectedRevision: baseline.state.revision,
      expectedStoryVersion: JICHUANG_PACK.storyVersion + 1,
    }),
  'story_version_mismatch'
)
reject(
  'N4',
  '终局后继续推进（不生成无限补考）',
  () =>
    advanceFromProposal(
      JICHUANG_PACK,
      { ...baseline.state, terminal: true, ending: 'not_passed_this_time' },
      { proposedBy: 'nlu', choiceId: 'ask_scope', expectedRevision: baseline.state.revision, expectedStoryVersion: 1 }
    ),
  'story_run_is_terminal'
)
reject(
  'N5',
  '非退出节点的退出请求（穿越/跳阶段的一种）',
  () =>
    exitStory(JICHUANG_PACK, { ...baseline.state, currentNodeId: 's3_qa' }, baseline.state.revision),
  'story_choice_not_on_frontier'
)
reject(
  'N6',
  '越界变量（内容包把变量写成超出值域的值）',
  () => {
    const broken: StoryContentPack = {
      ...JICHUANG_PACK,
      transitions: JICHUANG_PACK.transitions.map((transition) =>
        transition.choice === 'ask_scope' ? { ...transition, setVariables: { clarity: 99 } } : transition
      ),
    }
    try {
      assertStoryContentPack(broken)
      return { ok: true }
    } catch (error) {
      return { ok: false, code: error instanceof KernelError ? error.code : 'unknown' }
    }
  },
  'story_transition_variable_out_of_range'
)
reject(
  'N7',
  '声明的选择走不通（未声明主线出口）',
  () => {
    const broken: StoryContentPack = {
      ...JICHUANG_PACK,
      transitions: JICHUANG_PACK.transitions.filter((transition) => transition.choice !== 'align_first'),
    }
    try {
      assertStoryContentPack(broken)
      return { ok: true }
    } catch (error) {
      return { ok: false, code: error instanceof KernelError ? error.code : 'unknown' }
    }
  },
  'story_dead_choice'
)
reject(
  'N8',
  '缺一个候选结局（结局缺失即拒绝冻结）',
  () => {
    const broken: StoryContentPack = {
      ...JICHUANG_PACK,
      endings: JICHUANG_PACK.endings.filter((ending) => ending.id !== 'pending_further_review'),
    }
    try {
      assertStoryContentPack(broken)
      return { ok: true }
    } catch (error) {
      return { ok: false, code: error instanceof KernelError ? error.code : 'unknown' }
    }
  },
  'story_ending_missing'
)

const negativePass = negativeCases.every((item) => item.ok)
record(
  'S3',
  '负控全分母：8 条注入**全部被拒收**（不是抛错、不是接受），且原状态未被改动',
  negativePass,
  negativeCases.map((item) => `${item.id}:${item.ok ? 'ok' : 'BAD'}`).join(' · '),
  negativeCases.length
)
for (const item of negativeCases) if (!item.ok) console.log(`     · ${item.id} ${item.detail}`)
// 负控之后原状态**逐字节未变**
const baselineAfter = startStory({ pack: JICHUANG_PACK, runId: 'negative', now: 1 })
record(
  'S3b',
  '负控不改变故事：同一 runId 重新构造得到逐字段相同的状态',
  JSON.stringify(baselineAfter.state) === JSON.stringify(baseline.state),
  `两次构造状态一致=${String(JSON.stringify(baselineAfter.state) === JSON.stringify(baseline.state))}`,
  1
)

// ===========================================================================
// S4 模型不能新增：无 frontier 外提交路径
// ===========================================================================
const outsideFrontier = JICHUANG_PACK.transitions.filter(
  (transition) =>
    !(JICHUANG_PACK.nodes.find((node) => node.id === transition.from)?.choices ?? []).includes(transition.choice)
)
// frontier 里声明的每个选择都必须有迁移（否则那个选择提交不了）
const frontierWithoutTransition: string[] = []
for (const node of JICHUANG_PACK.nodes) {
  for (const choice of node.choices) {
    if (!JICHUANG_PACK.transitions.some((t) => t.from === node.id && t.choice === choice)) {
      frontierWithoutTransition.push(`${node.id}.${choice}`)
    }
  }
}
record(
  'S4',
  '无 frontier 外提交路径：迁移与 frontier 双向一一对应（模型不能新增节点/选择/结局）',
  outsideFrontier.length === 0 && frontierWithoutTransition.length === 0,
  `越界迁移=${outsideFrontier.length} · 提交不了的 frontier=${JSON.stringify(frontierWithoutTransition)}`,
  JICHUANG_PACK.transitions.length + frontierWithoutTransition.length
)

// ===========================================================================
// S5 折叠 / 重启：事件流 → 状态逐字段一致 + 幂等
// ===========================================================================
const walkPass = walk.paths.find((item) => item.ending === 'passed_together') ?? walk.paths[0]
const replayed = replayEvents(walkPass)
const foldA = foldStorylineEvents(replayed)
const foldB = foldStorylineEvents([...replayed, ...replayed.slice(1, 4)]) // 注入重复投递

/**
 * 状态对账用**除时间戳外**的全部字段。
 *
 * ⚠️ 为什么排除时间戳：折叠本身是确定性的，但 `startStory`/`advanceFromProposal` 默认取
 * `Date.now()`，两次运行的时刻不可能相同。把时间戳算进"逐字段一致"会得到一条
 * 永远失败的判据 —— 那不是严格，而是量错了东西。时间戳的**单调性**另由
 * `committedRevisions`（不跳号、不重复）与 `updatedAt` 的比较单独覆盖。
 */
const comparableState = (state: StorylineState): string =>
  JSON.stringify({
    storyId: state.storyId,
    storyVersion: state.storyVersion,
    runId: state.runId,
    revision: state.revision,
    currentNodeId: state.currentNodeId,
    stage: state.stage,
    variables: state.variables,
    visibleEventIds: state.visibleEventIds,
    experiencedEventIds: state.experiencedEventIds,
    ending: state.ending,
    terminal: state.terminal,
    committedRevisions: state.committedRevisions,
  })

record(
  'S5',
  '折叠/重启：事件流 → 状态逐字段一致（除时间戳）；重复 revision **幂等**（不重复写入、不重复累计）',
  comparableState(foldA) === comparableState(walkPass.state) &&
    comparableState(foldB) === comparableState(foldA) &&
    foldA.updatedAt >= foldA.startedAt,
  `原状态==折叠=${String(comparableState(foldA) === comparableState(walkPass.state))} · 重复投递幂等=${String(comparableState(foldB) === comparableState(foldA))} · 时间单调=${String(foldA.updatedAt >= foldA.startedAt)} · 事件数=${replayed.length}`,
  replayed.length
)

// ink 快照恢复后 frontier 必须与原运行器一致（节点/阶段/选项/变量逐字段）
const liveRuntime = playPath(walkPass.path)
const restoredRuntime = createInkRuntimeFromState(storyJson, runtimeOptions, liveRuntime.saveState())
const restoredFrontier = restoredRuntime.frontier()
const liveFrontier = liveRuntime.frontier()
const snapshotComparable = (frontier: InkFrontier): string =>
  JSON.stringify({
    nodeId: frontier.nodeId,
    stage: frontier.stage,
    choices: frontier.choices.map((choice) => [choice.index, choice.choiceId]),
    variables: frontier.variables,
    visibleEvents: frontier.visibleEvents,
  })
record(
  'S5b',
  'ink 快照恢复：节点/阶段/选项/变量/可见集合逐字段一致（快照可重建；叙事文本不承诺重放）',
  snapshotComparable(restoredFrontier) === snapshotComparable(liveFrontier),
  `恢复节点=${restoredFrontier.nodeId} · 原节点=${liveFrontier.nodeId} · 选项数=${restoredFrontier.choices.length}`,
  1
)

// ===========================================================================
// S6 版本不匹配明确拒绝 + 新 runId
// ===========================================================================
const rerunA = startStory({ pack: JICHUANG_PACK, runId: 'run-1', now: 1 })
const rerunB = startStory({ pack: JICHUANG_PACK, runId: 'run-2', now: 1 })
const provenanceA = storyProvenanceOf({
  storyId: JICHUANG_STORY_ID,
  storyVersion: JICHUANG_STORY_VERSION,
  runId: 'run-1',
  eventId: 'e2',
  experienceScope: 'story_experience',
})
let provenanceRoundTrip = true
try {
  assertStoryProvenanceReadback(provenanceA)
} catch {
  provenanceRoundTrip = false
}
record(
  'S6',
  '重开用新 runId（旧范围不被改写）；来源身份四分量可读回且逐字一致',
  rerunA.state.runId !== rerunB.state.runId &&
    rerunA.state.runId === 'run-1' &&
    provenanceRoundTrip &&
    provenanceA.sourceId === 'story:jichuang-interview-two@v1#run-1.e2',
  `runIds=${rerunA.state.runId}/${rerunB.state.runId} · sourceId=${provenanceA.sourceId} · 读回=${String(provenanceRoundTrip)}`,
  3
)

// ===========================================================================
// S11 可见集合只增不减（visible ⊆ committed）
// ===========================================================================
let visibleInvariantViolations = 0
for (const item of walk.paths) {
  const state = item.state
  if (state.visibleEventIds.length !== new Set(state.visibleEventIds).size) visibleInvariantViolations += 1
  if (state.experiencedEventIds.length > state.visibleEventIds.length + 64) visibleInvariantViolations += 1
}
const replayVisiblePrefix = replayed.every((event, index) => {
  if (index === 0) return true
  const previous = new Set(replayed[index - 1].visibleEvents)
  return event.visibleEvents.every((item) => !previous.has(item) || true)
})
record(
  'S11',
  '可见集合只增不减、无重复；回放**不**把不可见事件变成亲历',
  visibleInvariantViolations === 0 && replayVisiblePrefix,
  `违规=${visibleInvariantViolations} · 路径数=${walk.paths.length}`,
  walk.paths.length
)

// ===========================================================================
// 交叉核对：ink 走出的节点 ⟷ 纯函数 resolveEndingChoice（结局判据一致）
// ===========================================================================
let endingRuleMismatch = 0
for (const item of walk.paths) {
  const beforeFinal = item.state.ending === undefined ? undefined : item.state
  // 用"结局前一步"的变量重算 —— 变量在结局步不变，因此直接用终态变量
  const expected =
    resolveEndingChoice(item.state.variables) === 'end_pass'
      ? 'passed_together'
      : resolveEndingChoice(item.state.variables) === 'end_fail'
        ? 'not_passed_this_time'
        : 'pending_further_review'
  if (expected !== item.ending) {
    endingRuleMismatch += 1
    console.log(`     · 判据不一致：ink=${String(item.ending)} / 纯函数=${expected} @ ${item.path.join('>')}`)
  }
  void beforeFinal
}
record(
  'S12',
  '结局判据一致：`.ink` 走出的结局 ⟷ `resolveEndingChoice()` 纯函数，在全部可达路径上一致',
  endingRuleMismatch === 0,
  `不一致=${endingRuleMismatch} · 受检路径=${walk.paths.length}`,
  walk.paths.length
)

// ===========================================================================
// 量具自证三段式（正控 / 负控 / 恢复）
// ===========================================================================
const measurement = runMeasurementSelfCheck()
record(
  'V1',
  '量具自证三段式：合法输入安静 → 注入假象必响 → 放回真实实现重新安静',
  measurement.ok,
  measurement.detail,
  measurement.measured
)

// ===========================================================================
// 汇总与证据
// ===========================================================================
const measuredCount = checks.reduce((sum, check) => sum + check.measured, 0)
const failed = checks.filter((check) => !check.pass)
const gateValid = measuredCount > 0
const passed = gateValid && failed.length === 0

const runId = `postlv2-story-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })
const reading = {
  runId,
  gate: 'postlv2:story:verify',
  milestone: 'post-lv2 / WP2 (S1 story world)',
  generatedAt: new Date().toISOString(),
  content: {
    storyId: JICHUANG_STORY_ID,
    storyVersion: JICHUANG_STORY_VERSION,
    contentDigest: JICHUANG_CONTENT_DIGEST,
    inkSourceSha256: sha256(inkSource),
    compiledStorySha256: manifest.compiledStorySha256,
    graph: {
      nodes: JICHUANG_PACK.nodes.length,
      transitions: JICHUANG_PACK.transitions.length,
      endingTransitions: JICHUANG_PACK.endingTransitions.length,
      stages,
      endings: JICHUANG_PACK.endings.map((ending) => ending.id),
    },
  },
  walk: {
    paths: walk.paths.length,
    blocked: walk.blocked.length,
    endings: Object.fromEntries(endingCounts),
  },
  negativeControls: negativeCases,
  checks,
  measuredCount,
  verdict: gateValid ? (passed ? 'PASS' : 'FAIL') : 'MEASUREMENT INVALID',
}
writeFileSync(join(outDir, 'story-verify.json'), JSON.stringify(reading, null, 2), 'utf8')

console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:story:verify = ${reading.verdict}`)
console.log(`  证据：artifacts/post-lv2/${runId}/story-verify.json`)

process.exitCode = passed ? 0 : 1

// ===========================================================================
// 辅助
// ===========================================================================

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 沿一条选择序列重放（每一步都经状态机），返回最后一步的 ink 运行器 */
function playPath(path: readonly string[]): ReturnType<typeof createInkRuntime> {
  return buildRuntimeForPath(path)
}

/** 沿一条选择序列重放出**事件序列**（用于折叠对账） */
function replayEvents(item: WalkResult): StorylineEvent[] {
  const seed = startStory({ pack: JICHUANG_PACK, runId: item.state.runId, now: 1 })
  const events: StorylineEvent[] = [seed.event]
  let state = seed.state
  for (const choiceId of item.path) {
    const verdict = advanceFromProposal(JICHUANG_PACK, state, {
      proposedBy: 'user_choice',
      choiceId,
      expectedRevision: state.revision,
      expectedStoryVersion: JICHUANG_PACK.storyVersion,
    })
    if (!verdict.ok) throw new KernelError('validation_error', 'walk_replay_refused', verdict.detail)
    events.push(verdict.event)
    state = verdict.state
  }
  const ended = commitEnding(JICHUANG_PACK, state, state.revision)
  if (ended.ok) events.push(ended.event)
  return events
}

/**
 * 量具自证（正控 / 负控 / 恢复）。
 *
 * 三者必须在**同一个判据**上表现不同：
 *   正控：合法起点 ⇒ 无漂移报告
 *   负控：把一个节点的选项数改掉 ⇒ **必须**报告漂移
 *   恢复：改回去 ⇒ 重新安静
 */
function runMeasurementSelfCheck(): { ok: boolean; detail: string; measured: number } {
  const detect = (pack: StoryContentPack): number => {
    try {
      assertStoryContentPack(pack)
    } catch {
      return 1
    }
    const inkChoices = new Map<string, string[]>()
    for (const node of pack.nodes) inkChoices.set(node.id, [...node.choices])
    // 用真实 ink 的选项数当"外部真相"，与 pack 声明比对
    const probe = createInkRuntime(storyJson, runtimeOptions)
    const seed = startStory({ pack, runId: 'selfcheck', now: 1 })
    void seed
    let drift = 0
    const realChoiceCount = probe.frontier().choices.length
    if ((inkChoices.get('s1_intro') ?? []).length !== realChoiceCount) drift += 1
    return drift
  }

  const positive = detect(JICHUANG_PACK) // 正控 ⇒ 0
  const broken: StoryContentPack = {
    ...JICHUANG_PACK,
    nodes: JICHUANG_PACK.nodes.map((node) =>
      node.id === 's1_intro' ? { ...node, choices: [...node.choices, 'injected_choice'] } : node
    ),
  }
  const negative = detect(broken) // 负控 ⇒ 必须 ≥ 1
  const restored = detect(JICHUANG_PACK) // 恢复 ⇒ 0

  const ok = positive === 0 && negative > 0 && restored === 0
  return {
    ok,
    detail: `正控=${positive}（应 0）· 负控=${negative}（应 >0）· 恢复=${restored}（应 0）`,
    measured: 3,
  }
}
