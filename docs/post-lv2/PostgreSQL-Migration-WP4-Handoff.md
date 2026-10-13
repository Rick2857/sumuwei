# PostgreSQL 迁移 WP4：导出恢复与备份工具 —— Handoff（**部分交付**）

日期：2026-10-13（Asia/Shanghai）。runId：`pg-migration-wp4-20261013T1620`（比较器 + 导出）
/ `pg-migration-g07-20261013T092549Z`（在线备份 · 完整清单 · 库外资产）。
状态：**WP4 大部分交付** —— **规范化比较器**（`PG-G09` 量具本体）+ **固定版导出工具**
（PGlite 副本 → SQL → 空 PG **整条链已通**）+ **PG 在线备份与独立恢复**（`PG-G07` **47/47**）
+ **完整对象清单** + **数据库外资产清单与 manifest**；
**逐表内容比较**（51 张表的全列规范化摘要）**未开始**（见 §5，属 WP5）。
生产**未切换**；真实库**未被打开**。
上游：[执行计划](PostgreSQL-Migration-Execution-Plan-2026-10-12.md) §4/WP4 · §6 数据迁移与比较规程 ·
[ADR-132](../adr/ADR-132-postgresql-migration-backend-and-activation.md) ·
[验收契约](PostgreSQL-Migration-Acceptance-Contract.md)（`PG-G07` / `PG-G09`）·
[门矩阵](PostgreSQL-Migration-Gates-Matrix.md) · [WP3 Handoff](PostgreSQL-Migration-WP3-Handoff.md)。

---

## 1. 为什么先做比较器

计划 §4/WP4 的必交付物有六项（固定导出工具、PGlite 副本→SQL→空 PG、PG 在线备份→新库、
外部资产清单、完整清单、**规范化比较器**、导出/恢复日志、manifest、数据摘要）。

其中 **只有比较器不依赖 `@electric-sql/pglite-tools`** —— 那个依赖**仍未安装**（WP0 `L-PGM-02`），
所以导出那一支现在动不了。而比较器恰恰是**最要紧**的一件：

```text
迁移的完整性结论**全靠它**。比较器本身不可信 ⇒ 后面所有"一致"都不算数。
```

---

## 2. 它解决什么问题（这一节是 WP4 的技术核心）

同一份逻辑数据经 **PGlite** 与 **真 PostgreSQL** 两个驱动到达 JS 时**形状不同**：

| 类型 | 形状差异 |
|---|---|
| `bigint` | PGlite 可能给 `number 5`；pg 驱动**默认给字符串 `"5"`** |
| `jsonb` | PG **不保留键序** ⇒ `JSON.stringify` 会产出不同文本（**假不等**） |
| `numeric` | 可能是 `"1.50"` 或 `"1.5"` |
| 时间 | 可能是 `Date` 或字符串 |
| `bytea` | 可能是 `Buffer` 或 hex 字符串 |

⇒ 直接 `JSON.stringify(row)` 比出来的是**驱动的编码差异**，不是数据差异 ——
那就是本仓库反复记录的"**看起来合理但量的是别的东西**"。

### 2.1 归一化必须**按列类型**做，且带**类型家族标签**

⚠️ **这是本轮被自己的负控抓出来的一个真缺陷**（`F-WP4-01`）：

```text
第一版只按 JS 值的形状归一 ⇒
  bigint 5   → "5"
  text  "5"  → "5"        ← 撞在一起
⇒ 一个 bigint 列里的 5 与一个 text 列里的 "5" 会被判成"相同" —— **真的会漏掉差异**

门里那条专为此设计的负控（G09.1b）当场抓出来：
  FAIL  bigint 5 与 text "5" 归一成了同一个（5）⇒ 比较器会造出假相等
```

**修法**：归一化结果前面带**类型家族标签**（`n:` 数字 / `s:` 文本 / `j:` JSON / `b:` 布尔 /
`t:` 时间 / `x:` 二进制 / `v:` 向量），标签用控制字符与内容隔开。

⚠️ 标签是**家族级**而不是精确 SQL 类型级（`bigint` 与 `integer` 都算 `n`）。理由：
比较器比的是**同一张表的同一批逻辑数据**（两侧同一份列规格），而"源列 bigint、目标列 integer"
属于 **schema 差异**，由表清单/schema 比较去管，不该在这里表现成"每一行都不同"的噪声。

**连带修的一处测试设计问题**：两条测试原本把**具体编码**写死（`=== '5'` / `=== 't'`），
加标签后它们红了。改成断言**等价性**（三者归一成同一个）而不是编码 ——
编码是实现细节，不该被测试钉死。

### 2.2 比较策略（计划 §6.6 逐字）

```text
有主键  ⇒ 按主键排序 → 逐行摘要 → 分别给出「主键集合摘要」与「内容摘要」
          ⇒ 能把"少了/多了行"与"同一行的值变了"分成两个**具名**原因
无主键  ⇒ **稳定行多重集**比较（行摘要排序后哈希）
          ⇒ "不只比总数"：删一行加一行总数不变，但多重集变了
```

