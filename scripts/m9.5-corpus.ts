/**
 * M9.5 WP2 —— **语料生成与清单**（`pnpm m9.5:corpus`）。
 *
 * ============================================================================
 *  它产出什么、为什么这么设计
 * ============================================================================
 * 计划 §14.1 要一份 **600 条独立查询场景** 的金标语料，并按 **事实族** 分组拆分，
 * 且「同一底层事实的近义问法**不得**分散到三个集合造成泄漏」。
 *
 * 本生成器把那条纪律做成**构造性保证**，而不是靠人工小心：
 *
 * ```text
 * ① 事实（fact）= (owner, user, predicate, value) 的**四元组**，全局唯一。
 * ② **一个 fact group 恰好绑定一个问句** ⇒ 拆 split 的最小单位就是 fact 本身
 *    ⇒ **按构造不可能**出现"同一事实的问法跨 dev/val/blind"。
 *    （计划要求的是"不泄漏"，不是"每个事实必须多个问法"；v1 选前者，理由写进清单。）
 * ③ 拆分配额是**精确构造**的：plan 里每个子层的 dev/val/blind 条数直接写死，
 *    生成后**核对总数**，不符即失败关闭（不"差不多就行"）。
 * ```
 *
 * ============================================================================
 *  三处必须写明的边界
 * ============================================================================
 * ```text
 * A. **只用语料登记表里已注册的槽位**（`registeredPredicates()`）。
 *    `food.preference.cilantro`（3 个取值）与 `preferred.explanation.style`
 *    （scale + 语义依赖 qualifier）**被排除**：前者取值域太小且与 `food.avoid.general`
 *    主题重叠，后者不指定 qualifier 时问句本身有歧义 ⇒ 都会让"期望答案"不确定。
 *    排除理由写进清单（这是**范围选择**，不是"这两个槽位有问题"）。
 * B. **盲测集不进仓库**：盲测用**外部种子**（`artifacts/m9.5/local/corpus-seed.json`，
 *    已 ignore）生成；仓库侧只落 `sha256` 与计数。⚠️ 若种子缺失，脚本会**新建**一个并
 *    只回显其指纹 —— 公开仓库因此无法重新生成盲测集。
 * C. 语料里的记忆是**规格**（spec），不是已写入的库。WP9 执行时必须经**确定性写入路径**
 *    物化它们（不得依赖规则抽取器把句子解析对；抽取器的边界见 `AGENTS.md` §3 的冻结区）。
 * ```
 *
 * 用法：
 *   pnpm m9.5:corpus                 # 生成（缺种子时新建并落本地）
 *   pnpm m9.5:corpus --rebuild-seed  # 显式重建盲测种子（会作废既有盲测集）
 */

import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { registeredPredicates } from '../src/kernel/contracts/memory-predicates.ts'

import { sha256, type M4Harness } from './m4-harness.ts'
import { dirtyPaths, sourceTreeReading } from './m6.1-run-manifest.ts'
import {
  createM95RunId,
  openM95RunDir,
  runIdFromM95OutPath,
  selfCheckMeasurement,
  writeM95Manifest,
} from './m9.5-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const STARTED_AT = new Date().toISOString()
const GATE_VERSION = 'm9.5-corpus@1'
const CORPUS_VERSION = 'm9.5-corpus@1'
const GENERATOR_VERSION = 'm9.5-corpus-gen@1'

const CORPUS_DIR = join(REPO_ROOT, 'evals/m9.5/corpus')
const MANIFEST_PATH = join(CORPUS_DIR, 'M9.5-Corpus-Manifest.json')
const LOCAL_ROOT = join(REPO_ROOT, 'artifacts/m9.5/local')
const SEED_PATH = join(LOCAL_ROOT, 'corpus-seed.json')
const BLIND_DIR = join(LOCAL_ROOT, 'corpus-blind')

const OWNER_MAIN = 'C1'
const OWNER_OTHER = 'C2'

// ---------------------------------------------------------------------------
// 取值池（人类的合成值；数字/英文混排单独给）
// ---------------------------------------------------------------------------

const CITIES = [
  '江城', '明德', '云岭', '青川', '白鹭', '临海', '望京', '长陵', '南屿', '和风',
  '星洲', '翠屏', '洛川', '海陵', '锦山', '松江', '碧溪', '安平', '玉泉', '雁栖',
  '沧澜', '灵岩', '熙河', '桐乡', '兰亭', '顾山', '平湖', '皖水', '梅岭', '青阳',
  '楚门', '荆溪', '苏岭', '越城', '钱塘', '吴淞', '湘潭', '赣江', '汉中', '洛水',
  '白鹿', '栖霞', '穗城', '澄江', '墨溪', '燕山', '沅陵', '霅川',
] as const

const POOLS: Record<string, readonly string[]> = {
  'education.institution': CITIES.map((city) => `${city}大学`),
  /*
   * 数量类：**同时给小时与分钟两种口径**，让"换个单位说"有真实材料。
   * ⚠️ 取值数必须**留余量**：`numberUnit`(20) + `unitChange`(20) 共需 40 个
   *    (user × value) 组合；首版只给 10 个取值（16×... ⇒ 40 组合）恰在容量边界，
   *    实测报 `hard/unitChange/blind 第 8 条：事实池耗尽`（跨 split 唯一性约束吃掉余量）。
   *    ⇒ 给 **16 个取值**（16 × 4 users = 64 组合）。
   */
  'health.sleep.duration': [
    '7 小时', '420 分钟', '6 小时', '360 分钟', '8 小时', '480 分钟',
    '5 小时', '300 分钟', '9 小时', '540 分钟', '4 小时', '240 分钟',
    '10 小时', '600 分钟', '3 小时', '180 分钟',
  ],
  'education.major': [
    '计算机科学', '汉语言文学', '历史学', '数学与应用数学', '电子信息工程', '机械工程',
    '临床医学', '法学', '金融学', '心理学', '建筑学', '化学工程', '生物科学', '环境工程',
    '新闻学', '哲学', '物理学', '自动化', '土木工程', '软件工程', '人工智能', '材料科学',
    '经济学', '教育学',
  ],
  'education.status': ['high_school', 'undergraduate', 'graduate', 'doctorate', 'graduated', 'other'],
  'project.background.active': [
    '毕业论文', '课程设计', '毕业设计', '开源翻译工具', '个人博客重构', '数据可视化面板',
    '语音助手原型', '校园导览小程序', '财务记账应用', '图像修复实验', '爬虫框架', '单元测试套件',
    '论文复现项目', '方言语音库', '课程笔记系统', '简历生成器', '时间管理工具', '命令行待办工具',
    '天气聚合服务', '电子书转换器', '音乐推荐原型', '考研复习计划', '竞赛作品', '实验室周报系统',
    '知识图谱实验', '视频剪辑工具', '聊天机器人原型', '静态站点生成器', '密码管理器', '图表标注工具',
    '论文摘要生成器', '日程同步服务', '算式识别实验', '寝室水电统计', '社团报名系统', '车票提醒脚本',
  ],
  'device.primary': [
    'Windows 笔记本', 'MacBook', 'Linux 台式机', '二合一笔记本', '工作站', '树莓派',
    '迷你主机', '游戏本', '轻薄本', '一体机', '二手笔记本', 'ThinkPad X1',
  ],
  'food.avoid.general': [
    '辣', '香菜', '海鲜', '牛奶', '花生', '芒果', '咖啡', '酒精', '牛肉', '羊肉',
    '洋葱', '大蒜', '芹菜', '鸡蛋', '麸质', '冷饮', '甜食', '油炸食品', '腌制品', '动物内脏',
    '苦瓜', '木耳', '豆浆',
  ],
  'preferred.address': [
    'Alex', '小薇', '阿澈', '老张', '小林', '苏苏', '薇薇', '阿哲', '小雨', '老李',
    '阿宁', '嘉嘉', '小何', '阿洛', '团团', '明明',
  ],
  'tooling.preference.editor': [
    'VS Code', 'Vim', 'Neovim', 'JetBrains', 'Sublime Text', 'Emacs', 'Zed', 'Helix',
    'Notepad++', 'WebStorm',
  ],
}

/**
 * **被排除**的已注册槽位 + 理由（写进清单；这是范围选择，不是"槽位有问题"）。
 * 另有 `preferred.explanation.style` 未列入池 ⇒ 自动被排除，理由见下。
 */
