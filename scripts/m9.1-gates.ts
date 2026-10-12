/**
 * M9.1 门聚合（`pnpm m9.1:gates`）——只读已落盘证据，缺证据失败关闭。
 * 不重新执行任何门（AGENTS.md §6.4：文件不存在 = NOT RUN，不是 PASS）。
 */
import 'dotenv/config'

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const EVIDENCE_PARENT = join(ROOT, 'artifacts', 'm9.1')

/** 门清单：证据文件名 + 通过判据字段（缺文件 = NOT RUN ⇒ 失败关闭） */
const GATE_SPECS: { gate: string; file: string; kind: string }[] = [
  { gate: 'm9.1:test', file: 'test.json', kind: 'test' },
  { gate: 'm9.1:verify', file: 'verify.json', kind: 'verify' },
  { gate: 'm9.1:measurement:verify', file: 'measurement.json', kind: 'measurement' },
  { gate: 'm9.1:e2e:verify', file: 'e2e.json', kind: 'e2e' },
  { gate: 'm9.1:e2e:joint', file: 'joint.json', kind: 'joint' },
]

interface GateReading {
  gate: string
  status: 'PASS' | 'FAIL' | 'NOT_RUN'
  head?: string
  passed?: number
  failed?: number
  detail: string
}

/**
 * 「哪一份是最新」的判据 —— 三个坑，全部实测踩过：
 *  ① 目录名 = `<kind>-<YYYYMMDD>-<head8>`：同一天内 `head8` 是哈希 ⇒ **字典序与时间序无关**
 *     （`joint-20260927-bd0ac83`(20/0, 旧) 字典序大于 `joint-20260927-167ee58`(21/0, 新)）。
 *  ② **mtime 会被 checkout 破坏**：`git checkout`/`git merge` 重写工作树 ⇒ 全部 mtime 刷新，
 *     排序退化成字典序（坑 ① 复现）。实测：ff 合并进 `main` 后聚合器一度把 `joint` 取成 20/0、
 *     把冒烟轮 1 取成 @4 的 FAIL。
 *  ③ **同一个提交里入库多份同种 run** ⇒ 提交时间相同，兜底又回字典序。实测：
 *     `425c75a` 一次提交了 `joint-a7d89e8`(20/1, F-5 复现) 与 `joint-167ee58`(21/0, WP8 后) 两份。
 *
 * ⇒ 主键 = **证据自带的 `head` 在提交图中的位置**（`git rev-list --count <head>`）：
 *   内容自描述（「这份读数是哪棵树产生的」）、与 mtime 无关、与入库时刻无关、单调（本仓库历史是线性的）。
 *   次序 = ① head 的提交计数 → ② 该证据文件最后入库的提交时间 → ③ 目录名。
 *   任一取不到（如 head 不是提交）⇒ -1，交给下一级兜底。
 */
function commitTimes(): Map<string, number> {
  const map = new Map<string, number>()
  try {
    const out = execSync('git log --pretty=format:@@%ct --name-only -- artifacts/m9.1', {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    let t = 0
    for (const raw of out.split('\n')) {
      const line = raw.trim()
      if (line.startsWith('@@')) {
        t = Number(line.slice(2))
        continue
      }
      if (line === '') continue
      /* git log 从新到旧 ⇒ 首次出现即该文件最新的那次提交 */
      if (!map.has(line)) map.set(line, t)
    }
  } catch {
    /* 无 git（或超时）⇒ 走 mtime / 名字兜底 */
  }
  return map
}

const headCountCache = new Map<string, number>()
/** `git rev-list --count <head>`：该提交在历史中的位置（越大越新）；取不到 ⇒ -1 */
function headOrder(head: string | undefined): number {
  if (head === undefined || head === '') return -1
  const cached = headCountCache.get(head)
  if (cached !== undefined) return cached
  let n = -1
  try {
    n = Number(execSync(`git rev-list --count ${head}`, { cwd: ROOT, encoding: 'utf8' }).trim())
  } catch {
    n = -1
  }
  headCountCache.set(head, n)
  return n
}

/** 从证据 JSON 里读它自报的 head（自描述来源；取不到 ⇒ 用目录名兜底） */
function selfHead(absPath: string, dir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(absPath, 'utf8')) as { head?: unknown; runId?: unknown }
    if (typeof parsed.head === 'string' && parsed.head !== '') return parsed.head
    const runId = typeof parsed.runId === 'string' ? parsed.runId : ''
    const m = /-([0-9a-f]{7,40})$/.exec(runId)
    if (m !== null) return m[1]
  } catch {
    /* 内容不可读 ⇒ 交给下一级 */
  }
  const fromName = /-([0-9a-f]{7,40})$/.exec(dir)
  return fromName?.[1]
}

