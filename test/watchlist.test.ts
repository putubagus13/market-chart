import { describe, it, expect } from 'vitest';
import { WatchlistModel, WATCHLIST_MAX, quoteFromDaily, sparklinePath, sparklineArea, signedChange, seedList, seedVariants } from '../src/widget/watchlist/watchlist-model';
import { priceDecimals } from '../src/widget/price-decimals';

describe('watchlist model', () => {
    it('adds without duplicates (case-insensitive), removes and reorders', () => {
        const m = new WatchlistModel();
        let changes = 0;
        m.subscribe(() => (changes += 1));
        expect(m.add('BTCUSDT')).toBe(true);
        expect(m.add(' ethusdt ')).toBe(true);
        expect(m.add('btcusdt')).toBe(false);
        expect(m.add('')).toBe(false);
        expect(m.add('SOLUSDT')).toBe(true);
        expect(m.symbols).toEqual(['BTCUSDT', 'ethusdt', 'SOLUSDT']);
        m.move(2, 0);
        expect(m.symbols).toEqual(['SOLUSDT', 'BTCUSDT', 'ethusdt']);
        m.move(0, 99);
        expect(m.symbols).toEqual(['BTCUSDT', 'ethusdt', 'SOLUSDT']);
        expect(m.remove('ETHUSDT')).toBe(true);
        expect(m.remove('ETHUSDT')).toBe(false);
        expect(m.symbols).toEqual(['BTCUSDT', 'SOLUSDT']);
        expect(changes).toBe(6);
        expect(m.touched).toBe(true);
    });

    it('seeding does not count as an edit; restoring does', () => {
        const m = new WatchlistModel();
        m.seed(['A', 'a', 'B']);
        expect(m.symbols).toEqual(['A', 'B']);
        expect(m.touched).toBe(false);
        m.restore({ symbols: ['X', 'Y'] });
        expect(m.symbols).toEqual(['X', 'Y']);
        expect(m.touched).toBe(true);
    });

    it('round-trips its payload and ignores malformed ones', () => {
        const m = new WatchlistModel();
        m.add('BTCUSDT');
        m.add('ETHUSDT');
        const copy = new WatchlistModel();
        copy.restore(JSON.parse(JSON.stringify(m.toJSON())));
        expect(copy.symbols).toEqual(['BTCUSDT', 'ETHUSDT']);
        for (const bad of [null, 42, { symbols: 'BTC' }, {}]) {
            const x = new WatchlistModel();
            x.restore(bad);
            expect(x.symbols).toEqual([]);
        }
        const mixed = new WatchlistModel();
        mixed.restore({ symbols: ['A', 3, null, 'B'] });
        expect(mixed.symbols).toEqual(['A', 'B']);
    });

    it('stops at the size limit', () => {
        const m = new WatchlistModel();
        for (let i = 0; i < WATCHLIST_MAX; i += 1) m.add(`S${i}`);
        expect(m.add('ONE_MORE')).toBe(false);
        expect(m.symbols).toHaveLength(WATCHLIST_MAX);
    });
});

describe('quotes', () => {
    it('reads the last price and the change against the previous daily close', () => {
        expect(quoteFromDaily([{ close: 100 }, { close: 105 }])).toEqual({ last: 105, change: 5, changePercent: 5 });
        expect(quoteFromDaily([{ close: 100 }])).toBeNull();
    });

    it('picks decimals from the tick size, else from the magnitude', () => {
        expect(priceDecimals(60_000, 0.01)).toBe(2);
        expect(priceDecimals(0.5, 0.0001)).toBe(4);
        expect(priceDecimals(60_000)).toBe(2);
        expect(priceDecimals(12.3)).toBe(4);
        expect(priceDecimals(0.05)).toBe(6);
        expect(priceDecimals(0.000012)).toBe(8);
    });
});

