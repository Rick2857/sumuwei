/**
 * M9 WP10 —— 长门 F-2 取证探针（一次性诊断工具，非门）。
 *
 * 背景：live long #101「记住，技术问题我喜欢详细解释。」——她回复「记住了…这事我记下了」
 * （'written' 措辞），但 c5/c6 快照显示 memory_records 仍为 4 条（无新记录、无新信念）。
 * 本脚本打开长门的**临时副本**（只读查询），列出：
 *   1. 全部含 memory_explicit_write 步的 trace（时间序 + 步的 label/attributes）；
 *   2. memory_records 全量（id/status/predicate/value/recorded_at）；
 *   3. MEMORY_* 域事件全量（type/sequence/created_at）。
 * 用法：tsx scripts/m9-long-forensics.ts --db-dir <副本>
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { isProductionDir } from '../src/dev/sandbox.ts'

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main(): Promise<void> {
  const dbDir = argValue('--db-dir')
  if (dbDir === undefined || !existsSync(dbDir)) {
    console.error('用法：tsx scripts/m9-long-forensics.ts --db-dir <副本>')
    process.exit(2)
  }
  if (isProductionDir(dbDir) || resolve(dbDir) === resolve('data/pglite')) {
    console.error('拒绝：不打开生产目录')
    process.exit(2)
  }

  process.env.PGLITE_DATA_DIR = dbDir
  process.env.PROJECT_LG_SANDBOX = dbDir

  const { createThinHostRuntime } = await import('../src/infrastructure/runtime/thin-host-factory.ts')
  
  const { character } = await import('../src/character/index.ts')
  const { initDatabase } = await import('../src/db/index.ts')
  const { getRawDb, exec } = await import('../src/infrastructure/persistence/db.ts')
  const { sql } = await import('drizzle-orm')

  const runtime = createThinHostRuntime({
      character: character,
      settings: { OPENAI_API_KEY: 'placeholder', OPENAI_BASE_URL: '' },
      conversationLength: 16,
    })
  await initDatabase(runtime)
  const db = getRawDb(runtime)

  console.log('==== 含 memory_explicit_write 的 trace（时间序） ====')
  const traceRows = await exec(
    db,
    sql`select trace_id, started_at, steps from character_traces order by started_at asc`,
    '取全部 trace',
  )
  const allTraces = traceRows as unknown as Record<string, unknown>[]
  let found = 0
  for (const t of allTraces) {
    let steps: Record<string, unknown>[] = []
    try {
      const parsed = typeof t.steps === 'string' ? JSON.parse(t.steps) : t.steps
      steps = Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : []
    } catch {
      steps = []
    }
    const writeSteps = steps.filter((s) => s.kind === 'memory_explicit_write')
    if (writeSteps.length === 0) continue
    found += 1
    const when = new Date(Number(t.started_at)).toISOString()
    for (const s of writeSteps) {
      console.log(`  ${when}  ${String(s.label ?? '')}`)
      console.log(`    status=${String(s.status ?? '')}  attributes=${JSON.stringify(s.attributes ?? {})}`)
    }
  }
  console.log(`  （共 ${String(found)} 条含显式写入步的 trace；trace 总数 ${String(allTraces.length)}）`)

  console.log('')
  console.log('==== memory_records 全量 ====')
  const memRows = await exec(
    db,
    sql`select id, status, created_at, content from memory_records order by created_at asc`,
    '取全部记忆',
  )
  for (const r of memRows as unknown as Record<string, unknown>[]) {
    let pred = ''
    let val = ''
    try {
      const c = typeof r.content === 'string' ? JSON.parse(r.content) : (r.content as Record<string, unknown>)
      pred = String((c as Record<string, unknown>).predicate ?? '')
      val = String((c as Record<string, unknown>).value ?? '')
    } catch {
      pred = '(解析失败)'
    }
    console.log(
      `  ${String(r.id).slice(0, 22)}… ${String(r.status).padEnd(10)} ${new Date(Number(r.created_at)).toISOString()}  ${pred} = ${val}`,
    )
  }

  console.log('')
  console.log('==== MEMORY_* 域事件全量 ====')
  const evRows = await exec(
    db,
    sql`select id, sequence, type, created_at from character_domain_events
        where type like 'MEMORY_%' order by sequence asc`,
    '取 MEMORY 域事件',
  )
  for (const r of evRows as unknown as Record<string, unknown>[]) {
    console.log(
      `  #${String(r.sequence)}  ${String(r.type).padEnd(22)} ${new Date(Number(r.created_at)).toISOString()}`,
    )
  }

  process.exit(0)
}

await main()
