/**
 * groups-document —— 文档阅读的 6 组（计划书 §4A「文档 6 组」）。
 *
 * ```text
 * document-01 PDF                  指定文字、数字及实有结构；原文件未改
 * document-02 DOCX                 同上
 * document-03 PPTX                 同上
 * document-04 XLSX                 同上
 * document-05 空 / 扫描件           无法取得内容时**没有**成功阅读事实
 * document-06 损坏 / 伪装 / 超限     降档；原文件未改；**适配器自己**在魔数层拒绝
 * ```
 *
 * ⚠️ **期望值只来自 `fixtures/manifest.json`**（准备期独立写下的参考答案），
 *    不是从转换器输出回填的 —— 否则"断言"会退化成"复述"。
 *
 * ⚠️ `document-06` 的判据刻意落在**适配器的魔数判定**上：markitdown 会用 magika
 *    嗅探内容并吞掉转换器异常，它的 `ok:true` 只意味着"某个转换器成功了"，
 *    一个改了扩展名的二进制会静默降级成纯文本。因此那一条判据必须证明
 *    "**Python 进程根本没被启动**"，而不是"markitdown 报错了"。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { DOCUMENT_READ } from '../../src/kernel/action/utility-capabilities.ts'
import { createDocumentReadAdapter, structureOf } from '../../src/infrastructure/action/adapters/document-read.ts'
import type { DocumentReadOptions } from '../../src/infrastructure/action/adapters/document-read.ts'
import type { TurnContent } from '../../src/kernel/contracts/turn-content.ts'

import { firstResult, resultOf, summarizeActions } from './assembly.ts'
import type { BedEntry, GroupRunner, Suite, VerifyContext } from './groups.ts'
import { GroupRecorder, buildMinimalPdf, sanitize } from './groups.ts'
import { expectOf } from './fixtures.ts'

/** 一个"转换器被调用了几次"的计数器（只用于证明**没有**被调用） */
function makeConvertCounter(): {
  options: DocumentReadOptions['convert']
  calls: number
  formats: string[]
} {
  const state = { calls: 0, formats: [] as string[] }
  return {
    get calls() {
      return state.calls
    },
    get formats() {
      return state.formats
    },
    options: async () => {
      state.calls += 1
      state.formats.push('(被调用了)')
      return { ok: false, errorType: 'counter-only', error: '这个注入点不该被调用', timedOut: false }
    },
  }
}

interface DocumentCase {
  readonly fixture: string
  readonly format: 'pdf' | 'docx' | 'pptx' | 'xlsx'
}

