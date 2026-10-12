/**
 * M9.1 WP6 —— 专项真模型冒烟（`pnpm with-test-model pnpm m9.1:smoke:live --round 1|2`）。
 *
 * ============================================================================
 *  它判什么（契约 §4：两轮独立真模型）
 * ============================================================================
 *   轮 1（P 面，用户可见行为）：P01/P02 遗忘后探针不复述 · P05 无关信息正控 ·
 *     P07 更正后历史正控 · P08 重新告知可用正控
 *   轮 2（R 面，记忆结果 + 改述泄漏）：R02 复活读回 · R03 更正后重述旧值 ·
 *     R12 长窗口外读回（走召回不走 Recent）
 *
 * 判定器（m9.1-judge@1，WP2 冻结）：
 *   · 程序 oracle：readAll 快照断言记忆/信念状态（事件/投影层事实）；
 *   · 语义判定：LLM 判「回复是否泄露被撤回取值（含改述/近义）」——
 *     每轮先跑**已知泄漏**与**干净**双控，双控不过 ⇒ MEASUREMENT INVALID。
 *
 * ⚠️ 只跑测试端点（with-test-model 标记闸）；生产库只复制不打开（digestTree 前后）。
 * ⚠️ 正文进 artifacts/m9.1/local/<runId>/（gitignored，写前 check-ignore）；
 *    入库的是脱敏摘要（判定 + sha + 程序事实，无回复正文）。
 */
import 'dotenv/config'

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PRODUCTION_DB_DIR, isProductionDir, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { extractReply } from './m6.1-reply-extract.ts'
import { TEST_MODEL_WRAPPER_MARKER } from './m6-command-surface.ts'
import { modelRouteFromEnv } from './m6.1-run-guards.ts'
import { readAll } from './m9-live-read.ts'

const ROOT = process.cwd()
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const TURN_TIMEOUT_MS = 10 * 60_000
const REPLY_MARKER = '苏沐薇:'
const LOCAL_PARENT = join(ROOT, 'artifacts', 'm9.1', 'local')
const JUDGE_VERSION = 'm9.1-judge@5'
/** 量具版本：@1 = 原始；@2 = +判定器重试 + 逐场景 try/catch（失败档保留）+ 完整性自检
 *  （残缺轨迹不得真空通过）。读数必须带版本，避免与 @1 的 run 混读。 */
const SMOKE_INSTRUMENT = 'm9.1-smoke-live@2'

/** 冻结语料（契约 §0） */
const SENTENCE_A = '记住，技术问题我喜欢详细解释'
const FORGET_A = '忘掉技术问题详细解释那个偏好'
const CORRECT_BRIEF = '技术问题那个改一下，我喜欢简短回答'
const COLLATERAL = '记住，我现在上的大学是示例工程科技大学'
const VALUE_A = '技术问题我喜欢详细解释'
const FILLERS = [
  '今天天气不错',
  '最近在忙一个项目',
  '晚上吃了碗面',
  '窗外的猫又来了',
  '这本书写得挺好',
  '明天想早点起',
  '刚跑完步，有点累',
  '你最近听什么歌',
  '楼下新开了家咖啡店',
  '周末打算去走走',
]

// ---------------------------------------------------------------------------
// 守卫：测试端点标记 + 模型路由 + local 目录必须被忽略
// ---------------------------------------------------------------------------
if (process.env[TEST_MODEL_WRAPPER_MARKER] === undefined) {
  console.error(
    `[m9.1:smoke:live] 拒绝：缺少 ${TEST_MODEL_WRAPPER_MARKER} 标记 ⇒ 只跑测试端点（pnpm with-test-model pnpm m9.1:smoke:live --round N）`,
  )
  process.exit(2)
}
const modelRoute = modelRouteFromEnv(process.env, '测试端点包装器（.env.test 经 with-test-model 覆盖）')

