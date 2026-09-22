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
state updates idempotent by `orderNo` or `merchantOrderNo`. Return `2xx` after
successful handling; a non-2xx response causes the platform to retry.

## Verification order (merchant SDK)

1. Request shape and required headers.
2. `Content-Digest` recomputed over the body.
3. `Webhook-Event-Id` matches the body `eventId`.
4. `Signature-Input` parsed; parameters validated (alg, nonce, freshness, key id).
5. The `keyid` selects a platform webhook public key.
6. Signature verified against that public key over the reconstructed base.

## Payload

```json
{
  "eventId": "evt_…",
  "orderType": "PAYMENT",
  "orderNo": "…",
  "merchantOrderNo": "…",
  "status": "SUCCEEDED",
  "currency": "BRL",
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

Payment webhooks may include `payer.name` and `payer.documentNumber` from the
channel-reported actual payer, never copied from the create request. Unavailable
fields are omitted; the whole object is omitted when both fields are unavailable.
Document numbers remain strings, including leading zeros. No document type is
inferred. Existing notification records keep their original body on retry and
are not backfilled with payer details; merchants can use the authenticated
payment query to retrieve available details. Redact payer details in logs.
