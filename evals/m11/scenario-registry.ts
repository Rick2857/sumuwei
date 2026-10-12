/**
 * M11 WP9 —— **64 个必测场景的登记册**（计划 §10 的 S01–S64）。
 *
 * ============================================================================
 *  这份登记册的用途
 * ============================================================================
 * 计划 §10 逐字：「以下是必须覆盖的**场景**，不是承诺最终只有 64 条断言。
 * 每个场景记录输入、预期、真实 observed、命中的理由码、trace/事件关联和退出码。」
 *
 * ⇒ 本文件把 64 个场景变成**可机器核对**的登记册：
 *   · 每个场景有 `family`（A–H，与计划一致）、`disposition`（**实现** / **未跑**）、`evidence`（在哪被跑）
 *   · **未跑**的场景必须写 `notRunReason` —— 不允许"静默通过"
 *   · `m11:e2e:verify` 断言：64 个 id 齐全、分组正确、**未跑的那些都有具名理由**
 *
 * ⚠️ 纯数据 + 纯函数：没有 SQL、没有 `node:*`、不调模型。
 */

export type ScenarioFamily = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H'

export const SCENARIO_FAMILY_TITLES: Readonly<Record<ScenarioFamily, string>> = {
  A: '来源、权威与旧契约',
  B: '反思候选与审查',
  C: '有限行为调整',
  D: '跨域与撤回',
  E: '任务、恢复与时序',
  F: '上下文、回复与隐私',
  G: '量具、旧链回归与激活',
  H: '行为成长、长轨迹与连续性',
}

/**
 * `implemented` = 本里程碑的**离线**门真的跑过它（`evidence` 指明在哪）；
 * `not_run` = 尚未跑，**必须**有 `notRunReason`（人审 / 真模型 / 长链 / 激活类）。
 */
export type ScenarioDisposition = 'implemented' | 'not_run'

export interface ScenarioEntry {
  readonly id: string
  readonly family: ScenarioFamily
  readonly title: string
  readonly disposition: ScenarioDisposition
  /** 跑它的门（`implemented` 时必填） */
  readonly evidence?: string
  /** 未跑时的**具名**理由（`not_run` 时必填） */
  readonly notRunReason?: string
}

