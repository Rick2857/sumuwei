/**
 * M9 WP2 —— 量具有效性集中门（`pnpm m9:measurement:verify`）。
 *
 * ============================================================================
 *  量具自己也是被测对象（INV-M45-06；AGENTS §6.2/§6.7/§6.8）
 * ============================================================================
 * M9 的每一道门都依赖四件量具：清单校验（m9-manifest@1）、语料完整性、
 * oracle 独立性、runId/运行目录机器。本门用**最小夹具**证明它们都会响：
 *
 *      ① 正控：合法输入 → 检测器**安静**（否则它是噪音源）
 *      ② 负控：注入假象 → 检测器**必须响**（否则它是橡皮图章）
 *      ③ 恢复：放回真实实现 → 检测器**重新安静**（注入没改坏什么）
 *
 * 注入的假象（每个都必须被抓住）：
 *      manifest：缺必填字段 / schemaVersion 漂移 / counts.total=0（0 检查 ≠ PASS）/
 *                payloadSha256 事后篡改
 *      语料    ：重复 id / expect 闭集外 / 空语料（measured_count=0 ⇒ INVALID）
 *      oracle  ：源码出现 projections import（同义反复量具）
 *      runId   ：非法 wpId / 非法后缀 / 已存在目录拒绝覆盖（TD-04①）
 *
 * ⚠️ 本门不打开任何数据库（纯函数 + 文本夹具 + %TEMP% 目录）。
 *
 * 跑法：pnpm m9:measurement:verify
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  M9_MANIFEST_VERSION,
  assertValidM9RunId,
  createM9RunId,
  openM9RunDir,
  validateM9Manifest,
  writeM9Manifest,
} from './m9-evidence.ts'

const REPO_ROOT = process.cwd()

// ---------------------------------------------------------------------------
// 检测器（量具本体；与 m9:test 共用的判据在这里**重述**——量具门验证的是
// 检测器本身，不 import 业务测试的断言结果）
// ---------------------------------------------------------------------------

interface InferredSample {
  id: string
  value: string
  expect: string
  text: string
}
interface ReportedSample {
  id: string
  expect: string
  memoryType: string
  authority: string
  epistemicStatus: string
  status: string
}
interface Corpus {
  family: string
  inferred: InferredSample[]
  reported: ReportedSample[]
}

/** 语料完整性检测器：返回问题清单 + 实测计数（measured_count 纪律的载体） */
function corpusProblems(corpus: Corpus): {
  problems: string[]
  measured: Record<string, number>
} {
  const problems: string[] = []
  const measured: Record<string, number> = {
    inferredSamples: corpus.inferred.length,
    reportedSamples: corpus.reported.length,
    noteCount: corpus.inferred.filter((s) => s.expect === 'note').length,
    silentCount: corpus.inferred.filter((s) => s.expect === 'silent').length,
    eligibleCount: corpus.reported.filter((s) => s.expect === 'eligible').length,
    ineligibleCount: corpus.reported.filter((s) => s.expect === 'ineligible').length,
  }

  if (measured.inferredSamples === 0 && measured.reportedSamples === 0) {
    problems.push('MEASUREMENT INVALID：语料 0 条（0 检查 0 失败 ≠ PASS —— AGENTS §6.8）')
  }
  const allIds = [...corpus.inferred.map((s) => s.id), ...corpus.reported.map((s) => s.id)]
  if (new Set(allIds).size !== allIds.length) {
    problems.push('样本 id 存在重复（场景身份必须唯一）')
  }
  for (const s of corpus.inferred) {
    if (s.expect !== 'note' && s.expect !== 'silent') {
      problems.push(`inferred.expect 闭集外：${s.id} = ${JSON.stringify(s.expect)}`)
    }
  }
  for (const s of corpus.reported) {
    if (s.expect !== 'eligible' && s.expect !== 'ineligible') {
      problems.push(`reported.expect 闭集外：${s.id} = ${JSON.stringify(s.expect)}`)
    }
  }
  if (measured.noteCount === 0 && measured.inferredSamples > 0) {
    problems.push('inferred 正控为 0（全拒绝的量具什么都量不到）')
  }
  if (measured.silentCount === 0 && measured.inferredSamples > 0) {
    problems.push('inferred 负控为 0（没有负控的量具拦不住越权）')
  }
  return { problems, measured }
}

