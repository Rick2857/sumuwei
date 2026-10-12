/**
 * `m5.5.1:gates` —— M5.5.1 的**只读汇总门**（计划 §7.1 点名要有的入口）。
 *
 * 纪律（逐条来自计划书与 AGENTS.md §6）：
 *   ① **只读已落盘证据**：本门**不运行任何测试**，也**不改写任何 verdict**。
 *   ② **缺证据 = NOT RUN，不是 PASS**；计数为 0 = MEASUREMENT INVALID，也不是 PASS。
 *   ③ **版本 / 配置 / 归属必须匹配**：语料版本与验收版本必须一致（v2）；
 *      判定超时与 token 上限必须**被记录**；`maxTokensOverride` 非空必须**如实标注为覆盖**。
 *      任何一条不匹配 ⇒ 该门 FAIL（"读到的是别的配置的读数"是最坏的假绿）。
 *   ④ **归属可追**：每份证据记 runId / head（若有）/ 字节 / sha256 / mtime。
 *   ⑤ **三段式自证**（正控 / 负控 / 恢复）：把纯函数 `evaluate()` 指向**临时构造**的
 *      证据根，注入"缺文件"与"版本不符"两种假象，必须分别得到 NOT RUN 与 FAIL；
 *      放回真实根后必须回到同一个结论。只做正控的汇总门与"什么都不检查"无法区分。
 *
 * 退出码：0 = 全部必选门 PASS · 2 = 有 NOT RUN（未测完）· 1 = 有 FAIL。
 *
 * 证据根可用 `M551_GATES_ROOT` 覆盖（**只给自证用**；正常调用不要设）。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import {
  newestSemanticsEvidence as selectNewestSemanticsEvidence,
  type SemanticsEvidenceSelection,
} from './m5.5.1-gate-select.ts'

const ROOT = resolve('.')
const DEFAULT_EVIDENCE_ROOT = join(ROOT, 'artifacts', 'm5.5.1')
const EXPECTED_CORPUS_VERSION = 'v2'
const EXPECTED_ACCEPTANCE_VERSION = 'v2'

type Verdict = 'PASS' | 'FAIL' | 'NOT RUN' | 'MEASUREMENT INVALID' | 'DIAGNOSTIC ONLY'

interface Reading {
  id: string
  required: boolean
  file: string
  present: boolean
  /** 证据自报的通过/失败（缺字段时为 null，**不得**当成 0 通过） */
  passed: number | null
  failed: number | null
  /** 计数型自检：这份证据到底量了多少条 */
  measuredCount: number | null
  runId: string | null
  head: string | null
  corpusVersion: string | null
  acceptanceVersion: string | null
  judgeTimeoutMsEffective: number | null
  maxTokensOverride: number | null
  bytes: number | null
  sha256: string | null
  verdict: Verdict
  notes: string[]
}

const sha256File = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')

const readJson = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>

/**
 * 正式三轮与 smallSample 诊断分列；按自报时刻或 Git 提交时刻选最新正式档。
 * ⚠️ 刻意**不**优先取 PASS 的那一份 —— 归属必须如实，"挑一份好看的"是本门要防的事。
 *
 * ⚠️ 2026-10-04：实现搬到 [`./m5.5.1-gate-select.ts`](m5.5.1-gate-select.ts)。
 *    理由 = 这段逻辑原先**没有专属的三段式控制**（`R-35` 那个"小样本诊断档被当成最新观测"的
 *    口径问题是 2026-10-03 `4005f360` **顺手**修掉的，只有注释与一次读数背书）。
 *    抽成独立模块后，`m5.5.1:measurement:verify` 用 `%TEMP%` 夹具驱动**同一个函数**。
 *    ⚠️ 行为**逐条不变**：`smallSample` 跳过 · 自报时刻优先 · 缺失退 git 提交时刻 · 并列按 runId 降序。
 */
