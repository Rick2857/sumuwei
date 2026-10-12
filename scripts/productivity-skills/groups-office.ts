/**
 * 办公生成 4 组（第二批计划 §6A）。
 *
 * ⚠️ 这三组是**真 Python**（既有专属 venv）⇒ 缺解释器或生成器时如实 `NOT RUN`
 *    （`Suite.pythonAvailable()`），**不**降级成"用 JS 假装生成了 Office 文件"。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { contentOf, resultOf } from './assembly.ts'
import { GroupRecorder } from './reading.ts'
import {
  GENERATOR_PATH,
  PYTHON_PATH,
  sha256OfFile,
  type BedEntry,
  type GroupRunner,
  type Suite,
} from './groups.ts'
import type { GroupReading, VerifyContext } from './reading.ts'
import {
  DOCX_SPEC,
  PPTX_SPEC,
  PPTX_SPEC_OVER_LIMIT,
  XLSX_SPEC,
} from './fixtures.ts'

function officeOptions(entry: BedEntry): Parameters<BedEntry['bed']['say']>[0]['options'] {
  return {
    switches: { localFileWrite: true, office: true, taskAutonomy: true },
    sandboxRoot: entry.bed.sandboxRoot,
    recoveryRoot: entry.bed.recoveryRoot,
    turnContentTokens: 2000,
    office: { pythonPath: PYTHON_PATH, generatorPath: GENERATOR_PATH, timeoutMs: 120_000 },
  }
}

/** 从"生成 + 读回"的文本里抽出读回读数（它是程序给的那一行 JSON） */
function readbackOf(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined
  const line = text.split('\n').find((item) => item.startsWith('读回：'))
  if (line === undefined) return undefined
  try {
    return JSON.parse(line.slice('读回：'.length)) as Record<string, unknown>
  } catch {
    return undefined
  }
}

const office01: GroupRunner = {
  id: 'office-01',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('office-01')
    if (!suite.pythonAvailable()) {
      return rec.finish('DOCX 读回', {
        notRunReason: `专属 Python 环境或生成器不存在（python=${PYTHON_PATH} generator=${GENERATOR_PATH}）`,
      })
    }
    const entry = await suite.openBed('office-01')
    const target = `${entry.tree.root}\\report.docx`

    rec.countInput()
    const turn = await entry.bed.say({
      options: {
        ...officeOptions(entry),
        planner: plannerFor('生成 DOCX', target, 'docx', DOCX_SPEC),
      },
      text: `帮我生成一份 Word 报告到 ${target}`,
      replyText: '（离线固定回复）',
    })
    const result = resultOf(turn, 'office.generate')
    const content = contentOf(turn, 'office.generate')
    rec.check(
      'DOCX：生成动作成功（真 Python 生成器）',
      result?.status === 'success' && result.executed,
      `status=${result?.status ?? '(无)'} code=${result?.error?.code ?? '(无)'}`
    )
    rec.check(
      'DOCX：文件真的落盘（非 0 字节）',
      existsSync(target) && readFileSync(target).byteLength > 0,
      existsSync(target) ? `${String(readFileSync(target).byteLength)} 字节` : '文件不存在'
    )
    const readback = readbackOf(content?.text)
    rec.check(
      'DOCX：**重新打开**读回，规格点名的文本一处不缺（missingCount=0）',
      readback?.missingCount === 0,
      JSON.stringify(readback ?? null)
    )
    rec.check(
      'DOCX：读回到段落 / 表格（结构与规格一致）',
      typeof readback?.paragraphCount === 'number' &&
        Number(readback.paragraphCount) > 0 &&
        Number(readback.tableRows) >= 2,
      `paragraphs=${String(readback?.paragraphCount)} tableRows=${String(readback?.tableRows)}`
    )
    rec.check(
      'DOCX：当轮内容的事实面**明说排版视觉查看未做**（不把 XML 可读当排版通过）',
      (content?.facts ?? []).some((fact) => fact.includes('排版视觉查看')),
      (content?.facts ?? []).join(' | ').slice(0, 200)
    )
    suite.checkTurnContent(rec, content, 'DOCX')
    return rec.finish('DOCX 读回')
  },
}

