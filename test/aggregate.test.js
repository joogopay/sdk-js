import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validatePaymentMethod, validatePayoutMethod } from '../src/validate.js';
const cases = JSON.parse(readFileSync(new URL('../protocol/testdata/methods/002-aggregate.json', import.meta.url)));
for (const c of cases) test(`aggregate: ${c.name}`, () => {
 const run = () => (c.direction === 'payment' ? validatePaymentMethod : validatePayoutMethod)(c.currency, c.method);
 if (c.valid) assert.doesNotThrow(run); else assert.throws(run);
});
