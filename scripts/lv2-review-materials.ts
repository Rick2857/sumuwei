/**
 * Lv2 —— **人审材料包**（`pnpm lv2:review:materials`；计划 §5.4 / `LV2-G8`）。
 *
 * 做：从已落盘读数生成"给人审的材料"（表 + 四个审题 + 记录模板），并**机器断言**材料里
 *     不含任何回复正文（正文只在 `artifacts/lv2/local/**`，不进仓库）。
 * 不做：它**不**替人判定 —— `LV2-G8` 在真人明确裁定之前保持 **NOT RUN**。
 *
 * ⚠️ 本文件**刻意不用模板字符串**：第一版在中文与反引号混排处触发了解析错误
 *    （TS1127/TS1434，位置在"看起来没问题"的那一行）⇒ 改成纯字符串拼接，消灭这一类。
 */

import 'dotenv/config'

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createLv2RunId, openLv2RunDir, writeLv2Manifest } from './lv2-evidence.ts'

const ROOT = process.cwd()
const LV2 = join(ROOT, 'artifacts', 'lv2')

interface RunRow {
  readonly dir: string
  readonly wp: string
  readonly verdict: string
  readonly ended: string
  readonly counts: Record<string, number>
  readonly denominators: Record<string, unknown>
}

function readRuns(): RunRow[] {
  if (!existsSync(LV2)) return []
  const rows: RunRow[] = []
  for (const entry of readdirSync(LV2, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'local') continue
    const path = join(LV2, entry.name, 'manifest.json')
    if (!existsSync(path)) continue
    try {
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      rows.push({
        dir: entry.name,
        wp: String(manifest.wp ?? ''),
        verdict: String(manifest.verdict ?? 'UNKNOWN'),
        ended: String(manifest.ended ?? ''),
        counts: (manifest.counts ?? {}) as Record<string, number>,
        denominators: (manifest.denominators ?? {}) as Record<string, unknown>,
      })
    } catch {
      continue
    }
  }
  return rows.sort((a, b) => (a.ended === b.ended ? (a.dir < b.dir ? 1 : -1) : a.ended < b.ended ? 1 : -1))
}

