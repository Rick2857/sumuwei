/**
 * S1 · 隔离桩门（`s1:isolation-stub:verify`）—— E-2 第一切片
 *
 * 归属：多用户补充计划 S1（ADR-134 §5 `E-2`；契约 `R-S0-3`：**隔离危险目标、保留真实权限执行链**）。
 *
 * 做法：请求走**真实**能力登记表 → Policy → Gateway → 适配器 → 账本；执行目标换成**一次性 %TEMP% 沙箱**。
 * 零模型 / 零出网。**隔离必须在任何会碰数据库的 import 之前**（先例：`scripts/postlv2-*.ts`）。
 *
 * ⚠️ 三条**由探针校准过**的读法（见 `docs/post-lv2/Multi-User-S1-E2-Isolation-Recon-2026-10-14.md`）：
 *   ① **策略结论**在 `result.error.details.decision`（`missing_permission` / `dry_run_no_side_effect` /
 *      `risk_exceeds_limit` / `target_uncertain`…）；`result.error.code` 是**映射后的**失败码（常是 `permission_denied`）
 *      ⇒ 门断言 `decision`，**不**猜 `code`。
 *   ② `createActionTestBed()` **自己不隔离库**（它直接 `initDatabase`）⇒ 必须先 `isolateDatabase()`，
 *      否则跨 bed / 跨 run 共用一个库：**幂等键重放**与账本串台会让读数看起来"自相矛盾"。
 *   ③ 副作用能力**可以**不传 target；风险闸对 `maxRiskLevel` 生效（R2 在 R1 下拒、R3 下执行）。
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { cleanupSandbox, isolateDatabase, isProductionDir, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// 后端闸 + 隔离（都必须在动态 import 业务模块之前）
// ---------------------------------------------------------------------------
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
    console.log('')
    console.log('  [NOT RUN] s1:isolation-stub:verify（具名原因：directory_sandbox_requires_pglite_backend）')
    console.log('     本门用目录沙箱（PGlite）；.env 的 CHARACTER_DB_BACKEND=postgres 会让 initDatabase 重读 .env。')
    console.log('     跑法：在没有 .env 的 cwd 下驱动本脚本，并设 CHARACTER_DB_BACKEND=pglite（+ POSTGRES_URL= / DATABASE_URL=）。')
    console.log('     这不是"通过"：本门的读数为未取得。')
    process.exit(2)
  }
}

const runId = `s1-isolation-stub-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
const sandbox = isolateDatabase('s1-isolation-stub', { runId, keep: true })
console.log(`  [sandbox] ${sandbox.dir}`)

const { createActionTestBed } = await import('./action-harness.ts')
const { sql } = await import('drizzle-orm')
const { rowsOf } = await import('../src/infrastructure/persistence/db.ts')
const { createQqProactiveCapabilityDefinitions, QQ_PRIVATE_SEND_PERMISSION } = await import(
  '../src/kernel/action/qq-proactive-capability.ts'
)
const { createQqProactiveDeliveryAdapter } = await import(
  '../src/infrastructure/action/adapters/qq-proactive-delivery.ts'
)
type CapabilityDefinition = import('../src/kernel/action/capability-registry.ts').CapabilityDefinition
type CapabilityAdapter = import('../src/kernel/action/executor-port.ts').CapabilityAdapter
type GatewayResolveTarget = import('../src/kernel/action/gateway.ts').ActionGatewayOptions['resolveTarget']

interface Check {
  readonly id: string
  readonly label: string
  readonly pass: boolean
  readonly detail: string
}
const checks: Check[] = []
const record = (id: string, label: string, pass: boolean, detail: string): void => {
  checks.push({ id, label, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

interface ResultShape {
  actionId?: unknown
  accepted?: unknown
  executed?: unknown
  status?: unknown
  error?: { code?: unknown; details?: { decision?: unknown } }
}

/** **校准过的**读法：策略结论在 `error.details.decision` */
function decisionOf(result: ResultShape): string {
  const d = result.error?.details?.decision
  return typeof d === 'string' && d !== '' ? d : '(无 decision)'
}

