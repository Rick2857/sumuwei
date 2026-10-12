/**
 * fixtures —— 第二批验收的**合成输入**（第二批计划 §6A 末段）。
 *
 * ============================================================================
 *  三条纪律
 * ============================================================================
 * ```text
 * ① 文件写入测试只用**沙箱外的合成临时文件**证明全盘路径域生效，
 *    **不修改真实私人文件**（计划书 §6A 末段逐字）
 * ② 出站（天气 / 资讯）用**夹具响应**：本机没有直连出站，只有 HTTP 代理，
 *    而"固定地址连接"与代理本质冲突（第一批已登记为 L-US-11）
 * ③ 浏览器用**受控的假 sidecar**（真 MCP JSON-RPC 的最小实现），
 *    已登录真实会话那一条**在 C 集里验证**，这里不替代它
 * ```
 *
 * ⚠️ 每个 fixture 的**期望值独立撰写**（不是从被测实现里读出来的）——
 *    否则"量具自己没被验证"（AGENTS.md §6.2）。
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface SynthFile {
  readonly name: string
  readonly text: string
  /** 期望值（**独立撰写**：由 fixture 定义，不从被测实现读） */
  readonly expectedContains: readonly string[]
}

/** 合成文本文件（中文 / 空格 / 多卷） */
export const SYNTH_TEXT_FILES: readonly SynthFile[] = [
  {
    name: 'notes-cn.txt',
    text: [
      '静水压力测量笔记',
      '代号 LG-4096',
      '水温 21.5 摄氏度，静水压力 7.25 kPa。',
      '第三行有一个只有这一份文件才有的标记：青鳉三号。',
    ].join('\n'),
    expectedContains: ['LG-4096', '7.25', '青鳉三号'],
  },
  {
    name: 'a b c.md',
    text: ['# 带空格的路径', '', '这一份文件的名字里有空格。', '标记：空格路径可达。'].join('\n'),
    expectedContains: ['空格路径可达'],
  },
  {
    name: 'data.csv',
    text: ['项目,数值', '温度,21.5', '电压,3.3'].join('\n'),
    expectedContains: ['温度,21.5'],
  },
  {
    name: 'config.json',
    text: JSON.stringify({ project: 'project-LG', marker: 'JSON-标记-77' }, null, 2),
    expectedContains: ['JSON-标记-77'],
  },
]

/** 一个**二进制**文件（.txt 扩展名但内容是 PNG 头） —— 用来证明"判据是字节不是扩展名" */
export const BINARY_DISGUISED = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02])

// ---------------------------------------------------------------------------
// 天气夹具
// ---------------------------------------------------------------------------

export interface WeatherFixture {
  /** 城市名 → 地理编码响应 */
  readonly geocoding: Record<string, unknown>
  readonly forecast: Record<string, unknown>
}

/** 唯一候选城市（"西安"） */
export const WEATHER_UNIQUE: WeatherFixture = {
  geocoding: {
    results: [
      {
        name: '西安',
        latitude: 34.3416,
        longitude: 108.9398,
        country: '中国',
        admin1: '陕西省',
        timezone: 'Asia/Shanghai',
      },
    ],
  },
  forecast: {
    timezone: 'Asia/Shanghai',
    utc_offset_seconds: 28800,
    current: {
      time: '2026-10-04T15:00',
      temperature_2m: 18.4,
      apparent_temperature: 17.1,
      precipitation: 0,
      wind_speed_10m: 6.2,
      weather_code: 3,
    },
    current_units: {
      temperature_2m: '°C',
      apparent_temperature: '°C',
      precipitation: 'mm',
      wind_speed_10m: 'km/h',
    },
    daily: {
      time: ['2026-10-04', '2026-10-05', '2026-10-06'],
      temperature_2m_max: [22.1, 20.4, 19.8],
      temperature_2m_min: [12.3, 11.1, 10.5],
      precipitation_sum: [0, 1.2, 0],
      weather_code: [3, 61, 2],
    },
    daily_units: { temperature_2m_max: '°C', temperature_2m_min: '°C', precipitation_sum: 'mm' },
  },
}

