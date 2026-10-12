"""Single-shot client of the fixed arxiv-mcp-server; no generic tool input."""
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

TOOLS = {"search_papers", "get_abstract", "download_paper", "read_paper", "read_paper_section", "export_citations"}


async def run(payload):
    cache = Path(sys.argv[1]).resolve()
    cache.mkdir(parents=True, exist_ok=True)
    params = StdioServerParameters(
        command=sys.executable,
        args=[str(Path(__file__).with_name("arxiv-server.py")), "--storage-path", str(cache)],
        cwd=str(cache),
        env={"PYTHONUTF8": "1", "ARXIV_MAX_RETRIES": "0", "ARXIV_REQUEST_TIMEOUT": "15", "ARXIV_MAX_TOTAL_TIME": "75", "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1"},
    )
    called = []
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            await session.initialize()
            available = {tool.name for tool in (await session.list_tools()).tools}
            if not TOOLS.issubset(available):
                raise ValueError("arxiv_tools_missing")

            async def call(name, args):
                if name not in TOOLS:
                    raise ValueError("arxiv_tool_not_allowed")
                called.append(name)
                result = await session.call_tool(name, args)
                if result.isError:
                    raise RuntimeError("arxiv_upstream_failed")
                text = "\n".join(item.text for item in result.content if item.type == "text")
                if not text.strip():
                    raise RuntimeError("arxiv_empty_response")
                try:
                    structured = json.loads(text)
                except ValueError:
                    structured = None
                if isinstance(structured, dict) and (structured.get("status") in {"error", "rate_limited", "not_found"} or structured.get("success") is False):
                    if "timeout" in str(structured.get("message", "")).lower() or "timed out" in str(structured.get("message", "")).lower():
                        raise TimeoutError("arxiv_timeout")
                    raise RuntimeError("arxiv_upstream_failed")
                return text

            op = payload["operation"]
            args = payload["args"]
            paper = args.get("paperId")
            if op == "probe":
                text = json.dumps({"version": "0.8.1", "allowed_tools": sorted(TOOLS)})
            elif op == "search":
                text = await call("search_papers", {"query": args["query"], "max_results": args.get("limit", 3), "abstract_mode": "snippet"})
            elif op == "abstract":
                text = await call("get_abstract", {"paper_id": paper})
            elif op == "cite":
                text = await call("export_citations", {"paper_ids": [paper]})
            elif op == "read":
                await call("download_paper", {"paper_id": paper, "max_chars": 1})
                if args.get("section"):
                    text = await call("read_paper_section", {"paper_id": paper, "section_id": args["section"], "max_chars": 12000})
                else:
                    text = await call("read_paper", {"paper_id": paper, "max_chars": 12000})
            else:
                raise ValueError("arxiv_operation_not_allowed")
            return {"ok": True, "text": text[:16000], "totalChars": len(text.encode("utf-16-le")) // 2, "truncated": len(text) > 16000, "calls": called}


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        request = json.loads(sys.stdin.buffer.read(4097))
        if request.get("operation") == "read":
            answer = asyncio.run(asyncio.wait_for(run(request), timeout=85))
        else:
            with tempfile.TemporaryDirectory(prefix="lg-arxiv-metadata-") as transient:
                sys.argv[1] = transient
                answer = asyncio.run(asyncio.wait_for(run(request), timeout=43))
    except (TimeoutError, asyncio.TimeoutError):
        answer = {"ok": False, "failure": "timeout"}
    except Exception:
        answer = {"ok": False, "failure": "execution_failed"}
    print(json.dumps(answer, ensure_ascii=False))
