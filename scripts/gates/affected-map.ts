/**
 * 影响面映射 —— `AGENTS.md` §5「改哪里 → 跑哪些门」那张**人读表**的机器版。
 *
 * ============================================================================
 *  它与 §5 的关系（重要）
 * ============================================================================
 *  §5 仍然是**权威源**（它写在给机器看的仓库约定里）。本文件是它的**投影**：
 *  规则一行一行对应 §5 的表格行。两边不一致时以 §5 为准，并回来改这里。
 *
 *  为什么还需要一份机器版：§5 的回答是"我该跑哪几道门"，而人（和代理）经常
 *  跳过这一步直接跑 `m4.5:ci`（12 分钟）—— 于是"最小纪律"在实践中失效。
 *  `pnpm fast` 把这一步变成默认动作。
 *
 * ---------------------------------------------------------------------------
 *  失败关闭的两条
 * ---------------------------------------------------------------------------
 *  ① **未匹配到任何规则**的改动：不猜。把 lane 升级为整条 `offline`，
 *     并在报告里列出 `unmatchedPaths`（除非显式 `--allow-partial`）。
 *  ② 规则里引用的门若既不在清单里、也无法从 `package.json` 安全合成 ⇒ **报错退出**，
 *     不是"跳过顺便绿一下"。
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { GateSpec } from './types.ts'

/** §5 的一行：匹配这些路径 ⇒ 跑这些门。 */
export interface AffectedRule {
  /** §5 表里那一行的"你改了什么"。 */
  what: string
  match: readonly string[]
  gates: readonly string[]
  /** 改了它就该把整条 lane 升级为离线全量（影响面无法切分的东西）。 */
  global?: boolean
}

