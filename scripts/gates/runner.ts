/**
 * 门执行器（Tier 2 + Tier 0）—— 按**资源冲突图**调度、逐门记时、失败关闭。
 *
 * ============================================================================
 *  它做什么 / 它**不**做什么
 * ============================================================================
 *  做：把清单里的门按依赖 + 资源冲突调度执行（并发上限可调），逐门记录
 *      `seconds / exitCode / 是否缓存 / 与谁同时在跑`，落一份 `run.json`。
 *  不做：不改任何门的断言、不改任何门的证据文件内容、不合并门。
 *      每道门仍然是**独立进程 + 独立沙箱 + 独立退出码**。
 *
 * ---------------------------------------------------------------------------
 *  两条纪律，写进代码里而不是写在文档里
 * ---------------------------------------------------------------------------
 *  ① **失败关闭**：清单校验不过（缺声明/依赖环/路径逃逸）⇒ 整个运行拒绝启动。
 *     依赖失败的下游门记 `SKIPPED`（不是 PASS），运行判决为 FAIL。
 *  ② **快车道不留痕**：`--mode fast` 跑完会把**本次运行新弄脏的** `artifacts/**`
 *     按白名单还原（`git checkout --` / 删除新增未跟踪文件），
 *     并在还原后**复核**一遍；复核不通过 ⇒ 运行判决 FAIL 并打印出来。
 *     这样"并行跑出来的绿"不可能被后面的 `*:gates` 汇总当成发布证据。
 *     还原只动**新增**的脏路径：运行前就已经脏的路径一律保留（§7 的教训）。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { conflictBetween, validateManifest, type Conflict, type GateSpec, type RunMode } from './types.ts'

export type GateStatus = 'PASS' | 'FAIL' | 'SKIPPED' | 'CACHED' | 'TIMEOUT' | 'SPAWN-ERROR' | 'DEADLOCK'

export interface GateOutcome {
  id: string
  title: string
  status: GateStatus
  exitCode: number | null
  /** 本次真实耗时（毫秒）；`CACHED` 记被复用的那次耗时。 */
  ms: number
  seconds: number
  startedAt: string
  finishedAt: string
  /** 与它**同时在跑**的门（正控证据：证明并行真的发生了）。 */
  overlappedWith: string[]
  /** 与之冲突、因而没能同时跑的门（负控证据：证明冲突判定真的生效了）。 */
  serializedAgainst: string[]
  blockedBy?: string
  note?: string
  logPath?: string
  cachedFrom?: { key: string; recordedAt: string; seconds: number }
  /** 该门输入键的概览（缓存可诊断性：这条读数覆盖了多少文件）。 */
  inputKey?: { key: string; filesHashed: number; scope: string }
}

export interface RunReport {
  runId: string
  mode: RunMode
  lane: string
  root: string
  startedAt: string
  finishedAt: string
  seconds: number
  concurrency: number
  cacheEnabled: boolean
  manifestProblems: { id: string; problem: string }[]
  results: GateOutcome[]
  counts: Record<GateStatus | 'TOTAL', number>
  verdict: 'PASS' | 'FAIL' | 'REFUSED'
  restoredEvidence: string[]
  deletedEvidence: string[]
  preservedPreExistingDirty: string[]
  restoreFailures: string[]
  unmatchedPaths?: string[]
  notes: string[]
}

export interface ExecResult {
  exitCode: number
  ms: number
  note?: string
  tail?: string
}

export type GateExecutor = (spec: GateSpec, ctx: { logPath: string; timeoutMs: number }) => Promise<ExecResult>