const newestSemanticsEvidence = (root: string): SemanticsEvidenceSelection | null =>
  selectNewestSemanticsEvidence(root, ROOT)

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** 逐份证据的判定（纯函数） */
const judgeReading = (
  base: Omit<Reading, 'verdict' | 'notes'>,
  opts: { requireVersions: boolean }
): { verdict: Verdict; notes: string[] } => {
  const notes: string[] = []
  if (!base.present) return { verdict: 'NOT RUN', notes: ['证据文件不存在 ⇒ NOT RUN（不是 PASS）'] }

  if (base.passed === null || base.failed === null) {
    // 允许"只有 sections 而顶层没有 passed/failed"的证据（例如观测文件），此时按 sections 判。
    if (base.measuredCount === null) {
      return { verdict: 'MEASUREMENT INVALID', notes: ['证据既没有 passed/failed 也没有可读的计数 ⇒ MEASUREMENT INVALID'] }
    }
    notes.push('顶层无 passed/failed（观测型证据），按 sections 判定')
  } else if (base.passed === 0 && base.failed === 0) {
    return { verdict: 'MEASUREMENT INVALID', notes: ['passed=failed=0 ⇒ 计数为零，不是 PASS'] }
  } else if ((base.failed ?? 0) > 0) {
    notes.push(`failed=${base.failed} ⇒ FAIL`)
    return { verdict: 'FAIL', notes }
  }

  if (base.measuredCount !== null && base.measuredCount === 0) {
    return { verdict: 'MEASUREMENT INVALID', notes: ['measuredCount=0 ⇒ MEASUREMENT INVALID'] }
  }

  if (opts.requireVersions) {
    if (base.corpusVersion !== null && base.corpusVersion !== EXPECTED_CORPUS_VERSION) {
      return {
        verdict: 'FAIL',
        notes: [`语料版本 = ${base.corpusVersion}，期望 ${EXPECTED_CORPUS_VERSION} ⇒ FAIL（读到的是别的语料的读数）`],
      }
    }
    if (base.acceptanceVersion !== null && base.acceptanceVersion !== EXPECTED_ACCEPTANCE_VERSION) {
      return {
        verdict: 'FAIL',
        notes: [
          `验收版本 = ${base.acceptanceVersion}，期望 ${EXPECTED_ACCEPTANCE_VERSION} ⇒ FAIL（版本不匹配不得 PASS）`,
        ],
      }
    }
    if (base.corpusVersion === null && base.acceptanceVersion === null) {
      return { verdict: 'FAIL', notes: ['该证据**没有**语料/验收版本字段 ⇒ 无法验证版本匹配，不得 PASS'] }
    }
    if (base.judgeTimeoutMsEffective === null) {
      return { verdict: 'FAIL', notes: ['该证据**没有**记录判定超时 ⇒ 无法验证配置，不得 PASS'] }
    }
    if (base.maxTokensOverride !== null) {
      notes.push(`⚠️ 本次用了 token 覆盖（maxTokensOverride=${base.maxTokensOverride}）—— 不得当成生产缺省`)
    }
  }

  notes.push('按此份证据自身读数 = 通过')
  return { verdict: 'PASS', notes }
}

const load = (
  id: string,
  file: string,
  required: boolean,
  opts: { requireVersions?: boolean; measuredCountOf?: (o: Record<string, unknown>) => number | null } = {}
): Reading => {
  const present = existsSync(file)
  const base: Omit<Reading, 'verdict' | 'notes'> = {
    id,
    required,
    file: relative(ROOT, file).split(/[\\/]/).join('/'),
    present,
    passed: null,
    failed: null,
    measuredCount: null,
    runId: null,
    head: null,
    corpusVersion: null,
    acceptanceVersion: null,
    judgeTimeoutMsEffective: null,
    maxTokensOverride: null,
    bytes: null,
    sha256: null,
  }
  if (!present) return { ...base, verdict: 'NOT RUN', notes: ['证据文件不存在 ⇒ NOT RUN（不是 PASS）'] }

  base.bytes = statSync(file).size
  base.sha256 = sha256File(file)
  const o = readJson(file)
  base.passed = num(o.passed)
  base.failed = num(o.failed)
  base.runId = str(o.runId)
  base.head = str(o.head)
  base.corpusVersion = str(o.corpusVersion)
  base.acceptanceVersion = str(o.acceptanceVersion)
  base.judgeTimeoutMsEffective = num(o.judgeTimeoutMsEffective)
  base.maxTokensOverride = num(o.maxTokensOverride)
  base.measuredCount = (opts.measuredCountOf?.(o) ?? null) as number | null
  if (base.measuredCount === null) {
    const checks = Array.isArray(o.checks) ? (o.checks as unknown[]) : null
    if (checks !== null) base.measuredCount = checks.length
  }
  base.measuredCount = base.measuredCount ?? (base.passed !== null ? base.passed + (base.failed ?? 0) : null)

  const judged = judgeReading(base, { requireVersions: opts.requireVersions === true })
  const notes = [...judged.notes]
  if (base.corpusVersion === null && base.acceptanceVersion === null) {
    notes.push('该证据不带语料/验收版本字段 ⇒ 版本核对只在本门对**语义门**生效（其余按自身读数判）')
  }
  if (base.bytes !== null) notes.push(`mtime=${new Date(statSync(file).mtimeMs).toISOString()}`)
  return { ...base, verdict: judged.verdict, notes }
}

