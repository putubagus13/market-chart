// @vitest-environment jsdom
// The simulator panel places trades with the symbol's tick size; a user pip size only changes
// how results are read, so clearing it brings every trade back to the tick size.
import { describe, it, expect, afterEach } from 'vitest';
import { TradingSimView } from '../src/widget/trading-sim/sim-panel';
import { SimulationEngine } from '../src/widget/trading-sim/sim-engine';
import { PipSizes } from '../src/widget/trading-sim/pip-sizes';
import type { WidgetContext } from '../src/widget/contributions';
import type { Vela } from '../src/Vela';
import { createTranslator } from '../src/plugin';

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

const HOUR = 3_600_000;
const bars = Array.from({ length: 20 }, (_, i) => ({ time: i * HOUR, open: 100, high: 101, low: 99, close: 100 + i * 0.1, volume: 1 }));

type Anchors = Array<{ time: number; price: number }>;

function makeFakeChart() {
    const drawings: Array<{ id: string; anchors: Anchors; locked: boolean }> = [];
    const removed: string[] = [];
    const chartHandlers = new Map<string, Set<(payload: never) => void>>();
    const chart = {
        market: { symbol: 'BTCUSDT', timeframe: '60' },
        on: onFor(chartHandlers),
        getVisibleRange: () => null,
        setVisibleRange: () => {},
        data: {
            resolve: () => ({ provider: 'p', ticker: 'BTCUSDT' }),
            providerInstance: () => ({ getBars: async () => bars }),
            symbolInfo: async () => ({ mintick: 0.01 }),
        },
        drawings: {
            add: (_type: string, init: { anchors: Anchors }) => {
                const d = { id: `d${drawings.length}`, anchors: init.anchors.map((a) => ({ ...a })), locked: false };
                drawings.push(d);
                return d;
            },
            all: () => drawings,
            update: (id: string, patch: { anchors?: Anchors }) => {
                const d = drawings.find((x) => x.id === id);
                if (d && patch.anchors) d.anchors = patch.anchors.map((a) => ({ ...a }));
            },
            lock: (id: string, v = true) => {
                const d = drawings.find((x) => x.id === id);
                if (d) d.locked = v;
            },
            remove: (id: string) => {
                removed.push(id);
                const i = drawings.findIndex((x) => x.id === id);
                if (i >= 0) drawings.splice(i, 1);
            },
        },
    } as unknown as Vela;
    return { chart, drawings, removed, emit: emitFor(chartHandlers) };
}

type Handlers = Map<string, Set<(payload: never) => void>>;
const onFor = (map: Handlers) => (event: string, h: (payload: never) => void) => {
    if (!map.has(event)) map.set(event, new Set());
    map.get(event)!.add(h);
    return () => map.get(event)!.delete(h);
};
const emitFor = (map: Handlers) => (event: string, payload?: unknown): void => map.get(event)?.forEach((h) => h(payload as never));

function setup() {
    const host = document.createElement('div');
    document.body.append(host);
    const fake = makeFakeChart();
    const replayHandlers: Handlers = new Map();
    const replay = { state: { active: true, cursorTime: bars[19]!.time }, pause: () => {}, on: onFor(replayHandlers) };
    const toasts: Array<[string, string | undefined]> = [];
    const ctx = { host, i18n: createTranslator({ locale: 'en' }), toast: (m: string, kind?: string) => toasts.push([m, kind]), stateChanged: () => {}, replay } as unknown as WidgetContext;
    const engine = new SimulationEngine();
    const pips = new PipSizes();
    const view = new TradingSimView(ctx, engine, pips);
    host.append(view.el);
    view.bindChart(fake.chart);
    return { view, engine, pips, drawings: fake.drawings, removed: fake.removed, toasts, host, chart: fake.chart, emitChart: fake.emit, emitReplay: emitFor(replayHandlers) };
}

const LAST_CLOSE = bars[19]!.close;
const nextBar = (n: number, low: number, high: number, close: number) => ({ time: bars[19]!.time + n * HOUR, open: close, high, low, close, volume: 1 });

