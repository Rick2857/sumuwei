/** Shared-view mechanisms plus real Gateway/PostgreSQL readback; no network or model probes. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { drizzle } from 'drizzle-orm/node-postgres'
import { withKnowledgeTestDatabase } from './project-knowledge-test-db.ts'
import { applyKernelMigrations } from '../src/infrastructure/persistence/db.ts'
import { createActionLedgerStore } from '../src/infrastructure/action/action-ledger-store.ts'
import { createActionGateway } from '../src/kernel/action/gateway.ts'
import { createDefaultCapabilityDefinitions, createCapabilityRegistry, DEFAULT_GRANTED_PERMISSIONS } from '../src/kernel/action/capability-registry.ts'
import { createProjectKnowledgeDefinitions } from '../src/kernel/action/project-knowledge-capabilities.ts'
import { currentCapabilityFacts, selfCapabilitySnapshot } from '../src/infrastructure/project-knowledge/self-capabilities.ts'
import { readKernelFlags } from '../src/kernel/app/flags.ts'
import { buildToolCatalog } from '../src/kernel/action/tool-catalog.ts'
import { createEchoAdapter } from '../src/infrastructure/action/adapters/echo.ts'
import { createDeveloperQueryService } from '../src/infrastructure/dev/query-service.ts'
import type { ActionRequest } from '../src/kernel/action/action-request.ts'
import type { GatewayCapabilityFacts } from '../src/kernel/action/capability-facts.ts'

const checks: string[] = []
async function check(name: string, run: () => unknown | Promise<unknown>) { await run(); checks.push(name); console.log(`PASS ${name}`) }
const registry = createCapabilityRegistry([...createDefaultCapabilityDefinitions(), ...createProjectKnowledgeDefinitions()])
const flags = readKernelFlags({ CHARACTER_SELF_CAPABILITIES_ENABLED: 'true', CHARACTER_PROJECT_KNOWLEDGE_ENABLED: 'true',
  CHARACTER_ACTION_ENABLED: 'true', CHARACTER_TASK_AUTONOMY_ENABLED: 'true' })
const gatewayFacts: GatewayCapabilityFacts = { adapterIds: ['system.echo', 'self.capabilities'],
  grantedPermissions: [...DEFAULT_GRANTED_PERMISSIONS, 'project:read', 'self:read'], maxRiskLevel: 'R0', dryRun: false, lastResults: {} }
const base = { registry, flags, gateway: gatewayFacts, candidates: ['self.capabilities', 'project.search', 'nonexistent'],
  runtimeId: 'isolated-facts-runtime', entry: 'qq_private', now: 123 }
const out = 'artifacts/local/project-knowledge-p3'
await mkdir(out, { recursive: true })
try {
  await check('without gateway, registration is known and assembly/permissions/results remain unknown', () => {
    const view = currentCapabilityFacts({ registry, entry: 'developer', now: 123 })
    assert.equal(view.authority, 'registration-only')
    for (const row of view.tools) {
      assert.equal(row.registered, true); assert.equal(row.configured, 'unknown')
      assert.equal(row.assembled, 'unknown'); assert.equal(row.permissionGranted, 'unknown')
      assert.equal(row.taskCandidate, 'unknown'); assert.equal(row.lastObservedResult, null)
    }
  })
  await check('configured, assembled, permissions, candidate and global risk stay independent', () => {
    const view = currentCapabilityFacts(base), project = view.tools.find(row => row.id === 'project.search')!
    assert.equal(project.configured, true); assert.equal(project.assembled, false)
    assert.equal(project.permissionGranted, true); assert.equal(project.taskCandidate, true)
    assert.equal(view.tools.find(row => row.id === 'sandbox.file.write')!.riskAllowed, false)
    assert.equal(project.connection.state, 'unknown')
  })
  await check('no local probe is unknown, and a ready dependency never implies a remote connection', () => {
    const unknown = currentCapabilityFacts({ ...base, capability: 'self.capabilities',
      probe: () => ({ ready: true, reason: 'no_local_dependency_probe', checkedAt: 120 }) }).tools.find(row => row.id === 'self.capabilities')!
    assert.equal(unknown.dependency.state, 'unknown'); assert.equal(unknown.dependency.checkedAt, 120)
    const ready = currentCapabilityFacts({ ...base, capability: 'self.capabilities',
      probe: () => ({ ready: true, reason: 'local_dependencies_ready', checkedAt: 123 }) }).tools.find(row => row.id === 'self.capabilities')!
    assert.equal(ready.dependency.state, 'ready'); assert.equal(ready.connection.state, 'unknown')
  })
  await check('summary stays bounded and registered counts do not shrink for a single-capability query', () => {
    const view = selfCapabilitySnapshot({ ...base, capability: 'self.capabilities', wechat: false,
      probe: () => ({ ready: false, reason: 'runtime_dependencies_missing', checkedAt: 123 }) })
    assert.equal(view.summary.registered, registry.list().length); assert.equal(view.tools.length, 1)
    const summary = selfCapabilitySnapshot({ ...base, wechat: false, probe: () => { throw Error('must not probe summary') } })
    assert.deepEqual(summary.tools, []); assert.equal(summary.summary.taskCandidates.includes('nonexistent'), false)
    assert.ok(JSON.stringify(summary).length < 2100)
  })
  await check('catalogue and self query consume identical facts; unknown remote status defeats optimistic labels', () => {
    const view = currentCapabilityFacts(base)
    const catalog = buildToolCatalog(registry, { currentFacts: view, connectionStates: { 'project.search': 'connected' } })
    for (const row of catalog) {
      const fact = view.tools.find(tool => tool.id === row.capability)!
      assert.deepEqual(row.currentFact, fact); assert.equal(row.enabled, fact.taskCandidate === true)
      assert.equal(row.authorized, fact.permissionGranted === true)
    }
    assert.equal(catalog.find(row => row.capability === 'project.search')!.connection, 'unknown')
  })
  await check('global action off removes candidates without erasing registration or granting anything', () => {
    const off = currentCapabilityFacts({ ...base, flags: { ...flags, actionEnabled: false } })
    assert.equal(off.tools.some(row => row.taskCandidate === true), false)
    assert.equal(off.tools.length, registry.list().length)
    const fresh = currentCapabilityFacts({ ...base, now: 124, candidates: [] })
    assert.equal(fresh.observedAt, 124); assert.equal(fresh.tools.some(row => row.taskCandidate === true), false)
  })
  await withKnowledgeTestDatabase(process.env.LG_SIM_PGTEST_ADMIN_URL!, 'current-facts', async test => {
    const db = drizzle(test.pool) as never
    await applyKernelMigrations(db)
    let clock = 200
    const options = { registry, ledger: createActionLedgerStore(db), adapters: [createEchoAdapter()],
      grantedPermissions: DEFAULT_GRANTED_PERMISSIONS, maxRiskLevel: 'R1' as const, now: () => clock,
      resolveTarget: async () => ({ target: { type: 'internal_service' as const, canonicalId: 'fixture', confidence: 'exact' as const }, scopeViolation: false }) }
    const gateway = createActionGateway(options)
    const request = (id: string, args: Record<string, unknown>): ActionRequest => ({ actionId: `act:${id}` as never,
      traceId: `trc:${id}` as never, capability: 'system.echo', operation: 'echo', requestedBy: { kind: 'user', id: 'fixture' },
      arguments: args, sideEffect: 'none', createdAt: clock as never })
    await check('gateway readback is from actual installed adapters, not enabled flags or a second manifest', () => {
      const facts = gateway.readCapabilityFacts!()
      assert.deepEqual(facts.adapterIds, ['system.echo']); assert.deepEqual(facts.lastResults, {})
      assert.equal(currentCapabilityFacts({ ...base, gateway: facts }).tools.find(row => row.id === 'project.search')!.assembled, false)
    })
    await check('actual successful action is visible without copying arguments, effect text or credentials', async () => {
      const result = await gateway.execute('fixture' as never, request('facts-success', { text: 'secret-body-sentinel' }))
      assert.equal(result.status, 'success')
      const facts = gateway.readCapabilityFacts!(), row = facts.lastResults['system.echo']!
      assert.equal(row.executed, true); assert.equal(row.accepted, true); assert.equal(row.status, 'success')
      assert.equal(row.observedAt, 200); assert.equal(JSON.stringify(facts).includes('secret-body-sentinel'), false)
      ;(facts.adapterIds as string[]).push('project.search')
      row.status = 'failed'
      assert.equal(gateway.readCapabilityFacts!().adapterIds.includes('project.search'), false)
      assert.equal(gateway.readCapabilityFacts!().lastResults['system.echo']!.status, 'success')
    })
    await check('adapter rejection and policy denial do not become success or remote-connected facts', async () => {
      clock++
      const bad = await gateway.execute('fixture' as never, request('facts-bad', {}))
      assert.notEqual(bad.status, 'success')
      assert.equal(gateway.readCapabilityFacts!().lastResults['system.echo']!.status, bad.status)
      const denied = createActionGateway({ ...options, grantedPermissions: [] })
      const result = await denied.execute('fixture' as never, request('facts-denied', { text: 'hidden' }))
      assert.equal(result.accepted, false); assert.equal(result.executed, false)
      const fact = currentCapabilityFacts({ ...base, gateway: denied.readCapabilityFacts!() }).tools.find(row => row.id === 'system.echo')!
      assert.equal(fact.permissionGranted, false); assert.equal(fact.lastObservedResult!.status, 'rejected')
      assert.equal(fact.connection.state, 'unknown')
    })
    await check('new gateway has no inherited prior-runtime success; history is separate from current configuration', () => {
      assert.deepEqual(createActionGateway(options).readCapabilityFacts!().lastResults, {})
      const view = currentCapabilityFacts({ ...base, flags: { ...flags, selfCapabilitiesEnabled: false },
        gateway: gateway.readCapabilityFacts!() })
      assert.equal(view.tools.find(row => row.id === 'self.capabilities')!.configured, false)
      assert.notEqual(view.tools.find(row => row.id === 'system.echo')!.lastObservedResult, null)
    })
    await check('dry-run blocks writes while read-only execution remains factual; neither proves remote delivery', async () => {
      const dry = createActionGateway({ ...options, dryRun: true })
      const read = await dry.execute('fixture' as never, request('facts-dry-read', { text: 'simulation' }))
      assert.equal(read.executed, true, 'existing policy allows sideEffect=none in dry-run')
      const result = await dry.execute('fixture' as never, { ...request('facts-dry-write', { path: 'ignored.txt', content: 'simulation' }),
        capability: 'sandbox.file.write', operation: 'write', sideEffect: 'write' })
      assert.equal(result.executed, false)
      const row = currentCapabilityFacts({ ...base, gateway: dry.readCapabilityFacts!() }).tools.find(tool => tool.id === 'sandbox.file.write')!
      assert.equal(row.executionMode, 'dry-run'); assert.equal(row.lastObservedResult!.executed, false)
      assert.equal(row.connection.state, 'unknown')
    })
    await check('developer and chat use one projection; reads do not append ledger records', async () => {
      const before = (await test.pool.query('select count(*)::int n from character_action_events')).rows[0].n
      const read = () => currentCapabilityFacts({ ...base, gateway: gateway.readCapabilityFacts!() })
      const service = createDeveloperQueryService({ db, characterId: 'fixture' as never,
        owner: { kind: 'character', id: 'fixture' } as never, now: () => 123, currentCapabilityFacts: read })
      for (let i = 0; i < 3; i++) assert.deepEqual((await service.getCapabilities()).currentFacts, read())
      const fallback = createDeveloperQueryService({ db, characterId: 'fixture' as never,
        owner: { kind: 'character', id: 'fixture' } as never, now: () => 123 })
      assert.equal((await fallback.getCapabilities()).currentFacts!.authority, 'registration-only')
      assert.equal((await test.pool.query('select count(*)::int n from character_action_events')).rows[0].n, before)
    })
  })
  await writeFile(`${out}/facts-verification.json`, JSON.stringify({ status: 'PASS', checks, location: 'serversim',
    database: 'disposable PostgreSQL/pgtest', realModelRequests: 0, realQqMessages: 0 }, null, 2))
} catch (error) {
  await writeFile(`${out}/facts-verification.json`, JSON.stringify({ status: 'FAIL', checks, error: String(error) }, null, 2)); throw error
}
console.log(`PASS ${checks.length} checks`)