const EXCLUDED_PREDICATES: readonly { key: string; reason: string }[] = [
  {
    key: 'food.preference.cilantro',
    reason:
      '取值域只有 like/dislike/neutral（3 个），且主题与 food.avoid.general 重叠 ⇒ ' +
      '问句「你吃香菜吗？」在两槽位并存时期望答案不唯一',
  },
  {
    key: 'preferred.explanation.style',
    reason:
      'scale 取值 + **语义依赖 qualifier**（登记表原文：技术问题要详细、闲聊要简短必须落两条）' +
      '⇒ 不指定 qualifier 时问句本身有歧义，期望答案不确定',
  },
]

/** 话题名词：让问句模板可以跨 predicate 组合（否则要写 9×23 份模板） */
const TOPIC: Record<string, string> = {
  'education.institution': '学校',
  'health.sleep.duration': '睡眠时长',
  'education.major': '专业',
  'education.status': '学历阶段',
  'project.background.active': '在做的项目',
  'device.primary': '常用的设备',
  'food.avoid.general': '不吃的东西',
  'preferred.address': '称呼',
  'tooling.preference.editor': '常用的编辑器',
}

// ---------------------------------------------------------------------------
// 问句模板（按"子层"定义，用 {t} 代入话题、{hint} 代入取值片段）
// ---------------------------------------------------------------------------

type FormKind =
  | 'synonym' | 'indirect' | 'elliptical' | 'boundedHint' | 'mixedEntity'
  | 'person' | 'negation' | 'numberUnit' | 'similarProject' | 'unitChange' | 'historyVsCurrent'
  | 'neverSaved' | 'forgotten' | 'chatOnly' | 'ambiguousSubject' | 'outOfCoverage' | 'beyondScope'
  | 'superseded' | 'wrongOwner' | 'brokenRoot' | 'rebuildRevival' | 'summaryConflict' | 'sourceUnreadable'

interface FormSpec {
  readonly kind: FormKind
  readonly label: string
  /** 问句模板（可多条；生成时按 fact 序号轮换，避免整层同一句） */
  readonly templates: readonly string[]
  /** 期望：true = 应取回；false = 应未知/澄清；'historical' = 按原历史政策可取回 */
  readonly expectation: 'retrieve' | 'unknown' | 'clarify' | 'historical'
}

const FORMS: readonly FormSpec[] = [
  { kind: 'synonym', label: '同义改述', expectation: 'retrieve',
    templates: ['我{t}是什么来着？', '你还记得我{t}吗？', '我说过我{t}吗？'] },
  { kind: 'indirect', label: '间接指代', expectation: 'retrieve',
    templates: ['关于{t}那件事，你还有印象吗？', '我{t}这方面，你记着的是什么？'] },
  { kind: 'elliptical', label: '口语省略', expectation: 'retrieve',
    templates: ['{t}呢？', '{t}，说说。'] },
  { kind: 'boundedHint', label: '上下文有界提示', expectation: 'retrieve',
    templates: ['就是{hint}那个，我{t}到底是什么？', '提到{hint}的时候我说过我{t}，是什么？'] },
  { kind: 'mixedEntity', label: '中文夹英文/编号', expectation: 'retrieve',
    templates: ['我{t}那个带英文或编号的，具体是哪个？', '我{t}是英文名/型号那个，你还记得吗？'] },
  { kind: 'person', label: '人物/主体区分', expectation: 'retrieve',
    templates: ['我{t}是什么？'] },
  { kind: 'negation', label: '否定', expectation: 'retrieve',
    templates: ['我{t}这件事，我是不是说过相反的？先说我{t}是什么。'] },
  /*
   * 数字/单位：**材料**承载数字与单位（值形如「7 小时」）。
   * ⚠️ 原模板「我{t}里带数字的那个，是多少？」暗示"多个带数字的取值里挑一个"，
   *    而单值场景下没有可挑的 ⇒ 首轮人审指出"问答不匹配"。改为直接问取值。
   */
  { kind: 'numberUnit', label: '数字/单位', expectation: 'retrieve',
    templates: ['我{t}是多少？'] },
  { kind: 'similarProject', label: '相似项目区分', expectation: 'retrieve',
    templates: ['我{t}里跟另一个很像的那个，是哪一个？'] },
  /*
   * 单位/口径变化：**要求材料含单位**，且问法必须真的是"换口径"。
   * ⚠️ 原模板「换个说法再问一次」是**改述**，与"单位变化"无关 ⇒ 首轮人审指出标签与内容不符。
   */
  { kind: 'unitChange', label: '单位/口径变化', expectation: 'retrieve',
    templates: ['我{t}换个单位说，是多少？'] },
  { kind: 'historyVsCurrent', label: '历史与当前', expectation: 'historical',
    /*
     * ⚠️ **第四轮人审（Q001/Q009）**：原模板「我以前说我{t}是什么？」里的"以前"**有歧义**——
     *    它可能指"最近一次告知"，也可能指"更正之前" ⇒ 答案键只接受旧值就**判错了另一种读法**。
     *    ⇒ 明确写成「**更正之前**」，把歧义消掉（本类的前置就是"先更正过"）。
     */
    templates: ['更正之前，我{t}是什么？'] },
  { kind: 'neverSaved', label: '从未正式保存', expectation: 'unknown',
    templates: ['我{t}你还记得吗？'] },
  { kind: 'forgotten', label: '已遗忘', expectation: 'unknown',
    templates: ['我{t}是什么？我让你忘掉以后还想确认一下。'] },
  { kind: 'chatOnly', label: '只在聊天里提过', expectation: 'unknown',
    templates: ['我随口提过的{t}，你当成事实记住了吗？'] },
  { kind: 'ambiguousSubject', label: '主体模糊', expectation: 'clarify',
    templates: ['{t}是什么？'] },
  { kind: 'outOfCoverage', label: '超出覆盖', expectation: 'unknown',
    templates: ['我{t}在另一个世界的版本是什么？'] },
  { kind: 'beyondScope', label: '本阶段范围之外', expectation: 'unknown',
    templates: ['替我把{t}这件事自动办了吧，顺便告诉我原来是什么。'] },
  { kind: 'superseded', label: '旧值（更正后问现在）', expectation: 'retrieve',
    templates: ['我现在的{t}是什么？'] },
  { kind: 'wrongOwner', label: '错 owner', expectation: 'unknown',
    templates: ['另一个角色那边的{t}是什么？'] },
  { kind: 'brokenRoot', label: '根证据断链', expectation: 'unknown',
    templates: ['我{t}那条，来源还在吗？先说值。'] },
  { kind: 'rebuildRevival', label: '重建后是否复活', expectation: 'retrieve',
    templates: ['我现在的{t}是什么？'] },
  { kind: 'summaryConflict', label: '摘要与记忆冲突', expectation: 'retrieve',
    templates: ['我现在的{t}是什么？'] },
  { kind: 'sourceUnreadable', label: '来源不可读', expectation: 'unknown',
    templates: ['权威库读不到的时候，我{t}你还说得出来吗？'] },
]

/* 场景背景：**独立于用户原话**（首轮人审：提示不得混进 request） */
const SCENARIO_NOTE: Record<FormKind, string> = {
  synonym: '同一事实的另一种说法', indirect: '需要先推断指代', elliptical: '句子省略了主语或宾语',
  boundedHint: '给了一个限定线索', mixedEntity: '句中混入了另一个实体的词',
  person: '同一 predicate 下有两个主体', negation: '存在一条相反取值的诱饵',
  numberUnit: '取值含**数字 + 单位**（事实池经追加槽位 `health.sleep.duration` 提供）',
  similarProject: '存在两个相近取值', unitChange: '同一数量的**两种单位口径**（小时 / 分钟）',
  historyVsCurrent: '先被更正过，再问历史', neverSaved: '**从未正式保存过**（只有诱饵）',
  forgotten: '写过后被遗忘', chatOnly: '只在聊天行里出现过、未成为记忆',
  ambiguousSubject: '同一 predicate 下主体不唯一', outOfCoverage: '只有诱饵，无权威取值',
  beyondScope: '请求落在本阶段范围之外', superseded: '旧值被更正值取代',
  wrongOwner: '同一取值属于**另一个 owner**', brokenRoot: '根证据断链',
  rebuildRevival: '索引重建之后问同一件事', summaryConflict: '摘要里可能写着旧值',
  sourceUnreadable: '权威读取路径失败',
}

