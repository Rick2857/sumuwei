#!/usr/bin/env node
/**
 * ============================================================================
 *  部署资产清单（Windows 开发机 -> Linux 服务器）
 * ============================================================================
 *
 *  这个脚本回答一个很具体的问题：**"服务器上到底缺什么 / 多什么 / 坏了什么？"**
 *
 *  ---------------------------------------------------------------------------
 *  为什么要有这么一个东西（它挡住的是哪一类事故）
 *  ---------------------------------------------------------------------------
 *
 *  仓库里绝大多数"部署事故"不是代码问题，而是**搬东西搬错了**。本项目已经踩到的
 *  或者将要踩到的，按危险程度排：
 *
 *  ```text
 *  1) 把 Windows venv 整个 cp -r 到 Linux。
 *     venv 里是 `python.exe` / `Lib/site-packages/*.pyd` / `Scripts/*.exe`，
 *     Linux 上这些一个都用不了；更糟的是**它看起来是存在的**——
 *     `defaultRapidOcrPython()` 默认拼的就是 `venv/Scripts/python.exe`，
 *     只要这个路径能 stat 到，装配期就会**如实报"运行时可用"**，
 *     直到第一次真的 spawn 失败才炸。
 *     => 复制 venv 得到的是一个"会骗人"的部署，比不部署更难查。
 *
 *  2) 把 node_modules 一起搬过去。
 *     pnpm 的 node_modules 是一堆**符号链接**（指向 `.pnpm/` 里的真实目录）。
 *     `cp -r` 会复制成实体目录树，体积暴涨；`rsync -a` 保留链接但链接指向
 *     Windows 侧的绝对路径。正确做法是 Linux 上 `pnpm install --prod` 重装。
 *
 *  3) 把 data/ 一起搬过去（pglite / snapshots / qq-private）。
 *     生产库已经是 PostgreSQL 17 + pgvector 容器 `lg-postgresql-production`，
 *     本地 pglite 目录对服务器**没有任何价值**，而 qq-private 是隐私面。
 *
 *  4) 忘了 134 MiB 的 embedding 模型。
 *     它在 `artifacts/m9.5/local/` 下，而该目录被 gitignore（`.gitignore:164`）
 *     => `git clone` 到服务器上必然没有。语义召回会在**第一次真实查询**时才失败。
 *
 *  5) 忘了 `@huggingface/transformers` 不在 package.json 里。
 *     它只以"孤儿"形式存在于 `node_modules/.pnpm/`。开发机能跑是因为 pnpm 的
 *     扁平化把兄弟包暴露了；`pnpm install` 到服务器上不会有它。
 *     —— 这个脚本每次运行都会检查并**明确警告**，不猜、不修。
 *  ```
 *
 *  ---------------------------------------------------------------------------
 *  分类（这是本文件的核心数据结构）
 *  ---------------------------------------------------------------------------
 *
 *  | class      | 处置方式            | 判据                                |
 *  | ---------- | ------------------- | ----------------------------------- |
 *  | `model`    | **必须复制**        | 逐文件 sha256                       |
 *  | `resource` | **必须复制**        | 逐文件 sha256                       |
 *  | `config`   | **必须复制**        | 逐文件 sha256（非密钥，但形状要对）  |
 *  | `rebuild`  | **在服务器上重建**  | 永不哈希、永不复制；只记存在与否      |
 *  | `secret`   | **人工配置**        | 只记"存在 / 被 gitignore"，**不记值**|
 *
 *  为什么要把 `rebuild` 显式列进清单，而不是干脆不列：
 *  因为**漏掉的东西不会被发现，被错误列进来的东西才会被复制**。
 *  把"node_modules / 两个 venv / pglite"明确标成"重建"，
 *  等于在清单这一层就把"别 cp 它们"写成了机器可读的事实。
 *  本仓库 `.gitignore` 对 `local/` 目录有成熟约定（人审材料不进仓库），
 *  本脚本的输出路径沿用同一形状。
 *
 *  ---------------------------------------------------------------------------
 *  纪律（与仓库既有约定同形）
 *  ---------------------------------------------------------------------------
 *
 *  1. **永远不记录密钥的值，也不记录值的哈希。**
 *     `secret` 类只记 `{ 文件名, 是否存在, 是否被 gitignore }`。
 *     连字节数都不记 —— 长度本身也是信息。
 *  2. **缺失就如实记 `missing: true`，不失败。**
 *     开发机可能根本没下过模型（`m9.5:embedding:download` 是可选项）。
 *     一个诚实的"没有"比一个假的"失败"有用得多。
 *  3. **`--verify` 的退出码覆盖源码清单与 `model/resource/config`。**
 *     `rebuild` 类在服务器上"不存在"是**正常状态**（这正是要点），
 *     把它算作 FAIL 会让门永远红。需要严格时用 `--strict-rebuild`。
 *  4. **不碰生产数据库。** 本脚本只读文件系统 + package.json + .gitignore。
 *
 * ============================================================================
 *  用法
 * ============================================================================
 *
 *   node scripts/deploy/asset-manifest.mjs                       # 写清单
 *   node scripts/deploy/asset-manifest.mjs --verify <manifest>   # 在服务器上核对
 *   node scripts/deploy/asset-manifest.mjs --help
 *
 *  辅助开关：
 *   --root <dir>              指定仓库根（缺省 = 本脚本位置上溯两级）
 *   --out <file>              指定输出（缺省 artifacts/deploy/local/asset-manifest.json）
 *   --measure-rebuild         对 rebuild 目录也做文件计数/字节统计（默认不统计）
 *   --measure-node-modules    连 node_modules 也统计（慢；不跟随符号链接）
 *   --strict-rebuild          让 rebuild 类的"缺失"也参与退出码
 *   --quiet                   只打清单路径与最终结论
 *
 * ============================================================================
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sourceManifest, verifySourceManifest } from './source-manifest.mjs'

const SCHEMA_VERSION = 'deploy-asset-manifest@2'
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const DEFAULT_ROOT = resolve(dirname(SCRIPT_PATH), '..', '..')
const DEFAULT_OUT = 'artifacts/deploy/local/asset-manifest.json'

/* ==========================================================================
 *  资产规格表
 *  --------------------------------------------------------------------------
 *  这张表是本脚本的**唯一事实来源**。加一项部署资产 = 在这里加一行。
 *  `note` 是写给人读的，必须解释"为什么这一项在这个 class 里"。
 *  ========================================================================== */

