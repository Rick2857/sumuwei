/**
 * Tier 1：`m4.5:ci:full` 的**离线段复用**判定（纯函数）。
 *
 * ============================================================================
 *  为什么单独抽出来
 * ============================================================================
 * 这是一条**会改变"实际跑了什么"的判据**：判错方向会有两种坏结果 ——
 *   · 判成"该复用"但源码其实变了 ⇒ 用旧读数冒充新读数（**假绿**）；
 *   · 判成"不该复用"⇒ 只是慢一点（可接受）。
 * 因此它必须是纯函数，从而能被「正控 / 负控 / 恢复」三段式直接覆盖
 * （`scripts/verify-gate-runner.ts` 的 F 段），而不是藏在回归脚本的 if-else 里。
 *
 * 失败关闭：**只有**四个条件同时成立才复用，其余一律退回冻结形态（完整跑）。
 */

export interface ReuseInput {
  /** 调用方传了 `--no-reuse-offline`。 */
  noReuse: boolean
  /** 上一步 `m4.5:ci` 是否退出码 0。 */
  offlinePassed: boolean
  /** 上一步起跑时采到的源码树摘要（没采到 ⇒ undefined）。 */
  offlineKeyAtRun: string | undefined
  /** 现在这一刻的源码树摘要。 */
  currentKey: string
}

export interface ReuseDecision {
  reuse: boolean
  /** 人读的理由（会进 stdout **和**证据文件）。 */
  reason: string
}

export function decideOfflineReuse(input: ReuseInput): ReuseDecision {
  if (input.noReuse) {
    return { reuse: false, reason: '--no-reuse-offline：按冻结形态完整跑 `m4.5:ci:full`' }
  }
  if (!input.offlinePassed) {
    return { reuse: false, reason: '上一步 `m4.5:ci` 未成功 ⇒ **不**启用复用（按冻结形态完整跑）' }
  }
  if (input.offlineKeyAtRun === undefined) {
    return { reuse: false, reason: '没有采到离线段起跑时的源码树摘要 ⇒ **不**启用复用（失败关闭）' }
  }
  if (input.offlineKeyAtRun !== input.currentKey) {
    return {
      reuse: false,
      reason:
        `源码树摘要在两步之间变了（${input.offlineKeyAtRun.slice(0, 16)}… → ${input.currentKey.slice(0, 16)}…）` +
        ' ⇒ **不**启用复用（按冻结形态完整跑）',
    }
  }
  return {
    reuse: true,
    reason:
      `离线段复用：树摘要与 m4.5-ci 起跑时逐字相同（${input.currentKey.slice(0, 16)}…）` +
      ' ⇒ 本步只跑 `m4.5:smoke:live`（因为 `m4.5:ci:full` 就是 `m4.5:ci && m4.5:smoke:live`）',
  }
}