const FORM_BY_KIND = new Map(FORMS.map((form) => [form.kind, form]))

// ---------------------------------------------------------------------------
// 拆分配额（**精确构造**：每个子层的 dev/val/blind 条数写死）
// ---------------------------------------------------------------------------

type Stratum = 'normal' | 'hard' | 'unknown' | 'lifecycle'

interface PlanRow {
  readonly stratum: Stratum
  readonly kind: FormKind
  readonly dev: number
  readonly val: number
  readonly blind: number
  /** 只允许从这些 predicate 里取事实（缺省 = 全部可用池） */
  readonly predicates?: readonly string[]
  /**
   * **取值必须匹配的模式**（`L-M95-16`）。
   *
   * 有些子层对**取值形态**有前提（例如"中文夹英文/编号"要求取值**真的含 ASCII**、
   * 数字/单位要求含数字）。让取值去满足前提，比让模板去迁就取值更诚实：
   * 否则那个子层测的就不是它声称的那件事（报告里的覆盖会虚高）。
   */
  readonly valuePattern?: RegExp
}

const PLAN: readonly PlanRow[] = [
  // 正常可回答 240 = dev 96 / val 48 / blind 96
  { stratum: 'normal', kind: 'synonym', dev: 32, val: 16, blind: 32 },
  { stratum: 'normal', kind: 'indirect', dev: 20, val: 10, blind: 20 },
  { stratum: 'normal', kind: 'elliptical', dev: 20, val: 10, blind: 20 },
  { stratum: 'normal', kind: 'boundedHint', dev: 12, val: 6, blind: 12,
    predicates: ['education.institution', 'education.major', 'project.background.active',
      'device.primary', 'food.avoid.general', 'preferred.address', 'tooling.preference.editor'] },
  { stratum: 'normal', kind: 'mixedEntity', dev: 12, val: 6, blind: 12,
    predicates: ['tooling.preference.editor', 'device.primary'],
    /* ⚠️ `L-M95-16`：本类**必须**取含 ASCII 的取值（否则模板"带英文或编号"的前提不成立） */
    valuePattern: /[A-Za-z0-9]/ },
  // 难区分可回答 120 = dev 48 / val 24 / blind 48
  { stratum: 'hard', kind: 'person', dev: 8, val: 4, blind: 8 },
  { stratum: 'hard', kind: 'negation', dev: 8, val: 4, blind: 8,
    predicates: ['food.avoid.general'] },
  { stratum: 'hard', kind: 'numberUnit', dev: 8, val: 4, blind: 8,
    predicates: ['health.sleep.duration'] },
  { stratum: 'hard', kind: 'similarProject', dev: 8, val: 4, blind: 8,
    predicates: ['project.background.active'] },
  { stratum: 'hard', kind: 'unitChange', dev: 8, val: 4, blind: 8,
    predicates: ['health.sleep.duration'] },
  { stratum: 'hard', kind: 'historyVsCurrent', dev: 8, val: 4, blind: 8 },
  // 无答案/应澄清 120 = dev 48 / val 24 / blind 48
  { stratum: 'unknown', kind: 'neverSaved', dev: 8, val: 4, blind: 8 },
  { stratum: 'unknown', kind: 'forgotten', dev: 8, val: 4, blind: 8 },
  { stratum: 'unknown', kind: 'chatOnly', dev: 8, val: 4, blind: 8 },
  { stratum: 'unknown', kind: 'ambiguousSubject', dev: 8, val: 4, blind: 8 },
  { stratum: 'unknown', kind: 'outOfCoverage', dev: 8, val: 4, blind: 8 },
  { stratum: 'unknown', kind: 'beyondScope', dev: 8, val: 4, blind: 8 },
  // 生命周期/隔离对抗 120 = dev 48 / val 24 / blind 48
  { stratum: 'lifecycle', kind: 'superseded', dev: 8, val: 4, blind: 8 },
  { stratum: 'lifecycle', kind: 'wrongOwner', dev: 8, val: 4, blind: 8 },
  { stratum: 'lifecycle', kind: 'brokenRoot', dev: 8, val: 4, blind: 8 },
  { stratum: 'lifecycle', kind: 'rebuildRevival', dev: 8, val: 4, blind: 8 },
  { stratum: 'lifecycle', kind: 'summaryConflict', dev: 8, val: 4, blind: 8 },
  { stratum: 'lifecycle', kind: 'sourceUnreadable', dev: 8, val: 4, blind: 8 },
]

// ---------------------------------------------------------------------------
// 事实池：**(owner, user, predicate, value)** 四元组，全局唯一
// ---------------------------------------------------------------------------

interface Fact {
  readonly factId: string
  readonly owner: string
  readonly user: string
  readonly predicate: string
  readonly value: string
  readonly topic: string
}

const USERS = ['u1', 'u2', 'u3', 'u4'] as const

function availablePredicates(): string[] {
  const poolKeys = Object.keys(POOLS)
  const registered = new Set(registeredPredicates().map((spec) => spec.key))
  const excluded = new Set(EXCLUDED_PREDICATES.map((item) => item.key))
  const missing = poolKeys.filter((key) => !registered.has(key))
  if (missing.length > 0) {
    throw new Error(
      `取值池里的 predicate 未在登记表中：${missing.join(', ')} ⇒ ` +
        '语料不得引用未注册槽位（否则 WP9 无法把记忆物化进库）'
    )
  }
  return poolKeys.filter((key) => !excluded.has(key)).sort()
}

/**
 * 事实分配器 —— **不相交分区 + 秘密种子**（这两条缺一不可）。
 *
 * ⚠️ 第二版的两个坑（都由脚本自己如实报出，不是事后补记）：
 * ```text
 * ① user 轴贴在遍历上（而非进池）⇒ 池只有 158 个，生成到一半耗尽。
 * ② dev/val 与 blind 各用**一份同内容的池** ⇒ 同一事实会同时落进 dev 与 blind
 *    —— 那正是计划 §14.1 禁止的**跨 split 泄漏**（实测重复 138 条）。
 * ```
 *
 * 现在的结构：
 * ```text
 * 池 = (user × predicate × value) 笛卡尔积（本机 700 个）
 * 先用**秘密种子**把池洗一遍 ⇒ secretOrder
 * always:  blind   = secretOrder[0 .. 240)          ← 盲测集（公开仓库算不出来）
 *          dev-val = secretOrder[240 .. 全池)         ← 余量 ≥ 360 且与 blind **不相交**
 * 再把 dev-val 用**公开种子**洗一遍 ⇒ dev/val 的消耗顺序是可复算的（同一秘密种子下）
 * ```
 *
 * ⚠️ 诚实边界：dev/val 的**成员**也间接依赖秘密种子（因为它们是"被盲测拿剩的那部分"）。
 *    因此 `dev.jsonl` / `val.jsonl` **提交进仓库并用 sha256 钉住**；可复核的是它们的
 *    **内容与计数**，不是"从公开种子重算一遍"。理由写在清单里。
 */
const BLIND_SIZE = 240

interface FactAllocator {
  /**
   * @param filter       只从这些 predicate 里取
   * @param valuePattern **取值必须匹配**（`L-M95-16`：让"中文夹英文/编号"这类
   *                     只拿**真的含 ASCII** 的取值，否则模板的前提超过材料）
   */
  take(filter?: readonly string[], valuePattern?: RegExp): Fact | undefined
  readonly poolSize: number
  readonly partitionSize: number
  remaining(): number
}

