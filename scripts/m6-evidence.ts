/**
 * M6 —— **证据与清单的共享校验**（`m6:measurement:verify` 与 `m6:gates` 共用同一份判据）。
 *
 * ============================================================================
 *  为什么它必须只有一处
 * ============================================================================
 * "这份证据算不算有效"这个问题有两个消费者：
 *
 * ```text
 *   m6:measurement:verify   量具资格化：往这些校验里**注入假象**，必须每次都响
 *   m6:gates                只读汇总：缺文件 = NOT RUN，绝不当成 PASS
 * ```
 *
 * 如果两处各写一份，会出现"量具说它能抓 X、汇总却按另一套规则读"，而那种分歧
 * 在输出上表现为**两边都是绿的**。因此校验只有这一份，量具的任务是**证明它会响**。
 *
 * ⚠️ 本模块**不跑测试、不写 verdict、不碰数据库**：它是纯函数集合。
 */

// ---------------------------------------------------------------------------
// 门登记表（`m6:gates` 的唯一输入）
// ---------------------------------------------------------------------------

export interface M6GateSpec {
  readonly id: string
  readonly label: string
  /** 产出它的命令（**只用于展示与人工复核**，`m6:gates` 不会执行它） */
  readonly command: string
  /** 证据 `schemaVersion`（用来把落盘 JSON 归到某个门） */
  readonly schemaVersion: string
  /**
   * 这个门的**可接受判决**（不是所有门都用 `PASS` 这个词）。
   *
   * 例如 WP0 的基线不说"通过/失败"，它说 `BASELINE CAPTURED`（那才是它的命题）。
   * 把这层映射写成登记表字段，而不是在汇总里靠"看到不认识的就当失败/当通过"——
   * 后者会同时制造假红与假绿。
   */
  readonly acceptVerdicts: readonly string[]
  /** 必选门：缺失 ⇒ overall 不能是 PASS */
  readonly required: boolean
}

/**
 * 已落地的 M6 门。
 *
 * 只登记**真实存在**的门。计划书 §8 的 M6-G0…G12 是**判据**层级；这里登记的是
 * 承载它们的**可执行门**。两者的对应关系写在 `M6-Acceptance-Report` 里，
 * 不在这里重复（一处一个名字）。
 */
