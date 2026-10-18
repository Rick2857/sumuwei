# `scripts/` 条目清单（自动生成 —— **不要手改**）

> 生成：`pnpm scripts:catalog` · 校验：`pnpm scripts:catalog:verify`（门 `scripts:catalog:verify`）。
> 生成器：[`scripts/gates/scripts-catalog.ts`](../../scripts/gates/scripts-catalog.ts)。
> ⚠️ 本文件**没有时间戳**：`--check` 要求逐字节可复现，时间戳会让它每次都"过期"。
> ⚠️ 它**不改名、不删条目**：把"现状"变成可查的；收敛命名是独立的破坏性变更。

## 分类规则（机械、可复核，按顺序判定）

| 类别 | 判据 | 含义 |
|---|---|---|
| **已登记门** | 条目名 ∈ `ALL_GATES` 的 id 集合 | 可被 lane / `pnpm fast` 调度，有资源声明与冲突图保护 |
| **汇总/链入口** | 名字匹配 `:(gates|gates:verify|ci|ci:full)$` | 里程碑或链的收口命令（只读汇总，或串行链） |
| **文档入口** | `AGENTS.md` / `README.md` 里**逐字出现** `` `名字` `` | 有人类读的入口说明（写在 `AGENTS.md` / `README.md` 里） |
| **内部** | 以上都不是 | **内部件**：由别的脚本或门调用、或一次性排查用 —— 不是对外入口 |

## 计数

| 类别 | 条目数 |
|---|---:|
| 已登记门 | 246 |
| 汇总/链入口 | 18 |
| 文档入口 | 2 |
| 内部 | 416 |
| **合计** | **682** |

`scripts/` 下**没有任何 pnpm 入口引用**的脚本文件：**285 个**（见文末）。

## 每条 lane 的入口命令

| lane | 入口 | 说明 |
|---|---|---|
| `postgresql` | — | PostgreSQL 迁移（真 PG 实例上的门） |
| `m11.1` | `pnpm m11.1:gates` | M11.1 离线控制 |
| `desktop-control` | `pnpm desktop-control:verify` · `pnpm desktop-control:probe` | ADR-106 桌面查看与操作（离线夹具 + 实机只读探针） |
| `productivity` | — | 第二批（productivity）与浏览器 sidecar 的门 |
| `offline` | `pnpm m4.5:ci` · `pnpm fast:offline` | M4.5 离线门链（`pnpm m4.5:ci` 的展开，34 条） |
| `summaries` | `pnpm gates:run --lane summaries` | 里程碑汇总门（只读已落盘证据，秒级） |
| `all` | `pnpm gates:run --lane all` | 全部已登记的门 |
| `td` | `pnpm td:gates` | TD 专项门（搜索可靠性与隐私边界；离线、秒级） |
| `m9` | `pnpm m9:gates` | M9 信念域门（离线；计划 §16.2 登记） |
| `m9.5` | `pnpm m9.5:gates` | M9.5 语义记忆召回门（离线；计划 §16.1 登记） |
| `m10` | `pnpm m10:gates` | M10 目标域门（离线；计划 §12 登记） |
| `m10-semantic` | `pnpm m10-semantic:gates` | M10 语义档（真模型；计划 §16.1 的"三 lane 分开"之一） |
| `memory-coverage` | `pnpm memory-coverage:gates` | 「记忆体量」线门（离线；D-6 裁定后的新线，2026-09-30） |
| `m9.6` | `pnpm m9.6:gates` | M9.6（Jev 适用性）离线门（2026-10-04 登记） |
| `postlv2` | `pnpm postlv2:s8:gates` | post-Lv2 的 S8 离线门（2026-10-04 登记） |
| `postlv2-controls` | `pnpm postlv2:controls:gates` | post-Lv2 新增离线控制（2026-10-05 登记；`AUD-20261005-03`） |
| `lv2` | `pnpm lv2:gates` · `pnpm lv2:inherited:gates` | Lv2 综合验收离线门（2026-10-04 登记） |
| `summaries-all` | `pnpm summaries:all` | 全里程碑只读汇总门（21 道，含更晚里程碑；2026-10-04 新增） |
| `scripts` | `pnpm scripts:gates` | 脚本清单门（`P2-11`；离线、只读） |
| `affected` | `pnpm fast` | 按改动面推导（`AGENTS.md` §5 的机器版） |

## 按前缀分列

### `a1`（24 条）

**入口**：
- `a1:gates` — 汇总/链入口

**已登记门（19）**：`a1:admin:entry:verify` · `a1:audit:verify` · `a1:auth:http:verify` · `a1:auth:verify` · `a1:cognition-reader:verify` · `a1:cognition:verify` · `a1:core-stop:verify` · `a1:effective-config:verify` · `a1:gates:verify` · `a1:goals-commitments:verify` · `a1:goals-reader:verify` · `a1:jobs-admit:verify` · `a1:jobs-store:verify` · `a1:jobs:verify` · `a1:page:verify` · `a1:query:verify` · `a1:safety-quota-reader:verify` · `a1:safety-quota:verify` · `a1:serve:verify`

**内部（4）**：`a1:admin:init` · `a1:admin:serve` · `a1:jobs-admit:live:verify` · `a1:serve:db:live:verify`

### `action`（4 条）

**内部（4）**：`action:audit` · `action:list` · `action:show` · `action:trace`

### `admin`（1 条）

**内部（1）**：`admin:audit:readback`

### `avatar`（3 条）

**内部（3）**：`avatar:3d:stop` · `avatar:3d:test` · `avatar:3d:test:live`

### `backfill`（2 条）

**内部（2）**：`backfill:apply` · `backfill:preview`

### `capability`（1 条）

**内部（1）**：`capability:audit`

### `chat`（1 条）

**内部（1）**：`chat`

### `ci`（1 条）

