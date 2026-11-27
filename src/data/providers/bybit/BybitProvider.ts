import type { OHLCV } from '../../../core/model/ohlcv';
import type { BarRange, SymbolInfo } from '../../../core/ports/MarketDataFeed';
import type { DataProvider, ProviderInfo, SymbolDescriptor } from '../../../core/ports/DataProvider';
import { baseOf, ledgerCryptoIconUrl } from '../../symbol-base';
import type { Unsubscribe } from '../../../core/util/types';

/**
 * Bybit's public hosts, in order of preference. All three are Bybit's own and serve the same markets: the global
 * host, its alias, and the Netherlands host, which stays reachable on networks that block the first two. Each REST
 * host has a matching WebSocket host.
 */
const ENDPOINTS = [
    { rest: 'https://api.bybit.com', ws: 'wss://stream.bybit.com' },
    { rest: 'https://api.bytick.com', ws: 'wss://stream.bytick.com' },
    { rest: 'https://api.bybit.nl', ws: 'wss://stream.bybit.nl' },
] as const;
type Endpoint = (typeof ENDPOINTS)[number];

/** Bybit's kline rows come back NEWEST first and this many at most per request. */
const KLINE_PAGE = 1000;
/** Bybit closes a public socket that stays silent; its own heartbeat is an application-level ping every 20 s. */
const HEARTBEAT_MS = 20_000;
/**
 * If a socket opens but delivers no candle within this window, treat it as non-delivering and poll instead. Generous
 * enough not to mis-fire on an illiquid symbol (which degrades to polling harmlessly).
 */
const STREAM_STALL_MS = 30_000;
/** Reconnect backoff after an unexpected socket close. */
const STREAM_RECONNECT_MS = 2_000;

/** Market type in Bybit's v5 API: spot pairs, and USDT/USDC-margined linear contracts (perpetuals here). */
type Category = 'spot' | 'linear';

/** One raw Bybit kline row: `[startTime, open, high, low, close, volume, turnover]`, all strings. */
type RawRow = string[];

/** Canonical timeframe → Bybit interval (native, no aggregation). */
const TF_TO_INTERVAL: Record<string, string> = {
    '1': '1', '3': '3', '5': '5', '15': '15', '30': '30',
    '60': '60', '120': '120', '240': '240', '360': '360', '720': '720',
    D: 'D', W: 'W', M: 'M',
};

/** User-facing timeframe aliases → canonical keys (matches the other Vela layers). */
const TF_NORMALIZE: Record<string, string> = {
    '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '45m': '45',
    '1h': '60', '2h': '120', '3h': '180', '4h': '240', '6h': '360', '8h': '480', '12h': '720',
    '1d': 'D', '1w': 'W', '1mo': 'M', '1D': 'D', '1W': 'W', '4H': '240',
    D: 'D', W: 'W', M: 'M',
};

/** Native intraday timeframes in minutes (the aggregation sub-candle candidates). */
const NATIVE_MINUTES = [1, 3, 5, 15, 30, 60, 120, 240, 360, 720];
const SUPPORTED_TIMEFRAMES = ['1', '3', '5', '15', '30', '45', '60', '120', '180', '240', '360', '480', '720', 'D', 'W', 'M'];

/** Normalize a user timeframe to a canonical key. */
export function normalizeTf(tf: string): string {
    return TF_NORMALIZE[tf] ?? TF_NORMALIZE[tf.toLowerCase()] ?? tf;
}

/** Split a Vela ticker into the Bybit API symbol and its market: `.P` = perpetual (linear), else spot. */
export function parseTicker(ticker: string): { apiSymbol: string; category: Category } {
    const t = ticker.trim().toUpperCase();
    if (t.endsWith('.P')) return { apiSymbol: t.slice(0, -2), category: 'linear' };
    return { apiSymbol: t, category: 'spot' };
}

