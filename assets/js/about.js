/* Keep public navigation in sync with the current session. */
document.addEventListener('DOMContentLoaded', async function () {
    function renderSession(session) {
        document.querySelectorAll('[data-about-signed-in]').forEach((node) => { node.hidden = !session; });
        document.querySelectorAll('[data-about-signed-out]').forEach((node) => { node.hidden = Boolean(session); });
    }
    try {
        const client = await getSupabaseClient();
        // Supplies the initial session and subsequent sign-in/out changes.
        client.auth.onAuthStateChange((_event, session) => renderSession(session));
    } catch (_) {
        renderSession(null);
    }
});
