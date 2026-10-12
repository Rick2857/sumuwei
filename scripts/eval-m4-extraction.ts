/**
 * M4 抽取行为评测执行器 —— `evals/m4/extraction-cases.ts` 的 Runner。
 *
 * ============================================================================
 *  两档，与 M3 的 `eval:m3` / `eval:m3:live` 同一个分法
 * ============================================================================
 *   默认（离线）  —— 只跑 `requiresLiveModel: false` 的用例。
 *                    不调模型、不需要 API Key、秒级。CI 用这个。
 *   `--live`      —— 跑全部用例，抽取交给**真实模型**。
 *                    需要 API Key，人工 / 主分支用。
 *
 * 这个分法不是"省事"：离线段守的是**结构性**的硬 Gate
 * （她的输出抽不出东西、否定不被读成肯定、坏 JSON 抛错），
 * 而那些恰好是不需要模型就能证伪的。真实模型档守的是"模型产出的东西
 * 能不能通过 Source Firewall 与值闸"—— 那必须用真模型。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 判据是结构性的，没有 LLM judge
 * ---------------------------------------------------------------------------
 * 计划书第 187 节列的四类（extraction / authority / contamination /
 * explicit intent）全都可以结构化判定：几条、什么类型、什么权威、
 * 哪些槽位必须出现或必须不出现。
 * 一个"看起来答得不错"的分数在 M4 毫无价值，而"她的猜测有没有被存成
 * 用户事实"必须是一个布尔。
 *
 * 计划书第 188 节把 DB persistence / idempotency / replay / status
 * transition 等明确划给**纯程序测试**（在 `m4:verify` / `m4:test` 里），
 * 因此这里一条都不重复。
 *
 * 跑法：
 *   tsx scripts/eval-m4-extraction.ts                  # 离线档
 *   tsx scripts/eval-m4-extraction.ts --live            # 真实模型档
 *   tsx scripts/eval-m4-extraction.ts --suite authority # 只跑某个套件
 *   tsx scripts/eval-m4-extraction.ts --stdout --quiet  # 供 Promptfoo 调用
 */

import 'dotenv/config'

import { character } from '../src/character/index.ts'
import {
  LlmMemoryExtractor,
  RuleBasedMemoryExtractor,
  processorEventViewOf,
  resolveCandidates,
  type MemoryExtractionResult,
} from '../src/kernel/app/memory/extractor.ts'
import { applyValueGate, DEFAULT_IMPORTANCE_THRESHOLD } from '../src/kernel/app/memory/value.ts'
import {
  createExplicitMemoryIntentDetector,
  detectExplicitIntentFromEvent,
} from '../src/kernel/app/memory/intent-detector.ts'
import {
  entityRef,
  type EntityRef,
  type MemoryCandidate,
} from '../src/kernel/contracts/index.ts'
import type { ConversationEvent } from '../src/kernel/contracts/index.ts'
import {
  EXTRACTION_EVAL_CASES,
  casesWithNoBindingExpectation,
  hasBindingExpectation,
  type ExtractionEvalCase,
  type ExtractionEvalSuite,
  type ExtractionExpectations,
} from '../evals/m4/extraction-cases.ts'

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

/**
 * 可重复的 flag：`--filter A --filter B` 两个都要生效。
 *
 * 之前的单值实现里**第二个会静默覆盖第一个**，于是"跑两条失败用例"
 * 实际上只跑了一条 —— 而输出仍然打印"1 通过 / 0 失败"，
 * 是**绿色的**。这是最坏的一类评测缺陷：范围被悄悄缩小，
 * 结果却读起来像全过。迭代排查失败用例时几乎每次都会踩。
 */
const flags = (name: string): string[] => {
  const values: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && argv[i + 1] !== undefined) values.push(argv[i + 1]!)
  }
  return values
}

const live = argv.includes('--live')
const quiet = argv.includes('--quiet')
const onlySuite = flag('--suite') as ExtractionEvalSuite | undefined
const filters = flags('--filter')

/**
 * 值闸阈值：用**产品默认值**，不在这里写一个魔数。
 *
 * ⚠️ 原来 live 档写的是字面量 `0.45`，离线档**根本没传**。
 * 两处后果：
 *   · 默认值改了以后评测仍然按 0.45 算 —— 评测与产品脱节，
 *     而报告上看不出来（数字一样好看）
 *   · 离线档拿不到阈值 → `maxValueGateSurvivors` 这类判据静默不生效
 *     （runner 里是 `threshold !== undefined` 守卫），
 *     于是 M4X-004 在离线档永远绿
 *
 * 从 `value.ts` 取常量，让"评测用的阈值"与"产品用的阈值"是**同一个来源**。
 */
const VALUE_GATE_THRESHOLD = DEFAULT_IMPORTANCE_THRESHOLD

const log = (message: string): void => {
  if (!quiet) console.log(message)
}

// ---------------------------------------------------------------------------
// 夹具：把评测用例的事件渲染成**真实形状**的 ConversationEvent
// ---------------------------------------------------------------------------

/**
 * 用 `createConversationEvent` 造事件（而不是手搓对象）。
 *
 * 这一点很关键：手搓对象会绕过 `assertSourceConsistency`
 * （"来源一致性检查，失败关闭"），于是评测跑的可能是一批
 * **现实中造不出来的**事件。用真实构造器意味着评测输入的来源标签
 * 与生产完全同源。
 */
const { createConversationEvent } = await import('../src/kernel/contracts/index.ts')
const { asCharacterId, asConversationId } = await import('../src/kernel/contracts/index.ts')
const { createHumanConsoleUserTurnIngress, createCharacterAssistantTurnIngress } = await import(
  '../src/infrastructure/runtime/conversation-attribution.ts'
)

const EVAL_CHARACTER_ID = asCharacterId(String(character.id ?? character.name))
const EVAL_CONVERSATION_ID = asConversationId(`dm-${String(character.id ?? character.name)}-m4eval`)

/*
 * M5.1.1 / Phase 4a（ADR-043 `DR-6`）：**受信 ingress 各一份**（不是每例一份）。
 *
 * 这两个工厂是生产入口的角色专用构造器；评测用它们来回答
 * "这条行是**怎么被写进来的**"，而不是让夹具自己声明一个来源。
 * ⚠️ `createAgentRunnerUserTurnIngress()` 在这里**刻意不用**：它代表
 * "程序化替用户提交"（D01 形状），而那属于 wp7/D01 的用例，不是本评测的语料。
 */
