/**
 * Assertions against the shared cross-language protocol vectors.
 * A failure here means this implementation drifted from the protocol;
 * the vectors are the source of truth, not the code.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as p from '../src/protocol.js';

const TESTDATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'protocol', 'testdata');
const load = (rel) => JSON.parse(readFileSync(join(TESTDATA, rel), 'utf8'));
const b64 = (value) => Buffer.from(value, 'base64');

/** Recovers the header map from expected.signatureBase so the test does not fabricate its own inputs. */
function headersFromBase(signatureBase) {
  const names = {
    'content-type': 'Content-Type',
    'content-encryption': p.HEADER_CONTENT_ENCRYPTION,
    'content-digest': p.HEADER_CONTENT_DIGEST,
    'idempotency-key': p.HEADER_IDEMPOTENCY_KEY,
    'merchant-access-key': p.HEADER_MERCHANT_ACCESS_KEY,
    'webhook-event-id': p.HEADER_WEBHOOK_EVENT_ID,
  };
  const headers = {};
  for (const line of signatureBase.split('\n')) {
    const idx = line.indexOf(': ');
    if (idx < 0) continue;
    const key = JSON.parse(line.slice(0, idx));
    if (names[key]) headers[names[key]] = line.slice(idx + 2);
  }
  return headers;
}

for (const [name, covered] of [
  ['signature/001-read-query.json', p.MERCHANT_READ_COVERED],
  ['signature/002-write-envelope.json', p.MERCHANT_WRITE_COVERED],
  ['signature/003-read-raw-query-unicode.json', p.MERCHANT_READ_COVERED],
]) {
  test(`signature vector matches byte for byte: ${name}`, async () => {
    const v = load(name);
    const { input, expected } = v;

    const params = {
      label: p.SIGNATURE_LABEL_MERCHANT,
      covered,
      created: 1787803200,
      expires: 1787803500,
      nonce: input.nonce,
      keyId: '',
      alg: p.SIGNATURE_ALG_ED25519,
    };

    const gotInput = p.signatureInputHeader(params);
    assert.equal(gotInput, expected.signatureInput);
    assert.ok(!gotInput.includes('keyid'), 'merchant signatures carry no keyid');

    const base = p.signatureBase(params, {
      method: input.method,
      path: input.path,
      rawQuery: input.rawQuery,
      headers: headersFromBase(expected.signatureBase),
    });
    assert.equal(base.toString('utf8'), expected.signatureBase);

    // Ed25519 is deterministic, so the signature compares byte for byte
    const signature = await p.signEd25519(
      b64(v.key.merchantPrivateKeyBase64), p.SIGNATURE_LABEL_MERCHANT, base,
    );
    assert.equal(signature, expected.signature);

    await p.verifyEd25519(
      b64(v.key.merchantPublicKeyBase64),
      base,
      p.parseSignature(expected.signature, p.SIGNATURE_LABEL_MERCHANT),
    );
  });
}

// A 32-byte seed and the 64-byte private key must sign identically. libsodium / OpenSSL
// hand merchants the seed while the vectors carry the 64-byte key, so without this
// test the seed path goes unexercised.
for (const [name, covered] of [
  ['signature/001-read-query.json', p.MERCHANT_READ_COVERED],
  ['signature/002-write-envelope.json', p.MERCHANT_WRITE_COVERED],
]) {
  test(`32-byte seed and full private key sign identically: ${name}`, async () => {
    const v = load(name);
    const { input, expected } = v;
    const seed = b64(v.key.merchantPrivateKeySeedBase64);
    const full = b64(v.key.merchantPrivateKeyBase64);
    assert.equal(seed.length, 32);
    assert.equal(full.length, 64);
    assert.ok(full.subarray(0, 32).equals(seed));

    const params = {
      label: p.SIGNATURE_LABEL_MERCHANT,
      covered,
      created: 1787803200,
      expires: 1787803500,
      nonce: input.nonce,
      keyId: '',
      alg: p.SIGNATURE_ALG_ED25519,
    };
    const base = p.signatureBase(params, {
      method: input.method,
      path: input.path,
      rawQuery: input.rawQuery,
      headers: headersFromBase(expected.signatureBase),
    });

    for (const key of [seed, full]) {
      assert.equal(
        await p.signEd25519(key, p.SIGNATURE_LABEL_MERCHANT, base),
        expected.signature,
      );
    }
  });
}

test('Client accepts both a 32-byte seed and a 64-byte private key', async () => {
  const { Client } = await import('../src/index.js');
  const v = load('signature/001-read-query.json');
  for (const key of [v.key.merchantPrivateKeySeedBase64, v.key.merchantPrivateKeyBase64]) {
    new Client({
      baseUrl: 'https://api.example.com',
      accessKey: v.input.accessKey,
      merchantPrivateKeyBase64: key,
      platformBodyKeyId: 'bodykey_1',
      platformBodyPublicKeyBase64: Buffer.alloc(32).toString('base64'),
      platformWebhookPublicKeys: { whk_1: v.key.merchantPublicKeyBase64 },
    });
  }
});