**入口**：
- `ci:offline` — 文档入口

### `cli`（1 条）

**内部（1）**：`cli:exit:verify`

### `coexist`（6 条）

**内部（6）**：`coexist:chat` · `coexist:check` · `coexist:pet` · `coexist:prepare` · `coexist:start` · `coexist:stop`

### `db`（4 条）

**入口**：
- `db:init` — 文档入口

**内部（3）**：`db:inspect` · `db:restore` · `db:snapshot`

### `deploy`（3 条）

**内部（3）**：`deploy:assets` · `deploy:pg:selftest` · `deploy:verify`

### `desktop-control`（3 条 · **有同名 lane**）

**已登记门（2）**：`desktop-control:probe` · `desktop-control:verify`

**内部（1）**：`desktop-control:act`

### `diagnose`（1 条）

**内部（1）**：`diagnose:repeat`

### `doc`（2 条）

**内部（2）**：`doc:check` · `doc:sync`

### `dump`（1 条）

**内部（1）**：`dump:prompt`

### `eval`（20 条）

**已登记门（7）**：`eval:dryrun` · `eval:m3` · `eval:m4` · `eval:otlp` · `eval:providers` · `eval:scenarios` · `eval:telemetry`

**内部（13）**：`eval:m3:live` · `eval:m3:promptfoo` · `eval:m3:promptfoo:build` · `eval:m4:extraction` · `eval:m4:extraction:live` · `eval:m4:promptfoo` · `eval:m4:promptfoo:assertions` · `eval:m4:promptfoo:build` · `eval:m4:promptfoo:live` · `eval:phoenix-chat` · `eval:promptfoo` · `eval:promptfoo:build` · `eval:real`

### `extractor`（1 条）

**已登记门（1）**：`extractor:value-boundary:verify`

### `fast`（2 条）

**内部（2）**：`fast` · `fast:offline`

### `gates`（3 条）

**内部（3）**：`gates:profile` · `gates:run` · `gates:verify`

### `goal`（2 条）

**内部（2）**：`goal:settlement:live` · `goal:settlement:verify`

### `history`（1 条）

**内部（1）**：`history`

### `inc-01`（6 条）

**已登记门（1）**：`inc-01:gates`

**内部（5）**：`inc-01:first-snapshot` · `inc-01:measurement:verify` · `inc-01:regression:verify` · `inc-01:test` · `inc-01:verify`

### `inspect`（1 条）

**内部（1）**：`inspect`

### `kernel`（5 条）

**已登记门（4）**：`kernel:test` · `kernel:test:conversation` · `kernel:test:identity` · `kernel:verify`

**内部（1）**：`kernel:status`

### `learning`（1 条）

**已登记门（1）**：`learning:contracts:verify`

### `lv2`（14 条 · **有同名 lane**）

**已登记门（7）**：`lv2:core:verify` · `lv2:gates` · `lv2:inherited:gates` · `lv2:measurement:verify` · `lv2:privacy:budget:verify` · `lv2:regression:read` · `lv2:repair:verify`

**内部（7）**：`lv2:baseline` · `lv2:corpus:freeze` · `lv2:diagnose:memory` · `lv2:restart:preflight` · `lv2:review:materials` · `lv2:short:live` · `lv2:trajectory`

### `m10`（32 条 · **有同名 lane**）

**已登记门（29）**：`m10:activation:readback` · `m10:activation:verify` · `m10:completion:verify` · `m10:context:verify` · `m10:coverage:verify` · `m10:docs:verify` · `m10:e2e:verify` · `m10:evidence:verify` · `m10:gates` · `m10:gateway:verify` · `m10:inputs:verify` · `m10:invalidation:verify` · `m10:long:live` · `m10:long:verify` · `m10:m11:verify` · `m10:measurement:verify` · `m10:observability:verify` · `m10:onpath:live` · `m10:oracle:verify` · `m10:preflight` · `m10:realdb:invariant` · `m10:regression:verify` · `m10:review:materials` · `m10:scale:verify` · `m10:semantic:dry` · `m10:semantic:eval` · `m10:smoke:live` · `m10:source:verify` · `m10:test`

**内部（3）**：`m10:baseline` · `m10:review:score` · `m10:wp0:admission`

### `m10-semantic`（1 条 · **有同名 lane**）

**入口**：
- `m10-semantic:gates` — 汇总/链入口

### `m10.1`（18 条）

**已登记门（1）**：`m10.1:gates`

**内部（17）**：`m10.1:a11:behavior` · `m10.1:activate` · `m10.1:activation:readback` · `m10.1:agreement:verify` · `m10.1:assembly:verify` · `m10.1:context:verify` · `m10.1:docs:verify` · `m10.1:e2e:verify` · `m10.1:expiry:verify` · `m10.1:inputs:verify` · `m10.1:long:live` · `m10.1:long:verify` · `m10.1:measurement:verify` · `m10.1:policy:verify` · `m10.1:review:materials` · `m10.1:smoke:live` · `m10.1:wp0:verify`

### `m11`（23 条）

**已登记门（1）**：`m11:gates`

**内部（22）**：`m11:ablation:verify` · `m11:activate` · `m11:activation:readback` · `m11:activation:verify` · `m11:adaptive:verify` · `m11:context:verify` · `m11:docs:verify` · `m11:e2e:verify` · `m11:inputs:verify` · `m11:invalidation:verify` · `m11:lineage:verify` · `m11:long:live` · `m11:long:verify` · `m11:measurement:verify` · `m11:observability:verify` · `m11:policy:verify` · `m11:recovery:verify` · `m11:regression:verify` · `m11:review:materials` · `m11:semantic:eval` · `m11:smoke:live` · `m11:wp0:verify`

### `m11.1`（20 条 · **有同名 lane**）

