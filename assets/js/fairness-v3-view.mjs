// Plain-language view of a v3 verification result (verifier/v3/verify.mjs).
// Every state stays distinct; nothing collapses into a generic "fair" badge.

export const STATE_TEXT = Object.freeze({
    verified: 'Verified: every price and digit was recomputed from the revealed seed and matched.',
    not_yet_revealable: 'Not yet revealable: the seed for this day is published after the day ends and its contracts settle.',
    missing_history: 'Missing history: the range does not start from an anchored point, so its starting price is unproven.',
    invalid_config: 'Invalid configuration: the model settings, schedule or package format do not match the specification.',
    invalid_commitment: 'Invalid commitment: a commitment, seed hash or revealed seed does not match.',
    invalid_signature: 'Invalid signature: a commitment or checkpoint is not signed by a trusted SmartProfit key.',
    invalid_witness: 'Invalid witness: a timestamp receipt does not verify or is not earlier than the ticks it covers.',
    broken_continuity: 'Broken continuity: a tick is missing, reordered or does not chain to the one before it.',
    price_mismatch: 'Price mismatch: a published price differs from the recomputed price.',
    digit_mismatch: 'Digit mismatch: a published digit is not the final digit of its price.',
    contract_mismatch: 'Contract mismatch: a contract result does not follow from its exit tick.',
});

export const WITNESS_TEXT = Object.freeze({
    witnessed: 'Witnessed: DigiCert and Sectigo timestamps show each day\'s commitment existed before its first tick.',
    unwitnessed: 'Unwitnessed: independent timestamps are missing, so this check cannot show when the commitment was made.',
    invalid: 'Witness invalid: at least one timestamp receipt failed verification.',
});

export const SIGNATURE_TEXT = Object.freeze({
    valid: 'Signatures valid against the published SmartProfit signing key.',
    unpinned: 'Signatures verify, but no signing key has been published for pinning yet.',
    unsigned: 'Records are unsigned.',
    invalid: 'Signature check failed.',
});

export const LIMITS = 'A matching seed shows the published history follows from the committed seed. It does not show that no one with access to the engine service could preview the current day.';

/** @returns {{ headline: string, lines: string[], counts: Record<string, number> }} */
export function describeV3(result) {
    const counts = {};
    for (const tick of result.ticks) counts[tick.status] = (counts[tick.status] || 0) + 1;
    const lines = result.states.map((state) => STATE_TEXT[state] || state);
    lines.push(WITNESS_TEXT[result.witness] || result.witness, SIGNATURE_TEXT[result.signatures] || result.signatures);
    const contracts = result.contracts.length
        ? `${result.contracts.filter((c) => c.status === 'verified').length} of ${result.contracts.length} settled contracts verified${result.contracts.some((c) => c.status === 'void_refunded') ? '; refunded contracts are listed as refunded' : ''}.`
        : 'No settled contracts of yours in this range.';
    lines.push(contracts, LIMITS);
    const headline = `${result.ticks.length} ticks checked: ${Object.entries(counts).map(([state, n]) => `${n} ${state.replaceAll('_', ' ')}`).join(', ')}.`;
    return { headline, lines, counts };
}
