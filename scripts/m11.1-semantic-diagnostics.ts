import type { parseReflectionDraft } from '../src/kernel/contracts/reflection.ts'

/** Diagnostic axes only; the frozen scorer and referencesCorrect are unchanged. */
export function diagnoseSemantic(parsed: ReturnType<typeof parseReflectionDraft> | { ok: false }, gold: {
  adopt: boolean; slot: string | null; supportIds: string[]; counterIds: string[]
}, transportFailed: boolean) {
  if (transportFailed) return { kind: 'transport_failed' as const }
  if (!parsed.ok) return { kind: 'invalid_format' as const, reason: 'reason' in parsed ? parsed.reason : null }
  const draft = parsed.draft
  return { kind: 'structured' as const,
    legalSuggestionOmitted: gold.adopt && draft.suggestedSlot === undefined,
    riskSuggestionAdopted: !gold.adopt && draft.suggestedSlot !== undefined,
    expectedSlotCorrect: gold.adopt ? draft.suggestedSlot === gold.slot : null,
    supportComplete: gold.adopt ? gold.supportIds.every(id => draft.supportHandles.includes(id)) : null,
    counterComplete: gold.counterIds.every(id => draft.counterHandles.includes(id)),
  }
}
