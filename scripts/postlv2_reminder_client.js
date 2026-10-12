/** Text-only reminders stay visible without starting or interrupting speech. */
export async function showReminder(packet, doc = document, send = fetch) {
  if (!packet || typeof packet.text !== 'string' || !packet.text.trim() || [...packet.text].length > 500 ||
      typeof packet.deliveryId !== 'string' || typeof packet.receiptToken !== 'string') return false;
  let region = doc.getElementById('lg-reminders');
  if (!region) {
    region = doc.createElement('section'); region.id = 'lg-reminders'; region.setAttribute('aria-live', 'polite');
    Object.assign(region.style, { position: 'fixed', right: '20px', top: '20px', zIndex: '9999', maxWidth: '340px' });
    doc.body.appendChild(region);
  }
  if (![...region.children].some(item => item.dataset.deliveryId === packet.deliveryId)) {
    const card = doc.createElement('div'); card.dataset.deliveryId = packet.deliveryId;
    Object.assign(card.style, { background: '#fff', color: '#222', padding: '16px', marginBottom: '8px', borderRadius: '12px', boxShadow: '0 4px 20px #0003' });
    const text = doc.createElement('p'); text.textContent = `提醒：${packet.text}`;
    const close = doc.createElement('button'); close.textContent = '知道了'; close.onclick = () => card.remove();
    card.append(text, close); region.appendChild(card);
    while (region.children.length > 20) region.firstElementChild.remove();
  }
  try {
    const response = await send('/lg/reminder-receipt', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryId: packet.deliveryId, receiptToken: packet.receiptToken }) });
    return response.ok && (await response.json()).outcome === 'accepted';
  } catch { return false; }
}
