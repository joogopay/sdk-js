# Body encryption (X25519 sealed box)

Every `POST` (write) body is a sealed-box envelope encrypted to the platform's
X25519 public key. There is no plaintext mode. `GET` reads carry no body and no
encryption. Webhooks are signed but not encrypted.

`alg` is `sealedbox-v1-x25519-xsalsa20poly1305` — libsodium `crypto_box_seal`
(NaCl anonymous box): a fresh ephemeral X25519 key pair per message, key exchange
to the platform public key, XSalsa20-Poly1305 authenticated encryption. The
sealed output already carries the ephemeral public key and the authentication
tag, so no separate `nonce`/`iv`/`tag` is transmitted. The ciphertext is
non-deterministic.

## Envelope

The wire body is this JSON object, and nothing else:

```json
{
  "version": 1,
  "alg": "sealedbox-v1-x25519-xsalsa20poly1305",
  "keyId": "body_20260827_01",
  "ciphertext": "<base64(sealed-box output)>"
}
```

| Field | Rule |
|---|---|
| `version` | fixed `1` |
| `alg` | fixed, and equal to the `Content-Encryption` header |
| `keyId` | platform body public-key id; selects the private key the gateway decrypts with |
| `ciphertext` | standard base64 of the sealed-box output |

The merchant identity is not in the envelope; it is bound by the outer Ed25519
request signature. `Content-Digest` is computed over the envelope bytes (the wire
body), not the plaintext.

## Limits

- Plaintext (business JSON): at most 1 MiB. SDKs reject larger before sealing.
- Wire body (envelope): at most 2 MiB.

## Decryption (gateway)

1. Parse the envelope strictly (reject unknown fields and trailing content).
2. Check `version`, `alg`, non-empty `keyId` and `ciphertext`.
3. Select the platform private key for `keyId`.
4. `crypto_box_seal_open`; reject on failure or if the plaintext is empty or over 1 MiB.

Fixed vectors: [`testdata/bodycrypt/`](./testdata/bodycrypt/). Because the sealed
box is non-deterministic, a vector provides the platform key pair, the plaintext,
and a sample envelope; conformance is that opening the envelope yields the
plaintext, and that a freshly sealed envelope also opens to the plaintext.
