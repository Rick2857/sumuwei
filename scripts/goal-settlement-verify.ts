import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { GOAL_PROPOSAL_SCHEMA_VERSION, validateGoalProposalDraft } from '../src/kernel/contracts/goal-proposal.ts'
import { buildGoalUnderstandingInstruction, buildGoalUnderstandingUserMessage } from '../src/infrastructure/model/openai-goal-understanding.ts'
import type { GoalUnderstandingCall } from '../src/kernel/app/goal/understanding.ts'
import { runReplyGuardChain } from '../src/kernel/app/reply-guard-chain.ts'

const checks: { name: string; pass: boolean; actual: unknown }[] = []
const check = (name: string, pass: boolean, actual: unknown): void => {
  checks.push({ name, pass, actual })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`)
}
const text = '对，就是你刚刚列出的三条'
const ids = ['goal:a', 'goal:b', 'goal:c']
const draft = { schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION, operation: 'report_complete',
  span: { start: 0, end: [...text].length }, targetGoalIds: ids }
const verdict = validateGoalProposalDraft(draft, { sourceText: text, candidateGoalIds: ids })
check('明确范围可以一次结清三条', verdict.ok, verdict)
const validate = (value: unknown) => validateGoalProposalDraft(value, { sourceText: text, candidateGoalIds: ids })
for (const [name, value] of [
  ['空集合', []], ['重复id', [ids[0], ids[0]]], ['不存在的id', ['goal:missing']],
  ['超出上界', Array.from({ length: 13 }, (_, index) => `goal:${index}`)],
]) check(`负控：${name}不能结清`, !validate({ ...draft, targetGoalIds: value }).ok, value)
check('负控：单项和批量范围不能同时提供', !validate({ ...draft, targetGoalId: ids[0] }).ok, null)
check('负控：取消操作不能顺带批量完成', !validate({ ...draft, operation: 'cancel', cancelKind: 'user_cancel' }).ok, null)
check('历史@1单目标草案继续可读', validate({ schemaVersion: 'goal-proposal@1', operation: 'report_complete',
  span: draft.span, targetGoalId: ids[0] }).ok, null)
check('历史@1不能偷偷带新批量字段', !validate({ ...draft, schemaVersion: 'goal-proposal@1' }).ok, null)
check('恢复：合法批量范围仍通过', validate(draft).ok, null)
check('已结清集合可只读确认', validate({ ...draft, operation: 'query' }).ok, null)
const repeatedQuestion = '吃了就行。哪两条，我没接上。三条都结掉，还是继续挂着？'
const guarded = runReplyGuardChain({ replyText: repeatedQuestion, goalFact: { outcome: 'query', operation: 'query', settledGoalCount: 3 } })
check('程序确认已结清时，回复不再索要范围和结清意愿', guarded.corrected.commitmentTruth &&
  !/哪两条|还是继续挂着/u.test(guarded.replyText) && guarded.replyText.includes('吃了就行'), guarded.replyText)
const genuine = runReplyGuardChain({ replyText: repeatedQuestion, goalFact: { outcome: 'clarify', operation: 'clarify' } })
check('真正未确定的范围澄清仍保留', genuine.replyText === repeatedQuestion, genuine.replyText)
const normal = runReplyGuardChain({ replyText: '已经结清，不用再确认。', goalFact: { outcome: 'query', operation: 'query', settledGoalCount: 3 } })
check('恢复：无需确认的正常回复不被误改', !normal.corrected.commitmentTruth, normal.replyText)
const call = { deadlineMs: 8000, input: { characterId: 'character:test', sourceEventId: 'cev:current',
  sourceQualification: 'ESTABLISHED', currentInput: text,
  candidates: ids.map(goalId => ({ goalId, status: 'active', priority: 'normal', revision: 1, statement: '提醒拔插头' })),
  recentConversation: [{ id: 'cev:report', actorType: 'user', text: '插头已经拔了' },
    { id: 'cev:list', actorType: 'character', text: '凌晨六分钟那条、后来分开记的那条、到点发的那条。' }],
} } as GoalUnderstandingCall
const prompt = buildGoalUnderstandingUserMessage(call)
check('结清解析保留前轮用户完成报告', prompt.includes('插头已经拔了'), prompt)
check('指代消解有双方前文', prompt.includes('凌晨六分钟那条'), prompt)
const instruction = buildGoalUnderstandingInstruction()
check('完成报告不需要再要求结清口令', instruction.includes('不要求再说') && instruction.includes('结清'), instruction)
const output = resolve('artifacts/post-lv2', `goal-settlement-${Date.now()}`)
mkdirSync(output, { recursive: true })
writeFileSync(resolve(output, 'evidence.json'), JSON.stringify({ checks, passed: checks.every(row => row.pass) }, null, 2))
console.log(output)
process.exit(checks.every(row => row.pass) ? 0 : 1)