function isRejected(result: ResultShape): boolean {
  return result.accepted === false && result.executed === false && result.status === 'rejected'
}

const SANDBOX_FILE_WRITE = 'sandbox.file.write'
const R2_DANGEROUS = 's1.isolation.dangerous.write'
const R2_PERMISSION = 's1:isolation:dangerous'
const r2Runs = { count: 0 }

function r2Capability(): CapabilityDefinition {
  return {
    id: R2_DANGEROUS,
    version: 's1.isolation.dangerous.write@1',
    description: '隔离桩用的 R2 写能力（不是生产能力；只为证明风险闸是活的）',
    operations: [{ name: 'write', description: '计数并返回', sideEffect: 'write', riskLevel: 'R2' }],
    sideEffectLevel: 'write',
    riskLevel: 'R2',
    permissions: [R2_PERMISSION], // 登记表拒绝空 permissions
    supportsDryRun: true,
    idempotency: 'none',
  }
}

const countingR2Adapter: CapabilityAdapter = {
  capabilityId: R2_DANGEROUS,
  async execute() {
    r2Runs.count += 1
    return {}
  },
}

// ===========================================================================
// T0 隔离面自检（隔离是真的 · 库是全新的）
// ===========================================================================
const grantedBed = await createActionTestBed({
  label: 's1-isolation-stub-granted',
  grantedPermissions: ['system:echo', 'sandbox:read', 'sandbox:write'],
})
record('T0.1', '沙箱根在 %TEMP% 下', grantedBed.sandboxRoot.startsWith(tmpdir()), `root=${grantedBed.sandboxRoot}`)
record('T0.2', '沙箱不是生产库目录', isProductionDir(sandbox.dir) === false, `dir=${sandbox.dir}`)
{
  const all = await grantedBed.records({})
  record('T0.3', '库是全新的（账本里没有任何动作记录）', all.length === 0, `records=${all.length}`)
  record('T0.4', '起始态沙箱为空', (await grantedBed.sandboxFiles()).length === 0, 'files=0')
}

// ===========================================================================
// T1 未授予写权限 ⇒ 拒绝 + 无文件 + 账本无成功行（负控①）
// ===========================================================================
{
  const deniedBed = await createActionTestBed({
    label: 's1-isolation-stub-denied',
    grantedPermissions: ['system:echo', 'sandbox:read'], // 没有 sandbox:write
  })
  const result = (await deniedBed.execute({
    capability: SANDBOX_FILE_WRITE,
    operation: 'write',
    args: { path: 'denied.txt', content: '不该出现\n' },
    target: { type: 'sandbox_file', canonicalId: 'denied.txt', confidence: 'exact' },
  })) as ResultShape
  record(
    'T1.1',
    '未授予写权限 ⇒ 拒绝，策略结论是 missing_permission',
    isRejected(result) && decisionOf(result) === 'missing_permission',
    `decision=${decisionOf(result)} · code=${String(result.error?.code)}`
  )
  record(
    'T1.2',
    '目标文件没有被写出来',
    !(await deniedBed.sandboxFiles()).some((f) => f.relativePath === 'denied.txt'),
    'denied.txt 不在清单里'
  )
  {
    const rows = rowsOf(
      await deniedBed.db.execute(
        sql`select count(*)::int as c from character_action_events where action_id = ${String(result.actionId)} and status in ('success','executed','verified')`
      )
    )
    record('T1.3', '账本里该动作没有成功行', Number(rows[0]?.c ?? -1) === 0, `rows=${String(rows[0]?.c)}`)
  }
  record('T1.4', '沙箱仍然为空', (await deniedBed.sandboxFiles()).length === 0, 'files=0')
  await deniedBed.stop()
}

