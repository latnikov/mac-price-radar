// ============================================================
// BIGGEEK — справочник артикул → слаг
// ============================================================
var SLUGS_BIGGEEK = {

  // MacBook Air 13" M2 (2022) — 8GPU / 16GB / 256GB
  'MC7X4': 'apple-macbook-air-13-retina-z160000au-midnight-m2-8-core-gpu-8-core-16-gb-256-gb',
  'MC7W4': 'bg-apple-macbook-air-13-retina-starlight-m2-8-core-gpu-8-core-16-gb-256-gb',
  'MC7U4': 'bg-apple-macbook-air-13-retina-space-gray-m2-8-core-gpu-8-core-16-gb-256-gb',
  'MC7V4': 'bg-apple-macbook-air-13-retina-silver-m2-8-core-gpu-8-core-16-gb-256-gb',

  // MacBook Air 13" M4 (2025) — 10GPU / 16GB / 512GB
  'MW133': 'noutbuk-apple-macbook-air-13-mw133-m4-10-core-gpu-10-core-16gb-512gb-temnaa-noc-midnight',
  'MW103': 'noutbuk-apple-macbook-air-13-mw103-m4-10-core-gpu-10-core-16gb-512gb-siausaa-zvezda-starlight',
  'MC6U4': 'noutbuk-apple-macbook-air-13-mc6u4-m4-10-core-gpu-10-core-16gb-512gb-goluboe-nebo-sky-blue',
  'MW0X3': 'noutbuk-apple-macbook-air-13-mw0x3-m4-10-core-gpu-10-core-16gb-512gb-serebristyj-silver',
  // MacBook Air 13" M4 (2025) — 10GPU / 24GB / 512GB
  'MC6C4': 'noutbuk-apple-macbook-air-13-mc6c4-m4-10-core-gpu-10-core-24gb-512gb-temnaa-noc-midnight',
  'MC6A4': 'noutbuk-apple-macbook-air-13-mc6a4-m4-10-core-gpu-10-core-24gb-512gb-siausaa-zvezda-starlight',
  'MC6V4': 'noutbuk-apple-macbook-air-13-mc6v4-m4-10-core-gpu-10-core-24gb-512gb-goluboe-nebo-sky-blue',
  'MC654': 'noutbuk-apple-macbook-air-13-mc654-m4-10-core-gpu-10-core-24gb-512gb-serebristyj-silver',

  // MacBook Air 13" M5 (2026) — 8GPU / 16GB / 512GB
  'MDHE4': 'noutbuk-apple-macbook-air-13-mdhe4-m5-10-core-gpu-8-core-16gb-512gb-temnaa-noc-midnight',
  'MDHA4': 'noutbuk-apple-macbook-air-13-mdha4-m5-10-core-gpu-8-core-16gb-512gb-siausaa-zvezda-starlight',
  'MDHH4': 'noutbuk-apple-macbook-air-13-mdhh4-m5-10-core-gpu-8-core-16gb-512gb-goluboe-nebo-sky-blue',
  'MDH74': 'noutbuk-apple-macbook-air-13-mdh74-m5-10-core-gpu-8-core-16gb-512gb-serebristyj-silver',
  // MacBook Air 13" M5 (2026) — 10GPU / 16GB / 1TB
  'MDHF4': 'noutbuk-apple-macbook-air-13-mdhf4-m5-10-core-gpu-10-core-16gb-1tb-temnaa-noc-midnight',
  'MDHC4': 'noutbuk-apple-macbook-air-13-mdhc4-m5-10-core-gpu-10-core-16gb-1tb-siausaa-zvezda-starlight',
  'MDHJ4': 'noutbuk-apple-macbook-air-13-mdhj4-m5-10-core-gpu-10-core-16gb-1tb-goluboe-nebo-sky-blue',
  'MDH84': 'noutbuk-apple-macbook-air-13-mdh84-m5-10-core-gpu-10-core-16gb-1tb-serebristyj-silver',
  // MacBook Air 13" M5 (2026) — 10GPU / 24GB / 1TB
  'MDHG4': 'noutbuk-apple-macbook-air-13-mdhg4-m5-10-core-gpu-10-core-24gb-1tb-temnaa-noc-midnight',
  'MDHD4': 'noutbuk-apple-macbook-air-13-mdhd4-m5-10-core-gpu-10-core-24gb-1tb-siausaa-zvezda-starlight',
  'MDHK4': 'noutbuk-apple-macbook-air-13-mdhk4-m5-10-core-gpu-10-core-24gb-1tb-goluboe-nebo-sky-blue',
  'MDH94': 'noutbuk-apple-macbook-air-13-mdh94-m5-10-core-gpu-10-core-24gb-1tb-serebristyj-silver',

  // MacBook Air 15" M4 (2025) — 10GPU / 16GB / 512GB
  'MW1M3': 'noutbuk-apple-macbook-air-15-mw1m3-m4-10-core-gpu-10-core-16gb-512gb-temnaa-noc-midnight',
  'MW1K3': 'noutbuk-apple-macbook-air-15-mw1k3-m4-10-core-gpu-10-core-16gb-512gb-siausaa-zvezda-starlight',
  'MC7C4': 'noutbuk-apple-macbook-air-15-mc7c4-m4-10-core-gpu-10-core-16gb-512gb-goluboe-nebo-sky-blue',
  'MW1H3': 'noutbuk-apple-macbook-air-15-mw1h3-m4-10-core-gpu-10-core-16gb-512gb-serebristyj-silver',
  // MacBook Air 15" M4 (2025) — 10GPU / 24GB / 512GB
  'MC6L4': 'noutbuk-apple-macbook-air-15-mc6l4-m4-10-core-gpu-10-core-24gb-512gb-temnaa-noc-midnight',
  'MC6K4': 'noutbuk-apple-macbook-air-15-mc6k4-m4-10-core-gpu-10-core-24gb-512gb-siausaa-zvezda-starlight',
  'MC7D4': 'noutbuk-apple-macbook-air-15-mc7d4-m4-10-core-gpu-10-core-24gb-512gb-goluboe-nebo-sky-blue',
  'MC6J4': 'noutbuk-apple-macbook-air-15-mc6j4-m4-10-core-gpu-10-core-24gb-512gb-serebristyj-silver',

  // MacBook Air 15" M5 (2026) — 10GPU / 16GB / 512GB
  'MDVH4': 'noutbuk-apple-macbook-air-15-mdvh4-m5-10-core-gpu-10-core-16gb-512gb-temnaa-noc-midnight',
  'MDVD4': 'noutbuk-apple-macbook-air-15-mdvd4-m5-10-core-gpu-10-core-16gb-512gb-siausaa-zvezda-starlight',
  'MDVQ4': 'noutbuk-apple-macbook-air-15-mdvq4-m5-10-core-gpu-10-core-16gb-512gb-goluboe-nebo-sky-blue',
  'MDV94': 'noutbuk-apple-macbook-air-15-mdv94-m5-10-core-gpu-10-core-16gb-512gb-serebristyj-silver',
  // MacBook Air 15" M5 (2026) — 10GPU / 16GB / 1TB
  'MDVK4': 'noutbuk-apple-macbook-air-15-mdvk4-m5-10-core-gpu-10-core-16gb-1tb-temnaa-noc-midnight',
  'MDVE4': 'noutbuk-apple-macbook-air-15-mdve4-m5-10-core-gpu-10-core-16gb-1tb-siausaa-zvezda-starlight',
  'MDVT4': 'noutbuk-apple-macbook-air-15-mdvt4-m5-10-core-gpu-10-core-16gb-1tb-goluboe-nebo-sky-blue',
  'MDVA4': 'noutbuk-apple-macbook-air-15-mdva4-m5-10-core-gpu-10-core-16gb-1tb-serebristyj-silver',
  // MacBook Air 15" M5 (2026) — 10GPU / 24GB / 1TB
  'MDVN4': 'noutbuk-apple-macbook-air-15-mdvn4-m5-10-core-gpu-10-core-24gb-1tb-temnaa-noc-midnight',
  'MDVF4': 'noutbuk-apple-macbook-air-15-mdvf4-m5-10-core-gpu-10-core-24gb-1tb-siausaa-zvezda-starlight',
  'MDVU4': 'noutbuk-apple-macbook-air-15-mdvu4-m5-10-core-gpu-10-core-24gb-1tb-goluboe-nebo-sky-blue',
  'MDVC4': 'noutbuk-apple-macbook-air-15-mdvc4-m5-10-core-gpu-10-core-24gb-1tb-serebristyj-silver',

  // MacBook Pro 14" M4 base (2024) — 10GPU / 16GB / 512GB
  'MW2U3': 'noutbuk-apple-macbook-pro-14-mw2u3-m4-10-core-gpu-10-core-16gb-512gb-cernyj-kosmos-space-black',
  'MW2W3': 'noutbuk-apple-macbook-pro-14-mw2w3-m4-10-core-gpu-10-core-16gb-512gb-serebristyj-silver',

  // MacBook Pro 14" M5 base (2025) — 10GPU / 16GB / 512GB
  'MDE04': 'noutbuk-apple-macbook-pro-14-mde04-m5-10-core-gpu-10-core-16gb-512gb-cernyj-kosmos-space-black',
  'MDE44': 'noutbuk-apple-macbook-pro-14-mde44-m5-10-core-gpu-10-core-16gb-512gb-serebristyj-silver',
  // MacBook Pro 14" M5 base (2025) — 10GPU / 16GB / 1TB
  'MDE14': 'noutbuk-apple-macbook-pro-14-mde14-m5-10-core-gpu-10-core-16gb-1tb-cernyj-kosmos-space-black',
  'MDE54': 'noutbuk-apple-macbook-pro-14-mde54-m5-10-core-gpu-10-core-16gb-1tb-serebristyj-silver',
  // MacBook Pro 14" M5 base (2025) — 10GPU / 24GB / 1TB
  'MDE34': 'noutbuk-apple-macbook-pro-14-mde34-m5-10-core-gpu-10-core-24gb-1tb-cernyj-kosmos-space-black',
  'MDE64': 'noutbuk-apple-macbook-pro-14-mde64-m5-10-core-gpu-10-core-24gb-1tb-serebristyj-silver',

  // MacBook Pro 14" M4 Pro (2024) — 16GPU / 24GB / 512GB
  'MX2H3': 'noutbuk-apple-macbook-pro-14-mx2h3-m4-pro-12-core-gpu-16-core-24gb-512gb-cernyj-kosmos-space-black',
  'MX2E3': 'noutbuk-apple-macbook-pro-14-mx2e3-m4-pro-12-core-gpu-16-core-24gb-512gb-serebristyj-silver',

  // MacBook Pro 14" M5 Pro (2026) — 16GPU / 24GB / 1TB
  'MGDR4': 'noutbuk-apple-macbook-pro-14-mgdr4-m5-pro-15-core-gpu-16-core-24gb-1tb-cernyj-kosmos-space-black',
  'MGDN4': 'noutbuk-apple-macbook-pro-14-mgdn4-m5-pro-15-core-gpu-16-core-24gb-1tb-serebristyj-silver',
  // MacBook Pro 14" M5 Pro (2026) — 20GPU / 24GB / 2TB
  'MGDT4': 'noutbuk-apple-macbook-pro-14-mgdt4-m5-pro-18-core-gpu-20-core-24gb-2tb-cernyj-kosmos-space-black',
  'MGDP4': 'noutbuk-apple-macbook-pro-14-mgdp4-m5-pro-18-core-gpu-20-core-24gb-2tb-serebristyj-silver'
};

