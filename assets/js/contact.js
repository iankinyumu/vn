/* assets/js/contact.js */
document.addEventListener('DOMContentLoaded', function () {
    const contactForm = document.getElementById('contactForm');
    if (contactForm) {
        contactForm.addEventListener('submit', function (e) {
            e.preventDefault();
            const firstName = this.querySelector('input[placeholder="John"]').value.trim();
            const lastName = this.querySelector('input[placeholder="Doe"]').value.trim();
            const email = this.querySelector('input[type="email"]').value.trim();
            const subject = this.querySelector('select').value;
            const message = this.querySelector('textarea').value.trim();
            const termsChecked = this.querySelector('input[type="checkbox"]').checked;
            const errors = [];
            if (!firstName) errors.push('First Name is required.');
            if (!lastName) errors.push('Last Name is required.');
            if (!email) { errors.push('Email is required.'); }
            else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Invalid email format.');
            if (!subject) errors.push('Please select a topic.');
            if (!message) errors.push('Message is required.');
            else if (message.length < 10) errors.push('Message must be at least 10 characters.');
            if (!termsChecked) errors.push('You must accept the Privacy Policy.');
            if (errors.length > 0) { alert('Please fix the following:\n\n' + errors.join('\n')); return }
            alert('Message sent successfully!\n\nThank you for contacting us, ' + firstName + '! We will get back to you within 2 hours.');
            this.reset();
        });
    }
    const fileInput = document.querySelector('.file-upload-input');
    if (fileInput) {
        fileInput.addEventListener('change', function () {
            const files = this.files;
            if (files.length > 0) {
                const names = Array.from(files).map(f => f.name).join(', ');
                const label = this.parentElement;
                label.querySelector('i').className = 'fas fa-check';
                label.style.color = '#34d399';
                label.style.borderColor = '#34d399';
                setTimeout(() => { label.querySelector('i').className = 'fas fa-paperclip'; label.style.color = ''; label.style.borderColor = '' }, 3000);
            }
        });
    }
});