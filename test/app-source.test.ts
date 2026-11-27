import { describe, expect, it, vi } from 'vitest';
import { SOURCES, blockedNotice, pickSource, probeSources } from '../app/source';

describe('SOURCES', () => {
    it('prefers Binance, then Hyperliquid, then Coinbase, each with a symbol that provider serves', () => {
        expect(SOURCES.map((s) => [s.id, s.symbol])).toEqual([
            ['binance', 'binance:BTCUSDT'],
            ['hyperliquid', 'hyperliquid:BTC'],
            ['coinbase', 'coinbase:BTC-USD'],
        ]);
    });
});

describe('pickSource', () => {
    it('takes the first reachable source in order of preference', () => {
        expect(pickSource({ binance: true, hyperliquid: true, coinbase: true })?.id).toBe('binance');
        expect(pickSource({ binance: false, hyperliquid: true, coinbase: true })?.id).toBe('hyperliquid');
        expect(pickSource({ binance: false, hyperliquid: false, coinbase: true })?.id).toBe('coinbase');
    });

    it('is null when nothing is reachable', () => {
        expect(pickSource({ binance: false, hyperliquid: false, coinbase: false })).toBeNull();
    });
});

describe('probeSources', () => {
    it('probes every source at once, with no-cors so it only tests that the host is reachable', async () => {
        const fetchFn = vi.fn((url: string, _init?: { mode?: string }) => (url.includes('hyperliquid') ? Promise.resolve({}) : Promise.reject(new TypeError('blocked'))));
        const result = await probeSources(fetchFn as never, 1000);
        expect(result).toEqual({ binance: false, hyperliquid: true, coinbase: false });
        expect(fetchFn).toHaveBeenCalledTimes(4); // Binance has two hosts (primary and mirror)
        for (const call of fetchFn.mock.calls) expect(call[1]?.mode).toBe('no-cors');
    });

    it('counts Binance as reachable when only its market-data mirror answers', async () => {
        const fetchFn = vi.fn((url: string) => (url.includes('data-api.binance.vision') ? Promise.resolve({}) : Promise.reject(new TypeError('blocked'))));
        const result = await probeSources(fetchFn as never, 1000);
        expect(result).toEqual({ binance: true, hyperliquid: false, coinbase: false });
    });

    it('counts a source that never answers as unreachable once the timeout passes', async () => {
        const never = () => new Promise<never>(() => undefined);
        const started = Date.now();
        const result = await probeSources(never as never, 30);
        expect(result).toEqual({ binance: false, hyperliquid: false, coinbase: false });
        expect(Date.now() - started).toBeLessThan(500);
    });
});

describe('blockedNotice', () => {
    it('explains the problem and a way out, in both languages', () => {
        const id = blockedNotice('id');
        const en = blockedNotice('en');
        expect(id).not.toBe(en);
        for (const text of [id, en]) {
            expect(text.length).toBeGreaterThan(20);
            expect(text).toMatch(/VPN/);
        }
    });
});
