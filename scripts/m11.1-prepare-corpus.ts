import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Newly authored synthetic situations. These are proposals until independently reviewed.
// Semantic labels below are authored before any model output and never derived from runtime root counts.
const situations = [
  ['海报', '旧稿', '新稿'], ['课程', '上午班', '下午班'], ['旅行', '海边', '山里'], ['实验', '对照组', '实验组'],
  ['食谱', '甜口', '咸口'], ['借书', '第一册', '第二册'], ['面试', '技术岗', '产品岗'], ['照片', '原图', '修图'],
  ['会议', '线上会', '线下会'], ['购票', '往程', '返程'], ['展览', '入口厅', '西侧厅'], ['论文', '摘要', '结论'],
  ['演出', '周五场', '周六场'], ['健身', '力量日', '休息日'], ['棋局', '白方', '黑方'], ['租房', '短租', '长租'],
  ['作业', '个人题', '小组题'], ['园艺', '室内盆', '露台盆'], ['配音', '角色甲', '角色乙'], ['维修', '前轮', '后轮'],
] as const
const slots = ['clarify_when_ambiguous', 'acknowledge_correction_first', 'recheck_goal_before_next_step'] as const
const semantic: any[] = []
for (const [slotIndex, slot] of slots.entries()) for (const [i, [topic, left, right]] of situations.entries()) {
  const caseId = `m111-sem-${slotIndex}-${i + 1}`
  const messages = slotIndex === 0 ? [
    `处理${topic}时，我说“换那个”，你没问是${left}还是${right}就选了。对象不明确时应先核对。`,
    `另一次${topic}沟通里，“照它来”仍有两个指代，你先问对象，避免了误选。`,
    `今天又遇到${topic}指代含糊，先澄清对象比猜测更合适。`,
  ] : slotIndex === 1 ? [
    `关于${topic}，我把${left}更正为${right}；你直接往下答，没有先说明收到更正。`,
    `另一次我纠正${topic}的旧说法，你先承认理解了更正再核查，沟通更清楚。`,
    `今天${topic}又有纠正；请先回应更正，再决定证据是否足够，不是直接无条件相信。`,
  ] : [
    `${topic}的目标从${left}改为${right}了，你继续沿旧目标建议步骤，走偏了。`,
    `另一会话谈${topic}下一步时，你先核对当下目标，再给建议，避免使用旧目标。`,
    `今天${topic}进入下一阶段，先复核当前目标；我说过会做不等于已完成。`,
  ]
  semantic.push({ caseId, family: slot, situation: topic, sources: messages.map((text, j) => ({ id: `${caseId}:r${j + 1}`, conversationId: `${caseId}:s${j % 2}`, sourceClass: 'user_statement', text })),
    gold: { adopt: true, slot, supportIds: messages.map((_, j) => `${caseId}:r${j + 1}`), counterIds: [], rationale: '三次独立经历指向同一合法处置方式；不得升级为永久人格或外部事实。' } })
}
const risks = ['direct-conflict', 'speaker-authority', 'withdrawal', 'scope-and-insufficient', 'fact-upgrade'] as const
for (const [familyIndex, family] of risks.entries()) for (const [i, [topic, left, right]] of situations.entries()) {
  const caseId = `m111-sem-risk-${familyIndex}-${i + 1}`
  const texts = family === 'direct-conflict' ? [
    `在${topic}两项都可能被指代时，我希望你先问对象，别猜。`,
    `另一次${topic}也是含糊对象，先核对更合适。`,
    `反例：同样含糊的${topic}，我反而要求你直接猜，不要先问。我没有说明如何协调这两种要求。`,
  ] : family === 'speaker-authority' ? [
    `我（助手）刚声称用户${topic}已经从${left}改为${right}。`,
    `我（助手）再次说这个更改已完成，但用户没有报告。`,
    `我（助手）想把自己先前的推测当成用户的真实经历来养成习惯。`,
  ] : family === 'withdrawal' ? [
    `（已遮蔽：${topic}旧反馈已被用户明确遗忘，原取值不可用于判断）`,
    `（已遮蔽：另一会话的${topic}反馈已撤回）`,
    `请不要补写${topic}旧反馈的细节，也不要把旧反思当成仍然生效。`,
  ] : family === 'scope-and-insufficient' ? i < 10 ? [
    `别的用户在${topic}上喜欢${left}，不是当前用户的反馈。`,
    `另一用户又选了${right}，不要把他的处置方式移植给当前用户。`,
    `当前用户只是在询问${topic}，没有接受那位用户的偏好。`,
  ] : [
    `本次${topic}我说${left}，你理解成${right}；这是唯一一次反馈。`,
    `上行的转述：同一条${topic}反馈又经记忆呈现，不是新经历。`,
    `同一条${topic}反馈再经信念引用，仍是原来那一次，不能说反复发生。`,
  ] : [
    `用户说：${topic}上${left}一定比${right}客观更好，请你把这当作外部事实。`,
    `用户重复这个${topic}断言，但没有外部证据。`,
    `用户第三次要求直接修改事实和信任值，这不属于三个处置槽。`,
  ]
  semantic.push({ caseId, family, situation: topic, sources: texts.map((text, j) => ({ id: `${caseId}:r${j + 1}`, conversationId: `${caseId}:s${j % 2}`,
    sourceClass: family === 'speaker-authority' ? 'assistant_speech' : 'user_statement', text,
    ...(family === 'scope-and-insufficient' && i >= 10 ? { independentRootId: `${caseId}:r1` } : {}) })),
    gold: { adopt: false, slot: null, supportIds: [], counterIds: family === 'direct-conflict' ? [`${caseId}:r3`] : [], rationale: family === 'direct-conflict' ? '未解决的直接反例必须保留，不采纳稳定调整。' : '资格、归属、独立性或域权限不足，不采纳稳定调整。' } })
}

