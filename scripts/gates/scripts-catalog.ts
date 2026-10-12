/**
 * `scripts/` 目录清单生成器 —— **P2-11「575 个条目收敛」的交付物之一**（2026-10-07）。
 *
 * ============================================================================
 *  它回答什么问题
 * ============================================================================
 * `package.json` 里有 **575 条**脚本、`scripts/` 下有 **672 个**顶层文件。
 * 面对这个量级，"哪个是入口、哪个是内部件"必须**机器可答**，不能靠人记。
 *
 * 本生成器按一条**机械规则**给每条脚本一个分类（规则见下），产出
 * [`docs/architecture/Scripts-Catalog.md`](../../docs/architecture/Scripts-Catalog.md)。
 * `--check` 模式把生成结果与已提交的那份逐字节比较：不一致 ⇒ exit 1（门 `scripts:catalog:verify`）。
 *
 * ⚠️ 它**不改名、不删条目**：本仓库的文档与 ADR 大量引用这些名字，
 *    重命名是破坏性变更、需要独立裁定。本清单只把"现状"变成可查的。
 *
 * 用法：
 *   pnpm scripts:catalog           # 生成 / 更新清单
 *   pnpm scripts:catalog:verify    # 只校验（门）
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ALL_GATES, LANES, REPO_ROOT } from './manifest.ts'

const DOC_PATH = join(REPO_ROOT, 'docs', 'architecture', 'Scripts-Catalog.md')

type Kind = '已登记门' | '汇总/链入口' | '文档入口' | '内部'

const KIND_ORDER: readonly Kind[] = ['已登记门', '汇总/链入口', '文档入口', '内部']

const KIND_NOTE: Record<Kind, string> = {
  已登记门: '可被 lane / `pnpm fast` 调度，有资源声明与冲突图保护',
  '汇总/链入口': '里程碑或链的收口命令（只读汇总，或串行链）',
  文档入口: '有人类读的入口说明（写在 `AGENTS.md` / `README.md` 里）',
  内部: '**内部件**：由别的脚本或门调用、或一次性排查用 —— 不是对外入口',
}

/**
 * lane → 人类入口命令（**别名表**，因为别名不一定叫 `<lane>:gates`）。
 * 只登记 `package.json` 里**确实存在**的名字；查不到就是 `—`（不编造命令）。
 */
const LANE_ENTRY_ALIASES: Record<string, readonly string[]> = {
  'm11.1': ['m11.1:gates'],
  offline: ['m4.5:ci', 'fast:offline'],
  summaries: ['gates:run --lane summaries'],
  all: ['gates:run --lane all'],
  td: ['td:gates'],
  m9: ['m9:gates'],
  'm9.5': ['m9.5:gates'],
  m10: ['m10:gates'],
  'm10-semantic': ['m10-semantic:gates'],
  'memory-coverage': ['memory-coverage:gates'],
  'm9.6': ['m9.6:gates'],
  postlv2: ['postlv2:s8:gates'],
  'postlv2-controls': ['postlv2:controls:gates'],
  lv2: ['lv2:gates', 'lv2:inherited:gates'],
  'summaries-all': ['summaries:all'],
  scripts: ['scripts:gates'],
  affected: ['fast'],
  'desktop-control': ['desktop-control:verify', 'desktop-control:probe'],
}

function readText(path: string): string {
  return readFileSync(path, 'utf8')
}

interface PackageJson {
  readonly scripts: Record<string, string>
}

const pkg = JSON.parse(readText(join(REPO_ROOT, 'package.json'))) as PackageJson
const gateIds = new Set(ALL_GATES.map((gate) => gate.id))
const laneIds = LANES.map((lane) => lane.id)
const docsText = `${readText(join(REPO_ROOT, 'AGENTS.md'))}\n${readText(join(REPO_ROOT, 'README.md'))}`