**已登记门（10）**：`m11.1:batch:verify` · `m11.1:behavior:control` · `m11.1:e2e:verify` · `m11.1:gates` · `m11.1:gates:verify` · `m11.1:measurement:verify` · `m11.1:privacy-performance:verify` · `m11.1:recovery:verify` · `m11.1:source:verify` · `m11.1:wiring:verify`

**内部（10）**：`m11.1:baseline:verify` · `m11.1:behavior:collect` · `m11.1:joint:verify` · `m11.1:production:preview` · `m11.1:provider:verify` · `m11.1:review:materials` · `m11.1:semantic:eval` · `m11.1:semantic:probe` · `m11.1:semantic:repair-probe` · `m11.1:short:live`

### `m2.5`（1 条）

**入口**：
- `m2.5:ci` — 汇总/链入口

### `m3`（8 条）

**入口**：
- `m3:ci` — 汇总/链入口
- `m3:ci:full` — 汇总/链入口
- `m3:gates` — 汇总/链入口

**已登记门（3）**：`m3:migrate-gate` · `m3:seed-check` · `m3:verify`

**内部（2）**：`m3:phoenix` · `m3:seed-baseline`

### `m3.5`（7 条）

**入口**：
- `m3.5:ci` — 汇总/链入口
- `m3.5:ci:full` — 汇总/链入口
- `m3.5:gates` — 汇总/链入口

**已登记门（2）**：`m3.5:test` · `m3.5:verify`

**内部（2）**：`m3.5:baseline` · `m3.5:baseline:check`

### `m4`（21 条）

**入口**：
- `m4:ci` — 汇总/链入口
- `m4:ci:full` — 汇总/链入口
- `m4:gates` — 汇总/链入口

**已登记门（11）**：`m4:faults` · `m4:isolation:verify` · `m4:mutation-safety:verify` · `m4:nl-mutation:verify` · `m4:promptfoo:assertions` · `m4:promptfoo:build` · `m4:promptfoo:run` · `m4:restart:verify` · `m4:restore:verify` · `m4:test` · `m4:verify`

**内部（7）**：`m4:audit` · `m4:backup:verify` · `m4:hardkill:verify` · `m4:memory-integrity:verify` · `m4:real-db:verify` · `m4:scale:verify` · `m4:smoke:live`

### `m4.5`（9 条）

**入口**：
- `m4.5:ci` — 汇总/链入口
- `m4.5:ci:full` — 汇总/链入口

**已登记门（6）**：`m4.5:audit` · `m4.5:gates` · `m4.5:measurement:verify` · `m4.5:nl-action:verify` · `m4.5:test` · `m4.5:verify`

**内部（1）**：`m4.5:smoke:live`

### `m5`（10 条）

**已登记门（1）**：`m5:gates`

**内部（9）**：`m5:budget:verify` · `m5:e2e:verify` · `m5:ranking:verify` · `m5:retrieval:verify` · `m5:runtime:verify` · `m5:smoke:live` · `m5:test` · `m5:trace:verify` · `m5:verify`

### `m5.1`（10 条）

**已登记门（1）**：`m5.1:gates`

**内部（9）**：`m5.1:control:verify` · `m5.1:e2e:verify` · `m5.1:measurement:verify` · `m5.1:observability:verify` · `m5.1:page:verify` · `m5.1:query:verify` · `m5.1:regression:verify` · `m5.1:spike:otlp` · `m5.1:test`

### `m5.1.1`（43 条）

**已登记门（1）**：`m5.1.1:gates`

**内部（42）**：`m5.1.1:d01:smoke:live` · `m5.1.1:final:verify` · `m5.1.1:k16:verify` · `m5.1.1:k17:verify` · `m5.1.1:k19:verify` · `m5.1.1:k20:verify` · `m5.1.1:k25:verify` · `m5.1.1:k29:verify` · `m5.1.1:migration:verify` · `m5.1.1:phase4:closure:verify` · `m5.1.1:phase4:preflight` · `m5.1.1:phase4a:verify` · `m5.1.1:phase4b:db-v9` · `m5.1.1:phase4b:preflight` · `m5.1.1:phase4b:verify` · `m5.1.1:prod-copy:verify` · `m5.1.1:test` · `m5.1.1:wp10a:verify` · `m5.1.1:wp10b:verify` · `m5.1.1:wp10c:verify` · `m5.1.1:wp11:verify` · `m5.1.1:wp3:verify` · `m5.1.1:wp3.2:verify` · `m5.1.1:wp4:verify` · `m5.1.1:wp4.1:verify` · `m5.1.1:wp5:verify` · `m5.1.1:wp5.1:verify` · `m5.1.1:wp6:verify` · `m5.1.1:wp6.1:verify` · `m5.1.1:wp7:preflight` · `m5.1.1:wp7:verify` · `m5.1.1:wp8:verify` · `m5.1.1:wp8c1:restore` · `m5.1.1:wp8c1:verify` · `m5.1.1:wp8c2:verify` · `m5.1.1:wp8c3:verify` · `m5.1.1:wp9:verify` · `m5.1.1:wp9a:verify` · `m5.1.1:wp9b:selection:verify` · `m5.1.1:wp9b1:verify` · `m5.1.1:wp9b2:verify` · `m5.1.1:wp9c0:verify`

### `m5.5`（6 条）

**已登记门（1）**：`m5.5:gates`

**内部（5）**：`m5.5:e2e:verify` · `m5.5:measurement:verify` · `m5.5:smoke:live` · `m5.5:test` · `m5.5:verify`

### `m5.5.1`（7 条）

**已登记门（1）**：`m5.5.1:gates`

**内部（6）**：`m5.5.1:e2e:verify` · `m5.5.1:measurement:verify` · `m5.5.1:semantics:live` · `m5.5.1:smoke:live` · `m5.5.1:test` · `m5.5.1:verify`

### `m6`（4 条）

**已登记门（1）**：`m6:gates`

