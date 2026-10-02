/* Notification centre for signed-in pages (migration 20261003100000). The top bar button shows the
 * unread count as text; it opens a sheet with live announcements (site-wide, from administrators)
 * above the person's own notifications (support replies, funding, account). Important
 * announcements that are still unread also show once as a banner under the top bar.
 *
 * New items arrive over Supabase Realtime (RLS limits each subscriber to their own rows and the
 * announcements showing to them) and are shown as a toast through smartProfitNotify. The count is
 * re-read when the page becomes visible again, which also picks up scheduled announcements.
 */
(function () {
    'use strict';

    const PAGE = 30;
    const CATEGORY = Object.freeze({ trade: 'Trade', funding: 'Funding', support: 'Support', account: 'Account', system: 'SmartProfit' });
    const LINK = /^[a-z0-9-]+\.html(\?[A-Za-z0-9=&_.-]{0,200})?$/;

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    const icon = (name) => { const node = el('i', `fas ${name}`); node.setAttribute('aria-hidden', 'true'); return node; };
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    function when(value, now = new Date()) {
        const date = new Date(value);
        const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        return sameDay(date, now) ? time : `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`;
    }

    let client = null, user = null, dialog = null, button = null, banner = null, returnFocus = null;
    let unread = 0, items = [], announcements = [], cursor = null, more = false, loadId = 0;

    function paintCount() {
        if (!button) return;
        const count = button.querySelector('[data-notify-count]');
        count.textContent = unread > 99 ? '99+' : String(unread);
        count.hidden = unread === 0;
        button.setAttribute('aria-label', unread ? `Notifications, ${unread} unread` : 'Notifications');
    }
    const setUnread = (value) => { unread = Math.max(0, Number(value) || 0); paintCount(); };
    async function refreshCount() {
        const { data, error } = await client.rpc('get_notification_unread_count');
        if (!error) setUnread(data);
    }

    // Unread important announcements, newest first, one at a time under the top bar.
    function paintBanner() {
        if (!banner) return;
        const next = announcements.find((item) => item.severity === 'important' && !item.read);
        banner.hidden = !next;
        if (!next) { banner.replaceChildren(); return; }
        const body = el('div', 'engine-notice-body');
        const title = el('p');
        title.append(el('strong', '', 'Important: '), document.createTextNode(next.title));
        body.append(title, el('p', '', next.body));
        if (next.link && LINK.test(next.link)) { const readMore = el('a', 'notify-link', 'Read more'); readMore.href = next.link; body.lastChild.append(' ', readMore); }
        const close = el('button', 'engine-notice-close');
        close.type = 'button';
        close.setAttribute('aria-label', `Dismiss announcement: ${next.title}`);
        close.append(icon('fa-xmark'));
        close.addEventListener('click', () => markRead({ announcement: next }).catch(() => {}));
        banner.replaceChildren(icon('fa-bullhorn'), body, close);
        banner.firstChild.classList.add('engine-notice-icon');
    }

    function itemNode(entry, kind) {
        const li = el('li', 'notify-item');
        li.dataset.notifyItem = kind;
        if (!entry.read) li.classList.add('is-unread');
        const head = el('p', 'notify-meta');
        const label = kind === 'announcement' ? (entry.severity === 'important' ? 'Important announcement' : 'Announcement')
            : entry.from_staff ? 'From support' : (CATEGORY[entry.category] || 'SmartProfit');
        head.append(el('span', '', label), el('span', '', ' · '), el('time', '', when(entry.created_at)));
        head.lastChild.dateTime = entry.created_at;
        if (!entry.read) head.append(el('span', 'notify-unread', ' · Unread'));
        const title = el('p', 'notify-title', entry.title);
        li.append(head, title);
        if (entry.body) li.append(el('p', 'notify-body', entry.body));
        const actions = el('div', 'notify-actions');
        if (entry.link && LINK.test(entry.link)) {
            const open = el('a', 'notify-link', kind === 'announcement' ? 'Read more' : 'Open');
            open.href = entry.link;
            open.addEventListener('click', () => { if (!entry.read) markRead(kind === 'announcement' ? { announcement: entry } : { notification: entry }).catch(() => {}); });
            actions.append(open);
        }
        if (!entry.read) {
            const read = el('button', 'notify-text-btn', 'Mark read');
            read.type = 'button';
            read.addEventListener('click', () => markRead(kind === 'announcement' ? { announcement: entry } : { notification: entry }).catch(showError));
            actions.append(read);
        }
        if (actions.childElementCount) li.append(actions);
        return li;
    }

    function render() {
        const list = dialog.querySelector('[data-notify-list]');
        const sections = [];
        if (announcements.length) {
            const section = el('section', 'notify-group');
            section.append(el('h3', 'notify-group-title', 'Announcements'));
            const ul = el('ul', 'notify-items');
            ul.append(...announcements.map((entry) => itemNode(entry, 'announcement')));
            section.append(ul);
            sections.push(section);
        }
        const today = items.filter((entry) => sameDay(new Date(entry.created_at), new Date()));
        const earlier = items.filter((entry) => !today.includes(entry));
        for (const [name, group] of [['Today', today], ['Earlier', earlier]]) {
            if (!group.length) continue;
            const section = el('section', 'notify-group');
            section.append(el('h3', 'notify-group-title', name));
            const ul = el('ul', 'notify-items');
            ul.append(...group.map((entry) => itemNode(entry, 'notification')));
            section.append(ul);
            sections.push(section);
        }
        list.replaceChildren(...sections);
        dialog.querySelector('[data-notify-empty]').hidden = sections.length > 0;
        dialog.querySelector('[data-notify-more]').hidden = !more;
        dialog.querySelector('[data-notify-all-read]').disabled = unread === 0;
        paintBanner();
    }

    function setState(state) {
        dialog.querySelector('[data-notify-loading]').hidden = state !== 'loading';
        dialog.querySelector('[data-notify-error]').hidden = state !== 'error';
        if (state !== 'ready') { dialog.querySelector('[data-notify-empty]').hidden = true; dialog.querySelector('[data-notify-more]').hidden = true; }
    }
    function showError() { if (dialog) setState('error'); }

    async function load({ append = false } = {}) {
        const id = ++loadId;
        if (!append) setState('loading');
        const { data, error } = await client.rpc('list_my_notifications', { p_before: append ? cursor : null, p_limit: PAGE });
        if (id !== loadId) return;
        if (error) { setState('error'); return; }
        const page = data?.notifications || [];
        announcements = data?.announcements || [];
        items = append ? [...items, ...page] : page;
        cursor = items.at(-1)?.created_at || null;
        more = page.length === PAGE;
        setUnread(data?.unread);
        setState('ready');
        render();
    }

    async function markRead({ notification = null, announcement = null, all = false }) {
        const { data, error } = await client.rpc('mark_notifications_read', {
            p_notification_ids: notification ? [notification.id] : null,
            p_announcement_ids: announcement ? [announcement.id] : null,
            p_all: all,
        });
        if (error) throw error;
        for (const entry of all ? [...items, ...announcements] : [notification, announcement]) if (entry) entry.read = true;
        setUnread(data);
        if (dialog) render(); else paintBanner();
    }

    const TEMPLATE = `
        <div class="notify-head">
            <h2 class="notify-heading" id="notifyTitle">Notifications</h2>
            <button type="button" class="notify-text-btn" data-notify-all-read>Mark all read</button>
            <button type="button" class="notify-close" data-notify-close aria-label="Close"><i class="fas fa-xmark" aria-hidden="true"></i></button>
        </div>
        <div class="notify-scroll">
            <p class="notify-state" data-notify-loading role="status">Loading notifications…</p>
            <div class="notify-state" data-notify-error role="alert" hidden>
                <p>Notifications could not be loaded.</p>
                <button type="button" class="notify-text-btn" data-notify-retry>Try again</button>
            </div>
            <p class="notify-state" data-notify-empty hidden>No notifications yet. Replies from support, payment updates and announcements will appear here.</p>
            <div data-notify-list></div>
            <button type="button" class="notify-more" data-notify-more hidden>Show earlier</button>
        </div>`;

    function ensureDialog() {
        if (dialog) return dialog;
        dialog = el('dialog', 'notify-sheet');
        dialog.dataset.notifySheet = '';
        dialog.setAttribute('aria-labelledby', 'notifyTitle');
        dialog.innerHTML = TEMPLATE;
        document.body.append(dialog);
        dialog.addEventListener('close', () => { button?.setAttribute('aria-expanded', 'false'); returnFocus?.focus?.(); });
        // A click on the backdrop lands on the dialog itself.
        dialog.addEventListener('click', (event) => { if (event.target === dialog) closeSheet(); });
        dialog.querySelector('[data-notify-close]').addEventListener('click', closeSheet);
        dialog.querySelector('[data-notify-retry]').addEventListener('click', () => load().catch(showError));
        dialog.querySelector('[data-notify-more]').addEventListener('click', async (event) => {
            const more = event.currentTarget;
            more.disabled = true; more.setAttribute('aria-busy', 'true');
            try { await load({ append: true }); } catch (_) { showError(); } finally { more.disabled = false; more.removeAttribute('aria-busy'); }
        });
        dialog.querySelector('[data-notify-all-read]').addEventListener('click', async (event) => {
            const all = event.currentTarget;
            all.disabled = true; all.setAttribute('aria-busy', 'true');
            try { await markRead({ all: true }); } catch (_) { showError(); } finally { all.removeAttribute('aria-busy'); all.disabled = unread === 0; }
        });
        return dialog;
    }

    function closeSheet() {
        if (!dialog?.open) return;
        if (typeof dialog.close === 'function') dialog.close(); else { dialog.removeAttribute('open'); dialog.dispatchEvent(new Event('close')); }
    }

    function open() {
        ensureDialog();
        returnFocus = document.activeElement;
        if (!dialog.open) { if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', ''); }
        button?.setAttribute('aria-expanded', 'true');
        load().catch(showError);
    }

    function buildButton(mount) {
        button = el('button', 'app-notify-btn');
        button.type = 'button';
        button.dataset.notifyOpen = '';
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-expanded', 'false');
        const count = el('span', 'app-notify-count', '0');
        count.dataset.notifyCount = '';
        count.setAttribute('aria-hidden', 'true');
        count.hidden = true;
        button.append(icon('fa-bell'), count);
        button.addEventListener('click', open);
        mount.replaceChildren(button);
        paintCount();
    }

    // A new personal notification or announcement: count it, show it, and keep an open sheet current.
    function received(entry, kind) {
        if (!entry?.id) return;
        refreshCount().catch(() => {});
        if (dialog?.open) load().catch(showError);
        else if (kind === 'announcement') loadAnnouncements().catch(() => {});
        // Trades already have their own toasts on the trade page.
        if (kind === 'notification' && entry.category === 'trade') return;
        window.smartProfitNotify?.show({
            title: kind === 'announcement' ? `Announcement: ${entry.title}` : entry.sent_by ? `From support: ${entry.title}` : entry.title,
            detail: entry.body || '',
        });
    }
    // The banner needs the announcements even before the sheet is first opened.
    async function loadAnnouncements() {
        const { data, error } = await client.rpc('list_my_notifications', { p_before: null, p_limit: 1 });
        if (error) return;
        announcements = data?.announcements || [];
        setUnread(data?.unread);
        paintBanner();
    }

    async function start() {
        const mount = document.querySelector('[data-notifications]');
        if (!mount) return;
        banner = document.querySelector('[data-announcement-banner]');
        client = await window.getSupabaseClient?.();
        user = await window.getAuthenticatedUser?.();
        if (!client?.rpc || !user?.id) return;
        buildButton(mount);
        await loadAnnouncements();
        if (client.channel) {
            client.channel(`notifications:${user.id}`)
                .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` }, (payload) => received(payload.new, 'notification'))
                .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'announcements' }, (payload) => received(payload.new, 'announcement'))
                .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'announcements' }, () => loadAnnouncements().catch(() => {}))
                .subscribe((status) => { if (status === 'SUBSCRIBED') refreshCount().catch(() => {}); });
        }
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadAnnouncements().catch(() => {}); });
    }

    window.smartProfitNotifications = Object.freeze({ open, refresh: () => loadAnnouncements() });
    const boot = () => { start().catch(() => { /* Notifications are additive; the page works without them. */ }); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
