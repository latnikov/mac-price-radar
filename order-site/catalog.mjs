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
};
export const capacity = n => n >= 1024 ? `${n / 1024} ТБ` : `${n} ГБ`;
const findConfiguration = value => {
  const model = catalog.models.find(x => x.id === value?.model);
  const chip = model?.chips.find(x => x.id === value?.chip);
  return { model, chip };
};
export function validateConfiguration(value) {
  const { model, chip } = findConfiguration(value);
  if (!chip || !chip.memory.includes(value.memory) || !chip.storage.includes(value.storage) || !model.ethernet.includes(value.ethernet)) {
    throw new Error('Выберите доступную конфигурацию компьютера.');
  }
  return { model: model.id, chip: chip.id, memory: value.memory, storage: value.storage, ethernet: value.ethernet };
}
export function describeConfiguration(value) {
  const model = catalog.models.find(x => x.id === value.model);
  const chip = model.chips.find(x => x.id === value.chip);
  return `${model.name} (${chip.name}, CPU ${chip.cpu} / GPU ${chip.gpu}, ${value.memory} ГБ памяти, SSD ${capacity(value.storage)}, Ethernet ${value.ethernet} Гбит/с)`;
}
