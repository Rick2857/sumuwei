/**
 * 后 Lv2 · S1 —— **ink 内容包编译**（`pnpm postlv2:story:build`）。
 *
 * ============================================================================
 *  载体：ADR-091 §2 · 故事世界来源契约 S1/S6 · 计划 §3（inkjs）
 * ============================================================================
 * 它做四件事（**全离线，不碰数据库、不发模型请求**）：
 * ```text
 * ① 编译 evals/storyline/jichuang-interview-two/*.ink → 同名 .json
 * ② 解析 .ink 源的机器标签（node / stage / visible / choice）→ 与内容包逐条比对
 * ③ 生成 content-manifest.json：ink 源与编译产物的 sha256 + storyId/version
 * ④ 用位置锚定构造运行器并读一次起点 frontier（证明"能跑"，不是"能编译"）
 * ```
 * ⚠️ 编译失败或标签漂移**必须**退出码非 0（不能"用旧 JSON 继续跑"：
 * 那会让版本漂移变成静默的，而来源身份里带着 `storyVersion`）。
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  choiceIdsByNodeOf,
  compileInkSource,
  createInkRuntime,
} from '../src/infrastructure/storyline/ink-runtime.ts'
import { JICHUANG_PACK } from '../evals/storyline/jichuang-interview-two/story-pack.ts'
import { assertStoryContentPack } from '../src/kernel/storyline/story-types.ts'

const REPO_ROOT = resolve(process.cwd())
const PACK_DIR = join(REPO_ROOT, 'evals/storyline/jichuang-interview-two')
const INK_REL = 'evals/storyline/jichuang-interview-two/jichuang-interview-two.ink'
const JSON_REL = 'evals/storyline/jichuang-interview-two/jichuang-interview-two.json'
const MANIFEST_REL = 'evals/storyline/jichuang-interview-two/content-manifest.json'

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** 解析 `.ink` 源的机器标签（**静态**判据；运行期拿不到选项标签，见 ink-runtime 的说明） */
export interface InkTagScan {
  nodes: string[]
  choicesByNode: Record<string, string[]>
  visibleByNode: Record<string, string[]>
  stagesByNode: Record<string, string>
}

export function scanInkTags(source: string): InkTagScan {
  const nodes: string[] = []
  const choicesByNode: Record<string, string[]> = {}
  const visibleByNode: Record<string, string[]> = {}
  const stagesByNode: Record<string, string> = {}

  let currentNode: string | undefined
  let pendingChoice: string | undefined

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    const nodeMatch = /^#\s*node:([A-Za-z0-9_-]+)$/.exec(line)
    if (nodeMatch) {
      currentNode = nodeMatch[1]
      nodes.push(currentNode)
      choicesByNode[currentNode] = []
      visibleByNode[currentNode] = []
      continue
    }
    if (!currentNode) continue

    const stageMatch = /^#\s*stage:([A-Za-z0-9_-]+)$/.exec(line)
    if (stageMatch) {
      stagesByNode[currentNode] = stageMatch[1]
      continue
    }
    const visibleMatch = /^#\s*visible:([A-Za-z0-9_-]+)$/.exec(line)
    if (visibleMatch) {
      visibleByNode[currentNode].push(visibleMatch[1])
      continue
    }
    // 选项行形如： `* [文本] # choice:<id>`（结论：标签**在**选项行上）
    const choiceMatch = /^\*\s*\[[^\]]*\]\s*#\s*choice:([A-Za-z0-9_-]+)\s*$/.exec(line)
    if (choiceMatch) {
      pendingChoice = choiceMatch[1]
      choicesByNode[currentNode].push(pendingChoice)
      continue
    }
    if (pendingChoice !== undefined && line !== '' && !line.startsWith('*')) {
      pendingChoice = undefined
    }
  }

  return { nodes, choicesByNode, visibleByNode, stagesByNode }
}

console.log('  ① 编译 ink 内容包 …')
const source = readFileSync(join(PACK_DIR, 'jichuang-interview-two.ink'), 'utf8')
const json = compileInkSource(source)
writeFileSync(join(PACK_DIR, 'jichuang-interview-two.json'), json, 'utf8')

console.log('  ② 静态交叉核对 .ink 机器标签 ⟷ 内容包 …')
assertStoryContentPack(JICHUANG_PACK)
const scan = scanInkTags(source)
const problems: string[] = []

