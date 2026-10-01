/* Single source of the customer shell: the public header and footer, the
   signed-in side panel and top bar, and the restriction-banner mount point.
   Every customer page declares `data-shell-surface` on <body>, sets
   `data-shell-active` for the current nav item and exposes the two mount points
   below; nothing else defines nav markup, so the surfaces can never drift apart. */
(function () {
    'use strict';

    // Where this script lives, so the avatar list (avatars.js) can be loaded beside it on demand.
    const SHELL_SRC = document.currentScript?.src || '';

    const PUBLIC_LINKS = Object.freeze([
        { href: 'index.html', label: 'Home', icon: 'fa-house', key: 'home' },
        { href: 'about.html', label: 'About', icon: 'fa-circle-info', key: 'about' },
        { href: 'blog.html', label: 'Guides', icon: 'fa-book-open', key: 'blog' },
        { href: 'faq.html', label: 'FAQ', icon: 'fa-circle-question', key: 'faq' },
        { href: 'contact.html', label: 'Contact', icon: 'fa-headset', key: 'contact' },
        { href: 'fairness.html', label: 'Fairness', icon: 'fa-scale-balanced', key: 'fairness' }
    ]);

    const APP_LINKS = Object.freeze([
        { href: 'dashboard.html', label: 'Dashboard', icon: 'fa-gauge-high', key: 'dashboard' },
        { href: 'trade.html', label: 'Trade', icon: 'fa-chart-simple', key: 'trade' },
        { href: 'fairness.html', label: 'Fairness', icon: 'fa-scale-balanced', key: 'fairness' },
        { href: 'profile.html', label: 'Profile', icon: 'fa-user-circle', key: 'profile' }
    ]);

    const FOOTER_COLUMNS = Object.freeze([
        { title: 'Explore', links: [{ href: 'about.html', label: 'About' }, { href: 'blog.html', label: 'Guides' }, { href: 'contact.html', label: 'Contact' }, { href: 'fairness.html', label: 'Fairness' }] },
        { title: 'Account', links: [{ href: 'faq.html', label: 'FAQ' }, { href: 'login.html', label: 'Sign in' }, { href: 'register.html', label: 'Create account' }] }
    ]);

    const APP_FOOTER_LINKS = Object.freeze([
        { href: 'faq.html', label: 'FAQ' },
        { href: 'contact.html', label: 'Contact' },
        { href: 'blog.html', label: 'Guides' }
    ]);

    const TAGLINE = 'Digit contracts on self-generated indices. Practice only, with virtual funds.';
    const FOOTER_NOTE = '© 2026 SmartProfit. Practice mode only; virtual funds have no cash value.';
    // A page in Real mode declares data-shell-mode="real-sandbox" on <body>. Today the
    // only Real surface is the Daraja sandbox. Its credits are test-only, but a
    // prompt to a tester's own phone charges real M-Pesa money.
    const REAL_SANDBOX_NOTE = '© 2026 SmartProfit. Real mode is in Daraja Sandbox testing: credits are test-only, but a prompt to your own phone charges real M-Pesa money. Practice mode stays strictly virtual.';
    const RAIL_KEY = 'smartprofit:rail-expanded';

    let mounted = false;

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function icon(name) {
        const node = element('i', `fas ${name}`);
        node.setAttribute('aria-hidden', 'true');
        return node;
    }

    function navItem(link, activeKey) {
        const item = element('li', 'nav-item');
        const anchor = element('a', 'nav-link');
        anchor.href = link.href;
        if (link.key === activeKey) {
            anchor.classList.add('active');
            anchor.setAttribute('aria-current', 'page');
        }
        const glyph = icon(link.icon);
        glyph.classList.add('me-1');
        anchor.append(glyph, document.createTextNode(link.label));
        item.append(anchor);
        return item;
    }

    async function appendSessionAction(list) {
        const item = element('li', 'nav-item ms-2');
        let signedIn = false;
        try {
            signedIn = typeof window.isAuthenticated === 'function' && await window.isAuthenticated();
        } catch (_) {
            signedIn = false;
        }
        if (signedIn) {
            // Logging out loses nothing, so it takes the quiet style rather than the destructive one.
            const button = element('button', 'btn btn-outline-light btn-sm rounded-pill px-3');
            button.type = 'button';
            const glyph = icon('fa-right-from-bracket');
            glyph.classList.add('me-1');
            button.append(glyph, document.createTextNode('Log out'));
            button.addEventListener('click', () => { if (typeof window.logout === 'function') window.logout(); });
            item.append(button);
        } else {
            const anchor = element('a', 'btn btn-premium-primary btn-sm rounded-pill px-3', 'Create account');
            anchor.href = 'register.html';
            const signIn = element('a', 'btn btn-outline-light btn-sm rounded-pill px-3 me-1', 'Sign in');
            signIn.href = 'login.html';
            item.append(signIn, anchor);
        }
        list.append(item);
        return signedIn;
    }

    /* Appearance: System (follows the device), Light or Dark, from theme.js. A button opens a
       menu of three radio items. The menu is a popover, so it sits in the top layer where the
       side panel's clipping cannot cut it off, and Escape or a click outside closes it. */
    const APPEARANCE = Object.freeze([
        { value: 'system', label: 'System', detail: 'Match this device', icon: 'fa-circle-half-stroke' },
        { value: 'light', label: 'Light', icon: 'fa-sun' },
        { value: 'dark', label: 'Dark', icon: 'fa-moon' }
    ]);
    let appearanceCount = 0;

    function buildAppearance(where) {
        const store = window.smartProfitAppearance;
        const id = `appearanceMenu${++appearanceCount}`;
        const inRail = where === 'rail';
        const button = element('button', inRail ? 'app-rail-link appearance-toggle' : 'nav-link appearance-toggle appearance-nav');
        button.type = 'button';
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-controls', id);
        const glyph = icon('fa-circle-half-stroke');
        const text = element('span', inRail ? 'app-rail-text' : 'appearance-nav-text', 'Appearance');
        button.append(glyph, text);
        const menu = element('div', 'appearance-menu');
        menu.id = id;
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', 'Appearance');
        const popover = typeof menu.showPopover === 'function';
        if (popover) menu.popover = 'auto'; else menu.hidden = true;
        const items = APPEARANCE.map((choice) => {
            const item = element('button', 'appearance-item');
            item.type = 'button';
            item.setAttribute('role', 'menuitemradio');
            item.dataset.appearance = choice.value;
            item.tabIndex = -1;
            const label = element('span', 'appearance-item-label');
            label.append(icon(choice.icon), document.createTextNode(choice.label));
            item.append(label);
            if (choice.detail) item.append(element('span', 'appearance-item-detail', choice.detail));
            menu.append(item);
            return item;
        });
        const isOpen = () => (popover ? menu.matches(':popover-open') : !menu.hidden);
        const sync = () => {
            const current = store ? store.get() : 'system';
            const choice = APPEARANCE.find((entry) => entry.value === current) || APPEARANCE[0];
            glyph.className = `fas ${choice.icon}`;
            button.setAttribute('aria-label', `Appearance: ${choice.label}`);
            items.forEach((item) => item.setAttribute('aria-checked', String(item.dataset.appearance === current)));
        };
        // The menu is a fixed 240 by about 150px (tokens.css), so it can be placed before it shows.
        const MENU_W = 240, MENU_H = 160, GAP = 8;
        const place = () => {
            const box = button.getBoundingClientRect();
            const width = document.documentElement.clientWidth, height = window.innerHeight;
            const rtl = window.getComputedStyle(button).direction === 'rtl';
            const clampX = (x) => Math.min(Math.max(GAP, x), width - MENU_W - GAP);
            let left, top;
            if (inRail && (rtl ? box.left : width - box.right) >= MENU_W + 2 * GAP) {
                // Beside the side panel, bottom-aligned with the button.
                left = rtl ? box.left - GAP - MENU_W : box.right + GAP;
                top = box.bottom - MENU_H;
            } else if (inRail) {
                // In the phone drawer there is no room beside it: open above the button.
                left = rtl ? box.right - 12 - MENU_W : box.left + 12;
                top = box.top - 6 - MENU_H;
            } else {
                // Under the header button, aligned to its end edge; above it if there is no room below.
                left = rtl ? box.left : box.right - MENU_W;
                top = box.bottom + 6 + MENU_H <= height - GAP ? box.bottom + 6 : box.top - 6 - MENU_H;
            }
            Object.assign(menu.style, { position: 'fixed', margin: '0', right: 'auto', bottom: 'auto', left: `${Math.round(clampX(left))}px`, top: `${Math.round(Math.min(Math.max(GAP, top), height - MENU_H - GAP))}px` });
        };
        const focusChecked = () => (items.find((item) => item.getAttribute('aria-checked') === 'true') || items[0]).focus();
        const open = () => {
            if (popover) { menu.showPopover(); return; }
            sync();
            place();
            menu.hidden = false;
            button.setAttribute('aria-expanded', 'true');
            focusChecked();
        };
        const close = (focus) => {
            if (isOpen()) { if (popover) menu.hidePopover(); else menu.hidden = true; }
            button.setAttribute('aria-expanded', 'false');
            if (focus) button.focus();
        };
        if (popover) {
            // The button is the popover's invoker, so pressing it while open closes it rather
            // than light-dismissing and reopening.
            button.popoverTargetElement = menu;
            menu.addEventListener('beforetoggle', (event) => {
                const opening = event.newState === 'open';
                if (opening) { sync(); place(); }
                button.setAttribute('aria-expanded', String(opening));
            });
            menu.addEventListener('toggle', (event) => { if (event.newState === 'open') focusChecked(); });
        } else {
            button.addEventListener('click', () => (isOpen() ? close(false) : open()));
            document.addEventListener('pointerdown', (event) => { if (isOpen() && !menu.contains(event.target) && !button.contains(event.target)) close(false); });
        }
        button.addEventListener('keydown', (event) => { if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !isOpen()) { event.preventDefault(); open(); } });
        menu.addEventListener('click', (event) => {
            const item = event.target.closest('.appearance-item');
            if (!item) return;
            if (store) store.set(item.dataset.appearance);
            close(true);
        });
        menu.addEventListener('keydown', (event) => {
            const at = items.indexOf(document.activeElement);
            const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
            if (move !== undefined) { event.preventDefault(); items[(move + items.length) % items.length].focus(); }
            else if (event.key === 'Escape') { event.preventDefault(); close(true); }
            else if (event.key === 'Tab') close(false);
        });
        window.addEventListener('smartprofit:appearance', sync);
        window.addEventListener('resize', () => { if (isOpen()) place(); });
        sync();
        return { button, menu };
    }

    function buildHeader(activeKey, appearanceButton) {
        const header = element('header', 'premium-header');
        const nav = element('nav', 'navbar navbar-expand-xl');
        const container = element('div', 'container-fluid px-4');
        const brand = element('a', 'navbar-brand premium-logo');
        brand.href = 'index.html';
        brand.setAttribute('aria-label', 'SmartProfit home');
        const logoText = element('div', 'logo-text');
        logoText.append(element('span', 'logo-primary', 'Smart'), element('span', 'logo-secondary', 'Profit'));
        brand.append(logoText);
        const toggler = element('button', 'navbar-toggler');
        toggler.type = 'button';
        toggler.dataset.bsToggle = 'collapse';
        toggler.dataset.bsTarget = '#smartProfitNav';
        toggler.setAttribute('aria-label', 'Toggle navigation');
        toggler.setAttribute('aria-expanded', 'false');
        toggler.setAttribute('aria-controls', 'smartProfitNav');
        toggler.append(element('span', 'navbar-toggler-icon'));
        const collapse = element('div', 'collapse navbar-collapse');
        collapse.id = 'smartProfitNav';
        const list = element('ul', 'navbar-nav ms-auto align-items-center gap-1');
        list.append(...PUBLIC_LINKS.map((link) => navItem(link, activeKey)));
        if (appearanceButton) {
            const appearanceItem = element('li', 'nav-item');
            appearanceItem.append(appearanceButton);
            list.append(appearanceItem);
        }
        const sessionItem = element('li', 'nav-item ms-2');
        sessionItem.dataset.shellSession = '';
        list.append(sessionItem);
        collapse.append(list);
        container.append(brand, toggler, collapse);
        nav.append(container);
        header.append(nav);
        return header;
    }

    function buildFooter() {
        const footer = element('footer', 'premium-footer');
        const container = element('div', 'container-fluid px-4');
        const row = element('div', 'row g-3');
        const brandColumn = element('div', 'col-md-6');
        brandColumn.append(element('div', 'footer-brand-small', 'SmartProfit'), element('p', 'footer-desc', TAGLINE));
        row.append(brandColumn);
        FOOTER_COLUMNS.forEach((column) => {
            const cell = element('div', 'col-md-3');
            cell.append(element('h6', null, column.title));
            const list = element('ul');
            column.links.forEach((link) => {
                const item = element('li');
                const anchor = element('a', null, link.label);
                anchor.href = link.href;
                item.append(anchor);
                list.append(item);
            });
            cell.append(list);
            row.append(cell);
        });
        container.append(row, element('hr', 'footer-divider'));
        container.append(element('p', 'text-center footer-bottom-text', FOOTER_NOTE));
        footer.append(container);
        return footer;
    }

    /* Signed-in pages: a thin side panel holds the brand, navigation and log out.
       It expands in place on wide screens and slides in as a drawer on phones.
       The top bar carries only the mode switch and the funding actions. */
    const railPreference = () => { try { return localStorage.getItem(RAIL_KEY) === '1'; } catch (_) { return false; } };
    const saveRailPreference = (value) => { try { localStorage.setItem(RAIL_KEY, value ? '1' : '0'); } catch (_) { /* The preference is a convenience only. */ } };

    function buildRail(activeKey, appearanceButton) {
        const rail = element('aside', 'app-rail');
        rail.id = 'appRail';
        rail.dataset.appRail = '';
        const brand = element('a', 'app-rail-brand');
        brand.href = 'dashboard.html';
        brand.setAttribute('aria-label', 'SmartProfit home');
        const mark = element('span', 'app-rail-mark');
        mark.setAttribute('aria-hidden', 'true');
        mark.append(element('span', 'logo-primary', 'S'), element('span', 'logo-secondary', 'P'));
        const word = element('span', 'app-rail-word');
        word.setAttribute('aria-hidden', 'true');
        word.append(element('span', 'logo-primary', 'Smart'), element('span', 'logo-secondary', 'Profit'));
        brand.append(mark, word);
        const nav = element('nav', 'app-rail-nav');
        nav.setAttribute('aria-label', 'Main');
        const list = element('ul');
        APP_LINKS.forEach((link) => {
            const item = element('li');
            const anchor = element('a', 'app-rail-link');
            anchor.href = link.href;
            if (link.key === 'profile') anchor.dataset.railProfile = '';
            if (link.key === activeKey) { anchor.classList.add('active'); anchor.setAttribute('aria-current', 'page'); }
            anchor.append(icon(link.icon), element('span', 'app-rail-text', link.label));
            item.append(anchor);
            list.append(item);
        });
        nav.append(list);
        const foot = element('div', 'app-rail-foot');
        const logout = element('button', 'app-rail-link app-rail-logout');
        logout.type = 'button';
        logout.append(icon('fa-right-from-bracket'), element('span', 'app-rail-text', 'Log out'));
        logout.addEventListener('click', () => { if (typeof window.logout === 'function') window.logout(); });
        const expand = element('button', 'app-rail-link app-rail-expand');
        expand.type = 'button';
        expand.dataset.railExpand = '';
        expand.setAttribute('aria-controls', 'appRail');
        expand.append(icon('fa-angles-right'), element('span', 'app-rail-text', 'Expand'));
        if (appearanceButton) foot.append(appearanceButton);
        foot.append(logout, expand);
        rail.append(brand, nav, foot);
        return rail;
    }

    function buildTopbar() {
        const bar = element('header', 'app-topbar');
        const menu = element('button', 'app-topbar-menu');
        menu.type = 'button';
        menu.dataset.railOpen = '';
        menu.setAttribute('aria-label', 'Open menu');
        menu.setAttribute('aria-controls', 'appRail');
        menu.setAttribute('aria-expanded', 'false');
        menu.append(icon('fa-bars'));
        const switcher = element('div');
        switcher.dataset.accountSwitcher = '';
        // Funding is a Real mode action: the mode switch reveals these once the active mode is Real.
        const actions = element('div', 'app-topbar-actions');
        actions.dataset.fundingActions = '';
        actions.hidden = true;
        const deposit = element('button', 'app-fund-btn app-fund-deposit');
        deposit.type = 'button';
        deposit.dataset.fundingOpen = 'deposit';
        deposit.append(icon('fa-plus'), document.createTextNode('Deposit'));
        const withdraw = element('button', 'app-fund-btn app-fund-withdraw');
        withdraw.type = 'button';
        withdraw.dataset.fundingOpen = 'withdraw';
        withdraw.append(icon('fa-arrow-up'), document.createTextNode('Withdraw'));
        actions.append(deposit, withdraw);
        bar.append(menu, switcher, actions);
        return bar;
    }

    function wireRail(rail, topbar) {
        const backdrop = element('div', 'app-rail-backdrop');
        backdrop.hidden = true;
        const opener = topbar.querySelector('[data-rail-open]');
        const expand = rail.querySelector('[data-rail-expand]');
        const drawer = window.matchMedia ? window.matchMedia('(max-width: 991.98px)') : { matches: false };
        const setExpanded = (value) => {
            document.body.classList.toggle('rail-expanded', value);
            expand.setAttribute('aria-expanded', String(value));
            expand.querySelector('.app-rail-text').textContent = value ? 'Collapse' : 'Expand';
            hideTip();
        };
        // Collapsed, the panel shows icons only, so a label appears beside the item under the
        // keyboard focus or the pointer. It is visual only: each item already has its text for
        // assistive technology. Escape dismisses it (WCAG 1.4.13).
        const tip = element('div', 'app-rail-tip');
        tip.setAttribute('aria-hidden', 'true');
        tip.hidden = true;
        rail.append(tip);
        function hideTip() { tip.hidden = true; }
        const showTip = (item) => {
            if (drawer.matches || document.body.classList.contains('rail-expanded')) return;
            const box = item.getBoundingClientRect();
            const rtl = window.getComputedStyle(rail).direction === 'rtl';
            tip.textContent = item.querySelector('.app-rail-text')?.textContent || '';
            tip.style.top = `${Math.round(box.top + box.height / 2)}px`;
            tip.style.insetInlineStart = `${Math.round(rtl ? window.innerWidth - box.left : box.right) + 8}px`;
            tip.hidden = false;
        };
        const railItem = (event) => event.target.closest?.('.app-rail-link');
        rail.addEventListener('focusin', (event) => { const item = railItem(event); if (item?.matches(':focus-visible')) showTip(item); });
        rail.addEventListener('focusout', hideTip);
        rail.addEventListener('pointerover', (event) => { const item = railItem(event); if (item && event.pointerType === 'mouse') showTip(item); });
        rail.addEventListener('pointerout', (event) => { if (railItem(event) && !railItem(event).contains(event.relatedTarget)) hideTip(); });
        // On phones the closed drawer sits off screen; inert keeps it out of the Tab order and
        // the accessibility tree. While it is open, the page behind it is inert instead.
        let covered = [];
        const syncInert = () => { rail.inert = drawer.matches && !document.body.classList.contains('rail-open'); };
        const closeDrawer = (focus) => {
            if (!document.body.classList.contains('rail-open')) return;
            document.body.classList.remove('rail-open');
            backdrop.hidden = true;
            opener.setAttribute('aria-expanded', 'false');
            covered.forEach((node) => { node.inert = false; });
            covered = [];
            syncInert();
            if (focus) opener.focus();
        };
        const openDrawer = () => {
            document.body.classList.add('rail-open');
            backdrop.hidden = false;
            opener.setAttribute('aria-expanded', 'true');
            syncInert();
            covered = [...document.body.children].filter((node) => !node.contains(rail) && !node.inert);
            covered.forEach((node) => { node.inert = true; });
            rail.querySelector('.app-rail-link')?.focus();
        };
        const focusable = () => [...rail.querySelectorAll('a[href], button:not([disabled])')].filter((node) => node.offsetParent !== null);
        opener.addEventListener('click', () => (document.body.classList.contains('rail-open') ? closeDrawer(true) : openDrawer()));
        backdrop.addEventListener('click', () => closeDrawer(true));
        rail.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') { if (!tip.hidden) { hideTip(); return; } closeDrawer(true); return; }
            // Keep Tab inside the open drawer, as a modal would.
            if (event.key !== 'Tab' || !document.body.classList.contains('rail-open')) return;
            const items = focusable();
            const first = items[0];
            const last = items[items.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        });
        expand.addEventListener('click', () => {
            if (drawer.matches) { closeDrawer(true); return; }
            const next = !document.body.classList.contains('rail-expanded');
            setExpanded(next);
            saveRailPreference(next);
        });
        drawer.addEventListener?.('change', () => { closeDrawer(false); syncInert(); });
        setExpanded(railPreference());
        syncInert();
        return backdrop;
    }

    // Signed-in pages carry one line of legal text; navigation lives in the side panel.
    function buildAppFooter(realSandbox) {
        const footer = element('footer', 'app-footer');
        const links = element('nav', 'app-footer-links');
        links.setAttribute('aria-label', 'Help');
        APP_FOOTER_LINKS.forEach((link) => { const anchor = element('a', null, link.label); anchor.href = link.href; links.append(anchor); });
        footer.append(links, element('p', null, realSandbox ? REAL_SANDBOX_NOTE : FOOTER_NOTE));
        return footer;
    }

    // Scheduled engine changes (engine-notice.js fills it; empty and hidden otherwise).
    function buildEngineNotice() {
        const notice = element('div', 'engine-notice');
        notice.dataset.engineNotice = '';
        notice.setAttribute('role', 'status');
        notice.hidden = true;
        return notice;
    }

    function buildRestrictionBanner() {
        const banner = element('div', 'restriction-banner');
        banner.dataset.restrictionBanner = '';
        banner.setAttribute('role', 'status');
        banner.setAttribute('aria-live', 'polite');
        banner.hidden = true;
        return banner;
    }

    function declaredSurface() {
        const declared = document.body.dataset.shellSurface || document.documentElement.dataset.shellSurface;
        if (declared === 'app' || declared === 'public') return declared;
        return document.body.classList.contains('app-shell') ? 'app' : 'public';
    }

    function mount(options = {}) {
        const surface = options.surface || declaredSurface();
        const active = options.active || document.body.dataset.shellActive || '';
        const headerMount = document.querySelector('[data-shell-header]');
        const footerMount = document.querySelector('[data-shell-footer]');
        // The appearance menu lives beside the panel or header, inside the mount, so the phone
        // drawer's inert background never includes it.
        if (headerMount && surface === 'app') {
            const appearance = buildAppearance('rail');
            const rail = buildRail(active, appearance.button);
            const topbar = buildTopbar();
            headerMount.replaceChildren(rail, wireRail(rail, topbar), topbar, buildRestrictionBanner(), buildEngineNotice(), appearance.menu);
            document.body.classList.add('has-rail');
            paintRailAvatar(rail);
        } else if (headerMount) {
            const appearance = buildAppearance('nav');
            const header = buildHeader(active, appearance.button);
            headerMount.replaceChildren(header, appearance.menu);
            fillSessionAction(header);
        }
        if (footerMount) footerMount.replaceChildren(surface === 'app' ? buildAppFooter(document.body.dataset.shellMode === 'real-sandbox') : buildFooter());
        if (surface === 'app' && !document.body.classList.contains('app-shell')) document.body.classList.add('app-shell');
        if (surface === 'public' && !document.body.classList.contains('public-shell')) document.body.classList.add('public-shell');
        mounted = true;
        return { surface, active };
    }

    // The side panel's Profile link shows the person's character (avatars.js) instead of a generic
    // icon. The icon stays until the character is known, and the profile picker updates it live.
    function paintRailAvatar(rail) {
        const anchor = rail.querySelector('[data-rail-profile]');
        if (!anchor) return;
        const show = (id) => {
            const avatars = window.smartProfitAvatars;
            if (!avatars?.valid(id)) return;
            let image = anchor.querySelector('.app-rail-avatar');
            if (!image) {
                image = element('img', 'app-rail-avatar');
                Object.assign(image, { alt: '', width: 24, height: 24, decoding: 'async' });
                anchor.querySelector('i')?.replaceWith(image);
            }
            image.src = avatars.src(id);
        };
        document.addEventListener('smartprofit:avatar-changed', (event) => show(event.detail?.avatar));
        const ready = window.smartProfitAvatars ? Promise.resolve() : new Promise((resolve, reject) => {
            const script = Object.assign(document.createElement('script'), { src: new URL('avatars.js', SHELL_SRC || window.location.href).href });
            script.onload = resolve;
            script.onerror = reject;
            document.head.append(script);
        });
        ready.then(() => window.getAuthenticatedUser?.())
            .then((user) => { if (user) show(window.smartProfitAvatars.forUser(user)); })
            .catch(() => { /* Without the list or a session, the Profile icon stays. */ });
    }

    function fillSessionAction(header) {
        const target = header.querySelector('[data-shell-session]');
        if (!target) return;
        appendSessionAction(target).catch(() => { /* The session action stays empty when auth is unavailable. */ });
    }

    window.smartProfitShell = Object.freeze({
        mount,
        get mounted() { return mounted; },
        links: Object.freeze({ public: PUBLIC_LINKS, app: APP_LINKS })
    });

    function boot() {
        if (!mounted) mount();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