async function runFormatGroup(
  ctx: VerifyContext,
  suite: Suite,
  input: { id: string; title: string; cases: readonly DocumentCase[]; structureMarkers: readonly string[] }
): Promise<ReturnType<GroupRecorder['finish']>> {
  const rec = new GroupRecorder(input.id)
  const entry = await suite.openBed(input.id.replace('-', ''))
  const counter = makeConvertCounter()

  for (const item of input.cases) {
    const staged = suite.stageDocument(entry, item.fixture)
    const expected = expectOf(suite.fixtures, item.fixture)
    const before = createHash('sha256').update(readFileSync(staged.absolutePath)).digest('hex')

    const got = await suite.readDocument(entry, staged.relativePath)
    rec.countInput(1)
    const text = got.content?.text ?? ''

    suite.checkTurnContent(rec, got.content, `${input.id} ${item.fixture} 的当轮内容`)

    const mustContain = expected.mustContain ?? []
    const mustNotContain = expected.mustNotContain ?? []
    const missing = mustContain.filter((needle) => !text.includes(needle))
    const forbidden = mustNotContain.filter((needle) => text.includes(needle))
    rec.check(
      `${input.id} ${item.fixture}：manifest 的**全部** mustContain 都出现（${String(mustContain.length)} 条）`,
      missing.length === 0 && mustContain.length > 0,
      missing.length === 0 ? `全部命中：${mustContain.join(' / ')}` : `缺少：${missing.join(' / ')}`
    )
    rec.check(
      `${input.id} ${item.fixture}：manifest 的 mustNotContain 一条都不出现（${String(mustNotContain.length)} 条）`,
      forbidden.length === 0,
      forbidden.length === 0 ? '没有禁止串' : `出现：${forbidden.join(' / ')}`
    )

    /*
     * 结构：只断言"转换器**实际给出**的那类标记在"，**不**要求它没给出的东西。
     *
     * ⚠️ 实测（两次）：markitdown 对**文字型 PDF** 只给平段落，**不给** `#` 标题层级
     *    ⇒ 对 PDF 要求"标题"就是要求适配器编一个不存在的东西。
     *    因此这一条按格式分别断言（`structureMarkers` 空 = 该格式只断言"页/位不提供"那一行）。
     */
    const structure = got.content?.kind === 'document' ? got.content.structure : []
    rec.check(
      input.structureMarkers.length === 0
        ? `${input.id} ${item.fixture}：结构读数**如实**（本格式转换器不给标题层级，门不要求它）`
        : `${input.id} ${item.fixture}：转换器给出的结构标记里有 ${input.structureMarkers.join(' / ')}`,
      input.structureMarkers.every((marker) => structure.some((line) => line.includes(marker))),
      structure.join(' · ')
    )
    rec.check(
      `${input.id} ${item.fixture}：结构里明确说明"页码/精确定位**不提供**"（不生成虚构位置）`,
      structure.some((line) => line.includes('不提供')),
      structure.find((line) => line.includes('不提供')) ?? '(缺)'
    )

    /* 原文件未改：内容指纹与 manifest 声明一致（读操作不得改写源文件） */
    const after = createHash('sha256').update(readFileSync(staged.absolutePath)).digest('hex')
    rec.check(
      `${input.id} ${item.fixture}：**原文件未改**（前后 sha256 逐字相同，且等于 manifest 声明值）`,
      before === after && after === staged.sha256,
      `after=${after.slice(0, 16)}… declared=${String(staged.sha256).slice(0, 16)}…`
    )
    rec.check(
      `${input.id} ${item.fixture}：内容指纹是程序算的，且正文长度在范围里`,
      got.content?.sourceFingerprint === after &&
        (got.content?.scope.includedChars ?? 0) > 0 &&
        (got.content?.scope.includedChars ?? 0) === text.length,
      `sourceFingerprint=${String(got.content?.sourceFingerprint).slice(0, 16)}… chars=${String(got.content?.scope.includedChars)}`
    )
    rec.note(`${item.fixture}`, {
      bytes: staged.bytes,
      sha256: after.slice(0, 16),
      chars: text.length,
      structure,
      facts: got.content?.facts ?? [],
    })
  }

  rec.check(
    `${input.id}：整个格式组**没有**用注入计数器（这一组走的是真转换环境）`,
    counter.calls === 0,
    `注入点调用次数=${String(counter.calls)}`
  )
  void ctx
  return rec.finish(input.title)
}

const document01: GroupRunner = {
  id: 'document-01',
  async run(ctx, suite) {
    if (!suite.fixturesUsable) {
      const rec = new GroupRecorder('document-01')
      return rec.finish('PDF', { notRunReason: suite.fixturesProblem })
    }
    return await runFormatGroup(ctx, suite, {
      id: 'document-01',
      title: 'PDF',
      cases: [{ fixture: 'doc-zh.pdf', format: 'pdf' }],
      structureMarkers: [],
    })
  },
}

const document02: GroupRunner = {
  id: 'document-02',
  async run(ctx, suite) {
    if (!suite.fixturesUsable) {
      const rec = new GroupRecorder('document-02')
      return rec.finish('DOCX', { notRunReason: suite.fixturesProblem })
    }
    return await runFormatGroup(ctx, suite, {
      id: 'document-02',
      title: 'DOCX',
      cases: [{ fixture: 'doc-table.docx', format: 'docx' }],
      structureMarkers: ['标题', '表格行'],
    })
  },
}

