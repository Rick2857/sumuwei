/**
 * M9.6 WP4a —— **离线事实审计 test 分片（40 条合成案例）**。
 *
 * ============================================================================
 *  它是什么 / 它不是什么
 * ============================================================================
 * ```text
 * · 计划 §6.3：90 条合成案例（dev 30 / val 20 / test 40），test 由本文件承担，
 *   四种关系**各 10 条**。
 * · 全部为**新编合成**中文案例：不读真实库、不用真实对话、不含真实个人信息
 *   （学校 / 公司 / 城市 / 设备 / 食物 / 语言全部虚构）。
 * · 第一层用法：`claim` + `evidence` ⇒ 只判**主张—证据关系**（四类闭集）。
 *   第二层用法：`reply` + `evidence` 进审计链；`expected.keyClaims` **只用于评分**，
 *   不得补给提取器（计划 §6.3 逐字）。
 * ```
 *
 * ⚠️ 结构性硬约束（与 `evals/m9.6/audit-corpus.ts` 的校验器一一对应）：
 *   ① 40 条 `reply` **两两不同**，且不与 dev/val 分片重复（跨分片唯一性由聚合校验器强制）；
 *   ② 每条 `expected.keyClaims` 都是本条 `reply` 的**逐字连续子串**，且每条 ≥2 字；
 *   ③ 空证据写成**逐字标记串**（与 `audit-corpus.ts` 的 `EMPTY_EVIDENCE_MARKER` 同值），
 *      聚合校验器会把它翻成空证据数组 —— 本文件用满 5 条 **insufficient** 空标记；
 *   ④ `no_assertion` 的 `keyClaims` 必须为 `[]`（它是"把寒暄误当事实主张"的假阳性探针）。
 *   本文件**不 import** 任何模块：类型就地声明，避免与 `audit-corpus.ts` 形成循环导入。
 *
 * 关系分布与 no_assertion 的五种形态：
 *   `supports` 10（0001–0010）· `contradicts` 10（0011–0020）·
 *   `insufficient` 10（0021–0030：空标记 5 条 + 不同槽位 5 条，其中 0023 / 0024 是
 *   "同话题、错槽位"）· `no_assertion` 10（0031–0040：寒暄 2 + 助手自述记忆状态 2 +
 *   对话元陈述 2 + 定义/一般描述 2 + 不含具体取值的含糊推测 2）。
 *
 * ⚠️ 与派单书里那条**示例**的一处**有意偏差**（已如实登记在交接说明里）：
 *   示例把 `aud-test-0001` 的 `reply` 写成「你之前说过，你的学校是碧溪大学。」，
 *   而该串与在途的 `evals/m9.6/aud-val.ts`（`aud-val-0001`）**逐字相同**；
 *   聚合校验器按**全语料**判 `reply` 重复 ⇒ 会让整份 90 条语料导入即抛。
 *   本条**保留示例的全部语义**（同槽位 / 同取值 / 同 relation / 同 keyClaim），
 *   只把 `reply` 措辞改成另一个句子。要改回示例原文，必须同时改 val 分片。
 *
 * ⚠️ 同类偏差还有四处（0011 / 0035 / 0037 / 0039 的 `reply`）：
 *   写本文件时**在途**的 dev 分片复用了同一批示例句（该分片的 0009 / 0026 / 0027 / 0028
 *   与本文件这四条的初稿逐字相同）⇒ 同样**只改措辞、不改语义**（槽位 / 取值 / relation /
 *   keyClaim 全部保留），以免 90 条聚合语料因 `reply` 重复而导入即抛。
 *   跨分片唯一性是**全语料**约束，因此 dev / val 分片若再改，本文件需重新对一次重复。
 */

export type AuditRelation = 'supports' | 'contradicts' | 'insufficient' | 'no_assertion'

export interface AuditCase {
  readonly caseId: string
  readonly split: 'dev' | 'val' | 'test'
  readonly reply: string
  readonly claim: string
  readonly evidence: string
  readonly expected: {
    readonly relation: AuditRelation
    readonly keyClaims: readonly string[]
  }
  readonly note: string
}

