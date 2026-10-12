/**
 * 后 Lv2 · WP4 前置 —— **TTS 合成门**（`pnpm postlv2:tts:verify`）。
 *
 * ============================================================================
 *  载体：计划 §6.3 / §7 / §10.1（依赖阻塞时的替代）· 媒体交付契约 §1
 * ============================================================================
 * 它回答一个具体问题：
 * ```text
 *   **已过回复守卫**的中文文本，能不能在本机真的合成出**可播放的非静音音频**？
 * ```
 * 判据是**音频本身**（时长 / 峰值 / wav 字节数），不是"命令没报错"。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 模型选择：为什么不是 CosyVoice（以及为什么不是音质最好的那个）
 * ---------------------------------------------------------------------------
 * ```text
 * CosyVoice          : 已 clone 并锁 commit，但**权重是数 GB 量级**；计划 §10.1 允许
 *                      "依赖阻塞超过约 3 h 即走已可用且许可明确的替代" ⇒ 走替代
 * vits-icefall-zh-aishell3 : ✅ **采用**。许可链条**三段全部可核**：
 *                      k2-fsa/icefall = Apache-2.0（训练工具链）
 *                      k2-fsa/sherpa-onnx = Apache-2.0（运行时）
 *                      AISHELL-3 数据集 = **Apache-2.0**（openSLR 93 页面逐字读到）
 *                      ⚠️ 代价：**8 kHz / 174 说话人**（音质明显低于 22.05 kHz 的现代模型）
 * vits-zh-hf-fanchen-unity : ❌ **不采用**。音质更好（16 kHz），但
 *                      模型包**没有 LICENSE / MODEL_CARD**，
 *                      且 HuggingFace 上游仓库 `csukuangfj/vits-zh-hf-fanchen-*` **没有 license 标签**
 *                      ⇒ 不能把"许可不明"的东西立为默认（`L-PL2-05`）
 * vits-piper-zh_CN-xiao_ya : ❌ **不采用**。模型包 MODEL_CARD 逐字写明
 *                      训练集 `BZNSYP / Data-Baker` 是 **Non-commercial use**（`L-PL2-06`）
 * ```
 * ⚠️ **音色选择留给用户**（与 WP3 皮套同一条纪律）：本门只证明"能发声"，
 * **不**主张这个音色适合苏沐薇。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const REPO_ROOT = resolve(process.cwd())
const DEPS_ROOT = process.env.POSTLV2_DEPS_ROOT ?? 'C:\\Users\\user\\postlv2-deps'
const PYTHON = join(DEPS_ROOT, 'venv', 'Scripts', 'python.exe')
const PROBE = join(DEPS_ROOT, 'tts_probe.py')

/**
 * 采用的模型（**由用户 2026-10-03 裁定**）。
 *
 * ⚠️ 这里是**整条记录里最要紧的一行**：它记的不是"哪个模型最好"，
 * 而是"**用户在有许可风险的前提下选了哪个**"。
 */
const ADOPTED = {
  id: 'vits-zh-hf-fanchen-unity',
  dir: join(DEPS_ROOT, 'models', 'vits-zh-hf-fanchen-unity'),
  file: 'vits-zh-hf-fanchen-unity.onnx',
  archive: join(DEPS_ROOT, 'models', 'vits-zh-hf-fanchen-unity.tar.bz2'),
  /** 冻结的模型包指纹（逐字节比对；换模型必须改这里并重新出证据） */
  sha256Prefix: 'B4B3965681A215DC',
  sampleRateHz: 16000,
  numSpeakers: 1,
  /** 被否决的替代（保留在案：它是**许可上干净**的那一个） */
  licensedAlternative: 'vits-icefall-zh-aishell3（工具链/运行时/数据集三段 Apache-2.0，但只有 8 kHz）',
}

/**
 * **许可状态：如实登记，不粉饰，也不替用户否决他的决定。**
 *
 * ```text
 * 上游 csukuangfj/vits-zh-hf-fanchen-unity : tags = ['onnx','region:us']，cardData = {} ⇒ **无 license 标签**
 * 模型包内                                : **没有** LICENSE / MODEL_CARD
 * 作者仓库 Fanchen/vits-zh-fanchen-unity   : HTTP 401（不可读）
 * ```
 * ⇒ 本门的立场：**记录事实 + 记录用户的决定**，然后照用户的决定执行。
 * 门**不会**因为许可不明而红 —— 那是**用户**的判断权，不是量具的。
 * 但门**必须**让这条事实在证据里一眼可见（`tts-verify.json` 的 `licence` 字段）。
 */