// ===========================================================================
// T2 授予后真的写出来（负控②：量具是活的）
// ===========================================================================
{
  const result = (await grantedBed.execute({
    capability: SANDBOX_FILE_WRITE,
    operation: 'write',
    args: { path: 'allowed.txt', content: '允许的内容\n' },
    target: { type: 'sandbox_file', canonicalId: 'allowed.txt', confidence: 'exact' },
  })) as ResultShape
  record(
    'T2.1',
    '授予后执行成功（accepted · executed · success）',
    result.accepted === true && result.executed === true && result.status === 'success',
    `status=${String(result.status)} · executed=${String(result.executed)}`
  )
  record(
    'T2.2',
    '文件内容可读回',
    grantedBed.sandboxFile('allowed.txt') === '允许的内容\n',
    `content=${JSON.stringify(grantedBed.sandboxFile('allowed.txt'))}`
  )
}

// ===========================================================================
// T3 路径逃逸 ⇒ 拒绝，且逃逸目标不存在
// ===========================================================================
{
  const escapeName = `s1-escape-${Date.now()}.txt`
  const escapeAbsolute = join(dirname(grantedBed.sandboxRoot), escapeName)
  const result = (await grantedBed.execute({
    capability: SANDBOX_FILE_WRITE,
    operation: 'write',
    args: { path: `../${escapeName}`, content: '逃逸\n' },
    target: { type: 'sandbox_file', canonicalId: `../${escapeName}`, confidence: 'exact' },
  })) as ResultShape
  record(
    'T3.1',
    '路径逃逸被拒（具名策略结论）',
    isRejected(result) && decisionOf(result) !== '(无 decision)',
    `decision=${decisionOf(result)}`
  )
  record('T3.2', '沙箱外没有出现逃逸文件', !existsSync(escapeAbsolute), `checked=${escapeName}`)
}

// ===========================================================================
// T4 风险闸：R2 在 R1 下拒、在 R3 下真的执行（负控③）
// ===========================================================================
{
  const tight = await createActionTestBed({
    label: 's1-isolation-stub-r2-tight',
    extraCapabilities: [r2Capability()],
    extraAdapters: [countingR2Adapter],
    grantedPermissions: [R2_PERMISSION],
    maxRiskLevel: 'R1',
  })
  const denied = (await tight.execute({
    capability: R2_DANGEROUS,
    operation: 'write',
    args: {},
    target: { type: 'sandbox_file', canonicalId: 'r2.txt', confidence: 'exact' },
  })) as ResultShape
  record(
    'T4.1',
    'R2 能力在 maxRiskLevel=R1 下被拒（risk_exceeds_limit），适配器一次都没跑',
    isRejected(denied) && decisionOf(denied) === 'risk_exceeds_limit' && r2Runs.count === 0,
    `decision=${decisionOf(denied)} · runs=${r2Runs.count}`
  )
  await tight.stop()

  const loose = await createActionTestBed({
    label: 's1-isolation-stub-r2-loose',
    extraCapabilities: [r2Capability()],
    extraAdapters: [countingR2Adapter],
    grantedPermissions: [R2_PERMISSION],
    maxRiskLevel: 'R3',
  })
  const allowed = (await loose.execute({
    capability: R2_DANGEROUS,
    operation: 'write',
    args: {},
    target: { type: 'sandbox_file', canonicalId: 'r2.txt', confidence: 'exact' },
  })) as ResultShape
  record(
    'T4.2',
    '同一能力在 maxRiskLevel=R3 下真的执行（runs=1）⇒ R1 下的拒绝是风险闸做的',
    allowed.accepted === true && allowed.executed === true && r2Runs.count === 1,
    `runs=${r2Runs.count} · status=${String(allowed.status)}`
  )
  await loose.stop()
}

// ===========================================================================
// T5 干跑 ⇒ 无副作用（dry_run_no_side_effect）
// ===========================================================================
{
  const dryBed = await createActionTestBed({
    label: 's1-isolation-stub-dryrun',
    grantedPermissions: ['sandbox:write'],
    dryRun: true,
  })
  const result = (await dryBed.execute({
    capability: SANDBOX_FILE_WRITE,
    operation: 'write',
    args: { path: 'dryrun.txt', content: '不该出现\n' },
    target: { type: 'sandbox_file', canonicalId: 'dryrun.txt', confidence: 'exact' },
  })) as ResultShape
  record(
    'T5.1',
    '干跑下副作用被禁（dry_run_no_side_effect）',
    isRejected(result) && decisionOf(result) === 'dry_run_no_side_effect',
    `decision=${decisionOf(result)}`
  )
  record(
    'T5.2',
    '干跑下文件不存在',
    !(await dryBed.sandboxFiles()).some((f) => f.relativePath === 'dryrun.txt'),
    'dryrun.txt 不在清单里'
  )
  await dryBed.stop()
}

