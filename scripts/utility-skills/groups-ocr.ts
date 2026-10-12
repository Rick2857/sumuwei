/**
 * groups-ocr —— 本地 OCR 的 6 组（计划书 §4A「OCR 6 组」）。
 *
 * ```text
 * ocr-01 清晰中文        独立参考转录 + 逐样本 CER；关键数字全部正确
 * ocr-02 清晰英文        同上
 * ocr-03 清晰混合及数字   同上
 * ocr-04 退化图          展示读数和范围，**不混入平均数掩盖问题**
 * ocr-05 缺资产 / 非法或超限图   缺资产零出站且如实失败
 * ocr-06 工作器超时 / 恢复        释放计数归零；取消后可正常再识别
 * ```
 *
 * ⚠️ **参考答案只来自 `fixtures/manifest.json`**（准备期独立写下的转录），
 *    绝不拿 OCR 输出回填参考答案 —— 那会让"准确率"变成自证。
 *
 * ⚠️ **阈值不调、样本不换、不做后处理**：清晰三样本的判据是计划书 §1/§4A 写的
 *    `CER ≤ 5% 且关键数字全部正确`。不达标就如实 `FAIL` 并给出逐样本读数
 *    （计划书 §5：「若 OCR 不达标…可交付前三项并把 OCR 明确列为未完成；
 *    不能宣布四项全部完成」）。
 */

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { IMAGE_OCR } from '../../src/kernel/action/utility-capabilities.ts'
import { createImageOcrAdapter } from '../../src/infrastructure/action/adapters/image-ocr.ts'
import type { TurnContent } from '../../src/kernel/contracts/turn-content.ts'

import { resultOf, summarizeActions } from './assembly.ts'
import type { BedEntry, GroupRunner, Suite } from './groups.ts'
import { GroupRecorder, sanitize } from './groups.ts'
import { expectOf } from './fixtures.ts'

/** 计划书写明的清晰样本阈值（**不许**按读数调它） */
const CLEAR_CER_THRESHOLD = 0.05

/** 空白无关的 Levenshtein 距离（与准备期探针同一算法：自己实现，不引新依赖） */
export function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  let previous = Array.from({ length: n + 1 }, (_, index) => index)
  for (let i = 1; i <= m; i += 1) {
    const current: number[] = [i]
    for (let j = 1; j <= n; j += 1) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
    previous = current
  }
  return previous[n] ?? 0
}

export function characterErrorRate(reference: string, hypothesis: string): number {
  const ref = reference.replace(/\s+/g, '')
  const hyp = hypothesis.replace(/\s+/g, '')
  if (ref.length === 0) return hyp.length === 0 ? 0 : Number.POSITIVE_INFINITY
  return levenshtein(ref, hyp) / ref.length
}

/** 构造一张**尺寸合法但像素超限**的 PNG（IHDR 是真头，IDAT 是空数据） */
function buildOversizedPng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolour
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', Buffer.alloc(0)), chunk('IEND', Buffer.alloc(0))])
}

async function ocrUnavailable(
  suite: Suite,
  id: string,
  title: string
): Promise<ReturnType<GroupRecorder['finish']> | undefined> {
  const rec = new GroupRecorder(id)
  if (!suite.fixturesUsable) return rec.finish(title, { notRunReason: suite.fixturesProblem })
  const assets = await suite.ocrAssets()
  if (assets.problems.length > 0) {
    return rec.finish(title, { notRunReason: `本地 OCR 资产不可用：${assets.problems.join('；')}` })
  }
  return undefined
}

interface OcrFixtureCase {
  readonly fixture: string
  readonly label: string
}

