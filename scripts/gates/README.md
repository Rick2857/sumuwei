# 门执行器（`scripts/gates/`）—— 保质量地加速测试

> 这份文档写给"下一个人"：它记录**我们为什么敢并发跑门**、**每条判据的依据**、
> 以及**这套东西不主张什么**。
>
> 入口：`pnpm gates:run`（详表见 [`AGENTS.md`](../../AGENTS.md) §9 的"测试加速"一段）。
> 自证门：`pnpm gates:verify`（三段式，48 项检查）；CLI 退出延迟门：`pnpm cli:exit:verify`。

---

## 1. 它解决的是什么问题

`m4.5:ci` 是 34 条命令的 `&&` 串行链。实测（`artifacts/incidents/inc-01/regression.json`，
2026-09-21，`head = 6a16a35`）：

```text
inc-01:regression:verify 全量 2823s
├── m4.5:ci       749s   ← 34 道离线门串行
├── m4.5:ci:full 2065s   ← 其中又跑了一遍 m4.5:ci（749s）+ m4.5:smoke:live（≈1316s）
└── 其余 9 步       各 ≤9s
```

机器是 **24 逻辑核 / 39.7GB**，而链是**单路串行**。

本目录做三件事，**一件也不改门的断言**：

| Tier | 文件 | 做什么 |
|---|---|---|
| 0 | `runner.ts` | 逐门记 `seconds / exitCode / 与谁同时在跑`，落 `run.json` |
| 2 | `types.ts` + `manifest.ts` + `runner.ts` | 按**资源冲突图**调度并发；失败关闭 |
| 3 | `cache.ts` + `affected-map.ts` | 影响面映射（`AGENTS.md` §5 的机器版）+ 内容键缓存 |
| 1 | `reuse.ts` + `cache.ts#sourceTreeKey` | `inc-01` 回归里"离线段复用"的判据（由 `scripts/inc-01-regression.ts` 使用） |

**并发缺省 = 8 路（实测最优）**（用户 2026-09-27 裁定）：`--parallel` 不传时取 8（核数不足 8 的机器按核数走）。
安全性来自上面的资源冲突图，**不**来自"少开几路"；要串行就显式 `--serial`，要跑满就 `--parallel 24`。
`--mode release`（发布证据）仍强制串行 ⇒ **读数是性能调参，证据仍走串行路径**，两条互不冲突。

实测曲线（34 道离线门，全部 PASS、无抖动，**只改并发**）：

```text
串行 ≈749s · 6 路 87.2s · 8 路 88.8s · 16 路 91.9s · 24 路（跑满）96.5s
```

⇒ **"跑满机器"不是最快的**（比 8 路慢约 10%）：最重的那几道门互相抢 CPU
（`eval:m3` 6 路 80.4s → 24 路 93.1s），而墙钟由最长的那道门决定。
**换机器 / 换门集之后要复测**：对 `--parallel` 扫几个值、比 `run.json` 里的墙钟
（`pnpm gates:run --lane offline --parallel N`），**不要靠感觉改缺省**。

---

## 2. 为什么敢并发：资源声明的核查纪律

并行的唯一危险是**"看起来在正常工作"的读数失真**（两个门写同一份证据、抢同一个端口、
同时开真实库）。所以 `manifest.ts` 里每个门的 `resources` 是**人工逐文件核查**的结论，
写进 `why` 字段，可复核。核查过的事实（含行号级别的依据）：

```text
· 几乎所有门都走 isolateDatabase()（src/dev/sandbox.ts:81-124）——目录名含
  Date.now() + 进程内计数 ⇒ 每个进程天然唯一，跨进程并发不共享。
· eval:scenarios 由 evals/harness 逐场景 isolate + cleanupSandbox。
· 每个门只写"自己那一个"证据文件（component.json / pipeline.json / …）。
· 只有 verify-migrate-gate.ts 会读真实库：它 cpSync(PROD, workDir) 热复制一份
  （scripts/verify-migrate-gate.ts:165-166，INC-01 计划书 §12 已登记）⇒
  按 INV-DB-01 标为 parallel:'serial' + realDb:true，且**永不缓存**。
· eval:telemetry 直接读写 data/telemetry-dump.jsonl（真实库同级目录）⇒ 保守标 serial。
· 没有任何门改写 git 工作树（扫过 execFileSync/spawnSync 的 git 子命令）。
```

