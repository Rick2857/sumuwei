/**
 * image-ocr-worker.mjs —— `image.ocr` 的**子进程执行器**（实用能力加装计划 §3.1「OCR」）。
 *
 * ============================================================================
 *  它只知道**字节**，不知道路径、也不知道 URL
 * ============================================================================
 * 父进程（`image-ocr.ts`）通过 stdin 交给它的东西只有两段：
 *
 * ```text
 * stdin  := <一行 UTF-8 JSON 头>\n<原始图片字节>
 * stdout := 恰好一行 `IMAGE_OCR_RESULT=<JSON>`（任何库噪声都只许走 stderr）
 * 退出码 := 0 成功 / 2 协议错 / 3 资产缺失（未加载任何 OCR 组件）/ 4 超时 / 5 执行失败
 * ```
 *
 * 于是"工作器自己按路径去读图 / 自己按 URL 去下载"在**协议上**不可能：
 * 头里只有**执行器与语言资产的绝对路径**（都由父进程给定），
 * 没有任何"去哪里取图片"的入口 —— 图片只能以字节形式从 stdin 进来。
 *
 * ============================================================================
 *  离线是**结构性**的，不是纪律
 * ============================================================================
 * tesseract.js 的 worker-script（`src/worker-script/index.js:130`）在
 * `langPath` 缺省时会拼出 jsDelivr CDN；本项目**永远**显式给出本地 `langPath`，
 * 且 `cacheMethod: 'none'` 让缓存分支（`:103` / `:179`）整段失效。
 * 除此之外这里还自己装两道守卫：
 *
 *   ① 本线程：`globalThis.fetch` / `node:http` / `node:https` / `node:dns`
 *      一旦被调用就**写 marker 到 stderr 并抛错**（同时计数）。
 *   ② tesseract 的 worker 线程：在 `require('tesseract.js')` **之前**把
 *      `worker_threads.Worker` 换成会注入 `--import <内联守卫>` 的子类
 *      （tesseract 的 `spawnWorker` 在 require 时解构 `Worker`，因此必须抢先）。
 *      ⇒ 真正的语言数据读取发生在线程里，那一段也被同一套守卫罩住。
 *
 * 守卫的读数（`networkAttempts` / `crossThreadGuard`）随结果 JSON 一起回给父进程。
 *
 * ⚠️ 两处**实测坑**（记录在 `artifacts/post-lv2/local/utility-skills-preparation/runs/ocr-probe.json`）：
 *    · `dataPath` **不能**设：多语言并发 `FS.mkdir` 的 EEXIST 会让 worker-script
 *      先 reject 后 resolve，`createWorker` 随即解引用已删除的 promise 条目而崩（退出码 1）。
 *    · 语言顺序有意义：`chi_sim+eng` 会让第二个语言加载失败（tesseract 打印
 *      "Failed loading language"），`eng+chi_sim` 才两个都在。父进程负责给规范顺序，
 *      这里**原样**使用头里给的顺序并在结果里如实回报。
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'

/** 结果行的前缀：父进程按它从 stdout 里取那**一行**（库噪声可能混进 stdout） */
const RESULT_MARKER = 'IMAGE_OCR_RESULT='
/** 网络尝试 marker：父进程按它统计"工作器这一侧到底碰没碰网络" */
const NET_ATTEMPT_MARKER = 'IMAGE_OCR_NET_ATTEMPT'

const require = createRequire(import.meta.url)

// ---------------------------------------------------------------------------
// ① 本线程离线守卫（计数 + 抛错）
// ---------------------------------------------------------------------------

/** 本线程被守卫拦下的网络调用次数（正常路径下恒为 0） */
let networkAttempts = 0
const guardedEntryPoints = []

function markNetworkAttempt(what) {
  networkAttempts += 1
  try {
    process.stderr.write(`${NET_ATTEMPT_MARKER} thread=main what=${what}\n`)
  } catch {
    /* stderr 写不进去也不能让守卫本身出错 */
  }
}

function denyNetwork(what) {
  markNetworkAttempt(what)
  throw new Error(`IMAGE_OCR_OFFLINE_GUARD: 本进程不允许网络访问（${what}）`)
}

