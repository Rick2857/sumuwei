# node_modules 半途安装被删（croner 消失）与修复 —— 2026-10-09

## 症状（逐字）

停机窗口跑完 `pnpm m4.5:ci`（**EXIT 0**）之后，按 ADR-125 的收尾要把共存核心起回来：

```text
powershell -File scripts\coexist\start-background.ps1
  ↓ （脚本内部就是 `pnpm coexist:start`）
Error: ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR
  × installing dependencies
  ╰─▶ Failed to remove C:\Users\user\Desktop\project LG\node_modules\croner
      from the modules directory: 拒绝访问。 (os error 5)
```

结果：**核心没有起来**（0 个核心进程、6751/6752/6753/8931 全无监听）。进一步实测：

```text
Test-Path node_modules\croner            ⇒ 不存在
Get-ChildItem node_modules\.pnpm -Filter croner@*  ⇒ 空
node --input-type=module -e "import('croner')"     ⇒ ERR_MODULE_NOT_FOUND
```

## 成因（可复核，不是猜）

```text
① 工作树里 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` 有**未提交**改动
   （别会话的在制品：新增 reminder:channels:verify / coexist:chat / postlv2:model-memory:verify
    等脚本、engines 22.13.0、pnpm-workspace 的 overrides）⇒
   pnpm 判定"node_modules 与清单不一致"，于是在**运行脚本之前**自动安装依赖；
② 该自动安装的**移除阶段**被拒（`node_modules/croner` 访问被拒）⇒ 安装半途而废，
   它已经把 croner 从 `node_modules` 与 `.pnpm` 里删掉，却没有把新的装回来；
③ croner 是 QQ 主动联系调度器的依赖（ADR-110 精确固定 `croner@10.0.1`）
   ⇒ 核心 import 失败 ⇒ 起不来。
```

⚠️ 触发条件值得记住：**服务在跑 / 工作树里有别会话的未提交清单改动**时，任何经 `pnpm` 的命令
都可能触发这次自动安装。本次两次停机窗口之间就是这样。

## 影响面（如实）

```text
核心停机：约 19:50 → 20:2x（含 m4.5:ci 的 12.4 分钟停机窗口本身）
m4.5:ci：**EXIT 0 有效**（它跑在损坏之前；损坏发生在之后的 `pnpm coexist:start`）
被改的源码 / 脚本：无 —— 本次修复**没有**动 `src/**` 与 `scripts/**`
真实库：全程未被打开（停机 → CI（G14 热复制副本）→ 修复 → 重启）
```

## 修法（只按锁文件冻结安装，不碰别人的在制品）

```powershell
pnpm install --frozen-lockfile      # Done in 27.7s · EXIT 0
node --input-type=module -e "const m = await import('croner'); console.log(typeof m.Cron)"   # ⇒ function
powershell -File scripts\coexist\start-background.ps1                                        # ⇒ 新的 COEXIST_READY
```

⚠️ **刻意没有**做的一件事：`git checkout -- package.json pnpm-lock.yaml pnpm-workspace.yaml`。
那三份清单的改动**不属于本次任务**（是别会话/用户的在制品），回滚它们等于替别人决定。
判据：修复前后 `git diff --stat` 逐字相同（`3 files changed, 194 insertions(+), 1116 deletions(-)`）。

## 恢复读数（2026-10-09）

```text
COEXIST_READY                  第 4 次（新增一次，不是读到旧的）
核心进程 / sidecar 进程        4 / 1
sidecar 参数                   ... --extension --port 8931 --browser chrome \
                               --caps config,devtools,network,pdf,storage,testing,vision
入口监听                       6751 / 6752 / 6753 / 8931 各 1
tools/list                     **72**（storage 组 15 个：cookie 5 + localstorage 5 + sessionstorage 5）
```

## 下次别再踩

```text
· 停机窗口里要跑 pnpm 命令之前，先确认**没有**服务在跑（本次前半段是对的，后半段忘了）；
· 如果是"起服务"，优先用等价的 argv（`node node_modules/tsx/dist/cli.mjs <script>`）
  或确保 `pnpm install` 的移除阶段不会被占用者挡住；
· 看到 `ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR` ⇒ 立刻检查**哪些包没了**
  （`import('croner')` 这类一秒钟的探针），不要先怀疑自己的代码；
· 修复只按锁文件：`pnpm install --frozen-lockfile`；**不要**手工改别人未提交的清单。
```
