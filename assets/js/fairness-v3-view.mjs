// Plain-language view of a v3 verification result (verifier/v3/verify.mjs).
// Every state stays distinct. Nothing collapses into a generic "fair" badge,
// and the verdict is always spelled out in words, never shown by colour alone.

export const VERDICT_TEXT = Object.freeze({
    fully_verified: 'Fully verified: every check passed, from an anchored start, with pinned keys and independent timestamps.',
    partial: 'Partial: nothing contradicts the published record, but some evidence is missing or not yet available.',
    invalid: 'Invalid: at least one check failed. Details are listed below.',
});

export const STATE_TEXT = Object.freeze({
    verified: 'Verified: every price and digit was recomputed from the revealed seed and matched.',
    not_yet_revealable: 'Not yet revealable: the seed for this day is published after the day ends and its contracts settle.',
    missing_history: 'Missing history: the range does not start from an anchored point, so its starting price is unproven.',
    invalid_config: 'Invalid configuration: the model settings, schedule or package format do not match the specification.',
    invalid_commitment: 'Invalid commitment: a commitment, seed hash or revealed seed does not match.',
    invalid_signature: 'Invalid signature: a commitment or checkpoint is not signed by a published SmartProfit key.',
    invalid_witness: 'Invalid timestamp: a receipt does not verify against the pinned timestamp authority roots.',
    broken_continuity: 'Broken continuity: a tick is missing, reordered or does not chain to the one before it.',
    price_mismatch: 'Price mismatch: a published price differs from the recomputed price.',
    digit_mismatch: 'Digit mismatch: a published digit is not the final digit of its price.',
    contract_mismatch: 'Contract mismatch: a contract result does not follow from its exit tick.',
});

export const COMPONENT_TEXT = Object.freeze({
    price_continuity: { verified: 'Prices and continuity: recomputed and unbroken from an anchored start.', unanchored: 'Prices and continuity: the starting point is not anchored by genesis or a witnessed checkpoint.', unverifiable: 'Prices and continuity: no ticks to check.', invalid: 'Prices and continuity: failed.' },
    signatures: { valid: 'Signatures: valid against the published SmartProfit key.', unpinned: 'Signatures: no SmartProfit key has been published for pinning yet.', unsigned: 'Signatures: records are unsigned.', invalid: 'Signatures: failed or signed by an unpublished key.' },
    witness: { witnessed: 'Independent timestamps: DigiCert and Sectigo receipts are valid and earlier than each day\'s first tradable tick.', late: 'Independent timestamps: a receipt is later than the first tradable tick, so it cannot show the commitment came first.', missing: 'Independent timestamps: a required receipt is missing.', unwitnessed: 'Independent timestamps: not checked, no pinned roots available.', invalid: 'Independent timestamps: a receipt failed verification.' },
    checkpoints: { witnessed: 'Checkpoints: signed and independently timestamped.', none: 'Checkpoints: none in this range.', unwitnessed: 'Checkpoints: at least one lacks a valid independent timestamp.', invalid: 'Checkpoints: failed.' },
    reveal: { revealed: 'Seeds: every day in the range is revealed and reproduces its prices.', not_yet_revealable: 'Seeds: at least one day is not revealed yet. Its seed is published after the day ends and its contracts settle.' },
    contracts: { verified: 'Your contracts: each result follows from its exit tick.', none: 'Your contracts: none settled in this range.', unverifiable: 'Your contracts: an exit tick could not be fully checked yet.', invalid: 'Your contracts: a result does not follow from its exit tick.' },
});

export const LIMITS = 'A matching seed shows the published history follows from the committed seed, and valid timestamps show when each commitment existed. It does not show that no one with control of the engine service could see the current day in advance.';

const time = (ms) => new Date(Number(ms)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

/** @returns {{ verdict: string, headline: string, lines: string[], details: string[] }} */
export function describeV3(result, pkg = null) {
    const lines = Object.entries(result.components || {}).map(([name, value]) => COMPONENT_TEXT[name]?.[value] || `${name}: ${value}`);
    for (const state of result.states) if (state !== 'verified' && STATE_TEXT[state]) lines.push(STATE_TEXT[state]);
    const refunded = result.contracts.filter((c) => c.status === 'void_refunded').length;
    if (refunded) lines.push(`${refunded} refunded contract${refunded === 1 ? '' : 's'} in this range.`);
    lines.push(LIMITS);
    const details = [];
    if (pkg?.ticks?.length) {
        const first = pkg.ticks[0], last = pkg.ticks.at(-1);
        details.push(`Checked ${pkg.ticks.length} ticks of ${first.index}: #${first.tick_no} to #${last.tick_no} (${time(first.scheduled_ms)} to ${time(last.scheduled_ms)}).`);
        if (pkg.range?.truncated_to) details.push(`Stopped at tick #${pkg.range.truncated_to} (5,000-tick limit). Check again from tick #${BigInt(pkg.range.truncated_to) + 1n} for the rest.`);
        const configs = [...new Set(pkg.ticks.map((t) => t.config_hash))];
        details.push(configs.length === 1 ? 'One model configuration throughout.' : `${configs.length} model configurations: the settings changed at a day boundary inside this range, and each day was checked under its own.`);
        const anchor = Object.values(pkg.anchors || {})[0];
        details.push(anchor ? `Starts from signed checkpoint at tick #${anchor.checkpoint.tick_no}.` : 'Starts from the first tick of the series (genesis).');
        const providers = [...new Set((pkg.epochs || []).flatMap((e) => (e.witness || []).map((w) => w.provider)))];
        details.push(`Timestamp providers in this package: ${providers.length ? providers.join(', ') : 'none'}.`);
        const keys = [...new Set((pkg.signing_keys || []).map((k) => k.key_id))];
        details.push(`Signing key${keys.length === 1 ? '' : 's'}: ${keys.join(', ') || 'none'}.`);
    }
    const verified = result.ticks.filter((t) => t.status === 'verified').length;
    const headline = `${VERDICT_TEXT[result.verdict]} (${verified} of ${result.ticks.length} ticks fully recomputed.)`;
    return { verdict: result.verdict, headline, lines, details };
}

/** Distinct, actionable messages for everything that is not a verdict. */
export const UI_MESSAGES = Object.freeze({
    loading: 'Checking the proof in your browser…',
    offline: 'You appear to be offline. Check your connection, then try again.',
    network: 'The proof could not be downloaded from SmartProfit. Try again in a moment.',
    unsupported: 'This browser cannot run the check because it lacks Ed25519 signature support. Update the browser, or download the package and use the command-line verifier.',
    too_large: 'Choose a range of at most 5,000 ticks. Larger histories are checked one page at a time.',
    bad_range: 'Enter a first tick of at least 1 and a last tick that is not before it.',
    no_data: 'No version 3 ticks have been published in this range yet.',
    download_failed: 'The package could not be saved. Try again, or use a different browser.',
    stale_feed: 'Live prices are delayed right now. Published history can still be checked.',
});
