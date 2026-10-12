/**
 * materialize-ocr-assets.ts —— 从**已安装的包**离线物化 OCR 语言资产（WP4 的干净检出入口）。
 *
 * ============================================================================
 *  为什么需要这个入口
 * ============================================================================
 * tesseract.js 的 `langPath` 是**一个目录**（`src/worker-script/index.js:151` 拼
 * `${langPath}/${lang}.traineddata.gz`），而 `@tesseract.js-data/<lang>@1.0.0`
 * 每个包各自带一层 `4.0.0_best_int/` ⇒ 必须先把两个语言并到**同一层**。
 * 物化目录落在被 gitignore 的本地树里，因此干净检出后要能一键重建 —— 就是这个脚本。
 *
 * ```bash
 * node node_modules/tsx/dist/cli.mjs scripts/utility-skills/materialize-ocr-assets.ts
 * ```
 *
 * 三条硬性质（与适配器里 `materializeOcrLanguageDir()` 是**同一份实现**）：
 *   · 来源只能是已安装包（离线磁盘读），**不是**网络、也不是别人的临时目录
 *   · 来源与目标的 SHA-256 都逐条对**内置表**核过；来源不符 ⇒ 拒绝物化（不写、不覆盖）
 *   · 目标已存在且哈希一致 ⇒ 直接复用（幂等）
 *
 * 退出码：0 = 资产可用；1 = 有任何一条问题（调用方必须失败关闭）。
 */

import {
  OCR_REPO_ROOT,
  defaultOcrCacheDir,
  defaultOcrLangDir,
  defaultTesseractDataPackageRoot,
  ensureOcrLocalAssets,
} from '../../src/infrastructure/action/adapters/image-ocr.ts'

const result = await ensureOcrLocalAssets()
const usable = result.problems.length === 0

process.stdout.write(
  `${JSON.stringify(
    {
      status: usable ? 'OK' : 'FAILED',
      repoRoot: OCR_REPO_ROOT,
      langPath: defaultOcrLangDir(),
      cachePath: defaultOcrCacheDir(),
      packageRoot: defaultTesseractDataPackageRoot(),
      created: result.materialized.created,
      assets: result.materialized.assets.map((asset) => ({
        lang: asset.lang,
        path: asset.path,
        sourcePath: asset.sourcePath,
        bytes: asset.bytes,
        sha256: asset.sha256,
        copied: asset.copied,
      })),
      problems: result.problems,
    },
    null,
    2
  )}\n`,
  'utf8'
)

process.exitCode = usable ? 0 : 1
