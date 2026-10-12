"""Exercise the actual status route with bridge transports; no DB, audio or model calls."""
import ast
import json
from pathlib import Path
from types import SimpleNamespace

from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
import postlv2_vtuber_runtime as runtime


# The route lives inside serve(), which also starts acoustic models and LG.
# Compile that route unchanged so HTTP behavior can be checked without starting them.
source = Path(runtime.__file__)
tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
route = next(node for node in ast.walk(tree)
             if isinstance(node, ast.AsyncFunctionDef) and node.name == "status")
router = APIRouter()
namespace = {**vars(runtime), "router": router,
             "args": SimpleNamespace(mode="production"),
             "server": SimpleNamespace(default_context_cache=SimpleNamespace(
                 tts_engine=SimpleNamespace(speaker="test-speaker"),
                 asr_engine=SimpleNamespace())),
             "conf": {"character_config": {"tts_config": {"tts_model": "test-tts"},
                                            "asr_config": {"asr_model": "test-asr"}}}}
exec(compile(ast.Module(body=[route], type_ignores=[]), str(source), "exec"), namespace)
app = FastAPI()
app.include_router(router)

checks = []
cases = [
    ("spawn: ready child", None, SimpleNamespace(returncode=None), None, False, True, True),
    ("connect: ready socket, no child", {}, None, object(), False, True, True),
    ("connect: closed socket", {}, None, object(), True, True, False),
    ("connect: no socket", {}, None, None, False, True, False),
    ("spawn: exited child", None, SimpleNamespace(returncode=0), None, False, True, False),
    ("connect: not ready", {}, None, object(), False, False, False),
]
with TestClient(app, raise_server_exceptions=False) as client:
    for label, connect, process, writer, closed, ready, expected in cases:
        bridge = runtime.LGBridgeClient(Path.cwd(), "production", connect=connect)
        bridge.process = process
        bridge.socket_writer = writer
        bridge._transport_closed = closed
        bridge.ready = ready
        bridge.report_reading["accepted"] = 2
        namespace["BRIDGE"] = bridge
        response = client.get("/lg/status")
        assert response.status_code == 200, f"{label}: HTTP {response.status_code}"
        body = response.json()
        assert body["lg_process_alive"] is expected, (label, body["lg_process_alive"])
        assert body["mode"] == "production" and body["speaker"] == "test-speaker"
        assert body["playback_reports"]["accepted"] == 2 and body["last_turn"] is None
        assert "cancel_requests" in body and "partial" in body and "synthesis_verdicts" in body
        checks.append(label)

print(json.dumps({"passed": len(checks), "checks": checks,
                  "productionDatabaseOpened": False}, ensure_ascii=False))
