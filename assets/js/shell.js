/* Single source of the customer shell: the public header and footer, the
   signed-in side panel and top bar, and the restriction-banner mount point.
   Every customer page declares `data-shell-surface` on <body>, sets
   `data-shell-active` for the current nav item and exposes the two mount points
   below; nothing else defines nav markup, so the surfaces can never drift apart. */
(function () {
    'use strict';

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
            const button = element('button', 'btn btn-outline-danger btn-sm rounded-pill px-3');
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

    function buildHeader(activeKey) {
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

    function buildRail(activeKey) {
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
            anchor.title = link.label;
            if (link.key === activeKey) { anchor.classList.add('active'); anchor.setAttribute('aria-current', 'page'); }
            anchor.append(icon(link.icon), element('span', 'app-rail-text', link.label));
            item.append(anchor);
            list.append(item);
        });
        nav.append(list);
        const foot = element('div', 'app-rail-foot');
        const logout = element('button', 'app-rail-link app-rail-logout');
        logout.type = 'button';
        logout.title = 'Log out';
        logout.append(icon('fa-right-from-bracket'), element('span', 'app-rail-text', 'Log out'));
        logout.addEventListener('click', () => { if (typeof window.logout === 'function') window.logout(); });
        const expand = element('button', 'app-rail-link app-rail-expand');
        expand.type = 'button';
        expand.dataset.railExpand = '';
        expand.setAttribute('aria-controls', 'appRail');
        expand.append(icon('fa-angles-right'), element('span', 'app-rail-text', 'Expand'));
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
        const actions = element('div', 'app-topbar-actions');
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
            expand.title = value ? 'Collapse menu' : 'Expand menu';
        };
        const closeDrawer = (focus) => {
            if (!document.body.classList.contains('rail-open')) return;
            document.body.classList.remove('rail-open');
            backdrop.hidden = true;
            opener.setAttribute('aria-expanded', 'false');
            if (focus) opener.focus();
        };
        const openDrawer = () => {
            document.body.classList.add('rail-open');
            backdrop.hidden = false;
            opener.setAttribute('aria-expanded', 'true');
            rail.querySelector('.app-rail-link')?.focus();
        };
        opener.addEventListener('click', () => (document.body.classList.contains('rail-open') ? closeDrawer(true) : openDrawer()));
        backdrop.addEventListener('click', () => closeDrawer(true));
        rail.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDrawer(true); });
        expand.addEventListener('click', () => {
            if (drawer.matches) { closeDrawer(true); return; }
            const next = !document.body.classList.contains('rail-expanded');
            setExpanded(next);
            saveRailPreference(next);
        });
        drawer.addEventListener?.('change', () => closeDrawer(false));
        setExpanded(railPreference());
        return backdrop;
    }

    // Signed-in pages carry one line of legal text; navigation lives in the side panel.
    function buildAppFooter(realSandbox) {
        const footer = element('footer', 'app-footer');
        footer.append(element('p', null, realSandbox ? REAL_SANDBOX_NOTE : FOOTER_NOTE));
        return footer;
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
        if (headerMount && surface === 'app') {
            const rail = buildRail(active);
            const topbar = buildTopbar();
            headerMount.replaceChildren(rail, wireRail(rail, topbar), topbar, buildRestrictionBanner());
            document.body.classList.add('has-rail');
        } else if (headerMount) {
            const header = buildHeader(active);
            headerMount.replaceChildren(header);
            fillSessionAction(header);
        }
        if (footerMount) footerMount.replaceChildren(surface === 'app' ? buildAppFooter(document.body.dataset.shellMode === 'real-sandbox') : buildFooter());
        if (surface === 'app' && !document.body.classList.contains('app-shell')) document.body.classList.add('app-shell');
        if (surface === 'public' && !document.body.classList.contains('public-shell')) document.body.classList.add('public-shell');
        mounted = true;
        return { surface, active };
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
