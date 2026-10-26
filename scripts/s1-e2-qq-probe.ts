/**
 * S1 / E-2·QQ 类 侦察探针（**不是门**，用完即删）。
 *
 * 目的：把"越权 QQ 发送"这一类的**真实语义**打印出来，再据此写断言。
 * 用**真能力声明**（`createQqProactiveCapabilityDefinitions`）+ **真适配器**
 * （`createQqProactiveDeliveryAdapter`，注入一个只计数的假投递口）。
 *
 * ⚠️ 隔离库 + 一次性沙箱；零模型 / 零出网 / **没有任何真实 QQ 出站**（sink 是本地假件）。
 */

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

// 后端闸
{
  const { config: loadDotenv } = await import('dotenv')
  const { existsSync: ex } = await import('node:fs')
  const { dirname: dn, join: jn } = await import('node:path')
  let envDir = process.cwd()
  while (!ex(jn(envDir, '.env')) && dn(envDir) !== envDir) envDir = dn(envDir)
  loadDotenv({ path: jn(envDir, '.env'), quiet: true })
  const { databaseBackendEnvironmentFrom, resolveDatabaseBackend } = await import(
    '../src/infrastructure/persistence/database-backend.ts'
  )
  if (resolveDatabaseBackend(databaseBackendEnvironmentFrom()).backend === 'postgres') {
    console.log('  [NOT RUN] s1-e2-qq-probe（directory_sandbox_requires_pglite_backend）')
    process.exit(2)
  }
}

const runId = `s1-e2-qq-probe-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
const sandbox = isolateDatabase('s1-e2-qq-probe', { runId, keep: true })
console.log(`  [sandbox] ${sandbox.dir}`)

const { createActionTestBed } = await import('./action-harness.ts')
const { createQqProactiveCapabilityDefinitions, QQ_PRIVATE_SEND_PERMISSION } = await import(
  '../src/kernel/action/qq-proactive-capability.ts'
)
const { createQqProactiveDeliveryAdapter } = await import(
  '../src/infrastructure/action/adapters/qq-proactive-delivery.ts'
)

const sink: { calls: { text: string; deliveryId: string }[] } = { calls: [] }
const delivery = {
  deliver(input: { deliveryId: string; text: string }) {
    sink.calls.push({ text: input.text, deliveryId: input.deliveryId })
    return { written: true }
  },
}
const adapter = createQqProactiveDeliveryAdapter({
  delivery,
  resolveDeliveryId: (input) => (input as { idempotencyKey?: string }).idempotencyKey,
})

const TARGET = { type: 'qq_private_owner', canonicalId: 'owner-fixture', displayName: '本人', confidence: 'exact' as const }

/**
 * 这一支 resolver 就是生产方式的那一支：由**装配层按绑定常量**给出 `qq_private_owner` / `exact`。
 * （harness 的缺省 resolver 是沙箱梯子，会把声明目标改写成 sandbox_file ⇒ 适配器判 `qq_send_target_not_owner`。）
 */
const qqResolveTarget = async (): Promise<{
  target: typeof TARGET
  scopeViolation: boolean
}> => ({ target: TARGET, scopeViolation: false })

function summarize(result: unknown): Record<string, unknown> {
  const r = result as { actionId?: unknown; accepted?: unknown; executed?: unknown; status?: unknown; error?: unknown }
  return { accepted: r.accepted, executed: r.executed, status: r.status, error: r.error }
}

async function scenario(
  label: string,
  options: { granted: boolean; dryRun?: boolean },
  input: { args: Record<string, unknown>; target?: unknown; idempotencyKey?: string }
): Promise<void> {
  const bed = await createActionTestBed({
    label: `probe-${label}`,
    extraCapabilities: createQqProactiveCapabilityDefinitions(),
    extraAdapters: [adapter],
    grantedPermissions: options.granted ? [QQ_PRIVATE_SEND_PERMISSION] : ['system:echo'],
    maxRiskLevel: 'R3',
    resolveTarget: qqResolveTarget,
    ...(options.dryRun === true ? { dryRun: true } : {}),
  })
  const before = sink.calls.length
  const result = await bed.execute({
    capability: 'qq.private.message',
    operation: 'send',
    args: input.args,
    ...(input.target === undefined ? {} : { target: input.target as never }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  })
  console.log(`\n--- ${label} ---`)
  console.log(JSON.stringify({ ...summarize(result), sinkDelta: sink.calls.length - before, sinkTotal: sink.calls.length }, null, 2))
  await bed.stop()
}

// A 未授予权限
await scenario('A 未授予权限', { granted: false }, { args: { text: '越权尝试' }, target: TARGET, idempotencyKey: 'k-a' })
// B 授予 + exact 目标 + 幂等键
await scenario('B 授予（正常）', { granted: true }, { args: { text: '正常一条' }, target: TARGET, idempotencyKey: 'k-b' })
// C 授予但缺幂等键
await scenario('C 缺幂等键', { granted: true }, { args: { text: '没有键' }, target: TARGET })
// D 授予但参数里塞收件人
await scenario('D 参数塞收件人', { granted: true }, { args: { text: '塞收件人', user_id: '12345' }, target: TARGET, idempotencyKey: 'k-d' })
// E 授予但目标置信度不是 exact
await scenario('E 目标 confidence=strong', { granted: true }, {
  args: { text: '目标不确定' },
  target: { ...TARGET, confidence: 'strong' },
  idempotencyKey: 'k-e',
})
// F 授予但完全没给目标
await scenario('F 不给目标', { granted: true }, { args: { text: '没目标' }, idempotencyKey: 'k-f' })
// G 干跑
await scenario('G 干跑', { granted: true, dryRun: true }, { args: { text: '干跑' }, target: TARGET, idempotencyKey: 'k-g' })
// H 同一幂等键重复（第二次）
await scenario('H 同一键第二次', { granted: true }, { args: { text: '正常一条' }, target: TARGET, idempotencyKey: 'k-b' })

console.log('\n=== qq probe done ===')
cleanupSandbox(sandbox.dir)
await resetPluginSqlConnection()
