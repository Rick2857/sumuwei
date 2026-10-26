#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Prepare the natural PDF corpus for the document-recovery domain.

What this does
--------------
1. Downloads the **natural** public PDFs listed in the corpus plan
   (arXiv papers). The plan is frozen in ``document-corpus.json``; this
   script never invents a document.
2. Fetches the **independent** content standard from the arXiv metadata API
   (the title as the publisher records it). The standard therefore does not
   come from the extraction pipeline under test.
3. Builds the **derived** failure-type variants and labels them as derived:
   * ``scan-alike``   - page 1 of a natural paper rendered to a JPEG and
     embedded in a PDF with **no text layer** (what a scan looks like to a
     text extractor). Derived, not a real scan.
   * ``damaged-xref`` - a natural paper whose ``startxref`` offset is
     corrupted. Derived structural damage.
4. Writes ``corpus-readback.json``: the sha256 / byte size actually fetched,
   so the observation gate can detect a changed download.

Usage
-----
    python document-corpus-prepare.py --plan <plan.json> --out <dir>
    python document-corpus-prepare.py --discover            # arXiv id search
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import struct
import sys
import urllib.parse
import urllib.request

USER_AGENT = "project-lg-document-corpus/1.0 (local research corpus preparation)"
MAX_BYTES = 10 * 1024 * 1024


def _fetch(url: str, timeout: int = 90, attempts: int = 4) -> bytes:
    import time

    last: Exception | None = None
    for attempt in range(attempts):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read(MAX_BYTES + 1)
        except Exception as error:  # noqa: BLE001 - transient network failures are retried
            last = error
            time.sleep(3 * (attempt + 1))
    assert last is not None
    raise last


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# arXiv metadata: the independent content standard
# ---------------------------------------------------------------------------

def arxiv_metadata(ids: list[str]) -> dict:
    """arXiv **publisher metadata**: title + abstract. Not the PDF text pipeline."""
    import re
    import time

    url = "http://export.arxiv.org/api/query?" + urllib.parse.urlencode(
        {"id_list": ",".join(ids)}
    )
    last = ""
    for attempt in range(4):
        if attempt:
            time.sleep(4 * attempt)
        try:
            raw = _fetch(url).decode("utf-8", "replace")
        except Exception as error:  # noqa: BLE001
            last = str(error)
            continue
        entries = re.findall(r"<entry>(.*?)</entry>", raw, re.S)
        if not entries:
            last = "no entries in response: " + raw[:200]
            continue
        out = {}
        for entry in entries:
            entry_id = re.search(r"<id>http://arxiv\.org/abs/([^<]+)</id>", entry)
            title = re.search(r"<title>(.*?)</title>", entry, re.S)
            summary = re.search(r"<summary>(.*?)</summary>", entry, re.S)
            if entry_id and title:
                clean_id = re.sub(r"v\d+$", "", entry_id.group(1))
                parts = [" ".join(title.group(1).split())]
                if summary:
                    parts.append(" ".join(summary.group(1).split()))
                out[clean_id] = "\n".join(parts)
        return out
    print("arxiv metadata unavailable:", last, file=sys.stderr)
    return {}


def normalize(text: str) -> str:
    """Whitespace-, case- and punctuation-insensitive form used for matching.

    NFKC first: some PDF text layers map CJK glyphs to the **Kangxi radical**
    code points (电⼦ / U+2F66 instead of 电子). Without NFKC the same
    document would look like two different strings.
    """
    import unicodedata

    keep = []
    for char in unicodedata.normalize("NFKC", text).lower():
        if char.isalnum() or "一" <= char <= "鿿":
            keep.append(char)
    return "".join(keep)


def independent_text(document: dict, titles: dict) -> tuple:
    """The content standard's source, which is **not** the PDF text pipeline."""
    standard = document.get("standard") or {}
    kind = standard.get("kind")
    if kind == "none":
        return "", []
    if kind == "arxivMetadata":
        title = titles.get(document.get("arxivId", ""), "")
        return title, list(standard.get("phrases") or [])
    if kind == "urlText":
        raw = _fetch(standard["sourceUrl"]).decode("utf-8", "replace")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            return raw, list(standard.get("phrases") or [])
        if isinstance(payload, dict) and isinstance(payload.get("extract"), str):
            return payload["extract"], list(standard.get("phrases") or [])
        return raw, list(standard.get("phrases") or [])
    raise ValueError("unknown standard kind " + str(kind))


