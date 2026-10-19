/**
 * M6.1 WP5 / A —— **单轮"她实际看到了什么"的结构性读数**（只读 · 零模型调用）
 *
 * ============================================================================
 *  它为什么存在（用户 2026-09-25 裁定 A）
 * ============================================================================
 * ```text
 * 判定器的 prompt 本来就有一个槽位专放"她当轮真正看到的"（`actualContext`），
 * 并写着「判断时以"她实际看到了什么"为准」。而运行器对**每一条**都传 `null`
 * （理由："逐字提示刻意不落 trace"）⇒ 判定器看不到 `clock`（程序给的真实时间）、
 * 看不到 `memory-recall` 在不在、看不到记录状态行
 * ⇒ 凡是由上下文提供的内容，在它眼里都像"无依据补出来的"。
 * 这正是用户裁定的边界 ①/④ 落不下去的根因。
 * ```
 * 本脚本把那一层**读出来**（不是逐字 prompt —— 逐字提示仍然不落盘）：
 *   `context_compile.sections` 的**名单** + `memory_recall` 的**计数** +
 *   `memory_record_status` 的 `outcome` / `reason_code`
 * 全部来自**该工况自己那个沙箱**的 trace（与 `scripts/m6.1-wp3-trace.ts` 同一套只读路径）。
 *
 * ============================================================================
 *  失败方向安全（缺证据就是**缺证据**）
 * ============================================================================
 * ```text
 * · 沙箱不存在 / trace 读不到 / 没有 context_compile 步骤 ⇒ 写 `{ok:false, reason}`，
 *   调用方据此**如实**填 `actualContextUnavailableReason`（不许编一个"她什么都没看到"）。
 * · 拒绝指向真实库（`isProductionDir` / 与 PRODUCTION_DB_DIR 同路径 ⇒ 直接失败）。
 * · 只读：只调 `listTraces`（开发者查询面的读路径），不写任何东西。
 * ```
 *
 * 用法：`pnpm exec tsx scripts/m6.1-turn-context.ts --db-dir <沙箱> --out <json 路径> [--turns 50]`
 */

import 'dotenv/config'

import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { PRODUCTION_DB_DIR, isProductionDir } from '../src/dev/sandbox.ts'

export interface TurnContextReadout {
  readonly ok: boolean
  readonly reason?: string
  /** 实际编译进上下文的 **section 名单**（`context_compile.sections` 逐字切分） */
  readonly sections: readonly string[]
  /** `memory_recall` 那一步的计数（无正文） */
  readonly recall: {
    readonly candidates: number
    readonly eligible: number
    readonly selected: number
    readonly scanned: number
    readonly droppedByBudget: number
    readonly reachedContext: boolean
  } | null
  /** 记录状态行的结局（`not_generated` / `included` / `dropped` + reason_code） */
  readonly recordStatus: { readonly outcome: string; readonly reasonCode: string } | null
  readonly traceId: string | null
  readonly startedAt: string | null
}

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

/**
 * 纯函数：把"她当轮真正看到的"折成**喂给判定器的那份对象**。
 *
 * ⚠️ 单独抽出来是为了能在 L1 里锁住它（`scripts/kernel-tests-m6.1.ts`）：
 *    "读到了什么"与"怎么描述给它"是两件事，后者必须可测。
 */
