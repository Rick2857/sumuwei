/**
 * 文件 / 任务 4 组（第二批计划 §6A 的表格逐字）。
 *
 * ```text
 * ① 沙箱外中文/空格/多卷路径读取和正文入模
 * ② 自主选输入及创建/修改/覆盖
 * ③ 恢复副本与并发修改冲突
 * ④ OS 访问失败 / 任务取消 / 无授权任务不写
 * ```
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import {
  LOCAL_FILE_SCOPE_WORDING,
  contentOf,
  resultOf,
  scriptedPlanner,
  summarizeActions,
  unresolvedInvocation,
} from './assembly.ts'
import { GroupRecorder } from './reading.ts'
import {
  sha256OfFile,
  type BedEntry,
  type GroupRunner,
  type Suite,
} from './groups.ts'
import type { GroupReading, VerifyContext } from './reading.ts'
import { expectedOf } from './fixtures.ts'

function readOptions(entry: BedEntry): Parameters<BedEntry['bed']['say']>[0]['options'] {
  return {
    switches: { localFileRead: true },
    sandboxRoot: entry.bed.sandboxRoot,
    recoveryRoot: entry.bed.recoveryRoot,
    turnContentTokens: 2000,
  }
}

// ---------------------------------------------------------------------------
// file-01 沙箱外中文 / 空格 / 多卷路径读取与正文入模
// ---------------------------------------------------------------------------

const file01: GroupRunner = {
  id: 'file-01',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('file-01')
    const entry = await suite.openBed('file-01')

    /*
     * 逐条参数化输入：中文名 / 带空格名 / csv / json（多卷镜像）——
     * 每一条都有**独立撰写**的期望值（`fixtures.ts` 的 `expectedContains`）。
     *
     * ⚠️ 带空格的路径用**引号**给出：单动作路径的触发边界（`local-file-intent.ts`
     *    的文件头）要求"引号或不含空格"，因为**空格让边界没有确定答案**。
     *    下面还会专门测一次"不带引号的空格路径"——它必须**不成功**，
     *    否则就是"猜了一个边界然后把另一个位置的文件读了"。
     */
    const targets: { text: string; name: string; label: string }[] = [
      { text: `读一下 ${entry.tree.root}\\notes-cn.txt`, name: 'notes-cn.txt', label: '中文名（主卷）' },
      { text: `读一下 "${entry.tree.root}\\a b c.md"`, name: 'a b c.md', label: '名字里带空格（引号）' },
      { text: `读一下 ${entry.tree.root}\\data.csv`, name: 'data.csv', label: 'CSV' },
      { text: `读一下 ${entry.tree.root}\\config.json`, name: 'config.json', label: 'JSON' },
      { text: `读一下 ${entry.tree.secondaryRoot}\\notes-cn.txt`, name: 'notes-cn.txt', label: '多卷（第二个根）' },
      { text: `读一下 "${entry.tree.secondaryRoot}\\a b c.md"`, name: 'a b c.md', label: '多卷 + 空格（引号）' },
    ]

    for (const target of targets) {
      rec.countInput()
      const reading = await entry.bed.say({
        options: readOptions(entry),
        text: target.text,
        replyText: '（离线固定回复）',
      })
      const result = resultOf(reading, 'local.file.read')
      const content = contentOf(reading, 'local.file.read')
      const expected = expectedOf(target.name)
      rec.check(
        `${target.label}：读取成功（exact 目标 + 真适配器）`,
        result !== undefined && result.status === 'success' && result.executed,
        `status=${result?.status ?? '(没有动作)'} code=${result?.error?.code ?? '(无)'}`
      )
      rec.check(
        `${target.label}：正文含**独立期望值** ${expected.join(' / ')}`,
        content !== undefined && expected.every((needle) => content.text.includes(needle)),
        `期望=${expected.join(',')} 命中=${String(
          content !== undefined && expected.every((needle) => content.text.includes(needle))
        )}`
      )
      suite.checkTurnContent(rec, content, target.label)
      rec.check(
        `${target.label}：来源类别是"本机文件（全盘域）"，不是"沙箱内文件"`,
        content?.sourceKind === 'local-disk',
        `sourceKind=${String(content?.sourceKind)}`
      )
      rec.check(
        `${target.label}：正文进了 packet 的 turn-content section`,
        reading.sectionIds.includes('turn-content') &&
          reading.sectionOf('turn-content').includes(expected[0]!),
        `sections=${reading.sectionIds.join(',')}`
      )
    }

    /*
     * **触发边界**（如实的首版范围，不是缺陷）：不带引号的空格路径
     * ⇒ 边界没有确定答案 ⇒ 必须**不成功**，而且**不能**把 `...\a`（截断后的另一个位置）
     * 当成目标读出一个成功。
     */
    rec.countInput()
    const unquotedSpace = await entry.bed.say({
      options: readOptions(entry),
      text: `读一下 ${entry.tree.root}\\a b c.md`,
      replyText: '（离线固定回复）',
    })
    const unquotedResult = resultOf(unquotedSpace, 'local.file.read')
    rec.check(
      '触发边界：不带引号的空格路径 ⇒ **不成功**（不猜边界、不读另一个位置）',
      unquotedResult?.status !== 'success' && contentOf(unquotedSpace, 'local.file.read') === undefined,
      `status=${unquotedResult?.status ?? '(没有动作)'}`
    )

    /*
     * 空格路径**在任务环里**（结构化 JSON，没有边界歧义）⇒ 必须真的读得到。
     * 这一条与上面的"不成功"合起来才是完整的：能力**支持**空格，
     * 而单动作入口对无引号的空格**不猜**。
     */
    rec.countInput()
    const viaTask = await entry.bed.say({
      options: {
        switches: { localFileRead: true, taskAutonomy: true },
        sandboxRoot: entry.bed.sandboxRoot,
        recoveryRoot: entry.bed.recoveryRoot,
        turnContentTokens: 2000,
        planner: {
          id: 'fixture-space-planner',
          endpointHost: 'fixture.local',
          async plan() {
            return {
              ok: true as const,
              plan: {
                goal: '读一个带空格的文件',
                steps: [
                  {
                    capability: 'local.file.read',
                    operation: 'read',
                    args: { path: `${entry.tree.root}\\a b c.md` },
                  },
                ],
                done: true,
              },
              requestCount: 0,
            }
          },
        },
      },
      text: `帮我读一下 ${entry.tree.root}\\a b c.md 的内容`,
      replyText: '（离线固定回复）',
    })
    const viaTaskContent = contentOf(viaTask, 'local.file.read')
    rec.check(
      '空格路径在**任务环**里读得到（结构化路径没有边界歧义）',
      viaTaskContent !== undefined && viaTaskContent.text.includes('空格路径可达'),
      `status=${resultOf(viaTask, 'local.file.read')?.status ?? '(没有动作)'}`
    )

    // 二进制伪装：`.txt` 里装的是 PNG —— 判据必须是**字节**，不是扩展名
    rec.countInput()
    const disguised = await entry.bed.say({
      options: readOptions(entry),
      text: `读一下 ${entry.tree.root}\\disguised.txt`,
      replyText: '（离线固定回复）',
    })
    const disguisedResult = resultOf(disguised, 'local.file.read')
    rec.check(
      '伪装格式：二进制内容的 .txt ⇒ `unsupported`（不硬转、不产生乱码正文）',
      disguisedResult?.status === 'rejected' && disguisedResult.error?.code === 'unsupported',
      `status=${disguisedResult?.status ?? '(无)'} code=${disguisedResult?.error?.code ?? '(无)'}`
    )

    // 目录：用 read 读一个目录 ⇒ 明确说"是目录，不是文件"（指路到 list）
    rec.countInput()
    const asFile = await entry.bed.say({
      options: readOptions(entry),
      text: `读一下 ${entry.tree.root}`,
      replyText: '（离线固定回复）',
    })
    const asFileResult = resultOf(asFile, 'local.file.read')
    rec.check(
      '目录用读入口 ⇒ not_found 且话术指路（不是"读取失败"）',
      asFileResult?.status === 'not_found' &&
        (asFileResult.error?.message ?? '').includes('目录'),
      `message=${asFileResult?.error?.message ?? '(无)'}`
    )

    rec.note('读取的路径条数', targets.length)
    rec.note('摘要', summarizeActions(disguised))
    return rec.finish('沙箱外中文 / 空格 / 多卷路径读取与正文入模')
  },
}

