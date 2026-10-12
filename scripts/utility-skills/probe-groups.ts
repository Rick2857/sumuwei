/**
 * 局部探针：只跑**计算**的 6 组，把逐条断言打到 stdout（用于调试）。
 *
 * 不是交付物 —— 只是排障入口（`scripts/utility-skills/probe-*.ts` 的同类）。
 */

import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

import type { VerifyContext } from './groups.ts'
import { RUNNERS, Suite } from './groups.ts'

const only = process.argv[2] ?? 'math'
const runTag = `probe-${String(Date.now())}`
const localDir = resolve('artifacts/post-lv2/local/utility-skills-preparation', runTag)
mkdirSync(localDir, { recursive: true })

const ctx: VerifyContext = {
  only: ['math'],
  live: false,
  fixturesDir: resolve('artifacts/post-lv2/local/utility-skills-preparation/fixtures'),
  runDir: localDir,
  localDir,
  log: (message) => process.stdout.write(`${message}\n`),
}

const suite = new Suite(ctx)
const wanted = new Set(
  only === 'math'
    ? ['math-01', 'math-02', 'math-03', 'math-04', 'math-05', 'math-06']
    : only.split(',').map((s) => s.trim())
)

for (const runner of RUNNERS) {
  if (!wanted.has(runner.id)) continue
  process.stdout.write(`\n===== ${runner.id} =====\n`)
  const started = Date.now()
  try {
    const reading = await runner.run(ctx, suite)
    process.stdout.write(`  → ${reading.status}（${String(reading.measuredCount)} 条输入 · ${String(Date.now() - started)}ms）\n`)
    process.stdout.write(`  observed = ${JSON.stringify(reading.reason ?? null)}\n`)
    for (const item of reading.cases) {
      process.stdout.write(`  [${item.status}] ${item.title}\n`)
      if (item.observed !== undefined) {
        process.stdout.write(`        observed = ${JSON.stringify(item.observed)}\n`)
      }
    }
  } catch (error) {
    process.stdout.write(`  → 抛错：${(error as Error).stack ?? String(error)}\n`)
  }
}

/* 诊断：直接看"动作结果里有没有 turnContent"（把适配器层与网关层分开） */
if (process.env.PROBE_TURNCONTENT === '1') {
  const entry = await suite.openBed('probe-tc')
  entry.sandbox.writeText('tc.txt', 'turnContent 诊断正文\n')
  const reading = await entry.bed.say({
    options: { switches: { document: true }, sandboxRoot: entry.sandbox.root, turnContentTokens: 2000 },
    text: '读一下 doc-zh.pdf',
    replyText: '（诊断）',
  })
  process.stdout.write(
    `\n[probe] turnContent=${String(reading.turnContent.length)} ` +
      `actionResults=${JSON.stringify(
        reading.actionResults.map((item) => ({
          capability: String(item.result?.capability),
          status: String(item.result?.status),
          hasTurnContent: (item.result?.turnContent?.length ?? 0) > 0,
        }))
      )}\n`
  )
  process.stdout.write(
    `[probe] turnContentInContext=${JSON.stringify(reading.turnContentInContext ?? null).slice(0, 200)}\n`
  )
  process.stdout.write(`[probe] sections=${reading.sectionIds.join(',')}\n`)
}

/* 诊断：网页夹具的逐行 served 读数（含大响应体那一档） */
if (process.env.PROBE_SERVED === '1') {
  const entry = await suite.openBed('probe-served')
  const bundle = await suite.web()
  await suite.readWeb(entry, bundle.largeUrl, {
    resolve: bundle.fetcher.resolve,
    connect: bundle.fetcher.connect,
  })
  process.stdout.write(`\n[probe] served=${JSON.stringify(bundle.fixture.served)}\n`)
  process.stdout.write(`[probe] hits=${JSON.stringify([...bundle.fixture.hits.entries()])}\n`)
}

await suite.dispose()
process.stdout.write('\n[probe] 完成\n')
process.exit(0)