---

## 3. 交付物

| 文件 | 性质 | 内容 |
|---|---|---|
| `scripts/postgresql/row-digest.ts` | **新增** | 归一化（按列类型 + 家族标签）、行摘要、表摘要、比较器 |
| `scripts/postgresql/pglite-reader.ts` | **新增** | **只读**读一份 PGlite 副本的表内容（WP5 也会用） |
| `scripts/postgresql/credentials.ts` | **新增** | 试验凭据的**唯一**读取处（**剥 UTF-8 BOM** + 不给 key 兜底） |
| `scripts/postgresql/pglite-dump.ts` | **新增** | **固定版导出工具**（PGlite 副本 → SQL） |
| `scripts/postgresql/backup.ts` | **新增** | 备份**清单**（表/行数/内容摘要）与**具名拒收**链 |
| `scripts/postgresql/external-assets.ts` | **新增** | 数据库外资产：**归属声明表** + manifest + 具名拒收 + 完整性判据 |
| `scripts/postgresql/inventory.ts` | **新增** | **完整对象清单**：逐对象判类（in-scope / excluded / unclassified） |
| `scripts/postgresql/pg-exec.ts` | **新增** | 容器内执行 SQL / `pg_dump` 的**唯一一处**（`docker exec`） |
| `scripts/postgresql/g07-writer.sh` | **新增** | `PG-G07` 用的**并发写入进程**（每批 2 行、一个事务、提交后才打印） |
| `scripts/postgresql-g09-verify.ts` | **新增** | `PG-G09` 门 |
| `scripts/postgresql-g07-verify.ts` | **新增** | `PG-G07` 门（在线备份 → 新空库恢复 → 拒收链 → 资产 manifest） |
| `artifacts/post-lv2/local/pg-migration/export-runtime/` | **新增（gitignore）** | 导出工具的**独立**运行时（不在项目依赖树里） |

登记面（只追加）：`package.json` 两行 · `manifest.ts` 两门（`POSTGRESQL_GATES`）·
`affected-map.ts` 两条规则（**改量具/改备份链必须跑对应门**）·
`docs/architecture/Scripts-Catalog.md`（**重新生成**，见 §3.6）。

---

## 3.1 导出工具：版本为什么是 **0.2.21**（不是 latest）

计划 §2 逐字"**不能自动使用 latest**"。这条在这里是**硬约束**，不是谨慎：

```text
pglite-tools 的每个版本对一个**精确的 pglite 版本**有 peer 要求（从 registry packument 逐版读出）：
  tools 0.2.21 → pglite **0.3.16**   ← 与本仓库安装的 pglite 完全一致
  tools 0.3.6  → pglite 0.4.6
  tools 0.4.9  → pglite 0.5.9        ← latest
⇒ 用 latest 会**倒逼把源库引擎从 0.3.16 升到 0.5.9** —— 那是"同时升级框架"，
  研究 §3 明确要避免的。
```

**integrity 独立复算**（下载官方 tarball → 本地 SHA-512 → 与 registry 声明比）：

```text
@electric-sql/pglite-tools@0.2.21  MATCH  (535 214 B)   sha512-kv8Z7UmmBVECHud…K2lSDtA==
@electric-sql/pglite@0.3.16        MATCH  (8 132 416 B) sha512-mZkZfOd9OqTMHsK…DxfJmA==
```

许可证 **Apache-2.0** · **无运行时依赖**（只有那个 peer）。
装在 `artifacts/post-lv2/local/pg-migration/export-runtime/`（**gitignore**）——
本仓库对"外部工具"的既有做法（同 desktop-runtime / ocr-runtime）：
不把验证用工具塞进 `package.json`，避免扰动别人的在途改动与锁文件。

---

## 3.2 导出与恢复：读数

```text
导出（full）      11 335 681 B · sqlDigest 4ddc267bc70f… · 7.1s
                  `-- Dumped by pg_dump version 17.5`（与源引擎同版本）
导出（schema-only）  95 663 B · 2.6s
自证              sourceUnchanged=true · copyMatchesSource=true · closedClean=true
```

**恢复到空 PG（整条链）**：

```text
restore exit=0（**无任何 ERROR**）
public 表     51   ← 与来源一致
migrations 表  3   （plugin-sql 的 `migrations` schema）
kernel 版本   18   ← 与来源一致
conversation_events 548 ← 与来源一致
```

### 排除集与**逐条原因**（计划 §6.3 逐字要求"列清系统/扩展对象排除原因"）