describe('the simulator panel', () => {
    afterEach(() => document.body.replaceChildren());

    it('stores the tick size in a new trade even with a pip size set', async () => {
        const { view, engine, pips } = setup();
        pips.set('BTCUSDT', 10);
        await view.openDraft('long');
        view.placeDraft();
        expect(engine.openTrades).toHaveLength(1);
        expect(engine.openTrades[0]!.pip).toBe(0.01);
        pips.set('BTCUSDT', null);
        expect(pips.pipOf(engine.openTrades[0]!)).toBe(0.01);
    });

    it('a limit buy waits as a pending order at the typed price', async () => {
        const { view, engine, drawings } = setup();
        await view.openDraft('long');
        view.setOrderType('limit');
        view.setLimitPrice(100.5);
        view.placeDraft();
        expect(engine.pendingOrders).toHaveLength(1);
        expect(engine.pendingOrders[0]).toEqual(expect.objectContaining({ side: 'long', entry: 100.5 }));
        expect(engine.openTrades).toHaveLength(0);
        expect(drawings[0]!.anchors[0]!.price).toBe(100.5);
        expect(drawings[0]!.locked).toBe(true);
    });

    it('a fresh draft in Limit mode starts on the favorable side of the price', async () => {
        const buy = setup();
        buy.view.setOrderType('limit');
        await buy.view.openDraft('long');
        expect(buy.drawings[0]!.anchors[0]!.price).toBeLessThan(LAST_CLOSE);
        buy.view.placeDraft(); // no price typed: the starting price is already a valid limit
        expect(buy.engine.pendingOrders).toHaveLength(1);
        expect(buy.engine.pendingOrders[0]!.entry).toBeLessThan(LAST_CLOSE);
        const sell = setup();
        sell.view.setOrderType('limit');
        await sell.view.openDraft('short');
        expect(sell.drawings[0]!.anchors[0]!.price).toBeGreaterThan(LAST_CLOSE);
        sell.view.placeDraft();
        expect(sell.engine.pendingOrders).toHaveLength(1);
    });

    it('a limit price equal to the last close is refused', async () => {
        const { view, engine, host } = setup();
        await view.openDraft('long');
        view.setOrderType('limit');
        view.placeDraft();
        expect(engine.pendingOrders).toHaveLength(0);
        expect(host.textContent).toContain('A limit price must differ from the current price');
    });

    it('market orders still fill at the close, with trailing when asked', async () => {
        const { view, engine } = setup();
        await view.openDraft('long');
        view.setTrail(true, 2);
        view.placeDraft();
        expect(engine.openTrades).toHaveLength(1);
        const t = engine.openTrades[0]!;
        expect(t.entry).toBeCloseTo(LAST_CLOSE);
        expect(t.trailPct).toBe(2);
        expect(t.initialSl).toBe(t.sl);
    });

    it('cancelling a pending order removes it and its drawing', async () => {
        const { view, engine, removed } = setup();
        await view.openDraft('long');
        view.setOrderType('limit');
        view.setLimitPrice(100.5);
        view.placeDraft();
        view.cancelPendingOrder(engine.pendingOrders[0]!.id);
        expect(engine.pendingOrders).toHaveLength(0);
        expect(removed).toEqual(['d0']);
    });

    it('a replay that moves cancels pending orders and running trades', async () => {
        const { view, engine, removed, emitReplay } = setup();
        await view.openDraft('long');
        view.placeDraft();
        await view.openDraft('long');
        view.setOrderType('limit');
        view.setLimitPrice(100.5);
        view.placeDraft();
        expect(engine.openTrades).toHaveLength(1);
        expect(engine.pendingOrders).toHaveLength(1);
        emitReplay('replay:start');
        expect(engine.openTrades).toHaveLength(0);
        expect(engine.pendingOrders).toHaveLength(0);
        expect([...removed].sort()).toEqual(['d0', 'd1']);
    });

    it('a pending order that fills notifies once', async () => {
        const { view, engine, toasts, emitChart } = setup();
        await view.openDraft('long');
        view.setOrderType('limit');
        view.setLimitPrice(100.5);
        view.placeDraft();
        emitChart('bar', nextBar(1, 100, 102, 101));
        expect(engine.openTrades).toHaveLength(1);
        expect(toasts.filter(([, kind]) => kind === 'info')).toHaveLength(1);
    });

});

