"""Fault injection into the structural parser: an unread field must not become absent."""
import importlib.util
import pathlib
import sys
import types

source = pathlib.Path(__file__).parents[1] / 'utility-skills' / 'pdf-profile-runner.py'
spec = importlib.util.spec_from_file_location('profile_runner', source)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class Page:
    images = []
    def __init__(self, broken=False):
        self.broken = broken
    @property
    def chars(self):
        if self.broken:
            raise ValueError('controlled unreadable chars')
        return []
    def find_tables(self):
        return []
    def close(self):
        pass


class PDF:
    doc = types.SimpleNamespace(is_extractable=True)
    pages = [Page(), Page(True)]
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass


sys.modules['pdfplumber'] = types.SimpleNamespace(open=lambda data: PDF())
result = runner.profile(b'owned parser fault injection')
assert result['outcome'] == 'partial' and result['reason'] == 'parse_failed'
assert result['pages'] == 2 and result['inspectedPages'] == 1
assert result['chars'] == 0 and result['textLayer'] == 'unknown'
print('PASS structural field exception: 3 assertions; synthetic parser fault, not natural PDF correctness')
