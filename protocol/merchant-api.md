# Merchant API overview

## Endpoints

| # | Method | Path | Signed | Encrypted body | Purpose |
|---|---|---|---|---|---|
| 1 | POST | `/api/v1/payments` | ✓ | ✓ | create pay-in |
| 2 | GET | `/api/v1/payments?orderNo=…` | ✓ | — (no body) | query pay-in by order no |
| 3 | GET | `/api/v1/payments?merchantOrderNo=…` | ✓ | — | query pay-in by merchant order no |
| 4 | POST | `/api/v1/payouts` | ✓ | ✓ | create pay-out |
| 5 | GET | `/api/v1/payouts?orderNo=…` / `merchantOrderNo=…` | ✓ | — | query pay-out |
| 6 | GET | `/api/v1/payouts/{orderNo}/receipt` | ✓ | — | pay-out receipt |
| 7 | GET | `/api/v1/balances?currency=…` | ✓ | — | merchant balances |
| 8 | GET | `/api/v1/usd-rates?currency=…&payMethod=…` | ✓ | — | USD rate |
| 9 | GET | `/api/v1/payment/checkout?orderNo=…` | ✗ | ✗ | hosted-checkout status (public, unsigned) |
| 10 | POST | `/api/v1/payment/submitTradeNo` | ✗ | ✗ | payer reports the upstream trade number (UTR) |
| 11 | POST | `/api/v1/payment/addExtraInfo` | ✗ | ✗ | payer supplies details for a create-first order |

