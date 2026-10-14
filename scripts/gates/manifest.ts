/**
 * 门清单（manifest）—— **哪些门存在、它们各自的资源占用、以及各条 lane 的组成**。
 *
 * ============================================================================
 *  这份清单是"`AGENTS.md` §5 那张表"的机器版本
 * ============================================================================
 * 它**不改**任何门本身：`argv` 与 `package.json` 里那条脚本**逐字等价**
 * （差别只是不经 `pnpm run` 那一层包装：`pnpm` 启动 `node` → 再启动 `tsx`，
 * 而这里直接 `node node_modules/tsx/dist/cli.mjs`，与 `pnpm` 内部做的事相同）。
 *
 * ---------------------------------------------------------------------------
 *  `resources` 的填写纪律（这是整份文件里唯一需要"人来做判断"的部分）
 * ---------------------------------------------------------------------------
 *   ① 只有**确认**了下面全部条件才写 `parallel: 'safe'`：
 *        只用自己的沙箱 / 临时目录（`isolateDatabase()` 生成的目录名含
 *        `Date.now()` + 进程内计数 ⇒ 天然唯一）
 *        · 只写自己那一个证据文件
 *        · 不占固定端口（`listen(0)` 是临时端口，算安全）
 *        · 不改写 git 工作树
 *        · 不碰真实库
 *      任何一条不确定 ⇒ 写 `'serial'`（宁可慢，不可"看起来在跑"）。
 *   ② `evidenceWrites` 用**仓库相对路径**，可以写目录。它有两个用途：
 *      冲突检测 + 快车道跑完的还原白名单。
 *   ③ 每条 `why` 都写清楚**依据**（行号级别），因为下一个人要能复核这个判断。
 *
 * 真实依据来自对 34 个脚本的逐文件核查（`scripts/gates/README.md` 记录了核查方法）。
 */

import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { GateSpec } from './types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根（本文件在 `scripts/gates/`，往上两级）。 */
export const REPO_ROOT = resolve(HERE, '..', '..')

const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const TSC_CLI = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

/** `tsx scripts/x.ts` 的 argv 形式（与 pnpm run 等价，少一层包装）。 */
function tsx(script: string): string[] {
  return [process.execPath, TSX_CLI, script]
}

/** 所有门共用：不写任何证据、纯函数/纯沙箱的门。 */
const SAFE_PURE = { parallel: 'safe' as const }

// ===========================================================================
// 一、M4.5 离线门链（= `pnpm m4.5:ci` 的展开，34 条）
// ===========================================================================

export const OFFLINE_GATES: readonly GateSpec[] = [
  {
    id: 'typecheck',
    title: '类型检查（tsc --noEmit）',
    argv: [process.execPath, TSC_CLI, '--noEmit'],
    resources: { ...SAFE_PURE },
    why: '只读编译；不写证据、不占端口、不起库。',
  },
  {
    id: 'kernel:test',
    title: 'M1–M2 内核契约与投影',
    argv: tsx('scripts/kernel-tests.ts'),
    entry: 'scripts/kernel-tests.ts',
    resources: { ...SAFE_PURE },
    why: '纯内核断言（无 DB、无 spawn、无写文件）。',
  },
  {
    id: 'kernel:test:identity',
    title: '身份与 Seed 版本化',
    argv: tsx('scripts/kernel-tests-identity.ts'),
    entry: 'scripts/kernel-tests-identity.ts',
    resources: { ...SAFE_PURE },
    why: '纯函数断言。',
  },
  {
    id: 'kernel:test:conversation',
    title: '会话事件溯源',
    argv: tsx('scripts/kernel-tests-conversation.ts'),
    entry: 'scripts/kernel-tests-conversation.ts',
    resources: { ...SAFE_PURE },
    why: '纯函数断言。',
  },
  {
    id: 'kernel:verify',
    title: 'L2 内核跨进程（verify-phase-c）',
    argv: tsx('scripts/verify-phase-c.ts'),
    entry: 'scripts/verify-phase-c.ts',
    resources: { ...SAFE_PURE },
    why: "isolateDatabase('verify-phase-c')（默认 runId 含时间戳+计数）⇒ 沙箱唯一。",
  },
  {
    id: 'm3:verify',
    title: 'M3 持久化',
    argv: tsx('scripts/verify-m3-persistence.ts'),
    entry: 'scripts/verify-m3-persistence.ts',
    resources: { ...SAFE_PURE },
    why: "isolateDatabase('m3-persistence-verify', {keep:true})，目录名唯一；自清理。",
  },
  {
    id: 'm3:migrate-gate',
    title: '迁移闸（放行/拦截）',
    argv: tsx('scripts/verify-migrate-gate.ts'),
    entry: 'scripts/verify-migrate-gate.ts',
    // ⚠️ 保守：本门用**真实库路径**判定"这条迁移该不该被拦"。
    //    即使它不真的打开真实库，也按 INV-DB-01 的纪律当"真库相关"处理（串行 + 永不缓存）。
    resources: { parallel: 'serial', realDb: true },
    why: '引用 PRODUCTION_DB_DIR 做放行/拦截判定（第 77、230 行）。按 INV-DB-01 保守串行。',
  },
  {
    id: 'm3:seed-check',
    title: 'Seed 漂移检测',
    argv: tsx('scripts/seed-check.ts'),
    entry: 'scripts/seed-check.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['docs/m3/seed-fingerprint.json'] },
    why: '链上**不带** `--update` ⇒ 只读（写片段被 `--update` 守着，第 107 行）。声明可能写的路径只为让冲突检测与还原白名单覆盖它。',
  },
  {
    id: 'eval:scenarios',
    title: '场景回归（evals harness）',
    argv: tsx('scripts/eval-scenarios.ts'),
    entry: 'scripts/eval-scenarios.ts',
    resources: { ...SAFE_PURE },
    why: '每个场景由 evals/harness 自行 isolate 并在结束时 cleanupSandbox（第 47–79 行）。',
  },
  {
    id: 'eval:m3',
    title: 'M3 人格评测',
    argv: tsx('scripts/eval-m3.ts'),
    entry: 'scripts/eval-m3.ts',
    resources: { ...SAFE_PURE },
    why: '只写 `--json <path>`（链上不传）；沙箱由 harness 隔离。',
  },
  {
    id: 'eval:telemetry',
    title: '遥测落盘（本地 HTTP 服务）',
    argv: tsx('scripts/verify-telemetry.ts'),
    entry: 'scripts/verify-telemetry.ts',
    // ⚠️ 它直接读写 `data/telemetry-dump.jsonl`（第 60–61 行）—— 真实库的同级目录。
    //    端口用的是 `listen(0)`（临时端口）没问题，但 `data/` 这个位置足够敏感：
    //    按"不确定就串行"处理。
    resources: { parallel: 'serial', evidenceWrites: ['data/telemetry-dump.jsonl'] },
    why: '读写 data/ 下的落盘文件（真实库同级目录）；按保守纪律串行。',
  },
  {
    id: 'eval:otlp',
    title: 'OTLP 兼容（fixture 探针）',
    argv: tsx('scripts/verify-otlp-compat.ts'),
    entry: 'scripts/verify-otlp-compat.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['evals/fixtures/otlp'] },
    why: 'fixture 缺文件或 `--refresh` 时才写（第 144–146 行）；链上通常只读。',
  },
  {
    id: 'eval:dryrun',
    title: '干跑静默（dry-run 不写记忆）',
    argv: tsx('scripts/verify-dry-run-silence.ts'),
    entry: 'scripts/verify-dry-run-silence.ts',
    resources: { ...SAFE_PURE },
    why: "isolateDatabase('dry-run-silence')。",
  },
  {
    id: 'eval:providers',
    title: 'Provider 白名单',
    argv: tsx('scripts/verify-provider-whitelist.ts'),
    entry: 'scripts/verify-provider-whitelist.ts',
    resources: { ...SAFE_PURE },
    why: "isolateDatabase('provider-whitelist')。",
  },
  {
    id: 'm3.5:test',
    title: 'M3.5 前瞻兼容 + prompt 逐字节基线',
    argv: tsx('scripts/future-compat-tests.ts'),
    entry: 'scripts/future-compat-tests.ts',
    resources: { ...SAFE_PURE },
    why: '读 prompt 基线并比对；不写证据。',
  },
  {
    id: 'm3.5:verify',
    title: 'M3.5 持久化',
    argv: tsx('scripts/verify-m3.5-persistence.ts'),
    entry: 'scripts/verify-m3.5-persistence.ts',
    resources: { ...SAFE_PURE },
    why: "isolateDatabase('m3.5-persistence-verify', {keep:true})。",
  },
  {
    id: 'm4:test',
    title: 'M4 Memory Kernel 部件',
    argv: tsx('scripts/kernel-tests-memory.ts'),
    entry: 'scripts/kernel-tests-memory.ts',
    resources: { ...SAFE_PURE },
    why: '无 isolate / 无写文件 / 无 spawn ⇒ 纯部件断言。',
  },
  {
    id: 'm4:verify',
    title: 'M4 持久化（L2）',
    argv: tsx('scripts/verify-m4-persistence.ts'),
    entry: 'scripts/verify-m4-persistence.ts',
    resources: { ...SAFE_PURE },
    why: "isolateDatabase('m4-persistence-verify', {keep:true})。",
  },
  {
    id: 'm4:faults',
    title: 'M4 故障注入',
    argv: tsx('scripts/verify-m4-faults.ts'),
    entry: 'scripts/verify-m4-faults.ts',
    resources: { ...SAFE_PURE },
    why: "isolateDatabase('m4-faults')。",
  },
  {
    id: 'm4:restart:verify',
    title: 'M4 重启后状态不丢',
    argv: tsx('scripts/verify-m4-restart.ts'),
    entry: 'scripts/verify-m4-restart.ts',
    resources: { ...SAFE_PURE },
    why: 'spawn 子进程，但 runId 含 pid+时间戳（第 99 行），交接文件在自己的沙箱里（第 193 行）⇒ 不与其他门共享。',
  },
  {
    id: 'm4:isolation:verify',
    title: 'M4 隔离（A/B 用户不串）',
    argv: tsx('scripts/verify-m4-isolation.ts'),
    entry: 'scripts/verify-m4-isolation.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m4-acceptance/isolation'] },
    why: "isolateDatabase('m4-isolation', {keep:true}) + 自己的证据目录（第 21 行附近）。",
  },
  {
    id: 'postgresql:g01:verify',
    title: 'PG-G01 配置与隔离（PostgreSQL 后端选择 / 错配置与错目标失败关闭）',
    argv: tsx('scripts/postgresql-g01-verify.ts'),
    entry: 'scripts/postgresql-g01-verify.ts',
    /*
     * 资源填写依据（逐条核过）：
     *   · **不打开任何数据库**：主体是纯函数断言；4 个子进程用 `mkdtempSync` 的临时目录
     *     + 注入的假 `registerPlugin`（`initDatabase` 只走到"注册插件"就抛）。
     *   · **不碰真实库**：子进程里的 `.env` 是自造的 fixture；`PRODUCTION_DB_DIR` 只被
     *     当作"应当被拒的字符串"使用，从不打开。
     *   · 不占固定端口、不改写 git 工作树、不写任何证据文件（只往 stdout 打报告）。
     *   · 三个"真 PG 实例"用例**不在本门里**（如实报 NOT RUN）⇒ 不依赖任何外部服务。
     */
    resources: { ...SAFE_PURE },
    why: '纯函数 + 临时目录子进程；无数据库、无端口、无证据落盘（见本条 why 的逐条核对）。',
  },
  {
    id: 'm4:restore:verify',
    title: 'M4 快照/恢复',
    argv: tsx('scripts/verify-m4-restore.ts'),
    entry: 'scripts/verify-m4-restore.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m4-acceptance/restore'] },
    why: '三个沙箱标签各自唯一（source/empty/target）+ 自己的证据目录。',
  },
  {
    id: 'm4:mutation-safety:verify',
    title: 'M4 变更安全',
    argv: tsx('scripts/verify-m4-mutation-safety.ts'),
    entry: 'scripts/verify-m4-mutation-safety.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m4.1/mutation-safety.json'] },
    why: '沙箱标签按用例名派生（唯一）；只写自己那一个证据文件。',
  },
  {
    id: 'm4:nl-mutation:verify',
    title: 'M4 自然语言变更（L3）',
    argv: tsx('scripts/verify-m4-nl-mutation.ts'),
    entry: 'scripts/verify-m4-nl-mutation.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m4.1/nl-mutation.json'] },
    why: '沙箱标签按用例名派生（唯一）；只写自己那一个证据文件。',
  },
  {
    id: 'eval:m4',
    title: 'M4 场景评测',
    argv: tsx('scripts/eval-m4.ts'),
    entry: 'scripts/eval-m4.ts',
    resources: { ...SAFE_PURE },
    why: "isolateDatabase('m4-scenarios', {keep:true})。",
  },
  {
    id: 'm4:promptfoo:build',
    title: '生成 promptfoo 配置',
    argv: tsx('scripts/build-m4-promptfoo-config.ts'),
    entry: 'scripts/build-m4-promptfoo-config.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['evals/m4/promptfoo'] },
    why: '只写生成物目录 evals/m4/promptfoo；下游两步用 dependsOn 串起来。',
  },
  {
    id: 'm4:promptfoo:assertions',
    title: 'promptfoo 断言自检',
    argv: tsx('scripts/verify-m4-promptfoo-assertions.ts'),
    entry: 'scripts/verify-m4-promptfoo-assertions.ts',
    resources: { ...SAFE_PURE },
    dependsOn: ['m4:promptfoo:build'],
    why: '读上一步生成的配置；不写文件。',
  },
  {
    id: 'm4:promptfoo:run',
    title: 'promptfoo 离线档（确定性 provider）',
    argv: tsx('scripts/run-m4-promptfoo.ts'),
    entry: 'scripts/run-m4-promptfoo.ts',
    resources: { ...SAFE_PURE },
    dependsOn: ['m4:promptfoo:build', 'm4:promptfoo:assertions'],
    why: 'spawn promptfoo CLI，但结果写在 mkdtempSync 的临时目录（第 151、160 行）⇒ 不共享路径。',
  },
  {
    id: 'm4.5:test',
    title: 'M4.5 行动部件（L1）',
    argv: tsx('scripts/kernel-tests-action.ts'),
    entry: 'scripts/kernel-tests-action.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m4.5/component.json'] },
    why: '只写自己的 component.json。',
  },
  {
    id: 'm4.5:verify',
    title: 'M4.5 行动管线（L2，正负双控）',
    argv: tsx('scripts/verify-m4.5-pipeline.ts'),
    entry: 'scripts/verify-m4.5-pipeline.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m4.5/pipeline.json'] },
    why: "isolateDatabase('m45-pipeline') + 自己的 pipeline.json。",
  },
  {
    id: 'm4.5:measurement:verify',
    title: 'M4.5 量具验证（L0）',
    argv: tsx('scripts/verify-m4.5-measurement.ts'),
    entry: 'scripts/verify-m4.5-measurement.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m4.5/measurement.json'] },
    why: "spawn 的 CLI 与播种器都显式注入 sandbox.dir 作为 PGLITE_DATA_DIR（第 82–104 行）⇒ 不与其他门共享库。",
  },
  {
    id: 'm4.5:nl-action:verify',
    title: 'M4.5 自然语言行动（L3）',
    argv: tsx('scripts/verify-m4.5-nl-action.ts'),
    entry: 'scripts/verify-m4.5-nl-action.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m4.5/nl-action.json'] },
    why: '沙箱标签按用例名派生（唯一）。',
  },
  {
    id: 'm4.5:audit',
    title: 'M4.5 审计语料',
    argv: tsx('scripts/m4.5-audit.ts'),
    entry: 'scripts/m4.5-audit.ts',
    resources: {
      ...SAFE_PURE,
      evidenceWrites: ['artifacts/m4.5/audit-corpus.json', 'artifacts/m4.5/audit-report.txt'],
    },
    why: "isolateDatabase('m45-audit', {keep:true}) + 自己那两个证据文件。",
  },
  {
    id: 'm4.5:gates',
    title: 'M4.5 门汇总（只读已落盘证据）',
    argv: tsx('scripts/m4.5-gate-results.ts'),
    entry: 'scripts/m4.5-gate-results.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m4.5/gate-results.json'] },
    // 它是**汇总门**：读别的门写下的证据 ⇒ 必须等那些门落盘。
    dependsOn: ['m4.5:test', 'm4.5:verify', 'm4.5:measurement:verify', 'm4.5:nl-action:verify'],
    why: '读 component/pipeline/measurement/nl-action 四份证据（第 77–112 行）⇒ 用 dependsOn 表达顺序，而不是靠资源冲突。',
  },
]

// ===========================================================================
// 二、里程碑汇总门（只读已落盘证据，秒级）—— 单独一条 lane，便于秒级体检
// ===========================================================================

/**
 * 只读汇总门（2026-10-04 · A-3 追加）：读已落盘证据、写自己那份汇总；秒级。
 * `evidenceWrites` 用各自的里程碑根；空数组 = **连文件都不写**（`m9.6:gates` 源码逐字声明）。
 */
function summaryGate(id: string, entry: string, evidenceWrites: readonly string[]): GateSpec {
  return {
    id,
    title: `只读汇总门：${id}`,
    argv: tsx(entry),
    entry,
    resources: evidenceWrites.length > 0 ? { ...SAFE_PURE, evidenceWrites } : { ...SAFE_PURE },
    why:
      '只读各门已落盘证据（不跑门、不开库、不改写工作树）。⚠️ 读数**如实**：' +
      '某道汇总门报 NOT PASS / FAIL 是它那个里程碑的真读数，不是本 lane 的故障。',
  }
}

/**
 * 更晚里程碑的只读汇总门 —— 此前**不在**任何 lane 里（2026-10-04 · A-3）。
 *
 * ⚠️ 它们**单独一条 lane**（`summaries-all`），**不并进** `summaries`：
 * `summaries` 是"秒级体检"的稳定入口，且被多份文档引用为读数（例：R-05/R-17 的"summaries 7/7 PASS"）。
 * 本组里有 **6 道当下就是真 FAIL**（`m5.1:gates` 是 `m4.5` G14 的传递；`m6.1:gates` exit=2 见其输出；
 * `m9:gates` 11/13；`m11.1:gates` NOT PASS；`lv2:gates` / `lv2:inherited:gates` 继承读数）
 * ⇒ 并进去会让那条命令**从"7/7 PASS"变成红**，而红的原因跟被体检的改动无关。
 * 要全里程碑体检：`pnpm gates:run --lane summaries-all`（21 道 · 实测墙钟约 15 秒）。
 */
export const SUMMARY_LATE_GATES: readonly GateSpec[] = [
  summaryGate('m6.1:gates', 'scripts/m6.1-gates.ts', ['artifacts/m6.1']),
  summaryGate('m7:gates', 'scripts/m7-gates.ts', ['artifacts/m7']),
  summaryGate('m8:gates', 'scripts/m8-gates.ts', ['artifacts/m8']),
  summaryGate('m8.5:gates', 'scripts/m8.5-gates.ts', ['artifacts/m8.5']),
  summaryGate('m9:gates', 'scripts/m9-gates.ts', ['artifacts/m9']),
  summaryGate('m9.1:gates', 'scripts/m9.1-gates.ts', ['artifacts/m9.1']),
  summaryGate('m9.5:gates', 'scripts/m9.5-gates.ts', ['artifacts/m9.5']),
  summaryGate('m9.6:gates', 'scripts/m9.6-gates.ts', []),
  summaryGate('m10.1:gates', 'scripts/m10.1-gates.ts', ['artifacts/m10.1']),
  summaryGate('m11:gates', 'scripts/m11-gates.ts', ['artifacts/m11']),
  summaryGate('m11.1:gates', 'scripts/m11.1-gates.ts', ['artifacts/m11.1']),
  summaryGate('lv2:gates', 'scripts/lv2-gates.ts', ['artifacts/lv2']),
  summaryGate('lv2:inherited:gates', 'scripts/lv2-inherited-gates.ts', ['artifacts/lv2']),
  summaryGate('postlv2:s8:gates', 'scripts/postlv2-s8-gates.ts', ['artifacts/post-lv2']),
]

