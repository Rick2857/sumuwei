/**
 * U1 · 入口作用域门（`u1:entry-scope:verify`）—— 入口 ⇒ 作用域三元组
 *
 * 归属：多用户补充计划 U1 / WP5 接线的最后一环（`ADR-133` `D05`/`D12`；[`ADR-138`](../../docs/adr/ADR-138-authorization-filter-before-truncation.md)）。
 *
 * **纯进程内**：只读 `src/kernel/identity/entry-scope.ts`；零数据库 / 零模型 / 零出网。
 *
 * 它证明"入口翻译"本身的判据，特别是**失败关闭**那三条：
 *   ① 入站身份解析不出来 ⇒ **不给 scope**（不当作原主人）
 *   ② 群入口拿不到 groupId ⇒ 失败关闭
 *   ③ 群入口的 room **始终**是那个群（提问者是原主人也不变）
 *
 * ⚠️ 它**不**证明任何生产入口已经调用它（`main.ts` 仍未接线）。
 */

import { resolveEntryScope, ENTRY_KINDS, type EntryKind } from '../src/kernel/identity/entry-scope.ts'

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

const OWNER = 'u-owner'

// ===========================================================================
// T1 正控 · 四种入口各自的作用域
// ===========================================================================
{
  const ownerPrivate = resolveEntryScope({ entryKind: 'qq_private', ownerUserId: OWNER, resolvedInboundUserId: OWNER })
  record(
    'T1.1',
    '私聊 + 已绑定原主人 ⇒ {owner, external_query, private:owner}',
    ownerPrivate.failClosed === false &&
      ownerPrivate.scope?.principal.kind === 'owner' &&
      ownerPrivate.scope?.room.kind === 'private' &&
      ownerPrivate.scope?.room.userId === OWNER,
    `principal=${ownerPrivate.scope?.principal.kind} · room=${JSON.stringify(ownerPrivate.scope?.room)}`
  )
  const stranger = resolveEntryScope({ entryKind: 'qq_private', ownerUserId: OWNER, resolvedInboundUserId: 'u-b' })
  const strangerPrincipal = stranger.scope?.principal
  record(
    'T1.2',
    '私聊 + 普通用户 ⇒ {user, external_query, private:该用户}（**不是** owner）',
    stranger.failClosed === false &&
      strangerPrincipal !== undefined &&
      strangerPrincipal.kind === 'user' &&
      strangerPrincipal.userId === 'u-b' &&
      stranger.scope?.room.kind === 'private' &&
      stranger.scope?.room.userId === 'u-b',
    `principal=${String(strangerPrincipal?.kind)}/${strangerPrincipal?.kind === 'user' ? strangerPrincipal.userId : '(非用户)'}`
  )
  const avatar = resolveEntryScope({ entryKind: 'avatar_local', ownerUserId: OWNER })
  const cli = resolveEntryScope({ entryKind: 'cli_local', ownerUserId: OWNER })
  record(
    'T1.3',
    '本机入口（皮套 / CLI）⇒ owner + private:owner（操作者就是原主人，**不需要**入站身份）',
    avatar.failClosed === false && cli.failClosed === false && avatar.scope?.principal.kind === 'owner' && cli.scope?.principal.kind === 'owner',
    `avatar=${avatar.scope?.principal.kind} · cli=${cli.scope?.principal.kind}`
  )
  const group = resolveEntryScope({
    entryKind: 'qq_group',
    ownerUserId: OWNER,
    resolvedInboundUserId: 'u-c',
    groupId: 'g-1',
    groupAuthorized: true,
  })
  record(
    'T1.4',
    '群 + 已授权 ⇒ room 是那个群，`roomAuthorized=true`',
    group.failClosed === false &&
      group.scope?.room.kind === 'group' &&
      group.scope?.room.groupId === 'g-1' &&
      group.roomAuthorized === true,
    `room=${JSON.stringify(group.scope?.room)} · authorized=${String(group.roomAuthorized)}`
  )
}

// ===========================================================================
// T2 失败关闭三条（**本门的主要判据**）
// ===========================================================================
{
  const unknown = resolveEntryScope({ entryKind: 'qq_private', ownerUserId: OWNER })
  record(
    'T2.1',
    '私聊 + **身份解析不出来** ⇒ 不给 scope（失败关闭），**不当作原主人**',
    unknown.failClosed === true && unknown.scope === undefined && unknown.reason.includes('身份'),
    `failClosed=${String(unknown.failClosed)} · reason=${unknown.reason}`
  )
  const blank = resolveEntryScope({ entryKind: 'qq_private', ownerUserId: OWNER, resolvedInboundUserId: '   ' })
  record(
    'T2.2',
    '空白身份串也算**没有证据**（失败关闭）—— 不靠 trim 之外的宽容',
    blank.failClosed === true && blank.scope === undefined,
    `failClosed=${String(blank.failClosed)}`
  )
  const noGroup = resolveEntryScope({ entryKind: 'qq_group', ownerUserId: OWNER, resolvedInboundUserId: 'u-c' })
  record(
    'T2.3',
    '群入口拿不到 `groupId` ⇒ 失败关闭（不为叫不出名字的空间授权）',
    noGroup.failClosed === true && noGroup.scope === undefined,
    `failClosed=${String(noGroup.failClosed)} · reason=${noGroup.reason}`
  )
  const groupUnknownUser = resolveEntryScope({ entryKind: 'qq_group', ownerUserId: OWNER, groupId: 'g-1' })
  record(
    'T2.4',
    '群入口 + 身份不明 ⇒ 仍失败关闭（**群里也要知道是谁在问**）',
    groupUnknownUser.failClosed === true && groupUnknownUser.scope === undefined,
    `failClosed=${String(groupUnknownUser.failClosed)}`
  )
  const noOwner = resolveEntryScope({ entryKind: 'qq_private', ownerUserId: '  ', resolvedInboundUserId: OWNER })
  record(
    'T2.5',
    '配置里取不到原主人 id ⇒ 失败关闭（连"本人"都判不出来）',
    noOwner.failClosed === true && noOwner.scope === undefined,
    `failClosed=${String(noOwner.failClosed)}`
  )
}

