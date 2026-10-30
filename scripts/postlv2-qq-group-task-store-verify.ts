/**
 * **门 `postlv2:qq-group-task-store:verify`** —— QQ 群任务持久层（迁移 0027 + store）。
 *
 * ============================================================================
 *  它证明什么（每条都来自**真实隔离 PostgreSQL** 的真实读写，不看自述）
 * ============================================================================
 * ```text
 * 01 迁移连续到 27（DB 读数 = latestSchemaVersion = 27，名字逐字对）
 * 02 建单落库 + 读回（闭集/契约版本/dedupe 幂等/create 事件/列表过滤）
 * 03 每群最多一条非终态 reply_window（第二条具名拒绝；终态不占名额）
 * 04 授权来源只有 owner_qq_private（DDL check + store 输入闸，伪造值被拒）
 * 05 修改 CAS 冲突（旧 expectedVersion 被拒且**一个字段都没改**）
 * 06 修改升版本且 used_messages 逐字保留；内容形态切换清字段并记进事件
 * 07 非法状态迁移被拒（completed→active），行不变
 * 08 停止：queued→failed_confirmed、TaskStopReport 读数如实（在途仍计数）
 * 09 预留成功占用（实例 + send_reserved 事件 + 契约判定拒绝分支）
 * 10 **并发**抢最后一条额度：恰一个 granted、另一个 total_budget_exhausted
 * 11 per-inbound 额度（计划条数超限 / 同入站再占 / 换入站可占）
 * 12 slot 额度按**窗口**计算（窗口内拒、窗口外放）
 * 13 minInterval 生效（间隔内拒、到点放）
 * 14 api_accepted 增 used_messages；同结算重报幂等（不重复加账）
 * 15 failed_confirmed **不退额**（额度仍被消耗，再预留被拒）
 * 16 unknown 增额度并把任务**暂停**（之后预留被拒）
 * 17 重启恢复 in_flight→unknown / queued→failed_confirmed，且**不重播**
 *    （含 `markGroupSendInFlight` 只允许 queued→in_flight、重复调用幂等返回 false）
 * 18 append-only + 事件闭集（DDL 列出全部 10 个名字；闭集外被 DDL 拒；无 update/delete 路径）
 * 19 到额度上限后任务转 exhausted，后续预留被拒（自动 + 显式两条路径）
 * 20 坏行/坏 jsonb 读回**抛具名 KernelError**，不回退默认值
 * 21 发送前复核读数：剔除自己、其它实例（含在途/已明确失败）照常计入
 * 22 发送前复核读数：per-inbound 只算**同一条入站**的其它实例
 * 23 发送前复核读数：slot 只算窗口内其它实例 · 找不到自己 ⇒ 失败关闭
 * ```
 *
 * ⚠️ 诚实的边界（必须与读数一起读）：
 *  · 并发只有**一次** `Promise.all`（两个真并发事务）读数，**没有**多轮压测。
 *  · 零真实 QQ / 零真实模型 / 零 TTS / 零出网：本门只碰隔离库。
 *  · 18 的"append-only"是**结构断言**（源码里没有 update/delete 语句）+ DDL 闭集，
 *    不是"数据库里装了一个禁止改历史的触发器"（本批刻意不装）。
 *  · 17 的恢复读数来自**真实 UPDATE 行数**，但"进程真被杀"没有在本门复现。
 *
 * 运行（宿主，一次性隔离 PostgreSQL；`runPreparedPgGate` 起 pgvector 容器）：
 *   npx tsx scripts/postlv2-qq-group-task-store-verify.ts
 * ⚠️ 跑不了（没有 docker / 镜像不在）⇒ 本门**失败关闭并如实报 NOT RUN**，
 *    绝不退化成"裸 docker run"或借用生产库。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// 自举：外层起一次性隔离 PostgreSQL，内层（本轮子进程）才碰库
// ---------------------------------------------------------------------------
if (process.env.LG_QQ_GROUP_TASK_STORE_PG_CHILD !== '1') {
  process.env.LG_QQ_GROUP_TASK_STORE_PG_CHILD = '1'
  process.env.LG_PG_GATE_TIMEOUT_MS ??= '900000'
  const harness = await import('./postgresql/test-harness.ts')
  const admin = (process.env.LG_SIM_PGTEST_ADMIN_URL ?? '').trim()
  try {
    if (admin !== '') {
      await harness.runPreparedPgGateInInstance(
        admin, 'qq-group-task-store', 'scripts/postlv2-qq-group-task-store-verify.ts')
    } else {
      await harness.runPreparedPgGate('qq-group-task-store', 'scripts/postlv2-qq-group-task-store-verify.ts')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    /*
     * 两类失败必须分开报：门体断言失败（读数在上）**不是** "跑不起来"。
     * 混成一句 NOT RUN 会让批记录把"红了"读成"没跑"。
     */
    if (message.includes('PostgreSQL gate failed')) {
      console.error('❌ 门体断言失败（读数见上；一次性隔离库/容器已由 harness 清理）')
      process.exit(1)
    }
    console.error('❌ NOT RUN：隔离 PostgreSQL 起不来（本门失败关闭，不退化成裸 docker run / 生产库）')
    console.error(message)
    process.exit(2)
  }
  process.exit(0)
}

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { createM4Harness } from './m4-harness.ts'
import { currentSchemaVersion, exec } from '../src/infrastructure/persistence/db.ts'
import {
  assertMigrationsWellFormed,
  latestSchemaVersion,
} from '../src/infrastructure/persistence/migrations.ts'
import { KernelError } from '../src/kernel/contracts/ids.ts'
import { GROUP_TASK_CONTRACT_VERSION } from '../src/kernel/contracts/qq-group-task.ts'
import {
  GROUP_TASK_EVENT_NAMES,
  createGroupTask,
  getGroupTask,
  listGroupSendInstances,
  listGroupTasks,
  markGroupSendInFlight,
  modifyGroupTask,
  readSendOccupancyForRecheck,
  recoverGroupSendStateOnRestart,
  reserveGroupSend,
  setGroupTaskStatus,
  settleGroupSend,
  type CreateGroupTaskInput,
} from '../src/infrastructure/persistence/qq-group-task-store.ts'

// ---------------------------------------------------------------------------
// 隔离（失败关闭）：库名必须是 lg_test_*，否则立刻退出
// ---------------------------------------------------------------------------
const testUrl = (process.env.LG_TEST_PG_URL ?? '').trim()
const testPath = testUrl === '' ? '' : (() => { try { return new URL(testUrl).pathname } catch { return '' } })()
if (process.env.CHARACTER_DB_BACKEND !== 'postgres' || !/^\/lg_test_[a-z0-9_]+$/i.test(testPath)) {
  console.error('❌ NOT RUN：本门必须在隔离 PostgreSQL 上跑（CHARACTER_DB_BACKEND=postgres 且 LG_TEST_PG_URL 库名 lg_test_*）')
  console.error(`   backend=${String(process.env.CHARACTER_DB_BACKEND)} path=${testPath === '' ? '(空)' : testPath}`)
  process.exit(2)
}
const sandbox = isolateDatabase('qq-group-task-store', { postgres: { url: testUrl } })
assert.equal(sandbox.backend, 'postgres')
const h = await createM4Harness({ label: 'qq-group-task-store' })

