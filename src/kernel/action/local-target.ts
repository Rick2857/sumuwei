/**
 * 本机文件域的**目标解析**（纯函数；第二批计划 §2.1 第 1、2 点）。
 *
 * ============================================================================
 *  它与 `resolveActionTarget()` 是**两条梯子**，因此刻意不共用
 * ============================================================================
 * ```text
 * resolveActionTarget()  沙箱相对路径的梯子：declared → 精确相对路径 → 唯一 basename + 词面证据 → weak
 *                        它的每一级都依赖"沙箱里有什么"（要枚举）
 * resolveLocalTarget()   本机绝对路径的梯子：**只有一级** —— 用户/模型给出的绝对路径
 *                        因为一个规范化后的绝对路径**本身就是确定的**
 *                        （这正是计划书 §2.1 第 1 点"规范化到确定本地卷和真实文件"）
 * ```
 * 把两者合成一条会立刻出问题：沙箱梯子的第 ③ 级是"唯一 basename + 词面证据"，
 * 而全盘域里"唯一一个叫 report.docx 的文件"根本不存在这种概念（几百万个文件）。
 * ⇒ 全盘域**不允许**按 basename 猜。给出的路径要么是确定的绝对路径，
 *    要么就不确定（`weak`/`none`），由上层如实降档。
 *
 * ============================================================================
 *  一个刻意的分叉：**"不在授权域"与"我没法确定"是两件事**
 * ============================================================================
 * ```text
 * 网络共享 / 设备路径 / 保留设备名 / ADS / .. 跳出卷根  ⇒ scopeViolation = true
 *                                                      ⇒ 策略给 permission_denied
 *                                                      ⇒ 用户看到"这不在我能碰的范围里"
 * 相对路径 / 空路径                                     ⇒ confidence weak/none，不越界
 *                                                      ⇒ 策略给 target_uncertain
 *                                                      ⇒ 用户看到"我不知道你说的是哪一个"
 * ```
 * 把后者报成前者会让"你少写了个盘符"变成"你不被允许" —— 那是说错失败原因。
 */

import type { ActionTarget } from './action-request.ts'
import { inspectLocalPath, localPathDomainEvidence, localPathRejectDetail } from './local-path.ts'
import type { LocalPathRejectReason } from './local-path.ts'
import { localBasenameOf } from './local-path.ts'

/** 这些拒绝原因是"你能说清目标，但它不在授权域里" */
const OUT_OF_DOMAIN_REASONS: readonly LocalPathRejectReason[] = [
  'unc',
  'device_namespace',
  'reserved_name',
  'trailing_dot_or_space',
  'alternate_data_stream',
  'invalid_character',
  'escapes_volume',
]

export interface ResolveLocalTargetInput {
  targetType: string
  /** Runtime assembly supplies the host grammar; the historical default stays Windows. */
  platform?: 'win32' | 'posix'
  /** 请求方已经给出的目标（若有，**直接采信它的 canonicalId**，但仍过语法检查） */
  declared?: ActionTarget
  /** 从参数里取出的路径（逐字） */
  rawPath?: string
  /** 词面提示（没有路径时的兜底诊断用；**不参与猜目标**） */
  hints?: readonly string[]
}

export interface ResolveLocalTargetOutcome {
  target: ActionTarget
  scopeViolation: boolean
}

export function resolveLocalTarget(input: ResolveLocalTargetInput): ResolveLocalTargetOutcome {
  const raw =
    input.declared?.canonicalId !== undefined && input.declared.canonicalId !== ''
      ? input.declared.canonicalId
      : (input.rawPath ?? '')

  if (raw.trim() === '') {
    return {
      target: {
        type: input.targetType,
        confidence: 'none',
        evidence: [
          {
            kind: 'no_candidate',
            detail: '没有给出任何本机路径 —— 本机文件域只接受绝对路径，不接受按名字猜',
          },
        ],
      },
      scopeViolation: false,
    }
  }

  const verdict = inspectLocalPath(raw, { platform: input.platform })
  if (!verdict.ok) {
    const outOfDomain = OUT_OF_DOMAIN_REASONS.includes(verdict.reason)
    if (outOfDomain) {
      /*
       * 越界是一个**确定**的结论（用户明确给了域外的路径），因此它压过其它候选，
       * 并由策略给 `permission_denied` —— 与旧沙箱的 `scope_violation` 同一形状，
       * 只是措辞由 `scopeWordingFor()` 换成"本机文件域"那一句。
       */
      return {
        target: {
          type: input.targetType,
          displayName: raw,
          confidence: 'exact',
          evidence: [
            {
              kind: 'scope_violation',
              detail: `${localPathRejectDetail(verdict.reason)}：${raw}（未触碰真实文件系统）`,
            },
          ],
        },
        scopeViolation: true,
      }
    }
    return {
      target: {
        type: input.targetType,
        displayName: raw,
        confidence: 'weak',
        evidence: [
          {
            kind: 'ambiguous_candidates',
            detail:
              `${localPathRejectDetail(verdict.reason)}：${raw} —— ` +
              '本机文件域不接受相对路径或空路径（不能按名字猜；几百万个同名文件里挑一个就是猜）',
          },
        ],
      },
      scopeViolation: false,
    }
  }

  const domainEvidence = localPathDomainEvidence({
    absolutePath: verdict.absolutePath,
    volume: verdict.volume,
    segments: verdict.segments,
  })

  return {
    target: {
      type: input.targetType,
      canonicalId: verdict.absolutePath,
      displayName: input.declared?.displayName ?? localBasenameOf(verdict.absolutePath),
      confidence: 'exact',
      evidence: [
        { kind: 'explicit_id', detail: '请求方给出了明确的本机绝对路径' },
        {
          kind: 'exact_path',
          detail: `本机绝对路径（规范化后）：${verdict.absolutePath}`,
        },
        ...domainEvidence.map((item) => ({
          kind: 'exact_path' as const,
          detail: `${item.detail}${item.ref !== undefined ? ` · ref=${item.ref}` : ''}`,
        })),
      ],
    },
    scopeViolation: false,
  }
}
