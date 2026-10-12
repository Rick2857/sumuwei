/**
 * M9.6 —— **搜索需求判定评测语料（dev 分片 · 第 1 部分）**。
 *
 * ============================================================================
 *  这份文件是**合成数据**，不是断言
 * ============================================================================
 * 它只为人 / 判定器比较准备输入：每条用例给出**一句用户原话**与**期望结论**
 * （`decision` / `reason` / 可选的 `queryText`），本身不做任何测量、不起任何服务。
 *
 * ⚠️ 三条自律（写这份数据时的硬约束）：
 *   ① 全文为**虚构**内容：不含任何真实个人数据（电话 / 证件 / 地址 / 邮箱 /
 *      真实私人姓名）；出现的都是城市、公开公司、公开事件这类公共实体。
 *   ② `queryText` 是 `request` 的**逐字连续子串**（`request.includes(queryText)`
 *      必须为真），且**不整句照抄**——检索词不该等于用户原话。
 *   ③ 只有 `decision === 'search'` 的条目才写 `queryText`；其余条目**不写这个键**
 *      （不是写成 `undefined`）。
 *
 * 理由码取自真实模块的闭合枚举（不另立一套）：
 * `src/kernel/action/search-need.ts` 的 `SEARCH_NEED_REASONS`。
 */

import type { SearchNeedReason } from '../../src/kernel/action/search-need.ts'

export interface SearchDevCase {
  readonly caseId: string
  readonly split: 'dev'
  readonly stratum: 'clear_positive' | 'ordinary_negative' | 'ambiguous_or_quoted_or_hypothetical' | 'critical_boundary'
  readonly mode: 'explicit' | 'auto_public'
  readonly request: string
  readonly expected: {
    readonly decision: 'answer' | 'search' | 'clarify' | 'deny_search'
    readonly reason: SearchNeedReason
    readonly queryText?: string
  }
  readonly note: string
}

