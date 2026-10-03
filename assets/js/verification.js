/* Account verification (pages/verification.html), started by the customer from their profile.
   Six steps, each saved on the server as soon as it is submitted, so it can stop and resume on any
   device. The server validates every field and scores the knowledge check
   (supabase/migrations/20261003130000_split_onboarding_and_verification.sql);
   this script only presents the steps, normalises obvious input and shows the server's errors
   beside the right field. Every value reaches the page with textContent or as a form value. */
(function () {
    'use strict';

    const STEP_NAMES = ['About you', 'Address', 'Work and finances', 'Experience', 'Knowledge check', 'Goals and safety'];
    const TOTAL = STEP_NAMES.length;

    // ISO 3166-1 alpha-2. Names come from the browser (Intl.DisplayNames), so the list stays short.
    const COUNTRY_CODES = ('AF AX AL DZ AS AD AO AI AQ AG AR AM AW AU AT AZ BS BH BD BB BY BE BZ BJ BM BT BO BQ BA BW BV BR IO BN BG BF BI CV KH CM CA KY CF TD CL CN CX CC CO KM CG CD CK CR CI HR CU CW CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FK FO FJ FI FR GF PF TF GA GM GE DE GH GI GR GL GD GP GU GT GG GN GW GY HT HM VA HN HK HU IS IN ID IR IQ IE IM IL IT JM JP JE JO KZ KE KI KP KR KW KG LA LV LB LS LR LY LI LT LU MO MG MW MY MV ML MT MH MQ MR MU YT MX FM MD MC MN ME MS MA MZ MM NA NR NP NL NC NZ NI NE NG NU NF MK MP NO OM PK PW PS PA PG PY PE PH PN PL PT PR QA RE RO RU RW BL SH KN LC MF PM VC WS SM ST SA SN RS SC SL SG SX SK SI SB SO ZA GS SS ES LK SD SR SJ SE CH SY TW TJ TZ TH TL TG TK TO TT TN TR TM TC TV UG UA AE GB US UM UY UZ VU VE VN VG VI WF EH YE ZM ZW').split(' ');
    // East African Community first: most customers are here.
    const NEAR = ['KE', 'UG', 'TZ', 'RW', 'BI', 'SS', 'CD', 'SO', 'ET'];
    const COUNTIES = ['Baringo', 'Bomet', 'Bungoma', 'Busia', 'Elgeyo-Marakwet', 'Embu', 'Garissa', 'Homa Bay', 'Isiolo', 'Kajiado', 'Kakamega', 'Kericho', 'Kiambu', 'Kilifi', 'Kirinyaga', 'Kisii', 'Kisumu', 'Kitui', 'Kwale', 'Laikipia', 'Lamu', 'Machakos', 'Makueni', 'Mandera', 'Marsabit', 'Meru', 'Migori', 'Mombasa', "Murang'a", 'Nairobi', 'Nakuru', 'Nandi', 'Narok', 'Nyamira', 'Nyandarua', 'Nyeri', 'Samburu', 'Siaya', 'Taita-Taveta', 'Tana River', 'Tharaka-Nithi', 'Trans Nzoia', 'Turkana', 'Uasin Gishu', 'Vihiga', 'Wajir', 'West Pokot'];

    // What each server error means, said to the customer.
    const FIELD_ERRORS = {
        legal_first_name: 'Enter your first name as it appears on your ID, using letters only.',
        legal_last_name: 'Enter your last name as it appears on your ID, using letters only.',
        date_of_birth: 'Enter a real date of birth.',
        underage: 'You must be 18 or older to use SmartProfit.',
        nationality: 'Choose your nationality.',
        country_of_residence: 'Choose the country you live in.',
        phone: 'Enter a mobile number with its country code, for example +254 712 345 678.',
        address_line1: 'Enter your street address or building.',
        address_line2: 'Keep this line under 120 characters.',
        city: 'Enter your town or city.',
        region: 'Choose your county or enter your region.',
        postal_code: 'Use letters, numbers, spaces or hyphens only.',
        employment_status: 'Choose your employment status.',
        occupation: 'Choose the industry you work in.',
        annual_income: 'Choose your yearly income band.',
        savings: 'Choose your savings band.',
        source_of_funds: 'Choose at least one source.',
        tax_id: 'A KRA PIN is a letter, nine digits and a letter, for example A123456789Z. Leave it empty if you do not have it to hand.',
        is_pep: 'Answer yes or no.',
        experience_binary: 'Choose one.', experience_forex: 'Choose one.', experience_shares: 'Choose one.', finance_background: 'Answer yes or no.',
        q1: 'Choose an answer.', q2: 'Choose an answer.', q3: 'Choose an answer.', q4: 'Choose an answer.',
        goal: 'Choose what brings you here.',
        weekly_time: 'Choose how much time you expect to spend.',
        acknowledgements: 'Tick all three boxes to continue.'
    };

    // Explanations for the knowledge check, shown after the server has scored it.
    const ANSWERS = {
        q1: { correct: 'lose_stake', text: 'Seven is odd, so an Even contract loses and the whole stake is gone.' },
        q2: { correct: 'same_chance', text: 'Every tick is independent. Each digit from 0 to 9 is equally likely every time, whatever came before.' },
        q3: { correct: 'expected_loss', text: 'Payouts are set below fair odds, so over many contracts the expected result is a loss. No system changes that.' },
        q4: { correct: 'the_stake', text: 'A contract can lose at most its stake. Many losing contracts can still add up quickly.' }
    };

    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
    const forms = window.smartProfitForms;
    const clean = (value, max) => (forms ? forms.clean(value, max) : String(value || '').trim().slice(0, max));

    let client = null;
    let state = { status: 'not_started', current_step: 1, data: {} };
    let shown = 1;
    let busy = false;

    function status(text) { $('[data-ob-status]').textContent = text; }

    function countryOptions() {
        let names = null;
        try { names = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (_) { /* codes only */ }
        const name = (code) => { try { return names ? names.of(code) : code; } catch (_) { return code; } };
        const near = NEAR.map((code) => [code, name(code)]);
        const rest = COUNTRY_CODES.filter((code) => !NEAR.includes(code)).map((code) => [code, name(code)]).sort((a, b) => a[1].localeCompare(b[1]));
        for (const select of $$('[data-countries]')) {
            const placeholder = new Option('Choose a country', '');
            const top = document.createElement('optgroup'); top.label = 'East Africa';
            near.forEach(([code, label]) => top.append(new Option(label, code)));
            const all = document.createElement('optgroup'); all.label = 'All countries';
            rest.forEach(([code, label]) => all.append(new Option(label, code)));
            select.replaceChildren(placeholder, top, all);
        }
        const counties = $('[data-region-select]');
        counties.replaceChildren(new Option('Choose a county', ''), ...COUNTIES.map((county) => new Option(county, county)));
    }

    // Kenya gets a county list and a KRA PIN; anywhere else, a free region and any tax number.
    function syncResidence() {
        const kenya = ($('#country_of_residence').value || state.data.country_of_residence) === 'KE';
        const select = $('[data-region-select]'), text = $('[data-region-text]');
        select.hidden = select.disabled = !kenya;
        text.hidden = text.disabled = kenya;
        $('[data-region-label]').textContent = kenya ? 'County' : 'Region or state';
        $('[data-region-label]').htmlFor = kenya ? 'region' : 'regionText';
        $('[data-tax-label]').firstChild.textContent = kenya ? 'KRA PIN ' : 'Tax identification number ';
        $('[data-tax-hint]').textContent = kenya ? 'For example A123456789Z. You will need it before Real mode opens.' : 'If your country issues one. You will need it before Real mode opens.';
    }

    function fill(data) {
        for (const [key, value] of Object.entries(data || {})) {
            if (key === 'knowledge_answers' && value) { fill(value); continue; }
            const inputs = $$(`[name="${key}"]`);
            if (!inputs.length) continue;
            for (const input of inputs) {
                if (input.type === 'radio') input.checked = String(value) === input.value;
                else if (input.type === 'checkbox') input.checked = Array.isArray(value) ? value.includes(input.value) : Boolean(value);
                else input.value = value == null ? '' : String(value);
            }
        }
        if (data?.risk_acknowledged) $$('[name^="ack_"]').forEach((box) => { box.checked = true; });
        syncResidence();
        $('[data-income-warning]').hidden = !$('[name="goal"][value="extra_income"]').checked;
    }

    function stepForm(step) { return $(`[data-step="${step}"]`); }

    function show(step, { focus = true } = {}) {
        shown = step;
        $$('.ob-step').forEach((node) => { node.hidden = node.dataset.step !== String(step); });
        clearErrors();
        const number = step === 'done' ? TOTAL : step === '5-result' ? 5 : step;
        const reached = Math.max(Number(state.current_step) || 1, typeof number === 'number' ? number : 1);
        for (const item of $$('[data-step-item]')) {
            const n = Number(item.dataset.stepItem);
            const done = state.status === 'completed' || n < reached;
            const current = step !== 'done' && n === number;
            item.classList.toggle('is-current', current);
            item.classList.toggle('is-done', done && !current);
            if (current) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
            $('[data-step-state]', item).textContent = current ? 'Current' : done ? 'Done' : '';
        }
        $('[data-ob-progress-text]').textContent = step === 'done' ? 'Verification submitted' : `Step ${number} of ${TOTAL} · ${STEP_NAMES[number - 1]}`;
        $('[data-ob-progress-bar]').style.width = `${Math.round(((step === 'done' ? TOTAL : number - 1) / TOTAL) * 100)}%`;
        window.scrollTo({ top: 0 });
        if (focus) $(`[data-step="${step}"] h1`)?.focus();
    }

    /* ---- errors ------------------------------------------------------------------------- */

    function clearErrors() {
        $('[data-ob-errors]').hidden = true;
        $('[data-ob-error-list]').replaceChildren();
        $$('[data-error-for]').forEach((node) => { node.hidden = true; node.textContent = ''; });
        $$('[aria-invalid="true"]').forEach((node) => node.removeAttribute('aria-invalid'));
    }

    function fieldTarget(field) {
        return $(`[data-step="${shown}"] [name="${field}"]:not([disabled])`) || $(`[data-step="${shown}"] [data-field="${field}"] input`);
    }

    function showErrors(list) {
        const summary = $('[data-ob-errors]'), items = $('[data-ob-error-list]');
        items.replaceChildren();
        for (const { field, message } of list) {
            const slot = $(`[data-step="${shown}"] [data-error-for="${field}"]`);
            const target = fieldTarget(field);
            if (slot) {
                slot.textContent = message;
                slot.hidden = false;
                slot.id = slot.id || `err-${field}`;
            }
            if (target) {
                target.setAttribute('aria-invalid', 'true');
                const described = new Set((target.getAttribute('aria-describedby') || '').split(' ').filter(Boolean));
                if (slot) described.add(slot.id);
                target.setAttribute('aria-describedby', [...described].join(' '));
            }
            const li = document.createElement('li');
            const link = document.createElement('a');
            link.href = target?.id ? `#${target.id}` : '#obMain';
            link.textContent = message;
            link.addEventListener('click', (event) => { event.preventDefault(); target?.focus(); });
            li.append(link);
            items.append(li);
        }
        summary.hidden = false;
        summary.focus();
    }

    function serverError(error) {
        const message = String(error?.message || '');
        const match = message.match(/invalid_([a-z0-9_]+)/);
        if (match) return [{ field: match[1], message: FIELD_ERRORS[match[1]] || 'Check this answer.' }];
        if (/underage/.test(message)) return [{ field: 'date_of_birth', message: FIELD_ERRORS.underage }];
        return null;
    }

    /* ---- collecting a step ---------------------------------------------------------------- */

    function collect(step) {
        const form = stepForm(step);
        const value = (name) => form.querySelector(`[name="${name}"]:not([disabled])`)?.value ?? '';
        const radio = (name) => form.querySelector(`[name="${name}"]:checked`)?.value ?? null;
        const bool = (name) => { const v = radio(name); return v === null ? null : v === 'true'; };
        if (step === 1) {
            const country = value('country_of_residence');
            let phone = clean(value('phone'), 20).replace(/[\s()-]/g, '');
            // Local Kenyan formats: 07XX / 01XX and 2547XX become +254...
            if (country === 'KE' && /^0[17]\d{8}$/.test(phone)) phone = `+254${phone.slice(1)}`;
            else if (/^254\d{9}$/.test(phone)) phone = `+${phone}`;
            return { legal_first_name: clean(value('legal_first_name'), 50), legal_last_name: clean(value('legal_last_name'), 50), date_of_birth: value('date_of_birth'), country_of_residence: country, nationality: value('nationality'), phone };
        }
        if (step === 2) return { address_line1: clean(value('address_line1'), 120), address_line2: clean(value('address_line2'), 120), city: clean(value('city'), 80), region: clean(value('region'), 80), postal_code: clean(value('postal_code'), 12) };
        if (step === 3) return { employment_status: value('employment_status'), occupation: value('occupation'), annual_income: value('annual_income'), savings: value('savings'), source_of_funds: $$('[name="source_of_funds"]:checked', form).map((box) => box.value), tax_id: clean(value('tax_id'), 20).replace(/\s/g, '').toUpperCase(), is_pep: bool('is_pep') };
        if (step === 4) return { experience_binary: radio('experience_binary'), experience_forex: radio('experience_forex'), experience_shares: radio('experience_shares'), finance_background: bool('finance_background') };
        if (step === 5) return { q1: radio('q1'), q2: radio('q2'), q3: radio('q3'), q4: radio('q4') };
        return { goal: radio('goal'), weekly_time: radio('weekly_time'), ack_lose_stake: $('[name="ack_lose_stake"]', form).checked, ack_practice: $('[name="ack_practice"]', form).checked, ack_afford: $('[name="ack_afford"]', form).checked };
    }

    // Quick checks so a missing answer is pointed out without a round trip. The server checks everything again.
    function missing(step, data) {
        const out = [];
        const need = (field, ok) => { if (!ok) out.push({ field, message: FIELD_ERRORS[field] }); };
        if (step === 1) {
            need('legal_first_name', data.legal_first_name); need('legal_last_name', data.legal_last_name);
            need('date_of_birth', data.date_of_birth);
            if (data.date_of_birth) {
                const adult = new Date(); adult.setFullYear(adult.getFullYear() - 18);
                if (new Date(data.date_of_birth) > adult) out.push({ field: 'date_of_birth', message: FIELD_ERRORS.underage });
            }
            need('country_of_residence', data.country_of_residence); need('nationality', data.nationality);
            need('phone', /^\+[1-9]\d{7,14}$/.test(data.phone));
        } else if (step === 2) {
            need('address_line1', data.address_line1.length >= 2); need('city', data.city.length >= 2); need('region', data.region.length >= 2);
        } else if (step === 3) {
            ['employment_status', 'occupation', 'annual_income', 'savings'].forEach((f) => need(f, data[f]));
            need('source_of_funds', data.source_of_funds.length); need('is_pep', data.is_pep !== null);
        } else if (step === 4) {
            ['experience_binary', 'experience_forex', 'experience_shares'].forEach((f) => need(f, data[f])); need('finance_background', data.finance_background !== null);
        } else if (step === 5) {
            ['q1', 'q2', 'q3', 'q4'].forEach((f) => need(f, data[f]));
        } else {
            need('goal', data.goal); need('weekly_time', data.weekly_time);
            need('acknowledgements', data.ack_lose_stake && data.ack_practice && data.ack_afford);
        }
        return out;
    }

    async function rpc(name, args) {
        const { data, error } = await client.rpc(name, args);
        if (error) throw error;
        return data;
    }

    async function submit(step, button) {
        if (busy) return;
        const data = collect(step);
        const problems = missing(step, data);
        if (problems.length) { showErrors(problems); return; }
        busy = true;
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        status('Saving…');
        try {
            state = await rpc('save_my_verification_step', { p_step: step, p_data: data });
            if (step === 6) {
                state = await rpc('complete_my_verification', {});
                status('');
                renderDone();
                show('done');
                return;
            }
            status('Saved.');
            if (step === 5) { renderReview(data); show('5-result'); }
            else show(step + 1);
        } catch (error) {
            const mapped = serverError(error);
            if (mapped) { status(''); showErrors(mapped); }
            else if (/verification_completed/.test(error?.message || '')) { await load(); }
            else if (/step_locked/.test(error?.message || '')) { status('Finish the earlier steps first.'); await load(); }
            else if (/rate_limited/.test(error?.message || '')) status('Too many changes were saved. Contact support to finish your setup.');
            else status('We could not save this step. Check your connection and try again.');
        } finally {
            busy = false;
            button.disabled = false;
            button.removeAttribute('aria-busy');
        }
    }

    function renderReview(answers) {
        const score = Number(state.knowledge_score) || 0;
        $('[data-ob-score]').textContent = state.appropriateness === 'appropriate'
            ? `You answered ${score} of 4 correctly. You clearly understand the basics. Here is the reasoning behind each answer.`
            : `You answered ${score} of 4 correctly. That is fine: Practice is the place to learn. Read through each answer below; you can change your answers before you continue.`;
        const list = $('[data-ob-review]');
        list.replaceChildren(...Object.entries(ANSWERS).map(([question, info]) => {
            const li = document.createElement('li');
            const legend = $(`[data-field="${question}"] legend`)?.textContent.replace(/^\d+\.\s*/, '') || '';
            const right = answers[question] === info.correct;
            const head = document.createElement('p');
            const verdict = document.createElement('strong');
            verdict.className = right ? 'ob-verdict-right' : 'ob-verdict-wrong';
            verdict.textContent = right ? 'Correct.' : 'Not quite.';
            head.append(verdict, ` ${legend}`);
            const why = document.createElement('p');
            why.className = 'ob-review-why';
            const correctLabel = $(`[name="${question}"][value="${info.correct}"]`)?.parentElement.textContent.trim();
            why.textContent = `${right ? '' : `The answer is: ${correctLabel}. `}${info.text}`;
            li.append(head, why);
            return li;
        }));
    }

    function renderDone() {
        $('[data-ob-appropriateness]').textContent = state.appropriateness === 'appropriate'
            ? 'Your knowledge check showed you understand how digit contracts work.'
            : 'Your knowledge check suggests spending some time in Practice and the guides first. Before Real mode opens to you, we will ask you to take it again.';
    }

    async function load() {
        status('');
        try {
            state = await rpc('get_my_verification', {});
        } catch (_) {
            $('[data-ob-progress-text]').textContent = 'We could not load your verification.';
            status('Check your connection, then reload the page.');
            return;
        }
        fill(state.data);
        if (state.status === 'completed') {
            renderDone();
            show('done', { focus: false });
            return;
        }
        show(Math.min(Math.max(Number(state.current_step) || 1, 1), TOTAL), { focus: false });
    }

    async function boot() {
        countryOptions();
        $('[name="date_of_birth"]').max = (() => { const d = new Date(); d.setFullYear(d.getFullYear() - 18); return d.toISOString().slice(0, 10); })();
        $('[name="date_of_birth"]').min = (() => { const d = new Date(); d.setFullYear(d.getFullYear() - 110); return d.toISOString().slice(0, 10); })();
        for (let step = 1; step <= TOTAL; step += 1) {
            const form = stepForm(step);
            form.addEventListener('submit', (event) => { event.preventDefault(); submit(step, form.querySelector('[type="submit"]')); });
        }
        $$('[data-ob-back]').forEach((button) => button.addEventListener('click', () => {
            const step = Number(button.closest('[data-step]').dataset.step);
            show(step === 6 && $('[data-ob-review]').children.length ? '5-result' : Math.max(1, step - 1));
        }));
        $('[data-ob-retry]').addEventListener('click', () => show(5));
        $('[data-ob-next]').addEventListener('click', () => show(6));
        $('#country_of_residence').addEventListener('change', syncResidence);
        $$('[name="goal"]').forEach((radio) => radio.addEventListener('change', () => { $('[data-income-warning]').hidden = !$('[name="goal"][value="extra_income"]').checked; }));
        try { client = await window.getSupabaseClient(); } catch (_) { status('Sign-in is unavailable. Reload the page to try again.'); return; }
        await load();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