const evaluate = (root: string): { readings: Reading[]; overall: Verdict; requiredNotAccepted: string[] } => {
  const readings: Reading[] = []
  readings.push(load('L1 部件级', join(root, 'component.json'), true))
  readings.push(load('L2 接线', join(root, 'wiring.json'), true))
  readings.push(load('量具自证', join(root, 'measurement.json'), true))
  readings.push(load('Live Smoke', join(root, 'smoke', 'smoke-live.json'), true))
  readings.push(load('E2E 端到端', join(root, 'e2e.json'), true))

  const newest = newestSemanticsEvidence(root)
  if (newest === null) {
    readings.push({
      id: '语义门（最新观测）',
      required: true,
      file: 'wp7/<runId>/observations.json',
      present: false,
      passed: null,
      failed: null,
      measuredCount: null,
      runId: null,
      head: null,
      corpusVersion: null,
      acceptanceVersion: null,
      judgeTimeoutMsEffective: null,
      maxTokensOverride: null,
      bytes: null,
      sha256: null,
      verdict: 'NOT RUN',
      notes: ['wp7/ 下没有任何 observations.json ⇒ NOT RUN（不是 PASS）'],
    })
  } else {
    const o = readJson(newest.file)
    // 观测型证据：顶层有 sections.semantics.ok，用它当读数；同时要求版本/配置可验证。
    const sections = (o.sections ?? {}) as Record<string, { ok?: unknown }>
    const subs = ['transport', 'formatContract', 'semantics', 'strategy'] as const
    const present = subs.filter((k) => sections[k] !== undefined)
    const bad = subs.filter((k) => sections[k]?.ok === false)
    const reading: Reading = {
      id: `语义门（最新观测 · ${newest.runId}）`,
      required: true,
      file: relative(ROOT, newest.file).split(/[\\/]/).join('/'),
      present: true,
      passed: present.length - bad.length,
      failed: bad.length,
      measuredCount: num((o.stats as Record<string, unknown> | undefined)?.attempts) ?? null,
      runId: str(o.runId),
      head: null,
      corpusVersion: str(o.corpusVersion),
      acceptanceVersion: str(o.acceptanceVersion),
      judgeTimeoutMsEffective: num(o.judgeTimeoutMsEffective),
      maxTokensOverride: num(o.maxTokensOverride),
      bytes: statSync(newest.file).size,
      sha256: sha256File(newest.file),
      verdict: 'PASS',
      notes: [],
    }
    const judged = judgeReading(reading, { requireVersions: true })
    const formalShape = o.smallSample === false && (o.stats as Record<string, unknown> | undefined)?.runs === 3 &&
      (o.stats as Record<string, unknown> | undefined)?.attempts === 348
    reading.verdict = formalShape ? judged.verdict : 'MEASUREMENT INVALID'
    reading.notes = [...judged.notes, `四个分项：${present.join('/')}${bad.length > 0 ? ` · 未过：${bad.join('/')}` : ''}`]
    if (!formalShape) reading.notes.push('正式档必须为完整三轮、348 次尝试；失败请求保留原分母')
    readings.push(reading)
  }
  const diagnosticRoot = join(root, 'wp7')
  if (existsSync(diagnosticRoot)) for (const entry of readdirSync(diagnosticRoot, { withFileTypes: true })) {
    const file = join(diagnosticRoot, entry.name, 'observations.json')
    if (!entry.isDirectory() || !existsSync(file)) continue
    const observed = readJson(file)
    if (observed.smallSample === true) readings.push({ ...load(`诊断专用（${entry.name}）`, file, false), verdict: 'DIAGNOSTIC ONLY',
      measuredCount: num((observed.stats as Record<string, unknown> | undefined)?.attempts),
      notes: [`smallSample=true；单轮样本不作为正式三轮验收；semantics.ok=${String((observed.sections as Record<string, any> | undefined)?.semantics?.ok)}`] })
  }

  const requiredNotAccepted = readings.filter((r) => r.required && r.verdict !== 'PASS').map((r) => r.id)
  const overall: Verdict = readings.some((r) => r.required && r.verdict === 'FAIL')
    ? 'FAIL'
    : readings.some((r) => r.required && (r.verdict === 'NOT RUN' || r.verdict === 'MEASUREMENT INVALID'))
      ? 'NOT RUN'
      : 'PASS'
  return { readings, overall, requiredNotAccepted }
}

