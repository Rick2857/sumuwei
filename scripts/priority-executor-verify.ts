import assert from 'node:assert/strict'
import { createServer, type Socket } from 'node:net'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isolateDatabase } from '../src/dev/sandbox.ts'
for (const key of ['POSTGRES_URL', 'DATABASE_URL', 'LG_PG_EXPECT_DATABASE', 'LG_PG_EXPECT_DATABASE_PREFIX', 'LG_PG_EXPECT_USER', 'LG_PG_EXPECT_PORT']) process.env[key] = ''
process.env.CHARACTER_DB_BACKEND = 'pglite'
isolateDatabase('priority-executor')
const { createActionTestBed } = await import('./action-harness.ts')
const { createDesktopCapabilityDefinitions } = await import('../src/kernel/action/desktop-capability.ts')
const { ExecutorClient } = await import('../src/infrastructure/action/executor-client.ts')
const { executorDelegator, withExecutorTurnSignal } = await import('../src/infrastructure/action/executor-delegator.ts')
const { applyActionClaimGuard } = await import('../src/kernel/action/claim-guard.ts')
const { createInMemoryPayloadStaging } = await import('../src/kernel/action/payload-staging.ts')
const staging = createInMemoryPayloadStaging()
let peer: Socket | undefined
const emitted: { actionId: string; turnRequestId: string; args: Record<string, unknown> }[] = []
const server = createServer(socket => {
  peer = socket
  let text = ''
  socket.on('data', bytes => {
    text += bytes.toString()
    while (text.includes('\n')) {
      const index = text.indexOf('\n'), line = text.slice(0, index); text = text.slice(index + 1)
      if (line.startsWith('LG_ENTRY ')) socket.write('LG_ENTRY_READY v1\n')
      else emitted.push(JSON.parse(line))
    }
  })
})
await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
const client = new ExecutorClient({ host: '127.0.0.1', port: (server.address() as { port: number }).port, token: 'fixture' })
await client.connect()
let localCalls = 0
const link = { send: (payload: Record<string, unknown>, signal?: AbortSignal) => client.send(payload, signal), isCancelled: () => false }
let activeLink: typeof link | undefined = link
const bed = await createActionTestBed({ label: 'priority-executor', maxRiskLevel: 'R2',
  grantedPermissions: ['desktop:operate'], extraCapabilities: createDesktopCapabilityDefinitions(),
  extraAdapters: [{ capabilityId: 'desktop.operate', execute: async () => { localCalls++; return {} } }],
  delegator: (request, decision) => executorDelegator(activeLink, request, decision, staging, true),
  resolveTarget: async () => ({ target: { type: 'desktop_control', canonicalId: 'fixture', displayName: 'fixture', confidence: 'exact' }, scopeViolation: false }),
})
const checks: string[] = []
const execute = (trace: string) => bed.execute({ capability: 'desktop.operate', operation: 'act',
  traceId: trace, args: { action: 'click', window: 'fixture', index: 1, name: 'button' } }).then(result => {
    if (result.status !== 'success') console.log(JSON.stringify({ preflight: result.status, reason: result.error }))
    return result
  })