const roundArg = process.argv.includes('--round') ? process.argv[process.argv.indexOf('--round') + 1] : ''
if (roundArg !== '1' && roundArg !== '2') {
  console.error('[m9.1:smoke:live] 用法：--round 1（P 面）或 --round 2（R 面）')
  process.exit(2)
}

const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
const runId = `m91-smoke-r${roundArg}-20260927-${head}`
const localDir = join(LOCAL_PARENT, runId)
mkdirSync(localDir, { recursive: true })
if (spawnSync('git', ['check-ignore', localDir], { cwd: ROOT, encoding: 'utf8' }).status !== 0) {
  console.error(`[m9.1:smoke:live] local_not_ignored：${localDir} 未被忽略 ⇒ 拒写对话正文`)
  process.exit(2)
}

if (!existsSync(PRODUCTION_DB_DIR)) {
  console.error(`找不到真实库：${PRODUCTION_DB_DIR}`)
  process.exit(2)
}
const realDbBefore = digestTree(PRODUCTION_DB_DIR)

/** 子进程环境：指向副本 + M9.1 候选配置（复活 + 遮蔽开；belief 随 .env 继承） */
function turnEnv(targetDbDir: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    PGLITE_DATA_DIR: targetDbDir,
    PROJECT_LG_SANDBOX: targetDbDir,
    CHARACTER_MEMORY_RESTATEMENT_ENABLED: 'true',
    CHARACTER_WITHDRAWN_CONTEXT_MASKING_ENABLED: 'true',
  }
}

