# Brand artwork

Retrieved 2026-10-02. Manufacturer marks retain their original path geometry.
Inactive metadata and embedded styles were removed. Anker's empty vertical
margin was cropped. Ray-Ban's background was removed and its mark arranged
alongside Meta's mark in one SVG for the existing Ray-Ban Meta brand card.

- Apple: [Simple Icons](https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/apple.svg)
- Anker: inline header SVG on [anker.com](https://www.anker.com/)
- UGREEN: [official site header SVG](https://www.ugreen.com/cdn/shop/files/ugreen_logo-_1_e168f1f4-de2e-4509-bd2e-8ea001ac3a12.svg?v=1761026731)
- Logitech: [official navigation SVG](https://www.logitech.com/content/dam/logitech/en/nav/brand-logos/logitech.svg)
- Ray-Ban: [SVG Repo](https://www.svgrepo.com/show/303313/ray-ban-logo.svg)
- Meta: [Logotyp.us](https://logotyp.us/file/meta.svg)

# MacBook photography

The five photographs are loaded directly from Apple's CDN. No image files are
saved in this repository or deployed on the shop server. Each family and screen
size has its own CSS background; `contain` keeps its natural aspect ratio.
The Pro 14 source includes extra transparent margins in a square canvas. Its
background scale and position compensate for those margins without stretching
the photograph or storing an edited copy.

- [Air 13 and 15 specifications](https://www.apple.com/macbook-air/specs/)
- [Current Pro 14 and 16 Apple Store](https://www.apple.com/shop/buy-mac/macbook-pro/14-inch): transparent Space Black hero images, also used in the current store colour selection.
- [Neo 13 specifications](https://www.apple.com/macbook-neo/specs/)

The 14,000-byte budget covers the HTML response and its inline CSS. Photographs
and the five SVG logos are separate requests and add to the total page transfer.
