/**
 * post-Lv2 / **QQ 群任务 P2.1-D — 组合验收门**（真实 main + 桥 + 假 OneBot + 假模型 + 隔离 PG）。
 *
 * ============================================================================
 *  这道门回答什么问题（以及**不**回答什么）
 * ============================================================================
 * ```text
 * 真 main（`src/main.ts`，`--coexist`：一个核心 + 一条 QQ 入口）段：
 *   01 开关缺省关：不设 `CHARACTER_QQ_GROUP_TASKS_ENABLED` ⇒ 群任务链**未装配**
 *      （假 OneBot 侧 `get_group_list` / `send_group_msg` 各 0 次 · 任务表 0 行 ·
 *        已授予权限里没有 `qq:group_send`），且普通 QQ 私聊回复照常
 *   02 开起来 + 建单 + 真发送：主人私聊 ⇒ 群列表 ⇒ 建单 ⇒ Gateway ⇒ 假 OneBot
 *      收到 `send_group_msg`（群号/正文逐字）⇒ 实例 `api_accepted` + `platform_message_id`
 *      ⇒ 主人私聊事实里**只有否定句**说"平台接受 ≠ 群成员看到"
 *   03 群名消歧（同名两群）：模型澄清 ⇒ 0 条发送 · 任务表 0 行
 *      （+ 程序侧群号解析的两种拒法：列表里没有 ⇒ `group_task_group_not_found`；
 *        群号与群名矛盾 ⇒ `group_hint_conflict`；两者都 0 条发送）
 *   04 旧名单拒绝而任务可达：`isAllowedUser(owner, A群) === false`，但 02 那条**真的发出去了**
 *   09 旧 QQ 回归：同一次真 main 里普通私聊/群聊默认回复仍工作，且不建群任务
 *   10 重启恢复：进程重启后 `in_flight`⇒`unknown`、`queued`⇒`failed_confirmed`，**不重播**
 *
 * in-process 段（**不是** real main；真 store + 隔离 PG + 真 `OneBotPrivateClient` + 假 OneBot）：
 *   05–08 **第二道复核**：runtime 的 `execute` 端口里**先改库**（撤销 / 升版本 / 改 endAt /
 *      耗尽额度）再调 `deliverGroupTaskMessage` ⇒ 客户端 `groupTaskAuthorizer` 向持久层
 *      复核 ⇒ 0 条发送，并读到具名拒绝码。
 * ```
 *
 * ============================================================================
 *  P3-G 段（CONTRACT §4/§5：接管轮计入额度 + 跨进程派发/回执/结算）
 * ============================================================================
 * ```text
 * 21 额度有效 · 顺序两条入站：只发 1 条；第二条被**准入门**拒（任务已 exhausted）
 *    —— ⚠️ 与契约 §5 的写法不同：契约预期路由层 `no_reply+group_task_total_budget_exhausted`，
 *    实测结算在 `used==total` 时就把任务置终态 `exhausted` ⇒ 第二条连路由都不参与
 *    ⇒ 准入 denied（`qq_group_not_authorized`）。如实读，不按契约想象（已报 Lead）
 * 23 额度有效 · **派发层**：账本里已有在途预留占满额度、used_messages 还是 0
 *    ⇒ route 放行、reserveGroupSend 拒绝 ⇒ not_attempted ⇒ failed_confirmed + 具名额度码 · 0 条
 * 24 结算 · api_accepted：实例 api_accepted + platform_message_id；额度记 1 条
 * 25 结算 · failed_confirmed：假平台明确拒 ⇒ 实例 failed_confirmed、不占额度、不重试
 * 26 结算 · delivery_unknown：接受但无回执 id ⇒ 实例 unknown + 任务 paused；**不重发/不切侧信道**
 * 27 没有双发：真外壳接管轮恰好 1 条 send_group_msg；TURN_RESULT **无 replyText 键**、
 *    带 groupTaskDispatch；外壳不记 lg_turn_failed、不发第二条（含失败提示）
 * 28 计数 · 引用不加条数：引用段与正文**同一条消息**；实例 reserved_messages 仍是 1
 * 29 计数 · 语音+来源附录：reserved_messages=2；正文与附录**各自一条**；预留 ≥ 实际外发
 * 30 协议负控 · expiresAt 已过 ⇒ 0 条 + group_task_dispatch_expired
 * 31 协议负控 · 同一 deliveryKey 重复派发 ⇒ 仍只发 1 条、第二次原样返回首次结局
 * 32 协议负控 · 外壳不回执 ⇒ 注入 300ms 超时 ⇒ delivery_unknown + 假 OneBot 计数不增
 *
 * 真 main 覆盖 21/23–28（真 `src/main.ts` + 真外壳 + 假 OneBot）；
 * 22/29–32 在门进程内（理由：桥/外壳都把轮次**串行化**，并发只能压到账本那一层；
 *   超时上限只有 `TurnBridge` 构造参数这一个注入点）。
 * ```
 *
 * ============================================================================
 *  P3-H 段（`artifacts/local/qq-group-p3h/CONTRACT.md` §4 的三组验收）
 * ============================================================================
 * ```text
 * 用户裁定（2026-10-29，本批唯一授权来源）：
 *   「下一批先补"每条入站额度生效＋耗尽后无噪声退出"，暂缓连接收敛和语音扩展。」
 *   「旧断言若与修正后的需求冲突，应同步更新，不能为了保持'逐字不动'留下已知错误。」
 *
 * A 每条入站额度（H1：可信入站关联 ⇒ perInboundMaxMessages 真正生效）
 *   33 真链路 · 直接证据：接管轮实例上 `inbound_message_id` **非空**、形状是
 *      `qq:<bot>:group:<群>:<消息号>`（**完整 requestId**，不是裸 message_id）且**逐字等于**
 *      这一条入站的 requestId；同一任务第二条入站**独立计数**（各自一条，不是 1 条）
 *   34 派发层 · 同一入站第二条被拒：`group_task_per_inbound_exhausted` + 0 条发送
 *      + 反例断言"这次拒的不是总额度码"（总额度还很宽）⇒ 拒因只能是 per-inbound
 *   35 计数形态 · 语音+附录=2 **占同一条入站的额度**：再要一条 ⇒ per-inbound 拒
 *   40 派生出处的**纯函数负控**：形状 / bot / 群 / 位数 / transport 任一不符 ⇒ 不派生
 *      （13 条负例；含"裸 message_id 不认"与"跨群同号不撞"）
 *   42 默认 `perInboundMaxMessages=1` 时"语音+附录=2"**发不出去**
 *      （拒因 `group_task_planned_messages_invalid`）—— 判据正确，但**用户可见后果**是
 *      "整条回复消失"而不是"退化成纯文字" ⇒ 钉住，交由裁定（门不绕过、不放行）
 *
 * B 耗尽后无噪声退出（H2：任务结束后恢复默认路线，不许因历史任务永久抑制该群）
 *   36 名单外群：总额度耗尽后 ⇒ 0 条发送 · 0 次模型调用 · **0 条失败提示**
 *      · **不记 `lg_turn_failed`** · 一条 `qq_no_reply`（具名 `qq_group_not_authorized`）
 *   37 名单内群：同一耗尽状态 ⇒ **恢复默认规则**，正常回一条（默认路线，不带接管段）
 *   41 "没有生效任务"含**已过期**：一条到期但状态仍 active 的任务不许长期挡门
 *      （名单内群 ⇒ 回落默认路线并正常回一条；反例：**还没开始**的任务仍抑制）
 *
 * C 并发不串
 *   38 真链路：两条入站背靠背（不同发送者）⇒ 各自实例记各自的 requestId、
 *      各自引用**自己**那条入站的 `message_id`（引用段逐条核 `{type:'reply',data:{id}}`）
 *   39 派发层并发：两条**同时**预留（不同入站键）⇒ 都不串（各自实例键、各自额度计数）
 *
 * ⚠️ 本批同时**更正**了两条与新需求冲突的旧断言（写在门里，不是悄悄放松）：
 *    · 第 15 项（P3-B 负控）：原来只验"核心给了 `qq_group_not_authorized`"（**failed 也算过**）。
 *      新语义下这一支仍被拒，但必须**静默** ⇒ 加判据：桥侧 `no_reply` + 外壳只记
 *      `qq_no_reply` + **不记** `lg_turn_failed` + 0 条发送（含失败提示）。
 *    · 第 21 项（P3-G 顺序额度）：原来断言第二条 `outcome=failed`。
 *      新语义下 `qq_group_not_authorized` 进 `BRIDGE_SILENT_CODES` ⇒ 结局是 `no_reply`。
 *      判据（0 条发送 / 不再调模型 / 任务终态 exhausted）**一条没放松**。
 * ```
 *
 * ============================================================================
 *  P3-I 段（`artifacts/local/qq-group-p3i/CONTRACT.md` §0–§4 的六组验收）
 * ============================================================================
 * ```text
 * 用户裁定（2026-10-29，本批唯一授权来源）：
 *   「下一批按原顺序完成两件事：`send_once` 迁桥 → 补完整语音接管链，最后集中验收一次。」
 *
 * ① 43 `send_once` **确实走桥**（真 main + 真外壳 + 假 OneBot）
 *    判据是**归因**，不是"假 OneBot 收到了一条"（后者在 P3-H 的侧信道下也成立）：
 *      a) 那一条 `send_group_msg` 来自**外壳那条连接**（`connId` 逐字相等），
 *      b) 它由一条 `DELIVER_GROUP_TASK` 指令驱动，且 `deliveryKey` **逐字等于**账本里的实例 id。
 * ② 44 **无侧信道双发**：`get_group_list` 与 `send_group_msg` 都只来自外壳那条连接；
 *    同一正文只发 1 条；稳定期再读一次仍是 1 条（"桥 + 侧信道兜底"会变 2 条）。
 * ③ 45 **纯语音 = 1 条**：planned=1 · reserved_messages=1 · 假 OneBot 1 条 **record** 段 ·
 *    deliveredCount=1 · 音频是结构合法 PCM16 WAV（复用 `inspectWav`）。
 * ④ 46 **语音 + 独立来源附录 = 2 条**：planned=2 · reserved=2 · 恰好 2 条且
 *    **第 1 条 record、第 2 条纯文字附录** · deliveredCount=2 · 附录不许被拼进第 1 条。
 * ⑤ 47 **额度不足**（per-inbound 只允许 1，而本轮需要附录）⇒ **0 发送 + 具名码**
 *    （`group_task_appendix_not_permitted`，闭集兜底防"落回通用码"）
 *    —— 同时证明"没有降级成纯文字 / 没有偷偷加额度 / 没有改任务形态 / 没有删掉来源"。
 * ⑥ 48 **失败回落**：`textFallback=true` 且语音明确失败 ⇒ **一条**文字兜底
 *    （`reserved_messages` 仍 1 = 兜底是替代而非叠加；这条同时钉住 CONTRACT §0
 *     的**删掉 `voiceFloor`** —— 旧公式会让它计划 2 条 ⇒ 在 per-inbound=1 上永远发不出去）
 *    49 **`delivery_unknown` ⇒ 不重发**：一次尝试之后假 OneBot 计数**不增**
 *    （含不兜底、不迟到补发），且所有尝试都来自同一条连接（不切侧信道）。
 * ⑦ 50 **创建期冲突澄清**：`media='voice'` + `requireAppendix=true` + `perInboundMaxMessages=1`
 *    ⇒ 创建**被拒** + `group_task_voice_appendix_needs_two_messages` + **0 任务行** + 0 发送；
 *    反例（同一形态、per-inbound=2）**必须建得出来**（否则拒因不是"条数放不下"）。
 * ```
 *
 * ⚠️ **边界（必须与读数一起读）**
 * ```text
 * · 假 OneBot 只监听 `127.0.0.1`；**没有**真实 QQ 连接、没有真实模型、没有真实 TTS。
 * · 隔离 PG：`lg_test_*` 前缀（本门自己核对 `current_database()`），跑完由包装器删除；
 *   本门不碰生产库、不应用生产迁移。
 * · 05–08 的**编排**在门进程内（P2.1 只有"建 `send_once` 后同一轮同步派发"这一条入口，
 *   主链上不可能"建单后再撤销再发"）；真 main 只覆盖 01/02/03/04/09/10。
 * · 群名 `ambiguous` 分支在主链**不可达**：`readGroupTaskCreateSpec` 要求 `groupId` 必填且
 *   过 `isQqId`，而 `resolveDraftTarget` 总会把群号传进消歧 ⇒ 同名消歧**由模型**在语义入口
 *   里做（本门用假模型返回 `{kind:'clarify'}` 读数）。`ambiguous` 的真值表由
 *   `group-directory.ts` 自己的纯函数门覆盖，**不是**本门的读数。
 * · 门侧 `groupTaskAuthorizer` 是"读真 store + 走契约 `decideSendAllowance`"的薄适配器；
 *   生产外壳那一侧若走跨进程复核（桥 RPC），那条**跨进程**路径不在本门读数里（具名边界）。
 * · `api_accepted` **不等于**群成员看到/听到；本门只读到"假 OneBot 接受了这一段"。
 * · 重启恢复是真 UPDATE 读数，但**不是**真杀进程（核心有序停机后再起一个进程）。
 * · P3-H 的"并发不串"分两层取证（真链路背靠背两条帧 / 派发层两份同时预留），
 *   **都不是**"两条轮次在同一时刻执行"——外壳队列与 `TurnBridge.submit` 是串行的（既有设计）。
 * · P3-H 控 33 的 `inbound_message_id` 必须走**真外壳**的 `receive()`：门侧 `submitGroup()`
 *   用的是合成 requestId，核心派生会失败关闭成 `null`（验的是"取不到就不记账"，不是 H1 生效）。
 * · P3-I 的 ①② 靠**每条包自带的 `connId`** 归因（哪条 ws 连接发的），
 *   **不**靠"假 OneBot 收到了几条"：后者在侧信道下同样成立，是这一批最容易写出假绿的地方。
 *   约定口径（qq-chain 确认）：本门自建的 `negativeClient` / 语音客户端也是连接，
 *   **不是** main 的侧信道 ⇒ 判据是"每条包的 connId 是不是外壳那条"，不是"连接总数 == 1"。
 * · P3-I 的 ③–⑥ 用**自己的**客户端 + **假 TTS 端口**（构造第 4 参 `voice`）；
 *   零真实 TTS。"她真的选了语音"不在本门读数里：真 main 的装配层没有让模型选语音的口子。
 * · 语音"实际可播放"仍未证明：`inspectWav` 只做**结构**校验（RIFF/PCM16/时长），
 *   真实群里的可播放性要靠之后的另行授权试听（CONTRACT §5）。
 * ```
 *
 * 环境契约（由 `pnpm gates:pg --postlv2:qq-group-main:verify` 或 `runPreparedPgGate` 注入）：
 * ```text
 * CHARACTER_DB_BACKEND=postgres
 * LG_TEST_PG_URL=postgresql://…/lg_test_<id>      （必须是 lg_test_ 前缀）
 * ```
 */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { isolateDatabase } from '../src/dev/sandbox.ts'
import { startCoexistHost, delay, ROOT } from './coexist/harness.ts'
import { LgStdioClient } from '../src/infrastructure/qq/lg-stdio-client.ts'
import { OneBotPrivateClient, type QqGroupTaskAuthorizer } from '../src/infrastructure/qq/onebot-private-client.ts'
import { resolveGroupTarget } from '../src/infrastructure/qq/group-directory.ts'
import { inspectWav, type QqVoiceOutput } from '../src/infrastructure/qq/voice-reply.ts'
import {
  GROUP_TASK_NO_REPLY_MARKER,
  deriveInboundMessageId,
  type InboundMessageIdFacts,
} from '../src/infrastructure/runtime/qq-group-inbound-routing.ts'
import type { RawDb } from '../src/infrastructure/persistence/db.ts'
import {
  getGroupTask,
  readSendOccupancyForRecheck,
  modifyGroupTask,
  setGroupTaskStatus,
} from '../src/infrastructure/persistence/qq-group-task-store.ts'
import {
  decideSendAllowance,
} from '../src/kernel/contracts/qq-group-task.ts'
import {
  dispatchGroupTaskReply,
  handleGroupTaskTurn,
  plannedOutgoingMessages,
  type GroupSendExecutionOutcome,
  type GroupTaskRuntimeDeps,
} from '../src/infrastructure/runtime/qq-group-task-runtime.ts'
import { TurnBridge } from '../src/kernel/app/bridge/turn-bridge.ts'

/* ========================================================================= */
/* 0. 环境与隔离（失败关闭：不是 lg_test_ 就拒绝跑）                          */
/* ========================================================================= */
assert.equal(process.env.CHARACTER_DB_BACKEND, 'postgres',
  '本门必须在 postgres 后端上跑（pnpm gates:pg --postlv2:qq-group-main:verify）')
assert.match(new URL(process.env.LG_TEST_PG_URL!).pathname, /^\/lg_test_/,
  'LG_TEST_PG_URL 的库名必须带 lg_test_ 前缀')
const sandbox = isolateDatabase('qq-group-main', { postgres: { url: process.env.LG_TEST_PG_URL! } })
const pool = new pg.Pool({ connectionString: process.env.LG_TEST_PG_URL, max: 6 })
const db = drizzle(pool) as unknown as RawDb

const stamp = new Date().toISOString().replace(/\D/g, '')
const evidenceRoot = resolve(ROOT, 'artifacts/post-lv2', `qq-group-main-${stamp}`)
mkdirSync(evidenceRoot, { recursive: true })

/* ========================================================================= */
/* 1. 检查器（逐项具名 PASS/FAIL；result.json；失败退出码非零）                */
/* ========================================================================= */
const checks: string[] = []
const failures: string[] = []
const boundaryNotes: string[] = []
const readings: Record<string, unknown> = {}
const check = async (name: string, run: () => void | Promise<void>): Promise<void> => {
  try {
    await run()
    checks.push(name)
    console.log(`PASS ${name}`)
  } catch (error) {
    failures.push(name)
    const stack = error instanceof Error ? (error.stack ?? '') : ''
    const at = stack.split('\n').find((line) => line.includes('postlv2-qq-group-main-verify.ts')) ?? ''
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}${at === '' ? '' : `\n     ${at.trim()}`}`)
  }
}
const until = async (predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 60_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(100)
  }
  throw new Error(`fixture_timeout:${label}`)
}

/* ========================================================================= */
/* 2. 固定身份与夹具常量                                                      */
/* ========================================================================= */
const OWNER = '123456789'
const BOT = '987654321'
const MEMBER = '222222222'
/** 第二个群成员：**同群同人有 3 秒限流**，要连发两条入站必须换一个人，否则第二条被静默丢掉 */
const MEMBER2 = '333333333'
/** 旧静态名单里的群（`QQ_ALLOWED_GROUP_IDS`）——旧路径的对照组 / 05–08 的负控目标 */
const G_LEGACY = '10000003'
/**
 * 旧名单里的**第二个**群（P3-H 控 37 用）。
 *
 * ⚠️ 为什么要单独一个：控 37 要验"任务耗尽后**名单内**群恢复默认路线"，
 *    而它必须先把一个任务的额度真的用完 ⇒ 那个群会留下一行终态任务。
 *    借 `G_LEGACY` 会给 09/13/17 的旧路径读数里塞一行历史任务（虽然不冲突，
 *    但读数会变得需要解释）。单独一个群让"这一条控里发生了什么"一眼可读。
 */
const G_LEGACY_SEQ = '10000055'
/**
 * 旧名单里的**第三个**群（P3-H 控 41 用）：专门装一条**已过期但状态还是 active** 的任务。
 *
 * ⚠️ 这个形态是 H2 里最容易被漏掉的一支：`replyWindowTasks()` 只看状态，不看生效期
 *    ⇒ 一条到期任务会**长期**把这个群挡在门外（`group_task_out_of_term` ⇒ suppress），
 *    而"任务结束后恢复默认路线"要求它回落 `default`。
 */
const G_EXPIRED_ACTIVE = '10000058'
/**
 * 旧名单里的**第四个**群（P3-H 控 41 用）：装一条**还没开始**的任务。
 *
 * ⚠️ 用户裁定（2026-10-29）：「任务还没开始（`now < startAt`）」**不再抑制**，
 *    同样回落 `default` ——"还没开始 / 已到期 / 已撤销 / 已删除"是同一件事
 *    （此刻没有生效任务）。这个群旧名单放行 ⇒ 验"回落 default 之后**正常回一条**"。
 */
const G_FUTURE_ALLOWED = '10000061'
/** 静态名单**之外**的群 —— P2.1 的核心（旧名单拒绝而任务可达） */
const G_MAIN = '10000001'

/* ------------------------------------------------------------------------- */
/* P3-I（`artifacts/local/qq-group-p3i/CONTRACT.md` §4）的专用群号             */
/* ------------------------------------------------------------------------- */
/**
 * 每个新检查一个**独立群号**（与 22/29–32 同一条纪律：额度/结算按任务=按群算，
 * 共用群会把上一条检查的 `used_messages` 混进来；而且 ①② 的"哪条连接在说话"
 * 必须只看这一条检查自己的窗口）。
 */
/** 控 43/44：`send_once` 是否真的走桥（真 main + 真外壳 + 假 OneBot） */
const G_P3I_SEND_ONCE = '10000070'
/** 控 45：纯语音 = **1** 条 */
const G_P3I_VOICE_ONE = '10000071'
/** 控 46：语音 + 独立来源附录 = **2** 条（语音在前） */
const G_P3I_VOICE_APPENDIX = '10000072'
/** 控 47：额度不足（per-inbound 只允许 1，而本轮需要附录）⇒ 0 发送 + 具名码 */
const G_P3I_QUOTA = '10000073'
/** 控 48：`textFallback=true` 且语音失败 ⇒ 一条文字兜底（不加条数） */
const G_P3I_FALLBACK = '10000074'
/** 控 49：`delivery_unknown` ⇒ 不重发、不切侧信道 */
const G_P3I_UNKNOWN = '10000075'
/** 控 50：创建期冲突澄清（应被**拒绝**） */
const G_P3I_CONFLICT = '10000076'
/** 控 50 的反例（同一形态、per-inbound=2 ⇒ 应当建得出来） */
const G_P3I_CONFLICT_OK = '10000077'
/** 同名两群（群名消歧用） */
const G_DUP1 = '10000011'
const G_DUP2 = '10000012'
const DUP_NAME = '学习小组'
/** 正文（断言**逐字**到达假 OneBot） */
const MSG_MAIN = '今晚八点开会'
const MSG_MODEL = '收到。'
/** 假模型的"拒答"魔法词：入站正文里出现它 ⇒ 假模型回显**拒答标记**（ADR-156 / P3-F） */
const FAKE_MODEL_DECLINE_TOKEN = '拒绝回复'
const OWNER_FACTS = {
  transport: 'qq' as const, selfId: BOT, senderUserId: OWNER, messageType: 'private' as const,
}

/* ========================================================================= */
/* 3. 假模型（本机 HTTP；**不**打真实模型）                                    */
/* ========================================================================= */
interface ModelRequest {
  readonly system: string
  readonly raw: string
  readonly body: { tools?: unknown; messages?: { role?: string; content?: unknown }[] }
}
const modelRequests: ModelRequest[] = []
const replyPrompts: string[] = []
const groupTaskModelInputs: string[] = []
const semanticModelInputs: string[] = []

/** 建单草稿（闭集形状；`send_once` 不许 `longTerm` ⇒ 必须给 `endAt`） */
const createDraft = (over: Record<string, unknown>): Record<string, unknown> => ({
  kind: 'create',
  groupId: G_MAIN,
  groupNameHint: 'A群',
  taskKind: 'send_once',
  contentMode: 'owner_verbatim',
  text: MSG_MAIN,
  media: 'text',
  totalMaxMessages: 10,
  /*
   * ⚠️ 生效期必须是**真实窗口**：`startAt` 缺省会落到 0（纪元）⇒ 与 `endAt` 相差
   *    超过 7 天上限 ⇒ 草稿整条非法（门里踩过一次：05–08 因此拿不到 dispatch）。
   */
  startAt: Date.now(),
  endAt: Date.now() + 3_600_000,
  ...over,
})
/** 05–08 用的草稿：目标是**旧名单内**的群（客户端才会回具体拒绝码而不是被改判成旧闸的话） */
const negativeDraft = (text: string): Record<string, unknown> => createDraft({
  groupId: G_LEGACY, groupNameHint: '旧群', text,
})

/**
 * 请求体里**未转义**的 prompt 文本。
 *
 * ⚠️ `raw` 是完整请求体的 JSON 序列化 ⇒ 里面的 `"kind":"created"` 变成
 *    `\"kind\":\"created\"`。用 `raw` 直接判 JSON 片段会**假失败**（本门踩过一次：
 *    2026-10-28T16:18 组合门 8/10，02/03 两条都是这个原因，产品侧事实段其实在
 *    最终回复 prompt 里）。断言用的"prompt 文本"一律走这个函数。
 */
const decodedPromptOf = (body: ModelRequest['body']): string =>
  (body.messages ?? []).map(message => typeof message.content === 'string' ? message.content : '').join('\n')

/**
 * 只取**本轮**（某个下标之后）新到的回复请求。
 *
 * ⚠️ 用 `replyPrompts.filter(...).at(-1)` 会在"本轮根本没注入事实"时**回退到上一轮**的
 *    prompt ⇒ 断言可能被上一轮满足（假通过）。本门的每一条"事实进最终请求"都按
 *    `const mark = replyPrompts.length` → `replyPromptsSince(mark)` 划窗。
 */
const replyPromptsSince = (mark: number): string[] => replyPrompts.slice(mark)
/** 本轮回复请求里带「本轮群任务事实」段的那些（窗口内没有 ⇒ 就是没注入） */
const factPromptsSince = (mark: number): string[] =>
  replyPromptsSince(mark).filter(prompt => prompt.includes('【本轮群任务事实】'))

const MARKERS = [
  'P2G-CREATE-MAIN', 'P2G-GHOST-GROUP', 'P2G-HINT-CONFLICT', 'P2G-DUP-BOTH',
  'P2G-REVOKE', 'P2G-VERSION', 'P2G-EXPIRED', 'P2G-QUOTA',
  'P3I-BRIDGE-CREATE',
] as const

/** 按标记给出群任务草稿（标记来自本门提交的 userText） */
const draftFor = (raw: string): unknown => {
  const marker = MARKERS.find((candidate) => raw.includes(candidate))
  switch (marker) {
    case 'P2G-CREATE-MAIN': return createDraft({})
    /* P3-I 控 43/44：**同一个建单流程**，只是换一个群 ⇒ 本轮的 `send_group_msg` 可归因到这一条 */
    case 'P3I-BRIDGE-CREATE': return createDraft({ groupId: G_P3I_SEND_ONCE, groupNameHint: 'P3I桥接群' })
    case 'P2G-GHOST-GROUP': return createDraft({ groupId: '19999999', groupNameHint: null })
    case 'P2G-HINT-CONFLICT': return createDraft({ groupId: G_DUP1, groupNameHint: '完全无关的群名' })
    case 'P2G-DUP-BOTH': return { kind: 'clarify', reason: `有两个群都叫“${DUP_NAME}”，请给我群号` }
    case 'P2G-REVOKE': return negativeDraft('撤销前的正文')
    case 'P2G-VERSION': return negativeDraft('旧版本的正文')
    case 'P2G-EXPIRED': return negativeDraft('过期的正文')
    case 'P2G-QUOTA': return negativeDraft('超额度的正文')
    default: return { kind: 'none' }
  }
}

const model = createServer(async (request, response) => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  let body: ModelRequest['body'] = {}
  try { body = JSON.parse(raw || '{}') as ModelRequest['body'] } catch { /* 非 JSON 请求按空体处理 */ }
  const system = String((body.messages?.[0]?.content as string | undefined) ?? '')
  modelRequests.push({ system, raw, body })

  /*
   * 统一语义入口：本轮**不**产动作计划（`tool_calls: []`），让群任务决策器照旧跑。
   * ⚠️ 真正的计划形状由装配层定；本门只如实记录"这一路被叫到过"。
   */
  if (Array.isArray(body.tools)) {
    semanticModelInputs.push(raw)
    const semanticInput = JSON.parse(String(body.messages?.at(-1)?.content ?? '{}')) as {
      current?: { text?: string }; priorDomains?: string[] }
    const marker = semanticInput.current?.text ?? ''
    const nativeGroup = marker === 'NATIVE-GROUP-CREATE' ? '10000090'
      : marker === 'NATIVE-GROUP-AFTER-READ' ? '10000091' : undefined
    if (nativeGroup !== undefined) {
      const now = Date.now()
      const draft = createDraft({ groupId: nativeGroup, groupNameHint: null, taskKind: 'reply_window',
        contentMode: 'model_generated', text: null, brief: '按语境参与群聊', media: 'either', textFallback: true,
        startAt: now, endAt: now + 30 * 60_000, perInboundMaxMessages: 3 })
      delete draft.totalMaxMessages
      const readFirst = marker === 'NATIVE-GROUP-AFTER-READ' && semanticInput.priorDomains === undefined
      const name = readFirst ? 'lg_tools' : 'lg_group_task'
      const args = readFirst ? { branch: 'tools', goal: '只读计算后创建群任务', done: true,
        steps: [{ capability: 'math.calculate', operation: 'evaluate', args: { expression: '1+1' } }] } : draft
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [
        { id: 'native-group-fixture', type: 'function', function: { name, arguments: JSON.stringify(args) } },
      ] } }] }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { tool_calls: [] } }] }))
    return
  }

  let content: string
  if (system.includes('群任务决策器')) {
    groupTaskModelInputs.push(raw)
    content = JSON.stringify(draftFor(raw))
  } else if (system.includes('判断此刻是否愿意接话')) {
    content = JSON.stringify({ reply: true })
  } else {
    replyPrompts.push(decodedPromptOf(body))
    /*
     * ADR-156 / P3-F：假模型的**显式拒答**通道。
     * ⚠️ 只认入站正文里的魔法词（`拒绝回复`），**不**认标记本身 ——
     *    接管轮的上下文里本来就带着标记（教模型怎么拒答），用它做键会误判。
     */
    content = decodedPromptOf(body).includes(FAKE_MODEL_DECLINE_TOKEN)
      ? `<response><text>${GROUP_TASK_NO_REPLY_MARKER}</text></response>`
      : `<response><text>${MSG_MODEL}</text></response>`
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ choices: [{ message: { content } }] }))
})

await new Promise<void>((done) => model.listen(0, '127.0.0.1', () => done()))

/* ========================================================================= */
/* 4. 假 OneBot（本机 ws；只连 127.0.0.1）                                    */
/* ========================================================================= */
/**
 * 假 OneBot 收到的**一条**包，外加"它从哪条 ws 连接来"的证据。
 *
 * ⚠️ `connId` 是 P3-I 控 ①②（`send_once` 迁桥 / 无侧信道双发）的**唯一**证据面：
 *    "这一条 `send_group_msg` 是外壳发出去的，还是核心自建的另一条连接发出去的？"
 *    只看"假 OneBot 收到了一条"永远分不开这两件事 —— 而这两件事正是本批要与不要的分界。
 */
interface OneBotPacket { readonly action: string; readonly params: Record<string, unknown>; readonly connId: number }
interface OutboundSend {
  readonly action: string
  readonly groupId?: string
  readonly userId?: string
  readonly text: string
  readonly connId: number
}
const packets: OneBotPacket[] = []
const sends: OutboundSend[] = []
/** 每一条 ws 连接一个自增 id（连接序号即证据；不依赖包内容，也不依赖建立顺序的业务含义） */
let connSerial = 0
/** 当前**还活着**的连接 id（关掉的从集合里去掉；历史包仍保留自己的 connId） */
const liveConnections = new Set<number>()
const sockets = new Set<{
  send: (text: string) => void
  on: (event: string, cb: (data: unknown) => void) => void
  close?: () => void
}>()
/** 假群列表（**可变**：按检查阶段设置） */
let groupList: { group_id: string; group_name: string }[] = []
let nextMessageId = 7000
/**
 * 假 OneBot 对 `send_group_msg` 的**回执形态**（按群切换；缺省 `ok`）。
 *
 * ```text
 * ok      status:'ok' + data.message_id   ⇒ 外壳读得到平台回执 ⇒ api_accepted
 * error   status:'failed' retcode≠0       ⇒ 外壳抛 onebot_api_failed ⇒ failed_confirmed
 * no_id   status:'ok' 但 data 里没有 id    ⇒ 外壳抛 qq_delivery_unconfirmed ⇒ delivery_unknown
 * ```
 *
 * ⚠️ 三态是**契约 §5「结算准确」**的判据面；切成全局会对别的检查制造假读数，
 *    所以按键（群号）切换，每条检查自己设、自己复位。
 */
const sendModes = new Map<string, 'ok' | 'error' | 'no_id'>()
const recordSendModes = new Map<string, 'error' | 'no_id'>()

const { WebSocketServer } = createRequire(import.meta.resolve('jsdom'))('ws') as {
  WebSocketServer: new (options: { host: string; port: number }) => {
    on: (event: 'connection', handler: (socket: {
      on: (event: string, cb: (data: unknown) => void) => void
      send: (text: string) => void
    }) => void) => void
    once: (event: 'listening', handler: () => void) => void
    address: () => { port: number }
    clients: Set<{ terminate: () => void }>
    close: (done: () => void) => void
  }
}
const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 })
await new Promise<void>((done) => ws.once('listening', done))
const wsUrl = `ws://127.0.0.1:${ws.address().port}/`
ws.on('connection', (socket) => {
  const connId = ++connSerial
  liveConnections.add(connId)
  sockets.add(socket)
  socket.on('close', () => { sockets.delete(socket); liveConnections.delete(connId) })
  socket.on('message', (raw: unknown) => {
    const packet = JSON.parse(String(raw)) as { action?: unknown; params?: unknown; echo?: unknown }
    const action = String(packet.action ?? '')
    const params = (packet.params ?? {}) as Record<string, unknown>
    let data: unknown = {}
    if (action === 'get_login_info') data = { user_id: Number(BOT) }
    else if (action === 'get_group_member_info') {
      data = { user_id: Number(params.user_id), group_id: Number(params.group_id) }
    } else if (action === 'get_group_list') {
      packets.push({ action, params, connId })
      /* 真实 OneBot v11：`data` 就是数组；`client.call()` 原样返回它 */
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: packet.echo, data: groupList }))
      return
    } else if (action === 'send_private_msg' || action === 'send_group_msg') {
      const segments = Array.isArray(params.message)
        ? params.message as { data?: { text?: string } }[] : []
      packets.push({ action, params, connId })
      sends.push({
        action,
        ...(params.group_id === undefined ? {} : { groupId: String(params.group_id) }),
        ...(params.user_id === undefined ? {} : { userId: String(params.user_id) }),
        text: segments.map((part) => part.data?.text ?? '').join(''),
        connId,
      })
      /* P3-G：按群切换回执形态（见 `sendModes` 的说明）；这一帧仍算"尝试过一次" */
      const groupKey = String(params.group_id ?? '')
      const isRecord = (params.message as { type?: string }[]).some(segment => segment.type === 'record')
      const mode = (isRecord ? recordSendModes.get(groupKey) : undefined) ?? sendModes.get(groupKey) ?? 'ok'
      if (mode === 'error') {
        socket.send(JSON.stringify({ status: 'failed', retcode: 1200, echo: packet.echo, data: null }))
        return
      }
      if (mode === 'no_id') {
        /* 平台"接受"了，但没有回执 id —— 既有口径里这就是**结果不明**（不是失败） */
        socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: packet.echo, data: {} }))
        return
      }
      data = { message_id: ++nextMessageId }
    } else {
      packets.push({ action, params, connId })
    }
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: packet.echo, data }))
  })
})
const countAction = (action: string): number => packets.filter((packet) => packet.action === action).length
const groupSends = (groupId?: string): OutboundSend[] =>
  sends.filter((send) => send.action === 'send_group_msg' && (groupId === undefined || send.groupId === groupId))
/**
 * 某个群收到的 `send_group_msg` **原始包**（要逐段看 `message`：引用段/正文段/附录段都在这里）。
 * ⚠️ 只数 `message` 数组长度是**错的**判据：引用与正文是**同一条**消息里的两个段。
 */
const groupPackets = (groupId: string): OneBotPacket[] =>
  packets.filter((packet) => packet.action === 'send_group_msg'
    && String((packet.params as { group_id?: unknown }).group_id) === groupId)
/** 一个发送包的段类型序列（`['reply','text']` = 引用 + 正文 / `['text']` = 纯文字） */
const segmentTypes = (packet: OneBotPacket): string[] => {
  const message = (packet.params as { message?: unknown }).message
  return Array.isArray(message) ? (message as { type?: unknown }[]).map((part) => String(part.type)) : []
}
/** 一个发送包里的段（原样） */
const segmentsOf = (packet: OneBotPacket): { type?: unknown; data?: Record<string, unknown> }[] =>
  Array.isArray((packet.params as { message?: unknown }).message)
    ? (packet.params as { message: { type?: unknown; data?: Record<string, unknown> }[] }).message
    : []

/* ------------------------------------------------------------------------- */
/* 4b. P3-I：**"这一条是从哪条连接发的"** —— send_once 迁桥 / 无侧信道双发    */
/* ------------------------------------------------------------------------- */
/**
 * 一条连接打进来的**全部包**（按 `connId` 分组；`get_group_list` 与 `send_group_msg` 都在内）。
 *
 * ```text
 * P3-I 的判据不是"假 OneBot 收到了 send_group_msg"（那在 P3-H 的侧信道下也成立），
 * 而是"**只有一条连接**在说话，且那条连接是外壳的"。
 * ⇒ 侧信道存在时，core 自建的那条连接会自己打 `get_group_list`（群列表）与
 *    `send_group_msg`（send_once），一眼就能从 `connId` 分开。
 * ```
 */
const packetsOfConnection = (connId: number): OneBotPacket[] =>
  packets.filter((packet) => packet.connId === connId)
/** 某个群/某类动作的包**分别来自哪些连接**（读数用；集合大小 > 1 = 双发证据） */
const connectionsOf = (predicate: (packet: OneBotPacket) => boolean): number[] =>
  [...new Set(packets.filter(predicate).map((packet) => packet.connId))].sort((a, b) => a - b)
/** 本门自己那条连接（`negativeClient` / 语音客户端）**不是** main 的侧信道，读数时要排除 */
const connectionsSendingTo = (groupId: string): number[] =>
  connectionsOf((packet) => packet.action === 'send_group_msg'
    && String((packet.params as { group_id?: unknown }).group_id) === groupId)
/**
 * 一条 `record` 段里的**音频字节**（`base64://` 前缀）—— 只用来做结构校验与读数，
 * 不落地、不打印、不进证据文件的正文区。
 */