const EVAL_USER_INGRESS = createHumanConsoleUserTurnIngress()
const EVAL_CHARACTER_INGRESS = createCharacterAssistantTurnIngress()

/**
 * 把评测用例的事件渲染成**真实形状**的 `ConversationEvent`（带**受信归因**）。
 *
 * `'system'` 事件**不**带信封：生产里 `system_event` 没有对应的 ingress
 * （`conversationAttributionForEntryMode` 只装"用户"与"她的输出"两条通道），
 * 所以它的来源天然是"未确立" —— 夹具照实反映这一点，而不是给它补一个。
 */
function materializeEvents(testCase: ExtractionEvalCase): ConversationEvent[] {
  return testCase.events.map((e) => {
    const characterId = String(EVAL_CHARACTER_ID)
    const trustedAttribution =
      e.actor === 'user'
        ? EVAL_USER_INGRESS.attest({
            characterId,
            presenterActorId: 'user_alex',
            userId: 'user_alex',
          })
        : e.actor === 'character'
          ? EVAL_CHARACTER_INGRESS.attest({ characterId, presenterActorId: characterId })
          : undefined

    return createConversationEvent({
      characterId: EVAL_CHARACTER_ID,
      conversationId: EVAL_CONVERSATION_ID,
      conversationSequence: e.sequence,
      sequence: e.sequence,
      type:
        e.actor === 'user'
          ? 'user_message'
          : e.actor === 'character'
            ? 'assistant_message'
            : 'system_event',
      actorType: e.actor,
      ...(e.actor === 'character' ? { actorId: String(EVAL_CHARACTER_ID) } : {}),
      ...(e.actor === 'user' ? { actorId: 'user_alex' } : {}),
      content: e.content,
      // 时间固定：评测不该因为"跑在哪一天"而不同
      createdAt: 1_800_000_000_000,
      ...(trustedAttribution !== undefined ? { trustedAttribution } : {}),
    })
  })
}

// ---------------------------------------------------------------------------
// 判据（**结构性**，纯函数）
// ---------------------------------------------------------------------------

interface CaseOutcome {
  caseId: string
  suite: ExtractionEvalSuite
  passed: boolean
  failedChecks: { id: string; detail: string }[]
  candidateCount: number
  /** 顶层被拒的候选（Source Firewall / 契约断言） */
  rejectedCount: number
  live: boolean
  skipped?: string
  /**
   * **空过**：这条用例的绑定判据在本次实际输出下**不可能失败**。
   *
   * ========================================================================
   *  ⚠️ 为什么 green 还需要再分一层
   * ========================================================================
   * 实测（真实模型档）M4X-020 / M4X-021 两次都是「候选 0 / 被拒 0」——
   * 它们的 `mustExcludeTypes` / `authoritiesAllowed` 只在
   * `candidates.length > 0` 时才执行。模型什么都没抽，于是那些判据
   * **一条都没跑**，用例是绿的。
   *
   * 那个绿最容易被误读成"防火墙挡住了污染"（毕竟用例名这么写）。
   * 它实际说明的是"模型这次很客气"。两者是完全不同的结论，
   * 而报告上它们长得一样。
   *
   * 判定方式（刻意保守，宁可漏报也不误报）：
   *   candidates 与 rejected **都**为 0
   *   且用例含"只在坏输出上才触发"的判据
   *     （mustExcludeTypes / mustExcludePredicates / authoritiesAllowed /
   *       minRejected / maxValueGateSurvivors）
   *   且**没有** `expectEmpty: true`
   *     —— 那条是"0 才是对的"的**正面**断言，绿是有内容的。
   *
   * 它**不是失败**，只是"这条绿色不构成证据"。单独计数、单独打印，
   * 因为把一个无信息量的绿混进"通过"的总数里，正是这些用例
   * 一开始骗过我的方式。
   */
  vacuous?: boolean
}