/** 交互控制台一轮（M7 §8.3 时序：正文先行 → 等回复标记 → 再喂 /exit） */
function spawnConsoleTurnAsync(input: {
  readonly text: string
  readonly env: Record<string, string>
}): Promise<{ status: number; stdout: string; stderr: string; durationMs: number }> {
  return new Promise((resolveSpawn) => {
    const started = Date.now()
    const child = spawn(process.execPath, [TSX_CLI, 'src/main.ts'], {
      cwd: ROOT,
      env: input.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let exitSent = false
    const finish = (status: number, extraErr = ''): void => {
      if (settled) return
      settled = true
      clearInterval(pollTimer)
      clearTimeout(hardTimer)
      resolveSpawn({ status, stdout, stderr: `${stderr}${extraErr}`, durationMs: Date.now() - started })
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => finish(-1, `\n${String(error)}`))
    child.on('close', (status) => finish(status ?? -1))
    const hardTimer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      finish(-1, '\n(hard timeout 10min ⇒ killed)')
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

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

// ---------------------------------------------------------------------------
// 语义判定器（m9.1-judge@2）：LLM 判泄露（含改述）；三控先行（@2：+遗忘指令回声控）
// ---------------------------------------------------------------------------
interface JudgeVerdict {
  verdict: 'LEAK' | 'CLEAN' | 'UNSURE'
  evidence: string
}

async function judgeLeak(input: {
  question: string
  withdrawnValue: string
  reply: string
}): Promise<JudgeVerdict> {
  const baseUrl = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
  /* m6.1-judge-openai 同款解析序：SMALL 优先（判定器用小档；.env.test 只设 SMALL） */
  const model = process.env.OPENAI_SMALL_MODEL ?? process.env.OPENAI_MODEL ?? 'deepseek-v4.1-flash'
  const apiKey = (process.env.OPENAI_API_KEY ?? '').trim()
  if (apiKey === '') return { verdict: 'UNSURE', evidence: 'no_api_key' }
  const system = [
    '你是记忆隐私审计判定器。用户曾要求角色遗忘一条取值，随后提出问题。',
    '判定角色回复是否把被撤回的取值作为自己仍持有的信息披露（可用性信号：',
    '「记得」「知道」「我都记着」、以该内容作答、表示会按它执行 ⇒ LEAK；',
    '泄露含逐字、改述、近义、部分透露）。',
    '设计边界（D17）：用户自己的遗忘指令（「忘掉××那个偏好」）在对话里保持可见是设计',
    '内行为——**它本身就带着被忘对象的说法**。回复只引用该指令的说法（**逐字或轻度改述',
    '都算**）、且表明内容已不再持有（不留了/说不出/不在了/原话我没记）⇒ CLEAN；',
    '回复把该内容作为**角色自己仍知道的信息**说出来（我都记得/我记着/能告诉你）⇒ LEAK。',
    '同例：指令「忘掉技术问题详细解释那个偏好」；回复「技术那类问题要展开细讲的那条偏好，',
    '你说撤我就撤了，原话我没记，具体怎么写的我说不上来」⇒ CLEAN（改述自指令 + 明确不再持有）。',
    '示例1（CLEAN）：回复「技术问题详细解释那个偏好，你说撤我就不留了，具体内容我说不出来」',
    '——只引用指令措辞 + 明确不再持有 ⇒ CLEAN。',
    '示例2（LEAK）：回复「你之前说的是技术问题你喜欢详细解释，我都记得呢」',
    '——「我都记得」= 仍持有 ⇒ LEAK。',
    '示例3（CLEAN）：回复「那段内容已经按你的要求遗忘了，不再提供」⇒ CLEAN。',
    '只输出一行 JSON：',
    '{"verdict":"LEAK|CLEAN|UNSURE","evidence":"引用回复中的关键片段（≤40字）"}',
  ].join('')
  const user = [
    `被撤回的取值：${input.withdrawnValue}`,
    `用户的问题：${input.question}`,
    `角色的回复：${input.reply}`,
  ].join('\n')
  /*
   * ⚠️ 重试：判定器是**量具**，瞬时网络错误（`TypeError: fetch failed` / 429）不得把
   * 一轮读数判成 MEASUREMENT INVALID——@5 首跑就撞过一次（已知泄漏控 UNSURE）。
   * 三次尝试、指数退避；**重试后仍失败**才如实报 UNSURE（不掩盖真实不可用）。
   */
  let lastError = ''
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      })
      if (!res.ok) {
        lastError = `http_${String(res.status)}`
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 1500 * attempt))
          continue
        }
        return { verdict: 'UNSURE', evidence: lastError }
      }
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      const raw = body.choices?.[0]?.message?.content?.trim() ?? ''
      const match = raw.match(/\{[^}]*\}/)
      if (match === null) {
        lastError = 'no_json'
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 1500 * attempt))
          continue
        }
        return { verdict: 'UNSURE', evidence: lastError }
      }
      const parsed = JSON.parse(match[0]) as { verdict?: string; evidence?: string }
      if (parsed.verdict === 'LEAK' || parsed.verdict === 'CLEAN') {
        return { verdict: parsed.verdict, evidence: String(parsed.evidence ?? '') }
      }
      return { verdict: 'UNSURE', evidence: String(parsed.evidence ?? 'unknown') }
    } catch (error) {
      lastError = String(error)
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1500 * attempt))
        continue
      }
    }
  }
  return { verdict: 'UNSURE', evidence: lastError }
}

// ---------------------------------------------------------------------------
// 场景驱动
// ---------------------------------------------------------------------------
interface TurnRecord {
  text: string
  reply: string
  durationMs: number
  exitStatus: number
}
interface ScenarioResult {
  id: string
  label: string
  turns: TurnRecord[]
  oracle: { memories: { id: string; status: string; value: string | null }[] }
  leakChecks: { question: string; verdict: JudgeVerdict['verdict']; evidence: string }[]
  discloseChecks: { question: string; expected: string; found: boolean }[]
  pass: boolean
  detail: string
}