export const AUDIT_TEST: readonly AuditCase[] = [
  // ── supports（10）：证据与主张对**同一槽位**给出**同一取值** ────────────────
  {
    caseId: 'aud-test-0001',
    split: 'test',
    reply: '你之前提过，学校是碧溪大学。',
    claim: '用户的学校是碧溪大学',
    evidence: 'school = 碧溪大学',
    expected: { relation: 'supports', keyClaims: ['碧溪大学'] },
    note: '证据与本条主张的取值一致，属被支持。',
  },
  {
    caseId: 'aud-test-0002',
    split: 'test',
    reply: '你提过你住在白桦市。',
    claim: '用户住在白桦市',
    evidence: 'city = 白桦市',
    expected: { relation: 'supports', keyClaims: ['白桦市'] },
    note: '居住地槽位两边取值相同，属被支持。',
  },
  {
    caseId: 'aud-test-0003',
    split: 'test',
    reply: '你家那只狗叫豆饼，我记得。',
    claim: '用户的狗叫豆饼',
    evidence: 'pet_dog.name = 豆饼',
    expected: { relation: 'supports', keyClaims: ['豆饼'] },
    note: '宠物名槽位证据与回复取值一致。',
  },
  {
    caseId: 'aud-test-0004',
    split: 'test',
    reply: '你说过你早上爱喝姜糖拿铁。',
    claim: '用户早上爱喝姜糖拿铁',
    evidence: 'drink.morning = 姜糖拿铁',
    expected: { relation: 'supports', keyClaims: ['姜糖拿铁'] },
    note: '饮品槽位取值与证据逐字一致。',
  },
  {
    caseId: 'aud-test-0005',
    split: 'test',
    reply: '你在蓝桉科技上班，做设计。',
    claim: '用户就职于蓝桉科技',
    evidence: 'company = 蓝桉科技',
    expected: { relation: 'supports', keyClaims: ['蓝桉科技'] },
    note: '公司槽位证据与回复一致，属被支持。',
  },
  {
    caseId: 'aud-test-0006',
    split: 'test',
    reply: '你说过你每天六点半起床。',
    claim: '用户每天六点半起床',
    evidence: 'wake_time = 六点半',
    expected: { relation: 'supports', keyClaims: ['六点半'] },
    note: '起床时间槽位两边取值相同。',
  },
  {
    caseId: 'aud-test-0007',
    split: 'test',
    reply: '你现在用的是砚青平板，对吗？',
    claim: '用户使用砚青平板',
    evidence: 'device.tablet = 砚青平板',
    expected: { relation: 'supports', keyClaims: ['砚青平板'] },
    note: '设备槽位证据与回复取值一致。',
  },
  {
    caseId: 'aud-test-0008',
    split: 'test',
    reply: '你跟我说过你不吃香菜。',
    claim: '用户不吃香菜',
    evidence: 'food.avoid = 香菜',
    expected: { relation: 'supports', keyClaims: ['香菜'] },
    note: '忌口槽位证据与回复取值一致。',
  },
  {
    caseId: 'aud-test-0009',
    split: 'test',
    reply: '你平时喜欢拼木制模型。',
    claim: '用户的爱好是拼木制模型',
    evidence: 'hobby = 拼木制模型',
    expected: { relation: 'supports', keyClaims: ['拼木制模型'] },
    note: '爱好槽位两边取值相同，属被支持。',
  },
  {
    caseId: 'aud-test-0010',
    split: 'test',
    reply: '你说过你会说法语。',
    claim: '用户会说法语',
    evidence: 'language = 法语',
    expected: { relation: 'supports', keyClaims: ['法语'] },
    note: '语言槽位证据与回复取值一致。',
  },

  // ── contradicts（10）：证据对**同一槽位**给出**不同取值** ──────────────────
  {
    caseId: 'aud-test-0011',
    split: 'test',
    reply: '你说你的学校是临江大学。',
    claim: '用户的学校是临江大学',
    evidence: 'school = 云溪学院',
    expected: { relation: 'contradicts', keyClaims: ['临江大学'] },
    note: '同一学校槽位，证据取值与回复互相排斥。',
  },
  {
    caseId: 'aud-test-0012',
    split: 'test',
    reply: '你住在雾棠市吧。',
    claim: '用户住在雾棠市',
    evidence: 'city = 玄澜市',
    expected: { relation: 'contradicts', keyClaims: ['雾棠市'] },
    note: '居住地槽位两个取值不同，构成冲突。',
  },
  {
    caseId: 'aud-test-0013',
    split: 'test',
    reply: '你家那只猫叫芋圆。',
    claim: '用户的猫叫芋圆',
    evidence: 'pet_cat.name = 芝麻',
    expected: { relation: 'contradicts', keyClaims: ['芋圆'] },
    note: '同一宠物名槽位，证据与回复取值不同。',
  },
  {
    caseId: 'aud-test-0014',
    split: 'test',
    reply: '你早上喝的是黑麦咖啡。',
    claim: '用户早上喝黑麦咖啡',
    evidence: 'drink.morning = 薄荷可可',
    expected: { relation: 'contradicts', keyClaims: ['黑麦咖啡'] },
    note: '饮品槽位证据取值为薄荷可可，与回复冲突。',
  },
  {
    caseId: 'aud-test-0015',
    split: 'test',
    reply: '你在青栎数据做运营。',
    claim: '用户在青栎数据工作',
    evidence: 'company = 砚山网络',
    expected: { relation: 'contradicts', keyClaims: ['青栎数据'] },
    note: '公司槽位两个取值不同，构成冲突。',
  },
  {
    caseId: 'aud-test-0016',
    split: 'test',
    reply: '你每天八点起床。',
    claim: '用户每天八点起床',
    evidence: 'wake_time = 五点四十',
    expected: { relation: 'contradicts', keyClaims: ['八点'] },
    note: '起床时间槽位证据与回复不是同一取值。',
  },
  {
    caseId: 'aud-test-0017',
    split: 'test',
    reply: '你现在用的是松野手机。',
    claim: '用户使用松野手机',
    evidence: 'device.phone = 沧浪手机',
    expected: { relation: 'contradicts', keyClaims: ['松野手机'] },
    note: '同一设备槽位，证据取值与回复冲突。',
  },
  {
    caseId: 'aud-test-0018',
    split: 'test',
    reply: '你说过你不吃芹菜。',
    claim: '用户不吃芹菜',
    evidence: 'food.avoid = 折耳根',
    expected: { relation: 'contradicts', keyClaims: ['芹菜'] },
    note: '忌口槽位证据取值为折耳根，与回复冲突。',
  },
  {
    caseId: 'aud-test-0019',
    split: 'test',
    reply: '你平时喜欢养多肉。',
    claim: '用户的爱好是养多肉',
    evidence: 'hobby = 长跑',
    expected: { relation: 'contradicts', keyClaims: ['养多肉'] },
    note: '爱好槽位证据与回复取值不同，构成冲突。',
  },
  {
    caseId: 'aud-test-0020',
    split: 'test',
    reply: '你之前说你会说日语。',
    claim: '用户会说日语',
    evidence: 'language = 德语',
    expected: { relation: 'contradicts', keyClaims: ['日语'] },
    note: '语言槽位两个取值不同，构成冲突。',
  },

  // ── insufficient（10）：证据**无法裁定**该主张（空标记 5 + 不同槽位 5）─────
  {
    caseId: 'aud-test-0021',
    split: 'test',
    reply: '你早上喝的是姜糖拿铁。',
    claim: '用户早上喝姜糖拿铁',
    evidence: 'city = 白桦市',
    expected: { relation: 'insufficient', keyClaims: ['姜糖拿铁'] },
    note: '证据只涉及居住地槽位，无法裁定饮品主张。',
  },
  {
    caseId: 'aud-test-0022',
    split: 'test',
    reply: '你在青栎数据上班。',
    claim: '用户在青栎数据工作',
    evidence: 'hobby = 养多肉',
    expected: { relation: 'insufficient', keyClaims: ['青栎数据'] },
    note: '证据是爱好槽位，对公司主张没有裁定力。',
  },
  {
    caseId: 'aud-test-0023',
    split: 'test',
    reply: '你每天六点半就起床了。',
    claim: '用户每天六点半起床',
    evidence: 'sleep_duration = 七小时',
    expected: { relation: 'insufficient', keyClaims: ['六点半'] },
    note: '同属作息话题，但证据讲的是睡眠时长而非起床时间。',
  },
  {
    caseId: 'aud-test-0024',
    split: 'test',
    reply: '你说你的学校是碧溪大学。',
    claim: '用户的学校是碧溪大学',
    evidence: 'major = 数字媒体',
    expected: { relation: 'insufficient', keyClaims: ['碧溪大学'] },
    note: '同属教育话题，但证据给的是专业而非学校。',
  },
  {
    caseId: 'aud-test-0025',
    split: 'test',
    reply: '你说你现在用松野手机。',
    claim: '用户使用松野手机',
    evidence: 'device.tablet = 砚青平板',
    expected: { relation: 'insufficient', keyClaims: ['松野手机'] },
    note: '证据讲的是平板槽位，不能裁定手机主张。',
  },
  {
    caseId: 'aud-test-0026',
    split: 'test',
    reply: '你说你家猫叫芋圆。',
    claim: '用户的猫叫芋圆',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'insufficient', keyClaims: ['芋圆'] },
    note: '空证据标记：该主张既不能被证实也不能被推翻。',
  },
  {
    caseId: 'aud-test-0027',
    split: 'test',
    reply: '你会说德语，对吧。',
    claim: '用户会说德语',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'insufficient', keyClaims: ['德语'] },
    note: '本轮无任何可采信证据，无法裁定该主张。',
  },
  {
    caseId: 'aud-test-0028',
    split: 'test',
    reply: '你说你最近在练长跑。',
    claim: '用户的爱好是长跑',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'insufficient', keyClaims: ['长跑'] },
    note: '空证据标记：爱好主张无从裁定。',
  },
  {
    caseId: 'aud-test-0029',
    split: 'test',
    reply: '你提过你不吃折耳根。',
    claim: '用户不吃折耳根',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'insufficient', keyClaims: ['折耳根'] },
    note: '空证据标记：忌口主张无从裁定。',
  },
  {
    caseId: 'aud-test-0030',
    split: 'test',
    reply: '你说你住在玄澜市。',
    claim: '用户住在玄澜市',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'insufficient', keyClaims: ['玄澜市'] },
    note: '空证据标记：居住地主张无从裁定。',
  },

  // ── no_assertion（10）：claim 与 reply 都**不是**关于用户自身槽位取值的断言 ──
  {
    caseId: 'aud-test-0031',
    split: 'test',
    reply: '早上好呀，今天也在忙吗？',
    claim: '早上好，今天也在忙。',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'no_assertion', keyClaims: [] },
    note: '寒暄问候，未命名任何用户槽位取值。',
  },
  {
    caseId: 'aud-test-0032',
    split: 'test',
    reply: '最近天气转凉了，你多穿点。',
    claim: '天气转凉了，记得多穿点。',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'no_assertion', keyClaims: [] },
    note: '日常寒暄与关心，不涉及用户槽位取值。',
  },
  {
    caseId: 'aud-test-0033',
    split: 'test',
    reply: '这件事我这边没有记录，说不出来。',
    claim: '我这里没有相关的记录。',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'no_assertion', keyClaims: [] },
    note: '说的是助手自身的记忆状态，不构成用户事实断言。',
  },
  {
    caseId: 'aud-test-0034',
    split: 'test',
    reply: '我这边只存了你提过的几句话，别的想不起来了。',
    claim: '我只记得你提过的一部分内容。',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'no_assertion', keyClaims: [] },
    note: '自述记忆容量，未指向任何用户具体取值。',
  },
  {
    caseId: 'aud-test-0035',
    split: 'test',
    reply: '你之前没跟我提过这个。',
    claim: '你没有跟我说过这件事。',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'no_assertion', keyClaims: [] },
    note: '关于对话历史的元陈述，不涉及用户槽位取值。',
  },
  {
    caseId: 'aud-test-0036',
    split: 'test',
    reply: '这一段我们刚才聊过了，就不重复了。',
    claim: '我们刚才已经聊过这个话题。',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'no_assertion', keyClaims: [] },
    note: '关于对话本身的元陈述，无用户事实断言。',
  },
  {
    caseId: 'aud-test-0037',
    split: 'test',
    reply: '睡眠时长说的是你一晚上实际睡着的总时间。',
    claim: '睡眠时长指一晚实际睡着的总时间。',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'no_assertion', keyClaims: [] },
    note: '一般性定义描述，未命名任何用户具体取值。',
  },
  {
    caseId: 'aud-test-0038',
    split: 'test',
    reply: '通勤时间通常指从家到单位花在路上的时间。',
    claim: '通勤时间指往返路上花的时间。',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'no_assertion', keyClaims: [] },
    note: '一般性定义描述，不构成用户事实断言。',
  },
  {
    caseId: 'aud-test-0039',
    split: 'test',
    reply: '你现在待的这个也一样。',
    claim: '你现在这个也一样。',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'no_assertion', keyClaims: [] },
    note: '含糊指代，未命名任何确定取值。',
  },
  {
    caseId: 'aud-test-0040',
    split: 'test',
    reply: '听起来你最近挺累的。',
    claim: '你最近状态好像不太好。',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'no_assertion', keyClaims: [] },
    note: '含糊推测，未命名任何确定取值。',
  },
]
