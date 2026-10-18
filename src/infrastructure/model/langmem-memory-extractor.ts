import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { registeredPredicates } from '../../kernel/contracts/index.ts'
import { qualificationEstablishesUserFact, sourceQualificationOf } from '../../kernel/contracts/attribution.ts'
import { isQuestionLike } from '../../kernel/app/memory/content-extractor.ts'
import { detectByRule } from '../../kernel/app/memory/intent-detector.ts'
import { parseCandidatesJson, resolveCandidates, type MemoryExtractor, type MemoryExtractionInput, type MemoryExtractionResult } from '../../kernel/app/memory/extractor.ts'

export const AUTOMATIC_MEMORY_PROCESSOR = 'automatic-memory-langmem'
export const AUTOMATIC_MEMORY_VERSION = 'automatic-memory-langmem@1'

/**
 * ============================================================================
 *  Worker 失败的**具名原因**（2026-10-16 · 部署前定位用）
 * ============================================================================
 *
 *  改这一段的理由（**一个已观测到的真问题**）：
 * `artifacts/post-lv2/local/server-capacity-20261016/full-run/job-statuses.json`
 * 之外，容量测试报告记了 2 个 `automatic_memory_extraction_or_commit_failed`，
 * 而**当时定位不了** —— 原因不在数据不够，在**信息在抛出点就被销毁了**：
 *
 *   ① `invokeWorker` 把四种**完全不同**的失败压成同一个错误串
 *      （超时 / 被取消 / 非零退出 / 输出超预算），且 `signal.aborted`
 *      **分不清**是 40s 超时还是外部取消；
 *   ② python 的 stderr 被**主动丢弃**（隐私决定，**该保留**）⇒ 连异常类型都没有；
 *   ③ `automatic-memory.ts` 用 `catch {}` 把 ① 的结果也丢了。
 *
 * ⇒ 三层叠加 ⇒ 一次"超时"和一次"Python 崩溃"在账上长得**一模一样**。
 *
 * 这一层只做一件事：**把原因分类记下来**。
 * 它**不新增**任何出站、**不保留** stderr 正文、**不改变**既有成功路径。
 *
 * ⚠️ `exitCode` 是**数字**，不是用户内容 ⇒ 记进读数是安全的。
 * ⚠️ 与既有纪律同型：QQ 主动联系那一批修过第 ④ 类缺陷
 *    （"量具自己丢了 stderr、失败只回具名码不记人读理由"）—— 同一形状。
 */
export type LangMemWorkerFailureReason =
  /** python 进程根本没起来（解释器路径错 / venv 缺失 / 权限） */
  | 'spawn_failed'
  /** 超过 40s 硬期限（CPU 争用下的头号嫌疑，**但仍只是嫌疑**） */
  | 'timeout'
  /** 外部取消（轮次被取消 / 收尾） */
  | 'cancelled'
  /** 非零退出；带**退出码**（数字，非内容） */
  | 'exit_nonzero'
  /** stdout 超过 32 000 字符上限，子进程已被杀 */
  | 'output_over_budget'
  /** stdin 写失败（对端早退） */
  | 'stdin_failed'
  /** 关闭时信号处于已取消但分不清来源 */
  | 'aborted'

/** 带**具名原因**（且**不含**任何用户内容）的 worker 失败 */
export class LangMemWorkerFailure extends Error {
  constructor(readonly reason: LangMemWorkerFailureReason, readonly exitCode: number | null = null) {
    // 消息里只放**具名码**与退出码；**不放** stderr、不放 stdout、不放请求内容。
    super(`automatic_memory_worker_failed:${reason}${exitCode === null ? '' : `:exit=${String(exitCode)}`}`)
  }
}

/** Only returns native candidates; upstream never receives a storage handle. */
export class LangMemMemoryExtractor implements MemoryExtractor {
  readonly name = AUTOMATIC_MEMORY_PROCESSOR
  readonly version = AUTOMATIC_MEMORY_VERSION

