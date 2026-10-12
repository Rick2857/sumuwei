"""Reproduce the pinned, isolated arXiv runtime. Run with Python 3.10+."""
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[2]
uv = shutil.which("uv") or str(Path.home() / "AppData/Local/hermes/bin/uv.exe")
venv = root / "artifacts/post-lv2/local/low-cost-skills/arxiv-venv"
python = venv / "Scripts/python.exe"
if not python.exists():
    subprocess.run([uv, "venv", "--python", "3.11", str(venv)], check=True, cwd=root)
subprocess.run([uv, "pip", "sync", "--python", str(python), str(root / "scripts/learning-skills/arxiv-requirements.lock")], check=True, cwd=root)
assets = json.loads((root / "scripts/learning-skills/arxiv-assets.json").read_text(encoding="utf-8"))
for relative, expected in assets.items():
    actual = hashlib.sha256((root / relative).read_bytes()).hexdigest()
    if actual != expected:
        raise RuntimeError("Installed source fingerprint mismatch: " + relative)
print("arxiv-mcp-server 0.8.1 installed; fixed source fingerprints verified.")