// ============================================================
// IPHORIYA — справочник артикул → слаг
// Артикулы MBA 13 M2, MBP 14 M4 base, MBP 14 M4 Pro
// на сайте iphoriya.ru не представлены.
// ============================================================
var SLUGS_IPHORIYA = {

  // MacBook Air 13" M4 (2025) — 10GPU / 16GB / 512GB
  'MW133': 'apple-macbook-air-13-early-2025-mw133-m4-10-core-10-core-16gb-512gb-midnight',
  'MW103': 'apple-macbook-air-13-early-2025-mw103-m4-10-core-10-core-16gb-512gb-starlight',
  'MC6U4': 'apple-macbook-air-13-early-2025-mc6u4-m4-10-core-10-core-16gb-512gb-sky-blue',
  'MW0X3': 'apple-macbook-air-13-early-2025-mw0x3-m4-10-core-10-core-16gb-512gb-silver',
  // MacBook Air 13" M4 (2025) — 10GPU / 24GB / 512GB
  'MC6C4': 'apple-macbook-air-13-early-2025-mc6c4-m4-10-core-10-core-24gb-512gb-midnight',
  'MC6A4': 'apple-macbook-air-13-early-2025-mc6a4-m4-10-core-10-core-24gb-512gb-starlight',
  'MC6V4': 'apple-macbook-air-13-early-2025-mc6v4-m4-10-core-10-core-24gb-512gb-sky-blue',
  'MC654': 'apple-macbook-air-13-early-2025-mc654-m4-10-core-10-core-24gb-512gb-silver',

  // MacBook Air 13" M5 (2026) — 8GPU / 16GB / 512GB
  'MDHE4': 'apple-macbook-air-13-early-2026-mdhe4-m5-10-core-gpu-8-core-16gb-512gb-midnight',
  'MDHA4': 'apple-macbook-air-13-early-2026-mdha4-m5-10-core-gpu-8-core-16gb-512gb-starlight',
  'MDHH4': 'apple-macbook-air-13-early-2026-mdhh4-m5-10-core-gpu-8-core-16gb-512gb-sky-blue',
  'MDH74': 'apple-macbook-air-13-early-2026-mdh74-m5-10-core-gpu-8-core-16gb-512gb-silver',
  // MacBook Air 13" M5 (2026) — 10GPU / 16GB / 1TB
  'MDHF4': 'apple-macbook-air-13-early-2026-mdhf4-m5-10-core-gpu-10-core-16gb-1tb-midnight',
  'MDHC4': 'apple-macbook-air-13-early-2026-mdhc4-m5-10-core-gpu-10-core-16gb-1tb-starlight',
  'MDHJ4': 'apple-macbook-air-13-early-2026-mdhj4-m5-10-core-gpu-10-core-16gb-1tb-sky-blue',
  'MDH84': 'apple-macbook-air-13-early-2026-mdh84-m5-10-core-gpu-10-core-16gb-1tb-silver',
  // MacBook Air 13" M5 (2026) — 10GPU / 24GB / 1TB
  'MDHG4': 'apple-macbook-air-13-early-2026-mdhg4-m5-10-core-gpu-10-core-24gb-1tb-midnight',
  'MDHD4': 'apple-macbook-air-13-early-2026-mdhd4-m5-10-core-gpu-10-core-24gb-1tb-starlight',
  'MDHK4': 'apple-macbook-air-13-early-2026-mdhk4-m5-10-core-gpu-10-core-24gb-1tb-sky-blue',
  'MDH94': 'apple-macbook-air-13-early-2026-mdh94-m5-10-core-gpu-10-core-24gb-1tb-silver',

  // MacBook Air 15" M4 (2025) — 10GPU / 16GB / 512GB
  'MW1M3': 'apple-macbook-air-15-early-2025-mw1m3-m4-10-core-10-core-16gb-512gb-midnight',
  'MW1K3': 'apple-macbook-air-15-early-2025-mw1k3-m4-10-core-10-core-16gb-512gb-starlight',
  'MC7C4': 'apple-macbook-air-15-early-2025-mc7c4-m4-10-core-10-core-16gb-512gb-sky-blue',
  'MW1H3': 'apple-macbook-air-15-early-2025-mw1h3-m4-10-core-10-core-16gb-512gb-silver',
  // MacBook Air 15" M4 (2025) — 10GPU / 24GB / 512GB
  'MC6L4': 'apple-macbook-air-15-early-2025-mc6l4-m4-10-core-10-core-24gb-512gb-midnight',
  'MC6K4': 'apple-macbook-air-15-early-2025-mc6k4-m4-10-core-10-core-24gb-512gb-starlight',
  'MC7D4': 'apple-macbook-air-15-early-2025-mc7d4-m4-10-core-10-core-24gb-512gb-sky-blue',
  'MC6J4': 'apple-macbook-air-15-early-2025-mc6j4-m4-10-core-10-core-24gb-512gb-silver',

  // MacBook Air 15" M5 (2026) — 10GPU / 16GB / 512GB
  'MDVH4': 'apple-macbook-air-15-early-2026-mdvh4-m5-10-core-gpu-10-core-16gb-512gb-midnight',
  'MDVD4': 'apple-macbook-air-15-early-2026-mdvd4-m5-10-core-gpu-10-core-16gb-512gb-starlight',
  'MDVQ4': 'apple-macbook-air-15-early-2026-mdvq4-m5-10-core-gpu-10-core-16gb-512gb-sky-blue',
  'MDV94': 'apple-macbook-air-15-early-2026-mdv94-m5-10-core-gpu-10-core-16gb-512gb-silver',
  // MacBook Air 15" M5 (2026) — 10GPU / 16GB / 1TB
  'MDVK4': 'apple-macbook-air-15-early-2026-mdvk4-m5-10-core-gpu-10-core-16gb-1tb-midnight',
  'MDVE4': 'apple-macbook-air-15-early-2026-mdve4-m5-10-core-gpu-10-core-16gb-1tb-starlight',
  'MDVT4': 'apple-macbook-air-15-early-2026-mdvt4-m5-10-core-gpu-10-core-16gb-1tb-sky-blue',
  'MDVA4': 'apple-macbook-air-15-early-2026-mdva4-m5-10-core-gpu-10-core-16gb-1tb-silver',
  // MacBook Air 15" M5 (2026) — 10GPU / 24GB / 1TB
  'MDVN4': 'apple-macbook-air-15-early-2026-mdvn4-m5-10-core-gpu-10-core-24gb-1tb-midnight',
  'MDVF4': 'apple-macbook-air-15-early-2026-mdvf4-m5-10-core-gpu-10-core-24gb-1tb-starlight',
  'MDVU4': 'apple-macbook-air-15-early-2026-mdvu4-m5-10-core-gpu-10-core-24gb-1tb-sky-blue',
  'MDVC4': 'apple-macbook-air-15-early-2026-mdvc4-m5-10-core-gpu-10-core-24gb-1tb-silver',

  // MacBook Pro 14" M5 base (2025) — 10GPU / 16GB / 512GB
  'MDE04': 'apple-macbook-pro-14-late-2025-mde04-m5-10-core-gpu-10-core-16gb-512gb-space-black',
  'MDE44': 'apple-macbook-pro-14-late-2025-mde44-m5-10-core-gpu-10-core-16gb-512gb-silver',
  // MacBook Pro 14" M5 base (2025) — 10GPU / 16GB / 1TB
  'MDE14': 'apple-macbook-pro-14-late-2025-mde14-m5-10-core-gpu-10-core-16gb-1tb-space-black',
  'MDE54': 'apple-macbook-pro-14-late-2025-mde54-m5-10-core-gpu-10-core-16gb-1tb-silver',
  // MacBook Pro 14" M5 base (2025) — 10GPU / 24GB / 1TB
  'MDE34': 'apple-macbook-pro-14-late-2025-mde34-m5-10-core-gpu-10-core-24gb-1tb-space-black',
  'MDE64': 'apple-macbook-pro-14-late-2025-mde64-m5-10-core-gpu-10-core-24gb-1tb-silver',

  // MacBook Pro 14" M5 Pro (2026) — 16GPU / 24GB / 1TB
  'MGDR4': 'apple-macbook-pro-14-early-2026-mgdr4-m5-pro-15-core-gpu-16-core-24gb-1tb-space-black',
  'MGDN4': 'apple-macbook-pro-14-early-2026-mgdn4-m5-pro-15-core-gpu-16-core-24gb-1tb-silver',
  // MacBook Pro 14" M5 Pro (2026) — 20GPU / 24GB / 2TB
  'MGDT4': 'apple-macbook-pro-14-early-2026-mgdt4-m5-pro-18-core-gpu-20-core-24gb-2tb-space-black',
  'MGDP4': 'apple-macbook-pro-14-early-2026-mgdp4-m5-pro-18-core-gpu-20-core-24gb-2tb-silver'
};