/** A running market long: entry 101.9 (the last close); the stop and target come from the fake bars' average range. */
async function running(opts: { tp?: number } = {}) {
    const ctx = setup();
    await ctx.view.openDraft('long');
    if (opts.tp !== undefined) ctx.drawings[0]!.anchors[2]!.price = opts.tp;
    ctx.view.placeDraft();
    const trade = ctx.engine.openTrades[0]!;
    // one bar inside the stop and the target moves the last close to 103
    ctx.emitChart('bar', nextBar(1, 101, 104, 103));
    return { ...ctx, id: trade.id, trade: () => ctx.engine.openTrades[0]! };
}

describe('a running trade', () => {
    afterEach(() => document.body.replaceChildren());

    it('keeps its drawing unlocked, and a pending order locked until it fills', async () => {
        const { drawings, view, engine, emitChart } = await running();
        expect(drawings[0]!.locked).toBe(false);
        await view.openDraft('long');
        view.setOrderType('limit');
        view.setLimitPrice(100.5);
        view.placeDraft();
        expect(drawings[1]!.locked).toBe(true);
        emitChart('bar', nextBar(2, 100, 102, 101));
        expect(engine.openTrades).toHaveLength(2);
        expect(drawings[1]!.locked).toBe(false);
    });

    it('typing a tighter stop moves the trade and its drawing', async () => {
        const { view, id, trade, drawings } = await running();
        expect(view.moveStop(id, 100.5)).toBe('moved');
        expect(trade().sl).toBe(100.5);
        expect(drawings[0]!.anchors[1]!.price).toBe(100.5);
    });

    it('a looser stop or one at the price is refused with a message', async () => {
        const { view, id, trade, drawings, toasts } = await running();
        const sl0 = trade().sl;
        const before = toasts.length;
        expect(view.moveStop(id, 99)).toBe('loosens');
        expect(view.moveStop(id, 103)).toBe('past-price');
        expect(trade().sl).toBe(sl0);
        expect(toasts.slice(before).map(([, kind]) => kind)).toEqual(['error', 'error']);
        expect(drawings[0]!.anchors[1]!.price).toBe(sl0);
    });

    it('break-even moves the stop to the entry', async () => {
        const { view, id, trade } = await running();
        expect(view.stopToBreakeven(id)).toBe('moved');
        expect(trade().sl).toBeCloseTo(trade().entry);
    });

    it('dragging the stop on the chart goes through the same rule', async () => {
        const { trade, drawings, toasts, emitChart } = await running();
        drawings[0]!.anchors[1]!.price = 100.5;
        emitChart('drawing:edited', { id: 'd0' });
        expect(trade().sl).toBe(100.5);
        const before = toasts.length;
        drawings[0]!.anchors[1]!.price = 99.5;
        emitChart('drawing:edited', { id: 'd0' });
        expect(trade().sl).toBe(100.5);
        expect(drawings[0]!.anchors[1]!.price).toBe(100.5);
        expect(toasts.slice(before).some(([, kind]) => kind === 'error')).toBe(true);
    });

    it('dragging the entry or the target snaps back', async () => {
        const { trade, drawings, emitChart } = await running();
        const entry = trade().entry;
        const tp = trade().tp;
        drawings[0]!.anchors[0]!.price = 102.4;
        drawings[0]!.anchors[2]!.price = 120;
        emitChart('drawing:edited', { id: 'd0' });
        expect(drawings[0]!.anchors[0]!.price).toBe(entry);
        expect(drawings[0]!.anchors[2]!.price).toBe(tp);
        expect(trade().entry).toBe(entry);
        expect(trade().tp).toBe(tp);
    });

    it('a trailing stop keeps the drawing in step', async () => {
        const { view, id, trade, drawings, emitChart } = await running({ tp: 150 });
        const sl0 = trade().sl;
        expect(view.setTradeTrail(id, 1)).toBe(true);
        emitChart('bar', nextBar(2, 104, 120, 118)); // candidate 118.8 is not below the close 118
        expect(trade().sl).toBe(sl0);
        emitChart('bar', nextBar(3, 119, 121, 120)); // peak 121 less 1%
        expect(trade().sl).toBeCloseTo(119.79);
        expect(drawings[0]!.anchors[1]!.price).toBeCloseTo(119.79);
    });

    it('a stop hit closes the trade and removes the drawing, with the positive R in the message', async () => {
        const { view, id, engine, removed, toasts, emitChart, trade } = await running();
        const r = ((102.4 - 101.9) / (101.9 - trade().sl)).toFixed(2); // measured on the original risk
        expect(view.moveStop(id, 102.4)).toBe('moved');
        emitChart('bar', nextBar(2, 102, 104, 103));
        expect(engine.openTrades).toHaveLength(0);
        expect(engine.history[0]).toEqual(expect.objectContaining({ exit: 102.4, outcome: 'sl' }));
        expect(removed).toContain('d0');
        expect(toasts.some(([m]) => m.includes(`${r}R`))).toBe(true);
    });

    it('an invalid trailing distance is refused', async () => {
        const { view, id, trade, toasts } = await running();
        const before = toasts.length;
        expect(view.setTradeTrail(id, 0)).toBe(false);
        expect(trade().trailPct).toBeUndefined();
        expect(toasts.slice(before).map(([, kind]) => kind)).toEqual(['error']);
    });
});

