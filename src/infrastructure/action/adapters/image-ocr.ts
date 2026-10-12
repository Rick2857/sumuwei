/**
 * image-ocr —— 实用能力加装 WP4：**本地** OCR 适配器（计划书 §3.1「OCR」/ §4 A 的 OCR 6 组）。
 *
 * ============================================================================
 *  边界一句话
 * ============================================================================
 * ```text
 * 目标：沙箱内一个 PNG/JPEG（复用 M4.5 的沙箱包含性纪律）
 * 动作：把**校验过的图片字节**交给一个独立子进程做本地文字识别
 * 结果：识别文字 + 引擎读数 → 一份 OcrTurnContent（当轮内存载体）
 * ```
 *
 * 四条硬性质，每条都有对应的机器判据（见 `scripts/utility-skills/probe-image-ocr.ts`）：
 *
 * ① **工作器只拿字节，不拿路径、不拿 URL**
 *    子进程的 stdin 是 `<一行 JSON 头>\n<原始图片字节>`，头里只有执行器与语言资产的
 *    **绝对路径**（都由装配层给定），没有"图片在哪"的入口 ⇒ 工作器**没有能力**
 *    自己去读别的文件或去下载 —— 这是协议层面的，不是纪律层面的。
 *
 * ② **离线是结构性的**
 *    RapidOCR 分支只读固定 ONNX 模型并逐个核对指纹，Python 工作器重查版本/指纹，
 *    socket/HTTP 守卫在库导入前安装。下面的路径/缓存约定描述保留的 Tesseract 分支。
 *    tesseract.js 的 worker-script 只在 `langPath` **缺省**时才拼 jsDelivr CDN 地址；
 *    这里 `workerPath/corePath/langPath/cachePath` 四个路径**永远**显式传入，
 *    且 `cacheMethod: 'none'`。四个路径里任何一个不存在、任何一个语言资产的
 *    字节数或 SHA-256 对不上**内置表**，就在**孵化子进程之前**归一失败
 *    ⇒ "缺资产"这条路径上连一个 OCR 组件都没被加载过。
 *    子进程那一侧还会再自查一遍（防 TOCTOU：父进程核对完之后资产被换掉），
 *    并回报它自己拦下的网络调用计数（正常恒为 0）。
 *
 * ③ **上限与释放**
 *    16 MiB / 20 MP 在识别前校验（内置 PNG IHDR / JPEG SOF 解析，不引新依赖）；
 *    30 s 硬超时（或调用方给的 AbortSignal）⇒ `SIGKILL` 子进程并**等它真的退出**，
 *    释放事实进 `facts`。第二次调用**不受上一次被杀影响**（每次调用一个全新子进程，
 *    互不共享状态，因此"恢复"是构造性的）。
 *
 * ④ **空识别不是"成功且带内容"**
 *    图里没有文字时返回 `partial`（`completed: 0 / total: 1`）+ `effect.kind='no_change'`，
 *    且**不发** `turnContent`。理由：`execution_failed` 会谎称"执行出错了"（没有出错），
 *    `unsupported` 会谎称"不支持"（支持），`success` 会让账本与回复层都以为拿到了内容。
 *    `partial` 是既有的、被 `web-search.ts` 用过的同一档语义（"跑完了，但没有可引用的内容"），
 *    在回复层映射到 `empty` 态 —— "我打开看了，但这次没有取到可以引用的内容"。
 *
 * ⚠️ 两处**实测**（读数在 `artifacts/post-lv2/local/utility-skills-preparation/runs/`）：
 *    · 语言顺序有意义。`chi_sim+eng` 会让第二个语言（eng）静默丢失
 *      （tesseract 打印 "Failed loading language"，英文 confidence 掉到 chi_sim-only 的水平）。
 *      ⇒ 规范加载顺序是 `eng` 在前（`OCR_LANGUAGE_LOAD_ORDER`）；代价是退化中文样本
 *      分数低于 chi_sim-only（67 vs 75），这一点如实留在 `facts` 里。
 *    · `corePath` 在 tesseract.js v7 的 **Node** 路径上被忽略
 *      （`src/worker/node/spawnWorker.js` 只做 `new Worker(workerPath)`，
 *      `src/worker-script/node/getCore.js` 的 `corePath` 形参是 `_`，wasm 核心由 `require()` 解析）。
 *      这里仍然显式传入并**核对存在性**，但不谎称它在起作用 —— 见 `OCR_CORE_PATH_NOTE`。
 */

import { spawn } from 'node:child_process'
import { defaultRapidOcrModels, defaultRapidOcrPython, verifyRapidOcrAssets, type RapidOcrWorkerHeader } from './rapid-ocr-assets.ts'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import { ActionFailureError, actionFailure, normalizeAdapterError } from '../../../kernel/action/errors.ts'
import type {
  AdapterExecuteInput,
  AdapterOutcome,
  CapabilityAdapter,
} from '../../../kernel/action/executor-port.ts'
import { stringArg } from '../../../kernel/action/executor-port.ts'
import { IMAGE_OCR, IMAGE_OCR_OPERATION } from '../../../kernel/action/utility-capabilities.ts'
import type { OcrTurnContent, TurnContentSourceKind } from '../../../kernel/contracts/turn-content.ts'
import { TURN_CONTENT_LIMITS } from '../../../kernel/contracts/turn-content.ts'
import { resolveSandboxPath } from './sandbox-filesystem.ts'

// ---------------------------------------------------------------------------
// 首版运行约束（计划书 §3.1 公共上限）
// ---------------------------------------------------------------------------

export const OCR_LIMITS = {
  /** 单张图片字节上限 */
  maxImageBytes: 16 * 1024 * 1024,
  /** 单张图片像素上限（尺寸在识别**之前**校验） */
  maxPixels: 20_000_000,
  /** OCR 硬超时（超时 = 杀掉子进程并等它退出，不是"再等等"） */
  timeoutMs: 30_000,
} as const

export const OCR_IMAGE_EXTENSIONS: readonly string[] = ['.png', '.jpg', '.jpeg']

/**
 * `corePath` 的诚实注记（写进 `facts` 的配置事实里，避免"配了就以为生效了"）。
 *
 * ⚠️ tesseract.js v7 的 Node 实现**不会**用这个路径：wasm 核心是在 worker 线程里
 *    由 `require('tesseract.js-core/...')` 解析出来的。我们仍然显式传入并核对目录存在，
 *    因为(a)它是 v7 的公开选项、(b)装配层应当知道这个选项在当前版本里是"记录性"的。
 */
export const OCR_CORE_PATH_NOTE =
  'corePath 在 tesseract.js v7 的 Node 路径上被忽略（wasm 核心由 require 解析）；本适配器只核对它存在'

// ---------------------------------------------------------------------------
// 语言资产（**内置哈希表**：换掉资产必须在这里改，改了就是一次显式代码变更）
// ---------------------------------------------------------------------------

export interface TraineddataAsset {
  fileName: string
  bytes: number
  sha256: string
}

/**
 * `@tesseract.js-data/<lang>@1.0.0` 的 **4.0.0_best_int**（LSTM-only）训练数据。
 *
 * 与 `createWorker(langs, 1, options)`（第二参 = OEM.LSTM_ONLY）配对。同包里还带
 * `4.0.0`（legacy+LSTM）一档，本适配器不用它；两档的哈希都记在这里是为了"换档"时
 * 不必再去找读数：
 *
 * ```text
 * chi_sim 4.0.0          20,159,757 B  59388039851e4d1293d729c183fd8c1fa9bbbb959eed996e945024671e68c1d6
 * eng     4.0.0          10,923,060 B  ed350f3752f81ee8f38769edc14d92d997dababe23b565c59879372cc46a2468
 * ```
 *
 * 读数来源：`artifacts/post-lv2/local/utility-skills-preparation/runs/ocr-assets.json`。
 */
