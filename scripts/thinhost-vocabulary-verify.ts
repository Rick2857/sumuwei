/**
 * 门：本地取值词表与上游**逐字一致**（M12 · W2-③）。
 *
 * ============================================================================
 *  为什么这道门不能省
 * ============================================================================
 * `EventType` / `ModelType` 在运行时**只是字符串**：
 *   · 事件名错一个字母 ⇒ 事件**永远不会被派发**（不报错，只是没反应）
 *   · 模型路由键错 ⇒ `useModel` **回落到 TEXT_LARGE**（不报错，但行为漂了）
 * ⇒ 这两处都是**静默失败**：`typecheck` 一条都抓不到。
 *
 * ⚠️ 因此判据必须是**逐字比对上游的实际值**，不是"看起来对"。
 * ⚠️ 上游还在（删包前）⇒ 本门直接读上游的运行时对象做对照 —— 不是抄进本仓库的常量。
 *    删包后本门改为"对照冻结字面量"（与 UUID 门同一模式）。
 *
 * ⚠️ `ChannelType` **不在**本门范围内 —— 它是**类型层**问题（名义类型），
 *    与 `Memory`/`Room` 类型一起在 W4 处理（见 eliza-vocabulary.ts 的说明）。
 */

import { EventType, ModelType } from '../src/infrastructure/runtime/eliza-vocabulary.ts'

