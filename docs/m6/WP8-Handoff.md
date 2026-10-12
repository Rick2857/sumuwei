# WP8 Handoff —— 规模、性能与已知容量边界

```text
Completed WP:            WP8（M6 / Lv1 Hardening；计划书 §WP8 L366–377；契约 M6-G7）
Commit / branch:         <见提交后的 git log> / feature/m6-lv1-hardening（= main）
Changed files:
  scripts/verify-m6-wp8.ts                            新增：WP8 门（S/M/C/B 四节 24 项断言 + 2 条子门 + Z1）
  scripts/m6-evidence.ts                              登记 `wp8-scale` / `wp8-retrieval-boundary`（必选门；`m6:gates` 变 **12** 道）
  artifacts/m6/m6-wp8-20260921-6dd9d093b628/scale.json               新增（规模与性能）
  artifacts/m6/m6-wp8-20260921-6dd9d093b628/retrieval-boundary.json 新增（检索上界，单列）
  docs/m6/WP8-Handoff.md                              本文件

User-owned dirty files preserved: **原样未动、未提交**
  artifacts/incidents/inc-01/wp1-lease.json
  （SHA-256 仍为 BB08C5BE9FE13FC6B739D67D00D29ED4921CB2E4D8FCD9D1B5D7F12184BA42B6）

Commands + exact exit codes:
  pnpm typecheck                                    → EXIT 0
  pnpm exec tsx scripts/verify-m6-wp8.ts            → EXIT 0（**24/24**；2 条子门 EXIT 0；**约 840s**）
  门内子步骤（逐条独立进程）:
    pnpm m4:scale:verify -- 1000    → 0（32s）   既有规模驱动（1,000）
    pnpm m4:scale:verify -- 10000   → 0（375s）  既有规模驱动（10,000）
    pnpm m4:scale:verify（默认）     → 0（32s）   子门：同型既有判据
    pnpm m5:verify                  → 0（0s）    子门：召回资格/排序部件级
  门内自有规模场景（10,302 个回放事件）  → 约 250s
  pnpm m6:gates                                     → EXIT 0（**Hard Gates = PASS**；必选门 **12** 个，未运行 0，未通过 0）

Evidence produced:
  artifacts/m6/m6-wp8-20260921-6dd9d093b628/scale.json（schemaVersion `m6-wp8-scale@1`）
  artifacts/m6/m6-wp8-20260921-6dd9d093b628/retrieval-boundary.json（schemaVersion `m6-wp8-retrieval-boundary@1`）

Real data/pglite digest before / after:
  8307173d8b8f12df818008e05356e2ad6df4a56e598347d039650919f39aa4d4（1205 文件 / 31,584,799 字节）
  ⇒ 本门运行前后**逐字相同**（Z1）。**本门没有打开真实库**。

旧固定证据路径（**按白名单恢复**，机械判定）:
  跑之前先记下 `git status --porcelain -- artifacts` 里**已脏**的路径，跑完只还原**新增出现**的那些
  （AGENTS.md §7）。实测被重写过 2 条、全部与索引逐字一致（`git diff --quiet` 退出 0）：
    artifacts/m4-acceptance/scale/scale-result.json   （既有驱动的固定输出，SHA 前后 a22f527b… 相同）
    artifacts/m5/wp2-eligibility.json                 （子门 m5:verify 的固定输出）
  跑前已脏 = ["artifacts/incidents/inc-01/wp1-lease.json"]（用户既有改动）⇒ **没被碰**

三种计数（分开报，互不冒充）:
  既有驱动：operations 1000 / 10000 · persisted events 1060 / 10600 · current active memories 620 / 6200
  自有规模场景：requested operations **7500** · persisted domain events **10302** ·
                replayed_event_count **10302** · current active memories **3566** · total memories 6934
  `replayed_event_count` 的**独立复算**口径（不由被测方自报）：
    `select count(*) from memory_events l join memory_records r on r.id = l.memory_id where r.owner_kind/r.owner_id = …`
    —— 这正是 `memory-store.ts:796`（`domainEventsForMemory`）读的那张表。

硬性质（规模下）:
  重放逐字段一致  重建 6934/6934，`mismatched = 0`，**连续两次**同一结果
  重复不膨胀      memories 6934 < requested 7500
  旧事实不物理覆盖  superseded 2802 / retracted 566 仍在库；每条 SUPERSEDED 都有 `superseded_by`（缺指针 0）
  非法内容不入投影  `unsupported = 0` · `contamination = 0`
  失效记忆不入模    retracted 566→567；**端口级 `hits` 里仍然有它**（够得着，不是空过）而
                   该轮 `selectedIds` 与上下文里**都没有**它
  上下文受预算约束  memory section **45 token** ≤ 配置 `memoryTokens` 800；候选 50 / 选中 1

性能与容量读数（采不到的都写明"不可得"，不编）:
  wall time 自有场景 · RSS 本进程 573,177,856 → 707,940,352 字节（**不是** PGlite 引擎占用，采不到）
  events/sec、库大小 202,621,222 字节（约 193 MB，10,302 个事件）
  投影行数 memory_records 6936 / subject_links 6936 / evidence_links 6936 / memory_events 10305
  召回读数 candidates 50 · scanned **6936** · selected 1 · 选入率 0.02 · 裁剪率 0
  **性能 SLA：未冻结 ⇒ 本门不判**（计划书 §WP8 明文：SLA 需先校准冻结，不临时拍秒数）

检索上界（`retrieval-boundary.json`，单列）:
  实测窗口 = `scanLimit = max(1, min(500, limit×5))`（生产 limit=50 ⇒ 250）+ **排序之前**的
  `filtered.slice(0, limit)`（⇒ 50 条）；`listBySubject` 无 LIMIT（读全量）但同样过那道切片。
  三档探针（同一批 6934 条记忆里）：最新第 1 名 **能召回**（正控）· 第 51 名 **召回不到** ·
  最老的一条 **召回不到**；`store.list(limit=1000)` 实际返回**恰好 500** 行。
  已登记的局限被**收细**：`docs/m5/M5-Acceptance-Report.md` 第 195 行「检索最多扫描 500 行」，
  本门实测在"同一 subject 下记忆数 > 50"时，可被排序的选择集其实是**最近 50 条**。
  契约结论：`M6-Acceptance-Contract.md` 的 **M6-G7** 只要求「覆盖上限如实暴露」，
  **没有**"跨全库召回"的要求 ⇒ 本子门不 FAIL（B4 直接读文件核对，不靠记忆）。

Deviations or NOT RUN items:
  1. **`m4:scale:verify` 的固定证据路径**：它写的是无 runId 的
     `artifacts/m4-acceptance/scale/scale-result.json`。计划书 §WP8 要求"保存新运行证据后按白名单恢复"，
     本门把这件事做成**机械判定**（跑前记脏、跑后只还原新增），并把它写进证据
     （`fixedEvidencePath.restoredByteExact`），而不是靠人记得还原。
  2. **第一次跑的三条红全是本门夹具自己的问题**，已逐条修好并把教训留在代码注释里：
     ① 规模循环的槽位用了 `scale.fact.${i}`（每个 i 都是新槽位）⇒ 修订/遗忘**永远找不到目标**，
        于是 `superseded = retracted = 0` 却在**空集**上判真（M2/M5 红）。
        修法：槽位 `i % SLOT_COUNT`，且"该槽位还没有记忆就先建一条"。
     ② 规模记忆用了 M4 夹具的 `M4_T0`（2027 合成时钟），而生产记忆走真实 `Date.now()`（2026）
        ⇒ 合成历史比生产记忆**还新**，`recordedAt desc` 的前 50 条全是 `scale.fact.*`，
        生产记忆永远进不了候选（C1 红：候选 50 / 选中 0 / 排除全 `LOW_RELEVANCE`）。
        修法：规模窗改到 **30 天前**（"一堆旧记忆 + 用户刚说一句话"的真实形状）。
     ③ 边界探针的时间戳手抖加了 `operationsRequested`，把"第 51 新"变成了"最新"
        ⇒ B2 量到的是"第 1 名能召回"，与它声称的"第 51 名召回不到"**不是同一件事**（B2 红）。
        修法：三档时间戳刻意排开并写进注释。
     ⇒ 这三条都是 `AGENTS.md` §6.2「量具自己也要被验证」的同型：**判据为真但量的不是那个东西**。
  3. **既有驱动的 10,000 次操作本身不满足 `replayed_event_count >= 10000` 的口径**：
     它的参数是**操作数**，回放条数要看 `memory_events`；1,000 次操作只有 1,060 个领域事件。
     计划书允许"补安全合成事件量"，因此本门**另建**一个 10,302 事件的规模场景
     （全部走 M4 放行口，与既有驱动同一套入口），**没有**改报告名冒充达标、也没有放宽分母。
  4. **规模下的自然语言遗忘被具名拒绝**（本门实测，登记为规模边界）：
     在 10,302 事件的库里说 `忘掉我不吃香菜这件事` ⇒ `not_written / target_ambiguous`
     —— 她**不猜**目标（这是 M4.1/D1 之后的设计意图），而同一句在 1–2 条记忆的库（WP7a）能解析成功。
     因此 C3 的"失效不入模"用**同一台状态机**（`applyStateChange('retract', …)`，即解析出目标之后
     `忘掉` 走的那一条）把目标置为 retracted，并把这次 NL 拒绝的**理由码**一起写进证据（C4）。
     ⚠️ 这条局限应进 `M6-Known-Limitations.md`（WP11 汇总）：**记忆越多，"忘掉某件事"越可能解析不出目标**。
  5. **不新造语料、不改驱动语义**：规模操作全部经 `makeCandidate` / `tryCommit` / `commitAndFold` /
     `applyStateChange` 四个既有放行口；没有开 LLM extractor，没有接向量库。
  6. **NOT RUN（留给后面）**：50/100/500 轮长对话（WP9a/WP9b）· 生产形状 Live（WP10b）·
     最终离线门与全量回归（WP10a）· 真人盲审（G1）。**性能 SLA 仍未冻结**，本门不主张任何达标线。

Root-cause status: 与 INC-01 无关（本门不碰真实库的写路径）；INC-01 根因仍是 `PARTIAL`。
```

---

## 下一步（不自动开工）

`WP9a — 长对话校准与行为阈值`：复用 M3 的 PC / SA / Drift / Recovery 定义，但**先核对分数方向**、
`count/rate/score` 的区别与 judge rubric（不能把 baseline 里字段名含 `Count` 的当原始次数）；
用**当前批准端点**与固定配置跑 50／100 轮**校准**，保留独立校准集与正式验收集，
随机种子／轨迹定义／rubric 在正式运行前**冻结**；新 baseline 写入 `artifacts/m6/`，
**不**执行旧 `--write-baseline` 覆盖 M3 历史文件；无明确最低质量线或 judge 失效时
质量门记 `NOT RUN / MEASUREMENT INVALID`。产出 M6-D3（阈值包）。
