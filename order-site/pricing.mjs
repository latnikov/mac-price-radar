import { catalog, validateConfiguration } from './catalog.mjs';

// Customer totals from the supplied workbook. This module is server-only.
const totalsUsd = {
  'm6-12-12': {
    '16-256': 1189, '16-512': 1439, '16-1024': 1814, '16-2048': 2439,
    '24-256': 1439, '24-512': 1689, '24-1024': 2064, '24-2048': 2689,
    '32-256': 1689, '32-512': 1939, '32-1024': 2314, '32-2048': 2939,
  },
  'm5pro-15-16': {
    '24-512': 2192, '24-1024': 2567, '24-2048': 3192,
    '48-512': 2942, '48-1024': 3317, '48-2048': 3942,
    '64-512': 3442, '64-1024': 3817, '64-2048': 4442,
  },
  'm5pro-18-20': {
    '24-512': 2442, '24-1024': 2817, '24-2048': 3442,
    '48-512': 3192, '48-1024': 3567, '48-2048': 4192,
    '64-512': 3692, '64-1024': 4067, '64-2048': 4692,
  },
  'm5max-18-32': {
    '36-512': 3374, '36-1024': 3749, '36-2048': 4374,
  },
  'm5max-18-40': {
    '48-512': 4124, '48-1024': 4499, '48-2048': 5124,
    '64-512': 4624, '64-1024': 4999, '64-2048': 5624,
    '128-512': 6624, '128-1024': 6999, '128-2048': 7624,
  },
  'm5ultra-30-64': {
    '96-1024': 7154, '96-2048': 7779,
    '256-1024': 12154, '256-2048': 12779,
  },
  'm5ultra-36-80': {
    '96-1024': 8779, '96-2048': 9404,
    '256-1024': 13779, '256-2048': 14404,
  },
};

export const pricingInfo = Object.freeze({
  usdRub: 84.578,
  rateAdjustmentRub: 4,
  checkedAt: '2026-09-25T08:16:19Z',
  source: 'https://www.google.com/finance/quote/USD-RUB',
  configurationCount: Object.values(totalsUsd).reduce((sum, prices) => sum + Object.keys(prices).length, 0),
});

export function quoteCustomerPrice(value) {
  const configuration = validateConfiguration(value);
  const totalUsd = totalsUsd[configuration.chip]?.[`${configuration.memory}-${configuration.storage}`];
  if (!Number.isInteger(totalUsd)) throw new Error('Для этой конфигурации пока нет предварительной цены.');
  return Math.round(totalUsd * (pricingInfo.usdRub + pricingInfo.rateAdjustmentRub));
}

// Upgrade prices are derived from complete customer quotes. That keeps the UI in
// sync with the authoritative price table without publishing its source amounts.
export function quoteConfigurator(value) {
  const configuration = validateConfiguration(value);
  const model = catalog.models.find(item => item.id === configuration.model);
  const chip = model.chips.find(item => item.id === configuration.chip);
  const quote = overrides => quoteCustomerPrice({ ...configuration, ...overrides });
  const startingQuote = candidate => quoteCustomerPrice({
    model: model.id,
    chip: candidate.id,
    memory: candidate.memory[0],
    storage: candidate.storage[0],
    ethernet: model.ethernet[0],
  });
  const modelBasePriceRub = startingQuote(model.chips[0]);
  const memoryBasePriceRub = quote({ memory: chip.memory[0] });
  const storageBasePriceRub = quote({ storage: chip.storage[0] });
  const ethernetBasePriceRub = quote({ ethernet: model.ethernet[0] });
  return {
    priceRub: quoteCustomerPrice(configuration),
    basePricesRub: {
      chip: modelBasePriceRub,
      memory: memoryBasePriceRub,
      storage: storageBasePriceRub,
      ethernet: ethernetBasePriceRub,
    },
    stepPricesRub: {
      chip: Object.fromEntries(model.chips.map(option => [option.id, startingQuote(option) - modelBasePriceRub])),
      memory: Object.fromEntries(chip.memory.map(option => [option, quote({ memory: option }) - memoryBasePriceRub])),
      storage: Object.fromEntries(chip.storage.map(option => [option, quote({ storage: option }) - storageBasePriceRub])),
      ethernet: Object.fromEntries(model.ethernet.map(option => [option, quote({ ethernet: option }) - ethernetBasePriceRub])),
    },
  };
}

export const formatPublicPrice = price => `${Number(price).toLocaleString('ru-RU')} ₽`;