function classify(name: string): Kind {
  if (gateIds.has(name)) return '已登记门'
  if (/:(gates|gates:verify|ci|ci:full)$/.test(name)) return '汇总/链入口'
  /*
   * 文档入口的判据是**逐字出现**，且必须带边界：
   * `m4:test` 会作为子串出现在 `m4:test:identity` 里 —— 用反引号包住的写法做边界，
   * 既避开子串误判，也和仓库里"命令一律写成 `pnpm x` / 反引号包名字"的习惯一致。
   */
  if (docsText.includes(`\`${name}\``)) return '文档入口'
  return '内部'
}

interface Row {
  readonly name: string
  readonly command: string
  readonly kind: Kind
  readonly prefix: string
}

const rows: Row[] = Object.entries(pkg.scripts)
  .map(([name, command]) => ({ name, command, kind: classify(name), prefix: name.split(':')[0] ?? name }))
  .sort((a, b) => a.name.localeCompare(b.name))

/** `scripts/` 顶层文件（含子目录文件）里，**没有任何 pnpm 入口引用**的那些 —— 真正的"内部文件" */
function unenteredScriptFiles(): string[] {
  const commands = Object.values(pkg.scripts).join('\n')
  const out: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === '__pycache__' || entry.name === 'node_modules') continue
        walk(join(dir, entry.name), relative)
        continue
      }
      if (!/\.(ts|mjs|js|py|ps1|cmd)$/.test(entry.name)) continue
      if (!commands.includes(relative)) out.push(`scripts/${relative}`)
    }
  }
  walk(join(REPO_ROOT, 'scripts'), '')
  return out.sort((a, b) => a.localeCompare(b))
}

