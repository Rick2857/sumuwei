/**
 * M7 WP7 —— **L1 部件门**（`pnpm m7:test`）。
 *
 * ============================================================================
 *  它聚合什么、为什么是聚合而不是重写
 * ============================================================================
 * 计划书 §7.3 的命令清单里有 `pnpm m7:test`；WP0 交接单明确
 * "不提前注册空壳入口——随 WP2 合同落地再接线"。M7 的部件级判据
 * 已经作为三个 WP 门落地（合同静态检查 / 提案器 / 放行口+归约+投影），
 * 本入口把它们按 L1 口径**串行重跑并聚合**——不重写断言（一处判据一处实现），
 * 只提供"部件面一眼看全"的聚合读数 + 自己的 m7-manifest@1 证据。
 *
 * ```text
 *   m7:wp2:contracts   合同与事件形状（EntityRelationKey · 无 userTrust 写死形状）
 *   m7:wp3:verify      提案器（真实互动识别 · 负控不产生关系变化 · 提案不直接落库）
 *   m7:wp4:verify      Validator / Reducer / Projection（有界 delta · 重复/乱序/失败恢复）
 * ```
 *
 * 三个子门各自独立落自己的证据（新 runId，绝不覆盖）；本门只记聚合读数。
 * 任一子门失败 ⇒ 本门 FAIL（不吞子门退出码）。
 *
 * 跑法：pnpm m7:test
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM7RunId, openM7RunDir, writeM7Manifest } from './m7-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
/** 与 scripts/gates/manifest.ts 同一形状：node + tsx cli（不经 .bin 壳脚本——Windows 跑不了它） */
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')

/** 子门清单（冻结：与计划 §7.3 的 L1 口径一一对应） */
const COMPONENT_GATES: readonly { readonly script: string; readonly label: string }[] = [
  { script: 'scripts/m7-wp2-contracts.ts', label: 'WP2 合同与事件形状' },
  { script: 'scripts/m7-wp3-verify.ts', label: 'WP3 提案器' },
  { script: 'scripts/m7-wp4-verify.ts', label: 'WP4 Validator/Reducer/Projection' },
]

interface Check {
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}
const checks: Check[] = []
function record(id: string, label: string, expected: string, actual: string, pass: boolean): void {
  checks.push({ id, label, expected, actual, pass })
}

function main(): void {
  const results: { script: string; exitCode: number }[] = []
  for (const gate of COMPONENT_GATES) {
    /* 子门各自落自己的证据目录（新 runId）；这里只看退出码 */
    const exitCode = (() => {
      try {
        execFileSync(process.execPath, [TSX_CLI, gate.script], {
          cwd: REPO_ROOT,
          stdio: 'pipe',
          encoding: 'utf8',
          timeout: 10 * 60_000,
        })
        return 0
      } catch (error) {
        const err = error as { status?: number }
        return err.status ?? 1
      }
    })()
    results.push({ script: gate.script, exitCode })
    record(
      `T${String(results.length)}`,
      `${gate.label}（${gate.script}）⇒ 退出码 0`,
      'exit=0',
      `exit=${String(exitCode)}`,
      exitCode === 0,
    )
  }

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const stagesValid = checks.length === COMPONENT_GATES.length && checks.length > 0
  const verdict = !stagesValid ? 'MEASUREMENT INVALID' : failed === 0 ? 'PASS' : 'FAIL'

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM7RunId({ wpId: 'test', headShort: head })
  const dir = openM7RunDir(REPO_ROOT, runId)
  const capturedAt = new Date().toISOString()
  const payload = {
    schema: 'm7-test@1',
    runId,
    capturedAt,
    head,
    componentGates: results,
    checks,
    verdict,
    counts: { total: checks.length, passed, failed },
  }
  writeFileSync(join(dir, 'verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM7Manifest(dir, {
    runId,
    wp: 'test',
    head,
    headShort: head.slice(0, 12),
    branch: 'feature/m7-relationship',
    date: capturedAt.slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'component-test',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes: 'L1 部件聚合门：串行重跑 wp2-contracts / wp3-verify / wp4-verify 并聚合退出码；子门各自落独立证据',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label} → ${c.actual}`)
  }
  console.log(`verdict: ${verdict}（${String(passed)}/${String(checks.length)}）`)
  process.exitCode = verdict === 'PASS' ? 0 : 1
}

main()
