"""Fixed windows-mcp desktop worker: JSON header + bounded read-only state / closed-set actions.

============================================================================
 协议（与 `image-ocr-worker.py` 同型，先例逐条照抄）
============================================================================
```text
stdin   第 1 行 = JSON 头（≤64KB）  {"protocol": "desktop-control/1", "op": ...}
stdout  **恰好一行**  DESKTOP_CONTROL_RESULT=<json>   （ensure_ascii=False）
stderr  诊断日志（不解析）
exit    0 = 成功；2 = 协议；3 = 运行时/版本；4 = 目标不可用（失败关闭）；5 = 执行失败
```

============================================================================
 这个 worker 只暴露下列闭集操作
============================================================================
```text
runtime   只核对固定版本（不碰 UIA）—— 用于只读的"运行时存在吗"
state     只读桌面状态（UIA 语义树 → 有界文本 + 结构化索引）
apps      只读系统应用目录 + 三个可启动的系统文件夹（可按 query 过滤名称）
act       click / right_click / double_click / type / switch_app / launch_app；不做任意命令
```
上游 `windows-mcp` 一共注册了十几个 MCP 工具（含 PowerShell / Registry / 文件系统），
本 worker **一个都不代理**：它只 import `windows_mcp.desktop.service.Desktop`，
不 import `windows_mcp.__main__`（因此既不起 MCP 服务，也不初始化 PostHog 遥测）。

============================================================================
 三条硬性质（各有机器闸）
============================================================================
① **离线**：socket / urllib 在 import 之前就被打桩拒绝（`networkAttempts` 如实回传）。
   ⇒ "她自己看桌面"这件事不产生任何出站流量，也没有匿名遥测。
② **固定版本**：`windows-mcp` 的 dist-info 版本必须逐字等于 header 里的 `expectedVersion`
   （缺省 `0.8.7`），否则失败关闭（`runtime_mismatch`）。
③ **不做半懂的操作**：`act` 先在**本进程**重新取一次快照，然后
   逐条核对"索引→控件名→所属窗口→前台窗口"，任何一条不成立就失败关闭
   （`stale_reference` / `window_mismatch` / `focus_changed` / `not_actionable`）。
   引用过期不猜、多匹配不猜、用户切走了不动手。
"""

import importlib.metadata as metadata
import json
import os
import socket
import sys
import time
import traceback
import urllib.request

# --- 编码：**逐字** UTF-8，不依赖本机 ANSI 代码页 ---------------------------
# （本仓库真实踩过：PowerShell 重定向把 UTF-8 中文读成 ANSI ⇒ 看起来像 JSON 坏了。）
sys.stdin.reconfigure(encoding='utf-8', errors='replace')
sys.stdout.reconfigure(encoding='utf-8', errors='replace', newline='\n')

# --- ① 离线闸：必须在 import 上游之前打好桩 --------------------------------
network_attempts = 0


def deny_network(*args, **kwargs):
    global network_attempts
    network_attempts += 1
    raise RuntimeError('DESKTOP_CONTROL_OFFLINE_GUARD')


socket.socket.connect = deny_network
socket.socket.connect_ex = deny_network
socket.socket.sendto = deny_network
socket.create_connection = deny_network
socket.getaddrinfo = deny_network
urllib.request.urlopen = deny_network

PROTOCOL = 'desktop-control/1'
PINNED_PACKAGE = 'windows-mcp'
PINNED_VERSION = '0.8.7'

# 程序侧上限（**不接受 header 抬升**，只接受 header 下调）
MAX_ELEMENTS = 120
MAX_WINDOWS = 40
MAX_NAME_CHARS = 200
MAX_TEXT_CHARS = 4000
ACTION_WHITELIST = ('click', 'right_click', 'double_click', 'type', 'switch_app', 'launch_app')
# 程序侧的 shell 文件夹闭集（与 TS 侧 `DESKTOP_SHELL_FOLDERS` 同表；门核对两处逐字一致）。
# 回收站 / 此电脑 / 控制面板**不是应用**，不在开始菜单应用目录里 ⇒ 以前 launch_app 打不开它们。
# ⚠️ 提交给 ShellExecute 的目标只来自这张表或系统应用目录；模型给的路径 / CLSID / shell: 文本永不进目标。
SHELL_FOLDERS = (
    ('回收站', ('recycle bin', 'recycle_bin'), 'shell:RecycleBinFolder'),
    ('此电脑', ('this pc', 'my computer', 'this_pc'), 'shell:MyComputerFolder'),
    ('控制面板', ('control panel', 'control_panel'), 'shell:ControlPanelFolder'),
)
PASSWORD_PLACEHOLDER = '(密码字段)'
# 可编辑控件**当前值**最多回多少字符（读回要用它；密码字段一律不取值）
MAX_VALUE_CHARS = 200
EDIT_CONTROL_HINTS = ('edit', 'document', 'text', '编辑', '文档', '文本')