const LICENCE = {
  status: 'UNKNOWN_UPSTREAM_NO_LICENSE_METADATA',
  upstreamTags: ['onnx', 'region:us'],
  packageHasLicenseFile: false,
  userDecision: '用户 2026-10-03 明确指示：改用 fanchen-unity，不用管许可',
  residual: 'L-PL2-05',
}

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

const available = existsSync(PYTHON) && existsSync(PROBE) && existsSync(ADOPTED.archive)

let reading: Record<string, unknown> | undefined
let probeError: string | undefined
if (available) {
  try {
    const stdout = execFileSync(PYTHON, [PROBE], {
      cwd: DEPS_ROOT,
      encoding: 'utf8',
      timeout: 300_000,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        /* ⚠️ 模型经**环境变量**喂给探针：换模型 = 换输入，而不是改脚本 */
        POSTLV2_TTS_MODEL_DIR: ADOPTED.dir,
        POSTLV2_TTS_MODEL_FILE: ADOPTED.file,
        POSTLV2_TTS_OUT: join(DEPS_ROOT, 'tts-probe-out.wav'),
      },
      maxBuffer: 8 * 1024 * 1024,
    })
    const start = stdout.indexOf('{')
    const end = stdout.lastIndexOf('}')
    if (start >= 0 && end > start) {
      reading = JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>
    } else {
      probeError = '探针输出里没有 JSON 段'
    }
  } catch (error) {
    probeError = error instanceof Error ? error.message.slice(0, 300) : String(error)
  }
}

record(
  'T1',
  '外部前置就位（仓库之外的 venv + TTS 探针 + 模型包）',
  available,
  available ? `deps=${DEPS_ROOT}` : '缺 venv / 探针 / 模型包 ⇒ 本门 **NOT RUN**',
  available ? 1 : 0
)

// --- T2 模型包指纹 ---------------------------------------------------------
let modelSha = 'n/a'
if (existsSync(ADOPTED.archive)) {
  modelSha = createHash('sha256').update(readFileSync(ADOPTED.archive)).digest('hex').toUpperCase()
}
record(
  'T2',
  `模型包指纹与冻结值一致（逐字节）—— 且**真的**是用户裁定的那个模型（${ADOPTED.id}）`,
  available &&
    modelSha.startsWith(ADOPTED.sha256Prefix) &&
    reading?.['modelDir'] === ADOPTED.id,
  `sha256=${modelSha.slice(0, 16)}… · 冻结=${ADOPTED.sha256Prefix} · 探针读到的模型=${String(reading?.['modelDir'])}（应 ${ADOPTED.id}）`,
  available ? 2 : 0
)

// --- T3 真的产出了结构化读数 -----------------------------------------------
record(
  'T3',
  '探针**真的**跑起来并产出结构化读数',
  reading !== undefined,
  reading !== undefined ? `字段 ${Object.keys(reading).length} 个` : `未产出：${String(probeError ?? 'unknown')}`,
  reading !== undefined ? 1 : 0
)

// --- T4 **音频本身**才是判据（时长 / 峰值 / 字节数）--------------------------
const audioSeconds = Number(reading?.['audioSeconds'] ?? 0)
const peak = Number(reading?.['peakAmplitude'] ?? 0)
const wavBytes = Number(reading?.['wavBytes'] ?? 0)
const wavPath = String(reading?.['wavPath'] ?? '')
/**
 * ⚠️ 判据必须打在**音频内容**上：`peak > 0.01` 才排除"生成了一个全静音的 wav"
 * （那是最典型的假成功：文件在、时长在、听起来什么都没有）。
 */
