/**
 * 命令行调用的**分类**：哪些调用不该要求模型可达。
 *
 * ============================================================================
 *  这个模块为什么存在
 * ============================================================================
 * 它原本是 `main.ts` 里的一行布尔表达式。抽出来的唯一理由是
 * **它需要被测试** —— 而 `main.ts` 在模块加载时会无条件执行 `main()`，
 * 因此不能被任何测试导入。
 *
 * 抽出来之后，这条规则才有了"能被机器发现"的形态：
 * 一个纯函数，输入 argv，输出"是否需要模型连通性"。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 它守的是一个**实测到的操作性缺陷**
 * ---------------------------------------------------------------------------
 * `preflight()` 会真的发一次 `/chat/completions` 探测连通性，
 * 而它挡在 `memory:*` / `--kernel-status` / `--seed-status` 这些
 * **纯本地只读**命令前面。实测：
 *
 *     pnpm memory:audit
 *     → 模型连通性检查失败 (HTTP 522)
 *
 * 而那个命令读的是本地 `memory_records` 表，一次模型都不调。
 *
 * 后果不是"慢一点"，而是**在最需要审计的时候审计不了**：
 * 服务商抖动 / 限流 / 下线时，正好是最想看看"她到底记住了什么"的时候。
 *
 * `--migrate` 早先就因为同类理由（"迁移与模型无关"）被放在
 * preflight 之前；这里把同一条理由推广到全部只读命令，
 * 并且用测试锁住，免得下次有人"顺手"把它挪回去。
 */

/**
 * 需要模型连通性探测的调用 —— **只包括真的会调模型的那些**。
 *
 * 注意本函数回答的是"要不要发那次网络探测"，**不是**
 * "要不要 API Key"。只读命令仍然要求 Key 存在（运行时装配需要它）。
 * 把两件事分开是刻意的：合并会让人以为"只读命令可以完全没有 Key"。
 */
const READ_ONLY_FLAGS: readonly string[] = [
  // Memory Admin API（计划书第 133 节）：读本地四张表
  '--memory-list',
  '--memory-get',
  '--memory-history',
  '--memory-sources',
  '--memory-stats',
  '--memory-audit',
  '--automatic-memory-status',
  '--automatic-memory-retry',
  '--memory-retract',
  '--memory-replay',
  /*
   * S8 / L-S8-09：故事体验撤回入口。它是**写操作**，但同样**不需要探测模型连通性**
   * —— 与 memory:* 同一条理由："要撤回"最可能发生在服务商抖动时。
   */
  '--story-withdraw',
  /*
   * S8 / `L-S8-30` + `ADR-107` `R-2a′`：故事 run 的**显式开始**入口。
   * ⚠️ 同样是**写操作**（写世界账本第一条提交），同样**不需要探测模型连通性**。
   * ⚠️ **再次点明这份名单的语义**：它叫 `READ_ONLY_FLAGS`，但它回答的是
   *    "要不要发那次网络探测"，**不是**"这个命令只读"（模块头 `:36-40` 已把两件事分开）。
   *    本仓库里**已经**有 `--memory-retract` / `--story-withdraw` 两个写操作在名单里；
   *    改名单名/拆名单是另一件跨里程碑的事，**不在这里顺手做**。
   */
  '--story-start',
  // M4.5 Action Admin（计划书 §31）：读 character_action_events 一张表。
  // 与 memory:* 同一条理由 —— "她到底做了什么"最需要被查的时候，
  // 常常正是模型服务抖动 / 限流 / 下线的时候。
  '--action-list',
  '--action-show',
  '--action-trace',
  '--action-audit',
  // 只读视图
  '--kernel-status',
  '--seed-status',
  '--inspect',
  '--dump-prompt',
  /*
   * M5.1 WP2：开发者查询面（`--dev-server`）。
   *
   * 与 `memory:*` 同一条理由，而且更强：这条路径**从来不调模型**
   * ——它把既有的只读视图（trace / memory 诊断 / 执行账本）用 HTTP 摊开。
   * 因此"服务商抖动时更要能查"在这里同样成立。
   *
   * ⚠️ 它只是"不探测连通性"，**不是**"不需要 Key"：
   *    Key 的存在性检查仍然保留（运行时装配需要它）。
   */
  '--dev-server',
]

/**
 * 这次调用是不是**只读**的（因而不该要求模型可达）。
 *
 * `memory` 这个裸位置参数也算：`pnpm memory:list` 之类的脚本
 * 传的是 `memory list ...`（见 `parseMemoryAdminArgs`）。
 */
export function isReadOnlyInvocation(argv: readonly string[]): boolean {
  return argv.some(
    (arg) => arg === 'memory' || arg === 'action' || READ_ONLY_FLAGS.includes(arg)
  )
}

/**
 * ⚠️ **"不要求模型连通性" ≠ "只读"**（2026-10-01 拆开）。
 *
 * ```text
 * 上面那把清单**同时**承担了两件事：① 只读 ② 不要求模型可达（见 `isReadOnlyInvocation` 的注释）。
 * 而 M9.5 的 `--maintain-index` 把两件**分开**了：
 *   · **不**只读 —— 它会写派生四表
 *   · **但**也不需要**聊天模型** —— 它要的是**编码器**（本地 worker）
 * ⇒ 塞进 `READ_ONLY_FLAGS` 会让"它只读"成为**假陈述**，而那把锁存在的理由恰恰是"别把写当成读"。
 * ⇒ 因此**另立**这一条：**只有**"要不要探模型"这一件事。
 * ```
 */
const NO_MODEL_REQUIRED_FLAGS: readonly string[] = [
  /* M9.5 / WP7-A：受控的"跑一轮索引维护"模式 —— 写派生表，但不用聊天模型 */
  '--maintain-index',
]

/** 这次调用**要不要**探测模型连通性（= 不是只读 **且** 不在"不需要模型"那张清单里） */
export function requiresModelConnectivity(argv: readonly string[]): boolean {
  if (isReadOnlyInvocation(argv)) return false
  return !argv.some((arg) => NO_MODEL_REQUIRED_FLAGS.includes(arg))
}

/**
 * 供文档与测试共用的一份清单说明。
 *
 * `--migrate` **不在**这个清单里：它有自己的更早的分支
 * （在 preflight 之前就 return 了），因此它既不需要连通性
 * 也不需要 Key。把两件事混在一起会让"为什么 migrate 特殊"
 * 变得看不出来。
 */
export function describeReadOnlyInvocation(): string {
  return (
    '只读命令（不要求模型连通性）：' +
    [...READ_ONLY_FLAGS, 'memory <子命令>', 'action <子命令>'].join(' / ') +
    '；另有 --migrate 走更早的分支（连 Key 都不需要）'
  )
}