**内部（3）**：`m6:live` · `m6:measurement:verify` · `m6:verify`

### `m6.1`（33 条）

**已登记门（1）**：`m6.1:gates`

**内部（32）**：`m6.1:acceptance:build` · `m6.1:attribution-replay` · `m6.1:budget:capability` · `m6.1:budget:compare` · `m6.1:corpus:build` · `m6.1:cross-run:verify` · `m6.1:e2e:verify` · `m6.1:extraction-audit` · `m6.1:extractor:repro` · `m6.1:failures` · `m6.1:freeze:candidate` · `m6.1:instrument:live` · `m6.1:judge:review` · `m6.1:judge:stability` · `m6.1:live` · `m6.1:measurement:verify` · `m6.1:preflight` · `m6.1:rce:program-repro` · `m6.1:recall-coverage` · `m6.1:recall-probe` · `m6.1:test` · `m6.1:update-turn:repro` · `m6.1:update-turn:service-repro` · `m6.1:wp0:baseline` · `m6.1:wp1:verify` · `m6.1:wp3:baseline` · `m6.1:wp3:closure` · `m6.1:wp3:judge` · `m6.1:wp3:trace` · `m6.1:wp4:closure` · `m6.1:wp5:attribution` · `m6.1:wp5:verdict`

### `m7`（18 条）

**已登记门（1）**：`m7:gates`

**内部（17）**：`m7:e2e:verify` · `m7:live` · `m7:live:level1` · `m7:live:td06` · `m7:live:td06:longform` · `m7:measurement:verify` · `m7:test` · `m7:wp0:admission` · `m7:wp0:baseline` · `m7:wp2:contracts` · `m7:wp3:probe` · `m7:wp3:verify` · `m7:wp4:verify` · `m7:wp5:verify` · `m7:wp6:td06` · `m7:wp6:td07` · `m7:wp6:verify`

### `m8`（11 条）

**已登记门（1）**：`m8:gates`

**内部（10）**：`m8:e2e:verify` · `m8:live:level1` · `m8:long:verify` · `m8:wp0:admission` · `m8:wp0:baseline` · `m8:wp2:contracts` · `m8:wp3:verify` · `m8:wp4:verify` · `m8:wp5:verify` · `m8:wp6:verify`

### `m8.5`（17 条）

**已登记门（1）**：`m8.5:gates`

**内部（16）**：`m8.5:activate` · `m8.5:blind:run` · `m8.5:corpus:verify` · `m8.5:e2e:verify` · `m8.5:instruction:probe` · `m8.5:live:level1` · `m8.5:long:verify` · `m8.5:shadow:run` · `m8.5:test` · `m8.5:verify` · `m8.5:wp3:contracts` · `m8.5:wp4:verify` · `m8.5:wp5:verify` · `m8.5:wp6:verify` · `m8.5:wp7:verify` · `m8.5:wp8:verify`

### `m9`（16 条 · **有同名 lane**）

**已登记门（14）**：`m9:context:verify` · `m9:e2e:verify` · `m9:gates` · `m9:invalidation:verify` · `m9:measurement:verify` · `m9:perf:baseline` · `m9:runtime:verify` · `m9:scale:verify` · `m9:source:verify` · `m9:test` · `m9:verify` · `m9:wp0:admission` · `m9:wp0:baseline` · `m9:wp0r:verify`

**内部（2）**：`m9:live:level1` · `m9:live:long`

### `m9.1`（9 条）

**已登记门（1）**：`m9.1:gates`

**内部（8）**：`m9.1:activation:readback` · `m9.1:e2e:joint` · `m9.1:e2e:verify` · `m9.1:measurement:verify` · `m9.1:smoke:live` · `m9.1:test` · `m9.1:verify` · `m9.1:wp0:repro`

### `m9.5`（42 条 · **有同名 lane**）

**已登记门（37）**：`m9.5:a3:arm` · `m9.5:a3:download` · `m9.5:aggregator:verify` · `m9.5:assembly:verify` · `m9.5:baseline` · `m9.5:build:verify` · `m9.5:calibration:verify` · `m9.5:compat:verify` · `m9.5:context:verify` · `m9.5:corpus` · `m9.5:e2e:verify` · `m9.5:embedding:download` · `m9.5:embedding:verify` · `m9.5:encoder:verify` · `m9.5:gatelist:verify` · `m9.5:gates` · `m9.5:hybrid:verify` · `m9.5:index:verify` · `m9.5:legacy-strength:verify` · `m9.5:lexical-calibration` · `m9.5:lifecycle:verify` · `m9.5:live-judge:verify` · `m9.5:long:verify` · `m9.5:measurement:verify` · `m9.5:migration:verify` · `m9.5:modes:verify` · `m9.5:poc` · `m9.5:privacy:verify` · `m9.5:probe:verify` · `m9.5:quality:verify` · `m9.5:recovery:verify` · `m9.5:regression:verify` · `m9.5:retrieval:verify` · `m9.5:scale:verify` · `m9.5:semantic:verify` · `m9.5:test` · `m9.5:validation:verify`

**内部（5）**：`m9.5:a3:smoke` · `m9.5:embedding` · `m9.5:live-judge-llm:verify` · `m9.5:maintain` · `m9.5:smoke:live`

### `m9.6`（14 条 · **有同名 lane**）

**已登记门（4）**：`m9.6:audit-parser:verify` · `m9.6:gates` · `m9.6:measurement:verify` · `m9.6:test`

**内部（10）**：`m9.6:audit-compare` · `m9.6:compare` · `m9.6:emotion:compare` · `m9.6:emotion:verify` · `m9.6:followup:aggregate` · `m9.6:followup:readback` · `m9.6:followup:summary` · `m9.6:followup:verify` · `m9.6:preflight` · `m9.6:probe:probability`

### `memory`（10 条）

