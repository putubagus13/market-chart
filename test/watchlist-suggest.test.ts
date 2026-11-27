import { describe, it, expect } from 'vitest';
import { suggestSymbols, symbolFor } from '../src/widget/watchlist/suggestions';
import type { SymbolDescriptor } from '../src/core/ports/DataProvider';

const d = (ticker: string, description = '', provider = 'binance', extra: Partial<SymbolDescriptor> = {}): SymbolDescriptor => ({ ticker, description, provider, ...extra });
const list = [
    d('AAAUSDT', 'Aaa / TetherUS'),
    d('ETHUSDT', 'Ethereum / TetherUS'),
    d('BTCUSDT', 'Bitcoin / TetherUS'),
    d('SOLUSDT', 'Solana / TetherUS'),
    d('SOLBTC', 'Solana / Bitcoin'),
    d('BTC', 'Bitcoin', 'hyperliquid'),
    d('ES', 'E-mini', 'cme', { group: 'ES' }), // a group row: not loadable on its own
];
const none = new Set<string>();

describe('suggestSymbols', () => {
    it('with nothing typed, offers the majors first', () => {
        expect(suggestSymbols(list, '', none).slice(0, 3).map((s) => s.ticker)).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    });

    it('ranks a ticker that starts with the query ahead of one that merely contains it', () => {
        expect(suggestSymbols(list, 'sol', none).map((s) => s.ticker).slice(0, 2).sort()).toEqual(['SOLBTC', 'SOLUSDT']);
        // the exact ticker (hyperliquid's BTC) leads, then the USDT pair, then the rest of the prefix matches
        expect(suggestSymbols(list, 'btc', none).map((s) => s.ticker).slice(0, 2)).toEqual(['BTC', 'BTCUSDT']);
    });

    it('puts the exact ticker first, then the USDT pair, ahead of other quote currencies', () => {
        const pairs = [d('DOGEAUD'), d('DOGEBTC'), d('DOGEEUR'), d('DOGEUSDC'), d('DOGEUSDT'), d('DOGE'), d('DOGEBTCX')];
        expect(suggestSymbols(pairs, 'doge', none).map((s) => s.ticker).slice(0, 3)).toEqual(['DOGE', 'DOGEUSDT', 'DOGEUSDC']);
    });

    it('ranks perpetuals (.P) the same way: the exact coin, then its USDT contract, then the others', () => {
        const perps = [d('ETHBTCUSDT.P', '', 'bybit'), d('ETHPERP.P', '', 'bybit'), d('ETHUSDT.P', '', 'bybit'), d('ETHFIUSDT.P', '', 'bybit')];
        expect(suggestSymbols(perps, 'eth', none).map((s) => s.ticker).slice(0, 2)).toEqual(['ETHUSDT.P', 'ETHPERP.P']);
        expect(suggestSymbols([d('DOGE.P'), d('DOGEBTC.P'), d('DOGEUSDT.P')], 'doge', none).map((s) => s.ticker)).toEqual(['DOGE.P', 'DOGEUSDT.P', 'DOGEBTC.P']);
    });

    it('still finds the USDT pair when many other pairs share the prefix', () => {
        const many = Array.from({ length: 40 }, (_, i) => d(`AB${String(i).padStart(2, '0')}BTC`));
        expect(suggestSymbols([...many, d('ABUSDT')], 'ab', none)[0]!.ticker).toBe('ABUSDT');
    });

    it('lists the active source first, then the others, each in its own order', () => {
        const mixed = [d('ADA', 'ADA / USD Perpetual', 'hyperliquid'), d('ADAUSDT'), d('ADAUSDC'), d('ADABTC')];
        expect(suggestSymbols(mixed, 'ada', none, 8, 'binance').map((s) => s.ticker)).toEqual(['ADAUSDT', 'ADAUSDC', 'ADABTC', 'ADA']);
        expect(suggestSymbols(mixed, 'ada', none, 8, 'hyperliquid')[0]!.ticker).toBe('ADA');
        expect(suggestSymbols(mixed, 'ada', none, 8)[0]!.ticker).toBe('ADA'); // no preference: the exact ticker leads
    });

    it('finds a coin by its name as well as its ticker', () => {
        expect(suggestSymbols(list, 'ethereum', none).map((s) => s.ticker)).toEqual(['ETHUSDT']);
    });

    it('leaves out tickers already in the watchlist (any case), and still fills the limit', () => {
        const taken = new Set(['BTCUSDT', 'ETHUSDT']);
        const out = suggestSymbols(list, '', taken, 2);
        expect(out.map((s) => s.ticker)).toEqual(['SOLUSDT', 'AAAUSDT']);
    });

    it('never offers a group row, and stops at the limit', () => {
        expect(suggestSymbols(list, '', none, 100).some((s) => s.ticker === 'ES')).toBe(false);
        expect(suggestSymbols(list, '', none, 3)).toHaveLength(3);
    });

    it('is empty when nothing matches', () => {
        expect(suggestSymbols(list, 'zzzz', none)).toEqual([]);
        expect(suggestSymbols([], '', none)).toEqual([]);
    });
});

describe('symbolFor', () => {
    it('writes the bare ticker when that provider is the one the ticker resolves to, and prefixes it otherwise', () => {
        expect(symbolFor(d('BTCUSDT'), 'binance')).toBe('BTCUSDT');
        expect(symbolFor(d('BTC', '', 'hyperliquid'), 'binance')).toBe('hyperliquid:BTC');
        expect(symbolFor(d('BTC', '', 'hyperliquid'), undefined)).toBe('hyperliquid:BTC');
        expect(symbolFor({ ticker: 'X' }, 'binance')).toBe('X'); // no provider on the row: nothing to prefix
    });
});
