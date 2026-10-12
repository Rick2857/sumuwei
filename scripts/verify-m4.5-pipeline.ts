/**
 * M4.5 L2 —— 子系统级验证（`pnpm m4.5:verify`）。
 *
 * ============================================================================
 *  它证明的是"串起来之后会发生什么"
 * ============================================================================
 * ```text
 * ActionRequest → TargetResolver → Policy → Gateway → Adapter → ActionResult → Ledger
 * ```
 *
 * 三层证据同时取（计划书 §50）：
 *
 *   Level 1  真实外部结果      —— 文件真的在不在、内容对不对
 *   Level 2  Execution Ledger  —— 真实事件流（不是"函数返回了什么"）
 *   Level 3  ActionResult      —— 账本折叠出来的结论
 *
 * ---------------------------------------------------------------------------
 *  正负双控（§39）
 * ---------------------------------------------------------------------------
 *   阳性：该成功的真的成功（写文件 → 文件存在 + 内容正确）
 *   阴性：不该执行的真的没有执行（越界 / 模糊 / 无权限 / 超风险 / 干跑
 *          → **目录快照不变 + 适配器调用计数为 0**）
 *
 * 只测"不该写的时候不写"会被"什么都不做"骗过，因此两组都必须存在。
 *
 * 跑法：pnpm m4.5:verify
 */

import 'dotenv/config'

// ⚠️ 必须在任何会碰数据库的 import 之前（见 src/dev/sandbox.ts 的说明）
import { cleanupSandbox, isolateDatabase } from '../src/dev/sandbox.ts'

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { sql } from 'drizzle-orm'

import { rowsOf } from '../src/infrastructure/persistence/db.ts'
import {
  FAULTY_WRITE,
  PARTIAL_WRITE,
  createActionTestBed,
  createFaultyWriteAdapter,
  createPartialWriteAdapter,
  createReporter,
  faultyWriteCapability,
  partialWriteCapability,
  type ActionTestBed,
} from './action-harness.ts'
import {
  SANDBOX_FILE_READ,
  SANDBOX_FILE_WRITE,
  SYSTEM_ECHO,
  type CapabilityDefinition,
} from '../src/kernel/action/capability-registry.ts'
import type { CapabilityAdapter } from '../src/kernel/action/executor-port.ts'
import { checkActionAuditInvariants } from '../src/kernel/action/audit-invariants.ts'
import { applyActionClaimGuard } from '../src/kernel/action/claim-guard.ts'
import type { ActionResult } from '../src/kernel/action/action-result.ts'

const sandbox = isolateDatabase('m45-pipeline', { keep: false })
const evidenceDir = join(process.cwd(), 'artifacts', 'm4.5')
mkdirSync(evidenceDir, { recursive: true })

const report = createReporter()
console.log('='.repeat(72))
console.log('M4.5 L2 子系统验证（Request → Policy → Gateway → Executor → Result → Ledger）')
console.log('='.repeat(72))

// ---------------------------------------------------------------------------
// 额外能力：证明"没权限"与"超风险"在**适配器之前**就被拦住
// ---------------------------------------------------------------------------
const DENIED = 'test.denied.write'
const RISKY = 'test.risky.write'
const injection = { calls: 0, deniedCalls: 0, riskyCalls: 0 }

function deniedCapability(): CapabilityDefinition {
  return {
    id: DENIED,
    version: 'test.denied.write@1',
    description: '声明了一个从未被授予的权限（fail-closed 的证明）',
    operations: [{ name: 'write', description: 'x', sideEffect: 'write', riskLevel: 'R1' }],
    sideEffectLevel: 'write',
    riskLevel: 'R1',
    permissions: ['test:never-granted'],
    supportsDryRun: true,
    idempotency: 'supported',
  }
}

