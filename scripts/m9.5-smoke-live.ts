/**
 * M9.5 WP10 —— **真模型档冒烟**（`pnpm with-test-model pnpm m9.5:smoke:live`）。
 *
 * ============================================================================
 *  它按 `docs/m9.5/M9.5-Live-Acceptance-Bar.md` 的四条门槛判定
 * ============================================================================
 * ```text
 * (a) grounded correctness            ≥ 90%
 * (b) 主要类别**各自**                ≥ 85%   ← 按 stratum 分别算（不许平均分掩盖）
 * (c) unsupported assertion           ≤ 2%
 * (d) 关键隔离/遗忘错误               = 0     ← 硬零
 * ```
 * ⚠️ **判定器**用已三控验证过的 `m9.5-live-judge@1`（确定性：取值出现 / 禁止取值泄漏 / 是否如实说无依据）。
 * ⚠️ 真轮次**真实消耗** `.env.test` 端点额度 ⇒ 先 `--dry-run` 只打印用例与门槛，再上真调用。
 * ⚠️ 每个 case 用**独立库**并把该 case 的记忆物化进去（否则量的是空场景）。
 * 用法：`pnpm with-test-model pnpm m9.5:smoke:live [--dry-run] [--runs N]`
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { extractReply } from './m6.1-reply-extract.ts'
import { M4_T0 } from './m4-harness.ts'
import { createM55Harness } from './m5.5-harness.ts'

import { cleanReply, judgeLiveReply, type LiveCaseAnnotations } from './m9.5-live-judge.ts'
import { judgeWithModel } from './m9.5-live-judge-llm.ts'

const ROOT = resolve(import.meta.dirname, '..')
const CORPUS = join(ROOT, 'evals/m9.5/corpus')
const TSX_CLI = join(ROOT, 'node_modules/tsx/dist/cli.mjs')
/*
 * ⚠️ **必须带冒号**：`'苏沐薇'`（不带冒号）会命中**启动日志**里的 `#苏沐薇`
 *    ⇒ `/exit` 与启动**竞态**、被丢掉 ⇒ 每轮都等到 10 分钟硬超时（实测 `600024ms`、`exit=-1`）
 *    ⇒ 那次读数**无效**（不是质量结论）。与 `m9.1-smoke-live.ts` 的标记保持一致。
 */
const REPLY_MARKER = '苏沐薇:'
const TURN_TIMEOUT_MS = 10 * 60 * 1000

/** 四条门槛（**与 Bar 文档逐字一致**；改这里必须同时改文档） */
const BAR = { grounded: 0.9, perStratum: 0.85, unsupported: 0.02, criticalErrors: 0 }

/** 主要类别 = 语料的四个 stratum */
const STRATA = ['normal', 'hard', 'unknown', 'lifecycle'] as const

interface SmokeCase {
  readonly caseId: string
  readonly stratum: string
  readonly request: string
  readonly predicate: string
  readonly value: string
  readonly annotations: LiveCaseAnnotations
}

/**
 * 从语料抽一行 case，并把它翻成**判定器要的标注**。
 *
 * ```text
 * · `expectedUnknownOrClarify=true` ⇒ `expectUnknown`，期望取值 `null`
 * · 否则期望取值 = `authoritativeSnapshot.value`
 * · `forbiddenValues` = 该 case 的 `forbiddenIds` 里解析出的取值 + 诱饵值
 *   （`forbiddenIds` 形如 `mem:C1:<predicate>@<value>@<user>` ⇒ 取 `@` 之间那段）
 * ```
 */
