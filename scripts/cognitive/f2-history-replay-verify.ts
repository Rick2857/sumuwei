/**
 * **历史响应回放（零模型）**：用 run4 的 `calls-*.jsonl` 复核取证分类是否自洽。
 *
 * ⚠️ 只能回放**信封层**（形状/长度/哈希/usage/finish_reason/传输错误）。
 *    `contentPreview` 只有 240 字符，**不足以**重放完整候选计划 ⇒ 完成协议的行为验证靠夹具门
 *    （`f2-unit-execution-verify` 的 claim-mix / claim-only）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const out = resolve('artifacts/local/f2-history-replay', `run-${Date.now()}`)
mkdirSync(out, { recursive: true })
const checks: string[] = []
const check = (name: string, value: unknown, detail = ''): void => {
  if (!value) throw new Error(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  checks.push(name)
  console.log(`PASS ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const runDir = 'artifacts/local/f2-real-run/run-20261027d'
const units = ['A-cf', 'A-af', 'C-cf', 'C-af']
const calls: { unit: string, finishReason?: string | null, contentShape?: string, candidateCount?: number | null, usagePresent?: boolean, transportError?: string }[] = []
for (const unit of units) {
  const path = `${runDir}/calls-${unit}.jsonl`
  const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
  for (const line of lines) calls.push({ unit, ...JSON.parse(line) })
}

/* ① 截断 ⇒ 空内容（与真实失败模式一致） */
const truncated = calls.filter(call => call.finishReason === 'length')
check('① 历史里 finish_reason=length 的调用，content 形状只能是 empty 或 unparsable（截断 ⇒ 无完整候选）',
  truncated.length > 0 && truncated.every(call => call.contentShape === 'empty' || call.contentShape === 'unparsable'),
  `length=${String(truncated.length)} shapes=${JSON.stringify(truncated.map(call => call.contentShape))}`)

/* ② 有候选的调用：候选数 ≥1 且 finish_reason=stop */
const withCandidates = calls.filter(call => call.contentShape === 'candidates-array')
check('② 历史里有候选的调用：candidateCount ≥ 1 且 finish_reason=stop',
  withCandidates.length > 0 && withCandidates.every(call => (call.candidateCount ?? 0) >= 1 && call.finishReason === 'stop'),
  `count=${String(withCandidates.length)} candidates=${JSON.stringify(withCandidates.map(call => call.candidateCount))}`)

/* ③ 单候选普遍性：C-cf 全部候选数组都只有 1 个候选（不能当顺序操纵成功） */
const ccf = calls.filter(call => call.unit === 'C-cf' && call.contentShape === 'candidates-array')
const singleCandidate = ccf.filter(call => call.candidateCount === 1).length
check('③ C-cf 的有候选调用全部为**单候选**（顺序因子无法产生差异 ⇒ cf/af 标签不能被当作顺序操纵成功）',
  ccf.length >= 1 && singleCandidate === ccf.length, `candidates=${String(ccf.length)} single=${String(singleCandidate)}`)

/* ④ 传输错误调用：无 usage（结算只能按不可确认/有界暂扣） */
const transportErrors = calls.filter(call => call.transportError)
check('④ 传输错误调用 usagePresent=false（不能当作已确认成本）',
  transportErrors.every(call => call.usagePresent === false),
  `errors=${String(transportErrors.length)}`)

/* ⑤ 覆盖度：A/C 四单元的调用都被读到 */
check('⑤ 回放覆盖 A/C 四单元全部调用（无遗漏文件）',
  units.every(unit => calls.some(call => call.unit === unit)) && calls.length >= 60,
  `calls=${String(calls.length)}`)

writeFileSync(resolve(out, 'replay.json'), JSON.stringify({
  status: 'PASS', schema: 'f2-history-replay@1', measuredAt: new Date().toISOString(), checks,
  source: `${runDir}/calls-{A-cf,A-af,C-cf,C-af}.jsonl`,
  totals: { calls: calls.length, truncated: truncated.length, withCandidates: withCandidates.length, transportErrors: transportErrors.length },
  boundary: [
    '只回放信封层；contentPreview 仅 240 字符 ⇒ 不能重放完整候选计划',
    '完成协议行为验证由 f2-unit-execution-verify 的 claim-mix / claim-only 覆盖',
  ],
}, null, 2) + '\n', 'utf8')
console.log(`历史回放：${String(checks.length)}/${String(checks.length)}；${out}`)
