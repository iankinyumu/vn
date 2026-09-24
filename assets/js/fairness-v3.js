// Version 3 proof check on the fairness page. Uses the same standalone
// verifier as `node verifier/v3/cli.mjs`, and offers the package as a
// download so it can be checked without this page.
import { verifyPackage } from '../../verifier/v3/verify.mjs';
import { decodeBase64 } from '../../verifier/v3/tsa.mjs';
import { describeV3 } from './fairness-v3-view.mjs';

const section = document.querySelector('[data-fairness-v3]');
const MAX_RANGE = 4999;

async function trustInputs() {
    const [keys, roots] = await Promise.all([
        fetch(new URL('../../verifier/v3/trusted-keys.json', import.meta.url)).then((r) => r.json()),
        fetch(new URL('../../verifier/v3/tsa-roots.json', import.meta.url)).then((r) => r.json()),
    ]);
    const tsaRoots = Object.fromEntries(Object.entries(roots.providers).map(([name, entry]) => [name, entry.certificates.map(decodeBase64)]));
    // No published key yet means "unpinned", never "trusted by default".
    return { trustedKeys: Object.keys(keys.keys || {}).length ? keys.keys : null, tsaRoots };
}

async function start() {
    if (!section) return;
    const { client } = await window.loadEngineConfig();
    const rpc = async (name, args) => { const { data, error } = await client.rpc(name, args); if (error) throw error; return data; };
    const status = await rpc('get_engine_v3_status', {});
    const live = (status || []).filter((row) => row.engine_generation === 3);
    if (!live.length) return; // no v3 index yet: keep the section hidden
    const form = section.querySelector('form');
    const output = section.querySelector('[data-fairness-v3-result]');
    const list = section.querySelector('[data-fairness-v3-lines]');
    const download = section.querySelector('[data-fairness-v3-download]');
    for (const row of live) form.index.add(new Option(row.index_code, row.index_code));
    section.hidden = false;
    let lastPackage = null;
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const from = Number(form.from.value), to = Number(form.to.value);
        list.replaceChildren(); download.hidden = true;
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to - from > MAX_RANGE) { output.textContent = 'Enter a range of at most 5,000 ticks.'; return; }
        output.textContent = 'Verifying…';
        try {
            const account = window.smartProfitAccount.get();
            lastPackage = await rpc('get_v3_proof_package', { p_account_id: account.accountId, p_index: form.index.value, p_from: from, p_to: to });
            const view = describeV3(await verifyPackage(lastPackage, await trustInputs()));
            output.textContent = view.headline;
            list.replaceChildren(...view.lines.map((line) => { const item = document.createElement('li'); item.textContent = line; return item; }));
            download.hidden = false;
        } catch (error) {
            output.textContent = 'Verification could not run. Please try again.';
            console.error(error);
        }
    });
    download.addEventListener('click', () => {
        if (!lastPackage) return;
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([JSON.stringify(lastPackage, null, 2)], { type: 'application/json' }));
        link.download = `smartprofit-proof-${form.index.value}-${form.from.value}-${form.to.value}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
    });
}

start().catch((error) => console.error(error));