// ===========================================================================
// T6 恢复：再次写入成功
// ===========================================================================
{
  const result = (await grantedBed.execute({
    capability: SANDBOX_FILE_WRITE,
    operation: 'write',
    args: { path: 'restored.txt', content: '恢复\n' },
    target: { type: 'sandbox_file', canonicalId: 'restored.txt', confidence: 'exact' },
  })) as ResultShape
  record(
    'T6.1',
    '恢复后再次写出成功',
    result.accepted === true && result.executed === true && grantedBed.sandboxFile('restored.txt') === '恢复\n',
    `content=${JSON.stringify(grantedBed.sandboxFile('restored.txt'))}`
  )
}
await grantedBed.stop()

// ===========================================================================
// T7 **出站轴**（E-2 的第二个切片：本地出站接收器 + 假凭证夹具）
//
// R-S0-3 要求"判据分别检查 …是否写入或**出站**"。这一段补上"出站"：
//   · 一个**本地**接收器（127.0.0.1 + 临时端口），只**计数**收到的请求，不回任何敏感内容
//   · 一个只在隔离桩里登记的能力：把一段**固定的假凭证串**POST 给接收器
//   · 负控：没授予权限 ⇒ 接收器收到 **0** 次；授予后 ⇒ 收到 **≥1** 次（证明接收器能观测出站）
//   · 干跑 ⇒ 出站被禁（接收器计数不变）
// ⚠️ 它只证明"出站可被观测/可被拒"；**不**证明凭证文件本身不可读（那条由文件类的目标检查承担）。
// ===========================================================================
const EGRESS_PROBE = 's1.isolation.egress.probe'
const EGRESS_PERMISSION = 's1:isolation:egress'
const egressRuns = { count: 0 }
const egressHits = { count: 0 }

const receiver = createServer((_req, res) => {
  egressHits.count += 1
  res.writeHead(204).end()
})
const receiverPort = await new Promise<number>((done) => {
  receiver.listen(0, '127.0.0.1', () => {
    const address = receiver.address()
    done(typeof address === 'object' && address !== null ? address.port : 0)
  })
})
const receiverUrl = `http://127.0.0.1:${receiverPort}/sink`

function egressCapability(): CapabilityDefinition {
  return {
    id: EGRESS_PROBE,
    version: 's1.isolation.egress.probe@1',
    description: '隔离桩用的出站能力（把固定假凭证串 POST 给本地接收器；不是生产能力）',
    operations: [{ name: 'send', description: '向本地接收器 POST 一段固定假凭证串', sideEffect: 'write', riskLevel: 'R2' }],
    sideEffectLevel: 'write',
    riskLevel: 'R2',
    permissions: [EGRESS_PERMISSION],
    supportsDryRun: true,
    idempotency: 'none',
  }
}

const egressAdapter: CapabilityAdapter = {
  capabilityId: EGRESS_PROBE,
  async execute() {
    egressRuns.count += 1
    // 固定假凭证串（**不**读任何真实文件）
    await fetch(receiverUrl, { method: 'POST', body: 'FAKE-CREDENTIAL-FOR-ISOLATION-TEST' })
    return {}
  },
}

/** 假凭证文件：放在沙箱**之外**的一次性目录里（证明它不在被测沙箱内） */
const credentialsDir = mkdtempSync(join(tmpdir(), 's1-isolation-credentials-'))
const fakeCredentialPath = join(credentialsDir, 'fake-credentials.txt')
writeFileSync(fakeCredentialPath, 'FAKE-USER\nFAKE-SECRET\n', 'utf8')