```text
--no-owner       源库 owner 是 `postgres`，目标库**没有这个角色**
                 ⇒ 实测 `ERROR: role "postgres" does not exist`（57 条 OWNER TO）。
                 计划 §6.5 的"目标账号显式映射"= **省略源所有权**，
                 让目标的角色模型（create-test-db.sql 的 ALTER DEFAULT PRIVILEGES）生效。
--no-privileges  同上：源 ACL 在目标里没有对应角色。
--no-comments    来源里**只有 2 条 COMMENT，且都在 EXTENSION 上**（fuzzystrmatch / vector）。
                 而 `COMMENT ON EXTENSION` 要求**扩展所有权**，偏偏
                 `ALTER EXTENSION … OWNER TO` **语法不存在**
                 （实测 `ERROR: syntax error at or near "OWNER"`；
                  PG 的 ALTER EXTENSION 只支持 UPDATE / SET SCHEMA / ADD / DROP）
                 ⇒ 迁移账号无法应用它们。代价 = **2 条扩展的描述文字**（非数据）。
```

### ⚠️ 一次差点误判（纪律）

我一度把 `conversation_events=548` 当成"与 WP0 读到的 395 不符"。
**548 才是这个快照的真实行数**；395 来自**另一份来源**（2026-10-07 的迁移前备份）。
⇒ 这正是 WP0 就记下的"**两个读数必须绑定各自来源**"——差一点把**正确的结果**误判成不一致。

---

## 3.3 PG 在线备份 → 独立恢复（`PG-G07`）

### 3.3.1 「活动」是怎么**如实做出来**的

契约 `G07.1` 逐字："核心活动时备份成功（**不停止核心**）"。隔离试验实例上没有"核心"，
但"活动"这件事可以真的做出来 —— `scripts/postgresql/g07-writer.sh` 经 `docker exec` 起成
**另一个 OS 进程**，在被备份的库上持续写。它有三条刻意设计：

```text
① 每批**恰好 2 行、一个事务**
   ⇒ 目标库里若出现"只有 1 行的批次"，就等价于"备份取到了半提交状态" ——
     快照一致性从"感觉上应该没问题"变成**可判定**的
② **提交之后才打印**
   ⇒ psql -c "insert…; select…" 里的多条语句走同一条简单查询，PostgreSQL 把它们包在
     一个**隐式事务**里 ⇒ stdout 上出现一行就等于"那一批已提交"。
     于是 stdout 就是一份**提交后记录**，校验拿它与恢复出来的内容对，
     **不**去比"还在变的实时源"（契约 G07.6 要的正是这一点）
③ 停机经**数据库里的一个位**（`public.g07_control.stop`）
   ⇒ ⚠️ 因为容器里**看不见**宿主机的 `artifacts/`（见 3.3.4）
```

### 3.3.2 读数（runId `pg-migration-g07-20261013T092549Z`）

```text
在线备份（写入进行中）   exit 0 · **416 ms** · args `--no-comments`
                        11 124 527 B · sha256 29882973134276e7… · 56 张表 / 4 276 行
备份期间           提交 8 批（起止窗口内探针表 10 → 26 行）
                   第三方观察：2 次采样，其中 1 次看到 `pg_dump` 后端；
                   同一窗口内 `max client backends = 2`（写入进程 + pg_dump）
探针表的两个读数    备份里 k = **7** 批（14 行）· 源里 m = **15** 批（30 行）⇒ k < m
静默态对照 dump     源探针表 **30 行 == 2m**（停写之后才 dump）
恢复到新空库        exit 0 · **无任何 ERROR** · 扩展注释 **3/3 逐字与源相同**
逐表行数            51 张表 · **0 处不一致**
身份                src `lg_test_g07_src` / dst `lg_test_g07_dst`，同实例 17.11 + vector 0.8.7
```

**`k = 7 < m = 15` 是这一节最有分量的一条**：它同时证明了三件事 ——
备份不是"停下来之后才做的"、备份取到的是写入过程中的**某一刻**、
而那一刻意外的完整（连续前缀 1..7、每批 2 行、每批摘要与提交后记录逐字一致）。

### 3.3.3 排除集：`--no-comments` 的**代价实测为 0**

PGlite 那一支用的是三条排除（§3.2）。PG→PG 这一支**只用了 `--no-comments`**：
源对象与恢复账号同为 `lg_migrate` ⇒ `OWNER TO` / `GRANT` 本来就成立。

而第一次跑（**不带** `--no-comments`）红在这里：

```text
ERROR:  must be owner of extension vector
```

原因是 `COMMENT ON EXTENSION` 要求**扩展所有权**，而 `vector` 不是 trusted 扩展
（只有超级用户能装）⇒ 目标库里它由 bootstrap 装、注释归 bootstrap；
偏偏 `ALTER EXTENSION … OWNER TO` **语法不存在**（PG 的 `ALTER EXTENSION` 只支持
`UPDATE` / `SET SCHEMA` / `ADD` / `DROP`）⇒ 迁移账号改不动。

⚠️ 我一度以为"那就要补一条显式补偿"。**那个判断是错的**：写那两句注释的不是人，
是**扩展自己的安装脚本**（`vector--0.8.7.sql` 末尾、`fuzzystrmatch--1.1.sql`）——
目标侧**一装扩展就自带**同样的文字。⇒ 正确判据不是"把语句搬过去"，而是**验证两边逐字相同**：

