# WP6b Handoff —— 重启、关闭与恢复（INC-01 保护的集成验收）

```text
Completed WP:            WP6b（M6 / Lv1 Hardening）
Commit / branch:         <见提交后的 git log> / feature/m6-lv1-hardening（= main）
Changed files:
  scripts/verify-m6-wp6b.ts                         新增：WP6b 门（15 项断言 + 6 条必跑子门）
  scripts/m6-evidence.ts                            登记 `wp6b-restart-recovery`（必选门；`m6:gates` 变 8 道）
  scripts/verify-m4-hardkill.ts                     **判据更正**：硬编码 `schemaVersion === 5` ⇒ `=== latestSchemaVersion()`
  artifacts/m6/m6-wp6b-20260921-82d815e66ddf/restart-recovery.json   新增（本门证据）
  artifacts/m6/m6-wp3-reader-20260921-82d815e66ddf/                  子门 `verify-m6-wp3-reader.ts` 的 runId 证据
  artifacts/incidents/inc-01/{verify-aggregate,wp2-snapshot,wp3-close,wp4-integration,wp5-restore-drill}.json
                                                    子门 `inc-01:verify` 重跑刷新（runId / 读数；verdict 未变）
  docs/m6/WP6b-Handoff.md                           本文件

User-owned dirty files preserved: **原样未动、未提交**
  artifacts/incidents/inc-01/wp1-lease.json
  （SHA-256 前后逐字相同：BB08C5BE9FE13FC6B739D67D00D29ED4921CB2E4D8FCD9D1B5D7F12184BA42B6）
  ⚠️ `inc-01:verify` 刻意不重跑 WP1 的门（它会重写上面这个文件）。

Commands + exact exit codes:
  pnpm typecheck                                    → EXIT 0
  pnpm exec tsx scripts/verify-m6-wp6b.ts           → EXIT 0（**15/15**；子门 6/6 EXIT 0；约 182s）
  子门（逐条独立进程，本门逐条记录退出码）:
    pnpm inc-01:verify            → 0（93s）   租约/快照/收尾/状态机/恢复五门聚合
    pnpm m4:restart:verify        → 0（66s）   **两个不同进程**之间的写→关→重开→逐项读回
    pnpm m4:restore:verify        → 0（7s）
    pnpm m4:isolation:verify      → 0（4s）
    pnpm m4:hardkill:verify       → 0（8s）   ← 更正判据前是 **19/1（EXIT 1）**，见 Deviations 第 1 条
    verify-m6-wp3-reader.ts       → 0（3s）   摘要读取面只读 + 摘要不持久化
  pnpm m6:gates                                     → EXIT 0（**Hard Gates = PASS**；必选门 **8** 个，未运行 0，未通过 0）

Evidence produced:
  artifacts/m6/m6-wp6b-20260921-82d815e66ddf/restart-recovery.json
    （schemaVersion `m6-wp6b-restart-recovery@1`：6 条子门读数 · 9 项 drill 断言 ·
      **itemCoverage 映射表**（计划书 §WP6b 的 6 条要求各由哪条读数承载）· 真实库前后摘要）

Real data/pglite digest before / after:
  8307173d8b8f12df818008e05356e2ad6df4a56e598347d039650919f39aa4d4（1205 文件 / 31,584,799 字节）
  ⇒ 本门运行前后**逐字相同**（D9）；与 WP0 基线的关系按"漂移有据"判（共用 `scripts/inc-01-real-db-drift.ts`）。
  **本门没有打开真实库**：所有演练都在 `%TEMP%` 的可抛弃 fixture 上。

Measurements and measured_count:
  真实库 measured_count = 1205（> 0）
  摘要重建读数：`scannedEventCount = 3`、`items = 2`、`sourceRefs = 2`、两次 blockText 逐字一致
  owner record：硬杀之后 `cleanClose` **未写**（= 不假装干净收尾）；由 OS 释放租约
  零命中自检：`checks.length > 0` 且 `scannedEventCount > 0`，否则整门 MEASUREMENT INVALID

Positive / negative / recovery controls:
  D1 ⑥ 四处读数同一 runId（收尾 / manifest / 源摘要 / 恢复）
  D2 ② 摘要不持久化 ⇒ 同一源集合重建**逐字一致**（同一选择器、同一策略版本、两次调用）
  D3 ⑤ 前置：fixture 上建立 verified 快照（目录 + manifest），manifest 摘要 == 源摘要
  D4 ⑤ **损坏快照 ⇒ 拒绝**（`snapshot_digest_mismatch`），且**拒绝之后目标库一个字节没变**
        （这条直接对立于"静默初始化空库冒充恢复"）
  D5 ⑥ 隔离 root 上恢复：就位摘要 == manifest；旧库被**改名挪到 quarantine**（不删、不覆盖）
  D6 ③ 重复恢复**不产生重复数据**：第二次 apply 后内容与 manifest 仍逐字一致、快照未被搬动
        （⚠️ 真实语义是"再做一次原子切换"（幂等重放），**不是**被拒 —— 判据按实测写，见 Deviations 第 3 条）
  D7 ④ `taskkill /F` 强杀 ⇒ 租约由 OS 释放、新进程**立刻**重新取得；owner record 停在**未 clean**
  D8 ⑥ 注入第二次 rename 失败 ⇒ `promote_failed`、旧库仍在 quarantine、**dataDir 没有被静默重建**
  D9 ⑧ 真实库只读摘要前后逐字不变

Deviations or NOT RUN items:
  1. **`m4:hardkill:verify` 的判据被更正（原本是既有红）**：它硬编码
     `schema 版本仍然是 5（迁移记录没被写坏）`。那是 M4 年代的读数；之后仓库发布了 v6…v9，
     隔离库会自动升到最新 ⇒ 该断言在任何新建隔离库上**必然为假**（实测 v9，19/1 EXIT 1）。
     这条断言的**本意**是"强杀没有把迁移记录写坏"，正确形状是
     **等于代码里的最新版本**（`latestSchemaVersion()`）—— 与其同型的
     `verify-m4-real-db.ts` 早就做过同一处更正（注释里写着"M4.5 起这条判据不再写死 5"）。
     更正后 20/0 EXIT 0。**这是判据更正，不是放宽**：它现在检查的是"与代码一致"。
  2. **`taskkill /F` 必须杀整棵树**（本门实测到的坑）：`tsx` 的 CLI 会再起一个 node 子进程；
     只杀父进程时孙进程仍活着并**继续持有 named pipe 租约**（实测 `heldAfterKill=true`）。
     正确做法：`taskkill /PID <pid> /T /F` + 再按子进程自报的 pid 补一刀 + 等 OS 释放（最多 10s）。
     （`verify-m4-hardkill.ts` 里记过同型现象："杀掉的是 shell 而 node 子进程还活着"。）
  3. **重复恢复的真实语义已按实测登记**：第 ⑥ 条要求"不产生重复副作用或记忆膨胀"，
     实测的形态不是"第二次被拒"，而是"**幂等重放**：再做一次原子切换，多留一个 quarantine，
     内容逐字相同"。判据据此写，并把 quarantine 数量如实报进证据（=2）。
  4. **计划书 §WP6b 的第 ① 条（新进程读回 ID/事件/projection/qualification）由子门
     `m4:restart:verify` 承载**，本门不重复实现 —— 它的命题就是这件事，而计划书正是把它列进"必跑"。
     证据里有一张 `itemCoverage` 映射表，逐条写明每条要求由哪条读数负责，避免"两套判据互相冒充"。
  5. 子门重跑刷新了 `artifacts/incidents/inc-01/` 的 5 份证据（runId/读数；verdict 未变）；
     被重新生成的 M4 历史证据按白名单还原（`m4-acceptance/{hardkill,isolation,restore}`）。
  6. **NOT RUN**：WP7/WP8/WP9a/WP9b/WP10a/WP10b/WP11 与 G1 盲审（本轮只做 WP6b）。

Root-cause status（与 INC-01 有关的部分）:
  INC-01 的根因仍是 `PARTIAL`；WP6b 只是把它的**保护措施**在"重启/关闭/恢复"这条链上做了集成验收，
  不主张任何根因结论。
```