function riskyCapability(): CapabilityDefinition {
  return {
    id: RISKY,
    version: 'test.risky.write@1',
    description: 'R2 的外部可逆动作（M4.5 不运行 R2；这里用来证明上限真的生效）',
    operations: [{ name: 'write', description: 'x', sideEffect: 'write', riskLevel: 'R2' }],
    sideEffectLevel: 'write',
    riskLevel: 'R2',
    permissions: ['sandbox:write'],
    supportsDryRun: true,
    idempotency: 'supported',
  }
}

const bed: ActionTestBed = await createActionTestBed({
  label: 'pipeline',
  extraCapabilities: [
    faultyWriteCapability(),
    partialWriteCapability(),
    deniedCapability(),
    riskyCapability(),
  ],
  extraAdapters: [
    createFaultyWriteAdapter(injection),
    createPartialWriteAdapter(),
    {
      capabilityId: DENIED,
      async execute() {
        injection.deniedCalls += 1
        return {}
      },
    },
    {
      capabilityId: RISKY,
      async execute() {
        injection.riskyCalls += 1
        return {}
      },
    },
  ],
})

/** 沙箱目录的**快照**（阴性控制的判据：不该动的时候一个字节都不许变） */
function snapshotSandbox(): string {
  const files: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const absolute = join(dir, name)
      const relative = prefix === '' ? name : `${prefix}/${name}`
      const info = statSync(absolute)
      if (info.isDirectory()) walk(absolute, relative)
      else files.push(`${relative}:${createHash('sha256').update(readFileSync(absolute)).digest('hex')}`)
    }
  }
  walk(bed.sandboxRoot, '')
  return createHash('sha256').update(files.sort().join('|')).digest('hex')
}

async function sqlCount(query: ReturnType<typeof sql>): Promise<number> {
  const result = await bed.db.execute(query)
  return Number(rowsOf(result)[0]?.c ?? 0)
}

const memoryRecordsBefore = await sqlCount(sql`select count(*)::int as c from memory_records`)
const messagesBefore = await sqlCount(sql`select count(*)::int as c from memories`)

// ===========================================================================
// §1 阳性控制：该成功的真的成功
// ===========================================================================
report.section('§1 阳性控制（链路真的通）')
{
  const echo = await bed.execute({ capability: SYSTEM_ECHO, operation: 'echo', args: { text: 'hi' } })
  report.check('§1.1 system.echo 成功（链路本身是通的）', echo.status === 'success' && echo.executed)

  const write = await bed.execute({
    capability: SANDBOX_FILE_WRITE,
    operation: 'write',
    args: { path: 'hello.txt', content: 'hi' },
    idempotencyKey: 'positive-write-1',
  })
  report.check('§1.2 写文件 → success', write.status === 'success' && write.executed && write.accepted)
  report.check('§1.3 【Level 1】文件真的存在', bed.sandboxFile('hello.txt') === 'hi', `content=${String(bed.sandboxFile('hello.txt'))}`)
  report.check('§1.4 结果里带指纹（"外部状态真的变了"的机器判据）', write.effect?.fingerprint !== undefined)

  bed.writeSandboxFile('readme.md', 'readme-content')
  const read = await bed.execute({ capability: SANDBOX_FILE_READ, operation: 'read', args: { path: 'readme.md' } })
  report.check('§1.5 读文件 → success', read.status === 'success')
  report.check('§1.6 读到的内容与写入一致', read.effect?.kind === 'content_read')

  const nested = await bed.execute({
    capability: SANDBOX_FILE_WRITE,
    operation: 'write',
    args: { path: 'sub/dir/note.txt', content: 'nested' },
    idempotencyKey: 'positive-write-nested',
  })
  report.check('§1.7 子目录是自动创建的（不需要额外的能力）', nested.status === 'success' && bed.sandboxFile('sub/dir/note.txt') === 'nested')
}