interface Candidate {
  d: string
  ord: number
  ct: number
}

/** 候选按「最新」升序排序，取最后一个 */
function sortCandidates(cands: Candidate[]): Candidate[] {
  return [...cands].sort((a, b) => a.ord - b.ord || a.ct - b.ct || a.d.localeCompare(b.d))
}

function latestEvidence(file: string): { dir: string; data: Record<string, unknown> } | undefined {
  if (!existsSync(EVIDENCE_PARENT)) return undefined
  const times = commitTimes()
  const cands: Candidate[] = readdirSync(EVIDENCE_PARENT)
    .filter((d) => d.endsWith(file) === false && existsSync(join(EVIDENCE_PARENT, d, file)))
    .map((d) => ({
      d,
      ord: headOrder(selfHead(join(EVIDENCE_PARENT, d, file), d)),
      ct: times.get(`artifacts/m9.1/${d}/${file}`) ?? -1,
    }))
  const latest = sortCandidates(cands).at(-1)?.d
  if (latest === undefined) return undefined
  try {
    const raw = readFileSync(join(EVIDENCE_PARENT, latest, file), 'utf8')
    return { dir: latest, data: JSON.parse(raw) as Record<string, unknown> }
  } catch {
    return undefined
  }
}

function main(): void {
  console.log('\n=== M9.1 门聚合（只读已落盘证据）===')
  const head = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()
  const readings: GateReading[] = []

  for (const spec of GATE_SPECS) {
    const found = latestEvidence(spec.file)
    if (found === undefined) {
      readings.push({ gate: spec.gate, status: 'NOT_RUN', detail: `缺证据文件 ${spec.file}（失败关闭——不是 PASS）` })
      continue
    }
    const dbUntouched = found.data.dbUntouched === true || found.data.dbUntouched === undefined
    let passed: number
    let failed: number
    let status: GateReading['status']
    let detail: string
    if (spec.kind === 'measurement') {
      /* 量具有效性门：判据是 verdict + 逐 probe ok（该门**没有** passed/failed 计数器——
         首版按计数器读 ⇒ passed=0 ⇒ 把 VALID 误判 FAIL，实测踩中） */
      const probes = Array.isArray(found.data.probes) ? (found.data.probes as { ok?: boolean }[]) : []
      passed = probes.filter((p) => p.ok === true).length
      failed = probes.length - passed
      const verdictOk = found.data.verdict === 'MEASUREMENT VALID'
      /* 计数自检：0 个 probe 与「全部通过」在输出上不可区分（AGENTS §6.8） */
      status = verdictOk && probes.length > 0 && failed === 0 && dbUntouched ? 'PASS' : 'FAIL'
      detail = `${found.dir}（verdict=${String(found.data.verdict)} probes=${String(passed)}/${String(probes.length)} dbUntouched=${String(dbUntouched)}）`
    } else {
      passed = Number(found.data.passed ?? found.data.pass ?? 0)
      failed = Number(found.data.failed ?? found.data.fail ?? 0)
      status = failed === 0 && passed > 0 && dbUntouched ? 'PASS' : 'FAIL'
      detail = `${found.dir}（passed=${String(passed)} failed=${String(failed)} dbUntouched=${String(dbUntouched)}）`
    }
    readings.push({
      gate: spec.gate,
      status,
      head: String(found.data.head ?? found.dir),
      passed,
      failed,
      detail,
    })
  }

  /* smoke 两轮：独立证据文件（round 1 / round 2）；排序与上面同一判据（head 的提交计数为主） */
  const smokeTimes = commitTimes()
  for (const round of [1, 2]) {
    const cands: Candidate[] = existsSync(EVIDENCE_PARENT)
      ? readdirSync(EVIDENCE_PARENT)
          .filter((d) => d.includes(`smoke-r${String(round)}`) && existsSync(join(EVIDENCE_PARENT, d, 'smoke-summary.json')))
          .map((d) => ({
            d,
            ord: headOrder(selfHead(join(EVIDENCE_PARENT, d, 'smoke-summary.json'), d)),
            ct: smokeTimes.get(`artifacts/m9.1/${d}/smoke-summary.json`) ?? -1,
          }))
      : []
    const latest = sortCandidates(cands).at(-1)?.d
    if (latest === undefined) {
      readings.push({ gate: `m9.1:smoke:live(round ${String(round)})`, status: 'NOT_RUN', detail: '缺证据（失败关闭）' })
      continue
    }
    const data = JSON.parse(
      readFileSync(join(EVIDENCE_PARENT, latest, 'smoke-summary.json'), 'utf8'),
    ) as Record<string, unknown>
    const failed = Number(data.failed ?? 0)
    const passed = Number(data.passed ?? 0)
    const controlsOk = data.controlsOk === true
    const dbUntouched = data.dbUntouched === true
    readings.push({
      gate: `m9.1:smoke:live(round ${String(round)})`,
      status: failed === 0 && passed > 0 && controlsOk && dbUntouched ? 'PASS' : 'FAIL',
      head: String(data.head ?? latest),
      passed,
      failed,
      detail: `${latest}（controlsOk=${String(controlsOk)} dbUntouched=${String(dbUntouched)}）`,
    })
  }

  for (const r of readings) {
    const mark = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⏭'
    console.log(`  ${mark} ${r.gate} = ${r.status} :: ${r.detail}`)
  }
  const passCount = readings.filter((r) => r.status === 'PASS').length
  const notRun = readings.filter((r) => r.status === 'NOT_RUN').length
  const failed = readings.filter((r) => r.status === 'FAIL').length
  console.log(`\n=== 汇总：必选门 ${String(readings.length)} · 通过 ${String(passCount)} · 未通过 ${String(failed)} · 未运行 ${String(notRun)} ===`)

  /* 计划 §8.1：聚合器的必选门清单必须列明「哪些在机判内、哪些独立呈交」——
     不得用一个绿色掩盖未运行部分。以下三项**不在**本聚合器的机判范围内。 */
  const independentSubmissions = [
    'M9 原短门 m9:live:level1 ×3（flags ON 验收批 + flags OFF 负控批）——证据在 artifacts/m9/**，按 R-20 条件单独销账',
    'M9 原长门 m9:live:long（原冻结轨迹）——证据在 artifacts/m9/**，按 R-21 条件单独销账',
    '人工复核（5 题 + F-5 说明）——判定权在人：2026-09-28 用户声明式裁定 PASS（Q1–Q5 全确认）；载体 docs/m9.1/M9.1-Gate-Decision.md §6 / M9.1-Human-Review-Materials.md §4',
    '发布链 m4.5:ci / with-test-model m4.5:ci:full——按 EXIT 码单独呈交',
    'M9.1 生产激活读回 m9.1:activation:readback（配置层，正控+负控，EXIT 0；不打开数据库）——激活后记录，载体 docs/adr/ADR-073-m9.1-production-activation-merge-tag.md（M9 先例：激活读回不进必选门）',
  ]
  console.log('\n=== 独立呈交（不在本聚合器机判内；不得视为已通过）===')
  for (const item of independentSubmissions) console.log(`  · ${item}`)

  mkdirSync(EVIDENCE_PARENT, { recursive: true })
  writeFileSync(
    join(EVIDENCE_PARENT, 'gate-results.json'),
    JSON.stringify({ aggregator: 'm9.1:gates', head, readings, independentSubmissions, passCount, failed, notRun, overall: failed === 0 && notRun === 0 ? 'PASS' : 'NOT PASS' }, null, 2),
    'utf8',
  )
  console.log(`证据：${join(EVIDENCE_PARENT, 'gate-results.json')}`)
  process.exit(failed === 0 && notRun === 0 ? 0 : 1)
}

main()
