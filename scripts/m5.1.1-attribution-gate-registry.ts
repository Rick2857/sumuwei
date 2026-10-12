/**
 * M5.1.1 / WP8-B —— Attribution Measurement & Gate Harness：**统一门清单**（单一真相源）
 *
 * 这份文件是 WP8 的"注册表"：它不是测试，而是**声明**。
 *   · 哪一个 attribution correctness claim 由**哪一个已经存在的权威 verifier** 负责
 *   · 每个 verifier 的**规范证据文件**（它会重写的那一份）
 *   · 十条核心不变量 + 两个跨层反例（D01 / K-27）各自锚在哪一份证据的哪一个字段上
 *   · 计划里冻结的**七个 mutation**，逐条锚到"某个既有门真的响过"的证据
 *
 * 纪律（与 K-17 一致，避免 WP8 自己再犯"人工清单看起来全"的毛病）：
 *   ① 只声明**已存在**的 verifier —— 不在这里重新实现任何 WP4–WP7 的测试逻辑
 *   ② 每条断言都必须能在**真实的证据文件**里找到一个非空字段（否则 = MEASUREMENT INVALID）
 *   ③ "清单是否完整"由 `discoverAttributionVerifiers()` 扫 `scripts/` 得出，不靠人写
 *
 * 证据目录固定 `artifacts/m5.1.1/`；`artifacts/m5.1/` 与 `artifacts/m4.5/` 是**永久冻结**的历史。
 */

export type M511GateId =
  | 'M511-G1'
  | 'M511-G2'
  | 'M511-G3'
  | 'M511-G4'
  | 'M511-G5'
  | 'M511-G6'
  | 'M511-G7'
  | 'M511-G8'
  | 'M511-G9'

export type VerifierKind =
  /** 当前 correctness claim 的权威门：必须 exit 0 */
  | 'gate'
  /** 契约 / 内核测试：必须 exit 0，但不写自己的 JSON 证据 */
  | 'test'
  /** 量具自身的门（正控 / 负控 / 恢复） */
  | 'measurement'
  /** WP 期的作用域护栏：**不是**当前 correctness claim（基线早于后续 WP，重跑会如实报红） */
  | 'historical-scope-guard'

export interface VerifierSpec {
  /** 稳定 id（本文件内唯一） */
  readonly id: string
  /** package.json 里的脚本名；`null` = 没有独立 pnpm 入口（只在复合门里被调用） */
  readonly pnpm: string | null
  readonly script: string
  /** 该 verifier 会重写的规范证据（run → fork → restore 白名单的来源） */
  readonly evidence: readonly string[]
  /** 其中属于**永久冻结**目录（artifacts/m5.1、artifacts/m4.5）的那些 */
  readonly frozenEvidence?: readonly string[]
  /** 除证据之外的写入面（例如 wp3 门会重写 Phase-4 半径文档） */
  readonly extraWrites?: readonly string[]
  readonly kind: VerifierKind
  /** 服务哪几道 M511 门 */
  readonly gates: readonly M511GateId[]
  /** 是否应当出现在 `discoverAttributionVerifiers()` 的扫描结果里 */
  readonly discoveryFile: boolean
  /** 运行是否由 WP8 发起（false = 只在复合门/pnpm 链里被间接跑到） */
  readonly runnable: boolean
}

export interface M511GateSpec {
  readonly id: M511GateId
  readonly name: string
  readonly claim: string
  /** NOT_RUN = 该门的对象**尚未实现**（规则已冻结），不得伪造 PASS */
  readonly status: 'IMPLEMENTED' | 'NOT_RUN'
  readonly verifiers: readonly string[]
  readonly notRunReason?: string
}

/**
 * 冻结的九门注册表（`M5.1.1-Test-and-Gate-Plan.md` §6 / Execution-Plan R-3）。
 * 门 ID 与门名一律沿用注册表原文。
 */
export const M511_GATES: readonly M511GateSpec[] = [
  {
    id: 'M511-G1',
    name: 'Attribution Model 契约',
    claim: 'PrincipalKind 六值 / AttributionValue 三态 / 必要性矩阵 / 唯一映射函数 / 三态编码',
    status: 'IMPLEMENTED',
    verifiers: ['wp1-contracts', 'migration', 'k29', 'kernel-conversation'],
  },
  {
    id: 'M511-G2',
    name: 'Attribution Truth',
    claim: 'G-AT-1/2/3 + 六类场景 S1–S6 + 合法相等必须通过；行动/执行归因与生产 ingress 同属此门',
    status: 'IMPLEMENTED',
    verifiers: ['wp4', 'wp41', 'wp5', 'wp51', 'wp32', 'wp61'],
  },
  {
    id: 'M511-G3',
    name: 'Attestation Boundary',
    claim: 'G-AT-4：untrusted caller 不可自报三类字段（受信证据 token + 必要性矩阵双边界）',
    status: 'IMPLEMENTED',
    verifiers: ['k25', 'k29'],
  },
  {
    id: 'M511-G4',
    name: 'Attribution Mutation 负控',
    claim: '计划冻结的**七个** mutation：每个都有"正控安静 / 注入必响 / 恢复安静"的真实证据',
    status: 'IMPLEMENTED',
    verifiers: ['k25', 'k29', 'wp32', 'wp41', 'wp51', 'wp4', 'wp1-contracts', 'k20'],
  },
  {
    id: 'M511-G5',
    name: 'Replay / Rebuild 一致性',
    claim: 'R1–R6：录制读路径、replay、query 三面一致且不重写已存值',
    status: 'IMPLEMENTED',
    verifiers: ['wp6', 'wp61'],
  },
  {
    id: 'M511-G6',
    name: '迁移与历史回填',
    claim: 'M1–M7（含禁止伪造的陈旧计数、Axis B 完整性、restore epoch）',
    status: 'IMPLEMENTED',
    verifiers: ['migration', 'prodcopy', 'wp3', 'wp32', 'k16', 'k17', 'k20', 'wp41'],
  },
  {
    id: 'M511-G7',
    name: 'Surface 回归',
    claim: 'Query / Trace / Observability / Console / Execution Truth 的展示面回归',
    status: 'IMPLEMENTED',
    verifiers: ['wp7', 'm51-test', 'm51-query', 'm51-control', 'm51-observability', 'm51-page'],
  },
  {
    id: 'M511-G8',
    name: 'Break-Glass Cognitive Override',
    claim: '规则已冻结、**未实现**：不得伪造 PASS',
    status: 'NOT_RUN',
    verifiers: [],
    notRunReason: 'break-glass 入口尚未实现（Test-and-Gate-Plan §8）；按 Gate rule，缺证据 = NOT RUN',
  },
  {
    id: 'M511-G9',
    name: '旧 Gate 兼容性',
    claim: 'compatibility rule 四条约束（① 逐条记录 changed assertions ② 未删除/放宽旧判据 ③ 新结果只写 artifacts/m5.1.1/ ④ artifacts/m5.1/ 一字不动）+ ⑤ 不得反过来改 M5.1 结论与标签',
    status: 'IMPLEMENTED',
    verifiers: ['k19', 'k17'],
  },
]

