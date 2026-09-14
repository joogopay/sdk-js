/**
 * Protocol core: merchant request signing and platform webhook verification.
 * The protocol specification is the source of truth; the shared cross-language
 * test vectors guard byte-for-byte compatibility with the other SDKs.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';

import { SDKError } from './errors.js';

// libsodium-wrappers 0.7 ships a broken ESM entry (it imports a libsodium.mjs
// that is not in its own dist); the CJS entry works, hence createRequire.
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers');

/** libsodium is wasm and initializes asynchronously; every function that uses it awaits this first. */
export const sodiumReady = sodium.ready.then(() => sodium);

export const HEADER_MERCHANT_ACCESS_KEY = 'Merchant-Access-Key';
export const HEADER_WEBHOOK_EVENT_ID = 'Webhook-Event-Id';
export const HEADER_CONTENT_ENCRYPTION = 'Content-Encryption';
export const HEADER_CONTENT_DIGEST = 'Content-Digest';
export const HEADER_IDEMPOTENCY_KEY = 'Idempotency-Key';
export const HEADER_SIGNATURE_INPUT = 'Signature-Input';
export const HEADER_SIGNATURE = 'Signature';

export const SIGNATURE_LABEL_MERCHANT = 'merchant';
export const SIGNATURE_LABEL_PLATFORM = 'platform';
export const SIGNATURE_ALG_ED25519 = 'ed25519';
export const CONTENT_ENCRYPTION = 'sealedbox-v1-x25519-xsalsa20poly1305';

export const MAX_PLAIN_BODY_BYTES = 1 << 20;
export const MAX_WIRE_BODY_BYTES = 2 << 20;
export const MAX_SIGNATURE_LIFETIME = 300; // seconds
export const X25519_PUBLIC_KEY_SIZE = 32;
export const X25519_PRIVATE_KEY_SIZE = 32;
export const ED25519_PUBLIC_KEY_SIZE = 32;
export const ED25519_SIGNATURE_SIZE = 64;

// Covered components in signature-base order; the protocol fixes both the set and the order.
export const MERCHANT_WRITE_COVERED = Object.freeze([
  '@method', '@path', 'content-type', 'content-encryption',
  'content-digest', 'idempotency-key', 'merchant-access-key',
]);
export const MERCHANT_READ_COVERED = Object.freeze([
  '@method', '@path', '@query', 'merchant-access-key',
]);
export const PLATFORM_COVERED = Object.freeze([
  '@method', '@path', '@query', 'content-type', 'content-digest', 'webhook-event-id',
]);

// Public locator fields only: GET queries are not encrypted.
export const ALLOWED_READ_QUERY_FIELDS = new Set([
  'orderNo', 'merchantOrderNo', 'currency', 'payMethod', 'status',
  'startTime', 'endTime', 'page', 'pageSize', 'consentNo',
  'subscriptionPaymentNo', 'planNo', 'merchantPlanNo', 'merchantCustomerNo',
  'subscriptionNo', 'merchantSubscriptionNo', 'invoiceNo',
]);

const CROCKFORD32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export class ProtocolError extends SDKError {
  constructor(message) { super(message); this.name = new.target.name; }
}
export class InvalidHeaderError extends ProtocolError {}
export class InvalidEnvelopeError extends ProtocolError {}
export class InvalidSignatureError extends ProtocolError {}
export class ExpiredSignatureError extends ProtocolError {}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function makeParams(label, covered, nonce, now, keyId = '') {
  const created = now ?? nowSeconds();
  return Object.freeze({
    label, covered, created,
    expires: created + MAX_SIGNATURE_LIFETIME,
    nonce, keyId,
    alg: SIGNATURE_ALG_ED25519,
  });
}

export const newMerchantWriteSignatureParams = (nonce, now) =>
  makeParams(SIGNATURE_LABEL_MERCHANT, MERCHANT_WRITE_COVERED, nonce, now);
export const newMerchantReadSignatureParams = (nonce, now) =>
  makeParams(SIGNATURE_LABEL_MERCHANT, MERCHANT_READ_COVERED, nonce, now);
export const newPlatformSignatureParams = (keyId, nonce, now) =>
  makeParams(SIGNATURE_LABEL_PLATFORM, PLATFORM_COVERED, nonce, now, keyId);

export const newNonce = () => randomUUID();

/** Protocol values are ASCII without escapes, so JSON.stringify yields the expected quoted form. */
const quote = (value) => JSON.stringify(value);