/** 必须**逐文件复制**并校验哈希的二进制资产。 */
const MODEL_DIRS = [
  {
    path: 'artifacts/m9.5/local/embedding-lab/models',
    note:
      '语义召回的本地 ONNX 编码器（Xenova/multilingual-e5-small，q8，384 维，' +
      '约 134 MiB / 7 个文件）。`LAB_MODEL_ROOT` 是 src/main.ts:8701 的硬编码相对常量，' +
      '按 process.cwd() 解析 => 服务器上工作目录不同就找不到。' +
      '整目录被 .gitignore:164 覆盖（artifacts/m9.5/local/），git clone 必然缺。',
  },
  {
    path: 'artifacts/post-lv2/local/ocr-runtime/models',
    note:
      'RapidOCR 的 3 个 ONNX 模型（Det/Cls/Rec，约 15.4 MiB）。' +
      '字节数与 sha256 已在 src/infrastructure/action/adapters/rapid-ocr-assets.ts:7-11 ' +
      '硬编码为常量，那里的值是本清单的交叉校验源。',
  },
]

/** 必须复制的资源库。 */
const RESOURCE_ROOTS = [
  {
    path: 'resources',
    note:
      '工作流资源库（workflow-skills）。体积极小（3 文件 / 约 2.6 KiB），' +
      '但缺了它 `personal-library` 与 `writing-collaboration` 两个技能读不到。',
  },
]

/**
 * 必须存在且形状要对、但**不是二进制资产也不是密钥**的配置文件。
 * 之所以单列一类：它们不需要按目录搬运，但漏掉时报错很难懂。
 */
const CONFIG_FILES = [
  {
    path: 'evals/m9.5/embedding-manifest.json',
    note:
      'embedding 模型的权威清单（每个资产的 sha256）。' +
      '`verifyEmbeddingAssets()` 用它核对模型目录 => 模型在、清单不在 = 核不出来。',
  },
  {
    path: 'artifacts/post-lv2/local/ocr-runtime/models.json',
    note: 'OCR 模型的本机清单（与 rapid-ocr-assets.ts 的常量互为对照）。',
  },
  {
    path: 'artifacts/post-lv2/local/ocr-runtime/install-report.json',
    note:
      'OCR 环境的安装读数（Python 3.12.13 / pip 25.0.1 / 四个包的版本）。' +
      '这是**重建** OCR venv 时的版本依据来源，不是运行时依赖。',
  },
]

/**
 * 必须在服务器上**重建**、永远不要复制的东西。
 * `rebuild` 类不进哈希、不进复制清单 —— 它是一张"禁止搬运"清单。
 */
