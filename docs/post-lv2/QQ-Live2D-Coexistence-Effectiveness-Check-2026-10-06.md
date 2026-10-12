# QQ 与 Live2D 共存生效检查

检查日期：2026-10-06，UTC+8；记录时间约 18:05。用户请求：「搭建已完毕帮我检查一下是否生效」。

**结论：生产双入口接线已生效，当前代码的文字与协议隔离回归通过；完整语音并发体验尚未验收。另发现一个仍在运行中可复现的状态接口缺陷。**

## 当前运行读回

| 检查项 | 本次读数 | 判定范围 |
|---|---|---|
| 唯一生产库持有者 | `data/owner-records/production-db-owner-35ad551daf6fd4ac.json` 指向 Node PID 32884，17:20:51 建档；进程仍在运行 | 当前持有者与共存核心一致；没有另开生产数据库 |
| QQ 实际连接 | QQ 客户端 PID 26980 与 NapCat 6701、LG 6751 均为 ESTABLISHED；`pnpm qq:status` 认证与机器人账号校验通过 | QQ 协议连接正常；没有代替本人发正式私聊 |
| 皮套实际连接 | Python PID 27692 与 LG 6752 为 ESTABLISHED；根路径 `http://127.0.0.1:12394/` 返回 200；生产日志记录 ASR/TTS 初始化与 `LG_AVATAR_READY` | 外壳及核心连接就绪；不等于真实语音已经完成往返 |
| 两条会话归属 | 对 6751/6752 分别做认证握手，读回 `dm-sumuwei-b8ec0760-qq` 与 `dm-sumuwei-b8ec0760-avatar` | 会话由实际监听入口绑定，两者不同 |
| 协议负控 | 两条连接收到未知消息种类均返回 `bridge_unknown_message_kind` | 当前核心能处理并具名拒绝输入；探针没有提交聊天轮次 |
| 记忆语义功能 | 生产启动日志 ON 包含 `memory-llm-extractor`、`memory-semantic-recall`、`memory-semantic-mode(on)`；OFF 为 `memory-background(NOT-WIRED)` | 语义写入抽取与语义召回配置均已加载；不证明每条话都写入，也不证明本次自然聊天实际调用/命中 |
| 状态接口 | 两次读取 `/lg/status` 均为 HTTP 500，日志对应 `AttributeError` | **FAIL，仍未修复** |

本次检查没有停止或重启正式服务，没有发送正式 QQ 消息，也没有向真实记忆写入测试对话。只读取生产日志、配置、进程、网络连接与库持有者记录；没有另外打开 `data/pglite`。

## 当前代码的重新验证

以下检查全部在本次重新执行，退出码均为 0。测试库为新建隔离目录，生产库树摘要在测试前后相同。

| 检查 | 结果 | 新证据 |
|---|---|---|
| `pnpm typecheck` | PASS | 本次终端 `tsc --noEmit`，EXIT 0 |
| `pnpm postlv2:coexist:verify` | 运行器 PASS，36 条记录；其中包含观察项 | [result.json](../../artifacts/post-lv2/coexist-wp2-verify-20261006095456579/result.json) |
| 皮套与 QQ 外壳连接档检查 | 11 PASS、2 OBSERVED、2 NOT RUN | [result.json](../../artifacts/post-lv2/coexist-wp3-shell-20261006095502325/result.json) |
| 共存场景矩阵 | 15 PASS、5 OBSERVED、6 NOT RUN、1 N/A | [result.json](../../artifacts/post-lv2/coexist-wp4-matrix-20261006095528187/result.json) |

新读数支持：回复回原入口、近期上下文分开、同外部 requestId 不冲突、各会话序号连续、取消不串到另一条入口、一路断线另一条仍能继续、公共生命周期只运行一次、共享记忆写入，以及排队公平性。

**跨入口记忆必须单独看读侧。** WP2 的 R-8 虽记为 PASS，但 detail 明确是「召回未选中」，该运行器不主张跨入口召回成功；不能把它算作成功命中。已有真模型隔离证据见 `coexist-wp4-live-20261006074421839/result.json`，它证明了特定材料的跨入口共享记忆入模，但该档把 embedding 语义召回设为 off，不能替代生产语义召回首用验证。

WP3 的 W-11 NOT RUN 指的是该隔离门没有执行生产启动脚本切换；本次对正式 Python 进程、6752 连接和握手的读回已另行证明当前生产外壳使用连接档。两项证据的范围不同。

模型使用同一个调度器，双入口会等待共同资源。夹具固定延时场景的单入口平均 400ms、双入口平均 732ms，最大排队 364ms；这些是隔离夹具读数，不是实际模型或音频延迟。

## 状态接口缺陷

位置：`scripts/postlv2_vtuber_runtime.py:1325`。

```python
"lg_process_alive": BRIDGE.ready and BRIDGE.process.returncode is None
```

连接档下 `LGBridgeClient.process` 为 `None`：LG 核心由共存宿主持有，皮套通过 socket 连接。上述状态读取仍按自起子进程档访问 `returncode`，因此抛出异常，整个状态接口返回 500。

同一类已经有兼容两种连法的 `alive` 属性（约 178 行）。可修复方向是让状态接口使用 `BRIDGE.ready and BRIDGE.alive`，并补连接档状态读回验证。本次是检查，**尚未修改代码或重启皮套**。

影响：ASR、播放、取消等状态无法通过 `/lg/status` 正常读回。现存连接和握手仍正常，所以这个错误本身不能推出聊天入口失效，也不能用失效的状态读回宣布语音通过。

## 尚未闭合的验收

- 两条入口同时实际使用时的 ASR、TTS、音频、表情、首次音频延迟及播放中打断：NOT RUN；初始化不替代真实体验。
- 长对话触发摘要后的会话归属：本次矩阵未触发摘要，NOT RUN。
- 当前版本的正式自然首用、生产 embedding 语义召回命中：本次没有聊天轮级读数。
- 两入口的真实超时与跨进程再投递边界：本次矩阵未覆盖。
- 当前新读数仅包含类型检查与三组针对性门，本次没有重新跑 `m4.5:ci`。旧完整 CI 有 PASS 日志，但激活指纹与当前 `src/main.ts`、`src/infrastructure/runtime/entry-scope.ts`、`scripts/postlv2-coexist-verify.ts`、`package.json` 不同，不能仅凭旧日志宣称当前完整工程回归已重新通过。

后续闭合顺序：先修复并读回状态接口，再补摘要归属的隔离长对话；最后用本人 QQ 与实际皮套完成同时聊天、播放中收到 QQ、语音打断三个真实场景，并把结果分别登记为生产首用与真人体验。

## 后续修订：状态接口已修复

2026-10-06 18:53 后：经用户授权修复，正式 `/lg/status` 已读回 HTTP 200、`lg_process_alive=true`；新状态回归 6/6、原有生命周期检查 10/10、双入口外壳回归及 `m4.5:ci` 均通过。LG 核心与 QQ 未重启。详情见 [状态接口修复记录](QQ-Live2D-Status-Endpoint-Fix-2026-10-06.md)。上文 18:05 的失败读数作为历史保留；实际语音与真人并发的未验收项仍单独保留。
