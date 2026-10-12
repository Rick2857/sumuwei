/**
 * 局部探针：只跑**网页**的 6 组（排障入口，不是交付物）。
 */

import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

import type { VerifyContext } from './groups.ts'
import { RUNNERS, Suite } from './groups.ts'

const only = process.argv[2] ?? 'web-01'
const runTag = `probe-web-${String(Date.now())}`
const localDir = resolve('artifacts/post-lv2/local/utility-skills-preparation', runTag)
mkdirSync(localDir, { recursive: true })

const ctx: VerifyContext = {
  only: ['web'],
  live: false,
  fixturesDir: resolve('artifacts/post-lv2/local/utility-skills-preparation/fixtures'),
  runDir: localDir,
  localDir,
  log: (message) => process.stdout.write(`${message}\n`),
}

const suite = new Suite(ctx)
const wanted = new Set(only.split(',').map((s) => s.trim()))

/* 先单独确认夹具本身可用（这一步的读数决定了后面是"夹具问题"还是"适配器问题"） */
try {
  const bundle = await suite.web()
  process.stdout.write(
    `[probe] 夹具起来了：port=${String(bundle.fixture.port)} hosts=${bundle.fixture.hosts.hostNames.join(',')}\n`
  )
  process.stdout.write(`[probe] articleUrl=${bundle.articleUrl}\n`)
  process.stdout.write(`[probe] tls cert 长度=${String(bundle.fixture.tls.certPem.length)}\n`)
} catch (error) {
  process.stdout.write(`[probe] 夹具起不来：${(error as Error).message}\n`)
}

for (const runner of RUNNERS) {
  if (!wanted.has(runner.id)) continue
  process.stdout.write(`\n===== ${runner.id} =====\n`)
  try {
    const reading = await runner.run(ctx, suite)
    process.stdout.write(`  → ${reading.status}（${String(reading.measuredCount)} 条输入）\n`)
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

/* 直接跑一轮 `web.read`，把失败详情原样打出来（诊断用） */
if (process.env.PROBE_WEB_DIRECT === '1') {
  const entry = await suite.openBed('probe-web-direct')
  const bundle = await suite.web()
  const direct = await suite.readWeb(entry, bundle.articleUrl, {
    resolve: async (host) => {
      const answer = bundle.extraHosts.get(host.toLowerCase()) ?? bundle.fetcher.resolve(host)
      process.stdout.write(`\n[probe] resolve(${host}) -> ${JSON.stringify(answer)}\n`)
      return answer
    },
    connect: bundle.fetcher.connect,
  })
  process.stdout.write('\n[probe] direct = ')
  for (const item of direct.reading.actionResults) {
    process.stdout.write(
      JSON.stringify({
        capability: String(item.result?.capability),
        status: String(item.result?.status),
        rule: item.rule,
        error: item.result?.error,
      })
    )
  }
  process.stdout.write('\n')
  process.stdout.write(
    `[probe] adapterReading = ${JSON.stringify({
      connectCalls: bundle.fetcher.reading.connectCalls,
      resolveHosts: bundle.fetcher.reading.resolveHosts,
      connectErrors: bundle.fetcher.reading.connectErrors,
      connectOk: bundle.fetcher.reading.connectOk,
      served: [...bundle.fixture.served],
      resolveCalls: bundle.fetcher.reading.resolveCalls,
      hits: [...bundle.fixture.hits.entries()],
    })}\n`
  )
}

await suite.dispose()
process.stdout.write('\n[probe] 完成\n')
process.exit(0)

