/**
 * 角色自选工具 · **真实入口链**（`src/main.ts` 真的跑起来 · 生产库**副本** · 真模型）。
 *
 * ============================================================================
 *  它与另外四支的分工
 * ============================================================================
 * ```text
 * `:path` / `:matrix`      离线：决策端口是脚本夹具 ⇒ 量"提案怎么被处理"
 * `:semantic:eval`         真模型，但**不执行** ⇒ 量"她选得对不对"
 * `:live`                  真模型 + 真执行，但走的是**验收床**的装配
 * **本支**                 真模型 + 真执行 + **`src/main.ts` 本身的装配**——
 *                          激活是配置层的事，因此必须有一条读数证明"**真实入口**
 *                          真的会在 role 档下发决策调用并动手"
 * ```
 *
 * ```bash
 * pnpm with-test-model pnpm postlv2:role-tool:main-live
 * ```
 *
 * ============================================================================
 *  三条安全边界
 * ============================================================================
 * ```text
 * ① 必须经 `with-test-model`（`DSH_TEST_MODEL_WRAPPER=1`）⇒ 不烧生产 key
 * ② **生产库只复制**：`cpSync(data/pglite → %TEMP%)`，子进程一律指向副本
 *    （`PGLITE_DATA_DIR` / `PROJECT_LG_SANDBOX` / `ACTION_SANDBOX_ROOT`），
 *    真实库只比摘要、**从不打开**
 * ③ A/B 对照：**同一句话**在 `role` 档与 `rules` 档各跑一次（各自一份副本）——
 *    前者应当真的动手，后者应当零动作 ⇒ 这一条同时证明"激活真的生效"与"回滚真的回得去"
 * ```
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { PRODUCTION_DB_DIR, isProductionDir } from '../src/dev/sandbox.ts'
import { looksLikeTask } from '../src/kernel/action/task-intent.ts'

const REPO_ROOT = resolve(process.cwd())
const EVIDENCE_PARENT = 'artifacts/post-lv2/role-tool-decision'
const REAL_DB = PRODUCTION_DB_DIR

function git(args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function realDbDigest(): string {
  if (!existsSync(REAL_DB)) return 'absent'
  const names: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else names.push(path)
    }
  }
  walk(REAL_DB)
  names.sort()
  return createHash('sha256').update(names.join('|')).digest('hex').slice(0, 16)
}

interface RunReading {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

function runMain(args: readonly string[], env: NodeJS.ProcessEnv): RunReading {
  const tsxCli = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const result = spawnSync(process.execPath, [tsxCli, 'src/main.ts', ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    exitCode: result.status ?? 1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  }
}

/** 从 `action:list` 的输出里读"共 N 条" */
function listedCount(output: string): number | undefined {
  const matched = /共\s*(\d+)\s*条/.exec(output)
  return matched?.[1] === undefined ? undefined : Number(matched[1])
}

