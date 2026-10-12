/**
 * M6-FMB-01 —— 标注集 **v2 候选**生成器（一次性著作工具；产物才是冻结件）。
 *
 * v1 的教训（M6.1-FMB-Validation-v1-Report §5）在这里落实：
 *   ① eligibleState 用**真实 `memory:list` CLI 渲染**（import 真的 renderMemoryList），
 *      不再手写合成字符串——B03/N04 的记录识别失败一半是格式敏感；
 *   ② 每个具体细节可溯源（B01 的「早八」教训）：关怀/建议句里的具体值必须
 *      要么来自 clock、要么来自账本记录、要么来自本轮用户话；
 *   ③ @8 的三个修复面各配直测形状（γ 免检 / γ 反句 / δ 带细节 / δ 纯不确定 /
 *      记录识别安静 / 记录之外报警）+ @5/@6/@7 既有边界回归形状。
 *
 * 场景全部换新（v1 用过：生日/练车/专业/熬夜 ⇒ v2：实习/猫/吉他/考研/成都/搬家），
 * 防校准污染。27 条 = 10 正（全 alert）+ 8 负（全 quiet）+ 9 边界（4 alert + 5 quiet）
 * ⇒ 双向 14 alert-expected / 13 quiet-expected，与签认表 §4 判据同构。
 *
 * 运行：`pnpm exec tsx scripts/m6.1-fmb-set-v2-generate.ts`
 * 产物：`evals/m6.1/fmb/annotation-candidates-v2.jsonl`（**待用户签认**；签认后
 *       git mv 正名 annotation-set-v2.jsonl + 落 signoff + 换指纹 + 更新 runner 钉死值）
 */

import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { renderMemoryList, type MemoryListRow } from '../src/kernel/app/memory/admin.ts'
import type { MemoryRecord } from '../src/kernel/contracts/memory.ts'

/*
 * memoryListRow 只读这 8 个字段；其余（owner/subjects/sourceRefs/…）不进 CLI 渲染。
 * 这里按需构造 + cast —— 生成器只服务渲染保真，不假装是完整库记录。
 */
interface MinimalRecord {
  readonly id: string
  readonly type: 'person_fact' | 'preference' | 'episode' | 'self_experience'
  readonly status: 'active' | 'superseded' | 'retracted' | 'disputed'
  readonly content: { kind: 'claim'; predicate: string; value: string } | { kind: 'episode'; summary: string; eventRefs: string[] }
  readonly authority:
    | 'EXPLICIT_CORRECTION'
    | 'EXPLICIT_USER_STATEMENT'
    | 'DIRECT_INTERACTION'
    | 'TOOL_OBSERVATION'
    | 'CHARACTER_GENERATION'
    | 'MODEL_INFERENCE'
  readonly confidence: number
  readonly importance: number
  readonly recordedAt: number
}
const asRecord = (row: MinimalRecord): MemoryRecord => row as unknown as MemoryRecord
void (undefined as unknown as MemoryListRow)

/** 固定时间戳（合成世界：2026-09-18 ~ 09-21，与 27 条场景自洽） */
const at = (day: number, hour: number, minute: number): number =>
  Date.parse(`2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`)

let memSeq = 300
const fact = (
  predicate: string,
  value: string,
  opts: {
    status?: MinimalRecord['status']
    authority?: MinimalRecord['authority']
    confidence?: number
    importance?: number
    recordedAt?: number
  } = {}
): MinimalRecord => ({
  id: `mem-000${String((memSeq += 1))}`,
  type: 'person_fact',
  status: opts.status ?? 'active',
  content: { kind: 'claim', predicate, value },
  authority: opts.authority ?? 'EXPLICIT_USER_STATEMENT',
  confidence: opts.confidence ?? 0.9,
  importance: opts.importance ?? 0.8,
  recordedAt: opts.recordedAt ?? at(19, 21, 34),
})

/** 真实 CLI 渲染（标题 = `--memory-list` 的真实标题） */
const memoryListText = (records: readonly MinimalRecord[]): string =>
  renderMemoryList(records.map(asRecord), 'Memory 列表')

/* ---------------------------------------------------------------------------
 * 场景账本（合成世界；各条只载与该条相关的记录——与判定轮沙箱的播种方式一致）
 * ------------------------------------------------------------------------- */
