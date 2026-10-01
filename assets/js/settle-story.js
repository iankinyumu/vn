// "How a digit contract settles" on index.html: a scroll-driven walk through one contract.
// Presentation only. The section is complete without this script; GSAP enhances it when it
// loads, and gsap.matchMedia() leaves it static for anyone who prefers reduced motion.
(() => {
    const root = document.querySelector('[data-settle-story]');
    if (!root || !window.gsap || !window.ScrollTrigger) return;
    const { gsap, ScrollTrigger } = window;
    gsap.registerPlugin(ScrollTrigger);

    const steps = root.querySelectorAll('.settle-step');
    const ticks = root.querySelectorAll('.settle-tick');
    const ring = root.querySelector('.settle-ring');
    const [outcome, verify] = root.querySelectorAll('.settle-outcome, .settle-verify');
    const DIM = 0.35;

    const mm = gsap.matchMedia();
    mm.add({
        desktop: '(min-width: 992px) and (prefers-reduced-motion: no-preference)',
        compact: '(max-width: 991.98px) and (prefers-reduced-motion: no-preference)',
    }, ({ conditions }) => {
        // Desktop pins the section while the story plays; phones scrub it in place.
        const scrollTrigger = conditions.desktop
            ? { trigger: root, start: 'top top', end: '+=1200', pin: true, scrub: 0.6 }
            : { trigger: root, start: 'top 70%', end: 'bottom 70%', scrub: 0.6 };
        gsap.set(steps, { autoAlpha: DIM });
        const tl = gsap.timeline({ defaults: { duration: 0.5, ease: 'power2.out' }, scrollTrigger });

        tl.addLabel('buy')
            .to(steps[0], { autoAlpha: 1 }, 'buy')
            .from(ticks[0], { autoAlpha: 0, y: 10 }, 'buy+=0.2')
            .addLabel('ticks')
            .to(steps[0], { autoAlpha: DIM }, 'ticks')
            .to(steps[1], { autoAlpha: 1 }, 'ticks')
            .from([ticks[1], ticks[2], ticks[3]], { autoAlpha: 0, y: 10, stagger: 0.3 }, 'ticks+=0.1')
            .addLabel('settle')
            .to(steps[1], { autoAlpha: DIM }, 'settle')
            .to(steps[2], { autoAlpha: 1 }, 'settle')
            .from(ticks[4], { autoAlpha: 0, y: 10 }, 'settle')
            .fromTo(ring, { autoAlpha: 0, scale: 1.6 }, { autoAlpha: 1, scale: 1 }, 'settle+=0.3')
            .from(outcome, { autoAlpha: 0, y: 8 }, 'settle+=0.5')
            .addLabel('verify')
            .to(steps[2], { autoAlpha: DIM }, 'verify')
            .to(steps[3], { autoAlpha: 1 }, 'verify')
            .from(verify, { autoAlpha: 0, y: 8 }, 'verify+=0.2');
    });

    // Web fonts change line heights; recompute trigger positions once they are in.
    document.fonts?.ready.then(() => ScrollTrigger.refresh());
})();
