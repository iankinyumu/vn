import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { COMPONENT_TEXT, LIMITS, STATE_TEXT, UI_MESSAGES, VERDICT_TEXT, describeV3 } from '../assets/js/fairness-v3-view.mjs';
import { STATES } from '../verifier/v3/verify.mjs';


test('every verifier state, component value and verdict has its own plain-language text, none claiming generic fairness', () => {
    assert.deepEqual(Object.keys(STATE_TEXT).sort(), [...STATES].sort());
    const texts = [...Object.values(STATE_TEXT), ...Object.values(VERDICT_TEXT), ...Object.values(COMPONENT_TEXT).flatMap((v) => Object.values(v)), ...Object.values(UI_MESSAGES), LIMITS];
    assert.equal(new Set(texts).size, texts.length);
    for (const text of texts) assert.doesNotMatch(text, /\bfair\b|guarantee|audited|certified|equivalent/i);
    for (const verdict of ['fully_verified', 'partial', 'invalid']) assert.match(VERDICT_TEXT[verdict], /^(Fully verified|Partial|Invalid):/, 'verdict spelled out, never colour alone');
});

test('the view reports the verdict, each component and what was checked', () => {
    const pkg = { ticks: [{ index: 'SPI50', tick_no: '11', scheduled_ms: '1790380802000', config_hash: 'aa' }, { index: 'SPI50', tick_no: '12', scheduled_ms: '1790380804000', config_hash: 'bb' }],
        anchors: {}, epochs: [{ witness: [{ provider: 'digicert' }, { provider: 'sectigo' }] }], signing_keys: [{ key_id: 'ed25519-2026-10-1' }], range: { truncated_to: null } };
    const ok = describeV3({ verdict: 'fully_verified', states: ['verified'], ticks: [{ status: 'verified' }, { status: 'verified' }], contracts: [{ status: 'void_refunded' }],
        components: { price_continuity: 'verified', signatures: 'valid', witness: 'witnessed', checkpoints: 'none', reveal: 'revealed', contracts: 'none' } }, pkg);
    assert.match(ok.headline, /^Fully verified: .*\(2 of 2 ticks fully recomputed\.\)$/);
    assert.ok(ok.lines.includes(COMPONENT_TEXT.witness.witnessed) && ok.lines.includes(LIMITS) && ok.lines.some((l) => /1 refunded contract/.test(l)));
    assert.ok(ok.details.some((d) => /Checked 2 ticks of SPI50: #11 to #12 \(2026-09-26 00:00:02 UTC/.test(d)));
    assert.ok(ok.details.some((d) => /2 model configurations/.test(d)) && ok.details.some((d) => /digicert, sectigo/.test(d)) && ok.details.some((d) => /ed25519-2026-10-1/.test(d)));
    const partial = describeV3({ verdict: 'partial', states: ['missing_history', 'not_yet_revealable'], ticks: [{ status: 'missing_history' }], contracts: [],
        components: { price_continuity: 'unanchored', signatures: 'unpinned', witness: 'late', checkpoints: 'unwitnessed', reveal: 'not_yet_revealable', contracts: 'none' } });
    assert.match(partial.headline, /^Partial:/);
    for (const expected of [COMPONENT_TEXT.price_continuity.unanchored, COMPONENT_TEXT.signatures.unpinned, COMPONENT_TEXT.witness.late, COMPONENT_TEXT.reveal.not_yet_revealable, STATE_TEXT.missing_history]) assert.ok(partial.lines.includes(expected));
});

test('the fairness page carries a hidden v3 section and loads the shared verifier module', () => {
    const page = readFileSync('pages/fairness.html', 'utf8');
    assert.match(page, /<section[^>]*data-fairness-v3 hidden>/);
    assert.match(page, /<script type="module" src="\.\.\/assets\/js\/fairness-v3\.js"><\/script>/);
    const script = readFileSync('assets/js/fairness-v3.js', 'utf8');
    assert.match(script, /from '\.\.\/\.\.\/verifier\/v3\/verify\.mjs'/);
    assert.match(script, /engine_generation === 3/);
    assert.match(script, /trustFromDocuments\(keys, roots\)/, 'browser and CLI share one trust policy');
});

test('the static build ships the verifier beside the pages, without test fixtures', () => {
    execFileSync(process.execPath, ['scripts/build-static.mjs']);
    for (const file of ['verify.mjs', 'tsa.mjs', 'tsa-roots.json', 'trusted-keys.json']) assert.ok(existsSync(`dist/verifier/v3/${file}`), file);
    assert.equal(existsSync('dist/verifier/v3/fixtures'), false);
    assert.ok(existsSync('dist/assets/js/fairness-v3.js') && existsSync('dist/assets/js/fairness-v3-view.mjs'));
});
