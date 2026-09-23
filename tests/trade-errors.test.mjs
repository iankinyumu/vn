import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('trade page maps every stable engine purchase failure to plain text', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    const addListener = dom.window.addEventListener;
    dom.window.addEventListener = () => {};
    dom.window.eval(fs.readFileSync('assets/js/trade.js', 'utf8'));
    dom.window.addEventListener = addListener;
    const messages = dom.window.smartProfitTrade.errorMessages;
    for (const code of ['account_not_available', 'real_disabled', 'trading_restricted', 'restricted_limit_exceeded', 'access_restricted', 'feed_stale', 'exposure_limit', 'limits_not_configured', 'idempotency_conflict', 'insufficient_funds', 'invalid_stake', 'stake_below_minimum', 'stake_above_maximum', 'invalid_tick_count', 'rate_limit_exceeded']) {
        assert.equal(typeof messages[code], 'string', code);
        assert.ok(messages[code].endsWith('.'), code);
    }
    dom.window.close();
});
