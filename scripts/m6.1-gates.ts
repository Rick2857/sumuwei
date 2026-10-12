/**
 * M6.1 —— **门结果汇总**（`pnpm m6.1:gates --manifest <path>`）。
 *
 * ============================================================================
 *  它只做一件事：把**显式清单引用**的证据读出来，摊平给人看
 * ============================================================================
 * ```text
 *   不跑测试        没有 spawn、没有 tsx、没有数据库、没有模型
 *   不改 verdict    只**读**证据里的 verdict 字段，一个字节都不写回
 *   缺文件 = NOT RUN 文件不存在**不是** PASS（AGENTS §6.4）
 * ```
 *
 * ============================================================================
 *  与 M6 的 `m6:gates` 有一处**判据差异**（TD-04② 的直接后果）
 * ============================================================================
 * ```text
 *   m6:gates    扫 artifacts/m6/**，按 schemaVersion 找**最新**那份证据
 *   m6.1:gates  **只**读 --manifest 列出的证据；清单本身还要先过字段/自摘要/逐条 sha256
 * ```
 * "按最新挑证据"在同一个 HEAD 上重跑过几次之后，会让**旧绿冒充本次结论** ——
 * 那正是 M6 已登记的技术债。因此本门：
 *
 * ```text
 *   没有 --manifest            ⇒ 拒绝（不是"那就全扫一遍"）
 *   --all-runs / --latest      ⇒ **具名**拒绝
 *   清单缺字段 / 自摘要不符     ⇒ 该运行判 UNUSABLE，不参与汇总
 *   任何一条证据 sha256 不符     ⇒ 该运行判 UNUSABLE
 * ```
 *
 * 用法：
 *   pnpm m6.1:gates --manifest artifacts/m6.1/<wp0RunId>/manifest.json \
 *                   --manifest artifacts/m6.1/<wp1RunId>/manifest.json
 *   pnpm m6.1:gates --manifest … --write      # 额外写 <第一份清单所在目录>/gate-results.json
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { resolveManifestSelection } from './m6.1-command-surface.ts'
import {
  M6_1_CONTRACT_VERSION,
  M6_1_CORPUS_VERSION,
  M6_1_INSTRUMENT_VERSION,
} from './m6.1-contract.ts'
import {
  M6_1_GATE_SPECS,
  readLandedGateEvidence,
  readManifest,
  sha256OfText,
  verifyEvidenceEntries,
  type LandedGateEvidence,
} from './m6.1-evidence.ts'

const ROOT = resolve(process.cwd())

interface RunReading {
  manifestPath: string
  runId: string
  completion: string
  usable: boolean
  problems: string[]
  verdict: string
  evidenceEntries: { path: string; sha256: string }[]
}

function readRun(manifestPath: string): RunReading {
  const abs = resolve(ROOT, manifestPath)
  const problems: string[] = []
  if (!existsSync(abs)) {
    return {
      manifestPath,
      runId: '',
      completion: 'ABSENT',
      usable: false,
      problems: [`清单不存在：${manifestPath}`],
      verdict: '',
      evidenceEntries: [],
    }
  }
  const runDir = dirname(abs)
  const reading = readManifest(runDir)
  for (const problem of reading.problems) {
    problems.push(`${problem.code}: ${problem.detail}`)
  }
  if (reading.completion !== 'COMPLETE') {
    problems.push(
      reading.completion === 'ABSENT'
        ? '没有 manifest.json（中断的运行）⇒ 不参与汇总'
        : 'manifest.json 在位但 counts.executed <= 0 ⇒ 不参与汇总'
    )
  }

  const manifest = reading.manifest ?? {}
  const rawEvidence: readonly unknown[] = Array.isArray(manifest.evidence)
    ? (manifest.evidence as unknown[])
    : []
  const evidenceEntries = rawEvidence
    .filter(
      (entry): entry is { path: string; sha256: string } =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { path?: unknown }).path === 'string' &&
        typeof (entry as { sha256?: unknown }).sha256 === 'string'
    )
    .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))

  for (const problem of verifyEvidenceEntries(ROOT, rawEvidence)) {
    problems.push(`${problem.code}: ${problem.detail}`)
  }

  return {
    manifestPath,
    runId: String(manifest.runId ?? ''),
    completion: reading.completion,
    usable: problems.length === 0,
    problems,
    verdict: String(manifest.verdict ?? ''),
    evidenceEntries,
  }
}

function main(): void {
  const argv = process.argv.slice(2)
  const write = argv.includes('--write')
  const selection = resolveManifestSelection(argv)
  if (!selection.ok) {
    console.error(`[m6.1:gates] ${selection.code}：${selection.message}`)
    process.exit(2)
  }

  const runs = selection.manifests.map((manifestPath) => readRun(manifestPath))

  // 只从 **usable 的运行**引用的文件里**读**证据（不扫目录）
  const bySchema = new Map<string, LandedGateEvidence>()
  for (const run of runs) {
    if (!run.usable) continue
    for (const entry of run.evidenceEntries) {
      const abs = join(ROOT, entry.path)
      if (!existsSync(abs) || !entry.path.endsWith('.json')) continue
      const landed = readLandedGateEvidence(abs, readFileSync(abs, 'utf8'))
      if (landed === undefined || landed.schemaVersion === '') continue
      bySchema.set(landed.schemaVersion, landed)
    }
  }

  interface GateRow {
    id: string
    label: string
    command: string
    required: boolean
    acceptVerdicts: readonly string[]
    accepted: boolean
    verdict: string
    evidencePath: string | null
    passed: number
    failed: number
  }

  const rows: GateRow[] = M6_1_GATE_SPECS.map((spec) => {
    const landed = bySchema.get(spec.schemaVersion)
    const verdict = landed === undefined || landed.verdict === '' ? 'NOT RUN' : landed.verdict
    return {
      id: spec.id,
      label: spec.label,
      command: spec.command,
      required: spec.required,
      acceptVerdicts: spec.acceptVerdicts,
      accepted: spec.acceptVerdicts.includes(verdict),
      verdict,
      evidencePath: landed === undefined ? null : relative(ROOT, landed.path).split(/[\\/]/).join('/'),
      passed: landed?.passed ?? 0,
      failed: landed?.failed ?? 0,
    }
  })

  const requiredRows = rows.filter((row) => row.required)
  const notRun = requiredRows.filter((row) => row.verdict === 'NOT RUN')
  const notAccepted = requiredRows.filter((row) => !row.accepted)
  const unusableRuns = runs.filter((run) => !run.usable)

  const overall =
    unusableRuns.length > 0
      ? 'REFUSED (有清单不可用)'
      : notRun.length === requiredRows.length
        ? 'NOT RUN'
        : notAccepted.length === 0
          ? 'PASS'
          : 'NOT PASS'

  console.log('='.repeat(78))
  console.log('M6.1 门结果汇总（只读；缺文件 = NOT RUN，绝不是 PASS）')
  console.log('='.repeat(78))
  console.log('\n【引用的运行】')
  for (const run of runs) {
    console.log(`  ${run.manifestPath}`)
    console.log(`    runId=${run.runId || '(缺)'} completion=${run.completion} verdict=${run.verdict || '(缺)'} usable=${String(run.usable)}`)
    for (const problem of run.problems) {
      console.log(`    ⚠ ${problem}`)
    }
  }

  console.log('\n【逐门】')
  for (const row of rows) {
    const mark = row.accepted ? '✅' : row.verdict === 'NOT RUN' ? '⏸' : '❌'
    console.log(`${mark} ${row.id}  [${row.verdict}]${row.required ? '' : '（非必选）'}`)
    console.log(`     ${row.label}`)
    console.log(`     命令   ${row.command}`)
    console.log(`     接受判决 ${row.acceptVerdicts.join(' | ')}   证据 ${row.evidencePath ?? '(未引用)'}`)
    console.log(`     通过/失败 ${String(row.passed)}/${String(row.failed)}`)
  }

  console.log('\n【判定】')
  console.log(`  必选门 ${String(requiredRows.length)} · 未运行 ${String(notRun.length)} · 未通过 ${String(notAccepted.length)}`)
  console.log(`  overall = ${overall}`)
  if (overall === 'NOT PASS' || overall === 'NOT RUN' || overall.startsWith('REFUSED')) {
    console.log(
      '  ⇒ 这不是故障：`wp1-corpus` 的接受判决只有 FROZEN，未获真人批准时它必然不是 PASS。'
    )
  }

  if (write) {
    const first = selection.manifests[0]
    if (first === undefined) {
      console.error('[m6.1:gates] --write 需要至少一份清单')
      process.exit(2)
    }
    const outPath = join(dirname(resolve(ROOT, first)), 'gate-results.json')
    const payload = {
      schemaVersion: 'm6.1-gate-results@1',
      scope: 'M6.1 门结果汇总（只读显式清单引用的证据；不扫目录）',
      overall,
      manifests: runs,
      gates: rows,
      counters: {
        requiredGates: requiredRows.length,
        notRun: notRun.length,
        notAccepted: notAccepted.length,
        unusableRuns: unusableRuns.length,
      },
      versions: {
        contract: M6_1_CONTRACT_VERSION,
        corpus: M6_1_CORPUS_VERSION,
        instrument: M6_1_INSTRUMENT_VERSION,
      },
      notes: [
        '本汇总**只**读 --manifest 列出的文件；"按最新 PASS 挑证据"被具名拒绝（TD-04②）。',
        '缺文件 = NOT RUN；它不参与 overall 的分子，也不被算成通过。',
      ],
    }
    const text = `${JSON.stringify(payload, null, 2)}\n`
    writeFileSync(outPath, text, 'utf8')
    console.log(`\n  已写出 ${relative(ROOT, outPath).split(/[\\/]/).join('/')}  (${sha256OfText(text).slice(0, 12)}…)`)
  }

  process.exit(overall === 'PASS' ? 0 : 2)
}

try {
  main()
} catch (error) {
  console.error(`[m6.1:gates] 失败关闭：${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}