// ---------------------------------------------------------------------------
// 检查器
// ---------------------------------------------------------------------------
const checks: { id: string; name: string; pass: boolean; detail: string }[] = []
function checkMany(id: string, name: string, problems: readonly string[], detail = ''): void {
  const pass = problems.length === 0
  checks.push({ id, name, pass, detail: pass ? detail : problems.join(' | ') })
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${name}${detail === '' && pass ? '' : ` — ${pass ? detail : problems.join(' | ')}`}`)
}
function check(id: string, name: string, value: unknown, detail = ''): void {
  checkMany(id, name, value ? [] : ['断言失败'], detail)
}

/** 期望抛错：返回是否抛了、KernelError 的 code、消息 */
async function rejection(run: () => Promise<unknown>): Promise<{
  failed: boolean; isKernel: boolean; code: string; message: string
}> {
  try {
    await run()
    return { failed: false, isKernel: false, code: '', message: '没有抛错' }
  } catch (error) {
    if (error instanceof KernelError) {
      return { failed: true, isKernel: true, code: error.code, message: error.message }
    }
    return { failed: true, isKernel: false, code: '', message: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
const BOT = '3000001'
const NOW = 1_800_000_000_000

function taskInput(overrides: Partial<CreateGroupTaskInput> & { id: string; dedupeKey: string }): CreateGroupTaskInput {
  return {
    authSource: 'owner_qq_private',
    kind: 'reply_window',
    status: 'active',
    target: { botId: BOT, groupId: '8000001' },
    content: { mode: 'owner_verbatim', text: '明天三点在群里通知一下', brief: null },
    media: 'text',
    textFallback: false,
    trigger: { memberIds: [], replyToMessageId: null, categories: [], topicScope: null },
    term: { kind: 'window', startAt: NOW - 60_000, endAt: NOW + 3_600_000 },
    quota: { totalMaxMessages: 5, perInboundMaxMessages: 1, slot: null, minIntervalMs: 0 },
    now: NOW,
    ...overrides,
  }
}

async function eventRows(taskId: string): Promise<Record<string, unknown>[]> {
  return exec(h.db, sql`select event, version, detail, at from qq_group_task_events
    where task_id = ${taskId} order by at asc, event_id asc`, '读取群任务事件')
}

async function openInstanceIds(): Promise<{ id: string; state: string }[]> {
  const rows = await exec(h.db, sql`select id, state from qq_group_send_instances
    where state in ('queued', 'in_flight') order by created_at asc, id asc`, '读取未结算发送实例')
  return rows.map(row => ({ id: String(row.id), state: String(row.state) }))
}

async function countEvents(): Promise<number> {
  const rows = await exec(h.db, sql`select count(*)::int as n from qq_group_task_events`, '统计事件数')
  return Number(rows[0]?.n ?? 0)
}

let connectedDatabase = ''
const readings: Record<string, unknown> = {}

try {
  // -------------------------------------------------------------------------
  // 库身份（**实测**：来自 current_database()）
  // -------------------------------------------------------------------------
  const identity = await exec(h.db, sql`select current_database() as db, current_user as usr`, '读回数据库身份')
  connectedDatabase = String(identity[0]?.db ?? '')

  // -------------------------------------------------------------------------
  // 01 迁移
  // -------------------------------------------------------------------------
  {
    assertMigrationsWellFormed()
    const rows = await exec(h.db, sql`select version, name from character_schema_migrations order by version`,
      '读取已应用迁移')
    const versions = rows.map(row => Number(row.version))
    const latest = latestSchemaVersion()
    const current = await currentSchemaVersion(h.db)
    const named = rows.some(row => Number(row.version) === 27 && String(row.name) === 'qq-owner-authorized-group-tasks')
    checkMany('01', '迁移连续应用到 27（DB / latestSchemaVersion / 名字）', [
      ...(latest === 27 ? [] : [`latestSchemaVersion=${latest}`]),
      ...(current === 27 ? [] : [`currentSchemaVersion=${current}`]),
      ...(versions.length === 27 ? [] : [`applied=${versions.length}`]),
      ...(versions.every((v, index) => v === index + 1) ? [] : ['版本不是 1..27 连续']),
      ...(named ? [] : ['迁移 27 名字不符']),
    ], `db=${connectedDatabase} latest=${latest} applied=${versions.length}`)
    readings.migrations = { current, applied: versions.length, name27: named }
  }

  // -------------------------------------------------------------------------
  // 02 建单落库 + 读回 + dedupe 幂等
  // -------------------------------------------------------------------------
  {
    const input = taskInput({ id: 'qgt:t1', dedupeKey: 'owner_qq_private:evt-1' })
    const created = await createGroupTask(h.db, input)
    const read = await getGroupTask(h.db, input.id)
    const again = await createGroupTask(h.db, input)
    const events = await eventRows(input.id)
    const listed = await listGroupTasks(h.db, { status: 'active', groupId: '8000001' })
    const problems: string[] = []
    if (!created.created) problems.push('第一次建单 created=false')
    if (read === undefined) problems.push('读不回')
    else {
      if (read.contractVersion !== GROUP_TASK_CONTRACT_VERSION) problems.push(`contractVersion=${read.contractVersion}`)
      if (read.version !== 1) problems.push(`version=${read.version}`)
      if (read.status !== 'active') problems.push(`status=${read.status}`)
      if (read.kind !== 'reply_window') problems.push(`kind=${read.kind}`)
      if (read.authSource !== 'owner_qq_private') problems.push(`authSource=${read.authSource}`)
      if (read.usedMessages !== 0) problems.push(`usedMessages=${read.usedMessages}`)
      if (read.target.botId !== BOT || read.target.groupId !== '8000001') problems.push('target 不符')
      if (read.content.text !== input.content.text) problems.push('content.text 不是逐字原文')
    }
    if (again.created) problems.push('同 dedupe 键重复建单 created=true')
    if (again.task.id !== input.id) problems.push('dedupe 命中返回了别的任务')
    if (events.length !== 1) problems.push(`create 事件数=${events.length}`)
    else if (String(events[0]!.event) !== 'create') problems.push(`第一条事件=${String(events[0]!.event)}`)
    if (!listed.some(task => task.id === input.id)) problems.push('列表过滤读不到刚建的任务')
    checkMany('02', '建单落库 + 读回闭集 + dedupe 幂等 + create 事件', problems,
      `created=${created.created} dedupeCreated=${again.created} events=${events.length}`)
    readings.create = { created: created.created, dedupeCreated: again.created, events: events.length }
  }

  // -------------------------------------------------------------------------
  // 03 每群最多一条非终态 reply_window
  // -------------------------------------------------------------------------
  {
    const second = await rejection(() => createGroupTask(h.db, taskInput({
      id: 'qgt:t1b', dedupeKey: 'owner_qq_private:evt-2',
    })))
    const openRows = await exec(h.db, sql`select count(*)::int as n from qq_group_tasks
      where kind = 'reply_window' and bot_id = ${BOT} and group_id = '8000001'
        and status in ('clarifying','active','paused')`, '统计同群非终态回复任务')
    /* 终态不占名额：先建一条 revoked，再在同群建 active 必须成功 */
    const revoked = await createGroupTask(h.db, taskInput({
      id: 'qgt:t3a', dedupeKey: 'owner_qq_private:evt-3', status: 'revoked',
      target: { botId: BOT, groupId: '8000004' },
    }))
    const activeAfterRevoked = await createGroupTask(h.db, taskInput({
      id: 'qgt:t3b', dedupeKey: 'owner_qq_private:evt-4', status: 'active',
      target: { botId: BOT, groupId: '8000004' },
    }))
    checkMany('03', '每群最多一条非终态 reply_window（终态不占名额）', [
      ...(second.failed ? [] : ['第二条 reply_window 没有被拒']),
      ...(second.code === 'group_task_conflict_requires_decision' ? [] : [`拒绝码=${second.code || '(非 KernelError)'}`]),
      ...(Number(openRows[0]?.n ?? 0) === 1 ? [] : [`同群非终态数=${String(openRows[0]?.n)}`]),
      ...(revoked.created ? [] : ['revoked 终态任务建不出来']),
      ...(activeAfterRevoked.created ? [] : ['终态任务占了名额（同群 active 建不出来）']),
    ], `code=${second.code} open=1`)
    readings.groupUniqueness = { code: second.code, open: Number(openRows[0]?.n ?? 0), terminalThenActive: activeAfterRevoked.created }
  }

  // -------------------------------------------------------------------------
  // 04 授权来源只有 owner_qq_private
  // -------------------------------------------------------------------------
  {
    const storeFake = await rejection(() => createGroupTask(h.db, taskInput({
      id: 'qgt:fake-source', dedupeKey: 'owner_qq_private:fake',
      authSource: 'group_member_claim' as never,
    })))
    const ddlFake = await rejection(() => exec(h.db, sql`insert into qq_group_tasks
      (id, contract_version, version, status, kind, bot_id, group_id, content, media, text_fallback,
       trigger, term, quota, used_messages, last_send_at, auth_source, dedupe_key, created_at, updated_at)
      values ('qgt:ddl-fake', 1, 1, 'active', 'send_once', ${BOT}, '8000099', '{}'::jsonb, 'text', false,
              '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, null, 'group_member_claim', 'ddl-fake', 1, 1)`,
    '伪造授权来源（DDL 必须拒）'))
    const checksRows = await exec(h.db, sql`select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'qq_group_tasks'::regclass and contype = 'c'`, '读取任务表 check 约束')
    const authDef = checksRows
      .map(row => String(row.def ?? ''))
      .find(def => def.includes('owner_qq_private'))
    checkMany('04', '授权来源闭集只有 owner_qq_private（store 闸 + DDL check 双层）', [
      ...(storeFake.failed && storeFake.code === 'group_task_input_invalid'
        ? [] : [`store 闸=${storeFake.code || '没拦'}`]),
      ...(ddlFake.failed && ddlFake.isKernel ? [] : ['DDL 没有拒绝伪造授权来源']),
      ...(ddlFake.message.includes('auth_source') || ddlFake.message.includes('check') ? [] : ['DDL 拒绝理由不可辨']),
      ...(authDef === undefined ? ['找不到含 owner_qq_private 的 check 约束'] : []),
      ...(authDef !== undefined && authDef.includes('group_member_claim') ? ['DDL 闭集被放宽'] : []),
    ], `store=${storeFake.code} ddl=${ddlFake.failed ? 'rejected' : 'accepted'}`)
    readings.authSource = { storeCode: storeFake.code, ddlRejected: ddlFake.failed, checkDef: authDef ?? null }
  }

  // -------------------------------------------------------------------------
  // 05 修改 CAS 冲突
  // -------------------------------------------------------------------------
  {
    const stale = await modifyGroupTask(h.db, 'qgt:t1', 99, { media: 'either' }, NOW + 1000)
    const read = await getGroupTask(h.db, 'qgt:t1')
    checkMany('05', '修改 CAS 冲突（旧 expectedVersion 被拒且行不变）', [
      ...(stale.ok === false ? [] : ['旧版本修改居然成功']),
      ...(stale.ok === false && stale.code === 'group_task_version_conflict' ? [] : [`code=${stale.ok ? '(ok)' : stale.code}`]),
      ...(read !== undefined && read.version === 1 ? [] : [`version=${String(read?.version)}`]),
      ...(read !== undefined && read.media === 'text' ? [] : [`media=${String(read?.media)}`]),
    ], `code=${stale.ok ? '(ok)' : stale.code}`)
  }

  // -------------------------------------------------------------------------
  // 06 修改升版本 + 已用次数保留 + 形态切换清字段记事件
  // -------------------------------------------------------------------------
  {
    const created = await createGroupTask(h.db, taskInput({
      id: 'qgt:t6', dedupeKey: 'owner_qq_private:evt-6', kind: 'send_once',
      usedMessages: 2,
    }))
    const first = await modifyGroupTask(h.db, 'qgt:t6', 1,
      { minIntervalMs: 60_000, topicScope: '只回复作业相关' }, NOW + 1000)
    const switched = await modifyGroupTask(h.db, 'qgt:t6', 2,
      { contentMode: 'model_generated', brief: '围绕作业复述要点，语气自然' }, NOW + 2000)
    const events = await eventRows('qgt:t6')
    const modifyEvent = events.filter(row => String(row.event) === 'modify')
    const lastDetail = modifyEvent.length === 0 ? undefined : modifyEvent[modifyEvent.length - 1]!.detail
    const cleared = Array.isArray((lastDetail as Record<string, unknown> | undefined)?.cleared)
      ? (lastDetail as Record<string, unknown>).cleared as unknown[] : []
    const read = await getGroupTask(h.db, 'qgt:t6')
    checkMany('06', '修改升版本 + used_messages 保留 + 形态切换清字段并记事件', [
      ...(created.created ? [] : ['夹具建单失败']),
      ...(first.ok ? [] : [`第一次修改失败=${first.code}`]),
      ...(switched.ok ? [] : [`形态切换失败=${switched.code}`]),
      ...(read !== undefined && read.version === 3 ? [] : [`version=${String(read?.version)}`]),
      ...(read !== undefined && read.usedMessages === 2 ? [] : [`usedMessages=${String(read?.usedMessages)}`]),
      ...(read !== undefined && read.quota.minIntervalMs === 60_000 ? [] : ['minIntervalMs 没落库']),
      ...(read !== undefined && read.trigger.topicScope === '只回复作业相关' ? [] : ['topicScope 没落库']),
      ...(read !== undefined && read.content.mode === 'model_generated' ? [] : ['contentMode 没落库']),
      ...(read !== undefined && read.content.text !== null ? [`content.text 没清空=${String(read?.content.text)}`] : []),
      ...(read !== undefined && read.content.brief === '围绕作业复述要点，语气自然' ? [] : ['brief 没落库']),
      ...(cleared.includes('text') ? [] : [`modify 事件没记 cleared=${JSON.stringify(cleared)}`]),
      ...(modifyEvent.length === 2 ? [] : [`modify 事件数=${modifyEvent.length}`]),
    ], `version=3 used=2 cleared=${JSON.stringify(cleared)}`)
    readings.modify = { version: read?.version, used: read?.usedMessages, cleared, modifyEvents: modifyEvent.length }
  }

  // -------------------------------------------------------------------------
  // 07 非法状态迁移
  // -------------------------------------------------------------------------
  {
    await createGroupTask(h.db, taskInput({
      id: 'qgt:t7', dedupeKey: 'owner_qq_private:evt-7', kind: 'send_once', status: 'completed',
    }))
    const bad = await setGroupTaskStatus(h.db, 'qgt:t7', 1, 'active', NOW + 1000)
    const read = await getGroupTask(h.db, 'qgt:t7')
    checkMany('07', '非法状态迁移被拒（completed→active）且行不变', [
      ...(bad.ok === false ? [] : ['completed→active 居然成功']),
      ...(bad.ok === false && bad.code === 'group_task_transition_invalid' ? [] : [`code=${bad.ok ? '(ok)' : bad.code}`]),
      ...(read !== undefined && read.status === 'completed' ? [] : [`status=${String(read?.status)}`]),
      ...(read !== undefined && read.version === 1 ? [] : [`version=${String(read?.version)}`]),
    ], `code=${bad.ok ? '(ok)' : bad.code}`)
  }

  // -------------------------------------------------------------------------
  // 08 停止：queued→failed_confirmed + TaskStopReport
  // -------------------------------------------------------------------------
  {
    await createGroupTask(h.db, taskInput({
      id: 'qgt:t8', dedupeKey: 'owner_qq_private:evt-8',
      target: { botId: BOT, groupId: '8000006' },
      quota: { totalMaxMessages: 5, perInboundMaxMessages: 2, slot: null, minIntervalMs: 0 },
    }))
    const reservedA = await reserveGroupSend(h.db, {
      taskId: 'qgt:t8', now: NOW, target: { botId: BOT, groupId: '8000006' },
      plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'stop-a',
    })
    const reservedB = await reserveGroupSend(h.db, {
      taskId: 'qgt:t8', now: NOW + 1, target: { botId: BOT, groupId: '8000006' },
      plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'stop-b',
    })
    const instanceA = reservedA.kind === 'granted' ? reservedA.instance : undefined
    const instanceB = reservedB.kind === 'granted' ? reservedB.instance : undefined
    const inFlight = instanceB === undefined ? undefined : await markGroupSendInFlight(h.db, instanceB.id, NOW + 2)
    const stopped = await setGroupTaskStatus(h.db, 'qgt:t8', 1, 'revoked', NOW + 3, { reason: 'fixture-stop' })
    const instances = await listGroupSendInstances(h.db, 'qgt:t8')
    const readA = instances.find(row => row.id === instanceA?.id)
    const readB = instances.find(row => row.id === instanceB?.id)
    const report = stopped.ok ? stopped.stopReport : undefined
    checkMany('08', '停止：queued→failed_confirmed + TaskStopReport(stopSubsequent/canRevokeDelivered/inFlight)', [
      ...(instanceA !== undefined && instanceB !== undefined ? [] : ['夹具预留失败']),
      ...(inFlight?.ok === true ? [] : ['夹具进入 in_flight 失败']),
      ...(stopped.ok ? [] : [`停止失败=${stopped.ok ? '' : stopped.code}`]),
      ...(report?.stoppedSubsequent === true ? [] : ['stopSubsequent 不是 true']),
      ...(report?.canRevokeDelivered === false ? [] : ['canRevokeDelivered 不是 false']),
      ...(report?.inFlightRemaining === 1 ? [] : [`inFlightRemaining=${String(report?.inFlightRemaining)}`]),
      ...(report?.maybeDelivered === 0 ? [] : [`maybeDelivered=${String(report?.maybeDelivered)}`]),
      ...(readA?.state === 'failed_confirmed' ? [] : [`queued 实例最终态=${String(readA?.state)}`]),
      ...(readB?.state === 'in_flight' ? [] : [`in_flight 实例被擅自改判成=${String(readB?.state)}`]),
      ...(stopped.ok && stopped.invalidatedQueued === 1 ? [] : [`invalidatedQueued=${String(stopped.ok ? stopped.invalidatedQueued : NaN)}`]),
    ], `inFlight=${String(report?.inFlightRemaining)} maybeDelivered=${String(report?.maybeDelivered)}`)
    readings.stop = {
      report: report ?? null,
      queuedFinal: readA?.state ?? null,
      inFlightFinal: readB?.state ?? null,
    }
  }

  // -------------------------------------------------------------------------
  // 09 预留成功占用（+ 契约判定拒绝分支）
  // -------------------------------------------------------------------------
  {
    await createGroupTask(h.db, taskInput({
      id: 'qgt:t9', dedupeKey: 'owner_qq_private:evt-9',
      target: { botId: BOT, groupId: '8000007' },
      quota: { totalMaxMessages: 3, perInboundMaxMessages: 2, slot: null, minIntervalMs: 0 },
    }))
    const granted = await reserveGroupSend(h.db, {
      taskId: 'qgt:t9', now: NOW, target: { botId: BOT, groupId: '8000007' },
      plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'ok-1', textFingerprint: 'fp-ok-1',
    })
    const mediaDenied = await reserveGroupSend(h.db, {
      taskId: 'qgt:t9', now: NOW, target: { botId: BOT, groupId: '8000007' },
      plannedMessages: 1, plannedMedia: 'voice', inboundMessageId: 'ok-voice',
    })
    const targetDenied = await reserveGroupSend(h.db, {
      taskId: 'qgt:t9', now: NOW, target: { botId: BOT, groupId: '8999999' },
      plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'ok-2',
    })
    const events = await eventRows('qgt:t9')
    const instance = granted.kind === 'granted' ? granted.instance : undefined
    checkMany('09', '预留成功占用（queued 实例 + send_reserved 事件 + 媒介/目标拒绝）', [
      ...(instance !== undefined ? [] : ['预留被拒（应成功）']),
      ...(instance?.state === 'queued' ? [] : [`state=${String(instance?.state)}`]),
      ...(instance?.reservedMessages === 1 ? [] : [`reservedMessages=${String(instance?.reservedMessages)}`]),
      ...(instance?.taskVersion === 1 ? [] : [`taskVersion=${String(instance?.taskVersion)}`]),
      ...(instance?.settledAt === null ? [] : ['新占用的实例竟然已有 settledAt']),
      ...(instance?.textFingerprint === 'fp-ok-1' ? [] : [`textFingerprint=${String(instance?.textFingerprint)}`]),
      ...(instance?.target.groupId === '8000007' ? [] : ['实例 target 不是任务目标']),
      ...(events.some(row => String(row.event) === 'send_reserved') ? [] : ['没有 send_reserved 事件']),
      ...(mediaDenied.kind === 'denied' && mediaDenied.code === 'group_task_media_not_allowed'
        ? [] : [`媒介拒绝码=${mediaDenied.kind === 'denied' ? mediaDenied.code : '(granted)'}`]),
      ...(targetDenied.kind === 'denied' && targetDenied.code === 'group_task_target_mismatch'
        ? [] : [`目标拒绝码=${targetDenied.kind === 'denied' ? targetDenied.code : '(granted)'}`]),
    ], `state=${String(instance?.state)} reserved=${String(instance?.reservedMessages)}`)
    readings.reserve = { instanceState: instance?.state ?? null, mediaDenied: mediaDenied.kind === 'denied' ? mediaDenied.code : 'granted' }
  }

  // -------------------------------------------------------------------------
  // 10 **并发**抢最后一条额度（真 Promise.all：两个并发事务）
  // -------------------------------------------------------------------------
  {
    await createGroupTask(h.db, taskInput({
      id: 'qgt:t10', dedupeKey: 'owner_qq_private:evt-10',
      target: { botId: BOT, groupId: '8000008' },
      quota: { totalMaxMessages: 1, perInboundMaxMessages: 1, slot: null, minIntervalMs: 0 },
    }))
    const [left, right] = await Promise.all([
      reserveGroupSend(h.db, {
        taskId: 'qgt:t10', now: NOW, target: { botId: BOT, groupId: '8000008' },
        plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'race-1',
      }),
      reserveGroupSend(h.db, {
        taskId: 'qgt:t10', now: NOW, target: { botId: BOT, groupId: '8000008' },
        plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'race-2',
      }),
    ])
    const results = [left, right]
    const granted = results.filter(row => row.kind === 'granted').length
    const deniedCodes = results.filter(row => row.kind === 'denied').map(row => (row as { code: string }).code)
    const instanceCount = await exec(h.db, sql`select count(*)::int as n from qq_group_send_instances
      where task_id = 'qgt:t10'`, '统计并发预留结果实例数')
    checkMany('10', '并发抢最后一条额度：恰一个 granted、另一个 total_budget_exhausted', [
      ...(granted === 1 ? [] : [`granted=${granted}`]),
      ...(deniedCodes.length === 1 && deniedCodes[0] === 'group_task_total_budget_exhausted'
        ? [] : [`denied=${deniedCodes.join(',') || '(无)'}`]),
      ...(Number(instanceCount[0]?.n ?? 0) === 1 ? [] : [`实例数=${String(instanceCount[0]?.n)}`]),
    ], `granted=${granted} denied=${deniedCodes.join(',') || '(无)'} instances=${String(instanceCount[0]?.n)}`)
    readings.concurrency = { granted, deniedCodes, instances: Number(instanceCount[0]?.n ?? 0) }
  }

  // -------------------------------------------------------------------------
  // 11 per-inbound 额度
  // -------------------------------------------------------------------------
  {
    await createGroupTask(h.db, taskInput({
      id: 'qgt:t11', dedupeKey: 'owner_qq_private:evt-11',
      target: { botId: BOT, groupId: '8000010' },
      quota: { totalMaxMessages: 10, perInboundMaxMessages: 1, slot: null, minIntervalMs: 0 },
    }))
    const plannedTooMany = await reserveGroupSend(h.db, {
      taskId: 'qgt:t11', now: NOW, target: { botId: BOT, groupId: '8000010' },
      plannedMessages: 2, plannedMedia: 'text', inboundMessageId: 'in-1',
    })
    const first = await reserveGroupSend(h.db, {
      taskId: 'qgt:t11', now: NOW, target: { botId: BOT, groupId: '8000010' },
      plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'in-1',
    })
    const againSameInbound = await reserveGroupSend(h.db, {
      taskId: 'qgt:t11', now: NOW + 1, target: { botId: BOT, groupId: '8000010' },
      plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'in-1',
    })
    const differentInbound = await reserveGroupSend(h.db, {
      taskId: 'qgt:t11', now: NOW + 2, target: { botId: BOT, groupId: '8000010' },
      plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'in-2',
    })
    checkMany('11', 'per-inbound 额度（计划超限 / 同入站再占 / 换入站可占）', [
      ...(plannedTooMany.kind === 'denied' && plannedTooMany.code === 'group_task_planned_messages_invalid'
        ? [] : [`计划超限=${plannedTooMany.kind === 'denied' ? plannedTooMany.code : '(granted)'}`]),
      ...(first.kind === 'granted' ? [] : ['首次预留被拒']),
      ...(againSameInbound.kind === 'denied' && againSameInbound.code === 'group_task_per_inbound_exhausted'
        ? [] : [`同入站再占=${againSameInbound.kind === 'denied' ? againSameInbound.code : '(granted)'}`]),
      ...(differentInbound.kind === 'granted' ? [] : ['换入站被误拒']),
    ], `planned=${plannedTooMany.kind === 'denied' ? plannedTooMany.code : '(granted)'} sameInbound=${againSameInbound.kind === 'denied' ? againSameInbound.code : '(granted)'}`)
    readings.perInbound = {
      plannedTooMany: plannedTooMany.kind === 'denied' ? plannedTooMany.code : 'granted',
      sameInbound: againSameInbound.kind === 'denied' ? againSameInbound.code : 'granted',
      differentInbound: differentInbound.kind,
    }
  }

  // -------------------------------------------------------------------------
  // 12 slot 额度按窗口计算
  // -------------------------------------------------------------------------
  {
    await createGroupTask(h.db, taskInput({
      id: 'qgt:t12', dedupeKey: 'owner_qq_private:evt-12',
      target: { botId: BOT, groupId: '8000011' },
      quota: { totalMaxMessages: 10, perInboundMaxMessages: 2, slot: { windowMs: 60_000, maxMessages: 2 }, minIntervalMs: 0 },
    }))
    const inside = await reserveGroupSend(h.db, {
      taskId: 'qgt:t12', now: NOW, target: { botId: BOT, groupId: '8000011' },
      plannedMessages: 2, plannedMedia: 'text', inboundMessageId: 'slot-1',
    })
    const stillInside = await reserveGroupSend(h.db, {
      taskId: 'qgt:t12', now: NOW + 1000, target: { botId: BOT, groupId: '8000011' },
      plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'slot-2',
    })
    /* 恰好越过窗口（created_at=NOW 不在 [now-windowMs, now] 内）⇒ 应当放行 */
    const afterWindow = await reserveGroupSend(h.db, {
      taskId: 'qgt:t12', now: NOW + 60_001, target: { botId: BOT, groupId: '8000011' },
      plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'slot-3',
    })
    checkMany('12', 'slot 额度按窗口计算（窗口内拒、窗口外放）', [
      ...(inside.kind === 'granted' ? [] : ['窗口内首次占用被拒']),
      ...(stillInside.kind === 'denied' && stillInside.code === 'group_task_slot_budget_exhausted'
        ? [] : [`窗口内超额=${stillInside.kind === 'denied' ? stillInside.code : '(granted)'}`]),
      ...(afterWindow.kind === 'granted' ? [] : [`窗口外被误拒=${afterWindow.kind === 'denied' ? afterWindow.code : '(denied)'}`]),
    ], `inside=${inside.kind} stillInside=${stillInside.kind === 'denied' ? stillInside.code : 'granted'} afterWindow=${afterWindow.kind}`)
    readings.slot = {
      stillInside: stillInside.kind === 'denied' ? stillInside.code : 'granted',
      afterWindow: afterWindow.kind,
    }
  }

  // -------------------------------------------------------------------------
  // 13 minInterval
  // -------------------------------------------------------------------------
  {
    await createGroupTask(h.db, taskInput({
      id: 'qgt:t13', dedupeKey: 'owner_qq_private:evt-13',
      target: { botId: BOT, groupId: '8000012' },
      quota: { totalMaxMessages: 10, perInboundMaxMessages: 2, slot: null, minIntervalMs: 60_000 },
    }))
    const first = await reserveGroupSend(h.db, {
      taskId: 'qgt:t13', now: NOW, target: { botId: BOT, groupId: '8000012' },
      plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'mi-1',
    })
    const firstInstance = first.kind === 'granted' ? first.instance : undefined
    const settled = firstInstance === undefined ? undefined : await settleGroupSend(h.db, firstInstance.id, 'api_accepted', {
      platformMessageId: 'pm-mi-1', at: NOW,
    })
    const tooSoon = await reserveGroupSend(h.db, {
      taskId: 'qgt:t13', now: NOW + 1000, target: { botId: BOT, groupId: '8000012' },
      plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'mi-2',
    })
    const afterInterval = await reserveGroupSend(h.db, {
      taskId: 'qgt:t13', now: NOW + 60_000, target: { botId: BOT, groupId: '8000012' },
      plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'mi-3',
    })
    checkMany('13', 'minInterval 生效（间隔内拒、到点放）', [
      ...(firstInstance !== undefined ? [] : ['夹具预留失败']),
      ...(settled?.ok === true ? [] : ['夹具结算失败（last_send_at 没写进去）']),
      ...(tooSoon.kind === 'denied' && tooSoon.code === 'group_task_min_interval'
        ? [] : [`间隔内=${tooSoon.kind === 'denied' ? tooSoon.code : '(granted)'}`]),
      ...(afterInterval.kind === 'granted' ? [] : ['到点后仍被拒']),
    ], `tooSoon=${tooSoon.kind === 'denied' ? tooSoon.code : 'granted'} afterInterval=${afterInterval.kind}`)
    readings.minInterval = {
      tooSoon: tooSoon.kind === 'denied' ? tooSoon.code : 'granted',
      afterInterval: afterInterval.kind,
    }
  }

  // -------------------------------------------------------------------------
  // 14 api_accepted 增 used_messages + 幂等重报
  // -------------------------------------------------------------------------
  {
    await createGroupTask(h.db, taskInput({
      id: 'qgt:t14', dedupeKey: 'owner_qq_private:evt-14',
      target: { botId: BOT, groupId: '8000013' },
      quota: { totalMaxMessages: 5, perInboundMaxMessages: 2, slot: null, minIntervalMs: 0 },
    }))
    const reserved = await reserveGroupSend(h.db, {
      taskId: 'qgt:t14', now: NOW, target: { botId: BOT, groupId: '8000013' },
      plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'ac-1',
    })
    const instance = reserved.kind === 'granted' ? reserved.instance : undefined
    const missingId = instance === undefined ? undefined : await settleGroupSend(h.db, instance.id, 'api_accepted', { at: NOW + 1 })
    const accepted = instance === undefined ? undefined : await settleGroupSend(h.db, instance.id, 'api_accepted', {
      platformMessageId: 'pm-ac-1', at: NOW + 2,
    })
    const repeated = instance === undefined ? undefined : await settleGroupSend(h.db, instance.id, 'api_accepted', {
      platformMessageId: 'pm-ac-1', at: NOW + 3,
    })
    const read = await getGroupTask(h.db, 'qgt:t14')
    const settledEvents = (await eventRows('qgt:t14')).filter(row => String(row.event) === 'send_settled')
    checkMany('14', 'api_accepted 增 used_messages；重报幂等（不重复加账）', [
      ...(instance !== undefined ? [] : ['夹具预留失败']),
      ...(missingId?.ok === false && missingId.code === 'group_send_accepted_without_message_id'
        ? [] : ['没有平台消息 id 的 api_accepted 竟然被接受']),
      ...(accepted?.ok === true && accepted.usedMessagesAdded === 1 ? [] : [`首次结算 usedAdded=${String(accepted?.ok === true ? accepted.usedMessagesAdded : NaN)}`]),
      ...(accepted?.ok === true && accepted.instance.platformMessageId === 'pm-ac-1' ? [] : ['platformMessageId 没落库']),
      ...(accepted?.ok === true && accepted.instance.settledAt === NOW + 2 ? [] : [`settledAt=${String(accepted?.ok === true ? accepted.instance.settledAt : NaN)}`]),
      ...(repeated?.ok === true && repeated.alreadySettled === true ? [] : ['同结局重报不是幂等命中']),
      ...(repeated?.ok === true && repeated.usedMessagesAdded === 0 ? [] : ['重报又加了一次账']),
      ...(read?.usedMessages === 1 ? [] : [`usedMessages=${String(read?.usedMessages)}`]),
      ...(settledEvents.length === 1 ? [] : [`send_settled 事件数=${settledEvents.length}`]),
    ], `used=${String(read?.usedMessages)} alreadySettled=${String(repeated?.ok === true && repeated.alreadySettled)}`)
    readings.accepted = { usedMessages: read?.usedMessages ?? null, alreadySettled: repeated?.ok === true ? repeated.alreadySettled : null }
  }

  // -------------------------------------------------------------------------
  // 15 failed_confirmed **不退额**
  // -------------------------------------------------------------------------
  {
    await createGroupTask(h.db, taskInput({
      id: 'qgt:t15', dedupeKey: 'owner_qq_private:evt-15',
      target: { botId: BOT, groupId: '8000014' },
      quota: { totalMaxMessages: 1, perInboundMaxMessages: 1, slot: null, minIntervalMs: 0 },
    }))
    const reserved = await reserveGroupSend(h.db, {
      taskId: 'qgt:t15', now: NOW, target: { botId: BOT, groupId: '8000014' },
      plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'fail-1',
    })
    const instance = reserved.kind === 'granted' ? reserved.instance : undefined
    const failed = instance === undefined ? undefined : await settleGroupSend(h.db, instance.id, 'failed_confirmed', { at: NOW + 1 })
    const read = await getGroupTask(h.db, 'qgt:t15')
    const afterFail = await reserveGroupSend(h.db, {
      taskId: 'qgt:t15', now: NOW + 2, target: { botId: BOT, groupId: '8000014' },
      plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'fail-2',
    })
    checkMany('15', 'failed_confirmed 不退额（额度仍被消耗，再预留被拒）', [
      ...(instance !== undefined ? [] : ['夹具预留失败']),
      ...(failed?.ok === true && failed.usedMessagesAdded === 0 ? [] : ['明确失败竟然加了 used_messages']),
      ...(read?.usedMessages === 0 ? [] : [`usedMessages=${String(read?.usedMessages)}`]),
      ...(afterFail.kind === 'denied' && afterFail.code === 'group_task_total_budget_exhausted'
        ? [] : [`失败后再预留=${afterFail.kind === 'denied' ? afterFail.code : '(granted：退额了)'}`]),
    ], `used=${String(read?.usedMessages)} afterFail=${afterFail.kind === 'denied' ? afterFail.code : 'granted'}`)
    readings.failedNoRefund = {
      usedMessages: read?.usedMessages ?? null,
      afterFail: afterFail.kind === 'denied' ? afterFail.code : 'granted',
    }
  }

  // -------------------------------------------------------------------------
  // 16 unknown 增额度 + 暂停任务
  // -------------------------------------------------------------------------
  {
    await createGroupTask(h.db, taskInput({
      id: 'qgt:t16', dedupeKey: 'owner_qq_private:evt-16',
      target: { botId: BOT, groupId: '8000015' },
      quota: { totalMaxMessages: 3, perInboundMaxMessages: 1, slot: null, minIntervalMs: 0 },
    }))
    const reserved = await reserveGroupSend(h.db, {
      taskId: 'qgt:t16', now: NOW, target: { botId: BOT, groupId: '8000015' },
      plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'unk-1',
    })
    const instance = reserved.kind === 'granted' ? reserved.instance : undefined
    const unknown = instance === undefined ? undefined : await settleGroupSend(h.db, instance.id, 'unknown', {
      at: NOW + 5, detail: { reason: 'fixture-unknown' },
    })
    const read = await getGroupTask(h.db, 'qgt:t16')
    const blocked = await reserveGroupSend(h.db, {
      taskId: 'qgt:t16', now: NOW + 6, target: { botId: BOT, groupId: '8000015' },
      plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'unk-2',
    })
    const pauseEvents = (await eventRows('qgt:t16')).filter(row => String(row.event) === 'pause')
    checkMany('16', 'unknown 增额度并把任务暂停（之后预留被拒）', [
      ...(instance !== undefined ? [] : ['夹具预留失败']),
      ...(unknown?.ok === true && unknown.usedMessagesAdded === 1 ? [] : ['unknown 没有保守占用额度']),
      ...(unknown?.ok === true && unknown.paused === true ? [] : ['unknown 没有暂停任务']),
      ...(read?.status === 'paused' ? [] : [`status=${String(read?.status)}`]),
      ...(read?.usedMessages === 1 ? [] : [`usedMessages=${String(read?.usedMessages)}`]),
      ...(blocked.kind === 'denied' && blocked.code === 'group_task_not_active'
        ? [] : [`暂停后预留=${blocked.kind === 'denied' ? blocked.code : '(granted)'}`]),
      ...(pauseEvents.length === 1 ? [] : [`pause 事件数=${pauseEvents.length}`]),
    ], `status=${String(read?.status)} used=${String(read?.usedMessages)} blocked=${blocked.kind === 'denied' ? blocked.code : 'granted'}`)
    readings.unknown = { status: read?.status ?? null, usedMessages: read?.usedMessages ?? null }
  }

  // -------------------------------------------------------------------------
  // 17 重启恢复（in_flight→unknown / queued→failed_confirmed，不重播）
  // -------------------------------------------------------------------------
  {
    /* 先把前面检查留下的未结算实例**按真实路径**结清，让本项读数是精确的 */
    for (const open of await openInstanceIds()) {
      await settleGroupSend(h.db, open.id, open.state === 'in_flight' ? 'unknown' : 'failed_confirmed',
        { at: NOW + 9_000, detail: { code: 'gate_cleanup_before_restart_check' } })
    }
    const leftover = await openInstanceIds()
    const eventsBefore = await countEvents()
    const instancesBefore = await exec(h.db, sql`select count(*)::int as n from qq_group_send_instances
      where task_id = 'qgt:t17'`, '统计重启前 t17 实例数')

    await createGroupTask(h.db, taskInput({
      id: 'qgt:t17', dedupeKey: 'owner_qq_private:evt-17',
      target: { botId: BOT, groupId: '8000016' },
      quota: { totalMaxMessages: 5, perInboundMaxMessages: 2, slot: null, minIntervalMs: 0 },
    }))
    const reservedA = await reserveGroupSend(h.db, {
      taskId: 'qgt:t17', now: NOW, target: { botId: BOT, groupId: '8000016' },
      plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'restart-queued',
    })
    const reservedB = await reserveGroupSend(h.db, {
      taskId: 'qgt:t17', now: NOW + 1, target: { botId: BOT, groupId: '8000016' },
      plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'restart-inflight',
    })
    const instanceA = reservedA.kind === 'granted' ? reservedA.instance : undefined
    const instanceB = reservedB.kind === 'granted' ? reservedB.instance : undefined

    const firstFlight = instanceB === undefined ? undefined : await markGroupSendInFlight(h.db, instanceB.id, NOW + 2)
    const repeatFlight = instanceB === undefined ? undefined : await markGroupSendInFlight(h.db, instanceB.id, NOW + 3)
    const report = await recoverGroupSendStateOnRestart(h.db, NOW + 10_000)
    const afterA = (await listGroupSendInstances(h.db, 'qgt:t17')).find(row => row.id === instanceA?.id)
    const afterB = (await listGroupSendInstances(h.db, 'qgt:t17')).find(row => row.id === instanceB?.id)
    const read = await getGroupTask(h.db, 'qgt:t17')
    const stillOpen = await openInstanceIds()
    const instancesAfter = await exec(h.db, sql`select count(*)::int as n from qq_group_send_instances
      where task_id = 'qgt:t17'`, '统计重启后 t17 实例数')
    const acceptedRows = await exec(h.db, sql`select count(*)::int as n from qq_group_send_instances
      where task_id = 'qgt:t17' and state = 'api_accepted'`, '统计 t17 已接受实例')
    const eventsAfter = await countEvents()

    checkMany('17', '重启恢复 in_flight→unknown / queued→failed_confirmed 且不重播（含 in_flight 写口）', [
      ...(leftover.length === 0 ? [] : [`夹具清理后仍有未结算实例=${leftover.length}`]),
      ...(instanceA !== undefined && instanceB !== undefined ? [] : ['夹具预留失败']),
      ...(firstFlight?.ok === true ? [] : ['queued→in_flight 失败']),
      ...(repeatFlight?.ok === false && repeatFlight.code === 'group_send_already_in_flight'
        ? [] : ['重复调用 in_flight 写口不是幂等 false']),
      ...(report.inFlightToUnknown === 1 ? [] : [`inFlightToUnknown=${report.inFlightToUnknown}`]),
      ...(report.queuedToFailedConfirmed === 1 ? [] : [`queuedToFailedConfirmed=${report.queuedToFailedConfirmed}`]),
      ...(report.tasksTouched === 1 ? [] : [`tasksTouched=${report.tasksTouched}`]),
      ...(report.tasksPaused === 1 ? [] : [`tasksPaused=${report.tasksPaused}`]),
      ...(report.usedMessagesAdded === 1 ? [] : [`usedMessagesAdded=${report.usedMessagesAdded}`]),
      ...(report.replayed === 0 ? [] : ['报告说重播了']),
      ...(afterA?.state === 'failed_confirmed' ? [] : [`queued 恢复成=${String(afterA?.state)}`]),
      ...(afterB?.state === 'unknown' ? [] : [`in_flight 恢复成=${String(afterB?.state)}`]),
      ...(afterB?.settledAt === NOW + 10_000 ? [] : [`unknown.settledAt=${String(afterB?.settledAt)}`]),
      ...(read?.status === 'paused' ? [] : [`任务状态=${String(read?.status)}`]),
      ...(read?.usedMessages === 1 ? [] : [`usedMessages=${String(read?.usedMessages)}`]),
      ...(read?.lastSendAt === NOW + 10_000 ? [] : [`lastSendAt=${String(read?.lastSendAt)}`]),
      ...(stillOpen.length === 0 ? [] : [`恢复后仍有未结算实例=${stillOpen.length}`]),
      ...(Number(instancesAfter[0]?.n ?? 0) === Number(instancesBefore[0]?.n ?? 0) + 2
        ? [] : [`实例数 before=${String(instancesBefore[0]?.n)} after=${String(instancesAfter[0]?.n)}`]),
      ...(Number(acceptedRows[0]?.n ?? 0) === 0 ? [] : ['恢复把实例标成了 api_accepted']),
      ...(eventsAfter > eventsBefore ? [] : ['恢复没有留下任何事件（append-only 断裂）']),
    ], `inFlight→unknown=${report.inFlightToUnknown} queued→failed=${report.queuedToFailedConfirmed} paused=${report.tasksPaused} replayed=${report.replayed}`)
    readings.restart = {
      report,
      queuedFinal: afterA?.state ?? null,
      inFlightFinal: afterB?.state ?? null,
      taskStatus: read?.status ?? null,
      openAfter: stillOpen.length,
    }
  }

  // -------------------------------------------------------------------------
  // 18 append-only + 事件闭集（DDL 逐项列全；闭集外被拒；无 update/delete 路径）
  // -------------------------------------------------------------------------
  {
    const before = await countEvents()
    await modifyGroupTask(h.db, 'qgt:t6', 3, { minIntervalMs: 30_000 }, NOW + 20_000)
    const after = await countEvents()
    const distinct = await exec(h.db, sql`select distinct event from qq_group_task_events order by event`,
      '读取出现过的事件名')
    const observed = distinct.map(row => String(row.event))
    const unknownNames = observed.filter(name => !GROUP_TASK_EVENT_NAMES.includes(name as never))
    const vocabRows = await exec(h.db, sql`select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'qq_group_task_events'::regclass and contype = 'c'`, '读取事件表 check 约束')
    const vocabDef = vocabRows.map(row => String(row.def ?? '')).find(def => def.includes('send_reserved')) ?? ''
    const missingInDdl = GROUP_TASK_EVENT_NAMES.filter(name => !vocabDef.includes(`'${name}'`))
    const bogusEvent = await rejection(() => exec(h.db, sql`insert into qq_group_task_events
      (event_id, task_id, version, event, detail, at)
      values ('qgte:bogus', 'qgt:t1', 1, ${'send_never_declared'}, '{}'::jsonb, 1)`,
    '写一条闭集外事件（DDL 必须拒）'))
    const storeSource = readFileSync(
      resolve('src/infrastructure/persistence/qq-group-task-store.ts'), 'utf8')
    const insertSites = storeSource.match(/insert into qq_group_task_events/gi) ?? []
    const updateSites = storeSource.match(/update\s+qq_group_task_events/gi) ?? []
    const deleteSites = storeSource.match(/delete\s+from\s+qq_group_task_events/gi) ?? []
    checkMany('18', 'append-only + 事件闭集（DDL 列出 10 个名字 / 闭集外被拒 / 无 update-delete 路径）', [
      ...(after > before ? [] : [`事件数没有只增不减：before=${before} after=${after}`]),
      ...(unknownNames.length === 0 ? [] : [`出现闭集外事件名=${unknownNames.join(',')}`]),
      ...(GROUP_TASK_EVENT_NAMES.length === 10 ? [] : [`GROUP_TASK_EVENT_NAMES=${GROUP_TASK_EVENT_NAMES.length}`]),
      ...(missingInDdl.length === 0 ? [] : [`DDL check 缺事件名=${missingInDdl.join(',')}`]),
      ...(bogusEvent.failed && bogusEvent.isKernel ? [] : ['DDL 没有拒绝闭集外事件名']),
      ...(insertSites.length === 1 ? [] : [`事件 INSERT 站点=${insertSites.length}（应恰好 1 处）`]),
      ...(updateSites.length === 0 ? [] : ['store 里有 update qq_group_task_events']),
      ...(deleteSites.length === 0 ? [] : ['store 里有 delete from qq_group_task_events']),
    ], `events=${before}→${after} observed=${observed.length} insertSites=${insertSites.length}`)
    readings.eventLog = {
      eventsBefore: before, eventsAfter: after, observed, missingInDdl,
      insertSites: insertSites.length, updateSites: updateSites.length, deleteSites: deleteSites.length,
      bogusRejected: bogusEvent.failed,
    }
  }

  // -------------------------------------------------------------------------
  // 19 到额度上限后任务转 exhausted + 后续预留被拒
  // -------------------------------------------------------------------------
  {
    /* 自动路径：结算 api_accepted 时 used >= total ⇒ 任务置 exhausted */
    await createGroupTask(h.db, taskInput({
      id: 'qgt:t19', dedupeKey: 'owner_qq_private:evt-19',
      target: { botId: BOT, groupId: '8000017' },
      quota: { totalMaxMessages: 1, perInboundMaxMessages: 1, slot: null, minIntervalMs: 0 },
    }))
    const reserved = await reserveGroupSend(h.db, {
      taskId: 'qgt:t19', now: NOW, target: { botId: BOT, groupId: '8000017' },
      plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'ex-1',
    })
    const instance = reserved.kind === 'granted' ? reserved.instance : undefined
    const settled = instance === undefined ? undefined : await settleGroupSend(h.db, instance.id, 'api_accepted', {
      platformMessageId: 'pm-ex-1', at: NOW + 1,
    })
    const autoRead = await getGroupTask(h.db, 'qgt:t19')
    const afterExhausted = await reserveGroupSend(h.db, {
      taskId: 'qgt:t19', now: NOW + 2, target: { botId: BOT, groupId: '8000017' },
      plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'ex-2',
    })
    /* 显式路径：active 任务直接迁 exhausted 也合法，之后预留同样被拒 */
    await createGroupTask(h.db, taskInput({
      id: 'qgt:t19b', dedupeKey: 'owner_qq_private:evt-19b',
      target: { botId: BOT, groupId: '8000018' },
    }))
    const explicit = await setGroupTaskStatus(h.db, 'qgt:t19b', 1, 'exhausted', NOW + 3)
    const afterExplicit = await reserveGroupSend(h.db, {
      taskId: 'qgt:t19b', now: NOW + 4, target: { botId: BOT, groupId: '8000018' },
      plannedMessages: 1, plannedMedia: 'text', inboundMessageId: 'ex-3',
    })
    checkMany('19', '到额度上限后任务转 exhausted（自动 + 显式）且后续预留被拒', [
      ...(instance !== undefined ? [] : ['夹具预留失败']),
      ...(settled?.ok === true && settled.exhausted === true ? [] : ['结算没有把任务标成 exhausted']),
      ...(autoRead?.status === 'exhausted' ? [] : [`自动路径 status=${String(autoRead?.status)}`]),
      ...(afterExhausted.kind === 'denied' && afterExhausted.code === 'group_task_terminal'
        ? [] : [`耗尽的预留=${afterExhausted.kind === 'denied' ? afterExhausted.code : '(granted)'}`]),
      ...(explicit.ok === true ? [] : [`显式迁移失败=${explicit.ok ? '' : explicit.code}`]),
      ...(afterExplicit.kind === 'denied' && afterExplicit.code === 'group_task_terminal'
        ? [] : [`显式耗尽后预留=${afterExplicit.kind === 'denied' ? afterExplicit.code : '(granted)'}`]),
    ], `auto=${String(autoRead?.status)} reserve=${afterExhausted.kind === 'denied' ? afterExhausted.code : 'granted'}`)
    readings.exhausted = {
      autoStatus: autoRead?.status ?? null,
      explicit: explicit.ok,
      reserveCode: afterExhausted.kind === 'denied' ? afterExhausted.code : 'granted',
    }
  }

  // -------------------------------------------------------------------------
  // 20 坏行 / 坏 jsonb：抛具名错，不回退默认值
  // -------------------------------------------------------------------------
  {
    await createGroupTask(h.db, taskInput({
      id: 'qgt:t20', dedupeKey: 'owner_qq_private:evt-20', kind: 'send_once',
      target: { botId: BOT, groupId: '8000019' },
    }))
    /* ① 契约版本不符 */
    await exec(h.db, sql`insert into qq_group_tasks
      (id, contract_version, version, status, kind, bot_id, group_id, content, media, text_fallback,
       trigger, term, quota, used_messages, last_send_at, auth_source, dedupe_key, created_at, updated_at)
      values ('qgt:bad-contract', 99, 1, 'active', 'send_once', ${BOT}, '8000098', '{}'::jsonb, 'text', false,
              '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, null, 'owner_qq_private', 'bad-contract', 1, 1)`,
    '插入一条契约版本不符的行')
    const versionMismatch = await rejection(() => getGroupTask(h.db, 'qgt:bad-contract'))
    /* ② 坏 jsonb（闭集外的 content.mode） */
    await exec(h.db, sql`update qq_group_tasks
      set content = '{"mode":"telepathy","text":null,"brief":null}'::jsonb where id = 'qgt:t20'`,
    '把任务正文改成闭集外模式')
    const badJson = await rejection(() => getGroupTask(h.db, 'qgt:t20'))
    const badJsonInList = await rejection(() => listGroupTasks(h.db, { kind: 'send_once' }))
    /* ③ 坏 jsonb（trigger 不是对象） */
    await exec(h.db, sql`update qq_group_tasks set trigger = '"not-an-object"'::jsonb where id = 'qgt:t20'`,
      '把任务触发条件改成非对象')
    const badTrigger = await rejection(() => getGroupTask(h.db, 'qgt:t20'))
    checkMany('20', '坏行/坏 jsonb 读回抛具名 KernelError（不回退默认值）', [
      ...(versionMismatch.failed && versionMismatch.isKernel ? [] : ['契约版本不符没有抛错']),
      ...(versionMismatch.code === 'group_task_contract_version_mismatch'
        ? [] : [`契约版本码=${versionMismatch.code || versionMismatch.message}`]),
      ...(badJson.failed && badJson.code === 'group_task_row_invalid'
        ? [] : [`坏 jsonb 码=${badJson.code || badJson.message}`]),
      ...(badJsonInList.failed && badJsonInList.code === 'group_task_row_invalid'
        ? [] : [`列表读到坏行没抛错=${badJsonInList.code || badJsonInList.message}`]),
      ...(badTrigger.failed && badTrigger.code === 'group_task_row_invalid'
        ? [] : [`坏 trigger 码=${badTrigger.code || badTrigger.message}`]),
    ], `version=${versionMismatch.code} jsonb=${badJson.code} trigger=${badTrigger.code}`)
    readings.badRows = {
      contractVersion: versionMismatch.code || versionMismatch.message,
      contentJsonb: badJson.code || badJson.message,
      triggerJsonb: badTrigger.code || badTrigger.message,
      listPath: badJsonInList.code || badJsonInList.message,
    }
  }
  // -------------------------------------------------------------------------
  // 21–23 **发送前复核**的额度读数（`readSendOccupancyForRecheck`）
  //
  //  为什么要这三条：装配层的发送前复核必须回答"把这一条也算上之后还超不超额度"。
  //  用 `used_messages`（只累计 api_accepted/unknown）会把**在途/已明确失败**的其它
  //  实例漏掉；用"全部实例求和"又把自己算两遍。三个读数分别把这两件事钉住。
  // -------------------------------------------------------------------------
  {
    await createGroupTask(h.db, taskInput({
      id: 'qgt:t21', dedupeKey: 'owner_qq_private:evt-21',
      target: { botId: BOT, groupId: '8000021' },
      quota: { totalMaxMessages: 10, perInboundMaxMessages: 3, slot: null, minIntervalMs: 0 },
    }))
    await exec(h.db, sql`insert into qq_group_send_instances
      (id, task_id, task_version, state, reserved_messages, media, group_id, bot_id,
       inbound_message_id, text_fingerprint, platform_message_id, created_at, settled_at)
      values
        ('qgsi:t21-own', 'qgt:t21', 1, 'in_flight', 1, 'text', '8000021', ${BOT}, null, null, null, ${NOW}, null),
        ('qgsi:t21-other1', 'qgt:t21', 1, 'in_flight', 3, 'text', '8000021', ${BOT}, null, null, null, ${NOW}, null),
        ('qgsi:t21-other2', 'qgt:t21', 1, 'failed_confirmed', 2, 'text', '8000021', ${BOT}, null, null, null, ${NOW}, ${NOW})`,
    '插入 21 的实例账本（自己 1 + 在途 3 + 已明确失败 2）')
    const task21 = await getGroupTask(h.db, 'qgt:t21')
    const occupancy21 = task21 === undefined ? undefined
      : await readSendOccupancyForRecheck(h.db, { task: task21, instanceId: 'qgsi:t21-own', now: NOW })
    checkMany('21', '发送前复核读数：**剔除自己**、其它实例（含在途/已明确失败）照常计入', [
      ...(occupancy21?.ok === true ? [] : [`读数失败=${occupancy21?.ok === false ? occupancy21.code : '(缺任务)'}`]),
      ...(occupancy21?.ok === true && occupancy21.occupancy.totalMessages === 5
        ? [] : [`totalMessages=${String(occupancy21?.ok === true ? occupancy21.occupancy.totalMessages : '?')}（应 5）`]),
      ...(occupancy21?.ok === true && occupancy21.occupancy.current.id === 'qgsi:t21-own'
        ? [] : ['current 不是自己那条']),
      ...(occupancy21?.ok === true && occupancy21.occupancy.current.reservedMessages === 1
        ? [] : ['自己那条的 reservedMessages 不是 1']),
      ...(occupancy21?.ok === true && occupancy21.occupancy.slotMessages === 0
        ? [] : ['无 slot 时 slotMessages 应为 0']),
      ...(occupancy21?.ok === true && occupancy21.occupancy.perInboundMessages === 0
        ? [] : ['自己不是回复某条入站时 perInboundMessages 应为 0']),
    ], `total=${String(occupancy21?.ok === true ? occupancy21.occupancy.totalMessages : '?')}`
      + ` current=${String(occupancy21?.ok === true ? occupancy21.occupancy.current.id : '?')}`)
    readings.recheckExcludeSelf = occupancy21?.ok === true
      ? { totalMessages: occupancy21.occupancy.totalMessages,
        currentReserved: occupancy21.occupancy.current.reservedMessages }
      : { error: occupancy21?.ok === false ? occupancy21.code : 'task_missing' }

    await createGroupTask(h.db, taskInput({
      id: 'qgt:t22', dedupeKey: 'owner_qq_private:evt-22',
      target: { botId: BOT, groupId: '8000022' },
      quota: { totalMaxMessages: 10, perInboundMaxMessages: 3, slot: null, minIntervalMs: 0 },
    }))
    await exec(h.db, sql`insert into qq_group_send_instances
      (id, task_id, task_version, state, reserved_messages, media, group_id, bot_id,
       inbound_message_id, text_fingerprint, platform_message_id, created_at, settled_at)
      values
        ('qgsi:t22-own', 'qgt:t22', 1, 'in_flight', 1, 'text', '8000022', ${BOT}, 'in-x', null, null, ${NOW}, null),
        ('qgsi:t22-same', 'qgt:t22', 1, 'failed_confirmed', 2, 'text', '8000022', ${BOT}, 'in-x', null, null, ${NOW}, ${NOW}),
        ('qgsi:t22-other', 'qgt:t22', 1, 'in_flight', 1, 'text', '8000022', ${BOT}, 'in-y', null, null, ${NOW}, null)`,
    '插入 22 的实例账本（同入站 2 + 换入站 1）')
    const task22 = await getGroupTask(h.db, 'qgt:t22')
    const occupancy22 = task22 === undefined ? undefined
      : await readSendOccupancyForRecheck(h.db, { task: task22, instanceId: 'qgsi:t22-own', now: NOW })
    checkMany('22', '发送前复核读数：per-inbound 只算**同一条入站**的其它实例', [
      ...(occupancy22?.ok === true ? [] : ['读数失败']),
      ...(occupancy22?.ok === true && occupancy22.occupancy.totalMessages === 3
        ? [] : [`totalMessages=${String(occupancy22?.ok === true ? occupancy22.occupancy.totalMessages : '?')}（应 3）`]),
      ...(occupancy22?.ok === true && occupancy22.occupancy.perInboundMessages === 2
        ? [] : [`perInboundMessages=${String(occupancy22?.ok === true ? occupancy22.occupancy.perInboundMessages : '?')}（应 2）`]),
    ], `total=${String(occupancy22?.ok === true ? occupancy22.occupancy.totalMessages : '?')}`
      + ` perInbound=${String(occupancy22?.ok === true ? occupancy22.occupancy.perInboundMessages : '?')}`)
    readings.recheckPerInbound = occupancy22?.ok === true
      ? { totalMessages: occupancy22.occupancy.totalMessages,
        perInboundMessages: occupancy22.occupancy.perInboundMessages }
      : { error: 'read_failed' }

    await createGroupTask(h.db, taskInput({
      id: 'qgt:t23', dedupeKey: 'owner_qq_private:evt-23',
      target: { botId: BOT, groupId: '8000023' },
      quota: { totalMaxMessages: 10, perInboundMaxMessages: 2, slot: { windowMs: 60_000, maxMessages: 2 }, minIntervalMs: 0 },
    }))
    await exec(h.db, sql`insert into qq_group_send_instances
      (id, task_id, task_version, state, reserved_messages, media, group_id, bot_id,
       inbound_message_id, text_fingerprint, platform_message_id, created_at, settled_at)
      values
        ('qgsi:t23-own', 'qgt:t23', 1, 'in_flight', 1, 'text', '8000023', ${BOT}, null, null, null, ${NOW}, null),
        ('qgsi:t23-inside', 'qgt:t23', 1, 'in_flight', 1, 'text', '8000023', ${BOT}, null, null, null, ${NOW - 1_000}, null),
        ('qgsi:t23-outside', 'qgt:t23', 1, 'in_flight', 2, 'text', '8000023', ${BOT}, null, null, null, ${NOW - 120_000}, null)`,
    '插入 23 的实例账本（窗口内 1 + 窗口外 2）')
    const task23 = await getGroupTask(h.db, 'qgt:t23')
    const occupancy23 = task23 === undefined ? undefined
      : await readSendOccupancyForRecheck(h.db, { task: task23, instanceId: 'qgsi:t23-own', now: NOW })
    const missingInstance = task23 === undefined ? undefined
      : await readSendOccupancyForRecheck(h.db, { task: task23, instanceId: 'qgsi:t23-nope', now: NOW })
    checkMany('23', '发送前复核读数：slot 只算窗口内的其它实例 · 找不到自己 ⇒ 失败关闭', [
      ...(occupancy23?.ok === true ? [] : ['读数失败']),
      ...(occupancy23?.ok === true && occupancy23.occupancy.totalMessages === 3
        ? [] : [`totalMessages=${String(occupancy23?.ok === true ? occupancy23.occupancy.totalMessages : '?')}（应 3）`]),
      ...(occupancy23?.ok === true && occupancy23.occupancy.slotMessages === 1
        ? [] : [`slotMessages=${String(occupancy23?.ok === true ? occupancy23.occupancy.slotMessages : '?')}（应 1）`]),
      ...(missingInstance?.ok === false && missingInstance.code === 'group_send_instance_not_found'
        ? [] : ['找不到自己时没有失败关闭']),
    ], `total=${String(occupancy23?.ok === true ? occupancy23.occupancy.totalMessages : '?')}`
      + ` slot=${String(occupancy23?.ok === true ? occupancy23.occupancy.slotMessages : '?')}`
      + ` missing=${String(missingInstance?.ok === false ? missingInstance.code : '(未拒)')}`)
    readings.recheckSlot = occupancy23?.ok === true
      ? { totalMessages: occupancy23.occupancy.totalMessages, slotMessages: occupancy23.occupancy.slotMessages }
      : { error: 'read_failed' }
  }
} catch (error) {
  console.error(error)
  checkMany('99', '门体执行无未预期异常', [error instanceof Error ? `${error.name}: ${error.message}` : String(error)])
} finally {
  try {
    await h.stop()
  } catch (error) {
    console.error('harness stop failed:', error)
  }
  cleanupSandbox(sandbox.dir)
  await resetPluginSqlConnection()
}

// ---------------------------------------------------------------------------
// 读数（一行 JSON，供批记录直接摘）
// ---------------------------------------------------------------------------
const passed = checks.filter(row => row.pass).length
const failed = checks.length - passed
const summary = {
  gate: 'postlv2:qq-group-task-store:verify',
  script: 'scripts/postlv2-qq-group-task-store-verify.ts',
  ranAt: new Date().toISOString(),
  /** **实测**：`select current_database()` 读回的隔离库名 */
  database: connectedDatabase,
  backend: sandbox.backend,
  isolation: 'one-shot lg_test_* database via runPreparedPgGate (pgvector container)',
  passed,
  failed,
  checks,
  readings,
}
console.log(JSON.stringify(summary))
process.exitCode = failed === 0 && checks.length > 0 ? 0 : 1
