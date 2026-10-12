# 渠道识别与三出口提醒：2026-10-09 验收及交接

对应 [ADR-124](../adr/ADR-124-chat-channel-and-reminder-routing.md)。用户明确要求同时支持 QQ、皮套和控制台文字提醒。

代码已实现。正式库 0017 迁移及本次生产启用未执行，实际 QQ 手机收信和真实浏览器提醒整链未验收。

| 项目 | 本轮读数 | 证据范围 |
|---|---|---|
| 类型 | `pnpm typecheck` EXIT 0 | 当前源码、脚本、evals |
| 渠道整链 | `pnpm reminder:channels:verify` 34 PASS | 真实共存核心 + 隔离库 + loopback 模型；实际控制台进程、跨端请求、修改、重连、重启、错渠道回执、无回执不重发、旧库升级闭集 |
| 皮套显示边界 | Python 外壳与 JS 页面夹具 PASS | 初次连接即可接收、显示前不接受、消息/连接令牌、重复/过期/断线、安全文字显示、显示容量和失败分列；未使用真浏览器或 TTS |
| 渠道语义 | 测试端点真模型 8/8 PASS | 三出口、默认当前、“打开QQ”事项、未知渠道、当前入口、更换出口；不打开库、不发送消息，非统计正确率主张 |
| 原提醒上下文 | `reminder:context:verify` EXIT 0 | 指代、来源、关闭/超时、结果事实与语音守卫 |
| 原 QQ 投递 | 离线 235/235，量具 32/32 | 原固定本人私聊及权限、幂等、账本、归因；本地新增写豁免使用独立系统身份和 R1 |
| 原桥/传输 | `postlv2:bridge:verify`、`postlv2:transport:verify` EXIT 0 | 协议、控制消息和原有交付边界 |
| 共存与外壳 | `postlv2:coexist:verify`、`postlv2:coexist:shells` EXIT 0 | 共享生命周期、近期窗口隔离、共享记忆、真实 Python／QQ 外壳的本地夹具往返 |
| 量具和选门 | M5.1 measurement、gates:verify、affected:verify EXIT 0 | 新门已登记并由渠道源文件及主入口改动带出；affected 23/23 |
| 完整回归 | `pnpm with-test-model pnpm m4.5:ci:full` EXIT 0 | 含完整 `m4.5:ci`，本次新跑 Live Smoke **56/0**；不是只读旧聚合结果 |
| M5.1 收尾 | `m5.1:gates`、`m5.1:regression:verify` PASS | 读取既有 M5.1 专项证据与本次完整回归日志；不将继承证据说成本轮重跑所有 M5.1 门 |
| 页面构建 | Vite `build:web` EXIT 0 | 固定上游版本的现有前端补丁路径；不主张完整 web 类型检查通过 |
| 使用说明 | doc:sync / doc:check，scripts:catalog:verify PASS | 仓库权威说明已同步桌面投影，脚本清单含新命令 |

完整回归首次因正式库关闭记录不足被保护闸拒绝。随后明确选择已有 `pglite-2026-10-09T09-02-05-813Z-e188bf484542` 正式快照，校验 manifest、文件数和树摘要后复制到临时库；没有绕过保护或处理正式库 PID/WAL。快照摘要为 `e188bf48454202457441dd67338776c18cfb524f91395f3cee72a7dab04bcd2c`。这不证明当前正式库健康，也不关闭原隔离事故。

原共存夹具会继承新加入的 `CHARACTER_MEMORY_WRITE_MODE=post_turn_model`，使旧的规则记忆用例没有写入。现已在该夹具和共存测试 harness 中明确固定 legacy 模式后复验通过；生产记忆模式没有修改。原 QQ 静态装配判据同步到共用提醒调度位置，写豁免闭集逐项核对 QQ／本地身份，未放宽权限判据。

本轮会重写的十一条历史证据已逐路径保留本次副本，再恢复到测试前保存的工作树字节；原有未提交更改保留。本次证据在 `artifacts/post-lv2/reminder-channels/acceptance-20261009/`，专项逐次证据在同目录的时间戳子目录，长日志在 gitignore 的 `artifacts/post-lv2/local/reminder-channel-work/`。

正式库未打开、未迁移。文件级前后摘要相同：1269 文件，SHA-256 `32c87997a1691e17514880680af1b179737725656d6ea43679f87b039ca495c4`，见 `production-integrity.json`。

## 正式启用前待批准的动作

按 AGENTS.md 的新迁移授权要求，待用户批准后：核对正式库持有者／停止状态，完成既有备份纪律，应用唯一新增迁移 0017，读回旧提醒目标仍为 QQ，再按共存流程受控启动。入口令牌增加控制台 loopback 6753；页面包已沿现有固定版本路径构建。需要真实 QQ／页面交付时，使用本人授权的测试内容另记接口与真人收信读数。

## 代码交接

共享工作树中还有此前的记忆、审计、依赖等在途更改，本轮未整体提交。后续提交应按路径及差异归属收取，不能 `git add -A`。

本轮新增生产文件：`src/kernel/contracts/chat-channel.ts`、`src/kernel/context/chat-channel-section.ts`、`src/kernel/action/local-reminder-capability.ts`、`src/infrastructure/action/adapters/local-reminder-delivery.ts`、`src/infrastructure/runtime/reminder-scheduling.ts`、`scripts/coexist/chat.ts`、`scripts/postlv2_reminder_client.js`。

本轮新增验收文件：`scripts/reminder-channels-verify.ts`、`scripts/reminder-channels-live.ts`、`scripts/reminder-channels-shell-verify.py`、`scripts/reminder-channels-frontend-verify.mjs`，以及本报告／ADR-124／独立证据目录。

现有文件中的本轮差异：主入口、entry-scope、TurnGateway、提醒编排/守卫/流式回复、通知 store 和追加迁移、具名归因与能力登记、桥/调度、共存准备/监督/harness、皮套 Python 与前端补丁、相关旧门、package 命令与 affected/manifest、使用说明及自动生成脚本清单。共享文件需保留其它会话的既有差异。

## 生产启用追加读数（2026-10-09 18:39，Asia/Shanghai）

用户在上述验收与待批准动作之后回复“确认”。已完成正式库备份、16 → 17 迁移及受控启动；三个 loopback 入口监听同属唯一核心，QQ 认证、皮套 production/alive 状态及控制台独立令牌握手通过。迁移后只打开保留快照的一次性副本，确认旧三条提醒逐字段不变、目标均为 QQ。原“未打开／未迁移”及完整性读数仍归属于批准前的验收阶段，不用于描述启用后的正式库。见 [生产启用记录](Chat-Channel-Reminder-Activation-2026-10-09.md)；真实消息交付与本人阅读仍未验证。