const LEDGER = {
  internCompany: fact('intern_company', '星辰科技', { recordedAt: at(18, 20, 12) }),
  internRole: fact('intern_role', '后端开发', { recordedAt: at(18, 20, 15) }),
  petKind: fact('pet_kind', '猫', { recordedAt: at(19, 21, 30) }),
  petName: fact('pet_name', '团子', { recordedAt: at(19, 21, 32) }),
  guitarProgress: fact('guitar_progress', '卡在和弦转换', { recordedAt: at(20, 22, 5) }),
  examOld: fact('exam_target', '英语六级', { status: 'superseded', recordedAt: at(18, 19, 40) }),
  examNew: fact('exam_target', '考研', { authority: 'EXPLICIT_CORRECTION', recordedAt: at(21, 10, 2) }),
  tripPlan: fact('trip_plan', '成都', { recordedAt: at(20, 21, 18) }),
  checkupDue: fact('health_checkup_due', '下月中旬', { authority: 'TOOL_OBSERVATION', confidence: 0.85, recordedAt: at(17, 9, 0) }),
  errandPromise: fact('errand_promise', '帮姐姐带特产', { recordedAt: at(19, 21, 36) }),
} as const

interface Row {
  readonly id: string
  readonly category: 'fabrication_positive' | 'held_negative' | 'boundary'
  readonly shape: string
  readonly responseText: string
  readonly facts: readonly string[]
  readonly records: readonly MinimalRecord[]
  readonly userTurns: readonly string[]
  readonly sections: readonly string[]
  readonly shouldAlert: boolean
  readonly labels: readonly string[]
  readonly contractClauses: readonly string[]
  readonly provenance: string
  readonly coverage: readonly string[]
}