function annotationsOf(row: Record<string, unknown>): LiveCaseAnnotations {
  const snapshot = row.authoritativeSnapshot as { predicate: string; value: string }
  const expectUnknown = row.expectedUnknownOrClarify === true
  const forbidden: string[] = []
  for (const id of (row.forbiddenIds as string[] | undefined) ?? []) {
    const match = /@([^@]+)@/.exec(id)
    if (match !== null && match[1] !== snapshot.value) forbidden.push(match[1])
  }
  /*
   * ⚠️ **Round 70 修**：`expectUnknown` 的 case，**该 case 自己的取值**就是"她不得断言的那个"。
   *    第一版没把它放进 `forbiddenValues`（`neverSaved` 的 `forbiddenIds` 是空的）
   *    ⇒ 判定器只判成 `unsupported`，而按门槛 (d) 这属**关键错误**（硬零）
   *    ⇒ **硬零门槛会在失败存在时通过** —— 那是"量错了"，不是"做对了"。
   */
  if (expectUnknown && snapshot.value.length > 0) forbidden.push(snapshot.value)
  return {
    expectedValue: expectUnknown ? null : snapshot.value,
    forbiddenValues: forbidden,
    expectUnknown,
  }
}

/**
 * 每个 stratum 抽多少条。
 *
 * ⚠️ **用户 2026-09-29 裁定 (乙)：提到 7–8 条**（本实现取 **8**）。
 *    理由（实测三轮暴露的**分辨率**问题）：n=6 时一条 = 16.7%，而门槛 ≥85% ⇒
 *    5/6 = 83.3% < 85% ⇒ **"≥85%"在 n=6 等价于"一条都不能错"**，
 *    分辨率（16.7%）大于余量（1.7%）⇒ 单条个案就能翻转整类达不达标。
 *    n=8 ⇒ 一条 = 12.5%，**7/8 = 87.5% ≥ 85%**（允许一条失败）；6/8 = 75%（明确不达标）。
 */
const PER_STRATUM = 8