/** Map raw Bybit kline rows (newest first) to neutral OHLCV, oldest first. */
export function rowsToOHLCV(rows: RawRow[]): OHLCV[] {
    return rows
        .map((k) => ({ time: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) }))
        .sort((a, b) => a.time - b.time);
}

/** The kline payload of a Bybit `kline.<interval>.<symbol>` stream message. */
interface KlineEvent {
    start: number | string; // open time (ms)
    open: string | number;
    high: string | number;
    low: string | number;
    close: string | number;
    volume: string | number;
    confirm?: boolean;
}

/** Map a stream kline payload to neutral OHLCV. */
export function klineEventToOHLCV(k: KlineEvent): OHLCV {
    return { time: Number(k.start), open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close), volume: Number(k.volume) };
}

/** Sort by open-time and drop duplicate open-times (incoming wins) — the bar contract. */
function dedupeSorted(bars: OHLCV[]): OHLCV[] {
    const byTime = new Map<number, OHLCV>();
    for (const b of bars) byTime.set(b.time, b);
    return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Aggregate ascending sub-candles into `bucketMs` buckets aligned to the epoch. */
function aggregate(sub: OHLCV[], bucketMs: number): OHLCV[] {
    const buckets = new Map<number, OHLCV>();
    for (const b of sub) {
        const key = Math.floor(b.time / bucketMs) * bucketMs;
        const cur = buckets.get(key);
        if (!cur) buckets.set(key, { time: key, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 });
        else {
            cur.high = Math.max(cur.high, b.high);
            cur.low = Math.min(cur.low, b.low);
            cur.close = b.close;
            cur.volume = (cur.volume ?? 0) + (b.volume ?? 0);
        }
    }
    return [...buckets.values()].sort((a, b) => a.time - b.time);
}

/** Largest native sub-timeframe (minutes) that evenly divides `targetMin`, or null. */
function selectSubTf(targetMin: number): number | null {
    return NATIVE_MINUTES.filter((m) => m < targetMin && targetMin % m === 0).sort((a, b) => b - a)[0] ?? null;
}

/**
 * Bybit market-data provider, built on the public v5 REST + WebSocket APIs (no key). Serves spot pairs
 * (`BTCUSDT`) and linear perpetual contracts (`BTCUSDT.P`, the same `.P` convention as the Binance provider),
 * pages past the 1000-row cap, aggregates timeframes Bybit does not serve (e.g. `45`, `180`), streams candles over a
 * WebSocket (polling when a timeframe has no native stream), and picks whichever of Bybit's three hosts is reachable.
 *
 *   import { BybitProvider } from 'vela/providers/bybit';
 *   chart.data.registerProvider('bybit', new BybitProvider());
 */
export class BybitProvider implements DataProvider {
    /** The host confirmed reachable (cached after the first probe). */
    private endpointCache: Endpoint | null = null;
    /** The in-flight probe, shared so concurrent first calls do not each ping. */
    private endpointProbe: Promise<Endpoint> | null = null;
    private symbolsPromise: Promise<SymbolDescriptor[]> | null = null;

    info(): ProviderInfo {
        return {
            name: 'bybit',
            displayName: 'Bybit',
            requiresApiKey: false,
            supportedTimeframes: SUPPORTED_TIMEFRAMES,
            capabilities: { enumerate: true, stream: true, symbolInfo: true },
        };
    }

    async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
        try {
            const { apiSymbol, category } = parseTicker(ticker);
            const { rest } = await this.endpoint();
            const tf = normalizeTf(timeframe);

            const native = TF_TO_INTERVAL[tf];
            if (native) return dedupeSorted(rowsToOHLCV(await this.fetchRows(rest, category, apiSymbol, native, range)));

            // Aggregation path: fetch a native sub-timeframe and combine.
            const targetMin = /^\d+$/.test(tf) ? parseInt(tf, 10) : null;
            const subMin = targetMin != null ? selectSubTf(targetMin) : null;
            if (targetMin == null || subMin == null) {
                console.warn(`[vela] Bybit: timeframe "${timeframe}" is not supported and cannot be aggregated.`);
                return [];
            }
            const ratio = targetMin / subMin;
            const subRange: BarRange = { ...range, limit: range.limit != null ? range.limit * ratio + ratio : undefined };
            const sub = rowsToOHLCV(await this.fetchRows(rest, category, apiSymbol, String(subMin), subRange));
            const agg = aggregate(sub, targetMin * 60_000);
            return range.limit != null && agg.length > range.limit ? agg.slice(-range.limit) : agg;
        } catch (e) {
            // Fail soft: an empty result parks/empties the chart with a warning rather than rejecting the load.
            console.warn(`[vela] Bybit: failed to fetch ${ticker} ${timeframe} — ${e instanceof Error ? e.message : String(e)}`);
            return [];
        }
    }

    async getSymbolInfo(ticker: string): Promise<SymbolInfo | undefined> {
        const { apiSymbol, category } = parseTicker(ticker);
        const result = await this.get(`/v5/market/instruments-info`, { category, symbol: apiSymbol }).catch(() => null);
        const s = (result?.list as BybitInstrument[] | undefined)?.[0];
        if (!s) return undefined;
        const tickSize = parseFloat(s.priceFilter?.tickSize ?? '0.01') || 0.01;
        const perp = category === 'linear';
        return {
            ticker, // keep the original, incl. any .P
            tickerid: `BYBIT:${ticker}`,
            prefix: 'BYBIT',
            description: `${s.baseCoin} / ${s.quoteCoin}${perp ? ' Perpetual' : ''}`,
            type: perp ? 'futures' : 'crypto',
            basecurrency: s.baseCoin,
            currency: s.quoteCoin,
            mintick: tickSize,
            pricescale: Math.round(1 / tickSize),
            timezone: 'Etc/UTC',
            session: '24x7',
        };
    }

    listSymbols(): Promise<SymbolDescriptor[]> {
        if (!this.symbolsPromise) {
            this.symbolsPromise = Promise.all([
                this.listCategory('spot').catch(() => [] as SymbolDescriptor[]),
                this.listCategory('linear').catch(() => [] as SymbolDescriptor[]),
            ]).then(([spot, perps]) => [...spot, ...perps]);
        }
        return this.symbolsPromise;
    }

    /** Where the base asset's icon lives: the Ledger crypto-icon CDN, keyed by the base asset. */
    resolveSymbolIcon(symbol: SymbolDescriptor): string | undefined {
        return ledgerCryptoIconUrl(baseOf(symbol));
    }

    subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): Unsubscribe {
        const { apiSymbol, category } = parseTicker(ticker);
        const interval = TF_TO_INTERVAL[normalizeTf(timeframe)];
        // A native interval and a WebSocket implementation: true streaming. Otherwise poll getBars.
        if (interval && typeof WebSocket !== 'undefined') return this.streamKlines(ticker, timeframe, apiSymbol, category, interval, onBar);
        return this.pollBars(ticker, timeframe, onBar);
    }

    // ── internals ────────────────────────────────────────────────────────

    /**
     * Open a Bybit kline WebSocket: connect, send the subscribe frame, then keep the socket alive with Bybit's own
     * ping. Reconnects on an unexpected close until unsubscribed. A stall watchdog falls back to polling when the
     * socket opens but never delivers a candle, so a silent stream still yields live updates.
     */
    private streamKlines(ticker: string, timeframe: string, apiSymbol: string, category: Category, interval: string, onBar: (bar: OHLCV) => void): Unsubscribe {
        let closed = false;
        let ws: WebSocket | null = null;
        let reconnect: ReturnType<typeof setTimeout> | null = null;
        let stall: ReturnType<typeof setTimeout> | null = null;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        let polling: Unsubscribe | null = null;
        const topic = `kline.${interval}.${apiSymbol}`;

        const clearStall = (): void => {
            if (stall) clearTimeout(stall);
            stall = null;
        };
        const stopHeartbeat = (): void => {
            if (heartbeat) clearInterval(heartbeat);
            heartbeat = null;
        };
        const fallToPolling = (): void => {
            if (closed || polling) return;
            clearStall();
            stopHeartbeat();
            if (reconnect) clearTimeout(reconnect);
            reconnect = null;
            try {
                ws?.close();
            } catch {
                /* ignore */
            }
            ws = null;
            console.warn(`[vela] Bybit: ${ticker} ${timeframe} stream delivered no data; falling back to polling.`);
            polling = this.pollBars(ticker, timeframe, onBar);
        };

        const open = async (): Promise<void> => {
            if (closed) return;
            const { ws: host } = await this.endpoint();
            if (closed) return; // unsubscribed during the host probe
            const socket = new WebSocket(`${host}/v5/public/${category}`);
            ws = socket;
            stall = setTimeout(fallToPolling, STREAM_STALL_MS);
            socket.onopen = () => {
                socket.send(JSON.stringify({ op: 'subscribe', args: [topic] }));
                stopHeartbeat();
                heartbeat = setInterval(() => {
                    try {
                        socket.send(JSON.stringify({ op: 'ping' }));
                    } catch {
                        /* the close handler reconnects */
                    }
                }, HEARTBEAT_MS);
            };
            socket.onmessage = (ev: MessageEvent) => {
                if (closed || polling) return;
                try {
                    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as { topic?: string; data?: KlineEvent[] };
                    if (msg.topic === topic && Array.isArray(msg.data)) {
                        clearStall();
                        for (const k of msg.data) onBar(klineEventToOHLCV(k));
                    }
                } catch {
                    /* ignore non-JSON / control frames (subscribe ack, pong) */
                }
            };
            socket.onclose = () => {
                stopHeartbeat();
                if (!closed && !polling) reconnect = setTimeout(() => void open(), STREAM_RECONNECT_MS);
            };
            socket.onerror = () => {
                try {
                    socket.close();
                } catch {
                    /* already closed → onclose reconnects */
                }
            };
        };
        void open();

        return () => {
            closed = true;
            clearStall();
            stopHeartbeat();
            if (reconnect) clearTimeout(reconnect);
            polling?.();
            try {
                ws?.close();
            } catch {
                /* ignore */
            }
        };
    }

    /** Poll the forming candle (timeframes Bybit has no native kline stream for). */
    private pollBars(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): Unsubscribe {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const poll = async (): Promise<void> => {
            if (stopped) return;
            try {
                for (const b of await this.getBars(ticker, timeframe, { limit: 2 })) onBar(b);
            } catch {
                /* transient — keep polling */
            }
            if (!stopped) timer = setTimeout(() => void poll(), 3000);
        };
        timer = setTimeout(() => void poll(), 3000);
        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
        };
    }

    /** The instruments of one market type, following Bybit's page cursor; spot pairs plain, perpetuals with `.P`. */
    private async listCategory(category: Category): Promise<SymbolDescriptor[]> {
        const rows: BybitInstrument[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
            const result = await this.get('/v5/market/instruments-info', { category, limit: '1000', ...(cursor ? { cursor } : {}) });
            rows.push(...((result.list as BybitInstrument[] | undefined) ?? []));
            cursor = (result.nextPageCursor as string | undefined) || undefined;
            if (!cursor) break;
        }
        const trading = rows.filter((s) => s.status === 'Trading');
        if (category === 'spot') return trading.map((s) => ({ ticker: s.symbol, description: `${s.baseCoin} / ${s.quoteCoin}`, type: 'crypto' }));
        // dated futures (`LinearFutures`) are left out: this provider serves perpetuals
        return trading.filter((s) => s.contractType === 'LinearPerpetual').map((s) => ({ ticker: `${s.symbol}.P`, description: `${s.baseCoin} / ${s.quoteCoin} Perpetual`, type: 'futures' }));
    }

    /** Fetch kline rows, paging backward from `range.to` past Bybit's 1000-row cap. */
    private async fetchRows(base: string, category: Category, symbol: string, interval: string, range: BarRange): Promise<RawRow[]> {
        // With a `from` the whole window is wanted (then cut to `limit` oldest-first); otherwise the newest `limit` bars.
        const windowed = range.from != null;
        let remaining = windowed ? Infinity : (range.limit ?? 500);
        const out: RawRow[] = [];
        let end = range.to;
        for (let guard = 0; remaining > 0 && guard < 60; guard++) {
            const size = Math.min(remaining, KLINE_PAGE);
            const result = await this.get('/v5/market/kline', {
                category,
                symbol,
                interval,
                limit: String(size),
                ...(range.from != null ? { start: String(range.from) } : {}),
                ...(end != null ? { end: String(end) } : {}),
            }, base);
            const chunk = (result.list as RawRow[] | undefined) ?? [];
            if (chunk.length === 0) break;
            out.push(...chunk);
            remaining -= chunk.length;
            const oldest = Number(chunk[chunk.length - 1]![0]);
            end = oldest - 1;
            if (chunk.length < size) break;
            if (range.from != null && oldest <= range.from) break;
        }
        if (windowed && range.limit != null) return rowsToOHLCV(out).slice(0, range.limit).map(toRow);
        return out;
    }

    /** A v5 GET: the `result` object, or an error for a failed HTTP request or a non-zero `retCode`. */
    private async get(path: string, params: Record<string, string>, base?: string): Promise<Record<string, unknown>> {
        const url = new URL(`${base ?? (await this.endpoint()).rest}${path}`);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
        const res = await fetch(url.toString());
        if (!res.ok) throw new Error(`Bybit HTTP ${res.status} for ${url.pathname}`);
        const body = (await res.json()) as { retCode?: number; retMsg?: string; result?: Record<string, unknown> };
        if (body.retCode !== 0) throw new Error(`Bybit error ${body.retCode}: ${body.retMsg ?? ''}`.trim());
        return body.result ?? {};
    }

    /**
     * Resolve the reachable host: every host is pinged at once and the first in preference order that answers wins,
     * so a blocked or hanging preferred host costs at most its own timeout. The in-flight probe is shared, so a burst
     * of concurrent first calls issues ONE set of pings. A confirmed host is cached; a total failure clears the probe
     * so a later call can retry.
     */
    private endpoint(): Promise<Endpoint> {
        if (this.endpointCache) return Promise.resolve(this.endpointCache);
        if (!this.endpointProbe) {
            const ping = async (e: Endpoint): Promise<boolean> => {
                try {
                    return (await fetch(`${e.rest}/v5/market/time`, { signal: AbortSignal.timeout(5000) })).ok;
                } catch {
                    return false; // unreachable: the next host in order may do
                }
            };
            this.endpointProbe = (async () => {
                try {
                    const pings = ENDPOINTS.map(ping);
                    for (const [i, answered] of pings.entries()) if (await answered) return (this.endpointCache = ENDPOINTS[i]!);
                    return ENDPOINTS[0]; // give up; let the actual request surface the error
                } finally {
                    this.endpointProbe = null; // allow a fresh probe later if no host was cached
                }
            })();
        }
        return this.endpointProbe;
    }
}

/** Back to a raw row: only used to cut a windowed fetch to its `limit`, then mapped to OHLCV again. */
function toRow(b: OHLCV): RawRow {
    return [String(b.time), String(b.open), String(b.high), String(b.low), String(b.close), String(b.volume ?? 0), '0'];
}

/** The subset of a Bybit `instruments-info` entry this provider reads. */
interface BybitInstrument {
    symbol: string;
    status?: string;
    baseCoin: string;
    quoteCoin: string;
    contractType?: string;
    priceFilter?: { tickSize?: string };
}
