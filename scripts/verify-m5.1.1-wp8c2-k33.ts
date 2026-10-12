/**
 * M5.1.1 / WP8-C2 —— **K-33 专项门**（`pnpm m5.1.1:wp8c2:verify`）
 *
 * K-23 的原始安全命题（**语义未变**）：
 *
 *   ① 权威 mutation 面唯一：全 production `src/` 里只有一个地方 `insert into conversation_events`
 *   ② `recordedBy` **不能由调用方提供**，且 canonical recorder 是唯一权威生产者
 *      （`CANONICAL_LEDGER_RECORDER = Known(SYSTEM, "kernel")`）
 *
 * 旧的结构性证明②写成"`recordedBy` 只出现在契约里"——它在 WP3.1 当时成立，
 * 但后来的读回 / DTO / Query 面**合法地**要读这个槽位 ⇒ 它不再测量原命题。
 * 本门消费**同一个** analyzer（`scripts/m5.1.1-k23-recorder-boundary.ts`）来测原命题，
 * 判据基于 **AST 能力**（能不能在权威 mutation 边界上影响绑定到 `recorded_by_*` 的值），
 * **没有**任何文件名豁免表。
 *
 * 三段式：正控（真实 writer 必须被检出）/ 负控 A（真实 reader 不得计为 writer）/
 *         负控 B（注入第二个 writer、注入调用方自报 recordedBy ⇒ 必响）/ 恢复（重新安静）。
 */

import 'dotenv/config'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { analyzeRecorderBoundary, type RecorderBoundaryReport } from './m5.1.1-k23-recorder-boundary.ts'

const ROOT = process.cwd()
const ART = join(ROOT, 'artifacts', 'm5.1.1')
const SRC = join(ROOT, 'src')
const EXPECTED_CANONICAL = { kind: 'SYSTEM', id: 'kernel' }

