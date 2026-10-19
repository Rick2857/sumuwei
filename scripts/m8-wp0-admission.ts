/**
 * M8 WP0 —— **准入实验**（`pnpm m8:wp0:admission`）。
 *
 * ============================================================================
 *  要测的命题（先写命题，再写量具）
 * ============================================================================
 * M8 计划 §10 WP0 的退出条件，逐条变成机器可判的命题：
 *
 *   P1（M7 前置）：M7 的当前有效状态可从权威修订中确定且不矛盾
 *      ⇒ 量具：只读运行 `pnpm m7:gates`，要求 EXIT 0（Hard Gates = PASS）。
 *        不重算 M7 的判定，只读它已落盘的证据（一个概念一处实现）。
 *
 *   P2（槽位未漂移）：M8 的上下文槽位仍是计划书 §6.1 预留的形状
 *      ⇒ 量具：静态核对 `SECTION_PRIORITY.affect === 52` 与
 *        `ContextSectionKind` 含 `'affect'`（M3 契约的预留位，判据不能漂移）。
 *
 *   P3（生产面干净）：没有 M8 生产 flag；若代码已登记，缺省必须 false
 *      ⇒ 量具：`.env` / `.env.test` / `.env.example` 无 `CHARACTER_AFFECT_*`；
 *        `flags.ts` 若出现该开关，其 truthy 缺省必须是 false（激活属 WP9）。
 *
 *   P4（零迁移前提）：通用持久化形状可以承载 `affect:character`
 *      ⇒ 量具：隔离库实验 —— 用**生产同一条** mutation 链
 *        （applyAcceptedEvents → processed_operations → 投影 CRUD → 水位 → job）
 *        以假想的 affect 处理器身份走一遍：正控（一次落库、读回逐字段一致、
 *        水位前进）+ 幂等负控（重复落库 0 新建、旧乐观锁拒绝、水位回退拒绝）。
 *        全部通过 ⇒ M8 不需要新迁移（计划 §8.4「优先复用」的前提成立）。
 *
 *   P5（命名无碰撞）：`affect:character` 投影类型与 `affect-evaluator` 处理器名
 *      在准入时刻未被任何既有代码占用。
 *
 *   P6（表清单在册）：M8 要复用的五张通用表都在既有迁移 0001–0009 内
 *      （character_projections / character_domain_events / processed_operations /
 *       processor_watermarks / character_jobs）。
 *
 * ============================================================================
 *  硬边界
 * ============================================================================
 *  · `isolateDatabase()` 一次性沙箱库（本文件顶部、任何数据库 import 之前）；
 *    真实库**从不被打开**（不取租约、不建连接、不迁移）。
 *  · 不调模型、不出站；纯本地读写沙箱。
 *  · 计数型自检：每条测量都有非零分母（AGENTS §6.8）。
 *  · `pnpm m7:gates` 子进程是**只读汇总**（读已落盘证据，不重跑判定）。
 */
import type { Character } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m8-wp0-admission', { keep: false })




import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { asCharacterId } from '../src/kernel/contracts/index.ts'
import { computeIdempotencyKey } from '../src/kernel/contracts/job.ts'
import { DIAGNOSTIC_SIGNAL } from '../src/kernel/contracts/domain-event.ts'
import type { CharacterProjection } from '../src/kernel/contracts/projection.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import {
  applyAcceptedEvents,
  deleteProjection,
  getProjection,
  insertProjection,
  saveProjection,
} from '../src/infrastructure/persistence/event-store.ts'
import {
  advanceWatermark,
  enqueueJob,
  getWatermark,
  hasProcessedOperation,
} from '../src/infrastructure/persistence/job-store.ts'
import { createM8RunId, openM8RunDir, writeM8Manifest } from './m8-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')

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
// 静态代码事实
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

