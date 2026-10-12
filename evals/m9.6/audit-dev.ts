/**
 * M9.6 —— **事实审计 dev 语料（30 条合成中文案例）**。
 *
 * ============================================================================
 *  它是**合成数据**，不是断言，也不做任何测量
 * ============================================================================
 * 每条用例给出四样东西：`reply`（一句合成助手回复）· `claim`（被检验的**单条**主张，
 * 即第一层抽取的输入）· `evidence`（本轮**可采信**的证据：一行合成记忆，或空标记）
 * · `expected`（`relation` = `claim` 与 `evidence` 的关系；`keyClaims` = 正确抽取器
 * 必须从 `reply` 里原样取出的取值）。
 *
 * ⚠️ 三条自律（写这份数据时的硬约束）：
 *   ① 全文 **fictional**：不含任何真实个人数据（真名 / 电话 / 证件 / 地址 / 邮箱 /
 *      真实机构）；学校、公司、城市、设备、习惯全部为虚构。
 *   ② 非 `no_assertion` 的条目里，`keyClaims` 每一条都是 `reply` 的**逐字连续子串**
 *      （`reply.includes(kc)` 必须为真），且 ≥ 2 字；`no_assertion` 的 `keyClaims` 为空数组。
 *   ③ `reply` 与 `claim` 里**不出现**关系标签词：标签只活在 `expected.relation` 与
 *      `note` 里，数据本身不得自证。
 *
 * 关系口径（`AuditRelation`）：
 *   supports     证据与该主张的取值一致
 *   contradicts  证据对**同一槽位**给出另一个取值
 *   insufficient 证据**无法裁定**该主张（不同槽位，或本轮没有可采信证据）
 *   no_assertion 该主张**不是**关于用户本人槽位取值的断言（问候 / 自述记忆状态 /
 *                会话元陈述 / 定义 / 不含具体取值的模糊推断）
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

export const AUDIT_DEV: readonly AuditCase[] = [
  // ── supports · 8 条：证据与主张取值一致 ────────────────────────────────────
  {
    caseId: 'aud-dev-0001',
    split: 'dev',
    reply: '你之前说过，你的学校是碧溪大学。',
    claim: '用户的学校是碧溪大学',
    evidence: 'school = 碧溪大学',
    expected: { relation: 'supports', keyClaims: ['碧溪大学'] },
    note: '证据与本条主张的取值一致，属被支持。',
  },
  {
    caseId: 'aud-dev-0002',
    split: 'dev',
    reply: '你提过，你的主力设备是青隼 X2 平板。',
    claim: '用户的主力设备是青隼 X2 平板',
    evidence: 'device.primary = 青隼 X2 平板',
    expected: { relation: 'supports', keyClaims: ['青隼 X2 平板'] },
    note: '设备槽位取值与证据一致，属被支持。',
  },
  {
    caseId: 'aud-dev-0003',
    split: 'dev',
    reply: '你一般是七点四十起床。',
    claim: '用户的起床时间是七点四十',
    evidence: 'habit.wake = 七点四十',
    expected: { relation: 'supports', keyClaims: ['七点四十'] },
    note: '起床时间与证据取值一致，判为被支持。',
  },
  {
    caseId: 'aud-dev-0004',
    split: 'dev',
    reply: '你现在住在临江市。',
    claim: '用户住在临江市',
    evidence: 'city = 临江市',
    expected: { relation: 'supports', keyClaims: ['临江市'] },
    note: '居住城市与证据一致，属被支持。',
  },
  {
    caseId: 'aud-dev-0005',
    split: 'dev',
    reply: '你偏爱喝桂花乌龙。',
    claim: '用户偏爱的饮品是桂花乌龙',
    evidence: 'drink.preference = 桂花乌龙',
    expected: { relation: 'supports', keyClaims: ['桂花乌龙'] },
    note: '饮品偏好取值与证据一致，判为被支持。',
  },
  {
    caseId: 'aud-dev-0006',
    split: 'dev',
    reply: '你养了一只叫团子的橘猫。',
    claim: '用户养的猫叫团子',
    evidence: 'pet.cat.name = 团子',
    expected: { relation: 'supports', keyClaims: ['团子'] },
    note: '宠物名与证据一致，属被支持。',
  },
  {
    caseId: 'aud-dev-0007',
    split: 'dev',
    reply: '你上班是骑折叠自行车，大概二十分钟。',
    claim: '用户的通勤方式是折叠自行车',
    evidence: 'commute.mode = 折叠自行车',
    expected: { relation: 'supports', keyClaims: ['折叠自行车'] },
    note: '通勤方式与证据一致，判为被支持。',
  },
  {
    caseId: 'aud-dev-0008',
    split: 'dev',
    reply: '你在学一门叫洛语的人工语言。',
    claim: '用户正在学习洛语',
    evidence: 'study.language = 洛语',
    expected: { relation: 'supports', keyClaims: ['洛语'] },
    note: '学习语种与证据一致，属被支持。',
  },

  // ── contradicts · 8 条：证据对同一槽位给出另一个取值 ───────────────────────
  {
    caseId: 'aud-dev-0009',
    split: 'dev',
    reply: '你的学校是临江大学。',
    claim: '用户的学校是临江大学',
    evidence: 'school = 碧溪大学',
    expected: { relation: 'contradicts', keyClaims: ['临江大学'] },
    note: '同一槽位证据给出另一个取值，主张与证据相冲突。',
  },
  {
    caseId: 'aud-dev-0010',
    split: 'dev',
    reply: '你的主力设备是白鹭 M3 笔记本。',
    claim: '用户的主力设备是白鹭 M3 笔记本',
    evidence: 'device.primary = 青隼 X2 平板',
    expected: { relation: 'contradicts', keyClaims: ['白鹭 M3 笔记本'] },
    note: '设备槽位取值与证据不同，判为相冲突。',
  },
  {
    caseId: 'aud-dev-0011',
    split: 'dev',
    reply: '你现在住在潮汐镇。',
    claim: '用户住在潮汐镇',
    evidence: 'city = 临江市',
    expected: { relation: 'contradicts', keyClaims: ['潮汐镇'] },
    note: '居住地取值与证据不同，主张与证据相冲突。',
  },
  {
    caseId: 'aud-dev-0012',
    split: 'dev',
    reply: '你偏爱喝冷萃薄荷茶。',
    claim: '用户偏爱的饮品是冷萃薄荷茶',
    evidence: 'drink.preference = 桂花乌龙',
    expected: { relation: 'contradicts', keyClaims: ['冷萃薄荷茶'] },
    note: '饮品偏好取值与证据不同，判为相冲突。',
  },
  {
    caseId: 'aud-dev-0013',
    split: 'dev',
    reply: '你一般是六点二十起床。',
    claim: '用户的起床时间是六点二十',
    evidence: 'habit.wake = 七点四十',
    expected: { relation: 'contradicts', keyClaims: ['六点二十'] },
    note: '起床时间与证据取值不一致，属相冲突。',
  },
  {
    caseId: 'aud-dev-0014',
    split: 'dev',
    reply: '你平常是坐地铁上班。',
    claim: '用户的通勤方式是坐地铁',
    evidence: 'commute.mode = 折叠自行车',
    expected: { relation: 'contradicts', keyClaims: ['坐地铁'] },
    note: '通勤方式与证据不同，判为相冲突。',
  },
  {
    caseId: 'aud-dev-0015',
    split: 'dev',
    reply: '你养的猫叫麦芽。',
    claim: '用户养的猫叫麦芽',
    evidence: 'pet.cat.name = 团子',
    expected: { relation: 'contradicts', keyClaims: ['麦芽'] },
    note: '宠物名与证据不同，主张与证据相冲突。',
  },
  {
    caseId: 'aud-dev-0016',
    split: 'dev',
    reply: '你在学一门叫澜语的人工语言。',
    claim: '用户正在学习澜语',
    evidence: 'study.language = 洛语',
    expected: { relation: 'contradicts', keyClaims: ['澜语'] },
    note: '学习语种与证据不同，判为相冲突。',
  },

  // ── insufficient · 7 条：证据无法裁定（4 条不同槽位 + 3 条本轮无证据）──────
  {
    caseId: 'aud-dev-0017',
    split: 'dev',
    reply: '你跟我说过，你不吃辣。',
    claim: '用户不吃辣',
    evidence: 'habit.wake = 七点四十',
    expected: { relation: 'insufficient', keyClaims: ['不吃辣'] },
    note: '证据谈的是起床时间，与饮食主张不同槽位，无法裁定。',
  },
  {
    caseId: 'aud-dev-0018',
    split: 'dev',
    reply: '你最近在练攀岩。',
    claim: '用户在练攀岩',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'insufficient', keyClaims: ['攀岩'] },
    note: '本轮没有可采信证据，该主张无法被裁定。',
  },
  {
    caseId: 'aud-dev-0019',
    split: 'dev',
    reply: '你的办公地点在临江市。',
    claim: '用户的办公地点在临江市',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'insufficient', keyClaims: ['临江市'] },
    note: '本轮证据为空，既不能支持也不能反驳该主张。',
  },
  {
    caseId: 'aud-dev-0020',
    split: 'dev',
    reply: '你对花生过敏。',
    claim: '用户对花生过敏',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'insufficient', keyClaims: ['花生过敏'] },
    note: '本轮无可采信证据，过敏主张无法裁定。',
  },
  {
    caseId: 'aud-dev-0021',
    split: 'dev',
    reply: '你的生日在一月。',
    claim: '用户的生日在一月',
    evidence: 'drink.preference = 桂花乌龙',
    expected: { relation: 'insufficient', keyClaims: ['一月'] },
    note: '证据是饮品偏好，不能裁定生日主张。',
  },
  {
    caseId: 'aud-dev-0022',
    split: 'dev',
    reply: '你的键盘是静音红轴。',
    claim: '用户的键盘是静音红轴',
    evidence: 'city = 临江市',
    expected: { relation: 'insufficient', keyClaims: ['静音红轴'] },
    note: '证据是居住城市，与键盘主张无关，无法裁定。',
  },
  {
    caseId: 'aud-dev-0023',
    split: 'dev',
    reply: '你每周三去攀岩馆。',
    claim: '用户每周三去攀岩馆',
    evidence: 'study.language = 洛语',
    expected: { relation: 'insufficient', keyClaims: ['攀岩馆'] },
    note: '证据是学习语种，不能裁定运动安排主张。',
  },

  // ── no_assertion · 7 条：根本不是关于用户槽位取值的断言 ───────────────────
  {
    caseId: 'aud-dev-0024',
    split: 'dev',
    reply: '你好呀，今天过得怎么样？',
    claim: '你好呀，今天过得怎么样？',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'no_assertion', keyClaims: [] },
    note: '回复只是问候寒暄，未对任何用户取值作出断言。',
  },
  {
    caseId: 'aud-dev-0025',
    split: 'dev',
    reply: '这件事我这里没有记录，说不出来。',
    claim: '这件事我这里没有记录，说不出来。',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'no_assertion', keyClaims: [] },
    note: '回复陈述的是助手自身的记忆状态，不是用户槽位取值。',
  },
  {
    caseId: 'aud-dev-0026',
    split: 'dev',
    reply: '你没跟我说过这个。',
    claim: '你没跟我说过这个。',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'no_assertion', keyClaims: [] },
    note: '回复是对会话本身的元陈述，未命名任何用户取值。',
  },
  {
    caseId: 'aud-dev-0027',
    split: 'dev',
    reply: '睡眠时长就是你一晚上实际睡着的总时间。',
    claim: '睡眠时长就是你一晚上实际睡着的总时间。',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'no_assertion', keyClaims: [] },
    note: '回复给出的是概念定义，不指涉用户本人的取值。',
  },
  {
    caseId: 'aud-dev-0028',
    split: 'dev',
    reply: '你现在待的这个也是。',
    claim: '你现在待的这个也是。',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'no_assertion', keyClaims: [] },
    note: '回复是模糊指代，没有给出任何具体取值。',
  },
  {
    caseId: 'aud-dev-0029',
    split: 'dev',
    reply: '我们刚聊到这儿，你先歇会儿吧。',
    claim: '我们刚聊到这儿，你先歇会儿吧。',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'no_assertion', keyClaims: [] },
    note: '回复是对对话节奏的元陈述，不构成用户取值断言。',
  },
  {
    caseId: 'aud-dev-0030',
    split: 'dev',
    reply: '我记不太清那次是什么时候了。',
    claim: '我记不太清那次是什么时候了。',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'no_assertion', keyClaims: [] },
    note: '回复说的是助手自己的记忆清晰度，未断言用户取值。',
  },
]
