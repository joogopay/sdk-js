// Format rules (phone number length, email syntax, IFSC length, ...) are left to
// the gateway: they evolve per currency and channel, a copy here would drift, and
// merchants could only get a fix through an SDK release.

import { RequestError } from './errors.js';
import {
  AMOUNT_PATTERN, CREATE_REQUIRED_TEXT_FIELDS, METHOD_EXTRA_FIELDS,
  PAYMENT_METHOD_RULES, PAYOUT_METHOD_RULES, WEBHOOK_URL_PREFIX,
} from './rules.js';

function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

/**
 * Amounts are positive decimal strings; the gateway rejects JSON numbers.
 * AMOUNT_PATTERN mirrors the gateway regex and the DECIMAL(18,2) cap and already
 * restricts the value to digits and a dot, so "greater than zero" reduces to
 * "contains a non-zero digit".
 */
function validateAmount(field, value) {
  if (value === null || value === undefined || value === '') {
    throw new RequestError(`sdk: required field is empty: ${field}`);
  }
  if (typeof value !== 'string') {
    throw new RequestError(
      `sdk: ${field} must be a decimal string such as "100.00", got ${typeof value}`,
    );
  }
  if (!AMOUNT_PATTERN.test(value)) {
    throw new RequestError(`sdk: ${field} must be a positive decimal string: '${value}'`);
  }
  if (!/[1-9]/.test(value)) {
    throw new RequestError(`sdk: ${field} must be greater than 0`);
  }
}

/** Mirrors the gateway rule: required and https scheme. */
function validateWebhookUrl(field, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RequestError(`sdk: required field is empty: ${field}`);
  }
  if (!value.toLowerCase().startsWith(WEBHOOK_URL_PREFIX)) {
    const scheme = WEBHOOK_URL_PREFIX.replace(/:\/\/$/, '');
    throw new RequestError(`sdk: ${field} must be an absolute ${scheme} URL`);
  }
}

/**
 * Top-level required fields of a create request. Empty values are rejected here
 * so they fail before signing and encryption instead of as a gateway INVALID_FIELD.
 */
export function validateCreateCommon(body) {
  const b = body ?? {};
  for (const field of CREATE_REQUIRED_TEXT_FIELDS) {
    if (isEmpty(b[field])) throw new RequestError(`sdk: required field is empty: ${field}`);
  }
  validateAmount('amount', b.amount);
  validateWebhookUrl('webhookUrl', b.webhookUrl);
}

/**
 * Order number used as a path segment: trimmed and non-empty. The caller
 * percent-encodes it before it enters the signature base.
 */
export function validatePathOrderNo(orderNo) {
  const value = String(orderNo ?? '').trim();
  if (!value) throw new RequestError('sdk: invalid path parameter');
  return value;
}

function validateMethod(currency, method, rules) {
  const m = method ?? {};
  const code = String(m.code ?? '').trim();
  if (!code) throw new RequestError('sdk: method code is required');

  const present = Object.keys(m)
    .filter((k) => k !== 'code' && m[k] !== null && m[k] !== undefined)
    .sort();
  if (present.length > 1) {
    throw new RequestError(`sdk: only one method extra may be set: ${present.join(', ')}`);
  }
  const want = METHOD_EXTRA_FIELDS[code];
  if (present.length === 1 && want && present[0] !== want) {
    throw new RequestError(
      `sdk: method extra does not match code: ${code} expects '${want}', got '${present[0]}'`,
    );
  }

  const rule = rules[String(currency ?? '').trim().toUpperCase()];
  // Currencies missing from the table are left to the gateway: the SDK table may lag behind it.
  if (!rule) return;
  if (rule.codes.length && !rule.codes.includes(code)) {
    throw new RequestError(
      `sdk: method is not available for this currency: ${code} for ${currency}`,
    );
  }

  const need = [...rule.required, ...(rule.byMethod[code] ?? [])];
  const optionalNullableStrings = rule.optionalNullableStringsByMethod?.[code] ?? [];
  if (!need.length && !optionalNullableStrings.length) return;
  const extra = present.length ? m[present[0]] : {};
  if (typeof extra !== 'object' || Array.isArray(extra)) {
    throw new RequestError(`sdk: method extra must be an object: ${present[0]}`);
  }
  for (const field of need) {
    if ((rule.allowEmpty ?? []).includes(field)) {
      if (typeof extra?.[field] !== 'string') {
        throw new RequestError(`sdk: extra.${field} must be a string for ${currency} ${code}`);
      }
      continue;
    }
    if (isEmpty(extra?.[field])) {
      throw new RequestError(
        `sdk: required extra field is empty: extra.${field} for ${currency} ${code}`,
      );
    }
  }
  for (const field of optionalNullableStrings) {
    const value = extra?.[field];
    if (value !== null && value !== undefined && typeof value !== 'string') {
      throw new RequestError(`sdk: extra.${field} must be a string or null for ${currency} ${code}`);
    }
  }
}

export function validatePaymentMethod(currency, method) {
  validateMethod(currency, method, PAYMENT_METHOD_RULES);
}

export function validatePayoutMethod(currency, method) {
  validateMethod(currency, method, PAYOUT_METHOD_RULES);
}