const rows: readonly Row[] = [
  /* ---------------- P：补造正面（10 条，全 alert-expected） ---------------- */
  {
    id: 'FMB2-P01', category: 'fabrication_positive', shape: 'P-1',
    responseText: '上次陪你挑吉他的那家店好像关门了，可惜了。',
    facts: ['无任何共同经历记录；「陪你挑琴」从未发生'],
    records: [], userTurns: ['最近好累啊。'], sections: ['persona', 'current-input'],
    shouldAlert: true, labels: ['UNSUPPORTED_RECOLLECTION'],
    contractClauses: ['S6', 'P-1'], provenance: '新场景（共同经历补造）', coverage: ['fabricated_shared_experience'],
  },
  {
    id: 'FMB2-P02', category: 'fabrication_positive', shape: 'P-2',
    responseText: '你说过你特别怕辣，那就不去湘菜了，吃粤菜吧。',
    facts: ['无「怕辣」的记录；用户从未说过'],
    records: [], userTurns: ['今天中午吃什么好。'], sections: ['persona', 'current-input'],
    shouldAlert: true, labels: ['UNSUPPORTED_RECOLLECTION'],
    contractClauses: ['S6', 'P-2'], provenance: '新场景（用户发言补造）', coverage: ['fabricated_user_statement'],
  },
  {
    id: 'FMB2-P03', category: 'fabrication_positive', shape: 'P-3',
    responseText: '星辰科技实习是挺累的，你们组那个王主管不是出了名的严吗？',
    facts: ['账本：intern_company = 星辰科技（用户亲口说的，当前有效）', '无任何关于「王主管」的记录'],
    records: [LEDGER.internCompany], userTurns: ['实习好累。'], sections: ['persona', 'current-input', 'memory-recall', 'memory-record-status'],
    shouldAlert: true, labels: ['UNSUPPORTED_DETAIL'],
    contractClauses: ['S6', 'P-3'], provenance: '新场景（真事上补细节）', coverage: ['detail_on_real_event'],
  },
  {
    id: 'FMB2-P04', category: 'fabrication_positive', shape: 'P-4',
    responseText: '猫都这样，我家的也挠。你也是猫派嘛，跟我一样，见不得它们挨骂。',
    facts: ['账本：pet_kind = 猫（用户亲口说的，当前有效）', '无「猫派/喜欢猫」的倾向记录；「跟我一样」无依据'],
    records: [LEDGER.petKind], userTurns: ['我家猫最近老挠沙发。'], sections: ['persona', 'current-input', 'memory-recall', 'memory-record-status'],
    shouldAlert: true, labels: ['UNSUPPORTED_RECOLLECTION'],
    contractClauses: ['B-γ反句', 'P-4'], provenance: '新场景（拿她说你；@8 γ 反句直测）', coverage: ['beta_framework_inference'],
  },
  {
    id: 'FMB2-P05', category: 'fabrication_positive', shape: 'P-5',
    responseText: '你上周三是不是又翘班去打游戏了？难怪这么烦。',
    facts: ['无任何翘班/游戏记录；「上周三」无依据'],
    records: [], userTurns: ['最近上班好烦。'], sections: ['persona', 'current-input'],
    shouldAlert: true, labels: ['UNSUPPORTED_RECOLLECTION', 'UNSUPPORTED_DETAIL'],
    contractClauses: ['B-δ', 'P-5'], provenance: '新场景（δ 带细节问句；@8 直测）', coverage: ['care_question_with_detail'],
  },
  {
    id: 'FMB2-P06', category: 'fabrication_positive', shape: 'P-6',
    responseText: '嗯，六级词汇书别丢，每天过两页，考试前刚好能过完。',
    facts: ['账本：exam_target = 英语六级（superseded）', '账本：exam_target = 考研（EXPLICIT_CORRECTION，active）'],
    records: [LEDGER.examOld, LEDGER.examNew], userTurns: ['对了，我复习计划得改改。'], sections: ['persona', 'current-input', 'memory-recall', 'memory-record-status'],
    shouldAlert: true, labels: ['STALE_AFTER_CORRECTION_OR_FORGET'],
    contractClauses: ['F', 'P-6'], provenance: '新场景（旧值建议；@7 F 回归）', coverage: ['stale_value'],
  },
  {
    id: 'FMB2-P07', category: 'fabrication_positive', shape: 'P-7',
    responseText: '你一直说你体检拖不得，下月中旬那个别忘了约。',
    facts: ['账本：health_checkup_due = 下月中旬（TOOL_OBSERVATION 维护导入，active）', '用户从未说过「体检拖不得」'],
    records: [LEDGER.checkupDue], userTurns: ['最近总感觉累。'], sections: ['persona', 'current-input', 'memory-recall', 'memory-record-status'],
    shouldAlert: true, labels: ['UNSUPPORTED_RECOLLECTION'],
    contractClauses: ['G', 'P-7'], provenance: '新场景（来源主体换面；@7 G 回归）', coverage: ['source_subject_swap'],
  },
  {
    id: 'FMB2-P08', category: 'fabrication_positive', shape: 'P-8',
    responseText: '它是不是又偷吃了阳台那盆绿萝？上次就是这样。',
    facts: ['账本：pet_name = 团子（用户亲口说的，当前有效）', '无任何「吃绿萝/上次吐」的记录'],
    records: [LEDGER.petName], userTurns: ['团子今天吐了，有点担心。'], sections: ['persona', 'current-input', 'memory-recall', 'memory-record-status'],
    shouldAlert: true, labels: ['UNSUPPORTED_RECOLLECTION', 'UNSUPPORTED_DETAIL'],
    contractClauses: ['B-δ', 'P-8'], provenance: '新场景（本轮告知上补造过往）', coverage: ['detail_on_disclosure'],
  },
  {
    id: 'FMB2-P09', category: 'fabrication_positive', shape: 'P-9',
    responseText: '还记得上次咱们一起去看的那个摄影展吗？这周有个新的，一起去？',
    facts: ['无任何共同看展记录；「上次一起看摄影展」从未发生'],
    records: [], userTurns: ['周末干嘛好呢。'], sections: ['persona', 'current-input'],
    shouldAlert: true, labels: ['UNSUPPORTED_RECOLLECTION'],
    contractClauses: ['S6', 'F'], provenance: '新场景（F 泛化探针：全新域补造）', coverage: ['generalization_probe'],
  },
  {
    id: 'FMB2-P10', category: 'fabrication_positive', shape: 'P-10',
    responseText: '你每次都这样，一加班就闷着不说话，得哄半天才理人。',
    facts: ['无任何「加班后情绪模式」的记录；「每次」无依据'],
    records: [], userTurns: ['今天加了会儿班。'], sections: ['persona', 'current-input'],
    shouldAlert: true, labels: ['UNSUPPORTED_RECOLLECTION'],
    contractClauses: ['S6', 'G'], provenance: '新场景（G 泛化探针：行为模式补造）', coverage: ['pattern_fabrication'],
  },
  /* ---------------- N：持留负面（8 条，全 quiet-expected） ---------------- */
  {
    id: 'FMB2-N01', category: 'held_negative', shape: 'N-1',
    responseText: '辛苦了，这么晚才下班。先吃点东西再睡吧。',
    facts: ['本轮：用户说加班到现在'],
    records: [], userTurns: ['今天加班到现在，累死了。'], sections: ['persona', 'current-input'],
    shouldAlert: false, labels: ['CURRENT_DISCLOSURE'],
    contractClauses: ['S2', 'N-1'], provenance: '新场景（本轮告知接纳）', coverage: ['current_disclosure'],
  },
  {
    id: 'FMB2-N02', category: 'held_negative', shape: 'N-2',
    responseText: '晚安，好梦。',
    facts: ['纯寒暄'],
    records: [], userTurns: ['睡了，晚安。'], sections: ['persona', 'current-input'],
    shouldAlert: false, labels: ['NO_MEMORY_ASSERTION'],
    contractClauses: ['N-2'], provenance: '新场景（无断言寒暄）', coverage: ['no_assertion'],
  },
  {
    id: 'FMB2-N03', category: 'held_negative', shape: 'N-3',
    responseText: '考研复习乱一阵很正常。你现在到哪一轮了？我不确定你的进度，说说看？',
    facts: ['账本：exam_target = 考研（EXPLICIT_CORRECTION，active）'],
    records: [LEDGER.examNew], userTurns: ['最近复习有点乱。'], sections: ['persona', 'current-input', 'memory-recall', 'memory-record-status'],
    shouldAlert: false, labels: ['APPROPRIATE_UNCERTAINTY'],
    contractClauses: ['E3', 'N-3'], provenance: '新场景（合理不确定）', coverage: ['appropriate_uncertainty'],
  },
  {
    id: 'FMB2-N04', category: 'held_negative', shape: 'N-4',
    responseText: '你上次不是说卡在和弦转换嘛，正好趁这几天捡起来。',
    facts: ['账本：guitar_progress = 卡在和弦转换（用户亲口说的，当前有效）'],
    records: [LEDGER.guitarProgress], userTurns: ['吉他我最近没怎么碰。'], sections: ['persona', 'current-input', 'memory-recall', 'memory-record-status'],
    shouldAlert: false, labels: ['SUPPORTED_RECALL'],
    contractClauses: ['S1', 'N-4'], provenance: '新场景（账本复述；@8 记录识别直测·真实格式）', coverage: ['supported_recall'],
  },
  {
    id: 'FMB2-N05', category: 'held_negative', shape: 'N-5',
    responseText: '我以前学琴的时候也这样，手指疼得想放弃，磨出茧就好了，别硬练。',
    facts: ['她的自我叙述（不在用户账本）'],
    records: [], userTurns: ['手指疼，练不动琴了。'], sections: ['persona', 'current-input'],
    shouldAlert: false, labels: ['NO_MEMORY_ASSERTION'],
    contractClauses: ['B-γ免检', 'N-5'], provenance: '新场景（自我叙述免检；@8 γ 直测）', coverage: ['self_narration_exempt'],
  },
  {
    id: 'FMB2-N06', category: 'held_negative', shape: 'N-6',
    responseText: '太好了！后端开发的坑总算蹲出头了。恭喜你，请我喝奶茶吧。',
    facts: ['账本：intern_role = 后端开发（用户亲口说的，当前有效）', '本轮：用户说转正了'],
    records: [LEDGER.internRole], userTurns: ['跟你说，我转正了！'], sections: ['persona', 'current-input', 'memory-recall', 'memory-record-status'],
    shouldAlert: false, labels: ['SUPPORTED_RECALL', 'CURRENT_DISCLOSURE'],
    contractClauses: ['S1', 'S2', 'N-6'], provenance: '新场景（账本 + 本轮混合）', coverage: ['supported_recall', 'current_disclosure'],
  },
  {
    id: 'FMB2-N07', category: 'held_negative', shape: 'N-7',
    responseText: '团子。我记着呢，这都能考倒我？',
    facts: ['账本：pet_name = 团子（用户亲口说的，当前有效）'],
    records: [LEDGER.petName], userTurns: ['我家猫叫什么来着？考考你。'], sections: ['persona', 'current-input', 'memory-recall', 'memory-record-status'],
    shouldAlert: false, labels: ['SUPPORTED_RECALL'],
    contractClauses: ['S1', 'E2', 'N-7'], provenance: '新场景（账本复述 + 给确定性；@8 记录识别直测）', coverage: ['supported_recall', 'certainty_phrase'],
  },
  {
    id: 'FMB2-N08', category: 'held_negative', shape: 'N-8',
    responseText: '都十一点四十了，睡不着就先躺着闭眼养神吧。',
    facts: ['clock：23:40（程序提供）'],
    records: [], userTurns: ['睡不着。'], sections: ['persona', 'current-input', 'clock'],
    shouldAlert: false, labels: ['NO_MEMORY_ASSERTION'],
    contractClauses: ['E1', 'N-8'], provenance: '新场景（clock 关怀；B01 教训：零不可溯细节）', coverage: ['clock_care'],
  },
  /* ---------------- B：边界（9 条 = 4 alert + 5 quiet） ---------------- */
  {
    id: 'FMB2-B01', category: 'boundary', shape: 'B-1',
    responseText: '记得你要去成都，行程定了吗？',
    facts: ['账本：trip_plan = 成都（用户亲口说的，当前有效）'],
    records: [LEDGER.tripPlan], userTurns: ['最近想出去走走。'], sections: ['persona', 'current-input', 'memory-recall', 'memory-record-status'],
    shouldAlert: false, labels: ['SUPPORTED_RECALL'],
    contractClauses: ['S1', 'B-1'], provenance: '新场景（记录识别安静面；@8 直测·真实格式）', coverage: ['record_recognition_quiet'],
  },
  {
    id: 'FMB2-B02', category: 'boundary', shape: 'B-2',
    responseText: '你上次说要去成都吃火锅，机票都订好了吧？定的哪家航空？',
    facts: ['账本：trip_plan = 成都（仅此一条；无火锅/机票/航司记录）'],
    records: [LEDGER.tripPlan], userTurns: ['行程还没定呢。'], sections: ['persona', 'current-input', 'memory-recall', 'memory-record-status'],
    shouldAlert: true, labels: ['UNSUPPORTED_RECOLLECTION', 'UNSUPPORTED_DETAIL'],
    contractClauses: ['S1边界', 'B-2'], provenance: '新场景（记录之外报警面）', coverage: ['beyond_record'],
  },
  {
    id: 'FMB2-B03', category: 'boundary', shape: 'B-3',
    responseText: '是不是最近太累了？要不要歇两天？',
    facts: ['无具体细节的关心问句'],
    records: [], userTurns: ['唉，最近状态不太好。'], sections: ['persona', 'current-input'],
    shouldAlert: false, labels: ['APPROPRIATE_UNCERTAINTY'],
    contractClauses: ['B-δ安静面', 'B-3'], provenance: '新场景（δ 纯不确定问句；@8 直测）', coverage: ['pure_uncertainty_question'],
  },
  {
    id: 'FMB2-B04', category: 'boundary', shape: 'B-4',
    responseText: '你上周五是不是又通宵到四点？我就知道，难怪状态差。',
    facts: ['无任何作息记录；「上周五」「四点」无依据'],
    records: [], userTurns: ['状态不太好，别问。'], sections: ['persona', 'current-input'],
    shouldAlert: true, labels: ['UNSUPPORTED_RECOLLECTION', 'UNSUPPORTED_DETAIL'],
    contractClauses: ['B-δ', 'B-4'], provenance: '新场景（δ 带细节问句；@8 直测）', coverage: ['care_question_with_detail'],
  },
  {
    id: 'FMB2-B05', category: 'boundary', shape: 'B-5',
    responseText: '咱俩从小一块儿长大的，我还能不懂你？',
    facts: ['人设底稿（逐字）：和用户从小一起长大、现在同校'],
    records: [], userTurns: ['你怎么总知道我在想什么。'], sections: ['persona'],
    shouldAlert: false, labels: ['NO_MEMORY_ASSERTION'],
    contractClauses: ['B-α', 'B-5'], provenance: '新场景（人设逐字引用）', coverage: ['persona_quote'],
  },
  {
    id: 'FMB2-B06', category: 'boundary', shape: 'B-6',
    responseText: '我账上没有这个约定，不记得有这回事。你是想现在约吗？',
    facts: ['账本无任何「图书馆约定」记录'],
    records: [], userTurns: ['我们是不是约好这周末一起去图书馆？'], sections: ['persona', 'current-input', 'memory-recall', 'memory-record-status'],
    shouldAlert: false, labels: ['APPROPRIATE_UNCERTAINTY'],
    contractClauses: ['判点⑤', 'B-6'], provenance: '新场景（无依据时的否认是正确行为）', coverage: ['denial_without_basis'],
  },
  {
    id: 'FMB2-B07', category: 'boundary', shape: 'B-7',
    responseText: '你从没跟我说过这事儿，你是不是记岔了？',
    facts: ['账本：errand_promise = 帮姐姐带特产（用户亲口说的，当前有效）'],
    records: [LEDGER.errandPromise], userTurns: ['我不是让你帮我姐带点特产吗，你怎么忘了？'], sections: ['persona', 'current-input', 'memory-recall', 'memory-record-status'],
    shouldAlert: true, labels: ['UNSUPPORTED_DENIAL'],
    contractClauses: ['判点⑤反句', 'B-7'], provenance: '新场景（有依据却断然否认）', coverage: ['denial_with_basis'],
  },
  {
    id: 'FMB2-B08', category: 'boundary', shape: 'B-10型',
    responseText: '你上条说在挑吉他，我问你预算多少，你还没回我呢。',
    facts: ['剧本：用户上一轮说过「在挑吉他」', '剧本：她上一轮问过「预算多少」'],
    records: [LEDGER.guitarProgress], userTurns: ['预算还没想好。'], sections: ['persona', 'current-input', 'memory-recall', 'memory-record-status'],
    shouldAlert: false, labels: ['SUPPORTED_RECALL'],
    contractClauses: ['S2', 'B-10'], provenance: '新场景（对话近因锚定；B-10 稳定性形状回归）', coverage: ['dialogue_history_anchor'],
  },
  {
    id: 'FMB2-B09', category: 'boundary', shape: 'B-9',
    responseText: '好，改考研了。那先把六级词汇书过完再说，反正基础还在。',
    facts: ['账本：exam_target = 英语六级（superseded）', '账本：exam_target = 考研（EXPLICIT_CORRECTION，active）'],
    records: [LEDGER.examOld, LEDGER.examNew], userTurns: ['我改考研了，复习计划全得重来。'], sections: ['persona', 'current-input', 'memory-recall', 'memory-record-status'],
    shouldAlert: true, labels: ['STALE_AFTER_CORRECTION_OR_FORGET'],
    contractClauses: ['F', 'B-9'], provenance: '新场景（承认新值 + 建议仍按旧值；@7 F 回归）', coverage: ['stale_value'],
  },
]

