import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { LIMITS, SIGNATURE_TEXT, STATE_TEXT, WITNESS_TEXT, describeV3 } from '../assets/js/fairness-v3-view.mjs';
import { STATES } from '../verifier/v3/verify.mjs';

const result = (overrides) => ({ status: 'verified', states: ['verified'], witness: 'witnessed', signatures: 'valid', ticks: [{ status: 'verified' }], contracts: [], ...overrides });

test('every verifier state has its own plain-language explanation and none claims generic fairness', () => {
    assert.deepEqual(Object.keys(STATE_TEXT).sort(), [...STATES].sort());
    const texts = [...Object.values(STATE_TEXT), ...Object.values(WITNESS_TEXT), ...Object.values(SIGNATURE_TEXT), LIMITS];
    assert.equal(new Set(texts).size, texts.length);
    for (const text of texts) assert.doesNotMatch(text, /\bfair\b|guarantee|audited|certified|equivalent/i);
});

test('the view keeps failures, witness and signature coverage separate', () => {
    const ok = describeV3(result({ contracts: [{ status: 'verified' }, { status: 'void_refunded' }] }));
    assert.match(ok.headline, /1 ticks checked: 1 verified/);
    assert.ok(ok.lines.includes(WITNESS_TEXT.witnessed) && ok.lines.includes(SIGNATURE_TEXT.valid) && ok.lines.includes(LIMITS));
    assert.ok(ok.lines.some((line) => /1 of 2 settled contracts verified; refunded/.test(line)));
    const bad = describeV3(result({ status: 'price_mismatch', states: ['price_mismatch', 'not_yet_revealable'], witness: 'unwitnessed', signatures: 'unpinned',
        ticks: [{ status: 'price_mismatch' }, { status: 'not_yet_revealable' }] }));
    assert.match(bad.headline, /1 price mismatch, 1 not yet revealable/);
    assert.ok(bad.lines.includes(STATE_TEXT.price_mismatch) && bad.lines.includes(STATE_TEXT.not_yet_revealable));
    assert.ok(bad.lines.includes(WITNESS_TEXT.unwitnessed) && bad.lines.includes(SIGNATURE_TEXT.unpinned));
});

test('the fairness page carries a hidden v3 section and loads the shared verifier module', () => {
    const page = readFileSync('pages/fairness.html', 'utf8');
    assert.match(page, /<section[^>]*data-fairness-v3 hidden>/);
    assert.match(page, /<script type="module" src="\.\.\/assets\/js\/fairness-v3\.js"><\/script>/);
    const script = readFileSync('assets/js/fairness-v3.js', 'utf8');
    assert.match(script, /from '\.\.\/\.\.\/verifier\/v3\/verify\.mjs'/);
    assert.match(script, /engine_generation === 3/);
    assert.match(script, /keys\.keys : null/, 'an empty key list must mean unpinned, not trusted');
});

test('the static build ships the verifier beside the pages, without test fixtures', () => {
    execFileSync(process.execPath, ['scripts/build-static.mjs']);
    for (const file of ['verify.mjs', 'tsa.mjs', 'tsa-roots.json', 'trusted-keys.json']) assert.ok(existsSync(`dist/verifier/v3/${file}`), file);
    assert.equal(existsSync('dist/verifier/v3/fixtures'), false);
    assert.ok(existsSync('dist/assets/js/fairness-v3.js') && existsSync('dist/assets/js/fairness-v3-view.mjs'));
});
