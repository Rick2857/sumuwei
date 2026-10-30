/**
 * 认知能力建设 · P3-5b · **评分复现门**（`p3:5:score:verify`）
 * ============================================================================
 *  目的：把"判分"从一次性 `tmp/` 驱动固化成**可复算**的正式脚本，并用原始产物零网络复算、断言可复现。
 *
 *  ```text
 *  复现链（全部只读文件 + 纯函数）：
 *    turns/*.json + summary.json + task-spec.json
 *      ──(scripts/cognitive/p3-5-score-run.ts · normalization=p3-5-normalize@1)──▶ score.json / score-meta.json
 *  本门断言：
 *    ① 同一份原始产物**再算一次**，与归档 score.json **逐字段相同**（只忽略 generatedAt）；
 *    ② 归一化规则有**版本与原文**，且确实生效过（不代表"没归一化也一样"）；
 *    ③ 判分器源码 sha256 被记录且与当前文件一致（判分口径一改门就红）；
 *    ④ 正式驱动与**冻结前的 tmp 驱动**在 7 个冻结相关字段上一致（"原评分结果"没被换掉）；
 *    ⑤ 桩流量排除规则 v2：**不能只以 token 阈值判定**，无法确认的记 `unknown` 并**保留**在预算里。
 *  ```
 *
 *  ⚠️ 边界：**零真实模型请求、零网络、零数据库**（`globalThis.fetch` 在本门内被替换成"一调用就抛"）。
 *     本门只证明"判分可复现 + 排除规则有证据分级"，**不**重新评价试点结论。
 *
 *  运行：
 *  ```bash
 *  pnpm p3:5:score:verify
 *  ```
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { P3_5_NORMALIZATION_ID, P3_5_NORMALIZATION_RULE, computeP35Score } from './p3-5-score-run.ts'

const REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const SEALED_RUN = join(REPO, 'artifacts', 'cognitive', 'local', 'p3-5-20261028T155501670Z')
const CORRECTION_V2 = join(REPO, 'artifacts', 'cognitive', 'local', 'p3-5-accounting-correction-v2.json')
const ACCOUNTING = join(REPO, 'artifacts', 'cognitive', 'local', 'p3-5-accounting.jsonl')
const SCORER = join(REPO, 'scripts', 'cognitive', 'p3-5-score.ts')

/* ---- 零真实网络 ---- */
const realFetch = globalThis.fetch
let realFetchCalls = 0
globalThis.fetch = (async () => {
  realFetchCalls += 1
  throw new Error('p3-5b_gate_forbids_real_network')
}) as typeof fetch

interface CheckRow {
  readonly id: string
  readonly title: string
  readonly pass: boolean
  readonly detail: string
}
const checks: CheckRow[] = []
function check(id: string, title: string, fn: () => string): void {
  try {
    checks.push({ id, title, pass: true, detail: fn() })
  } catch (error) {
    checks.push({ id, title, pass: false, detail: error instanceof Error ? error.message : String(error) })
  }
}
const startedAt = Date.now()

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
const sha256File = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const withoutGeneratedAt = (value: Record<string, unknown>): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...value }
  delete copy.generatedAt
  return copy
}

const archivedScore = readJson(join(SEALED_RUN, 'score.json'))
const archivedMeta = readJson(join(SEALED_RUN, 'score-meta.json'))
const recomputed = computeP35Score({ runDir: SEALED_RUN })

// ---------------------------------------------------------------------------
//  ① 归档产物存在且可再算
// ---------------------------------------------------------------------------

check('01', '归档判分产物存在（score.json / score-meta.json / 冻结前驱动的 score.v0）', () => {
  for (const path of ['score.json', 'score-meta.json', 'score.v0-tmp-driver.json']) {
    assert.ok(existsSync(join(SEALED_RUN, path)), `缺少 ${path}`)
  }
  const meta = archivedMeta as { schema?: string, normalization?: { id?: string } }
  assert.equal(meta.schema, 'p3-5-score-meta@1')
  assert.equal(meta.normalization?.id, P3_5_NORMALIZATION_ID)
  return `run=${SEALED_RUN.split(/[\\/]/).pop()!}`
})

check('02', '复算可复现：同一份原始产物再算一次，与归档 score.json 逐字段相同（只忽略 generatedAt）', () => {
  const left = JSON.stringify(withoutGeneratedAt(recomputed.score))
  const right = JSON.stringify(withoutGeneratedAt(archivedScore))
  if (left !== right) {
    /* 给出第一个差异位置，便于定位（不是整块 dump）。 */
    let index = 0
    while (index < Math.min(left.length, right.length) && left[index] === right[index]) index += 1
    throw new Error(`复算与归档不一致（首个差异 @${String(index)}）：\n  复算=${left.slice(index, index + 120)}\n  归档=${right.slice(index, index + 120)}`)
  }
  return `score 字段数=${String(Object.keys(recomputed.score).length)}`
})

