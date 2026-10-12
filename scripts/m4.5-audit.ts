/**
 * M4.5 —— **人工审计语料 + 最小 Inspector**（计划书 §31 / §59）。
 *
 * ============================================================================
 *  它回答的是那七个问题
 * ============================================================================
 * ```text
 * 做的是什么？       capability.operation
 * 目标是谁？         target.canonicalId / confidence / evidence
 * 为什么允许？       decision.checks（逐条留痕）
 * 哪个能力执行？     capability@version（登记表）
 * 什么时候执行？     timestamps
 * 结果如何？         status / executed / effect
 * 证据在哪里？       evidence + traceId
 * ```
 *
 * 它跑在**隔离库 + 临时沙箱**上：造一批覆盖四态的动作（成功 / 失败 /
 * 被拒 / 模糊），再用**生产同一套渲染器**（`kernel/action/admin.ts`）
 * 输出清单，并跑 §32 的审计不变量。
 *
 * ⚠️ 与 `m4:audit` 一样：它**不是**一个"再跑一遍测试"的脚本，
 *    而是一次可以用眼睛看的抽样 —— 数字之外，那份清单本身要读得通。
 *
 * 跑法：pnpm m4.5:audit
 */

import 'dotenv/config'

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  FAULTY_WRITE,
  createActionTestBed,
  createFaultyWriteAdapter,
  createReporter,
  faultyWriteCapability,
} from './action-harness.ts'
import {
  checkActionAuditInvariants,
  renderAuditReport,
} from '../src/kernel/action/audit-invariants.ts'
import {
  renderActionAudit,
  renderActionDetail,
  renderActionList,
  renderActionTrace,
} from '../src/kernel/action/admin.ts'
import { SANDBOX_FILE_WRITE, SYSTEM_ECHO } from '../src/kernel/action/capability-registry.ts'

const evidenceDir = join(process.cwd(), 'artifacts', 'm4.5')
mkdirSync(evidenceDir, { recursive: true })

const report = createReporter()
console.log('='.repeat(72))
console.log('M4.5 人工审计语料（她做过什么：七问可答 + 审计不变量）')
console.log('='.repeat(72))

const sandbox = isolateDatabase('m45-audit', { keep: true })
await resetPluginSqlConnection()

const bed = await createActionTestBed({
  label: 'audit',
  extraCapabilities: [faultyWriteCapability()],
  extraAdapters: [createFaultyWriteAdapter({ calls: 0 })],
})

// ---------------------------------------------------------------------------
// 造语料：覆盖 success / failed / rejected / ambiguous / not_found / partial
// ---------------------------------------------------------------------------
const traceId = 'trc:m45-audit'

bed.writeSandboxFile('notes.md', 'audit-corpus')
await bed.say('读一下 notes.md')

await bed.execute({
  capability: SANDBOX_FILE_WRITE,
  operation: 'write',
  args: { path: 'created.txt', content: 'hello' },
  idempotencyKey: 'audit-write-1',
  traceId,
})
// 同一请求再发一次 → 幂等重放（审计必须能区分"物理执行"与"逻辑操作"）
await bed.execute({
  capability: SANDBOX_FILE_WRITE,
  operation: 'write',
  args: { path: 'created.txt', content: 'hello' },
  idempotencyKey: 'audit-write-1',
  traceId,
})
await bed.execute({
  capability: SANDBOX_FILE_WRITE,
  operation: 'write',
  args: { path: '../escape.txt', content: 'nope' },
  traceId,
})
bed.writeSandboxFile('a/dup.txt', 'A')
bed.writeSandboxFile('b/dup.txt', 'B')
await bed.execute({
  capability: SANDBOX_FILE_WRITE,
  operation: 'write',
  args: { path: 'dup.txt', content: 'X' },
  traceId,
})
await bed.execute({ capability: 'sandbox.file.read', operation: 'read', args: { path: 'missing.txt' }, traceId })
await bed.execute({
  capability: FAULTY_WRITE,
  operation: 'write',
  args: { path: 'fail.txt', content: 'x' },
  traceId,
})
await bed.execute({ capability: SYSTEM_ECHO, operation: 'echo', args: { text: 'audit' }, traceId })

// ---------------------------------------------------------------------------
// 渲染（生产同一套）
// ---------------------------------------------------------------------------
const all = await bed.records({ limit: 100 })
const lines: string[] = []