export const SUMMARY_GATES: readonly GateSpec[] = [
  {
    id: 'm5:gates',
    title: 'M5 门汇总',
    argv: tsx('scripts/m5-gate-results.ts'),
    entry: 'scripts/m5-gate-results.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m5'] },
    why: '只读各门证据 + 写自己的汇总。',
  },
  {
    id: 'm5.1:gates',
    title: 'M5.1 十二道门汇总',
    argv: tsx('scripts/m5.1-gate-results.ts'),
    entry: 'scripts/m5.1-gate-results.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m5.1'] },
    why: '只读各门证据 + 写自己的汇总。',
  },
  {
    id: 'm5.1.1:gates',
    title: 'M5.1.1 九门汇总',
    argv: tsx('scripts/m5.1.1-gate-results.ts'),
    entry: 'scripts/m5.1.1-gate-results.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m5.1.1'] },
    why: '只读各门证据 + 写自己的汇总。',
  },
  {
    id: 'm5.5:gates',
    title: 'M5.5 门汇总（G1–G5）',
    argv: tsx('scripts/m5.5-gate-results.ts'),
    entry: 'scripts/m5.5-gate-results.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m5.5'] },
    why: '只读各门证据 + 写自己的汇总。',
  },
  {
    id: 'm5.5.1:gates',
    title: 'M5.5.1 六门汇总（含三段式自证）',
    argv: tsx('scripts/m5.5.1-gates.ts'),
    entry: 'scripts/m5.5.1-gates.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m5.5.1'] },
    why: '只读各门证据 + 写自己的汇总。',
  },
  {
    id: 'm6:gates',
    title: 'M6 必选门汇总（17 门）',
    argv: tsx('scripts/m6-gates.ts'),
    entry: 'scripts/m6-gates.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m6'] },
    why: '只读各门证据 + 写自己的汇总。',
  },
  {
    id: 'inc-01:gates',
    title: 'INC-01 门汇总',
    argv: tsx('scripts/inc-01-gates.ts'),
    entry: 'scripts/inc-01-gates.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/incidents/inc-01'] },
    // 首次真实快照（G9）授权前它**按设计**非零（如实报"有门未运行"）。
    // 这是登记在案的已知非零，见 docs/incidents/INC-01-Prevention-Execution-Plan.md。
    acceptExitCodes: [2],
    why: '只读各门证据 + 写自己的汇总；G9 授权前按设计退出码非零（已登记）。',
  },
]

// ===========================================================================
// 三、TD 专项门（搜索可靠性与隐私边界）—— **刻意不并入离线链**
// ===========================================================================

/**
 * ⚠️ 为什么单独一组、而不是塞进 `OFFLINE_GATES`。
 *
 * `offline` lane 的公开声明是「**与 `pnpm m4.5:ci` 逐条等价**」（见下面 `LANES`）。
 * 往 `OFFLINE_GATES` 里加门会让那句声明**当场变假** —— 而发布证据必须来自
 * 冻结的命令清单（`AGENTS.md` §9.1 的铁律）。要改那份清单属独立裁定，
 * 不是"补两道门"能顺手做的。
 *
 * 于是这两道门登记在**自己的分组**里：可被调度、可被 `--lane all` 带到、
 * 可被 `--lane affected` 在改动搜索层时自动带出（见 `affected-map.ts` 的搜索层规则），
 * 但**不**改变离线链的组成。
 *
 * 依据（读数与剩余缺口）见 `docs/tech-debt/TD-10-TD-12-Reliability-and-Privacy-Phase1.md`。
 */
export const TD_GATES: readonly GateSpec[] = [
  {
    id: 'td10:reliability',
    title: 'TD-10 搜索链路可靠性（超时 / 空结果 / 失败降级）',
    argv: tsx('scripts/verify-td10-search-reliability.ts'),
    entry: 'scripts/verify-td10-search-reliability.ts',
    resources: {
      /*
       * 判成 `serial` 而不是 `safe`，理由是**清单纪律本身**（不是这道门有问题）：
       * 它 import `scripts/m4-harness.ts`，那个模块在**模块级**加载
       * `@elizaos/plugin-sql` / `@elizaos/core`（进程级单例的持有者）。
       * 本门从头到尾**没有**调 `initDatabase` / `isolateDatabase` / 开任何库，
       * 但"没有可读到的反例"不等于"已确认安全" ⇒ 按 §清单纪律写 serial。
       * 代价可忽略（本门 ~1s；lane 里只有这两道门）。
       */
      parallel: 'serial',
      evidenceWrites: ['artifacts/td/td10-td12/reliability-offline.json'],
    },
    why:
      '完全离线（不联网 / 不需要 key / 不碰数据库 / 不加载 `.env`），只写自己那一份证据（逐字节可复现）。' +
      '⚠️ 手工加 `--live` 时会**额外**写时间戳命名的 `reliability-live-*.json` 并真的出站 —— ' +
      'lane 不传该参数，故那两个动态文件名**未**登记为证据路径。',
  },
  {
    id: 'td12:privacy',
    title: 'TD-12 搜索触发边界与出站隐私边界',
    argv: tsx('scripts/verify-td12-privacy-boundary.ts'),
    entry: 'scripts/verify-td12-privacy-boundary.ts',
    resources: {
      parallel: 'serial',
      evidenceWrites: ['artifacts/td/td10-td12/privacy-offline.json'],
    },
    why:
      '完全离线（真实检测器 + 真实请求构造 + 记录器吃掉的 fetch 永不发出），只写自己那一份证据。' +
      '同样 import `m4-harness.ts` 取 reporter ⇒ 与 td10 同一条理由写 serial。',
  },
]

// ===========================================================================
// 五、M9 信念域门（计划 §16.2 登记）—— **刻意不并入离线链**
// ===========================================================================

/**
 * ⚠️ 与 TD_GATES 同一条纪律：`offline` lane 的公开声明是
 * 「与 `pnpm m4.5:ci` 逐条等价」，往 OFFLINE_GATES 里加门会让声明当场变假。
 * M9 的门登记在自己的分组 + 专用 lane（`pnpm gates:run --lane m9`），
 * `--lane affected` 在改动信念域路径时经 affected-map 自动带出。
 *
 * 资源声明依据（逐文件核查 2026-09-27）：
 *   · 除 `m9:wp0:baseline`（读 git 树 + `--out` 写证据，不开库）外，
 *     全部 `isolateDatabase('m9-…', { keep: false })` ⇒ 沙箱目录唯一、不碰真实库；
 *   · 每道门只写自己 `artifacts/m9/<runId>/` 下的证据（runId 含日期+head+后缀）
 *     ⇒ 声明 `evidenceWrites: ['artifacts/m9']`，同目录重叠由调度器自动串行；
 *   · 不占端口、不改写 git 工作树、无模型调用（WP9 的 live 门**不在**这里——
 *     它们要真模型，登记属 WP9 收口时的独立裁定）。
 */
export const M9_GATES: readonly GateSpec[] = [
  {
    id: 'm9:wp0:baseline',
    title: 'M9 WP0 基线捕获（CAPTURED 即合法）',
    argv: tsx('scripts/m9-wp0-baseline.ts'),
    entry: 'scripts/m9-wp0-baseline.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m9'] },
    why: '读 git 树/package.json 捕基线，不开任何库；只写 --out 指定的 artifacts/m9/<runId>。',
  },
  {
    id: 'm9:wp0:admission',
    title: 'M9 WP0 准入核查（一次性准入记录）',
    argv: tsx('scripts/m9-wp0-admission.ts'),
    entry: 'scripts/m9-wp0-admission.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m9'] },
    // ⚠️ 一次性准入记录（同 m5.1.1:wp11:verify 的处境）：它断言的是**开工前**
    // 基线——M7 潜伏缺陷在场（PRE-02，WP0-R 修复对象）、contracts 下无 belief
    // 文件（PRE-08 存在性锁，WP2 交接对象）、flags 无 CHARACTER_BELIEF_ENABLED
    // （WP6 才新增）、domainEventsFor 无 afterSequence（WP6 追加）。M9 建成 +
    // WP0-R 修复后这些断言**按设计翻红**（2026-09-27 实测 18/25）。它不是可
    // 重复的当前态门；当前态权威 = m9:wp0r:verify（POST-fix 复核，在 lane 内）。
    // 准入当时的 PASS 读数见 docs/m9/M9-Admission-Report.md，不回写。
    acceptExitCodes: [1],
    why: "isolateDatabase('m9-wp0-admission')；沙箱唯一；只写自己的证据目录。acceptExitCodes=[1]：断言开工前基线，建成后按设计非零（见左侧注释与 inc-01:gates 先例）。",
  },
  {
    id: 'm9:wp0r:verify',
    title: 'M9 WP0-R 复核',
    argv: tsx('scripts/m9-wp0r-verify.ts'),
    entry: 'scripts/m9-wp0r-verify.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m9'] },
    why: "isolateDatabase('m9-wp0r-verify')；沙箱唯一；只写自己的证据目录。",
  },
  {
    id: 'm9:test',
    title: 'M9 信念域部件测试（L1）',
    argv: tsx('scripts/m9-test.ts'),
    entry: 'scripts/m9-test.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m9'] },
    why: '纯内核断言 + 沙箱；只写自己的证据目录。',
  },
  {
    id: 'm9:measurement:verify',
    title: 'M9 量具有效性（正控/负控/恢复）',
    argv: tsx('scripts/m9-measurement-verify.ts'),
    entry: 'scripts/m9-measurement-verify.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m9'] },
    why: '量具三段式自证；沙箱；只写自己的证据目录。',
  },
  {
    id: 'm9:source:verify',
    title: 'M9 来源资格（WP3）',
    argv: tsx('scripts/m9-source-verify.ts'),
    entry: 'scripts/m9-source-verify.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m9'] },
    why: "isolateDatabase('m9-source-verify')；沙箱唯一；只写自己的证据目录。",
  },
  {
    id: 'm9:verify',
    title: 'M9 信念子系统（WP4）',
    argv: tsx('scripts/m9-verify.ts'),
    entry: 'scripts/m9-verify.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m9'] },
    why: "isolateDatabase('m9-verify')；沙箱唯一；只写自己的证据目录。",
  },
  {
    id: 'm9:invalidation:verify',
    title: 'M9 失效传播（WP5）',
    argv: tsx('scripts/m9-invalidation-verify.ts'),
    entry: 'scripts/m9-invalidation-verify.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m9'] },
    why: "isolateDatabase('m9-invalidation-verify')；沙箱唯一；只写自己的证据目录。",
  },
  {
    id: 'm9:runtime:verify',
    title: 'M9 调度与双流（WP6）',
    argv: tsx('scripts/m9-runtime-verify.ts'),
    entry: 'scripts/m9-runtime-verify.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m9'] },
    why: "isolateDatabase('m9-runtime-verify')；沙箱唯一；只写自己的证据目录。",
  },
  {
    id: 'm9:context:verify',
    title: 'M9 上下文面（WP7）',
    argv: tsx('scripts/m9-context-verify.ts'),
    entry: 'scripts/m9-context-verify.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m9'] },
    why: "isolateDatabase('m9-context-verify')；沙箱唯一；只写自己的证据目录。",
  },
  {
    id: 'm9:perf:baseline',
    title: 'M9 性能基线探针（形成 / 查询 / 上下文回查的 p50·p95 + DB 调用数）',
    argv: tsx('scripts/m9-perf-baseline.ts'),
    entry: 'scripts/m9-perf-baseline.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m9'] },
    why:
      "isolateDatabase('m9-perf-baseline')；沙箱唯一；只写自己的证据目录；零模型、零出网。" +
      '⚠️ 它**只出读数、不判 SLA**（`TD-17` 的 SLA 尚未冻结）：退出码非零只表示"量具自己的三段式控制失败"或"空集自检失败"，' +
      '不表示任何性能不达标。',
  },
  {
    id: 'm9:e2e:verify',
    title: 'M9 端到端场景矩阵（WP8 门 1：B01–B48 真网关+真双流）',
    argv: tsx('scripts/m9-e2e-verify.ts'),
    entry: 'scripts/m9-e2e-verify.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m9'] },
    why: "isolateDatabase('m9-e2e-verify')；沙箱唯一；只写自己的证据目录。",
  },
  {
    id: 'm9:scale:verify',
    title: 'M9 规模门（WP8 门 3：B42/B43 信念半/B45/B47，审计修订范围）',
    argv: tsx('scripts/m9-scale-verify.ts'),
    entry: 'scripts/m9-scale-verify.ts',
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m9'] },
    why: "isolateDatabase('m9-scale-verify')；沙箱唯一；只写自己的证据目录。m9:long:verify（B32）按审计 CANCELLED，不存在也不登记。",
  },
]

// ===========================================================================
// 六、lane 注册表
// ===========================================================================

export interface Lane {
  id: string
  title: string
  /** 由这份清单驱动时给出的门 id 顺序（顺序只影响展示，不影响调度）。 */
  gateIds?: readonly string[]
  /** 或者由"改动文件 → 门"的映射推导（见 affected-map.ts）。 */
  fromChangedPaths?: boolean
  /** 说明这条 lane 的用途与**它能主张什么 / 不能主张什么**。 */
  note: string
}

/**
 * M9.5 门（Round 79 登记）。
 *
 * ⚠️ **不塞进 `OFFLINE_GATES`**：那条 lane 的公开声明是「与 `pnpm m4.5:ci` 逐条等价」，
 *    加门会让那句话**当场变假**（本文件 L410–413/L467 已有此纪律）⇒ 另立一组，与 `M9_GATES` 同形。
 * ⚠️ 声明依据（用户 2026-09-28 裁定 **甲** + 本文件 §14–21 的纪律）：
 *    · `digestTree(data/pglite)` 是**只读**目录摘要（不取租约、不打开 PGlite、不写字节）
 *      ⇒ 按裁定**不**算"碰真实库"（措辞见 `scripts/gates/README.md` 的规则澄清节）
 *    · 每道门只写自己那个 `<runId>` 目录；不占端口；**不改写 git 工作树**（例外见下）
 * ⚠️ **例外（必须 `serial`）**：`m9.5:corpus` 与 `m9.5:regression:verify` **改写工作树**；
 *    `m9.5:aggregator:verify` 要在**稳定**档案树上对账；`m9.5:a3:download` 写模型目录（读取方互斥）。
 * ⚠️ 真模型门（`smoke:live` / `long:live`）**不在此组**：它们要真模型与额度，登记属独立裁定。
 */
const M95_EVIDENCE = { ...SAFE_PURE, evidenceWrites: ['artifacts/m9.5'] } as const

/** 只写自己的 `<runId>`、不开真实库、不改工作树 ⇒ 与 `M9_GATES` 同形 */
function m95(id: string, script: string, title: string): GateSpec {
  return {
    id,
    title,
    argv: tsx(script),
    entry: script,
    resources: { ...M95_EVIDENCE },
    why: '只写 artifacts/m9.5/<runId>；isolateDatabase 沙箱唯一；不占端口；不改 git 工作树；digestTree 只读（用户裁定甲）。',
  }
}