```text
fuzzystrmatch|determine similarities and distance between strings
plpgsql|PL/pgSQL procedural language
vector|vector data type and ivfflat and hnsw access methods
        ⇒ 源与目标**三行逐字相同**（不是"条数凑巧一样"）
```

### 3.3.4 ⚠️ 一条环境事实（差点让整条恢复路线写错）

compose 里的 `.:/opt/lg:ro`，那个 `.` 是 **compose 文件所在目录**，不是仓库根：

```text
容器内 /opt/lg  ==  scripts/postgresql/
⇒ 各门的脚本路径是 /opt/lg/create-test-db.sql（**不是** /opt/lg/scripts/postgresql/…）
⇒ 宿主机的 artifacts/ 容器里**看不见** ⇒ 11 MB 的备份**不能**"放本地让容器 -f 读"，
  只能从宿主进程灌进 psql 的 **stdin**（`psqlFromStdin`）
⇒ 连"停机哨兵文件"也得从文件改成**库里的一行**
```

这一条是 `docker inspect` 读出来的（**不是**从 compose 文本推断的）——实测值：
`Source=/…/project LG/scripts/postgresql → Destination=/opt/lg`。

---

## 3.4 完整对象清单（计划 §3.3「不能硬编码只导几张记忆表」）

`scripts/postgresql/inventory.ts` 的判据形状是**闭集**：每个对象判成
`in-scope` / `excluded`（**逐条具名原因**）/ `unclassified`，**第三堆非空就是拒收**。
出现了没见过的 schema 或 relkind，门会红着说"这个我没判过"。

```text
迁移范围来源 = verified 快照恢复出来的 src（真 PG，真实形状）
对象总数        175
  in-scope      58   （public 基表 + 序列 + migrations schema 的 kernel 迁移表）
  excluded     117   （索引 115 · 视图/复合类型 2 —— **只有 DDL 没有数据**）
  unclassified   0   ← 这一项是判据本体
扩展            fuzzystrmatch 1.2 · plpgsql 1.0 · vector 0.8.7
```

⚠️ **物化视图（relkind `m`）刻意判成 `in-scope`**（它**含数据**，与普通视图不同）；
**foreign table（`f`）刻意判成 `unclassified`**（没有裁定，来一个就得停下来决定一次）。
两条都是"宁可红，不要静默漏掉"。

恢复之后目标侧的清单**逐项相同**：`175 / 58 / 117 / 0`，双向差集为空。

---

## 3.5 数据库外资产清单与 manifest（计划 §3.3 / 契约 `G07.5`）

### 3.5.1 判据形状：**闭集**，而不是"我列了几个要备份的目录"

```text
unclassifiedDataRoots() 列出 data/ 下**每一个没有归属的目录**；非空 ⇒ 拒收。
⇒ 加了新目录却不来登记，门会红着说"这个我没判过"，
  而不是安静地把它漏在备份之外。
```

⚠️ 这条判据**第一次跑就咬到了自己**（见 §4.4 `F-WP4-06`）：`data/` 下 7 个
`pglite.backup-*` / `pglite.broken-*` / `pglite.snapshot-*` 目录没有归属。
现在用**通配声明**（`data/pglite.backup-*`）覆盖，并把匹配到的目录**逐条列出**
（`matchedRoots`：5 / 1 / 1 个）⇒ 连"通配符实际盖住了什么"都是可审计读数。

### 3.5.2 裁决表（`ASSET_ROOT_DECLARATIONS`，13 条）

| id | 路径 | 裁决 | 归属 / 原因 |
|---|---|---|---|
| `image-inputs` | `data/pglite/image-inputs` | **include** | 聊天图片原件（内容寻址 `image:sha256:<hex>.bin`） |
| `personal-library` | `data/personal-library` | **include** | 个人资料库（当前 0 文件，读数原样记录） |
| `owner-records` | `data/owner-records` | **include** | 数据库归属凭证（62 文件 / 8 699 B） |
| `local-file-recovery` | `data/local-file-recovery` | **include** | 就地改写前的 `.bak`（1 文件 / 1 B） |
| `qq-private` | `data/qq-private` | **include** | QQ 入口落盘（1 828 文件 / 606 541 757 B） |
| `database-itself` | `data/pglite` | exclude | **它就是数据库本体**，由快照/导出链负责（§6.1） |
| `legacy-snapshot-roots` | `data/snapshots` | exclude | 快照归档**本身**就是备份载体 |
| `snapshot-root-semantic-repair` | `data/snapshots-semantic-repair-20261005` | exclude | 同上的历史归档 |
| `legacy-db-copies` | `data/backup` | exclude | 旧库副本归档 |
| `legacy-pglite-copies` | `data/pglite.backup-*` | exclude | 历史里程碑备份（匹配 5 个目录） |
| `legacy-pglite-broken` | `data/pglite.broken-*` | exclude | 事故现场保留物，**刻意不删**，恢复也不从它来 |
| `legacy-pglite-snapshot` | `data/pglite.snapshot-*` | exclude | 早期手工快照（匹配 1 个） |
| `diagnostics` | `data/diagnostics` | exclude | 诊断产物（1.49 GB）；**刻意不遍历**（不增加判据） |
| `automatic-memory-runtime` | `data/runtime/automatic-memory/langmem-*` | exclude | 第三方实验运行时（含 `.venv`/`.git`）——⚠️ **这是一条裁定**，见 `L-PGW4-09` |