const audioIsReal = audioSeconds > 0.2 && peak > 0.01 && wavBytes > 10_000
record(
  'T4',
  '**音频本身**是判据：非静音（峰值 > 0.01）· 时长 > 0.2 s · wav 字节数 > 10 000 —— 排除"生成了全静音文件"这种假成功',
  reading !== undefined && audioIsReal,
  `时长=${audioSeconds} s · 峰值=${peak} · wav=${wavBytes} B · 采样率=${String(reading?.['sampleRate'])} Hz · 说话人数=${String(reading?.['numSpeakers'])}`,
  reading !== undefined ? 4 : 0
)

// --- T5 记录质量代价（**只记录**，不作判据：音色选择是用户的事）--------------
const sampleRate = Number(reading?.['sampleRate'] ?? 0)
record(
  'T5',
  '如实记录**质量代价**：采样率 / 说话人数 / 合成耗时（**只记录不设阈值** —— 音色与延迟的选择是用户的）',
  reading !== undefined && sampleRate > 0,
  `采样率=${sampleRate} Hz（现代模型多为 22050）· 说话人=${String(reading?.['numSpeakers'])} · 合成=${String(reading?.['synthMs'])} ms · RTF=${String(reading?.['realtimeFactor'])} · 构造=${String(reading?.['constructMs'])} ms`,
  reading !== undefined ? 2 : 0
)

// --- T6 wav 真的落盘且字节数对得上 ------------------------------------------
let wavOnDisk = 0
if (wavPath !== '' && existsSync(wavPath)) wavOnDisk = statSync(wavPath).size
record(
  'T6',
  'wav **真的落盘**（不是只在内存里）且磁盘字节数与探测值一致',
  reading !== undefined && wavOnDisk > 0 && wavOnDisk === wavBytes,
  `磁盘=${wavOnDisk} B · 探测=${wavBytes} B · 路径=${wavPath}`,
  reading !== undefined ? 2 : 0
)

// --- T7 **许可状态如实登记**（本门不因它变红；但必须一眼可见）----------------
/*
 * ⚠️ 这条判据的**方向**是刻意的：
 * 它断言的是"**我们如实记下了许可不明这件事，以及用户的决定**"，
 * **不是**"许可没问题"。量具不该替用户否决他的决定，但也**不许**把许可不明写成干净。
 */
record(
  'T7',
  '**许可状态如实登记**：上游无 license 标签 · 包内无 LICENSE · **用户决定已记录**（门不因许可不明变红，但事实必须在证据里一眼可见）',
  reading !== undefined &&
    LICENCE.status === 'UNKNOWN_UPSTREAM_NO_LICENSE_METADATA' &&
    LICENCE.packageHasLicenseFile === false &&
    LICENCE.userDecision.includes('不用管许可') &&
    LICENCE.residual === 'L-PL2-05',
  `状态=${LICENCE.status} · 上游标签=${JSON.stringify(LICENCE.upstreamTags)} · 包内许可文件=${String(LICENCE.packageHasLicenseFile)} · 用户决定="${LICENCE.userDecision}" · 残余=${LICENCE.residual}`,
  reading !== undefined ? 4 : 0
)

// --- T8 许可上干净的**替代**仍在案（降级路径不能丢）--------------------------
record(
  'T8',
  '**许可上干净的替代仍登记在案**（万一要回退，不必重新选型）',
  ADOPTED.licensedAlternative.includes('vits-icefall-zh-aishell3'),
  `替代=${ADOPTED.licensedAlternative}`,
  reading !== undefined ? 1 : 0
)

// ===========================================================================
// V1 量具自证三段式
// ===========================================================================
/**
 * 被检验的判据本体：**"这段音频是静音"**。
 * 负控要喂**真的静音**（全 0 样本），而不是编一个对象。
 */
const detectSilent = (samples: readonly number[]): boolean =>
  samples.length === 0 || Math.max(...samples.map((value) => Math.abs(value))) <= 0.01
