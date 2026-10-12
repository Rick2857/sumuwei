import assert from 'node:assert/strict';
import { showReminder } from './postlv2_reminder_client.js';

class Element {
  children = []; style = {}; dataset = {}; textContent = '';
  constructor(tag) { this.tag = tag; }
  setAttribute(name, value) { this[name] = value; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  appendChild(child) { child.parent = this; this.children.push(child); }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
  get firstElementChild() { return this.children[0]; }
}
const body = new Element('body');
const doc = { body, createElement: tag => new Element(tag), getElementById: id => body.children.find(item => item.id === id) };
const calls = [];
const send = async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ outcome: 'accepted' }) }; };
const packet = { deliveryId: 'delivery-1', text: '<img src=x onerror=alert(1)> 拔插头。', receiptToken: 'bound-token' };
assert.equal(await showReminder(packet, doc, send), true);
const region = doc.getElementById('lg-reminders');
assert.equal(region['aria-live'], 'polite');
assert.equal(region.children[0].children[0].textContent, `提醒：${packet.text}`);
assert.deepEqual(calls[0], { url: '/lg/reminder-receipt', body: { deliveryId: 'delivery-1', receiptToken: 'bound-token' } });
assert.equal(await showReminder(packet, doc, send), true);
assert.equal(region.children.length, 1);
region.children[0].children[1].onclick();
assert.equal(region.children.length, 0);
assert.equal(await showReminder({ ...packet, text: '字'.repeat(501) }, doc, send), false);
assert.equal(await showReminder({ ...packet, receiptToken: undefined }, doc, send), false);
assert.equal(calls.length, 2);
assert.equal(await showReminder(packet, doc, async () => ({ ok: true, json: async () => ({ outcome: 'rejected' }) })), false);
assert.equal(await showReminder(packet, doc, async () => { throw new Error('offline'); }), false);
for (let i = 0; i < 21; i++) await showReminder({ ...packet, deliveryId: `bounded-${i}` }, doc, send);
assert.equal(region.children.length, 20);
console.log('皮套页面：安全文字显示、回执、去重、关闭、容量和失败分列 PASS');