def emit(result, code=0):
    result['networkAttempts'] = network_attempts
    sys.stdout.write('DESKTOP_CONTROL_RESULT=' + json.dumps(result, ensure_ascii=False))
    sys.stdout.write('\n')
    sys.stdout.flush()
    raise SystemExit(code)


def fail(reason, message, code=5, **extra):
    payload = {'ok': False, 'code': reason, 'message': message}
    payload.update(extra)
    emit(payload, code)


def sanitize(value):
    """把 UIA 交出来的字符串修成**一定能严格 UTF-8 编码**的形态。

    UIA 会给出落单的 UTF-16 代理对（表情符号等）与私有区字符（VS Code 的导航栏）。
    前者的后果很重：一次编码失败会让**整个**结果消失 —— 而"什么都没读到"与
    "读到了但发不出去"在用户看来是两件事。这里两条都如实清理，绝不抛。
    """
    text = '' if value is None else str(value)
    text = ''.join(
        ch
        for ch in text
        if not ('\ue000' <= ch <= '\uf8ff' or '\U000f0000' <= ch <= '\U0010fffd')
    )
    return text.encode('utf-8', 'replace').decode('utf-8', 'replace')


def clip(value, limit):
    text = sanitize(value)
    if len(text) <= limit:
        return text
    return text[:limit] + '…'


def as_int(value, default=None):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


# --- ② 固定版本 ------------------------------------------------------------


def assert_pinned_version(expected):
    try:
        installed = metadata.version(PINNED_PACKAGE)
    except metadata.PackageNotFoundError:
        fail('runtime_mismatch', f'本机没有安装 {PINNED_PACKAGE}（期望 {expected}）', 3)
    if installed != expected:
        fail('runtime_mismatch', f'{PINNED_PACKAGE} 版本是 {installed}，期望 {expected}', 3)
    return installed


# --- 有界渲染 --------------------------------------------------------------


def element_view(node, index):
    """把一个 interactive 节点渲染成**有界**的结构（密码字段一律不取值）。"""
    meta = node.metadata or {}
    is_password = bool(meta.get('is_password'))
    name = PASSWORD_PLACEHOLDER if is_password else clip(node.name, MAX_NAME_CHARS)
    view = {
        'index': index,
        'controlType': clip(node.control_type, 40),
        'name': name,
        'window': clip(node.window_name, MAX_NAME_CHARS),
        'x': int(node.center.x),
        'y': int(node.center.y),
        'focused': bool(meta.get('has_focused')),
        'password': is_password,
    }
    if meta.get('expand_collapse_state'):
        view['expandState'] = clip(meta.get('expand_state'), 20)
    if meta.get('toggle_state'):
        view['toggleState'] = clip(meta.get('toggle_state'), 20)
    '''
    可编辑控件的**当前值**（读回要用它）。

    ⚠️ 只对**看起来可编辑**的控件取值（上游在元数据里给 `value`），且密码字段一律不取 ——
       "她看得到输入框里现在写着什么"是"看桌面"的一部分（上游默认也会带出来），
       但密码框的内容不属于这一部分。
    '''
    control = str(node.control_type or '').lower()
    raw_value = meta.get('value')
    if not is_password and isinstance(raw_value, str) and raw_value not in ('', '(empty)'):
        if any(hint in control for hint in EDIT_CONTROL_HINTS):
            view['value'] = clip(raw_value, MAX_VALUE_CHARS)
    return view


def window_view(window):
    return {
        'name': clip(window.name, MAX_NAME_CHARS),
        'handle': int(window.handle),
        'status': window.status.value if window.status is not None else 'Unknown',
        'width': int(window.bounding_box.width),
        'height': int(window.bounding_box.height),
        'processId': int(window.process_id),
    }


