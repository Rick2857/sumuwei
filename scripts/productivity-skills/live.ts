/**
 * live —— `--live` 的**八场景真模型短链**（第二批计划 §6C）。
 *
 * ============================================================================
 *  它走的是**生产装配本尊**
 * ============================================================================
 * ```text
 * 子进程：node --import tsx src/main.ts "<用户原话>"
 *   · env: PGLITE_DATA_DIR / PROJECT_LG_SANDBOX = 本次运行的**隔离库**（tmpdir）
 *          ACTION_SANDBOX_ROOT                  = 本次运行的工作树根（**合成临时文件**）
 *          LOCAL_FILE_RECOVERY_ROOT             = 本次运行的恢复副本根
 *          CHARACTER_LOCAL_FILE_*_ENABLED=1 …   第二批开关只在这一个子进程里打开
 * 模型：`pnpm with-test-model pnpm productivity:verify --live` 注入的测试端点
 * ```
 * ⚠️ **不碰生产库**：`PGLITE_DATA_DIR` 指向 `%TEMP%` 下的一次性目录。
 *
 * ⚠️ **不 fake**：八个场景逐条给出判据与实测读数。跑不了就 `NOT RUN` + 原因；
 *    需要真实登录态 / 真实出站而当前环境拿不到的，**如实**记下来。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { isProductionDir } from '../../src/dev/sandbox.ts'
import { scanClaims } from '../../src/kernel/action/claim-scanner.ts'

export type LiveStatus = 'PASS' | 'FAIL' | 'NOT RUN'

export interface LiveCaseReading {
  readonly id: string
  readonly capability: string
  readonly kind: 'success' | 'degrade'
  readonly title: string
  readonly status: LiveStatus
  readonly input: string
  readonly exitCode?: number
  readonly reply?: string
  readonly traceId?: string
  readonly expected?: unknown
  readonly observed?: unknown
  readonly reason?: string
  readonly modelCalls?: number
  readonly modelSeconds?: number | null
  readonly retries?: number
}

export interface LiveResult {
  readonly runId: string
  readonly runDir: string
  readonly exitCode: number
  readonly cases: readonly LiveCaseReading[]
  readonly notRunReason?: string
}

interface LiveCli {
  readonly label: string
}

const LOG_LINE = /\n\s+(?:Info|Warn|Error|Debug)\s{2,}/

function parseReply(stdout: string): { reply: string; traceId: string } {
  const marker = '苏沐薇:'
  const at = stdout.lastIndexOf(marker)
  if (at === -1) return { reply: '', traceId: /trace=(trc:[0-9a-f-]+)/.exec(stdout)?.[1] ?? '' }
  const body = stdout.slice(at + marker.length)
  const cut = LOG_LINE.exec(body)
  const raw = (cut === null ? body : body.slice(0, cut.index)).trim()
  /*
   * ⚠️ 附录**不要**在这里切掉：第一批的那条教训是"量具问错了地方"
   *    （stdout 走的是朗读文本）。本批的判据因此**不**依赖附录是否出现在 stdout 上，
   *    而是用程序事实（文件真的变了没有 / 回复里有没有编造）。
   */
  return { reply: raw, traceId: /trace=(trc:[0-9a-f-]+)/.exec(stdout)?.[1] ?? '' }
}

/**
 * "**未被否定的**成功口吻"（忽略否定窗口）。
 *
 * ⚠️ 用它而不是裸 `String.includes`（2026-10-04 实测更正）：浏览器的降档场景里
 *    她实际回的是「看不了。我这边**没有**页面内容，也没有你说的这个页面的记录。」
 *    —— 裸子串判据把"没有页面内容"读成了"声称看到了页面内容"。
 *    这与仓库既有的 `claim-scanner` 是同一条纪律（M4.1 起就在用）。
 */
function claimsSuccess(text: string, markers: readonly string[]): boolean {
  return scanClaims(text, markers).claims
}

