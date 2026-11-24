import { describe, it, expect } from 'vitest';
import { SimulationEngine, plannedRR, resultPips, resultR, validLevels, type SimTrade, type OpenOrder } from '../src/widget/trading-sim/sim-engine';
import { computeStats, MIN_SAMPLE } from '../src/widget/trading-sim/sim-stats';
import { PipSizes } from '../src/widget/trading-sim/pip-sizes';
import { buildStatsModel, PER_TRADE_BARS } from '../src/widget/trading-sim/sim-stats-model';

const long = (over: Partial<OpenOrder> = {}): OpenOrder => ({ symbol: 'BTC', timeframe: '60', side: 'long', entry: 100, sl: 90, tp: 120, openTime: 1_000, pip: 1, ...over });
const bar = (time: number, low: number, high: number, close = (low + high) / 2) => ({ time, low, high, close });

describe('simulation engine', () => {
    it('refuses levels on the wrong side of the entry', () => {
        const e = new SimulationEngine();
        expect(e.place(long({ sl: 110 }))).toBeNull();
        expect(e.place(long({ side: 'short' }))).toBeNull();
        expect(validLevels({ side: 'short', entry: 100, sl: 110, tp: 80 })).toBe(true);
        expect(e.openTrades).toHaveLength(0);
    });

    it('closes a long at its take profit and a short at its stop', () => {
        const e = new SimulationEngine();
        const a = e.place(long())!;
        const b = e.place(long({ side: 'short', sl: 105, tp: 80 }))!;
        expect(e.onBar('BTC', '60', bar(2_000, 95, 106))).toEqual([expect.objectContaining({ id: b.id, exit: 105, outcome: 'sl' })]);
        const done = e.onBar('BTC', '60', bar(3_000, 101, 125));
        expect(done).toEqual([expect.objectContaining({ id: a.id, exit: 120, outcome: 'tp', closeTime: 3_000 })]);
        expect(e.openTrades).toHaveLength(0);
        expect(e.history.map((t) => t.outcome)).toEqual(['sl', 'tp']);
    });

    it('a bar touching both levels closes at the stop', () => {
        const e = new SimulationEngine();
        e.place(long());
        const [t] = e.onBar('BTC', '60', bar(2_000, 85, 130));
        expect(t).toEqual(expect.objectContaining({ outcome: 'sl', exit: 90 }));
    });

    it('ignores the bar it was placed on, and other markets', () => {
        const e = new SimulationEngine();
        e.place(long());
        expect(e.onBar('BTC', '60', bar(1_000, 50, 200))).toEqual([]);
        expect(e.onBar('ETH', '60', bar(2_000, 50, 200))).toEqual([]);
        expect(e.onBar('BTC', '15', bar(2_000, 50, 200))).toEqual([]);
        expect(e.openTrades).toHaveLength(1);
    });

    it('tracks the favorable and adverse excursions while open', () => {
        const e = new SimulationEngine();
        e.place(long());
        e.onBar('BTC', '60', bar(2_000, 95, 112));
        e.onBar('BTC', '60', bar(3_000, 92, 108));
        expect(e.openTrades[0]).toEqual(expect.objectContaining({ mfe: 12, mae: 8 }));
    });

    it('closes by hand, cancels open trades, removes and restores history', () => {
        const e = new SimulationEngine();
        const t = e.place(long())!;
        expect(e.close(t.id, 104, 2_000)).toEqual(expect.objectContaining({ exit: 104, outcome: 'manual' }));
        e.place(long());
        expect(e.cancelOpen()).toHaveLength(1);
        expect(e.history).toHaveLength(1);
        const copy = new SimulationEngine();
        copy.restoreHistory(JSON.parse(JSON.stringify(e.toJSON())));
        expect(copy.history).toEqual(e.history);
        copy.restoreHistory({ trades: [{ id: 'x' }, ...e.toJSON().trades] });
        expect(copy.history).toHaveLength(1);
        copy.removeFromHistory(t.id);
        expect(copy.history).toHaveLength(0);
    });

    it('measures results in risks and pips', () => {
        const t = { ...long(), id: 'a', mfe: 0, mae: 0, exit: 120, closeTime: 2, outcome: 'tp' } as SimTrade;
        expect(plannedRR(t)).toBe(2);
        expect(resultR(t)).toBe(2);
        expect(resultPips({ ...t, pip: 0.5 })).toBe(40);
        expect(resultR({ ...t, side: 'short', entry: 100, sl: 110, exit: 110 })).toBe(-1);
    });
});