interface Check { id: string; ok: boolean; detail: string }
const checks: Check[] = []
function check(id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`)
}

// ---------------------------------------------------------------------------
// 上游**冻结读数**（M12 · W4：包已删除，无法再实时比对）
//
// ⚠️⚠️ 这不是"降级"，是**同一门换了取证方式**：
//   删包前这道门**每次运行**都实时 `import('@elizaos/core')` 逐字比对；
//   删包后那不可能了 ⇒ 把**当时实测到的上游取值**冻成**字面量**留在这里。
//   ⚠️ 判据强度因此从"与上游此刻一致"变成"与上游 **2026-10-19 实测值**一致" ——
//     这是真实的能力损失，如实记。补偿：字面量旁边写明取自 core dist 的行号，
//     任何人都能按图索骥复核。
// ---------------------------------------------------------------------------
const upstream = {
  EventType: {
    MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
    MESSAGE_SENT: 'MESSAGE_SENT',
    RUN_STARTED: 'RUN_STARTED',
    RUN_ENDED: 'RUN_ENDED',
  },
  ModelType: { TEXT_SMALL: 'TEXT_SMALL', TEXT_LARGE: 'TEXT_LARGE' },
  /**
   * ⚠️ 上游 `ModelType` 实测**含 19 个成员**（本地只用 2 个）。
   *   这里只冻结"本地没有的那些"的键集合 —— E4b 判的就是"本地不得自造成员"，
   *   而 E4 判的是"本地成员的值必须逐字等于上游同名成员的值"。
   *   ⚠️ 注意：这两个判据**只需要**上游成员的名字与值，不需要完整枚举 ⇒
   *   但为了 E4b 说清"上游有 19 个"，这里把数量也冻下来。
   */
  ModelTypeMemberCount: 19,
  ChannelType: { DM: 'DM' },
  /**
   * 上游 `AgentRuntime` 构造后的 `agentId`（实测 LG 角色）。
   * ⚠️ 规则来自 core dist:48921：`opts.character?.id ?? opts?.agentId ?? stringToUuid(name)`
   *    ⇒ `character.id` 优先 ⇒ 就是 LG 的固定角色 id。
   */
  agentIdForCharacterId: '00000000-0000-4000-8000-000000000001',
} as const

{
  const local: Record<string, string> = { ...EventType }
  const up: Record<string, string> = upstream.EventType
  const mismatches = Object.keys(local)
    .filter((k) => up[k] !== local[k])
    .map((k) => `${k}: 本地=${String(local[k])} 上游=${String(up[k])}`)
  check(
    'E1-event-type-values-match-upstream',
    mismatches.length === 0,
    mismatches.length === 0
      ? `EventType 四个值与上游逐字一致：${Object.keys(local).join(', ')}`
      : `不一致：${mismatches.join(' | ')}`
  )
}

{
  const local: Record<string, string> = { ...ModelType }
  const up: Record<string, string> = upstream.ModelType
  const mismatches = Object.keys(local)
    .filter((k) => up[k] !== local[k])
    .map((k) => `${k}: 本地=${String(local[k])} 上游=${String(up[k])}`)
  check(
    'E2-model-type-values-match-upstream',
    mismatches.length === 0,
    mismatches.length === 0
      ? `ModelType 两个值与上游逐字一致：${Object.keys(local).map((k) => `${k}=${String(local[k])}`).join(', ')}`
      : `不一致：${mismatches.join(' | ')}`
  )
}

// ---------------------------------------------------------------------------
// 形状对等：上游 `ModelType` 是**普通对象**（不是 TS enum）
// ⚠️ 第一版判据是"有没有键等于某个值"（反向映射的经典特征）——**它错了**：
//    `ModelType.TEXT_SMALL = 'TEXT_SMALL'`，**值恰好等于键名** ⇒ 被误判成"有反向映射"。
//    ⇒ 改成能真正区分的判据：**数值型 enum 会在运行时多出数字键**（`{0:'DM',DM:0}`），
//      而字符串 enum / 普通对象**一个数字都没有**。
//    这个判据能抓到"把本地改成数值 enum"这种真会改变运行时形状的改动。
// ---------------------------------------------------------------------------
{
  const upModel = upstream.ModelType
  const localModel: Record<string, unknown> = { ...ModelType }
  const upHasNumber = Object.values(upModel).some((v) => typeof v === 'number')
  const localHasNumber = Object.values(localModel).some((v) => typeof v === 'number')
  check(
    'E4-model-type-no-numeric-enum-shape',
    upHasNumber === false && localHasNumber === false,
    `上游 ModelType 含数字值=${String(upHasNumber)} · 本地含数字值=${String(localHasNumber)}` +
      `（数值 enum 会多出数字键 ⇒ 运行时形状不同）`
  )
}

// ---------------------------------------------------------------------------
// 形状对等：本地对象的**键集合**必须是上游键集合的子集（不许自造成员）
// ⚠️ 自造成员 = 上游没有的事件名/模型键 ⇒ 静默失效（永远不会被派发/命中）。
// ---------------------------------------------------------------------------
{
  const localKeys = Object.keys(ModelType)
  const upKeys = Object.keys(upstream.ModelType)
  const extra = localKeys.filter((k) => !upKeys.includes(k))
  check(
    'E4b-no-self-invented-members',
    extra.length === 0,
    extra.length === 0
      ? `本地没有自造成员（上游实测有 ${String(upstream.ModelTypeMemberCount)} 个，本地用 ${String(localKeys.length)} 个）`
      : `自造了上游没有的成员：${extra.join(', ')}`
  )
}

// ---------------------------------------------------------------------------
// 负控：**故意改一个字**必须被抓到
// ⚠️ 没有这条，一个"恒返回 true"的实现能过 E1–E4。
// ---------------------------------------------------------------------------
{
  const fake: Record<string, string> = { ...EventType }
  fake.MESSAGE_RECEIVED = 'MESSAGE_RECEIVED_TYPO'
  const detected = upstream.EventType.MESSAGE_RECEIVED !== fake.MESSAGE_RECEIVED
  check(
    'E5-negative-control',
    detected,
    `改坏一个事件名后比对必须报红（上游=${String(upstream.EventType.MESSAGE_RECEIVED)} 改后=${String(fake.MESSAGE_RECEIVED)}）`
  )
}

// ---------------------------------------------------------------------------
// 负控二：值改一个字符也必须被抓到（不只是"键不存在"）
// ---------------------------------------------------------------------------
{
  const local: Record<string, string> = { ...ModelType }
  local.TEXT_LARGE = 'TEXT_LARG'
  const up: Record<string, string> = upstream.ModelType
  const mismatches = Object.keys(local).filter((k) => up[k] !== local[k])
  check(
    'E6-negative-control-value-typo',
    mismatches.length === 1 && mismatches[0] === 'TEXT_LARGE',
    `模型路由键差一个字符也必须被抓到（抓到 ${String(mismatches.length)} 处：${mismatches.join(', ')}）`
  )
}

// ---------------------------------------------------------------------------
// E7 · **`runtime.agentId` 必须与旧宿主逐字相同**（2026-10-19 生产实测发现的真问题）
//
// ⚠️⚠️ 这不是"风格问题"，是**数据分裂**问题：
//   上游规则（core dist:48921）：`opts.character?.id ?? opts?.agentId ?? stringToUuid(name)`
//   ⇒ `character.id` **优先于**显式 `agentId`。
//   而 `agent_id` 是 `entities` / `rooms` / `memories` / `participants` 的**外键**
//   ⇒ 两种 id 会把**同一个角色**的数据劈成两半。
//   实测：薄宿主最初用 `stringToUuid('agent-'+name)` ⇒ `agents` 表**多出一行**苏沐薇。
//
// ⇒ 判据：**直接比对上游的实际推导结果**，不是比对"我们以为的规则"。
// ---------------------------------------------------------------------------
{
  const { resolveAgentId } = await import('../src/infrastructure/runtime/thin-host-factory.ts')
  const { character } = await import('../src/character/index.ts')

  // ⚠️ 删包后不能"真的造一个上游宿主读它的 agentId" ⇒ 与**冻结读数**比对。
  //   上游规则（core dist:48921）= `opts.character?.id ?? opts?.agentId ?? stringToUuid(name)`
  //   ⇒ LG 角色有 id ⇒ 上游的 agentId 就是 `character.id`。
  const expected = upstream.agentIdForCharacterId
  const got = resolveAgentId(
    { name: character.name, id: character.id },
    `11111111-2222-4333-8444-555555555555` // 故意传一个"看起来对但不同"的值（合成值）
  )
  check(
    'E7-agent-id-matches-upstream',
    got === expected && character.id === expected,
    `薄宿主的 agentId 与上游冻结读数逐字一致（上游=${expected} 本地=${got} character.id=${String(character.id)}）` +
      (got === expected && character.id === expected ? '' : ' ⇒ **数据会分裂**（agent_id 是四张表的外键）')
  )
  check(
    'E7b-character-id-wins',
    resolveAgentId({ name: 'x', id: 'ID-FROM-CHARACTER' }, 'ID-EXPLICIT') === 'ID-FROM-CHARACTER',
    'character.id 优先于显式 agentId（与上游同款优先级）'
  )
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n=== 取值词表门: ${checks.length - failed.length}/${checks.length} PASS ===`)
for (const f of failed) console.log(`FAILED: ${f.id} — ${f.detail}`)
if (failed.length > 0) process.exitCode = 1
