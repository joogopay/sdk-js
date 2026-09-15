# JooGoPay SDK for JavaScript

Official SDK for the merchant open API. Signing, digest and body encryption are
handled by the SDK; merchants never assemble `Signature-Input`, `Content-Digest`
or the sealed box envelope by hand.

## Protocol

[`protocol/`](protocol/) is the source of truth; the Go, JavaScript, PHP, Python and
Java SDKs are verified against the same set of test vectors:

| Item | Approach |
| --- | --- |
| Signature | Ed25519 with a fixed RFC 9421 profile |
| Digest | RFC 9530 `Content-Digest` (sha-256) |
| POST body | X25519 sealed box envelope; the digest is computed over the encrypted body |
| GET | No encryption, no body; the signature covers the public query and the access key |
| Webhook | Signed by the platform with Ed25519; the body is not encrypted |
| Merchant identity | Located by `Merchant-Access-Key` only; signature params carry **no keyId** |

## Installation

```
npm install @joogopay/sdk
```

Runtime dependency: libsodium-wrappers. Node.js 18 or newer.

## Configuration

Six values are needed. Only the private key is generated on the merchant side; the
platform never receives it.

| Field | Description |
| --- | --- |
| `baseUrl` | HTTPS platform origin, without `/api/v1` |
| `accessKey` | Merchant access identifier issued by the platform |
| `merchantPrivateKeyBase64` | Merchant Ed25519 private key, base64, **stored on the merchant side only** |
| `platformBodyKeyId` | Current platform body key id (per deployment) |
| `platformBodyPublicKeyBase64` | Platform X25519 public key, base64, used to encrypt POST bodies |
| `platformWebhookPublicKeys` | Platform webhook Ed25519 public keys, indexed by keyId |

The client rejects non-HTTPS base URLs. Synchronous responses are plaintext JSON whose
confidentiality and integrity rely on HTTPS/TLS.

## Quick start

```js
import { APIError, Client, RequestError, ResponseError, TransportError } from '@joogopay/sdk';

const client = new Client({
  baseUrl: 'https://panama.joogopay.com',          // production origin; no /api/v1
  accessKey: 'mak_live_xxx',
  merchantPrivateKeyBase64: merchantPrivateKey,          // merchant Ed25519 private key, base64
  platformBodyKeyId: 'body_20260827_01',
  platformBodyPublicKeyBase64: platformBodyPublicKey,    // platform X25519 public key, base64
  platformWebhookPublicKeys: {                           // keyId -> platform Ed25519 public key, base64
    pwhk_20260827_01: platformWebhookPublicKey,
  },
});

const order = await client.createPayment({
  merchantOrderNo: 'M20260101001',
  currency: 'BRL',
  amount: '100.00',                                  // decimal string, never a number
  paymentMethod: { code: 'PIX', pix: { payerName: 'Joao Silva' } },
  webhookUrl: 'https://merchant.example/webhook/payments',
});
console.log(order.orderNo, order.status, order.action?.url);
```

### Two kinds of failure, opposite handling

| Error | Meaning | Handling |
| --- | --- | --- |
| `RequestError` | Rejected **before it was sent** (local validation, a bad parameter, or a request the SDK could not encode or sign) | Safe to mark failed; fix the request and retry under the same `merchantOrderNo` |
| `TransportError` | Handed to the transport, no usable response (connection failure, timeout, interrupted read) | Outcome unknown; **never mark a payout failed**. Query by `merchantOrderNo`, or resend the identical request under the same number |
| `APIError` | The gateway returned a business error (`msg` / `apiMessage` / `traceId`) | Branch on `msg`. `IDEMPOTENCY_CONFLICT`: the number is taken but the platform could not return its order, query that number and keep querying rather than switching numbers. `CHANNEL_ERROR`: the order may already exist, query by `merchantOrderNo` first and reuse that number only once the query returns `ORDER_NOT_FOUND`. `CHANNEL_BUSY`: refused before the order was created, so resend the same number after a back-off; this is the only channel error that needs no query first |
| `ResponseError` | The gateway or CDN returned something that is not an envelope (HTML 502, ...) | Outcome unknown; query before deciding |
| `ResponseTooLargeError` | A response arrived but exceeded the size limit and was discarded | Outcome unknown; the order was most likely created, query before deciding |
| Anything else | An unexpected error; assume the request may have arrived | Outcome unknown; query before deciding |

**`merchantOrderNo` is the only key that prevents a duplicate order.** A second
create with the same number never creates a second order: the platform answers
with the original order, or with `IDEMPOTENCY_CONFLICT` when it recognises the
number as taken but cannot return that order. The idempotency key travels with the request for tracing and
is **not** a deduplication key.

Two rules follow:

- After an unknown outcome, never allocate a new `merchantOrderNo`. Query the
  existing one, or resend the same request under the same number.
- A resend must carry identical parameters. The platform returns the original
  order without comparing fields, so a changed amount or account silently has no
  effect. To change anything, use a new `merchantOrderNo` and reconcile the
  original order first.

The SDK validates locally before signing (top-level required fields and formats, method
code structure and required extras); the rules are defined in
[`protocol/merchant-api.md`](protocol/merchant-api.md#client-side-validation). Format checks
such as phone number length or email syntax are deliberately left to the gateway so the SDK
never drifts from it.

### Next steps

Querying, idempotent retries and webhook verification are covered by the platform
documentation at <https://docs.joogopay.com>; its examples map one to one onto this SDK.
The wire protocol is in [`protocol/webhook.md`](protocol/webhook.md) and
[`protocol/merchant-api.md`](protocol/merchant-api.md). Key points:

- After a create request times out, query by `merchantOrderNo` first instead of sending
  a new order; a deliberate retry repeats the same call with the same `merchantOrderNo`.
- For webhooks, pass method, path, headers and the **raw, unparsed body bytes** to
  `client.parsePaymentWebhook({ method, path, headers, body })`; the SDK verifies the
  digest, event id, time window and Ed25519 signature. Respond 2xx once handled and
  deduplicate by `eventId`.

## Amounts

Amounts, fees and rates in requests, responses, webhooks, balances, rates and receipts
are **always decimal strings**, e.g. `"100.00"`. Never use floating point.

## Order status

Only six external statuses exist: `PENDING` `PROCESSING` `SUCCEEDED` `FAILED` `EXPIRED`
`CANCELED`.

## Troubleshooting

| Situation | Action |
| --- | --- |
| Create request timed out | Query by `merchantOrderNo`; do not resend a new order |
| Deliberate retry | Call the same method again with the same `merchantOrderNo` and identical parameters; the SDK generates a fresh nonce per request |
| Signature rejected | Check the server clock, accessKey, merchant private key and the public key registered with the platform |
| Body decryption failed | Check that platformBodyKeyId and the public key belong to the current environment |
| Webhook signature rejected | Check that the webhook key set contains the keyid from the header |

## Tests

```
npm test
```

The tests assert directly against the vectors in [`protocol/testdata`](protocol/testdata/):
`Signature-Input`, signature base and signature value are compared byte for byte, and
body encryption is verified by decrypting ciphertext produced by the reference implementation.