record(
  'T7.0',
  '假凭证夹具在沙箱**之外**存在（是隔离目标，不是被测沙箱内容）',
  existsSync(fakeCredentialPath) && !fakeCredentialPath.startsWith(grantedBed.sandboxRoot),
  `credential=${fakeCredentialPath}`
)

{
  // 7a：没授予出站权限 ⇒ 接收器**一次都没收到**
  const noPermBed = await createActionTestBed({
    label: 's1-isolation-stub-egress-denied',
    extraCapabilities: [egressCapability()],
    extraAdapters: [egressAdapter],
    grantedPermissions: ['system:echo'], // 没有 s1:isolation:egress
    maxRiskLevel: 'R3',
  })
  const before = egressHits.count
  const denied = (await noPermBed.execute({
    capability: EGRESS_PROBE,
    operation: 'send',
    args: {},
    target: { type: 'sandbox_file', canonicalId: 'sink', confidence: 'exact' },
  })) as ResultShape
  record(
    'T7.1',
    '未授予出站权限 ⇒ 拒绝（missing_permission），接收器收到 **0** 次',
    isRejected(denied) && decisionOf(denied) === 'missing_permission' && egressHits.count === before && egressRuns.count === 0,
    `decision=${decisionOf(denied)} · hits=${egressHits.count - before} · runs=${egressRuns.count}`
  )
  await noPermBed.stop()

  // 7b：授予 + R3 ⇒ **真的出站**（证明接收器能观测出站 = 量具是活的）
  const allowBed = await createActionTestBed({
    label: 's1-isolation-stub-egress-allowed',
    extraCapabilities: [egressCapability()],
    extraAdapters: [egressAdapter],
    grantedPermissions: [EGRESS_PERMISSION],
    maxRiskLevel: 'R3',
  })
  const beforeAllow = egressHits.count
  const allowed = (await allowBed.execute({
    capability: EGRESS_PROBE,
    operation: 'send',
    args: {},
    target: { type: 'sandbox_file', canonicalId: 'sink', confidence: 'exact' },
  })) as ResultShape
  record(
    'T7.2',
    '授予后**真的出站**（接收器收到 ≥1 次）⇒ 出站可被观测',
    allowed.accepted === true && allowed.executed === true && egressHits.count > beforeAllow,
    `hits=${egressHits.count - beforeAllow} · runs=${egressRuns.count}`
  )

  // 7c：同一能力在干跑床 ⇒ 出站被禁
  const dryEgressBed = await createActionTestBed({
    label: 's1-isolation-stub-egress-dryrun',
    extraCapabilities: [egressCapability()],
    extraAdapters: [egressAdapter],
    grantedPermissions: [EGRESS_PERMISSION],
    maxRiskLevel: 'R3',
    dryRun: true,
  })
  const beforeDry = egressHits.count
  const dry = (await dryEgressBed.execute({
    capability: EGRESS_PROBE,
    operation: 'send',
    args: {},
    target: { type: 'sandbox_file', canonicalId: 'sink', confidence: 'exact' },
  })) as ResultShape
  record(
    'T7.3',
    '干跑下出站被禁（dry_run_no_side_effect），接收器计数不变',
    isRejected(dry) && decisionOf(dry) === 'dry_run_no_side_effect' && egressHits.count === beforeDry,
    `decision=${decisionOf(dry)} · hits=${egressHits.count - beforeDry}`
  )
  await dryEgressBed.stop()
  await allowBed.stop()
}

await new Promise<void>((done) => receiver.close(() => done()))