### 3.5.3 读数与**隐私边界**

```text
include 根合计        1 891 文件 / 606 550 457 B
manifestDigest       944ebf447dd01a6d…（对"相对路径 + 字节数 + 内容 sha256"规范化后取 sha256）
⚠️ 摘要**不含 mtime**（TD-23 的既有裁定：身份优先，mtime 永不参与）
data/ 顶层散落文件     23 个（开发期日志/证据/一次性探针）——**照实记数**，不假装归过类
image-inputs          **目录不存在** ⇒ 按缺省 dataDir 没有任何图片原件（见 `L-PGW4-10`）
```

落盘刻意分成两处：

```text
进仓库（机器证据）  artifacts/post-lv2/postgresql-migration/<runId>/g07-asset-manifest-summary.json
                    = 根的 id / 归属 / 裁决 / 原因 / 文件数 / 字节数 / 根摘要（**不含逐文件路径**）
不进仓库（gitignore）artifacts/post-lv2/local/pg-migration/g07-asset-files.json
                    = 逐文件清单 —— 因为 `data/qq-private` 的**文件名可能含 QQ 标识**
                      （那是私人标识，不该进提交历史）
```

拒收链是**有序**的、原因互不相同：

```text
asset_root_missing      根不在
asset_manifest_empty    manifest 一个文件都没有 ⇒ **不许把空集当绿灯**
asset_missing           少文件（"没备份全"）
asset_digest_mismatch   文件内容变了（"被改过"）
asset_unexpected_file   多出文件（"没清干净"）—— 这是**独立**的事故形状
```

---

## 3.6 `scripts:catalog`：一条**先前就在红**的门（顺手修，如实说明）

改动登记面之后跑 `pnpm scripts:catalog:verify`：

```text
用 HEAD 版本的清单      ❌ EXIT 1（已提交 695 行 / 现在应 728 行）
重新生成之后            ✅ 608 条 · EXIT 0
```

⇒ **这条门在我这一轮之前就是红的**（并行的其它会话加了 `scripts/` 条目却没重新生成清单）。
我重新生成了它，于是 diff 里会带上**约 20 条不属于 WP4 的条目**
（`coexist:chat` · `learning:contracts:verify` · `memory:automatic:*` · `postlv2:image:*` ·
`postlv2:model-memory:*` · `postlv2:avatar-opening:*` · `postlv2:affected:verify` …）。
**那不是我的改动**，是这个工作区里别的在途工作 —— 登记在此以免归属被弄错。

---

## 4. 读数

### 4.1 门 `pnpm postgresql:g09:verify` = **23/23 · 0 失败 · 0 notRun**（`measured_count = 23`）

**正控**

```text
G09.2-正控   两份相同数据 ⇒ 判一致
G09.3e ★     跨驱动（PGlite → 真 PG）比较 ⇒ 判**一致**   ← 整道门的关键
```

**负控（每条只改一处，原因**互不相同**）**

```text
G09.2a   删一行                    ⇒ row_count_differs
G09.2b   改主键值（行数不变）        ⇒ primary_key_set_differs
G09.2c   改非主键值（主键不变）      ⇒ content_digest_differs
G09.2d   改一个 bigint 值（差 1）    ⇒ content_digest_differs
G09.2e ★ 无主键表：删一行加一行（**总数不变**）⇒ multiset_differs
G09.3f   真 PG 里删一行             ⇒ row_count_differs
G09.3g   真 PG 里改一个非主键值      ⇒ content_digest_differs
```

**恢复**

```text
G09.2f   把改动还原 ⇒ 又一致
G09.3h   重建真 PG 目标 ⇒ 又一致
```

### 4.2 真跨驱动读数（本门最有分量的一条）

```text
来源   data/snapshots/desktop-actions-activation-20261009/
       pglite-2026-10-11T12-53-02-968Z-55f0cb5676aa（WP0 读过的那个 verified 快照）
表     character_schema_migrations（18 行 · 有主键 · **含一个 bigint 列** applied_at
       —— 正是编码差异所在）
方法   readPgliteTable 只读副本 → 逐值原样插进真 PG → psql 的 json_agg 读回
       → 两侧各自算摘要 → 比较
结果   **一致**
自证   sourceUnchanged=true · copyMatchesSource=true · closedClean=true
```

⚠️ **这一条才是"量具真的在量东西"的证据**：同一份逻辑数据经两个驱动到达 JS 时形状不同，
不做归一化这里会**假不等**。

### 4.3 门 `pnpm postgresql:g07:verify` = **47/47 · 0 失败 · 0 notRun**（`measured_count = 47`）

**§1 备份清单与拒收链**（纯函数，合成夹具）— 11 条