const REBUILD_DIRS = [
  {
    path: 'node_modules',
    note:
      'pnpm 符号链接 + Windows 平台二进制。Linux 上必须重跑 `pnpm install --prod`。',
    slow: true,
  },
  {
    path: 'artifacts/post-lv2/local/desktop-runtime/venv',
    note:
      'windows-mcp==0.8.7（requires-python >=3.14，本机 pyvenv.cfg 实读 = 3.14.0）。' +
      '**不要在 Linux 上重建**：上游依赖 dxcam / comtypes / pywin32，全是 Windows 专属。' +
      '=> Linux 上 `desktop.inspect` / `desktop.operate` 必须保持关闭' +
      '（.env 里不要设 CHARACTER_DESKTOP_INSPECT_ENABLED / _OPERATE_ENABLED）。',
  },
  {
    path: 'data/runtime/automatic-memory/langmem-48e3c11/.venv',
    note:
      'LangMem 虚拟环境（本机 pyvenv.cfg 实读 = CPython 3.12 系列，由 uv 0.12.4 创建）。' +
      '对应 CHARACTER_MEMORY_AUTOMATIC_PYTHON。' +
      '它的 `home` 指向 Windows 的 uv 目录 => 在 Linux 上是死路径。' +
      '用 scripts/deploy/bootstrap-linux-python.sh 重建。',
  },
  {
    path: 'artifacts/post-lv2/local/ocr-runtime/venv',
    note:
      'RapidOCR 虚拟环境（本机 pyvenv.cfg 实读 = 3.12.13）。' +
      '对应 PROJECT_LG_RAPIDOCR_PYTHON。默认路径是 `venv/Scripts/python.exe`（Windows 形）。',
  },
  {
    path: 'artifacts/post-lv2/local/utility-skills-preparation/python/venv',
    note:
      'document.read 与 office.generate 的 Python 环境（开发机 3.12.13）。' +
      '服务器需重建文档转换与 Office 依赖，并配置 PROJECT_LG_DOC_PYTHON、' +
      'PROJECT_LG_OFFICE_PYTHON；不能省略 MarkItDown 的四种文档格式 extras。',
  },
  {
    path: 'data/pglite',
    note:
      '开发期 PGlite 目录。生产库已是 PostgreSQL 17 + pgvector 容器' +
      '`lg-postgresql-production` => 这个目录在服务器上没有任何用途。',
  },
  {
    path: 'data/snapshots',
    note: '开发期快照。服务器上应由 PostgreSQL 自己的备份负责。',
  },
  {
    path: 'data/qq-private',
    note: 'QQ 私有身份面（隐私）。不迁移；服务器上由新的 NapCat 侧凭据提供。',
  },
]

/** 密钥文件：**只记名字 / 存在性 / 是否被 gitignore**。永远不读内容、不算哈希。 */
const SECRET_FILES = [
  { path: '.env', note: '主配置（含 API Key、模式开关、Python 解释器路径）。' },
  { path: '.env.qq', note: 'QQ 入口凭据。由 .gitignore:244 覆盖。' },
]

/* ==========================================================================
 *  小工具
 *  ========================================================================== */

const toPosix = (p) => p.split('\\').join('/')

/** 流式 sha256：134 MiB 的 onnx 不能整个读进内存。 */
function sha256File(abs) {
  return new Promise((ok, bad) => {
    const hash = createHash('sha256')
    const stream = createReadStream(abs)
    stream.on('error', bad)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => ok(hash.digest('hex')))
  })
}

function statOrNull(abs) {
  try {
    return statSync(abs)
  } catch {
    return null
  }
}

function humanBytes(n) {
  if (n === null || n === undefined) return 'n/a'
  if (n < 1024) return `${n} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(1)} ${units[i]}`
}

/**
 * 递归列文件。
 * `followSymlinks=false` 时**不进入符号链接目录** —— 这不是偷懒：
 * pnpm 的 node_modules 顶层全是链接到 `.pnpm/` 的符号链接，
 * 跟进去会数到整个 store，字节数完全失真。
 */
