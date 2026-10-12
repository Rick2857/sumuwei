/**
 * 第二批验收的**组计划与共享床（Suite）**（第二批计划 §6A 的 28 组）。
 *
 * ```text
 * 公共 8 组 + 文件/任务 4 组 + 天气 4 组 + 办公 4 组 + 资讯 4 组 + 浏览器 4 组
 * ```
 *
 * ⚠️ 读数形状与断言器在 `reading.ts`（**值不在这里**：避免与各组运行器循环导入）。
 * ⚠️ 各组运行器在 `groups-*.ts`；本文件只在末尾**注册**它们。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../../src/dev/sandbox.ts'
import { createM4Harness, type M4Harness } from '../m4-harness.ts'
import { assertTurnContent } from '../../src/kernel/contracts/turn-content.ts'
import type { TurnContent } from '../../src/kernel/contracts/turn-content.ts'

import { createProductivityBed, type ProductivityBed } from './assembly.ts'
import { makeSynthTree, type SynthTree } from './fixtures.ts'
import { GroupRecorder, type GroupReading, type VerifyContext } from './reading.ts'
import { startFakeSidecar, type FakeSidecar } from './browser-fixture.ts'

export type Capability = 'common' | 'files' | 'weather' | 'office' | 'news' | 'browser'

export interface GroupPlan {
  readonly id: string
  readonly capability: Capability
  readonly title: string
  readonly basis: string
}

/**
 * **组计划** = 公共 8 + 文件/任务 4 + 天气 4 + 办公 4 + 资讯 4 + 浏览器 4（计划书 §6A 逐字）
 * **+ 2026-10-09 追加的 `browser-06`**（`L-PS-63`：浏览器会话失效的自愈与边界）⇒ 实际 **29** 组。
 * 追加的理由：那条缺陷是**真机事故**逼出来的（sidecar 重启后适配器缓存着已失效的会话
 * ⇒ 之后每一次浏览器调用都拿 404，用户只看到"她一直说访问不了"），它必须有一条
 * **离线可断言**的判据；追加**不回写**计划书 §6A 的 28 组，只是在本行注明偏差。
 */