function evaluateCase(
  testCase: ExtractionEvalCase,
  result: MemoryExtractionResult,
  options: { live: boolean; threshold?: number }
): CaseOutcome {
  const failed: CaseOutcome['failedChecks'] = []
  const expects = testCase.expects
  const candidates = result.candidates

  const fail = (id: string, detail: string) => failed.push({ id, detail })

  // --- 条数 -------------------------------------------------------------
  if (expects.expectEmpty === true && candidates.length !== 0) {
    fail(
      'expectEmpty',
      `期望 0 条候选，实际 ${candidates.length} 条：` +
        candidates.map((c) => `${c.proposedType}/${describe(c)}`).join(' | ')
    )
  }
  if (expects.minCandidates !== undefined && candidates.length < expects.minCandidates) {
    fail('minCandidates', `期望至少 ${expects.minCandidates} 条，实际 ${candidates.length} 条`)
  }
  if (expects.maxCandidates !== undefined && candidates.length > expects.maxCandidates) {
    fail(
      'maxCandidates',
      `期望至多 ${expects.maxCandidates} 条，实际 ${candidates.length} 条：` +
        candidates.map((c) => `${c.proposedType}/${describe(c)}`).join(' | ')
    )
  }

  // --- 类型 -------------------------------------------------------------
  if (expects.mustIncludeTypes !== undefined && expects.mustIncludeTypes.length > 0) {
    const types = new Set(candidates.map((c) => c.proposedType))
    /*
     * ⚠️ 语义是「**任一**命中即可」，而这里原来写的是"全部都要有"：
     *
     *     const missing = expects.mustIncludeTypes.filter((t) => !types.has(t))
     *     if (missing.length > 0) fail(...)
     *
     * 接口上的文档（`ExtractionExpectations.mustIncludeTypes`）写的是
     * `必须出现的记忆类型（任一）`，`mustIncludePredicates` 用的是 `.some()`
     * —— 只有这一处是 `.filter` + 全部匹配。
     *
     * 后果是实测出来的：M4X-005 的模型输出 `episode`（**正确答案**，
     * 一段完成态的共同经历），却因为"没有同时是 self_experience"
     * 被判失败。一条判据与自己声明的语义相反，
     * 会让开发者去"修"一个根本没坏的东西。
     */
    const hit = expects.mustIncludeTypes.some((t) => types.has(t))
    if (!hit) {
      fail(
        'mustIncludeTypes',
        `期望出现 ${expects.mustIncludeTypes.join(' 或 ')}，实际类型：${[...types].join(',') || '(无候选)'}`
      )
    }
  }
  if (expects.mustExcludeTypes !== undefined && expects.mustExcludeTypes.length > 0) {
    const offenders = candidates.filter((c) => expects.mustExcludeTypes!.includes(c.proposedType))
    if (offenders.length > 0) {
      fail(
        'mustExcludeTypes',
        `**污染**：出现了不该有的类型 ${offenders
          .map((c) => `${c.proposedType}/${describe(c)}`)
          .join(', ')}（计划书第 148 / 149 节的 Critical Test）`
      )
    }
  }

  // --- 槽位 -------------------------------------------------------------
  const predicates = new Set(
    candidates
      .map((c) => (c.proposedContent.kind === 'claim' ? c.proposedContent.predicate : undefined))
      .filter((p): p is string => p !== undefined)
  )
  if (expects.mustIncludePredicates !== undefined && expects.mustIncludePredicates.length > 0) {
    const hit = expects.mustIncludePredicates.some((p) => predicates.has(p))
    if (!hit) {
      fail(
        'mustIncludePredicates',
        `期望出现 ${expects.mustIncludePredicates.join(' 或 ')}，实际：${[...predicates].join(', ') || '(无)'}`
      )
    }
  }
  if (expects.mustExcludePredicates !== undefined) {
    const hit = expects.mustExcludePredicates.filter((p) => predicates.has(p))
    if (hit.length > 0) fail('mustExcludePredicates', `出现了不该有的槽位：${hit.join(', ')}`)
  }

  // --- 权威 -------------------------------------------------------------
  if (expects.authoritiesAllowed !== undefined && candidates.length > 0) {
    const offenders = candidates.filter((c) => !expects.authoritiesAllowed!.includes(c.authority))
    if (offenders.length > 0) {
      fail(
        'authoritiesAllowed',
        `权威越界：${offenders.map((c) => `${c.proposedType}=${c.authority}`).join(', ')}`
      )
    }
  }

  // --- 证据必须在批次里（Source Firewall 的硬要求）----------------------
  if (expects.requireEvidenceInBatch === true) {
    const sequences = new Set(testCase.events.map((e) => e.sequence))
    const offenders = candidates.filter((c) => {
      const all = [...c.sourceRefs.map((r) => r.id), ...c.evidenceRootIds]
      return all.some((id) => {
        const seq = Number(String(id).split(':').pop())
        return !Number.isSafeInteger(seq) || !sequences.has(seq)
      })
    })
    if (offenders.length > 0) {
      fail(
        'requireEvidenceInBatch',
        `候选引用了本批次以外的证据：${offenders.map((c) => String(c.proposedId)).join(', ')}`
      )
    }
  }

  // --- 值闸（**最终是否留下了长期记忆**的唯一判据）----------------------
  /*
   * ==========================================================================
   *  ⚠️ 这一段原来**只记录、从不判失败**
   * ==========================================================================
   * 原注释写着"值闸的判据由专门的用例守（kernel-tests-memory）"——
   * 但那是**另一层**的测试。在这一层，M4X-004 声称
   * 「一次性状态 → 不该成为长期记忆」，而它够不到值闸的结论，
   * 于是"午餐被永久记住"也判它通过。
   *
   * 值闸的**领域规则**确实由 kernel-tests-memory 守；
   * 但"这一批候选里有没有东西活下来"只有这里能算 —— 两层都要有。
   */
  if (options.threshold !== undefined && candidates.length > 0) {
    const gated = applyValueGate(candidates, { threshold: options.threshold })
    const survivors = gated.filter((g) => g.ok).length

    if (
      expects.maxValueGateSurvivors !== undefined &&
      survivors > expects.maxValueGateSurvivors
    ) {
      const kept = gated
        .filter((g) => g.ok)
        .map((g) => `${g.candidate.proposedType}/${describe(g.candidate)}`)
        .join(', ')
      fail(
        'maxValueGateSurvivors',
        `期望至多 ${expects.maxValueGateSurvivors} 条穿过值闸，实际 ${survivors} 条：${kept}` +
          '（值闸放行 = 会被**永久写入**长期记忆）'
      )
    }

    // 只记录，便于人工读报告
    log(`     值闸（阈值 ${options.threshold}）：${survivors}/${candidates.length} 通过`)
  }

  // --- 顶层被拒条数 -----------------------------------------------------
  /*
   * 注入型用例里，`expectEmpty` 只能证明"没有坏东西活下来"，
   * **不能**证明"闸动过"。少了这一条，注入一旦静默失效，
   * 用例会在"闸根本没被触发"的情况下继续绿。
   * 详见 `ExtractionExpectations.minRejected` 上的说明。
   */
  if (expects.minRejected !== undefined && result.rejected.length < expects.minRejected) {
    fail(
      'minRejected',
      `期望至少 ${expects.minRejected} 条被顶层拒绝，实际 ${result.rejected.length} 条` +
        '（闸没动 → 这条用例没在测它声称要测的东西）'
    )
  }

  /*
   * --- 空过判定 -----------------------------------------------------------
   * 见 `CaseOutcome.vacuous` 的说明。这里只**标注事实**，不改变通过与否：
   * 一个空过的绿仍然是绿，但它不构成"这条用例声称守护的东西已被验证"的证据。
   */
  const onlyFiresOnBadOutput =
    (expects.mustExcludeTypes?.length ?? 0) > 0 ||
    (expects.mustExcludePredicates?.length ?? 0) > 0 ||
    (expects.authoritiesAllowed?.length ?? 0) > 0 ||
    expects.minRejected !== undefined ||
    expects.maxValueGateSurvivors !== undefined

  const vacuous =
    failed.length === 0 &&
    candidates.length === 0 &&
    result.rejected.length === 0 &&
    onlyFiresOnBadOutput &&
    expects.expectEmpty !== true

  return {
    caseId: testCase.id,
    suite: testCase.suite,
    passed: failed.length === 0,
    failedChecks: failed,
    candidateCount: candidates.length,
    rejectedCount: result.rejected.length,
    live: options.live,
    vacuous,
  }
}