// ============================================================
// APPLEINSIDER — справочник артикул → {страница, описание}
//
// Описания взяты напрямую с prices.appleinsider.com:
//   Air M4: "M4, 10C GPU, 16GB, 512GB, Midnight"   (без слова Air)
//   Air M5: "M5 Air, 8C GPU, 16GB, 512GB, Midnight" (со словом Air)
//   Pro base: "M5, 16GB, 512GB, Standard Display, Space Black"
//   Pro Pro:  "M5 Pro, 15C CPU, 16C GPU, 24GB, 1TB, Standard Display, Space Black"
//
// Столбец D = минимальная цена в USD (число).
// ============================================================
var AI_ARTICLES = {

  // ── MacBook Air 13" M4 (2025) ─────────────────────────────
  'MW133': {page: 'macbook-air-13-inch-m4', desc: 'M4, 10C GPU, 16GB, 512GB, Midnight'},
  'MW103': {page: 'macbook-air-13-inch-m4', desc: 'M4, 10C GPU, 16GB, 512GB, Starlight'},
  'MC6U4': {page: 'macbook-air-13-inch-m4', desc: 'M4, 10C GPU, 16GB, 512GB, Sky Blue'},
  'MW0X3': {page: 'macbook-air-13-inch-m4', desc: 'M4, 10C GPU, 16GB, 512GB, Silver'},
  'MC6C4': {page: 'macbook-air-13-inch-m4', desc: 'M4, 10C GPU, 24GB, 512GB, Midnight'},
  'MC6A4': {page: 'macbook-air-13-inch-m4', desc: 'M4, 10C GPU, 24GB, 512GB, Starlight'},
  'MC6V4': {page: 'macbook-air-13-inch-m4', desc: 'M4, 10C GPU, 24GB, 512GB, Sky Blue'},
  'MC654': {page: 'macbook-air-13-inch-m4', desc: 'M4, 10C GPU, 24GB, 512GB, Silver'},

  // ── MacBook Air 13" M5 (2026) ─────────────────────────────
  'MDHE4': {page: 'macbook-air-13-inch-m5', desc: 'M5 Air, 8C GPU, 16GB, 512GB, Midnight'},
  'MDHA4': {page: 'macbook-air-13-inch-m5', desc: 'M5 Air, 8C GPU, 16GB, 512GB, Starlight'},
  'MDHH4': {page: 'macbook-air-13-inch-m5', desc: 'M5 Air, 8C GPU, 16GB, 512GB, Sky Blue'},
  'MDH74': {page: 'macbook-air-13-inch-m5', desc: 'M5 Air, 8C GPU, 16GB, 512GB, Silver'},
  'MDHF4': {page: 'macbook-air-13-inch-m5', desc: 'M5 Air, 10C GPU, 16GB, 1TB, Midnight'},
  'MDHC4': {page: 'macbook-air-13-inch-m5', desc: 'M5 Air, 10C GPU, 16GB, 1TB, Starlight'},
  'MDHJ4': {page: 'macbook-air-13-inch-m5', desc: 'M5 Air, 10C GPU, 16GB, 1TB, Sky Blue'},
  'MDH84': {page: 'macbook-air-13-inch-m5', desc: 'M5 Air, 10C GPU, 16GB, 1TB, Silver'},
  'MDHG4': {page: 'macbook-air-13-inch-m5', desc: 'M5 Air, 10C GPU, 24GB, 1TB, Midnight'},
  'MDHD4': {page: 'macbook-air-13-inch-m5', desc: 'M5 Air, 10C GPU, 24GB, 1TB, Starlight'},
  'MDHK4': {page: 'macbook-air-13-inch-m5', desc: 'M5 Air, 10C GPU, 24GB, 1TB, Sky Blue'},
  'MDH94': {page: 'macbook-air-13-inch-m5', desc: 'M5 Air, 10C GPU, 24GB, 1TB, Silver'},

  // ── MacBook Air 15" M4 (2025) ─────────────────────────────
  'MW1M3': {page: 'macbook-air-15-inch-m4', desc: 'M4 15", 16GB, 512GB, Midnight'},
  'MW1K3': {page: 'macbook-air-15-inch-m4', desc: 'M4 15", 16GB, 512GB, Starlight'},
  'MC7C4': {page: 'macbook-air-15-inch-m4', desc: 'M4 15", 16GB, 512GB, Sky Blue'},
  'MW1H3': {page: 'macbook-air-15-inch-m4', desc: 'M4 15", 16GB, 512GB, Silver'},
  'MC6L4': {page: 'macbook-air-15-inch-m4', desc: 'M4 15", 24GB, 512GB, Midnight'},
  'MC6K4': {page: 'macbook-air-15-inch-m4', desc: 'M4 15", 24GB, 512GB, Starlight'},
  'MC7D4': {page: 'macbook-air-15-inch-m4', desc: 'M4 15", 24GB, 512GB, Sky Blue'},
  'MC6J4': {page: 'macbook-air-15-inch-m4', desc: 'M4 15" 24GB, 512GB, Silver'},

  // ── MacBook Air 15" M5 (2026) ─────────────────────────────
  'MDVH4': {page: 'macbook-air-15-inch-m5', desc: 'M5 15” Air, 16GB, 512GB, Midnight'},
  'MDVD4': {page: 'macbook-air-15-inch-m5', desc: 'M5 15” Air, 16GB, 512GB, Starlight'},
  'MDVQ4': {page: 'macbook-air-15-inch-m5', desc: 'M5 15” Air, 16GB, 512GB, Sky Blue'},
  'MDV94': {page: 'macbook-air-15-inch-m5', desc: 'M5 15” Air, 16GB, 512GB, Silver'},
  'MDVK4': {page: 'macbook-air-15-inch-m5', desc: 'M5 15” Air, 16GB, 1TB, Midnight'},
  'MDVE4': {page: 'macbook-air-15-inch-m5', desc: 'M5 15” Air, 16GB, 1TB, Starlight'},
  'MDVT4': {page: 'macbook-air-15-inch-m5', desc: 'M5 15” Air, 16GB, 1TB, Sky Blue'},
  'MDVA4': {page: 'macbook-air-15-inch-m5', desc: 'M5 15” Air, 16GB, 1TB, Silver'},
  'MDVN4': {page: 'macbook-air-15-inch-m5', desc: 'M5 15” Air, 24GB, 1TB, Midnight'},
  'MDVF4': {page: 'macbook-air-15-inch-m5', desc: 'M5 15” Air, 24GB, 1TB, Starlight'},
  'MDVU4': {page: 'macbook-air-15-inch-m5', desc: 'M5 15” Air, 24GB, 1TB, Sky Blue'},
  'MDVC4': {page: 'macbook-air-15-inch-m5', desc: 'M5 15” Air, 24GB, 1TB, Silver'},

  // ── MacBook Pro 14" M4 base (2024) ────────────────────────
  'MW2U3': {page: 'macbook-pro-14-inch-m4', desc: 'M4, 16GB, 512GB, Standard Display, Space Black'},
  'MW2W3': {page: 'macbook-pro-14-inch-m4', desc: 'M4, 16GB, 512GB, Standard Display, Silver'},

  // ── MacBook Pro 14" M5 base (2025) ────────────────────────
  'MDE04': {page: 'macbook-pro-14-inch-m5', desc: 'M5, 16GB, 512GB, Standard Display, Space Black'},
  'MDE44': {page: 'macbook-pro-14-inch-m5', desc: 'M5, 16GB, 512GB, Standard Display, Silver'},
  'MDE14': {page: 'macbook-pro-14-inch-m5', desc: 'M5, 16GB, 1TB, Standard Display, Space Black'},
  'MDE54': {page: 'macbook-pro-14-inch-m5', desc: 'M5, 16GB, 1TB, Standard Display, Silver'},
  'MDE34': {page: 'macbook-pro-14-inch-m5', desc: 'M5, 24GB, 1TB, Standard Display, Space Black'},
  'MDE64': {page: 'macbook-pro-14-inch-m5', desc: 'M5, 24GB, 1TB, Standard Display, Silver'},

  // ── MacBook Pro 14" M4 Pro (2024) ─────────────────────────
  'MX2H3': {page: 'macbook-pro-14-inch-m4-pro', desc: 'M4 Pro, 12C CPU, 16C GPU, 24GB, 512GB, Standard Display, Space Black'},
  'MX2E3': {page: 'macbook-pro-14-inch-m4-pro', desc: 'M4 Pro, 12C CPU, 16C GPU, 24GB, 512GB, Standard Display, Silver'},

  // ── MacBook Pro 14" M5 Pro (2026) ─────────────────────────
  'MGDR4': {page: 'macbook-pro-14-inch-m5-pro', desc: 'M5 Pro, 15C CPU, 16C GPU, 24GB, 1TB, Standard Display, Space Black'},
  'MGDN4': {page: 'macbook-pro-14-inch-m5-pro', desc: 'M5 Pro, 15C CPU, 16C GPU, 24GB, 1TB, Standard Display, Silver'},
  'MGDT4': {page: 'macbook-pro-14-inch-m5-pro', desc: 'M5 Pro, 18C CPU, 20C GPU, 24GB, 2TB, Standard Display, Space Black'},
  'MGDP4': {page: 'macbook-pro-14-inch-m5-pro', desc: 'M5 Pro, 18C CPU, 20C GPU, 24GB, 2TB, Standard Display, Silver'}
};

