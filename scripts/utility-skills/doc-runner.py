#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Single-shot document conversion runner for the utility-skills probes.

Contract
--------
* Input is **raw document bytes on stdin** (binary).  There is deliberately no
  way to hand this program a path or a URL.
* ``--ext`` is required and restricted to ``.pdf`` / ``.docx`` / ``.pptx`` /
  ``.xlsx`` (``.txt`` is tolerated as a plain-text passthrough case).
* Exactly one JSON object is written to **stdout** and nothing else::

      {"ok": true,  "markdown": "..."}
      {"ok": false, "errorType": "PdfReadError", "error": "..."}

  Library chatter, warnings and logging all go to **stderr**, because stdout
  is temporarily swapped to stderr for the duration of the conversion.
* Only the local file formats above are handled through ``convert_stream`` on
  an in-memory buffer, so no network access is ever attempted.

Usage
-----
    type doc.pdf | python doc-runner.py --ext .pdf
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import sys

ALLOWED_EXTS = (".pdf", ".docx", ".pptx", ".xlsx", ".txt")


def _normalize_ext(raw: str) -> str:
    ext = (raw or "").strip().lower()
    if ext and not ext.startswith("."):
        ext = "." + ext
    return ext


def _safe_text(value) -> str:
    """Make a string JSON-safe: drop lone surrogates, keep NULs escaped by json."""
    if value is None:
        return ""
    if not isinstance(value, str):
        value = str(value)
    return value.encode("utf-8", "replace").decode("utf-8", "replace")


def _reconfigure_utf8(stream) -> None:
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _route_logging_to_stderr() -> None:
    """Every logging handler must point at stderr; stdout carries only JSON."""
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    root.addHandler(handler)
    root.setLevel(logging.WARNING)


def _read_stdin_bytes() -> bytes:
    stream = getattr(sys.stdin, "buffer", None)
    if stream is not None:
        return stream.read()
    # Defensive: a replaced stdin without a binary buffer.
    return sys.stdin.read().encode("utf-8", "replace")


def _convert(data: bytes, ext: str) -> str:
    from markitdown import MarkItDown

    converter = MarkItDown(enable_plugins=False)
    result = converter.convert_stream(io.BytesIO(data), file_extension=ext)
    return _safe_text(getattr(result, "text_content", None))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Convert raw document bytes on stdin to Markdown as JSON."
    )
    parser.add_argument(
        "--ext",
        required=True,
        help="file extension of the stdin bytes, one of: %s" % ", ".join(ALLOWED_EXTS),
    )
    args = parser.parse_args(argv)

    _reconfigure_utf8(sys.stdout)
    _reconfigure_utf8(sys.stderr)
    _route_logging_to_stderr()

    ext = _normalize_ext(args.ext)
    real_stdout = sys.stdout

    def emit(payload: dict, code: int) -> int:
        real_stdout.write(json.dumps(payload, ensure_ascii=False))
        real_stdout.write("\n")
        real_stdout.flush()
        return code

    data = _read_stdin_bytes()

    if ext not in ALLOWED_EXTS:
        return emit(
            {
                "ok": False,
                "errorType": "UnsupportedExtension",
                "error": "unsupported extension %r; allowed: %s"
                % (args.ext, ", ".join(ALLOWED_EXTS)),
            },
            1,
        )

    # Everything below may print; keep stdout clean by parking it on stderr.
    saved_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        markdown = _convert(data, ext)
    except BaseException as exc:  # noqa: BLE001 - we must report every failure
        sys.stdout = saved_stdout
        return emit(
            {
                "ok": False,
                "errorType": type(exc).__name__,
                "error": _safe_text(exc),
            },
            1,
        )
    finally:
        sys.stdout = saved_stdout

    return emit({"ok": True, "markdown": markdown}, 0)


if __name__ == "__main__":
    sys.exit(main())
