# Webhook

The platform delivers order events to the merchant's `webhookUrl` as a signed
`POST` over HTTPS. The body is plaintext JSON protected in transit by TLS, without
additional body encryption. The signature uses the platform's Ed25519 key under
RFC 9421, with the label `platform`.

## Headers

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `Content-Digest` | `sha-256=:<base64(sha256(body))>:` |
| `Webhook-Event-Id` | event id, format `evt_` + 26 Crockford-base32 chars |
| `Signature-Input` | `platform=("@method" "@path" "@query" "content-type" "content-digest" "webhook-event-id");created=…;expires=…;nonce="…";keyid="…";alg="ed25519"` |
| `Signature` | `platform=:<base64(ed25519-signature)>:` |

The signature base is built exactly as in [signature.md](./signature.md), over
the covered components above.
`@query` is always covered. If the webhook URL has no query string, its value is
`?`. When it has one, pass the exact raw query bytes received after `?` to the
SDK; do not decode, reorder or re-encode them before verification.

## Delivery and retries

Signatures are fresh for a short window (300 s), so the platform re-signs on
**every** delivery attempt with a new `created`/`expires`/`nonce`. A retried
delivery is a new signed request, not a replay of the first one.

While a notification record exists, its first delivery, automatic retries, and
manual redelivery reuse the same `eventId` and body. After the record is removed
by the current seven-day cleanup policy, a later manual redelivery is a new
notification event and may use a new `eventId`.

The merchant must deduplicate delivery side effects by `eventId`, and make order
state updates idempotent by the verified platform `orderNo` after establishing
order ownership as described below. Return `2xx` only after
successful handling or durable acceptance into your processing queue. If acceptance
fails, return a non-2xx HTTP status so the platform retries. After accepting a task,
retry temporary query or processing failures in your own queue. A business error
in an HTTP 200 body does not request redelivery.

## Verification order (merchant SDK)

1. Request shape and required headers.
2. `Content-Digest` recomputed over the body.
3. `Webhook-Event-Id` matches the body `eventId`.
4. `Signature-Input` parsed; parameters validated (alg, nonce, freshness, key id).
5. The `keyid` selects a platform webhook public key.
6. Signature verified against that public key over the reconstructed base.

## Order ownership before state changes

Save the platform `orderNo` from order creation with the expected merchant, order type, merchant order number, currency and amount. After signature verification, match the event's `orderNo` to this record and validate those business fields before changing state or balances. A valid platform signature, a callback URL parameter or a matching `merchantOrderNo` alone does not establish that the order belongs to your merchant.

If the platform order is unknown locally (including a callback arriving before the create response), reliably queue the event and query by its `orderNo` with your own merchant credentials. Require the query to confirm the expected order; do not apply an unknown event solely by merchant order number. Retry temporary query failures from your queue. Check payment/paid/refund amounts according to their distinct meanings.

Deduplicate by `eventId` and apply business effects idempotently to the verified order. Persist acceptance and its processing state atomically so a failed update does not suppress later retries. Return 2xx only after commit or reliable queue acceptance. Route multi-merchant callbacks within the authenticated merchant configuration and verify the saved order mapping even when URLs differ.

## Payload

```json
{
  "eventId": "evt_…",
  "orderType": "PAYMENT",
  "orderNo": "…",
  "merchantOrderNo": "…",
  "status": "SUCCEEDED",
  "currency": "BRL",
  "paymentMethod": "PIX",
  "amount": "100.50",
  "paidAmount": "100.50",
  "channelTradeNo": "…",
  "payer": { "name": "Maria Silva", "documentNumber": "01234567890" },
  "attach": "…",
  "failure": { "code": 0, "msg": "…", "message": "…" }
}
```

`orderType` is `PAYMENT` or `PAYOUT`; payout payloads omit `paidAmount` and `payer`.
Amounts are decimal strings. `failure` is present when `status` is `FAILED`; branch on
`failure.msg`, use `failure.message` for display only.