// ===========================================================================
// T8 **越权 QQ 发送**（E-2 的第三个切片）——用**真能力声明** + **真适配器**
//
// 适配器：`createQqProactiveDeliveryAdapter`（注入一个只计数的假投递口 —— 没有任何真实 QQ 出站）。
// 目标：**注入 resolver** 模拟生产方式的那一支（`qq_private_owner` / `exact`）。
//      ⚠️ harness 缺省 resolver 是沙箱梯子，会把声明目标改写成 `sandbox_file` ⇒ 适配器判
//      `qq_send_target_not_owner`（探针实测），所以这里必须注入。
// 判据（.**全部由探针校准过**，见 E-2 侦察记录）：
//   A 未授予权限 ⇒ `missing_permission` + **0 次投递**
//   B 授予 + exact 目标 + 幂等键 ⇒ success + **1 次投递**（且正文真的交给了投递口）
//   C 缺幂等键 ⇒ `idempotency_key_required`（本仓库第一个 `idempotency: required` 的能力）+ 0 次
//   D 参数里塞收件人 ⇒ 适配器 `qq_send_recipient_from_argument`（"模型提供不了收件人"的机器形态）+ 0 次
//   E 目标置信度不是 exact ⇒ 适配器 `qq_send_target_not_owner` + 0 次
//   F 不给目标 ⇒ 策略 `target_uncertain` + 0 次
//   G 干跑 ⇒ `dry_run_no_side_effect` + 0 次
//   H **同一幂等键第二次** ⇒ 幂等重放：success 但 **0 次新投递**（重复发送是可见伤害）
// ===========================================================================
const qqDeliveries: { text: string; deliveryId: string }[] = []
const qqDelivery = {
  deliver(input: { deliveryId: string; text: string }) {
    qqDeliveries.push({ text: input.text, deliveryId: input.deliveryId })
    return { written: true }
  },
}
const qqAdapter = createQqProactiveDeliveryAdapter({
  delivery: qqDelivery,
  resolveDeliveryId: (input) => (input as { idempotencyKey?: string }).idempotencyKey,
})

/** 生产形状的 resolver：**回显声明目标**；没有声明 ⇒ 给出 `none` 置信度（让策略去判）。 */
const qqResolveTarget: GatewayResolveTarget = async ({ request }) => {
  const declared = request.target
  if (declared === undefined) {
    return { target: { type: 'unresolved', displayName: '未解析', confidence: 'none' }, scopeViolation: false }
  }
  return { target: declared, scopeViolation: false }
}

const QQ_TARGET_EXACT = {
  type: 'qq_private_owner',
  canonicalId: 'owner-isolation-fixture',
  displayName: '本人（隔离夹具）',
  confidence: 'exact' as const,
}

async function qqBed(granted: boolean, dryRun = false): Promise<Awaited<ReturnType<typeof createActionTestBed>>> {
  return createActionTestBed({
    label: `s1-isolation-stub-qq-${granted ? 'granted' : 'denied'}${dryRun ? '-dry' : ''}`,
    extraCapabilities: createQqProactiveCapabilityDefinitions(),
    extraAdapters: [qqAdapter],
    grantedPermissions: granted ? [QQ_PRIVATE_SEND_PERMISSION] : ['system:echo'],
    maxRiskLevel: 'R3',
    resolveTarget: qqResolveTarget,
    ...(dryRun ? { dryRun: true } : {}),
  })
}

interface QqResultShape extends ResultShape {
  error?: { code?: unknown; reason?: unknown; details?: { decision?: unknown; reason?: unknown } }
}
/**
 * 适配器具名理由读法（探针校准）：适配器的 `fail(code, reason, message)` 走
 * `actionFailure(code, message, { reason })` ⇒ 理由在 **`error.details.reason`**（不是 `error.reason`）。
 */
const reasonOf = (result: QqResultShape): string =>
  String(result.error?.details?.reason ?? result.error?.reason ?? '(无 reason)')