describe('after review: the drawing of a running trade', () => {
    afterEach(() => document.body.replaceChildren());

    it('moving the whole position does not move the stop, and puts every anchor back', async () => {
        const { trade, drawings, emitChart } = await running();
        const canonical = drawings[0]!.anchors.map((a) => ({ ...a }));
        const sl = trade().sl;
        drawings[0]!.anchors = drawings[0]!.anchors.map((a) => ({ time: a.time + HOUR, price: a.price + 0.5 }));
        emitChart('drawing:edited', { id: 'd0' });
        expect(trade().sl).toBe(sl);
        expect(drawings[0]!.anchors).toEqual(canonical.map((a, i) => (i === 1 ? { ...a, price: sl } : a)));
    });

    it('clicking the trailing switch updates the card at once, even though the switch has focus', async () => {
        const { view, id, host } = await running();
        const toggle = host.querySelector<HTMLInputElement>('[data-trade] label input')!;
        toggle.focus();
        view.setTradeTrail(id, 1);
        expect(host.querySelector('[data-trade]')!.textContent).toContain('Trailing 1%');
    });

    it('a trade that closes while a card field has focus loses its card', async () => {
        const { host, engine, emitChart } = await running();
        host.querySelector<HTMLInputElement>('[data-trade] input[aria-label="Stop loss"]')!.focus();
        emitChart('bar', nextBar(2, 103, 120, 119)); // reaches the take profit
        expect(engine.openTrades).toHaveLength(0);
        expect(host.querySelectorAll('.vela-sim-controls')).toHaveLength(0);
    });

    it('a drawing on another chart is never written to or read as the trade stop', async () => {
        const a = await running();
        const b = makeFakeChart();
        b.drawings.push({ id: 'd0', anchors: [{ time: 1, price: 1 }, { time: 2, price: 2 }, { time: 3, price: 3 }], locked: false });
        a.view.bindChart(b.chart);
        const sl = a.trade().sl;
        a.view.stopToBreakeven(a.id);
        expect(a.drawings[0]!.anchors[1]!.price).toBeCloseTo(a.trade().entry);
        expect(b.drawings[0]!.anchors[1]!.price).toBe(2);
        b.drawings[0]!.anchors[1]!.price = 2.5;
        b.emit('drawing:edited', { id: 'd0' });
        expect(a.trade().sl).toBeCloseTo(a.trade().entry);
        expect(sl).not.toBe(a.trade().sl);
    });
});