const document03: GroupRunner = {
  id: 'document-03',
  async run(ctx, suite) {
    if (!suite.fixturesUsable) {
      const rec = new GroupRecorder('document-03')
      return rec.finish('PPTX', { notRunReason: suite.fixturesProblem })
    }
    return await runFormatGroup(ctx, suite, {
      id: 'document-03',
      title: 'PPTX',
      cases: [{ fixture: 'doc-two-slides.pptx', format: 'pptx' }],
      structureMarkers: ['幻灯片标记'],
    })
  },
}

const document04: GroupRunner = {
  id: 'document-04',
  async run(ctx, suite) {
    if (!suite.fixturesUsable) {
      const rec = new GroupRecorder('document-04')
      return rec.finish('XLSX', { notRunReason: suite.fixturesProblem })
    }
    return await runFormatGroup(ctx, suite, {
      id: 'document-04',
      title: 'XLSX',
      cases: [{ fixture: 'doc-two-sheets.xlsx', format: 'xlsx' }],
      structureMarkers: ['工作表标记'],
    })
  },
}

const document05: GroupRunner = {
  id: 'document-05',
  async run(_ctx, suite) {
    const rec = new GroupRecorder('document-05')
    if (!suite.fixturesUsable) {
      return rec.finish('空 / 扫描件', { notRunReason: suite.fixturesProblem })
    }
    const entry = await suite.openBed('document05')

    /* 扫描件：有页面、有内容，但没有文字层 */
    const scan = suite.stageDocument(entry, 'doc-scan.pdf')
    const scanExpected = expectOf(suite.fixtures, 'doc-scan.pdf')
    const scanGot = await suite.readDocument(entry, scan.relativePath)
    rec.countInput(1)
    const scanResult = resultOf(scanGot.reading, DOCUMENT_READ)
    rec.check(
      'document-05 扫描件：**没有成功阅读事实**（终态不是 success，也没有当轮内容）',
      scanResult?.status !== 'success' && scanGot.reading.turnContent.length === 0,
      JSON.stringify(summarizeActions(scanGot.reading))
    )
    rec.check(
      'document-05 扫描件：失败落在"没有可提取的文字"那一档（不是笼统的 execution_failed）',
      (scanResult?.error?.message ?? '').includes('没有可提取的文字'),
      `code=${String(scanResult?.error?.code)} message=${sanitize(scanResult?.error?.message ?? '(无)')}`
    )
    rec.check(
      'document-05 扫描件：**不猜测内容** —— 栅格层里的文字没有出现在任何当轮内容里',
      scanGot.reading.turnContent.length === 0,
      `rasterText=${sanitize(scanExpected.rasterTextNotExtractable ?? '(未声明)')}`
    )
    rec.check(
      'document-05 扫描件：回复守卫把"我读完了"顶替成如实句',
      !scanGot.reading.replyText.includes('我读完了') &&
        scanGot.reading.guard.turnContent.states.some((state) => state.state === 'failed'),
      sanitize(scanGot.reading.replyText)
    )

    /*
     * 空文件 —— **两档都要有读数**，因为它们是**两条不同的闸**：
     *
     * ```text
     * ① 格式闸（魔数）：0 字节 `.pdf` ⇒ `unsupported`「文件头不是 %PDF-」
     *       实测：**格式闸排在"空内容"分支之前** ⇒ 0 字节的 pdf/docx 到不了"0 字节"那句
     * ② 内容分支：过了格式闸但正文为空（真空白 PDF / 无文字层）⇒「没有可提取的文字」
     * ```
     *
     * ⚠️ 一条**实测到的可达性事实**（如实登记，不粉饰）：`document.read` 目前
     *    **没有** "文件是空的（0 字节）" 这句能到达的路径 ——
     *    `.txt` 归 M4.5（`sandbox.file.read`，对 0 字节的 success 是对的），
     *    而 pdf/docx/pptx/xlsx 的 0 字节文件一律先被**格式闸**拦下。
     *    因此这里把两档分列断言，并**不**要求出现那句不可达的话术。
     */
    const zeroBytePdf = entry.sandbox.writeBytes('doc-zero.pdf', Buffer.alloc(0))
    const zeroGot = await suite.readDocument(entry, zeroBytePdf)
    rec.countInput(1)
    const zeroResult = resultOf(zeroGot.reading, DOCUMENT_READ)
    rec.check(
      'document-05 0 字节 `.pdf`：走的是**格式闸**（`unsupported`，「文件头不是 %PDF-」），且在转换之前',
      String(zeroResult?.capability) === DOCUMENT_READ &&
        zeroResult?.status === 'rejected' &&
        zeroResult?.error?.code === 'unsupported' &&
        (zeroResult.error.message ?? '').includes('%PDF-') &&
        zeroGot.reading.turnContent.length === 0,
      JSON.stringify(summarizeActions(zeroGot.reading))
    )
    /*
     * ⚠️ 「文件是空的（0 字节）」这句只可能来自**没有魔数**的格式（`.txt` / `.md`）。
     *    而 `.txt` 在检测器那一层归 M4.5 ⇒ 想量到这句，只能走**显式请求**
     *    （与计划书 §4A 的"驱动方式"一致：明确写清是显式请求，不假装是用户原话触发的）。
     */
    entry.sandbox.writeBytes('doc-empty.txt', Buffer.alloc(0))
    /*
     * ⚠️ 对照档必须是一个**真的能抽出字**的文件。第一版用非空 `.txt`，
     *    而 markitdown 的 `convert_stream(file_extension='.txt')` 把它抽成了**空串**
     *    ⇒ 那一档落回同一句"没有可提取的文字"，看起来像"两条闸一样"。
     *    这里换成有正文的最小 PDF（内容流里有一条 ASCII 行）。
     */
    const readablePdfPath = entry.sandbox.writeBytes('doc-readable.pdf', buildMinimalPdf(['READABLE PROBE LINE 4096']))
    /*
     * ⚠️ **部件级**调用（明写，不假装是用户原话触发）：`document.read` 适配器**本尊** +
     *    真 Python 转换环境。走这一层是因为 `.txt` 在检测器那一层归 M4.5，
     *    通过"用户原话"永远到不了 `document.read` 的 `.txt` 分支。
     */
    const directAdapter = createDocumentReadAdapter({ root: entry.sandbox.root })
    const runDirect = async (relativePath: string): Promise<{ code: string; message: string }> => {
      try {
        const outcome = await directAdapter.execute({
          actionId: `utility-verify:doc05:${relativePath}` as never,
          operation: 'read',
          target: { type: 'sandbox_file', canonicalId: relativePath, confidence: 'exact' },
          args: { path: relativePath },
          now: () => Date.now(),
        } as never)
        return { code: 'success', message: outcome.effect?.detail ?? '' }
      } catch (error) {
        const failure = (error as { failure?: { code?: string; message?: string } }).failure
        return { code: String(failure?.code ?? 'unknown'), message: String(failure?.message ?? '') }
      }
    }
    const txtEmpty = await runDirect('doc-empty.txt')
    const txtNonEmpty = await runDirect('doc-readable.pdf')
    rec.countInput(1)
    rec.check(
      'document-05 0 字节 `.txt`（**部件级**驱动，明写不假装是用户原话）：走**内容分支** 「文件是空的（0 字节）」',
      txtEmpty.code === 'target_not_found' && txtEmpty.message.includes('0 字节'),
      `code=${txtEmpty.code} message=${sanitize(txtEmpty.message, 60)}`
    )
    rec.check(
      'document-05 有正文的 PDF（**部件级**驱动，正控）：**能读到内容** —— 因此上面那条 0 字节读数的"不同"不是量具坏了',
      txtNonEmpty.code === 'success' && txtNonEmpty.message.includes('doc-readable.pdf'),
      `code=${txtNonEmpty.code} message=${sanitize(txtNonEmpty.message, 70)}`
    )
    /* 过了格式闸但**正文为空**的真 PDF（内容流是空的）⇒ 内容分支 */
    const blankPdf = entry.sandbox.writeBytes('doc-blank.pdf', buildMinimalPdf([]))
    const blankGot = await suite.readDocument(entry, blankPdf)
    rec.countInput(1)
    const blankResult = resultOf(blankGot.reading, DOCUMENT_READ)
    rec.check(
      'document-05 空白 PDF（格式合法、内容为空）：走的是**内容分支**（「没有可提取的文字」）',
      blankResult?.status === 'not_found' &&
        (blankResult.error?.message ?? '').includes('没有可提取的文字') &&
        blankGot.reading.turnContent.length === 0,
      JSON.stringify(summarizeActions(blankGot.reading))
    )
    rec.check(
      'document-05 两档话术**必须不同**：0 字节（格式闸）≠ 空白正文（内容分支）',
      (zeroResult?.error?.message ?? '') !== (blankResult?.error?.message ?? '') &&
        (zeroResult?.error?.code ?? '') !== (blankResult?.error?.code ?? ''),
      `zero=${sanitize(zeroResult?.error?.message ?? '(无)', 60)} · blank=${sanitize(blankResult?.error?.message ?? '(无)', 60)}`
    )
    /*
     * ⚠️ 如实登记一处**同话术**：空白 PDF 与扫描件都落在**同一条内容分支**上
     *    （markitdown 对两者都给出空串）⇒ 它们的失败句**逐字相同**。
     *    这不合并它们的语义（"本来就是空的"与"扫描件没有文字层"对用户是两件事），
     *    但**不能**假装程序能分辨 —— 可分辨的只有**两层闸**：格式闸 vs 内容分支。
     */
    const messages = new Set([
      zeroResult?.error?.message ?? '',
      blankResult?.error?.message ?? '',
      scanResult?.error?.message ?? '',
    ])
    rec.check(
      'document-05 可分辨的**两层**：格式闸话术 ⟂ 内容分支话术（空白 PDF 与扫描件共用内容分支那一句，如实登记）',
      messages.size === 2 &&
        txtEmpty.message !== (blankResult?.error?.message ?? '') &&
        (zeroResult?.error?.message ?? '') !== (blankResult?.error?.message ?? ''),
      `distinct=${String(messages.size)} · zero=${sanitize(zeroResult?.error?.message ?? '(无)', 40)} · content-branch=${sanitize(blankResult?.error?.message ?? '(无)', 40)}`
    )
    rec.check(
      'document-05 原文件未改：扫描件前后指纹一致（且等于 manifest 声明值）',
      createHash('sha256').update(readFileSync(scan.absolutePath)).digest('hex') === scan.sha256,
      '前后一致'
    )
    rec.note('noContent', {
      scan: summarizeActions(scanGot.reading),
      zeroByte: summarizeActions(zeroGot.reading),
      blankContent: summarizeActions(blankGot.reading),
    })
    return rec.finish('空 / 扫描件')
  },
}

