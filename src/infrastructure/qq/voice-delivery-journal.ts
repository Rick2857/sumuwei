/**
 * QQ 普通回复的**最小持久化投递日志**（post-Lv2 / P2）。
 *
 * ============================================================================
 *  它解决什么（不是"日志好看"，是三条真实后果）
 * ============================================================================
 * ```text
 * ① 重启后的重复入站：进程内 `seen` 集合清零 ⇒ 同一条消息会再回一次
 * ② 发送前崩溃：不知道"到底发没发" ⇒ 自动重播等于可能送两遍
 * ③ voice→text 兜底：不换键，避免"换一个键就绕过去重"
 * ```
 *
 * ============================================================================
 *  它是什么 / 不是什么
 * ============================================================================
 * ```text
 * 是    ：**append-only JSONL** + 逻辑回复键（受信入站 requestId 派生）
 * 不是  ：后台提醒通知表、进程内播放账、QQ 平台送达凭据
 * 不是  ：通用媒体任务服务（只记本批新增的普通回复投递）
 * ```
 *
 * ⚠️ **只做四件事**：占用（reserved）→ 结果（accepted / failed / unknown / fallback）
 *    → 重启遗留一律 unknown → 重复键拒绝。
 * ⚠️ **失败关闭**：日志不可读（含任一行坏）或落盘失败 ⇒ 新语音发送**禁止**
 *    （装配层据此**不装**语音端口）；文字路径保持旧行为（并记录"去重不可用"）。
 * ⚠️ **不存正文、不存音频**：只存 sha256 与结构读数（字节数 / 时长 / 耗时）。
 * ⚠️ 并发：进程内串行（既有队列）+ 文件锁；**单持有者**前提与 ADR-110 `D06`
 *    的"同一时刻只有一条有权投递的外壳连接"一致 —— 多外壳的跨进程互斥仍不是
 *    本文件要解决的（如实登记为已知限制）。
 */
import { createHash } from 'node:crypto'
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync,
} from 'node:fs'
import { dirname } from 'node:path'
import type { QqReplyDeliveryFact } from '../../kernel/contracts/qq-media-reply.ts'

/** 一条投递事件的结局（闭集；未知绝不默认成功） */
export const QQ_DELIVERY_STATUSES = [
  'reserved',
  'api_accepted',
  'failed_confirmed',
  'delivery_unknown',
  'fallback_text',
  'duplicate_skipped',
  'unknown_after_restart',
] as const
export type QqDeliveryStatus = (typeof QQ_DELIVERY_STATUSES)[number]

export type QqDeliveryPurpose = 'reply' | 'appendix'

export interface QqDeliveryJournalEntry {
  /** 事件发生时刻（毫秒；同一逻辑回复的多条事件共用递增 time） */
  at: number
  /** 逻辑回复键：`qq-reply:<受信入站 requestId>`（**不是**每次重生成的 replyId） */
  key: string
  requestId: string
  /** `reply` = 这一条回复本身；`appendix` = 语音回复的伴随来源附录 */
  purpose: QqDeliveryPurpose
  /** 同一逻辑回复的尝试序号（本批固定 1：已知结果不重试） */
  attempt: number
  status: QqDeliveryStatus
  /** 她这一轮**选的**媒介（不是最终实际发出的） */
  requested?: 'text' | 'voice'
  /** 最终**实际发出**的媒介 */
  effective?: 'text' | 'voice'
  messageId?: string
  reason?: string
  replyId?: string
  traceId?: string
  /** 正文摘要（**不存正文**） */
  textSha256?: string
  /** 音频摘要与结构读数（**不存音频**） */
  audioSha256?: string
  audioBytes?: number
  audioDurationMs?: number
  synthMs?: number
  totalMs?: number
  ttsRequestId?: string
  ttsUsage?: import('./voice-reply.ts').QqVoiceSynthesisResult['usage']
}