/** oracle 独立性检测器：**import 行**不得引用被测实现（同义反复守卫） */
function oracleIndependenceProblems(source: string): string[] {
  const problems: string[] = []
  // 只扫 import/require 行：注释里提及生产文件是合法文档行为，
  // 全文扫描会把"说明自己为何独立"的注释误判成违规（量具校准第一轮发现）。
  const importLines = source
    .split('\n')
    .filter((line) => /^\s*(import\b|.*\brequire\s*\()/.test(line))
  if (importLines.some((line) => line.includes('projections'))) {
    problems.push('oracle import 了 projections（import 被测 reducer = 同义反复）')
  }
  if (importLines.some((line) => line.includes('kernel/'))) {
    problems.push('oracle import 了 kernel 模块（预期机器必须零共享代码）')
  }
  return problems
}

// ---------------------------------------------------------------------------
// 三段式执行
// ---------------------------------------------------------------------------

interface StageResult {
  detector: string
  stage: 'positive' | 'negative' | 'recovery'
  pass: boolean
  detail: string
}

const results: StageResult[] = []

function record(detector: string, stage: StageResult['stage'], pass: boolean, detail: string): void {
  results.push({ detector, stage, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} [${detector}] ${stage} :: ${detail}`)
}

function mustThrow(label: string, fn: () => void): boolean {
  try {
    fn()
  } catch {
    return true
  }
  console.error(`      （${label}：没有抛）`)
  return false
}

function main(): void {
  console.log('M9 量具三段式（正控 / 负控 / 恢复）')

  // ---- 合法夹具 -----------------------------------------------------------
  const realCorpus = JSON.parse(
    readFileSync(join(REPO_ROOT, 'evals', 'fixtures', 'm9', 'belief-rule-corpus.json'), 'utf8'),
  ) as Corpus
  const realOracle = readFileSync(
    join(REPO_ROOT, 'evals', 'fixtures', 'm9', 'belief-oracle.ts'),
    'utf8',
  )
  const validManifest = {
    runId: 'm9-wp2-20260927-013f51b013f5-a1b2',
    wp: 'wp2',
    head: '013f51b013f5'.padEnd(40, '0'),
    headShort: '013f51b013f5',
    branch: 'feature/m7-relationship',
    date: '2026-09-27',
    toolVersions: { node: process.version },
    testType: 'measurement',
    counts: { total: 12, passed: 12, failed: 0 },
    phases: ['single'],
    supersedes: null,
  }

  // ===== 检测器①：m9-manifest@1 ==========================================
  console.log('检测器① m9-manifest@1')

  // ① 正控：合法 manifest 安静（writeM9Manifest 内部 sealManifest 补摘要，
  // 写出的清单就是"带正确 payloadSha256 的合法基线"——负控都从它注入）
  const tmpManifestDir = mkdtempSync(join(tmpdir(), 'm9-measurement-'))
  const manifestPath = ((): string => {
    writeM9Manifest(tmpManifestDir, { ...validManifest })
    return join(tmpManifestDir, 'manifest.json')
  })()
  const writtenManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  record(
    'manifest',
    'positive',
    validateM9Manifest(writtenManifest).length === 0,
    '写出的合法清单读回校验 0 问题',
  )

  // ② 负控：四种注入必须全部被抓住
  // 注入方式 = 真删键（destructure），不是置 undefined——`field in manifest`
  // 对值为 undefined 的键仍返回 true，置 undefined 测不到"缺字段检测器"
  // （量具校准第一轮的真实发现）。
  const { headShort: _omit, ...withoutHeadShort } = writtenManifest
  const missingField = validateM9Manifest(withoutHeadShort)
  record(
    'manifest',
    'negative',
    missingField.some((p) => p.field === 'headShort'),
    `缺必填字段被抓（${missingField.length} 问题：缺字段 + 摘要不符）`,
  )
  const wrongVersion = validateM9Manifest({ ...writtenManifest, schemaVersion: 'm8-manifest@1' })
  record(
    'manifest',
    'negative',
    wrongVersion.some((p) => p.field === 'schemaVersion'),
    'schemaVersion 漂移被抓',
  )
  const zeroCounts = validateM9Manifest({
    ...writtenManifest,
    counts: { total: 0, passed: 0, failed: 0 },
  })
  record(
    'manifest',
    'negative',
    zeroCounts.some((p) => p.field === 'counts.total' && p.problem.includes('INVALID')),
    'counts.total=0 ⇒ MEASUREMENT INVALID（0 检查 ≠ PASS）',
  )
  const tampered = validateM9Manifest({
    ...writtenManifest,
    counts: { total: 99, passed: 99, failed: 0 }, // 改了 payload 不改摘要
  })
  record(
    'manifest',
    'negative',
    tampered.some((p) => p.field === 'payloadSha256'),
    '事后篡改被摘要抓住',
  )
  record(
    'manifest',
    'negative',
    mustThrow('writeM9Manifest 拒写缺字段清单', () => {
      writeM9Manifest(tmpManifestDir, { wp: 'wp2' })
    }),
    '写侧失败关闭：缺字段清单拒写',
  )

  // ③ 恢复：合法清单重新安静
  record(
    'manifest',
    'recovery',
    validateM9Manifest(writtenManifest).length === 0,
    '放回真实清单后重新安静（注入没改坏什么）',
  )

  // ===== 检测器②：语料完整性 =============================================
  console.log('检测器② 语料完整性')

  const real = corpusProblems(realCorpus)
  record(
    'corpus',
    'positive',
    real.problems.length === 0 &&
      real.measured.inferredSamples > 0 &&
      real.measured.reportedSamples > 0,
    `真实语料 0 问题（inferred ${real.measured.inferredSamples} · reported ${real.measured.reportedSamples}）`,
  )

  const dupId = corpusProblems({
    ...realCorpus,
    inferred: [...realCorpus.inferred, { ...realCorpus.inferred[0]! }],
  })
  record('corpus', 'negative', dupId.problems.length > 0, '重复 id 被抓')

  const badExpect = corpusProblems({
    ...realCorpus,
    reported: [...realCorpus.reported, { ...realCorpus.reported[0]!, expect: 'maybe' }],
  })
  record('corpus', 'negative', badExpect.problems.length > 0, 'expect 闭集外被抓')

  const empty = corpusProblems({ family: realCorpus.family, inferred: [], reported: [] })
  record(
    'corpus',
    'negative',
    empty.problems.some((p) => p.includes('MEASUREMENT INVALID')),
    '空语料 ⇒ MEASUREMENT INVALID（不是 PASS）',
  )

  const recovered = corpusProblems(realCorpus)
  record('corpus', 'recovery', recovered.problems.length === 0, '真实语料重新安静')

  // ===== 检测器③：oracle 独立性 ===========================================
  console.log('检测器③ oracle 独立性')

  record(
    'oracle',
    'positive',
    oracleIndependenceProblems(realOracle).length === 0,
    '真实 oracle 源码 0 问题',
  )
  record(
    'oracle',
    'negative',
    oracleIndependenceProblems(
      "// 被污染的 oracle\nimport { reduceBelief } from '../src/kernel/projections/belief.ts'\n",
    ).length === 2,
    'import 生产 reducer 的 oracle 被抓（两条问题都响）',
  )
  record(
    'oracle',
    'recovery',
    oracleIndependenceProblems(realOracle).length === 0,
    '真实 oracle 重新安静',
  )

  // ===== 检测器④：runId / 运行目录机器 ===================================
  console.log('检测器④ runId / 运行目录')

  const goodRunId = createM9RunId({ wpId: 'wp2', headShort: '013f51b013f5', suffix: 'aaaa' })
  let accepted = true
  try {
    assertValidM9RunId(goodRunId)
  } catch {
    accepted = false
  }
  record('runid', 'positive', accepted, `合法 runId 被接受（${goodRunId}）`)

  record(
    'runid',
    'negative',
    mustThrow('非法 wpId', () => {
      createM9RunId({ wpId: 'WP 2!', headShort: '013f51b013f5' })
    }),
    '非法 wpId 被拒（不做静默归一化）',
  )
  record(
    'runid',
    'negative',
    mustThrow('非法后缀', () => {
      createM9RunId({ wpId: 'wp2', headShort: '013f51b013f5', suffix: 'ZZZZ' })
    }),
    '非 hex 后缀被拒',
  )

  const tmpRoot = mkdtempSync(join(tmpdir(), 'm9-runroot-'))
  const dirRunId = createM9RunId({ wpId: 'wp2', headShort: '013f51b013f5', suffix: 'bbbb' })
  openM9RunDir(tmpRoot, dirRunId)
  record(
    'runid',
    'negative',
    mustThrow('目录拒绝覆盖', () => {
      openM9RunDir(tmpRoot, dirRunId)
    }),
    '已存在 runId 目录拒绝覆盖（TD-04①）',
  )
  const dirRunId2 = createM9RunId({ wpId: 'wp2', headShort: '013f51b013f5', suffix: 'cccc' })
  const fresh = openM9RunDir(tmpRoot, dirRunId2)
  record('runid', 'recovery', fresh.endsWith(dirRunId2), '新 runId 正常开目录')

  // ---- 清理临时目录 -------------------------------------------------------
  rmSync(tmpManifestDir, { recursive: true, force: true })
  rmSync(tmpRoot, { recursive: true, force: true })

  // ---- 汇总 + 证据 --------------------------------------------------------
  const passed = results.filter((r) => r.pass).length
  const failed = results.length - passed
  const verdict = failed === 0 ? 'MEASUREMENT VALID' : 'MEASUREMENT INVALID'

  console.log('---')
  console.log(`三段式：${results.length} 项 · 通过 ${passed} · 失败 ${failed}`)
  console.log(`verdict: ${verdict}`)

  // 证据落盘（真实 artifacts 树；runId 拒绝覆盖）
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM9RunId({ wpId: 'wp2-measurement', headShort: head })
  const dir = openM9RunDir(REPO_ROOT, runId)
  writeFileSync(
    join(dir, 'measurement.json'),
    `${JSON.stringify({ schema: 'm9-wp2-measurement@1', runId, head, results, summary: { total: results.length, passed, failed, verdict } }, null, 2)}\n`,
    'utf8',
  )
  writeM9Manifest(dir, {
    runId,
    wp: 'wp2',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'measurement',
    counts: { total: results.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes: '量具三段式：manifest / 语料 / oracle 独立性 / runId 机器（正控-负控-恢复）',
    mode: 'offline',
    databaseScope: 'none',
  })
  console.log(`runId: ${runId}`)

  process.exitCode = failed === 0 ? 0 : 1
}

main()