const print = (title: string, result: ReturnType<typeof evaluate>): void => {
  console.log(`\n=== ${title} ===`)
  for (const r of result.readings) {
    const badge = r.verdict === 'PASS' ? '✅' : r.verdict === 'FAIL' ? '❌' : r.verdict === 'NOT RUN' ? '⏭️ ' : '⚠️ '
    console.log(
      `  ${badge} ${r.id.padEnd(34)} ${String(r.verdict).padEnd(19)} passed=${r.passed ?? '-'} failed=${r.failed ?? '-'} measured=${r.measuredCount ?? '-'}`
    )
    console.log(`      证据：${r.file}`)
    console.log(
      `      归属：runId=${r.runId ?? '-'} · 语料=${r.corpusVersion ?? '-'} · 验收=${r.acceptanceVersion ?? '-'} · 超时=${r.judgeTimeoutMsEffective ?? '-'} · token覆盖=${r.maxTokensOverride ?? '无'}`
    )
    console.log(`      sha256=${r.sha256 ?? '-'} · bytes=${r.bytes ?? '-'}`)
    for (const n of r.notes) console.log(`      · ${n}`)
  }
  console.log(`  ⇒ overall = **${result.overall}**` + (result.requiredNotAccepted.length > 0 ? ` · 未接受：${result.requiredNotAccepted.join(' · ')}` : ''))
}

// ---------------------------------------------------------------------------
// 三段式自证：正控（真实根）/ 负控（缺文件 · 版本不符）/ 恢复（真实根）
// ---------------------------------------------------------------------------