function installThreadGuard() {
  try {
    if (typeof globalThis.fetch === 'function') {
      globalThis.fetch = (...unusedArgs) => denyNetwork('fetch')
      guardedEntryPoints.push('fetch')
    }
  } catch {
    /* 装不上就少一个入口，结果里如实少一条 */
  }
  for (const [name, specifier, keys] of [
    ['http', 'node:http', ['request', 'get']],
    ['https', 'node:https', ['request', 'get']],
    ['dns', 'node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6']],
  ]) {
    try {
      const mod = require(specifier)
      for (const key of keys) {
        if (typeof mod[key] === 'function') {
          mod[key] = (...unusedArgs) => denyNetwork(`${name}.${key}`)
          guardedEntryPoints.push(`${name}.${key}`)
        }
      }
    } catch {
      /* 同上：守卫装不上不改变主流程，但读数里看得见 */
    }
  }
}

// ---------------------------------------------------------------------------
// ② tesseract worker 线程的离线守卫（内联 data: 模块，由 Worker 子类注入）
// ---------------------------------------------------------------------------

const CROSS_THREAD_GUARD_SOURCE = [
  "import http from 'node:http';",
  "import https from 'node:https';",
  "import dns from 'node:dns';",
  "import { threadId } from 'node:worker_threads';",
  `const mark = (what) => { try { process.stderr.write('${NET_ATTEMPT_MARKER} thread=' + threadId + ' what=' + what + '\\n'); } catch (e) {} };`,
  "const deny = (what) => { mark(what); throw new Error('IMAGE_OCR_OFFLINE_GUARD: 本线程不允许网络访问（' + what + '）'); };",
  "try { globalThis.fetch = (...a) => deny('fetch'); } catch (e) {}",
  "for (const [name, mod, keys] of [['http', http, ['request', 'get']], ['https', https, ['request', 'get']], ['dns', dns, ['lookup']]]) {",
  "  for (const key of keys) { try { mod[key] = (...a) => deny(name + '.' + key); } catch (e) {} }",
  "}",
  "globalThis.__IMAGE_OCR_OFFLINE_GUARD__ = true;",
].join('\n')

const CROSS_THREAD_GUARD_URL = `data:text/javascript,${encodeURIComponent(CROSS_THREAD_GUARD_SOURCE)}`

/**
 * 把 `worker_threads.Worker` 换成注入离线守卫的子类。
 *
 * ⚠️ 必须在 `require('tesseract.js')` **之前**做：`src/worker/node/spawnWorker.js:3`
 *    在模块加载时就 `const { Worker } = require('worker_threads')` 解构走了。
 *
 * @returns {boolean} 是否注入成功
 */
function installCrossThreadGuard() {
  try {
    const wt = require('node:worker_threads')
    if (wt.__imageOcrGuardPatched === true) return true
    const Base = wt.Worker
    class OfflineGuardedWorker extends Base {
      constructor(filename, options = {}) {
        const inherited = Array.isArray(options.execArgv) ? options.execArgv : process.execArgv
        super(filename, { ...options, execArgv: [...inherited, '--import', CROSS_THREAD_GUARD_URL] })
      }
    }
    wt.Worker = OfflineGuardedWorker
    wt.__imageOcrGuardPatched = true
    return true
  } catch {
    return false
  }
}

installThreadGuard()
const crossThreadGuardInstalled = installCrossThreadGuard()

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function writeResultLine(payload) {
  return new Promise((resolve) => {
    process.stdout.write(`${RESULT_MARKER}${JSON.stringify(payload)}\n`, () => resolve())
  })
}

/** 失败：**一个** JSON 对象 + 指定退出码（先写完 stdout 再退） */
async function fail(code, message, exitCode, extra = {}) {
  await writeResultLine({
    ok: false,
    code,
    message,
    networkAttempts,
    crossThreadGuard: crossThreadGuardInstalled,
    guardedEntryPoints,
    ...extra,
  })
  process.exit(exitCode)
}

