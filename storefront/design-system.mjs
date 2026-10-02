// Shared visual language for the shop, customer access and staff workspace.
import { readFileSync } from 'node:fs';

const css = name => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\s+/g, ' ').trim();
export const menuCss = css('./menu.css');
export const shopCss = css('./shop.css');
export const formsCss = css('./forms.css');
export const layoutCss = css('./layout.css');
export const brandCss = css('./brand.css');
export const productArtCss = css('./product-art.css');
export const storiesCss = css('./stories.css');
export const catalogCss = css('./catalog.css');
export const accessCss = css('./access.css');
export const productCss = css('./product.css');
export const responsiveCss = css('./responsive.css');
export const workspaceCss = css('./workspace.css');
export const parserCss = css('./parser.css');

const paths = {
  search: '<circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/>',
  heart: '<path d="M20 4a5 5 0 0 0-8 2 5 5 0 0 0-8-2C-2 10 12 21 12 21S26 10 20 4Z"/>',
  cart: '<path d="M2 3h3l3 12h10l3-9H6"/><circle cx="9" cy="20" r="1"/><circle cx="18" cy="20" r="1"/>',
  user: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="9" r="3"/><path d="M5 19a7 7 0 0 1 14 0"/>',

  overview: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  products: '<rect x="4" y="3" width="16" height="13" rx="2"/><path d="M2 20h20M9 16v4m6-4v4"/>',
  orders: '<rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 5V3h6v2M9 11h6m-6 5h6"/>',
  chats: '<path d="M21 11a8 8 0 0 1-8 8H6l-4 3V11a9 9 0 0 1 19 0Z"/><path d="M7 10h10M7 14h6"/>',
  people: '<circle cx="9" cy="7" r="3"/><path d="M2 21v-3a7 7 0 0 1 14 0v3M17 4a3 3 0 0 1 0 6m2 5a5 5 0 0 1 3 5"/>',
  sales: '<path d="M4 20V10m8 10V4m8 16v-7M2 22h20"/>',
  deals: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M8 7V3h8v4M2 12h20m-12 0v3h4v-3"/>',
  tasks: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m7 12 3 3 7-7"/>',
  parser: '<path d="M3 5h18M3 12h18M3 19h18M8 3v18m8-18v18"/>',
  integrations: '<path d="M8 2v5m8-5v5M6 7h12v4a6 6 0 0 1-12 0V7Zm6 10v5"/>',
  system: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
};
export const icon = name => `<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.arrow}</svg>`;
export const staffNavigation = [
  ['/crm', 'Обзор', 'overview'], ['/crm/desk', 'Переписка', 'chats'],
  ['/crm/contacts', 'Клиенты', 'people'], ['/crm/orders', 'Заказы', 'orders'],
  ['/crm/deals', 'Сделки', 'deals'], ['/crm/tasks', 'Задачи', 'tasks'],
  ['/crm/sales', 'Метрики', 'sales'], ['/crm/products', 'Каталог', 'products'],
  ['/crm/parser/', 'Парсер цен', 'parser'], ['/crm/integrations', 'Интеграции', 'integrations'],
  ['/crm/system', 'Система', 'system'],
];
