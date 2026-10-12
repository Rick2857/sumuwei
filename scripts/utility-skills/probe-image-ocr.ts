/**
 * probe-image-ocr.ts —— WP4（`image.ocr`）的探针与读数（计划书 §3.1「OCR」/ §4 A「OCR 6 组」）。
 *
 * ============================================================================
 *  它要回答的问题（每条都有对应读数，缺了就是缺了，不用"看起来没问题"顶替）
 * ============================================================================
 * ```text
 * ① 三张清晰样本 + 退化样本 + 空白样本：识别文字 / 独立参考 / 逐样本 CER / 关键数字 / confidence
 * ② 契约：产出的 OcrTurnContent 能不能过 assertTurnContent（直接调用）
 * ③ 冷热：工作器 bootstrap（冷）与本次识别（热）的毫秒数
 * ④ 离线：父进程守卫 + 子进程独立守卫 + 工作器自报，三处网络计数必须都是 0
 * ⑤ 边界：非图片 / 伪造 magic / 超 16 MiB / 超 20 MP → 必须**不孵化子进程**
 * ⑥ 缺资产：langPath 空目录 / corePath 空目录 / workerPath 不存在 → 失败关闭且零出站
 * ⑦ 生命周期：超时与取消 → 杀掉子进程、确认退出；**紧接着**一次正常识别必须成功（恢复）
 * ⑧ 一个 worker：同一适配器实例的并发第二次调用必须失败关闭（首版不排队）
 * ⑨ 资产：实际路径 + SHA-256；前后树指纹逐字相同；cache 目录前后都为空
 * ```
 *
 * 运行：
 * ```bash
 * node node_modules/tsx/dist/cli.mjs scripts/utility-skills/probe-image-ocr.ts
 * ```
 * 产出：`artifacts/post-lv2/local/utility-skills-preparation/runs/image-ocr-probe.json`
 *
 * ⚠️ 探针自己会往 `%TEMP%/dsh-image-ocr-probe/` 写三样运行期脚手架（生成物，不入库）：
 *    · `spawn-wrapper.mjs` —— 包在真实工作器外面，把每次 spawn 记进 spawn log
 *      （**这是"没有孵化子进程"这句话唯一可信的证据**：不能靠"结果看起来对"）
 *    · `net-guard.mjs`    —— 由 `NODE_OPTIONS=--import` 注入**子进程及其 worker 线程**的
 *      独立离线守卫（与交付代码里的守卫相互独立；被调用就写日志并抛错）
 *    · `img-over-limit-bytes.png`（> 16 MiB）、`img-over-limit-pixels.png`（6000x4000）等夹具
 */

import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { ActionFailureError, actionStatusOfFailure } from '../../src/kernel/action/errors.ts'
import type { ActionFailure } from '../../src/kernel/action/errors.ts'
import type { AdapterExecuteInput, AdapterOutcome } from '../../src/kernel/action/executor-port.ts'
import { newActionId } from '../../src/kernel/contracts/ids.ts'
import type {
  OcrTurnContent,
  TurnContent,
} from '../../src/kernel/contracts/turn-content.ts'
import {
  assertTurnContent,
  validateTurnContent,
} from '../../src/kernel/contracts/turn-content.ts'
import {
  IMAGE_OCR,
  IMAGE_OCR_OPERATION,
} from '../../src/kernel/action/utility-capabilities.ts'
import {
  createImageOcrAdapter,
  defaultOcrCacheDir,
  defaultOcrCorePath,
  defaultOcrLangDir,
  defaultTesseractDataPackageRoot,
  defaultTesseractEntry,
  defaultTesseractWorkerScript,
  describeAssetReading,
  ensureOcrLocalAssets,
  materializeOcrLanguageDir,
  parseWorkerStdout,
  runOcrWorker,
  sha256Hex,
  verifyOcrAssets,
  OCR_LIMITS,
  OCR_REPO_ROOT,
  OCR_TRAINEDDATA_ASSETS,
  type OcrAssetPaths,
  type OcrWorkerResult,
} from '../../src/infrastructure/action/adapters/image-ocr.ts'

const require = createRequire(import.meta.url)

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

const repoRoot = OCR_REPO_ROOT
const prepDir = join(repoRoot, 'artifacts/post-lv2/local/utility-skills-preparation')
const fixtureDir = join(prepDir, 'fixtures')
const ocrDataDir = join(prepDir, 'ocr-data')
const cachePath = defaultOcrCacheDir()
const corePath = defaultOcrCorePath()
const tesseractWorkerScript = defaultTesseractWorkerScript()
const tesseractEntry = defaultTesseractEntry()
const dataPackageRoot = defaultTesseractDataPackageRoot()
const realWorkerScript = join(repoRoot, 'src/infrastructure/action/adapters/image-ocr-worker.mjs')
const outPath = join(prepDir, 'runs/image-ocr-probe.json')

const scratchDir = join(tmpdir(), 'dsh-image-ocr-probe')
const spawnLogPath = join(scratchDir, 'spawn.log')
const netGuardLogPath = join(scratchDir, 'net-guard.log')
const spawnWrapperPath = join(scratchDir, 'spawn-wrapper.mjs')
const netGuardPath = join(scratchDir, 'net-guard.mjs')
const emptyLangPath = join(scratchDir, 'empty-langpath')
const emptyCorePath = join(scratchDir, 'empty-corepath')

/**
 * 语言资产目录 —— 由 `ensureOcrLocalAssets()` 物化（唯一来源 = 已安装的
 * `@tesseract.js-data/*`；**不**依赖任何别人留下的临时产物）。
 */
const langPath = defaultOcrLangDir()

/** 探针自己直接调工作器时用的那一组路径（`runCase` 走的是**适配器缺省值**，两者应当一致） */
const probeAssetPaths: OcrAssetPaths = {
  langPath,
  cachePath,
  corePath,
  tesseractWorkerScript,
  tesseractEntry,
}

// ---------------------------------------------------------------------------
// 父进程网络守卫（第 ③ 处观测点：本进程）
// ---------------------------------------------------------------------------

interface ParentNetworkGuardReading {
  attempts: number
  log: string[]
  patched: string[]
}

const parentNetwork: ParentNetworkGuardReading = { attempts: 0, log: [], patched: [] }

