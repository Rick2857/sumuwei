#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Verify the doc-runner.py contract and probe its error path.

The nine document fixtures all convert successfully, so they never exercise
``{"ok": false, ...}``.  This script pins down the contract that the Node-side
consumer depends on:

1. **stdout purity** -- exactly one JSON object, nothing else, on every path.
2. **NUL / non-ASCII safety** -- NUL bytes and CJK survive a round trip.
3. **the error path** -- at least one input must produce ``ok: false`` with a
   real exception class, so the consumer's failure branch is testable.
4. **no path/URL surface** -- positional arguments and a missing ``--ext`` are
   rejected; there is no way to hand the runner a path.

Writes ``runs/runner-contract.json`` next to the other run evidence.

Usage
-----
    python scripts/utility-skills/verify-runner-contract.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
import zipfile
import io
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_FIXTURES = "artifacts/post-lv2/local/utility-skills-preparation/fixtures"
DEFAULT_OUT = "artifacts/post-lv2/local/utility-skills-preparation/runs/runner-contract.json"
RUNNER = "scripts/utility-skills/doc-runner.py"


def resolve(p: str) -> Path:
    path = Path(p)
    return path if path.is_absolute() else (REPO_ROOT / path)


def run(python_exe: Path, runner: Path, data: bytes, args):
    started = time.perf_counter()
    proc = subprocess.run(
        [str(python_exe), str(runner)] + list(args),
        input=data,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(REPO_ROOT),
    )
    return proc, int(round((time.perf_counter() - started) * 1000))


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def make_zip_bytes() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("ooo/readme.txt", "a zip that is not an OOXML package\n")
    return buf.getvalue()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", default=DEFAULT_FIXTURES)
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--python", default=None)
    args = parser.parse_args(argv)

    fixtures_dir = resolve(args.fixtures)
    out_path = resolve(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    runner = REPO_ROOT / RUNNER
    python_exe = Path(args.python) if args.python else Path(sys.executable)

    checks = []

    def record(name, passed, detail):
        checks.append({"check": name, "passed": bool(passed), "detail": detail})
        print("  [%s] %s -- %s" % ("PASS" if passed else "FAIL", name, detail))

    # --- 1. stdout purity on a good fixture ------------------------------
    doc_zh = (fixtures_dir / "doc-zh.pdf").read_bytes()
    proc, ms = run(python_exe, runner, doc_zh, ["--ext", ".pdf"])
    out_text = proc.stdout.decode("utf-8", "replace")
    lines = [ln for ln in out_text.splitlines() if ln.strip()]
    parsed = None
    try:
        parsed = json.loads(out_text)
    except Exception as exc:
        parsed = None
        record("stdout is a single JSON object",
               False, "json.loads failed: %s" % exc)
    if parsed is not None:
        record(
            "stdout is a single JSON object",
            len(lines) == 1 and parsed.get("ok") is True,
            "lines=%d ok=%s keys=%s stderrBytes=%d"
            % (len(lines), parsed.get("ok"), sorted(parsed.keys()),
               len(proc.stderr)),
        )

    # --- 2. NUL + non-ASCII safety ---------------------------------------
    payload = "空值测试\u0000NUL 之后还有中文 4096\n".encode("utf-8")
    proc, ms = run(python_exe, runner, payload, ["--ext", ".txt"])
    out_text = proc.stdout.decode("utf-8", "replace")
    ok_nul = False
    detail = "raw=%r" % out_text[:120]
    try:
        parsed = json.loads(out_text)
        if parsed.get("ok"):
            back = parsed["markdown"]
            ok_nul = ("\u0000" in back and "中文 4096" in back)
            detail = ("markdownChars=%d hasNUL=%s hasCJK=%s"
                      % (len(back), "\u0000" in back, "中文 4096" in back))
    except Exception as exc:
        detail = "json.loads failed: %s; raw=%r" % (exc, out_text[:120])
    record("NUL byte and CJK survive the round trip", ok_nul, detail)

    # --- 3. the error path ------------------------------------------------
    candidates = [
        ("png-bytes-as-pdf", b"\x89PNG\r\n\x1a\n" + b"\x00" * 512, ".pdf"),
        ("zip-not-ooxml-as-docx", make_zip_bytes(), ".docx"),
        ("exe-header-as-pdf", b"MZ\x90\x00\x03\x00\x00\x00" + b"\x00" * 504, ".pdf"),
        ("sqlite-header-as-xlsx", b"SQLite format 3\x00" + b"\x00" * 496, ".xlsx"),
        ("gzip-bytes-as-pptx", b"\x1f\x8b\x08\x00" + b"\x00" * 508, ".pptx"),
    ]
    error_path = None
    attempts = []
    for label, data, ext in candidates:
        proc, ms = run(python_exe, runner, data, ["--ext", ext])
        out_text = proc.stdout.decode("utf-8", "replace")
        try:
            parsed = json.loads(out_text)
        except Exception as exc:
            attempts.append({"label": label, "ext": ext,
                             "parseError": str(exc)})
            continue
        attempts.append({
            "label": label,
            "ext": ext,
            "bytes": len(data),
            "sha256": sha256(data),
            "exitCode": proc.returncode,
            "ms": ms,
            "ok": parsed.get("ok"),
            "errorType": parsed.get("errorType"),
            "errorPreview": (parsed.get("error") or "")[:200],
            "markdownChars": len(parsed.get("markdown") or ""),
        })
        if parsed.get("ok") is False and error_path is None:
            error_path = attempts[-1]

    record(
        "at least one input reaches the ok:false error path",
        error_path is not None,
        ("errorType=%s ext=%s exitCode=%s error=%r"
         % (error_path["errorType"], error_path["ext"], error_path["exitCode"],
            error_path["errorPreview"][:120])) if error_path
        else "NO candidate produced ok:false; all degraded to text",
    )

    # --- 4. no path / URL surface ----------------------------------------
    proc, ms = run(python_exe, runner, doc_zh,
                   [str(fixtures_dir / "doc-zh.pdf")])
    positional_rejected = proc.returncode != 0 and b"{" not in proc.stdout
    record(
        "a positional path argument is rejected",
        positional_rejected,
        "exitCode=%s stdoutBytes=%d stderrPreview=%r"
        % (proc.returncode, len(proc.stdout),
           proc.stderr.decode("utf-8", "replace").strip()[-160:]),
    )

    proc, ms = run(python_exe, runner, doc_zh, [])
    missing_ext_rejected = proc.returncode != 0 and b"{" not in proc.stdout
    record(
        "--ext is required",
        missing_ext_rejected,
        "exitCode=%s stdoutBytes=%d" % (proc.returncode, len(proc.stdout)),
    )

    proc, ms = run(python_exe, runner, doc_zh, ["--ext", ".exe"])
    out_text = proc.stdout.decode("utf-8", "replace")
    unsupported_ok = False
    detail = "raw=%r" % out_text[:160]
    try:
        parsed = json.loads(out_text)
        unsupported_ok = (parsed.get("ok") is False
                          and parsed.get("errorType") == "UnsupportedExtension")
        detail = ("ok=%s errorType=%s exitCode=%s"
                  % (parsed.get("ok"), parsed.get("errorType"), proc.returncode))
    except Exception as exc:
        detail = "json.loads failed: %s" % exc
    record("an unsupported --ext is refused as JSON, not a crash",
           unsupported_ok, detail)

    proc, ms = run(python_exe, runner, b"", ["--ext", ".txt"])
    empty_ok = False
    try:
        parsed = json.loads(proc.stdout.decode("utf-8", "replace"))
        empty_ok = parsed.get("ok") is True and parsed.get("markdown") == ""
    except Exception:
        pass
    record("empty stdin is handled (ok:true, empty markdown)", empty_ok,
           "exitCode=%s" % proc.returncode)

    result = {
        "generatedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "runner": RUNNER,
        "runnerSha256": hashlib.sha256(runner.read_bytes()).hexdigest(),
        "python": str(python_exe),
        "checks": checks,
        "allChecksPassed": all(c["passed"] for c in checks),
        "errorPathCandidate": error_path,
        "errorPathAttempts": attempts,
    }
    with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print("wrote %s (allChecksPassed=%s)" % (out_path, result["allChecksPassed"]))
    return 0 if result["allChecksPassed"] else 1


if __name__ == "__main__":
    sys.exit(main())