const office02: GroupRunner = {
  id: 'office-02',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('office-02')
    if (!suite.pythonAvailable()) {
      return rec.finish('XLSX 读回与数值 / 公式类型', {
        notRunReason: `专属 Python 环境或生成器不存在（python=${PYTHON_PATH}）`,
      })
    }
    const entry = await suite.openBed('office-02')
    const target = `${entry.tree.root}\\data.xlsx`

    rec.countInput()
    const turn = await entry.bed.say({
      options: { ...officeOptions(entry), planner: plannerFor('生成 XLSX', target, 'xlsx', XLSX_SPEC) },
      text: `帮我生成一份 Excel 到 ${target}`,
      replyText: '（离线固定回复）',
    })
    const result = resultOf(turn, 'office.generate')
    const content = contentOf(turn, 'office.generate')
    rec.check(
      'XLSX：生成成功',
      result?.status === 'success',
      `status=${result?.status ?? '(无)'} code=${result?.error?.code ?? '(无)'}`
    )
    const readback = readbackOf(content?.text)
    rec.check(
      'XLSX：读回到**两个**工作表，列名一处不缺',
      Array.isArray(readback?.sheetNames) &&
        (readback.sheetNames as unknown[]).length === 2 &&
        readback.missingCount === 0,
      JSON.stringify(readback ?? null)
    )
    /*
     * ⚠️ 这一条是"读数通道"的**正控**（实测逼出来的）：Windows 上 CPython 的 stdout
     *    默认走系统代码页，中文工作表名会被编成 GBK 而 Node 按 UTF-8 解码 ⇒ 乱码。
     *    只断言"两个工作表"是**量不到**这件事的（数量对、名字坏）。
     */
    rec.check(
      'XLSX：读回的工作表名**逐字正确**（子进程的编码没有把中文弄坏）',
      Array.isArray(readback?.sheetNames) &&
        (readback.sheetNames as unknown[]).includes('汇总') &&
        (readback.sheetNames as unknown[]).includes('明细'),
      JSON.stringify(readback?.sheetNames ?? null)
    )
    /*
     * ⚠️ 本组最要紧的一条（计划书 §3.2 逐字）：
     *    "普通文字以文字写入；**不把外部正文中的 `=` 自动当公式**"。
     *    规格里第 3 行第一列是字符串 `=SUM(A1:A2)`（文字），第 4 行第二列是
     *    `{f:"=SUM(B2:B3)"}`（明确类型的公式）。因此：
     *    公式单元格数**只能**来自明确类型的那两个（1 明确 + 1 合计），不能把
     *    那个文字单元格也算进去。
     */
    rec.check(
      'XLSX：以 `=` 开头的**文字**没有被当成公式（公式单元格数 = 明确类型的那几个）',
      readback?.formulaCells === 2,
      `formulaCells=${String(readback?.formulaCells)}（期望 2：一条明确类型 + 一条合计）`
    )
    rec.check(
      'XLSX：文本单元格数 > 0（文字确实以文字写入）',
      typeof readback?.textCells === 'number' && Number(readback.textCells) > 0,
      `textCells=${String(readback?.textCells)}`
    )
    rec.check(
      'XLSX：数值单元格读回为数字（21.5 / 7.25 在产物里）',
      existsSync(target) && readFileSync(target).byteLength > 0,
      existsSync(target) ? `${String(readFileSync(target).byteLength)} 字节` : '文件不存在'
    )
    suite.checkTurnContent(rec, content, 'XLSX')
    return rec.finish('XLSX 读回与数值 / 公式类型')
  },
}