export const M95_GATES: readonly GateSpec[] = [
  {
    id: 'm9.5:baseline',
    title: 'M9.5 WP0 基线与旧缺口归因',
    /*
     * ⚠️ **Round 88 修路径**：登记时猜成 `scripts/m9.5-baseline.ts`，**该文件不存在**
     *    ⇒ `tsx` 立刻失败（**0.2s / exit=1**），在调度里表现为 FAIL。
     *    真实文件是 **`scripts/m9.5-wp0-baseline.ts`**（`Get-ChildItem scripts -Filter 'm9.5-*.ts'` 实测）。
     *    ⇒ 教训：`argv`/`entry` 的**脚本存在性没有任何判据**（`gates:verify` 只校验清单结构）
     *      —— 一个错别字就变成"0.2 秒就失败的门"，且**看起来像门坏了**。
     */
    argv: tsx('scripts/m9.5-wp0-baseline.ts'),
    entry: 'scripts/m9.5-wp0-baseline.ts',
    resources: { ...M95_EVIDENCE, parallel: 'serial' },
    why: '捕基线要求**树稳定** ⇒ serial；其余同 M95_EVIDENCE。',
  },
  {
    id: 'm9.5:poc',
    title: 'M9.5 WP1 向量组件能力（§6.3 第 1–2 条）',
    /*
     * ⚠️ **Round 111 修参数**：脚本要求 **`--part vector`**（另一档 `--part model` **有意未实现**：
     *    它需要安装本地推理运行时 + 下载资产，属**安装出站**决策）。
     *    第一版登记**没传参数** ⇒ 脚本打印「`--part 必须是 vector（收到：undefined）`」后 **exit=2**。
     *    ⇒ 这是同一处的**第 3 个**登记缺陷（前两个：脚本路径猜错 · 缺 `dependsOn`）。
     */
    argv: [...tsx('scripts/m9.5-poc.ts'), '--part', 'vector'],
    entry: 'scripts/m9.5-poc.ts',
    resources: { ...M95_EVIDENCE },
    /*
     * ⚠️ **Round 84 补 `dependsOn`**：它需要**已下载的模型**。第一版没声明依赖
     *    ⇒ 调度器让它与 `m9.5:embedding:download`（serial）**并发起跑** ⇒ 模型还没下来
     *    ⇒ `exit=2`（**拒绝运行**）。它的封存档平时是 `exitCode=0 / usable=true`。
     */
    dependsOn: ['m9.5:embedding:download'],
    why: '需要已下载的本地模型（依赖 embedding:download）+ 必须显式 `--part vector`；其余同 M95_EVIDENCE。',
  },
  m95('m9.5:measurement:verify', 'scripts/m9.5-measurement.ts', 'M9.5 WP2 量具有效性（正控/负控/恢复）'),
  m95('m9.5:calibration:verify', 'scripts/m9.5-calibration-verify.ts', '校准链①：A0/A1/A2 开发集对照'),
  m95('m9.5:validation:verify', 'scripts/m9.5-validation-verify.ts', '校准链②：独立验证集确认'),
  m95('m9.5:legacy-strength:verify', 'scripts/m9.5-legacy-strength-verify.ts', '校准链③：旧强项回归'),
  m95('m9.5:lexical-calibration', 'scripts/m9.5-lexical-calibration.ts', 'L-M95-18 A：有限词面权重校准'),
  {
    id: 'm9.5:a3:arm',
    title: '计划 §277 A3：换 embedding 模型的库外对照',
    /*
     * ⚠️ **Round 111 补 `dependsOn`**（与 `poc` 那处**同一类**，第 4 次）：它要读 **A3 的模型资产**，
     *    而 lane 里 **`a3:arm`（第 7 道）排在 `a3:download`（第 32 道）之前** ⇒ 资产还没下
     *    ⇒ `@huggingface/transformers` 在 `get_model_files` 抛错 ⇒ **exit=1**（实测 2.3s）。
     *    ⇒ 这正是"**登记时该逐门核对：它要什么参数、依赖谁、读哪个资产**"的又一例。
     */
    argv: tsx('scripts/m9.5-a3-arm.ts'),
    entry: 'scripts/m9.5-a3-arm.ts',
    resources: { ...M95_EVIDENCE },
    dependsOn: ['m9.5:a3:download'],
    why: '读 A3 模型资产（依赖 a3:download）；只写 artifacts/m9.5/<runId>；其余同 M95_EVIDENCE。',
  },
  m95('m9.5:test', 'scripts/m9.5-contract-tests.ts', 'WP3–8 纯契约门'),
  m95(
    'm9.5:build:verify',
    'scripts/m9.5-build-verify.ts',
    '启用计划 WP2-A 源枚举（keyset 分页/预算/游标/资格分列）'
  ),
  m95('m9.5:encoder:verify', 'scripts/m9.5-encoder-verify.ts', 'WP3 可终止执行单元 / 硬截止 / 清单与资产'),
  m95('m9.5:index:verify', 'scripts/m9.5-index-verify.ts', 'WP4 分页/版本/覆盖/generation/精确检索'),
  m95('m9.5:migration:verify', 'scripts/m9.5-migration-verify.ts', 'WP4 派生 schema 建/升/失败关闭（D31）'),
  m95('m9.5:lifecycle:verify', 'scripts/m9.5-lifecycle-verify.ts', 'WP5 水位/缺口/重试终态/换代拒混排'),
  m95('m9.5:retrieval:verify', 'scripts/m9.5-retrieval-verify.ts', 'WP6 通道登记如实性 / R3 / D26 / 策略版本'),
  m95('m9.5:hybrid:verify', 'scripts/m9.5-hybrid-verify.ts', 'WP6 真店接线：legacy 缺口 / off 等价 / 保住词面'),
  m95('m9.5:semantic:verify', 'scripts/m9.5-semantic-verify.ts', 'WP6 语义分数真进链路'),
  m95('m9.5:probe:verify', 'scripts/m9.5-probe-verify.ts', 'WP6 探针适配器具名失败 / 只服务已发布代'),
  m95('m9.5:assembly:verify', 'scripts/m9.5-assembly-verify.ts', 'WP6 生产装配：开关缺省 off / 两半同一开关'),
  m95('m9.5:context:verify', 'scripts/m9.5-context-verify.ts', 'WP7 逐层计数守恒（11 条不变式）'),
  m95('m9.5:compat:verify', 'scripts/m9.5-compat-verify.ts', 'WP7/8 §4.4 交给 M10/M11 的稳定边界'),
  m95('m9.5:privacy:verify', 'scripts/m9.5-privacy-verify.ts', 'WP8 无私人文本出站 / 诊断不泄漏 / 查询零写'),
  m95('m9.5:modes:verify', 'scripts/m9.5-modes-verify.ts', 'WP8 off/shadow/on 与失败降级（S46/S47）'),
  m95('m9.5:e2e:verify', 'scripts/m9.5-e2e-verify.ts', 'WP9 真 Gateway 全链'),
  m95('m9.5:scale:verify', 'scripts/m9.5-scale-verify.ts', 'WP9 候选上限 200 实测 / 查询边界 / 时延'),
  {
    id: 'm9.5:long:verify',
    title: 'M9.5 WP9 三条 500 轮离线轨迹',
    argv: tsx('scripts/m9.5-long-verify.ts'),
    entry: 'scripts/m9.5-long-verify.ts',
    resources: { ...M95_EVIDENCE, parallel: 'serial' },
    /*
     * ⚠️ **Round 87 由 `safe` 改 `serial`**：实测在 8 路并发下**阻塞**——
     *    该进程 CPU 曾快速累积到 **845 s**，随后 ~6 分钟只 +27 s（近乎停滞），且**零新增档**；
     *    而它**单独跑**时约 **430 s** 就完成（此前实测）。
     *    ⇒ 它要 **3 条轨迹 × 500 轮**的重 CPU，与另外 7 道门同跑属**资源错配** ⇒ 独占运行。
     */
    why: '3 条 × 500 轮的离线长轨迹；实测并发下阻塞（CPU 近乎停滞）而单独跑 ~430s 完成 ⇒ 必须 serial。',
  },
  m95('m9.5:recovery:verify', 'scripts/m9.5-recovery-verify.ts', 'WP9 故障注入 / 恢复 / 换代回滚'),
  m95('m9.5:quality:verify', 'scripts/m9.5-quality-verify.ts', 'WP10 人审材料：抽样/盲化/五条边界'),
  m95('m9.5:live-judge:verify', 'scripts/m9.5-live-judge.ts', 'WP10 真模型档判定器三控'),
  m95('m9.5:gatelist:verify', 'scripts/m9.5-gatelist-verify.ts', 'WP11 门清单对账：计划 §16.1 vs 实际脚本'),
  {
    id: 'm9.5:embedding:download',
    title: 'M9.5 WP1 安装出站（来源/字节/sha256）',
    argv: [...tsx('scripts/m9.5-embedding.ts'), '--phase', 'download'],
    entry: 'scripts/m9.5-embedding.ts',
    resources: {
      parallel: 'serial',
      evidenceWrites: ['artifacts/m9.5', 'artifacts/m9.5/local/embedding-lab'],
    },
    why: '**出站下载**并写模型目录（`artifacts/m9.5/local/embedding-lab/models`），编码方会读它 ⇒ 与读取方互斥 ⇒ serial。',
  },
  {
    id: 'm9.5:embedding:verify',
    title: 'M9.5 WP1 真实本地编码器（离线边界）',
    argv: [...tsx('scripts/m9.5-embedding.ts'), '--phase', 'verify'],
    entry: 'scripts/m9.5-embedding.ts',
    resources: { ...M95_EVIDENCE },
    why: '只读本地模型目录并编码；只写 artifacts/m9.5/<runId>；不改工作树、不占端口、digestTree 只读（用户裁定甲）。',
  },
  {
    id: 'm9.5:corpus',
    title: 'M9.5 WP2 语料与清单（600 + 200）',
    argv: tsx('scripts/m9.5-corpus.ts'),
    entry: 'scripts/m9.5-corpus.ts',
    resources: {
      parallel: 'serial',
      evidenceWrites: ['artifacts/m9.5', 'evals/m9.5/corpus'],
      mutatesGitWorktree: true,
    },
    why: '**改写 git 工作树**（重生成 evals/m9.5/corpus/dev.jsonl 等**被跟踪**文件）⇒ 必须 serial。',
  },
  {
    id: 'm9.5:a3:download',
    title: 'A3 候选模型下载与校验（来源证据）',
    argv: tsx('scripts/m9.5-a3-download.ts'),
    entry: 'scripts/m9.5-a3-download.ts',
    resources: {
      parallel: 'serial',
      evidenceWrites: ['artifacts/m9.5', 'artifacts/m9.5/local/embedding-lab'],
    },
    why: '写**模型目录**（`artifacts/m9.5/local/embedding-lab/models`），而 `m9.5:a3:arm` 会读它 ⇒ 与读取方互斥 ⇒ serial。',
  },
  {
    id: 'm9.5:aggregator:verify',
    title: '聚合门自检：取档规则两路对账',
    argv: tsx('scripts/m9.5-aggregator-verify.ts'),
    entry: 'scripts/m9.5-aggregator-verify.ts',
    resources: { parallel: 'serial', evidenceWrites: ['artifacts/m9.5'] },
    why: '要在**稳定**档案树上做两路对账（聚合门选择 vs 本门重演）⇒ 并行写档会让它看到变动中的树而误报 ⇒ serial。',
  },
  {
    id: 'm9.5:regression:verify',
    title: 'M9.5 WP11 准入前置门',
    argv: tsx('scripts/m9.5-regression-verify.ts'),
    entry: 'scripts/m9.5-regression-verify.ts',
    resources: {
      parallel: 'serial',
      evidenceWrites: ['artifacts/m9.5', 'artifacts/m5', 'artifacts/m5.5'],
      mutatesGitWorktree: true,
    },
    why: '**改写 git 工作树**（对白名单路径 `git checkout --` 还原被基线子门重生成的历史证据）⇒ 必须 serial。',
  },
]

// ===========================================================================
// M10 保障门链（目标、承诺与持续行为）
// ===========================================================================

/**
 * M10 的门组。
 *
 * ⚠️ **不并入 `OFFLINE_GATES`**：那一组的标题逐字写着"34 条"
 *    （`pnpm m4.5:ci` 的展开），加门会让那句话**当场变假**
 *    ⇒ 另立一组，与 `M9_GATES` / `M95_GATES` 同形。
 *
 * ⚠️ **例外（必须 `serial` 且声明改写工作树）**：`m10:measurement:verify`
 *    是**量具自证三段式** —— 它会**故意注入缺陷到源文件**、跑那道门、
 *    再**字节还原**。因此：
 *      · 必须 `parallel: 'serial'`（不得与其他门并发：别的门可能正在读那个文件）
 *      · 必须声明 `mutatesGitWorktree: true`（它真的会改工作树，哪怕只是一瞬间）
 *      · **不可缓存**（缓存会把"注入态跑出来的 FAIL"或"恢复态的 PASS"当成通用读数）
 */
const M10_EVIDENCE = { ...SAFE_PURE, evidenceWrites: ['artifacts/m10'] } as const

function m10(id: string, script: string, title: string, why?: string): GateSpec {
  return {
    id,
    title,
    argv: tsx(script),
    entry: script,
    resources: { ...M10_EVIDENCE },
    why:
      why ??
      '只写 artifacts/m10/<runId>；零模型 / 零真实库（`m10:test` 用隔离沙箱，其余不碰库）；' +
        '不占端口；**不改写 git 工作树**。',
  }
}

/**
 * M10 的**真模型门**（语义档 + live 档）—— 计划 §16.1 要求「**离线 / 语义 / live 三 lane 分开**」。
 *
 * ⚠️ **有意不并入 `M10_GATES`**：那条 lane 的语义是"**零模型 / 零出网**"
 *    （与 `td` / `m9` / `m9.5` lane 同一条纪律）。
 *
 * ⚠️ **它们真的出站**（语义门一次运行几百次调用；live 门一条 7 轮轨迹）⇒ `parallel: 'serial'`：
 *    与 CPU 密集的门并发会让出站调用互相干扰，读数也难归因。
 *
 * ⚠️ **`--lane all` 会带上它们**（`ALL_GATES` 包含所有 lane）⇒ 那条 lane 必须带包装器，
 *    否则它们**如实拒跑**（exit 2）—— 那是**刻意的**，不是缺陷（见各自的 `why`）。
 *    要跳过：`pnpm gates:run --lane all --skip m10:semantic:eval --skip m10:smoke:live`。
 */
/* ⚠️ WP12 的激活读回（计划 §18.2 三层）：**零模型 / 零出网 / 不打开真实库**
   ⇒ 它属**离线**那一组（`M10_GATES`），不进语义/live lane。 */
const M10_READBACK_GATE: GateSpec = {
  id: 'm10:activation:readback',
  title: 'M10 WP12 激活读回（计划 §18.2 三层：配置 / 装配 / 首次行为）',
  argv: tsx('scripts/m10-activation-readback.ts'),
  entry: 'scripts/m10-activation-readback.ts',
  resources: { ...M10_EVIDENCE, scratchKey: 'm10-readback-pure' },
  why:
    '只写 artifacts/m10/<runId>；**纯进程内**（读 flags + 读源码文本；**零数据库 / 零模型 / 零出网**）；' +
    '不占端口；不改写 git 工作树。⚠️ **它不打开真实库**：开关关着 ⇒ 按定义不可能有目标写入 ' +
    '⇒ 第三层**定义上**就是 `FIRST-USE NOT OBSERVED`（计划 §18.2 逐字），不需要读库即可如实报出；' +
    '开关**开着**时它**如实拒绝**并指出该走哪条路（快照副本 / 带 token 的只读 opener），' +
    '而**不**自己去开 —— 打开真实库是**独立授权**的事。',
}
export const M10_SEMANTIC_GATES: readonly GateSpec[] = [
  {
    id: 'm10:semantic:eval',
    title: 'M10 WP10 语义评估（冻结语料的意图理解 · 真模型 · 量跑次间方差 · 逐案）',
    argv: tsx('scripts/m10-semantic-eval.ts'),
    entry: 'scripts/m10-semantic-eval.ts',
    resources: { parallel: 'serial', evidenceWrites: ['artifacts/m10'] },
    why:
      '只写 artifacts/m10/<runId>；**真的出站**（真模型，一次运行几百次调用）⇒ `serial`；' +
      '**零数据库**（理解层的输入全在内存里 ⇒ 真实库从不被触碰）；不占端口；不改写 git 工作树。' +
      '⚠️ 它**必须**带 `with-test-model` 包装器（缺 `DSH_TEST_MODEL_WRAPPER` 标记即**拒跑**、exit 2）' +
      '⇒ 不带包装器直接跑它会**如实失败**，这是**刻意的**：绝不回落 `.env` 的生产 key。',
  },
  {
    id: 'm10:smoke:live',
    title: 'M10 WP10 小批真实链（真模型 + 有状态脚本轨迹 7 轮 · 隔离库 · 结构不变量）',
    argv: tsx('scripts/m10-smoke-live.ts'),
    entry: 'scripts/m10-smoke-live.ts',
    resources: { parallel: 'serial', evidenceWrites: ['artifacts/m10'] },
    why:
      '只写 artifacts/m10/<runId>；`isolateDatabase()` 一次性沙箱库（**真实库从不被打开** —— ' +
      '`C1` 直接断言库路径落在 %TEMP% 下，不靠"我记得调了它"）；**真的出站**（真模型）⇒ `serial`；' +
      '不占端口；不改写 git 工作树。' +
      '⚠️ 同样**必须**带 `with-test-model` 包装器（缺标记即拒跑、exit 2）。',
  },
  {
    id: 'm10:long:live',
    title: 'M10 WP10 长轨迹真实链（真模型 · 缺省 200 轮 · 收尾 rebuild 对账 · 隔离库）',
    argv: tsx('scripts/m10-long-live.ts'),
    entry: 'scripts/m10-long-live.ts',
    resources: { parallel: 'serial', evidenceWrites: ['artifacts/m10'] },
    why:
      '只写 artifacts/m10/<runId>；`isolateDatabase()` 一次性沙箱库（**真实库从不被打开** —— ' +
      '`C1` 断言库路径在 %TEMP% 下）；**真的出站**（真模型，缺省 **200 轮**）⇒ `serial`；' +
      '不占端口；不改写 git 工作树。收尾做"丢缓存 + 重读 + rebuild"以验**不变量 ②**（投影是派生的）。' +
      '⚠️ 同样**必须**带 `with-test-model` 包装器（缺标记即拒跑、exit 2）。' +
      '⚠️ 零出网的兄弟是 `m10:long:verify`（200/500 轮 + 跨进程重启 + 复活 + 迟到 + 重复）——' +
      '两者**各有归属**：那一条证"时间维度的边"，这一条证"真模型下的长轨迹"。',
  },
  {
    id: 'm10:onpath:live',
    title: 'M10 G-2 开档 live（**生产副本 + 交互式入口**：链真的建了目标 · 负控零事件 · 真实库未变）',
    argv: tsx('scripts/m10-onpath-live.ts'),
    entry: 'scripts/m10-onpath-live.ts',
    resources: { parallel: 'serial', evidenceWrites: ['artifacts/m10'] },
    why:
      '它证的是**接线本身在真装配里可用**：`cpSync` 真实库到 %TEMP%（**真实库从不打开** —— ' +
      '树摘要前后逐字相同是判据之一）；⭐ **入口模式必须走对**：' +
      '`conversationEntryModeOf(argv)` 里**任何位置参数 ⇒ `scripted_agent_runner`**，' +
      '只有**不带位置参数**（交互式 + stdin）才是 `interactive_human_console`，' +
      '而只有那一种入口才把"用户说的"归因给用户 ⇒ 才可能拿到 `ESTABLISHED`。' +
      '⚠️ 正控（开档 ⇒ ≥1 条 `GOAL_CREATED`）+ 负控（关档 ⇒ 0 条）**成对**。' +
      '⚠️ **退出码单列**：管道 stdin 会在流关闭后让 readline 抛 `readline was closed`，' +
      '那是**探针形态**的竞态，不是产品失败 ⇒ 判据按实质（事件数 + 摘要）判。' +
      '⚠️ **必须**带 `with-test-model` 包装器（缺标记即拒跑、exit 2）。',
  },
]