async function walkFiles(absDir, relDir, out, followSymlinks, budget) {
  let entries
  try {
    entries = readdirSync(absDir, { withFileTypes: true })
  } catch (err) {
    out.unreadable.push({ path: toPosix(relDir), reason: String(err.code || err.message) })
    return
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    if (budget.files >= budget.maxFiles) {
      out.truncated = true
      return
    }
    const abs = join(absDir, entry.name)
    const rel = toPosix(join(relDir, entry.name))
    let isDir = entry.isDirectory()
    let isFile = entry.isFile()
    if (entry.isSymbolicLink()) {
      if (!followSymlinks) {
        out.symlinkCount += 1
        continue
      }
      const st = statOrNull(abs)
      if (!st) continue
      isDir = st.isDirectory()
      isFile = st.isFile()
    }
    if (isDir) await walkFiles(abs, rel, out, followSymlinks, budget)
    else if (isFile) {
      out.files.push({ rel, abs, bytes: statOrNull(abs)?.size ?? 0 })
      budget.files += 1
    }
  }
}

/* ==========================================================================
 *  .gitignore 子集匹配器
 *  --------------------------------------------------------------------------
 *  为什么自己写而不用 `git check-ignore`：
 *  服务器上可能没有 git；而本脚本要回答的只是**"这个路径会不会被提交进仓库"**，
 *  一个保守的子集匹配足够，且完全确定性（无外部进程、无时序依赖）。
 *
 *  实现的子集（够用，且刻意不过度声称）：
 *    - 空行与 `#` 注释跳过
 *    - `!` 前缀 = 反选；**后出现的规则覆盖先出现的**（与 git 语义一致）
 *    - 无斜杠的模式 = 任意层级按 basename 匹配（文件或目录都算）
 *    - 结尾 `/` = 只匹配目录（及其内容）
 *    - `*` 跨不到 `/`，`**` 可以跨
 *  **不实现**：字符类 `[...]`、转义反斜杠、行尾续行。
 *    本仓库的 .gitignore 不使用它们；若将来使用了，结论可能偏保守。
 *  ========================================================================== */

/** 把一个 gitignore 模式翻译成正则源码（逐字符，避免任何哨兵字符）。 */
function globToRegexSource(pattern) {
  const SPECIAL = '.+^${}()|[]\\'
  let out = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i += 2
        while (pattern[i] === '*') i += 1
      } else {
        out += '[^/]*'
        i += 1
      }
    } else if (ch === '?') {
      out += '[^/]'
      i += 1
    } else if (SPECIAL.includes(ch)) {
      out += '\\' + ch
      i += 1
    } else {
      out += ch
      i += 1
    }
  }
  return out
}

function loadIgnoreRules(root) {
  const file = join(root, '.gitignore')
  if (!existsSync(file)) return { rules: [], present: false }
  const rules = []
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const negated = line.startsWith('!')
    const body = negated ? line.slice(1) : line
    const dirOnly = body.endsWith('/')
    const pattern = dirOnly ? body.slice(0, -1) : body
    if (pattern === '') continue
    const anchored = pattern.includes('/')
    const prefix = anchored ? '^' : '(?:^|/)'
    // 目录本身 + 其下所有内容。
    rules.push({ negated, dirOnly, re: new RegExp(prefix + globToRegexSource(pattern) + '(?:/.*)?$') })
  }
  return { rules, present: true }
}

/**
 * 判断路径是否被忽略。
 * 这里**不区分文件/目录**（除 `dirOnly` 规则外），这是有意的保守取舍：
 * 宁可多报一条"被忽略"，也不要漏报。
 */
function isIgnored(rules, repoRelPath) {
  let ignored = false
  for (const rule of rules) {
    if (rule.re.test(repoRelPath)) ignored = !rule.negated
  }
  return ignored
}

/* ==========================================================================
 *  收集
 *  ========================================================================== */

async function collectFileEntry(root, klass, relPath, note) {
  const abs = join(root, relPath)
  const st = statOrNull(abs)
  if (!st || !st.isFile()) {
    return { class: klass, path: relPath, bytes: null, sha256: null, note, missing: true }
  }
  return { class: klass, path: relPath, bytes: st.size, sha256: await sha256File(abs), note }
}

