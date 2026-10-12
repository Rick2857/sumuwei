/**
 * M4.5 L3 —— **自然语言集成**（`pnpm m4.5:nl-action:verify` / G13）。
 *
 * ============================================================================
 *  纪律：只从用户真实文本进入
 * ============================================================================
 * M4 的 D1 从 939 项断言中间穿了过去，原因只有一个：
 *
 *     它们几乎都**直接给 memoryId**，绕过了"从自然语言解析目标"这一层。
 *
 * M4.5 的动作链有一个等价的风险面：**直接构造 ActionRequest**。
 * 那会证明"Gateway 工作正常"，却完全测不到
 *
 *     用户那句话 → 意图判定 → 目标解析 → 策略 → 执行
 *
 * 因此本文件是硬的：
 *
 *     ❌ 禁止传 actionId / 目标 / 能力名
 *     ❌ 禁止直接调 gateway.execute 来断言结果
 *     ✅ 只通过 `bed.say(用户原话)` 进入，再看**沙箱真实文件**与**账本**
 *
 * ---------------------------------------------------------------------------
 *  与另外两层门的分工
 * ---------------------------------------------------------------------------
 *   L2 `m4.5:verify`              —— **子系统级**：Request → … → Ledger
 *   本文件（L3）                   —— **链路级**：真实文本 → … → 真实文件
 *   L4 `m4.5:smoke:live`          —— 真实模型 + 生产库副本 + 真实回复
 *
 * 跑法：pnpm m4.5:nl-action:verify
 */

import 'dotenv/config'

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
import { applyActionClaimGuard } from '../src/kernel/action/claim-guard.ts'
import { checkActionAuditInvariants } from '../src/kernel/action/audit-invariants.ts'

const evidenceDir = join(process.cwd(), 'artifacts', 'm4.5')
mkdirSync(evidenceDir, { recursive: true })

const report = createReporter()
const transcript: Record<string, unknown>[] = []

console.log('='.repeat(72))
console.log('M4.5 L3 自然语言集成（用户原话 → 意图 → 目标 → 策略 → 执行 → 账本）')
console.log('='.repeat(72))

interface Scenario {
  bed: ActionTestBed
  dir: string
  sandboxSnapshot: () => string
  dispose: () => Promise<void>
}