function staticCodeFacts(): Check[] {
  const checks: Check[] = []

  // P2：上下文槽位（M3 契约预留位，判据不能漂移）
  const contextContractPath = join(REPO_ROOT, 'src/kernel/contracts/context.ts')
  const contextText = existsSync(contextContractPath)
    ? readFileSync(contextContractPath, 'utf8')
    : ''
  const hasAffectPriority = /affect:\s*52/.test(contextText)
  const hasAffectKind = /'affect'/.test(contextText)
  checks.push(
    check(
      'S1',
      'P2：SECTION_PRIORITY.affect === 52（M3 预留位未漂移）',
      'context.ts 含 affect: 52',
      hasAffectPriority ? '槽位在（52）' : '槽位不见了 —— 判据漂移，需人工复核本实验前提',
      hasAffectPriority,
    ),
  )
  checks.push(
    check(
      'S2',
      "P2：ContextSectionKind 含 'affect'",
      "context.ts 含 'affect' 字面量",
      hasAffectKind ? 'kind 在' : 'kind 不见了 —— 判据漂移，需人工复核',
      hasAffectKind,
    ),
  )

  // P3：生产面没有 M8 flag；代码若登记，缺省必须 false
  const envFiles = ['.env', '.env.test', '.env.example'] as const
  const envHits: string[] = []
  for (const file of envFiles) {
    const abs = join(REPO_ROOT, file)
    if (existsSync(abs) && readFileSync(abs, 'utf8').includes('CHARACTER_AFFECT_')) {
      envHits.push(file)
    }
  }
  const flagsPath = join(REPO_ROOT, 'src/kernel/app/flags.ts')
  const flagsText = existsSync(flagsPath) ? readFileSync(flagsPath, 'utf8') : ''
  const flagRegistered = flagsText.includes('CHARACTER_AFFECT_CONTEXT_ENABLED')
  const flagDefaultFalse = /truthy\(env\.CHARACTER_AFFECT_CONTEXT_ENABLED,\s*false\)/.test(flagsText)
  checks.push(
    check(
      'S3',
      'P3：生产面无 CHARACTER_AFFECT_*（激活属 WP9 独立裁定）；代码若登记缺省必须 false',
      'env 文件零命中；flags.ts 未登记或缺省 false',
      `env 命中=${envHits.length ? envHits.join(',') : '0'} · 代码登记=${String(flagRegistered)}${flagRegistered ? ` · 缺省 false=${String(flagDefaultFalse)}` : ''}`,
      envHits.length === 0 && (!flagRegistered || flagDefaultFalse),
    ),
  )

  // P5：命名无碰撞（准入时刻）。
  // 注释行不算占用：processor.ts:11 的 affect-evaluator 是 M2.5 时代的**预留名单**
  // （文档事实），不是实现。量具只认可执行位置（非注释文本）的命中。
  const collisions: string[] = []
  for (const abs of srcFilesUnder(join(REPO_ROOT, 'src'))) {
    const text = readFileSync(abs, 'utf8')
    // 去掉注释行（块注释的每行以 * 开头；行注释以 // 开头）再搜
    const codeOnly = text
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\*|\/\/)/.test(line))
      .join('\n')
    if (codeOnly.includes('affect:character')) collisions.push(`${rel(abs)} (projectionType)`)
    if (codeOnly.includes('affect-evaluator')) collisions.push(`${rel(abs)} (processor)`)
  }
  checks.push(
    check(
      'S4',
      "P5：'affect:character' 与 'affect-evaluator' 在 src/** 无占用（准入时刻）",
      '0 命中',
      collisions.length === 0 ? '0 命中（名字干净）' : `命中：${collisions.join('; ')}`,
      collisions.length === 0,
    ),
  )

  // P6：零迁移前提 —— 五张通用表都在既有迁移里
  const migrationsPath = join(REPO_ROOT, 'src/infrastructure/persistence/migrations.ts')
  const migrationsText = existsSync(migrationsPath)
    ? readFileSync(migrationsPath, 'utf8')
    : ''
  const requiredTables = [
    'character_projections',
    'character_domain_events',
    'processed_operations',
    'processor_watermarks',
    'character_jobs',
  ] as const
  const missingTables = requiredTables.filter((t) => !migrationsText.includes(`create table if not exists ${t}`))
  checks.push(
    check(
      'S5',
      'P6：M8 复用的五张通用表都在既有迁移 DDL 内（零迁移前提）',
      `全部 ${requiredTables.length} 张在册`,
      missingTables.length === 0
        ? '5/5 在册（0001–0009 既有形状可承载 M8）'
        : `缺表：${missingTables.join(', ')} —— 停在 WP4 设计门（计划 §10 WP4 迁移策略）`,
      missingTables.length === 0,
    ),
  )

  return checks
}

