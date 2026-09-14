# Changelog — protocol

## v0.1.0 — 2026-09-14

- Top-level validation constants (required text fields, amount pattern, webhook
  URL prefix) live in `data/request-rules.json`; method rules in
  `data/method-rules.json`. Both are the single source every language SDK is
  generated from. Shared vectors under `testdata/validation/` exercise them.
- `data/method-rules.json` aligned with the gateway validators: `ARS` pay-in
  `CVU` / `QRIS` require `extra.phone`; `COP` pay-in `PSE` / `NEQUI` require no
  extra field.
- `data/{methods,countries,currencies}.json` drop the `preview` flag.
- Hosted-checkout endpoints `POST /api/v1/payment/{submitTradeNo,addExtraInfo}`
  added to `data/endpoints.json`: unsigned, unencrypted, outcome in `data.status`.
