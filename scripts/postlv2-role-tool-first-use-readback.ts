/**
 * 角色自选工具 · **首轮使用读回**（FIRST-USE 的机器读数；**只读**，且**绝不打开真实库**）。
 *
 * ============================================================================
 *  它读的是什么
 * ============================================================================
 * ```text
 * 真实对话**已经发生过**之后，系统自己在会话收尾时留了一份 **verified 快照**
 *   （`data/snapshots/<id>` + `<id>.manifest.json`，`operationKind=chat` / cleanClose=true）。
 * 本支把那份快照**复制**到 %TEMP%，在**副本**上做 SELECT-only 读回：
 *   · 最近的几轮 trace 里有没有**角色决策**那一步（有 ⇒ FIRST-USE OBSERVED）
 *   · 分支是什么（tools / answer / clarify / failed:超时…）
 *   · 那一轮有没有真的动作（账本按 trace_id 对照）
 *   · 决策那一步的**时延**（计划书 §7 要求声明的代价）
 * ```
 * ⚠️ **三条安全边界**（都写死在代码里）：
 * ```text
 * ① **从不打开真实库**：只读快照副本；`PGLITE_DATA_DIR` 指向副本，
 *    并且**先判**"副本与真实库不重叠"（`isProductionDir`）才继续。
 * ② **只允许 SELECT**：唯一的查询口逐句检查首词，非 SELECT 直接拒绝（先例 `verify-m4-real-db`）。
 * ③ **不落正文**：证据里只有闭集码 / 计数 / 时延 —— 没有她的回复、没有文件内容。
 * ```
 *
 * ```bash
 * pnpm postlv2:role-tool:first-use:readback                 # 取最新快照
 * pnpm postlv2:role-tool:first-use:readback --snapshot <id>  # 指定快照
 * pnpm postlv2:role-tool:first-use:readback --turns 5        # 看最近几轮
 * ```
 */

import 'dotenv/config'

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { AgentRuntime, stringToUuid } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'

import { character } from '../src/character/index.ts'
import { allowProductionDatabase } from '../src/db/index.ts'
import { isProductionDir } from '../src/dev/sandbox.ts'
import { productionSnapshotRootOf } from '../src/infrastructure/persistence/production-open-guard.ts'

const REPO_ROOT = resolve(process.cwd())
const EVIDENCE_PARENT = 'artifacts/post-lv2/role-tool-decision'

function git(args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

interface Cli {
  readonly snapshot?: string
  readonly turns: number
}

function parseArgv(argv: readonly string[]): Cli {
  let snapshot: string | undefined
  let turns = 3
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--snapshot') {
      snapshot = argv[index + 1]
      index += 1
      continue
    }
    if (arg === '--turns') {
      turns = Number(argv[index + 1] ?? '3')
      index += 1
      continue
    }
    throw new Error(`不认识的参数：${arg}`)
  }
  return { ...(snapshot !== undefined ? { snapshot } : {}), turns }
}

/** 快照根下"最新的一份**带 manifest** 的快照"（manifest 最后写 ⇒ 判定 verified 要两者都在） */
function latestVerifiedSnapshot(root: string): string | undefined {
  if (!existsSync(root)) return undefined
  const candidates = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(root, `${name}.manifest.json`)))
    .sort()
  return candidates[candidates.length - 1]
}

