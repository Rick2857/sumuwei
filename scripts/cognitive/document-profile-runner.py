#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""PDF bytes -> closed-set observable profile. No text, no content, no network.

Contract
--------
* Input is **raw PDF bytes on stdin** (binary), same shape as ``doc-runner.py``.
* Exactly one JSON object on stdout, nothing else::

      {"ok": true,  "protocol": "pdf-profile@1", "pages": 15, "textLayer": "present",
       "chars": 48213, "images": 2, "tables": 0, "extractionAllowed": true}
      {"ok": false, "protocol": "pdf-profile@1", "reason": "encrypted"}

* The profile is **structural only**: page count, whether a text layer exists,
  how many characters/images/tables the parser can see. **No document text
  leaves this program** - the profile is the only thing it emits.

Why this exists
---------------
The document domain currently only knows ``format=pdf`` + ``reader`` + protocol.
That is too coarse to tell a text-layer PDF from a scanned one, so a rule that
says "this reader extracts text" is falsified by an empty scanned document.
This probe supplies the **observable** distinction. It uses ``pdfplumber``,
which is already installed in the document Python environment (it is a
MarkItDown dependency) - **no new dependency**.

Usage
-----
    type doc.pdf | python document-profile-runner.py
"""

from __future__ import annotations

import io
import json
import sys

PROTOCOL = "pdf-profile@1"
MAX_BYTES = 10 * 1024 * 1024

#: Closed set of failure reasons. Never a free-text message.
REASONS = (
    "read_failed",
    "too_large",
    "not_pdf",
    "runtime_missing",
    "encrypted",
    "parse_failed",
)


def _emit(payload: dict, code: int) -> int:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True))
    sys.stdout.write("\n")
    sys.stdout.flush()
    return code


def _failure(reason: str) -> dict:
    assert reason in REASONS, reason
    return {
        "ok": False,
        "protocol": PROTOCOL,
        "reason": reason,
        "pages": 0,
        "textLayer": "unknown",
        "chars": 0,
        "images": 0,
        "tables": 0,
        "extractionAllowed": None,
    }


def _classify(error: BaseException) -> str:
    name = type(error).__name__
    if name == "PDFPasswordIncorrect":
        return "encrypted"
    message = str(error).lower()
    if "password" in message:
        return "encrypted"
    return "parse_failed"


def main() -> int:
    try:
        data = sys.stdin.buffer.read(MAX_BYTES + 1)
    except Exception:
        return _emit(_failure("read_failed"), 1)
    if len(data) > MAX_BYTES:
        return _emit(_failure("too_large"), 1)
    if not data.startswith(b"%PDF-"):
        return _emit(_failure("not_pdf"), 1)

    try:
        import pdfplumber  # noqa: PLC0415 - optional runtime dependency
    except Exception:
        return _emit(_failure("runtime_missing"), 1)

    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            pages = len(pdf.pages)
            chars = 0
            images = 0
            tables = 0
            for page in pdf.pages:
                try:
                    chars += len(page.chars)
                except Exception:
                    pass
                try:
                    images += len(page.images)
                except Exception:
                    pass
                try:
                    tables += len(page.find_tables())
                except Exception:
                    pass
                page.close()
            allowed = getattr(getattr(pdf, "doc", None), "is_extractable", None)
    except Exception as error:  # noqa: BLE001 - every failure is reported as a closed-set reason
        return _emit(_failure(_classify(error)), 1)

    return _emit(
        {
            "ok": True,
            "protocol": PROTOCOL,
            "pages": pages,
            "textLayer": "present" if chars > 0 else "absent",
            "chars": chars,
            "images": images,
            "tables": tables,
            "extractionAllowed": None if allowed is None else bool(allowed),
        },
        0,
    )


if __name__ == "__main__":
    raise SystemExit(main())
