# QR dependency notices

The supplier handoff uses these exact unmodified packages. Their registry integrity values are pinned in `package-lock.json`.

| Package | Purpose | Source | License copy |
|---|---|---|---|
| qrcode 1.5.4 | Server-generated handoff QR | [node-qrcode](https://github.com/soldair/node-qrcode) | [MIT, Ryan Day](licenses/qrcode-MIT.txt) |
| jsqr 1.4.0 | Client-side image/camera pixel decoding | [jsQR](https://github.com/cozmo/jsQR) | [Apache 2.0](licenses/jsqr-Apache-2.0.txt) |
| @types/qrcode 1.5.6 | Development type declarations | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/qrcode) | [MIT, Microsoft Corporation](licenses/types-qrcode-MIT.txt) |

Bryntum packages require the user's existing Enterprise entitlement; this application does not redistribute a key or proprietary source package. The immutable shared PayPal core archive is checked independently by `npm run verify:packages`.
