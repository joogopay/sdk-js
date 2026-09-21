# Changelog — protocol

## Unreleased

- `methods.json`: the 17 codes no currency accepts are flagged `payin`/`payout`
  false (`APPLE_PAY`, `CREDIT_CARD`, `GOOGLE_PAY`, `NETELLER`, `P2P`, `PAGO_FACIL`,
  `RAPIPAGO`, `SBP`, `SERVIFACIL`, `SKRILL`, `TH_BANK_CARD`, `TH_BANK_TRANSFER`,
  `TH_PROMPTPAY`, `TH_TRUEMONEY`, three `USDT-*`). Entries stay so the SDKs keep
  mapping their extra field names; the flags now mean "some currency accepts this".
- `currencies.json` drops `RUB` and `THB`, `countries.json` drops `RU` and `TH`:
  the gateway has no validator for either currency.
- `method-rules.json` fills the `codes` allowlist for every currency and
  direction the gateway validates: pay-in `ARS`, `BRL`, `CLP`, `COP`, `MXN`,
  `TRY` and payout `ARS`, `BRL`, `CLP`, `COP`, `IDR`, `MXN`, `TRY`. An empty list
  now only means that no allowlist is known.
- `methods.json`: `OXXO` is a pay-in method; `TRANSFIYA` is payout only.
- Deploy API support for omitted and `null` addresses before upgrading to this
  SDK contract; older API deployments may still require an address string.
- ARS `BANK_TRANSFER` payout `address` is optional. Omitted, `null` and empty
  strings mean no address; non-empty strings are preserved. Other value types
  are rejected before sending. The other eight recipient fields remain required,
  and other currencies and methods retain their existing rules.
- `optionalNullableStringsByMethod` defines method-scoped optional string
  fields that also accept `null`, shared by all five language validators.
- Philippine GCash and Maya follow the same shape as every other country:
  `PH_GCASH` and `PH_MAYA` are payout methods as well as pay-in ones, and the
  channel derives `bankCode` from the method code, so a merchant no longer sends
  it. Those two cover nearly all Philippine payout volume; every other wallet,
  GrabPay included, still goes out under the generic `PH_DF_WALLET` code, where
  `bankCode` names the wallet and stays required as it is for `PH_DF_BANK`.

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
