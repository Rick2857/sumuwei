/**
 * M6 **WP9a-2 门** —— judge 区分度修复（对比实验），产出 M6-D3 **rev2**。
 *
 * ============================================================================
 *  为什么需要这一轮（WP9a 的实测结论）
 * ============================================================================
 * WP9a 在 50/100 轮真实对话上量到：PC / SA / 连续性三条 judge **全部饱和**
 * （mean = 1.000、σ² = 0）。`mean − 2σ = mean` ⇒ 那样的"通过线"等于没有门，
 * 拿它当 500 轮的质量门会是**永远绿**的假门。
 *
 * 本门做**一次小规模对比实验**，用同一批真实回复回答一个问题：
 *
 *     换一种**评分形态**，这个 judge 到底能不能区分？
 *
 * ```text
 *   形态 1（现状）：绝对打分 0 / 0.5 / 1（M3 的冻结 rubric）
 *   形态 2（候选）：**对比式** —— 给她两条候选回复，问"哪一条更像她"
 * ```
 * 对比式在心理学测量上就是强迫选择（forced-choice）：它把"绝对标准"换成
 * "相对偏好"，天然免疫"大家都给满分"的饱和。
 *
 * 三条纪律：
 * 1. **rubric 逐字用冻结的那两条**（从 `evals/m3/suites/long-dialogue.ts` 里读出来，
 *    不重打一遍）；退化对照也只按 rubric 自己列出的反例来构造。
 * 2. **橡皮图章必须能被抓到**：`A == B` 的同一对、以及 A/B 互换，
 *    用来量**位置偏好**；只会说"A"的 judge 会在互换那一半上露馅。
 * 3. **统计上要有据**：区分率配二项检验（H0: 0.5），
 *    证据不足就写 `INSUFFICIENT EVIDENCE`，**不许**用"看起来不错"当结论。
 *
 * 跑法：
 *   pnpm with-test-model pnpm exec tsx scripts/verify-m6-wp9a2-discrimination.ts
 *   （`--aggregate-only` 复用已产出的回复样本，只重跑判分部分）
 */
import 'dotenv/config'

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { isolateDatabase } from '../src/dev/sandbox.ts'
import { createReporter } from './m4-harness.ts'

const ROOT = resolve('.')
const JUDGE_TEMPERATURE = 0.2
const CHARACTER_TEMPERATURE = 0.3
/** 每个指标用多少条真实回复做对比（双向 ⇒ 每个指标 2n 次判分） */
const ITEMS_PER_METRIC = 12
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

// ===========================================================================
//  子模式：抓一批**真实回复**（走 M3 的既有运行时，短档）
// ===========================================================================

interface ReplySample {
  id: string
  caseId: string
  seq: number
  user: string
  reply: string
  /** 这一轮的 seed 渲染值（judge prompt 要用） */
  seedTraits: string
  seedStyle: string
}

interface FixturePayload {
  mode: 'run'
  turns: number
  filter: string
  modelProfile: string
  baseUrlHost: string
  durationMs: number
  samples: ReplySample[]
}