// ============================================================
// Ключ ScrapingBee (для обхода Cloudflare на appleinsider.com)
// ============================================================
var SCRAPER_KEY = ""; // removed from repository

// ============================================================
// Вспомогательная функция: загружает одну страницу
// prices.appleinsider.com через ScraperAPI и возвращает объект
// { "описание конфига" → цена_в_usd (число) }
// Возвращает null при ошибке.
// ============================================================
// Определяем имя продавца по классам ячейки и (опционально) по vendor-order из шапки
function findVendorForPrice_(rowHtml, bestPrice, vendorCols) {
  var pos = 0;
  var colIdx = 0; // считаем ВСЕ <td> — чтобы совпадать с индексами из <thead>

  while (true) {
    var cellStart = rowHtml.indexOf('<td', pos);
    if (cellStart === -1) break;
    var cellEnd = rowHtml.indexOf('</td>', cellStart);
    var cellHtml = rowHtml.substring(cellStart, cellEnd);
    pos = cellEnd + 1;

    // Только ячейки с ценами, пропускаем best-price-col и alert-col
    if (cellHtml.indexOf('item-price') === -1 ||
        cellHtml.indexOf('best-price-col') !== -1 ||
        cellHtml.indexOf('alert-col') !== -1) {
      colIdx++;
      continue;
    }

    var priceMatch = cellHtml.match(/\$([\d,]+)/);
    if (!priceMatch) { colIdx++; continue; }

    var cellPrice = parseInt(priceMatch[1].replace(/,/g, ''), 10);
    if (cellPrice !== bestPrice) { colIdx++; continue; }

    // Нашли ячейку с нужной ценой — определяем продавца
    // 1. По заголовку таблицы
    if (vendorCols && vendorCols[colIdx]) return vendorCols[colIdx];
    // 2. По классу amzn
    if (cellHtml.indexOf('amzn') !== -1) return 'Amazon';
    // 3. По содержимому href
    var hrefMatch = cellHtml.match(/href="([^"]+)"/);
    if (hrefMatch) {
      var url = hrefMatch[1].toLowerCase();
      if (url.indexOf('amazon') !== -1)       return 'Amazon';
      if (url.indexOf('apple.com') !== -1)    return 'Apple';
      if (url.indexOf('bhphotovideo') !== -1) return 'B&H';
      if (url.indexOf('adorama') !== -1)      return 'Adorama';
      if (url.indexOf('bestbuy') !== -1)      return 'Best Buy';
      if (url.indexOf('walmart') !== -1)      return 'Walmart';
      if (url.indexOf('newegg') !== -1)       return 'Newegg';
      if (url.indexOf('expercom') !== -1)     return 'Expercom';
      if (url.indexOf('costco') !== -1)       return 'Costco';
    }
    // 4. Нет href вообще = Apple
    if (cellHtml.indexOf('href=') === -1) return 'Apple';

    return '';
  }
  return '';
}