**失败关闭**：`resources.parallel` 没声明 = 不可并行；清单校验不过（依赖环、路径逃逸、
依赖指向不存在的门）⇒ **整个运行 REFUSED**，不"挑着跑"。

## 3. 证据纪律：快车道不留痕

`--mode fast`（默认）跑完会把**本次运行新弄脏的** `artifacts/**` 还原，并在还原后**复核**：

```text
新改写的已跟踪文件 → git checkout -- <path>
新增的未跟踪文件   → 删除
运行前就已经脏的   → **原样保留**（AGENTS.md §7 的教训：无差别还原会把
                     "你自己故意重写的证据"一起冲掉）
复核不通过（仍有新增脏路径）⇒ 运行判决 FAIL 并打印
```

这样"并行跑出来的绿"**不可能**被后面的 `*:gates` 汇总当成发布证据。
`--mode release` 则**强制串行**、**拒绝 `--cache`**、**不还原** —— 发布证据只能由它产出。

## 4. 缓存：只覆盖"确定没变"的部分

```text
键 = sha256( 入口脚本的相对 import 闭包内容 + 配置盐 + argv + node/tsx 版本 )
     · 闭包里出现**非字面量 import()** ⇒ 闭包不可信 ⇒ 退化为全仓输入
     · 脚本字面提到 evals/ 或 docs/ ⇒ 把整棵目录纳入（宁可粗，不可漏）
只复用 exitCode === 0 的读数（失败从不入缓存）
只对 parallel:'safe' + 非真实库 + 不碰 data/ 的门生效
命中在报告里永远标 CACHED（并写出被复用那次的 recordedAt）
```

### 规则澄清（2026-09-28，用户裁定 **甲**）：**只读目录摘要不算"碰真实库"**

```text
背景：M9.5 的每一道门都会 `digestTree(data/pglite)` —— 那是"**真实库前后摘要相同**"的证据本体。
      按字面读"不碰 data/"，它们**没有一条**够格 `parallel:'safe'`（见 `L-M95-24`）。
裁定（用户 2026-09-28）：**只读**目录摘要**不**算"碰真实库"，因为它：
  · **不取** INV-DB-01 的独占租约
  · **不打开** PGlite（只遍历/读取文件字节）
  · **不写**任何字节
⇒ 因此 `digestTree(data/pglite)` **不**剥夺 `parallel:'safe'` 资格。

⚠️ 仍然**必须**标 `serial` 的情形：
  · 打开/写入真实库（含 `cpSync` 热复制后打开）
  · **改写 git 工作树**（重新生成语料、或 `git checkout --` 还原白名单路径）
  · 写 `data/` 下**真实库以外**的共享文件（如 `data/telemetry-dump.jsonl`）
  · 声明者**不确定**
```

> **真实踩到**：第一版把 `evals/m4/promptfoo/`（`build-m4-promptfoo-config` 每步都会重写的
> **生成物**）算进指纹 ⇒ 指纹在两步之间"稳定地变了"，复用**永远不成立** ——
> 而它在输出上看起来完全正常。现在由 `pnpm gates:verify` 的 F2 负控钉住。

## 5. 不主张什么

```text
① 不主张"快车道的绿等于发布证据"。发布证据仍只来自：冻结命令清单 + 串行档 + 干净树。
② 不主张断言、阈值、fixture、证据 schema 有任何改动 —— 一个字节都没有。
③ 不主张并行档的**耗时**等于串行档（并发下单个门会更慢；快的是墙钟）。
④ 不主张所有门都能并行：`serial` 门（真实库、data/、声明不确定的）会被调度器
   安排在**独处**的时段，这是刻意的。
```

## 6. 相关门

```bash
pnpm gates:verify        # 执行器自证（正控/负控/恢复 三段式，48 项；含缓存与复用判据）
pnpm cli:exit:verify     # CLI 退出延迟门（守上游孤儿 30s 定时器不回来）
pnpm gates:run --lane summaries        # 只读汇总门，秒级体检
pnpm gates:run --lane affected --cache # 按改动面推导（§5 的机器版）
```
