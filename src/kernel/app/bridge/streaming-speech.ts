import { KernelError } from '../../contracts/ids.ts'
import {
  decodeExpressiveSpeech, splitSpeechText, withoutAppendices, EXPRESSION_VERSION,
  type ExpressionDraft, type ExpressionCue, type SpeechExpression,
} from '../../contracts/expressive-speech.ts'
import {
  runReplyGuardChain, type ReplyGuardChainInput, type ReplyGuardChainOutcome,
} from '../reply-guard-chain.ts'
import { truthfulReminderReply, reminderReplyConfirmsChannel } from '../reminder-turn.ts'

export interface CheckedSpeechSegment {
  replyId: string
  traceId: string
  segmentIndex: number
  segment: SpeechExpression['segments'][number]
  guardStates: readonly string[]
}

/** Read only complete JSON objects inside the reserved speech envelope. */
export class SpeechStreamDecoder {
  private raw = ''
  private cursor = -1
  private afterObject = false
  private closed = false
  private finished = false
  private readonly decoded: ExpressionDraft['segments'] = []

  push(delta: string): ExpressionDraft['segments'] {
    if (this.finished) throw new Error('Speech stream is already finished')
    this.raw += delta
    if (this.cursor < 0) {
      const prefix = /^\s*(?:<response(?:\s[^>]*)?>\s*(?:(?:<thought>[\s\S]*?<\/thought>|<actions>[\s\S]*?<\/actions>|<providers>[\s\S]*?<\/providers>)\s*)*<text>\s*)?<lg-speech>\s*\{\s*"segments"\s*:\s*\[/.exec(this.raw)
      if (!prefix) return [] // Other valid model formats keep the existing whole-reply fallback.
      this.cursor = prefix[0].length
    }
    const ready: ExpressionDraft['segments'] = []
    while (!this.closed) {
      while (/\s/.test(this.raw[this.cursor] ?? '') && this.cursor < this.raw.length) this.cursor += 1
      if (this.cursor === this.raw.length) break
      if (this.afterObject) {
        if (this.raw[this.cursor] === ']') { this.closed = true; break }
        if (this.raw[this.cursor] !== ',') throw this.invalid()
        this.cursor += 1
        this.afterObject = false
        continue
      }
      if (this.raw[this.cursor] !== '{') throw this.invalid()
      let depth = 0
      let quoted = false
      let escaped = false
      let end = -1
      for (let i = this.cursor; i < this.raw.length; i += 1) {
        const char = this.raw[i]
        if (quoted) {
          if (escaped) escaped = false
          else if (char === '\\') escaped = true
          else if (char === '"') quoted = false
        } else if (char === '"') quoted = true
        else if (char === '{') depth += 1
        else if (char === '}' && --depth === 0) { end = i + 1; break }
      }
      if (end === -1) break
      const object = this.raw.slice(this.cursor, end)
      const draft = decodeExpressiveSpeech(`<lg-speech>{"segments":[${object}]}</lg-speech>`)
      if (this.decoded.length >= 32) throw this.invalid()
      ready.push(...draft.segments)
      this.decoded.push(...draft.segments)
      this.cursor = end
      this.afterObject = true
    }
    return ready
  }

  finish(text: string): ExpressionDraft {
    this.finished = true
    const draft = decodeExpressiveSpeech(text)
    if (this.cursor >= 0 && JSON.stringify(draft.segments) !== JSON.stringify(this.decoded)) throw this.invalid()
    return draft
  }

  private invalid(): KernelError {
    return new KernelError('validation_error', 'expression_invalid_stream', '流式表达封套非法或与最终正文不一致')
  }
}

/** Freeze each checked sentence before emission; a later rewrite cannot replace spoken history. */
export class CheckedSpeechStream {
  private readonly decoder = new SpeechStreamDecoder()
  private pending = ''
  private pendingCue: ExpressionCue = 'natural'
  private readonly outcomes: ReplyGuardChainOutcome[] = []
  private rewritten = false
  private fallback: ExpressionDraft['fallback']
  readonly segments: SpeechExpression['segments'] = []

  constructor(private readonly options: {
    replyId: string
    traceId: string
    facts: Omit<ReplyGuardChainInput, 'replyText'>
    emit: (packet: CheckedSpeechSegment) => void
  }) {}

  push(delta: string): void {
    for (const candidate of this.decoder.push(delta)) this.accept(candidate)
  }

  finish(text: string): { outcome: ReplyGuardChainOutcome; expression: SpeechExpression } {
    const draft = this.decoder.finish(text)
    this.fallback = draft.fallback
    if (this.segments.length === 0 && this.pending === '') {
      for (const candidate of draft.segments) this.accept(candidate)
    }
    if (this.pending !== '') { this.check(this.pending, this.pendingCue); this.pending = '' }
    const reminder = this.options.facts.reminderResult
    if (reminder !== undefined && reminder.kind !== 'none') {
      const combined = this.segments.map(segment => segment.text).join('')
      const required = 'text' in reminder ? reminder.text.replace(/^记得/u, '').replace(/[。！!？?]$/u, '') : reminder.message
      if (!combined.includes(required) || ('text' in reminder && !reminderReplyConfirmsChannel(reminder, combined))) this.check(truthfulReminderReply(reminder), 'natural')
    }
    return this.snapshot()
  }

  snapshot(): { outcome: ReplyGuardChainOutcome; expression: SpeechExpression } {
    const base = runReplyGuardChain({ ...this.options.facts, replyText: '', partialReply: true })
    const text = this.segments.map(segment => segment.text).join('')
    const appendices = [base.evidenceAppendix, base.turnContent.appendix].filter(Boolean)
    const outcome = { ...base, replyText: [text, ...appendices].join('\n\n') }
    for (const checked of this.outcomes) {
      if (outcome.reminder !== undefined) outcome.reminder.corrected ||= checked.reminder?.corrected ?? false
      for (const report of checked.reports) {
        outcome.reports = outcome.reports.map(target => target.name !== report.name ? target : {
          ...target,
          state: report.state === 'triggered' || (target.state === 'not_run' && report.state === 'passed')
            ? report.state : target.state,
          reasons: [...new Set([...target.reasons, ...report.reasons])],
        })
      }
      for (const key of Object.keys(outcome.corrected) as (keyof typeof outcome.corrected)[]) {
        outcome.corrected[key] ||= checked.corrected[key]
      }
      for (const key of ['memoryTruth', 'commitmentTruth', 'actionTruth', 'evidenceTruth', 'strippedCitationLabels'] as const) {
        outcome.markers[key] = [...new Set([...outcome.markers[key], ...checked.markers[key]])]
      }
      outcome.turnContent = { ...outcome.turnContent,
        corrected: outcome.turnContent.corrected || checked.turnContent.corrected,
        markers: [...new Set([...outcome.turnContent.markers, ...checked.turnContent.markers])],
        strippedLabels: [...new Set([...outcome.turnContent.strippedLabels, ...checked.turnContent.strippedLabels])],
      }
    }
    return {
      outcome,
      expression: { version: EXPRESSION_VERSION, replyId: this.options.replyId, segments: [...this.segments],
        ...(this.rewritten ? { fallback: 'guard_rewrite' as const } : this.fallback ? { fallback: this.fallback } : {}),
      },
    }
  }

  private accept(candidate: ExpressionDraft['segments'][number]): void {
    if (this.pending === '') this.pendingCue = candidate.cue
    else if (this.pendingCue !== candidate.cue) this.pendingCue = 'natural'
    this.pending += candidate.text
    const pieces = splitSpeechText(this.pending)
    this.pending = ''
    for (const piece of pieces) {
      if (/[。！？!?；;\n]$/.test(piece)) this.check(piece, this.pendingCue)
      else this.pending += piece
    }
  }

  private check(text: string, cue: ExpressionCue): void {
    const outcome = runReplyGuardChain({ ...this.options.facts, replyText: text, partialReply: true })
    this.outcomes.push(outcome)
    const checked = withoutAppendices(outcome.replyText, [outcome.evidenceAppendix, outcome.turnContent.appendix])
    this.rewritten ||= checked !== text
    for (const sentence of splitSpeechText(checked)) {
      if (sentence.trim() === '') continue
      const index = this.segments.length
      const segment = { segmentId: `${this.options.replyId}#${index}`, text: sentence,
        cue: checked === text ? cue : 'natural' as const }
      this.segments.push(segment)
      this.options.emit({ replyId: this.options.replyId, traceId: this.options.traceId,
        segmentIndex: index, segment, guardStates: outcome.reports.map(report => `${report.name}:${report.state}`) })
    }
  }
}
