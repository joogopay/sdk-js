# protocol

Cross-language source of truth. Every language SDK implements this protocol,
passes these test vectors, and generates its enums from `data/`.

English | [简体中文](./README-cn.md)

## Contents

| File | Purpose |
|---|---|
| [merchant-api.md](./merchant-api.md) | endpoint overview and SDK design rules |
| [signature.md](./signature.md) | Ed25519 / RFC 9421 request signing |
| [body-encryption.md](./body-encryption.md) | X25519 sealed-box body envelope |
| [webhook.md](./webhook.md) | webhook payload and platform-signature verification |
| [errors.md](./errors.md) | response envelope, error codes, success rule |
| `data/` | machine-readable enums and rules: methods, currencies, countries, statuses, endpoints, method-rules, request-rules |
| `testdata/` | fixed conformance vectors every SDK must pass |

## Test vectors

| Directory | Content |
|---|---|
| `testdata/signature/` | Ed25519 signing vectors: request, signature base, signature |
| `testdata/bodycrypt/` | sealed-box vectors: key pair, plaintext, envelope |
| `testdata/empty-object-post/` | `{}` plaintext, envelope, digest and signed POST vector |
| `testdata/webhook/` | signed webhook vectors and rejection cases |
| `testdata/responses/` | envelope-decoding vectors (success, APIError, non-JSON) |
| `testdata/validation/` | client-side validation vectors: a valid base request plus accept/reject cases every SDK must agree on |

Signing and webhook vectors are deterministic (fixed keys, `created`, `nonce`).
Sealed-box vectors are round-trip (the ciphertext is non-deterministic), so a
vector supplies the key pair, the plaintext, and a sample envelope.