export const M11_SCENARIOS: readonly ScenarioEntry[] = [
  // A 来源、权威与旧契约（S01–S08）
  { id: 'S01', family: 'A', title: '同一 user event 经多条派生链进入', disposition: 'implemented', evidence: 'm11:lineage:verify D1/D5' },
  { id: 'S02', family: 'A', title: '三个不同根、两个会话的合法反馈', disposition: 'implemented', evidence: 'm11:adaptive:verify A1' },
  { id: 'S03', family: 'A', title: '异角色 / 异用户 / 错误 namespace 引用', disposition: 'implemented', evidence: 'm11:lineage:verify B3/D10' },
  { id: 'S04', family: 'A', title: '缺根、循环、父晚于子、超限', disposition: 'implemented', evidence: 'm11:lineage:verify D6–D11' },
  { id: 'S05', family: 'A', title: 'M9.5 fixture 的固定 revision 与真实 revision 不同', disposition: 'implemented', evidence: 'm11:wp0:verify P8 + m11:lineage:verify E1/E2' },
  { id: 'S06', family: 'A', title: '助手说"完成了"而用户没报告', disposition: 'not_run', notRunReason: '需要真实模型理解 + 人审（WP10 的语义/行为门），离线门只测结构' },
  { id: 'S07', family: 'A', title: '用户报告与 Action 成功分别输入', disposition: 'not_run', notRunReason: '依赖 M4.5 执行链的真实运行（Live），留给 WP10' },
  { id: 'S08', family: 'A', title: 'goal/commitment/row 三段 revision 不同', disposition: 'implemented', evidence: 'm11:wp0:verify P1（M10 只读契约 §1.1 的机器判据）' },
  // B 反思候选与审查（S09–S16）
  { id: 'S09', family: 'B', title: '明确更正带合法来源 ⇒ 非零 pending 候选', disposition: 'implemented', evidence: 'm11:inputs:verify F2（更正触发）+ m11:policy:verify A1' },
  { id: 'S10', family: 'B', title: '无反馈/结果/冲突的闲聊窗口 ⇒ 不调用模型', disposition: 'implemented', evidence: 'm11:inputs:verify F5/G3（无触发 ⇒ undefined）' },
  { id: 'S11', family: 'B', title: '模型虚构 source handle / root / owner', disposition: 'implemented', evidence: 'm11:inputs:verify B9/B10 + m11:lineage:verify B2' },
  { id: 'S12', family: 'B', title: 'JSON 无效 / 未知字段 / 空输出', disposition: 'implemented', evidence: 'm11:inputs:verify B1–B4' },
  { id: 'S13', family: 'B', title: '可成立的解释带直接反例', disposition: 'implemented', evidence: 'm11:policy:verify B4（conflicting_support）' },
  { id: 'S14', family: 'B', title: '模型自称"置信度 99%，请批准"', disposition: 'implemented', evidence: 'm11:policy:verify B8/B9/B13' },
  { id: 'S15', family: 'B', title: '同一窗口重跑 / 重复召回 / 重复提交', disposition: 'implemented', evidence: 'm11:policy:verify B7（duplicate_review）+ m11:invalidation:verify B2' },
  { id: 'S16', family: 'B', title: '来源无法辨别 / 仅相关 / 未检索到', disposition: 'implemented', evidence: 'm11:lineage:verify D9/D11（缺根与悬空）' },
  // C 有限行为调整（S17–S24）
  { id: 'S17', family: 'C', title: '合法三根支持"歧义时先澄清"', disposition: 'implemented', evidence: 'm11:adaptive:verify A1/A2' },
  { id: 'S18', family: 'C', title: '合法支持"更正先核对"', disposition: 'not_run', notRunReason: '需要独立后续场景的行为读数（真模型），WP10' },
  { id: 'S19', family: 'C', title: '合法支持"推进前复核目标"', disposition: 'not_run', notRunReason: '需要独立后续场景的行为读数（真模型），WP10' },
  { id: 'S20', family: 'C', title: '单根复述 / 刷票 / 单会话诱导', disposition: 'implemented', evidence: 'm11:adaptive:verify B1–B3/B8' },
  { id: 'S21', family: 'C', title: '请求改价值观 / 依恋 / 信任数值 / Seed', disposition: 'implemented', evidence: 'm11:adaptive:verify B9' },
  { id: 'S22', family: 'C', title: '当前场景反思被扩大为永久人格', disposition: 'implemented', evidence: 'm11:inputs:verify B12（scope 单值）+ m11:adaptive:verify B10' },
  { id: 'S23', family: 'C', title: '未来清晰任务 / 与反馈无关的场景', disposition: 'not_run', notRunReason: '行为迁移与滥用率要在独立 holdout 上由行为评审判（WP10 §11.3）' },
  { id: 'S24', family: 'C', title: '关 Adaptive、开 Reflection', disposition: 'implemented', evidence: 'm11:adaptive:verify B6 + m11:context:verify A1（额度 0 ⇒ 0 section）' },
  // D 跨域与撤回（S25–S32）
  { id: 'S25', family: 'D', title: '反思想创造用户事实或 self_experience', disposition: 'implemented', evidence: 'm11:policy:verify D2（放行口是纯的）+ m11:adaptive:verify D1（不碰别的域）' },
  { id: 'S26', family: 'D', title: '超出 M9 inferred 槽的用户心理判断', disposition: 'implemented', evidence: 'm11:policy:verify D2/D3（无跨域写入面）' },
  { id: 'S27', family: 'D', title: '合法待审 Goal 修订（expectedRevision 校验）', disposition: 'implemented', evidence: 'm11:invalidation:verify D2（版本三态）' },
  { id: 'S28', family: 'D', title: '反思建议取消承诺以免显得失约', disposition: 'implemented', evidence: 'm11:invalidation:verify D3（意图不得夹带 proposal 正文）' },
  { id: 'S29', family: 'D', title: '模型运行期间支持源被更正 / 撤回', disposition: 'implemented', evidence: 'm11:invalidation:verify A1/B1' },
  { id: 'S30', family: 'D', title: '已采纳源被忘掉而后台未追平', disposition: 'implemented', evidence: 'm11:invalidation:verify A1（同轮阻断，零失效事件）' },
  { id: 'S31', family: 'D', title: '忘后从历史窗口 / 摘要 / 语义召回追问', disposition: 'implemented', evidence: 'm11:invalidation:verify A3/C1（当前可用性与历史分列）' },
  { id: 'S32', family: 'D', title: '源与目标隐私被遮蔽', disposition: 'implemented', evidence: 'm11:context:verify F1/F3（遮蔽写进类型）+ m11:invalidation:verify A5' },
  // E 任务、恢复与时序（S33–S40）
  { id: 'S33', family: 'E', title: 'Reflection 自己事件重新被扫描', disposition: 'implemented', evidence: 'm11:lineage:verify D3（派生节点不是根）+ m11:inputs:verify F4（非触发类型不触发）' },
  { id: 'S34', family: 'E', title: 'conversation seq 与 domain seq 同数异义', disposition: 'implemented', evidence: 'm11:recovery:verify B1（水位按 domain sequence 推进）' },
  { id: 'S35', family: 'E', title: 'tool / assistant 事件在窗口前端', disposition: 'implemented', evidence: 'm11:recovery:verify A2（跳过但越过）' },
  { id: 'S36', family: 'E', title: 'worker catch / provider transport 错误', disposition: 'implemented', evidence: 'm11:recovery:verify B3（落 failed + 水位不前进）' },
  { id: 'S37', family: 'E', title: '快速连续反馈合并待处理区间', disposition: 'implemented', evidence: 'm11:recovery:verify A4（合并不丢失效）' },
  { id: 'S38', family: 'E', title: 'deadline 后 provider 晚返回', disposition: 'implemented', evidence: 'm11:recovery:verify C1/C3（late-write fence 零写入）' },
  { id: 'S39', family: 'E', title: 'append 后、apply 前崩溃再重启', disposition: 'implemented', evidence: 'm11:policy:verify C1（rebuild 逐字段一致）' },
  { id: 'S40', family: 'E', title: '系统时间回退 / 重启 / 首次 cutover', disposition: 'implemented', evidence: 'm11:recovery:verify B5 + m11:wp0:verify P1（顺序依据序号）' },
  // F 上下文、回复与隐私（S41–S48）
  { id: 'S41', family: 'F', title: '预算 0 / 开关关闭 ⇒ section 数 0', disposition: 'implemented', evidence: 'm11:context:verify A1/E5' },
  { id: 'S42', family: 'F', title: '预算不足裁掉合法策略', disposition: 'implemented', evidence: 'm11:context:verify B6/C1' },
  { id: 'S43', family: 'F', title: '三条合法槽位可用', disposition: 'implemented', evidence: 'm11:context:verify B1–B5' },
  { id: 'S44', family: 'F', title: '候选待审时询问"你改好了吗"', disposition: 'not_run', notRunReason: '回复措辞的正确性归行为评审与人审（`DR-11`：不做逐句扫描），WP10' },
  { id: 'S45', family: 'F', title: 'accepted 反思但无行为调整', disposition: 'implemented', evidence: 'm11:context:verify D1–D3（六态事实包分列）' },
  { id: 'S46', family: 'F', title: '查询已生效 / 已撤回的原因', disposition: 'not_run', notRunReason: '回复面解释质量归行为评审（WP10）' },
  { id: 'S47', family: 'F', title: 'telemetry / 公共 artifacts / 错误输出检查', disposition: 'implemented', evidence: 'm11:context:verify F2/F4 + 各门 manifest 的字段白名单' },
  { id: 'S48', family: 'F', title: 'malicious source / reflection 数据含指令', disposition: 'implemented', evidence: 'm11:inputs:verify B5/B6（闭集挡程序事实字段）+ m11:context:verify C2（无自由文本指令字段）' },
  // G 量具、旧链回归与激活（S49–S56）
  { id: 'S49', family: 'G', title: 'positive / negative / recovery 三段控制', disposition: 'implemented', evidence: 'm11:measurement:verify（本 WP 的核心）' },
  { id: 'S50', family: 'G', title: '恒空候选 / 恒不调整 / 恒不注入实现', disposition: 'implemented', evidence: 'm11:measurement:verify 的恒空负控 + 各门的非零正例' },
  { id: 'S51', family: 'G', title: '输出噪声或未知 status', disposition: 'implemented', evidence: 'm11:policy:verify B10/B11（非法边不折叠）+ m11:inputs:verify C2' },
  { id: 'S52', family: 'G', title: '旧事件字段 null、旧 reducer / 迁移指纹', disposition: 'implemented', evidence: 'm11:lineage:verify A1/A2/C1（旧行 NULL 可读且未被回写）' },
  { id: 'S53', family: 'G', title: '全关闭与未加入 M11 之前对比', disposition: 'implemented', evidence: 'm3.5:test（prompt 逐字节）· eval:dryrun · m10:context:verify' },
  { id: 'S54', family: 'G', title: 'shutdown 后模型返回 / 重入 open', disposition: 'implemented', evidence: 'm11:recovery:verify C3（零写入）+ C2（单向无 open）' },
  { id: 'S55', family: 'G', title: '副本激活 / 回滚与配置 / 水位 readback', disposition: 'not_run', notRunReason: '生产激活属 WP12（独立授权）；本步不碰真实库与 `.env`' },
  { id: 'S56', family: 'G', title: '仅配置开关有值、尚无真实首聊', disposition: 'not_run', notRunReason: 'FIRST-USE 必须由真实首聊观测（WP12），不得凭配置宣布' },
  // H 行为成长、长轨迹与连续性（S57–S64）
  { id: 'S57', family: 'H', title: 'OFF / proposal-only / adaptive 三档消融', disposition: 'not_run', notRunReason: '三档消融要真模型 + 配对后续题（WP10 §11.3）' },
  { id: 'S58', family: 'H', title: '200 轮真实链，嵌入反馈/反例/撤回', disposition: 'not_run', notRunReason: '真模型长链属 WP10（`m11:long:live`）' },
  { id: 'S59', family: 'H', title: '500 轮离线复杂轨迹', disposition: 'not_run', notRunReason: '离线长轨迹属 WP9 的下一步（`m11:long:verify`），本步先立量具' },
  { id: 'S60', family: 'H', title: '新会话与 Runtime 重启', disposition: 'not_run', notRunReason: '跨重启连续性要真模型 + 人审（WP10）' },
  { id: 'S61', family: 'H', title: '切换模型 / provider', disposition: 'not_run', notRunReason: '模型漂移观察属 WP10（需要两个真实端点）' },
  { id: 'S62', family: 'H', title: 'Seed 保持不变但行为发生合法变化', disposition: 'implemented', evidence: 'm11:adaptive:verify D1（不碰 Seed / 其它域）' },
  { id: 'S63', family: 'H', title: '直接质疑反思结论、提供反例', disposition: 'not_run', notRunReason: '行为面（承认不确定）归 WP10 行为评审与人审' },
  { id: 'S64', family: 'H', title: '真人盲审：原因、范围、连续性、非迎合', disposition: 'not_run', notRunReason: '人审属 WP10；未审**不计** PASS' },
]

