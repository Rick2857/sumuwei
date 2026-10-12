/**
 * `pnpm desktop-control:act` —— **真实操作门**（ADR-106 §4 ⑤）。
 *
 * ============================================================================
 *  它为什么**必须**要用户在场，以及它为什么用一个**自己造的**目标
 * ============================================================================
 * ```text
 * 桌面操作会真的移动用户的鼠标、真的抢焦点。所以：
 * ① 没有 `--i-am-here` ⇒ 本门**拒绝运行**（打印"要发生什么"，退出码 1 = NOT RUN）。
 * ② 目标窗口**由本门自己创建**（`%TEMP%` 里的一个临时 txt + 记事本），
 *    绝不在用户自己的窗口上点/输。跑完把那个进程收掉。
 * ③ 判据是**读回来的值**：输入前记下编辑框的值，输入后再读，
 *    必须看到那段哨兵文本 ⇒ "输入真的落到了控件里"，而不是"调用没报错"。
 * ```
 *
 * ⚠️ 本门**不**在自动回归里（它需要人、需要前台窗口、会动鼠标）。
 * ⚠️ 证据里**只有计数与布尔**：哨兵文本与编辑框内容都不进仓库。
 */

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DESKTOP_INSPECT,
  DESKTOP_INSPECT_OPERATION,
  DESKTOP_OPERATE,
  DESKTOP_OPERATE_OPERATION,
} from '../../src/kernel/action/desktop-capability.ts'
import { createDesktopAdapters } from '../../src/infrastructure/action/adapters/desktop-control.ts'
import {
  DESKTOP_MCP_VERSION,
  verifyDesktopRuntime,
} from '../../src/infrastructure/action/adapters/desktop-control-assets.ts'
import {
  createInMemoryPayloadStaging,
  type PayloadStagingPort,
} from '../../src/kernel/action/payload-staging.ts'
import type { CapabilityAdapter } from '../../src/kernel/action/executor-port.ts'
import { newActionId } from '../../src/kernel/contracts/ids.ts'
import type { DesktopStateTurnContent } from '../../src/kernel/contracts/turn-content.ts'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const EVIDENCE_PARENT = 'artifacts/post-lv2/desktop-control'
const LOCAL_PARENT = 'artifacts/post-lv2/local/desktop-control'

interface Reading {
  id: string
  title: string
  status: 'PASS' | 'FAIL' | 'NOT RUN'
  observed: unknown
}

const cases: Reading[] = []

function record(id: string, title: string, ok: boolean | 'not-run', observed: unknown): void {
  cases.push({ id, title, status: ok === 'not-run' ? 'NOT RUN' : ok ? 'PASS' : 'FAIL', observed })
}

function git(args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function runIdOf(label: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const head = git(['rev-parse', '--short=8', 'HEAD']) || 'unknown'
  const suffix = createHash('sha256')
    .update(`${label}${stamp}${String(process.pid)}`)
    .digest('hex')
    .slice(0, 4)
  return `${label}-${stamp}-${head}-${suffix}`
}

const target = {
  type: 'local_executor',
  canonicalId: 'windows-desktop',
  displayName: '当前用户桌面（UI Automation 读取）',
  confidence: 'exact' as const,
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 把**本门自己造的那个窗口**提到前台（夹具准备，**不经过能力路径**）。
 *
 * ⚠️ 为什么门需要这一步：上游快照只枚举**前台窗口**的可交互元素（实测 2026-10-05：
 *    记事本在前台时有 26 个元素、一失焦就一个都没有），而本机同时还有别的会话在跑东西、
 *    焦点会被抢走。⇒ 门自己负责把自己的夹具摆到前台（**能力侧仍然只认"目标窗口必须在前台"**）。
 */
function activateFixture(title: string): void {
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `(New-Object -ComObject WScript.Shell).AppActivate('${title}') | Out-Null`,
      ],
      { stdio: 'ignore', timeout: 15_000 }
    )
  } catch {
    /* 尽力而为：拿不到前台就由判据如实失败（不伪造） */
  }
}

