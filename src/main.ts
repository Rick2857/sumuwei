/**
 * L1-M1 入口：把 ElizaOS Runtime 跑起来，接上 DeepSeek-V4-Flash，做多轮对话。
 *
 * 本文件负责「运行」这一层，且刻意保持薄：
 *   运行时装配 → 数据库 → 房间/参与者 → 每轮 Context 组装 → 调模型 → 存消息
 * 角色定义在 src/character/，上下文组装在 src/context/builder.ts。
 */
import 'dotenv/config'
import { checkImageInputs, ImageInputStore } from './infrastructure/media/image-input.ts'
import type { ImageInput } from './kernel/contracts/image-input.ts'

import { writeFileSync } from 'node:fs'
import { ARXIV_RESEARCH, ARXIV_PERMISSION, WORKFLOW_SKILL, WORKFLOW_SKILL_PERMISSION, PERSONAL_LIBRARY_SEARCH, PERSONAL_LIBRARY_PERMISSION, createLearningCapabilityDefinitions, type WorkflowSkillDefinition } from './kernel/action/learning-capabilities.ts'
import { createWorkflowSkillAdapter, loadWorkflowSkills } from './infrastructure/action/adapters/workflow-skill.ts'
import { createPersonalLibraryAdapter, PERSONAL_LIBRARY_ROOT } from './infrastructure/action/adapters/personal-library.ts'
import { createArxivAdapter, verifyArxivRuntimeSync } from './infrastructure/action/adapters/arxiv.ts'
import { createServer, type Server, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

import {
  AgentRuntime,
  ChannelType,
  EventType,
  ModelType,
  logger,
  stringToUuid,
  type Memory,
  type Plugin,
  type UUID,
} from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import openaiPlugin from '@elizaos/plugin-openai'
import bootstrapPlugin from '@elizaos/plugin-bootstrap'

import { character } from './character/index.ts'
import { buildTurnContext } from './context/builder.ts'
import { allowKernelMigration, allowProductionDatabase, initDatabase, type DbReady } from './db/index.ts'
import { isProductionDir } from './dev/sandbox.ts'
/*
 * INC-01 WP3（`AT3.1`/`AT3.2`）：**唯一的收尾路径**。
 *
 * 这个模块把 `stop → close → closed check` 收在一处，并且**幂等**：
 * 因此 main 的每个分支、信号处理与最外层 `finally` 都调它，
 * 而实际只会发生**一次** stop 与**一次** close。
 */
import {
  closeDatabaseConnection,
  createRuntimeShutdown,
  beforeDatabaseClose,
  isDatabaseClosed,
  shutdownExitCode,
  stopRuntimeServices,
  type ShutdownHandle,
} from './infrastructure/persistence/runtime-shutdown.ts'
/*
 * WP3 / ADR-132 `D05`：**单认知执行者资格**。
 *
 * 计划 §3.2 逐字："同角色首期只有一个认知执行者。PG advisory lock 可用于拒绝第二核心；
 * 读取/备份不争抢该写入资格。" 本模块是那条资格的唯一实现。
 *
 * ⚠️ 它是**纯追加**：`CHARACTER_DB_BACKEND` 未设（= PGlite）时
 *    `dedicatedPoolOf()` 返回 undefined（嵌入式客户端没有 `connect`）
 *    ⇒ 根本不尝试取得资格 ⇒ 既有行为逐字不变。
 */
import {
  acquireSingleCoreQualification,
  dedicatedPoolOf,
  singleCoreDenialMessage,
  type SingleCoreQualification,
} from './infrastructure/persistence/single-core-qualification.ts'
/*
 * INC-01 WP4（`AT4.1`–`AT4.5`）：**生产打开的唯一状态机**。
 *
 * `pnpm chat`（真实库）现在必须先拿租约、再做 pre-open verified snapshot，
 * 拿到 token 之后才允许真的打开；关闭之后做 post-close snapshot 并释放租约。
 * 这些函数只在本文件（唯一被允许打开真实库的入口）里被调用。
 */
import {
  lastVerifiedSnapshotId,
  prepareProductionOpen,
  productionDataDirOf,
  productionSnapshotRootOf,
  type ProductionOpenHandle,
} from './infrastructure/persistence/production-open-guard.ts'
import { createPersistentCharacterPlugin } from './plugin/persistent-character.ts'
import { openAiCompatiblePlugin } from './providers/openai-compatible.ts'
import { resolveCurrentState } from './state/provider.ts'
import { initCharacterState } from './state/init.ts'
/*
 * WP9-B2：状态引导组件**自己的受信身份**。
 *
 * ⚠️ 本模块是它**唯一**的生产调用点（装配根）。`initCharacterState` 本身
 * **不构成鉴证** —— 它只是这条受信链的消费者（见 `src/state/init.ts` 顶部注释）。
 */
import { attestStateBootstrapComponentIdentity } from './state/bootstrap-attestation.ts'
import { renderInspector } from './state/inspector.ts'
import { markInteraction, clearRoomMessages, resetState } from './state/repository.ts'
import { type KernelHandle, initKernel } from './kernel/app/kernel.ts'
import { TurnGateway, type TelemetryMirror } from './kernel/app/turn-gateway.ts'
import { SEARCH_JUDGE_TIMEOUT_MAX_MS, SEARCH_JUDGE_TIMEOUT_MIN_MS, describeKernelFlags, readKernelFlags } from './kernel/app/flags.ts'
import {
  createTelemetry,
  readTelemetryConfig,
} from './infrastructure/telemetry/index.ts'
import { TelemetryRecorder } from './infrastructure/telemetry/recorder.ts'
import { ConversationRecorder } from './infrastructure/runtime/conversation-recorder.ts'
/*
 * WP6.1（K-28）：对话 ingress 的**受信归因装配**。
 *
 * ⚠️ 入口模式由 `conversationEntryModeOf(argv)` 从**真实进程事实**推导
 * （有位置参数 = 程序化一次性入口）；角色由本模块的三个具名工厂决定。
 * 外部载荷**没有**任何字段能选它们。
 */
import {
  conversationAttributionForEntryMode,
  conversationEntryModeOf,
  type ConversationEntryMode,
} from './infrastructure/runtime/conversation-attribution.ts'
/*
 * post-Lv2 / ADR-109 `D02`：**入口作用域**（会话 id 的入口分量）。
 *
 * ⚠️ 入口键只能由装配层从**程序事实**产生（argv / 监听端口 / 认证结果）；
 *    它**不是**请求载荷里的字段 —— 那正是 `D02` 要挡的形状。
 */
import {
  CHAT_ENTRY_SCOPES,
  chatEntryKeyOfMode,
  conversationIdForEntry,
  type ChatEntryKey,
} from './infrastructure/runtime/entry-scope.ts'
/** post-Lv2 / ADR-109 `D06`：双入口的**有界轮转公平**调度（一次一轮） */
import { FairTurnScheduler } from './kernel/app/bridge/turn-scheduler.ts'
import {
  buildLegacyDumpContext,
  buildWhitelistedContext,
  callModelText,
  compileLegacyContext,
  recentContextLinesFrom,
  renderAffectReadback,
  renderAffectSection,
  renderBeliefReadback,
  buildBeliefContextSection,
  renderCriticalStateSection,
  renderRelationshipReadback,
  renderRelationshipSection,
  seedRelationshipOrigin,
} from './infrastructure/runtime/adapters.ts'
/*
 * M11 / WP8：行为策略槽的**只读**读面（装配层只取状态，额度与渲染都归网关）
 */
/*
 * M11 / WP12：慢路径的**生产接线**（调度 + 执行器 + 两个只读端口 + 模型端口）
 *
 * ⚠️ 这一块补的是 L-M11-20：WP7 的调度在 main.ts 里**从来没有**被调用过。
 */
import { runConfiguredReflectionTail } from './infrastructure/runtime/reflection-runtime.ts'
/* M10.1 / ADR-086 `D02`：约定识别的慢路径（`L-M10.1-11`：这条链此前**没有**运行时消费者） */
import { runConfiguredAgreementTail } from './infrastructure/runtime/agreement-runtime.ts'
import { createGoalReflectionQueue } from './infrastructure/runtime/goal-reflection-queue.ts'
import { createOpenAiAgreementDraftProvider } from './infrastructure/model/openai-agreement-understanding.ts'
import { readCurrentReflectionFactPack, readUsableAdaptiveSelfStates } from './infrastructure/runtime/reflection-current-state.ts'
import { createLateWriteFence } from './kernel/app/reflection/late-write-fence.ts'
import { createOpenAiReflectionDraftProvider } from './infrastructure/model/openai-reflection.ts'
import {
  maybeRunRelationshipEvaluation,
  relationshipOwnerOf,
  type RelationshipSchedulerOutcome,
} from './infrastructure/runtime/relationship-scheduler.ts'
/* S8 / ADR-094 `R-2` 选项 A：生产内容包来自 `src/content/**`（**不**从 `evals/**` 取） */
import { JICHUANG_PACK } from './content/storyline/jichuang-interview-two/story-pack.ts'
import { createStoryCognition } from './infrastructure/runtime/story-cognition.ts'
import { runStoryWithdrawCommand } from './infrastructure/runtime/story-withdraw-command.ts'
import { runStoryStartCommand } from './infrastructure/runtime/story-start-command.ts'
/* S8 / `ADR-107` `R-1b`：私有决策调用的**适配器**（它不是故事边界依赖：路径不含 `storyline/`） */
import { createOpenAiStoryChoicePort } from './infrastructure/model/openai-story-choice.ts'
import {
  affectTurnObservationOf,
  maybeRunAffectEvaluation,
  type AffectSchedulerOutcome,
} from './infrastructure/runtime/affect-scheduler.ts'
import {
  describeBeliefMemoryScheduling,
  describeBeliefScheduling,
  maybeRunBeliefEvaluation,
  maybeRunBeliefMemoryReconciliation,
} from './infrastructure/runtime/belief-scheduler.ts'
import {
  affectSemanticActivationReady,
  affectSemanticTraceStepsOf,
  cancelPendingAffectSemanticSources,
  describeAffectSemanticSweep,
  describeAffectSemanticTick,
  maybeRunAffectSemanticEvaluation,
} from './infrastructure/runtime/affect-semantic-scheduler.ts'
import { getAffectProjection } from './infrastructure/persistence/affect-store.ts'
import { createOpenAiAffectSemanticProvider } from './infrastructure/model/affect-semantic-provider.ts'
import { renderLedgerHistory } from './infrastructure/runtime/history-view.ts'
import {
  countBySourceKind,
  countConversationEvents,
  latestConversationSequence,
  recentConversationEvents,
} from './infrastructure/persistence/conversation-store.ts'
import { resetKernelData } from './infrastructure/persistence/event-store.ts'
import { applyBackfill, planBackfill } from './infrastructure/persistence/backfill.ts'
/*
 * ============================================================================
 *  M10 / `G-2`：目标域接线的四块料
 * ============================================================================
 * ```text
 * ① 四个端口：候选 / 写 / 放行口 / **兑现判定**（最后一块是本里程碑才补的生产实现）
 * ② 理解层：真模型 provider + **真期限运行时**（`withDeadline` 清定时器 + `unref`）
 * ③ 编排入口：`runGoalTurn`（`app/goal/turn.ts` 的**唯一**实现）
 * ④ 上下文：`orderGoalsForFocus`（排序是 WP5 的职责，网关**不重排**）
 * ```
 */
import {
  commitmentSummariesOf,
  candidatesFromGoals,
  prepareGoalTurn,
  type GoalTurnPorts,
} from './kernel/app/goal/turn.ts'
import { commitmentFactRowsOf } from './kernel/app/goal/commitment-facts.ts'
import type { CompileTurnInput, GoalTurnPortResult } from './kernel/app/turn-gateway.ts'
import { orderGoalsForFocus } from './kernel/app/goal/invalidation.ts'
import { validateGoalProposal, type GoalProposal } from './kernel/policies/goal-validator.ts'
import {
  applyGoalRows,
  createGoalStateLookup,
  listGoalStates,
} from './infrastructure/persistence/goal-store.ts'
import { createProcessedOperationStore } from './infrastructure/persistence/job-store.ts'
import { createProductionGoalCompletionPorts } from './infrastructure/goal/completion-ports.ts'
import { createRealGoalUnderstandingRuntime } from './infrastructure/goal/understanding-runtime.ts'
import { createOpenAiGoalUnderstandingProvider } from './infrastructure/model/openai-goal-understanding.ts'
import { sourceQualificationOf } from './kernel/contracts/attribution.ts'
import { GOAL_DOMAIN_EVENT_TYPES } from './kernel/contracts/domain-event.ts'
import { originReadingOfEvent } from './infrastructure/persistence/qualification-read.ts'
import {
  countDomainEvents,
  domainEventsFor,
  listProjections,
  projectionRevisions,
} from './infrastructure/persistence/event-store.ts'
import {
  asActionId,
  asConversationId,
  asTraceId,
  createFullDomainEventRegistry,
  entityRef,
  isClaimContent,
  isRegisteredPredicate,
  newActionId,
  newRuntimeId,
  newTraceId,
  seedSourceRef,
  type RuntimeId,
} from './kernel/contracts/index.ts'
import { hashSeed, shortHash } from './infrastructure/persistence/seed-hash.ts'
import { characterDefinitionFromCharacter } from './infrastructure/runtime/seed-projection.ts'
import { withGuardTimersUnrefed } from './infrastructure/runtime/guard-timers.ts'
import { requiresModelConnectivity } from './invocation.ts'
import {
  contaminatedMemories,
  countByProcessorVersion,
  createNativeMemoryStore,
  domainEventsForMemory,
  listRecentExplicitWrites,
  memoryCounts,
  unsupportedMemories,
} from './infrastructure/persistence/memory-store.ts'
import { recoverMemoryProjections } from './infrastructure/persistence/memory-recovery.ts'
// M9.1 / ADR-072 D16：撤销证据读端口（F-1 遮蔽的数据面；只读）
import { computeWithdrawnEvidence } from './infrastructure/persistence/withdrawn-evidence.ts'
// M5-PRE：状态完整性探针（与 memory-store 的**行数**探针分开 —— 见 memory-integrity.ts 的文件头）
import { memoryIntegrityProblems } from './infrastructure/persistence/memory-integrity.ts'
import { createProductionMaintenanceTrigger } from './infrastructure/persistence/semantic-index-production-runner.ts'
import { readSemanticIndexHealth } from './infrastructure/persistence/semantic-index-health.ts'
import { ensureSemanticIndexSchema } from './infrastructure/persistence/memory-semantic-index.ts'
// M5 WP3/WP5/WP6：检索适配器 + 召回服务 + 轮次端口 + 上下文预算
import { createMemoryRetrievalStore } from './infrastructure/persistence/memory-retrieval-store.ts'
import { rootReadingsByMemory } from './infrastructure/persistence/qualification-read.ts'
import type { RawDb } from './infrastructure/persistence/db.ts'
import { createRollupSourceReader } from './infrastructure/persistence/rollup-source-store.ts'
/*
 * M9.5 / WP6：语义召回的生产装配（**只在 `CHARACTER_MEMORY_SEMANTIC_ENABLED=true` 时被调用**）。
 * 三个 import 都是纯构造：读清单、构造子进程客户端（惰性）、组装探针 —— 都不打开数据库。
 */
import {
  DEFAULT_EMBEDDING_MANIFEST_PATH,
  loadEmbeddingManifest,
  validateEmbeddingManifest,
  verifyEmbeddingAssets,
} from './infrastructure/semantic/embedding-manifest.ts'
import { createEncoderClient, type EncoderClient } from './infrastructure/semantic/encoder-client.ts'
import { createSemanticProbe } from './infrastructure/semantic/semantic-probe.ts'
import type { MemorySemanticProbe } from './kernel/recall/ports.ts'
import { createMemoryRecallService } from './kernel/app/recall/retrieval.ts'
import { createRecallTurnPort, type RecallTurnPort } from './kernel/app/recall/turn.ts'
import { createRollupTurnPort, type RollupTurnPort } from './kernel/app/rollup/turn.ts'
import { DEFAULT_CONTEXT_BUDGET } from './kernel/recall/selector.ts'
import {
  memoryAdminUsage,
  parseMemoryAdminArgs,
  renderMemoryAudit,
  renderMemoryDetail,
  renderMemoryList,
  renderMemorySources,
  renderMemoryStats,
  renderMemoryTimeline,
  type MemoryRetractReason,
} from './kernel/app/memory/admin.ts'
import {
  createExplicitMemoryTurnPort,
  type ExplicitMemoryTurnPort,
} from './kernel/app/memory/explicit-turn.ts'
import { createExplicitMemoryService } from './kernel/app/memory/explicit-service.ts'
import { createExplicitMemoryIntentDetector, LlmMemoryIntentClassifier } from './kernel/app/memory/intent-detector.ts'
/*
 * 后 Lv2 · WP1：五道回复守卫的**唯一实现**。
 * ⚠️ 这里**不再**逐个 import 那五道守卫：链只有一份，
 *    逐个 import 会让"再抄一遍"重新变得容易（R3 的 host 就是这么漏掉全部五道的）。
 */
import { runReplyGuardChain } from './kernel/app/reply-guard-chain.ts'
import { toLookupReading, TurnBridge } from './kernel/app/bridge/turn-bridge.ts'
import { bindSpeechExpression, decodeExpressiveSpeech, withoutAppendices, type SpeechExpression } from './kernel/contracts/expressive-speech.ts'
import { runBridgeTransport, sessionHost, TurnCancellationRegistry } from './infrastructure/bridge/turn-bridge-transport.ts'
import { readQqPrivateConfig } from './infrastructure/qq/private-config.ts'
/* post-Lv2 / ADR-110 `D07`/`D08`：主动投递登记表 + 它的两个持久层端口 */
import { QqDeliveryRegistry } from './kernel/app/notification-delivery.ts'
import { advanceOccurrence, getOccurrence } from './infrastructure/persistence/notification-store.ts'
import {
  getIntent,
  countQuotaUsage,
  deferOccurrence,
  hasInFlightOccurrence,
  lastAcceptedAt,
  lastInboundAt,
  readControl,
  listPendingIntents,
  pendingCareDeferrals,
  reserveOccurrence,
} from './infrastructure/persistence/notification-store.ts'
import { precheckCareOpportunity } from './kernel/contracts/notification-intake.ts'
import { zonedDayWindow, MAX_NOTIFICATION_TEXT_CODEPOINTS } from './kernel/contracts/notification.ts'
/* post-Lv2 / ADR-111：一次自主关心的**依据面**与**执行** */
import {
  boundProactiveSources,
  renderSystemOpportunitySection,
} from './kernel/contracts/proactive-proposal.ts'
import { runCareOpportunity } from './kernel/app/proactive-care.ts'
import { buildProactiveSourceCandidates } from './infrastructure/runtime/proactive-sources.ts'
import { createOpenAiProactiveCarePort } from './infrastructure/model/openai-proactive-care.ts'
import { createOpenAiReminderResolver } from './infrastructure/model/openai-reminder-text.ts'
import { runReminderTurn, reminderCandidate, type ReminderSource } from './kernel/app/reminder-turn.ts'
import type { ChatChannel } from './kernel/contracts/chat-channel.ts'
import { createLocalReminderCapabilities, LOCAL_REMINDER_SEND, LOCAL_REMINDER_PERMISSION } from './kernel/action/local-reminder-capability.ts'
import { createLocalReminderDeliveryAdapter } from './infrastructure/action/adapters/local-reminder-delivery.ts'
import { bindLocalReminderConnection, createReminderScheduling, reportReminderForChannel } from './infrastructure/runtime/reminder-scheduling.ts'
import { reminderDedupeKey } from './kernel/contracts/notification-intake.ts'
import { createIntent, updateReminderText } from './infrastructure/persistence/notification-store.ts'
import { randomUUID } from 'node:crypto'
import type { NotificationIntentId } from './kernel/contracts/index.ts'
/** 提醒解析的私有调用端口（一次调用就是一次调用；失败 ⇒ 不建意图） */
const resolveReminder = createOpenAiReminderResolver({ env: process.env })
import { asNotificationIntentId } from './kernel/contracts/ids.ts'
/* post-Lv2 / ADR-110 `D04`：到点提醒的调度器 + 它要的 Croner 定时器 */
import { ProactiveScheduler } from './kernel/app/proactive-scheduler.ts'
import { createCronerTimer } from './infrastructure/time/croner-timer.ts'
import { readProactivePolicy } from './kernel/app/flags.ts'
/*
 * Lv4.5 / ADR-131：皮套入口的**系统发起开口**（机会预检 / 机会状态 / 编排 / 私有调用）。
 * ⚠️ 四件东西各自一层：预检在 contracts（纯）、状态与编排在 app/bridge、
 *    真正调模型在 infrastructure —— 装配根只负责**喂真读数**与**接出站**。
 */
import { precheckOpeningOpportunity } from './kernel/contracts/proactive-opening.ts'
import {
  createInMemoryOpeningState,
  openingPrecheckInputs,
  type OpeningStatePort,
} from './kernel/app/bridge/proactive-opening-state.ts'
import { runOpeningOpportunity } from './kernel/app/bridge/proactive-opening.ts'
import { createOpenAiProactiveOpeningPort } from './infrastructure/model/openai-proactive-opening.ts'
/* ⚠️ `ChatSession.characterId` 是 `string`，而那几个读数要 `CharacterId` ⇒ 在边界上转一次 */
import { asCharacterId } from './kernel/contracts/ids.ts'
import { createQqProactiveDeliveryAdapter } from './infrastructure/action/adapters/qq-proactive-delivery.ts'
import { VoiceDeliveryLedger, applyVoiceDeliveryView } from './kernel/app/bridge/voice-delivery-ledger.ts'
/*
 * M4.5：动作链路（ADR-030 ~ 035）。
 *
 * 装配层是唯一允许同时认识 kernel 与 infrastructure 的地方 ——
 * 因此"沙箱根在哪""装哪些适配器""授予哪些权限"三个决定都写在这里，
 * 而 `src/kernel/action/**` 一个字都不知道它们。
 */
import { createActionGateway, type ActionGateway } from './kernel/action/gateway.ts'
import { createActionIntentDetector, type ActionIntent } from './kernel/action/intent-detector.ts'
import {
  createActionTurnPort,
  type ActionTurnPort,
  type ActionTurnPortOptions,
  type ResolvedActionIntent,
} from './kernel/action/action-turn.ts'
import {
  DEFAULT_GRANTED_PERMISSIONS,
  SANDBOX_FILE_READ,
  SANDBOX_FILE_WRITE,
  SYSTEM_ECHO,
  createDefaultCapabilityDefinitions,
  createCapabilityRegistry,
  type CapabilityRegistry,
} from './kernel/action/capability-registry.ts'
import { resolveActionTarget } from './kernel/action/target-resolver.ts'
import { isDiskWideCapability } from './kernel/action/disk-wide-scope.ts'
import { hasSideEffect } from './kernel/action/action-request.ts'
/* Lv4.5 / `P3`（选项 B）：提前检索要**构造同一个形状**的动作请求（走同一个网关） */
import { createActionRequest } from './kernel/action/action-request.ts'
/*
 * ⚠️ `KernelError` 直接取自契约层：提前检索的失败**必须**报出 `code`
 *    （策略拒 / 目标解析不了 / 校验不过），不能只报一个 `"KernelError"` ——
 *    那等于把真因丢掉，实测为此多花了一轮才定位。
 */
import { KernelError, makeConversationEventId } from './kernel/contracts/ids.ts'
import { ChatStreamError } from './providers/chat-stream.ts'
import { nativeVoiceReplyPortFor } from './infrastructure/model/native-voice-reply.ts'
import { CheckedSpeechStream, type CheckedSpeechSegment } from './kernel/app/bridge/streaming-speech.ts'
/* ADR-098：提前检索的**具名**归因豁免（唯一的调用点是 `prepareLookup`） */
import { attestActionInitiatorFromNamedExemption } from './kernel/contracts/attribution.ts'
/* post-Lv2 / ADR-110 `D05`/`D05a`：主动投递的发起人身份 + "成功口吻"的唯一判据 */
import { PROACTIVE_SCHEDULER_PRINCIPAL_ID } from './kernel/contracts/notification.ts'
/**
 * 关心机会的**许可版本**：它是一个**程序常量**（没有"本人授权"这回事 ——
 * 关心不是本人要求过的事）。`D03` 的权限差体现在别处（她能沉默、能改期）。
 */
const PROACTIVE_CARE_PERMISSION_VERSION = 'care-permission@1'
/**
 * 关心的**私有调用端口**（ADR-110 `D04`：一次调用就是一次调用）。
 *
 * ⚠️ **惰性构造**：没有凭证时它每次 `evaluate` 都如实返回 `call_failed`
 *    （而不是在这里抛）—— "没有 key"与"她决定不说话"在读数上必须分开。
 */
const careEvaluationPort: ReturnType<typeof createOpenAiProactiveCarePort> | undefined =
  createOpenAiProactiveCarePort({ env: process.env })
/**
 * 提醒入口建完意图后用来**通知调度器重排**的钩子（2026-10-07 修的真缺陷）。
 *
 * ⚠️ 为什么不是直接调 `proactiveScheduler.refresh()`：那个变量是**函数内**的 `let`
 *    （装配在某次启动流程里），`ChatSession` 看不见它 ⇒ 只能由一个**模块级钩子**转接。
 * ⚠️ 没装钩子（主动功能没开 / 装配闸没过）⇒ `?.` 静默跳过，
 *    与"意图仍落库、等下次启动列出"的语义一致。
 */
let reminderRefreshHook: (() => Promise<void>) | undefined
let reminderRuntimeChannels: readonly ChatChannel[] = []
const localReminderChannels = new Map<ChatChannel, QqDeliveryRegistry>()

function reminderDeliveryChannel(db: RawDb, channel: ChatChannel): QqDeliveryRegistry {
  if (channel === 'qq_private') return proactiveDeliveryChannel(db)
  let registry = localReminderChannels.get(channel)
  if (!registry) {
    registry = new QqDeliveryRegistry({ store: {
      readOccurrenceState: async key => (await getOccurrence(db, key))?.state,
      advanceOccurrence: async request => await advanceOccurrence(db, request.occurrenceKey, request),
    }, onReading: reading => logger.info(`[reminder-delivery:${channel}] ${JSON.stringify(reading)}`) })
    localReminderChannels.set(channel, registry)
  }
  return registry
}

/* ★ R-a：启动判据抽成冻结的纯函数 ⇒ 门（不 import 本文件）也能三段式量到它 */
import { decideReminderStart } from './infrastructure/runtime/reminder-scheduler-guard.ts'
/* ★ A2：本轮"用户是否在要求记住"的判据（纯函数，供回复守卫链用） */
import { asksToRemember } from './kernel/app/memory/remember-request.ts'
/* ★ S4 ②（ADR-129 D08）：跨重启补说 —— 判据与措辞都是冻结纯函数 */
import { renderCatchupAnnouncement, takeCatchupBatch } from './kernel/app/reminder/catchup-continuation.ts'
import { finishIntent, listMissedIntents } from './infrastructure/persistence/notification-store.ts'

async function startStandaloneReminders(input: {
  kernel: KernelHandle; session: ChatSession; flags: ReturnType<typeof readKernelFlags>
  /*
   * ★ 2026-10-10 / R6「提醒能力入口无关」：union 里补上 `qq_private`。
   *
   * ⚠️ **为什么不止是加一档**：下面的 `bindLocalReminderConnection` 是**本地通道专用**
   *    （cli / avatar 的投递**报告**）。QQ 私聊**没有**这一层 —— 它的回执由外壳按
   *    **连接代次**回报（`REPORT_QQ_DELIVERY` → `host.reportQqDelivery` →
   *    `reportReminderForChannel(db, 'qq_private', registry, …)`，见 main.ts:5847-5858 的 coexist 装配），
   *    而且登记表的出站口**必须在 `openConnection` 那一步绑**，不是事后 `setOutputSink`。
   *    照搬本地连接会得到一个"本地连接 + QQ 通道"的混合体 —— 报告路径是错的，
   *    而它**看起来接上了**（本仓库在 ADR-110 §25 已经踩过同型一次）。
   * ⇒ 所以 `qq_private` 这一支**不建**本地连接、**不返回** `report`。
   */
  channel: 'cli' | 'avatar' | 'qq_private'
  write: (out: { deliveryId: string; text: string }) => { written: boolean; code?: string }
}) {
  if (input.flags.qqProactiveMode !== 'on' || !input.flags.entryScopedConversations) return undefined
  /*
   * ========================================================================
   *  ★ R-a（2026-10-10）：**同一进程只允许一个提醒调度器**
   * ========================================================================
   *  为什么要有这道闸：两个 timer 会抢**同一个实例键**（`occurrenceKey`）⇒
   *  重复投递；而且第二个 timer 不会被任何 `stop()` 收走（`reminderRefreshHook`
   *  已经被覆盖）⇒ 泄漏 —— 两者都是"看起来在跑、其实在重发"的形状。
   *  ⚠️ 判据用模块级的 `reminderRefreshHook`：coexist 那条入口装调度器时也设它
   *     （main.ts:6241）⇒ 这条闸同时覆盖"与 coexist 装了两份"的情形。
   *  ⚠️ 已启动 ⇒ **具名拒绝**（失败关闭、返回 `undefined`，与 flags 闸同一形状）：
   *     不静默复用（调用方以为拿到了 stop()），也不静默叠加。
   */
  /*
   * ⚠️ 判据**不在本文件里**：它被抽成冻结的纯函数 `decideReminderStart`（见
   *    `src/infrastructure/runtime/reminder-scheduler-guard.ts`），因为门**不 import 本文件**
   *    ⇒ 只有抽出去，门才能用三段式真的量到它（否则只能量"重复投递"这个**弱见证** ——
   *    那个现象已被 `excludeAttempted()` 挡掉，两个 timer 也可能全绿）。
   */
  const startDecision = decideReminderStart({ hookInstalled: reminderRefreshHook !== undefined })
  if (startDecision.kind === 'refuse') {
    logger.warn(
      `[reminder] 拒绝启动第二个调度器：本进程已有提醒调度在跑（${startDecision.code}）`
    )
    return undefined
  }
  const db = input.kernel.stores.db
  const local = input.channel === 'qq_private'
    ? undefined
    : (() => {
        const registry = reminderDeliveryChannel(db, input.channel)
        return bindLocalReminderConnection(db, input.channel, registry, input.write)
      })()
  reminderRuntimeChannels = [input.channel]
  const policy = readProactivePolicy(process.env)
  const timer = new ProactiveScheduler({ timer: createCronerTimer({ timeZone: policy.timeZone }), policy, careEnabled: false,
    ...createReminderScheduling({ db, characterId: input.kernel.characterId, channels: reminderRuntimeChannels,
      registry: channel => reminderDeliveryChannel(db, channel),
        /* ★ S3 ③ 缺口 B（D05「任何回复即销账」）：把真读数喂进去。
           ⚠️ `lastInboundAt` 返回 `Timestamp | undefined`（从没有过入站）⇒ 取 0，
              于是 `settledByReply = lastInboundAt > 上次投递时刻` 为 false —— 正确的"没回过"。 */
        lastInboundAt: async () => (await lastInboundAt(db, input.kernel.characterId)) ?? 0,
        /* ★ S3 ③：暂停优先于重复（D05）。读数与关心机会预检**同源**（readControl 的落库状态，不是内存变量） */
        paused: async () => (await readControl(db, input.kernel.characterId))?.paused === true,
        /* ★ 续发间隔：从 flags 来（缺省 60_000 ⇒ 与裁定逐字相同；设了 env 才能让行为级门秒级跑） */
        repeatIntervalMs: input.flags.reminderRepeatIntervalMs,
      /*
       * ★ 2026-10-10 / R6：照 coexist 那条入口的**同一形状**（main.ts:6079-6083）。
       *
       * ⚠️ 真发现（先后被类型系统与 coexist 的装配各证实一次）：
       *    `deliverProactiveQqText()` 只对**本地通道**收 `channel`；`qq_private` 必须**省略**它 ——
       *    投递会话自己就是 QQ 入口会话（coexist 里 `proactiveSender = session`，见 main.ts:6047），
       *    通道由会话本身决定。
       *    硬塞 `'qq_private'` 会被类型挡下；"绕过类型"则会造出本地连接 + QQ 通道的混合体
       *    （ADR-110 §25 已经踩过一次同型）。这里既不绕，也不多加一层本地连接。
       */
      execute: async (channel, request) => await input.session.deliverProactiveQqText({
        ...request,
        ...(channel === 'qq_private' ? {} : { channel }),
      }),
      reading: reading => logger.info(`[reminder] ${JSON.stringify(reading)}`),
    }), onCareOpportunity: async () => {},
  })
  reminderRefreshHook = async () => await timer.refresh()
  await timer.start()
  return {
    /* ★ 本地通道才有这一份报告；`qq_private` 的报告走 `host.reportQqDelivery`（见上） */
    ...(local === undefined ? {} : { report: local.report }),
    async stop() {
      timer.stop()
      if (!await timer.drain()) throw new Error('reminder_drain_timeout')
      reminderRefreshHook = undefined
      reminderRuntimeChannels = []
      await local?.close()
    },
  }
}
import { isSuccessResult, describeActionResult } from './kernel/action/action-result.ts'
/*
 * ⚠️ 后 Lv2 · WP1：`applyActionClaimGuard` / `applyCommitmentClaimGuard` /
 * `commitmentWriteFacts` 的调用点已经**全部**搬进 `reply-guard-chain.ts`
 * （链的唯一实现）。这里不再逐个 import —— 逐个 import 会让"再抄一遍"
 * 重新变得容易，而 R3 的 host 正是那样漏掉了全部五道守卫。
 */
/* M5.5 / ADR-045 D-11·D-12：能力追加登记 · 意图链 · 权限常量 */
import {
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SEARCH_LOCALE,
  WEB_SEARCH,
  WEB_SEARCH_OPERATION,
  WEB_SEARCH_PERMISSION,
  createExternalEvidenceCapabilityDefinitions,
} from './kernel/action/external-evidence-capability.ts'
import {
  chainIntentDetectors,
  createExternalEvidenceIntentDetector,
} from './kernel/action/external-evidence-intent.ts'
/*
 * 实用能力加装（`Utility-Skills-Execution-Plan-2026-10-04.md` §2）：
 * 四项能力的**登记 / 检测 / 权限**与四个适配器（能力声明恒登记、权限与适配器按开关）。
 */
import {
  DOCUMENT_READ,
  DOCUMENT_READ_PERMISSION,
  IMAGE_OCR,
  IMAGE_OCR_PERMISSION,
  MATH_CALCULATE,
  MATH_CALCULATE_PERMISSION,
  WEB_READ,
  WEB_READ_PERMISSION,
  createUtilityCapabilityDefinitions,
  utilityCapabilityLabel,
} from './kernel/action/utility-capabilities.ts'
import { createUtilityIntentDetector } from './kernel/action/utility-intent.ts'
import { createWeatherIntentDetector } from './kernel/action/weather-news-intent.ts'
import { createMathCalculateAdapter } from './infrastructure/action/adapters/math-calculate.ts'
import { createDocumentReadAdapter } from './infrastructure/action/adapters/document-read.ts'
import { createWebReadAdapter } from './infrastructure/action/adapters/web-read.ts'
import { createImageOcrAdapter } from './infrastructure/action/adapters/image-ocr.ts'
import { configuredOcrBackend } from './infrastructure/action/adapters/rapid-ocr-assets.ts'
/* M5.5.1 WP4 / ADR-049 §11 R2：候选 → 共用判定 → 程序授权 → 绑定 query */
import { resolveSearchNeed } from './kernel/action/search-need-resolution.ts'
import { searchNeedDiagnosticsOf } from './kernel/action/search-need-reply.ts'
import { createOpenAiSearchNeedJudge } from './infrastructure/model/openai-search-need-judge.ts'
import { SEARCH_MODES } from './kernel/action/search-need.ts'
/* M5.5 WP6 / ADR-045 D-9·D-17：回复五态 + 确定性来源附录 + 剥离自造引用
 * ⚠️ 后 Lv2 · WP1：这两个函数只在 `reply-guard-chain.ts` 里用（链的唯一实现）。 */
/*
 * M6.1 WP4 / ADR-055 `D-55g`：四道回复守卫的**观测三态**要进 trace。
 * 契约住在 kernel；这里只做"把返回值翻译成报告"这一件事。
 */
import type { ReplyGuardReport } from './kernel/contracts/reply-guard.ts'
/* M5.5 / ADR-054：Tavily provider + 指纹 + 适配器（ADR-046 的 D-20…D-30 在此落地） */
import { assertTavilyConfig, D20_RULING } from './infrastructure/search/tavily-config.ts'
import { TAVILY_PROVIDER_ID, createTavilySearchProvider } from './infrastructure/search/tavily-search-provider.ts'
import { createSha256Fingerprinter } from './infrastructure/search/fingerprint.ts'
import { createWebSearchAdapter } from './infrastructure/action/adapters/web-search.ts'
import {
  actionAdminUsage,
  parseActionAdminArgs,
  renderActionAudit,
  renderActionDetail,
  renderActionList,
  renderActionTrace,
} from './kernel/action/admin.ts'
import { createActionLedgerStore, foldRecord } from './infrastructure/action/action-ledger-store.ts'
import {
  createDeveloperQueryService,
  semanticRetrievalCapability,
} from './infrastructure/dev/query-service.ts'
import {
  AVAILABLE as DEVELOPER_AVAILABLE,
  unavailable as developerUnavailable,
} from './kernel/contracts/developer-query.ts'
import { createDeveloperControlAuditWriter } from './infrastructure/dev/control-audit.ts'
import {
  createAuditControlHandler,
  createDeveloperControlService,
  createDiagnosticControlHandler,
} from './infrastructure/dev/control-service.ts'
import {
  DEFAULT_DEVELOPER_HTTP_PORT,
  developerControlRoutePatterns,
  developerQueryRoutePatterns,
  startDeveloperQueryServer,
} from './infrastructure/dev/http-server.ts'
/*
 * ============================================================================
 *  第二批（`Productivity-Skills-and-Local-File-Execution-Plan-2026-10-04.md`）
 * ============================================================================
 * 本机文件域（能力 / 目标 / 意图 / 适配器）+ 任务执行环（授权 / 计划 / 环 / 规划器）
 * + 四项业务能力（天气 / 办公 / 资讯 / 浏览器）。
 *
 * ⚠️ 依赖方向：上面这些 `kernel/*` 模块**不 import 基础设施**；适配器与规划器
 *    住在 `infrastructure/`，由**这里**（唯一装配层）把它们拼起来。
 */
import {
  LOCAL_FILE_LIST,
  LOCAL_FILE_LIST_PERMISSION,
  LOCAL_FILE_READ,
  LOCAL_FILE_READ_PERMISSION,
  LOCAL_FILE_WRITE,
  LOCAL_FILE_WRITE_PERMISSION,
  createLocalFileCapabilityDefinitions,
  isLocalFileCapability,
} from './kernel/action/local-file-capabilities.ts'
import {
  createLocalFileIntentDetector,
} from './kernel/action/local-file-intent.ts'
import { resolveLocalTarget } from './kernel/action/local-target.ts'
import { createInMemoryPayloadStaging } from './kernel/action/payload-staging.ts'
import {
  createTaskAuthorizationRegistry,
} from './kernel/action/task-authorization.ts'
import { describeTaskRun } from './kernel/action/task-loop.ts'
import type { ActionPolicyScopeWording } from './kernel/action/policy.ts'
import type { RiskLevel } from './kernel/action/action-request.ts'
import type { TurnContentSourceKind } from './kernel/contracts/turn-content.ts'
import {
  createLocalListAdapter,
  createLocalReadAdapter,
  createLocalWriteAdapter,
  resolveLocalAbsolutePath,
} from './infrastructure/action/adapters/local-filesystem.ts'
import { createOpenAiTaskPlanner } from './infrastructure/model/openai-task-planner.ts'
/*
 * WP1 / ADR-104：角色自行选择工具（决策端口 + 程序生成的工具目录）。
 */
import { createOpenAiToolDecisionPort } from './infrastructure/model/openai-tool-decision.ts'
import {
  buildToolCatalog,
  renderToolCatalogForModel,
  type ToolConnectionState,
} from './kernel/action/tool-catalog.ts'
import {
  describeKnownDirectories,
  renderKnownDirectoriesForModel,
} from './kernel/action/known-directories.ts'
import { readKnownDesktopDirectories } from './infrastructure/action/known-folders.ts'
import {
  WEATHER_QUERY,
  WEATHER_QUERY_PERMISSION,
  createWeatherCapabilityDefinitions,
} from './kernel/action/weather-capability.ts'
import { createWeatherAdapter } from './infrastructure/action/adapters/weather.ts'
import {
  OFFICE_GENERATE,
  OFFICE_GENERATE_PERMISSION,
  createOfficeCapabilityDefinitions,
} from './kernel/action/office-capability.ts'
import { createOfficeGenerateAdapter } from './infrastructure/action/adapters/office-generate.ts'
import {
  NEWS_READ,
  NEWS_READ_PERMISSION,
  createNewsCapabilityDefinitions,
} from './kernel/action/news-capability.ts'
import { createNewsReadAdapter } from './infrastructure/action/adapters/news-read.ts'
import {
  BROWSER_MCP,
  BROWSER_MCP_PERMISSION,
  BROWSER_OPERATE,
  BROWSER_READ,
  BROWSER_OPERATE_PERMISSION,
  BROWSER_READ_PERMISSION,
  createBrowserCapabilityDefinitions,
  isBrowserCapability,
} from './kernel/action/browser-capability.ts'
import { createBrowserAdapters } from './infrastructure/action/adapters/browser.ts'
import {
  DESKTOP_INSPECT,
  DESKTOP_INSPECT_PERMISSION,
  DESKTOP_OPERATE,
  DESKTOP_OPERATE_PERMISSION,
  createDesktopCapabilityDefinitions,
  isDesktopCapability,
} from './kernel/action/desktop-capability.ts'
import { createDesktopAdapters } from './infrastructure/action/adapters/desktop-control.ts'
/*
 * post-Lv2 / ADR-110 `D05`：QQ 主动联系的**目标发送能力**。
 *
 * ⚠️ 它**恒登记**（关着时一条请求得到可审计的 `permission_denied`），
 *    但**不进** `TASK_CAPABILITY_IDS` ⇒ 角色自行选择工具与任务执行环永远规划不到它
 *    （计划 §7 的能力矩阵："本批新增 NONE"）。
 */
import {
  QQ_PRIVATE_OWNER_TARGET_TYPE,
  QQ_PRIVATE_SEND_OPERATION,
  QQ_PRIVATE_SEND_PERMISSION,
  QQ_PRIVATE_SEND_TEXT,
  createQqProactiveCapabilityDefinitions,
} from './kernel/action/qq-proactive-capability.ts'
import { verifyDesktopRuntimeSync } from './infrastructure/action/adapters/desktop-control-assets.ts'
import { createBrowserSidecarSupervisor, type BrowserSidecarSupervisor } from './infrastructure/action/browser-sidecar-supervisor.ts'
import {
  createSandboxReadAdapter,
  createSandboxWriteAdapter,
  listSandboxEntries,
} from './infrastructure/action/adapters/sandbox-filesystem.ts'
import { createEchoAdapter } from './infrastructure/action/adapters/echo.ts'
import {
  ChainedContentExtractor,
  LlmContentExtractor,
  createRuleOnlyContentExtractor,
} from './kernel/app/memory/content-extractor.ts'
import { createTargetMemoryResolver } from './kernel/app/memory/target-resolver.ts'
import { createMemoryMutationValidator } from './kernel/policies/memory-validator.ts'
import { applyAcceptedEvents } from './infrastructure/persistence/event-store.ts'
import { findEventRefs } from './infrastructure/persistence/conversation-store.ts'
import { AutomaticMemoryConsumer } from './infrastructure/runtime/automatic-memory.ts'
import { PostTurnModelMemoryConsumer, deferredMemoryTurnPort, MODEL_MEMORY_TARGET } from './infrastructure/runtime/post-turn-model-memory.ts'
import { readAutomaticMemoryHealth, authorizeAutomaticMemoryRetry } from './infrastructure/runtime/automatic-memory-control.ts'
import { LangMemMemoryExtractor } from './infrastructure/model/langmem-memory-extractor.ts'
import { getConversationEvent } from './infrastructure/persistence/conversation-store.ts'
import { getTrace } from './infrastructure/persistence/trace-store.ts'
import { hasProcessedOperation } from './infrastructure/persistence/job-store.ts'

// ---------------------------------------------------------------------------
// 真实库写保护
// ---------------------------------------------------------------------------
// 主程序是唯一允许操作真实对话库的入口：显式放行。
// 实验脚本不调用这个函数，因此它们若忘了隔离，会在 initDatabase 处**直接失败**，
// 而不是悄悄写坏真实历史（详见 src/dev/sandbox.ts）。
//
// 放在 import 之后即可：ESM 先求值全部 import、再执行模块体，
// 而真正的数据库连接发生在 main() 里的 await initDatabase(...)，那时早已放行。
allowProductionDatabase()


// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const MODEL_ID = process.env.OPENAI_LARGE_MODEL ?? 'deepseek-ai/DeepSeek-V4-Flash'
const BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.siliconflow.cn/v1'
/** 每轮注入的历史消息条数（ElizaOS 的 conversationLength） */
const CONVERSATION_LENGTH = Number(process.env.CONVERSATION_LENGTH ?? 16)
/** 输出上下文构建明细，用于 L1-M1 验收 */
const DEBUG_CONTEXT = process.env.DEBUG_CONTEXT !== '0'

/**
 * WP2：**已知目录事实**的只读缓存（启动时探一次，之后进程内不变）。
 *
 * ⚠️ 解引用是**同步**的（决策器与规划器都是同步取用），因此用"启动时填充 +
 *    只读缓存"而不是"每次调用现探" —— 后者会让每一轮都多一次 2 秒的进程。
 * ⚠️ 没探过 / 探失败 ⇒ **空数组**（= "这一轮不知道桌面在哪"），
 *    而不是一个猜出来的路径（那正是要修的故障）。
 */
let knownDirectoryLines: readonly string[] = []

/**
 * 探一次已知目录（**只读 + 有界 + 失败不阻塞**）。
 *
 * ⚠️ 失败时留一行 `warn`：不写这一行的话，"她不知道桌面在哪"与
 *    "探测脚本没跑起来"在日志上分不开（先例：M5.5.1 的"为什么没搜"）。
 */
async function primeKnownDirectoryFacts(): Promise<void> {
  try {
    const facts = await readKnownDesktopDirectories()
    knownDirectoryLines = [renderKnownDirectoriesForModel(facts)]
    logger.info(`[role-tool] 已知目录读数：${describeKnownDirectories(facts)}`)
  } catch (error) {
    knownDirectoryLines = []
    logger.warn(
      `[role-tool] 已知目录探测抛错（决策与规划将看不到它们，**不回落到猜的路径**）：` +
        `${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * 第二批：本机文件域的**目标域措辞**（只改措辞，不改判定）。
 *
 * 计划书 §2.1 第 2 点逐字：「全盘目标携带真实的本地路径域证据，Policy/trace
 * **不能把它错误描述为"沙箱范围内"**」。缺省那三句（沙箱）在 `policy.ts` 里
 * 一个字节都没动 —— 这里只是给本机文件域的能力配一套**如实**的说法。
 */
const LOCAL_FILE_SCOPE_WORDING: ActionPolicyScopeWording = {
  inScope: '在已授权的本机文件域内（**不是**沙箱：这是本机真实路径）',
  outOfScope: '目标在本机文件域之外（网络共享 / 设备路径 / 备用数据流）：未触碰真实文件系统',
  outOfScopeMessage: '这个目标不在我能碰的本机文件域里，拒绝执行',
}

/**
 * WP2：给**规划器**的内容额度上限（token）。
 *
 * ⚠️ 上限的理由是"这一份文本会进**每一次**重新规划"（一个任务可能规划 6 次），
 *    而它复用的额度是 `turnContentTokens`（那是**每轮**注入 prompt 的额度）。
 *    不加上限的话，把 prompt 额度调到 3000 会让每一次规划都背上 3000 token。
 */
const TOOL_PLANNER_CONTENT_CAP_TOKENS = 1_200
/**
 * WP3：给**规划器**的外部证据（搜索命中行）额度上限（token）。
 *
 * ⚠️ 比内容上限更低：规划器要的是"哪几条命中、URL 是什么"，正文交给 `web.read` 去取。
 *    同样复用的是"每轮注入 prompt 的搜索证据额度"（`webSearchEvidenceTokens`），
 *    并按计划书 §7 的"共享预算、不借新环规避"加上限。
 */
const TOOL_PLANNER_EVIDENCE_CAP_TOKENS = 600

/**
 * 第二批：任务执行环**允许使用**的能力全集（顺序 = 计划书 §2.2 的"任务需要的具体能力"）。
 *
 * ⚠️ 这是一张**候选表**，不是授权表：真正生效的是 `isTaskCapabilityEnabled()`
 *    ——它按开关逐项过滤。本表列进去但没有开关的能力，永远不会出现在任务授权里。
 * ⚠️ `browser.operate` 在表里，但它的风险等级是 **R2**：只有浏览器开关打开、
 *    任务额度被抬到 R2 时才可能被允许（计划书 §4）。
 */
const TASK_CAPABILITY_IDS: readonly string[] = [
  PERSONAL_LIBRARY_SEARCH,
  WORKFLOW_SKILL,
  ARXIV_RESEARCH,
  LOCAL_FILE_LIST,
  LOCAL_FILE_READ,
  LOCAL_FILE_WRITE,
  DOCUMENT_READ,
  IMAGE_OCR,
  MATH_CALCULATE,
  WEB_READ,
  WEB_SEARCH,
  WEATHER_QUERY,
  OFFICE_GENERATE,
  NEWS_READ,
  BROWSER_READ,
  BROWSER_OPERATE,
  /*
   * ★ 2026-10-09 / ADR-125：全工具档（任意工具入口）。进候选表不等于可用 ——
   *   真正的授权仍由 `toolCapabilitiesForTurn()` 按 `browserFullTools` 过滤。
   */
  BROWSER_MCP,
  /*
   * ADR-106：桌面两件也进候选表；真正的授权仍由 `isTaskCapabilityEnabled()` 按开关过滤。
   * ⚠️ `desktop.operate` 是 **R2**：与 `browser.operate` 同一条边界 ——
   *    只有对应开关打开、任务额度被抬到 R2 时才可能被允许。
   */
  DESKTOP_INSPECT,
  DESKTOP_OPERATE,
]

/**
 * 模型前置检查（preflight）。
 * 宁可在这里立刻炸掉，也不要等到第 3 轮对话才在 provider 里报一个难懂的错。
 *
 * ⚠️ `probeConnectivity: false` 用于**只读命令**（见 `main()` 里的说明）：
 *    仍然要求 Key 存在（运行时装配需要），但**不发**那次网络探测。
 *    一个读本地数据库的审计命令不该因为模型服务商 522 而失败。
 */
async function preflight(options: { probeConnectivity?: boolean } = {}): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error(
      '缺少 OPENAI_API_KEY：请在项目根目录的 .env 中填入 API Key（.env.example 是模板）。'
    )
  }

  if (options.probeConnectivity === false) {
    logger.info(`模型连通性检查已跳过（只读命令）：${MODEL_ID} @ ${BASE_URL}`)
    return
  }

  const url = `${BASE_URL.replace(/\/$/, '')}/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      messages: [{ role: 'user', content: '回复两个字：就绪' }],
      max_tokens: 16,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `模型连通性检查失败 (HTTP ${res.status}): ${body.slice(0, 300)}\n` +
        '（若你只是想审计/查看本地记忆，用 pnpm memory:* —— 那些命令不要求模型可达）'
    )
  }
  logger.info(`模型就绪: ${MODEL_ID} @ ${BASE_URL}`)
}

// ---------------------------------------------------------------------------
// 运行时装配
// ---------------------------------------------------------------------------

/**
 * 角色状态按「角色 × 用户」维度存放，两边都得有稳定 id。
 * characterId 取角色自身 id；userId 与 ChatSession 用同一个推导方式，
 * 保证重启后仍落在同一条状态记录上（L1-M4 的连续性前提）。
 */
export function resolveIds(userName: string): { characterId: string; userId: string } {
  return {
    characterId: character.id ?? character.name,
    userId: stringToUuid(`user-${userName}`),
  }
}

async function buildRuntime(userName: string): Promise<AgentRuntime> {
  const ids = resolveIds(userName)

  // persistent-character 需要知道自己服务的是「哪个角色 × 哪个用户」，
  // 因此先构造实例再注册，而不是靠全局单例。
  const persistentCharacter = createPersistentCharacterPlugin(ids)

  // 装配 L1 需要的插件实例，依赖关系在本仓库内可见：
  //   sql                  → 持久化（pglite），Recent Messages 的来源
  //   bootstrap            → 官方消息管线与 RECENT_MESSAGES / CHARACTER 等 provider
  //   openai               → 提供 embedding 能力（文本生成被下面这个覆盖）
  //   openai-compatible    → 我们的模型 provider（priority 更高，走 /chat/completions）
  //   persistent-character → L1-M2：角色状态持久化 + CHARACTER_STATE provider
  const plugins: Plugin[] = [
    openaiPlugin,
    bootstrapPlugin,
    openAiCompatiblePlugin,
    persistentCharacter,
  ]

  // runtime.getSetting() 走的是这个内部设置表，而不是 process.env，
  // 所以必须显式把 .env 的值播种进去，否则插件读到的全是 null。
  const settings: Record<string, string> = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    OPENAI_BASE_URL: BASE_URL,
    OPENAI_LARGE_MODEL: MODEL_ID,
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? MODEL_ID,
    // embedding 可以指向与对话不同的端点（DeepSeek 官方不提供 embedding）
    OPENAI_EMBEDDING_MODEL: process.env.OPENAI_EMBEDDING_MODEL ?? 'BAAI/bge-m3',
    OPENAI_EMBEDDING_DIMENSIONS: process.env.OPENAI_EMBEDDING_DIMENSIONS ?? '1024',
    ...(process.env.OPENAI_EMBEDDING_URL
      ? { OPENAI_EMBEDDING_URL: process.env.OPENAI_EMBEDDING_URL }
      : {}),
    ...(process.env.OPENAI_EMBEDDING_API_KEY
      ? { OPENAI_EMBEDDING_API_KEY: process.env.OPENAI_EMBEDDING_API_KEY }
      : {}),
    /*
     * ⚠️ **PostgreSQL 迁移（WP7/WP8，2026-10-13）**：上面那句注释对本条同样成立 ——
     *    插件的**适配器创建**读的是 `runtime.getSetting('POSTGRES_URL')`，它**不回落** `process.env`。
     *    ⇒ 不在这里播种，`.env` 里写了 PG 后端也**没用**：插件会回退成 **PGlite 适配器**、
     *      去开 `PGLITE_DATA_DIR`（那就是**真实库**），而仓库自己的身份核对期望的是 PG 库
     *      ⇒ **核心起不来**（实测：`期望 sumuwei，实际 template1`），
     *      而且在失败之前**已经打开了真实库**（`PG-ISO-01` 的同一形态，第二次踩到）。
     *    ⚠️ 只在环境里**真的有**这些键时才播种 ⇒ 纯 PGlite 档**逐字节不受影响**。
     */
    ...(process.env.POSTGRES_URL ? { POSTGRES_URL: process.env.POSTGRES_URL } : {}),
    ...(process.env.CHARACTER_DB_BACKEND ? { CHARACTER_DB_BACKEND: process.env.CHARACTER_DB_BACKEND } : {}),
    ...(process.env.PGLITE_DATA_DIR ? { PGLITE_DATA_DIR: process.env.PGLITE_DATA_DIR } : {}),
    ...(process.env.PGLITE_SNAPSHOT_DIR ? { PGLITE_SNAPSHOT_DIR: process.env.PGLITE_SNAPSHOT_DIR } : {}),
    ...(process.env.LG_PG_EXPECT_DATABASE ? { LG_PG_EXPECT_DATABASE: process.env.LG_PG_EXPECT_DATABASE } : {}),
    ...(process.env.LG_PG_EXPECT_DATABASE_PREFIX
      ? { LG_PG_EXPECT_DATABASE_PREFIX: process.env.LG_PG_EXPECT_DATABASE_PREFIX }
      : {}),
  }

  const runtime = new AgentRuntime({
    character,
    plugins,
    conversationLength: CONVERSATION_LENGTH,
    settings,
  })

  /*
   * INC-01 WP3（`AT3.3`）：**初始化失败也必须 close**。
   *
   * 真实情况：`initDatabase` 已经建好 adapter（PGlite 连接已打开），
   * 而紧随其后的 `initCharacterState` 失败 —— 在这之前那条路径会直接抛出，
   * **连接被留在打开状态**（正是事故的第三个缺口）。
   * `closeDatabaseConnection` 在没有 adapter 时是**安全 no-op**（只读命令会走到那一支）。
   *
   * INC-01 WP4（`AT4.1`/`AT4.2`）：**真实库**的这一次打开还必须先走生产状态机
   * （租约 → pre-open verified snapshot → 拿 token → 打开）。
   * 副本（例如 `verify-m5.5-smoke-live` 把 `PGLITE_DATA_DIR` 指向 `%TEMP%` 拷贝）
   * 与沙箱**不走**：它们不是她的库，走一遍只会平白复制 30MB。
   */
  const dataDir = productionDataDirOf()
  const guarded = process.env.PROJECT_LG_SANDBOX === undefined && isProductionDir(dataDir)
  let ready: DbReady | undefined

  const openDatabase = async (): Promise<void> => {
    // plugin-sql 需要走 registerPlugin 以完成迁移并注册适配器
    ready = await initDatabase(runtime, sqlPlugin)
  }

  try {
    if (guarded) {
      const handle = await prepareProductionOpen({
        dataDir,
        snapshotRoot: productionSnapshotRootOf(),
        operationKind: 'chat',
        deps: {
          openDatabase,
          /*
           * 停服务/关库都走 WP3 的唯一实现（收尾时是 `finish({ afterClose: true })`，
           * 那一步不会重复执行）；这里把注入点接上**同一个**实现，
           * 于是"裸 `runtime.stop()`"不会在 opener 里出现第二遍。
           */
          stopServices: () => stopRuntimeServices(runtime),
          closeDatabase: async () => await closeDatabaseConnection(runtime),
          isDatabaseClosed: () => isDatabaseClosed(runtime),
          lastVerifiedSnapshotId: () => lastVerifiedSnapshotId(productionSnapshotRootOf()),
        },
      })
      await handle.open()
      productionOpen = handle
      logger.info(
        `[inc-01] 生产状态机：${handle.reading.states.join(' → ')}` +
          `（pre-open 快照 ${handle.reading.preOpenSnapshotId ?? '未记录'}）`
      )
    } else {
      await openDatabase()
    }
    if (ready === undefined) {
      throw new Error('initDatabase 没有返回读数：拒绝把"没有库"当成"库就绪"')
    }
    const { adapterName } = ready

    /*
     * =======================================================================
     *  WP3 / ADR-132 `D05`：取得**单认知执行者资格**（在开库之后、状态引导之前）
     * =======================================================================
     * 为什么在这个位置：
     *   · **之后** —— 资格锁挂在连接池上，池要等 `initDatabase` 才存在；
     *   · **之前于状态引导** —— 任何业务写入（含状态引导那一条 `state_transition`）
     *     都不该由一个没有写入资格的进程做。
     *
     * 三条纪律（计划 §3.2 逐字）：
     *   ① 拿不到就**具名拒绝**并**拒绝启动** —— 不等待、不重试、不"试着跑跑看"；
     *   ② 只读与备份连接**不参与**这个锁（本函数不碰它们）；
     *   ③ 丢失资格由**可观测事件**判定 ⇒ 撤销后走既有有序停机链（停止接收新轮次）。
     *
     * ⚠️ 纯追加：PGlite 后端下 `dedicatedPoolOf()` 返回 undefined（嵌入式客户端没有
     *    `connect`）⇒ 直接跳过，既有行为**逐字不变**。
     */
    const qualificationPool = dedicatedPoolOf(runtime)
    if (qualificationPool !== undefined) {
      const qualification = await acquireSingleCoreQualification({
        pool: qualificationPool,
        characterId: ids.characterId,
        generation: 1,
        onInvalidated: (reason) => {
          if (reason === 'client_released') return
          logger.error(
            `[qualification] **写入资格丢失**（${reason}）：停止接收新轮次、取消未提交工作、保留已提交事实。` +
              `\n  绝不"再试一次拿锁"，也不另开一个核心碰运气（ADR-132 D05）。`
          )
          // 有序停机（与 sentinel 同一个 shutdown 链）。未建好时只记日志 ——
          // 那种情况只可能出现在"取得资格之后、收尾句柄建好之前"这一小段窗口。
          if (stopAfterQualificationLoss !== undefined) stopAfterQualificationLoss()
          else logger.error('[qualification] 收尾句柄尚未就绪 ⇒ 只记日志（本窗口极短）')
        },
      })
      singleCoreQualification = qualification
      beforeDatabaseClose(runtime, async () => {
        stopAfterQualificationLoss = undefined
        await qualification.release()
      })
      if (!qualification.acquired) {
        throw new KernelError(
          'persistence_error',
          qualification.denial ?? 'lock_not_acquired',
          singleCoreDenialMessage(qualification.denial ?? 'lock_not_acquired', ids.characterId)
        )
      }
      logger.info(
        `[qualification] 本进程是唯一认知执行者（lockId=${qualification.lockId}，` +
          `backendPid=${qualification.backendPid}）`
      )
    }

    // 状态建表必须等迁移之后（插件的 init 早于插件迁移执行）
    //
    // WP9-B2：生产装配根在这里**注入状态引导组件自己的受信身份证据** ——
    // 只有这样，首启那条 `state_transition` 的权威槽位才是
    // `Known(SYSTEM/state-bootstrap)`；不注入就是如实的 `Unknown(RUNTIME_UNRESOLVED)`。
    await initCharacterState(runtime, ids.characterId, ids.userId, {
      bootstrapEvidence: attestStateBootstrapComponentIdentity(),
    })

    const agentId = runtime.agentId as UUID
    logger.info(`角色已加载: ${character.name} (agentId=${agentId}, db=${adapterName})`)

    return runtime
  } catch (error) {
    await closeDatabaseConnection(runtime).catch(() => undefined)
    throw error
  }
}

/**
 * 装配 Character Kernel（M2.5）。
 *
 * 与 buildRuntime 分开，是为了让"M1 的运行时"与"M2.5 的角色内核"
 * 在代码上也是两件事：内核挂掉不该影响她能不能聊天，
 * 而反过来，要单独验证内核也不需要走完整运行时。
 */
async function buildKernel(runtime: AgentRuntime): Promise<KernelHandle> {
  /*
   * ⚠️ `registry` **必须**传 —— 这是 M4 的第二处接线缺口。
   *
   * ============================================================================
   *  实测症状：`domain_event_type_unregistered`
   * ============================================================================
   * 修好"显式记忆服务没人调用"之后，真库上的写入**仍然失败**。
   * 打开 trace 才看到放行口的拒绝码是 `domain_event_type_unregistered`：
   * 生产内核用的还是 M2.5 的最小诊断集，因此 `MEMORY_*` 六种领域事件
   * **一个都没登记**，于是每一条记忆提案都在放行口被拒。
   *
   * 为什么 M4 的测试全绿而生产不行：`m4:verify` / `eval:m4` 都显式传了
   * `createFullDomainEventRegistry()`，而 `main.ts` 没传 ——
   * `kernel.ts` 的注释写着"M4 的装配层传入"，但那一行从未被加上。
   *
   * 这与"服务没人调用"是**同一个形状**的缺陷：
   * 设计意图写在注释里、实现在代码里，而**中间的接线**没人做，
   * 并且没有任何测试在管"生产装配是否接上了"。
   *
   * 不传这个字段时行为与 M2.5 逐字节一致（那是刻意保留的默认），
   * 因此这里传**全集**只影响"允许哪些领域事件类型"，
   * 不改变既有诊断链路的行为，也不改变 prompt。
   */
  const kernel = await initKernel(runtime, {
    definition: characterDefinitionFromCharacter(character),
    registry: createFullDomainEventRegistry(),
  })
  logger.info(
    `[kernel] 角色内核就绪: ${kernel.definition.name}（${String(kernel.characterId)}）` +
      ` seed v${kernel.definition.seedVersion} hash=${kernel.identitySnapshot.snapshotHash.slice(0, 12)}` +
      `${kernel.seedCreated ? '（本次建档）' : ''}，` +
      `投影 ${kernel.reducers.length} 个`
  )
  return kernel
}

/**
 * 挂上事件日志，让"刚才究竟发生了什么"可见（Lv2 审计系统的雏形）。
 *
 * 注意：1.7.2 的 `runtime.events` 不是 EventEmitter，而是
 * `{ [eventName]: EventHandler[] }` 的字典，注册即向数组里 push。
 */
/**
 * M7 / WP6：调度结果的一行日志描述（"装了没有、响没响"必须一眼可见）。
 * 不含任何对话正文——只有计数与水位。
 */
function describeScheduling(outcome: RelationshipSchedulerOutcome): string {
  switch (outcome.kind) {
    case 'no_tail':
      return `无尾窗（水位 ${String(outcome.watermark)} = 账本 ${String(outcome.latest)}）`
    case 'held':
      return `持有：${outcome.reason}（尾窗 ${String(outcome.tailEvents)} 条 · 水位 ${String(outcome.watermark)}）`
    case 'flushed':
      return `消费：提案 ${String(outcome.proposals)} · 放行 ${String(outcome.acceptedProposals)} · ` +
        `拒 ${String(outcome.rejectedProposals)} · 域事件 ${String(outcome.createdEvents)} · ` +
        `水位 ${String(outcome.watermark)}→${String(outcome.latest)}${outcome.created ? '' : '（job 幂等命中）'}`
    case 'failed':
      return `失败（水位停在 ${String(outcome.watermark)}，下轮补洞）：${outcome.error}`
  }
}

/**
 * M8 / WP5：Affect 调度结果的一行日志描述（与 `describeScheduling` 同一纪律：
 * 不含任何对话正文——只有计数与水位；被拒明细只报码不报文）。
 */
function describeAffectScheduling(outcome: AffectSchedulerOutcome): string {
  switch (outcome.kind) {
    case 'no_tail':
      return `无尾窗（水位 ${String(outcome.watermark)} = 账本 ${String(outcome.latest)}）`
    case 'flushed':
      return `消费：提案 ${String(outcome.proposals)} · 放行 ${String(outcome.acceptedProposals)} · ` +
        `拒 ${String(outcome.rejectedProposals)} · 域事件 ${String(outcome.createdEvents)} · ` +
        `水位 ${String(outcome.watermark)}→${String(outcome.latest)}` +
        `${outcome.created ? '' : '（job 幂等命中）'}` +
        (outcome.deduplicated > 0 ? ` · 幂等命中 ${String(outcome.deduplicated)}` : '') +
        (outcome.rejections.length > 0
          ? ` · 拒码 [${outcome.rejections.map((r) => r.code).join(', ')}]`
          : '')
    case 'failed':
      return `失败（水位停在 ${String(outcome.watermark)}，下轮补洞）：${outcome.error}`
  }
}

function attachEventLog(runtime: AgentRuntime): void {
  const log = (event: string) => async (payload: unknown) => {
    const p = payload as { message?: { content?: { text?: string } }; text?: string }
    const text = p?.message?.content?.text ?? p?.text ?? ''
    logger.debug(`[event] ${event}${text ? ` :: ${text.slice(0, 60)}` : ''}`)
  }

  for (const event of [
    EventType.MESSAGE_RECEIVED,
    EventType.MESSAGE_SENT,
    EventType.RUN_STARTED,
    EventType.RUN_ENDED,
  ]) {
    const handlers = (runtime.events[event] ??= [])
    handlers.push(log(event))
  }
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

/**
 * post-Lv2 / **ADR-109 `D01`/`D03`** —— **公共生命周期与共享消费者的唯一执行者**。
 *
 * ============================================================================
 *  为什么需要这个接口
 * ============================================================================
 *
 * ```text
 * 一个核心 + 两个受信会话（D01）
 *   ⇒ 后台消费者（语义慢路径 / 反思 / 约定 / 故事）只能有**一套**在飞闸
 *   ⇒ 第二路会话不能自己跑一份（否则同一份认知被算两遍，水位互相打架）
 * ```
 *
 * 因此第二路会话（`publicLifecycle: 'shared'`）把四件事**借给** owner：
 * 四个 drain（它自己只提供 `traceId`，追加到哪条 trace 由 id 查库决定）
 * 与一个故事装配实例。
 *
 * ⚠️ **`closeShared()` 不在这个接口上给借用者用**：借用者调 `close()` 是
 *    **什么都不做**（`D07`：断开不是停机）。只有核心管理者能关库。
 */
interface SharedConsumerDelegate {
  drainAutomaticMemoryTail(): Promise<void>
  drainReflectionTail(recover?: boolean): Promise<void>
  drainAgreementTail(recover?: boolean): Promise<void>
  drainStoryTail(): Promise<void>
  drainSemanticTail(traceId?: ReturnType<typeof asTraceId>): Promise<void>
  /** S8：故事装配实例（owner 在 `open()` 里建一次；借用者复用**同一个**） */
  readonly storyCognition: ReturnType<typeof createStoryCognition> | undefined
}

class ChatSession {
  private readonly workflowSkills: readonly WorkflowSkillDefinition[]
  private readonly runtime: AgentRuntime
  /** 本会话的房间 id（--reset 等命令需要从外部访问，故公开只读） */
  readonly roomId: UUID
  private readonly userEntityId: UUID
  private readonly agentEntityId: UUID
  private readonly worldId: UUID
  private readonly ids: { characterId: string; userId: string }
  /**
   * **S8 / `ADR-107` `R-1b`**：故事装配实例（在 `open()` 里按开关建造一次，**每轮复用**）。
   *
   * ⚠️ 它存在的理由不只是省一次构造：它让"同轮选择解析"走**已登记的故事边界模块**
   *    （`story-cognition.ts`），而不是让 `main.ts` 自己去建账本端口 ——
   *    `m3.5:test` 的 `FC-T04` 边界锁**就是**在守这条（它的负控拿
   *    `src/main.ts` + `story-ledger-store.ts` 的合成 import 当反例）。
   */
  private storyCognition?: ReturnType<typeof createStoryCognition>
  private readonly userName: string
  /**
   * 干跑模式（--test / --dry-run）：能真实对话，但不产生任何副作用。
   *
   * 规矩（用户 2026-09-15）：我执行的测试，记忆默认不写入；
   * 是否把测试内容写进记忆由用户决定，我要在测完后询问。
   * 这个开关就是那条规矩的技术实现——不靠我记着，靠模式。
   *
   * 干跑时：不落消息、不记 state_events、不推进 lastInteractionAt。
   * 她读到的仍是**真实状态与真实历史**（所以测试是有意义的），
   * 但这次测试对她而言等于没发生过。
   */
  private readonly dryRun: boolean
  /** M2.5：Character Kernel 与功能开关（未启用时为 undefined） */
  private readonly kernel: KernelHandle | undefined
  private readonly flags: ReturnType<typeof readKernelFlags>
  /**
   * Lv4.5 / `P3`：**有限插话**的开关读数（只读）。
   *
   * ⚠️ 只用**窄**取值器而不是把整个 `flags` 公开：桥需要的只有这一个布尔，
   *    暴露整个开关表会让"桥能改哪些开关"变成一个隐式契约。
   */
  get interjectionEnabled(): boolean {
    return this.flags.interjectionEnabled
  }
  private readonly telemetry: TelemetryMirror | undefined
  /**
   * 本次程序运行的 id（M3 / 计划书第 9 节）。
   *
   * 它**只**进 Trace，绝不作为 CharacterId 或 UserId ——
   * RuntimeIdentity 与另外三种身份必须分开的原因就在这里：
   * 重启一次不该让她变成另一个人，也不该让用户变成另一个人。
   */
  private readonly runtimeId: RuntimeId
  private gateway: TurnGateway | undefined
  private turn = 0
  /** 干跑模式下本轮进程已进行的轮数（用于推导不重复的 turn） */
  private dryRunTurns = 0
  /** 会话内下一个可用序号（新链路用，来自数据库而不是进程内计数） */
  private conversationSequence = 1
  /**
   * WP6.1（K-28）：本次进程的**入口模式**。
   *
   * 它决定写进账本的归因：交互式人类控制台 ⇒ `Known(USER/…)` + confirmed；
   * 程序化一次性入口 ⇒ `Known(SERVICE/agent-runner)` + unconfirmed。
   *
   * ⚠️ 刻意**必填**（没有缺省值）：给一个默认值就等于"某个入口悄悄以另一个
   * 入口的身份记账"，而那正是 D01 的形状。唯一该决定它的地方是
   * `conversationEntryModeOf(argv)`。
   */
  private readonly entryMode: ConversationEntryMode
  /**
   * post-Lv2 / ADR-109 `D02`：**本会话属于哪个入口**。
   *
   * ⚠️ 它决定会话 id 的入口分量（`entryScopedConversations` 打开时）与账本
   *    `transport`。它由装配层从程序事实推出，**没有**任何请求字段能改它。
   */
  private readonly entryKey: ChatEntryKey
  /**
   * post-Lv2 / ADR-109 `D01`/`D03`：**借用** owner 的共享消费者。
   *
   * `undefined` ⇒ 本会话是 owner（自己跑公共生命周期与四个 drain）。
   * 有值    ⇒ 本会话是借用者（`open()` 不跑共享段、`close()` 什么都不做、
   *            四个 drain 转交给 owner）。
   */
  private readonly consumers: SharedConsumerDelegate | undefined
  private readonly qqOwnerId: string | undefined
  /**
   * Lv4.5 / `P1`：**语音交付账**（可选；只有 `--bridge` 入口注入）。
   *
   * 它只影响"最近对话"这一份**视图**：没播出去的句子不进已说内容
   * （媒体交付契约 §2 `M11`）。没有它时（CLI / 干跑 / 各门）行为逐字不变。
   */
  private readonly voiceDelivery: VoiceDeliveryLedger | undefined
  /**
   * INC-01 WP3（`AT3.1`）：**收尾句柄**。
   *
   * 交互式会话的 `close()` 也走它 —— 于是"对话循环退出"与"main 的分支返回"
   * 与"信号"三条路径共用**同一个**幂等的 `stop → close → closed check`。
   */
  private readonly shutdown: ShutdownHandle
  /**
   * M8.5 WP8：语义慢路径的**串行守卫**（§8.2 每 Character 一个串行提交队列）。
   *
   * 同一时刻至多一个语义 tick 在飞：轮后的 fire-and-forget drain 若撞上
   * 在飞 tick 就跳过（在飞的那个会排干尾窗——内存通知不是工作真相，
   * 持久水位间隙才是；跳过不丢工作）。收尾时 `close()` 对它做有界收拢。
   */
  private semanticDrainInFlight: Promise<void> | undefined
  /** M8.5 WP8：语义评估的中止信号（收尾链先 abort 再收拢短写事务） */
  private readonly semanticAbort = new AbortController()
  private reflectionDrainInFlight: Promise<void> | undefined
  /**
   * 第二批：**写入载荷的私有暂存**（进程级单例）。
   *
   * ⚠️ 必须**只有一个实例**：计划把载荷放进去，适配器按引用取出来。
   *    两个实例会让 `payloadRef` 在适配器那边取不到 —— 而那是"写一个空文件"
   *    或"拒绝写入"的分界线（本适配器选后者：取不到就失败关闭）。
   * ⚠️ 它在内存里，**永不落盘、永不进账本 / trace / 开发者面**。
   */
  private readonly payloadStaging = createInMemoryPayloadStaging()
  /** M10.1：约定识别慢路径的在飞 drain；与反思共用 A12 顺序队列。 */
  private agreementDrainInFlight: Promise<void> | undefined
  private automaticMemory: AutomaticMemoryConsumer | PostTurnModelMemoryConsumer | undefined
  private readonly automaticMemoryAbort = new AbortController()
  /**
   * **S8 / `ADR-107` `R-3b`**：轮尾故事消费的在飞 drain（同型重入保护）。
   *
   * ⚠️ 它存在的意义是把 `L-S8-30` §C2 的口径不一致补上：`D03` 的口径是"**提交后**消费"，
   *    而此前 `consumeOnce()` **只在 `open()` 跑一次** ⇒ 现在 = `open()` 补扫 + **每轮尾扫**。
   */
  private storyDrainInFlight: Promise<void> | undefined
  /** M10.1：真模型 provider 只造一次（它无状态，但构造要读 env） */
  private agreementProvider: ReturnType<typeof createOpenAiAgreementDraftProvider> | undefined
  private readonly reflectionFence = createLateWriteFence()
  private readonly goalReflectionQueue = createGoalReflectionQueue(this.reflectionFence)
  private readonly reflectionAbort = new AbortController()
  /** M8.5 WP8：语义 provider 惰性单例（只在 semantic 模式下构造） */
  private semanticProvider:
    | ReturnType<typeof createOpenAiAffectSemanticProvider>
    | undefined
  /*
   * ⚠️ **M9.5 / `L-M10-61` 的第二个成因（2026-09-30 修）**：
   *
   * ```text
   * `buildSemanticRecallProbe()` 原先**只把 probe 返回出去**，编码器 client 的引用被丢掉
   * ⇒ 停机时**没有人关它** ⇒ 它 spawn 的 worker **子进程**是活句柄
   * ⇒ 父进程的 event loop 永远不空 ⇒ **进程不退出**。
   *
   * 实测（有界探针，`semantic=true`）：
   *   ✅ 她的回复**已经产出**（`苏沐薇: 嗯。明天，交报告。`）· 停机也已开始
   *      （`SERVICE:EMBEDDING Stopping → Stopped (remainingItems=0)`）
   *   ❌ 但进程 `signal=SIGKILL @240s` —— **是"不退出"，不是"轮次挂住"**
   * ```
   * ⇒ 所以这里**留一个引用**，收尾链（`shutdown()`）在关库之前先关它（`AT3.1`/`AT3.2` 的同一条纪律：
   *   收尾唯一、且在关库之前）。
   */
  private semanticRecallEncoder: EncoderClient | undefined

  constructor(
    runtime: AgentRuntime,
    userName: string,
    options: {
      dryRun?: boolean
      kernel?: KernelHandle
      flags?: ReturnType<typeof readKernelFlags>
      /** 遥测镜像（默认 Noop：不开遥测时行为完全一致） */
      telemetry?: TelemetryMirror
      /** 本次运行 id（同一进程内应共用同一个；缺省时新建） */
      runtimeId?: RuntimeId
      /** WP6.1：入口模式（见字段说明；**必填**） */
      entryMode: ConversationEntryMode
      /**
       * post-Lv2 / ADR-109 `D02`：入口键（缺省由 `entryMode` 推 —— 见
       * `chatEntryKeyOfMode`；双入口模式**显式**传它，因为那时同一个
       * `--bridge` 进程里有两条入口，模式本身不再能区分）。
       */
      entryKey?: ChatEntryKey
      /**
       * post-Lv2 / ADR-109 `D01`/`D03`：**借用** owner 的共享消费者
       * （传了它就是"借用者"：不跑共享 open、close 什么都不做、四个 drain 转交）。
       */
      consumers?: SharedConsumerDelegate
      qqOwnerId?: string
      /** INC-01 WP3：收尾句柄（缺省由本会话自己按 runtime 建一个） */
      shutdown?: ShutdownHandle
      /**
       * Lv4.5 / `P1`：**语音交付账**（进程内；只有 `--bridge` 入口会传）。
       *
       * ⚠️ 不传 ⇒ 最近对话视图**逐字不变**（CLI / 干跑 / 各门都走这条路）。
       * ⚠️ 传了它也只改**视图**：生成的完整记录仍在 `conversation_events` 里。
       */
      voiceDelivery?: VoiceDeliveryLedger
    }
  ) {
    this.runtime = runtime
    this.shutdown = options.shutdown ?? runtimeShutdown ?? createRuntimeShutdown(runtime)
    this.userName = userName
    this.dryRun = options.dryRun ?? false
    this.kernel = options.kernel
    this.flags = options.flags ?? readKernelFlags()
    this.workflowSkills = this.flags.workflowSkillsEnabled ? loadWorkflowSkills() : []
    this.telemetry = options.telemetry
    this.runtimeId = options.runtimeId ?? newRuntimeId()
    this.entryMode = options.entryMode
    this.entryKey = options.entryKey ?? chatEntryKeyOfMode(options.entryMode)
    this.consumers = options.consumers
    this.qqOwnerId = options.qqOwnerId
    if ((this.entryMode === 'interactive_human_qq_private') !== (this.qqOwnerId !== undefined)) {
      throw new Error('QQ private entry requires its configured owner identity')
    }
    this.voiceDelivery = options.voiceDelivery
    // 角色状态按「角色 × 用户」维度存放，与插件使用同一套推导
    this.ids = resolveIds(userName)
    // 房间、world、实体都用确定性 id 推导：
    //   · 重启后仍落在同一个房间与同一段历史上（L1-M4 的连续性前提）
    //   · 避免重复启动时不断产生新的 agents/entities 行
    this.userEntityId = stringToUuid(`user-${userName}`)
    this.agentEntityId = stringToUuid(`agent-entity-${character.id ?? character.name}`)
    this.worldId = stringToUuid(`world-${character.id ?? character.name}`)
    this.roomId = stringToUuid(`room-dm-${userName}`)

    if (this.kernel) {
      this.gateway = this.buildGateway({ dryRun: this.dryRun })
    }
  }

  /**
   * 造一个网关。
   *
   * 抽成方法而不是内联在构造函数里，是因为 `--dump-prompt` 需要**第二个**
   * 只读网关（它要复用同一条编译路径，但绝不能写库）。
   * 两处共用同一段装配代码，避免"只读那份"和"真实那份"慢慢长歪。
   */
  /**
   * **M10 / `G-2`：目标域接线点。**
   *
   * ==========================================================================
   *  它接的是**那一条链**（`app/goal/turn.ts` 的 `runGoalTurn` 是唯一实现）
   * ==========================================================================
   * ```text
   * 有界输入 → 严格校验 → 放行口 → 写 → 投影
   * 四个端口：候选 / 写 / 放行口 / 兑现判定
   * ```
   *
   * ⚠️ **端口决定"接没接上"，`goalsEnabled` 决定"接上了要不要用"** ——
   *    两者缺一不可（只写其一正是 M4 那个惰性开关 D3 的成因）。
   *    关着时：`buildGateway` 里那个三元表达式**不调本函数** ⇒ 一个端口都不构造、
   *    不读清单、不构造 provider ⇒ 与接线前**行为逐字相同**（五个 trace 读数不变长）。
   *
   * ⚠️ **三处"由程序推、不由内容猜"**：
   *    · 来源资格：`sourceQualificationOf(originReadingOfEvent(那条已落库事件))`
   *    · 焦点顺序：`orderGoalsForFocus`（WP5 的确定性规则；网关**不重排**）
   *    · 兑现证据：`completion` 端口**只按 id 查真存储**（查不到就是查不到）
   */
  private buildGoalTurnPort(): NonNullable<CompileTurnInput['runGoalTurn']> {
    if (!this.kernel) throw new Error('buildGoalTurnPort 需要 kernel')
    const db = this.kernel.stores.db
    const characterId = this.kernel.characterId

    const registry = createFullDomainEventRegistry()
    const processed = createProcessedOperationStore(db)
    const lookup = createGoalStateLookup(db)
    const provider = createOpenAiGoalUnderstandingProvider()
    const runtime = createRealGoalUnderstandingRuntime()
    /* 撤销集：M10 v1 没有撤销入口（`D23` 的结构性选择）⇒ 恒为空集，但**口子在这里** */
    const withdrawn = new Set<string>()

    /* 让 `writer.commit` 拿到本轮放行口接受的**那批事件**（原样透传，不削形状） */
    let lastAccepted: readonly unknown[] = []
    const passThrough: GoalTurnPorts['passThrough'] = {
      validate: async (proposal: GoalProposal) => {
        const outcome = await validateGoalProposal(
          {
            registry,
            processed,
            state: {
              getGoal: (c: string, goalId: string) => lookup.getGoal(c as never, goalId as never),
              listGoals: (c: string) => lookup.listGoals(c as never),
            } as never,
            policy: { characterId, activeUserId: this.ids.userId },
          },
          proposal,
        )
        lastAccepted = outcome.acceptedEvents
        return {
          accepted: outcome.accepted,
          rejectedCodes: outcome.rejected.map((r) => r.code),
          acceptedEventTypes: outcome.acceptedEvents.map((e) => e.type),
          acceptedEvents: outcome.acceptedEvents,
        }
      },
    }

    const ports: GoalTurnPorts = {
      candidates: {
        readCandidates: async (c) => {
          const states = await listGoalStates(db, c as never)
          const built = candidatesFromGoals({
            goals: states.map((row) => row.goal),
            withdrawnEventIds: withdrawn,
            labelOf: (goal) => goal.statement,
          })
          /*
           * M10.1：**兑现的生产者**的输入 —— 只给**可见**目标（`built.goals` 已过遮蔽）
           * 的当前承诺。缺省不填 ⇒ `report_complete` 不会补 `COMMITMENT_FULFILLED`。
           */
          return {
            ...built,
            commitments: commitmentSummariesOf({ rows: states, visible: built.goals }),
          }
        },
      },
      writer: {
        /* 事件一个事务、投影行另一个事务（`L-M10-05`） */
        commit: async ({ characterId: c, now }) => {
          await applyAcceptedEvents(db, c as never, lastAccepted as never, [], now)
          const stored = (await domainEventsFor(db, c as never)).filter((event) =>
            (GOAL_DOMAIN_EVENT_TYPES as readonly string[]).includes(event.type),
          )
          await applyGoalRows(db, c as never, stored as never, now)
          return { eventsCommitted: lastAccepted.length, rowsCommitted: stored.length }
        },
      },
      passThrough,
      /* ⚠️ **生产实现**（不是 `m10-e2e-verify.ts` 那份伪造桩）：三个查表都接真存储 */
      completion: createProductionGoalCompletionPorts({ db, characterId }),
    }

    const prepare = async ({ currentInput, sourceEventId, lastAssistantEventId, lastAssistantText, recentConversation }: {
      readonly currentInput: string
      readonly sourceEventId: string
      readonly lastAssistantEventId?: string
      readonly lastAssistantText?: string
      readonly recentConversation?: import('./kernel/app/goal/understanding.ts').GoalUnderstandingInput['recentConversation']
    }): Promise<() => Promise<GoalTurnPortResult | undefined>> => {
      /*
       * 资格**由程序推**：读那条已落库的用户事件 ⇒ 它的受信读数 ⇒ 资格。
       * 读不出来（事件不存在 / 读不出受信读数）⇒ `UNCONFIRMED_ORIGIN` ⇒
       * 整轮判 `source_unusable`（**失败关闭**，不猜、不回落 ESTABLISHED）。
       */
      const sourceEvent =
        sourceEventId === '' ? undefined : await getConversationEvent(db, sourceEventId as never)
      const sourceQualification = sourceQualificationOf(
        sourceEvent === undefined ? undefined : originReadingOfEvent(sourceEvent),
      )
      /*
       * ⚠️ **env 门控的诊断**（缺省**完全静默**，与 `M95_ENCODER_DEBUG` 同形）。
       *
       * 为什么需要它：`source_unusable` 这个结论**丢掉了它的原因** ——
       * "id 是空的"、"事件查不到"、"读不出受信读数"三种情形**长得一模一样**，
       * 而它们要修的地方完全不同（`L-M10-68`）。这一行把三者分开。
       */
      if (process.env.M10_GOAL_DEBUG === '1') {
        logger.info(
          `[m10 goal] 资格：收到 sourceEventId=${sourceEventId === '' ? '**空**' : sourceEventId.slice(0, 40)}` +
            ` · 查到事件=${String(sourceEvent !== undefined)}` +
            ` · 读得出受信读数=${String(sourceEvent !== undefined && originReadingOfEvent(sourceEvent) !== undefined)}` +
            ` ⇒ 资格=${sourceQualification}`,
        )
      }

      const finish = await prepareGoalTurn(
        {
          characterId,
          currentInput,
          sourceEventId,
          sourceQualification,
          withdrawnEventIds: withdrawn,
          now: Date.now(),
          provider,
          runtime,
          ...(recentConversation === undefined ? {} : { recentConversation }),
          /* M10.1 / `L-M10.1-05` 第 ③ 跳：原样转发（缺一个就都不带 ⇒ 不提供提议侧证据） */
          ...(lastAssistantEventId === undefined || lastAssistantText === undefined
            ? {}
            : { lastAssistantEventId, lastAssistantText }),
        },
        ports,
      )

      return async () => {
        const turn = await finish()
        /*
         * 状态块：候选**已经排好序**（排序是 WP5 的职责）—— 网关**不重排**。
         * `rowKey` 是展示用的身份（`goal:<goalId>`），**不含正文**。
         */
        const states = await listGoalStates(db, characterId)
        const ordered = orderGoalsForFocus(states.map((row) => row.goal))
        return {
          turn,
          contextState: {
            ordered: ordered.ordered.map((goal) => ({
              goal,
              rowKey: `goal:${String(goal.goalId)}`,
            })),
            withdrawnEventIds: withdrawn,
          },
        }
      }
    }
    return Object.assign(async (info: Parameters<typeof prepare>[0]) => (await prepare(info))(), { prepare })
  }

  private buildGateway(options: { dryRun: boolean }): TurnGateway {
    if (!this.kernel) throw new Error('buildGateway 需要 kernel')

    /*
     * 会话 id 由 (角色, 用户, **入口**) 确定性推导：同一个「她 × 你 × 这条入口」
     * 永远是同一段近期历史。
     * 刻意不用用户名裸拼（ID 里不允许冒号，且改名会换一个人——与既有规矩一致）。
     *
     * ⚠️ post-Lv2 / ADR-109 `D02`：入口分量**只在开关打开时**加进去。
     *    关着（代码缺省）⇒ 三条入口都得到今天那个 id，行为与接线前逐字相同。
     *    打开 ⇒ CLI 仍然是今天那个 id（逐字不变），QQ 与皮套各得**新的**近期会话
     *    （长期记忆与认知不受影响）—— 后果已登记在 ADR-109 §2。
     */
    const conversationId = conversationIdForEntry({
      slug: this.kernel.definition.slug,
      userHash8: stringToUuid(`user-${this.userName}`).slice(0, 8),
      entry: this.entryKey,
      entryScoped: this.flags.entryScopedConversations,
    })
    const recorder = new ConversationRecorder({
      db: this.kernel.stores.db,
      characterId: this.kernel.characterId,
      conversationId,
      dryRun: options.dryRun,
      userName: this.userName,
      characterName: character.name,
      transport: CHAT_ENTRY_SCOPES[this.entryKey].transport,
      /*
       * WP6.1（K-28）：**生产 ingress 的受信归因接线点**。
       *
       * 这一行就是 K-28 的闭合：在这之前，全 `src/` 里没有任何生产代码构造过
       * 受信归因 ⇒ 生产里的对话行一律是 legacy（`attribution_origin` 为 NULL），
       * 读到的都是"由 actor_type 推导出来的"值（D01 的形状）。
       *
       * 入口模式是本进程的**真实事实**（有没有位置参数），角色由该模式决定 ——
       * 调用方没有、也不该有任何字段能选它。
       */
      attribution: conversationAttributionForEntryMode(this.entryMode).producers,
      // M3：领域身份（已解析好）与 transport 身份（平台侧是谁）都给。
      //   userId  → 登记 user_identities（"我们这边是谁"）
      //   userRef → 登记 external → internal 映射（"这个平台的这个人是谁"）
      // 二者分开是计划书第 25 节的要求；混用会算出一个新的人（实测踩到过）。
      userId: this.ids.userId,
      userRef: this.qqOwnerId ?? this.userName,
      deriveUserId: ({ transport, externalId }) => stringToUuid(`user-${transport}-${externalId}`),
    })
    return new TurnGateway({
      ...(this.flags.actionEnabled && this.flags.taskAutonomyEnabled && this.flags.toolDecisionMode === 'role'
        ? { desktopCapabilities: {
            inspect: this.flags.desktopInspectEnabled,
            operate: this.flags.desktopOperateEnabled,
            connected: verifyDesktopRuntimeSync().ok,
          } } : {}),
      ...(this.flags.workflowSkillsEnabled ? { workflowSkills: this.workflowSkills } : {}),
      kernel: this.kernel,
      definition: this.kernel.definition,
      // M3 WP3：身份来自快照（一轮一次），网关自己不读 Seed
      identity: this.kernel.identitySnapshot,
      recorder,
      conversationSequence: () => this.conversationSequence,
      modelProfile: nativeVoiceReplyPortFor(this.entryKey)?.model ?? MODEL_ID,
      recentLimit: CONVERSATION_LENGTH,
      slowPathEnabled: this.flags.slowPathEnabled,
      telemetry: this.telemetry,
      dryRun: options.dryRun,
      runtimeId: this.runtimeId,
      userId: this.ids.userId,
      /*
       * M5 WP6：召回接线点。
       *
       * ⚠️ **两个分支都要**：召回是**只读**的，因此只读网关（`--dump-prompt`）
       * 也应当注入它 —— 那是排查"她这一轮想起了什么"最常用的入口。
       * 写路径（memoryWriter / actionWriter）相反：它们只在不干跑时注入。
       *
       * 端口决定"接没接上"，`recallEnabled` 决定"接上了要不要用" ——
       * 两者缺一不可（只写其一正是 M4 那个惰性开关 D3 的成因）。
       */
      recall: this.buildRecallTurnPort(),
      /*
       * M6 / ADR-050：会话摘要接线点。
       *
       * 与召回一样**两个分支都注入**（只读）。缺省额度 0 ⇒ 行为零变化；
       * 开启 = 把 `rollupTokens` 配成非 0（属独立裁定，见 `buildRollupTurnPort` 的说明）。
       */
      rollup: this.buildRollupTurnPort(),
      recallEnabled: this.flags.recallEnabled,
      /*
       * ==========================================================================
       *  M9.5 / WP6（ADR-074 的 D25）—— **这是"装了要不要用"的第二半**
       * ==========================================================================
       * ```text
       * 与 `buildRecallTurnPort` 里"装不装探针"配套：**两处缺一不可**。
       * flag **off**（缺省）⇒ 这个字段**不出现** ⇒ 请求不带策略版本 ⇒ 现状逐字不变。
       * flag **on**       ⇒ 请求带 `hybrid-relevance@1` ⇒ 候选先按相关性排序再截断。
       * ```
       * ⚠️ 只选策略版本而不装探针**不会**伪装成"语义已启用"：探针缺失时
       *    store 会报 `not_indexed`，能力报告里 `semantic` 仍在 `unavailable`。
       */
      ...(this.flags.memorySemanticRecallEnabled ? { recallPolicyVersion: 'hybrid-relevance@1' as const } : {}),
      /*
       * M9.5 / WP8：**模式**决定"算不算"与"能不能影响排序"两件事。
       *  • `shadow`（缺省）⇒ 算分并记下对照读数，而**实际排序仍走旧路径**
       *    ⇒ 真实 prompt/回复输入不变（S47）；这是 §12 WP12 的"先观察"阶段。
       *  • `on`  ⇒ 语义分数参与排序。
       *  • `off` ⇒ 连探针都不建（`buildRecallTurnPort` 那半边也不会构造它）。
       */
      ...(this.flags.memorySemanticOnlyEnabled ? { recallSemanticMode: 'on' as const } : this.flags.memorySemanticRecallEnabled ? { recallSemanticMode: this.flags.memorySemanticMode } : {}),
      /*
       * M5.5（ADR-045 `D-16`）：外部证据的**独立额度**。
       *
       * 关闭时额度是 **0** —— 那不是"忘了填"，而是"今天不注入外部证据"这个
       * 真实配置。`ContextBudget` 的缺省值本来就是 0，这里只在启用时才改它。
       */
      recallBudget: {
        ...DEFAULT_CONTEXT_BUDGET,
        ...(this.flags.webSearchEnabled
          ? { externalEvidenceTokens: this.flags.webSearchEvidenceTokens }
          : {}),
        /*
         * M6 / ADR-050：摘要额度来自配置（缺省 0 = 不激活）。
         * ⚠️ 与 `externalEvidenceTokens` 同一形状，但**不**挂在搜索总开关下 ——
         *    摘要是独立能力，它的通电只看 `CHARACTER_ROLLUP_TOKENS`。
         */
        rollupTokens: this.flags.rollupTokens,
        /*
         * M11 / ADR-085 `D34`：**行为策略**的独立额度。
         *
         * ⚠️ 与 `rollupTokens` 同一形状（独立额度，**不**挂在别的总开关下），
         *    而且这一行是 `D34` 的落点：`adaptiveSelfTokens` **必须真的**被装配层传入，
         *    否则 `adaptive-self` 块在生产里永远不可达 ——
         *    先例就是 M10 的 `goalTokens`（`L-M11-10`：从未接线，而判定表写着 ACTIVATED）。
         *    静态回归锁：`m11:context:verify` 断言本文件里出现 `adaptiveSelfTokens`。
         */
        adaptiveSelfTokens: this.flags.adaptiveSelfTokens,
        /*
         * M10.1 / ADR-086 D09：**销账 L-M11-10** —— 目标状态块的额度以前从未被装配层传过，
         * 于是 goal-state 块在生产里**永远被 0 额度丢掉**（网关其实一直在读它）。
         * 这里与 `adaptiveSelfTokens` 同一形状：flag → recallBudget → 那一个 ContextBudget，
         * 静态回归锁断言本文件里真的出现这两个名字。
         */
        goalTokens: this.flags.goalTokens,
        commitmentTokens: this.flags.commitmentTokens,
        /*
         * 实用能力加装：**当轮内容**（计算 / 文档 / 网页正文 / OCR）的独立额度。
         *
         * ⚠️ 这一行是"接线必须真的发生"的落点（先例 `L-M11-10`：
         *    `goalTokens` 就是因为装配层从未赋值而在生产里永远不可达）。
         *    flag 缺省 0 ⇒ 额度 0 ⇒ section 构造上不会出现；开关打开时由
         *    `CHARACTER_TURN_CONTENT_TOKENS` 供电（隔离验收用 2000）。
         */
        turnContentTokens: this.flags.turnContentTokens,
      },
      /*
       * M10.1 / ADR-086 `D08`：**约定与结清**事实块的只读端口（WP4c 的接线点）。
       *
       * ⚠️ 与 `goalTokens` 那次同一条纪律：**光有额度和渲染器不够**，必须有人把端口接上 ——
       *    否则那一块在生产里**永远不可达**（`L-M11-10` 的形状）。
       * 只读：读的是投影行，不做任何写。
       */
      commitmentFactRows: async () =>
        commitmentFactRowsOf(
          await listGoalStates(this.kernel!.stores.db, this.kernel!.characterId)
        ),
      /*
       * M4：显式记忆的接线点。
       *
       * ⚠️ 这两行是本次修复的核心。
       *
       * 在这之前，`createExplicitMemoryService` 在全仓库**没有任何调用点**，
       * 而 `memoryExplicitEnabled` 读了 env、进了日志、从未 gate 任何东西。
       * 实测后果：用户说"记住，……"，她回答"记住了"，而库里一条都没有。
       *
       * 只读网关（`--dump-prompt`）**不注入** —— 它的契约是"只有读"，
       * 而显式记忆是一条写路径。
       */
      ...(options.dryRun
        ? {}
        : {
            memoryWriter: this.buildMemoryWriter(),
            memoryExplicitEnabled: this.flags.memoryPostTurnModelEnabled || this.flags.memoryExplicitEnabled,
            /*
             * M4.5：动作的接线点（ADR-030）。
             *
             * ⚠️ 这两行与上面两行必须**同时存在**：
             *     端口决定"接没接上"，开关决定"接上了要不要用"。
             *     只写其一正是 M4 那个缺陷（D3）的成因。
             *
             * 只读网关（`--dump-prompt`）**不注入** —— 它的契约是"只有读"
             * （`buildGateway({dryRun:true})` 的分支在这里被排除），
             * 而动作是一条真的会改世界的写路径。
             */
            actionWriter: this.buildActionWriter(),
            actionEnabled: this.flags.actionEnabled,
          }),
    })
  }

  /**
   * M5 WP6：把检索适配器 → 召回服务 → 轮次端口装配起来。
   *
   * 三个决定，每个都对应一条 M5 的不变量：
   *   · **只读**：整条链只调 `MemoryStorePort` 的读方法（`retrieve` 不写表）
   *   · **完整性来自 M5-PRE 的探针**：`integrity` 是 `memoryIntegrityProblems`
   *     本身，不是这里另写一套"证据还在不在"
   *   · **预算来自配置**（`DEFAULT_CONTEXT_BUDGET`）：计划书禁止靠
   *     "提高模型窗口"绕过上下文预算
   */
  private buildRecallTurnPort(): RecallTurnPort {
    if (!this.kernel) throw new Error('buildRecallTurnPort 需要 kernel')
    const db = this.kernel.stores.db
    const store = createNativeMemoryStore(db)
    /*
     * ==========================================================================
     *  M9.5 / WP6（ADR-074 的 D25）—— 语义探针的**生产装配点**
     * ==========================================================================
     * ```text
     * flag **off**（缺省）⇒ 这一段完全是惰性的：不读清单、不构造编码器、不构造探针，
     *   检索店收到的 `semanticProbe` **不存在** ⇒ 与接线前的行为逐字相同
     *   （`createEncoderClient` 本身也只在第一次 `encode` 时才 spawn 子进程）。
     * flag **on** ⇒ 装探针；配合网关选项里的 `recallPolicyVersion` 才算真的开启。
     *   ★ 两处缺一不可：只装探针不选策略版本 ⇒ 语义分数根本不被调用；
     *     只选策略版本不装探针 ⇒ 排序换了口径却没有任何语义分数（探针缺失）
     *     —— 后者会被判成 `not_indexed`，**不会**伪装成"语义已启用"。
     * ```
     */
    const semanticProbe = this.flags.memorySemanticRecallEnabled || this.flags.memorySemanticOnlyEnabled ? this.buildSemanticRecallProbe(db) : null
    const retrievalPort = createMemoryRetrievalStore({
      store,
      ...(this.flags.memorySemanticOnlyEnabled ? { semanticOnly: true } : {}),
      integrity: (owner) => memoryIntegrityProblems(db, owner),
      // Phase 4b：根证据受信读数（**必填** —— 忘记接线会让每条事实都被标成"来源未确立"）
      rootReadings: (ids) => rootReadingsByMemory(db, ids),
      ...(semanticProbe !== null ? { semanticProbe } : {}),
    })
    const service = createMemoryRecallService({ port: retrievalPort })
    return createRecallTurnPort({
      ...(this.flags.memorySemanticOnlyEnabled ? { semanticOnly: true } : {}),
      service,
      budget: DEFAULT_CONTEXT_BUDGET,
      injectionLimit: 3,
      now: () => Date.now(),
    })
  }

  /**
   * M9.5 / WP6：构造语义探针（**只在 flag 开启时被调用**）。
   *
   * ```text
   * 它做的事：读**仓库内**的模型清单（失败关闭，不自动下载）
   *           → 构造本地编码器的子进程客户端（**惰性**：构造时不 spawn、不加载模型）
   *           → 用派生索引 + 已发布的代做精确检索
   * ```
   *
   * ⚠️ 失败关闭：清单缺失 / 资产与清单不符时**抛错**而不是静默降级 ——
   *    因为这是**显式开启**的路径，静默降级会让"我打开了但没生效"无从分辨。
   *    运行时的"半路失败"（模型缺失 / 超时 / 没有已发布代）仍由探针**具名**返回，
   *    如实降级成 `degraded_lexical`（计划 §9.3）。
   */
  private buildSemanticRecallProbe(db: RawDb): MemorySemanticProbe {
    /*
     * ⚠️ `LAB_MODEL_ROOT` / `SEMANTIC_RECALL_DEADLINE_MS` / `SEMANTIC_RECALL_READY_TIMEOUT_MS`
     * 已**提到模块级一处**（M9.5 / WP4 · W1 前置）—— 维护的 `runOnce` 也要用它们，
     * 两处各写一份必然漂开。这里**不再**声明。
     */
    /*
     * ⚠️ 清单**只在一处加载 + 校验**（M9.5 / WP4 · W1 前置）：探针与维护共用它，
     * 两处各 load 一遍会各自抛、各自漂。校验不合法仍**抛**（与原来同一个失败关闭行为）。
     */
    const manifest = embeddingManifestShared()
    /*
     * ⚠️ **资产根必须带 `${manifest.modelId}`**（M10 WP11 轮次的 live 档跑出来的真缺陷）。
     *
     * 编码方（`encoder-worker-entry.ts`）用的是
     * `verifyEmbeddingAssets(`${LAB_MODEL_ROOT}/${manifest.modelId}`, manifest)`，
     * 下载脚本（`m9.5-a3-download.ts`）也逐字写着"**必须是嵌套布局**
     * `${LAB}/models/${modelId}`：worker 按…"。
     * 而这里**漏了 `modelId` 那一段** ⇒ 它在找 `models/config.json`，
     * 而真实文件在 `models/<modelId>/config.json` ⇒ **7 个资产全报 missing**。
     *
     * 后果（实测）：`.env` 开着语义召回 ⇒ **启动即抛**，`pnpm chat` 与
     * `m4.5:smoke:live` 的每一轮 CLI 都以 `exit=1` 退出（M10 的 `L-M10-58`）。
     * ⇒ 这一行是**与编码方对齐**的修复；`localModelPath` 仍传父目录（与 worker 一致）。
     */
    const assets = verifyEmbeddingAssets(
      join(process.cwd(), LAB_MODEL_ROOT, manifest.modelId),
      manifest,
    )
    if (!assets.ok) {
      throw new Error(
        `语义召回已开启，但本机模型资产与清单不符（**不**自动下载）：` +
          `verified=${String(assets.verified)}/${String(assets.total)} ` +
          `missing=${assets.missing.join(',')} hash=${assets.hashMismatch.join(',')}`
      )
    }
    /*
     * ⚠️ **走装配层单例**（M9.5 / WP4 · W1 前置）：`createEncoderClient` 会 spawn 一个 worker
     * （惰性 RSS ≈ 497.6 MB）⇒ **只能有一处构造**，否则维护与探针会各持一个 ≈ 双份内存。
     * `semanticEncoderShared()` 同时负责把 `semanticEncoderForExit` 挂上（否则停机吊住 event loop）。
     */
    const encoder = semanticEncoderShared({
      manifest,
      labModelRoot: LAB_MODEL_ROOT,
      deadlineMs: SEMANTIC_RECALL_DEADLINE_MS,
      readyTimeoutMs: SEMANTIC_RECALL_READY_TIMEOUT_MS,
    })
    /*
     * ⚠️ **留下引用**（`L-M10-61` 的第二个成因）：不留的话，停机时没人关它
     * ⇒ 它 spawn 的 worker 子进程吊住 event loop ⇒ **进程不退出**（实测 240s 仍在）。
     * 见字段声明处那段说明。
     */
    this.semanticRecallEncoder = encoder
    return createSemanticProbe({ db, manifest, encoder })
  }

  /**
   * M6 / ADR-050：把**会话摘要的来源读取面**装配成轮次级端口。
   *
   * ============================================================================
   *  这一行**不改变今天的任何行为**（这是刻意的）
   * ============================================================================
   * `recallBudget` 走 `DEFAULT_CONTEXT_BUDGET`，而它的 `rollupTokens` 缺省是 **0**
   * ⇒ `rollupForTurn()` 立刻返回 `undefined` ⇒ **不读库、不产 section、不写 trace**。
   *
   * 那为什么还要接？因为 `DR-11` 把"开/关"定义成**额度是否为 0**，而不是一个开关：
   * 若不在这里把端口接上，"改额度"这条唯一的开启路径就不存在，
   * 于是任何将来的激活都不得不改代码 —— 那正好是 DR-11 要避免的形状
   * （先例：ADR-045 的 `externalEvidenceTokens` 同样是"先接线、缺省 0、激活另裁"）。
   *
   * ⚠️ 与召回同一条纪律：它是**只读**的，因此只读网关（`--dump-prompt`）也注入它。
   */
  private buildRollupTurnPort(): RollupTurnPort {
    if (!this.kernel) throw new Error('buildRollupTurnPort 需要 kernel')
    return createRollupTurnPort({ reader: createRollupSourceReader(this.kernel.stores.db) })
  }

  /**
   * M4.5：把 Action Gateway 装配成**轮次级端口**。
   *
   * ============================================================================
   *  四个决定都写在这里，而且只有这里
   * ============================================================================
   *   · **装哪些能力** —— 登记表（未登记 = 不存在，ADR-031）
   *   · **授予哪些权限** —— `DEFAULT_GRANTED_PERMISSIONS`（显式，不自动）
   *   · **沙箱根在哪** —— `ACTION_SANDBOX_ROOT`（适配器不自己推导）
   *   · **风险上限** —— `CHARACTER_ACTION_MAX_RISK`（缺省 R1）
   *
   * 目标解析也在这里组装：`resolveActionTarget` 需要"沙箱里有什么"，
   * 而那是 IO —— kernel 侧的 Gateway 只接收一个函数，不自己读盘。
   */
  private buildActionWriter(): ActionTurnPort {
    /*
     * 登记表**只建一次**，并同时交给端口与 Gateway。
     *
     * 两处各建一份也"能用"（定义相同），但那会让"能力存在"这件事
     * 有两个来源 —— 而 ADR-031 的全部意义就是它只有一个。
     *
     * M5.5（ADR-045 `D-11`/`D-12`）：外部证据能力是**追加**，不是改 M4.5 的默认集
     *   · 追加 —— `createDefaultCapabilityDefinitions()` 仍然只返回那三个
     *     （M4.5 的既有判据锁着它，不许动）
     *   · **恒登记** —— 于是 flag 关闭时用户说"搜一下"得到的是一条可审计的
     *     `permission_denied`（模型据此如实说"联网没启用"），而不是"装作没听懂"
     */
    const registry = createCapabilityRegistry([
      ...createDefaultCapabilityDefinitions(),
      ...createLearningCapabilityDefinitions(),
      ...createExternalEvidenceCapabilityDefinitions(),
      /* 实用能力加装：四项能力**恒登记**（关闭时用户显式要求 ⇒ 可审计的 permission_denied） */
      ...createUtilityCapabilityDefinitions(),
      /*
       * 第二批（2026-10-04）：本机文件域 + 四项业务能力，同样**恒登记**。
       * ⚠️ 恒登记 = 关闭时用户显式要求得到一条**可审计的 `permission_denied`**
       *    （模型据此如实说"没启用"），而不是"装作没听懂"（先例 ADR-045 `D-12`）。
       * ⚠️ 权限与适配器只在开关打开时存在 ⇒ 关闭时**构造上**没有执行器、没有出站。
       */
      ...createLocalFileCapabilityDefinitions(),
      ...createWeatherCapabilityDefinitions(),
      ...createOfficeCapabilityDefinitions(),
      ...createNewsCapabilityDefinitions(),
      ...createBrowserCapabilityDefinitions(),
      /* ADR-106：桌面查看 / 操作两个能力，同样**恒登记**、权限条件授予 */
      ...createDesktopCapabilityDefinitions(),
      /*
       * post-Lv2 / ADR-110 `D05`：QQ 主动联系的目标发送能力，同样**恒登记**、权限条件授予。
       * ⚠️ 恒登记 ≠ 可达：它不在 `TASK_CAPABILITY_IDS` 里，所以工具目录与任务执行环
       *    都不会规划它；真实路径只有主动调度器那一条（WP4/WP5 的装配）。
       */
      ...createQqProactiveCapabilityDefinitions(),
      ...createLocalReminderCapabilities(),
    ])
    /*
     * ==========================================================================
     *  M5.5.1 WP4：**共同否决权**的接线（ADR-049 §11 R2）
     * ==========================================================================
     * §11.2 的六步在这里落成三件事：
     *   ① 词形检测器只**产生候选**（不再直接产生"要执行"的意图）
     *   ② 判定器给出合法 `search` 才继续；非 search / 失败 / 校验失败 ⇒ 不产生请求
     *   ③ 出站 query **逐字取自判定通过的那一段**（不再用旧的"去掉触发词"抽法 ⇒ 销 L-M55-17）
     *
     * ⚠️ 模式非法（`webSearchMode === undefined`）⇒ 判定器根本不存在 ⇒
     *    `resolveSearchNeed` 以 `judge_absent` 失败关闭，**绝不**退回词形直通。
     */
    const searchResolution = this.buildSearchResolver()
    /*
     * 第二批：Gateway **只建一次**并同时交给端口与任务执行环 ——
     * 两处必须是同一个对象（同一个目标解析、同一个账本、同一套权限），
     * 否则"任务能碰什么"就成了第二个权威。
     */
    const { gateway, grantedPermissions: actionGrantedPermissions } = this.buildActionGateway(registry)
    /*
     * Lv4.5 / `P3`（选项 B）：把**这一个**网关留给"边听边查"用。
     *
     * ==========================================================================
     *  为什么是"记下来"而不是"再建一个"
     * ==========================================================================
     * 再建一个网关意味着**第二份登记表**（能力集合、权限、目标解析、账本），
     * 而 ADR-031/032 的全部意义就是它只有一个 —— 两份迟早会漂移（一份放行、
     * 一份拦下）。所以提前检索用的**必须**是这里建好的同一个实例。
     *
     * ⚠️ 它在**会话打开时**建好（`buildGateway()` 会调到这里）⇒ 桥开始跑的时候
     *    它一定已经在了；万一不在，`prepareLookup` 会如实报"动作运行时缺席"
     *    而不是自己造一个。
     */
    this.actionGatewayRef = gateway
    this.actionRegistryRef = registry
    /*
     * 第二批：**有限任务执行环**的接线。
     *
     * ⚠️ 载荷暂存必须与网关适配器用的是**同一个实例**。
     *
     * ========================================================================
     *  一条真模型 live 逼出来的**生产缺陷**（2026-10-04）
     * ========================================================================
     * 第一版在这里新建了一个 `taskStaging` 交给任务环，而 `buildActionGateway()`
     * 里的写入/办公适配器拿的是 `this.payloadStaging` —— **两个实例**。
     * 于是：计划把正文放进 A，适配器去 B 里按引用取 ⇒ 取不到 ⇒
     * 每一次 `office.generate` 都是 `validation_failed / spec_not_staged`。
     *
     * ⚠️ 离线 28 组**一个断言都没碰到**它：验收床（`assembly.ts`）当时给两处传的是
     *    同一个 `staging`，与生产**不同形**。⇒ 修完这里之后，验收床也改成
     *    "两处同一个实例"，否则这扇门永远照不到这处缺陷。
     */
    const taskPort: NonNullable<ActionTurnPortOptions['task']> | undefined =
      this.flags.taskAutonomyEnabled === true
        ? {
            authorizations: createTaskAuthorizationRegistry({
              budget: {
                maxActions: this.flags.taskMaxActions,
                maxPlans: this.flags.taskMaxPlans,
                deadlineMs: this.flags.taskDeadlineMs,
              },
            }),
            planner: createOpenAiTaskPlanner({ registry }),
            /* ⚠️ **同一个实例**（见上面那条生产缺陷的注释）：不是第二个暂存 */
            staging: this.payloadStaging,
            /*
             * 本任务允许的能力集合：**由装配层按开关算出**。
             * ⚠️ 它只列"这次真的启用了"的能力 —— 关掉的能力连候选都不是，
             *    于是模型给出的越权步骤会在 `parseTaskPlan` 里被整条丢弃。
             * ⚠️ WP1：`role` 档下它多**追加**旧沙箱三件（计划书 §3 的能力矩阵逐字：
             *    "旧沙箱读/写与 echo 纳入完整工具清单"）。`rules` 档逐字不变。
             */
            capabilitiesFor: (): readonly string[] => this.toolCapabilitiesForTurn(),
            /*
             * 任务级风险额度：只有浏览器开关打开时才抬到 **R2**。
             * 计划书 §4："不为运行浏览器把所有聊天的风险上限统一升为 R2/R3"——
             * 组装层的 `CHARACTER_ACTION_MAX_RISK` 因此**一个字都不改**。
             */
            riskLevelFor: (): RiskLevel =>
              this.flags.browserFullTools && this.flags.browserEnabled
                ? /*
                   * ★ 2026-10-09 / ADR-125：全工具档把任务额度抬到 **R3**。
                   *   `browser.mcp` 声明 destructive/R3（"什么都可能做"的入口没有
                   *   诚实的更低声明），而额度是**任务级**的 ⇒ 不抬它就到不了。
                   *   ⚠️ 这是本次授权里**唯一**一处放宽风险额度的改动，且只在
                   *      `CHARACTER_BROWSER_FULL_TOOLS=true` 时生效；全局
                   *      `CHARACTER_ACTION_MAX_RISK` 仍然一个字都不改（缺省 R1）。
                   */
                  'R3'
                : this.flags.browserEnabled || this.flags.desktopOperateEnabled
                  ? 'R2'
                  : this.flags.actionMaxRiskLevel,
            resolveTarget: (input) => gateway.resolveTargetFor(input),
            /*
             * WP2 / ADR-104 `D14`：**重新规划**时给规划器的程序事实与内容额度。
             *
             * ⚠️ 只在 `role` 档接线 —— `rules` 档的规划器输入逐字段不变。
             * ⚠️ 内容额度**复用既有的 `turnContentTokens`**（上限 1200）而不是新开一个额度开关：
             *    计划书 §7 逐字要求"工具结果增加输入 token；决策次数、动作次数、总时限与
             *    搜索限额**共享**本轮/原任务预算，不能借新环规避现有限制"。
             *    ⇒ 规划器看到的是**同一批内容**的一个有界切片（同一套选择器）。
             */
            ...(this.flags.toolDecisionMode === 'role'
              ? {
                  replanContext: {
                    knownDirectories: (): readonly string[] => knownDirectoryLines,
                    contentTokens: Math.min(
                      this.flags.turnContentTokens,
                      TOOL_PLANNER_CONTENT_CAP_TOKENS
                    ),
                    /*
                     * WP3：外部证据的**独立**额度（搜索命中行），复用既有的证据额度开关，
                     * 上限比 prompt 那一份更低（规划器只需要"哪几条、URL 是什么"）。
                     * ⚠️ 缺省 `webSearchEvidenceTokens` 是 800，而搜索未启用时额度没有意义 ——
                     *    两个条件都在（搜索开着 + 额度 > 0）才会真的带上证据。
                     */
                    evidenceTokens:
                      this.flags.webSearchEnabled && this.flags.webSearchMode !== undefined
                        ? Math.min(
                            this.flags.webSearchEvidenceTokens,
                            TOOL_PLANNER_EVIDENCE_CAP_TOKENS
                          )
                        : 0,
                  },
                }
              : {}),
            onTaskOutcome: (outcome) => {
              logger.info(`[task] 任务执行读数：${describeTaskRun(outcome)}`)
            },
          }
        : undefined

    return createActionTurnPort({
      gateway,
      /*
       * 检测器**链式**（不是替换）：M4.5 的先，M5.5 的后。
       * 顺序的理由是**代价不对称**：文件读写是本机可回滚的，联网搜索是出站不可撤回的
       * ⇒ 混合指令（"读一下 a.txt 顺便搜一下"）只做本地那一件。
       */
      detector: chainIntentDetectors([
        /*
         * 第二批：**本机文件域排在 M4.5 之前**（顺序不是口味，是正确性）。
         *
         * ```text
         * M4.5 的 PATH_TOKEN 以扩展名结尾，而 `:` 不在它的字符类里
         * ⇒ 对 `C:\x\a.txt` 它会从 `\` 开始匹配，得到一个**丢掉了盘符**的片段，
         *   然后报一条"越出沙箱范围"的 permission_denied。
         * ```
         * 那是计划书 §2.1 第 2 点禁止的**说错域**。把本机域放在前面之后：
         * ```text
         * 带盘符 / UNC 的路径 ⇒ 归本机文件域（措辞是本机域那一套）
         * 沙箱相对路径        ⇒ 本检测器不认，落到下面的 M4.5（行为逐字不变）
         * ```
         * ⚠️ 本检测器**不受开关门控**：关掉本机文件域时，用户得到的是一条
         *    **可审计的** `permission_denied`（措辞仍是本机域的），而不是
         *    "越出沙箱范围"或"装作没听懂"（见 `local-file-intent.ts` 的文件头）。
         * ⚠️ 反过来的做法（在 M4.5 里先挖掉绝对路径）已实测会把
         *    `m4.5:nl-action:verify` 的 `NL-05` 三条断言打红 —— **链序才是解法**。
         * ⚠️ 这里**没有** write 检测器：写入只由任务执行环产生。
         */
        createLocalFileIntentDetector(),
        /*
         * 第二批：**天气与资讯也排在 M4.5 之前**。
         *
         * ```text
         * M4.5 的 PATH_TOKEN 认得 `.xml` / `.json` / `.html` / `.txt` …
         * ⇒ 一句"读一下这个订阅源 https://x/feed.xml"会被它抽成一条**沙箱路径**
         *   （`//x/feed.xml`）并报"越出沙箱范围" —— 而用户要的是读订阅源。
         * ```
         * 这一条**不是**本批引入的：即使没有本批，那句也会撞上 M4.5 的沙箱判据。
         * 本批只是让**更具体的判据**（显式订阅源词 + feed URL / 显式天气词 + 城市）
         * 先说话 —— 与"本机文件域排在前面"同一条理由：**具体压过泛化**。
         * ⚠️ 资讯**只认订阅来源词**（RSS/Atom/订阅源/feed）—— 只说"最新消息"
         *    不触发它，那归 M5.5 的联网搜索（计划书 §3.3 末段）。
         */
        createWeatherIntentDetector({
          weather: this.flags.weatherEnabled,
          news: this.flags.newsReadEnabled,
        }),
        createActionIntentDetector(),
        /*
         * 实用能力加装：显式资源请求（本地文档 / 图片 / 显式算式 / 显式 HTTPS URL）
         * 排在**搜索之前** —— 与"M4.5 排在 M5.5 之前"同一条代价不对称：
         * 用户显式指定的东西比"要不要搜"更确定，而搜索是出站不可撤回的那一侧。
         * ⚠️ 关掉的能力在检测层就**不产生请求**（见 `utility-intent.ts` 文件头第 3 条）。
         */
        createUtilityIntentDetector({
          math: this.flags.mathCalculateEnabled,
          document: this.flags.documentReadEnabled,
          web: this.flags.webReadEnabled,
          ocr: this.flags.imageOcrEnabled,
        }),
        createExternalEvidenceIntentDetector(),
      ]),
      registry,
      /*
       * WP5：把"动作请求是从哪个受信 ingress 进来的"显式登记下来。
       * Gateway 侧据此把 initiator 的受信证据接到每次事件的归因快照上。
       */
      attribution: { adapterId: 'action-turn' },
      ...(searchResolution !== undefined ? { resolveIntent: searchResolution } : {}),
      ...(taskPort !== undefined ? { task: taskPort } : {}),
      /*
       * ========================================================================
       *  WP1 / ADR-104：**角色自行选择工具**（只有 role 档才配这个端口）
       * ========================================================================
       * ⚠️ 缺省 `rules` ⇒ 这个字段**不出现** ⇒ `action-turn` 走 legacy 路径，
       *    关键词检测器逐字段起作用（今天的全部行为）。
       * ⚠️ 目录文本由**程序**生成（登记表 + 闭集参数 + 四态），模型改不了它；
       *    `isCapabilityEnabled` 直接复用 `isTaskCapabilityEnabled` ——
       *    "哪一项能用"只有一处判据（与任务授权同源）。
       */
      ...(this.flags.toolDecisionMode === 'role'
        ? {
            toolDecision: {
              port: createOpenAiToolDecisionPort({ timeoutMs: this.flags.toolDecisionTimeoutMs }),
              catalog: renderToolCatalogForModel(
                buildToolCatalog(registry, {
                  isCapabilityEnabled: (capability) =>
                    this.toolCapabilitiesForTurn().includes(capability),
                  grantedPermissions: actionGrantedPermissions,
                  /*
                   * ADR-106：桌面运行时的**如实读数**（同步、只读、不起进程）。
                   * ⚠️ 不猜成可用：venv 不在 / 版本不对 ⇒ `disconnected`，目录里那一行
                   *    会写"未连接"（先例：浏览器那条"不能把安装/连接状态猜成可用"）。
                   */
                  connectionStates: (() => {
                    const runtime = verifyDesktopRuntimeSync()
                    const state: ToolConnectionState = runtime.ok ? 'connected' : 'disconnected'
                    return { [DESKTOP_INSPECT]: state, [DESKTOP_OPERATE]: state,
                      [ARXIV_RESEARCH]: verifyArxivRuntimeSync() ? 'connected' as const : 'disconnected' as const }
                  })(),
                })
              ),
            },
          }
        : {}),
    })
  }

  /**
   * WP1 / ADR-104：**这一轮工具决策能用哪些能力**（一处实现，两处用）。
   *
   * ```text
   * rules 档（缺省）  = `TASK_CAPABILITY_IDS` ∩ 已启用  —— **逐字** = 第二批的既有清单
   * role 档            = 上面那份 **+ 旧沙箱三件**（echo / sandbox.file.read / write）
   * ```
   * ⚠️ 为什么 role 档要多这三件：计划书 §3 的能力矩阵逐字要求"旧沙箱读/写与 echo
   *    **纳入完整工具清单**"—— 否则"所有工具都由她自己决定"这句话里少了三件。
   *    它们在 `rules` 档**照旧不由任务环产生**（本方法在那里一个字节都没变）。
   * ⚠️ 追加的这三件**不新增任何执行能力**：域、权限、目标解析全是旧的那一套
   *    （sandbox 根 = `actionSandboxRoot`，风险 R0/R1）。
   * ⚠️ 目录与任务授权**必须**用同一个方法：两份清单分叉的那天，目录会告诉模型
   *    一个它其实拿不到的能力。
   */
  private toolCapabilitiesForTurn(): readonly string[] {
    const base = TASK_CAPABILITY_IDS.filter((capability) => this.isTaskCapabilityEnabled(capability))
    if (this.flags.toolDecisionMode !== 'role') return base
    return [...base, SYSTEM_ECHO, SANDBOX_FILE_READ, SANDBOX_FILE_WRITE]
  }

  /**
   * 第二批：**本任务是否允许这个能力**（装配层按开关算，模型不能扩大）。
   *
   * ⚠️ 一处实现，不散在各处：`capabilitiesFor()` 与"任务里的越权步骤会被丢弃"
   *    必须严格同源 —— 两份清单迟早会分叉，而分叉的那天就是越权成功的那天。
   */
  private isTaskCapabilityEnabled(capability: string): boolean {
    const flags = this.flags
    switch (capability) {
      case WORKFLOW_SKILL:
        return flags.workflowSkillsEnabled
      case PERSONAL_LIBRARY_SEARCH:
        return flags.personalLibraryEnabled
      case ARXIV_RESEARCH:
        return flags.arxivResearchEnabled
      case LOCAL_FILE_LIST:
      case LOCAL_FILE_READ:
        return flags.localFileReadEnabled
      case LOCAL_FILE_WRITE:
        return flags.localFileWriteEnabled
      case DOCUMENT_READ:
        return flags.documentReadEnabled
      case IMAGE_OCR:
        return flags.imageOcrEnabled
      case MATH_CALCULATE:
        return flags.mathCalculateEnabled
      case WEB_READ:
        return flags.webReadEnabled
      case WEB_SEARCH:
        return flags.webSearchEnabled && flags.webSearchMode !== undefined
      case WEATHER_QUERY:
        return flags.weatherEnabled
      case OFFICE_GENERATE:
        // 两条权限都要（矩阵逐字）：生成 + 本机落盘
        return flags.officeGenerateEnabled && flags.localFileWriteEnabled
      case NEWS_READ:
        return flags.newsReadEnabled
      case BROWSER_READ:
        return flags.browserEnabled
      case BROWSER_OPERATE:
        return flags.browserEnabled
      /*
       * ★ 2026-10-09 / ADR-125：全工具档。**两条都要**：浏览器那一档开着（它是载体），
       *   且"任意工具入口"这个开关也开着（`browserFullTools`）。
       *   ⚠️ 只开 browserEnabled 而不开它 ⇒ `browser.mcp` 不在本轮能力清单里，
       *      模型提出来的那一步会在 `parseTaskPlan` 被整条丢弃（不是执行时报错）。
       */
      case BROWSER_MCP:
        return flags.browserEnabled && flags.browserFullTools
      case DESKTOP_INSPECT:
        return flags.desktopInspectEnabled
      case DESKTOP_OPERATE:
        return flags.desktopOperateEnabled
      default:
        return false
    }
  }

  /**
   * 构造**搜索意图的异步解析器**（M5.5.1 WP4）。
   *
   * 只在"总开关 on **且** 模式合法 **且** 有能力构造判定器"时返回；
   * 否则返回 `undefined` ⇒ 端口不配钩子 ⇒ 走 M4.5/M5.5 的旧行为。
   *
   * ⚠️ 这里刻意**不**在旧行为上补任何"兜底搜索"：flag off 时 `web.search` 能力恒登记，
   *    用户说"搜一下"照旧得到一条**可审计的 `permission_denied`**（M5.5 `D-12`）。
   */
  private buildSearchResolver():
    | ((input: { text: string; baseline?: ActionIntent }) => Promise<ResolvedActionIntent>)
    | undefined {
    const flags = this.flags
    if (flags.webSearchEnabled !== true) return undefined
    if (flags.webSearchMode === undefined) return undefined
    /*
     * S4（裁定 A）：判定超时的**配置错误**与"开关关闭/模式非法"走同一条路 ——
     * 不构造判定器 ⇒ `resolveSearchNeed` 以 `judge_absent` 失败关闭，**不静默回落缺省**。
     */
    const judgeTimeoutMs = flags.webSearchJudgeTimeoutMs
    if (judgeTimeoutMs === undefined) return undefined
    // ⚠️ 实际生效值来自 flags（并已写进启动日志：`web-search-judge-timeout(Nms)`）
    const judge = createOpenAiSearchNeedJudge({ timeoutMs: judgeTimeoutMs })
    const mode = flags.webSearchMode
    const dryRun = this.dryRun === true

    return async (input: { text: string; baseline?: ActionIntent }): Promise<ResolvedActionIntent> => {
      const baseline = input.baseline
      /*
       * 本地动作优先：基线命中了**非搜索**能力（M4.5 的文件读写 / echo）⇒ 原样放行，
       * 连判定都不问（本地优先是 §11.2 第①步的"可提前拒绝"，也是代价不对称的那一侧）。
       */
      if (baseline !== undefined && baseline.capability !== WEB_SEARCH) return { intent: baseline }
      const explicitCandidate = baseline?.capability === WEB_SEARCH

      const resolution = await resolveSearchNeed(
        {
          text: input.text,
          mode,
          masterEnabled: true,
          dryRun,
          localActionFired: baseline !== undefined && explicitCandidate !== true,
          providerCallsUsed: 0,
          judgeCallsUsed: 0,
          explicitCandidate,
        },
        { judge }
      )
      /*
       * 诊断只放**闭集码与计数**（ADR-049 §5 的禁止清单：原始用户文本、query、
       * 模型自由解释、完整 prompt、网页标题/摘要、凭证一律不进 trace / 开发者面）。
       */
      const diagnostics: Record<string, string | number | boolean> = {
        search_need_code: resolution.code,
        search_need_judge_calls: resolution.judgeCalls,
        search_need_provider_calls: resolution.providerCalls,
        ...(resolution.candidateSource !== undefined
          ? { search_need_candidate_source: resolution.candidateSource }
          : {}),
        ...(resolution.decision !== undefined ? { search_need_decision: resolution.decision } : {}),
        ...(resolution.judgeCalls > 0 ? { search_need_judge_version: 'm5.5.1' } : {}),
      }
      if (resolution.action !== 'search' || resolution.query === undefined) {
        // 否决：**不产生请求**。判定结论由 diagnostics 如实表达（不伪造 executed 账本）。
        return { diagnostics }
      }
      return {
        intent: {
          capability: WEB_SEARCH,
          operation: WEB_SEARCH_OPERATION,
          // query **逐字**来自判定通过的那一段；旧抽法（含私有前缀）在这里被彻底取代
          args: { query: resolution.query, limit: DEFAULT_SEARCH_LIMIT, locale: DEFAULT_SEARCH_LOCALE },
          hints: [],
          rule: 'search_need_judged',
          phrase: input.text.slice(0, 60),
        },
        diagnostics,
      }
    }
  }

  /**
   * Lv4.5 / `P3`（选项 B）：**边听边查**用的那一个网关。
   *
   * ⚠️ 它**不是**第二份实现，而是 `buildActionWriter()` 里建好的**同一个实例**
   *    （同一个登记表 / 同一套权限 / 同一本账本 / 同一个目标解析）。
   *    再建一个就会让"能力存在"有两个来源 —— 而那正是 ADR-031/032 禁止的。
   */
  private actionGatewayRef?: ActionGateway
  /**
   * 与上面那一个网关**配套的**登记表（同一个实例）。
   *
   * ⚠️ 提前检索要读"这个操作**声明**了什么"（`sideEffect` / 风险级），
   *    而不是**自己写一个**。写死一个更低的级别就是**提权** ——
   *    即使今天它恰好等于声明值，明天声明改了就会静默不一致。
   */
  private actionRegistryRef?: CapabilityRegistry

  /**
   * 动作运行时**是否已经建好**（`P3` 选项 B 的诊断读数）。
   *
   * ============================================================================
   *  为什么值得专门暴露一个"就绪"读数
   * ============================================================================
   * "边听边查"依赖**会话打开时**建好的那一个网关。如果某个入口模式没走到那一步，
   * 结果**不是**报错，而是 `prepareLookup` 每次都返回 `action_runtime_absent` ——
   * 功能**静默地永远不触发**，而门全绿。这正是 `L-S8-30` 的形态
   * （入口在、门绿、永远不发生）。
   * ⇒ 所以要把"能力在不在"变成一条**能读到的日志**，而不是靠读代码推断。
   */
  get actionRuntimeReady(): boolean {
    return this.actionGatewayRef !== undefined && this.actionRegistryRef !== undefined
  }

  /**
   * Lv4.5 / `P3`（选项 B）：**提前检索**（用户原话里显式要求联网查证时）。
   *
   * ============================================================================
   *  它与"正式轮次里的那次搜索"是什么关系
   * ============================================================================
   * ```text
   * 同一个能力入口（`web.search`）、同一个网关、同一套权限与账本
   * ⇒ 用户 2026-10-05 裁定"走动作网关"：代价是**账本里多一条推测性检索记录**
   *   （那条检索**真的发生过**，所以记下来是如实的；只是它不隶属某一轮回复）
   * ```
   * ⚠️ **只读**：它不落用户事件、不写记忆、不生成回复 —— 它唯一的产物是一个
   *    "我查到过"的来源 id，供桥决定要不要插一句"查到了。"。
   * ⚠️ 失败**失败关闭**：拿不到网关 / 没登记 / 被策略拒绝，都如实回报，
   *    **不**伪造"查到了"。
   */
  async prepareLookup(query: string): Promise<{
    status: 'found' | 'not_found' | 'rejected' | 'failed'
    sourceRefs?: readonly string[]
    code?: string
  }> {
    const gateway = this.actionGatewayRef
    const registry = this.actionRegistryRef
    if (gateway === undefined || registry === undefined || this.kernel === undefined) {
      return { status: 'failed', code: 'action_runtime_absent' }
    }
    /*
     * ⚠️ 级别**读声明**，不自己写（见 `actionRegistryRef` 的注释）：
     *    没登记 ⇒ 具名拒绝，**不**猜一个级别去执行。
     */
    const operation = registry.getOperation(WEB_SEARCH, WEB_SEARCH_OPERATION)
    if (operation === undefined) {
      return { status: 'rejected', code: 'capability_not_registered' }
    }
    /*
     * ⚠️ 这次检索的**理由**必须写清楚：它是"用户说了显式检索词形"的结果，
     *    所以 `requestedBy` 是 `user`。它不是她自己想查 —— 那会变成主动出站。
     */
    const request = createActionRequest({
      actionId: newActionId(),
      /*
       * ⚠️ 它**不属于任何一轮**对话（提前检索发生在轮次之前）⇒ 这里新起一个 traceId，
       *    而不是借某一轮的。借来的 trace 会让动作记录挂在一个它并不属于的轮次上。
       */
      traceId: newTraceId(),
      capability: WEB_SEARCH,
      operation: WEB_SEARCH_OPERATION,
      requestedBy: { kind: 'user' },
      arguments: { query, limit: DEFAULT_SEARCH_LIMIT, locale: DEFAULT_SEARCH_LOCALE },
      sideEffect: operation.sideEffect,
    })
    try {
      const result = await gateway.execute(this.kernel.characterId, request, {
        /*
         * ======================================================================
         *  ADR-098：提前检索走**具名归因豁免**
         * ======================================================================
         * 用户 2026-10-05 裁定「给它一个具名的归因豁免」。
         *
         * ```text
         * 为什么必须给：动作事件要**受信 initiator 证据**，而提前检索发生在
         *   轮次**之前** ⇒ 没有因果上下文 ⇒ 网关失败关闭
         *   （实测读数：lookup_last_code = "action_attribution_evidence_missing"）
         * 这条豁免给出的是**名字**（`SYSTEM/pre-turn-lookup`），不是"未知"：
         *   账本因此可查、可审计；收窄（只读 + 只对 web.search/search）
         *   **由网关复核**（见 `assertNamedExemptionIsNarrow`），不是这里的自觉。
         * ⚠️ 它**不**把 payload 自报的 `requestedBy` 洗成权威 —— 那条禁令原样保留。
         * ```
         */
        initiatorEvidence: attestActionInitiatorFromNamedExemption({
          adapterId: 'pre-turn-lookup',
          exemption: 'pre_turn_lookup',
        }),
      })
      /*
       * ⚠️ 结局**随协议**回给外壳（不写日志）：桥的 stdout 是 NDJSON 协议通道，
       *    外壳在 ready 之后会丢弃非协议行 ⇒ `logger.info` 写的诊断在生产里**读不到**。
       *    实测教训：我一度以为"提前检索这个分支没跑"，其实是它跑了、**读数被扔掉**。
       */
      return toLookupReading(result)
    } catch (error) {
      /*
       * 失败关闭：桥会因此**不**说那一句（而不是说一句没有依据的"查到了"）。
       *
       * ⚠️ 取 **`KernelError.code`**，不是 `error.name` —— 后者一律是 `"KernelError"`，
       *    等于把"为什么失败"（策略拒 / 目标解析不了 / 校验不过）全丢掉。
       *    实测就是靠这条区分出来的：第一版只报 `KernelError`，看不出真因。
       * ⚠️ 它随 `PREPARE_RESULT.lookup` 回外壳、进 `/lg/status`（**不**写日志，
       *    因为桥的 stdout 是协议通道、生产上读不到）。
       */
      const code = error instanceof KernelError ? error.code : 'lookup_failed'
      return { status: 'failed', code }
    }
  }

  /**
   * post-Lv2 / ADR-110 `D05`：**经真网关**把一条主动文字发出去。
   *
   * ============================================================================
   *  它与 `prepareLookup` 的关系：同形，但两处**刻意不同**
   * ============================================================================
   * ```text
   * 同：  读声明 → 建请求 → 经网关执行 → 把结局**归一**成具名读数（不写日志）
   * 不同①：它是**写**（`D05a` 的写豁免），而提前检索是只读（ADR-098 的只读豁免）
   * 不同②：**额度在这一步签发** —— `riskBudgetOverride: 'R2'` 是**程序常量**
   *        ⚠️ 这是全仓库**唯一**一处给 R2 的地方，而它**只**对这次调用生效：
   *           全局 `CHARACTER_ACTION_MAX_RISK` 仍是 R1（缺省），没有被动过。
   *        ⚠️ 为什么这次可以给：ADR-110 `D05` 用户裁定"R2 只授给这一项本人私聊操作"，
   *           且这次调用的目标由**绑定常量**给出（`exact`）、载荷只有一段有界文字、
   *           幂等键必需、发出前有额度与暂停闸。它**不是**"给聊天整体升到 R2"。
   * 不同③：幂等键由**参数**带进来（`__occurrenceKey`）—— 同一次机会不许因为重试发两次
   * ```
   * ⚠️ 结局**随返回值**给调用方（不写日志）：这条路径上没有协议通道可回话，
   *    所以调用方（调度器）必须把读数记下来。
   */
  async deliverProactiveQqText(input: {
    occurrenceKey: string
    text: string
    channel?: 'avatar' | 'cli'
  }): Promise<{ outcome: 'executed' | 'refused'; code?: string; actionId?: string }> {
    const gateway = this.actionGatewayRef
    const registry = this.actionRegistryRef
    if (gateway === undefined || registry === undefined || this.kernel === undefined) {
      return { outcome: 'refused', code: 'action_runtime_absent' }
    }
    /* ⚠️ 级别**读声明**，不自己写：没登记 ⇒ 具名拒绝，**不**猜一个级别去执行 */
    if (input.channel !== undefined && input.channel !== this.entryKey) return { outcome: 'refused', code: 'reminder_entry_mismatch' }
    const capability = input.channel === undefined ? QQ_PRIVATE_SEND_TEXT : LOCAL_REMINDER_SEND
    const operation = registry.getOperation(capability, QQ_PRIVATE_SEND_OPERATION)
    if (operation === undefined) {
      return { outcome: 'refused', code: 'capability_not_registered' }
    }
    const actionId = newActionId()
    const request = createActionRequest({
      actionId,
      /*
       * ⚠️ 它**不属于任何一轮**对话（定时器到点触发）⇒ 新起一个 traceId，
       *    不借某一轮的（借来的 trace 会把这条动作挂在一个它并不属于的轮次上）。
       */
      traceId: newTraceId(),
      capability,
      operation: QQ_PRIVATE_SEND_OPERATION,
      /* ⚠️ 发起人身份是**系统侧**的（调度器），不是用户、不是模型 */
      requestedBy: { kind: 'system', id: input.channel === undefined ? PROACTIVE_SCHEDULER_PRINCIPAL_ID : 'local-reminder-scheduler' },
      /*
       * ⚠️ **参数闭集只有 `text`** —— 稳定键**不在这里**。
       *    实测教训：第一版把它当 `__occurrenceKey` 塞进 args，能力自己的闭集检查
       *    **当场拒绝**（`qq.private.message 的参数只有 text，收到 __occurrenceKey`）。
       *    那个拒绝是对的：args 是"模型能写的那一面"，不该混进程序字段。
       *    ⇒ 它走 `idempotencyKey`（下面那一行），由网关转给适配器。
       */
      arguments: { text: input.text },
      sideEffect: operation.sideEffect,
      /* 幂等键 = 这一次机会的键（同一次机会重试**不许**变成两次发送） */
      idempotencyKey: input.occurrenceKey,
    })
    try {
      const result = await gateway.execute(this.kernel.characterId, request, {
        /* `D05a`：闭集里的**写**豁免，收窄到 (调度器 · qq.private.message · send) */
        initiatorEvidence: attestActionInitiatorFromNamedExemption({
          adapterId: 'qq-proactive-delivery',
          exemption: input.channel === undefined ? 'proactive_qq_delivery' : 'scheduled_local_reminder_delivery',
        }),
        /* QQ 本人私聊授予 R2；本地文字提醒保持 R1，全局上限没动。 */
        riskBudgetOverride: input.channel === undefined ? 'R2' : 'R1',
      })
      /*
       * ⚠️ 判据用 `isSuccessResult`（**唯一**被允许出现成功口吻的条件），
       *    而不是"`executed` 为真就算成" —— 后者会把 `partial` / 非 success 读成成功。
       */
      if (isSuccessResult(result)) return { outcome: 'executed', actionId: String(actionId) }
      /*
       * ⚠️ 失败时把 `error.message` **原样**记进日志（**不含正文**）：
       *    整链第一版这里只回一个 `validation_failed`，完全看不出是哪一条校验
       *    （量具的教训：**具名码不够时要把人读的理由也留下**）。
       */
      logger.info(
        `[qq-proactive] 主动发送被拒：${describeActionResult(result)}` +
          (result.error === undefined ? '' : ` :: ${result.error.message}`)
      )
      return {
        outcome: 'refused',
        code:
          result.error?.code ??
          `proactive_send_${result.executed ? result.status : 'not_executed'}`,
        actionId: String(actionId),
      }
    } catch (error) {
      /* 与 `prepareLookup` 同一条：取 `KernelError.code`（`error.name` 一律是 "KernelError"，等于丢掉真因） */
      const code = error instanceof KernelError ? error.code : 'proactive_send_failed'
      return { outcome: 'refused', code, actionId: String(actionId) }
    }
  }

  /**
   * WP1：返回的不只是网关 —— 还有**这一次真的授予了哪些权限**。
   *
   * ⚠️ 一处算、两处用（网关 + 工具目录）：口径只能有一份（见下面 `grantedPermissions` 的注释）。
   */
  private buildActionGateway(registry: CapabilityRegistry): {
    gateway: ActionGateway
    grantedPermissions: readonly string[]
  } {
    if (!this.kernel) throw new Error('buildActionGateway 需要 kernel')
    const kernel = this.kernel
    const ledger = createActionLedgerStore(kernel.stores.db)
    const sandboxRoot = this.flags.actionSandboxRoot
    const sandboxOptions = { root: sandboxRoot }

    /*
     * ==========================================================================
     *  M5.5：联网搜索的**两处**消费（ADR-045 `D-12`）
     * ==========================================================================
     * 这个开关决定两件事，**少一件都不算打开**：
     *   ① 是否把 `web:search` 加进授予清单（否则策略在第 ③ 步拒绝）
     *   ② 是否构造 provider + 适配器（否则**构造上**没有出站能力）
     *
     * flag 关闭时：能力仍在登记表里（恒登记），策略拒绝 → 用户看到的是一条
     * 可审计的"没被允许"事实，而不是静默什么都不做。
     */
    const searchModeValid = this.flags.webSearchMode !== undefined
    /*
     * ⚠️ 模式非法 ⇒ 与"开关关闭"**同一条路**：不授予 `web:search`、不构造适配器
     *    （`D551-2`："非法值 = 配置错误 + 禁止搜索"）。判定器那边同理
     *    （`buildSearchResolver` 直接返回 undefined ⇒ 端口不配钩子）。
     */
    /*
     * S4：判定超时的配置错误与"开关关闭/模式非法"同一条路 —— 不授权、不构造适配器。
     */
    const judgeTimeoutValid = this.flags.webSearchJudgeTimeoutMs !== undefined
    const searchEnabled = this.flags.webSearchEnabled === true && searchModeValid && judgeTimeoutValid
    /*
     * ADR-054 / ADR-046 `D-25`：**按模式读不同的变量名**。
     * `--test`（干跑）走 `…_TEST_…`，真实聊天走生产名 —— 一个模式只拼一个变量名，
     * 于是"测试缺失时回落到生产 key"在结构上不存在这条路。
     */
    const tavilyConfig = searchEnabled ? assertTavilyConfig({}, { isTestMode: this.dryRun === true }) : undefined
    const webSearchAdapter =
      searchEnabled && tavilyConfig !== undefined
        ? createWebSearchAdapter({
            provider: createTavilySearchProvider({
              config: tavilyConfig,
              /*
               * 成本**只报告**（`D-30`）：把这一次实际消耗的 credit 打出来。
               * ⚠️ 它**不参与**任何放行/拒绝判断 —— 成本没有闸，这是刻意的。
               */
              onCreditsUsed: (credits) => {
                if (credits !== null) logger.info(`[search-cost] Tavily 本次消耗 ${credits} credit`)
              },
            }),
            fingerprint: createSha256Fingerprinter(),
          })
        : undefined

    /*
     * ==========================================================================
     *  实用能力加装：四个适配器**只在各自的开关打开时**构造
     * ==========================================================================
     * 与 `webSearchAdapter` 同一条纪律（`D-12`）：关闭时不构造 ⇒ **构造上**
     * 没有执行器、不 spawn 子进程、不加载重依赖、不出站。权限授予同样按开关，
     * 于是"没启用"是一条可审计的 `permission_denied`，而不是"装作没听懂"。
     */
    /*
     * 第二批：文档 / OCR 的**跨域路径解析器**（缺省 `undefined` = 只认沙箱）。
     *
     * 计划书 §2.1 第 3 点要求"文档/OCR 从**同一授权文件读取入口**取得字节"，
     * 而"同一入口"就是 `resolveLocalAbsolutePath`（语法院 + 重解析点守卫）。
     *
     * ⚠️ **用户 2026-10-05 裁定（`L-RTD-18`：允许访问本机所有文件）**之后，它的存在条件
     *    不再依赖"本机文件读开关"：只要**文档或图片**那一项自己开着，就装这个解析器
     *    —— 否则会出现"开关开了、策略也按本机全域判了，却仍然只认沙箱"的半接状态
     *    （第一版的实测形态：`document.read` 目标解析成 `local-disk` 却按沙箱拒）。
     * ⚠️ 它仍然**只是**路径解析（语法 + 重解析点守卫）：不发权限、不绕开关。
     */
    const diskWideResolver =
      this.flags.localFileReadEnabled ||
      this.flags.documentReadEnabled ||
      this.flags.imageOcrEnabled
        ? async (
            rawPath: string
          ): Promise<{
            absolutePath: string
            resourceRef: string
            sourceKind: TurnContentSourceKind
          }> => {
            const { absolutePath } = await resolveLocalAbsolutePath(rawPath)
            return { absolutePath, resourceRef: absolutePath, sourceKind: 'local-disk' }
          }
        : undefined
    const localFileResolver = diskWideResolver

    const mathAdapter = this.flags.mathCalculateEnabled ? createMathCalculateAdapter() : undefined
    const skillAdapter = this.flags.workflowSkillsEnabled ? createWorkflowSkillAdapter(this.workflowSkills) : undefined
    const libraryAdapter = this.flags.personalLibraryEnabled ? createPersonalLibraryAdapter() : undefined
    const arxivAdapter = this.flags.arxivResearchEnabled ? createArxivAdapter() : undefined
    const documentAdapter = this.flags.documentReadEnabled
      ? createDocumentReadAdapter({
          ...sandboxOptions,
          ...(localFileResolver !== undefined
            ? { resolveTarget: localFileResolver }
            : {}),
        })
      : undefined
    const webReadAdapter = this.flags.webReadEnabled ? createWebReadAdapter() : undefined
    const ocrAdapter = this.flags.imageOcrEnabled
      ? createImageOcrAdapter({
          backend: configuredOcrBackend(),
          ...sandboxOptions,
          ...(localFileResolver !== undefined
            ? { resolveTarget: localFileResolver }
            : {}),
        })
      : undefined
    const utilityPermissions = [
      ...(this.flags.mathCalculateEnabled ? [MATH_CALCULATE_PERMISSION] : []),
      ...(this.flags.documentReadEnabled ? [DOCUMENT_READ_PERMISSION] : []),
      ...(this.flags.webReadEnabled ? [WEB_READ_PERMISSION] : []),
      ...(this.flags.imageOcrEnabled ? [IMAGE_OCR_PERMISSION] : []),
    ]

    /*
     * ==========================================================================
     *  第二批：本机文件域 + 四项业务能力的适配器（**只在各自开关打开时构造**）
     * ==========================================================================
     * 同一条纪律（先例 `D-12`）：关闭时不构造 ⇒ 构造上没有执行器、不 spawn
     * 子进程、不加载重依赖、不出站。权限授予同样按开关。
     */
    const localFileReadAdapter = this.flags.localFileReadEnabled
      ? createLocalListAdapter()
      : undefined
    const localFileReadFileAdapter = this.flags.localFileReadEnabled
      ? createLocalReadAdapter()
      : undefined
    const localFileWriteAdapter = this.flags.localFileWriteEnabled
      ? createLocalWriteAdapter({
          recoveryRoot: resolve(this.flags.localFileRecoveryRoot),
          staging: this.payloadStaging,
        })
      : undefined
    const localFilePermissions = [
      ...(this.flags.localFileReadEnabled
        ? [LOCAL_FILE_LIST_PERMISSION, LOCAL_FILE_READ_PERMISSION]
        : []),
      ...(this.flags.localFileWriteEnabled ? [LOCAL_FILE_WRITE_PERMISSION] : []),
    ]

    const weatherAdapter = this.flags.weatherEnabled ? createWeatherAdapter() : undefined
    const newsAdapter = this.flags.newsReadEnabled ? createNewsReadAdapter() : undefined
    /*
     * ⚠️ 办公生成的两条权限都要（矩阵逐字）：`office:generate` + `local-file:write`。
     *    因此"Office 开关打开但本机写入关着"时，这一项**不授权也不构造** ——
     *    结果是用户得到一条可审计的 `permission_denied`，而不是"生成到一半失败"。
     */
    const officeEnabled = this.flags.officeGenerateEnabled && this.flags.localFileWriteEnabled
    const officeAdapter = officeEnabled
      ? createOfficeGenerateAdapter({
          recoveryRoot: resolve(this.flags.localFileRecoveryRoot),
          staging: this.payloadStaging,
        })
      : undefined
    const officePermissions = officeEnabled ? [OFFICE_GENERATE_PERMISSION] : []

    const browserAdapters = this.flags.browserEnabled
      ? createBrowserAdapters({
          sidecarUrl: this.flags.browserSidecarUrl,
          fetchImpl: globalThis.fetch,
        })
      : []
    const browserPermissions = this.flags.browserEnabled
      ? [
          BROWSER_READ_PERMISSION,
          BROWSER_OPERATE_PERMISSION,
          ...(this.flags.browserFullTools ? [BROWSER_MCP_PERMISSION] : []),
        ]
      : []

    /*
     * ADR-106：桌面两档。
     *
     * ⚠️ 适配器**建两个**（同一个 worker）：能力是两条，`capabilityId` 只能有一个。
     * ⚠️ 权限逐个开关给：只看的那一档开着不等于"能动手"也开着。
     * ⚠️ `staging` 传**同一个实例**（与执行环 / 写入适配器同一份）——
     *    `type` 要输入的正文只从它来（先例：`spec_not_staged` 生产缺陷）。
     */
    const desktopAdapters = createDesktopAdapters({
      staging: this.payloadStaging,
    }).filter((adapter) =>
      adapter.capabilityId === DESKTOP_INSPECT
        ? this.flags.desktopInspectEnabled
        : this.flags.desktopOperateEnabled
    )
    const desktopPermissions = [
      ...(this.flags.desktopInspectEnabled ? [DESKTOP_INSPECT_PERMISSION] : []),
      ...(this.flags.desktopOperateEnabled ? [DESKTOP_OPERATE_PERMISSION] : []),
    ]

    /*
     * ⚠️ 权限清单**在这里算一次**，并随网关一起返回：
     *    WP1 的工具目录要**如实**告诉角色"哪些权限被授予了"（`authorized` 那一态）。
     *    目录若自己再算一遍，就出现了第二份"什么被授权"的判据 —— 而两份判据
     *    迟早会分叉（分叉那天，目录会声称一个它其实没有的权限）。
     */
    const grantedPermissions: readonly string[] = [
      ...(skillAdapter !== undefined ? [WORKFLOW_SKILL_PERMISSION] : []),
      ...(libraryAdapter !== undefined ? [PERSONAL_LIBRARY_PERMISSION] : []),
      ...(arxivAdapter !== undefined ? [ARXIV_PERMISSION] : []),
      ...DEFAULT_GRANTED_PERMISSIONS,
      ...(searchEnabled ? [WEB_SEARCH_PERMISSION] : []),
      ...utilityPermissions,
      ...localFilePermissions,
      ...officePermissions,
      ...browserPermissions,
      ...desktopPermissions,
      ...(weatherAdapter !== undefined ? [WEATHER_QUERY_PERMISSION] : []),
      ...(newsAdapter !== undefined ? [NEWS_READ_PERMISSION] : []),
      /*
       * post-Lv2 / ADR-110 `D05`：QQ 主动联系的权限**条件授予**。
       *
       * ```text
       * mode = off        ⇒ **不授予** ⇒ 策略给出可审计的 missing_permission
       * mode = shadow/on  ⇒ 授予；真正"发不发"由 shadow 的 dryRun 与投递路径决定
       * ```
       * ⚠️ 这是本文件里**唯一**消费 `qqProactiveMode` 的地方（`m4.5:test` 有手写静态锁）。
       *    ⇒ "开关被读了但没人用"这种 D3 惰性开关的形状在这里被排掉。
       * ⚠️ 授予权限**不等于**放开风险上限：R2 仍需**这一次调用**自带额度
       *    （`riskBudgetOverride`，由主动装配根给程序常量），全局上限不动。
       */
      ...(this.flags.qqProactiveMode !== 'off' ? [QQ_PRIVATE_SEND_PERMISSION] : []),
      ...(this.flags.qqProactiveMode !== 'off' && this.entryKey !== 'qq_private' ? [LOCAL_REMINDER_PERMISSION] : []),
    ]

    /**
     * 进程级的主动投递通道（`D06`）。**只在非 off 时**建：
     * 关着时连这个对象都不该存在（与"能力没登记"逐字一致）。
     */
    const proactiveDeliveryAdapter =
      this.flags.qqProactiveMode !== 'off'
        ? createQqProactiveDeliveryAdapter({
            /* 出站口 = 登记表（它自己判"当前代次"）；没有当前连接时**失败关闭** */
            delivery: { deliver: (out) => proactiveDeliveryChannel(this.kernel!.stores.db).deliver(out) },
            /*
             * ⚠️ 稳定键走**幂等键**（`ActionRequest.idempotencyKey`），不走进 args ——
             *    它是程序给的字段，模型没有任何路径能写它。
             */
            resolveDeliveryId: (executeInput) => executeInput.idempotencyKey,
          })
        : undefined
    return {
      gateway: createActionGateway({
        registry,
        ledger,
        adapters: [
          createEchoAdapter(),
          ...(skillAdapter !== undefined ? [skillAdapter] : []),
          ...(libraryAdapter !== undefined ? [libraryAdapter] : []),
          ...(arxivAdapter !== undefined ? [arxivAdapter] : []),
          createSandboxReadAdapter(sandboxOptions),
          /*
           * WP3 / `L-RTD-17`（用户 2026-10-05 裁定按推荐方案修）：写入适配器拿到**与执行环
           * 同一个**暂存实例 ⇒ 它才认得执行环改写出来的 `payloadRef`。
           * ⚠️ 传 `this.payloadStaging`（**不是**新建一个）—— 先例 `spec_not_staged`。
           */
          createSandboxWriteAdapter({ ...sandboxOptions, staging: this.payloadStaging }),
          ...(webSearchAdapter !== undefined ? [webSearchAdapter] : []),
          ...(mathAdapter !== undefined ? [mathAdapter] : []),
          ...(documentAdapter !== undefined ? [documentAdapter] : []),
          ...(webReadAdapter !== undefined ? [webReadAdapter] : []),
          ...(ocrAdapter !== undefined ? [ocrAdapter] : []),
          ...(localFileReadAdapter !== undefined ? [localFileReadAdapter] : []),
          ...(localFileReadFileAdapter !== undefined ? [localFileReadFileAdapter] : []),
          ...(localFileWriteAdapter !== undefined ? [localFileWriteAdapter] : []),
          ...(weatherAdapter !== undefined ? [weatherAdapter] : []),
          ...(officeAdapter !== undefined ? [officeAdapter] : []),
          ...(newsAdapter !== undefined ? [newsAdapter] : []),
          ...browserAdapters,
          ...desktopAdapters,
          /*
           * post-Lv2 / ADR-110 `D05`：主动投递的**执行端**。
           *
           * ⚠️ 它的出站口是**登记表**（`qqDelivery.deliver`），不是某条 socket ——
           *    "只有当前代次能投递"因此是结构性的（登记表自己判）。
           * ⚠️ 稳定键（`occurrenceKey`）由调用方从**参数**带进来（`__occurrenceKey`，
           *    不是模型能写的字段）：`TASK_ARG_KEYS` 的闭集里没有它，所以它进不来 ——
           *    这里从 `request.arguments` 取不到时**失败关闭**（`qq_send_without_delivery_key`）。
           */
          ...(proactiveDeliveryAdapter === undefined ? [] : [proactiveDeliveryAdapter]),
          ...(this.flags.qqProactiveMode !== 'off' && this.entryKey !== 'qq_private'
            ? [createLocalReminderDeliveryAdapter(this.entryKey, reminderDeliveryChannel(this.kernel!.stores.db, this.entryKey))] : []),
        ],
        grantedPermissions,
        maxRiskLevel: this.flags.actionMaxRiskLevel,
        dryRun: this.dryRun,
        now: () => Date.now(),
      /*
       * WP5：启用受信行动归因（三个产出者标识都会写进证据）。
       * 不配这个对象 = 逐字段 legacy；配了之后**每次**调用都必须带受信
       * initiator 证据，否则失败关闭（WP5-3），不再退回 payload 自报。
       */
      attribution: {
        decisionPointAdapterId: 'action-gateway',
        policyAdapterId: 'action-policy',
        executorAdapterId: 'action-adapter',
      },
      /*
       * ⚠️ 目标解析注入点。
       *
       * `listEntries` 只枚举沙箱内的**相对路径与名字**（不读内容）——
       * 目标解析不需要内容，而"读内容"是适配器在执行阶段才做的事。
       * 沙箱不存在时返回空列表：那是"没有候选"，不是错误。
       *
       * M5.5：搜索的"目标"是**配置固定的本地服务**，不是用户指定的资源。
       * 它与用户输入无关（endpoint 是代码常量）⇒ `confidence: 'exact'` 是**如实**的，
       * 不是"因为只有一个候选就说是它"（那正是 ADR-032 要防的猜测）。
       */
      resolveTarget: async ({ request, operation }) => {
        if (request.capability === LOCAL_REMINDER_SEND) return {
          target: { type: 'local_reminder_entry', canonicalId: this.entryKey, displayName: this.entryKey,
            confidence: this.entryKey === 'qq_private' ? 'none' : 'exact' }, scopeViolation: false,
        }
        /*
         * ==================================================================
         *  post-Lv2 / ADR-110 `D05`：QQ 主动投递的目标 = **已绑定的本人**
         * ==================================================================
         * ⚠️ 与 `web.search` / `math.calculate` 同一类：目标**与用户输入无关**，
         *    它取自本机绑定（`readQqPrivateConfig().ownerId`）⇒ `exact` 是**如实**的。
         * ⚠️ **没有这一支的能力会落到沙箱梯子**（`resolveActionTarget` 把
         *    `qq:…` / 空 id 判为越界）—— 那不是"没接线"，会被读成"目标不合法"。
         * ⚠️ 绑定读不出来 ⇒ `confidence: 'none'`（**失败关闭**：策略给出
         *    `target_uncertain`，而不是"那就发给某个人吧"）。
         *    `readQqPrivateConfig` 会在缺配置时抛 —— 这里**必须**吞掉它：
         *    这台机器完全可能只跑皮套入口（没有 QQ 绑定），那时解析器不许把进程带崩。
         */
        if (request.capability === QQ_PRIVATE_SEND_TEXT) {
          let ownerId: string | undefined
          try {
            ownerId = readQqPrivateConfig(process.env).ownerId
          } catch {
            ownerId = undefined
          }
          return {
            target: {
              type: QQ_PRIVATE_OWNER_TARGET_TYPE,
              canonicalId: ownerId ?? '',
              displayName: ownerId === undefined ? '未绑定的本人' : `本人（${ownerId}）`,
              confidence: ownerId === undefined || ownerId === '' ? 'none' : 'exact',
            },
            scopeViolation: false,
          }
        }
        if (request.capability === WEB_SEARCH) {
          return {
            target: {
              type: 'external_service',
              canonicalId: TAVILY_PROVIDER_ID,
              displayName: `搜索服务（${new URL(D20_RULING.endpoint).host}）`,
              confidence: 'exact',
            },
            scopeViolation: false,
          }
        }
        if (request.capability === WORKFLOW_SKILL || request.capability === PERSONAL_LIBRARY_SEARCH) {
          return {
            target: {
              type: request.capability === WORKFLOW_SKILL ? 'workflow_skill' : 'personal_library',
              canonicalId: request.capability === WORKFLOW_SKILL ? String(request.arguments.skill ?? '') : PERSONAL_LIBRARY_ROOT,
              confidence: 'exact',
            },
            scopeViolation: false,
          }
        }
        if (request.capability === ARXIV_RESEARCH) {
          return {
            target: { type: 'external_service', canonicalId: 'arxiv-mcp@0.8.1', displayName: 'arXiv 固定 MCP（论文只缓存到专用目录）', confidence: 'exact' },
            scopeViolation: false,
          }
        }
        /*
         * 实用能力加装：两项"目标与用户输入无关"的能力走固定目标 ——
         *   · `math.calculate`：目标是**本地受限计算器**（代码常量）⇒ `exact` 是如实的
         *   · `web.read`：目标是**用户逐字给出的 URL**。它的可达性判定（HTTPS/端口/地址）
         *     属于**执行前的准入检查**，在适配器里做（`web-read.ts`），
         *     不在这里 —— 这里只回答"用户指的是哪一个目标"，而那句话逐字取自用户原话。
         *     ⚠️ 绝不把它当沙箱路径解析（`resolveActionTarget` 会把 `https://…` 判为越界）。
         */
        if (request.capability === MATH_CALCULATE) {
          return {
            target: {
              type: 'local_executor',
              canonicalId: 'restricted-math',
              displayName: '本地受限计算器（BigNumber，白名单 AST）',
              confidence: 'exact',
            },
            scopeViolation: false,
          }
        }
        if (request.capability === WEB_READ) {
          const url = typeof request.arguments.url === 'string' ? request.arguments.url : ''
          return {
            target: {
              type: 'remote_url',
              canonicalId: url,
              displayName: url,
              confidence: url === '' ? 'none' : 'exact',
            },
            scopeViolation: false,
          }
        }
        /*
         * ==================================================================
         *  第二批：本机文件域（`local.file.list/read/write`）
         * ==================================================================
         * ⚠️ **不是**沙箱梯子：它只有一级 —— "用户/模型给出的本机绝对路径"。
         *    几百万个同名文件里挑一个就是猜（见 `local-target.ts` 的文件头）。
         * `scopeViolation` 的语义在这里是"**域外**"（网络共享 / 设备路径 / ADS），
         * 措辞由 `scopeWordingFor` 换成"本机文件域"那一句。
         */
        /*
         * 用户 2026-10-05 裁定（`L-RTD-18`）：**文档 / 图片读取也按本机文件域判定**
         * —— 与 `local.file.*` 同一套解析与措辞（见 `kernel/action/disk-wide-scope.ts`）。
         * ⚠️ 只**读**的域被放宽；写侧三件（`local.file.write` / `office.generate` / 沙箱写）
         *    的域一个字节都没动。
         */
        if (isDiskWideCapability(request.capability)) {
          return resolveLocalTarget({
            targetType: 'local_file',
            ...(request.target !== undefined ? { declared: request.target } : {}),
            ...(typeof request.arguments.path === 'string'
              ? { rawPath: request.arguments.path }
              : {}),
          })
        }
        /*
         * 第二批：四项业务能力里"目标与用户输入无关或由程序固定"的那三项。
         * 与 `math.calculate` 同一条理由：目标是**代码常量**，
         * 因此 `confidence: 'exact'` 是如实的，不是"因为只有一个候选就说是它"。
         */
        if (request.capability === WEATHER_QUERY) {
          const city = typeof request.arguments.city === 'string' ? request.arguments.city : ''
          return {
            target: {
              type: 'external_service',
              canonicalId: 'open-meteo',
              displayName: `天气服务（open-meteo，城市：${city === '' ? '(未给出)' : city}）`,
              // ⚠️ 城市为空 ⇒ `none`：那会让策略给 `target_not_found`，而不是拿第一条候选猜
              confidence: city === '' ? 'none' : 'exact',
            },
            scopeViolation: false,
          }
        }
        if (request.capability === NEWS_READ) {
          const feeds = Array.isArray(request.arguments.feeds) ? request.arguments.feeds : []
          return {
            target: {
              type: 'external_service',
              canonicalId: 'rss-atom',
              displayName: `订阅源（${String(feeds.length)} 个）`,
              confidence: feeds.length === 0 ? 'none' : 'exact',
            },
            scopeViolation: false,
          }
        }
        if (request.capability === OFFICE_GENERATE) {
          const path = typeof request.arguments.path === 'string' ? request.arguments.path : ''
          /*
           * ⚠️ 办公生成写的是**一个具体的本机文件** ⇒ 目标必须按本机文件域解析，
           *    不能给它一个"程序固定"的假目标（那样 target 确定性与真实产物就会分叉）。
           */
          return resolveLocalTarget({ targetType: 'local_file', rawPath: path })
        }
        if (isBrowserCapability(request.capability)) {
          return {
            target: {
              type: 'browser_session',
              canonicalId: this.flags.browserSidecarUrl,
              displayName: `浏览器 sidecar（${this.flags.browserSidecarUrl}）`,
              confidence: 'exact',
            },
            scopeViolation: false,
          }
        }
        /*
         * ADR-106：桌面能力的目标是**这台机器的当前桌面**（代码常量，不是用户给的路径）。
         * ⚠️ 与 `math.calculate` 同一条理由：目标与用户输入无关 ⇒ `exact` 是如实的，
         *    不是"因为只有一个候选就说是它"。
         */
        if (isDesktopCapability(request.capability)) {
          return {
            target: {
              type: 'local_executor',
              canonicalId: 'windows-desktop',
              displayName: '当前用户桌面（UI Automation 读取；共用用户的鼠标与键盘）',
              confidence: 'exact',
            },
            scopeViolation: false,
          }
        }
        return await resolveActionTarget({
          targetType: 'sandbox_file',
          ...(request.target !== undefined ? { declared: request.target } : {}),
          hints:
            typeof request.arguments.path === 'string'
              ? [request.arguments.path]
              : [],
          listEntries: () => listSandboxEntries(sandboxOptions),
          // 写操作允许"目标还不存在"（新建）；读操作不允许（→ not_found）
          allowMissing: operation !== undefined && hasSideEffect(operation.sideEffect),
        })
      },
      /*
       * 第二批：**目标域措辞**（只改措辞，不改判定）。
       * 本机文件域的能力（含文档 / 图片读取 —— 用户 2026-10-05 裁定）拿
       * "已授权的本机文件域（不是沙箱）"，其余走缺省（逐字 = 第一批的沙箱那三句）。
       */
      scopeWordingFor: (capability) =>
        isDiskWideCapability(capability) ? LOCAL_FILE_SCOPE_WORDING : undefined,
      onLedgerEvent: (event) => {
        if (this.flags.debugContext) {
          logger.info(
            `[action] ${event.type} ${String(event.actionId)}` +
              `${event.status !== undefined ? ` status=${event.status}` : ''}`
          )
        }
      },
      }),
      grantedPermissions,
    }
  }

  /**
   * M4：把 `ExplicitMemoryService` 装配成**轮次级端口**。
   *
   * ============================================================================
   *  为什么装配写在这里，而不是让 TurnGateway 自己 new 一个服务
   * ============================================================================
   * 服务需要持久化（store / commitEvents / 目标解析的查询口），
   * 而 `kernel/app` 不许 import `infrastructure`（MI-13 / Kernel 边界）。
   * 因此"谁来 new 它"必须在装配层回答 —— 也就是这里。
   *
   * 每一层都按生产实际接：
   *   · validator  ← 与 `memory:retract` 同一个装配（含 `getRecord`，
   *                   它决定"找到多条时能不能判出是哪条"）
   *   · extractor  ← **缺省（规则）**：离线安全、确定性。
   *                   LLM 抽取的接法留到下一步，不在这里顺手打开 ——
   *                   那会让"显式路径是否被调用"这个本次要修的问题
   *                   与"抽取质量"混在一起，两件事的失败无法区分。
   *   · resolveTarget ← `createTargetMemoryResolver` 的五步梯子
   *   · commitEvents  ← `applyAcceptedEvents`（写领域事件的唯一入口）
   */
  private buildMemoryWriter(): ExplicitMemoryTurnPort {
    if (this.flags.memoryPostTurnModelEnabled) return deferredMemoryTurnPort()
    if (!this.kernel) throw new Error('buildMemoryWriter 需要 kernel')
    const kernel = this.kernel
    const db = kernel.stores.db
    const store = createNativeMemoryStore(db)
    const owner = entityRef('character', String(kernel.characterId))

    /*
     * M9.5 / WP4 · W1 —— **维护触发器**（事件触发 + 启动补追赶 + 显式命令兜底）。
     *
     * ```text
     * 为什么在这里构造：`commitEvents` 就在本方法里 —— 每一次"新记忆 / 更正 / 遗忘"都经过它。
     * ⚠️ 构造本身**不** spawn 编码器：`semanticEncoderShared()` 是惰性的，只有 `runOnce` 真的跑
     *    才会取编码器。而**投递**那一行额外用 `this.semanticRecallEncoder !== undefined` 把闸，
     *    ⇒ 语义召回关着时**根本不投递** ⇒ 不会为一个不该被消费的通道起 497.6 MB 的 worker。
     * ⚠️ 完整性**每轮现读**（它 async 且会变）⇒ 交出去的是**读法**，不是快照。
     * ```
     */
    const maintenance = createProductionMaintenanceTrigger({
      db,
      namespace: String(kernel.characterId),
      encoderClient: semanticEncoderShared({
        manifest: embeddingManifestShared(),
        labModelRoot: LAB_MODEL_ROOT,
        deadlineMs: SEMANTIC_RECALL_DEADLINE_MS,
        readyTimeoutMs: SEMANTIC_RECALL_READY_TIMEOUT_MS,
      }),
      manifest: embeddingManifestShared(),
      readIntegrityProblems: () => memoryIntegrityProblems(db, owner),
    })

    const validator = createMemoryMutationValidator({
      registry: kernel.registry,
      sources: { findEvents: (ids) => findEventRefs(db, ids as never) },
      processed: { hasProcessed: (key) => hasProcessedOperation(db, key) },
      lookup: {
        findActiveByFingerprint: async (input) => {
          const found = await store.getActiveByFingerprint(input.owner, input.fingerprint)
          return found === null ? undefined : { memoryId: found.id }
        },
        findActiveByCanonicalKey: async (input) =>
          (await store.getActiveByCanonicalKey(input.canonicalKey)).map((r) => ({
            memoryId: r.id,
          })),
        getRecord: async (id) => (await store.get(id)) ?? undefined,
      },
      /*
       * M9.1 / ADR-072 D12：复活发射闸。这一行必须存在（D3 的教训——
       * 只读进 flags、没有消费者的开关是惰性开关；m4:test 有静态锁断言
       * `memoryRestatementRevivalEnabled` 真的被消费）。
       *
       * off（缺省）：重述照旧发射无标记 CREATE（折叠 no-op），
       * 但 D08 的写入生效检查不受它控制——折叠没生效 ⇒ write_not_effective（诚实）。
       * on：D03 四条件满足时发射复活形（带 restatement 标记），槽位复活。
       */
      features: { restatementRevivalEnabled: this.flags.memoryRestatementRevivalEnabled },
    })

    const resolver = createTargetMemoryResolver({
      get: (id) => store.get(id),
      getActiveByCanonicalKey: (key) => store.getActiveByCanonicalKey(key),
      listBySubject: (o, subject) => store.listBySubject(o, subject),
      /*
       * ⚠️ **不**注入语义判别器（第 5 步）。
       *
       * 缺省 = 多条候选时返回 `ambiguous`。这是一个**安全**的缺省：
       * 报 ambiguous 让人来处理，猜错则是一次不可见的错误写入 ——
       * 而"改错一条记忆"比"没能改"严重得多。
       */
    })

    // ADR-108：同一开关控制语义意图与内容兜底，所有 main.ts 聊天入口共用。
    const invokeMemoryModel = async (prompt: string): Promise<string> =>
      (await callModelText(this.runtime, prompt, { signal: AbortSignal.timeout(15_000) })).text
    const service = createExplicitMemoryService({
      // `NativeMemoryStore.apply()` 的结构满足 `MemoryFoldPort`
      // （见那一行注释："由装配层把 NativeMemoryStore 适配进来"）
      store: { apply: (event) => store.apply(event) },
      validator,
      /*
       * M4.1 / D2-A：内容抽取器在这里选。
       *
       *   缺省      —— 只走规则（离线安全、确定性、可解释），与 M4 逐字节一致
       *   开关打开  —— 规则 → 模型兜底（`ChainedContentExtractor`）
       *
       * ⚠️ 模型那条路**只生成候选**：抽出来的内容照常过
       *    Schema 校验 / Authority / 冲突 / 去重 / 放行口，**不**直接写
       *    memory store（INV-M41-04：LLM 能帮助理解，不能直接决定持久状态）。
       *
       * ⚠️ 这一行必须存在。`CHARACTER_MEMORY_BACKGROUND_ENABLED` 之所以变成
       *    D3（一个惰性开关：打开了什么也不会发生），就是因为没有任何地方
       *    **消费**它。有一条回归锁断言本行真的读了 `memoryLlmExtractorEnabled`。
       */
      extractor: this.flags.memoryLlmExtractorEnabled
        ? new ChainedContentExtractor([
            createRuleOnlyContentExtractor(),
            new LlmContentExtractor({
              invokeModel: invokeMemoryModel,
            }),
          ])
        : createRuleOnlyContentExtractor(),
      resolveTarget: (input) =>
        resolver.resolve({
          owner: input.owner,
          text: input.text,
          ...(input.canonicalKey !== undefined ? { canonicalKey: input.canonicalKey } : {}),
          ...(input.subject !== undefined ? { subject: input.subject } : {}),
          ...(input.hints !== undefined ? { hints: input.hints } : {}),
        }),
      commitEvents: async (accepted, now) => {
        const events = (await applyAcceptedEvents(db, kernel.characterId, accepted, [], now)).domainEvents
        /*
         * M9.5 / WP4 · W1 + W3 —— **投递即返回**（**不** await）：
         *   · 一旦 await，编码就进了**用户轮次的关键路径**（冷加载 ~1.2 s）；
         *   · `semanticRecallEncoder !== undefined` 复用**已存在的事实**（探针建过 ⇔ 语义启用）
         *     ⇒ 语义关着时**根本不投递**（不会为不该消费的通道起 497.6 MB 的 worker）；
         *   · 维护失败由触发器自己的 `onError` 记日志 ⇒ **不改**这里的返回值
         *     （索引是派生结构，维护失败不能让"她记住了"变成失败）。
         *
         * ⚠️ **W3（启动补追赶）落在"首次使用"那一刻**，不是进程刚起来那一刻 ——
         *    因为触发器住在这个写入器里，而**启用闸**也在这里。对这个单用户应用，
         *    效果相同（进程起来后第一次真的写记忆时就把停机期间漏的补上）；
         *    ⚠️ 若将来要严格"进程启动即追"，得把触发器提到实例字段、在启动路径上触发。
         */
        if (this.semanticRecallEncoder !== undefined) {
          if (!semanticStartupCatchUpDone) {
            semanticStartupCatchUpDone = true
            void maintenance.trigger('startup')
          }
          if (events.length > 0) void maintenance.trigger('event')
        }
        return events
      },
      /*
       * ========================================================================
       *  M6.1 WP4 / ADR-055 `D-55b`：把**槽位冲突分析的读取端口**接进显式写入路径
       * ========================================================================
       *
       * 接在这里而不是别处，理由有三条，缺一条都会让这次的修复不成立：
       *
       *   ① 这是**生产装配那一处**（`buildGateway({dryRun:false})` 用同一个
       *      `buildMemoryWriter`）⇒ 门里跑的就是用户跑的（§4.6 的等价判据要求）。
       *   ② 修复的实质是**接通一条本来断掉的接线**：冲突分析的纯函数一直在
       *      （`conflict.ts`），但生产里**没有任何地方**构造过这个端口
       *      （全仓 `recordsInCanonicalSlot` 只出现在 `pipeline.ts` 自己与测试里）
       *      ⇒ 于是显式路径永远走不到冲突判定。
       *   ③ 语义**照抄既有门的参考实现**（`scripts/verify-m4-persistence.ts` 的那一段：
       *      active + disputed），**不新造读法** —— 这正是用户要的"同一实现"。
       */
      conflict: {
        recordsInCanonicalSlot: async ({ canonicalKey }) => {
          const active = await store.getActiveByCanonicalKey(canonicalKey)
          const disputed = (await store.list({ owner, status: 'disputed', limit: 500 })).filter(
            (record) => record.canonicalKey === canonicalKey
          )
          return [...active, ...disputed]
        },
      },
      /*
       * ========================================================================
       *  M6.1 WP5 / B① / ADR-058：correct 的**目标层兜底**读取端口
       * ========================================================================
       *
       * 接在这里的三条理由与 `conflict` 同构：
       *   ① 这是生产装配那一处（`buildGateway({dryRun:false})` 用同一个
       *      `buildMemoryWriter`）⇒ 门里跑的就是用户跑的；
       *   ② 修复的实质是**接通一条本来断掉的接线**：兜底的纯函数一直在
       *      `correction-fallback.ts`，但没有人给它喂"会话内最近写入"；
       *   ③ 语义**照抄** `memory-store.ts` 的 `listRecentExplicitWrites`
       *      （同会话 · 显式路径 · ACTIVE · 降序），复现器接的是**同一个函数**
       *      ⇒ 复现与生产接线逐字一致。
       *
       * ⚠️ 不接这一行 ⇒ 兜底不启用（可选端口的缺省语义），行为与 ADR-058 之前
       *    逐字相同 —— 回退 = 删这一行，不需要数据迁移。
       */
      recentExplicitWrites: ({ owner: o, speaker, triggerEventId }) =>
        listRecentExplicitWrites(db, { owner: o, speaker, triggerEventId }),
    })

    void owner
    return createExplicitMemoryTurnPort({
      service,
      ...(this.flags.memoryLlmExtractorEnabled ? {
        detector: createExplicitMemoryIntentDetector({
          classifier: new LlmMemoryIntentClassifier({ invokeModel: invokeMemoryModel }),
        }),
      } : {}),
    })
  }

  async open(): Promise<void> {
    // 顺序有讲究：world → entity → room → participants
    await this.runtime.ensureWorldExists({
      id: this.worldId,
      name: `${character.name}'s World`,
      agentId: this.runtime.agentId as UUID,
    })
    await this.runtime.ensureEntity({
      id: this.agentEntityId,
      names: [character.name],
      agentId: this.runtime.agentId as UUID,
      metadata: {},
    })
    await this.runtime.ensureEntity({
      id: this.userEntityId,
      names: [process.env.USER_NAME ?? 'Alex'],
      agentId: this.runtime.agentId as UUID,
      metadata: {},
    })
    await this.runtime.ensureRoomExists({
      id: this.roomId,
      name: `dm-${character.name}`,
      source: 'cli',
      type: ChannelType.DM,
      worldId: this.worldId,
    })
    await this.runtime.ensureParticipantInRoom(this.agentEntityId, this.roomId)
    await this.runtime.ensureParticipantInRoom(this.userEntityId, this.roomId)

    // -----------------------------------------------------------------------
    // 抑制 bootstrap SETTINGS provider 的启动噪声
    // -----------------------------------------------------------------------
    // SETTINGS provider 把 DM 房间当成"首次引导(onboarding)"，去找
    // "属于该用户的、metadata.settings 已初始化的 world"。我们的 world 是
    // 用**角色身份**建的（owner = 角色），所以它必然找不到，于是每次启动刷两条：
    //
    //   No world found for user during onboarding
    //   Critical error in settings provider (error=No server ownership found for onboarding)
    //
    // 这里**预跑一次白名单 composeState**：第一个用 DM message 调用
    // composeState 的路径决定 state 缓存里有什么，因此这次调用之后，
    // SETTINGS 根本不会被调用。
    //
    // 为什么放在 open()：它把"哪条命令先跑"这个偶然顺序变成确定性行为，
    // 而不是"取决于用户先敲了 --inspect 还是直接聊天"。
    //
    // 这次预组装**没有任何持久化副作用**，结果也不被使用；
    // 新链路的 prompt 仍由 ContextCompiler 独立组装（用事实账本 + 投影）。
    if (this.flags.contextCompilerV1) {
      try {
        await buildWhitelistedContext(this.runtime, {
          id: stringToUuid(`provider-warmup-${this.roomId}`),
          entityId: this.userEntityId,
          agentId: this.runtime.agentId as UUID,
          roomId: this.roomId,
          worldId: this.worldId,
          content: { text: '(warmup)', source: 'cli', channelType: ChannelType.DM },
        })
      } catch (error) {
        // 预热失败不该拦住对话：退回"照常启动，只是会有那两条噪声"
        logger.debug(
          `[turn] provider 预热失败（已忽略）: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    // 新链路：会话内序号从**数据库**推导，而不是进程内计数。
    // 干跑模式不写库、序号不前进，否则第二次干跑会撞上第一次的序号
    // （撞上时新链路会把它当成幂等命中，表现为"这句没记进去"）。
    if (this.gateway && this.kernel) {
      const last = await latestConversationSequence(
        this.kernel.stores.db,
        this.kernel.characterId,
        this.gatewayConversationId()
      )
      this.conversationSequence = last + 1
    }

    /*
     * ==========================================================================
     *  post-Lv2 / ADR-109 `D01`/`D03`：**公共生命周期只运行一次**
     * ==========================================================================
     * 下面这一整段（关系/情绪/信念建档与开机追赶、故事消费、反思与约定追赶、
     * 语义慢路径启动面）是**进程级**的：它消费的是**角色级**事件流
     * （`conversation_events.sequence`，见 `migrations.ts:131-132`），
     * 与"哪一条入口说的话"无关。
     *
     * ⇒ 一个核心 + 两个受信会话时，它必须**恰好跑一次**（owner 跑）。
     *    借用者（`consumers !== undefined`）跳过整段：它只借 owner 的实例与在飞闸。
     *
     * ⚠️ 这不是"省一点启动时间"，而是正确性：两个会话各跑一遍会重复播种、
     *    重复追赶、重复触发模型调用，而它们的 `processor_watermarks` 是**同一行**
     *    （`(character_id, processor, processor_version)`）—— 两份在飞会互相打架。
     */
    if (this.consumers === undefined) {
      await this.openSharedConsumers()
    }
  }

  /**
   * `open()` 的**共享段**：建档 / 开机追赶 / 慢路径启动面（ADR-109 `D01`）。
   *
   * ⚠️ 它只在 owner 会话上执行一次。借用者一个字都不跑。
   */
  private async openSharedConsumers(): Promise<void> {
    /*
     * ==========================================================================
     *  M7 / ADR-064 D-6：ORIGIN 播种（用户授权基线，U-M7-02）
     * ==========================================================================
     * 只在 `CHARACTER_RELATIONSHIP_CONTEXT_ENABLED` 打开时执行（缺省 off，
     * 先例 ADR-048：接线就位、激活另裁）。走完整放行链（提案 → Validator →
     * applyAcceptedEvents），幂等（已有投影 ⇒ no-op）。
     *
     * ⚠️ 干跑（--test）**不播种**：播种是一条域事件写入，而干跑的规矩是
     *    "这次测试对她而言等于没发生过"。干跑仍会**读**真实投影（如果之前
     *    真实模式建过档），这与 stateSection 读真实状态是同一条纪律。
     */
    if (this.flags.relationshipContextEnabled && this.kernel && !this.dryRun) {
      const outcome = await seedRelationshipOrigin(
        this.runtime,
        this.ids.characterId,
        this.ids.userId
      )
      logger.info(`[m7] 关系基线播种：${outcome.seeded ? '已建档' : '跳过'} —— ${outcome.reason}`)
      /*
       * WP6 生产调度（追赶）：开机把水位之后的尾窗评估掉——
       * 重启恢复的承载点（上次会话没消费完的窗口在这里补上）。
       * 失败不抛（maybeRunRelationshipEvaluation 内部吞掉进 job），
       * 聊天不受影响；下一轮的尾窗会再覆盖同一批事件。
       */
      const scheduling = await maybeRunRelationshipEvaluation(this.kernel.stores.db, {
        characterId: this.kernel.characterId,
        owner: relationshipOwnerOf(this.kernel.characterId),
      })
      logger.info(`[m7] 关系评估追赶：${describeScheduling(scheduling)}`)
    }

    /*
     * ==========================================================================
     *  M8 / ADR-066 §6.3：建档（含中断恢复）+ 开机追赶
     * ==========================================================================
     * 只在 `CHARACTER_AFFECT_CONTEXT_ENABLED` 打开时执行（缺省 off，先例
     * ADR-048/065）。`maybeRunAffectEvaluation` 一个入口三件事：
     *   · 未建档 ⇒ 播种 AFFECT_ORIGIN（0/0 中性起点 + cutover=当前账本最大序号，
     *     走唯一放行口，幂等）；
     *   · 已建档但水位落后于 cutover ⇒ 中断播种恢复（补推进）；
     *   · 尾窗非空 ⇒ 消费（上次会话没消费完的窗口在这里补上）。
     * 失败不抛（内部进 job/如实返回），聊天不受影响。
     *
     * ⚠️ 干跑（--test）**不执行**：播种/消费都是域事件写入，干跑的规矩是
     *    "这次测试对她而言等于没发生过"。干跑仍会**读**真实投影（如果之前
     *    真实模式建过档），与 stateSection 读真实状态是同一条纪律。
     */
    if (this.flags.affectContextEnabled && this.kernel && !this.dryRun) {
      const scheduling = await maybeRunAffectEvaluation(this.kernel.stores.db, {
        characterId: this.kernel.characterId,
        activeUserId: this.ids.userId,
        // M8.5 WP8：semantic 模式**且已激活**才让位（未激活 ⇒ M8 全路径照常）
        suppressImpacts: await this.semanticActive(),
        // M8.5 WP11：按投影行注册面选折叠器（@2 章 ⇒ @2 折叠——§23 回滚路径）
        affectReducerVersion: await this.affectReducerVersion(),
      })
      logger.info(`[m8] 情绪评估追赶：${describeAffectScheduling(scheduling)}`)
      /*
       * M8.5 WP8：语义慢路径的启动面（§8.1——崩溃/通知丢失后从持久水位补发现）。
       * · semantic（已激活）⇒ 追赶 tick（await：启动无回复延迟可放大；
       *   过期 source 不出站，有界）；
       * · 其余（rules / shadow / 旗设了但未激活）⇒ 模式切换取消扫面
       *   （回滚收拢：遗留的未终结 source 写 CANCELLED 终态闸；无遗留 ⇒
       *   no_pending，零写）。
       */
      if (await this.semanticActive()) {
        await this.drainSemanticTail()
      } else {
        const sweep = await cancelPendingAffectSemanticSources(this.kernel.stores.db, {
          characterId: this.kernel.characterId,
          characterAlias: character.name,
          activeUserId: this.ids.userId,
          provider: (this.semanticProvider ??= createOpenAiAffectSemanticProvider()),
        })
        if (sweep.kind === 'cancelled') {
          logger.info(`[m8.5] 模式切换取消扫面：${describeAffectSemanticSweep(sweep)}`)
        }
      }
    }

    /*
     * ==========================================================================
     *  M9 / ADR-070 §6.3：信念双流——建档 + 开机追赶（WP6 装配）
     * ==========================================================================
     * 只在 `CHARACTER_BELIEF_ENABLED` 打开时执行（缺省 off，先例
     * ADR-048/065/067）。两条独立输入流、各自水位、互不阻塞：
     *   · 流 1 `maybeRunBeliefEvaluation`（对话尾窗 → B-INFERRED）：
     *     未建档 ⇒ 播种 BELIEF_ORIGIN（cutover=当前账本最大序号，切换前
     *     历史不重放）；已建档但水位落后于 cutover ⇒ 中断播种恢复；
     *     尾窗非空 ⇒ 消费（上次会话没消费完的窗口在这里补上）。
     *   · 流 2 `maybeRunBeliefMemoryReconciliation`（Memory 域事件尾窗 →
     *     B-REPORTED + 依赖失效传播）：不建档（Memory 是既有域）。
     * 失败不抛（内部进 job/如实返回），聊天不受影响。
     *
     * ⚠️ turn hook ≠ 新建自主后台任务（计划 WP6 出口）：本块只挂在
     *    open（这里）/send（轮内+轮后）两个既有钩子上，没有定时器。
     * ⚠️ 干跑（--test）**不执行**：播种/消费都是域事件写入，干跑的规矩是
     *    "这次测试对她而言等于没发生过"。
     */
    /*
     * **S8 / ADR-094 `D01`（消费点）+ `R-2` 选项 A（生产内容包）**：
     * 故事认知的**真实消费点**。
     *
     * ```text
     * 关着：整块不执行（连账本端口都不构造）—— 与 M9 信念块同一条规矩
     * 开着：构造装配（世界账本 + 独立水位 + 生产入口 + 消费回路）并**跑一圈消费**
     * ```
     *
     * ⚠️ 这个 `if` 就是 `D01` 的**消费者**：`pnpm m4:test` 的消费锁断言
     *    `src/main.ts` 里必须**同时**出现 `storyCognitionEnabled` 与 `consumeOnce`
     *    —— 只加开关不接消费 = `CHARACTER_MEMORY_BACKGROUND_ENABLED` 那个 NOT-WIRED 惰性开关。
     * ⚠️ 干跑（`--test`）**不执行**：消费会写 `AFFECT_*` 域事件，干跑的规矩是
     *    "这次测试对她而言等于没发生过"。
     * ⚠️ **诚实边界（2026-10-04 修订）**：affect / relationship / reflection **三个消费者都已接通**
     *    （见 `story-cognition.ts` 的边界段；`edfdb195` + `7bde509e`）。但三个水位**都停在 0**，
     *    真因是**入口侧没有调用者**（`ingestChoice` 在生产里未被调用 ⇒ `storyline_commits` 永远 0 行），
     *    不是"没接线"。立案：`docs/post-lv2/S8-Consumption-Entry-Gap.md`（`L-S8-30`）。
     * ⏩ **2026-10-07 修订（上面这段已过时；只追加，不改写原文）**：入口**已经存在** ——
     *    开局 `main.ts:7316`（`runStoryStartCommand`，`postlv2:s8:start:verify` 守它）+
     *    同轮选择 `main.ts:3775-3778`（`resolveDailyTurn` ADR-115 / `resolveChoiceTurn` ADR-107 → `commitStoryTurn`）。
     *    `ingestChoice` 这个**直接**入口仍无调用者，但它不再是唯一入口；`pnpm postlv2:s8:daily:e2e` 在隔离库里
     *    实测 `storyline_commits` **恰好 3 行**（`STORY_STARTED` + 2×`CHOICE_COMMITTED`），三个水位 = 提交数
     *    ⇒ "永远 0 行"已不成立；`L-S8-30` 是否销账由维护线裁定。
     */
    if (this.flags.storyCognitionEnabled && this.kernel && !this.dryRun) {
      const cognition = createStoryCognition({
        db: this.kernel.stores.db,
        characterId: this.kernel.characterId,
        pack: JICHUANG_PACK,
        /* 显式注入真 provider：消费回路**会**发模型请求（反思必须调模型） */
        provider: createOpenAiReflectionDraftProvider(),
        adaptiveEnabled: this.flags.adaptiveSelfEnabled,
        userId: this.ids.userId,
        now: () => Date.now(),
      })
      /* 存起来给**每轮**的选择解析复用（`ADR-107` `R-1b` 的调用点；见字段注释） */
      this.storyCognition = cognition
      const consumed = await cognition.consumeOnce()
      logger.info(
        `[s8] 故事认知消费：${
          consumed.progress
            .map(
              (row) =>
                `${row.consumer}→${String(row.advancedTo)}${
                  row.failedAt === undefined
                    ? ''
                    : `(停于 ${String(row.failedAt.revision)}: ${row.failedAt.code})`
                }`
            )
            .join(' · ') || '（无可消费项）'
        }`
      )
    }

    if (this.flags.beliefEnabled && this.kernel && !this.dryRun) {
      const scheduling = await maybeRunBeliefEvaluation(this.kernel.stores.db, {
        characterId: this.kernel.characterId,
        activeUserId: this.ids.userId,
        activationId: 'open-catchup',
      })
      logger.info(`[m9] 信念交互流追赶：${describeBeliefScheduling(scheduling)}`)
      const memoryScheduling = await maybeRunBeliefMemoryReconciliation(
        this.kernel.stores.db,
        { characterId: this.kernel.characterId },
      )
      logger.info(`[m9] 信念 Memory 流追赶：${describeBeliefMemoryScheduling(memoryScheduling)}`)
    }

    /*
     * ==========================================================================
     *  M11 / ADR-085 §7.1：**反思慢路径**的接线（`L-M11-20` 的修复）
     * ==========================================================================
     * ⚠️ 补的是什么：WP7 建了调度、WP3–WP5 建了各段零件、WP9 的 e2e 门在**测试里**把它们
     *    串起来跑通过 —— 但 `main.ts` **从来没有**调用过 `maybeRunReflectionEvaluation`，
     *    也就是说**生产里没有任何东西会跑这条慢路径**（与 M10 的 `goalTokens` 从未接线同型）。
     *
     * 三条纪律与其它域一致：
     *   · **开关关 ⇒ 什么都不发生**（`CHARACTER_REFLECTION_ENABLED` 代码缺省 false）
     *   · **干跑不执行**（消费会写域事件；干跑的规矩是"这次测试等于没发生过"）
     *   · **失败不抛**：调度内部把失败落成 `failed` 任务且**不前进水位**，聊天不受影响
     *   · **不回判历史**（`D33`）：首次调用把 cutover 预置成**此刻**的账本边界（见调度器）
     */
    await this.drainReflectionTail(true)
    /*
     * M10.1 / ADR-086 `D02`：**开库时的约定识别追赶**（与反思那条并列）。
     * ⚠️ 关着时 `drainAgreementTail` 自检返回 ⇒ 连水位行都不建（与接线前逐字相同）。
     */
    await this.drainAgreementTail(true)
    if (this.flags.memoryEnabled && (this.flags.memoryPostTurnModelEnabled || this.flags.memoryAutomaticEnabled) && this.kernel && !this.dryRun) {
      const python = process.env.CHARACTER_MEMORY_AUTOMATIC_PYTHON
      if (!python && !this.flags.memoryPostTurnModelEnabled) throw new Error('CHARACTER_MEMORY_AUTOMATIC_PYTHON is required when automatic memory is enabled')
      const kernel = this.kernel
      const owner = entityRef('character', String(kernel.characterId))
      const maintenance = createProductionMaintenanceTrigger({
        db: kernel.stores.db, namespace: String(kernel.characterId),
        encoderClient: semanticEncoderShared({ manifest: embeddingManifestShared(), labModelRoot: LAB_MODEL_ROOT,
          deadlineMs: SEMANTIC_RECALL_DEADLINE_MS, readyTimeoutMs: SEMANTIC_RECALL_READY_TIMEOUT_MS }),
        manifest: embeddingManifestShared(), readIntegrityProblems: () => memoryIntegrityProblems(kernel.stores.db, owner),
      })
      const onReading = (reading: import('./infrastructure/runtime/automatic-memory.ts').AutomaticMemoryReading) => {
        logger.info(`[automatic-memory] ${JSON.stringify(reading)}`)
        if (reading.created > 0 && this.semanticRecallEncoder !== undefined) void maintenance.trigger('event')
      }
      this.automaticMemory = this.flags.memoryPostTurnModelEnabled ? new PostTurnModelMemoryConsumer({
        db: kernel.stores.db, characterId: kernel.characterId, speaker: entityRef('user', this.ids.userId), registry: kernel.registry,
        invoke: async (prompt) => (await callModelText(this.runtime, prompt, { temperature: 0, maxTokens: 4096, signal: AbortSignal.any([this.automaticMemoryAbort.signal, AbortSignal.timeout(30_000)]) })).text,
        onReading,
      }) : new AutomaticMemoryConsumer({
        db: kernel.stores.db, characterId: kernel.characterId, speaker: entityRef('user', this.ids.userId), registry: kernel.registry,
        extractor: new LangMemMemoryExtractor({ python: python!, signal: this.automaticMemoryAbort.signal }),
        onReading,
      })
      await this.automaticMemory.open()
    }
  }

  /** 本会话的 id（未启用 kernel 时抛错，调用方都先检查了 gateway） */
  private gatewayConversationId() {
    if (!this.gateway) throw new Error('TurnGateway 未启用')
    return this.gateway.conversationId
  }

  /**
   * post-Lv2 / ADR-109 `D03`：**故事装配实例**（借用者复用 owner 建的那一个）。
   *
   * ⚠️ 借用者**不能**自己造一个：故事账本端口是 `main.ts` 里那条被 `FC-T04`
   *    边界锁守着的依赖，一个进程里造两份会让"谁在消费"变成两处。
   */
  private get story(): ReturnType<typeof createStoryCognition> | undefined {
    return this.consumers === undefined ? this.storyCognition : this.consumers.storyCognition
  }

  /**
   * post-Lv2 / ADR-109 `D03`：把自己**作为共享消费者执行者**交给另一条入口会话。
   *
   * ⚠️ 只有 owner 会话该调它（`consumers === undefined`）。借用者调它会造出一个
   *    "转交给自己"的循环 ⇒ 这里**明确抛**，而不是让它在运行期变成无限递归。
   * ⚠️ `storyCognition` 是**取值器**：它在 `open()` 里才被赋值，取值时机必须晚于 `open()`。
   */
  sharedConsumerDelegate(): SharedConsumerDelegate {
    if (this.consumers !== undefined) {
      throw new Error('借用者会话不能作为共享消费者执行者（ADR-109 D03）')
    }
    const session = this
    return {
      drainAutomaticMemoryTail: () => session.drainAutomaticMemoryTail(),
      drainReflectionTail: (recover) => session.drainReflectionTail(recover),
      drainAgreementTail: (recover) => session.drainAgreementTail(recover),
      drainStoryTail: () => session.drainStoryTail(),
      drainSemanticTail: (traceId) => session.drainSemanticTail(traceId),
      get storyCognition() {
        return session.storyCognition
      },
    }
  }

  /**
   * 后 Lv2 · WP1：桥需要的**身份读面**（只读；外壳**不能**改）。
   *
   * ⚠️ 角色与会话来自 `resolveIds()` 与 `buildGateway` 的构造绑定，
   *    而不是来自任何请求载荷 —— 因此"外壳换个 id 就能跟她说话"在类型上不可能
   *    （`INV-PL2-08`）。
   */
  get characterId(): string {
    return this.ids.characterId
  }

  /**
   * Lv4.5 / `P2`：**只读准备**（桥的 `PREPARE_TURN` 背后的那一半）。
   *
   * ============================================================================
   *  它做什么，以及它**保证不**做什么
   * ============================================================================
   * ```text
   * 做：   用候选文本跑一遍**只读**召回（`TurnGateway.prepareTurn`），
   *        回一个"候选版本 + 命中 id 与计数"
   * 不做： 不写用户消息、不落事件、不推进序号、不写记忆、不调模型、不产出她的话
   * ```
   * ⚠️ 这与 `send()` 是**两条**路径：`send()` 是正式轮次（`beginTurn → 模型 → 守卫 →
   *    `completeTurn`），本方法**一步都不碰**它。一轮话只该有一条 `user_message`；
   *    反复"准备"不得把它变成七八条。
   *
   * ⚠️ `candidateRevision` 由**两个输入**决定：
   * ```text
   * ① 候选文本本身（改口 ⇒ 立刻不同）
   * ② 当前的**投影修订**（`projectionRevisions`）—— 记忆/信念/关系等投影变了，
   *    同文本的召回结果也可能不同 ⇒ 旧候选同样作废
   * ```
   * 因此外壳只需比较这个字符串就能判断"我手里那份候选还算不算数"，
   * 不必再问 LG 一次。
   */
  async prepare(userText: string): Promise<{
    candidateRevision: string
    recall: {
      status: 'ran' | 'failed' | 'not_searched'
      cause?: string
      selectedCount: number
      selectedMemoryIds: readonly string[]
    }
    wroteAnything: false
  }> {
    if (this.gateway === undefined || this.kernel === undefined) {
      throw new Error('只读准备需要 Character Kernel 已启用')
    }
    const prepared = await this.gateway.prepareTurn({
      userText,
      /* 与 `send()` 用**同一个**遮蔽计算器（`withdrawnContextMaskingEnabled` 的同一处消费点）：
         撤销遮蔽本身是只读的，而"已撤销的正文能不能当证据"在准备与正式轮次里必须一致。 */
      ...(this.flags.withdrawnContextMaskingEnabled
        ? {
            withdrawnMasking: (() => {
              const store = createNativeMemoryStore(this.kernel!.stores.db)
              const owner = entityRef('character', String(this.kernel!.characterId))
              return {
                compute: () => computeWithdrawnEvidence(this.kernel!.stores.db, store, owner),
              }
            })(),
          }
        : {}),
    })
    const revisions = await projectionRevisions(this.kernel.stores.db, this.kernel.characterId)
    return {
      candidateRevision: candidateRevisionOf(userText, revisions),
      recall: {
        status: prepared.recall.status,
        ...(prepared.recall.status === 'ran'
          ? {}
          : prepared.recall.status === 'not_searched'
            ? { cause: prepared.recall.cause }
            : { cause: prepared.recall.reason }),
        selectedCount: prepared.recall.status === 'ran' ? prepared.recall.selectedMemoryIds.length : 0,
        selectedMemoryIds: prepared.recall.status === 'ran' ? prepared.recall.selectedMemoryIds : [],
      },
      wroteAnything: false,
    }
  }

  get conversationId(): string {
    return String(this.gatewayConversationId())
  }

  /**
   * 取本房间下一个可用的轮次号。
   *
   * ⚠️ 不能用进程内自增计数器：消息 id 由 `msg-{room}-{turn}-{user|agent}` 推导，
   * 而每次单独运行脚本模式时计数器都从 0 开始，于是新消息会撞上上一轮运行留下的 id，
   * 被 `createMemory(..., unique=true)` 的 onConflictDoNothing **静默丢弃**——
   * 表现为「聊了但历史没涨」。实测确认过这个 bug。
   *
   * 以数据库里已有的消息条数为基准，跨进程也能单调递增。
   */
  private async nextTurn(): Promise<number> {
    const existing = await this.runtime.getMemories({
      tableName: 'messages',
      roomId: this.roomId,
      count: 1000,
    })
    // 干跑模式不写库，数据库条数不会增长，所以要叠加本轮已进行的轮数，
    // 否则同一进程内连续多轮会算出同一个 turn、消息 id 相撞。
    const base = existing.length
    this.turn = base
    return base + this.dryRunTurns + 1
  }

  /**
   * 把"下一轮该用几号"重新对齐到**账本的实际末尾**（`+1`）。
   *
   * ⚠️ 为什么必须有它（2026-10-05 会话跳号事故）：
   *   会话内序号原来只在**两处**赋值 —— `open()` 的"末尾 + 1"与 `send()` 里
   *   `beginTurn()` 之后的 `incoming.conversationSequence + 2`。后者是一个
   *   **预测**："本轮用户事件与助手事件都会落账"。而首句前取消 / 首句前失败时
   *   助手事件**从未产生**（`failTurn()` 只收尾 trace），预测就领先于真实账本
   *   ⇒ 同一进程的下一轮拿着一个偏大的号去写，被
   *   `ConversationRecorder.assertSequenceContiguous()` 正确地拒成
   *   `conversation_sequence_gap`，**整个后续会话都卡死**（重启才好，因为
   *   `open()` 会重读账本）。
   *
   * 修法不是"把预测改小一点"，而是**取消预测**：会话内序号的权威源是账本
   * （`conversation_events.conversation_sequence` 的最大值），不是进程内缓存。
   * 每轮开始前重读一次，于是"上一轮到底落了几条"这个事实**总是**被尊重，
   * 包括那些今天还不存在的半途失败路径（落账 0 条、1 条、2 条都对）。
   *
   * ⚠️ 干跑不重算：干跑不写库，账本最大值本来就不会动；而 `open()` 已经设好
   *    `last + 1`（干跑下 `latestConversationSequence` 只读不写，是安全的）。
   */
  private async reconcileConversationSequence(): Promise<void> {
    if (this.dryRun || !this.kernel || !this.gateway) return
    const last = await latestConversationSequence(
      this.kernel.stores.db,
      this.kernel.characterId,
      this.gatewayConversationId()
    )
    this.conversationSequence = last + 1
  }

  async send(userText: string, streaming?: {
    onSpeechSegment: (packet: CheckedSpeechSegment) => void
    signal?: AbortSignal
    onModelStart?: () => void
  }, images?: readonly ImageInput[]): Promise<string> {
    if (images !== undefined && (!this.flags.imageInputEnabled || !this.gateway || !this.flags.contextCompilerV1)) {
      throw new KernelError('validation_error', 'image_input_disabled', '图片输入尚未启用')
    }
    const checkedImages = checkImageInputs(images)
    const imageStore = this.flags.imageInputEnabled ? new ImageInputStore(productionDataDirOf()) : undefined
    if (checkedImages.length) {
      if (!this.dryRun) await imageStore!.save(checkedImages)
      userText += `\n[附带 ${checkedImages.length} 张图片]`
    }
    const turn = await this.nextTurn()
    this.turn = turn
    const agentId = this.runtime.agentId as UUID

    // 干跑模式（--test）：**也走新链路**，只是不落任何库。
    //
    // 这一点在 M2.5 里改过一次，原因值得记下来：
    //   原来 `useCompiler` 里带了 `!this.dryRun`，于是 `--test` 永远走旧路径 ——
    //   而"排查她看到了什么"最常用的入口恰恰是 `--test`。
    //   结果是：新路径的 prompt 除了跑真实对话之外没有别的观察方式，
    //   而真实对话会写库。
    //
    //   现在改成：干跑也编译（读得到真实状态与真实历史，所以测试有意义），
    //   但不写事件、不写 trace（由 ConversationRecorder 与 TurnGateway 的
    //   dryRun 守卫保证）。这既符合"测试对她等于没发生过"的既有规矩，
    //   又让 `--test` + `--dump-prompt` 能直接看到新路径的真实 prompt。
    const useCompiler = Boolean(this.gateway) && this.flags.contextCompilerV1

    // 1) 组装本轮上下文。
    //    ── 新链路（M2.5）：先写事实账本，再由 ContextCompiler 组装 ──
    //    ── 旧链路（M1）：先落 memories，再由 composeState + 模板组装 ──
    let prompt: string
    let modelImages: readonly ImageInput[] | undefined
    let incoming: Awaited<ReturnType<TurnGateway['beginTurn']>> | undefined
    /*
     * `P4` 后的时延修复：**生成段内部**的阶段计时（声明在**外层**作用域 —— 
     * 装配在下面那个 `if (useCompiler && this.gateway)` 块里，而模型/守卫/落账在块**外**，
     * 所以计时器必须活得比块长）。
     *
     * ⚠️ 动机：§3 的"首段实质语音"干净窗口 **9/9 超 5 000 ms**，而拆解显示时间几乎都在
     *    "提交 → 正文"这一段（生成 ≈22.8 s vs 合成 ≈1.9 s）。可"生成"还是黑盒
     *    ⇒ 不拆开就不知道该改装配、模型、守卫还是落账。
     */
    const phaseAt = { context: Date.now(), begin: 0, compile: 0, preCompile: 0, state: 0, guards: 0, complete: 0 }

    if (useCompiler && this.gateway) {
      /*
       * ⚠️ 2026-10-05 会话跳号事故的修复点**之一**（见 `reconcileConversationSequence`）：
       *    下一轮的会话内序号必须由**账本实际末尾**推出，不能沿用上一轮的预测。
       */
      await this.reconcileConversationSequence()
      /*
       * WP1 / ADR-104 D08：**决策阶段的上下文**（只有 role 档才读）。
       *
       * ⚠️ 为什么在这里读、而不是复用下面编译 prompt 用的那一份：
       *    ```text
       *    compileTurn 的那份 `recentLines` 是 **beginTurn 之后**才读的（含刚落账的
       *    用户行）—— 它是 prompt 的基线，一个字节都不能动。
       *    而决策发生在 beginTurn **里面**，那时还没有那份读数。
       *    ⇒ 这里多读一次（同一实现 `recentContextLinesFrom`），
       *      它是"给决策的输入"，与"给 prompt 的输入"是两份、各有各的用途。
       *    ```
       * ⚠️ 缺省 `rules` ⇒ **不读**（零额外开销），只有显式切到 role 档才有这一次读。
       */
      const decisionLines =
        this.flags.toolDecisionMode === 'role'
          ? (
              await recentContextLinesFrom(this.runtime, {
                characterId: this.kernel!.characterId,
                userName: this.userName,
                characterName: character.name,
                limit: CONVERSATION_LENGTH + 2,
                /*
                 * ADR-109 `D04`：入口作用域。开关关着 ⇒ **不传** ⇒ 角色级（M3 起的行为）；
                 * 打开 ⇒ 只读本入口那条会话 ⇒ 决策输入不会看见另一条入口的原话。
                 * ⚠️ 两处（这里与下面 prompt 的 `recentLines`）必须**同一份口径**：
                 *    一个按会话、一个按角色会让"她决定时看到的"与"她回答时看到的"不一致。
                 */
                ...(this.flags.entryScopedConversations
                  ? { conversationId: this.gatewayConversationId() }
                  : {}),
              })
            ).map((line) => `${line.speaker}：${line.text}`)
          : undefined
      incoming =
        decisionLines === undefined
          ? await this.gateway.beginTurn(userText, undefined, checkedImages.map(image => image.sourceRef))
          : await this.gateway.beginTurn(userText, { decisionLines }, checkedImages.map(image => image.sourceRef))
      /*
       * ⚠️ 这里原来写 `incoming.conversationSequence + 2`（= 预测助手事件也落账）。
       *    首句前取消 / 首句前失败时助手事件不存在 ⇒ 缓存领先账本 ⇒ 下一轮跳号。
       *    现在只推进到**已知落账的那一条用户事件**；助手事件落账后，
       *    下一轮开头的重算会把它带上（账本是权威源）。
       */
      this.conversationSequence = incoming.conversationSequence + 1
      /*
       * ==========================================================================
       *  S8 / `L-S8-30` + `ADR-107` `R-1b`：**同轮剧情选择解析**（`D02.3` 的位置）
       * ==========================================================================
       * `beginTurn` 刚把本轮用户事件写进账本 ⇒ 这里做"把用户**已经做出**的选择
       * 解析成内容包机器键"那一步：
       * ```text
       * 活跃 run（从账本折出来） → 有界输入 → **一次**私有决策调用 → 闭集 → 既有世界入口
       * ```
       * ⚠️ 四条纪律与其它域一致：
       *   · **开关关 ⇒ 连端口都不构造**（`CHARACTER_STORY_CHOICE_DECISION_ENABLED` 缺省 false；
       *     与总开关 `storyCognitionEnabled` **分列**）
       *   · **干跑不执行**（提交会写世界账本；干跑的规矩是"这次测试等于没发生过"）
       *   · **失败不抛**：结果是具名的，只记日志；聊天不受影响
       *   · ADR-115 日常模式：按本轮相关性惰性开局，以真实会话 id 绑定选择；
       *     仅相关轮把已提交场景作为世界观测送进回复上下文。
       *   · 旧手动模式仍在：没有活跃 run 时不发选择调用。
       */
      let storyWorldObservations: NonNullable<typeof incoming.worldObservations> = []
      let storyTurnScope: typeof incoming.storyTurnScope = undefined
      if (
        this.flags.storyCognitionEnabled &&
        this.flags.storyChoiceDecisionEnabled &&
        this.kernel &&
        !this.dryRun
      ) {
        try {
          const anchor = incoming.userEvent?.id
          if (anchor === undefined) {
            logger.info('[s8] 剧情选择解析：本轮没有用户事件（合成轮次）⇒ 跳过')
          } else if (this.story === undefined) {
            /*
             * ⚠️ 装配没到位（`open()` 没建、或开关在 `open()` 之后才打开）
             *    ⇒ 如实记一句，**不**在这里现造一个 —— 现造就会让 `main.ts` 多背
             *    账本 SQL 适配器那条依赖（`FC-T04` 的边界锁正是在守这件事）。
             */
            logger.info('[s8] 剧情选择解析：本轮没有可用的故事装配（`open()` 未建）⇒ 跳过')
          } else {
            const storyInput = {
              anchorConversationEventId: String(anchor),
              actorId: this.ids.userId,
              currentInput: userText,
              recentLines: decisionLines ?? [],
              decision: {
                port: createOpenAiStoryChoicePort({
                  timeoutMs: this.flags.storyChoiceDecisionTimeoutMs,
                }),
                deadlineMs: this.flags.storyChoiceDecisionTimeoutMs,
              },
            }
            const outcome = this.flags.storyDailyEnabled
              ? await this.story.resolveDailyTurn({ ...storyInput,
                  interactionRef: String(incoming.userEvent!.conversationId) })
              : await this.story.resolveChoiceTurn(storyInput)
            if ('worldObservations' in outcome) {
              storyWorldObservations = outcome.worldObservations
              storyTurnScope = outcome.kind === 'unrelated' ? 'unrelated'
                : outcome.kind === 'related' || outcome.kind === 'committed' ? 'related' : 'unavailable'
            }
            logger.info(
              `[s8] 剧情选择解析：${
                outcome.kind === 'committed'
                  ? `已提交 choice=${outcome.choiceId} rev=${String(outcome.revision)}`
                  : outcome.kind === 'rejected' || outcome.kind === 'failed'
                    ? `${outcome.kind}(${outcome.code})`
                    : `${outcome.kind}${
                        outcome.kind === 'no_active_run' || outcome.kind === 'no_candidates'
                          ? '（**没有发那次调用**）'
                          : ''
                      }`
              }`
            )
          }
        } catch (error) {
          if (this.flags.storyDailyEnabled) storyTurnScope = 'unavailable'
          logger.warn(
            `[s8] 剧情选择解析失败（**不抛**）：${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
      /*
       * ⚠️ 阶段点：`beginTurn`（写用户事件 + 开轮）到此为止。
       *    实测 `contextMs` 里最大的一块是**装配**（providers → prompt），
       *    而装配前面还有 `beginTurn` 与同轮的情绪/信念评估 —— 必须再分开，
       *    否则"该优化哪个 provider"仍然只能猜。
       */
      phaseAt.compile = Date.now()

      /*
       * ==========================================================================
       *  M8 / ADR-066 §6.3：**同轮**情绪评估（beginTurn 之后、编译之前）
       * ==========================================================================
       * beginTurn 刚把本轮用户事件写进账本 ⇒ 尾窗至少含它 ⇒ 这里同步消费：
       * 评估器（确定性规则，无 LLM，有界）→ Validator → TOUCH/IMPACT 落库。
       * 之后渲染的 affect section 读到的就是**含本轮**的投影——
       * "用户刚说完的话"影响"这一轮"的注入块（Level 1 出口条件）。
       *
       * `affectAppliedThisTurn`（reply-truth 的渲染面，ADR-066 §6.2）：
       *   flushed / no_tail ⇒ true（本轮窗口被成功处理）；
       *   failed            ⇒ false（渲染器追加如实边界行——失败不得冒充成功）。
       *
       * ⚠️ 干跑（--test）**不评估不落库**：与播种同一条纪律；渲染走
       *    `appliedThisTurn='unknown'`（干跑无法主张"本轮已应用"）。
       */
      let affectAppliedThisTurn: boolean | 'unknown' = 'unknown'
      let affectScheduling: AffectSchedulerOutcome | undefined
      if (this.flags.affectContextEnabled && this.kernel && !this.dryRun) {
        const scheduling = await maybeRunAffectEvaluation(this.kernel.stores.db, {
          characterId: this.kernel.characterId,
          activeUserId: this.ids.userId,
          // M8.5 WP8：semantic 模式**且已激活**才让位（观测带 suppressedImpacts，
          // trace 的 affect_proposal 步据此标注"让位"；未激活 ⇒ M8 全路径照常）
          suppressImpacts: await this.semanticActive(),
          // M8.5 WP11：按投影行注册面选折叠器（@2 章 ⇒ @2 折叠——§23 回滚路径）
          affectReducerVersion: await this.affectReducerVersion(),
        })
        affectScheduling = scheduling
        affectAppliedThisTurn = scheduling.kind === 'failed' ? false : true
        if (scheduling.kind === 'failed') {
          logger.warn(`[m8] 本轮情绪评估失败（降级：注入上一份有效状态 + 边界行）—— ${scheduling.error}`)
        }
      }
      /*
       * M8 WP6 任务 7/8：同轮评估的观测 → 网关六类 trace step
       * （affect_eligibility / proposal / validation / event / projection / context）。
       * `appliedThisTurn` 与 event/projection 计数**同一次观测**——
       * reply-truth 的绑定就在这里成形（ADR-066 §6.2）。
       * 映射是生产函数（affect-scheduler 导出，WP6 门测同一份）。
       * 干跑 / 开关关闭 ⇒ 不传 ⇒ trace 不追加任何 affect 步。
       */
      const affectEvaluation = affectTurnObservationOf(
        affectScheduling,
        affectAppliedThisTurn
      )

      /*
       * ==========================================================================
       *  M9 / ADR-070 §6.3：信念双流——**同轮**评估（WP6 装配）
       * ==========================================================================
       * 本轮用户事件已落账 ⇒ 尾窗非空 ⇒ 试算。新形成的信念**下一轮**才进
       * 上下文（WP7 才有注入块；本轮回复用的是编译时状态——事件先存在，
       * 投影才变化，与 M7/M8 的因果序同源）。两条流独立水位、互不阻塞：
       *   · 流 1（对话尾窗 → B-INFERRED）：本轮用户消息若命中详略信号 ⇒
       *     EVIDENCE_NOTED/FORMED/REINFORCED 同轮落库；
       *   · 流 2（Memory 域事件尾窗 → B-REPORTED + 失效传播）：本轮
       *     Memory 事件（若 memory job 先跑完）同轮转译。
       * 失败不抛（调度器内部进 job/如实返回），回复不被后台故障阻断；
       * 水位不前进 ⇒ 下一轮尾窗自动补洞（领域键跨窗口撞键）。
       * ⚠️ 干跑（--test）不评估不落库（播种同一条纪律）。
       */
      if (this.flags.beliefEnabled && this.kernel && !this.dryRun) {
        const scheduling = await maybeRunBeliefEvaluation(this.kernel.stores.db, {
          characterId: this.kernel.characterId,
          activeUserId: this.ids.userId,
          activationId: 'turn',
        })
        if (scheduling.kind === 'failed') {
          logger.warn(`[m9] 本轮信念交互评估失败（补洞语义，下一轮重覆盖）—— ${scheduling.error}`)
        } else if (scheduling.kind === 'flushed' || scheduling.kind === 'recovered') {
          logger.info(`[m9] 信念交互流（同轮）：${describeBeliefScheduling(scheduling)}`)
        }
        const memoryScheduling = await maybeRunBeliefMemoryReconciliation(
          this.kernel.stores.db,
          { characterId: this.kernel.characterId },
        )
        if (memoryScheduling.kind === 'failed') {
          logger.warn(`[m9] 本轮信念 Memory 流失败（补洞语义，下一轮重覆盖）—— ${memoryScheduling.error}`)
        } else if (memoryScheduling.kind === 'flushed') {
          logger.info(`[m9] 信念 Memory 流（同轮）：${describeBeliefMemoryScheduling(memoryScheduling)}`)
        }
      }

      /*
       * M7 / ADR-064 D-6（桥接 + 唯一注入块）。
       *
       * 开关打开时：legacy 状态块**退役关系轴**（只剩情绪，归 M8），
       * trust/closeness 由 M7 关系投影经 `relationship` section 唯一渲染——
       * 不允许双权威（ADR-064 §6）。开关关闭时：两处都与 M6.1 逐字一致。
       *
       * M8 / ADR-066 M8-D12（同一条桥接纪律的第二半）：
       * affectContextEnabled 打开时 legacy 状态块**同时退役情绪轴**——
       * valence/arousal 由 M8 投影经 `affect` section 唯一渲染。
       * 两个开关都关 ⇒ 状态块与 M6.1 逐字一致。
       */
      const relationshipAxes = !this.flags.relationshipContextEnabled
      const affectAxes = !this.flags.affectContextEnabled
      const stateSection = await renderCriticalStateSection(
        this.runtime,
        this.ids.characterId,
        this.ids.userId,
        { relationshipAxes, affectAxes }
      )
      const relationshipSection = this.flags.relationshipContextEnabled
        ? await renderRelationshipSection(
            this.runtime,
            this.ids.characterId,
            this.ids.userId
          )
        : undefined
      /*
       * M8：情绪注入块（未建档或开关关闭 ⇒ undefined ⇒ 0 个 section）。
       * 读时衰减视图（effectiveAffect）在 renderAffectSection 内结算，永不写回。
       */
      const affectSection = this.flags.affectContextEnabled
        ? await renderAffectSection(
            this.runtime,
            this.ids.characterId,
            Date.now(),
            affectAppliedThisTurn
          )
        : undefined
      /*
       * M9 / WP7：信念注入块构造器（开关关闭 ⇒ 不传 ⇒ 0 个 section + 无 trace 步）。
       * 注意与 affect 的差别：这里传的是**构造器回调**而不是预构建文本——
       * 同根去重需要"本轮召回实际选中了哪些 Memory"，那个集合只有网关内部
       * （召回之后）才知道（ADR-070 §9.3）。构造器内部完成资格回查 +
       * 同轮遮蔽 + renderBeliefSection 渲染；失败被网关 catch 成 absent。
       */
      const buildBeliefSection = this.flags.beliefEnabled
        ? async (info: { selectedMemoryIds: readonly string[] }) =>
            buildBeliefContextSection(this.runtime, {
              characterId: this.ids.characterId,
              activeUserId: this.ids.userId,
              selectedMemoryIds: info.selectedMemoryIds,
            })
        : undefined
      /*
       * M11 / WP8：行为策略注入块的状态读取器。
       *
       * ⚠️ 开关关闭 ⇒ **不传** ⇒ 0 个 section + trace 不变长（与 `buildBeliefSection` 同一条纪律）。
       * ⚠️ 额度**不**在这里决定：它只从 `recallBudget.adaptiveSelfTokens` 来（`D20`/`D34`），
       *    网关按那**一个** `ContextBudget` 渲染。这里只给**状态**。
       */
      const buildAdaptiveSelfStates = this.flags.adaptiveSelfEnabled
        ? async () => await readUsableAdaptiveSelfStates(this.kernel!.stores.db, this.kernel!.characterId, this.ids.userId)
        : undefined
      /*
       * M11 / WP8：**回复事实包**（`D21`）。
       *
       * ⚠️ 它是**程序事实**（六态之一 + 允许/不许说的表），由装配层按读数算出、
       *    交给网关记进 trace。**不**扫描回复正文 —— `DR-11`：措辞层没有启发式守卫，
       *    逐句扫描会制造假信号；真正的裁定归行为评审与人审（WP10）。
       * 在同轮旧域写入后读取当前资格和最近任务；历史失败行保留。
       */
      const buildCurrentReflectionFactPack = this.flags.adaptiveSelfEnabled
        ? () => readCurrentReflectionFactPack(this.kernel!.stores.db, this.kernel!.characterId, this.ids.userId)
        : undefined
      const recentLines = await recentContextLinesFrom(this.runtime, {
        characterId: this.kernel!.characterId,
        userName: this.userName,
        characterName: character.name,
        limit: CONVERSATION_LENGTH + 2,
        /*
         * ADR-109 `D04`（WP0 基线 §6 `R1`）：**近期窗口按入口分开**。
         *
         * ⚠️ 这是"计划 §5 的 A/B 标记不得互串"落地的那一行：不传 `conversationId`
         *    时 `recentConversationEvents` 读的是**角色级**（全部会话），于是两条入口
         *    的原文会互相进对方的 Recent 区块。
         * ⚠️ 开关关着 ⇒ 不传 ⇒ 与 M3 起逐字相同（单条会话的数据里两者返回同一批行）。
         */
        ...(this.flags.entryScopedConversations
          ? { conversationId: this.gatewayConversationId() }
          : {}),
      })
      /*
       * Lv4.5 / `P1`：**交付视图**（契约 §2 `M11`）。
       *
       * ⚠️ 它改的是**视图**，不是账：她生成过的每一句仍然完整留在
       *    `conversation_events` 里（那是生成账，谁都不删）。
       * ⚠️ 未播出的句子在这里按"没说过"处理，理由见 `applyVoiceDeliveryView`
       *    三个出口：没接入交付账 ⇒ 原样通过；整段播完 ⇒ 原样通过；
       *    否则只留播出的部分、一句都没播则整行撤掉。
       * ⚠️ 不传交付账（CLI / 干跑）⇒ 这一行是 `undefined`，
       *    `recentLines` **逐字不变** —— 既有基线不受影响。
       */
      const voiceLines =
        this.voiceDelivery !== undefined
          ? applyVoiceDeliveryView(recentLines, this.voiceDelivery, { characterName: character.name })
          : recentLines
      /*
       * M9.1 / ADR-072 D15/D21：撤销遮蔽（F-1）。开关开 ⇒ 传 compute 回调，
       * 网关在 recentLines 进任何下游之前完成遮蔽/压制（D19）+ trace（D20）。
       * 开关关 ⇒ 不传 ⇒ prompt 与 M3.5 基线逐字节相同。
       * ⚠️ 这一行就是 `withdrawnContextMaskingEnabled` 的消费点（m4:test 静态锁）。
       */
      const withdrawnMasking = this.flags.withdrawnContextMaskingEnabled
        ? (() => {
            const store = createNativeMemoryStore(this.kernel!.stores.db)
            const owner = entityRef('character', String(this.kernel!.characterId))
            return {
              compute: () => computeWithdrawnEvidence(this.kernel!.stores.db, store, owner),
            }
          })()
        : undefined

      /*
       * ⚠️ 阶段点：**同轮评估**（情绪/信念，可能各自带一次模型或嵌入调用）到此为止。
       *    它夹在 `beginTurn` 与 `compileTurn` 之间，是"装配 6.6 秒"的另一个嫌疑
       *    （另一个是 providers 本身）—— 不分开就只能猜该优化谁。
       */
      phaseAt.preCompile = Date.now()
      const packet = await this.gateway.compileTurn({
        ...(checkedImages.length ? { images: checkedImages } : {}),
        ...(imageStore ? { loadImage: (ref: string) => imageStore.load(ref) } : {}),
        turn: Object.assign(incoming, { worldObservations: storyWorldObservations, storyTurnScope }),
        chatChannel: { current: this.entryKey, reminderChannels: reminderRuntimeChannels },
        currentInput: userText,
        recentLines: voiceLines,
        ...(incoming.userEvent !== undefined && !this.dryRun ? { runReminderTurn: async (lines, withdrawn) => {
          const source = incoming!.userEvent!
          const current: ReminderSource = { id: String(source.id), text: userText, createdAt: source.createdAt }
          const recent = lines.filter(line => (line.actorType === 'user' || line.actorType === 'character') && line.createdAt !== undefined && line.id !== source.id)
            .slice(-24).map(line => ({ id: String(line.id), text: [...line.text].slice(0, 500).join(''), createdAt: line.createdAt!, actor: line.actorType as 'user' | 'character' }))
          if (!reminderCandidate(userText, recent)) return { kind: 'none' as const }
          let ownerRef: string
          try { ownerRef = readQqPrivateConfig(process.env).ownerId ?? this.ids.userId } catch { ownerRef = this.ids.userId }
          const rows = await listPendingIntents(this.kernel!.stores.db, this.kernel!.characterId, {
            kind: 'reminder', ownerRef, conversationRef: source.conversationId, editable: true, limit: 20,
          })
          const pending = rows.filter(row => row.scheduledAt > Date.now() && withdrawn?.ok !== false &&
            !row.sourceRefs.some(ref => withdrawn?.withdrawnEventIds.includes(ref))).map(row => ({ id: String(row.id), text: row.text!, dueAt: row.scheduledAt, sourceRefs: row.sourceRefs, channel: row.deliveryChannel }))
          const result = await runReminderTurn({ current, recent, pending, now: Date.now(),
            entry: this.entryKey, availableChannels: reminderRuntimeChannels,
            enabled: this.flags.qqProactiveMode === 'on' && this.flags.entryScopedConversations && reminderRefreshHook !== undefined,
          }, {
            resolve: resolveReminder,
            create: async request => {
              const created = await createIntent(this.kernel!.stores.db, { id: `qni:${randomUUID()}` as NotificationIntentId,
                characterId: this.kernel!.characterId, ownerRef, conversationRef: source.conversationId, kind: 'reminder',
                deliveryChannel: request.channel,
                sourceRefs: request.sourceRefs, scheduledAt: request.dueAt, timezone: request.timezone,
                planVersion: 1, permissionVersion: 'reminder-intake@1', policyVersion: 'policy@1', text: request.text,
                dedupeKey: reminderDedupeKey({ sourceEventId: request.timeSourceId, dueAt: request.dueAt }),
        /* ★ S3 ③ 写侧 3/3（ADR-129 D05/D07）：把重复模式交给 store 落库（缺省 = 不传 = null = 旧行为） */
        ...(request.repeatMode === undefined ? {} : { repeatMode: request.repeatMode }),
              })
              if (created.intent === undefined) throw new Error('reminder_create_without_readback')
              return { id: String(created.intent.id), created: created.created, text: created.intent.text!, dueAt: created.intent.scheduledAt, sourceRefs: created.intent.sourceRefs, channel: created.intent.deliveryChannel }
            },
            update: async (target, text, refs, channel) => {
              const row = rows.find(row => String(row.id) === target.id)
              return row !== undefined && await updateReminderText(this.kernel!.stores.db, row, text, refs, Date.now(), channel)
            },
          })
          logger.info(`[qq-proactive] 提醒入口：${result.kind}${'code' in result ? ` (${result.code})` : ''}`)
          if (result.kind === 'scheduled' || result.kind === 'updated') await reminderRefreshHook?.()
          return result
        } } : {}),
        stateSection,
        // Lv4 / ADR-102：开关集中在 flags.ts（2026-10-07 从裸 process.env 收进）
        ...(this.flags.expressiveSpeechEnabled ? { expressiveSpeech: true } : {}),
        // M9.1：撤销遮蔽（开关关闭 ⇒ 不传 ⇒ 0 步 trace、逐字节基线）
        ...(withdrawnMasking !== undefined ? { withdrawnMasking } : {}),
        // M7：关系注入块（未建档或开关关闭 ⇒ undefined ⇒ 0 个 section）
        ...(relationshipSection !== undefined ? { relationshipSection } : {}),
        // M8：情绪注入块（未建档或开关关闭 ⇒ undefined ⇒ 0 个 section）
        ...(affectSection !== undefined ? { affectSection } : {}),
        // M9：信念注入块构造器（开关关闭 ⇒ 不传 ⇒ 0 个 section + 无 belief_context 步）
        ...(buildBeliefSection !== undefined ? { buildBeliefSection } : {}),
        // M11：行为策略块（开关关闭 ⇒ 不传 ⇒ 0 个 section + 无 adaptive_self_context 步）
        ...(buildAdaptiveSelfStates !== undefined ? { buildAdaptiveSelfStates } : {}),
        // M11：回复事实包（只进 trace 的状态与计数；不扫描正文）
        ...(buildCurrentReflectionFactPack !== undefined ? { buildReflectionFactPack: buildCurrentReflectionFactPack } : {}),
        // M8 WP6：同轮评估观测 → 六类 affect trace step（不传 = 本轮无评估）
        ...(affectEvaluation !== undefined ? { affectEvaluation } : {}),
        /*
         * M5.5.1 WP6：把**真实时刻**交给她。
         *
         * 在这一次 `compileTurn` 里取一次 `Date.now()`，而不是让每一层各取一次：
         * 于是"她看到的时刻"与 trace 里那条 `clock:` 引用是**同一个数**。
         *
         * ⚠️ 干跑（`--test`）也注入：它不写库，但必须让她看到与真实一轮**同样的**
         *    prompt —— 否则"用 --test 排查她为什么会说那种话"就又不成立了。
         */
        clockEpochMs: Date.now(),
        /*
         * ====================================================================
         *  M10 / `G-2`：**目标域接线点**（每轮一处）
         * ====================================================================
         * ```text
         * 端口决定"接没接上"，`goalsEnabled` 决定"接上了要不要用" —— 两者缺一不可
         * （只写其一正是 M4 那个惰性开关 D3 的成因）。
         * ```
         * ⚠️ **关着时（缺省）**：这个三元表达式**不调** `buildGoalTurnPort()` ⇒
         *    一个端口都不构造、不读清单、不构造 provider ⇒ 与接线前**行为逐字相同**
         *    （`runGoalTurn` 不传 ⇒ 网关那条链整段不跑 ⇒ 五个 trace 读数不变长）。
         * ⚠️ **开着时**：这一轮会**真的调模型**（语义理解）并可能**写领域事件** ——
         *    所以缺省必须是 off（与召回不同：召回是**只读**的）。
         */
        ...(this.flags.goalsEnabled ? { runGoalTurn: this.buildGoalTurnPort() } : {}),
      })
      prompt = this.gateway.promptFor(packet)
      modelImages = packet.images

      if (DEBUG_CONTEXT) {
        logger.info(
          `[turn ${this.turn}] ContextCompiler ${packet.compilerVersion}: ` +
            `sections=[${packet.sections.map((s) => s.id).join(', ')}]` +
            `${packet.droppedSectionIds.length ? ` 裁剪=[${packet.droppedSectionIds.join(', ')}]` : ''} ` +
            `| ~${packet.estimatedTokens} tokens | prompt ${prompt.length} 字符`
        )
      }
    } else {
      // 1a) 先落库用户消息——Recent Messages 立刻就能看到它
      const userMessage: Memory = {
        id: stringToUuid(`msg-${this.roomId}-${turn}-user`),
        entityId: this.userEntityId,
        agentId,
        roomId: this.roomId,
        worldId: this.worldId,
        content: { text: userText, source: 'cli', channelType: ChannelType.DM },
      }
      // 干跑模式下不写库：这条消息只存在于本轮内存里
      if (!this.dryRun) {
        await this.runtime.createMemory(userMessage, 'messages', true)
      }

      phaseAt.preCompile = Date.now()
      const ctx = await compileLegacyContext(this.runtime, userMessage)
      prompt = ctx.prompt

      if (DEBUG_CONTEXT) {
        const lines = ctx.contributions.map((c) => `${c.name}(${c.chars})`).join(', ')
        logger.info(
          `[turn ${this.turn}] providers: ${lines || '(none)'} | 估算历史行数: ${ctx.recentMessageCount} | prompt ${ctx.prompt.length} 字符`
        )
      }
    }

    /*
     * ⚠️ 上下文装配**到此结束**（`phaseAt` 的第二个点）：它包含 `createMemory(userMessage)`
     *    与 `compileTurn`（providers → prompt）。
     */
    const contextMs = Date.now() - phaseAt.context
    /* ⚠️ 把 `contextMs` 再拆成三段：`beginTurn` / **同轮评估** / `compileTurn`（providers → prompt） */
    const beginTurnMs = phaseAt.compile - phaseAt.context
    const evaluationsMs = phaseAt.preCompile - phaseAt.compile
    const compileMs = Date.now() - phaseAt.preCompile
    phaseAt.state = Date.now()
    // 2) 标记真实互动：推进挂钟衰减的锚点。
    //      必须在模型看到状态之前做，否则 CHARACTER_STATE provider 结算出的
    //      「分开时长」会包含刚刚这段、就发生在眼前的间隔。
    //      干跑模式下**不推进**：测试不该改变她的任何时间戳。
    const previous = await resolveCurrentState(
      this.runtime,
      this.ids.characterId,
      this.ids.userId
    )
    const gapMinutes = (Date.now() - previous.state.lastInteractionAt) / 60000
    if (!this.dryRun) {
      await markInteraction(this.runtime, this.ids.characterId, this.ids.userId)
    }
    if (gapMinutes >= 1) {
      logger.info(`[turn ${this.turn}] 距上次互动 ${gapMinutes.toFixed(1)} 分钟`)
    }

    // 3) 调模型（ModelType.TEXT_LARGE 保持与 M1 一致：换模型类型等于换行为）
    const guardFacts = {
      /*
       * ★ A2（2026-10-10）：**本轮用户原话是不是在要求她记住**（程序事实，判据是纯函数）。
       * ⚠️ 没有用户事件（主动轮等）⇒ **不传**：那些轮次保持既有行为，只有真实用户轮才收紧/放宽 ——
       *    "接线只做一半也安全"这条在调用方也要成立（`undefined` = 既有行为）。
       * 为什么必须有这一条：`post_turn_model` 模式下 `pending_post_turn` 每轮都在，
       * 替换只看她措辞 ⇒ 她把"什么意思？"答成记忆状态模板（2026-10-10 真机）。
       */
      ...(incoming?.userEvent === undefined
        ? {}
        : { userAskedToRemember: asksToRemember(String(incoming.userEvent.content ?? '')) }),
      ...(incoming?.memoryWriteResult !== undefined ? { memoryWriteResult: incoming.memoryWriteResult } : {}),
      ...(incoming?.reminderResult !== undefined ? { reminderResult: incoming.reminderResult } : {}),
      ...(incoming?.goalFact !== undefined ? { goalFact: incoming.goalFact } : {}),
      ...(incoming?.goalWriteReality !== undefined ? { goalWriteReality: incoming.goalWriteReality } : {}),
      ...(incoming?.actionResults !== undefined ? { actionResults: incoming.actionResults } : {}),
      ...(incoming?.externalEvidenceInContext !== undefined ? { externalEvidenceInContext: incoming.externalEvidenceInContext } : {}),
      ...(incoming?.turnContentInContext !== undefined ? { turnContentInContext: incoming.turnContentInContext } : {}),
    }
    const nativeVoice = nativeVoiceReplyPortFor(this.entryKey)
    if (nativeVoice !== undefined && (!useCompiler || incoming?.userEvent === undefined || incoming.assistantSequence === undefined)) {
      throw new KernelError('validation_error', 'native_voice_requires_formal_turn', '原生语音必须经正式 LG 轮次')
    }
    const nativeIdentity = nativeVoice === undefined ? undefined : {
      replyId: String(makeConversationEventId(incoming!.userEvent!.characterId, incoming!.userEvent!.conversationId, incoming!.assistantSequence!)),
      traceId: String(incoming!.traceId),
      ...(streaming?.signal === undefined ? {} : { signal: streaming.signal }),
    }
    const speechStream = nativeVoice === undefined && streaming !== undefined && incoming?.userEvent !== undefined && incoming.assistantSequence !== undefined
      && this.flags.expressiveSpeechEnabled
      ? new CheckedSpeechStream({
          replyId: String(makeConversationEventId(incoming.userEvent.characterId, incoming.userEvent.conversationId, incoming.assistantSequence)),
          traceId: String(incoming.traceId), facts: guardFacts, emit: streaming.onSpeechSegment,
        }) : undefined
    let streamed: ReturnType<CheckedSpeechStream['snapshot']> | undefined
    let streamFailure: 'interrupted' | 'cancelled' | undefined
    let call: Awaited<ReturnType<typeof callModelText>>
    const modelStarted = Date.now()
    try {
      streaming?.signal?.throwIfAborted()
      streaming?.onModelStart?.()
      call = nativeVoice !== undefined
        ? await nativeVoice.generate({ prompt, ...nativeIdentity! })
        : await callModelText(this.runtime, prompt, {
        ...(modelImages?.length ? { images: modelImages } : {}),
        /*
         * ★ 2026-10-10：主回复的 `max_tokens` 从 flags 来（缺省 4096 = 与改动前逐字相同）。
         * 为什么要有这个口子：真机事故里上游以 `finish_reason=length` 结束 ⇒ 整轮失败
         * （`model_stream_finish_length`），皮套直接抛错、对话链断。详见 flags 的 `replyMaxTokens`。
         */
        maxTokens: this.flags.replyMaxTokens,
        ...(speechStream === undefined ? {} : {
          onTextDelta: delta => {
            streaming?.signal?.throwIfAborted()
            speechStream.push(delta)
          },
          ...(streaming?.signal !== undefined ? { signal: streaming.signal } : {}),
        }),
      })
      if (speechStream !== undefined) streamed = speechStream.finish(call.text)
    } catch (error) {
      if (speechStream === undefined) {
        if (nativeVoice !== undefined && incoming !== undefined && this.gateway !== undefined) {
          await this.gateway.failTurn(incoming, new Error(streaming?.signal?.aborted ? 'native_voice_cancelled' : 'native_voice_failed'))
        }
        throw error
      }
      if (speechStream.segments.length === 0) {
        /*
         * ======================================================================
         *  首句之前就结束的一轮：**失败原因必须具名，且取消与故障必须分开**
         * ======================================================================
         *  2026-10-05 会话跳号调查里查出的**第二个观测缺口**。
         *
         *  原来无论走哪条路径都记成 `speech_stream_failed_before_sentence`：
         *  于是"用户主动打断"与"模型 / 链路自己坏了"在 trace 里长得一模一样，
         *  而这两件事的处置完全不同（前者是正常交互，后者要查 provider）。
         *
         *  ⚠️ 这里**必须抛 `KernelError`，不能原样抛 `error`** —— 这一条是实测出来的：
         *    取消时 `runtime.useModel()` 抛的是 **`DOMException`（name=AbortError）**，
         *    而它不是 `Error` 的子类实例。原样抛出时，它在"等待中的 promise 被
         *    AbortSignal 唤醒"的那条路径上被**换成**了另一个 AbortError，
         *    于是 `failTurn()` 写进 trace 的原因码**根本不生效**，桥拿到的是
         *    通用兜底 `bridge_turn_failed`（等于"这次取消没有原因"）。
         *    换成一个普通 `Error` 子类实例之后，原因码逐字到达桥与外层。
         *
         *  判据只看 `signal.aborted`（而不是 `name === 'AbortError'`）：
         *  后者会把**超时**也误记成用户取消 —— 只认我们真的按下过的那一次。
         */
        /*
         * ----------------------------------------------------------------------
         *  ★ 2026-10-10：**折码不得吞掉"有名字的"原因**（真机事故的最后一个观测缺口）
         * ----------------------------------------------------------------------
         *  上面那条规则**只对 `ChatStreamError` 成立** ⇒ 其余一切都被折成通用码，
         *  而其中最要紧的一类恰恰**不是**传输故障：`expression_invalid_envelope` /
         *  `expression_invalid_stream`（她把 `<lg-speech>` 封套写坏了——JSON 没写完、
         *  `segments` 为空、字符串里有字面换行/未转义引号……）。
         *
         *  实测后果（2026-10-10 23:32 / 23:33，皮套入口）：trace 的 `error`、桥的
         *  `[bridge] 轮次失败`、皮套的 `RuntimeError` —— **三处全都只看到
         *  `speech_stream_failed_before_sentence`**，看起来像"链路坏了"，
         *  而真实原因没有任何地方留下（正文按纪律不落库，失败轮的 trace 又**不写**
         *  `model_call`/`model_generate` 步）。
         *
         *  现在：`KernelError` 带自己的 `code` 上报；只有连名字都没有的错误才用兜底码。
         *  ⚠️ 取消判据仍然是且只是 `signal.aborted`（`name === 'AbortError'`
         *    会把**超时**也误判成用户取消 —— 见 2026-10-05 的那条实测）。
         */
        const reason = error instanceof ChatStreamError ? error.code
          : error instanceof KernelError ? error.code
            : 'speech_stream_failed_before_sentence'
        const failureCode = streaming?.signal?.aborted === true
          ? 'speech_stream_cancelled_before_sentence'
          : reason
        /*
         * 诊断**只走 stderr**：`--bridge` 的 stdout 是 NDJSON 协议通道，
         * 写在那里等于丢日志（本仓库实测过这个坑）。
         *
         * ★ 2026-10-11 扩写：连"具名 code 都没有"的错误（实测就是 `TypeError`）
         *   也必须能自己说明是哪一跳。**允许进这一行的只有**：类名 / 具名 code /
         *   传输层 message / cause 摘要 —— **不带任何正文、prompt 或 key**。
         *   ⚠️ `SyntaxError` 的 message 会把载荷片段引出来（那就是正文）⇒ 一律不带。
         */
        const compress = (value: unknown, limit: number): string =>
          String(value ?? '').replace(/\s+/g, ' ').slice(0, limit)
        const errorCause = (error as { cause?: unknown } | undefined)?.cause
        const errorDetail = error instanceof Error
          ? `${error.constructor.name}${error instanceof SyntaxError ? '' : `: ${compress(error.message, 120)}`}`
          : typeof error
        const causeDetail = errorCause instanceof Error
          ? ` · cause=${errorCause.constructor.name}` +
            `${(errorCause as { code?: unknown }).code === undefined ? '' : `(${String((errorCause as { code?: unknown }).code)})`}` +
            `: ${compress(errorCause.message, 80)}`
          : ''
        console.error(
          `[stream] 首句前结束 · 原因=${reason}（${errorDetail}）` +
            ` · 取消=${String(streaming?.signal?.aborted === true)} · 上报码=${failureCode}${causeDetail}`
        )
        if (incoming && this.gateway) await this.gateway.failTurn(incoming, new Error(failureCode))
        throw new KernelError('validation_error', failureCode, failureCode)
      }
      // Already emitted checked sentences remain in the generated record; incomplete tokens do not.
      streamed = speechStream.snapshot()
      streamFailure = streaming?.signal?.aborted ? 'cancelled' : 'interrupted'
      call = { text: '', durationMs: Date.now() - modelStarted }
    }
    /* ⚠️ 阶段点：**模型调用之前**的那一段到此为止（状态推进） */
    const stateMs = Date.now() - phaseAt.state
    phaseAt.guards = Date.now()
    const expressionDraft = nativeVoice === undefined && streamed === undefined && useCompiler && this.flags.expressiveSpeechEnabled
      ? decodeExpressiveSpeech(call.text)
      : undefined
    const modelSeconds = (call.durationMs / 1000).toFixed(1)

    /*
     * ==========================================================================
     *  M4.1 / INV-M41-03：她的行动性语言必须由**真实执行结果**驱动
     * ==========================================================================
     * 上下文里那条 `droppable: false` 的 section 是**指令**，而模型可以不听。
     * 实测：内容抽取失败时她回过"这次是 VS Code。平时主要用。"
     * —— 读起来像已经记下，而库里什么都没有，用户无从分辨。
     *
     * 因此这里加一层**确定性**守卫：本轮"没写入"而回复里出现成功口吻时，
     * 替换成一句如实表述。
     *
     * ⚠️ 替换发生在**记账本与写 memories 之前**，因此
     *    "她说过什么"（账本）、"用户看到什么"、与"库里实际发生了什么"
     *    三者保持一致 —— 否则账本会留着那句没被说出口的话。
     */
    /*
     * ---------------------------------------------------------------------------
     *  ⚠️ 后 Lv2 · WP1：五道守卫走**唯一实现**（`reply-guard-chain.ts`）
     * ---------------------------------------------------------------------------
     * 顺序是一条**契约**，而且是被事故换来的：
     *     **记忆 → 承诺 → 动作 → 外部证据 → 搜索判定**
     * 这条链原来在 `main.ts` 手写一遍、在验收 host 里再手写一遍 ——
     * 而"抄一遍"正是最危险的那种重复：**漏掉一道之后行为看起来一样**
     * （回复仍然是一句话），只是那句话**没被检查**。R3 那版 host 就真的漏掉了
     * 全部五道，门照旧 PASS。
     *
     * 因此链**只有一份**。这里保留的是它**逐字相同**的入口：喂进去的字段、
     * 拿回来的正文与三态报告都没变（下面那几个常量只是既有名字的别名）。
     */
    const guardChain = streamed?.outcome ?? runReplyGuardChain({
      replyText: expressionDraft?.text ?? call.text,
      ...guardFacts,
    })
    /**
     * 记忆守卫的结果（诊断日志用它）。
     * ⚠️ 保留既有名字 `truth`：改名收益为零，而"看着安全、其实漏掉一处"的风险很大。
     */
    const truth = {
      replyText: guardChain.replyText,
      corrected: guardChain.corrected.memoryTruth,
      markers: guardChain.markers.memoryTruth,
    }
    /** 承诺守卫的结果（它**没有**自己的 trace 名字；效果体现在它改写后的文本上） */
    const commitmentTruth = { corrected: guardChain.corrected.commitmentTruth }
    /** 动作守卫的结果 */
    const actionTruth = {
      corrected: guardChain.corrected.actionTruth,
      markers: guardChain.markers.actionTruth,
    }
    /** 证据守卫的结果（五态 + 程序追加的附录 + 被剥离的自造引用标签） */
    const evidenceTruth = {
      state: guardChain.evidenceState,
      appendix: guardChain.evidenceAppendix,
      markers: guardChain.markers.evidenceTruth,
      strippedCitationLabels: guardChain.markers.strippedCitationLabels,
      corrected: guardChain.corrected.evidenceTruth,
    }
    /*
     * M5.5.1 WP5：**判定结论**也要绑到回复上（计划 §WP5："区分未查与查了没结果"）。
     *
     * 第四道守卫，同样串联：它只处理 M5.5 五态**表达不了**的那几类"没查"——
     *   · 判定说 answer    ⇒ 未查（本来就不需要查）
     *   · 判定说 clarify   ⇒ 未查，而且该问她
     *   · 判定说 deny_search ⇒ 未查（用户明确禁止，必须尊重）
     *   · 判定缺席/超时/坏输出 ⇒ 未查，且**这是故障**（与"查了没结果"刻意用不同的句子）
     *
     * ⚠️ `L-M55-03` 的边界一寸不让：程序**没有**建立候选（`no_candidate`）时不接手，
     *    与 M5.5 逐字一致。⚠️ 仍然在写账本与写 memories **之前**。
     *
     * ⚠️ 后 Lv2 · WP1：这一道**已经在** `runReplyGuardChain` 里面（第 ⑤ 步），
     *    链返回的 `replyText` 就是判定绑定之后的正文 —— 因此这里不再重复调用，
     *    只从链的读数里取诊断面。
     */
    const needDiagnostics = searchNeedDiagnosticsOf(incoming?.actionResults)
    const needReply = {
      replyText: guardChain.replyText,
      replaced: guardChain.corrected.searchNeed,
      state: guardChain.markers.searchNeedState,
    }
    /*
     * ========================================================================
     *  ★ S4 ②（ADR-129 D08）：**跨重启补说** —— 她错过的提醒，逐条说给他听
     * ========================================================================
     *  为什么在这里：`finalReplyText` 就是"写账本 / 写 memories / 回给用户"用的那一份，
     *  在它成型的那一刻追加，三处自动一致（与证据来源附录同一条纪律：**程序追加**）。
     *  ⚠️ 追加而非替换：她这一轮该说的话一个字不动，补说只是**附在后面**。
     *  ⚠️ 补说成功 ⇒ 那批推 `delivered`（`delivered` = 内容已经到他那儿了）⇒
     *     候选集永远只是 `missed` ⇒ **天然幂等**，重复补说在结构上不可能。
     *  ⚠️ `remaining > 0` 的"还没完/要继续吗"由 `renderCatchupAnnouncement` 按裁定③
     *     （**一个批次只问一次**）决定措辞；本处只喂事实。
     */
    const catchupMissed = await listMissedIntents(this.kernel!.stores.db, this.kernel!.characterId)
    const catchupBatch = takeCatchupBatch(catchupMissed)
    const catchupText = renderCatchupAnnouncement({
      items: catchupBatch.batch, remaining: catchupBatch.remaining, alreadyAsked: false,
    })
    if (catchupText !== '') {
      for (const item of catchupBatch.batch) await finishIntent(this.kernel!.stores.db, item.id, 'delivered')
    }
    const finalReplyText = catchupText === '' ? needReply.replyText : `${needReply.replyText}\n${catchupText}`
    /*
     * ⚠️ 保留既有变量名 `replyText`：写账本、写 memories、回给用户的那几处都用它；
     *    改名会制造一次"看着安全、其实漏掉一处"的大面积改动。
     *    `replyText` 从这一行起**就是**判定绑定之后的正文。
     */
    let replyText = finalReplyText
    if (nativeVoice !== undefined) {
      try {
        streaming?.signal?.throwIfAborted()
        const checkedText = withoutAppendices(finalReplyText, [guardChain.evidenceAppendix, guardChain.turnContent.appendix])
        if (checkedText.trim() !== call.text.trim()) {
          const correction = await nativeVoice.correct({ prompt, ...nativeIdentity!, checkedText })
          const correctionGuard = runReplyGuardChain({ replyText: correction.text, ...guardFacts })
          if (withoutAppendices(correctionGuard.replyText, [correctionGuard.evidenceAppendix, correctionGuard.turnContent.appendix]).trim() !== correction.text.trim()) {
            throw new Error('native_voice_correction_rejected')
          }
          // Native audio may already be heard: retain the original utterance and the actual correction.
          replyText = [call.text, `[更正] ${correction.text}`, guardChain.evidenceAppendix, guardChain.turnContent.appendix]
            .filter(Boolean).join('\n\n')
        }
        streaming?.signal?.throwIfAborted()
      } catch (error) {
        if (incoming !== undefined && this.gateway !== undefined) await this.gateway.failTurn(incoming, new Error('native_voice_correction_failed'))
        throw error
      }
    }
    if (needReply.replaced) {
      logger.warn(`[search-need] 判定结论=${needReply.state} ⇒ 回复里的"查证成功"口吻已顶替为如实句`)
    }
    if (truth.corrected) {
      logger.warn(
        `[memory-truth] 本轮显式记忆**未执行**，而回复里出现了成功口吻` +
          `（${truth.markers.join(' / ')}）→ 已替换为如实表述`
      )
    }
    if (actionTruth.corrected) {
      logger.warn(
        `[action-truth] 本轮动作**没有成功**，而回复里出现了动作成功口吻` +
          `（${actionTruth.markers.join(' / ')}）→ 已替换为如实表述`
      )
    }
    /*
     * 附录是**设计行为**（查到证据就该有来源），因此它走 info；
     * 只有"她说了不实的话被我们改掉"或"她自造了引用标签被我们剥离"
     * 才是需要人看的异常，走 warn。
     */
    if (evidenceTruth.appendix !== '') {
      logger.info(
        `[evidence-truth] 本轮搜索 = ${evidenceTruth.state}` +
          `，已追加确定性来源附录（${evidenceTruth.appendix.split('\n').length - 1} 条）`
      )
    }
    if (evidenceTruth.markers.length > 0 || evidenceTruth.strippedCitationLabels.length > 0) {
      logger.warn(
        `[evidence-truth] 本轮搜索 = ${evidenceTruth.state}` +
          (evidenceTruth.markers.length > 0
            ? `，回复里出现了搜索成功口吻（${evidenceTruth.markers.join(' / ')}）→ 已替换为如实表述`
            : '') +
          (evidenceTruth.strippedCitationLabels.length > 0
            ? `，剥离了 ${evidenceTruth.strippedCitationLabels.length} 个模型自造的内联引用标签` +
              `（${evidenceTruth.strippedCitationLabels.join(' ')}）`
            : '')
      )
    }

    /*
     * 实用能力加装：当轮内容守卫的**同一条日志纪律**（附录是设计行为 ⇒ info；
     * 顶替口径或剥离自造标签才是需要人看的异常 ⇒ warn）。
     * ⚠️ 它**没有**自己的 trace 报告名字（受控词汇表只有四个名字），
     *    因此这里只写日志；机器读数在 `turn_content` 那一步与 run.json 里。
     */
    if (guardChain.turnContent.appendix !== '') {
      logger.info(
        `[turn-content-truth] 本轮内容 = ${guardChain.turnContent.states.map((s) => `${s.capability}:${s.state}`).join(' ')}` +
          `，已追加确定性来源与范围附录（${guardChain.turnContent.appendix.split('\n').length - 1} 条）`
      )
    }
    if (
      guardChain.turnContent.markers.length > 0 ||
      guardChain.turnContent.strippedLabels.length > 0
    ) {
      logger.warn(
        `[turn-content-truth]` +
          (guardChain.turnContent.markers.length > 0
            ? `回复里出现了读取/计算成功口吻（${guardChain.turnContent.markers.join(' / ')}）→ 已替换为如实表述`
            : '') +
          (guardChain.turnContent.strippedLabels.length > 0
            ? `剥离了 ${String(guardChain.turnContent.strippedLabels.length)} 个模型自造的内联引用标签` +
              `（${guardChain.turnContent.strippedLabels.join(' ')}）`
            : '')
      )
    }
    /*
     * ==========================================================================
     *  M6.1 WP4 / ADR-055 `D-55g`：四道守卫的**观测三态**
     * ==========================================================================
     * 三态取自**既有的返回值**，不改任何一道守卫的语义：
     *   `not_run`    这一轮没有可观测的对象（没有显式记忆指令 / 没有动作结果 /
     *                没有搜索 / 没有判定路径）—— **修复前这条分支是静默的**
     *   `passed`     守卫运行了、没有改写回复
     *   `triggered`  守卫改写了回复（替换 / 剥离）
     *
     * ⚠️ `reasons` 只放**枚举标签与标记词**（它们是短词，不含正文）。
     * ⚠️ 报告随后由网关写进 trace 的 `reply_guard` 那一步；
     *    **"守卫触发"不是产品失败**，而"回复是否违规"仍由行为门单独判（§6.3）。
     *
     * ⚠️ 后 Lv2 · WP1：报告由**唯一实现**产出（`guardChain.reports`），
     *    这里的 `needDiagnostics` 只用于**复核** `search_need` 那一条的
     *    `not_run` 判据（"判定结论缺席"）—— 与链里的判据同源。
     */
    const replyGuards: ReplyGuardReport[] = [...guardChain.reports]
    /* ⚠️ 阶段点：回复守卫链到此为止 */
    const guardsMs = Date.now() - phaseAt.guards
    phaseAt.complete = Date.now()


    if (incoming && this.gateway) {
      // 4) 收尾：写助手事件 + 跑诊断慢路径 + 收 trace。
      //    慢路径失败不会影响已经产生的回复（它只写进 trace.error）。
      const outgoing = await this.gateway.completeTurn({
        turn: incoming,
        replyText,
        modelDurationMs: call.durationMs,
        replyGuards,
      })
      if (streamed !== undefined && String(outgoing.assistantEvent?.id ?? '') !== streamed.expression.replyId) {
        await this.gateway.failTurn(incoming, new Error('speech_stream_identity_mismatch'))
        throw new KernelError('validation_error', 'speech_stream_identity_mismatch', '流式分句身份与最终助手事件不一致')
      }
      if (streamFailure !== undefined) {
        await this.gateway.failTurn(incoming, new Error(`speech_stream_${streamFailure}`))
      }
      if (DEBUG_CONTEXT) {
        logger.info(
          `[turn ${this.turn}] trace=${outgoing.trace.traceId} ` +
            `domainEvents=${outgoing.domainEventIds.length} 模型 ${modelSeconds}s`
        )
      }
      // cutover 阶段：回复同时写回 memories，保证 --history / RECENT_MESSAGES
      // 这些既有能力完全不受影响（plan 第 72 节的双写策略，Phase J 再收口）。
      if (!this.dryRun) {
        await this.runtime.createMemory(
          {
            id: stringToUuid(`msg-${this.roomId}-${turn}-agent`),
            entityId: this.agentEntityId,
            agentId,
            roomId: this.roomId,
            worldId: this.worldId,
            content: { text: replyText, source: 'cli', channelType: ChannelType.DM },
          },
          'messages',
          true
        )
      }
      /*
       * M7 / WP6 生产调度（轮后增量）：本轮事件已落账 ⇒ 试算尾窗。
       * 语义命中（感谢/指控/修复）即时消费——指控从**下一轮**的关系
       * 注入块开始影响行为（事件先存在，投影才变化：ADR-064 的因果序）；
       * 零提案则持有（R-1 的跨日累积语义）。失败不抛：这条链的另一端
       * 是"用户刚说完话"（memory job 同款纪律），下一轮尾窗自动补洞。
       */
      if (this.flags.relationshipContextEnabled && this.kernel && !this.dryRun) {
        const scheduling = await maybeRunRelationshipEvaluation(this.kernel.stores.db, {
          characterId: this.kernel.characterId,
          owner: relationshipOwnerOf(this.kernel.characterId),
        })
        if (scheduling.kind !== 'no_tail') {
          logger.info(`[m7] 关系评估（轮后）：${describeScheduling(scheduling)}`)
        }
      }
      /*
       * M8 / ADR-066 §6.3：**轮后幂等补消费**。同轮评估已消费本轮用户事件；
       * 这里补上刚落账的回复事件（她的输出永远不合格 ⇒ 0 提案，但水位前进，
       * 尾窗保持有界）。失败不抛；下一轮的同轮评估天然补洞（领域键跨窗口撞键）。
       */
      if (this.flags.affectContextEnabled && this.kernel && !this.dryRun) {
        const scheduling = await maybeRunAffectEvaluation(this.kernel.stores.db, {
          characterId: this.kernel.characterId,
          activeUserId: this.ids.userId,
          // M8.5 WP8：semantic 模式**且已激活**才让位（未激活 ⇒ M8 全路径照常）
          suppressImpacts: await this.semanticActive(),
          // M8.5 WP11：按投影行注册面选折叠器（@2 章 ⇒ @2 折叠——§23 回滚路径）
          affectReducerVersion: await this.affectReducerVersion(),
        })
        if (scheduling.kind === 'failed') {
          logger.warn(`[m8] 情绪评估（轮后）失败—— ${scheduling.error}`)
        }
      }
      /*
       * M9 / ADR-070 §6.3：**轮后幂等补消费**（与 M8 同款纪律）。
       * 同轮评估已消费本轮用户事件；这里补上刚落账的回复事件——她的输出
       * 永远不合格（actorType=character 不在资格四条内）⇒ 0 提案，但水位
       * 前进，尾窗保持有界。流 2 同理补上本轮可能新落的 Memory 域事件。
       * 失败不抛；下一轮的同轮评估天然补洞（领域键跨窗口撞键）。
       */
      if (this.flags.beliefEnabled && this.kernel && !this.dryRun) {
        const scheduling = await maybeRunBeliefEvaluation(this.kernel.stores.db, {
          characterId: this.kernel.characterId,
          activeUserId: this.ids.userId,
          activationId: 'turn-tail',
        })
        if (scheduling.kind === 'failed') {
          logger.warn(`[m9] 信念评估（轮后）失败—— ${scheduling.error}`)
        }
        const memoryScheduling = await maybeRunBeliefMemoryReconciliation(
          this.kernel.stores.db,
          { characterId: this.kernel.characterId },
        )
        if (memoryScheduling.kind === 'failed') {
          logger.warn(`[m9] 信念 Memory 流（轮后）失败—— ${memoryScheduling.error}`)
        }
      }
      /*
       * M8.5 WP8（计划 §8.1 慢路径时序）：completeTurn 之后发**非阻塞**通知——
       * 语义 worker 从持久尾窗发现本轮 source 并评估。本轮回复已定稿（用的
       * 是编译时状态），语义 IMPACT 最早影响下一次上下文编译。
       * fire-and-forget：回复延迟不被模型调用放大；串行守卫在 drain 内部
       * （在飞 tick 会排干尾窗，跳过不丢工作）；收尾链在 close() 里收拢。
       * rules/shadow ⇒ drain 自检直接返回（零读零写），不追加任何 trace 步。
       */
      if (this.flags.affectContextEnabled && !this.dryRun) {
        void this.drainSemanticTail(outgoing.trace.traceId)
      }
      void this.drainReflectionTail()
      void this.drainAutomaticMemoryTail()
      /*
       * M10.1 / ADR-086 `D02`：**约定识别慢路径**（`L-M10.1-11` 的修复）。
       * ⚠️ 它**只在 `agreementEnabled` 打开时**才动端口（关着时 drain 直接返回 ⇒ 零读零写、
       *    不建水位行 ⇒ 与接线前逐字相同）。fire-and-forget：回复延迟不被模型调用放大。
       */
      if (incoming?.reminderResult === undefined || incoming.reminderResult.kind === 'none') void this.drainAgreementTail()
      /*
       * ==========================================================================
       *  S8 / `ADR-107` `R-3b`：**每轮尾扫**的故事消费（`D03` 的"提交后消费"）
       * ==========================================================================
       * ⚠️ 为什么在**轮尾**而不是提交之后立刻消费：`reflectionStep` 的消费**会真发模型请求**
       *    （provider 是必填注入）⇒ 压在回复之前就是把一次模型调用塞进用户等待
       *    （`ADR-107` `Q8` 明确否掉了那一天）。放在这里，水位机制保证"至多一次、
       *    失败停住不跳过"，代价只是**晚一轮**出现状态变化 —— 那是可接受的降级。
       * ⚠️ 关着总开关 ⇒ `this.storyCognition` 根本没建 ⇒ `drainStoryTail` 直接返回（零读零写）。
       */
      void this.drainStoryTail()
      /*
       * 后 Lv2 · WP1：把**这一轮实际用到的身份**记下来（桥的 host 只读它，
       * 不自己猜"刚写的是哪条事件"）。只记 id 与计数 —— 没有正文、没有 prompt。
       */
      /*
       * Lv4.5 / `P1`：**她不该把程序追加的附录念出来**。
       *
       * ```text
       * 账本：still 带附录的 replyText（`completeTurn` 已经在上面写完了）——"她生成过什么"
       * 交付：去掉附录的文本 ——"她说过什么"（字幕 / 语音 / 外壳聊天都用这一份）
       * ```
       * ⚠️ 两者必须**同时**采用同一个值：外壳会校验 `join(分句) === replyText`，
       *    只改一边会让那次校验失败（而失败表现是"分句对不上"，看起来像别的问题）。
       * ⚠️ 实测动机：2026-10-04 真实链路里她把 `[E1] …https://…` 与 `lat=…&lon=…` 念了出来。
       */
      const spokenText = withoutAppendices(replyText, [
        guardChain.evidenceAppendix,
        guardChain.turnContent.appendix,
      ])
      this.lastTurnReading = {
        replyId: String(outgoing.assistantEvent?.id ?? ''),
        traceId: String(outgoing.trace.traceId),
        domainEventIds: [...outgoing.domainEventIds],
        ...(streamed !== undefined ? { streamStatus: streamFailure ?? 'completed' } : {}),
        /*
         * 阶段耗时随身份一起交出去（桥的 host 把它放进 `TURN_RESULT.timings`，
         * 外壳记进 `/lg/status.last_turn`）——**不写日志**：桥的 stdout 是协议通道。
         */
        timings: {
          contextMs,
          beginTurnMs,
          evaluationsMs,
          compileMs,
          stateMs,
          modelMs: call.durationMs,
          guardsMs,
          completeMs: Date.now() - phaseAt.complete,
        },
        ...(streamed !== undefined ? { expression: streamed.expression } : expressionDraft !== undefined ? {
          expression: bindSpeechExpression(String(outgoing.assistantEvent?.id ?? ''), spokenText, expressionDraft),
        } : {}),
      }
      return spokenText
    }

    // 4') 旧链路：落库回复——下一轮的 Recent Messages 会带上它
    const agentMessage: Memory = {
      id: stringToUuid(`msg-${this.roomId}-${turn}-agent`),
      entityId: this.agentEntityId,
      agentId,
      roomId: this.roomId,
      worldId: this.worldId,
      content: { text: replyText, source: 'cli', channelType: ChannelType.DM },
    }
    if (!this.dryRun) {
      await this.runtime.createMemory(agentMessage, 'messages', true)
    } else {
      this.dryRunTurns += 1
    }
    if (DEBUG_CONTEXT) {
      logger.info(`[turn ${this.turn}] 模型 ${modelSeconds}s`)
    }

    return replyText
  }

  /**
   * 只读地导出「本轮她实际看到的完整 prompt」。
   *
   * 用于排查"她怎么会说这种话"——不要猜模型，先看它看到了什么。
   * 全程不写任何数据：不落消息、不建档、不推进 lastInteractionAt。
   *
   * ============================================================================
   *  默认走**新链路**（ContextCompiler），而不是旧路径
   * ============================================================================
   * 这一点在 M2.5 之后必须明确，否则这个命令会骗人：
   *   ContextCompiler 成为默认之后，她实际读到的 prompt **不是**
   *   `composeState + messageHandlerTemplate` 那一份了。
   *   如果 `--dump-prompt` 还渲染旧路径，排查时看到的就不是她看到的东西 ——
   *   而且旧路径还会打出 bootstrap 的 SETTINGS 报错，进一步误导。
   *
   * 因此：
   *   · 默认（`--dump-prompt`）    → 新链路：Seed + 状态 + 最近事件 + 当前输入
   *   · `--dump-prompt --legacy`   → 旧路径：保留对照能力（M1 会看到什么）
   */
  async renderPromptDump(question?: string, options: { legacy?: boolean } = {}): Promise<string> {
    const all = await this.runtime.getMemories({
      tableName: 'messages',
      roomId: this.roomId,
      count: 1000,
    })
    const sorted = all
      .filter((m) => typeof m.content?.text === 'string')
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))

    // 不给问题就用最后一条**用户**消息，还原最近一次真实提问
    const lastUser = [...sorted].reverse().find((m) => m.entityId === this.userEntityId)
    const text = question ?? String(lastUser?.content?.text ?? '')

    if (!text) {
      return '（房间里还没有用户消息，也没有传入问题，无法导出 prompt）'
    }

    const probe: Memory = {
      id: stringToUuid(`dump-${Date.now()}`),
      entityId: this.userEntityId,
      agentId: this.runtime.agentId as UUID,
      roomId: this.roomId,
      worldId: this.worldId,
      content: { text, source: 'cli', channelType: ChannelType.DM },
    }

    // --- 旧路径（对照用）---------------------------------------------------
    if (options.legacy || !this.gateway) {
      const ctx = await buildLegacyDumpContext(this.runtime, probe)
      return [
        `# 路径：旧（composeState + messageHandlerTemplate）`,
        `# 待问的问题：${text}`,
        `# provider 贡献：${ctx.contributions.map((c) => `${c.name}(${c.chars})`).join(', ')}`,
        `# prompt 长度：${ctx.prompt.length} 字符`,
        '',
        ctx.prompt,
      ].join('\n')
    }

    // --- 新路径（默认）-----------------------------------------------------
    // 走与真实对话**同一条**编译路径，因此这里看到的 section 组成就是她真正读到的。
    //
    // ⚠️ 必须用一个**只读网关**：真实网关的 `compileTurn` 会往 trace 写 step，
    //    而 `--dump-prompt` 从来没有 beginTurn —— 于是它会去 UPDATE 一条不存在的
    //    trace 行、抛错、命令挂死（实测踩到，见 turn-gateway.ts 里 appendStep 的注释）。
    //    用 `dryRun: true` 的网关，从结构上保证这个命令什么都不写。
    const readOnlyGateway = this.buildGateway({ dryRun: true })
    // M7/M8：与真实链路同形（桥接 + 关系/情绪注入块；开关关闭时两处都是 legacy 形态）
    const relationshipAxes = !this.flags.relationshipContextEnabled
    const affectAxes = !this.flags.affectContextEnabled
    const stateSection = await renderCriticalStateSection(
      this.runtime,
      this.ids.characterId,
      this.ids.userId,
      { relationshipAxes, affectAxes }
    )
    const relationshipSection = this.flags.relationshipContextEnabled
      ? await renderRelationshipSection(this.runtime, this.ids.characterId, this.ids.userId)
      : undefined
    // M8：情绪注入块（只读渲染，appliedThisTurn='unknown'——dump 不评估不落库）
    const affectSection = this.flags.affectContextEnabled
      ? await renderAffectSection(this.runtime, this.ids.characterId, Date.now(), 'unknown')
      : undefined
    /*
     * M9：信念注入块构造器（只读路径与真实链路同形——`--dump-prompt` 还原的
     * 必须是"她真正读到的" prompt；召回在 dryRun 网关里照常跑，去重判据
     * 因此同样成立。开关关闭 ⇒ 不传 ⇒ 0 个 section）。
     */
    const buildBeliefSection = this.flags.beliefEnabled
      ? async (info: { selectedMemoryIds: readonly string[] }) =>
          buildBeliefContextSection(this.runtime, {
            characterId: this.ids.characterId,
            activeUserId: this.ids.userId,
            selectedMemoryIds: info.selectedMemoryIds,
          })
      : undefined
    const recentLines = await recentContextLinesFrom(this.runtime, {
      characterId: this.kernel!.characterId,
      userName: this.userName,
      characterName: character.name,
      limit: CONVERSATION_LENGTH + 2,
    })
    /*
     * M9.1 / ADR-072 D15/D21：与真实链路同形——`--dump-prompt` 还原的必须是
     * "她真正读到的" prompt，因此遮蔽同样在这里生效（开关开时）。
     */
    const withdrawnMasking = this.flags.withdrawnContextMaskingEnabled
      ? (() => {
          const store = createNativeMemoryStore(this.kernel!.stores.db)
          const owner = entityRef('character', String(this.kernel!.characterId))
          return {
            compute: () => computeWithdrawnEvidence(this.kernel!.stores.db, store, owner),
          }
        })()
      : undefined

    const turn = {
      userEvent: undefined,
      assistantSequence: undefined,
      conversationSequence: this.conversationSequence,
      traceId: newTraceId(),
    }
    const packet = await readOnlyGateway.compileTurn({
      turn,
      currentInput: text,
      recentLines,
      stateSection,
      // M9.1：撤销遮蔽（与真实链路同形；开关关闭 ⇒ 不传）
      ...(withdrawnMasking !== undefined ? { withdrawnMasking } : {}),
      ...(relationshipSection !== undefined ? { relationshipSection } : {}),
      ...(affectSection !== undefined ? { affectSection } : {}),
      ...(buildBeliefSection !== undefined ? { buildBeliefSection } : {}),
      // 与真实链路一致：`--dump-prompt` 要还原的是**她真正读到的** prompt，
      // 因此时钟也必须在场（否则这个排查入口又会漏掉一类"她怎么会说这种话"）
      clockEpochMs: Date.now(),
    })
    const prompt = readOnlyGateway.promptFor(packet)

    return [
      `# 路径：新（ContextCompiler ${packet.compilerVersion}）`,
      `# 待问的问题：${text}`,
      `# sections：${packet.sections.map((s) => s.id).join(', ')}`,
      `# 被裁掉：${packet.droppedSectionIds.length === 0 ? '（无）' : packet.droppedSectionIds.join(', ')}`,
      `# 引用的对话事件：${packet.sourceConversationEventIds.length} 个`,
      `# 估算 tokens：${packet.estimatedTokens} ｜ prompt 长度：${prompt.length} 字符`,
      '',
      prompt,
    ].join('\n')
  }

  /**
   * 把她记得的最近消息按时间正序打印出来。
   * 用于确认「历史是否真的在累积」——这是排查上下文问题的第一现场。
   */
  /**
   * `--history`：最近对话的**人类调试视图**。
   *
   * TD-07（M7 WP6 预检）裁定 = **最小替换**：数据源从 ElizaOS `messages`
   * 遗留镜像换成 Kernel 账本（缺一半 / 标错人 / 作用域错三个缺陷的消除
   * 与边界说明见 `src/infrastructure/runtime/history-view.ts` 的头注释；
   * 机器判据 = `scripts/m7-wp6-td07.ts`）。
   */
  /**
   * 后 Lv2 · WP1（`INV-PL2-09`）：**上一轮真实产生的那条轮的 LG 身份**。
   *
   * ============================================================================
   *  它为什么必须由 `ChatSession` 自己报出来
   * ============================================================================
   * 入口桥的 host 必须是**生产那一套**轮次装配（`send()`），而不是"照着重写一遍"
   * —— 重写的那一份已经在 R3 真的漏掉过全部五道回复守卫。
   *
   * 但桥的输出契约要求 `replyId` / `traceId` / `domainEventIds`（外壳要靠它们对账），
   * 而 `send()` 的返回值是**一个字符串**。于是有两条路：
   *   · 让桥自己再查一次"刚写的是哪条事件" —— 那是猜测，且并发下会取错；
   *   · 让产轮的那一处**把它实际用到的身份记下来**，桥只读这份记录。← 本字段
   *
   * ⚠️ 它**只**保存 id 与计数：**没有**正文、**没有** prompt（`D-8` 的同一纪律）。
   * ⚠️ 它**不进 trace、不落库**：这是一次进程内的交接，不是新的账本。
   */
  private lastTurnReading:
    | {
        replyId: string
        traceId: string
        domainEventIds: readonly string[]
        expression?: SpeechExpression
        streamStatus?: 'completed' | 'interrupted' | 'cancelled'
        /** 生成段内部的阶段耗时（`P4` 后的时延修复要靠它定位主导阶段） */
        timings?: {
          contextMs: number
          beginTurnMs: number
          evaluationsMs: number
          compileMs: number
          stateMs: number
          modelMs: number
          guardsMs: number
          completeMs: number
        }
      }
    | undefined

  /** 读上一轮的身份（桥的 host 用它；没有就返回 `undefined`）。**只读**。 */
  lastTurnIdentity():
    | {
        replyId: string
        traceId: string
        domainEventIds: readonly string[]
        expression?: SpeechExpression
        streamStatus?: 'completed' | 'interrupted' | 'cancelled'
        timings?: {
          contextMs: number
          beginTurnMs: number
          evaluationsMs: number
          compileMs: number
          stateMs: number
          modelMs: number
          guardsMs: number
          completeMs: number
        }
      }
    | undefined {
    return this.lastTurnReading
  }

  async renderHistory(limit = 20): Promise<string> {
    if (!this.kernel) {
      return '（Kernel 未初始化：--history 需要 Character Kernel 账本）'
    }
    return renderLedgerHistory({
      db: this.kernel.stores.db,
      characterId: this.kernel.characterId,
      userId: this.ids.userId,
      userName: this.userName,
      characterName: character.name,
      limit,
    })
  }

  /**
   * M8.5 WP8：语义模式是否**真正**生效（模式旗 ∧ 激活就绪，进程内缓存）。
   *
   * 就绪闸防的是 WP13 之前的坏中间态：旗设了 semantic、投影行却还是 @1 章
   * ⇒ 词形让位了、语义 IMPACT 全被版本守卫拒 ⇒ valence 冻结无人写入。
   * 未就绪 ⇒ **不让位**（M8 全路径照常）+ 语义 worker 不跑 + 一次性告警——
   * 启动前提的失败关闭（确定性判据），不是运行时自动回落（M85-D01 禁后者）。
   */
  private semanticActiveCached: boolean | undefined
  private affectReducerVersionCached: 1 | 2 | undefined
  /**
   * M8.5 WP11（§23 回滚路径的装配面）：词形路径按投影行**注册面**选折叠器版本。
   *
   * 投影行是 @2 章（WP13 受控 rebuild 之后）⇒ 词形 TOUCH/IMPACT 也必须经 @2
   * 折叠（版本守卫拒绝跨版本追加；@2 对非语义事件与 @1 逐字一致——§9.3 A==B）。
   * 行是 @1（生产现状）⇒ 传 1，M8 行为逐字不变。行不存在（未建档）⇒ 1
   * （播种走缺省 @1；激活段的 rebuild 会重盖章）。
   *
   * 进程内缓存：注册面在进程生命周期内不变（rebuild 是激活段的受控操作，
   * 不与聊天进程并发——WP6 ⑦ 的注册面纪律）。
   */
  private async affectReducerVersion(): Promise<1 | 2> {
    if (this.affectReducerVersionCached !== undefined) return this.affectReducerVersionCached
    const kernel = this.kernel
    if (!kernel) {
      this.affectReducerVersionCached = 1
      return 1
    }
    const projection = await getAffectProjection(kernel.stores.db, kernel.characterId)
    this.affectReducerVersionCached = projection?.reducerVersion === 'affect-reducer@2' ? 2 : 1
    return this.affectReducerVersionCached
  }
  private async semanticActive(): Promise<boolean> {
    if (this.semanticActiveCached !== undefined) return this.semanticActiveCached
    if (!(this.flags.affectContextEnabled && this.flags.affectSemanticMode === 'semantic')) {
      this.semanticActiveCached = false
      return false
    }
    const kernel = this.kernel
    if (!kernel) {
      this.semanticActiveCached = false
      return false
    }
    const readiness = await affectSemanticActivationReady(kernel.stores.db, kernel.characterId)
    if (!readiness.ready) {
      logger.warn(
        `[m8.5] CHARACTER_AFFECT_SEMANTIC_MODE=semantic 但语义面未激活（${readiness.reason}）` +
          `⇒ 本进程按 rules 全路径运行：不让位 IMPACT、语义 worker 不跑（WP13 激活 rebuild 后生效）`
      )
    }
    this.semanticActiveCached = readiness.ready
    return readiness.ready
  }

  /**
   * M8.5 WP8：跑一次语义慢路径 tick（**串行守卫 + 永不抛**）。
   *
   * 时序（计划 §8.1 慢路径）：completeTurn 之后才调用——本轮回复用的
   * 是编译时已提交的状态；语义评估的 IMPACT 最早影响**下一次**上下文编译
   * （"可能不止延后一轮"是诚实口径，不承诺同轮/下一轮生效）。
   *
   * · 串行：在飞 tick 存在 ⇒ 本次跳过（在飞的那个会排干尾窗；跳过不丢工作
   *   ——持久水位间隙才是工作真相，§8.2 每 Character 并发 1）。
   * · 非阻塞：轮后调用是 fire-and-forget（`void this.drainSemanticTail()`）；
   *   回复延迟不被模型调用放大。启动追赶用 `await`（有界：过期 source 不出站）。
   * · trace：tick 出结果后经 `appendPostTurnStep` 追加 `affect_semantic_*`
   *   四步（no-op 结局不追加——rules/shadow 轮次 trace 不变长）。
   * · 永不抛：装配层意外（如收尾竞态）记日志吞掉——调用方是"用户刚说完话"。
   *
   * @param traceId 本轮 trace（轮后追加语义四步用；启动追赶无轮次 ⇒ 不传 ⇒ 不追加）
   */
  private async drainReflectionTail(recover = false): Promise<void> {
    /* ADR-109 `D03`：借用者不自己跑 —— 转交 owner（在飞闸只有一套） */
    if (this.consumers !== undefined) return await this.consumers.drainReflectionTail(recover)
    if (this.reflectionDrainInFlight !== undefined || this.reflectionFence.closed) return
    const kernel = this.kernel
    if (!kernel || (!this.flags.reflectionEnabled && !this.flags.adaptiveSelfEnabled) || this.dryRun) return
    const run = (async () => {
      try {
        const scheduling = await this.goalReflectionQueue.run(() => runConfiguredReflectionTail(kernel.stores.db, {
          characterId: kernel.characterId, activeUserId: this.ids.userId,
          reflectionEnabled: this.flags.reflectionEnabled, adaptiveEnabled: this.flags.adaptiveSelfEnabled,
          provider: createOpenAiReflectionDraftProvider(), fence: this.reflectionFence,
          signal: this.reflectionAbort.signal, recover,
        }))
        logger.info(`[m11] 反思慢路径追赶：${JSON.stringify(scheduling)}`)
      } catch (error) {
        logger.warn(`[m11] 慢路径中止：${String(error)}`)
      } finally { this.reflectionDrainInFlight = undefined }
    })()
    this.reflectionDrainInFlight = run
    await run
  }

  /**
   * **M10.1 / ADR-086 `D02`**：约定识别慢路径的追赶（`L-M10.1-11` 的修复 —— 让
   * `app/agreement/**` 在生产里**真的有消费者**）。
   *
   * ```text
   * 三条纪律与反思那条同源：
   *  · **开关关 ⇒ 一个端口都不动**（`drain` 自检直接返回：不读窗口、不调模型、不建水位行）
   *  · **干跑不执行**（消费会写域事件；干跑的规矩是"这次测试等于没发生过"）
   *  · **失败不抛**：调度器把失败落成 `failed` 任务且**不前进水位**（下一轮同窗重试补洞）
   *  · **不回判历史**（`D33`）：首次调用把 cutover 预置成**此刻**的账本序号
   * ```
   */
  private async drainAutomaticMemoryTail(): Promise<void> {
    if (this.consumers !== undefined) return await this.consumers.drainAutomaticMemoryTail()
    await this.automaticMemory?.drain()
  }

  private async drainAgreementTail(recover = false): Promise<void> {
    /* ADR-109 `D03`：借用者不自己跑 —— 转交 owner */
    if (this.consumers !== undefined) return await this.consumers.drainAgreementTail(recover)
    if (this.agreementDrainInFlight !== undefined || this.reflectionFence.closed) return
    const kernel = this.kernel
    if (!kernel || !this.flags.agreementEnabled || this.dryRun) return
    const run = (async () => {
      try {
        const scheduling = await this.goalReflectionQueue.run(() => runConfiguredAgreementTail(kernel.stores.db, {
          characterId: kernel.characterId,
          activeUserId: this.ids.userId,
          enabled: this.flags.agreementEnabled,
          provider: (this.agreementProvider ??= createOpenAiAgreementDraftProvider()),
          fence: this.reflectionFence,
          signal: this.reflectionAbort.signal,
          recover,
        }))
        logger.info(`[m10.1] 约定识别慢路径：${JSON.stringify(scheduling)}`)
      } catch (error) {
        logger.warn(`[m10.1] 约定识别中止（任务留在可重试态，下一轮同窗补洞）：${String(error)}`)
      } finally {
        this.agreementDrainInFlight = undefined
      }
    })()
    this.agreementDrainInFlight = run
    await run
  }

  /**
   * **S8 / `ADR-107` `R-3b`**：**每轮尾扫**的故事消费。
   *
   * ```text
   * 提交（`R-1b` 的轮内选择解析 / `story:start` 的开局）
   *   → **本方法**（轮尾，fire-and-forget）→ `consumeOnce()` 按各消费者水位逐条消费
   * ```
   * ⚠️ **不进用户等待的那一轮**（`ADR-107` `Q8`）：反射消费会真发模型请求。
   * ⚠️ 关着总开关 / 干跑 / 装配未建 ⇒ **直接返回**（零读零写，与接线前逐字相同）。
   * ⚠️ 失败**不抛**：水位机制保证"失败停住不跳过、下一轮从同一条继续"。
   */
  private async drainStoryTail(): Promise<void> {
    /* ADR-109 `D03`：借用者不自己跑 —— 转交 owner */
    if (this.consumers !== undefined) return await this.consumers.drainStoryTail()
    if (this.storyDrainInFlight !== undefined) return
    const cognition = this.storyCognition
    if (cognition === undefined || !this.flags.storyCognitionEnabled || this.dryRun) return
    const run = (async (): Promise<void> => {
      try {
        const consumed = await cognition.consumeOnce()
        /*
         * ⚠️ 只在**真的有消费**时打一行：每轮都打"无可消费项"会把有用的行淹掉
         *    （而"每轮都空转"本身不是缺陷 —— 没有新提交就是无事可做）。
         */
        const moved = consumed.progress.filter((row) => row.consumed.length > 0)
        if (moved.length > 0) {
          logger.info(
            `[s8] 剧情消费（轮尾）：${moved
              .map((row) => `${row.consumer}→${String(row.advancedTo)}`)
              .join(' · ')}`
          )
        }
      } catch (error) {
        logger.warn(
          `[s8] 剧情消费（轮尾）失败（**不抛**；水位不动，下一轮从同一条继续）：${String(error)}`
        )
      } finally {
        this.storyDrainInFlight = undefined
      }
    })()
    this.storyDrainInFlight = run
    await run
  }

  private async drainSemanticTail(traceId?: ReturnType<typeof asTraceId>): Promise<void> {    /* ADR-109 `D03`：借用者不自己跑 —— 转交 owner（`traceId` 仍指向**本轮**那条 trace，
       追加到哪条由 id 查库决定 ⇒ 借用者的一轮也拿得到自己的语义四步） */
    if (this.consumers !== undefined) return await this.consumers.drainSemanticTail(traceId)
    if (this.semanticDrainInFlight !== undefined) return
    if (!(await this.semanticActive())) return
    const kernel = this.kernel
    if (!kernel || this.dryRun) return
    const run = (async (): Promise<void> => {
      try {
        this.semanticProvider ??= createOpenAiAffectSemanticProvider()
        const startedAt = Date.now()
        const tick = await maybeRunAffectSemanticEvaluation(kernel.stores.db, {
          characterId: kernel.characterId,
          characterAlias: character.name,
          activeUserId: this.ids.userId,
          mode: this.flags.affectSemanticMode,
          provider: this.semanticProvider,
          signal: this.semanticAbort.signal,
        })
        logger.info(`[m8.5] 语义评估：${describeAffectSemanticTick(tick)}`)
        if (traceId !== undefined && this.gateway && tick.kind === 'ran') {
          for (const step of affectSemanticTraceStepsOf(tick, startedAt)) {
            await this.gateway.appendPostTurnStep(traceId, step)
          }
        }
      } catch (error) {
        // 装配层意外（收尾竞态/库已关等）：如实记日志，不炸聊天链
        logger.warn(`[m8.5] 语义评估意外中止（任务留在可重试态，下次启动补）—— ${String(error)}`)
      } finally {
        this.semanticDrainInFlight = undefined
      }
    })()
    this.semanticDrainInFlight = run
    await run
  }

  async close(): Promise<void> {
    /*
     * ==========================================================================
     *  post-Lv2 / ADR-109 `D07`：**断开不是停机**
     * ==========================================================================
     * 借用者会话的 `close()` **什么都不做**：它没有自己的库、没有自己的消费者、
     * 没有自己的租约。客户端断开只该关掉**它自己那条连接**（那是外壳的事）。
     * 只有核心管理者（owner 会话）能排空两路、等在飞消费者、关库并释放租约。
     *
     * ⚠️ 旧形状（每个入口一个进程）下这一行不存在，因为那时"一个会话"就是
     *    "一个进程"——`close()` 与"停机"是同一件事。共存把它拆开了。
     */
    if (this.consumers !== undefined) return
    const automaticMemoryClosing = this.automaticMemory?.close()
    this.automaticMemoryAbort.abort()
    await automaticMemoryClosing
    this.reflectionFence.close()
    this.reflectionAbort.abort()
    await this.reflectionDrainInFlight
    /* M10.1：约定识别的在飞 drain 同样在关库**之前**收拢（同一把 fence 已经在上面关掉） */
    await this.agreementDrainInFlight
    /*
     * INC-01 WP3（`AT3.1`/`AT3.2`）：不再只 `runtime.stop()` ——
     * 那条路径**不关数据库连接**（事故的第三个缺口）。
     * 现在走唯一的收尾句柄：`stop → close → closed check`，且幂等
     * （最外层 `finally` 与信号处理都调它，实际只发生一次）。
     */
    /*
     * M8.5 WP8（计划 §8.2 shutdown 链）：收尾在关库**之前**收拢语义慢路径——
     *   ① abort 在飞模型请求（中止 ⇒ 传输失败 ⇒ 任务留在可重试态）；
     *   ② 有界等待在飞 drain 退出（abort 后只剩短写事务，秒级；
     *      超时上限是防御性的——正常路径 abort 后立即返回）；
     *   ③ 交给既有唯一关库链（不在这里出现第二个 close）。
     * 持久任务行 + 终结闸 = 崩溃/中止恢复的真相源（WP6 W7 已证），
     * 所以"没收完"不是数据丢失，是下一进程的启动追赶。
     */
    this.semanticAbort.abort()
    if (this.semanticDrainInFlight !== undefined) {
      await Promise.race([
        this.semanticDrainInFlight,
        new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
      ])
    }
    /*
     * ⚠️ **M9.5 / `L-M10-61` 的第二个成因：收尾必须关掉编码器 client（以及它 spawn 的 worker）**。
     *
     * ```text
     * 不关它 ⇒ 子进程是活句柄 ⇒ 父进程 event loop 不空 ⇒ **进程不退出**
     * 实测：回复已产出、停机已开始，而进程 `signal=SIGKILL @240s` —— 是"不退出"，不是"轮次挂住"。
     * ```
     * 位置刻意放在**关库之前**（与 `AT3.1`/`AT3.2` 同一条纪律：先收拢慢路径，再走唯一关库链）。
     * 它幂等（`encoder-client` 的 `close()` 自己处理重复调用），且失败**不该**挡住关库
     * ⇒ 用 `try/catch` 包住、只记不抛（关库链是收尾的最后一环，不能被它带崩）。
     */
    /* ⚠️ 用**同一个幂等助手**（单一实现；聊天路径由最外层 `finally` 调它） */
    await closeSemanticEncoderForExit()
    await this.shutdown.shutdown()
  }
}
/**
 * `--kernel-status`：把 Character Kernel 的内部状态摊开给人看。
 *
 * 这是"可观测性"落在**开发者入口**上的那一半：不需要接 Phoenix，
 * 也不用进数据库，就能看到她的事实账本、变化历史、当前投影与最近 trace。
 * 全部只读。
 *
 * M3 起它多了一段**身份快照**：`character_id / seed_version / seed_hash`
 * 三样都会被打印（计划书第 122 节：回答异常时第一件事就是检查用了哪版人格）。
 */
async function renderKernelStatus(kernel: KernelHandle): Promise<string> {
  const db = kernel.stores.db
  const characterId = kernel.characterId

  const total = await countConversationEvents(db, characterId)
  const recent = await recentConversationEvents(db, { characterId, limit: 6 })
  const domainCount = await countDomainEvents(db, characterId)
  const domainRecent = await domainEventsFor(db, characterId, { limit: 5 })
  const projections = await listProjections(db, characterId)
  const traces = await kernel.stores.traceWriter.recent(characterId, 3)
  const revisions = await projectionRevisions(db, characterId)
  const sourceCounts = await countBySourceKind(db, characterId)

  const lines: string[] = []
  lines.push('='.repeat(72))
  lines.push('Character Kernel 状态（M2.5 + M3）')
  lines.push('='.repeat(72))
  lines.push('')
  lines.push(`角色：${kernel.definition.name}（${String(characterId)}）`)

  // --- M3：身份快照（每次排查的第一现场）--------------------------------
  const snapshot = kernel.identitySnapshot
  lines.push('')
  lines.push('## 身份快照（M3）')
  lines.push(`  character_id : ${String(snapshot.characterId)}`)
  lines.push(`  seed_version : v${snapshot.seedVersion}`)
  lines.push(`  seed_hash    : ${snapshot.snapshotHash}`)
  lines.push(`  来源引用     : ${seedSourceRef(snapshot.definition.slug, snapshot.seedVersion)}`)
  lines.push(
    `  结构         : schema v${snapshot.definition.schemaVersion}｜` +
      `traits ${snapshot.definition.personality.traits.length} 条｜` +
      `values ${snapshot.definition.values.length} 条｜` +
      `boundaries ${snapshot.definition.boundaries.length} 条`
  )

  lines.push('')
  lines.push(`## 事实账本 conversation_events（${total} 条）`)
  if (recent.length === 0) lines.push('  （还没有任何对话事件）')
  for (const e of recent) {
    lines.push(
      `  #${String(e.sequence).padStart(4, ' ')} [${e.actorType}/${e.type}] ` +
        `[${e.sourceKind}] ${e.content.replace(/\n/g, ' / ').slice(0, 52)}`
    )
  }
  lines.push(
    `  来源分布     : ${
      Object.entries(sourceCounts)
        .map(([kind, count]) => `${kind}=${count}`)
        .join('  ') || '（无）'
    }`
  )

  lines.push('')
  lines.push(`## 变化历史 character_domain_events（${domainCount} 条）`)
  if (domainRecent.length === 0) lines.push('  （还没有任何领域事件——慢路径可能没跑）')
  for (const e of domainRecent) {
    lines.push(
      `  #${String(e.sequence).padStart(4, ' ')} ${e.type} ← ${e.sourceConversationEventIds.join(', ')}`
    )
    lines.push(`        由 ${e.processor}@${e.processorVersion} 产生，幂等键 ${e.idempotencyKey}`)
  }
  lines.push('')
  lines.push('## 当前投影')
  for (const p of projections) {
    lines.push(
      `  ${p.projectionType}: revision=${p.revision} reducer=${p.reducerVersion} ` +
        `state=${JSON.stringify(p.state)}`
    )
  }
  lines.push(`  （Trace 记录到的投影版本：${JSON.stringify(revisions)}）`)
  lines.push('')
  lines.push('## 最近 trace')
  if (traces.length === 0) lines.push('  （没有 trace：上下文编译器未启用时不会有）')
  for (const t of traces) {
    lines.push(
      `  ${t.traceId} [${t.status}] in=${t.inputEventId} out=${t.outputEventId ?? '(无)'}`
    )
    lines.push(
      `      compiler=${t.contextCompilerVersion ?? '(无)'} ` +
        `seed=v${t.seedVersion ?? '?'} hash=${(t.seedHash ?? '').slice(0, 12) || '?'}`
    )
    lines.push(
      `      sections=[${t.contextSectionIds.join(', ') || '(旧路径)'}] ` +
        `domainEvents=${t.domainEventIds.length}`
    )
    if (t.identitySourceRefs.length > 0) {
      lines.push(`      identity=${t.identitySourceRefs.join(', ')}`)
    }
    // M3：run tree 的节点（计划书第 71 节）—— 一眼看出每一步花在哪
    if (t.steps.length > 0) {
      const tree = t.steps
        .map((s) => {
          const ms = s.finishedAt !== undefined ? s.finishedAt - s.startedAt : undefined
          return `${s.kind}${ms !== undefined ? `(${ms}ms)` : ''}`
        })
        .join(' → ')
      lines.push(`      steps: ${tree}`)
    }

    /*
     * ⚠️ **失败步骤必须带出它的原因**。
     *
     * 在这之前这里只打印步骤的 `kind`，于是 trace 里出现
     *     … → memory_explicit_write(5ms) → context_compile …
     * 时，**看不出**它是成功还是失败，更看不出失败为什么。
     *
     * 实测踩到过：显式记忆写入在真库里失败，我只能从她的话
     * （"你刚说的，我没记上"）推断出"确实失败了"，
     * 而**原因没有落在任何地方** —— 我只能靠猜（先猜类型不匹配，
     * 猜错了）才知道要去查什么。
     *
     * 一份"只告诉你失败了"的 trace 与没有 trace 差不多：
     * 排查需要的是**哪一步、为什么**。
     *
     * 只打印 `label`（它由代码写死，含原因码与意图类别），
     * 不打印 `attributes` —— 后者的键会随实现增加，
     * 而记忆内容绝不允许进 trace（计划书第 110 节）。
     */
    const failedSteps = t.steps.filter((s) => s.status === 'failed')
    for (const s of failedSteps) {
      lines.push(`      ⚠️ failed step: ${s.kind} — ${s.label}`)
    }

    if (t.error) lines.push(`      error: ${t.error}`)
  }
  lines.push('')
  lines.push('='.repeat(72))
  return lines.join('\n')
}

/**
 * `--seed-status`：Seed 的身份与历史（只读）。
 *
 * M3 新增。它回答三个问题，且**必须**能回答：
 *   1. 现在用的是哪一版？（版本 + 指纹）
 *   2. 她变过几次？每次是谁改的、为什么？（Seed 历史）
 *   3. 库里的内容和代码里的定义是不是同一份？（指纹比对）
 *
 * 第 3 条是"有人绕过写入闸改了库"的检测入口 —— 它是 M3 的读取闸，
 * 与写入闸（内容变了不升版本就拒绝）配对使用。
 */
async function renderSeedStatus(kernel: KernelHandle): Promise<string> {
  const db = kernel.stores.db
  const snapshot = kernel.identitySnapshot
  const versions = await kernel.identity.listSeedVersions(50)
  const codeDefinition = characterDefinitionFromCharacter(character)
  const codeHash = hashSeed(codeDefinition)

  const lines: string[] = []
  lines.push('='.repeat(72))
  lines.push('Seed Identity 状态（M3）')
  lines.push('='.repeat(72))
  lines.push('')
  lines.push(`角色      : ${snapshot.definition.name}（${String(snapshot.characterId)}）`)
  lines.push(`slug      : ${snapshot.definition.slug}`)
  lines.push(`seed 版本 : v${snapshot.seedVersion}`)
  lines.push(`seed 指纹 : ${snapshot.snapshotHash}`)
  lines.push(`结构版本  : schema v${snapshot.definition.schemaVersion}`)
  lines.push('')

  lines.push('## 库内 vs 代码')
  lines.push(`  库内指纹 : ${shortHash(snapshot.snapshotHash)}`)
  lines.push(`  代码指纹 : ${shortHash(codeHash)}`)
  if (snapshot.snapshotHash === codeHash) {
    lines.push('  ✅ 一致（库里的 Seed 就是代码里那一份）')
  } else if (snapshot.seedVersion === codeDefinition.seedVersion) {
    lines.push('  ❌ 不一致，且版本相同 —— 这是"被绕过写入闸改过"的典型特征')
  } else {
    lines.push(
      `  ⚠️ 不一致，但版本也不同（库 v${snapshot.seedVersion} / 代码 v${codeDefinition.seedVersion}）`
    )
    lines.push('     这通常是正常的：代码已经升到新版本，而库里还记着上一版。')
    lines.push('     启动一次（任意命令）会把它同步过去。')
  }

  lines.push('')
  lines.push(`## Seed 版本历史（${versions.length} 条，新的在前）`)
  if (versions.length === 0) lines.push('  （没有任何历史条目）')
  for (const v of versions) {
    const when = new Date(v.effectiveAt).toLocaleString('zh-CN', { hour12: false })
    lines.push(`  v${v.seedVersion}  ${shortHash(v.seedHash)}  ${when}`)
    if (v.author || v.reason) {
      lines.push(`      ${v.author ?? '(未知作者)'}：${v.reason ?? '(未说明原因)'}`)
    }
  }

  lines.push('')
  lines.push('## 当前 Seed 的内容摘要')
  lines.push(`  人格倾向（${snapshot.definition.personality.traits.length}）`)
  for (const trait of snapshot.definition.personality.traits) {
    lines.push(`    · ${trait.trait}（强度 ${trait.strength}）`)
  }
  lines.push(`  价值取向（${snapshot.definition.values.length}）`)
  for (const value of snapshot.definition.values) {
    lines.push(`    · ${value.value}（优先级 ${value.priority}）`)
  }
  lines.push(`  边界（${snapshot.definition.boundaries.length}）`)
  for (const boundary of snapshot.definition.boundaries) lines.push(`    · ${boundary}`)

  // 顺带把"读取闸"的结论说清楚：能走到这里打印完，就说明幂等读是一致的
  lines.push('')
  lines.push('（本命令只读：不写 Seed、不写历史、不推进任何时间戳。）')
  lines.push('='.repeat(72))
  void db
  return lines.join('\n')
}

/**
 * Memory Admin API（计划书第 133–135 节）。
 *
 * ============================================================================
 *  它存在的**唯一**理由是计划书第 3 节那句话
 * ============================================================================
 *     M4 完成以后：她已经"存得住"，但不代表"随时想得起来"。
 *     开发环境提供 memory inspect / list / get / history 用于验证 Memory，
 *     而 Main Agent 的完整自动召回在 M5 建设。
 *     这样我们可以分别判断：**记错了？** 还是 **记对了但没召回？**
 *
 * 少了这个入口，M5 的召回一旦不准，那两个问题就分不开。
 *
 * ⚠️ 两个写操作（`retract` / `replay`）走**真实的事件链**
 * （放行口 → 领域事件 → reducer），不直接 UPDATE 表 —— 计划书第 71 节
 * 明令禁止绕过事件。因此它们与她在对话里说"忘掉这件事"是**同一条路**。
 */
/**
 * 后 Lv2 · WP1：**按行读 stdin**（NDJSON 传输的读侧）。
 *
 * ⚠️ 失败关闭且**说清楚**：本进程的 stdin 在某些沙箱/启动方式下不是一个可读管道
 * （实测：受限沙箱里打开管道会得到 `EPERM`）。那时**不**想办法绕过，
 * 而是把这条通道标成"不可用"并抛具名错误 —— 桥不能靠一条它没验过的通道工作。
 */
async function* stdinLines(): AsyncIterable<string> {
  if (process.stdin.isTTY === true) {
    throw new Error(
      '--bridge 需要一个可读的 stdin（NDJSON）。当前是 TTY：请由外壳进程以管道方式启动本进程'
    )
  }
  try {
    const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
    for await (const line of reader) yield line
    reader.close()
  } catch (error) {
    throw new Error(
      `--bridge 无法读取 stdin（${error instanceof Error ? error.message : String(error)}）：` +
        '本通道不可用，拒绝以"看起来在工作"的方式继续'
    )
  }
}

/*
 * ==========================================================================
 *  后 Lv2 / **ADR-109**：`--coexist` —— 一个核心、两条受信入口
 * ==========================================================================
 * ```text
 * 一个常驻 LG 核心进程（唯一库持有者 + 唯一公共生命周期 + 一套后台消费者）
 *   ├─ 监听 127.0.0.1:<QQ 端口>     ← QQ 外壳（scripts/qq）
 *   └─ 监听 127.0.0.1:<皮套 端口>   ← 皮套外壳（Open-LLM-VTuber 的 LG 适配层）
 * ```
 *
 * 三条与计划/ADR 逐字对齐的纪律：
 *  · **入口由程序事实绑定**（`D02`）：哪条入口由**哪个监听端口**接受决定，
 *    载荷里**没有**任何字段能选会话；传输层第一行是一句**握手**（不是桥的消息种类，
 *    因此 `turn-bridge.ts` 的受控登记表**一个字都没改**）。
 *  · **公共生命周期只运行一次**（`D01`/`D03`）：owner 会话建一次，两条入口会话
 *    **借用**它的四个 drain 与故事装配。
 *  · **断开不是停机**（`D07`）：一条连接断开只关它自己；只有核心收尾能关库。
 *
 * ⚠️ 它**缺省不存在**（与 `--bridge` / `--dev-server` 同一条 feature-guard 纪律）。
 * ⚠️ 它**要求** `CHARACTER_ENTRY_SCOPED_CONVERSATIONS=true`：关着时两条入口会写进
 *    **同一条**会话 —— 那正是"看起来接上了、其实没隔离"，必须**失败关闭**。
 * ⚠️ 停机触发是 **stdin EOF**（与 `--bridge` 同源）：外壳关掉本进程的 stdin
 *    ⇒ 先关监听（不再收新入站）⇒ 等在飞轮次 ⇒ 走 owner 的唯一关库链。
 *    信号（Ctrl+C）仍走既有收尾链 —— 那条链**不等待**在飞轮次，是既有行为，
 *    已登记为限制（WP5 的停机脚本用 stdin EOF）。
 */

/** 一条入口的监听规格（**全部来自环境/程序事实**，没有载荷参与） */
interface CoexistenceEntrySpec {
  readonly entry: ChatEntryKey
  readonly port: number
  readonly token: string
  /** 只有皮套消费语音交付账（QQ 是纯文字入口 —— 与既有单入口行为一致） */
  readonly voiceDelivery: boolean
}

const COEXIST_ENV: Readonly<
  Record<ChatChannel, { port: string; token: string; defaultPort: number }>
> = Object.freeze({
  qq_private: {
    port: 'CHARACTER_COEXIST_QQ_PORT',
    token: 'CHARACTER_COEXIST_QQ_TOKEN',
    defaultPort: 6751,
  },
  avatar: {
    port: 'CHARACTER_COEXIST_AVATAR_PORT',
    token: 'CHARACTER_COEXIST_AVATAR_TOKEN',
    defaultPort: 6752,
  },
  cli: { port: 'CHARACTER_COEXIST_CLI_PORT', token: 'CHARACTER_COEXIST_CLI_TOKEN', defaultPort: 6753 },
})

/**
 * 从环境读两条入口的监听规格 —— **失败关闭**。
 *
 * ⚠️ 没有 token（或太短）**直接抛**：一个无鉴权的本机监听在"多用户机器"上
 *    等于把她的会话对同机任何进程开放。宁可起不来。
 */
function coexistenceSpecs(env: NodeJS.ProcessEnv): CoexistenceEntrySpec[] {
  const configured: ChatChannel[] = ['qq_private', 'avatar']
  if (env.CHARACTER_COEXIST_CLI_TOKEN) configured.push('cli')
  return configured.map((entry) => {
    const conf = COEXIST_ENV[entry]
    const token = (env[conf.token] ?? '').trim()
    if (token.length < 16) {
      throw new Error(
        `${conf.token} 未设置或过短（需要 >= 16 个字符）：` +
          '共存模式拒绝以"没有鉴权的本机监听"启动'
      )
    }
    const raw = (env[conf.port] ?? '').trim()
    const port = raw === '' ? conf.defaultPort : Number(raw)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`${conf.port} 不是合法端口：${JSON.stringify(raw)}`)
    }
    return { entry, port, token, voiceDelivery: entry === 'avatar' }
  })
}

/** 按行读一个 socket（传输层；**只做分帧，不做语义**） */
class SocketLineReader {
  private readonly queue: string[] = []
  private buffer = ''
  private closed = false
  private waiter: (() => void) | undefined

  constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.buffer += chunk
      for (;;) {
        const at = this.buffer.indexOf('\n')
        if (at < 0) break
        this.queue.push(this.buffer.slice(0, at))
        this.buffer = this.buffer.slice(at + 1)
      }
      this.release()
    })
    socket.on('close', () => this.finish())
    socket.on('error', () => this.finish())
  }

  private finish(): void {
    if (this.buffer !== '') {
      this.queue.push(this.buffer)
      this.buffer = ''
    }
    this.closed = true
    this.release()
  }

  private release(): void {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }

  async next(): Promise<string | undefined> {
    for (;;) {
      const line = this.queue.shift()
      if (line !== undefined) return line
      if (this.closed) return undefined
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
  }

  async *lines(): AsyncIterable<string> {
    for (;;) {
      const line = await this.next()
      if (line === undefined) return
      yield line
    }
  }
}

/**
 * 建一条入口的监听并服务它，直到该连接结束。
 *
 * ⚠️ **入口身份来自这个监听本身**（不是来自连接里的任何字段）——
 *    这就是 `D02` 的"由程序事实绑定"在本文件里的落点。
 *
 * ⚠️ 返回值里带 `shutdown()`（WP4 实测出来的缺口）：只 `server.close()` **不够** ——
 *    它只停止接受新连接，**已经接入的 socket 仍然开着** ⇒ 那些 `runBridgeTransport`
 *    的 async 任务永远不返回 ⇒ **进程不退出**（实测：`stdin` 已关，180 秒仍在）。
 *    因此核心收尾必须显式把这些连接**销毁**（`D07` 的另一半：停机不是丢下在飞的轮次，
 *    所以顺序是"先关监听 → 等调度器排空 → 再销毁连接"）。
 */
/**
 * 进程级的**主动投递通道**（post-Lv2 / ADR-110 `D06`）。
 *
 * ============================================================================
 *  为什么它可以是"进程级的一个"
 * ============================================================================
 * ```text
 * 这台机器上"当前那条有权投递的 QQ 外壳连接"**本来就是唯一的**：
 *   · 登记表内部按**代次**判权（多外壳在线时只有最新代次能发）
 *   · 绑定发生在 `--coexist` 的 QQ 入口连上时，解绑在它断开时
 * ⇒ 把"哪条连接"放进一个进程级持有者，与"代次"这条判据**同一个权威**，
 *   而不是让适配器去猜"现在该往哪写"。
 * ```
 * ⚠️ 它**懒建**（第一次要用时才建）：`--kernel-status` 一类只读命令不该因此打开任何东西。
 * ⚠️ 关着（`qqProactiveMode === 'off'`）时**不建、不注册适配器** ——
 *    那样一次主动发送会在策略层得到 `capability_not_registered`，与"没这个能力"逐字一致。
 */
let proactiveChannelRef: QqDeliveryRegistry | undefined

/**
 * Lv4.5 / ADR-131 `D15`：**主动开口的机会状态**（冷却 / 日额度 / 幂等键）。
 *
 * ⚠️ 进程级**懒建**（与上面的投递登记同一手法）：`--kernel-status` 一类只读命令不该因此建东西。
 * ⚠️ **它是内存的** ⇒ 重启后冷却 / 日额度 / 幂等键全部归零 ⇒ **重启可绕过限流**。
 *    这条局限有机器可读标识（`IN_MEMORY_OPENING_STATE_LIMITATION`）与**实测读数**，
 *    已登记进 `docs/post-lv2/Avatar-Proactive-Opening-Known-Limitations.md` 的 `L-APO-01`。
 */
let openingStateRef: OpeningStatePort | undefined

function openingState(): OpeningStatePort {
  if (openingStateRef === undefined) openingStateRef = createInMemoryOpeningState()
  return openingStateRef
}

/**
 * Lv4.5 / ADR-131 `D17`：主动开口的**私有模型调用**适配器（进程级懒建）。
 *
 * ⚠️ 期限由**调用方按策略**传进来（`policy.openingDeadlineMs`），**不是**适配器常量 ——
 *    策略值要随策略版本落库，不能散成适配器里的一份。
 */
let openingModelRef: ReturnType<typeof createOpenAiProactiveOpeningPort> | undefined

function openingModel(): ReturnType<typeof createOpenAiProactiveOpeningPort> {
  if (openingModelRef === undefined) openingModelRef = createOpenAiProactiveOpeningPort()
  return openingModelRef
}

function proactiveDeliveryChannel(db: RawDb): QqDeliveryRegistry {
  if (proactiveChannelRef === undefined) {
    proactiveChannelRef = new QqDeliveryRegistry({
      store: {
        readOccurrenceState: async (occurrenceKey) =>
          (await getOccurrence(db, occurrenceKey))?.state,
        advanceOccurrence: async (advanceInput) =>
          await advanceOccurrence(db, advanceInput.occurrenceKey, {
            to: advanceInput.to,
            ...(advanceInput.platformMessageId === undefined
              ? {}
              : { platformMessageId: advanceInput.platformMessageId }),
            ...(advanceInput.reasonCode === undefined ? {} : { reasonCode: advanceInput.reasonCode }),
          }),
      },
      onReading: (reading) => {
        /* ⚠️ 只记标识与理由码：这条线上没有正文 */
        logger.info(`[qq-delivery] ${JSON.stringify(reading)}`)
      },
    })
  }
  return proactiveChannelRef
}

async function createCoexistenceEntryServer(input: {
  readonly spec: CoexistenceEntrySpec
  readonly db: RawDb
  readonly session: ChatSession
  readonly scheduler: FairTurnScheduler
  readonly delivery: VoiceDeliveryLedger | undefined
  /**
   * post-Lv2 / ADR-110 `D06`/`D07`：主动投递的登记表（**QQ 入口**唯一消费它）。
   *
   * ⚠️ `undefined` = 主动模式关着 ⇒ 这一条线**没有装配**（`reportQqDelivery` 不注入
   *    ⇒ 桥会把回执如实报成 `qq_delivery_report_unsupported`，而 `DELIVER_QQ_TEXT` 也不会被发出）。
   */
  readonly qqDelivery: QqDeliveryRegistry | undefined
}): Promise<{ server: Server; shutdown: () => Promise<void> }> {
  const { spec, session, scheduler, delivery, qqDelivery } = input
  const localDelivery = spec.entry !== 'qq_private' && qqDelivery !== undefined ? reminderDeliveryChannel(input.db, spec.entry) : undefined
  const liveSockets = new Set<Socket>()
  const server = createServer((socket) => {
    liveSockets.add(socket)
    socket.on('close', () => liveSockets.delete(socket))
    void (async () => {
      const reader = new SocketLineReader(socket)
      /*
       * 传输层握手（**不是**桥的消息种类）：第一行必须是 `LG_ENTRY <token>`。
       * ⚠️ 这一行**先于**桥协议，因此受控登记表不需要新增任何 kind。
       */
      const hello = await reader.next()
      if (hello === undefined || hello.trim() !== `LG_ENTRY ${spec.token}`) {
        socket.write('LG_ENTRY_REJECTED invalid_handshake\n')
        socket.destroy()
        logger.warn(`[coexist] ${spec.entry}：握手失败（token 不符或空连接），已拒绝`)
        return
      }
      socket.write(`LG_ENTRY_READY ${spec.entry} ${session.conversationId}\n`)
      logger.info(
        `[coexist] ${spec.entry} 已接入（会话 ${session.conversationId}）` +
          ` · 语音交付账 ${delivery === undefined ? '不接（纯文字入口）' : '已接'}`
      )
      /*
       * 取消表**每入口一份**（`D05`：打断皮套不取消 QQ）。
       * ⚠️ 它仍然是**协作式**的：`CANCEL_TURN` 只记意图，真正的停在
       *    `session.send()` 的检查点（既有语义，一个字不改）。
       */
      const cancellation = new TurnCancellationRegistry()
      const base = sessionHost(session, {
        cancellation,
        ...(delivery === undefined ? {} : { delivery }),
        sheIsSpeaking: delivery === undefined ? undefined : () => delivery.hasUnplayed(),
        supersedeUnplayed:
          delivery === undefined
            ? undefined
            : ({ by, reason }) => delivery.markSuperseded({ by, reason }).length,
        lookup: async (request) => await session.prepareLookup(request.query),
      })
      /*
       * `D06`：正式轮次过**共享的**有界轮转调度器（一次一轮、两路公平）；
       * 控制消息（取消 / 播放回报 / 只读准备）走 `runBridgeTransport` 的
       * 独立通道，**不**排队（因此慢轮次期间取消仍然立刻可达）。
       */
      const host = { ...base }
      const innerRunTurn = base.runTurn.bind(base)
      host.runTurn = (request) => scheduler.run(spec.entry, () => innerRunTurn(request))
      const bridge = new TurnBridge({ host })
      /*
       * ==================================================================
       *  post-Lv2 / ADR-110 `D06`/`D07`：**主动投递**这一条线
       * ==================================================================
       * ⚠️ 只有 **QQ 入口**接：皮套入口不投递 QQ 文字（它投递的是"表演"）。
       * ⚠️ 代次**每条连接一个**：多外壳在线时只有当前代次能投递，
       *    旧代次的回执**不得**覆盖新状态（`D06`）。
       * ⚠️ 出站通道按**这条连接**注入（`setOutputSink`）：没有它，
       *    `deliverQqText` 会如实报 `output_channel_absent` 而**什么都不写**。
       */
      const isQqEntry = spec.entry === 'qq_private' && qqDelivery !== undefined
      if (isQqEntry || localDelivery) {
        bridge.setOutputSink((message) => socket.write(`${JSON.stringify(message)}\n`))
      }
      /*
       * ==================================================================
       *  Lv4.5 / ADR-131 `D01`：**皮套入口的系统发起开口**
       * ==================================================================
       * ⚠️ 挂在 `new TurnBridge({ host })` **之后**：要往外发就得先有 `bridge`
       *    （与上面 `host.runTurn` 的覆写同一手法 —— `TurnBridge` 存的是**同一个对象引用**，
       *    而它的 getter 在**调用时**才读 `host.openingOpportunity`）。
       * ⚠️ 只接**皮套入口**：这条通道的入口字面量就是 `avatar`
       *    （QQ 入口的主动那两类走 `onCareOpportunity` / 提醒那条线）。
       * ⚠️ 三个读数是**桥自己的**（`floor` / `turnRevision` / `hasLiveClient`）——
       *    装配层看不到也不该猜（猜就会变成 `D07` 的第二次实现）。
       *
       * 判据顺序与归属：
       * ```text
       * 预检（15 条具名拒绝，**全部在调模型之前**）  ← `precheckOpeningOpportunity`（纯）
       * 编排（一次调用 / 守卫 / 双次复核 / 仲裁）    ← `runOpeningOpportunity`
       * 出站（`CHARACTER_OUTPUT`，既有那条）          ← `bridge.emitCharacterOutput`
       * 这里**只**负责：喂真读数 · 记住占额 · 造表达 sidecar
       * ```
       */
      const openingMode = spec.entry === 'avatar' ? readKernelFlags().avatarOpeningMode : 'off'
      if (spec.entry === 'avatar') {
        /*
         * ⚠️ 打一行模式读数（**不含正文**）：这一条是"它到底有没有被授权激活"的唯一线索 ——
         *    没有它，模式 off 与"端口坏了"在日志上长得一模一样。
         */
        logger.info(
          `[avatar-opening] 模式=${openingMode}` +
            (openingMode === 'off' ? '（代码缺省）⇒ 端口不注入 ⇒ 桥如实报 opening_capability_absent' : '')
        )
      }
      if (spec.entry === 'avatar' && openingMode !== 'off') {
        /*
         * ⚠️ `shadow` 与 `on` **走同一条链**，差别只在最后"出不出站"（见下面那个分支）。
         *    模式在这里**只判一次**（连上来的时候）：它是**启动期配置**，
         *    不该在一次连接中途变化。
         */
        host.openingOpportunity = async ({ entry, idleMs, floor, turnRevision, hasLiveClient }) => {
          const policy = readProactivePolicy(process.env)
          const flags = readKernelFlags()
          const now = Date.now()
          const characterId = asCharacterId(session.characterId)
          const window = zonedDayWindow(now, policy.timeZone)
          /* 读数**全部按真东西喂**：判据在冻结的纯函数里，这里不重判一遍 */
          const [control, allUsedToday, candidateInFlight, built] = await Promise.all([
            readControl(input.db, characterId),
            countQuotaUsage(input.db, { characterId, dayStart: window.start, dayEnd: window.end }),
            hasInFlightOccurrence(input.db, characterId),
            buildProactiveSourceCandidates(input.db, { characterId }),
          ])
          const precheck = precheckOpeningOpportunity({
            entry,
            idleMs,
            now,
            policy,
            paused: control?.paused === true,
            entryScopedConversations: flags.entryScopedConversations,
            candidateInFlight,
            evidenceCount: built.candidates.length,
            /* 她此刻在不在说：与 `options.sheIsSpeaking` **同源**（交付账里还有没播完的片段） */
            sheIsSpeaking: delivery === undefined ? false : delivery.hasUnplayed(),
            userIsSpeaking: floor.userSpeaking,
            hasLiveClient,
            ...openingPrecheckInputs({ state: openingState(), now, policy, allUsedToday }),
          })
          if (!precheck.eligible) {
            return { decision: 'silenced' as const, code: precheck.code, idleMs }
          }
          /*
           * ⚠️ **先占额、再调模型**：冷却与日额度算的是"**占额**"，含结果不明与明确失败
           *    （与 `lastCareAt` 的注释同一条口径）。放在这里 ⇒ 一次失败的调用也占掉这一小时。
           */
          openingState().record({ opportunityKey: precheck.opportunityKey, at: now })
          const outcome = await runOpeningOpportunity({
            precheck,
            candidates: built.candidates,
            model: openingModel(),
            turnRevision,
            floor,
            /* `S04`：发送前**再读一次**依据面（与生成前那次是**同一个函数**） */
            recheckEvidence: async () =>
              (await buildProactiveSourceCandidates(input.db, { characterId })).candidates,
          })
          if (outcome.kind === 'silenced') {
            return { decision: 'silenced' as const, code: outcome.code, idleMs }
          }
          /*
           * ⚠️ `draft` 传**守卫改写前**的正文：`bindSpeechExpression` 靠
           *    `checkedText !== draft.text` 判断"守卫改写过了"，改写时它回落 natural cue
           *    并标 `fallback: 'guard_rewrite'`。若两处都传改写后的正文，
           *    那个诚实的标记就**永远不会出现**（看起来像"从没被改写"）。
           */
          if (openingMode === 'shadow') {
            /*
             * ⚠️ **shadow**：上面那整条链**已经跑完了**（预检 ⇒ 依据 ⇒ **一次真实模型调用** ⇒
             *    回复守卫 ⇒ 发送前复核 ⇒ 仲裁），只是**不出站**。
             * ⇒ 用 `silenced` + **具名码**，而不是 `spoken`："她没有说"是事实，
             *   读数不该替她说。而 `sourceRefs` / `opportunityKey` / `guardCorrected` 照旧回，
             *   所以这一档**能拿到"生成那一段"的真读数**（那正是 shadow 存在的理由）。
             * ⚠️ 它**照旧占额**（冷却与日额度算的是**占额**，与成败无关）。
             */
            return {
              decision: 'silenced' as const,
              code: 'opening_shadow_no_emit',
              sourceRefs: [...outcome.sourceRefs],
              opportunityKey: precheck.opportunityKey,
              idleMs,
              guardCorrected: outcome.guardCorrected,
            }
          }
          const expression = bindSpeechExpression(`opening:${precheck.opportunityKey}`, outcome.text, {
            text: outcome.draftText,
            segments: [{ text: outcome.draftText, cue: outcome.cue }],
          })
          const decision = bridge.emitCharacterOutput({ candidate: outcome.candidate, floor, expression })
          if (decision.action !== 'speak') {
            return { decision: 'silenced' as const, code: decision.code, idleMs }
          }
          return {
            decision: 'spoken' as const,
            /* ⚠️ **不**回正文（ADR-131 `D18`）：正文只从 `CHARACTER_OUTPUT` 出去 */
            sourceRefs: [...outcome.sourceRefs],
            opportunityKey: precheck.opportunityKey,
            idleMs,
            guardCorrected: outcome.guardCorrected,
          }
        }
      }
      /*
       * ⚠️ **出站口在 `openConnection` 这一步绑上去**（不是事后 `setOutputSink`）：
       *    登记表的 `deliver()` 只认"当前代次那一格 sink"，没绑 ⇒ 它如实报
       *    `qq_delivery_no_active_connection`。
       *    **实测教训**：第一版这里调的是 `openConnection()`（不传 sink），
       *    而 `bridge.setOutputSink` 设的是**桥**的口 —— 两处都"看起来接上了"，
       *    结果整链走到最后一步才以 `execution_failed` 收场（真正的理由是"那一格是空的"）。
       * ⇒ 这里把**桥**当成这一代次的出站口：登记表 → 桥 → 这条 socket。
       */
      const deliveryGeneration = isQqEntry
        ? qqDelivery!.openConnection((out) =>
            bridge.deliverQqText({ deliveryId: out.deliveryId, text: out.text })
          )
        : null
      if (isQqEntry) {
        host.reportQqDelivery = async (report) =>
          await reportReminderForChannel(input.db, 'qq_private', qqDelivery!, {
            ...report,
            ...(deliveryGeneration === null ? {} : { generation: deliveryGeneration }),
          })
      }
      const localConnection = localDelivery && spec.entry !== 'qq_private'
        ? bindLocalReminderConnection(input.db, spec.entry, localDelivery, out => bridge.deliverReminderText(out)) : undefined
      if (localConnection) host.reportReminderDelivery = localConnection.report
      await reminderRefreshHook?.()
      bridge.interjectionEnabled = session.interjectionEnabled
      try {
        const reading = await runBridgeTransport(bridge, {
          read: () => reader.lines(),
          write: (line) => socket.write(`${line}\n`),
        })
        logger.info(
          `[coexist] ${spec.entry} 连接结束：读入 ${reading.linesIn} 行` +
            `（解析 ${reading.parsed} / 畸形 ${reading.malformed}）· 写出 ${reading.linesOut} 行`
        )
      } catch (error) {
        logger.warn(`[coexist] ${spec.entry} 连接异常（**只关这一条**）：${String(error)}`)
      } finally {
        /*
         * ⚠️ 断开时**只有它仍是当前代次**才清掉水位（`closeConnection` 自己判）——
         *    否则"旧连接断开"会把新连接的投递权一起收走。
         */
        if (deliveryGeneration !== null) qqDelivery!.closeConnection(deliveryGeneration)
        await localConnection?.close()
        await reminderRefreshHook?.()
        socket.destroy()
      }
    })()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(spec.port, '127.0.0.1', () => resolve())
  })
  logger.info(`[coexist] ${spec.entry} 监听 127.0.0.1:${String(spec.port)}（只绑 loopback）`)
  return {
    server,
    /**
     * ⚠️ 顺序**不能换**：`server.close()` 的回调要等**所有已接入连接都结束**才触发，
     *    所以"先 `await` 回调、再销毁连接"会**自己把自己挂住**（WP4 实测：180 秒不退出）。
     *    正确顺序 = 先销毁 socket，再 `await` 关闭回调。
     */
    async shutdown() {
      for (const socket of liveSockets) socket.destroy()
      liveSockets.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/**
 * `--coexist` 的装配与运行（见上面那一段说明）。
 *
 * ⚠️ 它**不**新建第二份权威：角色、用户、记忆、认知全走既有的
 *    `ChatSession` / `TurnGateway` / 桥；这里只多了"一个核心 + 两条入口"的编排。
 */
async function runCoexistenceHost(input: {
  readonly runtime: AgentRuntime
  readonly userName: string
  readonly kernel: KernelHandle
  readonly flags: ReturnType<typeof readKernelFlags>
  readonly telemetry: TelemetryMirror | undefined
  readonly runtimeId: RuntimeId
  readonly shutdown: () => Promise<unknown>
}): Promise<void> {
  if (!input.flags.entryScopedConversations) {
    throw new Error(
      '--coexist 要求 CHARACTER_ENTRY_SCOPED_CONVERSATIONS=true：' +
        '关着时两条入口会写进**同一条**会话（近期窗口互相混入）—— ' +
        '那是"看起来接上了、其实没隔离"，拒绝启动'
    )
  }
  /*
   * ⚠️ 这里**解构**成与其它装配点**同一个形状**（`runtime, userName, kernel, flags, …`）：
   *    `m5.1.1:wp6.1:verify` 有一条静态锁在数
   *    "每一个 `new ChatSession(runtime, userName, { entryMode` 构造点都显式传了入口模式"。
   *    那条锁是**文本**判据（它不知道 `input.runtime` 与 `runtime` 是同一个值）——
   *    因此这里顺着它的形状写，而不是去改 M5.1.1 已冻结的证据线。
   */
  const { runtime, userName, kernel, flags, telemetry, runtimeId, shutdown } = input
  const specs = coexistenceSpecs(process.env)
  const qqConfig = readQqPrivateConfig(process.env)
  const maxQueuedPerEntry = Number((process.env.CHARACTER_COEXIST_QUEUE_BOUND ?? '4').trim())
  if (!Number.isSafeInteger(maxQueuedPerEntry) || maxQueuedPerEntry < 1) {
    throw new Error('CHARACTER_COEXIST_QUEUE_BOUND 必须是 >= 1 的整数')
  }

  /*
   * owner 会话：**承载公共生命周期与共享消费者**（`D01`/`D03`）。
   * ⚠️ 它绑 `cli` 入口（会话 id 与 M3 起逐字相同）且**没有监听端口** ——
   *    配置了 CLI 令牌时，由另一个共用消费者的会话承接控制台连接。
   */
  const owner = new ChatSession(runtime, userName, { entryMode: 'interactive_human_console',
    entryKey: 'cli',
    kernel,
    flags,
    ...(telemetry === undefined ? {} : { telemetry }),
    runtimeId,
  })
  await owner.open()
  const consumers = owner.sharedConsumerDelegate()

  const scheduler = new FairTurnScheduler({
    entries: specs.map((spec) => spec.entry),
    maxQueuedPerEntry,
  })

  /*
   * ==========================================================================
   *  post-Lv2 / ADR-110 `D07`/`D08`：**主动投递登记表的装配**
   * ==========================================================================
   * ⚠️ 两件事必须**同真**才装配：
   * ```text
   * ① 主动模式不是 off（`D14`）—— 关着时没有任何路径能发起投递，
   *    装一张能受理回执的登记表只会让"看起来接上了"更容易发生
   * ② QQ 绑定读得出来（收件人只由它决定，`D05`）
   * ```
   * ⚠️ 它与入口作用域**无关**：投递登记是"哪一条投递"，不是"哪一条会话"。
   * ⚠️ 端口只给形状：`notification-store` 的两个函数是唯一权威
   *    （`advanceOccurrence` 自己复核迁移表与表级 CHECK）。
   */
  const qqDelivery =
    flags.qqProactiveMode !== 'off' ? proactiveDeliveryChannel(kernel.stores.db) : undefined

  /** QQ 入口的会话（主动发送的执行体；没有它就没有"经真网关发出去"的那一步） */
  const reminderSenders = new Map<ChatChannel, ChatSession>()
  let proactiveSender: ChatSession | undefined
  /** 到点提醒的调度器（`Croner`；只在两件事**同真**时存在） */
  let proactiveScheduler: ProactiveScheduler | undefined

  const entries: { server: Server; shutdown: () => Promise<void> }[] = []
  try {
    for (const spec of specs) {
      const delivery = spec.voiceDelivery ? new VoiceDeliveryLedger() : undefined
      const session = new ChatSession(runtime, userName, { entryMode: CHAT_ENTRY_SCOPES[spec.entry].attributionEntryMode,
        entryKey: spec.entry,
        consumers,
        kernel,
        flags,
        ...(telemetry === undefined ? {} : { telemetry }),
        runtimeId,
        ...(spec.entry === 'qq_private' ? { qqOwnerId: qqConfig.ownerId } : {}),
        ...(delivery === undefined ? {} : { voiceDelivery: delivery }),
      })
      await session.open()
      reminderSenders.set(spec.entry, session)
      const entryServer = await createCoexistenceEntryServer({ spec, db: kernel.stores.db, session, scheduler, delivery, qqDelivery })
      /*
       * ⚠️ **QQ 入口**那一条会话就是主动发送的执行体（它有网关 + 它是本入口的会话）。
       *    皮套／控制台不参与自主关心；明确提醒则由保存的渠道选择执行体。
       */
      if (spec.entry === 'qq_private') proactiveSender = session
      entries.push(entryServer)
    }
    /*
     * ==========================================================================
     *  post-Lv2 / ADR-110 `D04`/`D14`：**主动调度器的启动**
     * ==========================================================================
     * ⚠️ 三个条件**同真**才启动（缺任何一个都**不启动**，且如实记为什么）：
     * ```text
     * ① `CHARACTER_QQ_PROACTIVE_MODE !== 'off'`（`D14`）
     * ② `CHARACTER_ENTRY_SCOPED_CONVERSATIONS === true` ——
     *    计划 §8 的硬要求：关着时两条入口共用同一条会话 ⇒
     *    "QQ 的近期窗口只读 QQ 自己的会话"在结构上不成立 ⇒ **失败关闭，不将就**
     * ③ QQ 入口会话在（它是执行体；没有它就没有网关那一步）
     * ```
     * ⚠️ `listPendingReminders` 用的是**同一条**冻结的纯函数
     *    （`reminderOccurrenceKey`）算键 —— 与 `reserveOccurrence` 用的是同一个键，
     *    否则"排的那条"和"占用的那条"会对不上（那是静默的重复发送）。
     */
    if (flags.qqProactiveMode !== 'off' && !flags.entryScopedConversations) {
      logger.warn(
        '[qq-proactive] 主动调度**不启动**：CHARACTER_QQ_PROACTIVE_MODE 不是 off，' +
          '但 CHARACTER_ENTRY_SCOPED_CONVERSATIONS 不是 true（计划 §8 的硬要求）'
      )
    } else if (flags.qqProactiveMode !== 'off' && proactiveSender === undefined) {
      logger.warn('[qq-proactive] 主动调度**不启动**：没有 QQ 入口会话（没有执行体）')
    } else if (flags.qqProactiveMode !== 'off' && proactiveSender !== undefined) {
      const policy = readProactivePolicy(process.env)
      reminderRuntimeChannels = flags.qqProactiveMode === 'on' ? specs.map(spec => spec.entry) : []
      const reminderScheduling = createReminderScheduling({ db: kernel.stores.db, characterId: kernel.characterId,
        channels: reminderRuntimeChannels,
        registry: channel => reminderDeliveryChannel(kernel.stores.db, channel),
        /* ★ S3 ③ 缺口 B：同上（coexist 路径）；`undefined` ⇒ 0 = 从没入站过 */
        lastInboundAt: async () => (await lastInboundAt(kernel.stores.db, kernel.characterId)) ?? 0,
        /* ★ S3 ③：同上（coexist 路径）；暂停读数与关心机会预检同源 */
        paused: async () => (await readControl(kernel.stores.db, kernel.characterId))?.paused === true,
        /* ★ 续发间隔：同上（coexist 路径） */
        repeatIntervalMs: flags.reminderRepeatIntervalMs,
        execute: async (channel, request) => await scheduler.runBackground(async () => {
          const sender = reminderSenders.get(channel)
          return sender ? await sender.deliverProactiveQqText({ ...request, ...(channel === 'qq_private' ? {} : { channel }) })
            : { outcome: 'refused' as const, code: 'reminder_entry_absent' }
        }),
        reading: reading => logger.info(`[reminder] ${JSON.stringify(reading)}`),
      })
      proactiveScheduler = new ProactiveScheduler({
        timer: createCronerTimer({ timeZone: policy.timeZone }), policy,
        ...reminderScheduling,
        onCareOpportunity: async ({ at }) => {
          /*
           * ==================================================================
           *  post-Lv2 / ADR-110 `D03`/`D04`：一次自主关心机会
           * ==================================================================
           * ⚠️ 这里**只**做"够不够格"的判定 + 把**不够格的原因**具名记下来。
           *    **不**调模型、**不**发东西 —— 因为来源那一半还没接线（见下面 `L-QQP-07`）。
           * ⚠️ 判据全在冻结的纯函数里（`precheckCareOpportunity`），这里只负责**喂真读数**：
           * ```text
           * paused          ← notification_control（落库的，不是内存变量）
           * 日额度          ← countQuotaUsage（按**策略时区**的日界，不是宿主机）
           * lastCareAt      ← 上一次关心**占额**的时刻（含结果不明与明确失败）
           * lastInboundAt   ← 最近一次真实入站（`user_message` + `actor_type='user'`）
           * 在途候选        ← 还在 pending/evaluating/prepared/dispatching 的实例行
           * ```
           */
          const policy = readProactivePolicy(process.env)
          /*
           * ⚠️ **先看"上一轮她说过会儿再说"**（迁移 `0016`）：还压着就**不问**。
           *    放在 `precheck` 之前是刻意的：它是"上一次机会的延续"，
           *    与"这一轮够不够格"是两件事 —— 混进去会污染那一套判据的读数。
           */
          const pendingDeferrals = await pendingCareDeferrals(
            kernel.stores.db,
            kernel.characterId,
            at
          )
          if (pendingDeferrals.length > 0) {
            logger.info(
              `[qq-proactive] 关心机会：上一轮改期到 ` +
                `${new Date(pendingDeferrals[0]!).toISOString()} 还没到 ⇒ 本轮不问`
            )
            return
          }
          const window = zonedDayWindow(at, policy.timeZone)
          const [control, careUsedToday, allUsedToday, lastCareAt, inbound, candidateInFlight] =
            await Promise.all([
              readControl(kernel.stores.db, kernel.characterId),
              countQuotaUsage(kernel.stores.db, {
                characterId: kernel.characterId,
                dayStart: window.start,
                dayEnd: window.end,
                kind: 'care',
              }),
              countQuotaUsage(kernel.stores.db, {
                characterId: kernel.characterId,
                dayStart: window.start,
                dayEnd: window.end,
              }),
              lastAcceptedAt(kernel.stores.db, kernel.characterId, 'care'),
              lastInboundAt(kernel.stores.db, kernel.characterId),
              hasInFlightOccurrence(kernel.stores.db, kernel.characterId),
            ])
          const precheck = precheckCareOpportunity({
            mode: flags.qqProactiveMode,
            paused: control?.paused === true,
            entryScopedConversations: flags.entryScopedConversations,
            now: at,
            policy,
            ...(inbound === undefined ? {} : { lastInboundAt: inbound }),
            ...(lastCareAt === undefined ? {} : { lastCareAt }),
            newInboundSinceLastCare:
              inbound !== undefined && (lastCareAt === undefined || inbound > lastCareAt),
            careUsedToday,
            allUsedToday,
            candidateInFlight,
            permissionVersion: PROACTIVE_CARE_PERMISSION_VERSION,
          })
          if (!precheck.eligible) {
            logger.info(
              `[qq-proactive] 关心机会不合格：${precheck.code}` +
                (precheck.deferredUntil === undefined
                  ? ''
                  : `（下次 ${new Date(precheck.deferredUntil).toISOString()}）`)
            )
            return
          }
          /*
           * ⚠️ `L-QQP-07`：**够格了，但今天仍旧发不出去** —— 而且理由必须是具名的。
           *
           * ```text
           * 关心的候选**必须**带"已有依据引用"（计划 §4.2 逐字："附理由码、已有依据引用"），
           * 而依据只能来自既有的 ContextCompiler（同一个 §4.2：「由既有 ContextCompiler
           * 装配专用系统机会」）。
           * ⇒ 那条 `system_opportunity` section **还没建** ⇒ 可用依据集是**空的** ⇒
           *   `verifyProactiveSources` 会以 `proactive_source_set_unavailable` 失败关闭
           *   （**空集即拒**是刻意的：拿不到可用集就不输出，而不是"没查到失效就当它有效"）。
           * ```
           * ⇒ 所以这里**不花这次模型调用**，如实记下"机会够格、但依据面还没接线"。
           *   ⚠️ **绝不**用一个编造的依据或程序模板硬凑一条"关心"出来 ——
           *      那等于替她说了一句她没有任何依据可说出口的话。
           */
          logger.info(
            `[qq-proactive] 关心机会够格（${precheck.opportunityKey} · dryRun=${String(precheck.dryRun)} · ` +
              `空闲=${String(Math.round(precheck.idleMs / 60_000))}分）`
          )
          /*
           * ==================================================================
           *  依据面（ADR-111）：**同一个构造**既喂简报、又渲审计面
           * ==================================================================
           * ⚠️ `S04` 要求"生成前与发送前用**同一套**可用集构造逻辑" ⇒ 这里算**一次**，
           *    两个用途共用（喂给模型的闭集 + 写进 `system_opportunity` 的那一份）。
           *    各算一次就会变成"复核复的是另一件事"。
           */
          const built = await buildProactiveSourceCandidates(kernel.stores.db, {
            characterId: String(kernel.characterId),
          })
          const sources = boundProactiveSources(built.candidates)
          const opportunitySection = renderSystemOpportunitySection(built.candidates)
          if (opportunitySection === undefined) {
            /*
             * ⚠️ **空依据集 ⇒ 不调模型、不发**（`S06`）：她**没有依据可说**时，
             *    唯一诚实的结局就是"这一轮没有这一块"。绝不编造依据、绝不用模板硬凑。
             */
            logger.info(
              `[qq-proactive] 关心机会够格但**依据面为空**（L-QQP-07）⇒ 不调模型、不发` +
                `（信念 ${String(built.readings.beliefs)} · 目标 ${String(built.readings.goals)}` +
                ` · 记忆 ${String(built.readings.memories)}）`
            )
            return
          }
          const careOutcome = await runCareOpportunity({
            occurrenceKey: precheck.opportunityKey,
            /* `shadow` 档：完整产生选择与审计，但**不**真的发（`D14`） */
            dryRun: precheck.dryRun,
            briefing: {
              opportunity: '这会儿没有人新说话；这是一次你可以主动开口的机会。',
              localTime: zonedDayWindow(at, policy.timeZone).dayKey,
              timezone: policy.timeZone,
              sources,
              /* ⚠️ 用**既有**的冻结上限，不新编一个数 */
              textBudget: MAX_NOTIFICATION_TEXT_CODEPOINTS,
            },
            evaluate: careEvaluationPort!,
            store: {
              reserveOccurrence: async (reserveInput) => {
                const reserved = await reserveOccurrence(kernel.stores.db, {
                  occurrenceKey: reserveInput.occurrenceKey,
                  characterId: kernel.characterId,
                  kind: 'care',
                  dueAt: at,
                  permissionVersion: PROACTIVE_CARE_PERMISSION_VERSION,
                  policyVersion: precheck.permissionVersion,
                })
                return {
                  created: reserved.created,
                  ...(reserved.occurrence === undefined ? {} : { state: reserved.occurrence.state }),
                }
              },
              advanceCare: async (advanceInput) =>
                await advanceOccurrence(kernel.stores.db, advanceInput.occurrenceKey, {
                  to: advanceInput.to,
                  ...(advanceInput.text === undefined ? {} : { text: advanceInput.text }),
                }),
              /* `defer` ⇒ 落进迁移 `0016` 那一列（tick 下一轮会跳过还没到期的） */
              deferOpportunity: async (deferInput) =>
                await deferOccurrence(kernel.stores.db, deferInput.occurrenceKey, deferInput.until),
            },
            dispatch: {
              assertDeliverable: (generation) => qqDelivery!.assertDeliverable(generation),
              beginDispatch: async (beginInput) => await qqDelivery!.beginDispatch(beginInput),
              settleConfirmedFailure: async (failInput) =>
                await qqDelivery!.settleConfirmedFailure(failInput),
            },
            action: {
              execute: async (executeInput) =>
                await proactiveSender!.deliverProactiveQqText({
                  occurrenceKey: executeInput.occurrenceKey,
                  text: executeInput.text,
                }),
            },
            /* ⚠️ 当前代次（没有连接时为 null ⇒ 失败关闭） */
            generation: qqDelivery!.currentGeneration(),
            now: at,
          })
          /* ⚠️ 读数**不含正文** */
          logger.info(
            `[qq-proactive] 关心机会 ${precheck.opportunityKey} → ${JSON.stringify(careOutcome)}` +
              `（依据 ${String(sources.length)} 条：信念 ${String(built.readings.beliefs)}` +
              ` · 目标 ${String(built.readings.goals)} · 记忆 ${String(built.readings.memories)}）`
          )
        },
        onReading: (reading) => {
          logger.info(`[qq-proactive] ${JSON.stringify(reading)}`)
        },
      })
      await proactiveScheduler.start()
      /*
       * ⚠️ 装钩子：提醒入口新建意图后**必须**让调度器重排（它只在启动时列出待办）。
       *    没装上的读数就是"意图建了、日志里却没有 `reminder_armed`"（2026-10-07 实测踩到）。
       */
      reminderRefreshHook = async () => {
        await proactiveScheduler?.refresh()
      }
      logger.info(
        `[qq-proactive] 调度器已启动：mode=${flags.qqProactiveMode} · 时区=${policy.timeZone} · ` +
          `时段=${String(policy.activeWindow.startHour)}–${String(policy.activeWindow.endHour)} · ` +
          `下一次=${String(proactiveScheduler.readings().reminderNextRunAt)}`
      )
    }
    /*
     * 停机触发：**stdin EOF**（与 `--bridge` 同源）。
     * ⚠️ 这一行**不**解析任何协议：stdin 在本模式下只当"还要不要继续服务"的信号。
     */
    process.stdout.write(
      `COEXIST_READY entries=${specs.map((spec) => `${spec.entry}:${String(spec.port)}`).join(',')}\n`
    )
    for await (const _line of stdinLines()) {
      void _line
    }
    logger.info('[coexist] stdin 已关闭：停止接收新入站（先关监听）')
  } finally {
    /* ⚠️ **先停主动调度器**：它会在库里推进实例状态 ⇒ 必须在关库**之前**停 */
    proactiveScheduler?.stop()
    if (proactiveScheduler && !await proactiveScheduler.drain()) throw new Error('reminder_drain_timeout')
    /*
     * 收尾顺序（`D07` 的两半，顺序不能换）：
     *   ① **先关监听**（不再收新入站）
     *   ② **等调度器排空**（在飞的轮次跑完 —— 停机不是丢下它们；有界，超时如实记）
     *   ③ **再销毁已接入的连接**（否则那些 transport 任务永远不返回、进程不退出）
     *   ④ 走 owner 的唯一关库链
     */
    for (const entry of entries) {
      /* ⚠️ **不 await**：`server.close()` 的回调要等连接都结束（见 `shutdown()` 的注释） */
      entry.server.close()
    }
    const drained = await scheduler.whenIdle(30_000)
    logger.info(`[coexist] 在飞轮次排空：${drained ? '已排空' : '**超时**（有界 30s，如实记）'}`)
    logger.info(
      `[coexist] 调度读数（**不含正文**）：${JSON.stringify(
        scheduler.readings.map((reading) => ({
          entry: reading.entry,
          waitMs: reading.waitMs,
          runMs: reading.runMs,
          outcome: reading.outcome,
        }))
      )}`
    )
    for (const entry of entries) {
      await entry.shutdown()
    }
    /* 只有核心收尾能关库（`D07`）：走 owner 的唯一关库链 */
    await owner.close()
    await shutdown()
  }
}

async function runMemoryAdminCommand(
  argv: readonly string[],
  kernel: KernelHandle,
  userName: string
): Promise<number> {
  const command = parseMemoryAdminArgs(argv.slice(argv.indexOf('memory') + 1).concat(
    argv.filter((a) => a.startsWith('--memory-'))
  ))

  if (command.kind === 'usage') {
    console.log('\n' + memoryAdminUsage())
    if (command.problem !== undefined) console.log(`\n⚠️ ${command.problem}`)
    return 2
  }

  const db = kernel.stores.db
  const store = createNativeMemoryStore(db)
  const ids = resolveIds(userName)
  const owner = entityRef('character', String(kernel.characterId))

  /** 把一条记忆的证据解析成真实事件（反查用） */
  const loadEvidenceEvents = async (record: {
    sourceRefs: readonly { kind: string; id: string }[]
  }) => {
    const conversationIds = record.sourceRefs
      .filter((ref) => ref.kind === 'conversation_event')
      .map((ref) => ref.id)
    if (conversationIds.length === 0) return []
    const all = await recentConversationEvents(db, {
      characterId: kernel.characterId,
      limit: 5000,
    })
    return all.filter((e) => conversationIds.includes(String(e.id)))
  }

  switch (command.kind) {
    case 'list': {
      const records = await store.list({
        owner,
        ...(command.status !== undefined
          ? { status: command.status as Parameters<typeof store.list>[0]['status'] }
          : {}),
        ...(command.type !== undefined
          ? { type: command.type as Parameters<typeof store.list>[0]['type'] }
          : {}),
        limit: command.limit,
      })
      const filters = [
        command.status !== undefined ? `status=${command.status}` : '',
        command.type !== undefined ? `type=${command.type}` : '',
      ]
        .filter((s) => s !== '')
        .join(' ')
      console.log('\n' + renderMemoryList(records, `Memory 列表${filters ? `（${filters}）` : ''}`))
      return 0
    }

    case 'get': {
      const record = await store.get(command.memoryId as never)
      if (record === null) {
        console.log(`\n⚠️ 找不到记忆 ${command.memoryId}`)
        console.log('   （用 pnpm memory:list 看有哪些；id 必须完整，包括 `mem:` 前缀）')
        return 1
      }
      console.log('\n' + renderMemoryDetail(record))
      return 0
    }

    case 'history': {
      if (command.memoryId !== undefined) {
        const record = await store.get(command.memoryId as never)
        if (record === null) {
          console.log(`\n⚠️ 找不到记忆 ${command.memoryId}`)
          return 1
        }
        if (record.canonicalKey === undefined) {
          // Episode 没有槽位 —— 它的"历史"就是它自己
          console.log('\n' + renderMemoryTimeline([record], `Memory ${command.memoryId} 的历史`))
          console.log('\n（Episode 家族没有事实槽位，因此它的历史只有它自己）')
          return 0
        }
        const slot = await store.listByCanonicalKey(record.canonicalKey)
        console.log(
          '\n' + renderMemoryTimeline(slot, `槽位 ${record.canonicalKey} 的完整历史`)
        )
        return 0
      }

      // 按 predicate 查：先规范化，再找该槽位
      const { normalizePredicate } = await import('./kernel/contracts/memory-predicates.ts')
      const normalized = normalizePredicate(command.predicate!)
      const all = await store.list({ owner, limit: 500 })
      const inSlot = all.filter(
        (r) => isClaimContent(r.content) && r.content.predicate === normalized
      )
      if (inSlot.length === 0) {
        console.log(`\n⚠️ 槽位 ${normalized} 上没有任何记忆`)
        return 1
      }
      const key = inSlot[0].canonicalKey
      const slot = key !== undefined ? await store.listByCanonicalKey(key) : inSlot
      console.log('\n' + renderMemoryTimeline(slot, `槽位 ${normalized} 的完整历史`))
      return 0
    }

    case 'sources': {
      const record = await store.get(command.memoryId as never)
      if (record === null) {
        console.log(`\n⚠️ 找不到记忆 ${command.memoryId}`)
        return 1
      }
      const events = await loadEvidenceEvents(record)
      console.log('\n' + renderMemorySources(record, events))
      return 0
    }

    case 'stats': {
      const counts = await memoryCounts(db, owner)
      const byProcessor = await countByProcessorVersion(db, owner)
      const unsupported = await unsupportedMemories(db, owner)
      const contaminated = await contaminatedMemories(db, owner)
      const integrity = await memoryIntegrityProblems(db, owner)
      const all = await store.list({ owner, limit: 500 })
      const unregistered = all.filter(
        (r) => isClaimContent(r.content) && !isRegisteredPredicate(r.content.predicate)
      ).length

      console.log(
        '\n' +
          renderMemoryStats({
            ...counts,
            byProcessor,
            unsupported: unsupported.length,
            contaminated: contaminated.length,
            unregisteredPredicate: unregistered,
          })
      )
      /*
       * M5-PRE：完整性两句 —— 与上面那两行**分开打印**，因为它们量的是**状态**，
       * 而 `unsupported` / `contaminated` 量的是**行数**。
       * 混在一行会重演这次缺陷：`0 unsupported` 让人以为库存是干净的，
       * 而实际上"证据指向的事件已经不在了"它根本看不见。
       */
      console.log('\n  Memory 完整性（M5-PRE）：')
      console.log(`    dangling evidence links      : ${integrity.danglingEvidenceLinks.length}`)
      console.log(`    dangling memory_events       : ${integrity.danglingMemoryEvents.length}`)
      console.log(`    无活证据的记忆（孤儿）        : ${integrity.memoriesWithoutLiveEvidence.length}`)
      console.log(`    无活事件流的记忆（不可 replay）: ${integrity.memoriesWithoutLiveEvents.length}`)
      if (integrity.danglingEvidenceLinks.length > 0) {
        console.log(
          '    （悬空 evidence link 若属于**仍有活证据**的记忆，那是"用户显式抹掉那段历史"的痕迹：\n' +
            '      删它会破 MI-11 的 A == B，因此刻意保留；真正的孤儿必须为 0）'
        )
      }
      return 0
    }

    case 'audit': {
      const all = await store.list({ owner, limit: command.limit })
      // 计划书第 217 节说"随机抽取"。这里用**确定性**的洗牌
      // （按 id 的稳定摘要排序）而不是 Math.random：
      // 一份每次运行都换样本的审计清单无法被复核
      const shuffled = [...all].sort((a, b) =>
        contentFingerprintKey(String(a.id)) < contentFingerprintKey(String(b.id)) ? -1 : 1
      )
      /*
       * S4-1（2026-09-26）：⑤ 的撤回文案按 MEMORY_RETRACTED.payload.reason 区分。
       * 原因取自领域事件流（memory_events → character_domain_events）——
       * 与 memory:history / memory:sources 同一权威源；查不到时渲染层如实写
       * "原因未提供"，不再冒充"用户要求忘掉"（真库缺陷修复撤回曾被误标）。
       */
      const retractReasons = new Map<string, MemoryRetractReason>()
      for (const record of shuffled) {
        if (record.status !== 'retracted') continue
        const events = await domainEventsForMemory(db, record.id)
        const retractedEvent = [...events].reverse().find((e) => e.type === 'MEMORY_RETRACTED')
        const reason = (retractedEvent?.payload as { reason?: unknown } | undefined)?.reason
        if (reason === 'explicit_forget' || reason === 'explicit_correction' || reason === 'audit') {
          retractReasons.set(String(record.id), reason)
        }
      }
      console.log('\n' + renderMemoryAudit(shuffled, retractReasons))
      return 0
    }

    case 'retract': {
      /*
       * **写操作**。走与她在对话里"忘掉这件事"**完全相同**的事件链：
       *   放行口 → MEMORY_RETRACTED → reducer → 投影
       * 计划书第 71 节禁止绕过事件直接 UPDATE。
       *
       * 它需要一条"触发事件"（`triggeredByEventId`）—— 那是"这次撤回由什么引起"。
       * 管理员手动的撤回不是由某句话引起的，但领域事件要求有来源，
       * 因此这里用**该记忆自己的最后一条证据**作为来源：
       * 那正是"这条记忆被建立时的那次对话"，语义上说得通（"基于当时的记录，判定它不该保留"）。
       */
      const record = await store.get(command.memoryId as never)
      if (record === null) {
        console.log(`\n⚠️ 找不到记忆 ${command.memoryId}`)
        return 1
      }
      const trigger = record.sourceRefs.find((r) => r.kind === 'conversation_event')
      if (trigger === undefined) {
        console.log('\n⚠️ 这条记忆没有对话事件作为来源，无法确定触发事件 —— 撤回失败')
        return 1
      }

      const { createMemoryMutationValidator } = await import(
        './kernel/policies/memory-validator.ts'
      )
      const { applyAcceptedEvents } = await import(
        './infrastructure/persistence/event-store.ts'
      )
      const { applyMemoryEvent } = await import(
        './infrastructure/persistence/memory-store.ts'
      )
      const { findEventRefs } = await import(
        './infrastructure/persistence/conversation-store.ts'
      )
      const { hasProcessedOperation } = await import(
        './infrastructure/persistence/job-store.ts'
      )

      const validator = createMemoryMutationValidator({
        registry: kernel.registry,
        sources: { findEvents: (ids) => findEventRefs(db, ids as never) },
        processed: { hasProcessed: (key) => hasProcessedOperation(db, key) },
        lookup: {
          findActiveByFingerprint: async (input) => {
            const found = await store.getActiveByFingerprint(input.owner, input.fingerprint)
            return found === null ? undefined : { memoryId: found.id }
          },
          findActiveByCanonicalKey: async (input) =>
            (await store.getActiveByCanonicalKey(input.canonicalKey)).map((r) => ({
              memoryId: r.id,
            })),
          getRecord: async (id) => (await store.get(id)) ?? undefined,
        },
      })

      const outcome = await validator.validate({
        characterId: kernel.characterId,
        owner,
        candidates: [],
        mutation: 'explicit',
        operation: 'retract',
        triggeredByEventId: trigger.id,
        target: {
          memoryId: record.id,
          reason: 'audit',
          note: `管理员手动撤回：${command.reason}`,
        },
      })

      if (outcome.accepted.length === 0) {
        console.log(`\n⚠️ 撤回被放行口拒绝：`)
        for (const r of outcome.rejected) console.log(`   ${r.code}: ${r.message}`)
        return 1
      }

      const applied = await applyAcceptedEvents(db, kernel.characterId, outcome.accepted, [], Date.now())
      for (const event of applied.domainEvents) await applyMemoryEvent(db, event)
      console.log(`\n✅ 已撤回 ${command.memoryId}（reason=audit）`)
      console.log(`   领域事件：${applied.domainEvents.map((e) => String(e.id)).join(', ')}`)
      console.log('   原始对话**未删除**（计划书第 59 节：认知遗忘 ≠ 数据删除）')
      return 0
    }

    case 'replay': {
      if (command.all) {
        const summary = await store.rebuildCharacterMemories(owner)
        console.log(`\n重放整个 Memory Space：${summary.rebuilt} 条`)
        console.log(`  一致：${summary.rebuilt - summary.mismatched}  不一致：${summary.mismatched}`)
        for (const detail of summary.details.filter((d) => !d.equal)) {
          console.log(`  ❌ ${String(detail.memoryId)}: ${detail.differences.join(', ')}`)
        }
        return summary.mismatched === 0 ? 0 : 1
      }
      const result = await store.rebuildMemory(command.memoryId as never)
      console.log(`\n重放 ${command.memoryId}`)
      console.log(`  折叠事件数：${result.appliedEvents}`)
      console.log(`  A == B    ：${result.equal ? '✅ 一致' : '❌ 不一致'}`)
      if (!result.equal) {
        console.log(`  差异字段  ：${result.differences.join(', ')}`)
        console.log('')
        console.log('  ⚠️ 不一致意味着**某次写入与事件流不符**：')
        console.log('     要么有人绕过事件改了库，要么 reducer 的某个分支不是纯函数。')
        return 1
      }
      return 0
    }
  }
}

/**
 * M4.5 Action Admin（计划书 §31）。
 *
 * ============================================================================
 *  它是**只读**的，且必须能在模型不可达时跑
 * ============================================================================
 * 与 `memory:*` 同一条理由（见 `src/invocation.ts`）：
 * "她到底做了什么"最需要被查的时候，常常正是模型服务抖动的时候。
 *
 * ⚠️ 所有过滤都走 `ExecutionLedgerPort` 里**同一个**实现
 *    （`listRecords` 的 status 是 SQL 过滤）——
 *    CLI 不自己读事件流再筛，否则量具与系统就分叉了（ADR-035）。
 */
async function runActionAdminCommand(
  argv: readonly string[],
  kernel: KernelHandle,
  userName: string
): Promise<number> {
  const command = parseActionAdminArgs(
    argv
      .slice(argv.indexOf('action') + 1)
      .concat(argv.filter((a) => a.startsWith('--action-')))
  )

  if (command.kind === 'usage') {
    console.log('\n' + actionAdminUsage())
    if (command.problem !== undefined) console.log(`\n⚠️ ${command.problem}`)
    return 2
  }

  const ledger = createActionLedgerStore(kernel.stores.db)
  const characterId = kernel.characterId
  void userName

  switch (command.kind) {
    case 'list': {
      const records = await ledger.listRecords({
        characterId,
        ...(command.status !== undefined ? { status: command.status } : {}),
        ...(command.capability !== undefined ? { capability: command.capability } : {}),
        limit: command.limit,
      })
      const filters = [
        command.status !== undefined ? `status=${command.status}` : '',
        command.capability !== undefined ? `capability=${command.capability}` : '',
      ]
        .filter((s) => s !== '')
        .join(' ')
      console.log(
        '\n' + renderActionList(records, `动作记录${filters !== '' ? `（${filters}）` : ''}`)
      )
      return 0
    }

    case 'show': {
      const events = await ledger.getEventsByActionId(characterId, asActionId(command.actionId))
      if (events.length === 0) {
        console.log(`\n⚠️ 找不到动作 ${command.actionId}`)
        console.log('   （用 pnpm action:list 看有哪些；id 必须完整，包括 `act:` 前缀）')
        return 1
      }
      const record = foldRecord(events)
      if (record === undefined) {
        console.log(`\n⚠️ 动作 ${command.actionId} 只有请求、没有终态（还悬着）`)
        console.log('   ' + renderActionTrace(events).split('\n').slice(0, 8).join('\n   '))
        return 1
      }
      console.log('\n' + renderActionDetail(record))
      /*
       * §31 的最后一个问题："最终回复是什么"。
       *
       * 答案**不在动作账本里**（账本只管她做过什么，ADR-034），
       * 而在这一轮 trace 指向的 assistant 事件里。
       * 因此这里做一次显式连接，并如实标注"还没写回复"的情况 ——
       * 因为"查不到"与"她没说"是两件事。
       */
      const trace = await getTrace(kernel.stores.db, asTraceId(String(record.traceId)))
      if (trace?.outputEventId === undefined) {
        console.log('  最终回复     : (这一轮还没有写回复事件)')
      } else {
        const event = await getConversationEvent(kernel.stores.db, trace.outputEventId)
        console.log(
          `  最终回复     : ${event === undefined ? '(事件读不到)' : String(event.content ?? '').replace(/\n/g, ' / ')}`
        )
      }
      return 0
    }

    case 'trace': {
      const events = await ledger.getEventsByTraceId(asTraceId(command.traceId))
      console.log('\n' + renderActionTrace(events))
      return events.length === 0 ? 1 : 0
    }

    case 'audit': {
      const records = await ledger.listRecords({ characterId, limit: command.limit })
      console.log('\n' + renderActionAudit(records))
      return 0
    }
  }
}

/** 稳定排序用的键（避免 Math.random 让审计样本每次不同） */
function contentFingerprintKey(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 1000003
  return String(hash).padStart(7, '0')
}

/**
 * Lv4.5 / `P2`：**候选版本**的推导（只读准备的另一半判据）。
 *
 * ```text
 * candidateRevision = f(候选文本, 影响召回的投影修订)
 * ```
 * ⚠️ 为什么带上投影修订：同一句话在"记忆/信念/关系投影变了之后"召回结果可能不同，
 *    所以"文本没变"**不足以**说明旧候选还有效。外壳只要比较这个字符串就知道
 *    手里那份候选是不是过期了 —— 过期即弃，不必问 LG 第二次。
 *
 * ⚠️ 它是**确定性**的（同一输入 ⇒ 同一版本），因此重发同一个候选不会假装成"新候选"。
 */
function candidateRevisionOf(
  userText: string,
  revisions: Readonly<Record<string, number>>
): string {
  const material = [userText, ...Object.entries(revisions).sort(([a], [b]) => (a < b ? -1 : 1)).flat().map(String)].join('\u0000')
  let hash = 0
  for (let i = 0; i < material.length; i += 1) hash = (hash * 33 + material.charCodeAt(i)) >>> 0
  return `prep:${hash.toString(16).padStart(8, '0')}`
}

/**
 * `--migrate`：**显式**的 schema 升级入口（默认只预览）。
 *
 * ============================================================================
 *  为什么需要它（一次事故换来的）
 * ============================================================================
 * M3 的迁移 0003 给 `character_definitions` 加了 `definition_json`，
 * 而已存在的那一行不会因此拥有它 —— 结果是真实库一升级，
 * **每条命令都在启动时失败**（`seed_definition_json_missing`，实测挂住 600 秒）。
 *
 * 当时人没有任何机会事先看到"这次迁移会动到她的 Seed 行"：迁移是在
 * 某次普通启动里悄悄发生的。所以现在 schema 变更是一个**显式动作**：
 *
 *     pnpm migrate          只读地列出待应用的迁移（**不写库**）
 *     pnpm migrate:apply    真正应用
 *
 * 普通命令遇到待应用迁移时会**拒绝启动**并指向这里。
 */
async function runMigrateCommand(apply: boolean): Promise<number> {
  const userName = process.env.USER_NAME ?? 'Alex'

  // 本命令本来就是用来动真实库 schema 的：显式放行两步闸。
  allowProductionDatabase()
  if (apply) allowKernelMigration()

  // 单独装配一个最小 runtime（不跑 kernel、不建会话）
  const characterModule = await import('./character/index.ts')
  const character = characterModule.character
  const { AgentRuntime, stringToUuid } = await import('@elizaos/core')
  const sqlPlugin = (await import('@elizaos/plugin-sql')).default
  const { initDatabase, kernelMigrationAllowed } = await import('./db/index.ts')

  console.log('')
  console.log('='.repeat(72))
  console.log(apply ? 'Character Kernel schema 迁移' : 'Character Kernel schema 迁移（预览）')
  console.log('='.repeat(72))
  console.log('')

  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin],
    conversationLength: 16,
    settings: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
      OPENAI_BASE_URL: process.env.BASE_URL_FOR_MIGRATE ?? 'https://api.deepseek.com',
      OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
      OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
    },
  })

  /*
   * INC-01 WP4（`AT4.1`）：`--migrate` **也**是真实库 opener —— 而它的**预览**分支
   * 连 `initDatabase` 都绕过了（它自己调 `registerPlugin` + `runPluginMigrations`）。
   * 不接状态机的话，"设一个环境变量就能打开真实库"这条缺口会原样留在这里。
   */
  const migrateDataDir = productionDataDirOf()
  const migrateGuarded =
    process.env.PROJECT_LG_SANDBOX === undefined && isProductionDir(migrateDataDir)
  let ready: DbReady | undefined
  let previewVersion = 0
  let previewPending: { version: number; name: string; statements: number }[] = []

  const openDatabase = async (): Promise<void> => {
    // 预览模式：先只看待办，**不应用**
    if (!apply) {
      await runtime.registerPlugin(sqlPlugin)
      await runtime.runPluginMigrations()
      const { getRawDb: getDb, pendingMigrations, currentSchemaVersion } = await import(
        './infrastructure/persistence/db.ts'
      )
      const db = getDb(runtime)
      previewVersion = await currentSchemaVersion(db)
      previewPending = await pendingMigrations(db)
      return
    }
    // 应用模式：initDatabase 里已放行，会真的跑迁移
    ready = await initDatabase(runtime, sqlPlugin)
  }

  let handle: ProductionOpenHandle | undefined
  try {
    if (migrateGuarded) {
      handle = await prepareProductionOpen({
        dataDir: migrateDataDir,
        snapshotRoot: productionSnapshotRootOf(),
        operationKind: 'migrate',
        deps: {
          openDatabase,
          // 同 buildRuntime：停服务/关库都走 WP3 的唯一实现（`runtime-shutdown.ts`）
          stopServices: () => stopRuntimeServices(runtime),
          closeDatabase: async () => await closeDatabaseConnection(runtime),
          isDatabaseClosed: () => isDatabaseClosed(runtime),
          lastVerifiedSnapshotId: () => lastVerifiedSnapshotId(productionSnapshotRootOf()),
        },
      })
      await handle.open()
    } else {
      await openDatabase()
    }

    if (!apply) {
      console.log(`  当前 schema 版本：${previewVersion}`)
      console.log('')
      if (previewPending.length === 0) {
        console.log('  ✅ 没有待应用的迁移 —— schema 已是最新。')
      } else {
        console.log(`  待应用的迁移（${previewPending.length} 个）：`)
        for (const item of previewPending) {
          console.log(`    · #${item.version} ${item.name}（${item.statements} 条语句）`)
        }
        console.log('')
        console.log('  ⚠️ 迁移会改 schema。它**不会**删改业务数据行，但：')
        console.log('     · 若迁移新增了非空列或需要装载的数据，升级后**首次启动可能失败**')
        console.log('       （M3 的 0003 就是这样：旧 Seed 行缺 definition_json）')
        console.log('     · 想留底就先自己备份 data/pglite')
        console.log('')
        console.log('  确认后执行：pnpm migrate:apply')
      }
      console.log('')
      console.log('（预览模式：本次没有改动任何数据。）')
      console.log('='.repeat(72))
      void userName
      void stringToUuid
      return 0
    }

    if (ready === undefined) {
      throw new Error('initDatabase 没有返回读数：拒绝把"没有库"当成"库就绪"')
    }
    console.log(`  当前 schema 版本：${ready.kernelSchemaVersion}`)
    console.log(`  ElizaOS 插件表   ：${ready.tables.length} 张`)
    console.log(`  kernel 迁移放行  ：${kernelMigrationAllowed() ? '是（本次显式 --apply）' : '否'}`)
    console.log('')
    console.log('  ✅ 迁移已应用。')
    console.log('='.repeat(72))
    return 0
  } finally {
    /*
     * INC-01 WP3（`AT3.5` 的同一理由）：迁移入口**自己**建了一个 runtime，
     * 因此它也必须有**自己的**收尾句柄 —— 否则 `--migrate --apply` 跑完
     * adapter 已经建好、而连接从未关闭（事故的第三个缺口在这条路径上的形态）。
     *
     * INC-01 WP4（`AT4.3`）：关闭之后再由状态机做 post-close verified snapshot 并释放租约。
     */
    await createRuntimeShutdown(runtime, {
      afterRun: async (reading) => {
        if (handle === undefined) return
        await handle.finish({ closed: reading.closed, detail: reading.note, afterClose: true })
      },
    })
      .shutdown()
      .catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const userName = process.env.USER_NAME ?? 'Alex'
  const argv = process.argv.slice(2)
  const scripted = argv.filter((a) => !a.startsWith('--'))
  /*
   * WP6.1（K-28）：**入口模式的唯一判定点**。
   *
   * 有位置参数（`tsx src/main.ts "…"`）= 程序化一次性提交 ⇒ 由 agent 侧提供内容；
   * 没有 = 交互式 readline 控制台 ⇒ 由人类直接提供内容。
   * 二者写进账本的**权威归因不同**（SERVICE/agent-runner vs USER/<id>），
   * 而这一点在 M5.1.1 之前完全不可区分（AGENTS.md 里记的那次 D01 事故）。
   */
  const entryMode = conversationEntryModeOf(argv)
  const qqPrivate = entryMode === 'interactive_human_qq_private' ? readQqPrivateConfig(process.env) : undefined
  const inspectOnly = argv.includes('--inspect')
  const historyOnly = argv.includes('--history')
  const dumpPrompt = argv.includes('--dump-prompt')
  /** --dump-prompt 的对照视图：渲染旧路径（M1 会看到什么），默认渲染新路径 */
  const dumpLegacy = argv.includes('--legacy')
  const resetRequested = argv.includes('--reset')
  const kernelStatus = argv.includes('--kernel-status')
  /** --seed-status：M3 的 Seed 身份视图（版本 / 指纹 / 历史）。只读 */
  const seedStatus = argv.includes('--seed-status')
  const resetKernelRequested = argv.includes('--reset-kernel')
  /** --backfill-events：把 M1/M2 时期的对话补进事实账本（默认只预览） */
  const backfillRequested = argv.includes('--backfill-events')
  const backfillApply = argv.includes('--apply')
  // 干跑模式：我执行的测试默认不写入记忆，是否写入由用户决定
  const dryRun = argv.includes('--test') || argv.includes('--dry-run')
  /** --migrate：显式的 schema 升级入口（默认只预览，加 --apply 才改库） */
  const migrateRequested = argv.includes('--migrate')
  const migrateApply = argv.includes('--apply')
  /**
   * `--dev-server`：M5.1 的开发者查询面（**只读** HTTP，仅 loopback）。
   *
   * 它默认**不存在** —— 只有显式带上这个标志才会监听端口（AT5.1 的 feature guard）。
   * `--port N` 可选；缺省 {@link DEFAULT_DEVELOPER_HTTP_PORT}。
   */
  const devServer = argv.includes('--dev-server')
  const devPortIndex = argv.indexOf('--port')
  const devPort =
    devPortIndex >= 0 && argv[devPortIndex + 1] !== undefined
      ? Number(argv[devPortIndex + 1])
      : undefined
  const flags = readKernelFlags()

  /*
   * ==========================================================================
   *  WP2 / ADR-104 `D14`：**已知目录事实探一次**（只有 role 档才探）
   * ==========================================================================
   * 它解决的是实测故障："模型没有任何办法知道真实用户名，于是只能猜
   * `C:\Users\user\Desktop`"（同一个 trace 里猜了两次）。
   *
   * ⚠️ 三件刻意的行为：
   *   ① 缺省 `rules` ⇒ **一个进程都不 spawn**（零开销，旧档行为逐字不变）
   *   ② 探测**只读**且**有硬超时**（2 秒）；失败/超时 ⇒ 如实记一行，**不阻塞启动**
   *      （启动因为一次探测失败而挂掉，比"这一轮她说不知道桌面在哪"糟得多）
   *   ③ 结果进**只读缓存**，决策器与规划器看的是**同一份**渲染文本
   */
  if (flags.toolDecisionMode === 'role') await primeKnownDirectoryFacts()

  /*
   * `--migrate` 必须走**自己的一条路**，而且要在 `preflight()` 之前。
   *
   * 两个理由：
   *   1. 它不需要 API Key（迁移与模型无关），走 preflight 会白要求一个 Key
   *   2. 它要能在"schema 待升级"的状态下运行 —— 而普通命令此时会
   *      被 `kernel_migration_pending` 拒绝启动。迁移入口自己必须是能进去的
   */
  if (migrateRequested) {
    process.exitCode = await runMigrateCommand(migrateApply)
    return
  }

  /*
   * ⚠️ 只读命令**不要求模型可达**。
   *
   * ==========================================================================
   *  这是一个实测到的操作性缺陷
   * ==========================================================================
   * `preflight()` 会真的发一次 `/chat/completions` 去探测连通性。
   * 它挡在 `memory:*` / `--kernel-status` / `--seed-status` 这些
   * **纯本地只读**命令前面，于是：
   *
   *   实测 `pnpm memory:audit` 报
   *     `模型连通性检查失败 (HTTP 522)`
   *   —— 而审计读的是本地 `memory_records` 表，
   *      整个过程一次模型都不调。
   *
   * 后果不是"慢一点"，而是**在最需要审计的时候审计不了**：
   * 模型服务商抖动、限流、或干脆下线，
   * 正好是最想看看"她到底记住了什么"的时候。
   *
   * `--migrate` 早先就因为同类理由（"迁移与模型无关"）
   * 被放在 preflight 之前。这里把同一条理由推广到全部只读命令。
   *
   * 分类逻辑在 `src/invocation.ts`（纯函数，因而**可以被测试**）——
   * `main.ts` 在模块加载时会无条件执行 `main()`，
   * 因此留在这一行里的规则永远不会有机器证据。
   *
   * 注意**保留** Key 的存在性检查：运行时装配仍然需要它。
   * 去掉的只是那个**网络探测** —— 它是"想聊天时尽早炸掉"的手段，
   * 而不是"读自己的库"的前置条件。
   */
  await preflight({ probeConnectivity: requiresModelConnectivity(argv) })
  const runtime = await buildRuntime(userName)
  /*
   * ==========================================================================
   *  INC-01 WP3（`AT3.2` / `AT3.4`）：收尾句柄与信号路径
   * ==========================================================================
   * 注册点选在这里（runtime 一建好、`initialize()` 之前）：
   *   · 于是 `runtime.initialize()` 中途失败也会被最外层 `finally` 收尾
   *   · 信号处理只**触发**一次有序收尾，**不调用 `process.exit()`**
   *     （`process.exit()` 会抢跑 `finally`，那正是"留脏状态"的成因之一）
   * `taskkill /F` 不可捕获 —— 它由 WP1 的租约自动释放与 WP2 的最后一份
   * verified snapshot 兜底，本函数不假装能处理它。
   */
  /*
   * ==========================================================================
   *  ADR-101：**LG 启动时**拉起浏览器 sidecar（D1 = 启动时；D2 = 退出时关掉）
   * ==========================================================================
   * ⚠️ 两件事**同时**要成立才会走这条路：`browser` 那一档开着 **且** autostart 开着。
   *    任何一个没开 ⇒ `browserSidecar` 保持 undefined ⇒ 行为与 ADR-100 **逐字相同**
   *    （LG 只是一个连固定地址的 HTTP 客户端，从不 spawn 任何进程）。
   *
   * ⚠️ 失败**在启动时就报**，并打出闭集原因码（ADR-101 §3.5）：
   *    自启动配错了不该等到用户第一次用浏览器才发现。
   * ⚠️ **不重试**：一次启动一次尝试。起不来就是起不来，如实说。
   * ⚠️ 它会让浏览器弹出一个连接页（上游每次 `--extension` 启动都会，见 ADR-101 §1）
   *    —— 这是**已知且登记**的代价，不是意外。
   */
  if (flags.browserEnabled && flags.browserSidecarAutostart) {
    const supervisor = createBrowserSidecarSupervisor({
      url: flags.browserSidecarUrl,
      dir: flags.browserSidecarDir,
      tokenFile: flags.browserSidecarTokenFile,
      browser: flags.browserSidecarBrowser,
      profile: flags.browserSidecarProfile,
      caps: flags.browserSidecarCaps,
      expectedVersion: flags.browserSidecarVersion,
      expectedEntrySha256: flags.browserSidecarEntrySha256,
      /*
       * 租约放 `data/`（与 `local-file-recovery` 同一个运行态目录）。
       * ⚠️ 它**不是**配置项：换路径只会让两份租约各说各话，没有正当用途。
       */
      leasePath: 'data/browser-sidecar.lease',
    })
    browserSidecar = supervisor
    const outcome = await supervisor.ensure()
    if (outcome.action === 'already-healthy') {
      logger.info(
        `[browser-sidecar] 已有一个健康的 sidecar，复用（不重复启动）` +
          (outcome.configWarning !== undefined
            ? ` —— ⚠️ 但**自启动的配置是坏的**：reason=${String(outcome.configWarning)}` +
              `${outcome.detail !== undefined ? ` · ${outcome.detail}` : ''}` +
              `（这次能用是因为端口上已经有一个别人起的；配好之前它永远不会自己起）`
            : '')
      )
    } else if (outcome.action === 'started') {
      logger.info(
        `[browser-sidecar] 已启动（pid=${String(outcome.pid)}，用时 ${String(outcome.waitedMs ?? 0)}ms）` +
          ` —— ⚠️ 浏览器会弹出一个连接页，请在**那个标签**里打开你要给她看的网址（ADR-101 §1）`
      )
    } else {
      logger.info(
        `[browser-sidecar] **启动失败**（不重试）：reason=${String(outcome.reason)}` +
          `${outcome.detail !== undefined ? ` · ${outcome.detail}` : ''}` +
          ` —— 浏览器那一档会如实失败；其它能力不受影响`
      )
    }
  }

  runtimeShutdown = createRuntimeShutdown(runtime, {
    /*
     * INC-01 WP4（`AT4.3`/`AT4.5`）：收尾读数出来**之后**才决定要不要晋升 post-close 快照。
     * `afterClose: true` ⇒ 不重复 stop/close（WP3 的唯一收尾路径刚刚做过），
     * 只做 ⑦ post-close verified snapshot 与 ⑧ 释放租约（写 `cleanClose`）。
     * `productionOpen` 为 undefined ⇒ 本次没有打开真实库，钩子什么都不做。
     */
    afterRun: async (reading) => {
      /*
       * ADR-101 D2：**关掉本进程自己起的** sidecar。
       *
       * ⚠️ 放在 `afterRun`（收尾读数**已经定稿**之后）而不是收尾路径里，理由是刻意
       *    与 INC-01 那条同一个：这里是"额外的动作"，**抛出也不改变退出码**。
       *    一个关不掉的 sidecar 不该让整次收尾判成失败 —— 它会如实记一行日志。
       * ⚠️ 只关**自己起的那个**（`stop()` 里有子进程句柄才动手）；别人的租约不碰。
       */
      if (browserSidecar !== undefined) {
        try {
          await browserSidecar.stop()
          logger.info('[browser-sidecar] 收尾：已关掉本进程启动的 sidecar')
        } catch (error) {
          logger.info(
            `[browser-sidecar] 收尾：关掉 sidecar 时出错（不影响退出码）：${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }
      }
      if (productionOpen === undefined) return
      const result = await productionOpen.finish({ closed: reading.closed, detail: reading.note, afterClose: true })
      logger.info(
        `[inc-01] 生产状态机收尾：${result.states.join(' → ')}` +
          `（cleanClose=${String(result.cleanClose)}，post-close 快照 ${result.postCloseSnapshotId ?? '未记录'}）`
      )
    },
  })
  const shutdown = (): Promise<unknown> => runtimeShutdown!.shutdown()
  /*
   * 现在收尾句柄存在了 ⇒ 把"资格丢失"的有序停机入口接上（`D05`）。
   * 接的是**同一个** `shutdown()`，不另发明一条收尾路径。
   */
  stopAfterQualificationLoss = (): void => {
    void shutdown().catch((error: unknown) => {
      logger.error(
        `[qualification] 资格丢失后的有序停机**失败**：${
          error instanceof Error ? error.message : String(error)
        }`
      )
    })
  }
  let signalShutdownStarted = false
  const onShutdownSignal = (signal: NodeJS.Signals): void => {
    if (signalShutdownStarted) return
    signalShutdownStarted = true
    logger.info(`收到 ${signal}：开始有序收尾（不调用 process.exit，避免抢跑 finally）`)
    void runtimeShutdown?.shutdown().then((reading) => {
      logger.info(`收尾读数：${reading.note}`)
    })
  }
  process.once('SIGINT', onShutdownSignal)
  process.once('SIGTERM', onShutdownSignal)
  // Character Kernel 必须在 initialize() 之后装配：它要读写自己的表，
  // 而那些表要等 initDatabase() 的迁移跑完才存在。
  //
  // ⚠️ `withGuardTimersUnrefed` 不是装饰：上游 `AgentRuntime.registerService`
  //    （`@elizaos/core@1.7.2` dist:50037-50042）为**每个服务**建一个 30s 的
  //    "初始化超时"定时器却**从不清除**，于是这个进程在命令跑完、库关好之后
  //    还会被它按住 **30 秒**才退出。实测：`--kernel-status` 墙钟 31.4s，
  //    其中 29.85s/32.65s 是 CPU profile 里的 `(idle)`。
  //    作用域收窄到这一次 `initialize()`，只 unref ≥30s 的定时器（不动回调与语义），
  //    理由与"为什么不用 process.exit()"见该模块的文件头。
  const initialized = await withGuardTimersUnrefed(() => runtime.initialize())
  if (initialized.report.unrefed > 0) {
    logger.info(
      `[boot] 上游守卫定时器已 unref：${initialized.report.unrefed} 个（延时 ${initialized.report.delays.join('/')}ms）` +
        ' —— 否则本进程会在收尾后白等这么久才退出（见 infrastructure/runtime/guard-timers.ts）'
    )
  }
  attachEventLog(runtime)
  const kernel = await buildKernel(runtime)

  /*
   * ============================================================================
   *  M9.5 / WP7-A 第 0 步 —— **受控的"跑一轮索引维护"模式**（`--maintain-index`）
   * ============================================================================
   * ```text
   * 为什么必须有它：WP7-A 要在**真实库**上建索引，而
   *   · `pnpm m9.5:maintain` **故意拒绝真实库**（它只维护副本）
   *   · 计划 §19.3 逐字**禁止另写直连真实库的脚本**
   * ⇒ 唯一合规入口就是这里 —— **既有入口**，库已按既有纪律开好（租约 → pre-open 快照 → token），
   *   收尾由既有的 `createRuntimeShutdown` 负责（`cleanClose` 照旧）。
   *
   * ⚠️ 落点**必须**在 kernel 就绪之后、任何"进聊天循环 / 起 dev server"之前（零复制那条纪律）。
   * ⚠️ 它**不读**任何语义模式开关、**不改**任何开关：这是一次**显式运维动作**，跑完即 return。
   * ⚠️ 这里的 `await` 是**对的**：它不在用户轮次的关键路径上（与 `commitEvents` 的投递相反）。
   * ```
   */
  if (argv.includes('--maintain-index')) {
    const maintenance = createProductionMaintenanceTrigger({
      db: kernel.stores.db,
      namespace: String(kernel.characterId),
      encoderClient: semanticEncoderShared({
        manifest: embeddingManifestShared(),
        labModelRoot: LAB_MODEL_ROOT,
        deadlineMs: SEMANTIC_RECALL_DEADLINE_MS,
        readyTimeoutMs: SEMANTIC_RECALL_READY_TIMEOUT_MS,
      }),
      manifest: embeddingManifestShared(),
      readIntegrityProblems: () =>
        memoryIntegrityProblems(
          kernel.stores.db,
          entityRef('character', String(kernel.characterId))
        ),
    })
    console.log('='.repeat(72))
    console.log('M9.5 / WP7-A：跑一轮索引维护（真实库 · 受控动作）')
    console.log('='.repeat(72))
    /*
     * ⚠️ **必须先确保派生 schema**（2026-10-01 **副本预演实测发现的缺陷**）：
     * builder 的 preflight 会核对"库记到的派生 schema 版本"，而真库/副本上
     * `memory_semantic_meta` 是 **0 行** ⇒ `recordedVersion = 0 ≠ 1` ⇒ **refused**，
     * 而 `runOnce` 只把 `refused` 放进返回值、**没人打印** ⇒ **整轮静默什么都没做**。
     * ⇒ 两处都补：① 先 ensure schema ② 把 refused 与计数**打出来**。
     */
    await ensureSemanticIndexSchema(kernel.stores.db, { now: Date.now() })
    await maintenance.trigger('manual')
    const health = await readSemanticIndexHealth(kernel.stores.db, String(kernel.characterId))
    console.log(`  已发布代：${String(health.publishedGenerationId)}`)
    for (const generation of health.generations) {
      console.log(
        `  · ${generation.generationId} [${generation.buildState}] ` +
          `indexed=${String(generation.indexed)} eligible=${String(generation.eligible)} ` +
          `pending=${String(generation.pending)} failed=${String(generation.failed)} ` +
          `excluded=${String(generation.excludedByPolicy)} watermark=${String(generation.processedWatermark)}`
      )
    }
    console.log(`  落后于源的条目：${String(health.staleOrOrphaned)}`)
    if (health.generations.length === 0) {
      /* ⚠️ **不许静默**：一轮跑完却一代都没有 ⇒ 必须说出来（上面那个缺陷就是静默造成的） */
      console.log('  ⚠️ 一轮跑完但**一代都没有** ⇒ 维护没有生效（看上面的 warn；常见原因：schema 未 ensure / refused）')
    }
    console.log('='.repeat(72))
    return
  }
  // 本次运行 id：一个进程一个。它只进 Trace（计划书第 9 节），
  // 于是"重启前后的两次运行"在 trace 里可区分，而"她是谁/用户是谁"不受影响。
  const runtimeId = newRuntimeId()
  logger.info(describeKernelFlags(flags))

  /*
   * ==========================================================================
   *  M4.1 / D3：这个开关**必须**在被打开时如实告警，而不是假装它能用
   * ==========================================================================
   * `CHARACTER_MEMORY_BACKGROUND_ENABLED` 被读进 flags、也会被打印，
   * 但**没有任何生产代码消费它**：`src/` 里没有任何文件 import
   * `kernel/app/memory/job.ts`。因此打开它**不会**启用自动记忆抽取。
   *
   * 实测（M4 验收）：开关打开后跑两轮普通陈述（"我最近开始学 Rust 了" /
   * "我平时住在西安"），记忆条数变化 **0** —— 而她的回复是
   * "西安。住的那条，记了。"。**一个安静的、看起来能开的开关，
   * 比一个不存在的开关更危险**：它会让人以为功能已经启用。
   *
   * 本阶段（M4.1）不接生产 —— 理由见 `docs/architecture/memory-lifecycle.md`：
   * 自动从闲聊抽取记忆会一次引入 false positive / silent write /
   * implicit consent / model nondeterminism 等一整批新风险，
   * 为了修一个 S3 而临时上线它，可能产生新的 S1。
   */
  if (flags.memoryBackgroundEnabled) {
    logger.warn(
      '[memory-background] ⚠️ 这个开关**没有接到任何东西**：生产代码里没有任何地方' +
        '消费它，打开它**不会**启用自动记忆抽取。后台抽取当前是' +
        ' EXPERIMENTAL / NOT PRODUCTION-WIRED（见 docs/architecture/memory-lifecycle.md）。' +
        '如果你想要"从日常对话里自动记住事情"，那需要先补接线，而不是打开这个开关。'
    )
  }
  logger.info(
    `[identity] runtime=${runtimeId} character=${String(kernel.characterId)} ` +
      `seed=v${kernel.definition.seedVersion} hash=${kernel.identitySnapshot.snapshotHash.slice(0, 12)}`
  )

  // 遥测：只在显式开启时才会真的导出（默认 phoenix，见 ADR-005）。
  // 遥测端口本身**永不抛异常**，因此这里不需要 try/catch 保护主链路。
  const telemetryConfig = readTelemetryConfig()
  const telemetryPort = createTelemetry(telemetryConfig)
  const telemetry = new TelemetryRecorder(telemetryPort)
  if (telemetryConfig.enabled) {
    logger.info(
      `[telemetry] 已启用导出：${telemetryPort.name} → ${telemetryConfig.endpoint}` +
        `${telemetryConfig.dumpPath ? `（离线 dump 到 ${telemetryConfig.dumpPath}）` : ''}`
    )
  }

  // --kernel-status：M2.5 的内核视图（事实账本 / 领域事件 / 投影 / trace / M3 身份快照）
  if (kernelStatus) {
    console.log('\n' + (await renderKernelStatus(kernel)))
    await shutdown()
    return
  }

  // --seed-status：M3 的 Seed 视图（版本 / 指纹 / 历史 / 与代码的比对）。只读。
  if (seedStatus) {
    console.log('\n' + (await renderSeedStatus(kernel)))
    await shutdown()
    return
  }

  /*
   * ==========================================================================
   *  M5.1 WP2：开发者查询面（`--dev-server`）
   * ==========================================================================
   * 计划书 AT2.6 的 HTTP Adapter + AT5.1 的 feature guard。
   *
   * 三件事在这里定死（细节在 `src/infrastructure/dev/http-server.ts`）：
   *   ① **必须显式带标志**才监听 —— 默认不存在
   *   ② **只绑回环**；非回环地址在启动期就抛
   *   ③ 服务**只读**：路由表里没有任何写方法，且只接受 GET
   *
   * 装配只做注入：身份快照来自 `kernel.identitySnapshot`（**唯一**来源），
   * 库句柄来自 `kernel.stores.db`。查询本身不在这里实现（AT2.1）。
   */
  if (devServer) {
    const service = createDeveloperQueryService({
      db: kernel.stores.db,
      characterId: kernel.characterId,
      owner: entityRef('character', String(kernel.characterId)),
      runtimeId,
      identitySnapshot: kernel.identitySnapshot,
      /*
       * M5.5 / ADR-045 `A10`：开发者面**如实报**这一轮装了什么。
       *
       * ⚠️ 为什么必须显式注入：dev 面的"运行时能力"默认读的是 M4.5 的
       *    默认登记表（三个能力），而装配层现在多装了一个 `web.search`
       *    （追加登记，D-11）。不注入的话，开发者面会**少报**一个真实存在的能力 ——
       *    而 M5.1 的整套价值就是"开发者面不说谎"。
       */
      runtimeCapabilities: [
        { id: 'image.input', authority: 'kernel/contracts/image-input.ts',
          availability: flags.imageInputEnabled ? DEVELOPER_AVAILABLE : developerUnavailable('CHARACTER_IMAGE_INPUT_ENABLED=false'),
          note: '用户发送的 PNG/JPEG 图片随正式会话入模；近期原图支持追问与比较，附件跟随库快照保留' },
        /*
         * M9.5 启用计划 WP5 ③：`semantic_retrieval` 的可用性**读真实状态**，
         * 而不是写死"没建索引" —— 索引一旦建起来，硬编码就会变成**主动错误**
         * （开发者面会一直说没建，而它其实建了）。只读一条 `select`。
         */
        await semanticRetrievalCapability(kernel.stores.db),
        {
          id: WEB_SEARCH,
          authority: 'kernel/action/external-evidence-capability.ts',
          availability: flags.webSearchEnabled && flags.webSearchMode !== undefined && flags.webSearchJudgeTimeoutMs !== undefined
            ? DEVELOPER_AVAILABLE
            : developerUnavailable(
                flags.webSearchJudgeTimeoutMs === undefined
                  ? `CHARACTER_WEB_SEARCH_JUDGE_TIMEOUT_MS=${JSON.stringify(process.env.CHARACTER_WEB_SEARCH_JUDGE_TIMEOUT_MS ?? "")} 不是 ${SEARCH_JUDGE_TIMEOUT_MIN_MS}..${SEARCH_JUDGE_TIMEOUT_MAX_MS} 的整数：配置错误 ⇒ 未授予 web:search、未构造适配器与判定器（不静默截断、不回落缺省）`
                  : flags.webSearchMode === undefined
                  ? `CHARACTER_WEB_SEARCH_MODE=${JSON.stringify(flags.webSearchModeRaw)} 不是 ${SEARCH_MODES.join('/')}：配置错误 ⇒ 未授予 web:search、未构造适配器与判定器（不静默降级）`
                  : 'CHARACTER_WEB_SEARCH_ENABLED=false：能力已登记，但未授予 web:search、未构造适配器'
              ),
          note:
            `M5.5 · provider=${TAVILY_PROVIDER_ID} · ` +
            `一次搜索 1 次请求 / 0 重试 / 硬超时 ${D20_RULING.hardTimeoutMs}ms / 结果 ≤ ${D20_RULING.maxResults} · ` +
            `M5.5.1 · mode=${flags.webSearchMode ?? 'INVALID'} · 判定 ≤1 次/轮（显式与自动共用）`,
        },
        /*
         * 实用能力加装：四项能力经**既有注入点** `runtimeCapabilities` 如实上报可用性
         * （计划书 §2 第 6 点：「延用已有 `runtimeCapabilities` 注入点显示可用性」）。
         *
         * ⚠️ 可用性读的是**开关**，不是"能力在不在登记表里"：能力恒登记，
         *    所以"已登记但未授予权限/未构造适配器"必须在这里如实写成不可用 ——
         *    否则开发者面会**多报**四个真实不存在的执行器（先例：M5.5 的 `web.search`）。
         */
        ...[
          { id: WORKFLOW_SKILL, on: flags.workflowSkillsEnabled, note: '固定两项流程；仅成功加载后进入本轮上下文' },
          { id: PERSONAL_LIBRARY_SEARCH, on: flags.personalLibraryEnabled, note: `只读专用资料夹 ${PERSONAL_LIBRARY_ROOT}` },
          { id: ARXIV_RESEARCH, on: flags.arxivResearchEnabled && verifyArxivRuntimeSync(), note: '固定 arXiv MCP 0.8.1；元数据 45s / 正文 90s 硬超时；独立环境；网络响应按实际结果报告' },
          { id: MATH_CALCULATE, on: flags.mathCalculateEnabled, note: '受限算式 → 本地 BigNumber 计算（白名单 AST，独立可终止执行器，2s 硬超时）' },
          { id: DOCUMENT_READ, on: flags.documentReadEnabled, note: '沙箱内 PDF/DOCX/PPTX/XLSX → 专属 Python 环境的 convert_stream（≤10MiB，30s 硬超时）' },
          { id: WEB_READ, on: flags.webReadEnabled, note: '显式 HTTPS URL → 逐跳地址校验 + Readability 正文提取（解压后 ≤2MiB，15s 总超时，不执行脚本/不加载子资源）' },
          { id: IMAGE_OCR, on: flags.imageOcrEnabled, note: 'PNG/JPEG → 固定本地 OCR 模型（≤16MiB/20MP，30s 硬超时，缺资产零出站失败）' },
        ].map((entry) => ({
          id: entry.id,
          authority: [WORKFLOW_SKILL, PERSONAL_LIBRARY_SEARCH, ARXIV_RESEARCH].includes(entry.id)
            ? 'kernel/action/learning-capabilities.ts' : 'kernel/action/utility-capabilities.ts',
          availability: entry.on
            ? DEVELOPER_AVAILABLE
            : developerUnavailable(
                `CHARACTER_${entry.id === WORKFLOW_SKILL ? 'WORKFLOW_SKILLS' : entry.id === PERSONAL_LIBRARY_SEARCH ? 'PERSONAL_LIBRARY' : entry.id === ARXIV_RESEARCH ? 'ARXIV_RESEARCH' : entry.id === MATH_CALCULATE ? 'MATH_CALCULATE' : entry.id === DOCUMENT_READ ? 'DOCUMENT_READ' : entry.id === WEB_READ ? 'WEB_READ' : 'IMAGE_OCR'}_ENABLED=false${entry.id === ARXIV_RESEARCH ? ' 或运行环境未就绪' : ''}：能力已登记，但本次不可用（代码缺省即关闭档）`
              ),
          note: `${utilityCapabilityLabel(entry.id)} · 当轮内容额度 CHARACTER_TURN_CONTENT_TOKENS=${String(flags.turnContentTokens)} · ${entry.note}`,
        })),
      ],
    })
    /*
     * M5.1 WP3：控制面。
     *
     * 两个命令**都是只读**的，而且它们的实现就是"把 Query 面跑一遍并回报" ——
     * 因此控制面没有任何自己的读取逻辑（AT2.1 的纪律在这里同样成立）。
     * 将来若有命令会改变领域状态，它必须经 ActionGateway（STOP 条件 14），
     * 而不是在这里写一条新路径。
     */
    const control = createDeveloperControlService({
      characterId: kernel.characterId,
      handlers: [createDiagnosticControlHandler(service), createAuditControlHandler(service)],
      /*
       * WP9-A / U-03：durable authoritative audit 在**生产装配**里接线。
       *
       * ⚠️ 这里**故意不传** `developerIdentity`：今天的 HTTP/CLI/Page 面都没有身份或认证证据，
       * 因此 `initiator` 如实记 `Unknown(RUNTIME_UNRESOLVED)`（U-02：developer 是上下文角色、
       * 不是位次种类）。将来真有可解析的身份证据时，由**这个装配根**注入 ——
       * **绝不**从 `requestedBy.surface` 或请求载荷推导任何位次/权威。
       */
      audit: createDeveloperControlAuditWriter({ db: kernel.stores.db }),
    })
    const httpServer = await startDeveloperQueryServer({
      service,
      control,
      characterId: kernel.characterId,
      ...(devPort !== undefined && Number.isSafeInteger(devPort) ? { port: devPort } : {}),
    })
    console.log(
      `\n开发者面（只读查询 + 白名单控制 / 仅 loopback）：${httpServer.url}\n` +
        developerQueryRoutePatterns()
          .map((pattern) => `  GET  ${pattern}`)
          .join('\n') +
        '\n' +
        developerControlRoutePatterns()
          .map((pattern) => `  ${pattern}`)
          .join('\n') +
        `\n（控制面白名单：${control
          .listCommands()
          .map((fact) => fact.type)
          .join(' / ')}；缺省端口 ${DEFAULT_DEVELOPER_HTTP_PORT}；Ctrl+C 关闭）`
    )

    await new Promise<void>((resolve) => {
      const stop = (): void => resolve()
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
    await httpServer.close()
    await shutdown()
    return
  }

  /*
   * Memory Admin API（计划书第 133 节）。
   *
   * ⚠️ 它放在**这里**（kernel 装配之后）而不是像 `--migrate` 那样靠前：
   * 它要读 `memory_records` 等表，而那些表要等迁移 0005 跑完才存在。
   * 因此在真实库尚未升级时，这个命令会**被迁移闸拦住**并指向
   * `pnpm migrate` —— 那是正确的：命令与它要读的表必须同时就位。
   */
  if (argv.includes('--automatic-memory-status') || argv.includes('--automatic-memory-retry')) {
    try {
      const reading = argv.includes('--automatic-memory-retry')
        ? await authorizeAutomaticMemoryRetry(kernel.stores.db, kernel.characterId,
          Number(argv.find(value => value.startsWith('--source-sequence='))?.split('=')[1]),
          argv.includes('--apply') && !argv.includes('--dry-run') && !argv.includes('--test'),
          flags.memoryPostTurnModelEnabled ? MODEL_MEMORY_TARGET : undefined)
        : await readAutomaticMemoryHealth(kernel.stores.db, kernel.characterId, flags.memoryPostTurnModelEnabled ? MODEL_MEMORY_TARGET : undefined)
      console.log(JSON.stringify(reading, null, 2))
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'automatic_memory_control_failed')
      process.exitCode = 1
    } finally { await shutdown() }
    return
  }
  const memoryAdminRequested =
    argv.includes('memory') || argv.some((a) => a.startsWith('--memory-'))
  if (memoryAdminRequested) {
    const code = await runMemoryAdminCommand(argv, kernel, userName)
    await shutdown()
    process.exitCode = code
    return
  }

  /*
   * M4.5 Action Admin（计划书 §31）。
   *
   * 与 `memory:*` 同一个位置、同一条理由：它读 `character_action_events`，
   * 而那张表要等迁移 0006 跑完才存在（未迁移时会被迁移闸拦住并指向
   * `pnpm migrate` —— 那是正确的：命令与它要读的表必须同时就位）。
   *
   * 顺序上刻意与 memory 分支并列而不是合并：
   * "她记住了什么"与"她做过什么"是两本账（ADR-034），
   * 合成一个入口会让两者的用法与输出慢慢混起来。
   */
  /*
   * S8 / L-S8-09：故事体验撤回的**用户入口**（`pnpm story:withdraw`）。
   *
   * ⚠️ 它是**写操作**（追加 `STORY_EXPERIENCE_RETRACTED`）——与 memory/action 只读面并列
   *    而不是混进去：撤回改变长期认知的**使用资格**，是有代价的动作。
   * ⚠️ 失败关闭：来源不可解析 / 理由不在闭集 / **引用不存在** ⇒ 具名拒收且零写入。
   */
  if (argv.includes('--story-withdraw')) {
    const code = await runStoryWithdrawCommand({
      db: kernel.stores.db,
      characterId: kernel.characterId,
      argv: argv.slice(argv.indexOf('--story-withdraw') + 1),
      now: () => Date.now(),
    })
    await shutdown()
    process.exitCode = code
    return
  }
  /*
   * S8 / `L-S8-30` + `ADR-107` `R-2a′`：故事 run 的**显式开始**入口（`pnpm story:start`）。
   *
   * ⚠️ 它是**写操作**（写世界账本的第一条提交 `STORY_STARTED` @ revision 1）。
   *    放在这里而不是"自动开始"：`ADR-094` `D02.2①` 逐字要求
   *    "该会话存在一个**用户显式开始**的活跃 run……**不自动开始任何故事**"。
   * ⚠️ 失败关闭：runId 形状非法 / 已有活跃 run ⇒ 具名拒收且零写入（`run-lifecycle.ts`）。
   * ⚠️ 绑定是 `system`（`STORY_STARTED` 不允许 `user_choice`）—— 开局**不是**一次用户选择，
   *    这条由 `assertStoryCommitBinding` 强制，不靠这里自觉。
   */
  if (argv.includes('--story-start')) {
    const code = await runStoryStartCommand({
      db: kernel.stores.db,
      characterId: kernel.characterId,
      argv: argv.slice(argv.indexOf('--story-start') + 1),
      now: () => Date.now(),
    })
    await shutdown()
    process.exitCode = code
    return
  }
  const actionAdminRequested =
    argv.includes('action') || argv.some((a) => a.startsWith('--action-'))
  if (actionAdminRequested) {
    const code = await runActionAdminCommand(argv, kernel, userName)
    await shutdown()
    process.exitCode = code
    return
  }

  /*
   * ==========================================================================
   *  后 Lv2 / **ADR-109 `D01`/`D02`/`D06`/`D07`**：`--coexist`
   * ==========================================================================
   * **一个核心、两条受信入口**（QQ 私聊 + 皮套），同一进程、同一份库、同一套消费者。
   *
   * ⚠️ 缺省**不存在**（与 `--bridge` / `--dev-server` 同一条 feature-guard 纪律）：
   *    不带它就没有任何监听端口、没有第二条会话。
   * ⚠️ 它**不替代** `--bridge`：单入口（CLI / 单皮套 / 单 QQ）仍然走原路径，
   *    行为逐字不变。共存是**追加**的一条装配，不是替换。
   */
  if (argv.includes('--coexist')) {
    await runCoexistenceHost({
      runtime,
      userName,
      kernel,
      flags,
      telemetry,
      runtimeId,
      shutdown,
    })
    return
  }

  /*
   * ==========================================================================
   *  后 Lv2 · WP1：`--bridge` —— **受限聊天入口**（NDJSON over stdio）
   * ==========================================================================
   * 外壳（VTuber / 语音桥 / 其它本机客户端）只能通过它提交一句话、拿到
   * **已经过回复守卫**的回复。它**不是**第二个角色，也**不是**第二个事实权威：
   *
   *   · host = `ChatSession.send()`（**生产那一套装配**；`INV-PL2-09`）
   *   · 身份由 session 在构造时绑定，请求**无法**改（`INV-PL2-08`）
   *   · 受控消息种类（`turn-bridge.ts` 的登记表，**不建万能连接器**）：
   *     `SUBMIT_TURN`（正式轮次）· `CANCEL_TURN`（协作式取消）·
   *     `REPORT_SYNTHESIZED` / `REPORT_PLAYBACK`（Lv4.5 / P1 的合成账与交付账）；
   *     控制消息在慢轮次期间**不排队**（见 `runBridgeTransport`）
   *   · 失败**不回落**到任何默认 Agent（桥只回 `failed` + 具名码）
   *
   * ⚠️ 缺省**不存在**：不带 `--bridge` 就一行都不读（与 `--dev-server` 同一条
   *    feature-guard 纪律）。
   * ⚠️ 开发者面（`--dev-server`，只读 HTTP）与它**分开**：那是查询面，这是入口面。
   */
  if (argv.includes('--bridge')) {
    /*
     * Lv4.5 / `P1`：**交付账**（进程内；不写库、不新增 schema）。
     *
     * 它只回答"客户端确认**播完**了哪几句"。LG 的生成记录完整保留在
     * `conversation_events` 里 —— 交付账**不是**第二份生成记录，
     * 它是"已说出去"的唯一权威（媒体交付契约 §1）。
     *
     * ⚠️ 它的消费点正好两处，且都在这一个分支里：
     *    ① `REPORT_SYNTHESIZED` / `REPORT_PLAYBACK` 回报（写入）
     *    ② 本会话的最近对话视图（读取；见 `applyVoiceDeliveryView`）
     *    ⇒ 所以它**在构造会话之前**建好并传进去，不留"先建后补"的中间态。
     */
    const delivery = new VoiceDeliveryLedger()
    const session = new ChatSession(runtime, userName, { entryMode,
      /*
       * post-Lv2 / ADR-109 `D02`：**这一支就是皮套**（`--bridge` 且没有 `--qq-private`）。
       * ⚠️ 必须显式给 `entryKey`：只看 `entryMode` 的话皮套会被算成 `cli`，
       *    于是"自起子进程档"与"连接档（`--coexist`）"会把同一个皮套写进**两条**会话。
       */
      entryKey: chatEntryKeyOfMode(entryMode, { bridgeEntry: true }),
      ...(qqPrivate !== undefined ? { qqOwnerId: qqPrivate.ownerId } : {}),
      kernel,
      flags,
      telemetry,
      runtimeId,
      ...(qqPrivate === undefined ? { voiceDelivery: delivery } : {}),
    })
    await session.open()
    if (qqPrivate !== undefined) process.stdout.write('QQ_PRIVATE_READY\n')
    /*
     * 后 Lv2 · `L-PL2-04`：给生产 host 装上**取消登记表**。
     * ⚠️ 它是**协作式**的：外壳发 `CANCEL_TURN` 只是"记下意图"，
     * 真正停下发生在 host 的"模型调用之前"那个检查点。
     * 越过提交点之后取消**照常被受理**，但读数里 `alreadyCommitted: true`
     * —— 受理与"撤销"是两件事，我们不把后者说成前者。
     */
    const cancellation = new TurnCancellationRegistry()
    /*
     * ★ 2026-10-10 / R6：**把 host 提出来**（原来它是内联进构造的）。
     *   下面 QQ 私聊那一支要挂 `host.reportQqDelivery`；`TurnBridge` 读它是 **getter**
     *   （turn-bridge.ts:711-712 `get hostReportQqDelivery()`）⇒ 构造之后再赋值照样生效，
     *   与 coexist 那条入口的做法一致（main.ts:5852-5858）。
     */
    const host = sessionHost(session, {
      cancellation,
      delivery,
      /*
       * Lv4.5 / `P3`（选项 B）：**边听边查**的两个出口。
       *
       * ```text
       * sheIsSpeaking —— 交付账里还有"没播完"的片段 ⇒ 她正在说 ⇒ 提醒才有价值
       * lookup        —— 提前检索（走**同一个**动作网关；用户 2026-10-05 裁定 ②）
       * ```
       * ⚠️ 两个都是**能力注入**：不注入时桥如实报"能力缺席"、不假装做过。
       */
      sheIsSpeaking: () => delivery.hasUnplayed(),
      lookup: async (input) => await session.prepareLookup(input.query),
      /*
       * `P3`（中途纠正）：晚到的证据**属于她正在回答的那次开口**时，
       * 先**废弃未播余句**再给纠正段。
       *
       * ⚠️ 交付账的语义（`markSuperseded`）：`queued` ⇒ `cancelled`（**确定没播**），
       *    `playing` / `synthesized` ⇒ `unknown`（**已经发出去了**，不知道声卡播到哪）
       *    —— 这条区分正是"不许把'不知道'说成'确定没播'"。终态一个字都不动。
       * ⚠️ 返回**真的动了几段**（0 也是有效读数："当时没有未播余句"）。
       */
      supersedeUnplayed: ({ by, reason }) => delivery.markSuperseded({ by, reason }).length,
    })
    const bridge = new TurnBridge({ host })
    /*
     * Lv4.5 / `P3`：**有限插话**的开关由 `CHARACTER_INTERJECTION_ENABLED` 决定（代码缺省 off）。
     *
     * ⚠️ 这一行就是"开关必须被真的消费"的落点：关着时桥一次都不会产出短句
     *    （只读准备那一步的呼唤判定直接不跑）。
     */
    bridge.interjectionEnabled = session.interjectionEnabled
    /*
     * Lv4.5 / `P3`（选项 B）：把"**边听边查到底接上了没有**"打成一条启动读数。
     *
     * ⚠️ 这一行不是装饰：没有它，"提前检索能力没接上"与"接了但这个发音没触发"
     *    在日志里长得一模一样（都只是**没有**那条插话），而前者是**静默失效**。
     */
    logger.info(
      `[bridge] 提前检索（边听边查）：${session.actionRuntimeReady ? 'CONTEXT-READY（动作运行时已建好 ⇒ 会真的走网关）' : 'ABSENT（动作运行时不在 ⇒ 如实不查）'}`
    )
    bridge.setOutputSink(message => process.stdout.write(`${JSON.stringify(message)}\n`))
    /*
     * ========================================================================
     *  ★ 2026-10-10 / R6「提醒能力入口无关」—— S0-b：**把 coexist 的 QQ 投递链搬进来**
     * ========================================================================
     *  照 `main.ts:5847-5858` 逐条搬（那套装配已被 ADR-110 §25 走过一遍，形状是验过的）：
     *    ① 登记表的出站口**必须在 `openConnection` 这一步绑**（不是事后 `setOutputSink`）——
     *       没绑 ⇒ 它如实报 `qq_delivery_no_active_connection`（实测踩过，见 5839-5845 的注释）；
     *    ② 回执走 `host.reportQqDelivery`（外壳发 `REPORT_QQ_DELIVERY`）→ `reportReminderForChannel`，
     *       并带上**连接代次**（多外壳在线时旧代次不得覆盖新状态，`D06`）。
     *  ⚠️ 皮套入口**不**投递 QQ 文字（它投递的是"表演"）⇒ 这一支只对 `--qq-private` 生效。
     */
    const qqDelivery = qqPrivate !== undefined && kernel !== undefined && flags.qqProactiveMode !== 'off'
      ? proactiveDeliveryChannel(kernel.stores.db)
      : undefined
    const qqDeliveryGeneration = qqDelivery === undefined
      ? null
      : qqDelivery.openConnection(out => bridge.deliverQqText({ deliveryId: out.deliveryId, text: out.text }))
    if (qqDelivery !== undefined) {
      host.reportQqDelivery = async report =>
        await reportReminderForChannel(kernel!.stores.db, 'qq_private', qqDelivery, {
          ...report,
          ...(qqDeliveryGeneration === null ? {} : { generation: qqDeliveryGeneration }),
        })
    }
    const standaloneReminders = kernel ? await startStandaloneReminders({
      kernel, session, flags,
      /* ★ R6：**入口决定通道** —— 皮套入口 'avatar'，QQ 私聊入口 'qq_private'（原来后者被排除） */
      channel: qqPrivate === undefined ? 'avatar' : 'qq_private',
      write: out => bridge.deliverReminderText(out),
    }) : undefined
    /* ★ `report` 只在本地通道存在（`qq_private` 的报告走 host.reportQqDelivery，见上） */
    if (standaloneReminders?.report !== undefined) bridge.setReminderDeliveryReporter(standaloneReminders.report)
    const reading = await runBridgeTransport(bridge, {
      read: () => stdinLines(),
      write: (line) => process.stdout.write(`${line}\n`),
    }).finally(async () => await standaloneReminders?.stop())
    await session.close()
    logger.info(
      `[bridge] 收尾：读入 ${reading.linesIn} 行（解析 ${reading.parsed} / 畸形 ${reading.malformed}）· 写出 ${reading.linesOut} 行`
    )
    await shutdown()
    return
  }

  // --inspect：只看状态，不进对话。用于 L1-M2 的验收与日常排错。
  if (inspectOnly) {
    const ids = resolveIds(userName)
    console.log('\n' + (await renderInspector(runtime, ids.characterId, ids.userId, { events: 10 })))
    // M7 / WP5：关系投影的只读读回（未建档也如实说）
    console.log('\n' + (await renderRelationshipReadback(runtime, ids.characterId, ids.userId)))
    // M8 / WP5：情绪投影的三段式只读读回（canonical / effective / legacy 对照）
    //（affect 是 per-character 投影，不带 target——与关系读回的签名差异是刻意的）
    console.log('\n' + (await renderAffectReadback(runtime, ids.characterId)))
    // M9 / WP7：信念域只读读回（origin/cutover · 信念行与根/依赖 · 事件流 · 双流 job+水位）
    console.log('\n' + (await renderBeliefReadback(runtime, ids.characterId)))
    await shutdown()
    return
  }

  // --history：看她还记得什么（最近的消息原文），用于确认"历史是否真的在累积"。
  if (historyOnly) {
    const session = new ChatSession(runtime, userName, { entryMode, kernel, flags, telemetry, runtimeId })
    await session.open()
    console.log('\n' + (await session.renderHistory(20)))
    await shutdown()
    return
  }

  // --backfill-events：把 M1/M2 时期的既有对话补进 M2.5 的事实账本。
  //
  //   为什么需要它：新链路的"最近对话"来自 conversation_events，而那批老消息
  //   只存在于 memories。不补的话，升级后她会"忘了"你们之前聊过的一切
  //   （而 --history 里明明还在），看起来就像记忆丢了。
  //
  //   默认**只预览**；加 --apply 才真正写入。幂等（按来源消息 id 判重）。
  if (backfillRequested) {
    const ids = resolveIds(userName)
    const session = new ChatSession(runtime, userName, { entryMode, kernel, flags, telemetry, runtimeId })
    await session.open()

    const options = {
      characterId: kernel.characterId,
      conversationId: asConversationId(
        `dm-${kernel.definition.slug}-${stringToUuid(`user-${userName}`).slice(0, 8)}`
      ),
      roomId: session.roomId,
      userEntityId: stringToUuid(`user-${userName}`),
      agentEntityId: stringToUuid(`agent-entity-${character.id ?? character.name}`),
      userName,
    }

    const plan = await planBackfill(kernel.stores.db, options)
    console.log('')
    console.log('回填 M1/M2 对话 → M2.5 事实账本')
    console.log(`  房间里可回填 ${plan.total} 条（用户 ${plan.userCount} / 她 ${plan.characterCount}）`)
    console.log(`  账本现有 ${plan.existingEvents} 条`)
    for (const item of plan.items.slice(0, 6)) {
      const who = item.actorType === 'user' ? userName : character.name
      console.log(
        `    [${new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })}] ${who}: ` +
          `${item.content.replace(/\n/g, ' / ').slice(0, 46)}`,
      )
    }
    if (plan.items.length > 6) console.log(`    …还有 ${plan.items.length - 6} 条`)

    if (!backfillApply) {
      console.log('\n（预览模式，未写入）确认无误后加 --apply 真正写入。')
    } else {
      const result = await applyBackfill(kernel.stores.db, options, plan)
      console.log(
        `\n已写入 ${result.written} 条（已回填跳过 ${result.skippedAlreadyBackfilled} 条，` +
          `幂等命中 ${result.deduplicated} 条）`
      )
      console.log(`账本：${result.before} → ${result.after} 条`)
    }
    void ids
    await shutdown()
    return
  }

  // --reset：重置 M1/M2 层 —— 清空该房间的对话记忆 + 状态回到初始值。
  //   注意：它**不动** M2.5 的事实账本（那是另一层数据，见 --reset-kernel）。
  //   两个命令分开是刻意的：用户明确要求保留"只重置可见记忆"的能力，
  //   同时把差别写在输出与使用说明里，避免"以为清干净了其实没有"。
  if (resetRequested) {
    const ids = resolveIds(userName)
    const session = new ChatSession(runtime, userName, { entryMode, kernel, flags, telemetry, runtimeId })
    await session.open()
    const removed = await clearRoomMessages(runtime, session.roomId)
    const after = await resetState(
      runtime,
      ids.characterId,
      ids.userId,
      '手工重置：清空测试残留，状态回到初始值'
    )
    console.log('')
    console.log(`已清空该房间的对话记忆：${removed} 条`)
    console.log(
      `状态已重置：valence=${after.valence} arousal=${after.arousal} ` +
        `trust=${after.trust} closeness=${after.closeness}（v${after.version}）`
    )
    console.log(
      '\n注意：这只重置了"她能回忆的对话"与情绪/关系状态。\n' +
        '      她的事实账本（真实发生过的对话、变化历史、Trace）**没有被清空**，\n' +
        '      用 --kernel-status 仍能看到。若也要清掉，请运行 --reset-kernel。'
    )
    console.log('\n' + (await renderInspector(runtime, ids.characterId, ids.userId, { events: 3 })))
    await shutdown()
    return
  }

  // --reset-kernel：重置 M2.5 层 —— 清空事实账本、变化历史、投影、Trace、
  //   幂等记录与任务。**保留 Seed Identity**（她是谁不因重置而改变）。
  if (resetKernelRequested) {
    const ids = resolveIds(userName)
    const session = new ChatSession(runtime, userName, { entryMode, kernel, flags, telemetry, runtimeId })
    await session.open()
    const conversationId = asConversationId(
      `dm-${kernel.definition.slug}-${stringToUuid(`user-${userName}`).slice(0, 8)}`
    )
    const result = await resetKernelData(kernel.stores.db, {
      characterId: kernel.characterId,
      conversationIds: [String(conversationId)],
      projectionTypes: [...kernel.reducers.map((r) => r.projectionType)],
    })

    console.log('')
    console.log('已重置 Character Kernel（Seed Identity 保留）：')
    console.log(`  对话事件 conversation_events       : ${result.conversationEvents} 条`)
    console.log(`  领域事件 character_domain_events   : ${result.domainEvents} 条`)
    console.log(`  投影 character_projections         : ${result.projections} 行`)
    console.log(`  Trace character_traces             : ${result.traces} 条`)
    console.log(`  幂等记录 processed_operations      : ${result.processedOperations} 条`)
    console.log(`  任务 character_jobs                : ${result.jobs} 条`)
    /*
     * M5-PRE：记忆侧的清点必须**一起报**。分开报的理由与 trace 里
     * `domainEventIds` / `actionIds` 分开是同一条：
     *   · 上面两组是"她与用户之间发生过什么"
     *   · 下面一组是"她因此记住了什么"
     * 混成一行，"重置是不是真的干净"就无法被复核 —— 而这次缺陷正是"看起来干净"。
     */
    console.log(`  记忆 memory_records                : ${result.memoryRecords} 条（已无活证据/事件流者）`)
    console.log(`  记忆 subject links                 : ${result.memorySubjectLinks} 条`)
    console.log(`  记忆 evidence links                : ${result.memoryEvidenceLinks} 条`)
    console.log(`  记忆 memory_events                 : ${result.memoryEventLinks} 条`)
    console.log(
      `\n保留：Seed Identity（v${kernel.definition.seedVersion}）、` +
        '以及 M1/M2 层的对话记忆与状态（那些用 --reset 清）。'
    )
    void ids
    await shutdown()
    return
  }

  // --dump-prompt：只读导出本轮完整 prompt，用于排查"她怎么会说这种话"。
  //   不给参数就用最后一条用户消息还原最近一次提问。
  if (dumpPrompt) {
    const question = scripted.join(' ') || undefined
    const session = new ChatSession(runtime, userName, { entryMode, kernel, flags, telemetry, runtimeId })
    await session.open()

    const dump = await session.renderPromptDump(question, { legacy: dumpLegacy })

    const path = 'data/prompt-dump.txt'
    writeFileSync(path, dump, 'utf8')
    console.log(`\nprompt 已写入 ${path}（${dump.length} 字符）`)
    console.log(
      `provider 贡献：${dump.split('\n')[1]?.replace('# provider 贡献：', '') ?? '(见文件)'}`
    )
    await shutdown()
    return
  }

  /*
   * ============================================================================
   *  M4 验收 S3-3：进入对话前，补折叠"已提交、未折叠"的 Memory 领域事件
   * ============================================================================
   * 写入是两步（事件一个事务、折叠一个事务）。进程死在两步之间时，
   * 事实在账本里、投影里没有 —— 她会"暂时想不起来"，而且**不会自愈**。
   *
   * 实测证据：`m4:hardkill:verify` 用真实 `taskkill /F` 杀在写入中间，
   * 复现了 1 条这样的孤儿事件。
   *
   * 位置是**刻意的**：
   *   · 只在**真的进入对话**之前做 —— 只读命令（`memory:*` /
   *     `--kernel-status` / `--seed-status` / `--inspect` / `--dump-prompt`）
   *     在上面各自的分支里已经 return 了，因此"只读"承诺一个字节都不受影响
   *   · `--dry-run` / `--test` **不做**：那两个模式的承诺是"不写库"，
   *     而补折叠是一次写。下次真实对话会补上（缺口不会因此消失）
   *   · 不做成"启动即迁移"那种前置闸 —— 它**是修复，不是准入**，
   *     失败不该让她整个起不来（见 memory-recovery.ts 的说明）
   */
  if (!dryRun) {
    const recovery = await recoverMemoryProjections(kernel.stores.db)
    if (recovery.scanned > 0 || recovery.failed > 0) {
      logger.warn(
        `[memory-recovery] 扫描到未折叠的 Memory 领域事件 ${recovery.scanned} 条：` +
          `补折叠 ${recovery.refolded}、仅补登记 ${recovery.alreadyReflected}、失败 ${recovery.failed}`
      )
    }
    for (const failure of recovery.failures) {
      logger.error(
        `[memory-recovery] 补折叠失败 ${failure.domainEventId}（${failure.type}）` +
          ` code=${failure.code}：${failure.message} —— 事实未丢（仍在账本），` +
          '但这条记忆的投影仍然缺失，下次启动会再扫到'
      )
    }
  }

  const session = new ChatSession(runtime, userName, { entryMode, dryRun, kernel, flags, telemetry, runtimeId })
  await session.open()

  if (dryRun) {
    console.log(
      '\n[dry-run] 本次测试不会写入记忆、不记录状态变更、不推进互动时间。\n' +
        '[dry-run] 测试结束后我会询问你是否要把本次内容写入记忆。\n'
    )
  }

  let cliReminders: Awaited<ReturnType<typeof startStandaloneReminders>>
  try {
    if (scripted.length > 0) {
      for (const line of scripted) {
        const reply = await session.send(line)
        console.log(`\n${character.name}: ${reply}`)
      }
      return
    }

    if (kernel && !dryRun) cliReminders = await startStandaloneReminders({ kernel, session, flags, channel: 'cli',
      write: out => {
        const registry = reminderDeliveryChannel(kernel.stores.db, 'cli')
        const generation = registry.currentGeneration() ?? undefined
        output.write(`\n【提醒】${out.text}\n`, error => {
          void reportReminderForChannel(kernel.stores.db, 'cli', registry, { deliveryId: out.deliveryId, generation,
            status: error ? 'failed_confirmed' : 'api_accepted', ...(error ? { reason: 'stdout_write_failed' } : { messageId: `cli:${out.deliveryId}` }),
          }).catch(error => logger.warn(`[reminder] ${String(error)}`))
        })
        return { written: true }
      },
    })
    const rl = createInterface({ input, output })
    console.log(`\n已进入与「${character.name}」的对话（Ctrl+C 退出）\n`)
    for (;;) {
      const line = (await rl.question(`${userName}: `)).trim()
      if (!line) continue
      if (line === '/exit') break
      const reply = await session.send(line)
      console.log(`\n${character.name}: ${reply}\n`)
    }
    rl.close()
  } finally {
    await cliReminders?.stop()
    await session.close()
  }
}

/**
 * INC-01 WP3（`AT3.2`）：**进程级唯一的收尾句柄**。
 *
 * 它在 runtime 建好之后立刻被赋值，之后：
 *   · `main()` 的每个分支调它；
 *   · SIGINT / SIGTERM 调它（`AT3.4`）；
 *   · 最外层 `finally` 调它 —— 于是"某个新分支忘了关库"不再是可能的缺陷。
 *
 * 值放在模块级而不是 `main()` 局部，是因为最外层 `finally` 与信号处理
 * 都在 `main()` 的词法作用域之外（与文件末尾那个 `beforeExit` 遥测 flush 同一条理由）。
 */
let runtimeShutdown: ShutdownHandle | undefined

/*
 * ⚠️ **M9.5 / `L-M10-61` 第二个成因的**真正**落点**（2026-09-30）。
 *
 * ```text
 * 现象：`semantic=true` 时**进程不退出**（回复已产出、停机已开始，而进程 240s 仍被 SIGKILL）。
 * 机器读数（关库后 dump 存活句柄）：
 *   资源 ["PipeWrap","PipeWrap","PipeWrap","Timeout"] · 句柄 Socket×3
 *   ⇒ **worker 子进程还活着**（它的 stdin/stdout/stderr 三个管道就是那三个 PipeWrap）
 * 根因：`createEncoderClient` 被 `buildSemanticRecallProbe` 构造后**引用被丢掉**
 *   ⇒ 停机时没人 `close()` 它 ⇒ 子进程吊住 event loop。
 *   ⚠️ 第一版修法把 `close()` 放进了**类方法**的 `shutdown()` —— 而聊天路径走的是
 *      **模块级** `runtimeShutdown`（最外层 `finally`），**根本不是那一条** ⇒ 修了等于没修。
 * ```
 *
 * ⇒ 与 `runtimeShutdown` / `productionOpen` **同一条理由**放模块级：
 *   最外层 `finally` 与信号处理都在 `main()` 的词法作用域之外。
 * 幂等（`encoder-client.close()` 自己处理重复调用），且**绝不抛**（收尾不能被它带崩）。
 */
let semanticEncoderForExit: EncoderClient | undefined
let semanticEncoderExitDone = false

/**
 * ADR-101：本进程启动的浏览器 sidecar（`autostart` 关着时**永远是 undefined**）。
 *
 * ⚠️ 放模块级与 `runtimeShutdown` 同一条理由：收尾钩子在 `main()` 的词法作用域里，
 *    但"谁起的谁关"这件事必须活到最外层收尾。
 * ⚠️ 它**只**代表"我们起的那个"；别人起的 sidecar 不在这里，也就不会被我们关掉。
 */
let browserSidecar: BrowserSidecarSupervisor | undefined
/** M9.5 / WP4 · W3：启动补追赶**只投递一次**（每进程一次） */
let semanticStartupCatchUpDone = false

/*
 * M9.5 / WP4 · W1 前置 —— **编码器的三个常量提到模块级一处**。
 *
 * 它们原本是 `buildSemanticRecallProbe()` 的**局部常量**，而维护的 `runOnce` 也要用它们
 * ⇒ 两处各写一份必然漂开（本仓库反复记录的那类缺陷）⇒ 提到这里，两处**共用同一份**。
 */
const LAB_MODEL_ROOT = 'artifacts/m9.5/local/embedding-lab/models'
/* 单次编码的硬截止（超时 ⇒ SIGKILL 子进程；实测热编码中位 5 ms，冷加载 766 ms） */
const SEMANTIC_RECALL_DEADLINE_MS = 120_000
const SEMANTIC_RECALL_READY_TIMEOUT_MS = 180_000

/**
 * M9.5 / WP4 · W1 前置 —— **冻结清单的唯一加载点**（惰性 + 失败关闭）。
 *
 * ```text
 * 探针与维护的 `runOnce` 都要用它 ⇒ 两处各 load 一遍会各自抛、各自漂。
 * ⇒ 一处加载、一处校验（不合法就抛 —— 与原来同一个行为，只是只做一次）。
 * ```
 */
let sharedEmbeddingManifest: ReturnType<typeof loadEmbeddingManifest> | undefined
function embeddingManifestShared(): ReturnType<typeof loadEmbeddingManifest> {
  if (sharedEmbeddingManifest === undefined) {
    const manifest = loadEmbeddingManifest(join(process.cwd(), DEFAULT_EMBEDDING_MANIFEST_PATH))
    const problems = validateEmbeddingManifest(manifest)
    if (problems.length > 0) {
      throw new Error(`语义召回已开启，但模型清单不合法：\n  ${problems.join('\n  ')}`)
    }
    sharedEmbeddingManifest = manifest
  }
  return sharedEmbeddingManifest
}

/**
 * M9.5 / WP4 · W1 前置 —— **编码器实例的唯一构造点**（装配层单例，惰性）。
 *
 * ```text
 * 为什么必须只有一处：`createEncoderClient` 会 spawn 一个 worker 子进程，
 * 而惰性 worker 的 RSS ≈ 497.6 MB ⇒ **两个实例 ≈ 双份内存**，不可接受。
 * 而维护（WP4）与语义探针都要用它 ⇒ 必须共用同一个实例。
 * ```
 *
 * ⚠️ **照旧挂 `semanticEncoderForExit`**：不挂的话停机时没人关子进程
 *    ⇒ worker 吊住 event loop ⇒ **进程不退出**（`L-M10-61` 实测 240s 仍在）。
 */
function semanticEncoderShared(options: {
  manifest: Parameters<typeof createEncoderClient>[0]['manifest']
  labModelRoot: string
  deadlineMs: number
  readyTimeoutMs: number
}): EncoderClient {
  if (semanticEncoderForExit === undefined) {
    semanticEncoderForExit = createEncoderClient({
      manifest: options.manifest,
      repoRoot: process.cwd(),
      localModelPath: join(process.cwd(), options.labModelRoot),
      /* 硬截止：超时 ⇒ SIGKILL 子进程（WP3 的 D27），并具名降级成 degraded_lexical */
      deadlineMs: options.deadlineMs,
      /* 冷加载的上限（实测 766 ms；给足余量，但不能无限等） */
      readyTimeoutMs: options.readyTimeoutMs,
    })
  }
  return semanticEncoderForExit
}
async function closeSemanticEncoderForExit(): Promise<void> {
  if (semanticEncoderExitDone) return
  semanticEncoderExitDone = true
  if (process.env.M95_ENCODER_DEBUG === '1') {
    console.error(
      `[m95-exit-debug] 收尾钩子被调用：引用${semanticEncoderForExit === undefined ? '**缺失**（说明这里不是构造点那条路径）' : '在'} ⇒ ${semanticEncoderForExit === undefined ? '不做事' : '将 close()'}`,
    )
  }
  if (semanticEncoderForExit === undefined) return
  try {
    await semanticEncoderForExit.close()
  } catch (error) {
    console.warn(
      `[shutdown] 关闭语义编码器 client 失败（不阻断关库）：` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * INC-01 WP4（`AT4.3`/`AT4.5`）：**本进程的生产打开句柄**。
 *
 * `buildRuntime()`（或 `--migrate`）在打开真实库之前建它；收尾时它的
 * `finish({ closed })` 负责 ⑦ post-close verified snapshot 与 ⑧ 释放租约。
 * 放在模块级的原因与 `runtimeShutdown` 相同：信号路径与最外层 `finally`
 * 都在 `main()` 的词法作用域之外。
 *
 * 它是 `undefined` 的含义是**如实的**："本次进程没有打开真实库"
 * （副本/沙箱/只读命令），因此没有 post-close 快照、也没有租约要放。
 */
let productionOpen: ProductionOpenHandle | undefined

/**
 * 本进程持有的**单认知执行者资格**（WP3 / ADR-132 `D05`）。
 *
 * 计划 §3.2 逐字："同角色首期只有一个认知执行者。PG advisory lock 可用于拒绝第二核心；
 * 读取/备份不争抢该写入资格。"
 *
 * ```text
 *   undefined      ⇒ 本次没有取得资格（PGlite 后端 / 未开库 / 只读命令）—— **如实的**
 *   acquired=true  ⇒ 本进程是唯一认知执行者
 *   acquired=false ⇒ 已具名拒绝（调用方据此拒绝启动）
 * ```
 *
 * 放在模块级的原因与 `runtimeShutdown` / `productionOpen` 相同：
 * 取得发生在 `buildRuntime()` 里，而释放发生在**收尾路径**（`afterRun`）里。
 */
let singleCoreQualification: SingleCoreQualification | undefined

/**
 * 写入资格**丢失**时的有序停机入口。
 *
 * `D05` 逐字："撤销资格后：停止接收新轮次、取消未提交工作、保留已提交事实。"
 * ⇒ 这里接的是**既有的有序停机链**（与 sentinel 同一个 `shutdown()`），
 *   而不是另发明一套"停止接收"的开关 —— 那会变成第二条收尾路径。
 *
 * 它在 `runtimeShutdown` 建好之后才被赋值；在那之前丢失资格只记日志（见下面的回调）。
 */
let stopAfterQualificationLoss: (() => void) | undefined

/**
 * 进程退出前 flush 遥测缓冲。
 *
 * 放在最外层而不是对话循环的 `finally`：`--inspect` / `--reset` 等分支会提前
 * return，`finally` 只管对话那个 try 块。这里注册一次就覆盖所有分支。
 * 它**永远不会**改变退出码——遥测不允许影响业务结果（铁律 12）。
 */
process.once('beforeExit', () => {
  try {
    const config = readTelemetryConfig()
    if (!config.enabled) return
    void createTelemetry(config).shutdown()
  } catch {
    /* 忽略：遥测不允许影响进程退出 */
  }
})

main()
  .catch((err) => {
    logger.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
  /*
   * INC-01 WP3（`AT3.2`）：**最外层 `finally`**。
   *
   * 这里是"把分散的 `runtime.stop()` 收束到外层 try/finally"的落点：
   * 每个分支仍然各自调 `shutdown()`（因此分支自己的输出之前库已经关好），
   * 而这一层保证**无论哪条路径返回/抛出**，进程退出前都走过一次收尾。
   * 句柄幂等 ⇒ 上面那些调用与这一次加起来仍然只有 1 次 stop、1 次 close。
   */
  .finally(async () => {
    /*
     * ⚠️ **先收拢语义慢路径，再走唯一关库链**（与 `AT3.1`/`AT3.2` 同一条纪律）。
     * 这一步是 `L-M10-61` 第二个成因的**真正修法所在**：不关掉编码器 client，
     * 它 spawn 的 worker 会吊住 event loop ⇒ **进程不退出**（机器读数见其声明处）。
     */
    await closeSemanticEncoderForExit()
    const reading = await runtimeShutdown?.shutdown()
    /*
     * 收尾失败必须体现在**最终退出码**上（计划书 §WP3 的判据：
     * "注入 stop 失败：close 仍执行，最终非零"），但**不覆盖**业务已经给出的非零码。
     * 判据本体在 `shutdownExitCode()` 里（单一策略，验收门读同一份）。
     */
    if ((process.exitCode ?? 0) === 0) process.exitCode = shutdownExitCode(reading)
    /*
     * ⚠️ **诊断插桩**（`M95_ENCODER_DEBUG=1` 时才跑）：把**还活着的资源**名字打印出来。
     *
     * 为什么需要它：`L-M10-61` 的第二形态是"**进程不退出**"（回复已产出、停机已开始，
     * 而进程 240s 仍被 SIGKILL）。关掉编码器 client **没有**解决它
     * ⇒ 还有别的活句柄。与其继续猜，不如**让进程自己说**还剩什么。
     * 位置刻意在**最外层 `finally` 的最后**（关库之后）—— 那是"本该已经空了"的时刻。
     */
    if (process.env.M95_ENCODER_DEBUG === '1') {
      const asInfo = process as unknown as { getActiveResourcesInfo?: () => string[] }
      const resources = asInfo.getActiveResourcesInfo?.() ?? []
      console.error(`[m95-exit-debug] 关库后仍存活的资源：${JSON.stringify(resources)}`)
      const asHandles = process as unknown as { _getActiveHandles?: () => unknown[] }
      const handles = asHandles._getActiveHandles?.() ?? []
      const names = handles.map(
        (handle) => (handle as { constructor?: { name?: string } })?.constructor?.name ?? typeof handle,
      )
      console.error(`[m95-exit-debug] 关库后仍存活的句柄：${names.join(', ')}`)
    }
  })