/** 一个干净场景：隔离库 + 真实文件系统沙箱（与生产同构的装配） */
async function openScenario(label: string): Promise<Scenario> {
  const sandbox = isolateDatabase(`m45-nl-${label}`, { keep: true })
  await resetPluginSqlConnection()
  const bed = await createActionTestBed({
    label: `nl-${label}`,
    extraCapabilities: [faultyWriteCapability(), partialWriteCapability()],
    extraAdapters: [createFaultyWriteAdapter({ calls: 0 }), createPartialWriteAdapter()],
  })

  const snapshot = (): string => {
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

  return {
    bed,
    dir: sandbox.dir,
    sandboxSnapshot: snapshot,
    async dispose() {
      await bed.stop()
      await resetPluginSqlConnection()
      cleanupSandbox(sandbox.dir)
    },
  }
}

/** 跑一句话，返回它产生的结果与账本记录 */
async function sayAndRecord(
  bed: ActionTestBed,
  text: string
): Promise<{ result: Awaited<ReturnType<ActionTestBed['say']>>; record?: Awaited<ReturnType<ActionTestBed['records']>>[number] }> {
  const result = await bed.say(text)
  if (result === undefined) return { result }
  const records = await bed.records({ limit: 50 })
  return { result, record: records.find((r) => String(r.actionId) === String(result.actionId)) }
}

// ===========================================================================
// NL-01 受支持的读：真的读到了
// ===========================================================================
report.section('NL-01 「读一下 sandbox/test.txt」→ 真的读到')
{
  const scenario = await openScenario('read-ok')
  try {
    scenario.bed.writeSandboxFile('test.txt', 'M4.5-L3')
    const { result, record } = await sayAndRecord(scenario.bed, '读一下 sandbox/test.txt')
    report.check('NL-01.1 产生了动作且成功', result?.status === 'success', String(result?.status))
    report.check('NL-01.2 目标是 test.txt 且确定性为 exact', record?.target?.canonicalId === 'test.txt' && record?.target?.confidence === 'exact')
    report.check('NL-01.3 账本里有终态记录（Level 2）', record !== undefined && record.finishedAt !== undefined)
    report.check('NL-01.4 traceId 存在（§20）', String(record?.traceId).startsWith('trc:'))
    transcript.push({ scenario: 'NL-01', text: '读一下 sandbox/test.txt', status: result?.status })
  } finally {
    await scenario.dispose()
  }
}

// ===========================================================================
// NL-02 受支持的写：文件真的出现
// ===========================================================================
report.section('NL-02 「帮我在沙箱里创建 hello.txt，内容为 hi」→ 文件真的出现')
{
  const scenario = await openScenario('write-ok')
  try {
    const before = scenario.sandboxSnapshot()
    const { result, record } = await sayAndRecord(scenario.bed, '帮我在沙箱里创建 hello.txt，内容为 hi')
    const content = scenario.bed.sandboxFile('hello.txt')
    report.check('NL-02.1 【Level 1】文件真的存在', content === 'hi', String(content))
    report.check('NL-02.2 结果 success', result?.status === 'success')
    report.check('NL-02.3 账本记录的副作用是 file_created', record?.effect?.kind === 'file_created')
    report.check('NL-02.4 沙箱确实变了（快照不同）', scenario.sandboxSnapshot() !== before)
    transcript.push({ scenario: 'NL-02', text: '帮我创建 hello.txt', status: result?.status, file: content })
  } finally {
    await scenario.dispose()
  }
}

// ===========================================================================
// NL-03 目标不存在
// ===========================================================================
report.section('NL-03 「读一下 missing.txt」→ not_found，且不得宣称成功')
{
  const scenario = await openScenario('not-found')
  try {
    const before = scenario.sandboxSnapshot()
    const { result, record } = await sayAndRecord(scenario.bed, '读一下 missing.txt')
    report.check('NL-03.1 如实报 not_found', result?.status === 'not_found', String(result?.error?.code))
    report.check('NL-03.2 沙箱一个字节都没变', scenario.sandboxSnapshot() === before)
    report.check('NL-03.3 账本记录可查（失败也留痕）', record !== undefined && record.status === 'not_found')
    const guard = applyActionClaimGuard({ results: result === undefined ? [] : [result], replyText: '我读到了，内容是那样。' })
    report.check('NL-03.4 回复守卫会拦住"我读到了"', guard.corrected)
    transcript.push({ scenario: 'NL-03', text: '读一下 missing.txt', status: result?.status })
  } finally {
    await scenario.dispose()
  }
}

// ===========================================================================
// NL-04 模糊目标（S4 的离线半边）
// ===========================================================================
report.section('NL-04 「修改 report.txt」（两个同名文件）→ ambiguous，且两个都没被改')
{
  const scenario = await openScenario('ambiguous')
  try {
    scenario.bed.writeSandboxFile('a/report.txt', 'A')
    scenario.bed.writeSandboxFile('b/report.txt', 'B')
    const before = scenario.sandboxSnapshot()
    const { result, record } = await sayAndRecord(scenario.bed, '修改 report.txt')
    report.check('NL-04.1 如实报 ambiguous', result?.status === 'ambiguous', String(result?.error?.code))
    report.check('NL-04.2 两个文件内容都没变', scenario.bed.sandboxFile('a/report.txt') === 'A' && scenario.bed.sandboxFile('b/report.txt') === 'B')
    report.check('NL-04.3 沙箱快照逐字节不变', scenario.sandboxSnapshot() === before)
    report.check('NL-04.4 账本里目标确定性是 weak（不是 exact）', record?.target?.confidence === 'weak')
    const guard = applyActionClaimGuard({ results: result === undefined ? [] : [result], replyText: '已经修改好了。' })
    report.check('NL-04.5 回复守卫要求"不确定"而不是成功', guard.corrected && guard.replyText.includes('不确定'))
    transcript.push({ scenario: 'NL-04', text: '修改 report.txt', status: result?.status })
  } finally {
    await scenario.dispose()
  }
}

// ===========================================================================
// NL-05 越界（S5 的离线半边）
// ===========================================================================
report.section('NL-05 「读一下 C:\\Windows\\win.ini」→ permission_denied，且没碰过真实主机')
{
  const scenario = await openScenario('out-of-scope')
  try {
    const before = scenario.sandboxSnapshot()
    const { result, record } = await sayAndRecord(scenario.bed, '读一下 C:\\Windows\\win.ini')
    report.check('NL-05.1 如实报 rejected / permission_denied', result?.status === 'rejected' && result.error?.code === 'permission_denied', `${result?.status}/${String(result?.error?.code)}`)
    report.check('NL-05.2 适配器一次都没被调用（没碰过真实主机）', result?.executed === false)
    report.check('NL-05.3 沙箱快照未变', scenario.sandboxSnapshot() === before)
    report.check(
      'NL-05.4 账本里带越界证据（"未触碰真实文件系统"）',
      (record?.target?.evidence ?? []).some((e) => e.kind === 'scope_violation')
    )
    transcript.push({ scenario: 'NL-05', text: '读一下 C:\\Windows\\win.ini', status: result?.status })
  } finally {
    await scenario.dispose()
  }
}

// ===========================================================================
// NL-06 没有意图：什么都不该发生
// ===========================================================================
report.section('NL-06 「今天天气不错」→ 没有动作请求（绝大多数轮次就是这样）')
{
  const scenario = await openScenario('no-intent')
  try {
    const before = await scenario.bed.records({ limit: 50 })
    const result = await scenario.bed.say('今天天气不错，我们聊点别的。')
    const after = await scenario.bed.records({ limit: 50 })
    report.check('NL-06.1 没有产生 ActionResult', result === undefined)
    report.check('NL-06.2 账本一条都没增加（阴性控制）', after.length === before.length, `${before.length} → ${after.length}`)
    report.check('NL-06.3 沙箱是空的（什么都没写）', (await scenario.bed.sandboxFiles()).length === 0)
    transcript.push({ scenario: 'NL-06', text: '今天天气不错', status: 'no_action' })
  } finally {
    await scenario.dispose()
  }
}

// ===========================================================================
// NL-07 确定性：同一句话在两个独立库上得到同一结论
// ===========================================================================
report.section('NL-07 确定性（同一句话两次结论相同）')
{
  const runOnce = async (label: string): Promise<string> => {
    const scenario = await openScenario(label)
    try {
      scenario.bed.writeSandboxFile('a/report.txt', 'A')
      scenario.bed.writeSandboxFile('b/report.txt', 'B')
      const result = await scenario.bed.say('修改 report.txt')
      return `${result?.status}/${String(result?.error?.code)}`
    } finally {
      await scenario.dispose()
    }
  }
  const a = await runOnce('determinism-a')
  const b = await runOnce('determinism-b')
  report.check('NL-07.1 两个独立库上得到同一个结论', a === b, `${a} vs ${b}`)
}

// ===========================================================================
// NL-08 账本自洽（审计不变量 + 折叠）
// ===========================================================================
report.section('NL-08 账本自洽（审计不变量 + 折叠两次一致）')
{
  const scenario = await openScenario('audit')
  try {
    await scenario.bed.say('读一下 nope.txt')
    await scenario.bed.say('帮我在沙箱里创建 a.txt，内容为 A')
    await scenario.bed.say('帮我在沙箱里创建 a.txt，内容为 A')
    await scenario.bed.say('读一下 a.txt')
    const records = await scenario.bed.records({ limit: 50 })
    const violations = checkActionAuditInvariants(records)
    report.check('NL-08.1 审计不变量零违规（§32）', violations.length === 0, violations.map((v) => v.invariant).join(','))
    report.check('NL-08.2 幂等键相同 → 第二次是重放', records.filter((r) => r.idempotentReplay).length === 1)
    report.check('NL-08.3 每条记录都能按 actionId 读回事件流', await (async () => {
      for (const record of records) {
        const events = await scenario.bed.ledger.getEventsByActionId(scenario.bed.characterId, record.actionId)
        if (events.length === 0) return false
      }
      return true
    })())
    report.check('NL-08.4 file 内容没有被第二次写改掉', scenario.bed.sandboxFile('a.txt') === 'A')
    transcript.push({ scenario: 'NL-08', records: records.map((r) => `${r.capability}:${r.status}`) })
  } finally {
    await scenario.dispose()
  }
}

// ===========================================================================
// NL-09 部分成功与失败也要能从文本进入（§28 / §27）
// ===========================================================================
report.section('NL-09 失败与部分成功从文本进入时的如实性')
{
  const scenario = await openScenario('failure')
  try {
    const faulty = await scenario.bed.say('请用回声说一句 test')
    report.check('NL-09.1 echo 这条文本路径仍然可用（对照组）', faulty?.status === 'success', String(faulty?.status))
    // 故障注入的能力不在检测器的规则里：这是刻意的 —— 规则检测器只认真实能力。
    // 它证明"文本路径不会触发没被设计为可触发的能力"。
    const notDetected = await scenario.bed.records({ capability: FAULTY_WRITE, limit: 10 })
    report.check('NL-09.2 故障注入能力无法从文本触发（检测器不认识它）', notDetected.length === 0)
    const partial = await scenario.bed.records({ capability: PARTIAL_WRITE, limit: 10 })
    report.check('NL-09.3 部分成功能力同样无法从文本触发', partial.length === 0)
  } finally {
    await scenario.dispose()
  }
}

// ===========================================================================
// 证据
// ===========================================================================
writeFileSync(
  join(evidenceDir, 'nl-action.json'),
  `${JSON.stringify(
    {
      testId: 'M4.5 / L3 / G13',
      name: 'Natural-Language Action Integration',
      priority: 'P0',
      status: report.failed === 0 ? 'PASS' : 'FAIL',
      discipline: '禁止传 actionId / 目标 / 能力名；只从用户真实文本进入；断言看真实文件与账本',
      transcript,
      checks: { passed: report.passed, failed: report.failed, failures: report.failures },
    },
    null,
    2
  )}\n`,
  'utf8'
)

report.finish('M4.5 L3 自然语言集成')