async function main(): Promise<number> {
  const here = process.argv.includes('--i-am-here')
  const label = process.argv.find((arg) => arg.startsWith('--label='))?.slice('--label='.length) ?? 'act'
  const writeEvidence = process.argv.includes('--evidence')

  if (!here) {
    process.stdout.write(
      '[desktop-control:act] 本门会**真的动你的鼠标键盘**（点一次 / 输一次）。\n' +
        '[desktop-control:act] 目标由本门自己创建（%TEMP% 里的临时 txt + 记事本），跑完收掉。\n' +
        '[desktop-control:act] 要在场并同意时，加 `--i-am-here` 再跑一次：\n' +
        '[desktop-control:act]   pnpm desktop-control:act --i-am-here\n' +
        '[desktop-control:act] 现在**没有**执行任何动作 ⇒ NOT RUN。\n'
    )
    return 1
  }

  const runtime = await verifyDesktopRuntime()
  if (!runtime.ok) {
    process.stdout.write(`[desktop-control:act] 运行时不可用 ⇒ NOT RUN：${runtime.problems.join('；')}\n`)
    return 1
  }

  const runId = runIdOf(label)
  const scratch = join(tmpdir(), `lg-desktop-act-${runId}`)
  mkdirSync(scratch, { recursive: true })
  const fixtureName = `lg-desktop-act-${runId.slice(-4)}.txt`
  const fixturePath = join(scratch, fixtureName)
  const baseline = '基线：这一段是桌面操作门自己写下的初始内容'
  const sentinel = `哨兵-${runId.slice(-4)}-由桌面能力写入`
  writeFileSync(fixturePath, baseline, 'utf8')

  process.stdout.write(`[desktop-control:act] 目标文件 = ${fixturePath}\n`)
  process.stdout.write('[desktop-control:act] 现在会打开记事本，并在它里面**真的**输入一次、点一次\n')

  const notepad = spawn('notepad.exe', [fixturePath], { detached: true, stdio: 'ignore' })
  notepad.unref()
  const notepadPid = notepad.pid

  const staging: PayloadStagingPort = createInMemoryPayloadStaging()
  const adapters = createDesktopAdapters({ staging })
  const inspect = adapters.find((adapter) => adapter.capabilityId === DESKTOP_INSPECT)
  const operate = adapters.find((adapter) => adapter.capabilityId === DESKTOP_OPERATE)
  if (inspect === undefined || operate === undefined) throw new Error('适配器没有建出来')

  const textOf = async (adapter: CapabilityAdapter, args: Record<string, unknown>) => {
    const outcome = await adapter.execute({
      actionId: newActionId(),
      operation: adapter.capabilityId === DESKTOP_INSPECT ? DESKTOP_INSPECT_OPERATION : DESKTOP_OPERATE_OPERATION,
      target,
      args,
      now: () => Date.now() as never,
    })
    const content = outcome.turnContent?.find((item) => item.kind === 'desktop-state') as
      | DesktopStateTurnContent
      | undefined
    return { outcome, text: content?.text ?? '' }
  }

  try {
    /* ① 等这个自造窗口出现，并找到一个**可编辑**控件（带 value 的那种） */
    let editValue = ''
    let editIndex = -1
    let editName = ''
    let found = false
    for (let attempt = 0; attempt < 24; attempt += 1) {
      /*
       * ⚠️ 每一步都先把自己的夹具窗口提到前台 —— 上游快照只枚举**前台窗口**的元素
       *    （实测：记事本在前台时 26 个元素，一失焦一个都没有）。
       */
      activateFixture(fixtureName)
      await sleep(700)
      try {
        const reading = await textOf(inspect, { window: fixtureName })
        const match = /#(\d+) (\S+)「(.*?)」@\d+,\d+｜窗口「.*?」.*?｜值：「(.*)」/.exec(reading.text)
        if (match !== null) {
          found = true
          editIndex = Number(match[1])
          editName = match[3]
          editValue = match[4]
          break
        }
      } catch {
        /* 窗口还没出来 / 过滤不到 / 失焦：继续试（最多 24 轮） */
      }
    }
    record(
      'dc-act-fixture-visible',
      '自造的记事本窗口出现了，而且**读到了编辑控件当前的值**（读回的前提）',
      found,
      { found, attempts: 24, hasValue: editValue.length > 0 }
    )
    if (!found) {
      process.stdout.write('[desktop-control:act] 没有等到可编辑控件 ⇒ 后续判据 NOT RUN\n')
      return finish(false)
    }
    record(
      'dc-act-baseline-value',
      '输入**之前**读到的值就是本门写下的初始内容（⇒ 值不是凭空来的）',
      editValue.includes(baseline.slice(0, 8)),
      { baselineChars: baseline.length, readChars: editValue.length }
    )

    /* 一个"重新摆前排 + 重新读一次编辑控件"的小工具（动作前的引用刷新） */
    const refreshEditTarget = async (): Promise<{ index: number; name: string; text: string } | undefined> => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        activateFixture(fixtureName)
        await sleep(600)
        try {
          const reading = await textOf(inspect, { window: fixtureName })
          const match = /#(\d+) (\S+)「(.*?)」@\d+,\d+｜窗口「.*?」.*?｜值：「(.*)」/.exec(reading.text)
          if (match !== null) {
            return { index: Number(match[1]), name: match[3], text: reading.text }
          }
        } catch {
          /* 失焦 / 还没出来：再试 */
        }
      }
      return undefined
    }

    /* ② 真输入一次（正文经**私有暂存** ⇒ 与生产同一条通道） */
    const staged = staging.put({
      value: { kind: 'text', text: sentinel },
      label: 'desktop-control:act',
      fingerprint: createHash('sha256').update(sentinel).digest('hex'),
      bytes: Buffer.byteLength(sentinel, 'utf8'),
    })
    let typed: Awaited<ReturnType<typeof textOf>> | undefined
    let typeAttempts = 0
    for (; typeAttempts < 3; typeAttempts += 1) {
      const fresh = await refreshEditTarget()
      if (fresh === undefined) continue
      try {
        typed = await textOf(operate, {
          action: 'type',
          window: fixtureName,
          index: fresh.index,
          name: fresh.name,
          payloadRef: staged.payloadRef,
        })
        break
      } catch (error) {
        /* 失焦 / 引用过期：如实记下再试一次（**不**改判据） */
        if (typeAttempts === 2) throw error
      }
    }
    record(
      'dc-act-type-succeeded',
      '`type` 真的执行了（当轮内容里带着"这一次做过的动作"的程序事实）',
      typed !== undefined && (typed.outcome.effect?.detail ?? '').includes('type'),
      { effect: typed?.outcome.effect?.detail, chars: sentinel.length, attempts: typeAttempts + 1 }
    )
    /*
     * 读回**单独再查一次**（并重新把夹具摆到前台）。
     *
     * ⚠️ 为什么不能在同一个 worker 调用里读回就断言：上游快照**只枚举前台窗口**的元素
     *    （实测：记事本在前台时 26 个元素、一失焦一个都没有），而本机同时还有别的会话
     *    在跑东西、焦点会被抢走。⇒ "她做完再看一眼"这件事本来就是**再一次查看**
     *    （与 `browser.operate` 的"引用过期就重新取快照"同一条纪律）。
     */
    let landed = false
    let landedText = ''
    let readbackAttempts = 0
    for (; readbackAttempts < 6; readbackAttempts += 1) {
      activateFixture(fixtureName)
      await sleep(800)
      try {
        const reading = await textOf(inspect, { window: fixtureName })
        landedText = reading.text
        if (reading.text.includes(sentinel)) {
          landed = true
          break
        }
      } catch {
        /* 失焦：再试 */
      }
    }
    record(
      'dc-act-type-readback',
      '**读回**里能看到刚才输入的那段哨兵文本 ⇒ "输入真的落到了控件里"',
      landed,
      { landed, readChars: landedText.length, attempts: readbackAttempts + 1 }
    )

    /* ③ 真点击一次（点在同一个编辑控件上：看得见的最小动作） */
    let clicked: Awaited<ReturnType<typeof textOf>> | undefined
    let clickAttempts = 0
    for (; clickAttempts < 6; clickAttempts += 1) {
      const fresh = await refreshEditTarget()
      if (fresh === undefined) continue
      try {
        clicked = await textOf(operate, {
          action: 'click',
          window: fixtureName,
          index: fresh.index,
          name: fresh.name,
        })
        break
      } catch (error) {
        if (clickAttempts === 5) {
          process.stdout.write(
            `[desktop-control:act] click 尝试 ${String(clickAttempts + 1)} 次未成：${String(
              (error as { failure?: { details?: { workerCode?: unknown } } }).failure?.details?.workerCode ??
                'unknown'
            )}\n`
          )
        }
      }
    }
    record(
      'dc-act-click-succeeded',
      '`click` 真的执行了（程序事实：控件类型 / 窗口 / 坐标）',
      clicked !== undefined && (clicked.outcome.effect?.detail ?? '').includes('click'),
      { effect: clicked?.outcome.effect?.detail, attempts: clickAttempts + 1 }
    )
    record(
      'dc-act-typed-text-not-in-evidence',
      '输入过的正文**不在**证据串里（只有程序事实）',
      clicked !== undefined &&
        !JSON.stringify(clicked.outcome.evidence).includes(sentinel) &&
        !JSON.stringify(clicked.outcome.effect).includes(sentinel),
      { checked: 'evidence + effect' }
    )
  } finally {
    if (notepadPid !== undefined) {
      try {
        execFileSync('taskkill', ['/PID', String(notepadPid), '/T', '/F'], { stdio: 'ignore' })
      } catch {
        /* 收尾失败不改判定，但要在日志里如实留下 */
        process.stdout.write('[desktop-control:act] 收尾：杀掉记事本失败（判定不受影响）\n')
      }
    }
    rmSync(scratch, { recursive: true, force: true })
  }

  return finish(true)

  async function finish(ran: boolean): Promise<number> {
    const failed = cases.filter((item) => item.status === 'FAIL')
    const notRun = cases.filter((item) => item.status === 'NOT RUN')
    const overall = failed.length === 0 && notRun.length === 0
    for (const item of cases) {
      const mark = item.status === 'PASS' ? '·' : item.status === 'FAIL' ? '×' : '!'
      process.stdout.write(`[desktop-control:act] ${mark} ${item.status.padEnd(7)} ${item.id} — ${item.title}\n`)
      if (item.status !== 'PASS') {
        process.stdout.write(`[desktop-control:act]     observed = ${JSON.stringify(item.observed)}\n`)
      }
    }
    process.stdout.write(
      `[desktop-control:act] 判据 ${String(cases.length)} 条 · 未运行 ${String(notRun.length)} · 未通过 ${String(failed.length)}\n`
    )
    process.stdout.write(`[desktop-control:act] overall = ${overall ? 'PASS' : 'NOT PASS'}\n`)
    if (writeEvidence) {
      const runDir = join(REPO_ROOT, EVIDENCE_PARENT, runId)
      if (existsSync(runDir)) throw new Error(`runId 目录已存在，拒绝覆盖：${runDir}`)
      mkdirSync(runDir, { recursive: true })
      mkdirSync(join(REPO_ROOT, LOCAL_PARENT, runId), { recursive: true })
      writeFileSync(
        join(REPO_ROOT, LOCAL_PARENT, runId, 'act-notes.txt'),
        `哨兵与编辑框内容只在这里（被 gitignore）：\n${cases.map((item) => `${item.id}=${item.status}`).join('\n')}\n`,
        'utf8'
      )
      writeFileSync(
        join(runDir, 'act.json'),
        `${JSON.stringify(
          {
            schemaVersion: 'desktop-control-act@1',
            runId,
            head: git(['rev-parse', 'HEAD']),
            startedAt: new Date().toISOString(),
            /** ⚠️ 本门**真的动过鼠标键盘**：动作数 = 2（一次 type、一次 click），目标是自己造的记事本 */
            actions: ran ? 2 : 0,
            target: '本门自建的临时记事本（%TEMP%，跑完已收掉）',
            pinned: { package: 'windows-mcp', version: DESKTOP_MCP_VERSION },
            overall: overall ? 'PASS' : 'NOT PASS',
            cases,
          },
          null,
          2
        )}\n`,
        'utf8'
      )
      process.stdout.write(`[desktop-control:act] 证据 = ${EVIDENCE_PARENT}/${runId}/act.json\n`)
    }
    return overall ? 0 : 1
  }
}

process.exit(await main())
