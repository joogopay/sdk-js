/**
 * End-to-end client tests against a fake gateway on node:http: the wire shape
 * of signed requests, the response vectors and the full webhook path.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as sdk from '../src/index.js';
import * as p from '../src/protocol.js';

const TESTDATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'protocol', 'testdata');
const load = (rel) => JSON.parse(readFileSync(join(TESTDATA, rel), 'utf8'));
const b64 = (v) => Buffer.from(v, 'base64');

const SIG = load('signature/001-read-query.json');
const BODY = load('bodycrypt/001-sealed-box.json');
const HOOK = load('webhook/001-payment-succeeded.json');

let server;
let baseUrl;
let captured = {};
let nextResponse = {};

before(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      captured = {
        method: req.method,
        path: req.url,
        headers: { ...req.headers },
        body: Buffer.concat(chunks),
      };
      const payload = nextResponse.body ?? { code: 200, msg: 'OK', data: {} };
      const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
      res.writeHead(nextResponse.status ?? 200, {
        'Content-Type': nextResponse.ctype ?? 'application/json',
        'Content-Length': raw.length,
      });
      res.end(raw);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `https://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

function makeClient(overrides = {}) {
  return new sdk.Client({
    baseUrl,
    accessKey: 'mak_live_test',
    merchantPrivateKeyBase64: SIG.key.merchantPrivateKeyBase64,
    platformBodyKeyId: BODY.keyId,
    platformBodyPublicKeyBase64: BODY.platformBodyPublicKeyBase64,
    platformWebhookPublicKeys: {
      [HOOK.key.platformWebhookKeyId]: HOOK.key.platformWebhookPublicKeyBase64,
    },
    fetchImpl: (url, options) => fetch(url.replace(/^https:/, 'http:'), options),
    ...overrides,
  });
}

test('createPayment: wire shape and server-side decryption round trip', async () => {
  nextResponse = {
    body: {
      code: 200,
      msg: 'OK',
      data: { orderNo: 'ORD001', status: 'PENDING', amount: '100.00', currency: 'BRL' },
    },
  };
  const order = await makeClient().createPayment({
    merchantOrderNo: 'M202608270001',
    currency: 'BRL',
    amount: '100.00',
    paymentMethod: { code: 'PIX', pix: { payerCPF: '12345678901' } },
    webhookUrl: 'https://merchant.example.com/webhook/payments',
  });
  assert.equal(order.orderNo, 'ORD001');
  assert.equal(order.amount, '100.00');

  const h = captured.headers;
  assert.equal(captured.method, 'POST');
  assert.ok(!captured.path.includes('?'), 'POST carries no query');
  assert.equal(h['content-type'], 'application/json');
  assert.equal(h['content-encryption'], p.CONTENT_ENCRYPTION);
  assert.ok(p.validUuidV4(h['idempotency-key']));
  assert.equal(h['merchant-access-key'], 'mak_live_test');
  assert.ok(h['signature-input'].startsWith('merchant=('));
  assert.ok(!h['signature-input'].includes('keyid'), 'merchant requests carry no keyId');
  assert.ok(h.signature.startsWith('merchant=:'));

  // Content-Digest is computed over the envelope, not the plaintext
  assert.equal(h['content-digest'], p.contentDigestSha256(captured.body));
  const envelope = JSON.parse(captured.body.toString('utf8'));
  assert.equal(envelope.alg, p.CONTENT_ENCRYPTION);
  assert.equal(envelope.keyId, BODY.keyId);

  const opened = await p.openBodyEnvelope(
    captured.body,
    b64(BODY.platformBodyPublicKeyBase64),
    b64(BODY.platformBodyPrivateKeyBase64),
  );
  assert.equal(opened.keyId, BODY.keyId);
  assert.deepEqual(JSON.parse(opened.plaintext.toString('utf8')), {
    merchantOrderNo: 'M202608270001',
    currency: 'BRL',
    amount: '100.00',
    paymentMethod: { code: 'PIX', pix: { payerCPF: '12345678901' } },
    webhookUrl: 'https://merchant.example.com/webhook/payments',
  });
});

test('idempotency key is reused across retries', async () => {
  nextResponse = {};
  const client = makeClient();
  const key = p.newNonce();
  const req = {
    merchantOrderNo: 'M1', currency: 'BRL', amount: '1.00',
    payoutMethod: { code: 'PIX', pix: { keyType: 'CPF', key: '12345678901' } },
    webhookUrl: 'https://m.example.com/w',
  };
  await client.createPayout(req, { idempotencyKey: key });
  const first = captured.headers['idempotency-key'];
  await client.createPayout(req, { idempotencyKey: key });
  assert.equal(first, key);
  assert.equal(captured.headers['idempotency-key'], key);
});

test('query: GET has no body and no write-only headers', async () => {
  nextResponse = { body: { code: 200, msg: 'OK', data: { orderNo: 'ORD001' } } };
  await makeClient().queryPaymentByOrderNo('P202608270001');

  assert.equal(captured.method, 'GET');
  assert.equal(captured.path, '/api/v1/payments?orderNo=P202608270001');
  assert.equal(captured.body.length, 0);
  for (const absent of ['content-type', 'content-encryption', 'content-digest',
    'idempotency-key']) {
    assert.ok(!(absent in captured.headers), `GET must not carry ${absent}`);
  }
  assert.ok(!captured.headers['signature-input'].includes('keyid'));
});

test('query: blank query parameter is rejected', async () => {
  await assert.rejects(() => makeClient().queryPaymentByOrderNo('   '), sdk.RequestError);
});

test('balance and usd rate hit the current paths, not the legacy ones', async () => {
  nextResponse = { body: { code: 200, msg: 'OK', data: { balance: '10.00' } } };
  await makeClient().getBalance('BRL');
  assert.ok(captured.path.startsWith('/api/v1/balances?'));

  nextResponse = { body: { code: 200, msg: 'OK', data: { usdRate: '5.40' } } };
  const rate = await makeClient().getUsdRate('BRL', 'PIX');
  assert.ok(captured.path.startsWith('/api/v1/usd-rates?'));
  assert.equal(rate.usdRate, '5.40');
});

test('receipt: path parameter is escaped and no query is sent', async () => {
  nextResponse = {
    body: { code: 200, msg: 'OK', data: { orderNo: 'ORD/001', amount: '100.00' } },
  };
  const receipt = await makeClient().getPayoutReceipt('ORD/001');
  assert.equal(captured.path, '/api/v1/payouts/ORD%2F001/receipt');
  assert.ok(!captured.path.includes('?'));
  assert.equal(receipt.amount, '100.00');
});

test('receipt: empty order number is rejected', () => {
  assert.throws(() => makeClient().getPayoutReceipt(''), sdk.RequestError);
});

test('response vector 001: success', async () => {
  const v = load('responses/001-success-payment-order.json');
  nextResponse = { status: v.httpStatus, body: v.body };
  const order = await makeClient().queryPaymentByOrderNo('ORD202605190001');
  assert.equal(order.orderNo, 'ORD202605190001');
  assert.equal(order.status, sdk.STATUS_SUCCEEDED);
  assert.equal(order.action.qrCode, '00020-qr');
});

test('response vector 002: business error decodes to APIError', async () => {
  const v = load('responses/002-api-error-order-not-found.json');
  nextResponse = { status: v.httpStatus, body: v.body };
  await assert.rejects(
    () => makeClient().queryPaymentByOrderNo('missing'),
    (err) => {
      assert.ok(err instanceof sdk.APIError);
      assert.equal(err.httpStatus, v.expectedFields.HTTPStatus);
      assert.equal(err.code, v.expectedFields.Code);
      assert.equal(err.msg, v.expectedFields.Msg);
      assert.equal(err.apiMessage, v.expectedFields.Message);
      assert.equal(err.traceId, v.expectedFields.TraceID);
      return true;
    },
  );
});

test('response vector 003: HTTP 200 with a non-200 envelope code still fails', async () => {
  const v = load('responses/003-http-200-envcode-not-ok.json');
  nextResponse = { status: v.httpStatus, body: v.body };
  await assert.rejects(
    () => makeClient().queryPaymentByOrderNo('drift'),
    (err) => err instanceof sdk.APIError && err.httpStatus === 200 && err.code === 12100099,
  );
});

// An order object with no orderNo would be recorded as a successful payout.
test('a success envelope without data is a ResponseError', async () => {
  nextResponse = { status: 200, body: Buffer.from('{"code":200,"msg":"OK","data":null}'), ctype: 'application/json' };
  await assert.rejects(
    () => makeClient().queryPaymentByOrderNo('P1'),
    (err) => err instanceof sdk.ResponseError,
  );
});

test('response vector 004: non-JSON response decodes to ResponseError', async () => {
  const v = load('responses/004-non-json-body.json');
  nextResponse = {
    status: v.httpStatus,
    body: readFileSync(join(TESTDATA, 'responses', v.bodyFile)),
    ctype: 'text/html',
  };
  await assert.rejects(
    () => makeClient().queryPaymentByOrderNo('boom'),
    (err) => err instanceof sdk.ResponseError
      && err.httpStatus === v.expectedFields.HTTPStatus,
  );
});

test('response vector money fields are decimal strings', () => {
  const dir = join(TESTDATA, 'responses');
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const data = JSON.parse(readFileSync(join(dir, name), 'utf8'))?.body?.data;
    if (!data || typeof data !== 'object') continue;
    for (const field of sdk.MONEY_FIELDS) {
      if (field in data) {
        assert.equal(typeof data[field], 'string',
          `${name}: ${field}=${JSON.stringify(data[field])} must be a decimal string`);
      }
    }
  }
});

const hookArgs = {
  method: HOOK.input.method,
  path: HOOK.input.path,
  rawQuery: HOOK.input.rawQuery,
  headers: HOOK.headers,
  body: Buffer.from(HOOK.body, 'utf8'),
};

test('parses a payment webhook', async () => {
  const hook = await makeClient({ now: () => 1787803300 }).parsePaymentWebhook(hookArgs);
  assert.equal(hook.eventId, HOOK.headers['Webhook-Event-Id']);
  assert.equal(hook.orderType, 'PAYMENT');
  assert.equal(hook.status, sdk.STATUS_SUCCEEDED);
  assert.equal(hook.amount, '100.50');
  assert.equal(hook.paidAmount, '100.50');
});

test('webhook rejects an unknown keyId', async () => {
  const client = makeClient({
    now: () => 1787803300,
    platformWebhookPublicKeys: { wk_other: HOOK.key.platformWebhookPublicKeyBase64 },
  });
  await assert.rejects(() => client.parsePaymentWebhook(hookArgs),
    (err) => err instanceof sdk.WebhookError && /platform key not found/.test(err.message));
});

test('webhook rejects an expired signature', async () => {
  await assert.rejects(
    () => makeClient({ now: () => 1787803501 }).parsePaymentWebhook(hookArgs),
    p.ExpiredSignatureError,
  );
});

test('webhook rejects a mismatched order type', async () => {
  await assert.rejects(
    () => makeClient({ now: () => 1787803300 }).parsePayoutWebhook(hookArgs),
    sdk.WebhookError,
  );
});

test('webhook rejects an eventId that differs from the header', async () => {
  await assert.rejects(
    () => makeClient({ now: () => 1787803300 }).parsePaymentWebhook({
      ...hookArgs,
      headers: { ...HOOK.headers, 'Webhook-Event-Id': 'evt_0000000000000000000000000Z' },
    }),
    sdk.WebhookError,
  );
});

for (const [name, override] of [
  ['empty baseUrl', { baseUrl: '' }],
  ['http baseUrl', { baseUrl: 'http://api.example.com' }],
  ['non-https baseUrl scheme', { baseUrl: 'ftp://api.example.com' }],
  ['baseUrl with a path', { baseUrl: 'https://api.example.com/api/v1' }],
  ['baseUrl is not a URL', { baseUrl: 'not-a-url' }],
  ['empty accessKey', { accessKey: '' }],
  ['invalid merchant private key', { merchantPrivateKeyBase64: 'bm90LWEta2V5' }],
  ['empty platformBodyKeyId', { platformBodyKeyId: '' }],
  ['platform body public key has the wrong length', { platformBodyPublicKeyBase64: 'c2hvcnQ=' }],
  ['empty webhook public key set', { platformWebhookPublicKeys: {} }],
]) {
  test(`config validation: ${name}`, () => {
    assert.throws(() => makeClient(override), sdk.ConfigError);
  });
}

test('submitPaymentTradeNo sends plaintext JSON, unsigned and unencrypted', async () => {
  nextResponse = { body: { code: 200, msg: 'OK', data: { status: 1, orderStatus: 'PENDING' } } };
  const got = await makeClient().submitPaymentTradeNo('P1', 'UTR123');

  assert.equal(got.status, 1);
  assert.equal(got.orderStatus, 'PENDING');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.path, '/api/v1/payment/submitTradeNo');
  assert.equal(captured.headers['content-type'], 'application/json');
  assert.equal(captured.headers.signature, undefined);
  assert.equal(captured.headers['content-encryption'], undefined);
  assert.deepEqual(JSON.parse(captured.body.toString()), { orderNo: 'P1', tradeNo: 'UTR123' });
});

test('submitPaymentTradeNo: rejection resolves with status 0 instead of throwing', async () => {
  nextResponse = {
    body: { code: 200, msg: 'OK', data: { status: 0, message: 'too many requests, please retry later' } },
  };
  const got = await makeClient().submitPaymentTradeNo('P1', 'UTR123');

  assert.equal(got.status, 0);
  assert.match(got.message, /too many requests/);
});

test('submitPaymentTradeNo throws on missing parameters', async () => {
  const c = makeClient();
  for (const [orderNo, tradeNo] of [['', 'UTR'], ['P1', ''], [' ', 'UTR'], ['P1', ' ']]) {
    assert.throws(() => c.submitPaymentTradeNo(orderNo, tradeNo), /invalid query parameter/);
  }
});

test('addPaymentExtraInfo omits optional fields instead of sending empty values', async () => {
  nextResponse = {
    body: { code: 200, msg: 'OK', data: { status: 1, orderStatus: 'PENDING', paymentUrl: 'https://h5.example/p/1' } },
  };
  const c = makeClient();

  const got = await c.addPaymentExtraInfo('P1', 'PK_JAZZCASH', { mobile: '03001234567' });
  assert.equal(got.paymentUrl, 'https://h5.example/p/1');
  assert.equal(captured.path, '/api/v1/payment/addExtraInfo');
  assert.deepEqual(JSON.parse(captured.body.toString()), {
    orderNo: 'P1',
    payMethod: 'PK_JAZZCASH',
    extra: { mobile: '03001234567' },
  });

  await c.addPaymentExtraInfo('P1', '', null);
  assert.deepEqual(JSON.parse(captured.body.toString()), { orderNo: 'P1' });

  assert.throws(() => c.addPaymentExtraInfo(' '), /invalid query parameter/);
});

// Local validation. The rule table is generated from the shared protocol data; these
// tests guard how it is applied. Half of the cases are positive: a wrongly rejected
// request can only be fixed by an SDK release.

test('unencodable request body is a RequestError, never a TransportError', async () => {
  const client = makeClient({ fetchImpl: async () => { throw new Error('must not be reached'); } });
  await assert.rejects(
    client.createPayment(payReq('BRL', { code: 'PIX', pix: { payerName: 1n } })),
    (err) => err instanceof sdk.RequestError && !(err instanceof sdk.TransportError),
  );
});

test('transport failure is a TransportError, never a RequestError', async () => {
  const client = makeClient({ fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); } });
  await assert.rejects(client.getBalance('BRL'), (err) => {
    assert.ok(err instanceof sdk.TransportError);
    assert.ok(!(err instanceof sdk.RequestError));
    return true;
  });
});

const payReq = (currency, paymentMethod) => ({
  merchantOrderNo: 'M1', currency, amount: '1.00', paymentMethod,
  webhookUrl: 'https://m.example.com/w',
});

test('validation: malformed requests are not sent', async () => {
  const client = makeClient();
  const cases = [
    [payReq('BRL', {}), /code is required/],
    [payReq('PKR', {
      code: 'PK_JAZZCASH',
      pkJazzcash: { mobile: '03001234567' },
      pkEasypaisa: { mobile: '03001234567' },
    }), /only one method extra/],
    [payReq('PKR', { code: 'PK_JAZZCASH', pkEasypaisa: { mobile: '03001234567' } }),
      /does not match code/],
    [payReq('PKR', { code: 'PH_GCASH', phGcash: { mobile: '09171234567' } }),
      /not available for this currency/],
    [payReq('IDR', { code: 'ID_VA', idVa: { accountName: 'Budi', email: 'b@example.com', mobile: '0812' } }),
      /extra\.bankCode/],
  ];
  for (const [req, re] of cases) {
    await assert.rejects(() => client.createPayment(req), re);
  }
});

test('validation: valid requests always pass', async () => {
  nextResponse = {};
  const client = makeClient();
  const ok = [
    // PKR / PHP payments have no required extras; omitting extra entirely is valid
    payReq('PKR', { code: 'PK_JAZZCASH' }),
    payReq('PKR', { code: 'PK_JAZZCASH', pkJazzcash: { mobile: '03001234567' } }),
    payReq('PHP', { code: 'PH_GCASH' }),
    payReq('IDR', {
      code: 'ID_VA',
      idVa: { accountName: 'Budi', email: 'b@example.com', mobile: '0812', bankCode: 'BCA' },
    }),
    payReq('XYZ', { code: 'WHATEVER' }),  // currency not in the table is not rejected
    payReq('BRL', { code: 'PIX' }),       // no method allowlist for this currency
  ];
  for (const req of ok) {
    await client.createPayment(req);
  }
});

// Rejecting the key happens before anything is sent, so it must land in the same
// class as any other pre-send failure; a merchant reading TransportError here
// would query an order that was never created.
test('a malformed idempotency key is a RequestError and nothing is sent', async () => {
  nextResponse = {};
  captured = {};
  const client = makeClient();
  await assert.rejects(
    () => client.createPayment({
      merchantOrderNo: 'M1', currency: 'BRL', amount: '1.00',
      paymentMethod: { code: 'PIX', pix: { payerName: 'X' } },
      webhookUrl: 'https://m.example.com/w',
    }, { idempotencyKey: 'my-key-123' }),
    (err) => err instanceof sdk.RequestError,
  );
  assert.deepEqual(captured, {}, 'nothing reached the server');
});

test('validation: conditional required fields; flattening them would wrongly reject IN_UPI', async () => {
  nextResponse = {};
  const client = makeClient();
  const payout = (payoutMethod) => ({
    merchantOrderNo: 'M1', currency: 'INR', amount: '1.00', payoutMethod,
    webhookUrl: 'https://m.example.com/w',
  });

  await client.createPayout(payout({
    code: 'IN_UPI',
    inUpi: { account: 'mary@upi', name: 'Mary', email: 'm@example.com', mobile: '9871476369' },
  }));

  await assert.rejects(() => client.createPayout(payout({
    code: 'IN_IFSC',
    inIfsc: { name: 'Mary', email: 'm@example.com', mobile: '9871476369' },
  })), /extra\.(ifsc|account)/);

  await client.createPayout(payout({
    code: 'IN_IFSC',
    inIfsc: {
      account: '123456789', ifsc: 'HDFC0001234',
      name: 'Mary', email: 'm@example.com', mobile: '9871476369',
    },
  }));
});

test('validation: IDR wallet payouts are accepted under their own extra field', async () => {
  nextResponse = {};
  const client = makeClient();
  const extra = (wallet) => ({ bankCode: wallet, accountName: 'Budi', email: 'b@example.com', mobile: '081234567890' });
  const payout = (payoutMethod) => ({
    merchantOrderNo: 'M1', currency: 'IDR', amount: '10000', payoutMethod,
    webhookUrl: 'https://m.example.com/w',
  });

  for (const [code, field, wallet] of [
    ['ID_DANA', 'idDana', 'DANA'], ['ID_OVO', 'idOvo', 'OVO'], ['ID_GOPAY', 'idGopay', 'GOPAY'],
    ['ID_LINKAJA', 'idLinkaja', 'LINKAJA'], ['ID_SHOPEEPAY', 'idShopeepay', 'SHOPEEPAY'],
  ]) {
    await client.createPayout(payout({ code, [field]: extra(wallet) }));
  }

  await assert.rejects(() => client.createPayout(payout({ code: 'ID_DANA', idOvo: extra('OVO') })),
    /does not match code/);
});

// Top-level required/format vectors shared by all SDKs; a failure here is a protocol
// mismatch in this implementation, not in the vectors.

const VALIDATION_REASON_FRAGMENT = {
  missing_required_field: (c) => `required field is empty: ${c.field}`,
  invalid_amount: () => 'amount must be',
  invalid_webhook_url: () => 'webhookUrl must be',
};

for (const file of readdirSync(join(TESTDATA, 'validation')).filter((f) => f.endsWith('.json')).sort()) {
  const vector = load(`validation/${file}`);
  for (const c of vector.cases) {
    test(`validation vector ${file} / ${c.name}`, async () => {
      nextResponse = {};
      const client = makeClient();
      const body = { ...vector.base, ...c.override };
      const call = () => (vector.direction === 'payment'
        ? client.createPayment(body)
        : client.createPayout(body));
      if (c.expect === 'accept') {
        await call();
        return;
      }
      await assert.rejects(call, {
        name: 'RequestError',
        message: new RegExp(VALIDATION_REASON_FRAGMENT[c.reason](c).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      });
    });
  }
}

test('receipt: blank order number is rejected, surrounding whitespace is trimmed', async () => {
  nextResponse = {};
  const client = makeClient();
  for (const bad of ['', '  ', '\t', null, undefined]) {
    assert.throws(() => client.getPayoutReceipt(bad), sdk.RequestError);
  }
  await client.getPayoutReceipt('  P202608270001 ');
  assert.equal(captured.path, '/api/v1/payouts/P202608270001/receipt');
});

test('ARS payout permits an empty address but requires a string field', async () => {
  const extra = { firstName: 'Ana', lastName: 'Perez', email: 'ana@example.com', phone: '1123456789', documentType: 'DNI', documentNumber: '30123456', address: '', accountNo: '0000003100012345678901', accountType: 'CBU' };
  const request = (bankTransfer) => ({ merchantOrderNo: 'ars-address-001', currency: 'ARS', amount: '1.00', webhookUrl: 'https://merchant.example.com/webhook', payoutMethod: { code: 'BANK_TRANSFER', bankTransfer } });
  nextResponse = {};
  await makeClient().createPayout(request(extra));
  const opened = await p.openBodyEnvelope(captured.body, b64(BODY.platformBodyPublicKeyBase64), b64(BODY.platformBodyPrivateKeyBase64));
  const body = JSON.parse(opened.plaintext.toString('utf8'));
  assert.equal(body.payoutMethod.bankTransfer.address, '');
  const blocked = makeClient({ fetchImpl: async () => { assert.fail('invalid address reached transport'); } });
  for (const address of [undefined, null, 1, false, [], {}]) {
    const invalid = { ...extra, address };
    if (address === undefined) delete invalid.address;
    await assert.rejects(blocked.createPayout(request(invalid)), /extra.address/);
  }
  for (const field of ['documentType', 'documentNumber']) {
    await assert.rejects(blocked.createPayout(request({ ...extra, [field]: '' })), new RegExp(`extra.${field}`));
  }
});

for (const req of (() => {
  const v = load('methods/001-usd-wallets.json');
  return [v.payment, ...v.payouts];
})()) {
  const methodField = req.paymentMethod ? 'paymentMethod' : 'payoutMethod';
  const method = req[methodField];
  const branch = Object.keys(method).find((key) => key !== 'code');
  test(`USD ${methodField} ${method.code}: sealed fields and required validation`, async () => {
    nextResponse = {};
    const client = makeClient();
    const create = (value) => req.paymentMethod ? client.createPayment(value) : client.createPayout(value);
    await create(req);
    const opened = await p.openBodyEnvelope(captured.body,
      b64(BODY.platformBodyPublicKeyBase64), b64(BODY.platformBodyPrivateKeyBase64));
    assert.deepEqual(JSON.parse(opened.plaintext), req);
    const lastRequest = captured;
    for (const field of Object.keys(method[branch])) {
      for (const empty of [null, '', '  ']) {
        const invalid = structuredClone(req);
        invalid[methodField][branch][field] = empty;
        await assert.rejects(() => create(invalid), sdk.RequestError);
        assert.equal(captured, lastRequest, `${field} must fail before HTTP`);
      }
    }
    const formats = structuredClone(req);
    for (const field of Object.keys(method[branch])) formats[methodField][branch][field] = 'format-is-checked-by-gateway';
    await create(formats);
  });
}
