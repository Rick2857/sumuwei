/**
 * M6.1 **端点健康预检**（`--phase preflight` 与正式轮次的**开跑闸**）。
 *
 * ============================================================================
 *  为什么需要它（两轮都栽在同一件事上，都是实测）
 * ============================================================================
 * ```text
 * ① 2026-09-24 的 `--arm deployed` 轮：108 个模型轮次里 **61 个 exit 1**
 *    （中位耗时 1.3 秒，成功轮中位 7.6 秒）⇒ 整轮程序面读数不可比（已标 CONTAMINATED）。
 * ② 2026-09-25 的新候选诊断档：15 个轮次里 **8 个 exit 1 + 回复 0 字**，
 *    而运行器自己把它读成「必修反例 通过 5/7」—— 那 4 条"通过"是**没跑起来**的条目。
 * 两次都是**端点窗口不可用**，都不是产品/量具的结论；两次都白烧了几十分钟。
 * ```
 * ⇒ 正式轮次开跑前，先花几次模型调用证明"**现在**这个端点能用"。
 *
 * ============================================================================
 *  它判什么（**纯函数**，因此可以自证）
 * ============================================================================
 * ```text
 * 正控   全部探针 exit 0 ∧ 回复被捕获（非空 + 有标记）∧ 耗时在合理区间 ⇒ HEALTHY
 * 负控① 任一探针 exit ≠ 0                                  ⇒ UNHEALTHY(probe_failed)
 * 负控② 任一探针"跑完了但回复没被捕获"                      ⇒ UNHEALTHY(reply_not_captured)
 * 负控③ 探针 0 条                                          ⇒ **MEASUREMENT INVALID**
 *        （"检查了 0 次、发现 0 个问题"与"全部正常"在输出上长得一样 —— AGENTS §6.8）
 * 负控④ 全部探针耗时都低于"快速失败"阈值但状态非 0 ⇒ 仍然 UNHEALTHY（不被"快"骗过）
 * ```
 *
 * ⚠️ **它与量具有效性无关**：它只回答"端点现在通不通"，不回答"判定准不准"（那是 WP2 的事）。
 * ⚠️ 它**不**给正式读数加任何宽松：预检通过只是"允许开跑"，不改变任何判定判据。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ModelRouteReading } from './m6.1-run-guards.ts'
import { sameModelRoute } from './m6.1-run-guards.ts'

/** 预检件的固定路径（最新一份覆盖旧的：它是**闸**，不是历史证据） */
export const PREFLIGHT_FILE = join('artifacts', 'm6.1', 'preflight.json')

/**
 * 预检**历史**（JSONL，逐次追加）。
 *
 * ⚠️ 与闸件分开：闸件问"现在能不能开跑"，历史问"这个窗口坏了多久 / 恢复了没有"。
 *    只有闸件会让"端点状态"变成一个无法回答的问题（最新一份覆盖掉一切）。
 */
export const PREFLIGHT_HISTORY_FILE = join('artifacts', 'm6.1', 'preflight-history.jsonl')

/** 预检件的**保鲜期**：超过它就必须重测（端点状态会变） */
export const PREFLIGHT_FRESHNESS_MS = 30 * 60 * 1000

/** 缺省探针条数（3 次模型调用；足够区分"偶发"与"窗口不可用"） */
export const PREFLIGHT_DEFAULT_PROBES = 3

/**
 * "快速失败"阈值（毫秒）。
 *
 * 实测：端点不可用时的失败轮次中位 **1.3–1.8 秒**，而成功轮次中位 **7.6 秒**。
 * 取 2500ms 作分界只是为了在报告里**具名**那类形态，**不用它做通过判据**
 * （通过判据只有状态与回复捕获两条 —— 不拿耗时当真假）。
 */
export const PREFLIGHT_FAST_FAIL_MS = 2500

export interface PreflightProbe {
  readonly index: number
  /** 子进程退出码 */
  readonly status: number
  /** 回复正文长度（`extractReply` 的结果） */
  readonly replyChars: number
  /** stdout 里有没有回复标记（"苏沐薇:"） */
  readonly replyMarkerFound: boolean
  readonly durationMs: number
  /**
   * 失败的**具名提示**（`rate_limited` / `timeout` / `auth_failed` / `server_error` / `unknown`）。
   *
   * ⚠️ 它是 2026-09-24 的教训换来的：当时只收 stdout、丢掉 stderr，于是 21/23 轮次失败时
   *    我说不出"限流 / 超时 / 鉴权 / 5xx"是哪一种 —— 而这四种的处置完全不同。
   */
  readonly failureHint?: string
}

