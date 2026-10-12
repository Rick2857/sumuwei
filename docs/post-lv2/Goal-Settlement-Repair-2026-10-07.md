# 结清与重复确认修复记录（2026-10-07）

用户授权：放宽结清限制，修复过度追问及反复确认。裁定载体：[ADR-116](../adr/ADR-116-contextual-goal-settlement.md)。本轮修改代码和验收入口，不批量修改生产历史，不向真实 QQ 发消息。

## 行为与实现

- “已经拔了”等本人完成报告直接申请结清，无须额外结清口令。完成事实与“刚列出的那些”等范围可以跨轮结合。
- 解析器收到同会话、撤销遮蔽后的双方前文和当前候选；`@2` 草案支持最多 12 项的明确结清/只读确认集合，历史 `@1` 单目标仍可用。
- 多目标复用既有提案、放行口和完成证据判定。任一项失败整批不写；重复确认跳过已结清项，不复活取消或被替代项。
- 相关事项已结清时，范围补充和口头数量差异走只读确认；普通吃饭等报告无目标时正常回应，不制造“你想让我记录吗”的问题。
- 回复事实说明真实结清数量；只读确认按实际状态提供已结清计数。回复守卫在程序已核对的范围内阻止重复索要编号或结清授权。未解决的 `clarify` 不被守卫抹掉。
- 提醒设置解析把完成/结清报告交回目标域，不把完成确认误作新提醒设置。
- 生产主入口曾给编译器一个回合对象的浅副本，编译生成的 `goalFact`、`goalWriteReality`、`reminderResult` 无法回到定稿守卫。改为保持同一个回合对象，已有守卫才实际收到程序结果。

## 验证

所有写入试验均使用新隔离库；未打开或修写 `data/pglite`。真模型通过 `with-test-model` 使用 `.env.test`，QQ 是本机协议夹具，不是实际手机实收试验。

| 检查 | 本轮读数 |
|---|---|
| `goal:settlement:verify` 的结构、程序守卫、上下文门 | 17 项通过，含正控/负控/恢复 |
| 隔离库 + 真网关 + 真用户事件 + 真完成证据端口 | 6 项通过；第二项证据故障使整批零写入，原进程新请求恢复后写 3 项目标及 3 条兑现 |
| 真模型解析与真实隔离写入 | 8 项通过；三项语义负控分别覆盖未完成、只有范围无完成事实、只完成两项但对象未确定 |
| 主入口五轮真模型回复和账本读回 | PASS；`GOAL_COMPLETED=3`，`COMMITMENT_FULFILLED=3`，`GOAL_CREATED=4`（3 条事项 + 默认偏好），重复确认没有重写/重建 |
| `m10:test` / `m10:source:verify` / `m10:e2e:verify` | 59/59、45/45、19/19 |
| `m10.1:policy:verify` / `m10.1:e2e:verify` / `m10.1:context:verify` | 16/16、13/13、9/9 |
| `reminder:context:verify` | 部件门及主入口六轮均 PASS；浅副本故障修复后已恢复 |
| `postlv2:text-stream:verify` | PASS |
| `m5.1:measurement:verify` / `m5.1:regression:verify` / `m5.1:gates` | 16/16、PASS、PASS；回归读取本轮最终 CI 日志，其余历史门按既有证据继承 |
| `typecheck` | EXIT 0 |
| 完整 `m4.5:ci` | 首轮类型错误 FAIL；修正后两次 EXIT 0，最后一次覆盖最终代码 |

主要证据：

- [修复前四项失败](../../artifacts/post-lv2/goal-settlement-1791357491416/evidence.json)
- [结构及程序守卫验证](../../artifacts/post-lv2/goal-settlement-1791358998138/evidence.json)
- [真模型语义负控及隔离写入](../../artifacts/post-lv2/goal-settlement-live-1791358327055/evidence.json)
- [最终主入口五轮回复及实际账本](../../artifacts/post-lv2/goal-settlement-main-live-1791358977230/evidence.json)
- [提醒六轮恢复](../../artifacts/post-lv2/reminder-context-repair/main-current-1791358317019/evidence.json)
- [最终源码摘要及门退出码](../../artifacts/post-lv2/goal-settlement-final-1791359547498/evidence.json)

CI、各相关门的 UTF-8 日志及退出码保存在本地 `data/diagnostics/goal-settlement-20261007/`，不入仓库。共享工作树存在其他在途改动，本记录不是新里程碑的干净树发布证明；完整离线门的 G14 是继承的 52/0，本轮新跑的真模型证据是上表所列结清试验。

## 失败记录与限度

1. 初始主入口复测中，三条虽已写成完成，后续“两条都是”仍触发澄清并实际追问；补充解析规则和程序守卫后复测。失败档 `goal-settlement-main-live-1791358031456`、`1791358479796` 保留。
2. 量具最初把“不用再确认”“不需要再确认”及“说清楚就行”的确认口吻当成追加追问。量具已修，并增加正常确认/真实追问/恢复三段自证；对应 `1791358172840`、`1791358367406`、`1791358801474` 的原 FAIL 不回写。最后一份的实际账本已经完成三条，FAIL 属量具误报。
3. `goal-settlement-live-1791358268502` 的范围负控遇到 8 秒解析超时，按失败保存，不算语义错误或通过。新请求负控通过。最终五轮主入口的数量更正轮也有真实超时，回复如实说明已有交代无需重复；既有三条完成事件保留，后续范围确认仍正常。
4. 提醒六轮的初次 FAIL `reminder-context-repair/main-current-1791358214509` 揭示了回合对象副本的结果丢失；修复后新证据通过。它属于当前主入口的事实传递问题，不归咎于提醒内容或用户措辞。
5. 放宽的是完成报告和范围理解；不把 API 接受当收件、不把用户报告当程序观测、不用 `user_report` 替代 `action_result` / `conversation_output`，也不自动关闭默认偏好或新的未来约定。

## 生效

源代码已接线，无新增配置开关或数据库迁移。现有 QQ/LG 进程需要正常重启后加载新代码；本轮只启动了隔离验收进程。真实历史里的旧记录保留，后续本人完成报告可通过新入口处理。

## 共享工作树交接

本轮产物交给用户及后续接管会话按路径复核，未将共享文件内其他在途改动一并提交。修改范围：`goal-proposal.ts`、`goal/understanding.ts`、`goal/turn.ts`、`openai-goal-understanding.ts`、`turn-gateway.ts`、`main.ts`、`goal-sections.ts`、`goal/claim-guard.ts`、`reply-guard-chain.ts`、`reminder-turn.ts` 和 `package.json` 的两条新命令。新增三个 `scripts/goal-settlement-*.ts`、ADR-116、本记录及 `artifacts/post-lv2/goal-settlement-*` 验收档。共享文件的会话前副本和本轮 CI 日志位于上述本地诊断目录；接管时应核对差异，保留其他会话的产物。
