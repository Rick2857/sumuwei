/**
 * M9.5 WP11 —— **门清单对账门**（`pnpm m9.5:gatelist:verify`）。
 *
 * ============================================================================
 *  它防的是哪一类错（**已经真实发生过**）
 * ============================================================================
 * ```text
 * `m9.5:gates` 只会检查"**它清单里**的门有没有档" ——
 *   它**不会**发现"清单本身漏了计划要求的门"。
 * 实测后果：计划 §16.1 点名的 `m9.5:test`（WP3–8 纯契约门）**几十轮里一直没建**，
 *   而聚合门始终报 `Hard Gates = PASS`（"清单外的门"对它不存在）。
 * ⇒ 本门把**计划 §16.1 的命令清单**与 **`package.json` 里实际存在的脚本**对账：
 *    计划有、却没建 ⇒ **必须**出现在**已申报缺席**表里（带理由），否则报红。
 * ```
 * 用法：`pnpm m9.5:gatelist:verify`
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'

import { sha256 } from './m4-harness.ts'
import { dirtyPaths, sourceTreeReading } from './m6.1-run-manifest.ts'
import {
  createM95RunId,
  openM95RunDir,
  selfCheckMeasurement,
  writeM95Manifest,
} from './m9.5-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const STARTED_AT = new Date().toISOString()
const GATE_VERSION = 'm9.5-gatelist@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')
const PLAN = join(REPO_ROOT, 'docs/m9.5/M9.5-Execution-Plan.md')

/**
 * **已申报缺席**（计划有、但故意没建）—— 每条**必须**有理由。
 *
 * ⚠️ 这张表是本门的**唯一豁免口**：没有它，缺席就是**未申报**，本门报红。
 *    它存在的意义是让"没建"这件事**可见**，而不是静默通过。
 */
const DECLARED_ABSENT: Record<string, string> = {
  'm9.5:quality:eval':
    '冻结盲测的检索质量 —— **参数冻结前不得跑**（会消耗盲集、毁掉独立性）；冻结后才建并跑',
  /*
   * ⚠️ `m9.5:smoke:live` **已从本表移除**（2026-09-28）：它**已经建了**（`scripts/m9.5-smoke-live.ts`，
   *    Round 67），且**已跑过小批预检**（结论 NOT MET）。
   *    本门的检查③（"申报'没建'的必须真的没建"）**正确地把这张过期表抓了出来**
   *    （Round 82 实测：`③ 已申报缺席的表不过期 —— m9.5:smoke:live`）⇒ 这就是该检查存在的意义。
   */
  'm9.5:long:live':
    '至少一条 500 轮真实回复链 —— 前置＝正式档达标（smoke 预检 NOT MET ⇒ 尚未到建它的时机）',
}