/** glob 只支持两种最常用的形式：`**` 任意层级、`*` 单层内任意字符。 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${escaped}$`)
}

export const AFFECTED_RULES: readonly AffectedRule[] = [
  {
    what: 'QQ reply media, synthesis, delivery and bridge metadata',
    match: ['src/kernel/contracts/qq-media-reply.ts', 'src/kernel/context/qq-media-reply-section.ts',
      'src/infrastructure/qq/**', 'src/infrastructure/bridge/turn-bridge-transport.ts',
      'src/kernel/app/bridge/turn-bridge.ts', 'scripts/qq/chat.ts', 'scripts/postlv2-qq-voice-*.ts'],
    gates: ['postlv2:qq-voice-reply:verify', 'postlv2:qq-voice-delivery:verify',
      'postlv2:qq-voice-main:verify', 'qq:reconnect:verify', 'postlv2:transport:verify'],
  },
  {
    what: 'U1 完成接线与 G1 QQ 成员/房间入口',
    match: ['src/infrastructure/persistence/read-scope.ts', 'src/infrastructure/qq/**',
      'src/infrastructure/runtime/impression-query.ts', 'scripts/u1-completion-verify.ts', 'scripts/qq/group-verify.ts'],
    gates: ['u1:completion:verify', 'qq:group:verify', 'qq:group:coexist:verify'],
  },
  {
    what: '任意 `.ts`',
    match: ['**/*.ts'],
    gates: ['typecheck'],
  },
  {
    what: 'EBL 生命周期、来源与执行接线',
    match: ['src/kernel/contracts/epistemic-belief.ts', 'src/kernel/app/epistemic-belief-lifecycle/**',
      'src/infrastructure/persistence/epistemic-belief-*.ts', 'src/infrastructure/runtime/epistemic-*.ts',
      'src/infrastructure/runtime/adapters.ts', 'src/infrastructure/runtime/belief-scheduler.ts',
      'src/infrastructure/runtime/post-turn-model-memory.ts', 'src/infrastructure/model/langmem-memory-extractor.ts',
      'src/kernel/contracts/belief-renderer.ts', 'src/kernel/app/turn-gateway.ts',
      'scripts/epistemic-belief-*.ts', 'evals/epistemic-belief-lifecycle/**',
      'src/kernel/action/task-loop.ts', 'src/kernel/action/action-turn.ts', 'src/kernel/app/flags.ts', 'src/main.ts'],
    gates: ['ebl:verify', 'ebl:postgres:verify', 'ebl:human:verify'],
  },
  {
    what: '`src/kernel/contracts/**`、`src/kernel/policies/validator.ts`、`src/kernel/projections/**`',
    match: ['src/kernel/contracts/**', 'src/kernel/policies/validator.ts', 'src/kernel/projections/**'],
    gates: ['kernel:test', 'kernel:verify'],
  },
  {
    what: '`src/kernel/contracts/scope.ts`（U1 作用域契约：矩阵/可见性/门槛）或它自己的门',
    match: ['src/kernel/contracts/scope.ts', 'scripts/u1-scope-contract-verify.ts'],
    gates: ['u1:scope:verify'],
  },
  {
    what: '`src/kernel/contracts/record-visibility.ts`（U1 读取判定核心）或它自己的门',
    match: ['src/kernel/contracts/record-visibility.ts', 'scripts/u1-record-visibility-verify.ts'],
    gates: ['u1:record-visibility:verify', 'u1:scope:verify'],
  },
  {
    what: '`src/kernel/identity/inbound-identity.ts`（U1 逐消息身份解析）或它自己的门',
    match: ['src/kernel/identity/inbound-identity.ts', 'scripts/u1-inbound-identity-verify.ts'],
    gates: ['u1:identity:verify'],
  },
  {
    what: '`src/infrastructure/runtime/inbound-identity-resolver.ts`（U1 身份解析读写链）或它自己的门',
    match: ['src/infrastructure/runtime/inbound-identity-resolver.ts', 'scripts/u1-identity-store-verify.ts'],
    gates: ['u1:identity-store:verify'],
  },
  {
    what: '`src/infrastructure/runtime/conversation-recorder.ts`（U1 录制器逐消息身份）或它自己的门',
    match: ['src/infrastructure/runtime/conversation-recorder.ts', 'scripts/u1-recorder-identity-verify.ts'],
    gates: ['u1:recorder-identity:verify'],
  },
  {
    what: '`src/infrastructure/runtime/adapters.ts`（关系 ORIGIN 播种器）或它自己的门',
    match: ['src/infrastructure/runtime/adapters.ts', 'scripts/u1-new-user-relationship-verify.ts'],
    gates: ['u1:new-user-relationship:verify'],
  },
  {
    what: '`src/infrastructure/persistence/record-scope-store.ts`（U1 记录作用域标签）或它自己的门',
    match: ['src/infrastructure/persistence/record-scope-store.ts', 'scripts/u1-record-scope-verify.ts'],
    gates: ['u1:record-scope:verify'],
  },
  {
    what: '`src/infrastructure/persistence/record-scope-store.ts` 的授权前置过滤（G18 / ADR-138）或它自己的门',
    match: ['scripts/u1-authorized-candidates-verify.ts'],
    gates: ['u1:authorized-candidates:verify'],
  },
  {
    what: '`scripts/u1-g18-wiring-verify.ts`（G18 接线的门本身）',
    match: ['scripts/u1-g18-wiring-verify.ts'],
    gates: ['u1:g18-wiring:verify'],
  },
  {
    what: '`src/infrastructure/runtime/scope-labeling.ts`（写侧打标）或它自己的门',
    match: ['src/infrastructure/runtime/scope-labeling.ts', 'scripts/u1-write-path-labeling-verify.ts'],
    gates: ['u1:write-path-labeling:verify', 'u1:record-scope:verify'],
  },
  {
    what: '`src/main.ts`（生产装配根：入口作用域与召回授权器的接线点）或它自己的门',
    match: ['scripts/u1-main-wiring-verify.ts'],
    gates: ['u1:main-wiring:verify'],
  },
  {
    what: '`src/infrastructure/runtime/inbound-turn-scope.ts`（入站 ⇒ 本轮作用域）或它自己的门',
    match: ['src/infrastructure/runtime/inbound-turn-scope.ts', 'scripts/u1-inbound-turn-scope-verify.ts'],
    gates: ['u1:inbound-turn-scope:verify', 'u1:entry-scope:verify'],
  },
  {
    what: '`src/kernel/app/turn-gateway.ts` 的作用域注入点或它自己的门',
    match: ['scripts/u1-gateway-scope-verify.ts'],
    gates: ['u1:gateway-scope:verify'],
  },
  {
    what: '`src/kernel/identity/entry-scope.ts`（入口 ⇒ 作用域）或它自己的门',
    match: ['src/kernel/identity/entry-scope.ts', 'scripts/u1-entry-scope-verify.ts'],
    gates: ['u1:entry-scope:verify'],
  },
  {
    what: '`src/infrastructure/admin/**`（A1 管理后台）、`admin-ports/**`（端口）、`admin-readers/**`（真数据源 reader）、`evals/a1/**`（只读面冻结清单）或它自己的门',
    match: ['src/infrastructure/admin/**', 'src/infrastructure/admin-ports/**', 'src/infrastructure/admin-readers/**', 'evals/a1/**', 'scripts/a1-auth-primitives-verify.ts', 'scripts/a1-auth-http-verify.ts', 'scripts/a1-admin-entry-verify.ts', 'scripts/a1-query-surface-verify.ts', 'scripts/a1-effective-config-verify.ts', 'scripts/a1-serve-verify.ts', 'scripts/a1-safety-quota-verify.ts', 'scripts/a1-jobs-verify.ts', 'scripts/a1-goals-commitments-verify.ts', 'scripts/a1-page-verify.ts', 'scripts/a1-cognition-verify.ts', 'scripts/a1-gates-verify.ts', 'scripts/a1-goals-reader-verify.ts', 'scripts/a1-safety-quota-reader-verify.ts', 'scripts/a1-cognition-reader-verify.ts', 'scripts/a1-audit-verify.ts', 'scripts/a1-core-stop-verify.ts', 'scripts/a1-jobs-admit-verify.ts', 'scripts/a1-jobs-store-verify.ts', 'scripts/a1-admin.ts'],
    gates: ['a1:auth:verify', 'a1:auth:http:verify', 'a1:admin:entry:verify', 'a1:query:verify', 'a1:effective-config:verify', 'a1:serve:verify', 'a1:safety-quota:verify', 'a1:jobs:verify', 'a1:goals-commitments:verify', 'a1:page:verify', 'a1:cognition:verify', 'a1:gates:verify', 'a1:goals-reader:verify', 'a1:safety-quota-reader:verify', 'a1:cognition-reader:verify', 'a1:audit:verify', 'a1:core-stop:verify', 'a1:jobs-admit:verify', 'a1:jobs-store:verify'],
  },
  {
    what: '`src/kernel/app/bridge/turn-bridge.ts`（受控登记表 / 桥协议）或它自己的门',
    match: ['src/kernel/app/bridge/turn-bridge.ts', 'scripts/u1-bridge-platform-facts-verify.ts'],
    gates: ['u1:bridge-facts:verify', 'postlv2:transport:verify', 'kernel:test'],
  },
  {
    what: '`src/kernel/recall/ports.ts` 或召回检索实现（`memory-retrieval-store.ts`）',
    match: ['src/kernel/recall/**', 'src/infrastructure/persistence/memory-retrieval-store.ts'],
    gates: ['u1:g18-wiring:verify', 'kernel:test', 'kernel:verify'],
  },
  {
    what: '`evals/s1/**`（S1 拒绝套件）或它自己的门',
    match: ['evals/s1/**', 'scripts/s1-rejection-suite-verify.ts', 'scripts/s1-rejection-evidence-verify.ts'],
    gates: ['s1:rejection-suite:verify', 's1:rejection-evidence:verify', 's1:e1:verify'],
  },
  {
    what: '`scripts/s1-isolation-stub-verify.ts`（S1 隔离桩 E-2）或它复用的 `action-harness.ts`',
    match: ['scripts/s1-isolation-stub-verify.ts', 'scripts/action-harness.ts'],
    gates: ['s1:isolation-stub:verify'],
  },
  {
    what: '`scripts/s1-e1-program-cases.ts`（S1 / E-1 离线程序面读数）或它判定的作用域契约',
    match: ['scripts/s1-e1-program-cases.ts', 'src/kernel/contracts/scope.ts'],
    gates: ['s1:e1:verify', 'u1:scope:verify'],
  },
  {
    what: '`src/kernel/context/sections.ts`、`src/kernel/app/turn-gateway.ts`（prompt 相关）',
    match: ['src/kernel/context/sections.ts', 'src/kernel/app/turn-gateway.ts', 'src/kernel/context/**'],
    gates: ['m3.5:test', 'eval:scenarios', 'eval:dryrun', 'eval:providers'],
  },
  {
    what: '`src/kernel/identity/seed.ts`、`src/character/**`',
    match: ['src/kernel/identity/**', 'src/character/**'],
    gates: ['kernel:test:identity', 'm3:seed-check'],
  },
  {
    what: '`src/infrastructure/persistence/migrations.ts`',
    match: ['src/infrastructure/persistence/migrations.ts'],
    gates: ['m3:verify', 'm3.5:verify', 'm3:migrate-gate', 'm4:verify', 'm4:test'],
    global: true,
  },
  {
    what: '`src/infrastructure/persistence/trace-store.ts`、`src/kernel/contracts/trace.ts`',
    match: ['src/infrastructure/persistence/trace-store.ts', 'src/kernel/contracts/trace.ts'],
    gates: ['m3:verify', 'm3.5:verify', 'eval:telemetry', 'eval:otlp'],
  },
  {
    what: '`src/kernel/app/memory/**`、`memory-store.ts`、`memory-validator.ts`',
    match: ['src/kernel/app/memory/**', 'src/infrastructure/persistence/memory-store.ts', 'src/kernel/policies/memory-validator.ts'],
    gates: ['m4:test', 'm4:verify', 'm4:mutation-safety:verify', 'm4:nl-mutation:verify', 'eval:m4', 'memory-coverage:verify', 'extractor:value-boundary:verify'],
    global: true,
  },
  {
    what: '「记忆体量」线的语料（`evals/memory-coverage/**`）',
    match: ['evals/memory-coverage/**'],
    gates: ['memory-coverage:verify'],
  },
  {
    what: '`src/kernel/action/**`、`src/infrastructure/action/**`',
    match: ['src/kernel/action/**', 'src/infrastructure/action/**'],
    gates: ['m4.5:test', 'm4.5:verify', 'm4.5:measurement:verify', 'm4.5:nl-action:verify',
      /* ⚠️ 2026-10-05（`AUD-20261005-03`）：角色工具决策面就在这一组路径里（目录 / 规划器 / 限定路径） */
      'postlv2:role-tool:verify', 'postlv2:role-tool:path'],
  },
  {
    /*
     * 三域应用方案（2026-10-19 / 2026-10-20）的**行动预测**那一支。
     *
     * ⚠️ 为什么必须单独登记（可复核）：`src/kernel/action/**` 那条规则**不含**
     *    `src/kernel/contracts/world-model.ts`、不含 `src/infrastructure/model/openai-action-forecast.ts`，
     *    也不含 `src/main.ts` 与 `src/kernel/app/flags.ts` ——
     *    也就是说"改了预测契约 / 改了开关接线"当时是**结构上可能**的一道门都不红
     *    （同型先例：QQ 主动联系、浏览器全工具档，已各修过一次）。
     */
    what: '世界模型三处应用：共用最小契约 / 行动预测（工具与任务执行域）',
    match: [
      'src/kernel/contracts/world-model.ts',
      'src/kernel/action/action-forecast.ts',
      'src/kernel/action/task-loop.ts',
      'src/kernel/action/action-turn.ts',
      'src/infrastructure/model/openai-action-forecast.ts',
      'scripts/world-model-action-forecast-verify.ts',
    ],
    gates: ['worldmodel:forecast:verify'],
  },
  {
    /*
     * 三域应用方案的**反思域**（比较材料）那一支。
     *
     * ⚠️ 同样必须单独登记：`src/kernel/app/reflection/**` 与
     *    `src/infrastructure/persistence/reflection-*.ts` 此前**不在**任何
     *    affected 规则里 ⇒ 改了比较材料**一道门都不红**是结构上可能的。
     */
    what: '世界模型三处应用：反思域比较材料（辅助解释，不是证据）',
    match: [
      'src/kernel/app/reflection/outcome-comparison.ts',
      'src/kernel/app/reflection/draft-port.ts',
      'src/infrastructure/runtime/reflection-runner.ts',
      'src/infrastructure/runtime/reflection-runtime.ts',
      'src/infrastructure/persistence/reflection-comparison-source.ts',
      'scripts/world-model-reflection-comparison-verify.ts',
    ],
    gates: ['worldmodel:reflection:verify'],
  },
  {
    /*
     * 反思域的**隔离整链**（需要库）。
     *
     * ⚠️ **不进快车道**：它要创建隔离 PostgreSQL 容器并运行迁移，
     *    而且是"整链"而不是"受影响的那一格" ⇒ `pnpm fast` 跑它会拖慢每次改动。
     *    ⇒ 只登记门名（`pnpm worldmodel:reflection:e2e` 手动/收口时跑）。
     */
    what: '世界模型三处应用：反思域隔离整链（不做快车道，收口时手动跑）',
    match: ['scripts/world-model-reflection-e2e-verify.ts', 'scripts/postgresql/test-harness.ts'],
    gates: [],
  },
  {
    /*
     * 聚合门：只读已落盘证据 ⇒ 便宜、可进快车道。
     * ⚠️ 它**只在证据已经存在时**有意义；没跑过就是 `NOT RUN`（如实）。
     */
    what: '世界模型三处应用：只读聚合门（按域分列，不合成总分）',
    match: ['scripts/world-model-gates.ts'],
    gates: ['worldmodel:gates'],
  },
  {
    what: '`src/kernel/recall/**`、`memory-retrieval-store.ts`',
    match: ['src/kernel/recall/**', 'src/infrastructure/persistence/memory-retrieval-store.ts'],
    gates: ['m5:test', 'm5:verify', 'm5:e2e:verify'],
  },
  {
    /*
     * ⚠️ 2026-10-06（WP6 的"整链回归"）：**补一道本来就该有的规则**。
     *
     * 此前这一批的路径**一条都没在 affected 映射里** ⇒ `pnpm fast` 不会跑这一批的门，
     * 于是"改了主动联系却什么都没红"是**结构上可能**的。这正是 WP6 要找的洞。
     *
     * ⚠️ 只带**离线**门：真模型档（`postlv2:qq-proactive:live`）按既有契约定不自动跑
     * （它真的出站、要 `DSH_TEST_MODEL_WRAPPER=1` + 测试凭证）；
     * 整链门（`:chain`）会**起一个真核心**，比这一组里其它门重得多，也不进快车道。
     */
    what: 'QQ 主动联系（ADR-110 / ADR-111）：通知契约 / 持久层 / 调度 / 投递 / 依据面',
    match: [
      'src/kernel/contracts/notification*.ts',
      'src/kernel/contracts/proactive-*.ts',
      'src/kernel/app/proactive-*.ts',
      'src/kernel/app/notification-delivery.ts',
      'src/infrastructure/persistence/notification-store.ts',
      'src/infrastructure/time/**',
      'src/infrastructure/action/adapters/qq-proactive-delivery.ts',
      'src/infrastructure/model/openai-proactive-care.ts',
      'src/infrastructure/runtime/proactive-sources.ts',
      'src/kernel/context/sections.ts',
      'scripts/postlv2-qq-proactive-verify.ts',
      /* ⚠️ 2026-10-07（本次审计 §12）：提醒上下文与 QQ 重连的判据脚本此前也不在映射里 */
      'scripts/reminder-context-*.ts',
      'scripts/qq/reconnect-verify.ts',
      /*
       * ⚠️ `src/main.ts` **必须**在里面：整条关心的焊接（够格 ⇒ 依据面 ⇒ 调模型 ⇒ 落库 ⇒ 投递）
       *    就写在那个文件里。少了它，"改了焊接而这一批的门不跑"照样成立。
       */
      'src/main.ts',
    ],
    gates: ['kernel:test', 'postlv2:qq-proactive:verify', 'postlv2:qq-proactive:measurement:verify', 'qq:reconnect:verify'],
  },
  {
    what: '入口渠道事实与三渠道提醒',
    match: ['src/kernel/contracts/chat-channel.ts', 'src/kernel/context/chat-channel-section.ts',
      'src/kernel/app/reminder-turn.ts', 'src/kernel/app/bridge/**', 'src/kernel/app/reply-guard-chain.ts',
      'src/kernel/action/local-reminder-capability.ts', 'src/kernel/contracts/attribution.ts',
      'src/infrastructure/persistence/notification-store.ts', 'src/infrastructure/persistence/migrations.ts',
      'src/infrastructure/runtime/reminder-scheduling.ts', 'src/infrastructure/action/adapters/local-reminder-delivery.ts',
      'src/main.ts', 'scripts/coexist/**', 'scripts/postlv2_reminder_client.js', 'scripts/postlv2_vtuber_runtime.py',
      'scripts/postlv2-expression-frontend.py', 'scripts/reminder-channels-*'],
    gates: ['reminder:channels:verify'],
  },
  {
    what: 'M5.1 开发者平面：`src/infrastructure/dev/**`、`src/kernel/contracts/developer-*.ts`',
    match: ['src/infrastructure/dev/**', 'src/kernel/contracts/developer-*.ts'],
    gates: ['m5.1:test', 'm5.1:query:verify', 'm5.1:control:verify', 'm5.1:page:verify'],
  },
  {
    what: '可观测性：`src/kernel/contracts/observability.ts`、`src/infrastructure/telemetry/**`',
    match: ['src/kernel/contracts/observability.ts', 'src/infrastructure/telemetry/**'],
    gates: ['m5.1:observability:verify'],
  },
  {
    what: '开关：`src/kernel/app/flags.ts`',
    match: ['src/kernel/app/flags.ts'],
    gates: ['m4:test', 'm4.5:test'],
  },
  {
    what: 'CLI / 入口：`src/main.ts`、`src/invocation.ts`、`*admin.ts`',
    match: ['src/main.ts', 'src/invocation.ts', 'src/**/*admin.ts'],
    gates: ['m4:test', 'm4.5:test',
      /* ADR-131：开口端口的**端口本体**就内联在 `src/main.ts` 里（装配根） */
      'postlv2:avatar-opening:verify',
      /*
       * ⚠️ 2026-10-05（`AUD-20261005-03`）：`src/main.ts` 正是 `R-54` 取消/失败之后的
       * **会话序号权威源**（其修法就在这个文件里）⇒ 本该带出它的专属控制。
       * 代价面已核过并接受：这道门要启动 **7 次** `src/main.ts`（隔离库 + loopback 假模型，零真实出站），
       * 且它的证据目录名**固定** ⇒ 重跑覆盖同一份文件（见该门 `why` 与 `AGENTS §7` 的还原纪律）。
       */
      'postlv2:sequence-continuity:verify'],
  },
  {
    what: '真实库相关脚本与生产状态机',
    match: [
      'src/infrastructure/persistence/production-*.ts',
      'src/infrastructure/persistence/runtime-shutdown.ts',
      'scripts/snapshot-db.ts',
      'scripts/restore-db.ts',
      'scripts/snapshot-state.ts',
      'scripts/verify-m4-real-db.ts',
    ],
    gates: ['inc-01:test', 'inc-01:verify', 'inc-01:measurement:verify'],
    global: true,
  },
  {
    what: '用户可见文档（权威源）',
    match: ['docs/苏沐薇-使用说明.txt'],
    gates: ['doc:check'],
  },
  {
    what: '**本加速器自己的实现**（清单 / 调度 / 缓存 / 映射）',
    match: ['scripts/gates/**', 'scripts/gates-run.ts', 'scripts/verify-gate-runner.ts'],
    gates: ['gates:verify'],
  },
  {
    what: '**M6.1 本阶段自己的东西**（判据 / 语料 / 门 / 自证）',
    match: ['scripts/m6.1-*', 'scripts/kernel-tests-m6.1.ts', 'evals/m6.1/**'],
    /*
     * ⚠️ 只登记到"按改动面推导"，**刻意不登记进 SUMMARY_GATES**。
     *
     * `m6.1:gates` 与其它汇总门有一处判据差异：它**必须**显式给 `--manifest`
     * （TD-04② 的修法：不接受"按最新 PASS 挑证据"）。而 lane 的 argv 是固定的、
     * 无法逐门传参 ⇒ 把它放进 `summaries` lane 只会跑出一个"用法错误"，
     * 再配一个 `acceptExitCodes: [2]` 就变成"什么都没做却算通过"——
     * 那比不登记更坏。所以汇总由人/文档显式调用（见 docs/m6.1/WP1-Handoff.md）。
     */
    gates: ['m6.1:test', 'm6.1:wp1:verify'],
  },
  {
    what: '**搜索层**：provider / 适配器 / 触发与回复判据（`AGENTS.md` §5 的"搜索层"行）',
    match: [
      'src/infrastructure/search/**',
      'src/infrastructure/action/adapters/web-search.ts',
      'src/kernel/action/external-evidence-*.ts',
      'src/kernel/action/search-port.ts',
      'scripts/verify-td10-search-reliability.ts',
      'scripts/verify-td12-privacy-boundary.ts',
    ],
    /*
     * ⚠️ 这一行**刻意只带这两道门**，三条理由（都是可复核的事实，不是偏好）：
     *
     *   ① 在 TD-10/TD-12 之前，改搜索层**只**会命中上面的 `**\/*.ts` ⇒ 只跑 `typecheck`，
     *      而这层真正会坏的地方（出站形状 / 降级 / 误触发 / 上下文泄漏）恰恰不是类型问题。
     *   ② `m5.5:measurement:verify` **当前是 FAIL**（它的冻结基线 `artifacts/m5.5/baseline.json`
     *      在后续里程碑改写 `artifacts/m5`/`m5.1` 之后过期，见 `Tech-Debt-Register.md` 的 TD-10）。
     *      把它接进快车道 = 每次动搜索层都红在一个**与本次改动无关**的旧因上 ⇒
     *      等于训练人忽略这条 lane。所以它**在修好基线之前不进快车道**。
     *   ③ `m5.5:smoke:live` / `m5.5.1:semantics:live` 需要真实模型 ⇒ **不得**进快车道；
     *      其余 `m5.5:*` / `m5.5.1:*` 是里程碑自己的套件，"要不要进快车道"是**策略决定**，
     *      不在 TD-10/TD-12 第一阶段单方面改。
     */
    gates: ['td10:reliability', 'td12:privacy'],
  },
  {
    what: '**M9 信念域**：评估器/校验器/合同/投影/调度/上下文装配（M9 计划 §16.2 的机器版）',
    match: [
      'src/kernel/app/belief/**',
      'src/kernel/policies/belief-validator.ts',
      'src/kernel/contracts/belief*.ts',
      'src/kernel/contracts/belief-renderer.ts',
      'src/infrastructure/persistence/belief-store.ts',
      'src/infrastructure/runtime/belief-scheduler.ts',
    ],
    /*
     * ⚠️ 与搜索层行同一条纪律：只带 M9 自己的离线门，不带 live 门（真模型，
     * WP9 收口时独立裁定）。信念域的坏点（资格/失效传播/调度水位/同根去重/
     * 修订因果链）不是类型问题 ⇒ 值得按改动面自动带出这组门。
     * `m9:long:verify`（B32）按 M9-M95-Overlap-Audit.md CANCELLED——不存在、
     * 永不引用（affected-map 引用不存在的门会失败关闭报错，这是设计）。
     */
    gates: [
      'm9:test',
      'm9:verify',
      'm9:invalidation:verify',
      'm9:runtime:verify',
      'm9:context:verify',
      'm9:e2e:verify',
      'm9:scale:verify',
    ],
  },
  {
    what: '**M10 目标 / 承诺域**：引用契约、只读输入端口、输入适配器（WP2 起；WP3 补 m10:test）',
    match: [
      'src/kernel/contracts/goal-reference.ts',
      'src/kernel/contracts/goal-proposal.ts',
      'src/kernel/contracts/goal.ts',
      'src/kernel/app/goal/**',
      'src/kernel/context/goal-sections.ts',
      'src/kernel/policies/goal-validator.ts',
      'src/kernel/projections/goal.ts',
      'src/infrastructure/persistence/goal-store.ts',
      'src/infrastructure/persistence/goal-input-store.ts',
      'evals/m10/**',
      'scripts/m10-*',
      /* ⚠️ 2026-10-07（本次审计 §12）：目标**结清**（ADR-116）的判据脚本走 `tsx` 直调、没有独立 npm 门
         ⇒ 按**域**归到这一行（M10 的离线门已经覆盖目标/承诺的引用、资格、失效与重放）。 */
      'scripts/goal-settlement-*.ts',
    ],
    /*
     * ⚠️ 与 M9 信念域行同一条纪律：只带 M10 自己的**离线**门，不带 live 门
     * （真模型档按契约 §5 独立裁定）。目标域的坏点（引用版本 / 资格 /
     * 失效传播 / 唯一放行口 / 重放一致 / 计数守恒）不是类型问题 ⇒ 值得按改动面自动带出。
     *
     * `m10:test` 于 WP3 落地，**同一步**追加进来（`m10:inputs:verify` 在 WP2 时已在；
     * 当时不写 `m10:test` 是因为受影响映射对缺门是**失败关闭** —— 见 `resolveSpec`
     * 与登记册 `U-08`）。
     */
    gates: [
      'm10:test',
      'm10:inputs:verify',
      'm10:source:verify',
      'm10:invalidation:verify',
      'm10:completion:verify',
      'm10:context:verify',
      'm10:observability:verify',
      'm10:measurement:verify',
      'm10:e2e:verify',
      'm10:scale:verify',
      'm10:long:verify',
      'm10:preflight',
      'm10:gateway:verify',
      'm10:oracle:verify',
      'm10:semantic:dry',
      'm10:review:materials',
      'm10:m11:verify',
      'm10:docs:verify',
      'm10:evidence:verify',
      'm10:realdb:invariant',
      'm10:coverage:verify',
      'm10:activation:verify',
      'm10:gates',
      'm10:regression:verify',
      /*
       * ⚠️ 2026-10-05（`AUD-20261005-03`）：目标域的**post-Lv2 控制**也接进来 ——
       * 它们测的正是这一组路径（目标理解期限 / prepare 与 recall 的并行与幂等）。
       * 两条都**离线**（provider 注入替身、`network:"MOCKED"`）。
       */
      'postlv2:goal-deadline:verify',
      'postlv2:goal-parallel:verify',
    ],
  },
  // 影响面**无法切分**的东西：改了它们就必须整条离线链重跑。
  { what: 'M11.1 reflection wiring and measurement controls',
    match: ['src/kernel/app/reflection/**', 'src/kernel/contracts/reflection*.ts',
      'src/infrastructure/runtime/reflection*.ts', 'src/infrastructure/persistence/reflection*.ts',
      'src/infrastructure/model/openai-reflection.ts', 'scripts/m11.1-*.ts'],
    gates: ['m11.1:wiring:verify', 'm11.1:recovery:verify', 'm11.1:e2e:verify', 'm11.1:measurement:verify',
      'm11.1:batch:verify', 'm11.1:behavior:control', 'm11.1:gates:verify', 'm11.1:privacy-performance:verify', 'm11.1:source:verify'] },
  /*
   * 2026-10-04（A-3）：post-Lv2 的 S8 故事线与 Lv2 的语料/验收面此前**没有任何规则**
   * ⇒ 改了它们 `pnpm fast` 什么都不会带（走 `unmatchedPaths` 才升级到整条离线链）。
   * 只带**离线**门：真模型档（`postlv2:s8:semantic:eval` / `lv2:short:live`）与
   * 真库档（`postlv2:s8:activation-readback:db`）按各自契约独立裁定，不自动跑。
   */
  { what: 'post-Lv2 / S8 故事线（story-cognition 装配、故事账本与消费者、内容包）',
    match: ['src/infrastructure/runtime/story-cognition.ts', 'src/infrastructure/runtime/story-*.ts',
      'src/kernel/app/storyline/**', 'src/kernel/storyline/**', 'src/kernel/contracts/storyline*.ts', 'src/kernel/contracts/story-*.ts',
      'src/content/storyline/**', 'scripts/postlv2-s8-*.ts'],
    /* ⚠️ 2026-10-05：`postlv2:s8:start:verify`（`L-S8-30` 入口侧 `story:start`）与
       `postlv2:s8:choice:verify`（`ADR-107` `R-1b`：候选 `choiceId` 的产出面）测的正是这一组路径
       （`story-start-command` / `run-lifecycle` / `admin` / `choice-*` / `story-choice-draft`）⇒ 必须带出。 */
    gates: ['postlv2:s8:store:verify', 'postlv2:s8:contracts:verify', 'postlv2:s8:roots:verify',
      'postlv2:s8:state:verify', 'postlv2:s8:reflection:verify', 'postlv2:s8:lifecycle:verify',
      'postlv2:s8:measurement:verify', 'postlv2:s8:production:verify', 'postlv2:s8:withdraw:verify',
      'postlv2:s8:start:verify', 'postlv2:s8:choice:verify', 'postlv2:s8:entry-lock:verify', 'postlv2:s8:daily:verify', 'postlv2:s8:daily:e2e',
      'postlv2:s8:gates'] },
  /*
   * ⚠️ 2026-10-07（本次审计 §12）：**两条线此前一条规则都没有**。
   *
   * 下面这两条补的是**推导集合本身**（不是"多带几道门"）：
   *   · 共存线：改了 `entry-scope` / `turn-scheduler` / `scripts/coexist/**` 时
   *     `postlv2:coexist:verify` 等必须跑（此前只会因未匹配路径升级 ⇒ 它们一道不跑）。
   *   · 语音/皮套线：`src/kernel/app/bridge/**` 与 `scripts/postlv2_*.py` 是**整条**
   *     桥 / 流式表达 / 交付契约的实现面，此前同样没有任何规则。
   *   · 自动记忆线：ADR-117/118 的消费者与抽取器不在 `src/kernel/app/memory/**` 里
   *     ⇒ 老的记忆规则**罩不到它**。
   *
   * ⚠️ 只带**离线**门：真模型档（`:live`）与"真的起一个核心"的门（`:chain` / `:shells`）
   *    按既有契约不自动进快车道（见本文件 §"QQ 主动联系"那条的同一段理由）。
   */
  {
    what: '双入口共存（ADR-109）：入口维度会话 / 公平轮转 / 状态端点',
    match: [
      'src/infrastructure/runtime/entry-scope.ts',
      'src/kernel/app/bridge/turn-scheduler.ts',
      'scripts/coexist/**',
      'scripts/postlv2-coexist-*.ts',
      'scripts/postlv2-status-verify.py',
    ],
    gates: ['postlv2:coexist:verify', 'postlv2:bridge:verify', 'postlv2:transport:verify', 'postlv2:delivery:verify'],
  },
  {
    what: '语音与皮套线（ADR-102 按句流式 / 表达接入 / 桥与交付契约）',
    match: [
      'src/kernel/app/bridge/**',
      'src/kernel/contracts/expressive-speech.ts',
      'src/kernel/contracts/media-delivery.ts',
      'src/kernel/context/expressive-speech-section.ts',
      'src/infrastructure/bridge/**',
      'scripts/postlv2_*.py',
      'scripts/postlv2-*.py',
      'scripts/postlv2-expression-*.ts',
      'scripts/postlv2-text-stream-verify.py',
    ],
    gates: ['postlv2:bridge:verify', 'postlv2:transport:verify', 'postlv2:expression:verify', 'postlv2:body:verify', 'postlv2:delivery:verify',
      // ADR-131：开口的**预检/生成/编排/状态**四段与接线都在这一片里
      // （`src/kernel/app/bridge/**` + `scripts/postlv2_vtuber_runtime.py` 已被上面的 match 命中）
      'postlv2:avatar-opening:verify'],
  },
  {
    what: '自动记忆（ADR-117 / ADR-118）：LangMem 抽取器与消费者',
    match: [
      'src/infrastructure/runtime/automatic-memory.ts',
      'src/infrastructure/model/langmem-memory-extractor.ts',
      'scripts/automatic_memory_langmem.py',
      'scripts/postlv2-automatic-memory-verify.ts',
    ],
    gates: ['m4:test', 'm4:verify', 'postlv2:automatic-memory:verify', 'memory-coverage:verify', 'extractor:value-boundary:verify'],
  },
  { what: 'Lv2 综合验收面（语料、核心/修复/量具/隐私预算、回归读回）',
    match: ['evals/lv2/**', 'scripts/lv2-*.ts'],
    gates: ['lv2:core:verify', 'lv2:repair:verify', 'lv2:measurement:verify',
      'lv2:privacy:budget:verify', 'lv2:regression:read', 'lv2:gates', 'lv2:inherited:gates'] },
  /*
   * 2026-10-05（`AUD-20261005-03`）：**选档器**与**聚合门**自己的实现改了 ⇒ 必须重跑
   * "选档器自证"。`TD-23` / `AUD-20261005-02` 的本体就在这几个文件里：同一个"按 mtime 选最新一份"
   * 的缺陷在三个聚合门上各出现过一次。改判据就重跑判据的量具 —— 这是最低限度。
   */
  { what: '**证据选档器与三个聚合门自己的实现**（`TD-23` / `AUD-20261005-02`）',
    match: [
      'scripts/gate-evidence-select.ts',
      'scripts/m10.1-gate-select.ts',
      'scripts/m10-gates.ts',
      'scripts/m11.1-gates.ts',
      'scripts/m10.1-gates.ts',
    ],
    gates: ['postlv2:gate-selection:verify'] },
  { what: '依赖与构建配置', match: ['package.json', 'pnpm-lock.yaml', 'tsconfig.json'], gates: [], global: true },
  { what: '近期能力离线契约：图片',
    match: ['src/infrastructure/media/**', 'src/kernel/contracts/image-input.ts', 'src/providers/openai-compatible.ts',
      'scripts/postlv2-image-input-verify.ts', 'evals/image-input/**', 'src/main.ts'],
    gates: ['postlv2:image:verify'] },
  { what: '近期能力离线契约：学习技能',
    match: ['src/infrastructure/action/adapters/arxiv.ts', 'src/infrastructure/action/adapters/personal-library.ts',
      'src/infrastructure/action/adapters/workflow-skill.ts', 'src/kernel/action/learning-capabilities.ts',
      'src/kernel/context/workflow-skill-section.ts', 'scripts/learning-skills-verify.ts', 'scripts/learning-skills/**', 'src/main.ts'],
    gates: ['learning:contracts:verify'] },
  { what: '近期能力离线契约：工具编排与规划',
    match: ['src/infrastructure/model/task-orchestration-instructions.ts', 'src/infrastructure/model/openai-task-planner.ts',
      'src/infrastructure/model/openai-tool-decision.ts', 'src/kernel/action/task-loop.ts', 'src/kernel/action/task-plan.ts',
      'scripts/postlv2-orchestration-verify.ts'],
    gates: ['postlv2:orchestration:verify', 'postlv2:role-tool:path'] },
  { what: '桌面调用协议与回复能力事实',
    match: ['src/kernel/action/desktop-capability.ts', 'src/infrastructure/action/adapters/desktop-control*',
      'src/infrastructure/model/openai-task-planner.ts', 'src/infrastructure/model/openai-tool-decision.ts',
      'src/kernel/app/turn-gateway.ts', 'src/main.ts', 'scripts/desktop-control/**'],
    gates: ['desktop-control:verify'] },
  { what: '自动记忆健康与受控恢复',
    match: ['src/infrastructure/runtime/automatic-memory*.ts', 'scripts/postlv2-automatic-memory-recovery-verify.ts', 'src/main.ts'],
    gates: ['postlv2:automatic-memory:recovery:verify'] },
  { what: '轮末统一模型记忆判定与纯语义召回',
    match: ['src/infrastructure/runtime/post-turn-model-memory.ts', 'scripts/postlv2-model-memory*.ts',
      'evals/post-lv2/model-memory-contrast.json', 'src/infrastructure/runtime/automatic-memory-control.ts',
      'src/infrastructure/persistence/memory-retrieval-store.ts', 'src/kernel/app/recall/turn.ts',
      'src/kernel/recall/ranking.ts', 'src/kernel/app/memory/response-truth.ts', 'src/kernel/app/flags.ts', 'src/main.ts'],
    gates: ['postlv2:model-memory:verify'] },
  {
    what: '**浏览器能力 / sidecar 接线 / 第二批验收床**（2026-10-09 / `ADR-125` 补的第二条规则）',
    match: [
      'src/kernel/action/browser-*.ts',
      'src/infrastructure/action/adapters/browser.ts',
      'src/infrastructure/action/browser-sidecar-supervisor.ts',
      'scripts/productivity-skills-verify.ts',
      'scripts/productivity-skills/**',
    ],
    /*
     * ⚠️ 补这条规则的原因（可复核）：在它之前，改 `browser-capability.ts` /
     *    `browser-operations.ts` / 浏览器适配器**只**会命中上面那条
     *    `src/kernel/action/**` ⇒ 跑 m4.5 与 role-tool，**一道浏览器门都不跑**。
     *    而这一批真正的判据（白名单 7→72、闭集不许被放宽、风险额度 R3、
     *    零出站负控）全在 `productivity:verify` 的 `browser-01…05` 里 ——
     *    也就是说"改了浏览器什么都没红"当时是**结构上可能**的（同型先例：QQ 主动联系）。
     */
    gates: ['productivity:verify', 'productivity:sidecar:autostart:verify'],
  },
  { what: '受影响门选择器自身',
    match: ['scripts/gates/affected-map.ts', 'scripts/gates/manifest.ts', 'scripts/gates-run.ts', 'scripts/postlv2-affected-verify.ts'],
    gates: ['postlv2:affected:verify'] },
  { what: 'pnpm 依赖覆盖配置', match: ['pnpm-workspace.yaml'], gates: [], global: true },
  { what: '数据库环境加载保护', match: ['src/db/index.ts', 'scripts/postlv2-database-env-verify.ts'],
    gates: ['postlv2:database-env:verify'] },
  /*
   * PostgreSQL 迁移（WP1）的两条规则。
   *
   * ⚠️ 为什么必须登记（同型先例：QQ 主动联系、浏览器全工具档）：
   *    `src/dev/sandbox.ts` 被 **253 个**脚本使用，而 PG 后端下"隔离"的判据
   *    整个换了地方（目录 → 目标三元组）。不登记 ⇒ 改了这条保护**一道门都不跑**
   *    是**结构上可能**的，而这正是最难事后发现的一类。
   */
  { what: 'PostgreSQL 后端选择与身份核对',
    match: ['src/infrastructure/persistence/database-backend.ts', 'src/infrastructure/persistence/db.ts',
      'scripts/postgresql-g01-verify.ts'],
    gates: ['postgresql:g01:verify', 'm3:migrate-gate', 'postlv2:database-env:verify'] },
  { what: '实验隔离（PGlite 目录 / PostgreSQL 目标）',
    match: ['src/dev/sandbox.ts'],
    gates: ['postgresql:g01:verify', 'm4:isolation:verify', 'm3:migrate-gate', 'postlv2:database-env:verify'] },
  /*
   * PostgreSQL 服务/账号/建库工具（WP2）与 schema 权限门（WP2/WP3）。
   *
   * ⚠️ 为什么必须登记：`scripts/postgresql/**` 里装的是**权限边界本身**
   *    （四账号分离、建库授权重放、compose 的 loopback/digest 固定）。
   *    改了它们而不跑 PG-G02 ⇒ "权限边界被改松了却没有任何门红"是结构上可能的。
   */
  { what: 'PostgreSQL 服务/账号/建库工具与 schema 权限门',
    match: ['scripts/postgresql/**', 'scripts/postgresql-g02-verify.ts'],
    gates: ['postgresql:g01:verify', 'postgresql:g02:verify'] },
  /*
   * 迁移完整性的**量具**（WP4）：规范化比较器 + 只读 PGlite 读取器。
   *
   * ⚠️ 为什么必须登记：后面所有"源与目标一致"的结论都经它产出。
   *    改了它而不跑 PG-G09 ⇒ "比较器悄悄变得不再能发现问题"是结构上可能的，
   *    而那会让**所有**完整性结论一起失效（假绿的最大来源）。
   */
  { what: '迁移完整性量具（规范化比较器 + 只读 PGlite 读取器）',
    match: ['scripts/postgresql/row-digest.ts', 'scripts/postgresql/pglite-reader.ts', 'scripts/postgresql-g09-verify.ts'],
    gates: ['postgresql:g09:verify'] },
  /*
   * 在线备份 / 恢复 / 库外资产（WP4 的 `G07`）。
   *
   * ⚠️ 为什么必须登记：这三个模块一起决定"备份能不能恢复、损坏能不能被拒收"。
   *    改了它们而不跑 PG-G07 ⇒ "篡改/截断的备份被当成好的"或"库外资产没被清单覆盖"
   *    这类问题可以**结构上**发生，而它们全都是**到了要恢复那天才发现**的形状。
   */
  { what: '在线备份与拒收链 + 库外资产清单 + 对象完整清单（PG-G07）',
    match: ['scripts/postgresql/backup.ts', 'scripts/postgresql/external-assets.ts', 'scripts/postgresql/inventory.ts',
      'scripts/postgresql/pg-exec.ts', 'scripts/postgresql/g07-writer.sh', 'scripts/postgresql-g07-verify.ts'],
    gates: ['postgresql:g07:verify'] },
  /*
   * 全库逐表比较（WP5 的 `G05`）。
   *
   * ⚠️ 为什么必须登记：这一组文件决定"整库数据一致"这个结论。其中
   *    `column-encoding.ts` 是**两侧共用**的编码判据 —— 它错一次，
   *    `G05` 会在"看起来在比数据、其实在比驱动的编码"上给出结论。
   */
  { what: '全库逐表比较：两侧编码判据 + 目标读取器 + 源多表会话（PG-G05）',
    match: ['scripts/postgresql/column-encoding.ts', 'scripts/postgresql/pg-target-reader.ts',
      'scripts/postgresql/pglite-reader.ts', 'scripts/postgresql/inventory-probe.ts', 'scripts/postgresql-g05-verify.ts'],
    gates: ['postgresql:g05:verify', 'postgresql:g09:verify'] },
  /*
   * 投影与语义召回（WP5 的 `G06`）。
   *
   * ⚠️ 为什么必须登记：这道门是"**投影是缓存而不是事实本体**"这条铁律在 PG 上的可执行证明。
   *    它依赖**六个 store 级重建函数**与 `character_projections` 的键形状 ——
   *    改了其中任何一个而不跑 PG-G06 ⇒ "重建不再等于恢复出来的投影"是结构上可能的。
   */
  { what: '投影重建与语义召回（六个 store 级重建 + 向量/编码器读数，PG-G06）',
    match: ['scripts/postgresql/projection-probe.ts', 'scripts/postgresql-g06-verify.ts'],
    gates: ['postgresql:g06:verify'] },
  /*
   * 资源读数（WP5 的 `S8`）与"真实库有没有被动过"的评估量具。
   *
   * ⚠️ 为什么必须登记：这两件东西是**运维决策的输入**（迁移的动机是运维能力，
   *    不是延迟数字）。改了测量/评估口径而不跑它们 ⇒ "读数悄悄变得不可比"是可能的。
   */
  { what: '资源读数（S8）与真实库触碰评估量具',
    match: ['scripts/postgresql-bench-verify.ts', 'scripts/postgresql/production-touch-assessment.ts'],
    gates: ['postgresql:bench:verify'] },
  { what: '功能整链与回归（记忆增改撤回 · 通知 · 重启续跑，PG-G08）',
    match: ['scripts/postgresql-g08-verify.ts'],
    gates: ['postgresql:g08:verify'] },
  /*
   * 有限真模型 smoke（WP5 的最后一项交付）。
   *
   * ⚠️ 它是 **live 门**（要 `.env.test` + `pnpm with-test-model`）⇒ **不进** offline lane；
   *    但按改动面**必须**被带出来：改了 smoke 或改了"来源选择"的实现而不跑它，
   *    "真模型那条路还通不通"就没人量了。
   */
  { what: '有限真模型 smoke（隔离 PG + 真模型一次调用）',
    match: ['scripts/postgresql-live-smoke.ts', 'scripts/live-smoke-source.ts'],
    gates: ['postgresql:live:smoke'] },
  /*
   * 单认知执行者资格（WP3 / ADR-132 `D05`）。
   *
   * ⚠️ 为什么必须登记：这个模块是"同一角色只有一个认知执行者"的**唯一**实现。
   *    改了它而不跑 PG-G03 ⇒ "第二个核心不再被拒"是结构上可能的，
   *    而那是一条**并发写**级别的安全问题（不是显示问题）。
   */
  { what: '单认知执行者资格（D05：专用连接 + advisory lock + 可观测失效）',
    match: ['src/infrastructure/persistence/single-core-qualification.ts', 'scripts/postgresql-g03-verify.ts'],
    gates: ['postgresql:g03:verify'] },
  { what: 'OSS 借鉴：播放/中断控制与少量相关记忆注入',
    match: ['scripts/postlv2_speech_client.js', 'scripts/postlv2_voice_control.py', 'scripts/postlv2_vtuber_runtime.py',
      'scripts/postlv2-expression-frontend.py', 'scripts/postlv2-voice-control-verify.py', 'scripts/postlv2-oss-mechanisms-verify.ts',
      'src/kernel/recall/selector.ts', 'src/kernel/app/recall/turn.ts', 'src/kernel/contracts/recall.ts', 'src/main.ts'],
    gates: ['postlv2:oss-mechanisms:verify'] },
  { what: 'Live Smoke 来源保护', match: ['scripts/live-smoke-source.ts', 'scripts/verify-m4.5-smoke-live.ts'],
    gates: ['postlv2:database-env:verify'], global: true },
]

