/**
 * M7 WP0 —— TD-08 / TD-09 **准入实验**（`pnpm m7:wp0:admission`）。
 *
 * ============================================================================
 *  要测的命题（先写命题，再写量具）
 * ============================================================================
 * TD-08（召回排序前截最近 50 条）会不会让 M7 **漏掉关系所需的证据**？
 *
 *   M7 计划 §3.1.3：关系变化的依据是「受信的真实直接互动**事件**」。
 *   事件证据走的是 Processor/Job 的**事件区间读**（`conversationEventsInRange`，
 *   注释明写「Processor / Job 的输入」），不是记忆检索路径。
 *   ⇒ 本实验证明：事件区间读**没有** 50 条截断；它的界是**显式、可分页**的
 *     （缺省 200 / 钳制上限 2000），且分页能无缺口覆盖全区间。
 *
 *   对照面（TD-08 的事实仍然成立，不重跑）：记忆检索路径在**排序之前**切片
 *   `filtered.slice(0, query.limit)`（生产 limit=50 ⇒ 候选集最近 50 条）。
 *   该读数已由 M6 WP8 探针落盘（第 1 名可召回 / 第 51 名不可 / 最老一条不可），
 *   本脚本只做**代码事实的机器核对**（切片行仍在），不重跑旧门。
 *
 * TD-09（大库 NL 遗忘 target_ambiguous）会不会阻断 M7？
 *
 *   M7 的「纠正或撤回」（计划 §6 场景 11）走**关系域事件**的取代链
 *   （append + supersede，键是确定性的 owner→target），不经过 NL 遗忘路径。
 *   NL 遗忘的歧义拒绝码 `target_ambiguous` 只存在于记忆 NL 变更 / 行动协议 /
 *   召回资格三类文件里；事件账本与（未来的）关系投影路径对它**零依赖**。
 *   ⇒ 本脚本把这个「零依赖」做成机器检查：`target_ambiguous` 的命中文件集
 *     必须落在已知清单内；哪天关系路径里出现它，这条检查会变红。
 *
 * ============================================================================
 *  硬边界
 * ============================================================================
 *  · `isolateDatabase()` 一次性沙箱库（本文件顶部、任何数据库 import 之前）；
 *    真实库**从不被打开**（不取租约、不建连接、不迁移）。
 *  · 不调模型、不出站；纯本地读写沙箱。
 *  · 计数型自检：每条测量都有非零分母（AGENTS §6.8）。
 */
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m7-wp0-admission', { keep: false })

import { AgentRuntime, type Character } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { asConversationId } from '../src/kernel/contracts/index.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { createConversationLedger } from '../src/infrastructure/persistence/ledger.ts'
import { createM7RunId, openM7RunDir, writeM7Manifest } from './m7-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')

/** 种子事件数：刻意 > 200（缺省界）且 > 50（TD-08 的截断点）。 */
const SEED_COUNT = 250

// ---------------------------------------------------------------------------
// 量具：检查条目
// ---------------------------------------------------------------------------

interface Check {
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}

function check(id: string, label: string, expected: string, actual: string, pass: boolean): Check {
  return { id, label, expected, actual, pass }
}

// ---------------------------------------------------------------------------
// 静态代码事实（TD-08 对照面 / TD-09 零依赖）
// ---------------------------------------------------------------------------

function srcFilesUnder(dir: string): string[] {
  const out: string[] = []
  const visit = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name)
      if (entry.isDirectory()) visit(abs)
      else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(abs)
    }
  }
  visit(dir)
  return out
}

function rel(p: string): string {
  return relative(REPO_ROOT, p).split(/[\\/]/).join('/')
}

/** TD-09：`target_ambiguous` 的命中文件集必须落在记忆 NL 变更 / 行动 / 召回资格清单内。 */
const TD09_ALLOWED_FILES: readonly string[] = [
  'src/kernel/recall/eligibility.ts',
  'src/kernel/action/errors.ts',
  'src/kernel/action/gateway.ts',
  'src/kernel/action/policy.ts',
  'src/kernel/app/memory/response-truth.ts',
  'src/kernel/app/memory/explicit-service.ts',
  'src/kernel/app/memory/correction-fallback.ts',
]

