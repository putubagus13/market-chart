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

function setup() {
    const host = document.createElement('div');
    document.body.append(host);
    const drawings: Array<{ id: string; anchors: Array<{ time: number; price: number }> }> = [];
    const chart = {
        market: { symbol: 'BTCUSDT', timeframe: '60' },
        on: () => () => {},
        getVisibleRange: () => null,
        setVisibleRange: () => {},
        data: {
            resolve: () => ({ provider: 'p', ticker: 'BTCUSDT' }),
            providerInstance: () => ({ getBars: async () => bars }),
            symbolInfo: async () => ({ mintick: 0.01 }),
        },
        drawings: {
            add: (_type: string, init: { anchors: Array<{ time: number; price: number }> }) => {
                const d = { id: `d${drawings.length}`, anchors: init.anchors };
                drawings.push(d);
                return d;
            },
            all: () => drawings,
            update: () => {},
            lock: () => {},
            remove: () => {},
        },
    } as unknown as Vela;
    const replay = { state: { active: true, cursorTime: bars[19]!.time }, pause: () => {}, on: () => () => {} };
    const ctx = { host, i18n: createTranslator({ locale: 'en' }), toast: () => {}, stateChanged: () => {}, replay } as unknown as WidgetContext;
    const engine = new SimulationEngine();
    const pips = new PipSizes();
    const view = new TradingSimView(ctx, engine, pips);
    view.bindChart(chart);
    return { view, engine, pips };
}

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
});
