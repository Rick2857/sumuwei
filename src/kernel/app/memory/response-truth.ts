/**
 * Response Truth Policy —— M4.1 / INV-M41-03。
 *
 * ============================================================================
 *  「系统不能宣称未发生的行为已经发生」
 * ============================================================================
 * 计划书第 55 节的原文是：
 *
 *     不能在 Memory Commit 失败时回答"记住了"。
 *
 * M4 的实现方式是**在上下文里放一条 `droppable: false` 的指令**
 * （`explicit-turn.ts` 的 `translate()` + `sections.ts` 的
 * `createMemoryWriteResultProvider`）。那是对的，但它是**指令** ——
 * 而模型可以不听。
 *
 * 实测：内容抽取失败（`content_unresolved`）时，她回过
 * 「这次是 VS Code。平时主要用。」这种读起来像"已经记下"的话。
 * 用户没有任何办法分辨。
 *
 * 因此这里补一层**确定性的**后置守卫：只要本轮的执行结果是"没写入"，
 * 而回复里出现了**未被否定的成功口吻**，就把回复替换成一句如实表述。
 *
 * ---------------------------------------------------------------------------
 *  为什么必须是确定性守卫（而不是"把 prompt 写得更严厉"）
 * ---------------------------------------------------------------------------
 * C7 是 Hard Gate。一条只在"模型愿意配合"时成立的保证不是保证 ——
 * 那正是这个项目反复记录的那类错误：把"容易测的"当成"真正要守的"。
 *
 * ---------------------------------------------------------------------------
 *  它的代价（如实记录）
 * ---------------------------------------------------------------------------
 * 在这一种情形下，她的回复由**代码**写，而不是由模型写。
 * 换取的是"成功口吻不可能出现在未执行的操作之后"这条**语法级**保证。
 *
 * ---------------------------------------------------------------------------
 *  范围限制（同样是如实的）
 * ---------------------------------------------------------------------------
 * 目前只在 CLI 真实链路（`ChatSession.send()`）上调用。
 * 其它 transport 需要复用**同一个纯函数** —— 因为策略本身在这里，
 * 而不是在装配层。
 */

import type { ExplicitMemoryTurnResult } from './explicit-turn.ts'
import { CLAIM_NEGATIONS, scanClaims } from '../../action/claim-scanner.ts'

/**
 * "成功口吻"标记。
 *
 * 取舍：只收**明确的完成态**表述。刻意**不**收"好"/"知道了"/"行"这类的
 * 泛应声词 —— 它们也可能是对别的意思的回应，收进来会大量误伤。
 * 宁可漏报（那只是回到 prompt 层），也不要误改成她没说过的意思。
 */
export const RESPONSE_SUCCESS_MARKERS: readonly string[] = [
  '记住了',
  '记下了',
  '记好了',
  '已经记住',
  '已经记下',
  '我记着',
  '抹了',
  '删了',
  '删掉',
  '忘掉了',
  '已经忘掉',
  '已经撤',
  '撤了',
  '改好了',
  '已经改',
  '已经更新',
  '更新好了',
  '恢复了',
  '已经恢复',
  '搞定了',
  '弄好了',
  '处理好了',
]

/**
 * 否定词。判定方式：标记出现位置**往前 4 个字符**里若有否定词，
 * 就认为这是一句**如实**的否定表述（"我没记住"），不算违规。
 *
 * 4 个字符是实测选的窗口：要能覆盖"我**没有**记住" / "我**没能**记住"，
 * 又不至于把上一句的否定吸进来。
 *
 * ⚠️ M4.5：扫描实现已抽到 `../action/claim-scanner.ts`（动作守卫共用同一份），
 *    但**词表与函数行为在本文件里保持不变** —— `verify-m4-smoke-live.ts`
 *    直接 import 下面这两个符号，改动会立刻打断 M4.1 的验收证据链。
 */
const NEGATIONS: readonly string[] = CLAIM_NEGATIONS

/** 回复里是否出现了**未被否定的**成功口吻 */
export function replyClaimsSuccess(replyText: string): { claims: boolean; markers: string[] } {
  const scanned = scanClaims(replyText, RESPONSE_SUCCESS_MARKERS, { negationWindow: 4 })
  return { claims: scanned.claims, markers: scanned.markers }
}

export interface ResponseTruthInput {
  /** 本轮显式记忆的执行结果（`undefined` = 这一轮没有显式记忆指令） */
  result: ExplicitMemoryTurnResult | undefined
  /** 模型生成的回复 */
  replyText: string
  /**
   * ★ A2（2026-10-10）：本轮用户原话**是不是在要求她记住/改动记忆**（由
   * `asksToRemember()` 算出的**程序事实**；`undefined` = 调用方还没接这条线）。
   *
   * ⚠️ 三态语义是刻意的，为的是让"接线只做一半"也**安全**：
   *   `undefined` ⇒ **保持既有行为**（旧调用方逐字不变，守卫不会被静默关掉）；
   *   `true`      ⇒ 照旧扫描成功口吻（确实是记忆轮）；
   *   `false`     ⇒ **不替换**：这一轮不归记忆域管，她的措辞不该被整轮顶掉。
   */
  userAskedToRemember?: boolean
}