def collect_state(desktop, *, window_filter, max_elements):
    """取一次快照，返回**纯数据**（不含任何 PIL 图像）。"""
    from windows_mcp.desktop.service import Size

    started = time.perf_counter()
    state = desktop.get_state(
        use_vision=False,
        use_dom=False,
        use_annotation=False,
        use_ui_tree=True,
        as_bytes=False,
        scale=1.0,
        grid_lines=None,
        display_indices=None,
        region=None,
        max_image_size=Size(width=1920, height=1080),
    )
    state_ms = (time.perf_counter() - started) * 1000

    tree = state.tree_state
    nodes = list(getattr(tree, 'interactive_nodes', []) or [])
    wanted = (window_filter or '').strip().lower()
    if wanted:
        filtered = [node for node in nodes if wanted in str(node.window_name or '').lower()]
    else:
        filtered = list(nodes)

    elements = [element_view(node, index) for index, node in enumerate(filtered[:max_elements])]
    windows = [window_view(window) for window in list(state.windows or [])[:MAX_WINDOWS]]
    active = state.active_window
    return {
        'stateMs': state_ms,
        'captureSec': float(getattr(state, 'capture_sec', 0.0) or 0.0),
        'activeWindow': window_view(active) if active is not None else None,
        'windows': windows,
        'windowsTotal': len(list(state.windows or [])),
        'elements': elements,
        'elementsTotal': len(filtered),
        'elementsOnDesktop': len(nodes),
        'truncated': bool(getattr(tree, 'truncated', False)) or len(filtered) > len(elements),
        'elementLimit': int(getattr(tree, 'element_limit', 0) or 0),
        'windowFound': True if not wanted else len(filtered) > 0,
    }


def render_state_text(state, *, window_filter):
    """给**模型**看的有界文本（每一行一个可指名的元素）。

    ⚠️ 返回值是 `(text, charsBeforeClip, clipped)` 三元组：
       **裁剪前的字符数要如实交出去** —— 否则"裁剪"这件事会在调用方那里消失
       （2026-10-05 实测：这里先裁到 4000+省略号，适配器再拿 4001 去判"有没有超上限"
       ⇒ `truncated` 永远是 false。范围事实必须由**知道原始长度**的那一侧给出）。
    """
    lines = []
    active = state['activeWindow']
    lines.append(
        '前台窗口：' + (f"{active['name']}（句柄 {active['handle']}）" if active else '（无）')
    )
    shown = 0
    for window in state['windows']:
        lines.append(
            f"窗口：{window['name']}｜{window['status']}｜{window['width']}x{window['height']}｜"
            f"句柄 {window['handle']}"
        )
        shown += 1
    if state['windowsTotal'] > shown:
        lines.append(f"（还有 {state['windowsTotal'] - shown} 个窗口未列出）")
    scope = '全部窗口' if not window_filter else f'窗口含「{clip(window_filter, MAX_NAME_CHARS)}」'
    lines.append(f'可交互元素（{scope}，共 {state["elementsTotal"]} 个）：')
    for element in state['elements']:
        focus = '｜当前焦点' if element['focused'] else ''
        value = f"｜值：「{element['value']}」" if element.get('value') else ''
        lines.append(
            f"#{element['index']} {element['controlType']}「{element['name']}」"
            f"@{element['x']},{element['y']}｜窗口「{element['window']}」{focus}{value}"
        )
    if state['elementsTotal'] > len(state['elements']):
        lines.append(f"（只列了前 {len(state['elements'])} 个；更具体地按窗口再查一次）")
    if state['truncated']:
        lines.append('（上游快照本身在上限处截断了：有些元素没被访问到）')
    joined = '\n'.join(lines)
    clipped = len(joined) > MAX_TEXT_CHARS
    return (joined[:MAX_TEXT_CHARS] + '…' if clipped else joined, len(joined), clipped)


# --- act：核对链 -----------------------------------------------------------


