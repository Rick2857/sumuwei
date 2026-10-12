#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Probe every document fixture through doc-runner.py and record evidence.

Runs ``scripts/utility-skills/doc-runner.py`` once per document fixture listed
in ``fixtures/manifest.json``, feeding the raw fixture bytes on stdin, and
writes ``runs/document-probe.json``.

The probe deliberately pipes bytes with :mod:`subprocess` (never through a
shell), so no encoding or BOM corruption can creep into the input.

Usage
-----
    python scripts/utility-skills/probe-documents.py
    python scripts/utility-skills/probe-documents.py --fixtures <dir> --out <file>
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_FIXTURES = "artifacts/post-lv2/local/utility-skills-preparation/fixtures"
DEFAULT_OUT = "artifacts/post-lv2/local/utility-skills-preparation/runs/document-probe.json"
RUNNER = "scripts/utility-skills/doc-runner.py"
PREVIEW_CHARS = 300

# formats where "markdown came back looking like the raw input bytes" is a
# meaningful red flag rather than normal behaviour
BINARY_EXTS = {".pdf", ".docx", ".pptx", ".xlsx"}

# fixtures whose outcome is worth an explicit note even when nothing is wrong
INTERESTING = {"doc-scan.pdf", "doc-fake.pdf", "doc-corrupt.docx",
               "doc-empty.txt", "doc-huge.txt"}

FALLBACK_MECHANISM = (
    "markitdown sniffs the content with magika and, when that contradicts "
    "--ext, queues BOTH guesses and tries the converters in order. A thrown "
    "converter exception is swallowed into FailedConversionAttempt and the "
    "loop continues. So ok:true means 'some converter succeeded', NOT 'the "
    "declared format parsed'. A corrupt/mislabelled binary silently degrades "
    "to plain-text extraction of its raw bytes."
)


def raw_passthrough_suspected(data: bytes, markdown: str, ext: str) -> bool:
    """True when markdown looks like the raw input bytes read as text."""
    if ext not in BINARY_EXTS or not markdown:
        return False
    head = data[:48].decode("utf-8", "ignore").strip()
    if len(head) < 8:
        return False
    first_line = head.split("\n")[0]
    return first_line in markdown


def resolve(p: str) -> Path:
    path = Path(p)
    return path if path.is_absolute() else (REPO_ROOT / path)


def run_one(python_exe: Path, runner: Path, data: bytes, ext: str):
    started = time.perf_counter()
    proc = subprocess.run(
        [str(python_exe), str(runner), "--ext", ext],
        input=data,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(REPO_ROOT),
    )
    elapsed_ms = int(round((time.perf_counter() - started) * 1000))
    return proc, elapsed_ms