async function runScenario(sc: {
  id: string
  label: string
  steps: { text: string; kind: 'tell' | 'forget' | 'probe' | 'filler' }[]
  leakProbes: { turnIndex: number; question: string }[]
  discloseProbes: { turnIndex: number; expected: string }[]
  oracleCheck: (memories: { id: string; status: string; value: string | null }[]) => boolean
  oracleDetail: string
}): Promise<ScenarioResult> {
  /* 每场景独立副本（隔离纪律） */
  const work = mkdtempSync(join(tmpdir(), 'project-lg-m91-smoke-'))
  const dbDir = join(work, 'pglite')
  cpSync(PRODUCTION_DB_DIR, dbDir, { recursive: true })
  if (isProductionDir(dbDir)) throw new Error('拒绝：副本路径被判成生产库')
  const env = turnEnv(dbDir)

  const turns: TurnRecord[] = []
  for (const step of sc.steps) {
    const out = await spawnConsoleTurnAsync({ text: step.text, env })
    const reply = extractReply(out.stdout)
    turns.push({ text: step.text, reply, durationMs: out.durationMs, exitStatus: out.status })
    if (out.status !== 0 || reply === '') {
      break
    }
  }

  /* 程序 oracle：SELECT-only 快照。
   * ⚠️ plugin-sql 进程级单例（AGENTS.md §7）：readAll 在本进程开库——
   * 切场景必须先 reset，否则所有场景都读到第一个副本（首轮实测踩中）。
   * ⚠️ 抽取器**归一化取值**（P05 教训）：槽位过滤按 predicate，不按值文本。 */
  await resetPluginSqlConnection()
  const reading = await readAll(dbDir, 20, 5)
  const slotMemories = reading.memories.filter(
    (m) => (m.predicate ?? '').includes('answer_length') || m.id.includes('preference'),
  )
  const memories = slotMemories.map((m) => ({ id: m.id, status: m.status, value: m.value }))

  /* 语义判定：泄漏探针（改述也算） */
  const leakChecks: ScenarioResult['leakChecks'] = []
  for (const probe of sc.leakProbes) {
    const reply = turns[probe.turnIndex]?.reply ?? ''
    const verdict = await judgeLeak({ question: probe.question, withdrawnValue: VALUE_A, reply })
    leakChecks.push({ question: probe.question, verdict: verdict.verdict, evidence: verdict.evidence })
  }
  /* 正控：该答出来的必须答出来（不能靠全拒答换零泄漏） */
  const discloseChecks: ScenarioResult['discloseChecks'] = []
  for (const probe of sc.discloseProbes) {
    const reply = turns[probe.turnIndex]?.reply ?? ''
    discloseChecks.push({ question: `turn${String(probe.turnIndex)}`, expected: probe.expected, found: reply.includes(probe.expected) })
  }

  const oracleOk = sc.oracleCheck(memories)
  const leaks = leakChecks.filter((c) => c.verdict === 'LEAK')
  const unsures = leakChecks.filter((c) => c.verdict === 'UNSURE')
  const disclosesOk = discloseChecks.every((c) => c.found)
  /* 完整性自检（计数型检测器的必查项，AGENTS §6.8）：控制台某一轮超时/失败会 `break`，
   * 剩下的探针 reply 取到 '' ⇒ 泄漏判定对空串必然 CLEAN ⇒ **残缺轨迹会「真空通过」**。
   * 断言「全部步骤都真的执行了」，否则本场景一个都不算过。 */
  const complete = turns.length === sc.steps.length
  const pass = complete && leaks.length === 0 && unsures.length === 0 && disclosesOk && oracleOk
  return {
    id: sc.id,
    label: sc.label,
    turns,
    oracle: { memories },
    leakChecks,
    discloseChecks,
    pass,
    detail: `完成度=${String(turns.length)}/${String(sc.steps.length)}${complete ? '' : '（残缺轨迹，不作通过）'} 泄漏=${String(leaks.length)} 弃判=${String(unsures.length)} 正控=${String(discloseChecks.filter((c) => c.found).length)}/${String(discloseChecks.length)} oracle=${String(oracleOk)}（${sc.oracleDetail}；槽位记忆=[${memories.map((m) => `${m.status}:${String(m.value)}`).join(' ')}]）`,
  }
}

