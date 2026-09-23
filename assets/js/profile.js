(() => {
    'use strict';
    document.addEventListener('DOMContentLoaded', () => {
        const status = document.getElementById('profileStatus');
        if (status) status.textContent = 'Account balances and contract history are available from the active Practice account.';
    });
})();