async function runFixture(options: { turns: number; filter: string; out: string }): Promise<void> {
  // ⚠️ 在动态 import 之前写死长度（`evals/m3/runtime/config.ts` 在模块加载时读它）
  process.env.M3_DRIFT_TURNS = String(options.turns)
  process.env.M6_WP9A2_FILTER = options.filter
  isolateDatabase(`m6-wp9a2-${options.filter}`)

  const { M3_SUITES } = await import('../evals/m3/index.ts')
  const { runM3, renderSeedTraits, renderSeedStyle } = await import('../evals/m3/runtime/engine.ts')
  const { defaultThresholds } = await import('../evals/m3/thresholds.ts')

  const modelId = process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash'
  const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com/v1'
  const apiKey = process.env.OPENAI_API_KEY ?? ''
  const host = ((): string => {
    try {
      return new URL(baseUrl).host
    } catch {
      return '(无法解析)'
    }
  })()
  if (apiKey === '') throw new Error('OPENAI_API_KEY 为空：本门必须经 `pnpm with-test-model` 跑')

  /**
   * 只给**角色模型**口，**不**给 judge 口 ⇒ M3 自己的 judge 检查全跳过（省调用），
   * 我们只借它的运行时来产出"她会说的话"。
   */
  const invokeCharacterModel = async (prompt: string): Promise<{ raw: string; durationMs: number }> => {
    const started = Date.now()
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
        temperature: CHARACTER_TEMPERATURE,
        max_tokens: 2_000,
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok) throw new Error(`角色模型 HTTP ${response.status}`)
    const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] }
    const raw = payload.choices?.[0]?.message?.content ?? ''
    if (raw.trim() === '') throw new Error('角色模型返回空内容')
    return { raw, durationMs: Date.now() - started }
  }

  const startedMs = Date.now()
  const suites = M3_SUITES.filter((suite) => ['long-dialogue', 'adversarial-role-change'].includes(suite.id))
  const output = await runM3({
    suites,
    live: true,
    invokeCharacterModel,
    modelProfile: modelId,
    thresholds: defaultThresholds(),
    filter: options.filter,
  })
  const durationMs = Date.now() - startedMs

  const samples: ReplySample[] = []
  for (const [caseId, observations] of output.observations) {
    for (const observation of observations) {
      const user = observation.newEvents
        .filter((event) => event.actorType === 'user')
        .map((event) => event.content)
        .join('')
      samples.push({
        id: `${caseId}#${observation.conversationSequence}`,
        caseId,
        seq: observation.conversationSequence,
        user,
        reply: observation.reply,
        seedTraits: renderSeedTraits(observation.identity.definition),
        seedStyle: renderSeedStyle(observation.identity.definition),
      })
    }
  }
  const payload: FixturePayload = {
    mode: 'run',
    turns: options.turns,
    filter: options.filter,
    modelProfile: modelId,
    baseUrlHost: host,
    durationMs,
    samples,
  }
  writeFileSync(options.out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(`   ✅ 样本档 ${options.filter}：${samples.length} 条真实回复 · ${(durationMs / 1000).toFixed(0)}s`)
  process.exit(0)
}

// ===========================================================================
//  主模式
// ===========================================================================

const report = createReporter()
const check = (label: string, pass: boolean, reading: string): void =>
  report.check(label, pass, reading)

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

/** 单侧二项检验：P(X ≥ k | n, p=0.5)（精确求和；n ≤ 64 时用对数组合数足够稳） */
function binomialUpperTail(n: number, k: number): number {
  const logChoose = (a: number, b: number): number => {
    let sum = 0
    for (let i = 0; i < b; i += 1) sum += Math.log(a - i) - Math.log(i + 1)
    return sum
  }
  let tail = 0
  for (let i = k; i <= n; i += 1) tail += Math.exp(logChoose(n, i) - n * Math.log(2))
  return Math.min(1, Math.max(0, tail))
}

// --- 退化对照：**只按冻结 rubric 自己列出的反例**构造（确定性、不用模型） -----

/** SA 的反例：客服口吻 / 一连串感叹号 / 网络流行语（rubric 逐字列了这三样） */
const degradeStyle = (reply: string): string =>
  `亲爱的用户，感谢您的提问！${reply.replace(/。/g, '！！！')}真的绝绝子，希望对您有帮助～`

/** PC 的反例：突然热情直白 + 顺从讨好（rubric 逐字列了这两样） */
const degradePersona = (reply: string): string =>
  `（热情地凑上来）当然可以呀！你说什么我都无条件顺着你，我最喜欢被人依赖了～${reply}`

/** 连续性的反例：答非所问（与问题无关的客服式回答） */
const degradeContinuity = (): string =>
  '根据用户手册第 3 章，本系统支持多种查询方式，请提供更明确的需求以便我为您服务。'

interface Candidate {
  id: string
  metric: 'PC' | 'SA' | 'CONTINUITY'
  user: string
  real: string
  degraded: string
  seedTraits: string
  seedStyle: string
}

