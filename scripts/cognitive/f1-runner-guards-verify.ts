/**
 * **G8 门：正式运行器的守卫与记账（零真实模型请求）**
 *
 * 对应预注册 §8 的 G8 一行：
 *   预算请求前计尝试 · 逐请求检查 · usage 缺失不补 0 · 参数/源码/镜像漂移拒跑 · started.lock 防重跑
 *
 * 13 个**独立场景**（每个场景一个独立进程 + 一个新建空白 `lg_test_<id>` 库）：
 *  · 前五个只测**记账口**（`createRequestMeter` / `chargeForUsage`）：纯逻辑，但仍在隔离库里跑
 *  · 第六个测 `started.lock` 的原子性
 *  · 第七~第十个测**封存守卫**（缺项 / UNBOUND / 非 PASS / 漂移 / 授权闸）
 *  · 第十一个**真的起运行器子进程**：没有封存清单 ⇒ 必须拒绝（`missing_seal`）；
 *    有封存但**不含运行授权** ⇒ 必须拒绝（`run_not_authorized`）
 *  · 第十二、十三个跑**一个真实单元**（离线确定性 transport，1 个任务）：
 *    证明三臂装配的所有模型调用（候选 / 轮后记忆 / 反思）都真的穿过同一个记账口
 *
 * ⚠️ 本门**零物理模型请求**：离线 transport 只有声明请求单位（不是费用），
 *    不得把这里的计数当成真实调用。
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runPgScenarioGate } from '../postgresql/scenario-gate.ts'
import { loadPreregData } from './f1-three-arm-factory.ts'
import { createMeteredArmPorts, runArmUnit, F1_PLANNER_TIMEOUT_MS, F1_REQUEST_HARD_TIMEOUT_MS } from './f1-live-runner.ts'
import {
  F1_GUARD_CODES, F1_REQUEST_PARAMETERS, F1_REQUEST_PURPOSES, F1_REQUIRED_GATE_IDS, F1_REQUIRED_SEAL_BINDINGS,
  F1_ABORT_POLICY, F1_TASK_BUDGET, accountUnitOutcome, acquireStartedLock, appendLedgerEntry, assertRunAuthorized,
  buildSealedManifest, canStartUnitWithin, chargeForUsage, createRequestMeter, deriveUnitTimeoutMs,
  endpointMetadataDigest, endpointMetadataFromEnvText, fileDigestOrMissing, loadSealedManifest,
  appendTaskJournalEntry, readAttemptLedger, readTaskJournal, sealIntegrity, sha256Text,
  type F1GuardError, type F1GuardCode,
  type F1SealBindingId, type F1SealCurrent, type F1SealedManifest, type F1SealInput,
} from './f1-live-runner-guards.ts'

const RUNNER_LOCAL = resolve('scripts/cognitive/f1-live-runner.ts')
const RUNNER_FILE_URL = pathToFileURL(RUNNER_LOCAL).href
const OUT_DIR = resolve('artifacts/local/f1-runner-guards')
const RUNNER = 'scripts/cognitive/f1-live-runner.ts'
const CASES = [
  'meter-budget-before-request',
  'meter-attempts-before-fetch',
  'meter-task-request-cap',
  'meter-usage-missing-not-zero',
  'meter-partial-usage-keeps-known-and-stops',
  'meter-token-shrink-and-stop',
  'meter-deadline-refusal',
  'started-lock-refuses-second-run',
  'seal-refuses-missing-or-unbound',
  'seal-refuses-non-pass-gate',
  'seal-integrity-detects-drift',
  'run-authorization-guards',
  'runner-cli-refuses-unsealed',
  'unit-model-calls-metered',
  'unit-usage-missing-conservative',
  'unit-failed-cost-accounting',
  'unit-timeout-derived-from-budget',
  'meter-client-abort-bounded-unverified',
  'task-journal-recovers-completed-tasks',
  'meter-journals-in-flight-before-request',
] as const

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
const requestOf = (): { url: string; init: RequestInit } => ({
  url: 'https://offline.invalid/v1/chat/completions',
  init: {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'x' }], max_tokens: 9999, stream: true }),
  },
})

async function expectGuard(run: () => Promise<unknown> | unknown, code: F1GuardCode): Promise<F1GuardError> {
  try { await run() } catch (error) {
    assert.ok(error instanceof Error && 'code' in error, `期望 ${code}，实际不是守卫错误`)
    const guard = error as F1GuardError
    assert.equal(guard.code, code)
    return guard
  }
  return assert.fail(`期望守卫拒绝 ${code}，实际通过了`) as never
}

/** 端点元数据：优先容器里的测试配置；**只**读非机密字段。 */
function containerEndpoint(): { metadata: { host: string; model: string; apiKeyPresent: boolean; apiKeyLength: number }, metadataSha256: string } {
  const file = [process.env.F1_TEST_ENV_FILE, process.env.TEST_MODEL_ENV_FILE, '/opt/serversim/env/.env.test', '.env.test']
    .find((candidate): candidate is string => candidate !== undefined && candidate.trim() !== '' && existsSync(candidate))
  if (file === undefined) throw new Error('endpoint_env_file_missing')
  const metadata = endpointMetadataFromEnvText(readFileSync(file, 'utf8'))
  return { metadata, metadataSha256: endpointMetadataDigest(metadata) }
}

/** 封存输入的**合法基座**（所有字段齐全）；各负控场景只破坏一处。 */
function fixtureSealInput(tmp: string): F1SealInput {
  const file = (name: string): string => {
    const path = resolve(tmp, name)
    mkdirSync(resolve(path, '..'), { recursive: true })
    writeFileSync(path, `fixture:${name}\n`, 'utf8')
    return path
  }
  const bindings = F1_REQUIRED_SEAL_BINDINGS.map((id: F1SealBindingId) => {
    const path = file(`binding-${id}.txt`)
    return { id, path, sha256: fileDigestOrMissing(path) }
  })
  const gateReadings = F1_REQUIRED_GATE_IDS.map(id => {
    const path = file(`gate-${id}.json`)
    return { id, status: 'PASS' as const, checks: 1, sources: [{ path, sha256: fileDigestOrMissing(path) }] }
  })
  const gateBundlePath = file('gate-bundle.json')
  const endpoint = containerEndpoint()
  const units = ['w01', 'w02', 'w03'].flatMap(worldId => (['A', 'B', 'C'] as const).map(arm => ({
    unit: `${worldId}:${arm}`, worldId, arm,
    tasks: Array.from({ length: 8 }, (_, index) => `${worldId}-t0${String(index + 1)}`),
  })))
  return {
    protocolId: 'f1-qualified-veto-dev@1',
    sealedAt: '2026-10-25T00:00:00.000Z',
    bindings,
    identity: { sourceFingerprint: sha256Text('fixture-source'), imageDigest: sha256Text('fixture-image') },
    endpoint: { ...endpoint.metadata, metadataSha256: endpoint.metadataSha256 },
    parameters: F1_REQUEST_PARAMETERS,
    gateBundle: { path: gateBundlePath, sha256: fileDigestOrMissing(gateBundlePath) },
    gateReadings,
    budget: { perTask: { ...F1_TASK_BUDGET },
      sequence: { requests: 432, totalTokens: 2_000_000, wallClockSeconds: 44_520 } },
    units,
    outputPath: tmp,
    authorization: { modelCallsAuthorized: false, productionActivationAuthorized: false, modelRequestsAtSeal: 0 },
    notes: ['gate fixture（不是执行封存）'],
  }
}

function currentOf(manifest: F1SealedManifest): F1SealCurrent {
  const bindings: Record<string, string> = {}
  for (const binding of manifest.bindings) bindings[binding.id] = fileDigestOrMissing(resolve(binding.path))
  return {
    bindings,
    identity: { sourceFingerprint: manifest.identity.sourceFingerprint, imageDigest: manifest.identity.imageDigest },
    endpoint: { host: manifest.endpoint.host, model: manifest.endpoint.model,
      apiKeyLength: manifest.endpoint.apiKeyLength, metadataSha256: manifest.endpoint.metadataSha256 },
    parameters: F1_REQUEST_PARAMETERS,
  }
}

const checks = (): { list: string[]; check: (label: string, pass: unknown) => void } => {
  const list: string[] = []
  return {
    list,
    check(label, pass) {
      assert.ok(pass, label)
      list.push(label)
      console.log(`PASS ${label}`)
    },
  }
}

