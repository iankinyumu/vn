/* Loading indicator: a Lottie line that draws itself (assets/lottie/sp-loader.json),
 * rendered by the self-hosted lottie-web light player. The player is fetched only
 * the first time a loader is shown. Until it is ready, or if it cannot load, a CSS
 * version of the same mark is shown, so a loader is never blank. With reduced
 * motion the animation shows one still frame.
 *
 *   const loader = window.smartProfitLoader.mount(host, { label: 'Loading market' });
 *   loader.remove();
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

    function mount(host, { label = 'Loading', overlay = true } = {}) {
        if (!host) return { remove() {} };
        const root = document.createElement('div');
        root.className = `sp-loader${overlay ? ' sp-loader-overlay' : ''}`;
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

    window.smartProfitLoader = Object.freeze({ mount });
})();