function staticCodeFacts(): Check[] {
  const checks: Check[] = []

  // S1：记忆检索路径的「排序前切片」仍在（TD-08 事实成立，作为对照面被机器核对）
  const retrievalPath = join(REPO_ROOT, 'src/infrastructure/persistence/memory-retrieval-store.ts')
  const retrievalText = existsSync(retrievalPath) ? readFileSync(retrievalPath, 'utf8') : ''
  const hasSlice = retrievalText.includes('filtered.slice(0, query.limit)')
  checks.push(
    check(
      'S1',
      'TD-08 对照面：记忆检索路径仍在排序前切片（filtered.slice(0, query.limit)）',
      '该行存在于 memory-retrieval-store.ts（生产 limit=50 ⇒ 候选集最近 50 条）',
      hasSlice ? '行仍在（对照面成立）' : '行不见了 —— 判据漂移，需人工复核本实验前提',
      hasSlice,
    ),
  )

  // S2：事件区间读是显式钳制（min(2000, limit)），且没有排序前切片
  const convStorePath = join(REPO_ROOT, 'src/infrastructure/persistence/conversation-store.ts')
  const convStoreText = existsSync(convStorePath) ? readFileSync(convStorePath, 'utf8') : ''
  const hasClamp = convStoreText.includes('Math.min(2000, limit)')
  const rangeFnPresent = convStoreText.includes('conversationEventsInRange')
  checks.push(
    check(
      'S2',
      '事件区间读的界是显式钳制（缺省 200 / 上限 2000），无排序前切片',
      'conversationEventsInRange 含 Math.min(2000, limit)',
      hasClamp && rangeFnPresent
        ? '钳制与区间函数都在（显式、可分页）'
        : `clamp=${String(hasClamp)} fn=${String(rangeFnPresent)} —— 判据漂移，需人工复核`,
      hasClamp && rangeFnPresent,
    ),
  )

  // S3：target_ambiguous 命中文件集 ⊆ 记忆 NL / 行动 / 召回资格清单
  const hits: string[] = []
  for (const abs of srcFilesUnder(join(REPO_ROOT, 'src'))) {
    const text = readFileSync(abs, 'utf8')
    if (text.includes('target_ambiguous')) hits.push(rel(abs))
  }
  const unexpected = hits.filter((h) => !TD09_ALLOWED_FILES.includes(h))
  checks.push(
    check(
      'S3',
      'TD-09：NL 遗忘的歧义拒绝码只存在于记忆 NL 变更 / 行动协议 / 召回资格文件',
      `命中集 ⊆ 已知 ${TD09_ALLOWED_FILES.length} 文件清单`,
      `命中 ${hits.length} 个文件${unexpected.length === 0 ? '（全部在清单内）' : `；清单外：${unexpected.join(', ')}`}`,
      unexpected.length === 0 && hits.length > 0,
    ),
  )

  return checks
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const runtime = new AgentRuntime({ character: character as Character, plugins: [], settings: {} })
  await initDatabase(runtime, sqlPlugin)
  await runtime.initialize()
  const kernel = await initKernel(runtime, {
    definition: characterDefinitionFromCharacter(character),
  })
  const db = kernel.stores.db
  const ledger = createConversationLedger({ db })
  const conversationId = asConversationId('m7-wp0-admission-conversation')

  // --- 种子：250 条用户直接互动事件（正控：全部 appended、零幂等命中） ---
  let appended = 0
  let idempotentHits = 0
  for (let i = 1; i <= SEED_COUNT; i += 1) {
    const outcome = await ledger.appendUserStatement({
      characterId: kernel.characterId,
      conversationId,
      userId: 'm7-wp0_admission_user',
      content: `m7-wp0 admission seed #${i}`,
      conversationSequence: i,
    })
    if (outcome.appended) appended += 1
    else idempotentHits += 1
  }
  const totalCount = await ledger.count(kernel.characterId)

  const checks: Check[] = []
  checks.push(
    check(
      'P1',
      '种子正控：250 次追加全部落库、零幂等命中、账本计数 = 250',
      `appended=250 · idempotent=0 · count=250`,
      `appended=${appended} · idempotent=${idempotentHits} · count=${totalCount}`,
      appended === SEED_COUNT && idempotentHits === 0 && totalCount === SEED_COUNT,
    ),
  )

  // --- 全量读一次（宽区间 + 钳制上限），推导实际序号范围 ---
  const wide = await ledger.listRange(kernel.characterId, 1, 1_000_000, 2000)
  const minSeq = wide[0]?.sequence ?? 0
  const maxSeq = wide[wide.length - 1]?.sequence ?? 0
  const span = maxSeq - minSeq + 1

  // M1：显式 limit=250 ⇒ 全区间可见（没有 50 条截断）
  const full = await ledger.listRange(kernel.characterId, minSeq, maxSeq, SEED_COUNT)
  checks.push(
    check(
      'M1',
      '事件区间读（显式 limit=250）看得到全部 250 条 —— 无 50 条截断',
      '250 条',
      `${full.length} 条`,
      full.length === SEED_COUNT,
    ),
  )

  // M2：缺省 limit ⇒ 恰好 200（显式界，不是 50；界本身是文档化契约）
  const defaultLimit = await ledger.listRange(kernel.characterId, minSeq, maxSeq)
  checks.push(
    check(
      'M2',
      '缺省 limit 的界是 200（显式、文档化；与记忆检索的 50 是两回事）',
      '200 条',
      `${defaultLimit.length} 条`,
      defaultLimit.length === 200,
    ),
  )

  // M3：limit=2000（钳制上限）⇒ 全区间可见
  const ceiling = await ledger.listRange(kernel.characterId, minSeq, maxSeq, 2000)
  checks.push(
    check(
      'M3',
      '钳制上限 2000 允许一次读完全区间',
      '250 条',
      `${ceiling.length} 条`,
      ceiling.length === SEED_COUNT,
    ),
  )

  // M4：分页无缺口 —— 两段拼接 = 全集、无重叠、序号连续
  const splitAt = minSeq + 199
  const page1 = await ledger.listRange(kernel.characterId, minSeq, splitAt, 200)
  const page2 = await ledger.listRange(kernel.characterId, splitAt + 1, maxSeq, 200)
  const seq1 = new Set(page1.map((e) => e.sequence))
  const seq2 = new Set(page2.map((e) => e.sequence))
  const overlap = [...seq1].filter((s) => seq2.has(s)).length
  const unionSize = new Set([...seq1, ...seq2]).size
  const contiguous = unionSize === SEED_COUNT && overlap === 0 && span === SEED_COUNT
  checks.push(
    check(
      'M4',
      '分页覆盖：[min..min+199] + [min+200..max] 拼接 = 全集，无重叠无缺口',
      `并集=${SEED_COUNT} · 重叠=0 · 跨度=${SEED_COUNT}`,
      `并集=${unionSize} · 重叠=${overlap} · 跨度=${span}（${page1.length}+${page2.length}）`,
      contiguous,
    ),
  )

  // M5：负控对照 —— 第 51 条事件在区间读里**可见**（记忆检索路径的第 51 条不可达，
  //     那是 M6 WP8 已落盘的读数，这里只证明关系证据路径不受它影响）
  const byOrder = [...wide].sort((a, b) => a.sequence - b.sequence)
  const fiftyFirst = byOrder[50]
  const visibleViaRange = full.some((e) => e.sequence === fiftyFirst?.sequence)
  checks.push(
    check(
      'M5',
      '第 51 条事件经区间读可见（对照：记忆检索路径的第 51 条不可达 —— M6 WP8 探针）',
      '可见',
      fiftyFirst ? `sequence=${String(fiftyFirst.sequence)} 可见=${String(visibleViaRange)}` : '（种子不足 —— 不应发生）',
      visibleViaRange && fiftyFirst !== undefined,
    ),
  )

  // --- 静态代码事实 ---
  checks.push(...staticCodeFacts())

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const verdict = failed === 0 ? 'PASS' : 'FAIL'

  // --- 证据落盘 ---
  const head = (await gitHead()) ?? '(unknown)'
  const runId = createM7RunId({ wpId: 'wp0-admission', headShort: head })
  const dir = openM7RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm7-wp0-admission@1',
    runId,
    capturedAt: new Date().toISOString(),
    head,
    branch: 'feature/m7-relationship',
    sandbox: { label: 'm7-wp0-admission', keep: false, realDbOpened: false },
    propositions: {
      td08:
        'M7 关系证据路径（Processor/Job 事件区间读）不受记忆检索「排序前截 50」影响；' +
        '其界显式可分页（缺省 200 / 钳制 2000）',
      td09:
        'M7 关系纠正走关系域事件取代链（owner→target 确定性键），不经过 NL 遗忘路径；' +
        'target_ambiguous 对事件/投影路径零依赖',
    },
    seed: { requested: SEED_COUNT, appended, idempotentHits, count: totalCount, minSeq, maxSeq },
    td08ContrastCitation: {
      m6Wp8Evidence: 'artifacts/m6/m6-wp8-20260922-866f2fba5f27/retrieval-boundary.json',
      note:
        '记忆检索路径的 50 条截断读数（第 1 名可召回 / 第 51 名不可 / 最老一条不可）' +
        '以 M6 WP8 已落盘证据为准，本实验不重跑旧门，只机器核对切片行仍在（S1）',
    },
    td09AllowedFiles: TD09_ALLOWED_FILES,
    checks,
    verdict,
    counts: { total: checks.length, passed, failed },
  }
  writeFileSync(join(dir, 'admission.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM7Manifest(dir, {
    runId,
    wp: 'wp0-admission',
    head,
    headShort: head.slice(0, 12),
    branch: 'feature/m7-relationship',
    date: payload.capturedAt.slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'admission',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes: 'TD-08/09 准入实验：事件区间读无 50 截断；target_ambiguous 对关系路径零依赖',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label}`)
    console.log(`      期望 ${c.expected} · 实测 ${c.actual}`)
  }
  console.log(`verdict: ${verdict}（${passed}/${checks.length}）`)

  await runtime.stop()
  process.exitCode = failed === 0 ? 0 : 1
}

function gitHead(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
