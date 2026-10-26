# 西电本科课表（可选，默认关闭）

服务器可独立同步西安电子科技大学本科课表，苏沐薇通过受控只读工具查询本地快照。无需安装 Flutter 桌面程序。此入口只支持本科教务；未实现研究生入口。协议实现参考 [Traintime PDA 固定版本](https://github.com/BenderBlog/traintime_pda/tree/e780e4d01ea740c979ff5c31b9db439dbc586864)。

## 启用条件

- Node 与依赖按主项目安装；另备 Python 3 与 Pillow。滑块匹配在本机运行。
- 使用你自己的学校账号。首次登录可能需要学校短信验证；学校以后要求再次验证时仍需人工处理，不能保证永不干预。
- 主进程必须从仓库根启动。默认状态目录为 `data/xidian`，不会纳入 Git。

默认模板与代码均为 `CHARACTER_XIDIAN_TIMETABLE_ENABLED=false`。只有主动配置后才启用；普通部署无需填写学校账号、安装 Pillow 或安装定时器。

## 首次同步

在服务器的交互式终端，以运行同步服务的账号执行：

```bash
pnpm xidian:configure
PROJECT_LG_XIDIAN_PYTHON=/absolute/path/to/python pnpm xidian:sync
```

配置助手通过隐藏输入读取密码，保存到权限为 0600 的 `data/xidian/credentials.json`；目录为 0700。不要把密码、验证码、会话文件或课表快照发送到聊天或提交到仓库。该功能需要在服务器本地保存凭据和登录会话，以便自动刷新。

若同步提示 `verification_required`，显式请求学校验证码，然后在隐藏输入中提交：

```bash
pnpm exec tsx scripts/xidian/sync.ts send-code
python3 scripts/xidian/configure.py --verify-code
PROJECT_LG_XIDIAN_PYTHON=/absolute/path/to/python pnpm xidian:sync
```

完成同步后，在主服务自己的环境文件中设置并重启该服务：

```dotenv
CHARACTER_XIDIAN_TIMETABLE_ENABLED=true
# 可选；主服务与同步进程必须使用同一目录
# PROJECT_LG_XIDIAN_DIR=/absolute/private/path/xidian
```

## 自动刷新

`scripts/xidian/lg-xidian-sync.service` 和 `.timer` 是需要编辑的 systemd 示例。先把服务账号、工作目录、Python 路径和可写目录替换为自己的值，创建状态目录并配置凭据，再将两个文件安装到 systemd 单元目录，执行 `systemctl daemon-reload` 与 `systemctl enable --now lg-xidian-sync.timer`。不要将示例路径当作自动发现的本机路径。

定时器每小时刷新；先复用会话，失效后才尝试密码登录。每日密码提交最多三次，错误密码会暂停，修改凭据后才恢复；同步锁阻止并发任务。短信和其它二次认证不自动绕过，状态码会保存在私有的 `status.json` 中。需要重新配置时，由你在服务器本地安全替换凭据文件。

## 查询与边界

启用后可询问“我明天有什么课”“查一下本周课表”。工具为 `xidian.timetable/query`，只接受北京时间日期 `date=YYYY-MM-DD` 与 `days=1..7`，缺省今天起七天。只开放给原主人私聊；不提供账号切换或群聊代查。旧单主人入口沿用原身份授权。

查询不会现场登录学校，也不修改教务数据。同步器计算课程、周次、节次及调停课；不明确的变更保留提示。快照超过六小时、损坏或缺失时如实失败，不能把失败解释成“没有课”。返回内容包含同步时间；近期同步失败时会提示。

停用主服务开关并停止/禁用定时器即可退出；如需删除凭据，在自己的服务器上处理状态目录。

## 验证与许可

```bash
pnpm xidian:verify
/absolute/path/to/python scripts/xidian/verify-slider.py
```

第二条使用已安装 Pillow 的解释器。这些测试使用合成课表和模拟学校响应，不会提交真实学校密码或发送短信。公开副本的检查范围见 [验证记录](PUBLIC-VERIFICATION.md)。

IDS/eHall 协议适配文件使用 MPL-2.0，滑块算法移植保留上游 MIT 许可；详见 [文件级许可说明](../scripts/xidian/NOTICE.md) 及 [完整 MPL-2.0](../scripts/xidian/MPL-2.0.txt)。主项目其余文件继续按各自许可分发。