export const M6_GATE_SPECS: readonly M6GateSpec[] = [
  {
    id: 'wp0-baseline',
    label: 'WP0 基线与前置核对',
    command: 'pnpm exec tsx scripts/m6-wp0-baseline.ts --out artifacts/m6/<runId>',
    schemaVersion: 'm6-wp0-baseline@1',
    acceptVerdicts: ['BASELINE CAPTURED'],
    required: true,
  },
  {
    id: 'wp2-rollup-unit',
    label: 'WP2 摘要纯逻辑部件门',
    command: 'pnpm exec tsx scripts/verify-m6-wp2-rollup.ts',
    schemaVersion: 'm6-wp2-rollup-unit@1',
    acceptVerdicts: ['PASS'],
    required: true,
  },
  {
    id: 'wp3-wiring',
    label: 'WP3 接线门（packet 级 R-2 负控）',
    command: 'pnpm exec tsx scripts/verify-m6-wp3-wiring.ts',
    schemaVersion: 'm6-wp3-wiring@1',
    acceptVerdicts: ['PASS'],
    required: true,
  },
  {
    id: 'wp3-reader',
    label: 'WP3 只读来源读取面门（隔离库）',
    command: 'pnpm exec tsx scripts/verify-m6-wp3-reader.ts',
    schemaVersion: 'm6-wp3-reader@1',
    acceptVerdicts: ['PASS'],
    required: true,
  },
  {
    id: 'wp4-measurement',
    label: 'WP4 量具资格化（8 类注入 × 三段式 + 命令面守卫）',
    command: 'pnpm m6:measurement:verify',
    schemaVersion: 'm6-wp4-measurement@1',
    acceptVerdicts: ['PASS'],
    required: true,
  },
  {
    id: 'wp5-console',
    label: 'WP5 开发者面（摘要事实的派生与页面纪律）',
    command: 'pnpm exec tsx scripts/verify-m6-wp5-console.ts',
    schemaVersion: 'm6-wp5-console@1',
    acceptVerdicts: ['PASS'],
    required: true,
  },
  {
    id: 'wp6a-faults',
    label: 'WP6a 降级与动作真相（四层读数 × 5 类故障）',
    command: 'pnpm exec tsx scripts/verify-m6-wp6a-faults.ts',
    schemaVersion: 'm6-wp6a-faults@1',
    acceptVerdicts: ['PASS'],
    required: true,
  },
  {
    id: 'wp6b-restart-recovery',
    label: 'WP6b 重启/关闭/恢复（INC-01 保护的集成验收）',
    command: 'pnpm exec tsx scripts/verify-m6-wp6b.ts',
    schemaVersion: 'm6-wp6b-restart-recovery@1',
    acceptVerdicts: ['PASS'],
    required: true,
  },
  {
    id: 'wp7a-e2e',
    label: 'WP7a A–E 自然语言剧情 + 摘要/召回跨模块',
    command: 'pnpm exec tsx scripts/verify-m6-wp7a.ts',
    schemaVersion: 'm6-wp7a-e2e@1',
    acceptVerdicts: ['PASS'],
    required: true,
  },
  {
    id: 'wp7b-e2e',
    label: 'WP7b 跨午夜/时区/三个时间通道 + 同轮预算竞争 + 本地评审包',
    command: 'pnpm exec tsx scripts/verify-m6-wp7b.ts',
    schemaVersion: 'm6-wp7b-e2e@1',
    acceptVerdicts: ['PASS'],
    required: true,
  },
  {
    id: 'wp8-scale',
    label: 'WP8 规模与性能（1k→10k · ≥10k 事件回放 · 三种计数分开）',
    command: 'pnpm exec tsx scripts/verify-m6-wp8.ts',
    schemaVersion: 'm6-wp8-scale@1',
    acceptVerdicts: ['PASS'],
    required: true,
  },
  {
    id: 'wp8-retrieval-boundary',
    label: 'WP8 检索覆盖上界（第 500 行边界内外，单列）',
    command: 'pnpm exec tsx scripts/verify-m6-wp8.ts',
    schemaVersion: 'm6-wp8-retrieval-boundary@1',
    acceptVerdicts: ['PASS'],
    required: true,
  },
  {
    id: 'wp9a-calibration',
    label: 'WP9a 长对话校准（50/100 轮，测试端点）+ 阈值包 M6-D3',
    command: 'pnpm with-test-model pnpm exec tsx scripts/verify-m6-wp9a-calibration.ts',
    schemaVersion: 'm6-wp9a-calibration@1',
    acceptVerdicts: ['PASS'],
    required: true,
  },
  {
    id: 'wp9a2-judge-discrimination',
    label: 'WP9a-2 judge 区分度修复（绝对 vs 对比式，统计判据）+ M6-D3 rev2',
    command: 'pnpm with-test-model pnpm exec tsx scripts/verify-m6-wp9a2-discrimination.ts',
    schemaVersion: 'm6-wp9a2-discrimination@1',
    acceptVerdicts: ['PASS'],
    required: true,
  },
  {
    id: 'wp9b-long-dialogue',
    label: 'WP9b 500 轮正式长对话（3 条独立轨迹；冻结阈值 rev2）',
    command: 'pnpm with-test-model pnpm exec tsx scripts/verify-m6-wp9b-long-dialogue.ts',
    schemaVersion: 'm6-wp9b-long-dialogue@1',
    acceptVerdicts: ['PASS'],
    required: true,
  },
  {
    id: 'wp10a-final-offline',
    /*
     * ⚠️ 条数**不在这条 label 里写死**（TD-15）：唯一来源是
     * `verify-m6-wp10a-final-offline.ts` 的 `PLAN_10_1`，运行时报在 R1 段。
     * 历史 label 曾写"39 条"而清单实际是 32 条 —— 正是"数字对不上话"的那类漂移。
     */
    label: 'WP10a 最终候选离线门与全量回归（计划书 §10.1 全部离线门 + INC-01 + M6 离线 + 回归）',
    command: 'pnpm exec tsx scripts/verify-m6-wp10a-final-offline.ts --finalize',
    schemaVersion: 'm6-wp10a-regression@1',
    acceptVerdicts: ['PASS'],
    required: true,
  },
  {
    id: 'wp10b-live',
    /*
     * ⚠️ 它的可接受判决目前**达不到**：M6 自己的 Live 全绿，但两道受影响的 Live 复验
     *    因**本机 SearXNG 不可达**而按设计具名拒绝（NOT RUN，不是 FAIL）⇒ 判定 `PARTIAL`。
     *    登记成必选门是**有意的**：它让 `m6:gates` 如实显示"Live 半边没测完"，
     *    而不是把"没测"混进一个绿色的总数（计划书：Live 为必需；不运行则交付状态保留未完成）。
     */
    label: 'WP10b 最终候选 Live（production-copy + 受影响 Live 复验）',
    command: 'pnpm with-test-model pnpm exec tsx scripts/verify-m6-wp10b-live.ts',
    schemaVersion: 'm6-wp10b-live@1',
    acceptVerdicts: ['PASS'],
    required: true,
  },
]