---

## 下一步（不自动开工）

`WP7 — 多轮自然语言与跨模块组合`：A–E 五类剧情（一周式变化 / 错误与修正 / 假设与虚构 /
污染与来源 / 遗忘）+ 计划书列出的额外覆盖（另一用户隔离、重复动作、目标含糊拒绝、
沙箱文件写后读回、显式禁止联网、私人对象、搜索成功/空结果/超时、同轮记忆+搜索+摘要预算竞争、
跨午夜、干跑），每例至少一次**真实自然语言端到端**（不用内部 API 代替用户表达），
证据 `artifacts/m6/<runId>/e2e.json` + 本地评审包。

---

## 补记（WP7a 期间）：证据计数形状更正 + 本门证据重生成

WP7a 期间发现 `m6:gates` 在本门（以及任何把计数放在嵌套对象里的门）上打出**假红**：

```text
⚠️ rollup_no_positive_example: passed = 0：一条正控都没过，却声称有结论
```

根因：`m6-evidence.readLandedEvidence` 只读**顶层** `passed` / `failed` / `measurementInvalid`，
而本门把它们放在 `measurements` 里 ⇒ 汇总一律读成 `passed = 0`。数字对，但描述的不是那个东西
（同型教训见 `AGENTS.md` §6.9）。

```text
改动:  scripts/verify-m6-wp6b.ts       证据 JSON 补顶层 `passed` / `failed` / `measurementInvalid`
重跑:  pnpm exec tsx scripts/verify-m6-wp6b.ts   → EXIT 0（15 项断言 / 0 失败；子门 6/6 EXIT 0）
新证据: artifacts/m6/m6-wp6b-20260921-421e2081066f/restart-recovery.json（passed=15）
        + artifacts/m6/m6-wp3-reader-20260921-421e2081066f/（子门证据）
旧证据: artifacts/m6/m6-wp6b-20260921-82d815e66ddf/ **保留不删**（历史读数；verdict 同为 PASS）
汇总:  pnpm m6:gates → Hard Gates = PASS（必选门 9 个；**两条假红都消失**）
        —— 本门 passed=15、WP7a passed=17
副作用: 子门重跑刷新了 `artifacts/incidents/inc-01/` 的 5 份证据与
        `artifacts/m4-acceptance/{hardkill,isolation,restore}`、
        `artifacts/m4.1/nl-mutation.json`、`artifacts/m4.5/nl-action.json`
        （逐份核对：`verdict` 行 0 处变化，只有 runId / 时间戳 / 计数字段），按**白名单**还原。
        `artifacts/incidents/inc-01/wp1-lease.json`（用户既有改动）**未被触碰**：
        SHA-256 仍为 BB08C5BE9FE13FC6B739D67D00D29ED4921CB2E4D8FCD9D1B5D7F12184BA42B6。
```