{
  // A 未授予权限
  const bed = await qqBed(false)
  const before = qqDeliveries.length
  const result = (await bed.execute({
    capability: 'qq.private.message',
    operation: 'send',
    args: { text: '越权尝试' },
    target: QQ_TARGET_EXACT,
    idempotencyKey: 'iso-qq-a',
  })) as QqResultShape
  record(
    'T8.1',
    '未授予 qq:private_send ⇒ 拒绝（missing_permission），且**一次投递都没有**',
    isRejected(result) && decisionOf(result) === 'missing_permission' && qqDeliveries.length === before,
    `decision=${decisionOf(result)} · deliveries=${qqDeliveries.length - before}`
  )
  await bed.stop()
}
{
  // B 正常：授予 + exact + 幂等键 ⇒ 真投递一次
  const bed = await qqBed(true)
  const before = qqDeliveries.length
  const result = (await bed.execute({
    capability: 'qq.private.message',
    operation: 'send',
    args: { text: '隔离夹具正文' },
    target: QQ_TARGET_EXACT,
    idempotencyKey: 'iso-qq-b',
  })) as QqResultShape
  const delta = qqDeliveries.length - before
  const last = qqDeliveries[qqDeliveries.length - 1]
  record(
    'T8.2',
    '授予 + exact 目标 + 幂等键 ⇒ success，且**真的投递一次**（正文交给了投递口）',
    result.accepted === true && result.executed === true && result.status === 'success' && delta === 1 && last?.text === '隔离夹具正文',
    `status=${String(result.status)} · deliveries=${delta} · text=${JSON.stringify(last?.text)}`
  )
  await bed.stop()
}
{
  // C 缺幂等键
  const bed = await qqBed(true)
  const before = qqDeliveries.length
  const result = (await bed.execute({
    capability: 'qq.private.message',
    operation: 'send',
    args: { text: '没有键' },
    target: QQ_TARGET_EXACT,
  })) as QqResultShape
  record(
    'T8.3',
    '缺幂等键 ⇒ 拒绝（idempotency_key_required：幂等**必需**的能力不许在没有键时发送），0 次投递',
    isRejected(result) && decisionOf(result) === 'idempotency_key_required' && qqDeliveries.length === before,
    `decision=${decisionOf(result)} · deliveries=${qqDeliveries.length - before}`
  )
  await bed.stop()
}
{
  // D 参数里塞收件人
  const bed = await qqBed(true)
  const before = qqDeliveries.length
  const result = (await bed.execute({
    capability: 'qq.private.message',
    operation: 'send',
    args: { text: '塞收件人', user_id: '12345' },
    target: QQ_TARGET_EXACT,
    idempotencyKey: 'iso-qq-d',
  })) as QqResultShape
  record(
    'T8.4',
    '参数里塞收件人 ⇒ 适配器具名拒绝（qq_send_recipient_from_argument），0 次投递',
    result.status === 'rejected' && reasonOf(result) === 'qq_send_recipient_from_argument' && qqDeliveries.length === before,
    `status=${String(result.status)} · reason=${reasonOf(result)} · deliveries=${qqDeliveries.length - before}`
  )
  await bed.stop()
}
{
  // E 目标置信度不是 exact
  const bed = await qqBed(true)
  const before = qqDeliveries.length
  const result = (await bed.execute({
    capability: 'qq.private.message',
    operation: 'send',
    args: { text: '目标不确定' },
    target: { ...QQ_TARGET_EXACT, confidence: 'strong' },
    idempotencyKey: 'iso-qq-e',
  })) as QqResultShape
  record(
    'T8.5',
    '目标置信度不是 exact ⇒ 适配器具名拒绝（qq_send_target_not_owner），0 次投递',
    result.status === 'rejected' && reasonOf(result) === 'qq_send_target_not_owner' && qqDeliveries.length === before,
    `status=${String(result.status)} · reason=${reasonOf(result)} · deliveries=${qqDeliveries.length - before}`
  )
  await bed.stop()
}
{
  // F 不给目标
  const bed = await qqBed(true)
  const before = qqDeliveries.length
  const result = (await bed.execute({
    capability: 'qq.private.message',
    operation: 'send',
    args: { text: '没目标' },
    idempotencyKey: 'iso-qq-f',
  })) as QqResultShape
  record(
    'T8.6',
    '不给目标 ⇒ 策略拒绝（target_uncertain），0 次投递',
    result.accepted === false && decisionOf(result) === 'target_uncertain' && qqDeliveries.length === before,
    `decision=${decisionOf(result)} · status=${String(result.status)} · deliveries=${qqDeliveries.length - before}`
  )
  await bed.stop()
}
{
  // G 干跑
  const bed = await qqBed(true, true)
  const before = qqDeliveries.length
  const result = (await bed.execute({
    capability: 'qq.private.message',
    operation: 'send',
    args: { text: '干跑' },
    target: QQ_TARGET_EXACT,
    idempotencyKey: 'iso-qq-g',
  })) as QqResultShape
  record(
    'T8.7',
    '干跑 ⇒ 出站被禁（dry_run_no_side_effect），0 次投递',
    isRejected(result) && decisionOf(result) === 'dry_run_no_side_effect' && qqDeliveries.length === before,
    `decision=${decisionOf(result)} · deliveries=${qqDeliveries.length - before}`
  )
  await bed.stop()
}
{
  // H 同一幂等键第二次（幂等重放：不产生第二次可见伤害）
  const bed = await qqBed(true)
  const before = qqDeliveries.length
  const first = (await bed.execute({
    capability: 'qq.private.message',
    operation: 'send',
    args: { text: '同一条' },
    target: QQ_TARGET_EXACT,
    idempotencyKey: 'iso-qq-h',
  })) as QqResultShape
  const afterFirst = qqDeliveries.length
  const second = (await bed.execute({
    capability: 'qq.private.message',
    operation: 'send',
    args: { text: '同一条' },
    target: QQ_TARGET_EXACT,
    idempotencyKey: 'iso-qq-h',
  })) as QqResultShape
  record(
    'T8.8',
    '同一幂等键第二次 ⇒ 幂等重放：**不产生第二次投递**（重复发送是可见伤害）',
    first.status === 'success' &&
      afterFirst - before === 1 &&
      qqDeliveries.length === afterFirst &&
      second.accepted === true,
    `first=${String(first.status)} · deliveries=${afterFirst - before} · afterSecond=${qqDeliveries.length - afterFirst}`
  )
  await bed.stop()
}

