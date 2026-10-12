# 所有正式聊天入口的语义记忆写入（2026-10-06）

依据：[ADR-108](../adr/ADR-108-semantic-memory-write-activation.md)。用户要求把语义功能用于写入，并明确包括所有聊天入口。该请求授权本批实现、隔离验证、生产配置激活与已有 QQ 入口的正常重启，不需要重复申请开关授权。

## 行为与范围

原来“请记住……”在规则意图入口处未命中，内容抽取器的 LLM 兜底也没有启用。现在共用 `src/main.ts / buildMemoryWriter` 装配两步：

```text
用户真实消息
  → 规则意图；未命中则语义意图分类
  → 明确记忆操作才继续；普通闲聊返回无意图
  → 规则内容抽取；未命中则语义内容抽取
  → 已有证据 / 身份 / schema / 权威 / 冲突 / 去重 / 提交
  → 已有回复真相守卫
```

| 能力面 | 本批结果 |
|---|---|
| 新增能力 | 已有语义意图分类器接入共用写入端口，启用已有语义内容兜底 |
| 正式入口 | CLI、通用 stdio bridge、QQ，以及调用正式 bridge 的语音/Live2D 共用 |
| 开关 | `CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED=true`；代码缺省仍 false |
| 原有语义召回 | 保留独立开关与模式，不由写入开关替代 |
| 权限与副作用 | 仅用户明确要求的记忆操作可继续；候选仍经原放行链 |
| 新依赖 / 迁移 / 第二写入者 | NONE |
| 自动从全部闲聊生成长期事实 | 本批未启用；后台抽取仍保持原状态 |

意图分类只接受完整闭集标签，含操作词的解释、否定句、多个标签与 JSON 均不会被截成操作。开启前的负控复现了旧子串解析会把 `do not remember` 认成写入操作，修复后单元门通过。内容模型可见已有槽位的描述和枚举取值，以便按契约产生候选。

## 验证读数

| 检查 | 结果与边界 |
|---|---|
| `pnpm m4:test` | 262 PASS / 0 FAIL；原 261 项和新增完整闭集负控 |
| `pnpm typecheck` | EXIT 0 |
| `pnpm postlv2:memory-write:verify` | PASS；本地模型 fixture + 真 main.ts + 4 个新隔离库 |
| `pnpm with-test-model pnpm postlv2:memory-write:live` | PASS；`.env.test` 端点 + 真 main.ts + 3 个新隔离库，5 个实际聊天轮 |
| `pnpm m4.5:ci` | EXIT 0；串行完整离线链，G14 是承接的既有 Live Smoke，未在本命令重跑 |

离线整链分列：off 档零新增；on 档通用桥写出香菜偏好与就读学校两条记忆，普通生日自述零写入；CLI 写出一条；QQ 入口的引用、自述、问句、坏分类格式、分类失败、分类超时、内容坏 JSON 共 7 个负控零新增，之后同进程新请求写入成功。内容正控“请长期记住，我目前在示科读书。”先证明规则抽取器返回空，再观察模型内容兜底与实际持久化行，避免只用回复“记住了”当成功证据。

真实模型档独立重跑 off、通用桥 on 和 CLI on，学校槽位与 `food.preference.cilantro=dislike` 实际存在于隔离库，普通生日自述没有被自动记录。该档证明有限材料上的真实模型行为，不外推任意说法的正确率。测试没有打开真实库，没有发送任何 QQ 消息。两档的真实库目录树摘要均前后相同。

新证据：

- `artifacts/post-lv2/semantic-memory-write-offline-20261006041220064/result.json`
- `artifacts/post-lv2/semantic-memory-write-live-20261006041339002/result.json`
- `artifacts/post-lv2/semantic-memory-write-delivery-20261006/full-ci.json` 与同目录 `gate-results.json`；本次改写的 6 个已跟踪历史文件已按运行前备份逐字节恢复，本批新读数另存，原用户未提交修改也保留。
- 启用前闭集负控的 FAIL 日志保留在忽略的 `artifacts/post-lv2/local/semantic-memory-write-repro.log`；测试 fixture 初次未处理启动健康请求的日志也保留，随后仅修测试服务器路由。

## 激活与剩余边界

当前：实现、隔离整链、真实模型有限检查及完整回归均已通过，生产开关尚未改变。已有 QQ 进程已按正常退出链关闭，owner record 的 `cleanClose=true` 已读回。激活后在本节追加时间、配置与新进程读回。

每次语义调用期限 15 秒。规则未命中的聊天增加一次私有意图调用，内容也未命中时再增加一次，可能增加回复等待；失败不猜、不伪报成功。模型误判仍是行为风险，有限测试不保证永不误写。已有问句守卫保留，因此某些“你能记住……吗”形式仍可能被内容抽取拒绝；复杂多事实等边界也未作普遍验收。

此开关在每次正式入口启动时加载；仍运行旧版本的其它进程需正常重启。测试或沙箱若显式设 false，继续维持规则档。自然生产首用与实际收益仍为 NOT OBSERVED，不由配置读回替代。

回滚：将 `CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED=false` 后正常重启。已有记忆、历史事件和语义召回配置保留。

### 生产激活追加记录（2026-10-06，UTC+8）

实现提交 `a2b7a5f4394af3f286788924023918f7badbf89f`。12:22 在 `.env` 追加 `CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED=true`；配置程序逐项比对确认其余变量逐字值不变，私有备份留在被忽略的本地目录。四份被测试源文件的摘要与离线、真实模型和完整回归证据一致。读回：显式记忆 true、LLM 意图/内容兜底 true、语义召回 true/on、后台抽取 false。

随后运行 `pnpm qq:chat`，12:23 读回正式 `src/main.ts --bridge --qq-private` 进程已运行，LG 就绪，鉴权连接事件为 `onebot_owner_private_ready`。正式 CLI 和语音启动器也加载同一 `.env`，没有单独的 QQ 写入开关；其它已启动的入口需要正常重启才能加载新配置。

追加状态：配置激活 **ACTIVATED**；共用接线与隔离整链 **PASS**；真实模型有限检查 **PASS**；QQ 新进程及账号连接 **RUNNING / PASS**；自然生产首用 **NOT OBSERVED**。上文生产尚未改变是激活前读数，以本追加记录为当前状态。没有提交合成生产对话，测试没有写入她的真实记忆。机器读回为 `artifacts/post-lv2/semantic-memory-write-delivery-20261006/activation.json`。
