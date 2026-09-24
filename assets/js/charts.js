(function () {
    // A line gains nothing visible beyond about two points per CSS pixel of width.
    const POINTS_PER_PIXEL = 2;

    /* Reduces ticks to the points worth drawing. Only the most recent `window`
       ticks are kept; if more than maxPoints remain, each bucket of interior ticks
       keeps its lowest and highest price in order, so spikes and the price range
       survive. The first and the latest tick are always kept, so `position` of the
       last point is always count - 1. */
    function chartPoints(ticks, { window: size = Infinity, maxPoints = Infinity } = {}) {
        const recent = ticks.length > size ? ticks.slice(-size) : ticks;
        const all = recent.map((tick, position) => ({ position, price: Number(tick.price) }));
        const count = all.length;
        if (count <= maxPoints || maxPoints < 4) return { points: all, count };
        const last = count - 1;
        const buckets = Math.floor((maxPoints - 2) / 2);
        const span = (last - 1) / buckets;
        const points = [all[0]];
        for (let bucket = 0; bucket < buckets; bucket++) {
            const from = 1 + Math.floor(bucket * span), to = 1 + Math.floor((bucket + 1) * span);
            if (to <= from) continue;
            let low = all[from], high = all[from];
            for (let position = from + 1; position < to; position++) {
                if (all[position].price < low.price) low = all[position];
                if (all[position].price > high.price) high = all[position];
            }
            if (low === high) points.push(low);
            else points.push(...(low.position < high.position ? [low, high] : [high, low]));
        }
        points.push(all[last]);
        return { points, count };
    }

    // Price-axis steps are 1, 2 or 5 times a power of ten, never finer than the index's last decimal.
    function niceStep(rough, minStep) {
        const power = 10 ** Math.floor(Math.log10(rough));
        const scaled = rough / power;
        return Math.max((scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * power, minStep);
    }

    // Price labels for the visible range [bottom, top], roughly one per `spacing` CSS pixels of chart height.
    function axisTicks(bottom, top, cssHeight, decimals, spacing = 56) {
        if (!(top > bottom)) return [];
        const step = niceStep((top - bottom) / Math.max(2, Math.floor(cssHeight / spacing)), 10 ** -decimals);
        const ticks = [];
        for (let k = Math.ceil(bottom / step); k <= Math.floor(top / step) && ticks.length < 50; k++) ticks.push(Number((k * step).toFixed(decimals)));
        return ticks;
    }

    // A filled price tag on the axis, centred on y and kept inside the canvas.
    function priceTag(context, text, left, y, width, height, ratio, background, color) {
        const tagHeight = 18 * ratio, top = Math.min(Math.max(y - tagHeight / 2, 0), height - tagHeight);
        context.fillStyle = background;
        context.fillRect(left, top, width - left, tagHeight);
        context.fillStyle = color;
        context.fillText(text, left + 6 * ratio, top + tagHeight / 2);
    }

    /* Draws the recent price line. Options:
       window      how many of the most recent ticks to show;
       markLatest  mark the latest tick with a dot;
       decimals    the index's precision; turns on the right-side price axis, gridlines and the latest-price line and tag;
       pointer     {x, y} in CSS pixels from the canvas's top left; draws a crosshair and its price tag (needs decimals);
       directionColors  color the entire line from the latest tick's direction (trade page only).
       Returns the layout it drew with, or null when there was nothing to draw. */
    function draw(canvas, ticks, options = {}) {
        const ratio = window.devicePixelRatio || 1;
        const width = Math.round(canvas.clientWidth * ratio), height = Math.round(canvas.clientHeight * ratio);
        // Assigning width or height reallocates the drawing buffer, so it only happens when the size changed.
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) return null;
        context.clearRect(0, 0, width, height);
        if (!width || !height) return null;
        const recent = options.window && ticks.length > options.window ? ticks.slice(-options.window) : ticks;
        if (recent.length < 2) return null;
        let low = Infinity, high = -Infinity;
        for (const tick of recent) { const price = Number(tick.price); if (price < low) low = price; if (price > high) high = price; }
        const decimals = Number.isInteger(options.decimals) && options.decimals >= 0 ? options.decimals : null;
        const withAxis = decimals !== null;
        const format = (price) => `$${price.toFixed(decimals)}`;
        if (withAxis) { context.font = `500 ${11 * ratio}px 'DM Mono', monospace`; context.textBaseline = 'middle'; }
        // The axis fits the longest price label, so the plot only narrows when the index gains a digit.
        const axisWidth = withAxis ? Math.ceil(context.measureText('8'.repeat(Math.max(format(low).length, format(high).length))).width + 14 * ratio) : 0;
        const plotWidth = Math.max(1, width - axisWidth);
        const { points, count } = chartPoints(recent, { maxPoints: Math.max(4, plotWidth / ratio * POINTS_PER_PIXEL) });
        const range = high - low || (withAxis ? 10 * 10 ** -decimals : 1);
        const padTop = height * .075, span = height * .85;
        const yOf = (price) => height - ((price - low) / range * span + padTop);
        const priceAt = (y) => low + (height - y - padTop) / span * range;
        const x = (point) => point.position / (count - 1) * plotWidth;
        const y = (point) => yOf(point.price);
        const latest = points[points.length - 1];
        const previousPrice = Number(recent[recent.length - 2].price);
        const direction = latest.price > previousPrice ? 'up' : latest.price < previousPrice ? 'down' : 'flat';
        const trendColor = direction === 'up' ? '#64d9a0' : direction === 'down' ? '#ff7885' : '#80d7ff';
        const layout = { plotWidth, axisWidth, low, high, labels: [], latestY: y(latest), latestPrice: latest.price, direction, crosshair: null };
        const tagHeight = 18 * ratio;
        if (withAxis) {
            // Gridlines and labels share one position, so they stay aligned with the line at any size and price range.
            layout.labels = axisTicks(priceAt(height), priceAt(0), height / ratio, decimals).map((price) => ({ price, y: yOf(price) }));
            context.fillStyle = 'rgba(255,255,255,.055)';
            for (const label of layout.labels) context.fillRect(0, Math.round(label.y), plotWidth, ratio);
            context.fillStyle = 'rgba(255,255,255,.12)';
            context.fillRect(plotWidth, 0, ratio, height);
            context.fillStyle = 'rgba(214,224,235,.66)';
            for (const label of layout.labels) {
                // A label under the latest-price tag, or cut off at an edge, would be unreadable.
                label.shown = Math.abs(label.y - layout.latestY) >= tagHeight && label.y >= tagHeight / 2 && label.y <= height - tagHeight / 2;
                if (label.shown) context.fillText(format(label.price), plotWidth + 6 * ratio, label.y);
            }
        }
        context.strokeStyle = options.directionColors ? trendColor : '#80d7ff'; context.lineWidth = 2 * ratio; context.beginPath();
        points.forEach((point, position) => { position ? context.lineTo(x(point), y(point)) : context.moveTo(x(point), y(point)); });
        context.stroke();
        if (options.markLatest) {
            // The latest tick is marked so the newest price is always visible at the right edge.
            context.fillStyle = options.directionColors ? trendColor : '#80d7ff'; context.beginPath();
            context.arc(x(latest) - 3 * ratio, y(latest), 3 * ratio, 0, Math.PI * 2);
            context.fill();
        }
        if (!withAxis) return layout;
        context.fillStyle = options.directionColors ? trendColor : 'rgba(128,215,255,.55)';
        for (let dash = 0; dash < plotWidth; dash += 8 * ratio) context.fillRect(dash, Math.round(layout.latestY), Math.min(4 * ratio, plotWidth - dash), ratio);
        priceTag(context, format(latest.price), plotWidth, layout.latestY, width, height, ratio, options.directionColors ? trendColor : '#80d7ff', '#0b111a');
        const pointer = options.pointer;
        if (pointer && pointer.x >= 0 && pointer.y >= 0 && pointer.x * ratio <= plotWidth && pointer.y * ratio <= height) {
            const px = Math.round(pointer.x * ratio), py = Math.round(pointer.y * ratio);
            layout.crosshair = { x: px, y: py, price: Number(priceAt(py).toFixed(decimals)) };
            context.fillStyle = 'rgba(255,255,255,.4)';
            context.fillRect(px, 0, ratio, height);
            context.fillRect(0, py, plotWidth, ratio);
            priceTag(context, format(layout.crosshair.price), plotWidth, py, width, height, ratio, '#2c3947', '#eef4fa');
        }
        return layout;
    }
    window.drawIndexChart = draw;
    window.indexChartPoints = chartPoints;
    window.indexChartAxisTicks = axisTicks;
})();