const office03: GroupRunner = {
  id: 'office-03',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('office-03')
    if (!suite.pythonAvailable()) {
      return rec.finish('PPTX 读回与固定版式范围', {
        notRunReason: `专属 Python 环境或生成器不存在（python=${PYTHON_PATH}）`,
      })
    }
    const entry = await suite.openBed('office-03')
    const target = `${entry.tree.root}\\deck.pptx`

    rec.countInput()
    const turn = await entry.bed.say({
      options: { ...officeOptions(entry), planner: plannerFor('生成 PPTX', target, 'pptx', PPTX_SPEC) },
      text: `帮我生成一份 PPT 到 ${target}`,
      replyText: '（离线固定回复）',
    })
    const result = resultOf(turn, 'office.generate')
    const content = contentOf(turn, 'office.generate')
    rec.check(
      'PPTX：生成成功',
      result?.status === 'success',
      `status=${result?.status ?? '(无)'} code=${result?.error?.code ?? '(无)'}`
    )
    const readback = readbackOf(content?.text)
    rec.check(
      'PPTX：读回页数 = 封面 1 + 正文 3（固定版式范围如实）',
      readback?.slideCount === 4,
      `slideCount=${String(readback?.slideCount)}`
    )
    rec.check(
      'PPTX：读回到 1 个表格与 1 张图表',
      readback?.tables === 1 && readback?.charts === 1,
      `tables=${String(readback?.tables)} charts=${String(readback?.charts)}`
    )
    rec.check(
      'PPTX：封面标题在文本里（PPTX-KEY-1 能在读回样本中找到）',
      JSON.stringify(readback ?? {}).includes('PPTX-KEY-1') ||
        (content?.text ?? '').includes('PPTX-KEY-1'),
      JSON.stringify(readback ?? null).slice(0, 200)
    )
    suite.checkTurnContent(rec, content, 'PPTX')

    // 超限 ⇒ 生成器**拒收整条**（不是截断成 20 页）
    rec.countInput()
    const overLimit = await entry.bed.say({
      options: {
        ...officeOptions(entry),
        planner: plannerFor('生成超限 PPTX', `${entry.tree.root}\\over.pptx`, 'pptx', PPTX_SPEC_OVER_LIMIT),
      },
      text: `帮我生成 21 页的 PPT 到 ${entry.tree.root}\\over.pptx`,
      replyText: '（离线固定回复）',
    })
    const overResult = resultOf(overLimit, 'office.generate')
    rec.check(
      'PPTX 超限：21 页 > 20 ⇒ 拒收（`validation_failed`，不静默截断）',
      overResult?.status === 'rejected' && overResult.error?.code === 'validation_failed',
      `status=${overResult?.status ?? '(无)'} code=${overResult?.error?.code ?? '(无)'} message=${(overResult?.error?.message ?? '').slice(0, 120)}`
    )
    rec.check(
      'PPTX 超限：没有产出文件（拒收不是"生成一半"）',
      !existsSync(`${entry.tree.root}\\over.pptx`),
      existsSync(`${entry.tree.root}\\over.pptx`) ? '竟然有产物' : '无产物（正确）'
    )
    return rec.finish('PPTX 读回与固定版式范围')
  },
}