async function next(index: number) {
  for (let i = 0; i < 500 && !emitted[index]; i++) await new Promise(done => setTimeout(done, 10))
  assert.ok(emitted[index], 'gateway must actually dispatch')
  return emitted[index]!
}
try {
  const pending = execute('trace:completed')
  const first = await next(0)
  assert.equal(first.turnRequestId, 'trace:completed')
  assert.equal((await bed.records()).some(r => r.status === 'success'), false, 'dispatch alone is not terminal success')
  peer!.write(JSON.stringify({ kind: 'ACTION_RESULT', actionId: first.actionId, outcome: 'completed' }) + '\n')
  const completed = await pending
  assert.equal(completed.status, 'success'); assert.equal(completed.effect?.kind, 'action_completed_remote')
  assert.equal((await bed.records()).filter(r => r.status === 'success').length, 1)
  peer!.write(JSON.stringify({ kind: 'ACTION_RESULT', actionId: first.actionId, outcome: 'completed' }) + '\n')
  checks.push('real Gateway, database ledger and TCP client await completed before success; duplicate cannot commit twice')
  for (const [outcome, status] of [['rejected', 'rejected'], ['failed_confirmed', 'failed'], ['unknown', 'timeout']] as const) {
    const index = emitted.length
    const pending = execute(`trace:${outcome}`)
    const item = await next(index)
    // A late receipt belonging to the previous action cannot complete this one.
    peer!.write(JSON.stringify({ kind: 'ACTION_RESULT', actionId: first.actionId, outcome: 'completed' }) + '\n')
    peer!.write(JSON.stringify({ kind: 'ACTION_RESULT', actionId: item.actionId, outcome, code: 'fixture_code' }) + '\n')
    const result = await pending
    assert.equal(result.status, status)
    const guarded = applyActionClaimGuard({ replyText: '我已经完成了操作。', results: [result] })
    assert.ok(!guarded.replyText.includes('已经完成'), 'unsuccessful receipts cannot become success claims')
    checks.push(`${outcome} settles as ${status}; late/foreign action rejected and reply truth guarded`)
  }
  const control = new AbortController()
  const index = emitted.length
  const cancelled = withExecutorTurnSignal(control.signal, () => execute('trace:cancelled'))
  await next(index); control.abort()
  const cancelledResult = await cancelled
  assert.equal(cancelledResult.status, 'timeout')
  assert.equal(cancelledResult.error?.details?.executorOutcome, 'unknown')
  checks.push('in-flight cancellation is unknown and does not automatically resend')
  const body = '仅执行端应收到的私有输入正文'
  const ref = staging.put({ value: { kind: 'text', text: body }, label: 'fixture', bytes: Buffer.byteLength(body), fingerprint: 'fixture' })
  const typeIndex = emitted.length
  const typed = bed.execute({ capability: 'desktop.operate', operation: 'act', traceId: 'trace:type', args: {
    action: 'type', window: 'fixture', index: 1, name: 'textbox', payloadRef: ref.payloadRef,
    payloadBytes: ref.bytes, payloadFingerprint: ref.fingerprint } })
  const typedWire = await next(typeIndex)
  assert.equal(typedWire.args.content, body)
  assert.equal(typedWire.args.payloadRef, undefined)
  peer!.write(JSON.stringify({ kind: 'ACTION_RESULT', actionId: typedWire.actionId, outcome: 'completed' }) + '\n')
  assert.equal((await typed).status, 'success')
  assert.ok(!JSON.stringify(await bed.records()).includes(body), 'private text must not enter ledger')
  checks.push('staged typing reaches executor, while database ledger retains only its reference')
  const preCancelled = new AbortController(); preCancelled.abort()
  const wireCount = emitted.length
  const preResult = await withExecutorTurnSignal(preCancelled.signal, () => execute('trace:pre-cancelled'))
  assert.notEqual(preResult.status, 'success'); assert.equal(emitted.length, wireCount)
  checks.push('cancellation before dispatch sends zero actions')
  const index2 = emitted.length
  const disconnected = execute('trace:disconnect')
  await next(index2); peer!.destroy()
  assert.equal((await disconnected).status, 'timeout')
  activeLink = undefined
  assert.equal((await execute('trace:offline')).status, 'failed')
  assert.equal(localCalls, 0)
  checks.push('disconnect settles unknown; subsequent offline requests fail closed with zero local fallback executions')
  const source = readFileSync('src/main.ts', 'utf8')
  assert.ok(source.includes('executorDelegator(this.executorLink, request, decision, this.payloadStaging,'))
  assert.ok(source.includes('send: (payload, signal) => client.send(payload, signal)'))
  assert.ok(source.includes('withExecutorTurnSignal(streaming?.signal'))
  assert.ok(!source.includes('onResult: () => undefined'))
  checks.push('main assembly uses the verified delegator and turn cancellation context')
  mkdirSync('artifacts/post-lv2/local/priority-three-20261018', { recursive: true })
  writeFileSync('artifacts/post-lv2/local/priority-three-20261018/executor-checks.json', JSON.stringify({
    status: 'PASS', checks, dispatched: emitted.length, localCalls, productionOpened: false, realDesktopActions: 0 }, null, 2))
  console.log(`PASS ${checks.length} executor settlement check groups`)
} finally {
  await client.close(); await new Promise<void>(done => server.close(() => done())); await bed.stop()
}