async function main(): Promise<number> {
  if (process.env.DSH_TEST_MODEL_WRAPPER !== '1') {
    process.stderr.write(
      '❌ 拒绝运行：本支会真的跑一轮聊天（含模型调用与动作），必须经测试包装器：\n' +
        '   pnpm with-test-model pnpm postlv2:role-tool:main-live\n'
    )
    return 2
  }
  if (!existsSync(REAL_DB)) {
    process.stderr.write(`❌ 找不到真实库：${REAL_DB}\n`)
    return 2
  }

  const startedAt = new Date().toISOString()
  const dbBefore = realDbDigest()
  const work = mkdtempSync(join(tmpdir(), 'lg-role-tool-main-live-'))
  /** 她要看的那个目录（**临时**，只放三份合成文件） */
  const targetDir = join(work, 'desktop')
  mkdirSync(targetDir, { recursive: true })
  writeFileSync(join(targetDir, 'notes-cn.txt'), '这是一份合成笔记。\n', 'utf8')
  writeFileSync(join(targetDir, 'a b c.md'), '# 带空格的名字\n', 'utf8')
  writeFileSync(join(targetDir, 'data.csv'), 'a,b\n1,2\n', 'utf8')
  /*
   * ⚠️ 这句话是**计划书 §1 的原句**，也是整件事的起因：
   *   「我想问个问题，就是我的电脑桌面上有几个快捷方式。」
   *   · `looksLikeTask` = **false**（无任务形标记、无写动作词）
   *   · 没有任何**绝对路径** ⇒ 本机文件域的检测器也无从触发
   *   ⇒ `rules` 档**什么都不会做**；而 `role` 档里她拿得到"程序给出的已知目录"
   *      （WP2 的已知目录事实），应当真的去列那个目录。
   *
   * 前两版的对照句都挑错了，两次都是"量具挑错了对象"：
   *   ① "**帮我**看看这个目录…" —— "帮我"命中任务关键词闸 ⇒ rules 档也动手（那不是缺陷）
   *   ② "那个目录里现在有几个文件？它的位置是 <绝对路径>" —— 句子里有绝对路径 ⇒
   *      本机文件域的检测器照样触发（rules 档又动手）
   *   ⇒ 只有"**既无任务标记、又无绝对路径**"的问题句，才是真正只有她能回答的那一档。
   */
  const text = '我想问个问题，就是我的电脑桌面上有几个快捷方式。'

  const log = (message: string): void => {
    process.stdout.write(`${message}\n`)
  }
  log(`[role-tool:main-live] 生产库（只复制）：${REAL_DB} · 摘要 ${dbBefore}`)
  log(`[role-tool:main-live] 合成目录：${targetDir}`)

  /**
   * 跑一档：**各自一份库副本**（两档互不污染，也不碰真实库）。
   *
   * ⚠️ 动作数必须读**增量**：`--action-list` 列的是**整本账**（生产库副本里本来就有历史动作），
   *    所以"18 条"不是"这一轮做了 18 件事"。第一版直接数绝对值，于是把它读成了
   *    "rules 档也做了 17 件事"——**又一个"量具挑错了对象"**。现在读 `后 - 前`。
   */
  const runMode = (
    mode: 'role' | 'rules'
  ): {
    readonly chat: RunReading
    readonly before: number
    readonly after: number
    readonly delta: number
    readonly dbDir: string
  } => {
    const dbDir = join(work, `pglite-${mode}`)
    const sandboxRoot = join(work, `action-sandbox-${mode}`)
    mkdirSync(sandboxRoot, { recursive: true })
    cpSync(REAL_DB, dbDir, { recursive: true })
    if (isProductionDir(dbDir) || isProductionDir(sandboxRoot)) {
      throw new Error('拒绝运行：副本目录与真实库重叠')
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PGLITE_DATA_DIR: dbDir,
      PROJECT_LG_SANDBOX: dbDir,
      ACTION_SANDBOX_ROOT: sandboxRoot,
      CHARACTER_TOOL_DECISION_MODE: mode,
    }
    const before = listedCount(runMain(['--action-list'], env).stdout) ?? 0
    const chat = runMain([text], env)
    /* ⚠️ **不带能力过滤**：她这一轮可能选的是别的工具（第一版只数 local.file.list，
       于是把"她**搜了一下**"读成了"她什么都没做"）。 */
    const after = listedCount(runMain(['--action-list'], env).stdout) ?? 0
    return { chat, before, after, delta: after - before, dbDir }
  }

  const role = runMode('role')
  const rules = runMode('rules')
  const dbAfter = realDbDigest()
  /**
   * 她这一轮**公开说出来的话**（回复正文）——它是最便宜的"她选了哪一支"的观察面：
   * ```text
   * 直接回答 / 反问一句 / 说做不到 —— 三者在回复文本上长得不一样
   * ```
   * ⚠️ 它只是**观察值**（可读、可核对），判据不依赖它；分支的权威读数在 trace 里。
   * ⚠️ 只抓**她那一行**（`<角色名>: …`），不要把整段日志（含启动/收尾噪声）存进证据。
   */
  const replyOf = (reading: RunReading): string => {
    const line = reading.stdout
      .split(/\r?\n/)
      .reverse()
      .find((item) => /^\s*\S[^:]{0,20}:\s+\S/.test(item) && !item.includes('PLUGIN'))
    return (line ?? '').trim().slice(0, 400)
  }
  const replyTail = replyOf(role.chat)

  const checks: { readonly id: string; readonly ok: boolean; readonly detail: string }[] = [
    {
      id: 'role-turn-succeeded',
      ok: role.chat.exitCode === 0,
      detail: `exit=${String(role.chat.exitCode)} · stdout ${String(role.chat.stdout.length)} 字符`,
    },
    {
      id: 'role-acted',
      ok: role.delta >= 1,
      detail: `role 档：账本 ${String(role.before)} → ${String(role.after)}（**本轮新增 ${String(role.delta)} 条**）`,
    },
    {
      id: 'rules-did-nothing',
      ok: rules.chat.exitCode === 0 && rules.delta === 0,
      detail:
        `rules 档：账本 ${String(rules.before)} → ${String(rules.after)}（本轮新增 ${String(rules.delta)} 条）· ` +
        `looksLikeTask(对照句)=${String(looksLikeTask(text))}`,
    },
    {
      id: 'real-db-untouched',
      ok: dbBefore === dbAfter,
      detail: `${dbBefore} → ${dbAfter}`,
    },
  ]
  const failed = checks.filter((check) => !check.ok)
  for (const check of checks) {
    log(`[role-tool:main-live]   ${check.ok ? '·' : '×'} ${check.id} —— ${check.detail}`)
  }

  const stamp = startedAt.replace(/[-:]/g, '').replace(/\..+$/, '')
  const runId = `role-tool-main-live-${stamp}-${git(['rev-parse', '--short=8', 'HEAD']) || 'unknown'}`
  const runDir = join(REPO_ROOT, EVIDENCE_PARENT, runId)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    join(runDir, 'main-live.json'),
    `${JSON.stringify(
      {
        schemaVersion: 'role-tool-decision-main-live@1',
        runId,
        head: git(['rev-parse', 'HEAD']),
        startedAt,
        endedAt: new Date().toISOString(),
        isolation: {
          kind: 'production-copy',
          note: '真实库只复制（cpSync）；每档各自一份副本；真实库只比摘要',
          targetDir,
        },
        text,
        modes: {
          role: { exitCode: role.chat.exitCode, ledgerBefore: role.before, ledgerAfter: role.after, actions: role.delta, replyTail },
          rules: { exitCode: rules.chat.exitCode, ledgerBefore: rules.before, ledgerAfter: rules.after, actions: rules.delta },
        },
        realDb: { before: dbBefore, after: dbAfter },
        checks,
        verdict: failed.length === 0 ? 'PASS' : 'NOT PASS',
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  log(`[role-tool:main-live] 证据 = ${EVIDENCE_PARENT}/${runId}/main-live.json`)
  log(`[role-tool:main-live] overall = ${failed.length === 0 ? 'PASS' : 'NOT PASS'}`)
  return failed.length === 0 ? 0 : 1
}

process.exit(await main())