async function runClearGroup(
  suite: Suite,
  input: { id: string; title: string; bed: string; cases: readonly OcrFixtureCase[] }
): Promise<ReturnType<GroupRecorder['finish']>> {
  const rec = new GroupRecorder(input.id)
  const entry = await suite.openBed(input.bed)
  const assets = await suite.ocrAssets()
  const ocr = suite.ocrOptions(assets.langPath, assets.cachePath)

  for (const item of input.cases) {
    const expected = expectOf(suite.fixtures, item.fixture)
    const reference = expected.ocrReference ?? ''
    const keyNumbers = expected.keyNumbers ?? []
    const relativePath = suite.stageImage(entry, item.fixture)
    const got = await suite.recognize(entry, relativePath, ocr)
    rec.countInput(1)

    const content = got.content
    suite.checkTurnContent(rec, content, `${input.id} ${item.fixture} 的当轮内容`)
    const text = content?.kind === 'ocr' ? content.text : ''
    const cer = characterErrorRate(reference, text)
    const numbersFound = keyNumbers.filter((number) => text.includes(number))
    const numbersMissing = keyNumbers.filter((number) => !text.includes(number))

    rec.check(
      `${input.id} ${item.fixture}（${item.label}）：真的识别到了文字（不是空结果）`,
      text.trim() !== '' && content?.kind === 'ocr',
      `text.length=${String(text.length)} confidence=${String(content?.kind === 'ocr' ? content.confidence : undefined)}`
    )
    rec.check(
      `${input.id} ${item.fixture}：关键数字**全部正确**（${keyNumbers.join(' / ')}）`,
      numbersMissing.length === 0 && keyNumbers.length > 0,
      numbersMissing.length === 0 ? `全部命中（${numbersFound.join(' / ')}）` : `缺：${numbersMissing.join(' / ')}`
    )
    rec.check(
      `${input.id} ${item.fixture}：CER ≤ ${String(CLEAR_CER_THRESHOLD * 100)}%（计划书 §4A 的清晰样本阈值，**不调**）`,
      cer <= CLEAR_CER_THRESHOLD,
      `CER=${(cer * 100).toFixed(2)}% · reference="${sanitize(reference, 60)}" · observed="${sanitize(text, 60)}"`
    )
    rec.check(
      `${input.id} ${item.fixture}：识别文字真的入了模（section + 附录），源指纹是原图字节的 sha256`,
      got.reading.sectionIds.includes('turn-content') &&
        got.reading.guard.turnContent.states.some((state) => state.state === 'delivered') &&
        (content?.sourceFingerprint ?? '').length === 64,
      `sections=[${got.reading.sectionIds.join(',')}] appendix=${got.reading.guard.turnContent.appendix !== ''}`
    )
    rec.check(
      `${input.id} ${item.fixture}：事实里如实标注"引擎自报 confidence ≠ 校准准确率"`,
      (content?.facts ?? []).some((fact) => fact.includes('confidence')) &&
        (content?.facts ?? []).some((fact) => fact.includes('不等于校准准确率')),
      (content?.facts ?? []).find((fact) => fact.includes('confidence')) ?? '(缺)'
    )
    rec.check(
      `${input.id} ${item.fixture}：固定模型的中英文识别范围如实登记`,
      content?.kind === 'ocr' && content.languages.length > 0,
      `languages=${content?.kind === 'ocr' ? content.languages.join('+') : '(无)'}`
    )
    rec.note(item.fixture, {
      cer,
      cerPercent: Number((cer * 100).toFixed(2)),
      keyNumbersFound: numbersFound,
      confidence: content?.kind === 'ocr' ? content.confidence : null,
      languages: content?.kind === 'ocr' ? content.languages : [],
      observedText: sanitize(text, 80),
    })
  }
  /* 参考转录落到 local/（公开证据里不出现正文面） */
  suite.writeLocal(
    `${input.id}-readings.json`,
    `${JSON.stringify({ reference: input.cases.map((item) => ({ fixture: item.fixture, reference: expectOf(suite.fixtures, item.fixture).ocrReference ?? '' })) }, null, 2)}\n`
  )
  return rec.finish(input.title)
}

const ocr01: GroupRunner = {
  id: 'ocr-01',
  async run(_ctx, suite) {
    const unavailable = await ocrUnavailable(suite, 'ocr-01', '清晰中文')
    if (unavailable !== undefined) return unavailable
    return await runClearGroup(suite, {
      id: 'ocr-01',
      title: '清晰中文',
      bed: 'ocr01',
      cases: [{ fixture: 'img-zh.png', label: '清晰中文（48px 深色字）' }],
    })
  },
}

const ocr02: GroupRunner = {
  id: 'ocr-02',
  async run(_ctx, suite) {
    const unavailable = await ocrUnavailable(suite, 'ocr-02', '清晰英文')
    if (unavailable !== undefined) return unavailable
    return await runClearGroup(suite, {
      id: 'ocr-02',
      title: '清晰英文',
      bed: 'ocr02',
      cases: [{ fixture: 'img-en.png', label: '清晰英文（44px）' }],
    })
  },
}

