import assert from 'node:assert/strict'
import { drizzle } from 'drizzle-orm/node-postgres'
import { withPgTest } from './postgresql/test-harness.ts'

await withPgTest('memory-lists', async test => {
  const { applyKernelMigrations } = await import('../src/infrastructure/persistence/db.ts')
  await applyKernelMigrations(drizzle(test.pool) as never)
  const { createM4Harness } = await import('./m4-harness.ts')
  const { createNativeMemoryStore } = await import('../src/infrastructure/persistence/memory-store.ts')
  const { withReadScope } = await import('../src/infrastructure/persistence/read-scope.ts')
  const h = await createM4Harness({ label: 'debt-memory-lists' })
  let queries = 0
  const counted = { execute: async (query: unknown) => { queries++; return h.db.execute(query) } }
  const store = createNativeMemoryStore(counted)
  let checks = 0
  const check = (name: string) => { checks++; console.log('PASS ' + name) }
  try {
    const evidence = await h.recordUserEvidence('这是隔离验收的事实集合。')
    const originals = []
    for (let i = 0; i < 24; i++) {
      const record = await h.commitAndFold(h.makeCandidate('person_fact', {
        kind: 'claim', subject: h.user, predicate: 'test.slot.' + i, value: 'value-' + i,
      }, { sourceRefs: [evidence.ref] }), Date.now() + i)
      assert.ok(record)
      originals.push(record)
    }
    const expected = new Map()
    for (const record of originals) expected.set(String(record.id), await h.store.get(record.id))
    const list = await store.list({ owner: h.owner, limit: 200 })
    assert.equal(list.length, originals.length)
    for (const record of list) assert.deepEqual(record, expected.get(String(record.id)))
    check('list matches scalar get field-for-field across 24 records')
    for (const [label, read] of [
      ['subject', () => store.listBySubject(h.owner, h.user)],
      ['source', () => store.listBySource(evidence.ref as never)],
      ['list', () => store.list({ owner: h.owner, limit: 200 })],
    ] as const) {
      queries = 0
      const rows = await read()
      assert.equal(rows.length, 24)
      assert.equal(queries, 4, label + ' must use one selection and three hydration queries')
      for (const record of rows) assert.deepEqual(record, expected.get(String(record.id)))
      check(label + ': 24 records, exactly 4 DB calls, scalar-equivalent')
    }
    const sorted = [...list].sort((a, b) => b.recordedAt - a.recordedAt)
    assert.deepEqual(list.map(r => r.id), sorted.map(r => r.id))
    check('recency order preserved')
    const key = originals[0].canonicalKey!
    for (const rows of [await store.listByCanonicalKey(key), await store.getActiveByCanonicalKey(key)]) {
      assert.equal(rows.length, 1)
      assert.deepEqual(rows[0], expected.get(String(rows[0].id)))
    }
    check('canonical history and active reads match scalar hydration')
    const outsider = { ...h.user, id: 'another-user' }
    queries = 0
    assert.deepEqual(await store.listBySubject(h.owner, outsider as never), [])
    assert.equal(queries, 1)
    check('empty subject adds no hydration queries')
    const scope = { context: { principal: { kind: 'user', userId: 'other-user' },
      actor: { kind: 'user', userId: 'other-user' }, room: { kind: 'dm', userId: 'other-user' } },
      ownerUserId: 'owner', roomAuthorized: true }
    assert.deepEqual(await withReadScope(scope as never, () => h.store.listBySubject(h.owner, h.user)), [])
    check('external unrelated room cannot read the records')
    console.log(JSON.stringify({ backend: 'postgres', checks, status: 'PASS', productionOpened: false }))
  } finally { await h.stop() }
})