function makeFactAllocator(input: {
  readonly publicSeed: number
  readonly secretSeed: number
  readonly mode: 'dev-val' | 'blind'
}): FactAllocator {
  const nextOf = (seedRef: { value: number }): number => {
    seedRef.value = (Math.imul(seedRef.value, 1664525) + 1013904223) >>> 0
    return seedRef.value / 0x100000000
  }
  const shuffle = <T>(items: T[], seed: number): T[] => {
    const state = { value: seed >>> 0 }
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(nextOf(state) * (i + 1))
      const a = items[i] as T
      items[i] = items[j] as T
      items[j] = a
    }
    return items
  }

  const predicates = availablePredicates()
  const comboList: Fact[] = []
  for (const user of USERS) {
    for (const predicate of predicates) {
      for (const value of POOLS[predicate] ?? []) {
        comboList.push({
          factId: `${predicate}@${value}@${user}`,
          owner: OWNER_MAIN,
          user,
          predicate,
          value,
          topic: TOPIC[predicate] ?? predicate,
        })
      }
    }
  }
  const poolSize = comboList.length
  const secretOrder = shuffle([...comboList], input.secretSeed)
  const partition =
    input.mode === 'blind'
      ? secretOrder.slice(0, BLIND_SIZE)
      : secretOrder.slice(BLIND_SIZE)
  const ordered = shuffle(partition, input.publicSeed)

  const used = new Set<string>()
  return {
    poolSize,
    partitionSize: ordered.length,
    remaining: () => ordered.length - used.size,
    take: (filter, valuePattern) => {
      for (const combo of ordered) {
        if (used.has(combo.factId)) continue
        if (filter !== undefined && !filter.includes(combo.predicate)) continue
        /* `L-M95-16`：取值模式不满足就跳过（而不是先取再退回中性问法） */
        if (valuePattern !== undefined && !valuePattern.test(combo.value)) continue
        used.add(combo.factId)
        return combo
      }
      return undefined
    },
  }
}

/**
 * **前驱值池**：只用于"更正前的旧值"，**绝不作为任何用例的答案**。
 * 与 `POOLS` **不相交**（构造上保证）⇒ 引入前驱不会造成跨用例的答案碰撞，
 * 也不需要从有限的答案池里多取一个槽位（盲测分区本来就没有余量）。
 */
const PREDECESSOR_POOLS: Record<string, readonly string[]> = {
  'education.institution': ['老城大学', '旧港大学', '远山大学', '北岭大学', '沙洲大学', '清源大学', '麦田大学', '双溪大学'],
  'education.major': ['编辑出版学', '档案学', '博物馆学', '农林经济管理', '印刷工程', '纺织工程', '采矿工程', '航海技术'],
  /*
   * ⚠️⚠️ **2026-09-29 修（`L-M95-33` bug② 的配套）**：`education.status` 原先**只有 `['other']`**，
   *    而事实取值也是 `'other'` ⇒ 前驱"必须与当前不同"的规则下**一个候选都不剩**
   *    ⇒ 5 条 `historyVsCurrent`/`superseded`/`summaryConflict` 被跳过 ⇒ 语料少 5 条（门如实报缺口）。
   *    ⇒ 补入**本语料里确实出现过**的取值（`high_school` 见场景证据）。
   *    ⚠️ 池里每个取值都必须**可能与事实取值不同**，否则该形态必然无前驱。
   */
  /*
   * ⚠️ **2026-09-29 补（`L-M95-33` bug② 的配套）**：`health.sleep.duration` 原先**不在本表里**
   *    ⇒ `predecessorOf` 恒返回 `null` ⇒ 需要前驱的 `superseded`/`summaryConflict`（`lifecycle` 层）
   *    **被跳过 5 条** ⇒ 语料少 5 条。取值风格与事实池一致（小时/分钟两种口径）。
   */
  'health.sleep.duration': ['3 小时', '240 分钟', '5 小时', '300 分钟', '6 小时', '360 分钟'],
  'education.status': ['high_school', 'undergraduate', 'other'],
  'project.background.active': ['旧版论文', '早期草案', '上一版设计', '初版原型', '临时脚本', '试做小工具', '早期笔记', '初步方案'],
  'device.primary': ['旧笔记本', '上一台台式机', '借来的电脑', '老款平板', '机房电脑', '二手台式机', '备用机', '早期上网本'],
  'food.avoid.general': ['奶制品', '坚果', '贝类', '内脏', '芥末', '生姜', '苦味菜', '生冷食物'],
  'preferred.address': ['小苏', '阿薇', '老苏', '苏同学', '薇薇安', '小V', '苏老师', '阿薇姐'],
  'tooling.preference.editor': ['旧编辑器', '早前的 IDE', '学校推荐的编辑器', '命令行编辑器', '老版本编辑器', '临时用的编辑器', '别人的编辑器', '初学时的编辑器'],
}

/** 需要"前一版取值"的形态（更正 / 摘要冲突 / 历史与当前） */
const NEEDS_PREDECESSOR: readonly FormKind[] = ['superseded', 'summaryConflict', 'historyVsCurrent']

function predecessorOf(fact: Fact): { value: string; memoryId: string } | null {
  const pool = PREDECESSOR_POOLS[fact.predicate]
  if (pool === undefined || pool.length === 0) return null
  /*
   * ⚠️⚠️ **2026-09-29 修（`L-M95-33` bug②）**：前驱的取值**必须与当前取值不同**。
   *
   * 原先：`const value = pool[fact.value.length % pool.length]`
   *   · 用"**当前取值的长度**"取模当索引 —— 病态且与语义无关；
   *   · 而 `education.status` 的池只有 `['other']`，当前取值也是 `'other'`
   *     ⇒ 前驱恒等于当前 ⇒ `previousValue === value`（"更正"根本不存在）
   *     ⇒ **memoryId 也相同**（id 由 owner/predicate/value/user 派生）
   *     ⇒ `relevantMemoryIds` 与 `forbiddenIds` **同一条** ⇒ 用例**自相矛盾**，
   *       任何判定器都不可能满足（实测：期望 `correct/wrong`，实测 `wrong/wrong`）。
   *
   * 现在：先**剔除**与当前取值相同的候选；一个都不剩 ⇒ 返回 `null`
   *   （调用方据此**不产出**该形态的用例，而不是产出矛盾的用例）。
   * ⚠️ 索引仍保持**确定性**（同样的输入 ⇒ 同样的输出），不用随机数。
   */
  const candidates = pool.filter((candidate) => candidate !== fact.value)
  if (candidates.length === 0) return null
  const value = candidates[fact.value.length % candidates.length] as string
  return { value, memoryId: `mem:${fact.owner}:${fact.predicate}@${value}@${fact.user}` }
}

// ---------------------------------------------------------------------------
// 用例构造
// ---------------------------------------------------------------------------

interface CorpusCase {
  readonly caseId: string
  readonly familyId: string
  readonly split: 'dev' | 'val' | 'blind'
  readonly stratum: Stratum
  readonly formKind: FormKind
  readonly namespace: string
  readonly user: string
  readonly request: string
  readonly intent: string
  readonly timeScope: string
  readonly authoritativeSnapshot: {
    readonly owner: string
    readonly subject: string
    readonly predicate: string
    readonly value: string
    readonly status: string
    /** 更正/历史形态才有：**前一版取值**（其 id 进 `forbiddenIds` 或 `relevantMemoryIds`） */
    readonly previousValue?: string
  }
  readonly relevantMemoryIds: readonly string[]
  readonly requiredEvidenceGroups: readonly (readonly string[])[]
  readonly forbiddenIds: readonly string[]
  readonly expectedUnknownOrClarify: boolean
  readonly lifecycleSetup: string
  /**
   * **场景背景**（独立于 `request`）。
   *
   * ```text
   * 首轮人审指出：`request` 里原本夹带着「（索引重建之后问）」「（摘要里可能写着旧值）」
   * 这类**测试意图提示** —— 它们会让评审人直接看出本题考查什么，**盲评因此失效**。
   * ⇒ 场景信息移到本字段，`request` 保持**纯用户原话**。
   * ```
   */
  readonly scenarioNote: string
  /**
   * **独立判断所需的证据**（首轮人审：跨 owner / 主体歧义 / 来源断链三类
   * 只给了一张权威快照，评审人**无法独立判断** ⇒ 那三题问的成了"我猜得对不对"）。
   *
   * - `wrongOwner`        当前访问主体 + **另一 owner 的实际记录**
   * - `ambiguousSubject`  **多个可能主体** + 对话背景
   * - `brokenRoot`        **来源引用**（或"断链"这件事本身）
   * - 其余子层            `{}`（不需要额外证据；判据只对上面三类要求非空）
   */
  readonly sceneEvidence: Record<string, unknown>
  readonly acceptableAnswerPoints: readonly string[]
  readonly modelInputRestrictions: readonly string[]
  readonly annotator: string
  readonly adjudication: string
}