  constructor(private readonly input: { python: string; signal?: AbortSignal }) {}

  async process(input: MemoryExtractionInput): Promise<MemoryExtractionResult> {
    const views = input.views.filter((view) => view.actorType === 'user'
      && qualificationEstablishesUserFact(sourceQualificationOf(view.trustedOrigin))
      && view.actorId === String(input.speaker.id) && !isQuestionLike(view.content)
      && detectByRule(view.content) === undefined)
    if (views.length === 0) return { candidates: [], rejected: [], extracted: false }
    if (views.length !== 1 || views[0]!.content.length > 8000) throw new Error('automatic_memory_source_budget')
    const raw = await invokeWorker(this.input, JSON.stringify({
      events: views.map(({ sequence, content }) => ({ sequence, actor: 'USER', content })),
      predicates: registeredPredicates().map(({ key, description, valueShape, allowed }) => ({ key, description, valueShape, allowed })),
    }))
    const descriptors = parseCandidatesJson(raw)
    const envelope = JSON.parse(raw) as { candidates?: { evidenceQuotes?: { sequence: number; quote: string }[] }[] }
    if (descriptors === undefined || !Array.isArray(envelope.candidates)
      || descriptors.length !== envelope.candidates.length || descriptors.length > 4) {
      throw new Error('automatic_memory_malformed_output')
    }
    const keys = new Set(registeredPredicates().map(({ key }) => key))
    const rejected: MemoryExtractionResult['rejected'] = []
    const grounded = descriptors.filter((candidate, index) => {
      const quotes = envelope.candidates![index]?.evidenceQuotes
      const spec = registeredPredicates().find(({ key }) => key === candidate.claim?.predicate)
      const valid = candidate.subjectToken === 'USER'
        && ['person_fact', 'preference', 'episode'].includes(candidate.memoryType)
        && (candidate.claim === undefined || keys.has(candidate.claim.predicate))
        && candidate.evidenceEventSequences.length === 1
        && candidate.evidenceEventSequences[0] === views[0]!.sequence
        && quotes?.length === 1 && quotes[0]!.sequence === views[0]!.sequence
        && typeof quotes[0]!.quote === 'string' && quotes[0]!.quote.trim().length >= 2
        && views[0]!.content.includes(quotes[0]!.quote)
        && (candidate.claim === undefined || (spec?.valueShape === 'text'
          ? typeof candidate.claim.value === 'string' && quotes[0]!.quote.includes(candidate.claim.value)
          : spec?.allowed?.includes(String(candidate.claim.value)) === true))
        && (candidate.episode === undefined || candidate.episode.participantTokens.every((p) => p === 'USER'))
      if (!valid) rejected.push({ reason: 'automatic_memory_ungrounded', detail: 'candidate failed source, quote or registered-slot checks' })
      return valid
    })
    const resolved = resolveCandidates(grounded, { owner: input.owner, speaker: input.speaker,
      events: views, processor: this.name, processorVersion: this.version })
    const candidates = resolved.flatMap((result) => {
      if (result.ok) return [result.candidate]
      rejected.push(result.rejection)
      return []
    })
    return { candidates, rejected, extracted: candidates.length > 0 }
  }
}

