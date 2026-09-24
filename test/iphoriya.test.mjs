import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchIphoriyaOffers } from '../scripts/iphoriya.mjs';

const categories = [
  { id: 54, slug: 'macbook-air', count: 1 },
  { id: 55, slug: 'macbook-pro', count: 1 },
  { id: 1292, slug: 'macbook-neo', count: 0 },
];
const product = (id, name, slug, price, stock = true) => ({ id, name, permalink: `https://iphoriya.ru/product/${slug}`, prices: { price: String(price), currency_code: 'RUB', currency_minor_unit: 0 }, is_in_stock: stock });
const products = [
  product(1, 'Apple MacBook Air 13 Early 2026 MDHE4 M5 10-core, GPU 8-core, 16GB, 512GB, Midnight', 'apple-macbook-air-13-early-2026-mdhe4-m5-10-core-gpu-8-core-16gb-512gb-midnight', 135900),
  product(2, 'Apple MacBook Pro 14 Late 2025 MDE04 M5 10-core, GPU 10-core, 16GB, 512GB, Space Black', 'apple-macbook-pro-14-late-2025-mde04-m5-10-core-gpu-10-core-16gb-512gb-space-black', 169900, false),
];
const response = (data, headers = {}) => new Response(JSON.stringify(data), { headers });

test('loads every current MacBook from the WooCommerce catalogue with price and stock', async () => {
  const fetched = [];
  const result = await fetchIphoriyaOffers({ pageSize: 1, fetchPage: async url => {
    fetched.push(url);
    if (url.includes('/categories')) return response(categories);
    const page = Number(new URL(url).searchParams.get('page'));
    return response([products[page - 1]], { 'x-wp-total': '2', 'x-wp-totalpages': '2' });
  } });
  assert.equal(fetched.length, 3);
  assert.equal(result.offers.length, 2);
  assert.equal(result.offers[0].price, 135900);
  assert.equal(result.offers[0].stock, 'InStock');
  assert.equal(result.offers[1].stock, 'OutOfStock');
  assert.equal(result.stats.catalogProducts, 2);
});

test('rejects incomplete, duplicated, malformed, and unsafe catalogues', async () => {
  const incomplete = async url => url.includes('/categories') ? response(categories) : response([products[0]], { 'x-wp-total': '2', 'x-wp-totalpages': '1' });
  await assert.rejects(fetchIphoriyaOffers({ fetchPage: incomplete }), /received 1 of 2/);
  const duplicated = async url => url.includes('/categories') ? response(categories) : response([products[0], products[0]], { 'x-wp-total': '2', 'x-wp-totalpages': '1' });
  await assert.rejects(fetchIphoriyaOffers({ fetchPage: duplicated }), /duplicate product id/);
  const malformed = async url => url.includes('/categories') ? response(categories) : response([{ ...products[0], prices: { price: 'free', currency_code: 'RUB', currency_minor_unit: 0 } }, products[1]], { 'x-wp-total': '2', 'x-wp-totalpages': '1' });
  await assert.rejects(fetchIphoriyaOffers({ fetchPage: malformed }), /invalid price/);
  const unsafe = async url => url.includes('/categories') ? response(categories) : response([{ ...products[0], permalink: 'https://evil.test/product/macbook' }, products[1]], { 'x-wp-total': '2', 'x-wp-totalpages': '1' });
  await assert.rejects(fetchIphoriyaOffers({ fetchPage: unsafe }), /unsafe product URL/);
});
