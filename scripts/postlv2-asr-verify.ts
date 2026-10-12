/**
 * 后 Lv2 · WP5 前置 —— **流式 ASR 门**（`pnpm postlv2:asr:verify`）。
 *
 * ============================================================================
 *  载体：计划 §7 / §8.1（流式识别）· 交付契约 `M5`/`M9` · 媒体交付契约 §1
 * ============================================================================
 * 它要回答的**唯一**问题是计划 §8.1 逐字提出的那个：
 *
 * ```text
 *   同一麦克风音频流**持续**供给在线识别，输出带版本的 partial/final；
 *   **不能**把完整录音切几片事后处理后称为流式理解。
 * ```
 *
 * 因此判据是 **partial 随块变化**（≥2 次不同文本），而不是"能识别出一句话"。
 *
 * ---------------------------------------------------------------------------
 *  它跑在哪里（为什么不是 `src/` 里的测试）
 * ---------------------------------------------------------------------------
 * 它是**外部进程 + 外部模型**的读数，不是 LG 的部件。因此：
 *   · Python 侧探针脚本与模型都在**仓库之外**（`C:\Users\user\postlv2-deps`，见依赖冻结 §2）；
 *   · 本门**不改**仓库、**不**装依赖，只 spawn 那个已存在的探针并解析它的 JSON；
 *   · 模型/脚本**缺失** ⇒ 报 **NOT RUN**（而不是 PASS、也不是 FAIL）——
 *     那是"外部前置未就位"的如实表达。
 *
 * ⚠️ 与 `PL2-AI-01` 的纪律一致：本门**不碰任何数据库**（连隔离库都不开）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(process.cwd())

/** 外部依赖根（见依赖与许可冻结 §2：**刻意在仓库之外**） */
const DEPS_ROOT = process.env.POSTLV2_DEPS_ROOT ?? 'C:\\Users\\user\\postlv2-deps'
const PYTHON = join(DEPS_ROOT, 'venv', 'Scripts', 'python.exe')
const PROBE = join(DEPS_ROOT, 'streaming_asr_probe.py')
const MODEL_FILE = join(DEPS_ROOT, 'models', 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2')
const MODEL_SHA256 = '2CBD71B640D9C37D3784F29367333A4577B0398B62E9DEEED418170B081CBA8B'

interface Check {
  id: string
  label: string
  pass: boolean
  detail: string
  measured: number
}
const checks: Check[] = []
const record = (id: string, label: string, pass: boolean, detail: string, measured: number): void => {
  checks.push({ id, label, pass, detail, measured })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

const available = existsSync(PYTHON) && existsSync(PROBE) && existsSync(MODEL_FILE)

let reading: Record<string, unknown> | undefined
let probeStdout = ''
let probeError: string | undefined

if (available) {
  try {
    probeStdout = execFileSync(PYTHON, [PROBE], {
      cwd: DEPS_ROOT,
      encoding: 'utf8',
      timeout: 300_000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      maxBuffer: 8 * 1024 * 1024,
    })
    const start = probeStdout.indexOf('{')
    const end = probeStdout.lastIndexOf('}')
    if (start >= 0 && end > start) {
      reading = JSON.parse(probeStdout.slice(start, end + 1)) as Record<string, unknown>
    } else {
      probeError = '探针输出里没有 JSON 段'
    }
  } catch (error) {
    probeError = error instanceof Error ? error.message.slice(0, 300) : String(error)
  }
}

// --- A1 外部前置就位 -------------------------------------------------------
record(
  'A1',
  '外部前置就位（仓库之外的 venv + 探针 + 模型包）',
  available,
  available
    ? `deps=${DEPS_ROOT} · 模型包=${(1).toFixed(0)} 存在`
    : `缺：${[
        !existsSync(PYTHON) ? 'python' : '',
        !existsSync(PROBE) ? 'probe' : '',
        !existsSync(MODEL_FILE) ? 'model' : '',
      ]
        .filter(Boolean)
        .join(' , ')} ⇒ 本门 **NOT RUN**`,
  available ? 1 : 0
)

// --- A2 模型包指纹（内容摘要，不是"文件名对了"）-----------------------------
let modelSha = 'n/a'
let modelBytes = 0
if (existsSync(MODEL_FILE)) {
  modelBytes = readFileSync(MODEL_FILE).byteLength
  const { createHash } = await import('node:crypto')
  modelSha = createHash('sha256').update(readFileSync(MODEL_FILE)).digest('hex').toUpperCase()
}
const modelFingerprintOk = modelSha === MODEL_SHA256
record(
  'A2',
  '模型包指纹与冻结值一致（sha256 逐字节，而不是"文件名对了"）',
  available ? modelFingerprintOk : false,
  `sha256=${modelSha.slice(0, 16)}… · 冻结值=${MODEL_SHA256.slice(0, 16)}… · ${(modelBytes / 1024 / 1024).toFixed(1)} MB`,
  available ? 1 : 0
)

// --- A3 真的拿到 JSON 读数 -------------------------------------------------
record(
  'A3',
  '探针**真的**产出了结构化读数（跑得起来 + 能被解析）',
  reading !== undefined,
  reading !== undefined ? `字段 ${Object.keys(reading).length} 个` : `未产出：${String(probeError ?? 'unknown')}`,
  reading !== undefined ? 1 : 0
)

// --- A4 **流式**判据（本门存在的理由）--------------------------------------
const partialChanges = Number(reading?.['partialChanges'] ?? 0)
const chunks = Number(reading?.['chunks'] ?? 0)
const partialsNonEmpty = Number(reading?.['partialsNonEmpty'] ?? 0)
const finalText = String(reading?.['final'] ?? '')
record(
  'A4',
  '**真流式**：partial 随块变化 ≥2 次（不是"整段切几片事后处理"），且 final 非空',
  reading !== undefined && partialChanges >= 2 && finalText.trim() !== '' && chunks > 1,
  `块=${chunks} · partial 变化=${partialChanges} 次 · 非空 partial=${partialsNonEmpty} · final=${JSON.stringify(finalText.slice(0, 40))}`,
  reading !== undefined ? 3 : 0
)

// --- A5 final 与最后一条 partial 的关系（如实记录，不作判据）----------------
record(
  'A5',
  '记录 `final` 与"最后一条非空 partial"是否相同（如实记录；两种情况都不算失败）',
  reading !== undefined,
  `final == 最后一条 partial = ${String(reading?.['finalEqualsLastPartial'])}`,
  reading !== undefined ? 1 : 0
)

// --- A6 实时性读数（记录，不设阈值）----------------------------------------
const rtf = Number(reading?.['realtimeFactor'] ?? Number.NaN)
record(
  'A6',
  '记录实时性（`feedMs / 音频秒数`）—— **只记录不设阈值**：本机 CPU 读数不是延迟承诺',
  reading !== undefined && Number.isFinite(rtf),
  `RTF=${String(rtf)} · 构造=${String(reading?.['recognizerConstructMs'])} ms · 喂入=${String(reading?.['feedMs'])} ms · 音频=${String(reading?.['audioSeconds'])} s`,
  reading !== undefined ? 1 : 0
)

// ===========================================================================
// A7–A9 Lv4.5 / P2 前置：**两遍识别**（流式 partial + 正式 final）的读数
// ===========================================================================
/*
 * 载体：`docs/post-lv2/Lv4.5-Lean-Execution-Plan-2026-10-04.md` §2「两个实现选择」第 1 条。
 *
 * ⚠️ 这里量的是**两条链各自的性质**，不是"哪个模型更准"：
 *   · partial 到底早不早、变不变（否则"边听边准备"没有输入）；
 *   · 流式 final 能不能**替代**离线 final（决定两遍是不是白跑）；
 *   · 合起来一轮多花多少毫秒。
 * ⚠️ 判据刻意只打**同语料**（本项目的合成音）：真人样本在别处没有稳定参照，
 *    拿它设阈值等于拿一个我没有的"正确文本"当真值。
 */
const PARTIAL_PROBE = join(REPO_ROOT, 'scripts/postlv2-partial-probe.py')
const ZIPFORMER_TEST_DIR = join(DEPS_ROOT, 'models', 'sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30', 'test_wavs')
const SPEECH_PYTHON = join(DEPS_ROOT, 'cosyvoice3-venv', 'Scripts', 'python.exe')
/** TTS 音色样本（**同项目语音域**）：判据打在这里 */
const PROJECT_SAMPLES = ['01-greeting.wav', '04-long.wav'].map((name) => join(DEPS_ROOT, 'voice-samples', name))
/** 真人样本（厂商自带）：**只记录**，见 notClaimed */
const HUMAN_SAMPLES = ['0.wav', '1.wav'].map((name) => join(ZIPFORMER_TEST_DIR, name))

interface PartialSample {
  wav: string
  audioSeconds: number
  streaming: {
    model: string
    wallMs: number
    realtimeFactor: number
    partialChanges: number
    nonEmptyPartials: number
    firstNonEmptyMs: number | null
    stableFractionOfAudio: number | null
    final: string
    finalEqualsLastPartial: boolean
  }
  offline: { final: string; speechDetected: boolean; wallMs: number }
  agreement: { characterSimilarity: number; editDistance: number }
  cost: { extraMsIfBothRun: number }
}

const partialAvailable =
  existsSync(SPEECH_PYTHON) && existsSync(PARTIAL_PROBE) && PROJECT_SAMPLES.every((path) => existsSync(path))

const runPartialProbe = (wavs: readonly string[]): PartialSample[] => {
  if (!partialAvailable || wavs.length === 0) return []
  try {
    const stdout = execFileSync(SPEECH_PYTHON, [PARTIAL_PROBE, ...wavs, '--batch-out', join(REPO_ROOT, 'artifacts/post-lv2', 'partial-probe-last.json')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 600_000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      maxBuffer: 16 * 1024 * 1024,
    })
    const start = stdout.indexOf('{')
    const end = stdout.lastIndexOf('}')
    if (start < 0 || end <= start) return []
    const parsed = JSON.parse(stdout.slice(start, end + 1)) as { samples?: PartialSample[] }
    return parsed.samples ?? []
  } catch (error) {
    console.log(`  [probe] 两遍识别探针失败：${error instanceof Error ? error.message.slice(0, 160) : String(error)}`)
    return []
  }
}

const projectReadings = runPartialProbe(PROJECT_SAMPLES)
const humanReadings = runPartialProbe(HUMAN_SAMPLES)

record(
  'A7',
  '**流式 partial 真的产生**（Lv4.5 / P2 前置）：`sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30`（**生产在用的那一档**）按 100 ms 分块喂，每份样本都有 ≥2 次不同文本，且最早的非空 partial 明显早于音频结束',
  projectReadings.length === PROJECT_SAMPLES.length &&
    projectReadings.every(
      (sample) =>
        sample.streaming.partialChanges >= 2 &&
        (sample.streaming.firstNonEmptyMs ?? Number.POSITIVE_INFINITY) < sample.audioSeconds * 1000 * 0.5
    ),
  projectReadings.length === 0
    ? `前置缺失或缺样本 ⇒ 本组 **NOT RUN**（python=${String(existsSync(SPEECH_PYTHON))} · probe=${String(existsSync(PARTIAL_PROBE))}）`
    : projectReadings
        .map(
          (sample) =>
            `${sample.wav}: 变化=${sample.streaming.partialChanges} 次 · 首个=${String(sample.streaming.firstNonEmptyMs)}ms / 音频 ${(sample.audioSeconds * 1000).toFixed(0)}ms · RTF=${sample.streaming.realtimeFactor}`
        )
        .join(' | '),
  projectReadings.length * 3
)

record(
  'A8',
  '**两遍是不是重复劳动**（Lv4.5 / P2 前置）：流式 final 在**同一段音频**上与离线 SenseVoice final 的归一化相似度（**如实记录，含分歧**；两份都留着）',
  projectReadings.length === PROJECT_SAMPLES.length &&
    projectReadings.every((sample) => sample.streaming.final.length > 0 && sample.offline.speechDetected),
  projectReadings.length === 0
    ? 'NOT RUN（同 A7 的前置）'
    : projectReadings
        .map(
          (sample) =>
            `${sample.wav}: 相似度=${sample.agreement.characterSimilarity}（编辑距离 ${sample.agreement.editDistance}）· 流式=${JSON.stringify(sample.streaming.final.slice(0, 24))} · 离线=${JSON.stringify(sample.offline.final.slice(0, 24))}`
        )
        .join(' | '),
  projectReadings.length * 3
)

record(
  'A9',
  '**代价面**（Lv4.5 / P2 前置）：两条链合起来一轮多花多少毫秒（**只记录**：本机 CPU 读数不是延迟承诺）',
  projectReadings.length === PROJECT_SAMPLES.length,
  projectReadings.length === 0
    ? 'NOT RUN（同 A7 的前置）'
    : projectReadings
        .map((sample) => `${sample.wav}: 流式 ${sample.streaming.wallMs}ms + 离线 ${sample.offline.wallMs}ms = ${sample.cost.extraMsIfBothRun}ms`)
        .join(' | '),
  projectReadings.length
)

// ===========================================================================
// 汇总与证据
// ===========================================================================
const measuredCount = checks.reduce((sum, check) => sum + check.measured, 0)
const failedChecks = checks.filter((check) => !check.pass)
const gateValid = measuredCount > 0
/** 前置缺失 ⇒ NOT RUN（不是 PASS、也不是 FAIL） */
const verdict = !available ? 'NOT RUN' : !gateValid ? 'MEASUREMENT INVALID' : failedChecks.length === 0 ? 'PASS' : 'FAIL'

let head = 'unknown'
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
} catch {
  /* 只读盘点失败不改变判定 */
}

const runId = `postlv2-asr-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })
const artifact = {
  runId,
  gate: 'postlv2:asr:verify',
  milestone: 'post-lv2 / WP5 prerequisite (streaming ASR)',
  generatedAt: new Date().toISOString(),
  source: { head },
  externalPrerequisites: {
    depsRoot: DEPS_ROOT,
    python: existsSync(PYTHON),
    probe: existsSync(PROBE),
    modelArchive: existsSync(MODEL_FILE),
    modelSha256: modelSha,
    modelSha256Frozen: MODEL_SHA256,
    modelBytes,
    note:
      '外部依赖刻意在仓库之外（依赖冻结 §2）。模型权重与音色条款**尚未逐条读**，' +
      '因此本读数**不**主张许可已核。',
  },
  probeReading: reading ?? null,
  probeError: probeError ?? null,
  checks,
  measuredCount,
  verdict,
  /** Lv4.5 / P2 前置：**两遍识别**读数（合成音样本 —— 判据打在这里） */
  twoPassProjectSamples: projectReadings,
  /** Lv4.5 / P2 前置：真人样本（厂商自带）—— **只记录**，任何判据都不得用它设阈值 */
  twoPassHumanSamples: humanReadings,
  notClaimed: [
    '不主张延迟承诺：RTF 是本机 CPU 的一次读数，不是产品 SLA',
    '不主张"麦克风真的能用"：本门喂的是模型自带的测试 wav，不是真实麦克风',
    '不主张模型权重许可已核：模型包与仓库 LICENSE 是两份东西',
    /*
     * ⚠️ Lv4.5 / P2 前置的三条边界（2026-10-04 追加）。
     */
    '两遍识别读数**不构成准确率结论**：合成音样本上的分歧（相似度低到 0.46）反映的是"两条链在**本项目音色**上不一致"，不是"谁更准"——本门没有真值',
    'human 样本（厂商 wav）只用于记录：本门**没有**任何判据允许拿它设阈值',
    '流式 partial 的**浏览器实际形态**仍未验：本门跑的是 Python 直喂，网页真正的 partial/final 需联合测试（计划 §3 第一步的 ASR 行）',
  ],
}
writeFileSync(join(outDir, 'asr-verify.json'), JSON.stringify(artifact, null, 2), 'utf8')

console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${verdict === 'PASS' ? '✅' : verdict === 'NOT RUN' ? '⏭️' : '❌'} postlv2:asr:verify = ${verdict}`)
console.log(`  证据：artifacts/post-lv2/${runId}/asr-verify.json`)

process.exit(verdict === 'PASS' || verdict === 'NOT RUN' ? 0 : 1)