```text
G07.0b-正控  完好的备份按清单校验 ⇒ 通过     ← 没有它，后面的"拒收"不说明任何事
G07.0c-负控  **同长度**改一个字符            ⇒ backup_digest_mismatch（而**不是** truncated）
G07.0d-负控  砍掉尾部                        ⇒ backup_truncated
G07.0e-负控  长度**相同**但结尾行被抹成空白  ⇒ backup_truncated（靠"结尾行在不在"抓）
G07.0f/g/h  文件不存在 / 0 字节 / 非 dump    ⇒ backup_file_missing / backup_empty / backup_header_missing
G07.0i-负控  备份**没变**、清单被改（摘要换掉）⇒ 仍拒收  ← 证明判据挂在清单上
G07.0j      六种拒收原因**互不相同**（可区分性本身是判据）
G07.0k      破坏的副本还原 ⇒ 又通过（恢复段）
```

**§2 库外资产**（夹具三段式 + 真数据根）— 9 条

```text
G07.5b/c/d-负控  改内容 / 删文件 / 加文件 ⇒ 三种**互不相同**的具名拒收
G07.5f-负控      空 manifest ⇒ asset_manifest_empty（不许把空集当绿灯）
G07.5g ★         夹具里放一个**未登记**目录 ⇒ 被点名列出
G07.5h/i         真数据根：未登记目录 == 0 · manifest 真的算出了内容
```

**§3 真实例**（并发写入 → 在线备份 → 新空库恢复）— 27 条，含

```text
G07.1g ★  写入进行中 pg_dump 退出码 0
G07.1h ★  备份**确实**发生在写入进行中（备份窗口内行数 10 → 26；第三方看到 pg_dump 后端）
G07.3  ★  篡改 ⇒ backup_digest_mismatch      G07.3b ★ 拒收发生在**恢复之前**（dst 此刻仍不存在）
G07.4  ★  截断 ⇒ backup_truncated（与篡改原因不同）
G07.6a ★  备份里是连续前缀 1..k 且每批恰好 2 行（**没有半提交事务**）
G07.6b ★  每一批与"提交后记录"**逐字**一致
G07.6c ★  k ≥ 3 且 k < m（备份取的是写入中的某一刻）
G07.6d ★  静默态对照 dump 的探针表 = 2m 行 ⇒ 两份确实取自不同时刻
G07.7  ★  源身份与目标身份**分开**记录且确实是两个库
G07.2f ★  被排除的扩展注释与源**逐字**相同
G07.2e    逐表行数 51 张全一致（⚠️ 读数里同时写明"这条**不**证明内容一致"）
```

### 4.4 本轮抓到并修掉的缺陷（**全部是我自己的工具/量具**）

```text
F-WP4-03  `relkind` 是 `"char"` 不是 text ⇒ `text || "char"` 报
          `operator is not unique`；而同一条 SQL 里 `order by 1, 2` 又报
          `ORDER BY position 2 is not in select list`（输出只有一列）。
          两个错**一个盖住另一个**，表面上都表现为"对象清单读不出来"（很像权限问题）。
          修：`c.relkind::text` + 排序一律写**显式列名**，别用位置号。

F-WP4-04  在线备份不带 `--no-comments` ⇒ 恢复红在 `must be owner of extension vector`。
          修：dump 用 `--no-comments`，并**用判据**（不是推断）证明代价为 0 ——
          源与目标的扩展注释**逐字相同**。⚠️ 中间的弯路：我一度加了一条"用超级用户把
          注释补回去"的补偿步骤，后来发现**要补的东西本来就在**（扩展安装脚本自带）。

F-WP4-05  ★ 量具自身缺陷（最值钱的一条）：采样循环里 `psql()` 走 **`spawnSync`**，
          它**阻塞整个事件循环** ⇒ "不留睡眠"的紧循环让 `dumpProcess.on('close')`
          **永远排不上队**，`dumpExit` 一直是 `undefined`，循环只能跑到超时。
          读数的表现极其误导：`committedDuringDump = 1818`（看着像备份跑了 60s），
          真相是**备份 0.6s 就结束了**，循环空转了 180s。
          反方向也踩过：第一版 `sleep(250)` ⇒ dump 只有 0.5s，只采到 **1** 个样本，
          判据变成在量**采样频率**。
          修：每轮 `await` 让出 ~15ms，并把"并发"的硬判据放在**确定性的行数增长**上。

F-WP4-06  `data/` 下 7 个 `pglite.*` 目录没有归属 ⇒ 完整性判据第一次跑就点名。
          （**这正是它该做的**：不是缺陷，是判据生效。）修：加通配声明 + matchedRoots。

F-WP4-07  写入进程的 stdout 按 chunk 直接 `split('\n')`，**没留残行** ⇒ 跨块的那一行被
          切成两段、两段都过不了正则 ⇒ 那一批从记录里消失。
          实测后果："src 3261 批 ≠ 记录 3259 批" —— 量具**自己的丢行**被报成数据不一致。
          修：留 pending 残行。

F-WP4-08  篡改用**字符串**替换：`str[i]` 是 1 个 UTF-16 码元，而文件里的中文是 3 字节
          UTF-8 ⇒ "同长度篡改"实际少了 2 字节，于是"篡改"看起来像"截断"，
          `G07.3` 与 `G07.4` 双双失去区分力。修：在 **Buffer** 上翻一个字节。

F-WP4-09  取数顺序错误：先读 src 清单、**之后**才建本门的探针表 ⇒ dump 里多出两个对象，
          `G07.2d` 报"目标多对象"。那不是数据问题，是量具自己造的。
          修：本门自己造的对象必须在**取源清单之前**存在。

F-WP4-10  `srcSummary!` 非空断言把"清单读不出来"变成
          `TypeError: Cannot read properties of undefined` ⇒ 真正的失败原因被一段栈盖住。
          修：显式挡一道并抛出**说清原因**的错误。
```

