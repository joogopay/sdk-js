# Changelog — js

Versions follow SemVer. Tags are `vX.Y.Z` on this repository.

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