def resolve_target(desktop, header):
    """按 header 重新取快照并核对索引 → 返回 (state, element, window_view)。"""
    window_filter = header.get('window')
    if not isinstance(window_filter, str) or window_filter.strip() == '':
        fail('validation_failed', 'act 必须带上它看到过的窗口名（window）', 2)
    index = as_int(header.get('index'))
    if index is None or index < 0 or index >= MAX_ELEMENTS:
        fail('validation_failed', f'index 不合法：{header.get("index")!r}', 2)
    name = header.get('name')
    if not isinstance(name, str) or name.strip() == '':
        fail('validation_failed', 'act 必须带上它看到过的控件名（name）', 2)

    state = collect_state(desktop, window_filter=window_filter, max_elements=MAX_ELEMENTS)
    if not state['windowFound']:
        fail(
            'window_not_found',
            f'没有窗口的名字里含「{window_filter.strip()}」⇒ 请先重新查看桌面状态',
            4,
            state=state,
        )
    if index >= len(state['elements']):
        fail(
            'stale_reference',
            f'#{index} 在这一次快照里不存在（共有 {state["elementsTotal"]} 个）⇒ 请重新查看后再操作',
            4,
            state=state,
        )
    element = state['elements'][index]
    if element['name'].strip() != name.strip():
        fail(
            'stale_reference',
            f'#{index} 现在叫「{element["name"]}」，不是它看到过的「{name}」⇒ 引用已过期',
            4,
            state=state,
        )
    requested = window_filter.strip()
    if requested.lower() not in element['window'].lower():
        fail(
            'window_mismatch',
            f'#{index} 属于窗口「{element["window"]}」，不是「{requested}」',
            4,
            state=state,
        )
    active = state['activeWindow']
    if active is None or requested.lower() not in active['name'].lower():
        fail(
            'focus_changed',
            f'目标窗口「{requested}」现在不在前台（前台是'
            + (f"「{active['name']}」" if active else '空')
            + '）⇒ 不猜、不动手；请先把那个窗口切到前面',
            4,
            state=state,
        )
    return state, element


def require_name(value, field):
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_NAME_CHARS or any(ch in value for ch in '\r\n\0'):
        fail('validation_failed', f'{field} 必须是非空、有界的实际名称', 2)
    return value


def resolve_window(desktop, header):
    title = require_name(header.get('window'), 'window')
    handle = header.get('handle')
    if type(handle) is not int or handle <= 0:
        fail('validation_failed', 'switch_app 必须带正整数 handle', 2)
    state = collect_state(desktop, window_filter=None, max_elements=1)
    windows = state['windows'] + ([state['activeWindow']] if state['activeWindow'] else [])
    matches = [window for window in windows if window['handle'] == handle and window['name'] == title]
    if not matches:
        fail('stale_reference', '窗口标题或句柄已变化，请重新查看桌面', 4)
    return state, matches[0]


def resolve_launch_target(desktop, name):
    """解析启动目标，返回 `(显示名, 提交给 ShellExecute 的目标, 类别)`。

    ⚠️ **目标只来自两处**：① 本文件的程序常量表 `SHELL_FOLDERS`（回收站 / 此电脑 / 控制面板）；
    ② 上游的系统应用目录。模型给的**只**是一个名字 —— 它给的路径 / CLSID / `shell:` 文本
    既进不了参数，也进不了目标（含 `\\`、`/`、`:` 的名字在这里就被拒）。
    """
    name = require_name(name, 'name')
    if any(ch in name for ch in '\\/:'):
        fail('validation_failed', '启动只接受应用目录或系统文件夹的名字，不接受路径、命令或 shell: 前缀', 2)
    folded = name.casefold()
    for label, aliases, target in SHELL_FOLDERS:
        if folded == label.casefold() or folded in tuple(alias.casefold() for alias in aliases):
            return label, target, '系统文件夹'
    apps = desktop.get_apps_from_start_menu()
    matches = [(key, value) for key, value in apps.items() if key.casefold() == folded]
    if not matches:
        fail('window_not_found', '应用目录和系统文件夹里都没有这个完整名称，请先用 desktop.inspect.apps 查询', 4)
    if len(matches) != 1:
        fail('target_ambiguous', '应用名称不唯一，不能确定启动目标', 4)
    app_name, app_id = matches[0]
    from windows_mcp.desktop.utils import resolve_known_folder_guid_path
    # 目标来自系统目录；不用模型给出的路径、命令、argv 或 Shell 文本。
    target = resolve_known_folder_guid_path(app_id) if '\\' in app_id else 'shell:AppsFolder\\' + app_id
    if '\\' in app_id and not os.path.isfile(target):
        fail('window_not_found', '应用目录引用的启动目标已不存在', 4)
    return app_name, target, '应用'


def perform_window_action(desktop, header):
    action = header['action']
    if action == 'switch_app':
        state, window = resolve_window(desktop, header)
        performed = {'action': action, 'window': window['name'], 'handle': window['handle'], 'controlType': '窗口'}
    else:
        app_name, target, kind = resolve_launch_target(desktop, header.get('name'))
        state = None
        performed = {'action': action, 'name': app_name, 'controlType': kind}
    if header.get('dryRun') is True:
        return state, performed
    if action == 'switch_app':
        import win32gui
        desktop.bring_window_to_top(window['handle'])
        deadline = time.perf_counter() + 1.0
        while win32gui.GetForegroundWindow() != window['handle']:
            if time.perf_counter() >= deadline:
                fail('focus_changed', '系统未把指定句柄切到前台，不能报告切换成功', 4)
            time.sleep(0.05)
    else:
        os.startfile(target)
        performed['launchRequested'] = True
    return state, performed