/** 同名候选（"朝阳"）—— 两个都叫朝阳，行政区分属北京与辽宁 */
export const WEATHER_AMBIGUOUS: WeatherFixture = {
  ...WEATHER_UNIQUE,
  geocoding: {
    results: [
      { name: '朝阳', latitude: 39.92, longitude: 116.44, country: '中国', admin1: '北京市', timezone: 'Asia/Shanghai' },
      { name: '朝阳', latitude: 41.57, longitude: 120.45, country: '中国', admin1: '辽宁省', timezone: 'Asia/Shanghai' },
    ],
  },
}

/** 收窄到唯一（用户给了省份） */
export const WEATHER_NARROWED: WeatherFixture = WEATHER_AMBIGUOUS

/** 空结果（没找到地名） */
export const WEATHER_NOT_FOUND: WeatherFixture = { ...WEATHER_UNIQUE, geocoding: { results: [] } }

// ---------------------------------------------------------------------------
// 资讯夹具（RSS 2.0 / Atom）
// ---------------------------------------------------------------------------

function rssDate(iso: string): string {
  return new Date(iso).toUTCString()
}

export const RSS_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>夹具科技日报</title>
    <link>https://news.example.com/</link>
    <description>验收用订阅源</description>
    <item>
      <title>第一条：模型推理成本下降</title>
      <link>https://news.example.com/a1</link>
      <pubDate>${rssDate('2026-10-04T08:00:00Z')}</pubDate>
      <description>摘要：推理成本较上月下降 12%。标记 ALPHA-1。</description>
    </item>
    <item>
      <title>第二条：本地部署成为主流</title>
      <link>https://news.example.com/a2</link>
      <pubDate>${rssDate('2026-10-03T09:30:00Z')}</pubDate>
      <description>摘要：本地部署占比升至 41%。标记 BETA-2。</description>
    </item>
    <item>
      <title>第三条：没有发布时间的条目</title>
      <link>https://news.example.com/a3</link>
      <description>摘要：这一条订阅源没有给出发布时间。标记 GAMMA-3。</description>
    </item>
    <item>
      <title>第一条：模型推理成本下降（转载）</title>
      <link>https://news.example.com/a1</link>
      <pubDate>${rssDate('2026-10-04T08:00:00Z')}</pubDate>
      <description>摘要：同链接的转载，应被去重。标记 DUPLICATE-4。</description>
    </item>
  </channel>
</rss>`

export const ATOM_FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>夹具 Atom 源</title>
  <updated>2026-10-04T10:00:00Z</updated>
  <entry>
    <title>Atom 第一条</title>
    <link href="https://news.example.com/atom-1"/>
    <updated>2026-10-04T07:00:00Z</updated>
    <summary>Atom 摘要，标记 ATOM-1。</summary>
  </entry>
</feed>`

/** 带 DTD 与实体声明的坏源（**必须被拒**） */
export const RSS_WITH_DTD = `<?xml version="1.0"?>
<!DOCTYPE rss [ <!ENTITY xxe SYSTEM "file:///C:/Windows/win.ini"> ]>
<rss version="2.0"><channel><title>坏源</title>
<item><title>&xxe;</title><link>https://news.example.com/evil</link></item>
</channel></rss>`

