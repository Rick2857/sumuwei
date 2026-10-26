/** Synthetic mechanism fixtures, not real-user/model acceptance evidence. */
import { makeEblClaim, type EblObservation, type EblSources } from '../../src/kernel/contracts/epistemic-belief.ts'
export const fixtureClaim = () => makeEblClaim({ characterId: 'ebl-test-character', subjectId: 'ebl-test-user',
  domain: 'tool', predicate: 'readback_matches', expected: true, scope: 'sandbox_readback',
  environment: 'sandbox-filesystem@1', conditions: { encoding: 'utf8' }, formation: { kind: 'action', id: 'formation' } })
export function fixtureObservation(id: string, options: Partial<EblObservation> = {}): EblObservation {
  return { ref: { kind: 'action', id }, characterId: 'ebl-test-character', subjectId: 'ebl-test-user',
    episodeId: `episode-${id}`, bindingKey: `binding-${id}`, environment: 'sandbox-filesystem@1',
    targetId: `target-${id}`, observedAt: 1000, independentKey: id, revision: '1', rootIds: [`action:${id}`],
    usable: true, witnessed: true, executed: true, complete: true, value: true, influencedBy: [], ...options }
}
export function fixtureSources(observations: EblObservation[]): EblSources {
  const anchor = fixtureObservation('anchor', { ref: { kind: 'conversation', id: 'anchor' }, observedAt: 0 })
  return { formation: observations.find(item => item.ref.id === 'formation'), observations: [...observations, anchor],
    fingerprint: JSON.stringify(observations.map(item => [item.ref.id, item.usable, item.value])) }
}
/** Hand labels, independent of production reducer/validator calculations. */
export const HAND_LABELED_EBL_TRACE = [
  ['pending', 0, 0, 0], ['pending', 1, 0, 0], ['pending', 1, 1, 0],
  ['pending', 2, 1, 0], ['pending', 2, 2, 0], ['validated', 2, 2, 0],
  ['validated', 2, 2, 1], ['validated', 3, 2, 1], ['suspended', 3, 3, 1], ['retired', 3, 3, 1],
] as const
