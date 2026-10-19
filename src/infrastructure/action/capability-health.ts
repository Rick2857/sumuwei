import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { DEFAULT_DOC_PYTHON, DEFAULT_DOC_RUNNER } from './adapters/document-read.ts'
import { OFFICE_PYTHON, OFFICE_GENERATOR_SCRIPT } from './adapters/office-generate.ts'
import { PERSONAL_LIBRARY_ROOT } from './adapters/personal-library.ts'
import { loadWorkflowSkills } from './adapters/workflow-skill.ts'
import { verifyArxivRuntimeSync } from './adapters/arxiv.ts'
import { RAPID_OCR_MODELS, defaultRapidOcrModels, defaultRapidOcrPython } from './adapters/rapid-ocr-assets.ts'
import { dirname, join, resolve } from 'node:path'

export interface CapabilityHealth {
  ready: boolean; reason: string; checkedAt: number
  runtime?: { python: string; packages: Record<string, string> }
}
const cache = new Map<string, CapabilityHealth>()
const require = createRequire(import.meta.url)
function file(path: string): void { if (!statSync(path).isFile()) throw new Error('runtime_file_missing') }
function python(path: string, packages: readonly string[]): CapabilityHealth['runtime'] {
  file(path)
  // Metadata only: no model load, network, tool invocation or user content.
  const reading = spawnSync(path, ['-I', '-c',
    'import importlib.metadata as m,sys,json; print(json.dumps({"python":sys.version.split()[0],"packages":{p:m.version(p) for p in sys.argv[1:]}}))', ...packages],
  { windowsHide: true, timeout: 3000, encoding: 'utf8', maxBuffer: 16 * 1024 })
  return reading.status === 0 && !reading.error ? JSON.parse(reading.stdout) : undefined
}
export function capabilityHealth(capability: string, options: {
  sandboxRoot?: string; libraryRoot?: string; pythonPath?: string; fresh?: boolean
} = {}): CapabilityHealth {
  const key = JSON.stringify([capability, options.sandboxRoot, options.libraryRoot, options.pythonPath])
  const previous = cache.get(key)
  if (!options.fresh && previous && Date.now() - previous.checkedAt < 30_000) return previous
  let ready = true
  let reason = 'local_dependencies_ready'
  let runtime: CapabilityHealth['runtime']
  try {
    switch (capability) {
      case 'workflow.skill': loadWorkflowSkills(); break
      case 'library.search':
      case 'sandbox.file.read':
      case 'sandbox.file.write': {
        const root = capability === 'library.search' ? options.libraryRoot ?? PERSONAL_LIBRARY_ROOT : options.sandboxRoot
        if (!root) throw new Error('runtime_root_missing')
        let checkedRoot = resolve(root)
        // The existing write adapter creates missing directories after authorization.
        // Probe the parent without creating anything or blocking a legitimate first write.
        if (capability === 'sandbox.file.write') {
          while (!existsSync(checkedRoot)) {
            const parent = dirname(checkedRoot)
            if (parent === checkedRoot) throw new Error('runtime_root_missing')
            checkedRoot = parent
          }
          if (checkedRoot !== resolve(root)) reason = 'runtime_root_creatable'
        }
        if (!statSync(checkedRoot).isDirectory()) throw new Error('runtime_root_missing')
        accessSync(checkedRoot, constants.R_OK | (capability === 'sandbox.file.write' ? constants.W_OK : 0))
        break
      }
      case 'document.read':
        file(DEFAULT_DOC_RUNNER)
        runtime = python(options.pythonPath ?? DEFAULT_DOC_PYTHON,
          ['markitdown', 'pdfminer-six', 'python-docx', 'python-pptx', 'openpyxl'])
        ready = runtime !== undefined
        break
      case 'office.generate':
        file(OFFICE_GENERATOR_SCRIPT)
        runtime = python(options.pythonPath ?? OFFICE_PYTHON, ['python-docx', 'python-pptx', 'openpyxl'])
        ready = runtime !== undefined
        break
      case 'math.calculate':
        file(fileURLToPath(new URL('./adapters/math-calculate-worker.ts', import.meta.url)))
        require.resolve('mathjs'); require.resolve('tsx/esm'); break
      case 'research.arxiv': ready = verifyArxivRuntimeSync(); break
      case 'image.ocr':
        runtime = python(options.pythonPath ?? defaultRapidOcrPython(), ['rapidocr', 'onnxruntime', 'Pillow'])
        ready = runtime !== undefined
        for (const model of RAPID_OCR_MODELS) {
          const bytes = readFileSync(join(defaultRapidOcrModels(), model.file))
          if (bytes.length !== model.bytes || createHash('sha256').update(bytes).digest('hex') !== model.sha256) ready = false
        }
        break
      default: reason = 'no_local_dependency_probe'; break
    }
    if (!ready) reason = 'runtime_dependencies_missing'
  } catch { ready = false; reason = capability === 'library.search' || capability.startsWith('sandbox.file.')
    ? 'runtime_root_unavailable' : 'runtime_dependencies_missing' }
  const result = { ready, reason, checkedAt: Date.now(), ...(runtime ? { runtime } : {}) }
  // Only fixed capability/path combinations are admitted by the assembly root.
  if (cache.size >= 64) cache.clear()
  cache.set(key, result)
  return result
}