export function signatureInputValue(params) {
  const components = params.covered.map(quote).join(' ');
  let value = `(${components})`
    + `;created=${params.created}`
    + `;expires=${params.expires}`
    + `;nonce=${quote(params.nonce)}`;
  if (params.label === SIGNATURE_LABEL_PLATFORM) value += `;keyid=${quote(params.keyId)}`;
  return `${value};alg=${quote(params.alg)}`;
}

export function signatureInputHeader(params) {
  validateSignatureParams(params, params.created);
  return `${params.label}=${signatureInputValue(params)}`;
}

const COMPONENT_HEADERS = {
  'content-type': 'Content-Type',
  'content-encryption': HEADER_CONTENT_ENCRYPTION,
  'content-digest': HEADER_CONTENT_DIGEST,
  'idempotency-key': HEADER_IDEMPOTENCY_KEY,
  'merchant-access-key': HEADER_MERCHANT_ACCESS_KEY,
  'webhook-event-id': HEADER_WEBHOOK_EVENT_ID,
};

function componentValue(component, { method, path, rawQuery, headers }) {
  if (component === '@method') return method;
  if (component === '@path') return path || '/';
  if (component === '@query') return `?${rawQuery}`;
  const name = COMPONENT_HEADERS[component];
  if (!name) throw new InvalidHeaderError(`unknown covered component: ${component}`);
  const lowered = Object.fromEntries(
    Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const value = (lowered[name.toLowerCase()] ?? '').trim();
  if (!validHeaderValue(value)) throw new InvalidHeaderError(`missing or invalid header: ${name}`);
  return value;
}

/** Builds the RFC 9421 signature base. */
export function signatureBase(params, { method, path, rawQuery = '', headers = {} }) {
  if (!params.covered?.length) throw new InvalidHeaderError('empty covered components');
  const lines = params.covered.map(
    (c) => `${quote(c)}: ${componentValue(c, { method, path, rawQuery, headers })}`,
  );
  lines.push(`${quote('@signature-params')}: ${signatureInputValue(params)}`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

const validHeaderValue = (value) =>
  typeof value === 'string' && value !== '' && value.trim() === value
  && !value.includes('\r') && !value.includes('\n');

/** Lowercase UUID v4 only; uppercase hex is rejected. */
export function validUuidV4(value) {
  if (typeof value !== 'string' || value.length !== 36) return false;
  for (let i = 0; i < 36; i += 1) {
    const ch = value[i];
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (ch !== '-') return false;
    } else if (i === 14) {
      if (ch !== '4') return false;
    } else if (i === 19) {
      if (!'89ab'.includes(ch)) return false;
    } else if (!/[0-9a-f]/.test(ch)) return false;
  }
  return true;
}

export function validateIdempotencyKey(value) {
  if (!validUuidV4(value)) {
    throw new InvalidHeaderError('Idempotency-Key must be a lowercase UUID v4');
  }
}

export function validateWebhookEventId(value) {
  if (typeof value !== 'string' || !value.startsWith('evt_') || value.length !== 30) {
    throw new InvalidHeaderError('invalid Webhook-Event-Id');
  }
  for (const ch of value.slice(4)) {
    if (!CROCKFORD32.includes(ch)) throw new InvalidHeaderError('invalid Webhook-Event-Id');
  }
}

/** Only allowlisted fields, each key at most once, no blank values. */
export function validateMerchantReadQuery(rawQuery) {
  if (!rawQuery) return;
  if (/%(?![0-9A-Fa-f]{2})/.test(rawQuery)) {
    throw new InvalidHeaderError('query contains malformed percent-encoding');
  }
  const seen = new Set();
  for (const [key, value] of new URLSearchParams(rawQuery)) {
    if (!ALLOWED_READ_QUERY_FIELDS.has(key) || seen.has(key) || !value.trim()) {
      throw new InvalidHeaderError(`query field not allowed: ${key}`);
    }
    seen.add(key);
  }
}

export function validateFreshness(params, now) {
  if (params.created <= 0 || params.expires <= 0 || params.expires <= params.created
      || params.expires - params.created > MAX_SIGNATURE_LIFETIME) {
    throw new ExpiredSignatureError('invalid signature lifetime');
  }
  if (now < params.created - MAX_SIGNATURE_LIFETIME || now > params.expires) {
    throw new ExpiredSignatureError('signature expired');
  }
}

const sameComponents = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function coveredComponentsAllowed(label, covered) {
  if (label === SIGNATURE_LABEL_MERCHANT) {
    return sameComponents(covered, MERCHANT_WRITE_COVERED)
      || sameComponents(covered, MERCHANT_READ_COVERED);
  }
  if (label === SIGNATURE_LABEL_PLATFORM) return sameComponents(covered, PLATFORM_COVERED);
  return false;
}

export function validateSignatureParams(params, now) {
  if (!params.label || params.alg !== SIGNATURE_ALG_ED25519 || !validUuidV4(params.nonce)) {
    throw new InvalidHeaderError('invalid signature params');
  }
  if (params.label === SIGNATURE_LABEL_PLATFORM) {
    if (!validHeaderValue(params.keyId)) {
      throw new InvalidHeaderError('platform signature requires keyid');
    }
  } else if (params.label !== SIGNATURE_LABEL_MERCHANT) {
    throw new InvalidHeaderError('unknown signature label');
  }
  if (!coveredComponentsAllowed(params.label, params.covered)) {
    throw new InvalidHeaderError('covered components not allowed');
  }
  validateFreshness(params, now);
}

export function parseSignatureInput(value, label, covered) {
  const prefix = `${label}=(`;
  if (typeof value !== 'string' || !value.startsWith(prefix)) {
    throw new InvalidHeaderError('bad Signature-Input label');
  }
  const closing = value.indexOf(')');
  if (closing < 0 || closing + 1 >= value.length || value[closing + 1] !== ';') {
    throw new InvalidHeaderError('bad Signature-Input components');
  }
  const rawComponents = value.slice(prefix.length, closing).split(/\s+/).filter(Boolean);
  if (rawComponents.length !== covered.length) {
    throw new InvalidHeaderError('covered components mismatch');
  }
  rawComponents.forEach((raw, i) => {
    if (JSON.parse(raw) !== covered[i]) {
      throw new InvalidHeaderError('covered components mismatch');
    }
  });

  const parts = value.slice(closing + 2).split(';');
  const expected = label === SIGNATURE_LABEL_PLATFORM ? 5 : 4;
  if (parts.length !== expected) throw new InvalidHeaderError('bad Signature-Input params');

  const got = {};
  for (const part of parts) {
    const idx = part.indexOf('=');
    const key = idx > 0 ? part.slice(0, idx) : '';
    if (!key || key in got) throw new InvalidHeaderError('bad Signature-Input params');
    got[key] = part.slice(idx + 1);
  }
  for (const key of Object.keys(got)) {
    if (!['created', 'expires', 'nonce', 'keyid', 'alg'].includes(key)) {
      throw new InvalidHeaderError(`unknown Signature-Input param: ${key}`);
    }
  }
  if ('keyid' in got && label !== SIGNATURE_LABEL_PLATFORM) {
    throw new InvalidHeaderError('merchant signature must not carry keyid');
  }
  const created = Number(got.created);
  const expires = Number(got.expires);
  if (!Number.isInteger(created) || !Number.isInteger(expires)) {
    throw new InvalidHeaderError('bad Signature-Input params');
  }
  return Object.freeze({
    label,
    covered,
    created,
    expires,
    nonce: JSON.parse(got.nonce),
    alg: JSON.parse(got.alg),
    keyId: 'keyid' in got ? JSON.parse(got.keyid) : '',
  });
}

export const parseMerchantWriteSignatureInput = (value) =>
  parseSignatureInput(value, SIGNATURE_LABEL_MERCHANT, MERCHANT_WRITE_COVERED);
export const parseMerchantReadSignatureInput = (value) =>
  parseSignatureInput(value, SIGNATURE_LABEL_MERCHANT, MERCHANT_READ_COVERED);
export const parsePlatformSignatureInput = (value) =>
  parseSignatureInput(value, SIGNATURE_LABEL_PLATFORM, PLATFORM_COVERED);

/** RFC 9530 Content-Digest value (sha-256). */
export const contentDigestSha256 = (body) =>
  `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;

export function verifyContentDigest(body, header) {
  const want = Buffer.from(contentDigestSha256(body));
  const got = Buffer.from(String(header ?? ''));
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Accepts a 32-byte seed or the 64-byte seed||pub form libsodium works with. */
function normalizePrivateKey(privateKey, s) {
  const key = Buffer.from(privateKey);
  if (key.length === 64) return key;
  if (key.length === 32) return Buffer.from(s.crypto_sign_seed_keypair(key).privateKey);
  throw new InvalidSignatureError('ed25519 private key must be 32 or 64 bytes');
}

export async function signEd25519(privateKey, label, base) {
  const s = await sodiumReady;
  if (!label || !base?.length) throw new InvalidSignatureError('empty label or signature base');
  const signature = s.crypto_sign_detached(base, normalizePrivateKey(privateKey, s));
  return signatureHeader(label, Buffer.from(signature));
}

export async function verifyEd25519(publicKey, base, signature) {
  const s = await sodiumReady;
  if (publicKey?.length !== ED25519_PUBLIC_KEY_SIZE || !base?.length
      || signature?.length !== ED25519_SIGNATURE_SIZE) {
    throw new InvalidSignatureError('invalid ed25519 verify input');
  }
  if (!s.crypto_sign_verify_detached(signature, base, publicKey)) {
    throw new InvalidSignatureError('signature verification failed');
  }
}

export function signatureHeader(label, signature) {
  if (!validHeaderValue(label) || signature?.length !== ED25519_SIGNATURE_SIZE) {
    throw new InvalidSignatureError('invalid signature header input');
  }
  return `${label}=:${Buffer.from(signature).toString('base64')}:`;
}

export function parseSignature(value, label) {
  if (!validHeaderValue(label)) throw new InvalidSignatureError('invalid signature label');
  const prefix = `${label}=:`;
  if (typeof value !== 'string' || !value.startsWith(prefix) || !value.endsWith(':')) {
    throw new InvalidSignatureError('malformed Signature header');
  }
  const raw = value.slice(prefix.length, -1);
  const signature = Buffer.from(raw, 'base64');
  if (signature.length !== ED25519_SIGNATURE_SIZE || signature.toString('base64') !== raw) {
    throw new InvalidSignatureError('malformed Signature header');
  }
  return signature;
}

/** Seals the plaintext POST body with the platform X25519 public key and returns the wire body. */
export async function sealBodyEnvelope(plaintext, publicKey, keyId) {
  const s = await sodiumReady;
  if (!plaintext?.length || plaintext.length > MAX_PLAIN_BODY_BYTES) {
    throw new InvalidEnvelopeError('invalid plaintext size');
  }
  if (publicKey?.length !== X25519_PUBLIC_KEY_SIZE || !validHeaderValue(keyId)) {
    throw new InvalidEnvelopeError('invalid platform body key');
  }
  const ciphertext = s.crypto_box_seal(new Uint8Array(plaintext), new Uint8Array(publicKey));
  return Buffer.from(JSON.stringify({
    version: 1,
    alg: CONTENT_ENCRYPTION,
    keyId,
    ciphertext: Buffer.from(ciphertext).toString('base64'),
  }), 'utf8');
}

export function decodeBodyEnvelope(wireBody) {
  if (!wireBody?.length || wireBody.length > MAX_WIRE_BODY_BYTES) {
    throw new InvalidEnvelopeError('invalid envelope size');
  }
  let raw;
  try {
    raw = JSON.parse(Buffer.from(wireBody).toString('utf8'));
  } catch {
    throw new InvalidEnvelopeError('envelope is not valid json');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidEnvelopeError('invalid envelope');
  }
  const keys = Object.keys(raw).sort().join(',');
  if (keys !== 'alg,ciphertext,keyId,version') {
    throw new InvalidEnvelopeError('unexpected envelope fields');
  }
  if (raw.version !== 1 || raw.alg !== CONTENT_ENCRYPTION
      || !validHeaderValue(raw.keyId) || !raw.ciphertext) {
    throw new InvalidEnvelopeError('invalid envelope');
  }
  const ciphertext = Buffer.from(raw.ciphertext, 'base64');
  if (ciphertext.toString('base64') !== raw.ciphertext) {
    throw new InvalidEnvelopeError('invalid envelope ciphertext');
  }
  return { ...raw, ciphertextBytes: ciphertext };
}

export function peekBodyEnvelopeKeyId(wireBody) {
  try {
    return decodeBodyEnvelope(wireBody).keyId;
  } catch {
    return '';
  }
}

/** Opens the envelope with the platform X25519 key pair; returns plaintext and keyId. */
export async function openBodyEnvelope(wireBody, publicKey, privateKey) {
  const s = await sodiumReady;
  if (publicKey?.length !== X25519_PUBLIC_KEY_SIZE
      || privateKey?.length !== X25519_PRIVATE_KEY_SIZE) {
    throw new InvalidEnvelopeError('invalid platform body key pair');
  }
  const envelope = decodeBodyEnvelope(wireBody);
  let plaintext;
  try {
    plaintext = s.crypto_box_seal_open(
      new Uint8Array(envelope.ciphertextBytes),
      new Uint8Array(publicKey),
      new Uint8Array(privateKey),
    );
  } catch {
    throw new InvalidEnvelopeError('envelope decrypt failed');
  }
  if (!plaintext?.length || plaintext.length > MAX_PLAIN_BODY_BYTES) {
    throw new InvalidEnvelopeError('invalid plaintext size');
  }
  return { plaintext: Buffer.from(plaintext), keyId: envelope.keyId };
}
