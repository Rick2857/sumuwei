/**
 * 一次性只读读回：`model_stream_finish_length` 那一轮的 trace 里到底留下了什么（2026-10-10）。
 *
 * ============================================================================
 *  它要回答的问题
 * ============================================================================
 * ```text
 * 主回复流以 finish_reason="length" 结束 ⇒ 整轮失败（src/providers/chat-stream.ts:28-31）。
 * 假设是"输出预算被思维链吃光"（M5.5.1 R2 量过同型：completionTokens=800 · reasoningTokens=800）。
 * 要坐实它，需要两个读数：completionTokens / reasoningTokens。
 * ```
 * ⚠️ 但**先要确认这两个读数到底存不存在**：主回复流（`readChatStream`）**不解析 `usage`**，
 *    也没设 `stream_options.include_usage` ⇒ 流式那次调用很可能**根本没有 token 计数**。
 *    本脚本因此查两件事：① trace 里有没有 token 字段；② 失败前**有没有内容被发出**。
 *
 * 纪律（照 `scripts/diagnose-repeat-reply.ts` 的 `--copy` 先例）：
 *   · 生产库**只被 `cpSync` 读**，**从不**作为数据库打开；打开的是 %TEMP% 里的副本；
 *   · `rows()` 拒绝一切非 SELECT 语句（构造上只读）；
 *   · 副本可能是"写入中的瞬时快照" ⇒ 读数只当近实时，不当精确当前值。
 */
import 'dotenv/config'

import { cpSync, mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import { stringToUuid } from '../src/kernel/contracts/uuid.ts'
import type { Character, Plugin } from '../src/infrastructure/runtime/eliza-types.ts'

import { character } from '../src/character/index.ts'
import { allowProductionDatabase, initDatabase } from '../src/db/index.ts'
import { isProductionDir } from '../src/dev/sandbox.ts'
import { productionDataDirOf } from '../src/infrastructure/persistence/production-open-guard.ts'
import {
  closeDatabaseConnection,
  stopRuntimeServices,
} from '../src/infrastructure/persistence/runtime-shutdown.ts'
import { exec, getRawDb, type RawDb } from '../src/infrastructure/persistence/db.ts'
import { createPersistentCharacterPlugin } from '../src/plugin/persistent-character.ts'

allowProductionDatabase()

const characterId = character.id ?? character.name
const userId = stringToUuid('user-Alex')
const runtime = createThinHostRuntime({
  character: character,
  conversationLength: 16,
  settings: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
  },
})

const realDataDir = productionDataDirOf()
const copyDir = mkdtempSync(join(tmpdir(), 'm45-trace-readback-'))
cpSync(realDataDir, copyDir, { recursive: true })
process.env.PGLITE_DATA_DIR = copyDir
process.env.PROJECT_LG_SANDBOX = copyDir
console.log(`源（只被 cpSync 读，从未打开）: ${realDataDir}`)
console.log(`副本（被打开）              : ${copyDir}`)

await initDatabase(runtime)
const db: RawDb = getRawDb(runtime)

async function rows(sql: string): Promise<Record<string, unknown>[]> {
  if (!sql.trim().slice(0, 12).toLowerCase().startsWith('select')) {
    throw new Error(`只读脚本，拒绝非 SELECT：${sql.slice(0, 120)}`)
  }
  return await exec(db, sql, 'trace-readback')
}
const cut = (value: unknown, n = 110): string =>
  String(value ?? '').replace(/\s+/g, ' ').slice(0, n)

console.log('\n=== ① 最近的 trace（找失败那一轮） ===')
const traces = await rows(
  `select trace_id, status, error, started_at, finished_at
     from character_traces
    where character_id = '${characterId}'
    order by started_at desc
    limit 10`
)
for (const row of traces) {
  console.log(
    `  ${String(row.trace_id).slice(0, 24)} ${String(row.status).padEnd(9)} ` +
      `error=${cut(row.error, 46) || '(无)'}`
  )
}

