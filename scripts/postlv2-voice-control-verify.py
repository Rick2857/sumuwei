"""Functional queue and wire checks; no microphone, GPU, model or database."""
import asyncio
import json
from pathlib import Path
import postlv2_vtuber_runtime as runtime
from postlv2_voice_control import SpeechInbox


async def verify():
    inbox = SpeechInbox(2)
    assert inbox.put_nowait({"index": 0}) and inbox.put_nowait({"index": 1})
    assert (await inbox.get())["index"] == 0
    assert inbox.put_nowait({"index": 2})
    assert not inbox.put_nowait({"index": 3})
    try:
        await inbox.get()
        raise AssertionError("overflow did not interrupt")
    except asyncio.CancelledError:
        pass
    assert not inbox.put_nowait({"index": 4})

    client = runtime.LGBridgeClient(Path.cwd(), connect={"host": "fixture"})
    client.socket_writer = object()
    client.ready = True
    incoming = asyncio.Queue()
    sent = []

    async def read_line():
        return await incoming.get()

    async def send_line(line):
        sent.append(json.loads(line))

    client._read_line = read_line
    client._send_line = send_line
    reader = asyncio.create_task(client.read_results())
    busy_turn = asyncio.create_task(client.request({"kind": "SUBMIT_TURN", "requestId": "busy", "userText": "fixture"}))
    await asyncio.sleep(0)
    waiting = SpeechInbox()
    client.speech_queues["busy"] = waiting
    waiting.put_nowait({"kind": "SPEECH_SEGMENT", "requestId": "busy"})
    first = asyncio.create_task(client.interrupt("busy"))
    second = asyncio.create_task(client.interrupt("busy"))
    for _ in range(5):
        await asyncio.sleep(0)
    assert not busy_turn.done() and not first.done() and not second.done()
    assert sum(packet["kind"] == "CANCEL_TURN" for packet in sent) == 1
    try:
        await waiting.get()
        raise AssertionError("queued speech survived interrupt")
    except asyncio.CancelledError:
        pass
    await incoming.put((json.dumps({"kind": "CANCEL_RESULT", "requestId": "busy",
        "cancel": {"requested": True, "stoppedBeforeModel": False, "alreadyCommitted": False}}) + "\n").encode())
    assert (await first)["status"] == "acknowledged" and (await second)["status"] == "acknowledged"
    assert (await client.interrupt("busy"))["status"] == "acknowledged"
    assert sum(packet["kind"] == "CANCEL_TURN" for packet in sent) == 1
    assert client.cancel_reading["requested"] == 1
    assert not busy_turn.done()  # ACK is not model completion or durable rollback.
    busy_turn.cancel()
    await asyncio.gather(busy_turn, return_exceptions=True)
    await incoming.put(b"")
    await reader
    assert (await client.interrupt("disconnected"))["status"] == "failed"
    print(json.dumps({"checks": 8, "passed": 8, "performanceAcceptance": "NOT RUN", "databaseOpened": False}))


asyncio.run(verify())