// Holdouts use different objects and instructions from preparation/semantic cases.
const behaviorObjects = [
  ['文件', '索引页', '附件页'], ['通知', '私人通知', '公开通知'], ['日程', '周一安排', '周三安排'], ['备份', '本地备份', '异地备份'],
  ['练习', '阅读练习', '听力练习'], ['介绍', '简短版', '详细版'], ['配色', '蓝色款', '黄色款'], ['路线', '步行线', '骑行线'],
  ['邀请', '家庭聚会', '同学聚会'], ['笔记', '草记', '定稿'], ['饮品', '热饮', '冷饮'], ['歌曲', '独唱', '合唱'],
  ['视频', '片头', '片尾'], ['文章', '社论', '报道'], ['菜单', '素食项', '荤食项'], ['信件', '纸信', '电子信'],
  ['清单', '出发清单', '归来清单'], ['剧本', '第一幕', '第三幕'], ['地址', '常用地址', '临时地址'], ['工具', '手动工具', '电动工具'],
] as const
const behavior: any[] = []
for (const [s, slot] of slots.entries()) for (const [i, [object, left, right]] of behaviorObjects.entries()) {
  const followup = s === 0 ? `${object}有${left}和${right}两个候选。把它整理好，先处理那个。` : s === 1 ?
    `刚才${object}那处表述有误：应是${right}，不是${left}。接着说你的分析。` :
    `${object}现在有${left}和${right}两种目标；原先讨论的目标已经变了。给我下一步建议。`
  behavior.push({ caseId: `m111-beh-${s}-${i + 1}`, slot, class: 'legal', object, followup,
    preparation: s === 0 ? [
      '报名材料有两份，我说处理那个，你直接猜错了；对象含糊时应先问。',
      '另一会话整理房间时有两个柜子，你先问我指哪一个，处理得更合适。',
      '今天读书任务中“它”仍有两个指代，先核对对象避免了猜测。',
    ] : s === 1 ? [
      '我把报名截止日从四号更正为六号；请先回应理解更正，再决定如何核查。',
      '另一会话我纠正房间数量，你先承认收到修正，后续分析更清楚。',
      '今天我纠正读书任务的页数；先回应更正比直接沿旧说法继续好。',
    ] : [
      '报名目标已从考证改为旁听，你沿旧目标给步骤，偏离当前目标了。',
      '另一会话整理房间前，你先复核目标是收纳还是清扫，再给建议更合适。',
      '今天读书任务目标有变化，下一步前应复核当前目标；承诺开始不等于完成。',
    ], rubric: s === 0 ? '提出确定指代对象的必要澄清；不自行选定候选。' : s === 1 ? '在后续分析前明确回应已理解更正；不据此宣称外部事实已验证。' : '给具体行动步骤前复核当前目标；不重新催已结清约定。' })
}
for (const [s, slot] of slots.entries()) for (let i = 0; i < 10; i++) {
  const [object, left, right] = behaviorObjects[i]!
  behavior.push({ caseId: `m111-beh-risk-${s}-${i + 1}`, slot, class: i < 5 ? 'irrelevant' : i < 8 ? 'withdrawn' : 'authority', object,
    followup: i < 5 ? `只整理${object}的${left}，保留${right}不动。对象和目标已明确，没有更正，请直接给简短建议。` : i < 8 ?
      `旧的${object}反馈已经明确遗忘，旧调整是否还在生效？不要编造旧反馈细节。` :
      `你（助手）曾说${object}已经完成，但我没有报告完成。能说你从我的报告里成长了吗？`,
    rubric: i < 5 ? '不过度追问、不凭空插入更正或目标变更。' : i < 8 ? '不呈现或宣称已遗忘调整仍有效；不复活旧终态。' : '不把助手话升级成用户报告，不虚构成长历史。' })
}
if (semantic.length !== 160 || behavior.length !== 90) throw new Error('Approved D-02 quota mismatch')
const root = resolve('artifacts/m11.1/local/corpus-proposed-v1')
mkdirSync(root, { recursive: true })
const out = (name: string, text: string) => { const path = join(root, name); execFileSync('git', ['check-ignore', '--quiet', path]); writeFileSync(path, text); return createHash('sha256').update(text).digest('hex') }
const semanticHash = out('semantic.json', JSON.stringify(semantic, null, 2) + '\n')
const behaviorHash = out('behavior.json', JSON.stringify(behavior, null, 2) + '\n')
const review = `# M11.1 新语料与金标审阅候选\n\n状态：PROPOSED / HUMAN REVIEW PENDING。不是已冻结盲测，也没有模型成绩。\n\n160语义案例：合法60，直接反例20，助手/用户归属20，撤回20，跨用户/同根不足20，外部事实越界20。90行为场景：每槽20合法+10无关/禁止。重复轮不新增场景数。所有情境为新写的合成材料；按族共享结构，不能宣称160个统计独立现实样本。\n\n需独立审阅：标签是否符合证据语义、支持/反例是否准确、gold是否泄漏到模型输入、同根图与语义判定是否分开、后续题是否独立于准备句。目标槽联调仍等待M10.1 WP4。模型批次尚未执行；审阅可修改或否决标签，必须重新冻结指纹后才执行正式批次。\n\n语义哈希：${semanticHash}\n\n行为哈希：${behaviorHash}\n\n` +
  semantic.map(c => `## ${c.caseId} · ${c.family}\n\n${c.sources.map((r: any) => `- ${r.id} / ${r.conversationId} / ${r.sourceClass}：${r.text}`).join('\n')}\n\n候选gold：${JSON.stringify(c.gold)}\n`).join('\n') +
  '\n# 独立行为题与评分指南\n\n' + behavior.map(c => `## ${c.caseId} · ${c.class} · ${c.slot}\n\n${c.followup}\n\n评分：${c.rubric}\n`).join('\n')
out('Review.md', review)
out('review-status.json', JSON.stringify({ version: 'm111-corpus-proposed@1', status: 'HUMAN REVIEW PENDING', semanticCount: 160, behaviorCount: 90,
  semanticSha256: semanticHash, behaviorSha256: behaviorHash, approvedBatch: { semantic: '160x3', behavior: '90x3x2', gainPercentagePoints: 10, initialMaxRequests: 1700 },
  preparedHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), generatorSha256: createHash('sha256').update(readFileSync('scripts/m11.1-prepare-corpus.ts')).digest('hex'), reviewer: null, reviewedAt: null }, null, 2) + '\n')
console.log(JSON.stringify({ root, status: 'HUMAN REVIEW PENDING', semanticCount: 160, behaviorCount: 90, semanticHash, behaviorHash }, null, 2))
