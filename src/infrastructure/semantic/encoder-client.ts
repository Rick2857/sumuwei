/**
 * M9.5 WP3 —— **编码器的父进程客户端**（D27：可终止执行单元 + 硬截止 + 回收证据）。
 *
 * ============================================================================
 *  三条设计纪律（都不是可选项）
 * ============================================================================
 * ```text
 * ① **推理只在子进程里跑**：父进程不加载 ONNX、不做推理。于是"取消"= 杀掉那个进程，
 *    而不是"等 Promise 超时但底层继续算"（WP1 实测过后者：结算后 500 ms 内还烧 8625 ms CPU）。
 * ② **硬截止**：每次编码有 deadline；到点未回 ⇒ `SIGKILL`。父进程**不**等它自然结束。
 * ③ **回收必须有证据**：杀之后要能说清"底层确实停了"。本模块提供两样可核对的事实：
 *      · `onExit` 观察到子进程退出（含 signal）—— 被杀掉的进程在结构上不可能继续计算；
 *      · 退出的时刻晚于 kill 的时刻，且此后**不再有**任何一行输出。
 *    另有一条**独立佐证**在门里做：机器级 CPU 利用率在"任务进行中"与"杀之后"两侧的对比。
 * ```
 *
 * ⚠️ 子进程**不派生**任何子进程 ⇒ 杀它即回收全部工作（"无孤儿任务"的结构性保证）。
 * ⚠️ 本模块**不**打开数据库、**不**联网。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cpus } from 'node:os'
import { join, resolve } from 'node:path'

import type { EmbeddingManifest } from './embedding-manifest.ts'

export type EncodeFailure =
  | 'encode_timeout'
  | 'worker_error'
  | 'worker_exited'
  | 'manifest_invalid'
  | 'assets_missing'
  | 'background_disabled'

export interface EncodeOk {
  readonly ok: true
  readonly dimension: number
  readonly vectors: readonly (readonly number[])[]
  readonly cpuUserMs: number
  readonly elapsedMs: number
  readonly fromColdStart: boolean
}

export interface EncodeFail {
  readonly ok: false
  readonly reason: EncodeFailure
  readonly detail: string
  /** 取消后**是否观察到**子进程真的退出（D27 的正控证据） */
  readonly reclaimed: boolean
  readonly killedAfterMs: number | null
}

export type EncodeResult = EncodeOk | EncodeFail

export interface EncoderClientOptions {
  readonly manifest: EmbeddingManifest
  readonly repoRoot: string
  /** 模型资产目录（`<modelRoot>/<modelId>` 的父目录） */
  readonly localModelPath: string
  /** 单次编码的硬截止（毫秒） */
  readonly deadlineMs: number
  /** 子进程就绪的等待上限（毫秒），含冷加载 */
  readonly readyTimeoutMs?: number
}

interface Pending {
  readonly id: number
  readonly resolve: (value: EncodeResult) => void
  readonly killTimer: ReturnType<typeof setTimeout>
  readonly startedAt: number
  readonly texts: number
}

export interface EncoderClient {
  readonly fingerprintPromise: Promise<string>
  /** 子进程 pid（未启动时为 null） */
  pid(): number | null
  encode(texts: readonly string[]): Promise<EncodeResult>
  /** 预加载（把冷启动从延迟读数里分出去） */
  warmup(): Promise<{ readonly ok: boolean; readonly coldLoadMs: number; readonly detail: string }>
  /** 热编码延迟采样（用于"回收后机器不卡"的独立佐证） */
  sampleLatency(count: number): Promise<readonly number[]>
  close(): Promise<void>
  /** 供门读取的观察记录（kill 与 exit 的时刻） */
  readonly reclaimLog: {
    readonly kills: readonly { readonly at: number; readonly pid: number | null }[]
    readonly exits: readonly { readonly at: number; readonly code: number | null; readonly signal: string | null }[]
    readonly outputsAfterKill: number
  }
}