⚠️ 这十条里有 **5 条是"量具/夹具自己的缺陷"**（03/05/07/08/09）——
它们会往**两个方向**错：F-WP4-07 会把一致报成不一致（假红），
F-WP4-01（上一轮）会把不一致报成一致（**假绿**）。假绿那条更危险。

### 4.5 lane

`pnpm gates:run --lane postgresql` = **4 道 PASS**（g03 串行于 g02；g07 与 g09 串行于其后）。

---

## 5. WP4 仍未做（下一轮清单）

```text
✅ **固定兼容导出工具**（`@electric-sql/pglite-tools@0.2.21`，integrity 已独立复算，装在独立运行时）
✅ **PGlite 副本 → SQL → 空 PG**（整条链已通；排除集与逐条原因见 §3.2）
✅ **PG 在线备份 → 新库**（`PG-G07` 47/47：并发写入中 416ms 完成，恢复到新空库 exit 0 无 ERROR）
✅ **完整清单**（175 对象 → 58 in-scope / 117 excluded（逐条原因）/ **0 unclassified**）
✅ **外部资产清单**（13 条裁决 + manifest + 三段式拒收 + 完整性判据）
✅ **manifest** 与**数据摘要**（bytes + sha256 + 逐表行数 + contentDigest + 资产 manifestDigest）
✅ **损坏备份拒收**（篡改 / 截断 / 抹尾 / 空 / 缺 / 非 dump ⇒ **六种互不相同**的具名原因）
⏳ **逐表内容比较**（用 §2 的比较器对**全部 51 张表**做全列规范化摘要比较）⇒ 属 WP5
   当前只做到**行数**一致（§4.3 `G07.2e`），而那条读数**自己就写明**"不证明内容一致"
   ✅ **2026-10-13 已由 WP5 交付**：`pnpm postgresql:g05:verify` **29/29** ——
   54 张表（public 51 + migrations 3）/ 4 261 行**逐表规范化摘要一致**（0 处不一致）；
   见 [WP5 Handoff](PostgreSQL-Migration-WP5-Handoff.md) §3。
   ⇒ `L-PGW4-01`（"只在一张 18 行真表上验证过"）与 `L-PGW4-13`（"行数一致不证明内容一致"）
   **两笔账已销**（仍未覆盖的部分见 WP5 §6：14 张空表 · 无 numeric 列 · 无 bytea 列）
⏳ 备份的**唯一性/保留策略**（实际 RPO/RTO、异地、WAL/PITR）⇒ 计划 §10 第二阶段
```

---

## 6. 边界（`L-PGW4-01…04`）

