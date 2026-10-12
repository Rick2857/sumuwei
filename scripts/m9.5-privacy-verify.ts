/**
 * M9.5 WP8 —— **隐私门**（`pnpm m9.5:privacy:verify`）。
 *
 * ============================================================================
 *  计划 §12 WP8 的三句要求（逐条变成判据）
 * ============================================================================
 * ```text
 * ① 「**无私人文本出站**」
 *    不是"我们没这么写"，而是**结构性封死**：编码子进程在加载推理库之前装上
 *    不出站守卫（`installNoEgressGuard`），任何 `fetch` / XHR 立刻抛具名错误。
 *    ⚠️ 判据必须**两向**：守卫要**真的会响**（拿它去 fetch，必须抛出），
 *       而正常路径**仍然能跑**（否则守卫把功能掐死了 —— 那是另一类坏）。
 * ② 「**诊断不泄漏**」
 *    正文**合法地**进上下文（那是 prompt 的用途），但**不许进** trace / 决策记录 /
 *    序列化的证据档。判据用**哨兵串**：它必须**在** `selection` 里（正控：证明哨兵真的在场上），
 *    并且**不在** trace/record/bundleTrace/证据档里（负控）。没有正控的"不含"是空的。
 * ③ 「**查询零写**」
 *    一次检索不许改动任何表。判据：相关表的逐行摘要**前后逐字相同**。
 * ```
 * 用法：`pnpm m9.5:privacy:verify`
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { sql } from 'drizzle-orm'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { rowsOf } from '../src/infrastructure/persistence/db.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import {
  EGRESS_GUARD_CODE,
  egressGuardStatus,
  installNoEgressGuard,
} from '../src/infrastructure/semantic/no-egress-guard.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { createRecallTurnPort } from '../src/kernel/app/recall/turn.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { newTraceId } from '../src/kernel/contracts/ids.ts'
import { createRecallRequest } from '../src/kernel/contracts/recall.ts'
import type { MemorySemanticProbe } from '../src/kernel/recall/ports.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'

import { M4_T0, sha256 } from './m4-harness.ts'
import { createM55Harness } from './m5.5-harness.ts'
import { dirtyPaths, sourceTreeReading } from './m6.1-run-manifest.ts'
import {
  createM95RunId,
  openM95RunDir,
  runIdFromM95OutPath,
  selfCheckMeasurement,
  writeM95Manifest,
} from './m9.5-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const STARTED_AT = new Date().toISOString()
const GATE_VERSION = 'm9.5-privacy@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')

/**
 * 哨兵串：故意做成"绝不可能自然出现"的形态。
 * ⚠️ 它同时出现在**记忆取值**与**查询句**里，因此"它不在 trace 里"才是真的结论
 *    （只放在查询句里的话，有些路径本来就不记查询句，那样的"不含"证明不了什么）。
 */
const SENTINEL = 'SENTINEL-M95-PRIVACY-9f3c2a71-DO-NOT-LEAK'

interface Probe {
  readonly id: string
  readonly question: string
  readonly verdict: 'ok' | 'unexpected'
  readonly reading: Record<string, unknown>
  readonly error: string | null
}

async function probe(input: {
  readonly id: string
  readonly question: string
  readonly run: () => Promise<Record<string, unknown>> | Record<string, unknown>
  readonly judge?: (reading: Record<string, unknown>) => string[]
}): Promise<Probe> {
  try {
    const reading = input.run()
    const resolved = reading instanceof Promise ? await reading : reading
    const problems = input.judge?.(resolved) ?? []
    return {
      id: input.id,
      question: input.question,
      verdict: problems.length > 0 ? 'unexpected' : 'ok',
      reading: resolved,
      error: problems.length > 0 ? problems.join('; ') : null,
    }
  } catch (error) {
    return {
      id: input.id,
      question: input.question,
      verdict: 'unexpected',
      reading: {},
      error: (error as Error).message.replace(/\s+/g, ' ').slice(0, 240),
    }
  }
}