/**
 * 小时 ⇄ 分钟的**等价**写法（只服务 `health.sleep.duration`）。
 * ⚠️ 刻意不做通用单位系统：本里程碑只需要证明"两种口径都能对上"。
 */
/**
 * 按子层给出**独立判断所需的证据**。
 *
 * ⚠️ 只放**场景事实**，不放"怎么判"（第二轮人审指出：`whyItMatters` 那类文字
 *    把**结论/判定规则**混进了证据里 ⇒ 应移出卡片，通用规则另处统一提供）。
 * ⚠️ 也不放答案键（`relevantMemoryIds` / `forbiddenIds` / 期望澄清仍在答案键里）。
 */
function sceneEvidenceFor(input: {
  readonly kind: FormKind
  readonly user: string
  readonly predicate: string
  readonly value: string
  /** 同 predicate 下的**另一个**取值（`ambiguousSubject` 用它做"两种可能"） */
  readonly alternateValue: string
}): Record<string, unknown> {
  const recordIdOf = (owner: string, subject: string, value: string): string =>
    `mem:${owner}:${input.predicate}@${value}@${subject}`
  const otherSubject = USERS.find((candidate) => candidate !== input.user) ?? 'u2'
  switch (input.kind) {
    case 'wrongOwner':
      return {
        /* **当前 owner 与读取范围**必须显式给出（否则与顶层 `memory.owner` 混淆） */
        currentOwner: OWNER_MAIN,
        accessScope: `${OWNER_MAIN}（当前会话只读本 owner）`,
        /*
         * ⚠️ 第三轮人审（Q002）：顶层 `memory` 若也展示一条 C1 记录，会看起来**两个 owner 都有记录**
         *    ⇒ 不能准确表达"**只有另一 owner 保存**"。
         * ⇒ 明确 C1 的记录集合**为空**，并把 C2 的记录单独列为**不可访问的候选**。
         */
        currentOwnerRecords: [],
        inaccessibleCandidateRecord: {
          recordId: recordIdOf(OWNER_OTHER, input.user, input.value),
          owner: OWNER_OTHER,
          subject: input.user,
          predicate: input.predicate,
          value: input.value,
          accessible: false,
        },
      }
    case 'ambiguousSubject':
      return {
        /*
         * ⚠️ 第三轮人审（Q016/Q020）：两条候选若**取值相同**，直接回答共同值**不一定错**
         *    ⇒ 无法验证"选错主体会答错"。改为**两个主体各持不同取值**，
         *    并明确**没有任何可消歧的上下文**。
         */
        candidateRecords: [
          {
            recordId: recordIdOf(OWNER_MAIN, input.user, input.value),
            subject: input.user,
            value: input.value,
          },
          {
            recordId: recordIdOf(OWNER_MAIN, otherSubject, input.alternateValue),
            subject: otherSubject,
            value: input.alternateValue,
          },
        ],
        disambiguatingContext: null,
        note: '问句**没有指明**问的是谁，且上下文里**没有**可消歧的线索',
      }
    case 'brokenRoot':
      return {
        rootEvidenceRefs: [],
        rootStatus: 'broken',
        /* ⚠️ 这是**合成前提**，不等于"实际运行中已验证断链" */
        provenance: 'synthetic_premise',
      }
    /*
     * ⚠️ 第三轮人审（Q024）：卡片顶层给了 `memory = <值>`、README 又称它是"权威快照"，
     *    而答案键说这条**从未正式保存** ⇒ **卡片里没有任何事实支持这个区别**，
     *    评审人只能去猜一个看不见的标签。
     * ⇒ 把"**没有正式记忆集合**"这件事**显式作为场景事实**给出。
     */
    case 'neverSaved':
      return {
        formalMemoryRecords: [],
        appearsOnlyIn: 'historical_dialogue',
        /*
         * ⚠️ **第四轮人审（Q024）**：光说"没存长期记忆"**不等于"不能回答"**——
         *    若那段历史对话**仍在本轮可见上下文**里，她仍可能有依据。
         *    ⇒ 把"本轮历史**是否可见**"作为**场景事实**显式给出（合成前提：不可见）。
         */
        historyVisibleThisTurn: false,
        note: '该取值只在**对话行**里出现过；**正式 Memory 集合为空**，且**那段历史本轮不可见**',
      }
    case 'forgotten':
      return {
        formalMemoryRecords: [],
        appearsOnlyIn: 'retracted_by_request',
        note: '曾经写过、随后**按用户要求遗忘** ⇒ 当前正式 Memory 集合为空',
      }
    case 'chatOnly':
      return {
        formalMemoryRecords: [],
        appearsOnlyIn: 'chat_line_only',
        note: '只在聊天里提过，**从未成为记忆**',
      }
    case 'outOfCoverage':
      return {
        formalMemoryRecords: [],
        appearsOnlyIn: 'no_authoritative_record',
        note: '没有任何权威取值，只有诱饵',
      }
    default:
      return {}
  }
}

function convertedFormOf(value: string): string {
  const hours = /^(\d+(?:\.\d+)?)\s*小时$/u.exec(value)
  if (hours !== null) return `${String(Number(hours[1]) * 60)} 分钟`
  const minutes = /^(\d+)\s*分钟$/u.exec(value)
  if (minutes !== null) return `${String(Number(minutes[1]) / 60)} 小时`
  return value
}

function hintOf(value: string): string {
  const compact = value.replace(/\s+/g, '')
  return compact.length <= 2 ? compact : compact.slice(0, 2)
}

function memoryIdOf(fact: Fact): string {
  return `mem:${fact.owner}:${fact.predicate}@${fact.value}@${fact.user}`
}

