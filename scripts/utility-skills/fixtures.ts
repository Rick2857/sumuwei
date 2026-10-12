/**
 * fixtures —— 实用能力验收的**共享 fixture 载体**（`scripts/utility-skills-verify.ts` 专用）。
 *
 * ============================================================================
 *  三条纪律
 * ============================================================================
 * ① **独立期望值只能来自 `manifest.json`**：
 *    `files[].expect.mustContain` / `expect.ocrReference` / `expect.webExpect` 是准备期
 *    独立写下的参考答案。本模块**不**从组件输出回填期望 —— 那会让"断言"变成"复述"。
 *
 * ② **每个 fixture 的 SHA-256 都要与 manifest 逐字核对**：
 *    读数来自被核对过字节的那份文件，而不是"路径上恰好是那个文件"。
 *    对不上 ⇒ 调用方必须判 `NOT RUN`（`loadFixtureSet` 把问题逐条记在 `problems` 里）。
 *
 * ③ **交付给适配器的副本必须落在沙箱根内**：
 *    `document.read` / `image.ocr` 走 `resolveSandboxPath`（语法 + realpath 双层），
 *    manifest 目录在本仓库的 `artifacts/` 树里、且**会被后续运行覆写**，
 *    因此读的是**复制到本次运行沙箱**的那一份（原文件只读、前后指纹不变）。
 *
 * ⚠️ 本模块**不**碰数据库，也不 `isolateDatabase()`（那由主脚本在 import 之前做）。
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// manifest 形状（只声明我们真的消费的字段；多出来的字段原样保留在 `raw` 里）
// ---------------------------------------------------------------------------

export interface FixtureDocumentExpect {
  mustContain?: readonly string[]
  mustNotContain?: readonly string[]
  structure?: readonly string[]
  note?: string
  overLimit?: boolean
  rasterTextNotExtractable?: string
}

export interface FixtureImageExpect {
  ocrReference?: string
  keyNumbers?: readonly string[]
  clear?: boolean
  note?: string
}

export interface FixtureWebExpect {
  title?: string
  articleMustContain?: readonly string[]
  articleMustNotContain?: readonly string[]
  scriptMustNotRun?: boolean
  scriptMarker?: string
  navTextIsBoilerplate?: readonly string[]
  adText?: string
  minArticleParagraphs?: number
  minBodyChars?: number
  hasImg?: string
  staticProseIsEmpty?: boolean
}

export interface FixtureExpect {
  mustContain?: readonly string[]
  mustNotContain?: readonly string[]
  structure?: readonly string[]
  note?: string
  overLimit?: boolean
  rasterTextNotExtractable?: string
  ocrReference?: string
  keyNumbers?: readonly string[]
  clear?: boolean
  webExpect?: FixtureWebExpect
}

export interface FixtureEntry {
  path: string
  sha256?: string
  bytes?: number
  kind?: string
  expect?: FixtureExpect
  raw: Record<string, unknown>
}

export interface FixtureManifest {
  generatedAtUtc?: string
  generator?: string
  files: readonly FixtureEntry[]
  raw: Record<string, unknown>
}

export interface FixtureSet {
  /** 绝对路径的 fixtures 目录 */
  dir: string
  /** `manifest.json` 的绝对路径 */
  manifestPath: string
  manifestExists: boolean
  manifest?: FixtureManifest
  /** 非空 ⇒ 调用方判 `NOT RUN`，并把原因逐条写进读数 */
  problems: readonly string[]
  /** 真的量到的 fixture 条数（计数型自检；0 ⇒ 测量无效） */
  measuredCount: number
  /** 逐条：路径 → 磁盘上的实际 sha256 / 字节数 / 是否与 manifest 一致 */
  verified: readonly {
    path: string
    absPath: string
    exists: boolean
    bytes: number | null
    sha256: string | null
    expectedSha256: string | null
    expectedBytes: number | null
    ok: boolean
    problem?: string
  }[]
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

export function sha256OfFile(absolutePath: string): string | undefined {
  if (!existsSync(absolutePath)) return undefined
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex')
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((item): item is string => typeof item === 'string')
  return out.length === value.length ? out : undefined
}