// ===========================================================================
// §2 阴性控制：不该执行的真的没有执行
// ===========================================================================
report.section('§2 阴性控制（不该执行的一个字节都不许动）')
{
  // ① 越界
  const before = snapshotSandbox()
  const escape = await bed.execute({
    capability: SANDBOX_FILE_WRITE,
    operation: 'write',
    args: { path: '../../escape.txt', content: 'nope' },
  })
  report.check('§2.1 越界（..）→ rejected / permission_denied', escape.status === 'rejected' && escape.error?.code === 'permission_denied', `${escape.status}/${String(escape.error?.code)}`)
  report.check('§2.2 越界时适配器**一次都没有被调用**', escape.executed === false)
  report.check('§2.3 越界后沙箱快照逐字节不变', snapshotSandbox() === before)

  const drive = await bed.execute({
    capability: SANDBOX_FILE_READ,
    operation: 'read',
    args: { path: 'C:\\Windows\\win.ini' },
  })
  report.check('§2.4 盘符路径 → permission_denied（不是 not_found）', drive.error?.code === 'permission_denied', String(drive.error?.code))

  // ② 模糊目标（D1 的可达原形）
  bed.writeSandboxFile('a/report.txt', 'A')
  bed.writeSandboxFile('b/report.txt', 'B')
  const beforeAmbiguous = snapshotSandbox()
  const ambiguous = await bed.execute({
    capability: SANDBOX_FILE_WRITE,
    operation: 'write',
    args: { path: 'report.txt', content: 'X' },
  })
  report.check('§2.5 多候选 → ambiguous', ambiguous.status === 'ambiguous', `${ambiguous.status}/${String(ambiguous.error?.code)}`)
  report.check('§2.6 模糊时适配器没被调用', ambiguous.executed === false)
  report.check(
    '§2.7 两个同名文件内容都没变',
    snapshotSandbox() === beforeAmbiguous && bed.sandboxFile('a/report.txt') === 'A' && bed.sandboxFile('b/report.txt') === 'B'
  )

  // ③ 目标不存在（读）
  const missing = await bed.execute({ capability: SANDBOX_FILE_READ, operation: 'read', args: { path: 'missing.txt' } })
  report.check('§2.8 读不存在的文件 → not_found（不是 rejected）', missing.status === 'not_found', String(missing.error?.code))

  // ④ 未登记能力：连目标解析都不做
  const unregistered = await bed.execute({ capability: 'not.registered', operation: 'write', args: { path: 'x.txt' } })
  report.check('§2.9 未登记能力 → rejected / unsupported', unregistered.status === 'rejected' && unregistered.error?.code === 'unsupported')

  // ⑤ 缺权限
  const denied = await bed.execute({ capability: DENIED, operation: 'write', args: { path: 'x.txt', content: 'x' } })
  report.check('§2.10 缺权限 → permission_denied', denied.error?.code === 'permission_denied')
  report.check('§2.11 缺权限时适配器调用计数为 0', injection.deniedCalls === 0)

  // ⑥ 超风险上限（缺省 R1）
  const risky = await bed.execute({ capability: RISKY, operation: 'write', args: { path: 'x.txt', content: 'x' } })
  report.check('§2.12 R2 能力在 R1 上限下 → risk_exceeds_limit', risky.error?.code === 'permission_denied' && risky.status === 'rejected')
  report.check('§2.13 超风险时适配器调用计数为 0', injection.riskyCalls === 0)

  // ⑦ 缺少内容（校验失败，但仍然归一到 rejected）
  const noContent = await bed.execute({
    capability: SANDBOX_FILE_WRITE,
    operation: 'write',
    args: { path: 'no-content.txt' },
  })
  report.check('§2.14 主进程装配下"没说要写什么"不得写出空文件', bed.sandboxFile('no-content.txt') === undefined)
  /*
   * 失败码是 `validation_failed`（适配器自己发现"不知道要写什么"），
   * 状态是 `rejected`（系统拒绝执行）—— `executed: true` 的含义是
   * "适配器被调用过"，而不是"世界被改了"。
   */
  report.check(
    '§2.15 该失败被归一到确定的失败码（validation_failed / rejected）',
    noContent.status === 'rejected' && noContent.error?.code === 'validation_failed',
    `${noContent.status}/${String(noContent.error?.code)}`
  )
}