/** A closed trade with risk 10 (entry 100, stop 90) and the given outcome. */
function closed(i: number, outcome: 'tp' | 'sl', opts: { tp?: number; mfe?: number } = {}): SimTrade {
    const tp = opts.tp ?? 120;
    return { ...long({ tp }), id: `t${i}`, closeTime: i, exit: outcome === 'tp' ? tp : 90, outcome, mfe: opts.mfe ?? (outcome === 'tp' ? tp - 100 : 0), mae: outcome === 'sl' ? 10 : 0 };
}

describe('simulation statistics', () => {
    it('counts wins, losses, win rate, streaks and drawdown in pips', () => {
        // W L L L W W L  → pip curve: +20, +10, 0, -10, +10, +30, +20
        const seq: Array<'tp' | 'sl'> = ['tp', 'sl', 'sl', 'sl', 'tp', 'tp', 'sl'];
        const s = computeStats(seq.map((o, i) => closed(i, o)));
        expect(s.total).toBe(7);
        expect(s.wins).toBe(3);
        expect(s.losses).toBe(4);
        expect(s.winRate).toBeCloseTo(3 / 7);
        expect(s.netPips).toBe(20);
        expect(s.netR).toBe(2);
        expect(s.longestLosingStreak).toBe(3);
        expect(s.longestWinningStreak).toBe(2);
        expect(s.maxDrawdownPips).toBe(30); // peak +20 → trough −10
        expect(s.maxDrawdownR).toBe(3);
    });

    it('is all zeros with no trades', () => {
        const s = computeStats([]);
        expect(s).toEqual(expect.objectContaining({ total: 0, winRate: 0, maxDrawdownPips: 0, recommended: null }));
    });

    it('recommends the ratio with the best expectancy once the sample is large enough', () => {
        // 12 trades, stop 10 below. Each moved a known number of risks before its stop.
        // mfe in risks: four reached 3R, four reached 1.5R, four went straight to the stop.
        const trades: SimTrade[] = [];
        for (let i = 0; i < 4; i += 1) trades.push(closed(i, 'sl', { mfe: 30 }));
        for (let i = 4; i < 8; i += 1) trades.push(closed(i, 'sl', { mfe: 15 }));
        for (let i = 8; i < 12; i += 1) trades.push(closed(i, 'sl', { mfe: 0 }));
        const s = computeStats(trades);
        const at = (rr: number) => s.rr.find((r) => r.rr === rr)!;
        expect(at(1).probability).toBeCloseTo(8 / 12);
        expect(at(3).probability).toBeCloseTo(4 / 12);
        expect(at(4).probability).toBe(0);
        // expectancy: 1R → 8/12 − 4/12 = 0.33; 1.5R → 0.67·1.5 − 0.33 = 0.67; 3R → 0.33·3 − 0.67 = 0.33
        expect(s.recommended?.rr).toBe(1.5);
        expect(s.recommended?.expectancy).toBeCloseTo(2 / 3);
    });

    it('leaves out trades that hit a nearer target from farther ratios, and needs a minimum sample', () => {
        const trades = Array.from({ length: MIN_SAMPLE }, (_, i) => closed(i, 'tp', { tp: 110 })); // all won at 1R
        const s = computeStats(trades);
        const at = (rr: number) => s.rr.find((r) => r.rr === rr)!;
        expect(at(1)).toEqual(expect.objectContaining({ probability: 1, sample: MIN_SAMPLE }));
        expect(at(2).sample).toBe(0); // nothing known about 2R
        expect(s.recommended?.rr).toBe(1);
        expect(computeStats(trades.slice(1)).recommended).toBeNull();
    });
});

describe('default stop distance', () => {
    it('is the average true range of the bars behind the cursor', async () => {
        const { averageTrueRange } = await import('../src/widget/trading-sim/sim-panel');
        const b = (high: number, low: number, close: number) => ({ time: 0, open: close, high, low, close, volume: 0 });
        // true ranges: max(12−8, |12−10|, |8−10|) = 4; max(15−11, |15−9|, |11−9|) = 6 (gap from the previous close)
        expect(averageTrueRange([b(11, 9, 10), b(12, 8, 9), b(15, 11, 14)])).toBe(5);
        expect(averageTrueRange([b(11, 9, 10)])).toBe(0);
    });
});

