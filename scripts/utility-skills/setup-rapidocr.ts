/** Preparation only: install pinned dependencies and verified models. Never called by recognition. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { RAPID_OCR_MODELS, rapidOcrRuntimeDir, verifyRapidOcrAssets } from '../../src/infrastructure/action/adapters/rapid-ocr-assets.ts'

const root = resolve('.')
const runtime = rapidOcrRuntimeDir()
const basePython = process.argv[2] ?? join(root, 'artifacts/post-lv2/local/utility-skills-preparation/python/venv/Scripts/python.exe')
const python = join(runtime, 'venv/Scripts/python.exe')
const modelDir = join(runtime, 'models')
mkdirSync(modelDir, { recursive: true })
function run(executable: string, args: string[]): void {
  const result = spawnSync(executable, args, { stdio: 'inherit', windowsHide: true })
  if (result.error || result.status !== 0) throw new Error(`OCR 安装失败，exit=${result.status}: ${result.error?.message ?? ''}`)
}
if (!existsSync(python)) run(basePython, ['-X', 'utf8', '-m', 'venv', join(runtime, 'venv')])
run(python, ['-X', 'utf8', '-m', 'pip', 'install', '--disable-pip-version-check', '-r', join(root, 'scripts/utility-skills/rapidocr-requirements.lock.txt'), '--report', join(runtime, 'install-report.json')])
for (const model of RAPID_OCR_MODELS) {
  const target = join(modelDir, model.file)
  if (!existsSync(target)) {
    const response = await fetch(model.url, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`下载 OCR 模型失败：${response.status}`)
    const data = Buffer.from(await response.arrayBuffer())
    if (data.length !== model.bytes || createHash('sha256').update(data).digest('hex') !== model.sha256) throw new Error(`OCR 模型指纹不符：${model.file}`)
    writeFileSync(target, data)
  }
  const data = readFileSync(target)
  if (data.length !== model.bytes || createHash('sha256').update(data).digest('hex') !== model.sha256) throw new Error(`现有 OCR 模型指纹不符，拒绝覆盖：${model.file}`)
}
const reading = await verifyRapidOcrAssets(python, modelDir)
if (reading.problems.length) throw new Error(reading.problems.join('；'))
writeFileSync(join(runtime, 'models.json'), JSON.stringify(reading, null, 2) + '\n')
console.log('RapidOCR 固定环境与 PP-OCRv4 模型准备完成')
