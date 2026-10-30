import type { RiskLevel } from './action-request.ts'
import type { ActionStatus } from './action-result.ts'
import type { ToolCatalogEntry } from './tool-catalog.ts'

export interface ObservedCapabilityResult {
  actionId: string; operation: string; status: ActionStatus; accepted: boolean; executed: boolean
  idempotentReplay: boolean; observedAt: number
}
/** Read back from an existing gateway; contains no action arguments, body, target or credentials. */
export interface GatewayCapabilityFacts {
  adapterIds: readonly string[]; grantedPermissions: readonly string[]; maxRiskLevel: RiskLevel; dryRun: boolean
  lastResults: Readonly<Record<string, ObservedCapabilityResult>>
}
export interface CapabilityDependencyFact {
  state: 'ready' | 'failed' | 'unknown' | 'not_checked'; reason: string; checkedAt: number | null
}
export interface CapabilityConnectionFact {
  state: 'connected' | 'disconnected' | 'unknown'; checkedAt: number | null
  source: 'runtime-transport' | 'not_observed'
}
type KnownBoolean = boolean | 'unknown'
export interface CurrentCapabilityFact {
  id: string; version: string; operations: readonly string[]; riskLevel: RiskLevel; registered: true
  configured: KnownBoolean; assembled: KnownBoolean; permissionGranted: KnownBoolean; taskCandidate: KnownBoolean
  riskAllowed: KnownBoolean; executionMode: 'live' | 'dry-run' | 'unknown'
  dependency: CapabilityDependencyFact; connection: CapabilityConnectionFact
  lastObservedResult: ObservedCapabilityResult | null
}
export interface CurrentCapabilityView {
  version: 'current-capabilities@1'; observedAt: number; runtimeId: string | null; entry: string
  authority: 'runtime-gateway' | 'registration-only'; tools: readonly CurrentCapabilityFact[]
  sourceRefs: readonly string[]
}
/** Projection only: these facts never grant permission or decide whether an action may execute. */
export function buildCurrentCapabilityFacts(input: {
  catalog: readonly ToolCatalogEntry[]; observedAt: number; runtimeId?: string; entry: string
  configurationObserved: boolean; gateway?: GatewayCapabilityFacts; candidates?: readonly string[]
  dependencies?: Readonly<Record<string, CapabilityDependencyFact>>
  connections?: Readonly<Record<string, CapabilityConnectionFact>>
}): CurrentCapabilityView {
  const gateway = input.gateway
  return { version: 'current-capabilities@1', observedAt: input.observedAt, runtimeId: input.runtimeId ?? null,
    entry: input.entry, authority: gateway ? 'runtime-gateway' : 'registration-only',
    sourceRefs: ['CapabilityRegistry', ...(input.configurationObserved ? ['loaded-kernel-flags'] : []),
      ...(gateway ? ['ActionGateway.adapters', 'ActionGateway.grantedPermissions', 'ActionGateway.result-readback'] : []),
      ...(input.candidates ? ['ChatSession.toolCapabilitiesForTurn'] : []),
      ...(Object.keys(input.dependencies ?? {}).length ? ['capabilityHealth.local-only'] : []),
      ...(Object.keys(input.connections ?? {}).length ? ['runtime-transport'] : [])],
    tools: input.catalog.map(row => ({ id: row.capability, version: row.version,
      operations: row.operations.map(op => op.name), riskLevel: row.riskLevel, registered: true,
      configured: input.configurationObserved ? row.enabled : 'unknown',
      assembled: gateway ? gateway.adapterIds.includes(row.capability) : 'unknown',
      permissionGranted: gateway ? row.permissions.every(p => gateway.grantedPermissions.includes(p)) : 'unknown',
      taskCandidate: input.candidates ? input.candidates.includes(row.capability) : 'unknown',
      riskAllowed: gateway ? Number(row.riskLevel.slice(1)) <= Number(gateway.maxRiskLevel.slice(1)) : 'unknown',
      executionMode: gateway ? gateway.dryRun ? 'dry-run' : 'live' : 'unknown',
      dependency: input.dependencies?.[row.capability] ?? { state: 'not_checked',
        reason: 'not_requested', checkedAt: null },
      connection: input.connections?.[row.capability] ?? { state: 'unknown', checkedAt: null, source: 'not_observed' },
      lastObservedResult: gateway?.lastResults[row.capability] ? { ...gateway.lastResults[row.capability]! } : null,
    })) }
}
