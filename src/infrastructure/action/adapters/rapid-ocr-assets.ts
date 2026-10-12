import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
export const RAPID_OCR_MODELS = [
  { component: 'Det', file: 'ch_PP-OCRv4_det_mobile.onnx', bytes: 4745517, sha256: 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9', url: 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv4/det/ch_PP-OCRv4_det_mobile.onnx' },
  { component: 'Cls', file: 'ch_ppocr_mobile_v2.0_cls_mobile.onnx', bytes: 585532, sha256: 'e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c', url: 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx' },
  { component: 'Rec', file: 'ch_PP-OCRv4_rec_mobile.onnx', bytes: 10857958, sha256: '48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b', url: 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv4/rec/ch_PP-OCRv4_rec_mobile.onnx' },
] as const

export function rapidOcrRuntimeDir(): string {
  return join(ROOT, 'artifacts/post-lv2/local/ocr-runtime')
}

export function defaultRapidOcrPython(): string {
  return process.env.PROJECT_LG_RAPIDOCR_PYTHON ?? join(rapidOcrRuntimeDir(), 'venv/Scripts/python.exe')
}

export function defaultRapidOcrModels(): string {
  return process.env.PROJECT_LG_RAPIDOCR_MODEL_DIR ?? join(rapidOcrRuntimeDir(), 'models')
}

export function configuredOcrBackend(): 'rapidocr' | 'tesseract' {
  const value = process.env.PROJECT_LG_OCR_BACKEND ?? 'rapidocr'
  if (value !== 'rapidocr' && value !== 'tesseract') throw new Error(`PROJECT_LG_OCR_BACKEND 不合法：${value}`)
  return value
}

export interface RapidOcrWorkerHeader {
  protocol: string
  imageBytes: number
  assets: { component: string; path: string; bytes: number; sha256: string }[]
}

/** 只读核对；运行时绝不补下载或修改模型。 */
export async function verifyRapidOcrAssets(
  python = defaultRapidOcrPython(), modelDir = defaultRapidOcrModels()
): Promise<{ problems: string[]; assets: RapidOcrWorkerHeader['assets'] }> {
  const problems: string[] = []
  try {
    if (!(await stat(python)).isFile()) problems.push('OCR Python 不是文件')
  } catch { problems.push('本地 OCR Python 不存在') }
  const assets: RapidOcrWorkerHeader['assets'] = []
  for (const model of RAPID_OCR_MODELS) {
    const path = join(modelDir, model.file)
    try {
      const data = await readFile(path)
      if (data.length !== model.bytes || createHash('sha256').update(data).digest('hex') !== model.sha256) {
        problems.push(`${model.file} 的字节数或 SHA-256 不符`)
      } else assets.push({ component: model.component, path, bytes: model.bytes, sha256: model.sha256 })
    } catch { problems.push(`${model.file} 不存在或不可读`) }
  }
  return { problems, assets }
}
