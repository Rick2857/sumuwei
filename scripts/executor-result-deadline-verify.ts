import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { ExecutorClient } from '../src/infrastructure/action/executor-client.ts'

const server = createServer(socket => socket.on('data', data => {
  if (data.toString().startsWith('LG_ENTRY ')) socket.write('LG_ENTRY_READY v1\n')
}))
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const client = new ExecutorClient({ host: '127.0.0.1', port: (server.address() as { port: number }).port,
  token: 'fixture', onResult: () => undefined })
try {
  await client.connect()
  const result = await Promise.race([
    client.send({ actionId: 'silent', timeoutMs: 30 }),
    new Promise<null>(resolve => setTimeout(() => resolve(null), 200)),
  ])
  assert.ok(result, 'authenticated silent executor must settle under its action deadline')
  assert.equal(result.outcome, 'unknown')
  assert.equal(result.code, 'lg_executor_result_timeout')
  console.log('PASS bounded executor result deadline')
} finally {
  await client.close()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