function parseManifest(raw: unknown, manifestPath: string): FixtureManifest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${manifestPath} 的顶层不是对象`)
  }
  const record = raw as Record<string, unknown>
  const filesRaw = record.files
  if (!Array.isArray(filesRaw)) {
    throw new Error(`${manifestPath} 里没有 files 数组`)
  }
  const files: FixtureEntry[] = []
  for (const item of filesRaw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const entry = item as Record<string, unknown>
    if (typeof entry.path !== 'string' || entry.path === '') continue
    const expectRaw =
      entry.expect !== null && typeof entry.expect === 'object' && !Array.isArray(entry.expect)
        ? (entry.expect as Record<string, unknown>)
        : undefined
    const webRaw =
      expectRaw?.webExpect !== null &&
      typeof expectRaw?.webExpect === 'object' &&
      !Array.isArray(expectRaw?.webExpect)
        ? (expectRaw?.webExpect as Record<string, unknown>)
        : undefined
    const expect: FixtureExpect | undefined =
      expectRaw === undefined
        ? undefined
        : {
            ...(asStringArray(expectRaw.mustContain) !== undefined
              ? { mustContain: asStringArray(expectRaw.mustContain) as string[] }
              : {}),
            ...(asStringArray(expectRaw.mustNotContain) !== undefined
              ? { mustNotContain: asStringArray(expectRaw.mustNotContain) as string[] }
              : {}),
            ...(asStringArray(expectRaw.structure) !== undefined
              ? { structure: asStringArray(expectRaw.structure) as string[] }
              : {}),
            ...(typeof expectRaw.note === 'string' ? { note: expectRaw.note } : {}),
            ...(expectRaw.overLimit === true ? { overLimit: true } : {}),
            ...(typeof expectRaw.rasterTextNotExtractable === 'string'
              ? { rasterTextNotExtractable: expectRaw.rasterTextNotExtractable }
              : {}),
            ...(typeof expectRaw.ocrReference === 'string'
              ? { ocrReference: expectRaw.ocrReference }
              : {}),
            ...(asStringArray(expectRaw.keyNumbers) !== undefined
              ? { keyNumbers: asStringArray(expectRaw.keyNumbers) as string[] }
              : {}),
            ...(typeof expectRaw.clear === 'boolean' ? { clear: expectRaw.clear } : {}),
            ...(webRaw !== undefined ? { webExpect: parseWebExpect(webRaw) } : {}),
          }
    files.push({
      path: entry.path,
      ...(typeof entry.sha256 === 'string' ? { sha256: entry.sha256 } : {}),
      ...(typeof entry.bytes === 'number' ? { bytes: entry.bytes } : {}),
      ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
      ...(expect !== undefined ? { expect } : {}),
      raw: entry,
    })
  }
  return {
    ...(typeof record.generatedAtUtc === 'string' ? { generatedAtUtc: record.generatedAtUtc } : {}),
    ...(typeof record.generator === 'string' ? { generator: record.generator } : {}),
    files,
    raw: record,
  }
}

function parseWebExpect(raw: Record<string, unknown>): FixtureWebExpect {
  return {
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    ...(asStringArray(raw.articleMustContain) !== undefined
      ? { articleMustContain: asStringArray(raw.articleMustContain) as string[] }
      : {}),
    ...(asStringArray(raw.articleMustNotContain) !== undefined
      ? { articleMustNotContain: asStringArray(raw.articleMustNotContain) as string[] }
      : {}),
    ...(typeof raw.scriptMustNotRun === 'boolean' ? { scriptMustNotRun: raw.scriptMustNotRun } : {}),
    ...(typeof raw.scriptMarker === 'string' ? { scriptMarker: raw.scriptMarker } : {}),
    ...(asStringArray(raw.navTextIsBoilerplate) !== undefined
      ? { navTextIsBoilerplate: asStringArray(raw.navTextIsBoilerplate) as string[] }
      : {}),
    ...(typeof raw.adText === 'string' ? { adText: raw.adText } : {}),
    ...(typeof raw.minArticleParagraphs === 'number'
      ? { minArticleParagraphs: raw.minArticleParagraphs }
      : {}),
    ...(typeof raw.minBodyChars === 'number' ? { minBodyChars: raw.minBodyChars } : {}),
    ...(typeof raw.hasImg === 'string' ? { hasImg: raw.hasImg } : {}),
    ...(typeof raw.staticProseIsEmpty === 'boolean'
      ? { staticProseIsEmpty: raw.staticProseIsEmpty }
      : {}),
  }
}

/**
 * 载入 fixture 集：读 manifest、逐条核对 SHA-256/字节数。
 *
 * ⚠️ `manifest.json` 缺失 ⇒ `manifestExists: false` 且 `problems` 里有具名原因。
 *    调用方据此判 `NOT RUN`（**绝不** PASS）：没有独立期望值时，"读到了东西"
 *    与"读到了对的东西"在输出上长得一样。
 */
export function loadFixtureSet(fixturesDir: string): FixtureSet {
  const dir = resolve(fixturesDir)
  const manifestPath = join(dir, 'manifest.json')
  const problems: string[] = []

  if (!existsSync(manifestPath)) {
    return {
      dir,
      manifestPath,
      manifestExists: false,
      problems: [`fixture manifest 不存在：${manifestPath}`],
      measuredCount: 0,
      verified: [],
    }
  }

  let manifest: FixtureManifest
  try {
    manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown, manifestPath)
  } catch (error) {
    return {
      dir,
      manifestPath,
      manifestExists: true,
      problems: [`fixture manifest 解析失败：${(error as Error).message}`],
      measuredCount: 0,
      verified: [],
    }
  }

  if (manifest.files.length === 0) {
    problems.push('manifest.files 是空数组（"核对了 0 个 fixture、发现 0 处不一致"不是 PASS）')
  }

  const verified: FixtureSet['verified'][number][] = []
  for (const entry of manifest.files) {
    const absPath = join(dir, entry.path)
    if (!existsSync(absPath)) {
      problems.push(`fixture 文件不存在：${entry.path}`)
      verified.push({
        path: entry.path,
        absPath,
        exists: false,
        bytes: null,
        sha256: null,
        expectedSha256: entry.sha256 ?? null,
        expectedBytes: entry.bytes ?? null,
        ok: false,
        problem: '文件不存在',
      })
      continue
    }
    const bytes = readFileSync(absPath)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const expectedSha256 = entry.sha256 ?? null
    const expectedBytes = entry.bytes ?? null
    const problems0: string[] = []
    if (expectedSha256 === null) problems0.push('manifest 里没有 sha256')
    else if (sha256 !== expectedSha256) problems0.push(`sha256 不符（实际 ${sha256}）`)
    if (expectedBytes === null) problems0.push('manifest 里没有字节数')
    else if (bytes.byteLength !== expectedBytes) {
      problems0.push(`字节数不符（实际 ${String(bytes.byteLength)}）`)
    }
    if (problems0.length > 0) problems.push(`fixture ${entry.path}：${problems0.join('；')}`)
    verified.push({
      path: entry.path,
      absPath,
      exists: true,
      bytes: bytes.byteLength,
      sha256,
      expectedSha256,
      expectedBytes,
      ok: problems0.length === 0,
      ...(problems0.length > 0 ? { problem: problems0.join('；') } : {}),
    })
  }

  return {
    dir,
    manifestPath,
    manifestExists: true,
    manifest,
    problems,
    measuredCount: verified.length,
    verified,
  }
}

export function manifestEntry(set: FixtureSet, path: string): FixtureEntry | undefined {
  return set.manifest?.files.find((entry) => entry.path === path)
}

export function expectOf(set: FixtureSet, path: string): FixtureExpect {
  return manifestEntry(set, path)?.expect ?? {}
}

export function webExpectOf(set: FixtureSet, path: string): FixtureWebExpect {
  return expectOf(set, path).webExpect ?? {}
}

/** manifest 里声明的 sha256（调用方据此断言"复制过来的就是那一份"） */
export function declaredSha256(set: FixtureSet, path: string): string | undefined {
  return manifestEntry(set, path)?.sha256
}

// ---------------------------------------------------------------------------
// 复制进本次运行的沙箱（原文件只读）
// ---------------------------------------------------------------------------

/** 本次运行独占的 fixture 沙箱根（沙箱内路径稳定 ⇒ 用户原话可复用） */
export function makeFixtureSandbox(
  baseDir: string,
  sourceDir: string
): {
  /** 沙箱根的绝对路径（给 `resolveSandboxPath` 用） */
  root: string
  /** 把 manifest 里的一个 fixture 复制进沙箱，返回**沙箱相对**路径 */
  copy: (fixturePath: string, sandboxName?: string) => string
  /** 写一个运行期生成的文本文件（sentinel 用例等），返回**沙箱相对**路径 */
  writeText: (sandboxName: string, text: string) => string
  /** 写一个运行期生成的二进制文件 */
  writeBytes: (sandboxName: string, bytes: Uint8Array) => string
  /** 沙箱内的绝对路径 */
  abs: (sandboxName: string) => string
  /** 沙箱根的绝对路径 */
  readonly rootAbs: string
} {
  const rootAbs = resolve(baseDir)
  const sourceAbs = resolve(sourceDir)
  mkdirSync(rootAbs, { recursive: true })

  const abs = (sandboxName: string): string => join(rootAbs, sandboxName)

  return {
    root: rootAbs,
    rootAbs,
    abs,
    copy(fixturePath, sandboxName = fixturePath) {
      const target = abs(sandboxName)
      mkdirSync(resolve(target, '..'), { recursive: true })
      copyFileSync(join(sourceAbs, fixturePath), target)
      return sandboxName.split('\\').join('/')
    },
    writeText(sandboxName, text) {
      const target = abs(sandboxName)
      mkdirSync(resolve(target, '..'), { recursive: true })
      writeFileSync(target, text)
      return sandboxName.split('\\').join('/')
    },
    writeBytes(sandboxName, bytes) {
      const target = abs(sandboxName)
      mkdirSync(resolve(target, '..'), { recursive: true })
      writeFileSync(target, bytes)
      return sandboxName.split('\\').join('/')
    },
  }
}
