/* Frequently asked questions for the digit-index product. The list is the only
   source of FAQ content; the page markup stays empty and is filled in here so
   the answers cannot drift from the behaviour they describe. */
(() => {
    'use strict';

    const CATEGORY_LABELS = Object.freeze({
        general: 'General',
        contracts: 'Contracts',
        payouts: 'Payouts',
        account: 'Account',
        fairness: 'Fairness',
        restrictions: 'Restrictions'
    });

    const FAQS = Object.freeze([
        {
            id: 'what', category: 'general',
            question: 'What can I practise here?',
            answer: 'A practice account buys digit contracts with virtual USD credits. It opens with 10,000.00 USD of practice credit and runs the same engine path a funded account would use: the same quote, purchase, settlement and ledger.'
        },
        {
            id: 'settlement', category: 'contracts',
            question: 'How is a contract decided?',
            answer: 'A contract settles on the final digit of the tick that closes it. Even/Odd are the contract types enabled at launch; Over, Under, Match and Differ exist in the engine but are switched off in the published policy.'
        },
        {
            id: 'independence', category: 'general',
            question: 'Can past digits predict the next one?',
            answer: 'No. Every final digit remains equally likely on each tick, so a run of previous digits does not make any outcome more or less likely. On new ticks, the engine generates the price and its final digit decides the result. Older ticks remain verifiable under their original digit rule.'
        },
        {
            id: 'margin', category: 'payouts',
            question: 'How are payouts priced?',
            answer: 'Payouts use the published policy: payout = floor(stake × (1 − margin) × 10 ÷ winning digits) to the cent, and profit is the payout minus the stake. Policy version 1, the version the platform ships with, sets a house margin of 3.5% for every contract type, so contracts return 96.5% of the amount staked on average. The margin is configurable: a later policy version may set it between 0.5% and 15%, including per contract type, and applies to new purchases only. Every quote shows the exact payout and the policy version before you buy.'
        },
        {
            id: 'rounding', category: 'payouts',
            question: 'Why can the effective margin be slightly above 3.5%?',
            answer: 'Payouts are floored to the cent, never rounded up, so on some small stakes the effective margin is slightly above the published one. For example, a 1.01 Even stake is worth exactly 1.9493 and pays 1.94. The rounding always favours the house. The engine also refuses any contract whose profit would fall below 1% of the stake.'
        },
        {
            id: 'ticks', category: 'contracts',
            question: 'How long does a contract run?',
            answer: 'A contract runs for one to ten ticks, and each index ticks every 2 seconds. The entry tick is always strictly after every tick already published, so a contract can never be bought into a result you have already seen.'
        },
        {
            id: 'stale', category: 'contracts',
            question: 'What happens if the price feed stops?',
            answer: 'The page shows whether the feed is live. If no tick arrives for longer than three tick intervals, the feed is marked stale and buying is disabled until it catches up.'
        },
        {
            id: 'verify', category: 'fairness',
            question: 'How do I verify fairness?',
            answer: 'The fairness page takes an index and a tick range. It checks that the revealed seed matches the commitment published before the epoch started, then recomputes the digits from that seed and reports how many match the published ticks.'
        },
        {
            id: 'verify-limits', category: 'fairness',
            question: 'What does the proof not show?',
            answer: 'Commit–reveal shows that a seed was not swapped after it was committed, and it lets anyone audit past digits. It does not prove the seed was chosen in good faith, and while the seed lives in the database an operator with direct database access could compute future digits. Moving the seed into isolated custody is a prerequisite for any funded account type.'
        },
        {
            id: 'funds', category: 'account',
            question: 'Are practice funds withdrawable?',
            answer: 'No. Practice funds are virtual USD credits. They have no cash value, cannot be withdrawn or transferred, and are not a forecast of any funded result. There is no deposit or withdrawal path anywhere in the product.'
        },
        {
            id: 'reset', category: 'account',
            question: 'Can I reset my practice balance?',
            answer: 'Yes, when the account has no open contracts and its available balance is below the minimum stake. A reset restores the opening credit, is allowed at most once every 24 hours, and reports the reason on screen when it is refused.'
        },
        {
            id: 'real', category: 'account',
            question: 'Is funded trading available?',
            answer: 'Not yet. The account type exists in the data model and stays switched off, so the account switcher lists it as unavailable. Enabling it requires a published readiness checklist and an owner-only, audited activation — not a settings change.'
        },
        {
            id: 'limits', category: 'restrictions',
            question: 'What limits apply to a practice account?',
            answer: 'Practice limits are a minimum stake of 1.00 USD, a maximum stake of 1,000.00 USD, at most 20 open contracts, 30 purchases per minute and a capped liability per settle tick. The server checks every one of them on each purchase.'
        },
        {
            id: 'restricted', category: 'restrictions',
            question: 'What happens if my account is restricted?',
            answer: 'A restriction applies to the account you are using. Notices are shown without changing anything, limits are enforced on each request, and a block stops new contracts while contracts already open still settle. The reason and any expiry are shown at the top of the page.'
        }
    ]);

    const normalise = (value) => value.trim().toLowerCase();

    function itemFor(faq) {
        const item = document.createElement('article');
        item.className = 'faq-item';
        item.id = `faq-${faq.id}`;
        item.dataset.category = faq.category;

        const question = document.createElement('button');
        question.type = 'button';
        question.className = 'faq-question';
        question.setAttribute('aria-expanded', 'false');
        question.append(document.createTextNode(faq.question));
        const chevron = document.createElement('i');
        chevron.className = 'fas fa-chevron-down';
        chevron.setAttribute('aria-hidden', 'true');
        question.append(chevron);

        const answer = document.createElement('div');
        answer.className = 'faq-answer';
        answer.hidden = true;
        answer.append(document.createTextNode(faq.answer));

        question.addEventListener('click', () => {
            const open = question.getAttribute('aria-expanded') === 'true';
            question.setAttribute('aria-expanded', String(!open));
            answer.hidden = open;
            item.classList.toggle('active', !open);
        });

        item.append(question, answer);
        return item;
    }

    function matches(faq, category, term) {
        if (category !== 'all' && faq.category !== category) return false;
        if (!term) return true;
        return normalise(`${faq.question} ${faq.answer}`).includes(term);
    }

    function start() {
        const list = document.getElementById('faqList');
        if (!list) return;
        const search = document.getElementById('faqSearch');
        const buttons = Array.from(document.querySelectorAll('.faq-cat-btn'));
        const empty = document.getElementById('faqEmpty');
        let category = 'all';

        const draw = () => {
            const term = normalise(search?.value || '');
            const visible = FAQS.filter((faq) => matches(faq, category, term));
            list.replaceChildren(...visible.map(itemFor));
            if (empty) empty.hidden = visible.length > 0;
        };

        buttons.forEach((button) => {
            button.addEventListener('click', () => {
                category = button.dataset.category || 'all';
                buttons.forEach((other) => other.classList.toggle('active', other === button));
                draw();
            });
        });
        search?.addEventListener('input', draw);

        // A #faq-<id> link (from another page or the sidebar) shows every question, opens that answer and scrolls to it.
        const openLinked = () => {
            const id = window.location.hash.startsWith('#faq-') ? window.location.hash.slice(1) : '';
            if (!id || !FAQS.some((faq) => `faq-${faq.id}` === id)) return;
            category = 'all';
            buttons.forEach((other) => other.classList.toggle('active', other.dataset.category === 'all'));
            if (search) search.value = '';
            draw();
            const item = document.getElementById(id);
            const question = item?.querySelector('.faq-question');
            if (question?.getAttribute('aria-expanded') === 'false') question.click();
            item?.scrollIntoView?.();
        };
        draw();
        openLinked();
        window.addEventListener('hashchange', openLinked);
    }

    window.SMARTPROFIT_FAQS = FAQS;
    window.SMARTPROFIT_FAQ_CATEGORIES = CATEGORY_LABELS;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})();