export const M10_GATES: readonly GateSpec[] = [
  {
    id: 'm10:preflight',
    title: 'M10 真模型端点预检（零出网；WP10 的第一个真模型门之前必跑）',
    argv: tsx('scripts/m10-endpoint-preflight.ts'),
    entry: 'scripts/m10-endpoint-preflight.ts',
    /* 它**不写任何证据**（只读 `.env*` 的键名与长度）⇒ 不需要 evidenceWrites */
    resources: { ...SAFE_PURE },
    why:
      '**零出网**、零花费、秒级：只读 `.env*` 的键名与"值是否存在/长度"，' +
      '断言测试端点与模型**都不同于生产**，且本门输出里**不含任何凭据取值**。' +
      '不碰真实库、不占端口、不改写 git 工作树、不写证据。',
  },
  m10('m10:inputs:verify', 'scripts/m10-inputs-verify.ts', 'M10 WP2 来源引用与只读输入'),
  m10('m10:test', 'scripts/m10-test.ts', 'M10 WP3 纯内核与持久化'),
  m10('m10:source:verify', 'scripts/m10-source-verify.ts', 'M10 WP4 语料与语义提案链'),
  m10('m10:invalidation:verify', 'scripts/m10-invalidation-verify.ts', 'M10 WP5 失效 / 遗忘 / 冲突'),
  m10('m10:completion:verify', 'scripts/m10-completion-verify.ts', 'M10 WP6 兑现与回复事实'),
  m10('m10:context:verify', 'scripts/m10-context-verify.ts', 'M10 WP7a 目标上下文段'),
  m10('m10:observability:verify', 'scripts/m10-observability-verify.ts', 'M10 WP7b 可观察面'),
  {
    id: 'm10:scale:verify',
    title: 'M10 WP9-A 规模（G46 按 ID 可读 · 抽样重建 · 跨用户 · U-06 成本曲线）',
    argv: tsx('scripts/m10-scale-verify.ts'),
    entry: 'scripts/m10-scale-verify.ts',
    resources: { ...M10_EVIDENCE, scratchKey: 'm10-scale-isolated-db' },
    why:
      '只写 artifacts/m10/<runId>；`isolateDatabase()` 一次性沙箱库（**真实库从不被打开**）；' +
      '零模型 / 零出网；不占端口；不改写 git 工作树。⚠️ 性能读数只报不设阈值。',
  },
  {
    id: 'm10:regression:verify',
    title: 'M10 回归运行清单/退出码只读核验（计划 §16.1/§16.3）',
    argv: tsx('scripts/m10-regression-verify.ts'),
    entry: 'scripts/m10-regression-verify.ts',
    resources: { ...M10_EVIDENCE },
    why:
      '只写 artifacts/m10/<runId>；**只读** `artifacts/.fast/*/run.json`（别人的运行清单）、' +
      '`docs/m10/M10-Execution-Plan.md`（§16.3 的清单）与 `package.json`（命令是否存在），' +
      '外加 `git`（HEAD/分支）——零数据库 / 零模型 / 零出网；不占端口；不改写 git 工作树。' +
      '⚠️ **不跑任何子门**（`A8` 判结构钉住：每个进程启动调用的第一个实参都必须是 `git`）。',
  },
  {
    id: 'm10:gates',
    title: 'M10 只读证据判定聚合（逐门 PASS/FAIL/NOT RUN/INVALID，计划 §16.1）',
    argv: tsx('scripts/m10-gates.ts'),
    entry: 'scripts/m10-gates.ts',
    resources: { ...M10_EVIDENCE },
    why:
      '只写 artifacts/m10/<runId>；**只读** `artifacts/m10/**` 与 `git`（HEAD/分支）——' +
      '零数据库 / 零模型 / 零出网；不占端口；不改写 git 工作树。' +
      '⚠️ **不隐式跑门**（`A8` 判结构钉住：每个进程启动调用的第一个实参都必须是 `git`）。',
  },
  {
    id: 'm10:activation:verify',
    title: 'M10 激活候选绊线（缺口表 vs 代码实际状态 · 总判一致 · 结论槽不撒谎）',
    argv: tsx('scripts/m10-activation-verify.ts'),
    entry: 'scripts/m10-activation-verify.ts',
    resources: { ...M10_EVIDENCE, scratchKey: 'm10-activation-pure' },
    why:
      '只写 artifacts/m10/<runId>；**只读** `docs/m10/M10-Activation-Candidate.md` 与 ' +
      '`src/kernel/app/flags.ts` / `src/main.ts`（零数据库 / 零模型 / 零出网）；不占端口；不改写 git 工作树。' +
      '⚠️ 它**不**判断 M10 该不该激活（那只属用户授权 `U-01`）。',
  },
  {
    id: 'm10:coverage:verify',
    title: 'M10 WP11 §14 覆盖账（G01–G48 齐不全 · 检查 id 在真实证据里存在 · 未达项有理由）',
    argv: tsx('scripts/m10-coverage-verify.ts'),
    entry: 'scripts/m10-coverage-verify.ts',
    resources: { ...M10_EVIDENCE, scratchKey: 'm10-coverage-pure' },
    why:
      '只写 artifacts/m10/<runId>；**只读** `docs/m10/M10-Scenario-Coverage.md` 与 `artifacts/m10/**`' +
      '（零数据库 / 零模型 / 零出网）；不占端口；不改写 git 工作树。' +
      '⚠️ 它**不**重跑任何门，也**不**主张任何语义结论。',
  },
  {
    id: 'm10:realdb:invariant',
    title: 'M10 L-M10-56 真实库不变量的可诊断读数（连读 N 次 + 逐文件比对）',
    argv: tsx('scripts/m10-realdb-invariant.ts'),
    entry: 'scripts/m10-realdb-invariant.ts',
    /*
     * ⚠️ **必须 `parallel: 'serial'`**：它读的是**真实库**的字节。
     *    它自己不开库、不取租约（只读字节），但**别的门可能正在打开库** ——
     *    而 INC-01 的文档写明"打开会写 pg_control / WAL"。
     *    ⇒ 与任何可能开库的门并发，都会让它的读数在测"别人正在写"而不是"这棵树没变"。
     */
    resources: { ...M10_EVIDENCE, parallel: 'serial', scratchKey: 'm10-realdb-bytes' },
    why:
      '只写 artifacts/m10/<runId>；**只读** `data/pglite` 的字节（**不开库、不取租约、零写入**）；' +
      '零模型 / 零出网；不占端口；不改写 git 工作树。' +
      '⚠️ `serial`：别的门可能正在打开真实库（那会写 pg_control/WAL）。',
  },
  {
    id: 'm10:evidence:verify',
    title: 'M10 WP11 证据档完整性（自洽 · head 可追溯 · FAIL 档有具名解释 · 损坏判定器正负控）',
    argv: tsx('scripts/m10-evidence-verify.ts'),
    entry: 'scripts/m10-evidence-verify.ts',
    /*
     * ⚠️ **必须 `parallel: 'serial'`**：本门**遍历整个 `artifacts/m10/**`**，
     *    而**同一条 lane 里的兄弟门正在并发写那个树**。
     *
     *    真实的失败形态：某个兄弟门刚写完**证据档**、还没写**清单**（我的门都是先写
     *    payload 再 `writeM10Manifest`）⇒ 本门读到那个目录会判"清单缺失 ⇒ INVALID"
     *    ⇒ **一条与产品无关的抖动**。它在首次跑时没出现（时机问题），但那是运气。
     *    ⇒ 独占时段是这条判据唯一正确的声明。
     */
    resources: { ...M10_EVIDENCE, parallel: 'serial', scratchKey: 'm10-evidence-readonly' },
    why:
      '只写 artifacts/m10/<runId>；**只读** `artifacts/m10/**`（零数据库 / 零模型 / 零出网）；' +
      '所有破坏性负控都发生在 `mkdtemp` **副本**里，绝不碰真档案；不占端口；不改写 git 工作树。' +
      '⚠️ `serial`：它遍历的正是兄弟门**正在写**的那棵树。' +
      '⚠️ 它**不**重跑任何门，也**不**主张任何语义结论。',
  },
  {
    id: 'm10:docs:verify',
    title: 'M10 WP11 文档一致性（Known Limitations 不漏/不编/不空洞 · 不出结论数字）',
    argv: tsx('scripts/m10-docs-verify.ts'),
    entry: 'scripts/m10-docs-verify.ts',
    resources: { ...M10_EVIDENCE, scratchKey: 'm10-docs-pure' },
    why:
      '只写 artifacts/m10/<runId>；**纯进程内**（只读 docs/m10/*.md；零数据库 / 零模型 / 零出网）；' +
      '不占端口；不改写 git 工作树。⚠️ 它只核对**文档一致性**，不主张任何语义/人审/live 结论。',
  },
  /* ⚠️ WP12 的激活读回：**零模型 / 零出网 / 不打开真实库** ⇒ 属**离线**这一组 */
  M10_READBACK_GATE,
  {
    id: 'm10:m11:verify',
    title: 'M10 U-12 M11 只读契约（只读面 · 无写原语 · 写入口边界 · 文档一致）',
    argv: tsx('scripts/m10-m11-verify.ts'),
    entry: 'scripts/m10-m11-verify.ts',
    resources: { ...M10_EVIDENCE, scratchKey: 'm10-m11-pure' },
    why:
      '只写 artifacts/m10/<runId>；**纯进程内**（只读源码文本；零数据库 / 零模型 / 零出网）；' +
      '不占端口；不改写 git 工作树。⚠️ 它只核对**只读面的边界**，不总结 M10 成就。',
  },
  {
    id: 'm10:review:materials',
    title: 'M10 U-11 人审材料（盲审卡片无金标 + 独立答案单 + 计分器已知答案自证）',
    argv: tsx('scripts/m10-review-materials.ts'),
    entry: 'scripts/m10-review-materials.ts',
    resources: { ...M10_EVIDENCE, scratchKey: 'm10-review-pure' },
    why:
      '只写 artifacts/m10/<runId>；**纯进程内**（只读冻结语料；零数据库 / 零模型 / 零出网）；' +
      '不占端口；不改写 git 工作树。⚠️ 它只**生成材料**，不主张语义质量。',
  },
  {
    id: 'm10:semantic:dry',
    title: 'M10 WP10 离线干跑（度量机已知答案自证 + 语料驱动真实链的接线）',
    argv: tsx('scripts/m10-semantic-dry.ts'),
    entry: 'scripts/m10-semantic-dry.ts',
    resources: { ...M10_EVIDENCE, scratchKey: 'm10-semdry-isolated-db' },
    why:
      '只写 artifacts/m10/<runId>；`isolateDatabase()` 一次性沙箱库（**真实库从不被打开**）；' +
      '**零模型 / 零出网**（provider 由语料金标驱动）；不占端口；不改写 git 工作树。' +
      '⚠️ 它**不主张语义质量**：证据里 `semanticClaim = none`（机器判据 `D1`）。',
  },
  {
    id: 'm10:oracle:verify',
    title: 'M10 U-14 折叠 oracle（声明式转移表 vs 命令式 reducer 的等价对照）',
    argv: tsx('scripts/m10-oracle-verify.ts'),
    entry: 'scripts/m10-oracle-verify.ts',
    resources: { ...M10_EVIDENCE, scratchKey: 'm10-oracle-pure' },
    why:
      '只写 artifacts/m10/<runId>；**纯进程内**（零数据库 / 零模型 / 零出网）；' +
      '不占端口；不改写 git 工作树。',
  },
  {
    id: 'm10:gateway:verify',
    title: 'M10 U-20 网关注入（不接端口零变化 · 两条 section · 五个 trace 读数）',
    argv: tsx('scripts/m10-gateway-verify.ts'),
    entry: 'scripts/m10-gateway-verify.ts',
    resources: { ...M10_EVIDENCE, scratchKey: 'm10-gateway-isolated-db' },
    why:
      '只写 artifacts/m10/<runId>；`isolateDatabase()` 一次性沙箱库（**真实库从不被打开**）；' +
      '零模型（只调 beginTurn/compileTurn/completeTurn，不生成回复）/ 零出网；' +
      '不占端口；不改写 git 工作树。',
  },
  {
    id: 'm10:long:verify',
    title: 'M10 WP9-B 时间维度（200 轮轨迹 · 重启 · 复活 · 迟到 · 重复 · 零分母）',
    argv: tsx('scripts/m10-long-verify.ts'),
    entry: 'scripts/m10-long-verify.ts',
    resources: { ...M10_EVIDENCE, scratchKey: 'm10-long-isolated-db' },
    why:
      '只写 artifacts/m10/<runId>；`isolateDatabase()` 一次性沙箱库（**真实库从不被打开**）；' +
      '零模型 / 零出网；不占端口；不改写 git 工作树。',
  },
  {
    id: 'm10:e2e:verify',
    title: 'M10 WP8b 端到端（隔离库 + 离线 provider + 唯一编排入口）',
    argv: tsx('scripts/m10-e2e-verify.ts'),
    entry: 'scripts/m10-e2e-verify.ts',
    resources: { ...M10_EVIDENCE, scratchKey: 'm10-e2e-isolated-db' },
    why:
      '只写 artifacts/m10/<runId>；`isolateDatabase()` 一次性沙箱库（**真实库从不被打开**，' +
      '因此 **不**声明 `realDb`）；零模型 / 零出网；不占端口；不改写 git 工作树。' +
      '`scratchKey` 表明它独占自己的沙箱目录（与其他门不共享 scratch）。',
  },
  {
    id: 'm10:measurement:verify',
    title: 'M10 WP8 量具自证（正控 / 负控 / 恢复 三段式）',
    argv: tsx('scripts/m10-measurement-verify.ts'),
    entry: 'scripts/m10-measurement-verify.ts',
    resources: {
      parallel: 'serial',
      mutatesGitWorktree: true,
      evidenceWrites: ['artifacts/m10'],
    },
    why:
      '**改写 git 工作树**：它把一处**具名缺陷**注入源文件、跑那道门、再按 sha256 字节还原。' +
      '⇒ 必须 serial（别的门可能正在读那个文件）；**不可缓存**（缓存会把注入态或恢复态的读数当通用结果）。',
  },
]

// ===========================================================================
// 「记忆体量」（Memory Coverage）—— D-6 裁定的那条线（2026-09-30）
// ===========================================================================

/**
 * 只写 `artifacts/memory-coverage/<runId>`；**不开任何数据库**（构造属性）；
 * 零模型 / 零出网；不占端口；不改写 git 工作树。
 *
 * ⚠️ 与 `M9_GATES` / `M95_GATES` / `M10_GATES` 同形：**有意不并入 `offline` lane**
 *    —— 那条 lane 的公开声明是「与 `pnpm m4.5:ci` 逐条等价」，加门会让声明变假。
 */
const MC_EVIDENCE = { ...SAFE_PURE, evidenceWrites: ['artifacts/memory-coverage'] } as const

/**
 * WP4 的写读档写在**自己的子根**（`artifacts/memory-coverage/e2e/`）⇒ 与 WP0 量具的档不混。
 * ⚠️ 它**会开数据库**，但只开 `%TEMP%` 下的一次性沙箱（`isolateDatabase`）——
 *    **真实库从未被打开**（`isProductionDir()` 硬拦重叠）。
 */
const MC_E2E_EVIDENCE = {
  ...SAFE_PURE,
  evidenceWrites: ['artifacts/memory-coverage/e2e'],
} as const

/**
 * 取值边界线的档写在**自己的根**（`artifacts/extractor-value-boundary/`）——
 * 它是**另一条线**（ADR-056 / ADR-080），与「记忆体量」的档不混。
 * ⚠️ 它**不打开数据库**（构造属性：只 import 抽取器）。
 */
const MC_VALUE_EVIDENCE = {
  ...SAFE_PURE,
  evidenceWrites: ['artifacts/extractor-value-boundary'],
} as const

export const MC_GATES: readonly GateSpec[] = [
  {
    id: 'memory-coverage:verify',
    title: '「记忆体量」WP0 覆盖率量具（哪一道闸门挡下了这句话）',
    argv: tsx('scripts/memory-coverage-verify.ts'),
    entry: 'scripts/memory-coverage-verify.ts',
    resources: { ...MC_EVIDENCE },
    why:
      '只写 artifacts/memory-coverage/<runId>；**不 import 任何数据库入口**（构造属性 ⇒ 真实库' +
      '从未被打开，也**不**声明 realDb）；只 import 纯函数 / 纯数据模块（intent-detector / ' +
      'content-extractor / memory-predicates）⇒ 零模型 / 零出网 / 不占端口 / 不改写 git 工作树。' +
      '⚠️ 它**只读**语料（evals/memory-coverage/corpus/**），不写语料 ⇒ 不 `mutatesGitWorktree`。',
  },
  {
    id: 'memory-coverage:e2e',
    title: '「记忆体量」WP4 端到端写读（Level 2：账本 / 事件）',
    argv: tsx('scripts/memory-coverage-e2e.ts'),
    entry: 'scripts/memory-coverage-e2e.ts',
    resources: { ...MC_E2E_EVIDENCE },
    why:
      '只写 artifacts/memory-coverage/e2e/<runId>；**每个语料条目一个 `%TEMP%` 一次性沙箱**' +
      '（`isolateDatabase` + `resetPluginSqlConnection`；`isProductionDir()` 硬拦真实库重叠）' +
      '⇒ **真实库从未被打开**，因此**不**声明 `realDb`。零模型（`replyText` 是 fixture）/ 零出网 / ' +
      '不占端口 / 不改写 git 工作树。⚠️ 它比量具慢（46 次建库），但仍属秒级~分钟级。',
  },
  {
    id: 'extractor:value-boundary:verify',
    title: 'M9.7 取值边界线：一个虚词/疑问词不是一个取值（+ 尾部填充语 + 回接正控）',
    argv: tsx('scripts/extractor-value-boundary-verify.ts'),
    entry: 'scripts/extractor-value-boundary-verify.ts',
    resources: { ...MC_VALUE_EVIDENCE },
    why:
      '只写 artifacts/extractor-value-boundary/<runId>；**不 import 任何数据库入口**（构造属性 ⇒ ' +
      '真实库从未被打开，也**不**声明 realDb）；只 import 抽取器（纯函数）⇒ 零模型 / 零出网 / ' +
      '不占端口 / 不改写 git 工作树。⚠️ 与 `memory-coverage:verify`（可达性）与 `memory-coverage:e2e`' +
      '（写读）**分工不重叠**：它只管**取值这一层**。',
  },
]

/** M11.1 controls only. Historical baseline, formal models and the refusing aggregate are separate. */
export const M111_GATES: readonly GateSpec[] = [
  ['m11.1:wiring:verify', 'scripts/m11.1-wiring-verify.ts'],
  ['m11.1:recovery:verify', 'scripts/m11.1-recovery-verify.ts'],
  ['m11.1:e2e:verify', 'scripts/m11.1-e2e-verify.ts'],
  ['m11.1:measurement:verify', 'scripts/m11.1-measurement-verify.ts'],
  ['m11.1:batch:verify', 'scripts/m11.1-model-batch-verify.ts'],
  ['m11.1:behavior:control', 'scripts/m11.1-behavior-collect.ts'],
  ['m11.1:gates:verify', 'scripts/m11.1-gates-verify.ts'],
  ['m11.1:privacy-performance:verify', 'scripts/m11.1-privacy-performance.ts'],
  ['m11.1:source:verify', 'scripts/m11.1-source-matrix.ts'],
].map(([id, entry]) => ({ id: id!, title: id!, entry: entry!,
  argv: [...tsx(entry!), ...(id === 'm11.1:behavior:control' ? ['--control'] : [])],
  tags: ['m11.1'], resources: { parallel: 'serial', evidenceWrites: ['artifacts/m11.1'] },
  why: 'Isolated controls, shared evidence parent. Production-profile performance uses a filesystem copy; serial execution keeps its timing interpretable. No live model or historical baseline rerun.' }))

// ===========================================================================
// 一一、M9.6 / post-Lv2(S8) / Lv2 的离线门（2026-10-04 · A-3 登记）
// ===========================================================================
/**
 * 这三组此前**不在任何 lane 里** ⇒ `pnpm fast` / `--lane affected` 带不出它们，
 * 只能靠人记住命令（登记册 §0p 记的正是这类"接收停摆"）。
 *
 * 并发属性按本文件开头的纪律逐条判定（2026-10-04 逐文件核过）：
 *   · 只用自己的 `%TEMP%` 一次性沙箱；`data/pglite` 只出现在"从不打开真实库"的断言/注释里
 *     （例：`postlv2-s8-store-verify.ts:17/633/649/683`）；
 *   · **零出网**：`m9.6:test` / `m9.6:audit-parser:verify` 里的 `fetch` 全是注入的**替身**
 *     （`makeFetch`），实测真实出站 0；
 *   · 证据写在各自里程碑根（`artifacts/m9.6` / `artifacts/post-lv2` / `artifacts/lv2`）
 *     ⇒ 与 `M95_GATES` 同一现状：**同里程碑内的门不会彼此并发**（共享证据父目录被判冲突）。
 *     这是"宁可慢"的保守选择；要真并发需先把证据布局改成每门一个子根（同 `L-M95-24`）。
 */
export const M96_GATES: readonly GateSpec[] = [
  {
    id: 'm9.6:test',
    title: 'M9.6 契约 / 编排离线门',
    argv: tsx('scripts/m9.6-test.ts'),
    entry: 'scripts/m9.6-test.ts',
    tags: ['m9.6'],
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m9.6/contract-tests.json'] },
    why: '只写自己那份固定证据文件（无时钟字段 ⇒ 重复运行逐字节相同）；不起数据库、零出网（fetch 全是替身）、不改写工作树。',
  },
  {
    id: 'm9.6:measurement:verify',
    title: 'M9.6 量具有效性（伪通过负控 · 分母纪律）',
    argv: tsx('scripts/m9.6-measurement-verify.ts'),
    entry: 'scripts/m9.6-measurement-verify.ts',
    tags: ['m9.6'],
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m9.6/measurement.json'] },
    why: '只写自己那份固定证据文件；纯计算 + 注入的错公式，不起数据库、零出网、不改写工作树。',
  },
  {
    id: 'm9.6:audit-parser:verify',
    title: 'M9.6 WP0a 判定器（四态 · 17 码 · 负控复刻旧解析器）',
    argv: tsx('scripts/m9.6-audit-parser-verify.ts'),
    entry: 'scripts/m9.6-audit-parser-verify.ts',
    tags: ['m9.6'],
    resources: { ...SAFE_PURE, evidenceWrites: ['artifacts/m9.6/audit-parser.json'] },
    why: '只写自己那份固定证据文件；`fetchImpl` 全部是替身（真实出站 0）；不起数据库、不改写工作树。',
  },
]

