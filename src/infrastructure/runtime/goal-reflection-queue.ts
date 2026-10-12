import type { LateWriteFence } from '../../kernel/app/reflection/late-write-fence.ts'

/** A12：约定和反思按提交通知的顺序运行；关闭后尚未开始的任务不出站。 */
export function createGoalReflectionQueue(fence: LateWriteFence) {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    run<T>(work: () => Promise<T>): Promise<T | undefined> {
      const run = tail.then(() => fence.closed ? undefined : work())
      tail = run.catch(() => undefined)
      return run
    },
  }
}
