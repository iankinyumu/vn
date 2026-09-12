/* assets/js/blog-single.js */
document.addEventListener('DOMContentLoaded', function () {
    const commentForm = document.getElementById('commentForm');
    if (commentForm) {
        commentForm.addEventListener('submit', function (e) {
            e.preventDefault();
            const name = this.querySelector('input[type="text"]').value.trim();
            const email = this.querySelector('input[type="email"]').value.trim();
            const message = this.querySelector('textarea').value.trim();
            if (!name) { alert('Please enter your name.'); return }
            if (!email) { alert('Please enter your email.'); return }
            if (!message) { alert('Please enter your comment.'); return }
            alert('Comment posted successfully!\n\nThank you, ' + name + '!');
            this.reset();
        });
    }
    document.querySelectorAll('.share-btn').forEach(btn => {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            if (this.classList.contains('copy-link')) { alert('Link copied to clipboard!'); return }
            const platform = this.classList.contains('twitter') ? 'Twitter' : this.classList.contains('facebook') ? 'Facebook' : this.classList.contains('linkedin') ? 'LinkedIn' : this.classList.contains('telegram') ? 'Telegram' : 'Reddit';
            alert('Sharing on ' + platform + '...');
        });
    });
    document.querySelectorAll('.comment-action-btn').forEach(btn => {
        btn.addEventListener('click', function () {
            if (this.querySelector('.fa-comment')) { alert('Reply feature coming soon!') }
            else { const count = parseInt(this.textContent.trim()) || 0; this.innerHTML = `<i class="far fa-thumbs-up"></i> ${count + 1}` }
        });
    });
});