function gitOrNull(args: readonly string[]): string | null {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function safeTreeDigest(): Record<string, unknown> | null {
  try {
    const digest = digestTree(REAL_DB_DIR)
    return { dir: 'data/pglite', measuredCount: digest.measuredCount, treeSha256: digest.treeSha256 }
  } catch (error) {
    return { dir: 'data/pglite', error: (error as Error).message }
  }
}

function claim(predicate: string, value: string, subject: ReturnType<typeof entityRef>): never {
  return { kind: 'claim', subject, predicate, value } as never
}

/** 相关表的逐行摘要（`'查询零写'` 的判据）。 */
async function tableDigest(db: { execute: (query: unknown) => Promise<unknown> }): Promise<string> {
  const tables = [
    'memories',
    'memory_evidence_links',
    'conversation_events',
    'domain_events',
    'memory_semantic_meta',
    'memory_semantic_generations',
    'memory_semantic_index',
    'memory_semantic_failures',
  ]
  const parts: string[] = []
  for (const table of tables) {
    const exists = rowsOf(
      await db.execute(
        sql`select count(*)::int as c from information_schema.tables
            where table_schema = 'public' and table_name = ${table}`
      )
    )[0]
    if (Number(exists?.c ?? 0) === 0) {
      parts.push(`${table}=absent`)
      continue
    }
    const digest = rowsOf(await db.execute(sql.raw(`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as d from ${table} t`)))[0]
    const count = rowsOf(await db.execute(sql.raw(`select count(*)::int as c from ${table}`)))[0]
    parts.push(`${table}=${String(count?.c ?? 0)}:${String(digest?.d ?? 'null')}`)
  }
  return parts.join('\n')
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: 'wp8-privacy', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const realDbBefore = safeTreeDigest()
  const probes: Probe[] = []

  /* ---- ① 不出站守卫：**两向**判据 ---- */
  probes.push(
    await probe({
      id: 'egress-guard-fires-and-does-not-break-the-happy-path',
      question: '① 不出站守卫**真的会响**（fetch 抛具名错误），且它不拦本地 `node:fs`',
      run: async () => {
        const guard = installNoEgressGuard()
        const before = guard.blockedCount
        let thrownCode: string | null = null
        let thrownName: string | null = null
        try {
          await fetch('https://example.invalid/would-be-egress')
        } catch (error) {
          thrownCode = (error as { code?: string }).code ?? null
          thrownName = (error as Error).name
        }
        /* 正控的反面：本地读取**必须**照常（守卫只封网络，不封本地模型读取） */
        const fs = await import('node:fs')
        const localReadOk = fs.existsSync(join(REPO_ROOT, 'evals/m9.5/embedding-manifest.json'))
        return {
          installed: guard.installed,
          blockedDelta: guard.blockedCount - before,
          blockedCount: guard.blockedCount,
          thrownCode,
          thrownName,
          blockedTargets: [...guard.blockedTargets],
          localReadOk,
          guardCodeConstant: EGRESS_GUARD_CODE,
          status: egressGuardStatus().installed,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.installed !== true) problems.push('守卫未安装')
        if (Number(reading.blockedDelta) < 1) problems.push('★ 守卫装了却拦不住 fetch（空壳）')
        if (reading.thrownCode !== EGRESS_GUARD_CODE) {
          problems.push(`★ 抛出的错误码不是具名的 ${EGRESS_GUARD_CODE}，实际 ${String(reading.thrownCode)}`)
        }
        if (reading.localReadOk !== true) problems.push('守卫把本地读取也封死了 ⇒ 会掐死正常路径')
        /* 目标只记 origin/host —— 日志本身也要守住隐私边界 */
        const targets = reading.blockedTargets as string[]
        if (!targets.every((target) => !target.includes('/would-be-egress'))) {
          problems.push('★ 守卫把完整 URL 记进了日志 ⇒ 日志本身泄漏')
        }
        return problems
      },
    })
  )

  probes.push(
    await probe({
      id: 'worker-installs-guard-before-loading-inference',
      question: '① 编码子进程在**加载推理库之前**安装守卫（静态核对安装位置）',
      run: () => {
        const source = readFileSync(
          join(REPO_ROOT, 'src/infrastructure/semantic/encoder-worker-entry.ts'),
          'utf8'
        )
        const guardAt = source.indexOf('installNoEgressGuard()')
        const transformersAt = source.indexOf("from '@huggingface/transformers'")
        const manifestAt = source.indexOf("from './embedding-manifest.ts'")
        return {
          guardInstalled: guardAt >= 0,
          guardBeforeManifestImport: guardAt >= 0 && manifestAt >= 0 && guardAt < manifestAt,
          /* 该入口**不**静态 import 推理库（它按路径动态解析），所以这里只保证顺序约束 */
          dynamicResolutionOnly: transformersAt < 0,
          allowRemoteModelsFalse: source.includes('allowRemoteModels = false'),
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.guardInstalled !== true) problems.push('★ 子进程入口没有安装不出站守卫')
        if (reading.guardBeforeManifestImport !== true) {
          problems.push('★ 守卫不在其它 import 之前 ⇒ 推理库初始化期间仍可能出站')
        }
        if (reading.allowRemoteModelsFalse !== true) {
          problems.push('子进程必须仍然设置 `allowRemoteModels = false`（守卫是**加固**，不是替代）')
        }
        return problems
      },
    })
  )

  /* ---- 真库布景：哨兵同时进入**记忆取值**与**查询句** ---- */
  await resetPluginSqlConnection()
  isolateDatabase('m95-wp8-privacy', { keep: false })
  const bed = await createM55Harness({ label: 'm95-wp8-privacy' })
  const h = bed.h
  const db = h.db

  const evidence = await h.recordUserEvidence(`记住：我的暗号是 ${SENTINEL}。`)
  const target = await h.commitAndFold(
    h.makeCandidate('person_fact', claim('profile.passphrase', SENTINEL, h.user), {
      sourceRefs: [evidence.ref],
    }),
    M4_T0 + 100
  )
  const targetId = String(target?.id ?? '')
  /* 再放两条普通记忆，让链路有内容可筛 */
  for (let i = 0; i < 2; i += 1) {
    const filler = await h.recordUserEvidence(`记住：我在练钢琴第 ${String(i)} 首。`)
    await h.commitAndFold(
      h.makeCandidate('preference', claim('preference.hobby.recent', `钢琴-${String(i)}`, h.user), {
        sourceRefs: [filler.ref],
      }),
      M4_T0 + 200 + i
    )
  }

  const deterministicProbe: MemorySemanticProbe = {
    name: 'gate-privacy-deterministic',
    score: async (input) => {
      const scores = new Map<string, number>()
      for (const id of input.memoryIds) scores.set(String(id), String(id) === targetId ? 0.95 : 0.2)
      return scores.size > 0 ? { ok: true, scores } : { ok: false, reason: 'missing_score' }
    },
  }

  const digestBefore = await tableDigest(db)
  const port = createMemoryRetrievalStore({
    store: h.store,
    integrity: (owner) => memoryIntegrityProblems(db, owner),
    rootReadings: (ids) => rootReadingsByMemory(db, ids),
    semanticProbe: deterministicProbe,
  })
  const recallPort = createRecallTurnPort({
    service: createMemoryRecallService({ port }),
    budget: DEFAULT_CONTEXT_BUDGET,
    now: () => M4_T0 + 10_000,
  })
  const outcome = await recallPort.run(
    createRecallRequest({
      traceId: newTraceId(),
      characterId: String(h.characterId),
      user: entityRef('user', String(h.user.id)),
      query: { text: `我的暗号是 ${SENTINEL} 吗？`, source: 'user_message' },
      intent: 'current_fact',
      candidateLimit: 10,
      contextBudget: { memoryTokens: DEFAULT_CONTEXT_BUDGET.memoryTokens },
      retrievalPolicyVersion: 'hybrid-relevance@1',
      semanticMode: 'on',
    })
  )
  const digestAfter = await tableDigest(db)

  /* ---- ② 诊断不泄漏（哨兵必须**在** selection 里、**不在**诊断里） ---- */
  probes.push(
    await probe({
      id: 'sentinel-reaches-context-but-not-diagnostics',
      question: '② 哨兵**在** `selection`（正控）而**不在** trace / 决策记录 / bundleTrace（负控）',
      run: () => {
        const selectionJson = JSON.stringify(outcome.selection)
        const traceJson = JSON.stringify(outcome.trace)
        const recordJson = JSON.stringify(outcome.record)
        const bundleTraceJson = JSON.stringify(outcome.bundleTrace)
        return {
          inSelection: selectionJson.includes(SENTINEL),
          inTrace: traceJson.includes(SENTINEL),
          inRecord: recordJson.includes(SENTINEL),
          inBundleTrace: bundleTraceJson.includes(SENTINEL),
          selectionBytes: selectionJson.length,
          traceBytes: traceJson.length,
          recordBytes: recordJson.length,
          bundleTraceBytes: bundleTraceJson.length,
          selectedTarget: outcome.trace.selectedIds.includes(targetId),
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        /* ★ 正控：哨兵必须真的在场上（否则负控是空的） */
        if (reading.inSelection !== true) {
          problems.push('★ 正控失败：哨兵没进上下文 ⇒ 后面的"不在诊断里"证明不了任何事')
        }
        if (reading.selectedTarget !== true) problems.push('布景：目标应被选中')
        for (const key of ['inTrace', 'inRecord', 'inBundleTrace'] as const) {
          if (reading[key] !== false) problems.push(`★ 哨兵出现在 ${key} 里 ⇒ 诊断泄漏私人正文`)
        }
        return problems
      },
    })
  )

  /* ---- ③ 查询零写 ---- */
  probes.push(
    await probe({
      id: 'retrieval-makes-zero-writes',
      question: '③ 一次检索**不改动任何表**：逐行摘要前后逐字相同',
      run: () => ({
        identical: digestBefore === digestAfter,
        beforeLines: digestBefore.split('\n').length,
        afterLines: digestAfter.split('\n').length,
        beforeDigest: sha256(digestBefore),
        afterDigest: sha256(digestAfter),
        /* 计数型自检：摘要里必须真有表（0 张表 vs 全部一致在输出上长得一样） */
        tablesDigested: digestBefore.split('\n').filter((line) => !line.endsWith('=absent')).length,
      }),
      judge: (reading) => {
        const problems: string[] = []
        if (Number(reading.tablesDigested) <= 0) problems.push('没摘到任何表 ⇒ MEASUREMENT INVALID')
        if (reading.identical !== true) problems.push('★ 检索改动了表 ⇒ 违反"查询零写"')
        return problems
      },
    })
  )

  await bed.dispose()
  const realDbAfter = safeTreeDigest()
  const realDbUnchanged = JSON.stringify(realDbBefore) === JSON.stringify(realDbAfter)

  /* ---- ④ 证据档本身也不许含哨兵 ---- */
  const unexpected = probes.filter((item) => item.verdict === 'unexpected').length
  const selfCheck = selfCheckMeasurement({ measuredCount: probes.length, notRunCount: 0, failedCount: unexpected })

  const payload = {
    schemaVersion: 'm9.5-privacy@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies:
        '无私人文本出站（结构性守卫两向）/ 诊断不泄漏（哨兵在 selection 而**不在** trace·record·bundleTrace）/ 查询零写（逐行摘要前后逐字相同）',
      sentinelPolicy:
        '哨兵串**只**出现在本档的"计数与布尔"里；门的读数刻意**不**把正文写进证据（下面自检会核对）',
      notProves:
        '**不**证明本机之外的其它路径不出站（例如 M5.5 的搜索能力 —— 那有自己的授权与账本）；' +
        '也**不**证明操作系统级网络隔离',
    },
    probes,
    measurement: { selfCheck, measuredCount: probes.length, unexpectedVerdictCount: unexpected },
    realDbProtection: { before: realDbBefore, after: realDbAfter, unchanged: realDbUnchanged },
  }
  const payloadJson = JSON.stringify(payload, null, 2)
  const evidencePath = join(runDir, 'privacy-verify.json')
  writeFileSync(evidencePath, `${payloadJson}\n`, 'utf8')

  /* 证据档的**后置**自检：如果读数把正文带进来了，这里必须报出来 */
  const evidenceLeaksSentinel = readFileSync(evidencePath, 'utf8').includes(SENTINEL)
  if (evidenceLeaksSentinel) {
    process.stdout.write('  [unexpected] evidence-file-contains-sentinel ⇒ 证据档自身泄漏了正文\n')
    process.exitCode = 3
  }

  const tree = sourceTreeReading(REPO_ROOT)
  const manifestPath = writeM95Manifest(runDir, {
    runId,
    stage: 'wp8',
    lane: 'offline',
    startedAt: STARTED_AT,
    completedAt: new Date().toISOString(),
    head: gitOrNull(['rev-parse', 'HEAD']),
    headShort,
    branch: gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyPaths: dirtyPaths(REPO_ROOT),
    sourceTreeHash: tree.treeSha256,
    sourceTreeHashDefinition: tree.definition,
    gateVersion: GATE_VERSION,
    dbKind: 'synthetic',
    isolationProof: {
      sandboxIsolationUsed: true,
      realDbDigestBefore: realDbBefore,
      realDbDigestAfter: realDbAfter,
      realDbUnchanged,
      method: 'isolateDatabase() + digestTree() 前后比对（只读）',
    },
    configHash: { sentinelPolicy: 'counts-and-booleans-only', egressGuard: EGRESS_GUARD_CODE },
    command: [{ cmd: 'pnpm m9.5:privacy:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS' && !evidenceLeaksSentinel,
    measuredCount: probes.length,
    notRunCount: 0,
    counts: { total: probes.length, passed: probes.length - unexpected, failed: unexpected },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    artifactHashes: { 'privacy-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 WP8 隐私门：${runId}`,
      ...probes.map((item) => `  [${item.verdict}] ${item.id}${item.error === null ? '' : ` ⇒ ${item.error}`}`),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  证据档含哨兵：${String(evidenceLeaksSentinel)}（必须为 false）`,
      `  真实库前后摘要相同：${String(realDbUnchanged)}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS' || evidenceLeaksSentinel) process.exitCode = 3
}

await main()