// ---------------------------------------------------------------------------
// file-02 自主选输入及创建 / 修改 / 覆盖
// ---------------------------------------------------------------------------

const file02: GroupRunner = {
  id: 'file-02',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('file-02')
    const entry = await suite.openBed('file-02')
    const inputPath = `${entry.tree.root}\\notes-cn.txt`
    const outputPath = `${entry.tree.root}\\output-created.txt`

    /*
     * 一个用户目标 → 自主读输入、写产物：
     * ```text
     * 第 1 步  local.file.read   inputPath
     * 第 2 步  local.file.write  outputPath（新建）
     * ```
     * ⚠️ 用户原话里**没有**出现 outputPath 的完整指令序列 —— 这正是
     *    "程序依据已授予的任务授权执行，不要求用户把每一步改写为新指令"。
     */
    rec.countInput()
    const created = await entry.bed.say({
      options: {
        switches: { localFileRead: true, localFileWrite: true, taskAutonomy: true },
        sandboxRoot: entry.bed.sandboxRoot,
        recoveryRoot: entry.bed.recoveryRoot,
        planner: scriptedPlanner([
          {
            goal: '读输入并写出第一版',
            steps: [
              { capability: 'local.file.read', operation: 'read', args: { path: inputPath } },
              {
                capability: 'local.file.write',
                operation: 'write',
                args: { path: outputPath, content: '第一版：来自 notes-cn.txt 的摘要\n标记 OUT-V1' },
              },
            ],
            done: true,
          },
        ]),
      },
      text: `帮我根据 ${inputPath} 写一份摘要到 ${outputPath}`,
      replyText: '（离线固定回复）',
    })
    const createdResult = resultOf(created, 'local.file.write')
    rec.check(
      '任务环：一个用户目标里自主完成了"读 → 写"两步',
      created.actionResults.filter((item) => item.result !== undefined).length === 2,
      `执行了 ${String(created.actionResults.length)} 步`
    )
    rec.check(
      '新建：文件真的落盘且 effect 是 file_created',
      existsSync(outputPath) &&
        createdResult?.effect?.kind === 'file_created' &&
        readFileSync(outputPath, 'utf8').includes('OUT-V1'),
      `effect=${createdResult?.effect?.kind ?? '(无)'}`
    )
    const v1Fingerprint = sha256OfFile(outputPath)

    // 修改 / 覆盖：带"读到的原指纹" → 允许覆盖，且 effect 是 file_overwritten
    rec.countInput()
    const overwritten = await entry.bed.say({
      options: {
        switches: { localFileWrite: true, taskAutonomy: true },
        sandboxRoot: entry.bed.sandboxRoot,
        recoveryRoot: entry.bed.recoveryRoot,
        planner: scriptedPlanner([
          {
            goal: '覆盖成第二版',
            steps: [
              {
                capability: 'local.file.write',
                operation: 'write',
                args: {
                  path: outputPath,
                  content: '第二版：覆盖后的内容\n标记 OUT-V2',
                  expectedOriginalFingerprint: v1Fingerprint,
                },
              },
            ],
            done: true,
          },
        ]),
      },
      text: `把 ${outputPath} 改成第二版`,
      replyText: '（离线固定回复）',
    })
    const overwriteResult = resultOf(overwritten, 'local.file.write')
    rec.check(
      '覆盖：指纹相符 ⇒ 真的覆盖（effect=file_overwritten）',
      overwriteResult?.effect?.kind === 'file_overwritten' &&
        readFileSync(outputPath, 'utf8').includes('OUT-V2'),
      `effect=${overwriteResult?.effect?.kind ?? '(无)'} status=${overwriteResult?.status ?? '(无)'}`
    )
    rec.check(
      '覆盖后原内容被替换（不是追加）',
      !readFileSync(outputPath, 'utf8').includes('OUT-V1'),
      '文件里仍有第一版内容'
    )

    // 账本与文件对照：账本行的效果指纹 == 真实文件指纹
    const rows = await entry.bed.actionRows()
    const writeRows = rows.filter((row) => row.capability === 'local.file.write')
    const finalFingerprint = sha256OfFile(outputPath)
    rec.countInput()
    rec.check(
      '账本与文件对照：写动作在账本里有行（可查）',
      writeRows.length >= 2,
      `账本里 ${String(writeRows.length)} 行写动作`
    )
    rec.check(
      '账本里**没有**正文（只有引用与指纹）',
      !JSON.stringify(rows).includes('OUT-V2') && !JSON.stringify(rows).includes('OUT-V1'),
      '账本里出现了写入正文'
    )
    rec.check(
      '落盘结果指纹与最后一次写入一致（提交后核对）',
      writeRows.length > 0 &&
        // `listRecords` 按 created_at desc 排序 ⇒ [0] 才是**最新**那一次写入
        writeRows[0]!.effect?.fingerprint === finalFingerprint,
      `账本指纹=${String(writeRows[0]?.effect?.fingerprint).slice(0, 12)} 文件指纹=${finalFingerprint.slice(0, 12)}`
    )

    rec.note('第一版指纹', v1Fingerprint.slice(0, 12))
    rec.note('最终指纹', finalFingerprint.slice(0, 12))
    rec.note('写动作账本行数', writeRows.length)
    return rec.finish('自主选输入及创建 / 修改 / 覆盖')
  },
}