lines.push('================================================================')
lines.push('M4.5 动作审计清单（她做过什么）')
lines.push('================================================================')
lines.push('')
lines.push(renderActionList(all, '全部动作记录'))
lines.push('')
lines.push('---- 单条详情（抽样：第一个成功的写） ----')
const sample = all.find((r) => r.status === 'success' && r.capability === SANDBOX_FILE_WRITE) ?? all[0]!
lines.push(renderActionDetail(sample))
lines.push('')
lines.push('---- 一条 trace 下的全部动作 ----')
lines.push(renderActionTrace(await bed.ledger.getEventsByTraceId(traceId as never)))
lines.push('')
lines.push('---- 审计不变量（§32） ----')
lines.push(renderActionAudit(all))
lines.push('')

const violations = checkActionAuditInvariants(all)

// ---------------------------------------------------------------------------
// 断言：清单本身要成立（否则它只是一份好看的输出）
// ---------------------------------------------------------------------------
report.section('§1 语料覆盖')
{
  const statuses = new Set(all.map((r) => r.status))
  report.check('§1.1 覆盖 success', statuses.has('success'))
  report.check('§1.2 覆盖 rejected（越界）', statuses.has('rejected'))
  report.check('§1.3 覆盖 ambiguous（多候选）', statuses.has('ambiguous'))
  report.check('§1.4 覆盖 not_found', statuses.has('not_found'))
  report.check('§1.5 覆盖 failed（注入失败）', statuses.has('failed'))
  report.check('§1.6 覆盖幂等重放', all.some((r) => r.idempotentReplay))
}

report.section('§2 七问逐条可答（随机抽样的每一条都要答得出）')
{
  for (const record of all) {
    const answers = [
      record.capability !== '' && record.operation !== '',
      record.status !== undefined,
      record.requestedAt > 0,
      String(record.traceId).startsWith('trc:'),
    ]
    if (!answers.every(Boolean)) {
      report.check(`§2.x ${String(record.actionId)} 七问可答`, false)
    }
  }
  report.check('§2.1 全部记录的"做什么 / 结果 / 时间 / trace"都可答', all.every((r) => r.capability !== '' && r.status !== undefined && r.requestedAt > 0 && String(r.traceId).startsWith('trc:')))
  report.check(
    '§2.2 "目标是谁"对**真的执行过**的记录都可答（含确定性等级）',
    all.filter((r) => r.executed).every((r) => r.target !== undefined && r.target.confidence !== undefined)
  )
  report.check(
    '§2.3 "为什么允许"可从账本逐条读出（decision.checks 落库）',
    await (async () => {
      const allowEvents = (await bed.ledger.listEvents(bed.characterId, 200)).filter(
        (e) => e.type === 'ACTION_AUTHORIZED'
      )
      return (
        allowEvents.length > 0 &&
        allowEvents.every((e) => {
          const decision = e.payload.decision as { checks?: unknown } | undefined
          return Array.isArray(decision?.checks) && decision.checks.length > 0
        })
      )
    })()
  )
  report.check('§2.4 "证据在哪里"：每条终态记录都带 evidence 或显式为空数组', all.every((r) => Array.isArray(r.evidence)))
}

report.section('§3 审计不变量')
{
  report.check('§3.1 零违规（§32 四条 + 两条补充）', violations.length === 0, violations.map((v) => `${v.invariant}@${v.actionId}`).join(', '))
  report.check('§3.2 报告里逐项说出了物理执行与重放的次数', renderAuditReport(all).includes('物理执行'))
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------
const corpus = {
  generatedAt: new Date().toISOString(),
  sandboxDir: sandbox.dir,
  records: all.map((record) => ({
    actionId: String(record.actionId),
    traceId: String(record.traceId),
    capability: record.capability,
    operation: record.operation,
    status: record.status,
    executed: record.executed,
    accepted: record.accepted,
    idempotentReplay: record.idempotentReplay,
    sideEffect: record.sideEffect,
    target: record.target ?? null,
    failure: record.failure ?? null,
    effect: record.effect ?? null,
    timestamps: {
      requested: record.requestedAt,
      started: record.startedAt ?? null,
      finished: record.finishedAt ?? null,
    },
    evidence: record.evidence,
  })),
  auditViolations: violations,
  checks: { passed: report.passed, failed: report.failed, failures: report.failures },
}

writeFileSync(join(evidenceDir, 'audit-corpus.json'), `${JSON.stringify(corpus, null, 2)}\n`, 'utf8')
writeFileSync(join(evidenceDir, 'audit-report.txt'), `${lines.join('\n')}\n`, 'utf8')

console.log(`\n${lines.join('\n')}`)

await bed.stop()
await resetPluginSqlConnection()
cleanupSandbox(sandbox.dir)

report.finish('M4.5 人工审计语料')