const ocr03: GroupRunner = {
  id: 'ocr-03',
  async run(_ctx, suite) {
    const unavailable = await ocrUnavailable(suite, 'ocr-03', '清晰混合及数字')
    if (unavailable !== undefined) return unavailable
    return await runClearGroup(suite, {
      id: 'ocr-03',
      title: '清晰混合及数字',
      bed: 'ocr03',
      cases: [{ fixture: 'img-mixed.png', label: '清晰混合（CJK + latin + 数字）' }],
    })
  },
}

const ocr04: GroupRunner = {
  id: 'ocr-04',
  async run(_ctx, suite) {
    const unavailable = await ocrUnavailable(suite, 'ocr-04', '退化图')
    if (unavailable !== undefined) return unavailable
    const rec = new GroupRecorder('ocr-04')
    const entry = await suite.openBed('ocr04')
    const assets = await suite.ocrAssets()
    const ocr = suite.ocrOptions(assets.langPath, assets.cachePath)

    const fixture = 'img-degraded.png'
    const expected = expectOf(suite.fixtures, fixture)
    const reference = expected.ocrReference ?? ''
    const relativePath = suite.stageImage(entry, fixture)
    const got = await suite.recognize(entry, relativePath, ocr)
    rec.countInput(1)
    const content = got.content
    const text = content?.kind === 'ocr' ? content.text : ''
    const cer = characterErrorRate(reference, text)
    const numbersFound = (expected.keyNumbers ?? []).filter((number) => text.includes(number))

    /* 清晰样本作对照：退化图**不**与清晰样本平均（会掩盖问题） */
    const clearPath = suite.stageImage(entry, 'img-mixed.png')
    const clearGot = await suite.recognize(entry, clearPath, ocr)
    rec.countInput(1)
    const clearText = clearGot.content?.kind === 'ocr' ? clearGot.content.text : ''
    const clearCer = characterErrorRate(reference, clearText)

    rec.check(
      'ocr-04 退化图：**展示读数与范围**（逐样本 CER + 观测文本长度 + confidence），不混入任何平均值',
      Number.isFinite(cer),
      `CER=${(cer * 100).toFixed(2)}% · text.length=${String(text.length)} · confidence=${String(content?.kind === 'ocr' ? content.confidence : undefined)}`
    )
    rec.check(
      'ocr-04 退化图：退化读数**明显差于**同文本的清晰样本（这正是"不平均"要保住的差别）',
      cer > clearCer,
      `degraded CER=${(cer * 100).toFixed(2)}% vs clear CER=${(clearCer * 100).toFixed(2)}%`
    )
    rec.check(
      'ocr-04 退化图：有内容时核对数字；无内容时必须如实 partial 且不注入识别正文',
      text.trim() === ''
        ? resultOf(got.reading, IMAGE_OCR)?.status === 'partial' && got.reading.turnContent.length === 0
        : numbersFound.length === (expected.keyNumbers ?? []).length && (expected.keyNumbers ?? []).length > 0,
      `found=${numbersFound.join(' / ')}`
    )
    rec.check(
      'ocr-04 退化图：**没有**成功口吻被强留 —— 退化读数如实进了 facts（confidence 与耗时都在）',
      text.trim() === ''
        ? got.reading.guard.turnContent.states.some((state) => state.state === 'empty') && got.reading.guard.turnContent.appendix === ''
        : (content?.facts ?? []).some((fact) => fact.includes('confidence')) &&
          (content?.facts ?? []).some((fact) => fact.includes('冷启动')),
      (content?.facts ?? []).join(' · ').slice(0, 160)
    )
    rec.check(
      'ocr-04 退化图：manifest 明确把它标为 `clear:false`（门不把它混进清晰档的判定）',
      expected.clear === false,
      `clear=${String(expected.clear)}`
    )
    rec.note('degraded', {
      cer,
      clearCer,
      numbersFound,
      observedText: sanitize(text, 80),
      clearText: sanitize(clearText, 80),
    })
    return rec.finish('退化图')
  },
}