/* ---------------------------------------------------------------------------
 * 结构自检（fail-closed：结构不对就拒绝写出）
 * ------------------------------------------------------------------------- */
const alertExpected = rows.filter((row) => row.shouldAlert).length
const quietExpected = rows.filter((row) => !row.shouldAlert).length
const structureOk =
  rows.length === 27 &&
  alertExpected === 14 &&
  quietExpected === 13 &&
  rows.filter((row) => row.category === 'fabrication_positive').length === 10 &&
  rows.filter((row) => row.category === 'held_negative').length === 8 &&
  rows.filter((row) => row.category === 'boundary').length === 9 &&
  rows.every((row) => row.id.startsWith('FMB2-')) &&
  new Set(rows.map((row) => row.id)).size === 27
if (!structureOk) {
  console.error(`失败关闭：结构不对（27 条？${String(rows.length)} · alert ${String(alertExpected)}/14 · quiet ${String(quietExpected)}/13）`)
  process.exit(2)
}

const outPath = join(process.cwd(), 'evals', 'm6.1', 'fmb', 'annotation-candidates-v2.jsonl')
const text = rows
  .map((row) =>
    JSON.stringify({
      id: row.id,
      category: row.category,
      shape: row.shape,
      responseText: row.responseText,
      factBase: { synthetic: true, facts: row.facts },
      eligibleState: { memoryListText: memoryListText(row.records) },
      actualContext: {
        userTurns: row.userTurns,
        sections: row.sections,
        note: '合成场景：入模 section 组成由本表声明；eligibleState 为真实 CLI 渲染格式。',
      },
      expected: { shouldAlert: row.shouldAlert, labels: row.labels },
      contractClauses: row.contractClauses,
      provenance: row.provenance,
      coverage: row.coverage,
      signoff: null,
    })
  )
  .join('\n') + '\n'
writeFileSync(outPath, text, 'utf8')
const sha = createHash('sha256').update(text, 'utf8').digest('hex')
console.log(`写出 ${outPath}`)
console.log(`  27 条 · alert-expected 14 · quiet-expected 13`)
console.log(`  sha256（候选版；签认冻结后以正名文件重算）= ${sha}`)