export const GROUP_PLAN: readonly GroupPlan[] = [
  { id: 'common-01', capability: 'common', title: '默认关闭 / 授权', basis: '能力恒登记、权限按开关；关闭时的可审计 permission_denied' },
  { id: 'common-02', capability: 'common', title: '旧聊天与第一批兼容', basis: '旧沙箱读写仍只返回字节/指纹；第一批四项行为不变；两套措辞分叉' },
  { id: 'common-03', capability: 'common', title: '目标 / 路径域事实', basis: '全盘目标的证据与策略措辞**不得**说成"沙箱范围内"' },
  { id: 'common-04', capability: 'common', title: '正文 / token 隐私与来源资格', basis: '账本 / 事件 / 记忆 / trace 扫 sentinel；参数里只有引用与指纹' },
  { id: 'common-05', capability: 'common', title: '预算 / 实际入模', basis: '额度 0 ⇒ 不注入；>0 ⇒ 入模份数与 reality 一致' },
  { id: 'common-06', capability: 'common', title: '取消 / 迟到', basis: '任务关闭后不再执行；预算耗尽如实停止' },
  { id: 'common-07', capability: 'common', title: '任务归因 / 操作范围与风险', basis: '越权与白名单外参数被拒；R2 只在额度抬高时放行；同 trace' },
  { id: 'common-08', capability: 'common', title: '量具正控 / 负控 / 恢复与非空计数', basis: '三段式 × 2 例 + 计数型自检 + measured_count > 0' },
  { id: 'file-01', capability: 'files', title: '沙箱外中文 / 空格 / 多卷路径读取与正文入模', basis: '合成临时文件 + 真适配器；正文真的进 packet' },
  { id: 'file-02', capability: 'files', title: '自主选输入及创建 / 修改 / 覆盖', basis: '任务环：读输入 → 写产物 → 覆盖；文件与账本对照' },
  { id: 'file-03', capability: 'files', title: '恢复副本与并发修改冲突', basis: '覆盖前副本逐字节等于原文件；冲突时不写' },
  { id: 'file-04', capability: 'files', title: 'OS 访问失败 / 任务取消 / 无授权任务不写', basis: '失败如实；无权限 ⇒ 0 字节写入' },
  { id: 'weather-01', capability: 'weather', title: '已知城市及字段单位', basis: '独立期望值（夹具）+ 单位/时区/数据时间都在' },
  { id: 'weather-02', capability: 'weather', title: '同名候选 / 未知城市', basis: '歧义 ⇒ 澄清；0 候选 ⇒ not_found；都不取第一条' },
  { id: 'weather-03', capability: 'weather', title: '时区 / 有效时间 / 旧数据', basis: 'facts 里必须有预报有效时间与获取时间' },
  { id: 'weather-04', capability: 'weather', title: '限流、坏响应和超时', basis: 'timeout / http_error / bad_body 三档各自如实' },
  { id: 'office-01', capability: 'office', title: 'DOCX 读回', basis: '真 Python 生成 + 重新打开；期望文本全在' },
  { id: 'office-02', capability: 'office', title: 'XLSX 读回与数值 / 公式类型', basis: '以 = 开头的文字**不是**公式；明确类型的公式才是' },
  { id: 'office-03', capability: 'office', title: 'PPTX 读回与固定版式范围', basis: '页数/表格/图表读回；超限拒收' },
  { id: 'office-04', capability: 'office', title: '超限 / 生成失败 / 覆盖冲突时原文件保留', basis: '失败后目标文件的指纹逐字节未变' },
  { id: 'news-01', capability: 'news', title: 'RSS / Atom 正常条目', basis: '夹具 feed + 独立期望值（标题/链接/摘要标记）' },
  { id: 'news-02', capability: 'news', title: '时间过滤 / 去重 / 未知日期', basis: '同链接去重；未知发布时间**不**按抓取时间补' },
  { id: 'news-03', capability: 'news', title: '按需深读及摘要 / 全文区分', basis: '条目只带摘要；深读交 web.read（能力边界）' },
  { id: 'news-04', capability: 'news', title: '坏 XML / 实体声明 / 网络边界与失败', basis: 'DTD 与实体在解析前拒；非 XML 类型拒；获取失败如实' },
  { id: 'browser-01', capability: 'browser', title: '已绑定会话 / 任务标签范围', basis: '受控假 sidecar：会话建立、快照来自绑定标签' },
  { id: 'browser-02', capability: 'browser', title: '确定元素点击 / 填写及页面读回', basis: 'ref 定位 → 操作 → 页面读回；过期 ref 如实失败' },
  { id: 'browser-03', capability: 'browser', title: '默认禁用工具 / 超范围导航 / 断连', basis: '白名单外工具**零请求**；断连如实失败' },
  { id: 'browser-04', capability: 'browser', title: '登录态继承与焦点 / 窗口影响', basis: '真实已登录 profile + 桌面焦点读数（**需人工首连**）' },
  /*
   * ★ 2026-10-09：这两个组**差点白写** —— 运行器都加了（`BROWSER_GROUPS`），但**本计划表漏登记**，
   *   而跑批是按本表驱动 ⇒ 它们一次都没跑过（读数会显示"28 组"，而 `RUNNERS` 已有 30 个）。
   *   ⚠️ 教训：**加组 = 加运行器 + 加本表两处**；只加一处会得到一个"看起来配置好了但从不执行"的组。
   */
  { id: 'browser-05', capability: 'browser', title: '全工具档（任意工具入口）的正负控', basis: 'browser.mcp 可达 evaluate / cookie_list；R2 额度被拒；开关关着连提出都不成立；坏名字与坏参 ⇒ 零出站' },
  { id: 'browser-06', capability: 'browser', title: '浏览器会话失效的自愈与边界', basis: '会话失效（上游 404）⇒ 重建一次并重试成功 + 程序附注如实；非会话类失败不重建；连续失效只重建一次' },
]

/** `--live` 的八个固定场景（计划书 §6C 逐字） */
export interface LiveScenario {
  readonly id: string
  readonly capability: Exclude<Capability, 'common'>
  readonly kind: 'success' | 'degrade'
  readonly title: string
}

export const LIVE_PLAN: readonly LiveScenario[] = [
  { id: 'live-weather-success', capability: 'weather', kind: 'success', title: '指定城市、固定日期范围、真实天气 API；单位/时间与结果一致' },
  { id: 'live-weather-degrade', capability: 'weather', kind: 'degrade', title: '同名目标或失败响应；不猜城市、不编数值' },
  { id: 'live-file-office-success', capability: 'files', kind: 'success', title: '一个用户目标；自主读输入、生成三格式并覆盖一个合成文件' },
  { id: 'live-file-office-degrade', capability: 'files', kind: 'degrade', title: '目标不可写或并发冲突；原文件保留，不声称已保存' },
  { id: 'live-news-success', capability: 'news', kind: 'success', title: '固定真实源，概览 + 一条深读；发布时间/来源/范围正确' },
  { id: 'live-news-degrade', capability: 'news', kind: 'degrade', title: '坏源/无正文；不给假全文结论' },
  { id: 'live-browser-success', capability: 'browser', kind: 'success', title: '已授权 profile 中真实已登录任务页，元素读取/填写并读回' },
  { id: 'live-browser-degrade', capability: 'browser', kind: 'degrade', title: '扩展断连、过期元素或未绑定标签；如实失败' },
]