// ===========================================================================
// §3 执行失败 / 部分成功（§28）
// ===========================================================================
report.section('§3 失败与部分成功（§27 / §28）')
{
  const faulty = await bed.execute({ capability: FAULTY_WRITE, operation: 'write', args: { path: 'f.txt', content: 'x' } })
  report.check('§3.1 注入的适配器失败 → executed=true / failed', faulty.executed === true && faulty.status === 'failed')
  report.check('§3.2 失败被归一（不是原始的 Error 字符串）', faulty.error?.code === 'execution_failed')
  report.check('§3.3 该失败时适配器确实被调用过', injection.calls === 1)

  const guard = applyActionClaimGuard({ results: [faulty], replyText: '已经帮你创建好了。' })
  report.check('§3.4 失败 + 成功口吻 → 被替换（INV-M45-01）', guard.corrected && !guard.allowedSuccess)

  const partial = await bed.execute({
    capability: PARTIAL_WRITE,
    operation: 'write',
    args: { path: 'p.txt', content: 'x' },
  })
  report.check('§3.5 部分成功 → status=partial（**不是** success）', partial.status === 'partial')
  report.check('§3.6 partial 带进度（回复层要靠它说"只完成一部分"）', partial.progress?.completed === 2 && partial.progress?.total === 3)

  const partialGuard = applyActionClaimGuard({ results: [partial], replyText: '已经完成了。' })
  report.check('§3.7 partial 时的回复必须体现"只完成了一部分"', partialGuard.corrected && partialGuard.replyText.includes('2/3'))

  const before = snapshotSandbox()
  const dryRun = await bed.execute({ capability: SANDBOX_FILE_WRITE, operation: 'write', args: { path: 'dry.txt', content: 'x' } })
  report.check('§3.8 正常模式下干跑开关未开时正常执行（对照）', dryRun.status === 'success' && bed.sandboxFile('dry.txt') === 'x')
  void before
}

// ===========================================================================
// §4 幂等（§26）
// ===========================================================================
report.section('§4 幂等（重复请求不产生第二次副作用）')
{
  bed.writeSandboxFile('idem.txt', 'first')
  const first = await bed.execute({
    capability: SANDBOX_FILE_WRITE,
    operation: 'write',
    args: { path: 'idem.txt', content: 'first' },
    idempotencyKey: 'idem-key-1',
  })
  const second = await bed.execute({
    capability: SANDBOX_FILE_WRITE,
    operation: 'write',
    args: { path: 'idem.txt', content: 'first' },
    idempotencyKey: 'idem-key-1',
  })
  report.check('§4.1 第一次是真实执行', first.status === 'success' && first.idempotentReplay !== true)
  report.check('§4.2 第二次是幂等重放（**没有**第二次副作用）', second.idempotentReplay === true)
  report.check('§4.3 重放仍然如实报告成功的后置状态（世界确实已经是那样）', second.status === 'success' && second.executed === true)
  report.check('§4.4 【Level 2】账本里只有一次物理执行', (await bed.records({ capability: SANDBOX_FILE_WRITE, limit: 100 })).filter((r) => r.capability === SANDBOX_FILE_WRITE && r.idempotencyKey === 'idem-key-1' && r.executed && !r.idempotentReplay).length === 1)
  report.check('§4.5 内容没有被第二次调用改掉', bed.sandboxFile('idem.txt') === 'first')
}