/**
 * Verifier 注册表。**只列已存在的东西**；每一条都能被 `pnpm <pnpm>` 真的跑起来。
 * （证据名 = 该脚本 `EVIDENCE_DIR` / `writeFileSync` 里真实写入的路径，已逐个核对。）
 */
export const VERIFIERS: readonly VerifierSpec[] = [
  {
    id: 'wp1-contracts',
    pnpm: 'm5.1.1:test',
    script: 'scripts/kernel-tests-m5.1.1.ts',
    evidence: ['artifacts/m5.1.1/wp1-contracts.json', 'artifacts/m5.1.1/wp1-axis-b-closure.json'],
    kind: 'test',
    gates: ['M511-G1'],
    discoveryFile: true,
    runnable: true,
  },
  {
    id: 'kernel-conversation',
    pnpm: 'kernel:test:conversation',
    script: 'scripts/kernel-tests-conversation.ts',
    evidence: [],
    kind: 'test',
    gates: ['M511-G1'],
    discoveryFile: true,
    runnable: true,
  },
  {
    id: 'migration',
    pnpm: 'm5.1.1:migration:verify',
    script: 'scripts/verify-m5.1.1-migration.ts',
    evidence: ['artifacts/m5.1.1/wp4.1-migration-verify.json', 'artifacts/m5.1.1/wp4.1-migration-preview.txt'],
    kind: 'gate',
    gates: ['M511-G1', 'M511-G6'],
    discoveryFile: true,
    runnable: true,
  },
  {
    id: 'prodcopy',
    pnpm: 'm5.1.1:prod-copy:verify',
    script: 'scripts/verify-m5.1.1-production-copy-schema.ts',
    evidence: ['artifacts/m5.1.1/wp9b1-production-copy-v9.json'],
    kind: 'gate',
    gates: ['M511-G6'],
    discoveryFile: true,
    runnable: true,
  },
  {
    id: 'k16',
    pnpm: 'm5.1.1:k16:verify',
    script: 'scripts/verify-m5.1.1-k16-overlap-audit.ts',
    evidence: ['artifacts/m5.1.1/wp2.1-k16-overlap-audit.json'],
    kind: 'gate',
    gates: ['M511-G6'],
    discoveryFile: true,
    runnable: true,
  },
  {
    id: 'k17',
    pnpm: 'm5.1.1:k17:verify',
    script: 'scripts/verify-m5.1.1-k17-consumer-impact.ts',
    evidence: ['artifacts/m5.1.1/wp2.2-k17-consumer-impact.json'],
    kind: 'gate',
    gates: ['M511-G6', 'M511-G9'],
    discoveryFile: true,
    runnable: true,
  },
  {
    id: 'k19',
    pnpm: 'm5.1.1:k19:verify',
    script: 'scripts/verify-m5.1.1-k19-evidence-integrity.ts',
    evidence: ['artifacts/m5.1.1/wp2.3-k19-evidence-integrity.json'],
    kind: 'gate',
    gates: ['M511-G9'],
    discoveryFile: false,
    runnable: true,
  },
  {
    id: 'k20',
    pnpm: 'm5.1.1:k20:verify',
    script: 'scripts/verify-m5.1.1-k20-anti-fabrication.ts',
    evidence: ['artifacts/m5.1.1/wp2.4-k20-anti-fabrication.json'],
    kind: 'gate',
    gates: ['M511-G6', 'M511-G4'],
    discoveryFile: true,
    runnable: true,
  },
  {
    id: 'k25',
    pnpm: 'm5.1.1:k25:verify',
    script: 'scripts/verify-m5.1.1-k25-trusted-attestation.ts',
    evidence: ['artifacts/m5.1.1/wp4-k25-trusted-attestation.json'],
    kind: 'gate',
    gates: ['M511-G3', 'M511-G4'],
    discoveryFile: true,
    runnable: true,
  },
  {
    id: 'k29',
    pnpm: 'm5.1.1:k29:verify',
    script: 'scripts/verify-m5.1.1-k29-necessity.ts',
    // `k29-exits.json` 由本门在 `verify-m5.1.1-k29-necessity.ts` 的收尾处写入
    // （`join(EVIDENCE_DIR, 'k29-exits.json')`），自 9c7bff7 起进 git。
    // 它**长期未被登记**（WP9-B1 期间由 WP8 harness 的"未声明门写入面"检查发现）：
    // 该检查本身是对的，缺的是这里的声明 —— 补登记是**如实登记**，检测器一字未改。
    evidence: [
      'artifacts/m5.1.1/k29-necessity-enforcement.json',
      'artifacts/m5.1.1/k29-exits.json',
    ],
    kind: 'gate',
    gates: ['M511-G1', 'M511-G3', 'M511-G4'],
    discoveryFile: true,
    runnable: true,
  },
  {
    id: 'wp3',
    pnpm: 'm5.1.1:wp3:verify',
    script: 'scripts/verify-m5.1.1-wp3-backfill.ts',
    evidence: ['artifacts/m5.1.1/wp3-backfill.json', 'artifacts/m5.1.1/wp3-before-image.json'],
    extraWrites: ['docs/m5.1.1/M5.1.1-Phase4-Cognitive-Impact-Radius.md'],
    kind: 'gate',
    gates: ['M511-G6'],
    discoveryFile: true,
    runnable: true,
  },
  {
    id: 'wp32',
    pnpm: 'm5.1.1:wp3.2:verify',
    script: 'scripts/verify-m5.1.1-wp32-recorded-axisb.ts',
    evidence: ['artifacts/m5.1.1/wp3.2-recorded-axisb.json'],
    kind: 'gate',
    gates: ['M511-G2', 'M511-G6', 'M511-G4'],
    discoveryFile: true,
    runnable: true,
  },
  {
    id: 'wp4',
    pnpm: 'm5.1.1:wp4:verify',
    script: 'scripts/verify-m5.1.1-wp4-write-path.ts',
    evidence: ['artifacts/m5.1.1/wp4.1-wp4-write-path.json', 'artifacts/m5.1.1/wp4.1-wp4-attestation.json'],
    kind: 'gate',
    gates: ['M511-G2', 'M511-G4'],
    discoveryFile: true,
    runnable: true,
  },
  {
    id: 'wp41',
    pnpm: 'm5.1.1:wp4.1:verify',
    script: 'scripts/verify-m5.1.1-wp41-k22-action-axisb.ts',
    evidence: ['artifacts/m5.1.1/wp4.1-k22-action-axis-b.json'],
    kind: 'gate',
    gates: ['M511-G2', 'M511-G6', 'M511-G4'],
    discoveryFile: true,
    runnable: true,
  },
  {
    id: 'wp5',
    pnpm: 'm5.1.1:wp5:verify',
    script: 'scripts/verify-m5.1.1-wp5-action-attribution.ts',
    evidence: ['artifacts/m5.1.1/wp5-action-attribution.json', 'artifacts/m5.1.1/wp5-execution-attribution.json'],
    kind: 'gate',
    gates: ['M511-G2'],
    discoveryFile: true,
    runnable: true,
  },
  {
    id: 'wp51',
    pnpm: 'm5.1.1:wp5.1:verify',
    script: 'scripts/verify-m5.1.1-wp51-k27-causal-initiator.ts',
    evidence: ['artifacts/m5.1.1/wp5.1-k27-causal-initiator.json'],
    kind: 'gate',
    gates: ['M511-G2', 'M511-G4'],
    discoveryFile: true,
    runnable: true,
  },
  {
    id: 'wp6',
    pnpm: 'm5.1.1:wp6:verify',
    script: 'scripts/verify-m5.1.1-wp6-recorded-read-path.ts',
    evidence: ['artifacts/m5.1.1/wp6-recorded-read-path.json', 'artifacts/m5.1.1/wp6-replay.json', 'artifacts/m5.1.1/wp6-query-grounding.json'],
    kind: 'gate',
    gates: ['M511-G5'],
    discoveryFile: true,
    runnable: true,
  },
  {
    id: 'wp61',
    pnpm: 'm5.1.1:wp6.1:verify',
    script: 'scripts/verify-m5.1.1-wp61-conversation-ingress.ts',
    evidence: ['artifacts/m5.1.1/wp6.1-conversation-ingress.json'],
    kind: 'gate',
    gates: ['M511-G2', 'M511-G5'],
    discoveryFile: true,
    runnable: true,
  },
  {
    id: 'wp7',
    pnpm: 'm5.1.1:wp7:verify',
    script: 'scripts/verify-m5.1.1-wp7-console.ts',
    evidence: ['artifacts/m5.1.1/wp7-console.json', 'artifacts/m5.1.1/wp7-rendering.json', 'artifacts/m5.1.1/wp7-delete-page.json'],
    kind: 'gate',
    gates: ['M511-G7'],
    discoveryFile: true,
    runnable: true,
  },
  {
    id: 'wp8c2-k33',
    pnpm: 'm5.1.1:wp8c2:verify',
    script: 'scripts/verify-m5.1.1-wp8c2-k33.ts',
    evidence: ['artifacts/m5.1.1/wp8c2-k33-verify.json', 'artifacts/m5.1.1/wp8c2-k23-boundary.json'],
    kind: 'gate',
    gates: ['M511-G1', 'M511-G6'],
    discoveryFile: true,
    runnable: true,
  },
  {
    id: 'm51-test',
    pnpm: 'm5.1:test',
    script: 'scripts/kernel-tests-dev-plane.ts',
    evidence: ['artifacts/m5.1/wp1-contracts.json'],
    frozenEvidence: ['artifacts/m5.1/wp1-contracts.json'],
    kind: 'test',
    gates: ['M511-G7'],
    discoveryFile: true,
    runnable: true,
  },
  {
    id: 'm51-query',
    pnpm: 'm5.1:query:verify',
    script: 'scripts/verify-m5.1-query.ts',
    evidence: ['artifacts/m5.1/query-negative-control.json'],
    frozenEvidence: ['artifacts/m5.1/query-negative-control.json'],
    kind: 'gate',
    gates: ['M511-G7'],
    discoveryFile: false,
    runnable: true,
  },
  {
    id: 'm51-control',
    pnpm: 'm5.1:control:verify',
    script: 'scripts/verify-m5.1-control.ts',
    evidence: ['artifacts/m5.1/control-execution-truth.json'],
    frozenEvidence: ['artifacts/m5.1/control-execution-truth.json'],
    kind: 'gate',
    gates: ['M511-G7'],
    discoveryFile: false,
    runnable: true,
  },
  {
    id: 'm51-observability',
    pnpm: 'm5.1:observability:verify',
    script: 'scripts/verify-m5.1-observability.ts',
    evidence: ['artifacts/m5.1/observability-evidence.json', 'artifacts/m5.1/leakage-evidence.json'],
    frozenEvidence: ['artifacts/m5.1/observability-evidence.json', 'artifacts/m5.1/leakage-evidence.json'],
    kind: 'gate',
    gates: ['M511-G7'],
    discoveryFile: false,
    runnable: true,
  },
  {
    id: 'm51-page',
    pnpm: 'm5.1:page:verify',
    script: 'scripts/verify-m5.1-page.ts',
    evidence: ['artifacts/m5.1/page-evidence.json'],
    frozenEvidence: ['artifacts/m5.1/page-evidence.json'],
    kind: 'gate',
    gates: ['M511-G7'],
    discoveryFile: false,
    runnable: true,
  },
  {
    id: 'wp7-preflight',
    pnpm: 'm5.1.1:wp7:preflight',
    script: 'scripts/verify-m5.1.1-wp7-preflight.ts',
    evidence: ['artifacts/m5.1.1/wp7-preflight.json'],
    kind: 'historical-scope-guard',
    gates: [],
    discoveryFile: true,
    runnable: false,
  },
  {
    id: 'm51-measurement',
    pnpm: 'm5.1:measurement:verify',
    script: 'scripts/verify-m5.1-measurement.ts',
    evidence: [],
    frozenEvidence: ['artifacts/m5.1/measurement-negative-controls.json'],
    extraWrites: ['artifacts/m5.1/measurement-negative-controls.json'],
    kind: 'measurement',
    gates: [],
    discoveryFile: false,
    runnable: true,
  },
]