/** 路径常量（与 `office-generate.ts` 同源） */
export const PYTHON_PATH = resolve(
  'artifacts/post-lv2/local/utility-skills-preparation/python/venv/Scripts/python.exe'
)
export const GENERATOR_PATH = resolve('scripts/productivity-skills/office-generate.py')

export interface BedEntry {
  readonly bed: ProductivityBed
  readonly tree: SynthTree
  readonly dir: string
}

export class Suite {
  readonly ctx: VerifyContext
  private readonly beds: BedEntry[] = []
  private readonly roots: string[] = []
  private bedCounter = 0
  private sidecar?: FakeSidecar

  constructor(ctx: VerifyContext) {
    this.ctx = ctx
  }

  pythonAvailable(): boolean {
    return existsSync(PYTHON_PATH) && existsSync(GENERATOR_PATH)
  }

  async openBed(label: string): Promise<BedEntry> {
    const previous = this.beds[this.beds.length - 1]
    if (previous !== undefined) await previous.bed.dispose()
    await resetPluginSqlConnection()
    const dir = join(this.ctx.localDir, 'sandbox', `${label}-${String(++this.bedCounter)}`)
    mkdirSync(dir, { recursive: true })
    this.roots.push(dir)
    /*
     * ⚠️ 合成文件树放在 **%TEMP%** 下（**沙箱外**）：它证明全盘路径域真的生效。
     *    放在工作目录里会让断言退化成"沙箱其实也在里面"。
     * ⚠️ 它**只**写新建的合成文件：**不碰任何真实私人文件**（计划书 §6A 末段）。
     */
    const workRoot = join(tmpdir(), `lg-productivity-${label}-${String(this.bedCounter)}`)
    const secondaryRoot = join(
      tmpdir(),
      `lg-productivity-${label}-${String(this.bedCounter)}-volume2`
    )
    const tree = makeSynthTree(workRoot, secondaryRoot)
    this.roots.push(workRoot, secondaryRoot)

    const recoveryRoot = join(dir, 'recovery')
    mkdirSync(recoveryRoot, { recursive: true })
    const isolated = isolateDatabase(`productivity-${label}-${this.bedCounter}`, { keep: true })
    this.roots.push(isolated.dir)
    const harness: M4Harness = await createM4Harness({
      label: `productivity-${label}-${this.bedCounter}`,
    })
    const bed = createProductivityBed({
      harness,
      label,
      sandboxRoot: join(dir, 'action-sandbox'),
      recoveryRoot,
    })
    const entry: BedEntry = { bed, tree, dir }
    this.beds.push(entry)
    this.ctx.log(
      `[productivity:verify]   · 床（可独立复核）dir=${dir} · db=${isolated.dir} · 合成树=${workRoot}`
    )
    return entry
  }

  async openSidecar(): Promise<FakeSidecar> {
    if (this.sidecar === undefined) this.sidecar = await startFakeSidecar()
    return this.sidecar
  }

  checkTurnContent(rec: GroupRecorder, item: TurnContent | undefined, label: string): void {
    if (item === undefined) {
      rec.check(`${label}：这一轮确实产出了当轮内容`, false, '没有 TurnContent')
      return
    }
    let problem = ''
    try {
      assertTurnContent(item)
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error)
    }
    rec.check(`${label}：契约断言通过（scope 恒等式 / 指纹 / 类型）`, problem === '', problem || '通过')
  }

  async dispose(): Promise<void> {
    for (const entry of this.beds) {
      try {
        await entry.bed.dispose()
      } catch {
        /* 收尾失败不影响读数 */
      }
    }
    if (this.sidecar !== undefined) await this.sidecar.close()
    for (const root of this.roots) {
      try {
        cleanupSandbox(root)
      } catch {
        /* 同上 */
      }
    }
  }
}

export interface GroupRunner {
  readonly id: string
  run(ctx: VerifyContext, suite: Suite): Promise<GroupReading>
}

// ---------------------------------------------------------------------------
// 小工具（各组共用）
// ---------------------------------------------------------------------------

