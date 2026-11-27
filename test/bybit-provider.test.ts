import { describe, it, expect, vi, afterEach } from 'vitest';
import { BybitProvider, normalizeTf, parseTicker, rowsToOHLCV, klineEventToOHLCV } from '../src/data/providers/bybit/BybitProvider';
import type { OHLCV } from '../src/core/model/ohlcv';

const HOUR = 3_600_000;
const res = (body: unknown, ok = true, status = ok ? 200 : 500): Response => ({ ok, status, json: () => Promise.resolve(body) }) as unknown as Response;
const ok = (list: unknown, extra: object = {}): Response => res({ retCode: 0, retMsg: 'OK', result: { list, ...extra } });
/** Bybit returns a kline row as strings: [start, open, high, low, close, volume, turnover], NEWEST FIRST. */
const row = (t: number, o = 10, h = 12, l = 9, c = 11, v = 5): string[] => [String(t), String(o), String(h), String(l), String(c), String(v), '0'];

describe('Bybit pure helpers', () => {
    it('normalizeTf maps aliases to canonical keys', () => {
        expect(normalizeTf('1h')).toBe('60');
        expect(normalizeTf('4h')).toBe('240');
        expect(normalizeTf('1d')).toBe('D');
        expect(normalizeTf('60')).toBe('60');
    });

    it('parseTicker splits perpetuals (.P) from spot, upper-casing', () => {
        expect(parseTicker('BTCUSDT')).toEqual({ apiSymbol: 'BTCUSDT', category: 'spot' });
        expect(parseTicker('btcusdt.p')).toEqual({ apiSymbol: 'BTCUSDT', category: 'linear' });
    });

    it('rowsToOHLCV reads the string rows and returns them oldest first', () => {
        const bars = rowsToOHLCV([row(2000, 20, 22, 19, 21, 7), row(1000)]);
        expect(bars.map((b) => b.time)).toEqual([1000, 2000]);
        expect(bars[1]).toEqual({ time: 2000, open: 20, high: 22, low: 19, close: 21, volume: 7 });
    });

    it('klineEventToOHLCV maps a stream payload', () => {
        expect(klineEventToOHLCV({ start: 1000, open: '10', high: '12', low: '9', close: '11', volume: '100' })).toEqual({ time: 1000, open: 10, high: 12, low: 9, close: 11, volume: 100 });
    });
});