function main(): void {
  const started = new Date().toISOString()
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const runs = readRuns()
  const pick = (prefix: string): RunRow | undefined => runs.find((run) => run.wp.startsWith(prefix))
  const latestShort = pick('wp4-short')
  const trajectory = runs.find((run) => run.wp === 'wp5-trajectory' && run.verdict !== 'PREFLIGHT')
  const restart = pick('wp5-restart')
  const privacy = pick('wp6-privacy-budget')

  const lines: string[] = []
  lines.push('# Lv2 人审材料（LV2-G8）')
  lines.push('')
  lines.push('> 生成：' + started + ' · head ' + head.slice(0, 12) + ' · 由 pnpm lv2:review:materials 生成')
  lines.push('> 本材料只含读数；回复正文在 artifacts/lv2/local/<runId>/replies.json（不进仓库）。')
  lines.push('')
  lines.push('## 1. 要看什么（按优先序）')
  lines.push('')
  lines.push('| # | 材料 | 位置 | 关注点 |')
  lines.push('|---|---|---|---|')
  lines.push('| 1 | 短场景四代读数（12 类 × 6 案 × 2 轮真实回复） | artifacts/lv2/' + String(latestShort?.dir ?? '缺') + '/ | 她说的与库里发生的是否一致 |')
  lines.push('| 2 | 混合轨迹真实档 50 轮 + 15 次回访 | artifacts/lv2/' + String(trajectory?.dir ?? '缺') + '/ | 长程连续性：身份/口气/取回/终态 |')
  lines.push('| 3 | 重启与 rebuild | artifacts/lv2/' + String(restart?.dir ?? '缺') + '/ | 重启后状态是否连续（现读数只在控制档） |')
  lines.push('| 4 | 隐私与预算 | artifacts/lv2/' + String(privacy?.dir ?? '缺') + '/ | 真实库隔离与"正文不进仓库" |')
  lines.push('')
  lines.push('## 2. 四个审题（请逐条给"无异议 / 有问题"）')
  lines.push('')
  lines.push('Q1 身份与口气：跨 50 轮、跨重启后，她还是同一个苏沐薇吗？（C01 + 轨迹 + 重启档）')
  lines.push('Q2 澄清与不猜：无标记的更正/隐含改动，她是否要求澄清而不猜着改？（C02-02 已裁定口径）')
  lines.push('Q3 归属与结清：她说的"记下了/说定了"与程序事实是否一致？约定/目标终态是否可核对？（C07/C08）')
  lines.push('Q4 自然性与长程连续性：50 轮里有没有越用越不像她或明显机械化的段落？')
  lines.push('')
  lines.push('## 3. 读数摘要（机器生成，非人审结论）')
  lines.push('')
  lines.push('| run | verdict | 关键计数 |')
  lines.push('|---|---|---|')
  const listed = [latestShort, trajectory, restart, privacy]
  for (const run of listed) {
    if (run === undefined) continue
    const key = Object.entries(run.counts)
      .map(([name, value]) => name + '=' + String(value))
      .join(' · ')
    lines.push('| ' + run.wp + '（' + run.dir + '） | ' + run.verdict + ' | ' + key + ' |')
  }
  lines.push('')
  lines.push('## 4. 记录模板（写在本地，不入库）')
  lines.push('')
  lines.push('artifacts/lv2/local/blind-review-record.md —— 审阅人/时间 · Q1–Q4 逐条 · 结论（无异议 / 有问题）')
  lines.push('')
  const table = lines.join('\n')

  /* 机器断言：材料里不得出现回复正文（抽查句子级窗口） */
  const replySamples: string[] = []
  const localRoot = join(LV2, 'local')
  if (existsSync(localRoot)) {
    for (const entry of readdirSync(localRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const repliesPath = join(localRoot, entry.name, 'replies.json')
      if (!existsSync(repliesPath)) continue
      try {
        const parsed = JSON.parse(readFileSync(repliesPath, 'utf8')) as {
          payloads?: readonly { replies?: readonly { reply?: unknown }[] }[]
        }
        for (const payload of parsed.payloads ?? []) {
          for (const row of payload.replies ?? []) {
            if (typeof row.reply === 'string' && row.reply.length >= 12) replySamples.push(row.reply.slice(0, 20))
          }
        }
      } catch {
        continue
      }
    }
  }
  const leaked = replySamples.filter((sample) => table.includes(sample))
  const checks = [
    { id: 'M1-扫到证据库', pass: runs.length > 0, note: 'run 数 = ' + String(runs.length) },
    { id: 'M2-含四个审题', pass: lines.join(' ').includes('Q4'), note: 'Q1–Q4 齐全' },
    { id: 'M3-含记录模板', pass: table.includes('blind-review-record.md'), note: '模板在材料里' },
    { id: 'M4-材料不含回复正文', pass: leaked.length === 0, note: '抽查 ' + String(replySamples.length) + ' 个窗口 · 命中 ' + String(leaked.length) },
  ]
  const verdict = checks.every((check) => check.pass) ? 'PASS' : 'FAIL'

  const runId = createLv2RunId({ wpId: 'wp7-review-materials', headShort: head })
  const dir = openLv2RunDir(ROOT, runId)
  writeFileSync(join(dir, 'review-materials.md'), table + '\n', 'utf8')
  const localDir = join(LV2, 'local', runId)
  mkdirSync(localDir, { recursive: true })
  writeFileSync(
    join(localDir, 'blind-review-record.md'),
    '# Lv2 人审记录（模板 · 本地保存，不入库）\n\n审阅人：\n时间：\n\nQ1：\nQ2：\nQ3：\nQ4：\n\n结论：\n',
    'utf8',
  )
  const manifestPath = writeLv2Manifest(dir, {
    runId,
    wp: 'wp7-review-materials',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    toolVersions: { node: process.version },
    testType: 'human-review-materials',
    counts: { total: checks.length, passed: checks.filter((c) => c.pass).length, failed: checks.filter((c) => !c.pass).length },
    phases: ['single'],
    supersedes: null,
    started,
    ended: new Date().toISOString(),
    worktree: {
      clean: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() === '',
      note: '本脚本自己的 run 目录按白名单不计入',
    },
    sourceFingerprints: Object.fromEntries(
      (['scripts/lv2-review-materials.ts', 'scripts/lv2-evidence.ts'] as const).map((path) => [
        path,
        createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex'),
      ]),
    ),
    config: { mode: '只读（不调模型、不开库）', materials: 'aggregate-only（正文永不入材料）' },
    model: { providerKind: 'none', note: '零模型请求' },
    requests: { planned: 0, actual: 0, note: '零模型请求' },
    denominators: { runsSeen: runs.length, replySamplesChecked: replySamples.length, checks: checks.length },
    correlations: { cases: 0, conversations: 0, requests: 0, traces: 0 },
    faultInjection: null,
    cleanClose: true,
    realDb: { opened: false, summaryBefore: null, summaryAfter: null, note: '只读；不打开任何库' },
    verdict,
    limitation:
      '本门只证明"材料备好了、且不含正文"；LV2-G8 的判定要等真人逐条回答四个审题 —— ' +
      '在此之前 G8 保持 NOT RUN（历史人审不代替本轮材料）。',
  })

  console.log('[lv2:review] runId = ' + runId)
  console.log('[lv2:review] 材料 = ' + join(dir, 'review-materials.md').replace(ROOT + '\\', '').replace(/\\/g, '/'))
  console.log('[lv2:review] 记录模板（本地，不入库）= ' + join(localDir, 'blind-review-record.md').replace(ROOT + '\\', '').replace(/\\/g, '/'))
  for (const check of checks) console.log('   ' + (check.pass ? '✅' : '❌') + ' ' + check.id + ' —— ' + check.note)
  console.log('[lv2:review] verdict = ' + verdict + ' · manifest = ' + manifestPath.replace(ROOT + '\\', '').replace(/\\/g, '/'))
  process.exitCode = verdict === 'PASS' ? 0 : 1
}

main()