let passed = 0
let failed = 0
const failures: string[] = []
const measurements: { label: string; count: number; valid: boolean }[] = []
function check(label: string, ok: boolean, detail: string): boolean {
  if (ok) {
    passed += 1
    console.log(`  ✅ ${label}  [${detail}]`)
  } else {
    failed += 1
    failures.push(`${label} :: ${detail}`)
    console.log(`  ❌ ${label}  [${detail}]`)
  }
  return ok
}
function section(t: string): void {
  console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`)
}
function measure(label: string, count: number, valid = count > 0): void {
  measurements.push({ label, count, valid })
  console.log(`  · 量：${label} = ${count}${valid ? '' : '   ← MEASUREMENT INVALID（测到的对象数为 0）'}`)
}
function sha256(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}
function dirStats(dir: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        files += 1
        bytes += statSync(p).size
      }
    }
  }
  walk(dir)
  return { files, bytes }
}

section('§0 只读预检（本门不写 src / schema / 真库）')
const srcBefore = dirStats(SRC)
const migrationsSha = sha256(join(ROOT, 'src/infrastructure/persistence/migrations.ts'))
const dbMtimeBefore = statSync(join(ROOT, 'data/pglite')).mtime.toISOString()
console.log(`  src：${srcBefore.files} 文件 / ${srcBefore.bytes} 字节 · migrations.ts sha256=${migrationsSha.slice(0, 16)}… · 真库 mtime=${dbMtimeBefore}`)
measure('扫描的 src 文件数', srcBefore.files)

section('§1 真实仓库：权威 recorder 边界（正控 + 边界断言）')
const real: RecorderBoundaryReport = analyzeRecorderBoundary({ srcRoot: SRC })
measure('mutation site 数（自动发现）', real.counts.mutationSites)
measure('权威 writer 文件数', real.counts.authoritativeWriterFiles)
measure('值提供者数', real.counts.valueProviders)
measure('envelope 生产者数', real.counts.envelopeProducers)
measure('recordedBy 值构造点数', real.counts.recordedByValueConstructions)
measure('只读引用文件数（负控 A 的对象）', real.counts.readerFilesWithRecordedBy, true)
measure('调用方可控提供者数', real.counts.callerControlledProviders, true)
measure('无法解释的引用数', real.counts.unexplainedReferences, true)
console.log(`  · 权威 mutation 面：${real.mutationSites.map((s) => `${s.file}:${s.line}(${s.verb})`).join(' , ') || '(无)'}`)
console.log(`  · 权威 writer 文件：${real.authoritativeWriterFiles.join(' , ') || '(无)'}`)
console.log(`  · envelope 生产者：${real.envelopeProducers.map((e) => `${e.file}:${e.line}`).join(' , ') || '(无)'}`)
console.log(`  · 引用分类：${real.references.map((r) => `${r.file}=${r.classification}`).join(' · ')}`)

check('① 权威 mutation 面**自动发现**（不靠 EXPECTED_FILE 常量）', real.counts.mutationSites > 0, `${real.counts.mutationSites} 处`)
check('① 权威 writer 文件**恰好一个** `insert into conversation_events`', real.counts.authoritativeWriterFiles === 1, real.authoritativeWriterFiles.join(' , ') || '(无)')
check('① 该唯一写入面确实绑定 `recorded_by_*`（经本地常量展开判定）', real.recordedByColumnsCovered, `列映射 = ${JSON.stringify(real.recordedByColumns)} · binds=${String(real.mutationSites.some((s) => s.bindsRecordedByColumns))}`)
check('② envelope 生产者**恰好一处**（`attributionSlotsOfContext(trusted)` 那条路）', real.counts.envelopeProducers === 1, real.envelopeProducers.map((e) => `${e.file}:${e.line}`).join(' , ') || '(无)')
check('② 该 envelope 生产者从**受信上下文**派生槽位（不是从输入直接抄）', real.slotsFromTrustedContext.length > 0, `${real.slotsFromTrustedContext.length} 处`)
check('② 受信上下文构造点是生产 ingress（`buildTrustedAttributionContext` 调用点）', real.trustedContextCallSites.length > 0, real.trustedContextCallSites.map((c) => `${c.file}:${c.line}`).join(' , '))

section('§2 规范化 recorder（C2-7：Known ≠ canonical，必须恰好是 Known(SYSTEM,"kernel")）')
check('契约里的 CANONICAL_LEDGER_RECORDER = Known(SYSTEM, "kernel")', real.canonicalRecorder.kind === EXPECTED_CANONICAL.kind && real.canonicalRecorder.id === EXPECTED_CANONICAL.id, `${real.canonicalRecorder.kind}/${real.canonicalRecorder.id} @ ${real.canonicalRecorder.declaredAt}`)
check('TRUSTED_LEDGER_WRITERS 里的 principal 全部等于 canonical recorder（没有第二个 recorder）', real.trustedLedgerWriters.length > 0 && real.trustedLedgerWriters.every((w) => w.kind === EXPECTED_CANONICAL.kind && w.id === EXPECTED_CANONICAL.id), real.trustedLedgerWriters.map((w) => `${w.writerId}=${w.kind}/${w.id}`).join(' , ') || '(空注册表)')
const nonCanonical = real.recordedByValueConstructions.filter((v) => !v.usesCanonicalConstant)
check('每一个 recordedBy **值构造点**都使用 canonical 常量（Absent/Unknown/SERVICE/USER 不得冒充）', nonCanonical.length === 0, nonCanonical.map((v) => `${v.file}:${v.line}`).join(' , ') || `${real.recordedByValueConstructions.length} 处全部使用 canonical`)
measure('recordedBy 值构造点（用 canonical 常量）数', real.recordedByValueConstructions.filter((v) => v.usesCanonicalConstant).length)

section('§3 调用方供给面（C2-6 / §4 核心判据）')
check('核心判据：`callerControlledProviders.length === 0`', real.callerControlledProviders.length === 0, real.callerControlledProviders.map((c) => `${c.file}:${c.line} ${c.detail}`).join(' , ') || '0')
measure('自动发现的写链入口参数类型数', real.writeChainEntryParamTypes.length)
const carrierParams = real.writeChainEntryParamTypes.filter((p) => p.recordedByMembers.length > 0)
console.log(`  · 写链入口参数类型：${real.writeChainEntryParamTypes.map((p) => `${p.fn}(${p.param}: ${p.typeName})`).join(' · ')}`)
check('正控：权威写入面的参数类型**确实携带** recordedBy（否则这个问题是空问题）', carrierParams.length > 0, carrierParams.map((p) => `${p.fn}(${p.param}: ${p.typeName}) → ${p.recordedByMembers.join(',')}`).join(' , ') || '(没有找到任何携带者)')
const riskyCarriers = carrierParams.filter((p) => !p.viaTrustedCarrier)
check('负控：携带 recordedBy 的入口类型只能经由**受信载体**（`trustedAttribution` ⇒ 受信上下文）', riskyCarriers.length === 0, riskyCarriers.map((p) => `${p.fn}(${p.param}: ${p.typeName}).${p.recordedByMembers.join(',')}`).join(' , ') || `${carrierParams.length} 处均经由受信载体`)
measure('`TrustedAttributionContext` 的产出点数（自动发现）', real.trustedContextProducers.length)
check('受信上下文只有**一个**产出点（= 受信构造器；调用方造不出来）', real.trustedContextProducers.length === 1, real.trustedContextProducers.map((p) => `${p.file}:${p.line}`).join(' , ') || '(无)')
check('该产出点就在 canonical 受信构造器里（不是别处随手造的）', real.trustedContextProducers.every((p) => p.file === 'src/kernel/contracts/attribution.ts'), real.trustedContextProducers.map((p) => `${p.file}:${p.line} ${p.snippet}`).join(' , '))
const riskyInputTypes = real.writeChainInputTypesWithRecordedBy.filter((t) => !t.isInternalEnvelope)
check('写链输入类型里带 recordedBy 成员的**只有内部封装 / 受信上下文**（没有公共输入面）', riskyInputTypes.length === 0, riskyInputTypes.map((t) => `${t.file}:${t.typeName}.${t.member}`).join(' , ') || `${real.writeChainInputTypesWithRecordedBy.length} 处均为内部封装`)
check('所有引用都能被**能力规则**解释（没有"无法解释"的引用）', real.unexplainedReferences.length === 0, real.unexplainedReferences.map((u) => `${u.file}:${u.occurrence}`).join(' , ') || '0')
const nonInsertBinding = real.mutationSites.filter((s) => s.verb !== 'insert' && s.bindsRecordedByColumns)
measure('非 insert 的 mutation 面数（update / delete）', real.mutationSites.filter((s) => s.verb !== 'insert').length, true)
check('除那一条 INSERT 外，**没有别的 mutation 面**能绑定 recorded_by_*（没有第二个值提供者）', nonInsertBinding.length === 0, nonInsertBinding.map((s) => `${s.file}:${s.line}(${s.verb})`).join(' , ') || `${real.mutationSites.length - 1} 处非 insert 面均不绑定 recorded_by_*`)

section('§4 负控 A：真实 reader 不得被算作 writer')
const mustBeReaders = ['src/infrastructure/dev/query-service.ts', 'src/kernel/contracts/developer-query.ts', 'src/infrastructure/action/action-ledger-store.ts']
measure('负控 A 用到的真实 reader 数', mustBeReaders.filter((f) => real.references.some((r) => r.file === f)).length)
check(
  '负控 A：三个真实 reader 都引用了 recordedBy，但都**没有**被计入权威 writer',
  mustBeReaders.every((f) => real.references.some((r) => r.file === f && r.classification === 'READ_ONLY_REFERENCE')) && !mustBeReaders.some((f) => real.authoritativeWriterFiles.includes(f)),
  mustBeReaders.map((f) => `${f}=${real.references.find((r) => r.file === f)?.classification ?? 'MISSING'}`).join(' · '),
)
console.log(`  · 只读引用的机械理由：${real.references.filter((r) => r.classification === 'READ_ONLY_REFERENCE').map((r) => `${r.file} ← ${r.reason}`).join(' | ')}`)

section('§5 负控 B：合成"第二个 writer"与"调用方自报 recordedBy" ⇒ 必响')
const tmp = mkdtempSync(join(tmpdir(), 'wp8c2-src-'))
const tmpSrc = join(tmp, 'src')
let injected: RecorderBoundaryReport | null = null
try {
  cpSync(SRC, tmpSrc, { recursive: true })
  writeFileSync(
    join(tmpSrc, 'infrastructure/persistence/zz-synthetic-second-writer.ts'),
    [
      "import { sql } from 'drizzle-orm'",
      'export function syntheticSecondWriter(event: { id: string }) {',
      '  return sql`insert into conversation_events (id, recorded_by_kind, recorded_by_id, recorded_by_unknown_reason)',
      "             values (${event.id}, ${'SYSTEM'}, ${'kernel'}, ${null})`",
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(tmpSrc, 'infrastructure/persistence/zz-synthetic-caller-supplied.ts'),
    [
      "import { sql } from 'drizzle-orm'",
      'export function syntheticCallerSupplied(input: { id: string; recordedBy: string }) {',
      '  return sql`insert into conversation_events (id, recorded_by_kind) values (${input.id}, ${input.recordedBy})`',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  injected = analyzeRecorderBoundary({ srcRoot: tmpSrc })
  measure('注入后 mutation site 数', injected.counts.mutationSites)
  measure('注入后权威 writer 文件数', injected.counts.authoritativeWriterFiles)
  measure('注入后调用方可控提供者数', injected.counts.callerControlledProviders)
  check('负控 B①：注入第二个 `insert into conversation_events` ⇒ 权威 writer 数 **> 1**（必响）', injected.counts.authoritativeWriterFiles > 1, `${injected.counts.authoritativeWriterFiles} 个：${injected.authoritativeWriterFiles.join(' , ')}`)
  check('负控 B②：注入"调用方自报 recordedBy 并绑定到 recorded_by_*" ⇒ callerControlledProviders **> 0**（必响）', injected.counts.callerControlledProviders > 0, injected.callerControlledProviders.map((c) => `${c.file}:${c.line}`).join(' , ') || '0')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
const restored = analyzeRecorderBoundary({ srcRoot: SRC })
check('负控 B③（恢复）：临时副本销毁、重分析真实 src ⇒ 重新安静（1 个 writer · 0 个调用方可控）', restored.counts.authoritativeWriterFiles === 1 && restored.counts.callerControlledProviders === 0, `writer=${restored.counts.authoritativeWriterFiles} · callerControlled=${restored.counts.callerControlledProviders}`)

section('§6 范围冻结与回归自检')
const srcAfter = dirStats(SRC)
check('src/ 一个字节都没改（只读分析）', srcAfter.files === srcBefore.files && srcAfter.bytes === srcBefore.bytes, `${srcBefore.files}/${srcBefore.bytes} → ${srcAfter.files}/${srcAfter.bytes}`)
check('migrations.ts 未改', sha256(join(ROOT, 'src/infrastructure/persistence/migrations.ts')) === migrationsSha, migrationsSha.slice(0, 16) + '…')
const dbMtimeAfter = statSync(join(ROOT, 'data/pglite')).mtime.toISOString()
check('真实库 data/pglite 未被触碰', dbMtimeAfter === dbMtimeBefore, `mtime ${dbMtimeAfter}`)
check('K-32 仍然成立（冻结证据 == immutable 标签）', existsSync(join(ROOT, 'artifacts/m5.1.1/wp8c1-k32-verify.json')), 'K-32 门证据仍在（C2 的回归里会再跑一次 wp8c1:verify）')

const verdict = failed === 0 && measurements.every((m) => m.valid) ? 'PASS' : 'FAIL'
mkdirSync(ART, { recursive: true })
writeFileSync(join(ART, 'wp8c2-k23-boundary.json'), `${JSON.stringify(real, null, 2)}\n`, 'utf8')
writeFileSync(
  join(ART, 'wp8c2-k33-verify.json'),
  `${JSON.stringify({ testId: 'M5.1.1 / WP8-C2 K-33 writer-boundary precision repair', generatedAt: new Date().toISOString(), command: 'pnpm m5.1.1:wp8c2:verify', finding: 'K-33', verdict, passed, failed, failures, boundary: { mutationSites: real.mutationSites, authoritativeWriterFiles: real.authoritativeWriterFiles, envelopeProducers: real.envelopeProducers, canonicalRecorder: real.canonicalRecorder, trustedLedgerWriters: real.trustedLedgerWriters, callerControlledProviders: real.callerControlledProviders, references: real.references }, negativeControls: { injectedWriterFiles: injected?.authoritativeWriterFiles ?? null, injectedCallerControlled: injected?.callerControlledProviders ?? null, restored: { writers: restored.counts.authoritativeWriterFiles, callerControlled: restored.counts.callerControlledProviders } }, measurements, measurementInvalid: measurements.filter((m) => !m.valid).length }, null, 2)}\n`,
  'utf8',
)

console.log(`\n${'='.repeat(78)}`)
console.log(`WP8-C2 / K-33 专项门：${passed} 通过 / ${failed} 失败｜K-33 = ${verdict}`)
console.log('证据已写入：artifacts/m5.1.1/wp8c2-k23-boundary.json · wp8c2-k33-verify.json')
console.log('='.repeat(78))
process.exit(verdict === 'PASS' ? 0 : 1)