/** S8（storyline 认知）的离线门。**真模型档**（`postlv2:s8:semantic:eval`）与**真库档**（`*:activation-readback:db`）**不在其中**。 */
export const PL2_GATES: readonly GateSpec[] = [
  ...([
  ['postlv2:s8:store:verify', 'scripts/postlv2-s8-store-verify.ts'],
  ['postlv2:s8:contracts:verify', 'scripts/postlv2-s8-contracts-verify.ts'],
  ['postlv2:s8:roots:verify', 'scripts/postlv2-s8-roots-verify.ts'],
  ['postlv2:s8:state:verify', 'scripts/postlv2-s8-state-verify.ts'],
  ['postlv2:s8:reflection:verify', 'scripts/postlv2-s8-reflection-verify.ts'],
  ['postlv2:s8:lifecycle:verify', 'scripts/postlv2-s8-lifecycle-verify.ts'],
  ['postlv2:s8:measurement:verify', 'scripts/postlv2-s8-measurement-verify.ts'],
  ['postlv2:s8:production:verify', 'scripts/postlv2-s8-production-verify.ts'],
  ['postlv2:s8:withdraw:verify', 'scripts/postlv2-s8-withdraw-verify.ts'],
  ['postlv2:db:verify', 'scripts/postlv2-db-verify.ts'],
] as [string, string][]).map(([id, entry]) => ({
  id,
  title: id,
  entry,
  argv: tsx(entry),
  tags: ['post-lv2'],
  resources: { parallel: 'serial' as const, evidenceWrites: ['artifacts/post-lv2'] },
  why:
    '隔离库（`isolateDatabase()` 一次性 %TEMP% 沙箱）+ 零模型；证据写在共享里程碑根 ⇒ 按 manifest 纪律保守声明 serial。' +
    '⚠️ `postlv2:db:verify` 只读**已落盘**的 artifact 快照（不打开真实库）。',
  })),
  /*
   * ⚠️ **2026-10-13 追加 1 道**（多用户补充计划 X0/U1 / `ADR-133` `ACCEPTED / DESIGN FROZEN`）：
   * 作用域契约的**纯判定门**。它只核对契约层（矩阵完整性 / 每个具名拒绝码可复现 /
   * 拆掉身份核查必须判红并恢复 / 裁定门槛的严格大于语义 / 可见性铁律）。
   * ⚠️ **不**主张接线、不主张运行时隔离、不打开任何库。
   */
  {
    id: 'u1:scope:verify',
    title: 'U1 作用域契约（权限矩阵 · 可见性 · 裁定门槛；纯判定）',
    argv: tsx('scripts/u1-scope-contract-verify.ts'),
    entry: 'scripts/u1-scope-contract-verify.ts',
    tags: ['post-lv2', 'u1'],
    resources: { parallel: 'safe' as const },
    why:
      '**纯进程内**：只读 `src/kernel/contracts/scope.ts` 的纯函数；零数据库 / 零模型 / 零出网 / 不占端口 / 不写证据 / 不改工作树。' +
      '三段式：正控（该放行的格放行）+ 负控（**每个具名拒绝码都可复现**）+ 拆掉身份核查必须判红、恢复后正控再次通过。' +
      '⚠️ 它**只**核对契约判定：不主张身份解析/读取面过滤/RLS 已接线，也不主张多用户隔离已就绪。',
  },
  {
    id: 'u1:identity:verify',
    title: 'U1 逐消息身份解析（平台账号唯一依据 · 不回退为原主人；纯判定）',
    argv: tsx('scripts/u1-inbound-identity-verify.ts'),
    entry: 'scripts/u1-inbound-identity-verify.ts',
    tags: ['post-lv2', 'u1'],
    resources: { parallel: 'safe' as const },
    why:
      '**纯进程内**：只读 `src/kernel/identity/inbound-identity.ts` 的纯函数；零数据库 / 零模型 / 零出网 / 不占端口 / 不写证据 / 不改工作树。' +
      '三段式：正控（含"同一 QQ 跨私聊与两群 = 同一 userId"）+ 负控（**每个具名拒绝码都可复现**）+ ' +
      '拆掉账号比对的弱化解析器必须把陌生人当主人（证明防线在被量）。' +
      '⚠️ 它**只**核对解析判定：不主张入口已接线（WP2b）、不主张任何生产开通。',
  },
  {
    id: 'u1:identity-store:verify',
    title: 'U1 身份解析读写链（映射表 · 幂等建档 · 并发首次消息只有一行）',
    argv: tsx('scripts/u1-identity-store-verify.ts'),
    entry: 'scripts/u1-identity-store-verify.ts',
    tags: ['post-lv2', 'u1'],
    resources: { parallel: 'serial' as const, evidenceWrites: ['artifacts/post-lv2'] },
    why:
      '隔离库（`isolateDatabase()` 一次性 %TEMP% 沙箱；`data/pglite` **从不被打开**）+ 零模型 / 零出网。' +
      '三段式：正控（首见幂等建档 / 重复解析不新建 / 同一账号跨群同一 userId / 原主人识别）+ ' +
      '负控（**每条拒绝路径都不写任何行**；G14 的并发首次消息 ×8 ⇒ 映射**恰好 +1 行**）+ ' +
      '拆防线（白名单恒真 ⇒ 会真的为陌生账号建档）+ 恢复。' +
      '⚠️ 证据写共享里程碑根 ⇒ 保守声明 serial。⚠️ 它**不**接线入口：生产链路仍只接本人私聊。',
  },
  {
    id: 'u1:recorder-identity:verify',
    title: 'U1 录制器逐消息身份（现状回归 · 不回退为单用户 · 三处失败关闭 · 拆防线判红）',
    argv: tsx('scripts/u1-recorder-identity-verify.ts'),
    entry: 'scripts/u1-recorder-identity-verify.ts',
    tags: ['post-lv2', 'u1'],
    resources: { parallel: 'serial' as const, evidenceWrites: ['artifacts/post-lv2'] },
    why:
      '隔离库（`isolateDatabase()` 一次性 %TEMP% 沙箱；`data/pglite` **从不被打开**）+ 零模型 / 零出网。' +
      '正控（不给身份 ⇒ 与今天逐字节相同；给身份 ⇒ 按平台账号解析、事件 actor 正确、跨会话同一 userId）+ ' +
      '负控（**三处失败关闭都不回退**：缺解析器 / 空账号 / 空 userId）+ 拆防线（忽略平台账号 ⇒ 陌生人被记成主人）+ 恢复。' +
      '⚠️ `.env` 为 postgres 后端时本门**具名 NOT RUN**（目录沙箱要求 PGlite）。' +
      '⚠️ 它**不**接线生产入口：装配层（main.ts）本轮一字未改。',
  },
  {
    id: 'u1:new-user-relationship:verify',
    title: 'U1 新用户初始关系（WP3 / ADR-136 方案 A：0.2/0.2 + NEW_USER_BASELINE · 原主人路径不变 · 幂等）',
    argv: tsx('scripts/u1-new-user-relationship-verify.ts'),
    entry: 'scripts/u1-new-user-relationship-verify.ts',
    tags: ['post-lv2', 'u1'],
    resources: { parallel: 'serial' as const },
    why:
      '隔离库（`isolateDatabase()` 一次性 %TEMP% 沙箱；`data/pglite` **从不被打开**）+ 零模型 / 零出网。' +
      '正控（新用户 = 0.2/0.2 + `NEW_USER_BASELINE` + originated；**原主人仍是 0.85/0.60 + `SETTING_BASELINE`**；两份投影互不影响）+ ' +
      '负控（重复播种 no-op、revision 不变 ⇒ 不重置）+ 拆防线（**用原主人播种器建新用户 ⇒ 读数真的会错**）+ 恢复 + ' +
      '契约闭集（五值**具名**、`MAINTENANCE_INJECTION` 仍失败关闭）。' +
      '⚠️ `.env` 为 postgres 后端时本门**具名 NOT RUN**。⚠️ 它只证"播种器的值/来源/幂等"：**不**接线（谁何时调它属 WP2b-2b）。',
  },
  {
    id: 'u1:record-scope:verify',
    title: 'U1 记录作用域标签（WP4 / ADR-137 方案 B：迁移 0019 · 写一次 · 保守缺省 · 库层 CHECK · 不回填）',
    argv: tsx('scripts/u1-record-scope-verify.ts'),
    entry: 'scripts/u1-record-scope-verify.ts',
    tags: ['post-lv2', 'u1'],
    resources: { parallel: 'serial' as const },
    why:
      '隔离库（`isolateDatabase()` 一次性 %TEMP% 沙箱；`data/pglite` **从不被打开**）+ 零模型 / 零出网。' +
      '正控（表/列齐 · schema=19 · 写读一致 · 缺标签被如实列出）+ ' +
      '负控（**写一次**：重复写不改原标签 · 缺标签 ⇒ `private_to_origin`+`labelMissing` · ' +
      '**库层 CHECK 拒绝五类非法行**（绕过应用层直接插）· 应用层也拒）+ ' +
      '拆防线（把缺省换成 `public_to_room` 必须与真实判定不同）+ 恢复 + ' +
      '**迁移只建表**（事后标签表为空 ⇒ 不给旧记录回填 origin）。' +
      '⚠️ 它只证**标签的存取与缺省**：读取面（召回/候选/输出）**尚未**按它过滤（那是 WP5）。',
  },
  {
    id: 'u1:record-visibility:verify',
    title: 'U1 记录可见性判定（WP5 判定核心：授权 × 归属披露 · 缺标签保守 · 特权独立带审计）',
    argv: tsx('scripts/u1-record-visibility-verify.ts'),
    entry: 'scripts/u1-record-visibility-verify.ts',
    tags: ['post-lv2', 'u1'],
    resources: { parallel: 'safe' as const },
    why:
      '**纯进程内**：只读 `src/kernel/contracts/record-visibility.ts`（以及它组合的 scope 判定）；' +
      '零数据库 / 零模型 / 零出网 / 不占端口 / 不写证据 / 不改工作树。' +
      '正控（自己私聊来源 · 同群公开 · **特权通路带审计** · 内部认知走 `internal_cognition_read`）+ ' +
      '负控（他人私聊来源 · 跨群 · 私聊里读群资料 · 显式分享条件不满足 · 群未授权 · 用途不对 · `character_internal` 不回吐原文）+ ' +
      '**缺标签保守性专项**（本人可读但 `labelMissing=true`；他人/群来源一律拒）+ 矩阵格派生（五条）+ 拆防线（缺标签当"同群可见"必与真实判定相反）。' +
      '⚠️ 它只证**判定**：今天**没有任何读取面**接线；`explicit_shared` 的放宽按 `ADR-137` `R-WP4-2` 已推迟（今天拒、失败关闭）。',
  },
  {
    id: 'u1:authorized-candidates:verify',
    title: 'U1 授权前置过滤（G18 / ADR-138：filter→slice 而不是 slice→filter · 缺标签缺省=原主人私聊）',
    argv: tsx('scripts/u1-authorized-candidates-verify.ts'),
    entry: 'scripts/u1-authorized-candidates-verify.ts',
    tags: ['post-lv2', 'u1'],
    resources: { parallel: 'serial' as const },
    why:
      '隔离库（`isolateDatabase()` 一次性 %TEMP% 沙箱；`data/pglite` **从不被打开**）+ 零模型 / 零出网。' +
      '正控（越权候选**占满前缀**时合法记录仍被选出 · `limit` 被填满 · 返回**同序** · `denied`/`deniedForMissingLabel` 如实 · 留痕不记正文）+ ' +
      '负控（**拆防线**：`slice(2)→filter` 得 0 条 vs `filter→slice(2)` 得 2 条 ⇒ 次序就是被量的那件事 · ' +
      '缺标签对普通用户拒/对**原主人**可见 · 群未授权不可见）+ 恢复 + 空候选边界。' +
      '⚠️ 本门**不**关闭 `G18`：读取面尚未接线（截断仍在 `memory-retrieval-store.ts:345-348`）。' +
      '⚠️ `.env` 为 postgres 后端时本门**具名 NOT RUN**。',
  },
  {
    id: 'u1:g18-wiring:verify',
    title: 'U1 G18 接线（ADR-138：召回**截断之前**先过授权 · 不注入即逐字不变）',
    argv: tsx('scripts/u1-g18-wiring-verify.ts'),
    entry: 'scripts/u1-g18-wiring-verify.ts',
    tags: ['post-lv2', 'u1'],
    resources: { parallel: 'safe' as const },
    why:
      '**纯进程内**：被测对象是**真的** `createMemoryRetrievalStore({ authorizeCandidates })` 的截断路径；' +
      '数据面用夹具 store（合成记录）⇒ 候选集合可控；零数据库 / 零模型 / 零出网 / 不占端口 / 不写证据。' +
      '正控（注入后越权候选**不占名额** · `limit` 被填满 · `authorization` 计数如实 · **同序**）+ ' +
      '负控（**不注入 ⇒ 取到最新两条且 `authorization` 字段不出现** —— 形状逐字不变 · ' +
      '**拆防线：先截断后过滤得 0 条 vs 新次序得 2 条** · 授权器"全放行" ⇒ 又回到最新两条）+ 恢复。' +
      '⚠️ 本门**不**代表 `G18` 在生产已关闭：装配处（`main.ts` 召回装配）**尚未**注入授权器。',
  },
  {
    id: 'u1:entry-scope:verify',
    title: 'U1 入口作用域（入口 ⇒ 作用域三元组 · 身份不明/群无名一律失败关闭 · 缺省来源域=原主人私聊）',
    argv: tsx('scripts/u1-entry-scope-verify.ts'),
    entry: 'scripts/u1-entry-scope-verify.ts',
    tags: ['post-lv2', 'u1'],
    resources: { parallel: 'safe' as const },
    why:
      '**纯进程内**：只读 `src/kernel/identity/entry-scope.ts`；零数据库 / 零模型 / 零出网 / 不占端口 / 不写证据。' +
      '正控（四种入口各自的作用域：私聊主人 / 私聊普通用户 / 本机入口 / 群）+ ' +
      '**失败关闭五条**（身份解析不出 · 空白身份 · 群无 groupId · 群内身份不明 · 取不到原主人 id）+ ' +
      '群 ≠ 私聊（原主人在群里 room 仍是那个群；未授权如实传 false）+ 缺省来源域恒为原主人私聊 + ' +
      '拆防线（"身份不明当作原主人"必与真实判定相反）+ 入口闭集自检。' +
      '⚠️ 本门**不**代表生产入口已接线：`main.ts` 仍未调用它。',
  },
  {
    id: 'u1:gateway-scope:verify',
    title: 'U1 网关作用域端到端（真 TurnGateway 一轮 ⇒ 检索端口真的收到 query.scope；不传即 undefined）',
    argv: tsx('scripts/u1-gateway-scope-verify.ts'),
    entry: 'scripts/u1-gateway-scope-verify.ts',
    tags: ['post-lv2', 'u1'],
    resources: { parallel: 'serial' as const },
    why:
      '隔离库（`isolateDatabase()` 一次性 %TEMP% 沙箱）+ **真 `TurnGateway`**（`beginTurn → compileTurn`；' +
      '**不调 `completeTurn`** ⇒ 零模型 / 零出网）+ 真召回服务 + **间谍检索端口**（只记 `query.scope`，不碰真库）。' +
      '正控（传了 `scope` ⇒ 端口看到的 `query.scope` **逐字相同**）+ 负控（**不传 ⇒ `undefined`**，不是空对象/默认作用域 —— 接线前逐字相同）+ ' +
      '拆防线（"不传就补一个原主人作用域"会凭空造出授权上下文，与真实读数相反）。' +
      '⚠️ 本门只证"网关把 scope 传下去了"：`main.ts` **仍未设置该选项** ⇒ 生产行为一字未变。',
  },
  {
    id: 'u1:inbound-turn-scope:verify',
    title: 'U1 入站消息 ⇒ 本轮作用域（WP2b-2b 核心：平台事实 → 身份解析 → 入口作用域 · 失败关闭 · 幂等不改绑）',
    argv: tsx('scripts/u1-inbound-turn-scope-verify.ts'),
    entry: 'scripts/u1-inbound-turn-scope-verify.ts',
    tags: ['post-lv2', 'u1'],
    resources: { parallel: 'serial' as const },
    why:
      '隔离库（真身份映射表；`data/pglite` 从不被打开）+ 零模型 / 零出网。' +
      '正控（私聊原主人 ⇒ owner · 私聊陌生但获准 ⇒ user · 群消息 ⇒ room 是那个群且未授权如实传 false）+ ' +
      '负控（**没有平台账号证据 ⇒ 不给 scope** · 未获准 ⇒ 失败关闭且**不建档** · 群号出现在私聊里 ⇒ 具名拒绝）+ ' +
      '幂等（重复解析 `boundFirstTime=false` 且**不改绑**）+ 缺省来源域恒为原主人私聊 + 拆防线（把"解析失败"补成原主人必与真实读数相反）。' +
      '⚠️ 本门只证"这一层翻译得对"：`main.ts` **仍未调用它**（生产未接线）。',
  },
  {
    id: 'u1:main-wiring:verify',
    title: 'U1 main.ts 接线（G18 生产接线点存在性 + **量具有效性**：四处削弱必须各判红）',
    argv: tsx('scripts/u1-main-wiring-verify.ts'),
    entry: 'scripts/u1-main-wiring-verify.ts',
    tags: ['post-lv2', 'u1'],
    resources: { parallel: 'safe' as const },
    why:
      '**结构判据（text-lock）**，但按"量具有效性"写：① 真实 `src/main.ts` ⇒ 0 违规；' +
      '② **四处人为削弱**（对所有入口给 scope / 掐掉网关转交 / 授权器永远放行 / 失败关闭改成放行全部）' +
      '各跑一次 ⇒ **必须每次判红且红的正是那一条**。只有 ② 全过，① 才有信息量。' +
      '⚠️ 它**只证接线点在**，**不证行为**；行为读数（真会话走一轮看召回是否按作用域过滤）**未取得**。',
  },
  {
    id: 'u1:write-path-labeling:verify',
    title: 'U1 写入侧打标（ADR-137 写侧：新记忆写下时按**本轮房间**打归属 · 写一次 · 无作用域即 no-op）',
    argv: tsx('scripts/u1-write-path-labeling-verify.ts'),
    entry: 'scripts/u1-write-path-labeling-verify.ts',
    tags: ['post-lv2', 'u1'],
    resources: { parallel: 'serial' as const },
    why:
      '隔离库（真标签表；`data/pglite` 从不被打开）+ 零模型 / 零出网。' +
      '正控（私聊 ⇒ 来源域=那个人 · **群 ⇒ 来源域=那个群** · `labeled_by` 记写侧标记）+ ' +
      '负控（**没有作用域 ⇒ 完全 no-op**、标签表里没有那一行 ⇒ 不编来源域 · 空 memoryId 不打）+ ' +
      '写一次（重复打标 `already_labeled` 且原标签逐字不变）+ ' +
      '**收益**（打完标的记录经授权过滤器读回：来源域本人读得到、旁人读不到）+ ' +
      '拆防线（硬编码"原主人私聊"会把群来源记错 ⇒ 可判红）。' +
      '⚠️ `main.ts` 是否调用它由 `u1:main-wiring:verify`（结构判据）守。',
  },
  {
    id: 'u1:bridge-facts:verify',
    title: 'U1 / ADR-139：桥上的入站平台事实（闭集形状 · 具名拒绝 · 缺席逐字旧行为）',
    argv: tsx('scripts/u1-bridge-platform-facts-verify.ts'),
    entry: 'scripts/u1-bridge-platform-facts-verify.ts',
    tags: ['post-lv2', 'u1'],
    resources: { parallel: 'safe' as const },
    why:
      '**纯进程内**（真 `TurnBridge` + 桩 host）：零数据库 / 零模型 / 零出网 / 不占端口 / 不写证据。' +
      '正控（合法 private / 合法 group ⇒ 合法；合法 facts 的轮次真的回；缺席 facts 照常回）+ ' +
      '负控（未知键 / 未知 transport / 空 selfId / 空 senderUserId / 未知 messageType / private 带 groupId / ' +
      'group 缺 groupId / null / 数组 / 字符串 **逐条具名判红**，且非法 facts 的轮次 **host.runTurn 一次都不跑**）+ 恢复。' +
      '⚠️ 它**只**守这一格的形状与拒绝语义（`ADR-139` `D01`/`D04`）：' +
      '非原主人私聊未开放（`R-139-3` = ①，本切片 owner-only），核心侧"谁消费它、怎么算 scope"是下一包。',
  },
  {
    id: 'u1:completion:verify',
    title: 'U1 实库房间隔离、非旁路 RLS、后台归因和印象阈值',
    argv: tsx('scripts/u1-completion-verify.ts'),
    entry: 'scripts/u1-completion-verify.ts',
    tags: ['post-lv2', 'u1'],
    resources: { parallel: 'serial' as const },
    why: '固定 PGlite 沙箱；真存储/事务和无旁路角色，零外部模型，零生产连接。',
  },
  {
    id: 'qq:group:verify',
    title: 'G1 真桥/核心群聊隔离与成员撤销整链',
    argv: tsx('scripts/qq/group-verify.ts'),
    entry: 'scripts/qq/group-verify.ts',
    tags: ['post-lv2', 'u1', 'qq'],
    resources: { parallel: 'serial' as const },
    why: '本地临时 OneBot/模型端口、人工账号、真 main.ts 子进程和隔离数据库；真实 QQ/外部模型未运行。',
  },
  {
    id: 'qq:group:coexist:verify',
    title: 'G1 共存连接：群聊矩阵与皮套主人具名查询',
    argv: [...tsx('scripts/qq/group-verify.ts'), '--coexist'],
    entry: 'scripts/qq/group-verify.ts',
    tags: ['post-lv2', 'u1', 'qq'],
    resources: { parallel: 'serial' as const },
    why: '复用群夹具；真 --coexist 核心、两个临时 TCP 端口和单一隔离库；不启停生产服务。',
  },
  {
    id: 'postlv2:s8:start:verify',
    title:
      'S8 显式开局入口（`L-S8-30` 入口侧：正控 / 幂等 / 单活跃 run 负控 / 形状负控 / 终局后恢复）',
    argv: tsx('scripts/postlv2-s8-start-verify.ts'),
    entry: 'scripts/postlv2-s8-start-verify.ts',
    tags: ['post-lv2'],
    resources: { parallel: 'serial' as const, evidenceWrites: ['artifacts/post-lv2'] },
    why:
      '隔离库（`isolateDatabase()` 一次性 %TEMP% 沙箱）+ **零模型 / 零出网**（开局是程序提交、绑定 `system`，与模型提案无关）。' +
      '⚠️ **主张只挂在账本读数上**（S1–S5）；S6 是"装配在场"的文本锁，**明确不作为主张** —— ' +
      '文本锁测不到"入口有没有被真的调用"，而那正是 `L-S8-30` 立案的形状（`ADR-107` §2.5(1) / `R-4c`）。' +
      '⚠️ `notCovered` 逐条写进证据：`ingestChoice` 的生产调用者 · 每轮消费点（`R-3b`）· 端到端"入口缺席负控"（`R-4c` 三段式）**都未做**。',
  },
  /*
   * ⚠️ **2026-10-05 追加**（`ADR-107` `R-1b`）：候选 `choiceId` 的产出面。
   * 主张挂在**账本读数**与**私有端口调用计数**上；真实模型的解析质量**不在**本门内（见 `notCovered`）。
   */
  {
    id: 'postlv2:s8:choice:verify',
    title:
      'S8 剧情选择解析（`R-1b`：正控 / 开关负控 / 无活跃 run 零调用 / 闭集外 / 形状负控 ×4 / 恢复 / 无候选）',
    argv: tsx('scripts/postlv2-s8-choice-verify.ts'),
    entry: 'scripts/postlv2-s8-choice-verify.ts',
    tags: ['post-lv2'],
    resources: { parallel: 'serial' as const, evidenceWrites: ['artifacts/post-lv2'] },
    why:
      '隔离库（`isolateDatabase()` 一次性 %TEMP% 沙箱）+ **零真实模型 / 零出网**：私有决策端口是**注入的替身**，' +
      '"调用了几次"由计数器给 —— 那正是"没有活跃 run / 没有候选 ⇒ 一次都不发"这几条主张的来源。' +
      '⚠️ **本门不主张真实模型的解析质量**：' +
      '"她会不会把用户没做的选择解析出来"是 `L-S8-31`（模型误解读 ⇒ 冒充一次 `user_choice` ⇒ 按 `ADR-093` `D01` 可成为习惯根）。' +
      '⚠️ `notCovered` 逐条写进证据：真实模型质量 · `main.ts` 生产接线 · flag 与缺省锁 · `m3.5:test` 基线未动，**都未做**。',
  },
]