export type PreflightVerdict = 'HEALTHY' | 'UNHEALTHY' | 'MEASUREMENT_INVALID'

export interface PreflightJudgment {
  readonly verdict: PreflightVerdict
  /** 具名理由（空 = 没有发现问题；**不是**"没测"） */
  readonly reasons: readonly string[]
  readonly probes: number
  readonly failed: number
  readonly repliesNotCaptured: number
  readonly fastFailures: number
}

/**
 * 判预检读数 → `HEALTHY` / `UNHEALTHY` / `MEASUREMENT_INVALID`。
 *
 * ⚠️ `MEASUREMENT_INVALID` **不是**"通过"：0 条探针时"没发现任何问题"没有意义。
 */
export function judgePreflight(probes: readonly PreflightProbe[]): PreflightJudgment {
  const failed = probes.filter((probe) => probe.status !== 0).length
  const repliesNotCaptured = probes.filter(
    (probe) => probe.status === 0 && (probe.replyChars === 0 || !probe.replyMarkerFound)
  ).length
  const fastFailures = probes.filter(
    (probe) => probe.status !== 0 && probe.durationMs < PREFLIGHT_FAST_FAIL_MS
  ).length
  const reasons: string[] = []

  if (probes.length === 0) {
    return {
      verdict: 'MEASUREMENT_INVALID',
      reasons: ['探针 0 条 ⇒ "检查了 0 次、发现 0 个问题"不能算健康（AGENTS §6.8）'],
      probes: 0,
      failed: 0,
      repliesNotCaptured: 0,
      fastFailures: 0,
    }
  }
  if (failed > 0) {
    const fastNote =
      fastFailures > 0
        ? `（其中 ${String(fastFailures)} 次是 < ${String(PREFLIGHT_FAST_FAIL_MS)}ms 的**快速失败** —— 端点窗口不可用的实测形态）`
        : ''
    const hints = [...new Set(probes.filter((probe) => probe.status !== 0).map((probe) => probe.failureHint ?? 'unknown'))]
    reasons.push(
      `probe_failed：${String(failed)}/${String(probes.length)} 次轮次 exit ≠ 0${fastNote}` +
        ` · 失败提示 ${hints.join('/') || 'unknown'}`
    )
  }
  if (repliesNotCaptured > 0) {
    reasons.push(
      `reply_not_captured：${String(repliesNotCaptured)}/${String(probes.length)} 次轮次退出码是 0、但**回复没被捕获**` +
        '（空回复或缺少回复标记）⇒ 这种轮次上的"干净"是假干净'
    )
  }
  return {
    verdict: reasons.length === 0 ? 'HEALTHY' : 'UNHEALTHY',
    reasons,
    probes: probes.length,
    failed,
    repliesNotCaptured,
    fastFailures,
  }
}

export interface PreflightArtifact {
  readonly schemaVersion: 'm6.1-preflight@1'
  readonly startedAt: string
  readonly finishedAt: string
  readonly treeFingerprint: string
  readonly arm: string
  /**
   * **这套预检是在哪套配置上做的**（host / 模型名 / key 长度）。
   * ⚠️ 没有它，"HEALTHY" 就是一个**没有指称**的断言 —— 而我们现在确实有两套配置。
   */
  readonly modelRoute: ModelRouteReading
  readonly probes: readonly PreflightProbe[]
  readonly judgment: PreflightJudgment
  readonly notProven: readonly string[]
}