/**
 * 扫描用的"归因断言针"：只有**真的在断言归因属性**的脚本才会同时/单独出现这些标识符。
 * 这张针表是本 WP 的判据；改它 = 改判据（必须连同证据一起重新评审）。
 */
export const DISCOVERY_NEEDLES: readonly string[] = [
  'assertAttributionNecessity',
  'attribution_origin',
  'contentOriginator',
  'attributionOrigin',
  'axisB',
  'Axis B',
  'UNCONFIRMED_ORIGIN',
  'MIGRATED_LEGACY',
  'attributionSlotsOf',
  'NECESSITY_MATRIX',
]

/**
 * 命中针表但**不是** verifier 的脚本（必须逐条写明理由）。
 *
 * 这里只有 WP8 **自己的量具**：注册表逐字声明了针表、harness 又 import 了它 ⇒ 两者必然命中。
 * 这是 K-17 那一课（检测器不能把自己的判据文本当成被测对象）的同型问题，所以显式登记而不是
 * 放宽针表 —— 针表本身一个字未改；负控（注入合成 verifier ⇒ 必响）证明这条排除没有把判据变哑。
 */
export const NON_VERIFIER_SCRIPTS: readonly { readonly file: string; readonly reason: string }[] = [
  { file: 'scripts/m5.1.1-attribution-gate-registry.ts', reason: 'WP8 的量具本体：它就是「针表 + 注册表」的声明文件，不是被测的 verifier' },
  { file: 'scripts/verify-m5.1.1-wp8-harness.ts', reason: 'WP8 的量具本体：它 import 针表并实现覆盖检查，不是被测的 verifier' },
  { file: 'scripts/m5.1.1-k23-recorder-boundary.ts', reason: 'K-23/K-33 的**共享分析器**（被 wp3 门与 K-33 专项门消费）；它不是独立门，也不该被当成被测 verifier' },
  { file: 'scripts/verify-m5.1.1-wp8c3-final.ts', reason: 'WP8-C3 的**重新资格化元门**：它自己会调用 `m5.1.1:wp8:verify` ⇒ 绝不能进入 harness 自己的运行集（会递归）' },
  { file: 'scripts/verify-m5.1.1-wp9-runtime-e2e.ts', reason: 'WP9 的**里程碑 E2E 门**（`WP9-C1` 之后它是**可 PASS** 的门：E4 按 R-48 接到真实 State Bootstrap 链、E8 接到 WP9-A 的生产 audit writer 链）。它**不属于** WP8 九门注册表（WP8 已于 C3 收口，且 `M511-G2` 的成员集合是当时冻结的）—— 它的判定由 **WP9 自己的验收清单与 handoff** 承担，并由 R-48 §C1-3 单独列进必跑清单。登记在此仅为让覆盖扫描能解释它（否则 WP8 会报 unclassifiedVerifier）' },
  { file: 'scripts/verify-m5.1.1-wp9a-control-audit.ts', reason: 'WP9-A 的**里程碑门**（U-03 Developer Control durable audit 的专项验收）。同样不属于 WP8 九门注册表，登记在此仅为让覆盖扫描能解释它（否则 WP8 会报 unclassifiedVerifier）' },
  { file: 'scripts/verify-m5.1.1-wp9b-e4-selection.ts', reason: 'WP9-B 的 **B0 选型门**（只读扫描：生产里是否存在真实的 SYSTEM 发起行为）。它**不是** E4 的验收门，也不属于 WP8 九门注册表，登记在此仅为让覆盖扫描能解释它（否则 WP8 会报 unclassifiedVerifier）' },
  { file: 'scripts/verify-m5.1.1-wp9b1-verify.ts', reason: 'WP9-B1 的 **R-45 落地门**（契约新族 + MIGRATION_0009 的 DDL 半径 + state_events 归因 round-trip 与负控）。它属于 M5.1.1 的后继 WP（WP9-B2 才会接线 `src/state/init.ts`），**不属于** WP8 九门注册表；登记在此仅为让覆盖扫描能解释它（否则 WP8 会报 unclassifiedVerifier）' },
  { file: 'scripts/verify-m5.1.1-wp9b2-verify.ts', reason: 'WP9-B2 的 **生产归因接线门**（Hard Gate 静态判据 + E4-A/E4-B 两条形态 + 三个核心负控 + 静态检测器的正控/负控/恢复三段式）。它属于 M5.1.1 的后继 WP，**不属于** WP8 九门注册表；登记在此仅为让覆盖扫描能解释它（否则 WP8 会报 unclassifiedVerifier）' },
  { file: 'scripts/verify-m5.1.1-wp9c0-e4-boundary.ts', reason: 'WP9-C0 的 **canonical E4 验收边界复核门**（只读：逐字锁定四份冻结材料 + 溯源链 + PREMISE CHECK + 生产可达性探针 + 覆盖率矩阵 + 三段式）。它**不裁定** E4 的归属、**不**改任何既有判据、**不**碰 `src/**`；不属于 WP8 九门注册表，登记在此仅为让覆盖扫描能解释它（否则 WP8 会报 unclassifiedVerifier）' },
  { file: 'scripts/verify-m5.1.1-wp10a-preflight.ts', reason: 'WP10-A 的 **production-copy 与回归预检门**（只读：工作树 / v7-v8-v9 指纹 / 真实库边界身份 / 副本方案与三层写保护 / 命令盘点与 Live Smoke 前置 / fork-restore 白名单 / CI 链隔离静默检查 + 三段式）。它**不跑** CI、**不迁移**、**不碰** `src/**`；不属于 WP8 九门注册表，登记在此仅为让覆盖扫描能解释它（否则 WP8 会报 unclassifiedVerifier）' },
  { file: 'scripts/verify-m5.1.1-wp10b-production-copy.ts', reason: 'WP10-B 的 **production-copy 迁移门**（真实库只被 cpSync 复制 + 在副本上 apply v6 → v9；四项 canonical 验证 + 五个 canonical 步骤，且逐步标注"跑在哪"）。它**不**迁移真实库、**不**改 `src/**`；不属于 WP8 九门注册表，登记在此仅为让覆盖扫描能解释它（否则 WP8 会报 unclassifiedVerifier）' },
  { file: 'scripts/verify-m5.1.1-wp10c-regression.ts', reason: 'WP10-C 的 **全量回归与门汇总门**（跑一次完整 `m4.5:ci` + 四个聚合器 + Live Smoke 前置如实登记 + 从 immutable 标签逐路径还原冻结面 + K-32/K-33 复核）。它**不**迁移真实库、**不**改 `src/**`；不属于 WP8 九门注册表，登记在此仅为让覆盖扫描能解释它（否则 WP8 会报 unclassifiedVerifier）' },
  { file: 'scripts/verify-m5.1.1-wp11-closure.ts', reason: 'WP11 的 **Phase 1–3 收官门**：它**独立地**从 `artifacts/m5.1.1/**` 的落盘证据**算出** Phase 1/2/3 的状态，再断言 `M5.1.1-Phase1-3-Acceptance-Report.md` 的六行与算出来的值逐字相同，并机器执行 canonical 的禁令（`M5.1.1 PASS` / `D01 CLOSED` 不得出现）。它只读证据、**不重跑任何门**、**不**改 `src/**`、**不**开数据库；不属于 WP8 九门注册表，登记在此仅为让覆盖扫描能解释它（否则 WP8 会报 unclassifiedVerifier）' },
  { file: 'scripts/verify-m5.1.1-phase4a-origin-gate.ts', reason: '**Phase 4a 的来源资格闸专项门**（ADR-043 `DR-1`/`DR-3`/`DR-6`/`DR-7`）：静态反后门 + 正控/负控/恢复三段式 + `measured_count > 0` 自检 + T3 七格冻结。它属于 ADR-043 落地阶段（`4a`），**不属于** WP8 九门注册表（WP8 已于 C3 收口，判据当时冻结）；登记在此仅为让覆盖扫描能解释它（否则 WP8 会报 unclassifiedVerifier）。⚠️ 它命中针表是**语义必然**：本门被测的对象就是"受信来源读数"，因此必须在夹具与断言里点名 `contentOriginator` / `axisB` / `UNCONFIRMED_ORIGIN`。针表一个字未改' },
  { file: 'scripts/verify-m5.1.1-phase4b-preflight.ts', reason: '**Phase 4b 的只读预检**（ADR-043 §4.3 的 `prepare` + `preview` + `warn` 三段的机器部分）：量变更面 / 门影响清单 / 存量半径 / 预览前后对照 / N-1…N-6 设计 / 激活回滚路径。它**只读**（不改 `src/**`、**不开数据库**、**不**激活 4b、**不**写认知），属于 ADR-043 落地阶段（`4b`），**不属于** WP8 九门注册表。命中针表的原因与 4a 门同型：它必须逐字引用 `UNCONFIRMED_ORIGIN` / `MIGRATED_LEGACY` 才能把"哪些记忆会拿到这个资格"量出来。针表一个字未改' },
  { file: 'scripts/verify-m5.1.1-phase4b-db-v9.ts', reason: '**真实库 v9 迁移后验证**（用户 D-1 = ② 授权迁移之后）：只读地断言 ① schema=9 且 1..9 连续 ② 既有业务行的**身份摘要**与 WP10-B 在副本上记录的 before 值逐字相同 ③ **没有任何一行被伪造归因**（`attribution_origin` 全 NULL、无 `MIGRATED_LEGACY`、无 `contentOriginator=USER`）④ 列形状 39 ⑤ 记忆面未被触碰。它属于 ADR-043 落地阶段（`4b` 的前置），**不属于** WP8 九门注册表。命中针表是**语义必然**：本条断言的对象就是那三列的物理值与"不得伪造"。它与 `verify-m4-real-db.ts` 同一范式（显式 `allowProductionDatabase()` + **只允许 SELECT** 的读闸，且该闸自带负控）。针表一个字未改' },
  { file: 'scripts/verify-m5.1.1-phase4b-qualification.ts', reason: '**Phase 4b 的存量资格专项门**（ADR-043 §4.2 的 `N-1`…`N-6` + §3.3 的⑥⑦）：纯派生三值/定义域/规则版本、排序降一档、prompt 标签后缀、端到端 `N-1` 负控与 `N-2` 正控、`N-3`（跑完派生后 `memory_records` 的 authority/status 摘要逐字节未变）、`N-5`、`N-6` 计数自检。它属于 ADR-043 落地阶段（`4b`），**不属于** WP8 九门注册表。命中针表是**语义必然**：它逐字断言 `UNCONFIRMED_ORIGIN` / `CONTRADICTED_ORIGIN` / `attributionOrigin` 的语义。针表一个字未改' },
  { file: 'scripts/m5.1.1-post-migration-invariants.ts', reason: '**迁移前提的两态与 post-migration 不变量**（共享助手，用户 2026-09-19 裁定授权取代 `prod-copy`/`k16`/`wp3`/`wp5` 的失效判据）：它给那几道门提供"真库已迁移 ⇒ 改断言既有行身份摘要逐字不变 ∧ 0 行伪造归因"的分支，**不删除**原来的彩排断言。它不是独立门（`prod-copy`/`k16`/`wp3` 消费它），登记在此仅为让覆盖扫描能解释它（否则 WP8 会报 unclassifiedVerifier）。命中针表是因为它必须读 `attribution_origin` 才能断言"没有伪造归因"。针表一个字未改' },
  { file: 'scripts/verify-m5.1.1-d01-live-smoke.ts', reason: '**M5.1.1-D01 关闭候选的真实链路 Live Smoke**（`pnpm m5.1.1:d01:smoke:live`，只允许在 `pnpm with-test-model` 下运行）：它在**临时副本**上跑 4 个场景（S1 存量降档 / S2 确立来源正控（交互式人类控制台）/ S3 代理伪装负控（agent-runner）/ S4 证据判定器的正控-负控-恢复三段式），产出 Level 1（真实模型回复，只记长度）与 Level 2（trace / 账本 / 派生资格）证据。它**不属于** WP8 九门注册表（那是 Phase 1–3 的注册表）。命中针表是**语义必然**：S3 的证据就是"那一行的 Axis B 三列原样读数"（`source_kind` / `source_authority` / `epistemic_source`），因此必须点名它们。它**不**派生 `trustedOrigin`（唯一适配边界是 `processorEventViewOf()`），只消费 `qualificationsForMemories()` 与 `qualificationLabelSuffix()` 两个生产读数；真实库只复制、从不打开（本文件里没有任何一行设置 `PROJECT_LG_ALLOW_PRODUCTION_DB`）。针表一个字未改' },
  { file: 'scripts/verify-m5.1.1-phase4-closure.ts', reason: '**Phase 4 的最终关闭门**（`pnpm m5.1.1:phase4:closure:verify` / `pnpm m5.1.1:final:verify`，ADR-044）：它只读**已提交**证据（4a 门 / Activation Record / D01 Live Smoke / M5.1.1 九门 / m5.1 回归）与当前状态源文档，断言 ① 四项关闭依据可定位且 PASS ② 授权留痕（R-62 / R-63，逐字）③ 当前状态源一致为 `Phase 4 PASS / D01 CLOSED / Final PASS` ④ 历史区一字未改 ⑤ 延期能力未被冒充（M511-G8 / DC-1..DC-3 / K-31）。它**不属于** WP8 九门注册表（那是 Phase 1–3 的注册表；本门是 Phase 4 的）。⚠️ **它唯一的写入面是 `artifacts/m5.1.1/phase4-closure.json`**（门里有一条静态自检断言"只有一处 `writeFileSync` 且目标就是该路径"），且证据里**没有任何时钟字段**（重复运行逐字节相同）。它**不**打开真实库、**不**跑真实模型、**不**改 `src/**`。命中针表是**语义必然**：它要从 Live Smoke 的证据里读 S3 那一行的 Axis B 读数（`axisBSourceAuthority` 等）来断言负控成立。针表一个字未改' },
]

