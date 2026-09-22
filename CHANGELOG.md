# Changelog — js

Versions follow SemVer. Tags are `vX.Y.Z` on this repository.

## v0.1.6 — 2026-09-22

- `IDR` payouts: `accountNo` is now required for every method, wallets included
  (`ID_DANA`, `ID_OVO`, `ID_GOPAY`, `ID_LINKAJA`, `ID_SHOPEEPAY`), matching the
  gateway. The recipient account is taken from `accountNo` (the wallet-registered
  phone number for wallets); `mobile` is a contact number and never stands in
  for it. A wallet payout without `accountNo` is now rejected before sending as
  a missing required field instead of coming back as a gateway error.
- Authenticated payment queries and signed payment webhooks may carry the optional
  channel-reported `payer.name` and `payer.documentNumber`, reported by the channel
  and never copied from the create request. Responses are returned as parsed JSON,
  so both fields arrive unchanged and no API change was needed. Older payloads
  without payer remain supported.

## v0.1.5 — 2026-09-21

- Method-code allowlists now cover every currency and direction the gateway
  validates, so a code the gateway would refuse is rejected before sending as
  "method not available" instead of coming back as an API error. Newly listed:
  pay-in `ARS` (`BANK_TRANSFER`, `CVU`, `QRIS`), `BRL` (`PIX`), `CLP` (`KHIPU`,
  `MACH`, `PAGO46`, `WEBPAY`), `COP` (`BREB`, `NEQUI`, `PSE`), `MXN` (`CASH`,
  `OXXO`, `SPEI`), `TRY` (`BANK_TRANSFER`); payout `ARS`, `CLP`, `MXN`
  (`BANK_TRANSFER`), `BRL` (`PIX`), `COP` (`BANK_CARD`, `BANK_TRANSFER`, `BREB`,
  `TRANSFIYA`), `IDR` (`ID_BANK_TRANSFER` and the five wallets), `TRY`
  (`BANK_TRANSFER`, `PAPARA`). Types and constants are unchanged.

## v0.1.4 — 2026-09-19

- Philippine GCash and Maya payouts take the wallet's own code (`PH_GCASH` /
  `PH_MAYA`) under its own extra field, matching Bangladesh, Indonesia and
  Pakistan; the channel derives `bankCode` from the code. Every other wallet,
  GrabPay included, still goes out under `PH_DF_WALLET` with `bankCode` naming
  the wallet, where it stays required as it is for `PH_DF_BANK`.

## v0.1.3 — 2026-09-18

- Needs a platform that accepts an omitted or `null` ARS `address` (platform
  release of 2026-09-18); against an earlier platform, send `address` as a string.
- ARS `BANK_TRANSFER` payout `address` is optional. Omitted, `null` and empty
  strings mean no address; non-empty strings are preserved. Other value types
  are rejected before sending. The other eight recipient fields remain required,
  and other currencies and methods retain their existing rules.

## v0.1.2 — 2026-09-17

- USD payments accept `CASH_APP`; USD payouts accept `CASH_APP`, `PAYPAL` and
  `CHIME`. Each method carries its own extra field and its own required set,
  checked before the request goes out.
- ARS payouts accept an empty `address`. It is the only required field that may
  be blank, and it must still be present as a string: `undefined`, `null` and
  non-string values are rejected the way an empty required field always was.
- Documentation: the `protocol/` links in the README point at the repository.
  That directory is not shipped in the package, so the relative links they
  replace were dead on the npm package page.

## v0.1.1 — 2026-09-15

- Fixed: every query call dropped its query string on Node older than 18.16,
  where `URLSearchParams.size` is `undefined`, so the gateway received the
  request with no parameters at all. The query string is now built with
  `toString()`.
- A malformed idempotency key is now a `RequestError`, like every other failure
  raised before the request goes out. It used to escape as an internal protocol
  error that the package does not export, so callers could neither match it nor
  tell it apart from an unknown outcome on an order that was never sent.
- Indonesia wallet payouts (`ID_DANA` / `ID_OVO` / `ID_GOPAY` / `ID_LINKAJA` /
  `ID_SHOPEEPAY`) validate under their own extra field (`idDana`, `idOvo`, ...),
  same shape as `idBankTransfer`. No API change.
- Documentation: `IDEMPOTENCY_CONFLICT` means the platform has the number but
  cannot return its order, so the caller keeps querying that number instead of
  allocating a new one. `merchantOrderNo` is the only key the platform
  deduplicates on; the idempotency key is carried for tracing and takes a fresh
  value per request. `CHANNEL_BUSY`, already in `MSG`, is now in the error table
  as the one channel error that can be resent without querying first.

## v0.1.0 — 2026-09-14

Initial public release.

- Ed25519 request signing (RFC 9421 HTTP Message Signatures) and X25519
  sealed-box body encryption for POST requests.
- Platform webhook verification: `verifyWebhook`, `parsePaymentWebhook`, `parsePayoutWebhook`.
- Endpoints: `createPayment`, `createPayout`, `queryPaymentByOrderNo`, `queryPaymentByMerchantOrderNo`, `queryPayoutByOrderNo`, `queryPayoutByMerchantOrderNo`, `getBalance`, `getUsdRate`, `getPayoutReceipt`, `getPaymentCheckout`, `submitPaymentTradeNo`, `addPaymentExtraInfo`.
- Local validation before signing: top-level required fields, decimal-string
  amount within `DECIMAL(18,2)`, `https` webhook URL, method-code shape and
  per-currency required extras. Format checks (phone, e-mail, IFSC) stay with
  the gateway.
- Error taxonomy: `RequestError` (rejected before sending), `TransportError` (sent or possibly sent, no response), `APIError` (gateway business error), `ResponseError` (non-envelope response).
- Amounts, balances, fees and rates are decimal strings; idempotency key
  support.
