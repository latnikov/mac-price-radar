import { catalog, capacity, describeConfiguration } from '/catalog.mjs';
const $ = id => document.getElementById(id);
let model = catalog.models[0];
let requestId = crypto.randomUUID();
let pendingPayload = null;
let sending = false;
let currentQuoteRub = null;
let quoteVersion = 0;
const formatPublicPrice = price => `${Number(price).toLocaleString('ru-RU')} ₽`;
const selectedValue = id => $(id).querySelector('[aria-pressed="true"]')?.dataset.value;
const setStepPricesLoading = () => document.querySelectorAll('.option-step').forEach(step => {
  step.textContent = 'Считаем цену…';
  step.closest('button').classList.remove('is-upgrade', 'is-downgrade');
});
const showStepPrices = (stepPrices, currentPrice) => {
  for (const [group, prices] of Object.entries(stepPrices)) {
    $(`${group}-options`)?.querySelectorAll('button').forEach(button => {
      const price = prices[button.dataset.value];
      const step = button.querySelector('.option-step');
      if (!step || !Number.isInteger(price)) return;
      step.textContent = price === 0
        ? formatPublicPrice(currentPrice)
        : `${price > 0 ? '+' : '−'} ${formatPublicPrice(Math.abs(price))}`;
      button.classList.toggle('is-upgrade', price > 0);
      button.classList.toggle('is-downgrade', price < 0);
    });
  }
};
const optionButtons = (id, values, label, onChange, { preferred, preserve = true } = {}) => {
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
    const name = document.createElement('span');
    name.className = 'option-name';
    name.textContent = label(item.value);
    const step = document.createElement('span');
    step.className = 'option-step';
    step.textContent = 'Считаем цену…';
    button.append(name, step);
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-pressed') === 'true') return;
      container.querySelectorAll('button').forEach(other => {
        const active = other === button;
        other.setAttribute('aria-pressed', String(active));
        other.setAttribute('aria-checked', String(active));
      });
      onChange();
    });
    return button;
  });
  container.replaceChildren(...buttons);
};
function selection() {
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
  $('continue-order').disabled = true;
  $('price').textContent = 'Считаем предварительную цену…';
  setStepPricesLoading();
  try {
    const query = new URLSearchParams(Object.entries(configuration).map(([key, value]) => [key, String(value)]));
    const response = await fetch(`/api/quote?${query}`, { signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Не удалось рассчитать цену.');
    if (version !== quoteVersion) return;
    currentQuoteRub = data.priceRub;
    showStepPrices(data.stepPricesRub, currentQuoteRub);
    $('price').textContent = `Предварительная цена: ${formatPublicPrice(currentQuoteRub)}`;
    $('continue-order').disabled = false;
  } catch (error) {
    if (version !== quoteVersion) return;
    document.querySelectorAll('.option-step').forEach(step => { step.textContent = 'Доплата недоступна'; });
    $('price').textContent = error.name === 'TimeoutError' ? 'Расчёт цены занял слишком много времени. Попробуйте ещё раз.' : error.message;
  }
}
function summary() {
  const configuration = selection();
  $('selection').textContent = describeConfiguration(configuration);
  void refreshQuote(configuration);
}
function chipChanged({ resetMemory = false } = {}) {
  const chip = model.chips.find(x => x.id === selectedValue('chip-options'));
  optionButtons('memory-options', chip.memory, x => `${x} ГБ`, summary, {
    preferred: resetMemory && chip.memory.includes(16) ? 16 : undefined,
    preserve: !resetMemory,
  });
  optionButtons('storage-options', chip.storage, capacity, summary, { preferred: 256, preserve: false });
  summary();
}
function modelChanged(id) {
  model = catalog.models.find(x => x.id === id);
  $('model-name').textContent = model.name;
  $('studio-note').hidden = model.id !== 'studio';
  $('ethernet-block').hidden = model.id === 'mini';
  document.querySelectorAll('[data-model]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.model === id)));
  optionButtons('chip-options', model.chips, x => `${x.name} · ${x.cpu} CPU / ${x.gpu} GPU`, chipChanged, { preserve: false });
  optionButtons('ethernet-options', model.ethernet, x => `${x} Гбит/с`, summary, { preserve: false });
  chipChanged({ resetMemory: true });
}
function showStep(step) {
  $('configuration').hidden = step !== 'configuration';
  document.querySelector('.models').hidden = step !== 'configuration';
  $('contact-step').hidden = step !== 'contact';
  $('success').hidden = step !== 'success';
}
document.querySelectorAll('[data-model]').forEach(x => x.addEventListener('click', () => modelChanged(x.dataset.model)));
$('configuration').addEventListener('submit', async e => {
  e.preventDefault();
  if (!Number.isInteger(currentQuoteRub)) return;
  const configuration = selection();
  $('contact-selection').textContent = describeConfiguration(configuration);
  $('contact-price').textContent = `Предварительная цена: ${formatPublicPrice(currentQuoteRub)}`;
  showStep('contact');
  $('contact-title').focus();
  $('availability').textContent = '';
  try {
    const response = await fetch('/api/status');
    const status = await response.json();
    if (!status.acceptingOrders) $('availability').textContent = 'Форма пока в режиме просмотра: приём заявок ещё не подключён.';
    $('submit-order').disabled = !status.acceptingOrders;
  } catch { $('availability').textContent = 'Не удалось проверить связь с сервером. Попробуйте отправить заявку.'; $('submit-order').disabled = false; }
});
$('back').addEventListener('click', () => { if (!sending) { showStep('configuration'); $('chip-options').querySelector('button')?.focus(); } });
$('new-order').addEventListener('click', () => {
  $('order').reset(); requestId = crypto.randomUUID(); pendingPayload = null;
  showStep('configuration'); $('chip-options').querySelector('button')?.focus();
});
$('order').addEventListener('submit', async e => {
  e.preventDefault();
  if (sending) return;
  const phone = $('phone').value.replace(/\D/g, '');
  if (!/^(?:7|8)\d{10}$/.test(phone) && !/^\d{10}$/.test(phone)) {
    $('form-error').textContent = 'Укажите российский номер: +7 и ещё 10 цифр.'; $('form-error').hidden = false; $('phone').focus(); return;
  }
  const body = { configuration: selection(), phone: $('phone').value, name: $('customer-name').value, consent: $('consent').checked, website: $('website').value };
  const fingerprint = JSON.stringify(body);
  if (pendingPayload && pendingPayload !== fingerprint) requestId = crypto.randomUUID();
  pendingPayload = fingerprint;
  sending = true; $('submit-order').disabled = true; $('back').disabled = true;
  $('submit-order').textContent = 'Отправляем…'; $('form-error').hidden = true;
  try {
    const response = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId }, body: fingerprint, signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Не удалось отправить заявку. Попробуйте ещё раз.');
    $('order-number').textContent = data.orderId;
    $('success-selection').textContent = describeConfiguration(body.configuration);
    $('success-price').textContent = `Предварительная цена: ${formatPublicPrice(data.priceRub ?? currentQuoteRub)}`;
    showStep('success'); $('success-title').focus();
  } catch (error) {
    $('form-error').textContent = error.name === 'TypeError' || error.name === 'TimeoutError' ? 'Ответ сервера не получен. Нажмите «Отправить заявку» ещё раз — повторная отправка не создаст дубль.' : error.message;
    $('form-error').hidden = false;
  } finally { sending = false; $('submit-order').disabled = false; $('back').disabled = false; $('submit-order').textContent = 'Отправить заявку'; }
});
modelChanged('mini');
