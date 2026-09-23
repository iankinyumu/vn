import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('restriction banner only renders restrictions for the active account mode', async () => {
    const dom = new JSDOM('<!doctype html><body><div data-restriction-banner hidden></div></body>', { runScripts: 'outside-only' });
    dom.window.smartProfitAccount = { get: () => ({ mode: 'DEMO' }) };
    dom.window.getSupabaseClient = async () => ({ rpc: async () => ({ data: [{ scope: 'REAL', severity: 'BLOCKED', reason: 'Real only', params: {} }, { scope: 'DEMO', severity: 'LIMITED', reason: 'Practice limit', params: { max_stake: 5 } }], error: null }) });
    dom.window.eval(fs.readFileSync('assets/js/restriction-banner.js', 'utf8'));
    await dom.window.refreshRestrictionBanner();
    const banner = dom.window.document.querySelector('[data-restriction-banner]');
    assert.equal(banner.hidden, false);
    assert.match(banner.textContent, /Practice limit/);
    assert.doesNotMatch(banner.textContent, /Real only/);
    dom.window.close();
});
