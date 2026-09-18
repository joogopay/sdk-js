# Changelog — protocol

## Unreleased

- Deploy API support for omitted and `null` addresses before upgrading to this
  SDK contract; older API deployments may still require an address string.
- ARS `BANK_TRANSFER` payout `address` is optional. Omitted, `null` and empty
  strings mean no address; non-empty strings are preserved. Other value types
  are rejected before sending. The other eight recipient fields remain required,
  and other currencies and methods retain their existing rules.
- `optionalNullableStringsByMethod` defines method-scoped optional string
  fields that also accept `null`, shared by all five language validators.

- `data/methods.json`: `ID_DANA` / `ID_OVO` / `ID_GOPAY` / `ID_LINKAJA` / `ID_SHOPEEPAY`
  are payout methods as well (Indonesia wallet payouts). The extra field is the
  same `PayoutBankAccountContactExtra` shape as `ID_BANK_TRANSFER`; `bankCode`
  is the wallet code (`DANA`, `OVO`, ...), `accountNo` may be omitted.

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