const recordBytesOf = (packet: OneBotPacket): Uint8Array | undefined => {
  const segment = segmentsOf(packet).find((part) => part.type === 'record')
  const file = segment?.data?.file
  if (typeof file !== 'string' || !file.startsWith('base64://')) return undefined
  try { return new Uint8Array(Buffer.from(file.slice('base64://'.length), 'base64')) } catch { return undefined }
}
/**
 * 一段**合法 PCM16 WAV**（结构合法即可；与旧语音门同形的夹具）。
 *
 * ⚠️ 这是"假 TTS 端口"的产出，不是真实合成：本门零真实 TTS。
 */
function wavFixture(dataBytes = 4800): Uint8Array {
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const write4 = (offset: number, text: string): void => {
    for (let index = 0; index < 4; index += 1) bytes[offset + index] = text.charCodeAt(index)
  }
  write4(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); write4(8, 'WAVE')
  write4(12, 'fmt '); view.setUint32(16, 16, true)
  view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 24_000, true); view.setUint32(28, 48_000, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  write4(36, 'data'); view.setUint32(40, dataBytes, true)
  return bytes
}

/* ------------------------------------------------------------------------- */
/* 4c. **假 TTS 端口**（零真实 TTS；只合成一段结构合法的 WAV）                 */
/* ------------------------------------------------------------------------- */
/**
 * 语音合成的**档位**（每条检查自己设、自己复位 —— 与 `sendModes` 同一条纪律）。
 *
 * ```text
 * ok        合成一段合法 PCM16 WAV ⇒ 外壳应发 record 段
 * throw     合成抛错（具名 code）   ⇒ 外壳必须按任务授权处理"语音明确失败"
 * ```
 * ⚠️ 口径：**抛错**而不是返回一个半截对象 —— 旧实现（`synthesizeVoice`）对
 *    `audio` 不是 `Uint8Array` 的返回值只给 `voice_synthesis_bad_result`，
 *    而抛错在旧/新两版实现里都会被折成"具名 reason"，读数更稳。
 */
type VoicePlan = { readonly kind: 'ok' } | { readonly kind: 'throw'; readonly code: string }
let voicePlan: VoicePlan = { kind: 'ok' }
/** 合成调用记录（**只记正文是否为空与次数**，不记音频字节） */
const voiceSynthesisCalls: { readonly textLength: number }[] = []
const fakeVoicePort: QqVoiceOutput = {
  synthesizer: {
    async synthesize({ text }) {
      voiceSynthesisCalls.push({ textLength: [...text].length })
      const plan = voicePlan
      if (plan.kind === 'throw') throw new Error(plan.code)
      return { audio: wavFixture(), format: 'wav' as const }
    },
  },
}

/** 往假 OneBot 的连接里塞一条**入站** QQ 事件（私聊 / 群聊）；返回这条入站的 `message_id` */
const inbound = (input: { text: string; groupId?: string; userId?: string }): number => {
  const messageId = ++nextMessageId
  const payload = {
    post_type: 'message',
    message_type: input.groupId === undefined ? 'private' : 'group',
    sub_type: input.groupId === undefined ? 'friend' : 'normal',
    self_id: Number(BOT),
    user_id: Number(input.userId ?? OWNER),
    sender: { user_id: Number(input.userId ?? OWNER) },
    ...(input.groupId === undefined ? {} : { group_id: Number(input.groupId) }),
    message_id: messageId,
    message: input.groupId === undefined
      ? [{ type: 'text', data: { text: input.text } }]
      : [{ type: 'at', data: { qq: Number(BOT) } }, { type: 'text', data: { text: input.text } }],
  }
  for (const socket of sockets) socket.send(JSON.stringify(payload))
  return messageId
}
/** 最近一条入站事件的 `message_id`（`inbound()` 自己返回它；这里给"就地调用"的写法用） */
const lastInboundMessageId = (): number => nextMessageId

/* ========================================================================= */
/* 5. 门侧授权复核（读**真 store** + 走契约 `decideSendAllowance`）            */
/* ========================================================================= */
/**
 * ⚠️ **门侧适配器**：它只做"读持久层任务事实 → 契约判定"这一层。
 * 生产装配层若在这一层之外还做跨进程复核（桥 RPC），那条路径不在本门读数里（具名边界）。
 */
const createGateAuthorizer = (): QqGroupTaskAuthorizer => async (input) => {
  const task = await getGroupTask(db, input.taskId)
  if (task === undefined) return { ok: false, code: 'group_task_not_found' }
  /*
   * ⚠️ 与装配层**同一份**账本口径：实例账本里剔除自己这条（`readSendOccupancyForRecheck`），
   *    再把这条自己的预留当 `plannedMessages` 加回来。早先门侧写的是"全部实例求和"
   *    （把自己算两遍）⇒ 08 那条"额度用尽"实际上是**双算**造出来的假拒绝。
   */
  if (input.deliveryKey === undefined || input.deliveryKey === '') {
    return { ok: false, code: 'group_send_instance_not_found' }
  }
  const occupancy = await readSendOccupancyForRecheck(db, {
    task, instanceId: input.deliveryKey, now: Date.now(),
  })
  if (!occupancy.ok) return { ok: false, code: occupancy.code }
  const decision = decideSendAllowance({
    task,
    now: Date.now(),
    target: { botId: BOT, groupId: input.groupId },
    expectedVersion: input.taskVersion,
    plannedMessages: occupancy.occupancy.current.reservedMessages,
    plannedMedia: task.media === 'voice' ? 'voice' : 'text',
    usage: {
      totalMessages: occupancy.occupancy.totalMessages,
      slotMessages: occupancy.occupancy.slotMessages,
      perInboundMessages: occupancy.occupancy.perInboundMessages,
      lastSendAt: task.lastSendAt,
    },
  })
  return decision.kind === 'granted' ? { ok: true } : { ok: false, code: decision.code }
}

/* ========================================================================= */
/* 6. 真 main 起停（`--coexist`）                                             */
/* ========================================================================= */
interface ShellLog { event: string; requestId?: string; messageId?: string | number; reason?: string }
/** 外壳把一条 `DELIVER_GROUP_TASK` 落地之后的**三态读数**（不含正文） */
interface ShellDispatchReading {
  deliveryKey: string
  taskId: string
  status: 'api_accepted' | 'failed_confirmed' | 'delivery_unknown'
  messageId?: string
  reason?: string
  /**
   * P3-I：这条指令**自己**的形状（"发送确实由桥指令驱动"的证据）。
   * ⚠️ `text` 是夹具正文，不是群成员数据；它只用于断言"派发的就是这一条"。
   */
  media?: string
  text?: string
  reservedMessages?: number
  appendixText?: string
  textFallback?: boolean
}
interface Shell {
  readonly lg: LgStdioClient
  readonly qq: OneBotPrivateClient
  readonly logs: ShellLog[]
  /** 外壳真的把几条派发指令落过地（每一条 = 一次策略 A 的四条检查 + 一次发送尝试） */
  readonly dispatches: ShellDispatchReading[]
  readonly groupTaskShellWiring: string
  /** P3-I：`LIST_GROUPS` 用的是哪条接线（产品 API / handleLine 兜底 / absent） */
  readonly groupListBridge: string
  submitOwner(text: string, requestId: string): Promise<Record<string, unknown>>
  /** 群入站（**直接交核心**：平台事实里**不带** `messageId`，QQ 侧不允许带） */
  submitGroup(text: string, requestId: string, groupId: string, senderUserId: string):
    Promise<Record<string, unknown>>
  stop(): Promise<void>
}

/**
 * 有界停机：核心有序停机可能因为一个在飞轮次/调度器而慢。
 * ⚠️ 超时**不**假装"停好了"：如实记一条边界读数，然后 kill（不卡死门）。
 */
const stopHost = async (
  host: Awaited<ReturnType<typeof startHost>> | undefined,
  label: string,
  budgetMs = 20_000,
): Promise<number | null> => {
  if (host === undefined) return null
  if (host.child.exitCode !== null) return host.child.exitCode
  const outcome = await Promise.race([
    host.stop().then((code) => ({ kind: 'stopped' as const, code })),
    delay(budgetMs).then(() => ({ kind: 'timeout' as const, code: null })),
  ]).catch(() => ({ kind: 'failed' as const, code: null }))
  if (outcome.kind !== 'stopped') {
    boundaryNotes.push(`${label} 有序停机未在 ${String(budgetMs)}ms 内完成（${outcome.kind}）⇒ 已 kill`)
    console.error(`[fixture] ${label} 有序停机超时；stdout tail:\n${host.stdout.slice(-15).join('\n')}`)
    console.error(`[fixture] ${label} stderr tail:\n${host.stderr.slice(-15).join('\n')}`)
    host.kill()
    await delay(500)
  }
  return outcome.code
}

const startHost = async (options: { groupTasks: boolean; suffix: string }) => await startCoexistHost({
  dbDir: resolve(sandbox.dir, `host-${options.suffix}`),
  modelPort: (model.address() as { port: number }).port,
  env: {
    CHARACTER_DB_BACKEND: 'postgres',
    ...(options.groupTasks ? { CHARACTER_QQ_GROUP_TASKS_ENABLED: 'true' } : {}),
    CHARACTER_SEMANTIC_ENTRY_ENABLED: 'true',
    CHARACTER_CONTEXT_COMPILER_V1: 'true',
    CHARACTER_RELATIONSHIP_CONTEXT_ENABLED: 'true',
    CHARACTER_MEMORY_EXPLICIT_ENABLED: 'false',
    CHARACTER_ACTION_ENABLED: 'true',
    CHARACTER_TASK_AUTONOMY_ENABLED: 'true',
    CHARACTER_MATH_CALCULATE_ENABLED: 'true',
    CHARACTER_ACTION_MAX_RISK: 'R1',
    CHARACTER_TURN_CONTENT_TOKENS: '2000',
    CHARACTER_RELAY_TASKS_ENABLED: 'false',
    QQ_OWNER_ID: OWNER,
    QQ_BOT_ID: BOT,
    QQ_MULTI_USER_ENABLED: 'true',
    /* P3-H：第二个旧名单群（控 37 用；见 `G_LEGACY_SEQ` 的说明） */
    QQ_ALLOWED_GROUP_IDS: `${G_LEGACY},${G_LEGACY_SEQ},${G_EXPIRED_ACTIVE},${G_FUTURE_ALLOWED}`,
    QQ_ONEBOT_WS_URL: wsUrl,
    LOG_LEVEL: 'info',
  },
})

/**
 * 门侧外壳：与生产外壳（`scripts/qq/chat.ts`）同形状 —— 连真 main 的 QQ 入口，
 * 同时连假 OneBot 的 ws。`groupTaskAuthorizer` 只在"开关开"的那一路装。
 *
 * ⚠️ 生产外壳若把群任务派发做成"核心 → 外壳"的桥指令，这里还要装那个处理器
 *    （照抄 `scripts/qq/chat.ts` 的对应接线）。本门用**特征探测**如实记录"装没装上"：
 *    没装上就是一条具名边界，而不是假装通了。
 */
const startShell = async (input: {
  readonly host: { qqPort: number; qqToken: string }
  readonly withAuthorizer: boolean
  /**
   * P3-I：注入**假 TTS 端口**（`voice` 是构造第 4 参，与生产外壳同一条接线）。
   * ⚠️ 缺省**不注入** —— 这一条不能改成"统统注入"：控 29/35 的读数恰恰是
   *    "没有合成能力 ⇒ 按任务授权回落文字"，注入之后那两条会被合成掉（旧读数就假了）。
   */
  readonly voice?: QqVoiceOutput
}): Promise<Shell> => {
  const lg = new LgStdioClient(ROOT, process.env, {
    connect: { host: '127.0.0.1', port: input.host.qqPort, token: input.host.qqToken },
  })
  const logs: ShellLog[] = []
  const authorizer = input.withAuthorizer ? createGateAuthorizer() : undefined
  /*
   * ADR-156 / P3-B：与生产外壳（`scripts/qq/chat.ts`）同一条接线 ——
   * 群任务开关打开时，**群入站准入下沉给核心**（外壳不再先拿静态名单丢消息）。
   * ⚠️ 关着时（本门 01 那一路）不传 ⇒ 旧行为逐字不变。
   */
  const deferGroupAdmissionToCore = input.withAuthorizer
  const qq = new OneBotPrivateClient({
    ownerId: OWNER, botId: BOT, wsUrl, token: 'offline-group-task-combo-token-123456',
    multiUserEnabled: true,
    /* P3-H：名单里多一个 `G_LEGACY_SEQ`（控 37 的默认路线要能**发回**那个群） */
    allowedGroupIds: [G_LEGACY, G_LEGACY_SEQ, G_EXPIRED_ACTIVE, G_FUTURE_ALLOWED],
  }, (request) => lg.submit(request), (reading) => logs.push(reading), input.voice, undefined, authorizer,
  deferGroupAdmissionToCore)
  await lg.ready
  await qq.connect()

  /*
   * 外壳侧的群任务派发入口（核心 → 外壳的桥指令 `DELIVER_GROUP_TASK`）。
   *
   * ⚠️ **P3-G 的接线换过一次，这次必须换成策略 A 那一条**：
   * ```text
   * 旧（P2）：setGroupTaskDeliveryHandler → deliverGroupTaskMessage（自建侧信道 + authorizer 复核）
   * 新（P3-G / CONTRACT §3.4）：setGroupTaskDeliveryHandler → deliverGroupTaskFromCore（策略 A）
   * ```
   * 若这里还装旧的，接管轮的正文会从**侧信道**发出去：看起来"发出了 1 条"，
   * 但"桥派发 → 平台回执 → 核心结算"这条本批要验的链**一次都没走**
   * （这正是本门第 0 步发现"假绿"的那类形状）。
   */
  const dispatches: ShellDispatchReading[] = []
  let groupTaskShellWiring = 'absent'
  if (input.withAuthorizer
    && typeof (lg as unknown as Record<string, unknown>).setGroupTaskDeliveryHandler === 'function') {
    lg.setGroupTaskDeliveryHandler(async (instruction) => {
      const reading = await qq.deliverGroupTaskFromCore(instruction)
      dispatches.push({
        deliveryKey: instruction.deliveryKey,
        taskId: instruction.taskId,
        status: reading.status,
        ...(reading.messageId === undefined ? {} : { messageId: reading.messageId }),
        ...(reading.reason === undefined ? {} : { reason: reading.reason }),
        /* P3-I：指令本身的形状也是证据（"发送确实由这条指令驱动"） */
        media: instruction.media,
        text: instruction.text,
        reservedMessages: instruction.reservedMessages,
        ...(instruction.appendixText === undefined ? {} : { appendixText: instruction.appendixText }),
        ...(instruction.textFallback === undefined ? {} : { textFallback: instruction.textFallback }),
      })
      return reading
    })
    groupTaskShellWiring = 'setGroupTaskDeliveryHandler→deliverGroupTaskFromCore'
  }

  /*
   * =======================================================================
   *  P3-I：外壳侧的**群列表只读**入口（核心 → 外壳的桥指令 `LIST_GROUPS`）
   * =======================================================================
   * ```text
   * 为什么要装它：P3-I 把"核心自建的那条 OneBot 连接"删掉了，群列表只能走桥。
   *   门夹具如果还等着核心自己连假 OneBot 取群列表，`send_once` 的群号解析会
   *   直接失败（`group_task_group_list_unavailable`）—— 那是**夹具没跟上**，
   *   不是产品缺陷。所以这里必须照 `scripts/qq/chat.ts` 装上同一条接线。
   * ⚠️ 外壳只做**只读** `get_group_list`：不发消息、不占发送队列。
   * ⚠️ 优先用产品 API（`setGroupListHandler`）；产品 API 缺席时退到
   *    "拦截 `handleLine` 里的 `LIST_GROUPS`"这一条不依赖方法名的兜底，
   *    并把**用了哪条**如实记进读数（不许"看起来通了"）。
   * ```
   */
  const groupListBridge = installGroupListBridge(lg, qq)

  return {
    lg,
    qq,
    logs,
    dispatches,
    groupTaskShellWiring,
    groupListBridge: groupListBridge.mode,
    submitOwner: async (text, requestId) =>
      await lg.submit({ requestId, userText: text, platformFacts: OWNER_FACTS }) as unknown as Record<string, unknown>,
    submitGroup: async (text, requestId, groupId, senderUserId) =>
      await lg.submit({ requestId, userText: text, platformFacts: {
        transport: 'qq', selfId: BOT, senderUserId, messageType: 'group', groupId,
      } }) as unknown as Record<string, unknown>,
    stop: async () => {
      await qq.close().catch(() => undefined)
      await lg.close().catch(() => undefined)
    },
  }
}

/**
 * 装 `LIST_GROUPS`（核心 → 外壳的只读群列表指令）。
 *
 * ```text
 * 首选：`LgStdioClient.setGroupListHandler(handler)`（生产接线：`(…) => qq.listGroups()`）
 * 兜底：拦截 `handleLine`，自己认出 `kind==='LIST_GROUPS'` 并写回 `LIST_GROUPS_RESULT`
 *       （不依赖产品方法名；截到的响应总是 `groups` / 具名 `code`，不回空数组冒充成功）
 * ```
 * ⚠️ 返回 `mode` 是**证据**：它进 `readings`，让"用了哪条接线"可核。
 */
const installGroupListBridge = (
  lg: LgStdioClient,
  qq: OneBotPrivateClient,
): { readonly mode: string } => {
  const api = (lg as unknown as Record<string, unknown>).setGroupListHandler
  if (typeof api === 'function') {
    ;(api as (handler: () => Promise<readonly { groupId: string; groupName: string }[]>) => void)
      .call(lg, async () => await qq.listGroups())
    return { mode: 'setGroupListHandler→listGroups' }
  }
  /*
   * 兜底：`handleLine` 是私有的（`private handleLine`），但它是**实例上**唯一的行分派口。
   * 这里把它换成"先认 LIST_GROUPS，其余原样交回"，并用私有的 `writeLine` 回一帧。
   */
  const internals = lg as unknown as {
    handleLine?: (line: string) => void
    writeLine?: (payload: Record<string, unknown>) => void
  }
  const original = internals.handleLine
  const write = internals.writeLine
  if (typeof original !== 'function' || typeof write !== 'function') {
    return { mode: 'absent（产品 API 与 handleLine 兜底都不可用 ⇒ 群列表走不了桥）' }
  }
  internals.handleLine = function patchedHandleLine(this: unknown, line: string): void {
    let parsed: { kind?: unknown; requestId?: unknown } | undefined
    try { parsed = JSON.parse(line) as { kind?: unknown; requestId?: unknown } } catch { parsed = undefined }
    if (parsed?.kind !== 'LIST_GROUPS') { original.call(this, line); return }
    const requestId = typeof parsed.requestId === 'string' ? parsed.requestId : ''
    void (async () => {
      try {
        const groups = await qq.listGroups()
        write.call(lg, {
          kind: 'LIST_GROUPS_RESULT', requestId,
          groups: groups.map((entry) => ({ groupId: entry.groupId, groupName: entry.groupName })),
        })
      } catch (error) {
        write.call(lg, {
          kind: 'LIST_GROUPS_RESULT', requestId,
          code: error instanceof Error ? error.message : 'group_task_group_list_unavailable',
        })
      }
    })()
  }
  return { mode: 'intercept:handleLine(LIST_GROUPS)' }
}

/* ========================================================================= */
/* 7. 数据库读数小工具                                                       */
/* ========================================================================= */
interface TaskRow {
  id: string
  version: number
  status: string
  kind: string
  group_id: string
  used_messages: number
  auth_source: string
}
interface InstanceRow {
  id: string
  task_id: string
  state: string
  reserved_messages: number
  platform_message_id: string | null
  /**
   * P3-H：这一条实例的**入站关联键**（`perInboundMaxMessages` 的唯一依据）。
   * P3-G 的具名缺口就是这一列恒 `null` ⇒ per-inbound 维度恒 0。
   */
  inbound_message_id: string | null
}
const TASK_COLUMNS = 'id,version,status,kind,group_id,used_messages,auth_source'
const taskRows = async (groupId?: string): Promise<TaskRow[]> => (await pool.query(
  groupId === undefined
    ? `select ${TASK_COLUMNS} from qq_group_tasks order by created_at asc, id asc`
    : `select ${TASK_COLUMNS} from qq_group_tasks where group_id = $1 order by created_at asc, id asc`,
  groupId === undefined ? [] : [groupId],
)).rows as TaskRow[]
const instanceRows = async (taskId: string): Promise<InstanceRow[]> => (await pool.query(
  'select id,task_id,state,reserved_messages,platform_message_id,inbound_message_id from qq_group_send_instances' +
  ' where task_id = $1 order by created_at asc, id asc',
  [taskId],
)).rows as InstanceRow[]
const eventNames = async (taskId: string): Promise<string[]> => ((await pool.query(
  'select event from qq_group_task_events where task_id = $1 order by at asc, event_id asc', [taskId],
)).rows as { event: string }[]).map((row) => row.event)
const taskCount = async (): Promise<number> =>
  Number(((await pool.query('select count(*)::int as n from qq_group_tasks')).rows[0] as { n: number }).n)
const taskRowById = async (id: string): Promise<TaskRow | undefined> =>
  ((await pool.query(`select ${TASK_COLUMNS} from qq_group_tasks where id = $1`, [id])).rows as TaskRow[])[0]

/**
 * 门侧夹具：插一条 `reply_window` 任务（列与 UI 建单落库的那一行**同一份**）。
 *
 * ⚠️ 用 SQL 直插而不是"走建单流程"：这些检查要的是**接管轮**（入站 → 任务接管 → 派发），
 *    而建单流程（`send_once`）已经在 02/05–08 覆盖过；两者不是同一条链。
 * ⚠️ `totalMaxMessages` 是这组检查的**自变量**（1 = 额度有效；10 = 结算三态各发一条）。
 * ⚠️ 每个检查一个**独立群号**：额度/结算/引用都是按任务（=按群）算的，
 *    共用群会把"上一条检查的 used_messages"混进这一条（P2.1 那批抓过跨轮读数假通过）。
 */
const insertReplyTask = async (input: {
  readonly id: string
  readonly groupId: string
  readonly totalMaxMessages: number
  /** `either` = 语音/文字都可能（DDL：只有 `either` 允许 `textFallback=true`） */
  readonly media?: 'text' | 'voice' | 'either'
  readonly textFallback?: boolean
  readonly memberIds?: readonly string[]
  readonly perInboundMaxMessages?: number
  /**
   * 生效期（缺省 = 现在前 60 s ~ 现在后 1 h）。
   *
   * ⚠️ P3-H 控 41 要造两种"非正常"窗口：**已过期但状态仍 active**（旧行为会一直抑制该群）
   *    与**还没开始**（那时的抑制理由是如实的 ⇒ 必须仍然抑制）。
   */
  readonly term?: { readonly startAt: number; readonly endAt: number }
}): Promise<void> => {
  const now = Date.now()
  const startAt = input.term?.startAt ?? now - 60_000
  const endAt = input.term?.endAt ?? now + 3_600_000
  await pool.query(`insert into qq_group_tasks
    (id, contract_version, version, status, kind, bot_id, group_id, content, media, text_fallback,
     trigger, term, quota, used_messages, last_send_at, auth_source, dedupe_key, created_at, updated_at, revoked_at)
    values ($1, 1, 1, 'active', 'reply_window', $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb,
            0, null, 'owner_qq_private', $10, $11, $11, null)`, [
    input.id, BOT, input.groupId,
    JSON.stringify({ mode: 'owner_verbatim', text: '门夹具正文', brief: null }),
    input.media ?? 'text',
    input.textFallback ?? false,
    JSON.stringify({
      memberIds: [...(input.memberIds ?? [MEMBER])],
      replyToMessageId: null, categories: [], topicScope: null,
    }),
    JSON.stringify({ kind: 'window', startAt, endAt }),
    JSON.stringify({
      totalMaxMessages: input.totalMaxMessages,
      perInboundMaxMessages: input.perInboundMaxMessages ?? 3,
      slot: null, minIntervalMs: 0,
    }),
    `qq-group-task:${OWNER}:${input.id}`, now,
  ])
}

/* ========================================================================= */
/* 8. 事实文本判定（"不能说已送达"：肯定式声明只许出现在**否定句**里）        */
/* ========================================================================= */
const POSITIVE_DELIVERY = /已送达|已经送达|群成员已(?:看到|听到|收到)|已经看到|已经听到/g
const NEGATION = /不是|不能|不等于|不算|并非|不代表|只(?:是|证明|说明)|不证明/
const sentences = (text: string): string[] =>
  text.split(/[。；\n]/).map((part) => part.trim()).filter((part) => part !== '')
/** 返回**肯定式**投递声明的命中（同句带否定语境的不算） */
const positiveDeliveryClaims = (text: string): string[] => {
  const found: string[] = []
  for (const sentence of sentences(text)) {
    if (NEGATION.test(sentence)) continue
    for (const match of sentence.matchAll(POSITIVE_DELIVERY)) {
      found.push(`${match[0]}（句：${sentence.slice(0, 120)}）`)
    }
  }
  return found
}

/* ========================================================================= */
/* 9. 主流程                                                                 */
/* ========================================================================= */
let hostA: Awaited<ReturnType<typeof startHost>> | undefined
let hostB: Awaited<ReturnType<typeof startHost>> | undefined
let hostC: Awaited<ReturnType<typeof startHost>> | undefined
let shellA: Shell | undefined
let shellB: Shell | undefined
let negativeClient: OneBotPrivateClient | undefined
/** P3-I：带**假 TTS 端口**的门侧客户端（控 45–49 用；inally 里也要收） */
let p3iVoiceClient: OneBotPrivateClient | undefined
const hostTails: Record<string, string[]> = {}
const captureTail = (label: string, host: { stdout: string[]; stderr: string[] }): void => {
  hostTails[label] = [...host.stdout.slice(-40), '—— stderr ——', ...host.stderr.slice(-40)]
}
let scenarioError: unknown