test('Signature-Input round-trips through parse and format', () => {
  const v = load('signature/001-read-query.json');
  const params = p.parseMerchantReadSignatureInput(v.expected.signatureInput);
  assert.equal(params.nonce, v.input.nonce);
  assert.equal(params.keyId, '', 'merchant params carry no keyId');
  assert.equal(p.signatureInputHeader(params), v.expected.signatureInput);
});

test('merchant Signature-Input rejects keyid', () => {
  const tampered = load('signature/001-read-query.json').expected.signatureInput
    .replace(';alg="ed25519"', ';keyid="mkey_x";alg="ed25519"');
  assert.throws(() => p.parseMerchantReadSignatureInput(tampered), p.InvalidHeaderError);
});

test('body vector: decrypts to the expected plaintext', async () => {
  const v = load('bodycrypt/001-sealed-box.json');
  const wire = Buffer.from(JSON.stringify(v.envelope), 'utf8');

  assert.equal(p.peekBodyEnvelopeKeyId(wire), v.keyId);

  const { plaintext, keyId } = await p.openBodyEnvelope(
    wire, b64(v.platformBodyPublicKeyBase64), b64(v.platformBodyPrivateKeyBase64),
  );
  assert.deepEqual(plaintext, b64(v.plaintextBase64));
  assert.equal(keyId, v.keyId);

  await assert.rejects(
    () => p.openBodyEnvelope(wire, Buffer.alloc(32, 0x44), Buffer.alloc(32, 0x44)),
    p.InvalidEnvelopeError,
  );

  const tamperedCiphertext = b64(v.envelope.ciphertext);
  tamperedCiphertext[tamperedCiphertext.length - 1] ^= 0x01;
  const tamperedWire = Buffer.from(JSON.stringify({
    ...v.envelope,
    ciphertext: tamperedCiphertext.toString('base64'),
  }), 'utf8');
  await assert.rejects(
    () => p.openBodyEnvelope(
      tamperedWire, b64(v.platformBodyPublicKeyBase64), b64(v.platformBodyPrivateKeyBase64),
    ),
    p.InvalidEnvelopeError,
  );
});

test('body round trip: sealed box ciphertext is randomized, so only a round trip can be checked', async () => {
  const v = load('bodycrypt/001-sealed-box.json');
  const plaintext = b64(v.plaintextBase64);

  const wire = await p.sealBodyEnvelope(plaintext, b64(v.platformBodyPublicKeyBase64), v.keyId);
  const envelope = JSON.parse(wire.toString('utf8'));
  assert.equal(envelope.version, 1);
  assert.equal(envelope.alg, p.CONTENT_ENCRYPTION);
  assert.equal(envelope.keyId, v.keyId);

  const opened = await p.openBodyEnvelope(
    wire, b64(v.platformBodyPublicKeyBase64), b64(v.platformBodyPrivateKeyBase64),
  );
  assert.deepEqual(opened.plaintext, plaintext);
  assert.equal(opened.keyId, v.keyId);
});

test('envelope rejects algorithm drift and extra fields', () => {
  const v = load('bodycrypt/001-sealed-box.json');
  const wrongAlg = Buffer.from(JSON.stringify({ ...v.envelope, alg: 'aes-gcm' }), 'utf8');
  assert.throws(() => p.decodeBodyEnvelope(wrongAlg), p.InvalidEnvelopeError);

  const extra = Buffer.from(JSON.stringify({ ...v.envelope, unexpected: 'x' }), 'utf8');
  assert.throws(() => p.decodeBodyEnvelope(extra), p.InvalidEnvelopeError);
});

test('empty-object POST vector: encryption, digest and signature match byte for byte', async () => {
  const v = load('empty-object-post/001-empty-object.json');
  const wire = Buffer.from(JSON.stringify(v.envelope), 'utf8');
  assert.equal(v.plaintext, '{}');
  assert.equal(p.contentDigestSha256(wire), v.expected.contentDigest);

  const opened = await p.openBodyEnvelope(
    wire,
    b64(v.platformBodyKey.publicKeyBase64),
    b64(v.platformBodyKey.privateKeyBase64),
  );
  assert.equal(opened.plaintext.toString('utf8'), '{}');
  assert.equal(opened.keyId, v.platformBodyKey.keyId);

  const params = {
    label: p.SIGNATURE_LABEL_MERCHANT,
    covered: p.MERCHANT_WRITE_COVERED,
    created: 1787803200,
    expires: 1787803500,
    nonce: v.input.nonce,
    keyId: '',
    alg: p.SIGNATURE_ALG_ED25519,
  };
  assert.equal(p.signatureInputHeader(params), v.expected.signatureInput);
  const base = p.signatureBase(params, {
    method: v.input.method,
    path: v.input.path,
    rawQuery: v.input.rawQuery,
    headers: headersFromBase(v.expected.signatureBase),
  });
  assert.equal(base.toString('utf8'), v.expected.signatureBase);
  assert.equal(
    await p.signEd25519(
      b64(v.merchantKey.merchantPrivateKeyBase64), p.SIGNATURE_LABEL_MERCHANT, base,
    ),
    v.expected.signature,
  );
  await assert.rejects(
    () => p.sealBodyEnvelope(
      Buffer.alloc(0), b64(v.platformBodyKey.publicKeyBase64), v.platformBodyKey.keyId,
    ),
    p.InvalidEnvelopeError,
  );
});