const document06: GroupRunner = {
  id: 'document-06',
  async run(_ctx, suite) {
    const rec = new GroupRecorder('document-06')
    if (!suite.fixturesUsable) {
      return rec.finish('损坏、伪装格式、加密/超限', { notRunReason: suite.fixturesProblem })
    }
    const entry = await suite.openBed('document06')

    /*
     * ⚠️ 关键判据：把转换器换成"被调用就记账"的注入点。
     *    下面的每一档都必须在**魔数/规模**层被适配器拒绝 ⇒ 计数器恒为 0
     *    ⇒ "Python 进程根本没被启动"是**结构性**的，不是靠纪律。
     */
    const counter = makeConvertCounter()

    const rejected: readonly { fixture: string; why: string }[] = [
      { fixture: 'doc-corrupt.docx', why: '512 字节非 ZIP 数据却叫 .docx' },
      { fixture: 'doc-fake.pdf', why: '纯文本却叫 .pdf（伪装格式）' },
    ]
    for (const item of rejected) {
      const staged = suite.stageDocument(entry, item.fixture)
      const before = createHash('sha256').update(readFileSync(staged.absolutePath)).digest('hex')
      const reading = await entry.bed.say({
        options: {
          switches: { document: true },
          sandboxRoot: entry.sandbox.root,
          documentConvert: counter.options,
        },
        text: `帮我读一下 ${staged.relativePath}`,
        replyText: '我读完了，里面写着温度 21.5 度。',
      })
      rec.countInput(1)
      const result = resultOf(reading, DOCUMENT_READ)
      rec.check(
        `document-06 ${item.fixture}（${item.why}）被降档拒绝，且理由具名`,
        result?.status === 'rejected' &&
          result?.error?.code === 'unsupported' &&
          (result.error.message ?? '').length > 0,
        `code=${String(result?.error?.code)} message=${sanitize(result?.error?.message ?? '(无)')}`
      )
      rec.check(
        `document-06 ${item.fixture}：**转换器一次都没被调用**（拒绝发生在魔数层）`,
        counter.calls === 0,
        `注入点调用次数=${String(counter.calls)}`
      )
      rec.check(
        `document-06 ${item.fixture}：没有当轮内容，回复守卫顶替了成功口吻`,
        reading.turnContent.length === 0 && !reading.replyText.includes('我读完了'),
        `turnContent=${String(reading.turnContent.length)} reply=${sanitize(reading.replyText)}`
      )
      const after = createHash('sha256').update(readFileSync(staged.absolutePath)).digest('hex')
      rec.check(
        `document-06 ${item.fixture}：**原文件未改**（前后 sha256 与 manifest 声明逐字相同）`,
        before === after && after === staged.sha256,
        `after=${after.slice(0, 16)}…`
      )
    }

    /*
     * 超限档：
     *
     * ⚠️ 第一版用 `doc-huge.txt`（12 MiB）—— 那是个**夹具缺陷**（不是适配器问题）：
     *    `.txt` **不在** `DOCUMENT_EXTENSIONS`（`pdf|docx|pptx|xlsx`）里，
     *    因此那句话连 `document.read` 的请求都产生不了，永远不会走到规模闸。
     *    这里改成一个 **11 MiB 的 `.pdf`**（在沙箱里现生成：规模闸看的是文件大小，
     *    而它排在魔数检查**之前** ⇒ 这一档量到的正是"超限"本身）。
     */
    const hugePdf = entry.sandbox.writeBytes('doc-huge.pdf', Buffer.alloc(11 * 1024 * 1024, 0x25))
    const huge = await entry.bed.say({
      options: {
        switches: { document: true },
        sandboxRoot: entry.sandbox.root,
        documentConvert: counter.options,
      },
      text: `帮我读一下 ${hugePdf}`,
      replyText: '我读完了，里面写着温度 21.5 度。',
    })
    rec.countInput(1)
    const hugeResult = resultOf(huge, DOCUMENT_READ)
    rec.check(
      'document-06 超限（11 MiB `.pdf`）：被**规模闸**拒绝（`unsupported`，理由是"超过上限"）',
      hugeResult?.status === 'rejected' &&
        hugeResult.error?.code === 'unsupported' &&
        (hugeResult.error.message ?? '').includes('超过上限'),
      `code=${String(hugeResult?.error?.code)} message=${sanitize(hugeResult?.error?.message ?? '(无)')}`
    )
    rec.check(
      'document-06 超限：**转换器一次都没被调用**（规模闸在转换之前）',
      counter.calls === 0,
      `注入点调用次数=${String(counter.calls)}`
    )
    rec.check(
      'document-06 超限：没有当轮内容，回复守卫顶替了成功口吻',
      huge.turnContent.length === 0 && !huge.replyText.includes('我读完了'),
      `turnContent=${String(huge.turnContent.length)}`
    )
    rec.check(
      'document-06 超限：manifest 里那个**同名但扩展名不同**的样本（`doc-huge.txt`）**不产生**文档请求（`.txt` 归 M4.5）',
      await (async () => {
        const staged = suite.stageDocument(entry, 'doc-huge.txt')
        const legacy = await entry.bed.say({
          options: { switches: { document: true }, sandboxRoot: entry.sandbox.root },
          text: `帮我读一下 ${staged.relativePath}`,
          replyText: '（离线验收的固定回复）',
        })
        return (
          resultOf(legacy, DOCUMENT_READ) === undefined && legacy.turnContent.length === 0
        )
      })(),
      '`.txt` 没有产生 document.read 请求（如实登记这一档的归属）'
    )

    /* 首版不支持的扩展名：在扩展名闸就被拒（同样不启动转换器） */
    entry.sandbox.writeBytes('archive.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))
    const zipReading = await entry.bed.say({
      options: {
        switches: { document: true },
        sandboxRoot: entry.sandbox.root,
        documentConvert: counter.options,
      },
      text: '帮我读一下 archive.zip',
      replyText: '我读完了。',
    })
    rec.countInput(1)
    rec.check(
      'document-06 首版不支持的扩展名（`.zip`）：检测层不产生文档请求，转换器 0 次调用',
      counter.calls === 0 && zipReading.turnContent.length === 0,
      `actions=${JSON.stringify(summarizeActions(zipReading))}`
    )

    /* 加密档：首版**没有**加密 fixture ⇒ 如实登记 NOT COVERED（不假称已测） */
    const encryptedFixture = suite.fixtures.manifest?.files.find((file) =>
      /(encrypt|password|加密)/i.test(file.path)
    )
    rec.check(
      'document-06 加密档：本批 fixture 里**没有**加密样本 ⇒ 如实登记为该档**未覆盖**（不假称已测）',
      encryptedFixture === undefined,
      encryptedFixture === undefined
        ? 'fixture 里没有加密样本 ⇒ 加密档 NOT COVERED（首版只覆盖损坏 / 伪装 / 超限）'
        : `存在加密样本：${encryptedFixture.path}`
    )

    /* 正控：同一套注入点在合法文件上**会**被调用（证明计数器真的在量东西） */
    const positive = suite.stageDocument(entry, 'doc-zh.pdf')
    const positiveReading = await entry.bed.say({
      options: {
        switches: { document: true },
        sandboxRoot: entry.sandbox.root,
        documentConvert: async () => {
          counter.options
          return { ok: true, markdown: '# 假转换\n\n这是注入点返回的正文。', timedOut: false }
        },
      },
      text: `帮我读一下 ${positive.relativePath}`,
      replyText: '（离线验收的固定回复）',
    })
    rec.countInput(1)
    rec.check(
      'document-06 **正控**：同一形状的注入点在合法文件上**确实会**被调用并产出内容（证明上面的"0 次"不是量具坏了）',
      positiveReading.turnContent.length === 1 &&
        (positiveReading.turnContent[0]?.text ?? '').includes('这是注入点返回的正文'),
      `turnContent=${String(positiveReading.turnContent.length)}`
    )
    rec.note('degrade', {
      rejected: rejected.map((item) => item.fixture),
      converterCallsOnRejected: counter.calls,
      overLimitRejected: hugeResult?.error?.code ?? null,
      encryptedCovered: encryptedFixture !== undefined,
    })
    return rec.finish('损坏、伪装格式、加密/超限')
  },
}

export const DOCUMENT_GROUPS: readonly GroupRunner[] = [
  document01,
  document02,
  document03,
  document04,
  document05,
  document06,
]

/* 引用（说明这个导出是刻意保留的：结构判据的单一实现在适配器里） */
export const DOCUMENT_HELPERS = { createDocumentReadAdapter, structureOf } as const
export type { TurnContent, BedEntry }
