// Apple technical specifications checked 2026-10-01. This registry describes
// models, never stock or a generated cross-product of purchasable variants.
export const lineupCheckedAt = '2026-10-01';
export const macbookFamilies = Object.freeze([
  { id: 'neo', name: 'MacBook Neo', sizes: [13], chips: ['A18 Pro'], description: 'Первый Mac. Всё самое нужное.', source: 'https://www.apple.com/macbook-neo/specs/' },
  { id: 'air', name: 'MacBook Air', sizes: [13, 15], chips: ['M5'], description: 'Лёгкий. Быстрый. На каждый день.', source: 'https://www.apple.com/macbook-air/specs/' },
  { id: 'pro', name: 'MacBook Pro', sizes: [14, 16], chips: ['M5', 'M5 Pro', 'M5 Max'], description: 'Больше мощности для большой работы.', source: 'https://www.apple.com/macbook-pro/specs/' },
]);
const colors = new Map([
  ['silver', 'Silver'], ['серебристый', 'Silver'], ['серебристая', 'Silver'],
  ['midnight', 'Midnight'], ['тёмная ночь', 'Midnight'], ['темная ночь', 'Midnight'],
  ['starlight', 'Starlight'], ['сияющая звезда', 'Starlight'],
  ['sky blue', 'Sky Blue'], ['skyblue', 'Sky Blue'], ['небесно-голубой', 'Sky Blue'],
  ['space black', 'Space Black'], ['spaceblack', 'Space Black'], ['чёрный космос', 'Space Black'], ['черный космос', 'Space Black'],
  ['blush', 'Blush'], ['citrus', 'Citrus'], ['indigo', 'Indigo'],
]);
export const colorNames = { Silver: 'Серебристый', Midnight: 'Тёмная ночь', Starlight: 'Сияющая звезда', 'Sky Blue': 'Небесно-голубой', 'Space Black': 'Чёрный космос', Blush: 'Розовый', Citrus: 'Цитрус', Indigo: 'Индиго' };
const integer = v => v === null || v === undefined || v === '' ? null : Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null;
export const capacity = n => n >= 1024 ? `${n / 1024} ТБ` : `${n} ГБ`;