async function succeed(payload) {
  await writeResultLine({
    ok: true,
    networkAttempts,
    crossThreadGuard: crossThreadGuardInstalled,
    guardedEntryPoints,
    ...payload,
  })
  process.exit(0)
}

// ---------------------------------------------------------------------------
// stdin：一行 JSON 头 + 原始字节
// ---------------------------------------------------------------------------

async function readAllStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function splitFraming(raw) {
  const newline = raw.indexOf(0x0a)
  if (newline < 0) return null
  return { headerBytes: raw.subarray(0, newline), imageBytes: raw.subarray(newline + 1) }
}

// ---------------------------------------------------------------------------
// 资产核对（缺资产 ⇒ 在**加载任何 OCR 组件之前**就失败）
// ---------------------------------------------------------------------------

async function sha256OfFile(absolutePath) {
  const bytes = await readFile(absolutePath)
  return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function verifyAssets(header) {
  const problems = []
  const verified = []
  const declared = Array.isArray(header.assets) ? header.assets : []

  for (const asset of declared) {
    const lang = typeof asset.lang === 'string' ? asset.lang : '(unnamed)'
    try {
      const info = await stat(asset.path)
      if (!info.isFile()) {
        problems.push(`${lang}: 不是文件（${String(asset.path)}）`)
        continue
      }
      const actual = await sha256OfFile(asset.path)
      if (actual.bytes !== asset.bytes) {
        problems.push(`${lang}: 字节数不符（期望 ${String(asset.bytes)}，实际 ${String(actual.bytes)}）`)
      }
      if (actual.sha256 !== asset.sha256) {
        problems.push(`${lang}: sha256 不符（期望 ${String(asset.sha256)}，实际 ${actual.sha256}）`)
      }
      if (actual.bytes === asset.bytes && actual.sha256 === asset.sha256) {
        verified.push({ lang, path: asset.path, bytes: actual.bytes, sha256: actual.sha256 })
      }
    } catch (error) {
      problems.push(`${lang}: 读不到（${error instanceof Error ? error.message : String(error)}）`)
    }
  }

  const languages = Array.isArray(header.languages) ? header.languages : []
  for (const lang of languages) {
    if (!verified.some((entry) => entry.lang === lang)) {
      problems.push(`缺少语言资产：${String(lang)}`)
    }
  }

  for (const [name, target] of [
    ['workerPath', header.workerPath],
    ['corePath', header.corePath],
    ['cachePath', header.cachePath],
    ['tesseractEntry', header.tesseractEntry],
    ['langPath', header.langPath],
  ]) {
    try {
      await stat(target)
    } catch (error) {
      problems.push(`${name} 不存在（${String(target)}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { problems, verified }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const raw = await readAllStdin()
  const framing = splitFraming(raw)
  if (framing === null) {
    await fail('protocol_error', 'stdin 里没有找到 JSON 头的换行分隔符', 2)
    return
  }

  let header
  try {
    header = JSON.parse(framing.headerBytes.toString('utf8'))
  } catch (error) {
    await fail('protocol_error', `JSON 头解析失败：${error instanceof Error ? error.message : String(error)}`, 2)
    return
  }

  const image = framing.imageBytes
  if (typeof header.imageBytes !== 'number' || header.imageBytes !== image.byteLength) {
    await fail(
      'protocol_error',
      `图片字节数与头不一致（头 ${String(header.imageBytes)}，实到 ${String(image.byteLength)}）`,
      2
    )
    return
  }

  const languages = Array.isArray(header.languages) && header.languages.length > 0 ? header.languages : ['eng']
  const requestedTimeoutMs = Number.isFinite(header.timeoutMs) && header.timeoutMs > 0 ? header.timeoutMs : 30_000
  // 留一点余量：让工作器**自己**也有机会如实报告超时，父进程的硬超时仍然是权威。
  const watchdogMs = Math.max(1_000, requestedTimeoutMs - 1_500)

  const { problems, verified } = await verifyAssets({ ...header, languages })
  if (problems.length > 0) {
    await fail('assets_missing', `本地 OCR 资产不完整：${problems.join('；')}`, 3, {
      assetProblems: problems,
      assetHashes: verified,
      loadedAnything: false,
    })
    return
  }

  let tesseract
  try {
    tesseract = require(header.tesseractEntry)
  } catch (error) {
    await fail('assets_missing', `tesseract.js 入口加载失败：${error instanceof Error ? error.message : String(error)}`, 3, {
      assetHashes: verified,
      loadedAnything: false,
    })
    return
  }

  const workerErrors = []
  const options = {
    // ---- 四个本地路径：全部显式，没有任何 CDN 缺省可以落到 ----
    workerPath: header.workerPath,
    corePath: header.corePath,
    langPath: header.langPath,
    cachePath: header.cachePath,
    // ---- 缓存整段关掉：只从 langPath 现读现解压 ----
    cacheMethod: 'none',
    gzip: true,
    // `logger` 关（tesseract.js 内部会无条件调用它，因此给一个显式空函数而不是 undefined）
    logger: () => {},
    // 不给 errorHandler 会让 onMessage 回调在 worker 侧 reject 时抛出去（createWorker.js:217）
    errorHandler: (data) => {
      workerErrors.push(String(data))
    },
  }

  const totalStart = performance.now()
  const setupStart = totalStart
  let worker = null
  try {
    worker = await withWatchdog(
      tesseract.createWorker(languages.join('+'), 1 /* OEM.LSTM_ONLY */, options),
      watchdogMs,
      'setup_timeout'
    )
  } catch (error) {
    await fail(
      error instanceof WatchdogError ? 'timeout' : 'execution_failed',
      `OCR 工作器初始化失败：${error instanceof Error ? error.message : String(error)}`,
      error instanceof WatchdogError ? 4 : 5,
      { workerErrors, assetHashes: verified, phase: 'setup' }
    )
    return
  }
  const setupMs = performance.now() - setupStart

  const recognizeStart = performance.now()
  let recognition
  try {
    recognition = await withWatchdog(
      worker.recognize(image),
      Math.max(1_000, watchdogMs - setupMs),
      'recognize_timeout'
    )
  } catch (error) {
    try {
      await worker.terminate()
    } catch {
      /* terminate 失败不影响"已失败"这个结论 */
    }
    await fail(
      error instanceof WatchdogError ? 'timeout' : 'execution_failed',
      `OCR 识别失败：${error instanceof Error ? error.message : String(error)}`,
      error instanceof WatchdogError ? 4 : 5,
      { workerErrors, assetHashes: verified, phase: 'recognize', setupMs, released: true }
    )
    return
  }
  const recognizeMs = performance.now() - recognizeStart

  // 生命周期：无论结果如何，工作器在这里被**显式**释放。
  let released = false
  try {
    await worker.terminate()
    released = true
  } catch {
    released = false
  }

  const data = recognition && typeof recognition === 'object' ? recognition.data ?? {} : {}
  await succeed({
    text: typeof data.text === 'string' ? data.text : '',
    confidence: typeof data.confidence === 'number' ? data.confidence : null,
    languages,
    setupMs,
    recognizeMs,
    totalMs: performance.now() - totalStart,
    released,
    workerErrors,
    assetHashes: verified,
    // `dump.js` 的字段名是 `version`（引擎自报版本）与 `psm` / `oem`（实际生效的分割/引擎模式）
    engineVersion: typeof data.version === 'string' ? data.version : null,
    psm: typeof data.psm === 'string' ? data.psm : null,
    oem: typeof data.oem === 'string' ? data.oem : null,
  })
}

class WatchdogError extends Error {}

function withWatchdog(promise, ms, label) {
  let timer = null
  const guard = new Promise((unusedResolve, reject) => {
    timer = setTimeout(() => reject(new WatchdogError(`工作器${label}（${String(ms)} ms）`)), ms)
  })
  return Promise.race([promise, guard]).finally(() => {
    if (timer !== null) clearTimeout(timer)
  })
}

main().catch(async (error) => {
  await fail('execution_failed', `未预期的工作器故障：${error instanceof Error ? error.message : String(error)}`, 5)
})