/**
 * 历史回声：同一事实在**别的 WP 独立跑出来的**证据副本里也必须成立（跨时间一致性）。
 * 这些副本是已提交的历史证据，WP8 只读不写。
 */
export const HISTORICAL_ECHOES: Readonly<Record<string, readonly string[]>> = {
  'agentAsUserD01.row.actor': ['artifacts/m5.1.1/k29-wp6.1-conversation-ingress.json', 'artifacts/m5.1.1/wp7-wp6.1-conversation-ingress.json'],
  'agentAsUserD01.row.contentOriginator': ['artifacts/m5.1.1/k29-wp6.1-conversation-ingress.json', 'artifacts/m5.1.1/wp7-wp6.1-conversation-ingress.json'],
  'd01CrossLedger.actionInitiator': [
    'artifacts/m5.1.1/k29-k27-causal-initiator.json',
    'artifacts/m5.1.1/wp6-k27-causal-initiator.json',
    'artifacts/m5.1.1/wp61-k27-causal-initiator.json',
    'artifacts/m5.1.1/wp7-k27-causal-initiator.json',
  ],
  'positiveControls': ['artifacts/m5.1.1/k29-k22-action-axis-b.json', 'artifacts/m5.1.1/wp51-k22-action-axis-b.json'],
}
/**
 * M5.1 冻结点（永久冻结的兼容性基线）。
 *
 * ⚠️ **命名明确化（WP8-C3）**：这段对象以前把 annotated tag 的 **tag object id** 写成 `commit`，
 * 而它**不是** commit id。两者都能用于 `git diff <rev>..HEAD`（git 会 peel），但字段名会误导读者。
 * 现在拆成三个显式字段：
 *   · `tagName`        —— 标签名（历史内容比较一律写 `m5.1-complete:<path>`）
 *   · `tagObjectId`    —— annotated tag 自身的对象 id（`git rev-parse m5.1-complete`）
 *   · `targetCommitId` —— 它指向的 commit（`git rev-list -n 1 m5.1-complete`）
 * **语义未变**：冻结点没有移动、没有 repoint、边界没有改，只是把表示方式写清楚。
 */