/** 外壳/门注入的最小端口（不传 = 本批旧的"无去重"行为，读数会记 `journal_absent`） */
export interface QqDeliveryJournalPort {
  readonly path: string
  readonly readable: boolean
  /** 重启收尾：把遗留 `reserved` 追加成 `unknown_after_restart`（返回条数） */
  recover(now?: number): number
  /** 这个逻辑键（+ 用途）是否已占用过 */
  has(key: string, purpose?: QqDeliveryPurpose): boolean
  /**
   * 发送**之前**的持久化占用。
   *
   * ```text
   * ok        ⇒ 可以尝试发送
   * duplicate ⇒ 这个逻辑回复已经占用/有过结局 ⇒ **不发送**
   * unavailable ⇒ 日志不可读/不可写 ⇒ 语音必须回落到文字（文字保持旧行为）
   * ```
   */
  reserve(input: {
    key: string
    requestId: string
    purpose: QqDeliveryPurpose
    requested: 'text' | 'voice'
    replyId?: string
    traceId?: string
    attempt?: number
    now?: number
  }): { ok: true } | { ok: false; reason: 'duplicate' | 'unavailable' }
  /** 追加一条**结局/中间事实**（失败抛；调用方决定是否继续） */
  append(entry: QqDeliveryJournalEntry): void
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 2_000

/** 同步小睡（Node 主线程允许；只在锁竞争时的有界等待里用） */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function parseJournal(text: string): QqDeliveryJournalEntry[] {
  const entries: QqDeliveryJournalEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let value: unknown
    try { value = JSON.parse(line) } catch { throw new Error('delivery_journal_corrupt') }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('delivery_journal_corrupt')
    const entry = value as QqDeliveryJournalEntry
    if (typeof entry.key !== 'string' || entry.key.trim() === '' ||
        typeof entry.requestId !== 'string' ||
        typeof entry.at !== 'number' || !Number.isFinite(entry.at) ||
        !QQ_DELIVERY_STATUSES.includes(entry.status) ||
        (entry.purpose !== 'reply' && entry.purpose !== 'appendix') ||
        (entry.requested !== undefined && entry.requested !== 'text' && entry.requested !== 'voice') ||
        (entry.effective !== undefined && entry.effective !== 'text' && entry.effective !== 'voice')) {
      throw new Error('delivery_journal_corrupt')
    }
    entries.push(entry)
  }
  return entries
}

/** Exact previous reply only; never import another room's newest global journal entry. */
export function readQqReplyDelivery(path: string, replyId: string | undefined): QqReplyDeliveryFact | undefined {
  if (!replyId || !existsSync(path)) return undefined
  try {
    const entries = parseJournal(readFileSync(path, 'utf8'))
    const start = entries.find(entry => entry.replyId === replyId && entry.purpose === 'reply')
    if (start === undefined) return undefined
    const related = entries.filter(entry => entry.key === start.key && entry.purpose === 'reply' && entry.status !== 'duplicate_skipped')
    const last = related.at(-1)!
    const requested = related.find(entry => entry.requested !== undefined)?.requested
    return { replyId, status: last.status as QqReplyDeliveryFact['status'],
      ...(requested === undefined ? {} : { requested }), ...(last.effective === undefined ? {} : { effective: last.effective }) }
  } catch { return undefined } // An unreadable journal is not proof of any delivery outcome.
}

/**
 * 文件版投递日志（append-only JSONL）。
 *
 * ⚠️ 构造时**不做 IO**：`readable` 由工厂 {@link openQqDeliveryJournal} 探测。
 */
export class FileQqDeliveryJournal implements QqDeliveryJournalPort {
  readonly path: string
  private _readable = true
  private broken: string | undefined

  constructor(path: string) {
    this.path = path
  }

  get readable(): boolean { return this._readable && this.broken === undefined }
  /** 若已损坏，具体原因（读数用；不含正文） */
  get problem(): string | undefined { return this.broken }

  private markBroken(reason: string): void {
    this.broken ??= reason
    this._readable = false
  }

  private load(): QqDeliveryJournalEntry[] {
    try {
      if (!existsSync(this.path)) return []
      return parseJournal(readFileSync(this.path, 'utf8'))
    } catch (error) {
      this.markBroken(error instanceof Error ? error.message : 'delivery_journal_unreadable')
      throw error
    }
  }