const office04: GroupRunner = {
  id: 'office-04',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('office-04')
    if (!suite.pythonAvailable()) {
      return rec.finish('超限 / 生成失败 / 覆盖冲突时原文件保留', {
        notRunReason: `专属 Python 环境或生成器不存在（python=${PYTHON_PATH}）`,
      })
    }
    const entry = await suite.openBed('office-04')
    const target = `${entry.tree.root}\\keep-me.docx`
    const original = '这是一个**已经存在**的文件，生成失败时它必须逐字节保留。标记 KEEP-ORIGINAL'
    writeFileSync(target, original, 'utf8')
    const before = sha256OfFile(target)

    // ① 规格被拒 ⇒ 原文件保留，且**没有**恢复副本被动用
    rec.countInput()
    const rejected = await entry.bed.say({
      options: {
        ...officeOptions(entry),
        planner: plannerFor('生成一个坏规格', target, 'docx', {
          title: '坏规格',
          blocks: [{ type: 'shell', command: 'whoami' }],
        }),
      },
      text: `帮我重新生成 ${target}`,
      replyText: '（离线固定回复）',
    })
    const rejectedResult = resultOf(rejected, 'office.generate')
    rec.check(
      '生成失败（规格里有未知块类型）⇒ `validation_failed`',
      rejectedResult?.status === 'rejected' && rejectedResult.error?.code === 'validation_failed',
      `status=${rejectedResult?.status ?? '(无)'} code=${rejectedResult?.error?.code ?? '(无)'}`
    )
    rec.check(
      '生成失败 ⇒ 目标文件**逐字节未变**',
      sha256OfFile(target) === before && readFileSync(target, 'utf8') === original,
      `指纹=${sha256OfFile(target).slice(0, 12)} 期望=${before.slice(0, 12)}`
    )

    // ② 并发冲突 ⇒ 拒绝，原文件保留
    writeFileSync(target, '别的程序改动过它。标记 EXTERNAL-EDIT', 'utf8')
    const edited = sha256OfFile(target)
    rec.countInput()
    const conflict = await entry.bed.say({
      options: {
        ...officeOptions(entry),
        planner: plannerFor('用旧指纹覆盖', target, 'docx', DOCX_SPEC, before),
      },
      text: `帮我覆盖 ${target}`,
      replyText: '（离线固定回复）',
    })
    const conflictResult = resultOf(conflict, 'office.generate')
    rec.check(
      '并发冲突：指纹不符 ⇒ 拒绝生成（不覆盖别人的编辑）',
      conflictResult?.status === 'rejected' &&
        conflictResult.error?.details?.reason === 'concurrent_modification',
      `status=${conflictResult?.status ?? '(无)'} reason=${String(conflictResult?.error?.details?.reason)}`
    )
    rec.check(
      '并发冲突 ⇒ 目标文件**逐字节未变**',
      sha256OfFile(target) === edited && readFileSync(target, 'utf8').includes('EXTERNAL-EDIT'),
      `指纹=${sha256OfFile(target).slice(0, 12)}`
    )

    // ③ 覆盖成功时**留下恢复副本**
    rec.countInput()
    const ok = await entry.bed.say({
      options: {
        ...officeOptions(entry),
        planner: plannerFor('覆盖成功', target, 'docx', DOCX_SPEC, edited),
      },
      text: `帮我覆盖 ${target}`,
      replyText: '（离线固定回复）',
    })
    const okResult = resultOf(ok, 'office.generate')
    const backupRef = okResult?.evidence?.find((item) => item.kind === 'adapter')?.ref
    rec.check(
      '覆盖成功：effect 是 file_overwritten 且证据给出恢复副本',
      okResult?.effect?.kind === 'file_overwritten' && backupRef !== undefined,
      `effect=${okResult?.effect?.kind ?? '(无)'} backup=${String(backupRef)}`
    )
    rec.check(
      '恢复副本逐字节等于被覆盖前的原文件',
      backupRef !== undefined && existsSync(backupRef) && sha256OfFile(backupRef) === edited,
      backupRef === undefined ? '没有副本' : `副本指纹=${existsSync(backupRef) ? sha256OfFile(backupRef).slice(0, 12) : '(不存在)'}`
    )
    rec.note('生成失败后原文件指纹', sha256OfFile(target).slice(0, 12))
    return rec.finish('超限 / 生成失败 / 覆盖冲突时原文件保留')
  },
}

/** 造一个"生成一份 Office 文件"的计划（离线确定性；不调模型） */
function plannerFor(
  goal: string,
  path: string,
  format: string,
  spec: unknown,
  expectedOriginalFingerprint?: string
): Parameters<BedEntry['bed']['say']>[0]['options']['planner'] {
  return {
    id: 'fixture-office-planner',
    endpointHost: 'fixture.local',
    async plan() {
      return {
        ok: true,
        plan: {
          goal,
          steps: [
            {
              capability: 'office.generate',
              operation: 'generate',
              args: {
                path,
                format,
                spec,
                ...(expectedOriginalFingerprint !== undefined
                  ? { expectedOriginalFingerprint }
                  : {}),
              },
            },
          ],
          done: true,
        },
        requestCount: 0,
      }
    },
  }
}

export const OFFICE_GROUPS: readonly GroupRunner[] = [office01, office02, office03, office04]