// Парсим <thead> для получения порядка продавцов по атрибуту title
function parseVendorHeader_(html) {
  var theadStart = html.indexOf('<thead');
  if (theadStart === -1) return [];
  var theadEnd = html.indexOf('</thead>', theadStart);
  var theadHtml = (theadEnd !== -1) ? html.substring(theadStart, theadEnd) : html.substring(theadStart, theadStart + 3000);

  var vendors = [];
  var pos = 0;
  var vendorMap = {
    'apple': 'Apple', 'amazon': 'Amazon', 'adorama': 'Adorama',
    'b-h-photo': 'B&H', 'bhphoto': 'B&H', 'expercom': 'Expercom',
    'macmall': 'MacMall', 'bestbuy': 'Best Buy', 'walmart': 'Walmart',
    'costco': 'Costco', 'newegg': 'Newegg', 'bhphotovideo': 'B&H'
  };

  while (true) {
    var thPos = theadHtml.indexOf('<th', pos);
    if (thPos === -1) break;
    var thClose = theadHtml.indexOf('>', thPos);
    var thTag = theadHtml.substring(thPos, thClose + 1);

    var titleMatch = thTag.match(/title="([^"]+)"/);
    if (titleMatch) {
      var key = titleMatch[1].toLowerCase();
      vendors.push(vendorMap[key] || titleMatch[1]);
    } else {
      vendors.push(''); // placeholder для колонок без title
    }
    pos = thClose + 1;
  }
  return vendors;
}