async function main(): Promise<number> {
  const cli = parseArgv(process.argv.slice(2))
  const snapshotRoot = productionSnapshotRootOf()
  const snapshotId = cli.snapshot ?? latestVerifiedSnapshot(snapshotRoot)
  if (snapshotId === undefined) {
    process.stderr.write(`❌ 找不到任何 verified 快照：${snapshotRoot}\n`)
    return 2
  }
  const snapshotDir = join(snapshotRoot, snapshotId)
  if (!existsSync(snapshotDir)) {
    process.stderr.write(`❌ 快照目录不存在：${snapshotDir}\n`)
    return 2
  }
  const manifest = JSON.parse(
    readFileSync(join(snapshotRoot, `${snapshotId}.manifest.json`), 'utf8')
  ) as { createdAt?: string; fileCount?: number; nonVolatileTreeSha256?: string }

  const work = mkdtempSync(join(tmpdir(), 'lg-role-tool-first-use-'))
  const copyDir = join(work, 'pglite')
  cpSync(snapshotDir, copyDir, { recursive: true })
  if (isProductionDir(copyDir) || isProductionDir(work)) {
    process.stderr.write('❌ 拒绝运行：副本目录与真实库重叠\n')
    return 2
  }

  /*
   * 把隔离指示**先**设好，再动态 import 数据库层：这样 `initDatabase` 看到的是副本，
   * 而且**不会**触发生产状态机（它只为真实库目录而存在）。
   */
  process.env.PGLITE_DATA_DIR = copyDir
  process.env.PROJECT_LG_SANDBOX = copyDir
  allowProductionDatabase()
  const dbModule = (await import('../src/db/index.ts')) as unknown as {
    initDatabase: (runtime: AgentRuntime, plugin: unknown) => Promise<void>
  }
  const { initDatabase } = dbModule
  const dbHelpers = (await import('../src/infrastructure/persistence/db.ts')) as unknown as {
    getRawDb: (holder: unknown) => never
    exec: (db: never, query: unknown, context: string) => Promise<Record<string, unknown>[]>
  }
  const { getRawDb, exec } = dbHelpers

  const characterId = String(character.id ?? character.name)
  const userId = stringToUuid(`user-${process.env.USER_NAME ?? 'Alex'}`)
  const runtime = new AgentRuntime({
    character: character as never,
    plugins: [sqlPlugin] as never,
    conversationLength: 16,
    settings: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
      OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
      OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
    },
  })
  await initDatabase(runtime, sqlPlugin)
  const db = getRawDb(runtime)

  /* ② 只允许 SELECT 的唯一查询口（判据看**字符串首词**，与 `verify-m4-real-db` 同形） */
  const select = async (statement: string, label: string): Promise<Record<string, unknown>[]> => {
    const head = statement.trim().slice(0, 12).toLowerCase()
    if (!head.startsWith('select')) {
      throw new Error(`只读读回拒绝执行非 SELECT 语句（${label}）：${statement.slice(0, 120)}`)
    }
    return await exec(db, statement, label)
  }
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`

  const traces = await select(
    `select trace_id, started_at from character_traces where character_id = ${quote(characterId)}
     order by started_at desc limit ${String(Math.max(1, Math.min(20, cli.turns)))}`,
    'traces'
  )

  const turns: Record<string, unknown>[] = []
  let observed = false
  for (const row of traces) {
    const traceId = String(row.trace_id)
    const traceRow = await select(
      `select steps from character_traces where trace_id = ${quote(traceId)} limit 1`,
      'trace-steps'
    )
    const steps = (() => {
      const raw = traceRow[0]?.steps
      if (typeof raw === 'string') {
        try {
          return JSON.parse(raw) as { kind?: string; label?: string; startedAt?: number; finishedAt?: number; attributes?: Record<string, unknown> }[]
        } catch {
          return []
        }
      }
      return Array.isArray(raw) ? (raw as never[]) : []
    })()
    const decisionStep = steps.find(
      (step) => step.attributes !== undefined && (step.attributes.decision !== undefined || step.attributes.tool_decision === 'role')
    )
    const actionRows = await select(
      `select capability, status from character_action_events where trace_id = ${quote(traceId)} limit 20`,
      'actions'
    )
    if (decisionStep !== undefined) observed = true
    turns.push({
      traceId,
      startedAt: row.started_at ?? null,
      stepKinds: steps.map((step) => String(step.kind ?? '')),
      decision:
        decisionStep === undefined
          ? null
          : {
              branch: decisionStep.attributes?.branch ?? decisionStep.attributes?.decision ?? null,
              result: decisionStep.attributes?.result ?? null,
              stopped: decisionStep.attributes?.stopped ?? null,
              failure: decisionStep.attributes?.failure ?? null,
              /** 决策那一步的墙钟时延（动作段的整个窗口；无动作时≈决策调用本身） */
              durationMs:
                typeof decisionStep.startedAt === 'number' && typeof decisionStep.finishedAt === 'number'
                  ? decisionStep.finishedAt - decisionStep.startedAt
                  : null,
            },
      actions: [
        ...new Set(
          actionRows
            /* ⚠️ 一次动作在账本里有多行事件（requested / decided / executed …）；
               只有带 `status` 的那一行是**真的执行结果** ⇒ 按它去重才是"这一轮做了几件事" */
            .filter((item) => item.status !== null && item.status !== undefined)
            .map((item) => `${String(item.capability)}=${String(item.status)}`)
        ),
      ],
    })
  }

  const runId = `role-tool-first-use-${new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')}-${git(['rev-parse', '--short=8', 'HEAD']) || 'unknown'}`
  const runDir = join(REPO_ROOT, EVIDENCE_PARENT, runId)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    join(runDir, 'first-use.json'),
    `${JSON.stringify(
      {
        schemaVersion: 'role-tool-decision-first-use@1',
        runId,
        head: git(['rev-parse', 'HEAD']),
        at: new Date().toISOString(),
        source: {
          kind: 'verified-snapshot-copy',
          snapshotId,
          snapshotCreatedAt: manifest.createdAt ?? null,
          snapshotFileCount: manifest.fileCount ?? null,
          snapshotTreeSha256: manifest.nonVolatileTreeSha256 ?? null,
          note: '真实库**从未被打开**：只复制快照，并在副本上做 SELECT-only 读回',
        },
        /** ⚠️ 证据里**没有**她的回复、没有文件内容：只有闭集码 / 计数 / 时延 */
        modelCalls: 0,
        turns,
        verdict: observed ? 'FIRST-USE OBSERVED' : 'FIRST-USE NOT OBSERVED',
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  process.stdout.write(`[role-tool:first-use] 快照 ${snapshotId}（${String(manifest.createdAt ?? '?')}）\n`)
  for (const turn of turns) {
    const decision = turn.decision as { branch?: unknown; durationMs?: unknown } | null
    process.stdout.write(
      `[role-tool:first-use]   ${String(turn.traceId).slice(0, 18)}… 决策=${
        decision === null ? '(无)' : String(decision.branch ?? '?')
      } · 时延=${decision?.durationMs === null || decision?.durationMs === undefined ? '?' : `${String(decision.durationMs)}ms`}` +
        ` · 动作=[${(turn.actions as string[]).join(' ')}]\n`
    )
  }
  process.stdout.write(`[role-tool:first-use] 证据 = ${EVIDENCE_PARENT}/${runId}/first-use.json\n`)
  process.stdout.write(`[role-tool:first-use] overall = ${observed ? 'FIRST-USE OBSERVED' : 'FIRST-USE NOT OBSERVED'}\n`)
  /* ⚠️ 退出码：0 = 观测到；1 = 没观测到（那是**读数**，不是脚本失败） */
  return observed ? 0 : 1
}

process.exit(await main())