describe('pip sizes', () => {
    it('rejects non-positive pip sizes', () => {
        const pips = new PipSizes();
        expect(pips.set('BTCUSDT', 0)).toBe(false);
        expect(pips.set('BTCUSDT', -1)).toBe(false);
        expect(pips.set('BTCUSDT', NaN)).toBe(false);
        expect(pips.get('BTCUSDT')).toBeUndefined();
        expect(pips.set('btcusdt', 1)).toBe(true);
        expect(pips.get('BTCUSDT')).toBe(1);
        pips.set('BTCUSDT', null);
        expect(pips.get('BTCUSDT')).toBeUndefined();
    });

    it("pips use each trade's own symbol override", () => {
        const pips = new PipSizes();
        pips.set('BTC', 10);
        const trades = [{ ...closed(1, 'tp'), symbol: 'BTC' }, { ...closed(2, 'tp'), symbol: 'ETH' }];
        expect(computeStats(trades, { pipOf: (t) => pips.pipOf(t) }).netPips).toBe(2 + 20);
    });

    it('round-trips and skips invalid saved entries', () => {
        const pips = new PipSizes();
        pips.restore({ BTC: 10, ETH: -1, SOL: 'x' });
        expect(pips.toJSON()).toEqual({ BTC: 10 });
        pips.restore(null);
        expect(pips.toJSON()).toEqual({ BTC: 10 });
    });

    it('resultPips takes an explicit pip size', () => {
        const t = closed(1, 'tp');
        expect(resultPips(t)).toBe(20);
        expect(resultPips(t, 10)).toBe(2);
    });
});

/** The 12-trade fixture: four reached 3R, four 1.5R, four went straight to the stop. */
function twelve(): SimTrade[] {
    const trades: SimTrade[] = [];
    for (let i = 0; i < 4; i += 1) trades.push(closed(i, 'sl', { mfe: 30 }));
    for (let i = 4; i < 8; i += 1) trades.push(closed(i, 'sl', { mfe: 15 }));
    for (let i = 8; i < 12; i += 1) trades.push(closed(i, 'sl', { mfe: 0 }));
    return trades;
}

describe('statistics model', () => {
    it('one trade gives a two-point equity curve', () => {
        const m = buildStatsModel(computeStats([closed(1, 'tp')]));
        expect(m.equity).toEqual([{ x: 0, y: 0 }, { x: 1, y: 2 }]);
        expect(m.drawdown).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
        expect(m.empty).toBe(false);
    });

    it('drawdown is the fall from the running peak', () => {
        const seq: Array<'tp' | 'sl'> = ['tp', 'sl', 'sl', 'sl', 'tp', 'tp', 'sl'];
        const s = computeStats(seq.map((o, i) => closed(i, o)));
        expect(s.drawdownR).toEqual([0, -1, -2, -3, -1, 0, -1]);
        expect(s.equityR).toEqual([2, 1, 0, -1, 1, 3, 2]);
        expect(s.maxDrawdownR).toBe(3);
    });

    it('per-trade bars keep the newest 50', () => {
        const m = buildStatsModel(computeStats(Array.from({ length: 120 }, (_, i) => closed(i, 'tp'))));
        expect(PER_TRADE_BARS).toBe(50);
        expect(m.bars).toHaveLength(50);
        expect(m.bars[0]!.label).toBe('71');
        expect(m.bars[49]!.label).toBe('120');
        expect(m.barsTruncated).toBe(true);
        expect(m.equity).toHaveLength(121);
    });

    it('tones follow the sign', () => {
        const flat = { ...closed(3, 'tp'), exit: 100, outcome: 'manual' as const };
        const m = buildStatsModel(computeStats([closed(1, 'tp'), closed(2, 'sl'), flat]));
        expect(m.bars.map((b) => b.tone)).toEqual(['profit', 'loss', 'muted']);
        expect(m.split).toEqual({ wins: 1, losses: 1, breakeven: 1 });
    });

    it('recommendation needs a positive expectancy and enough sample', () => {
        const few = buildStatsModel(computeStats(twelve().slice(8)));
        expect(few.recommendedRR).toBeNull();
        expect(few.samplesToRecommend).toBe(6);
        const m = buildStatsModel(computeStats(twelve()));
        expect(m.recommendedRR).toBe(1.5);
        expect(m.ratios.filter((r) => r.recommended).map((r) => r.rr)).toEqual([1.5]);
        expect(m.samplesToRecommend).toBe(0);
    });

    it('empty model', () => {
        const m = buildStatsModel(computeStats([]));
        expect(m.empty).toBe(true);
        expect(m.equity).toEqual([{ x: 0, y: 0 }]);
        expect(m.bars).toEqual([]);
    });
});