const packNodeIds = JICHUANG_PACK.nodes.map((node) => node.id)
for (const id of packNodeIds) {
  if (!scan.nodes.includes(id)) problems.push(`内容包节点 ${id} 在 .ink 里没有 # node: 声明`)
}
for (const id of scan.nodes) {
  if (!packNodeIds.includes(id)) problems.push(`.ink 节点 ${id} 不在内容包里（图漂移）`)
}
for (const node of JICHUANG_PACK.nodes) {
  const inkChoices = scan.choicesByNode[node.id] ?? []
  if (JSON.stringify(inkChoices) !== JSON.stringify([...node.choices])) {
    problems.push(
      `节点 ${node.id} 的选项不一致：.ink=${JSON.stringify(inkChoices)} / 内容包=${JSON.stringify([...node.choices])}`
    )
  }
  const inkVisible = scan.visibleByNode[node.id] ?? []
  if (JSON.stringify(inkVisible) !== JSON.stringify([...node.visibleEvents])) {
    problems.push(
      `节点 ${node.id} 的可见事件不一致：.ink=${JSON.stringify(inkVisible)} / 内容包=${JSON.stringify([...node.visibleEvents])}`
    )
  }
  if (scan.stagesByNode[node.id] !== node.stage) {
    problems.push(`节点 ${node.id} 的阶段不一致：.ink=${String(scan.stagesByNode[node.id])} / 内容包=${node.stage}`)
  }
}

// `.ink` 里出现的节点若不是可达结局节点，必须在迁移目标里出现（否则是走不到的死重）
const transitionTargets = new Set([
  ...JICHUANG_PACK.transitions.map((transition) => transition.to),
  ...JICHUANG_PACK.endingTransitions.map((transition) => transition.to),
])
for (const id of scan.nodes) {
  if (id === JICHUANG_PACK.entryNodeId) continue
  // 显式退出落点由运行器的 RUN_EXITED 路径到达（不是普通迁移），单独放行
  if (id === 'end_exit') continue
  if (!transitionTargets.has(id)) problems.push(`.ink 节点 ${id} 没有任何迁移指向它（不可达）`)
}
// 退出节点由运行器的 RUN_EXITED 路径到达（不是普通迁移），但必须在 .ink 里有对应节点
for (const exitNode of JICHUANG_PACK.exitNodes) {
  if (!scan.nodes.includes(exitNode)) problems.push(`退出节点 ${exitNode} 在 .ink 里没有对应节点`)
}
if (!scan.nodes.includes('end_exit')) problems.push('.ink 缺少 end_exit 节点（明确退出路径的落点）')

console.log('  ③ 位置锚定构造运行器并读起点 …')
const runtime = createInkRuntime(json, { choiceIdsByNode: choiceIdsByNodeOf(JICHUANG_PACK.nodes) })
const frontier = runtime.frontier()
console.log(`     节点=${frontier.nodeId} · 阶段=${frontier.stage}`)
console.log(`     可见事件=${JSON.stringify(frontier.visibleEvents)}`)
console.log(`     选项=${JSON.stringify(frontier.choices.map((choice) => choice.choiceId))}`)

if (frontier.nodeId === '') problems.push('编译产物读不出 # node: 标签')
if (frontier.choices.length === 0) problems.push('编译产物读不出选项（起点应为 3 个）')

if (problems.length > 0) {
  console.error('')
  for (const problem of problems) console.error(`  ❌ ${problem}`)
  console.error(`\n❌ postlv2:story:build 失败：${problems.length} 处漂移`)
  process.exitCode = 1
} else {
  const manifest = {
    storyId: JICHUANG_PACK.storyId,
    storyVersion: JICHUANG_PACK.storyVersion,
    title: JICHUANG_PACK.title,
    inkSource: INK_REL,
    inkSourceSha256: sha256(source),
    compiledStory: JSON_REL,
    compiledStorySha256: sha256(json),
    compiledAt: new Date().toISOString(),
    machineTagContract: ['node:<id>', 'stage:<id>', 'visible:<id>', 'choice:<id>'],
    graph: {
      nodes: JICHUANG_PACK.nodes.length,
      transitions: JICHUANG_PACK.transitions.length,
      stages: [...new Set(JICHUANG_PACK.nodes.map((node) => node.stage))],
      endings: JICHUANG_PACK.endings.map((ending) => ending.id),
      exitNodes: JICHUANG_PACK.exitNodes,
    },
    note:
      '本 manifest 是内容包指纹（来源身份含 storyVersion）。' +
      'inkjs 2.4.0 运行期不暴露选项行标签 ⇒ 选项身份按**位置**锚定（ink-runtime.ts）。',
  }
  writeFileSync(join(PACK_DIR, 'content-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  console.log(
    `\n  ✅ postlv2:story:build PASS · ${json.length} 字节 · 源 sha256 ${manifest.inkSourceSha256.slice(0, 16)}`
  )
  console.log(`  证据：${MANIFEST_REL}`)
}