const ocr05: GroupRunner = {
  id: 'ocr-05',
  async run(_ctx, suite) {
    const unavailable = await ocrUnavailable(suite, 'ocr-05', '缺资产 / 非法或超限图')
    if (unavailable !== undefined) return unavailable
    const rec = new GroupRecorder('ocr-05')
    const entry = await suite.openBed('ocr05')
    const assets = await suite.ocrAssets()

    /* ① 缺语言资产：**在孵化子进程之前**失败关闭，且零出站 */
    const emptyLangDir = mkdtempSync(join(tmpdir(), 'utility-ocr-empty-lang-'))
    const missing = await suite.recognize(
      entry,
      suite.stageImage(entry, 'img-zh.png'),
      suite.ocrOptions(emptyLangDir, assets.cachePath)
    )
    rec.countInput(1)
    const missingResult = resultOf(missing.reading, IMAGE_OCR)
    rec.check(
      'ocr-05 缺资产：如实失败（`execution_failed`）并逐条写出缺了哪个文件',
      missingResult?.status === 'failed' &&
        missingResult.error?.code === 'execution_failed' &&
        (missingResult.error.message ?? '').includes('资产'),
      `code=${String(missingResult?.error?.code)} message=${sanitize(missingResult?.error?.message ?? '(无)')}`
    )
    rec.check(
      'ocr-05 缺资产：错误原因白名单传到回复层，明确说明资产故障并去掉模型猜测',
      missingResult?.error?.details?.reason === 'ocr_assets_missing' &&
        missing.reading.replyText.includes('本地 OCR 资产不可用') &&
        !missing.reading.replyText.includes('格式'),
      sanitize(missing.reading.replyText)
    )
    rec.check(
      'ocr-05 缺资产：失败详情列出问题清单与模型目录',
      Array.isArray(missingResult?.error?.details?.problems) &&
        (missingResult?.error?.details?.problems as unknown[]).length > 0 &&
        typeof missingResult?.error?.details?.modelDir === 'string',
      JSON.stringify(missingResult?.error?.details ?? {}).slice(0, 200)
    )
    rec.check(
      'ocr-05 缺资产：**没有**当轮内容 ⇒ 不可能有"我识别到了"的事实',
      missing.reading.turnContent.length === 0,
      `turnContent=${String(missing.reading.turnContent.length)}`
    )
    rec.check(
      'ocr-05 缺资产：回复守卫把它顶替成如实句（不说"识别出"）',
      !missing.reading.replyText.includes('识别出') &&
        missing.reading.guard.turnContent.states.some((state) => state.state === 'failed'),
      sanitize(missing.reading.replyText)
    )

    /* ② 非法图：magic bytes 不是 PNG/JPEG */
    const notImagePath = entry.sandbox.writeBytes('not-an-image.png', Buffer.from('这不是图片，只是改了扩展名的文本。', 'utf8'))
    const notImage = await suite.recognize(entry, notImagePath, suite.ocrOptions(assets.langPath, assets.cachePath))
    rec.countInput(1)
    const notImageResult = resultOf(notImage.reading, IMAGE_OCR)
    rec.check(
      'ocr-05 非法图：magic bytes 不对 ⇒ `validation_failed`（在识别之前拒绝）',
      notImageResult?.status === 'rejected' &&
        notImageResult.error?.code === 'validation_failed' &&
        (notImageResult.error.message ?? '').includes('magic bytes'),
      `code=${String(notImageResult?.error?.code)} message=${sanitize(notImageResult?.error?.message ?? '(无)')}`
    )

    /* ③ 截断的 PNG（魔数对、IHDR 读不出） */
    const truncated = entry.sandbox.writeBytes(
      'truncated.png',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
    )
    const truncatedGot = await suite.recognize(
      entry,
      truncated,
      suite.ocrOptions(assets.langPath, assets.cachePath)
    )
    rec.countInput(1)
    rec.check(
      'ocr-05 截断的 PNG：读不出宽高 ⇒ 拒绝（**不猜**默认尺寸，否则像素上限就是空话）',
      resultOf(truncatedGot.reading, IMAGE_OCR)?.error?.code === 'validation_failed',
      sanitize(resultOf(truncatedGot.reading, IMAGE_OCR)?.error?.message ?? '(无)')
    )

    /* ④ 像素超限：6000×4000 = 24 MP > 20 MP（尺寸在识别**之前**校验） */
    const oversizedPixels = entry.sandbox.writeBytes('over-pixels.png', buildOversizedPng(6000, 4000))
    const overPixels = await suite.recognize(
      entry,
      oversizedPixels,
      suite.ocrOptions(assets.langPath, assets.cachePath)
    )
    rec.countInput(1)
    rec.check(
      'ocr-05 像素超限：24 MP > 20 MP ⇒ 在识别之前拒绝，并写出实际像素数',
      resultOf(overPixels.reading, IMAGE_OCR)?.error?.code === 'validation_failed' &&
        (resultOf(overPixels.reading, IMAGE_OCR)?.error?.message ?? '').includes('24000000'),
      sanitize(resultOf(overPixels.reading, IMAGE_OCR)?.error?.message ?? '(无)')
    )

    /* ⑤ 字节超限：超过 16 MiB（大小检查在最前面，所以不需要是合法 PNG） */
    const oversizedBytes = entry.sandbox.writeBytes(
      'over-bytes.png',
      Buffer.alloc(17 * 1024 * 1024, 0x41)
    )
    const overBytes = await suite.recognize(
      entry,
      oversizedBytes,
      suite.ocrOptions(assets.langPath, assets.cachePath)
    )
    rec.countInput(1)
    rec.check(
      'ocr-05 字节超限：17 MiB > 16 MiB ⇒ 在识别之前拒绝，并写出实际字节数',
      resultOf(overBytes.reading, IMAGE_OCR)?.error?.code === 'validation_failed' &&
        (resultOf(overBytes.reading, IMAGE_OCR)?.error?.message ?? '').includes('17825792'),
      sanitize(resultOf(overBytes.reading, IMAGE_OCR)?.error?.message ?? '(无)')
    )

    /* ⑥ 正控：同一套读法在合法图上**必须**成功（否则上面的拒绝只是量具坏了） */
    const positive = await suite.recognize(
      entry,
      suite.stageImage(entry, 'img-en.png'),
      suite.ocrOptions(assets.langPath, assets.cachePath)
    )
    rec.countInput(1)
    rec.check(
      'ocr-05 **正控**：同一套读法在合法清晰图上仍然成功（证明上面的拒绝不是量具坏了）',
      positive.content?.kind === 'ocr' && positive.content.text.includes('4711'),
      `kind=${String(positive.content?.kind)}`
    )
    rec.check(
      'ocr-05 缺资产路径上**没有出站**：失败详情里没有网络错误，且失败发生在资产核对阶段',
      (missingResult?.error?.details?.loadedAnything ?? false) === false ||
        missingResult?.error?.details?.loadedAnything === undefined,
      `loadedAnything=${String(missingResult?.error?.details?.loadedAnything)}`
    )
    rec.note('rejects', {
      missingAssetCode: String(missingResult?.error?.code ?? ''),
      notImageCode: String(notImageResult?.error?.code ?? ''),
      positiveOk: positive.content?.kind === 'ocr',
    })
    return rec.finish('缺资产 / 非法或超限图')
  },
}

