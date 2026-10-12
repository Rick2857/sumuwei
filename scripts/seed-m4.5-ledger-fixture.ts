/**
 * M4.5 L0 —— 量具 fixture 播种器（**子进程**）。
 *
 * ============================================================================
 *  为什么它必须是一个独立进程
 * ============================================================================
 * PGlite 是嵌入式 Postgres，**同一个数据目录不能被两个进程同时打开**。
 * 而 L0 要验证的是"生产 CLI 的 --status 过滤是不是真的只返回那个状态" ——
 * 那就必须让 CLI 进程独占那个库。
 *
 * 因此分工是：
 *
 *   本文件（子进程）  开库 → 通过**生产端口**造出七种终态 → 关库 → 写 fixture.json
 *   L0 主进程        只编排：先跑本文件，再跑一串 CLI，最后比对输出
 *
 * 主进程**从不打开数据库**，因此不存在锁竞争。
 *
 * ⚠️ fixture 不是手写 SQL 塞进去的：它走的是 `ExecutionLedgerPort` 的
 *    具名写入（与生产同一条路径）。手写 SQL 造出来的"状态"可能根本
 *    不是系统会产生的形状，那样的量具验证毫无意义。
 */

import 'dotenv/config'

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import {
  FAULTY_WRITE,
  PARTIAL_WRITE,
  createActionTestBed,
  createFaultyWriteAdapter,
  createPartialWriteAdapter,
  faultyWriteCapability,
  partialWriteCapability,
} from './action-harness.ts'
import { SANDBOX_FILE_WRITE, SYSTEM_ECHO } from '../src/kernel/action/capability-registry.ts'
import { createActionRequest } from '../src/kernel/action/action-request.ts'
import { newActionId, asTraceId } from '../src/kernel/contracts/ids.ts'

const sandboxDir = process.env.PGLITE_DATA_DIR
if (sandboxDir === undefined || sandboxDir.trim() === '') {
  console.error('seed-m4.5-ledger-fixture：必须由父进程通过 PGLITE_DATA_DIR 指定隔离目录')
  process.exit(2)
}

const marker = join(sandboxDir, 'm45-fixture.json')
if (existsSync(marker)) {
  // 幂等：同一个目录再跑一次不会产生第二份 fixture
  console.log(readFileSync(marker, 'utf8'))
  process.exit(0)
}

const injection = { calls: 0 }
const bed = await createActionTestBed({
  label: 'measurement-fixture',
  extraCapabilities: [faultyWriteCapability(), partialWriteCapability()],
  extraAdapters: [createFaultyWriteAdapter(injection), createPartialWriteAdapter()],
})

const expected: Record<string, string[]> = {
  success: [],
  failed: [],
  partial: [],
  rejected: [],
  ambiguous: [],
  not_found: [],
  cancelled: [],
}

function record(status: string, actionId: string): void {
  expected[status]!.push(String(actionId))
}

// ① success（真实写入）
{
  const result = await bed.execute({
    capability: SANDBOX_FILE_WRITE,
    operation: 'write',
    args: { path: 'ok.txt', content: 'ok' },
    idempotencyKey: 'fixture-success',
  })
  record(result.status, String(result.actionId))
}

// ② success（无副作用能力：同样是 success，但不应被当成"改了世界"）
{
  const result = await bed.execute({ capability: SYSTEM_ECHO, operation: 'echo', args: { text: 'x' } })
  record(result.status, String(result.actionId))
}

// ③ failed（注入失败）
{
  const result = await bed.execute({
    capability: FAULTY_WRITE,
    operation: 'write',
    args: { path: 'fail.txt', content: 'x' },
  })
  record(result.status, String(result.actionId))
}

// ④ partial
{
  const result = await bed.execute({
    capability: PARTIAL_WRITE,
    operation: 'write',
    args: { path: 'partial.txt', content: 'x' },
  })
  record(result.status, String(result.actionId))
}

// ⑤ rejected（越界）
{
  const result = await bed.execute({
    capability: SANDBOX_FILE_WRITE,
    operation: 'write',
    args: { path: '../escape.txt', content: 'x' },
  })
  record(result.status, String(result.actionId))
}

// ⑥ ambiguous（多候选）
{
  bed.writeSandboxFile('a/dup.txt', 'A')
  bed.writeSandboxFile('b/dup.txt', 'B')
  const result = await bed.execute({
    capability: SANDBOX_FILE_WRITE,
    operation: 'write',
    args: { path: 'dup.txt', content: 'x' },
  })
  record(result.status, String(result.actionId))
}

// ⑦ not_found（读不存在的文件）
{
  const result = await bed.execute({
    capability: 'sandbox.file.read',
    operation: 'read',
    args: { path: 'missing.txt' },
  })
  record(result.status, String(result.actionId))
}

// ⑧ cancelled（走端口的具名写入；M4.5 的 CLI 没有取消入口，但状态必须可表示）
{
  const request = createActionRequest({
    actionId: newActionId(),
    traceId: asTraceId('trc:fixture-cancelled'),
    capability: SANDBOX_FILE_WRITE,
    operation: 'write',
    requestedBy: { kind: 'user', id: 'user-fixture' },
    arguments: { path: 'cancelled.txt' },
    sideEffect: 'write',
  })
  await bed.ledger.appendRequested({ characterId: bed.characterId, request })
  await bed.ledger.appendCancelled({
    characterId: bed.characterId,
    request,
    target: { type: 'sandbox_file', canonicalId: 'cancelled.txt', confidence: 'exact' },
  })
  record('cancelled', String(request.actionId))
}

const records = await bed.records({ limit: 100 })
const traceId = String(records.find((r) => r.idempotencyKey === 'fixture-success')?.traceId ?? '')

writeFileSync(
  marker,
  `${JSON.stringify(
    {
      expected,
      total: records.length,
      traceId,
      byStatus: records.reduce<Record<string, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1
        return acc
      }, {}),
    },
    null,
    2
  )}\n`,
  'utf8'
)

await bed.stop()
await resetPluginSqlConnection()
console.log(readFileSync(marker, 'utf8'))
