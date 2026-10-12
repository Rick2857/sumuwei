# 共存模式状态接口修复

日期：2026-10-06（UTC+8）。用户授权：「好的修复这个问题」。

**结论：`/lg/status` 的 HTTP 500 已修复，并已在正式皮套上读回 HTTP 200、`lg_process_alive=true`。共享 LG 核心与 QQ 保持在线。**

## 原因与改动

共存连接模式下，`LGBridgeClient.process` 为 `None`：皮套通过 TCP 连接共享核心，没有自己的 LG 子进程。状态接口仍读取 `BRIDGE.process.returncode`，因此抛出 `AttributeError`。

本次生产逻辑只修改 `scripts/postlv2_vtuber_runtime.py:1325` 一处：

```diff
- "lg_process_alive": BRIDGE.ready and BRIDGE.process.returncode is None
+ "lg_process_alive": BRIDGE.ready and BRIDGE.alive
```

现有 `alive` 属性同时支持子进程与 TCP 传输；原接口字段名和其他状态字段保持原有形状。

## 回归与生产读回

| 检查 | 结果 |
|---|---|
| 修复前失败复现 | 新增 HTTP 路由检查在「连接就绪、没有子进程」场景得到 HTTP 500，退出码 1 |
| 修复后状态路由 | `scripts/postlv2-status-verify.py`：6/6 PASS，覆盖子进程存活/退出、TCP 就绪/断开/缺失、桥未就绪及诊断字段保留 |
| 原有启动与关闭行为 | `scripts/postlv2-production-verify.py`：10/10 PASS |
| 两条实际外壳的隔离回归 | `pnpm postlv2:coexist:shells`：EXIT 0；隔离实验的生产库树摘要前后相同；真实语音仍为该门的 NOT RUN |
| 完整离线回归 | `pnpm m4.5:ci`：EXIT 0，完成时间 18:53:11；包含本次 `typecheck` |
| 正式皮套接口 | 多次 GET `http://127.0.0.1:12394/lg/status`：HTTP 200、`mode=production`、`lg_process_alive=true` |
| 正式 QQ | `pnpm qq:status`：认证与独立机器人账号校验 PASS；QQ 到 NapCat 与共享核心的连接均为 ESTABLISHED |

新增检查编译并挂载运行脚本中的原始状态路由，使用实际 `LGBridgeClient` 和隔离的 ASR/TTS 状态对象，通过 FastAPI 的 HTTP 客户端读取；不启动模型、音频或数据库。

复跑命令：

```powershell
& 'C:\Users\user\postlv2-deps\cosyvoice3-venv\Scripts\python.exe' -B -X utf8 scripts/postlv2-status-verify.py
```

本次按实际脚本链核对了离线 CI：`m4.5:ci` 的 G14 汇总只读取既有 Live Smoke 证据，不执行 `m4.5:smoke:live`。因此运行本次离线 CI 没有热复制正在运行的生产库；G14 的 52/0 是承接的历史读数，不是本次重新调用真模型。

## 正式加载与数据边界

确认皮套没有活动客户端后，仅结束不持库的旧皮套 Python 外壳，通过独立隐藏控制台重新启动连接档。LG 核心 PID **32884**、QQ PID **26980** 在重启前后相同，正式新皮套 PID **16100** 连到 **6752**。

这次独立外壳的临时启动辅助器在 `artifacts/post-lv2/local/coexist-status-fix-20261006/reload-avatar.cjs`，其生命周期关联原核心与共存 STOP 哨兵。正常后续共存启动仍使用原生产入口并加载修复后的 Python 源文件。

没有提交正式聊天轮次，没有发送 QQ 测试消息，没有另外打开真实数据库，也没有向真实记忆写入测试内容。原有证据文件在 CI 前备份，CI 后恢复了实际变化的 6 个文件，内容哈希均与运行前一致；新证据单独保留。

本次关闭的是状态接口缺陷。双入口实际语音、播放中并发及打断体验仍按原共存验收记录分别等待读数。

## 证据位置

- `artifacts/post-lv2/local/coexist-status-fix-20261006/regression-evidence.json`：失败复现与修复后检查。
- `artifacts/post-lv2/local/coexist-status-fix-20261006/production-readback.json`：正式接口读回与修复文件哈希。
- `artifacts/post-lv2/local/coexist-status-fix-20261006/m4.5-ci.log`、`ci-result.json`、`ci-evidence/`：本次完整离线回归及原有文件恢复校验。
- `artifacts/post-lv2/coexist-wp3-shell-20261006104737022/result.json`：本次双入口外壳回归。

以上运行时本地材料保持在既有 gitignore 范围，未覆盖原激活指纹或历史失败记录。