test('webhook vector: signature base matches byte for byte and the signature verifies', async () => {
  const v = load('webhook/001-payment-succeeded.json');
  const body = Buffer.from(v.body, 'utf8');
  const { headers } = v;

  assert.equal(p.contentDigestSha256(body), headers['Content-Digest']);
  assert.ok(p.verifyContentDigest(body, headers['Content-Digest']));

  const params = p.parsePlatformSignatureInput(headers['Signature-Input']);
  assert.equal(params.keyId, v.key.platformWebhookKeyId, 'platform params keep keyId');

  const base = p.signatureBase(params, {
    method: v.input.method,
    path: v.input.path,
    rawQuery: v.input.rawQuery,
    headers,
  });
  assert.equal(base.toString('utf8'), v.expected.signatureBase);

  await p.verifyEd25519(
    b64(v.key.platformWebhookPublicKeyBase64),
    base,
    p.parseSignature(headers.Signature, p.SIGNATURE_LABEL_PLATFORM),
  );
  await assert.rejects(
    () => p.verifyEd25519(
      Buffer.alloc(32, 0x55),
      base,
      p.parseSignature(headers.Signature, p.SIGNATURE_LABEL_PLATFORM),
    ),
    p.InvalidSignatureError,
  );

  p.validateWebhookEventId(headers['Webhook-Event-Id']);
  assert.equal(JSON.parse(v.body).eventId, headers['Webhook-Event-Id']);
});

test('webhook rejects a tampered amount', async () => {
  const v = load('webhook/001-payment-succeeded.json');
  const { headers } = v;
  const params = p.parsePlatformSignatureInput(headers['Signature-Input']);
  const tampered = Buffer.from(v.body.replace('"100.50"', '"999.00"'), 'utf8');

  assert.ok(!p.verifyContentDigest(tampered, headers['Content-Digest']));

  const base = p.signatureBase(params, {
    method: v.input.method,
    path: v.input.path,
    rawQuery: v.input.rawQuery,
    headers: { ...headers, 'Content-Digest': p.contentDigestSha256(tampered) },
  });
  await assert.rejects(
    () => p.verifyEd25519(
      b64(v.key.platformWebhookPublicKeyBase64),
      base,
      p.parseSignature(headers.Signature, p.SIGNATURE_LABEL_PLATFORM),
    ),
    p.InvalidSignatureError,
  );
});

test('UUID v4 rules', () => {
  assert.ok(p.validUuidV4('b7754a6c-4a9c-4cf0-b77f-6f2d4b7e5f5a'));
  assert.ok(p.validUuidV4(p.newNonce()));
  assert.ok(!p.validUuidV4('B7754A6C-4A9C-4CF0-B77F-6F2D4B7E5F5A'), 'lowercase only');
  assert.ok(!p.validUuidV4('b7754a6c-4a9c-1cf0-b77f-6f2d4b7e5f5a'), 'version nibble must be 4');
  assert.ok(!p.validUuidV4('b7754a6c-4a9c-4cf0-c77f-6f2d4b7e5f5a'), 'variant nibble must be 8/9/a/b');
});

test('webhook event id rules', () => {
  p.validateWebhookEventId('evt_00000000000000000000000001');
  for (const bad of ['evt_0000', 'xxx_00000000000000000000000001',
    'evt_0000000000000000000000000I']) {
    assert.throws(() => p.validateWebhookEventId(bad), p.InvalidHeaderError);
  }
});

test('GET query allowlist', () => {
  p.validateMerchantReadQuery('orderNo=P202608270001');
  p.validateMerchantReadQuery('currency=BRL&payMethod=PIX');
  for (const bad of ['secret=1', 'orderNo=', 'orderNo=a&orderNo=b', 'orderNo=%zz']) {
    assert.throws(() => p.validateMerchantReadQuery(bad), p.InvalidHeaderError);
  }
});

test('signature time window', () => {
  const params = p.newMerchantReadSignatureParams(p.newNonce(), 1787803200);
  assert.equal(params.expires - params.created, p.MAX_SIGNATURE_LIFETIME);
  p.validateFreshness(params, 1787803200);
  p.validateFreshness(params, 1787803500);
  assert.throws(() => p.validateFreshness(params, 1787803501), p.ExpiredSignatureError);
  assert.throws(
    () => p.validateFreshness(params, 1787803200 - p.MAX_SIGNATURE_LIFETIME - 1),
    p.ExpiredSignatureError,
  );
});
