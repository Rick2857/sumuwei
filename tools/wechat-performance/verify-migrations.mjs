/** Packaging guard for the pinned upstream commit; never opens a database. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

assert(process.argv[2], 'usage: node verify-migrations.mjs <agent-server-rust directory>')
const expected = {
  'V1__baseline.sql': '65d7869886f7e71e78f2c656fb3310583355233ea6f1c3db00fa52dae4667c81',
  'V2__add_novnc_port.sql': 'd09de45789d5b4cded420ab4a69b47c4f4aae9ddde740734a4a2ccee3a833c41',
  'V3__voice_jobs.sql': 'e9339c3ce7b7f1713406810c7179880399ede0e21d06ca7220842239de8288c1',
}
const dir = resolve(process.argv[2], 'migrations')
assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.sql')).sort(), Object.keys(expected).sort())
for (const [name, hash] of Object.entries(expected)) {
  assert.equal(createHash('sha256').update(readFileSync(resolve(dir, name))).digest('hex'), hash,
    `${name}: migration bytes changed; use canonical Git files before building`)
}
console.log('PASS pinned upstream migration bytes (3 files)')