async function collectDirEntries(root, klass, relPath, note, opts) {
  const abs = join(root, relPath)
  const st = statOrNull(abs)
  if (!st || !st.isDirectory()) {
    return [
      {
        class: klass,
        path: relPath,
        bytes: null,
        sha256: null,
        note,
        missing: true,
        isDirectory: true,
        fileCount: 0,
        totalBytes: 0,
        files: [],
      },
    ]
  }
  const bucket = { files: [], symlinkCount: 0, truncated: false, unreadable: [] }
  await walkFiles(abs, relPath, bucket, false, { files: 0, maxFiles: opts.maxFilesPerDir })

  const perFile = []
  let totalBytes = 0
  for (const f of bucket.files) {
    totalBytes += f.bytes
    perFile.push({
      class: klass,
      path: f.rel,
      bytes: f.bytes,
      sha256: await sha256File(f.abs),
      note: `${relPath} 的成员文件`,
    })
  }
  const rollupNote =
    note +
    (bucket.symlinkCount ? `（另有 ${bucket.symlinkCount} 个符号链接未跟随）` : '') +
    (bucket.truncated ? `（警告：超过 ${opts.maxFilesPerDir} 文件上限，已截断）` : '')

  return [
    ...perFile,
    {
      class: klass,
      path: relPath,
      bytes: totalBytes,
      sha256: null, // 目录本身没有单一哈希；逐文件哈希在上面那些条目里
      note: rollupNote,
      isDirectory: true,
      rolledUp: true,
      fileCount: bucket.files.length,
      totalBytes,
      symlinkCount: bucket.symlinkCount,
      files: perFile.map((e) => ({ path: e.path, bytes: e.bytes, sha256: e.sha256 })),
    },
  ]
}

async function collectRebuildEntry(root, spec, opts) {
  const abs = join(root, spec.path)
  const exists = !!statOrNull(abs)
  let bytes = null
  let fileCount = null
  let symlinkCount = 0
  let truncated = false

  const wantsMeasure = opts.measureRebuild || (spec.slow && opts.measureNodeModules)
  if (exists && wantsMeasure) {
    const bucket = { files: [], symlinkCount: 0, truncated: false, unreadable: [] }
    await walkFiles(abs, spec.path, bucket, false, { files: 0, maxFiles: opts.maxFilesPerDir })
    bytes = bucket.files.reduce((sum, f) => sum + f.bytes, 0)
    fileCount = bucket.files.length
    symlinkCount = bucket.symlinkCount
    truncated = bucket.truncated
  }

  let tail
  if (!exists) tail = '（本机不存在）'
  else if (bytes === null) tail = '（本机存在；未统计体积，加 --measure-rebuild 可得）'
  else tail = `（本机存在，${humanBytes(bytes)} / ${fileCount} 文件）`
  if (truncated) tail += `（警告：已截断于 ${opts.maxFilesPerDir} 文件）`

  return {
    class: 'rebuild',
    path: spec.path,
    bytes,
    sha256: null, // 重建类**永不**哈希：它们要被替换，不是被校验
    note: spec.note + tail,
    isDirectory: true,
    exists,
    fileCount,
    symlinkCount,
  }
}

function collectSecretEntry(root, spec, rules) {
  const abs = join(root, spec.path)
  return {
    class: 'secret',
    path: spec.path,
    bytes: null, // 刻意为 null：连长度都不记
    sha256: null, // 刻意为 null：绝不记录值的哈希
    note: spec.note,
    isSecret: true,
    exists: !!statOrNull(abs),
    gitignored: isIgnored(rules, spec.path),
  }
}

/**
 * `@huggingface/transformers` 的声明情况。
 * 本函数**只读**，不改 package.json。发现缺失只报告 —— 补依赖是一次
 * 需要单独裁定的改动，不是部署脚本该顺手做的事。
 */
function inspectRuntimeDependency(root) {
  const name = '@huggingface/transformers'
  let declared = false
  let declaredVersion = null
  let readError = null
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const entry = pkg[field]?.[name]
      if (typeof entry === 'string') {
        declared = true
        declaredVersion = entry
      }
    }
  } catch (err) {
    readError = String(err.code || err.message)
  }

  // 开发机上"恰好存在"的孤儿副本（`.pnpm/<name>@<version>_<peer>`），只用来报告。
  const pnpmDir = join(root, 'node_modules', '.pnpm')
  const orphans = []
  if (existsSync(pnpmDir)) {
    try {
      for (const d of readdirSync(pnpmDir, { withFileTypes: true })) {
        if (!d.isDirectory() || !d.name.startsWith('@huggingface+transformers@')) continue
        orphans.push(d.name.slice('@huggingface+transformers@'.length).split('_')[0])
      }
    } catch {
      /* 读不到就当作没有孤儿；这不是本脚本的判定重点 */
    }
  }

  // 交叉源：evals 清单里钉的那个版本。
  let manifestVersion = null
  try {
    const m = JSON.parse(readFileSync(join(root, 'evals/m9.5/embedding-manifest.json'), 'utf8'))
    manifestVersion = m?.runtime?.version ?? null
  } catch {
    /* 读不到就为 null */
  }

  return { name, declared, declaredVersion, readError, manifestVersion, orphans, linked: existsSync(join(root, 'node_modules', name)) }
}

/* ==========================================================================
 *  生成
 *  ========================================================================== */