/*
 * ⚠️ 2026-10-16 · **部署前复核推翻并修正了第一版**。
 *
 * 复核（artifacts/post-lv2/local/server-capacity-20261016/deploy-review/REVIEW.md §1）
 * 指出第一版有两处判错，本机探针逐条坐实：
 *
 * ① **`child.on('error')` 会抢跑。** `spawn(..., {signal})` 被信号中止时会发
 *    一个 **`name === 'AbortError'`** 的 `'error'`。第一版写的是无条件的
 *    `reason ??= 'spawn_failed'` ⇒ **超时与取消都被标成 spawn_failed**，
 *    后面判 `deadline` / `external` 的分支**根本到不了**。
 *
 * ② **`code !== 0` 会抢在信号判定之前。** 被信号杀掉的子进程 `code` 是 **`null`**，
 *    而 `null !== 0` 为真 ⇒ 就算 ① 修好了，超时仍会被标成 `exit_nonzero`。
 *    ⇒ **判据必须是 `code === null`（被信号杀）与"正常非零退出"分开。**
 *
 * 这两条合起来的后果很严重：**第一版并没有真的修好那个"定位不了"** ——
 * 三种失败在账上还是长得一样。门当时也没抓到，因为它只测了手工构造的
 * `LangMemWorkerFailure` 映射表，**从没驱动过这个函数本身**。
 *
 * 现在：`invokeWorker` 被导出并允许注入期限/脚本，门可以**真的**触发四种失败。
 */
export interface InvokeWorkerInput {
  python: string
  signal?: AbortSignal
  /** 硬期限（毫秒）。缺省 40s；**门会用很小的值真的把它逼到超时**。 */
  timeoutMs?: number
  /** worker 脚本路径。缺省是正式的抽取器脚本。 */
  workerScript?: string
}

export function invokeWorker(input: InvokeWorkerInput, request: string): Promise<string> {
  return new Promise((accept, reject) => {
    const deadline = AbortSignal.timeout(input.timeoutMs ?? 40_000)
    const external = input.signal
    const signal = AbortSignal.any(external ? [deadline, external] : [deadline])
    const child = spawn(input.python, ['-X', 'utf8', input.workerScript ?? resolve('scripts/automatic_memory_langmem.py')], {
      windowsHide: true, signal, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OPENAI_MODEL: process.env.OPENAI_LARGE_MODEL,
        LANGCHAIN_TRACING_V2: 'false', LANGSMITH_TRACING: 'false' },
    })
    let output = ''
    let reason: LangMemWorkerFailureReason | undefined
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
      if (output.length > 32_000) { reason ??= 'output_over_budget'; child.kill() }
    })
    // Provider error bodies can contain sensitive source text. Do not retain stderr.
    child.stderr.resume()
    child.stdin.on('error', () => { reason ??= 'stdin_failed' })
    child.on('error', (error: NodeJS.ErrnoException) => {
      /*
       * ⚠️ **这里必须特判 AbortError。**
       *   signal 中止发的是 `'error'`，但它**不是**"进程起不来" ——
       *   那是超时或被取消。若在这里写死原因，后面判 `deadline` / `external` 就永远到不了
       *   （这正是第一版的错，已被复核与探针坐实）。
       *   ⇒ AbortError 一律**不写原因**，交给下面的 `close` 按信号状态判定。
       */
      if (error.name === 'AbortError') return
      reason ??= 'spawn_failed'
    })
    child.once('close', (code) => {
      /*
       * ⚠️ **判据顺序是这件事的一部分，不能调换**：
       *   · 先看已经定下来的具名原因（stdout 超预算 / stdin 写失败 / 真的 spawn 失败）—— 那更具体；
       *   · 再按**信号状态**判（超时 / 取消 / 其它中止）；
       *   · 最后才看退出码 —— 因为**被信号杀掉的 `code` 是 `null`**，
       *     `null !== 0` 为真，先判退出码会把超时误标成 `exit_nonzero`（第一版的第二个错）。
       */
      if (reason !== undefined) { reject(new LangMemWorkerFailure(reason, code)); return }
      const killedBySignal = code === null
      if (deadline.aborted && killedBySignal) { reject(new LangMemWorkerFailure('timeout', code)); return }
      if (external?.aborted === true && killedBySignal) { reject(new LangMemWorkerFailure('cancelled', code)); return }
      if (signal.aborted) { reject(new LangMemWorkerFailure('aborted', code)); return }
      if (code !== 0) { reject(new LangMemWorkerFailure('exit_nonzero', code)); return }
      accept(output.trim())
    })
    child.stdin.end(request)
  })
}