/**
 * **post-Lv2 新增离线控制**（`AUD-20261005-03`，2026-10-05 登记）。
 *
 * ============================================================================
 *  为什么有这一组
 * ============================================================================
 * 审计 `AUD-20261005-03` 的事实：取消连续性、目标期限/并行、角色工具面**都已有独立验证脚本**，
 * 但 `PL2_GATES` 仍只有 10 个 S8/DB 门 ⇒ 这些新路径**不进任何 lane**、
 * `pnpm fast` / `--lane affected` **带不出**它们（只能靠人记住命令）。
 * 「有测试 ≠ 已有持续调度」。
 *
 * ⚠️ **只登记逐条核过"离线安全"的门**（2026-10-05 逐文件核，证据引用见每条的 `why`）。
 * 下列门**有意不登记**（各自的原因都是可复核的事实，不是偏好）：
 * ```text
 * `postlv2:semantic:verify`              —— 依赖 gitignored 的本地编码器资产
 *                                           （`evals/m9.5/embedding-manifest.json` +
 *                                            `artifacts/m9.5/local/embedding-lab/models`）；
 *                                           资产不在 ⇒ 具名 FAIL ⇒ 会让快车道为**与本次改动无关**的原因变红
 * `postlv2:semantic:production:verify`   —— **读活的 `data/pglite`**（`cpSync` 真库副本），
 *                                           用户正在聊天时复制不静止 ⇒ 直接崩且不落证据
 * `postlv2:role-tool:matrix`             —— 依赖三处 gitignored 本地资产（python venv / OCR 图 / rapidocr 运行时），
 *                                           任一缺 ⇒ `notRun` ⇒ NOT PASS；且真的跑 python + OCR（长）
 * `postlv2:role-tool:known-dirs`         —— 它**自己**声明读数依赖本机环境，且会把**用户真实桌面路径**
 *                                           写进仓库跟踪的证据里
 * `postlv2:goal-thinking-eval`           —— **真的出站**（真 `fetch`；需 `DSH_TEST_MODEL_WRAPPER=1` + 测试凭证）
 * ```
 * ⇒ 它们仍可用 `pnpm <id>` 显式跑；"显式"与"自动带出"是两件事。
 */
export const PL2_CONTROL_GATES: readonly GateSpec[] = ([
  ['reminder:channels:verify', 'scripts/reminder-channels-verify.ts', '三入口渠道事实与跨渠道提醒', '隔离库、loopback 模型、真实共存核心/控制台与 Python/页面夹具；不发真实 QQ，不打开正式库。'],
  [
    'postlv2:avatar-opening:verify',
    'scripts/postlv2-avatar-opening-verify.ts',
    'ADR-131 皮套入口的系统发起开口：机会预检 15 条具名拒绝 / 生成侧 / 编排 / 机会状态 / 接线',
    '**纯契约与纯函数 + 假模型端口**；零真实模型 / 零出网 / **不打开任何库** / 不改写工作树。' +
      '三段式（正控 · **量具有效性（期望反向 ⇒ 必须报红）** · 恢复）+ `measured_count`。' +
      '⚠️ 接线那一段**优先结构判据**（把 `isBridgeControlMessageKind` 等 import 进来**调用**）；' +
      '只有 `main.ts` 的内联端口与 Python 外壳**无法 import**，才退回**窄范围**文本判据，且在读数里写明。',
  ],
  ['postlv2:database-env:verify', 'scripts/postlv2-database-env-verify.ts', '数据库环境加载前置保护', '临时 cwd/.env + 假插件；不打开数据库，覆盖晚加载与旧 sandbox 标记。'],
  ['postlv2:oss-mechanisms:verify', 'scripts/postlv2-oss-mechanisms-verify.ts', 'AIRI / LiveKit / Pipecat / MaiBot 机制功能', '实际 Web Audio 播放器受控时钟、标准库 Python 桥、隔离库与 TurnGateway；零真实模型，不作性能或人格收益验收。'],
  ['postlv2:image:verify', 'scripts/postlv2-image-input-verify.ts', '图片输入离线整链', '隔离库、loopback 模型/QQ 夹具，不发真消息，不依赖外部资产。'],
  ['learning:contracts:verify', 'scripts/learning-skills-verify.ts', '学习技能离线契约', '--offline 使用临时资料库与论文 worker 夹具；外部资产指纹独立验收。'],
  ['postlv2:orchestration:verify', 'scripts/postlv2-orchestration-verify.ts', '首份提案与重规划协议', '实际模型适配器 + fetch 夹具；不打开数据库、不调用真实模型。'],
  ['postlv2:affected:verify', 'scripts/postlv2-affected-verify.ts', '受影响门选择覆盖与升级正负控', '纯规划函数和已登记离线门；不执行资产或真实链。'],
  ['postlv2:automatic-memory:recovery:verify', 'scripts/postlv2-automatic-memory-recovery-verify.ts', '自动记忆健康与受控恢复', '真实消费者、隔离库、假提取器；无外部 Python 或真实模型。'],
  [
    'postlv2:s8:daily:verify',
    'scripts/postlv2-s8-daily-verify.ts',
    'ADR-115 日常故事：无关零写入、相关开局、自然选择、续接、确定性结局和真实上下文',
    '隔离库 + 真实故事装配与 TurnGateway；决策端口用离线夹具，不主张模型语义正确率。',
  ],
  [
    'postlv2:s8:daily:e2e',
    'scripts/postlv2-s8-daily-e2e.ts',
    'ADR-115 日常故事真实 main.ts：提交/水位读回 + 入口/消费缺席负控 + 恢复',
    '正控与恢复使用真实 main.ts；负控只摘除临时副本的入口或消费调用，每档全新隔离库、跨进程续接。' +
      '本机 HTTP 夹具；生产源码不改、真实库不打开，不主张真实模型质量。临时副本在 finally 删除，串行运行。',
  ],
  [
    'postlv2:s8:entry-lock:verify',
    'scripts/postlv2-s8-entry-lock-verify.ts',
    'S8 入口锁（`ADR-107` `R-4c`）：正控 / **入口缺席负控** / 恢复 —— 把"入口有没有被真的调用"变成**行为**判据',
    '隔离库 + **真装配**（`createStoryCognition`）+ 离线反射固定件 + 注入的选择端口 ⇒ **零真实模型 / 零出网**。' +
      '⚠️ **主张只挂在账本与水位读数上**（`L1`/`L2`/`L3`）：入口**被调用**时账本出现 `CHOICE_COMMITTED` 且**三个消费者水位都推进**；' +
      '**不**调用入口时它**留不下任何行**（而同一套装配紧接着就能产出 ⇒ 证明判据**对入口是否被调用敏感**，不是恒真）。' +
      '⚠️ `main.ts` 的**文本锁**读数在证据里**列出来但不作为主张**（`R-4c` 的降级：文本锁测不到"入口有没有被真的调用"，' +
      '而那正是 `L-S8-30` 立案的形状）。',
  ],
  [
    'postlv2:gate-selection:verify',
    'scripts/postlv2-gate-selection-verify.ts',
    '选档器自证（身份优先 · mtime 永不参与 · 并列判定不同即失败关闭）—— `TD-23` / `AUD-20261005-02`',
    '纯计算 + `%TEMP%` 夹具 + 只读源码做结构锁；驱动真的 `summarizeM111Evidence()`；零库 / 零模型 / 零出网 / 不改写工作树。',
  ],
  [
    'postlv2:goal-deadline:verify',
    'scripts/postlv2-goal-deadline-verify.ts',
    '目标理解期限控制（成功/错误 body 读取 · 晚结果零写入 · 期限 8s）',
    '`scripts/postlv2-goal-deadline-verify.ts:122` 自报 `database:"NOT_OPENED"` / `network:"MOCKED"`；' +
      '全部 provider 注入 `fetchImpl`（`:37-40`/`:83-92`/`:105-108`/`:113-116`）⇒ **零真实出站**。' +
      '⚠️ 它**刻意真等 ~8 秒**（`:64` 断言 `elapsedMs` 落在 7900–10000）⇒ 排到不与 CPU 争用的时段；' +
      '同一 lane 内已声明 `serial`。',
  ],
  [
    'postlv2:goal-parallel:verify',
    'scripts/postlv2-goal-parallel-verify.ts',
    '目标 prepare 与 recall 并行控制（提交仍在 recall 后 · 单请求 · 幂等）',
    '`:3-4` 在 import 数据库模块**之前**就 `isolateDatabase(...,{keep:false})`；provider/planner 全是注入的脚本件（`:37-42`）' +
      '⇒ 零真实出站、不打开真实库、不改写工作树。',
  ],
  [
    'postlv2:role-tool:verify',
    'scripts/postlv2-role-tool-verify.ts',
    '角色工具决策目录与契约（16 项能力四态目录）',
    '该脚本自述 `:27-28`「真实库 `data/pglite` **一次都不打开**：不需要数据库、不需要模型、不需要网络」；' +
      '提案全是字面夹具（`:582-644`）。⚠️ 它读 `.env`（`:296-297`）⇒ **"当前"那一半反映本机配置**（这正是它要报的读数）。',
  ],
  [
    'postlv2:role-tool:path',
    'scripts/postlv2-role-tool-path-verify.ts',
    '角色工具限定路径（`L-RTD-*` 的路径面：53/53）',
    '走 Suite 的隔离库（`:52` → `groups.ts:136`）；决策端口是夹具（`:94-118`）、列出的目录是 `%TEMP%` 合成树（`:299`，`:80-81` 明写"不读真实的用户桌面"）；' +
      '开头/结尾各比一次真实库的 mtime 与文件数（只读 `readdirSync`/`statSync`）。' +
      '⚠️ **声明 `serial`**：用户**正在聊天**时会写 `data/pglite` ⇒ 那个只读比对会假红（`:796`）。',
  ],
  [
    'postlv2:sequence-continuity:verify',
    'scripts/postlv2-sequence-continuity-verify.ts',
    '取消/失败后的会话序号连续性（`R-54` 的修法；7 场景 + 旧缺陷复现负控）',
    '走**真实 `src/main.ts --bridge`** + 全新隔离库 + **loopback HTTP 假模型**（`:60`/`:100`）⇒ 零真实出站；' +
      '`:51`/`:431` 只对真实库做**树摘要**比对（不打开）。' +
      '⚠️ **慢**：结构上要启动 7 次 `src/main.ts`（`:322`/`:336`/`:357`/`:371`/`:392`），每步 60s 期限（`:189`）⇒ 保守声明 `serial`。' +
      '⚠️ 它的证据目录名是**固定**的（`:50` `artifacts/post-lv2/sequence-continuity-verify-20261005`，**不带时间戳**）⇒ ' +
      '重跑会**覆盖**那一份文件（不是新增一份）。按 `AGENTS §7` 的纪律：它不是"历史证据被改写"，' +
      '而是"同一道门重跑"；跑完若不想提交它，用 `git checkout -- <path>` 还原。',
  ],
  /*
   * ⚠️ **2026-10-07 追加 4 道**（全项目审计 §7/§12 的"门不在 manifest"那一项）。
   *
   * 判据与上面那一批**同一条**：只登记**逐文件核过"离线安全"**的门。
   * 本轮逐文件核过的事实：这 4 个脚本里**没有** `PRODUCTION_DB_DIR` / `cpSync`（副本真实库）、
   * **没有** `openai` / `fetch(` 真出站、**没有**依赖 `postlv2-deps` 或 `artifacts/<里程碑>/local/` 的外部 venv。
   * 本机实跑读数：`transport` **PASS（78 项）** · `qq:reconnect:verify` / `delivery` / `body` 见各自证据。
   *
   * ⚠️ **同时拒绝的 4 道**（原因都可复核，见下面 lane note 的排除清单）：
   * `postlv2:expression:verify`（Python 侧调 `~/postlv2-deps/qwen3-tts-venv` 外部 venv）·
   * `postlv2:automatic-memory:verify`（依赖 `CHARACTER_MEMORY_AUTOMATIC_PYTHON` 指向的 langmem venv）·
   * `postlv2:coexist:verify`（起两条 loopback + 核对真实库树摘要；用户核心在跑时会有租约冲突）·
   * `postlv2:bridge:verify`（会起 ElizaOS 运行时，且脚本内出现真实库判据）。
   */
  [
    'postlv2:transport:verify',
    'scripts/postlv2-transport-verify.ts',
    '入口桥传输与生产 host（78 项：控制消息并行 / 正式轮次串行 / 两个读数字段）',
    '离线：只走桥的传输层与 loopback 替身；本轮逐文件核过无真实库 / 模型 / 外部资产依赖。' +
      '⚠️ 它与 `postlv2:bridge:verify` **不是**一回事：后者会起 ElizaOS 运行时，因而**未登记**。',
  ],
  [
    'postlv2:delivery:verify',
    'scripts/postlv2-delivery-verify.ts',
    '媒体交付账（生成 / 合成 / 交付三本账不互相替代）',
    '离线：纯账目与迁移表判据（Cubism / 音频侧是 stub）；本轮逐文件核过无真实库 / 模型 / 外部资产依赖。',
  ],
  [
    'postlv2:body:verify',
    'scripts/postlv2-body-verify.ts',
    '皮套状态映射（WP3：任务状态 → 有限表情 / 动作）',
    '离线：纯映射判据；本轮逐文件核过无真实库 / 模型 / 外部资产依赖。' +
      '⚠️ 它**不**主张真实 Cubism 渲染（那要窗口与设备，属未登记的档）。',
  ],
  [
    'qq:reconnect:verify',
    'scripts/qq/reconnect-verify.ts',
    'QQ 私聊重连恢复（本地 OneBot 夹具；不打开数据库、不发真 QQ）',
    '离线：脚本第 1 行自述 `no database or real QQ sends`，夹具是本机 `ws` 服务（非真实 OneBot）。' +
      '⚠️ **真 NapCat + 真手机**从不在本门内（那是真人体验档）。',
  ],
] as [string, string, string, string][]).map(([id, entry, title, why]) => ({
  id,
  title,
  entry,
  argv: id === 'learning:contracts:verify' ? [...tsx(entry), '--offline'] : tsx(entry),
  tags: ['post-lv2', 'post-lv2-controls'],
  resources: { parallel: 'serial' as const, evidenceWrites: ['artifacts/post-lv2'],
    ...(id === 'postlv2:s8:daily:e2e' ? { mutatesGitWorktree: true } : {}) },
  why:
    why +
    '（`AUD-20261005-03` 登记：这些门此前**不在任何 lane 里** ⇒ `pnpm fast` / `--lane affected` 带不出它们。）',
}))

/** Lv2 综合验收的离线门。**真模型档**（`lv2:short:live`）与**改写工作树档**（`lv2:corpus:freeze`）**不在其中**。 */
export const LV2_GATES: readonly GateSpec[] = ([
  ['lv2:core:verify', 'scripts/lv2-core-verify.ts'],
  ['lv2:repair:verify', 'scripts/lv2-repair-verify.ts'],
  ['lv2:measurement:verify', 'scripts/lv2-measurement-verify.ts'],
  ['lv2:privacy:budget:verify', 'scripts/lv2-privacy-budget-verify.ts'],
  ['lv2:regression:read', 'scripts/lv2-regression-read.ts'],
] as [string, string][]).map(([id, entry]) => ({
  id,
  title: id,
  entry,
  argv: tsx(entry),
  tags: ['lv2'],
  resources: { parallel: 'serial' as const, evidenceWrites: ['artifacts/lv2'] },
  why:
    '隔离库 / 只读已落盘证据；`lv2:privacy:budget:verify` 是纯文件扫描（正控：注入一条本地正文必须响）。' +
    '证据写在共享里程碑根 ⇒ 保守声明 serial。',
}))

/**
 * ADR-106（桌面查看与操作）的两道门。
 *
 * ```text
 * desktop-control:verify  离线：夹具 worker ⇒ 协议 / 有界 / 失败映射 / 闭集 / 隐私边界 / 目录四态
 * desktop-control:probe   实机**只读**：真 worker 读一次桌面 + 用真实快照做失败关闭负控
 *                         （**不点击、不输入、不截图**；干跑档保证"核对链通过"也不动手）
 * ```
 * ⚠️ **有意不并入 `offline` lane**：那条 lane 的公开声明是"与 `pnpm m4.5:ci` 逐条等价"。
 * ⚠️ `desktop-control:act`（**真的动鼠标键盘**）**不登记**：它需要人在场，
 *    必须由人显式跑 `pnpm desktop-control:act --i-am-here`。
 */
export const DESKTOP_CONTROL_GATES: readonly GateSpec[] = ([
  ['desktop-control:verify', 'scripts/desktop-control/verify-desktop-control.ts'],
  ['desktop-control:probe', 'scripts/desktop-control/probe-desktop-state.ts'],
] as [string, string][]).map(([id, entry]) => ({
  id,
  title: id,
  entry,
  argv: tsx(entry),
  tags: ['desktop-control'],
  resources: { parallel: 'serial' as const, evidenceWrites: ['artifacts/post-lv2/desktop-control'] },
  why:
    (id.endsWith('probe')
      ? '需要本机独立运行时（`artifacts/post-lv2/local/desktop-runtime`）与一个真实桌面；'
      : '纯离线（夹具 worker，不 import windows-mcp、不碰 UIA）；') +
    '运行时不在 ⇒ 如实 NOT RUN（不是 PASS）；两道门都不点击、不输入、不截图。',
}))

/**
 * 脚本清单门（`P2-11`，2026-10-07）—— **只读**：把 `docs/architecture/Scripts-Catalog.md`
 * 与 `package.json`（575 条）和本文件的门登记逐字节比对。
 *
 * 为什么值得一道门：`pnpm <里程碑>:gates` 这类入口、以及"哪些条目是内部件"，
 * 一旦与现实脱节，**没有任何东西会红**（文档过期是静默的）。这条门让"清单过期"变成一个失败读数。
 *
 * ⚠️ 与 td/m9/m9.5/… 同一条纪律：**有意不并入 `offline` lane** ——
 *    那条 lane 的公开声明是"与 `pnpm m4.5:ci` 逐条等价"，加门会让声明变假。
 */