export const OCR_TRAINEDDATA_ASSETS: Readonly<Record<string, TraineddataAsset>> = {
  chi_sim: {
    fileName: 'chi_sim.traineddata.gz',
    bytes: 1_718_768,
    sha256: 'b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c',
  },
  eng: {
    fileName: 'eng.traineddata.gz',
    bytes: 2_952_873,
    sha256: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91',
  },
}

/**
 * 规范**加载顺序**（实测：`chi_sim+eng` 会丢第二个语言；`eng+chi_sim` 两个都在）。
 *
 * ⚠️ 不要"顺手改成计划书里的 chi_sim 先" —— 那会让英文那一半静默失效。
 *    语言集合本身由调用方决定，这里只决定**顺序**。
 */
export const OCR_LANGUAGE_LOAD_ORDER: readonly string[] = ['eng', 'chi_sim']

export const OCR_DEFAULT_LANGUAGES: readonly string[] = ['eng', 'chi_sim']

/** 可用的语言（能查到内置哈希表的那些） */
export function knownOcrLanguages(): readonly string[] {
  return Object.keys(OCR_TRAINEDDATA_ASSETS)
}

/**
 * 把调用方给的语言选择规范化：只留已知语言、去重、按规范顺序排。
 *
 * 支持 `args.language`（`'eng'` / `'eng+chi_sim'` / `'chi_sim'`）与 `args.languages`（数组）。
 * 未知语言**不静默丢弃** —— 返回问题清单，由调用点归一成 `validation_failed`。
 */
export function normalizeOcrLanguages(requested: unknown): { languages: string[]; problems: string[] } {
  const problems: string[] = []
  let raw: string[] = []
  if (Array.isArray(requested)) {
    raw = requested.filter((item): item is string => typeof item === 'string')
  } else if (typeof requested === 'string') {
    raw = requested.split('+')
  } else if (requested !== undefined && requested !== null) {
    problems.push(`language 参数形状不认识：${typeof requested}`)
    return { languages: [...OCR_DEFAULT_LANGUAGES], problems }
  }

  const wanted = new Set<string>()
  for (const token of raw) {
    const lang = token.trim().toLowerCase()
    if (lang === '') continue
    if (OCR_TRAINEDDATA_ASSETS[lang] === undefined) {
      problems.push(`没有这个语言的本地资产：${lang}（可用：${knownOcrLanguages().join(' / ')}）`)
      continue
    }
    wanted.add(lang)
  }

  if (wanted.size === 0) {
    problems.push('没有指定任何可用语言')
    return { languages: [...OCR_DEFAULT_LANGUAGES], problems }
  }

  // 规范顺序：按 OCR_LANGUAGE_LOAD_ORDER 排；不在表里的（理论上不会有）接在后面保序
  const ordered = OCR_LANGUAGE_LOAD_ORDER.filter((lang) => wanted.has(lang))
  for (const lang of wanted) if (!ordered.includes(lang)) ordered.push(lang)
  return { languages: ordered, problems }
}

// ---------------------------------------------------------------------------
// 纯函数：格式 / 尺寸 / 像素（不引新依赖，自己解 PNG IHDR 与 JPEG SOF）
// ---------------------------------------------------------------------------

export type ImageFormat = 'png' | 'jpeg'

export interface ImageValidation {
  bytes: number
  format?: ImageFormat
  width?: number
  height?: number
  pixels?: number
  problems: string[]
}

/** 扩展名（沙箱相对路径）是不是受支持的图片 */
export function hasSupportedImageExtension(relativePath: string): boolean {
  const lower = relativePath.toLowerCase()
  return OCR_IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/** magic bytes：PNG `89 50 4E 47`，JPEG `FF D8 FF` */
export function detectImageFormat(bytes: Uint8Array): ImageFormat | undefined {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg'
  }
  return undefined
}

/**
 * 自己读尺寸（**不依赖任何解码库**）。
 *
 * ```text
 * PNG  : 8 字节签名 + 4 字节长度 + 'IHDR' ⇒ 偏移 16 起是 4+4 字节的大端宽/高
 * JPEG : 走 marker 段，碰到 SOF0..SOF15（C0–CF，排除 C4 DHT / C8 JPG / CC DAC）
 *        ⇒ 段内 长度(2) 精度(1) 高(2) 宽(2)
 * ```
 *
 * 读不出来就返回 `undefined` —— 由调用点归一成 `validation_failed`，
 * **不猜**默认尺寸（猜出来的像素数会让上限判据变成一句空话）。
 */
export function readImageDimensions(
  format: ImageFormat,
  bytes: Uint8Array
): { width: number; height: number } | undefined {
  if (format === 'png') {
    if (bytes.length < 24) return undefined
    // 偏移 12–15 必须是 'IHDR'：光看前 4 个字节不足以确认这是能解的 PNG
    if (!(bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52)) return undefined
    const width = readUint32BE(bytes, 16)
    const height = readUint32BE(bytes, 20)
    if (width === 0 || height === 0) return undefined
    return { width, height }
  }

  let offset = 2 // 跳过 SOI
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return undefined // EOI / 进入扫描数据：没有 SOF
    const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3]
    if (segmentLength < 2) return undefined
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (offset + 9 > bytes.length) return undefined
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6]
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8]
      if (width === 0 || height === 0) return undefined
      return { width, height }
    }
    offset += 2 + segmentLength
  }
  return undefined
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
  )
}

/**
 * 识别**之前**的全部图片校验：字节数 → magic bytes → 尺寸 → 像素数。
 *
 * 顺序是刻意的：先便宜的检查，再解析头；任何一项不过都返回问题清单，
 * 调用点据此归一失败 —— **一个字节都不会进子进程**。
 */
export function validateImageBytes(
  bytes: Uint8Array,
  limits: { maxImageBytes: number; maxPixels: number } = OCR_LIMITS
): ImageValidation {
  const problems: string[] = []
  const reading: ImageValidation = { bytes: bytes.byteLength, problems }

  if (bytes.byteLength === 0) {
    problems.push('图片是 0 字节')
    return reading
  }
  if (bytes.byteLength > limits.maxImageBytes) {
    problems.push(`图片 ${bytes.byteLength} 字节，超过上限 ${limits.maxImageBytes}`)
    return reading
  }

  const format = detectImageFormat(bytes)
  if (format === undefined) {
    problems.push('magic bytes 不是 PNG（89 50 4E 47）也不是 JPEG（FF D8 FF）')
    return reading
  }
  reading.format = format

  const dimensions = readImageDimensions(format, bytes)
  if (dimensions === undefined) {
    problems.push(`读不出 ${format.toUpperCase()} 的宽高（头被截断或不是真的 ${format.toUpperCase()}）`)
    return reading
  }
  reading.width = dimensions.width
  reading.height = dimensions.height

  const pixels = dimensions.width * dimensions.height
  reading.pixels = pixels
  if (pixels > limits.maxPixels) {
    problems.push(
      `${dimensions.width}x${dimensions.height} = ${pixels} 像素，超过上限 ${limits.maxPixels}`
    )
  }
  return reading
}