function fetchAiPagePrices_(pageName) {
  var targetUrl = 'https://prices.appleinsider.com/' + pageName;
  var scraperUrl = 'https://app.scrapingbee.com/api/v1/'
    + '?api_key=' + SCRAPER_KEY
    + '&url=' + encodeURIComponent(targetUrl)
    + '&render_js=true';

  try {
    var resp = UrlFetchApp.fetch(scraperUrl, {muteHttpExceptions: true});
    if (resp.getResponseCode() !== 200) {
      Logger.log('fetchAiPagePrices_: HTTP ' + resp.getResponseCode() + ' для ' + pageName);
      return null;
    }
    var html = resp.getContentText();
    var vendorCols = parseVendorHeader_(html); // порядок продавцов из шапки
    var priceMap = {};
    var searchPos = 0;
    var descTag = '<td class="item-desc">';

    // Ищем каждый item-desc напрямую — не зависим от класса <tr>
    while (true) {
      var descStart = html.indexOf(descTag, searchPos);
      if (descStart === -1) break;

      var descEnd = html.indexOf('</td>', descStart);
      if (descEnd === -1) break;
      // Убираем все вложенные теги (<a href="...">) — оставляем только текст
      // Нормализуем типографские кавычки/дюймы → ASCII "
      var desc = html.substring(descStart + descTag.length, descEnd)
        .replace(/<[^>]+>/g, '')
        .replace(/[“”‘’′″＂＇]/g, '"')
        .replace(/&quot;/g, '"')
        .trim();

      // Ищем best-price-col в пределах текущей строки таблицы
      var rowEnd = html.indexOf('</tr>', descStart);
      if (rowEnd === -1) rowEnd = descStart + 3000;
      var rowHtml = html.substring(descStart, rowEnd);

      // Ищем best-price-col: берём цену из него
      var bestColIdx = rowHtml.indexOf('best-price-col');
      if (bestColIdx !== -1) {
        var cellStart = rowHtml.indexOf('>', bestColIdx) + 1;
        var cellEnd   = rowHtml.indexOf('</td>', cellStart);
        var cellContent = cellEnd > cellStart ? rowHtml.substring(cellStart, cellEnd) : '';
        var priceNumMatch = cellContent.match(/\$([\d,]+)/);
        if (priceNumMatch) {
          var price = parseInt(priceNumMatch[1].replace(/,/g, ''), 10);
          // Vendor: ищем в retailer-col ячейках по классу/порядку
          var vendor = findVendorForPrice_(rowHtml, price, vendorCols);
          if (!isNaN(price)) priceMap[desc] = {price: price, vendor: vendor};
        }
      }

      searchPos = descEnd + 1;
    }
    return priceMap;

  } catch (e) {
    Logger.log('fetchAiPagePrices_ исключение для ' + pageName + ': ' + e);
    return null;
  }
}