// ---------------------------------------------------------------------------
//  ② 归一化规则：有版本、有原文、确实生效
// ---------------------------------------------------------------------------

check('03', '归一化规则：版本 + 原文都归档，且确实生效过（归档里没有残留容器绝对路径）', () => {
  const normalization = archivedScore.normalization as { id?: string, rule?: string }
  assert.equal(normalization.id, P3_5_NORMALIZATION_ID)
  assert.equal(normalization.rule, P3_5_NORMALIZATION_RULE)
  const turns = archivedScore.turns as readonly { normalizedReadPaths: readonly string[], normalizedCitedPaths: readonly string[] }[]
  const residual = turns.flatMap(turn => [...turn.normalizedReadPaths, ...turn.normalizedCitedPaths])
    .filter(path => path.startsWith('/') || path.includes(':\\'))
  assert.equal(residual.length, 0, `归一化后仍有绝对路径：${residual.slice(0, 3).join(', ')}`)
  /* 反例保险：原始产物里**确实**有容器绝对路径形态（否则这条"生效"断言是真空的）。 */
  const raw = readJson(join(SEALED_RUN, 'summary.json')) as { perArm?: readonly { readPaths?: readonly string[] }[] }
  const rawAbsolute = (raw.perArm ?? []).flatMap(arm => arm.readPaths ?? []).filter(path => path.startsWith('/opt/project-lg/'))
  assert.ok(rawAbsolute.length > 0, '原始产物里没有容器绝对路径 ⇒ 归一化断言是真空的')
  return `normalize=${P3_5_NORMALIZATION_ID} 原始绝对路径=${String(rawAbsolute.length)} 归一化后=0`
})

check('04', '判分器口径锁：meta 记录的 scorer sha256 == 当前判分器文件 sha256', () => {
  const recorded = (archivedMeta.scorer as { sha256?: string } | undefined)?.sha256
  assert.ok(typeof recorded === 'string' && recorded.length === 64, 'meta 没有记录 scorer sha256')
  const actual = sha256File(SCORER)
  assert.equal(recorded, actual, `判分器变了（记录=${recorded.slice(0, 16)}… 实际=${actual.slice(0, 16)}…）⇒ 需重新判分并更新归档`)
  return `scorer sha256=${actual.slice(0, 16)}…`
})

// ---------------------------------------------------------------------------
//  ③ "原评分结果"没被换掉：与冻结前 tmp 驱动逐字段一致
// ---------------------------------------------------------------------------

check('05', '与冻结前驱动一致：7 个冻结相关字段逐字相同（结论没被新驱动改掉）', () => {
  const preFreeze = readJson(join(SEALED_RUN, 'score.v0-tmp-driver.json'))
  const fields = ['taskOutcomes', 'armSummaries', 'autoLoadRate', 'planFailureHistogram', 'contentIdentical', 'm9PerTask', 'overhead']
  const differing = fields.filter(field => JSON.stringify(preFreeze[field]) !== JSON.stringify(archivedScore[field]))
  assert.equal(differing.length, 0, `字段不一致：${differing.join(',')}`)
  const verdictA = (preFreeze.comparison as { verdict?: string }).verdict
  const verdictB = (archivedScore.comparison as { verdict?: string }).verdict
  assert.equal(verdictA, verdictB)
  return `verdict=${String(verdictB)} fields=${String(fields.length)}/7`
})

// ---------------------------------------------------------------------------
//  ④ 桩流量排除规则 v2：证据分级、不能只靠 token、unknown 保留
// ---------------------------------------------------------------------------