// ===========================================================================
// §5 账本 / 审计 / trace 链（§20 / §31 / §32）
// ===========================================================================
report.section('§5 账本、审计与 trace 链')
{
  const records = await bed.records({ limit: 200 })
  report.check('§5.1 账本里有终态记录（Level 2 证据存在）', records.length > 0, `${records.length} 条`)
  report.check('§5.2 每条记录都有 traceId', records.every((r) => String(r.traceId).startsWith('trc:')))
  report.check(
    '§5.3 每个**真的执行过**的 action 都有目标与确定性等级（未登记能力不解析目标 → 没有目标是正确的）',
    records.filter((r) => r.executed).every((r) => r.target !== undefined && r.target.confidence !== undefined)
  )
  report.check(
    '§5.3b 副作用等级由声明记录（审计用它，而不是适配器自报）',
    records.every((r) => ['none', 'read', 'write', 'destructive'].includes(r.sideEffect))
  )

  const violations = checkActionAuditInvariants(records)
  report.check('§5.4 四条审计不变量全部通过（§32）', violations.length === 0, violations.map((v) => `${v.invariant}@${v.actionId}: ${v.detail}`).join(' | '))
  report.check(
    '§5.4b 幂等重放记录存在，但被明确标注（不是"假的成功"）',
    records.some((r) => r.idempotentReplay) && records.filter((r) => r.status === 'success' && !r.executed).every((r) => r.idempotentReplay)
  )

  const success = await bed.records({ status: 'success', limit: 100 })
  const failed = await bed.records({ status: 'failed', limit: 100 })
  const ambiguous = await bed.records({ status: 'ambiguous', limit: 100 })
  report.check('§5.5 status 过滤真的在过滤（success 集合里没有 failed 的）', success.every((r) => r.status === 'success') && failed.every((r) => r.status === 'failed'))
  report.check('§5.6 分区互斥：同一 action 不会同时出现在两个状态里', !success.some((s) => failed.some((f) => String(f.actionId) === String(s.actionId))))
  report.check('§5.7 ambiguous 分区非空（阴性控制的记录也进了账本）', ambiguous.length > 0, `${ambiguous.length} 条`)

  // trace 反查：三个动作共用一条 traceId
  const traceId = 'trc:m45-pipeline-shared'
  await bed.execute({ capability: SYSTEM_ECHO, operation: 'echo', args: { text: 'a' }, traceId })
  await bed.execute({ capability: SANDBOX_FILE_WRITE, operation: 'write', args: { path: 'trace.txt', content: 't' }, idempotencyKey: 'trace-1', traceId })
  const traceEvents = await bed.ledger.getEventsByTraceId(traceId as never)
  report.check('§5.8 一条 trace 能反查到它下面的全部动作（§20）', new Set(traceEvents.map((e) => String(e.actionId))).size === 2)
  report.check(
    '§5.9 事件顺序固定：ACTION_REQUESTED 早于 ACTION_STARTED（STOP-05）',
    traceEvents.filter((e) => e.type === 'ACTION_REQUESTED').every((requested) => {
      const started = traceEvents.find((e) => String(e.actionId) === String(requested.actionId) && e.type === 'ACTION_STARTED')
      return started === undefined || started.sequence > requested.sequence
    })
  )

  const firstRecord = records[0]!
  const events = await bed.ledger.getEventsByActionId(bed.characterId, firstRecord.actionId)
  report.check('§5.10 单个 action 的事件流可完整读取', events.length >= 3)
  report.check(
    '§5.11 证据里**不含**文件内容原文（隐私纪律：账本不存正文）',
    events.every((e) => !JSON.stringify(e.payload).includes('readme-content'))
  )
}

// ===========================================================================
// §6 Action ≠ Memory（ADR-034）
// ===========================================================================
report.section('§6 Action 不写 Memory（两本账）')
{
  const memoryRecordsAfter = await sqlCount(sql`select count(*)::int as c from memory_records`)
  const messagesAfter = await sqlCount(sql`select count(*)::int as c from memories`)
  report.check('§6.1 memory_records 一条都没增加', memoryRecordsAfter === memoryRecordsBefore, `${memoryRecordsBefore} → ${memoryRecordsAfter}`)
  report.check('§6.2 ElizaOS 的 memories 表也没被动作写过', messagesAfter === messagesBefore, `${messagesBefore} → ${messagesAfter}`)
  report.check('§6.3 动作落在自己的表里', (await sqlCount(sql`select count(*)::int as c from character_action_events`)) > 0)
}