export const SCRIPTS_GATES: readonly GateSpec[] = [
  {
    id: 'scripts:catalog:verify',
    title: 'scripts 清单与 package.json / manifest 一致',
    argv: [...tsx('scripts/gates/scripts-catalog.ts'), '--check'],
    entry: 'scripts/gates/scripts-catalog.ts',
    tags: ['scripts'],
    resources: { ...SAFE_PURE },
    why:
      '纯只读：读 package.json / AGENTS.md / README.md / 本文件，重算清单并与已提交的那份逐字节比较；' +
      '不一致 ⇒ exit 1（清单过期，跑 `pnpm scripts:catalog` 更新）。不写证据、不起库、不出网。',
  },
]

/**
 * 第二批（post-Lv2 productivity）与浏览器 sidecar 的门（2026-10-09 / `ADR-125` 收尾纳入）。
 *
 * ```text
 * productivity:verify                  28 组离线组合（含 browser-01…05）
 * productivity:sidecar:autostart:verify ADR-101 自启动（起真 sidecar，全部临时端口）
 * ```
 *
 * ⚠️ **为什么不并入 `offline` lane**：那条 lane 的公开声明是"与 `pnpm m4.5:ci` 逐条等价"，
 *    加门会让那句声明变假（与 desktop-control / td / scripts 同一条纪律）。
 *
 * ⚠️ **`acceptExitCodes: [1]` 的理由（逐字）**：`productivity:verify` 的退出码现在分三档
 *    （0 干净 / **1 只有 NOT RUN** / 3 有 FAIL 或 MEASUREMENT INVALID / 2 门自己抛错）。
 *    本表**只**接受 1 —— 因为那 28 组里有一组（`browser-04`：真登录态继承与桌面焦点影响）
 *    **只能由人做前置**，它的 NOT RUN 是如实的，不是"没人跑"。
 *    ⇒ 真失败（3）与门抛错（2）**照旧让它红**；接受的不是"red"，只是"human-required 未跑"。
 */
export const PRODUCTIVITY_GATES: readonly GateSpec[] = [
  {
    id: 'productivity:verify',
    title: '第二批 28 组离线组合（含 browser-01…05）',
    argv: tsx('scripts/productivity-skills-verify.ts'),
    entry: 'scripts/productivity-skills-verify.ts',
    tags: ['productivity'],
    acceptExitCodes: [1],
    resources: {
      parallel: 'serial',
      evidenceWrites: ['artifacts/post-lv2/productivity-skills'],
    },
    why:
      "每组自己 isolateDatabase（目录名含时间戳，唯一）+ 临时端口夹具 sidecar；但整套要跑几十个床、" +
      '并写自己的证据目录 ⇒ 保守串行。退出码 1 = **只有 NOT RUN**（唯一的 NOT RUN 是需真人前置的 ' +
      '`browser-04`）；有 FAIL ⇒ 3，门抛错 ⇒ 2 —— 两者都不被接受（见上方注释）。',
  },
  {
    id: 'productivity:sidecar:autostart:verify',
    title: '浏览器 sidecar 自启动（ADR-101）',
    argv: tsx('scripts/productivity-skills/sidecar-autostart-verify.ts'),
    entry: 'scripts/productivity-skills/sidecar-autostart-verify.ts',
    tags: ['productivity'],
    resources: { parallel: 'serial' },
    why:
      '会用**临时端口**起真 sidecar 子进程（`freePort()`）并读写租约 ⇒ 串行；' +
      '依赖本机已装的那份固定版本 sidecar（`artifacts/post-lv2/local/.../browser-sidecar`）与 token 文件，' +
      '缺失 ⇒ 如实失败（不静默跳过）。不写证据、不碰真实库。',
  },
]

// 已核查不依赖外部资产/真实模型的专项；全量升级仍保留命中的这些门。
export const OFFLINE_SPECIALTY_IDS: readonly string[] = [
  ...PL2_CONTROL_GATES.map(g => g.id),
  'm5:test', 'm5:verify', 'm5:e2e:verify',
]

// ===========================================================================
// PostgreSQL 迁移（WP1 起的 PG 门）
// ===========================================================================
/**
 * ⚠️ **有意不并入 `offline` lane**（同 `desktop-control` lane 的先例）：
 * 那条 lane 的声明与 `pnpm m4.5:ci` **逐条等价**，而 `postgresql:g02:verify`
 * **需要**一个在跑的隔离 PG 实例（Docker + `lg-postgresql-trial` + 凭据文件）。
 * 把它塞进 offline lane 等于让本仓库的核心离线 CI **依赖 Docker 在跑** ——
 * 那是另一件事，不该顺手发生。
 *
 * `postgresql:g01:verify` **不在这里**：它是纯函数 + 临时目录子进程，不需要任何实例
 * ⇒ 它留在 `OFFLINE_GATES` 里（因此被核心 CI 覆盖）。
 *
 * 调用：`pnpm gates:run --lane postgresql`
 */
export const POSTGRESQL_GATES: readonly GateSpec[] = [
  {
    id: 'postgresql:g08:verify',
    title: 'WP5 功能整链与回归（记忆增改撤回 · 认知恢复 · 通知 · 重启续跑 · 外部发送受控）',
    argv: tsx('scripts/postgresql-g08-verify.ts'),
    entry: 'scripts/postgresql-g08-verify.ts',
    /*
     * 资源填写依据（逐条核过）：
     *   · **需要**在跑的隔离 PG 实例 + 凭据文件 + verified 来源快照 + 导出运行时；
     *     任一缺失 ⇒ **非零退出**并具名报 notRun。
     *   · 它建**一个**测试库（`lg_test_g08`，从快照恢复），在**同一个**目标上
     *     起**两次**真核心（`initDatabase` + `initKernel`，与装配根同一条路）：
     *     第一次跑真实写入路径（记忆增/改/撤回走 `appendDomainEvent` + `applyMemoryEvent`；
     *     通知走 `createIntent` / `reserveOccurrence` / `deferOccurrence` / `pendingCareDeferrals`），
     *     关库（并断言旧句柄真的用不了），第二次再起 ⇒ 断言续跑（事件数不增、水位/投影摘要不变、
     *     记忆状态逐行一致、同键占用仍 `created:false`）。
     *   · **外部发送在测试中受控**：从不构造投递通道、不起 QQ 进程；`G08.5a/5b` 是结构性断言。
     *   · 自建自删测试库；**真实库目录指纹前后比对**（`PG-ISO-01` 之后每道新门都带）。
     *   · 它会**再起一个核心**（第二条连接 + 内核装配）⇒ 与其他 PG 门共用实例，**必须 serial**。
     */
    resources: { parallel: 'serial' },
    why:
      '需要隔离 PG 实例 + verified 快照 + 导出运行时；建 lg_test_g08 并在同一目标上起两次真核心；' +
      '走真实事件溯源/通知 store 写入路径；关库后断言旧句柄失效；外部发送结构性受控；自建自删；必须 serial。',
  },
  {
    id: 'postgresql:bench:verify',
    title: 'WP5 资源读数（S8：服务端执行时间 / 端到端往返 / 连接数 / CPU·内存 / 磁盘 / 备份耗时 · 两侧分列不判优）',
    argv: tsx('scripts/postgresql-bench-verify.ts'),
    entry: 'scripts/postgresql-bench-verify.ts',
    /*
     * 资源填写依据（逐条核过）：
     *   · **需要**在跑的隔离 PG 实例 + 凭据文件 + verified 来源快照 + 导出运行时；
     *     任一缺失 ⇒ **非零退出**并具名报 notRun。
     *   · 它建**一个**测试库（`lg_test_bench`，从快照恢复）+ 打开**同一份快照**的 PGlite 副本
     *     ⇒ 两侧是"同一个库的两份"（`B03` 断言两侧同一条查询结果相同才继续）。
     *   · 它复用 `PG-G07` 已验证的**写入进程**（`scripts/postgresql/g07-writer.sh`）做
     *     "写入进行中的并发只读"与"写入进行中的备份耗时"。
     *   · ⚠️ **它不设性能目标、不判优**（计划 §5 逐字"未设性能收益目标"）：`B11` 结构性断言
     *     读数里**不许**出现 faster/winner/speedup 之类的判优字段。
     *   · 自建自删测试库；**真实库目录指纹前后比对**（`PG-ISO-01` 之后每道新门都带）。
     *   · **必须 serial**：与其他 PG 门共用同一个实例（`L-PGW2-03`），且它会起写入进程。
     */
    resources: { parallel: 'serial' },
    why:
      '需要隔离 PG 实例 + verified 快照 + 导出运行时；建 lg_test_bench 并与同一快照的 PGlite 副本对照；' +
      '复用 g07-writer 做并发只读与在线备份耗时；**不设性能目标、不判优**；自建自删；必须 serial。',
  },
  {
    id: 'postgresql:g04:verify',
    title: 'PG-G04 SQL/仓储兼容（真 PG：JSON/null · bigint 边界 · RETURNING · 唯一/部分索引 · 幂等 · 乐观冲突 · 事务原子性 · 四仓储真实执行）',
    argv: tsx('scripts/postgresql-g04-verify.ts'),
    entry: 'scripts/postgresql-g04-verify.ts',
    /*
     * 资源填写依据（逐条核过）：
     *   · **需要**在跑的隔离 PG 实例 + 凭据文件 + verified 来源快照 + 导出运行时；
     *     任一缺失 ⇒ **非零退出**并具名报 notRun。
     *   · 它建**一个**测试库（`lg_test_g04`，从 verified 快照恢复）并在上面起**一次**真核心
     *     （`initDatabase` + `initKernel`，与装配根同一条路）。
     *   · 判据分七组：JSON/null（含 null 与缺键可区分）· bigint 边界（**只主张 SQL/文本层**，
     *     并如实记录 JS number 会丢）· `RETURNING` · 唯一索引与**部分**唯一索引（含谓词不命中不拦）·
     *     幂等（事件键 / 任务键 / 已处理操作表）· 乐观冲突（错的 expectedRevision ⇒ `revision_conflict`
     *     且**没写进去**）· 事务原子性（事务内撞主键 ⇒ 整体回滚 0 行）· 四个仓储真实执行
     *     （Event / Conversation / Memory / Job）。
     *   · 自建自删测试库；**真实库目录指纹前后比对**（`PG-ISO-01` 之后每道新门都带）。
     *   · 它起一个核心并建库 ⇒ 与其他 PG 门共用实例，**必须 serial**。
     */
    resources: { parallel: 'serial' },
    why:
      '需要隔离 PG 实例 + verified 快照 + 导出运行时；建 lg_test_g04 并起一次真核心；' +
      '七组 SQL/仓储判据（含部分唯一索引与事务回滚）；自建自删；真实库指纹前后比对；必须 serial。',
  },
  {
    id: 'postgresql:g10:verify',
    title: 'PG-G10 切换就绪（只读审查：G01…09 全 PASS · run 归属 · 恢复演练 · WP6 四份文档完整）',
    argv: tsx('scripts/postgresql-g10-verify.ts'),
    entry: 'scripts/postgresql-g10-verify.ts',
    /*
     * 资源填写依据（逐条核过）：
     *   · 它是**只读聚合器**：**不连数据库、不跑别的门、不改任何东西** —— 只读
     *     `artifacts/post-lv2/postgresql-migration/` 下**已落盘**的证据 + WP6 的四份文档。
     *   · ⇒ 它**不需要** PG 实例/凭据/快照；缺的是**上游门的证据** ⇒ 那种情况下它具名报 notRun。
     *   · ⚠️ 选档按 `runId` **字典序**（不看 mtime —— 仓库既有纪律 `TD-23`）。
     *   · ⚠️ **必须最后跑**：它读的就是其他门刚写的证据 ⇒ `serial` 且依赖全部 PG 门。
     */
    resources: { parallel: 'serial' },
    why:
      '只读聚合器：读已落盘证据 + WP6 四份文档，不连库、不跑门；按 runId 选档（不看 mtime）；' +
      '必须在上游门之后跑。',
  },
  {
    id: 'postgresql:g02:verify',
    title: 'PG-G02 schema 与权限（真 PG：从零可运行 / 权限边界 / 并发迁移 / 回滚）',
    argv: tsx('scripts/postgresql-g02-verify.ts'),
    entry: 'scripts/postgresql-g02-verify.ts',
    /*
     * 资源填写依据（逐条核过）：
     *   · **需要**一个在跑的隔离 PG 实例（容器 `lg-postgresql-trial`）与它的凭据文件；
     *     拿不到时本门**非零退出**并如实报 `notRun` —— 它不会"绿着跳过"。
     *     （这一条是实测修出来的：第一版在实例不可达时以 0 退出，那是个假绿。）
     *   · 它**自建自删**自己的测试库（`lg_test_g02` / `lg_test_g02_race`），不污染别的门。
     *   · 不碰真实库 `data/pglite`：全程只连 127.0.0.1:55432 的隔离实例。
     *   · **必须 serial**：`L-PGW2-03` 记的"同时跑两道 PG 门会互相影响"
     *     （实例长期存在，门之间靠库名隔离）⇒ 不许与别的 PG 门并行。
     *   · 不写证据文件（只往 stdout 打报告）。
     */
    resources: { parallel: 'serial' },
    why: '需要隔离 PG 实例（拿不到则非零退出 + 具名 notRun）；自建自删 lg_test_g02*；不碰真实库；必须 serial（L-PGW2-03）。',
  },
  {
    id: 'postgresql:g03:verify',
    title: 'PG-G03 生命周期与写入资格（真 PG + 两个真实 OS 进程：第二核心拒绝 / 锁丢失检测 / 服务器重启）',
    argv: tsx('scripts/postgresql-g03-verify.ts'),
    entry: 'scripts/postgresql-g03-verify.ts',
    /*
     * 资源填写依据（逐条核过）：
     *   · **需要**在跑的隔离 PG 实例 + 凭据文件；拿不到时**非零退出**并具名报 notRun。
     *   · 它**起多个真实 OS 进程**（`qualification-probe.ts`）—— 这是计划 §5 对
     *     `PG-G03` 的逐字要求（"真 PG + 两个 OS 进程"）；同进程模拟证明不了跨进程资格。
     *   · 它会**终止**自己那条专用连接（`pg_terminate_backend`）来测"锁连接丢失"。
     *     终止条件被限制在 `usename = 'lg_migrate'`，即本门自己的测试账号。
     *   · ⚠️ **它还会 `docker restart` 这个容器**（测 `G03.6`"服务器重启 ⇒ 资格重新建立"）。
     *     因此：① 它必须 serial（会打断别的 PG 门）；② 它**无论断言成败都等实例回到健康**
     *     （`waitForHealthy`），不把实例留在停着的状态；③ 重启后它会断言
     *     "另一个进程可以取得资格"，以证明旧锁真的随会话消失。
     *   · 自建自删 `lg_test_g03`；不碰真实库 `data/pglite`。
     *   · 不写证据文件。
     */
    resources: { parallel: 'serial' },
    why: '需要隔离 PG 实例 + 多个真实 OS 进程；会终止自己的 lg_migrate 会话并**重启容器**（故必须 serial，且无论成败都要等实例回到健康）；自建自删 lg_test_g03。',
  },
  {
    id: 'postgresql:g05:verify',
    title: 'PG-G05 迁移完整性（全库逐表规范化内容摘要 + 主题面 + 真数据四条具名负控 + 重新恢复）',
    argv: tsx('scripts/postgresql-g05-verify.ts'),
    entry: 'scripts/postgresql-g05-verify.ts',
    /*
     * 资源填写依据（逐条核过）：
     *   · **需要**在跑的隔离 PG 实例 + 凭据文件 + 一个 verified 的 PGlite 来源快照
     *     **以及**导出工具的独立运行时。任一缺失 ⇒ **非零退出**并具名报 notRun。
     *   · 它读**源副本**（`openPgliteSnapshot`：复制一次、打开一次、读多表，自证源目录未动），
     *     并把同一份快照导出后恢复进一个**新空库**再逐表比较（54 张表 / 4261 行）。
     *   · 它自建自删一个测试库（`lg_test_g05`），**无论断言成败都清理**。
     *   · 负控是**真数据**上的改动（删一行 / 改主键 / 改归因 / 改向量 / 回退水位 / 改无主键表的一行），
     *     之后**重新从同一份导出恢复一次**并再比一遍 ⇒ 不需要额外的回滚机制。
     *   · 不碰真实库 `data/pglite`；不写任何东西到源目录。
     *   · **必须 serial**：与其他 PG 门共用同一个实例（`L-PGW2-03`）。
     */
    resources: { parallel: 'serial' },
    why:
      '需要隔离 PG 实例 + verified 快照 + 导出运行时（缺任一则非零退出 + 具名 notRun）；' +
      '读源副本（自证源目录未动）并与从同一快照恢复的新空库逐表比较；自建自删 lg_test_g05；必须 serial。',
  },
  {
    id: 'postgresql:g06:verify',
    title: 'PG-G06 投影与语义召回（六个 store 级重建 A==B / 向量代与维度 / 固定查询 ID / 等距按集合 / 编码器指纹不变）',
    argv: tsx('scripts/postgresql-g06-verify.ts'),
    entry: 'scripts/postgresql-g06-verify.ts',
    /*
     * 资源填写依据（逐条核过）：
     *   · **需要**在跑的隔离 PG 实例 + 凭据文件 + verified 来源快照 + 导出运行时。
     *     任一缺失 ⇒ **非零退出**并具名报 notRun（不"绿着跳过"）。
     *   · 它建**两个**测试库：A（**只读**，只做 SELECT）与 B（启动核心 + 六个 store 级重建）。
     *     ⚠️ 它是本仓库里**第一个**把真核心（`initKernel`）**对着 PostgreSQL 目标**启动的门
     *     （走 `isolateDatabase(..., { postgres: { url } })` 的隔离判据：目标必须是 `lg_test_` 前缀）。
     *   · 它**自建自删**两个测试库，且**无论断言成败都清理**。
     *   · 不碰真实库 `data/pglite`；不写任何东西到源目录。
     *   · **必须 serial**：与其他 PG 门共用同一个实例（`L-PGW2-03`），且它会持有连接池。
     */
    resources: { parallel: 'serial' },
    why:
      '需要隔离 PG 实例 + verified 快照 + 导出运行时；建两个测试库（A 只读 / B 起核心做六个 store 级重建）；' +
      '**真核心对着 PostgreSQL 目标启动**（隔离判据要求 lg_test_ 前缀）；自建自删；必须 serial。',
  },
  {
    id: 'postgresql:g07:verify',
    title: 'PG-G07 在线备份恢复（并发写入中备份 / 新空库恢复 / 篡改与截断具名拒收 / 库外资产 manifest）',
    argv: tsx('scripts/postgresql-g07-verify.ts'),
    entry: 'scripts/postgresql-g07-verify.ts',
    /*
     * 资源填写依据（逐条核过）：
     *   · **需要**在跑的隔离 PG 实例 + 凭据文件 + 一个 verified 的 PGlite 来源快照
     *     **以及**导出工具的独立运行时（`artifacts/post-lv2/local/pg-migration/export-runtime`）。
     *     任一缺失 ⇒ **非零退出**并具名报 notRun（不"绿着跳过"）。
     *   · 它起**一个真实的并发写入进程**（`docker exec … sh /opt/lg/g07-writer.sh`，
     *     即另一个 OS 进程）在被备份的库上持续写，然后**不停任何东西**做在线 `pg_dump` ——
     *     这是契约 `G07.1` 的逐字要求（"核心活动时备份成功（不停止核心）"）。
     *     ⚠️ 那**不是**真实认知核心；真实核心的在线备份读数属 WP7/WP8。
     *   · 它自建自删**两个**测试库（`lg_test_g07_src` / `lg_test_g07_dst`），
     *     且**无论断言成败都清理**（否则下一道门会撞名）。
     *   · 备份本体（含私人历史）与逐文件资产清单落 `artifacts/post-lv2/local/`（gitignore，**不进仓库**）；
     *     进仓库的只有清单（表名/行数/摘要）与资产汇总。
     *   · 不碰真实库 `data/pglite`：只读 `data/` 下登记的资产根算摘要，不写。
     *   · **必须 serial**：与其他 PG 门共用同一个实例（`L-PGW2-03`）。
     */
    resources: { parallel: 'serial' },
    why:
      '需要隔离 PG 实例 + verified 快照 + 导出运行时（缺任一则非零退出 + 具名 notRun）；' +
      '起真实并发写入进程做在线备份；自建自删 lg_test_g07_src/dst；备份本体与逐文件清单只进 local/；必须 serial。',
  },
  {
    id: 'postgresql:g09:verify',
    title: 'PG-G09 量具有效性（规范化比较器 · 三段式 + 真跨驱动）',
    argv: tsx('scripts/postgresql-g09-verify.ts'),
    entry: 'scripts/postgresql-g09-verify.ts',
    /*
     * 资源填写依据（逐条核过）：
     *   · **需要**隔离 PG 实例 + 凭据文件，**并且需要**一个 verified 的 PGlite 来源快照
     *     （缺省用 WP0 读过的那个；可用 `LG_PG_SOURCE_SNAPSHOT` 指定）。
     *     三者任一缺失 ⇒ **非零退出**并具名报 notRun（不"绿着跳过"）。
     *   · 它只**读副本**：`readPgliteTable()` 先在 `%TEMP%` 做一次性副本再打开，
     *     并自证"源目录前后摘要逐字相同"；拒绝 `--from` 指向真实库 `data/pglite`。
     *   · 自建自删 `lg_test_g09`；不碰真实库。
     *   · **必须 serial**：与其他 PG 门共用同一个实例（`L-PGW2-03`）。
     *   · 不写证据文件（只往 stdout 打报告）。
     */
    resources: { parallel: 'serial' },
    why: '需要隔离 PG 实例 + 一个 verified PGlite 来源快照（只读副本，自证源目录未动）；自建自删 lg_test_g09；必须 serial。',
  },
]