function render(): string {
  const byKind = new Map<Kind, number>(KIND_ORDER.map((kind) => [kind, 0]))
  for (const row of rows) byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + 1)

  const prefixes = [...new Set(rows.map((row) => row.prefix))].sort((a, b) => a.localeCompare(b))
  const unentered = unenteredScriptFiles()
  const lines: string[] = []

  lines.push('# `scripts/` 条目清单（自动生成 —— **不要手改**）')
  lines.push('')
  lines.push('> 生成：`pnpm scripts:catalog` · 校验：`pnpm scripts:catalog:verify`（门 `scripts:catalog:verify`）。')
  lines.push('> 生成器：[`scripts/gates/scripts-catalog.ts`](../../scripts/gates/scripts-catalog.ts)。')
  lines.push('> ⚠️ 本文件**没有时间戳**：`--check` 要求逐字节可复现，时间戳会让它每次都"过期"。')
  lines.push('> ⚠️ 它**不改名、不删条目**：把"现状"变成可查的；收敛命名是独立的破坏性变更。')
  lines.push('')
  lines.push('## 分类规则（机械、可复核，按顺序判定）')
  lines.push('')
  lines.push('| 类别 | 判据 | 含义 |')
  lines.push('|---|---|---|')
  for (const kind of KIND_ORDER) {
    const rule =
      kind === '已登记门'
        ? '条目名 ∈ `ALL_GATES` 的 id 集合'
        : kind === '汇总/链入口'
          ? '名字匹配 `:(gates|gates:verify|ci|ci:full)$`'
          : kind === '文档入口'
            ? '`AGENTS.md` / `README.md` 里**逐字出现** `` `名字` ``'
            : '以上都不是'
    lines.push(`| **${kind}** | ${rule} | ${KIND_NOTE[kind]} |`)
  }
  lines.push('')
  lines.push('## 计数')
  lines.push('')
  lines.push('| 类别 | 条目数 |')
  lines.push('|---|---:|')
  for (const kind of KIND_ORDER) lines.push(`| ${kind} | ${String(byKind.get(kind) ?? 0)} |`)
  lines.push(`| **合计** | **${String(rows.length)}** |`)
  lines.push('')
  lines.push(
    '`scripts/` 下**没有任何 pnpm 入口引用**的脚本文件：**' + String(unentered.length) + ' 个**（见文末）。'
  )
  lines.push('')
  lines.push('## 每条 lane 的入口命令')
  lines.push('')
  lines.push('| lane | 入口 | 说明 |')
  lines.push('|---|---|---|')
  for (const lane of LANES) {
    const aliases = (LANE_ENTRY_ALIASES[lane.id] ?? []).filter(
      (alias) => alias.includes('--lane') || pkg.scripts[alias] !== undefined
    )
    const declared = aliases.length > 0 ? aliases.map((alias) => `\`pnpm ${alias}\``).join(' · ') : '—'
    lines.push(`| \`${lane.id}\` | ${declared} | ${lane.title} |`)
  }
  lines.push('')
  lines.push('## 按前缀分列')
  lines.push('')
  for (const prefix of prefixes) {
    const bucket = rows.filter((row) => row.prefix === prefix)
    const gates = bucket.filter((row) => row.kind === '已登记门')
    const entries = bucket.filter((row) => row.kind === '汇总/链入口' || row.kind === '文档入口')
    const internal = bucket.filter((row) => row.kind === '内部')
    const isLane = laneIds.includes(prefix)
    lines.push(
      `### \`${prefix}\`（${String(bucket.length)} 条${isLane ? ' · **有同名 lane**' : ''}）`
    )
    lines.push('')
    if (entries.length > 0) {
      lines.push('**入口**：')
      for (const row of entries) lines.push(`- \`${row.name}\` — ${row.kind}`)
      lines.push('')
    }
    if (gates.length > 0) {
      lines.push(`**已登记门（${String(gates.length)}）**：${gates.map((row) => `\`${row.name}\``).join(' · ')}`)
      lines.push('')
    }
    if (internal.length > 0) {
      lines.push(`**内部（${String(internal.length)}）**：${internal.map((row) => `\`${row.name}\``).join(' · ')}`)
      lines.push('')
    }
  }
  lines.push('## 没有任何 pnpm 入口引用的脚本文件')
  lines.push('')
  lines.push(
    '判据：`scripts/` 下的脚本文件路径**不出现在任何** `package.json` 命令里（含子目录；跳过 `__pycache__`）。' +
      '这些文件由别的脚本 import、由门调用、或是一次性排查件 —— **它们不是入口**。'
  )
  lines.push('')
  for (const file of unentered) lines.push(`- \`${file}\``)
  lines.push('')
  return `${lines.join('\n')}\n`
}

const rendered = render()
const check = process.argv.includes('--check')

if (check) {
  if (!existsSync(DOC_PATH)) {
    console.error(`❌ 清单不存在：${DOC_PATH}（先跑 pnpm scripts:catalog）`)
    process.exit(1)
  }
  const current = readFileSync(DOC_PATH, 'utf8')
  if (current === rendered) {
    console.log(`✅ scripts 清单与 package.json / manifest 一致（${String(rows.length)} 条）`)
    process.exit(0)
  }
  const currentLines = current.split('\n')
  const renderedLines = rendered.split('\n')
  const firstDiff = renderedLines.findIndex((line, index) => currentLines[index] !== line)
  console.error('❌ scripts 清单已过期（与 package.json / manifest 不一致）')
  console.error(`   首个不同处：第 ${String(firstDiff + 1)} 行`)
  console.error(`   已提交：${currentLines[firstDiff] ?? '（文件更短）'}`)
  console.error(`   现在应：${renderedLines[firstDiff] ?? '（文件更长）'}`)
  console.error(`   行数：已提交 ${String(currentLines.length)} / 现在 ${String(renderedLines.length)}`)
  console.error('   ⇒ 跑 `pnpm scripts:catalog` 更新，并在同一个提交里说明改了什么。')
  process.exit(1)
}

writeFileSync(DOC_PATH, rendered, 'utf8')
console.log(`✅ 已写出 ${DOC_PATH}（${String(rows.length)} 条 · ${String(rendered.length)} 字节）`)
