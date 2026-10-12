import { useEffect, useState } from 'react';
import { useLive2DConfig } from '@/context/live2d-config-context';
import { createAppearanceController } from '@/utils/postlv2-appearance';
import definition from '@/utils/postlv2-appearance.json';

const controller = createAppearanceController(definition, value => {
  document.documentElement.setAttribute('data-lg-appearance', JSON.stringify(value));
});
const panelStyle = { position: 'fixed', top: 16, right: 16, zIndex: 30, maxWidth: 'calc(100vw - 32px)',
  border: '1px solid #dce3ed', borderRadius: 12, background: '#fff', color: '#25354b',
  boxShadow: '0 4px 20px #18334d18', fontSize: 14 };

export function AppearancePanel() {
  const { modelInfo } = useLive2DConfig();
  const [ready, setReady] = useState(false);
  const [selection, setSelection] = useState(controller.reading());
  useEffect(() => {
    if (modelInfo?.name !== 'lg_ulvm2_0001') return;
    let frame;
    let attached = null;
    let isReady = false;
    setReady(false);
    const attach = () => {
      const model = window.getLive2DManager?.()?.getModel(0);
      if (model !== attached || !isReady) {
        const bound = controller.bind(model);
        attached = bound ? model : null;
        if (bound !== isReady) { isReady = bound; setReady(bound); }
      }
      frame = requestAnimationFrame(attach);
    };
    attach();
    return () => { cancelAnimationFrame(frame); controller.unbind(); };
  }, [modelInfo?.name, modelInfo?.url]);
  if (modelInfo?.name !== 'lg_ulvm2_0001') return null;
  const change = action => { action(); setSelection(controller.reading()); };
  return <details style={panelStyle}>
    <summary style={{ cursor: 'pointer', padding: '10px 14px', fontWeight: 600 }}>服装与特效</summary>
    <div style={{ padding: '4px 14px 14px', width: 260, maxWidth: 'calc(100vw - 32px)', maxHeight: '65vh', overflowY: 'auto' }}>
      {!ready && <p role="status">皮套正在加载…</p>}
      <label style={{ display: 'block', marginBottom: 14 }}>服装
        <select aria-label="服装" disabled={!ready} value={selection.costume}
          onChange={event => change(() => controller.setCostume(event.target.value))}
          style={{ display: 'block', width: '100%', marginTop: 6, padding: 8, border: '1px solid #cbd5e1', borderRadius: 6 }}>
          <option value="original">原始服装</option>
          {definition.costumes.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      <fieldset disabled={!ready} style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 8 }}>特效</legend>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 10px' }}>
          {definition.effects.map(item => <label key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={selection.effects.includes(item.id)}
              onChange={event => change(() => controller.setEffect(item.id, event.target.checked))} />{item.label}
          </label>)}
        </div>
        <button type="button" onClick={() => change(() => controller.clearEffects())}
          style={{ marginTop: 12, padding: '6px 10px', border: '1px solid #cbd5e1', borderRadius: 6 }}>清除特效</button>
      </fieldset>
    </div>
  </details>;
}