/** 内容指纹（结果/来源都用同一处实现） */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * `TurnContentScope` 的**唯一**算法（校验器要求 `includedChars === text.length`
 * 且 `truncated === totalChars > includedChars`，所以只能这样算）。
 */
export function computeOcrScope(
  text: string,
  maxTextChars: number = TURN_CONTENT_LIMITS.maxTextChars
): { text: string; totalChars: number; includedChars: number; truncated: boolean } {
  const totalChars = text.length
  const included = totalChars > maxTextChars ? text.slice(0, maxTextChars) : text
  return {
    text: included,
    totalChars,
    includedChars: included.length,
    truncated: totalChars > included.length,
  }
}

// ---------------------------------------------------------------------------
// 目标解析（复用 sandbox-filesystem 的包含性纪律，不重新发明一遍）
// ---------------------------------------------------------------------------

/** 适配器拿到的沙箱相对路径（`canonicalId` 优先，其次 `args.path`） */
export function ocrRelativePathOf(input: AdapterExecuteInput): string {
  const canonical = input.target.canonicalId
  if (canonical !== undefined && canonical !== '') return canonical
  const fromArgs = stringArg(input.args, 'path')
  if (fromArgs !== undefined && fromArgs !== '') return fromArgs
  throw new ActionFailureError(
    actionFailure('validation_failed', '适配器没有拿到路径：目标与参数里都没有 path')
  )
}

/**
 * 绝对路径解析：**直接**用 `resolveSandboxPath`。
 *
 * 刻意不复制一份实现：包含性守卫（语法 + realpath 双重比较）只有一处实现，
 * 才不会出现"文件读守住了、图片 OCR 没守住"的第二种纪律。
 *
 * ⚠️ 它同时是**绝对路径 / `..` 的拒绝点**：`path.resolve(root, 'C:/…')` 与
 *    `path.resolve(root, '../…')` 都会落到根之外，于是 `permission_denied`
 *    在**任何 `stat` / 读之前**就抛出来（探针有 `edge-absolute-path` 与
 *    `edge-parent-escape` 两条读数，且 spawn 计数为 0）。
 */
export async function resolveOcrTarget(root: string, relativePath: string): Promise<string> {
  return resolveSandboxPath({ root }, relativePath)
}

/**
 * Node 文件系统错误码 → 一个**短**机器码（`unknown` 兜底）。
 *
 * 它只用来填 `details` / 结构化读数：用户可见的 `message` 里不许出现
 * `ENOENT: no such file or directory, stat 'C:\…'` 这种原始文本（分不清
 * "这个文件不存在"与"处理过程出错了"）。
 */
export function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && code !== '' ? code : 'unknown'
}

/**
 * 文件系统错误的**显式归一**（不许把 Node 的原始消息漏到账本 / 回复层）。
 *
 * 为什么不能只靠外层的 `normalizeAdapterError`：那样 `code` 虽然对，
 * 但 `message` 会是 `ENOENT: no such file or directory, stat 'C:\…'` —— 用户面拿到一句
 * 既长、又指不出"是哪个沙箱相对路径"的话，而且**"这个文件不存在"与"识别过程出错了"
 * 在措辞上分不开**（计划书的纪律：失败不许被误报）。
 *
 * 归一规则（与 `document-read.ts` 同档，但把权限与其它错误再分开）：
 * ```text
 * ENOENT / ENOTDIR   → target_not_found   （沙箱内没有这个文件）
 * EACCES / EPERM     → permission_denied  （文件在，但系统不让读）
 * 其它 fs 错误        → execution_failed
 * ```
 * 原始错误码只进 `details`（机器可查），不进用户可见的那一句话。
 */
export function normalizeImageFileError(error: unknown, relativePath: string): ActionFailureError {
  const errorCode = errorCodeOf(error)
  if (errorCode === 'ENOENT' || errorCode === 'ENOTDIR') {
    return new ActionFailureError(
      actionFailure('target_not_found', `读不到图片：${relativePath}`, { path: relativePath, errorCode })
    )
  }
  if (errorCode === 'EACCES' || errorCode === 'EPERM') {
    return new ActionFailureError(
      actionFailure('permission_denied', `系统不让读这个图片：${relativePath}`, {
        path: relativePath,
        errorCode,
      })
    )
  }
  return new ActionFailureError(
    actionFailure('execution_failed', `读取图片失败：${relativePath}（${errorCode}）`, {
      path: relativePath,
      errorCode,
    })
  )
}

// ---------------------------------------------------------------------------
// 仓库内默认路径（`createImageOcrAdapter({ root })` 必须能直接工作）
// ---------------------------------------------------------------------------

/**
 * 从本文件位置推出的仓库根。
 *
 * ⚠️ 与 `document-read.ts` 的 `DEFAULT_DOC_RUNNER` 同一种做法（`import.meta.url` 相对）。
 *    它假设"源码树 = 运行树"（本项目用 tsx 直接跑 TS，没有 dist 打包步骤）；
 *    真要做 dist 构建时，这里和 `DEFAULT_DOC_RUNNER` 一起改。
 *
 * ⚠️ 每个路径都允许用**具名环境变量**覆盖，但**默认值永远是仓库内的本地路径** ——
 *    这里不存在任何 CDN 缺省（tesseract.js 自己在 `langPath` 缺省时会拼 jsDelivr，
 *    所以我们绝不把 `langPath` 留空）。
 */
export const OCR_REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** 物化后的扁平语言资产目录（`<lang>.traineddata.gz` 直接放这一层） */
export function defaultOcrLangDir(): string {
  return (
    process.env.PROJECT_LG_OCR_LANG_PATH ??
    join(OCR_REPO_ROOT, 'artifacts/post-lv2/local/utility-skills-preparation/ocr-data/lang')
  )
}

/** 缓存目录（`cacheMethod: 'none'` ⇒ 不会被读写；显式给出以免 tesseract 落到 CWD） */
export function defaultOcrCacheDir(): string {
  return (
    process.env.PROJECT_LG_OCR_CACHE_PATH ??
    join(OCR_REPO_ROOT, 'artifacts/post-lv2/local/utility-skills-preparation/ocr-data/cache')
  )
}

/** tesseract.js-core 目录（v7 的 Node 路径忽略它，见 `OCR_CORE_PATH_NOTE`） */
export function defaultOcrCorePath(): string {
  return process.env.PROJECT_LG_OCR_CORE_PATH ?? join(OCR_REPO_ROOT, 'node_modules/tesseract.js-core')
}

/** tesseract.js 的 node worker 脚本（v7 的 `workerPath`；**不能**缺省，否则库会去拿 CDN worker） */
export function defaultTesseractWorkerScript(): string {
  return (
    process.env.PROJECT_LG_OCR_WORKER_PATH ??
    join(OCR_REPO_ROOT, 'node_modules/tesseract.js/src/worker-script/node/index.js')
  )
}

/** tesseract.js 入口（子进程 require 它；绝对路径，因此不依赖子进程的 CWD） */
export function defaultTesseractEntry(): string {
  return (
    process.env.PROJECT_LG_OCR_TESSERACT_ENTRY ??
    join(OCR_REPO_ROOT, 'node_modules/tesseract.js/src/index.js')
  )
}

