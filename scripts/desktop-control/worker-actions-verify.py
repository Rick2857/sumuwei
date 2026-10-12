"""真实生产 worker 的动作路由与目标核对；替换 OS/UIA 端口，不碰用户桌面。"""
import copy
import importlib.util
import io
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
worker_path = Path(__file__).resolve().parents[2] / 'src/infrastructure/action/adapters/desktop-control-worker.py'
spec = importlib.util.spec_from_file_location('desktop_worker_test', worker_path)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

WINDOW = {'name': '夹具窗口', 'handle': 42, 'status': 'Normal', 'width': 100, 'height': 100, 'processId': 7}
ELEMENT = {'index': 0, 'name': '确定', 'window': '夹具窗口', 'x': 10, 'y': 20,
           'focused': False, 'password': False, 'controlType': '按钮'}
STATE = {'windows': [WINDOW], 'activeWindow': WINDOW, 'windowsTotal': 1, 'elements': [ELEMENT],
         'elementsTotal': 1, 'windowFound': True, 'truncated': False, 'stateMs': 1}


class DesktopActions(unittest.TestCase):
    def setUp(self):
        from unittest.mock import Mock
        self.desktop = Mock()
        self.desktop.get_apps_from_start_menu.return_value = {'microsoft edge': r'C:\Programs\Edge.lnk'}
        self.state = copy.deepcopy(STATE)
        service = types.ModuleType('windows_mcp.desktop.service')
        service.Desktop = lambda: self.desktop
        utils = types.ModuleType('windows_mcp.desktop.utils')
        utils.resolve_known_folder_guid_path = lambda value: value
        foreground = types.ModuleType('win32gui')
        foreground.GetForegroundWindow = lambda: 42
        self.patchers = [
            patch.dict(sys.modules, {'windows_mcp.desktop.service': service,
                                     'windows_mcp.desktop.utils': utils, 'win32gui': foreground}),
            patch.object(worker, 'collect_state', side_effect=lambda *args, **kwargs: self.state),
            patch.object(worker.metadata, 'version', return_value='0.8.7'),
            patch.object(sys, 'platform', 'win32'),
            patch.object(worker.os.path, 'isfile', return_value=True),
            patch.object(worker.os, 'startfile', create=True),
        ]
        self.startfile = None
        for patcher in self.patchers:
            self.startfile = patcher.start()
            self.addCleanup(patcher.stop)

    def call(self, **header):
        data = {'protocol': 'desktop-control/1', 'expectedVersion': '0.8.7', **header}
        with patch.object(sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(json.dumps(data).encode()))), \
                patch.object(sys, 'stdout', new_callable=io.StringIO) as output:
            with self.assertRaises(SystemExit) as stopped:
                worker.main()
            result = json.loads(output.getvalue().strip().split('=', 1)[1])
        self.assertEqual(result['ok'], stopped.exception.code == 0)
        return result

    def control(self, action, **extra):
        return self.call(op='act', action=action, window='夹具窗口', index=0, name='确定', **extra)

    def test_double_click_reaches_upstream_with_two_clicks(self):
        result = self.control('double_click')
        self.assertTrue(result['ok'])
        self.desktop.click.assert_called_once_with((10, 20), clicks=2)
        self.assertIn('前台窗口', result['readbackText'])

    def test_single_click_stays_single(self):
        self.assertTrue(self.control('click')['ok'])
        self.desktop.click.assert_called_once_with((10, 20), clicks=1)

    def test_right_click_presses_the_right_button_once(self):
        self.assertTrue(self.control('right_click')['ok'])
        self.desktop.click.assert_called_once_with((10, 20), button='right', clicks=1)

    def test_right_click_readback_is_not_filtered_by_the_target_window(self):
        """右键弹出的上下文菜单是**另一个顶层窗口**；读回若按 window 过滤，菜单项会被滤掉。

        ⇒ 第一次取快照仍按目标窗口过滤（核对用），**读回**那次必须不带过滤（与 double_click 同规）。
        """
        self.assertTrue(self.control('right_click')['ok'])
        self.assertEqual(worker.collect_state.call_args_list[0].kwargs['window_filter'], '夹具窗口')
        self.assertIsNone(worker.collect_state.call_args_list[-1].kwargs['window_filter'])

    def test_right_click_keeps_the_same_guards(self):
        self.state['elements'][0]['name'] = '变更'
        self.assertEqual(self.control('right_click')['code'], 'stale_reference')
        self.desktop.click.assert_not_called()

    def test_right_click_dry_run_never_clicks(self):
        self.assertTrue(self.control('right_click', dryRun=True)['dryRun'])
        self.desktop.click.assert_not_called()

    def test_double_click_dry_run_never_clicks(self):
        self.assertTrue(self.control('double_click', dryRun=True)['dryRun'])
        self.desktop.click.assert_not_called()

    def test_double_click_keeps_stale_and_foreground_guards(self):
        for key, value, expected in [('name', '变更', 'stale_reference'), ('activeWindow', None, 'focus_changed')]:
            self.state = copy.deepcopy(STATE)
            if key == 'name':
                self.state['elements'][0][key] = value
            else:
                self.state[key] = value
            self.assertEqual(self.control('double_click')['code'], expected)
        self.desktop.click.assert_not_called()

    def test_password_control_is_rejected(self):
        self.state['elements'][0]['password'] = True
        self.assertEqual(self.control('double_click')['code'], 'not_actionable')
        self.desktop.click.assert_not_called()

    def test_switch_exact_handle(self):
        self.assertTrue(self.call(op='act', action='switch_app', window='夹具窗口', handle=42)['ok'])
        self.desktop.bring_window_to_top.assert_called_once_with(42)

    def test_switch_stale_handle_or_title_does_not_activate(self):
        for title, handle in [('夹具窗口', 43), ('夹具', 42), ('夹具窗口', '42')]:
            self.assertFalse(self.call(op='act', action='switch_app', window=title, handle=handle)['ok'])
        self.desktop.bring_window_to_top.assert_not_called()

    def test_switch_checks_actual_foreground(self):
        with patch.object(sys.modules['win32gui'], 'GetForegroundWindow', return_value=99), \
                patch.object(worker.time, 'perf_counter', side_effect=range(100)):
            result = self.call(op='act', action='switch_app', window='夹具窗口', handle=42)
        self.assertEqual(result['code'], 'focus_changed')

    def test_switch_dry_run_never_activates(self):
        self.assertTrue(self.call(op='act', action='switch_app', window='夹具窗口', handle=42, dryRun=True)['dryRun'])
        self.desktop.bring_window_to_top.assert_not_called()

    def test_launch_uses_exact_directory_target_and_reads_back(self):
        result = self.call(op='act', action='launch_app', name='Microsoft Edge')
        self.assertTrue(result['ok'])
        self.assertTrue(result['performed']['launchRequested'])
        self.startfile.assert_called_once_with(r'C:\Programs\Edge.lnk')
        self.assertIn('activeWindow', result['readback'])

    def test_launch_does_not_fuzzy_match(self):
        self.assertEqual(self.call(op='act', action='launch_app', name='Edge')['code'], 'window_not_found')
        self.startfile.assert_not_called()

    def test_launch_registered_app_id_uses_shell_namespace(self):
        self.desktop.get_apps_from_start_menu.return_value = {'记事本': 'Microsoft.Notepad!App'}
        self.assertTrue(self.call(op='act', action='launch_app', name='记事本')['ok'])
        self.startfile.assert_called_once_with('shell:AppsFolder\\Microsoft.Notepad!App')

    def test_launch_rejects_paths_and_extra_args(self):
        for extra in [{'name': r'C:\Windows\cmd.exe'}, {'name': 'microsoft edge', 'content': '--anything'},
                      {'name': 'microsoft edge', 'window': '夹具窗口'}]:
            self.assertEqual(self.call(op='act', action='launch_app', **extra)['code'], 'validation_failed')
        self.startfile.assert_not_called()

    def test_launch_missing_reference_and_ambiguity(self):
        self.desktop.get_apps_from_start_menu.return_value = {'Microsoft Edge': 'a', 'microsoft edge': 'b'}
        self.assertEqual(self.call(op='act', action='launch_app', name='Microsoft Edge')['code'], 'target_ambiguous')
        self.startfile.assert_not_called()

    def test_launch_missing_target_does_not_start(self):
        with patch.object(worker.os.path, 'isfile', return_value=False):
            self.assertEqual(self.call(op='act', action='launch_app', name='Microsoft Edge')['code'], 'window_not_found')
        self.startfile.assert_not_called()

    def test_launch_dry_run_never_starts(self):
        self.assertTrue(self.call(op='act', action='launch_app', name='Microsoft Edge', dryRun=True)['dryRun'])
        self.startfile.assert_not_called()

    def test_apps_discovery_filter_and_bounds(self):
        self.desktop.get_apps_from_start_menu.return_value = {f'app {index}': 'id' for index in range(130)}
        result = self.call(op='apps', query='app')
        self.assertTrue(result['ok'])
        self.assertEqual(result['appsListed'], 120)
        self.assertTrue(result['state']['truncated'])
        self.assertLessEqual(len(result['text']), 4000)
        self.assertNotIn('id', result['text'])

    def test_unregistered_action_is_rejected(self):
        self.assertEqual(self.control('scroll')['code'], 'unsupported_action')
        self.desktop.click.assert_not_called()

    def test_shell_folder_launch_submits_the_program_target_only(self):
        """三个系统文件夹按名字启动；提交给 ShellExecute 的目标**只来自程序常量表**。"""
        for name, target in [('回收站', 'shell:RecycleBinFolder'),
                             ('Recycle Bin', 'shell:RecycleBinFolder'),
                             ('recycle_bin', 'shell:RecycleBinFolder'),
                             ('此电脑', 'shell:MyComputerFolder'),
                             ('This PC', 'shell:MyComputerFolder'),
                             ('控制面板', 'shell:ControlPanelFolder')]:
            self.startfile.reset_mock()
            result = self.call(op='act', action='launch_app', name=name)
            self.assertTrue(result['ok'], f'{name} ⇒ {result}')
            self.startfile.assert_called_once_with(target)
            self.assertEqual(result['performed']['controlType'], '系统文件夹')

    def test_shell_folder_names_cannot_inject_a_target(self):
        """模型给的名字**永远**成不了目标：路径 / CLSID / shell: 文本一律开不了口。"""
        for name, expected in [('shell:RecycleBinFolder', 'validation_failed'),
                               ('::{645FF040-5081-101B-9F08-00AA002F954E}', 'validation_failed'),
                               ('C:\\Windows\\explorer.exe', 'validation_failed'),
                               ('回收站/../..', 'validation_failed'),
                               ('{645FF040-5081-101B-9F08-00AA002F954E}', 'window_not_found')]:
            self.startfile.reset_mock()
            result = self.call(op='act', action='launch_app', name=name)
            self.assertFalse(result['ok'], name)
            self.assertEqual(result['code'], expected, name)
            self.startfile.assert_not_called()

    def test_shell_folder_launch_dry_run_never_starts(self):
        self.assertTrue(self.call(op='act', action='launch_app', name='回收站', dryRun=True)['dryRun'])
        self.startfile.assert_not_called()

    def test_apps_lists_shell_folders_and_filters_them(self):
        """系统文件夹与"应用"分开列，同样参与 query 过滤，且不泄漏启动目标。"""
        self.desktop.get_apps_from_start_menu.return_value = {'microsoft edge': r'C:\Programs\Edge.lnk'}
        result = self.call(op='apps')
        self.assertTrue(result['ok'])
        self.assertEqual(result['shellFolders'], ['回收站', '此电脑', '控制面板'])
        for label in ('回收站', '此电脑', '控制面板'):
            self.assertIn(label, result['text'])
        self.assertNotIn('Edge.lnk', result['text'])
        only = self.call(op='apps', query='回收')
        self.assertEqual(only['shellFolders'], ['回收站'])
        self.assertIn('回收站', only['text'])
        self.assertNotIn('控制面板', only['text'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