export const M5L_FREEZE = {
  tagName: 'm5.1-complete',
  tagObjectId: '2e718f38a6256330d1a72af960702f64f570efff',
  targetCommitId: '2aac6cad50e0dbf66f26bf243345d9af01861013',
  frozenDirs: ['artifacts/m5.1', 'artifacts/m4.5'],
} as const

export interface EvidenceAnchor {
  /** 证据文件（相对仓库根） */
  readonly file: string
  /** JSON 点路径，数字段表示数组下标，例如 `positiveControls.0.axisBNull` */
  readonly path: string
  readonly expect: 'equals' | 'isFalse' | 'isTrue' | 'contains' | 'allEqual'
  readonly value?: string | number | boolean
  /** `allEqual` / `allTrue` 之类按字段投影时使用 */
  readonly field?: string
  readonly note?: string
}

export interface FactClaim {
  readonly id: string
  readonly statement: string
  readonly gates: readonly M511GateId[]
  /** 'invariant' = 十条核心不变量之一；'counterexample' = D01 / K-27 跨层反例；'mutation' = 七个注入负控之一 */
  readonly kind: 'invariant' | 'counterexample' | 'mutation'
  readonly anchors: readonly EvidenceAnchor[]
  /** 冻结的静态锚（源码里必须存在/不得存在某些标识） */
  readonly sourceAnchors?: readonly { readonly file: string; readonly contains?: readonly string[]; readonly notContains?: readonly string[] }[]
}