export interface ResponseTruthOutcome {
  /** 最终要展示（并且被记进账本）的回复 */
  replyText: string
  /** 是否发生了替换 */
  corrected: boolean
  /** 触发替换的成功口吻标记（`corrected === true` 时非空） */
  markers: string[]
  /**
   * 这一轮**真实执行**了什么（C9：执行结果可以被测试直接检查）。
   *
   *   `undefined` —— 这一轮没有显式记忆指令
   *   `true`      —— 真的写入，或之前已经生效过（两者都可以确认）
   *   `false`     —— **没有写入**（不得出现成功口吻）
   */
  executed: boolean | undefined
}

/** 如实表述（按失败原因分） */
function truthfulSentence(result: Extract<ExplicitMemoryTurnResult, { kind: 'not_written' }>): string {
  switch (result.reason) {
    case 'pending_post_turn':
      return '收到，记忆请求会在这轮回复后处理；现在还没有完成。'
    case 'content_unresolved':
      return '我知道你是让我记一件事，可这句话我没能可靠地拆成一条能存下来的记忆，所以这次没有写入。你换个说法再说一次？'
    case 'target_not_found':
      return '我没找到你说的那条记忆，所以什么都没改。'
    case 'target_ambiguous':
      return '我找到不止一条像的，不确定你指的是哪一条，所以什么都没改。你说得再具体一点？'
    case 'persistence_failed':
      return '这次没能写进库里，所以什么都没记下。稍后再试一次？'
    /*
     * M9.1 / ADR-072 D09：dispute 生效但**没有写入**——如实说明「已标存疑、
     * 没有直接改」，不用成功口吻，也不伪装成失败（标记这个动作确实做了）。
     */
    case 'marked_disputed':
      return '这条和已有的说法对不上，我把它标成了存疑，没有直接改。你再说清楚一点，我再更新。'
    /*
     * M9.1 / ADR-072 D08：事件提交了但折叠没生效（同 id 撞上被撤销/被更正的
     * 记录）。如实说「没记上」，不解释内部机制（那是 trace 的事）。
     */
    case 'write_not_effective':
      return '这次的内容和之前撤销过的一条完全一样，我没能把它重新记上。你想让我重新记的话，再说一次？'
    default:
      return '这次的操作没有执行成功，所以什么都没改。'
  }
}

/**
 * 应用 Response Truth Policy。
 *
 * 纯函数：同输入必同输出，不读时间、不读环境、不写任何东西 ——
 * 因此它的判据可以用**离线单测**覆盖（而"模型会不会听话"不能）。
 */
export function applyResponseTruthPolicy(input: ResponseTruthInput): ResponseTruthOutcome {
  const { result, replyText } = input

  if (result === undefined) {
    return { replyText, corrected: false, markers: [], executed: undefined }
  }

  const executed = result.kind !== 'not_written'

  if (executed) {
    return { replyText, corrected: false, markers: [], executed: true }
  }

  // 到这里：本轮**没有写入**。不得出现成功口吻。
  // Pending applies to every turn. Generic action completion (e.g. a scheduled reminder)
  // is checked by its own action guard; only memory completion belongs here.
  /*
   * ★ A2（2026-10-10）：**这一轮不归记忆域管** ⇒ 不替换。
   * 事故：`post_turn_model` 模式下 `pending_post_turn` 是**每一轮**都有的常量
   * （`post-turn-model-memory.ts:47` 逐字："No classification or model call before the reply"），
   * 于是她在回答"什么意思？"时随口一句"我记着"会把**整轮回复**顶成记忆状态模板 = 答非所问。
   * ⚠️ `=== false` 才跳过：`undefined`（调用方没接这条线）走**既有行为**，不静默放宽。
   */
  if (input.userAskedToRemember === false) {
    return { replyText, corrected: false, markers: [], executed: false }
  }
  const claim = result.reason === 'pending_post_turn' && !replyText.includes('记忆')
    ? scanClaims(replyText, ['记住了', '记下了', '记好了', '已经记住', '已经记下', '我记着', '忘掉了', '已经忘掉'], { negationWindow: 4 })
    : replyClaimsSuccess(replyText)
  if (!claim.claims) {
    return { replyText, corrected: false, markers: [], executed: false }
  }

  return {
    replyText: truthfulSentence(result),
    corrected: true,
    markers: claim.markers,
    executed: false,
  }
}