**内部（10）**：`memory:audit` · `memory:automatic:retry` · `memory:automatic:status` · `memory:get` · `memory:history` · `memory:list` · `memory:replay` · `memory:retract` · `memory:sources` · `memory:stats`

### `memory-coverage`（3 条 · **有同名 lane**）

**入口**：
- `memory-coverage:gates` — 汇总/链入口

**已登记门（2）**：`memory-coverage:e2e` · `memory-coverage:verify`

### `migrate`（2 条）

**内部（2）**：`migrate` · `migrate:apply`

### `phoenix`（2 条）

**内部（2）**：`phoenix:down` · `phoenix:up`

### `postgresql`（15 条 · **有同名 lane**）

**已登记门（11）**：`postgresql:bench:verify` · `postgresql:g01:verify` · `postgresql:g02:verify` · `postgresql:g03:verify` · `postgresql:g04:verify` · `postgresql:g05:verify` · `postgresql:g06:verify` · `postgresql:g07:verify` · `postgresql:g08:verify` · `postgresql:g09:verify` · `postgresql:g10:verify`

**内部（4）**：`postgresql:cutover:apply` · `postgresql:goal-rebuild:apply` · `postgresql:live:smoke` · `postgresql:p02:verify`

### `postlv2`（91 条 · **有同名 lane**）

**入口**：
- `postlv2:controls:gates` — 汇总/链入口

**已登记门（32）**：`postlv2:affected:verify` · `postlv2:automatic-memory:recovery:verify` · `postlv2:avatar-opening:verify` · `postlv2:body:verify` · `postlv2:database-env:verify` · `postlv2:db:verify` · `postlv2:delivery:verify` · `postlv2:gate-selection:verify` · `postlv2:goal-deadline:verify` · `postlv2:goal-parallel:verify` · `postlv2:image:verify` · `postlv2:orchestration:verify` · `postlv2:oss-mechanisms:verify` · `postlv2:role-tool:path` · `postlv2:role-tool:verify` · `postlv2:s8:choice:verify` · `postlv2:s8:contracts:verify` · `postlv2:s8:daily:e2e` · `postlv2:s8:daily:verify` · `postlv2:s8:entry-lock:verify` · `postlv2:s8:gates` · `postlv2:s8:lifecycle:verify` · `postlv2:s8:measurement:verify` · `postlv2:s8:production:verify` · `postlv2:s8:reflection:verify` · `postlv2:s8:roots:verify` · `postlv2:s8:start:verify` · `postlv2:s8:state:verify` · `postlv2:s8:store:verify` · `postlv2:s8:withdraw:verify` · `postlv2:sequence-continuity:verify` · `postlv2:transport:verify`

**内部（58）**：`postlv2:appearance:verify` · `postlv2:asr:verify` · `postlv2:automatic-memory:live` · `postlv2:automatic-memory:verify` · `postlv2:avatar` · `postlv2:avatar-opening:chain` · `postlv2:avatar:live2d` · `postlv2:avatar:production` · `postlv2:avatar:production:verify` · `postlv2:avatar:verify` · `postlv2:baseline` · `postlv2:bridge:verify` · `postlv2:coexist:live` · `postlv2:coexist:matrix` · `postlv2:coexist:shells` · `postlv2:coexist:verify` · `postlv2:delegation-wire:verify` · `postlv2:delegation:real` · `postlv2:expression:verify` · `postlv2:goal-thinking:eval` · `postlv2:image:live` · `postlv2:memory-write:live` · `postlv2:memory-write:verify` · `postlv2:mic` · `postlv2:model-memory:live` · `postlv2:model-memory:verify` · `postlv2:playback-buffer:eval` · `postlv2:qq-proactive:chain` · `postlv2:qq-proactive:live` · `postlv2:qq-proactive:measurement:verify` · `postlv2:qq-proactive:verify` · `postlv2:role-tool:activation:readback` · `postlv2:role-tool:first-use:readback` · `postlv2:role-tool:known-dirs` · `postlv2:role-tool:live` · `postlv2:role-tool:main-live` · `postlv2:role-tool:matrix` · `postlv2:role-tool:semantic:eval` · `postlv2:s7:gate` · `postlv2:s7:live` · `postlv2:s8:activation-readback` · `postlv2:s8:activation-readback:db` · `postlv2:s8:baseline` · `postlv2:s8:daily:live` · `postlv2:s8:dev-probe` · `postlv2:s8:quote:ab:live` · `postlv2:s8:semantic:eval` · `postlv2:s8:semantic:recompute` · `postlv2:semantic:production:verify` · `postlv2:semantic:verify` · `postlv2:source-root:verify` · `postlv2:source:verify` · `postlv2:speech:verify` · `postlv2:story:build` · `postlv2:story:verify` · `postlv2:text-stream:verify` · `postlv2:tts:verify` · `postlv2:world:verify`

### `productivity`（5 条 · **有同名 lane**）

**已登记门（2）**：`productivity:sidecar:autostart:verify` · `productivity:verify`

**内部（3）**：`productivity:activation:readback` · `productivity:sidecar:check` · `productivity:wp0`

### `qq`（9 条）

**已登记门（3）**：`qq:group:coexist:verify` · `qq:group:verify` · `qq:reconnect:verify`

**内部（6）**：`qq:chat` · `qq:check` · `qq:prepare` · `qq:start` · `qq:status` · `qq:verify`

### `reminder`（6 条）

**已登记门（1）**：`reminder:channels:verify`

**内部（5）**：`reminder:channels:live` · `reminder:context:live` · `reminder:context:verify` · `reminder:planning:live` · `reminder:planning:verify`

### `reset`（1 条）

**内部（1）**：`reset`

### `s1`（4 条）

**已登记门（4）**：`s1:e1:verify` · `s1:isolation-stub:verify` · `s1:rejection-evidence:verify` · `s1:rejection-suite:verify`

