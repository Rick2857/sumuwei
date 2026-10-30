/**
 * P3-4 门 —— **技能 → P2 规则资格的可选依赖联验**（零真实模型请求）。
 *
 * ============================================================================
 *  计划 §7 P3-4 的四条要求 ↔ 本门的四组检查
 * ============================================================================
 * ```text
 * ① 「没有规则依赖的技能正常使用，不强制预测或模拟，不为资料技能虚构规律」
 *      → A 组：产品技能（无声明）照旧可加载；加载不写 EBL、不产生规则证据
 * ② 「独立的受限测试技能引用已有 P2 测试规则，走实际资格读面验证依赖契约；
 *     该测试技能不进入产品目录」
 *      → A/B 组：夹具资产根里造一个 `restricted-rule-dependent`，
 *        用**真实 EBL 只读读面**（`createEblRuleSnapshotPort`）判依赖
 * ③ 「正确规则/版本/范围可消费，错误范围、未知、挂起、撤回、替代版本
 *     不能被当作当前合格依赖」
 *      → B 组：**真实 EBL 状态只有 `validated` 与 `withdrawn`**；
 *        `pending` / `suspended` / `superseded` / `retired` / 错范围 / 未知 /
 *        版本冲突 / 读面失败由**纯判据**覆盖（`usable=false` 是唯一权威字段）
 * ④ 「加载之后、动作之前规则失效，后续依赖动作不得继续沿用旧资格；
 *     记录具体阻断原因，不声称已撤销发生过的副作用」
 *      → C 组：加载成功拿到基线 → 撤回规则 → **真实任务环**里依赖步骤被拒
 *        （`skill_rule_unusable`），副作用没有发生，EBL 状态仍是 withdrawn；
 *        另有负控：声明了依赖但装配漏传读面 ⇒ 同样失败关闭
 * ```
 *
 * ⚠️ 零真实模型请求、零外网；隔离 PostgreSQL（一次性 `lg_test_*` 库）。
 * ⚠️ 门自己**不判资格**：合格与否由真实读面 + P1/P2 判据决定。
 * ⚠️ 本门**不**证明"技能会自动声明依赖"：声明来自测试资产，是受控输入。
 */

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { runPreparedPgGate, runPreparedPgGateInInstance } from '../postgresql/test-harness.ts'
import { isolateDatabase } from '../../src/dev/sandbox.ts'

if (process.env.LG_P3_RULE_DEPENDENCY_PG_CHILD !== '1') {
  process.env.LG_P3_RULE_DEPENDENCY_PG_CHILD = '1'
  process.env.LG_PG_GATE_TIMEOUT_MS ??= '900000'
  const admin = (process.env.LG_SIM_PGTEST_ADMIN_URL ?? '').trim()
  if (admin !== '') await runPreparedPgGateInInstance(admin, 'p3-skill-rule-dependency', 'scripts/cognitive/p3-skill-rule-dependency-verify.ts')
  else await runPreparedPgGate('p3-skill-rule-dependency', 'scripts/cognitive/p3-skill-rule-dependency-verify.ts')
  process.exit(0)
}
const sandbox = isolateDatabase('p3-skill-rule-dependency', { postgres: { url: process.env.LG_TEST_PG_URL ?? '' } })
assert.equal(sandbox.backend, 'postgres')

import { createHash } from 'node:crypto'
import { asTraceId } from '../../src/kernel/contracts/ids.ts'
import { makeEblClaim } from '../../src/kernel/contracts/epistemic-belief.ts'
import {
  decideSkillRuleDependenciesAtLoad,
  decideSkillRuleDependenciesBeforeAction,
  parseWorkflowSkillRuleDependencies,
  type WorkflowSkillRuleDependencyDeclaration,
} from '../../src/kernel/contracts/workflow-skill-rule-dependency.ts'
import type { UsableRuleSnapshot, VisibleRuleContext } from '../../src/kernel/contracts/cognitive-collaboration.ts'
import { createM4Harness } from '../m4-harness.ts'
import { createActionGateway } from '../../src/kernel/action/gateway.ts'
import { createCapabilityRegistry, DEFAULT_GRANTED_PERMISSIONS, createDefaultCapabilityDefinitions } from '../../src/kernel/action/capability-registry.ts'
import { createActionRequest } from '../../src/kernel/action/action-request.ts'
import { newActionId } from '../../src/kernel/contracts/ids.ts'
import { createActionLedgerStore } from '../../src/infrastructure/action/action-ledger-store.ts'
import {
  WORKFLOW_SKILL, WORKFLOW_SKILL_PERMISSION,
  PERSONAL_LIBRARY_PERMISSION, PERSONAL_LIBRARY_SEARCH,
  createLearningCapabilityDefinitions,
} from '../../src/kernel/action/learning-capabilities.ts'
import { createUtilityCapabilityDefinitions } from '../../src/kernel/action/utility-capabilities.ts'
import { createLocalFileCapabilityDefinitions } from '../../src/kernel/action/local-file-capabilities.ts'
import { createSandboxReadAdapter, createSandboxWriteAdapter, listSandboxEntries } from '../../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import { createInMemoryPayloadStaging } from '../../src/kernel/action/payload-staging.ts'
import { resolveActionTarget } from '../../src/kernel/action/target-resolver.ts'
import { hasSideEffect } from '../../src/kernel/action/action-request.ts'
import { runTask } from '../../src/kernel/action/task-loop.ts'
import { createTaskAuthorizationRegistry } from '../../src/kernel/action/task-authorization.ts'
import { attestActionInitiatorFromCausalOrigin, correlationSourceFromConversationEvent, triggeringConversationEventOf } from '../../src/kernel/contracts/attribution.ts'
import { createEblStore } from '../../src/infrastructure/persistence/epistemic-belief-store.ts'
import { createEblSourceReader, eblReadbackRef, EBL_HUMAN_ENVIRONMENT, EBL_TOOL_ENVIRONMENT } from '../../src/infrastructure/persistence/epistemic-belief-source.ts'
import { createEblRuleSnapshotPort } from '../../src/infrastructure/runtime/ebl-rule-snapshot.ts'
import { createManagedWorkflowSkillAdapter } from '../../src/infrastructure/action/adapters/workflow-skill.ts'
import { loadWorkflowSkillCatalog, loadedReleaseOf, type LoadedWorkflowSkillCatalog } from '../../src/infrastructure/action/workflow-skill-catalog.ts'
import { createWorkflowSkillReleaseStore } from '../../src/infrastructure/persistence/workflow-skill-release-store.ts'
import { computeWorkflowSkillReleaseDigest } from '../../src/kernel/contracts/workflow-skill-catalog.ts'
import {
  createWorkflowSkillRuleDependencyChecker,
  loadWorkflowSkillRuleDependencies,
  type WorkflowSkillRuleDependencyChecker,
} from '../../src/infrastructure/action/workflow-skill-rule-dependency.ts'
import { readKernelFlags } from '../../src/kernel/app/flags.ts'
import { assertMigrationsWellFormed, latestSchemaVersion, MIGRATIONS } from '../../src/infrastructure/persistence/migrations.ts'
import { WORKFLOW_SKILL_RULE_DEPENDENCY_VERSION } from '../../src/kernel/contracts/workflow-skill-rule-dependency.ts'
import { sql } from 'drizzle-orm'
import { exec } from '../../src/infrastructure/persistence/db.ts'

