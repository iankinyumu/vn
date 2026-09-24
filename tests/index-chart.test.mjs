import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

function loadCharts() {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync('assets/js/charts.js', 'utf8'));
    return dom.window;
}

const series = (count, price = (n) => 1000 + Math.sin(n / 7) + n / 1000) => Array.from({ length: count }, (_, position) => ({ tick_no: position + 1, price: price(position + 1).toFixed(3), digit: (position + 1) % 10 }));

/* A canvas stand-in that counts buffer reallocations (width/height writes) and
   records the path drawn, since jsdom has no 2D context. */
function fakeCanvas(clientWidth, clientHeight) {
    const log = { resizes: 0, lines: [], arcs: [], texts: [], rects: [], strokes: [] };
    let width = 300, height = 150;
    const context = { clearRect() {}, beginPath() { log.lines.push([]); }, moveTo(x, y) { log.lines.at(-1).push([x, y]); }, lineTo(x, y) { log.lines.at(-1).push([x, y]); }, stroke() { log.strokes.push(this.strokeStyle); }, fill() {}, arc(x, y) { log.arcs.push([x, y]); }, fillRect(x, y, w, h) { log.rects.push([x, y, w, h]); }, fillText(text, x, y) { log.texts.push({ text, x, y }); }, measureText: (text) => ({ width: text.length * 7 }) };
    const canvas = {
        clientWidth, clientHeight,
        get width() { return width; }, set width(value) { log.resizes++; width = value; },
        get height() { return height; }, set height(value) { log.resizes++; height = value; },
        getContext: () => context,
    };
    return { canvas, log };
}

test('the chart canvas buffer is only resized when its displayed size changes', () => {
    const window = loadCharts();
    const { canvas, log } = fakeCanvas(600, 300);
    const ticks = series(50);
    window.drawIndexChart(canvas, ticks);
    assert.equal(log.resizes, 2);
    for (let tick = 0; tick < 20; tick++) window.drawIndexChart(canvas, ticks);
    assert.equal(log.resizes, 2, 'redrawing at the same size must not reallocate the canvas');
    canvas.clientWidth = 800;
    window.drawIndexChart(canvas, ticks);
    assert.equal(log.resizes, 3, 'a resize must resize the buffer');
    assert.equal(canvas.width, 800);
    assert.equal(Math.round(log.lines.at(-1).at(-1)[0]), 800, 'a resized chart spans the new width');
});

test('a window keeps only the most recent ticks and the latest tick is the last point', () => {
    const window = loadCharts();
    const ticks = series(1000);
    const { points, count } = window.indexChartPoints(ticks, { window: 300 });
    assert.equal(count, 300);
    assert.equal(points.length, 300);
    assert.equal(points.at(-1).price, Number(ticks.at(-1).price));
    assert.equal(points[0].price, Number(ticks[700].price));
});

test('downsampling bounds the point count but keeps the price range, spikes and the latest tick', () => {
    const window = loadCharts();
    const ticks = series(1000, (n) => (n === 377 ? 2000 : n === 612 ? 10 : 1000 + (n % 5) / 100));
    const { points, count } = window.indexChartPoints(ticks, { maxPoints: 60 });
    assert.equal(count, 1000);
    assert.ok(points.length <= 60, `${points.length} points drawn`);
    const prices = points.map((point) => point.price);
    assert.equal(Math.max(...prices), 2000, 'a high spike was dropped');
    assert.equal(Math.min(...prices), 10, 'a low spike was dropped');
    assert.equal(points.at(-1).position, 999);
    assert.equal(points.at(-1).price, Number(ticks.at(-1).price));
    assert.ok(points.every((point, position) => position === 0 || point.position > points[position - 1].position), 'points are out of order');
});

