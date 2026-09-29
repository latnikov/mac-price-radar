// Apple US configurators and technical specifications, checked 2026-09-24.
// Keep this shared contract authoritative on both client and server.
export const catalog = {
  checkedAt: '2026-09-24',
  models: [
    { id: 'mini', name: 'Mac mini', ethernet: [2.5], chips: [
      { id: 'm6-12-12', name: 'M6', cpu: 12, gpu: 12, memory: [16, 24, 32], storage: [256, 512, 1024, 2048] },
      { id: 'm5pro-15-16', name: 'M5 Pro', cpu: 15, gpu: 16, memory: [24, 48, 64], storage: [512, 1024, 2048] },
      { id: 'm5pro-18-20', name: 'M5 Pro', cpu: 18, gpu: 20, memory: [24, 48, 64], storage: [512, 1024, 2048] },
    ] },
    { id: 'studio', name: 'Mac Studio', ethernet: [10], chips: [
      { id: 'm5max-18-32', name: 'M5 Max', cpu: 18, gpu: 32, memory: [36], storage: [512, 1024, 2048] },
      { id: 'm5max-18-40', name: 'M5 Max', cpu: 18, gpu: 40, memory: [48, 64, 128], storage: [512, 1024, 2048] },
      { id: 'm5ultra-30-64', name: 'M5 Ultra', cpu: 30, gpu: 64, memory: [96, 256], storage: [1024, 2048] },
      { id: 'm5ultra-36-80', name: 'M5 Ultra', cpu: 36, gpu: 80, memory: [96, 256], storage: [1024, 2048] },
    ] },
  ],
  // Google Store US phone lineup and Google hardware specifications, checked 2026-09-27.
  pixelCheckedAt: '2026-09-27',
  pixelModels: [
    { id: 'pixel-11', name: 'Pixel 11', generation: '2026', chip: 'Tensor G6', screen: '6,3″', storage: [256, 512], memoryByStorage: { 256: 12, 512: 12 } },
    { id: 'pixel-11-pro', name: 'Pixel 11 Pro', generation: '2026', chip: 'Tensor G6', screen: '6,3″', storage: [256, 512, 1024], memoryByStorage: { 256: 12, 512: 16, 1024: 16 } },
    { id: 'pixel-11-pro-xl', name: 'Pixel 11 Pro XL', generation: '2026', chip: 'Tensor G6', screen: '6,8″', storage: [256, 512, 1024], memoryByStorage: { 256: 12, 512: 16, 1024: 16 } },
    { id: 'pixel-11-pro-fold', name: 'Pixel 11 Pro Fold', generation: '2026', chip: 'Tensor G6', screen: 'складной', storage: [256, 512, 1024], memoryByStorage: { 256: 16, 512: 16, 1024: 16 } },
    { id: 'pixel-10a', name: 'Pixel 10a', generation: '2026', chip: 'Tensor G4', screen: '6,3″', storage: [128, 256], memoryByStorage: { 128: 8, 256: 8 } },
    { id: 'pixel-10', name: 'Pixel 10', generation: '2025', chip: 'Tensor G5', screen: '6,3″', storage: [128, 256], memoryByStorage: { 128: 12, 256: 12 } },
    { id: 'pixel-10-pro', name: 'Pixel 10 Pro', generation: '2025', chip: 'Tensor G5', screen: '6,3″', storage: [128, 256, 512, 1024], memoryByStorage: { 128: 16, 256: 16, 512: 16, 1024: 16 } },
    { id: 'pixel-10-pro-xl', name: 'Pixel 10 Pro XL', generation: '2025', chip: 'Tensor G5', screen: '6,8″', storage: [256, 512, 1024], memoryByStorage: { 256: 16, 512: 16, 1024: 16 } },
    { id: 'pixel-10-pro-fold', name: 'Pixel 10 Pro Fold', generation: '2025', chip: 'Tensor G5', screen: 'складной', storage: [256, 512, 1024], memoryByStorage: { 256: 16, 512: 16, 1024: 16 } },
  ],
};
export const capacity = n => n >= 1024 ? `${n / 1024} ТБ` : `${n} ГБ`;
const findConfiguration = value => {
  const model = catalog.models.find(x => x.id === value?.model);
  const chip = model?.chips.find(x => x.id === value?.chip);
  return { model, chip };
};
export function validateConfiguration(value) {
  if (value?.model === 'other') {
    if (typeof value.description !== 'string' || value.description.trim().length < 3 || value.description.length > 500 || /[\x00-\x1f\x7f]/.test(value.description)) {
      throw new Error('Опишите товар и нужные параметры: от 3 до 500 символов.');
    }
    return { model: 'other', description: value.description.trim() };
  }
  if (value?.model === 'pixel') {
    const phone = catalog.pixelModels.find(item => item.id === value.phone);
    if (!phone || !phone.storage.includes(value.storage)) throw new Error('Выберите доступную модель Pixel и объём памяти.');
    return { model: 'pixel', phone: phone.id, storage: value.storage };
  }
  const { model, chip } = findConfiguration(value);
  if (!chip || !chip.memory.includes(value.memory) || !chip.storage.includes(value.storage) || !model.ethernet.includes(value.ethernet)) {
    throw new Error('Выберите доступную конфигурацию компьютера.');
  }
  return { model: model.id, chip: chip.id, memory: value.memory, storage: value.storage, ethernet: value.ethernet };
}
export function describeConfiguration(value) {
  if (value.model === 'other') return `Другой товар: ${value.description}`;
  if (value.model === 'pixel') {
    const phone = catalog.pixelModels.find(item => item.id === value.phone);
    return `Google ${phone.name} (${capacity(value.storage)}, ${phone.memoryByStorage[value.storage]} ГБ оперативной памяти, ${phone.chip})`;
  }
  const model = catalog.models.find(x => x.id === value.model);
  const chip = model.chips.find(x => x.id === value.chip);
  return `${model.name} (${chip.name}, CPU ${chip.cpu} / GPU ${chip.gpu}, ${value.memory} ГБ памяти, SSD ${capacity(value.storage)}, Ethernet ${value.ethernet} Гбит/с)`;
}