/** 已安装的训练数据包根（`@tesseract.js-data/<lang>/4.0.0_best_int/…`） */
export function defaultTesseractDataPackageRoot(): string {
  return (
    process.env.PROJECT_LG_OCR_DATA_PACKAGE_ROOT ?? join(OCR_REPO_ROOT, 'node_modules/@tesseract.js-data')
  )
}

// ---------------------------------------------------------------------------
// 语言资产物化（从**已安装的包**拷到一个扁平目录，逐个核对 SHA-256）
// ---------------------------------------------------------------------------

export interface MaterializedOcrLanguageAsset {
  lang: string
  /** 目标（扁平目录里的）绝对路径 */
  path: string
  /** 来源（已安装包里的）绝对路径 */
  sourcePath: string
  bytes: number
  sha256: string
  /** 这一次**真的写了**目标文件（false = 已存在且 sha256 一致，直接复用） */
  copied: boolean
}

export interface MaterializedOcrLanguageDir {
  dir: string
  assets: readonly MaterializedOcrLanguageAsset[]
  /** 这一次是否发生过写入 */
  created: boolean
  /** 非空 ⇒ 资产不可用；调用方必须**失败关闭**（不许退化成"用旧的/去下载"） */
  problems: readonly string[]
}

async function digestOfFile(absolutePath: string): Promise<string | null> {
  try {
    return sha256Hex(await readFile(absolutePath))
  } catch {
    return null
  }
}

/**
 * 把两个 `.traineddata.gz` 从已安装包拷进**一个扁平目录**。
 *
 * 为什么要扁平：tesseract.js 的 `langPath` 是**单个目录**（`src/worker-script/index.js:151`
 * 拼 `${langPath}/${lang}.traineddata${gzip ? '.gz' : ''}`），而 `@tesseract.js-data/<lang>`
 * 每个包各带自己的一层 `4.0.0_best_int/` ⇒ 必须先把它们并到同一层。
 *
 * 三条纪律：
 *   · **来源必须是已安装包**（离线磁盘读），不是网络、也不是别人留下的临时目录
 *   · 来源与目标的 sha256 都要对**内置表**核过；来源不符 ⇒ 拒绝物化（不写）
 *   · 目标已存在且哈希一致 ⇒ 直接复用（幂等；不会每次调用都写 4.7 MB）
 */
export async function materializeOcrLanguageDir(options?: {
  /** 目标目录；缺省 `defaultOcrLangDir()` */
  dir?: string
  /** 要物化的语言；缺省 = 内置哈希表的全部语言 */
  languages?: readonly string[]
  /** 已安装包根；缺省 `defaultTesseractDataPackageRoot()` */
  packageRoot?: string
}): Promise<MaterializedOcrLanguageDir> {
  const dir = options?.dir ?? defaultOcrLangDir()
  const packageRoot = options?.packageRoot ?? defaultTesseractDataPackageRoot()
  const languages = options?.languages ?? knownOcrLanguages()
  const problems: string[] = []
  const assets: MaterializedOcrLanguageAsset[] = []
  let created = false

  if (languages.length === 0) {
    problems.push('没有要求任何语言（物化不能对 0 个资产给出 PASS）')
  }

  for (const lang of languages) {
    const asset = OCR_TRAINEDDATA_ASSETS[lang]
    if (asset === undefined) {
      problems.push(`内置哈希表里没有语言：${lang}`)
      continue
    }
    const sourcePath = join(packageRoot, lang, '4.0.0_best_int', asset.fileName)
    const targetPath = join(dir, asset.fileName)

    let source: Buffer
    try {
      source = await readFile(sourcePath)
    } catch {
      // 短句 + 路径；Node 的原始消息只以 errorCode 的形式留在 problems 之外
      problems.push(`已安装包里的语言资产读不到：${sourcePath}`)
      continue
    }
    const sourceSha = sha256Hex(source)
    if (source.byteLength !== asset.bytes || sourceSha !== asset.sha256) {
      problems.push(
        `已安装包里的语言资产与内置表不一致（${sourcePath}）：字节 ${source.byteLength}/${asset.bytes}，sha256 ${sourceSha}/${asset.sha256} —— 拒绝物化`
      )
      continue
    }

    let copied = false
    const existing = await digestOfFile(targetPath)
    if (existing !== asset.sha256) {
      try {
        await mkdir(dir, { recursive: true })
        await writeFile(targetPath, source)
        copied = true
        created = true
      } catch {
        problems.push(`物化写入失败：${targetPath}`)
        continue
      }
    }
    const finalSha = await digestOfFile(targetPath)
    if (finalSha !== asset.sha256) {
      problems.push(`物化后校验失败（${targetPath}）：sha256 ${String(finalSha)}/${asset.sha256}`)
      continue
    }
    assets.push({
      lang,
      path: targetPath,
      sourcePath,
      bytes: asset.bytes,
      sha256: asset.sha256,
      copied,
    })
  }

  return { dir, assets, created, problems }
}

export interface OcrLocalAssets {
  langPath: string
  cachePath: string
  /** 这一次是否写过东西（供装配层/探针如实记录） */
  materialized: MaterializedOcrLanguageDir
  /** 非空 ⇒ 失败关闭 */
  problems: readonly string[]
}

/**
 * 装配层的**一步到位**入口：建缓存目录 + 物化语言资产 + 汇总问题。
 *
 * `scripts/utility-skills/materialize-ocr-assets.ts` 与适配器的懒加载都调它，
 * 于是"从干净检出重建资产"与"运行期第一次用"走的是同一条代码路径。
 */
export async function ensureOcrLocalAssets(options?: {
  langDir?: string
  cacheDir?: string
  languages?: readonly string[]
  packageRoot?: string
}): Promise<OcrLocalAssets> {
  const langPath = options?.langDir ?? defaultOcrLangDir()
  const cachePath = options?.cacheDir ?? defaultOcrCacheDir()
  const problems: string[] = []
  try {
    await mkdir(cachePath, { recursive: true })
  } catch {
    problems.push(`缓存目录建不出来：${cachePath}`)
  }
  const materialized = await materializeOcrLanguageDir({
    dir: langPath,
    ...(options?.languages !== undefined ? { languages: options.languages } : {}),
    ...(options?.packageRoot !== undefined ? { packageRoot: options.packageRoot } : {}),
  })
  problems.push(...materialized.problems)
  return { langPath, cachePath, materialized, problems }
}

// ---------------------------------------------------------------------------
// 资产核对
// ---------------------------------------------------------------------------

export interface OcrAssetPaths {
  /** 扁平目录：`<lang>.traineddata.gz` 直接放在这一层 */
  langPath: string
  /** 缓存目录（`cacheMethod: 'none'` ⇒ 不会被读写；显式给出以免 tesseract 落到 CWD） */
  cachePath: string
  /** tesseract.js-core 目录（v7 的 Node 路径忽略它，见 `OCR_CORE_PATH_NOTE`） */
  corePath: string
  /** tesseract.js 的 node worker 脚本（v7 的 `workerPath`） */
  tesseractWorkerScript: string
  /** tesseract.js 入口（子进程用它 require；必须是绝对路径） */
  tesseractEntry: string
}

export interface OcrAssetReading {
  languages: readonly {
    lang: string
    path: string
    bytes: number | null
    sha256: string | null
    expectedSha256: string
    expectedBytes: number
    ok: boolean
    /** 读不到时的机器可查错误码（用户可见的 `problems` 里**不含**它） */
    errorCode: string | null
  }[]
  langPath: string
  langPathExists: boolean
  cachePath: string
  cachePathExists: boolean
  corePath: string
  corePathExists: boolean
  coreFileCount: number
  tesseractWorkerScript: string
  workerScriptExists: boolean
  tesseractEntry: string
  tesseractEntryExists: boolean
  /** 任何一条不为空 ⇒ 适配器在**孵化子进程之前**失败关闭 */
  problems: readonly string[]
}