function describe(candidate: MemoryCandidate): string {
  if (candidate.proposedContent.kind === 'claim') {
    return `${candidate.proposedContent.predicate}=${String(candidate.proposedContent.value)}`
  }
  return candidate.proposedContent.summary.slice(0, 40)
}

/**
 * 定向注入：把**坏模型输出**喂给解析路径，断言它抛错而不是被"猜"出来。
 *
 * 计划书第 146 节：
 *     如果 extractor 返回 invalid schema → retry within policy
 *     仍失败 → job failed。**不能自动尝试猜 JSON**。
 *
 * 这条不需要真实模型：喂一个确定的坏字符串就够，而且**更严格**
 * （真实模型偶尔会吐合法 JSON，于是用例会偶发通过，掩盖解析路径的缺陷）。
 *
 * `rejectedCount` 被复用来表达"注入是否按预期失败"（1 = 抛了正确的错）
 * —— 那个字段在注入型用例里没有别的含义。这是刻意的：
 * 与其新增一个只在这一处用的字段，不如复用并在这里说明。
 */
async function runMalformedOutputInjection(
  testCase: ExtractionEvalCase,
  views: readonly ReturnType<typeof processorEventViewOf>[],
  owner: EntityRef,
  speaker: EntityRef
): Promise<CaseOutcome> {
  const extractor = new LlmMemoryExtractor()
  let threw = false
  let code = ''
  try {
    await extractor.process(
      { views, owner, speaker },
      {
        processorName: 'memory-extractor',
        processorVersion: 'memory-extractor@1',
        // "看起来像在解释但完全不是 JSON" —— 正是计划书第 146 节
        // 点名禁止去"猜"的那种输出
        invokeModel: async () => '我认为这一轮值得记住，因为用户说了不吃香菜',
      }
    )
  } catch (error) {
    threw = true
    code = String((error as { code?: string }).code)
  }

  const expected = 'memory_extractor_malformed_output'
  const ok = threw && code === expected
  return {
    caseId: testCase.id,
    suite: testCase.suite,
    passed: ok,
    failedChecks: ok
      ? []
      : [
          {
            id: 'malformed_output_not_rejected',
            detail: threw
              ? `抛了错但错误码是 ${code}（期望 ${expected}）`
              : '坏输出被接受了 —— 计划书第 146 节明确禁止猜 JSON',
          },
        ],
    candidateCount: 0,
    rejectedCount: ok ? 1 : 0,
    live: false,
  }
}

/**
 * 显式意图判据：把用例声明的意图真的**判一遍**。
 *
 * ============================================================================
 *  ⚠️ 这段存在的理由：两条用例声称在测意图，却从未调用过判定器
 * ============================================================================
 * M4X-030（「记住，我不吃香菜」→ remember）与 M4X-031
 * （「不要再记这件事了」**不得**被读成"记住"）的 `expects` 里
 * 原本只有候选数。把 `REMEMBER_KEYWORDS` / `FORGET_KEYWORDS`
 * 整张表删掉，两条用例依然是绿的 —— 而它们的名字会让后来的人
 * 相信"显式意图理解已被验证"。
 *
 * 意图判定是**纯规则**（`RuleOnlyMemoryIntentClassifier`），完全确定，
 * 因此这条判据不依赖模型、在离线档也跑，而且比"看模型抽出了什么"严格。
 *
 * `detectExplicitIntentFromEvent` 只接受用户事件（她自己说的话
 * **永远**不可能被读成"用户要求记住"）—— 这里刻意走那个入口而不是
 * 直接调 `detect()`：判据要测的是**生产路径上的那道闸**，
 * 而不是一个平行实现。
 */
async function checkExplicitIntent(
  testCase: ExtractionEvalCase,
  events: readonly ConversationEvent[]
): Promise<{ id: string; detail: string }[]> {
  const expectation = testCase.expects.expectExplicitIntent
  if (expectation === undefined) return []

  const event = events.find((e) => e.sequence === expectation.sequence)
  if (event === undefined) {
    return [
      {
        id: 'expectExplicitIntent',
        detail: `用例声明要判事件 ${expectation.sequence} 的意图，但该事件不存在`,
      },
    ]
  }

  const detector = createExplicitMemoryIntentDetector()
  const detected = await detectExplicitIntentFromEvent(detector, {
    id: event.id,
    actorType: event.actorType,
    content: event.content,
  })

  const actual = detected?.kind ?? 'none'
  if (actual === expectation.intent) return []

  return [
    {
      id: 'expectExplicitIntent',
      detail:
        `事件 ${expectation.sequence}「${event.content}」的意图期望 ${expectation.intent}，` +
        `实际 ${actual}${detected !== undefined ? `（命中「${detected.matched}」，来源 ${detected.detectedBy}）` : ''}`,
    },
  ]
}

/**
 * 定向注入：把**她自己的消息**当证据，硬塞两条污染候选给 Source Firewall。
 *
 * ============================================================================
 *  ⚠️ 这段存在的理由：live 档的污染用例是**空过**的
 * ============================================================================
 * 实测（真实模型档）M4X-020 / M4X-021 两次都是「候选 0 / 被拒 0」：
 * 模型本来就没从那些句子里抽出任何东西，于是 `mustExcludeTypes` 与
 * `authoritiesAllowed` **一条都没执行**，用例绿得毫无信息量 ——
 * 它证明的是"模型很客气"，**不是**"防火墙挡住了污染"。
 *
 * 而计划书第 148 / 149 节把这条称作 Critical Test。一个 Critical Test
 * 的绿不能取决于模型当天的心情的。
 *
 * 注入的候选是**确定构造**的：
 *   · `person_fact`（subject USER）+ 证据 = 她的消息
 *     → 她的猜测想变成"用户事实"
 *   · `self_experience`（subject CHARACTER）+ 证据 = 她的消息
 *     → 她临时编的经历想变成正史
 * 两条都必须被拒。"闸该不该拦"不再依赖模型。
 *
 * ---------------------------------------------------------------------------
 *  为什么不复用离线段的"规则抽取器 + 注入"
 * ---------------------------------------------------------------------------
 * 原来它写在 `if (!live)` 里面，并用 `testCase.suite === 'contamination'`
 * 判断要不要注入。于是：
 *   · live 档根本没有注入 → `minRejected` 这条判据在 live 档必然失败
 *     （这是加判据时暴露出来的：判据在两个档位下含义不同）
 *   · 注入的触发条件藏在 suite 标签里 → 与"怎么执行"耦合
 *
 * 现在它是一条**独立的执行路径**（`injection: 'contaminated_candidate'`），
 * 在 live / 离线两档下都跑，且与模型无关。
 */
