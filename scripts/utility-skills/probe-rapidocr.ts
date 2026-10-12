/** New backend evidence: independent network/spawn observations, assets and real process recovery. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createImageOcrAdapter, type ImageOcrAdapterOptions } from '../../src/infrastructure/action/adapters/image-ocr.ts'
import { defaultRapidOcrModels, defaultRapidOcrPython, verifyRapidOcrAssets } from '../../src/infrastructure/action/adapters/rapid-ocr-assets.ts'
import { ActionFailureError } from '../../src/kernel/action/errors.ts'
import { assertTurnContent } from '../../src/kernel/contracts/turn-content.ts'
import { applyTurnContentReplyPolicy, turnContentFactsOf } from '../../src/kernel/action/turn-content-reply.ts'

const parent = resolve('artifacts/post-lv2/local/ocr-diagnosis-20261004')
mkdirSync(parent, { recursive: true })
const scratch = mkdtempSync(join(parent, 'component-'))
const root = resolve('artifacts/post-lv2/local/utility-skills-preparation/fixtures')
const worker = resolve('src/infrastructure/action/adapters/image-ocr-worker.py')
const wrapper = join(scratch, 'audited-worker.py')
const spawnLog = join(scratch, 'spawn.log')
const netLog = join(scratch, 'network.log')
const calibration = join(scratch, 'calibration.log')
writeFileSync(spawnLog, '')
writeFileSync(netLog, '')
writeFileSync(wrapper, [
  'import os, sys, socket, runpy',
  `with open(${JSON.stringify(spawnLog)}, 'a') as f: f.write(str(os.getpid()) + '\\n')`,
  'def audit(event, args):',
  "    if event in ('socket.connect', 'socket.getaddrinfo', 'socket.sendto'):",
  `        with open(${JSON.stringify(netLog)}, 'a') as f: f.write(event + '\\n')`,
  "        raise RuntimeError('INDEPENDENT_OCR_NETWORK_AUDIT')",
  'sys.addaudithook(audit)',
  "if '--calibrate' in sys.argv:",
  '    try: socket.socket().connect(("127.0.0.1", 9))',
  '    except RuntimeError: sys.exit(0)',
  '    sys.exit(1)',
  `runpy.run_path(${JSON.stringify(worker)}, run_name='__main__')`,
  '',
].join('\n'))
const rows: { name: string; ok: boolean; observed?: unknown }[] = []
function check(name: string, ok: boolean, observed?: unknown): void {
  rows.push({ name, ok, observed })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
}
const lines = (file: string): string[] => readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean)
const calibrated = spawnSync(defaultRapidOcrPython(), ['-X', 'utf8', wrapper, '--calibrate'], { windowsHide: true })
check('独立网络探针正控：在实际连接前拦下 connect', calibrated.status === 0 && lines(netLog).length === 1)
writeFileSync(calibration, readFileSync(netLog))
writeFileSync(spawnLog, '')
writeFileSync(netLog, '')
const before = await verifyRapidOcrAssets()
check('固定模型指纹与 Python 存在', before.problems.length === 0, before)
const options: ImageOcrAdapterOptions = { root, backend: 'rapidocr', workerScript: wrapper }
const call = (adapter: ReturnType<typeof createImageOcrAdapter>, path = 'img-en.png', signal?: AbortSignal) => adapter.execute({
  actionId: 'rapidocr-probe' as never, operation: 'recognize',
  target: { type: 'sandbox_file', canonicalId: path, confidence: 'exact' },
  args: { path, ...(signal !== undefined ? { signal } : {}) }, now: () => Date.now(),
} as never)
async function failure(work: Promise<unknown>) {
  try { await work; return undefined } catch (error) {
    if (!(error instanceof ActionFailureError)) throw error
    return error.failure
  }
}
const missingDir = join(scratch, 'missing-models')
mkdirSync(missingDir)
const count = lines(spawnLog).length
const missing = await failure(call(createImageOcrAdapter({ ...options, modelDir: missingDir })))
check('缺模型失败关闭且没有孵化进程', missing?.details?.reason === 'ocr_assets_missing' && lines(spawnLog).length === count, missing)
const brokenDir = join(scratch, 'broken-models')
mkdirSync(brokenDir)
for (const asset of before.assets) writeFileSync(join(brokenDir, asset.path.split(/[\\/]/).at(-1)!), 'corrupt')
const broken = await failure(call(createImageOcrAdapter({ ...options, modelDir: brokenDir })))
check('损坏模型失败关闭且没有孵化进程', broken?.details?.reason === 'ocr_assets_missing' && lines(spawnLog).length === count)
const pidBefore = lines(spawnLog).length
const controller = new AbortController()
const reusable = createImageOcrAdapter(options)
const cancelling = failure(call(reusable, 'img-en.png', controller.signal))
const deadline = Date.now() + 5000
while (lines(spawnLog).length === pidBefore && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20))
check('取消前真实 Python 子进程已启动', lines(spawnLog).length > pidBefore)
const competing = await failure(call(reusable))
check('同一实例并发第二次调用被拒绝', competing?.code === 'execution_failed', competing)
controller.abort()
const cancelled = await cancelling
check('在运行中的进程取消后确认退出', cancelled?.code === 'cancelled' && cancelled.details?.released === true, cancelled)
const recovered = await call(reusable)
const content = recovered.turnContent?.[0]
if (content !== undefined) assertTurnContent(content)
check('同一实例取消后可恢复且实际释放', content?.kind === 'ocr' && content.text.includes('4711') && content.facts.some((f) => f.includes('工作器已释放')))
const timeout = await failure(call(createImageOcrAdapter({ ...options, timeoutMs: 1 })))
check('超时后确认退出', timeout?.code === 'timeout' && timeout.details?.released === true, timeout)
const afterTimeout = await call(reusable)
check('超时后正常识别可用', afterTimeout.turnContent?.[0]?.kind === 'ocr')
check('实际识别期间独立网络探针未发现出站', lines(netLog).length === 0, lines(netLog))
const after = await verifyRapidOcrAssets()
check('运行前后模型逐字相同', after.problems.length === 0 && JSON.stringify(before.assets) === JSON.stringify(after.assets))

// 模型可能在失败时猜图片格式；reason 只从白名单程序事实进入回复层。
const facts = turnContentFactsOf([{ result: { capability: 'image.ocr', status: 'failed', error: missing } }] as never)
const guarded = applyTurnContentReplyPolicy({ facts, replyText: '也许图片格式不兼容，可以换张图。' })
check('原因透传后确定性去掉猜测且不泄露路径', guarded.replyText.includes('本地 OCR 资产不可用') && !guarded.replyText.includes('格式') && !guarded.replyText.includes(defaultRapidOcrModels()), guarded)
const unrelated = applyTurnContentReplyPolicy({ facts: [{ capability: 'image.ocr', kind: 'ocr', status: 'failed', failureCode: 'execution_failed' }], replyText: '这次处理失败了。' })
check('没有该原因的普通失败不被错判为资产故障', unrelated.replyText === '这次处理失败了。')
const legacy = await call(createImageOcrAdapter({ root, backend: 'tesseract' }))
check('Tesseract 回滚后仍可执行', legacy.turnContent?.[0]?.kind === 'ocr' && legacy.turnContent[0].text.includes('4711'))
writeFileSync(join(scratch, 'results.json'), JSON.stringify({ rows, counts: { pass: rows.filter((r) => r.ok).length, fail: rows.filter((r) => !r.ok).length }, productionDbTouched: false }, null, 2) + '\n')
console.log(`证据：${scratch}/results.json`)
process.exitCode = rows.every((row) => row.ok) ? 0 : 1