/**
 * 逐个资产核对：存在 → 是文件 → 字节数 → SHA-256（对**内置表**）。
 *
 * ⚠️ 计数型检测器必须能自证"真的量到了东西"：`languages` 为空时这里直接算问题，
 *    否则"核对了 0 个资产、发现 0 个不一致"会与"全部一致"长得一模一样。
 */
export async function verifyOcrAssets(
  paths: OcrAssetPaths,
  languages: readonly string[]
): Promise<OcrAssetReading> {
  const problems: string[] = []

  const list: {
    lang: string
    path: string
    bytes: number | null
    sha256: string | null
    expectedSha256: string
    expectedBytes: number
    ok: boolean
    errorCode: string | null
  }[] = []

  if (languages.length === 0) problems.push('没有要求任何语言（资产核对不能对 0 个资产给出 PASS）')

  for (const lang of languages) {
    const asset = OCR_TRAINEDDATA_ASSETS[lang]
    if (asset === undefined) {
      problems.push(`内置哈希表里没有语言：${lang}`)
      continue
    }
    const absolute = join(paths.langPath, asset.fileName)
    const entry = {
      lang,
      path: absolute,
      bytes: null as number | null,
      sha256: null as string | null,
      expectedSha256: asset.sha256,
      expectedBytes: asset.bytes,
      ok: false,
      /** 读不到时的机器可查错误码（**只**进这里，不进用户可见的那句话） */
      errorCode: null as string | null,
    }
    try {
      const info = await stat(absolute)
      if (!info.isFile()) {
        problems.push(`语言资产不是文件：${absolute}`)
      } else {
        const bytes = await readFile(absolute)
        entry.bytes = bytes.byteLength
        entry.sha256 = sha256Hex(bytes)
        if (entry.bytes !== asset.bytes) {
          problems.push(`${lang} 字节数不符：期望 ${asset.bytes}，实际 ${entry.bytes}`)
        }
        if (entry.sha256 !== asset.sha256) {
          problems.push(`${lang} sha256 不符：期望 ${asset.sha256}，实际 ${entry.sha256}`)
        }
        entry.ok = entry.bytes === asset.bytes && entry.sha256 === asset.sha256
      }
    } catch (error) {
      // ⚠️ 用户可见的只有"哪条路径读不到"；Node 的原始消息（ENOENT: … stat '…'）不许漏出去
      entry.errorCode = errorCodeOf(error)
      problems.push(`${lang} 读不到：${absolute}`)
    }
    list.push(entry)
  }

  // 目录/脚本存在性
  const langPathExists = existsSync(paths.langPath)
  if (!langPathExists) problems.push(`langPath 不存在：${paths.langPath}`)
  const cachePathExists = existsSync(paths.cachePath)
  if (!cachePathExists) problems.push(`cachePath 不存在：${paths.cachePath}`)
  const corePathExists = existsSync(paths.corePath)
  if (!corePathExists) problems.push(`corePath 不存在：${paths.corePath}`)
  const workerScriptExists = existsSync(paths.tesseractWorkerScript)
  if (!workerScriptExists) problems.push(`tesseract workerPath 不存在：${paths.tesseractWorkerScript}`)
  const tesseractEntryExists = existsSync(paths.tesseractEntry)
  if (!tesseractEntryExists) problems.push(`tesseract 入口不存在：${paths.tesseractEntry}`)

  let coreFileCount = 0
  if (corePathExists) {
    try {
      const entries = await readdir(paths.corePath)
      coreFileCount = entries.filter((name) => name.startsWith('tesseract-core')).length
      if (coreFileCount === 0) problems.push(`corePath 里没有任何 tesseract-core* 文件：${paths.corePath}`)
    } catch {
      problems.push(`corePath 列不出来：${paths.corePath}`)
    }
  }

  return {
    languages: list,
    langPath: paths.langPath,
    langPathExists,
    cachePath: paths.cachePath,
    cachePathExists,
    corePath: paths.corePath,
    corePathExists,
    coreFileCount,
    tesseractWorkerScript: paths.tesseractWorkerScript,
    workerScriptExists,
    tesseractEntry: paths.tesseractEntry,
    tesseractEntryExists,
    problems,
  }
}

/** 核对读数 → `facts` 用的短句（**只放程序核对过的东西**） */
export function describeAssetReading(reading: OcrAssetReading): string[] {
  const lines = reading.languages.map(
    (entry) =>
      `${entry.lang}.traineddata.gz ${entry.bytes ?? '?'} 字节 sha256=${(entry.sha256 ?? '?').slice(0, 12)}…（与内置表一致）`
  )
  lines.push(`corePath 存在（${reading.coreFileCount} 个 tesseract-core* 文件；${OCR_CORE_PATH_NOTE}）`)
  if (reading.langPathExists) lines.push('langPath 存在（缓存 cacheMethod=none，不读不写）')
  return lines
}

// ---------------------------------------------------------------------------
// 子进程协议（`<一行 JSON 头>\n<原始图片字节>` → stdout 一行 `IMAGE_OCR_RESULT=<JSON>`）
// ---------------------------------------------------------------------------

/** 结果行前缀（与 `image-ocr-worker.mjs` 的 `RESULT_MARKER` 必须逐字一致） */
export const OCR_WORKER_RESULT_MARKER = 'IMAGE_OCR_RESULT='
/** stdout / stderr 各最多留多少字符（诊断够用即可，避免一次坏事把内存吃光） */
const MAX_CAPTURED_STDIO = 16 * 1024

export interface OcrWorkerHeader {
  protocol: string
  languages: readonly string[]
  langPath: string
  cachePath: string
  corePath: string
  workerPath: string
  tesseractEntry: string
  assets: readonly { lang: string; path: string; bytes: number; sha256: string }[]
  timeoutMs: number
  imageBytes: number
}

export interface OcrWorkerResult {
  ok: boolean
  code?: string
  message?: string
  text?: string
  confidence?: number | null
  languages?: string[]
  setupMs?: number
  recognizeMs?: number
  totalMs?: number
  released?: boolean
  networkAttempts?: number
  crossThreadGuard?: boolean
  guardedEntryPoints?: string[]
  assetHashes?: { lang: string; path: string; bytes: number; sha256: string }[]
  assetProblems?: string[]
  workerErrors?: string[]
  engineVersion?: string | null
  psm?: string | null
  oem?: string | null
  loadedAnything?: boolean
  phase?: string
}

export interface OcrWorkerRun {
  exitCode: number | null
  signal: NodeJS.Signals | null
  /** 我们为什么杀它（undefined = 它自己退出的） */
  killReason?: 'timeout' | 'cancelled'
  /** 从 spawn 到 `close` 的毫秒数（**不**等于识别耗时） */
  releasedMs: number
  stdout: string
  stderr: string
  result?: OcrWorkerResult
  parseProblem?: string
}

export interface OcrWorkerRunInput {
  workerScript: string
  executable?: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  header: OcrWorkerHeader | RapidOcrWorkerHeader
  image: Uint8Array
  signal?: AbortSignal
}