try {
  /* ---------------- 隔离库身份核对 ---------------- */
  const identity = (await pool.query('select current_database() as db, current_user as usr')).rows[0] as {
    db?: string; usr?: string
  }
  assert.match(String(identity.db ?? ''), /^lg_test_/, `当前连接不是隔离测试库：${String(identity.db)}`)
  readings['isolatedDatabase'] = String(identity.db)
  readings['isolatedRole'] = String(identity.usr ?? '')

  /* =======================================================================
   * 01 开关缺省关 ⇒ 群任务链**未装配**（真 main，flag 不设）
   * ===================================================================== */
  hostA = await startHost({ groupTasks: false, suffix: 'off' })
  await hostA.ready
  shellA = await startShell({ host: hostA, withAuthorizer: false })
  const offGroupListBefore = countAction('get_group_list')
  const offSendBefore = groupSends().length
  const offTurn = await shellA.submitOwner('P2G-CREATE-MAIN：往A群发一条文字：今晚八点开会', 'p2g-off-1')
  await check('01 开关缺省关：真 main 起来后群任务链未装配（无群列表/无群发送/0 任务行/无 qq:group_send 授权）', async () => {
    assert.equal(offTurn.outcome, 'replied', `开关关时普通私聊应当照常回复：${JSON.stringify(offTurn).slice(0, 400)}`)
    await delay(800)
    assert.equal(countAction('get_group_list') - offGroupListBefore, 0, '开关关时核心不该请求群列表')
    assert.equal(groupSends().length - offSendBefore, 0, '开关关时不该有任何 send_group_msg')
    assert.equal(await taskCount(), 0, '开关关时不该落任何群任务')
    /* 已授予权限清单里**没有** `qq:group_send`（能力 id 恒登记，权限才是装配证据） */
    const granted = modelRequests.filter((request) => request.raw.includes('qq:group_send'))
    assert.equal(granted.length, 0, '开关关时不该出现已授予的 qq:group_send')
    assert.equal(replyPrompts.some((prompt) => prompt.includes('【本轮群任务事实】')), false,
      '开关关时主人私聊 prompt 不该有群任务事实段')
  })
  readings['check01'] = {
    turnOutcome: offTurn.outcome,
    groupListRequests: countAction('get_group_list') - offGroupListBefore,
    groupSends: groupSends().length - offSendBefore,
    taskRows: await taskCount(),
    modelRequests: modelRequests.length,
  }
  await shellA.stop(); shellA = undefined
  captureTail('A', hostA)
  readings['hostAExit'] = await stopHost(hostA, 'hostA')
  hostA = undefined

  /* =======================================================================
   * 开起来：一个真 main 进程里覆盖 02/03/04/09
   * ===================================================================== */
  groupList = [
    { group_id: '10000090', group_name: '原生建单夹具群' },
    { group_id: '10000091', group_name: '读取后建单夹具群' },
    { group_id: G_LEGACY, group_name: '旧群' },
    { group_id: G_MAIN, group_name: 'A群' },
    { group_id: G_DUP1, group_name: DUP_NAME },
    { group_id: G_DUP2, group_name: DUP_NAME },
    /*
     * P3-I：新检查自己的群必须出现在**真实群列表**里，否则 `send_once` 的群号解析
     * 会以 `group_task_group_not_found` 结束（那是夹具没喂群列表，不是产品缺陷）。
     */
    { group_id: G_P3I_SEND_ONCE, group_name: 'P3I桥接群' },
    { group_id: G_P3I_VOICE_ONE, group_name: 'P3I语音群' },
    { group_id: G_P3I_VOICE_APPENDIX, group_name: 'P3I语音附录群' },
    { group_id: G_P3I_QUOTA, group_name: 'P3I额度群' },
    { group_id: G_P3I_FALLBACK, group_name: 'P3I兜底群' },
    { group_id: G_P3I_UNKNOWN, group_name: 'P3I未知群' },
    { group_id: G_P3I_CONFLICT, group_name: 'P3I冲突群' },
    { group_id: G_P3I_CONFLICT_OK, group_name: 'P3I冲突对照群' },
  ]
  hostB = await startHost({ groupTasks: true, suffix: 'on' })
  await hostB.ready
  shellB = await startShell({ host: hostB, withAuthorizer: true })
  boundaryNotes.push(`外壳侧群任务派发入口：${shellB.groupTaskShellWiring === 'absent'
    ? 'absent（核心→外壳的群任务派发不在本门读数里）' : shellB.groupTaskShellWiring}`)
  boundaryNotes.push(`外壳侧群列表只读入口（P3-I \`LIST_GROUPS\`）：${shellB.groupListBridge}`)
  readings['shellGroupTaskWiring'] = shellB.groupTaskShellWiring
  readings['shellGroupListBridge'] = shellB.groupListBridge

  /* ------------------- 02 建单 + 真发送 ------------------- */
  const createPromptMark = replyPrompts.length
  const mainTurn = await shellB.submitOwner('P2G-CREATE-MAIN：往A群发一条文字：今晚八点开会', 'p2g-create-main')
  await check('02 开起来+建单+真发送：send_group_msg 群号/正文逐字 · 实例 api_accepted + platform_message_id · 事实只说"平台接受"', async () => {
    assert.equal(mainTurn.outcome, 'replied', `群任务轮应当正常回复：${JSON.stringify(mainTurn).slice(0, 400)}`)
    await until(() => groupSends(G_MAIN).length > 0, 'send_group_msg to A群')
    const sent = groupSends(G_MAIN)[0]!
    assert.equal(sent.groupId, G_MAIN, `群号必须逐字是 ${G_MAIN}：${JSON.stringify(sent)}`)
    assert.equal(sent.text, MSG_MAIN, `正文必须逐字是「${MSG_MAIN}」：${JSON.stringify(sent.text)}`)

    const rows = await taskRows(G_MAIN)
    assert.equal(rows.length, 1, `A群应当恰好 1 条任务，实际 ${rows.length}`)
    const task = rows[0]!
    assert.equal(task.kind, 'send_once', `任务种类应当是 send_once：${task.kind}`)
    assert.equal(task.auth_source, 'owner_qq_private', `授权来源必须是 owner_qq_private：${task.auth_source}`)
    assert.equal(task.used_messages, 1, `单次发送后 used_messages 应当为 1：${task.used_messages}`)

    const instances = await instanceRows(task.id)
    assert.equal(instances.length, 1, `应当恰好 1 条发送实例，实际 ${instances.length}`)
    const instance = instances[0]!
    assert.equal(instance.state, 'api_accepted', `实例结局应当是 api_accepted：${instance.state}`)
    assert.ok(instance.platform_message_id !== null && instance.platform_message_id !== '',
      'api_accepted 必须有 platform_message_id（DDL 也约束了）')
    assert.equal(instance.reserved_messages, 1, `文字单次发送应预留 1 条：${instance.reserved_messages}`)

    const events = await eventNames(task.id)
    for (const expected of ['create', 'send_reserved', 'send_settled']) {
      assert.ok(events.includes(expected), `事件链缺 ${expected}：${events.join(',')}`)
    }

    /* ⚠️ 划窗：只看这一轮新到的回复请求，不许拿上一轮的 prompt 蒙混 */
    const facts = factPromptsSince(createPromptMark)
    assert.equal(facts.length, 1, `本轮主人私聊主回复的 prompt 应当**恰好** 1 条带「【本轮群任务事实】」（实际 ${facts.length}）`)
    const fact = facts[0]!
    assert.ok(fact.includes('【本次发送结局】'), '事实段里应当有「【本次发送结局】」')
    assert.ok(fact.includes('平台接受'), '事实段应当说"平台接受"（api_accepted 的原话）')
    assert.ok(fact.includes('"kind":"created"'), '事实 JSON 里应当有 created（任务已登记）')
    assert.ok(NEGATION.test(fact), '事实段应当带否定语境（平台接受 ≠ 群成员看到/听到）')
    assert.deepEqual(positiveDeliveryClaims(fact), [],
      `事实段出现肯定式投递声明：${positiveDeliveryClaims(fact).join(' | ')}`)
    assert.equal(fact.includes('已送达'), false, '事实段不许出现"已送达"')
    /* 事实只谈本轮这一条任务 / 这一个群：不许带出旧群或同名群 */
    assert.ok(fact.includes(G_MAIN), `事实段应当带上真实群号 ${G_MAIN}`)
    assert.equal(fact.includes(G_LEGACY), false, `事实段不许出现旧群 ${G_LEGACY}（跨群泄漏）`)
    assert.equal(fact.includes(DUP_NAME), false, `事实段不许出现同名群「${DUP_NAME}」（跨群泄漏）`)
  })
  readings['check02'] = {
    sent: groupSends(G_MAIN)[0],
    tasks: await taskRows(G_MAIN),
    instances: (await taskRows(G_MAIN)).length === 0 ? [] : await instanceRows((await taskRows(G_MAIN))[0]!.id),
    replyRequestsThisTurn: replyPromptsSince(createPromptMark).length,
    factsThisTurn: factPromptsSince(createPromptMark).length,
    /* 只存**事实段本身**（从头到 `</context>` 之间），便于如实核对 */
    factText: (factPromptsSince(createPromptMark)[0] ?? '').slice(
      (factPromptsSince(createPromptMark)[0] ?? '').indexOf('【本轮群任务事实】'),
      (factPromptsSince(createPromptMark)[0] ?? '').indexOf('</context>'),
    ),
  }

  for (const [marker, groupId, label] of [
    ['NATIVE-GROUP-CREATE', '10000090', '59 native semantic create reaches persistence'],
    ['NATIVE-GROUP-AFTER-READ', '10000091', '60 read continuation group create reaches persistence'],
  ]) {
    const semanticMark = semanticModelInputs.length
    const turn = await shellB.submitOwner(marker!, `native-group-${groupId}`)
    await check(label!, async () => {
      assert.equal(turn.outcome, 'replied')
      const rows = await taskRows(groupId!)
      assert.equal(rows.length, 1, '有效原生草稿必须真正建单，不能变成 invalid_output')
      const task = (await getGroupTask(db, rows[0]!.id))!
      assert.equal(task.kind, 'reply_window')
      assert.equal(task.status, 'active')
      assert.equal(task.media, 'either')
      assert.equal(task.quota.totalMaxMessages, null)
      assert.equal(task.quota.perInboundMaxMessages, 3)
      assert.ok(task.term.kind === 'window')
      assert.equal(task.term.endAt - task.term.startAt, 30 * 60_000)
      assert.equal(groupSends(groupId!).length, 0, '创建监听任务不主动向群里发消息')
      if (marker === 'NATIVE-GROUP-AFTER-READ') {
        const continuation = semanticModelInputs.slice(semanticMark).map(raw => {
          const body = JSON.parse(raw); return JSON.parse(body.messages.at(-1).content)
        }).find(input => input.priorDomains?.includes('tools'))
        assert.ok(continuation, '真实只读工具后必须经过统一语义入口继续理解')
        assert.ok(continuation.materials?.some((row: { text: string }) => row.text.includes('2')))
      }
      readings[marker!] = { taskId: task.id, quota: task.quota, term: task.term, groupSends: 0 }
      assert.equal((await setGroupTaskStatus(db, task.id, task.version, 'revoked', Date.now())).ok, true)
    })
  }

  /* ------------------- 03 群名消歧（同名两群） ------------------- */
  const dupGroupListBefore = countAction('get_group_list')
  const dupSendBefore = groupSends().length
  const dupTaskBefore = await taskCount()
  /* 划窗基准：三个子轮各自只读"自己这一轮"的回复请求 */
  const dupPromptMark = replyPrompts.length
  const dupTurn = await shellB.submitOwner('P2G-DUP-BOTH：往学习小组发一条文字：今晚八点开会', 'p2g-dup-name')
  await check('03 群名消歧（同名两群）：走澄清 · 0 条发送 · 任务表 0 行（含程序侧 not_found / hint_conflict 两种拒法）', async () => {
    assert.equal(dupTurn.outcome, 'replied', `澄清轮应当正常回复：${JSON.stringify(dupTurn).slice(0, 400)}`)
    await delay(600)
    assert.equal(groupSends().length - dupSendBefore, 0, '澄清时一条群消息都不许发')
    assert.equal(await taskCount(), dupTaskBefore, '澄清时不许落任务行')
    const dupFacts = factPromptsSince(dupPromptMark)
    assert.equal(dupFacts.length, 1, `澄清轮应当**恰好** 1 条带事实的回复请求（实际 ${dupFacts.length}）`)
    const fact = dupFacts[0]!
    assert.ok(fact.includes('"kind":"clarify"'), `本轮的群任务事实应当是 clarify：${fact.slice(-500)}`)
    /* 澄清 = 没有派发 ⇒ 不许出现"发送结局"这类段（说了就等于声称尝试过发送） */
    assert.equal(fact.includes('【本次发送结局】'), false, '澄清轮不许出现「【本次发送结局】」（没有派发）')
    assert.deepEqual(positiveDeliveryClaims(fact), [],
      `澄清事实段出现肯定式投递声明：${positiveDeliveryClaims(fact).join(' | ')}`)
    /* 同名两群是**模型**在看到真实群列表后判的（程序侧不猜群） */
    assert.ok(countAction('get_group_list') - dupGroupListBefore > 0,
      '同名消歧这一轮应当真的请求过群列表（装配层喂给模型）')
    assert.ok([...groupTaskModelInputs, ...semanticModelInputs].some((raw) =>
      raw.includes(G_DUP1) && raw.includes(G_DUP2)),
    '真实群列表（含同名两群）应当出现在喂给模型的输入里')

    /* 程序侧群号解析的两种拒法：都 0 条发送、0 行任务 */
    const ghostSendBefore = groupSends().length
    const ghostTaskBefore = await taskCount()
    const ghostPromptMark = replyPrompts.length
    const ghostTurn = await shellB!.submitOwner('P2G-GHOST-GROUP：往一个不存在的群发一条文字：今晚八点开会', 'p2g-ghost')
    assert.equal(ghostTurn.outcome, 'replied')
    await delay(600)
    assert.equal(groupSends().length - ghostSendBefore, 0, '群号不在真实列表里 ⇒ 0 条发送')
    assert.equal(await taskCount(), ghostTaskBefore, '群号不在真实列表里 ⇒ 不落任务')
    const ghostFacts = factPromptsSince(ghostPromptMark)
    assert.equal(ghostFacts.length, 1, `群号不存在这一轮应当**恰好** 1 条带事实的回复请求（实际 ${ghostFacts.length}）`)
    const ghostFact = ghostFacts[0]!
    assert.ok(ghostFact.includes('group_task_group_not_found'),
      `群号不在列表里应当具名拒绝 group_task_group_not_found：${ghostFact.slice(-400)}`)
    /* 不串轮：这一轮不许再出现上一轮（澄清）的事实 */
    assert.equal(ghostFact.includes('"kind":"clarify"'), false,
      '群号不存在这一轮不许再带上一轮的 clarify 事实（跨轮泄漏）')
    assert.equal(ghostFact.includes('【本次发送结局】'), false, '群号不存在 ⇒ 没有派发 ⇒ 不许有发送结局段')

    const conflictSendBefore = groupSends().length
    const conflictTaskBefore = await taskCount()
    const conflictPromptMark = replyPrompts.length
    const conflictTurn = await shellB!.submitOwner('P2G-HINT-CONFLICT：往A群发一条文字：今晚八点开会', 'p2g-conflict')
    assert.equal(conflictTurn.outcome, 'replied')
    await delay(600)
    assert.equal(groupSends().length - conflictSendBefore, 0, '群号与群名矛盾 ⇒ 0 条发送')
    assert.equal(await taskCount(), conflictTaskBefore, '群号与群名矛盾 ⇒ 不落任务')
    const conflictFacts = factPromptsSince(conflictPromptMark)
    assert.equal(conflictFacts.length, 1, `群号/群名矛盾这一轮应当**恰好** 1 条带事实的回复请求（实际 ${conflictFacts.length}）`)
    const conflictFact = conflictFacts[0]!
    assert.ok(conflictFact.includes('group_hint_conflict'),
      `群号与群名矛盾应当具名拒绝 group_hint_conflict：${conflictFact.slice(-400)}`)
    /* 不串轮：不许再带上一轮的 not_found 或更早的 clarify */
    assert.equal(conflictFact.includes('group_task_group_not_found'), false,
      '群号/群名矛盾这一轮不许再带上一轮的 not_found 事实（跨轮泄漏）')
    assert.equal(conflictFact.includes('"kind":"clarify"'), false,
      '群号/群名矛盾这一轮不许再带澄清事实（跨轮泄漏）')

    readings['check03'] = {
      groupListRequests: countAction('get_group_list') - dupGroupListBefore,
      dupFactText: fact.slice(fact.indexOf('【本轮群任务事实】'), fact.indexOf('</context>')),
      ghostFactText: ghostFact.slice(ghostFact.indexOf('【本轮群任务事实】'), ghostFact.indexOf('</context>')),
      conflictFactText: conflictFact.slice(conflictFact.indexOf('【本轮群任务事实】'), conflictFact.indexOf('</context>')),
    }
  })

  /* ------------------- 04 旧名单拒绝而任务可达 ------------------- */
  await check('04 旧名单拒绝而任务可达：isAllowedUser(owner, A群)=false（旧群=true），而 02 那条真的发出去', async () => {
    assert.equal(await shellB!.qq.isAllowedUser(OWNER, G_MAIN), false,
      `旧静态名单必须拒绝 ${G_MAIN}（它不在 QQ_ALLOWED_GROUP_IDS 里）`)
    assert.equal(await shellB!.qq.isAllowedUser(OWNER, G_LEGACY), true,
      `旧静态名单应当放行 ${G_LEGACY}（对照组：旧路径还活着）`)
    assert.ok(groupSends(G_MAIN).length >= 1, '02 那条任务授权发送必须真的到达假 OneBot')
    const denials = [...hostB!.stdout, ...hostB!.stderr]
      .filter((line) => line.includes('qq_target_no_longer_authorized') || line.includes('qq_group_task_send_not_authorized'))
    assert.deepEqual(denials, [], `任务授权发送不该被旧闸拒绝：${denials.slice(-3).join(' | ')}`)
  })
  readings['check04'] = {
    allowedOutside: await shellB!.qq.isAllowedUser(OWNER, G_MAIN),
    allowedLegacy: await shellB!.qq.isAllowedUser(OWNER, G_LEGACY),
    sendsToMainGroup: groupSends(G_MAIN).length,
  }

  /* =======================================================================
   * P3-I ①② `send_once` 真的走桥 ＋ 没有侧信道双发
   * （`artifacts/local/qq-group-p3i/CONTRACT.md` §1 / §4 ①②）
   *
   * ```text
   * 现状（P3-H）：`send_once` 由核心**自建的那条 OneBot 连接**发出
   *   （`ensureQqGroupTaskClient` → `deliverGroupTaskMessage`）。假 OneBot 上
   *   因此有**两条** ws 连接：外壳一条（轮次回复）、核心一条（群列表 + 单发）。
   * 目标（P3-I）：`send_once` 也走桥 ⇒ 群列表走 `LIST_GROUPS`、发送走
   *   `DELIVER_GROUP_TASK` ⇒ 核心**不再自建连接**。
   * ```
   *
   * ⚠️ 判据**不是**"假 OneBot 收到了一条 send_group_msg" —— 那在 P3-H 的侧信道下
   *    也成立（这正是最容易写出"假绿"的地方）。判据是两条**归因**：
   *      a) 那一条是外壳那条连接发的（`connId` 逐字相等），
   *      b) 它由一条 `DELIVER_GROUP_TASK` 指令驱动（`deliveryKey` = 账本实例 id）。
   *    只要还留着侧信道，`a` 立刻红（连接不同），`b` 也红（根本没走处理器）。
   * ===================================================================== */
  /*
   * 外壳那条连接的**徽章**：让外壳自己打一次 `get_group_list`，取那条包的 `connId`。
   * ⚠️ 用 `await` 划窗（不是"最后一条包"）：不依赖时序先后，也不受核心侧并发影响。
   * ⚠️ 取不到时用 `-1` 哨兵（**不在 `check()` 之外抛**：那会中断整个场景，
   *    于是"徽章失败"会被读成"门崩了"而不是"这一条控红了"）。
   */
  const shellConnBadgeMark = packets.length
  await shellB.qq.listGroups()
  const shellConn = packets.slice(shellConnBadgeMark)
    .find((packet) => packet.action === 'get_group_list')?.connId ?? -1
  readings['p3iShellConnection'] = shellConn

  const bridgeCreatePromptMark = replyPrompts.length
  const bridgeTurnStartedAt = Date.now()
  const bridgeTurn = await shellB.submitOwner('P3I-BRIDGE-CREATE：往P3I桥接群发一条文字：今晚八点开会', 'p3i-bridge-create')
  /** 建单那一轮之后才知道的任务行（控 44 也要用） */
  let bridgeTaskId: string | undefined

  await check('43 P3-I ① `send_once` **确实走桥**：send_group_msg 由 DELIVER_GROUP_TASK 指令驱动（deliveryKey=账本实例·正文/群号逐字·外壳连接）', async () => {
    assert.notEqual(shellConn, -1, '夹具：外壳那条连接应当打出一条 `get_group_list`（徽章失败）')
    assert.equal(bridgeTurn.outcome, 'replied',
      `建单轮应当正常回复：${JSON.stringify(bridgeTurn).slice(0, 400)}`)
    await until(() => groupPackets(G_P3I_SEND_ONCE).length > 0,
      'P3-I send_once：桥派发把 send_group_msg 送到假 OneBot', 15_000)
    const packetsThisTurn = groupPackets(G_P3I_SEND_ONCE)
    assert.equal(packetsThisTurn.length, 1,
      `这一轮应当恰好 1 条 send_group_msg（实际 ${packetsThisTurn.length}）：`
      + JSON.stringify(packetsThisTurn.map((packet) => ({ connId: packet.connId, types: segmentTypes(packet) }))))
    const sent = packetsThisTurn[0]!
    /* 正文与群号：与 02 同一条纪律，逐字 */
    const text = segmentsOf(sent).filter((part) => part.type === 'text')
      .map((part) => String(part.data?.text ?? '')).join('')
    assert.equal(text, MSG_MAIN, `正文必须逐字是「${MSG_MAIN}」：${JSON.stringify(text)}`)
    assert.equal(String((sent.params as { group_id?: unknown }).group_id), G_P3I_SEND_ONCE,
      '群号必须逐字是本轮的群')

    /* ①-a **归因到指令**：外壳的派发处理器收到过这一条，且键就是账本里的实例 id */
    const rows = await taskRows(G_P3I_SEND_ONCE)
    assert.equal(rows.length, 1,
      `P3-I 建单后应当**恰好** 1 条 send_once 任务：${JSON.stringify(rows)}`)
    const bridgeTask = rows[0]!
    bridgeTaskId = bridgeTask.id
    const instances = await instanceRows(bridgeTask.id)
    assert.equal(instances.length, 1, `应当恰好 1 条发送实例：${JSON.stringify(instances)}`)
    const instance = instances[0]!
    const instructions = shellB!.dispatches.filter((entry) => entry.taskId === bridgeTask.id)
    assert.equal(instructions.length, 1,
      `这一条发送必须由**恰好一条**桥指令驱动（实际 ${instructions.length} 条）；`
      + `dispatches=${JSON.stringify(shellB!.dispatches)}`)
    const instruction = instructions[0]!
    assert.equal(instruction.deliveryKey, instance.id,
      `指令的 deliveryKey 必须逐字等于账本里的实例 id（那就是这次预留）：`
      + `instruction=${instruction.deliveryKey} · instance=${instance.id}`)
    assert.equal(instruction.media, 'text', `单发文字指令的 media 应当是 text：${instruction.media}`)
    assert.equal(instruction.text, MSG_MAIN, `指令正文必须逐字是「${MSG_MAIN}」：${String(instruction.text)}`)
    assert.ok((instruction.reservedMessages ?? 0) >= 1,
      `指令必须带预留条数（外壳按它做第二道核）：${String(instruction.reservedMessages)}`)

    /* ①-b **归因到连接**：那一条是外壳那条连接发的 */
    assert.equal(sent.connId, shellConn,
      `这条 send_group_msg 必须从**外壳那条连接**发出（侧信道会落在另一条连接上）：`
      + `sent.connId=${sent.connId} · shellConn=${String(shellConn)} · `
      + `各连接发出的 action=${JSON.stringify(connectionsOf(() => true)
        .map((connId) => ({ connId, actions: [...new Set(packetsOfConnection(connId).map((packet) => packet.action))] })))}`)

    /* 结算：平台回执 → 实例 api_accepted + 额度记 1（与 02 同一口径） */
    assert.equal(instance.state, 'api_accepted', `实例应当结算成 api_accepted：${instance.state}`)
    assert.ok(instance.platform_message_id !== null && instance.platform_message_id !== '',
      'api_accepted 必须有 platform_message_id')
    const task = await getGroupTask(db, bridgeTask.id)
    assert.equal(task?.usedMessages, 1, `额度账本记 1 条：${String(task?.usedMessages)}`)
    readings['check43'] = {
      groupId: G_P3I_SEND_ONCE,
      sentConnId: sent.connId, shellConn, segmentTypes: segmentTypes(sent),
      instruction: { deliveryKey: instruction.deliveryKey, media: instruction.media, reservedMessages: instruction.reservedMessages },
      instance, elapsedMs: Date.now() - bridgeTurnStartedAt,
      replyRequestsThisTurn: replyPromptsSince(bridgeCreatePromptMark).length,
    }
  })

  await check('44 P3-I ② **无侧信道双发**：本场景只有外壳那条连接在说话（群列表与发送都来自它）· 同一内容只发 1 条', async () => {
    /*
     * ======================================================================
     *  判据（三条，缺一不可）
     * ======================================================================
     * ```text
     * ① 群列表：`get_group_list` 必须由外壳那条连接打出（P3-H 是核心自建连接打的）
     * ② 发送：`send_group_msg` 同样只来自外壳那条连接
     * ③ 条数：同一正文本场景只发 1 条（"两条路兜底"会变成 2 条）
     * ```
     * ⚠️ 这里**不断言"连接总数 == 1"**：本门自己的 `negativeClient` / 语音客户端
     *    也是连接（它们不是 main 的侧信道；qq-chain 已确认这条口径）。
     *    真正的判据是"**谁**在发" —— 即每条包里自带的 `connId`。
     */
    assert.notEqual(shellConn, -1, '夹具：外壳连接徽章必须存在')
    const listConnections = connectionsOf((packet) => packet.action === 'get_group_list')
    /* 徽章本身那一条也在里面；只要求"全部来自外壳那条连接" */
    assert.deepEqual(listConnections.filter((connId) => connId !== shellConn), [],
      `群列表**不许**由外壳之外的连接请求（那说明核心还在自建 OneBot 连接）：`
      + `shellConn=${shellConn} · listConnections=${JSON.stringify(listConnections)}`)

    const sendConnections = connectionsSendingTo(G_P3I_SEND_ONCE)
    assert.deepEqual(sendConnections, [shellConn],
      `send_once 的那条发送必须只来自外壳那条连接：`
      + `期望 [${String(shellConn)}] · 实际 ${JSON.stringify(sendConnections)}`)
    assert.equal(groupPackets(G_P3I_SEND_ONCE).length, 1,
      `同一内容只许发 1 条（"桥 + 侧信道兜底"会变 2 条）：实际 ${groupPackets(G_P3I_SEND_ONCE).length}`)
    /* 同一 taskId 只许有一条桥指令（重派也会变成 2 条） */
    const instructionsForTask = shellB!.dispatches.filter((entry) => entry.taskId === bridgeTaskId)
    assert.equal(instructionsForTask.length, 1,
      `同一 taskId 只许 1 条派发指令：${JSON.stringify(shellB!.dispatches)}`)
    /* 稳定期再读一次：不许"过一会儿又发一条" */
    await delay(700)
    assert.equal(groupPackets(G_P3I_SEND_ONCE).length, 1,
      `稳定期之后仍必须只有 1 条（不许迟到补发）：${groupPackets(G_P3I_SEND_ONCE).length}`)

    readings['check44'] = {
      shellConn,
      getGroupListConnections: listConnections,
      sendGroupMsgConnections: sendConnections,
      sendsThisScenario: groupPackets(G_P3I_SEND_ONCE).length,
      liveOneBotConnections: [...liveConnections],
      note: '本门自建的客户端（negativeClient / 语音客户端）也是连接，但不是 main 的侧信道；'
        + '判据是"每条包的 connId 是不是外壳那条"。',
    }
  })

  /* ------------------- 09 旧 QQ 默认回复回归 ------------------- */
  await check('09 旧 QQ 回归：同一次真 main 里普通私聊/群聊默认回复仍工作，且不建群任务、不带群任务事实', async () => {
    const taskBefore = await taskCount()
    const privateBefore = sends.filter((send) => send.action === 'send_private_msg').length
    const privatePromptMark = replyPrompts.length
    inbound({ text: '普通私聊 fixture' })
    await until(() => sends.filter((send) => send.action === 'send_private_msg').length > privateBefore,
      'legacy private reply')
    const privateReply = sends.filter((send) => send.action === 'send_private_msg').at(-1)!
    assert.equal(privateReply.userId, OWNER, `普通私聊回复应当发给主人：${JSON.stringify(privateReply)}`)
    assert.equal(privateReply.text, MSG_MODEL, `普通私聊回复正文应当来自模型：${privateReply.text}`)
    /* 普通私聊不是群任务轮 ⇒ 不许带「本轮群任务事实」（跨轮/跨会话泄漏） */
    assert.deepEqual(factPromptsSince(privatePromptMark), [],
      '普通私聊轮不许带「本轮群任务事实」段')

    const groupBefore = groupSends(G_LEGACY).length
    const groupPromptMark = replyPrompts.length
    inbound({ text: '群聊 fixture', groupId: G_LEGACY, userId: MEMBER })
    await until(() => groupSends(G_LEGACY).length > groupBefore, 'legacy group reply')
    const groupReply = groupSends(G_LEGACY).at(-1)!
    assert.equal(groupReply.groupId, G_LEGACY, `普通群聊回复应当回到旧群：${JSON.stringify(groupReply)}`)
    assert.equal(groupReply.text, MSG_MODEL, `普通群聊回复正文应当来自模型：${groupReply.text}`)
    /* 群成员触发的旧群聊回复不是主人私聊 ⇒ 群任务事实**一行都不许进** */
    assert.deepEqual(factPromptsSince(groupPromptMark), [],
      '旧群聊（成员触发）轮不许带「本轮群任务事实」段（跨会话/跨群泄漏）')

    assert.equal(await taskCount(), taskBefore, '普通 QQ 回复不许建群任务')
  })
  readings['check09'] = {
    privateReplies: sends.filter((send) => send.action === 'send_private_msg').length,
    legacyGroupReplies: groupSends(G_LEGACY).length,
  }

  /* =======================================================================
   * 11–13 P3-A：**群入站路由 + 默认规则退后**（正负控）
   *
   * 11 正控：群里有生效中的 reply_window 任务、这条入站在任务范围内
   *        ⇒ 路由判 `task_candidate` ⇒ 这一轮由任务接管（默认闲聊规则退后）。
   * 12 负控：群里有生效中的任务、但这条入站**不在任务范围内**（成员不在名单）
   *        ⇒ 路由判 `suppress` ⇒ **0 条回复、0 次模型调用**（默认路线不许兜底）。
   * 13 负控：群里**没有**任务 ⇒ 走默认路线（逐字旧行为，不带任务接管段）。
   *
   * ⚠️ 群入站**直接交核心**（平台事实走桥）：外壳侧那道静态群名单检查**不在**
   *    本门的读数里（外壳不开库，见批记录 §5 的具名缺口）。
   * ===================================================================== */
  const G_ROUTE_OUT = '10000005'
  const ROUTE_TASK_ID = `qgt:route-main-${stamp}`
  const ROUTE_OUT_TASK_ID = `qgt:route-out-${stamp}`
  const routeNow = Date.now()
  await pool.query(`insert into qq_group_tasks
    (id, contract_version, version, status, kind, bot_id, group_id, content, media, text_fallback,
     trigger, term, quota, used_messages, last_send_at, auth_source, dedupe_key, created_at, updated_at, revoked_at)
    values ($1, 1, 1, 'active', 'reply_window', $2, $3, $4::jsonb, 'text', false, $5::jsonb, $6::jsonb, $7::jsonb,
            0, null, 'owner_qq_private', $8, $9, $9, null), ($10, 1, 1, 'active', 'reply_window', $2, $11, $4::jsonb, 'text', false,
            $12::jsonb, $6::jsonb, $7::jsonb, 0, null, 'owner_qq_private', $13, $9, $9, null)`, [
    ROUTE_TASK_ID, BOT, G_MAIN,
    JSON.stringify({ mode: 'owner_verbatim', text: '路由夹具正文', brief: null }),
    JSON.stringify({ memberIds: [MEMBER], replyToMessageId: null, categories: ['notice', 'learning_qa'], topicScope: '本周排期' }),
    JSON.stringify({ kind: 'window', startAt: routeNow - 60_000, endAt: routeNow + 3_600_000 }),
    JSON.stringify({ totalMaxMessages: 10, perInboundMaxMessages: 3, slot: null, minIntervalMs: 0 }),
    `qq-group-task:${OWNER}:route-main-${stamp}`, routeNow,
    ROUTE_OUT_TASK_ID, G_ROUTE_OUT,
    JSON.stringify({ memberIds: ['999999999'], replyToMessageId: null, categories: [], topicScope: null }),
    `qq-group-task:${OWNER}:route-out-${stamp}`,
  ])

  const routeTaskRows = await taskRows(G_MAIN)
  assert.ok(routeTaskRows.some(row => row.id === ROUTE_TASK_ID), '路由夹具：G_MAIN 应当有一条 reply_window 任务')

  /* --- 11 正控：任务接管 --- */
  const takeoverMark = replyPrompts.length
  const takeoverModelBefore = modelRequests.length
  const takeoverTurn = await shellB.submitGroup('P3-ROUTE-IN：今天几点开会', 'p3-route-in', G_MAIN, MEMBER)
  await check('11 P3 入站路由 · 正控：任务在范围内 ⇒ task_candidate（任务接管 · 默认规则退后 · 恰好 1 条回复）', async () => {
    assert.equal(takeoverTurn.outcome, 'replied', `任务接管轮应当正常回复：${JSON.stringify(takeoverTurn).slice(0, 300)}`)
    const prompts = replyPromptsSince(takeoverMark)
    assert.equal(prompts.length, 1, `任务接管轮应当**恰好** 1 次回复生成（实际 ${prompts.length}）`)
    const prompt = prompts[0]!
    assert.ok(prompt.includes('【本轮群任务接管】'), '任务接管轮必须带「【本轮群任务接管】」段')
    assert.ok(prompt.includes(ROUTE_TASK_ID), `任务接管段必须带上任务 id：${ROUTE_TASK_ID}`)
    assert.ok(prompt.includes('默认的闲聊规则本轮**退后**'), '任务接管段必须写明默认规则退后')
    /*
     * 方案 §5：**类别 / 话题范围**是模型"该不该回"的判据 ⇒ 必须**逐字**出现在 prompt 里。
     * ⚠️ 这只证明"判据到了模型面前"；模型是否遵守**未观察**（门里是假模型）。
     */
    assert.ok(prompt.includes('关注类别：notice、learning_qa'),
      '任务接管段必须带上任务的**类别**事实（模型据此判断该不该回）')
    assert.ok(prompt.includes('话题范围：本周排期'), '任务接管段必须带上任务的**话题范围**事实')
    const routeLogs = [...hostB!.stdout, ...hostB!.stderr].filter(line => line.includes('[qq-group-task] inbound'))
    assert.ok(routeLogs.some(line => line.includes('"route":"task_candidate"')),
      `核心必须记下 task_candidate 路由读数：${routeLogs.slice(-3).join(' | ')}`)
    assert.ok(modelRequests.length > takeoverModelBefore, '任务接管轮应当真的调了模型')
  })
  readings['check11'] = {
    route: 'task_candidate', taskId: ROUTE_TASK_ID, replies: replyPromptsSince(takeoverMark).length,
  }

  /* --- 12 负控：任务在管但消息不在范围 ⇒ 抑制（0 回复 / 0 模型调用） --- */
  const suppressMark = replyPrompts.length
  const suppressModelBefore = modelRequests.length
  const suppressTurn = await shellB.submitGroup('P3-ROUTE-OUT：不在名单里的人说话', 'p3-route-out', G_ROUTE_OUT, MEMBER)
  await check('12 P3 入站路由 · 负控：消息不在任务范围 ⇒ suppress（**no_reply** · 0 条回复 · 0 次模型调用）', async () => {
    /*
     * ADR-156 / P3-C：抑制现在是**`no_reply`**（有意不回），**不再**记成失败。
     * ⚠️ 断言从"不等于 replied"收紧成"正好是 no_reply" —— 否则"失败"也能蒙混过关。
     */
    assert.equal(suppressTurn.outcome, 'no_reply',
      `范围外的群消息必须判"有意不回"而不是失败：${JSON.stringify(suppressTurn).slice(0, 300)}`)
    assert.equal(String(suppressTurn.code ?? ''), 'group_task_inbound_suppressed',
      `抑制必须给出具名码 group_task_inbound_suppressed：${JSON.stringify(suppressTurn).slice(0, 300)}`)
    assert.equal(suppressTurn.delivery, 'none', '有意不回没有任何东西被交付')
    assert.deepEqual(replyPromptsSince(suppressMark), [], '被抑制的入站不许产生任何回复生成')
    assert.equal(modelRequests.length, suppressModelBefore, '被抑制的入站不许调模型（默认规则不许兜底）')
    const routeLogs = [...hostB!.stdout, ...hostB!.stderr].filter(line => line.includes('[qq-group-task] inbound'))
    assert.ok(routeLogs.some(line => line.includes('"route":"suppress"')),
      `核心必须记下 suppress 路由读数：${routeLogs.slice(-3).join(' | ')}`)
  })
  readings['check12'] = { route: 'suppress', replies: replyPromptsSince(suppressMark).length }

  /* --- 13 负控：没有任务 ⇒ 默认路线逐字照旧 --- */
  const defaultMark = replyPrompts.length
  const defaultTurn = await shellB.submitGroup('P3-ROUTE-DEFAULT：没有任务的群', 'p3-route-default', G_LEGACY, MEMBER)
  await check('13 P3 入站路由 · 负控：群里没有任务 ⇒ 走默认路线（旧行为照旧 · 不带任务接管段）', async () => {
    assert.equal(defaultTurn.outcome, 'replied', `没有任务的群应当照旧回复：${JSON.stringify(defaultTurn).slice(0, 300)}`)
    const prompts = replyPromptsSince(defaultMark)
    assert.equal(prompts.length, 1, `默认路线应当恰好 1 次回复生成（实际 ${prompts.length}）`)
    assert.equal(prompts[0]!.includes('【本轮群任务接管】'), false,
      '没有任务的群不许带「【本轮群任务接管】」段（默认规则没退后）')
  })
  readings['check13'] = { route: 'default', replies: replyPromptsSince(defaultMark).length }

  /* =======================================================================
   * 14–15 P3-B：**外壳侧准入**（经真外壳 + 假 OneBot 的完整往返）
   *
   * 14 正控：任务在管的群（**不在**旧静态名单里）从**外壳**进来
   *        ⇒ 外壳把准入下沉给核心 ⇒ 核心 task_candidate ⇒ 回复**真的发回该群**。
   *        （这条同时证明两件：入站没被外壳的旧名单丢掉；回复没被外壳的旧名单拦住）
   * 15 负控：既没有任务、也不在旧名单的群从**外壳**进来
   *        ⇒ 外壳转发（因为下放了）但核心拒绝 ⇒ **0 条群发送 / 0 次模型调用**。
   *        ⇒ "下放"不等于"放行"：准入判定仍在核心，且失败关闭。
   * ===================================================================== */
  const G_UNKNOWN = '10000009'
  const shellMark = replyPrompts.length
  const shellModelBefore = modelRequests.length
  const shellSendBefore = groupSends(G_MAIN).length
  inbound({ text: 'P3-SHELL-IN：群里这条该由任务接管', groupId: G_MAIN, userId: MEMBER })
  const shellInboundId = lastInboundMessageId()
  await check('14 P3-B 外壳准入 · 正控：任务群（不在旧名单）经外壳进来 ⇒ 核心接管并**真的回复到群**', async () => {
    await until(() => groupSends(G_MAIN).length > shellSendBefore, 'shell inbound reply to task group')
    const reply = groupSends(G_MAIN).at(-1)!
    assert.equal(reply.groupId, G_MAIN, `回复必须发回任务群 ${G_MAIN}：${JSON.stringify(reply)}`)
    assert.equal(reply.text, MSG_MODEL, `回复正文应当来自模型：${JSON.stringify(reply.text)}`)
    const prompts = replyPromptsSince(shellMark)
    assert.equal(prompts.length, 1, `经外壳的任务接管轮应当恰好 1 次回复生成（实际 ${prompts.length}）`)
    assert.ok(prompts[0]!.includes('【本轮群任务接管】'), '经外壳的任务接管轮也必须带接管段')
    /* 外壳**没有**用旧名单把这条丢掉（那会记 qq_member_not_authorized） */
    const dropped = shellB!.logs.filter(log => log.event === 'qq_member_not_authorized')
    assert.equal(dropped.length, 0, `外壳不许把任务群的入站按旧名单丢掉：${JSON.stringify(dropped)}`)
    assert.ok(modelRequests.length > shellModelBefore, '任务接管轮应当真的调了模型')
  })
  readings['check14'] = {
    groupId: G_MAIN, shellReply: groupSends(G_MAIN).at(-1), replies: replyPromptsSince(shellMark).length,
  }

  const unknownMark = replyPrompts.length
  const unknownModelBefore = modelRequests.length
  const unknownSendBefore = groupSends(G_UNKNOWN).length
  const unknownShellLogBefore = shellB!.logs.length
  inbound({ text: 'P3-SHELL-UNKNOWN：这个群没有任何授权', groupId: G_UNKNOWN, userId: MEMBER })
  await check('15 P3-B 外壳准入 · 负控：无任务且不在旧名单的群 ⇒ 核心拒绝且**静默**（0 条群发送 · 0 次模型调用 · 0 条失败提示）', async () => {
    await delay(1200)
    assert.equal(groupSends(G_UNKNOWN).length - unknownSendBefore, 0,
      '既没有任务、也不在旧名单的群，一条消息都不许发')
    assert.deepEqual(replyPromptsSince(unknownMark), [], '被核心拒绝的群入站不许产生回复生成')
    assert.equal(modelRequests.length, unknownModelBefore, '被核心拒绝的群入站不许调模型')
    const hostLogs = [...hostB!.stdout, ...hostB!.stderr]
    assert.ok(hostLogs.some(line => line.includes('qq_group_not_authorized')),
      `核心必须给出 qq_group_not_authorized：${hostLogs.slice(-5).join(' | ')}`)
    /*
     * ======================================================================
     *  ⚠️ **P3-H 语义更正（用户裁定 2026-10-29，见门头）**
     * ======================================================================
     * ```text
     * 旧断言：只要核心日志里有 `qq_group_not_authorized` 就算过
     *        ⇒ "结局 failed + 外壳记 lg_turn_failed + 尝试发失败提示"**也能通过**
     * 用户原话：「修正额度耗尽后的处理……**不允许的群静默忽略，不尝试发送失败提示。**」
     *        「旧断言若与修正后的需求冲突，应同步更新，不能为了保持'逐字不动'留下已知错误。」
     * ⇒ 这一支**仍然会被拒**（这是 P3-B 的语义，保留），但**必须静默**：
     *    桥侧 `no_reply`；外壳只记 `qq_no_reply`（具名理由）；**不记** `lg_turn_failed`；
     *    一条群消息都不发（含失败提示）。
     * ⚠️ 这三条是**收紧**：旧行为会记成失败并**尝试**发提示（被旧名单拦住 ⇒ 群里看不到，
     *    但读数语义是"失败"，而且那个语义正是用户裁定要否掉的东西）。
     * ```
     */
    let silence: ShellLog | undefined
    try {
      await until(() => shellB!.logs.slice(unknownShellLogBefore).some(log => log.event === 'qq_no_reply'),
        'qq_no_reply for qq_group_not_authorized')
      silence = shellB!.logs.slice(unknownShellLogBefore).find(log => log.event === 'qq_no_reply')
    } catch (error) {
      const seen = shellB!.logs.slice(unknownShellLogBefore)
        .map(log => `${log.event}:${String(log.reason ?? '')}`)
      assert.fail(`未等到 qq_no_reply（${String(error)}）· 本轮外壳读数=${JSON.stringify(seen.slice(-6))}`
        + ` · 群发送总数=${groupSends().length}`)
    }
    assert.equal(silence!.reason, 'qq_group_not_authorized',
      `qq_no_reply 的理由必须是具名码 qq_group_not_authorized：${JSON.stringify(silence)}`)
    const shellLogsThisTurn = shellB!.logs.slice(unknownShellLogBefore)
    assert.equal(shellLogsThisTurn.some(log => log.event === 'lg_turn_failed'), false,
      `不属于任何任务、旧名单也不放行的群入站**不许**记成失败：${
        JSON.stringify(shellLogsThisTurn.filter(log => log.event === 'lg_turn_failed'))}`)
  })
  readings['check15'] = {
    groupId: G_UNKNOWN,
    sends: groupSends(G_UNKNOWN).length - unknownSendBefore,
    outcome: 'no_reply',
    code: 'qq_group_not_authorized',
    failedPromptSent: false,
  }

  /* =======================================================================
   * 16–17 P3-B-2：**原生引用回复**（方案 §7.1）
   *
   * 16 正控：任务接管轮的回复**带** `{type:'reply', data:{id}}` 段，
   *        引用目标 = **这一条入站**的 `message_id`（外壳从真实入站取，模型给不出），
   *        且仍然**只有一条** `send_group_msg`（引用不是第二条消息 ⇒ 不额外占额度）。
   * 17 负控：**默认路线**（旧行为）的群回复**不带**引用段 ⇒ 旧行为逐字不变。
   * ===================================================================== */
  await check('16 P3-B-2 原生引用回复 · 正控：任务接管轮引用**本条入站**且不额外多发一条', async () => {
    const groupPackets = packets.filter(packet => packet.action === 'send_group_msg'
      && String((packet.params as { group_id?: unknown }).group_id) === G_MAIN)
    const last = groupPackets.at(-1)!
    const message = (last.params as { message?: unknown }).message
    assert.ok(Array.isArray(message), `send_group_msg 必须带 message 段数组：${JSON.stringify(last.params).slice(0, 200)}`)
    const first = (message as { type?: unknown; data?: { id?: unknown } }[])[0]
    assert.equal(first?.type, 'reply', `任务接管轮的第一个段必须是 reply：${JSON.stringify(first)}`)
    assert.equal(String(first?.data?.id), String(shellInboundId),
      `引用目标必须是**本条入站**的 message_id=${shellInboundId}（不是别的消息、不是模型给的）：${JSON.stringify(first)}`)
    /*
     * 这一轮**只有一条**群发送：引用与正文在同一条消息里，不是两条。
     * ⚠️ 只数**本轮增量**（02/11 也往同一个群发过东西）；基准是这条入站之前的读数。
     */
    assert.equal(groupPackets.length - shellSendBefore, 1,
      `任务接管轮只许发一条群消息（本轮实际 ${groupPackets.length - shellSendBefore}）`)
  })
  readings['check16'] = { quoteTarget: shellInboundId, sendsInTurn: 1 }

  const legacyQuoteBefore = packets.filter(packet => packet.action === 'send_group_msg'
    && String((packet.params as { group_id?: unknown }).group_id) === G_LEGACY).length
  /*
   * ⚠️ 用**主人**发这条：多用户档下"同一群同一个人"有 3 秒限流（09 那条刚用过同一个键），
   *    那会让本控因**限流**假失败，与引用无关。
   */
  const legacyInboundId = inbound({ text: 'P3-QUOTE-DEFAULT：旧路线不加引用', groupId: G_LEGACY, userId: OWNER })
  await check('17 P3-B-2 原生引用回复 · 正控：默认路线（非接管轮）的群回复**也**带引用段，目标是本条入站', async () => {
    await until(() => packets.filter(packet => packet.action === 'send_group_msg'
      && String((packet.params as { group_id?: unknown }).group_id) === G_LEGACY).length > legacyQuoteBefore,
    'legacy group reply after quote check')
    const legacyPackets = packets.filter(packet => packet.action === 'send_group_msg'
      && String((packet.params as { group_id?: unknown }).group_id) === G_LEGACY)
    const message = (legacyPackets.at(-1)!.params as { message?: unknown }).message
    assert.ok(Array.isArray(message), '旧路线的群回复也必须带 message 段数组')
    const segments = message as { type?: unknown; data?: { id?: unknown } }[]
    const types = segments.map(part => part.type)
    /*
     * 语义翻转（2026-10-29 用户裁定「一到五全改」第 3 条：普通群回复加引用框）。
     *
     * ```text
     * 旧断言：默认路线**不许**带 `{type:'reply'}`（那时只有任务接管轮带）
     * 新契约：默认路线**也**带，引用目标同样是 `receive()` 里已经校验过的**本条入站** id
     * ```
     * ⚠️ 强度不变（不是放宽）：仍然要求"有 reply 段"且"引用目标逐字等于本条入站 id"，
     *    并把旧的 `false` 预期翻成 `true` —— 翻转的是**契约**，不是判据的严格程度。
     */
    assert.equal(segments[0]?.type, 'reply',
      `默认路线的群回复第一个段必须是 reply：${JSON.stringify(types)}（入站 id=${legacyInboundId}）`)
    assert.equal(String(segments[0]?.data?.id), String(legacyInboundId),
      `引用目标必须是**本条入站**的 message_id=${legacyInboundId}：${JSON.stringify(segments[0])}`)
    assert.equal(types.includes('text'), true, `默认路线的群回复仍必须是文字：${JSON.stringify(types)}`)
    const semanticInput = semanticModelInputs.map(raw => {
      const body = JSON.parse(raw)
      return JSON.parse(body.messages.at(-1).content) as { current?: { text?: string }; conversationContext?: string[] }
    }).find(input => input.current?.text?.startsWith('P3-QUOTE-DEFAULT'))
    assert(semanticInput?.conversationContext?.some(line => line.includes('当前待答')
      && line.includes(`"messageId":"${legacyInboundId}"`)), '指向与消息身份必须进入真实语义入口请求')
    assert(replyPrompts.at(-1)?.includes('本轮群消息的指向与时间'), '主回复也必须收到本轮指向信息')
  })
  readings['check17'] = { quoteInDefaultPath: true }

  /* =======================================================================
   * 18 P3-C：**有意不回经外壳**（`no_reply` 的端到端行为）
   *
   * 范围外的群成员在**任务在管的群**里说话 ⇒ 核心判 suppress ⇒ 结局 `no_reply`
   * ⇒ 外壳**什么都不发**：不回复、不发"失败提示"、不重试，只记一条 `qq_no_reply`。
   * ⚠️ 这条专治"沉默被记成失败"：旧行为会往群里发一句"这轮回复没有完成……"。
   * ===================================================================== */
  const noReplySendBefore = packets.filter(packet => packet.action === 'send_group_msg'
    && String((packet.params as { group_id?: unknown }).group_id) === G_ROUTE_OUT).length
  const noReplyLogBefore = shellB!.logs.length
  inbound({ text: 'P3-NOREPLY-OUT：不在名单里的人说话', groupId: G_ROUTE_OUT, userId: MEMBER })
  await check('18 P3-C 有意不回 · 经外壳：抑制轮**一条消息都不发**（连失败提示也不发）', async () => {
    await until(() => shellB!.logs.slice(noReplyLogBefore).some(log => log.event === 'qq_no_reply'),
      'qq_no_reply reading from the shell')
    const noReplyLogs = shellB!.logs.slice(noReplyLogBefore)
    const silence = noReplyLogs.find(log => log.event === 'qq_no_reply')!
    assert.equal(silence.reason, 'group_task_inbound_suppressed',
      `外壳必须记下具名理由（不是"未知"）：${JSON.stringify(silence)}`)
    /* 外壳**没有**把这条当成失败（那会记 lg_turn_failed 并给群里发提示） */
    assert.equal(noReplyLogs.some(log => log.event === 'lg_turn_failed'), false,
      `有意不回不许记成失败：${JSON.stringify(noReplyLogs.filter(log => log.event === 'lg_turn_failed'))}`)
    /* 一条群消息都不许发（含失败提示） */
    assert.equal(packets.filter(packet => packet.action === 'send_group_msg'
      && String((packet.params as { group_id?: unknown }).group_id) === G_ROUTE_OUT).length, noReplySendBefore,
    '有意不回不许往群里发任何东西（包括"失败提示"）')
  })
  readings['check18'] = { outcome: 'no_reply', sentAnything: false }

  /* =======================================================================
   * 19 P3-F：**模型显式拒答**（"这条不在任务范围内"）⇒ 静默，不发送、不算失败
   *
   * 触发：入站正文含魔法词 ⇒ 假模型回显**拒答标记** ⇒ 核心在交出回复前识别它
   * 期望：0 条群发送 · 0 条失败提示 · 外壳记 `qq_no_reply{reason:group_task_model_declined}`
   *       · **不是** `lg_turn_failed`（拒答是正常结果，不是故障）
   * ===================================================================== */
  const declineSendBefore = packets.filter(packet => packet.action === 'send_group_msg'
    && String((packet.params as { group_id?: unknown }).group_id) === G_MAIN).length
  const declineTurn = await shellB.submitGroup(`P3-DECLINE：这条${FAKE_MODEL_DECLINE_TOKEN}`, 'p3-decline', G_MAIN, MEMBER)
  await check('19 P3-F 模型显式拒答 · 桥侧结局：no_reply + 具名码 + 无交付', async () => {
    assert.notEqual(declineTurn.outcome, 'replied', `模型拒答时不该产出回复：${JSON.stringify(declineTurn).slice(0, 240)}`)
    assert.equal(String(declineTurn.code ?? ''), 'group_task_model_declined',
      `拒答必须给出具名码 group_task_model_declined：${JSON.stringify(declineTurn).slice(0, 240)}`)
    assert.equal(declineTurn.delivery, 'none', '拒答没有任何东西被交付')
    assert.equal(packets.filter(packet => packet.action === 'send_group_msg'
      && String((packet.params as { group_id?: unknown }).group_id) === G_MAIN).length, declineSendBefore,
    '模型拒答时一条群消息都不许发')
  })
  readings['check19'] = { outcome: 'no_reply', reason: 'group_task_model_declined', sentAnything: false }

  /* --- 同一拒答**经真外壳**再走一遍：外壳侧不许发提示、不许记成失败 --- */
  const declineShellLogBefore = shellB!.logs.length
  const declineShellSendBefore = packets.filter(packet => packet.action === 'send_group_msg'
    && String((packet.params as { group_id?: unknown }).group_id) === G_MAIN).length
  /*
   * ⚠️ 用 **MEMBER**（G_MAIN 那个任务的 `memberIds` 成员）：
   *    主人本人**不在**该任务的成员名单里 ⇒ 会被**成员范围**先拒（那是控 18 的事）。
   * ⚠️ 必须先等过外壳的 3 秒限流窗口（同群同人）：控 19 刚用过这个键。
   */
  await delay(3200)
  inbound({ text: `P3-DECLINE-SHELL：这条${FAKE_MODEL_DECLINE_TOKEN}`, groupId: G_MAIN, userId: MEMBER })
  await check('20 P3-F 模型显式拒答 · 外壳侧：记 qq_no_reply（不是 failed）· 不发失败提示', async () => {
    try {
      await until(() => shellB!.logs.slice(declineShellLogBefore).some(log => log.event === 'qq_no_reply'),
        'qq_no_reply reading from the shell')
    } catch (error) {
      const tail = shellB!.logs.slice(-6).map(log => `${log.event}:${(log as { reason?: string }).reason ?? ''}`)
      const seen = shellB!.logs.slice(declineShellLogBefore).filter(log => log.event === 'qq_inbound_seen').length
      assert.fail(`未等到 qq_no_reply（${String(error)}）· 末几条=${JSON.stringify(tail)} · 本轮 seen=${seen} · 群发送总数=${packets.filter(p => p.action === 'send_group_msg').length}`)
    }
    const declineLogs = shellB!.logs.slice(declineShellLogBefore)
    const silence = declineLogs.find(log => log.event === 'qq_no_reply')!
    assert.equal(silence.reason, 'group_task_model_declined',
      `qq_no_reply 的理由必须是具名码：${JSON.stringify(silence)}`)
    assert.equal(declineLogs.some(log => log.event === 'lg_turn_failed'), false,
      `拒答**不是**失败，不许记 lg_turn_failed：${JSON.stringify(declineLogs.filter(log => log.event === 'lg_turn_failed'))}`)
    assert.equal(packets.filter(packet => packet.action === 'send_group_msg'
      && String((packet.params as { group_id?: unknown }).group_id) === G_MAIN).length, declineShellSendBefore,
    '模型拒答时一条群消息都不许发（包括失败提示）')
  })
  readings['check20'] = { shell: 'qq_no_reply', failedLogged: false, sentAnything: false }

  /* =======================================================================
   * 21–29 P3-G：**接管轮计入额度 + 派发/回执/结算**（CONTRACT §4/§5）
   *
   * ============================================================================
   *  ⚠️ 额度是**两层、两本账**（Lead 已按此裁定并改契约 §5）
   * ============================================================================
   * ```text
   * 路由层  qq-group-inbound-routing.ts:106 读 active.usedMessages（**已结算列**）
   *         ⇒ "顺序第二条"：used(1) >= totalMax(1) ⇒ suppress
   *            ⇒ 结局 no_reply + 具名码 group_task_total_budget_exhausted
   * 派发层  reserveGroupSend 读**实例账本**（reserved_messages 之和，行锁事务）
   *         ⇒ "并发/在途"：两轮都能过路由（结算之前 used 都还是 0），
   *            第二条在**预留**时被拒 ⇒ not_attempted + 具名额度码
   * ```
   * ⚠️ 所以"上限 1 时只发 1 条"有**两个不同**的具名结局，两者都是额度生效的证据；
   *    唯一算缺陷的是"两条都真的发出去"。把 `no_reply` 读成"额度没生效"是**误读**。
   * ⚠️ 这也是"原子预留不是先查再写"的唯一证据面：先查再写会让两条**都**通过。
   * ===================================================================== */
  const G_QUOTA_SEQ = '10000021'
  const G_SETTLE_OK = '10000023'
  const G_SETTLE_FAIL = '10000024'
  const G_SETTLE_UNKNOWN = '10000025'
  const G_NODOUBLE = '10000026'
  const G_RESULT = '10000027'
  const G_QUOTA_INFLIGHT = '10000028'
  const G_QUOTE = '10000029'
  const P3G = {
    quotaSeq: `qgt:p3g-quota-seq-${stamp}`,
    settleOk: `qgt:p3g-settle-ok-${stamp}`,
    settleFail: `qgt:p3g-settle-fail-${stamp}`,
    settleUnknown: `qgt:p3g-settle-unknown-${stamp}`,
    noDouble: `qgt:p3g-no-double-${stamp}`,
    result: `qgt:p3g-result-${stamp}`,
    quotaInflight: `qgt:p3g-quota-inflight-${stamp}`,
    quote: `qgt:p3g-quote-${stamp}`,
  } as const
  /** `TURN_RESULT.groupTaskDispatch`（缺席 ⇒ undefined；K5 的机器判据就是它） */
  const dispatchOf = (turn: Record<string, unknown>): Record<string, unknown> | undefined =>
    turn.groupTaskDispatch === undefined
      ? undefined
      : turn.groupTaskDispatch as Record<string, unknown>
  /** 本轮新到的外壳读数（按 mark 划窗：**不**跨轮取最后一条） */
  const shellLogsSince = (mark: number): ShellLog[] => shellB!.logs.slice(mark)
  /**
   * 等一条**可能晚到**的外壳读数（带超时；到点仍没有 ⇒ 返回 `log: undefined` 让断言报读数）。
   *
   * ============================================================================
   *  为什么必须轮询：`qq_group_task_dispatch_settled` 是**轮次收尾之后**才写的
   * ============================================================================
   * ```text
   * 时序（外壳 `receive()`）：
   *   假 OneBot 收到 send_group_msg   ← 轮次**内部**（核心派发时就发了）
   *   → 核心结算（实例落 api_accepted）← 也在轮次内部
   *   → 核心把 TURN_RESULT 交回外壳
   *   → 外壳才写 `qq_group_task_dispatch_settled`   ← **最后**
   * ⇒ 门若在"看到那条发送/那条实例"的**同一瞬间**去读这条读数，读到的是 `undefined`。
   * ```
   * ⚠️ **这不是假设，是一次真实的假红**：2026-10-29 容器读数 **40/42**，控 28 就红在这里
   *    （同一份门 + 同一份 src，本机 42/42 —— 本机同进程几乎瞬间落下，容器里慢一点就露出来了）。
   * ⇒ 一律**带超时轮询**，并把"等了多久"写进读数：**不**把这笔时间藏起来。
   */
  const waitShellEvent = async (
    mark: number,
    event: string,
    timeoutMs = 8_000,
  ): Promise<{ log?: ShellLog; waitedMs: number }> => {
    const startedAt = Date.now()
    const find = (): ShellLog | undefined => shellB!.logs.slice(mark).find((log) => log.event === event)
    for (;;) {
      const hit = find()
      if (hit !== undefined) return { log: hit, waitedMs: Date.now() - startedAt }
      if (Date.now() - startedAt >= timeoutMs) return { waitedMs: Date.now() - startedAt }
      await delay(100)
    }
  }

  /* ------------------- 21 额度有效 · 顺序两条入站 ------------------- */
  await insertReplyTask({ id: P3G.quotaSeq, groupId: G_QUOTA_SEQ, totalMaxMessages: 1 })
  const quotaSeqMark = groupPackets(G_QUOTA_SEQ).length
  const quotaSeqPromptMark = replyPrompts.length
  const quotaSeqFirst = await shellB.submitGroup('P3G-QUOTA-SEQ-1：第一条', 'p3g-quota-seq-1', G_QUOTA_SEQ, MEMBER)
  const quotaSeqSecond = await shellB.submitGroup('P3G-QUOTA-SEQ-2：第二条', 'p3g-quota-seq-2', G_QUOTA_SEQ, MEMBER)
  await check('21 P3-G 额度有效 · 顺序两条入站：只发 1 条；第二条被**准入门**拒（任务已 exhausted）· 0 条发送', async () => {
    await until(() => instanceRows(P3G.quotaSeq).then((rows) => rows.length > 0), 'quota seq instance row')
    await delay(400)
    const firstDispatch = dispatchOf(quotaSeqFirst)
    /* 反例断言：第一条必须**真的**走完派发，否则"只发 1 条"可以由"一条都没发"蒙混 */
    assert.ok(firstDispatch !== undefined,
      `第一条必须带 groupTaskDispatch（K5 的机器判据）：${JSON.stringify(quotaSeqFirst).slice(0, 400)}`)
    assert.equal(firstDispatch!.status, 'api_accepted',
      `第一条应当被平台接受：${JSON.stringify(firstDispatch)}`)
    assert.equal('replyText' in quotaSeqFirst, false,
      'K5：带 groupTaskDispatch 的 TURN_RESULT 不许带 replyText（线缆那一行 JSON 里键都不该存在）')
    const sent = groupPackets(G_QUOTA_SEQ).length - quotaSeqMark
    assert.equal(sent, 1, `上限 1：两条入站只能发 1 条（实际 ${sent}）`)
    const packet = groupPackets(G_QUOTA_SEQ).at(-1)!
    const text = segmentsOf(packet).filter((part) => part.type === 'text')
      .map((part) => String(part.data?.text ?? '')).join('')
    assert.equal(text, MSG_MODEL, `那一条的正文必须逐字来自模型：${JSON.stringify(text)}`)

    /*
     * ======================================================================
     *  第二条的**真实**结局（门在这里如实读，不按契约想象）
     * ======================================================================
     * ```text
     * 预期（契约 §5 / 裁定）：路由层 usedMessages(1) >= totalMax(1) ⇒ suppress
     *                        ⇒ no_reply + group_task_total_budget_exhausted
     * 实测：结算那一步 `decideTaskAfterSendSettlement` 在 used 达到 total **同时**
     *      把任务标成终态 `exhausted`（`settleGroupSend` → status='exhausted', version+1）
     *      ⇒ 第二条入站时 `replyWindowTasks()` 里已经没有它（只有 active|paused 参与路由）
     *      ⇒ `decideGroupAdmission` 判 denied ⇒ 准入层拒绝 `qq_group_not_authorized`
     * ```
     * ⇒ 两条都是"额度生效"的证据（第二条一条也没发），但**具名额度码不在这条路径上**：
     *   `group_task_total_budget_exhausted` 的真实产生点是**预留层**（见控 23）。
     * ⚠️ 这是产品侧与契约 §5 的口径冲突（已如实报给 Lead），门不在这里编一个
     *    "no_reply + 额度码"来把契约凑绿。
     *
     * ⚠️ **P3-H 更正（用户裁定 2026-10-29，见门头）**：
     * ```text
     * 旧断言：`outcome === 'failed'` + `code === 'qq_group_not_authorized'`
     * 用户原话：「修正额度耗尽后的处理。任务结束后恢复默认规则……不允许的群静默忽略，
     *           不尝试发送失败提示。」「旧断言若与修正后的需求冲突，应同步更新。」
     * ⇒ `qq_group_not_authorized` 进 `BRIDGE_SILENT_CODES` ⇒ 桥把这一支映射成
     *    `no_reply` + `delivery:'none'`（**不是** failed）。
     * ⇒ 这里改的是**结局的形状**，判据（0 条发送 / 不再调模型 / 任务确已终态）**一条没放松**。
     * ```
     */
    assert.equal(quotaSeqSecond.outcome, 'no_reply',
      `第二条的实测结局：额度耗尽 ⇒ 准入拒绝 ⇒ 桥把它映射成"有意不回"（不是 failed）：${
        JSON.stringify(quotaSeqSecond).slice(0, 300)}`)
    assert.equal(String(quotaSeqSecond.code ?? ''), 'qq_group_not_authorized',
      `第二条的实测具名码（任务 exhausted ⇒ 准入 denied）：${JSON.stringify(quotaSeqSecond).slice(0, 300)}`)
    assert.equal(quotaSeqSecond.delivery, 'none',
      `有意不回没有任何东西被交付：${JSON.stringify(quotaSeqSecond).slice(0, 300)}`)
    assert.equal(dispatchOf(quotaSeqSecond), undefined, '第二条不该有派发读数（它没走到派发层）')
    assert.equal(groupPackets(G_QUOTA_SEQ).length - quotaSeqMark, 1,
      `第二条过去之后仍然只能有 1 条（实际 ${groupPackets(G_QUOTA_SEQ).length - quotaSeqMark}）`)
    /* 反例断言：第二条**必须真的到过核心**（否则"0 条发送"可能只是"消息没送到"） */
    const hostLines = [...hostB!.stdout, ...hostB!.stderr]
    assert.ok(hostLines.some((line) => line.includes('qq_group_not_authorized')),
      `核心必须留下第二条的具名拒绝：${hostLines.slice(-5).join(' | ')}`)
    /* 第二条在准入层就被拒 ⇒ 不该白白再调一次模型 */
    assert.equal(replyPromptsSince(quotaSeqPromptMark).length, 1,
      `额度耗尽后第二条不该再产生模型调用（本轮回复请求应当只有第一条那一次）：${
        replyPromptsSince(quotaSeqPromptMark).length}`)

    const instances = await instanceRows(P3G.quotaSeq)
    assert.equal(instances.length, 1, `上限 1 只该有 1 条实例：${JSON.stringify(instances)}`)
    assert.equal(instances[0]!.reserved_messages, 1, `文字回复预留 1 条：${instances[0]!.reserved_messages}`)
    const task = await getGroupTask(db, P3G.quotaSeq)
    assert.equal(task?.usedMessages, 1, `额度账本应当记 1 条：${task?.usedMessages}`)
    assert.equal(task?.status, 'exhausted',
      `额度用尽 ⇒ 任务终态 exhausted（这正是第二条被准入拒绝的原因）：${task?.status}`)
    assert.equal(task?.version, 2,
      `结算把任务版本 +1（exhausted 是一次真实的状态迁移）：${task?.version}`)
    readings['check21'] = {
      sent,
      second: {
        outcome: quotaSeqSecond.outcome, code: quotaSeqSecond.code, delivery: quotaSeqSecond.delivery,
      },
      instances,
      task: { status: task?.status, usedMessages: task?.usedMessages, version: task?.version },
      contractConflict: '契约 §5 预期 no_reply+group_task_total_budget_exhausted；'
        + '实测第二条是准入层 qq_group_not_authorized（结算已把任务置 exhausted ⇒ 不再参与路由）',
      p3hCorrection: 'P3-H：`qq_group_not_authorized` 进 BRIDGE_SILENT_CODES ⇒ 结局形状由 failed 更正为 '
        + 'no_reply + delivery=none（用户裁定：不允许的群静默忽略）。判据 0 条发送 / 不再调模型 / 任务终态未放松。',
    }
  })

  /* ------------------- 24 结算准确 · api_accepted ------------------- */
  await insertReplyTask({ id: P3G.settleOk, groupId: G_SETTLE_OK, totalMaxMessages: 10 })
  const shellMarkOk = shellB.logs.length
  const settleOkTurn = await shellB.submitGroup('P3G-SETTLE-OK：平台接受', 'p3g-settle-ok', G_SETTLE_OK, MEMBER)
  await check('24 P3-G 结算准确 · api_accepted：实例落 api_accepted + 平台 message_id；额度记 1 条', async () => {
    const dispatch = dispatchOf(settleOkTurn)
    assert.ok(dispatch !== undefined, `接管轮必须带 groupTaskDispatch：${JSON.stringify(settleOkTurn).slice(0, 400)}`)
    assert.equal(dispatch!.status, 'api_accepted', `平台接受了这条：${JSON.stringify(dispatch)}`)
    assert.equal(typeof dispatch!.messageId === 'string' && String(dispatch!.messageId).trim() !== '', true,
      `api_accepted 必须带平台回执 id：${JSON.stringify(dispatch)}`)
    await until(() => instanceRows(P3G.settleOk).then((rows) => rows.length === 1), 'settle ok instance')
    const instance = (await instanceRows(P3G.settleOk))[0]!
    assert.equal(instance.state, 'api_accepted', `实例结局必须是 api_accepted：${instance.state}`)
    assert.ok(instance.platform_message_id !== null && instance.platform_message_id !== '',
      'api_accepted 必须落 platform_message_id（DDL 也约束了）')
    assert.equal(instance.reserved_messages, 1, `文字回复预留 1 条：${instance.reserved_messages}`)
    const task = await getGroupTask(db, P3G.settleOk)
    assert.equal(task?.usedMessages, 1, `api_accepted 计入 1 条额度：${task?.usedMessages}`)
    assert.equal(task?.status, 'active', `成功结算不该改任务状态：${task?.status}`)
    const events = await eventNames(P3G.settleOk)
    for (const expected of ['send_reserved', 'send_settled']) {
      assert.ok(events.includes(expected), `事件链缺 ${expected}：${events.join(',')}`)
    }
    const settled = shellLogsSince(shellMarkOk).find((log) => log.event === 'qq_group_task_dispatch_delivered'
      && String(log.requestId ?? '') === String(dispatch!.deliveryKey ?? ''))
    assert.ok(settled !== undefined,
      `外壳必须记下这一条派发的结算读数（qq_group_task_dispatch_delivered）：${
        JSON.stringify(shellLogsSince(shellMarkOk).slice(-4))}`)
    assert.equal((settled as unknown as { deliveredCount?: number }).deliveredCount, 1,
      `deliveredCount 只数平台已接受的条数：${JSON.stringify(settled)}`)
    assert.equal(settled!.reason, 'api_accepted',
      `外壳读数必须与回执同源：${JSON.stringify(settled)}`)
    readings['check24'] = { dispatch, instance, usedMessages: task?.usedMessages ?? null, events, settled }
  })

  /* ------------------- 25 结算准确 · failed_confirmed ------------------- */
  await insertReplyTask({ id: P3G.settleFail, groupId: G_SETTLE_FAIL, totalMaxMessages: 10 })
  sendModes.set(G_SETTLE_FAIL, 'error')
  const shellMarkFail = shellB.logs.length
  const settleFailFailMark = groupPackets(G_SETTLE_FAIL).length
  const settleFailTurn = await shellB.submitGroup('P3G-SETTLE-FAIL：平台明确拒绝', 'p3g-settle-fail', G_SETTLE_FAIL, MEMBER)
  await check('25 P3-G 结算准确 · failed_confirmed：平台拒绝 ⇒ 实例 failed_confirmed、不计额度、不重试', async () => {
    try {
      const dispatch = dispatchOf(settleFailTurn)
      assert.ok(dispatch !== undefined, `接管轮必须带 groupTaskDispatch：${JSON.stringify(settleFailTurn).slice(0, 400)}`)
      assert.equal(dispatch!.status, 'failed_confirmed',
        `平台明确拒绝 ⇒ failed_confirmed（不是 unknown）：${JSON.stringify(dispatch)}`)
      assert.equal(String(dispatch!.reason ?? ''), 'onebot_api_failed',
        `必须带具名理由：${JSON.stringify(dispatch)}`)
      assert.equal('replyText' in settleFailTurn, false,
        'K5：派发过的轮次不许再带 replyText（否则外壳会再发一条）')
      await until(() => instanceRows(P3G.settleFail).then((rows) => rows.length === 1), 'settle fail instance')
      const instance = (await instanceRows(P3G.settleFail))[0]!
      assert.equal(instance.state, 'failed_confirmed', `实例必须是 failed_confirmed：${instance.state}`)
      assert.equal(instance.platform_message_id, null, '失败不许编一个平台回执 id')
      const task = await getGroupTask(db, P3G.settleFail)
      assert.equal(task?.usedMessages, 0, `明确失败不占额度：${task?.usedMessages}`)
      assert.equal(task?.status, 'active', `明确失败不该暂停任务：${task?.status}`)
      /* 一次调用 = 一次尝试：不许重试（假 OneBot 的尝试次数是唯一证据面） */
      const attempted = groupPackets(G_SETTLE_FAIL).length - settleFailFailMark
      assert.equal(attempted, 1, `失败只许尝试 1 次（实际 ${attempted}）`)
      await delay(900)
      assert.equal(groupPackets(G_SETTLE_FAIL).length - settleFailFailMark, 1,
        '失败之后不许重试（假 OneBot 计数不增）')
      const settled = shellLogsSince(shellMarkFail).find((log) => log.event === 'qq_group_task_dispatch_delivered'
        && String(log.requestId ?? '') === String(dispatch!.deliveryKey ?? ''))
      assert.ok(settled !== undefined,
        `外壳必须记下这一条派发的结算读数：${JSON.stringify(shellLogsSince(shellMarkFail).slice(-4))}`)
      assert.equal((settled as unknown as { deliveredCount?: number }).deliveredCount, 0,
        `明确失败 ⇒ 平台已接受 0 条：${JSON.stringify(settled)}`)
      assert.equal(settled!.reason, 'failed_confirmed:onebot_api_failed',
        `外壳读数必须带三态 + 具名理由：${JSON.stringify(settled)}`)
      readings['check25'] = { dispatch, instance, usedMessages: task?.usedMessages ?? null, attempted, settled }
    } finally {
      sendModes.delete(G_SETTLE_FAIL)
    }
  })

  /* ------------------- 26 结算准确 · delivery_unknown ------------------- */
  await insertReplyTask({ id: P3G.settleUnknown, groupId: G_SETTLE_UNKNOWN, totalMaxMessages: 10 })
  sendModes.set(G_SETTLE_UNKNOWN, 'no_id')
  const shellMarkUnknown = shellB.logs.length
  const unknownMarkPackets = groupPackets(G_SETTLE_UNKNOWN).length
  const settleUnknownTurn = await shellB.submitGroup('P3G-SETTLE-UNKNOWN：接受但无回执 id', 'p3g-settle-unknown', G_SETTLE_UNKNOWN, MEMBER)
  await check('26 P3-G 结算准确 · delivery_unknown：无回执 id ⇒ 实例 unknown + 任务 paused；**不重发、不切侧信道**', async () => {
    try {
      const dispatch = dispatchOf(settleUnknownTurn)
      assert.ok(dispatch !== undefined, `接管轮必须带 groupTaskDispatch：${JSON.stringify(settleUnknownTurn).slice(0, 400)}`)
      assert.equal(dispatch!.status, 'delivery_unknown',
        `接受了却没有回执 id ⇒ 结果未知（不是失败、也不是成功）：${JSON.stringify(dispatch)}`)
      assert.equal(String(dispatch!.reason ?? ''), 'qq_delivery_unconfirmed',
        `必须带具名理由：${JSON.stringify(dispatch)}`)
      await until(() => instanceRows(P3G.settleUnknown).then((rows) => rows.length === 1), 'settle unknown instance')
      const instance = (await instanceRows(P3G.settleUnknown))[0]!
      assert.equal(instance.state, 'unknown', `实例必须落 unknown：${instance.state}`)
      assert.equal(instance.platform_message_id, null, '结果未知不许编平台回执 id')
      const task = await getGroupTask(db, P3G.settleUnknown)
      assert.equal(task?.usedMessages, 1, `unknown 保守计入 1 条额度：${task?.usedMessages}`)
      assert.equal(task?.status, 'paused', `unknown 必须把任务置 paused（结果不明绝不继续发）：${task?.status}`)
      /* 不重发、不切侧信道补发：唯一证据面是假 OneBot 的计数不再增长 */
      const attempted = groupPackets(G_SETTLE_UNKNOWN).length - unknownMarkPackets
      assert.equal(attempted, 1, `未知结局只许尝试 1 次（实际 ${attempted}）`)
      await delay(1200)
      assert.equal(groupPackets(G_SETTLE_UNKNOWN).length - unknownMarkPackets, 1,
        'unknown 之后假 OneBot 计数不增（不重发、不切侧信道补发）')
      const settled = shellLogsSince(shellMarkUnknown).find((log) => log.event === 'qq_group_task_dispatch_delivered'
        && String(log.requestId ?? '') === String(dispatch!.deliveryKey ?? ''))
      assert.ok(settled !== undefined,
        `外壳必须记下这一条派发的结算读数：${JSON.stringify(shellLogsSince(shellMarkUnknown).slice(-4))}`)
      /*
       * 平台回了 `ok` 但**没有 `message_id`** ⇒ 外壳侧连"这条被接受"都无法确认
       *   （`sendSegments` 抛 `qq_delivery_unconfirmed`）⇒ `deliveredCount=0`。
       * ⚠️ 这不是缺陷：`deliveredCount` 的定义是"**已确认**被平台接受的条数"，
       *    这一例的诚实读数就是 0（同时整体结局是 `delivery_unknown`，不是 failed）。
       */
      assert.equal((settled as unknown as { deliveredCount?: number }).deliveredCount, 0,
        `无回执 id ⇒ 无法确认接受 ⇒ deliveredCount=0：${JSON.stringify(settled)}`)
      assert.equal(settled!.reason, 'delivery_unknown:qq_delivery_unconfirmed',
        `外壳读数必须带三态 + 具名理由：${JSON.stringify(settled)}`)
      readings['check26'] = {
        dispatch, instance, usedMessages: task?.usedMessages ?? null, status: task?.status, attempted, settled,
      }
    } finally {
      sendModes.delete(G_SETTLE_UNKNOWN)
    }
  })

  /* ------------------- 23 额度有效 · 派发层 not_attempted --------------- */
  await insertReplyTask({ id: P3G.quotaInflight, groupId: G_QUOTA_INFLIGHT, totalMaxMessages: 1 })
  /*
   * 夹具：账本里**已有**一条在途预留占满额度，而 `used_messages` 还是 0
   *   ⇒ 路由层放行（used=0 < 1）⇒ 派发层预留被拒 ⇒ `not_attempted`。
   * 这正是"路由层与派发层读两本账"的那条缝隙，也是本组唯一能拿到
   * `not_attempted` 的真实形态（顺序第二条在路由层就被拦下了）。
   */
  await pool.query(`insert into qq_group_send_instances
    (id, task_id, task_version, state, reserved_messages, media, group_id, bot_id,
     inbound_message_id, text_fingerprint, platform_message_id, created_at, settled_at)
    values ($1, $2, 1, 'in_flight', 1, 'text', $3, $4, null, null, null, $5, null)`, [
    `qgsi:p3g-inflight-${stamp}`, P3G.quotaInflight, G_QUOTA_INFLIGHT, BOT, Date.now(),
  ])
  const inflightMark = groupPackets(G_QUOTA_INFLIGHT).length
  const inflightTurn = await shellB.submitGroup('P3G-QUOTA-INFLIGHT：额度被在途预留占满', 'p3g-quota-inflight', G_QUOTA_INFLIGHT, MEMBER)
  await check('23 P3-G 额度有效 · 派发层：账本已被在途预留占满 ⇒ not_attempted（route 放行、预留拒绝）· 0 条发送', async () => {
    const dispatch = dispatchOf(inflightTurn)
    assert.ok(dispatch !== undefined, `接管轮必须带 groupTaskDispatch：${JSON.stringify(inflightTurn).slice(0, 400)}`)
    /*
     * `not_attempted` 没有实例 id；装配层把它如实表达成 failed_confirmed（"确定没发出去"）
     *   + 具名额度码。⚠️ 断言"确定没发"与"具名额度码"两件事，不要求它长得像 sent。
     */
    assert.equal(dispatch!.status, 'failed_confirmed',
      `预留被拒 ⇒ 确定没发出去：${JSON.stringify(dispatch)}`)
    assert.equal(String(dispatch!.reason ?? ''), 'group_task_total_budget_exhausted',
      `必须带具名额度码：${JSON.stringify(dispatch)}`)
    assert.equal('replyText' in inflightTurn, false,
      'K5：额度被拒**不许**回落旧路径（那会绕过额度再发一条）⇒ 也不许带 replyText')
    await delay(500)
    assert.equal(groupPackets(G_QUOTA_INFLIGHT).length - inflightMark, 0,
      '派发层被拒 ⇒ 一条都不许发')
    const instances = await instanceRows(P3G.quotaInflight)
    assert.equal(instances.length, 1, `被拒的预留不写实例（账本里只该有夹具那一条）：${JSON.stringify(instances)}`)
    assert.equal(instances[0]!.id, `qgsi:p3g-inflight-${stamp}`, '夹具那条在途预留必须原样还在')
    const task = await getGroupTask(db, P3G.quotaInflight)
    assert.equal(task?.usedMessages, 0, `被拒的预留不动额度列：${task?.usedMessages}`)
    assert.equal(task?.status, 'active', `被拒的预留不改任务状态：${task?.status}`)
    readings['check23'] = { dispatch, instances: instances.length, usedMessages: task?.usedMessages ?? null }
  })

  /* ------------------- 27 没有双发（真外壳 + K5） ------------------- */
  await insertReplyTask({ id: P3G.noDouble, groupId: G_NODOUBLE, totalMaxMessages: 10 })
  await insertReplyTask({ id: P3G.result, groupId: G_RESULT, totalMaxMessages: 10 })
  const noDoubleMark = groupPackets(G_NODOUBLE).length
  const noDoubleShellMark = shellB.logs.length
  const noDoubleInboundId = inbound({ text: 'P3G-NODOUBLE：接管轮只许发一条', groupId: G_NODOUBLE, userId: MEMBER })
  const resultMark = groupPackets(G_RESULT).length
  const resultTurn = await shellB.submitGroup('P3G-RESULT：TURN_RESULT 形状', 'p3g-result', G_RESULT, MEMBER)
  await check('27 P3-G 没有双发：接管轮恰好 1 条 send_group_msg · TURN_RESULT 无 replyText 且带 groupTaskDispatch · 外壳不记 lg_turn_failed', async () => {
    await until(() => groupPackets(G_NODOUBLE).length > noDoubleMark, 'no-double shell inbound send')
    assert.equal(groupPackets(G_NODOUBLE).length - noDoubleMark, 1,
      `接管轮只许 1 条 send_group_msg（本轮实际 ${groupPackets(G_NODOUBLE).length - noDoubleMark}）`)
    const packet = groupPackets(G_NODOUBLE).at(-1)!
    assert.equal(String((packet.params as { group_id?: unknown }).group_id), G_NODOUBLE,
      `群号必须逐字是 ${G_NODOUBLE}：${JSON.stringify(packet.params).slice(0, 200)}`)
    const body = segmentsOf(packet).filter((part) => part.type === 'text')
      .map((part) => String(part.data?.text ?? '')).join('')
    assert.equal(body, MSG_MODEL, `正文必须逐字来自模型（不许多一段"失败提示"）：${JSON.stringify(body)}`)
    /*
     * 外壳侧：这一轮的派发结算读数**必须存在**（它只在 groupTaskDispatch 出现时记），
     * 且**不许**记成失败 —— 后者是 P3-C 修掉那个缺陷的镜像（成功被报成失败，
     * 外壳就会往群里补一句"这轮回复没有完成"）。
     */
    const logsThisTurn = shellLogsSince(noDoubleShellMark)
    assert.equal(logsThisTurn.some((log) => log.event === 'lg_turn_failed'), false,
      `接管轮不许记 lg_turn_failed：${JSON.stringify(logsThisTurn.filter((log) => log.event === 'lg_turn_failed'))}`)
    /*
     * ⚠️ 这条读数**晚于**"假 OneBot 已收到那条发送"（它由外壳在 `submit()` 返回之后才写，
     *    见 `waitShellEvent` 的时序说明）⇒ 必须带超时轮询，并在读数里记下等了多久。
     *    2026-10-29 容器 **40/42** 那次红的就是这一族读数（控 28），本控是同一形状的隐患。
     */
    const settledWait = await waitShellEvent(noDoubleShellMark, 'qq_group_task_dispatch_settled')
    const settled = settledWait.log
    assert.ok(settled !== undefined,
      `外壳必须记下本轮 qq_group_task_dispatch_settled（等了 ${settledWait.waitedMs}ms）`
      + ` · 本轮外壳事件=${JSON.stringify(logsThisTurn.map((log) => log.event))}`
      + ` · 该群发送数=${groupPackets(G_NODOUBLE).length - noDoubleMark}`)
    assert.equal(settled!.reason, 'api_accepted', `这一轮应当是平台接受：${JSON.stringify(settled)}`)
    /* 也不许出现第二条群消息（含失败提示） */
    await delay(1200)
    assert.equal(groupPackets(G_NODOUBLE).length - noDoubleMark, 1,
      '接管轮过完之后不许再出现第二条群消息（含失败提示）')

    /* TURN_RESULT 形状：**直接看线缆那一行 JSON**（`LgStdioClient` 是把那一行 JSON.parse 后返回的） */
    const resultDispatch = dispatchOf(resultTurn)
    assert.ok(resultDispatch !== undefined, `直连核心那一轮也必须有 groupTaskDispatch：${JSON.stringify(resultTurn).slice(0, 400)}`)
    assert.equal('replyText' in resultTurn, false,
      `§1.3：groupTaskDispatch 出现时 TURN_RESULT **不许带** replyText 键（不是"空字符串"）：${Object.keys(resultTurn).join(',')}`)
    assert.equal(resultTurn.outcome, 'replied', `§1.3：outcome 仍是 replied：${String(resultTurn.outcome)}`)
    assert.equal(resultTurn.delivery, 'generated', `§1.3：delivery 仍是 generated：${String(resultTurn.delivery)}`)
    const groupTaskReply = resultTurn.groupTaskReply as Record<string, unknown> | undefined
    assert.ok(groupTaskReply !== undefined, '§1.3：groupTaskReply 仍照旧带（闭集不变）')
    assert.deepEqual(Object.keys(groupTaskReply!).sort(), ['groupId', 'taskId', 'taskVersion'],
      `groupTaskReply 闭集必须逐字是这三个键：${Object.keys(groupTaskReply!).join(',')}`)
    assert.equal(groupTaskReply!.taskId, P3G.result, `groupTaskReply.taskId 必须是本轮任务：${String(groupTaskReply!.taskId)}`)
    assert.equal(groupTaskReply!.groupId, G_RESULT, `groupTaskReply.groupId 必须逐字是 ${G_RESULT}`)
    await until(() => groupPackets(G_RESULT).length > resultMark, 'result turn send')
    assert.equal(groupPackets(G_RESULT).length - resultMark, 1,
      `直连核心那一轮也只许 1 条（实际 ${groupPackets(G_RESULT).length - resultMark}）`)
    readings['check27'] = {
      shellInboundSends: groupPackets(G_NODOUBLE).length - noDoubleMark,
      shellInboundId: noDoubleInboundId,
      resultDispatch, turnResultKeys: Object.keys(resultTurn), groupTaskReply,
      settledReadingWaitedMs: settledWait.waitedMs,
    }
  })

  /* ------------------- 28 计数符合约定 · 引用不加条数 ------------------- */
  /*
   * ⚠️ 夹具窗口是**故意宽**的（`insertReplyTask` 缺省 = 现在前 60 s ~ 现在后 1 h），
   *    而且任务就在这条入站**之前**插入 ⇒ 不存在"跑出生效期 ⇒ 回落 default"的可能。
   *    （P3-H 给路由加了生效期判据：`now < startAt` / `now >= endAt` 都不算生效任务。
   *     这里把它写清楚，是为了下次容器里再红时**不必**重新排除这一种可能。）
   */
  await insertReplyTask({ id: P3G.quote, groupId: G_QUOTE, totalMaxMessages: 10 })
  const quoteMark = groupPackets(G_QUOTE).length
  const quoteShellMark = shellB.logs.length
  /* 引用目标 = `inbound()` 自己造的那条入站的 `message_id`（外壳 `receive()` 会逐字校验它） */
  const quotedInboundId = inbound({ text: 'P3G-QUOTE：引用不额外计条数', groupId: G_QUOTE, userId: MEMBER })
  await check('28 P3-G 计数 · 原生引用：引用段在**同一条**消息里（不额外计条数）· 实例 reserved_messages 仍是 1', async () => {
    await until(() => groupPackets(G_QUOTE).length > quoteMark, 'quoted takeover send')
    assert.equal(groupPackets(G_QUOTE).length - quoteMark, 1,
      `引用不额外占条数 ⇒ 仍然只有 1 条 send_group_msg（实际 ${groupPackets(G_QUOTE).length - quoteMark}）`)
    const packet = groupPackets(G_QUOTE).at(-1)!
    const parts = segmentsOf(packet)
    /* ⚠️ 判据：**逐段**看，不能拿 `message` 数组长度当"条数" */
    assert.equal(parts[0]?.type, 'reply',
      `引用段必须是第一个段：${JSON.stringify(parts).slice(0, 300)}`)
    assert.equal(String(parts[0]?.data?.id), String(quotedInboundId),
      `引用目标必须是**本条入站**的 message_id（外壳自持，核心给不出）：${JSON.stringify(parts[0])}`)
    const textParts = parts.filter((part) => part.type === 'text')
    assert.equal(textParts.length, 1, `正文只该有 1 个 text 段：${JSON.stringify(parts).slice(0, 300)}`)
    assert.equal(String(textParts[0]!.data?.text ?? ''), MSG_MODEL, '引用那一条的正文仍必须逐字来自模型')
    const quoteSettledWait = await waitShellEvent(quoteShellMark, 'qq_group_task_dispatch_settled')
    await until(() => instanceRows(P3G.quote).then((rows) => rows.length === 1), 'quote instance row')
    const instance = (await instanceRows(P3G.quote))[0]!
    assert.equal(instance.reserved_messages, 1,
      `引用**不额外计条数** ⇒ 预留仍是 1：${instance.reserved_messages}`)
    assert.equal(instance.state, 'api_accepted', `引用那一条应当被平台接受：${instance.state}`)
    /*
     * ======================================================================
     *  ⚠️ **2026-10-29 容器读数 40/42 的那一条红**（本机 42/42，容器里 `undefined`）
     * ======================================================================
     * ```text
     * 症状：外壳必须记下这一轮的派发结算读数 ⇒ 实际 undefined
     * 定位（先排除另外两种可能，不是猜）：
     *   ② "那一轮走了旧路径"？**排除**：本控上面的 `until(实例行 === 1)` **已经成功**
     *      ⇒ 核心确实走了接管派发（旧路径不写实例行）⇒ 不是行为差异。
     *   ③ "夹具窗口跑出生效期、回落 default"？**排除**：同上 —— 回落 default 就不会有实例行，
     *      而且 `直到 (groupPackets 增长)` 也证明了那条发送真的发生。
     *   ⇒ 只剩 ①：**门把读数窗口读早了**。
     * 时序：`qq_group_task_dispatch_settled` 由外壳在 `submit()` **返回之后**才写
     *       （`receive()` 的 `groupTaskDispatch` 分支）；而"假 OneBot 收到那条发送"与
     *       "实例行落 api_accepted" 都发生在**轮次内部**、比它更早。
     *       本机同进程几乎瞬间落下 ⇒ 一直绿；容器里慢一点 ⇒ 读到 undefined。
     * ```
     * ⇒ 改成**带超时轮询**（不删断言、不放宽理由），并把"等了多久"与"本轮外壳到底记了哪些
     *   事件"一起写进读数 —— 下次若真变了行为，失败信息自己会说出是哪种。
     */
    const quoteSettled = quoteSettledWait.log
    const quoteShellEvents = shellLogsSince(quoteShellMark).map((log) => log.event)
    assert.ok(quoteSettled !== undefined,
      `外壳必须记下这一轮的派发结算读数 qq_group_task_dispatch_settled`
      + `（等了 ${quoteSettledWait.waitedMs}ms）· 本轮外壳事件=${JSON.stringify(quoteShellEvents)}`
      + ` · 该群发送数=${groupPackets(G_QUOTE).length - quoteMark}`
      + ` · 实例=${JSON.stringify(instance)}`
      + ` —— 若这里为空且上面的事件里也没有 dispatch_delivered，就是"那一轮没走派发"的产品侧差异`)
    assert.equal(quoteSettled!.reason, 'api_accepted',
      `派发结算读数必须说"平台接受"：${JSON.stringify(quoteSettled)}`)
    readings['check28'] = {
      inboundMessageId: quotedInboundId,
      segments: parts.map((part) => String(part.type)),
      instance,
      settledReadingWaitedMs: quoteSettledWait.waitedMs,
      shellEventsThisTurn: quoteShellEvents,
    }
  })

  /* =======================================================================
   * 33 / 36–38 P3-H：三组验收里**经真外壳**的那一部分
   *
   * ```text
   * 33 A 每条入站额度 · 直接证据（H1 生效）
   * 36 B 耗尽后无噪声退出 · 名单外群 ⇒ 静默
   * 37 B 耗尽后恢复默认路线 · 名单内群 ⇒ 正常回一条
   * 38 C 并发不串 · 两条入站各自引用自己那条
   * ```
   *
   * ⚠️ 这一组**必须**走真外壳的 `receive()`：`inbound_message_id` 的**唯一可信来源**
   *    就是外壳自己构造的 `requestId`（`qq:<bot>:group:<群>:<消息号>`，三个成分全部来自
   *    已校验的报文）。门侧 `submitGroup()` 用的是合成 requestId（`p3-route-in` 这种），
   *    核心派生时会**失败关闭**成 `null` —— 那验的是"取不到就不记账"，不是 H1 生效。
   * ===================================================================== */
  /**
   * 这条入站经**真外壳**构造出来的 requestId（`onebot-private-client.ts` 的 `receive()`）。
   * ⚠️ 它不是门里编的：`id` 来自假 OneBot 的 `message_id`，`groupId` 来自同一条报文。
   */
  const inboundRequestIdOf = (groupId: string, messageId: number): string =>
    `qq:${BOT}:group:${groupId}:${String(messageId)}`
  /** CONTRACT §1.2 的 requestId 闭集形状（核心派生必须逐段核对） */
  const REQUEST_ID_SHAPE = /^qq:(\d+):group:(\d+):(-?\d+)$/
  /** 一批发送包里各自的**引用目标**（没有引用段 ⇒ undefined） */
  const quoteIdsOf = (batch: readonly OneBotPacket[]): (string | undefined)[] => batch.map((packet) => {
    const reply = segmentsOf(packet).find((part) => part.type === 'reply')
    return reply === undefined ? undefined : String(reply.data?.id ?? '')
  })
  const textOf = (packet: OneBotPacket): string => segmentsOf(packet)
    .filter((part) => part.type === 'text').map((part) => String(part.data?.text ?? '')).join('')
  const waitForTaskStatus = async (taskId: string, status: string): Promise<void> => {
    await until(async () => (await getGroupTask(db, taskId))?.status === status, `task ${taskId} -> ${status}`)
  }

  /* ------------------- 33 A · 每条入站额度（H1 直接证据） ------------------- */
  const G_INBOUND = '10000051'
  const P3H_INBOUND_TASK = `qgt:p3h-inbound-${stamp}`
  /*
   * `perInboundMaxMessages = 1`：每一条入站只准回 1 条。
   * ⇒ 第二条入站**必须**能发（它有自己的 1 条额度）。若 per-inbound 维度串了/恒 0，
   *    这里会出现"第二条被 per-inbound 拒"或者"两条都记同一个键"。
   */
  await insertReplyTask({
    id: P3H_INBOUND_TASK, groupId: G_INBOUND, totalMaxMessages: 10,
    perInboundMaxMessages: 1, memberIds: [MEMBER, MEMBER2],
  })
  const inboundMark = groupPackets(G_INBOUND).length
  const inboundPromptMark = replyPrompts.length
  const inboundIdA = inbound({ text: 'P3H-A-FIRST：第一条入站', groupId: G_INBOUND, userId: MEMBER })
  await check('33 P3-H A · 每条入站额度：账本 `inbound_message_id` 非空且逐字等于该入站的 requestId；另一条入站独立计数', async () => {
    /* 顺序两条入站（真链路串行 ⇒ 先把第一条走完，再发第二条） */
    await until(() => groupPackets(G_INBOUND).length > inboundMark, 'first per-inbound send')
    const inboundIdB = inbound({ text: 'P3H-A-SECOND：第二条入站（独立计数）', groupId: G_INBOUND, userId: MEMBER2 })
    const requestIdA = inboundRequestIdOf(G_INBOUND, inboundIdA)
    const requestIdB = inboundRequestIdOf(G_INBOUND, inboundIdB)
    await until(() => instanceRows(P3H_INBOUND_TASK).then(rows => rows.length === 2), 'two per-inbound instances')
    // An instance is reserved before sending; wait for the second platform packet too.
    await until(() => groupPackets(G_INBOUND).length >= inboundMark + 2, 'second per-inbound send')
    /* 反例断言：两条入站**都真的发了一条**（否则"独立计数"可以由"两条都没发"蒙混） */
    const sends = groupPackets(G_INBOUND).length - inboundMark
    assert.equal(sends, 2,
      `per-inbound=1 时两条不同入站各自都能回 1 条（实际 ${sends}）：若第二条被拒，说明 per-inbound 维度串了`)

    const instances = await instanceRows(P3H_INBOUND_TASK)
    assert.equal(instances.length, 2, `两条入站各 1 条实例：${JSON.stringify(instances)}`)
    /*
     * **H1 生效的唯一直接证据**：账本里 `inbound_message_id` **非空**。
     * P3-G 的具名缺口正是这一列恒 null（桥对 QQ 禁止 messageId ⇒ 上游拿不到可信入站 id）。
     */
    for (const instance of instances) {
      assert.ok(instance.inbound_message_id !== null && instance.inbound_message_id !== '',
        `接管轮实例必须有非空 inbound_message_id（P3-G 的具名缺口就是这一列恒 null）：${
          JSON.stringify(instances)}`)
      const shape = REQUEST_ID_SHAPE.exec(String(instance.inbound_message_id))
      assert.ok(shape !== null,
        `inbound_message_id 必须是**完整 requestId** \`qq:<bot>:group:<群>:<消息号>\`（不是裸 message_id）：${
          String(instance.inbound_message_id)}`)
      assert.equal(shape![1], BOT, `requestId 第 1 段必须是 bot（派生时逐段核对）：${String(instance.inbound_message_id)}`)
      assert.equal(shape![2], G_INBOUND, `requestId 第 2 段必须是群号：${String(instance.inbound_message_id)}`)
    }
    /*
     * 逐条对回：**顺序**按实例写入顺序（= 入站被回答的顺序，外壳同群 FIFO 队列）。
     * ⚠️ 关联依据写在这里：实例没有"属于哪条入站"的第二证据面，只能靠
     *    (a) 每条的 `inbound_message_id` 逐字比对 requestId，(b) 两条键**互不相同**。
     *    若两条都记成同一个键，(b) 会红。
     */
    const recorded = instances.map(instance => String(instance.inbound_message_id))
    assert.deepEqual(recorded, [requestIdA, requestIdB],
      `两条入站必须各自对回自己的 requestId（不串、不共用）：实际 ${JSON.stringify(recorded)}`
      + ` · 期望 ${JSON.stringify([requestIdA, requestIdB])}`)
    assert.equal(new Set(recorded).size, 2, `两条入站的关联键必须互不相同：${JSON.stringify(recorded)}`)
    /* 反例断言：不许把"裸 message_id"当关联键（那会跨群/跨机器人撞号） */
    assert.equal(recorded.includes(String(inboundIdA)), false,
      `inbound_message_id 不许是裸 message_id（CONTRACT §1.2）：${JSON.stringify(recorded)}`)
    /* 第二条入站真的走了模型（它是一次正常回复，不是被拒） */
    assert.equal(replyPromptsSince(inboundPromptMark).length, 2,
      `两条入站各 1 次回复生成（实际 ${replyPromptsSince(inboundPromptMark).length}）`)
    readings['check33'] = {
      groupId: G_INBOUND,
      inboundMessageIds: { first: inboundIdA, second: inboundIdB },
      requestIds: { first: requestIdA, second: requestIdB },
      recordedInboundMessageIds: recorded,
      sends,
      instances,
    }
  })

  /* ------------------- 36 B · 耗尽后无噪声退出（名单外群） ------------------- */
  const G_EXHAUST_SILENT = '10000054'
  const P3H_SILENT_TASK = `qgt:p3h-silent-${stamp}`
  await insertReplyTask({
    id: P3H_SILENT_TASK, groupId: G_EXHAUST_SILENT, totalMaxMessages: 1,
    perInboundMaxMessages: 3, memberIds: [MEMBER, MEMBER2],
  })
  const silentQuotaMark = groupPackets(G_EXHAUST_SILENT).length
  inbound({ text: 'P3H-B-CONSUME：把总额度用掉', groupId: G_EXHAUST_SILENT, userId: MEMBER })
  await check('36 P3-H B · 总额度耗尽后（名单外群）：0 条发送 · 0 次模型调用 · 0 条失败提示 · 不记 lg_turn_failed · 一条 qq_no_reply', async () => {
    await until(() => groupPackets(G_EXHAUST_SILENT).length > silentQuotaMark, 'first send consumes the quota')
    await waitForTaskStatus(P3H_SILENT_TASK, 'exhausted')
    /* 反例断言：额度**真的**被用掉了（否则"第二条静默"可能只是"一条都没发过"） */
    const consumed = groupPackets(G_EXHAUST_SILENT).length - silentQuotaMark
    assert.equal(consumed, 1, `第一条入站应当真的发出 1 条（实际 ${consumed}）`)
    const task = await getGroupTask(db, P3H_SILENT_TASK)
    assert.equal(task?.status, 'exhausted', `额度用尽后任务应落终态 exhausted：${String(task?.status)}`)
    assert.equal(task?.usedMessages, 1, `额度账本记 1 条：${String(task?.usedMessages)}`)

    /*
     * 第二条入站（**不同发送者** ⇒ 不被 3 秒限流吃掉；额度与发送者无关）。
     * 该群**不在**旧静态名单里 ⇒ 任务已终态 ⇒ 准入 denied。
     * 用户裁定：「任务结束后恢复默认规则……不允许的群**静默忽略，不尝试发送失败提示**。」
     */
    const sendMark2 = groupPackets(G_EXHAUST_SILENT).length
    const promptMark2 = replyPrompts.length
    const modelMark2 = modelRequests.length
    const shellLogMark2 = shellB!.logs.length
    inbound({ text: 'P3H-B-SILENT：额度耗尽后的第二条', groupId: G_EXHAUST_SILENT, userId: MEMBER2 })

    let silence: ShellLog | undefined
    try {
      await until(() => shellB!.logs.slice(shellLogMark2).some(log => log.event === 'qq_no_reply'),
        'qq_no_reply after quota exhaustion')
      silence = shellB!.logs.slice(shellLogMark2).find(log => log.event === 'qq_no_reply')
    } catch (error) {
      const seen = shellB!.logs.slice(shellLogMark2)
        .map(log => `${log.event}:${String(log.reason ?? '')}`)
      assert.fail(`未等到 qq_no_reply（${String(error)}）· 外壳本轮读数=${JSON.stringify(seen.slice(-6))}`
        + ` · 该群发送总数=${groupPackets(G_EXHAUST_SILENT).length}`)
    }
    await delay(500)
    const logsThisTurn = shellB!.logs.slice(shellLogMark2)
    /* ① 一条群消息都不发（含"失败提示"） */
    assert.equal(groupPackets(G_EXHAUST_SILENT).length - sendMark2, 0,
      `耗尽后名单外群的入站一条都不许发（含失败提示）：本轮 ${
        groupPackets(G_EXHAUST_SILENT).length - sendMark2} 条`)
    /* ② 0 次模型调用 */
    assert.deepEqual(replyPromptsSince(promptMark2), [],
      '耗尽后名单外群的入站不许产生回复生成')
    assert.equal(modelRequests.length, modelMark2, '耗尽后名单外群的入站不许调模型')
    /* ③ 具名理由 + 不记 lg_turn_failed */
    assert.equal(silence!.reason, 'qq_group_not_authorized',
      `静默必须带具名理由（不是"未知"）：${JSON.stringify(silence)}`)
    assert.equal(logsThisTurn.some(log => log.event === 'lg_turn_failed'), false,
      `不许记成失败（那会触发"失败提示"那条路）：${
        JSON.stringify(logsThisTurn.filter(log => log.event === 'lg_turn_failed'))}`)
    /* 反例断言：这条入站**真的到过**外壳（否则"0 条发送"可能只是"消息没送到"） */
    assert.ok(logsThisTurn.some(log => log.event === 'qq_inbound_seen'),
      `这条入站必须真的到过外壳（否则静默是假的）：${JSON.stringify(logsThisTurn.slice(-4))}`)
    readings['check36'] = {
      groupId: G_EXHAUST_SILENT,
      totalBudgetConsumed: consumed,
      taskStatus: task?.status,
      sendsAfter: 0,
      modelCallsAfter: 0,
      failedPromptSent: false,
      silentReason: silence!.reason,
      failedLogged: false,
    }
  })

  /* ------------------- 37 B · 耗尽后恢复默认路线（名单内群） ------------------- */
  const P3H_LEGACY_TASK = `qgt:p3h-legacy-${stamp}`
  await insertReplyTask({
    id: P3H_LEGACY_TASK, groupId: G_LEGACY_SEQ, totalMaxMessages: 1,
    perInboundMaxMessages: 3, memberIds: [MEMBER, MEMBER2],
  })
  const legacySeqMark = groupPackets(G_LEGACY_SEQ).length
  inbound({ text: 'P3H-B-LEGACY-CONSUME：把总额度用掉', groupId: G_LEGACY_SEQ, userId: MEMBER })
  await check('37 P3-H B · 总额度耗尽后（名单内群）：**恢复默认规则**，正常回一条（不许因历史任务永久抑制该群）', async () => {
    await until(() => groupPackets(G_LEGACY_SEQ).length > legacySeqMark, 'first send consumes the quota')
    await waitForTaskStatus(P3H_LEGACY_TASK, 'exhausted')
    const consumed = groupPackets(G_LEGACY_SEQ).length - legacySeqMark
    assert.equal(consumed, 1, `第一条入站（任务接管）应当真的发出 1 条（实际 ${consumed}）`)
    const task = await getGroupTask(db, P3H_LEGACY_TASK)
    assert.equal(task?.status, 'exhausted', `名额用尽后任务应落终态：${String(task?.status)}`)

    const sendMark2 = groupPackets(G_LEGACY_SEQ).length
    const promptMark2 = replyPrompts.length
    const shellLogMark2 = shellB!.logs.length
    inbound({ text: 'P3H-B-LEGACY-DEFAULT：耗尽后走默认路线', groupId: G_LEGACY_SEQ, userId: MEMBER2 })
    await until(() => groupPackets(G_LEGACY_SEQ).length > sendMark2, 'default-route reply after exhaustion')
    /*
     * 用户原话：「任务结束后恢复默认规则：**旧规则允许的群正常处理**……
     *          不要因为历史上有一条耗尽任务，就永久抑制这个群。」
     * ⇒ 判据：这个群（在旧名单里）**正常回了一条**，而且走的是**默认路线**（不带接管段）。
     */
    const batch = groupPackets(G_LEGACY_SEQ).slice(sendMark2)
    assert.equal(batch.length, 1,
      `名单内群在任务耗尽后应当**正常回一条**（实际 ${batch.length}）：被永久抑制就是这里的红`)
    assert.equal(textOf(batch[0]!), MSG_MODEL,
      `默认路线的正文应当来自模型：${JSON.stringify(textOf(batch[0]!))}`)
    const prompts = replyPromptsSince(promptMark2)
    assert.equal(prompts.length, 1, `默认路线应当恰好 1 次回复生成（实际 ${prompts.length}）`)
    assert.equal(prompts[0]!.includes('【本轮群任务接管】'), false,
      '任务已终态 ⇒ 走**默认路线**：不许再注入「本轮群任务接管」段')
    /* 反例断言：这一轮**不是**静默（静默 = 什么都没发 + qq_no_reply） */
    const logsThisTurn = shellB!.logs.slice(shellLogMark2)
    assert.equal(logsThisTurn.some(log => log.event === 'qq_no_reply'), false,
      `名单内群不许被静默抑制：${JSON.stringify(logsThisTurn.filter(log => log.event === 'qq_no_reply'))}`)
    assert.equal(logsThisTurn.some(log => log.event === 'lg_turn_failed'), false,
      `默认路线的正常回复不许记成失败：${
        JSON.stringify(logsThisTurn.filter(log => log.event === 'lg_turn_failed'))}`)
    readings['check37'] = {
      groupId: G_LEGACY_SEQ,
      taskStatusAfterConsume: task?.status,
      repliesAfterExhaustion: batch.length,
      replyText: textOf(batch[0]!),
      route: 'default',
      takeoverSectionInjected: prompts[0]!.includes('【本轮群任务接管】'),
    }
  })

  /* ------------------- 38 C · 并发不串（真链路） ------------------- */
  const G_CONCURRENT = '10000056'
  const P3H_CONCURRENT_TASK = `qgt:p3h-concurrent-${stamp}`
  await insertReplyTask({
    id: P3H_CONCURRENT_TASK, groupId: G_CONCURRENT, totalMaxMessages: 10,
    perInboundMaxMessages: 3, memberIds: [MEMBER, MEMBER2],
  })
  const concurrentMark = groupPackets(G_CONCURRENT).length
  /*
   * 两条入站**背靠背**塞进去（两个 ws 帧、两个不同发送者 ⇒ 都进队列）。
   * 外壳同群串行执行，但 `rememberActiveInbound` 落**队列内**（不是入队时）⇒
   * 每一轮各自记自己那条入站，引用目标不会串到"下一条消息"上。
   */
  const concurrentIdA = inbound({ text: 'P3H-C-FIRST：并发第一条', groupId: G_CONCURRENT, userId: MEMBER })
  const concurrentIdB = inbound({ text: 'P3H-C-SECOND：并发第二条', groupId: G_CONCURRENT, userId: MEMBER2 })
  await check('38 P3-H C · 并发不串：两条入站各自引用**自己**那条 message_id · 实例各自记自己的 requestId', async () => {
    const requestIdA = inboundRequestIdOf(G_CONCURRENT, concurrentIdA)
    const requestIdB = inboundRequestIdOf(G_CONCURRENT, concurrentIdB)
    await until(() => groupPackets(G_CONCURRENT).length - concurrentMark >= 2, 'two concurrent-inbound sends')
    await until(() => instanceRows(P3H_CONCURRENT_TASK).then(rows => rows.length === 2), 'two concurrent instances')
    const batch = groupPackets(G_CONCURRENT).slice(concurrentMark)
    assert.equal(batch.length, 2, `两条入站各 1 条发送（实际 ${batch.length}）`)
    /*
     * 引用对象不串：引用段逐条核 `{type:'reply', data:{id}}`。
     * ⚠️ 配对依据：外壳同群 FIFO 队列（第一条先被回答 ⇒ 先发）。
     *    若引用串了，最典型的形状是**两条都引用后一条**（`activeInbounds` 按群只留最近一条
     *    时就是这个后果）⇒ 这里会变成 [msgB, msgB]，立刻红。
     */
    const quotes = quoteIdsOf(batch)
    assert.deepEqual(quotes, [String(concurrentIdA), String(concurrentIdB)],
      `引用目标必须各自是本条入站的 message_id：实际 ${JSON.stringify(quotes)}`
      + ` · 期望 ${JSON.stringify([String(concurrentIdA), String(concurrentIdB)])}`)
    assert.equal(new Set(quotes).size, 2, `两条回复不许引用同一条入站：${JSON.stringify(quotes)}`)
    /* 额度关联不串：实例各记自己的 requestId */
    const recorded = (await instanceRows(P3H_CONCURRENT_TASK)).map(row => String(row.inbound_message_id))
    assert.deepEqual(recorded, [requestIdA, requestIdB],
      `实例的 inbound_message_id 必须各自对回自己的 requestId：实际 ${JSON.stringify(recorded)}`)
    assert.equal(new Set(recorded).size, 2, `两条实例不许共用同一个关联键：${JSON.stringify(recorded)}`)
    readings['check38'] = {
      groupId: G_CONCURRENT,
      inbounds: { first: concurrentIdA, second: concurrentIdB },
      quotes,
      recordedInboundMessageIds: recorded,
      requests: { first: requestIdA, second: requestIdB },
      boundary: '关联依据 = 外壳同群 FIFO 队列（两条 ws 帧背靠背进入，轮次仍串行；'
        + '真正同时预留的证据在控 39 的派发层）',
    }
  })

  /* ------------------- 41 B · "没有生效任务"含**已过期**与**还没开始** ------------------- */
  /*
   * CONTRACT §2.2 ① 的括号里写的是「没有生效任务（从未有 / **已终态** / **已过期**）」。
   * 控 37 验"已终态"；这一条验"不在生效期"的两种形态 —— 而且这两种**只在生效期判据上**才咬人：
   *
   * ```text
   * 一条 window 任务到期后，状态仍停留在 active（没有任何东西会把它改成 expired）
   *   ⇒ 旧代码 `replyWindowTasks()` 只看状态 ⇒ 它**还在**"生效任务"里
   *   ⇒ `decideInboundRouting` 判 group_task_out_of_term ⇒ suppress
   *   ⇒ 这个群被一条**已经过期**的任务长期闭嘴（默认路线不许兜底）
   * ```
   *
   * ★★ **2026-10-29 追加裁定（Lead 转达，本控按它改）** ★★
   * ```text
   * 「任务还没开始（now < startAt）」**不再抑制**，同样回落 default。
   *   理由：任务不在生效期应当**一律**回到默认路线 —— 还没开始 / 已到期 / 已撤销 / 已删除
   *   是同一件事（"此刻没有生效任务"）。保留一个"还没开始就静默抑制"的特殊态，
   *   会产生一段主人看不见也解释不了的"她突然不说话"的窗口。
   * ```
   * ⇒ 本控的三条读数（原写成"还没开始仍抑制"，现按裁定翻转为 default）：
   *    ① 已到期 + 名单内群  ⇒ default ⇒ 正常回 1 条
   *    ② 还没开始 + 名单外群 ⇒ default ⇒ 静默（0 发送 / 0 模型 / 0 提示 / 无 lg_turn_failed）
   *    ③ 还没开始 + 名单内群 ⇒ default ⇒ 正常回 1 条
   * ⚠️ 与 P3-A 旧行为的差别：旧实现里 `now < startAt` 走
   *    `decideInboundRouting → group_task_out_of_term ⇒ suppress`（门里曾经如实钉过这一条，
   *    属于"与修正后需求冲突的旧断言"，本批按用户裁定翻转 —— 见门头"更正了旧断言"一节）。
   */
  const G_FUTURE_OUT = '10000059'
  const P3H_EXPIRED_TASK = `qgt:p3h-expired-active-${stamp}`
  const P3H_FUTURE_OUT_TASK = `qgt:p3h-future-out-${stamp}`
  const P3H_FUTURE_ALLOWED_TASK = `qgt:p3h-future-allowed-${stamp}`
  const p3hTermNow = Date.now()
  await insertReplyTask({
    id: P3H_EXPIRED_TASK, groupId: G_EXPIRED_ACTIVE, totalMaxMessages: 10, perInboundMaxMessages: 3,
    /* 已结束 1 小时，但 status 仍是 active（夹具**不**改状态机：这正是被测形态） */
    term: { startAt: p3hTermNow - 7_200_000, endAt: p3hTermNow - 3_600_000 },
  })
  await insertReplyTask({
    id: P3H_FUTURE_OUT_TASK, groupId: G_FUTURE_OUT, totalMaxMessages: 10, perInboundMaxMessages: 3,
    /* 还没开始 + **不在**旧名单 ⇒ 回落 default 之后由旧名单拒绝 ⇒ 静默 */
    term: { startAt: p3hTermNow + 3_600_000, endAt: p3hTermNow + 7_200_000 },
  })
  await insertReplyTask({
    id: P3H_FUTURE_ALLOWED_TASK, groupId: G_FUTURE_ALLOWED, totalMaxMessages: 10, perInboundMaxMessages: 3,
    /* 还没开始 + **在**旧名单 ⇒ 回落 default 之后由旧名单放行 ⇒ 正常回一条 */
    term: { startAt: p3hTermNow + 3_600_000, endAt: p3hTermNow + 7_200_000 },
  })
  await check('41 P3-H B · "没有生效任务"含**已过期**与**还没开始**：两种都不许挡门（名单内 ⇒ 默认路线回一条 · 名单外 ⇒ 静默）', async () => {
    /* ① 已过期（状态仍 active）+ 名单内群 ⇒ 应当回落 default 并**正常回一条** */
    const expiredMark = groupPackets(G_EXPIRED_ACTIVE).length
    const expiredPromptMark = replyPrompts.length
    const expiredShellMark = shellB!.logs.length
    inbound({ text: 'P3H-B-EXPIRED：过期任务不许挡门', groupId: G_EXPIRED_ACTIVE, userId: MEMBER })
    try {
      await until(() => groupPackets(G_EXPIRED_ACTIVE).length > expiredMark,
        'default-route reply despite an expired-but-active task')
    } catch (error) {
      const seen = shellB!.logs.slice(expiredShellMark)
        .map(log => `${log.event}:${String(log.reason ?? '')}`)
      assert.fail(`过期任务仍然挡住了这个群（${String(error)}）· 外壳读数=${JSON.stringify(seen.slice(-6))}`
        + ' · 期望：回落 default ⇒ 正常回一条')
    }
    const batch = groupPackets(G_EXPIRED_ACTIVE).slice(expiredMark)
    assert.equal(batch.length, 1, `名单内群应当正常回一条（实际 ${batch.length}）`)
    assert.equal(textOf(batch[0]!), MSG_MODEL, `默认路线的正文应当来自模型：${JSON.stringify(textOf(batch[0]!))}`)
    const expiredPrompts = replyPromptsSince(expiredPromptMark)
    assert.equal(expiredPrompts.length, 1, `默认路线应当恰好 1 次回复生成（实际 ${expiredPrompts.length}）`)
    assert.equal(expiredPrompts[0]!.includes('【本轮群任务接管】'), false,
      '过期任务不算生效任务 ⇒ 不许注入「本轮群任务接管」段')
    /* 反例断言：**没有**靠改状态机来完成这件事（本批零存储改动） */
    const expiredTask = await getGroupTask(db, P3H_EXPIRED_TASK)
    assert.equal(expiredTask?.status, 'active',
      `夹具那条过期任务的状态**不许**被改写（零存储改动 ⇒ 只在路由层判生效期）：${String(expiredTask?.status)}`)
    assert.equal(expiredTask?.version, 1, `过期任务不该被升版本：${String(expiredTask?.version)}`)

    /* ② 还没开始 + 名单外群 ⇒ default ⇒ 由旧名单拒绝 ⇒ **静默**（0 发送 / 0 模型 / 0 提示） */
    const futureOutSendMark = groupPackets(G_FUTURE_OUT).length
    const futureOutPromptMark = replyPrompts.length
    const futureOutModelMark = modelRequests.length
    const futureOutShellMark = shellB!.logs.length
    inbound({ text: 'P3H-B-FUTURE-OUT：还没开始 + 名单外群', groupId: G_FUTURE_OUT, userId: MEMBER })
    let futureOutSilence: ShellLog | undefined
    try {
      await until(() => shellB!.logs.slice(futureOutShellMark).some(log => log.event === 'qq_no_reply'),
        'qq_no_reply for a not-yet-started task in a non-allowlisted group')
      futureOutSilence = shellB!.logs.slice(futureOutShellMark).find(log => log.event === 'qq_no_reply')
    } catch (error) {
      const seen = shellB!.logs.slice(futureOutShellMark)
        .map(log => `${log.event}:${String(log.reason ?? '')}`)
      assert.fail(`还没开始的名单外群必须回落默认路线并静默（${String(error)}）`
        + ` · 外壳读数=${JSON.stringify(seen.slice(-6))}`)
    }
    await delay(400)
    const futureOutLogs = shellB!.logs.slice(futureOutShellMark)
    /*
     * 具名码必须是 `qq_group_not_authorized` —— 如果它还是 `group_task_inbound_suppressed`，
     * 说明"还没开始"仍然走**任务抑制**那一支（= 裁定要否掉的那个特殊态）。
     */
    assert.equal(futureOutSilence!.reason, 'qq_group_not_authorized',
      `"还没开始"必须回落 default（旧名单拒绝 ⇒ qq_group_not_authorized），`
      + `不许再走任务抑制那一支：${JSON.stringify(futureOutSilence)}`)
    assert.equal(groupPackets(G_FUTURE_OUT).length - futureOutSendMark, 0,
      '还没开始的名单外群：0 条发送（含失败提示）')
    assert.deepEqual(replyPromptsSince(futureOutPromptMark), [], '还没开始的名单外群：0 次回复生成')
    assert.equal(modelRequests.length, futureOutModelMark, '还没开始的名单外群：0 次模型调用')
    assert.equal(futureOutLogs.some(log => log.event === 'lg_turn_failed'), false,
      `不许记 lg_turn_failed：${JSON.stringify(futureOutLogs.filter(log => log.event === 'lg_turn_failed'))}`)

    /* ③ 还没开始 + 名单内群 ⇒ default ⇒ 由旧名单放行 ⇒ **正常回一条** */
    const futureOkMark = groupPackets(G_FUTURE_ALLOWED).length
    const futureOkPromptMark = replyPrompts.length
    inbound({ text: 'P3H-B-FUTURE-OK：还没开始 + 名单内群', groupId: G_FUTURE_ALLOWED, userId: MEMBER })
    try {
      await until(() => groupPackets(G_FUTURE_ALLOWED).length > futureOkMark,
        'default-route reply despite a not-yet-started task')
    } catch (error) {
      const seen = shellB!.logs.slice(-6).map(log => `${log.event}:${String(log.reason ?? '')}`)
      assert.fail(`"还没开始"的名单内群必须回落默认路线并正常回一条（${String(error)}）`
        + ` · 外壳读数=${JSON.stringify(seen)}`)
    }
    const futureOkBatch = groupPackets(G_FUTURE_ALLOWED).slice(futureOkMark)
    assert.equal(futureOkBatch.length, 1, `名单内群应当正常回一条（实际 ${futureOkBatch.length}）`)
    assert.equal(textOf(futureOkBatch[0]!), MSG_MODEL,
      `默认路线的正文应当来自模型：${JSON.stringify(textOf(futureOkBatch[0]!))}`)
    const futureOkPrompts = replyPromptsSince(futureOkPromptMark)
    assert.equal(futureOkPrompts.length, 1, `默认路线应当恰好 1 次回复生成（实际 ${futureOkPrompts.length}）`)
    assert.equal(futureOkPrompts[0]!.includes('【本轮群任务接管】'), false,
      '"还没开始"的任务不算生效任务 ⇒ 不许注入「本轮群任务接管」段')
    readings['check41'] = {
      expiredActive: {
        groupId: G_EXPIRED_ACTIVE, taskStatus: expiredTask?.status,
        sends: batch.length, text: textOf(batch[0]!), takeoverSectionInjected: false,
      },
      notYetStartedOutside: {
        groupId: G_FUTURE_OUT, reason: futureOutSilence!.reason,
        sends: 0, modelCalls: 0, failedLogged: false,
      },
      notYetStartedAllowed: {
        groupId: G_FUTURE_ALLOWED, sends: futureOkBatch.length,
        text: textOf(futureOkBatch[0]!), takeoverSectionInjected: false,
      },
      ruling: '「还没开始」不再抑制（与已到期/已撤销/已删除同一件事：此刻没有生效任务）'
        + ' ⇒ 一律回落 default，由旧静态名单与成员核验决定；'
        + '保留"还没开始就静默抑制"的特殊态会产生一段主人看不见也解释不了的"她突然不说话"的窗口。',
      boundary: '两种形态都只在**路由层**按生效期判（不改任务状态机、不删行：本批零存储改动）',
    }
  })

  /* ---------------- 收尾 host B（重启恢复需要新进程） ---------------- */
  await shellB.stop(); shellB = undefined
  captureTail('B', hostB)
  readings['hostBExit'] = await stopHost(hostB, 'hostB')
  hostB = undefined

  /* ------------------- 10 重启恢复（不重播） ------------------- */
  const restartTaskId = `qgt:restart-fixture-${stamp}`
  const restartNow = Date.now()
  await pool.query(`insert into qq_group_tasks
    (id, contract_version, version, status, kind, bot_id, group_id, content, media, text_fallback,
     trigger, term, quota, used_messages, last_send_at, auth_source, dedupe_key, created_at, updated_at, revoked_at)
    values ($1, 1, 1, 'active', 'reply_window', $2, $3, $4::jsonb, 'text', false, $5::jsonb, $6::jsonb, $7::jsonb,
            0, null, 'owner_qq_private', $8, $9, $9, null)`, [
    restartTaskId, BOT, G_LEGACY,
    JSON.stringify({ mode: 'owner_verbatim', text: '重启恢复夹具正文', brief: null }),
    JSON.stringify({ memberIds: [], replyToMessageId: null, categories: [], topicScope: null }),
    JSON.stringify({ kind: 'window', startAt: restartNow, endAt: restartNow + 3_600_000 }),
    JSON.stringify({ totalMaxMessages: 10, perInboundMaxMessages: 3, slot: null, minIntervalMs: 0 }),
    `qq-group-task:${OWNER}:restart-fixture-${stamp}`, restartNow,
  ])
  await pool.query(`insert into qq_group_send_instances
    (id, task_id, task_version, state, reserved_messages, media, group_id, bot_id,
     inbound_message_id, text_fingerprint, platform_message_id, created_at, settled_at)
    values
      ($1, $3, 1, 'in_flight', 1, 'text', $4, $5, null, null, null, $6, null),
      ($2, $3, 1, 'queued', 1, 'text', $4, $5, null, null, null, $6, null)`, [
    `qgsi:restart-inflight-${stamp}`, `qgsi:restart-queued-${stamp}`, restartTaskId, G_LEGACY, BOT, restartNow,
  ])
  const replayBaseline = groupSends().length
  hostC = await startHost({ groupTasks: true, suffix: 'restart' })
  await hostC.ready
  await delay(1500)
  await check('10 重启恢复：in_flight⇒unknown / queued⇒failed_confirmed，不重播（假 OneBot 计数不增）', async () => {
    const states = new Map((await pool.query(
      'select id,state from qq_group_send_instances where task_id = $1', [restartTaskId],
    )).rows.map((row) => [String((row as { id: string }).id), String((row as { state: string }).state)]))
    assert.equal(states.get(`qgsi:restart-inflight-${stamp}`), 'unknown',
      `in_flight 应当转 unknown：${JSON.stringify(Object.fromEntries(states))}`)
    assert.equal(states.get(`qgsi:restart-queued-${stamp}`), 'failed_confirmed',
      `queued 应当转 failed_confirmed：${JSON.stringify(Object.fromEntries(states))}`)
    const task = await getGroupTask(db, restartTaskId)
    assert.ok(task !== undefined, '重启恢复后任务行应当还在')
    assert.equal(task!.status, 'paused', `unknown 结算应当把任务置 paused（结果不明绝不继续发）：${task!.status}`)
    assert.equal(task!.usedMessages, 1, `unknown 保守计入 1 条额度：${task!.usedMessages}`)
    assert.equal(groupSends().length, replayBaseline, '重启恢复不许重播任何一条（假 OneBot 计数不增）')
  })
  readings['check10'] = {
    instances: (await pool.query('select id,state from qq_group_send_instances where task_id = $1',
      [restartTaskId])).rows,
    sendsAfterRestart: groupSends().length - replayBaseline,
  }
  captureTail('C', hostC)
  readings['hostCExit'] = await stopHost(hostC, 'hostC')
  hostC = undefined

  /* =======================================================================
   * 05–08 第二道复核（in-process，**不是** real main；真 store + 真 client）
   * ===================================================================== */
  const negativeLogs: ShellLog[] = []
  negativeClient = new OneBotPrivateClient({
    ownerId: OWNER, botId: BOT, wsUrl, token: 'offline-group-task-combo-token-123456',
    multiUserEnabled: true, allowedGroupIds: [G_LEGACY],
  }, undefined, (reading) => negativeLogs.push(reading), undefined, undefined, createGateAuthorizer())
  await negativeClient.connect()

  const runtimeDeps = (execute: GroupTaskRuntimeDeps['execute']): GroupTaskRuntimeDeps => ({
    db,
    ownerRef: OWNER,
    botId: BOT,
    now: () => Date.now(),
    listGroups: async () => groupList.map((entry) => ({
      groupId: String(entry.group_id), groupName: entry.group_name,
    })),
    resolveGroup: resolveGroupTarget,
    execute,
  })

  /** `execute` 端口：**先改库**（模拟"预留之后、真正发送之前任务变了"）→ 再走真客户端发送 */
  const executeAfterMutation = (
    mutate: (task: { id: string; version: number }) => Promise<void>,
  ): GroupTaskRuntimeDeps['execute'] => async (input): Promise<GroupSendExecutionOutcome> => {
    const task = await getGroupTask(db, input.taskId)
    assert.ok(task !== undefined, `第二道复核前任务行必须存在：${input.taskId}`)
    await mutate({ id: task!.id, version: task!.version })
    const result = await negativeClient!.deliverGroupTaskMessage({
      groupId: input.target.groupId,
      taskId: input.taskId,
      taskVersion: input.taskVersion,
      media: input.media,
      text: input.text,
      deliveryKey: input.idempotencyKey,
    })
    if (result.status === 'api_accepted') {
      return { kind: 'accepted', ...(result.messageId === undefined ? {} : { platformMessageId: result.messageId }) }
    }
    if (result.status === 'failed_confirmed') return { kind: 'failed', code: result.reason ?? 'failed_confirmed' }
    return { kind: 'unknown', ...(result.reason === undefined ? {} : { code: result.reason }) }
  }

  /** 一条"第二道复核"负控：建单 → 预留 → 改库 → 客户端复核拒绝 → 0 条发送 */
  const runSecondRecheck = async (input: {
    readonly name: string
    readonly marker: string
    readonly expectedCode: string
    readonly mutate: (task: { id: string; version: number }) => Promise<void>
    /** 夹具自己在账本里另插的实例数（"别人的预留"）——缺省 0 */
    readonly extraReservedInstances?: number
  }): Promise<void> => {
    await check(input.name, async () => {
      const sendBefore = groupSends().length
      const outcome = await handleGroupTaskTurn(runtimeDeps(executeAfterMutation(input.mutate)), {
        draft: draftFor(input.marker),
        current: { id: `evt-${input.marker}`, text: input.marker },
        sourceEventId: `evt-${input.marker}-${stamp}`,
      })
      assert.equal(outcome.dispatch?.kind, 'failed',
        `第二道复核应当判"明确失败"：${JSON.stringify(outcome.dispatch)}`)
      assert.equal(outcome.dispatch?.code, input.expectedCode,
        `拒绝码应当是 ${input.expectedCode}：${outcome.dispatch?.code}`)
      assert.equal(groupSends().length, sendBefore, '第二道复核拒绝后一条都不许发')
      const instances = await instanceRows(String(outcome.dispatch?.taskId))
      const extra = input.extraReservedInstances ?? 0
      assert.equal(instances.length, 1 + extra,
        `本轮应当只有 1 条自己的预留实例（+${extra} 条夹具实例，失败不退额）：${JSON.stringify(instances)}`)
      const own = instances.filter(instance => instance.id === String(outcome.dispatch?.instanceId))
      assert.equal(own.length, 1, `自己那条实例必须还在账本里（失败不退额）：${JSON.stringify(instances)}`)
      assert.equal(own[0]!.state, 'failed_confirmed',
        `自己那条实例应当结算成 failed_confirmed：${own[0]!.state}`)
    })
  }

  await runSecondRecheck({
    name: '05 发送前复核 · 撤销：预留后任务被撤销 ⇒ 客户端复核拒绝 group_task_terminal，0 条发送',
    marker: 'P2G-REVOKE',
    expectedCode: 'group_task_terminal',
    mutate: async (task) => {
      const saved = await setGroupTaskStatus(db, task.id, task.version, 'revoked', Date.now(),
        { via: 'gate-negative-revoke' })
      assert.equal(saved.ok, true, `夹具撤销任务失败：${JSON.stringify(saved)}`)
    },
  })

  await runSecondRecheck({
    name: '06 发送前复核 · 修改升版本：预留后改内容升版本 ⇒ 旧版本不得发出（group_task_version_changed），0 条发送',
    marker: 'P2G-VERSION',
    expectedCode: 'group_task_version_changed',
    mutate: async (task) => {
      const saved = await modifyGroupTask(db, task.id, task.version, { text: '改过之后的正文' }, Date.now())
      assert.equal(saved.ok, true, `夹具修改任务失败：${JSON.stringify(saved)}`)
    },
  })

  await runSecondRecheck({
    name: '07 发送前复核 · 过期：预留后 endAt 已过 ⇒ group_task_out_of_term，0 条发送',
    marker: 'P2G-EXPIRED',
    expectedCode: 'group_task_out_of_term',
    mutate: async (task) => {
      const now = Date.now()
      await pool.query('update qq_group_tasks set term = $1::jsonb where id = $2', [
        JSON.stringify({ kind: 'window', startAt: now - 600_000, endAt: now - 1 }), task.id,
      ])
    },
  })

  /*
   * 08 **额度用尽**：由**别人的**预留把额度占满，而不是"把自己算两遍"。
   *
   * ```text
   * 夹具在预留之后另插 10 条 in_flight 实例（各预留 1）⇒ 账本已满；
   * `task.used_messages` 仍是 **0**（只有 api_accepted/unknown 才累计）
   *   ⇒ 早先那套"只用 used_messages + planned=1"的口径在这条夹具上会**放行**
   *      （0+1 <= 10），也就是漏掉在途的其它实例。
   * 现在的口径：账本(剔除自己)=10 + planned(自己 1) = 11 > 10 ⇒ 拒绝。
   * ```
   */
  const quotaOtherInstances = 10
  await runSecondRecheck({
    name: '08 发送前复核 · 额度：预留后被**其它实例**占满 ⇒ group_task_total_budget_exhausted，0 条发送',
    marker: 'P2G-QUOTA',
    expectedCode: 'group_task_total_budget_exhausted',
    extraReservedInstances: quotaOtherInstances,
    mutate: async (task) => {
      const at = Date.now()
      for (let index = 0; index < quotaOtherInstances; index += 1) {
        await pool.query(`insert into qq_group_send_instances
          (id, task_id, task_version, state, reserved_messages, media, group_id, bot_id,
           inbound_message_id, text_fingerprint, platform_message_id, created_at, settled_at)
          values ($1, $2, $3, 'in_flight', 1, 'text', $4, $5, null, null, null, $6, null)`, [
          `qgsi:quota-other-${stamp}-${index}`, task.id, task.version, G_LEGACY, BOT, at,
        ])
      }
      /* 读数：这一列**看不见**在途实例（口径差异的证据，不是被清掉的旧读数） */
      const row = (await pool.query('select used_messages from qq_group_tasks where id = $1',
        [task.id])).rows[0] as { used_messages?: number } | undefined
      readings['check08UsedMessagesAtRecheck'] = Number(row?.used_messages ?? 0)
      readings['check08OtherReservedMessages'] = quotaOtherInstances
    },
  })

  /* =======================================================================
   * 22 / 29–32 P3-G：**派发层与协议侧**的 in-process 检查
   *
   * 为什么这一段在进程内（与 05–08 同一条纪律）：
   * ```text
   * · 22（并发抢最后一条额度）：真 main 的 `TurnBridge.submit` 有**串行闸**，
   *   外壳 `OneBotPrivateClient.queue` 也串行 ⇒ 一轮真链路里拿不到"两个轮次同时写账"。
   *   而"原子预留不是先查再写"的证据恰好在**账本那一层**：两个 `Promise.all`
   *   的 `dispatchGroupTaskReply` 抢同一条额度，只有一个能预留成功。
   *   ⚠️ 若哪天有人把行锁换成"先查再写"，这条会立刻变成 **2 条发送** ⇒ 红。
   * · 29–31（计数/协议负控）：判据是**外壳策略 A 的四条检查**与**派发指令的形状**，
   *   直接对真 `OneBotPrivateClient` 调用即可；绕真 main 只会多两个不确定来源。
   * · 32（外壳不回执 ⇒ 超时）：需要把等回执的上限压到几百毫秒，
   *   那是 `TurnBridge` 的构造参数（`groupTaskDeliveryTimeoutMs`），
   *   真 main 没有 env 注入点 ⇒ 只能进程内建一个桥。
   * ```
   * 全部用：真 store + 隔离 PG + 真 `OneBotPrivateClient` + 假 OneBot（零真实 QQ/模型）。
   * ===================================================================== */
  const G_QUOTA_ATOMIC = '10000022'
  const G_VOICE = '10000030'
  const G_EXPIRED = '10000031'
  const G_TIMEOUT = '10000032'

  /* ------------------- 22 额度有效 · 原子预留（并发） ------------------- */
  const atomicTaskId = `qgt:p3g-quota-atomic-${stamp}`
  await insertReplyTask({ id: atomicTaskId, groupId: G_QUOTA_ATOMIC, totalMaxMessages: 1 })
  const atomicTaskView = await getGroupTask(db, atomicTaskId)
  assert.ok(atomicTaskView !== undefined, '并发预留夹具：任务行必须存在')
  const atomicSendMark = groupPackets(G_QUOTA_ATOMIC).length
  const runAtomicReserve = (text: string) => dispatchGroupTaskReply(
    { db, now: () => Date.now(), dispatchToShell: async (instruction) => await negativeClient!.deliverGroupTaskFromCore(instruction) },
    { task: atomicTaskView!, text, media: 'text', plannedMessages: 1, inboundMessageId: null },
  )
  const atomicOutcomes = await Promise.all([runAtomicReserve('并发甲'), runAtomicReserve('并发乙')])
  await check('22 P3-G 额度有效 · 原子预留（并发）：两条同时抢最后 1 条 ⇒ 只发 1 条；另一条 not_attempted + 具名额度/终态码（竞态：两个码都合法）', async () => {
    /*
     * ============================================================================
     *  ⚠️ **这两个码都对；写死其中一个就是把竞态当成常量**（2026-10-29 容器读数教训）
     * ============================================================================
     * ```text
     * 夹具：totalMaxMessages = 1，两条**同时**进 `dispatchGroupTaskReply`。
     * 时序：reserveGroupSend 的行锁只在**预留事务内**持有；赢家随后 settle。
     *   · 输家赶在赢家 settle **之前**拿到锁
     *       ⇒ 看到 task=active + 账本已占 1 ⇒ group_task_total_budget_exhausted
     *   · 输家等到赢家 settle **之后**才拿到锁
     *       ⇒ `decideTaskAfterSendSettlement` 在同一次结算里已把任务置终态 exhausted
     *       ⇒ decideSendAllowance 第一步 isTerminalGroupTaskStatus ⇒ group_task_terminal
     * ```
     * ⇒ 谁先谁后是**竞态**，两个码都是**正确的失败关闭**（都是"这条不许发出去"）。
     *   ⚠️ 本机长期只看到前者、容器里换成后者（serversim **40/42** 的那一条红）——
     *   这正是"断言把竞态写死"的形态。**不**放宽到"随便什么码都行"，而是收成
     *   **闭集**，并把重心放在真正与竞态无关的不变式上：
     *     ① 假 OneBot 只收到 **1** 条发送（"先查再写"会让两条都发 ⇒ 立刻红）；
     *     ② 账本**恰好 1 行**实例且已 `api_accepted`；
     *     ③ 输家是 `not_attempted`（**未发送**）且**没写过实例**；
     *     ④ 任务最终 `exhausted`、`used_messages = 1`。
     */
    const sent = atomicOutcomes.filter((outcome) => outcome.kind === 'sent')
    const denied = atomicOutcomes.filter((outcome) => outcome.kind === 'not_attempted')
    assert.equal(sent.length, 1, `并发两条只能有一条成功：${JSON.stringify(atomicOutcomes)}`)
    assert.equal(denied.length, 1, `另一条必须在**预留**时被拒：${JSON.stringify(atomicOutcomes)}`)
    /** 竞态决定的具名码**闭集**（两者都是失败关闭；见上面的时序说明） */
    const ALLOWED_DENIAL_CODES = ['group_task_total_budget_exhausted', 'group_task_terminal'] as const
    assert.ok((ALLOWED_DENIAL_CODES as readonly string[]).includes(String(denied[0]!.code)),
      `被拒那条必须带具名码，且落在 {${ALLOWED_DENIAL_CODES.join(' | ')}} 里：`
      + `${JSON.stringify(denied[0])} ⇒ 若出现别的码（尤其"放过"),说明行锁/终态判据坏了`)
    assert.equal(denied[0]!.instanceId, undefined, '被拒的预留不许留下实例 id（它没写过任何东西）')
    const sends = groupPackets(G_QUOTA_ATOMIC).length - atomicSendMark
    assert.equal(sends, 1, `"先查再写"会让两条都通过 ⇒ 2 条；行锁口径必须是 1 条（实际 ${sends}）`)
    const instances = await instanceRows(atomicTaskId)
    assert.equal(instances.length, 1, `账本里只该有 1 条实例：${JSON.stringify(instances)}`)
    assert.equal(instances[0]!.state, 'api_accepted', `赢的那条应当结算成 api_accepted：${instances[0]!.state}`)
    assert.equal(instances[0]!.reserved_messages, 1, `文字回复预留 1 条：${instances[0]!.reserved_messages}`)
    const task = await getGroupTask(db, atomicTaskId)
    assert.equal(task?.usedMessages, 1, `额度账本记 1 条：${task?.usedMessages}`)
    /* ④ 总额度=1 且赢家已结算 ⇒ 任务必然落终态（与"输家看到哪个码"无关） */
    assert.equal(task?.status, 'exhausted',
      `赢家结算后任务应当是终态 exhausted：${String(task?.status)}`)
    readings['check22'] = {
      outcomes: atomicOutcomes,
      sends,
      instances,
      usedMessages: task?.usedMessages ?? null,
      taskStatus: task?.status,
      observedDenialCode: denied[0]!.code,
      acceptedDenialCodes: [...ALLOWED_DENIAL_CODES],
      raceNote: '输家看到 total_budget_exhausted（赶在赢家 settle 前拿到锁）或 '
        + 'group_task_terminal（等到赢家 settle 后）——两者都是正确的失败关闭，取决于谁先；'
        + '本机长期只出现前者，容器（serversim）出现后者。',
    }
  })

  /* ------------------- 29 计数 · 语音 + 附录 = 2 条 ------------------- */
  const voiceTaskId = `qgt:p3g-voice-${stamp}`
  /*
   * ⚠️ `media` 必须是 `either`：DDL 有
   *    `check (media = 'either' or not text_fallback)`（`qq_group_tasks_text_fallback_vocab`）
   *    —— "语音任务 + 文字兜底"这个组合在**单媒体**任务上不合法（门里踩过一次）。
   */
  await insertReplyTask({
    id: voiceTaskId, groupId: G_VOICE, totalMaxMessages: 10, media: 'either', textFallback: true,
  })
  const voiceTaskView = await getGroupTask(db, voiceTaskId)
  assert.ok(voiceTaskView !== undefined, '语音计数夹具：任务行必须存在')
  const voiceSendMark = groupPackets(G_VOICE).length
  /* ⚠️ `plannedMessages` 用**生产函数**算（不是门里硬编码 2）：口径漂移要能红 */
  const voicePlanned = plannedOutgoingMessages({
    media: 'voice', hasAppendix: true, allowTextFallback: voiceTaskView!.textFallback,
  })
  const voiceOutcome = await dispatchGroupTaskReply(
    { db, now: () => Date.now(), dispatchToShell: async (instruction) => await negativeClient!.deliverGroupTaskFromCore(instruction) },
    {
      task: voiceTaskView!, text: '语音正文夹具', media: 'voice',
      plannedMessages: voicePlanned, inboundMessageId: null, appendixText: '来源：夹具附录',
    },
  )
  await check('29 P3-G 计数符合约定 · 语音+来源附录：reserved_messages=2 · 正文与附录**各自一条**发出（预留 ≥ 实际外发）', async () => {
    assert.equal(voicePlanned, 2, `生产函数必须给出 2（语音 1 + 附录 1）：${voicePlanned}`)
    assert.equal(voiceOutcome.kind, 'sent', `语音轮应当结算成 sent：${JSON.stringify(voiceOutcome)}`)
    assert.equal(voiceOutcome.settlement, 'api_accepted', `结算必须是 api_accepted：${String(voiceOutcome.settlement)}`)
    const instances = await instanceRows(voiceTaskId)
    assert.equal(instances.length, 1, `只该有 1 条实例：${JSON.stringify(instances)}`)
    const instance = instances[0]!
    assert.equal(instance.reserved_messages, 2,
      `语音 + 附录必须预留 2 条：${instance.reserved_messages}`)
    const packetsThisCall = groupPackets(G_VOICE).slice(voiceSendMark)
    assert.equal(packetsThisCall.length, 2,
      `正文与附录各一条 ⇒ 假 OneBot 必须收到 2 条（实际 ${packetsThisCall.length}）`)
    const texts = packetsThisCall.map((packet) => segmentsOf(packet)
      .filter((part) => part.type === 'text').map((part) => String(part.data?.text ?? '')).join(''))
    assert.deepEqual(texts, ['语音正文夹具', '来源：夹具附录'],
      `顺序必须是**先正文、后附录**：${JSON.stringify(texts)}`)
    /* 契约 §4.1：发送前预留数 **≥** 实际外发数（不是"相等"：附录可能失败，正文仍成立） */
    assert.ok(instance.reserved_messages >= packetsThisCall.length,
      `预留(${instance.reserved_messages}) 必须 ≥ 实际外发(${packetsThisCall.length})`)
    /* 附录那条不许带引用段（引用只属于正文那一条，否则群里会出现两条"引用回复"） */
    for (const packet of packetsThisCall) {
      assert.deepEqual(segmentTypes(packet), ['text'],
        `语音兜底 + 附录两条都必须是纯文字段：${JSON.stringify(segmentTypes(packet))}`)
    }
    /*
     * 外壳自己的**结算读数**：`deliveredCount` 只数平台已接受的对外消息。
     * 这条是"2 条都对"与"1 条（附录被静默吞掉）"唯一能一眼分开的地方。
     */
    const delivered = negativeLogs.find((log) => log.event === 'qq_group_task_dispatch_delivered'
      && String(log.requestId ?? '') === String(voiceOutcome.instanceId ?? ''))
    assert.ok(delivered !== undefined,
      `外壳必须记下这一条派发的结算读数：${JSON.stringify(negativeLogs.slice(-4))}`)
    assert.equal((delivered as unknown as { deliveredCount?: number }).deliveredCount, 2,
      `deliveredCount 必须是 2（正文 + 附录都被平台接受）：${JSON.stringify(delivered)}`)
    readings['check29'] = {
      planned: voicePlanned, texts, instance, sends: packetsThisCall.length, delivered,
    }
  })

  /* ------------------- 30 协议负控 · expiresAt 已过 ------------------- */
  const expiredKey = `qgsi:p3g-expired-${stamp}`
  const expiredMark = groupPackets(G_EXPIRED).length
  const expiredLogMark = negativeLogs.length
  const expiredReading = await negativeClient.deliverGroupTaskFromCore({
    deliveryKey: expiredKey, groupId: G_EXPIRED, taskId: 'qgt:p3g-expired', taskVersion: 1,
    text: '过期夹具正文', media: 'text', reservedMessages: 1, expiresAt: Date.now() - 1,
  })
  await check('30 P3-G 协议负控 · expiresAt 已过：0 条发送 + group_task_dispatch_expired（外壳策略 A 检查 ③）', async () => {
    assert.equal(expiredReading.status, 'failed_confirmed',
      `过期 ⇒ 确定没发出去（不是 unknown）：${JSON.stringify(expiredReading)}`)
    assert.equal(expiredReading.reason, 'group_task_dispatch_expired',
      `必须带具名码 group_task_dispatch_expired：${JSON.stringify(expiredReading)}`)
    assert.equal(groupPackets(G_EXPIRED).length - expiredMark, 0, '过期指令一条都不许发')
    await delay(500)
    assert.equal(groupPackets(G_EXPIRED).length - expiredMark, 0, '过期指令也不许"过一会儿再发一次"')
    const rejection = negativeLogs.slice(expiredLogMark)
      .find((log) => log.event === 'qq_group_task_dispatch_rejected')
    assert.ok(rejection !== undefined,
      `外壳必须记下拒绝读数（不静默）：${JSON.stringify(negativeLogs.slice(expiredLogMark).slice(-3))}`)
    assert.equal(rejection!.reason, 'group_task_dispatch_expired',
      `拒绝读数必须带同一个具名码：${JSON.stringify(rejection)}`)
    assert.equal(String(rejection!.requestId ?? ''), expiredKey,
      `拒绝读数必须能对回这一条指令：${JSON.stringify(rejection)}`)
    readings['check30'] = { reading: expiredReading, rejection }
  })

  /* ------------------- 31 协议负控 · 同一 deliveryKey 重复派发 ------------------- */
  const replayKey = `qgsi:p3g-replay-${stamp}`
  const replayInstruction = {
    deliveryKey: replayKey, groupId: G_EXPIRED, taskId: 'qgt:p3g-replay', taskVersion: 1,
    text: '重复派发夹具正文', media: 'text' as const, reservedMessages: 1, expiresAt: Date.now() + 60_000,
  }
  const replayMark = groupPackets(G_EXPIRED).length
  const replayLogMark = negativeLogs.length
  const replayFirst = await negativeClient.deliverGroupTaskFromCore(replayInstruction)
  const replaySecond = await negativeClient.deliverGroupTaskFromCore({ ...replayInstruction })
  await check('31 P3-G 协议负控 · 同一 deliveryKey 重复派发：仍只发 1 条 · 第二次原样返回首次结局（读数 replayed）', async () => {
    assert.equal(replayFirst.status, 'api_accepted', `第一次应当被平台接受：${JSON.stringify(replayFirst)}`)
    assert.equal(groupPackets(G_EXPIRED).length - replayMark, 1,
      `同一 deliveryKey 只许发 1 条（实际 ${groupPackets(G_EXPIRED).length - replayMark}）`)
    await delay(600)
    assert.equal(groupPackets(G_EXPIRED).length - replayMark, 1, '重复派发之后不许再多发一条')
    assert.equal(replaySecond.status, replayFirst.status,
      `第二次必须原样返回首次结局：${JSON.stringify({ first: replayFirst, second: replaySecond })}`)
    assert.equal(replaySecond.messageId, replayFirst.messageId,
      '第二次必须回同一个平台 message_id（不重新发、不换一个新 id）')
    const replayed = negativeLogs.slice(replayLogMark)
      .find((log) => log.event === 'group_task_dispatch_replayed')
    assert.ok(replayed !== undefined,
      `幂等命中必须留读数（不静默；事件名是 group_task_dispatch_replayed，没有 qq_ 前缀）：${
        JSON.stringify(negativeLogs.slice(replayLogMark).slice(-3))}`)
    assert.equal(String(replayed!.requestId ?? ''), replayKey, '读数必须能对回这个 deliveryKey')
    readings['check31'] = { first: replayFirst, second: replaySecond, sends: groupPackets(G_EXPIRED).length - replayMark }
  })

  /* ------------------- 32 协议负控 · 外壳不回执 ⇒ 超时 ------------------- */
  const timeoutSink: { kind: string; requestId: string }[] = []
  const timeoutBridge = new TurnBridge({
    host: {
      characterId: 'gate-p3g-character',
      conversationId: 'gate-p3g-conversation',
      /* 这一段**永远不该被调用**：本控只测 `deliverGroupTask` 的等回执路径 */
      runTurn: async () => { throw new Error('gate_p3g_timeout_probe_must_not_run_a_turn') },
    },
    /* ⚠️ 可注入是这条控的前提：缺省 5000 ms 会让门空等，且掩盖"是不是真的超时" */
    groupTaskDeliveryTimeoutMs: 300,
  })
  timeoutBridge.setOutputSink((message) => {
    timeoutSink.push({
      kind: String((message as { kind?: unknown }).kind ?? ''),
      requestId: String((message as { requestId?: unknown }).requestId ?? ''),
    })
  })
  const timeoutKey = `qgsi:p3g-timeout-${stamp}`
  const timeoutSendMark = groupPackets(G_TIMEOUT).length
  const timeoutStartedAt = Date.now()
  const timeoutReading = await timeoutBridge.deliverGroupTask({
    deliveryKey: timeoutKey, groupId: G_TIMEOUT, taskId: 'qgt:p3g-timeout', taskVersion: 1,
    text: '超时夹具正文', media: 'text', reservedMessages: 1, expiresAt: Date.now() + 60_000,
  })
  const timeoutElapsed = Date.now() - timeoutStartedAt
  await check('32 P3-G 协议负控 · 外壳不回执：超时 delivery_unknown（注入 300ms）· 假 OneBot 计数不增 · 命令只写一次', async () => {
    assert.equal(timeoutReading.status, 'delivery_unknown',
      `没有回执 ⇒ 结果未知（不猜成成功/失败）：${JSON.stringify(timeoutReading)}`)
    assert.equal(timeoutReading.reason, 'group_task_delivery_timeout',
      `必须带具名码 group_task_delivery_timeout：${JSON.stringify(timeoutReading)}`)
    assert.ok(timeoutElapsed >= 200 && timeoutElapsed <= 3_000,
      `必须走**注入的** 300ms（不是缺省 5000ms、也不是瞬间返回）：${timeoutElapsed}ms`)
    /* 指令只写了一次：超时**不重试**（重试 = 群里可能多一条） */
    assert.equal(timeoutSink.length, 1, `指令只许写 1 次（实际 ${timeoutSink.length}）`)
    assert.equal(timeoutSink[0]!.kind, 'DELIVER_GROUP_TASK', `写出去的必须是派发指令：${JSON.stringify(timeoutSink)}`)
    assert.equal(timeoutSink[0]!.requestId, timeoutKey, `requestId 必须 = deliveryKey：${JSON.stringify(timeoutSink)}`)
    assert.equal(groupPackets(G_TIMEOUT).length - timeoutSendMark, 0,
      '没有回执 ⇒ 一条也不许发（谁都没发过这条指令）')
    /* 桥自己的读数：超时计一次、在途清零 */
    const dispatchReading = timeoutBridge.groupTaskDispatchReading
    assert.equal(dispatchReading.timedOut, 1, `桥必须记下 1 次超时：${JSON.stringify(dispatchReading)}`)
    assert.equal(dispatchReading.pending, 0, `超时之后在途必须清零：${JSON.stringify(dispatchReading)}`)
    /*
     * 迟到的回执：键已经删了 ⇒ **不静默丢弃**，如实回 `group_task_report_unknown_key`
     * （CONTRACT §2.3 ⑤）—— 并且不能因此把这条派发改判成"已接受"。
     */
    const lateReport = timeoutBridge.acceptGroupTaskDeliveryReport({
      deliveryKey: timeoutKey, status: 'api_accepted', messageId: '999999',
    })
    assert.equal(lateReport.accepted, false, `超时之后的晚到回执不许被受理：${JSON.stringify(lateReport)}`)
    assert.equal(lateReport.code, 'group_task_report_unknown_key',
      `必须给具名码 group_task_report_unknown_key：${JSON.stringify(lateReport)}`)
    await delay(600)
    assert.equal(timeoutSink.length, 1, '超时之后不许重试（指令仍然只写 1 次）')
    assert.equal(groupPackets(G_TIMEOUT).length - timeoutSendMark, 0, '超时之后假 OneBot 计数不增')
    readings['check32'] = { reading: timeoutReading, elapsedMs: timeoutElapsed, sink: timeoutSink, lateReport }
  })

  /* =======================================================================
   * 34 / 35 / 39 P3-H：派发层（in-process：真 store + 真外壳 + 假 OneBot）
   *
   * ```text
   * 为什么这几条在进程内（与 22/29–32 同一条纪律）：
   *   一轮真链路只产生**一条**接管回复（同一轮不回两次话）⇒
   *   "同一条入站再来一条"在真 main 里**构造不出来**。
   *   而 per-inbound 额度恰恰只在"同一条入站可以有多条"时才咬人 ⇒
   *   证据面在 `reserveGroupSend` 的行锁事务 / `dispatchGroupTaskReply` 那一层。
   * ```
   *
   * ⚠️ 这一组验的**不是**"per-inbound 有没有接线"（那是控 33 的事：账本里非空键），
   *    而是"键到了账本之后，额度是不是真的按它分账"。
   * ===================================================================== */

  /* ------------------- 34 A · 同一入站第二条被拒（per-inbound 分账） ------------------- */
  const G_PI_LEDGER = '10000052'
  const perInboundTaskId = `qgt:p3h-per-inbound-${stamp}`
  await insertReplyTask({
    id: perInboundTaskId, groupId: G_PI_LEDGER, totalMaxMessages: 10, perInboundMaxMessages: 1,
  })
  const perInboundView = await getGroupTask(db, perInboundTaskId)
  assert.ok(perInboundView !== undefined, 'per-inbound 夹具：任务行必须存在')
  const perInboundMark = groupPackets(G_PI_LEDGER).length
  /** 同一任务的两条**不同**入站关联键（形状与真外壳构造的一致） */
  const piInboundX = inboundRequestIdOf(G_PI_LEDGER, 910_001)
  const piInboundY = inboundRequestIdOf(G_PI_LEDGER, 910_002)
  const dispatchPerInbound = async (
    inboundMessageId: string, text: string,
  ): Promise<Awaited<ReturnType<typeof dispatchGroupTaskReply>>> => await dispatchGroupTaskReply(
    {
      db,
      now: () => Date.now(),
      dispatchToShell: async (instruction) => await negativeClient!.deliverGroupTaskFromCore(instruction),
    },
    {
      task: perInboundView!, text, media: 'text', plannedMessages: 1, inboundMessageId,
    },
  )
  const piFirst = await dispatchPerInbound(piInboundX, '同一入站 · 第一条')
  const piSecond = await dispatchPerInbound(piInboundX, '同一入站 · 第二条')
  const piThird = await dispatchPerInbound(piInboundY, '另一条入站 · 应独立计数')
  await check('34 P3-H A · 同一入站超过上限就拒（group_task_per_inbound_exhausted · 0 条）；另一条入站独立计数', async () => {
    /* 反例断言：第一条必须真的发出去（否则"第二条被拒"可以由"根本没发过"蒙混） */
    assert.equal(piFirst.kind, 'sent',
      `同一入站的第一条应当正常发出：${JSON.stringify(piFirst)}`)
    assert.equal(piFirst.settlement, 'api_accepted',
      `第一条应当是平台接受：${String(piFirst.settlement)}`)
    /*
     * **本组的主角**：同一条入站的第二条撞 `perInboundMaxMessages = 1`。
     * 拒因必须是**具名 per-inbound 码**，且这条路径**一条都不许发**。
     */
    assert.equal(piSecond.kind, 'not_attempted',
      `同一入站的第二条必须在预留时就被拒：${JSON.stringify(piSecond)}`)
    assert.equal(piSecond.code, 'group_task_per_inbound_exhausted',
      `拒因必须是 group_task_per_inbound_exhausted（CONTRACT §4 A）：${JSON.stringify(piSecond)}`)
    assert.equal(piSecond.instanceId, undefined,
      `被拒的预留不许留下实例 id（它没写过任何东西）：${JSON.stringify(piSecond)}`)
    /*
     * 反例断言：**不是**别的额度码。
     * totalMaxMessages = 10 还很宽 ⇒ 若这里报 total_budget_exhausted，说明
     * "per-inbound" 实际上读的是**总数**（那就等于没有 per-inbound 这一维）。
     */
    assert.notEqual(piSecond.code, 'group_task_total_budget_exhausted',
      `总额度还有 8 条，拒因不许是总额度码（那说明 per-inbound 读成了总数）：${JSON.stringify(piSecond)}`)
    assert.notEqual(piSecond.code, 'group_task_planned_messages_invalid',
      `本次 planned=1 ≤ perInboundMax=1 ⇒ 不是"单条就超上限"那一支：${JSON.stringify(piSecond)}`)
    /* 另一条入站独立计数：它有自己的 1 条额度 */
    assert.equal(piThird.kind, 'sent',
      `另一条入站必须独立计数（不受前一条影响）：${JSON.stringify(piThird)}`)

    const sends = groupPackets(G_PI_LEDGER).length - perInboundMark
    assert.equal(sends, 2, `两次成功 + 一次被拒 ⇒ 恰好 2 条发送（实际 ${sends}）`)
    const instances = await instanceRows(perInboundTaskId)
    assert.equal(instances.length, 2,
      `被拒的预留不写实例 ⇒ 账本里只该有 2 条：${JSON.stringify(instances)}`)
    assert.deepEqual(instances.map(row => String(row.inbound_message_id)), [piInboundX, piInboundY],
      `两条实例各自记自己的入站键：${JSON.stringify(instances)}`)
    /** 第一条之后 per-inbound 维度**不再是 0**（P3-G 的缺口正是它恒 0） */
    const perInboundReserved = instances.reduce((sum, row) => sum + row.reserved_messages, 0)
    assert.equal(perInboundReserved, 2, `两条实例各预留 1 条 ⇒ 合计 2（实际 ${perInboundReserved}）`)
    readings['check34'] = {
      groupId: G_PI_LEDGER,
      first: { kind: piFirst.kind, settlement: piFirst.settlement },
      secondSameInbound: { kind: piSecond.kind, code: piSecond.code },
      thirdOtherInbound: { kind: piThird.kind },
      sends,
      instances,
    }
  })

  /* ------------------- 35 A · 语音+附录=2 占**同一条入站**的额度 ------------------- */
  const G_PI_VOICE = '10000053'
  const piVoiceTaskId = `qgt:p3h-per-inbound-voice-${stamp}`
  /*
   * ⚠️ `media` 必须是 `either`：DDL 有 `check (media = 'either' or not text_fallback)`
   *    ——"语音任务 + 文字兜底"在单媒体任务上不合法（同控 29）。
   */
  await insertReplyTask({
    id: piVoiceTaskId, groupId: G_PI_VOICE, totalMaxMessages: 10,
    media: 'either', textFallback: true, perInboundMaxMessages: 2,
  })
  const piVoiceView = await getGroupTask(db, piVoiceTaskId)
  assert.ok(piVoiceView !== undefined, '语音 per-inbound 夹具：任务行必须存在')
  const piVoiceMark = groupPackets(G_PI_VOICE).length
  const piVoiceInbound = inboundRequestIdOf(G_PI_VOICE, 910_003)
  /* ⚠️ 用**生产函数**算（不是门里硬编码 2）：口径漂移要能红 */
  const piVoicePlanned = plannedOutgoingMessages({
    media: 'voice', hasAppendix: true, allowTextFallback: true,
  })
  const piVoiceFirst = await dispatchGroupTaskReply(
    {
      db,
      now: () => Date.now(),
      dispatchToShell: async (instruction) => await negativeClient!.deliverGroupTaskFromCore(instruction),
    },
    {
      task: piVoiceView!, text: 'P3H 语音正文', media: 'voice', plannedMessages: piVoicePlanned,
      inboundMessageId: piVoiceInbound, appendixText: '来源：P3H 附录',
    },
  )
  const piVoiceSecond = await dispatchGroupTaskReply(
    {
      db,
      now: () => Date.now(),
      dispatchToShell: async (instruction) => await negativeClient!.deliverGroupTaskFromCore(instruction),
    },
    {
      task: piVoiceView!, text: '同一条入站再来一条', media: 'text', plannedMessages: 1,
      inboundMessageId: piVoiceInbound,
    },
  )
  await check('35 P3-H A · 语音+附录=2 占**同一条入站**额度：再来一条 ⇒ per-inbound 拒（0 条发送）', async () => {
    assert.equal(piVoicePlanned, 2, `生产函数必须给出 2（语音 1 + 附录 1）：${piVoicePlanned}`)
    assert.equal(piVoiceFirst.kind, 'sent', `语音+附录应当结算成 sent：${JSON.stringify(piVoiceFirst)}`)
    assert.equal(piVoiceFirst.settlement, 'api_accepted', `必须是 api_accepted：${String(piVoiceFirst.settlement)}`)
    /* 反例断言：那"2 条"是**真的**发出去了（否则"额度被占满"是账面上的假象） */
    const firstPackets = groupPackets(G_PI_VOICE).slice(piVoiceMark)
    assert.equal(firstPackets.length, 2,
      `正文与附录各一条 ⇒ 假 OneBot 必须收到 2 条（实际 ${firstPackets.length}）`)
    /*
     * 同一条入站再来一条：perInbound 已经用掉 2（= 上限）⇒ 拒。
     * ⚠️ 这也是为什么 CONTRACT §4 A 把"语音+附录=2"和"perInboundMaxMessages=1 再来一条"
     *    并列：两者都是"同一条入站的**累计**条数"越界，而不是"单条太长"。
     */
    assert.equal(piVoiceSecond.kind, 'not_attempted',
      `同一条入站再来一条必须被拒：${JSON.stringify(piVoiceSecond)}`)
    assert.equal(piVoiceSecond.code, 'group_task_per_inbound_exhausted',
      `拒因必须是 group_task_per_inbound_exhausted：${JSON.stringify(piVoiceSecond)}`)
    const sends = groupPackets(G_PI_VOICE).length - piVoiceMark
    assert.equal(sends, 2, `被拒那一条一条都不许发 ⇒ 总数仍是 2（实际 ${sends}）`)
    const instances = await instanceRows(piVoiceTaskId)
    assert.equal(instances.length, 1, `只该有 1 条实例（被拒的预留不写实例）：${JSON.stringify(instances)}`)
    assert.equal(instances[0]!.reserved_messages, 2,
      `语音+附录预留 2 条（这就是 per-inbound 被占满的那 2 条）：${instances[0]!.reserved_messages}`)
    assert.equal(String(instances[0]!.inbound_message_id), piVoiceInbound,
      `实例的入站键必须逐字是这一条入站的 requestId：${String(instances[0]!.inbound_message_id)}`)
    readings['check35'] = {
      groupId: G_PI_VOICE, planned: piVoicePlanned, inboundMessageId: piVoiceInbound,
      first: { kind: piVoiceFirst.kind, settlement: piVoiceFirst.settlement },
      secondSameInbound: { kind: piVoiceSecond.kind, code: piVoiceSecond.code },
      sends, instances,
    }
  })

  /* ------------------- 39 C · 并发两条（不同入站）不串 ------------------- */
  const G_CONCURRENT_LEDGER = '10000057'
  const concurrentLedgerTaskId = `qgt:p3h-concurrent-ledger-${stamp}`
  await insertReplyTask({
    id: concurrentLedgerTaskId, groupId: G_CONCURRENT_LEDGER, totalMaxMessages: 10, perInboundMaxMessages: 1,
  })
  const concurrentLedgerView = await getGroupTask(db, concurrentLedgerTaskId)
  assert.ok(concurrentLedgerView !== undefined, '并发 per-inbound 夹具：任务行必须存在')
  const concurrentLedgerMark = groupPackets(G_CONCURRENT_LEDGER).length
  const clInboundX = inboundRequestIdOf(G_CONCURRENT_LEDGER, 920_001)
  const clInboundY = inboundRequestIdOf(G_CONCURRENT_LEDGER, 920_002)
  const dispatchConcurrentLedger = async (
    inboundMessageId: string, text: string,
  ): Promise<Awaited<ReturnType<typeof dispatchGroupTaskReply>>> => await dispatchGroupTaskReply(
    {
      db,
      now: () => Date.now(),
      dispatchToShell: async (instruction) => await negativeClient!.deliverGroupTaskFromCore(instruction),
    },
    { task: concurrentLedgerView!, text, media: 'text', plannedMessages: 1, inboundMessageId },
  )
  const clOutcomes = await Promise.all([
    dispatchConcurrentLedger(clInboundX, '并发·甲'),
    dispatchConcurrentLedger(clInboundY, '并发·乙'),
  ])
  await check('39 P3-H C · 并发两条入站（各自 per-inbound=1）⇒ 都不串：各记自己的键、各自额度互不吃掉', async () => {
    /*
     * ⚠️ 这一条是 per-inbound **不串**的最强证据面：
     *   perInboundMaxMessages = 1，两条**同时**预留。
     *   · 键若是同一个（或都成了 null ⇒ 该维度失效），第二条会撞 per-inbound 拒；
     *   · 键若是"总数当 per-inbound"，同样会拒（1+1 > 1）；
     *   ⇒ 只有"各按各的键分账"才会**两条都成功**。
     */
    const sent = clOutcomes.filter((outcome) => outcome.kind === 'sent')
    assert.equal(sent.length, 2,
      `两条不同入站各自有 1 条额度 ⇒ 必须都成功：${JSON.stringify(clOutcomes)}`)
    const sends = groupPackets(G_CONCURRENT_LEDGER).length - concurrentLedgerMark
    assert.equal(sends, 2, `两条都得真的发出去（实际 ${sends}）`)
    const instances = await instanceRows(concurrentLedgerTaskId)
    assert.equal(instances.length, 2, `账本里应当有 2 条实例：${JSON.stringify(instances)}`)
    const recorded = instances.map(row => String(row.inbound_message_id))
    /* 集合相等 + 互不相同 ⇒ 没有串（顺序取决于行锁事务的先后，不作断言） */
    assert.deepEqual([...recorded].sort(), [clInboundX, clInboundY].sort(),
      `两条实例必须各记自己的入站键：实际 ${JSON.stringify(recorded)}`
      + ` · 期望 ${JSON.stringify([clInboundX, clInboundY])}`)
    assert.equal(new Set(recorded).size, 2, `两条实例不许共用同一个键：${JSON.stringify(recorded)}`)
    for (const row of instances) {
      assert.equal(row.reserved_messages, 1, `每条各预留 1 条：${JSON.stringify(instances)}`)
    }
    readings['check39'] = {
      groupId: G_CONCURRENT_LEDGER,
      outcomes: clOutcomes.map(outcome => ({ kind: outcome.kind, code: outcome.code ?? null })),
      sends,
      recordedInboundMessageIds: recorded,
      boundary: '派发层并发（两份预留同时进行，行锁串行化）；真链路的并发见控 38',
    }
  })

  /* ------------------- 40 A · 派生函数负控（纯函数 · 拒绝非法形状） ------------------- */
  await check('40 P3-H A · 派生函数负控（纯函数）：形状/bot/群/位数任一不符 ⇒ 不派生（绝不猜）；合法 ⇒ **完整** requestId', async () => {
    /*
     * CONTRACT §1.3 原话：「派生函数必须是**纯函数**，放在可单测位置，并带"拒绝非法形状"的负控。」
     *
     * 为什么这条控重要：H1 的整个安全性都压在"关联键只来自**受信** requestId"这一条上
     *   （`platformFactsProblems` 对 QQ 禁止 `messageId` 的那道防伪造不放开）。
     *   一旦派生函数"宽松一点、猜一下"，跨群/跨机器人的同号消息就会撞在一起，
     *   而那种错误**不会**有任何运行期报错 —— 只会让 per-inbound 额度悄悄算错。
     * ⇒ 这里逐条钉死**必须返回 undefined** 的形态。函数只吃两个参数（requestId + 已校验事实），
     *   结构上拿不到模型输出 ⇒ "模型可填字段"在这条路径上不存在。
     */
    const facts: InboundMessageIdFacts = {
      transport: 'qq', messageType: 'group', selfId: BOT, groupId: G_PI_LEDGER,
    }
    const valid = `qq:${BOT}:group:${G_PI_LEDGER}:1234567`
    assert.equal(deriveInboundMessageId(valid, facts), valid,
      '合法形状 + bot/群逐字相同 ⇒ 原样返回这一条 requestId')
    /* ① 返回的是**完整 requestId**，不是裸消息号（裸号会跨群/跨机器人撞号） */
    assert.notEqual(deriveInboundMessageId(valid, facts), '1234567',
      'inbound_message_id 不许被裁成裸 message_id（CONTRACT §1.2 明确要求完整 requestId）')
    const negative = `qq:${BOT}:group:${G_PI_LEDGER}:-2020555111`
    assert.equal(deriveInboundMessageId(negative, facts), negative, '真实 OneBot 的有符号 message_id 也必须关联到入站额度')
    /*
     * ② 同一消息号在**两个群**里 ⇒ 两个**不同**的键（这正是不用裸号的理由）。
     */
    const sameNumberOtherGroup = `qq:${BOT}:group:${G_PI_VOICE}:1234567`
    assert.equal(deriveInboundMessageId(sameNumberOtherGroup,
      { ...facts, groupId: G_PI_VOICE }), sameNumberOtherGroup,
      '同一个消息号在另一个群里也是合法的（但它是**另一个**键）')
    assert.notEqual(deriveInboundMessageId(valid, facts), deriveInboundMessageId(sameNumberOtherGroup,
      { ...facts, groupId: G_PI_VOICE }), '两个群的同号消息不许落成同一个关联键')

    /** 每一条都必须**不派生**（失败关闭；不许猜一个键让额度能过） */
    const negatives: { readonly why: string; readonly requestId: string | undefined
      readonly facts: typeof facts | undefined }[] = [
      { why: '裸消息号（没有 qq: 前缀）', requestId: '1234567', facts },
      { why: '私聊形状（不是 group）', requestId: `qq:${BOT}:private:${MEMBER}:1234567`, facts },
      { why: '多一段（qq:<bot>:group:<群>:<号>:<号>）',
        requestId: `qq:${BOT}:group:${G_PI_LEDGER}:1234567:8`, facts },
      { why: 'bot 与本轮事实不符（跨机器人）', requestId: `qq:111111111:group:${G_PI_LEDGER}:1234567`, facts },
      { why: '群与本轮事实不符（跨群）', requestId: `qq:${BOT}:group:99999999:1234567`, facts },
      { why: '消息号不是纯数字', requestId: `qq:${BOT}:group:${G_PI_LEDGER}:abc`, facts },
      { why: '前缀只差一个字符', requestId: `qqq:${BOT}:group:${G_PI_LEDGER}:1234567`, facts },
      { why: '前后有空白（正则锚定 ⇒ 不认）', requestId: ` ${valid} `, facts },
      { why: 'requestId 缺席（旧调用点）', requestId: undefined, facts },
      { why: '平台事实缺席（无从核对 bot/群）', requestId: valid, facts: undefined },
      { why: '事实说这是私聊', requestId: valid, facts: { ...facts, messageType: 'private' } },
      { why: '事实说不是 QQ（微信的消息 id 是另一套）', requestId: valid, facts: { ...facts, transport: 'wechat' } },
      { why: '事实里没有群号', requestId: valid, facts: { ...facts, groupId: undefined } },
    ]
    for (const entry of negatives) {
      assert.equal(deriveInboundMessageId(entry.requestId, entry.facts as typeof facts | undefined),
        undefined, `这一形态**必须**不派生（${entry.why}）：requestId=${String(entry.requestId)}`)
    }
    readings['check40'] = {
      validShape: deriveInboundMessageId(valid, facts),
      negativeCases: negatives.map(entry => entry.why),
      negativeCount: negatives.length,
    }
  })

  /* ------------------- 42 A · 默认 per-inbound=1 时"2 条形态"发不出去（钉住后果） ------------------- */
  /*
   * ============================================================================
   *  ⚠️ 这一条**不是**新缺陷的"通过条件"，而是把一个**产品侧后果**如实钉住
   * ============================================================================
   * ```text
   * 事实：任务草稿不写 `perInboundMaxMessages` 时**缺省 = 1**（契约 DDL 口径）。
   *       而"语音 + 来源附录"这种回复形态是 **2 条**对外消息
   *       （`plannedOutgoingMessages` 给出 2）。
   * ⇒ P3-H 之前 per-inbound 对接管轮**不生效** ⇒ 这种回复照发（账面上 2 条、维度按 0 计）。
   * ⇒ P3-H 之后它**真的生效** ⇒ 整条回复**一条都发不出去**
   *      （不是"退化成纯文字"，是**什么都不发**）。
   * ```
   * 判据本身是**对的**（用户要的就是"超过每条入站上限就拒绝"）；这里钉住的是它的
   * **用户可见后果**，供裁定：默认任务要不要允许"语音+附录"？若要不许，模型选语音时
   * 应否退化成纯文字？—— 那是产品决定，**不在门里绕过、不在这里偷偷放行**。
   *
   * ⚠️ **P3-I 更新了这条控的期望码（产物变化，判据没放松）**：
   * ```text
   * P3-H 的读数：`group_task_planned_messages_invalid`（`decideSendAllowance` 里
   *   `planned > perInboundMaxMessages` 那一支，通用码）。
   * P3-I 的合同（CONTRACT §0.2 逐字）：`group_task_planned_messages_invalid`
   *   **只**用于"计划条数本身越界"的通用情形；「语音+附录这种要被识别成」更具体的
   *   `group_task_appendix_not_permitted`，且判定在 `reserveGroupSend` **之前**
   *   ⇒ 0 发送 **且 0 实例行**（P3-H 那条会先预留再被额度拒，账上会留痕迹）。
   * ⇒ 期望码改成更具体的那一个；"整条回复消失 / 不退化文字 / 0 发送"三条判据逐字不变。
   *   通用码并没有消失，它在契约层仍会为"计划条数越界"触发 —— 由控 51 单独钉住。
   * ```
   *
   * ⚠️ 与控 35 的分工：35 用 `perInboundMaxMessages = 2` 验"2 条形态**能**发 + 占满额度"；
   *    42 用**缺省 1** 验"同一形态**不能**发"。
   * ⚠️ 与控 47 的分工：47 用"任务声明只语音 + per-inbound=1 + 需要附录"验同一后果的
   *    具名码与全部不变式；42 是 P3-H 留下的**同一后果的旧读数**，两者现在的期望码一致。
   */
  const G_PI_DEFAULT = '10000060'
  const piDefaultTaskId = `qgt:p3h-per-inbound-default-${stamp}`
  await insertReplyTask({
    id: piDefaultTaskId, groupId: G_PI_DEFAULT, totalMaxMessages: 10,
    media: 'either', textFallback: true,
    /* ⚠️ **故意不传** `perInboundMaxMessages`：走 `insertReplyTask` 的缺省 3 —— 见下一条断言 */
    perInboundMaxMessages: 1,
  })
  const piDefaultView = await getGroupTask(db, piDefaultTaskId)
  assert.ok(piDefaultView !== undefined, '默认 per-inbound 夹具：任务行必须存在')
  const piDefaultMark = groupPackets(G_PI_DEFAULT).length
  const piDefaultPlanned = plannedOutgoingMessages({
    media: 'voice', hasAppendix: true, allowTextFallback: true,
  })
  const piDefaultOutcome = await dispatchGroupTaskReply(
    {
      db,
      now: () => Date.now(),
      dispatchToShell: async (instruction) => await negativeClient!.deliverGroupTaskFromCore(instruction),
    },
    {
      task: piDefaultView!, text: 'P3H 默认额度语音正文', media: 'voice',
      plannedMessages: piDefaultPlanned, inboundMessageId: inboundRequestIdOf(G_PI_DEFAULT, 910_004),
      appendixText: '来源：P3H 默认额度附录',
    },
  )
  await check('42 P3-H A · 默认 per-inbound=1 的"语音+附录=2"发不出去（钉住后果：整条回复消失，不是退化成文字；P3-I 起码更具体）', async () => {
    assert.equal(piDefaultView!.quota.perInboundMaxMessages, 1,
      `夹具的 perInboundMaxMessages 必须是 1（= 草稿缺省值）：${piDefaultView!.quota.perInboundMaxMessages}`)
    assert.equal(piDefaultPlanned, 2, `"语音+来源附录"是 2 条对外消息：${piDefaultPlanned}`)
    assert.equal(piDefaultOutcome.kind, 'not_attempted',
      `放不下 ⇒ 在**预留之前**就被拒（一条都不发）：${JSON.stringify(piDefaultOutcome)}`)
    /*
     * ⚠️ 拒因（P3-I 的合同口径，CONTRACT §0.2）：**语音+附录放不下**必须被识别成
     *    `group_task_appendix_not_permitted`，**不是**通用的
     *    `group_task_planned_messages_invalid`（后者只留给"计划条数本身越界"），
     *    也**不是** `group_task_per_inbound_exhausted`（"这一条入站已经用掉了"）。
     *    三者都 0 发送，但语义不同；门如实读更具体的那一个，不硬凑成通用码。
     */
    assert.equal(piDefaultOutcome.code, 'group_task_appendix_not_permitted',
      `语音+附录放不下必须是 group_task_appendix_not_permitted（CONTRACT §0.2）：`
      + `${JSON.stringify(piDefaultOutcome)}`
      + '（若读数是 group_task_planned_messages_invalid ⇒ 落回了通用码；'
      + '若读数是 group_task_per_inbound_exhausted ⇒ 判定跑到"用掉之后"去了）')
    assert.equal(groupPackets(G_PI_DEFAULT).length - piDefaultMark, 0,
      '被拒 ⇒ 正文与附录一条都不许发（不许"只发正文当兜底"）')
    const instances = await instanceRows(piDefaultTaskId)
    assert.equal(instances.length, 0,
      `被拒的预留不写实例：${JSON.stringify(instances)}`)
    readings['check42'] = {
      groupId: G_PI_DEFAULT,
      perInboundMaxMessages: piDefaultView!.quota.perInboundMaxMessages,
      planned: piDefaultPlanned,
      outcome: { kind: piDefaultOutcome.kind, code: piDefaultOutcome.code },
      sends: 0,
      taskRows: (await taskRows(G_PI_DEFAULT)).length,
      instances: 0,
      productQuestion: '默认任务（perInboundMaxMessages=1）上"语音+来源附录"=2 条 ⇒ 整条回复被拒（0 发送）。'
        + '判据本身符合"超过每条入站上限就拒绝"；未裁定的是产品侧：默认任务要不要允许这个形态，'
        + '以及模型选语音时是否应退化成纯文字。门不绕过、不放行，只钉住后果。'
        + '（P3-I 起拒因是更具体的 group_task_appendix_not_permitted，判定在预留之前 ⇒ 连实例行都没有。）',
    }
  })

  /* =======================================================================
   * 45–50 P3-I：**语音接管链**的条数 / 额度 / 兜底 / 未知 / 创建期冲突澄清
   * （`artifacts/local/qq-group-p3i/CONTRACT.md` §0 / §2 / §4 ③–⑥）
   *
   * ```text
   * 为什么这一段在进程内（与 22/29–35/39 同一条纪律）：
   *   ① 语音"这一轮到底发几条"是**账本 + 外壳指令**两层的事，
   *      真 main 里模型选不选语音不可控（装配层还没有让模型选语音的口子）；
   *   ② `textFallback` 的兜底与 `delivery_unknown` 的不重发要靠"让合成失败 / 让平台不回执"，
   *      那两档只能由门自己切（假 TTS 档位 + 假 OneBot 回执档位）。
   * 全部用：真 store + 隔离 PG + 真 `OneBotPrivateClient` + 假 OneBot + **假 TTS 端口**。
   * ```
   *
   * ⚠️ 这一段用**自己的**客户端（`voiceClient`，构造第 4 参是假 TTS），
   *    不重配 `negativeClient` —— 控 29/35 的读数恰恰是"没有合成能力 ⇒ 按任务授权回落文字"，
   *    给那一条装上 TTS 会把它们的旧读数变成假的。
   * ===================================================================== */
  const voiceLogs: ShellLog[] = []
  const voiceClient = p3iVoiceClient = new OneBotPrivateClient({
    ownerId: OWNER, botId: BOT, wsUrl, token: 'offline-group-task-combo-token-123456',
    multiUserEnabled: true, allowedGroupIds: [G_LEGACY],
  }, undefined, (reading) => voiceLogs.push(reading), fakeVoicePort)
  await voiceClient.connect()
  /* 语音客户端那条连接的徽章（控 49 要证明"没有切到别的连接/侧信道"） */
  const voiceConnMark = packets.length
  await voiceClient.listGroups()
  const voiceConn = packets.slice(voiceConnMark)
    .find((packet) => packet.action === 'get_group_list')?.connId ?? -1
  readings['p3iVoiceClientConnection'] = voiceConn

  /** 派发到"带假 TTS 的外壳"（与 22/29/34 的 `dispatchToShell` 同一形状） */
  const voiceDispatch = async (instruction: Parameters<typeof voiceClient.deliverGroupTaskFromCore>[0]) =>
    await voiceClient.deliverGroupTaskFromCore(instruction)
  /** 读一条派发的外壳结算读数（`deliveredCount` 只数平台已确认接受的条数） */
  const deliveredReadingOf = (deliveryKey: string): Record<string, unknown> | undefined =>
    voiceLogs.find((log) => log.event === 'qq_group_task_dispatch_delivered'
      && String(log.requestId ?? '') === deliveryKey) as unknown as Record<string, unknown> | undefined

  /* ------------------- 45 ③ 纯语音 = 1 条 ------------------- */
  const voiceOneTaskId = `qgt:p3i-voice-one-${stamp}`
  /*
   * ⚠️ `media: 'voice'` + `textFallback: false` 是 DDL 允许的组合
   *    （`check (media = 'either' or not text_fallback)`）；"只语音不得回落文字"正是这一条。
   */
  await insertReplyTask({
    id: voiceOneTaskId, groupId: G_P3I_VOICE_ONE, totalMaxMessages: 10,
    media: 'voice', textFallback: false, perInboundMaxMessages: 2,
  })
  const voiceOneView = await getGroupTask(db, voiceOneTaskId)
  assert.ok(voiceOneView !== undefined, '纯语音夹具：任务行必须存在')
  const voiceOneMark = groupPackets(G_P3I_VOICE_ONE).length
  voicePlan = { kind: 'ok' }
  const voiceOneSynthesisMark = voiceSynthesisCalls.length
  const voiceOnePlanned = plannedOutgoingMessages({
    media: 'voice', hasAppendix: false, allowTextFallback: voiceOneView!.textFallback,
  })
  const voiceOneText = 'P3I 纯语音正文'
  const voiceOneOutcome = await dispatchGroupTaskReply(
    { db, now: () => Date.now(), dispatchToShell: voiceDispatch },
    {
      task: voiceOneView!, text: voiceOneText, media: 'voice', plannedMessages: voiceOnePlanned,
      inboundMessageId: inboundRequestIdOf(G_P3I_VOICE_ONE, 930_001),
    },
  )
  await check('45 P3-I ③ **纯语音 = 1 条**：reserved_messages=1 · 假 OneBot 1 条 record · deliveredCount=1（且没有变成文字）', async () => {
    assert.equal(voiceOnePlanned, 1,
      `纯语音（无附录、无兜底）只占 **1** 条：plannedOutgoingMessages=${voiceOnePlanned}`)
    assert.equal(voiceOneOutcome.kind, 'sent', `纯语音轮应当结算成 sent：${JSON.stringify(voiceOneOutcome)}`)
    assert.equal(voiceOneOutcome.settlement, 'api_accepted',
      `结算必须是 api_accepted：${String(voiceOneOutcome.settlement)}`)
    /* 反例断言：外壳**真的合成过**（否则"1 条"可能只是"把文字当语音发了"） */
    assert.ok(voiceSynthesisCalls.length > voiceOneSynthesisMark,
      '外壳必须真的调用过 TTS 端口（本门是假 TTS，零真实合成）')

    const packetsThisCall = groupPackets(G_P3I_VOICE_ONE).slice(voiceOneMark)
    assert.equal(packetsThisCall.length, 1,
      `纯语音必须**恰好 1 条** send_group_msg（实际 ${packetsThisCall.length}）：`
      + JSON.stringify(packetsThisCall.map((packet) => segmentTypes(packet))))
    const only = packetsThisCall[0]!
    assert.deepEqual(segmentTypes(only), ['record'],
      `纯语音那一条必须是 **record 段**（不是文字）：${JSON.stringify(segmentTypes(only))}`)
    /* 音频是**结构合法的 WAV**（复用既有校验：`inspectWav`，不看内容） */
    const audio = recordBytesOf(only)
    assert.ok(audio !== undefined, 'record 段的 `file` 必须是 `base64://` 开头的音频')
    const inspection = inspectWav(audio!)
    assert.ok(inspection !== undefined,
      `发出去的音频必须是结构合法的 PCM16 WAV（既有校验 inspectWav）：${JSON.stringify({
        bytes: audio.byteLength, head: String.fromCharCode(...audio.slice(0, 4)),
      })}`)

    const instances = await instanceRows(voiceOneTaskId)
    assert.equal(instances.length, 1, `只该有 1 条实例：${JSON.stringify(instances)}`)
    const instance = instances[0]!
    assert.equal(instance.reserved_messages, 1,
      `纯语音必须只预留 1 条（契约 §0：不许因为"允许兜底"就要求 ≥2）：${instance.reserved_messages}`)
    assert.equal(instance.state, 'api_accepted', `实例应当 api_accepted：${instance.state}`)
    assert.ok(instance.platform_message_id !== null && instance.platform_message_id !== '',
      'api_accepted 必须有 platform_message_id')
    /* 外壳的结算读数：deliveredCount 只数**平台已确认接受**的条数 */
    const delivered = deliveredReadingOf(instance.id)
    assert.ok(delivered !== undefined,
      `外壳必须记下这条派发的结算读数：${JSON.stringify(voiceLogs.slice(-4))}`)
    assert.equal(Number(delivered!.deliveredCount), 1,
      `deliveredCount 必须是 **1**（只发了一条语音）：${JSON.stringify(delivered)}`)
    readings['check45'] = {
      groupId: G_P3I_VOICE_ONE, planned: voiceOnePlanned,
      sends: packetsThisCall.length, segmentTypes: segmentTypes(only),
      wav: inspection, instance, deliveredCount: delivered!.deliveredCount,
      ttsCalls: voiceSynthesisCalls.length - voiceOneSynthesisMark,
    }
  })

  /* ------------------- 46 ④ 语音 + 独立来源附录 = 2 条（语音在前） ------------------- */
  const voiceAppendixTaskId = `qgt:p3i-voice-appendix-${stamp}`
  await insertReplyTask({
    id: voiceAppendixTaskId, groupId: G_P3I_VOICE_APPENDIX, totalMaxMessages: 10,
    media: 'voice', textFallback: false, perInboundMaxMessages: 2,
  })
  const voiceAppendixView = await getGroupTask(db, voiceAppendixTaskId)
  assert.ok(voiceAppendixView !== undefined, '语音+附录夹具：任务行必须存在')
  const voiceAppendixMark = groupPackets(G_P3I_VOICE_APPENDIX).length
  voicePlan = { kind: 'ok' }
  const voiceAppendixText = '来源：P3I 独立附录'
  const voiceAppendixBody = 'P3I 语音+附录正文'
  const voiceAppendixPlanned = plannedOutgoingMessages({
    media: 'voice', hasAppendix: true, allowTextFallback: voiceAppendixView!.textFallback,
  })
  const voiceAppendixOutcome = await dispatchGroupTaskReply(
    { db, now: () => Date.now(), dispatchToShell: voiceDispatch },
    {
      task: voiceAppendixView!, text: voiceAppendixBody, media: 'voice',
      plannedMessages: voiceAppendixPlanned,
      inboundMessageId: inboundRequestIdOf(G_P3I_VOICE_APPENDIX, 930_002),
      appendixText: voiceAppendixText,
    },
  )
  await check('46 P3-I ④ **语音 + 独立来源附录 = 2 条**：reserved=2 · 假 OneBot 恰好 2 条且**语音在前** · deliveredCount=2', async () => {
    assert.equal(voiceAppendixPlanned, 2,
      `语音 + 独立附录 = **2** 条对外消息：plannedOutgoingMessages=${voiceAppendixPlanned}`)
    assert.equal(voiceAppendixOutcome.kind, 'sent',
      `语音+附录轮应当结算成 sent：${JSON.stringify(voiceAppendixOutcome)}`)
    assert.equal(voiceAppendixOutcome.settlement, 'api_accepted',
      `结算必须是 api_accepted：${String(voiceAppendixOutcome.settlement)}`)

    const packetsThisCall = groupPackets(G_P3I_VOICE_APPENDIX).slice(voiceAppendixMark)
    assert.equal(packetsThisCall.length, 2,
      `语音 + 附录必须**恰好 2 条** send_group_msg（实际 ${packetsThisCall.length}）：`
      + JSON.stringify(packetsThisCall.map((packet) => segmentTypes(packet))))
    /*
     * 顺序是**硬要求**（契约 §2 第 5 条 / §0 表格）：语音在前、附录在后。
     * ⚠️ 反过来的话群里会先看到一串来源、再看到正文 —— 那是"顺序错了"，不是"风格问题"。
     */
    assert.deepEqual(segmentTypes(packetsThisCall[0]!), ['record'],
      `第 1 条必须是**语音**（record 段）：${JSON.stringify(segmentTypes(packetsThisCall[0]!))}`)
    assert.deepEqual(segmentTypes(packetsThisCall[1]!), ['text'],
      `第 2 条必须是**纯文字附录**（不带引用段、不带 record）：${JSON.stringify(segmentTypes(packetsThisCall[1]!))}`)
    assert.equal(textOf(packetsThisCall[1]!), voiceAppendixText,
      `第 2 条的正文必须逐字是附录：${JSON.stringify(textOf(packetsThisCall[1]!))}`)
    const audio = recordBytesOf(packetsThisCall[0]!)
    assert.ok(audio !== undefined && inspectWav(audio) !== undefined,
      '第 1 条里必须是结构合法的 PCM16 WAV')
    /* 附录那一条不许带引用段（引用只属于正文那一条） */
    assert.equal(textOf(packetsThisCall[0]!).includes(voiceAppendixText), false,
      '附录不许被拼进第 1 条（它是**独立**第二条消息）')

    const instances = await instanceRows(voiceAppendixTaskId)
    assert.equal(instances.length, 1, `只该有 1 条实例：${JSON.stringify(instances)}`)
    const instance = instances[0]!
    assert.equal(instance.reserved_messages, 2, `语音+附录必须预留 2 条：${instance.reserved_messages}`)
    assert.equal(instance.state, 'api_accepted', `实例应当 api_accepted：${instance.state}`)
    const delivered = deliveredReadingOf(instance.id)
    assert.ok(delivered !== undefined,
      `外壳必须记下这条派发的结算读数：${JSON.stringify(voiceLogs.slice(-4))}`)
    assert.equal(Number(delivered!.deliveredCount), 2,
      `deliveredCount 必须是 **2**（正文与附录都被平台接受）：${JSON.stringify(delivered)}`)
    readings['check46'] = {
      groupId: G_P3I_VOICE_APPENDIX, planned: voiceAppendixPlanned,
      sends: packetsThisCall.length,
      order: packetsThisCall.map((packet) => segmentTypes(packet)),
      appendixText: textOf(packetsThisCall[1]!), instance,
      deliveredCount: delivered!.deliveredCount,
    }
  })

  /* ------------------- 47 ⑤ 额度不足：0 发送 + 具名码（不许降级/加额度/删来源） ------------------- */
  const voiceQuotaTaskId = `qgt:p3i-voice-quota-${stamp}`
  /*
   * 形态：任务**只语音**（不许改文字），per-inbound 只允许 1 条，而本轮**需要附录** ⇒ 2 条放不下。
   * 期望（契约 §0.2 落地口径）：`group_task_appendix_not_permitted` + **0 发送 + 0 实例行**
   *   （判定在 `reserveGroupSend` **之前**）。
   */
  await insertReplyTask({
    id: voiceQuotaTaskId, groupId: G_P3I_QUOTA, totalMaxMessages: 10,
    media: 'voice', textFallback: false, perInboundMaxMessages: 1,
  })
  const voiceQuotaView = await getGroupTask(db, voiceQuotaTaskId)
  assert.ok(voiceQuotaView !== undefined, '额度不足夹具：任务行必须存在')
  const voiceQuotaMark = groupPackets(G_P3I_QUOTA).length
  const voiceQuotaSynthesisMark = voiceSynthesisCalls.length
  const voiceQuotaPlanned = plannedOutgoingMessages({
    media: 'voice', hasAppendix: true, allowTextFallback: voiceQuotaView!.textFallback,
  })
  const voiceQuotaOutcome = await dispatchGroupTaskReply(
    { db, now: () => Date.now(), dispatchToShell: voiceDispatch },
    {
      task: voiceQuotaView!, text: 'P3I 额度不足正文', media: 'voice',
      plannedMessages: voiceQuotaPlanned,
      inboundMessageId: inboundRequestIdOf(G_P3I_QUOTA, 930_003),
      appendixText: '来源：P3I 放不下的附录',
    },
  )
  await check('47 P3-I ⑤ **额度不足 ⇒ 0 发送 + 具名码**：不许降级成纯文字 · 不许偷偷加额度 · 不许删掉来源', async () => {
    assert.equal(voiceQuotaView!.quota.perInboundMaxMessages, 1,
      `夹具的 per-inbound 必须是 1：${voiceQuotaView!.quota.perInboundMaxMessages}`)
    assert.equal(voiceQuotaPlanned, 2, `"语音+来源附录"是 2 条对外消息：${voiceQuotaPlanned}`)
    assert.equal(voiceQuotaOutcome.kind, 'not_attempted',
      `放不下 ⇒ 在**预留之前**就被拒（一条都不发）：${JSON.stringify(voiceQuotaOutcome)}`)
    /*
     * 具名码：契约 §0.2 要求"语音+附录这种要被识别成 appendix_not_permitted"，
     * 通用码 `planned_messages_invalid` 只留给"计划条数本身越界"。
     * ⚠️ 闭集 + 具体钉死两件都要：闭集防"放过"，具体码防"落回通用码"。
     */
    const QUOTA_DENIAL_CODES = ['group_task_appendix_not_permitted', 'group_task_planned_messages_invalid'] as const
    assert.ok((QUOTA_DENIAL_CODES as readonly string[]).includes(String(voiceQuotaOutcome.code)),
      `拒因必须落在闭集 {${QUOTA_DENIAL_CODES.join(' | ')}} 里（出现别的码 = 可能"放过"了）：`
      + `${JSON.stringify(voiceQuotaOutcome)}`)
    assert.equal(voiceQuotaOutcome.code, 'group_task_appendix_not_permitted',
      `契约 §0.2：语音+附录放不下必须被识别成 \`group_task_appendix_not_permitted\`，`
      + `不许落回通用的 \`group_task_planned_messages_invalid\`；实测 ${String(voiceQuotaOutcome.code)}`)

    /* ① 0 发送：正文与附录一条都不许发（"只发正文当兜底"也是降级） */
    const sends = groupPackets(G_P3I_QUOTA).length - voiceQuotaMark
    assert.equal(sends, 0, `被拒 ⇒ 0 条发送（实际 ${sends}）`)
    assert.equal(voiceSynthesisCalls.length, voiceQuotaSynthesisMark,
      '被拒 ⇒ 连语音都不该去合成（没额度就不做无谓的外部调用）')
    /* ② 0 实例行：判定在预留之前 ⇒ 账本里不该有任何东西 */
    const instances = await instanceRows(voiceQuotaTaskId)
    assert.equal(instances.length, 0, `被拒的预留不写实例：${JSON.stringify(instances)}`)
    /* ③ 不许偷偷加额度 */
    const after = await getGroupTask(db, voiceQuotaTaskId)
    assert.equal(after?.quota.perInboundMaxMessages, 1,
      `不许擅自改 perInboundMaxMessages：${String(after?.quota.perInboundMaxMessages)}`)
    assert.equal(after?.quota.totalMaxMessages, 10,
      `不许擅自加 totalMaxMessages：${String(after?.quota.totalMaxMessages)}`)
    assert.equal(after?.usedMessages, 0, `被拒不动额度：${String(after?.usedMessages)}`)
    /* ④ 不许把任务形态改掉（改成文字 = 降级；改成 either = 偷偷放宽） */
    assert.equal(after?.media, 'voice', `不许把任务的 media 改掉：${String(after?.media)}`)
    assert.equal(after?.textFallback, false, `不许偷偷打开 textFallback：${String(after?.textFallback)}`)
    assert.equal(after?.status, 'active', `任务仍是 active（拒的是这一轮，不是把任务废掉）：${String(after?.status)}`)
    /* ⑤ 不许删掉来源：任务内容/触发条件必须原样（没有"为了塞进一条而删引用"的动作） */
    assert.equal(after?.content.text, '门夹具正文', '任务正文不许被改写')
    readings['check47'] = {
      groupId: G_P3I_QUOTA, perInboundMaxMessages: 1, planned: voiceQuotaPlanned,
      outcome: { kind: voiceQuotaOutcome.kind, code: voiceQuotaOutcome.code },
      sends, instances: instances.length,
      quotaAfter: { perInbound: after?.quota.perInboundMaxMessages, total: after?.quota.totalMaxMessages },
      mediaAfter: after?.media, textFallbackAfter: after?.textFallback, statusAfter: after?.status,
      note: '判据是"放不下 ⇒ 一条都不发 + 具名码"；门不绕过、不放行。'
        + '"不许删掉来源"在本轮的可观测形态是：既没有发正文、也没有把附录拼进正文。',
    }
  })

  /* ------------------- 48 ⑥a 失败回落：一条文字兜底，不加条数 ------------------- */
  const fallbackTaskId = `qgt:p3i-fallback-${stamp}`
  /*
   * ⚠️ `media: 'either'` 是 DDL 要求（`check (media = 'either' or not text_fallback)`）：
   *    "语音/文字都可能 + 允许兜底"才是合法组合。
   */
  await insertReplyTask({
    id: fallbackTaskId, groupId: G_P3I_FALLBACK, totalMaxMessages: 10,
    media: 'either', textFallback: true, perInboundMaxMessages: 1,
  })
  const fallbackView = await getGroupTask(db, fallbackTaskId)
  assert.ok(fallbackView !== undefined, '失败回落夹具：任务行必须存在')
  const fallbackMark = groupPackets(G_P3I_FALLBACK).length
  const fallbackSynthesisMark = voiceSynthesisCalls.length
  const fallbackText = 'P3I 兜底文字'
  /* 让假 TTS **明确失败**（具名原因；抛错在旧/新两版实现里都会被折成 reason） */
  voicePlan = { kind: 'throw', code: 'voice_synthesis_failed' }
  const fallbackPlanned = plannedOutgoingMessages({
    media: 'voice', hasAppendix: false, allowTextFallback: fallbackView!.textFallback,
  })
  const fallbackOutcome = await dispatchGroupTaskReply(
    { db, now: () => Date.now(), dispatchToShell: voiceDispatch },
    {
      task: fallbackView!, text: fallbackText, media: 'voice', plannedMessages: fallbackPlanned,
      inboundMessageId: inboundRequestIdOf(G_P3I_FALLBACK, 930_004),
    },
  )
  await check('48 P3-I ⑥a **语音失败 ⇒ 一条文字兜底**：不加条数（reserved 仍 1）· 假 OneBot 恰好 1 条文字 · deliveredCount=1', async () => {
    /*
     * ======================================================================
     *  ⚠️ 这条同时钉住 CONTRACT §0 的**删掉 `voiceFloor`**
     * ======================================================================
     * ```text
     * 旧（P3-G）：media==='voice' && allowTextFallback ⇒ 计划条数**至少 2**
     *            ⇒ 在 perInboundMaxMessages=1 的任务上，纯语音+兜底**永远发不出去**
     *            （`group_task_planned_messages_invalid`）。
     * 新（P3-I）：兜底是**替代**那条语音，不是追加 ⇒ 计划条数仍是 **1**。
     * ```
     */
    assert.equal(fallbackPlanned, 1,
      `"语音失败 ⇒ 文字兜底"只占 **1** 条（兜底是替代，不是叠加；voiceFloor 必须已删除）：`
      + `plannedOutgoingMessages=${fallbackPlanned}`)
    assert.ok(voiceSynthesisCalls.length > fallbackSynthesisMark,
      '必须真的尝试过合成（否则"兜底"是假的：根本没走语音那条路）')
    assert.equal(fallbackOutcome.kind, 'sent',
      `兜底之后应当算成功发送：${JSON.stringify(fallbackOutcome)}`)
    assert.equal(fallbackOutcome.settlement, 'api_accepted',
      `兜底那一条应当 api_accepted：${String(fallbackOutcome.settlement)}`)

    const packetsThisCall = groupPackets(G_P3I_FALLBACK).slice(fallbackMark)
    assert.equal(packetsThisCall.length, 1,
      `兜底**只发一条**（不许"语音 + 文字"两条，也不许"两条文字"）：实际 ${packetsThisCall.length} `
      + JSON.stringify(packetsThisCall.map((packet) => segmentTypes(packet))))
    assert.deepEqual(segmentTypes(packetsThisCall[0]!), ['text'],
      `兜底那一条必须是**纯文字**：${JSON.stringify(segmentTypes(packetsThisCall[0]!))}`)
    assert.equal(textOf(packetsThisCall[0]!), fallbackText,
      `兜底正文必须逐字是这一轮的正文：${JSON.stringify(textOf(packetsThisCall[0]!))}`)

    const instances = await instanceRows(fallbackTaskId)
    assert.equal(instances.length, 1, `只该有 1 条实例：${JSON.stringify(instances)}`)
    const instance = instances[0]!
    assert.equal(instance.reserved_messages, 1,
      `兜底**不加条数**：reserved_messages 仍是 1（实际 ${instance.reserved_messages}）`)
    assert.equal(instance.state, 'api_accepted', `实例应当 api_accepted：${instance.state}`)
    const delivered = deliveredReadingOf(instance.id)
    assert.ok(delivered !== undefined,
      `外壳必须记下这条派发的结算读数：${JSON.stringify(voiceLogs.slice(-4))}`)
    assert.equal(Number(delivered!.deliveredCount), 1,
      `deliveredCount 必须是 **1**（兜底那一条）：${JSON.stringify(delivered)}`)
    /* 读数：外壳必须留一条"语音→文字"的原因（不静默降级） */
    const fallbackLogged = voiceLogs.filter((log) => /voice_fallback|voice_synthesis_failed/.test(log.event))
    assert.ok(fallbackLogged.length > 0,
      `"语音失败 ⇒ 文字兜底"必须留具名读数（不许静默降级）：${JSON.stringify(voiceLogs.slice(-4))}`)
    readings['check48'] = {
      groupId: G_P3I_FALLBACK, planned: fallbackPlanned, sends: packetsThisCall.length,
      segmentTypes: segmentTypes(packetsThisCall[0]!), text: textOf(packetsThisCall[0]!), instance,
      deliveredCount: delivered!.deliveredCount,
      synthesisAttempts: voiceSynthesisCalls.length - fallbackSynthesisMark,
      fallbackReadings: fallbackLogged.map((log) => log.event),
    }
  })
  voicePlan = { kind: 'ok' }

  /* ------------------- 49 ⑥b delivery_unknown：不重发、不切侧信道 ------------------- */
  const unknownTaskId = `qgt:p3i-unknown-${stamp}`
  /*
   * `media: 'either'` + `textFallback: true`：结果不明时**连兜底也不许发**
   * （消息可能已经送达 ⇒ 再发一条文字就是群里多一条）。
   * ⚠️ per-inbound 给 3：这一条验的是"未知不重发"，不是"额度"（额度见控 47）。
   */
  await insertReplyTask({
    id: unknownTaskId, groupId: G_P3I_UNKNOWN, totalMaxMessages: 10,
    media: 'either', textFallback: true, perInboundMaxMessages: 3,
  })
  const unknownView = await getGroupTask(db, unknownTaskId)
  assert.ok(unknownView !== undefined, '未知结局夹具：任务行必须存在')
  const unknownAttemptMark = groupPackets(G_P3I_UNKNOWN).length
  voicePlan = { kind: 'ok' }
  /* 平台"接受"了但没有回执 id ⇒ 既有口径就是**结果不明**（不是失败） */
  sendModes.set(G_P3I_UNKNOWN, 'no_id')
  const unknownPlanned = plannedOutgoingMessages({
    media: 'voice', hasAppendix: false, allowTextFallback: unknownView!.textFallback,
  })
  const unknownOutcome = await dispatchGroupTaskReply(
    { db, now: () => Date.now(), dispatchToShell: voiceDispatch },
    {
      task: unknownView!, text: 'P3I 未知结局正文', media: 'voice', plannedMessages: unknownPlanned,
      inboundMessageId: inboundRequestIdOf(G_P3I_UNKNOWN, 930_005),
    },
  )
  sendModes.delete(G_P3I_UNKNOWN)
  await check('49 P3-I ⑥b **`delivery_unknown` ⇒ 不重发、不切侧信道**：假 OneBot 计数不增（含不兜底、不补发）', async () => {
    assert.equal(unknownOutcome.kind, 'unknown',
      `没有回执 id ⇒ 结果不明（不许猜成成功/失败）：${JSON.stringify(unknownOutcome)}`)
    assert.equal(unknownOutcome.settlement, 'unknown',
      `结算必须是 unknown：${String(unknownOutcome.settlement)}`)
    const instances = await instanceRows(unknownTaskId)
    assert.equal(instances.length, 1, `只该有 1 条实例：${JSON.stringify(instances)}`)
    const instance = instances[0]!
    assert.equal(instance.state, 'unknown', `实例应当落到 unknown：${instance.state}`)
    assert.equal(instance.platform_message_id, null, 'unknown 不许带 platform_message_id')
    const task = await getGroupTask(db, unknownTaskId)
    assert.equal(task?.status, 'paused',
      `unknown 应当把任务置 paused（结果不明绝不继续发）：${String(task?.status)}`)

    /*
     * **这一条的主角**：一次尝试之后就**再也不许**有任何发送。
     * "不重发 + 不兜底 + 不切侧信道"三种越界都会让这个计数变大。
     */
    const attempts = groupPackets(G_P3I_UNKNOWN).length - unknownAttemptMark
    assert.equal(attempts, 1,
      `一条指令 = **一次**尝试（"重发/兜底"会变成 2 条或更多）：实际 ${attempts} `
      + JSON.stringify(groupPackets(G_P3I_UNKNOWN).slice(unknownAttemptMark).map((packet) => segmentTypes(packet))))
    await delay(900)
    assert.equal(groupPackets(G_P3I_UNKNOWN).length - unknownAttemptMark, 1,
      `稳定期之后假 OneBot 计数**不增**（不许迟到补发/兜底）：`
      + `${groupPackets(G_P3I_UNKNOWN).length - unknownAttemptMark}`)
    /* 不切侧信道：所有尝试都必须来自**这一条**客户端连接 */
    assert.deepEqual(connectionsSendingTo(G_P3I_UNKNOWN), [voiceConn],
      `所有发送必须来自这条客户端连接（切侧信道会落在另一条连接上）：`
      + `期望 [${voiceConn}] · 实际 ${JSON.stringify(connectionsSendingTo(G_P3I_UNKNOWN))}`)
    /* 读数：外壳自己也不许把这一条算成"已确认" */
    const delivered = deliveredReadingOf(instance.id)
    assert.ok(delivered !== undefined,
      `外壳必须记下这条派发的结算读数：${JSON.stringify(voiceLogs.slice(-4))}`)
    assert.equal(Number(delivered!.deliveredCount), 0,
      `deliveredCount 必须是 **0**（没有回执 id ⇒ 一条也没"确认接受"）：${JSON.stringify(delivered)}`)
    readings['check49'] = {
      groupId: G_P3I_UNKNOWN, planned: unknownPlanned,
      outcome: { kind: unknownOutcome.kind, settlement: unknownOutcome.settlement },
      attempts, afterDelay: groupPackets(G_P3I_UNKNOWN).length - unknownAttemptMark,
      segmentTypes: groupPackets(G_P3I_UNKNOWN).slice(unknownAttemptMark).map((packet) => segmentTypes(packet)),
      connectionIds: connectionsSendingTo(G_P3I_UNKNOWN),
      instance, taskStatus: task?.status, deliveredCount: delivered!.deliveredCount,
    }
  })

  /* ------------------- 50 创建期冲突澄清：提前拒，不许悄悄建出一个发不出的任务 ------------------- */
  /*
   * ```text
   * 条件：任务声明「必须语音」（media==='voice'）**且**「必须带来源附录」（requireAppendix=true），
   *      而 perInboundMaxMessages = 1
   * 处理：**创建期就拒绝并要求澄清**（具名码 `group_task_voice_appendix_needs_two_messages`），
   *      不是建单之后等生成阶段才发现（那样主人会拿到一条永远发不出去的任务）。
   * ```
   * ⚠️ 反例（同一形态、per-inbound=2）**必须建得出来** —— 否则"拒绝"可能只是
   *    "任何带 requireAppendix 的草稿都被拒"，那这条控就没测到冲突本身。
   */
  /** 探针执行端口：**不发送任何东西**（这些检查只关心"建不建得出来"） */
  const creationProbe: GroupTaskRuntimeDeps['execute'] = async () => ({ kind: 'failed', code: 'gate_p3i_probe_no_send' })
  const conflictDraft = createDraft({
    groupId: G_P3I_CONFLICT, groupNameHint: 'P3I冲突群',
    media: 'voice', textFallback: false, perInboundMaxMessages: 1, requireAppendix: true,
  })
  const conflictMark = groupPackets(G_P3I_CONFLICT).length
  const conflictOutcome = await handleGroupTaskTurn(runtimeDeps(creationProbe), {
    draft: conflictDraft,
    current: { id: 'evt-p3i-conflict', text: 'P3I-CONFLICT' },
    sourceEventId: `evt-p3i-conflict-${stamp}`,
  })
  const conflictOkDraft = createDraft({
    groupId: G_P3I_CONFLICT_OK, groupNameHint: 'P3I冲突对照群',
    media: 'voice', textFallback: false, perInboundMaxMessages: 2, requireAppendix: true,
  })
  const conflictOkMark = groupPackets(G_P3I_CONFLICT_OK).length
  const conflictOkOutcome = await handleGroupTaskTurn(runtimeDeps(creationProbe), {
    draft: conflictOkDraft,
    current: { id: 'evt-p3i-conflict-ok', text: 'P3I-CONFLICT-OK' },
    sourceEventId: `evt-p3i-conflict-ok-${stamp}`,
  })
  await check('50 P3-I 创建期冲突澄清：voice+requireAppendix+perInbound=1 ⇒ **创建被拒**（group_task_voice_appendix_needs_two_messages · 0 任务行 · 0 发送），perInbound=2 则建得出来', async () => {
    assert.equal(conflictOutcome.result.kind, 'failed',
      `这一形态必须在**创建期**被拒：${JSON.stringify(conflictOutcome.result)}`)
    assert.equal((conflictOutcome.result as { code?: string }).code,
      'group_task_voice_appendix_needs_two_messages',
      `拒因必须是具名码 group_task_voice_appendix_needs_two_messages（契约 §0.1）；`
      + `实测 ${JSON.stringify(conflictOutcome.result)}`
      + '（若读数是 invalid_output ⇒ 草稿闭集还不认 requireAppendix；'
      + '若读数是别的 ⇒ 判定没落在创建期）')
    /* 没有建出这个任务行 —— "先建单、等生成阶段才发现"是被明确禁止的 */
    const conflictRows = await taskRows(G_P3I_CONFLICT)
    assert.equal(conflictRows.length, 0,
      `创建被拒 ⇒ **不许**留下任务行：${JSON.stringify(conflictRows)}`)
    assert.equal(groupPackets(G_P3I_CONFLICT).length - conflictMark, 0,
      '创建被拒 ⇒ 一条都不许发')

    /* 反例：同一形态、per-inbound = 2 ⇒ 应当建得出来（冲突是"1 条放不下 2 条"，不是"禁语音附录"） */
    assert.equal(conflictOkOutcome.result.kind, 'created',
      `per-inbound=2 时同一形态必须建得出来（否则拒绝的理由不是"条数放不下"）：`
      + `${JSON.stringify(conflictOkOutcome.result)}`)
    const okRows = await taskRows(G_P3I_CONFLICT_OK)
    assert.equal(okRows.length, 1, `对照任务应当落 1 行：${JSON.stringify(okRows)}`)
    const okTask = await getGroupTask(db, okRows[0]!.id)
    assert.equal(okTask?.quota.perInboundMaxMessages, 2,
      `对照任务的 per-inbound 应当是 2：${String(okTask?.quota.perInboundMaxMessages)}`)
    assert.equal(okTask?.media, 'voice', `对照任务的 media 应当是 voice：${String(okTask?.media)}`)
    assert.equal(groupPackets(G_P3I_CONFLICT_OK).length - conflictOkMark, 0,
      '夹具的执行端口不发送任何东西 ⇒ 这一组不该有 send_group_msg（只验创建期）')
    readings['check50'] = {
      conflict: {
        draft: {
          media: 'voice', requireAppendix: true, perInboundMaxMessages: 1,
        },
        result: conflictOutcome.result,
        taskRows: conflictRows.length,
        sends: groupPackets(G_P3I_CONFLICT).length - conflictMark,
      },
      negativeControl: {
        draft: { media: 'voice', requireAppendix: true, perInboundMaxMessages: 2 },
        resultKind: conflictOkOutcome.result.kind,
        taskRows: okRows.length,
        media: okTask?.media, perInbound: okTask?.quota.perInboundMaxMessages,
        sends: groupPackets(G_P3I_CONFLICT_OK).length - conflictOkMark,
      },
    }
  })

  /* ------------------- 51 分层不变式：通用码没有消失，只是不再冒充"附录放不下" ------------------- */
  /*
   * ============================================================================
   *  §0.2 的**分层**判据（防止"把两个码混成一个"的两种退化）
   * ============================================================================
   * ```text
   * 通用码 `group_task_planned_messages_invalid` —— 只留给"计划条数**本身**越界"：
   *     非安全整数 / < 1 / > maxPlannedMessages   ⇒ 契约层 `decideSendAllowance` 仍必须给这个码
   * 具体的 `group_task_appendix_not_permitted` —— "语音 + 来源附录"这一轮需要 2 条而形态放不下，
   *     判定在**预留之前**（控 47 的 0 发送 + 0 实例行就是它的证据面）
   * ```
   * ⚠️ 为什么需要这条：控 47 只断言"附录形态给更具体的码"。若有人（a）把那个码删掉、
   *    或（b）把**通用码**也一起删掉/吞掉，47 仍然能绿 —— 那就变成"闭集是空的"。
   *    这条纯函数负控把契约层那两个分支分别钉住：**两条通路都活着，但各管各的**。
   */
  await check('51 P3-I §0.2 分层负控（纯函数）：`decideSendAllowance` 仍为"计划条数本身越界"给 `group_task_planned_messages_invalid`，与附录码互不冒充', async () => {
    const task = voiceQuotaView!
    /** 构造一次 §0.2 判据输入（只用契约层，不碰库） */
    const decide = (plannedMessages: number) => decideSendAllowance({
      task,
      now: Date.now(),
      target: task.target,
      expectedVersion: null,
      plannedMessages,
      plannedMedia: 'voice',
      usage: { totalMessages: 0, slotMessages: 0, perInboundMessages: 0, lastSendAt: null },
    })
    /* ① 超过契约上限（`maxPlannedMessages`）⇒ 通用码 */
    const tooMany = decide(99)
    assert.equal(tooMany.kind, 'denied', `99 条计划必须被拒：${JSON.stringify(tooMany)}`)
    assert.equal((tooMany as { code?: string }).code, 'group_task_planned_messages_invalid',
      `"计划条数本身越界"必须是 group_task_planned_messages_invalid：${JSON.stringify(tooMany)}`)
    /* ② 非安全整数 / 0 ⇒ 同一个通用码 */
    for (const bad of [0, 1.5]) {
      const denied = decide(bad)
      assert.equal((denied as { code?: string }).code, 'group_task_planned_messages_invalid',
        `plannedMessages=${String(bad)} 必须是 group_task_planned_messages_invalid：${JSON.stringify(denied)}`)
    }
    /*
     * ③ 契约层对"2 条 > per-inbound=1"**仍然**给通用码 —— 这是**预期**的：
     *    具体码属于"这一轮需要附录"这个**运行时事实**，契约层看不到附录，只能按条数判。
     *    两个码的分工由此可读：契约层 = 条数，运行时层 = 形态。
     */
    const twoOverOne = decide(2)
    assert.equal((twoOverOne as { code?: string }).code, 'group_task_planned_messages_invalid',
      `契约层只能按条数判 ⇒ 2 > 1 给通用码（附录不在契约层的信息里）：${JSON.stringify(twoOverOne)}`)
    /* ④ 额度内 ⇒ 放行（反例：不许"什么都拒"） */
    const granted = decide(1)
    assert.equal(granted.kind, 'granted',
      `1 条 ≤ per-inbound=1 ⇒ 必须放行：${JSON.stringify(granted)}`)
    readings['check51'] = {
      plannedLayers: {
        contractLayer: {
          planned99: (tooMany as { code?: string }).code,
          planned0: (decide(0) as { code?: string }).code,
          planned1_5: (decide(1.5) as { code?: string }).code,
          planned2_over_perInbound1: (twoOverOne as { code?: string }).code,
          planned1: granted.kind,
        },
        runtimeLayer: '控 47：语音 + 来源附录放不下 ⇒ group_task_appendix_not_permitted（在预留之前）',
      },
      note: '两条通路都活着、各管各的：契约层按**条数**判（通用码），运行时层按**形态**判（附录码）。',
    }
  })

  // Quoted group voice: the quoted guarded text is a separate message, before a standalone record.
  const quoteFixture = async (n: number, perInboundMaxMessages = 3, textFallback = false) => {
    const groupId = String(10000078 + n), taskId = `qgt:p3i-quote-${n}-${stamp}`, quoteMessageId = `-${940000+n}`
    await insertReplyTask({ id: taskId, groupId, totalMaxMessages: 10,
      media: textFallback ? 'either' : 'voice', textFallback, perInboundMaxMessages })
    const task = (await getGroupTask(db, taskId))!
    const requestId = inboundRequestIdOf(groupId, Number(quoteMessageId))
    ;(voiceClient as unknown as { rememberActiveInbound(g: string, r: string, m: string): void })
      .rememberActiveInbound(groupId, requestId, quoteMessageId)
    return { groupId, taskId, task, quoteMessageId, requestId }
  }
  const quoteSend = async (f: Awaited<ReturnType<typeof quoteFixture>>, appendixText?: string, plannedMessages?: number) =>
    await dispatchGroupTaskReply({ db, now: Date.now, dispatchToShell: voiceDispatch }, {
      task: f.task, text: '模型最终正文', media: 'voice', quoteMessageId: f.quoteMessageId,
      inboundMessageId: f.requestId, ...(appendixText === undefined ? {} : { appendixText }),
      plannedMessages: plannedMessages ?? plannedOutgoingMessages({ media: 'voice', hasQuote: true,
        hasAppendix: appendixText !== undefined, allowTextFallback: f.task.textFallback }),
    })
  await check('52 group voice: quoted text then standalone record; reserve two; signed inbound retained', async () => {
    const f = await quoteFixture(0)
    const result = await quoteSend(f)
    assert.equal(result.kind, 'sent')
    const sent = groupPackets(f.groupId)
    assert.deepEqual(sent.map(segmentTypes), [['reply', 'text'], ['record']])
    assert.equal(textOf(sent[0]!), '模型最终正文')
    const message = (sent[0]!.params as { message: { type: string; data: { id?: string } }[] }).message
    assert.equal(message[0]!.data.id, f.quoteMessageId)
    const rows = await instanceRows(f.taskId)
    assert.equal(rows[0]!.reserved_messages, 2)
    assert.equal(Number(deliveredReadingOf(rows[0]!.id)?.deliveredCount), 2)
    const stored = await pool.query('select inbound_message_id from qq_group_send_instances where task_id=$1', [f.taskId])
    assert.equal(stored.rows[0].inbound_message_id, f.requestId)
  })
  await check('53 group voice with source: quoted text / record / unquoted appendix, three reserved', async () => {
    const f = await quoteFixture(1)
    assert.equal((await quoteSend(f, '来源：夹具')).kind, 'sent')
    const sent = groupPackets(f.groupId)
    assert.deepEqual(sent.map(segmentTypes), [['reply', 'text'], ['record'], ['text']])
    assert.equal(textOf(sent[2]!), '来源：夹具')
    const rows = await instanceRows(f.taskId)
    assert.equal(rows[0]!.reserved_messages, 3)
    assert.equal(Number(deliveredReadingOf(rows[0]!.id)?.deliveredCount), 3)
  })
  await check('54 insufficient quote quota: no sends, instances or synthesis', async () => {
    const f = await quoteFixture(2, 1), mark = voiceSynthesisCalls.length
    const result = await quoteSend(f)
    assert.equal(result.code, 'group_task_voice_quote_quota_insufficient')
    assert.equal(groupPackets(f.groupId).length, 0)
    assert.equal((await instanceRows(f.taskId)).length, 0)
    assert.equal(voiceSynthesisCalls.length, mark)
  })
  await check('55 underreserved quote: no sends or instances', async () => {
    const f = await quoteFixture(3)
    assert.equal((await quoteSend(f, undefined, 1)).code, 'group_task_planned_messages_invalid')
    assert.equal(groupPackets(f.groupId).length, 0)
    assert.equal((await instanceRows(f.taskId)).length, 0)
  })
  await check('56 synthesis fails before quote: no orphan quoted text', async () => {
    const f = await quoteFixture(4)
    voicePlan = { kind: 'throw', code: 'voice_synthesis_failed' }
    try { assert.equal((await quoteSend(f)).kind, 'failed') } finally { voicePlan = { kind: 'ok' } }
    assert.equal(groupPackets(f.groupId).length, 0)
  })
  await check('57 record rejected after quote: only one accepted text; no duplicate fallback or appendix', async () => {
    const f = await quoteFixture(5, 3, true)
    recordSendModes.set(f.groupId, 'error')
    const result = await quoteSend(f, '来源：夹具')
    assert.equal(result.kind, 'sent')
    assert.match(result.code ?? '', /^voice_failed_after_quote:/)
    assert.deepEqual(groupPackets(f.groupId).map(segmentTypes), [['reply', 'text'], ['record']])
    const rows = await instanceRows(f.taskId)
    assert.equal(Number(deliveredReadingOf(rows[0]!.id)?.deliveredCount), 1)
  })
  await check('58 record unknown after quote: pause, no replay or appendix', async () => {
    const f = await quoteFixture(6, 3, true)
    recordSendModes.set(f.groupId, 'no_id')
    assert.equal((await quoteSend(f, '来源：夹具')).kind, 'unknown')
    await delay(100)
    assert.deepEqual(groupPackets(f.groupId).map(segmentTypes), [['reply', 'text'], ['record']])
    assert.equal((await getGroupTask(db, f.taskId))?.status, 'paused')
    const rows = await instanceRows(f.taskId)
    assert.equal(Number(deliveredReadingOf(rows[0]!.id)?.deliveredCount), 1)
  })
  await voiceClient.close().catch(() => undefined)
  p3iVoiceClient = undefined
  readings['negativeRecheck'] = negativeLogs
    .filter((log) => log.event === 'qq_group_task_send_not_authorized'
      || log.event === 'qq_group_task_send_api_accepted'
      || log.event === 'qq_group_task_send_failed')
  await negativeClient.close().catch(() => undefined)
  negativeClient = undefined
} catch (error) {
  scenarioError = error
} finally {
  await shellA?.stop().catch(() => undefined)
  await shellB?.stop().catch(() => undefined)
  await p3iVoiceClient?.close().catch(() => undefined)
  await negativeClient?.close().catch(() => undefined)
  for (const host of [hostA, hostB, hostC]) {
    if (host === undefined) continue
    await stopHost(host, 'finally').catch(() => host.kill())
  }
}