// ---------------------------------------------------------------------------
// file-03 恢复副本与并发修改冲突
// ---------------------------------------------------------------------------

const file03: GroupRunner = {
  id: 'file-03',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('file-03')
    const entry = await suite.openBed('file-03')
    const path = `${entry.tree.root}\\recover-me.txt`
    const original = '原始内容：这一行必须在恢复副本里逐字节出现。标记 ORIGINAL-KEEP'
    writeFileSync(path, original, 'utf8')
    const originalFingerprint = sha256OfFile(path)

    // ① 覆盖 ⇒ 恢复副本逐字节等于原文件
    rec.countInput()
    const first = await entry.bed.say({
      options: {
        switches: { localFileWrite: true, taskAutonomy: true },
        sandboxRoot: entry.bed.sandboxRoot,
        recoveryRoot: entry.bed.recoveryRoot,
        planner: scriptedPlanner([
          {
            goal: '覆盖一次，留下恢复副本',
            steps: [
              {
                capability: 'local.file.write',
                operation: 'write',
                args: {
                  path,
                  content: '新内容：覆盖之后的样子。标记 NEW-V1',
                  expectedOriginalFingerprint: originalFingerprint,
                },
              },
            ],
            done: true,
          },
        ]),
      },
      text: `把 ${path} 覆盖成新内容`,
      replyText: '（离线固定回复）',
    })
    const writeResult = resultOf(first, 'local.file.write')
    const backupRef = writeResult?.evidence?.find((item) => item.kind === 'adapter')?.ref
    rec.check(
      '覆盖成功，且证据里给出了**恢复副本**的位置',
      writeResult?.status === 'success' && backupRef !== undefined,
      `status=${writeResult?.status ?? '(无)'} backup=${String(backupRef)}`
    )
    rec.check(
      '恢复副本存在，且**逐字节等于**覆盖前的原文件',
      backupRef !== undefined &&
        existsSync(backupRef) &&
        readFileSync(backupRef, 'utf8') === original &&
        sha256OfFile(backupRef) === originalFingerprint,
      backupRef === undefined ? '没有副本引用' : `副本指纹=${existsSync(backupRef) ? sha256OfFile(backupRef).slice(0, 12) : '(不存在)'}`
    )
    rec.check(
      '覆盖后目标文件是新内容',
      readFileSync(path, 'utf8').startsWith('新内容'),
      '目标文件不是新内容'
    )

    // ② 并发修改：外部程序改动文件后，用**旧的**原指纹再覆盖 ⇒ 拒绝，文件不动
    const afterFirst = sha256OfFile(path)
    writeFileSync(path, '别的程序写进去的内容。标记 EXTERNAL-EDIT', 'utf8')
    const externallyEdited = sha256OfFile(path)
    rec.countInput()
    const conflict = await entry.bed.say({
      options: {
        switches: { localFileWrite: true, taskAutonomy: true },
        sandboxRoot: entry.bed.sandboxRoot,
        recoveryRoot: entry.bed.recoveryRoot,
        planner: scriptedPlanner([
          {
            goal: '用旧指纹覆盖',
            steps: [
              {
                capability: 'local.file.write',
                operation: 'write',
                args: {
                  path,
                  content: '试图用旧内容覆盖新编辑',
                  expectedOriginalFingerprint: afterFirst,
                },
              },
            ],
            done: true,
          },
        ]),
      },
      text: `再覆盖一次 ${path}`,
      replyText: '（离线固定回复）',
    })
    const conflictResult = resultOf(conflict, 'local.file.write')
    rec.check(
      '并发修改：指纹不符 ⇒ 拒绝写入（`validation_failed` + concurrent_modification）',
      conflictResult?.status === 'rejected' &&
        conflictResult.error?.code === 'validation_failed' &&
        conflictResult.error.details?.reason === 'concurrent_modification',
      `status=${conflictResult?.status ?? '(无)'} code=${conflictResult?.error?.code ?? '(无)'} reason=${String(conflictResult?.error?.details?.reason)}`
    )
    rec.check(
      '并发修改：原文件**逐字节未变**（不能用旧内容覆盖新编辑）',
      sha256OfFile(path) === externallyEdited &&
        readFileSync(path, 'utf8').includes('EXTERNAL-EDIT'),
      `指纹=${sha256OfFile(path).slice(0, 12)} 期望=${externallyEdited.slice(0, 12)}`
    )

    rec.note('恢复副本', backupRef ?? null)
    rec.note('冲突拒绝码', conflictResult?.error?.code ?? null)
    return rec.finish('恢复副本与并发修改冲突')
  },
}