const selfTest = (): { ok: boolean; lines: string[] } => {
  const lines: string[] = []
  const temp = mkdtempSync(join(tmpdir(), 'm551-gates-selftest-'))
  try {
    // 正控：真实根必须给出**至少一份非 NOT RUN** 的读数
    const real = evaluate(DEFAULT_EVIDENCE_ROOT)
    const measured = real.readings.filter((r) => r.present && r.measuredCount !== null && r.measuredCount > 0).length
    const posOk = measured > 0
    lines.push(`正控：真实证据根读到 ${measured} 份非零计数的证据（必须 > 0）⇒ ${posOk ? 'OK' : 'FAIL'}`)

    // 负控 ①：少一份必选证据 ⇒ 该门必须 NOT RUN，且 overall 不得是 PASS
    const missing = join(temp, 'missing')
    cpSync(DEFAULT_EVIDENCE_ROOT, missing, { recursive: true })
    rmSync(join(missing, 'wiring.json'), { force: true })
    const missingResult = evaluate(missing)
    const wiring = missingResult.readings.find((r) => r.id === 'L2 接线')
    const neg1Ok = wiring?.verdict === 'NOT RUN' && missingResult.overall !== 'PASS'
    lines.push(
      `负控①（缺 wiring.json）：L2 接线 = ${wiring?.verdict ?? '-'} · overall = ${missingResult.overall}（要求 NOT RUN 且非 PASS）⇒ ${neg1Ok ? 'OK' : 'FAIL'}`
    )

    // 负控 ②：把语料版本改成 v1 ⇒ 语义门必须 FAIL（不许拿别的版本的读数当 PASS）
    const tampered = join(temp, 'tampered')
    cpSync(DEFAULT_EVIDENCE_ROOT, tampered, { recursive: true })
    const newest = newestSemanticsEvidence(tampered)
    if (newest !== null) {
      const o = readJson(newest.file)
      o.corpusVersion = 'v1'
      writeFileSync(newest.file, `${JSON.stringify(o, null, 2)}\n`, 'utf8')
    }
    const tamperedResult = evaluate(tampered)
    const sem = tamperedResult.readings.find((r) => r.id.startsWith('语义门'))
    const neg2Ok = sem?.verdict === 'FAIL'
    lines.push(
      `负控②（把语料版本改成 v1）：语义门 = ${sem?.verdict ?? '-'}（要求 FAIL）⇒ ${neg2Ok ? 'OK' : 'FAIL'}`
    )

    const scoped = join(temp, 'scope')
    cpSync(DEFAULT_EVIDENCE_ROOT, scoped, { recursive: true })
    const formal = newestSemanticsEvidence(scoped)
    if (formal === null) throw new Error('正式证据缺失，无法运行选择负控')
    const original = readJson(formal.file)
    const altered = { ...original, ended: '2099-01-01T00:00:00.000Z',
      sections: { ...(original.sections as Record<string, unknown>), semantics: { ok: false } } }
    writeFileSync(formal.file, `${JSON.stringify(altered)}\n`, 'utf8')
    const latestFailureBlocks = evaluate(scoped).overall === 'FAIL'
    writeFileSync(formal.file, `${JSON.stringify(original)}\n`, 'utf8')
    const scopeRestores = evaluate(scoped).overall === real.overall
    lines.push(`选择负控：最新正式 FAIL 必须阻断；恢复原档恢复原结论 ⇒ ${latestFailureBlocks && scopeRestores ? 'OK' : 'FAIL'}`)

    // 恢复：再跑真实根，结论必须与正控一致
    const restored = evaluate(DEFAULT_EVIDENCE_ROOT)
    const recOk = restored.overall === real.overall
    lines.push(`恢复：真实根重新评估 overall = ${restored.overall}（正控时是 ${real.overall}）⇒ ${recOk ? 'OK' : 'FAIL'}`)

    const ok = posOk && neg1Ok && neg2Ok && recOk && latestFailureBlocks && scopeRestores
    return { ok, lines }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

const main = (): void => {
  const root = process.env.M551_GATES_ROOT !== undefined ? resolve(process.env.M551_GATES_ROOT) : DEFAULT_EVIDENCE_ROOT
  if (!existsSync(root)) {
    console.error(`[m551:gates] 证据根不存在：${root} ⇒ NOT RUN`)
    process.exit(2)
  }

  const result = evaluate(root)
  print(`M5.5.1 门汇总（只读已落盘证据 · 根 = ${relative(ROOT, root) || '.'}）`, result)

  const st = selfTest()
  console.log('\n=== 量具自证（正控 / 负控 / 恢复）===')
  for (const line of st.lines) console.log(`  ${line}`)
  console.log(`  ⇒ 自证 = ${st.ok ? 'PASS' : 'FAIL'}`)

  /*
   * 落盘一份汇总读数（与 `m5.5:gates` 的 `artifacts/m5.5/gate-results.json` 同一约定）。
   * ⚠️ 本文件含时钟字段 `generatedAt` ⇒ 每次运行都会变，**不进"冻结身份"清单**；
   *    它只记录"这一次只读汇总看到了什么"，**不改写**任何被汇总门自己的 verdict。
   */
  const outPath = join(root, 'gate-results.json')
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        schemaVersion: 'm5.5.1-gate-results@1',
        generatedAt: new Date().toISOString(),
        note: '只读汇总：本文件不运行测试、不改写被判据门的 verdict；含时钟字段，每次运行都会变。',
        evidenceRoot: relative(ROOT, root).split(/[\\/]/).join('/'),
        expected: { corpusVersion: EXPECTED_CORPUS_VERSION, acceptanceVersion: EXPECTED_ACCEPTANCE_VERSION },
        overall: result.overall,
        requiredNotAccepted: result.requiredNotAccepted,
        readings: result.readings,
        selfTest: { ok: st.ok, lines: st.lines },
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  console.log(`证据：${relative(ROOT, outPath).split(/[\\/]/).join('/')}`)

  console.log(
    `\nM5.5.1 门汇总：${result.readings.filter((r) => r.required && r.verdict === 'PASS').length}/${result.readings.filter(r => r.required).length} 必选门被接受 · 诊断 ${result.readings.filter(r => r.verdict === 'DIAGNOSTIC ONLY').length} 份分列 · overall = ${result.overall}` +
      (result.requiredNotAccepted.length > 0 ? `\n未接受：${result.requiredNotAccepted.join(' · ')}` : '')
  )
  console.log('⚠️ 本命令**没有**运行任何测试，也**没有**改写任何 verdict；它只读已落盘证据。')

  if (!st.ok) process.exit(1)
  process.exit(result.overall === 'PASS' ? 0 : result.overall === 'FAIL' ? 1 : 2)
}

main()