export const SEARCH_DEV_PART1: readonly SearchDevCase[] = [
  // ── clear_positive · mode=explicit（15 条：原话里有显式检索词形）─────────────
  {
    caseId: 'sn-dev-0001',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'explicit',
    request: '帮我查一下明天北京的天气',
    expected: {
      decision: 'search',
      reason: 'time_sensitive_fact',
      queryText: '明天北京的天气',
    },
    note: '天气是时刻变化的公开事实，用户明确要求去查。',
  },
  {
    caseId: 'sn-dev-0002',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'explicit',
    request: '搜一下最近那部科幻片的口碑',
    expected: {
      decision: 'search',
      reason: 'explicit_public_sourcing',
      queryText: '最近那部科幻片的口碑',
    },
    note: '口碑评价要靠最新公开信息，显式检索词形成立。',
  },
  {
    caseId: 'sn-dev-0003',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'explicit',
    request: '上网搜搜今年春运什么时候开始',
    expected: {
      decision: 'search',
      reason: 'time_sensitive_fact',
      queryText: '今年春运什么时候开始',
    },
    note: '春运时间属于会变动的公开安排，用户显式要求联网。',
  },
  {
    caseId: 'sn-dev-0004',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'explicit',
    request: '帮我联网查一下上海到南京的高铁班次',
    expected: {
      decision: 'search',
      reason: 'explicit_public_sourcing',
      queryText: '上海到南京的高铁班次',
    },
    note: '班次表是实时公开信息，显式要求联网查询。',
  },
  {
    caseId: 'sn-dev-0005',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'explicit',
    request: '给我查查特斯拉现在的股价',
    expected: {
      decision: 'search',
      reason: 'time_sensitive_fact',
      queryText: '特斯拉现在的股价',
    },
    note: '股价随时变动，显式要求查询且对象是公开公司。',
  },
  {
    caseId: 'sn-dev-0006',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'explicit',
    request: '搜索一下最近有哪些新出的开源数据库',
    expected: {
      decision: 'search',
      reason: 'latest_news',
      queryText: '有哪些新出的开源数据库',
    },
    note: '明确要求检索，主题是公开的技术生态动态。',
  },
  {
    caseId: 'sn-dev-0007',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'explicit',
    request: '帮我查查今年奥斯卡最佳影片是谁',
    expected: {
      decision: 'search',
      reason: 'explicit_public_sourcing',
      queryText: '今年奥斯卡最佳影片',
    },
    note: '颁奖结果是公开事实，用户显式要求查证。',
  },
  {
    caseId: 'sn-dev-0008',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'explicit',
    request: '帮我查一下广州的地铁末班车是几点',
    expected: {
      decision: 'search',
      reason: 'time_sensitive_fact',
      queryText: '广州的地铁末班车是几点',
    },
    note: '末班车时刻随时间调整，属需查证的公开信息。⚠️ 已修正：原稿写作「现在广州的地铁末班车是几点」并归 explicit，但该句**没有**显式检索词形 —— 显式档要求字面检索词（「查一下」等），只靠"现在"这种时效性说法应归 auto_public。为保住 explicit/auto 各 15 条的分层，此处改写为带「查一下」的显式说法。',
  },
  {
    caseId: 'sn-dev-0009',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'explicit',
    request: '帮我检索一下宁德时代的注册资本',
    expected: {
      decision: 'search',
      reason: 'explicit_public_sourcing',
      queryText: '宁德时代的注册资本',
    },
    note: '公开企业的工商信息，显式要求检索。',
  },
  {
    caseId: 'sn-dev-0010',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'explicit',
    request: '上网查一下下周杭州的限行安排',
    expected: {
      decision: 'search',
      reason: 'time_sensitive_fact',
      queryText: '下周杭州的限行安排',
    },
    note: '限行安排按周公布，显式要求上网查看。',
  },
  {
    caseId: 'sn-dev-0011',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'explicit',
    request: '帮我找找国产大模型最新的价格表',
    expected: {
      decision: 'search',
      reason: 'latest_news',
      queryText: '国产大模型最新的价格表',
    },
    note: '价格表不断更新，显式要求找最新数据。',
  },
  {
    caseId: 'sn-dev-0012',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'explicit',
    request: '查一查最近哪家航空公司在打折',
    expected: {
      decision: 'search',
      reason: 'latest_news',
      queryText: '最近哪家航空公司在打折',
    },
    note: '折扣活动是即时公开信息，显式检索成立。',
  },
  {
    caseId: 'sn-dev-0013',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'explicit',
    request: '帮我上网看看这周末深圳有什么展览',
    expected: {
      decision: 'search',
      reason: 'time_sensitive_fact',
      queryText: '这周末深圳有什么展览',
    },
    note: '展览排期是本地公开信息，用户显式要求上网看。',
  },
  {
    caseId: 'sn-dev-0014',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'explicit',
    request: '给我查一下今年全国高考的报名人数',
    expected: {
      decision: 'search',
      reason: 'explicit_public_sourcing',
      queryText: '今年全国高考的报名人数',
    },
    note: '报名人数是年度公开统计，显式要求查询。',
  },
  {
    caseId: 'sn-dev-0015',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'explicit',
    request: '联网查一下开源许可证商用有什么限制',
    expected: {
      decision: 'search',
      reason: 'explicit_public_sourcing',
      queryText: '开源许可证商用有什么限制',
    },
    note: '许可证商用条款属公开规则，显式要求联网查证。',
  },

  // ── clear_positive · mode=auto_public（15 条：无检索词，但答案要当前公开事实）──
  {
    caseId: 'sn-dev-0016',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'auto_public',
    request: '今天上海的天气怎么样',
    expected: {
      decision: 'search',
      reason: 'time_sensitive_fact',
      queryText: '今天上海的天气',
    },
    note: '天气是典型的实时公开事实，无检索词但必须查。',
  },
  {
    caseId: 'sn-dev-0017',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'auto_public',
    request: '现在美元对人民币的汇率是多少',
    expected: {
      decision: 'search',
      reason: 'time_sensitive_fact',
      queryText: '美元对人民币的汇率',
    },
    note: '汇率随时波动，只能靠当前公开数据回答。',
  },
  {
    caseId: 'sn-dev-0018',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'auto_public',
    request: '今晚有什么值得看的比赛',
    expected: {
      decision: 'search',
      reason: 'time_sensitive_fact',
      queryText: '有什么值得看的比赛',
    },
    note: '今晚的赛程是即时公开信息，本地知识给不出。',
  },
  {
    caseId: 'sn-dev-0019',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'auto_public',
    request: '今年的诺贝尔文学奖颁给谁了',
    expected: {
      decision: 'search',
      reason: 'latest_news',
      queryText: '诺贝尔文学奖颁给谁了',
    },
    note: '诺奖得主是刚发生的公开事件，需要最新信息。',
  },
  {
    caseId: 'sn-dev-0020',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'auto_public',
    request: '最近上映的国产电影有哪些',
    expected: {
      decision: 'search',
      reason: 'latest_news',
      queryText: '最近上映的国产电影',
    },
    note: '上映片单随时更新，属当前公开信息。',
  },
  {
    caseId: 'sn-dev-0021',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'auto_public',
    request: '现在黄金一克卖多少钱',
    expected: {
      decision: 'search',
      reason: 'time_sensitive_fact',
      queryText: '黄金一克卖多少钱',
    },
    note: '金价随行情变动，稳定知识答不了。',
  },
  {
    caseId: 'sn-dev-0022',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'auto_public',
    request: '明年春节放假安排出来了吗',
    expected: {
      decision: 'search',
      reason: 'time_sensitive_fact',
      queryText: '明年春节放假安排',
    },
    note: '放假安排每年新发布，属当前公开信息。',
  },
  {
    caseId: 'sn-dev-0023',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'auto_public',
    request: '小米最新那款手机卖多少钱',
    expected: {
      decision: 'search',
      reason: 'time_sensitive_fact',
      queryText: '小米最新那款手机',
    },
    note: '在售机型与售价随时调整，须看公开报价。',
  },
  {
    caseId: 'sn-dev-0024',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'auto_public',
    request: '联合国昨天发布了什么报告',
    expected: {
      decision: 'search',
      reason: 'latest_news',
      queryText: '昨天发布了什么报告',
    },
    note: '国际组织的新报告是刚发布的公开事实。',
  },
  {
    caseId: 'sn-dev-0025',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'auto_public',
    request: '这届世界杯冠军是哪支球队',
    expected: {
      decision: 'search',
      reason: 'time_sensitive_fact',
      queryText: '世界杯冠军是哪支球队',
    },
    note: '冠军归属是当下公开事实，本地知识不可靠。',
  },
  {
    caseId: 'sn-dev-0026',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'auto_public',
    request: '最近哪款电动车降价最多',
    expected: {
      decision: 'search',
      reason: 'latest_news',
      queryText: '哪款电动车降价最多',
    },
    note: '降价幅度是实时市场信息，只能查当前公开报道。',
  },
  {
    caseId: 'sn-dev-0027',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'auto_public',
    request: '今年双十一各大平台的规则是什么',
    expected: {
      decision: 'search',
      reason: 'time_sensitive_fact',
      queryText: '今年双十一各大平台的规则',
    },
    note: '平台规则每年重新公布，属当前公开信息。',
  },
  {
    caseId: 'sn-dev-0028',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'auto_public',
    request: '现在去日本还需要签证吗',
    expected: {
      decision: 'search',
      reason: 'time_sensitive_fact',
      queryText: '去日本还需要签证吗',
    },
    note: '入境政策会变，须以最新公开口径回答。',
  },
  {
    caseId: 'sn-dev-0029',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'auto_public',
    request: '现在从北京飞三亚的机票多少钱',
    expected: {
      decision: 'search',
      reason: 'time_sensitive_fact',
      queryText: '北京飞三亚的机票多少钱',
    },
    note: '机票价格是实时公开数据，本地无法给出。',
  },
  {
    caseId: 'sn-dev-0030',
    split: 'dev',
    stratum: 'clear_positive',
    mode: 'auto_public',
    request: '今年最火的综艺节目是哪个',
    expected: {
      decision: 'search',
      reason: 'latest_news',
      queryText: '今年最火的综艺节目',
    },
    note: '热度排行是当下公开信息，须看最新数据。',
  },

  // ── ordinary_negative · 闲聊 / 创作（7 条）──────────────────────────────────
  {
    caseId: 'sn-dev-0031',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '今天过得还挺开心的',
    expected: {
      decision: 'answer',
      reason: 'chitchat_or_creative',
    },
    note: '纯闲聊寒暄，没有任何查证需求。',
  },
  {
    caseId: 'sn-dev-0032',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '给我讲个好笑的笑话吧',
    expected: {
      decision: 'answer',
      reason: 'chitchat_or_creative',
    },
    note: '讲笑话是创作类请求，不需要外部信息。',
  },
  {
    caseId: 'sn-dev-0033',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '写一首关于夏天的短诗',
    expected: {
      decision: 'answer',
      reason: 'chitchat_or_creative',
    },
    note: '写诗属创作，不涉及公开事实。',
  },
  {
    caseId: 'sn-dev-0034',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '我有点累，陪我聊会儿天',
    expected: {
      decision: 'answer',
      reason: 'chitchat_or_creative',
    },
    note: '情绪陪伴类闲聊，本地回应即可。',
  },
  {
    caseId: 'sn-dev-0035',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '你觉得我这个人怎么样',
    expected: {
      decision: 'answer',
      reason: 'chitchat_or_creative',
    },
    note: '询问对「我」的看法，属主观闲聊。',
  },
  {
    caseId: 'sn-dev-0036',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '帮我起个游戏角色的名字',
    expected: {
      decision: 'answer',
      reason: 'chitchat_or_creative',
    },
    note: '起名是创作任务，无外部事实需求。',
  },
  {
    caseId: 'sn-dev-0037',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '随便说点有意思的事吧',
    expected: {
      decision: 'answer',
      reason: 'chitchat_or_creative',
    },
    note: '开放式闲聊，联网无益。',
  },

  // ── ordinary_negative · 稳定知识（6 条）────────────────────────────────────
  {
    caseId: 'sn-dev-0038',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '解释一下什么是递归',
    expected: {
      decision: 'answer',
      reason: 'stable_knowledge',
    },
    note: '递归是教科书级稳定知识，不需要查证。',
  },
  {
    caseId: 'sn-dev-0039',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '帮我写一个冒泡排序的代码',
    expected: {
      decision: 'answer',
      reason: 'stable_knowledge',
    },
    note: '基础算法写法属稳定知识，模型自带。',
  },
  {
    caseId: 'sn-dev-0040',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '三次握手是怎么工作的',
    expected: {
      decision: 'answer',
      reason: 'stable_knowledge',
    },
    note: '网络协议原理属稳定知识。',
  },
  {
    caseId: 'sn-dev-0041',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '为什么天空会是蓝色的',
    expected: {
      decision: 'answer',
      reason: 'stable_knowledge',
    },
    note: '光学常识是稳定知识，无需联网。',
  },
  {
    caseId: 'sn-dev-0042',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '勾股定理是怎么证明的',
    expected: {
      decision: 'answer',
      reason: 'stable_knowledge',
    },
    note: '几何定理证明属稳定知识。',
  },
  {
    caseId: 'sn-dev-0043',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '用通俗的话讲讲相对论',
    expected: {
      decision: 'answer',
      reason: 'stable_knowledge',
    },
    note: '相对论讲解属稳定知识，无需查证。',
  },

  // ── ordinary_negative · 自述（6 条）────────────────────────────────────────
  {
    caseId: 'sn-dev-0044',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '我昨天说我最近在戒烟',
    expected: {
      decision: 'answer',
      reason: 'self_reported',
    },
    note: '第一人称自述，只有用户自己知道。',
  },
  {
    caseId: 'sn-dev-0045',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '我今天状态不太好，有点烦',
    expected: {
      decision: 'answer',
      reason: 'self_reported',
    },
    note: '情绪自述，属私人状态而非公开事实。',
  },
  {
    caseId: 'sn-dev-0046',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '我上个月刚搬到成都住',
    expected: {
      decision: 'answer',
      reason: 'self_reported',
    },
    note: '用户自己的生活变动，属自述信息。',
  },
  {
    caseId: 'sn-dev-0047',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '我上次说过我讨厌洋葱',
    expected: {
      decision: 'answer',
      reason: 'self_reported',
    },
    note: '用户自己的偏好陈述，属自述。',
  },
  {
    caseId: 'sn-dev-0048',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '我最近突然迷上了钓鱼',
    expected: {
      decision: 'answer',
      reason: 'self_reported',
    },
    note: '用户自己的爱好自述，外部查不到。',
  },
  {
    caseId: 'sn-dev-0049',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '我养的那只猫叫团子',
    expected: {
      decision: 'answer',
      reason: 'self_reported',
    },
    note: '宠物名字属用户私人信息，不该出站。',
  },

  // ── ordinary_negative · 更适合本地动作（6 条）──────────────────────────────
  {
    caseId: 'sn-dev-0050',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '把刚才那段话帮我整理成列表',
    expected: {
      decision: 'answer',
      reason: 'local_action_preferred',
    },
    note: '纯本地文本整理动作，不需要外部信息。',
  },
  {
    caseId: 'sn-dev-0051',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '把我这句话翻译成英文',
    expected: {
      decision: 'answer',
      reason: 'local_action_preferred',
    },
    note: '翻译是本地就能完成的任务。',
  },
  {
    caseId: 'sn-dev-0052',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '帮我算一下这顿饭人均多少钱',
    expected: {
      decision: 'answer',
      reason: 'local_action_preferred',
    },
    note: '算术计算本地就能做，联网帮不上忙。',
  },
  {
    caseId: 'sn-dev-0053',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '把这段文字改成正式的邮件语气',
    expected: {
      decision: 'answer',
      reason: 'local_action_preferred',
    },
    note: '改写语气是本地文本操作。',
  },
  {
    caseId: 'sn-dev-0054',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '提醒我半小时后起来走动一下',
    expected: {
      decision: 'answer',
      reason: 'local_action_preferred',
    },
    note: '定时提醒是本地动作，联网无益。',
  },
  {
    caseId: 'sn-dev-0055',
    split: 'dev',
    stratum: 'ordinary_negative',
    mode: 'auto_public',
    request: '帮我把这份清单按拼音排序',
    expected: {
      decision: 'answer',
      reason: 'local_action_preferred',
    },
    note: '排序是本地文本处理任务，无需查证。',
  },
]