/** stdout 里找**最后一行**结果（库噪声可能混进 stdout，因此用 marker 而不是"整段就是 JSON"） */
export function parseWorkerStdout(stdout: string): { result?: OcrWorkerResult; problem?: string } {
  let payload: string | undefined
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith(OCR_WORKER_RESULT_MARKER)) {
      payload = line.slice(OCR_WORKER_RESULT_MARKER.length)
    }
  }
  if (payload === undefined) return { problem: 'stdout 里没有结果行' }
  try {
    const parsed: unknown = JSON.parse(payload)
    if (parsed === null || typeof parsed !== 'object') return { problem: '结果行不是对象' }
    return { result: parsed as OcrWorkerResult }
  } catch (error) {
    return { problem: `结果行不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 调用方可以通过 `args.signal` / `args.abortSignal` 传入取消信号（形状不认识就当没给） */
export function abortSignalOf(args: Record<string, unknown>): AbortSignal | undefined {
  const candidate = args.signal ?? args.abortSignal
  if (candidate === null || typeof candidate !== 'object') return undefined
  const maybe = candidate as {
    aborted?: unknown
    addEventListener?: unknown
    removeEventListener?: unknown
  }
  if (
    typeof maybe.aborted !== 'boolean' ||
    typeof maybe.addEventListener !== 'function' ||
    typeof maybe.removeEventListener !== 'function'
  ) {
    return undefined
  }
  return candidate as AbortSignal
}

function roundMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : 0
}

/**
 * 跑一次子进程。
 *
 * 三条纪律：
 *   · **图片只走 stdin 字节**（头里没有路径/URL 之外的取图入口，图片本体也从不落到盘上）
 *   · 超时/取消 ⇒ `SIGKILL` + **等它真的 `close`**（"发了信号"不等于"释放了"）
 *   · 无论走哪条路，返回之前子进程一定已经结束
 */
export async function runOcrWorker(input: OcrWorkerRunInput): Promise<OcrWorkerRun> {
  const startedAt = performance.now()
  const child = spawn(input.executable ?? process.execPath, input.executable === undefined ? [input.workerScript] : ['-X', 'utf8', input.workerScript], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: input.env,
  })

  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    if (stdout.length < MAX_CAPTURED_STDIO) stdout += chunk
  })
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length < MAX_CAPTURED_STDIO) stderr += chunk
  })
  // 子进程被杀之后写 stdin 会异步 EPIPE —— 必须有监听者，否则父进程自己崩
  child.stdin?.on('error', () => {})

  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClosed) => {
    child.once('close', (code, signal) => {
      resolveClosed({ code, signal })
    })
  })
  child.once('error', () => {
    /* spawn 本身失败时 `close` 也会到（code=null）；这里只避免未处理事件 */
  })

  let killReason: 'timeout' | 'cancelled' | undefined
  const kill = (reason: 'timeout' | 'cancelled'): void => {
    if (killReason === undefined) killReason = reason
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    child.stdin?.destroy()
  }

  const timer = setTimeout(() => {
    kill('timeout')
  }, input.timeoutMs)
  const signal = input.signal
  const onAbort = (): void => {
    kill('cancelled')
  }
  if (signal !== undefined) {
    if (signal.aborted) kill('cancelled')
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    child.stdin?.write(`${JSON.stringify(input.header)}\n`)
    child.stdin?.write(Buffer.from(input.image))
    child.stdin?.end()
  } catch {
    /* stdin 已经不可写：由退出码/parseProblem 说明问题，不在这里抛 */
  }

  const { code, signal: exitSignal } = await closed
  clearTimeout(timer)
  if (signal !== undefined) signal.removeEventListener('abort', onAbort)

  const parsed = parseWorkerStdout(stdout)
  const releasedMs = roundMs(performance.now() - startedAt)
  return {
    exitCode: code,
    signal: exitSignal,
    ...(killReason !== undefined ? { killReason } : {}),
    releasedMs,
    stdout,
    stderr,
    ...(parsed.result !== undefined ? { result: parsed.result } : {}),
    ...(parsed.problem !== undefined ? { parseProblem: parsed.problem } : {}),
  }
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

export interface ImageOcrAdapterOptions {
  /** 内部旧调用保持 Tesseract；生产装配明确选择后端。 */
  backend?: 'rapidocr' | 'tesseract'
  pythonPath?: string
  modelDir?: string
  /** 沙箱根（装配层注入；适配器不自己推导） */
  root: string
  /**
   * 扁平语言资产目录。**缺省 = 懒物化**：第一次执行时调用 `ensureOcrLocalAssets()`
   * 把两个 `.traineddata.gz` 从已安装的 `@tesseract.js-data/*` 拷到仓库内的
   * `ocr-data/lang/` 并逐个核对 SHA-256（不写、不改内置表、零网络）。
   */
  langPath?: string
  /** 缓存目录；缺省 = 仓库内 `ocr-data/cache`（会被创建；`cacheMethod:'none'` ⇒ 只作占位） */
  cachePath?: string
  /** 缺省 = `<repo>/node_modules/tesseract.js-core` */
  corePath?: string
  /** 缺省 = `<repo>/node_modules/tesseract.js/src/worker-script/node/index.js` */
  tesseractWorkerScript?: string
  /** 缺省 = `<repo>/node_modules/tesseract.js/src/index.js` */
  tesseractEntry?: string
  /** 子进程脚本；后端决定缺省为同目录 `.py`（RapidOCR）或 `.mjs`（Tesseract）。 */
  workerScript?: string
  /** 缺省语言（调用方仍可用 `args.language(s)` 覆盖） */
  languages?: readonly string[]
  timeoutMs?: number
  maxImageBytes?: number
  maxPixels?: number
  /** 子进程环境；缺省继承 `process.env`（探针据此注入独立于本适配器的离线守卫） */
  env?: NodeJS.ProcessEnv
  /**
   * 第二批：**跨域路径解析**（缺省 = 只认沙箱，逐字段回到第一批行为）。
   *
   * 计划书 §2.1 第 3 点：「文档/OCR 从**同一授权文件读取入口**取得字节」。
   * 配了它 ⇒ 本适配器接受**本机绝对路径**；不配 ⇒ 老样子（绝对路径一律拒绝）。
   * ⚠️ 它**只**替换"路径 → 已授权绝对路径"这一步：扩展名闸、格式闸、pixel 上限、
   *    工作器/超时/语言资产全部不变。
   */
  resolveTarget?: (rawPath: string) => Promise<{
    absolutePath: string
    resourceRef: string
    sourceKind: TurnContentSourceKind
  }>
}

export function createImageOcrAdapter(options: ImageOcrAdapterOptions): CapabilityAdapter {
  const backend = options.backend ?? 'tesseract'
  const workerScript =
    options.workerScript ?? fileURLToPath(new URL(backend === 'rapidocr' ? './image-ocr-worker.py' : './image-ocr-worker.mjs', import.meta.url))
  const timeoutMs = options.timeoutMs ?? OCR_LIMITS.timeoutMs
  const maxImageBytes = options.maxImageBytes ?? OCR_LIMITS.maxImageBytes
  const maxPixels = options.maxPixels ?? OCR_LIMITS.maxPixels
  const defaultLanguages = options.languages ?? OCR_DEFAULT_LANGUAGES
  const env = options.env ?? process.env

  /**
   * 路径解析（**懒**：物化要读磁盘，不该在构造期做）。
   *
   * 成功就记住；**失败不记住** —— 下一次调用会重试（资产可能刚被物化好）。
   * 失败时返回 `problems`，调用点据此归一成 `execution_failed` 并**不孵化子进程**。
   */
  let resolvedAssets: Promise<{ paths: OcrAssetPaths; problems: string[] }> | undefined

  function resolveAssets(): Promise<{ paths: OcrAssetPaths; problems: string[] }> {
    if (resolvedAssets !== undefined) return resolvedAssets
    const pending = (async () => {
      const problems: string[] = []
      let langPath = options.langPath
      let cachePath = options.cachePath ?? defaultOcrCacheDir()
      if (options.langPath === undefined) {
        const ensured = await ensureOcrLocalAssets({
          ...(options.cachePath !== undefined ? { cacheDir: options.cachePath } : {}),
          languages: defaultLanguages,
        })
        langPath = ensured.langPath
        cachePath = ensured.cachePath
        problems.push(...ensured.problems)
      }
      const paths: OcrAssetPaths = {
        langPath: langPath ?? defaultOcrLangDir(),
        cachePath,
        corePath: options.corePath ?? defaultOcrCorePath(),
        tesseractWorkerScript: options.tesseractWorkerScript ?? defaultTesseractWorkerScript(),
        tesseractEntry: options.tesseractEntry ?? defaultTesseractEntry(),
      }
      return { paths, problems }
    })()
    const memo = pending.then(
      (value) => {
        if (value.problems.length > 0) resolvedAssets = undefined // 失败不缓存：下次重试
        return value
      },
      (error: unknown) => {
        resolvedAssets = undefined // 未预期异常也不缓存（否则一次瞬态问题会钉死整个实例）
        throw error
      }
    )
    resolvedAssets = memo
    return memo
  }

  /**
   * 首版**只有一个 worker**：同一实例的并发调用直接失败关闭。
   *
   * 刻意**不排队**：排队会让"这一轮到底算谁的"变成一个需要解释的问题，
   * 而首版只需要一条可审计的结论（并发请求者得到 `execution_failed`，如实说"这一轮没做"）。
   */
  let inFlight = false

  return {
    capabilityId: IMAGE_OCR,

    async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
      try {
        if (inFlight) {
          throw new ActionFailureError(
            actionFailure('execution_failed', '同一 OCR 适配器同一时刻只允许一个工作器（首版一个 worker）')
          )
        }
        inFlight = true
        return await executeOnce(input)
      } catch (error) {
        // 归一：账本里不允许出现原始错误字符串（errors.ts 的纪律）
        throw new ActionFailureError(normalizeAdapterError(error))
      } finally {
        inFlight = false
      }
    },
  }

  async function executeOnce(input: AdapterExecuteInput): Promise<AdapterOutcome> {
    // ① 目标：沙箱相对路径 + 扩展名（越界/歧义在任何 IO 之前就被拒）
    const relativePath = ocrRelativePathOf(input)
    if (!hasSupportedImageExtension(relativePath)) {
      throw new ActionFailureError(
        actionFailure('validation_failed', `只支持 ${OCR_IMAGE_EXTENSIONS.join(' / ')}：${relativePath}`)
      )
    }
    const resolution =
      options.resolveTarget === undefined
        ? {
            absolutePath: await resolveOcrTarget(options.root, relativePath),
            resourceRef: relativePath,
            sourceKind: 'local-file' as TurnContentSourceKind,
          }
        : await options.resolveTarget(relativePath)
    const absolute = resolution.absolutePath

    // ② 字节：存在性 → 大小 → magic bytes → 尺寸 → 像素数（全部在识别之前、也在孵化之前）
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(absolute)
    } catch (error) {
      // 显式归一：`ENOENT` → target_not_found，且**不把 Node 的原始消息**漏出去
      throw normalizeImageFileError(error, relativePath)
    }
    if (!info.isFile()) {
      throw new ActionFailureError(actionFailure('target_not_found', `目标是目录，不是文件：${relativePath}`))
    }
    if (info.size > maxImageBytes) {
      throw new ActionFailureError(
        actionFailure('validation_failed', `图片 ${info.size} 字节，超过上限 ${maxImageBytes}`, {
          bytes: info.size,
          maxImageBytes,
        })
      )
    }
    let bytes: Buffer
    try {
      bytes = await readFile(absolute)
    } catch (error) {
      throw normalizeImageFileError(error, relativePath)
    }
    const validation = validateImageBytes(bytes, { maxImageBytes, maxPixels })
    if (validation.problems.length > 0) {
      throw new ActionFailureError(
        actionFailure('validation_failed', `图片不合法：${validation.problems.join('；')}`, {
          problems: validation.problems,
          bytes: validation.bytes,
        })
      )
    }

    // ③ 语言选择 + 本地资产（**缺资产 ⇒ 在孵化子进程之前失败**，零网络）
    const { languages, problems: languageProblems } = normalizeOcrLanguages(
      input.args.languages ?? input.args.language ?? defaultLanguages
    )
    if (languageProblems.length > 0) {
      throw new ActionFailureError(
        actionFailure('validation_failed', `语言选择不合法：${languageProblems.join('；')}`, {
          problems: languageProblems,
        })
      )
    }
    let header: OcrWorkerHeader | RapidOcrWorkerHeader
    if (backend === 'rapidocr') {
      const modelDir = options.modelDir ?? defaultRapidOcrModels()
      const assets = await verifyRapidOcrAssets(options.pythonPath ?? defaultRapidOcrPython(), modelDir)
      if (assets.problems.length > 0) {
        throw new ActionFailureError(actionFailure('execution_failed', `本地 OCR 资产不可用：${assets.problems.join('；')}`, {
          reason: 'ocr_assets_missing', problems: assets.problems, modelDir, loadedAnything: false,
        }))
      }
      header = { protocol: 'image-ocr/1', imageBytes: bytes.byteLength, assets: assets.assets }
    } else {
      const resolved = await resolveAssets()
      if (resolved.problems.length > 0) {
        throw new ActionFailureError(
          actionFailure('execution_failed', `本地 OCR 资产不可用：${resolved.problems.join('；')}`, {
            problems: resolved.problems,
            reason: 'ocr_assets_missing',
            loadedAnything: false,
          })
        )
      }
      const assetPaths = resolved.paths
      const assets = await verifyOcrAssets(assetPaths, languages)
      if (assets.problems.length > 0) {
        throw new ActionFailureError(
          actionFailure('execution_failed', `本地 OCR 资产不可用：${assets.problems.join('；')}`, {
            problems: assets.problems,
            reason: 'ocr_assets_missing',
            loadedAnything: false,
            // 机器可查的那一层（含 errorCode）走 details，不进用户可见的 message
            languageAssets: assets.languages,
            langPath: assets.langPath,
            corePath: assets.corePath,
            cachePath: assets.cachePath,
          })
        )
      }

      // ④ 子进程：只给它字节 + 本地路径 + 语言清单
      header = {
        protocol: 'image-ocr/1',
        languages,
        langPath: assetPaths.langPath,
        cachePath: assetPaths.cachePath,
        corePath: assetPaths.corePath,
        workerPath: assetPaths.tesseractWorkerScript,
        tesseractEntry: assetPaths.tesseractEntry,
        assets: assets.languages.map((entry) => ({
          lang: entry.lang,
          path: entry.path,
          bytes: entry.bytes ?? -1,
          sha256: entry.sha256 ?? '',
        })),
        timeoutMs,
        imageBytes: bytes.byteLength,
      }
    }
    const run = await runOcrWorker({
      workerScript,
      ...(backend === 'rapidocr' ? { executable: options.pythonPath ?? defaultRapidOcrPython() } : {}),
      env,
      timeoutMs,
      header,
      image: bytes,
      ...(abortSignalOf(input.args) !== undefined ? { signal: abortSignalOf(input.args) } : {}),
    })

    const releaseNote = `工作器已释放（退出码 ${String(run.exitCode)}${run.signal !== null ? `，信号 ${run.signal}` : ''}，${String(run.releasedMs)} ms）`

    // ⑤ 超时 / 取消：不是成功，也不是"没发生"
    if (run.killReason === 'timeout') {
      throw new ActionFailureError(
        actionFailure('timeout', `OCR 超过 ${timeoutMs} ms，工作器已被杀掉并确认退出`, {
          exitCode: run.exitCode,
          signal: run.signal,
          released: true,
          releasedMs: run.releasedMs,
          relativePath,
        })
      )
    }
    if (run.killReason === 'cancelled') {
      throw new ActionFailureError(
        actionFailure('cancelled', 'OCR 被取消，工作器已被杀掉并确认退出', {
          exitCode: run.exitCode,
          signal: run.signal,
          released: true,
          releasedMs: run.releasedMs,
          relativePath,
        })
      )
    }

    // ⑥ 结果行
    if (run.result === undefined) {
      throw new ActionFailureError(
        actionFailure('execution_failed', `OCR 工作器没有回结果：${run.parseProblem ?? '未知'}`, {
          exitCode: run.exitCode,
          signal: run.signal,
          released: true,
          releasedMs: run.releasedMs,
          stderrTail: run.stderr.slice(-500),
          relativePath,
        })
      )
    }
    const result = run.result
    if (result.ok !== true) {
      const code = result.code === 'timeout' ? 'timeout' : 'execution_failed'
      throw new ActionFailureError(
        actionFailure(code, `OCR 工作器失败（${result.code ?? 'unknown'}）：${result.message ?? ''}`, {
          exitCode: run.exitCode,
          signal: run.signal,
          released: true,
          releasedMs: run.releasedMs,
          assetProblems: result.assetProblems,
          workerErrors: result.workerErrors,
          loadedAnything: result.loadedAnything,
          ...(result.code === 'assets_missing' ? { reason: 'ocr_assets_missing' } : {}),
          relativePath,
        })
      )
    }

    const text = typeof result.text === 'string' ? result.text : ''
    const actualLanguages =
      Array.isArray(result.languages) && result.languages.length > 0 ? result.languages : languages
    const confidence =
      typeof result.confidence === 'number' && Number.isFinite(result.confidence)
        ? Math.round(result.confidence * 10) / 10
        : undefined
    const scope = computeOcrScope(text)
    const format = (validation.format ?? 'png').toUpperCase()
    const resultFingerprint = sha256Hex(text)
    const sourceFingerprint = sha256Hex(bytes)

    /*
     * ⑦ 空识别：**不是** success-with-content。
     *
     * 返回 `partial`（completed 0 / total 1）+ `effect.kind='no_change'`，且不发 turnContent。
     * 回复层据此落到 `empty` 态（turn-content-reply.ts:  status 'partial' + injectedCount 0 ⇒ 'empty'）。
     */
    if (text.trim() === '') {
      return {
        effect: {
          kind: 'no_change',
          detail: `本地 OCR：${relativePath} 没有识别到文字（引擎已读完，confidence=${String(confidence ?? 0)}）`,
        },
        evidence: [
          {
            kind: 'adapter',
            detail: `image.ocr ${actualLanguages.join('+')} 0 chars confidence=${String(confidence ?? 0)}`,
            ref: relativePath,
          },
          { kind: 'adapter', detail: releaseNote, ref: relativePath },
        ],
        partial: {
          completed: 0,
          total: 1,
          detail: '图片里没有可识别的文字（引擎已完整读完，未产生可引用的内容）',
        },
      }
    }

    const facts: string[] = [
      `图片 ${String(validation.width)}x${String(validation.height)} 像素（${format}，${String(bytes.byteLength)} 字节，${String(validation.pixels)} 像素）`,
      `识别文字 ${String(scope.totalChars)} 字符 / ${String(Buffer.byteLength(text, 'utf8'))} UTF-8 字节${
        scope.truncated ? `（已截断到 ${String(scope.includedChars)} 字符）` : ''
      }`,
      backend === 'rapidocr'
        ? `实际加载语言 ${actualLanguages.join('+')}（固定 PP-OCRv4 mobile 检测/识别模型与 v2 分类模型，SHA-256 逐个核对）`
        : `实际加载语言 ${actualLanguages.join('+')}（langPath 内 traineddata 的 sha256 与内置表逐个一致）`,
      `引擎自报 confidence ${String(confidence ?? 'n/a')}（不等于校准准确率）`,
      ...(typeof result.engineVersion === 'string' ? [`引擎版本 ${result.engineVersion}`] : []),
      `冷启动（工作器 bootstrap）${String(roundMs(result.setupMs))} ms，本次识别 ${String(roundMs(result.recognizeMs))} ms`,
      releaseNote,
      backend === 'rapidocr'
        ? `子进程报告的网络调用次数 ${String(result.networkAttempts ?? 0)}（Python socket/HTTP 离线守卫）`
        : `子进程报告的网络调用次数 ${String(result.networkAttempts ?? 0)}（跨线程离线守卫 ${result.crossThreadGuard === true ? '已装' : '未装'}）`,
      ...(backend === 'tesseract' && actualLanguages.includes('eng') && actualLanguages.includes('chi_sim')
        ? ['配置事实：语言顺序为 eng+chi_sim（实测 chi_sim+eng 会丢第二个语言；代价是退化中文样本分数低于 chi_sim-only）']
        : []),
    ]

    const turnContent: OcrTurnContent = {
      contentId: `${String(input.actionId)}:ocr`,
      kind: 'ocr',
      capability: IMAGE_OCR,
      operation: IMAGE_OCR_OPERATION,
      /*
       * ⚠️ `sourceKind` **保持 `'image-recognition'`**：它描述的是"这份内容是
       *    **图片识别**得来的"，而不是"文件在哪"。跨域与否体现在 `resourceRef`
       *    （绝对路径）与 facts 里 —— 改这一档会让第一批的 prompt 措辞漂移。
       */
      sourceKind: 'image-recognition',
      resourceRef: resolution.resourceRef,
      sourceFingerprint,
      resultFingerprint,
      scope: {
        totalChars: scope.totalChars,
        includedChars: scope.includedChars,
        truncated: scope.truncated,
      },
      facts,
      text: scope.text,
      languages: actualLanguages,
      ...(confidence !== undefined ? { confidence } : {}),
    }

    return {
      effect: {
        kind: 'content_read',
        detail: `本地 OCR：${relativePath} 识别 ${String(scope.includedChars)} 字符（confidence=${String(confidence ?? 'n/a')}）`,
        fingerprint: resultFingerprint,
        bytes: text.length,
      },
      evidence: [
        {
          kind: 'adapter',
          detail: `image.ocr ${actualLanguages.join('+')} ${String(scope.includedChars)} chars confidence=${String(confidence ?? 'n/a')}`,
          ref: resolution.resourceRef,
        },
      ],
      turnContent: [turnContent],
    }
  }
}
