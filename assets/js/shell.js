/* Single source of the customer shell: header, navigation, footer, mode ribbon
   and the restriction-banner mount point. Every customer page declares
   `data-shell-surface` on <body>, sets `data-shell-active` for the current nav
   item and exposes the two mount points below; nothing else defines nav markup,
   so the surfaces can never drift apart again. */
(function () {
    'use strict';

    const PUBLIC_LINKS = Object.freeze([
        { href: 'index.html', label: 'Home', icon: 'fa-house', key: 'home' },
        { href: 'about.html', label: 'About', icon: 'fa-circle-info', key: 'about' },
        { href: 'blog.html', label: 'Blog', icon: 'fa-newspaper', key: 'blog' },
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

    const FOOTER_COLUMNS = Object.freeze({
        public: [
            { title: 'Explore', links: [{ href: 'about.html', label: 'About' }, { href: 'blog.html', label: 'Blog' }, { href: 'contact.html', label: 'Contact' }, { href: 'fairness.html', label: 'Fairness' }] },
            { title: 'Account', links: [{ href: 'faq.html', label: 'FAQ' }, { href: 'login.html', label: 'Sign in' }, { href: 'register.html', label: 'Create account' }] }
        ],
        app: [
            { title: 'Workspace', links: [{ href: 'dashboard.html', label: 'Dashboard' }, { href: 'trade.html', label: 'Trade' }, { href: 'profile.html', label: 'Profile' }] },
            { title: 'Learn', links: [{ href: 'fairness.html', label: 'Fairness' }, { href: 'faq.html', label: 'FAQ' }, { href: 'contact.html', label: 'Contact' }] }
        ]
    });

    const TAGLINE = 'Digit contracts on self-generated indices. Practice only, with virtual funds.';

    let mounted = false;

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
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
        const icon = element('i', `fas ${link.icon} me-1`);
        icon.setAttribute('aria-hidden', 'true');
        anchor.append(icon, document.createTextNode(link.label));
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
            const icon = element('i', 'fas fa-right-from-bracket me-1');
            icon.setAttribute('aria-hidden', 'true');
            button.append(icon, document.createTextNode('Log out'));
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

    function buildHeader(surface, activeKey) {
        const header = element('header', 'premium-header');
        const nav = element('nav', 'navbar navbar-expand-xl');
        const container = element('div', 'container-fluid px-4');
        const brand = element('a', 'navbar-brand premium-logo');
        brand.href = surface === 'app' ? 'dashboard.html' : 'index.html';
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
        const links = surface === 'app' ? APP_LINKS : PUBLIC_LINKS;
        list.append(...links.map((link) => navItem(link, activeKey)));
        if (surface === 'app') {
            const switcherItem = element('li', 'nav-item ms-2');
            const switcher = element('select', 'account-switcher form-select form-select-sm');
            switcher.dataset.accountSwitcher = '';
            switcher.setAttribute('aria-label', 'Active account');
            switcherItem.append(switcher);
            list.append(switcherItem);
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

    function buildFooter(surface) {
        const footer = element('footer', 'premium-footer');
        const container = element('div', 'container-fluid px-4');
        const row = element('div', 'row g-3');
        const brandColumn = element('div', 'col-md-6');
        brandColumn.append(element('div', 'footer-brand-small', 'SmartProfit'), element('p', 'footer-desc', TAGLINE));
        row.append(brandColumn);
        FOOTER_COLUMNS[surface].forEach((column) => {
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
        container.append(element('p', 'text-center footer-bottom-text', '\u00A9 2026 SmartProfit. Practice mode only; virtual funds have no cash value.'));
        footer.append(container);
        return footer;
    }

    function buildRibbon() {
        const ribbon = element('div', 'practice-ribbon');
        ribbon.dataset.practiceRibbon = '';
        ribbon.setAttribute('role', 'note');
        ribbon.textContent = 'PRACTICE \u00B7 virtual funds';
        return ribbon;
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
        if (headerMount) {
            headerMount.replaceChildren();
            if (surface === 'app') headerMount.append(buildRibbon());
            const header = buildHeader(surface, active);
            headerMount.append(header);
            if (surface === 'app') headerMount.append(buildRestrictionBanner());
            fillSessionAction(header);
        }
        if (footerMount) footerMount.replaceChildren(buildFooter(surface));
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
