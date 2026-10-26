"""Run locally in an interactive terminal. Never paste passwords into chat."""
import getpass
import json
import os
from pathlib import Path
import re
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
os.chdir(root)
directory = Path(os.environ.get('PROJECT_LG_XIDIAN_DIR', root / 'data' / 'xidian'))
if not sys.stdin.isatty():
    sys.exit('Use an interactive local terminal; credentials must not arrive through chat or tool arguments.')
if '--verify-code' in sys.argv:
    code = getpass.getpass('School verification code (hidden): ')
    tsx = root / 'node_modules' / 'tsx' / 'dist' / 'cli.mjs'
    sys.exit(subprocess.run(['node', str(tsx), 'scripts/xidian/sync.ts', 'verify-code'], input=code, text=True).returncode)

username = input('Xidian student number: ').strip()
if not re.fullmatch(r'\d{8,16}', username):
    sys.exit('Invalid student number')
password = getpass.getpass('IDS password (hidden): ')
if not password or password != getpass.getpass('Repeat password (hidden): '):
    sys.exit('Passwords do not match')
directory.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(directory, 0o700)
target = directory / 'credentials.json'
if target.exists():
    sys.exit('Credentials already exist. Rename them locally before configuring a replacement.')
fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as handle:
    json.dump({'username': username, 'password': password}, handle)
print('Credentials saved locally. Run: pnpm exec tsx scripts/xidian/sync.ts')