/** 影响面之外的路径：改了它们不需要跑任何门（但要在报告里如实说明）。 */
const IGNORED_PATHS: readonly string[] = ['artifacts/**', 'data/**', '*.md', 'docs/**', '.gitignore']

export interface AffectedPlan {
  /** 推导出来的门 id（有序去重）。 */
  gateIds: string[]
  /** 没有匹配到任何规则的路径 ⇒ 触发 lane 升级。 */
  unmatchedPaths: string[]
  /** 命中"影响面无法切分"的规则 ⇒ 触发 lane 升级。 */
  escalations: { path: string; why: string }[]
  /** 被忽略的路径（不改判据，只为了让报告能解释"为什么它没触发任何门"）。 */
  ignoredPaths: string[]
  /** 每条命中规则的说明。 */
  hits: { path: string; what: string; gates: string[] }[]
  /** 需要升级为整条离线 lane 吗。 */
  escalateToOffline: boolean
}

/** 工作树里改了什么（含未跟踪、不含 ignored 与 artifacts/data）。 */
export function changedPaths(root: string): { paths: string[]; error?: string } {
  /*
   * ⚠️ 2026-10-07（本次全项目审计 §12 的**根因**）：必须带 `-uall`。
   *
   * 不带它时，`git status` 把一个**整个新增目录**折叠成一条 `dir/` 条目
   * （实测：`?? scripts/coexist/`、`?? src/infrastructure/time/`）。
   * 那条路径是**目录**，任何文件级 glob 都匹配不到 ⇒ 被记进 `unmatchedPaths`
   * ⇒ `escalateToOffline = true`。
   *
   * 而升级的后果**不是"多跑了几道门"，而是"推导出来的那几道门一道都不跑"**：
   * lane 被整条替换成 `offline`（= 与 `m4.5:ci` 等价）。于是
   * 「改了共存 ⇒ 跑的是 M1–M4.5 离线链、`postlv2:coexist:verify` 一次没跑」
   * 在结构上是可能的 —— 这正是审计抓到的那条覆盖洞。
   */
  const r = spawnSync('git', ['status', '--porcelain', '-z', '-uall'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
  if (r.status !== 0) {
    return { paths: [], error: `git status 失败（退出码 ${String(r.status)}）：${String(r.stderr ?? '').slice(0, 400)}` }
  }
  const entries = String(r.stdout ?? '')
    .split('\0')
    .filter((s) => s.length > 2)
  const paths: string[] = []
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    if (entry === undefined) continue
    const xy = entry.slice(0, 2)
    paths.push(entry.slice(3).replace(/\\/g, '/'))
    if (xy.includes('R') || xy.includes('C')) i += 1
  }
  return { paths }
}

export function planAffected(paths: readonly string[]): AffectedPlan {
  const gateIds: string[] = []
  const unmatchedPaths: string[] = []
  const escalations: { path: string; why: string }[] = []
  const ignoredPaths: string[] = []
  const hits: { path: string; what: string; gates: string[] }[] = []

  for (const path of paths) {
    if (IGNORED_PATHS.some((g) => globToRegExp(g).test(path))) {
      ignoredPaths.push(path)
      continue
    }
    let matched = false
    for (const rule of AFFECTED_RULES) {
      if (!rule.match.some((g) => globToRegExp(g).test(path))) continue
      matched = true
      hits.push({ path, what: rule.what, gates: [...rule.gates] })
      for (const g of rule.gates) if (!gateIds.includes(g)) gateIds.push(g)
      if (rule.global === true) {
        escalations.push({ path, why: `${rule.what} ⇒ 影响面无法切分` })
      }
    }
    if (!matched) unmatchedPaths.push(path)
  }

  return {
    gateIds,
    unmatchedPaths,
    escalations,
    ignoredPaths,
    hits,
    escalateToOffline: unmatchedPaths.length > 0 || escalations.length > 0,
  }
}

/** An escalation adds the full offline lane without discarding audited offline specialties. */
export function escalatedGateIds(plan: AffectedPlan, offline: readonly string[], specialties: readonly string[]): string[] {
  return [...new Set([...offline, ...plan.gateIds.filter(id => specialties.includes(id))])]
}

/**
 * 把一个门 id 变成可执行的 spec：
 *   ① 清单里有 ⇒ 用清单（带人工核对过的资源声明）；
 *   ② 清单里没有 ⇒ 从 `package.json` **安全合成**（只接受 `tsx <脚本> [参数…]`），
 *      并按 `parallel: 'serial'` 处理（失败关闭：没有经过资源核查的门不许并行）。
 *   ③ 合成不了（复合脚本 / 非 tsx 命令）⇒ 返回原因，调用方**报错退出**。
 */
export function resolveSpec(
  root: string,
  id: string,
  manifest: readonly GateSpec[]
): { spec: GateSpec } | { error: string } {
  const known = manifest.find((g) => g.id === id)
  if (known !== undefined) return { spec: known }

  let scripts: Record<string, string>
  try {
    scripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> })
      .scripts ?? {}
  } catch (error) {
    return { error: `读 package.json 失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const script = scripts[id]
  if (script === undefined) return { error: `门 ${id} 既不在清单里，package.json 里也没有这条脚本` }
  if (/[&|]/.test(script)) {
    return {
      error:
        `门 ${id} 是复合脚本（\`${script}\`）⇒ **拒绝自动展开**。` +
        '复合脚本必须显式登记进 scripts/gates/manifest.ts（人工核查它每一步的资源占用），' +
        '否则"顺手跑一下"会把没核查过的步骤拉进并发里。',
    }
  }
  const parts = script.trim().split(/\s+/)
  if (parts[0] !== 'tsx' || parts[1] === undefined) {
    return { error: `门 ${id} 的命令形状无法安全合成：\`${script}\`（只接受 \`tsx <脚本> [参数…]\`）` }
  }
  const entry = parts[1]
  const argv = [process.execPath, join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), ...parts.slice(1)]
  return {
    spec: {
      id,
      title: `package.json: ${id}`,
      argv,
      entry,
      resources: { parallel: 'serial' },
      why: '未登记进清单 ⇒ 没有经过资源核查 ⇒ 按不可并行处理（失败关闭）',
    },
  }
}