export interface RunOptions {
  root: string
  lane: string
  mode: RunMode
  concurrency: number
  timeoutMsPerGate?: number
  failFast?: boolean
  runId: string
  evidenceRoot: string
  /** 为 true 时不动 artifacts（用于自证门与调试）。 */
  keepEvidence?: boolean
  /** 注入执行器：自证门用它跑合成门，避免真跑 34 道门。 */
  executor?: GateExecutor
  /** 缓存：仅在 fast 档生效，且由调用方保证只对 cacheable 的门传 key。 */
  cache?: {
    dir: string
    salt: string
    keyFor: (spec: GateSpec) => { key: string; filesHashed: number; scope: string } | undefined
    /** 命中判定：返回被复用的读数（不满足复用条件时返回 undefined）。 */
    lookup: (spec: GateSpec, key: string) => GateOutcome['cachedFrom'] | undefined
    store: (spec: GateSpec, key: string, outcome: GateOutcome) => void
  }
  onEvent?: (event: RunEvent) => void
}

export type RunEvent =
  | { type: 'start'; id: string; title: string; overlappedWith: string[] }
  | { type: 'finish'; outcome: GateOutcome }
  | { type: 'skip'; id: string; blockedBy: string }
  | { type: 'note'; message: string }

/** 默认执行器：直接 spawn argv（不经 `pnpm run` 那一层包装），输出流式落日志。 */
export function defaultExecutor(root: string): GateExecutor {
  return (spec, ctx) =>
    new Promise<ExecResult>((resolvePromise) => {
      const started = Date.now()
      mkdirSync(join(ctx.logPath, '..'), { recursive: true })
      const log = createWriteStream(ctx.logPath)
      log.write(`$ ${spec.argv.join(' ')}\n`)
      const argv0 = spec.argv[0] ?? ''
      const rest = spec.argv.slice(1)
      let child: ChildProcess
      try {
        child = spawn(argv0, rest, {
          cwd: root,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (error) {
        log.end()
        resolvePromise({
          exitCode: -1,
          ms: Date.now() - started,
          note: `spawn 失败：${error instanceof Error ? error.message : String(error)}`,
        })
        return
      }

      let tail = ''
      const push = (chunk: Buffer): void => {
        log.write(chunk)
        tail = `${tail}${chunk.toString('utf8')}`.slice(-8000)
      }
      child.stdout?.on('data', push)
      child.stderr?.on('data', push)

      let settled = false
      const finish = (result: ExecResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          log.end()
        } catch {
          /* 日志收尾失败不影响读数 */
        }
        resolvePromise({ ...result, tail })
      }

      const timer = setTimeout(() => {
        killTree(child.pid)
        finish({
          exitCode: -1,
          ms: Date.now() - started,
          note: `超时（>${Math.round(ctx.timeoutMs / 1000)}s）⇒ 已杀进程树`,
        })
      }, ctx.timeoutMs)

      child.on('error', (error) => {
        finish({
          exitCode: -1,
          ms: Date.now() - started,
          note: `子进程错误：${error.message}`,
        })
      })
      child.on('close', (code) => {
        finish({ exitCode: code ?? -1, ms: Date.now() - started })
      })
    })
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* 已经退了 */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// artifacts 脏路径快照 / 还原（§7 的"还原白名单"纪律，机器化）
// ---------------------------------------------------------------------------

export function artifactStatus(root: string): Map<string, string> {
  const map = new Map<string, string>()
  const r = spawnSync('git', ['status', '--porcelain', '-z', '--', 'artifacts'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
  if (r.status !== 0) return map
  const entries = String(r.stdout ?? '')
    .split('\0')
    .filter((s) => s.length > 2)
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    if (entry === undefined) continue
    const xy = entry.slice(0, 2)
    const path = entry.slice(3).replace(/\\/g, '/')
    map.set(path, xy)
    // -z 格式下重命名会多一个 NUL 分隔的"原路径"项，跳过它。
    if (xy.includes('R') || xy.includes('C')) i += 1
  }
  return map
}

export interface RestoreResult {
  restored: string[]
  deleted: string[]
  preserved: string[]
  failed: string[]
}

/** 只还原**本次运行新弄脏**的路径；运行前就脏的一律保留。 */
export function restoreNewlyDirtyArtifacts(
  root: string,
  before: Map<string, string>,
  options: { dryRun?: boolean } = {}
): RestoreResult {
  const after = artifactStatus(root)
  const restored: string[] = []
  const deleted: string[] = []
  const preserved: string[] = []
  for (const [path, xy] of after) {
    if (before.has(path)) {
      preserved.push(path)
      continue
    }
    if (xy === '??') {
      deleted.push(path)
      if (options.dryRun !== true) rmSync(join(root, path), { recursive: true, force: true })
    } else {
      restored.push(path)
      if (options.dryRun !== true) {
        spawnSync('git', ['checkout', '--', path], { cwd: root, stdio: 'ignore' })
      }
    }
  }
  // 复核：还原之后**不应**再有"新增的脏路径"。不通过就是 FAIL，不许静默。
  const recheck = artifactStatus(root)
  const failed = [...recheck.keys()].filter((p) => !before.has(p))
  return { restored, deleted, preserved, failed }
}

// ---------------------------------------------------------------------------
// 调度
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString()
}

function acceptsExit(spec: GateSpec, exitCode: number): boolean {
  if (exitCode === 0) return true
  return (spec.acceptExitCodes ?? []).includes(exitCode)
}

export async function runGates(specs: readonly GateSpec[], options: RunOptions): Promise<RunReport> {
  const timeoutMsPerGate = options.timeoutMsPerGate ?? 45 * 60 * 1000
  const executor = options.executor ?? defaultExecutor(options.root)
  const notes: string[] = []
  const emit = (event: RunEvent): void => options.onEvent?.(event)

  const startedAll = Date.now()
  const startedAt = nowIso()
  const manifestProblems = validateManifest(specs)

  const before = options.keepEvidence === true ? new Map<string, string>() : artifactStatus(options.root)

  const outcomes = new Map<string, GateOutcome>()
  const running = new Map<string, { spec: GateSpec; promise: Promise<void> }>()
  const pending = new Map<string, GateSpec>(specs.map((s) => [s.id, s]))
  const intervals = new Map<string, { start: number; end: number }>()
  const conflictsSeen = new Map<string, Set<string>>()

  const finishOutcome = (outcome: GateOutcome): void => {
    outcomes.set(outcome.id, outcome)
    emit({ type: 'finish', outcome })
  }

  const launch = (spec: GateSpec): void => {
    const overlappedWith = [...running.keys()]
    pending.delete(spec.id)
    emit({ type: 'start', id: spec.id, title: spec.title, overlappedWith })
    const startedIso = nowIso()
    const startedMs = Date.now()

    const promise = (async () => {
      // ① 缓存命中（只在快车道、只复用成功读数；键不匹配一律不命中）。
      if (options.cache !== undefined && options.mode === 'fast') {
        const key = options.cache.keyFor(spec)
        if (key !== undefined) {
          const cached = options.cache.lookup(spec, key.key)
          if (cached !== undefined) {
            const finishedMs = Date.now()
            intervals.set(spec.id, { start: startedMs, end: finishedMs })
            finishOutcome({
              id: spec.id,
              title: spec.title,
              status: 'CACHED',
              exitCode: 0,
              ms: cached.seconds * 1000,
              seconds: cached.seconds,
              startedAt: startedIso,
              finishedAt: nowIso(),
              overlappedWith,
              serializedAgainst: [],
              cachedFrom: cached,
              inputKey: key,
              note: `复用 ${cached.recordedAt} 的成功读数（输入键相同：${key.filesHashed} 个文件 / ${key.scope}）`,
            })
            return
          }
        }
      }

      // ② 真跑。
      const logPath = join(options.evidenceRoot, 'logs', `${spec.id.replace(/[^a-zA-Z0-9._-]/g, '_')}.log`)
      let result: ExecResult
      try {
        result = await executor(spec, { logPath, timeoutMs: timeoutMsPerGate })
      } catch (error) {
        result = {
          exitCode: -1,
          ms: Date.now() - startedMs,
          note: `执行器抛错：${error instanceof Error ? error.message : String(error)}`,
        }
      }
      const finishedMs = Date.now()
      intervals.set(spec.id, { start: startedMs, end: finishedMs })
      const status: GateStatus =
        result.note?.startsWith('超时') === true
          ? 'TIMEOUT'
          : result.exitCode === -1 && result.note !== undefined && result.note.startsWith('spawn')
            ? 'SPAWN-ERROR'
            : acceptsExit(spec, result.exitCode)
              ? 'PASS'
              : 'FAIL'
      const inputKey =
        options.cache !== undefined && options.mode === 'fast' ? options.cache.keyFor(spec) : undefined
      const outcome: GateOutcome = {
        id: spec.id,
        title: spec.title,
        status,
        exitCode: result.exitCode,
        ms: result.ms,
        seconds: Math.round(result.ms / 100) / 10,
        startedAt: startedIso,
        finishedAt: nowIso(),
        overlappedWith,
        serializedAgainst: [],
        ...(result.note === undefined ? {} : { note: result.note }),
        ...(existsSync(logPath) ? { logPath: relative(options.root, logPath).replace(/\\/g, '/') } : {}),
        ...(inputKey === undefined ? {} : { inputKey }),
      }
      if (status === 'PASS' && options.cache !== undefined && options.mode === 'fast' && inputKey !== undefined) {
        options.cache.store(spec, inputKey.key, outcome)
      }
      finishOutcome(outcome)
    })()

    running.set(spec.id, { spec, promise })
    void promise.finally(() => {
      running.delete(spec.id)
    })
  }

  let guard = 0
  while (pending.size > 0 || running.size > 0) {
    guard += 1
    if (guard > specs.length * 4 + 1000) {
      notes.push('调度器触发了自保上限（疑似死锁）⇒ 剩余门标 DEADLOCK')
      for (const spec of pending.values()) {
        finishOutcome(deadlockOutcome(spec))
      }
      pending.clear()
      break
    }

    let progressed = false

    // ① 依赖已经不可能成功的门 ⇒ SKIPPED（不是 PASS）。
    for (const spec of [...pending.values()]) {
      const deps = spec.dependsOn ?? []
      const brokenDep = deps.find((d) => {
        const o = outcomes.get(d)
        return o !== undefined && o.status !== 'PASS' && o.status !== 'CACHED'
      })
      if (brokenDep !== undefined) {
        pending.delete(spec.id)
        progressed = true
        emit({ type: 'skip', id: spec.id, blockedBy: brokenDep })
        finishOutcome({
          id: spec.id,
          title: spec.title,
          status: 'SKIPPED',
          exitCode: null,
          ms: 0,
          seconds: 0,
          startedAt: nowIso(),
          finishedAt: nowIso(),
          overlappedWith: [],
          serializedAgainst: [],
          blockedBy: brokenDep,
          note: `依赖 ${brokenDep} 未成功 ⇒ 本门未运行（**不**算通过）`,
        })
      }
    }

    // ② 启动所有"依赖就绪 + 与在跑的门不冲突 + 没超并发上限"的门。
    const failFastTripped =
      options.failFast === true && [...outcomes.values()].some((o) => o.status !== 'PASS' && o.status !== 'CACHED')
    if (!failFastTripped) {
      for (const spec of [...pending.values()]) {
        if (running.size >= options.concurrency) break
        const deps = spec.dependsOn ?? []
        const depsReady = deps.every((d) => {
          const o = outcomes.get(d)
          return o !== undefined && (o.status === 'PASS' || o.status === 'CACHED')
        })
        if (!depsReady) continue
        const blocker = [...running.values()].find(
          (entry) => conflictBetween(spec, entry.spec) !== undefined
        )
        if (blocker !== undefined) {
          // 记下"它因为冲突没能和谁并行"，作为负控证据。
          const set = conflictsSeen.get(spec.id) ?? new Set<string>()
          set.add(blocker.spec.id)
          conflictsSeen.set(spec.id, set)
          continue
        }
        launch(spec)
        progressed = true
      }
    } else {
      for (const spec of [...pending.values()]) {
        pending.delete(spec.id)
        progressed = true
        finishOutcome({
          id: spec.id,
          title: spec.title,
          status: 'SKIPPED',
          exitCode: null,
          ms: 0,
          seconds: 0,
          startedAt: nowIso(),
          finishedAt: nowIso(),
          overlappedWith: [],
          serializedAgainst: [],
          note: '--fail-fast：前面已有门失败 ⇒ 本门未运行（**不**算通过）',
        })
      }
    }

    if (running.size > 0) {
      await Promise.race([...running.values()].map((entry) => entry.promise))
      progressed = true
    } else if (!progressed && pending.size > 0) {
      notes.push('没有可启动的门且没有在跑的门 ⇒ 怀疑依赖环（剩余门标 DEADLOCK）')
      for (const spec of pending.values()) finishOutcome(deadlockOutcome(spec))
      pending.clear()
      break
    }
  }

  // ③ 事后：并行/串行的观察证据。
  const ids = [...intervals.keys()]
  for (const id of ids) {
    const a = intervals.get(id)
    const outcome = outcomes.get(id)
    if (a === undefined || outcome === undefined) continue
    const overlapped = ids.filter((other) => {
      if (other === id) return false
      const b = intervals.get(other)
      if (b === undefined) return false
      return a.start < b.end && b.start < a.end
    })
    outcome.overlappedWith = overlapped
    outcome.serializedAgainst = [...(conflictsSeen.get(id) ?? new Set<string>())]
  }

  // ④ 快车道不留痕：还原本次新弄脏的 artifacts。
  let restore: RestoreResult = { restored: [], deleted: [], preserved: [], failed: [] }
  if (options.keepEvidence !== true) {
    restore = restoreNewlyDirtyArtifacts(options.root, before)
    if (restore.failed.length > 0) {
      notes.push(`⚠️ 证据还原复核未通过：仍有 ${restore.failed.length} 条新增脏路径 ⇒ 运行判决 FAIL`)
    }
  }

  const results = specs.map((s) => outcomes.get(s.id)).filter((o): o is GateOutcome => o !== undefined)
  const counts: RunReport['counts'] = {
    PASS: 0,
    FAIL: 0,
    SKIPPED: 0,
    CACHED: 0,
    TIMEOUT: 0,
    'SPAWN-ERROR': 0,
    DEADLOCK: 0,
    TOTAL: results.length,
  }
  for (const r of results) counts[r.status] += 1

  const bad = results.some(
    (r) => r.status !== 'PASS' && r.status !== 'CACHED'
  )
  const verdict: RunReport['verdict'] = manifestProblems.length > 0 ? 'REFUSED' : bad || restore.failed.length > 0 ? 'FAIL' : 'PASS'

  return {
    runId: options.runId,
    mode: options.mode,
    lane: options.lane,
    root: options.root,
    startedAt,
    finishedAt: nowIso(),
    seconds: Math.round((Date.now() - startedAll) / 100) / 10,
    concurrency: options.concurrency,
    cacheEnabled: options.cache !== undefined && options.mode === 'fast',
    manifestProblems,
    results,
    counts,
    verdict,
    restoredEvidence: restore.restored,
    deletedEvidence: restore.deleted,
    preservedPreExistingDirty: restore.preserved,
    restoreFailures: restore.failed,
    notes,
  }
}

function deadlockOutcome(spec: GateSpec): GateOutcome {
  return {
    id: spec.id,
    title: spec.title,
    status: 'DEADLOCK',
    exitCode: null,
    ms: 0,
    seconds: 0,
    startedAt: nowIso(),
    finishedAt: nowIso(),
    overlappedWith: [],
    serializedAgainst: [],
    note: '调度器判定它无法被安排（依赖环或资源自锁）⇒ **未运行**',
  }
}

/** 读一份 run.json（自证门与调试用）。 */
export function readRunReport(path: string): RunReport {
  return JSON.parse(readFileSync(path, 'utf8')) as RunReport
}

export function writeRunReport(path: string, report: RunReport): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

export function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}