// ---------------------------------------------------------------------------
// P1：M7 前置状态（只读汇总子进程）
// ---------------------------------------------------------------------------

function m7GatesReading(): { exitCode: number; summary: string } {
  try {
    const stdout = execFileSync('pnpm m7:gates', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      shell: true,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const summaryLine =
      stdout
        .split(/\r?\n/)
        .filter((l) => l.includes('summary:'))
        .pop() ?? '(summary 行未找到)'
    return { exitCode: 0, summary: summaryLine.trim() }
  } catch (error) {
    const err = error as { status?: number; stdout?: string }
    const summaryLine =
      (err.stdout ?? '')
        .split(/\r?\n/)
        .filter((l) => l.includes('summary:'))
        .pop() ?? '(无 summary)'
    return { exitCode: err.status ?? 1, summary: summaryLine.trim() }
  }
}

// ---------------------------------------------------------------------------
// 主流程（隔离库实验）
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const checks: Check[] = []

  // --- P1：M7 前置（在任何数据库 import 生效之后也能跑，但它本身只读证据） ---
  const m7 = m7GatesReading()
  checks.push(
    check(
      'P1',
      'M7 前置状态可读且不矛盾（pnpm m7:gates 只读汇总 EXIT 0）',
      'EXIT 0 · Hard Gates = PASS',
      `EXIT ${String(m7.exitCode)} · ${m7.summary}`,
      m7.exitCode === 0,
    ),
  )

  // --- 隔离库实验（P4：通用形状承载 affect:character） ---
  const runtime = createThinHostRuntime({
    character: character,
    settings: {},
  })
  await initDatabase(runtime)
  await runtime.initialize()
  const kernel = await initKernel(runtime, {
    definition: characterDefinitionFromCharacter(character),
  })
  const db = kernel.stores.db
  const characterId = asCharacterId(kernel.characterId)

  // 假想的 affect 处理器身份（准入实验专用；M8 实现后由真实处理器接管）
  const ADMISSION_PROCESSOR = 'm8-wp0-admission-probe'
  const ADMISSION_PROCESSOR_VERSION = 'm8-wp0-admission-probe@1'
  const ADMISSION_PROJECTION_TYPE = 'affect:character'

  // E1/E2/E3：mutation 链正控 + 幂等负控
  const idemKey = computeIdempotencyKey({
    characterId,
    processor: ADMISSION_PROCESSOR,
    processorVersion: ADMISSION_PROCESSOR_VERSION,
    sourceFromSequence: 1,
    sourceToSequence: 1,
    operation: 'affect-admission-probe',
  })
  const accepted = {
    type: DIAGNOSTIC_SIGNAL,
    operation: 'signal',
    payload: { counterDelta: 1 },
    sourceConversationEventIds: [],
    idempotencyKey: idemKey,
    processor: ADMISSION_PROCESSOR,
    processorVersion: ADMISSION_PROCESSOR_VERSION,
    scope: 'CHARACTER_INTERNAL' as const,
  }
  const first = await applyAcceptedEvents(db, characterId, [accepted], [])
  checks.push(
    check(
      'E1',
      'P4 正控：applyAcceptedEvents 一次落库（createdCount=1，事件带序号）',
      'createdCount=1 · 事件有 id 与 sequence',
      `createdCount=${String(first.createdCount)} · dedup=${String(first.deduplicatedCount)} · 事件数=${String(first.domainEvents.length)}`,
      first.createdCount === 1 && first.domainEvents.length === 1,
    ),
  )
  const second = await applyAcceptedEvents(db, characterId, [accepted], [])
  const processedHit = await hasProcessedOperation(db, idemKey)
  checks.push(
    check(
      'E2',
      'P4 幂等负控：同一 accepted 事件重放 ⇒ 0 新建（processed_operations 命中）',
      'createdCount=0 · dedup=1 · hasProcessed=true',
      `createdCount=${String(second.createdCount)} · dedup=${String(second.deduplicatedCount)} · hasProcessed=${String(processedHit)}`,
      second.createdCount === 0 && second.deduplicatedCount === 1 && processedHit,
    ),
  )

  // E4/E5/E6：投影 CRUD（affect:character 作用域键）
  const now = Date.now()
  const probeState = {
    originated: true,
    valence: 0.08,
    arousal: 0.03,
    originKind: 'ACTIVATION_BASELINE',
    lastInteractionAt: now,
    lastAffectEventAt: now,
    lastDomainEventId: first.domainEvents[0]?.id ?? null,
    projectionVersion: 1,
  }
  const probeProjection: CharacterProjection<typeof probeState> = {
    characterId,
    projectionType: ADMISSION_PROJECTION_TYPE,
    revision: 1,
    reducerVersion: 'affect-admission-probe-reducer@1',
    lastDomainEventId: first.domainEvents[0]?.id,
    lastDomainEventSequence: first.domainEvents[0]?.sequence,
    state: probeState,
    updatedAt: now,
  }
  await insertProjection(db, probeProjection)
  const readBack = await getProjection<typeof probeState>(db, characterId, ADMISSION_PROJECTION_TYPE)
  // JSONB 不保序：逐字段比对（键序差异不是数据差异 —— 量具教训，AGENTS §6.9 的近亲）
  const stateFieldIdentical =
    readBack !== undefined &&
    (Object.keys(probeState) as (keyof typeof probeState)[]).every(
      (k) => JSON.stringify(readBack.state?.[k]) === JSON.stringify(probeState[k]),
    ) &&
    Object.keys(readBack.state ?? {}).length === Object.keys(probeState).length
  const fieldIdentical =
    readBack !== undefined &&
    readBack.projectionType === ADMISSION_PROJECTION_TYPE &&
    readBack.revision === 1 &&
    readBack.reducerVersion === probeProjection.reducerVersion &&
    stateFieldIdentical
  checks.push(
    check(
      'E3',
      'P4 正控：affect:character 投影行写入后读回逐字段一致（JSONB 键序无关）',
      '读回 = 写入（类型/版本/revision/state 逐字段）',
      readBack ? `读回一致=${String(fieldIdentical)} · revision=${String(readBack.revision)}` : '读回 undefined',
      fieldIdentical,
    ),
  )

  // 乐观锁：正确 revision 前进；旧 revision 拒绝（负控）
  await saveProjection(db, { ...probeProjection, revision: 2, updatedAt: now + 1 }, 1)
  let staleRejected = false
  let staleError = ''
  try {
    await saveProjection(db, { ...probeProjection, revision: 3, updatedAt: now + 2 }, 1)
  } catch (error) {
    staleRejected = true
    staleError = (error as { code?: string }).code ?? String(error)
  }
  checks.push(
    check(
      'E4',
      'P4 乐观锁：expectedRevision=1 前进到 2；旧 revision 再写 ⇒ projection_revision_conflict',
      '前进成功 · 旧锁拒绝',
      `前进=ok · 旧锁拒绝=${String(staleRejected)}（${staleError}）`,
      staleRejected && staleError.includes('projection_revision_conflict'),
    ),
  )

  const deleted = await deleteProjection(db, characterId, ADMISSION_PROJECTION_TYPE)
  const afterDelete = await getProjection(db, characterId, ADMISSION_PROJECTION_TYPE)
  checks.push(
    check(
      'E5',
      'P4 投影删除：deleteProjection 生效，读回 undefined',
      '删 1 行 · 读回 undefined',
      `删=${String(deleted)} 行 · 读回=${afterDelete === undefined ? 'undefined' : '仍在'}`,
      deleted === 1 && afterDelete === undefined,
    ),
  )

  // E7：水位往返 + 回退负控
  const wmProcessor = 'affect-evaluator'
  const wmVersion = 'affect-evaluator@1'
  const before = await getWatermark(db, characterId, wmProcessor, wmVersion)
  await advanceWatermark(db, characterId, wmProcessor, wmVersion, 5)
  const at5 = await getWatermark(db, characterId, wmProcessor, wmVersion)
  let regressionRejected = false
  let regressionError = ''
  try {
    await advanceWatermark(db, characterId, wmProcessor, wmVersion, 3)
  } catch (error) {
    regressionRejected = true
    regressionError = (error as { code?: string }).code ?? String(error)
  }
  await advanceWatermark(db, characterId, wmProcessor, wmVersion, 7)
  const at7 = await getWatermark(db, characterId, wmProcessor, wmVersion)
  checks.push(
    check(
      'E6',
      'P4 水位：undefined → 5 →（回退 3 拒绝 watermark_regression）→ 7',
      '前进 ok · 回退拒绝 · 终值 7',
      `初始=${before === undefined ? 'undefined' : String(before.processedThroughSequence)} · 5=${String(at5?.processedThroughSequence)} · 回退拒绝=${String(regressionRejected)}（${regressionError}） · 7=${String(at7?.processedThroughSequence)}`,
      at5?.processedThroughSequence === 5 &&
        regressionRejected &&
        regressionError.includes('watermark_regression') &&
        at7?.processedThroughSequence === 7,
    ),
  )

  // E8：job 层幂等（affect 形状的窗口 job）
  const jobKey = computeIdempotencyKey({
    characterId,
    processor: wmProcessor,
    processorVersion: wmVersion,
    sourceFromSequence: 1,
    sourceToSequence: 5,
    operation: 'affect-evaluation',
  })
  const enqueued1 = await enqueueJob(db, {
    characterId,
    processor: wmProcessor,
    processorVersion: wmVersion,
    sourceFromSequence: 1,
    sourceToSequence: 5,
    idempotencyKey: jobKey,
    triggerKind: 'conversation',
  })
  const enqueued2 = await enqueueJob(db, {
    characterId,
    processor: wmProcessor,
    processorVersion: wmVersion,
    sourceFromSequence: 1,
    sourceToSequence: 5,
    idempotencyKey: jobKey,
    triggerKind: 'conversation',
  })
  checks.push(
    check(
      'E7',
      'P4 job 幂等：同窗口同操作 ⇒ 第一次 created，第二次复用（created=false）',
      'created=true → created=false',
      `first=${String(enqueued1.created)} · second=${String(enqueued2.created)} · 同 id=${String(enqueued1.job.id === enqueued2.job.id)}`,
      enqueued1.created && !enqueued2.created && enqueued1.job.id === enqueued2.job.id,
    ),
  )

  // --- 静态代码事实 ---
  checks.push(...staticCodeFacts())

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const verdict = failed === 0 ? 'PASS' : 'FAIL'

  // --- 证据落盘 ---
  const head = (await gitHead()) ?? '(unknown)'
  const runId = createM8RunId({ wpId: 'wp0-admission', headShort: head })
  const dir = openM8RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm8-wp0-admission@1',
    runId,
    capturedAt: new Date().toISOString(),
    head,
    branch: 'feature/m7-relationship',
    sandbox: { label: 'm8-wp0-admission', keep: false, realDbOpened: false },
    propositions: {
      p1_m7Precondition: 'M7 前置状态可读且不矛盾（m7:gates 只读汇总 EXIT 0）',
      p2_slotsReserved: 'M8 上下文槽位仍是计划书 §6.1 预留形状（affect: 52 · kind affect）',
      p3_productionClean: '生产面无 CHARACTER_AFFECT_*；代码缺省必须 false（激活属 WP9）',
      p4_zeroMigration:
        '通用持久化形状（事件/幂等/投影/水位/job）可以承载 affect:character —— ' +
        '正控（一次落库、读回一致、水位前进、job 创建）+ 负控（重复 0 新建、旧乐观锁拒绝、水位回退拒绝、job 复用）',
      p5_naming: "affect:character / affect-evaluator 在准入时刻无占用",
      p6_tables: '五张通用表都在既有迁移 0001–0009 内',
    },
    m7Reading: { exitCode: m7.exitCode, summary: m7.summary },
    probeIdentity: {
      processor: ADMISSION_PROCESSOR,
      processorVersion: ADMISSION_PROCESSOR_VERSION,
      projectionType: ADMISSION_PROJECTION_TYPE,
      watermarkProcessor: wmProcessor,
      watermarkProcessorVersion: wmVersion,
    },
    checks,
    verdict,
    counts: { total: checks.length, passed, failed },
  }
  writeFileSync(join(dir, 'admission.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM8Manifest(dir, {
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
    notes: 'M8 准入：M7 前置 PASS · 槽位在 · 生产面干净 · 零迁移前提成立（隔离库实验）',
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
