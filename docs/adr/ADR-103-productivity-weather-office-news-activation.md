# ADR-103：天气、办公生成与资讯阅读生产激活

状态：**ACTIVATED（配置层） / FIRST-USE NOT OBSERVED**。日期：2026-10-05。

授权：用户在确认这三项已安装但正式聊天开关关闭后，明确要求「行将他们启用」。本次启用 `weather.query`、`office.generate`、`news.read`。

## 1. 已执行的配置变更

北京时间 18:07:46，在 `.env` 追加三项开关：

```text
CHARACTER_WEATHER_ENABLED=true
CHARACTER_OFFICE_GENERATE_ENABLED=true
CHARACTER_NEWS_READ_ENABLED=true
```

追加后核对原 `.env` 字节前缀完全一致。代码中的三项缺省仍为 `false`，没有源码或 schema 变更。

办公生成依赖的 `CHARACTER_LOCAL_FILE_WRITE_ENABLED=true` 与 `CHARACTER_TASK_AUTONOMY_ENABLED=true` 已由 [ADR-099](ADR-099-productivity-skills-write-and-task-autonomy-activation.md) 启用；本轮回读仍为 true。当轮内容额度为 3000 token。

## 2. 验证与证据归属

- `pnpm productivity:activation:readback`：天气、办公生成、资讯阅读三项均为 true；文件读写和任务自主保持 true。
- 本机办公依赖回读：python-docx 1.2.0、python-pptx 1.0.2、openpyxl 3.1.5。
- 承接同日 16:56:22 完成的隔离验收：weather / office / news 共 12 组全 PASS。激活时重核该运行记录的 49 个源码指纹，全部与当前源码相符。本轮没有重跑这 12 组，也没有把它们写成生产首用证据。
- 当前 LG 默认聊天端口 12393 / 12394 没有监听；新启动的 LG 将加载上述配置。本轮操作为配置激活，首次实际天气请求、办公文件产出与资讯读取仍分别记 `NOT OBSERVED`。

机器证据：

- [激活记录与承接指纹](../../artifacts/post-lv2/productivity-skills/activation-weather-office-news-20261005T100746/activation.json)
- [实际开关回读](../../artifacts/post-lv2/productivity-skills/activation-weather-office-news-20261005T100746/activation-readback.json)
- [承接的隔离验收](../../artifacts/post-lv2/productivity-skills/effectiveness-audit-20261005T085456-6d073986-2fc1/run.json)

## 3. 使用与回滚

天气查询需要明确城市或经纬度；办公生成按用户目标在任务环中生成 DOCX / XLSX / PPTX；专用资讯阅读读取明确的 RSS / Atom 订阅源。普通新闻主题检索继续沿用既有联网搜索。

逐项回滚：将对应开关改为 `false` 并重启 LG。已生成的办公文件、恢复副本与动作账本保留。

浏览器属于 [ADR-100](ADR-100-productivity-skills-browser-activation.md) 的独立能力；其服务连接、登录态继承与真实会话验收仍按原记录分列。本次三项激活不关闭浏览器未运行项，也不宣布第二批整批验收全部通过。
