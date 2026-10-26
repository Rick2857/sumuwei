#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""One-off discovery: arXiv entries whose metadata **summary** contains CJK.

The summary is publisher metadata, independent of any PDF text extraction, so
a phrase taken from it is an *independent* content standard for a Chinese
document.
"""
import json
import re
import sys
import urllib.parse
import urllib.request

UA = "project-lg-document-corpus/1.0"


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=90) as response:
        return response.read().decode("utf-8", "replace")


def cjk_count(text):
    return sum(1 for c in text if "一" <= c <= "鿿")


def main():
    query = sys.argv[1] if len(sys.argv) > 1 else "cat:cs.CL"
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 100
    url = "http://export.arxiv.org/api/query?" + urllib.parse.urlencode(
        {"search_query": query, "max_results": count, "sortBy": "submittedDate", "sortOrder": "descending"}
    )
    raw = fetch(url)
    hits = []
    for entry in re.findall(r"<entry>(.*?)</entry>", raw, re.S):
        entry_id = re.search(r"<id>http://arxiv\.org/abs/([^<]+)</id>", entry)
        title = re.search(r"<title>(.*?)</title>", entry, re.S)
        summary = re.search(r"<summary>(.*?)</summary>", entry, re.S)
        if not (entry_id and summary):
            continue
        text = " ".join(summary.group(1).split())
        if cjk_count(text) >= 30:
            hits.append(
                {
                    "id": entry_id.group(1),
                    "title": " ".join(title.group(1).split()) if title else "",
                    "summary": text[:400],
                }
            )
    print(json.dumps(hits, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