// ===========================================================================
// T3 群不等于私聊（原主人在群里也仍是"在群里"）
// ===========================================================================
{
  const ownerInGroup = resolveEntryScope({
    entryKind: 'qq_group',
    ownerUserId: OWNER,
    resolvedInboundUserId: OWNER,
    groupId: 'g-1',
    groupAuthorized: true,
  })
  record(
    'T3.1',
    '原主人在群里提问 ⇒ room **仍是那个群**（不变成 private:owner）',
    ownerInGroup.scope?.room.kind === 'group' && ownerInGroup.scope?.room.groupId === 'g-1',
    `room=${JSON.stringify(ownerInGroup.scope?.room)}`
  )
  const unauthorized = resolveEntryScope({
    entryKind: 'qq_group',
    ownerUserId: OWNER,
    resolvedInboundUserId: 'u-c',
    groupId: 'g-1',
    groupAuthorized: false,
  })
  record(
    'T3.2',
    '群未授权 ⇒ `roomAuthorized=false`（**如实传递**，不在这里替策略放行）',
    unauthorized.failClosed === false && unauthorized.roomAuthorized === false,
    `roomAuthorized=${String(unauthorized.roomAuthorized)}`
  )
}

// ===========================================================================
// T4 缺标签的保守来源域恒为"原主人私聊"（`ADR-138` `D02`）
// ===========================================================================
{
  const cases: { id: string; kind: EntryKind; outcome: ReturnType<typeof resolveEntryScope> }[] = [
    { id: 'T4.1', kind: 'qq_private', outcome: resolveEntryScope({ entryKind: 'qq_private', ownerUserId: OWNER, resolvedInboundUserId: 'u-b' }) },
    { id: 'T4.2', kind: 'qq_group', outcome: resolveEntryScope({ entryKind: 'qq_group', ownerUserId: OWNER, resolvedInboundUserId: 'u-c', groupId: 'g-1' }) },
    { id: 'T4.3', kind: 'cli_local', outcome: resolveEntryScope({ entryKind: 'cli_local', ownerUserId: OWNER }) },
  ]
  for (const item of cases) {
    record(
      item.id,
      `${item.kind} 的缺省来源域 = **原主人私聊**（旧无标签记录对主人可见、对旁人不可见）`,
      item.outcome.defaultOriginRoom.kind === 'private' && item.outcome.defaultOriginRoom.userId === OWNER,
      `defaultOriginRoom=${JSON.stringify(item.outcome.defaultOriginRoom)}`
    )
  }
}

// ===========================================================================
// T5 拆防线 · "身份不明就当作原主人"必须与真实判定相反
// ===========================================================================
{
  // 弱化版：解析不出身份时按原主人处理 —— 这正是"陌生人被当成主人"的形状
  const weakened = (resolved: string | undefined) => resolved ?? OWNER
  const real = resolveEntryScope({ entryKind: 'qq_private', ownerUserId: OWNER })
  record(
    'T5.1',
    '拆防线 · "身份不明 ⇒ 当作原主人"会给出 owner 作用域，而**真实判定失败关闭**（证明这条防线被量到）',
    weakened(undefined) === OWNER && real.failClosed === true && real.scope === undefined,
    `weakened=${weakened(undefined)} · real.failClosed=${String(real.failClosed)}`
  )
  record('T5.2', '恢复 · 真实判定在拿到身份后正常给出 scope', resolveEntryScope({ entryKind: 'qq_private', ownerUserId: OWNER, resolvedInboundUserId: OWNER }).failClosed === false, 'ok')
}

// ===========================================================================
// T6 闭集自检
// ===========================================================================
{
  const bad = resolveEntryScope({ entryKind: 'telepathy' as EntryKind, ownerUserId: OWNER, resolvedInboundUserId: OWNER })
  record(
    'T6.1',
    '未登记的入口种类 ⇒ 失败关闭（闭集是四条：' + ENTRY_KINDS.join(' / ') + '）',
    bad.failClosed === true && bad.scope === undefined && ENTRY_KINDS.length === 4,
    `failClosed=${String(bad.failClosed)} · kinds=${ENTRY_KINDS.length}`
  )
}

// ===========================================================================
// 汇总
// ===========================================================================
const failed = checks.filter((c) => !c.pass)
const passed = failed.length === 0
console.log('')
console.log(`  measured_count = ${checks.length}`)
console.log(`  ${passed ? '✅' : '❌'} u1:entry-scope:verify = ${passed ? 'PASS' : 'FAIL'}`)
console.log('  ⚠️ 本门**不**代表生产入口已接线：`main.ts` 仍未调用它。')
if (!passed) {
  console.log('  失败项：')
  for (const c of failed) console.log(`    - ${c.id} ${c.label}：${c.detail}`)
}
process.exitCode = passed ? 0 : 1
