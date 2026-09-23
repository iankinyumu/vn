import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { JSDOM } from 'jsdom';

test('fairness WebCrypto verifier reproduces the published SPI10 vector', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'https://example.test/pages/fairness.html' });
    Object.defineProperty(dom.window, 'crypto', { value: webcrypto });
    dom.window.TextEncoder = TextEncoder;
    dom.window.eval(fs.readFileSync('assets/js/fairness.js', 'utf8'));
    const seed = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    const actual = [];
    for (let tick = 1; tick <= 20; tick++) actual.push(await dom.window.smartProfitFairness.digit(seed, 'DEMO', 'SPI10', tick));
    assert.deepEqual(actual, [2, 8, 3, 9, 8, 6, 1, 6, 7, 8, 7, 7, 6, 1, 9, 0, 1, 8, 2, 5]);
    assert.equal(await dom.window.smartProfitFairness.digest(Uint8Array.from(seed.match(/../g), (pair) => parseInt(pair, 16))), '630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd');
    dom.window.close();
});