  private withLock<T>(run: () => T): T {
    mkdirSync(dirname(this.path), { recursive: true })
    const lock = `${this.path}.lock`
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      try {
        const fd = openSync(lock, 'wx')
        closeSync(fd)
        break
      } catch {
        /* 崩溃遗留的锁：只清"明显陈旧"的那把（不猜"也许还活着"） */
        try {
          if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
            unlinkSync(lock)
            continue
          }
        } catch { /* 锁文件同时消失 ⇒ 继续尝试 */ }
        if (Date.now() > deadline) throw new Error('delivery_journal_locked')
        sleepSync(10)
      }
    }
    try {
      return run()
    } finally {
      try { unlinkSync(lock) } catch { /* 已被清理 */ }
    }
  }

  private appendRaw(entries: readonly QqDeliveryJournalEntry[]): void {
    if (entries.length === 0) return
    const text = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
    appendFileSync(this.path, text, { encoding: 'utf8', mode: 0o600, flush: true })
  }

  recover(now?: number): number {
    const at = now ?? Date.now()
    if (!this.readable) return 0
    try {
      return this.withLock(() => {
        const entries = this.load()
        const latest = new Map<string, QqDeliveryJournalEntry>()
        for (const entry of entries) {
          if (entry.status !== 'duplicate_skipped') latest.set(JSON.stringify([entry.key, entry.purpose]), entry)
        }
        const orphans = [...latest.values()].filter((entry) => entry.status === 'reserved')
        this.appendRaw(orphans.map((entry) => ({
          at, key: entry.key, requestId: entry.requestId, purpose: entry.purpose,
          attempt: entry.attempt, status: 'unknown_after_restart' as const, reason: 'restart_while_reserved',
        })))
        return orphans.length
      })
    } catch (error) {
      this.markBroken(error instanceof Error ? error.message : 'delivery_journal_recover_failed')
      return 0
    }
  }

  has(key: string, purpose?: QqDeliveryPurpose): boolean {
    if (!this.readable) return false
    try {
      return this.load().some((entry) => entry.key === key && (purpose === undefined || entry.purpose === purpose))
    } catch { return false }
  }

  reserve(input: Parameters<QqDeliveryJournalPort['reserve']>[0]): { ok: true } | { ok: false; reason: 'duplicate' | 'unavailable' } {
    if (!this.readable) return { ok: false, reason: 'unavailable' }
    try {
      return this.withLock(() => {
        const entries = this.load()
        const duplicate = entries.some((entry) => entry.key === input.key &&
          (input.purpose === 'reply' ? entry.purpose === 'reply' : entry.purpose === 'appendix'))
        if (duplicate) return { ok: false as const, reason: 'duplicate' as const }
        this.appendRaw([{
          at: input.now ?? Date.now(),
          key: input.key,
          requestId: input.requestId,
          purpose: input.purpose,
          attempt: input.attempt ?? 1,
          status: 'reserved',
          requested: input.requested,
          ...(input.replyId === undefined ? {} : { replyId: input.replyId }),
          ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
        }])
        return { ok: true as const }
      })
    } catch (error) {
      this.markBroken(error instanceof Error ? error.message : 'delivery_journal_unavailable')
      return { ok: false, reason: 'unavailable' }
    }
  }

  append(entry: QqDeliveryJournalEntry): void {
    if (!this.readable) throw new Error(this.broken ?? 'delivery_journal_unavailable')
    try {
      this.withLock(() => this.appendRaw([entry]))
    } catch (error) {
      this.markBroken(error instanceof Error ? error.message : 'delivery_journal_write_failed')
      throw error
    }
  }
}

/**
 * 打开（必要时创建）一个投递日志。
 *
 * ⚠️ **失败返回 `error` 而不是抛**：装配层据此**不装**语音端口（失败关闭），
 *    而不是让语音发送带着一个坏日志跑。
 */
export function openQqDeliveryJournal(path: string): { journal?: FileQqDeliveryJournal; error?: string } {
  const journal = new FileQqDeliveryJournal(path)
  try {
    /* 只读探测：不存在 = 空日志（可写性在首次 reserve 时暴露） */
    if (existsSync(path)) parseJournal(readFileSync(path, 'utf8'))
    return { journal }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'delivery_journal_unreadable' }
  }
}