async function buildManifest(root, opts) {
  const { rules, present } = loadIgnoreRules(root)
  const entries = []

  for (const spec of MODEL_DIRS) entries.push(...(await collectDirEntries(root, 'model', spec.path, spec.note, opts)))
  for (const spec of RESOURCE_ROOTS) entries.push(...(await collectDirEntries(root, 'resource', spec.path, spec.note, opts)))
  for (const spec of CONFIG_FILES) entries.push(await collectFileEntry(root, 'config', spec.path, spec.note))

  const rebuild = []
  for (const spec of REBUILD_DIRS) rebuild.push(await collectRebuildEntry(root, spec, opts))
  const secrets = SECRET_FILES.map((spec) => collectSecretEntry(root, spec, rules))
  entries.push(...rebuild, ...secrets)

  /* 按 class 汇总。**不把 rolledUp 目录条目重复计入**，否则字节数会翻倍。 */
  const totals = {}
  for (const e of entries) {
    if (e.rolledUp) continue
    const t = (totals[e.class] ??= { files: 0, bytes: 0, missing: 0 })
    t.files += 1
    if (e.bytes !== null) t.bytes += e.bytes
    if (e.missing) t.missing += 1
  }

  const runtime = inspectRuntimeDependency(root)
  const warnings = []
  if (runtime.readError) {
    warnings.push(`package.json 读取失败（${runtime.readError}）：无法判定运行时依赖声明情况。`)
  } else if (!runtime.declared) {
    warnings.push(
      `@huggingface/transformers 未在 package.json 声明（evals/m9.5/embedding-manifest.json ` +
        `钉的是 ${runtime.manifestVersion ?? '未知'}）=> 服务器上 pnpm install 不会装它，` +
        `语义召回会在第一次真实查询时失败。`,
    )
  }
  if (runtime.declared && runtime.manifestVersion && runtime.declaredVersion !== runtime.manifestVersion) {
    warnings.push(
      `@huggingface/transformers：package.json 声明 ${runtime.declaredVersion}，` +
        `但 evals 清单钉的是 ${runtime.manifestVersion} => 两者不一致，需裁定。`,
    )
  }
  if (!present) warnings.push('根目录没有 .gitignore：secret 的 gitignored 字段不可信。')
  if (!isIgnored(rules, opts.outRelPath)) {
    warnings.push(
      `输出路径 ${opts.outRelPath} **不被 .gitignore 覆盖** => 生成的清单会被 git 扫进提交。` +
        '（本脚本不改 .gitignore；请人工决定是否加一条 artifacts/deploy/local/。）',
    )
  }

  const missing = entries.filter((e) => e.missing && e.class !== 'secret' && e.class !== 'rebuild')

  return {
    schemaVersion: SCHEMA_VERSION,
    source: sourceManifest(root),
    generator: 'scripts/deploy/asset-manifest.mjs',
    generatedAt: new Date().toISOString(),
    repoRoot: root,
    outputPath: opts.outRelPath,
    outputPathGitignored: isIgnored(rules, opts.outRelPath),
    gitignorePresent: present,
    producedOn: { platform: process.platform, arch: process.arch, node: process.version, cwd: process.cwd() },
    note:
      'secret 类只记录「文件存在」与「是否被 gitignore」；不记录值，也不记录值的哈希。' +
      'rebuild 类必须在目标机器上重建，不要复制。',
    runtimeDependencies: runtime,
    totals,
    missingAssets: missing.map((e) => ({ class: e.class, path: e.path, note: e.note })),
    rebuild: rebuild.map((e) => ({ path: e.path, exists: e.exists, bytes: e.bytes, fileCount: e.fileCount, note: e.note })),
    secrets: secrets.map((e) => ({ path: e.path, exists: e.exists, gitignored: e.gitignored, note: e.note })),
    warnings,
    entries,
  }
}

/* ==========================================================================
 *  校验
 *  ========================================================================== */

