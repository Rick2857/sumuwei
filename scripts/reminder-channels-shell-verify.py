"""Exercise the actual avatar reminder boundary without opening production or TTS."""
import asyncio
import json
from unittest.mock import AsyncMock
import postlv2_vtuber_runtime as runtime


async def verify():
    runtime.BRIDGE = type('Bridge', (), {'report': AsyncMock(return_value={'outcome': 'accepted'})})()
    runtime.REMINDER_CLIENT['websocket'] = None
    message = {'requestId': 'due-1', 'reminderText': '记得拔插头。'}
    await runtime.deliver_local_reminder(message)
    assert runtime.BRIDGE.report.call_args.args[0]['deliveryStatus'] == 'failed_confirmed'
    runtime.BRIDGE.report.reset_mock()
    websocket = type('WebSocket', (), {'send_text': AsyncMock()})()
    handler_class = type('Handler', (), {'handle_new_connection': AsyncMock(), 'handle_disconnect': AsyncMock()})
    runtime.bind_reminder_websockets(handler_class)
    handler = handler_class()
    await handler.handle_new_connection(websocket, 'client-1')
    assert runtime.REMINDER_CLIENT['websocket'] is websocket, 'new page receives reminders before its first chat'
    await runtime.deliver_local_reminder(message)
    assert runtime.BRIDGE.report.call_count == 0, 'sending a websocket packet is not browser receipt'
    packet = json.loads(websocket.send_text.call_args.args[0])
    assert packet['type'] == 'lg-reminder' and packet['text'] == message['reminderText']
    body = {'deliveryId': message['requestId'], 'receiptToken': 'forged'}
    assert (await runtime.accept_local_reminder_receipt(body))['outcome'] == 'rejected'
    body['receiptToken'] = packet['receiptToken']
    runtime.REMINDER_CLIENT['websocket'] = object()
    assert (await runtime.accept_local_reminder_receipt(body))['outcome'] == 'rejected'
    runtime.REMINDER_CLIENT['websocket'] = websocket
    assert (await runtime.accept_local_reminder_receipt(body))['outcome'] == 'accepted'
    report = runtime.BRIDGE.report.call_args.args[0]
    assert report['kind'] == 'REPORT_REMINDER_DELIVERY' and report['deliveryStatus'] == 'api_accepted'
    assert (await runtime.accept_local_reminder_receipt(body))['outcome'] == 'rejected'
    await runtime.deliver_local_reminder({'requestId': 'expired', 'reminderText': '过期'})
    expired = json.loads(websocket.send_text.call_args.args[0])
    runtime.REMINDER_RECEIPTS['expired']['at'] -= 31
    assert (await runtime.accept_local_reminder_receipt({'deliveryId': 'expired', 'receiptToken': expired['receiptToken']}))['outcome'] == 'rejected'
    websocket.send_text.side_effect = ConnectionError('closed')
    await runtime.deliver_local_reminder({'requestId': 'closed', 'reminderText': '断线'})
    assert runtime.BRIDGE.report.call_args.args[0]['deliveryStatus'] == 'failed_confirmed'
    assert 'closed' not in runtime.REMINDER_RECEIPTS
    await handler.handle_disconnect('client-1')
    assert runtime.REMINDER_CLIENT['websocket'] is None and not runtime.REMINDER_RECEIPTS
    print('皮套外壳：无客户端、显示前不接受、绑定令牌/连接、重复/过期与断线 PASS')


asyncio.run(verify())
