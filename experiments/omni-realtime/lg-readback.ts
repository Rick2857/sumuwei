import { readFileSync } from 'node:fs'
import { parse } from 'dotenv'
import { psql } from '../../scripts/postgresql/pg-exec.ts'
import { assertIsolatedPostgres, PG_CONTAINER, PG_HOST_PORT } from './isolated-pg.ts'

const config = parse(readFileSync(new URL('.lg-core.local.env', import.meta.url)))
const target = new URL(config.POSTGRES_URL!)
const database = target.pathname.slice(1)
if (!/^lg_test_omni_[a-z0-9_]+$/.test(database)) throw new Error('test_database_required')
if (target.hostname !== '127.0.0.1' || target.port !== PG_HOST_PORT || config.LG_PG_CONTAINER !== PG_CONTAINER) throw new Error('test_instance_required')
assertIsolatedPostgres()
const result = psql({ container: PG_CONTAINER, user: decodeURIComponent(target.username),
  password: decodeURIComponent(target.password), database,
  sql: `SELECT json_build_object('database',current_database(),
  'conversationEvents',(SELECT count(*) FROM conversation_events),
  'memoryRecords',(SELECT count(*) FROM memory_records),
  'actionEvents',(SELECT count(*) FROM character_action_events),
  'domainTypes',(SELECT json_agg(t) FROM (SELECT type,count(*) FROM character_domain_events GROUP BY type) t),
  'traces',(SELECT json_agg(t) FROM (SELECT trace_id,status,error,model_profile,selected_memory_ids,steps FROM character_traces ORDER BY started_at) t),
  'connections',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()))` })
if (result.rc !== 0) throw new Error('test_readback_failed')
const value = JSON.parse(result.out)
value.traces = value.traces.map((trace: { trace_id: string; status: string; error: unknown; model_profile: string; selected_memory_ids: unknown[]; steps: { kind: string; attributes?: Record<string, unknown> }[] }) => ({
  traceId: trace.trace_id, status: trace.status, error: trace.error, modelProfile: trace.model_profile,
  selectedMemoryCount: trace.selected_memory_ids.length,
  sections: trace.steps.find(step => step.kind === 'context_compile')?.attributes?.sections,
  memoryWrite: trace.steps.find(step => step.kind === 'memory_explicit')?.attributes,
}))
console.log(JSON.stringify(value))