test('the drawn line is bounded by the canvas width and ends at the latest tick, which can be marked', () => {
    const window = loadCharts();
    const { canvas, log } = fakeCanvas(200, 100);
    const ticks = series(1000);
    window.drawIndexChart(canvas, ticks, { window: 300, markLatest: true });
    const line = log.lines[0];
    assert.ok(line.length <= 400, `${line.length} points for a 200px chart`);
    assert.equal(line.at(-1)[0], 200, 'the latest tick is not at the right edge');
    assert.equal(log.arcs.length, 1);
    assert.equal(log.arcs[0][1], line.at(-1)[1], 'the marker is not on the latest price');
    window.drawIndexChart(canvas, ticks);
    assert.equal(log.arcs.length, 1, 'the marker is opt-in');
});

test('fewer than two ticks, or an empty series, draws nothing after clearing', () => {
    const window = loadCharts();
    const { canvas, log } = fakeCanvas(200, 100);
    window.drawIndexChart(canvas, []);
    window.drawIndexChart(canvas, series(1), { markLatest: true });
    assert.equal(log.lines.length, 0);
    assert.equal(log.arcs.length, 0);
});

test('axis labels step by 1, 2 or 5 times a power of ten, never finer than the index precision', () => {
    const window = loadCharts();
    assert.deepEqual([...window.indexChartAxisTicks(999.93, 1000.61, 300, 2)], [1000, 1000.2, 1000.4, 1000.6]);
    const fine = window.indexChartAxisTicks(10.0001, 10.0019, 600, 3);
    assert.ok(fine.every((price, position) => position === 0 || Math.round((price - fine[position - 1]) * 1000) >= 1), 'labels finer than the precision');
    assert.deepEqual([...window.indexChartAxisTicks(5, 5, 300, 2)], []);
});

test('with decimals the chart draws a right-side price axis, aligned labels and a latest-price line and tag', () => {
    const window = loadCharts();
    const { canvas, log } = fakeCanvas(400, 300);
    const ticks = series(120);
    const layout = window.drawIndexChart(canvas, ticks, { window: 300, markLatest: true, decimals: 3 });
    assert.ok(layout.axisWidth > 0 && layout.plotWidth === 400 - layout.axisWidth, 'no room was kept for the axis');
    const line = log.lines[0];
    assert.equal(line.at(-1)[0], layout.plotWidth, 'the latest tick is not at the plot edge next to the axis');
    assert.ok(line.every(([x]) => x <= layout.plotWidth), 'the line runs under the axis');
    assert.ok(layout.labels.length >= 2, 'too few price labels');
    const axisTexts = log.texts.filter((text) => text.x > layout.plotWidth);
    for (const label of layout.labels.filter((item) => item.shown)) {
        const drawn = axisTexts.find((text) => text.text === `$${label.price.toFixed(3)}`);
        assert.ok(drawn, `label ${label.price} was not drawn`);
        assert.equal(drawn.y, label.y);
        assert.ok(label.price >= layout.low - (layout.high - layout.low) && label.price <= layout.high + (layout.high - layout.low));
        // A label sits where the line would plot that price.
        const expected = 300 - ((label.price - layout.low) / (layout.high - layout.low) * 300 * .85 + 300 * .075);
        assert.ok(Math.abs(label.y - expected) < 1e-6);
    }
    assert.ok(axisTexts.every((text) => /^\$\d+\.\d{3}$/.test(text.text)), 'axis text needs a dollar sign and the index precision');
    const latestText = `$${Number(ticks.at(-1).price).toFixed(3)}`;
    assert.equal(axisTexts.at(-1).text, latestText, 'the latest price tag is missing');
    assert.equal(layout.latestY, line.at(-1)[1], 'the latest price line is not at the latest tick');
    assert.equal(layout.crosshair, null, 'no pointer means no crosshair');
});

