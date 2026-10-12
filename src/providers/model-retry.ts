/**
 * 模型调用的有界传输重试策略（纯函数，零依赖）
 *
 * 背景（2026-09-25，M6.1 判定轮 `a8fed873e6cf` 批四轮的空回复根因）：
 *   3 条 turns_incomplete 的 stderr 留痕显示两种**外部瞬态**失败形态——
 *   ① `fetch failed`（传输层掉线，2 条：SRP-C-06#2 / SRP-A-01#0）；
 *   ② HTTP 200 + `content:""` + `reasoning_content` 满（推理耗尽预算、
 *      零正文发射，1 条：SRP-B-08#0）。
 *   失败关闭路径（空回复 + 不编造）工作正确，但一轮里 ≥2 条就把
 *   「技术失败 ≤1」门顶破（r2-dep 因此 27→25）。
 *
 * 纪律（为什么只重试这些、不重试别的）：
 *   - 只重试**瞬态**：传输失败 / HTTP 5xx / HTTP 429 / 空回复；
 *   - **不**重试 4xx 鉴权与参数错（HTTP 401/400…）、缺 key、非 JSON、
 *     模型自报 error——那不是瞬态，重试只是掩盖配置错；
 *   - 有界（最多 `MODEL_CALL_MAX_ATTEMPTS` 次尝试）+ 指数退避；
 *   - 耗尽后**原样抛出**——失败仍然失败关闭，不许把重试耗尽
 *     静默成"成功"。
 *
 * 本模块刻意**零 import**：策略与 IO 分离，回归锁可以不加载
 * `@elizaos/core` 直接做行为级正控 / 负控。
 */

/** 最多尝试次数（含首次；3 = 首次 + 2 次重试） */
export const MODEL_CALL_MAX_ATTEMPTS = 3

/** 退避基数（ms）：第 1 次重试等 2000ms，第 2 次等 4000ms */
export const MODEL_CALL_RETRY_BASE_MS = 2000

/** 第 N 次尝试（1 起）失败后的退避时长（ms） */
export function modelCallBackoffMs(attempt: number): number {
  return MODEL_CALL_RETRY_BASE_MS * 2 ** (attempt - 1)
}

/**
 * 判定一条模型调用错误消息是否**瞬态可重试**。
 *
 * 消息形状来自 `openai-compatible.ts` 的抛错文案：
 *   - undici 的 `TypeError: fetch failed`（传输层）；
 *   - `模型调用失败 (HTTP <status> @ …)`；
 *   - `模型返回空回复: <body 前 300 字>`（reasoning-only 完成形态）。
 */
export function isRetriableModelFailure(message: string): boolean {
  if (message.includes('fetch failed')) return true
  if (/HTTP 5\d\d /.test(message)) return true
  if (/HTTP 429 /.test(message)) return true
  if (message.includes('模型返回空回复')) return true
  return false
}
