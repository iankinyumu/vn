(() => {
    'use strict';
    document.addEventListener('DOMContentLoaded', () => {
        const status = document.getElementById('profileStatus');
        if (status) status.textContent = 'Balances and contract history follow the account selected in the menu at the top.';
    });
})();