export const ALL_GATES: readonly GateSpec[] = [
  ...OFFLINE_GATES,
  ...POSTGRESQL_GATES,
  ...SUMMARY_GATES,
  ...TD_GATES,
  ...M9_GATES,
  ...M95_GATES,
  ...M10_GATES,
  ...M10_SEMANTIC_GATES,
  ...MC_GATES,
  ...M111_GATES,
  ...SUMMARY_LATE_GATES,
  ...M96_GATES,
  ...PL2_GATES,
  ...PL2_CONTROL_GATES,
  ...LV2_GATES,
  ...DESKTOP_CONTROL_GATES,
  ...SCRIPTS_GATES,
  ...PRODUCTIVITY_GATES,
]

export const LANES: readonly Lane[] = [
  {
    id: 'postgresql',
    title: 'PostgreSQL 迁移（真 PG 实例上的门）',
    gateIds: POSTGRESQL_GATES.map((gate) => gate.id),
    note:
      'PG-G02 需要**一个在跑的隔离 PG 实例**（Docker + `lg-postgresql-trial` + 凭据文件）。' +
      '**有意不并入 `offline` lane**（那条 lane 与 `pnpm m4.5:ci` 逐条等价，而核心离线 CI 不该依赖 Docker 在跑）。' +
      '拿不到实例时本门**非零退出**并具名报 notRun —— 不"绿着跳过"。' +
      '⚠️ 实例是长期存在的，门之间靠库名隔离（`lg_test_<门>`）⇒ 本 lane 内的门必须 serial。' +
      '调用：`pnpm gates:run --lane postgresql`。',
  },
  { id: 'm11.1', title: 'M11.1 离线控制', gateIds: M111_GATES.map(gate => gate.id),
    note: 'Only implemented offline controls. Formal semantic/behavior/short/long models require explicit test-model execution and frozen batch identities; never automatically repeated by fast.' },
  {
    id: 'desktop-control',
    title: 'ADR-106 桌面查看与操作（离线夹具 + 实机只读探针）',
    gateIds: DESKTOP_CONTROL_GATES.map((gate) => gate.id),
    note:
      '两道门：`desktop-control:verify`（离线夹具，秒级）与 `desktop-control:probe`（真 worker + 真实桌面，**只读**）。' +
      '**有意不并入 `offline` lane**（那条 lane 声明与 `pnpm m4.5:ci` 逐条等价）。' +
      '⚠️ 本 lane **不**主张"她能操作桌面"：真操作那道门（`desktop-control:act`）需要人在场，**不登记**在门表里。' +
      '调用：`pnpm gates:run --lane desktop-control`。',
  },
  {
    id: 'productivity',
    title: '第二批（productivity）与浏览器 sidecar 的门',
    gateIds: PRODUCTIVITY_GATES.map((gate) => gate.id),
    note:
      '两道门：`productivity:verify`（28 组离线组合，含浏览器 `browser-01…05`）与 ' +
      '`productivity:sidecar:autostart:verify`（ADR-101 自启动）。' +
      '**有意不并入 `offline` lane**（那条 lane 声明与 `pnpm m4.5:ci` 逐条等价）。' +
      '⚠️ `productivity:verify` 按设计在"只有 NOT RUN"时返回 **1**，本 lane 显式接受 [1]；' +
      '有 FAIL ⇒ 3、门抛错 ⇒ 2，两者**照样红**。唯一被接受的 NOT RUN 是 `browser-04`' +
      '（真登录态继承 / 焦点影响，需人工前置）。' +
      '⚠️ 浏览器的真机自检 `productivity:sidecar:check` **不登记**：它要一份**已连通**的扩展与' +
      '一个被共享的标签，退出码 2 = PARTIAL 是常态（见 ADR-125 的 L-PS-54）。' +
      '调用：`pnpm gates:run --lane productivity`。',
  },
  {
    id: 'offline',
    title: 'M4.5 离线门链（`pnpm m4.5:ci` 的展开，34 条）',
    gateIds: OFFLINE_GATES.map((g) => g.id),
    note:
      '内容与 `pnpm m4.5:ci` **逐条等价**（同一批命令、同一批证据文件）。' +
      '快车道只是把它们按资源冲突图调度并发，**不改任何断言**；' +
      '发布证据仍应由串行档（`--mode release`）产出。',
  },
  {
    id: 'summaries',
    title: '里程碑汇总门（只读已落盘证据，秒级）',
    gateIds: SUMMARY_GATES.map((g) => g.id),
    note: '这些门不产生新读数，只汇总已落盘证据；适合改动后的快速体检。',
  },
  {
    id: 'all',
    title: '全部已登记的门',
    gateIds: ALL_GATES.map((g) => g.id),
    note: '离线链 + 汇总门。注意：汇总门会被调度器安排在它们依赖的写门之后。',
  },
  {
    id: 'td',
    title: 'TD 专项门（搜索可靠性与隐私边界；离线、秒级）',
    gateIds: TD_GATES.map((g) => g.id),
    note:
      '这两道门**有意不并入 `offline` lane** —— 那条 lane 的公开声明是' +
      '「与 `pnpm m4.5:ci` 逐条等价」，加门会让声明变假，而发布证据必须来自冻结命令清单。' +
      '调用方式：`pnpm gates:run --lane td`（显式），或 `--lane affected` 在改动搜索层时自动带出。' +
      '⚠️ 它们**不**主张"搜索链路已经稳定"：真实限流 / 真实超时仍未现场观测（TD-10 缺口 G-2/G-7）。',
  },
  {
    id: 'm9',
    title: 'M9 信念域门（离线；计划 §16.2 登记）',
    gateIds: M9_GATES.map((g) => g.id),
    note:
      'M9 的 12 道离线门（WP0–WP8）。与 td lane 同一条纪律：**有意不并入 `offline` lane**' +
      '（那条 lane 声明与 `pnpm m4.5:ci` 逐条等价）。调用：`pnpm gates:run --lane m9`（显式），' +
      '或 `--lane affected` 在改动信念域路径时自动带出。⚠️ WP9 的 live 门（真模型）不在其中——' +
      '登记属 WP9 收口时的独立裁定；`m9:long:verify`（B32）按 M9-M95-Overlap-Audit.md CANCELLED，永不登记。',
  },
  {
    id: 'm9.5',
    title: 'M9.5 语义记忆召回门（离线；计划 §16.1 登记）',
    gateIds: M95_GATES.map((g) => g.id),
    note:
      'M9.5 的 35 道离线门（WP0–WP11）。与 td/m9 lane 同一条纪律：**有意不并入 `offline` lane**' +
      '（那条 lane 声明与 `pnpm m4.5:ci` 逐条等价）。调用：`pnpm gates:run --lane m9.5`（显式）。' +
      '⚠️ 真模型门（`m9.5:smoke:live` / `long:live`）**不在其中**——它们要真模型与端点额度，' +
      '登记属真模型档收口时的独立裁定（用户已批准端点，但四条门槛未达标 ⇒ 尚未登记）。',
  },
  {
    id: 'm10',
    title: 'M10 目标域门（离线；计划 §12 登记）',
    gateIds: M10_GATES.map((g) => g.id),
    note:
      `M10 的 ${String(M10_GATES.length)} 道离线门（WP2–WP11）。与 td/m9/m9.5 lane 同一条纪律：**有意不并入 \`offline\` lane**` +
      '（那条 lane 声明与 `pnpm m4.5:ci` 逐条等价）。调用：`pnpm gates:run --lane m10`（显式），' +
      '或 `--lane affected` 在改动目标域路径时自动带出。' +
      '⚠️ `m10:measurement:verify` 声明了 `mutatesGitWorktree` ⇒ 由调度器排到**独处时段**；' +
      '⚠️ **真模型门不在其中**：`m10:semantic:eval` / `m10:smoke:live` / `m10:long:live` 三道' +
      '都在 **`m10-semantic` lane**（已登记）。',
  },
  {
    id: 'm10-semantic',
    title: 'M10 语义档（真模型；计划 §16.1 的"三 lane 分开"之一）',
    gateIds: M10_SEMANTIC_GATES.map((g) => g.id),
    note:
      '**真模型档**：它们**真的出站**（语义门一次几百次调用；live 门一条 7 轮轨迹）⇒ 与离线 lane 分开。' +
      '调用：`pnpm with-test-model pnpm gates:run --lane m10-semantic`。' +
      '⚠️ **不带包装器时它们会如实拒跑**（exit 2，缺 `DSH_TEST_MODEL_WRAPPER` 标记）——' +
      '那是刻意的（绝不回落 `.env` 的生产 key），**不是**缺陷。' +
      '⚠️ `--lane all` 也会带上它们 ⇒ 那条 lane 要么带包装器，要么逐个 `--skip`。',
  },
  {
    id: 'memory-coverage',
    title: '「记忆体量」线门（离线；D-6 裁定后的新线，2026-09-30）',
    gateIds: MC_GATES.map((g) => g.id),
    note:
      '目前只有 **WP0 的覆盖率量具**一道。与 td/m9/m9.5/m10 lane 同一条纪律：**有意不并入 `offline` lane**' +
      '（那条 lane 声明与 `pnpm m4.5:ci` 逐条等价）。调用：`pnpm gates:run --lane memory-coverage`（显式），' +
      '或 `pnpm fast` 在改动抽取/意图路径时自动带出（见 `affected-map.ts`）。' +
      '⚠️ 它**只**测生产缺省显式路径的两道闸门（意图检测 + 内容抽取）的可达性：' +
      '不判取值正确性（`m6.1:extractor:repro`）· 不判写入结果（要库）· 不判假阳 · 不判后台路径（NOT-WIRED，归 TD-19）。',
  },
  {
    id: 'm9.6',
    title: 'M9.6（Jev 适用性）离线门（2026-10-04 登记）',
    gateIds: M96_GATES.map((g) => g.id),
    note:
      '三道离线门（契约/编排 · 量具有效性 · WP0a 判定器）。**有意不并入 `offline` lane**（那条 lane 声明与 `pnpm m4.5:ci` 逐条等价）。' +
      '⚠️ **不在其中**：`m9.6:preflight`（真的出站到官方接口，11/20 次调用）· `m9.6:probe:probability`（20 次真实调用）· ' +
      '`m9.6:compare` / `audit-compare` / `emotion:*` / `followup:*`（真模型批次或一次性研究轮）。' +
      '⇒ `m9.6:gates` 的 5/5 里有两道**只在你显式跑过后**才有新档（这是如实，不是故障）。',
  },
  {
    id: 'postlv2',
    title: 'post-Lv2 的 S8 离线门（2026-10-04 登记）',
    gateIds: PL2_GATES.map((g) => g.id),
    note:
      'S8（storyline 认知）的隔离库门；**有意不并入 `offline` lane**。' +
      '⚠️ 实测 **10 道 · 8 PASS · 2 FAIL**，两条都是**真读数**、且都不是"改动引起的"：' +
      '① `postlv2:s8:measurement:verify` —— Q7 按设计红：金标语料**尚未人审** ⇒ 如实留 `AWAITING HUMAN REVIEW`（`L-S8-22`，不自签）；' +
      '② `postlv2:db:verify` —— **MEASUREMENT INVALID**：它读到的两份快照不一致（一份 `snapshot_dir_missing`、一份 v10），' +
      '而脚本里 `LATEST_SCHEMA_VERSION = 11` 是**硬编码**（已过期：真实库 2026-10-03 已在授权下到 **v13**）⇒ ' +
      '它印出的"v11 从未被应用到真实库"是**错的**。见登记册 §0p `R-40`。' +
      '⚠️ **不在 lane 里**：真模型档（`postlv2:s8:semantic:eval` / `semantic:recompute` / `s8:dev-probe` / `s7:live`）· ' +
      '真库档（`postlv2:s8:activation-readback:db` **要开真实库**，属 INC-01 受控路径）· 需要窗口/设备的档（`postlv2:mic` / `postlv2:avatar`）。' +
      '非 S8 的 post-Lv2 门（story/source/world/body/speech/tts/avatar/expression…）**多数**仍未登记，属另一条工作流；' +
      '⏩ **2026-10-07**：其中 4 道已按"逐文件核过离线安全"登记进 `postlv2-controls`（`body` 在其中；`expression`/`speech`/`tts`/`avatar` 因外部 venv 或设备依赖**仍不登记**）。',
  },
  {
    id: 'postlv2-controls',
    title: 'post-Lv2 新增离线控制（2026-10-05 登记；`AUD-20261005-03`）',
    gateIds: PL2_CONTROL_GATES.map((g) => g.id),
    note:
      '取消连续性 · 目标期限/并行 · 角色工具决策目录与限定路径 · **选档器自证**六道；**有意不并入 `offline` lane**' +
      '（那条 lane 声明与 `pnpm m4.5:ci` 逐条等价）。调用：`pnpm gates:run --lane postlv2-controls`（显式），' +
      '或 `--lane affected` 在改动它们测量的面时自动带出（见 `affected-map.ts`）。' +
      '⏩ **2026-10-07 追加 4 道离线门**（`transport` · `delivery` · `body` · `qq:reconnect`）：' +
      '它们此前**不在任何 lane 里**（本轮逐文件核过"离线安全"才登记，见该组上方的注释）。' +
      '⚠️ **不在其中**（各自的原因是可复核的事实）：`postlv2:semantic:verify`（依赖 gitignored 本地编码器资产）· ' +
      '`postlv2:semantic:production:verify`（**读活库**做副本）· `postlv2:role-tool:matrix`（依赖三处 gitignored 本地资产 + 真跑 python/OCR）· ' +
      '`postlv2:role-tool:known-dirs`（读数依赖本机环境，且会把真实桌面路径写进证据）· `postlv2:goal-thinking-eval`（**真出站**）· ' +
      '**`postlv2:expression:verify`**（Python 侧调 `~/postlv2-deps/qwen3-tts-venv` **外部 venv**）· ' +
      '**`postlv2:automatic-memory:verify`**（依赖 `CHARACTER_MEMORY_AUTOMATIC_PYTHON` 指向的 langmem venv）· ' +
      '**`postlv2:coexist:verify`**（起两条 loopback + 核对真实库树摘要；用户核心在跑时会租约冲突）· ' +
      '**`postlv2:bridge:verify`**（起 ElizaOS 运行时，且脚本内有真实库判据）。' +
      '⚠️ `postlv2:sequence-continuity:verify` **故意慢**（7 次 `src/main.ts` 启动）⇒ 声明 `serial`；' +
      '它的证据目录名固定 ⇒ 重跑覆盖同一份文件（见该门 `why`）。',
  },
  {
    id: 'lv2',
    title: 'Lv2 综合验收离线门（2026-10-04 登记）',
    gateIds: LV2_GATES.map((g) => g.id),
    note:
      '核心 / 修复 / 量具 / 隐私预算 / 回归读回五道；**有意不并入 `offline` lane**。' +
      '⚠️ **不在其中**：真模型档（`lv2:short:live`）· 会改写工作树（`lv2:corpus:freeze`）· ' +
      '只读汇总门（`lv2:gates` / `lv2:inherited:gates` 在 **summaries** lane）。' +
      '⚠️ `lv2:inherited:gates` 会如实报出各里程碑的**继承读数**（其中 `m4.5` 的 G14 仍 FAIL）——那是真读数。',
  },
  {
    id: 'summaries-all',
    title: '全里程碑只读汇总门（21 道，含更晚里程碑；2026-10-04 新增）',
    gateIds: [...SUMMARY_GATES, ...SUMMARY_LATE_GATES].map((g) => g.id),
    note:
      '`summaries` 的**超集**：多出 M6.1/M7/M8/M8.5/M9/M9.1/M9.5/M9.6/M10.1/M11/M11.1/Lv2/post-Lv2 的只读汇总门。' +
      '⚠️ **实测（2026-10-04）21 道 · 15 PASS · 6 FAIL（exit 1）**，而 `summaries` 本身当下也是 **6 PASS / 1 FAIL**' +
      '（`m5.1:gates` 承接 `m4.5` 的 G14 FAIL —— 登记册 §0m `R-36` 已登记，不是本批引入的）。' +
      '本组新增的 5 道 FAIL 同样是各自里程碑的真读数：`m6.1:gates`（失败关闭如实拒收，exit=2）· `m9:gates`（11/13）· ' +
      '`m11.1:gates`（NOT PASS）· `lv2:gates` / `lv2:inherited:gates`（继承读数）。' +
      '⇒ 它是**体检**，不是"应当全绿"的交付门；变更前请先读各里程碑自己的判定载体。' +
      '调用：`pnpm gates:run --lane summaries-all`（墙钟约 15 秒）。',
  },
  {
    id: 'scripts',
    title: '脚本清单门（`P2-11`；离线、只读）',
    gateIds: SCRIPTS_GATES.map((gate) => gate.id),
    note:
      '一条只读门：重算 `docs/architecture/Scripts-Catalog.md` 并与已提交的那份逐字节比较。' +
      '**有意不并入 `offline` lane**（那条 lane 的公开声明是"与 `pnpm m4.5:ci` 逐条等价"）。' +
      '调用：`pnpm scripts:gates`（= `pnpm gates:run --lane scripts`）。' +
      '⚠️ 它**不**主张"脚本命名已经收敛"：它只保证清单与现实一致 —— ' +
      '改名 / 合并 / 删除条目是**破坏性变更**（文档与 ADR 大量逐字引用这些名字），需要独立裁定。',
  },
  {
    id: 'affected',
    title: '按改动面推导（`AGENTS.md` §5 的机器版）',
    fromChangedPaths: true,
    note:
      '由 `git diff` + 未跟踪文件推导"该跑哪些门"。**未匹配到任何规则**的改动会强制加入' +
      '保守集合，并在 run.json 里记 `unmatchedPaths` —— 这种运行**不构成**任何交付证据。',
  },
]

export function laneById(id: string): Lane | undefined {
  return LANES.find((lane) => lane.id === id)
}

export function gatesByIds(ids: readonly string[]): GateSpec[] {
  const byId = new Map(ALL_GATES.map((g) => [g.id, g]))
  return ids.map((id) => byId.get(id)).filter((g): g is GateSpec => g !== undefined)
}