/**
 * 十条核心不变量（用户 WP8 执行令原文）+ 两个跨层反例 + 七个 mutation。
 * 每一条的锚都指向**真实证据里的真实字段**（§5/§6 会逐条解析，解析不到 = MEASUREMENT INVALID）。
 */
export const FACT_CLAIMS: readonly FactClaim[] = [
  {
    id: 'INV-1',
    statement: 'actor_type ≠ authoritative actor（呈现角色不是权威 actor）',
    gates: ['M511-G2'],
    kind: 'invariant',
    anchors: [
      { file: 'artifacts/m5.1.1/wp6.1-conversation-ingress.json', path: 'agentAsUserD01.row.actorType', expect: 'equals', value: 'user' },
      { file: 'artifacts/m5.1.1/wp6.1-conversation-ingress.json', path: 'agentAsUserD01.row.actor', expect: 'equals', value: 'KNOWN|SERVICE|agent-runner|-' },
      { file: 'artifacts/m5.1.1/wp6.1-conversation-ingress.json', path: 'agentAsUserD01.row.containsUserPrincipal', expect: 'isFalse' },
      { file: 'artifacts/m5.1.1/wp4.1-wp4-write-path.json', path: 'd01Regression.db.actor_type', expect: 'equals', value: 'user' },
      { file: 'artifacts/m5.1.1/wp4.1-wp4-write-path.json', path: 'd01Regression.db.actor_kind', expect: 'equals', value: 'SERVICE' },
    ],
  },
  {
    id: 'INV-2',
    statement: 'presented role ≠ contentOriginator（发言位置不是内容来源）',
    gates: ['M511-G2'],
    kind: 'invariant',
    anchors: [
      { file: 'artifacts/m5.1.1/wp6.1-conversation-ingress.json', path: 'agentAsUserD01.row.actorType', expect: 'equals', value: 'user' },
      { file: 'artifacts/m5.1.1/wp6.1-conversation-ingress.json', path: 'agentAsUserD01.row.contentOriginator', expect: 'equals', value: 'KNOWN|SERVICE|agent-runner|-' },
      { file: 'artifacts/m5.1.1/wp4.1-wp4-write-path.json', path: 'd01Regression.db.content_originator_kind', expect: 'equals', value: 'SERVICE' },
    ],
  },
  {
    id: 'INV-3',
    statement: 'speaker ≠ action initiator（谁在说话不是谁发起了动作）',
    gates: ['M511-G2'],
    kind: 'invariant',
    anchors: [
      { file: 'artifacts/m5.1.1/wp5.1-k27-causal-initiator.json', path: 'd01CrossLedger.presentedSpeaker', expect: 'contains', value: 'user/u-1' },
      { file: 'artifacts/m5.1.1/wp5.1-k27-causal-initiator.json', path: 'd01CrossLedger.actionInitiator', expect: 'equals', value: 'KNOWN|SERVICE|agent' },
      { file: 'artifacts/m5.1.1/wp5.1-k27-causal-initiator.json', path: 'd01CrossLedger.actionInitiatorIsUser', expect: 'isFalse' },
      { file: 'artifacts/m5.1.1/wp5.1-k27-causal-initiator.json', path: 'negatives.speakerUserWithoutCausal', expect: 'equals', value: 'UNKNOWN|-|-|RUNTIME_UNRESOLVED' },
      { file: 'artifacts/m5.1.1/wp6.1-conversation-ingress.json', path: 'crossLedgerK27.agentAction.initiator', expect: 'equals', value: 'KNOWN|SERVICE|agent-runner|-' },
    ],
  },
  {
    id: 'INV-4',
    statement: 'Unknown ≠ Absent（未确立与不适用是两个不同的三态值，展示面也必须分开）',
    gates: ['M511-G1', 'M511-G7'],
    kind: 'invariant',
    anchors: [
      { file: 'artifacts/m5.1.1/wp7-console.json', path: 'rendering.stateRenderings.absent', expect: 'equals', value: '不适用' },
      { file: 'artifacts/m5.1.1/wp7-console.json', path: 'rendering.stateRenderings.unknownLegacy', expect: 'equals', value: '来源未确立（历史未记录）' },
    ],
    sourceAnchors: [
      { file: 'src/kernel/contracts/actor.ts', contains: ['LEGACY_UNRECORDED', 'RUNTIME_UNRESOLVED'] },
      { file: 'src/infrastructure/dev/page.html', contains: ['不适用', '来源未确立（历史未记录）', '来源未确定（运行时无法解析）'] },
    ],
  },
  {
    id: 'INV-5',
    statement: 'no-envelope ≠ Unknown（整个信封缺席与"记了但未确立"必须分开）',
    gates: ['M511-G5', 'M511-G7'],
    kind: 'invariant',
    anchors: [
      { file: 'artifacts/m5.1.1/wp4.1-wp4-write-path.json', path: 'legacyRegression.storeLegacyRow.hasEnvelope', expect: 'isFalse' },
      { file: 'artifacts/m5.1.1/wp4.1-wp4-write-path.json', path: 'legacyRegression.migratedLegacyRow.hasEnvelope', expect: 'isFalse' },
      { file: 'artifacts/m5.1.1/wp7-console.json', path: 'rendering.noEnvelopeRendered', expect: 'contains', value: '未记录归因（Legacy Event）' },
      { file: 'artifacts/m5.1.1/wp7-console.json', path: 'rendering.stateRenderings.unknownLegacy', expect: 'equals', value: '来源未确立（历史未记录）' },
    ],
  },
  {
    id: 'INV-6',
    statement: 'RECORDED ≠ MIGRATED_LEGACY（录制读路径不重写已存值；两种 origin 不互相冒充）',
    gates: ['M511-G2', 'M511-G6'],
    kind: 'invariant',
    anchors: [
      { file: 'artifacts/m5.1.1/wp4.1-wp4-write-path.json', path: 'readbackAttribution.neverRewritesStoredValue', expect: 'isTrue' },
      { file: 'artifacts/m5.1.1/wp4.1-wp4-write-path.json', path: 'legacyRegression.recordedNotOverwritten.readSourceAuthority', expect: 'equals', value: 'UNCONFIRMED_ORIGIN' },
      { file: 'artifacts/m5.1.1/wp4.1-wp4-write-path.json', path: 'legacyRegression.recordedNotOverwritten.derivedFromActorType', expect: 'equals', value: 'USER_EXPLICIT' },
      { file: 'artifacts/m5.1.1/wp3.2-recorded-axisb.json', path: 'branchReadings', field: 'match', expect: 'allEqual', value: true },
    ],
  },
  {
    id: 'INV-7',
    statement: 'UNCONFIRMED_ORIGIN ≠ Attribution UNKNOWN（Axis B 未确证与槽位未确立是两回事）',
    gates: ['M511-G3', 'M511-G6'],
    kind: 'invariant',
    anchors: [
      { file: 'artifacts/m5.1.1/wp4.1-wp4-write-path.json', path: 'd01Regression.db.content_originator_kind', expect: 'equals', value: 'SERVICE' },
      { file: 'artifacts/m5.1.1/wp4.1-wp4-write-path.json', path: 'd01Regression.db.source_authority', expect: 'equals', value: 'UNCONFIRMED_ORIGIN' },
      { file: 'artifacts/m5.1.1/wp1-axis-b-closure.json', path: 'negativeControls', field: 'id', expect: 'allEqual', note: '四条负控逐条存在（见 §5 明细）' },
      { file: 'artifacts/m5.1.1/wp4-k25-trusted-attestation.json', path: 'negatives', field: 'holds', expect: 'allEqual', value: true },
    ],
  },
  {
    id: 'INV-8',
    statement: 'Action Axis B = NOT_APPLICABLE（行动侧三列恒为 NULL，不是"未知/缺失/错误"）',
    gates: ['M511-G2', 'M511-G6'],
    kind: 'invariant',
    anchors: [
      { file: 'artifacts/m5.1.1/wp4.1-k22-action-axis-b.json', path: 'positiveControls', field: 'axisBNull', expect: 'allEqual', value: true },
      { file: 'artifacts/m5.1.1/wp4.1-k22-action-axis-b.json', path: 'negativeControls', field: 'contractDetectorFired', expect: 'allEqual', value: true },
    ],
  },
  {
    id: 'INV-9',
    statement: 'requested ≠ authorized ≠ attempted ≠ executed ≠ verified（执行真相的五个位次不互相顶替）',
    gates: ['M511-G2', 'M511-G7'],
    kind: 'invariant',
    anchors: [
      { file: 'artifacts/m5.1.1/wp5-execution-attribution.json', path: 'stages', field: 'type', expect: 'allEqual', note: '九个阶段的 type 与矩阵行逐个登记（见 §5 明细）' },
      { file: 'artifacts/m5.1.1/wp7-console.json', path: 'rendering.executionRendered', expect: 'contains', value: 'executed=true' },
      { file: 'artifacts/m5.1.1/wp7-console.json', path: 'rendering.executionRendered', expect: 'contains', value: 'not_attempted' },
    ],
    sourceAnchors: [{ file: 'src/kernel/contracts/developer-query.ts', contains: ['attempted', 'verification'] }],
  },
  {
    id: 'INV-10',
    statement: 'recordedBy 说的是"谁写了账本"，不是"谁做的/谁执行的"',
    gates: ['M511-G3', 'M511-G2'],
    kind: 'invariant',
    anchors: [
      { file: 'artifacts/m5.1.1/wp4.1-wp4-write-path.json', path: 'd01Regression.readback.recordedBy', expect: 'equals', value: 'KNOWN|SYSTEM|kernel|-' },
      { file: 'artifacts/m5.1.1/wp4.1-wp4-write-path.json', path: 'd01Regression.readback.actor', expect: 'equals', value: 'KNOWN|SERVICE|agent|-' },
      { file: 'artifacts/m5.1.1/wp4-k25-trusted-attestation.json', path: 'mutation', field: 'rejectedAsEvidence', expect: 'allEqual', value: true },
    ],
  },
  {
    id: 'CE-D01',
    statement: 'D01 跨层反例：user 角色 + SERVICE 作者 ⇒ 从写路径到生产 ingress 到行动链**处处**仍是 SERVICE',
    gates: ['M511-G2', 'M511-G6'],
    kind: 'counterexample',
    anchors: [
      { file: 'artifacts/m5.1.1/wp4.1-wp4-write-path.json', path: 'd01Regression.db.actor_kind', expect: 'equals', value: 'SERVICE' },
      { file: 'artifacts/m5.1.1/wp6.1-conversation-ingress.json', path: 'agentAsUserD01.row.actor', expect: 'equals', value: 'KNOWN|SERVICE|agent-runner|-' },
      { file: 'artifacts/m5.1.1/wp6.1-conversation-ingress.json', path: 'agentAsUserD01.row.contentOriginator', expect: 'equals', value: 'KNOWN|SERVICE|agent-runner|-' },
      { file: 'artifacts/m5.1.1/wp5.1-k27-causal-initiator.json', path: 'd01CrossLedger.actionInitiator', expect: 'equals', value: 'KNOWN|SERVICE|agent' },
      { file: 'artifacts/m5.1.1/wp5.1-k27-causal-initiator.json', path: 'immutability.d01ChainAllServiceAgent', expect: 'isTrue' },
      { file: 'artifacts/m5.1.1/wp6.1-conversation-ingress.json', path: 'agentAsUserD01.constructionMatchesDb', expect: 'isTrue' },
    ],
  },
  {
    id: 'CE-K27',
    statement: 'K-27 跨层反例：agent 以 user 身份对话 ⇒ 行动 initiator = SERVICE（人类发起仍 = USER）',
    gates: ['M511-G2'],
    kind: 'counterexample',
    anchors: [
      { file: 'artifacts/m5.1.1/wp5.1-k27-causal-initiator.json', path: 'd01CrossLedger.actionInitiatorIsUser', expect: 'isFalse' },
      { file: 'artifacts/m5.1.1/wp5.1-k27-causal-initiator.json', path: 'humanPositive.actionInitiator', expect: 'equals', value: 'KNOWN|USER|u-1' },
      { file: 'artifacts/m5.1.1/wp5.1-k27-causal-initiator.json', path: 'restore.actionInitiator', expect: 'equals', value: 'KNOWN|USER|u-1' },
      { file: 'artifacts/m5.1.1/wp5.1-k27-causal-initiator.json', path: 'negatives.fired', expect: 'equals', value: 7 },
      { file: 'artifacts/m5.1.1/wp6.1-conversation-ingress.json', path: 'crossLedgerK27.agentAction.initiator', expect: 'equals', value: 'KNOWN|SERVICE|agent-runner|-' },
      { file: 'artifacts/m5.1.1/wp6.1-conversation-ingress.json', path: 'crossLedgerK27.humanAction.initiator', expect: 'contains', value: 'KNOWN|USER|' },
    ],
  },
  {
    id: 'MUT-1',
    statement: 'mutation ①：agent 替发（user 角色）时 contentOriginator **不得**是 USER',
    gates: ['M511-G2'],
    kind: 'mutation',
    anchors: [
      { file: 'artifacts/m5.1.1/wp6.1-conversation-ingress.json', path: 'agentAsUserD01.row.containsUserPrincipal', expect: 'isFalse' },
      { file: 'artifacts/m5.1.1/wp6.1-conversation-ingress.json', path: 'agentAsUserD01.row.contentOriginator', expect: 'equals', value: 'KNOWN|SERVICE|agent-runner|-' },
    ],
  },
  {
    id: 'MUT-2',
    statement: 'mutation ②：调用方自报 contentOriginator=USER ⇒ 必响且零残留',
    gates: ['M511-G3'],
    kind: 'mutation',
    anchors: [
      { file: 'artifacts/m5.1.1/wp4.1-wp4-attestation.json', path: 'attestation.callerInjection.rejectedCode', expect: 'equals', value: 'untrusted_attribution_context' },
      { file: 'artifacts/m5.1.1/wp4.1-wp4-attestation.json', path: 'attestation.callerInjection.residueRows', expect: 'equals', value: 0 },
      { file: 'artifacts/m5.1.1/wp4.1-wp4-attestation.json', path: 'attestation.callerInjection.forgeryFingerprintRows', expect: 'equals', value: 0 },
    ],
  },
  {
    id: 'MUT-3',
    statement: 'mutation ③：自报 authority=CAPABILITY / 表面身份提权 ⇒ 必响（受信证据 token 才作数）',
    gates: ['M511-G3'],
    kind: 'mutation',
    anchors: [
      { file: 'artifacts/m5.1.1/wp4-k25-trusted-attestation.json', path: 'negatives.0.holds', expect: 'isTrue' },
      { file: 'artifacts/m5.1.1/wp4-k25-trusted-attestation.json', path: 'negatives.3.holds', expect: 'isTrue' },
      { file: 'artifacts/m5.1.1/wp4-k25-trusted-attestation.json', path: 'negatives.4.holds', expect: 'isTrue' },
      { file: 'artifacts/m5.1.1/wp4-k25-trusted-attestation.json', path: 'mutation.2.rejectedAsEvidence', expect: 'isTrue' },
    ],
  },
  {
    id: 'MUT-4',
    statement: 'mutation ④：initiator 证据被篡改 / 克隆 ⇒ 必响并回落 UNKNOWN(RUNTIME_UNRESOLVED)',
    gates: ['M511-G2'],
    kind: 'mutation',
    anchors: [
      { file: 'artifacts/m5.1.1/wp5.1-k27-causal-initiator.json', path: 'negatives.handCraftedCausalRejected', expect: 'isTrue' },
      { file: 'artifacts/m5.1.1/wp5.1-k27-causal-initiator.json', path: 'negatives.causalClonesRejected', expect: 'equals', value: 2 },
      { file: 'artifacts/m5.1.1/wp5.1-k27-causal-initiator.json', path: 'negatives.slotsDisagree', expect: 'equals', value: 'UNKNOWN|-|-|RUNTIME_UNRESOLVED' },
    ],
  },
  {
    id: 'MUT-5',
    statement: 'mutation ⑤：executor 证据被篡改 ⇒ 契约检测器必响且库拒绝、零残留',
    gates: ['M511-G2'],
    kind: 'mutation',
    anchors: [
      { file: 'artifacts/m5.1.1/wp4.1-k22-action-axis-b.json', path: 'negativeControls', field: 'dbRejected', expect: 'allEqual', value: true },
      { file: 'artifacts/m5.1.1/wp4.1-k22-action-axis-b.json', path: 'negativeControls', field: 'residueRows', expect: 'allEqual', value: 0 },
    ],
  },
  {
    id: 'MUT-6',
    statement: 'mutation ⑥：LEGACY_UNRECORDED 被洗成 KNOWN USER ⇒ 必响',
    gates: ['M511-G6'],
    kind: 'mutation',
    anchors: [
      { file: 'artifacts/m5.1.1/wp2.4-k20-anti-fabrication.json', path: 'threeStage.negative', field: 'fired', expect: 'allEqual', value: true },
      { file: 'artifacts/m5.1.1/wp2.4-k20-anti-fabrication.json', path: 'threeStage.positive.quiet', expect: 'isTrue' },
      { file: 'artifacts/m5.1.1/wp2.4-k20-anti-fabrication.json', path: 'threeStage.restore.quiet', expect: 'isTrue' },
      { file: 'artifacts/m5.1.1/wp2.4-k20-anti-fabrication.json', path: 'retainedInvariants.unknownKindLikeCount', expect: 'equals', value: 0 },
    ],
  },
  {
    id: 'MUT-7',
    statement: 'mutation ⑦：Absent 被填成具体值 ⇒ 必要性矩阵必响（MUST_ABSENT 槽位填值 = 违规）',
    gates: ['M511-G1', 'M511-G3'],
    kind: 'mutation',
    anchors: [
      { file: 'artifacts/m5.1.1/k29-necessity-enforcement.json', path: 'verdict', expect: 'equals', value: 'PASS' },
      { file: 'artifacts/m5.1.1/k29-necessity-enforcement.json', path: 'measurements', field: 'valid', expect: 'allEqual', value: true },
    ],
    sourceAnchors: [{ file: 'src/kernel/contracts/attribution.ts', contains: ['assertAttributionNecessity', 'NECESSITY_MATRIX'] }],
  },
]
