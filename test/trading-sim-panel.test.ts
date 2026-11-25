// @vitest-environment jsdom
// The simulator panel places trades with the symbol's tick size; a user pip size only changes
// how results are read, so clearing it brings every trade back to the tick size.
import { describe, it, expect, afterEach } from 'vitest';
import { TradingSimView, evidenceOf, serializeSim, restoreSim } from '../src/widget/trading-sim/sim-panel';
import { MemoryEvidenceStore, type EvidenceStore } from '../src/widget/trading-sim/evidence-store';
import { TradeEvidence } from '../src/widget/trading-sim/trade-evidence';
import { computeStats } from '../src/widget/trading-sim/sim-stats';
import { buildBackup, buildDataset, parseBackup } from '../src/widget/trading-sim/trade-archive';
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

function makeFakeChart(providerBars: typeof bars = bars) {
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
            providerInstance: () => ({ getBars: async () => providerBars }),
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

const SHOT = 'data:image/webp;base64,AAAA';
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

type Download = { filename: string; text: string; mime: string };

function setup(opts: { store?: EvidenceStore; providerBars?: typeof bars; capture?: () => string | null; downloads?: Download[] } = {}) {
    const host = document.createElement('div');
    document.body.append(host);
    const fake = makeFakeChart(opts.providerBars);
    const replayHandlers: Handlers = new Map();
    const replay = { state: { active: true, cursorTime: bars[19]!.time }, pause: () => {}, on: onFor(replayHandlers) };
    const toasts: Array<[string, string | undefined]> = [];
    const ctx = { host, i18n: createTranslator({ locale: 'en' }), toast: (m: string, kind?: string) => toasts.push([m, kind]), stateChanged: () => {}, replay } as unknown as WidgetContext;
    const engine = new SimulationEngine();
    const pips = new PipSizes();
    const store = opts.store ?? new MemoryEvidenceStore();
    const evidence = evidenceOf(ctx, store);
    const view = new TradingSimView(ctx, engine, pips, evidence, { capture: opts.capture ?? (() => SHOT), paint: async () => {}, download: (filename, text, mime) => void opts.downloads?.push({ filename, text, mime }) });
    host.append(view.el);
    view.bindChart(fake.chart);
    return { view, engine, pips, evidence, store, ctx, drawings: fake.drawings, removed: fake.removed, toasts, host, chart: fake.chart, emitChart: fake.emit, emitReplay: emitFor(replayHandlers) };
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
        await flush(); // the drawing stays until the closing screenshot has been taken
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

const failingStore = (): EvidenceStore => {
    const boom = (): Promise<never> => Promise.reject(new Error('quota'));
    return { putWindow: boom, getWindow: boom, putShot: boom, getShot: boom, removeShot: boom, remove: boom, clear: boom };
};
const hitTarget = () => nextBar(1, 100, 110, 108);

describe('the trade journal in the panel', () => {
    afterEach(() => document.body.replaceChildren());

    async function placeMarket(t: ReturnType<typeof setup>): Promise<string> {
        await t.view.openDraft('long');
        t.view.placeDraft();
        return t.engine.openTrades[0]!.id;
    }

    it('saves a context that ends at the placement bar, whatever the provider has loaded', async () => {
        const later = Array.from({ length: 5 }, (_, i) => ({ time: bars[19]!.time + (i + 1) * HOUR, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
        const t = setup({ providerBars: [...bars, ...later] });
        const id = await placeMarket(t);
        t.emitChart('bar', hitTarget());
        await flush();
        const w = (await t.store.getWindow(id))!;
        expect(w.map((c) => c[0])).toEqual([...bars.map((b) => b.time), hitTarget().time]);
        expect(w.every((c) => c[4] !== 1)).toBe(true);
    });

    it('adds each revealed bar, the closing bar included, and stops at the close', async () => {
        const t = setup();
        const id = await placeMarket(t);
        t.emitChart('bar', nextBar(1, 100, 102, 101));
        t.emitChart('bar', nextBar(2, 100, 110, 108));
        t.emitChart('bar', nextBar(3, 100, 101, 100));
        await flush();
        const w = (await t.store.getWindow(id))!;
        expect(w[w.length - 1]![0]).toBe(nextBar(2, 0, 0, 0).time);
    });

    it('takes an open shot and a close shot, and the position is still on the chart for the close one', async () => {
        const seen: number[] = [];
        let live: unknown[] = [];
        const t = setup({ capture: () => (seen.push(live.length), SHOT) });
        live = t.drawings;
        const id = await placeMarket(t);
        await flush();
        t.emitChart('bar', hitTarget());
        await flush();
        expect(await t.store.getShot(id, 'open')).toBe(SHOT);
        expect(await t.store.getShot(id, 'close')).toBe(SHOT);
        expect(seen).toEqual([1, 1]);
        expect(t.drawings).toHaveLength(0);
    });

    it('a manual close takes the close shot too', async () => {
        const t = setup();
        const id = await placeMarket(t);
        t.emitChart('bar', nextBar(1, 100, 102, 101));
        t.view.closeTrade(id);
        await flush();
        expect(await t.store.getShot(id, 'close')).toBe(SHOT);
        expect(await t.store.getWindow(id)).toBeDefined();
    });

    it('a cancelled order is logged, keeps its candles, loses its open shot, and leaves the statistics alone', async () => {
        const t = setup();
        const before = computeStats(t.engine.history);
        t.view.setOrderType('limit');
        await t.view.openDraft('long');
        t.view.placeDraft();
        const id = t.engine.pendingOrders[0]!.id;
        await flush();
        expect(await t.store.getShot(id, 'open')).toBe(SHOT);
        t.view.cancelPendingOrder(id);
        await flush();
        expect(t.engine.orderLog).toEqual([expect.objectContaining({ id, outcome: 'cancelled', reason: 'user' })]);
        expect(t.engine.history).toHaveLength(0);
        expect(computeStats(t.engine.history)).toEqual(before);
        expect(await t.store.getShot(id, 'open')).toBeUndefined();
        expect((await t.store.getWindow(id))!.length).toBeGreaterThan(0);
    });

    it('ending the replay logs waiting orders as not filled and forgets running trades', async () => {
        const t = setup();
        const running = await placeMarket(t);
        t.view.setOrderType('limit');
        await t.view.openDraft('short');
        t.view.placeDraft();
        const waiting = t.engine.pendingOrders[0]!.id;
        await flush();
        t.emitReplay('replay:end');
        await flush();
        expect(t.engine.orderLog).toEqual([expect.objectContaining({ id: waiting, outcome: 'unfilled', reason: 'replay' })]);
        expect(t.engine.history).toHaveLength(0);
        expect(await t.store.getWindow(running)).toBeUndefined();
        expect(await t.store.getShot(running, 'open')).toBeUndefined();
        expect(await t.store.getShot(waiting, 'open')).toBeUndefined();
        expect(await t.store.getWindow(waiting)).toBeDefined();
    });

    it('removing a trade or clearing the history empties the store', async () => {
        const t = setup();
        const first = await placeMarket(t);
        t.emitChart('bar', hitTarget());
        await flush();
        t.engine.removeFromHistory(first);
        await flush();
        expect(await t.store.getWindow(first)).toBeUndefined();
        expect(await t.store.getShot(first, 'close')).toBeUndefined();
        const second = await placeMarket(t);
        t.emitChart('bar', nextBar(2, 100, 110, 108));
        await flush();
        expect(await t.store.getWindow(second)).toBeDefined();
        t.engine.clearHistory();
        await flush();
        expect(await t.store.getWindow(second)).toBeUndefined();
    });

    it('a store that fails never blocks placing, closing, cancelling, or removing, and one toast says so', async () => {
        const t = setup({ store: failingStore() });
        const id = await placeMarket(t);
        t.emitChart('bar', hitTarget());
        await flush();
        expect(t.engine.history.map((x) => x.id)).toEqual([id]);
        t.view.setOrderType('limit');
        await t.view.openDraft('long');
        t.view.placeDraft();
        t.view.cancelPendingOrder(t.engine.pendingOrders[0]!.id);
        t.engine.removeFromHistory(id);
        await flush();
        expect(t.engine.orderLog).toHaveLength(1);
        expect(t.toasts.filter(([m, kind]) => kind === 'error' && m.includes('candles or screenshots'))).toHaveLength(1);
    });

    it('with screenshots off, the candles are still saved', async () => {
        const t = setup();
        t.evidence.screenshots = false;
        const id = await placeMarket(t);
        t.emitChart('bar', hitTarget());
        await flush();
        expect(await t.store.getShot(id, 'open')).toBeUndefined();
        expect(await t.store.getShot(id, 'close')).toBeUndefined();
        expect(await t.store.getWindow(id)).toBeDefined();
    });

    it('labels typed before placing go onto the trade; tags stay for the next order, the note clears', async () => {
        const t = setup();
        await t.view.openDraft('long');
        const tags = t.host.querySelector<HTMLInputElement>('.vela-sim-form input[aria-label="Tags"]')!;
        const note = t.host.querySelector<HTMLInputElement>('.vela-sim-form input[aria-label="Note"]')!;
        tags.value = 'breakout, pullback';
        note.value = 'why';
        t.view.placeDraft();
        expect(t.engine.openTrades[0]).toEqual(expect.objectContaining({ tags: ['breakout', 'pullback'], note: 'why' }));
        expect(note.value).toBe('');
        expect(tags.value).toBe('breakout, pullback');
    });

    it('saves and restores the order log and the screenshot setting with the document', async () => {
        const t = setup();
        t.view.setOrderType('limit');
        await t.view.openDraft('long');
        t.view.placeDraft();
        t.view.cancelPendingOrder(t.engine.pendingOrders[0]!.id);
        t.evidence.screenshots = false;
        const saved = JSON.parse(JSON.stringify(serializeSim(t.engine, t.pips, t.evidence)));
        expect(saved.orders).toHaveLength(1);
        expect(saved.settings).toEqual({ screenshots: false });
        const engine = new SimulationEngine();
        const evidence = new TradeEvidence(null, () => {});
        restoreSim(saved, engine, new PipSizes(), evidence);
        expect(engine.orderLog).toEqual(t.engine.orderLog);
        expect(evidence.screenshots).toBe(false);
        const old = new SimulationEngine();
        restoreSim({ trades: [] }, old, new PipSizes(), new TradeEvidence(null, () => {}));
        expect(old.history).toHaveLength(0);
        expect(serializeSim(new SimulationEngine(), new PipSizes(), new TradeEvidence(null, () => {}))).toBeUndefined();
    });
});

describe('the journal pages', () => {
    afterEach(() => document.body.replaceChildren());

    /** A closed trade with tags, a cancelled limit order, and a pip size: a history worth exporting. */
    async function journal(t: ReturnType<typeof setup>): Promise<string> {
        await t.view.openDraft('long');
        t.view.placeDraft();
        const id = t.engine.openTrades[0]!.id;
        t.engine.setLabels(id, { tags: ['breakout'], note: 'plan' });
        t.emitChart('bar', hitTarget());
        await flush();
        t.view.setOrderType('limit');
        await t.view.openDraft('long');
        t.view.placeDraft();
        t.view.cancelPendingOrder(t.engine.pendingOrders[0]!.id);
        t.view.setOrderType('market');
        t.pips.set('BTCUSDT', 0.5);
        await flush();
        return id;
    }

    /** Open the History tab through its trigger, as a user does. */
    const showHistory = async (t: ReturnType<typeof setup>): Promise<void> => {
        [...t.host.querySelectorAll<HTMLButtonElement>('[role="tablist"] button')].find((b) => b.textContent!.trim().startsWith('History'))!.click();
        await flush();
    };

    const field = (host: HTMLElement, card: string, label: 'Tags' | 'Note'): HTMLInputElement => host.querySelector<HTMLInputElement>(`${card} input[aria-label="${label}"]`)!;
    const change = (input: HTMLInputElement, value: string): void => {
        input.value = value;
        input.dispatchEvent(new Event('change'));
    };

    it('tags and a note can be edited on a running trade, a waiting order, and a closed trade', async () => {
        const t = setup();
        await t.view.openDraft('long');
        t.view.placeDraft();
        const id = t.engine.openTrades[0]!.id;
        change(field(t.host, `[data-trade="${id}"]`, 'Tags'), 'a, b');
        change(field(t.host, `[data-trade="${id}"]`, 'Note'), 'note one');
        expect(t.engine.openTrades[0]).toEqual(expect.objectContaining({ tags: ['a', 'b'], note: 'note one' }));
        t.view.setOrderType('limit');
        await t.view.openDraft('short');
        t.view.placeDraft();
        const waiting = t.engine.pendingOrders[0]!.id;
        change(field(t.host, `[data-pending="${waiting}"]`, 'Tags'), 'limit');
        expect(t.engine.pendingOrders[0]!.tags).toEqual(['limit']);
        t.emitChart('bar', hitTarget());
        await flush();
        change(field(t.host, `[data-trade="${id}"]`, 'Tags'), 'closed');
        expect(t.engine.history.find((x) => x.id === id)!.tags).toEqual(['closed']);
        expect(t.engine.history.find((x) => x.id === id)!.note).toBe('note one');
    });

    it('lists orders that never filled apart from the trades, and removing one drops its candles', async () => {
        const t = setup();
        await journal(t);
        const record = t.engine.orderLog[0]!;
        const card = t.host.querySelector(`[data-record="${record.id}"]`)!;
        expect(card.textContent).toContain('Cancelled');
        expect(t.host.querySelectorAll('[data-trade]')).toHaveLength(1);
        card.querySelector<HTMLButtonElement>('button[aria-label="Remove order"]')!.click();
        await flush();
        expect(t.engine.orderLog).toHaveLength(0);
        expect(await t.store.getWindow(record.id)).toBeUndefined();
    });

    it('shows the two screenshots of a closed trade and opens them larger', async () => {
        const t = setup();
        const id = await journal(t);
        await showHistory(t);
        const thumbs = [...t.host.querySelectorAll<HTMLImageElement>(`[data-trade="${id}"] .vela-sim-shots img`)];
        expect(thumbs.map((img) => img.getAttribute('src'))).toEqual([SHOT, SHOT]);
        const before = t.host.querySelectorAll('img').length;
        t.host.querySelector<HTMLElement>(`[data-trade="${id}"] .vela-sim-shot`)!.click();
        await flush();
        expect(t.host.querySelectorAll('img').length).toBe(before + 2);
    });

    it('shows no screenshot strip for a trade saved without shots', async () => {
        const t = setup();
        t.engine.restoreHistory({ trades: [{ id: 'old', symbol: 'BTCUSDT', timeframe: '60', side: 'long', entry: 100, sl: 95, tp: 110, openTime: 1, pip: 1, mfe: 5, mae: 1, closeTime: 2, exit: 110, outcome: 'tp' }] });
        await flush();
        expect(t.host.querySelector('[data-trade="old"]')).not.toBeNull();
        expect(t.host.querySelector('[data-trade="old"] .vela-sim-shots')).toBeNull();
    });

    it('exports a backup that holds exactly what the engine, the store, and the pip sizes hold', async () => {
        const downloads: Download[] = [];
        const t = setup({ downloads });
        await journal(t);
        await t.view.exportBackup();
        expect(downloads).toHaveLength(1);
        expect(downloads[0]!.filename).toMatch(/^vela-trades-\d{4}-\d{2}-\d{2}\.json$/);
        const parsed = parseBackup(downloads[0]!.text);
        if (!parsed.ok) throw new Error('unreadable');
        const ids = [...t.engine.history, ...t.engine.orderLog].map((x) => x.id);
        const data = await t.evidence.read(ids);
        expect(parsed.backup.trades).toEqual(t.engine.history);
        expect(parsed.backup.orders).toEqual(t.engine.orderLog);
        expect(parsed.backup.windows).toEqual(data.windows);
        expect(parsed.backup.images).toEqual(data.images);
        expect(parsed.backup.pipSizes).toEqual({ BTCUSDT: 0.5 });
        expect(Object.keys(parsed.backup.images)).toHaveLength(1);
    });

    it('leaves the screenshots out of the backup when that switch is off', async () => {
        const downloads: Download[] = [];
        const t = setup({ downloads });
        await journal(t);
        t.host.querySelector<HTMLInputElement>('input[aria-label="Include screenshots in backup"]')!.click();
        await t.view.exportBackup();
        const parsed = parseBackup(downloads[0]!.text);
        expect(parsed.ok && parsed.backup.images).toEqual({});
        expect(parsed.ok && Object.keys(parsed.backup.windows).length).toBeGreaterThan(0);
    });

    it('exports the dataset: one line for the trade and one for the order', async () => {
        const downloads: Download[] = [];
        const t = setup({ downloads });
        const id = await journal(t);
        await t.view.exportDataset();
        expect(downloads[0]!.filename).toMatch(/^vela-dataset-\d{4}-\d{2}-\d{2}\.jsonl$/);
        const rows = downloads[0]!.text.trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
        expect(rows.map((r) => r.id)).toEqual([id, t.engine.orderLog[0]!.id]);
        expect(rows[0]).toEqual(expect.objectContaining({ schema: 1, tags: ['breakout'], note: 'plan', outcome: 'tp' }));
        expect(rows[1]).toEqual(expect.objectContaining({ outcome: 'cancelled', result_r: null }));
    });

    it('an exported backup imports into a fresh simulator with every field the same', async () => {
        const downloads: Download[] = [];
        const a = setup({ downloads });
        await journal(a);
        await a.view.exportBackup();
        const b = setup();
        await b.view.importText(downloads[0]!.text);
        expect(b.engine.history).toEqual(a.engine.history);
        expect(b.engine.orderLog).toEqual(a.engine.orderLog);
        const ids = [...a.engine.history, ...a.engine.orderLog].map((x) => x.id);
        expect(await b.evidence.read(ids)).toEqual(await a.evidence.read(ids));
        expect(b.pips.toJSON()).toEqual(a.pips.toJSON());
        await showHistory(b);
        expect(b.host.querySelectorAll(`[data-trade="${a.engine.history[0]!.id}"] .vela-sim-shots img`)).toHaveLength(2);
    });

    it('importing the same file twice adds nothing the second time and says so', async () => {
        const downloads: Download[] = [];
        const a = setup({ downloads });
        await journal(a);
        await a.view.exportBackup();
        const b = setup();
        await b.view.importText(downloads[0]!.text);
        await b.view.importText(downloads[0]!.text);
        expect(b.engine.history).toHaveLength(1);
        expect(b.engine.orderLog).toHaveLength(1);
        expect(b.toasts[b.toasts.length - 2]![0]).toContain('2 added');
        expect(b.toasts[b.toasts.length - 1]![0]).toContain('2 already present');
    });

    it('never overwrites a trade it already has, and keeps a pip size already set', async () => {
        const downloads: Download[] = [];
        const a = setup({ downloads });
        const id = await journal(a);
        await a.view.exportBackup();
        const b = setup();
        b.engine.restoreHistory({ trades: [{ ...a.engine.history[0]!, entry: 99, id }] });
        b.pips.set('BTCUSDT', 2);
        await b.view.importText(downloads[0]!.text);
        expect(b.engine.history[0]!.entry).toBe(99);
        expect(b.pips.get('BTCUSDT')).toBe(2);
    });

    it('a file it cannot use changes nothing and says why', async () => {
        const t = setup();
        await journal(t);
        const before = JSON.stringify(t.engine.toJSON());
        const toasts = t.toasts.length;
        for (const text of ['not json', JSON.stringify({ format: 'x', version: 1 }), JSON.stringify({ format: 'vela.tradingSim', version: 99 })]) await t.view.importText(text);
        expect(JSON.stringify(t.engine.toJSON())).toBe(before);
        expect(t.toasts.slice(toasts).map(([, kind]) => kind)).toEqual(['error', 'error', 'error']);
        expect(t.toasts.slice(toasts).map(([m]) => m)).toEqual(['That file is not valid JSON.', 'That file is not a Vela trade backup.', 'That backup was made by a newer version.']);
    });

    it('a replay step does not rebuild the cards while a tag field is being typed in', async () => {
        const t = setup();
        await t.view.openDraft('long');
        t.view.placeDraft();
        const id = t.engine.openTrades[0]!.id;
        const input = field(t.host, `[data-trade="${id}"]`, 'Tags');
        input.focus();
        input.value = 'half typed';
        t.emitChart('bar', nextBar(1, 100, 102, 101));
        expect(field(t.host, `[data-trade="${id}"]`, 'Tags')).toBe(input);
        expect(input.value).toBe('half typed');
    });

    it('keeps the history cards while a tag field there is being typed in', async () => {
        const t = setup();
        const id = await journal(t);
        const input = field(t.host, `[data-trade="${id}"]`, 'Tags');
        input.focus();
        t.emitReplay('replay:step');
        expect(field(t.host, `[data-trade="${id}"]`, 'Tags')).toBe(input);
    });

    it('lets the screenshot setting be switched and saved', async () => {
        const t = setup();
        await journal(t);
        const state: string[] = [];
        (t.ctx as { stateChanged: () => void }).stateChanged = () => void state.push('changed');
        t.host.querySelector<HTMLInputElement>('input[aria-label="Save screenshots"]')!.click();
        expect(t.evidence.screenshots).toBe(false);
        expect(state.length).toBeGreaterThan(0);
    });
});

describe('after review', () => {
    afterEach(() => document.body.replaceChildren());
    const showHistory = async (t: ReturnType<typeof setup>): Promise<void> => {
        [...t.host.querySelectorAll<HTMLButtonElement>('[role="tablist"] button')].find((b) => b.textContent!.trim().startsWith('History'))!.click();
        await flush();
    };

    it('the placement candle is the bar the replay showed, not the provider\'s finished version of it', async () => {
        const finished = { ...bars[19]!, high: 150, low: 90, close: 120 };
        const t = setup({ providerBars: [...bars.slice(0, 19), finished] });
        const shown = { time: bars[19]!.time, open: 100, high: 101, low: 99.5, close: 100.4, volume: 1 };
        t.emitChart('bar', shown); // the bar still forming when the user pauses
        await t.view.openDraft('long');
        t.view.placeDraft();
        const id = t.engine.openTrades[0]!.id;
        expect(t.engine.openTrades[0]!.entry).toBe(shown.close);
        t.emitChart('bar', nextBar(1, 100, 110, 108));
        await flush();
        const w = (await t.store.getWindow(id))!;
        const placement = w.find((c) => c[0] === shown.time)!;
        expect([placement[2], placement[3], placement[4]]).toEqual([shown.high, shown.low, shown.close]);
    });

    it('does not read screenshots for a History tab nobody has opened, and shows them once it opens', async () => {
        const store = new MemoryEvidenceStore();
        const reads = { n: 0 };
        const getShot = store.getShot.bind(store);
        store.getShot = async (id, kind) => (reads.n++, getShot(id, kind));
        const t = setup({ store });
        await t.view.openDraft('long');
        t.view.placeDraft();
        const id = t.engine.openTrades[0]!.id;
        t.emitChart('bar', nextBar(1, 100, 110, 108));
        await flush();
        expect(reads.n).toBe(0);
        await showHistory(t);
        expect(reads.n).toBeGreaterThan(0);
        expect(t.host.querySelectorAll(`[data-trade="${id}"] .vela-sim-shots img`)).toHaveLength(2);
    });

    it('a replay step does not rebuild the History cards, a real change does', async () => {
        const t = setup();
        await t.view.openDraft('long');
        t.view.placeDraft();
        const id = t.engine.openTrades[0]!.id;
        t.emitChart('bar', nextBar(1, 100, 110, 108));
        await flush();
        await showHistory(t);
        const card = t.host.querySelector(`[data-trade="${id}"]`)!;
        t.emitReplay('replay:step');
        t.emitChart('bar', nextBar(2, 100, 102, 101));
        expect(t.host.querySelector(`[data-trade="${id}"]`)).toBe(card);
        t.engine.setLabels(id, { tags: ['x'] });
        expect(t.host.querySelector(`[data-trade="${id}"]`)).not.toBe(card);
    });
});