console.log('\n=== ② 最近 4 条 trace 的 step 种类（判"这轮到底有没有调模型"） ===')
for (const row of traces.slice(0, 4)) {
  const detail = await rows(
    `select steps from character_traces where trace_id = '${String(row.trace_id)}'`
  )
  const steps = (detail[0]?.steps ?? []) as { kind?: string }[]
  const kinds = steps.map((step) => String(step.kind))
  console.log(`  ${String(row.trace_id).slice(0, 22)} ${String(row.status).padEnd(9)}`)
  console.log(`      调模型 = ${String(kinds.includes('model_generate') || kinds.includes('model_call'))}`)
  console.log(`      steps = ${kinds.join(', ')}`)
  /*
   * ★ A1：把"显式记忆/提醒"那两步的**判定输入与结果**打出来 ——
   *   要坐实的是"追问句（什么意思？）被判成了 remember"还是别的。
   */
  for (const step of steps) {
    const kind = String(step.kind)
    if (!/memory_explicit_write|memory_write|reminder/.test(kind)) continue
    console.log(`      [${kind}] ${cut(JSON.stringify(step), 420)}`)
  }
}

const failed = traces.find((row) => String(row.error ?? '') !== '')
if (failed === undefined) {
  console.log('\n⚠️ 最近 10 条 trace 里没有 error 非空的记录。')
} else {
  console.log(`\n=== ② 失败那一轮的 steps（含所有 token/长度字段） ===`)
  const detail = await rows(
    `select steps, error, status, started_at, finished_at
       from character_traces
      where trace_id = '${String(failed.trace_id)}'`
  )
  const first = detail[0]
  const steps = (first?.steps ?? []) as { kind?: string; [key: string]: unknown }[]
  console.log(`  trace=${String(failed.trace_id)} status=${String(first?.status)} steps=${String(steps.length)}`)
  console.log(`  error=${cut(first?.error, 90)}`)
  for (const step of steps) {
    const keys = Object.keys(step).filter((key) => key !== 'kind')
    /*
     * 逐 step 打印，并把"像 token / 长度"的字段单独点名 —— 本脚本存在的理由
     * 就是回答"这两个读数到底存不存在"。
     */
    const interesting = keys
      .filter((key) => /token|length|chars|bytes|content/i.test(key))
      .map((key) => `${key}=${cut(step[key], 40)}`)
      .join(' · ')
    console.log(`    · ${String(step.kind).padEnd(22)} ${cut(interesting, 150)}`)
  }
  const json = JSON.stringify(steps)
  console.log(
    `\n  该轮 trace 里出现 "token" 字样的次数 = ${String((json.match(/token/gi) ?? []).length)}` +
      ` · "reasoning" = ${String((json.match(/reasoning/gi) ?? []).length)}`
  )
  /*
   * ⚠️ 把每一处 "token" 的**上下文**打出来，是为了分清两件完全不同的事：
   *    · **预算字段**（`xxxTokens`：程序给这一轮/这一段的额度）—— 不是模型消耗；
   *    · **usage**（`completion_tokens` / `reasoning_tokens`：模型真花了多少）。
   *    只有后者能坐实"思维链吃光"；前者只是配置。
   */
  const contexts = [...json.matchAll(/.{0,42}token.{0,42}/gi)].map((m) => m[0])
  console.log('  这 10 处的上下文（逐条）：')
  for (const [index, text] of contexts.entries()) {
    console.log(`    [${String(index + 1)}] ${cut(text, 110)}`)
  }
}

console.log('\n=== ③ 最近 12 条对话事件（assistant 正文放宽到 400 字符，便于判"奇怪"） ===')
const events = await rows(
  `select sequence, conversation_sequence, actor_type, type, content, created_at
     from conversation_events
    where character_id = '${characterId}'
    order by sequence desc
    limit 12`
)
for (const row of events.reverse()) {
  const isAssistant = String(row.actor_type) === 'assistant'
  console.log(
    `  #${String(row.sequence)} c${String(row.conversation_sequence)} ` +
      `${String(row.actor_type).padEnd(9)} ${String(row.type).padEnd(20)} ${cut(row.content, isAssistant ? 400 : 120)}`
  )
}

await stopRuntimeServices(runtime)
await closeDatabaseConnection(runtime)
console.log('\n（副本已读毕；真实库从未被打开）')
