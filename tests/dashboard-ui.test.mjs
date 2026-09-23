import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('dashboard exposes clear reset-practice error messages', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    const addListener = dom.window.addEventListener;
    dom.window.addEventListener = () => {};
    dom.window.eval(fs.readFileSync('assets/js/dashboard.js', 'utf8'));
    dom.window.addEventListener = addListener;
    for (const code of ['account_not_available', 'open_contracts_exist', 'reset_not_available', 'reset_rate_limited']) assert.match(dom.window.smartProfitDashboard.resetMessages[code], /\.$/);
    dom.window.close();
});