// ---------------------------------------------------------------------------
// file-04 OS 访问失败 / 任务取消 / 无授权任务不写
// ---------------------------------------------------------------------------

const file04: GroupRunner = {
  id: 'file-04',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('file-04')
    const entry = await suite.openBed('file-04')

    // ① 不存在的文件 ⇒ target_not_found（不是"读取失败"）
    rec.countInput()
    const missing = await entry.bed.say({
      options: readOptions(entry),
      text: `读一下 ${entry.tree.root}\\does-not-exist-9f3a.txt`,
      replyText: '（离线固定回复）',
    })
    const missingResult = resultOf(missing, 'local.file.read')
    rec.check(
      'OS 失败①：文件不存在 ⇒ `target_not_found`（与"读取失败"分得开）',
      missingResult?.status === 'not_found' && missingResult.error?.code === 'target_not_found',
      `status=${missingResult?.status ?? '(无)'} code=${missingResult?.error?.code ?? '(无)'}`
    )

    // ② 网络共享 / 设备路径 ⇒ 域外 ⇒ permission_denied
    for (const [label, bad] of [
      ['网络共享', '\\\\server\\share\\a.txt'],
      ['设备命名空间', '\\\\.\\PHYSICALDRIVE0'],
    ] as const) {
      rec.countInput()
      const turn = await entry.bed.say({
        options: readOptions(entry),
        text: `读一下 ${bad}`,
        replyText: '（离线固定回复）',
      })
      const result = resultOf(turn, 'local.file.read')
      rec.check(
        `OS 失败②：${label} ⇒ permission_denied（域外，未触碰文件系统）`,
        result?.status === 'rejected' && result.error?.code === 'permission_denied',
        `status=${result?.status ?? '(无)'} code=${result?.error?.code ?? '(无)'}`
      )
    }

    // ③ 无授权的任务不写：任务环开着但**权限不授予** ⇒ 一步都不执行
    const noPermTarget = `${entry.tree.root}\\no-permission.txt`
    rec.countInput()
    const noPermission = await entry.bed.say({
      options: {
        switches: { localFileWrite: true, taskAutonomy: true },
        grantPermissions: false,
        sandboxRoot: entry.bed.sandboxRoot,
        recoveryRoot: entry.bed.recoveryRoot,
        planner: scriptedPlanner([
          {
            goal: '写一份',
            steps: [
              {
                capability: 'local.file.write',
                operation: 'write',
                args: { path: noPermTarget, content: '不该写下去的内容' },
              },
            ],
            done: true,
          },
        ]),
      },
      text: `帮我写一份到 ${noPermTarget}`,
      replyText: '（离线固定回复）',
    })
    rec.check(
      '无授权：**没有任何成功写入**（授权集合为空 ⇒ 不签发任务环；即使产生请求也必须是拒绝）',
      noPermission.actionResults.every(
        (item) => item.result === undefined || item.result.status !== 'success'
      ),
      `动作数=${String(noPermission.actionResults.length)} · 状态=${noPermission.actionResults
        .map((item) => String(item.result?.status ?? '(未执行)'))
        .join(',')}`
    )
    rec.check(
      '无授权：目标文件**没有被创建**（0 字节写入）',
      !existsSync(noPermTarget),
      existsSync(noPermTarget) ? '文件竟然被创建了' : '不存在（正确）'
    )

    // ④ 任务被取消 ⇒ 后续轮次不再执行
    rec.countInput()
    const cancelled = await entry.bed.say({
      options: {
        switches: { localFileWrite: true, taskAutonomy: true },
        sandboxRoot: entry.bed.sandboxRoot,
        recoveryRoot: entry.bed.recoveryRoot,
        taskMaxActions: 1,
        taskMaxPlans: 1,
        planner: scriptedPlanner([
          {
            goal: '写一份但计划未完成',
            steps: [
              {
                capability: 'local.file.write',
                operation: 'write',
                args: { path: `${entry.tree.root}\\cancelled-1.txt`, content: '第一份' },
              },
            ],
            done: false,
          },
        ]),
      },
      text: `帮我写一份到 ${entry.tree.root}\\cancelled-1.txt`,
      replyText: '（离线固定回复）',
    })
    rec.check(
      '预算用尽后任务**如实停止**（不再有第二个动作）',
      cancelled.actionResults.filter((item) => item.result !== undefined).length === 1,
      `动作数=${String(cancelled.actionResults.filter((item) => item.result !== undefined).length)}`
    )
    rec.check(
      '已完成的那个动作**保留**（不因后续停止而撤销）',
      readFileSync(`${entry.tree.root}\\cancelled-1.txt`, 'utf8').includes('第一份'),
      '第一份内容不在文件里'
    )

    rec.note('无授权时的动作数', noPermission.actionResults.length)
    rec.note('取消目标存在', existsSync(noPermTarget))
    void LOCAL_FILE_SCOPE_WORDING
    void unresolvedInvocation
    return rec.finish('OS 访问失败 / 任务取消 / 无授权任务不写')
  },
}

export const FILE_GROUPS: readonly GroupRunner[] = [file01, file02, file03, file04]