// ============================================================
// Основная функция: записывает цены AppleInsider в столбец D
// ============================================================
function checkAppleInsiderPrices() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('input');
  if (!sheet) {
    SpreadsheetApp.getUi().alert('Лист "input" не найден!');
    return;
  }
  var lastRow = sheet.getLastRow();

  // 1. Собираем, какие страницы нужны и для каких строк
  //    pageJobs = { 'macbook-air-13-inch-m5': [{row:2, desc:'...'}, ...], ... }
  var pageJobs = {};
  var noDataRows = [];

  for (var i = 2; i <= lastRow; i++) {
    var article = sheet.getRange(i, 1).getValue();
    if (!article) continue;
    var key = article.toString().trim().toUpperCase();
    var info = AI_ARTICLES[key];
    if (!info) {
      noDataRows.push(i);
      continue;
    }
    if (!pageJobs[info.page]) pageJobs[info.page] = [];
    pageJobs[info.page].push({row: i, desc: info.desc});
  }

  // Сразу записываем «Нет данных» для неизвестных артикулов
  for (var n = 0; n < noDataRows.length; n++) {
    sheet.getRange(noDataRows[n], 4).setValue('Нет данных');
  }

  // 2. Для каждой уникальной страницы — один запрос
  for (var page in pageJobs) {
    var priceMap = fetchAiPagePrices_(page);
    var jobs = pageJobs[page];

    for (var j = 0; j < jobs.length; j++) {
      var job = jobs[j];
      // Нормализуем кавычки: при копировании кода " могла превратиться в " (U+201D)
      var lookupDesc = job.desc
        .replace(/[“”‘’′″＂＇]/g, '"')
        .replace(/&quot;/g, '"');
      if (priceMap === null) {
        sheet.getRange(job.row, 4).setValue('Ошибка запроса');
      } else if (priceMap[lookupDesc] !== undefined) {
        var entry = priceMap[lookupDesc];
        var cellVal = entry.vendor ? entry.price + ' (' + entry.vendor + ')' : entry.price + ' (см. AppleInsider)';
        sheet.getRange(job.row, 4).setValue(cellVal);
      } else {
        sheet.getRange(job.row, 4).setValue('Не найдено');
        Logger.log('Не найдено: ' + job.desc + ' (lookup: ' + lookupDesc + ') на странице ' + page);
        Logger.log('Доступные описания: ' + Object.keys(priceMap).join(' | '));
      }
    }

    Utilities.sleep(1200); // пауза между запросами к ScraperAPI
  }

  SpreadsheetApp.getUi().alert('Цены AppleInsider обновлены!');
}