async function verifyManifest(root, manifestPath, opts) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    console.error(`x 读不了清单 ${manifestPath}：${err.code || err.message}`)
    return { exitCode: 1 }
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    console.error(`x 清单版本不符：${manifest.schemaVersion} != ${SCHEMA_VERSION}（请用同版本的脚本重出清单）`)
    return { exitCode: 1 }
  }

  const rows = []
  let failures = verifySourceManifest(root, manifest.source) ? 0 : 1
  console.log(failures ? 'FAIL source files changed/missing or manifest invalid' : 'PASS source tree fingerprint')
  let hashed = 0

  for (const e of manifest.entries ?? []) {
    if (e.rolledUp) continue
    const klass = e.class

    if (klass === 'secret') {
      const exists = !!statOrNull(join(root, e.path))
      rows.push({
        class: klass,
        path: e.path,
        status: 'INFO',
        detail: exists === e.exists ? `存在性一致（${exists ? '有' : '无'}）` : '存在性已变化',
      })
      if (exists !== e.exists) failures += 1
      continue
    }

    if (klass === 'rebuild') {
      const exists = !!statOrNull(join(root, e.path))
      let status
      let detail
      if (exists) {
        status = 'INFO'
        detail = '存在（重建类：存在与否不参与判定）'
      } else {
        status = opts.strictRebuild ? 'FAIL' : 'SKIP'
        detail = '不存在 —— 这是重建类的正常状态，不要复制'
        if (opts.strictRebuild) failures += 1
      }
      rows.push({ class: klass, path: e.path, status, detail })
      continue
    }

    /* model / resource / config：真正要比对的三类。 */
    hashed += 1
    const abs = join(root, e.path)
    const st = statOrNull(abs)
    if (!st || !st.isFile()) {
      rows.push({ class: klass, path: e.path, status: 'MISSING', detail: '文件不存在' })
      failures += 1
      continue
    }
    if (e.sha256 === null) {
      rows.push({ class: klass, path: e.path, status: 'SKIP', detail: '清单里没有哈希（产出时就是缺的）' })
      continue
    }
    const actual = await sha256File(abs)
    if (actual === e.sha256) {
      const sizeNote = e.bytes !== null && st.size !== e.bytes ? `字节数 ${st.size} != ${e.bytes}` : ''
      rows.push({
        class: klass,
        path: e.path,
        status: sizeNote ? 'PASS*' : 'PASS',
        detail: sizeNote ? `哈希一致，但 ${sizeNote}` : 'sha256 一致',
      })
    } else {
      rows.push({
        class: klass,
        path: e.path,
        status: 'MISMATCH',
        detail: `期望 ${e.sha256.slice(0, 16)}... 实得 ${actual.slice(0, 16)}...`,
      })
      failures += 1
    }
  }

  /* ---- 表格 ---- */
  const w = [8, 10, 62, 36]
  const head = ['CLASS', 'STATUS', 'PATH', 'DETAIL']
  console.log('  ' + head.map((c, i) => c.padEnd(w[i])).join('  '))
  console.log('  ' + '-'.repeat(w.reduce((a, b) => a + b, 0) + 6))
  for (const r of rows) {
    console.log('  ' + [r.class, r.status, r.path, r.detail].map((c, i) => String(c).padEnd(w[i]).slice(0, w[i])).join('  '))
  }

  const counts = {}
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1
  console.log('')
  console.log(`合计 ${rows.length} 项：` + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' / '))
  console.log(`真正参与哈希比对的条目：${hashed}（MISSING 与 MISMATCH 已分列，见上表）`)

  if (manifest.warnings?.length) {
    console.log('')
    console.log('清单自带的告警（产出端发现的，服务器上同样成立）：')
    for (const msg of manifest.warnings) console.log(`  ! ${msg}`)
  }

  console.log('')
  if (failures > 0) {
    console.log(`x FAIL：${failures} 项不一致。`)
    return { exitCode: 1 }
  }
  console.log('OK PASS：所有需要复制的资产逐字节一致。')
  return { exitCode: 0 }
}

/* ==========================================================================
 *  人类摘要
 *  ========================================================================== */

