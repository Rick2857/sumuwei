/**
 * M4.5 —— **门结果汇总**（计划书 §54：`artifacts/m4.5/` 保存 gate results）。
 *
 * ============================================================================
 *  它是"量具的量具"：只读已落盘的证据，不自己跑门
 * ============================================================================
 * 它**不重新跑测试**，也不猜测结果 —— 它把每个门自己写下的证据文件读出来，
 * 汇总成 `artifacts/m4.5/gate-results.json`。
 *
 * 因此有一条刻意的性质：
 *
 *     证据文件不存在 → 那个门是 `not-run`，**不是** PASS
 *
 * 手写一份"全绿"的汇报是这个项目最不该出现的东西（M4.1 的教训：
 * 数字看起来合理，而量的是错的东西）。
 *
 * 跑法：pnpm m4.5:gates（通常由 m4.5:ci 顺带调用）
 */

import 'dotenv/config'

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { selectM45G14Reading } from './m4.5-gate-select.ts'

const ROOT = process.cwd()
const evidenceDir = join(ROOT, 'artifacts', 'm4.5')

interface GateResult {
  gate: string
  name: string
  command: string
  evidence: string
  status: 'PASS' | 'FAIL' | 'not-run'
  passed?: number
  failed?: number
  failures?: readonly string[]
  hardGate?: boolean
  note?: string
  /** ⏩ `R-50`：G14 的**当期读数来源**（落盘，供人复核"它读的是哪一份"） */
  selectedEvidence?: string
  selectionBasis?: string
  selectionDegraded?: boolean
  tiedWith?: readonly string[]
  /** ⏩ `R-50`：**历史档分列**（当期 PASS ≠ 抹掉历史 FAIL；TD-16 不回写） */
  historical?: readonly {
    path: string
    status: string
    passed?: number
    failed?: number
    lastCommit: string
    note: string
  }[]
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function fromEvidence(options: {
  gate: string
  name: string
  command: string
  file: string
  hardGate?: boolean
  note?: string
}): GateResult {
  const path = join(evidenceDir, options.file)
  const json = readJson(path)
  const checks = (json?.checks ?? {}) as { passed?: number; failed?: number; failures?: string[] }
  const status = json === undefined ? 'not-run' : json.status === 'PASS' ? 'PASS' : 'FAIL'
  return {
    gate: options.gate,
    name: options.name,
    command: options.command,
    evidence: `artifacts/m4.5/${options.file}`,
    status,
    ...(checks.passed !== undefined ? { passed: checks.passed } : {}),
    ...(checks.failed !== undefined ? { failed: checks.failed } : {}),
    ...(checks.failures !== undefined ? { failures: checks.failures } : {}),
    ...(options.hardGate === true ? { hardGate: true } : {}),
    ...(options.note !== undefined ? { note: options.note } : {}),
  }
}

/**
 * ⏩ **G14 的选档（2026-10-04，登记册 §0p `R-50`；继承 `R-36` 的读数）**。
 *
 * 判据本体**一个字没改**（仍是 `status === 'PASS' && failed === 0`）；改的只是**读哪一份**：
 * 从"固定路径 `artifacts/m4.5/smoke/smoke-result.json`"改成"按**身份**选当期读数"
 * （清单 `endedAt` → 清单 `head|headStarted` 的提交时刻 → 证据提交时刻 → 具名降级；
 * **mtime 永不参与**，**刻意不看 verdict**）。见 `scripts/m4.5-gate-select.ts`。
 *
 * ⚠️ **历史档分列**：固定路径那份是 **2026-09-30 刻意留下**的失败档（26 通过 / 18 失败，
 * 且 S11.1–S11.3 全红 = 量具空转档），按 `TD-16` **不回写**，只在 `historical` 里如实列出
 * ⇒ "当期 PASS"与"历史 FAIL"在同一份证据里**都看得见**。
 */
function g14Result(): GateResult {
  const fixedPath = join(evidenceDir, 'smoke', 'smoke-result.json')
  const selection = selectM45G14Reading({
    archiveParent: join(ROOT, 'artifacts', 'm11.1'),
    repoRoot: ROOT,
    fixedPath,
    fixedRelative: 'artifacts/m4.5/smoke/smoke-result.json',
  })
  const fixed = readJson(fixedPath)
  const fixedChecks = (fixed?.checks ?? {}) as { passed?: number; failed?: number }
  let fixedCommit = 'unknown'
  try {
    fixedCommit = execFileSync('git', ['log', '-1', '--format=%h', '--', 'artifacts/m4.5/smoke/smoke-result.json'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim()
  } catch {
    /* 只读盘点失败不改变结论 */
  }
  /* 并列档判定不同 ⇒ 失败关闭（不许按字典序偷偷定一个） */
  const status = selection.conflictingVerdicts ? 'FAIL' : selection.reading.status
  return {
    gate: 'G14',
    name: 'Production-copy Live Smoke（L4）',
    command: 'pnpm m4.5:smoke:live',
    evidence: selection.evidencePath,
    status,
    ...(selection.reading.passed !== undefined ? { passed: selection.reading.passed } : {}),
    ...(selection.reading.failed !== undefined ? { failed: selection.reading.failed } : {}),
    hardGate: true,
    note:
      `真实模型 + 生产库副本 + 临时沙箱；需要 OPENAI_API_KEY · 当期读数按**身份**选：` +
      `basis=${selection.basis} · 来源=${selection.source}` +
      (selection.degraded ? ' · ⚠️ **具名降级**（没有任何时间戳，只按 runId 裁决）' : '') +
      (selection.conflictingVerdicts ? ' · ⚠️ **并列档判定不同 ⇒ 失败关闭**' : ''),
    selectedEvidence: selection.evidencePath,
    selectionBasis: selection.basis,
    ...(selection.degraded ? { selectionDegraded: true } : {}),
    ...(selection.tiedWith.length > 0 ? { tiedWith: selection.tiedWith } : {}),
    historical: [
      {
        path: 'artifacts/m4.5/smoke/smoke-result.json',
        status: fixed === undefined ? 'not-run' : fixed.status === 'PASS' ? 'PASS' : 'FAIL',
        ...(fixedChecks.passed !== undefined ? { passed: fixedChecks.passed } : {}),
        ...(fixedChecks.failed !== undefined ? { failed: fixedChecks.failed } : {}),
        lastCommit: fixedCommit,
        note: '2026-09-30 刻意记录的失败档（量具空转档：S11.1–S11.3 全红）；**保留、不回写**（TD-16 / R-36 / R-50）',
      },
    ],
  }
}

const gates: GateResult[] = [  fromEvidence({
    gate: 'G12',
    name: 'Measurement Validation（L0）',
    command: 'pnpm m4.5:measurement:verify',
    file: 'measurement.json',
    hardGate: true,
  }),
  fromEvidence({
    gate: 'L2',
    name: 'Action Pipeline（子系统）',
    command: 'pnpm m4.5:verify',
    file: 'pipeline.json',
  }),
  fromEvidence({
    gate: 'G13',
    name: 'Natural Language E2E（L3）',
    command: 'pnpm m4.5:nl-action:verify',
    file: 'nl-action.json',
    hardGate: true,
  }),
  g14Result(),
]

/*
 * L1（部件）与审计语料**现在也落 JSON 证据了** ——
 * 汇总器只读证据，不去控制台文本里猜数字（那正是 M4.1 的量具错法）。
 */
gates.push(
  fromEvidence({
    gate: 'G2',
    name: 'Component（L1）',
    command: 'pnpm m4.5:test',
    file: 'component.json',
  })
)
gates.push({
  gate: 'G9',
  name: '人工审计语料',
  command: 'pnpm m4.5:audit',
  evidence: 'artifacts/m4.5/audit-corpus.json',
  status: existsSync(join(evidenceDir, 'audit-corpus.json')) ? 'PASS' : 'not-run',
  note: existsSync(join(evidenceDir, 'audit-corpus.json'))
    ? '审计不变量零违规由 audit-corpus.json 的 auditViolations 为空表示'
    : undefined,
})

/*
 * ⏩ **选档器自证（正控 / 负控 / 恢复）** —— `AGENTS §6.7` 的纪律（2026-10-04，`R-50`）。
 *
 * 它量的是**选档器这个量具**：把 `selectM45G14Reading()` 指向 `%TEMP%` 夹具，逐条验证
 * "更晚的赢 / mtime 不参与 / verdict 不被偷看 / 并列判定不同要失败关闭 / 空候选要具名降级"。
 * 它**不碰** `artifacts/**`，也不改上面那条 G14 的读数。
 */
function runG14SelectionSelfProof(): { checks: { id: string; label: string; pass: boolean; detail: string }[]; failed: number } {
  const checks: { id: string; label: string; pass: boolean; detail: string }[] = []
  const root = mkdtempSync(join(tmpdir(), 'm45-g14-select-'))
  const fixedMissing = join(root, 'no-such-fixed.json')
  const plant = (runId: string, manifest: Record<string, unknown>, reading: Record<string, unknown>): string => {
    const dir = join(root, runId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ liveSmoke: { passed: 52, failed: 0 }, ...manifest }), 'utf8')
    writeFileSync(join(dir, 'artifacts__m4.5__smoke__smoke-result.json'), JSON.stringify(reading), 'utf8')
    return dir
  }
  const select = (): ReturnType<typeof selectM45G14Reading> =>
    selectM45G14Reading({ archiveParent: root, repoRoot: ROOT, fixedPath: fixedMissing, fixedRelative: '(fixture)' })

  try {
    /*
     * 正控：自报 `endedAt` 更晚者赢 —— 三点一起证：
     *   ① 不是按名字选（赢家 runId 字典序**更小**：`aaa` < `zzz`）；
     *   ② **不偷看 verdict**（更晚的那份是 **FAIL**，照样被选中 ⇒ 选档器不"挑一份好看的"）；
     *   ③ 时间来源 = 自报 `endedAt`（`basis=reported-time`）。
     */
    const prefix = 'm111-full-live-regression-'
    plant(`${prefix}aaa-late`, { endedAt: '2026-10-02T06:00:00Z' }, { status: 'FAIL', checks: { passed: 26, failed: 18 } })
    plant(`${prefix}zzz-early`, { endedAt: '2026-10-01T06:00:00Z' }, { status: 'PASS', checks: { passed: 52, failed: 0 } })
    const positive = select()
    checks.push({
      id: 'P1',
      label:
        '正控：自报 `endedAt` 更晚者胜（runId 字典序更小 ⇒ 不是按名字选；那份是 **FAIL** ⇒ 也不偷看 verdict）',
      pass:
        positive.runDir.endsWith('aaa-late') &&
        positive.basis === 'reported-time' &&
        positive.reading.status === 'FAIL',
      detail: `${positive.runDir.split(/[\\/]/).pop() ?? ''} / basis=${positive.basis} / status=${positive.reading.status}`,
    })

    /* 负控①：两份都**没有任何时间戳** ⇒ 具名降级（basis=none），且把 mtime 反转也不许跟着 mtime 走 */
    const quiet = join(root, 'b')
    mkdirSync(quiet, { recursive: true })
    plant(`${prefix}q-aaa`, {}, { status: 'FAIL', checks: { passed: 1, failed: 1 } })
    plant(`${prefix}q-zzz`, {}, { status: 'FAIL', checks: { passed: 1, failed: 1 } })
    const older = new Date(1_600_000_000_000)
    utimesSync(join(root, `${prefix}q-aaa`), older, older) // 让"字典序更小"的那份看起来更旧
    const degradedRoot = join(root, 'only-q')
    mkdirSync(degradedRoot, { recursive: true })
    for (const name of [`${prefix}q-aaa`, `${prefix}q-zzz`]) {
      const from = join(root, name)
      const to = join(degradedRoot, name)
      mkdirSync(to, { recursive: true })
      writeFileSync(join(to, 'manifest.json'), readFileSync(join(from, 'manifest.json')))
      writeFileSync(
        join(to, 'artifacts__m4.5__smoke__smoke-result.json'),
        readFileSync(join(from, 'artifacts__m4.5__smoke__smoke-result.json'))
      )
    }
    const degraded = selectM45G14Reading({
      archiveParent: degradedRoot,
      repoRoot: ROOT,
      fixedPath: fixedMissing,
      fixedRelative: '(fixture)',
    })
    checks.push({
      id: 'P2',
      label: '负控①：没有任何时间戳 ⇒ **具名降级**（`basis=none`、`degraded=true`），按 runId 裁决而不是 mtime',
      pass: degraded.basis === 'none' && degraded.degraded === true && degraded.runDir.endsWith('q-zzz'),
      detail: `basis=${degraded.basis} · degraded=${String(degraded.degraded)} · 选中=${degraded.runDir.split(/[\\/]/).pop() ?? ''}`,
    })

    /* 负控②：时间**并列且判定不同** ⇒ 失败关闭（不许按字典序偷偷定一个） */
    const tieRoot = join(root, 'tie')
    mkdirSync(tieRoot, { recursive: true })
    for (const [suffix, status] of [
      ['t-pass', 'PASS'],
      ['t-fail', 'FAIL'],
    ] as const) {
      const dir = join(tieRoot, `${prefix}${suffix}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'manifest.json'),
        JSON.stringify({ liveSmoke: { passed: 1, failed: 0 }, endedAt: '2026-10-02T06:00:00Z' }),
        'utf8'
      )
      writeFileSync(
        join(dir, 'artifacts__m4.5__smoke__smoke-result.json'),
        JSON.stringify({ status, checks: { passed: 1, failed: status === 'PASS' ? 0 : 1 } }),
        'utf8'
      )
    }
    const tied = selectM45G14Reading({
      archiveParent: tieRoot,
      repoRoot: ROOT,
      fixedPath: fixedMissing,
      fixedRelative: '(fixture)',
    })
    checks.push({
      id: 'P3',
      label: '负控②：时间并列**且判定不同** ⇒ `conflictingVerdicts=true`（调用方失败关闭）',
      pass: tied.conflictingVerdicts === true && tied.tiedWith.length === 1,
      detail: `conflicting=${String(tied.conflictingVerdicts)} · 并列=${JSON.stringify(tied.tiedWith)}`,
    })

    /* 恢复：没有任何候选 ⇒ 回落到固定路径并**具名**标注（这里那份不存在 ⇒ not-run） */
    const emptyRoot = join(root, 'empty')
    mkdirSync(emptyRoot, { recursive: true })
    const fallback = selectM45G14Reading({
      archiveParent: emptyRoot,
      repoRoot: ROOT,
      fixedPath: fixedMissing,
      fixedRelative: '(fixture)',
    })
    checks.push({
      id: 'P4',
      label: '恢复：零候选 ⇒ 回落固定路径并**具名**（`source=fixed-path`、`degraded=true`；文件不存在 ⇒ `not-run`）',
      pass: fallback.source === 'fixed-path' && fallback.degraded === true && fallback.reading.status === 'not-run',
      detail: `source=${fallback.source} · degraded=${String(fallback.degraded)} · status=${fallback.reading.status}`,
    })

    checks.push({
      id: 'P5',
      label: '计数自检：本次自证**真的量到了**夹具（≥1 个候选）',
      pass: positive.runDir !== '' && tied.tiedWith.length > 0,
      detail: `正控候选=${positive.runDir === '' ? 0 : 1} · 并列组=${tied.tiedWith.length + 1}`,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return { checks, failed: checks.filter((check) => !check.pass).length }
}

const g14SelectionSelfProof = runG14SelectionSelfProof()

const summary = {
  testId: 'M4.5 / gate results',
  generatedAt: new Date().toISOString(),
  note: '只读已落盘证据；文件不存在 = not-run（不是 PASS）',
  gates,
  hardGates: gates.filter((g) => g.hardGate === true).map((g) => ({ gate: g.gate, status: g.status })),
  g14SelectionSelfProof,
}

mkdirSync(evidenceDir, { recursive: true })
writeFileSync(join(evidenceDir, 'gate-results.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

console.log('')
console.log('M4.5 门结果汇总（只读证据，不重跑）')
console.log('='.repeat(72))
for (const gate of gates) {
  const mark = gate.status === 'PASS' ? '✅' : gate.status === 'FAIL' ? '❌' : '⏭️'
  const counts =
    gate.passed === undefined ? '' : ` ${gate.passed} 通过 / ${gate.failed ?? 0} 失败`
  console.log(
    `  ${mark} ${gate.gate.padEnd(4)} ${gate.name.padEnd(34)} ${gate.status}${counts}` +
      `${gate.hardGate === true ? '  [HARD GATE]' : ''}`
  )
  for (const failure of gate.failures ?? []) console.log(`        ❌ ${failure}`)
}
console.log('='.repeat(72))
console.log(
  `  G14 选档器自证（正控 / 负控 / 恢复）：${String(g14SelectionSelfProof.checks.length - g14SelectionSelfProof.failed)}/${String(g14SelectionSelfProof.checks.length)}`
)
for (const check of g14SelectionSelfProof.checks) {
  console.log(`      ${check.pass ? '✅' : '❌'} ${check.id} ${check.label} —— ${check.detail}`)
}
console.log(`证据：${join(evidenceDir, 'gate-results.json')}`)

const hardNotPassed = summary.hardGates.filter((g) => g.status !== 'PASS')
if (hardNotPassed.length > 0) {
  console.log(
    `\n⚠️ 有 ${hardNotPassed.length} 个 Hard Gate 不是 PASS：` +
      hardNotPassed.map((g) => `${g.gate}=${g.status}`).join(', ')
  )
}
process.exit(0)
