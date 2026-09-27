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

    /* Groups ticks into candles of `period` ticks, aligned on tick numbers so every viewer
       sees the same boundaries. The last candle may still be forming. */
    function candles(ticks, period) {
        const size = Math.max(1, Math.floor(period) || 1);
        const out = [];
        for (const tick of ticks) {
            const price = Number(tick.price), bucket = Math.floor(Number(tick.tick_no) / size);
            const last = out[out.length - 1];
            if (last && last.bucket === bucket) {
                if (price > last.high) last.high = price;
                if (price < last.low) last.low = price;
                last.close = price;
                last.ticks++;
            } else out.push({ bucket, open: price, high: price, low: price, close: price, ticks: 1, firstTick: Number(tick.tick_no) });
        }
        return out;
    }

    // Space per candle: never cramped below MIN_SLOT or stretched past MAX_SLOT CSS pixels.
    const MIN_SLOT = 6, MAX_SLOT = 22;

    // Chart colours come from the --chart-* tokens (tokens.css), so the chart follows the
    // light or dark appearance. The fallbacks are the dark values, for a canvas outside a themed page.
    const FALLBACK = Object.freeze({ up: '#64d9a0', down: '#ff7885', line: '#80d7ff', area: 'rgba(128,215,255,.55)', grid: 'rgba(255,255,255,.055)', edge: 'rgba(255,255,255,.12)', axis: 'rgba(214,224,235,.66)', crosshair: 'rgba(255,255,255,.4)', tag: '#2c3947', tagInk: '#eef4fa', onTrend: '#0b111a' });
    function palette(canvas) {
        let style = null;
        try { style = window.getComputedStyle(canvas); } catch (_) { style = null; }
        const read = (key) => (style && style.getPropertyValue('--chart-' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())).trim()) || FALLBACK[key];
        return Object.fromEntries(Object.keys(FALLBACK).map((key) => [key, read(key)]));
    }

    /* Draws candlesticks ('candles') or OHLC bars ('ohlc') with the same axis, latest-price
       line and crosshair as the line chart, plus an O/H/L/C readout for the candle under
       the pointer, or the latest candle. */
    function drawCandles(context, ticks, options, ratio, width, height, colors) {
        const all = candles(ticks, options.period);
        if (!all.length) return null;
        const decimals = Number.isInteger(options.decimals) && options.decimals >= 0 ? options.decimals : 2;
        const format = (price) => `$${price.toFixed(decimals)}`;
        context.font = `500 ${11 * ratio}px 'DM Mono', monospace`;
        context.textBaseline = 'middle';
        const { up, down } = colors;
        let low = Infinity, high = -Infinity;
        for (const candle of all) { if (candle.low < low) low = candle.low; if (candle.high > high) high = candle.high; }
        const axisWidth = Math.ceil(context.measureText('8'.repeat(Math.max(format(low).length, format(high).length))).width + 14 * ratio);
        const plotWidth = Math.max(1, width - axisWidth);
        const shown = all.slice(-Math.max(1, Math.floor(plotWidth / (MIN_SLOT * ratio))));
        low = Infinity; high = -Infinity;
        for (const candle of shown) { if (candle.low < low) low = candle.low; if (candle.high > high) high = candle.high; }
        const slot = Math.min(plotWidth / shown.length, MAX_SLOT * ratio);
        const range = high - low || 10 * 10 ** -decimals;
        const padTop = height * .1, span = height * .8;
        const yOf = (price) => height - ((price - low) / range * span + padTop);
        const priceAt = (y) => low + (height - y - padTop) / span * range;
        // The latest candle sits at the right edge; older ones extend left.
        const centre = (position) => plotWidth - (shown.length - position - 0.5) * slot;
        const latest = shown[shown.length - 1];
        const direction = latest.close > latest.open ? 'up' : latest.close < latest.open ? 'down' : 'flat';
        const layout = { style: options.style, plotWidth, axisWidth, low, high, labels: [], latestY: yOf(latest.close), latestPrice: latest.close, direction, candles: shown.length, slot, crosshair: null, readout: null };
        const tagHeight = 18 * ratio;
        layout.labels = axisTicks(priceAt(height), priceAt(0), height / ratio, decimals).map((price) => ({ price, y: yOf(price) }));
        context.fillStyle = colors.grid;
        for (const label of layout.labels) context.fillRect(0, Math.round(label.y), plotWidth, ratio);
        context.fillStyle = colors.edge;
        context.fillRect(plotWidth, 0, ratio, height);
        context.fillStyle = colors.axis;
        for (const label of layout.labels) {
            label.shown = Math.abs(label.y - layout.latestY) >= tagHeight && label.y >= tagHeight / 2 && label.y <= height - tagHeight / 2;
            if (label.shown) context.fillText(format(label.price), plotWidth + 6 * ratio, label.y);
        }
        const body = Math.max(ratio, Math.round(slot * .62));
        shown.forEach((candle, position) => {
            const cx = Math.round(centre(position));
            const color = candle.close >= candle.open ? up : down;
            const top = yOf(candle.high), bottom = yOf(candle.low), open = yOf(candle.open), close = yOf(candle.close);
            context.fillStyle = color;
            if (options.style === 'ohlc') {
                // A bar from low to high, open ticked to the left and close to the right.
                const arm = Math.max(2 * ratio, Math.round(body / 2));
                const stroke = Math.max(ratio, Math.round(1.5 * ratio));
                context.fillRect(cx - stroke / 2, top, stroke, Math.max(ratio, bottom - top));
                context.fillRect(cx - arm, Math.round(open) - stroke / 2, arm, stroke);
                context.fillRect(cx, Math.round(close) - stroke / 2, arm, stroke);
            } else {
                // A wick from low to high and a body from open to close.
                context.fillRect(cx - ratio / 2, top, ratio, Math.max(ratio, bottom - top));
                context.fillRect(cx - body / 2, Math.min(open, close), body, Math.max(ratio, Math.abs(close - open)));
            }
        });
        const trendColor = direction === 'down' ? down : up;
        context.fillStyle = trendColor;
        for (let dash = 0; dash < plotWidth; dash += 8 * ratio) context.fillRect(dash, Math.round(layout.latestY), Math.min(4 * ratio, plotWidth - dash), ratio);
        priceTag(context, format(latest.close), plotWidth, layout.latestY, width, height, ratio, trendColor, colors.onTrend);
        let focus = latest;
        const pointer = options.pointer;
        if (pointer && pointer.x >= 0 && pointer.y >= 0 && pointer.x * ratio <= plotWidth && pointer.y * ratio <= height) {
            const px = Math.round(pointer.x * ratio), py = Math.round(pointer.y * ratio);
            const position = Math.min(shown.length - 1, Math.max(0, Math.floor(shown.length - (plotWidth - px) / slot)));
            focus = shown[position] || latest;
            layout.crosshair = { x: px, y: py, price: Number(priceAt(py).toFixed(decimals)), candle: position };
            context.fillStyle = colors.crosshair;
            context.fillRect(px, 0, ratio, height);
            context.fillRect(0, py, plotWidth, ratio);
            priceTag(context, format(layout.crosshair.price), plotWidth, py, width, height, ratio, colors.tag, colors.tagInk);
        }
        // The O/H/L/C readout for the focused candle, top left of the plot.
        const fields = [['O', focus.open], ['H', focus.high], ['L', focus.low], ['C', focus.close]];
        layout.readout = Object.fromEntries(fields.map(([key, value]) => [key, Number(value.toFixed(decimals))]));
        let cursor = 10 * ratio;
        const line = 14 * ratio;
        for (const [key, value] of fields) {
            const text = value.toFixed(decimals);
            const keyWidth = context.measureText(key).width + 4 * ratio;
            // On a narrow chart the readout stops at the plot's edge rather than run into the axis.
            if (cursor + keyWidth + context.measureText(text).width > plotWidth - 6 * ratio) break;
            context.fillStyle = colors.axis;
            context.fillText(key, cursor, line);
            cursor += keyWidth;
            context.fillStyle = focus.close >= focus.open ? up : down;
            context.fillText(text, cursor, line);
            cursor += context.measureText(text).width + 12 * ratio;
        }
        return layout;
    }

    /* Draws the recent price line. Options:
       window      how many of the most recent ticks to show;
       markLatest  mark the latest tick with a dot;
       decimals    the index's precision; turns on the right-side price axis, gridlines and the latest-price line and tag;
       pointer     {x, y} in CSS pixels from the canvas's top left; draws a crosshair and its price tag (needs decimals);
       directionColors  color the entire line from the latest tick's direction (trade page only);
       style       'line' (default), 'candles' or 'ohlc'; the candle styles use every tick given;
       period      ticks per candle for the candle styles.
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
        const colors = palette(canvas);
        if (options.style === 'candles' || options.style === 'ohlc') return drawCandles(context, ticks, options, ratio, width, height, colors);
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
        const trendColor = direction === 'up' ? colors.up : direction === 'down' ? colors.down : colors.line;
        const layout = { plotWidth, axisWidth, low, high, labels: [], latestY: y(latest), latestPrice: latest.price, direction, crosshair: null };
        const tagHeight = 18 * ratio;
        if (withAxis) {
            // Gridlines and labels share one position, so they stay aligned with the line at any size and price range.
            layout.labels = axisTicks(priceAt(height), priceAt(0), height / ratio, decimals).map((price) => ({ price, y: yOf(price) }));
            context.fillStyle = colors.grid;
            for (const label of layout.labels) context.fillRect(0, Math.round(label.y), plotWidth, ratio);
            context.fillStyle = colors.edge;
            context.fillRect(plotWidth, 0, ratio, height);
            context.fillStyle = colors.axis;
            for (const label of layout.labels) {
                // A label under the latest-price tag, or cut off at an edge, would be unreadable.
                label.shown = Math.abs(label.y - layout.latestY) >= tagHeight && label.y >= tagHeight / 2 && label.y <= height - tagHeight / 2;
                if (label.shown) context.fillText(format(label.price), plotWidth + 6 * ratio, label.y);
            }
        }
        context.strokeStyle = options.directionColors ? trendColor : colors.line; context.lineWidth = 2 * ratio; context.beginPath();
        points.forEach((point, position) => { position ? context.lineTo(x(point), y(point)) : context.moveTo(x(point), y(point)); });
        context.stroke();
        if (options.markLatest) {
            // The latest tick is marked so the newest price is always visible at the right edge.
            context.fillStyle = options.directionColors ? trendColor : colors.line; context.beginPath();
            context.arc(x(latest) - 3 * ratio, y(latest), 3 * ratio, 0, Math.PI * 2);
            context.fill();
        }
        if (!withAxis) return layout;
        context.fillStyle = options.directionColors ? trendColor : colors.area;
        for (let dash = 0; dash < plotWidth; dash += 8 * ratio) context.fillRect(dash, Math.round(layout.latestY), Math.min(4 * ratio, plotWidth - dash), ratio);
        priceTag(context, format(latest.price), plotWidth, layout.latestY, width, height, ratio, options.directionColors ? trendColor : colors.line, colors.onTrend);
        const pointer = options.pointer;
        if (pointer && pointer.x >= 0 && pointer.y >= 0 && pointer.x * ratio <= plotWidth && pointer.y * ratio <= height) {
            const px = Math.round(pointer.x * ratio), py = Math.round(pointer.y * ratio);
            layout.crosshair = { x: px, y: py, price: Number(priceAt(py).toFixed(decimals)) };
            context.fillStyle = colors.crosshair;
            context.fillRect(px, 0, ratio, height);
            context.fillRect(0, py, plotWidth, ratio);
            priceTag(context, format(layout.crosshair.price), plotWidth, py, width, height, ratio, colors.tag, colors.tagInk);
        }
        return layout;
    }
    window.drawIndexChart = draw;
    window.indexChartPoints = chartPoints;
    window.indexChartAxisTicks = axisTicks;
    window.indexChartCandles = candles;
})();
