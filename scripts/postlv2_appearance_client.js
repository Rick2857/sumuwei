/** Manual appearance overlays own only this avatar's clothing and effect parameters. */
export function createAppearanceController(definition, publish = () => {}) {
  let costume = 'original';
  const effects = new Set();
  let binding = null;
  let rendered = null;
  let frames = 0;
  const entries = [...definition.costumes, ...definition.effects];
  const parameterIds = [...new Set(entries.flatMap(item => item.parameters.map(p => p.Id)))];
  const reading = () => ({ costume, effects: [...effects], bound: binding !== null, rendered });
  const changed = () => { rendered = null; publish(reading()); };

  function unbind() {
    binding?.release();
    if (binding && binding.core.update === binding.wrapped) binding.core.update = binding.original;
    binding = null;
    changed();
  }

  function bind(model) {
    unbind();
    if (model?._modelSetting?.getModelFileName() !== 'ulvm2_0001.moc3') return false;
    const core = model._model;
    if (!core) return false;
    const indices = new Map();
    for (let i = 0; i < core.getParameterCount(); i++) indices.set(core.getParameterId(i).getString().s, i);
    if (parameterIds.some(id => !indices.has(id))) return false;
    const owned = parameterIds.map(id => ({ id, index: indices.get(id), defaultValue: core.getParameterDefaultValue(indices.get(id)) }));
    const original = core.update;
    let enabled = true;
    const wrapped = function (...args) {
      if (!enabled) {
        if (core.update === wrapped) core.update = original;
        return original.apply(this, args);
      }
      const values = new Map(owned.map(p => [p.id, p.defaultValue]));
      const selected = [definition.costumes.find(item => item.id === costume),
        ...definition.effects.filter(item => effects.has(item.id))].filter(Boolean);
      for (const item of selected) for (const p of item.parameters) values.set(p.Id, values.get(p.Id) + p.Value);
      const before = owned.map(p => core.getParameterValueByIndex(p.index));
      const applied = {};
      for (const p of owned) {
        applied[p.id] = Math.max(core.getParameterMinimumValue(p.index), Math.min(core.getParameterMaximumValue(p.index), values.get(p.id)));
        core.setParameterValueByIndex(p.index, applied[p.id]);
      }
      try {
        const result = original.apply(this, args);
        const firstFrame = !rendered;
        rendered = { costume, effects: [...effects], parameters: applied, frame: ++frames, timestampMs: Date.now() };
        if (firstFrame || frames % 30 === 0) publish(reading());
        return result;
      } finally { owned.forEach((p, i) => core.setParameterValueByIndex(p.index, before[i])); }
    };
    binding = { core, original, wrapped, release: () => { enabled = false; } };
    core.update = wrapped;
    changed();
    return true;
  }

  function setCostume(id) {
    if (id !== 'original' && !definition.costumes.some(item => item.id === id)) return false;
    costume = id;
    changed();
    return true;
  }

  function setEffect(id, enabled) {
    if (typeof enabled !== 'boolean' || !definition.effects.some(item => item.id === id)) return false;
    if (enabled) effects.add(id); else effects.delete(id);
    changed();
    return true;
  }

  function clearEffects() { effects.clear(); changed(); }
  return { bind, unbind, setCostume, setEffect, clearEffects, reading };
}
