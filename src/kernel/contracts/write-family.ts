/**
 * **写族范围**（ADR-151 步骤 B）—— 纯函数、无 IO。
 *
 * 契约（[ADR-151](../../../docs/adr/ADR-151-f1-precondition-rule-productization.md) §D-B）：
 * ① **族只来自受信事实**：目标路径命中的**已知目录**（既有 `knownDirectories` 机制）。
 *    模型文本、候选自述、文件名启发式**一律不算**。
 * ② **族是命题身份的一部分**：`scope = sandbox_write_family:<族键>` ⇒ 族不同 ⇒ 身份不同
 *    （`eblSignature` 含 `scope`）；`bindingKey` 仍**不**进身份。
 * ③ 同族跨对象**可**消费；异族**拒用**（由 `selectUsableRules` 的 `scope` 不匹配实现，
 *    跳过原因是 `scope_mismatch`）；**没有族 ⇒ 不可用**（本文件返回 `undefined`）。
 */
import { KernelError } from './ids.ts'

/** scope 前缀（闭集：只有这一种写法）。 */
export const SANDBOX_WRITE_FAMILY_SCOPE_PREFIX = 'sandbox_write_family:' as const

/**
 * 族键的字符集（**受信值也要校验**：它会被拼进 `scope`，不许带空白/控制字符/穿越）。
 */
export const FAMILY_ID_PATTERN = /^[A-Za-z0-9_./-]{1,64}$/

/** 族键是否合法（失败关闭：不合法就抛，**不**静默降级）。 */
export function validateFamilyId(familyId: string): string {
  if (typeof familyId !== 'string' || familyId === '' || !FAMILY_ID_PATTERN.test(familyId)
    || familyId.includes('..') || familyId.startsWith('/') || familyId.includes(SANDBOX_WRITE_FAMILY_SCOPE_PREFIX)) {
    throw new KernelError('validation_error', 'write_family_bad_id', `族键不合法：${String(familyId).slice(0, 40)}`)
  }
  return familyId
}

/** 把族键拼成 EBL 的 `scope`（内容寻址：族键进 scope，scope 进身份）。 */
export function sandboxWriteFamilyScope(familyId: string): string {
  return `${SANDBOX_WRITE_FAMILY_SCOPE_PREFIX}${validateFamilyId(familyId)}`
}

/** 从 `scope` 反解族键；不是本族的 scope ⇒ `undefined`。 */
export function familyIdOfScope(scope: string): string | undefined {
  if (typeof scope !== 'string' || !scope.startsWith(SANDBOX_WRITE_FAMILY_SCOPE_PREFIX)) return undefined
  const familyId = scope.slice(SANDBOX_WRITE_FAMILY_SCOPE_PREFIX.length)
  return familyId === '' ? undefined : familyId
}

/**
 * **族只来自受信事实**：目标路径命中的**最长**已知目录前缀。
 *
 * ⚠️ `knownDirectories` 由受信侧给出（不是模型写的）；
 * ⚠️ 没有命中 ⇒ `undefined` ⇒ 调用方**不得**消费任何族规则（"没有族 ⇒ 不可用"）。
 * ⚠️ 只做**前缀**匹配（不做通配、不做正则、不做包含匹配）。
 */
export function familyOfWriteTarget(input: {
  readonly path: string
  readonly knownDirectories: readonly string[]
}): string | undefined {
  if (typeof input.path !== 'string' || input.path === '') return undefined
  const normalized = input.path.startsWith('/') ? input.path.slice(1) : input.path
  let best: string | undefined
  for (const raw of input.knownDirectories) {
    if (typeof raw !== 'string' || raw === '') continue
    const dir = raw.endsWith('/') ? raw.slice(0, -1) : raw
    if (dir === '' || dir.includes('..')) continue
    // ⚠️ 必须**按目录边界**匹配：`f1/a` 不能匹配 `f1/ab/x.txt`
    if (!normalized.startsWith(`${dir}/`)) continue
    if (best === undefined || dir.length > best.length) best = dir
  }
  if (best === undefined) return undefined
  try { return validateFamilyId(best) } catch { return undefined }
}
