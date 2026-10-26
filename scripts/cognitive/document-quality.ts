/** Development unit-presence scorer. Candidate visual references are not human-approved gold. */
export interface ReferenceUnit { id: string; page: number; region: string; kind: 'fragments' | 'row'; needles: string[]; columns?: string[] }
export function normalizeReference(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/-\r?\n(?=[a-z])/g, '').replace(/[\s|*_`]/g, '')
}
export function scoreReference(text: string, units: readonly ReferenceUnit[]) {
  const flat = normalizeReference(text), lines = text.split(/\r?\n/).map(normalizeReference)
  return units.map(unit => {
    const needles = unit.needles.map(normalizeReference), present = needles.map(n => flat.includes(n))
    let verdict: 'observed' | 'not_observed' | 'association_unknown' = present.every(Boolean) ? 'observed' : 'not_observed'
    if (verdict === 'observed' && unit.kind === 'row') {
      const row = lines.some(line => {
        let offset = 0
        for (const needle of needles) { const index = line.indexOf(needle, offset); if (index < 0) return false; offset = index + needle.length }
        return true
      })
      if (!row) verdict = 'association_unknown'
    }
    return { id: unit.id, page: unit.page, kind: unit.kind, verdict, present }
  })
}
export function referenceSummary(text: string, units: readonly ReferenceUnit[]) {
  const scores = scoreReference(text, units)
  return { observed: scores.filter(s => s.verdict === 'observed').length,
    notObserved: scores.filter(s => s.verdict === 'not_observed').length,
    associationUnknown: scores.filter(s => s.verdict === 'association_unknown').length, units: units.length, scores }
}