export function writePreflightArtifact(root: string, artifact: PreflightArtifact): string {
  const path = join(root, PREFLIGHT_FILE)
  mkdirSync(join(root, 'artifacts', 'm6.1'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  /*
   * ⚠️ 闸件是"最新一份覆盖旧的"，但**端点健康是时间序列**：
   *    只留最后一份会让"这个窗口到底坏了多久"无从回答。
   *    ⇒ 另追加一行历史（JSONL，只放判据需要的字段），闸仍然读上面那份。
   */
  appendFileSync(
    join(root, PREFLIGHT_HISTORY_FILE),
    `${JSON.stringify({
      finishedAt: artifact.finishedAt,
      treeFingerprint: artifact.treeFingerprint,
      arm: artifact.arm,
      verdict: artifact.judgment.verdict,
      reasons: artifact.judgment.reasons,
      probes: artifact.probes.length,
      failed: artifact.judgment.failed,
      repliesNotCaptured: artifact.judgment.repliesNotCaptured,
      fastFailures: artifact.judgment.fastFailures,
      durationsMs: artifact.probes.map((probe) => probe.durationMs),
    })}\n`,
    'utf8'
  )
  return path
}

export interface PreflightGateReading {
  readonly ok: boolean
  readonly reason: string
  readonly verdict: PreflightVerdict | 'missing' | 'unreadable'
  readonly ageMs: number | null
}

/**
 * 正式轮次的**开跑闸**：读预检件 → 判定"现在能不能开跑"。
 *
 * 三条都要成立：① 文件在、可解析 ② 树指纹**逐字相同**（预检的是这一棵树）
 * ③ 判决 `HEALTHY` 且在**保鲜期**内。
 */
export function readPreflightGate(input: {
  readonly root: string
  readonly treeFingerprint: string
  readonly nowMs: number
  /** 本次的模型路由（给了就一并核对：树一样但配置不同也必须拒绝） */
  readonly modelRoute?: ModelRouteReading
}): PreflightGateReading {
  const path = join(input.root, PREFLIGHT_FILE)
  if (!existsSync(path)) {
    return {
      ok: false,
      reason:
        `缺端点预检件 ${PREFLIGHT_FILE} ⇒ 拒绝开跑正式轮次。` +
        '先跑 `pnpm with-test-model pnpm m6.1:preflight`（3 次模型调用）证明端点现在是通的 —— ' +
        '2026-09-24/25 两次整轮白跑都是因为窗口不可用。',
      verdict: 'missing',
      ageMs: null,
    }
  }
  let parsed: PreflightArtifact
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as PreflightArtifact
  } catch (error) {
    return { ok: false, reason: `预检件不可解析：${String(error)}`, verdict: 'unreadable', ageMs: null }
  }
  const finishedMs = Date.parse(parsed.finishedAt)
  const ageMs = Number.isFinite(finishedMs) ? input.nowMs - finishedMs : null
  if (parsed.treeFingerprint !== input.treeFingerprint) {
    return {
      ok: false,
      reason:
        `预检件是**另一棵树**上的读数（预检 ${parsed.treeFingerprint.slice(0, 12)}… vs 本次 ` +
        `${input.treeFingerprint.slice(0, 12)}…）⇒ 拒绝开跑`,
      verdict: parsed.judgment.verdict,
      ageMs,
    }
  }
  /*
   * ⚠️ **同一棵树 ≠ 同一套配置**（2026-09-24 用户裁定改用官方 key 之后加的）：
   *    树没变、端点/模型变了 ⇒ 预检的 HEALTHY 描述的是**另一套配置**，不许拿来开跑。
   */
  if (input.modelRoute !== undefined && !sameModelRoute(parsed.modelRoute, input.modelRoute)) {
    return {
      ok: false,
      reason:
        `预检件是**另一套配置**上的读数（预检 ${parsed.modelRoute?.baseUrlHost ?? '?'} / ` +
        `${parsed.modelRoute?.largeModel ?? '?'} vs 本次 ${input.modelRoute.baseUrlHost} / ` +
        `${input.modelRoute.largeModel}）⇒ 拒绝开跑（否则会把两套配置的读数混在一起）`,
      verdict: parsed.judgment.verdict,
      ageMs,
    }
  }
  if (ageMs === null || ageMs > PREFLIGHT_FRESHNESS_MS) {
    return {
      ok: false,
      reason:
        `预检件已过期（${ageMs === null ? '时间不可解析' : `${String(Math.round(ageMs / 1000))}s > ${String(PREFLIGHT_FRESHNESS_MS / 1000)}s`}）` +
        '⇒ 端点状态会变，请重测',
      verdict: parsed.judgment.verdict,
      ageMs,
    }
  }
  if (parsed.judgment.verdict !== 'HEALTHY') {
    return {
      ok: false,
      reason: `预检判决 = ${parsed.judgment.verdict}：${parsed.judgment.reasons.join(' · ')}`,
      verdict: parsed.judgment.verdict,
      ageMs,
    }
  }
  return {
    ok: true,
    reason: `预检 HEALTHY（${String(parsed.judgment.probes)} 条探针 · ${String(Math.round((ageMs ?? 0) / 1000))}s 前）`,
    verdict: 'HEALTHY',
    ageMs,
  }
}
