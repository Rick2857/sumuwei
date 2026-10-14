"""Use the canonical voice shell in connection mode; never spawn a production core."""
import argparse
import asyncio
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--connection", type=Path, required=True)
args = parser.parse_args()
connection = json.loads(args.connection.read_text(encoding="utf-8"))
if connection["host"] != "127.0.0.1" or not connection["token"]:
    raise ValueError("An authenticated loopback core connection is required")
runtime_root = Path(connection["runtimeRoot"]).resolve()
sys.path.insert(0, str(runtime_root / "scripts"))
spec = importlib.util.spec_from_file_location("postlv2_vtuber_runtime", runtime_root / "scripts/postlv2_vtuber_runtime.py")
runtime = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runtime
spec.loader.exec_module(runtime)
import uvicorn

BaseServer = uvicorn.Server

class StoppableServer(BaseServer):
    async def serve(self, *args, **kwargs):
        async def stop_on_stdin_close():
            await asyncio.to_thread(sys.stdin.readline)
            self.should_exit = True
        task = asyncio.create_task(stop_on_stdin_close())
        try:
            return await super().serve(*args, **kwargs)
        finally:
            task.cancel()

uvicorn.Server = StoppableServer
try:
    asyncio.run(runtime.serve(SimpleNamespace(
        repo_root=runtime_root, deps_root=Path(connection["depsRoot"]), mode="sandbox-copy",
        connect_host=connection["host"], connect_port=connection["port"], connect_token=connection["token"],
        bind_host="127.0.0.1")))
except KeyboardInterrupt:
    pass