// ============================================================
// Проверка наличия на ОБОИХ сайтах
// Столбец A — артикул
// Столбец B — результат BigGeek
// Столбец C — результат Айфория
// ============================================================
function checkAvailability() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('input');
  if (!sheet) { SpreadsheetApp.getUi().alert('Лист "input" не найден!'); return; }
  var lastRow = sheet.getLastRow();

  for (var i = 2; i <= lastRow; i++) {
    var article = sheet.getRange(i, 1).getValue();
    if (!article) continue;

    var key = article.toString().trim().toUpperCase();

    // --- BigGeek (столбец B) ---
    var slugBG = SLUGS_BIGGEEK[key];
    if (!slugBG) {
      sheet.getRange(i, 2).setValue('Нет на сайте');
    } else {
      var urlBG = 'https://biggeek.ru/products/' + slugBG;
      try {
        var respBG = UrlFetchApp.fetch(urlBG, { muteHttpExceptions: true });
        sheet.getRange(i, 2).setValue(respBG.getResponseCode() === 200 ? urlBG : 'НЕТ В НАЛИЧИИ');
      } catch (e) {
        sheet.getRange(i, 2).setValue('НЕТ В НАЛИЧИИ');
      }
      Utilities.sleep(400);
    }

    // --- Айфория (столбец C) ---
    var slugIP = SLUGS_IPHORIYA[key];
    if (!slugIP) {
      sheet.getRange(i, 3).setValue('Нет на сайте');
    } else {
      var urlIP = 'https://iphoriya.ru/product/' + slugIP;
      try {
        var respIP = UrlFetchApp.fetch(urlIP, { muteHttpExceptions: true });
        sheet.getRange(i, 3).setValue(respIP.getResponseCode() === 200 ? urlIP : 'НЕТ В НАЛИЧИИ');
      } catch (e) {
        sheet.getRange(i, 3).setValue('НЕТ В НАЛИЧИИ');
      }
      Utilities.sleep(400);
    }
  }

  SpreadsheetApp.getUi().alert('Готово!');
}

// ============================================================
// Запустить всё сразу: наличие + цены AppleInsider
// ============================================================
function checkAll() {
  checkAvailability();
  checkAppleInsiderPrices();
}

// ============================================================
// Ежедневный триггер (запускает checkAll)
// ============================================================
function createDailyTrigger() {
  // Удаляем старые триггеры checkAvailability и checkAll
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    var fn = triggers[i].getHandlerFunction();
    if (fn === 'checkAvailability' || fn === 'checkAll') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('checkAll')
    .timeBased()
    .everyDays(1)
    .atHour(9)
    .create();
  SpreadsheetApp.getUi().alert('Триггер установлен! Каждый день в 9:00 будут обновляться наличие и цены.');
}

// ============================================================
// Меню
// ============================================================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('BigGeek & Айфория')
    .addItem('Проверить наличие (BigGeek + Айфория)', 'checkAvailability')
    .addItem('Обновить цены AppleInsider (USD)', 'checkAppleInsiderPrices')
    .addSeparator()
    .addItem('Обновить всё сразу', 'checkAll')
    .addSeparator()
    .addItem('Настроить авто-обновление (раз в день в 9:00)', 'createDailyTrigger')
    .addToUi();
}