// ===========================================================================
// 汇总 + 证据 + 收尾
// ===========================================================================
const failed = checks.filter((c) => !c.pass)
const passed = failed.length === 0
const evidenceDir = join(REPO_ROOT, 'artifacts', 'post-lv2', runId)
mkdirSync(evidenceDir, { recursive: true })
writeFileSync(
  join(evidenceDir, 's1-isolation-stub-verify.json'),
  `${JSON.stringify(
    {
      runId,
      gate: 's1:isolation-stub:verify',
      sandbox: sandbox.dir,
      measuredCount: checks.length,
      failed: failed.length,
      checks,
      coveredClasses: [
        '文件写入（沙箱内）',
        '权限未授予',
        '路径逃逸',
        '风险超限',
        '干跑',
        '出站（本地接收器可观测）',
        '越权 QQ 发送（真能力声明 + 真适配器 + 假投递口：权限/幂等键/收件人参数/目标置信度/无目标/干跑/幂等重放）',
      ],
      notCoveredClasses: [
        'shell／桌面控制（本切片没有把这类能力登记为被测对象）',
        '数据库修改',
        '后台任务执行时的授权复查',
        '凭证**文件**本身的可读性（本门只证出站可观测/可拒；文件可读性由文件类的目标检查承担）',
      ],
      note:
        '真实权限链 + 一次性 %TEMP% 沙箱目标；零模型 / 零出网；生产库从不被打开。' +
        '策略结论读自 result.error.details.decision（探针校准，见 E-2 侦察记录）。',
    },
    null,
    2
  )}\n`,
  'utf8'
)

console.log('')
console.log(`  measured_count = ${checks.length}`)
console.log(`  ${passed ? '✅' : '❌'} s1:isolation-stub:verify = ${passed ? 'PASS' : 'FAIL'}`)
console.log(`  证据：${evidenceDir}/s1-isolation-stub-verify.json`)
if (!passed) {
  console.log('  失败项：')
  for (const c of failed) console.log(`    - ${c.id} ${c.label}：${c.detail}`)
}

cleanupSandbox(sandbox.dir)
await resetPluginSqlConnection()
process.exit(passed ? 0 : 1)
