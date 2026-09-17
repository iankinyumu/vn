document.getElementById('sandboxSignIn').addEventListener('submit', async (event) => {
    event.preventDefault();
    const response = await fetch('/sandbox-api/signin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity: document.getElementById('identity').value }) });
    const result = await response.json();
    document.getElementById('sandboxStatus').textContent = result.error ? 'Unable to select test account.' : `Signed in as ${result.data.session.user.email}. Open the staff workspace or customer conversations.`;
});