const TEST_SKILL_ID = 'restricted-rule-dependent'
const PRODUCT_SKILL_ID = 'personal-library'
const startedAt = Date.now()
const outputDir = resolve('artifacts/local/p3-skill-rule-dependency', new Date().toISOString().replace(/[:.]/g, ''))
mkdirSync(outputDir, { recursive: true })

const checks: { id: string; name: string; pass: boolean; detail: string }[] = []
function checkMany(id: string, name: string, problems: string[], detail = ''): void {
  const pass = problems.length === 0
  checks.push({ id, name, pass, detail: pass ? detail : problems.join(' | ') })
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${name}${detail === '' && pass ? '' : ` — ${pass ? detail : problems.join(' | ')}`}`)
}
const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex')
const readings: Record<string, unknown> = {}

const h = await createM4Harness({ label: 'p3-skill-rule-dependency', userId: 'Alex' })
const characterId = h.kernel.characterId
const ledger = createActionLedgerStore(h.db)
const store = createWorkflowSkillReleaseStore(h.db)
const ebl = createEblStore(h.db, characterId, createEblSourceReader(h.userId))
const snapshot = createEblRuleSnapshotPort(h.db, characterId, h.userId)
const authorizations = createTaskAuthorizationRegistry()
const staging = createInMemoryPayloadStaging()

try {
  // =========================================================================
  // A. 资产与声明（测试技能不进产品目录）
  // =========================================================================
  const realCatalog = loadWorkflowSkillCatalog()
  assert.ok(realCatalog.ok, `real catalog: ${JSON.stringify(realCatalog)}`)
  const realLoaded = realCatalog.loaded
  const realSkillIds = realLoaded.catalog.skills.map((skill) => skill.skillId).sort()
  checkMany('01', 'product catalog unchanged: only personal-library; the test skill is NOT in it', [
    ...(realSkillIds.length === 1 && realSkillIds[0] === PRODUCT_SKILL_ID ? [] : [`skills=${realSkillIds.join(',')}`]),
    ...(realLoaded.catalog.skills.some((skill) => skill.skillId === TEST_SKILL_ID) ? ['test skill leaked into product catalog'] : []),
  ], `skills=${realSkillIds.join(',')}`)

  const fixtureRoot = join(sandbox.dir, 'rule-dependency-skills')
  cpSync(resolve('resources/workflow-skills'), fixtureRoot, { recursive: true })
  rmSync(join(fixtureRoot, 'revisions.json'), { force: true })
  rmSync(join(fixtureRoot, 'frozen'), { recursive: true, force: true })

  /*
   * 受限测试技能：内容与产品技能**无关**（就是一句"只用只读资料"），
   * 它的意义是"有一个资产可以声明规则依赖"，不是"又一个产品技能"。
   */
  const testSkillText = [
    '---',
    'name: restricted-rule-dependent',
    '---',
    '这是一个**受限测试技能**：只在门的夹具资产里存在，不进入产品目录。',
    '它只做只读检索与阅读，不写文件、不联网、不调用外部工具。',
    '它声明依赖一条已登记的 P2 测试规则；规则不合格时它不得被加载。',
  ].join('\n')
  const testDir = join(fixtureRoot, TEST_SKILL_ID)
  mkdirSync(testDir, { recursive: true })
  writeFileSync(join(testDir, 'SKILL.md'), `${testSkillText}\n`, 'utf8')

  const catalogRaw = JSON.parse(readFileSync(join(fixtureRoot, 'catalog.json'), 'utf8')) as {
    catalogVersion: string
    skills: Record<string, unknown>[]
    [key: string]: unknown
  }
  const productSkillRaw = catalogRaw.skills.find((skill) => skill.skillId === PRODUCT_SKILL_ID) as {
    releases: Record<string, unknown>[]
  }
  const productV1 = productSkillRaw.releases.find((release) => release.version === 1) as Record<string, unknown>
  const testVersion = 1
  const testIdentity = {
    skillId: TEST_SKILL_ID,
    version: testVersion,
    contentFingerprint: sha256(`${testSkillText}\n`),
    applicability: productV1.applicability,
    requiredCapabilities: ['library.search'],
    inputBoundary: productV1.inputBoundary as never,
    resultVerificationContract: 'restricted-test-skill@1',
    predecessorVersion: null,
  }
  const testRelease = {
    ...testIdentity,
    contentPath: `${TEST_SKILL_ID}/SKILL.md`,
    changeReason: 'P3-4 门内受限测试技能（声明对 P2 规则的依赖；不进入产品目录）',
    verification: {
      reportRef: 'docs/architecture/Cognitive-Capability-P3-Batch4-Rule-Dependency-Contract-2026-10-28.md',
      verifiedAt: '2026-10-28',
      gateIds: ['p3:skill-rule-dependency:verify'],
    },
    initialState: 'published',
    releaseDigest: computeWorkflowSkillReleaseDigest(testIdentity as never),
  }
  catalogRaw.skills.push({ skillId: TEST_SKILL_ID, currentVersion: testVersion, releases: [testRelease] })
  writeFileSync(join(fixtureRoot, 'catalog.json'), JSON.stringify(catalogRaw, null, 2))

  const fixtureCatalog = loadWorkflowSkillCatalog({ root: fixtureRoot })
  assert.ok(fixtureCatalog.ok, `fixture catalog: ${JSON.stringify(fixtureCatalog)}`)
  const fixtureLoaded = fixtureCatalog.loaded
  const fixtureRegistered = await store.registerCatalog(fixtureLoaded.catalog, {
    catalogDigest: fixtureLoaded.catalogDigest,
    now: Date.now() + 1,
  })
  const testCurrent = await store.readCurrent(TEST_SKILL_ID)
  checkMany('02', 'test skill asset root loads and registers as published current (product releases unchanged)', [
    ...(fixtureRegistered.ok ? [] : [`register=${JSON.stringify(fixtureRegistered)}`]),
    ...(testCurrent?.version === testVersion && testCurrent.state === 'published' ? [] : [`testCurrent=${String(testCurrent?.version)}/${String(testCurrent?.state)}`]),
    ...(loadedReleaseOf(fixtureLoaded, PRODUCT_SKILL_ID, 1) !== undefined ? [] : ['product v1 missing from fixture root']),
  ], `inserted=${fixtureRegistered.ok ? String(fixtureRegistered.inserted) : 'n/a'} testCurrent=${String(testCurrent?.version)}`)

  /* 声明解析：好形状 + 六种坏形状（闭集） */
  const goodDeclarationFile = {
    dependencyVersion: WORKFLOW_SKILL_RULE_DEPENDENCY_VERSION,
    skillId: TEST_SKILL_ID,
    dependencies: [{ claimId: 'ebl:placeholder' }],
  }
  const parseGood = parseWorkflowSkillRuleDependencies(goodDeclarationFile)
  const badDeclarations: { id: string; input: unknown; expect: string }[] = [
    { id: 'unknown-file-field', input: { ...goodDeclarationFile, extra: true }, expect: 'file_unknown_field' },
    { id: 'version-mismatch', input: { ...goodDeclarationFile, dependencyVersion: 'workflow-skill-rule-dependency@0' }, expect: 'dependency_version_mismatch' },
    { id: 'bad-skill-id', input: { ...goodDeclarationFile, skillId: 'Bad Id' }, expect: 'skill_id_invalid' },
    { id: 'dependencies-not-array', input: { ...goodDeclarationFile, dependencies: {} }, expect: 'dependencies_invalid' },
    { id: 'declaration-unknown-field', input: { ...goodDeclarationFile, dependencies: [{ claimId: 'ebl:x', scopes: [] }] }, expect: 'declaration_invalid' },
    { id: 'declaration-duplicate', input: { ...goodDeclarationFile, dependencies: [{ claimId: 'ebl:x' }, { claimId: 'ebl:x' }] }, expect: 'declaration_duplicate' },
  ]
  checkMany('03', 'dependency declaration parsing is closed-set: good shape passes, six bad shapes rejected', [
    ...(parseGood.ok ? [] : [`good=${JSON.stringify(parseGood)}`]),
    ...badDeclarations.flatMap((item) => {
      const parsed = parseWorkflowSkillRuleDependencies(item.input)
      return parsed.ok ? [`${item.id} unexpectedly ok`] : parsed.code === item.expect ? [] : [`${item.id}=${parsed.code}（期望 ${item.expect}）`]
    }),
  ], badDeclarations.map((item) => item.expect).join(','))

  /* 旁挂文件：不存在 ⇒ 没有依赖（产品技能）；坏文件 ⇒ 失败关闭 */
  const missingFile = loadWorkflowSkillRuleDependencies(fixtureRoot, PRODUCT_SKILL_ID)
  mkdirSync(join(fixtureRoot, 'broken-dependency'), { recursive: true })
  writeFileSync(join(fixtureRoot, 'broken-dependency', 'rule-dependencies.json'), '{ not json', 'utf8')
  const brokenFile = loadWorkflowSkillRuleDependencies(fixtureRoot, 'broken-dependency')
  checkMany('04', 'sidecar loader: missing file ⇒ no dependency; broken file ⇒ fail closed', [
    ...(missingFile.ok && missingFile.declarations.length === 0 ? [] : [`missing=${JSON.stringify(missingFile)}`]),
    ...(brokenFile.ok === false && brokenFile.code === 'file_invalid' ? [] : [`broken=${JSON.stringify(brokenFile)}`]),
  ], `missing=${missingFile.ok ? 'none' : 'n/a'} broken=${brokenFile.ok ? 'ok' : brokenFile.code}`)

  // =========================================================================
  // B. 真实资格读面：加载时判定
  // =========================================================================
  const fsRoot = join(sandbox.dir, 'sandbox-files')
  mkdirSync(fsRoot, { recursive: true })
  const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
  const resolveTarget = async ({ request, operation }: Parameters<Required<Parameters<typeof createActionGateway>[0]>['resolveTarget']>[0]) =>
    resolveActionTarget({
      targetType: 'sandbox_file',
      hints: typeof request.arguments.path === 'string' ? [request.arguments.path] : [],
      listEntries: () => listSandboxEntries({ root: fsRoot, staging }),
      allowMissing: operation !== undefined && hasSideEffect(operation.sideEffect),
    })
  const sandboxGateway = createActionGateway({
    registry, ledger,
    adapters: [createSandboxReadAdapter({ root: fsRoot, staging }), createSandboxWriteAdapter({ root: fsRoot, staging })],
    grantedPermissions: DEFAULT_GRANTED_PERMISSIONS, maxRiskLevel: 'R1', resolveTarget,
    attribution: { decisionPointAdapterId: 'p3-4', executorAdapterId: 'sandbox-filesystem' },
  })
  /**
   * 受信 invocation：网关配置了 attribution ⇒ 每次 `execute` 都必须带 initiator 证据
   * （失败关闭，不退回 payload 自报）。
   *
   * ⚠️ initiator 的因果来源必须是**这一对动作的锚点事件**：EBL 的 readback 观测会核对
   *    "动作 → 会话锚点"的归属；用别的锚点会让形成来源读不出来（`ebl_formation_source`）。
   */
  const invocationForEvent = (event: Awaited<ReturnType<typeof h.recordUserEvidence>>['event']) => ({
    initiatorEvidence: attestActionInitiatorFromCausalOrigin({
      adapterId: 'p3-4',
      causalSource: correlationSourceFromConversationEvent({ adapterId: 'p3-4', triggeringEvent: triggeringConversationEventOf(event) }),
    }),
    riskBudgetOverride: 'R1' as const,
  })
  /**
   * 用**真实动作 + 真实 EBL 命令序列**把一条命题做成 `validated`（不绕过任何 EBL 断言）。
   *
   * 顺序按 EBL 自己的纪律排：
   * ```text
   * ① 真跑一对写→读（W1/R1，锚点 E1）⇒ formation 观测可读
   * ② propose（身份 = formation 引用）
   * ③ 登记测试（source 指向**将来**的 W2/R2，锚点 E2）—— EBL 要求"先登记、后观测"
   * ④ 真跑 W2/R2 ⇒ 观测晚于登记
   * ⑤ settle（support）+ review ⇒ validated
   * ```
   * ⚠️ 两对动作用**不同的锚点对话事件**：settle 断言"测试来源的根与形成来源不复用"。
   */
  async function formValidatedRule(index: number): Promise<{ claimId: string; formationRef: ReturnType<typeof eblReadbackRef> }> {
    const content = `UTF-8 验证 ${String(index)}\n`
    /**
     * 真跑一对写→读。`settleOn` 给了就"先登记、后观测、再结算"：
     * 先建两个**将来**的动作请求（actionId 此刻已知）⇒ 用它们登记测试 ⇒ 再真跑 ⇒ settle。
     * ⚠️ 每个测试用**不同路径**：EBL 的冻结政策要求 ≥2 个不同 bindingKey/designId/独立键。
     */
    const runPair = async (input: {
      readonly path: string
      readonly traceId: string
      readonly anchor: Awaited<ReturnType<typeof h.recordUserEvidence>>['event']
      readonly settleOn?: { claimId: string }
    }): Promise<{ writeId: string; readId: string; source: ReturnType<typeof eblReadbackRef> }> => {
      const invocation = invocationForEvent(input.anchor)
      const writeRequest = createActionRequest({
        actionId: newActionId(), traceId: asTraceId(input.traceId), capability: 'sandbox.file.write', operation: 'write',
        arguments: { path: input.path, content }, requestedBy: { kind: 'user' },
        sideEffect: registry.getOperation('sandbox.file.write', 'write')!.sideEffect,
      })
      const readRequest = createActionRequest({
        actionId: newActionId(), traceId: asTraceId(input.traceId), capability: 'sandbox.file.read', operation: 'read',
        arguments: { path: input.path }, requestedBy: { kind: 'user' },
        sideEffect: registry.getOperation('sandbox.file.read', 'read')!.sideEffect,
      })
      const source = eblReadbackRef(String(writeRequest.actionId), String(readRequest.actionId), String(input.anchor.id))
      if (input.settleOn !== undefined) {
        await ebl.commit(input.settleOn.claimId, {
          kind: 'register',
          test: {
            id: String(readRequest.actionId), episodeId: input.traceId, bindingKey: input.path,
            designId: String(writeRequest.actionId), targetId: String(writeRequest.actionId),
            source, anchor: { kind: 'conversation', id: String(input.anchor.id) },
          },
        })
      }
      const write = await sandboxGateway.execute(characterId, writeRequest, invocation)
      const read = await sandboxGateway.execute(characterId, readRequest, invocation)
      if (write.status !== 'success' || read.status !== 'success') {
        throw new Error(`rule pair ${input.path} failed: write=${String(write.status)} read=${String(read.status)}`)
      }
      if (input.settleOn !== undefined) {
        await ebl.commit(input.settleOn.claimId, { kind: 'settle', testId: String(readRequest.actionId), source })
      }
      return { writeId: String(writeRequest.actionId), readId: String(readRequest.actionId), source }
    }

    const formationAnchor = await h.recordUserEvidence(`规则 ${String(index)} 形成锚点。`)
    const formationPair = await runPair({ path: `rule-${String(index)}-formation.txt`, traceId: `p3-4-formation-${String(index)}`, anchor: formationAnchor.event })
    const formationRef = formationPair.source
    const claim = makeEblClaim({
      characterId: String(characterId), subjectId: h.userId, domain: 'tool', predicate: 'readback_matches',
      expected: true, scope: 'sandbox_readback', environment: EBL_TOOL_ENVIRONMENT, conditions: { encoding: 'utf8' },
      formation: formationRef,
    })
    await ebl.commit(claim.id, { kind: 'propose', claim })
    /* 冻结政策要求 **两个独立工具测试**：不同 bindingKey / designId / 独立键 */
    for (const slot of [1, 2] as const) {
      const anchor = await h.recordUserEvidence(`规则 ${String(index)} 测试锚点 ${String(slot)}。`)
      await runPair({
        path: `rule-${String(index)}-test-${String(slot)}.txt`,
        traceId: `p3-4-test-${String(index)}-${String(slot)}`,
        anchor: anchor.event,
        settleOn: { claimId: claim.id },
      })
    }
    await ebl.commit(claim.id, { kind: 'review' })
    return { claimId: claim.id, formationRef }
  }

  const firstRule = await formValidatedRule(1)
  const claimId = firstRule.claimId
  const claimState = await ebl.get(claimId)
  const claimSnapshot = await snapshot.current(claimId)
  checkMany('05', 'real chain forms a validated EBL rule; the read surface reports it usable with a version/fingerprint', [
    ...(claimState?.status === 'validated' ? [] : [`status=${String(claimState?.status)}`]),
    ...(claimSnapshot?.usable === true ? [] : [`snapshot=${JSON.stringify(claimSnapshot)}`]),
    ...(claimSnapshot !== undefined && claimSnapshot.claimId === claimId ? [] : ['snapshot claimId mismatch']),
    ...(claimSnapshot !== undefined && claimSnapshot.ruleVersion === claimId ? [] : ['ruleVersion should be the content-addressed claim id']),
  ], `status=${String(claimState?.status)} usable=${String(claimSnapshot?.usable)}`)

  const visible: VisibleRuleContext = {
    subjectId: h.userId, scope: 'sandbox_readback', environment: EBL_TOOL_ENVIRONMENT, conditions: { encoding: 'utf8' },
  }

  /** 用真实目录资产 + 可选依赖检查器，跑一次 `workflow.skill.load`（真实 Gateway + 真适配器）。 */
  async function loadSkill(
    skillId: string,
    dependencies: {
      readonly declarations: readonly WorkflowSkillRuleDependencyDeclaration[]
      readonly snapshotPort: typeof snapshot
      readonly visible: VisibleRuleContext
    } | undefined
  ): Promise<{ status?: string; reason?: unknown; detail?: string }> {
    const registryWithSkills = createCapabilityRegistry([
      ...createLearningCapabilityDefinitions(),
      ...createDefaultCapabilityDefinitions(),
      ...createUtilityCapabilityDefinitions(),
      ...createLocalFileCapabilityDefinitions(),
    ])
    const checker: WorkflowSkillRuleDependencyChecker | undefined = dependencies === undefined ? undefined : createWorkflowSkillRuleDependencyChecker({
      skillId,
      declarations: dependencies.declarations,
      snapshot: dependencies.snapshotPort,
      visible: dependencies.visible,
    })
    if (checker !== undefined) {
      lastChecker = checker
    } else {
      lastChecker = undefined
    }
    const gateway = createActionGateway({
      registry: registryWithSkills, ledger,
      adapters: [createManagedWorkflowSkillAdapter({
        loaded: fixtureLoaded,
        legacySkills: [],
        readStates: (id) => store.readStates(id),
        grantedCapabilities: () => ['workflow.skill', 'library.search', 'local.file.read', 'document.read'],
        registeredCapabilities: () => ['workflow.skill', 'library.search', 'local.file.read', 'document.read'],
        ...(checker === undefined ? {} : { ruleDependency: { checkAtLoad: async (id) => (id === checker.skillId ? await checker.checkAtLoad() : undefined) } }),
      })],
      grantedPermissions: [WORKFLOW_SKILL_PERMISSION, PERSONAL_LIBRARY_PERMISSION],
      maxRiskLevel: 'R1',
      resolveTarget: async ({ request }) => ({
        target: {
          type: 'local_executor',
          canonicalId: request.capability === WORKFLOW_SKILL ? String(request.arguments.skill ?? '') : String(request.arguments.path ?? ''),
          confidence: 'exact',
          display: `p3-4 load ${skillId}`,
        },
        scopeViolation: false,
      }),
    })
    const request = createActionRequest({
      actionId: newActionId(), traceId: asTraceId(`p3-4-load-${String(Date.now())}`),
      capability: WORKFLOW_SKILL, operation: 'load', arguments: { skill: skillId }, requestedBy: { kind: 'user' },
      sideEffect: 'none',
    })
    const result = await gateway.execute(characterId, request)
    return {
      ...(result.status !== undefined ? { status: result.status } : {}),
      ...(result.error !== undefined ? { reason: result.error.details?.['reason'], detail: result.error.message } : {}),
    }
  }
  let lastChecker: WorkflowSkillRuleDependencyChecker | undefined

  const okLoad = await loadSkill(TEST_SKILL_ID, { declarations: [{ claimId }], snapshotPort: snapshot, visible })
  checkMany('06', 'load with a qualified rule dependency succeeds and captures a baseline', [
    ...(okLoad.status === 'success' ? [] : [`load=${JSON.stringify(okLoad)}`]),
    ...(lastChecker?.baselines().length === 1 && lastChecker.baselines()[0]?.claimId === claimId ? [] : [`baselines=${JSON.stringify(lastChecker?.baselines() ?? null)}`]),
  ], `status=${String(okLoad.status)} baselines=${String(lastChecker?.baselines().length ?? 0)}`)

  /* 立刻捕获"加载成功时"的基线与检查器：后面的负控会覆盖 `lastChecker` */
  const loadedChecker = lastChecker
  const capturedBaselines = loadedChecker?.baselines() ?? []

  const productLoad = await loadSkill(PRODUCT_SKILL_ID, undefined)
  checkMany('07', 'a skill without a dependency declaration is unaffected (product skill still loads)', [
    ...(productLoad.status === 'success' ? [] : [`load=${JSON.stringify(productLoad)}`]),
    ...(lastChecker !== undefined ? ['checker should be undefined when the skill has no declaration'] : []),
  ], `status=${String(productLoad.status)}`)

  const wrongScope = await loadSkill(TEST_SKILL_ID, {
    declarations: [{ claimId }], snapshotPort: snapshot,
    visible: { ...visible, scope: 'some_other_scope' },
  })
  checkMany('08', 'wrong scope is not treated as a qualified dependency', [
    ...(wrongScope.status === 'rejected' && wrongScope.reason === 'rule_scope_mismatch' ? [] : [`result=${JSON.stringify(wrongScope)}`]),
  ], `reason=${String(wrongScope.reason)}`)

  const unknownClaim = await loadSkill(TEST_SKILL_ID, {
    declarations: [{ claimId: 'ebl:does-not-exist' }], snapshotPort: snapshot, visible,
  })
  checkMany('09', 'unknown claim is not treated as a qualified dependency', [
    ...(unknownClaim.status === 'rejected' && unknownClaim.reason === 'rule_unknown' ? [] : [`result=${JSON.stringify(unknownClaim)}`]),
  ], `reason=${String(unknownClaim.reason)}`)

  /*
   * ⚠️ 真实状态的覆盖边界（如实写）：本门构造的真实 EBL 状态是
   *    **validated**（00 正控）与 **withdrawn**（加载后失效）。
   *    `pending` / `suspended` / `superseded` / `retired` 的**真实状态**需要
   *    反例测试链 / 预注册链（本门没有造），它们的判据由 check 12 的**纯判据**覆盖 ——
   *    读面路径完全一致（`usable === false` ⇒ `rule_not_usable` + 状态入账），
   *    但**不声称**这四种真实状态已在链上验证。
   */


  // =========================================================================
  // C. 加载之后、动作之前失效：真实任务环拒绝后续依赖动作
  // =========================================================================
  const readPolicy = {
    id: 'p3-4-dependent-offline',
    endpointHost: 'offline',
    async plan() {
      return {
        ok: true as const, requestCount: 1,
        plan: { goal: '读两遍', done: true, steps: [
          { capability: 'sandbox.file.read', operation: 'read', args: { path: 'prepared.txt' } },
          { capability: 'sandbox.file.read', operation: 'read', args: { path: 'prepared.txt' } },
        ] },
      }
    },
  }
  async function runDependentPlan(options: {
    readonly dependencies?: readonly { claimId: string; ruleVersion: string; evidenceFingerprint: string }[]
    /** 负控：声明了依赖但**装配漏传读面**（必须失败关闭，不能静默跳过） */
    readonly omitRuleSnapshot?: boolean
  } = {}) {
    const prepared = 'prepared.txt'
    writeFileSync(join(fsRoot, prepared), '准备好的内容\n', 'utf8')
    const evidence = await h.recordUserEvidence('读两遍（技能依赖联验）')
    const traceId = asTraceId(`p3-4-dependent-${String(Date.now())}`)
    const authorization = authorizations.issue({
      conversationKey: String(evidence.event.conversationId), originalText: 'dependent plan',
      triggeringEventId: String(evidence.event.id), allowedCapabilities: ['sandbox.file.write', 'sandbox.file.read'], maxRiskLevel: 'R1',
    })
    const initiatorEvidence = attestActionInitiatorFromCausalOrigin({
      adapterId: 'p3-4',
      causalSource: correlationSourceFromConversationEvent({ adapterId: 'p3-4', triggeringEvent: triggeringConversationEventOf(evidence.event) }),
    })
    return await runTask({
      gateway: sandboxGateway, registry, authorizations, staging, resolveTarget,
      invocationFor: () => ({ initiatorEvidence, riskBudgetOverride: 'R1' }),
      ...(options.omitRuleSnapshot === true ? {} : { ruleSnapshot: snapshot }),
      ...(options.dependencies !== undefined ? { skillRuleDependencies: options.dependencies } : {}),
      planner: readPolicy,
    }, { characterId, traceId, authorization, text: 'dependent plan' })
  }

  /*
   * 基线来自 check 06 那次**加载成功**（那时规则还合格）。现在先做"还活着"的对照，
   * 然后撤回规则，再做"加载后失效"的拒绝。
   */
  const aliveBeforeAction = loadedChecker === undefined ? undefined : await loadedChecker.checkBeforeAction()
  checkMany('14', 'after a successful load the captured baseline still verifies while the rule is alive', [
    ...(capturedBaselines.length === 1 ? [] : [`baselines=${String(capturedBaselines.length)}`]),
    ...(aliveBeforeAction?.ok === true ? [] : [`beforeAction=${JSON.stringify(aliveBeforeAction)}`]),
  ], `baselines=${String(capturedBaselines.length)}`)

  const aliveRun = await runDependentPlan({ dependencies: capturedBaselines })
  checkMany('15', 'control: with the rule alive, the dependent steps still execute', [
    ...(aliveRun.steps.length === 2 && aliveRun.steps.every((step) => step.status === 'success') ? [] : [
      aliveRun.steps.map((step) => `${step.capability}.${step.operation}=${String(step.status ?? step.droppedReason)}`).join(' | '),
    ]),
  ], `steps=${String(aliveRun.steps.length)}`)

  /*
   * 纯判据覆盖（**明确标注**）：suspended / superseded / 版本冲突 / 读面失败
   * 这四种的**真实状态构造**需要反例测试链或读面故障注入，本门没有造；
   * 这里用夹具快照证明判据本身的闭集行为，不当成"真实状态已验证"。
   */
  const fabricatedBase: UsableRuleSnapshot = {
    claimId: 'ebl:fab', predicate: 'readback_matches', expected: true, claimVersion: 3,
    policy: 'epistemic-policy@2', subjectId: h.userId, scope: 'sandbox_readback',
    environment: EBL_TOOL_ENVIRONMENT, conditions: { encoding: 'utf8' }, ruleVersion: 'ebl:fab',
    sources: [{ kind: 'action', id: 'action:fab', revision: 'r1' }], evidenceFingerprint: 'f'.repeat(64),
    status: 'validated', usable: true,
  }
  /*
   * ⚠️ "四态被拒"的**真正判据是 `usable=false`**：`selectUsableRules` 只读 `usable`，
   *    `status` 只是给人看的标签。所以下面另加一条**反例**：`usable=true` + 一个非
   *    `validated` 的状态标签 ⇒ 判据**不拦**。这条如实记录"`status` 不参与判定"，
   *    并说明 `status → usable` 的映射是**资格读面的责任**（真实读面
   *    `createEblRuleSnapshotPort` 负责），不是本契约的责任。
   */
  const fabricationCases: { id: string; status: string; usable: boolean; reason?: string; code: string }[] = [
    { id: 'suspended', status: 'suspended', usable: false, reason: 'not_usable', code: 'rule_not_usable' },
    { id: 'superseded', status: 'superseded', usable: false, reason: 'not_usable', code: 'rule_not_usable' },
    { id: 'retired', status: 'retired', usable: false, reason: 'not_usable', code: 'rule_not_usable' },
    { id: 'pending', status: 'pending', usable: false, reason: 'not_usable', code: 'rule_not_usable' },
  ]
  const authorityVerdict = decideSkillRuleDependenciesAtLoad({
    declarations: [{ claimId: 'ebl:fab' }],
    snapshots: [{ ...fabricatedBase, status: 'suspended', usable: true }],
    visible,
  })
  checkMany('12', 'pure judgement: `usable=false` snapshots are blocked whatever the status label (a `usable=true` snapshot is NOT blocked — `usable` is the authoritative field, mapping status→usable belongs to the read surface)', [
    ...fabricationCases.flatMap((item) => {
      const verdict = decideSkillRuleDependenciesAtLoad({
        declarations: [{ claimId: 'ebl:fab' }],
        snapshots: [{ ...fabricatedBase, status: item.status, usable: item.usable, ...(item.reason !== undefined ? { invalidatedReason: item.reason as never } : {}) }],
        visible,
      })
      return verdict.ok ? [`${item.id} unexpectedly ok`] : verdict.block.code === item.code ? [] : [`${item.id}=${verdict.block.code}（期望 ${item.code}）`]
    }),
    ...(() => {
      const stale: UsableRuleSnapshot = { ...fabricatedBase, evidenceFingerprint: '0'.repeat(64) }
      const verdict = decideSkillRuleDependenciesAtLoad({
        declarations: [{ claimId: 'ebl:fab', evidenceFingerprint: 'a'.repeat(64) }],
        snapshots: [stale], visible,
      })
      return verdict.ok ? ['version conflict unexpectedly ok'] : verdict.block.code === 'rule_version_conflict' ? [] : [`version=${verdict.block.code}`]
    })(),
    ...(authorityVerdict.ok ? [] : [`usable-authority: usable=true 的快照被拒（${authorityVerdict.block.code}），说明判定实际读了 status`]),
  ], `${fabricationCases.map((item) => `${item.id}=${item.code}`).join(',')},authority=usable`)

  const unreadableVerdict = decideSkillRuleDependenciesAtLoad({
    declarations: [{ claimId }], snapshots: [], visible, snapshotUnreadable: true,
  })
  /*
   * 真实路径：让**端口自己抛错**，走 infra 检查器的 catch（而不是只传 `snapshotUnreadable` 旗标）。
   * ⇒ "读不到 ⇒ 具名拒用"在真实适配器/网关路径上也有读数。
   */
  const throwingPort = {
    current: async (): Promise<UsableRuleSnapshot | undefined> => { throw new Error('p3-4 injected read failure') },
    list: async (): Promise<UsableRuleSnapshot[]> => { throw new Error('p3-4 injected read failure') },
  }
  const unreadableLoad = await loadSkill(TEST_SKILL_ID, { declarations: [{ claimId }], snapshotPort: throwingPort, visible })
  checkMany('13', 'unreadable qualification surface fails closed through the real adapter (injected port failure ⇒ named refusal, never "no dependency")', [
    ...(unreadableVerdict.ok === false && unreadableVerdict.block.code === 'rule_snapshot_unreadable' ? [] : [`pureVerdict=${JSON.stringify(unreadableVerdict)}`]),
    ...(unreadableLoad.status === 'rejected' && unreadableLoad.reason === 'rule_snapshot_unreadable' ? [] : [`realLoad=${JSON.stringify(unreadableLoad)}`]),
  ], `pure=${unreadableVerdict.ok ? 'ok' : unreadableVerdict.block.code} real=${String(unreadableLoad.reason)}`)

  /*
   * 加载之后、动作之前：规则被撤回（基线是 check 06 那次**加载成功**时捕获的）。
   */
  await ebl.commit(claimId, { kind: 'withdraw' })
  const withdrawnSnapshot = await snapshot.current(claimId)
  const withdrawnLoad = await loadSkill(TEST_SKILL_ID, { declarations: [{ claimId }], snapshotPort: snapshot, visible })
  checkMany('11', 'a withdrawn rule is not treated as a qualified dependency (status + reason recorded)', [
    ...(withdrawnSnapshot?.usable === false && withdrawnSnapshot.status === 'withdrawn' ? [] : [`snapshot=${JSON.stringify(withdrawnSnapshot)}`]),
    ...(withdrawnLoad.status === 'rejected' && withdrawnLoad.reason === 'rule_not_usable' ? [] : [`result=${JSON.stringify(withdrawnLoad)}`]),
  ], `status=${String(withdrawnSnapshot?.status)} reason=${String(withdrawnLoad.reason)}`)

  const invalidated = loadedChecker === undefined ? undefined : await loadedChecker.checkBeforeAction()
  /*
   * ⚠️ 撤回会**改证据指纹**（forbiddenRoots 进入观测 revision）⇒ P2 的判据顺序（先版本/指纹、
   *    后状态）让它表现为 `version_conflict` 而不是 `source_withdrawn`。两者都是"基线不再成立"，
   *    检查只要求：**必须被拒** + **原因落在闭集里**（并如实记录是哪一个）。
   */
  const blockedCodes = new Set(['rule_invalidated_after_load', 'rule_version_conflict'])
  const invalidatedProblems: string[] = []
  if (invalidated === undefined) invalidatedProblems.push('no checker')
  else if (invalidated.ok) invalidatedProblems.push('unexpectedly ok')
  else if (!blockedCodes.has(invalidated.block.code)) invalidatedProblems.push(`code=${invalidated.block.code}`)
  checkMany('16', 'rule withdrawn between load and action ⇒ before-action check refuses with a closed reason', invalidatedProblems,
    invalidated === undefined ? 'no checker' : invalidated.ok ? 'ok' : invalidated.block.code)

  const blockedRun = await runDependentPlan({ dependencies: capturedBaselines })
  /* 负控：声明了依赖但**没有读面** ⇒ 必须失败关闭（不能因为 `ruleSnapshot` 缺失就静默放行） */
  const noSurfaceRun = await runDependentPlan({ dependencies: capturedBaselines, omitRuleSnapshot: true })
  const blockedSteps = blockedRun.steps
  checkMany('17', 'real task loop: dependent steps do NOT execute after invalidation, and declared dependencies without a read surface fail closed', [
    ...(blockedSteps.some((step) => step.droppedReason === 'skill_rule_unusable') ? [] : [
      blockedSteps.map((step) => `${step.capability}.${step.operation}=${String(step.status ?? step.droppedReason)}`).join(' | ') || 'no steps',
    ]),
    ...(blockedSteps.every((step) => step.status === undefined) ? [] : ['a dependent step actually executed']),
    ...(noSurfaceRun.steps.some((step) => step.droppedReason === 'skill_rule_unusable') ? [] : [
      `no-surface run=${noSurfaceRun.steps.map((step) => `${step.operation}=${String(step.status ?? step.droppedReason)}`).join(' | ') || 'no steps'}`,
    ]),
    ...(noSurfaceRun.steps.every((step) => step.status === undefined) ? [] : ['no-surface run executed a step']),
  ], `${blockedSteps.map((step) => `${step.operation}=${String(step.status ?? step.droppedReason)}`).join(' | ')} · noSurface=${noSurfaceRun.steps.length} step(s), 0 executed`)

  const controlRun = await runDependentPlan()
  checkMany('18', 'without the skill dependency (option absent) the same plan is NOT refused — old behaviour unchanged', [
    ...(controlRun.steps.length === 2 && controlRun.steps.every((step) => step.status === 'success') ? [] : [
      controlRun.steps.map((step) => `${step.operation}=${String(step.status ?? step.droppedReason)}`).join(' | '),
    ]),
  ], `steps=${String(controlRun.steps.length)}`)

  /* 版本/证据指纹冲突（真实读面 + 错误基线） */
  const staleVerdict = await decideSkillRuleDependenciesBeforeAction({
    baselines: [{ claimId, ruleVersion: claimId, evidenceFingerprint: '0'.repeat(64) }],
    snapshot,
  })
  checkMany('19', 'stale baseline (evidence fingerprint changed) is a version conflict, not a silent pass', [
    ...(staleVerdict.ok === false && staleVerdict.block.code === 'rule_version_conflict' ? [] : [`verdict=${JSON.stringify(staleVerdict)}`]),
  ], staleVerdict.ok ? 'ok' : staleVerdict.block.code)


  // =========================================================================
  // D. 不复制 EBL 资格系统 / 不回灌规则证据
  // =========================================================================
  const sourceOf = (path: string): string => readFileSync(resolve(path), 'utf8')
  const kernelContract = sourceOf('src/kernel/contracts/workflow-skill-rule-dependency.ts')
  const infraAdapter = sourceOf('src/infrastructure/action/workflow-skill-rule-dependency.ts')
  const managedAdapter = sourceOf('src/infrastructure/action/adapters/workflow-skill.ts')
  const mainSource = sourceOf('src/main.ts')
  assertMigrationsWellFormed()
  /*
   * ⚠️ 只看**import 语句**（注释里提到 EBL 不算"导入实现"）：
   *    判据是 `from '…epistemic-belief…'` 这种模块说明符。
   */
  const importsModule = (source: string, names: readonly string[]): boolean =>
    names.some((name) => new RegExp(`from\\s+['"][^'"]*${name}`).test(source))
  checkMany('20', 'P3 does not duplicate EBL qualification: no EBL store/impl imports in the new P3 modules', [
    ...(importsModule(kernelContract, ['epistemic-belief']) ? ['kernel dependency contract imports EBL'] : []),
    ...(importsModule(infraAdapter, ['epistemic-belief', 'ebl-rule-snapshot']) ? ['infra dependency adapter imports EBL implementation'] : []),
    ...(kernelContract.includes('cognitive-collaboration') ? [] : ['kernel dependency contract should reuse the P1/P2 contract']),
  ], 'kernel→contract only; infra→RuleSnapshotPort only')

  const eblEventCount = async (): Promise<number> => {
    const rows = await exec(h.db, sql`select count(*)::int as n from character_domain_events where type = 'EPISTEMIC_BELIEF_RECORDED'`, '统计 EBL 事件数')
    return Number(rows[0]?.n ?? 0)
  }
  const eblBefore = await eblEventCount()
  const productLoad2 = await loadSkill(PRODUCT_SKILL_ID, undefined)
  const blockedAgain = await runDependentPlan({ dependencies: capturedBaselines })
  const eblAfter = await eblEventCount()
  checkMany('21', 'skill load / blocked dependent action never write rule evidence (EBL event count unchanged)', [
    ...(eblBefore > 0 ? [] : ['baseline EBL event count is 0 — this check would be vacuous']),
    ...(eblAfter === eblBefore ? [] : [`EBL events ${String(eblBefore)}→${String(eblAfter)}`]),
    ...(productLoad2.status === 'success' ? [] : ['product skill load failed']),
    ...(blockedAgain.steps.every((step) => step.status === undefined) ? [] : ['blocked run executed a step']),
  ], `eblEvents=${String(eblBefore)}→${String(eblAfter)}`)

  /*
   * 结构锁（**全 `src` 扫描**，不只看 `main.ts` 的字符串）：
   *   · `skillRuleDependencies` 只应出现在任务环（选项定义 + 本闸）
   *   · `ruleDependency` 只应出现在受管适配器（选项定义 + 调用）
   *   · 全 `src` 里没有第二个"传值"站点 ⇒ **真的没有**第二个装配点
   */
  const walkSourceFiles = (dir: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walkSourceFiles(full))
      else if (entry.name.endsWith('.ts')) out.push(full)
    }
    return out
  }
  const srcRoot = resolve('src')
  const srcFiles = walkSourceFiles(srcRoot)
  const filesMentioning = (needle: string): string[] =>
    srcFiles
      .filter((file) => readFileSync(file, 'utf8').includes(needle))
      .map((file) => relative(resolve('.'), file).replace(/\\/g, '/'))
      .sort()
  const declarationSites = filesMentioning('skillRuleDependencies')
  const hookSites = filesMentioning('ruleDependency')
  checkMany('22', 'production entry has no P3-4 wiring: the dependency gate is opt-in, its only definition sites are the task loop + managed adapter, and nothing in `src` passes them', [
    ...(!mainSource.includes('workflow-skill-rule-dependency') ? [] : ['main.ts imports the dependency module']),
    ...(!mainSource.includes('skillRuleDependencies') ? [] : ['main.ts sets skillRuleDependencies']),
    ...(managedAdapter.includes('ruleDependency') ? [] : ['managed adapter should expose the optional hook']),
    ...(declarationSites.length === 1 && declarationSites[0] === 'src/kernel/action/task-loop.ts'
      ? []
      : [`skillRuleDependencies sites=${declarationSites.join(',') || '(none)'}`]),
    ...(hookSites.length === 1 && hookSites[0] === 'src/infrastructure/action/adapters/workflow-skill.ts'
      ? []
      : [`ruleDependency sites=${hookSites.join(',') || '(none)'}`]),
  ], `schema=${String(latestSchemaVersion())} declarationSites=${String(declarationSites.length)} hookSites=${String(hookSites.length)}`)

  const flags = readKernelFlags({})
  /*
   * ⚠️ 断言口径（2026-10-28 协同再基线）：**不再**断言"全局 schema 恰好 26"。
   *    迁移会被**别的域**合法新增（例：并行工作流的 QQ 群任务域加了迁移 27），
   *    把全局常量钉死会让本门在**与 P3-4 无关**的改动后变红 ⇒ 那是脆断言，不是纪律。
   *    改为**批内相对**断言：
   *      ① P3 基线迁移（25/26）仍在（`latestSchemaVersion() >= 26`）；
   *      ② **本批没有新增迁移**（迁移清单里没有任何一条属于规则依赖）。
   *    语义等价于原来那句"schema still 26 (no new migration)"，但不再被外部迁移误伤。
   */
  const migrationsWithRuleDependency = MIGRATIONS.filter(migration =>
    `${migration.name} ${migration.statements.join(' ')}`.includes('rule-dependency') ||
    `${migration.name} ${migration.statements.join(' ')}`.includes('rule_dependency'))
  checkMany('23', 'P2 thresholds / switches untouched: P3 defaults still off; the P3 migration baseline is intact and **this batch added no migration**', [
    ...(flags.workflowSkillsEnabled === false ? [] : ['workflowSkillsEnabled']),
    ...(flags.workflowSkillCatalogEnabled === false ? [] : ['workflowSkillCatalogEnabled']),
    ...(latestSchemaVersion() >= 26 ? [] : [`schema=${String(latestSchemaVersion())}`]),
    ...(migrationsWithRuleDependency.length === 0 ? [] : [`本批新增了迁移：${migrationsWithRuleDependency.map(m => String(m.version)).join(',')}`]),
  ], `schema=${String(latestSchemaVersion())} catalogEnabled=${String(flags.workflowSkillCatalogEnabled)} p3Migrations=${String(migrationsWithRuleDependency.length)}`)

  /* 最终状态复核：已撤回的规则仍然不可用（没有"后来的通过"把它洗白） */
  const finalWithdrawn = await snapshot.current(claimId)
  const finalScopeVerdict = decideSkillRuleDependenciesAtLoad({
    declarations: [{ claimId }],
    snapshots: finalWithdrawn === undefined ? [] : [finalWithdrawn],
    visible,
  })
  checkMany('24', 'final state: the withdrawn rule is still unusable and the test skill registration is intact', [
    ...(finalScopeVerdict.ok === false && finalScopeVerdict.block.code === 'rule_not_usable' ? [] : [`verdict=${JSON.stringify(finalScopeVerdict)}`]),
    ...((await store.readCurrent(TEST_SKILL_ID)) !== undefined ? [] : ['test skill registration missing']),
  ], finalScopeVerdict.ok ? 'ok' : finalScopeVerdict.block.code)

  readings.fixture = { testSkillId: TEST_SKILL_ID, testSkillCurrent: testCurrent?.version, productSkills: realSkillIds }
  readings.realRule = { claimId, status: claimState?.status, withdrawnStatus: withdrawnSnapshot?.status }
  readings.beforeAction = {
    alive: aliveBeforeAction?.ok === true,
    blocked: invalidated === undefined ? 'no_checker' : invalidated.ok ? 'ok' : invalidated.block.code,
    blockedRuleReason: invalidated === undefined || invalidated.ok ? null : (invalidated.block.ruleReason ?? null),
    blockedRunDropped: blockedSteps.map((step) => step.droppedReason ?? null),
  }
} catch (error) {
  console.error(error)
  checkMany('99', 'verification completed without unexpected exception', [String(error)])
} finally {
  await h.stop()
}

const passed = checks.filter((row) => row.pass).length
const failed = checks.length - passed
const summary = {
  gate: 'p3:skill-rule-dependency:verify',
  script: 'scripts/cognitive/p3-skill-rule-dependency-verify.ts',
  isolation: {
    backend: sandbox.backend,
    productionDatabaseTouched: false,
    realModelRequests: 0,
    networkRequests: 0,
    basis: 'isolated lg_test_* database; gate builds no model or HTTP port',
  },
  counts: { total: checks.length, passed, failed },
  elapsedMs: Date.now() - startedAt,
  checks,
  readings,
}
writeFileSync(join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
console.log(`\nP3 rule-dependency gate: ${passed} PASS / ${failed} FAIL / ${checks.length} total（${String(summary.elapsedMs)} ms）`)
console.log(`evidence: ${outputDir}`)
process.exitCode = failed === 0 && checks.length > 0 ? 0 : 1