async function runContaminationInjection(
  testCase: ExtractionEvalCase,
  views: readonly ReturnType<typeof processorEventViewOf>[],
  owner: EntityRef,
  speaker: EntityRef
): Promise<CaseOutcome> {
  const herEvent = testCase.events.find((e) => e.actor === 'character')
  if (herEvent === undefined) {
    /*
     * 用例声明要注入污染候选，却没有她的事件可当证据 ——
     * 这是**用例写错了**，必须响亮地失败。
     * 静默跳过的话，它会变成一个永远绿的"守护 Critical Test"的用例。
     */
    return {
      caseId: testCase.id,
      suite: testCase.suite,
      passed: false,
      failedChecks: [
        {
          id: 'contamination_injection_no_source',
          detail: '用例要注入污染候选，但没有任何 character 事件可用作证据来源',
        },
      ],
      candidateCount: 0,
      rejectedCount: 0,
      live: false,
    }
  }

  const resolved = resolveCandidates(
    [
      {
        memoryType: 'person_fact',
        subjectToken: 'USER',
        claim: { predicate: 'user.attribute.probe', value: 'from_her_output' },
        evidenceEventSequences: [herEvent.sequence],
      },
      {
        memoryType: 'self_experience',
        subjectToken: 'CHARACTER',
        episode: {
          summary: '（评测注入）她自己的经历',
          participantTokens: ['CHARACTER'],
        },
        evidenceEventSequences: [herEvent.sequence],
      },
    ],
    {
      owner,
      events: views,
      speaker,
      processor: 'eval-injection',
      processorVersion: 'eval-injection@1',
    }
  )

  const injected: MemoryExtractionResult = {
    candidates: resolved.flatMap((r) => (r.ok ? [r.candidate] : [])),
    rejected: resolved.flatMap((r) => (r.ok ? [] : [r.rejection])),
    extracted: resolved.some((r) => r.ok),
  }

  return evaluateCase(testCase, injected, { live: false, threshold: VALUE_GATE_THRESHOLD })
}

// ---------------------------------------------------------------------------
// 运行
// ---------------------------------------------------------------------------

/**
 * `--dump-raw`：把模型的**原始输出**打出来。
 *
 * 存在的理由：`memory_extractor_malformed_output` 只告诉我们"解析失败"，
 * 而"模型到底输出了什么"是修这个缺陷的**唯一**依据 ——
 * 猜它的形状（"大概是 markdown 代码块吧"）会把一个可测的问题
 * 变成一个凭印象的修改。实测就是靠它发现模型输出被 ``` 包住。
 */
const dumpRaw = argv.includes('--dump-raw')

const selected = EXTRACTION_EVAL_CASES.filter((c) => {
  if (onlySuite !== undefined && c.suite !== onlySuite) return false
  if (filters.length > 0 && !filters.some((f) => c.id.includes(f))) return false
  if (!live && c.requiresLiveModel) return false
  return true
})

/*
 * 若 `--filter` 一个用例都没匹配上，**必须报错**而不是"0 条全过"。
 *
 * 拼错一个 id（`M4X-05` 而不是 `M4X-005`）会得到"0 通过 / 0 失败"，
 * 退出码 0、摘要 `ok:true` —— 一次彻头彻尾的假绿。
 * 评测脚本对"没跑到东西"和"跑到了并且都过"必须给出不同结论。
 */
if (filters.length > 0 && selected.length === 0) {
  console.error(`❌ --filter ${filters.join(' ')} 没有匹配到任何用例（共 ${EXTRACTION_EVAL_CASES.length} 条）`)
  process.exit(2)
}
if (onlySuite !== undefined && selected.length === 0) {
  console.error(`❌ --suite ${onlySuite} 没有匹配到任何用例`)
  process.exit(2)
}

/*
 * ==========================================================================
 *  结构性门：禁止"什么都没判"的用例进入评测
 * ==========================================================================
 * 见 `casesWithNoBindingExpectation` 的说明 —— 这个门是被三处同形的
 * 假绿用例逼出来的（M4X-004 / M4X-005 / M4X-030/031）。
 *
 * 它在**跑任何用例之前**失败，因为一条空转用例的危害不是"少测了一点"，
 * 而是**报告上多了一个绿色的保证**。那种绿色会被后续所有人当成事实。
 */
const vacuous = casesWithNoBindingExpectation()
if (vacuous.length > 0) {
  console.error('❌ 以下用例的 expects 里没有任何**绑定**判据（空转用例）：')
  for (const c of vacuous) console.error(`   · ${c.id} ${c.description}`)
  console.error(
    '   空转用例比没有用例更糟：它在报告里给出一个绿色的保证，而那个保证是空的。\n' +
      '   至少要有一条：非空 mustInclude*/mustExclude*/authoritiesAllowed、' +
      'expectEmpty: true、maxCandidates、maxValueGateSurvivors、minRejected、' +
      'expectExplicitIntent 或 injection。'
  )
  process.exit(2)
}

/*
 * --------------------------------------------------------------------------
 *  配置门：只有注入型用例才允许用 `minRejected`
 * --------------------------------------------------------------------------
 * `minRejected` 断言的是"注入的候选被闸拦下了 N 条"。
 * 它唯一的含义来自**注入**：非注入型用例里"被拒条数"取决于模型/规则
 * 抽取器当天产出了什么，那是不可控的 —— 要么恒为 0（永远失败），
 * 要么碰巧非 0（偶然绿）。
 *
 * 这正是我自己踩过的坑：把 `minRejected: 2` 加在 live 档会跑的用例上，
 * 而注入只在离线档发生 → live 档必然失败。
 * 一个"只在某个档位下才有意义"的判据必须由结构来约束，
 * 不能靠记性。
 */