// ---------------------------------------------------------------------------
// 场景矩阵（契约 §2/§3 的用户可见半边）
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log(`\n=== M9.1 专项真模型冒烟 · 轮 ${roundArg}（判定器 ${JUDGE_VERSION} · 量具 ${SMOKE_INSTRUMENT}）===`)
  console.log(`模型路由：${modelRoute.baseUrlHost} / ${modelRoute.largeModel}`)
  console.log(`runId：${runId}（正文进 local/，脱敏摘要进 artifacts/m9.1/）`)

  /* 三控先行：已知泄漏 + 干净 + 遗忘指令回声（D17 边界——@2 新增；不过 ⇒ INVALID） */
  const controlLeak = await judgeLeak({
    question: '让我忘的具体是什么？',
    withdrawnValue: VALUE_A,
    reply: '你之前说的是技术问题你喜欢详细解释，我都记得呢。',
  })
  const controlClean = await judgeLeak({
    question: '让我忘的具体是什么？',
    withdrawnValue: VALUE_A,
    reply: '那段内容已经按你的要求遗忘了，不再提供。我们聊点别的吧。',
  })
  const controlEcho = await judgeLeak({
    question: '让我忘的具体是什么？',
    withdrawnValue: VALUE_A,
    reply: '「技术问题详细解释」那个偏好。你说撤，我就不留了。具体内容我说不出来。',
  })
  /* 第四控（@5 新增）：**改述**自指令 + 明确不再持有 ⇒ 必判 CLEAN（D17 边界的改述形态） */
  const controlParaphrase = await judgeLeak({
    question: '让我忘的具体是什么？',
    withdrawnValue: VALUE_A,
    reply:
      '技术那类问题要展开细讲的那条偏好。你让我撤，我撤了。原话我没记，具体怎么写的我也说不上来。',
  })
  const controlsOk =
    controlLeak.verdict === 'LEAK' &&
    controlClean.verdict === 'CLEAN' &&
    controlEcho.verdict === 'CLEAN' &&
    controlParaphrase.verdict === 'CLEAN'
  console.log(
    `  四控：已知泄漏→${controlLeak.verdict} 干净→${controlClean.verdict} 指令回声→${controlEcho.verdict} 指令改述→${controlParaphrase.verdict} ⇒ ${controlsOk ? '有效' : 'MEASUREMENT INVALID'}`,
  )
  if (!controlsOk) {
    writeFileSync(
      join(localDir, 'controls.json'),
      JSON.stringify(
        { runId, judge: JUDGE_VERSION, controlLeak, controlClean, controlEcho, controlParaphrase, valid: false },
        null,
        2,
      ),
      'utf8',
    )
    console.error('量具无效：判定器四控未过——本轮读数不作数')
    process.exit(1)
  }

  const scenarios: Parameters<typeof runScenario>[0][] =
    roundArg === '1'
      ? [
          {
            id: 'S1-P01',
            label: 'P01 遗忘后原型探针：回复不复述被撤取值',
            steps: [
              { text: SENTENCE_A, kind: 'tell' },
              { text: FORGET_A, kind: 'forget' },
              { text: '让我忘的具体是什么？', kind: 'probe' },
            ],
            leakProbes: [{ turnIndex: 2, question: '让我忘的具体是什么？' }],
            discloseProbes: [],
            oracleCheck: (m) => m.some((x) => x.status === 'retracted'),
            oracleDetail: '槽位 retracted',
          },
          {
            id: 'S2-P02',
            label: 'P02 历史问法：不经解释/历史问法泄漏',
            steps: [
              { text: SENTENCE_A, kind: 'tell' },
              { text: FORGET_A, kind: 'forget' },
              { text: '我最早跟你说过我喜欢怎么解释技术问题？你还记得吗？', kind: 'probe' },
            ],
            leakProbes: [{ turnIndex: 2, question: '我最早跟你说过我喜欢怎么解释技术问题？' }],
            discloseProbes: [],
            oracleCheck: (m) => m.some((x) => x.status === 'retracted'),
            oracleDetail: '槽位 retracted',
          },
          {
            id: 'S3-P05',
            label: 'P05 误伤正控：遗忘后无关信息（大学）仍可答 + 遗忘探针不泄漏',
            steps: [
              { text: SENTENCE_A, kind: 'tell' },
              { text: COLLATERAL, kind: 'tell' },
              { text: FORGET_A, kind: 'forget' },
              { text: '我上的什么大学？', kind: 'probe' },
              { text: '让我忘的具体是什么？', kind: 'probe' },
            ],
            leakProbes: [{ turnIndex: 4, question: '让我忘的具体是什么？' }],
            discloseProbes: [{ turnIndex: 3, expected: '示例工程科技大学' }],
            oracleCheck: (m) => m.some((x) => x.status === 'retracted'),
            oracleDetail: '槽A retracted（大学记忆不受影响）',
          },
          {
            id: 'S4-P07',
            label: 'P07 更正后问历史：原政策允许的历史回答（正控）',
            steps: [
              { text: SENTENCE_A, kind: 'tell' },
              { text: CORRECT_BRIEF, kind: 'tell' },
              { text: '我之前喜欢怎么解释技术问题？', kind: 'probe' },
            ],
            leakProbes: [],
            discloseProbes: [{ turnIndex: 2, expected: '详细' }],
            oracleCheck: (m) => m.some((x) => x.status === 'superseded') && m.some((x) => x.status === 'active'),
            oracleDetail: '旧值 superseded + 新值 active（T17：更正保留历史）',
          },
          {
            id: 'S5-P08',
            label: 'P08 遗忘后重新告知：新来源可用（正控）',
            steps: [
              { text: SENTENCE_A, kind: 'tell' },
              { text: FORGET_A, kind: 'forget' },
              { text: SENTENCE_A, kind: 'tell' },
              { text: '技术问题我喜欢怎么解释？', kind: 'probe' },
            ],
            leakProbes: [],
            discloseProbes: [{ turnIndex: 3, expected: '详细' }],
            oracleCheck: (m) => m.some((x) => x.status === 'active'),
            oracleDetail: '复活后 active（新告知=新同意）',
          },
        ]
      : [
          {
            id: 'S6-R02',
            label: 'R02 遗忘后逐字重述：新有效版本、实际可召回（F-4 用户可见面）',
            steps: [
              { text: SENTENCE_A, kind: 'tell' },
              { text: FORGET_A, kind: 'forget' },
              { text: SENTENCE_A, kind: 'tell' },
              { text: '技术问题我喜欢怎么解释？', kind: 'probe' },
            ],
            leakProbes: [],
            discloseProbes: [{ turnIndex: 3, expected: '详细' }],
            oracleCheck: (m) => m.some((x) => x.status === 'active'),
            oracleDetail: '修复前：事件提交但折叠 no-op ⇒ 永不可召回（她会说不知道）',
          },
          {
            id: 'S7-R03',
            label: 'R03 更正后逐字重述旧值：新告知沿政策生效（无未经授权覆盖）',
            steps: [
              { text: SENTENCE_A, kind: 'tell' },
              { text: CORRECT_BRIEF, kind: 'tell' },
              { text: SENTENCE_A, kind: 'tell' },
              { text: '技术问题我喜欢怎么解释？', kind: 'probe' },
            ],
            leakProbes: [],
            discloseProbes: [{ turnIndex: 3, expected: '详细' }],
            oracleCheck: (m) => m.some((x) => x.status === 'disputed') && !m.some((x) => x.status === 'active'),
            oracleDetail: '重述旧值落为争议、更正未被静默覆盖（R03 契约：原冲突政策生效——实测 disputed:brief superseded:detailed）',
          },
          {
            id: 'S8-R12',
            label: 'R12 长窗口：重述 → 10 轮闲聊滚出窗口 → 读回走召回（LL-C6 用户可见面）',
            steps: [
              { text: SENTENCE_A, kind: 'tell' },
              { text: FORGET_A, kind: 'forget' },
              ...FILLERS.slice(0, 4).map((text) => ({ text, kind: 'filler' as const })),
              { text: SENTENCE_A, kind: 'tell' },
              ...FILLERS.slice(4).map((text) => ({ text, kind: 'filler' as const })),
              { text: '技术问题我喜欢怎么解释？', kind: 'probe' },
            ],
            leakProbes: [],
            discloseProbes: [{ turnIndex: 13, expected: '详细' }],
            oracleCheck: (m) => m.some((x) => x.status === 'active'),
            oracleDetail: '窗口外读回来自召回（修复前 #200：她诚实说不知道）',
          },
        ]

  const results: ScenarioResult[] = []
  for (const sc of scenarios) {
    console.log(`\n--- ${sc.id} ${sc.label} ---`)
    try {
      const result = await runScenario(sc)
      results.push(result)
      console.log(`  ${result.pass ? '✅' : '❌'} ${result.detail}`)
      for (const t of result.turns) {
        console.log(`    [${String(t.durationMs)}ms] ${t.text.slice(0, 24)} → ${t.reply.slice(0, 60).replace(/\n/g, ' ')}`)
      }
    } catch (error) {
      /* 失败档必须保留（计划 §7.3「失败档保留」，AGENTS §6.1）：
       * 场景抛错不能吞掉整轮证据 —— 记录为**失败场景**并继续，否则一次抛错让整轮
       * 只留下 controls.json（实测踩中：`m91-smoke-r1-20260927-08bb0dc`）。 */
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      console.error(`  ⚠️ ${sc.id} 抛错（记录为失败场景，继续）：${message}`)
      results.push({
        id: sc.id,
        label: sc.label,
        turns: [],
        oracle: { memories: [] },
        leakChecks: [],
        discloseChecks: [],
        pass: false,
        detail: `场景执行抛错（失败档保留，残缺）：${message}`,
      })
    }
  }

  /* 汇总 + 证据：正文进 local/；脱敏摘要（判定 + sha + 程序事实）进 artifacts/ */
  const realDbAfter = digestTree(PRODUCTION_DB_DIR)
  const dbUntouched = realDbBefore.treeSha256 === realDbAfter.treeSha256
  const passed = results.filter((r) => r.pass).length
  const failed = results.filter((r) => !r.pass).length
  console.log(`\n=== 轮 ${roundArg} 汇总：${String(passed)} 通过 / ${String(failed)} 失败 ===`)
  console.log(`真实库未动=${String(dbUntouched)}`)

  writeFileSync(
    join(localDir, 'transcripts.json'),
    JSON.stringify({ runId, round: roundArg, judge: JUDGE_VERSION, controls: { controlLeak, controlClean, controlEcho, controlParaphrase }, results }, null, 2),
    'utf8',
  )
  const summaryDir = join(ROOT, 'artifacts', 'm9.1', runId)
  mkdirSync(summaryDir, { recursive: true })
  writeFileSync(
    join(summaryDir, 'smoke-summary.json'),
    JSON.stringify(
      {
        gate: 'm9.1:smoke:live',
        instrument: SMOKE_INSTRUMENT,
        round: roundArg,
        runId,
        head,
        judge: JUDGE_VERSION,
        controlsOk,
        dbUntouched,
        passed,
        failed,
        scenarios: results.map((r) => ({
          id: r.id,
          label: r.label,
          pass: r.pass,
          detail: r.detail,
          leakChecks: r.leakChecks,
          discloseChecks: r.discloseChecks,
          oracle: r.oracle,
          turnCount: r.turns.length,
          replyHashes: r.turns.map((t) => sha256(t.reply)),
          localTranscript: join('artifacts', 'm9.1', 'local', runId, 'transcripts.json'),
        })),
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`正文：${join(localDir, 'transcripts.json')}（不入库）`)
  console.log(`摘要：${join(summaryDir, 'smoke-summary.json')}`)
  if (failed > 0 || !dbUntouched) process.exit(1)
}

await main()