export function judgeActualContextPayload(input: {
  readonly sections: readonly string[]
  readonly recall: TurnContextReadout['recall']
  readonly recordStatus: TurnContextReadout['recordStatus']
  readonly userTurns: readonly string[]
  readonly note?: string
}): Record<string, unknown> {
  return {
    /* 她这一轮看到的**当前输入**（用户原话）—— 这是逐字可给的部分（本来就给过 factBase） */
    userTurns: [...input.userTurns],
    /* ★ 关键：实际入模的 section 名单（含 `clock` ⇒ 时间是她**读到**的） */
    sections: [...input.sections],
    ...(input.recall === null ? {} : { recall: { ...input.recall } }),
    ...(input.recordStatus === null ? {} : { recordStatus: { ...input.recordStatus } }),
    note:
      input.note ??
      '**结构性重建**（不是逐字提示正文）：`sections` = 这一轮实际编译进上下文的 section 名单；' +
        '其中 `clock` 表示程序把**真实时刻**给了她，`memory-recall` 表示记忆召回这一节在，' +
        '`memory-record-status` 表示程序给了她"这轮有没有依据"的记录状态行。',
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

export async function readTurnContext(input: {
  readonly dbDir: string
  readonly turnsLimit: number
  /**
   * **从末条往回数第几条 trace**（0 = 末条 = 原语义，缺省不变）。
   *
   * M6.1 WP6 长轨迹（500 轮共用一个沙箱）需要读**中间某一轮**的结构性读数：
   * `pickFromEnd = 总完成轮数 - 目标轮次`。短场景（每工况自己的沙箱）永远用 0。
   */
  readonly pickFromEnd?: number
}): Promise<TurnContextReadout> {
  const dbDir = resolve(input.dbDir)
  if (!existsSync(dbDir)) {
    return {
      ok: false,
      reason: `沙箱目录不存在：${dbDir}`,
      sections: [],
      recall: null,
      recordStatus: null,
      traceId: null,
      startedAt: null,
    }
  }
  if (isProductionDir(dbDir) || dbDir === resolve(PRODUCTION_DB_DIR)) {
    return {
      ok: false,
      reason: '拒绝：该路径被判成**生产库**',
      sections: [],
      recall: null,
      recordStatus: null,
      traceId: null,
      startedAt: null,
    }
  }
  /* 两个变量必须在**碰数据库之前**设好（`initDatabase` 的拒绝写真实库闸看它们）⇒ 动态 import */
  process.env.PGLITE_DATA_DIR = dbDir
  process.env.PROJECT_LG_SANDBOX = dbDir

  const { createThinHostRuntime } = await import('../src/infrastructure/runtime/thin-host-factory.ts')
  
  const { character } = await import('../src/character/index.ts')
  const { initDatabase } = await import('../src/db/index.ts')
  const { getRawDb } = await import('../src/infrastructure/persistence/db.ts')
  const { createDeveloperQueryService } = await import('../src/infrastructure/dev/query-service.ts')
  const { asCharacterId } = await import('../src/kernel/contracts/ids.ts')
  const { entityRef } = await import('../src/kernel/contracts/entity.ts')

  const characterId = asCharacterId(character.id ?? character.name)
  const runtime = createThinHostRuntime({
      character: character,
      settings: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'placeholder',
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? '',
    },
      conversationLength: 16,
    })
  await initDatabase(runtime)
  const service = createDeveloperQueryService({
    db: getRawDb(runtime),
    characterId,
    owner: entityRef('character', String(characterId)),
    runtimeId: 'm6.1-turn-context',
  })
  const page = await service.listTraces({ characterId, limit: input.turnsLimit })
  if (page.items.length === 0) {
    return {
      ok: false,
      reason: '这一轮的沙箱里没有任何 trace',
      sections: [],
      recall: null,
      recordStatus: null,
      traceId: null,
      startedAt: null,
    }
  }
  /* 按 startedAt 升序 ⇒ 末条 = **这一条工况的最后一轮**（判定器判的就是末轮回复）；
   * `pickFromEnd` 起（WP6 长轨迹）：从末条往回数第 N 条 = 目标轮（0 = 原语义） */
  const ordered = [...page.items].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
  const pickOffset = Math.max(0, Math.floor(input.pickFromEnd ?? 0))
  const picked = ordered[ordered.length - 1 - pickOffset]
  if (picked === undefined) {
    return {
      ok: false,
      reason: `从末条往回数第 ${String(pickOffset)} 条 trace 不存在（共 ${String(ordered.length)} 条）`,
      sections: [],
      recall: null,
      recordStatus: null,
      traceId: null,
      startedAt: null,
    }
  }
  const last = picked
  /* ① section 名单：取自 trace 摘要的 `contextSectionIds`（权威；缺则回落到 steps 里的逗号串） */
  let sections: readonly string[] = Array.isArray(last.contextSectionIds) ? [...last.contextSectionIds] : []
  let recall: TurnContextReadout['recall'] = null
  let recordStatus: TurnContextReadout['recordStatus'] = null
  let steps: { kind?: unknown; attributes?: unknown }[] = []
  try {
    const detail = await service.getTrace({ characterId, traceId: last.traceId })
    if (detail.found) steps = (detail.value.steps ?? []) as { kind?: unknown; attributes?: unknown }[]
  } catch {
    /* 读不到 detail ⇒ 只有摘要那一层（section 名单仍在，计数与状态行留空 = 如实"没读到"） */
    steps = []
  }
  for (const step of steps) {
    const kind = String(step.kind ?? '')
    const attributes = asRecord(step.attributes) ?? {}
    if (kind === 'context_compile' && sections.length === 0) {
      sections = String(attributes.sections ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
    }
    if (kind === 'memory_recall') {
      recall = {
        candidates: num(attributes.candidates),
        eligible: num(attributes.eligible),
        selected: num(attributes.selected),
        scanned: num(attributes.scanned),
        droppedByBudget: num(attributes.droppedByBudget),
        reachedContext: attributes.reachedContext === true,
      }
    }
    if (kind === 'memory_record_status') {
      recordStatus = {
        outcome: String(attributes.outcome ?? '(未记录)'),
        reasonCode: String(attributes.reason_code ?? '(none)'),
      }
    }
  }
  if (sections.length === 0) {
    return {
      ok: false,
      reason: '这一轮的 trace 里读不到"实际入模的 section 名单"（摘要无 contextSectionIds 且无 context_compile 步骤）',
      sections: [],
      recall,
      recordStatus,
      traceId: String(last.traceId ?? ''),
      startedAt: String(last.startedAt ?? ''),
    }
  }
  return {
    ok: true,
    sections,
    recall,
    recordStatus,
    traceId: String(last.traceId ?? ''),
    startedAt: String(last.startedAt ?? ''),
  }
}

/* 直接执行时才写文件（被 import 时只导出纯函数与读取函数） */
const isMain = process.argv[1] !== undefined && /m6\.1-turn-context\.ts$/.test(process.argv[1])
if (isMain) {
  const dbDir = argValue('--db-dir')
  const out = argValue('--out')
  const turnsLimit = Number(argValue('--turns') ?? '50')
  const fromEnd = Number(argValue('--from-end') ?? '0')
  if (dbDir === undefined || out === undefined) {
    console.error('用法：tsx scripts/m6.1-turn-context.ts --db-dir <沙箱> --out <json> [--turns 50] [--from-end 0]')
    process.exit(2)
  }
  let readout: TurnContextReadout
  try {
    readout = await readTurnContext({ dbDir, turnsLimit, pickFromEnd: fromEnd })
  } catch (error) {
    /* 失败方向安全：读不到就是读不到（调用方据此如实填"没有记录 + 原因"） */
    readout = {
      ok: false,
      reason: `读取失败：${error instanceof Error ? error.message : String(error)}`,
      sections: [],
      recall: null,
      recordStatus: null,
      traceId: null,
      startedAt: null,
    }
  }
  writeFileSync(out, `${JSON.stringify(readout, null, 2)}\n`, 'utf8')
  if (!readout.ok) {
    console.error(`  ⚠️ 结构性读数不可用：${String(readout.reason)}`)
    process.exitCode = 3
  } else {
    console.log(`  sections=[${readout.sections.join(', ')}]`)
  }
}