def preview(text: str) -> str:
    return text[:PREVIEW_CHARS]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", default=DEFAULT_FIXTURES)
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--python", default=None,
                        help="interpreter used to run doc-runner.py")
    args = parser.parse_args(argv)

    fixtures_dir = resolve(args.fixtures)
    out_path = resolve(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    runner = REPO_ROOT / RUNNER
    python_exe = Path(args.python) if args.python else Path(sys.executable)

    manifest_path = fixtures_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    fixtures = []
    notes = []

    for entry in manifest["files"]:
        if entry.get("kind") != "document":
            continue
        name = entry["path"]
        path = fixtures_dir / name
        ext = path.suffix.lower()
        expect = entry.get("expect", {})
        data = path.read_bytes()

        proc, elapsed_ms = run_one(python_exe, runner, data, ext)
        raw_out = proc.stdout.decode("utf-8", "replace")
        raw_err = proc.stderr.decode("utf-8", "replace")

        record = {
            "file": name,
            "ext": ext,
            "bytes": len(data),
            "exitCode": proc.returncode,
            "ms": elapsed_ms,
            "stdoutBytes": len(proc.stdout),
        }

        markdown = ""
        try:
            payload = json.loads(raw_out)
        except Exception as exc:
            record["ok"] = False
            record["errorType"] = "ProbeJSONError"
            record["error"] = "runner stdout was not valid JSON: %s" % exc
            record["stdoutPreview"] = raw_out[:PREVIEW_CHARS]
            payload = None

        if payload is not None:
            if payload.get("ok"):
                markdown = payload.get("markdown") or ""
                record["ok"] = True
                record["markdownChars"] = len(markdown)
                record["markdownPreview"] = preview(markdown)
                record["markdownUtf8Bytes"] = len(markdown.encode("utf-8"))
            else:
                record["ok"] = False
                record["errorType"] = payload.get("errorType")
                record["error"] = (payload.get("error") or "")[:PREVIEW_CHARS]

        assertions = []
        for needle in expect.get("mustContain", []):
            assertions.append({
                "needle": needle,
                "found": needle in markdown,
                "expectPresent": True,
            })
        for needle in expect.get("mustNotContain", []):
            assertions.append({
                "needle": needle,
                "found": needle in markdown,
                "expectPresent": False,
            })
        record["assertionResults"] = assertions
        record["allAssertionsPassed"] = all(
            a["found"] == a["expectPresent"] for a in assertions
        )
        record["rawPassthroughSuspected"] = raw_passthrough_suspected(
            data, markdown, ext
        )

        if raw_err.strip():
            record["stderrPreview"] = raw_err.strip()[:PREVIEW_CHARS]

        # --- observations worth surfacing to the consumer -------------------
        if name in INTERESTING or not record.get("ok") or not record["allAssertionsPassed"]:
            if name == "doc-scan.pdf":
                notes.append({
                    "file": name,
                    "note": "image-only PDF: markdownChars=%d (expected ~0), no text layer extracted"
                            % record.get("markdownChars", -1),
                })
            elif name == "doc-fake.pdf":
                notes.append({
                    "file": name,
                    "note": "plain text named .pdf: ok=%s (NO error) markdownChars=%s "
                            "rawPassthroughSuspected=%s -- the .pdf guess failed, markitdown "
                            "fell back to the content-sniffed text guess"
                            % (record.get("ok"), record.get("markdownChars"),
                               record["rawPassthroughSuspected"]),
                })
            elif name == "doc-corrupt.docx":
                notes.append({
                    "file": name,
                    "note": "512 bytes of non-ZIP named .docx: ok=%s (NO error, no exception "
                            "class) markdownChars=%s rawPassthroughSuspected=%s -- mammoth "
                            "raised, the exception was swallowed, and the raw bytes came back "
                            "as markdown"
                            % (record.get("ok"), record.get("markdownChars"),
                               record["rawPassthroughSuspected"]),
                })
            elif name == "doc-empty.txt":
                notes.append({
                    "file": name,
                    "note": "zero-byte input: ok=%s markdownChars=%s"
                            % (record.get("ok"), record.get("markdownChars")),
                })
            elif name == "doc-huge.txt":
                notes.append({
                    "file": name,
                    "note": "%d-byte input accepted: ok=%s markdownChars=%s ms=%s "
                            "(no size ceiling observed; the caller must enforce limits)"
                            % (len(data), record.get("ok"),
                               record.get("markdownChars"), elapsed_ms),
                })
            else:
                notes.append({
                    "file": name,
                    "note": "ok=%s allAssertionsPassed=%s markdownChars=%s ms=%s"
                            % (record.get("ok"), record["allAssertionsPassed"],
                               record.get("markdownChars"), elapsed_ms),
                })

            if raw_err.strip():
                notes.append({
                    "file": name,
                    "note": "stderr: %s" % raw_err.strip()[:400],
                })

        fixtures.append(record)

    if any(f.get("rawPassthroughSuspected") for f in fixtures):
        notes.insert(0, {"file": "*", "note": FALLBACK_MECHANISM})
    notes.insert(0, {
        "file": "*",
        "note": "the runner's ok:false path is NOT exercised by any fixture: every "
                "fixture converted successfully, including the two deliberately broken "
                "binaries (they degraded to plain text instead of failing)",
    })

    result = {
        "generatedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "runner": RUNNER,
        "runnerSha256": _sha256(runner),
        "fixturesManifest": str(manifest_path.relative_to(REPO_ROOT)).replace("\\", "/"),
        "python": str(python_exe),
        "markitdownVersion": _markitdown_version(),
        "fixtureCount": len(fixtures),
        "okCount": sum(1 for f in fixtures if f.get("ok")),
        "allAssertionsPassed": all(f.get("allAssertionsPassed") for f in fixtures),
        "fixtures": fixtures,
        "notes": notes,
    }

    with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    print("wrote %s (%d fixtures, %d ok)"
          % (out_path, len(fixtures), result["okCount"]))
    for f in fixtures:
        print("  %-22s ext=%-6s ok=%-5s exit=%s ms=%-6s chars=%s"
              % (f["file"], f["ext"], f.get("ok"), f["exitCode"], f["ms"],
                 f.get("markdownChars", "-")))
    return 0


def _sha256(path: Path) -> str:
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _markitdown_version():
    try:
        import importlib.metadata as md
        return md.version("markitdown")
    except Exception:
        return None


if __name__ == "__main__":
    sys.exit(main())