test('the latest-price tag and labels follow the price as it moves and stay aligned after a resize', () => {
    const window = loadCharts();
    const { canvas, log } = fakeCanvas(400, 300);
    const ticks = series(120);
    const first = window.drawIndexChart(canvas, ticks, { decimals: 3 });
    const moved = [...ticks, { tick_no: 121, price: '1005.000', digit: 0 }];
    log.texts.length = 0;
    const second = window.drawIndexChart(canvas, moved, { decimals: 3 });
    assert.equal(log.texts.at(-1).text, '$1005.000');
    assert.equal(second.high, 1005);
    assert.notDeepEqual(second.labels.map((label) => label.price), first.labels.map((label) => label.price), 'labels did not follow the new range');
    canvas.clientWidth = 700; canvas.clientHeight = 200;
    log.lines.length = 0;
    const resized = window.drawIndexChart(canvas, moved, { decimals: 3 });
    assert.equal(resized.plotWidth, 700 - resized.axisWidth);
    assert.equal(log.lines[0].at(-1)[0], resized.plotWidth);
    assert.equal(log.lines[0].at(-1)[1], resized.latestY);
    assert.ok(resized.labels.every((label) => label.y >= 0 && label.y <= 200));
});

test('a pointer over the plot draws a crosshair tagged with the inspected price; outside it draws none', () => {
    const window = loadCharts();
    const { canvas, log } = fakeCanvas(400, 300);
    const ticks = series(120);
    const layout = window.drawIndexChart(canvas, ticks, { decimals: 3, pointer: { x: 100, y: 150 } });
    assert.deepEqual({ ...layout.crosshair, price: undefined }, { x: 100, y: 150, price: undefined });
    const expected = layout.low + (300 - 150 - 300 * .075) / (300 * .85) * (layout.high - layout.low);
    assert.equal(layout.crosshair.price, Number(expected.toFixed(3)));
    assert.equal(log.texts.at(-1).text, `$${expected.toFixed(3)}`, 'the crosshair price tag is missing');
    assert.ok(log.rects.some(([x, y, w, h]) => x === 100 && y === 0 && w === 1 && h === 300), 'no vertical crosshair line');
    assert.ok(log.rects.some(([x, y, w, h]) => x === 0 && y === 150 && w === layout.plotWidth && h === 1), 'no horizontal crosshair line');
    assert.equal(window.drawIndexChart(canvas, ticks, { decimals: 3, pointer: { x: 399, y: 150 } }).crosshair, null, 'a pointer over the axis drew a crosshair');
    assert.equal(window.drawIndexChart(canvas, ticks, { pointer: { x: 100, y: 150 } }).crosshair, null, 'the crosshair needs the price axis');
});

test('a flat price series still gets a readable axis at the index precision', () => {
    const window = loadCharts();
    const { canvas } = fakeCanvas(400, 300);
    const layout = window.drawIndexChart(canvas, series(50, () => 1234.5), { decimals: 2 });
    assert.ok(layout.labels.length >= 2);
    assert.ok(layout.labels.some((label) => Math.abs(label.price - 1234.5) < 0.1));
});

test('the whole trade line follows only the latest tick direction without changing the dashboard chart', () => {
    const window = loadCharts();
    const { canvas, log } = fakeCanvas(400, 300);
    const ticks = series(4, (n) => [1000, 1001, 999, 1002][n - 1]);
    const layout = window.drawIndexChart(canvas, ticks, { decimals: 2, directionColors: true, markLatest: true });
    assert.equal(layout.direction, 'up');
    assert.deepEqual(log.strokes, ['#64d9a0'], 'the rising line was not entirely green');
    log.strokes.length = 0;
    const falling = series(4, (n) => [1000, 1001, 1002, 999][n - 1]);
    assert.equal(window.drawIndexChart(canvas, falling, { decimals: 2, directionColors: true }).direction, 'down');
    assert.deepEqual(log.strokes, ['#ff7885'], 'the falling line was not entirely red');
    log.strokes.length = 0;
    const flat = series(4, (n) => [1000, 1001, 1002, 1002][n - 1]);
    assert.equal(window.drawIndexChart(canvas, flat, { decimals: 2, directionColors: true }).direction, 'flat');
    assert.deepEqual(log.strokes, ['#80d7ff'], 'an unchanged price should use the neutral line color');
    log.strokes.length = 0;
    window.drawIndexChart(canvas, ticks, { decimals: 2 });
    assert.deepEqual(log.strokes, ['#80d7ff'], 'the shared dashboard chart gained trade-only colors');
});
