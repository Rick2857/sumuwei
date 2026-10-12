/** Read-only verification of the pinned shell installation and selected assets. */
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const deps = resolve(process.env.POSTLV2_DEPS_ROOT ?? join(homedir(), 'postlv2-deps'))
const vt = join(deps, 'Open-LLM-VTuber')
const modelDir = join(vt, 'live2d-models', 'lg_ulvm2_0001')
const modelPath = join(modelDir, 'ulvm2_0001.model3.json')
const receiptPath = join(vt, 'lg-avatar-receipt.json')

function readJson(path: string): any {
  if (!existsSync(path)) throw new Error(`missing ${path}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

function requireValue(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const backendCommit = execFileSync('git', ['-C', vt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const frontendCommit = execFileSync('git', ['-C', join(vt, 'frontend'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const receipt = readJson(receiptPath)
const model = readJson(modelPath)
const dictionary = readJson(join(vt, 'model_dict.json'))
const profile = dictionary.find((item: any) => item.name === 'lg_ulvm2_0001')
const configText = readFileSync(join(vt, 'conf.yaml'), 'utf8')
const expressions = model.FileReferences?.Expressions ?? []

requireValue(backendCommit === receipt.vtuber_commit, 'backend commit differs from receipt')
requireValue(frontendCommit === receipt.frontend_commit, 'frontend commit differs from receipt')
requireValue(profile?.url === '/live2d-models/lg_ulvm2_0001/ulvm2_0001.model3.json', 'avatar profile is missing')
requireValue(expressions.length === 36 && receipt.expression_count === 36, 'expression registration is incomplete')
requireValue(expressions.some((entry: any) => entry.Name === 'neutral'), 'neutral reset expression is missing')
requireValue(JSON.stringify(model.Groups) === JSON.stringify([
  { Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] },
  { Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] },
]), 'blink or lip-sync group is not bound to the selected model')
const cosyProfile = receipt.speech_profile === 'cosyvoice3'
if (cosyProfile) {
  requireValue(/tts_model:\s*lg_cosyvoice3/.test(configText), 'CosyVoice3 adapter is not selected')
  requireValue(/asr_model:\s*lg_sensevoice/.test(configText), 'SenseVoice adapter is not selected')
  requireValue(/vad_model:/.test(configText), 'backend speech detection is missing')
  requireValue(receipt.asr_model === 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17', 'SenseVoice receipt differs')
  requireValue(receipt.tts_reference_sha256 === '5d6f1575f4578b43ac1859f651d426b3a0428cb6f03d85a552c9be465d85b18e', 'voice reference differs')
} else {
  requireValue(/speaker:\s*Ono_Anna/.test(configText), 'Ono_Anna is not selected')
  requireValue(/tts_model:\s*lg_qwen_tts/.test(configText), 'LG Qwen TTS adapter is not selected')
  requireValue(/asr_model:\s*lg_online_asr/.test(configText), 'LG online ASR adapter is not selected')
  requireValue(receipt.asr_model === 'sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30', 'Zipformer receipt differs')
}
requireValue(Object.keys(receipt.source_files ?? {}).length >= 48, 'source asset receipt is incomplete')

console.log(JSON.stringify({
  backendCommit,
  frontendCommit,
  avatar: profile.name,
  expressionCount: expressions.length,
  blink: ['ParamEyeLOpen', 'ParamEyeROpen'],
  lipSync: 'ParamMouthOpenY',
  speaker: receipt.speaker,
  asr: `${cosyProfile ? 'lg_sensevoice' : 'lg_online_asr'} / ${receipt.asr_model}`,
  tts: cosyProfile ? 'lg_cosyvoice3' : 'lg_qwen_tts',
  checked: true,
}, null, 2))