/** 结构性坏掉的 XML */
export const RSS_BROKEN = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>坏源</title>
<item><title>没有闭合的标签<link>https://news.example.com/broken</item>
</channel>`

// ---------------------------------------------------------------------------
// 办公生成夹具（**受限结构化规格**）
// ---------------------------------------------------------------------------

export const DOCX_SPEC = {
  title: '静水压力测量报告',
  subtitle: 'project-LG · 2026-10-04',
  header: 'LG 内部报告',
  footer: '第 1 页',
  blocks: [
    { type: 'heading', level: 1, text: '一、目的' },
    { type: 'paragraph', text: '本报告记录静水压力测量的复核结果，标记 DOCX-KEY-1。' },
    { type: 'bullets', items: ['水温 21.5 摄氏度', '静水压力 7.25 kPa'] },
    {
      type: 'table',
      header: ['项目', '数值'],
      rows: [
        ['温度', '21.5'],
        ['压力', '7.25'],
      ],
    },
  ],
}

export const XLSX_SPEC = {
  sheets: [
    {
      name: '汇总',
      columns: ['项目', '数值'],
      rows: [
        ['温度', 21.5],
        ['压力', 7.25],
        ['以等号开头的文字', '=SUM(A1:A2)'],
        ['明确类型的公式', { f: '=SUM(B2:B3)' }],
      ],
      totals: [{ column: 2, label: '合计' }],
    },
    {
      name: '明细',
      columns: ['时间', '读数'],
      rows: [
        ['2026-10-04T08:00', 7.25],
        ['2026-10-04T09:00', 7.31],
      ],
    },
  ],
}

export const PPTX_SPEC = {
  title: '静水压力复核',
  subtitle: 'PPTX-KEY-1',
  slides: [
    { title: '背景', bullets: ['测量点 3 个', '复核周期 2 周'] },
    {
      title: '数据表',
      table: {
        header: ['点位', '压力'],
        rows: [
          ['A', '7.25'],
          ['B', '7.31'],
        ],
      },
    },
    {
      title: '趋势',
      chart: {
        kind: 'bar',
        categories: ['A', 'B', 'C'],
        series: [{ name: '压力', values: [7.25, 7.31, 7.28] }],
      },
    },
  ],
}

/** 超限规格（PPT 21 页 > 20 上限） */
export const PPTX_SPEC_OVER_LIMIT = {
  title: '超限',
  slides: Array.from({ length: 21 }, (_item, index) => ({
    title: `第 ${String(index + 1)} 页`,
    bullets: ['内容'],
  })),
}

/** 未知块类型（**必须被拒收整条**） */
export const DOCX_SPEC_UNKNOWN_BLOCK = {
  title: '坏规格',
  blocks: [{ type: 'shell', command: 'whoami' }],
}

// ---------------------------------------------------------------------------
// 目录与写入
// ---------------------------------------------------------------------------

export interface SynthTree {
  readonly root: string
  /** 沙箱外的一个**多卷**位置（第二个盘符若存在，否则同卷的另一个根目录） */
  readonly secondaryRoot: string
  readonly files: readonly string[]
}

/**
 * 在 `workRoot` 下造一个**沙箱外**的合成文件树。
 *
 * ⚠️ 它**只**写 `workRoot` 里新建的合成文件：**不碰任何真实私人文件**
 *    （计划书 §6A："不修改真实私人文件来做覆盖试验"）。
 */
export function makeSynthTree(workRoot: string, secondaryRoot: string): SynthTree {
  mkdirSync(workRoot, { recursive: true })
  mkdirSync(secondaryRoot, { recursive: true })
  const files: string[] = []
  for (const file of SYNTH_TEXT_FILES) {
    const path = join(workRoot, file.name)
    writeFileSync(path, file.text, 'utf8')
    // 第二份放到"另一个卷/根"里，用于多卷路径那一条
    const mirror = join(secondaryRoot, file.name)
    writeFileSync(mirror, file.text, 'utf8')
    files.push(path, mirror)
  }
  writeFileSync(join(workRoot, 'disguised.txt'), BINARY_DISGUISED)
  writeFileSync(join(workRoot, 'empty.txt'), '')
  return { root: workRoot, secondaryRoot, files }
}

export function cleanupTree(root: string): void {
  if (!existsSync(root)) return
  rmSync(root, { recursive: true, force: true })
}

/** fixture 的期望值（**独立撰写**）：按名字查 */
export function expectedOf(name: string): readonly string[] {
  const found = SYNTH_TEXT_FILES.find((file) => file.name === name)
  return found?.expectedContains ?? []
}