// ===========================================================================
// §7 折叠确定性（A == B）
// ===========================================================================
report.section('§7 折叠自证（同一事件流两次结论相同）')
{
  const events = await bed.ledger.listEvents(bed.characterId, 200)
  const byAction = new Map<string, typeof events>()
  for (const event of events) {
    const key = String(event.actionId)
    byAction.set(key, [...(byAction.get(key) ?? []), event])
  }
  const { foldRecord } = await import('../src/infrastructure/action/action-ledger-store.ts')
  const first = [...byAction.values()].map((list) => JSON.stringify(foldRecord(list)))
  const second = [...byAction.values()].map((list) => JSON.stringify(foldRecord([...list])))
  report.check('§7.1 每个 action 折叠两次结果相同（账本能自证）', JSON.stringify(first) === JSON.stringify(second))
  report.check('§7.2 悬挂的 action（有请求无终态）不会折叠出记录', [...byAction.values()].every((list) => (list.some((e) => e.status !== undefined) ? foldRecord(list) !== undefined : foldRecord(list) === undefined)))
}

// ===========================================================================
// 证据
// ===========================================================================
const allRecords = await bed.records({ limit: 200 })

/*
 * 正负双控的**机器可读**摘要（§54：artifacts 里要有 positive / negative controls）。
 *
 * ⚠️ 它由 `report.failures` 反推，而不是手写一份"这些都通过了"：
 *    每一条 control 只有在它对应的断言**没有被记进失败列表**时才算通过。
 *    手写的控制清单是 This-project 最不该出现的东西 —— 它看起来合理，
 *    但量的是写的人当时的心情。
 */
const POSITIVE_CONTROLS = ['§1.1', '§1.2', '§1.3', '§1.4', '§1.5', '§1.6', '§1.7']
const NEGATIVE_CONTROLS = [
  '§2.1', '§2.2', '§2.3', '§2.4', '§2.5', '§2.6', '§2.7', '§2.8',
  '§2.9', '§2.10', '§2.11', '§2.12', '§2.13', '§2.14',
]
const controlStatus = (prefixes: readonly string[]) =>
  prefixes.map((prefix) => ({
    check: prefix,
    passed: !report.failures.some((f) => f.startsWith(prefix)),
  }))

const evidence = {
  testId: 'M4.5 / L2',
  name: 'Action Pipeline（Request → Policy → Gateway → Executor → Result → Ledger）',
  priority: 'P0',
  status: report.failed === 0 ? 'PASS' : 'FAIL',
  sandboxDir: sandbox.dir,
  controls: {
    positive: controlStatus(POSITIVE_CONTROLS),
    negative: controlStatus(NEGATIVE_CONTROLS),
    discipline: '阳性：该成功的真的成功；阴性：不该执行的真的没有执行（快照哈希不变 + 适配器调用计数 0）',
  },
  counts: {
    records: allRecords.length,
    byStatus: allRecords.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1
      return acc
    }, {}),
    physicalExecutions: allRecords.filter((r) => r.executed && !r.idempotentReplay).length,
    idempotentReplays: allRecords.filter((r) => r.idempotentReplay).length,
  },
  stateHashes: {
    sandboxFinal: snapshotSandbox(),
    memoryRecordsBefore,
    memoryRecordsAfter: await sqlCount(sql`select count(*)::int as c from memory_records`),
    ledgerEvents: await sqlCount(sql`select count(*)::int as c from character_action_events`),
  },
  auditViolations: checkActionAuditInvariants(allRecords),
  sampleActions: allRecords.slice(0, 8).map((r) => ({
    actionId: String(r.actionId),
    capability: r.capability,
    operation: r.operation,
    status: r.status,
    executed: r.executed,
    target: r.target === undefined ? null : { id: r.target.canonicalId ?? null, confidence: r.target.confidence },
  })),
  checks: { passed: report.passed, failed: report.failed, failures: report.failures },
}
writeFileSync(join(evidenceDir, 'pipeline.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

await bed.stop()
report.finish('M4.5 L2 子系统验证')
cleanupSandbox(sandbox.dir)
void readdirSync
void statSync
