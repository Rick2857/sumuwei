import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { registeredPredicates } from '../../kernel/contracts/index.ts'
import { qualificationEstablishesUserFact, sourceQualificationOf } from '../../kernel/contracts/attribution.ts'
import { isQuestionLike } from '../../kernel/app/memory/content-extractor.ts'
import { detectByRule } from '../../kernel/app/memory/intent-detector.ts'
import { parseCandidatesJson, resolveCandidates, type MemoryExtractor, type MemoryExtractionInput, type MemoryExtractionResult } from '../../kernel/app/memory/extractor.ts'

export const AUTOMATIC_MEMORY_PROCESSOR = 'automatic-memory-langmem'
export const AUTOMATIC_MEMORY_VERSION = 'automatic-memory-langmem@1'

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

function invokeWorker(input: { python: string; signal?: AbortSignal }, request: string): Promise<string> {
  return new Promise((accept, reject) => {
    const signal = AbortSignal.any([AbortSignal.timeout(40_000), ...(input.signal ? [input.signal] : [])])
    const child = spawn(input.python, ['-X', 'utf8', resolve('scripts/automatic_memory_langmem.py')], {
      windowsHide: true, signal, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OPENAI_MODEL: process.env.OPENAI_LARGE_MODEL,
        LANGCHAIN_TRACING_V2: 'false', LANGSMITH_TRACING: 'false' },
    })
    let output = ''
    let failed = false
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
      if (output.length > 32_000) { failed = true; child.kill() }
    })
    // Provider error bodies can contain sensitive source text. Do not retain stderr.
    child.stderr.resume()
    child.stdin.on('error', () => { failed = true })
    child.on('error', () => { failed = true })
    child.once('close', (code) => {
      if (failed || code !== 0 || signal.aborted) reject(new Error('automatic_memory_worker_failed'))
      else accept(output.trim())
    })
    child.stdin.end(request)
  })
}