const misplacedRejection = EXTRACTION_EVAL_CASES.filter(
  (c) => c.expects.minRejected !== undefined && c.injection === undefined
)
if (misplacedRejection.length > 0) {
  console.error('❌ 以下用例用了 `minRejected` 但没声明 injection（会被判空）：')
  for (const c of misplacedRejection) console.error(`   · ${c.id} ${c.description}`)
  console.error('   `minRejected` 只在注入型用例里有意义：非注入用例的"被拒条数"取决于模型。')
  process.exit(2)
}

/*
 * --------------------------------------------------------------------------
 *  门的**自检**：证明这个门本身不是空转的
 * --------------------------------------------------------------------------
 * 一个"用来发现空转用例"的判据如果永远返回"有判据"，它就会让所有
 * 空转用例合法通过 —— 比没有这个门更糟，因为它还额外给出了一份
 * "已检查"的错觉。
 *
 * 所以拿几组合成的 `expects` 去验它，其中几组的**期望是错的**：
 * 如果判据退化成恒真/恒假，这里会立刻失败。
 *
 * 放在评测入口而不是某个测试文件里，是因为它守的东西**属于这个脚本**：
 * 谁改了这个判据，谁在下次跑评测时就会看到它坏掉。
 */
{
  const cases: { expects: ExtractionExpectations; want: boolean; why: string }[] = [
    {
      expects: { minCandidates: 1, requireEvidenceInBatch: true },
      want: false,
      why: 'M4X-005 修复前的真实形状：只有 minCandidates + 证据卫生要求',
    },
    { expects: { minCandidates: 0 }, want: false, why: '下限 0 对"该产出什么"零要求' },
    { expects: { requireEvidenceInBatch: true }, want: false, why: '证据卫生要求是通用项，候选为空时也空转' },
    { expects: { expectEmpty: false }, want: false, why: 'M4X-040 修复前的空转配置（false 等价于没写）' },
    { expects: {}, want: false, why: '空对象' },
    { expects: { expectEmpty: true }, want: true, why: '"0 条才对"是绑定判据' },
    { expects: { maxValueGateSurvivors: 0 }, want: true, why: '值闸幸存数是绑定判据' },
    {
      expects: { expectExplicitIntent: { sequence: 1, intent: 'remember' } },
      want: true,
      why: '意图判据是绑定判据',
    },
    { expects: { minRejected: 2 }, want: true, why: '被拒条数是绑定判据' },
    {
      expects: { maxCandidates: 1, mustExcludeTypes: [] },
      want: true,
      why: 'M4X-004 修复前的真实形状：判据存在，但选错了轴（数量轴 vs 持久化轴）',
      /*
       * ⚠️ 这一条的 `want` 是 **true**，而且它标出了这个门的**覆盖边界**。
       *
       * `maxCandidates: 1` 确实是一条绑定判据（出现 2 条就会失败），
       * 所以它**不算**空转 —— 门放它过，是对的。
       *
       * 但这意味着：**M4X-004 那类缺陷，这个门抓不到。**
       * 它的 expects 不是"没有判据"，而是"判据选错了轴"：
       * 用「候选数 ≤ 1」（数量轴）去声称「没被记住」（持久化轴）。
       * 两者都是合法判据，只有把 description 和 expects 放在一起读
       * 才能看出不匹配 —— 那需要人。
       *
       * 所以这个门的真实作用是：
       *   ✅ 抓 M4X-005 / M4X-030 / M4X-031 那一类（**完全没有**绑定判据）
       *   ❌ 抓不到 M4X-004 那一类（判据存在但与声称无关）
       *
       * 如实标出这个边界，而不是让门看起来比它实际能做的更多 ——
       * 那正是这些假绿用例本身的毛病。
       */
    },
  ]
  const broken = cases.filter((c) => hasBindingExpectation(c.expects) !== c.want)
  if (broken.length > 0) {
    console.error('❌ 空转判据的自检失败 —— 门本身已坏：')
    for (const b of broken) {
      console.error(
        `   · ${JSON.stringify(b.expects)} → 期望判定 ${b.want}，实际 ${!b.want}（${b.why}）`
      )
    }
    process.exit(2)
  }
}

log(`\n${'='.repeat(72)}`)
log(`M4 抽取行为评测（${live ? '真实模型档' : '离线档'}）`)
log(`${'='.repeat(72)}`)
log(
  `  用例：${selected.length} 条` +
    (live
      ? ''
      : `（跳过 ${EXTRACTION_EVAL_CASES.filter((c) => c.requiresLiveModel).length} 条需要真实模型的）`)
)
log('')

// 真实模型档的模型口
//
// ⚠️ 走 `/chat/completions` 而**不是** ElizaOS 的 `useModel`（与
// `eval-m3-live.ts` 同一条理由，它在那里已经踩过一次）：
//
//   评测设施不该依赖被测对象（Runtime）的装配。
//   若它依赖 Runtime，那"Runtime 挂了导致跑不了"会被误读成
//   "抽取器退化了" —— 而那是评测里最危险的一类缺陷：
//   数字看起来合理，但量的是错的东西。
//
// 实测确认了这一点的必要性：第一版用 `new AgentRuntime(...)` +
// `initialize()`，而 `initialize()` 要求 SQL 插件（"Database adapter not
// initialized"）—— 于是一个**只调模型**的评测被迫先建一个数据库。
// 直接 HTTP 调用把这条依赖整个去掉。
if (live && (process.env.OPENAI_API_KEY ?? '') === '') {
  log('⚠️  --live 需要 OPENAI_API_KEY。用例全部**跳过**（不假装跑了）。')
  emitSummary([], { live, skippedAll: true })
  process.exit(0)
}

const MODEL_ID = process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash'
const BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com'