const selfCheck = (() => {
  const realSamples = reading !== undefined && existsSync(wavPath)
    ? (() => {
        // 只读 wav 的 data 段前 2000 个样本（16-bit 小端）即可判定
        const buffer = readFileSync(wavPath)
        const dataOffset = buffer.indexOf(Buffer.from('data'))
        const samples: number[] = []
        for (let i = dataOffset + 8; i < Math.min(buffer.length - 1, dataOffset + 4008); i += 2) {
          samples.push(buffer.readInt16LE(i) / 32768)
        }
        return samples
      })()
    : []
  const positive = detectSilent(realSamples) // 正控 ⇒ false（真音频不静音）
  const negative = detectSilent([0, 0, 0, 0, 0]) // 负控 ⇒ true（真静音必须响）
  const restored = detectSilent(realSamples) // 恢复 ⇒ false
  return {
    ok: positive === false && negative === true && restored === false,
    detail: `正控（真实合成音频）=${String(positive)}（应 false）· 负控（全 0 样本）=${String(negative)}（应 true）· 恢复=${String(restored)}（应 false）· 样本数=${realSamples.length}`,
  }
})()
record('V1', '量具自证三段式：真实合成音频不静 → 喂全 0 样本必响 → 恢复后重新安静', selfCheck.ok, selfCheck.detail, 3)

// ===========================================================================
// 汇总与证据
// ===========================================================================
const measuredCount = checks.reduce((sum, check) => sum + check.measured, 0)
const failedChecks = checks.filter((check) => !check.pass)
const gateValid = measuredCount > 0
const verdict = !available ? 'NOT RUN' : !gateValid ? 'MEASUREMENT INVALID' : failedChecks.length === 0 ? 'PASS' : 'FAIL'

let head = 'unknown'
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
} catch {
  /* 只读盘点失败不改变判定 */
}
const runId = `postlv2-tts-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })
const artifact = {
  runId,
  gate: 'postlv2:tts:verify',
  milestone: 'post-lv2 / WP4 prerequisite (text-to-speech synthesis)',
  generatedAt: new Date().toISOString(),
  source: { head },
  externalPrerequisites: {
    depsRoot: DEPS_ROOT,
    python: existsSync(PYTHON),
    probe: existsSync(PROBE),
    modelArchive: existsSync(ADOPTED.archive),
    modelSha256: modelSha,
    modelSha256Frozen: ADOPTED.sha256Prefix,
  },
  adoptedModel: {
    name: ADOPTED.id,
    decidedBy: '用户 2026-10-03（原话："改用 fanchen-unity，不用管许可"）',
    measured: {
      sampleRateHz: Number(reading?.['sampleRate'] ?? 0),
      numSpeakers: Number(reading?.['numSpeakers'] ?? 0),
      synthMs: Number(reading?.['synthMs'] ?? 0),
      audioSeconds: audioSeconds,
      peak: peak,
    },
    /** ⚠️ 这一条不粉饰：它是**已知**的、**未解决**的许可风险 */
    licenceRisk: LICENCE,
    upgradeAndFallbackPath: ADOPTED.licensedAlternative,
  },
  rejectedModels: [
    {
      name: 'vits-piper-zh_CN-xiao_ya-medium-int8',
      reason: 'MODEL_CARD 逐字写明训练集 BZNSYP/Data-Baker 为 **Non-commercial use**',
      residual: 'L-PL2-06',
    },
  ],
  probeReading: reading ?? null,
  probeError: probeError ?? null,
  checks,
  measuredCount,
  verdict,
  notClaimed: [
    '**不主张许可没问题**：上游无 license 标签、包内无 LICENSE 文件 —— 这是已知风险（L-PL2-05），用户已知情并决定采用',
    '不主张这个音色适合苏沐薇：音色选择是**用户**的事（与 WP3 皮套同一条纪律）',
    '不主张延迟达标：本机一次读数不是 SLA（媒体契约 §3 的阈值需要真人同钟测量）',
    '不主张已接进轮次链：那是 WP4 本体（检查后分句 → 合成 → 交付账），尚未做',
  ],
}
writeFileSync(join(outDir, 'tts-verify.json'), JSON.stringify(artifact, null, 2), 'utf8')

console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${verdict === 'PASS' ? '✅' : verdict === 'NOT RUN' ? '⏭️' : '❌'} postlv2:tts:verify = ${verdict}`)
console.log(`  音频：${wavPath}（${audioSeconds} s · ${sampleRate} Hz · 峰值 ${peak}）`)
console.log(`  证据：artifacts/post-lv2/${runId}/tts-verify.json`)

process.exit(verdict === 'PASS' || verdict === 'NOT RUN' ? 0 : 1)