function installParentNetworkGuard(): void {
  const deny = (what: string): never => {
    parentNetwork.attempts += 1
    parentNetwork.log.push(what)
    throw new Error(`PROBE_PARENT_OFFLINE_GUARD：父进程不允许网络访问（${what}）`)
  }
  try {
    globalThis.fetch = ((...args: unknown[]) => {
      void args
      return deny('fetch')
    }) as unknown as typeof fetch
    parentNetwork.patched.push('fetch')
  } catch {
    /* 装不上就如实少一条 */
  }
  for (const [name, specifier, keys] of [
    ['http', 'node:http', ['request', 'get']],
    ['https', 'node:https', ['request', 'get']],
    ['net', 'node:net', ['connect', 'createConnection']],
    ['tls', 'node:tls', ['connect']],
    ['dns', 'node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6']],
  ] as const) {
    try {
      const mod = require(specifier) as Record<string, unknown>
      for (const key of keys) {
        if (typeof mod[key] === 'function') {
          mod[key] = (...args: unknown[]): never => {
            void args
            return deny(`${name}.${key}`)
          }
          parentNetwork.patched.push(`${name}.${key}`)
        }
      }
      if (specifier === 'node:net') {
        const Socket = (mod.Socket ?? {}) as { prototype?: Record<string, unknown> }
        const prototype = Socket.prototype
        if (prototype !== undefined && typeof prototype.connect === 'function') {
          prototype.connect = function patchedConnect(...args: unknown[]): never {
            void args
            return deny('net.Socket.prototype.connect')
          }
          parentNetwork.patched.push('net.Socket.prototype.connect')
        }
      }
    } catch {
      /* 同上 */
    }
  }
}

installParentNetworkGuard()

// ---------------------------------------------------------------------------
// 运行期脚手架（%TEMP%）：spawn 包装器 + 子进程独立离线守卫
// ---------------------------------------------------------------------------

const SPAWN_WRAPPER_SOURCE = `// 由 probe-image-ocr.ts 生成：记录每次 spawn，再转交给真实工作器。
import { appendFileSync } from 'node:fs'
try {
  appendFileSync(process.env.DSH_OCR_SPAWN_LOG, JSON.stringify({ case: process.env.DSH_OCR_PROBE_CASE ?? 'unlabeled', pid: process.pid, at: Date.now() }) + '\\n')
} catch {}
await import(process.env.DSH_OCR_REAL_WORKER)
`

const NET_GUARD_SOURCE = `// 由 probe-image-ocr.ts 生成：独立于交付代码的离线守卫（子进程 + 其 worker 线程）。
import { appendFileSync } from 'node:fs'
import { threadId } from 'node:worker_threads'
import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns'

const record = (event, what) => {
  try { appendFileSync(process.env.DSH_OCR_NETGUARD_LOG, JSON.stringify({ pid: process.pid, thread: threadId, event, what }) + '\\n') } catch {}
}
record('guard-loaded', null)
const deny = (what) => { record('attempt', what); throw new Error('PROBE_OFFLINE_GUARD ' + what) }
try { globalThis.fetch = (...a) => deny('fetch') } catch {}
for (const [n, m, ks] of [['http', http, ['request', 'get']], ['https', https, ['request', 'get']], ['dns', dns, ['lookup']]]) {
  for (const k of ks) { try { m[k] = (...a) => deny(n + '.' + k) } catch {} }
}
record('guard-ready', null)
`

function prepareScratch(): void {
  rmSync(scratchDir, { recursive: true, force: true })
  mkdirSync(scratchDir, { recursive: true })
  mkdirSync(emptyLangPath, { recursive: true })
  mkdirSync(emptyCorePath, { recursive: true })
  writeFileSync(spawnLogPath, '', 'utf8')
  writeFileSync(netGuardLogPath, '', 'utf8')
  writeFileSync(spawnWrapperPath, SPAWN_WRAPPER_SOURCE, 'utf8')
  writeFileSync(netGuardPath, NET_GUARD_SOURCE, 'utf8')
}

/** 子进程环境：spawn 记账 + 独立离线守卫（`NODE_OPTIONS` 会被 worker 线程继承） */
function probeEnv(caseId: string): NodeJS.ProcessEnv {
  const inherited = process.env.NODE_OPTIONS ?? ''
  return {
    ...process.env,
    DSH_OCR_PROBE_CASE: caseId,
    DSH_OCR_SPAWN_LOG: spawnLogPath,
    DSH_OCR_NETGUARD_LOG: netGuardLogPath,
    DSH_OCR_REAL_WORKER: pathToFileURL(realWorkerScript).href,
    NODE_OPTIONS: `${inherited} --import=${pathToFileURL(netGuardPath).href}`.trim(),
  }
}

function readJsonLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '')
  const out: Record<string, unknown>[] = []
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object') out.push(parsed as Record<string, unknown>)
    } catch {
      out.push({ parseError: line.slice(0, 200) })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 夹具生成（%TEMP%）
// ---------------------------------------------------------------------------

/** PNG 签名 + IHDR（只为让"尺寸/像素"判据真的被走到；不需要能解码） */
function craftPng(width: number, height: number, paddingBytes: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrLength = Buffer.from([0, 0, 0, 13])
  const ihdrTag = Buffer.from('IHDR', 'ascii')
  const dims = Buffer.alloc(8)
  dims.writeUInt32BE(width, 0)
  dims.writeUInt32BE(height, 4)
  const ihdrRest = Buffer.from([8, 2, 0, 0, 0])
  const crc = Buffer.alloc(4)
  const base = Buffer.concat([signature, ihdrLength, ihdrTag, dims, ihdrRest, crc])
  if (paddingBytes <= 0) return base
  return Buffer.concat([base, Buffer.alloc(paddingBytes, 0x00)])
}

interface GeneratedFixtures {
  fakeMagicPng: string
  overLimitBytesPng: string
  overLimitPixelsPng: string
}

function generateFixtures(): GeneratedFixtures {
  const fakeMagicPng = join(scratchDir, 'fake-magic.png')
  writeFileSync(fakeMagicPng, 'this file is definitely not a png\n', 'utf8')

  const overLimitBytesPng = join(scratchDir, 'over-limit-bytes.png')
  writeFileSync(overLimitBytesPng, craftPng(400, 200, OCR_LIMITS.maxImageBytes + 1))

  const overLimitPixelsPng = join(scratchDir, 'over-limit-pixels.png')
  writeFileSync(overLimitPixelsPng, craftPng(6_000, 4_000, 0))

  return { fakeMagicPng, overLimitBytesPng, overLimitPixelsPng }
}

// ---------------------------------------------------------------------------
// 纯函数：CER / 关键数字
// ---------------------------------------------------------------------------

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const previous = new Array<number>(b.length + 1)
  const current = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j += 1) previous[j] = j
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j]
  }
  return previous[b.length]
}

const stripWhitespace = (value: string): string => value.replace(/\s+/g, '')

/** PER-SAMPLE CER = Levenshtein(去空白) / 参考长度（参考为空时无有限比率 ⇒ null） */
function cerOf(hypothesis: string, reference: string): {
  distance: number
  referenceLength: number
  cer: number | null
  exactMatch: boolean
} {
  const hyp = stripWhitespace(hypothesis)
  const ref = stripWhitespace(reference)
  const distance = levenshtein(hyp, ref)
  return {
    distance,
    referenceLength: ref.length,
    cer: ref.length === 0 ? (hyp.length === 0 ? 0 : null) : distance / ref.length,
    exactMatch: distance === 0,
  }
}

function numbersIn(text: string): string[] {
  // 允许 `21.5` / `2026-10-04` / `37%`（百分号不算数字的一部分）这类真实读数形状
  const found = text.match(/\d+(?:[.,/-]\d+)*/g)
  return found ?? []
}

