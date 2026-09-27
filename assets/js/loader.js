/* Loading indicator: a Lottie line that draws itself (assets/lottie/sp-loader.json),
 * rendered by the self-hosted lottie-web light player. The player is fetched only
 * the first time a loader is shown. Until it is ready, or if it cannot load, a CSS
 * version of the same mark is shown, so a loader is never blank. With reduced
 * motion the animation shows one still frame.
 *
 *   const loader = window.smartProfitLoader.mount(host, { label: 'Loading market' });
 *   loader.remove();
 *
 * A page that declares data-page-loader="Loading dashboard" on <body> is covered
 * below the top bar from the moment this script runs until the page calls
 * window.smartProfitLoader.pageReady() once its main data has loaded or failed.
 * A 20 second limit guarantees the page is never left covered.
 */
(function () {
    'use strict';

    const base = (() => {
        const script = document.currentScript?.src || '';
        return script ? script.replace(/js\/loader\.js(\?.*)?$/, '') : '../assets/';
    })();
    const PLAYER = `${base}vendor/lottie/lottie_light.min.js`;
    const ANIMATION = `${base}lottie/sp-loader.json`;
    const STILL_FRAME = 60;
    let player = null;

    const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

    function loadPlayer() {
        if (window.lottie) return Promise.resolve(window.lottie);
        if (!player) {
            player = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = PLAYER;
                script.async = true;
                script.onload = () => (window.lottie ? resolve(window.lottie) : reject(new Error('lottie missing')));
                script.onerror = () => reject(new Error('lottie failed to load'));
                document.head.append(script);
            });
            // A failed load is not cached, so a later loader tries again.
            player.catch(() => { player = null; });
        }
        return player;
    }

    function mount(host, { label = 'Loading', overlay = true, compact = false } = {}) {
        if (!host) return { remove() {} };
        const root = document.createElement('div');
        root.className = `sp-loader${overlay ? ' sp-loader-overlay' : ''}${compact ? ' sp-loader-compact' : ''}`;
        root.dataset.loader = '';
        root.setAttribute('role', 'status');
        const art = document.createElement('div');
        art.className = 'sp-loader-art';
        art.setAttribute('aria-hidden', 'true');
        art.dataset.fallback = '';
        const text = document.createElement('span');
        text.className = 'sp-loader-label';
        text.textContent = label;
        root.append(art, text);
        host.append(root);

        let animation = null;
        let removed = false;
        loadPlayer().then((lottie) => {
            if (removed) return;
            animation = lottie.loadAnimation({ container: art, renderer: 'svg', loop: true, autoplay: !reducedMotion(), path: ANIMATION, rendererSettings: { preserveAspectRatio: 'xMidYMid meet' } });
            animation.addEventListener('DOMLoaded', () => {
                if (removed) return;
                delete art.dataset.fallback;
                if (reducedMotion()) animation.goToAndStop(STILL_FRAME, true);
            });
            animation.addEventListener('data_failed', () => { art.dataset.fallback = ''; });
        }).catch(() => { /* The CSS mark stays. */ });

        return {
            element: root,
            setLabel(next) { text.textContent = next; },
            remove() {
                if (removed) return;
                removed = true;
                animation?.destroy();
                root.remove();
            },
        };
    }

    const PAGE_LIMIT_MS = 20000;
    let pageLoader = null;
    let pageTimer = null;

    function startPage() {
        const label = document.body?.dataset.pageLoader;
        if (!label) return;
        const host = document.createElement('div');
        host.className = 'sp-page-loader';
        host.dataset.pageLoaderHost = '';
        document.body.append(host);
        const busy = () => { if (pageLoader) document.querySelector('main')?.setAttribute('aria-busy', 'true'); };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', busy, { once: true }); else busy();
        pageLoader = { host, loader: mount(host, { label, overlay: false }) };
        pageTimer = setTimeout(pageReady, PAGE_LIMIT_MS);
    }

    function pageReady() {
        clearTimeout(pageTimer);
        if (!pageLoader) return;
        const { host, loader } = pageLoader;
        pageLoader = null;
        document.querySelector('main')?.removeAttribute('aria-busy');
        host.classList.add('is-done');
        setTimeout(() => { loader.remove(); host.remove(); }, reducedMotion() ? 0 : 200);
    }

    // A table row holding a compact loader, for tables that reload in place.
    function row(columns, label = 'Loading') {
        const tr = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = columns;
        tr.append(cell);
        mount(cell, { label, overlay: false, compact: true });
        return tr;
    }

    window.smartProfitLoader = Object.freeze({ mount, pageReady, row });
    startPage();
})();
