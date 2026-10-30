// 只报告实际提交的目标/承诺事实；回复措辞由模型决定。
/** 校验通过的事件类型不代表已经提交；提交失败时 trace 仍保留那些类型。 */
export function commitmentWriteFacts(reality?: {
  readonly acceptedEventTypes: readonly string[]
  readonly eventsCommitted: number
}): { commitmentWritten: boolean; goalCreated: boolean } {
  const written = (reality?.eventsCommitted ?? 0) > 0
  return {
    commitmentWritten: written && (reality?.acceptedEventTypes.includes('COMMITMENT_ACCEPTED') ?? false),
    goalCreated: written && (reality?.acceptedEventTypes.includes('GOAL_CREATED') ?? false),
  }
}
