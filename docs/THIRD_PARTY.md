# Third-party notices

The supplier handoff uses these exact unmodified packages. Their registry integrity values are pinned in `package-lock.json`.

| Package | Purpose | Source | License copy |
|---|---|---|---|
| qrcode 1.5.4 | Server-generated handoff QR | [node-qrcode](https://github.com/soldair/node-qrcode) | [MIT, Ryan Day](licenses/qrcode-MIT.txt) |
| jsqr 1.4.0 | Client-side image/camera pixel decoding | [jsQR](https://github.com/cozmo/jsQR) | [Apache 2.0](licenses/jsqr-Apache-2.0.txt) |
| @types/qrcode 1.5.6 | Development type declarations | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/qrcode) | [MIT, Microsoft Corporation](licenses/types-qrcode-MIT.txt) |

Bryntum packages require the user's existing Enterprise entitlement; this application does not redistribute a key or proprietary source package. The immutable shared PayPal core archive is checked independently by `npm run verify:packages`.

## Source parsing and current speech transport

| Package | Purpose | Source | License |
|---|---|---|---|
| pdfjs-dist 6.5.438 | Bounded PDF text and page locations | [PDF.js](https://github.com/mozilla/pdf.js) | Apache 2.0, included in the package |
| exceljs 4.4.0 | Workbook cell/value extraction | [ExcelJS](https://github.com/exceljs/exceljs) | MIT, included in the package |
| yauzl 3.4.0 | ZIP preflight bounds before workbook parsing | [yauzl](https://github.com/thejoshwolfe/yauzl) | MIT, included in the package |
| ws 8.22.2 | Server-side Realtime speech WebSocket | [ws](https://github.com/websockets/ws) | MIT, included in the package |

Exact integrity values and transitive dependencies are pinned in `package-lock.json`. ExcelJS's UUID dependency is overridden to 11.1.1; the actual workbook parser round-trip is covered by the source tests. The new transport and parsers do not ship a model key or application environment file.

## Wrap account and report output

| Package or asset | Purpose | Source | License notice |
| --- | --- | --- | --- |
| @paypal/agent-toolkit 1.11.0 | Exact owned invoice/order/refund reads through the installed OpenAI adapter | [Official PayPal toolkit](https://github.com/paypal/agent-toolkit) | Installed npm metadata says ISC; [upstream Apache-2.0 copy](licenses/paypal-agent-toolkit-upstream-Apache-2.0.txt). The discrepancy is retained in the dependency review. |
| ag-charts-community 14.3.0 | Linked financial comparisons and cost waterfall | [AG Charts](https://github.com/ag-grid/ag-charts) | [MIT, AG GRID LTD](licenses/ag-charts-community-MIT.txt) |
| pdf-lib 1.17.1 | Real paginated immutable report bytes | [pdf-lib](https://github.com/Hopding/pdf-lib) | [MIT, Andrew Dillon](licenses/pdf-lib-MIT.txt) |
| @pdf-lib/fontkit 1.1.1 | Embedded PDF glyph metrics and font subsets | [fontkit fork](https://github.com/Hopding/fontkit) | MIT, declared by the installed package and its README |
| axios 1.21.1 | Exact installed Toolkit transport guard | [axios](https://github.com/axios/axios) | [MIT](licenses/axios-MIT.txt) |
| Noto Sans Regular/Bold | Embedded readable PDF text | [Noto fonts](https://github.com/notofonts/noto-fonts) | [OFL-1.1](../public/fonts/OFL.txt); hashes in the dependency review |

The application uses AG Charts Community; no Bryntum Chart package or entitlement is claimed. [Exact dependency and transport review](architecture/wrap-dependency-review.md) records the remaining Toolkit transitive advisories and the public adapter actually exercised.
