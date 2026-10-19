/**
 * 局部探针：`live-math-success` 的**交付文本 vs 控制台回声**（排障入口，不是交付物）。
 *
 * 它回答一个具体问题（2026-10-04，父亲agent 的问题）：
 *   「程序生成的 `来源与范围：` 附录到底有没有进**交付文本**，还是只有我的捕获丢了它？」
 *
 * 做法：跑一次真实子进程（真模型 + 隔离库），然后**从隔离库里只读**拿两处：
 *   · `conversation_events` 里那条**助手**事件（交付文本的去处）
 *   · `memories` 表里那条 agent message（旧路径落库的文本）
 * 与 stdout 上的控制台回声并排打印，并各自检查 `来源与范围：` / `[C1]`。
 */

import type { Character } from '../../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../../src/infrastructure/runtime/thin-host-factory.ts'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'



import { sql } from 'drizzle-orm'

import { character } from '../../src/character/index.ts'
import { resetPluginSqlConnection } from '../../src/dev/sandbox.ts'
import { initDatabase } from '../../src/db/index.ts'
import { getRawDb, rowsOf } from '../../src/infrastructure/persistence/db.ts'

const ROOT = process.cwd()
const tsxCli = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const fixtures = join(ROOT, 'artifacts/post-lv2/local/utility-skills-preparation/fixtures')

const work = mkdtempSync(join(tmpdir(), 'project-lg-delivery-probe-'))
const dbDir = join(work, 'pglite')
const sandboxRoot = join(work, 'action-sandbox')
mkdirSync(dbDir, { recursive: true })
mkdirSync(sandboxRoot, { recursive: true })
copyFileSync(join(fixtures, 'doc-zh.pdf'), join(sandboxRoot, 'doc-zh.pdf'))
copyFileSync(join(fixtures, 'img-en.png'), join(sandboxRoot, 'img-en.png'))

const childEnv = {
  ...process.env,
  PGLITE_DATA_DIR: dbDir,
  PROJECT_LG_SANDBOX: dbDir,
  ACTION_SANDBOX_ROOT: sandboxRoot,
  CHARACTER_MATH_CALCULATE_ENABLED: '1',
  CHARACTER_DOCUMENT_READ_ENABLED: '1',
  CHARACTER_WEB_READ_ENABLED: '1',
  CHARACTER_IMAGE_OCR_ENABLED: '1',
  CHARACTER_TURN_CONTENT_TOKENS: process.env.CHARACTER_TURN_CONTENT_TOKENS ?? '3000',
  CHARACTER_WEB_SEARCH_ENABLED: '0',
}

const input = '帮我算一下 0.1 + 0.2 是多少'
const result = spawnSync(process.execPath, [tsxCli, 'src/main.ts', input], {
  cwd: ROOT,
  env: childEnv,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
const merged = `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`
/* ⚠️ 先自证子进程**真的跑了**：没有这一步，"交付文本没有附录"与"子进程根本没说话"分不开 */
process.stdout.write(
  `\n[probe] child exit=${String(result.status)} stdout=${String(String(result.stdout ?? '').length)} stderr=${String(String(result.stderr ?? '').length)} chars · hasMark=${String(merged.includes('苏沐薇:'))} · hasModelLine=${String(/模型\s|模型就绪/.test(merged))}\n`
)

/* 控制台回声：与 `live.ts` 的 `parseReply` 同一算法（切到明确日志行为止） */
const marker = '苏沐薇:'
const at = merged.lastIndexOf(marker)
const LOG_LINE = /\n\s+(?:Info|Warn|Error|Debug)\s{2,}/
const body = at === -1 ? '' : merged.slice(at + marker.length)
const cut = LOG_LINE.exec(body)
const echo = (cut === null ? body : body.slice(0, cut.index)).trim()

/* 从隔离库只读拿交付文本（**打开的是那次子进程用过的同一个目录**） */
/*
 * ⚠️ 父进程自己也要把库指向那个副本：`initDatabase` 的"拒绝写真实库"闸看的就是这两个
 *    环境变量（第一版忘了这一步，被闸正面拦下 —— 那个闸是对的）。
 */
process.env.PGLITE_DATA_DIR = dbDir
process.env.PROJECT_LG_SANDBOX = dbDir
const runtime = createThinHostRuntime({
    character: character,
    settings: { OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'placeholder', OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? '' },
    conversationLength: 16,
  })
await initDatabase(runtime)
const db = getRawDb(runtime)
const q = async (text: string): Promise<Record<string, unknown>[]> => rowsOf(await db.execute(sql.raw(text)))
const assistantEvents = await q(
  `select id, content, created_at from conversation_events where actor_type = 'character' order by created_at desc limit 3`
)
const memories = await q(
  `select id, content, created_at from memories where type = 'messages' order by created_at desc limit 5`
)
await runtime.stop()
await resetPluginSqlConnection()

const asText = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
  }
  return JSON.stringify(value ?? null)
}

const deliveredFromEvents = assistantEvents.map((row) => asText(row.content)).join('\n---\n')
const deliveredFromMemories = memories.map((row) => asText(row.content)).join('\n---\n')

const check = (label: string, text: string): void => {
  process.stdout.write(
    `${label}: chars=${String(text.length)} · 来源与范围=${String(text.includes('来源与范围：'))} · [C1]=${String(text.includes('[C1]'))}\n`
  )
  process.stdout.write(`    tail: ${JSON.stringify(text.slice(-160))}\n`)
}

process.stdout.write(`\n=== 交付 vs 回声（runId=delivery-probe）===\n`)
check('① 控制台回声（我的 harness 今天读的就是这个）', echo)
check('② 隔离库 conversation_events（助手事件 = 交付文本）', deliveredFromEvents)
check('③ 隔离库 memories(messages)', deliveredFromMemories)
process.stdout.write(`\n assistantEvents=${String(assistantEvents.length)} rows · memories=${String(memories.length)} rows\n`)

const out = join(ROOT, 'artifacts/post-lv2/local/utility-skills-preparation/runs', 'delivery-probe.json')
writeFileSync(
  out,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      input,
      echo: { chars: echo.length, hasAppendix: echo.includes('来源与范围：'), hasLabel: echo.includes('[C1]'), text: echo },
      deliveredEvents: {
        rows: assistantEvents.length,
        hasAppendix: deliveredFromEvents.includes('来源与范围：'),
        hasLabel: deliveredFromEvents.includes('[C1]'),
        text: deliveredFromEvents,
      },
      deliveredMemories: {
        rows: memories.length,
        hasAppendix: deliveredFromMemories.includes('来源与范围：'),
        hasLabel: deliveredFromMemories.includes('[C1]'),
        text: deliveredFromMemories,
      },
    },
    null,
    2
  )}\n`,
  'utf8'
)
process.stdout.write(`\n证据：${out}\n`)
process.exit(0)