function printSummary(manifest, outAbs) {
  console.log('')
  console.log('=== 部署资产清单 ===')
  console.log(`写入：${outAbs}`)

  console.log('')
  console.log('--- 按类汇总（不重复计入目录汇总条目）---')
  for (const klass of ['model', 'resource', 'config', 'rebuild', 'secret']) {
    const t = manifest.totals[klass]
    if (!t) continue
    const bytes = klass === 'secret' ? 'n/a (刻意不记)' : humanBytes(t.bytes)
    const miss = t.missing ? `，缺失 ${t.missing}` : ''
    console.log(`  ${klass.padEnd(9)} ${String(t.files).padStart(4)} 项  ${bytes.padStart(16)}${miss}`)
  }

  console.log('')
  console.log('--- rebuild：这些必须在服务器上重建，永远不要复制 ---')
  for (const r of manifest.rebuild) {
    const size = r.bytes === null ? '(未统计)' : humanBytes(r.bytes)
    console.log(`  ${r.exists ? '存在' : '缺失'}  ${r.path.padEnd(58)} ${size}`)
  }

  console.log('')
  console.log('--- secret：只记存在性，不记值 ---')
  for (const s of manifest.secrets) {
    console.log(`  ${s.exists ? '存在' : '缺失'}  ${s.path.padEnd(58)} gitignored=${s.gitignored}`)
  }

  if (manifest.missingAssets.length) {
    console.log('')
    console.log('--- 如实记为 missing 的资产（不是失败）---')
    for (const m of manifest.missingAssets) console.log(`  - ${m.class}: ${m.path}`)
  }

  const rt = manifest.runtimeDependencies
  console.log('')
  console.log('--- 运行时包 ---')
  console.log(`  ${rt.name}`)
  console.log(`    package.json 声明   : ${rt.declared ? rt.declaredVersion : '否  <== 部署阻塞'}`)
  console.log(`    evals 清单钉的版本 : ${rt.manifestVersion ?? 'n/a'}`)
  console.log(`    node_modules 链接  : ${rt.linked ? '有' : '无'}`)
  if (rt.orphans.length) console.log(`    .pnpm 孤儿副本      : ${rt.orphans.join(', ')}`)

  if (manifest.warnings.length) {
    console.log('')
    console.log('--- 告警 ---')
    for (const msg of manifest.warnings) console.log(`  ! ${msg}`)
  }

  console.log('')
  console.log(
    '下一步：在服务器上 `node scripts/deploy/asset-manifest.mjs --verify <本文件的副本>`，' +
      '并用 scripts/deploy/bootstrap-linux-python.sh 重建 Python 运行时。',
  )
}

/* ==========================================================================
 *  CLI
 *  ========================================================================== */

const HELP = `部署资产清单（Windows -> Linux）

用法：
  node scripts/deploy/asset-manifest.mjs                       写清单到 artifacts/deploy/local/asset-manifest.json
  node scripts/deploy/asset-manifest.mjs --verify <manifest>   在服务器上逐文件核对
  node scripts/deploy/asset-manifest.mjs --help

选项：
  --root <dir>            仓库根目录（缺省 = 本脚本位置上溯两级）
  --out <file>            输出路径（相对 --root；缺省 artifacts/deploy/local/asset-manifest.json）
  --measure-rebuild       对 rebuild 目录也统计文件数与字节数（默认不统计）
  --measure-node-modules  连 node_modules 也统计（慢；不跟随符号链接）
  --strict-rebuild        让 rebuild 类的"缺失"也计入失败（默认只算 INFO/SKIP）
  --quiet                 只打输出路径
  --help                  本帮助

分类：model / resource / config = 必须复制并校验；rebuild = 必须在服务器重建；
secret = 只记存在性与 gitignore，**永不记录值或值的哈希**。
`

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP)
    return 0
  }

  const opts = {
    root: DEFAULT_ROOT,
    outRelPath: DEFAULT_OUT,
    measureRebuild: false,
    measureNodeModules: false,
    strictRebuild: false,
    quiet: false,
    verifyPath: null,
    maxFilesPerDir: 20000,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--verify') {
      if (i + 1 >= argv.length) {
        console.error('--verify 需要一个清单路径。')
        return 2
      }
      opts.verifyPath = argv[++i]
    } else if (a === '--root') opts.root = resolve(argv[++i])
    else if (a === '--out') opts.outRelPath = argv[++i]
    else if (a === '--measure-rebuild') opts.measureRebuild = true
    else if (a === '--measure-node-modules') opts.measureNodeModules = true
    else if (a === '--strict-rebuild') opts.strictRebuild = true
    else if (a === '--quiet') opts.quiet = true
    else {
      console.error(`未知参数：${a}\n\n${HELP}`)
      return 2
    }
  }

  if (!existsSync(opts.root)) {
    console.error(`仓库根不存在：${opts.root}（用 --root 指定）`)
    return 2
  }

  if (opts.verifyPath) return (await verifyManifest(opts.root, opts.verifyPath, opts)).exitCode

  const manifest = await buildManifest(opts.root, opts)
  const outAbs = join(opts.root, opts.outRelPath)
  mkdirSync(dirname(outAbs), { recursive: true })
  writeFileSync(outAbs, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  if (opts.quiet) console.log(`清单已写入：${outAbs}`)
  else printSummary(manifest, outAbs)

  if (manifest.missingAssets.length > 0) {
    console.log('')
    console.log(`! 有 ${manifest.missingAssets.length} 项资产在本机不存在，已如实记为 missing（不是失败）。`)
  }
  return 0
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('x 清单脚本异常：', err)
    process.exit(1)
  },
)
