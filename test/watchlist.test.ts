import { describe, it, expect } from 'vitest';
import { WatchlistModel, WATCHLIST_MAX, quoteFromDaily } from '../src/widget/watchlist/watchlist-model';
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