function pickCases(): SmokeCase[] {
  const rows = readFileSync(join(CORPUS, 'dev.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const picked: SmokeCase[] = []
  for (const stratum of STRATA) {
    /*
     * ⚠️ 原先 `rows.find(...)` 只取**第一条** ⇒ 每类 1 条。
     *    那让门槛 (b)"主要类别均 ≥ 85%"**失去意义**（1 条只能 0% 或 100%）。
     *    ⇒ 每类抽 `PER_STRATUM` 条，并加**样本量下限**（不足 ⇒ MEASUREMENT INVALID）。
     */
    const inStratum = rows.filter((item) => item.stratum === stratum)
    /* 按 caseId 稳定排序后取前 N（确定性 ⇒ 可复现） */
    const sorted = [...inStratum].sort((a, b) => (String(a.caseId) < String(b.caseId) ? -1 : 1))
    for (const row of sorted.slice(0, PER_STRATUM)) {
      const snapshot = row.authoritativeSnapshot as { predicate: string; value: string }
      picked.push({
        caseId: String(row.caseId),
        stratum,
        request: String(row.request),
        predicate: snapshot.predicate,
        value: snapshot.value,
        annotations: annotationsOf(row),
      })
    }
  }
  return picked
}

function turnEnv(dbDir: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    PGLITE_DATA_DIR: dbDir,
    PROJECT_LG_SANDBOX: dbDir,
  }
}

function spawnConsoleTurn(input: {
  readonly text: string
  readonly env: Record<string, string>
}): Promise<{ status: number; stdout: string; durationMs: number }> {
  return new Promise((resolveSpawn) => {
    const started = Date.now()
    const child = spawn(process.execPath, [TSX_CLI, 'src/main.ts'], {
      cwd: ROOT,
      env: input.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let settled = false
    let exitSent = false
    const finish = (status: number): void => {
      if (settled) return
      settled = true
      clearInterval(pollTimer)
      clearTimeout(hardTimer)
      resolveSpawn({ status, stdout, durationMs: Date.now() - started })
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.on('error', () => finish(-1))
    child.on('close', (status) => finish(status ?? -1))
    const hardTimer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      finish(-1)
    }, TURN_TIMEOUT_MS)
    child.stdin?.write(`${input.text}\n`)
    const pollTimer = setInterval(() => {
      if (!exitSent && stdout.includes(REPLY_MARKER)) {
        exitSent = true
        child.stdin?.write('/exit\n')
      }
    }, 500)
  })
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const runsIndex = process.argv.indexOf('--runs')
  const runs = runsIndex >= 0 ? Number(process.argv[runsIndex + 1]) : 1
  /*
   * ⚠️ **Round 102**：原先 `runs` **只出现在输出标签里**，从未用来循环 ⇒
   *    `--runs 3` 会**声称**跑 3 次而**实际只跑 1 次**。那是**误导性开关**。
   *    ⇒ 在实现多次循环之前，**拒绝**静默地只跑一次（失败关闭，而不是"看起来跑了3次"）。
   */
  if (runs !== 1) {
    throw new Error(`--runs=${String(runs)} 尚未实现（多次运行循环未落地）⇒ 拒绝静默只跑一次；请先跑单次 24 条，或实现循环后再用`)
  }
  /* `--limit N`：**只用于接线预检**（样本不足时下方的样本量下限会判 MEASUREMENT INVALID，不给假百分比） */
  const limitIndex = process.argv.indexOf('--limit')
  const limit = limitIndex >= 0 ? Number(process.argv[limitIndex + 1]) : undefined
  const pickedAll = pickCases()
  const cases = limit === undefined ? pickedAll : pickedAll.slice(0, Math.max(1, limit))

  process.stdout.write(
    [`M9.5 真模型档冒烟${dryRun ? '（**干跑**，不调用模型）' : ''}`, `  用例 ${String(cases.length)} 条（每 stratum ${String(PER_STRATUM)} 条）· runs=${String(runs)}`]
      .concat(
        cases.map(
          (item) =>
            `  · ${item.stratum} ${item.caseId} · 期望=${item.annotations.expectUnknown ? '（如实说无依据）' : `「${String(item.annotations.expectedValue)}」`} · 禁止取值 ${String(item.annotations.forbiddenValues.length)} 个`
        )
      )
      .join('\n') + '\n'
  )
  process.stdout.write(`  门槛：grounded ≥ ${String(BAR.grounded * 100)}% · 每类 ≥ ${String(BAR.perStratum * 100)}% · unsupported ≤ ${String(BAR.unsupported * 100)}% · 关键错误 = ${String(BAR.criticalErrors)}\n`)

  if (dryRun) {
    process.stdout.write('  干跑结束：用例选择与标注抽取已验证；**未**调用任何模型，**未**产生读数。\n')
    return
  }

  /* ---- 真轮次 ---- */
  const perCase: Record<string, unknown>[] = []
  for (const item of cases) {
    /*
     * ⚠️ **场景物化**（Round 68 补）：真空副本**不含**语料里的合成事实
     *   （`栖霞大学` 等）⇒ 不物化就跑，她只会答"没记过"，那是**布景问题**而不是质量读数。
     *   做法：在本进程把该 case 的记忆写进一个**隔离库**，再把**那个库的目录**交给子进程。
     *   `isolateDatabase()` 返回 `{ dir }` ⇒ 路径是拿得到的（不是猜的）。
     */
    await resetPluginSqlConnection()
    const sandbox = isolateDatabase(`m95-smoke-${item.caseId}`)
    const bed = await createM55Harness({ label: `m95-smoke-${item.caseId}` })
    const h = bed.h
    /*
     * ⚠️⚠️ **Round 99 修布景 bug（严重）**：原先**无条件**为每个 case 写入
     *      `记住：{predicate} 是 {value}` —— **包括 `neverSaved` / `unknown` 那类**，
     *      而那类 case 的前提恰恰是"**该取值从未正式保存**"。
     *      ⇒ 我**亲手把它存成了记忆** ⇒ 她回「记得。毕业设计。」在这个布景里是**正确**的，
     *        而判定器（被告知该取值属禁止项）判它"无依据却断言" ⇒ **把布景 bug 记成了产品缺陷**。
     *      ⇒ **`M9.5-FMB-01` 的立案依据来自这条读数 ⇒ 该依据作废，须重测**（见立案书 §2.5）。
     *      修法：**只有"期望她答出取值"的 case 才物化记忆**；无依据类**不写任何记忆**。
     */
    if (!item.annotations.expectUnknown) {
      const evidence = await h.recordUserEvidence(`记住：${item.predicate} 是 ${item.value}。`)
      const written = await h.commitAndFold(
        h.makeCandidate('preference', { kind: 'claim', subject: h.user, predicate: item.predicate, value: item.value } as never, {
          sourceRefs: [evidence.ref],
        }),
        M4_T0 + 1_000
      )
      if (written === null || written === undefined) throw new Error(`${item.caseId}: 物化失败（记忆没写成）`)
    }
    await bed.dispose()

    const env = turnEnv(sandbox.dir)
    /* 结构性断言：子进程拿到的**就是**物化过的那个目录 */
    if (env.PGLITE_DATA_DIR !== sandbox.dir || env.PROJECT_LG_SANDBOX !== sandbox.dir) {
      throw new Error('子进程的数据目录与物化目录不一致 ⇒ 会量到空场景')
    }
    const out = await spawnConsoleTurn({ text: item.request, env })
    /* ⚠️ `cleanReply`：削掉尾部混入的控制台日志（`L-M95-25`），否则噪声会进被测对象 */
    const reply = cleanReply(extractReply(out.stdout))
    /*
     * **本轮可采信的证据**（`M9.5-FMB-01` 的判据要的是"断言 ↔ 证据"）：
     *  · `expectUnknown=true` ⇒ **我们什么都没物化** ⇒ 证据 = **空**
     *  · 否则 ⇒ ① 物化的那条记忆；② **本轮可见对话里的那句用户原话**
     *    （`recordUserEvidence('记住：X 是 Y。')` 会作为**用户行**进入本轮上下文 ⇒
     *     她引用"你刚才自己说的"是**有据**的，不算编造）
     * ⚠️ 证据集合**必须与本轮实际可见/入模的东西一致**：漏一项就会把**合法回复**判成
     *    "未被支持的断言"（Round 99 与本轮各踩一次，同族）。
     */
    const admissibleEvidence = item.annotations.expectUnknown
      ? []
      : [`记忆：${item.predicate} = ${item.value}`, `用户在本轮可见对话里说过：「记住：${item.predicate} 是 ${item.value}。」`]
    const verdict = await judgeWithModel({ request: item.request, reply, admissibleEvidence })
    /* 确定性判定器**保留为交叉记录**（不花额度；两者不一致本身就是信息） */
    const deterministic = judgeLiveReply(reply, item.annotations)
    if (verdict.kind === 'unavailable') throw new Error(`LLM 判定器不可用：${verdict.judgeModel}`)
    /*
     * ⚠️ **记录回复正文**（Round 70 补）：不记正文 ⇒ 失败时**无法归因**
     *    （"她真没说无依据" vs "判定器的词形表没命中" 是两件事，而后者是我声明过的边界）。
     *    正文落在 **gitignore 的私有实验目录**（含语料内容，不进仓库）。
     */
    perCase.push({ ...item, reply, replyLength: reply.length, durationMs: out.durationMs, status: out.status, verdict, deterministic })
    process.stdout.write(
      `  ${item.stratum} · exit=${String(out.status)} · ${String(out.durationMs)}ms · kind=${verdict.kind} · grounded=${String(verdict.grounded)} · critical=${String(verdict.criticalErrors.length)} · unsupported=${String(verdict.unsupportedAssertions.length)}${verdict.criticalErrors.length > 0 || deterministic.criticalErrors.length > 0 ? ` · 确定性判定 critical=${String(deterministic.criticalErrors.length)}` : ''}\n`
    )
    if (!verdict.grounded) {
      process.stdout.write(`      ↳ 未达标用例的回复原文（供归因）：${reply.replace(/\s+/g, ' ').slice(0, 220)}\n`)
    }
  }

  /* 落一份**回复清单**到私有实验目录（便于复核归因；不进仓库） */
  {
    const dir = join(ROOT, 'artifacts/m9.5/local/live-smoke')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          schemaVersion: 'm9.5-smoke-transcript@1',
          generatedAt: new Date().toISOString(),
          bar: BAR,
          perCase: perCase.map((row) => ({
            stratum: row.stratum,
            caseId: row.caseId,
            request: row.request,
            expected: (row.annotations as LiveCaseAnnotations).expectedValue,
            expectUnknown: (row.annotations as LiveCaseAnnotations).expectUnknown,
            reply: row.reply,
            verdict: row.verdict,
            status: row.status,
            durationMs: row.durationMs,
          })),
        },
        null,
        2
      )}\n`,
      'utf8'
    )
    process.stdout.write(`  回复清单（私有，供归因）：${path}\n`)
  }

  /* ---- 四条门槛 ---- */
  const judged = perCase.map((row) => row.verdict as ReturnType<typeof judgeLiveReply>)
  const groundedRate = judged.filter((v) => v.grounded).length / judged.length
  /*
   * ⚠️ **口径必须写明**（`M9.5-FMB-01` 复查）：门槛 (c) 的原文是「unsupported assertion ≤ 2%」，
   *    而**确定性判定器数不出"回复里共有多少条断言"** ⇒ 本门的分母是 **case 数**，不是 assertion 数。
   *    ⇒ 如实标注为「**含 unsupported 的 case / 总 case**」，**不**假装它是 per-assertion 比率。
   *    （若要真正的 per-assertion 口径，需要能数断言的判定器 —— 那是 `L-M95-29` 的 (乙) 一类。）
   */
  const unsupportedRate =
    judged.reduce((sum, verdict) => sum + verdict.unsupportedAssertions.length, 0) / Math.max(1, judged.length)
  const criticalErrors = judged.reduce((sum, v) => sum + v.criticalErrors.length, 0)
  const perStratum = STRATA.map((stratum) => {
    const rows = perCase.filter((row) => row.stratum === stratum)
    const ok = rows.filter((row) => (row.verdict as ReturnType<typeof judgeLiveReply>).grounded).length
    return { stratum, cases: rows.length, grounded: ok, rate: rows.length === 0 ? 0 : ok / rows.length }
  })

  const problems: string[] = []
  /*
   * ⚠️ **样本量下限**（`M9.5-FMB-01` 复查）：每类不足 `PER_STRATUM` 条 ⇒ **MEASUREMENT INVALID**，
   *    而不是"用 1 条算出 0%/100% 然后报门槛未达"。**计数型判据必须自检分母**。
   */
  const thinStrata = perStratum.filter((row) => row.cases < PER_STRATUM)
  if (thinStrata.length > 0) {
    process.stdout.write(
      `\n⛔ MEASUREMENT INVALID：以下类别样本不足 ${String(PER_STRATUM)} 条 ⇒ ${JSON.stringify(thinStrata)}\n` +
        '   （"每类 ≥ 85%" 在 1 条样本上没有意义 ⇒ 不判门槛，先补样本）\n'
    )
    process.exitCode = 3
    return
  }
  if (groundedRate < BAR.grounded) problems.push(`(a) grounded ${(groundedRate * 100).toFixed(1)}% < ${String(BAR.grounded * 100)}%`)
  for (const row of perStratum) {
    if (row.cases > 0 && row.rate < BAR.perStratum) problems.push(`(b) ${row.stratum} ${(row.rate * 100).toFixed(1)}% < ${String(BAR.perStratum * 100)}%`)
  }
  if (unsupportedRate > BAR.unsupported) problems.push(`(c) unsupported ${(unsupportedRate * 100).toFixed(1)}% > ${String(BAR.unsupported * 100)}%`)
  if (criticalErrors !== BAR.criticalErrors) problems.push(`(d) 关键错误 ${String(criticalErrors)} ≠ 0`)

  process.stdout.write(
    [
      '',
      `M9.5 真模型档冒烟：${problems.length === 0 ? '**MET（达标）**' : '**NOT MET（未达标）**'}`,
      `  (a) grounded ${(groundedRate * 100).toFixed(1)}% · (c) unsupported ${(unsupportedRate * 100).toFixed(1)}% · (d) 关键错误 ${String(criticalErrors)}`,
      ...perStratum.map((row) => `  (b) ${row.stratum}: ${String(row.grounded)}/${String(row.cases)} = ${(row.rate * 100).toFixed(1)}%`),
      ...problems.map((line) => `  ✗ ${line}`),
    ].join('\n') + '\n'
  )
}

await main()
