/**
 * M9.5 **启用计划 / WP6 第 0 步** —— 把**真编码器**接成 `IndexEncoderPort`。
 *
 * ============================================================================
 *  为什么这是 WP6 的第一步（而不是可选的收尾）
 * ============================================================================
 * ```text
 * WP2-B 的 `buildSemanticIndex()` 依赖的是**注入端口**，而门里注入的是**夹具编码器**
 * ⇒ 到今天为止，**没有任何一次真模型编码**跑过这条写侧路径。
 * 而 WP6（生产副本预演）要预演的恰恰是"真跑一遍" ⇒ 不接真编码器，预演就只是再跑一次夹具。
 * ```
 *
 * ⚠️ **它只做适配**：不选库、不落盘、不决定批次大小 —— 那些都是调用方（预演脚本 / 生产入口）的事。
 * ⚠️ 编码器的**硬截止 / 子进程回收 / 冷启动**语义都在 `EncoderClient` 里（M9.5 已验收），
 *    本文件**不重写**任何一条；失败时如实把 `reason` 传给写侧（写侧会把它记成失败行）。
 */

import type { EncoderClient } from '../semantic/encoder-client.ts'
import type { IndexEncoderPort } from '../persistence/semantic-index-builder.ts'

export function createEncoderIndexPort(
  client: EncoderClient,
  options: { readonly modelFingerprint: string }
): IndexEncoderPort {
  return {
    modelFingerprint: options.modelFingerprint,
    encode: async (texts) => {
      const result = await client.encode(texts)
      if (!result.ok) {
        /* 失败关闭：把具名原因交给写侧（它记失败行、挡水位），**不**返回零向量糊过去 */
        return { ok: false, reason: result.reason }
      }
      return { ok: true, dimension: result.dimension, vectors: result.vectors }
    },
  }
}