/** 关键数字是否命中：**先看字面出现**，再看数值 token（"2026-10-04" 这类日期不会被拆开误判） */
function keyNumberFound(expected: string, text: string): boolean {
  if (text.includes(expected)) return true
  const normalized = expected.replace(',', '.')
  return numbersIn(text).some((found) => found === expected || found.replace(',', '.') === normalized)
}

// ---------------------------------------------------------------------------
// 资产读数
// ---------------------------------------------------------------------------

function treeFingerprint(dir: string): { fileCount: number; totalBytes: number; files: string[] } {
  const files: string[] = []
  let totalBytes = 0
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(absolute, relative)
      else if (entry.isFile()) {
        const bytes = readFileSync(absolute)
        totalBytes += bytes.byteLength
        files.push(`${relative} ${bytes.byteLength} ${sha256Hex(bytes)}`)
      }
    }
  }
  if (existsSync(dir)) walk(dir, '')
  return { fileCount: files.length, totalBytes, files: files.sort() }
}

function cacheDirListing(): string[] {
  if (!existsSync(cachePath)) return []
  return readdirSync(cachePath).sort()
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

interface ManifestEntry {
  path: string
  bytes: number
  sha256: string
  kind: string
  expect: {
    ocrReference?: string
    keyNumbers?: string[]
    clear?: boolean
    note?: string
  }
}

interface CaseSpec {
  id: string
  group: string
  root: string
  target: string
  /** 期望的**归一后**语义，写出来是为了让读数能自己对照，不用人去猜 */
  expect:
    | { kind: 'content'; reference: string; keyNumbers: string[]; clear: boolean }
    | { kind: 'empty' }
    | { kind: 'failure'; code: string; mustNotSpawn: boolean }
  overrides?: Partial<{
    langPath: string
    corePath: string
    tesseractWorkerScript: string
    timeoutMs: number
    maxImageBytes: number
    maxPixels: number
  }>
  args?: Record<string, unknown>
  /** 断言产出的 `languages`（顺序敏感） */
  expectLanguages?: readonly string[]
  useSpawnWrapper: boolean
  abortAfterMs?: number
}

interface CaseReading {
  id: string
  group: string
  target: string
  absoluteTarget: string
  expectation: string
  status: 'success' | 'partial' | 'failure'
  normalizedStatus: string | null
  failureCode: string | null
  failureMessage: string | null
  failureDetails: Record<string, unknown> | null
  adapterCallMs: number
  spawned: boolean
  /** `spawned` 这句话的**证据来源**（不能靠"结果看起来对"） */
  spawnEvidence: 'spawn-log' | 'failure-details' | 'outcome-content' | 'none-observed'
  spawnCountForCase: number
  exitCode: number | null
  signal: string | null
  released: boolean | null
  killReason: string | null
  coldStartMs: number | null
  recognizeMs: number | null
  recognizedText: string | null
  recognizedChars: number | null
  reference: string | null
  cer: ReturnType<typeof cerOf> | null
  keyNumbersExpected: string[]
  keyNumbersFoundInText: string[]
  keyNumbersAllFound: boolean | null
  confidence: number | null
  languages: string[] | null
  turnContentEmitted: boolean
  turnContentAccepted: boolean | null
  turnContentProblems: string[]
  assertTurnContentAccepted: boolean | null
  assertTurnContentError: string | null
  facts: string[]
  effectDetail: string | null
  effectBytes: number | null
  evidence: { kind: string; detail: string; ref?: string }[]
  scope: { totalChars: number; includedChars: number; truncated: boolean } | null
  resourceRef: string | null
  sourceFingerprint: string | null
  resultFingerprint: string | null
  resultFingerprintMatchesText: boolean | null
  contentId: string | null
  childReportedNetworkAttempts: number | null
  childCrossThreadGuard: boolean | null
  stderrNetAttemptMarkers: number
  met: boolean
  metNotes: string[]
}

function readManifest(): Map<string, ManifestEntry> {
  const raw = readFileSync(join(fixtureDir, 'manifest.json'), 'utf8')
  const parsed = JSON.parse(raw) as { files: ManifestEntry[] }
  return new Map(parsed.files.map((entry) => [entry.path, entry]))
}

function extractNumber(facts: readonly string[], pattern: RegExp): number | null {
  for (const fact of facts) {
    const match = pattern.exec(fact)
    if (match !== null) {
      const value = Number(match[1])
      if (Number.isFinite(value)) return value
    }
  }
  return null
}

async function runCase(spec: CaseSpec, manifest: Map<string, ManifestEntry>): Promise<CaseReading> {
  const spawnBefore = readJsonLines(spawnLogPath).length
  const absoluteTarget = join(spec.root, spec.target)

  const adapter = createImageOcrAdapter({
    root: spec.root,
    // ⚠️ 只有 override 才显式传路径：其余一律走**适配器自己的缺省值**
    //    （`createImageOcrAdapter({ root })` 就是装配层的目标形状）
    ...(spec.overrides?.langPath !== undefined ? { langPath: spec.overrides.langPath } : {}),
    ...(spec.overrides?.corePath !== undefined ? { corePath: spec.overrides.corePath } : {}),
    ...(spec.overrides?.tesseractWorkerScript !== undefined
      ? { tesseractWorkerScript: spec.overrides.tesseractWorkerScript }
      : {}),
    ...(spec.useSpawnWrapper ? { workerScript: spawnWrapperPath } : {}),
    ...(spec.overrides?.timeoutMs !== undefined ? { timeoutMs: spec.overrides.timeoutMs } : {}),
    ...(spec.overrides?.maxImageBytes !== undefined ? { maxImageBytes: spec.overrides.maxImageBytes } : {}),
    ...(spec.overrides?.maxPixels !== undefined ? { maxPixels: spec.overrides.maxPixels } : {}),
    env: probeEnv(spec.id),
  })

  const args: Record<string, unknown> = { ...(spec.args ?? {}) }
  if (spec.abortAfterMs !== undefined) {
    const controller = new AbortController()
    args.signal = controller.signal
    setTimeout(() => {
      controller.abort()
    }, spec.abortAfterMs)
  }

  const input: AdapterExecuteInput = {
    actionId: newActionId(),
    operation: IMAGE_OCR_OPERATION,
    target: { type: 'sandbox_file', canonicalId: spec.target, confidence: 'exact' },
    args,
    now: () => Date.now(),
  }

  const startedAt = Date.now()
  let outcome: AdapterOutcome | undefined
  let failure: ActionFailure | undefined
  try {
    outcome = await adapter.execute(input)
  } catch (error) {
    failure =
      error instanceof ActionFailureError
        ? error.failure
        : { code: 'execution_failed', message: `probe 未能归一：${String(error)}` }
  }
  const adapterCallMs = Date.now() - startedAt

  const spawnLines = readJsonLines(spawnLogPath)
  const spawnCountForCase = spawnLines
    .slice(spawnBefore)
    .filter((line) => line.case === spec.id).length

  const item = outcome?.turnContent?.[0]
  const ocrItem = item !== undefined && item.kind === 'ocr' ? (item as OcrTurnContent) : undefined
  const validationProblems = item !== undefined ? validateTurnContent(item) : []
  let assertAccepted: boolean | null = null
  let assertError: string | null = null
  if (item !== undefined) {
    try {
      assertTurnContent(item)
      assertAccepted = true
    } catch (error) {
      assertAccepted = false
      assertError = error instanceof Error ? error.message : String(error)
    }
  }

  const recognizedText = ocrItem?.text ?? null
  const manifestEntry = manifest.get(spec.target)
  const reference =
    spec.expect.kind === 'content' ? spec.expect.reference : (manifestEntry?.expect.ocrReference ?? null)
  const keyNumbersExpected = spec.expect.kind === 'content' ? spec.expect.keyNumbers : []
  const keyNumbersFound = recognizedText === null ? [] : numbersIn(recognizedText)
  const keyNumbersAllFound =
    keyNumbersExpected.length === 0
      ? null
      : keyNumbersExpected.every((expected) => keyNumberFound(expected, recognizedText ?? ''))

  const facts = ocrItem?.facts ?? []

  const status: CaseReading['status'] =
    failure !== undefined ? 'failure' : outcome?.partial !== undefined ? 'partial' : 'success'

  const reading: CaseReading = {
    id: spec.id,
    group: spec.group,
    target: spec.target,
    absoluteTarget,
    expectation:
      spec.expect.kind === 'content'
        ? `success + turnContent；参考「${spec.expect.reference}」；关键数字 ${spec.expect.keyNumbers.join('/') || '(无)'}`
        : spec.expect.kind === 'empty'
          ? 'partial（0/1）且**不发** turnContent'
          : `failure code=${spec.expect.code}${spec.expect.mustNotSpawn ? '，且不孵化子进程' : ''}`,
    status,
    normalizedStatus: failure !== undefined ? actionStatusOfFailure(failure.code) : status,
    failureCode: failure?.code ?? null,
    failureMessage: failure?.message ?? null,
    failureDetails: (failure?.details as Record<string, unknown> | undefined) ?? null,
    adapterCallMs,
    spawned: false,
    spawnEvidence: 'none-observed',
    spawnCountForCase,
    exitCode: null,
    signal: null,
    released: null,
    killReason: null,
    coldStartMs: extractNumber(facts, /冷启动（工作器 bootstrap）([\d.]+) ms/),
    recognizeMs: extractNumber(facts, /本次识别 ([\d.]+) ms/),
    recognizedText,
    recognizedChars: recognizedText === null ? null : recognizedText.length,
    reference,
    cer: recognizedText === null || reference === null ? null : cerOf(recognizedText, reference),
    keyNumbersExpected,
    keyNumbersFoundInText: keyNumbersFound,
    keyNumbersAllFound,
    confidence: ocrItem?.confidence ?? null,
    languages: ocrItem?.languages !== undefined ? [...ocrItem.languages] : null,
    turnContentEmitted: item !== undefined,
    turnContentAccepted: item !== undefined ? validationProblems.length === 0 : null,
    turnContentProblems: validationProblems,
    assertTurnContentAccepted: assertAccepted,
    assertTurnContentError: assertError,
    facts: [...facts],
    effectDetail: outcome?.effect?.detail ?? null,
    effectBytes: outcome?.effect?.bytes ?? null,
    evidence: (outcome?.evidence ?? []).map((entry) => ({
      kind: entry.kind,
      detail: entry.detail,
      ...(entry.ref !== undefined ? { ref: entry.ref } : {}),
    })),
    scope: item?.scope !== undefined ? { ...item.scope } : null,
    resourceRef: item?.resourceRef ?? null,
    sourceFingerprint: item?.sourceFingerprint ?? null,
    resultFingerprint: item?.resultFingerprint ?? null,
    resultFingerprintMatchesText:
      item !== undefined && recognizedText !== null ? item.resultFingerprint === sha256Hex(recognizedText) : null,
    contentId: item?.contentId ?? null,
    childReportedNetworkAttempts: extractNumber(facts, /子进程报告的网络调用次数 (\d+)/),
    childCrossThreadGuard: facts.some((fact) => fact.includes('跨线程离线守卫 已装')),
    stderrNetAttemptMarkers: 0,
    met: false,
    metNotes: [],
  }

  // 释放事实：成功路径从 facts 里取，失败/partial 路径从 details 或 evidence 里取
  const releaseHaystack = [
    ...facts,
    ...reading.evidence.map((entry) => entry.detail),
  ].join('\n')
  const releaseMatch = /工作器已释放（退出码 (\S+?)(?:，信号 (\S+?))?，([\d.]+) ms）/.exec(releaseHaystack)
  if (releaseMatch !== null) {
    reading.exitCode = releaseMatch[1] === 'null' ? null : Number(releaseMatch[1])
    reading.signal = releaseMatch[2] ?? null
    reading.released = true
  }
  const details = reading.failureDetails
  if (details !== null) {
    if (typeof details.exitCode === 'number' || details.exitCode === null) {
      reading.exitCode = (details.exitCode as number | null) ?? null
    }
    if (typeof details.signal === 'string' || details.signal === null) {
      reading.signal = (details.signal as string | null) ?? null
    }
    if (details.released === true) reading.released = true
    if (typeof details.exitCode === 'number' && reading.killReason === null && failure?.code !== 'timeout') {
      reading.killReason = 'exited'
    }
  }
  if (failure?.code === 'timeout') reading.killReason = 'timeout'
  if (failure?.code === 'cancelled') reading.killReason = 'cancelled'

  /*
   * `spawned` 必须有证据：
   *   · 用了 spawn 包装器 ⇒ 证据是 spawn log（"没有孵化子进程"这句话**只**能靠它）
   *   · 否则：拿到内容 ⇒ 子进程一定跑过；失败详情里有退出码/释放记录 ⇒ 也证明跑过
   */
  if (spec.useSpawnWrapper) {
    reading.spawnEvidence = 'spawn-log'
    reading.spawned = spawnCountForCase > 0
  } else if (failure === undefined) {
    reading.spawnEvidence = 'outcome-content'
    reading.spawned = true
  } else if (reading.released === true || reading.exitCode !== null || reading.signal !== null) {
    reading.spawnEvidence = 'failure-details'
    reading.spawned = true
  } else {
    reading.spawnEvidence = 'none-observed'
    reading.spawned = false
  }

  // 是否达到期望
  if (spec.expect.kind === 'content') {
    if (status !== 'success') reading.metNotes.push(`期望 success，实际 ${status}`)
    if (!reading.turnContentEmitted) reading.metNotes.push('没有产出 turnContent')
    if (reading.assertTurnContentAccepted !== true) reading.metNotes.push('assertTurnContent 拒绝/未调用')
    if (reading.resultFingerprintMatchesText !== true) reading.metNotes.push('resultFingerprint 与 text 的 sha256 不一致')
    if (keyNumbersAllFound === false) reading.metNotes.push('关键数字没有全部命中')
    if (spec.expectLanguages !== undefined) {
      const actual = (reading.languages ?? []).join('+')
      if (actual !== spec.expectLanguages.join('+')) {
        reading.metNotes.push(`期望语言 ${spec.expectLanguages.join('+')}，实际 ${actual}`)
      }
    }
  } else if (spec.expect.kind === 'empty') {
    if (status !== 'partial') reading.metNotes.push(`期望 partial，实际 ${status}`)
    if (reading.turnContentEmitted) reading.metNotes.push('空白图不该发 turnContent')
    if (reading.effectDetail === null || !reading.effectDetail.includes('没有识别到文字')) {
      reading.metNotes.push('effect.detail 没有如实说"没有识别到文字"')
    }
  } else {
    if (reading.failureCode !== spec.expect.code) {
      reading.metNotes.push(`期望 failure code=${spec.expect.code}，实际 ${String(reading.failureCode)}`)
    }
    if (spec.expect.mustNotSpawn && reading.spawned) reading.metNotes.push('不该孵化子进程，但它孵化了')
  }
  // 跨用例的结构性检查：失败消息里**不许**漏出 Node 的原始错误码（用户面分不清"不存在"与"出错"）
  if (reading.failureMessage !== null && /\b(ENOENT|ENOTDIR|EACCES|EPERM|EISDIR|EBUSY)\b/.test(reading.failureMessage)) {
    reading.metNotes.push(`失败消息里漏出了 Node 原始错误码：${reading.failureMessage}`)
  }
  // 越界拒绝必须**先于任何 IO**：`resolveSandboxPath` 的 permission_denied 不带任何"读"的痕迹
  if (spec.expect.kind === 'failure' && spec.expect.code === 'permission_denied') {
    if (reading.failureMessage === null || !reading.failureMessage.includes('沙箱根')) {
      reading.metNotes.push('越界拒绝的措辞里没有指出"沙箱根"')
    }
    if (reading.failureDetails !== null) {
      reading.metNotes.push('越界拒绝带上了 IO 详情 —— 说明包含性检查没有先于 stat/读')
    }
  }
  // 文件不存在：原始错误码只许进 details
  if (spec.expect.kind === 'failure' && spec.expect.code === 'target_not_found' && spec.id === 'edge-missing-file') {
    if (reading.failureDetails?.errorCode !== 'ENOENT') {
      reading.metNotes.push(`target_not_found 的 details.errorCode 期望 ENOENT，实际 ${String(reading.failureDetails?.errorCode)}`)
    }
  }
  reading.met = reading.metNotes.length === 0
  return reading
}

// ---------------------------------------------------------------------------
// 直接调用工作器（负控：工作器一侧的缺资产 / 被换掉的资产）
// ---------------------------------------------------------------------------

interface DirectWorkerReading {
  id: string
  purpose: string
  exitCode: number | null
  signal: string | null
  spawned: number
  result: OcrWorkerResult | null
  parseProblem: string | null
  stderrTail: string
  met: boolean
  metNotes: string[]
}

async function runDirectWorkerCase(input: {
  id: string
  purpose: string
  mutate: (header: Record<string, unknown>) => void
  expectCode: string
  imagePath: string
}): Promise<DirectWorkerReading> {
  const image = readFileSync(input.imagePath)
  const assets = await verifyOcrAssets(probeAssetPaths, ['eng', 'chi_sim'])
  const header: Record<string, unknown> = {
    protocol: 'image-ocr/1',
    languages: ['eng', 'chi_sim'],
    langPath,
    cachePath,
    corePath,
    workerPath: tesseractWorkerScript,
    tesseractEntry,
    assets: assets.languages.map((entry) => ({
      lang: entry.lang,
      path: entry.path,
      bytes: entry.bytes ?? -1,
      sha256: entry.sha256 ?? '',
    })),
    // 内部 watchdog 会抬到 1000 ms 下限；这里给父进程一个更宽的上限
    timeoutMs: 30_000,
    imageBytes: image.byteLength,
  }
  input.mutate(header)

  const spawnBefore = readJsonLines(spawnLogPath).length
  const run = await runOcrWorker({
    workerScript: spawnWrapperPath,
    env: probeEnv(input.id),
    timeoutMs: 20_000,
    header: header as never,
    image,
  })
  const spawned = readJsonLines(spawnLogPath).slice(spawnBefore).filter((line) => line.case === input.id).length
  const result = run.result ?? null
  const notes: string[] = []
  if (result === null) notes.push(`没有结果行：${String(run.parseProblem)}`)
  else if (result.ok !== false) notes.push('期望失败，但它报 ok=true')
  else if (result.code !== input.expectCode) {
    notes.push(`期望 code=${input.expectCode}，实际 ${String(result.code)}`)
  }
  return {
    id: input.id,
    purpose: input.purpose,
    exitCode: run.exitCode,
    signal: run.signal,
    spawned,
    result,
    parseProblem: run.parseProblem ?? null,
    stderrTail: run.stderr.slice(-400),
    met: notes.length === 0,
    metNotes: notes,
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function summarize(list: CaseReading[]): Record<string, unknown> {
  const clear = list.filter((entry) => entry.group === 'clear')
  const clearCer = clear.map((entry) => ({
    id: entry.id,
    cer: entry.cer?.cer ?? null,
    referenceLength: entry.cer?.referenceLength ?? null,
    distance: entry.cer?.distance ?? null,
    within5Percent: entry.cer?.cer !== null && entry.cer?.cer !== undefined ? entry.cer.cer <= 0.05 : null,
    keyNumbersAllFound: entry.keyNumbersAllFound,
    confidence: entry.confidence,
    recognizedText: entry.recognizedText,
    reference: entry.reference,
  }))
  return {
    total: list.length,
    met: list.filter((entry) => entry.met).length,
    notMet: list.filter((entry) => !entry.met).map((entry) => ({ id: entry.id, notes: entry.metNotes })),
    clearSamples: clearCer,
    clearSamplesAllWithin5Percent: clearCer.every((entry) => entry.within5Percent === true),
    cerThresholdNote:
      '计划书 §4 A：三张清晰样本逐样本 CER ≤ 5% 且指定关键数字全对。本读数**逐样本列出、不合成平均**；' +
      '退化样本（img-degraded）单独列在 cases 里，不混入这里的结论。未达阈值如实记 false，不调阈值凑通过。',
    spawnEvidenceBreakdown: list.reduce<Record<string, number>>((accumulator, entry) => {
      accumulator[entry.spawnEvidence] = (accumulator[entry.spawnEvidence] ?? 0) + 1
      return accumulator
    }, {}),
    casesWhereChildWasSpawned: list.filter((entry) => entry.spawned).map((entry) => entry.id),
    pathRefusals: list
      .filter((entry) =>
        ['edge-absolute-path', 'edge-parent-escape', 'edge-missing-file', 'edge-non-image-extension'].includes(
          entry.id
        )
      )
      .map((entry) => ({
        id: entry.id,
        target: entry.target,
        failureCode: entry.failureCode,
        failureMessage: entry.failureMessage,
        failureDetails: entry.failureDetails,
        adapterCallMs: entry.adapterCallMs,
        spawned: entry.spawned,
        spawnEvidence: entry.spawnEvidence,
      })),
  }
}

async function main(): Promise<void> {
  prepareScratch()
  const generated = generateFixtures()
  const manifest = readManifest()

  // ① 物化（唯一来源 = 已安装的 @tesseract.js-data/*；离线磁盘读 + 内置表核对）
  const ensured = await ensureOcrLocalAssets()
  const materializedNow = await materializeOcrLanguageDir()
  const assetsReading = await verifyOcrAssets(probeAssetPaths, ['eng', 'chi_sim'])
  const treeBefore = treeFingerprint(ocrDataDir)
  const cacheBefore = cacheDirListing()

  const cases: CaseSpec[] = [
    {
      id: 'ocr-clear-zh',
      group: 'clear',
      root: fixtureDir,
      target: 'img-zh.png',
      expect: {
        kind: 'content',
        reference: manifest.get('img-zh.png')?.expect.ocrReference ?? '',
        keyNumbers: manifest.get('img-zh.png')?.expect.keyNumbers ?? [],
        clear: true,
      },
      useSpawnWrapper: false,
    },
    {
      id: 'ocr-clear-en',
      group: 'clear',
      root: fixtureDir,
      target: 'img-en.png',
      expect: {
        kind: 'content',
        reference: manifest.get('img-en.png')?.expect.ocrReference ?? '',
        keyNumbers: manifest.get('img-en.png')?.expect.keyNumbers ?? [],
        clear: true,
      },
      useSpawnWrapper: false,
    },
    {
      id: 'ocr-clear-mixed',
      group: 'clear',
      root: fixtureDir,
      target: 'img-mixed.png',
      expect: {
        kind: 'content',
        reference: manifest.get('img-mixed.png')?.expect.ocrReference ?? '',
        keyNumbers: manifest.get('img-mixed.png')?.expect.keyNumbers ?? [],
        clear: true,
      },
      useSpawnWrapper: false,
    },
    {
      id: 'ocr-degraded',
      group: 'degraded',
      root: fixtureDir,
      target: 'img-degraded.png',
      expect: {
        kind: 'content',
        reference: manifest.get('img-degraded.png')?.expect.ocrReference ?? '',
        keyNumbers: manifest.get('img-degraded.png')?.expect.keyNumbers ?? [],
        clear: false,
      },
      useSpawnWrapper: false,
    },
    {
      id: 'ocr-empty-image',
      group: 'edge',
      root: fixtureDir,
      target: 'img-empty.png',
      expect: { kind: 'empty' },
      useSpawnWrapper: false,
    },
    {
      id: 'ocr-english-only',
      group: 'edge',
      root: fixtureDir,
      target: 'img-en.png',
      expect: {
        kind: 'content',
        reference: manifest.get('img-en.png')?.expect.ocrReference ?? '',
        keyNumbers: manifest.get('img-en.png')?.expect.keyNumbers ?? [],
        clear: false,
      },
      args: { language: 'eng' },
      expectLanguages: ['eng'],
      useSpawnWrapper: false,
    },
    {
      id: 'edge-unknown-language',
      group: 'edge',
      root: fixtureDir,
      target: 'img-en.png',
      expect: { kind: 'failure', code: 'validation_failed', mustNotSpawn: true },
      args: { language: 'fra' },
      useSpawnWrapper: true,
    },

    // ---- 边界：非法 / 超限 ⇒ 必须在孵化子进程之前失败 ----
    {
      id: 'edge-non-image-extension',
      group: 'edge',
      root: fixtureDir,
      target: 'doc-fake.pdf',
      expect: { kind: 'failure', code: 'validation_failed', mustNotSpawn: true },
      useSpawnWrapper: true,
    },
    {
      id: 'edge-missing-file',
      group: 'edge',
      root: fixtureDir,
      target: 'missing.png',
      expect: { kind: 'failure', code: 'target_not_found', mustNotSpawn: true },
      useSpawnWrapper: true,
    },
    {
      id: 'edge-absolute-path',
      group: 'edge',
      root: fixtureDir,
      target: 'C:/Windows/System32/x.png',
      expect: { kind: 'failure', code: 'permission_denied', mustNotSpawn: true },
      useSpawnWrapper: true,
    },
    {
      id: 'edge-parent-escape',
      group: 'edge',
      root: fixtureDir,
      target: '../escape.png',
      expect: { kind: 'failure', code: 'permission_denied', mustNotSpawn: true },
      useSpawnWrapper: true,
    },
    {
      id: 'edge-fake-magic-png',
      group: 'edge',
      root: scratchDir,
      target: 'fake-magic.png',
      expect: { kind: 'failure', code: 'validation_failed', mustNotSpawn: true },
      useSpawnWrapper: true,
    },
    {
      id: 'edge-over-limit-bytes',
      group: 'edge',
      root: scratchDir,
      target: 'over-limit-bytes.png',
      expect: { kind: 'failure', code: 'validation_failed', mustNotSpawn: true },
      useSpawnWrapper: true,
    },
    {
      id: 'edge-over-limit-pixels',
      group: 'edge',
      root: scratchDir,
      target: 'over-limit-pixels.png',
      expect: { kind: 'failure', code: 'validation_failed', mustNotSpawn: true },
      useSpawnWrapper: true,
    },
    {
      id: 'edge-missing-lang-asset',
      group: 'edge',
      root: fixtureDir,
      target: 'img-en.png',
      expect: { kind: 'failure', code: 'execution_failed', mustNotSpawn: true },
      overrides: { langPath: emptyLangPath },
      useSpawnWrapper: true,
    },
    {
      id: 'edge-missing-core-path',
      group: 'edge',
      root: fixtureDir,
      target: 'img-en.png',
      expect: { kind: 'failure', code: 'execution_failed', mustNotSpawn: true },
      overrides: { corePath: emptyCorePath },
      useSpawnWrapper: true,
    },
    {
      id: 'edge-missing-worker-script',
      group: 'edge',
      root: fixtureDir,
      target: 'img-en.png',
      expect: { kind: 'failure', code: 'execution_failed', mustNotSpawn: true },
      overrides: { tesseractWorkerScript: join(scratchDir, 'no-such-worker.js') },
      useSpawnWrapper: true,
    },

    // ---- 生命周期：超时 / 取消 ⇒ 杀掉并等它退出 ----
    {
      id: 'life-timeout-then-recover',
      group: 'lifecycle',
      root: fixtureDir,
      target: 'img-en.png',
      expect: { kind: 'failure', code: 'timeout', mustNotSpawn: false },
      overrides: { timeoutMs: 60 },
      useSpawnWrapper: false,
    },
    {
      id: 'life-cancel-midflight',
      group: 'lifecycle',
      root: fixtureDir,
      target: 'img-en.png',
      expect: { kind: 'failure', code: 'cancelled', mustNotSpawn: false },
      abortAfterMs: 60,
      useSpawnWrapper: false,
    },
  ]

  const readings: CaseReading[] = []
  for (const spec of cases) {
    const reading = await runCase(spec, manifest)
    readings.push(reading)
    process.stderr.write(
      `[probe] ${reading.id}: status=${reading.status} code=${String(reading.failureCode)} spawned=${String(reading.spawned)} met=${String(reading.met)}\n`
    )
  }

  // 恢复：超时被杀之后，**紧接着**一次正常识别必须成功
  const recoveryStartedAt = Date.now()
  const recovery = await runCase(
    {
      id: 'life-recovery-after-timeout',
      group: 'lifecycle',
      root: fixtureDir,
      target: 'img-en.png',
      expect: {
        kind: 'content',
        reference: manifest.get('img-en.png')?.expect.ocrReference ?? '',
        keyNumbers: manifest.get('img-en.png')?.expect.keyNumbers ?? [],
        clear: true,
      },
      useSpawnWrapper: false,
    },
    manifest
  )
  readings.push(recovery)

  /*
   * 懒物化：把物化目录**删掉**，再跑一次缺省路径的识别 ——
   * 适配器必须自己从已安装包重建（离线 + 内置表核对），并且重建出来的字节与删除前逐字相同。
   */
  const langDirBeforeDelete = treeFingerprint(langPath)
  rmSync(langPath, { recursive: true, force: true })
  const langDirDeleted = !existsSync(langPath)
  const lazyCase = await runCase(
    {
      id: 'lazy-materialize-after-delete',
      group: 'edge',
      root: fixtureDir,
      target: 'img-zh.png',
      expect: {
        kind: 'content',
        reference: manifest.get('img-zh.png')?.expect.ocrReference ?? '',
        keyNumbers: manifest.get('img-zh.png')?.expect.keyNumbers ?? [],
        clear: true,
      },
      useSpawnWrapper: false,
    },
    manifest
  )
  readings.push(lazyCase)
  const langDirAfterDelete = treeFingerprint(langPath)
  const rebuiltIdentical = JSON.stringify(langDirBeforeDelete.files) === JSON.stringify(langDirAfterDelete.files)

  // 一个 worker：同一适配器实例的并发第二次调用必须失败关闭
  const concurrency = await runConcurrencyCase(manifest)

  // 直接调用工作器：工作器一侧的缺资产 / 被换掉的资产
  const directCases: DirectWorkerReading[] = [
    await runDirectWorkerCase({
      id: 'direct-swapped-asset-hash',
      purpose: '父进程核对通过之后资产被换成别的内容（TOCTOU）⇒ 工作器必须自己发现并失败关闭',
      expectCode: 'assets_missing',
      imagePath: join(fixtureDir, 'img-en.png'),
      mutate: (header) => {
        const assets = header.assets as { lang: string; path: string; bytes: number; sha256: string }[]
        assets[0] = { ...assets[0], sha256: 'f'.repeat(64) }
      },
    }),
    await runDirectWorkerCase({
      id: 'direct-missing-langpath',
      purpose: 'langPath 指向不存在的目录 ⇒ 工作器必须在加载任何 OCR 组件之前失败',
      expectCode: 'assets_missing',
      imagePath: join(fixtureDir, 'img-en.png'),
      mutate: (header) => {
        header.langPath = join(scratchDir, 'no-such-langpath')
      },
    }),
  ]

  const treeAfter = treeFingerprint(ocrDataDir)
  const cacheAfter = cacheDirListing()
  const spawnLines = readJsonLines(spawnLogPath)
  const netGuardLines = readJsonLines(netGuardLogPath)
  const netAttemptLines = netGuardLines.filter((line) => line.event === 'attempt')
  const childReportedAttempts = readings.reduce(
    (sum, entry) => sum + (entry.childReportedNetworkAttempts ?? 0),
    0
  )
  const stderrMarkers = readings.filter((entry) => entry.stderrNetAttemptMarkers > 0).length

  const guardThreads = new Set(netGuardLines.map((line) => String(line.thread ?? '?')))
  const guardPids = new Set(netGuardLines.map((line) => String(line.pid ?? '?')))

  const networkVerdict = {
    parentAttempts: parentNetwork.attempts,
    parentAttemptLog: parentNetwork.log,
    parentPatchedEntryPoints: parentNetwork.patched,
    childGuardLoadedLines: netGuardLines.filter((line) => line.event === 'guard-loaded').length,
    childGuardPids: [...guardPids],
    childGuardThreads: [...guardThreads],
    childGuardAttemptLines: netAttemptLines.length,
    childGuardAttemptLog: netAttemptLines,
    workerSelfReportedAttempts: childReportedAttempts,
    workerSelfReportedCrossThreadGuardMissing: readings.filter(
      (entry) => entry.turnContentEmitted && entry.childCrossThreadGuard !== true
    ).length,
    stderrMarkerHits: stderrMarkers,
    totalAttempts: parentNetwork.attempts + netAttemptLines.length + childReportedAttempts,
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    status: 'RAN',
    command: 'node node_modules/tsx/dist/cli.mjs scripts/utility-skills/probe-image-ocr.ts',
    environment: {
      node: process.version,
      platform: process.platform,
      repoRoot,
      fixtureDir,
      scratchDir,
      realWorkerScript,
      limits: { ...OCR_LIMITS },
    },
    defaultPaths: {
      langPath: defaultOcrLangDir(),
      cachePath: defaultOcrCacheDir(),
      corePath: defaultOcrCorePath(),
      tesseractWorkerScript: defaultTesseractWorkerScript(),
      tesseractEntry: defaultTesseractEntry(),
      dataPackageRoot: defaultTesseractDataPackageRoot(),
      repoRoot: OCR_REPO_ROOT,
      note:
        '这些是 createImageOcrAdapter({ root }) 的缺省值：全部 import.meta.url 相对的仓库内本地路径，' +
        '没有一个是 CDN；每个都可以用具名环境变量覆盖。',
    },
    materialization: {
      sourcePackageRoot: dataPackageRoot,
      sourcePaths: materializedNow.assets.map((asset) => ({
        lang: asset.lang,
        sourcePath: asset.sourcePath,
        targetPath: asset.path,
        bytes: asset.bytes,
        sha256: asset.sha256,
        copiedThisRun: asset.copied,
      })),
      ensuredProblems: ensured.problems,
      materializeProblems: materializedNow.problems,
      createDir: materializedNow.dir,
      materializedCreatedThisRun: materializedNow.created,
      lazyRecreate: {
        deletedDir: langPath,
        deleted: langDirDeleted,
        filesBeforeDelete: langDirBeforeDelete.files,
        filesAfterRecreate: langDirAfterDelete.files,
        rebuiltByteIdentical: rebuiltIdentical,
        caseId: 'lazy-materialize-after-delete',
        caseMet: lazyCase.met,
      },
    },
    assets: {
      paths: probeAssetPaths,
      builtinHashTable: OCR_TRAINEDDATA_ASSETS,
      reading: assetsReading,
      facts: describeAssetReading(assetsReading),
      treeBefore,
      treeAfter,
      treeFingerprintUnchanged:
        JSON.stringify(treeBefore.files) === JSON.stringify(treeAfter.files) &&
        treeBefore.fileCount === treeAfter.fileCount,
      cacheDirBefore: cacheBefore,
      cacheDirAfter: cacheAfter,
      cacheDirStayedEmpty: cacheAfter.length === 0 && cacheBefore.length === 0,
      generatedFixtures: generated,
      generatedFixtureSizes: Object.fromEntries(
        Object.entries(generated).map(([key, value]) => [key, statSync(value).size])
      ),
      fixtureIntegrity: [...manifest.values()]
        .filter((entry) => entry.kind === 'image')
        .map((entry) => {
          const absolute = join(fixtureDir, entry.path)
          const bytes = readFileSync(absolute)
          const sha256 = sha256Hex(bytes)
          return {
            path: entry.path,
            bytes: bytes.byteLength,
            sha256,
            manifestSha256: entry.sha256,
            manifestBytes: entry.bytes,
            matchesManifest: sha256 === entry.sha256 && bytes.byteLength === entry.bytes,
            ocrReference: entry.expect.ocrReference ?? null,
          }
        }),
    },
    network: networkVerdict,
    cases: readings,
    summary: summarize(readings),
    lifecycle: {
      timeout: (() => {
        const entry = readings.find((item) => item.id === 'life-timeout-then-recover')
        return entry === undefined
          ? null
          : {
              caseId: entry.id,
              status: entry.status,
              failureCode: entry.failureCode,
              normalizedStatus: entry.normalizedStatus,
              exitCode: entry.exitCode,
              signal: entry.signal,
              killReason: entry.killReason,
              released: entry.released,
              adapterCallMs: entry.adapterCallMs,
              failureDetails: entry.failureDetails,
              spawned: entry.spawned,
              spawnEvidence: entry.spawnEvidence,
            }
      })(),
      cancel: (() => {
        const entry = readings.find((item) => item.id === 'life-cancel-midflight')
        return entry === undefined
          ? null
          : {
              caseId: entry.id,
              status: entry.status,
              failureCode: entry.failureCode,
              normalizedStatus: entry.normalizedStatus,
              exitCode: entry.exitCode,
              signal: entry.signal,
              killReason: entry.killReason,
              released: entry.released,
              adapterCallMs: entry.adapterCallMs,
              failureDetails: entry.failureDetails,
              spawned: entry.spawned,
              spawnEvidence: entry.spawnEvidence,
            }
      })(),
      recovery: (() => {
        const entry = readings.find((item) => item.id === 'life-recovery-after-timeout')
        return entry === undefined
          ? null
          : {
              caseId: entry.id,
              status: entry.status,
              met: entry.met,
              metNotes: entry.metNotes,
              confidence: entry.confidence,
              coldStartMs: entry.coldStartMs,
              recognizeMs: entry.recognizeMs,
              adapterCallMs: entry.adapterCallMs,
              exitCode: entry.exitCode,
              spawnEvidence: entry.spawnEvidence,
              note: '紧接在超时被杀之后跑的正常识别：恢复成功即证明"杀掉工作器"没有污染后续调用。',
            }
      })(),
    },
    directWorkerCases: directCases,
    concurrency,
    spawnLog: { path: spawnLogPath, lines: spawnLines },
    netGuardLog: { path: netGuardLogPath, lineCount: netGuardLines.length },
  }

  mkdirSync(join(prepDir, 'runs'), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  process.stdout.write(
    [
      `probe-image-ocr: ${readings.filter((entry) => entry.met).length}/${readings.length} 用例达到期望`,
      `network totalAttempts=${networkVerdict.totalAttempts}（父进程 ${parentNetwork.attempts} / 子进程守卫 ${netAttemptLines.length} / 工作器自报 ${childReportedAttempts}）`,
      `assets treeFingerprintUnchanged=${String(payload.assets.treeFingerprintUnchanged)} cacheStayedEmpty=${String(payload.assets.cacheDirStayedEmpty)}`,
      `directWorker ${directCases.filter((entry) => entry.met).length}/${directCases.length} 达到期望`,
      `concurrency=${String(concurrency.met)}`,
      `written → ${outPath}`,
    ].join('\n') + '\n'
  )
}

interface ConcurrencyReading {
  first: { status: string; failureCode: string | null }
  second: { status: string; failureCode: string | null }
  met: boolean
  notes: string[]
}

/**
 * "首版一个 worker"：同一适配器实例上并发两次调用，第二次必须**失败关闭**（不排队）。
 *
 * ⚠️ 两次 `execute` 之间不 await：第一次在同步段就把 in-flight 置位，
 *    因此第二次一定看见它（这是确定性的，不靠时序运气）。
 */
async function runConcurrencyCase(manifest: Map<string, ManifestEntry>): Promise<ConcurrencyReading> {
  const adapter = createImageOcrAdapter({
    // 刻意**不给**任何路径：装配层的目标形状就是 `{ root }`
    root: fixtureDir,
    env: probeEnv('concurrency-two-calls'),
  })
  const makeInput = (target: string): AdapterExecuteInput => ({
    actionId: newActionId(),
    operation: IMAGE_OCR_OPERATION,
    target: { type: 'sandbox_file', canonicalId: target, confidence: 'exact' },
    args: {},
    now: () => Date.now(),
  })

  const settle = async (
    promise: Promise<AdapterOutcome>
  ): Promise<{ status: string; failureCode: string | null }> => {
    try {
      const outcome = await promise
      return { status: outcome.partial !== undefined ? 'partial' : 'success', failureCode: null }
    } catch (error) {
      return {
        status: error instanceof ActionFailureError ? actionStatusOfFailure(error.failure.code) : 'unknown',
        failureCode: error instanceof ActionFailureError ? error.failure.code : null,
      }
    }
  }

  const [first, second] = await Promise.all([
    settle(adapter.execute(makeInput('img-en.png'))),
    settle(adapter.execute(makeInput('img-zh.png'))),
  ])

  const notes: string[] = []
  const okOrder = first.status === 'success' && second.failureCode === 'execution_failed'
  const rejectedOrder = second.status === 'success' && first.failureCode === 'execution_failed'
  if (!okOrder && !rejectedOrder) {
    notes.push(
      `期望"恰好一个成功 + 一个 execution_failed"，实际 first=${first.status}/${String(first.failureCode)} second=${second.status}/${String(second.failureCode)}`
    )
  }
  // 参考：manifest 只为"读到了什么"提供基线，这里不参与判定
  void manifest
  return { first, second, met: notes.length === 0, notes }
}

main().catch((error) => {
  process.stderr.write(`probe-image-ocr 失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