# --- main ------------------------------------------------------------------


def main():
    header_line = sys.stdin.buffer.readline(64 * 1024)
    try:
        header = json.loads(header_line)
    except (ValueError, UnicodeError):
        fail('protocol_error', 'desktop 输入头不合法（不是一个 JSON 对象）', 2)
    if not isinstance(header, dict) or header.get('protocol') != PROTOCOL:
        fail('protocol_error', f'协议名必须是 {PROTOCOL}', 2)

    op = header.get('op')
    expected = header.get('expectedVersion') or PINNED_VERSION
    if not isinstance(expected, str):
        fail('protocol_error', 'expectedVersion 必须是字符串', 2)

    if op == 'runtime':
        installed = assert_pinned_version(expected)
        emit({'ok': True, 'op': 'runtime', 'package': PINNED_PACKAGE, 'version': installed})

    import_started = time.perf_counter()
    from windows_mcp.desktop.service import Desktop  # noqa: E402  (离线闸之后才 import)

    import_ms = (time.perf_counter() - import_started) * 1000
    installed = assert_pinned_version(expected)

    if not sys.platform.startswith('win'):
        fail('runtime_mismatch', f'这个 worker 只能在 Windows 上跑（当前 {sys.platform}）', 3)

    desktop = Desktop()

    if op == 'apps':
        query = header.get('query', '')
        if not isinstance(query, str) or len(query) > MAX_NAME_CHARS:
            fail('validation_failed', 'query 必须是有界字符串', 2)
        folded_query = query.casefold()
        names = sorted(name for name in desktop.get_apps_from_start_menu() if folded_query in name.casefold())
        listed = names[:MAX_ELEMENTS]
        '''
        系统文件夹与"应用"**分开列**（它们是程序常量，不是开始菜单里的东西），
        但同样参与 `query` 过滤、同样能用 `launch_app` 按名字打开。
        ⚠️ 下面这两行文本里不得出现 ASCII 的 "id" 子串 —— 门有一条断言：
           应用目录引用的**目标**（.lnk 路径 / AppID）不许泄漏进给模型看的文本。
        '''
        folders = [label for label, aliases, target in SHELL_FOLDERS if folded_query in label.casefold()]
        lines = ['系统应用目录（启动使用逐字名称；不是窗口或控件列表）：']
        lines.extend(clip(name, MAX_NAME_CHARS) for name in listed)
        if len(names) > len(listed):
            lines.append(f'（应用还有 {len(names) - len(listed)} 项未列出；用 query 收窄）')
        lines.append('系统文件夹（同样按名字启动；它们不是应用）：')
        lines.extend(folders if folders else ['（没有匹配的系统文件夹）'])
        text = '\n'.join(lines)
        emit({'ok': True, 'op': 'apps', 'version': installed, 'appsListed': len(listed),
              'shellFolders': folders,
              'state': {'windowsTotal': 0, 'elements': [], 'truncated': len(names) > len(listed)},
              'text': text[:MAX_TEXT_CHARS], 'textCharsBeforeClip': len(text), 'textClipped': len(text) > MAX_TEXT_CHARS})

    if op == 'state':
        window_filter = header.get('window')
        if window_filter is not None and not isinstance(window_filter, str):
            fail('validation_failed', 'window 必须是字符串或省略', 2)
        requested = as_int(header.get('maxElements'), MAX_ELEMENTS)
        max_elements = max(1, min(requested if requested else MAX_ELEMENTS, MAX_ELEMENTS))
        state = collect_state(
            desktop, window_filter=window_filter, max_elements=max_elements
        )
        if not state['windowFound']:
            fail(
                'window_not_found',
                f'没有窗口的名字里含「{window_filter}」⇒ 请先看不带 window 的整体状态',
                4,
                state=state,
            )
        rendered, chars_before_clip, text_clipped = render_state_text(
            state, window_filter=window_filter
        )
        emit(
            {
                'ok': True,
                'op': 'state',
                'version': installed,
                'state': state,
                'text': rendered,
                'textCharsBeforeClip': chars_before_clip,
                'textClipped': text_clipped,
                'timingMs': {'import': import_ms, 'state': state['stateMs']},
            }
        )

    if op == 'act':
        action = header.get('action')
        if action not in ACTION_WHITELIST:
            fail(
                'unsupported_action',
                f'动作必须是闭集 {list(ACTION_WHITELIST)} 之一，收到 {action!r}',
                2,
            )
        action_started = time.perf_counter()
        window_action = action in ('switch_app', 'launch_app')
        if window_action:
            forbidden = ('index', 'name', 'content') if action == 'switch_app' else ('window', 'index', 'handle', 'content')
            if any(header.get(key) is not None for key in forbidden):
                fail('validation_failed', '窗口或应用动作含有不适用的参数', 2)
            state, performed = perform_window_action(desktop, header)
        else:
            state, element = resolve_target(desktop, header)
            if element['password']:
                fail('not_actionable', f'#{element["index"]} 是密码字段 ⇒ 不接受操作', 4)
            performed = {
                'action': action, 'index': element['index'], 'name': element['name'],
                'controlType': element['controlType'], 'window': element['window'],
                'x': element['x'], 'y': element['y'],
            }
        '''
        **干跑**（`dryRun: true`）：核对链**全部跑完**，但**不动手**。

        ⚠️ 这不是给模型用的开关（它不在 `TASK_ARG_KEYS` 里，模型给不出这个字段）；
        它是**程序**用的：实机只读门要能验证"核对链会放行一个合法目标"，
        而那次验证**绝不能**真的点下去（2026-10-05：这个门第一版正是因此真点了一次，
        见 `docs/post-lv2/Desktop-Control-WP5-Probe-Record.md` 的事故记录）。
        '''
        if header.get('dryRun') is True:
            emit(
                {
                    'ok': True,
                    'op': 'act',
                    'version': installed,
                    'dryRun': True,
                    'wouldPerform': performed,
                    'guardChain': 'passed',
                    'timingMs': {'import': import_ms, 'resolve': state['stateMs'] if state else 0},
                }
            )
        if action == 'right_click':
            '''
            右键：与单击**同一条**核对链（索引 / 名字 / 所属窗口 / 前台），只是换按键。

            ⚠️ 它弹出的上下文菜单是**另一个顶层窗口**，菜单项**不属于**右键前那个窗口。
               ⇒ 下面的读回因此不用 `window` 过滤（与 double_click 同规）：交回去的是
               **整个桌面的新快照**，模型必须按这份新快照里的窗口名与 index 再点菜单项。
            '''
            desktop.click((element['x'], element['y']), button='right', clicks=1)
        elif action in ('click', 'double_click'):
            desktop.click((element['x'], element['y']), clicks=2 if action == 'double_click' else 1)
        elif action == 'type':
            content = header.get('content')
            if not isinstance(content, str) or content == '':
                fail('validation_failed', 'type 必须带上要输入的正文（content）', 2)
            if len(content) > MAX_TEXT_CHARS:
                fail('validation_failed', f'一次最多输入 {MAX_TEXT_CHARS} 个字符', 2)
            # `clear=False`：**不**替用户清空既有内容（那是不可撤回的破坏）。
            desktop.type((element['x'], element['y']), text=content, clear=False)
            performed['enteredChars'] = len(content)
        action_ms = (time.perf_counter() - action_started) * 1000

        readback_filter = None if window_action or action in ('double_click', 'right_click') else header.get('window')
        readback = collect_state(desktop, window_filter=readback_filter, max_elements=20)
        readback_text, readback_chars, readback_clipped = render_state_text(
            readback, window_filter=readback_filter
        )
        emit(
            {
                'ok': True,
                'op': 'act',
                'version': installed,
                'performed': performed,
                'readback': {
                    'activeWindow': readback['activeWindow'],
                    'windowsTotal': readback['windowsTotal'],
                    'elementsTotal': readback['elementsTotal'],
                    'truncated': readback['truncated'],
                },
                'readbackText': readback_text,
                'readbackCharsBeforeClip': readback_chars,
                'readbackClipped': readback_clipped,
                'timingMs': {
                    'import': import_ms,
                    'resolve': state['stateMs'] if state else 0,
                    'action': action_ms,
                    'readback': readback['stateMs'],
                },
            }
        )

    fail('protocol_error', f'未知 op：{op!r}（只支持 runtime / state / apps / act）', 2)


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 —— 失败关闭：任何异常都如实回一条
        fail('execution_failed', f'desktop worker 执行失败（{type(error).__name__}）', 5,
             traceback=clip(traceback.format_exc(), 2000))