Fixed vectors: [`testdata/webhook/`](./testdata/webhook/).

Payment events include the optional string `paymentMethod`, using the same code
as the authenticated payment query. Ordinary orders retain their method; an
aggregate order created with `ALL` reports its committed selection, such as `PSE`
or `PIX`, once payment preparation has completed. `ALL` means no actual method
has been committed, including expiry or cancellation before selection and failed
preparation. It is not a payment rail and must not be counted as a paid method.

The method is frozen with the first event body and covered by its signature.
Existing events without this field remain unchanged on retry; use the
authenticated query to retrieve their current method. Consumers must accept a
missing field for older events. Go and Python consumers need an SDK version that
exposes the field, or can read it from the verified raw payload. Payout webhook
payloads are unchanged.

Payment webhooks may include `payer.name` and `payer.documentNumber` from the
channel-reported actual payer, never copied from the create request. Unavailable
fields are omitted; the whole object is omitted when both fields are unavailable.
Document numbers remain strings, including leading zeros. No document type is
inferred. Existing notification records keep their original body on retry and
are not backfilled with payer details; merchants can use the authenticated
payment query to retrieve available details. Redact payer details in logs.

Payout result webhooks may include an optional `receiver` from the stored channel
result. Its optional string fields are `name`, `documentType`, `documentNumber`,
`keyType`, `key`, `bankCode` and `bankName`. For BRL PIX, `bankCode` is the bank's
ISPB and `keyType` is `PIX` when a key is available. Document numbers and bank codes
retain leading zeros. Missing fields are omitted; the object is omitted when no
receiver details are available. The platform does not substitute create-request
data or product-account defaults for missing receiver details.
Existing notification records keep their original body on retry and
are not backfilled with receiver details.

Successful payout webhooks may also include an optional `sender`. Its optional
string fields are `name`, `documentType`, `documentNumber`, `bankCode`, `bankName`,
`bankBranch`, `accountNumber` and `accountSuffix`. `bankCode` carries ISPB for BRL;
`accountSuffix` is a separate account suffix supplied by the channel, not appended
to `accountNumber`. Account numbers, branch codes and document numbers retain
leading zeros. Document types are not inferred from document numbers.

Channel-reported sender details take precedence as a whole. When the channel
provides partial details, missing fields remain omitted. Only when no sender
details are available does the platform use the default name and tax ID configured
on the product account used for this order. If neither source provides details,
`sender` is omitted. Failed and in-progress payouts omit `sender`. Retries retain
the stored body; configuration changes do not rewrite an existing notification.

## Payout returns

A successful payout may later be returned by the upstream channel. After the
platform credits the merchant refund, it sends `status: "REFUNDED"` to the original
payout `webhookUrl`. This is a separate event with a new `eventId`; retries reuse
that event ID and its body. The original success event remains unchanged.

```json
{
  "eventId": "evt_00000000000000000000000002",
  "orderType": "PAYOUT",
  "orderNo": "PO202609240001",
  "merchantOrderNo": "M202609240001",
  "status": "REFUNDED",
  "currency": "MXN",
  "amount": "100.00",
  "refundNo": "R202609240001",
  "refundAmount": "100.00",
  "refundTime": 1790208000000
}
```

`refundNo` identifies the refund. `refundAmount` is the full returned principal in
major currency units as a decimal string, not the net balance credit after fees.
`refundTime` is the refund posting time in Unix milliseconds, unchanged on retry.
Automatic retries stop on HTTP 2xx or 24 hours after the refund notification is
created, independently of the original payout's creation time. Failed records
are retained, and the payout query remains available after automatic retries stop.
These fields are payout-only and omitted until refund posting completes. Query
the original payout to confirm the same result. Deduplicate refund posting by the
original order or refund number, and never let a late success event revert a
refunded order. This contract does not introduce payment refunds, partial refunds,
or a merchant refund-request endpoint.
