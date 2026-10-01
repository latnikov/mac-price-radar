const invalid = message => Object.assign(new Error(message), { status: 400 });
export const deliveryNames = { pickup: 'Самовывоз', local: 'Доставка по Нижнему Новгороду', russia: 'Доставка по России' };
export const shipmentNames = { pending: 'Ожидает согласования', confirmed: 'Согласована', shipped: 'Передана перевозчику', delivered: 'Получена', cancelled: 'Отменена' };
export function cleanField(value, max, label) {
  const text = String(value ?? '').trim();
  if (text.length > max || /[\x00-\x1f\x7f]/.test(text)) throw invalid(`Проверьте поле «${label}».`);
  return text;
}
export function normalizeEmail(value) {
  const email = cleanField(value, 254, 'Email').toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('Укажите правильный email.');
  return email;
}
export function normalizeDelivery(input) {
  const method = input.deliveryMethod || 'pickup';
  if (!Object.hasOwn(deliveryNames, method)) throw invalid('Выберите способ получения.');
  const city = method === 'pickup' ? '' : method === 'local' ? 'Нижний Новгород' : cleanField(input.deliveryCity, 100, 'Город');
  if (method === 'russia' && !city) throw invalid('Для доставки по России укажите город.');
  return { method, city, address: method === 'pickup' ? '' : cleanField(input.deliveryAddress, 250, 'Адрес или пункт выдачи'),
    feeKopecks: method === 'pickup' ? 0 : null, state: method === 'pickup' ? 'confirmed' : 'pending', carrier: '', tracking: '', estimatedDate: '' };
}
export function rublesToKopecks(input, { optional = false } = {}) {
  const text = String(input ?? '').trim().replace(',', '.');
  if (!text && optional) return null;
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(text)) throw invalid('Укажите сумму в рублях с точностью до копеек.');
  const [whole, fractional = ''] = text.split('.');
  return Number(whole) * 100 + Number(fractional.padEnd(2, '0'));
}