function buildCase(input: {
  readonly row: PlanRow
  readonly fact: Fact
  readonly split: 'dev' | 'val' | 'blind'
  readonly ordinal: number
}): CorpusCase | null {
  const { row, fact, split, ordinal } = input
  const memoryId = memoryIdOf(fact)
  const form = FORM_BY_KIND.get(row.kind)
  if (form === undefined) throw new Error(`未知 formKind：${row.kind}`)
  const template = form.templates[ordinal % form.templates.length] as string
  /*
   * ⚠️ 第二轮人审（Q011）：`mixedEntity` 的模板**预设取值里含英文或编号**，
   *    而 `device.primary` 池里也有「迷你主机」「工作站」这类**两者都没有**的值
   *    ⇒ 问句断言了一个材料不支持的事实（"模板与事实不匹配"）。
   * 处置：**模板的前提必须在材料上成立** —— 取值不含 ASCII 字母/数字时，
   *    换用**中性**问法（不声称任何该取值没有的性质）。
   */
  const ASCII_VALUE = /[A-Za-z0-9]/
  const templateForValue =
    row.kind === 'mixedEntity' && !ASCII_VALUE.test(fact.value) ? '我{t}具体是哪一个？' : template
  const request = templateForValue.replace(/\{t\}/g, fact.topic).replace(/\{hint\}/g, hintOf(fact.value))
  const retrieve = form.expectation === 'retrieve' || form.expectation === 'historical'
  const predecessor = NEEDS_PREDECESSOR.includes(row.kind) ? predecessorOf(fact) : null
  /*
   * ⚠️⚠️ **2026-09-29 修（`L-M95-33` bug②）**：需要前驱的形态（更正 / 摘要冲突 / 历史与当前）
   *    若**拿不到"与当前取值不同"的前驱** ⇒ **不产出该用例**（返回 `null`，调用方过滤掉）。
   *
   * 为什么必须跳过而不是将就：这三种形态的断言本体是"**期望与禁止必须是两条不同的记忆**"
   *   （`historyVsCurrent`：期望旧值、禁止新值被当成"你以前说的"）。
   *   前驱缺失时，旧代码会让 `relevantMemoryIds` 与 `forbiddenIds` **都等于 `[memoryId]`**
   *   ⇒ 同一条记忆**既必需又禁止** ⇒ **自相矛盾**，任何判定器都不可能满足
   *   ⇒ 实测后果：`m9.5:measurement:verify` 三个负控同时失败（`L-M95-32`）。
   * ⚠️ 跳过会让该形态的条数**少于计划**；这是**诚实的少**，不是"凑数产出矛盾用例"。
   */
  if (NEEDS_PREDECESSOR.includes(row.kind) && predecessor === null) return null

  /*
   * 期望与禁止必须**分开**表达（这是这几类用例的断言本体）：
   *   superseded / summaryConflict：期望**新值**，**禁止**旧值被当现状
   *   historyVsCurrent            ：期望**旧值**（历史意图），**禁止**新值被当成"你以前说的"
   *   unknown 类                  ：不给目标，也不给禁止 id —— 断言是"不得断言未获支持的事实"，
   *                                 由 `expectedUnknownOrClarify` + `acceptableAnswerPoints` 承载
   */
  const wantNew = row.kind === 'superseded' || row.kind === 'summaryConflict'
  const wantOld = row.kind === 'historyVsCurrent'
  const relevantIds = !retrieve
    ? []
    : wantOld && predecessor !== null
      ? [predecessor.memoryId]
      : [memoryId]
  const forbiddenIds = !retrieve
    ? []
    : wantNew && predecessor !== null
      ? [predecessor.memoryId]
      : wantOld
        ? [memoryId]
        : []

  /* 每个子层的生命周期设置（WP9 按它物化 fixture） */
  const lifecycleSetup: Record<FormKind, string> = {
    synonym: 'single_active', indirect: 'single_active', elliptical: 'single_active',
    boundedHint: 'single_active', mixedEntity: 'single_active',
    person: 'two_subjects_same_predicate', negation: 'single_active_plus_opposite_decoy',
    numberUnit: 'single_active', similarProject: 'two_similar_values',
    unitChange: 'single_active', historyVsCurrent: 'corrected_then_ask_history',
    neverSaved: 'decoys_only', forgotten: 'written_then_forgotten',
    chatOnly: 'chat_line_only_not_memory', ambiguousSubject: 'two_subjects_same_predicate',
    outOfCoverage: 'decoys_only', beyondScope: 'decoys_only',
    superseded: 'corrected_value_supersedes_old', wrongOwner: 'same_value_other_owner',
    brokenRoot: 'root_evidence_broken', rebuildRevival: 'rebuilt_after_drop',
    summaryConflict: 'summary_holds_old_value', sourceUnreadable: 'authority_query_fails',
  }

  return {
    caseId: `${split}-${row.stratum}-${row.kind}-${String(ordinal).padStart(4, '0')}`,
    familyId: fact.factId,
    split,
    stratum: row.stratum,
    formKind: row.kind,
    namespace: OWNER_MAIN,
    user: fact.user,
    request,
    intent: form.expectation === 'historical' ? 'historical_fact'
      : form.expectation === 'clarify' ? 'clarify'
      : form.expectation === 'unknown' ? 'current_fact'
      : 'current_fact',
    timeScope: form.expectation === 'historical' ? 'historical' : 'current',
    authoritativeSnapshot: {
      owner: OWNER_MAIN,
      subject: fact.user,
      predicate: fact.predicate,
      value: fact.value,
      status: retrieve ? 'active' : 'absent_or_not_usable',
      ...(predecessor !== null && (wantNew || wantOld) ? { previousValue: predecessor.value } : {}),
    },
    relevantMemoryIds: relevantIds,
    requiredEvidenceGroups: relevantIds.map((id) => [id]),
    forbiddenIds,
    expectedUnknownOrClarify: !retrieve,
    lifecycleSetup: lifecycleSetup[row.kind],
    /* 场景背景（独立字段；原话里不带测试意图） */
    scenarioNote: SCENARIO_NOTE[row.kind],
    /* 独立判断所需的证据（三类非空；其余为 {}） */
    sceneEvidence: sceneEvidenceFor({
      kind: row.kind,
      user: fact.user,
      predicate: fact.predicate,
      value: fact.value,
      /* 同 predicate 下的另一个取值（`ambiguousSubject` 用；取池里下一个，缺省复用自己） */
      alternateValue:
        (POOLS[fact.predicate] ?? []).find((candidate) => candidate !== fact.value) ?? fact.value,
    }),
    acceptableAnswerPoints: (() => {
      /*
       * ⚠️ **第四轮人审**（五条语义修正）：核心是**答案键与问句的边界** ——
       *   「有记录但来源不可核验」「从未正式保存」「单条记录不足以判断历史」都要**分开**说，
       *   不能一律落到"没有可支持的记录"（那会把**能答的**说成不能答，也会把**不能断言**的说成已断言）。
       */

      /* ⑤ Q018：`brokenRoot` **有**记录（投影行在），只是**来源断链、不可核验** */
      if (row.kind === 'brokenRoot') {
        return [
          `**有**这条记录（投影行仍在：${fact.predicate} = ${fact.value}）`,
          '但**来源断链、无法核验** ⇒ **不能据此确认**取值',
          '不得说成"没有记录" —— 那是**另一回事**（有记录 vs 无记录）',
        ]
      }

      /* ④ Q024：`neverSaved` = "长期记忆里没有" **不等于** "不能回答" */
      if (row.kind === 'neverSaved') {
        return [
          '可以说明**长期记忆里没有**这一条',
          '⚠️ 但**不等于**"不能回答"：若历史对话**仍在本轮可见上下文**里，她**仍可能有依据**回答',
          '应当明确**本轮历史内容是否可见**；不可见时如实说明不可见，而不是断言"你从未说过"',
        ]
      }

      if (!retrieve) {
        return form.expectation === 'clarify'
          ? [
              '应当**澄清**：问句的**主体不唯一**，需要先问清是谁',
              '不得**二选一猜一个**主体当作答案',
              '不得答成"没有相关的记录"——记录**存在**，只是不知道问的是哪一条',
            ]
          : ['如实说明没有可支持的记录', '不编造具体值', '不把未命中解释成"你从未说过"']
      }

      /* ① Q005：问的是"换个单位"，**没有**指定换成哪个 —— 任一正确换算都算对 */
      if (row.kind === 'unitChange') {
        return [
          '给出**任一正确**的等价换算（例：存储为 4 小时 ⇒ **240 分钟** 与 **14,400 秒** 都算对）',
          `可以附带原口径 ${fact.value}，但它**不能单独构成答案**`,
          '换算若与原口径**矛盾**则算错；**不得**限定成只接受某一种单位',
        ]
      }

      /* ③ Q017/Q021：`negation` 问了**两件事**，只答得出其中一件 —— 必须把另一件标为"无法确认" */
      if (row.kind === 'negation') {
        return [
          `先回答**当前记录**：${fact.predicate} = ${fact.value}`,
          '⚠️ 问句还问了"**是不是说过相反的**" —— **单条记录不足以确认**这一点',
          '无相反记录的证据时，应如实说**无法确认**，**不得**凭这一条断言"没有说过相反的话"',
        ]
      }

      if (wantOld && predecessor !== null) {
        return [`给出历史取值 ${fact.predicate} = ${predecessor.value}`, '明确这是**更正之前**的取值，不是现状']
      }
      if (wantNew && predecessor !== null) {
        return [`给出当前取值 ${fact.predicate} = ${fact.value}`, `不得把旧值 ${predecessor.value} 当作现状`]
      }
      return [`给出 ${fact.predicate} = ${fact.value}`, '保留"这是记忆里的当前值"这一边界']
    })(),
    modelInputRestrictions: [
      '查询文本不得包含 gold 标签（caseId / relevantMemoryIds）',
      '盲测集不得进入任何在线提示或开发集',
    ],
    annotator: 'synthetic-generator',
    adjudication: 'PENDING_HUMAN_REVIEW',
  }
}

// ---------------------------------------------------------------------------
// 机械关键负控（**与行为语料不混为同一分母**，≥200）
// ---------------------------------------------------------------------------

interface NegativeControl {
  readonly id: string
  readonly kind: string
  readonly setup: string
  readonly mustHold: string
  readonly injectedFailure: string | null
}