async function invokeLiveModel(prompt: string): Promise<string> {
  const response = await fetch(`${BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}`,
    },
    body: JSON.stringify({
      model: MODEL_ID,
      messages: [{ role: 'user', content: prompt }],
      // 温度低：抽取要的是可重复的结构，不是创意
      temperature: 0.2,
      /*
       * ======================================================================
       *  ⚠️ **刻意不设 max_tokens**（用户 2026-09-16 明确要求取消预算限制）
       * ======================================================================
       * `deepseek-flash` 是**推理模型**：它的 `reasoning_content` 也计入
       * 输出预算。设一个上限会让评测量到的东西**不是抽取质量**，
       * 而是"我把预算设成了多少" ——
       *
       *   实测序列：预算 1200 → 5/12 用例因 `empty_output` 失败
       *             预算 4096 → 仍有 2/12 失败
       *
       * 也就是说那个失败**随预算漂移**，而它看起来像"抽取器有问题"。
       * 这与 M3 的评测教训同形：**数字随无关参数漂移，却读成了结论**。
       *
       * 不设上限 = 让模型自己决定要用多少推理 token。
       * 这样"空输出"才真的是"模型认为没什么可说/拒答"，
       * 而不是"预算不够"—— 两者是完全不同的世界状态。
       */
    }),
  })

  if (!response.ok) {
    throw new Error(`模型调用失败 ${response.status}：${(await response.text()).slice(0, 300)}`)
  }
  const payload = (await response.json()) as {
    choices?: {
      message?: { content?: string; reasoning_content?: string }
      finish_reason?: string
    }[]
    usage?: { completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } }
  }

  const choice = payload.choices?.[0]
  const content = choice?.message?.content ?? ''

  if (content.trim() === '') {
    /*
     * 空输出**无条件**打出成因（不是 debug 细节，而是失败诊断）。
     *
     * `finish_reason` 与推理 token 数是判断"预算不够"还是"模型拒答"
     * 的**唯一**依据。少了它，我们只会看到"抽取器抛错"，
     * 然后去改 prompt —— 而真实原因可能在别处。
     */
    log(
      `     ⚠️ 空 content：finish_reason=${choice?.finish_reason ?? '?'} ` +
        `completion_tokens=${payload.usage?.completion_tokens ?? '?'} ` +
        `reasoning_tokens=${payload.usage?.completion_tokens_details?.reasoning_tokens ?? '?'}` +
        ` reasoning_content=${(choice?.message?.reasoning_content ?? '').length} 字`
    )
  }

  return content
}

const owner: EntityRef = entityRef('character', String(EVAL_CHARACTER_ID))
const speaker: EntityRef = entityRef('user', 'user_alex')

const outcomes: CaseOutcome[] = []