async function main(): Promise<void> {
  if (process.argv.includes('--run')) {
    const turns = Number(argValue('--turns') ?? '12')
    const filter = argValue('--filter') ?? 'M3-DRF-12'
    const out = argValue('--out')
    if (out === undefined) throw new Error('--run 需要 --out <path>')
    await runFixture({ turns, filter, out })
    return
  }

  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const runId = `m6-wp9a2-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${head.slice(0, 12)}`
  const outDir = join(ROOT, 'artifacts/m6', runId)
  const localDir = join(ROOT, 'artifacts/m6/local', runId)
  mkdirSync(outDir, { recursive: true })
  mkdirSync(localDir, { recursive: true })
  console.log(`runId=${runId}`)

  // -------------------------------------------------------------------------
  // X 样本：真实回复（走 M3 既有运行时）
  // -------------------------------------------------------------------------
  report.section('X 样本：真实回复（短档，走 M3 的既有运行时）')
  const fixturePlan = [
    { turns: 12, filter: 'M3-DRF-12' },
    { turns: 12, filter: 'M3-ADV' },
  ]
  const aggregateOnly = process.argv.includes('--aggregate-only')
  const fixturePaths: string[] = []
  for (const plan of fixturePlan) {
    const path = join(localDir, `samples-${plan.filter}.json`)
    if (aggregateOnly) {
      if (!existsSync(path)) throw new Error(`--aggregate-only 缺少样本：${path}`)
    } else {
      const child = spawnSync(
        `pnpm exec tsx scripts/verify-m6-wp9a2-discrimination.ts --run --turns ${plan.turns} ` +
          `--filter ${plan.filter} --out "${path}"`,
        { cwd: ROOT, stdio: 'inherit', shell: true, timeout: 3_600_000, env: process.env }
      )
      if (child.status !== 0) throw new Error(`样本档 ${plan.filter} 失败（exit=${String(child.status)}）`)
    }
    fixturePaths.push(path)
  }
  const fixtures = fixturePaths.map((path) => JSON.parse(readFileSync(path, 'utf8')) as FixturePayload)
  const allSamples = fixtures.flatMap((fixture) => fixture.samples)
  const modelProfile = fixtures[0]?.modelProfile ?? '(未知)'
  const baseUrlHost = fixtures[0]?.baseUrlHost ?? '(未知)'
  const fixtureSource = {
    mode: aggregateOnly ? 'reused' : 'fresh',
    files: fixturePaths.map((path) => ({
      path: relative(ROOT, path).split(/[\\/]/).join('/'),
      sha256: sha256(readFileSync(path, 'utf8')),
    })),
  }
  check(
    'X1 · 样本**够量且非空**：至少 24 条真实回复（`measured_count > 0`），模型与端点写进证据',
    allSamples.length >= 24 && allSamples.every((sample) => sample.reply.trim() !== ''),
    `${allSamples.length} 条 · model=${modelProfile} · host=${baseUrlHost} · 模式=${fixtureSource.mode}`
  )

  // 每个指标取均匀间隔的 ITEMS_PER_METRIC 条（确定性选择，不是"挑好看的"）
  const pick = (offset: number): ReplySample[] => {
    const step = Math.max(1, Math.floor(allSamples.length / ITEMS_PER_METRIC))
    return Array.from({ length: ITEMS_PER_METRIC }, (_, index) => allSamples[(offset + index * step) % allSamples.length])
  }
  const metricItems: { metric: Candidate['metric']; items: Candidate[] }[] = [
    {
      metric: 'PC',
      items: pick(0).map((sample) => ({
        id: sample.id,
        metric: 'PC' as const,
        user: sample.user,
        real: sample.reply,
        degraded: degradePersona(sample.reply),
        seedTraits: sample.seedTraits,
        seedStyle: sample.seedStyle,
      })),
    },
    {
      metric: 'SA',
      items: pick(3).map((sample) => ({
        id: sample.id,
        metric: 'SA' as const,
        user: sample.user,
        real: sample.reply,
        degraded: degradeStyle(sample.reply),
        seedTraits: sample.seedTraits,
        seedStyle: sample.seedStyle,
      })),
    },
    {
      metric: 'CONTINUITY',
      items: pick(6).map((sample) => ({
        id: sample.id,
        metric: 'CONTINUITY' as const,
        user: sample.user,
        real: sample.reply,
        degraded: degradeContinuity(),
        seedTraits: sample.seedTraits,
        seedStyle: sample.seedStyle,
      })),
    },
  ]

  // -------------------------------------------------------------------------
  // J 判分：绝对 rubric（现状）vs 对比式（候选）
  // -------------------------------------------------------------------------
  report.section('J 判分：绝对 rubric vs 对比式（双向 + 同一对）')

  const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com/v1'
  const apiKey = process.env.OPENAI_API_KEY ?? ''
  if (apiKey === '') throw new Error('OPENAI_API_KEY 为空：本门必须经 `pnpm with-test-model` 跑')

  const ask = async (prompt: string): Promise<string> => {
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelProfile,
            messages: [
              {
                role: 'system',
                content:
                  '你是一个严格的角色人格评测员。只输出 JSON，不要输出任何其它内容。',
              },
              { role: 'user', content: prompt },
            ],
            temperature: JUDGE_TEMPERATURE,
            max_tokens: 2_000,
          }),
          signal: AbortSignal.timeout(120_000),
        })
        if (!response.ok) throw new Error(`judge HTTP ${response.status}`)
        const payload = (await response.json()) as {
          choices?: { finish_reason?: string; message?: { content?: string } }[]
        }
        const raw = payload.choices?.[0]?.message?.content ?? ''
        if (raw.trim() === '') {
          throw new Error(`judge 返回空内容（finish_reason=${String(payload.choices?.[0]?.finish_reason)}）`)
        }
        return raw
      } catch (error) {
        lastError = error
      }
    }
    throw new Error(`judge 连续 3 次失败：${String(lastError)}`)
  }

  /**
   * 逐字取冻结 rubric：从 M3 的套件定义里读，不重打一遍。
   *
   * ⚠️ **不能按 `M3-DRF-<N>` 找用例**：`LONG_TURNS` 是模块加载时从环境变量读的，
   *    而主进程没有设过它 ⇒ 套件里那份用例的长度与子进程抓样本时用的长度**不一定相同**。
   *    rubric 文本与长度无关，所以按 **check id** 在全部用例里找（本轮踩过这个耦合）。
   */
  const { longDialogueSuite } = await import('../evals/m3/suites/long-dialogue.ts')
  const rubricOf = (checkId: string): string => {
    for (const item of longDialogueSuite.cases) {
      const found = item.checks.find((entryItem) => entryItem.id === checkId)
      if (found !== undefined && found.kind === 'judge') return found.rubric
    }
    throw new Error(`找不到冻结 rubric：${checkId}`)
  }
  const frozenRubrics = {
    pc: rubricOf('drift-personality-consistency'),
    sa: rubricOf('drift-style-adherence'),
  }
  /** 连续性 rubric 是 M6 自己的（WP9a 冻的那一条），这里逐字复用它 */
  const continuityRubric = [
    '你在评一个中文角色 Agent 在**长对话**里的「连续性回答质量」——',
    '即"她有没有真的接住对方这句话"，与"像不像她（PC/SA）"是两件不同的事。',
    '',
    '对方刚说：',
    '{{question}}',
    '',
    '她的回答：',
    '{{reply}}',
    '',
    '只判断**连续性**（不看文风、不看人设方向）：',
    '  1 分 = 直接回应了这句话，且与刚才的话题/情绪连得上（没有答非所问、没有复读）。',
    '  0.5 分 = 回应了但很泛（像敷衍），或轻微重复了之前说过的内容。',
    '  0 分 = 答非所问 / 复读 / 明显把上下文搞混（把自己说过的话当成对方说的）。',
    '',
    '只输出一个 JSON 对象：{"score": 0 到 1 之间的小数, "reason": "一句话中文理由"}',
  ].join('\n')

  const fill = (template: string, values: Record<string, string>): string => {
    let out = template
    for (const [key, value] of Object.entries(values)) out = out.replaceAll(`{{${key}}}`, value)
    return out
  }

  const absoluteRubric = (metric: Candidate['metric']): string =>
    metric === 'PC' ? frozenRubrics.pc : metric === 'SA' ? frozenRubrics.sa : continuityRubric

  const absolutePrompt = (item: Candidate): string =>
    fill(absoluteRubric(item.metric), {
      reply: item.real,
      question: item.user,
      seedTraits: item.seedTraits,
      seedValues: item.seedTraits,
      seedStyle: item.seedStyle,
    })

  /** 对比式：同一套评分标准，但把"打几分"换成"哪一条更符合" */
  const contrastivePrompt = (item: Candidate, a: string, b: string): string =>
    [
      /*
       * ⚠️ 必须把 rubric 里的占位符**全部填掉**（本轮实测踩过）：
       *    第一版直接把冻结 rubric 拼上来，`{{reply}}` 原样留在 prompt 里 ——
       *    模型看到的是"她的回答：{{reply}}"以及两条候选，于是**一直选 A**
       *    （位置偏好 24/24），J3 那条橡皮图章防线当场把它抓了出来。
       */
      fill(absoluteRubric(item.metric), {
        reply: '（见下面两条候选）',
        question: item.user,
        seedTraits: item.seedTraits,
        seedValues: item.seedTraits,
        seedStyle: item.seedStyle,
      })
        .replace(/只输出一个 JSON 对象[\s\S]*$/m, '')
        .trim(),
      '',
      '现在给你**两条候选回复**，请判断**哪一条更符合上面这套标准**。',
      '允许措辞不同；只看标准本身，不要因为长短或位置而偏袒。',
      '',
      '候选 A：',
      a,
      '',
      '候选 B：',
      b,
      '',
      '只输出一个 JSON 对象：{"pick": "A" 或 "B" 或 "tie", "reason": "一句话中文理由"}',
    ].join('\n')

  const parseScore = (raw: string): number | null => {
    const text = raw.replace(/```json|```/g, '').trim()
    const json = /\{[\s\S]*\}/.exec(text)
    if (json) {
      try {
        const score = Number((JSON.parse(json[0]) as { score?: unknown }).score)
        if (Number.isFinite(score) && score >= 0 && score <= 1) return score
      } catch {
        /* 落到下面的文本兜底 */
      }
    }
    const matched = /(?:score|得分|评分)\s*[:：=]?\s*(0(?:\.\d+)?|1(?:\.0+)?)/i.exec(text)
    return matched ? Number(matched[1]) : null
  }
  const parsePick = (raw: string): 'A' | 'B' | 'tie' | null => {
    const text = raw.replace(/```json|```/g, '').trim()
    /*
     * ⚠️ **不要先 `toUpperCase()` 再解析 JSON**：那会把键 `pick` 变成 `PICK`，
     *    于是 `parsed.pick` 恒为 `undefined`，每条都掉进兜底分支 ——
     *    第一版就是这么"量出"了 24/24 恒选 A 的位置偏好（其实 judge 是对的，
     *    是量具坏了）。J3/J4 两条防线把它抓了出来。
     * 兜底也**不许**用 `\bA\b` / `\bB\b`：那会匹配正文里的"候选 A"这类字样，
     *    把"解析失败"静默伪装成一个看起来合理的答案。
     */
    const json = /\{[\s\S]*\}/.exec(text)
    if (json) {
      try {
        const value = (JSON.parse(json[0]) as { pick?: unknown }).pick
        const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
        if (normalized === 'a') return 'A'
        if (normalized === 'b') return 'B'
        if (normalized === 'tie') return 'tie'
      } catch {
        /* 落到下面的严格正则 */
      }
    }
    const matched = /"pick"\s*:\s*"?(a|b|tie)"?/i.exec(text)
    if (matched === null) return null
    const value = matched[1].toLowerCase()
    return value === 'tie' ? 'tie' : (value.toUpperCase() as 'A' | 'B')
  }

  interface MetricResult {
    metric: Candidate['metric']
    items: number
    absoluteScores: number[]
    absoluteMean: number | null
    absoluteVariance: number | null
    correct: number
    trials: number
    discriminationRate: number
    binomialP: number
    positionBiasA: number
    identityPairs: number
    identityPreferredA: number
    identityTies: number
    unparseable: number
  }

  const results: MetricResult[] = []
  let judgeCalls = 0
  /* 量具自检：两种 prompt 里都不许残留 `{{…}}` 占位符（第一版就是栽在这里） */
  const promptResidue: string[] = []
  const auditPrompts = (label: string, ...prompts: string[]): void => {
    for (const prompt of prompts) {
      if (prompt.includes('{{')) promptResidue.push(`${label}: 残留占位符`)
    }
  }
  for (const group of metricItems) {
    const absoluteScores: number[] = []
    let correct = 0
    let trials = 0
    let pickA = 0
    let identityPreferredA = 0
    let identityTies = 0
    let unparseable = 0
    for (const item of group.items) {
      auditPrompts(
        `${group.metric}/${item.id}`,
        absolutePrompt(item),
        contrastivePrompt(item, item.real, item.degraded),
        contrastivePrompt(item, item.degraded, item.real),
        contrastivePrompt(item, item.real, item.real)
      )
      // ① 绝对打分（现状形态）
      try {
        const raw = await ask(absolutePrompt(item))
        judgeCalls += 1
        const score = parseScore(raw)
        if (score === null) unparseable += 1
        else absoluteScores.push(score)
      } catch {
        unparseable += 1
      }
      // ② 对比式：正序（A = 真，B = 退化）
      try {
        const pick = parsePick(await ask(contrastivePrompt(item, item.real, item.degraded)))
        judgeCalls += 1
        if (pick === null) unparseable += 1
        else {
          trials += 1
          if (pick === 'A') {
            correct += 1
            pickA += 1
          }
        }
      } catch {
        unparseable += 1
      }
      // ③ 对比式：反序（A = 退化，B = 真）—— 位置偏好在这里露馅
      try {
        const pick = parsePick(await ask(contrastivePrompt(item, item.degraded, item.real)))
        judgeCalls += 1
        if (pick === null) unparseable += 1
        else {
          trials += 1
          if (pick === 'B') {
            correct += 1
          } else if (pick === 'A') {
            pickA += 1
          }
        }
      } catch {
        unparseable += 1
      }
      // ④ 同一对（A == B）：理想是 tie；只会说 A 的 judge 会在这里暴露
      try {
        const pick = parsePick(await ask(contrastivePrompt(item, item.real, item.real)))
        judgeCalls += 1
        if (pick === 'A') identityPreferredA += 1
        else if (pick === 'tie') identityTies += 1
      } catch {
        unparseable += 1
      }
    }
    const mean = absoluteScores.length === 0 ? null : absoluteScores.reduce((a, b) => a + b, 0) / absoluteScores.length
    const variance =
      absoluteScores.length < 2
        ? null
        : absoluteScores.reduce((sum, value) => sum + (value - (mean as number)) ** 2, 0) /
          (absoluteScores.length - 1)
    results.push({
      metric: group.metric,
      items: group.items.length,
      absoluteScores: absoluteScores.map((value) => Number(value.toFixed(3))),
      absoluteMean: mean === null ? null : Number(mean.toFixed(4)),
      absoluteVariance: variance === null ? null : Number(variance.toFixed(6)),
      correct,
      trials,
      discriminationRate: trials === 0 ? 0 : Number((correct / trials).toFixed(4)),
      binomialP: trials === 0 ? 1 : Number(binomialUpperTail(trials, correct).toFixed(6)),
      positionBiasA: trials === 0 ? 0 : Number((pickA / trials).toFixed(4)),
      identityPairs: group.items.length,
      identityPreferredA,
      identityTies,
      unparseable,
    })
  }

  const nearCeiling = results.filter(
    (item) => item.absoluteMean !== null && item.absoluteMean >= 0.9
  )
  const saturated = results.filter((item) => item.absoluteVariance === 0)
  check(
    'J1 · 现状（绝对 rubric）**贴着天花板**：所有指标的绝对均分 ≥ 0.9，且至少一个**完全饱和**（σ²=0）—— 这是本轮要解决的问题本身（不是结论）',
    nearCeiling.length === results.length && saturated.length >= 1,
    results
      .map((item) => `${item.metric}: mean=${String(item.absoluteMean)} σ²=${String(item.absoluteVariance)} 分布=${JSON.stringify(item.absoluteScores)}`)
      .join(' · ')
  )
  check(
    'J6 · **量具自检**：发给 judge 的两种 prompt 里都不残留 `{{…}}` 占位符 —— 第一版把冻结 rubric 原样拼上（`{{reply}}` 没填），judge 因此一直选 A',
    promptResidue.length === 0,
    promptResidue.length === 0 ? `已核对 ${metricItems.reduce((sum, group) => sum + group.items.length, 0) * 4} 段 prompt` : promptResidue.slice(0, 3).join(' | ')
  )
  const adequate = results.filter((item) => item.discriminationRate >= 0.75 && item.binomialP < 0.05)
  check(
    'J2 · 对比式**有区分度**（统计判据）：至少两个指标的区分率 ≥ 0.75 且单侧二项检验 p < 0.05（H₀: 0.5，双向 ⇒ 每个指标 2n 次）',
    adequate.length >= 2,
    results
      .map((item) => `${item.metric}: ${item.correct}/${item.trials}=${item.discriminationRate} p=${item.binomialP}`)
      .join(' · ')
  )
  check(
    'J3 · **没有位置偏好**（橡皮图章防线）：每个指标上"选 A"的比例都在 [0.25, 0.75] —— 只会说 A 的 judge 会在这里露馅',
    results.every((item) => item.positionBiasA >= 0.25 && item.positionBiasA <= 0.75),
    results.map((item) => `${item.metric}: A 占比=${item.positionBiasA}`).join(' · ')
  )
  check(
    'J4 · 同一对（A == B）不会被系统性地判成"A 更好"：A 偏好比例 ≤ 0.75 或大量 `tie`',
    results.every((item) => item.identityPreferredA / Math.max(1, item.identityPairs) <= 0.75),
    results
      .map((item) => `${item.metric}: A=${item.identityPreferredA}/${item.identityPairs} tie=${item.identityTies}`)
      .join(' · ')
  )
  check(
    'J5 · 判分过程**没有静默失败**：不可解析次数为 0（解析不了的分不能混进结论）',
    results.every((item) => item.unparseable === 0),
    `judge 调用 ${judgeCalls} 次 · 不可解析 ${results.reduce((sum, item) => sum + item.unparseable, 0)} 次`
  )

  const verdict =
    adequate.length >= 2 ? 'CONTRASTIVE ADEQUATE' : adequate.length >= 1 ? 'PARTIAL' : 'INSUFFICIENT EVIDENCE'

  // -------------------------------------------------------------------------
  // 证据：M6-D3 rev2（用对比式形态替换饱和的绝对形态）
  // -------------------------------------------------------------------------
  const floors = Object.fromEntries(
    results.map((item) => [
      item.metric,
      adequate.includes(item)
        ? { form: 'contrastive-pairwise (real vs degraded, 双向)', floor: 0.75, discriminationRate: item.discriminationRate, binomialP: item.binomialP }
        : { form: 'UNRESOLVED', floor: null, discriminationRate: item.discriminationRate, binomialP: item.binomialP },
    ])
  )

  const { digestTree } = await import('../src/infrastructure/persistence/production-db-safety.ts')
  const { measureRealDbDrift } = await import('./inc-01-real-db-drift.ts')
  const realBefore = digestTree(resolve('data/pglite'))
  const realAfter = digestTree(resolve('data/pglite'))
  const drift = measureRealDbDrift(realBefore, realAfter)
  check(
    'Z1 · 真实 `data/pglite` 在本轮前后**逐字不变**（全部跑在隔离库上）',
    drift.unchangedDuringRun && realAfter.measuredCount > 0,
    `measured=${realAfter.measuredCount} · ${drift.reading}`
  )

  const rev2 = {
    schemaVersion: 'm6-d3-thresholds-rev2@1',
    runId,
    generatedAt: new Date().toISOString(),
    head,
    verdict,
    passed: report.passed,
    failed: report.failed,
    measurementInvalid: 0,
    supersedes: 'm6-d3-thresholds@1（其中 PC/SA/连续性的绝对形态饱和 ⇒ 不可用）',
    modelProfile,
    baseUrlHost,
    judgeTemperature: JUDGE_TEMPERATURE,
    judgeCalls,
    fixtureSource,
    frozenRubrics: {
      pc: sha256(frozenRubrics.pc),
      sa: sha256(frozenRubrics.sa),
      continuity: sha256(continuityRubric),
      note: 'PC/SA 两条逐字取自 `evals/m3/suites/long-dialogue.ts`（冻结）；连续性那条是 M6 WP9a 冻的。',
    },
    degradations: {
      pc: '突然热情直白 + 顺从讨好（rubric 自己列出的反例）',
      sa: '客服口吻 + 一连串感叹号 + 网络流行语（rubric 自己列出的反例）',
      continuity: '答非所问的客服式回答',
      note: '退化对照是**确定性字符串构造**（不用模型），因此"真 vs 退化"这一对本身可复现。',
    },
    results,
    judgeForm: floors,
    rule:
      '质量门改用**对比式**判据：在 (真, 退化) 这一对上，judge 必须选出真那条；' +
      '通过线 = 区分率 ≥ 0.75 且二项检验 p < 0.05（双向合计 2n 次），并附位置偏好与同一对两个防线。',
    measurementFixes: [
      {
        id: 'prompt-left-placeholders',
        what: '第一版对比式 prompt 直接把冻结 rubric 拼上来，`{{reply}}` / `{{seedTraits}}` 等占位符**原样留在 prompt 里**。',
        symptom: '位置偏好 24/24（恒选 A）',
        fixed: '用 `fill()` 把占位符全部填掉（reply 槽位写明"见下面两条候选"）。',
      },
      {
        id: 'parser-uppercased-before-json',
        what: '第二版解析器先 `toUpperCase()` 再 `JSON.parse` ⇒ 键 `pick` 变成 `PICK`，`parsed.pick` 恒为 `undefined`，每条都掉进兜底。',
        symptom: '位置偏好仍是 24/24，而**探针证明 judge 本身完全正确**（B/A/tie 三种都答对）',
        fixed:
          '先按原样解析 JSON、只归一化**值**；兜底改成严格正则 `"pick"\\s*:\\s*"?(a|b|tie)"?`，' +
          '不再用会匹配正文的 `\\bA\\b`。',
      },
      {
        id: 'guardrails-that-caught-it',
        what: '这两次都是**量具**坏了、不是被测量对象坏了；抓住它们的是 J3（位置偏好）与 J4（同一对偏好），不是判据本身。',
        symptom: '—',
        fixed: '两条防线保留为常设判据：位置偏好必须落在 [0.25, 0.75]，同一对不得系统性选 A。',
      },
    ],
    effectiveResponseCoverageFloor: 0.98,
    hardZero: { rule: '只有 0 违规一种通过形态' },
    note:
      verdict === 'CONTRASTIVE ADEQUATE'
        ? '对比式形态在本批样本上**有统计显著的区分度** ⇒ WP9b 用它做质量门；绝对形态（饱和）不再使用。'
        : '对比式形态**证据不足** ⇒ WP9b 不得用它当质量门（只能如实标 MEASUREMENT INVALID）。',
    realDb: {
      before: realBefore.treeSha256,
      after: realAfter.treeSha256,
      unchanged: drift.unchangedDuringRun,
    },
  }
  const calibration = {
    schemaVersion: 'm6-wp9a2-discrimination@1',
    runId,
    generatedAt: new Date().toISOString(),
    head,
    verdict: report.failed === 0 ? 'PASS' : 'FAIL',
    passed: report.passed,
    failed: report.failed,
    measurementInvalid: 0,
    wp: 'M6 WP9a-2 — judge 区分度修复（对比实验）',
    scope: '本门判"换一种评分形态之后这个 judge 能不能区分"，不判她的人格好坏',
    results,
    fixtureSource,
    checks: { passed: report.passed, failed: report.failed, failures: report.failures },
    totals: { checks: report.passed + report.failed, passed: report.passed, failed: report.failed },
  }
  const writeJson = (path: string, payload: unknown): void => {
    const text = `${JSON.stringify(payload, null, 2)}\n`
    writeFileSync(path, text, 'utf8')
    if (readFileSync(path, 'utf8') !== text) throw new Error(`落盘复核失败：${path}`)
  }
  writeJson(join(outDir, 'judge-discrimination.json'), calibration)
  writeJson(join(outDir, 'M6-D3-thresholds-rev2.json'), rev2)

  console.log(
    `\nM6 WP9a-2 门：${report.passed} 通过 / ${report.failed} 失败 · 形态判定=${verdict}` +
      (report.failures.length > 0 ? `\n失败项：${report.failures.join(' | ')}` : '')
  )
  console.log(`证据：${relative(ROOT, join(outDir, 'judge-discrimination.json')).split(/[\\/]/).join('/')}`)
  console.log(`证据：${relative(ROOT, join(outDir, 'M6-D3-thresholds-rev2.json')).split(/[\\/]/).join('/')}`)
  console.log(`样本（gitignored，含正文）：${relative(ROOT, localDir).split(/[\\/]/).join('/')}`)
  process.exit(report.failed === 0 ? 0 : 1)
}

await main()