describe('BybitProvider.getBars (stubbed fetch)', () => {
    afterEach(() => vi.unstubAllGlobals());

    /** Every host pings fine; klines answer with `list`; records the request URLs. */
    function stub(list: unknown): string[] {
        const calls: string[] = [];
        vi.stubGlobal('fetch', vi.fn((input: string | URL) => {
            const url = input.toString();
            calls.push(url);
            if (url.includes('/v5/market/time')) return Promise.resolve(res({ retCode: 0 }));
            if (url.includes('/v5/market/kline')) return Promise.resolve(ok(list, { category: 'linear' }));
            return Promise.resolve(res({}, false, 404));
        }));
        return calls;
    }

    it('fetches a native timeframe and returns ascending OHLCV', async () => {
        const calls = stub([row(2 * HOUR), row(HOUR)]);
        const bars = await new BybitProvider().getBars('BTCUSDT.P', '1h', { limit: 2 });
        const url = new URL(calls.find((u) => u.includes('/kline'))!);
        expect(url.searchParams.get('category')).toBe('linear');
        expect(url.searchParams.get('symbol')).toBe('BTCUSDT');
        expect(url.searchParams.get('interval')).toBe('60');
        expect(url.searchParams.get('limit')).toBe('2');
        expect(bars.map((b) => b.time)).toEqual([HOUR, 2 * HOUR]);
    });

    it('asks the spot category for a plain ticker, and names daily/weekly/monthly the way Bybit does', async () => {
        const calls = stub([row(HOUR)]);
        await new BybitProvider().getBars('ETHUSDT', '1d', { limit: 1 });
        await new BybitProvider().getBars('ETHUSDT', 'W', { limit: 1 });
        await new BybitProvider().getBars('ETHUSDT', 'M', { limit: 1 });
        const params = calls.filter((u) => u.includes('/kline')).map((u) => new URL(u).searchParams);
        expect(params.map((p) => p.get('category'))).toEqual(['spot', 'spot', 'spot']);
        expect(params.map((p) => p.get('interval'))).toEqual(['D', 'W', 'M']);
    });

    it('aggregates a timeframe Bybit does not serve (45m) from 15m candles', async () => {
        const MIN15 = 15 * 60_000;
        const base = 10 * HOUR; // aligned to a 45m bucket (epoch multiple of 45m)
        const aligned = Math.floor(base / (45 * 60_000)) * 45 * 60_000;
        const calls = stub([row(aligned + 2 * MIN15, 3, 9, 2, 8, 1), row(aligned + MIN15, 2, 5, 1, 3, 1), row(aligned, 1, 4, 0.5, 2, 1)]);
        const bars = await new BybitProvider().getBars('BTCUSDT.P', '45', {});
        expect(new URL(calls.find((u) => u.includes('/kline'))!).searchParams.get('interval')).toBe('15');
        expect(bars).toHaveLength(1);
        expect(bars[0]).toEqual({ time: aligned, open: 1, high: 9, low: 0.5, close: 8, volume: 3 });
    });

    it('pages backward past the 1000-row cap and merges the pages in order', async () => {
        const page = (from: number, n: number): string[][] => Array.from({ length: n }, (_, i) => row((from + n - 1 - i) * HOUR));
        const ends: Array<string | null> = [];
        let kline = 0;
        vi.stubGlobal('fetch', vi.fn((input: string | URL) => {
            const url = input.toString();
            if (url.includes('/v5/market/time')) return Promise.resolve(res({ retCode: 0 }));
            if (url.includes('/kline')) {
                kline += 1;
                ends.push(new URL(url).searchParams.get('end'));
                return Promise.resolve(ok(kline === 1 ? page(1000, 1000) : page(500, 500)));
            }
            return Promise.resolve(res({}, false, 404));
        }));
        const bars = await new BybitProvider().getBars('BTCUSDT.P', '1h', { limit: 1500 });
        expect(kline).toBe(2);
        expect(bars).toHaveLength(1500);
        expect(bars[0]!.time).toBeLessThan(bars[bars.length - 1]!.time);
        expect(ends[1]).toBe(String(1000 * HOUR - 1)); // the next page ends just before the oldest row of the last one
    });

    it('fails soft: an API error answers with no bars and a warning, not a rejection', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn((input: string | URL) => {
            const url = input.toString();
            if (url.includes('/v5/market/time')) return Promise.resolve(res({ retCode: 0 }));
            return Promise.resolve(res({ retCode: 10001, retMsg: 'params error' }));
        }));
        expect(await new BybitProvider().getBars('NOPE', '1h', { limit: 1 })).toEqual([]);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe('BybitProvider endpoint choice (stubbed fetch)', () => {
    afterEach(() => vi.unstubAllGlobals());

    function stubHosts(reachable: (host: string) => boolean): string[] {
        const calls: string[] = [];
        vi.stubGlobal('fetch', vi.fn((input: string | URL) => {
            const url = input.toString();
            calls.push(url);
            const host = new URL(url).host;
            if (!reachable(host)) return Promise.reject(new TypeError('blocked'));
            if (url.includes('/v5/market/time')) return Promise.resolve(res({ retCode: 0 }));
            return Promise.resolve(ok([row(HOUR)]));
        }));
        return calls;
    }
    const klineHosts = (calls: string[]): string[] => calls.filter((u) => u.includes('/kline')).map((u) => new URL(u).host);

    it('prefers api.bybit.com when it answers', async () => {
        const calls = stubHosts(() => true);
        await new BybitProvider().getBars('BTCUSDT.P', '1h', { limit: 1 });
        expect(klineHosts(calls)).toEqual(['api.bybit.com']);
    });

    it('falls back to the Netherlands endpoint when the global hosts are blocked', async () => {
        const calls = stubHosts((h) => h === 'api.bybit.nl');
        const bars = await new BybitProvider().getBars('BTCUSDT.P', '1h', { limit: 1 });
        expect(klineHosts(calls)).toEqual(['api.bybit.nl']);
        expect(bars).toHaveLength(1);
    });

    it('asks every host once, however many requests start together', async () => {
        const calls = stubHosts((h) => h === 'api.bybit.nl');
        const p = new BybitProvider();
        await Promise.all([p.getBars('BTCUSDT.P', '1h', { limit: 1 }), p.getBars('ETHUSDT.P', '1h', { limit: 1 }), p.getBars('SOLUSDT.P', '1h', { limit: 1 })]);
        expect(calls.filter((u) => u.includes('/v5/market/time'))).toHaveLength(3); // one ping per host, not per request
    });
});

describe('BybitProvider.listSymbols / getSymbolInfo (stubbed fetch)', () => {
    afterEach(() => vi.unstubAllGlobals());

    const instrument = (symbol: string, base: string, quote: string, extra: object = {}) => ({ symbol, baseCoin: base, quoteCoin: quote, status: 'Trading', priceFilter: { tickSize: '0.01' }, ...extra });

    it('lists trading spot pairs plain and perpetual contracts with .P, leaving dated futures and halted markets out', async () => {
        vi.stubGlobal('fetch', vi.fn((input: string | URL) => {
            const url = new URL(input.toString());
            if (url.pathname === '/v5/market/time') return Promise.resolve(res({ retCode: 0 }));
            const category = url.searchParams.get('category');
            if (category === 'spot') return Promise.resolve(ok([instrument('BTCUSDT', 'BTC', 'USDT'), instrument('OLDUSDT', 'OLD', 'USDT', { status: 'Closed' })]));
            return Promise.resolve(
                ok([
                    instrument('BTCUSDT', 'BTC', 'USDT', { contractType: 'LinearPerpetual' }),
                    instrument('BTCUSDT-27MAR26', 'BTC', 'USDT', { contractType: 'LinearFutures' }),
                    instrument('HALTUSDT', 'HALT', 'USDT', { contractType: 'LinearPerpetual', status: 'Settling' }),
                ]),
            );
        }));
        const list = await new BybitProvider().listSymbols();
        expect(list).toEqual([
            { ticker: 'BTCUSDT', description: 'BTC / USDT', type: 'crypto' },
            { ticker: 'BTCUSDT.P', description: 'BTC / USDT Perpetual', type: 'futures' },
        ]);
    });

    it('follows the page cursor until the list is complete', async () => {
        const cursors: Array<string | null> = [];
        vi.stubGlobal('fetch', vi.fn((input: string | URL) => {
            const url = new URL(input.toString());
            if (url.pathname === '/v5/market/time') return Promise.resolve(res({ retCode: 0 }));
            if (url.searchParams.get('category') === 'spot') return Promise.resolve(ok([]));
            const cursor = url.searchParams.get('cursor');
            cursors.push(cursor);
            return Promise.resolve(
                cursor === null
                    ? ok([instrument('AUSDT', 'A', 'USDT', { contractType: 'LinearPerpetual' })], { nextPageCursor: 'page2' })
                    : ok([instrument('BUSDT', 'B', 'USDT', { contractType: 'LinearPerpetual' })], { nextPageCursor: '' }),
            );
        }));
        const list = await new BybitProvider().listSymbols();
        expect(list.map((s) => s.ticker)).toEqual(['AUSDT.P', 'BUSDT.P']);
        expect(cursors).toEqual([null, 'page2']);
    });

    it('still lists what it can when one market type fails', async () => {
        vi.stubGlobal('fetch', vi.fn((input: string | URL) => {
            const url = new URL(input.toString());
            if (url.pathname === '/v5/market/time') return Promise.resolve(res({ retCode: 0 }));
            if (url.searchParams.get('category') === 'spot') return Promise.reject(new TypeError('blocked'));
            return Promise.resolve(ok([instrument('BTCUSDT', 'BTC', 'USDT', { contractType: 'LinearPerpetual' })]));
        }));
        expect((await new BybitProvider().listSymbols()).map((s) => s.ticker)).toEqual(['BTCUSDT.P']);
    });

    it('gives tick size and names for one symbol, and nothing for an unknown one', async () => {
        vi.stubGlobal('fetch', vi.fn((input: string | URL) => {
            const url = new URL(input.toString());
            if (url.pathname === '/v5/market/time') return Promise.resolve(res({ retCode: 0 }));
            return Promise.resolve(url.searchParams.get('symbol') === 'BTCUSDT' ? ok([instrument('BTCUSDT', 'BTC', 'USDT', { contractType: 'LinearPerpetual', priceFilter: { tickSize: '0.1' } })]) : ok([]));
        }));
        const p = new BybitProvider();
        expect(await p.getSymbolInfo('BTCUSDT.P')).toMatchObject({ ticker: 'BTCUSDT.P', tickerid: 'BYBIT:BTCUSDT.P', prefix: 'BYBIT', description: 'BTC / USDT Perpetual', type: 'futures', mintick: 0.1, pricescale: 10, session: '24x7' });
        expect(await p.getSymbolInfo('NOPEUSDT.P')).toBeUndefined();
    });

    it('describes itself, and points icons at the base asset', () => {
        const p = new BybitProvider();
        expect(p.info()).toMatchObject({ name: 'bybit', displayName: 'Bybit', requiresApiKey: false, capabilities: { enumerate: true, stream: true, symbolInfo: true } });
        expect(p.resolveSymbolIcon({ ticker: 'BTCUSDT.P', description: 'BTC / USDT Perpetual' })).toBe('https://crypto-icons.ledger.com/BTC.png');
    });
});

/** Minimal scriptable WebSocket double. */
function makeFakeWS() {
    class FakeWS {
        static instances: FakeWS[] = [];
        url: string;
        sent: string[] = [];
        readyState = 0;
        onopen: (() => void) | null = null;
        onmessage: ((ev: { data: string }) => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(url: string) {
            this.url = url;
            FakeWS.instances.push(this);
        }
        send(d: string): void {
            this.sent.push(d);
        }
        close(): void {
            this.readyState = 3;
            this.onclose?.();
        }
        _open(): void {
            this.readyState = 1;
            this.onopen?.();
        }
        _msg(obj: unknown): void {
            this.onmessage?.({ data: JSON.stringify(obj) });
        }
    }
    return FakeWS;
}

describe('BybitProvider.subscribe', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    const pingOk = (blocked: (host: string) => boolean = () => false): void =>
        void vi.stubGlobal('fetch', vi.fn((input: string | URL) => {
            const url = input.toString();
            if (blocked(new URL(url).host)) return Promise.reject(new TypeError('blocked'));
            return Promise.resolve(res({ retCode: 0 }));
        }));

    it('subscribes to the kline topic on the perpetual socket and delivers each candle', async () => {
        const FakeWS = makeFakeWS();
        vi.stubGlobal('WebSocket', FakeWS);
        pingOk();
        const bars: OHLCV[] = [];
        const unsub = new BybitProvider().subscribe('BTCUSDT.P', '1h', (b) => bars.push(b));
        await vi.waitFor(() => expect(FakeWS.instances.length).toBe(1));
        const ws = FakeWS.instances[0]!;
        expect(ws.url).toBe('wss://stream.bybit.com/v5/public/linear');
        ws._open();
        expect(JSON.parse(ws.sent[0]!)).toEqual({ op: 'subscribe', args: ['kline.60.BTCUSDT'] });
        ws._msg({ success: true, op: 'subscribe' }); // the ack is not a candle
        expect(bars).toEqual([]);
        ws._msg({ topic: 'kline.60.BTCUSDT', data: [{ start: HOUR, open: '10', high: '12', low: '9', close: '11', volume: '5', confirm: false }] });
        expect(bars).toEqual([{ time: HOUR, open: 10, high: 12, low: 9, close: 11, volume: 5 }]);
        unsub();
        expect(ws.readyState).toBe(3);
    });

    it('uses the spot socket for a plain ticker, and the socket host that matches the reachable REST host', async () => {
        const FakeWS = makeFakeWS();
        vi.stubGlobal('WebSocket', FakeWS);
        pingOk((h) => h !== 'api.bybit.nl');
        const unsub = new BybitProvider().subscribe('ETHUSDT', '15', () => {});
        await vi.waitFor(() => expect(FakeWS.instances.length).toBe(1));
        expect(FakeWS.instances[0]!.url).toBe('wss://stream.bybit.nl/v5/public/spot');
        unsub();
    });

    it('keeps the connection alive with Bybit\'s own heartbeat', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
        const FakeWS = makeFakeWS();
        vi.stubGlobal('WebSocket', FakeWS);
        pingOk();
        const unsub = new BybitProvider().subscribe('BTCUSDT.P', '1h', () => {});
        await vi.waitFor(() => expect(FakeWS.instances.length).toBe(1));
        const ws = FakeWS.instances[0]!;
        ws._open();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(ws.sent.map((s) => JSON.parse(s).op)).toContain('ping');
        unsub();
    });

    it('polls instead when the timeframe has no native stream (45m)', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const FakeWS = makeFakeWS();
        vi.stubGlobal('WebSocket', FakeWS);
        let klines = 0;
        vi.stubGlobal('fetch', vi.fn((input: string | URL) => {
            const url = input.toString();
            if (url.includes('/v5/market/time')) return Promise.resolve(res({ retCode: 0 }));
            if (url.includes('/kline')) {
                klines += 1;
                return Promise.resolve(ok([row(HOUR)]));
            }
            return Promise.resolve(res({}, false, 404));
        }));
        const unsub = new BybitProvider().subscribe('BTCUSDT.P', '45', () => {});
        await vi.advanceTimersByTimeAsync(3100);
        expect(FakeWS.instances).toHaveLength(0);
        expect(klines).toBeGreaterThan(0);
        unsub();
    });
});