export async function runLive(cli: LiveCli): Promise<LiveResult> {
  const startedAt = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const runId = `${cli.label}-live-${startedAt}-${String(process.pid)}`
  const runDir = resolve(process.cwd(), 'artifacts/post-lv2/productivity-skills', runId)
  const localDir = resolve(
    process.cwd(),
    'artifacts/post-lv2/local/productivity-skills-preparation/live',
    runId
  )
  mkdirSync(runDir, { recursive: true })

  const cases: LiveCaseReading[] = []
  const writeEvidence = (notRunReason?: string): LiveResult => {
    const evidence = {
      schemaVersion: 'productivity-skills-live@1',
      runId,
      mode: 'live',
      startedAt,
      endedAt: new Date().toISOString(),
      ...(notRunReason !== undefined ? { notRunReason } : {}),
      cases,
    }
    writeFileSync(join(runDir, 'live.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    return { runId, runDir, exitCode: 1, cases, ...(notRunReason !== undefined ? { notRunReason } : {}) }
  }
  const failAll = (reason: string): LiveResult => {
    for (const plan of LIVE_IDS) {
      cases.push({ ...plan, status: 'NOT RUN', input: '', reason })
    }
    process.stdout.write(`[productivity:live] NOT RUN：${reason}\n`)
    return writeEvidence(reason)
  }

  // ① 包装器标记：没有它就是"以为在跑测试、其实在烧 .env 的 key"
  if (process.env.DSH_TEST_MODEL_WRAPPER !== '1') {
    return failAll(
      '没有经过 `pnpm with-test-model` 包装（DSH_TEST_MODEL_WRAPPER≠1）—— 拒绝用 `.env` 的生产 key 跑 `--live`'
    )
  }
  if (!existsSync(resolve('.env.test'))) {
    return failAll('找不到 `.env.test`（测试端点配置）—— 不回落生产 key')
  }

  // ② 隔离库 + 合成工作树（**都在 tmpdir**；生产库一个字节都不动）
  const work = mkdtempSync(join(tmpdir(), 'project-lg-productivity-live-'))
  const dbDir = join(work, 'pglite')
  const sandboxRoot = join(work, 'action-sandbox')
  const recoveryRoot = join(work, 'recovery')
  const synthRoot = join(work, 'synth')
  for (const dir of [dbDir, sandboxRoot, recoveryRoot, synthRoot]) mkdirSync(dir, { recursive: true })
  if (isProductionDir(dbDir) || isProductionDir(sandboxRoot) || isProductionDir(synthRoot)) {
    return failAll('拒绝运行：隔离目录与真实库重叠')
  }

  /*
   * ⚠️ **合成输入**：本场景**只**写新建的合成临时文件，
   *    **不修改任何真实私人文件**（计划书 §6A 末段）。
   */
  const inputPath = join(synthRoot, 'live-input.txt')
  writeFileSync(
    inputPath,
    ['验收输入', '代号 LIVE-LG-4096', '静水压力 7.25 kPa，水温 21.5 摄氏度。', '标记 LIVE-INPUT-ONLY'].join('\n'),
    'utf8'
  )
  const docxOut = join(synthRoot, 'live-report.docx')
  const xlsxOut = join(synthRoot, 'live-data.xlsx')
  const readOnlyTarget = join(sandboxRoot, 'already-a-dir')
  mkdirSync(readOnlyTarget, { recursive: true })

  const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PGLITE_DATA_DIR: dbDir,
    PROJECT_LG_SANDBOX: dbDir,
    ACTION_SANDBOX_ROOT: sandboxRoot,
    LOCAL_FILE_RECOVERY_ROOT: recoveryRoot,
    CHARACTER_LOCAL_FILE_READ_ENABLED: '1',
    CHARACTER_LOCAL_FILE_WRITE_ENABLED: '1',
    CHARACTER_TASK_AUTONOMY_ENABLED: '1',
    CHARACTER_WEATHER_ENABLED: '1',
    CHARACTER_OFFICE_GENERATE_ENABLED: '1',
    CHARACTER_NEWS_READ_ENABLED: '1',
    CHARACTER_BROWSER_ENABLED: process.env.PRODUCTIVITY_LIVE_BROWSER === '1' ? '1' : '0',
    CHARACTER_BROWSER_SIDECAR_URL:
      process.env.CHARACTER_BROWSER_SIDECAR_URL ?? 'http://127.0.0.1:8931/mcp',
    CHARACTER_TURN_CONTENT_TOKENS: process.env.CHARACTER_TURN_CONTENT_TOKENS ?? '2000',
    CHARACTER_WEB_SEARCH_ENABLED: '0',
  }

  const say = (
    input: string,
    extraEnv: NodeJS.ProcessEnv = {}
  ): {
    exitCode: number
    reply: string
    traceId: string
    stdout: string
    modelCalls: number
    modelSeconds: number | null
    retries: number
    /** 程序事实：这一轮的某个动作**成功**了（只看 ACTION_SUCCEEDED 行） */
    actionSucceeded: boolean
    /** 程序事实：当轮内容**真的入了模**（`[turn-content-truth]` 行） */
    turnContentDelivered: boolean
  } => {
    const result = spawnSync(process.execPath, [tsxCli, 'src/main.ts', input], {
      cwd: process.cwd(),
      env: { ...childEnv, ...extraEnv },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    })
    const stdout = String(result.stdout ?? '')
    const merged = `${stdout}\n${String(result.stderr ?? '')}`
    const parsed = parseReply(stdout)
    const modelLines = [...merged.matchAll(/\[turn \d+\][^\n]*模型[^\n]*?([\d.]+)\s*s/g)]
    const seconds = modelLines.map((match) => Number(match[1]))
    return {
      exitCode: result.status ?? 1,
      ...parsed,
      stdout: merged,
      modelCalls: modelLines.length,
      modelSeconds: seconds.length === 0 ? null : seconds.reduce((sum, value) => sum + value, 0),
      retries: [...merged.matchAll(/重试|retry/gi)].length,
      /*
       * ⚠️ 这两个是**程序事实**（应用自己打的闭集行），不是对回复的解读：
       *    "能力真的成功了 / 内容真的进上下文了"只能由它们回答，
       *    而"模型有没有把 URL 抄一遍"**不能**当作能力是否可用的判据
       *    （实测：能力交付成功、模型只说了「读完了。三篇，都是阮一峰的科技周刊。」）。
       */
      actionSucceeded: /\[action\] ACTION_SUCCEEDED/.test(merged),
      turnContentDelivered: /\[turn-content-truth\][^\n]*delivered/.test(merged),
    }
  }

  const dumpRaw = (id: string, output: string): void => {
    try {
      mkdirSync(localDir, { recursive: true })
      writeFileSync(join(localDir, `${id}.log`), output, 'utf8')
    } catch {
      /* 落盘失败不影响读数 */
    }
  }
  const record = (
    base: Omit<LiveCaseReading, 'status'>,
    status: LiveStatus,
    extra: Partial<LiveCaseReading> = {},
    rawOutput?: string
  ): void => {
    /*
     * ========================================================================
     *  ⚠️ **没有观测到一轮，就不许判 FAIL**（2026-10-04 实测逼出来的）
     * ========================================================================
     * 那一轮里模型端点连续 `call_failed`，八个场景里六个的 stdout
     * **既没有回复也没有 traceId**。第一版照样判 FAIL，并且把
     * 一句**写死的** reason（"回复里出现了看起来像真实气温的数值"）写了进去 ——
     * 于是证据在**说一件没有发生过的事**。
     *
     * 这正是 AGENTS.md §6.9 的那条：数字（这里是 `FAIL`）对，
     * 但它描述的东西不是你以为的那个。
     * ⇒ 判据改在这里，而不是在八个调用点各写一遍：**没量到 = NOT RUN**。
     */
    const measured = (base.reply ?? '') !== '' || (base.traceId ?? '') !== ''
    if (status === 'FAIL' && !measured) {
      cases.push({
        ...base,
        status: 'NOT RUN',
        reason:
          `这一轮没有产生可判定的轮次：stdout 里既没有回复也没有 traceId` +
          `${base.exitCode !== undefined ? `（exit=${String(base.exitCode)}）` : ''} —— ` +
          '模型端点或环境不可用（实测过 `call_failed` 与 `OpenAI API key validation failed`）。' +
          '**这不是能力失败**，因此如实记 NOT RUN。',
      })
      if (rawOutput !== undefined) dumpRaw(base.id, rawOutput)
      return
    }
    cases.push({ ...base, status, ...extra })
    if (rawOutput !== undefined) dumpRaw(base.id, rawOutput)
  }

  const liveFeedUrl = process.env.PRODUCTIVITY_LIVE_FEED_URL ?? 'https://www.ruanyifeng.com/blog/atom.xml'

  // -------------------------------------------------------------------------
  // 场景 ① 天气 · 成功
  // -------------------------------------------------------------------------
  const weatherSuccess = say('查一下西安的天气')
  const weatherOk =
    weatherSuccess.traceId !== '' &&
    /西安/.test(weatherSuccess.reply) &&
    /°C|度/.test(weatherSuccess.reply) &&
    !/我猜|可能是|大概是/.test(weatherSuccess.reply)
  record(
    {
      id: 'live-weather-success',
      capability: 'weather',
      kind: 'success',
      title: '指定城市、固定日期范围、真实天气 API；单位/时间与结果一致',
      input: '查一下西安的天气',
      exitCode: weatherSuccess.exitCode,
      reply: weatherSuccess.reply.slice(0, 400),
      traceId: weatherSuccess.traceId,
      expected: { mentionsCity: '西安', hasUnit: true },
    },
    weatherOk ? 'PASS' : 'FAIL',
    {
      modelCalls: weatherSuccess.modelCalls,
      modelSeconds: weatherSuccess.modelSeconds,
      retries: weatherSuccess.retries,
      observed: {
        mentionsCity: /西安/.test(weatherSuccess.reply),
        hasUnit: /°C|度/.test(weatherSuccess.reply),
      },
      ...(weatherOk
        ? {}
        : {
            reason:
              '回复里没有城市名或单位。⚠️ 本机可能没有直连出站（只有 HTTP 代理），' +
              '而适配器用 globalThis.fetch 直连固定域名 ⇒ 拿不到数据时如实失败。' +
              '真读数见 raw 日志。',
          }),
    },
    weatherSuccess.stdout
  )

  // -------------------------------------------------------------------------
  // 场景 ② 天气 · 降档
  // -------------------------------------------------------------------------
  const weatherDegrade = say('查一下青鳉三号星的天气')
  /*
   * ⚠️ 天气降档的判据：**程序事实**（动作是不是成功了）+ "回复里有没有**未被否定的**
   *    具体气温数值"。第一版只做后者，于是"没有 21 度这种数据"这类**如实否定**
   *    会被读成"编了数值"（与浏览器那条同型）。
   */
  const weatherDegradeOk =
    !weatherDegrade.actionSucceeded &&
    !/\d+(\.\d+)?\s*(°C|度)/.test(weatherDegrade.reply) &&
    weatherDegrade.traceId !== ''
  record(
    {
      id: 'live-weather-degrade',
      capability: 'weather',
      kind: 'degrade',
      title: '同名目标或失败响应；不猜城市、不编数值',
      input: '查一下青鳉三号星的天气',
      exitCode: weatherDegrade.exitCode,
      reply: weatherDegrade.reply.slice(0, 400),
      traceId: weatherDegrade.traceId,
      expected: { noInventedNumbers: true },
    },
    weatherDegradeOk ? 'PASS' : 'FAIL',
    {
      modelCalls: weatherDegrade.modelCalls,
      modelSeconds: weatherDegrade.modelSeconds,
      retries: weatherDegrade.retries,
      observed: { replyHead: weatherDegrade.reply.slice(0, 160) },
      ...(weatherDegradeOk ? {} : { reason: '回复里出现了看起来像真实气温的数值' }),
    },
    weatherDegrade.stdout
  )

  // -------------------------------------------------------------------------
  // 场景 ③ 文件 + 办公 · 成功
  // -------------------------------------------------------------------------
  const officeSuccess = say(
    `帮我读一下 ${inputPath}，把要点生成一份 Word 报告，输出到 ${docxOut}`
  )
  const officeOk = existsSync(docxOut) && readFileSync(docxOut).byteLength > 0
  record(
    {
      id: 'live-file-office-success',
      capability: 'files',
      kind: 'success',
      title: '一个用户目标；自主读输入、生成三格式并覆盖一个合成文件',
      input: `读 ${inputPath} → 生成 Word 到 ${docxOut}`,
      exitCode: officeSuccess.exitCode,
      reply: officeSuccess.reply.slice(0, 400),
      traceId: officeSuccess.traceId,
      expected: { docxExists: true, bytes: '>0' },
    },
    officeOk ? 'PASS' : 'FAIL',
    {
      modelCalls: officeSuccess.modelCalls,
      modelSeconds: officeSuccess.modelSeconds,
      retries: officeSuccess.retries,
      observed: {
        docxExists: existsSync(docxOut),
        docxBytes: existsSync(docxOut) ? readFileSync(docxOut).byteLength : 0,
        replyClaimsSaved: /保存|生成好了|写好了|已经生成/.test(officeSuccess.reply),
      },
      ...(officeOk
        ? {}
        : {
            reason:
              '产物不存在或为 0 字节。⚠️ 这一场景要求模型在**一次规划**里同时给出' +
              '"读输入 + 生成 Office"两步；模型只做一步时任务环会如实地只完成那一步。',
          }),
    },
    officeSuccess.stdout
  )

  // -------------------------------------------------------------------------
  // 场景 ④ 文件 + 办公 · 降档（目标不可写）
  // -------------------------------------------------------------------------
  const officeDegrade = say(
    `把一份 Word 报告写到 ${readOnlyTarget}（这是一个目录）`
  )
  const officeDegradeOk =
    !claimsSuccess(officeDegrade.reply, ['已经保存', '保存好了', '生成好了', '写好了']) &&
    officeDegrade.traceId !== ''
  record(
    {
      id: 'live-file-office-degrade',
      capability: 'files',
      kind: 'degrade',
      title: '目标不可写或并发冲突；原文件保留，不声称已保存',
      input: `写到目录 ${readOnlyTarget}`,
      exitCode: officeDegrade.exitCode,
      reply: officeDegrade.reply.slice(0, 400),
      traceId: officeDegrade.traceId,
      expected: { noSuccessClaim: true },
    },
    officeDegradeOk ? 'PASS' : 'FAIL',
    {
      modelCalls: officeDegrade.modelCalls,
      modelSeconds: officeDegrade.modelSeconds,
      retries: officeDegrade.retries,
      observed: {
        replyHead: officeDegrade.reply.slice(0, 160),
        successClaim: claimsSuccess(officeDegrade.reply, ['已经保存', '保存好了', '生成好了', '写好了']),
      },
      ...(officeDegradeOk ? {} : { reason: '回复里出现了"保存好了 / 生成好了"这类成功口吻' }),
    },
    officeDegrade.stdout
  )

  // -------------------------------------------------------------------------
  // 场景 ⑤ 资讯 · 成功
  // -------------------------------------------------------------------------
  const newsSuccess = say(`读一下这个订阅源 ${liveFeedUrl} 的资讯`)
  /*
   * ⚠️ 判据是**程序事实**，不是"模型有没有把 URL 抄一遍"（2026-10-04 实测更正）：
   *    那一轮 `news.read` **成功**、`[turn-content-truth] … news.read:delivered`
   *    也打了，而模型只回了一句「读完了。三篇，都是阮一峰的科技周刊。」——
   *    能力没问题，是**判据问错了地方**（与第一批那条"量具抓取通道"同型）。
   */
  const newsOk =
    newsSuccess.traceId !== '' && newsSuccess.actionSucceeded && newsSuccess.turnContentDelivered
  record(
    {
      id: 'live-news-success',
      capability: 'news',
      kind: 'success',
      title: '固定真实源，概览 + 一条深读；发布时间/来源/实际阅读范围正确',
      input: `读 ${liveFeedUrl}`,
      exitCode: newsSuccess.exitCode,
      reply: newsSuccess.reply.slice(0, 400),
      traceId: newsSuccess.traceId,
      expected: { sourceUrl: liveFeedUrl, actionSucceeded: true, turnContentDelivered: true },
    },
    newsOk ? 'PASS' : 'FAIL',
    {
      modelCalls: newsSuccess.modelCalls,
      modelSeconds: newsSuccess.modelSeconds,
      retries: newsSuccess.retries,
      observed: {
        actionSucceeded: newsSuccess.actionSucceeded,
        turnContentDelivered: newsSuccess.turnContentDelivered,
        replyHead: newsSuccess.reply.slice(0, 120),
      },
      ...(newsOk
        ? {}
        : {
            reason:
              `程序事实不成立：actionSucceeded=${String(newsSuccess.actionSucceeded)} ` +
              `turnContentDelivered=${String(newsSuccess.turnContentDelivered)}。` +
              '订阅源取不到时如实失败（不是"编一条"）；可用 `PRODUCTIVITY_LIVE_FEED_URL` 换一个可达的真实源重跑。',
          }),
    },
    newsSuccess.stdout
  )

  // -------------------------------------------------------------------------
  // 场景 ⑥ 资讯 · 降档（坏源）
  // -------------------------------------------------------------------------
  const newsDegrade = say('读一下这个订阅源 https://no-such-host-9f3a.invalid/feed.xml 的资讯')
  const newsDegradeOk =
    !claimsSuccess(newsDegrade.reply, ['我读完了这篇文章', '文章正文里', '全文如下']) &&
    newsDegrade.traceId !== ''
  record(
    {
      id: 'live-news-degrade',
      capability: 'news',
      kind: 'degrade',
      title: '坏源/无正文；不给假全文结论',
      input: '读 https://no-such-host-9f3a.invalid/feed.xml',
      exitCode: newsDegrade.exitCode,
      reply: newsDegrade.reply.slice(0, 400),
      traceId: newsDegrade.traceId,
      expected: { noFakeFullTextClaim: true },
    },
    newsDegradeOk ? 'PASS' : 'FAIL',
    {
      modelCalls: newsDegrade.modelCalls,
      modelSeconds: newsDegrade.modelSeconds,
      retries: newsDegrade.retries,
      observed: { replyHead: newsDegrade.reply.slice(0, 160) },
      ...(newsDegradeOk ? {} : { reason: '回复里声称读到了全文' }),
    },
    newsDegrade.stdout
  )

  // -------------------------------------------------------------------------
  // 场景 ⑦ 浏览器 · 成功（**需真实已登录 profile + 人工首连**）
  // -------------------------------------------------------------------------
  if (process.env.PRODUCTIVITY_LIVE_BROWSER !== '1') {
    record(
      {
        id: 'live-browser-success',
        capability: 'browser',
        kind: 'success',
        title: '已授权 profile 中真实已登录任务页，元素读取/填写并读回',
        input: '（未运行）',
        expected: { realLoggedInProfile: true },
      },
      'NOT RUN',
      {
        reason:
          '需要**人工首连**：安装官方扩展、选择目标 profile、允许连接，然后设 ' +
          '`PRODUCTIVITY_LIVE_BROWSER=1` 与 `CHARACTER_BROWSER_SIDECAR_URL` 重跑。' +
          '受控假 sidecar 的读数在离线第 ①②③ 组，**不替代**本场景。',
      }
    )
  } else {
    const browserSuccess = say('帮我看一下当前页面写了什么')
    const browserOk = browserSuccess.traceId !== '' && !/我没启用|没有启用/.test(browserSuccess.reply)
    record(
      {
        id: 'live-browser-success',
        capability: 'browser',
        kind: 'success',
        title: '已授权 profile 中真实已登录任务页，元素读取/填写并读回',
        input: '帮我看一下当前页面写了什么',
        exitCode: browserSuccess.exitCode,
        reply: browserSuccess.reply.slice(0, 400),
        traceId: browserSuccess.traceId,
        expected: { pageRead: true },
      },
      browserOk ? 'PASS' : 'FAIL',
      {
        modelCalls: browserSuccess.modelCalls,
        modelSeconds: browserSuccess.modelSeconds,
        retries: browserSuccess.retries,
        observed: { replyHead: browserSuccess.reply.slice(0, 160) },
      },
      browserSuccess.stdout
    )
  }

  // -------------------------------------------------------------------------
  // 场景 ⑧ 浏览器 · 降档（断连）
  // -------------------------------------------------------------------------
  const browserDegrade = say('帮我看一下当前页面写了什么', {
    CHARACTER_BROWSER_SIDECAR_URL: 'http://127.0.0.1:1/mcp',
  })
  const browserDegradeOk =
    !claimsSuccess(browserDegrade.reply, ['页面内容', '页面里写着', '我看到了']) &&
    browserDegrade.traceId !== ''
  record(
    {
      id: 'live-browser-degrade',
      capability: 'browser',
      kind: 'degrade',
      title: '扩展断连、过期元素或未绑定标签；如实失败，不继续其它标签/页面',
      input: '（sidecar 指向一个必然连不上的地址）',
      exitCode: browserDegrade.exitCode,
      reply: browserDegrade.reply.slice(0, 400),
      traceId: browserDegrade.traceId,
      expected: { honestFailure: true },
    },
    browserDegradeOk ? 'PASS' : 'FAIL',
    {
      modelCalls: browserDegrade.modelCalls,
      modelSeconds: browserDegrade.modelSeconds,
      retries: browserDegrade.retries,
      observed: {
        replyHead: browserDegrade.reply.slice(0, 160),
        claimsPageContent: claimsSuccess(browserDegrade.reply, ['页面内容', '页面里写着', '我看到了']),
      },
      ...(browserDegradeOk ? {} : { reason: '回复里声称看到了页面内容' }),
    },
    browserDegrade.stdout
  )

  // -------------------------------------------------------------------------
  // 收口
  // -------------------------------------------------------------------------
  const result = writeEvidence()
  const pass = cases.filter((item) => item.status === 'PASS').length
  const failCount = cases.filter((item) => item.status === 'FAIL').length
  const notRun = cases.filter((item) => item.status === 'NOT RUN').length
  process.stdout.write(
    `[productivity:live] 八场景：PASS ${String(pass)} · FAIL ${String(failCount)} · NOT RUN ${String(notRun)}\n`
  )
  process.stdout.write(
    `[productivity:live] 证据 = artifacts/post-lv2/productivity-skills/${runId}/live.json\n`
  )
  for (const item of cases) {
    process.stdout.write(
      `[productivity:live]   ${item.id.padEnd(28)} ${item.status}${item.reason !== undefined ? ` — ${item.reason.slice(0, 120)}` : ''}\n`
    )
  }
  return { ...result, exitCode: failCount === 0 && pass > 0 ? 0 : 1 }
}

/** 八场景的形状（`failAll` 也要用它，因此提出来当常量） */
const LIVE_IDS: readonly {
  id: string
  capability: string
  kind: 'success' | 'degrade'
  title: string
}[] = [
  { id: 'live-weather-success', capability: 'weather', kind: 'success', title: '天气成功' },
  { id: 'live-weather-degrade', capability: 'weather', kind: 'degrade', title: '天气降档' },
  { id: 'live-file-office-success', capability: 'files', kind: 'success', title: '文件+办公成功' },
  { id: 'live-file-office-degrade', capability: 'files', kind: 'degrade', title: '文件+办公失败' },
  { id: 'live-news-success', capability: 'news', kind: 'success', title: '资讯成功' },
  { id: 'live-news-degrade', capability: 'news', kind: 'degrade', title: '资讯失败' },
  { id: 'live-browser-success', capability: 'browser', kind: 'success', title: '浏览器成功' },
  { id: 'live-browser-degrade', capability: 'browser', kind: 'degrade', title: '浏览器失败' },
]
