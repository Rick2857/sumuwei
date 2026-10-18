/** Real isolated workers only; no database, model calls or production files. */
import assert from 'node:assert/strict'
import { createMathCalculateAdapter, type MathCalculateOptions } from '../src/infrastructure/action/adapters/math-calculate.ts'
import { ActionFailureError } from '../src/kernel/action/errors.ts'
import type { AdapterExecuteInput } from '../src/kernel/action/executor-port.ts'
import type { ActionId } from '../src/kernel/contracts/ids.ts'

let checks = 0
async function calculate(expression: string, options: MathCalculateOptions = {}) {
  const input: AdapterExecuteInput = {
    actionId: 'math-startup-check' as ActionId, operation: 'evaluate', args: { expression },
    target: { type: 'math_executor', canonicalId: 'restricted', confidence: 'exact' }, now: Date.now,
  }
  const result = await createMathCalculateAdapter(options).execute(input)
  const content = result.turnContent?.find(item => item.kind === 'calculation')
  assert.ok(content?.kind === 'calculation')
  return content.value
}
async function check(label: string, run: () => Promise<void>) {
  const started = Date.now()
  await run()
  checks++
  console.log(JSON.stringify({ label, ok: true, ms: Date.now() - started }))
}
await check('default cold startup + exact arithmetic', async () => {
  assert.equal(await calculate('2+3*4'), '14')
  assert.equal(await calculate('0.1+0.2'), '0.3')
  assert.equal(await calculate('9007199254740993+1'), '9007199254740994')
})
await check('startup deadline terminates worker', async () => {
  await assert.rejects(calculate('2+3*4', { startupTimeoutMs: 1 }), error =>
    error instanceof ActionFailureError && error.failure.code === 'timeout' && error.message.includes('启动'))
})
await check('evaluation deadline still terminates worker', async () => {
  await assert.rejects(calculate('2^999', { timeoutMs: 1 }), error =>
    error instanceof ActionFailureError && error.failure.code === 'timeout' && !error.message.includes('启动'))
})
await check('AST and finite-result guards remain active', async () => {
  for (const expression of ['import("node:fs")', '1/0']) {
    await assert.rejects(calculate(expression), error =>
      error instanceof ActionFailureError && error.failure.code === 'validation_failed')
  }
})
await check('subsequent call recovers after timeouts', async () => {
  assert.equal(await calculate('12*12'), '144')
})
assert.ok(checks > 0)
console.log(JSON.stringify({ checks, pass: true }))