check('06', '排除规则 v2 存在：判据写明"端点 + 角色 + 时延"，token 只作旁证', () => {
  assert.ok(existsSync(CORRECTION_V2), '缺少 p3-5-accounting-correction-v2.json')
  const correction = readJson(CORRECTION_V2) as {
    schema?: string
    rule?: { id?: string, tokenThresholdRole?: string }
    evidence?: { mockModelLog?: { status?: string }, endpointConfig?: { value?: string } }
    totals?: { excluded?: { requests?: number, tokens?: number }, provider?: { requests?: number, tokens?: number }, unknown?: { requests?: number, tokens?: number }, tokenOnlyRows?: number }
    rows?: readonly { classification?: string, basis?: readonly string[], confidence?: string }[]
  }
  assert.equal(correction.schema, 'p3-5-accounting-correction@2')
  assert.equal(correction.rule?.id, 'p3-5-stub-exclusion@2')
  assert.ok(correction.rule?.tokenThresholdRole?.includes('旁证'), '规则没有把 token 降级为旁证')
  assert.equal(correction.totals?.tokenOnlyRows, 0, '存在"只以 token 判定"的记录')
  assert.equal(correction.evidence?.mockModelLog?.status, 'not_archived', '假模型日志缺口必须如实标注')
  const rows = correction.rows ?? []
  assert.ok(rows.length > 0, '没有逐条判定记录')
  for (const row of rows) {
    if (row.classification === 'excluded_stub') {
      const basis = row.basis ?? []
      const hasRole = basis.some(item => item.startsWith('role:'))
      const hasRtt = basis.some(item => item.startsWith('rtt:'))
      assert.ok(hasRole && hasRtt, `被排除的行缺少角色/时延证据：${JSON.stringify(row.basis)}`)
    }
  }
  return `excluded=${String(correction.totals?.excluded?.requests)}/${String(correction.totals?.excluded?.tokens)} provider=${String(correction.totals?.provider?.requests)}/${String(correction.totals?.provider?.tokens)} unknown=${String(correction.totals?.unknown?.requests)}/${String(correction.totals?.unknown?.tokens)}`
})

check('07', '未知记录**保留**在预算里：provider + unknown 合计 == 归档保留的 24 请求 / 53 979 token', () => {
  const correction = readJson(CORRECTION_V2) as {
    totals?: { provider?: { requests?: number, tokens?: number }, unknown?: { requests?: number, tokens?: number, attempts?: number } }
    rows?: readonly { classification?: string, taskId?: string }[]
  }
  const requests = Number(correction.totals?.provider?.requests ?? NaN) + Number(correction.totals?.unknown?.requests ?? NaN)
  const tokens = Number(correction.totals?.provider?.tokens ?? NaN) + Number(correction.totals?.unknown?.tokens ?? NaN)
  assert.equal(requests, 24)
  assert.equal(tokens, 53_979)
  const unknownRows = (correction.rows ?? []).filter(row => row.classification === 'unknown')
  assert.ok(unknownRows.length >= 1, '本批应有 1 条"无法确认"的记录（A:T5:r1 答复 944 ms）')
  return `kept=${String(requests)}/requests ${String(tokens)}/tokens · unknown=${String(unknownRows.length)}（保留，不排除）`
})

check('08', '累计账目与批记录一致：131 请求 / 275 757 token', () => {
  const rows = readFileSync(ACCOUNTING, 'utf8').split(/\r?\n/).filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as { requests?: number, tokens?: number })
  const requests = rows.reduce((sum, row) => sum + Number(row.requests ?? 0), 0)
  const tokens = rows.reduce((sum, row) => sum + Number(row.tokens ?? 0), 0)
  assert.equal(requests, 131)
  assert.equal(tokens, 275_757)
  return `rows=${String(rows.length)} requests=${String(requests)} tokens=${String(tokens)}`
})

// ---------------------------------------------------------------------------
//  ⑤ 结论稳定 + 零网络
// ---------------------------------------------------------------------------

check('09', '结论稳定：verdict 与逐任务配对一致，且两臂达成数来自 armSummaries（不手抄）', () => {
  const comparison = archivedScore.comparison as { verdict?: string, perTask?: readonly { sameOutcome?: boolean }[] }
  const arms = archivedScore.armSummaries as readonly { arm: string, achieved: number, tasks: number }[]
  assert.equal(comparison.verdict, 'compatible')
  const perTask = comparison.perTask ?? []
  assert.equal(perTask.length, 6)
  assert.equal(perTask.filter(item => item.sameOutcome === true).length, 6)
  assert.deepEqual(arms.map(arm => `${arm.arm}:${String(arm.achieved)}/${String(arm.tasks)}`), ['A:4/4', 'B:4/4'])
  return `verdict=compatible perTask=6/6 arms=A:4/4,B:4/4`
})

check('10', '零网络自证：本门内真 `fetch` 调用次数 = 0', () => {
  assert.equal(realFetchCalls, 0, `本门内发生了 ${String(realFetchCalls)} 次真网络调用`)
  return 'realFetch=0'
})

globalThis.fetch = realFetch

const passed = checks.filter(row => row.pass).length
const failed = checks.length - passed
const elapsedMs = Date.now() - startedAt
for (const row of checks) {
  console.log(`${row.pass ? 'PASS' : 'FAIL'} ${row.id} ${row.title}${row.pass ? `（${row.detail}）` : `\n     ↳ ${row.detail}`}`)
}
console.log(`\nP3-5b 评分复现门：${String(passed)} PASS / ${String(failed)} FAIL / ${String(checks.length)} total（${String(elapsedMs)} ms）`)
process.exitCode = failed === 0 && checks.length > 0 ? 0 : 1
