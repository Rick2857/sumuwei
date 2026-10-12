# LangMem 写入档回退 — 记录（2026-10-10）

判定载体：[ADR-130](../adr/ADR-130-memory-write-mode-rollback-to-langmem.md)（`ACCEPTED / EXECUTED`，状态修订）。
用户裁定原话：**「A：只删 WRITE_MODE，启用 LangMem 写入」**。

机器证据：`artifacts/post-lv2/langmem-write-rollback-20261010/backlog-readback.txt`
（只读副本读数，未打开生产库）· 备份 `artifacts/post-lv2/local/langmem-write-mode-rollback-20261010/.env.before`
（`local/` 按 gitignore 不入库）。

---

## 状态槽（**逐条分列**，不合成总分）

| 槽 | 状态 | 载体 / 读数 |
|---|---|---|
| 设计裁定 | **ACCEPTED** | ADR-130（用户三选一中的 A） |
| 实现 | **COMPLETE（配置层）** | `.env` 一处改动 + 一个**只读**读回脚本；**`src/**` 零改动** |
| 改动前基线 | **CAPTURED** | 只读副本：schema 18 · 账本 514 事件 / 最大序号 944 · LangMem 水位 **785** · post-turn 水位 **944** · 记忆 active 3 / retracted 2 |
| 离线硬门 | **PASS** | `postlv2:automatic-memory:verify` **20/20 EXIT 0** · `postlv2:model-memory:verify` EXIT 0 · `typecheck` EXIT 0 · `m4.5:ci` **EXIT 0**（G2 150/0 · L2 53/0 · G12 38/0 · G13 32/0 · **G14 生产副本 Live Smoke 52/0** · G9 人工审计 PASS） |
| 快车道 | **PARTIAL（1 红，非本次改动）** | `pnpm fast` 52 道 / PASS 51 / FAIL 1 = `postlv2:role-tool:verify`（既存 `generic_bypass_arg` + 在途提醒线未同步夹具） |
| 量具有效性（正控/负控） | **PASS（同门两种档位一红一绿）** | 唯一变量 = `CHARACTER_MEMORY_WRITE_MODE`：带 `post_turn_model` ⇒ LangMem 门 **19/20**（bridge 检查红）；清掉 ⇒ **20/20** |
| 生产激活 | **EXECUTED（配置层）** | `.env` 8658 → 8889 字节 · 严格 UTF-8 通过 · `U+FFFD`=0 · 生效档位实读 `memoryPostTurnModelEnabled=false` |
| 真实链 | **NOT TAKEN** | 本轮**未启动核心**（见"未做"） |
| 自然首轮 | **NOT OBSERVED** | 同上 |
| 人审 | **不适用** | 本页没有需要人读的措辞产物（三句正文之类的读数不在本轮） |

### 改动前后的记忆写入面

```text
改前：受信 user_message →（回复后）post-turn-model-memory@1 → 模型闭集提案 → 原生 validator/事件/折叠
改后：受信 user_message →（回复后）automatic-memory-langmem@1 → LangMem 候选 → 既有值闸/冲突/validator/折叠
      ＋ 前台同步显式路径恢复（"记住 X" 当场写；回复可说"已记住"）
      ＋ 召回档**不变**：CHARACTER_MEMORY_RECALL_MODE=semantic_only（ADR-123 §7 继续生效）
```

## 换档的真实代价（必须记住的一条）

`(785, 944]` = 61 个事件 / **31 条受信 `user_message`**，而**这 31 条全部已被 post-turn 档判定过**、
"从未被任何档处理过"的洞 = **0**。
⇒ 这是**同一批原话的第二次判定**，不是补历史。

排空节奏：每次通知最多 **20** 个源事件（`automatic-memory.ts:70`），通知来自每轮回复后的
`void this.drainAutomaticMemoryTail()`（`main.ts:4790`）⇒ 约 **4 轮**对话排空；
回复不被阻塞，但头几轮的后台模型调用 / Python 子进程占用会升高。

## 当前停放状态（2026-10-10，用户裁定「先别起，我自己找时间」）

- 配置**已切换**（写入档 = LangMem），**核心仍停机**（6751/6752/12394 均 0 监听）⇒ **追赶尚未开始**。
- 两个水位都**不会自己动**（只有核心起来才走）：LangMem 仍 `785`、post-turn 仍 `944`。
  下次受控启动时，LangMem 会从 **786** 起处理到当时的账本末尾（本轮实测区间 `(785, 944]` = 61 事件 / 31 条原话；
  你越晚启动，这个区间只会**更长**，因为新对话在累积）。
- 下次启动的官方入口（**需逐字授权**，无授权 ⇒ 退出码 2）：

```powershell
pnpm coexist:check                                                   # 只读就绪判据，先看它怎么说
$env:PROJECT_LG_COEXIST_ACTIVATE='coexist@C:\Users\user\Desktop\project LG\data\pglite'
pnpm coexist:start
```

  启动后头几轮应看到 `[automatic-memory]` 日志（`status=cutover` 只在该处理器**首次**出现；
  本轮不会有 cutover，因为水位行已存在 ⇒ 直接是 `completed` 行，`created` 计数为真实写入数）。

## 未做（不因本页自动关闭）

1. **未启动共享核心**（因此：真实链 NOT TAKEN · 自然首轮 NOT OBSERVED · 31 条原话的实际二次判定结果未测）。
2. **未跑生产端点的真实模型档**（`postlv2:automatic-memory:live` 用的是测试端点 ark）。
3. **未修** ADR-123 立案根因里的两条独立缺陷：前台显式路径的内容规则（"叫我拔插头"→称呼）与
   记忆 pending 模板覆盖回复（2026-10-10 那轮答非所问）。
4. 未合并 / 未打标签 / 未提交（工作树含其它会话的在途改动，本页只登记自己的那一处）。

## 撤回

`.env` 去注释恢复 `CHARACTER_MEMORY_WRITE_MODE=post_turn_model` ⇒ 回到 ADR-123 档；
两个处理器水位**分开保留**，任一方向的回退都**不是**完整数据回滚（ADR-130 §6）。
