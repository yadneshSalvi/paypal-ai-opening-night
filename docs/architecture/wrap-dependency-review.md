# Wrap dependency and transport review

Qualified package inputs are `@fracture/paypal-core` 0.2.4 (existing archive SHA-256 `5c03e848a603c91f98f213c9bfee2e5e4ccb00fd54946ae349945c55f53c3f0f`), APIMatic `paypal` 2.29.0, PayPal Agent Toolkit 1.11.0 (installed npm metadata says ISC; the official upstream repository supplies Apache-2.0), axios 1.21.1, Bryntum Grid/Core Enterprise 8.0.0 (existing licensed integration), AG Charts Community 14.3.0 (MIT), pdf-lib 1.17.1 (MIT), fontkit 1.1.1 (MIT) and Noto Sans Regular/Bold (OFL; license in `public/fonts/OFL.txt`). The PDF fonts came from the official `notofonts/noto-fonts` repository. No shared core source was changed. No Bryntum Chart entitlement is asserted.

The [official Toolkit repository](https://github.com/paypal/agent-toolkit) and actual installed public exports were inspected. The OpenAI adapter is CommonJS and loads its own CommonJS axios instance. An ESM axios interceptor does not cover that instance. Native Node `createRequire` resolution is retained through server bundling; runtime checks verify that the exact installed instance still contains the qualified interceptor. Tests use the actual installed adapter and gateway with injected transports. The first unguarded attempt remains unknown-egress evidence, not a successful provider qualification.

`npm audit` on this frozen dependency family reports 11 findings: 10 high and one moderate, all through Toolkit dependencies; this is not a zero-advisory release. The mathjs override to 15.2.0 removed the initial mathjs advisory. The remaining families are Zod 3, LangChain/LangSmith serialization/prototype concerns, older AI SDK/jsondiffpatch, and uuid. The Toolkit pins older adapter dependencies. A blind force downgrade of Toolkit or major Zod substitution would change its qualified catalog contract.

Measured `require.cache` inspection of the used `@paypal/agent-toolkit/openai` entry loads Zod, mathjs, axios, lodash and its PayPal SDK, and does **not** load LangChain, LangSmith, AI SDK, jsondiffpatch or the OpenAI model client. This is a scoped reachability result; the other adapters remain present on disk. Production inputs are validated with direct Zod 4.6.7 and hard byte limits before the Toolkit sees a server-created object containing only one bounded original ID. No untrusted constrained collection is submitted to Toolkit Zod. Returned provider bodies are byte-bounded and handled by the application's exact identity/conservation checks. The model gateway uses direct bounded Responses HTTP and never LangChain deserialization, prompt pulling, AI SDK file uploads or HTML diff formatting.

The [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) affects versions below 4.6.6 and describes oversized constrained collections. The [LangChain advisory](https://github.com/advisories/GHSA-r399-636x-v7f6) documents unsafe deserialization and patched 0.3.80/1.1.8 versions. These advisories remain a full-release dependency remediation/review gate; the bounded adapter is not a general permission to enable another Toolkit export or mutation action. No optional tool catalog is registered with the model beyond the three application-owned functions.

Build qualification uses Node 22.22.3, npm 10.9.8 and Next 16.4.6 webpack. Google Fonts CSS and real font files were cached from their official endpoints for the provider-disabled build; no placeholder font bytes were substituted. The initial Turbopack build could not consume that local font mock and failed; two subsequent webpack attempts exposed native-require rewriting before the corrected adapter passed. The original build failures are retained. The final frozen build manifest records exact source, lockfile, public fonts, installed dependency tree, build files and private-value scan. Both report route file traces include the Noto files.

## PDF font provenance

The [official Noto Sans directory](https://github.com/notofonts/noto-fonts/tree/main/hinted/ttf/NotoSans) supplied these original font files. `scripts/verify-packages.ts` checks the exact bytes used in the export qualification.

| File | SHA-256 | License |
| --- | --- | --- |
| NotoSans-Regular.ttf | b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5 | OFL-1.1 |
| NotoSans-Bold.ttf | c976e4b1b99edc88775377fcc21692ca4bfa46b6d6ca6522bfda505b28ff9d6a | OFL-1.1 |
| OFL.txt | 0dab92d0544f7b233403f14b84a663bdbfa746982eda629e7f4f9ffe1b036feb | Full bundled notice |

The Toolkit distribution has a license metadata discrepancy: its installed `package.json` says ISC and contains no root license file, while the [official repository license](https://github.com/paypal/agent-toolkit/blob/main/LICENSE) is Apache-2.0. The upstream license is retained in the third-party notices rather than asserting an unverified ISC text.