def discover_chinese(max_results: int = 6) -> list:
    """Find arXiv entries whose **title is written in Chinese**."""
    import re

    url = "http://export.arxiv.org/api/query?" + urllib.parse.urlencode(
        {
            "search_query": "ti:\"中文\"",
            "max_results": max_results * 4,
        }
    )
    raw = _fetch(url).decode("utf-8", "replace")
    found = []
    for entry in re.findall(r"<entry>(.*?)</entry>", raw, re.S):
        entry_id = re.search(r"<id>http://arxiv\.org/abs/([^<]+)</id>", entry)
        title = re.search(r"<title>(.*?)</title>", entry, re.S)
        if not (entry_id and title):
            continue
        clean = " ".join(title.group(1).split())
        cjk = sum(1 for c in clean if "一" <= c <= "鿿")
        if cjk >= 4:
            found.append((entry_id.group(1), clean))
        if len(found) >= max_results:
            break
    return found


# ---------------------------------------------------------------------------
# Minimal PDF writer (used only for the derived scan-alike variant)
# ---------------------------------------------------------------------------

def build_image_pdf(jpeg: bytes, width: int, height: int) -> bytes:
    """One page, one JPEG XObject, **no text operators at all**."""
    content = b"q 612 0 0 792 0 0 cm /Im0 Do Q\n"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /XObject /Subtype /Image /Width " + str(width).encode()
        + b" /Height " + str(height).encode()
        + b" /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length "
        + str(len(jpeg)).encode() + b" >>\nstream\n" + jpeg + b"\nendstream",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"endstream",
    ]
    body = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
    offsets = []
    for index, obj in enumerate(objects):
        offsets.append(len(body))
        body += str(index + 1).encode() + b" 0 obj\n" + obj + b"\nendobj\n"
    xref = len(body)
    body += b"xref\n0 " + str(len(objects) + 1).encode() + b"\n0000000000 65535 f \n"
    for offset in offsets:
        body += ("%010d 00000 n \n" % offset).encode()
    body += (
        b"trailer\n<< /Size " + str(len(objects) + 1).encode() + b" /Root 1 0 R >>\n"
        b"startxref\n" + str(xref).encode() + b"\n%%EOF\n"
    )
    return body


def render_first_page_jpeg(pdf_bytes: bytes, scale: float = 1.5) -> tuple:
    import pypdfium2 as pdfium  # noqa: PLC0415 - optional runtime dependency

    document = pdfium.PdfDocument(io.BytesIO(pdf_bytes))
    try:
        page = document[0]
        bitmap = page.render(scale=scale)
        image = bitmap.to_pil()
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=72)
        return buffer.getvalue(), image.width, image.height
    finally:
        document.close()


def corrupt_startxref(pdf_bytes: bytes) -> bytes:
    """Point ``startxref`` at a wrong offset (keeps every object intact)."""
    marker = pdf_bytes.rfind(b"startxref")
    if marker < 0:
        raise ValueError("startxref not found")
    tail = pdf_bytes[marker:]
    end = tail.find(b"%%EOF")
    body = tail[:end]
    lines = body.split(b"\n")
    if len(lines) < 3:
        raise ValueError("unexpected startxref shape")
    try:
        offset = int(lines[1].strip())
    except ValueError as error:
        raise ValueError("startxref offset is not an integer") from error
    broken = lines[0] + b"\n" + str(offset + 7).encode() + b"\n" + b"\n".join(lines[2:])
    return pdf_bytes[:marker] + broken + tail[end:]


# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan")
    parser.add_argument("--out")
    parser.add_argument("--discover", action="store_true")
    args = parser.parse_args()

    if args.discover:
        for entry_id, title in discover_chinese():
            print(entry_id, "|", title)
        return 0

    if not args.plan or not args.out:
        parser.error("--plan and --out are required")

    with open(args.plan, "r", encoding="utf-8") as handle:
        plan = json.load(handle)
    os.makedirs(args.out, exist_ok=True)

    readback = {
        "version": "document-corpus-readback@1",
        "planSha256": _sha256(open(args.plan, "rb").read()),
        "documents": [],
    }

    natural = [d for d in plan["documents"] if d["kind"] == "natural"]
    titles = {}
    arxiv_ids = [d["arxivId"] for d in natural if d.get("arxivId")]
    if arxiv_ids:
        try:
            titles = arxiv_metadata(arxiv_ids)
        except Exception as error:  # noqa: BLE001
            print("arxiv metadata failed:", error, file=sys.stderr)

    bytes_by_id = {}
    for document in natural:
        url = document["url"]
        target = os.path.join(args.out, document["file"])
        try:
            data = _fetch(url)
        except Exception as error:  # noqa: BLE001
            readback["documents"].append(
                {"id": document["id"], "status": "FETCH_FAILED", "error": str(error)}
            )
            print(document["id"], "FETCH_FAILED", error, file=sys.stderr)
            continue
        if not data.startswith(b"%PDF-"):
            readback["documents"].append(
                {"id": document["id"], "status": "NOT_PDF", "bytes": len(data)}
            )
            continue
        # The content standard is verified against an **independent** source.
        try:
            source, phrases = independent_text(document, titles)
        except Exception as error:  # noqa: BLE001
            readback["documents"].append(
                {"id": document["id"], "status": "STANDARD_UNAVAILABLE", "error": str(error)}
            )
            print(document["id"], "STANDARD_UNAVAILABLE", error, file=sys.stderr)
            continue
        haystack = normalize(source)
        missing = [p for p in phrases if normalize(p) not in haystack]
        if missing:
            readback["documents"].append(
                {
                    "id": document["id"],
                    "status": "STANDARD_NOT_IN_SOURCE",
                    "missing": missing,
                }
            )
            print(
                document["id"],
                "STANDARD_NOT_IN_SOURCE",
                missing,
                file=sys.stderr,
            )
            continue
        with open(target, "wb") as handle:
            handle.write(data)
        bytes_by_id[document["id"]] = data
        record = {
            "id": document["id"],
            "status": "OK",
            "file": document["file"],
            "url": url,
            "bytes": len(data),
            "sha256": _sha256(data),
            "kind": "natural",
            "standardVerified": phrases,
            "standardSourceChars": len(source),
        }
        if document.get("arxivId") and document["arxivId"] in titles:
            record["independentTitle"] = titles[document["arxivId"]]
        readback["documents"].append(record)
        print(document["id"], "ok", len(data), record["sha256"][:16])

    # ---- derived variants -------------------------------------------------
    for document in plan["documents"]:
        if document["kind"] != "derived":
            continue
        base_id = document["derivedFrom"]
        if base_id not in bytes_by_id:
            readback["documents"].append(
                {"id": document["id"], "status": "BASE_MISSING", "base": base_id}
            )
            continue
        base = bytes_by_id[base_id]
        target = os.path.join(args.out, document["file"])
        try:
            if document["variant"] == "scan-alike":
                jpeg, width, height = render_first_page_jpeg(base)
                data = build_image_pdf(jpeg, width, height)
            elif document["variant"] == "damaged-xref":
                data = corrupt_startxref(base)
            else:
                raise ValueError("unknown variant " + document["variant"])
        except Exception as error:  # noqa: BLE001
            readback["documents"].append(
                {"id": document["id"], "status": "BUILD_FAILED", "error": str(error)}
            )
            print(document["id"], "BUILD_FAILED", error, file=sys.stderr)
            continue
        with open(target, "wb") as handle:
            handle.write(data)
        base_plan = next((d for d in plan["documents"] if d["id"] == base_id), None)
        record = {
            "id": document["id"],
            "status": "OK",
            "file": document["file"],
            "bytes": len(data),
            "sha256": _sha256(data),
            "kind": "derived",
            "variant": document["variant"],
            "derivedFrom": base_id,
        }
        if base_plan is not None:
            base_standard = base_plan.get("standard") or {}
            record["standardVerified"] = list(base_standard.get("phrases") or [])
            record["standardKind"] = base_standard.get("kind")
        readback["documents"].append(record)
        print(document["id"], "ok", len(data), _sha256(data)[:16])

    out_path = os.path.join(args.out, "corpus-readback.json")
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(readback, handle, ensure_ascii=False, indent=2)
    print("readback ->", out_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