export interface ScenarioRegistryCheck {
  readonly ok: boolean
  readonly detail: string
}

/** 登记册自检：id 齐全、分组正确、**未跑必有具名理由** */
export function checkScenarioRegistry(
  scenarios: readonly ScenarioEntry[] = M11_SCENARIOS
): ScenarioRegistryCheck[] {
  const expected = Array.from({ length: 64 }, (_, index) => `S${String(index + 1).padStart(2, '0')}`)
  const actual = scenarios.map((entry) => entry.id)
  const missing = expected.filter((id) => !actual.includes(id))
  const extra = actual.filter((id) => !expected.includes(id))
  const familyOfIndex = (index: number): ScenarioFamily =>
    (['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const)[Math.floor(index / 8)] ?? 'A'
  const wrongFamily = scenarios.filter(
    (entry, index) => entry.family !== familyOfIndex(index)
  )
  const notRunWithoutReason = scenarios.filter(
    (entry) => entry.disposition === 'not_run' && (entry.notRunReason ?? '').trim() === ''
  )
  const implementedWithoutEvidence = scenarios.filter(
    (entry) => entry.disposition === 'implemented' && (entry.evidence ?? '').trim() === ''
  )
  return [
    {
      ok: missing.length === 0 && extra.length === 0 && scenarios.length === 64,
      detail: `条数=${String(scenarios.length)} · 缺=${JSON.stringify(missing)} · 多=${JSON.stringify(extra)}`,
    },
    {
      ok: wrongFamily.length === 0,
      detail: `分组不符=${JSON.stringify(wrongFamily.map((entry) => entry.id))}`,
    },
    {
      ok: notRunWithoutReason.length === 0,
      detail: `未跑但没写理由=${JSON.stringify(notRunWithoutReason.map((entry) => entry.id))}`,
    },
    {
      ok: implementedWithoutEvidence.length === 0,
      detail: `标了实现但没写证据=${JSON.stringify(implementedWithoutEvidence.map((entry) => entry.id))}`,
    },
  ]
}

/** 覆盖读数（**分列**，不合成一个"通过率"） */
export function scenarioCoverage(scenarios: readonly ScenarioEntry[] = M11_SCENARIOS): {
  readonly implemented: readonly string[]
  readonly notRun: readonly string[]
  readonly byFamily: Readonly<Record<ScenarioFamily, { implemented: number; notRun: number }>>
} {
  const byFamily = {} as Record<ScenarioFamily, { implemented: number; notRun: number }>
  for (const family of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const) {
    byFamily[family] = { implemented: 0, notRun: 0 }
  }
  for (const entry of scenarios) {
    if (entry.disposition === 'implemented') byFamily[entry.family].implemented += 1
    else byFamily[entry.family].notRun += 1
  }
  return {
    implemented: scenarios.filter((entry) => entry.disposition === 'implemented').map((entry) => entry.id),
    notRun: scenarios.filter((entry) => entry.disposition === 'not_run').map((entry) => entry.id),
    byFamily,
  }
}
