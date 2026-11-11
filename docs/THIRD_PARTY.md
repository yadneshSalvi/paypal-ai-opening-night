# QR dependency notices

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
