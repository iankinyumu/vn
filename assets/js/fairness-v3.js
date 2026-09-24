// Version 3 proof check on the fairness page. Uses the same standalone
// verifier and the same published trust documents as `node verifier/v3/cli.mjs`,
// and downloads exactly the package it checked, for checking elsewhere.
import { trustFromDocuments } from '../../verifier/v3/trust.mjs';
import { verifyPackage } from '../../verifier/v3/verify.mjs';
import { UI_MESSAGES, describeV3 } from './fairness-v3-view.mjs';

const section = document.querySelector('[data-fairness-v3]');
const MAX_TICKS = 5000;
const DEFAULT_TICKS = 200;
// A valid Ed25519 public key (RFC 8032 test 1) to probe Ed25519 support.
const PROBE_KEY = Uint8Array.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'.match(/../g), (h) => parseInt(h, 16));

async function trustInputs() {
    const [keys, roots] = await Promise.all([
        fetch(new URL('../../verifier/v3/trusted-keys.json', import.meta.url)).then((r) => r.json()),
        fetch(new URL('../../verifier/v3/tsa-roots.json', import.meta.url)).then((r) => r.json()),
    ]);
    return trustFromDocuments(keys, roots); // same documents, same policy as the CLI
}
async function ed25519Supported() {
    try { await globalThis.crypto.subtle.importKey('raw', PROBE_KEY, { name: 'Ed25519' }, false, ['verify']); return true; } catch { return false; }
}
const codeOf = (error) => String(error?.message || error?.code || '').match(/[a-z_]+/)?.[0];

async function start() {
    if (!section) return;
    const { client } = await window.loadEngineConfig();
    const rpc = async (name, args) => { const { data, error } = await client.rpc(name, args); if (error) throw error; return data; };
    const status = await rpc('get_engine_v3_status', {});
    const live = (status || []).filter((row) => row.engine_generation === 3);
    if (!live.length) return; // no v3 history yet: keep the section hidden
    const form = section.querySelector('form');
    const output = section.querySelector('[data-fairness-v3-result]');
    const list = section.querySelector('[data-fairness-v3-lines]');
    const details = section.querySelector('[data-fairness-v3-details]');
    const download = section.querySelector('[data-fairness-v3-download]');
    const note = section.querySelector('[data-fairness-v3-note]');
    const submit = form.querySelector('button[type="submit"]');
    for (const row of live) form.index.add(new Option(row.index_code, row.index_code));
    section.hidden = false;
    const say = (message) => { output.textContent = message; section.dataset.state = Object.keys(UI_MESSAGES).find((k) => UI_MESSAGES[k] === message) || 'result'; };
    if (!await ed25519Supported()) { say(UI_MESSAGES.unsupported); submit.disabled = true; return; }
    const noteFor = () => { const row = live.find((r) => r.index_code === form.index.value); note.textContent = row?.purchase_block === 'feed_stale' ? UI_MESSAGES.stale_feed : ''; note.hidden = !note.textContent; };
    async function defaultRange() {
        const latest = await rpc('get_recent_ticks', { p_index: form.index.value, p_limit: 1 }).catch(() => []);
        const newest = Number(latest?.[0]?.tick_no || 0);
        if (newest) { form.from.value = Math.max(1, newest - DEFAULT_TICKS + 1); form.to.value = newest; }
        noteFor();
    }
    form.index.addEventListener('change', () => defaultRange());
    await defaultRange();
    let lastPackage = null;
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const from = Number(form.from.value), to = Number(form.to.value);
        list.replaceChildren(); details.replaceChildren(); download.hidden = true; lastPackage = null;
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) { say(UI_MESSAGES.bad_range); return; }
        if (to - from + 1 > MAX_TICKS) { say(UI_MESSAGES.too_large); return; }
        if (navigator.onLine === false) { say(UI_MESSAGES.offline); return; }
        say(UI_MESSAGES.loading);
        submit.disabled = true;
        section.setAttribute('aria-busy', 'true');
        try {
            const account = window.smartProfitAccount.get();
            let pkg;
            try { pkg = await rpc('get_v3_proof_package', { p_account_id: account.accountId, p_index: form.index.value, p_from: from, p_to: to }); }
            catch (error) { say(codeOf(error) === 'not_found' ? UI_MESSAGES.no_data : navigator.onLine === false ? UI_MESSAGES.offline : UI_MESSAGES.network); return; }
            const view = describeV3(await verifyPackage(pkg, await trustInputs()), pkg);
            lastPackage = pkg;
            say(view.headline);
            section.dataset.verdict = view.verdict;
            list.replaceChildren(...view.lines.map((line) => Object.assign(document.createElement('li'), { textContent: line })));
            details.replaceChildren(...view.details.map((line) => Object.assign(document.createElement('li'), { textContent: line })));
            download.hidden = false;
        } catch (error) {
            say(UI_MESSAGES.network);
            console.error(error);
        } finally {
            submit.disabled = false;
            section.removeAttribute('aria-busy');
        }
    });
    download.addEventListener('click', () => {
        if (!lastPackage) return;
        try {
            const link = document.createElement('a');
            link.href = URL.createObjectURL(new Blob([JSON.stringify(lastPackage, null, 2)], { type: 'application/json' }));
            link.download = `smartprofit-proof-${form.index.value}-${form.from.value}-${form.to.value}.json`;
            document.body.append(link); link.click(); link.remove();
            setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        } catch (error) { say(UI_MESSAGES.download_failed); console.error(error); }
    });
}

start().catch((error) => {
    console.error(error);
    const output = section?.querySelector('[data-fairness-v3-result]');
    if (output && !section.hidden) output.textContent = UI_MESSAGES.network;
});
