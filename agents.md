# Mac Price Radar — agent instructions

## Goal
Maintain a reliable Russian retail price radar for MacBook products. The source of truth is normalized product offers; the UI and Google Sheet are projections.

## Architecture
- `src/`: TypeScript domain model, normalization, cheapest-offer selection, and source adapters.
- `data/`: checked-in demo/config data only. Never commit credentials or private supplier feeds.
- `web/`: dependency-free internal static table consuming `data/offers.json`.
- `apps-script/`: optional Google Sheets synchronizer. It writes values into the existing spreadsheet; it does not scrape stores.

## Rules
- Match offers by stable SKU when available; otherwise use normalized model/chip/RAM/SSD/screen fields.
- Never compare different RAM/SSD/chip configurations as the same product.
- Exclude foreign stores and offers marked used, display, refurbished, or preorder unless explicitly enabled.
- Keep raw title, source URL, fetched time, stock, warranty, and condition for auditability.
- A missing price is unavailable, not zero. A cheapest price must be accompanied by its store and URL.
- New stores are adapters implementing `RetailerAdapter`; do not put retailer-specific parsing in the domain layer.

## Validation
Run `npm run typecheck`, `npm run test`, and `npm run build:data` before handing off. Update `README.md` when changing deployment or sheet columns.