function buildNegativeControls(): NegativeControl[] {
  const controls: NegativeControl[] = []
  const reasons = [
    ['wrong_owner', '把另一 owner（C2）的记忆设为最高相似度', '该候选必须被资格拒，零跨域入模'],
    ['retracted', '把已撤回记忆设为最高相似度', '该候选必须被资格拒'],
    ['wrong_subject', '把同一 owner 下另一 subject 的记忆设为最高相似度', '受支持的隔离契约必须生效'],
  ] as const
  let index = 0
  for (const [kind, setup, mustHold] of reasons) {
    for (let i = 0; i < 40; i += 1) {
      index += 1
      controls.push({
        id: `NC-${String(index).padStart(3, '0')}`,
        kind,
        setup,
        mustHold,
        injectedFailure: null,
      })
    }
  }
  const faults = [
    ['invalid_vector:nan', '编码器返回含 NaN 的向量', 'D28：必须项目侧拒绝并具名分类'],
    ['invalid_vector:zero_norm', '编码器返回零范数向量', 'D28：数据库**会接受**它 ⇒ 必须项目侧拒绝'],
    ['invalid_vector:dimension', '编码器返回 383 维向量', 'D28：维度不符必须拒'],
    ['model_missing', '本地模型目录缺失', '如实降级为 degraded_lexical，不联网、不静默成功'],
    ['dimension_mismatch', '索引里混入另一维度的 generation', '拒绝混排并告警'],
    ['encode_timeout', '编码超过硬截止', '该轮语义降级并记录具名原因'],
    ['canceled_no_reclaim', '取消后底层仍继续占用 CPU', 'D27：必须判为失败（不可声称取消成功）'],
    ['generation_mismatch', '查询的 generation 与索引不匹配', '索引停用，不返回候选'],
    ['source_unavailable', '权威回查失败而向量缓存健康', '失败关闭，不用缓存事实顶替'],
    ['partial_coverage', '索引有缺口', '状态如实报 partial，不把未命中解释为不存在'],
  ] as const
  for (const [kind, setup, mustHold] of faults) {
    for (let i = 0; i < 8; i += 1) {
      index += 1
      controls.push({
        id: `NC-${String(index).padStart(3, '0')}`,
        kind,
        setup,
        mustHold,
        injectedFailure: kind,
      })
    }
  }
  return controls
}

// ---------------------------------------------------------------------------
// 种子：盲测用外部种子（本地、已 ignore）
// ---------------------------------------------------------------------------