Endpoints 9–11 form the **hosted-checkout group**: the merchant's H5 page calls
them directly and holds no merchant private key, so they carry no signature and
no body encryption. See [Hosted-checkout group](#hosted-checkout-group).

Out of scope for this SDK: subscription (`/subscription/*`), channel callbacks,
H5 authorization pages, and back-office APIs.

## Design rules

Every language SDK follows these:

1. Methods return `(*T, error)` (or the language equivalent); `T` is the decoded
   envelope `data`, with no metadata wrapper and no SDK fields mixed into DTOs.
2. Writes (`CreatePayment`, `CreatePayout`) are not retried automatically. After a
   timeout or transport error, recover by querying with `merchantOrderNo` /
   `orderNo`. A deliberate retry reuses the same `merchantOrderNo`, which is the
   only key the platform deduplicates on; the idempotency key is carried for
   tracing and takes a fresh value per request.
3. No SDK-side enum validation of currency / country / method; enum constants are
   hints only, unknown values pass through.
4. Every **signed** `POST` body is a sealed-box envelope; the signature always
   covers the final wire body (the envelope bytes), and `Content-Digest` is over
   those bytes. The hosted-checkout POSTs (10, 11) are the exception — plain JSON,
   `Content-Type: application/json`, no signature and no envelope.
5. Requests are signed with the merchant Ed25519 key (see
   [signature.md](./signature.md)); webhooks are verified with the platform
   Ed25519 key (see [webhook.md](./webhook.md)).
6. Money — `amount`, `paidAmount`, balances, fees, rates — is a decimal string
   such as `"100.50"`, never a JSON number. SDKs keep it as a string end to end.
7. SDKs read no local env, emit no logs, print no body, and do not panic.

## Payout refund results

Authenticated payout queries can return `REFUNDED` after an upstream full return
is confirmed and the merchant refund is credited. The response adds `refundNo`,
`refundAmount` (full principal as a decimal string), and `refundTime` (posting time
in Unix milliseconds). Before posting completes, the original payment result is
retained and these fields are omitted. The original order identifiers and `amount`
are unchanged. See [Payout returns](./webhook.md#payout-returns) for notification and
idempotency rules. This status does not apply to payment or checkout results.

## Actual payer in payment queries and webhooks

Authenticated `GET /api/v1/payments` and payment webhooks can return an optional
`payer` object:

```json
{"payer":{"name":"Maria Silva","documentNumber":"01234567890"}}
```

These are actual payer details reported by the payment channel, not the payer
submitted in the create request. Either field can be omitted when unavailable;
the whole object is omitted when neither is available. Document numbers remain
strings, including leading zeros. No document type is inferred.

Payment query requests must be signed by the merchant that owns the order. A valid signature
from another merchant does not grant access. Use HTTPS with certificate
verification, and redact names and document numbers in logs. The response uses
ordinary JSON protected by TLS, without additional body encryption. These fields
are not returned by create, public checkout, payout query, or payout webhooks.
Payment webhooks carry the available payer in their signed JSON body over HTTPS;
see [webhook.md](./webhook.md).

## Hosted-checkout group

Endpoints 9–11 are served by the gateway without the signature interceptor, so a
client may call them with only a `baseUrl`. They exist for the merchant's own
checkout page; a merchant backend may also call them, for reconciliation or to
complete an order on the payer's behalf.

### `status` is the outcome, not the HTTP code

⚠️ **The two POSTs answer `HTTP 200` with envelope `code: 200` even when the
platform refuses the request.** The outcome lives in the `data` payload:

| `status` | meaning |
|---|---|
| `1` | accepted |
| `0` | refused — `message` says why (invalid state, rate limited, …) |

```json
{ "code": 200, "msg": "OK",
  "data": { "status": 0, "message": "too many requests, please retry later" } }
```

An SDK caller that only checks for a thrown error or a non-2xx status **will read
a refusal as a success**. Every SDK exposes the decoded `status`; Go additionally
offers `Ok()` on the result types. Check it.

`orderStatus`, when present, is the checkout-facing order status
(`CREATED` / `PENDING` / …) — note that this vocabulary differs from the merchant
API's own status strings; see [statuses](./data/statuses.json).

### Request shapes

```jsonc
// POST /api/v1/payment/submitTradeNo
{ "orderNo": "P2026…", "tradeNo": "UTR123456" }        // both required

// POST /api/v1/payment/addExtraInfo
{ "orderNo": "P2026…",
  "payMethod": "PK_JAZZCASH",                          // optional
  "extra": { "mobile": "03001234567" } }               // optional, string→string
```

`addExtraInfo` completes a "create first, fill in later" order: the merchant may
create the payment without payer details, the order waits, and this call is what
triggers the real upstream order. `paymentUrl` comes back once that happened.

## Client-side validation

Every SDK checks the request before signing it, against
[`data/method-rules.json`](./data/method-rules.json) (per-currency method
rules) and [`data/request-rules.json`](./data/request-rules.json) (top-level
field list, amount pattern, webhook URL prefix) — one source of truth
from which every language's rule table is generated. The
top-level checks are pinned by [`testdata/validation/`](./testdata/validation/):
every SDK runs the same accept/reject cases, so a rule change that is not
mirrored in a language fails that language's suite.

The SDK applies these checks:

| | |
|---|---|
| **Top-level** | The four fields the gateway marks `required` on every create: `merchantOrderNo`, `currency`, `amount`, `webhookUrl` must be non-blank. `amount` must be a **string** matching `^(0\|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$` and greater than zero — the gateway's amount format plus its `DECIMAL(18,2)` bounds; a JSON number is rejected because the gateway expects a string. `webhookUrl` must be an absolute URL starting with `https://`. |
| **Shape** | `code` non-empty; at most one method extra set; the extra present must be the one that belongs to `code`; if the currency has a method allow-list, `code` must be on it. |
| **Required** | Fields the gateway requires to be non-empty for that currency, plus any a specific method code adds. |
| **Optional nullable strings** | Method-scoped fields in `optionalNullableStringsByMethod` may be omitted or set to `null` or a string; other types are rejected. For ARS `BANK_TRANSFER` payouts, omitted, `null` and empty `address` values all mean no address. Non-empty strings are preserved. The other eight recipient fields remain required. |

Two small normalisations happen before the checks: a caller-supplied
`Idempotency-Key` is trimmed before UUID validation, and the `orderNo` passed to
`GetPayoutReceipt` is trimmed and must be non-blank (other characters are
percent-escaped, not rejected — `ORD/001` goes out as `ORD%2F001`).

Formats — phone length, e-mail, IFSC length, document numbers — are deliberately
**not** checked. Those rules evolve per currency and per upstream; a copy inside
the SDK drifts from the gateway, and a merchant hit by a stale copy can only wait
for an SDK release. The gateway's `400` is the more accurate answer.

Two rules keep the checks from blocking legitimate traffic:

- A currency absent from the table is **not** rejected — the SDK's table may be
  older than the gateway.
- An empty `codes` list means that currency has no allow-list at the gateway, so
  the SDK must not reject on the code either.

Required fields are conditional where the gateway makes them conditional — for
example an `INR` payout needs `name`, `email` and `mobile` always, but `ifsc` and
`account` only for `IN_IFSC`; flattening that would reject every valid `IN_UPI`
payout.

## Amounts and settlement

- `amount` is required to create a pay-in / pay-out.
- The settled amount is the `paidAmount` from the webhook or query response.
- For most channels `paidAmount == amount`; channels with range-amount or
  user-entered-amount modes may settle a `paidAmount` within the channel's range.
- Per-channel amount modes and parameter semantics (`minAmount`, `maxAmount`,
  multiple payments, …) are defined by the `paymentMethod.<channel>` extra fields.

## Client shape

```text
NewClient(Config{
    BaseURL, AccessKey,
    MerchantPrivateKeyBase64,
    PlatformBodyKeyID, PlatformBodyPublicKeyBase64,
    PlatformWebhookPublicKeys,
})
    ├── CreatePayment / CreatePayout            → *PaymentOrder / *PayoutOrder
    ├── QueryPayment/PayoutBy{Order,Merchant}No → *…Order
    ├── GetBalance / GetUSDRate / GetPayoutReceipt / GetPaymentCheckout
    └── VerifyWebhook / ParsePaymentWebhook / ParsePayoutWebhook
```

Errors: `*APIError` (business error from the envelope), `*ResponseError`
(non-envelope body), and sentinel errors for local validation and transport.
See [errors.md](./errors.md).