/* ========================================================================= */
/* 10. 证据 + 退出码                                                         */
/* ========================================================================= */
if (scenarioError !== undefined) {
  console.error('场景中断：', scenarioError)
  failures.push(`scenario: ${String(scenarioError)}`)
}
const passed = checks.length
const total = passed + failures.length
const result = {
  status: failures.length === 0 ? 'PASS' : 'FAIL',
  checks: total,
  passed,
  failed: failures.length,
  failures,
  controls: checks,
  readings,
  boundary: {
    database: `isolated PostgreSQL ${String(readings['isolatedDatabase'] ?? '?')}`,
    network: 'LOCAL_LOOPBACK_ONLY',
    realOneBot: 'FAKE_WS_FIXTURE_ONLY',
    realQq: 'NOT RUN',
    realModel: 'NONE',
    realTts: 'NONE',
    realMainCovers: ['01 flag-off', '02 create+send', '03 clarify/not_found/hint_conflict',
      '04 legacy allowlist vs task', '09 legacy QQ replies', '10 restart recovery',
      '11-13 inbound routing', '14-15 shell admission (15 = 静默拒绝)',
      '16-17 native quote (legacy path)',
      '18 no_reply through shell', '19-20 model decline',
      '21/23-28 P3-G takeover: quota / settle / no-double-send / counting',
      '33 P3-H A: per-inbound ledger key (真外壳 requestId 派生)',
      '36 P3-H B: 耗尽后名单外群静默', '37 P3-H B: 耗尽后名单内群恢复默认路线',
      '38 P3-H C: 两条入站各自引用/各自关联',
      '41 P3-H B: 已过期任务不许长期挡门（+ 还没开始仍抑制）',
      '43 P3-I ①: `send_once` 由 `DELIVER_GROUP_TASK` 指令驱动且从外壳那条连接发出',
      '44 P3-I ②: 群列表与发送都只来自外壳那条连接（无侧信道双发）'],
    inProcessCovers: ['05 revoked', '06 version changed', '07 expired', '08 quota exhausted',
      '22 P3-G atomic reserve (two concurrent reservations, one budget)',
      '29 P3-G voice+appendix counting', '30-32 P3-G protocol negatives (expired / replay / timeout)',
      '34 P3-H A: 同一入站第二条被拒（per-inbound 分账）',
      '35 P3-H A: 语音+附录=2 占同一条入站额度',
      '39 P3-H C: 并发两份预留各按各的入站键',
      '40 P3-H A: deriveInboundMessageId 纯函数负控（13 条必须不派生的形态）',
      '42 P3-H A: 默认 per-inbound=1 下"语音+附录=2"被拒（钉住产品侧后果）',
      '45 P3-I ③: 纯语音 = 1 条（record 段 + 合法 WAV + deliveredCount=1）',
      '46 P3-I ④: 语音 + 独立附录 = 2 条且语音在前',
      '47 P3-I ⑤: 额度不足 ⇒ 0 发送 + `group_task_appendix_not_permitted`',
      '48 P3-I ⑥a: 语音失败 ⇒ 一条文字兜底（不加条数；voiceFloor 必须已删）',
      '49 P3-I ⑥b: `delivery_unknown` ⇒ 不重发 / 不兜底 / 不切侧信道',
      '50 P3-I 创建期冲突澄清: voice + requireAppendix + per-inbound=1 ⇒ 创建被拒（含 per-inbound=2 的反例）'],
    p3iSendOnceGoesThroughBridge: 'P3-I ① 的判据是**归因**，不是"假 OneBot 收到了 send_group_msg"'
      + '（后者在 P3-H 的核心自建侧信道下同样成立 —— 那正是最容易写出"假绿"的形态）。'
      + '两条归因：a) 那一条 packet 的 `connId` 逐字等于**外壳那条连接**（门里用"外壳自己打一次 '
      + '`get_group_list`"给连接打徽章，不猜时序）；b) 外壳的派发处理器**收到了这一条指令**，'
      + '且 `deliveryKey` 逐字等于账本里的实例 id（那就是这次原子预留）。'
      + '控 44 顺着同一条证据面把侧信道也钉死：群列表与发送**都只来自外壳那条连接**，同一正文只发 1 条。',
    p3iVoiceCountsFollowContractZero: 'P3-I ③④ 的条数口径完全来自 CONTRACT §0 的表：纯语音 **1**、'
      + '语音+独立来源附录 **2**、原生引用**不计条数**、兜底**仍是 1**（替代，不是追加）。'
      + '关键回归：旧的 `voiceFloor`（`media=voice && allowTextFallback ⇒ 至少 2`）必须**已删除** —— '
      + '否则"纯语音 + 允许兜底"的任务在 `perInboundMaxMessages=1` 上永远发不出去（控 48 就是这条的读数面）。',
    p3iVoiceProvesStructureNotPlayability: '③④ 证明的是**发出去的东西是语音段、且音频是结构合法 PCM16 WAV**'
      + '（复用 `inspectWav`，不看内容），**不是**"群里真的能播放"。真实可播放性要靠 CONTRACT §5 的'
      + '另行授权试听 —— 夹具通过**不能替代**那一步。',
    p3iUnknownNeverResends: '控 49：`delivery_unknown` 之后**一次都不许再发** —— 不重发、不兜底、不切侧信道。'
      + '三种越界都会让"假 OneBot 上的尝试次数"变大；稳定期再读一次是防"迟到补发"。'
      + '口径沿用 P3-G 的 `deliveredCount`：没有回执 id ⇒ 0（没拿到回执就不许说"确定发出去了"）。',
    p3iCreationConflictIsEarly: '控 50：冲突在**创建期**就拒（`group_task_voice_appendix_needs_two_messages`），'
      + '**不留任务行** —— "先建单、等生成阶段才发现"会让主人拿到一条永远发不出去的任务。'
      + '⚠️ `requireAppendix` 本批**零存储改动**（qq-chain 确认：只用于创建期判定，不进 `qq_group_tasks`），'
      + '因此生成期只能按"本轮是否带附录 × perInboundMaxMessages"判，**不能**判"任务声明不带附录"。',
    p3hPerInboundEffective: 'P3-H 把 P3-G 的具名缺口（`perInboundMaxMessages` 对接管轮不生效）补上了：'
      + '核心**不**接受模型可填的 `messageId`（`platformFactsProblems` 对 QQ 的禁止仍然有效，那是防伪造），'
      + '而是复用外壳 `receive()` 里已经校验过的**受信 `requestId`**（`qq:<bot>:group:<群>:<消息号>`）'
      + '按闭集形状 + 逐段核对（bot / 群）派生；任一不符 ⇒ `null`（失败关闭，绝不猜）。'
      + '落库口径：`inbound_message_id` 存**完整 requestId**（不是裸 message_id —— 裸号会跨群/跨机器人撞号）。'
      + '证据：控 33（账本非空 + 逐字等于该入站 requestId + 第二条入站独立计数）、'
      + '控 34（同一入站第二条 group_task_per_inbound_exhausted）、控 35（语音+附录=2 占同一条入站额度）。',
    p3hExhaustThenDefault: 'H2 的语义：**任务结束（终态 exhausted）⇒ 恢复默认路线**，'
      + '不允许的群**静默忽略**（不是"永久抑制这个群"，也不是"发一条更委婉的失败提示"）。'
      + '落地两条：① 准入层不再因为"曾有一条耗尽任务"而长期否认该群（`replyWindowTasks()` 只看 active|paused，'
      + '终态任务本来就不参与路由）；② `qq_group_not_authorized` 进 `BRIDGE_SILENT_CODES` ⇒ 桥映射成 '
      + '`no_reply` + `delivery:none`，外壳只记 `qq_no_reply`（具名理由）、**不记** `lg_turn_failed`、不发任何提示。'
      + '证据：控 36（名单外群：0 发送/0 模型/0 提示/无 lg_turn_failed）、控 37（名单内群：正常回一条，默认路线）。',
    p3hOldAssertionsUpdated: '本批按用户裁定「旧断言若与修正后的需求冲突，应同步更新」更正了两条既有断言：'
      + '· 第 15 项：原来只验"核心给了 qq_group_not_authorized"（failed 也能过）⇒ 现在加判"桥侧 no_reply + '
      + '外壳 qq_no_reply + 不记 lg_turn_failed + 0 条发送"；'
      + '· 第 21 项：原来断言第二条 `outcome=failed` ⇒ 现在 `no_reply` + `delivery=none`（判据 0 条发送 / '
      + '不再调模型 / 任务终态 exhausted 一条没放松）。其余各项**逐字未动**。',
    p3hConcurrencyBoundary: '「并发不串」的证据分两层，**都不是**"两条轮次真的同时跑"：'
      + '① 真链路（控 38）：两条 ws 帧背靠背进入，但外壳 `this.queue` 与 `TurnBridge.submit` 串联行 '
      + '⇒ 轮次仍是一条一条执行；`rememberActiveInbound` 落在**队列内**（不是入队时）正是为了让每轮引用自己那条。'
      + '② 派发层（控 39）：两份 `dispatchGroupTaskReply` 真并发，但 `reserveGroupSend` 的行锁把事务串起来 '
      + '⇒ 同时性只在"进入预留前"。'
      + '未覆盖：两条轮次在同一时刻**都进入**核心轮次处理（既有设计就是串行，ADR-091 D12）。',
    notProven: '真实 QQ 送达 / 群成员是否看到或听到 / 真实模型语义判断 / 真实 TTS /'
      + ' 生产迁移 27 / 语音轮的真实合成与播放 / 两条轮次真正同时执行（串行是既有设计）',
    p3gTwoLedgers: '额度是**三层三本账**（契约 §5 已按实测改写）：'
      + '① 准入门 `decideGroupAdmission`（任务在不在）② 路由层 `decideInboundRouting`（读 used_messages 已结算列）'
      + '③ 预留层 `reserveGroupSend`（读实例账本，行锁事务）。'
      + '⚠️ 实测：total 用尽时 `settleGroupSend → decideTaskAfterSendSettlement` 在**同一次结算**里就把任务置终态 '
      + 'exhausted ⇒ 下一次入站连路由都不参与 ⇒ 准入门 denied（qq_group_not_authorized）。'
      + '路由层的 total 分支因此在接管轮**不可达**；`group_task_total_budget_exhausted` 的真实产生点是**预留层**'
      + '（控 23 的 not_attempted、控 22 的并发败者）。'
      + '把 qq_group_not_authorized 读成"额度没生效"是误读。',
    p3gQuotaSequentialNotADefect: '契约 §5 原措辞（顺序第二条 = 路由层 suppress ⇒ no_reply + '
      + 'group_task_total_budget_exhausted）与实测冲突，判据是**准入层 vs 路由层**：'
      + '`decideTaskAfterSendSettlement` 在 used>=totalMax 时返回 markExhausted ⇒ `settleGroupSend` 写 status=exhausted、'
      + 'version+1 ⇒ `replyWindowTasks()`（只收 active|paused）不再包含它 ⇒ `decideGroupAdmission` 判 denied。'
      + '⚠️ **这不是缺陷**：验收判据"上限 1 ⇒ 最多发 1 条、第二条 0 条、且第二条不再调模型"完全成立，'
      + '而且终态更诚实（主人授权的任务确实用完了）。Lead 裁定：按实测落，**不改**任务生命周期语义。',
    p3gSlotAtRoutingIsByDesign: '路由层 slot **按 0 计**是 P3-A 记录里具名的设计口径（原文："路由层 slot 按 0 计'
      + '（窗口超额由发送前复核拦）"）：路由层不做 slot 闸，真正的 slot 闸在发送前复核 '
      + '`readSendOccupancyForRecheck`（那条读的是真实例账本）。**这不是缺陷**，不要当成额度失效的证据。',
    p3gConcurrencyBoundary: '真链路拿不到"两个轮次同时写账"：TurnBridge.submit 有串行闸、'
      + '外壳 OneBotPrivateClient.queue 也串行 ⇒ 并发证据只能在账本那一层（控 22 的两个 Promise.all 预留）。'
      + '这不是缺陷：串行是既有设计（ADR-091 D12），控 22 要证明的是 `reserveGroupSend` 的行锁"先查再写"不存在。',
    p3gInlineSend: '契约 §3.2 原措辞"用原有队列"在"核心同步等回执"的时序下**会自锁**：'
      + '派发发生在核心的轮次内部，而此刻外壳 `this.queue` 的尾巴正是**正在等核心回 TURN_RESULT 的那一轮** '
      + '⇒ 把发送挂到队列后面 = 等一条正在等我的链 ⇒ 5 秒后核心按 delivery_unknown 结算。'
      + '实测口径落地为**同一 socket 串行 + 就地发**（外壳记 `group_task_dispatch_inline`，'
      + 'reason=`in_flight_turn_awaits_receipt`）。'
      + '门侧另有独立探针 `artifacts/local/qq-group-p3g/probe-shell-dispatch-queue.ts` 复现过这条时序：'
      + '在入站轮次内部调 `deliverGroupTaskFromCore` 返回 2ms / api_accepted / 1 条发送 —— 就地发是正解。',
    p3gShellLogChannels: '外壳有两条不同的读数：`qq_group_task_dispatch_delivered`（处理器侧结算，'
      + '带 deliveredCount = **平台已确认接受**的条数）与 `qq_group_task_dispatch_settled`（receive() 的 '
      + 'groupTaskDispatch 分支，零发送、不记 lg_turn_failed）。前者只在真外壳收派发时出现，'
      + '后者只在真外壳**自己提交**的那一轮出现 —— 直连桥的 TURN_RESULT 不看这两条（看返回值）。',
    p3gShellLogNames: '事件名以实测为准，**不按前缀猜**：外壳侧 `qq_group_task_*`（send_api_accepted / '
      + 'send_failed / appendix_send_* / dispatch_delivered / dispatch_settled），'
      + '桥侧 `group_task_*`（dispatch_inline / dispatch_replayed / dispatch_quote_unavailable / '
      + 'dispatch_quote_mismatch）。门里踩过一次：按 `qq_group_task_dispatch_replayed` 找读数找不到。',
    p3gDeliveredCountOnlyConfirmed: '`deliveredCount` 只数**已确认被平台接受**的条数：'
      + '平台回 ok 但**没有 message_id** 时外壳抛 `qq_delivery_unconfirmed` ⇒ deliveredCount=0，'
      + '整体结局 `delivery_unknown`（控 26 就是这个读数）。这与"api_accepted ≠ 群成员看到"是同一条纪律：'
      + '没拿到回执 id 就不许说"确定发出去了"。',
    p3gVoiceBoundary: '真 main 里没有让模型选语音的装配（本门不开 qq-voice-reply）⇒ 语音+附录的**计数**'
      + '用 in-process `dispatchGroupTaskReply` + 真外壳发送来测；"她真的选了语音"不在本门读数里。'
      + '⚠️ P3-H 控 35 用同一条 in-process 路径验"语音+附录=2 占同一条入站额度"。',
    notes: boundaryNotes,
    hostTails,
  },
  ranAt: new Date().toISOString(),
  node: process.version,
  evidenceRoot,
}
mkdirSync(evidenceRoot, { recursive: true })
writeFileSync(resolve(evidenceRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')

console.log('')
console.log('边界（必须与读数一起读）：')
for (const note of boundaryNotes) console.log(`  · ${note}`)
console.log('  · 05–08 的编排在**门进程内**（P2.1 只有一条派发入口，主链无法"建单后再撤销再发"）；'
  + '真 main 只覆盖 01/02/03/04/09/10。')
console.log('  · 群目录 `ambiguous` 分支在主链**不可达**（create 草稿的 groupId 必填）；'
  + '同名消歧是**模型**判的（门里是假模型）。')
console.log('  · `api_accepted` ≠ 群成员看到/听到；本门只读到假 OneBot 接受了那一段。')
console.log('')
if (failures.length === 0) {
  console.log(`PASS: QQ 群任务组合验收（P2.1-D，${String(passed)}/${String(total)} 项）\n${evidenceRoot}`)
} else {
  console.log(`FAIL: QQ 群任务组合验收（P2.1-D，${String(passed)}/${String(total)} 项通过）`)
  console.log(`未通过：\n${failures.map((name) => `  · ${name}`).join('\n')}`)
  console.log(evidenceRoot)
  process.exitCode = 1
}

await pool.end().catch(() => undefined)
for (const socket of ws.clients) socket.terminate()
await new Promise<void>((done) => ws.close(() => done()))
model.closeAllConnections()
await new Promise<void>((done) => model.close(() => done()))