describe('sparklinePath', () => {
    it('draws one point per value, left to right, with the lowest value at the bottom and the highest at the top', () => {
        const d = sparklinePath([10, 20, 15], 60, 20, 2);
        const pts = d.split(/[ML]/).filter(Boolean).map((p) => p.trim().split(' ').map(Number));
        expect(pts).toHaveLength(3);
        expect(pts[0]![0]).toBe(2); // starts at the left padding
        expect(pts[2]![0]).toBe(58); // ends at the right padding
        expect(pts[0]![1]).toBe(18); // lowest value: bottom, inside the padding
        expect(pts[1]![1]).toBe(2); // highest value: top, inside the padding
    });

    it('draws a flat series as a centred line instead of dividing by zero', () => {
        const d = sparklinePath([5, 5, 5], 60, 20, 2);
        expect(d).not.toMatch(/NaN|Infinity/);
        const ys = d.split(/[ML]/).filter(Boolean).map((p) => Number(p.trim().split(' ')[1]));
        expect(new Set(ys)).toEqual(new Set([10]));
    });

    it('draws nothing for fewer than two usable values, and skips non-finite ones', () => {
        expect(sparklinePath([], 60, 20)).toBe('');
        expect(sparklinePath([1], 60, 20)).toBe('');
        expect(sparklinePath([1, Number.NaN, 3], 60, 20).split(/[ML]/).filter(Boolean)).toHaveLength(2);
    });
});

describe('signedChange', () => {
    it('shows an explicit sign for a rise, a fall and no move', () => {
        const fmt = (n: number): string => n.toFixed(2);
        expect(signedChange(1.234, fmt)).toBe('+1.23');
        expect(signedChange(-1.234, fmt)).toBe('-1.23'); // the same sign the percent formatter writes beside it
        expect(signedChange(0, fmt)).toBe('0.00');
    });
});

describe('seedList', () => {
    const all = (): boolean => true;
    const defaults = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

    it('puts the chart symbol first and does not repeat it when a default is the same ticker without the provider prefix', () => {
        expect(seedList('binance:BTCUSDT', defaults, all)).toEqual(['binance:BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
        expect(seedList('btcusdt', defaults, all)).toEqual(['btcusdt', 'ETHUSDT', 'SOLUSDT']);
    });

    it('keeps a chart symbol that is not among the defaults', () => {
        expect(seedList('hyperliquid:BTC', defaults, all)).toEqual(['hyperliquid:BTC', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    });

    it('lists only what a source can serve, and copes with no chart symbol', () => {
        expect(seedList('', defaults, (s) => !s.startsWith('ETH'))).toEqual(['BTCUSDT', 'SOLUSDT']); // no form of ETH is served
        expect(seedList('FOO', defaults, (s) => s !== 'FOO')).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
        expect(seedList('', defaults, () => false)).toEqual([]);
    });
});

describe('sparklineArea', () => {
    it('is the line closed down to the bottom edge, so it can be filled', () => {
        const line = sparklinePath([10, 20, 15], 60, 20, 2);
        const area = sparklineArea([10, 20, 15], 60, 20, 2);
        expect(area.startsWith(line)).toBe(true); // the same points first
        expect(area.endsWith('Z')).toBe(true);
        // then straight down to the bottom (y = height - pad) under the last point, and back under the first
        expect(area.slice(line.length)).toBe('L58 18L2 18Z');
    });

    it('draws nothing when there is no line to fill', () => {
        expect(sparklineArea([], 60, 20)).toBe('');
        expect(sparklineArea([7], 60, 20)).toBe('');
    });
});

describe('seedVariants', () => {
    it('tries the Binance-style ticker first, then the perpetual, the bare coin and the USD pair', () => {
        expect(seedVariants('ETHUSDT')).toEqual(['ETHUSDT', 'ETHUSDT.P', 'ETH', 'ETH-USD']);
    });
});

describe('seedList with variants', () => {
    it('lists each default as the first form a source can serve, so a perpetuals-only source still fills the list', () => {
        const served = new Set(['BTCUSDT.P', 'ETHUSDT.P']);
        expect(seedList('', ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], (s) => served.has(s))).toEqual(['BTCUSDT.P', 'ETHUSDT.P']);
    });

    it('prefers the plain ticker when it is served, and never lists the same coin twice', () => {
        const served = new Set(['BTCUSDT', 'BTCUSDT.P', 'BTC']);
        expect(seedList('', ['BTCUSDT'], (s) => served.has(s))).toEqual(['BTCUSDT']);
    });

    it('does not repeat the chart symbol under another form of the same coin', () => {
        const served = new Set(['bybit:BTCUSDT.P', 'BTCUSDT.P', 'ETHUSDT.P']);
        expect(seedList('bybit:BTCUSDT.P', ['BTCUSDT', 'ETHUSDT'], (s) => served.has(s))).toEqual(['bybit:BTCUSDT.P', 'ETHUSDT.P']);
    });
});
