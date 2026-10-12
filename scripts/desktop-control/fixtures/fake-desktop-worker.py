"""离线夹具 worker（**只有门用它**）：说同一套协议，不碰 UIA、不 import windows-mcp。

用途：让 `desktop-control.ts` 的适配器在**离线**可判定 ——
协议（恰好一行）· 有界与截断 · 具名码 → 内核失败码的映射 · 闭集动作 ·
"必须在拉起进程之前就拒掉"的那几条 · 隐私边界（正文不进证据）。

⚠️ 场景由**环境变量** `DESKTOP_FIXTURE_SCENARIO` 给定（适配器把 env 原样传给子进程）。
⚠️ 它**不是**生产 worker 的替身：生产 worker 的判定链（索引/名字/窗口/前台）由
   `desktop-control:probe` 在**真机**上用真 worker 的负控档测（门里说清楚了测的是哪一半）。
"""

import json
import os
import pathlib
import sys
import time

sys.stdin.reconfigure(encoding='utf-8', errors='replace')
sys.stdout.reconfigure(encoding='utf-8', errors='replace', newline='\n')


def emit(payload, code=0):
    sys.stdout.write('DESKTOP_CONTROL_RESULT=' + json.dumps(payload, ensure_ascii=False) + '\n')
    sys.stdout.flush()
    raise SystemExit(code)


def state_payload(text, windows=2, elements=3, truncated=False, before_clip=None, clipped=False):
    payload = {
        'ok': True,
        'op': 'state',
        'version': '0.8.7',
        'state': {
            'windowsTotal': windows,
            'elementsTotal': elements,
            'truncated': truncated,
            'windowFound': True,
        },
        'text': text,
        'timingMs': {'import': 1.0, 'state': 1.0},
    }
    if before_clip is not None:
        payload['textCharsBeforeClip'] = before_clip
        payload['textClipped'] = clipped
    return payload


def main():
    header = json.loads(sys.stdin.buffer.readline(64 * 1024) or b'{}')
    scenario = os.environ.get('DESKTOP_FIXTURE_SCENARIO', 'state-ok')
    marker = os.environ.get('DESKTOP_FIXTURE_MARKER')
    if marker:
        pathlib.Path(marker).write_text(header.get('op', ''), encoding='utf-8')

    if scenario == 'state-ok':
        emit(state_payload('前台窗口：夹具窗口（句柄 1）\n#0 按钮「确定」@10,20｜窗口「夹具窗口」'))
    if scenario == 'state-reply':
        if header.get('op') == 'apps':
            payload = state_payload('系统应用目录：\nmicrosoft edge', windows=0, elements=0)
            payload.update({'op': 'apps', 'appsListed': 1})
            emit(payload)
        if header.get('op') == 'act':
            emit({'ok': True, 'op': 'act', 'performed': {
                'action': header.get('action'), 'name': header.get('name'), 'window': header.get('window'),
            }, 'readback': {'windowsTotal': 1, 'elementsTotal': 1, 'truncated': False},
                'readbackText': '前台窗口：夹具窗口（句柄 1）'})
        payload = state_payload('前台窗口：夹具窗口（句柄 1）\n#0 按钮「确定」@10,20｜窗口「夹具窗口」', windows=1, elements=1)
        payload['state']['elements'] = [{'index': 0, 'name': '确定', 'window': '夹具窗口'}]
        emit(payload)
    if scenario == 'state-empty-text':
        emit(state_payload(''))
    if scenario == 'state-huge':
        emit(state_payload('字' * 9000))
    if scenario == 'state-truncated-upstream':
        emit(state_payload('夹具文本', truncated=True))
    if scenario == 'state-worker-clipped':
        '''
        worker **自己**裁过（`textClipped` + 裁剪前长度）⇒ 适配器必须如实标 truncated。

        ⚠️ 这一档是 2026-10-05 实测缺陷的负控：worker 先裁到 4000 字符 + 省略号，
           适配器再拿 4001 去判"有没有超上限" ⇒ `truncated` **永远**是 false。
        '''
        emit(state_payload('裁过的文本' * 5, before_clip=9000, clipped=True))
    if scenario == 'state-worker-clipped-silently':
        '''worker 裁了但**没报**（只给比原文短的文本）⇒ 适配器仍须如实标 truncated。'''
        emit(state_payload('裁过的文本' * 5, before_clip=9000, clipped=False))
    if scenario == 'state-multiline-stdout':
        sys.stdout.write('这一行是多余的（协议只允许一行）\n')
        sys.stdout.flush()
        emit(state_payload('夹具文本'))
    if scenario == 'state-garbage':
        sys.stdout.write('DESKTOP_CONTROL_RESULT=这不是 JSON\n')
        sys.stdout.flush()
        raise SystemExit(0)
    if scenario == 'state-no-result-line':
        sys.stdout.write('什么都没有\n')
        sys.stdout.flush()
        raise SystemExit(0)
    if scenario == 'act-ok':
        emit(
            {
                'ok': True,
                'op': 'act',
                'version': '0.8.7',
                'performed': {
                    'action': header.get('action'),
                    'index': header.get('index'),
                    'name': header.get('name'),
                    'controlType': '按钮',
                    'window': header.get('window'),
                    'x': 42,
                    'y': 43,
                    'enteredChars': len(header.get('content') or ''),
                },
                'readback': {'windowsTotal': 2, 'elementsTotal': 3, 'truncated': False},
                'readbackText': '前台窗口：夹具窗口（句柄 1）',
                'timingMs': {'import': 1.0, 'resolve': 1.0, 'action': 1.0, 'readback': 1.0},
            }
        )
    if scenario.startswith('code:'):
        emit({'ok': False, 'code': scenario.split(':', 1)[1], 'message': '夹具给的具名失败'}, 4)
    if scenario.startswith('sleep:'):
        time.sleep(int(scenario.split(':', 1)[1]) / 1000)
        emit(state_payload('迟到的夹具文本'))
    emit({'ok': False, 'code': 'protocol_error', 'message': f'夹具不认识场景 {scenario}'}, 2)


try:
    main()
except SystemExit:
    raise
except Exception as error:  # noqa: BLE001
    emit({'ok': False, 'code': 'execution_failed', 'message': f'夹具异常 {type(error).__name__}'}, 5)
