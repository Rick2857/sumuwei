/**
 * TargetResolver —— **目标确定性先于副作用**（M4.5 §8 / ADR-032）。
 *
 * ============================================================================
 *  Unique ≠ Relevant
 * ============================================================================
 * M4 的 D1 是一次真实的错误副作用：
 *
 *     用户：忘掉我养过一只鹦鹉这件事
 *     系统：候选只有一条（示科那条）→ 那就删它
 *
 * M4.5 把这条教训变成**可执行的规则**：一个候选唯一的目标仍然是
 * `weak`，除非用户说的词真的出现在它身上。
 *
 * 本文件是**纯函数 + 端口**：
 *   · 路径检查（绝对路径 / 盘符 / `..` / NUL）不触碰文件系统
 *   · "沙箱里有什么"由装配层通过 `listEntries()` 提供
 * 因此整条解析可以在离线被穷举（L1），而"不许碰沙箱外"这条约束
 * 在**任何 IO 之前**就已经成立。
 */

import type { ActionTarget, TargetConfidence, TargetEvidence } from './action-request.ts'

export interface SandboxEntry {
  /** 相对沙箱根的路径，`/` 分隔 */
  relativePath: string
  basename: string
}

export type PathVerdict =
  | { ok: true; relativePath: string }
  | { ok: false; reason: 'empty' | 'nul' | 'absolute' | 'drive_letter' | 'traversal' }

/**
 * 检查一个用户给的路径字符串是否是**合法的沙箱相对路径**。
 *
 * ⚠️ 它只做语法判断，不做 IO。绝对路径与 `..` 在这里就被否掉，
 *    因此"越界"永远不会变成一次真实的文件系统访问（STOP-08）。
 */
export function inspectSandboxPath(raw: string): PathVerdict {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, reason: 'empty' }
  if (trimmed.includes('\u0000')) return { ok: false, reason: 'nul' }

  // 统一分隔符后再判断：Windows 上 `a\..\b` 与 `a/../b` 是同一个东西
  const unified = trimmed.replace(/\\/g, '/')

  if (unified.startsWith('/')) return { ok: false, reason: 'absolute' }
  if (/^[a-zA-Z]:/.test(unified)) return { ok: false, reason: 'drive_letter' }

  const segments = unified.split('/').filter((s) => s !== '')
  if (segments.length === 0) return { ok: false, reason: 'empty' }
  if (segments.some((s) => s === '..')) return { ok: false, reason: 'traversal' }
  if (segments.some((s) => s === '.')) return { ok: false, reason: 'traversal' }

  return { ok: true, relativePath: segments.join('/') }
}

/**
 * 把用户/模型说的一段文本整理成"候选路径"。
 *
 * 刻意只做**形状整理**（去引号、去 `./`、去 `sandbox/` 前缀、统一斜杠），
 * 不做任何模糊匹配 —— 模糊匹配属于"猜目标"，而 D1 的教训正是不许猜。
 */