for (const testCase of selected) {
  const events = materializeEvents(testCase)

  /*
   * ⚠️ `failure` 套件**先于** live/offline 分派处理。
   *
   * 第一版把它留在分派之后，于是 live 档里它走了**真实模型**那条路 ——
   * 而那条用例要测的是"解析器面对坏输出会不会去猜"，
   * 与模型本身无关。结果是它在 live 档里量的是"模型这次吐得对不对"，
   * 与它的声称不符（又一次"用例声称验证 X 但实际量的是 Y"）。
   */
  /*
   * ==========================================================================
   *  分派：**由 `injection` 字段决定走哪条执行路径**
   * ==========================================================================
   * 原来是 `testCase.suite === 'failure'`。那是把"怎么执行"编码在一个
   * 用于**报告分组**的语义标签里 —— 两者一旦耦合，加一条注入型用例
   * 就必须复用它所属 suite 的语义，或者去改分派代码（而那段代码
   * 同时管着报告分组）。
   *
   * 它同时必须先于 live/offline 分派：注入型用例测的是**解析器**
   * 面对坏输出会不会去猜，与模型本身无关。放错位置就会在 live 档里
   * 量成"模型这次吐得对不对"，与用例声称的不符。
   */
  if (testCase.injection === 'malformed_output') {
    const views = events.map((e) => processorEventViewOf(e))
    const outcome = await runMalformedOutputInjection(testCase, views, owner, speaker)
    outcomes.push(outcome)
    log(
      `  ${outcome.passed ? '✅' : '❌'} ${testCase.id} ${testCase.description}` +
        `  (注入坏输出 → ${outcome.rejectedCount === 1 ? '抛错 memory_extractor_malformed_output' : '未按预期抛错'})`
    )
    for (const f of outcome.failedChecks) log(`       [${f.id}] ${f.detail}`)
    continue
  }

  if (testCase.injection === 'contaminated_candidate') {
    const views = events.map((e) => processorEventViewOf(e))
    const outcome = await runContaminationInjection(testCase, views, owner, speaker)
    outcomes.push(outcome)
    log(
      `  ${outcome.passed ? '✅' : '❌'} ${testCase.id} ${testCase.description}` +
        `  (注入 2 条污染候选 → 被拒 ${outcome.rejectedCount} / 活下来 ${outcome.candidateCount})`
    )
    for (const f of outcome.failedChecks) log(`       [${f.id}] ${f.detail}`)
    continue
  }

  if (!live) {
    /*
     * ==========================================================================
     *  离线段：规则抽取器
     * ==========================================================================
     * 为什么不能"只跑规则抽取器"就当成测完了 —— 第一版就是这么写的，
     * 而结果是**多个用例都成了假的绿色**：
     *
     *   · M4X-022（她的输出抽不出东西）：
     *     规则抽取器天然只看用户事件，因此它"通过"了，
     *     但它**根本没有测** Source Firewall —— 测的是"规则抽取器不看她的消息"
     *   · M4X-040（坏 JSON 抛错）：
     *     规则抽取器不做 JSON 解析，因此它"通过"了，
     *     而那条用例声称验证的东西**一个字都没验**
     *
     * 一条声称验证 X 而实际验证不了 X 的用例，比没有那条用例更糟：
     * 它给出的是**假的绿色**（M3 的评测教训：最危险的不是失败，
     * 而是"数字看起来合理但量的是错的东西"）。
     *
     * 因此那两条**不再走这条分支**：它们由 `injection` 字段分派到
     * `runMalformedOutputInjection` / `runContaminationInjection`
     * （见循环开头）。那两条注入路径在 live / 离线两档下都跑，
     * 且都不依赖模型 —— 一个 Critical Test 的绿不能取决于模型当天的心情。
     *
     * 留在这一段的，是**真的要用规则抽取器**的用例。
     */
    const views = events.map((e) => processorEventViewOf(e))

    const ruleResult = await new RuleBasedMemoryExtractor().process({
      views,
      owner,
      speaker,
    })

    const outcome = evaluateCase(testCase, ruleResult, { live: false, threshold: VALUE_GATE_THRESHOLD })
    outcome.failedChecks.push(...(await checkExplicitIntent(testCase, events)))
    outcome.passed = outcome.failedChecks.length === 0
    outcomes.push(outcome)
    log(
      `  ${outcome.passed ? '✅' : '❌'} ${testCase.id} ${testCase.description}` +
        `  (候选 ${outcome.candidateCount} / 被拒 ${outcome.rejectedCount})` +
        (outcome.vacuous === true ? '  ⚠️ 空过：判据一条都没跑' : '')
    )
    /*
     * ⚠️ 失败详情必须**随该条用例**打印，不能像原来那样只打最后一条。
     *
     * 原实现是循环外 `const last = outcomes[outcomes.length - 1]` ——
     * 于是离线档里只要**最后**一条用例是通过的，前面所有失败用例的
     * 原因就一个字都不打。你看到一排 ❌ 却没有理由，只能重跑加 --filter
     * 去猜是哪一条、为什么失败。
     *
     * 输出把失败原因藏起来，和把失败判成通过是同一类问题：
     * 都让报告读起来比事实更乐观。
     */
    for (const f of outcome.failedChecks) log(`       [${f.id}] ${f.detail}`)
  } else {
    const extractor = new LlmMemoryExtractor()
    let result: MemoryExtractionResult
    try {
      result = await extractor.process(
        { views: events.map((e) => processorEventViewOf(e)), owner, speaker },
        {
          processorName: 'memory-extractor',
          processorVersion: 'memory-extractor@1',
          invokeModel: async (prompt) => {
            const raw = await invokeLiveModel(prompt)
            if (dumpRaw) {
              log(`\n  ── 模型原始输出（${testCase.id}）────────────────────────`)
              log(raw.slice(0, 1500))
              log(`  ────────────────────────────────────────────────\n`)
            }
            return raw
          },
        }
      )
    } catch (error) {
      // 抽取器抛错（例如坏 JSON）→ 那是**用例级的失败**，不是"0 条候选"
      const outcome: CaseOutcome = {
        caseId: testCase.id,
        suite: testCase.suite,
        passed: false,
        failedChecks: [
          {
            id: 'extractor_threw',
            detail: `${(error as { code?: string }).code ?? 'error'}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
        candidateCount: 0,
        rejectedCount: 0,
        live: true,
      }
      outcomes.push(outcome)
      log(`  ❌ ${testCase.id} ${testCase.description}  (抽取器抛错)`)
      continue
    }

    const outcome = evaluateCase(testCase, result, { live: true, threshold: VALUE_GATE_THRESHOLD })
    outcome.failedChecks.push(...(await checkExplicitIntent(testCase, events)))
    outcome.passed = outcome.failedChecks.length === 0
    outcomes.push(outcome)
    log(
      `  ${outcome.passed ? '✅' : '❌'} ${testCase.id} ${testCase.description}` +
        `  (候选 ${outcome.candidateCount} / 被拒 ${outcome.rejectedCount})` +
        (outcome.vacuous === true ? '  ⚠️ 空过：判据一条都没跑' : '')
    )
    for (const f of outcome.failedChecks) log(`       [${f.id}] ${f.detail}`)
  }
}

emitSummary(outcomes, { live, skippedAll: false })

/*
 * 失败时**非零退出**。
 *
 * ⚠️ 原来无论用例红成什么样都退 0 —— 于是把它挂进任何 `&&` 串起来的
 * CI 里，它永远不会拦住任何东西，而报告上却是一排 ❌。
 * 一个"报了失败但退出码是 0"的脚本，在自动化里等于没有判据。
 *
 * 退出码语义：
 *   0 = 全部通过
 *   1 = 有用例失败
 *   2 = 配置错误（`--filter` 没匹配到、用例表里有空转用例、门自检失败）
 *       —— 2 在别处已经 exit，这里不会走到
 */
process.exit(outcomes.every((o) => o.passed) ? 0 : 1)

// ---------------------------------------------------------------------------
// 摘要输出（单行 JSON，供 Promptfoo 解析）
// ---------------------------------------------------------------------------

function emitSummary(all: readonly CaseOutcome[], options: { live: boolean; skippedAll: boolean }): void {
  const passed = all.filter((o) => o.passed).length
  const failed = all.filter((o) => !o.passed)
  const vacuous = all.filter((o) => o.vacuous === true)
  const summary = {
    live: options.live,
    skippedAll: options.skippedAll,
    caseCount: all.length,
    passed,
    failed: failed.length,
    ok: failed.length === 0,
    /*
     * 空过的绿**单独计数**，不混进 `passed` 的语义里。
     *
     * `passed: 10, vacuous: 2` 与 `passed: 10, vacuous: 0` 是**两件不同的事**，
     * 而只报 `passed: 10` 会让它们长得完全一样。
     */
    vacuous: vacuous.length,
    vacuousCases: vacuous.map((o) => o.caseId),
    cases: all.map((o) => ({
      caseId: o.caseId,
      suite: o.suite,
      passed: o.passed,
      candidateCount: o.candidateCount,
      rejectedCount: o.rejectedCount,
      failedChecks: o.failedChecks,
      ...(o.vacuous === true ? { vacuous: true } : {}),
    })),
  }

  // 单行 JSON 到 stdout；其余日志走 console.log（--quiet 时被压掉）
  process.stdout.write(JSON.stringify(summary) + '\n')

  log('')
  log('='.repeat(72))
  log(`M4 抽取行为评测：${passed} 通过 / ${failed.length} 失败（${all.length} 条）`)
  if (vacuous.length > 0) {
    log('')
    log(
      `⚠️ 其中 ${vacuous.length} 条是**空过**（绿，但不构成证据）：` +
        '本次输出下它们的判据不可能失败。'
    )
    for (const v of vacuous) log(`  - ${v.caseId}（候选 0 / 被拒 0，判据一条都没跑）`)
    log('   这不是失败。但它**不能**读成"这条用例声称守护的东西已验证"。')
  }
  if (failed.length > 0) {
    log('')
    log('失败用例：')
    for (const f of failed) log(`  - ${f.caseId} → ${f.failedChecks.map((c) => c.id).join(', ')}`)
  }
  log('='.repeat(72))
}