function blindSeed(rebuild: boolean): { seed: number; created: boolean } {
  mkdirSync(dirname(SEED_PATH), { recursive: true })
  if (existsSync(SEED_PATH) && !rebuild) {
    const parsed = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as { blindSeed?: number }
    if (Number.isInteger(parsed.blindSeed)) {
      return { seed: parsed.blindSeed as number, created: false }
    }
  }
  const seed = randomBytes(4).readUInt32LE(0)
  writeFileSync(
    SEED_PATH,
    `${JSON.stringify({ blindSeed: seed, createdAt: new Date().toISOString(), why: 'M9.5 盲测集种子：不进仓库，公开仓库因此无法重算盲测集' }, null, 2)}\n`,
    'utf8'
  )
  return { seed, created: true }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function gitOrNull(args: readonly string[]): string | null {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function toJsonl(cases: readonly CorpusCase[]): string {
  return cases.map((item) => JSON.stringify(item)).join('\n') + (cases.length > 0 ? '\n' : '')
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const rebuild = process.argv.includes('--rebuild-seed')
  const supersedesIndex = process.argv.indexOf('--supersedes')
  const supersedes = supersedesIndex >= 0 ? (process.argv[supersedesIndex + 1] ?? null) : null
  const reasonIndex = process.argv.indexOf('--supersession-reason')
  const supersessionReason = reasonIndex >= 0 ? (process.argv[reasonIndex + 1] ?? null) : null
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: 'wp2-corpus', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)

  const blindSeedValue = (() => {
    const { seed, created } = blindSeed(rebuild)
    return { seed, created }
  })()
  const devAllocator = makeFactAllocator({
    publicSeed: 0x5eed_0001,
    secretSeed: blindSeedValue.seed,
    mode: 'dev-val',
  })
  const blindAllocator = {
    allocator: makeFactAllocator({
      publicSeed: 0x5eed_0002,
      secretSeed: blindSeedValue.seed,
      mode: 'blind',
    }),
    seed: blindSeedValue.seed,
    created: blindSeedValue.created,
  }

  const dev: CorpusCase[] = []
  const val: CorpusCase[] = []
  const blind: CorpusCase[] = []
  const deficits: string[] = []

  /*
   * **两趟分配**：先满足"限定 predicate"的行，再从全池取其余 ——
   * 否则不限定的行会把 `mixedEntity` / `negation` 需要的那几个槽位先吃掉。
   */
  const orderedRows = [...PLAN].sort(
    (a, b) => (a.predicates === undefined ? 1 : 0) - (b.predicates === undefined ? 1 : 0)
  )

  for (const row of orderedRows) {
    for (const split of ['dev', 'val', 'blind'] as const) {
      const count = row[split]
      const allocator = split === 'blind' ? blindAllocator.allocator : devAllocator
      for (let i = 0; i < count; i += 1) {
        const fact = allocator.take(row.predicates, row.valuePattern)
        if (fact === undefined) {
          deficits.push(`${row.stratum}/${row.kind}/${split} 第 ${String(i + 1)} 条：事实池耗尽`)
          continue
        }
        const item = buildCase({ row, fact, split, ordinal: i })
        /*
         * ⚠️ `buildCase` 在"需要前驱却拿不到**不同取值**的前驱"时返回 `null`（`L-M95-33` bug②）
         *    ⇒ **跳过并如实记账**（不产出矛盾用例；`deficits` 让"少了几条"可见）。
         */
        if (item === null) {
          deficits.push(`${row.stratum}/${row.kind}/${split} 第 ${String(i + 1)} 条：无可用前驱（取值与当前相同）⇒ 跳过`)
          continue
        }
        if (split === 'dev') dev.push(item)
        else if (split === 'val') val.push(item)
        else blind.push(item)
      }
    }
  }

  /* 事实唯一性：同一 fact group 绝不允许出现在两个 split（构造性保证 + 复核） */
  const seen = new Map<string, string>()
  const duplicates: string[] = []
  for (const item of [...dev, ...val, ...blind]) {
    const previous = seen.get(item.familyId)
    if (previous !== undefined) duplicates.push(`${item.familyId}（${previous} 与 ${item.caseId}）`)
    else seen.set(item.familyId, item.caseId)
  }

  const negatives = buildNegativeControls()

  const plannedByStratum = (stratum: Stratum): { dev: number; val: number; blind: number } => {
    const rows = PLAN.filter((row) => row.stratum === stratum)
    return {
      dev: rows.reduce((sum, row) => sum + row.dev, 0),
      val: rows.reduce((sum, row) => sum + row.val, 0),
      blind: rows.reduce((sum, row) => sum + row.blind, 0),
    }
  }

  const countByStratumAndSplit = (cases: readonly CorpusCase[]): Record<string, Record<string, number>> => {
    const out: Record<string, Record<string, number>> = {}
    for (const item of cases) {
      out[item.stratum] = out[item.stratum] ?? {}
      out[item.stratum][item.split] = (out[item.stratum][item.split] ?? 0) + 1
    }
    return out
  }

  const expectations = { dev: 240, val: 120, blind: 240 } as const
  const actual = { dev: dev.length, val: val.length, blind: blind.length }
  const planMatches =
    actual.dev === expectations.dev && actual.val === expectations.val && actual.blind === expectations.blind
  const stratumTotals = {
    normal: dev.filter((c) => c.stratum === 'normal').length + val.filter((c) => c.stratum === 'normal').length + blind.filter((c) => c.stratum === 'normal').length,
    hard: dev.filter((c) => c.stratum === 'hard').length + val.filter((c) => c.stratum === 'hard').length + blind.filter((c) => c.stratum === 'hard').length,
    unknown: dev.filter((c) => c.stratum === 'unknown').length + val.filter((c) => c.stratum === 'unknown').length + blind.filter((c) => c.stratum === 'unknown').length,
    lifecycle: dev.filter((c) => c.stratum === 'lifecycle').length + val.filter((c) => c.stratum === 'lifecycle').length + blind.filter((c) => c.stratum === 'lifecycle').length,
  }

  /* --- 落盘：dev/val 进仓库；blind 进 ignore 区 --- */
  mkdirSync(CORPUS_DIR, { recursive: true })
  mkdirSync(BLIND_DIR, { recursive: true })
  const devPath = join(CORPUS_DIR, 'dev.jsonl')
  const valPath = join(CORPUS_DIR, 'val.jsonl')
  const blindPath = join(BLIND_DIR, 'blind.jsonl')
  writeFileSync(devPath, toJsonl(dev), 'utf8')
  writeFileSync(valPath, toJsonl(val), 'utf8')
  writeFileSync(blindPath, toJsonl(blind), 'utf8')

  const hashOf = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
  const corpusHash = createHash('sha256')
    .update(hashOf(devPath))
    .update(hashOf(valPath))
    .update(hashOf(blindPath))
    .digest('hex')

  const manifest = {
    schemaVersion: CORPUS_VERSION,
    generatorVersion: GENERATOR_VERSION,
    createdAt: new Date().toISOString(),
    design: {
      total: 600,
      splits: { dev: 240, val: 120, blind: 240 },
      strata: { normal: 240, hard: 120, unknown: 120, lifecycle: 120 },
      mechanicalNegativeControls: negatives.length,
      leakageRule:
        '一个 fact group 恰好绑定一个问句 ⇒ 拆 split 的最小单位是 fact 本身 ⇒ 按构造不可能跨 split 泄漏（v1 选择）',
      factAxes: ['owner', 'user', 'predicate', 'value'],
      users: USERS,
      owners: { main: OWNER_MAIN, isolation: OWNER_OTHER },
      predicatesUsed: availablePredicates(),
      predicatesExcluded: EXCLUDED_PREDICATES,
      materializationNote:
        '语料里的是**规格**：WP9 必须经**确定性写入路径**物化（不得依赖规则抽取器把句子解析对）',
    },
    counts: {
      bySplit: actual,
      byStratum: stratumTotals,
      byStratumAndSplit: countByStratumAndSplit([...dev, ...val, ...blind]),
      negativeControls: negatives.length,
    },
    plannedByStratum: {
      normal: plannedByStratum('normal'),
      hard: plannedByStratum('hard'),
      unknown: plannedByStratum('unknown'),
      lifecycle: plannedByStratum('lifecycle'),
    },
    planMatches,
    deficits,
    duplicates,
    factPool: {
      poolSize: devAllocator.poolSize,
      blindPartitionSize: blindAllocator.allocator.partitionSize,
      devValPartitionSize: devAllocator.partitionSize,
      devValRemaining: devAllocator.remaining(),
      blindRemaining: blindAllocator.allocator.remaining(),
      definition: '(user × predicate × value) 的笛卡尔积，洗牌后按需取用；user 进池、不贴在遍历上',
      disjointness:
        '秘密种子洗一遍后**切分**：blind = 前 240，dev/val = 其余 ⇒ 两分区**不相交**（再由 familyId 唯一性复核）',
      reproducibility:
        '⚠️ dev/val 的成员也间接依赖秘密种子（它们是被盲测拿剩的那部分）' +
        '⇒ 可复核的是**内容与计数**（已提交 + sha256 钉住），不是"从公开种子重算一遍"',
    },
    artifacts: {
      dev: { path: 'evals/m9.5/corpus/dev.jsonl', sha256: hashOf(devPath), inRepo: true },
      val: { path: 'evals/m9.5/corpus/val.jsonl', sha256: hashOf(valPath), inRepo: true },
      blind: {
        path: 'artifacts/m9.5/local/corpus-blind/blind.jsonl',
        sha256: hashOf(blindPath),
        inRepo: false,
        why: '盲测集必须不可被调参窥视；仓库侧只留 sha256 与计数',
      },
      negativeControls: {
        path: 'evals/m9.5/corpus/negative-controls.jsonl',
        inRepo: true,
        why: '负控**不是**盲测内容，它测的是机械边界，公开不影响盲性',
      },
    },
    blindSeed: {
      storage: 'artifacts/m9.5/local/corpus-seed.json（已 ignore）',
      fingerprintSha256: sha256(String(blindAllocator.seed)),
      createdThisRun: blindAllocator.created,
      why: '公开仓库不含种子 ⇒ 无法重算盲测集；指纹用于钉住这一次的盲测身份',
    },
    corpusHash,
    fieldList: [
      'caseId', 'familyId', 'split', 'namespace', 'user', 'request', 'intent', 'timeScope',
      'authoritativeSnapshot', 'relevantMemoryIds', 'requiredEvidenceGroups', 'forbiddenIds',
      'expectedUnknownOrClarify', 'lifecycleSetup', 'acceptableAnswerPoints',
      'modelInputRestrictions', 'annotator', 'adjudication',
    ],
    annotatorNote:
      '`adjudication` 全为 PENDING_HUMAN_REVIEW：**合成语料也要人审**，' +
      '人审未完成前本语料不得用于结论（计划 §14.2 / §14.6）',
  }
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const negativesPath = join(CORPUS_DIR, 'negative-controls.jsonl')
  writeFileSync(
    negativesPath,
    negatives.map((item) => JSON.stringify(item)).join('\n') + '\n',
    'utf8'
  )

  /* --- 证据 --- */
  const measuredCount = dev.length + val.length + blind.length + negatives.length
  const failed =
    (planMatches ? 0 : 1) + (deficits.length > 0 ? 1 : 0) + (duplicates.length > 0 ? 1 : 0)
  const selfCheck = selfCheckMeasurement({ measuredCount, notRunCount: 0, failedCount: failed })
  const payload = { schemaVersion: 'm9.5-corpus@1', runId, generatedAt: new Date().toISOString(), supersedes, supersessionReason, manifest }
  const evidencePath = join(runDir, 'corpus.json')
  writeFileSync(evidencePath, `${JSON.stringify({ ...payload, measurement: { selfCheck, measuredCount, failed } }, null, 2)}\n`, 'utf8')

  const tree = sourceTreeReading(REPO_ROOT)
  const manifestPath = writeM95Manifest(runDir, {
    runId,
    stage: 'wp2',
    lane: 'offline',
    startedAt: STARTED_AT,
    completedAt: new Date().toISOString(),
    head: gitOrNull(['rev-parse', 'HEAD']),
    headShort,
    branch: gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyPaths: dirtyPaths(REPO_ROOT),
    sourceTreeHash: tree.treeSha256,
    sourceTreeHashDefinition: tree.definition,
    gateVersion: GATE_VERSION,
    dbKind: 'not-applicable',
    isolationProof: {
      dbTouched: false,
      method: '**构造属性**：本脚本不 import 任何数据库模块（仅谓词登记表 + 证据模块）',
    },
    configHash: { corpusVersion: CORPUS_VERSION, generatorVersion: GENERATOR_VERSION },
    command: [{ cmd: 'pnpm m9.5:corpus', exitCode: 0 }],
    exitCode: 0,
    completion: planMatches && deficits.length === 0 && duplicates.length === 0 ? 'complete' : 'partial',
    usable: selfCheck.verdict === 'PASS',
    measuredCount,
    notRunCount: 0,
    counts: { total: measuredCount, passed: measuredCount - failed, failed },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes,
    corpusHash,
    corpusVersion: CORPUS_VERSION,
    artifactHashes: { 'corpus.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 WP2 语料生成完成：${runId}`,
      `  清单：${MANIFEST_PATH}`,
      `  证据：${evidencePath}`,
      `  清单档：${manifestPath}`,
      `  拆分：dev=${String(actual.dev)} val=${String(actual.val)} blind=${String(actual.blind)}（计划 240/120/240）`,
      `  分层：normal=${String(stratumTotals.normal)} hard=${String(stratumTotals.hard)} unknown=${String(stratumTotals.unknown)} lifecycle=${String(stratumTotals.lifecycle)}`,
      `  机械负控：${String(negatives.length)}`,
      `  corpusHash：${corpusHash}`,
      `  盲测种子：${blindAllocator.created ? '本次新建' : '复用既有'}（指纹 ${sha256(String(blindAllocator.seed)).slice(0, 16)}…）`,
      `  事实池：dev/val 用池 ${String(devAllocator.poolSize)} 剩余 ${String(devAllocator.remaining())} · blind 用池 ${String(blindAllocator.allocator.poolSize)} 剩余 ${String(blindAllocator.allocator.remaining())}`,
      `  事实唯一性：${duplicates.length === 0 ? '全部唯一（无跨 split 泄漏）' : `⚠️ 重复 ${String(duplicates.length)} 条`}`,
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      deficits.length > 0 ? `  ⚠️ 缺口：${deficits.slice(0, 5).join(' / ')}` : '',
    ]
      .filter((line) => line !== '')
      .join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

await main()
