(function () {
    function draw(canvas, ticks) {
        const context = canvas.getContext('2d');
        const width = canvas.width = canvas.clientWidth * (devicePixelRatio || 1);
        const height = canvas.height = canvas.clientHeight * (devicePixelRatio || 1);
        context.clearRect(0, 0, width, height);
        if (ticks.length < 2) return;
        const prices = ticks.map((tick) => Number(tick.price));
        const low = Math.min(...prices), high = Math.max(...prices), range = high - low || 1;
        context.strokeStyle = '#80d7ff'; context.lineWidth = 2 * (devicePixelRatio || 1); context.beginPath();
        prices.forEach((price, index) => {
            const x = index / (prices.length - 1) * width;
            const y = height - ((price - low) / range * (height * .85) + height * .075);
            index ? context.lineTo(x, y) : context.moveTo(x, y);
        });
        context.stroke();
    }
    window.drawIndexChart = draw;
})();
