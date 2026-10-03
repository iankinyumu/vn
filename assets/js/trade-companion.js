// Trade page companion: the character the person picked on their profile, parked in a corner.
// It has four jobs and no others (DESIGN.md):
//   1. explain why buying is blocked right now, and what to do about it;
//   2. keep the session limits: say when take-profit or stop-loss is reached, and suggest breaks;
//   3. show the feed at a glance: awake while the feed is live, asleep when it is not;
//   4. help on request: explain the contract type that is selected, plus a first-visit tour.
// It reads only what trade.js already shows on the page. It never reacts to wins, losses,
// payouts or the session result, and never prompts anyone to trade. Same in Practice and Real.
(function () {
    const STORE = 'smartprofit:companion';
    const BREAK_MINUTES = 30;
    const BREAK_TRADES = 25;
    const find = (selector, root = document) => root.querySelector(selector);
    // A preference: kept on the device only with cookie consent (consent.js).
    const prefs = () => window.smartProfitConsent?.store || localStorage;
    const read = () => { try { return JSON.parse(prefs().getItem(STORE)) || {}; } catch (_) { return {}; } };
    const write = (patch) => { try { prefs().setItem(STORE, JSON.stringify({ ...read(), ...patch })); } catch (_) { /* private mode: keep defaults */ } };
    const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const LIVE = new Set(['live', 'polling']);

    const HELP = Object.freeze({
        evenodd: 'Even / Odd: you pick a side, then the last digit of the settle tick decides. Even wins on 0, 2, 4, 6 or 8; Odd wins on 1, 3, 5, 7 or 9. Each digit is equally likely.',
        matchdiffer: 'Matches / Differs: pick a digit. Matches wins only if the settle tick ends in that digit (1 in 10); Differs wins on any other digit (9 in 10), so it pays less.',
        overunder: 'Over / Under: pick a barrier digit. Over wins if the settle digit is higher than it, Under if lower; a settle digit equal to the barrier loses both.',
    });
    const TOUR = Object.freeze([
        'Pick a contract type above the chart, then an index. The digit strip under the chart shows how often each last digit came up recently; past digits never predict the next one.',
        'Set your stake and how many ticks the contract runs. The settle tick is fixed when you buy, and only its last digit decides the result.',
        'Take profit and Stop loss end your session when it reaches either amount. I will tell you when that happens, and suggest breaks on long sessions.',
    ]);

    function start(initialAvatar) {
        let avatarId = initialAvatar;
        const avatars = window.smartProfitAvatars;
        const base = new URL('../img/characters/', document.querySelector('script[src$="trade-companion.js"]')?.src || new URL('../assets/js/', window.location.href)).href;
        const art = (pose) => `${base}${avatarId}${pose === 'asleep' ? '-asleep' : reduceMotion() ? '-still' : ''}.svg`;
        const nameNow = () => avatars?.nameOf(avatarId) || 'Your character';
        const name = nameNow();

        // ---- DOM ----------------------------------------------------------------------------
        const root = document.createElement('aside');
        root.className = 'companion';
        root.dataset.companion = '';
        root.setAttribute('aria-label', `${name}, your trading companion`);
        root.innerHTML = `
            <div class="companion-bubble" data-companion-bubble hidden>
                <p class="companion-text" data-companion-text></p>
                <div class="companion-actions" data-companion-actions></div>
            </div>
            <button type="button" class="companion-figure" data-companion-toggle aria-expanded="false" aria-controls="companionBubble">
                <img data-companion-img alt="" width="64" height="64" decoding="async">
                <span class="visually-hidden" data-companion-label></span>
            </button>
            <button type="button" class="companion-hide" data-companion-hide>Hide</button>
            <p class="visually-hidden" role="status" aria-live="polite" data-companion-live></p>`;
        find('[data-companion-bubble]', root).id = 'companionBubble';
        // Set as an attribute, never inside the template, so a name can never become markup.
        find('[data-companion-hide]', root).setAttribute('aria-label', `Hide ${name}`);
        const bubble = find('[data-companion-bubble]', root);
        const text = find('[data-companion-text]', root);
        const actions = find('[data-companion-actions]', root);
        const toggle = find('[data-companion-toggle]', root);
        const img = find('[data-companion-img]', root);
        const label = find('[data-companion-label]', root);
        const live = find('[data-companion-live]', root);

        const shown = document.createElement('button');
        shown.type = 'button';
        shown.className = 'companion-show';
        shown.dataset.companionShow = '';
        shown.textContent = `Show ${name}`;
        // In the page flow under the order ticket, so it never covers the chart, the fields or the buy bar.
        (find('.trade-ticket') || document.body).append(root, shown);

        // ---- State -------------------------------------------------------------------------
        let message = null;          // what the bubble is saying, { kind, text, actions, announce }
        let pinnedHelp = false;      // the person opened help; blocks do not replace it until closed
        let dismissedBlock = '';     // a block the person closed stays closed until it changes
        const session = { since: Date.now(), trades: 0, nextBreakAt: BREAK_TRADES, nextBreakTime: Date.now() + BREAK_MINUTES * 60000 };

        const setPose = (pose) => {
            const next = art(pose);
            if (img.getAttribute('src') !== next) img.src = next;
            root.dataset.pose = pose;
            label.textContent = pose === 'asleep' ? `${nameNow()} is asleep: the price feed is not live. Open help.` : `${nameNow()}. Open help.`;
        };
        const button = (caption, onClick, primary = false) => {
            const node = Object.assign(document.createElement('button'), { type: 'button', className: primary ? 'companion-action is-primary' : 'companion-action', textContent: caption });
            node.addEventListener('click', onClick);
            return node;
        };
        function say(next) {
            message = next;
            bubble.hidden = !next;
            toggle.setAttribute('aria-expanded', String(Boolean(next)));
            text.textContent = next?.text || '';
            actions.replaceChildren(...(next?.actions || []), ...(next ? [button(next.closeLabel || 'Close', close)] : []));
            // Only the companion's own news is announced; mirrored page messages already have a status role.
            if (next?.announce) live.textContent = next.text;
        }
        function close() {
            if (message?.kind === 'block') dismissedBlock = message.text;
            pinnedHelp = false;
            say(null);
            evaluate();
        }

        // ---- Role 1 and 3: blocks and the feed -------------------------------------------------
        const feed = () => find('[data-feed-state]')?.dataset.state || 'loading';
        function blockReason() {
            const state = feed();
            if (state === 'stale') return 'The price feed is reconnecting, so buying is paused. It unlocks by itself when ticks arrive again.';
            if (state === 'unavailable') return 'The price feed is unavailable right now, so nothing can be bought. Try another index, or reload the page in a moment.';
            if (state === 'empty') return 'This index has no ticks yet. Pick another index, or wait for the first tick.';
            const gate = find('[data-v3-gate]');
            if (gate && !gate.hidden && gate.textContent.trim()) return gate.textContent.trim();
            const stake = find('#trade-stake');
            if (stake && !stake.validity.valid) {
                const min = stake.min ? `$${Number(stake.min).toFixed(2)}` : null, max = stake.max ? `$${Number(stake.max).toFixed(2)}` : null;
                return `That stake can't be used. Enter an amount${min && max ? ` between ${min} and ${max}` : min ? ` of at least ${min}` : ''}, in steps of one cent.`;
            }
            const status = find('[data-trade-status]')?.textContent.trim() || '';
            if (status && !/ bought · exit tick #/.test(status)) return status;
            return null;
        }

        // ---- Role 2: session limits and breaks -----------------------------------------------
        function guardText() {
            const guard = find('[data-session-guard]');
            return guard && !guard.hidden ? find('[data-session-guard-text]')?.textContent.trim() : '';
        }
        function tradesSoFar() {
            const [won, lost] = (find('[data-session-count]')?.textContent.match(/\d+/g) || [0, 0]).map(Number);
            return won + lost;
        }
        function breakDue() {
            const trades = tradesSoFar();
            if (trades < session.trades) Object.assign(session, { since: Date.now(), nextBreakAt: BREAK_TRADES, nextBreakTime: Date.now() + BREAK_MINUTES * 60000 });
            session.trades = trades;
            const minutes = Math.round((Date.now() - session.since) / 60000);
            if (trades >= session.nextBreakAt || (trades > 0 && Date.now() >= session.nextBreakTime)) {
                session.nextBreakAt = trades + BREAK_TRADES;
                session.nextBreakTime = Date.now() + BREAK_MINUTES * 60000;
                const time = minutes >= 1 ? `traded for ${minutes} minute${minutes === 1 ? '' : 's'} and ` : '';
                return `You've ${time}placed ${trades} contract${trades === 1 ? '' : 's'} this session. This is a good moment for a break.`;
            }
            return '';
        }

        // ---- Decide what to show ----------------------------------------------------------------
        function evaluate() {
            setPose(LIVE.has(feed()) ? 'awake' : 'asleep');
            if (pinnedHelp || read().hidden) return;
            const guard = guardText();
            if (guard) {
                if (message?.kind !== 'guard' || message.text.indexOf(guard) !== 0) {
                    say({ kind: 'guard', announce: true, text: `${guard} Your session has stopped here. Taking a break before a new session is a good idea.`, closeLabel: 'OK' });
                }
                return;
            }
            const due = breakDue();
            if (due) { say({ kind: 'break', announce: true, text: due, closeLabel: 'OK' }); return; }
            if (message?.kind === 'break') return;
            const block = blockReason();
            if (block && block !== dismissedBlock) {
                if (message?.text !== block) say({ kind: 'block', text: block });
                return;
            }
            if (!block) dismissedBlock = '';
            if (message && message.kind !== 'tour') say(null);
        }

        // ---- Role 4: help and the first-visit tour ---------------------------------------------
        function selectedHelp() {
            const family = find('[data-families] input:checked')?.value;
            const ticks = find('[data-tick-chips] input:checked')?.value;
            const base = HELP[family] || 'Pick a contract type above the chart to see how it settles.';
            return ticks ? `${base} You've chosen ${ticks} tick${ticks === '1' ? '' : 's'}: the contract settles on the ${ticks === '1' ? 'next' : `${ticks}th`} tick after you buy.` : base;
        }
        function showHelp() {
            pinnedHelp = true;
            say({ kind: 'help', text: selectedHelp(), actions: [button('Show the tour', () => tour(0))] });
        }
        function tour(step) {
            pinnedHelp = true;
            const last = step === TOUR.length - 1;
            say({
                kind: 'tour',
                text: `${step + 1} of ${TOUR.length}. ${TOUR[step]}`,
                actions: last ? [] : [button('Next', () => tour(step + 1), true)],
                closeLabel: last ? 'Done' : 'Skip',
            });
            write({ toured: true });
        }

        // ---- Wiring ------------------------------------------------------------------------------
        toggle.addEventListener('click', () => (message && (message.kind === 'help' || message.kind === 'tour') ? close() : showHelp()));
        find('[data-companion-hide]', root).addEventListener('click', () => { write({ hidden: true }); applyHidden(); });
        shown.addEventListener('click', () => { write({ hidden: false }); applyHidden(); toggle.focus(); });
        root.addEventListener('keydown', (event) => { if (event.key === 'Escape' && message) { close(); toggle.focus(); } });
        function applyHidden() {
            const hidden = Boolean(read().hidden);
            root.hidden = hidden;
            shown.hidden = !hidden;
            if (!hidden) evaluate();
        }

        // Watch only the few nodes that carry blocks, limits and the feed state, not the ticking chart.
        const watched = ['[data-feed-state]', '[data-session-guard]', '[data-session-count]', '[data-trade-status]', '[data-v3-gate]'];
        const observer = new MutationObserver(() => evaluate());
        const observe = () => watched.forEach((selector) => { const node = find(selector); if (node && !node.dataset.companionWatched) { node.dataset.companionWatched = ''; observer.observe(node, { attributes: true, childList: true, subtree: true, characterData: true }); } });
        observe();
        document.addEventListener('input', (event) => { if (event.target.id === 'trade-stake') evaluate(); });
        document.addEventListener('change', () => { observe(); evaluate(); });
        window.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener?.('change', () => evaluate());
        setInterval(evaluate, 60000);

        // Follow a character picked on another device or tab.
        document.addEventListener('smartprofit:avatar-changed', (event) => {
            if (!window.smartProfitAvatars?.valid(event.detail?.avatar) || event.detail.avatar === avatarId) return;
            avatarId = event.detail.avatar;
            img.removeAttribute('src');
            root.setAttribute('aria-label', `${nameNow()}, your trading companion`);
            evaluate();
        });
        window.smartProfitAvatars?.markShown(avatarId);
        window.smartProfitAvatars?.listen();

        applyHidden();
        evaluate();
        // The first-visit tour follows the onboarding answers: someone who trades regularly is not
        // walked through it (it stays one tap away under help); everyone else gets it once.
        if (!read().toured && !read().hidden) {
            const answers = window.smartProfitOnboarding?.answers?.() || Promise.resolve({});
            answers.then((given) => { if (given?.experience === 'experienced') write({ toured: true }); else tour(0); }).catch(() => tour(0));
        }
    }

    // The character is the one picked on the profile (auth metadata), or the stable fallback.
    window.addEventListener('DOMContentLoaded', async () => {
        if (!document.querySelector('[data-trade-form]') || !window.smartProfitAvatars) return;
        try {
            const user = await window.getAuthenticatedUser?.();
            if (user) start(window.smartProfitAvatars.forUser(user));
        } catch (error) { console.error('[smartprofit] companion unavailable', error); }
    });
})();
