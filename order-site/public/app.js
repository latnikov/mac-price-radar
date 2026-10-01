import { catalog, capacity, describeConfiguration } from './catalog.mjs';
import { createQuoteLoader } from './quote-client.mjs';
import { readSelection, selectionHash } from './selection-link.mjs';
const loadQuote = createQuoteLoader();
const $ = id => document.getElementById(id);
let model = catalog.models[0];
let requestId = crypto.randomUUID();
let pendingPayload = null;
let sending = false;
let currentQuoteRub = null;
let currentQuoteStatus = 'on_request';
let currentPricingAsOf = null;
let quoteReady = false;
let quoteVersion = 0;
let currentStep = 'configuration';
let restoredSelection = readSelection(location.hash);
function saveSelection() {
  const hash = selectionHash(selection());
  if (location.hash !== hash) history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
}
function syncMobileOrder() {
  $('mobile-order').hidden = currentStep !== 'configuration';
  $('mobile-model').textContent = model.id === 'other' ? 'Другой товар' : model.name;
  $('mobile-price').textContent = quoteReady ? (Number.isInteger(currentQuoteRub) ? formatPublicPrice(currentQuoteRub) : 'Цена по запросу') : 'Выберите параметры';
  $('mobile-continue').disabled = !quoteReady;
  $('mobile-continue').textContent = Number.isInteger(currentQuoteRub) ? 'Оформить →' : 'Продолжить →';
}
const formatPublicPrice = price => `${Number(price).toLocaleString('ru-RU')} ₽`;
const priceText = (price, status = currentQuoteStatus) => Number.isInteger(price) ? `${status === 'stale_estimate' ? 'Ориентировочная' : 'Предварительная'} цена: ${formatPublicPrice(price)}` : 'Цена по запросу';
const quoteNote = (price, status, asOf) => {
  if (!Number.isInteger(price)) return 'Оставьте заявку на выбранную конфигурацию. Стоимость, наличие и срок привоза подтвердим по телефону.';
  const date = Number.isFinite(Date.parse(asOf)) ? new Date(asOf).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }) : null;
  const basis = status === 'stale_estimate' ? `Это ориентир по последнему прайсу${date ? ` от ${date}` : ''}.` : 'Это предварительная цена.';
  return `${basis} Точную стоимость и срок привоза в Нижний Новгород подтвердим по телефону.`;
};
const paymentMethod = () => document.querySelector('input[name="payment"]:checked').value;
const paymentText = () => paymentMethod() === 'invoice' ? 'Перевод на расчётный счёт от ИП/юрлица' : 'Наличные';
const selectedValue = id => $(id).querySelector('[aria-pressed="true"]')?.dataset.value;
const setStepPricesLoading = () => document.querySelectorAll('.option-step').forEach(step => {
  step.textContent = 'Считаем цену…';
  step.closest('button').classList.remove('is-upgrade', 'is-downgrade');
});
const showStepPrices = (stepPrices, currentPrice) => {
  document.querySelectorAll('.option-step').forEach(step => {
    step.textContent = 'Цена по запросу';
    step.closest('button').classList.remove('is-upgrade', 'is-downgrade');
  });
  for (const [group, prices] of Object.entries(stepPrices)) {
    $(`${group}-options`)?.querySelectorAll('button').forEach(button => {
      const price = prices[button.dataset.value];
      const step = button.querySelector('.option-step');
      if (!step) return;
      if (!Number.isInteger(price)) { step.textContent = 'Цена по запросу'; return; }
      step.textContent = price === 0
        ? formatPublicPrice(currentPrice)
        : `${price > 0 ? '+' : '−'} ${formatPublicPrice(Math.abs(price))}`;
      button.classList.toggle('is-upgrade', price > 0);
      button.classList.toggle('is-downgrade', price < 0);
    });
  }
};
const optionButtons = (id, values, label, onChange, { preferred, preserve = true, detail } = {}) => {
  const container = $(id);
  const previous = selectedValue(id);
  const normalized = values.map(value => ({ value, id: String(typeof value === 'object' ? value.id : value) }));
  const selected = preserve && normalized.some(item => item.id === previous)
    ? previous
    : String(preferred !== undefined && normalized.some(item => item.id === String(preferred)) ? preferred : normalized[0].id);
  const buttons = normalized.map(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.value = item.id;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-pressed', String(item.id === selected));
    button.setAttribute('aria-checked', String(item.id === selected));
    button.tabIndex = item.id === selected ? 0 : -1;
    const name = document.createElement('span');
    name.className = 'option-name';
    name.textContent = label(item.value);
    const step = document.createElement('span');
    step.className = 'option-step';
    step.textContent = 'Считаем цену…';
    button.append(name);
    if (detail) {
      const description = document.createElement('span');
      description.className = 'option-detail'; description.textContent = detail(item.value);
      button.append(description);
    }
    button.append(step);
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-pressed') === 'true') return;
      container.querySelectorAll('button').forEach(other => {
        const active = other === button;
        other.setAttribute('aria-pressed', String(active));
        other.setAttribute('aria-checked', String(active));
        other.tabIndex = active ? 0 : -1;
      });
      onChange();
    });
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = [...container.querySelectorAll('button')];
      const index = items.indexOf(button);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + items.length) % items.length;
      items[next].click(); items[next].focus();
    });
    return button;
  });
  container.replaceChildren(...buttons);
};
function selection() {
  if (model.id === 'other') return { model: 'other', description: $('other-description').value.trim() };
  if (model.id === 'pixel') return { model: 'pixel', phone: selectedValue('phone-options'), storage: Number(selectedValue('pixel-storage-options')) };
  return {
    model: model.id,
    chip: selectedValue('chip-options'),
    memory: Number(selectedValue('memory-options')),
    storage: Number(selectedValue('storage-options')),
    ethernet: Number(selectedValue('ethernet-options')),
  };
}
async function refreshQuote(configuration) {
  const version = ++quoteVersion;
  currentQuoteRub = null;
  currentQuoteStatus = 'on_request';
  currentPricingAsOf = null;
  quoteReady = false;
  $('continue-order').disabled = true;
  $('retry-quote').hidden = true;
  $('quote-note').textContent = 'Проверяем стоимость выбранной конфигурации…';
  syncMobileOrder();
  $('price').textContent = 'Считаем предварительную цену…';
  setStepPricesLoading();
  try {
    const data = await loadQuote(configuration);
    if (version !== quoteVersion) return;
    currentQuoteRub = data.priceRub;
    currentQuoteStatus = data.priceStatus;
    currentPricingAsOf = data.pricingAsOf;
    quoteReady = true;
    showStepPrices(data.stepPricesRub, currentQuoteRub);
    $('price').textContent = priceText(currentQuoteRub);
    $('continue-order').textContent = Number.isInteger(currentQuoteRub) ? 'Оформить заказ' : 'Запросить стоимость';
    $('quote-note').textContent = quoteNote(currentQuoteRub, currentQuoteStatus, currentPricingAsOf);
    $('price-help').textContent = Number.isInteger(currentQuoteRub)
      ? 'Под выбранными вариантами показана текущая цена, под остальными — насколько цена увеличится или уменьшится.'
      : 'Выберите нужную конфигурацию и отправьте запрос стоимости. Цену подтвердим перед покупкой.';
    $('continue-order').disabled = false;
    syncMobileOrder();
  } catch (error) {
    if (version !== quoteVersion) return;
    document.querySelectorAll('.option-step').forEach(step => { step.textContent = 'Доплата недоступна'; });
    $('price').textContent = 'Не удалось рассчитать цену';
    $('quote-note').textContent = 'Проверьте соединение и повторите расчёт. Выбранные параметры сохранены.';
    $('retry-quote').hidden = false;
    syncMobileOrder();
  }
}
function summary() {
  const configuration = selection();
  saveSelection();
  $('share-message').textContent = '';
  $('share-selection').hidden = model.id === 'other';
  $('retry-quote').hidden = true;
  $('selection').textContent = describeConfiguration(configuration);
  if (model.id === 'other') {
    ++quoteVersion; currentQuoteRub = null; currentQuoteStatus = 'on_request'; currentPricingAsOf = null; quoteReady = configuration.description.length >= 3;
    $('selection').textContent = configuration.description || 'Укажите товар и нужные параметры.';
    $('price').textContent = 'Цена по запросу';
    $('quote-note').textContent = 'Стоимость и возможность заказа уточним по вашей заявке.';
    $('continue-order').disabled = !quoteReady; $('continue-order').textContent = 'Запросить стоимость';
    syncMobileOrder();
    return;
  }
  if (model.id === 'pixel') {
    const phone = catalog.pixelModels.find(item => item.id === configuration.phone);
    $('pixel-specs').textContent = `${phone.chip} · ${phone.screen} · ${phone.memoryByStorage[configuration.storage]} ГБ оперативной памяти. Оперативная память определяется выбранной версией.`;
  }
  void refreshQuote(configuration);
}
function chipChanged({ resetMemory = false } = {}) {
  const chip = model.chips.find(x => x.id === selectedValue('chip-options'));
  optionButtons('memory-options', chip.memory, x => `${x} ГБ`, summary, {
    preferred: restoredSelection?.memory ?? (resetMemory && chip.memory.includes(16) ? 16 : undefined),
    preserve: !resetMemory && !restoredSelection,
  });
  optionButtons('storage-options', chip.storage, capacity, summary, { preferred: restoredSelection?.storage ?? 256, preserve: false });
  summary();
}
function phoneChanged() {
  const phone = catalog.pixelModels.find(item => item.id === selectedValue('phone-options'));
  optionButtons('pixel-storage-options', phone.storage, capacity, summary, { preferred: restoredSelection?.storage, preserve: false });
  summary();
}
function modelChanged(id) {
  model = catalog.models.find(x => x.id === id) || { id, name: id === 'pixel' ? 'Google Pixel' : 'товар' };
  $('model-name').textContent = model.name;
  $('mac-fields').hidden = !['mini', 'studio'].includes(id);
  $('pixel-fields').hidden = id !== 'pixel';
  $('other-fields').hidden = id !== 'other';
  $('other-description').required = id === 'other';
  $('other-description').disabled = id !== 'other';
  $('price-help').hidden = id === 'other';
  $('studio-note').hidden = model.id !== 'studio';
  $('ethernet-block').hidden = model.id === 'mini';
  document.querySelectorAll('[data-model]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.model === id)));
  if (id === 'other') { summary(); return; }
  if (id === 'pixel') {
    optionButtons('phone-options', catalog.pixelModels, item => item.name, phoneChanged, {
      preserve: !restoredSelection, preferred: restoredSelection?.phone, detail: item => `${item.generation} · ${item.chip} · ${item.screen}`,
    });
    phoneChanged(); return;
  }
  optionButtons('chip-options', model.chips, x => `${x.name} · ${x.cpu} CPU / ${x.gpu} GPU`, chipChanged, { preferred: restoredSelection?.chip, preserve: false });
  optionButtons('ethernet-options', model.ethernet, x => `${x} Гбит/с`, summary, { preferred: restoredSelection?.ethernet, preserve: false });
  chipChanged({ resetMemory: true });
}
function showStep(step) {
  currentStep = step;
  $('configuration').hidden = step !== 'configuration';
  document.querySelector('.models').hidden = step !== 'configuration';
  $('contact-step').hidden = step !== 'contact';
  $('success').hidden = step !== 'success';
  document.querySelectorAll('[data-step]').forEach(item => {
    if (item.dataset.step === step) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
  syncMobileOrder();
}
document.querySelectorAll('[data-model]').forEach(x => x.addEventListener('click', () => { if (model.id !== x.dataset.model) modelChanged(x.dataset.model); }));
$('retry-quote').addEventListener('click', () => { void refreshQuote(selection()); });
$('share-selection').addEventListener('click', async () => {
  saveSelection();
  try { await navigator.clipboard.writeText(location.href); $('share-message').textContent = 'Ссылка скопирована. Она откроет выбранную конфигурацию.'; }
  catch { $('share-message').textContent = 'Выбор сохранён в адресе страницы. Скопируйте его из строки браузера.'; }
});
window.addEventListener('hashchange', () => {
  if (sending) { saveSelection(); return; }
  restoredSelection = readSelection(location.hash);
  modelChanged(restoredSelection?.model || 'mini'); restoredSelection = null;
  showStep('configuration');
});
$('other-description').addEventListener('input', summary);
$('configuration').addEventListener('submit', async e => {
  e.preventDefault();
  if (!quoteReady) return;
  const configuration = selection();
  $('contact-selection').textContent = describeConfiguration(configuration);
  $('contact-price').textContent = priceText(currentQuoteRub);
  $('contact-quote-note').textContent = quoteNote(currentQuoteRub, currentQuoteStatus, currentPricingAsOf);
  $('contact-payment').textContent = `Оплата: ${paymentText()}`;
  showStep('contact');
  $('form-error').hidden = true;
  $('contact-title').focus();
  $('availability').textContent = '';
  $('submit-order').disabled = true;
  try {
    const response = await fetch('api/status', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Status unavailable');
    const status = await response.json();
    if (!status.acceptingOrders) $('availability').textContent = 'Форма пока в режиме просмотра: приём заявок ещё не подключён.';
    $('submit-order').disabled = !status.acceptingOrders;
  } catch { $('availability').textContent = 'Не удалось проверить связь с сервером. Попробуйте отправить заявку.'; $('submit-order').disabled = false; }
});
const focusSelection = () => model.id === 'other' ? $('other-description').focus() : $(model.id === 'pixel' ? 'phone-options' : 'chip-options').querySelector('button[aria-pressed="true"]')?.focus();
$('back').addEventListener('click', () => { if (!sending) { showStep('configuration'); focusSelection(); } });
$('new-order').addEventListener('click', () => {
  $('order').reset(); requestId = crypto.randomUUID(); pendingPayload = null;
  showStep('configuration'); summary(); focusSelection();
});
$('order').addEventListener('submit', async e => {
  e.preventDefault();
  if (sending) return;
  const phone = $('phone').value.replace(/\D/g, '');
  if (!/^(?:7|8)\d{10}$/.test(phone) && !/^\d{10}$/.test(phone)) {
    $('form-error').textContent = 'Укажите российский номер: +7 и ещё 10 цифр.'; $('form-error').hidden = false; $('phone').focus(); return;
  }
  const body = { configuration: selection(), paymentMethod: paymentMethod(), phone: $('phone').value, name: $('customer-name').value, consent: $('consent').checked, website: $('website').value };
  const fingerprint = JSON.stringify(body);
  if (pendingPayload && pendingPayload !== fingerprint) requestId = crypto.randomUUID();
  pendingPayload = fingerprint;
  sending = true; $('submit-order').disabled = true; $('back').disabled = true;
  $('submit-order').textContent = 'Отправляем…'; $('form-error').hidden = true;
  try {
    const response = await fetch('api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId }, body: fingerprint, signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Не удалось отправить заявку. Попробуйте ещё раз.');
    $('order-number').textContent = data.orderId;
    $('success-selection').textContent = describeConfiguration(body.configuration);
    $('success-price').textContent = priceText(data.priceRub, data.priceStatus);
    $('success-quote-note').textContent = quoteNote(data.priceRub, data.priceStatus, data.pricingAsOf);
    showStep('success'); $('success-title').focus();
  } catch (error) {
    $('form-error').textContent = error.name === 'TypeError' || error.name === 'TimeoutError' ? 'Ответ сервера не получен. Нажмите «Отправить заявку» ещё раз — повторная отправка не создаст дубль.' : error.message;
    $('form-error').hidden = false;
  } finally { sending = false; $('submit-order').disabled = false; $('back').disabled = false; $('submit-order').textContent = 'Отправить заявку'; }
});
modelChanged(restoredSelection?.model || 'mini');
restoredSelection = null;