### `scripts`（3 条 · **有同名 lane**）

**入口**：
- `scripts:gates` — 汇总/链入口

**已登记门（1）**：`scripts:catalog:verify`

**内部（1）**：`scripts:catalog`

### `search`（3 条）

**内部（3）**：`search:native:live` · `search:native:probe` · `search:native:verify`

### `seed-status`（1 条）

**内部（1）**：`seed-status`

### `snapshot`（1 条）

**内部（1）**：`snapshot`

### `story`（2 条）

**内部（2）**：`story:start` · `story:withdraw`

### `summaries`（1 条 · **有同名 lane**）

**内部（1）**：`summaries:all`

### `td`（1 条 · **有同名 lane**）

**入口**：
- `td:gates` — 汇总/链入口

### `td10`（1 条）

**已登记门（1）**：`td10:reliability`

### `td12`（1 条）

**已登记门（1）**：`td12:privacy`

### `test`（3 条）

**内部（3）**：`test` · `test:dry` · `test:guard`

### `thinhost`（1 条）

**内部（1）**：`thinhost:attribution`

### `typecheck`（1 条）

**已登记门（1）**：`typecheck`

### `u1`（16 条）

**已登记门（16）**：`u1:authorized-candidates:verify` · `u1:bridge-facts:verify` · `u1:completion:verify` · `u1:entry-scope:verify` · `u1:g18-wiring:verify` · `u1:gateway-scope:verify` · `u1:identity-store:verify` · `u1:identity:verify` · `u1:inbound-turn-scope:verify` · `u1:main-wiring:verify` · `u1:new-user-relationship:verify` · `u1:record-scope:verify` · `u1:record-visibility:verify` · `u1:recorder-identity:verify` · `u1:scope:verify` · `u1:write-path-labeling:verify`

### `utility`（1 条）

**内部（1）**：`utility:verify`

### `verify`（3 条）

**内部（3）**：`verify:decay` · `verify:l1` · `verify:state`

### `with-test-model`（1 条）

**内部（1）**：`with-test-model`

## 没有任何 pnpm 入口引用的脚本文件

判据：`scripts/` 下的脚本文件路径**不出现在任何** `package.json` 命令里（含子目录；跳过 `__pycache__`）。这些文件由别的脚本 import、由门调用、或是一次性排查件 —— **它们不是入口**。

