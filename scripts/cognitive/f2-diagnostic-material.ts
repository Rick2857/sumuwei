/**
 * **四题诊断的冻结材料读取（自校验摘要）**。
 *
 * ⚠️ 与正式序列分开：诊断材料**只**含 2 个独立开发对象 × A/C 臂 = 4 题，
 *    预算为**追加** 24 请求 / 累计 120,000 token（跨封存累计，不清零）。
 * ⚠️ 摘要不符 / 形状不合法 ⇒ 抛错（fail-closed），**不**回退到正式序列。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

export const F2_DIAGNOSTIC_PATH = 'docs/architecture/f2-preregistration-20261025/diagnostic-4q.json'

export interface F2DiagnosticTask {
  readonly unit: string
  readonly arm: 'A' | 'B' | 'C'
  readonly order: 'cached-first' | 'authoritative-first'
  readonly object: string
  readonly condition: 'fresh' | 'stale'
}
export interface F2DiagnosticMaterial {
  readonly id: string
  readonly digest: string
  readonly frozenAt: string
  readonly family: string
  readonly formation: readonly { readonly object: string, readonly condition: string, readonly role: string }[]
  readonly tasks: readonly F2DiagnosticTask[]
  readonly modelParameters: {
    readonly endpointHost: string
    readonly model: string
    readonly maxCompletionTokens: number
    readonly temperatureRequested: number
    readonly reasoningEffort?: 'low' | 'medium' | 'high'
  }
  readonly budget: {
    readonly requestsCap: number
    readonly tokensCap: number
    readonly perTaskRequests: number
  }
  readonly stopRules: readonly string[]
  readonly limitations: readonly string[]
}

/** 读材料并**自校验摘要**（与 `digestBasis` 同一条规范化 JSON）。 */
export function readF2DiagnosticMaterial (
  path: string = (process.env.F2_DIAGNOSTIC_MATERIAL ?? '').trim() || F2_DIAGNOSTIC_PATH,
): F2DiagnosticMaterial {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const canonical = JSON.stringify({
    id: raw.id,
    frozenAt: raw.frozenAt,
    family: raw.family,
    objects: raw.objects,
    arms: raw.arms,
    tasks: raw.tasks,
    formation: raw.formation,
    modelParameters: raw.modelParameters,
    budget: raw.budget,
    stopRules: raw.stopRules,
  })
  const digest = createHash('sha256').update(canonical).digest('hex')
  if (typeof raw.digest !== 'string' || raw.digest !== digest) throw new Error('f2_diagnostic_digest_mismatch')
  const tasks = raw.tasks as F2DiagnosticTask[]
  const budgetRaw = raw.budget as Record<string, number>
  const requestsCap = Number(budgetRaw.additionalPhysicalRequestsCap)
  const tokensCap = Number(budgetRaw.cumulativeTokenStopThreshold)
  const perTaskRequests = Number(budgetRaw.perTaskRequests)
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('f2_diagnostic_tasks_invalid')
  if (!Number.isFinite(requestsCap) || !Number.isFinite(tokensCap) || !Number.isFinite(perTaskRequests)) throw new Error('f2_diagnostic_budget_invalid')
  return {
    id: String(raw.id), digest, frozenAt: String(raw.frozenAt), family: String(raw.family),
    formation: raw.formation as F2DiagnosticMaterial['formation'],
    tasks,
    modelParameters: raw.modelParameters as F2DiagnosticMaterial['modelParameters'],
    budget: { requestsCap, tokensCap, perTaskRequests },
    stopRules: (raw.stopRules ?? []) as readonly string[],
    limitations: (raw.limitations ?? []) as readonly string[],
  }
}

/** 预算绑定对象（进封存 `budgetCaps`；与正式预算**不同源**）。 */
export function diagnosticBudgetBindingOf (material: F2DiagnosticMaterial): Record<string, number> {
  return { requestsCap: material.budget.requestsCap, tokensCap: material.budget.tokensCap, perTaskRequests: material.budget.perTaskRequests }
}

/* ------------------------------------------------------------------ 累计账目（跨封存不清零） */
export interface F2DiagnosticAccount {
  readonly path: string
  readonly entries: readonly { readonly at: string, readonly startMarker: string, readonly units: number, readonly requests: number, readonly tokens: number, readonly status: string }[]
  readonly requests: number
  readonly tokens: number
}

export function readDiagnosticAccount (executorDir: string): F2DiagnosticAccount {
  const path = resolve(executorDir, 'accounting.jsonl')
  if (!existsSync(path)) return { path, entries: [], requests: 0, tokens: 0 }
  try {
    const entries = readFileSync(path, 'utf8').split(/\r?\n/).filter(line => line.trim() !== '').map(line => JSON.parse(line) as F2DiagnosticAccount['entries'][number])
    return {
      path, entries,
      requests: entries.reduce((sum, entry) => sum + Number(entry.requests ?? 0), 0),
      tokens: entries.reduce((sum, entry) => sum + Number(entry.tokens ?? 0), 0),
    }
  } catch { throw new Error('f2_diagnostic_account_unreadable') }
}

export function appendDiagnosticAccount (executorDir: string, entry: Omit<F2DiagnosticAccount['entries'][number], 'at'>): void {
  mkdirSync(executorDir, { recursive: true })
  appendFileSync(resolve(executorDir, 'accounting.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8')
}