export function inspectMacbook(input = {}) {
  input ||= {};
  const model = String(input.model || '').replace(/[″”"]/g, '').replace(/\s+/g, ' ').trim();
  const family = macbookFamilies.find(f => new RegExp(`\\bMacBook\\s+${f.id}\\b`, 'i').test(model));
  const rawChip = String(input.chip || '').replace(/\s+/g, '').toLowerCase();
  const chip = ({ a18pro: 'A18 Pro', m5: 'M5', m5pro: 'M5 Pro', m5max: 'M5 Max' })[rawChip] || '';
  const screenIn = integer(input.screenIn) || integer(model.match(/\b(13|14|15|16)\b/)?.[1]) || (family?.id === 'neo' ? 13 : null);
  const color = colors.get(String(input.color || '').trim().toLowerCase()) || '';
  const ramGb = integer(input.ramGb), storageGb = ({1000:1024,2000:2048,4000:4096,8000:8192})[integer(input.storageGb)] || integer(input.storageGb), cpuCores = integer(input.cpuCores), gpuCores = integer(input.gpuCores);
  const issues = [];
  if (!family || !family.sizes.includes(screenIn)) issues.push('Модель не входит в актуальную линейку MacBook');
  if (input.condition !== 'new' || /б\s*\/\s*у|refurb|used|восстановлен|витрин|open.?box/i.test(model)) issues.push('Не подтверждено новое состояние');
  if (!family?.chips.includes(chip) || (family?.id === 'pro' && screenIn === 16 && chip === 'M5')) issues.push('Неподходящий чип');
  const memory = family?.id === 'neo' ? [8] : family?.id === 'air' || chip === 'M5' ? [16, 24, 32] : chip === 'M5 Pro' ? [24, 48, 64] : [36, 48, 64, 128];
  const storage = family?.id === 'neo' ? [256, 512] : family?.id === 'air' ? [512, 1024, 2048, 4096] : chip === 'M5 Max' ? [2048, 4096, 8192] : [1024, 2048, 4096];
  if (!memory.includes(ramGb) || !storage.includes(storageGb)) issues.push('Проверьте память и накопитель по спецификации Apple');
  const allowedColors = family?.id === 'neo' ? ['Silver', 'Blush', 'Citrus', 'Indigo'] : family?.id === 'air' ? ['Silver', 'Midnight', 'Starlight', 'Sky Blue'] : ['Silver', 'Space Black'];
  if (!allowedColors.includes(color)) issues.push('Не подтверждён цвет');
  if (family?.id === 'neo' && ((cpuCores && cpuCores !== 6) || (gpuCores && gpuCores !== 5))) issues.push('Проверьте конфигурацию A18 Pro');
  if (chip === 'M5' && ((cpuCores && cpuCores !== 10) || (gpuCores && ![8, 10].includes(gpuCores)) || (family?.id === 'pro' && gpuCores === 8))) issues.push('Проверьте ядра M5');
  if (chip === 'M5 Pro' && (cpuCores || gpuCores) && !([[15, 16], [18, 20]].some(([c, g]) => c === cpuCores && g === gpuCores))) issues.push('Неоднозначная конфигурация M5 Pro');
  if (chip === 'M5 Pro' && screenIn === 16 && (cpuCores && cpuCores !== 18 || gpuCores && gpuCores !== 20)) issues.push('16-дюймовый M5 Pro требует 18 CPU / 20 GPU');
  if (chip === 'M5 Pro' && ramGb === 64 && gpuCores !== 20) issues.push('64 ГБ требуют M5 Pro с 20 ядрами GPU');
  if (chip === 'M5 Max' && (![[18, 32], [18, 40]].some(([c, g]) => c === cpuCores && g === gpuCores) || (gpuCores === 32 && ramGb !== 36) || (gpuCores === 40 && ramGb === 36))) issues.push('Неоднозначная конфигурация M5 Max');
  const configuration = { model: family ? `${family.name} ${screenIn}` : model, family: family?.id || '', chip, screenIn, ramGb, storageGb, color, cpuCores, gpuCores,
    keyboard: (input.keyboard && input.keyboard !== 'unknown' ? String(input.keyboard).slice(0, 40) : null), region: (input.region && input.region !== 'unknown' ? String(input.region).slice(0, 40) : null), condition: input.condition || null };
  return { ok: issues.length === 0, issues, configuration, family };
}

export function configurationTitle(c) { return `${c.model}″ · ${c.chip} · ${c.ramGb}/${capacity(c.storageGb)} · ${colorNames[c.color] || c.color}`; }
export function configurationSpec(c) { return [c.chip, `${c.ramGb} ГБ памяти`, `${capacity(c.storageGb)} SSD`, colorNames[c.color] || c.color, c.cpuCores && c.gpuCores ? `${c.cpuCores} CPU / ${c.gpuCores} GPU` : '', c.keyboard, c.region].filter(Boolean).join(' · '); }

export function importPriceCatalog(store, { publish = false, actor = 'owner' } = {}) {
  const report = { created: 0, updated: 0, published: 0, skipped: 0, issues: [] };
  const recommendations = store.db.prepare('SELECT data FROM recommendations ORDER BY key').all().map(r => JSON.parse(r.data));
  for (const r of recommendations) {
    const inspected = inspectMacbook(r.configuration);
    if (!inspected.ok || r.priceRub == null) { report.skipped++; report.issues.push({ key: r.key, title: r.label, reasons: inspected.ok ? r.issues : inspected.issues }); continue; }
    const mapping = store.db.prepare('SELECT product_id,managed FROM catalog_imports WHERE recommendation_key=?').get(r.key);
    const matches = mapping ? [store.product(mapping.product_id)].filter(Boolean) : store.products().filter(p => p.draft.recommendationKey === r.key);
    if (matches.length > 1) { report.skipped++; report.issues.push({ key: r.key, title: r.label, reasons: ['Несколько карточек с одной конфигурацией: проверьте вручную'] }); continue; }
    const existing = matches[0];
    if (existing && !mapping?.managed) { report.skipped++; continue; }
    const c = inspected.configuration;
    const draft = existing?.draft || { title: configurationTitle(c), category: 'MacBook', vendor: 'Apple', description: 'Новый MacBook. Условия заказа и получения подтверждает менеджер.', channels: [] };
    const desiredPublished=publish || Boolean(existing?.published);
    if(existing && JSON.stringify(existing.draft.configuration)===JSON.stringify(c) && Boolean(existing.published)===desiredPublished){if(existing.published)report.published++;continue;}
    const p = store.tx(()=>{const saved=store.saveProduct({ ...draft, configuration: c, recommendationKey: r.key, mappingConfirmed: true, specification: existing?.draft.specification || configurationSpec(c) },
      { id: existing?.id, expectedRevision: existing?.revision, publish: desiredPublished, actor });
    store.db.prepare('INSERT INTO catalog_imports VALUES(?,?,1) ON CONFLICT(recommendation_key) DO UPDATE SET product_id=excluded.product_id').run(r.key, saved.id);return saved;});
    existing ? report.updated++ : report.created++;
    if (p.published) report.published++;
  }
  store.setSetting('catalog_import', { ...report, issues: report.issues.slice(0, 200), at: store.now() });
  store.audit(actor, 'catalog_imported', JSON.stringify({ created: report.created, updated: report.updated, published: report.published }));
  return report;
}