// ---------------------------------------------------------------------------
// manifest 校验（计划书 §9.2 的字段集）
// ---------------------------------------------------------------------------

/** §9.2 要求的字段名（**清单本身**也是判据：少一个字段就是一个未登记的缺口） */
export const M6_MANIFEST_REQUIRED_FIELDS: readonly string[] = [
  'runId',
  'testType',
  'codeCommit',
  'runRelevantTreeSha',
  'workingTreeExceptions',
  'commands',
  'toolVersions',
  'fixtureRubricThresholdHashes',
  'nonSecretConfigFingerprint',
  'startedAt',
  'finishedAt',
  'counts',
  'evidence',
  'sandboxIdentity',
  'realDbProtection',
  'exclusions',
]

export interface ManifestProblem {
  readonly code: string
  readonly detail: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 校验一份 manifest。
 *
 * 六类问题（每类都是**真实事故形态**，不是理论）：
 * ```text
 *   manifest_missing_field      缺 §9.2 的字段 ⇒ 这份证据不完整，不能参与汇总
 *   manifest_zero_counts        执行数 = 0 ⇒ MEASUREMENT INVALID（"检查了 0 项"不是 PASS）
 *   manifest_skipped_silently   退出码 0 却有 skipped 且没有说明 ⇒ 假绿（注入 #1）
 *   manifest_stale_commit       codeCommit 与证据自己记的 head 不一致 ⇒ 旧提交的结果（注入 #2）
 *   manifest_unresolved_evidence 证据条目缺 SHA-256 或路径 ⇒ 无法核验归属
 *   manifest_failed_runs_dropped 尝试数 > 完成 + 跳过，且没有失败清单（注入 #8）
 * ```
 */
export function validateManifest(manifest: unknown): ManifestProblem[] {
  const problems: ManifestProblem[] = []
  if (!isRecord(manifest)) {
    return [{ code: 'manifest_not_object', detail: 'manifest 不是对象' }]
  }
  for (const field of M6_MANIFEST_REQUIRED_FIELDS) {
    if (!(field in manifest)) {
      problems.push({ code: 'manifest_missing_field', detail: `缺字段 ${field}` })
    }
  }

  const counts = isRecord(manifest.counts) ? manifest.counts : undefined
  if (counts !== undefined) {
    const executed = Number(counts.executed ?? 0)
    const completed = Number(counts.completed ?? 0)
    const skipped = Number(counts.skipped ?? 0)
    const failed = Number(counts.failed ?? 0)
    if (executed <= 0) {
      problems.push({
        code: 'manifest_zero_counts',
        detail: `executed = ${executed}：检查了 0 项不是 PASS（MEASUREMENT INVALID）`,
      })
    }
    // 注入 #1：退出码 0 却有跳过项，而没人说明"跳过了什么"
    if (skipped > 0 && !Array.isArray(manifest.skippedReasons)) {
      problems.push({
        code: 'manifest_skipped_silently',
        detail: `skipped = ${skipped} 但没有 skippedReasons：跳过必须有理由，否则与"没测"看起来一样`,
      })
    }
    // 注入 #8：尝试了 5 次、完成 3、跳过 0、失败 0 —— 剩下 2 次去哪了？
    if (executed > completed + skipped + failed) {
      problems.push({
        code: 'manifest_failed_runs_dropped',
        detail:
          `executed(${executed}) > completed(${completed}) + skipped(${skipped}) + failed(${failed})：` +
          '失败轮次被丢弃了（"重试后的好回复覆盖坏回复"是同一类）',
      })
    }
  }

  // 注入 #2：证据自称的 head 与 manifest 的 codeCommit 不一致 ⇒ 旧提交/默认路径的结果
  const head = typeof manifest.head === 'string' ? manifest.head : undefined
  const codeCommit = typeof manifest.codeCommit === 'string' ? manifest.codeCommit : undefined
  if (head !== undefined && codeCommit !== undefined && head !== codeCommit) {
    problems.push({
      code: 'manifest_stale_commit',
      detail: `codeCommit(${codeCommit.slice(0, 7)}) ≠ 证据自称的 head(${head.slice(0, 7)})`,
    })
  }

  const evidence = Array.isArray(manifest.evidence) ? manifest.evidence : []
  for (const item of evidence) {
    if (!isRecord(item) || typeof item.path !== 'string' || typeof item.sha256 !== 'string') {
      problems.push({
        code: 'manifest_unresolved_evidence',
        detail: '有一条证据缺 path 或 sha256 ⇒ 无法核验"这份读数是哪来的"',
      })
    }
  }

  return problems
}

// ---------------------------------------------------------------------------
// 逐门证据校验
// ---------------------------------------------------------------------------

export interface GateEvidenceProblem {
  readonly code: string
  readonly detail: string
}

/**
 * 摘要相关证据的**共同形状**（WP2 部件门 / WP3 接线门 / WP3 读取面门都有）。
 *
 * 注入 #6 就落在这一条上：**正控数为 0 却报 PASS** = "系统靠永远不摘要过门"的假绿。
 */
export function validateRollupEvidence(payload: unknown): GateEvidenceProblem[] {
  const problems: GateEvidenceProblem[] = []
  if (!isRecord(payload)) return [{ code: 'evidence_not_object', detail: '证据不是对象' }]
  const passed = Number(payload.passed ?? 0)
  const failed = Number(payload.failed ?? 0)
  const invalid = Number(payload.measurementInvalid ?? 0)
  const verdict = String(payload.verdict ?? '')

  if (passed <= 0) {
    problems.push({
      code: 'rollup_no_positive_example',
      detail: `passed = ${passed}：一条正控都没过，却声称有结论 —— "永远不摘要"也能满足这种门`,
    })
  }
  if (verdict === 'PASS' && (failed > 0 || invalid > 0)) {
    problems.push({
      code: 'rollup_pass_with_failures',
      detail: `verdict=PASS 但 failed=${failed} / invalid=${invalid}`,
    })
  }
  if (verdict === 'MEASUREMENT INVALID') {
    problems.push({
      code: 'rollup_measurement_invalid',
      detail: '证据自己声明 MEASUREMENT INVALID ⇒ 它不能参与汇总',
    })
  }
  /*
   * ⚠️ 这条检测**改过一次**（WP10a 抓出来的）：原来只认 `scope` / `counters` 两个键，
   *    而 M6 的 payload 把计数放在 `checks` / `totals` 里、把范围写成 **字符串** `scope`
   *    ⇒ 8 道门被误报"无法回答这份读数测的是什么范围"（假警告）。
   *    正确形状：**任一种**能把"范围 + 计数"说清楚的写法都算过 ——
   *    记录型 `scope` / 记录型 `counters` / 非空字符串 `scope` / 成对的 `checks`+`totals`。
   *    （判据更正，不是放宽：它现在能认出的信息**更多**，不是更少。）
   */
  const hasObjectScope = isRecord(payload.scope)
  const hasCounters = isRecord(payload.counters)
  const hasStringScope = typeof payload.scope === 'string' && payload.scope.trim() !== ''
  const hasChecksAndTotals = isRecord(payload.checks) && isRecord(payload.totals)
  if (!hasObjectScope && !hasCounters && !hasStringScope && !hasChecksAndTotals) {
    problems.push({
      code: 'rollup_scope_missing',
      detail:
        '既没有 scope 也没有 counters（以及成对的 checks+totals）⇒ 无法回答"这份读数测的是什么范围"',
    })
  }
  return problems
}

/**
 * 一轮摘要的"**选了 ≠ 入模**"检测（注入 #5）。
 *
 * ```text
 *   选择的条数 > 0   而   section 没活过裁剪（sectionSurvived = false）
 *   ⇒ 若任何人把"实际入模"记成 selected，那就是把 ADR-050 DR-9 要防的那件事写进了证据
 * ```
 */
export function detectChosenButNotInjected(input: {
  selectedCount: number
  sectionSurvived: boolean
  claimedInjectedCount: number
}): GateEvidenceProblem[] {
  if (input.claimedInjectedCount > 0 && !input.sectionSurvived) {
    return [
      {
        code: 'chosen_but_not_injected',
        detail:
          `声称入模 ${input.claimedInjectedCount} 条，但 section 没活过裁剪` +
          `（选中 ${input.selectedCount} 条）—— "选了"不等于"入模"`,
      },
    ]
  }
  return []
}

// ---------------------------------------------------------------------------
// 两个独立检测器（计划书 §WP4 的注入 #4 / #7）
// ---------------------------------------------------------------------------

/**
 * **不可得却写成 0**（注入 #4 的前半）。
 *
 * ```text
 *   token / usage 这一类读数有两种"0"：
 *     真的量到了 0         —— 可以写 0
 *     根本量不到（不可得）  —— **必须写 null / 缺省**，写 0 是把"不知道"伪装成"确定"
 * ```
 * 这是本仓库已经登记过的形态（`kernel-tests-m5.5.1.ts` 的"不可得记 null，不伪装成 0"）。
 */
export function detectUnavailableWrittenAsZero(input: {
  reportedTokens: number | null
  tokensAvailable: boolean
}): GateEvidenceProblem[] {
  if (!input.tokensAvailable && input.reportedTokens === 0) {
    return [
      {
        code: 'unavailable_written_as_zero',
        detail: '读数不可得却写成了 0 —— "不知道"被伪装成了"确定"',
      },
    ]
  }
  return []
}

/**
 * **长对话的轮数与重复**（注入 #7）。
 *
 * 两件事一起查：
 * ```text
 *   声称 500 轮，实际只观察到 50 个不同的 turn  —— 只跑 50 轮却标 500
 *   同一个 turn 出现两次                          —— 断点重复输入导致的重复写入
 * ```
 */
export function validateLongDialogueEvidence(payload: unknown): GateEvidenceProblem[] {
  const problems: GateEvidenceProblem[] = []
  if (!isRecord(payload)) return [{ code: 'long_dialogue_not_object', detail: '证据不是对象' }]
  const claimed = Number(payload.claimedRounds ?? 0)
  const turnIds = Array.isArray(payload.observedTurnIds) ? payload.observedTurnIds.map(String) : []
  const distinct = new Set(turnIds)
  if (claimed > distinct.size) {
    problems.push({
      code: 'round_count_mismatch',
      detail: `声称 ${claimed} 轮，实际只有 ${distinct.size} 个不同的 turn`,
    })
  }
  if (distinct.size < turnIds.length) {
    problems.push({
      code: 'duplicate_turns',
      detail: `出现 ${turnIds.length - distinct.size} 个重复 turn（断点续跑没有去重？）`,
    })
  }
  return problems
}

// ---------------------------------------------------------------------------
// 从落盘证据里取 verdict（`m6:gates` 用；**只读**）
// ---------------------------------------------------------------------------

export interface LandedEvidence {
  readonly path: string
  readonly schemaVersion: string
  readonly verdict: string
  readonly passed: number
  readonly failed: number
  readonly measurementInvalid: number
  readonly head: string | null
  readonly generatedAt: string | null
  readonly problems: readonly GateEvidenceProblem[]
}

/**
 * 读一份落盘证据并**如实**报出它的结论。
 *
 * ⚠️ 缺字段 ⇒ 空串/0，而**不是**默认 PASS。`m6:gates` 对空 verdict 的处理是
 * `NOT RUN`（计划书 §8.3：文件不存在 = `not-run`，不是 PASS）。
 */
export function readLandedEvidence(path: string, text: string): LandedEvidence | undefined {
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(payload)) return undefined
  return {
    path,
    schemaVersion: String(payload.schemaVersion ?? ''),
    verdict: String(payload.verdict ?? ''),
    passed: Number(payload.passed ?? 0),
    failed: Number(payload.failed ?? 0),
    measurementInvalid: Number(payload.measurementInvalid ?? 0),
    head: typeof payload.head === 'string' ? payload.head : null,
    generatedAt: typeof payload.generatedAt === 'string' ? payload.generatedAt : null,
    problems:
      String(payload.schemaVersion ?? '').startsWith('m6-wp0-baseline')
        ? [] // 基线不是"通过/失败"型证据，它的判据是 verdict 字符串本身
        : validateRollupEvidence(payload),
  }
}
