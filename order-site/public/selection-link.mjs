import { validateConfiguration } from './catalog.mjs';

// Only catalog choices enter a shareable URL. Contact fields, consent, payment
// and free-form requests remain in the form and never enter browser history.
export function readSelection(hash = '') {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (params.get('model') === 'other') return { model: 'other' };
  const value = { model: params.get('model'), chip: params.get('chip'), phone: params.get('phone') };
  for (const key of ['memory', 'storage', 'ethernet']) value[key] = Number(params.get(key));
  try { return validateConfiguration(value); } catch { return null; }
}

export function selectionHash(configuration) {
  if (configuration.model === 'other') return '#model=other';
  const safe = validateConfiguration(configuration);
  return `#${new URLSearchParams(Object.entries(safe))}`;
}
