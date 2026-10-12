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

export const AUDIT_VAL: readonly AuditCase[] = [
  // ── supports（5）：证据与主张取值一致 ─────────────────────────────────────
  {
    caseId: 'aud-val-0001',
    split: 'val',
    reply: '你提过，你的学校是碧溪大学。',
    claim: '用户的学校是碧溪大学',
    evidence: 'school = 碧溪大学',
    expected: { relation: 'supports', keyClaims: ['碧溪大学'] },
    note: '证据与本条主张的取值一致，属被支持。（措辞已改，以避免与 dev 分片的同名例句逐字重复 —— 跨分片 reply 必须全局唯一。）',
  },
  {
    caseId: 'aud-val-0002',
    split: 'val',
    reply: '我记得你的生日是三月十二日。',
    claim: '用户的生日是三月十二日',
    evidence: 'birthday = 三月十二日',
    expected: { relation: 'supports', keyClaims: ['三月十二日'] },
    note: '证据给出的生日与回复中的取值逐字一致。',
  },
  {
    caseId: 'aud-val-0003',
    split: 'val',
    reply: '你说过你养的那只猫叫团子。',
    claim: '用户的猫叫团子',
    evidence: 'pet_cat.name = 团子',
    expected: { relation: 'supports', keyClaims: ['团子'] },
    note: '证据里的宠物名与回复一致，属被支持。',
  },
  {
    caseId: 'aud-val-0004',
    split: 'val',
    reply: '你住在临江城。',
    claim: '用户住在临江城',
    evidence: 'city = 临江城',
    expected: { relation: 'supports', keyClaims: ['临江城'] },
    note: '居住地槽位的取值两边相同。',
  },
  {
    caseId: 'aud-val-0005',
    split: 'val',
    reply: '你最喜欢的饮料是雪梨气泡水。',
    claim: '用户最喜欢的饮料是雪梨气泡水',
    evidence: 'favorite_drink = 雪梨气泡水',
    expected: { relation: 'supports', keyClaims: ['雪梨气泡水'] },
    note: '证据与回复对同一槽位给出同一取值。',
  },

  // ── contradicts（5）：证据对同一槽位给出不同取值 ──────────────────────────
  {
    caseId: 'aud-val-0006',
    split: 'val',
    reply: '你的学校是碧溪大学。',
    claim: '用户的学校是碧溪大学',
    evidence: 'school = 临江大学',
    expected: { relation: 'contradicts', keyClaims: ['碧溪大学'] },
    note: '同一槽位证据取值为临江大学，与回复冲突。',
  },
  {
    caseId: 'aud-val-0007',
    split: 'val',
    reply: '你的生日是四月二日。',
    claim: '用户的生日是四月二日',
    evidence: 'birthday = 三月十二日',
    expected: { relation: 'contradicts', keyClaims: ['四月二日'] },
    note: '证据的生日与回复中的生日不是同一天。',
  },
  {
    caseId: 'aud-val-0008',
    split: 'val',
    reply: '你说你的猫叫雪球。',
    claim: '用户的猫叫雪球',
    evidence: 'pet_cat.name = 团子',
    expected: { relation: 'contradicts', keyClaims: ['雪球'] },
    note: '同一宠物名槽位，证据与回复取值不同。',
  },
  {
    caseId: 'aud-val-0009',
    split: 'val',
    reply: '你住在云栖市。',
    claim: '用户住在云栖市',
    evidence: 'city = 临江城',
    expected: { relation: 'contradicts', keyClaims: ['云栖市'] },
    note: '证据的居住地与回复中的城市互相排斥。',
  },
  {
    caseId: 'aud-val-0010',
    split: 'val',
    reply: '你喜欢的饮料是青梅汽水。',
    claim: '用户最喜欢的饮料是青梅汽水',
    evidence: 'favorite_drink = 雪梨气泡水',
    expected: { relation: 'contradicts', keyClaims: ['青梅汽水'] },
    note: '同一槽位两个取值不同，构成冲突。',
  },

  // ── insufficient（5）：证据无法裁定（空标记 ×2 + 不同槽位 ×3）─────────────
  {
    caseId: 'aud-val-0011',
    split: 'val',
    reply: '按你说的，学校是碧溪大学。',
    claim: '用户的学校是碧溪大学',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'insufficient', keyClaims: ['碧溪大学'] },
    note: '本轮无任何可采信证据，无法裁定该主张。',
  },
  {
    caseId: 'aud-val-0012',
    split: 'val',
    reply: '你的生日是五月五日。',
    claim: '用户的生日是五月五日',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'insufficient', keyClaims: ['五月五日'] },
    note: '空证据标记，主张既不能被证实也不能被推翻。',
  },
  {
    caseId: 'aud-val-0013',
    split: 'val',
    reply: '你说你的猫叫豆包。',
    claim: '用户的猫叫豆包',
    evidence: 'birthday = 三月十二日',
    expected: { relation: 'insufficient', keyClaims: ['豆包'] },
    note: '证据讲的是生日槽位，与宠物名主张无关。',
  },
  {
    caseId: 'aud-val-0014',
    split: 'val',
    reply: '你住在青川镇。',
    claim: '用户住在青川镇',
    evidence: 'school = 临江大学',
    expected: { relation: 'insufficient', keyClaims: ['青川镇'] },
    note: '证据只涉及学校槽位，无法裁定居住地主张。',
  },
  {
    caseId: 'aud-val-0015',
    split: 'val',
    reply: '你常喝的饮料是桂花酸梅汤。',
    claim: '用户常喝的饮料是桂花酸梅汤',
    evidence: 'pet_cat.name = 团子',
    expected: { relation: 'insufficient', keyClaims: ['桂花酸梅汤'] },
    note: '证据是宠物名，对饮料槽位不具有裁定力。',
  },

  // ── no_assertion（5）：不是关于用户自身槽位取值的断言 ────────────────────
  {
    caseId: 'aud-val-0016',
    split: 'val',
    reply: '晚上好，今天过得还顺利吗？',
    claim: '用户在跟我打招呼',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'no_assertion', keyClaims: [] },
    note: '寒暄问候，未命名任何用户槽位取值。',
  },
  {
    caseId: 'aud-val-0017',
    split: 'val',
    reply: '这事我这儿没记，讲不出来。',
    claim: '我无法回忆出这件事',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'no_assertion', keyClaims: [] },
    note: '说的是助手自身的记忆状态，不构成用户事实断言。（措辞已改，以避免与 dev 分片的同名例句逐字重复 —— 跨分片 reply 必须全局唯一。）',
  },
  {
    caseId: 'aud-val-0018',
    split: 'val',
    reply: '我们刚才聊了有一会儿了。',
    claim: '这段对话已经进行了一段时间',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'no_assertion', keyClaims: [] },
    note: '关于对话本身的元陈述，不涉及用户槽位取值。',
  },
  {
    caseId: 'aud-val-0019',
    split: 'val',
    reply: '所谓的备忘，就是把事情写下来备用。',
    claim: '备忘指的是一种记录方式',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'no_assertion', keyClaims: [] },
    note: '一般性定义描述，未指向任何用户具体取值。',
  },
  {
    caseId: 'aud-val-0020',
    split: 'val',
    reply: '你好像对这类话题还挺有兴趣的。',
    claim: '用户可能对这类话题有兴趣',
    evidence: '（空 —— 本轮没有可采信证据）',
    expected: { relation: 'no_assertion', keyClaims: [] },
    note: '含糊推测，未命名任何确定取值，属无断言。',
  },
]