- `scripts/action-harness.ts`
- `scripts/automatic_memory_langmem.py`
- `scripts/backfill-conversation-events.ts`
- `scripts/coexist/fingerprint.mjs`
- `scripts/coexist/harness.ts`
- `scripts/coexist/qq-proactive-shell.ts`
- `scripts/coexist/readiness.ts`
- `scripts/coexist/send-ctrl-c.mjs`
- `scripts/coexist/start-background.ps1`
- `scripts/deploy/tunnel-pc.ps1`
- `scripts/deploy/verify-posix-killtree.ts`
- `scripts/desktop-control/fixtures/fake-desktop-worker.py`
- `scripts/desktop-control/reply-chain.ts`
- `scripts/desktop-control/worker-actions-verify.py`
- `scripts/dev-page-harness.ts`
- `scripts/diag-db.ts`
- `scripts/diag-m3-coverage.ts`
- `scripts/diag-m3-judge.ts`
- `scripts/diag-m3-observation.ts`
- `scripts/diag-m3-runtime-integrity.ts`
- `scripts/diag-m3.5-columns.ts`
- `scripts/diag-m4-explicit.ts`
- `scripts/diag-model.ts`
- `scripts/diag-phoenix-spans.ts`
- `scripts/diag-seed-db-diff.ts`
- `scripts/diag-seed-diff.ts`
- `scripts/diag-state-db.ts`
- `scripts/fixtures/retired-tavily-config.ts`
- `scripts/fixtures/retired-tavily-search-provider.ts`
- `scripts/gate-evidence-select.ts`
- `scripts/gates/affected-map.ts`
- `scripts/gates/cache.ts`
- `scripts/gates/manifest.ts`
- `scripts/gates/reuse.ts`
- `scripts/gates/runner.ts`
- `scripts/gates/types.ts`
- `scripts/inc-01-lease-child.ts`
- `scripts/inc-01-real-db-drift.ts`
- `scripts/inc-01-rootcause/collect-evidence.mjs`
- `scripts/inc-01-rootcause/repro.mjs`
- `scripts/inc-01-rootcause/wal-oracle.mjs`
- `scripts/inspect-memory-integrity.ts`
- `scripts/kernel-test-kit.ts`
- `scripts/learning-skills-activation-readback.ts`
- `scripts/learning-skills-main-live.ts`
- `scripts/learning-skills/arxiv-server.py`
- `scripts/learning-skills/arxiv-worker.py`
- `scripts/learning-skills/install-arxiv.py`
- `scripts/live-smoke-source.ts`
- `scripts/lv2-evidence.ts`
- `scripts/lv2-gate-select.ts`
- `scripts/lv2-harness.ts`
- `scripts/lv2-m51-inherited.ts`
- `scripts/lv2-regression-evidence.ts`
- `scripts/m10-evidence.ts`
- `scripts/m10-gauge-audit.ts`
- `scripts/m10-harness.ts`
- `scripts/m10-review-diff.ts`
- `scripts/m10.1-gate-select.ts`
- `scripts/m11-evidence.ts`
- `scripts/m11.1-behavior-worker.ts`
- `scripts/m11.1-historical-behavior-score.ts`
- `scripts/m11.1-human-review-record.ts`
- `scripts/m11.1-json-schema-probe.ts`
- `scripts/m11.1-measurement.ts`
- `scripts/m11.1-model-batch.ts`
- `scripts/m11.1-prepare-corpus.ts`
- `scripts/m11.1-private-worker.ts`
- `scripts/m11.1-process-worker.ts`
- `scripts/m11.1-semantic-diagnostics.ts`
- `scripts/m18-post-migration-readback.ts`
- `scripts/m4-harness.ts`
- `scripts/m4.5-gate-select.ts`
- `scripts/m5.1.1-attribution-gate-registry.ts`
- `scripts/m5.1.1-k23-recorder-boundary.ts`
- `scripts/m5.1.1-post-migration-invariants.ts`
- `scripts/m5.5-fetch-recorder.mjs`
- `scripts/m5.5-harness.ts`
- `scripts/m5.5.1-corpus-audit.ts`
- `scripts/m5.5.1-gate-select.ts`
- `scripts/m5.5.1-semantics-stats.ts`
- `scripts/m6-command-surface.ts`
- `scripts/m6-evidence.ts`
- `scripts/m6-g1a-assemble.ts`
- `scripts/m6-wp0-baseline.ts`
- `scripts/m6.1-acceptance-corpus.ts`
- `scripts/m6.1-acceptance-items.ts`
- `scripts/m6.1-assembly-equivalence.ts`
- `scripts/m6.1-assembly-runtime.ts`
- `scripts/m6.1-command-surface.ts`
- `scripts/m6.1-confirmation-items.ts`
- `scripts/m6.1-contract.ts`
- `scripts/m6.1-control-sets.ts`
- `scripts/m6.1-cross-run-core.ts`
- `scripts/m6.1-evidence.ts`
- `scripts/m6.1-fmb-set-v2-generate.ts`
- `scripts/m6.1-fmb-set-v3-generate.ts`
- `scripts/m6.1-fmb-validation.ts`
- `scripts/m6.1-instrument.ts`
- `scripts/m6.1-judge-openai.ts`
- `scripts/m6.1-judge-quote-probe.ts`
- `scripts/m6.1-live-long.ts`
- `scripts/m6.1-long-gates-reeval.ts`
- `scripts/m6.1-long-scan-core.ts`
- `scripts/m6.1-long-sequence.ts`
- `scripts/m6.1-long-trajectories.ts`
- `scripts/m6.1-preflight-lib.ts`
- `scripts/m6.1-realdb-readout.ts`
- `scripts/m6.1-reply-extract.ts`
- `scripts/m6.1-run-guards.ts`
- `scripts/m6.1-run-manifest.ts`
- `scripts/m6.1-turn-context.ts`
- `scripts/m6.1-wp5-rejudge.ts`
- `scripts/m6.1-wp6-review-pack.ts`
- `scripts/m7-evidence.ts`
- `scripts/m7-level1-seed.ts`
- `scripts/m7-long-trajectory.ts`
- `scripts/m7-td06-judge.ts`
- `scripts/m7-td06-setup-inject.ts`
- `scripts/m7-trajectory-read.ts`
- `scripts/m8-evidence.ts`
- `scripts/m8-live-read.ts`
- `scripts/m8-long-trajectory.ts`
- `scripts/m8.5-corpus-verify.ts`
- `scripts/m8.5-live-drill.ts`
- `scripts/m8.5-live-read.ts`
- `scripts/m8.5-wp0-carryability.ts`
- `scripts/m8.5-wp0-provider-probe.ts`
- `scripts/m9-activation-readback.ts`
- `scripts/m9-evidence.ts`
- `scripts/m9-live-corpus.ts`
- `scripts/m9-live-fixture.ts`
- `scripts/m9-live-probe.ts`
- `scripts/m9-live-read.ts`
- `scripts/m9-long-forensics.ts`
- `scripts/m9.1-fixtures.ts`
- `scripts/m9.5-d5-scan.ts`
- `scripts/m9.5-encoder-smoke.ts`
- `scripts/m9.5-evidence.ts`
- `scripts/m9.5-semantic-index-readback.ts`
- `scripts/m9.5-wp6-rehearsal.ts`
- `scripts/m9.6-candidates.ts`
- `scripts/m9.6-emotion-corpus.ts`
- `scripts/m9.6-jev-protocol.ts`
- `scripts/m9.6-stats.ts`
- `scripts/math-worker-startup-verify.ts`
- `scripts/memory-coverage-evidence.ts`
- `scripts/model-stream-length-readback.ts`
- `scripts/postgresql-cutover-probe.ts`
- `scripts/postgresql/backup.ts`
- `scripts/postgresql/column-encoding.ts`
- `scripts/postgresql/credentials.ts`
- `scripts/postgresql/external-assets.ts`
- `scripts/postgresql/goal-fold-idempotency-probe.ts`
- `scripts/postgresql/goal-revision-probe.ts`
- `scripts/postgresql/init-probe.ts`
- `scripts/postgresql/inventory-probe.ts`
- `scripts/postgresql/inventory.ts`
- `scripts/postgresql/pg-exec.ts`
- `scripts/postgresql/pg-target-reader.ts`
- `scripts/postgresql/pglite-dump.ts`
- `scripts/postgresql/pglite-reader.ts`
- `scripts/postgresql/production-fingerprint.ts`
- `scripts/postgresql/production-touch-assessment.ts`
- `scripts/postgresql/projection-probe.ts`
- `scripts/postgresql/qualification-probe.ts`
- `scripts/postgresql/row-digest.ts`
- `scripts/postgresql/second-target-probe.ts`
- `scripts/postlv2_appearance_client.js`
- `scripts/postlv2_cosyvoice.py`
- `scripts/postlv2_expression_client.js`
- `scripts/postlv2_expression.py`
- `scripts/postlv2_image_upload.js`
- `scripts/postlv2_reminder_client.js`
- `scripts/postlv2_speech_client.js`
- `scripts/postlv2_voice_control.py`
- `scripts/postlv2_vtuber_runtime.py`
- `scripts/postlv2-bridge-production.ts`
- `scripts/postlv2-bridge-sandbox.ts`
- `scripts/postlv2-executor-run.ts`
- `scripts/postlv2-expression-frontend.py`
- `scripts/postlv2-expression-verify.py`
- `scripts/postlv2-image-input-python-test.py`
- `scripts/postlv2-interjection-probe.py`
- `scripts/postlv2-langmem-backlog-readback.ts`
- `scripts/postlv2-latency-readback.py`
- `scripts/postlv2-live-wake-verify.ts`
- `scripts/postlv2-lookup-notice-probe.ts`
- `scripts/postlv2-microphone.py`
- `scripts/postlv2-partial-live-probe.ts`
- `scripts/postlv2-partial-probe.py`
- `scripts/postlv2-playback-chain-probe.ts`
- `scripts/postlv2-production-env.ts`
- `scripts/postlv2-production-verify.py`
- `scripts/postlv2-resample-partial-probe.py`
- `scripts/postlv2-s8-store-restart.ts`
- `scripts/postlv2-semantic-index-probe.ts`
- `scripts/postlv2-status-verify.py`
- `scripts/postlv2-streaming-verify.mjs`
- `scripts/postlv2-streaming-verify.py`
- `scripts/postlv2-text-stream-readback.ts`
- `scripts/postlv2-text-stream-verify.py`
- `scripts/postlv2-timing-probe.ts`
- `scripts/postlv2-voice-control-verify.py`
- `scripts/postlv2-vtuber-setup.py`
- `scripts/postlv2-wake-coverage.ts`
- `scripts/postlv2-wake-name-table.py`
- `scripts/productivity-skills/assembly.ts`
- `scripts/productivity-skills/browser-fixture.ts`
- `scripts/productivity-skills/fix-encoding.mjs`
- `scripts/productivity-skills/fixtures.ts`
- `scripts/productivity-skills/groups-browser.ts`
- `scripts/productivity-skills/groups-common.ts`
- `scripts/productivity-skills/groups-files.ts`
- `scripts/productivity-skills/groups-news.ts`
- `scripts/productivity-skills/groups-office.ts`
- `scripts/productivity-skills/groups-weather.ts`
- `scripts/productivity-skills/groups.ts`
- `scripts/productivity-skills/live.ts`
- `scripts/productivity-skills/office-generate.py`
- `scripts/productivity-skills/reading.ts`
- `scripts/productivity-skills/sidecar-tools.ts`
- `scripts/public-ci.ps1`
- `scripts/qq/start.cmd`
- `scripts/qq/start.ps1`
- `scripts/reminder-channels-frontend-verify.mjs`
- `scripts/reminder-channels-shell-verify.py`
- `scripts/scenario-json.ts`
- `scripts/seed-m4.5-ledger-fixture.ts`
- `scripts/semantic-empty-recall-verify.ts`
- `scripts/semantic-encoder-pipe-verify.ts`
- `scripts/server-process-verify.ts`
- `scripts/test-persist-read.ts`
- `scripts/test-persist-write.ts`
- `scripts/text-scan.ts`
- `scripts/thinhost-ddl-decoupling-measure.ts`
- `scripts/thinhost-equivalence-verify.ts`
- `scripts/thinhost-initdb-verify.ts`
- `scripts/thinhost-steadystate-probe.ts`
- `scripts/thinhost-surface-verify.ts`
- `scripts/thinhost-wiring-verify.ts`
- `scripts/utility-skills/assembly.ts`
- `scripts/utility-skills/doc-runner.py`
- `scripts/utility-skills/fixtures.ts`
- `scripts/utility-skills/groups-document.ts`
- `scripts/utility-skills/groups-ocr.ts`
- `scripts/utility-skills/groups-web.ts`
- `scripts/utility-skills/groups.ts`
- `scripts/utility-skills/live.ts`
- `scripts/utility-skills/make-fixtures.py`
- `scripts/utility-skills/materialize-ocr-assets.ts`
- `scripts/utility-skills/probe-delivery.ts`
- `scripts/utility-skills/probe-documents.py`
- `scripts/utility-skills/probe-groups.ts`
- `scripts/utility-skills/probe-image-ocr.ts`
- `scripts/utility-skills/probe-rapidocr.ts`
- `scripts/utility-skills/probe-web-read.ts`
- `scripts/utility-skills/probe-web.ts`
- `scripts/utility-skills/setup-rapidocr.ts`
- `scripts/utility-skills/transport.ts`
- `scripts/utility-skills/verify-runner-contract.py`
- `scripts/verify-inc-01-wp1.ts`
- `scripts/verify-inc-01-wp2.ts`
- `scripts/verify-inc-01-wp3.ts`
- `scripts/verify-inc-01-wp4.ts`
- `scripts/verify-inc-01-wp5.ts`
- `scripts/verify-m6-wp10a-final-offline.ts`
- `scripts/verify-m6-wp10b-live.ts`
- `scripts/verify-m6-wp2-rollup.ts`
- `scripts/verify-m6-wp3-reader.ts`
- `scripts/verify-m6-wp3-wiring.ts`
- `scripts/verify-m6-wp5-console.ts`
- `scripts/verify-m6-wp6a-faults.ts`
- `scripts/verify-m6-wp6b.ts`
- `scripts/verify-m6-wp7a.ts`
- `scripts/verify-m6-wp7b.ts`
- `scripts/verify-m6-wp8.ts`
- `scripts/verify-m6-wp9a-calibration.ts`
- `scripts/verify-m6-wp9a2-discrimination.ts`
- `scripts/verify-m6-wp9b-long-dialogue.ts`
- `scripts/verify-production-lease-platform.ts`
- `scripts/verify-state.ts`
- `scripts/wechat-discretion-verify.ts`
- `scripts/wechat-group-verify.ts`
- `scripts/wechat-main-verify.ts`

