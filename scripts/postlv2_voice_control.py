"""Bounded speech inbox with an immediate interruption path, independent of core ACK."""
import asyncio


class SpeechInbox:
    def __init__(self, limit=64):
        self._queue = asyncio.Queue(maxsize=limit)
        self._interrupted = False

    def put_nowait(self, packet):
        if self._interrupted:
            return False
        try:
            self._queue.put_nowait(packet)
            return True
        except asyncio.QueueFull:
            self.interrupt()
            return False

    def interrupt(self):
        if self._interrupted:
            return
        self._interrupted = True
        while not self._queue.empty():
            self._queue.get_nowait()
        self._queue.put_nowait(None)

    async def get(self):
        if self._interrupted:
            raise asyncio.CancelledError('speech_inbox_interrupted')
        packet = await self._queue.get()
        if packet is None or self._interrupted:
            raise asyncio.CancelledError('speech_inbox_interrupted')
        return packet
