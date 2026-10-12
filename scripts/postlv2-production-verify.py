"""Bridge lifecycle checks with subprocess stubs; no production DB or acoustic inference."""
import asyncio
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch
import postlv2_vtuber_runtime as runtime

checks = []


class Input:
    def __init__(self, process):
        self.process = process
        self.closed = False

    def write(self, value):
        packet = json.loads(value)
        self.process.packets.append(packet)
        response = {"kind": "TURN_RESULT", "requestId": packet["requestId"],
                    "outcome": "rejected", "code": "bridge_unknown_message_kind"}
        self.process.stdout.feed_data((json.dumps(response) + "\n").encode())

    async def drain(self):
        pass

    def close(self):
        self.closed = True
        if not self.process.hold_close and self.process.returncode is None:
            self.process.finish()


class Process:
    def __init__(self, hold_close=False):
        self.returncode = None
        self.hold_close = hold_close
        self.stdout = asyncio.StreamReader()
        self.stdin = Input(self)
        self.packets = []
        self.finished = asyncio.Event()

    def finish(self, code=0):
        self.returncode = code
        self.stdout.feed_eof()
        self.finished.set()

    async def wait(self):
        await self.finished.wait()
        return self.returncode

    def terminate(self):
        raise AssertionError("Hard kill must not be used")


async def verify():
    for mode, entry in [("sandbox-copy", "postlv2-bridge-sandbox.ts"), ("production", "postlv2-bridge-production.ts")]:
        child = Process()
        calls = []

        async def spawn(*args, **kwargs):
            calls.append((args, kwargs))
            return child

        with patch.object(runtime.asyncio, 'create_subprocess_exec', spawn):
            bridge = runtime.LGBridgeClient(Path.cwd(), mode)
            await bridge.start()
            assert calls[0][0][-1].endswith(entry)
            assert calls[0][1].get('stderr') is None
            assert bridge.ready
            assert child.packets == [{"kind": "LG_STARTUP_PROBE", "requestId": "lg-startup-probe"}]
            assert not bridge.pending
            checks.append(mode + ': correct entry, inherited errors, no chat submitted for readiness')
            child.hold_close = True
            closing = asyncio.create_task(bridge.close())
            await asyncio.sleep(0)
            assert child.stdin.closed and not closing.done() and not bridge.ready
            child.finish()
            await closing
            checks.append(mode + ': EOF shutdown waits for child and never terminates it')

    child = Process()

    async def exited(*args, **kwargs):
        child.finish(2)
        return child

    with patch.object(runtime.asyncio, 'create_subprocess_exec', exited):
        bridge = runtime.LGBridgeClient(Path.cwd(), 'production')
        try:
            await bridge.start()
            raise AssertionError('Failed startup must reject')
        except RuntimeError:
            assert not bridge.ready and not bridge.pending and child.stdin.closed
            checks.append('startup failure is visible, cleans stdin, and never announces readiness')

    child = Process(hold_close=True)
    bridge = runtime.LGBridgeClient(Path.cwd())
    bridge.process = child
    bridge.reader = asyncio.create_task(bridge.read_results())
    closing = asyncio.create_task(runtime.await_bridge_close(bridge))
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert child.stdin.closed
    closing.cancel()  # Uvicorn's replayed SIGINT cancels the serve task here.
    await asyncio.sleep(0)
    assert not closing.done() and not bridge.reader.done()
    checks.append('replayed Ctrl+C cannot cancel LG EOF drain or its result reader')
    child.finish()
    await closing
    checks.append('protected shutdown still waits for the actual child exit')

    child = Process()
    bridge = runtime.LGBridgeClient(Path.cwd())
    bridge.process = child
    bridge.reader = asyncio.create_task(bridge.read_results())
    child.finish(1)
    try:
        await bridge.close()
        raise AssertionError('Failed shutdown must reject')
    except RuntimeError:
        checks.append('nonzero child exit propagates to launcher failure')

    try:
        runtime.LGBridgeClient(Path.cwd(), 'arbitrary')
        raise AssertionError('Unknown mode must reject')
    except ValueError:
        checks.append('unknown mode is refused before process creation')

    # 2026-10-05：启动横幅搬家（`.cmd` 保持纯 ASCII，横幅改由 Python 打印）。
    # 两条都要钉：正式入口仍看得见那三行（含**调用方给的**端口），且皮套测试入口保持安静。
    silent = io.StringIO()
    with redirect_stdout(silent):
        runtime.print_launch_banner('sandbox-copy', 12393)
    assert silent.getvalue() == '', silent.getvalue()
    banner = io.StringIO()
    with redirect_stdout(banner):
        runtime.print_launch_banner('production', 12394)
    lines = banner.getvalue().splitlines()
    assert len(lines) == 3, lines
    assert lines[1] == '启动完成后打开 http://127.0.0.1:12394/', lines
    assert '%' not in banner.getvalue(), lines
    checks.append('launch banner is printed by Python: sandbox silent, production carries the caller port')


asyncio.run(verify())
print(json.dumps({"passed": len(checks), "checks": checks}, ensure_ascii=False))