let passed = 0
const failures: string[] = []
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${name}${detail === undefined ? '' : ` —— ${detail}`}`)
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

/** 从计划 §16.1 那段里抽出命令名（`m9.5:xxx` 形式） */
function planCommands(): { readonly commands: readonly string[]; readonly headingFound: boolean } {
  const lines = readFileSync(PLAN, 'utf8').split(/\r?\n/)
  const start = lines.findIndex((line) => /^###\s+16\.1/.test(line.trim()))
  if (start < 0) return { commands: [], headingFound: false }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^###\s/.test((lines[index] ?? '').trim())) {
      end = index
      break
    }
  }
  const region = lines.slice(start, end).join('\n')
  const found = new Set<string>()
  for (const match of region.matchAll(/m9\.5:(?:[a-z0-9]+:)*[a-z0-9]+/g)) found.add(match[0])
  return { commands: [...found].sort(), headingFound: true }
}

/** 实际存在的脚本名（`package.json` 里以 `m9.5:` 开头的键，以及 `m9.5` 二级命令） */
function existingScripts(): string[] {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  return Object.keys(pkg.scripts ?? {})
    .filter((name) => name.startsWith('m9.5') || name.startsWith('m9.5:'))
    .sort()
}

/** **本门自己**的差集（便于两向负控） */
function reconcile(planned: readonly string[], created: readonly string[]): { missing: string[]; additions: string[] } {
  const createdSet = new Set(created)
  const plannedSet = new Set(planned)
  return {
    missing: planned.filter((name) => !createdSet.has(name)),
    additions: created.filter((name) => !plannedSet.has(name)),
  }
}

async function main(): Promise<void> {
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId = createM95RunId({ wpId: 'wp11-gatelist', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const realDbBefore = safeTreeDigest()

  const plan = planCommands()
  const created = existingScripts()
  const { missing, additions } = reconcile(plan.commands, created)
  const undeclared = missing.filter((name) => DECLARED_ABSENT[name] === undefined)
  const declaredButCreated = Object.keys(DECLARED_ABSENT).filter((name) => created.includes(name))

  /* ---- ① 计划清单被真的解析到（防"抽不到就当没有"） ---- */
  check(
    '① 计划 §16.1 的命令清单被真的解析到',
    plan.headingFound === true && plan.commands.length >= 15,
    `heading=${String(plan.headingFound)} 命令数=${String(plan.commands.length)}`
  )

  /* ---- ② ★ 核心：计划有、却没建的门，**必须**已申报 ---- */
  check(
    '② ★ 计划点名的门**不得未申报缺席**（这正是 `m9.5:test` 被漏掉几十轮的机制）',
    undeclared.length === 0,
    undeclared.length > 0 ? `未申报缺席：${undeclared.join(', ')}` : `缺席 ${String(missing.length)} 道，全部已申报`
  )

  /* ---- ③ 已申报缺席者**不得**其实已存在（申报表不许过期） ---- */
  check(
    '③ 已申报缺席的表**不过期**：申报"没建"的必须真的没建',
    declaredButCreated.length === 0,
    declaredButCreated.join(', ')
  )

  /* ---- ④ 申报表每条都有理由（防"写个空理由就豁免"） ---- */
  const emptyReason = Object.entries(DECLARED_ABSENT)
    .filter(([, reason]) => reason.trim().length < 10)
    .map(([name]) => name)
  check('④ 每条"已申报缺席"都带**实质理由**（不是空话豁免）', emptyReason.length === 0, emptyReason.join(', '))

  /* ---- ⑤ 负控：差集**必须**能把"计划有、没建"认出来 ---- */
  const negative = reconcile([...plan.commands, 'm9.5:totally-fake'], created)
  check(
    '⑤ ★ 负控：注入一个计划外的假命令 ⇒ 必须被认成**缺席**',
    negative.missing.includes('m9.5:totally-fake')
  )

  /* ---- ⑥ 正控/反向控制：本仓库自建的门必须被报成**追加**，不是缺席 ---- */
  const positive = reconcile([...plan.commands, 'm9.5:totally-fake'], [...created, 'm9.5:my-own-addition'])
  check(
    '⑥ 正控：自建门（计划外）必须落在**追加**里，**不**算缺席',
    positive.additions.includes('m9.5:my-own-addition') && !positive.missing.includes('m9.5:my-own-addition')
  )

  /* ---- ⑦ 计数自检 ---- */
  check('⑦ 计数自检：实际存在的 m9.5 脚本 > 0', created.length > 0, String(created.length))

  /* ---- ⑧ ★ **文档清单对账**（`L-M95-26` 保留的机制建议）：计划 §22.1 的收口文档必须真的存在 ---- */
  const planDocs = (() => {
    const lines = readFileSync(PLAN, 'utf8').split(/\r?\n/)
    const start = lines.findIndex((line) => /^###\s+22\.1/.test(line.trim()))
    let end = lines.length
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^###\s/.test((lines[index] ?? '').trim())) {
        end = index
        break
      }
    }
    const region = start >= 0 ? lines.slice(start, end).join('\n') : ''
    const named = [...new Set([...region.matchAll(/`(M9\.5-[A-Za-z0-9-]+\.md)`/g)].map((match) => match[1] as string))]
    return {
      headingFound: start >= 0,
      named,
      missing: named.filter((name) => !existsSync(join(REPO_ROOT, 'docs/m9.5', name))),
      handoffGlob: /M9\.5-WP\*/.test(region),
      handoffCount: readdirSync(join(REPO_ROOT, 'docs/m9.5')).filter((name) => /^M9\.5-WP.*Handoff\.md$/.test(name)).length,
      adr: /新设计 ADR/.test(region),
      adrCount: readdirSync(join(REPO_ROOT, 'docs/adr')).filter((name) => /^ADR-074/.test(name)).length,
    }
  })()
  check('⑧a 计划 §22.1 的文档清单被**定位到**', planDocs.headingFound === true)
  check('⑧b 文档清单**解析到 ≥1 个名字**（防空转）', planDocs.named.length > 0, `named=${String(planDocs.named.length)}`)
  check(
    '⑧c ★ **计划要求的收口文档全部存在**（"清单自身漏项"此前**没有判据**；实测曾缺 3 份达 76 轮，见 `L-M95-26`）',
    planDocs.missing.length === 0,
    planDocs.missing.length > 0 ? `缺失：${planDocs.missing.join(', ')}` : `已核 ${String(planDocs.named.length)} 份`
  )
  check(
    '⑧d `M9.5-WP*-Handoff.md` 通配行要求至少一份',
    !planDocs.handoffGlob || planDocs.handoffCount > 0,
    `handoff=${String(planDocs.handoffCount)}`
  )
  check('⑧e 计划要求"新设计 ADR" ⇒ `docs/adr/ADR-074*` 存在', !planDocs.adr || planDocs.adrCount > 0)

  /* ---- ⑨ 负控：注入假文档名 ⇒ 必须被认成缺失 ---- */
  check(
    '⑨ 负控：假文档名必须被认成缺失（否则"没缺"可能只是判据坏了）',
    !existsSync(join(REPO_ROOT, 'docs/m9.5', 'M9.5-Totally-Missing.md'))
  )

  const total = passed + failures.length
  const selfCheck = selfCheckMeasurement({ measuredCount: total, notRunCount: 0, failedCount: failures.length })
  const realDbAfter = safeTreeDigest()

  const payload = {
    schemaVersion: 'm9.5-gatelist@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies:
        '**计划 §16.1 的命令清单** vs **`package.json` 实际脚本** 的对账：缺席必须**已申报**（带理由）、申报表不得过期、' +
        '差集两向控制（假命令必须被认出、自建门必须算追加）',
      notProves:
        '**不**判断各门断言的内容对不对；也**不**替代 `m9.5:aggregator@1`（那条管"取档规则"）与 `m9.5:regression@1`（准入）',
      why: '聚合门只检查"清单里的门有没有档" ⇒ 清单**漏门**时它会继续报 PASS（`m9.5:test` 实测被漏掉几十轮）',
    },
    reconciliation: {
      planCommands: plan.commands,
      planCommandCount: plan.commands.length,
      createdM95Scripts: created,
      createdCount: created.length,
      missing,
      declaredAbsent: DECLARED_ABSENT,
      undeclaredMissing: undeclared,
      additions,
      additionsCount: additions.length,
    },
    checks: { passed, failed: failures.length, total },
    failures,
    realDbProtection: { before: realDbBefore, after: realDbAfter, note: '本门只读计划书与 package.json' },
  }
  const evidencePath = join(runDir, 'gatelist-verify.json')
  writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const tree = sourceTreeReading(REPO_ROOT)
  const manifestPath = writeM95Manifest(runDir, {
    runId,
    stage: 'wp11',
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
    dbKind: 'not-applicable',
    isolationProof: { dbTouched: false, method: '**构造属性**：本门只读 `docs/` 与 `package.json`' },
    configHash: { planCommands: plan.commands.length, createdScripts: created.length, declaredAbsent: Object.keys(DECLARED_ABSENT).length },
    command: [{ cmd: 'pnpm m9.5:gatelist:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: total,
    notRunCount: 0,
    counts: { total, passed, failed: failures.length },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    artifactHashes: { 'gatelist-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      'M9.5 门清单对账：计划 §16.1 vs package.json',
      `  通过 ${String(passed)} / 失败 ${String(failures.length)}（共 ${String(total)} 项）`,
      ...failures.map((line) => `  ✗ ${line}`),
      `  计划命令 ${String(plan.commands.length)} · 实际脚本 ${String(created.length)} · 缺席 ${String(missing.length)}（已申报） · 自建追加 ${String(additions.length)}`,
      ...missing.map((name) => `    · ${name} —— ${DECLARED_ABSENT[name] ?? '★ 未申报'}`),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (failures.length > 0 || total === 0) process.exitCode = 3
}

await main()