export function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function fileStat(path: string): { size: number } | undefined {
  try {
    const info = statSync(path)
    return { size: info.size }
  } catch {
    return undefined
  }
}

export { writeFileSync }

// ---------------------------------------------------------------------------
// 出站夹具（天气 fetch / 资讯 fetcher）
// ---------------------------------------------------------------------------

export type WeatherFetchMode = 'ok' | 'timeout' | 'rateLimited' | 'badjson'

/**
 * 天气出站的**夹具 fetch**。
 *
 * ⚠️ `timeout` 那一档**必须理会调用方的 AbortSignal**：适配器的硬超时靠它取消，
 *    一个"永不 settle 且不看 signal"的假 fetch 会让整轮验收**挂死** ——
 *    那不是"测到超时"，那是量具自己卡住。
 */
export function fixtureWeatherFetch(
  fixture: { geocoding: unknown; forecast: unknown },
  mode: WeatherFetchMode = 'ok',
  endpoints: { geocoding: string; forecast: string } = {
    geocoding: 'https://geocoding-api.open-meteo.com/v1/search',
    forecast: 'https://api.open-meteo.com/v1/forecast',
  }
): typeof fetch {
  return (async (
    input: string | URL | Request,
    init?: { signal?: AbortSignal | null }
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (mode === 'timeout') {
      return await new Promise<Response>((_resolve, reject) => {
        const fail = (): void => reject(new DOMException('aborted', 'AbortError'))
        if (init?.signal?.aborted === true) fail()
        else init?.signal?.addEventListener('abort', fail, { once: true })
      })
    }
    if (!url.startsWith(endpoints.geocoding) && !url.startsWith(endpoints.forecast)) {
      return new Response('not found', { status: 404 })
    }
    if (mode === 'rateLimited') return new Response('rate limited', { status: 429 })
    const body = url.startsWith(endpoints.geocoding) ? fixture.geocoding : fixture.forecast
    if (mode === 'badjson') return new Response('<html>not json</html>', { status: 200 })
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
}

export interface NewsFixtureFeed {
  readonly url: string
  readonly contentType?: string
  readonly body?: string
  /** 直接让获取抛错（模拟网络失败） */
  readonly throwError?: string
}

export interface NewsFetchResult {
  bytes: Buffer
  finalUrl: string
  finalHost: string
  hops: readonly { url: string; host: string; address: string; servername: string; status: number }[]
  status: number
  contentType?: string
}

/**
 * 资讯出站的**夹具 fetcher**。
 *
 * ⚠️ 它替换的是**IO**，不是准入与上限：`news.read` 仍然先跑
 *    `admitWebReadUrl()`（HTTPS / 端口 / 地址分类），非 HTTPS 的源照样被拒。
 */
export function fixtureNewsFetcher(
  feeds: readonly NewsFixtureFeed[],
  options: { onRequest?: (url: string) => void } = {}
): (request: { url: string; deadlineAt: number; maxBytes: number }) => Promise<NewsFetchResult> {
  return async (request) => {
    options.onRequest?.(request.url)
    const feed = feeds.find((item) => item.url === request.url)
    if (feed === undefined) throw new Error(`夹具没有这个源：${request.url}`)
    if (feed.throwError !== undefined) throw new Error(feed.throwError)
    const body = feed.body ?? ''
    const host = new URL(request.url).hostname
    return {
      bytes: Buffer.from(body, 'utf8'),
      finalUrl: request.url,
      finalHost: host,
      hops: [{ url: request.url, host, address: '203.0.113.7', servername: host, status: 200 }],
      status: 200,
      ...(feed.contentType !== undefined ? { contentType: feed.contentType } : {}),
    }
  }
}

// ---------------------------------------------------------------------------
// 注册（**最后**：值级依赖因此在求值期已经就位）
// ---------------------------------------------------------------------------

import { COMMON_GROUPS } from './groups-common.ts'
import { FILE_GROUPS } from './groups-files.ts'
import { WEATHER_GROUPS } from './groups-weather.ts'
import { OFFICE_GROUPS } from './groups-office.ts'
import { NEWS_GROUPS } from './groups-news.ts'
import { BROWSER_GROUPS } from './groups-browser.ts'

export const RUNNERS: readonly GroupRunner[] = [
  ...COMMON_GROUPS,
  ...FILE_GROUPS,
  ...WEATHER_GROUPS,
  ...OFFICE_GROUPS,
  ...NEWS_GROUPS,
  ...BROWSER_GROUPS,
]