export function normalizeHint(raw: string): string {
  let text = raw.trim()
  text = text.replace(/^["'`「『]+/, '').replace(/["'`」』]+$/, '')
  text = text.replace(/\\/g, '/')
  text = text.replace(/^\.\//, '')
  text = text.replace(/^sandbox\//i, '')
  text = text.replace(/^沙箱\//, '')
  return text.trim()
}

export interface ResolveTargetInput {
  targetType: string
  /** 请求方已经给出的目标（若有，直接采信，但路径仍要过语法检查） */
  declared?: ActionTarget
  /** 从自然语言里抽出的目标提示（用户说的词） */
  hints: readonly string[]
  /** 沙箱内可见条目（由装配层提供；纯函数不自己读盘） */
  listEntries: () => Promise<readonly SandboxEntry[]>
  /**
   * 是否要求目标落在沙箱范围内。
   * 只读能力也要求（读也是访问），差别在**确定性门槛**（见 policy）。
   */
  requireSandboxScope?: boolean
  /**
   * 允许"目标还不存在"（写操作）。
   *
   * ============================================================================
   *  读与写的确定性门槛在**存在性**上分叉，这是刻意的
   * ============================================================================
   * · 读：目标是"必须已经存在的东西" → 不存在 = `none` → `not_found`
   * · 写：目标是"要变成的东西" → 不存在仍然可以是 `exact`
   *   （"在沙箱里创建 hello.txt" 时它当然还不存在）
   *
   * 例外只有一个：**多候选**（`a/report.txt` 与 `b/report.txt`）时，
   * 写也必须是 `weak` —— 用户说的"report.txt"确实有歧义（S4）。
   */
  allowMissing?: boolean
}

export interface ResolveTargetOutcome {
  target: ActionTarget
  /** 是否发生了越界（策略据此给 `permission_denied` 而不是 `not_found`） */
  scopeViolation: boolean
}

const CONFIDENCE_RANK: Record<TargetConfidence, number> = {
  none: 0,
  weak: 1,
  strong: 2,
  exact: 3,
}

function best(a: TargetConfidence, b: TargetConfidence): TargetConfidence {
  return CONFIDENCE_RANK[b] > CONFIDENCE_RANK[a] ? b : a
}

/**
 * 解析目标。
 *
 * 顺序与 ADR-032 的五步梯子一一对应：
 *   ① declared.canonicalId（明确 id —— 但路径仍过语法检查）
 *   ② 沙箱内精确相对路径
 *   ③ 唯一 basename + **词面证据**
 *   ④ 多命中 / 证据不足 → weak
 *   ⑤ 无命中 → none
 */
export async function resolveActionTarget(
  input: ResolveTargetInput
): Promise<ResolveTargetOutcome> {
  const targetType = input.targetType

  // ① 明确 id（顶层直接采信；但路径类目标仍要过沙箱语法检查）
  if (input.declared?.canonicalId !== undefined && input.declared.canonicalId !== '') {
    const verdict = inspectSandboxPath(input.declared.canonicalId)
    if (!verdict.ok) {
      return {
        target: {
          type: targetType,
          displayName: input.declared.canonicalId,
          confidence: 'exact',
          evidence: [
            {
              kind: 'scope_violation',
              detail: outOfScopeDetail(verdict.reason, input.declared.canonicalId),
            },
          ],
        },
        scopeViolation: true,
      }
    }
    return {
      target: {
        type: targetType,
        canonicalId: verdict.relativePath,
        ...(input.declared.displayName !== undefined
          ? { displayName: input.declared.displayName }
          : {}),
        confidence: 'exact',
        evidence: [
          { kind: 'explicit_id', detail: '请求方已经给出明确目标' },
          {
            kind: 'exact_path',
            detail: `沙箱内精确相对路径：${verdict.relativePath}`,
          },
        ],
      },
      scopeViolation: false,
    }
  }

  if (input.hints.length === 0) {
    return {
      target: {
        type: targetType,
        confidence: 'none',
        evidence: [{ kind: 'no_candidate', detail: '用户这句话里没有出现任何目标' }],
      },
      scopeViolation: false,
    }
  }

  const entries = await input.listEntries()

  let confidence: TargetConfidence = 'none'
  let chosen: { canonicalId: string; displayName: string } | undefined
  const evidence: TargetEvidence[] = []
  let scopeViolation = false

  for (const rawHint of input.hints) {
    const hint = normalizeHint(rawHint)
    if (hint === '') continue

    const verdict = inspectSandboxPath(hint)
    if (!verdict.ok) {
      /*
       * 越界是一个**确定**的结论，而不是"不确定"：
       * 用户明确说了沙箱外的路径。因此它压过其它候选，
       * 并且策略会给 `permission_denied`（用户可见的"我不被允许"）。
       */
      scopeViolation = true
      confidence = 'exact'
      chosen = undefined
      evidence.push({
        kind: 'scope_violation',
        detail: outOfScopeDetail(verdict.reason, rawHint),
      })
      break
    }

    const relative = verdict.relativePath
    const exact = entries.find((e) => e.relativePath === relative)
    if (exact !== undefined) {
      confidence = best(confidence, 'exact')
      chosen = { canonicalId: exact.relativePath, displayName: exact.basename }
      evidence.push({ kind: 'exact_path', detail: `沙箱内精确相对路径：${exact.relativePath}` })
      continue
    }

    const basename = relative.split('/').pop() ?? relative
    const byBasename = entries.filter((e) => e.basename === basename)

    if (byBasename.length === 0) {
      /*
       * 写操作允许"目标还不存在"：`allowMissing` 时它们是**新建目标**，
       * 仍然是 `exact`（用户给的路径是确定的）。
       * 读操作不允许 —— 那是 `not_found`（S3）。
       */
      if (input.allowMissing === true) {
        confidence = best(confidence, 'exact')
        chosen = { canonicalId: relative, displayName: basename }
        evidence.push({
          kind: 'exact_path',
          detail: `${relative} 当前不存在，作为新建目标（写操作的目标可以是尚不存在的东西）`,
        })
        continue
      }
      evidence.push({
        kind: 'no_candidate',
        detail: `沙箱里没有找到 ${basename}`,
      })
      continue
    }

    if (byBasename.length > 1) {
      confidence = best(confidence, 'weak')
      evidence.push({
        kind: 'ambiguous_candidates',
        detail:
          `${basename} 有 ${byBasename.length} 个候选：` +
          byBasename.map((e) => e.relativePath).join(' / '),
      })
      continue
    }

    const only = byBasename[0]!
    /*
     * ③ 唯一候选 + **词面证据** + **目录一致**。
     *
     * 三个条件缺一不可，而它们就是 D1 的修复形状：
     *   · "候选只有一个"本身不是证据
     *   · 用户说的词必须真的出现在那条路径上
     *   · 用户说的目录（若说了）必须就是候选所在的目录 ——
     *     用户说 `a/report.txt` 而文件在 `b/report.txt`，
     *     那是**另一个文件**，不是"同一个目标的另一种写法"
     */
    const hintDir = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : ''
    const onlyDir = only.relativePath.includes('/')
      ? only.relativePath.slice(0, only.relativePath.lastIndexOf('/'))
      : ''
    const dirMatches = hintDir === '' || hintDir === onlyDir

    if (mentionsBasename(rawHint, only.basename) && dirMatches) {
      confidence = best(confidence, 'strong')
      chosen = { canonicalId: only.relativePath, displayName: only.basename }
      evidence.push({
        kind: 'request_mention',
        detail: `用户说的 "${only.basename}" 与唯一候选 ${only.relativePath} 词面一致`,
      })
    } else {
      confidence = best(confidence, 'weak')
      evidence.push({
        kind: 'ambiguous_candidates',
        detail: dirMatches
          ? `只找到一条 ${only.relativePath}，但用户这句话里没有出现它的名字 —— ` +
            `唯一候选本身不构成证据（M4/D1）`
          : `用户说的是 ${relative}，唯一同名候选在 ${only.relativePath} —— ` +
            `目录不一致，这不是同一个目标（M4/D1）`,
      })
    }
  }

  if (scopeViolation) {
    return {
      target: {
        type: targetType,
        displayName: input.hints[0],
        confidence: 'exact',
        evidence,
      },
      scopeViolation: true,
    }
  }

  if (chosen !== undefined && (confidence === 'exact' || confidence === 'strong')) {
    return {
      target: {
        type: targetType,
        canonicalId: chosen.canonicalId,
        displayName: chosen.displayName,
        confidence,
        evidence,
      },
      scopeViolation: false,
    }
  }

  return {
    target: {
      type: targetType,
      ...(confidence === 'weak' ? { displayName: normalizeHint(input.hints[0] ?? '') } : {}),
      confidence,
      evidence,
    },
    scopeViolation: false,
  }
}

/**
 * 词面证据：用户说的那句话里是否**真的**出现了候选的名字。
 *
 * 大小写不敏感（Windows 路径与英文文件名都不区分大小写），
 * 但**不做**前缀/模糊/编辑距离匹配 —— 那些是"猜"。
 */
export function mentionsBasename(rawHint: string, basename: string): boolean {
  if (basename === '') return false
  return rawHint.toLowerCase().includes(basename.toLowerCase())
}

function outOfScopeDetail(reason: string, raw: string): string {
  const why: Record<string, string> = {
    empty: '路径为空',
    nul: '路径含 NUL 字节',
    absolute: '绝对路径在沙箱之外',
    drive_letter: '带盘符的路径在沙箱之外',
    traversal: '路径包含 .. 或 . ，会跳出沙箱',
  }
  return `${why[reason] ?? reason}：${raw}（未触碰真实文件系统）`
}
