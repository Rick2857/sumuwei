/**
 * system.echo —— 最低风险的能力（R0 / sideEffect=none）。
 *
 * ============================================================================
 *  它存在的理由不是"好玩"，而是**让链路本身可测**
 * ============================================================================
 * 真实副作用（写文件）会同时验证"权限 / 目标 / 执行 / 账本"四件事，
 * 当它们一起坏掉时，很难判断是哪一层。echo 把链路与副作用分开：
 *
 *   · 链路坏了（registry / policy / gateway / ledger）→ echo 也坏
 *   · 只有副作用坏了                              → echo 仍然通过
 *
 * 它是 Positive Control 的第一档（§39）。
 */

import type { AdapterExecuteInput, AdapterOutcome, CapabilityAdapter } from '../../../kernel/action/executor-port.ts'
import { stringArg } from '../../../kernel/action/executor-port.ts'
import { SYSTEM_ECHO } from '../../../kernel/action/capability-registry.ts'
import { actionFailure, ActionFailureError } from '../../../kernel/action/errors.ts'
import { contentFingerprint } from './sandbox-filesystem.ts'

export function createEchoAdapter(): CapabilityAdapter {
  return {
    capabilityId: SYSTEM_ECHO,
    async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
      const text = stringArg(input.args, 'text')
      if (text === undefined) {
        throw new ActionFailureError(actionFailure('validation_failed', 'echo 缺少 text 参数'))
      }
      return {
        effect: {
          kind: 'echo',
          detail: text,
          fingerprint: contentFingerprint(text),
          bytes: Buffer.byteLength(text, 'utf8'),
        },
        evidence: [{ kind: 'adapter', detail: 'echo 原样返回' }],
      }
    },
  }
}