const ocr06: GroupRunner = {
  id: 'ocr-06',
  async run(_ctx, suite) {
    const unavailable = await ocrUnavailable(suite, 'ocr-06', '工作器超时 / 恢复')
    if (unavailable !== undefined) return unavailable
    const rec = new GroupRecorder('ocr-06')
    const entry = await suite.openBed('ocr06')
    const assets = await suite.ocrAssets()
    const hangingWorker = suite.writeHangingWorker()

    /*
     * ① 超时：把子进程脚本换成一个**永不作答**的脚本（真实 OCR 走不到 30 秒超时），
     *    用 2 秒硬超时 —— 判据是"被 SIGKILL 且确认退出"，而不是"看起来失败了"。
     */
    const startedAt = Date.now()
    const timedOut = await suite.recognize(
      entry,
      suite.stageImage(entry, 'img-zh.png'),
      { ...suite.ocrOptions(assets.langPath, assets.cachePath, 2000), workerScript: hangingWorker }
    )
    const elapsed = Date.now() - startedAt
    rec.countInput(1)
    const timeoutResult = resultOf(timedOut.reading, IMAGE_OCR)
    rec.check(
      'ocr-06 超时：终态是 `timeout`（不是 failed，也不是 success）',
      timeoutResult?.status === 'timeout' && timeoutResult.error?.code === 'timeout',
      `status=${String(timeoutResult?.status)} code=${String(timeoutResult?.error?.code)}`
    )
    rec.check(
      'ocr-06 超时：**确认释放** —— 详情里 `released=true`，且实际等待了硬超时那么久',
      timeoutResult?.error?.details?.released === true &&
        elapsed >= 2000 &&
        elapsed < 20_000,
      `released=${String(timeoutResult?.error?.details?.released)} elapsedMs=${String(elapsed)}`
    )
    rec.check(
      'ocr-06 超时：没有当轮内容，回复守卫顶替成如实句',
      timedOut.reading.turnContent.length === 0 &&
        timedOut.reading.guard.turnContent.states.some((state) => state.state === 'timeout'),
      sanitize(timedOut.reading.replyText)
    )

    /* ② 恢复：超时之后同一适配器下一次调用**正常成功** */
    const recovered = await suite.recognize(
      entry,
      suite.stageImage(entry, 'img-en.png'),
      suite.ocrOptions(assets.langPath, assets.cachePath)
    )
    rec.countInput(1)
    rec.check(
      'ocr-06 恢复：被 SIGKILL 之后，同一能力下一次调用**正常识别**（`4711` 在其中）',
      recovered.content?.kind === 'ocr' && recovered.content.text.includes('4711'),
      `text="${sanitize(recovered.content?.kind === 'ocr' ? recovered.content.text : '', 60)}"`
    )

    /*
     * ③ 取消：已经 abort 的信号 ⇒ 立刻杀掉并如实回 `cancelled`。
     *
     * ⚠️ 这一条走的是**部件级**调用（不是网关）：取消信号在生产里经
     *    `AdapterExecuteInput.args.signal` 传入，而 `action-turn` 给适配器的 `args`
     *    **逐字取自意图**（`action-turn.ts:172`）—— 也就是说，验证脚本无法通过
     *    "用户原话"把 AbortSignal 送进真实链路。这里如实分列：
     *    适配器自己的取消契约（部件级）+ 取消之后**真实网关**仍然正常（下面 ④）。
     */
    const directAdapter = createImageOcrAdapter({
      root: entry.sandbox.root,
      ...(suite.ocrOptions(assets.langPath, assets.cachePath, 60_000) as object),
      workerScript: hangingWorker,
    })
    const abortController = new AbortController()
    abortController.abort()
    let cancelCode = ''
    let cancelReleased: unknown
    try {
      await directAdapter.execute({
        actionId: 'utility-verify:cancel' as never,
        operation: 'recognize',
        target: { type: 'sandbox_file', canonicalId: 'img-zh.png', confidence: 'exact' },
        args: { path: 'img-zh.png', signal: abortController.signal },
        now: () => Date.now(),
      } as never)
      cancelCode = '(没有抛错)'
    } catch (error) {
      const failure = (error as { failure?: { code?: string; details?: Record<string, unknown> } }).failure
      cancelCode = String(failure?.code ?? (error as Error).message)
      cancelReleased = failure?.details?.released
    }
    rec.countInput(1)
    rec.check(
      'ocr-06 取消：已 abort 的信号 ⇒ 终态 `cancelled` 且确认释放（部件级：适配器的取消契约）',
      cancelCode === 'cancelled' && cancelReleased === true,
      `code=${cancelCode} released=${String(cancelReleased)}`
    )

    /* ④ 释放计数归零：没有残留的子进程（用一次真实的再识别证明适配器不欠账） */
    const afterAll = await suite.recognize(
      entry,
      suite.stageImage(entry, 'img-mixed.png'),
      suite.ocrOptions(assets.langPath, assets.cachePath)
    )
    rec.countInput(1)
    rec.check(
      'ocr-06 释放计数归零：连续"被杀 + 恢复 + 再识别"之后仍然正常工作（首版一次一个 worker ⇒ 无残留）',
      afterAll.content?.kind === 'ocr' && afterAll.content.text.length > 0,
      `text.length=${String(afterAll.content?.kind === 'ocr' ? afterAll.content.text.length : 0)}`
    )
    rec.check(
      'ocr-06 释放事实进 facts：成功那一轮里写着"工作器已释放（退出码 …）"',
      (recovered.content?.facts ?? []).some((fact) => fact.includes('工作器已释放')),
      (recovered.content?.facts ?? []).find((fact) => fact.includes('工作器已释放')) ?? '(缺)'
    )
    rec.check(
      'ocr-06 超时阈值是**调用方可配**的（本组用 2000ms，生产缺省 30000ms）—— 配置事实可查',
      timeoutResult?.error?.details?.releasedMs !== undefined,
      `releasedMs=${String(timeoutResult?.error?.details?.releasedMs)}`
    )
    rec.note('timeoutRecovery', {
      timeoutElapsedMs: elapsed,
      released: timeoutResult?.error?.details?.released ?? null,
      recovered: recovered.content?.kind === 'ocr',
      afterAll: afterAll.content?.kind === 'ocr',
      hangingWorkerExists: existsSync(hangingWorker),
    })
    return rec.finish('工作器超时 / 恢复')
  },
}

export const OCR_GROUPS: readonly GroupRunner[] = [ocr01, ocr02, ocr03, ocr04, ocr05, ocr06]

export type { TurnContent, BedEntry }