```text
L-PGW4-01  比较器**只在一张 18 行的真表上**做过真跨驱动验证。
           全表比较（51 张 · 含 vector/jsonb/bytea）属 **WP5**。
           ⇒ **不主张**"比较器已覆盖所有列类型"——覆盖的是：整数家族（含 bigint 的
              number/string 两种形状）、文本、JSON（键序）、numeric、布尔、时间、null。
             **未在真数据上验证**：`bytea`、`vector`、`uuid`、数组、`timestamptz` 的时区表示。

L-PGW4-02  比较器**只比数据**，不比 schema。列类型/约束/索引/序列的差异由表清单与
           schema 比较负责（WP5/WP6）。⇒ 不主张"它同时是 schema 比较器"。

L-PGW4-03  `readPgliteTable` 会**复制整个 PGlite 目录**再打开（约 49 MB / 1269 文件）。
           对全库比较（51 张表）要**一次复制、多次读取**，否则每张表复制一遍 ——
           WP5 落地时要把"打开一次、读多表"做成接口（当前是"每次调用复制一次"）。

L-PGW4-04  ~~`@electric-sql/pglite-tools` 未装 ⇒ WP4 的导出那一支**无法开工**~~
           ✅ **2026-10-13 已解决**：固定 `0.2.21`（peer 与 pglite 0.3.16 一致）·
           integrity 独立复算 · 装在**独立运行时**（gitignore，不进项目依赖树）。
           ⚠️ 换版本时必须**重走这三步**（peer 映射 → integrity → 独立安装），
           尤其不能直接升到 latest（会倒逼源库引擎升级）。

L-PGW4-05  **导出参数的排除集是实测逼出来的，不是预设的**：
           `--no-owner --no-privileges`（源 owner/ACL 在目标不存在）+
           `--no-comments`（唯一 2 条 COMMENT 都在 EXTENSION 上，而
           `ALTER EXTENSION … OWNER TO` 语法不存在 ⇒ 无法转移所有权）。
           ⇒ **换来源或换 pg_dump 版本时要重新核对这三条是否仍然充分**
           （判据：恢复 exit=0 且无 ERROR）。

L-PGW4-06  `readPgliteTable` / `dumpPgliteSnapshot` 都**每次调用复制一次整个 PGlite 目录**
           （约 49 MB / 1269 文件）。全库比较（51 张表）与逐表导出要改成
           "**复制一次、用多次**"，否则 51 张表会复制 51 遍。

L-PGW4-07  ⚠️ **"在线备份"里的"活动"是并发写入进程，不是真实认知核心**。
           本门（以及 `g07-writer.sh`）证明的是**机制**：并发写入下不需要停任何东西，
           且取到的是**事务一致**的点。**不主张**"已对真实核心做过在线备份" ——
           那需要真实核心在跑，属 WP7/WP8（`P2.3` 在线只读查询与备份**同时**成功）。

L-PGW4-08  备份清单里的 `rows` 来自 `COPY … FROM stdin;` 块的**行数**，
           这依赖"COPY 文本格式把行内换行转义成 `\n`"。
           真出现一个含**裸换行**的 COPY 块，行数会被多算 ⇒ 那是**假红**（宁可假红）而不是假绿。

L-PGW4-09  ⚠️ `data/runtime/automatic-memory/langmem-*` 判 `exclude` 是一条**裁定**，不是读数：
           它是第三方实验运行时的**检出**（含 `.venv` / `.git`，可重现、非角色数据）。
           若 M9.6 线将来把它当**权威记忆存储**，这条裁定要**重开**。
           同理 `data/diagnostics`（1.49 GB）是"刻意不遍历"，不是"确认无内容"。

L-PGW4-10  `image-inputs` 目录在当前缺省 dataDir（`data/pglite`）下**不存在**
           ⇒ 按缺省路径**没有任何图片原件**。
           ⚠️ **不能**由此断言"从来没有图片输入"：若某次运行以 `PGLITE_DATA_DIR` 指向别处，
           那些原件不在本清单的根里（`ImageInputStore` 的路径由 dataDir 推导）。
           `data/personal-library` 存在但为空 —— 这两条都按**"目录状态"**记录，不推广成结论。

L-PGW4-11  在线备份只有 **~0.4 s**（11 MB / 56 张表）⇒ 采样窗口极窄。
           本轮为此把"并发"的硬判据放在**确定性的行数增长**上，采样只作旁证
           （`samples: 2` · `samplesWithPgDumpPresent: 1`）。
           ⇒ **不主张**"采样观察覆盖了整个备份窗口"。

L-PGW4-12  `psql()` / 建库脚本调用在 `PG-G02`/`G03`/`G09` 里**各有一份**，本模块
           （`scripts/postgresql/pg-exec.ts`）是**第四份**。本轮**只新增、没有回头改写**
           那三份（它们是绿的，动它们要有理由）⇒ 三处重复仍在，交下一轮或维护线收敛。
           ⚠️ 已知的一处**真实**偏差：那三份用 `/opt/lg/${script}`，
           而 `pg-exec.ts` 的注释里曾写成 `/opt/lg/scripts/postgresql/…`（已改）。
           这类偏差正是"收在一处"要解决的问题。

L-PGW4-13  `G07` 的**逐表行数**一致（51 张）**不**证明内容一致（契约 §5 `N02`）。
           内容级比较（全列规范化摘要）属 WP5 —— 本门的观测记录里**逐字写着这句话**，
           免得下游把行数当完整性。
```

---

## 7. 不主张

```text
· 不主张 WP4 完成 —— 计划 §4/WP4 的必交付物里**逐表内容比较**仍未做（见 §5）
· 不主张"比较器已覆盖所有列类型"（L-PGW4-01：bytea/vector/uuid/数组/时区未在真数据上验证）
· 不主张"整库内容一致"—— 只做到了**对象集合**与**逐表行数**一致（行数一致不证明内容一致）
· 不主张"已对真实核心做过在线备份"（L-PGW4-07：那是并发写入进程，真实核心属 WP7/WP8）
· 不主张"库外资产清单是完整的"到"没有别处还有数据"的程度 ——
  它保证的是"`data/` 下每个**目录**都被判过类"，而**名单之外的路径**
  （例如某次以 `PGLITE_DATA_DIR` 指向的别处）不在判据范围内（L-PGW4-10）
· 不主张"损坏备份拒收覆盖所有损坏形状"—— 覆盖的是**六种具名原因**；
  例如"备份内容合法但语义上是别的库的"不在其中
· 不主张本轮关闭或推进任何历史事故、里程碑或技术债
```