async function runCase(caseId: string): Promise<void> {
  const { list, check } = checks()
  mkdirSync(OUT_DIR, { recursive: true })
  const tmp = mkdtempSync(resolve(OUT_DIR, `case-${caseId}-`))
  /** 离线声明的请求单位（**不是**物理模型调用/费用） */
  let declaredRequestUnits = 0
  try {
    switch (caseId) {
      // ------------------------------------------------------------- 记账口
      case 'meter-budget-before-request': {
        let transportCalls = 0
        const meter = createRequestMeter({
          allowance: { requests: 0, tokens: 10_000, deadlineAt: Date.now() + 60_000 },
          maxCompletionTokens: 4096,
          transport: async () => { transportCalls += 1; return { status: 200, text: '{}' } },
        })
        const error = await expectGuard(() => meter.send('candidate', requestOf()), 'budget_refused')
        check('预算不足 ⇒ 守卫拒绝（budget_refused）', error.code === 'budget_refused')
        check('拒绝发生在 transport **之前**（0 次调用）', transportCalls === 0)
        check('被拒请求**不**计尝试（attempts 保持 0）', meter.requestsAttempted === 0)
        check('拒绝留痕且 outcome=budget_refused / attempt=0',
          meter.calls.length === 1 && meter.calls[0]!.outcome === 'budget_refused' && meter.calls[0]!.attempt === 0)
        check('被拒请求零 token 扣账', meter.tokensCharged === 0)
        break
      }
      case 'meter-attempts-before-fetch': {
        let transportCalls = 0
        const meter = createRequestMeter({
          allowance: { requests: 1, tokens: 1_000_000, deadlineAt: Date.now() + 60_000 },
          maxCompletionTokens: 100,
          transport: async () => { transportCalls += 1; throw new Error('network_down') },
        })
        await expectGuard(() => meter.send('candidate', requestOf()), 'transport_failed')
        check('传输失败 ⇒ 拒绝且**不自动重试**（transport 恰好 1 次）', transportCalls === 1)
        check('尝试数在 transport 之前计（=1，不是 0）', meter.requestsAttempted === 1)
        check('失败也留痕（outcome=transport_failed）', meter.calls.length === 1 && meter.calls[0]!.outcome === 'transport_failed')
        check('usage 读数缺失 ⇒ reportedTokens=null（不补 0）', meter.calls[0]!.usageMissing && meter.calls[0]!.reportedTokens === null)
        check('传输失败 ⇒ 成本未确认（costVerifiable=false），扣账只是已知下限', meter.calls[0]!.costVerifiable === false && meter.tokensCharged === 100)
        const second = await expectGuard(() => meter.send('candidate', requestOf()), 'cost_unverifiable')
        check('成本未确认 ⇒ **停止后续请求**（在 transport 之前拒绝）', transportCalls === 1 && second.code === 'cost_unverifiable')
        break
      }
      case 'meter-task-request-cap': {
        let transportCalls = 0
        let tag = { taskId: 'w01-t01', ordinal: 1 }
        const meter = createRequestMeter({
          allowance: { requests: 100, tokens: 10_000_000, deadlineAt: Date.now() + 60_000 },
          maxCompletionTokens: 4096, maxRequestsPerTask: F1_TASK_BUDGET.maxModelRequests,
          taskTag: () => tag,
          transport: async () => { transportCalls += 1; return { status: 200, text: JSON.stringify({ usage: { total_tokens: 10 } }) } },
        })
        for (let index = 0; index < F1_TASK_BUDGET.maxModelRequests; index += 1) {
          await meter.send(index % 3 === 0 ? 'candidate' : index % 3 === 1 ? 'post_turn_memory' : 'reflection', requestOf())
        }
        check('单题 6 次（候选/记忆/反思合计）都被允许', transportCalls === F1_TASK_BUDGET.maxModelRequests)
        check('单题请求计数按 taskId 归并', meter.taskAttempts()['w01-t01'] === F1_TASK_BUDGET.maxModelRequests)
        const seventh = await expectGuard(() => meter.send('candidate', requestOf()), 'task_request_limit')
        check('同一 taskId 第 7 次 ⇒ task_request_limit（不是"再放一次"）', seventh.code === 'task_request_limit')
        check('第 7 次**没有**发出（transport 仍 6 次）', transportCalls === F1_TASK_BUDGET.maxModelRequests)
        check('第 7 次不计尝试（attempts 仍 6）', meter.requestsAttempted === F1_TASK_BUDGET.maxModelRequests)
        check('第 7 次留痕且 attempt=0 / 理由=单题请求数上限',
          meter.calls.at(-1)!.attempt === 0 && meter.calls.at(-1)!.budgetRefusal === '单题请求数上限')
        // 换一个 taskId 仍可请求（上限是**每任务**，不是每单元）
        tag = { taskId: 'w01-t02', ordinal: 2 }
        await meter.send('candidate', requestOf())
        check('换 taskId 后不受前一任务上限影响', transportCalls === F1_TASK_BUDGET.maxModelRequests + 1)
        break
      }
      case 'meter-usage-missing-not-zero': {
        const noUsage = createRequestMeter({
          allowance: { requests: 5, tokens: 1_000_000, deadlineAt: Date.now() + 60_000 }, maxCompletionTokens: 4096,
          transport: async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }),
        })
        await noUsage.send('candidate', requestOf())
        const call = noUsage.calls[0]!
        check('响应无 usage ⇒ usageMissing=true', call.usageMissing)
        check('响应无 usage ⇒ reportedTokens=null（**不是 0**）', call.reportedTokens === null)
        check('响应无 usage ⇒ 成本标记**未确认**（costVerifiable=false）', call.costVerifiable === false)
        check('响应无 usage ⇒ 扣账只是已知下限（0 + 4096）', call.chargedTokens === 4096)
        check('币值只加在 charged 上（tokensReported 仍 0）', noUsage.tokensReported === 0 && noUsage.tokensCharged === 4096)
        let secondCalls = 0
        const noUsageSecond = createRequestMeter({
          allowance: { requests: 5, tokens: 1_000_000, deadlineAt: Date.now() + 60_000 }, maxCompletionTokens: 4096,
          transport: async () => { secondCalls += 1; return { status: 200, text: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) } },
        })
        await noUsageSecond.send('candidate', requestOf())
        await expectGuard(() => noUsageSecond.send('candidate', requestOf()), 'cost_unverifiable')
        check('缺 usage 后 ⇒ 后续请求被拒（第 2 次 transport 0 次）', secondCalls === 1)
        const withUsage = createRequestMeter({
          allowance: { requests: 5, tokens: 1_000_000, deadlineAt: Date.now() + 60_000 }, maxCompletionTokens: 4096,
          transport: async () => ({ status: 200, text: JSON.stringify({ usage: { total_tokens: 123 } }) }),
        })
        await withUsage.send('candidate', requestOf())
        check('响应带 usage ⇒ 按真读数扣账（123）且成本已确认',
          withUsage.calls[0]!.reportedTokens === 123 && withUsage.calls[0]!.chargedTokens === 123 && withUsage.calls[0]!.costVerifiable === true)
        check('响应带 usage ⇒ usageMissing=false', withUsage.calls[0]!.usageMissing === false)
        const split = chargeForUsage({ prompt_tokens: 5, completion_tokens: 7 }, 4096)
        check('usage 只有分项（两个都在）⇒ prompt+completion 求和（12）且成本已确认',
          split.reportedTokens === 12 && split.usageMissing === false && split.costVerifiable === true)
        const genuineZero = chargeForUsage({ total_tokens: 0 }, 4096)
        check('provider 明确报 0 ⇒ 尊重真读数（不强行改成上限）', genuineZero.chargedTokens === 0 && genuineZero.usageMissing === false && genuineZero.costVerifiable === true)
        break
      }
      case 'meter-partial-usage-keeps-known-and-stops': {
        // 用户给定探针：已知输入 10000 token，其余缺失 —— 不得只记 4096（输出上限不是总 token 上限）
        const partial = chargeForUsage({ prompt_tokens: 10_000 }, 4096)
        check('只有 prompt_tokens=10000 ⇒ 总量标未知（reportedTokens=null）', partial.reportedTokens === null)
        check('只有 prompt_tokens=10000 ⇒ **保留已知输入量**（knownPromptTokens=10000）', partial.knownPromptTokens === 10_000)
        check('只有 prompt_tokens=10000 ⇒ 成本未确认（costVerifiable=false）', partial.costVerifiable === false && partial.usageMissing === true)
        check('只有 prompt_tokens=10000 ⇒ 扣账 ≥ 已知输入（14096，不是 4096）', partial.chargedTokens === 10_000 + 4096)
        // 已知输出、缺输入：同样保留已知量并停下（输入未知，不能声称已确认）
        const partialCompletion = chargeForUsage({ completion_tokens: 50 }, 4096)
        check('只有 completion_tokens=50 ⇒ knownCompletionTokens=50、总量未知、成本未确认',
          partialCompletion.knownCompletionTokens === 50 && partialCompletion.reportedTokens === null && partialCompletion.costVerifiable === false)
        // 真正的计量器：第一条不完整 usage 之后，第二条请求必须被拒
        let transportCalls = 0
        const meter = createRequestMeter({
          allowance: { requests: 50, tokens: 10_000_000, deadlineAt: Date.now() + 60_000 }, maxCompletionTokens: 4096,
          transport: async () => { transportCalls += 1; return { status: 200, text: JSON.stringify({ usage: { prompt_tokens: 10_000 } }) } },
        })
        await meter.send('candidate', requestOf())
        check('第一条含已知输入的响应 ⇒ 扣账 14096（≥ 已知输入），tokensReported 仍 0',
          meter.tokensCharged === 14_096 && meter.tokensReported === 0)
        await expectGuard(() => meter.send('candidate', requestOf()), 'cost_unverifiable')
        check('成本未确认后 ⇒ 后续请求停止（transport 仍 1 次）', transportCalls === 1)
        check('停止理由写进 budgetStopReason（序列应标 INCOMPLETE）',
          (meter.budgetStopReason() ?? '').includes('成本无法确认'))
        break
      }
      case 'meter-token-shrink-and-stop': {
        let transportCalls = 0
        const meter = createRequestMeter({
          allowance: { requests: 10, tokens: 100, deadlineAt: Date.now() + 60_000 }, maxCompletionTokens: 4096,
          transport: async () => { transportCalls += 1; return { status: 200, text: JSON.stringify({ usage: { total_tokens: 60 } }) } },
        })
        await meter.send('candidate', requestOf())
        check('剩余 token < 单请求上限 ⇒ 该请求 max_tokens 缩到剩余量（100）', meter.calls[0]!.effectiveMaxTokens === 100)
        await meter.send('candidate', requestOf())
        check('第二次把 max_tokens 缩到剩余量（40）', meter.calls[1]!.effectiveMaxTokens === 40)
        check('累计扣账可越过上限（如实记 overshoot=20，不删读数）', meter.tokensCharged === 120 && meter.overshoot === 20)
        const third = await expectGuard(() => meter.send('candidate', requestOf()), 'budget_refused')
        check('越过上限后 ⇒ 后续请求在 transport 前停止', transportCalls === 2 && third.message.includes('总 token 上限'))
        break
      }
      case 'meter-deadline-refusal': {
        let transportCalls = 0
        const meter = createRequestMeter({
          allowance: { requests: 10, tokens: 10_000, deadlineAt: Date.now() - 1 }, maxCompletionTokens: 4096,
          transport: async () => { transportCalls += 1; return { status: 200, text: '{}' } },
        })
        const error = await expectGuard(() => meter.send('candidate', requestOf()), 'budget_refused')
        check('序列截止时间已过 ⇒ 拒绝', error.message.includes('序列时限'))
        check('截止时间拒绝也在 transport 之前（0 次）', transportCalls === 0)
        break
      }

      // ------------------------------------------------------------ 防重跑
      case 'started-lock-refuses-second-run': {
        const dir = resolve(tmp, 'run-a')
        const lock = acquireStartedLock(dir, 'marker-0123456789abcdef')
        const content = readFileSync(lock.path, 'utf8')
        check('started.lock 首次创建成功且写入 startMarker', existsSync(lock.path) && content.includes('marker-0123456789abcdef'))
        await expectGuard(() => acquireStartedLock(dir, 'marker-0123456789abcdef'), 'already_started')
        check('第二次（同目录同 startMarker）⇒ already_started', true)
        await expectGuard(() => acquireStartedLock(dir, 'marker-other'), 'already_started')
        check('第二次（同目录不同 startMarker）同样拒绝（不覆盖）', true)
        check('拒绝**不删除**锁文件（防"清空再跑"）', existsSync(lock.path))
        rmSync(lock.path)
        acquireStartedLock(dir, 'marker-0123456789abcdef')
        check('手工删除后重新创建成功（原子闸本身可恢复；代码不提供自动删锁）', existsSync(lock.path))
        break
      }

      // ------------------------------------------------------------ 封存守卫
      case 'seal-refuses-missing-or-unbound': {
        buildSealedManifest(fixtureSealInput(tmp))
        check('合法基座可以封存（control）', true)
        const missing = fixtureSealInput(tmp)
        missing.bindings = missing.bindings.filter(binding => binding.id !== 'runner')
        await expectGuard(() => buildSealedManifest(missing), 'binding_missing')
        check('少一个绑定项 ⇒ binding_missing', true)
        const unbound = fixtureSealInput(tmp)
        // 把任意一项摘要改成 MISSING（非法 64hex）⇒ 拒绝
        unbound.bindings[0] = { ...unbound.bindings[0]!, sha256: 'MISSING' }
        await expectGuard(() => buildSealedManifest(unbound), 'binding_unbound')
        check('绑定摘要 MISSING / 非 64hex ⇒ binding_unbound', true)
        const noIdentity = fixtureSealInput(tmp)
        noIdentity.identity = { sourceFingerprint: 'UNBOUND', imageDigest: 'UNBOUND' }
        await expectGuard(() => buildSealedManifest(noIdentity), 'identity_unbound')
        check('源码/镜像身份未绑定（UNBOUND）⇒ identity_unbound', true)
        const noKey = fixtureSealInput(tmp)
        noKey.endpoint = { ...noKey.endpoint, apiKeyPresent: false, apiKeyLength: 0 }
        await expectGuard(() => buildSealedManifest(noKey), 'endpoint_invalid')
        check('端点无 key（无法证明提供方存在）⇒ endpoint_invalid', true)
        const badParams = fixtureSealInput(tmp)
        badParams.parameters = { ...F1_REQUEST_PARAMETERS, maxCompletionTokens: 2048 } as unknown as typeof F1_REQUEST_PARAMETERS
        await expectGuard(() => buildSealedManifest(badParams), 'invalid_parameter')
        check('参数偏离 F1_REQUEST_PARAMETERS ⇒ invalid_parameter（不许按结果换参数）', true)
        const badUnits = fixtureSealInput(tmp)
        badUnits.units = badUnits.units.slice(0, 8)
        await expectGuard(() => buildSealedManifest(badUnits), 'seal_incomplete')
        check('执行单元规模不符（8 ≠ 9）⇒ seal_incomplete', true)
        break
      }
      case 'seal-refuses-non-pass-gate': {
        const failing = fixtureSealInput(tmp)
        failing.gateReadings = failing.gateReadings.map(gate => gate.id === 'G9_quota_and_parameters' ? { ...gate, status: 'FAIL' as const } : gate)
        await expectGuard(() => buildSealedManifest(failing), 'gate_reading_not_pass')
        check('门读数 FAIL ⇒ gate_reading_not_pass（不许带红封存）', true)
        const missingGate = fixtureSealInput(tmp)
        missingGate.gateReadings = missingGate.gateReadings.map(gate => gate.id === 'G2_timing_calibration' ? { ...gate, status: 'MISSING' as const } : gate)
        await expectGuard(() => buildSealedManifest(missingGate), 'gate_reading_missing')
        check('门读数 MISSING ⇒ gate_reading_missing（缺项不是 PASS）', true)
        const absent = fixtureSealInput(tmp)
        absent.gateReadings = absent.gateReadings.filter(gate => gate.id !== 'full_ci')
        await expectGuard(() => buildSealedManifest(absent), 'gate_reading_missing')
        check('缺少必需门（full_ci）⇒ gate_reading_missing', true)
        const notRun = fixtureSealInput(tmp)
        notRun.gateReadings = notRun.gateReadings.map(gate => gate.id === 'preflight_after' ? { ...gate, status: 'NOT RUN' as const } : gate)
        await expectGuard(() => buildSealedManifest(notRun), 'gate_reading_not_pass')
        check('门读数 NOT RUN ⇒ gate_reading_not_pass（未跑不是通过）', true)
        break
      }
      case 'seal-integrity-detects-drift': {
        const manifest = buildSealedManifest(fixtureSealInput(tmp))
        check('封存清单自指纹字段存在（64 hex）', manifest.selfDigest.length === 64)
        const sealPath = resolve(tmp, 'sealed-manifest.json')
        writeFileSync(sealPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
        check('写入后可读回（自指纹相符）', loadSealedManifest(sealPath).startMarker === manifest.startMarker)
        check('干净状态 ⇒ 无漂移', sealIntegrity(manifest, currentOf(manifest)).length === 0)
        // 逐项破坏 current，必须被逐项列出
        const driftBindings = currentOf(manifest)
        driftBindings.bindings = { ...driftBindings.bindings, runner: sha256Text('changed-runner') }
        check('绑定摘要漂移 ⇒ 被列出', sealIntegrity(manifest, driftBindings).some(item => item.includes('binding runner')))
        const driftIdentity = currentOf(manifest)
        driftIdentity.identity = { sourceFingerprint: sha256Text('other-source'), imageDigest: manifest.identity.imageDigest }
        check('源码指纹漂移 ⇒ 被列出', sealIntegrity(manifest, driftIdentity).some(item => item.includes('sourceFingerprint')))
        const driftImage = currentOf(manifest)
        driftImage.identity = { sourceFingerprint: manifest.identity.sourceFingerprint, imageDigest: sha256Text('other-image') }
        check('镜像身份漂移 ⇒ 被列出', sealIntegrity(manifest, driftImage).some(item => item.includes('imageDigest')))
        const driftEndpoint = currentOf(manifest)
        driftEndpoint.endpoint = { ...driftEndpoint.endpoint, host: 'other.invalid' }
        check('端点主机漂移 ⇒ 被列出', sealIntegrity(manifest, driftEndpoint).some(item => item.includes('endpoint host')))
        const driftParams = currentOf(manifest)
        driftParams.parameters = { ...F1_REQUEST_PARAMETERS, maxCompletionTokens: 2048 } as unknown as typeof F1_REQUEST_PARAMETERS
        check('参数漂移 ⇒ 被列出', sealIntegrity(manifest, driftParams).some(item => item.includes('maxCompletionTokens')))
        const missing = currentOf(manifest)
        missing.identity = { sourceFingerprint: undefined, imageDigest: undefined }
        check('运行前未提供身份 ⇒ 被列出（不默认放行）', sealIntegrity(manifest, missing).filter(item => item.includes('identity')).length === 2)
        // 清单被手改 ⇒ 拒绝加载
        const tampered = JSON.parse(readFileSync(sealPath, 'utf8')) as Record<string, unknown>
        tampered.sealedAt = '2026-10-26T00:00:00.000Z'
        writeFileSync(sealPath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8')
        await expectGuard(() => loadSealedManifest(sealPath), 'seal_drift')
        check('封存清单被手改（自指纹不符）⇒ seal_drift', true)
        await expectGuard(() => loadSealedManifest(resolve(tmp, 'no-such-seal.json')), 'missing_seal')
        check('没有封存清单 ⇒ missing_seal（不是跳过封存）', true)
        break
      }
      case 'run-authorization-guards': {
        const authorized = buildSealedManifest({ ...fixtureSealInput(tmp),
          authorization: { modelCallsAuthorized: true, productionActivationAuthorized: false, modelRequestsAtSeal: 0 } })
        const env = { F1_MODEL_CALLS_AUTHORIZED: '1', SERVERSIM_MARKER: 'lg-serversim@gate-fixture' }
        assertRunAuthorized({ manifest: authorized, drift: [], env })
        check('授权封存 + 显式标记 + serversim ⇒ 放行（control）', true)
        await expectGuard(() => assertRunAuthorized({ manifest: authorized, drift: [], env: { ...env, F1_MODEL_CALLS_AUTHORIZED: undefined } }),
          'authorization_marker_missing')
        check('缺少显式授权标记 ⇒ authorization_marker_missing', true)
        await expectGuard(() => assertRunAuthorized({ manifest: authorized, drift: [], env: { ...env, SERVERSIM_MARKER: undefined } }),
          'serversim_required')
        check('不在 serversim ⇒ serversim_required', true)
        await expectGuard(() => assertRunAuthorized({ manifest: authorized, drift: [], env: { ...env, F1_ALLOW_OFFLINE: '1' } }),
          'offline_marker_forbidden')
        check('真实运行带离线标记 ⇒ offline_marker_forbidden', true)
        await expectGuard(() => assertRunAuthorized({ manifest: authorized, drift: ['binding runner'], env }),
          'seal_drift')
        check('有漂移 ⇒ seal_drift（先拒跑）', true)
        const unauthorized = buildSealedManifest(fixtureSealInput(tmp))
        await expectGuard(() => assertRunAuthorized({ manifest: unauthorized, drift: [], env }),
          'run_not_authorized')
        check('封存不含运行授权 ⇒ run_not_authorized', true)
        const production = JSON.parse(JSON.stringify(authorized)) as F1SealedManifest
        production.authorization = { ...production.authorization, productionActivationAuthorized: true as never }
        await expectGuard(() => assertRunAuthorized({ manifest: production, drift: [], env }),
          'production_activation_forbidden')
        check('封存声称生产激活 ⇒ production_activation_forbidden', true)
        check('授权闸要求清单状态 = SEALED_RUN_AUTHORIZED', authorized.status === 'SEALED_RUN_AUTHORIZED')
        break
      }
      case 'runner-cli-refuses-unsealed': {
        // ① 没有封存清单 ⇒ --run 拒绝（missing_seal），且不可能发请求
        const emptyRoot = resolve(tmp, 'empty-evidence')
        mkdirSync(emptyRoot, { recursive: true })
        const run = spawnSync(process.execPath, ['--import', './node_modules/tsx/dist/loader.mjs', RUNNER, '--run'], {
          cwd: process.cwd(), encoding: 'utf8', timeout: 120_000,
          env: { ...process.env, F1_EVIDENCE_ROOT: emptyRoot },
        })
        const runOutput = `${run.stdout ?? ''}${run.stderr ?? ''}`
        check('没有封存清单 ⇒ --run 退出非 0', run.status !== 0)
        check('拒绝码是 missing_seal（不是"跳过封存"）', runOutput.includes('missing_seal'))
        // ② 有封存但**不含运行授权** ⇒ --run 拒绝（run_not_authorized）
        const sealedRoot = resolve(tmp, 'unauthorized-evidence')
        mkdirSync(sealedRoot, { recursive: true })
        const manifest = buildSealedManifest(fixtureSealInput(sealedRoot))
        writeFileSync(resolve(sealedRoot, 'sealed-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
        const unauthorized = spawnSync(process.execPath, ['--import', './node_modules/tsx/dist/loader.mjs', RUNNER, '--run'], {
          cwd: process.cwd(), encoding: 'utf8', timeout: 120_000,
          env: { ...process.env, F1_EVIDENCE_ROOT: sealedRoot,
            F1_SOURCE_FINGERPRINT: manifest.identity.sourceFingerprint, F1_IMAGE_DIGEST: manifest.identity.imageDigest },
        })
        const unauthorizedOutput = `${unauthorized.stdout ?? ''}${unauthorized.stderr ?? ''}`
        check('有封存但无运行授权 ⇒ --run 退出非 0', unauthorized.status !== 0)
        check('拒绝码是 run_not_authorized', unauthorizedOutput.includes('run_not_authorized'))
        check('拒绝发生在任何单元启动之前（输出里没有 UNIT 行）', !unauthorizedOutput.includes('UNIT '))
        break
      }

      // -------------------------------------------------- 真实单元（离线 transport）
      case 'unit-model-calls-metered':
      case 'unit-usage-missing-conservative': {
        process.env.F1_ALLOW_OFFLINE = '1'
        process.env.F1_OFFLINE_MODE = '1'
        const omitUsage = caseId === 'unit-usage-missing-conservative'
        const { tasks, oracle } = loadPreregData()
        const task = tasks.find(item => item.worldId === 'w01' && item.ordinal === 1)!
        const entry = oracle.find(item => item.worldId === 'w01')!.schedule.find(item => item.taskId === task.taskId)!
        const report = await runArmUnit({
          worldId: 'w01', arm: 'A', tasks: [task], oracle: [entry],
          allowance: { requests: 40, tokens: 1_000_000, deadlineAt: Date.now() + 180_000 },
          transportKind: 'offline-fixture', offlineOmitUsage: omitUsage,
          evidenceDir: resolve(tmp, 'unit-files'), reportPath: resolve(tmp, `${caseId}.json`),
        })
        const calls = report.calls
        const observedPurposes = [...new Set(calls.map(call => call.purpose))]
        console.log(`observedPurposes=${JSON.stringify(observedPurposes)} calls=${String(calls.length)}`)
        check('单元报告真的落盘且可读', existsSync(resolve(tmp, `${caseId}.json`)))
        check('所有**尝试**都穿过同一个记账口（attemptedCalls === modelRequests）',
          calls.filter(call => call.attempt >= 1).length === report.modelRequests)
        check('每次尝试都有尝试序号（attempt ≥ 1 且 ≤ modelRequests）',
          calls.filter(call => call.attempt >= 1).every(call => call.attempt <= report.modelRequests))
        check('请求用途都在闭集内（没有第四类偷偷调用）',
          observedPurposes.every(purpose => (F1_REQUEST_PURPOSES as readonly string[]).includes(purpose)))
        check('候选生成真的穿过记账口', observedPurposes.includes('candidate'))
        check('轮后记忆真的穿过记账口', observedPurposes.includes('post_turn_memory'))
        // 反思尾链是否真的触发由内核调度决定（本夹具不强制它跑）；若触发则必须已记账。
        check('反思调用若触发则已记账（未触发如实记，不用别的角色冒充）',
          observedPurposes.includes('reflection') || !calls.some(call => call.purpose === 'reflection'))
        check('每次调用都记到当前任务（taskId 非空且为本题）', calls.every(call => call.taskId === task.taskId))
        check('本单元恰好跑 1 个任务且 auditor 无异常', report.tasks.length === 1 && report.observerErrors.length === 0)
        check('报告声明零物理模型请求（离线 transport 不是模型）', report.provider === 'offline-fixture' && report.endpoint === null)
        check('报告不声明生产打开', report.productionOpened === false)
        check('planner 实际请求消息被捕获（同形性材料在真实运行器里也在）', report.plannerInputs.length > 0)
        // 端口直测：不依赖反思尾链是否被内核调度，直接证明**三类角色端口**都进同一个 meter
        const portMeter = createRequestMeter({
          allowance: { requests: 10, tokens: 1_000_000, deadlineAt: Date.now() + 60_000 }, maxCompletionTokens: 4096,
          transport: async purpose => ({ status: 200, text: JSON.stringify({
            choices: [{ message: { content: purpose === 'post_turn_memory' ? '{"destination":"none","decisions":[]}' : '{}' } }],
            usage: { total_tokens: 9 },
          }) }),
        })
        const portEndpoint = { baseUrl: 'https://offline.invalid/v1', model: 'offline-fixture', key: 'offline-fixture', host: 'offline.invalid' }
        const ports = createMeteredArmPorts({ endpoint: portEndpoint, meter: portMeter, maxCompletionTokens: 4096 })
        const candidateResponse = await ports.fetchImpl('https://offline.invalid/v1/chat/completions',
          { method: 'POST', body: JSON.stringify({ model: 'stale-model', messages: [{ role: 'user', content: 'fixture' }], max_tokens: 9999 }) })
        const candidateText = await candidateResponse.text()
        await ports.memoryInvoke('fixture memory prompt')
        await ports.reflectionProvider.call({ characterId: 'fixture', window: [], handles: [], counterHandles: [],
          triggerReasonCodes: ['fixture'], deadlineMs: 5_000 })
        check('端口直测：三类角色调用都进同一 meter（顺序 = 候选 / 记忆 / 反思）',
          JSON.stringify(portMeter.calls.map(call => call.purpose)) === JSON.stringify(['candidate', 'post_turn_memory', 'reflection']))
        check('端口直测：请求 max_tokens 被改写到封存上限（9999 → 4096）',
          portMeter.calls[0]!.effectiveMaxTokens === F1_REQUEST_PARAMETERS.maxCompletionTokens)
        check('端口直测：响应正文原样返回（没有被记账口吞掉）', candidateText.includes('choices'))
        check('端口直测：每次调用按 usage 真读数扣账（9×3 = 27）', portMeter.tokensCharged === 27 && portMeter.usageMissingCount === 0)
        check('任务行带本任务成本（请求数非 0）', report.tasks[0]!.cost.requests > 0)
        check('任务行记录了本任务出现的请求用途', report.tasks[0]!.cost.purposes.length > 0)
        // ---- 请求账本（每次尝试立即落盘；崩溃也能对账）----
        check('请求账本文件存在且可读', existsSync(report.ledgerPath) && report.ledger.readable)
        check('账本行数 = started + finished + refused（**阶段化**记账）',
          report.ledger.lines === report.ledger.requestsAttempted + report.ledger.requestsFinished + report.ledger.requestsRefused)
        check('账本发出数 = 报告尝试数', report.ledger.requestsAttempted === report.modelRequests)
        check('账本 token（已确认下限）与报告一致',
          report.ledger.tokensCharged === report.cost.tokensCharged && report.ledger.tokensReported === report.cost.tokensReported)
        check('账本 usage 缺失计数与报告一致', report.ledger.usageMissingCount === report.cost.usageMissingCount)
        // ⚠️ 第二本账：真实单元跑完必须留下**每题一条** task_finished（崩溃后靠它取回已完成题）
        const unitJournal = readTaskJournal(report.taskJournalPath)
        check(`单元跑完留下任务账本，且完成数 = 已跑题数（finished=${String(unitJournal.finished)} / tasks=${String(report.tasks.length)}）`,
          unitJournal.readable && unitJournal.finished === report.tasks.length)
        check('任务账本的题顺序与报告一致（无缺题、无重题）',
          unitJournal.rows.map(item => item.taskId).join(',') === report.tasks.map(row => row.taskId).join(','))
        check('任务账本里没有"开始了但没结论"的题（正常结束）', unitJournal.inFlightTaskIds.length === 0)
        check('账本成对：发出数 = 完成数，**无在途残留**（单元正常结束时）',
          report.ledger.requestsAttempted === report.ledger.requestsFinished && report.ledger.inFlightAttempts === 0)
        check('被拒绝的请求在账本里是 attempt_refused（不计尝试、不计成本）',
          report.ledger.requestsRefused >= 0 && report.ledger.requestsAttempted === report.modelRequests)
        check('**单题**请求数上限在真实单元里落实（每个 taskId ≤ 6）',
          Object.values(report.cost.taskAttempts).every(count => count <= F1_TASK_BUDGET.maxModelRequests))
        if (omitUsage) {
          // 缺陷 2 的端到端后果：缺 usage ⇒ 成本未确认 ⇒ **后续请求停止**、单元预算停止 ⇒ INCOMPLETE
          check('usage 缺失：成本未确认（costUnverifiable=true）', report.cost.costUnverifiable === true)
          check('usage 缺失：只有**一次**真实尝试（后续请求被 stop）', report.modelRequests === 1 && calls.filter(call => call.attempt >= 1).length === 1)
          check('usage 缺失：账本里只有 1 次发出、其余是 attempt_refused',
            report.ledger.requestsAttempted === 1 && report.ledger.requestsFinished === 1 && report.ledger.requestsRefused >= 1)
          check('usage 缺失：后续调用是拒绝（attempt=0，理由=成本无法确认）',
            calls.filter(call => call.attempt === 0).every(call => call.budgetRefusal === 'usage 不完整（成本无法确认）'))
          check('usage 缺失：总量标未知（tokensReported=0），扣账仅已知下限 4096',
            report.cost.tokensReported === 0 && report.cost.tokensCharged === 4096)
          check('usage 缺失：usageMissingCount=1（不是 calls.length）', report.cost.usageMissingCount === 1)
          check('usage 缺失：单元 budgetStop = 成本无法确认（序列应 INCOMPLETE）',
            (report.budgetStop ?? '').includes('成本无法确认'))
        } else {
          check('usage 在场：每次**尝试**都有真读数（18）',
            calls.filter(call => call.attempt >= 1).every(call => call.usageMissing === false && call.reportedTokens === 18))
          check('usage 在场：全部调用成本已确认（costUnverifiable=false）', report.cost.costUnverifiable === false)
          check('usage 在场：账本里发出数 = 完成数（没有在途残留）',
            report.ledger.requestsAttempted === report.ledger.requestsFinished)
          check('usage 在场：若出现拒绝，只可能是单题请求数上限（不是其它异常）',
            calls.filter(call => call.attempt === 0).every(call => call.budgetRefusal === '单题请求数上限'))
          check('usage 在场：报告 tokensReported = 尝试数×18',
            report.cost.tokensReported === calls.filter(call => call.attempt >= 1).length * 18)
          check('usage 在场：报告 tokensCharged = tokensReported', report.cost.tokensCharged === report.cost.tokensReported)
          check('usage 在场：usageMissingCount=0', report.cost.usageMissingCount === 0)
          check('usage 在场：单元没有被成本/预算停止', report.budgetStop === null)
        }
        declaredRequestUnits = report.modelRequests
        break
      }
      case 'unit-failed-cost-accounting': {
        // 缺陷 3：失败单元也必须先对账；成本无法确认 ⇒ 停止序列并标 INCOMPLETE。
        const crashedLedgerPath = resolve(tmp, 'crash-ledger.jsonl')
        writeFileSync(crashedLedgerPath, '', 'utf8')
        const crashedMeter = createRequestMeter({
          allowance: { requests: 50, tokens: 10_000_000, deadlineAt: Date.now() + 60_000 }, maxCompletionTokens: 4096,
          transport: async () => ({ status: 200, text: JSON.stringify({ usage: { total_tokens: 18 } }) }),
          ledgerPath: crashedLedgerPath,
        })
        await crashedMeter.send('candidate', requestOf())
        await crashedMeter.send('post_turn_memory', requestOf())
        const crashedLedger = readAttemptLedger(crashedLedgerPath)
        check('单元"崩溃"后没有报告，但**请求尝试已落盘**（2 次 / 36 token）',
          crashedLedger.readable && crashedLedger.requestsAttempted === 2 && crashedLedger.tokensCharged === 36)
        check('账本成对（2 started / 2 finished，无在途残留）',
          crashedLedger.requestsFinished === 2 && crashedLedger.inFlightAttempts === 0)
        const confirmed = accountUnitOutcome({ ledger: crashedLedger, reportExists: false, error: 'fixture_crash' })
        check('失败单元 + 可确认账本 ⇒ 成本已确认、**不**强制停止（整体仍 INCOMPLETE）',
          confirmed.costConfirmed === true && confirmed.mustStop === false && confirmed.requestsAttempted === 2)
        // 账本缺失 ⇒ 无法确认是否已有请求发生 ⇒ 必须停止
        const missingLedger = readAttemptLedger(resolve(tmp, 'no-such-ledger.jsonl'))
        const unconfirmed = accountUnitOutcome({ ledger: missingLedger, reportExists: false, error: 'fixture_crash_before_ledger' })
        check('账本缺失 ⇒ 成本**无法确认**且必须停止序列',
          unconfirmed.costConfirmed === false && unconfirmed.mustStop === true && String(unconfirmed.reason).includes('账本'))
        // 账本里出现 usage 不完整 ⇒ 成本未确认 ⇒ 停止
        const incompleteLedgerPath = resolve(tmp, 'incomplete-ledger.jsonl')
        writeFileSync(incompleteLedgerPath, '', 'utf8')
        const incompleteMeter = createRequestMeter({
          allowance: { requests: 50, tokens: 10_000_000, deadlineAt: Date.now() + 60_000 }, maxCompletionTokens: 4096,
          transport: async () => ({ status: 200, text: JSON.stringify({ usage: { prompt_tokens: 10_000 } }) }),
          ledgerPath: incompleteLedgerPath,
        })
        await incompleteMeter.send('candidate', requestOf())
        const incomplete = accountUnitOutcome({ ledger: readAttemptLedger(incompleteLedgerPath), reportExists: false })
        check('账本含不完整 usage ⇒ 成本未确认且必须停止',
          incomplete.costConfirmed === false && incomplete.mustStop === true && String(incomplete.reason).includes('成本无法确认'))
        // 报告与账本不一致 ⇒ 成本未确认 ⇒ 停止（防止"报告少记"漏账）
        const mismatch = accountUnitOutcome({
          ledger: crashedLedger, reportExists: true,
          reportCost: { requestsAttempted: 1, tokensCharged: 18, tokensReported: 18, usageMissingCount: 0, costUnverifiable: false },
        })
        check('单元报告与账本不一致 ⇒ 成本未确认且必须停止', mismatch.costConfirmed === false && mismatch.mustStop === true &&
          String(mismatch.reason).includes('账本不一致'))
        // 正常成功单元（报告=账本）不停止
        const consistent = accountUnitOutcome({
          ledger: crashedLedger, reportExists: true,
          reportCost: { requestsAttempted: 2, tokensCharged: 36, tokensReported: 36, usageMissingCount: 0, costUnverifiable: false },
        })
        check('报告=账本 ⇒ 成本已确认、不停止（control）', consistent.costConfirmed === true && consistent.mustStop === false)
        declaredRequestUnits = 3
        break
      }
      case 'meter-client-abort-bounded-unverified': {
        // 政策 A（用户 2026-10-25 裁定）：客户端 abort 记"有界未确认成本"，事件数 ≤ K 时**继续**序列。
        const k = 2
        const ledgerPath = resolve(tmp, 'abort-ledger.jsonl')
        writeFileSync(ledgerPath, '', 'utf8')
        let calls = 0
        const abortError = () => { const e = new Error('This operation was aborted'); e.name = 'AbortError'; return e }
        const meter = createRequestMeter({
          allowance: { requests: 20, tokens: 10_000_000, deadlineAt: Date.now() + 60_000 },
          maxCompletionTokens: 4096,
          maxUnverifiedCostEvents: k,
          ledgerPath,
          transport: async () => {
            calls += 1
            // 前两次 abort（未收到响应），之后正常
            if (calls <= 2) throw abortError()
            return { status: 200, text: JSON.stringify({ usage: { total_tokens: 100 } }) }
          },
        })
        await expectGuard(() => meter.send('candidate', requestOf()), 'transport_failed')
        await expectGuard(() => meter.send('candidate', requestOf()), 'transport_failed')
        const afterTwo = meter.summary()
        check('两次客户端 abort 后**没有**判为"成本无法确认"（不算已确认，但不再阻断）',
          afterTwo.costUnverifiable === false && meter.costUnverifiable === false)
        check(`abort 事件被单列计数（2 ≤ K=${String(k)}）`, afterTwo.unverifiedCostEvents === 2 && meter.unverifiedFloorTokens === 8192)
        check('abort 也按**已知下限**扣账（每次 4096）', afterTwo.tokensCharged === 8192)
        const third = await meter.send('candidate', requestOf())
        check('≤K 时**继续**发请求（第三次真的发出并成功）', third.status === 200 && calls === 3)
        check('成功请求的成本仍记成已确认', meter.summary().costUnverifiable === false)
        // 超过 K ⇒ 拒绝后续请求
        const overMeter = createRequestMeter({
          allowance: { requests: 20, tokens: 10_000_000, deadlineAt: Date.now() + 60_000 },
          maxCompletionTokens: 4096, maxUnverifiedCostEvents: 1, ledgerPath: resolve(tmp, 'abort-over.jsonl'),
          transport: async () => { throw abortError() },
        })
        await expectGuard(() => overMeter.send('candidate', requestOf()), 'transport_failed')
        await expectGuard(() => overMeter.send('candidate', requestOf()), 'transport_failed') // 第 2 个 abort ⇒ 超过 K=1
        const limitReason = overMeter.budgetStopReason()
        await expectGuard(() => overMeter.send('candidate', requestOf()), 'unverified_cost_limit')
        check(`事件数 > K ⇒ 停止理由明确、后续请求被拒（code=unverified_cost_limit）`,
          String(limitReason).includes('未确认成本事件超过上限'))
        // 控制：**非** abort 的传输失败仍然立刻停（不许借政策 A 放行）
        const otherMeter = createRequestMeter({
          allowance: { requests: 20, tokens: 10_000_000, deadlineAt: Date.now() + 60_000 },
          maxCompletionTokens: 4096, ledgerPath: resolve(tmp, 'abort-other.jsonl'),
          transport: async () => { throw new Error('http_500') },
        })
        await expectGuard(() => otherMeter.send('candidate', requestOf()), 'transport_failed')
        check('非 abort 的传输失败**仍然**按"成本无法确认"立刻停止（政策 A 不放行这类）',
          otherMeter.costUnverifiable === true && String(otherMeter.budgetStopReason()).includes('成本无法确认'))
        // 控制：HTTP 200 但 usage 不完整仍然立刻停
        const partialMeter = createRequestMeter({
          allowance: { requests: 20, tokens: 10_000_000, deadlineAt: Date.now() + 60_000 },
          maxCompletionTokens: 4096, ledgerPath: resolve(tmp, 'abort-partial.jsonl'),
          transport: async () => ({ status: 200, text: JSON.stringify({ usage: { prompt_tokens: 10 } }) }),
        })
        await partialMeter.send('candidate', requestOf())
        check('HTTP 200 但 usage 不完整**仍然**立刻停止（提供方报告异常不放行）',
          partialMeter.costUnverifiable === true)
        // 账本口径：abort 计入 unverifiedCostEventCount，不算 costUnverifiable
        const summary = readAttemptLedger(ledgerPath)
        check('账本把 abort 单列（unverifiedCostEventCount ≥ 1）且不因此判成本无法确认',
          summary.unverifiedCostEventCount >= 1 && summary.unverifiedFloorTokens >= 4096)
        const accountingOk = accountUnitOutcome({ ledger: summary, reportExists: false, maxUnverifiedCostEvents: 8 })
        check('对账：abort 事件在 K 内 ⇒ 成本可入账（costStatus=confirmed_with_unverified_events）、不停止',
          accountingOk.costConfirmed === true && accountingOk.costStatus === 'confirmed_with_unverified_events' && accountingOk.mustStop === false)
        const accountingOver = accountUnitOutcome({ ledger: summary, reportExists: false, maxUnverifiedCostEvents: 0 })
        check('对账：事件数 > K ⇒ 必须停止序列',
          accountingOver.costConfirmed === false && accountingOver.mustStop === true &&
          String(accountingOver.reason).includes('未确认成本事件超过上限'))
        break
      }
      case 'task-journal-recovers-completed-tasks': {
        /*
         * 任务账本（第二本账）验证：
         *  ① 完好账本 ⇒ 已完成的题可整条读回；
         *  ② **在途崩溃**（写到一半被杀）⇒ 已完成题仍取回、在途题被标出；
         *  ③ 账本被写坏/截断 ⇒ 显式 `readable=false`（**不**把"读不出来"变成"没有题"）；
         *  ④ 与请求账本一起对账 ⇒ 在途崩溃必须停止序列。
         * 说明：②用"在 kill 点截断账本"**等价模拟**真实 SIGKILL（真实 SIGKILL 已在
         *       round-1 真实发生并被在途守卫捕获；当时的读数丢失正是本账要补的缺口）。
         */
        const journalPath = resolve(tmp, 'tasks-w01-A.jsonl')
        writeFileSync(journalPath, '', 'utf8')
        const unit = 'w01:A'
        for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
          appendTaskJournalEntry(journalPath, { phase: 'task_started', unit, worldId: 'w01', arm: 'A',
            taskId: `w01-t0${String(ordinal)}`, ordinal, at: Date.now() })
          appendTaskJournalEntry(journalPath, { phase: 'task_finished', unit, worldId: 'w01', arm: 'A',
            taskId: `w01-t0${String(ordinal)}`, ordinal, at: Date.now(),
            row: { taskId: `w01-t0${String(ordinal)}`, goalAchieved: ordinal !== 1, stopped: ordinal === 1 ? 'budget_plans' : 'done' } })
        }
        const complete = readTaskJournal(journalPath)
        check('完好任务账本：3 题全部可整条读回',
          complete.readable && complete.finished === 3 && complete.rows.length === 3 && complete.inFlightTaskIds.length === 0)
        check('读回的题行保留原始字段（不是空壳）',
          complete.rows.every(item => (item.row as Record<string, unknown>).taskId === item.taskId))
        // ② 在 kill 点截断：第 4 题只落了 task_started
        appendTaskJournalEntry(journalPath, { phase: 'task_started', unit, worldId: 'w01', arm: 'A',
          taskId: 'w01-t04', ordinal: 4, at: Date.now() })
        const crashed = readTaskJournal(journalPath)
        check('在途崩溃：已完成题仍取回（3 条），在途题被标出（w01-t04）',
          crashed.readable && crashed.finished === 3 &&
          crashed.inFlightTaskIds.length === 1 && crashed.inFlightTaskIds[0] === 'w01-t04')
        check('在途崩溃：完成数 < 开始数（差 1，正是被杀那一题）', crashed.started === 4 && crashed.finished === 3)
        // ③ 账本被写坏 ⇒ 不可读（不假装没有题）
        const brokenPath = resolve(tmp, 'tasks-broken.jsonl')
        writeFileSync(brokenPath, '{"phase":"task_finished","unit":"w01:A"}\n{"phase":\n', 'utf8')
        const broken = readTaskJournal(brokenPath)
        check('账本写坏 ⇒ 显式 readable=false（不把读不出来当没有）', broken.readable === false)
        const missing = readTaskJournal(resolve(tmp, 'no-such-tasks.jsonl'))
        check('账本不存在 ⇒ readable=false', missing.readable === false)
        // ④ 与请求账本一起对账
        const ledgerPath = resolve(tmp, 'crash-ledger-2.jsonl')
        writeFileSync(ledgerPath, '', 'utf8')
        appendLedgerEntry(ledgerPath, { phase: 'attempt_started', sequence: 1, purpose: 'candidate', attempt: 1,
          taskId: 'w01-t04', ordinal: 4, startedAt: Date.now(), effectiveMaxTokens: 4096 })
        const accounting = accountUnitOutcome({ ledger: readAttemptLedger(ledgerPath), reportExists: false, error: 'SIGKILL' })
        check('在途崩溃 + 任务账本仍有 3 题 ⇒ 对账必须停止序列且成本无法确认',
          accounting.costConfirmed === false && accounting.mustStop === true &&
          String(accounting.reason).includes('在途崩溃'))
        check('取回的 3 题在被杀那一刻**已经在账本里**（不依赖崩溃后的补算）',
          crashed.rows.filter(item => item.ordinal <= 3).length === 3)
        declaredRequestUnits = 3
        break
      }
      case 'unit-timeout-derived-from-budget': {
        // 真实教训：单元子进程沿用 harness 默认 120 s ⇒ 真实模型调用还在途时被杀 ⇒ 在途崩溃。
        const harnessDefault = 120_000
        const derived = deriveUnitTimeoutMs({ tasksPerUnit: 8, perTaskDeadlineMs: F1_TASK_BUDGET.deadlineMs })
        check(`单元子进程超时**由封存预算推导**（8 题 × 单题时限 + 余量）：derived=${String(derived)}`,
          derived === 8 * F1_TASK_BUDGET.deadlineMs + 120_000)
        check('推导出的超时**远大于** harness 默认 120 s（首跑就是在这里被杀）', derived > harnessDefault * 10)
        check(`单题时限能容下最坏的 6 次模型调用（评测侧规划器 90 s）：deadlineMs=${String(F1_TASK_BUDGET.deadlineMs)}`,
          F1_TASK_BUDGET.deadlineMs >= F1_TASK_BUDGET.maxModelRequests * 90_000)
        check('剩余时间不足一个完整单元 ⇒ **不启动**该单元（记 budgetStop，而不是启动后被杀）',
          canStartUnitWithin(derived, derived) === true && canStartUnitWithin(derived - 1, derived) === false)
        check('剩余时间充足时可以启动', canStartUnitWithin(derived * 2, derived) === true)
        // attempt-2 真实教训：45 s 产品默认超时会在个别请求上 abort（无 usage ⇒ 成本未确认 ⇒ 停止序列）
        check('评测侧规划器超时 90 s **大于**产生 abort 的 45 s 边界（产品默认值不变）',
          F1_PLANNER_TIMEOUT_MS === 90_000 && F1_PLANNER_TIMEOUT_MS > 45_000)
        check('单请求硬上限 ≥ 规划器超时（memory/反思也受同一硬上限保护）',
          F1_REQUEST_HARD_TIMEOUT_MS >= F1_PLANNER_TIMEOUT_MS)
        break
      }
      case 'meter-journals-in-flight-before-request': {
        // 「请求在途崩溃」的账本缺口：痕迹必须在**请求发出前**落盘。
        const ledgerPath = resolve(tmp, 'in-flight-ledger.jsonl')
        writeFileSync(ledgerPath, '', 'utf8')
        let seenDuringFlight = ''
        let seenPhasesDuringFlight: string[] = []
        const meter = createRequestMeter({
          allowance: { requests: 10, tokens: 1_000_000, deadlineAt: Date.now() + 60_000 }, maxCompletionTokens: 4096,
          transport: async () => {
            // ⚠️ 请求**还在途**时读账本：必须已经能看到 attempt_started
            seenDuringFlight = readFileSync(ledgerPath, 'utf8')
            seenPhasesDuringFlight = seenDuringFlight.split(/\r?\n/).filter(line => line.trim() !== '')
              .map(line => (JSON.parse(line) as { phase: string }).phase)
            return { status: 200, text: JSON.stringify({ usage: { total_tokens: 12 } }) }
          },
          ledgerPath,
        })
        await meter.send('candidate', requestOf())
        check('请求在途时账本已落 attempt_started（发出前留痕）',
          seenPhasesDuringFlight.includes('attempt_started'))
        check('请求在途时**还没有** attempt_finished（确实还在途）',
          !seenPhasesDuringFlight.includes('attempt_finished'))
        const summary = readAttemptLedger(ledgerPath)
        check('请求返回后账本成对（1 started / 1 finished / 0 在途）',
          summary.requestsAttempted === 1 && summary.requestsFinished === 1 && summary.inFlightAttempts === 0)
        check('成本已确认（tokensCharged=12，usage 完整）',
          summary.costUnverifiable === false && summary.tokensCharged === 12)
        // 模拟"进程死在请求返回前"：只留下 attempt_started
        const inFlightPath = resolve(tmp, 'in-flight-crash.jsonl')
        appendLedgerEntry(inFlightPath, {
          phase: 'attempt_started', sequence: 1, purpose: 'candidate', attempt: 1,
          taskId: 'w01-t01', ordinal: 1, startedAt: Date.now(), effectiveMaxTokens: 4096,
        })
        const inFlight = readAttemptLedger(inFlightPath)
        check('只有 started 没有 finished ⇒ 判为**在途崩溃**（inFlightAttempts=1）',
          inFlight.inFlightAttempts === 1 && inFlight.costUnverifiable === true)
        check('在途崩溃时尝试数仍被计入（1 次，不少报）', inFlight.requestsAttempted === 1)
        const inFlightAccounting = accountUnitOutcome({ ledger: inFlight, reportExists: false, error: 'fixture_in_flight_crash' })
        check('在途崩溃 ⇒ 成本无法确认且**必须停止整个序列**',
          inFlightAccounting.costConfirmed === false && inFlightAccounting.mustStop === true &&
          String(inFlightAccounting.reason).includes('在途'))
        // 成对的 started+finished ⇒ 不是在途崩溃
        const pairedPath = resolve(tmp, 'paired.jsonl')
        writeFileSync(pairedPath, '', 'utf8')
        const pairedMeter = createRequestMeter({
          allowance: { requests: 10, tokens: 1_000_000, deadlineAt: Date.now() + 60_000 }, maxCompletionTokens: 4096,
          transport: async () => ({ status: 200, text: JSON.stringify({ usage: { total_tokens: 12 } }) }),
          ledgerPath: pairedPath,
        })
        await pairedMeter.send('candidate', requestOf())
        const paired = readAttemptLedger(pairedPath)
        check('成对记账 ⇒ 不算在途崩溃（不误停）',
          paired.inFlightAttempts === 0 && paired.costUnverifiable === false &&
          accountUnitOutcome({ ledger: paired, reportExists: true,
            reportCost: { requestsAttempted: 1, tokensCharged: 12, tokensReported: 12, usageMissingCount: 0, costUnverifiable: false } }).mustStop === false)
        // 被拒绝的请求也要留痕，但**不算尝试、不算成本**
        const refusedPath = resolve(tmp, 'refused.jsonl')
        writeFileSync(refusedPath, '', 'utf8')
        const refusedMeter = createRequestMeter({
          allowance: { requests: 0, tokens: 1_000_000, deadlineAt: Date.now() + 60_000 }, maxCompletionTokens: 4096,
          transport: async () => ({ status: 200, text: '{}' }),
          ledgerPath: refusedPath,
        })
        await expectGuard(() => refusedMeter.send('candidate', requestOf()), 'budget_refused')
        const refused = readAttemptLedger(refusedPath)
        check('被拒请求写 attempt_refused，且**不计尝试、不计成本**',
          refused.requestsRefused === 1 && refused.requestsAttempted === 0 && refused.tokensCharged === 0)
        declaredRequestUnits = 3
        break
      }
      default:
        throw new Error(`unknown_case:${caseId}`)
    }
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(resolve(OUT_DIR, `case-${caseId}.json`), `${JSON.stringify({
      schema: 'f1-g8-case@1', case: caseId, status: 'PASS', checks: list,
      ...(declaredRequestUnits === 0 ? {} : { declaredRequestUnits }),
    }, null, 2)}\n`, 'utf8')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 父进程：逐场景执行 + 聚合
// ---------------------------------------------------------------------------
if (process.argv.includes('--list-cases')) {
  // 场景清单的**唯一事实源在门里**（逐场景执行器会来问）
  for (const id of CASES) console.log(`${id}\t0`)
  process.exit(0)
}
if (process.argv.includes('--case')) {
  const caseId = arg('--case')!
  assert.ok((CASES as readonly string[]).includes(caseId), `unknown_case:${caseId}`)
  await runCase(caseId)
  process.exit(0)
}

assert.ok(process.env.LG_SIM_PGTEST_ADMIN_URL, 'serversim_pgtest_required')
mkdirSync(OUT_DIR, { recursive: true })
// 清掉上一轮的 case 报告（避免旧读数冒充本轮）——只清本门自己的目录
for (const name of readdirSync(OUT_DIR)) {
  if (name.startsWith('case-') && name.endsWith('.json')) rmSync(resolve(OUT_DIR, name))
}
const outcomes = await runPgScenarioGate({
  label: 'f1-runner-guards',
  script: 'scripts/cognitive/f1-runner-guards-verify.ts',
  scenarios: CASES.map(id => ({ id, argv: ['--case', id] })),
})
for (const outcome of outcomes) assert.equal(outcome.ok, true, `${outcome.id}: ${outcome.tail}`)
const aggregate: string[] = []
const cases: Array<{ case: string, checks: number, labels: string[] }> = []
let declaredRequestUnits = 0
for (const caseId of CASES) {
  const report = readJson(resolve(OUT_DIR, `case-${caseId}.json`)) as { case: string, status: string, checks: string[], declaredRequestUnits?: number }
  assert.equal(report.case, caseId)
  assert.equal(report.status, 'PASS')
  assert.ok(report.checks.length > 0, `${caseId}: 没有断言`)
  cases.push({ case: caseId, checks: report.checks.length, labels: report.checks })
  for (const label of report.checks) aggregate.push(`${caseId}: ${label}`)
  declaredRequestUnits += report.declaredRequestUnits ?? 0
}
const output = resolve(OUT_DIR, 'verification.json')
writeFileSync(output, `${JSON.stringify({
  schema: 'f1-g8-verification@1',
  status: 'PASS',
  kind: 'runner_guards_offline_zero_physical_model_requests',
  checks: aggregate,
  cases,
  physicalModelRequests: 0,
  declaredRequestUnits,
  guardCodes: F1_GUARD_CODES,
  limits: [
    '离线确定性 transport：声明的请求单位不是真实模型调用或费用',
    '未发出真实请求；真实提供方下的预算/usage 行为要等授权运行',
    '本门不替代 G1/G3–G7 的装配与破坏性控制读数',
  ],
}, null, 2)}\n`, 'utf8')
console.log(`G8 运行器守卫门：${aggregate.length} 项检查全部通过（零物理模型请求）; ${output}`)
console.log(`cases=${String(cases.length)} checks=${String(aggregate.length)} declaredRequestUnits=${String(declaredRequestUnits)}`)
