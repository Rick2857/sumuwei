# 渠道识别与三出口提醒：生产启用记录

日期：2026-10-09，Asia/Shanghai。对应 [ADR-124](../adr/ADR-124-chat-channel-and-reminder-routing.md) 与 [验收记录](Chat-Channel-Reminder-Acceptance-2026-10-09.md)。

用户在呈交代码验收及“备份、迁移到 v17、受控启动”的具体动作后明确回复“确认”。本次按此范围执行，当前服务保持运行。

## 备份与迁移

启动前 6751／6752／6753／12394 均无监听、旧 QQ 核心未运行。正式库上一条 owner 记录为 `cleanClose=false`，保留其原记录；既有租约程序自动归档，不手动修改记录、处理 PID/WAL 或恢复数据库。

`pnpm db:snapshot --snapshot-root data/snapshots/reminder-channel-activation-20261009 --keep 30` 取得独占租约，源静止／复制摘要／一次性副本健康验证通过，schema 为 v16。保留快照 `2026-10-09T10-36-24-494Z-0de820a7639f`：1268 个非易变文件、41988639 字节、SHA-256 `0de820a7639f00d85380c3e3460d7706cf128d80a3f05c0d9268ee4936c0cec0`。此处摘要按既有算法排除 `postmaster.pid`，不能与批准前逐文件摘要直接比较。

`.env` 中仅将快照根由审计目录改为本次独立目录，避免本次自动保留策略触及此前审计快照。入口令牌文件沿既有准备流程增加控制台独立令牌与 6753，未打印令牌。生产提醒模式仍为 `on`、入口会话隔离仍为 true；生产记忆模式未改。

`pnpm migrate:apply` EXIT 0，唯一新增迁移 `#17 reminder-delivery-channel`，schema **16 → 17**。生产状态机完成迁移关闭、post-close 快照与租约释放；直接读回迁移 owner PID 52380 为 `cleanClose=true`，结束时间 `2026-10-09T10:37:31.617Z`。

| 快照 | 用途 | schema |
|---|---|---|
| `2026-10-09T10-36-24-494Z-0de820a7639f` | 手动迁移前备份 | 16 |
| `2026-10-09T10-37-22-355Z-0de820a7639f` | 迁移 pre-open | 16 |
| `2026-10-09T10-37-27-341Z-c33ae7880434` | 迁移 post-close | 17 |
| `2026-10-09T10-38-04-355Z-c33ae7880434` | 正式启动 pre-open | 17 |

迁移读回只打开前后保留快照的一次性副本。原有 **3 条**通知意图，排除新增列后的全部字段 SHA-256 前后均为 `6cb0fc41eb50e83b2d68613f65b16d38a94095bb39c2e065c7686c9683f0723f`。新增列非空、缺省 QQ，旧行全为 `qq_private`，约束只含 `qq_private`／`avatar`／`cli`。副本均关闭，保留快照摘要未变。本次没有裁剪已有快照。

## 正式启动读回

通过既有逐字授权串启动监督者，正式库由单一核心持有。使用直接 TSX 监督入口，行为与 `pnpm coexist:start` 相同。

| 项目 | 2026-10-09 18:39 读数 |
|---|---|
| 监督者 | PID 5572，保持运行 |
| 唯一核心 | owner PID 18468，6751／6752／6753 均由其监听 |
| 绑定范围 | 三入口及 HTTP 12394 均仅 `127.0.0.1` |
| 核心 | `COEXIST_READY entries=qq_private:6751,avatar:6752,cli:6753` |
| QQ 外壳 | `onebot_owner_private_ready`；启动前另有只读认证 PASS |
| 皮套 | PID 23400，`LG_AVATAR_READY`；`/lg/status` HTTP 200、production、`lg_process_alive=true` |
| 语音配置 | 既有 CosyVoice3／SenseVoice；本次未做语音性能验收 |
| 控制台 | 独立令牌握手返回真实 `cli` 入口；未提交任何聊天轮次，检查后断开 |
| 前端 | HTTP 实际 JS 与部署包摘要相同，含提醒回执路径；受管提醒客户端与当前仓库源码摘要相同 |

运行中 owner 尚未关闭，不能在当前记录上要求 `cleanClose=true`。日后按 `pnpm coexist:stop` 有序排空并检查 exit 0、post-close 快照、租约与端口释放。

## 使用与证据边界

现在可在皮套或其他入口提出“十分钟后通过 QQ 发消息提醒我喝水”，也可明确选择皮套／控制台；未指定时默认当前入口。皮套页面须保持连接；控制台须另开终端运行 `pnpm coexist:chat`。目标离线不静默改投，结果不明不自动重发。

本轮未发送 QQ 测试消息、未提交正式诊断聊天、未向真实浏览器投递提醒。就绪及部署检查不代替消息实际交付、本人阅读、自然首次使用或长期收益。原 `AUD-ISO-01` 的历史影响未知与 OPEN 状态不因本次备份健康或激活改变。

机器证据：[activation-20261009](../../artifacts/post-lv2/reminder-channels/activation-20261009/)。迁移与启动原日志、只读检查脚本及原 owner 记录在 gitignore 的 `artifacts/post-lv2/local/reminder-channel-activation-20261009/`。批准前验收证据原样保留，无提交、推送或打标签。