export function createEncoderClient(options: EncoderClientOptions): EncoderClient {
  const workerEntry = join(options.repoRoot, 'src/infrastructure/semantic/encoder-worker-entry.ts')
  const tsxCli = join(options.repoRoot, 'node_modules/tsx/dist/cli.mjs')
  const kills: { at: number; pid: number | null }[] = []
  const exits: { at: number; code: number | null; signal: string | null }[] = []
  let lastKillAt = -1
  let outputsAfterKill = 0

  /*
   * ⚠️ **M10 `L-M10-61` 的诊断插桩**（用户 2026-09-30 授权进 M9.5 内部；env 门控，默认静默）。
   *
   * 背景：`CHARACTER_MEMORY_SEMANTIC_ENABLED=true` 时的**聊天轮次**会**静默**阻塞
   * （跨过文档承诺的 180s 就绪超时，300s 仍不动），而 `m9.5:encoder:verify`（含**真的 encode**）
   * 与 `m9.5:probe:verify` 都 PASS ⇒ 卡点要么在 client 的某个 await 上，
   * 要么**根本不在编码器里**（`encode` 从未被调用）。
   *
   * ⇒ 这两个问题必须先用读数分开，不能靠读代码猜：
   * ```text
   * 若日志里**没有** `encode() 被调用`      ⇒ 卡点在**调用方**（召回路径），不在 client
   * 若日志里有、且 `waitReady` 超时          ⇒ 卡点在 worker 就绪
   * 若日志里有、且请求已发出但无响应          ⇒ 卡点在 worker 的 load/encode
   * ```
   */
  const debugEnabled = process.env.M95_ENCODER_DEBUG === '1'
  const t0 = Date.now()
  const debug = (mark: string, extra = ''): void => {
    if (!debugEnabled) return
    console.error(`[m95-encoder-debug +${String(Date.now() - t0)}ms] ${mark}${extra === '' ? '' : ` ${extra}`}`)
  }
  debug('client 构造完成（**注意：构造本身不 spawn**，见下）')

  let child: ChildProcessWithoutNullStreams | null = null
  let fingerprint: string | null = null
  let readyResolve: ((value: { ok: boolean; detail: string }) => void) | null = null
  let readyPromise: Promise<{ ok: boolean; detail: string }> | null = null
  const pending = new Map<number, Pending>()
  let nextId = 1
  let closed = false

  const failAllPending = (reason: EncodeFailure, detail: string): void => {
    for (const [id, item] of pending) {
      clearTimeout(item.killTimer)
      pending.delete(id)
      item.resolve({
        ok: false,
        reason,
        detail,
        reclaimed: true,
        killedAfterMs: lastKillAt >= 0 ? Date.now() - lastKillAt : null,
      })
    }
  }

  const killChild = (): void => {
    if (child === null) return
    lastKillAt = Date.now()
    kills.push({ at: lastKillAt, pid: child.pid ?? null })
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已经死了：正常 */
    }
  }

  const start = (): void => {
    if (child !== null) return
    if (!existsSync(workerEntry)) throw new Error(`worker 入口不存在：${workerEntry}`)
    if (!existsSync(tsxCli)) throw new Error(`tsx CLI 不存在：${tsxCli}（本仓库用 tsx 跑 TS）`)
    readyPromise = new Promise((res) => {
      readyResolve = res
    })
    child = spawn(process.execPath, [tsxCli, workerEntry], {
      cwd: options.repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        M95_EMBEDDING_MANIFEST: join(options.repoRoot, 'evals/m9.5/embedding-manifest.json'),
      },
    }) as ChildProcessWithoutNullStreams
    debug('worker 已 spawn', `pid=${String(child.pid ?? 'null')} entry=${workerEntry.slice(-40)}`)

    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (line === '') continue
        debug('worker → client', line.slice(0, 200))
        if (lastKillAt >= 0) outputsAfterKill += 1
        let message: Record<string, unknown>
        try {
          message = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if (message.type === 'ready') {
          fingerprint = typeof message.fingerprint === 'string' ? message.fingerprint : null
          readyResolve?.({ ok: true, detail: `assetsVerified=${String(message.assetsVerified)}` })
          continue
        }
        if (message.type === 'loaded') {
          continue
        }
        if (message.type === 'error') {
          readyResolve?.({ ok: false, detail: String(message.error) })
          failAllPending('worker_error', String(message.error))
          continue
        }
        if (message.type === 'result') {
          const id = Number(message.id)
          const item = pending.get(id)
          if (item === undefined) continue
          pending.delete(id)
          clearTimeout(item.killTimer)
          if (message.ok === true) {
            const dims = message.dims as number[]
            const dimension = dims[dims.length - 1] as number
            const data = message.data as number[]
            const vectors: number[][] = []
            for (let offset = 0; offset < data.length; offset += dimension) {
              vectors.push(data.slice(offset, offset + dimension))
            }
            item.resolve({
              ok: true,
              dimension,
              vectors,
              cpuUserMs: Number(message.cpuUserMs ?? 0),
              elapsedMs: Number(message.elapsedMs ?? 0),
              fromColdStart: false,
            })
          } else {
            item.resolve({
              ok: false,
              reason: 'worker_error',
              detail: String(message.error ?? 'unknown'),
              reclaimed: false,
              killedAfterMs: null,
            })
          }
          continue
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      /* 子进程的 stderr 不参与判定（它可能带加载器的告警）；要判定的事实在 stdout 协议里 */
      /*
       * ⚠️ 诊断插桩（env 门控）：**把 worker 的 stderr 转出来**。
       *    原先它被读到就丢 ⇒ 诊断时**看不见 worker 那边发生了什么**。
       */
      if (debugEnabled) {
        const text = chunk.toString('utf8').trimEnd()
        if (text !== '') console.error(`[m95-worker-stderr] ${text.slice(0, 400)}`)
      }
    })
    child.on('exit', (code, signal) => {
      exits.push({ at: Date.now(), code: code ?? null, signal: signal ?? null })
      const current = child
      child = null
      /* 子进程退出 ⇒ 它（以及它没派生过的任何东西）都不再计算 */
      failAllPending('worker_exited', `worker 退出 code=${String(code)} signal=${String(signal)}`)
      void current
    })
    child.on('error', (error) => {
      readyResolve?.({ ok: false, detail: `spawn 失败：${error.message}` })
    })
  }

  const waitReady = async (): Promise<{ ok: boolean; detail: string }> => {
    debug('waitReady 进入 ⇒ 将调用 start()（**第一次 encode 才走到这里**）')
    start()
    debug('start() 返回（child 已 spawn 或已存在）', `child=${child === null ? 'null' : '有'}`)
    const timeoutMs = options.readyTimeoutMs ?? 120_000
    /*
     * ⚠️⚠️ **这里曾经是"进程不退出"的根因**（`L-M10-61` 的第三个、也是最后一个成因）。
     *
     * ```text
     * 原写法：Promise.race([readyPromise, new Promise(res => setTimeout(res, timeoutMs))])
     *   ⇒ ready **赢了**（实测 247ms）之后，那个 `setTimeout` **从来没有被清掉**；
     *     而 `timeoutMs` = SEMANTIC_RECALL_READY_TIMEOUT_MS = **180_000**
     *   ⇒ 一个**没人要的兜底定时器把 event loop 吊住 180 秒** ⇒ 进程不退出。
     *
     * 实测（有界探针）：回复已产出、worker 已正确关掉、**没有**孤儿进程，
     *   而进程仍被 SIGKILL @75s；关库后 dump 存活资源 = ["PipeWrap","PipeWrap","PipeWrap","Timeout"]。
     *   ⇒ 那个 **Timeout** 就是它。这也解释了三条此前的读数：
     *     · "跨过文档承诺的 180s"  —— 进程其实会在 180s **之后**自己退出（不是轮次挂住）
     *     · "与语义模式无关"      —— `warmup`/`fingerprint` 都会调本函数，与模式无关
     *     · "关掉语义召回就正常"  —— 没有 worker 就没人调本函数 ⇒ 没有这个定时器
     * ```
     * ⇒ 两条修法一起上：**`unref()`**（兜底截止不该吊住进程）+ **赢了就 `clearTimeout`**。
     */
    let readyTimer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      readyPromise as Promise<{ ok: boolean; detail: string }>,
      new Promise<{ ok: boolean; detail: string }>((res) => {
        readyTimer = setTimeout(
          () => res({ ok: false, detail: `worker 就绪超时（${String(timeoutMs)} ms）` }),
          timeoutMs,
        )
        /* 兜底截止**不是**"还有活在干" ⇒ 不该让进程为它多活 180 秒 */
        readyTimer.unref?.()
      }),
    ])
    if (readyTimer !== undefined) clearTimeout(readyTimer)
    debug('waitReady 返回', `ok=${String(outcome.ok)} detail=${outcome.detail.slice(0, 120)}`)
    return outcome
  }

  const encode = async (texts: readonly string[]): Promise<EncodeResult> => {
    debug('encode() 被调用', `texts=${String(texts.length)} 条`)
    if (closed) return { ok: false, reason: 'background_disabled', detail: 'client 已关闭', reclaimed: false, killedAfterMs: null }
    const ready = await waitReady()
    if (!ready.ok) {
      killChild()
      return { ok: false, reason: 'worker_error', detail: ready.detail, reclaimed: true, killedAfterMs: 0 }
    }
    if (child === null) {
      return { ok: false, reason: 'worker_exited', detail: 'worker 不在', reclaimed: true, killedAfterMs: null }
    }
    const id = nextId
    nextId += 1
    const startedAt = Date.now()
    return new Promise<EncodeResult>((res) => {
      const killTimer = setTimeout(() => {
        /* ★ 硬截止到了：**杀进程**，不"等它自己停" */
        killChild()
        const item = pending.get(id)
        if (item === undefined) return
        pending.delete(id)
        item.resolve({
          ok: false,
          reason: 'encode_timeout',
          detail: `超过硬截止 ${String(options.deadlineMs)} ms ⇒ SIGKILL`,
          reclaimed: true,
          killedAfterMs: Date.now() - startedAt,
        })
      }, options.deadlineMs)
      pending.set(id, { id, resolve: res, killTimer, startedAt, texts: texts.length })
      child?.stdin.write(`${JSON.stringify({ kind: 'encode', id, texts: [...texts] })}\n`)
    })
  }

  return {
    get reclaimLog() {
      return { kills, exits, outputsAfterKill }
    },
    pid: () => child?.pid ?? null,
    fingerprintPromise: (async () => {
      await waitReady()
      return fingerprint ?? ''
    })(),
    encode,
    async warmup() {
      const ready = await waitReady()
      if (!ready.ok) return { ok: false, coldLoadMs: -1, detail: ready.detail }
      const started = Date.now()
      const result = await encode(['passage: 预热。'])
      return {
        ok: result.ok,
        coldLoadMs: Date.now() - started,
        detail: result.ok ? 'ok' : result.detail,
      }
    },
    async sampleLatency(count: number) {
      const samples: number[] = []
      for (let i = 0; i < count; i += 1) {
        const started = Date.now()
        const result = await encode([`query: 延迟采样 ${String(i)}。`])
        if (result.ok) samples.push(Date.now() - started)
      }
      return samples
    },
    async close() {
      closed = true
      if (child !== null) {
        try {
          child.stdin.write(`${JSON.stringify({ kind: 'exit' })}\n`)
        } catch {
          /* 已经断了 */
        }
        await new Promise((res) => setTimeout(res, 200))
        killChild()
      }
    },
  }
}

/** 机器级 CPU 利用率（用于"杀之后确实不再占满 CPU"的独立佐证；本机 24 核，读数偏粗）。 */
export function cpuSnapshot(): readonly { readonly idle: number; readonly total: number }[] {
  return cpus().map((cpu) => {
    const times = cpu.times
    const total = times.user + times.nice + times.sys + times.idle + times.irq
    return { idle: times.idle, total }
  })
}

export function cpuUtilisationBetween(
  before: readonly { readonly idle: number; readonly total: number }[],
  after: readonly { readonly idle: number; readonly total: number }[]
): number {
  let idleDelta = 0
  let totalDelta = 0
  for (let i = 0; i < Math.min(before.length, after.length); i += 1) {
    idleDelta += (after[i] as { idle: number }).idle - (before[i] as { idle: number }).idle
    totalDelta += (after[i] as { total: number }).total - (before[i] as { total: number }).total
  }
  if (totalDelta <= 0) return Number.NaN
  return Number((1 - idleDelta / totalDelta).toFixed(4))
}

export function resolveRepoRoot(from: string): string {
  return resolve(from)
}
