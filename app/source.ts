// Which market-data source to start on. Some networks block exchanges (Indonesian ISPs
// intercept Binance and Coinbase, for one), and a chart with no data is useless, so the
// app checks which source it can reach before it boots. Pure apart from the injected fetch.
import type { ChartLang } from './embed';

export type SourceId = 'binance' | 'hyperliquid' | 'coinbase';

export interface Source {
    id: SourceId;
    /** A pinned symbol (`provider:ticker`) that provider serves. */
    symbol: string;
    /**
     * A host the source needs; only its reachability matters, not the status. Hyperliquid's API host
     * answers a plain GET with 405 (every endpoint is POST + JSON, which no-cors cannot send); that is
     * fine, because the fetch still settles. Browsers log the 405 in the console; it is expected.
     */
    probe: string;
}

/** The preferred source, and what the chart opens on when we cannot tell which one works. */
export const DEFAULT_SOURCE: Source = { id: 'binance', symbol: 'binance:BTCUSDT', probe: 'https://api.binance.com/api/v3/ping' };

/** In order of preference. */
export const SOURCES: readonly Source[] = [
    DEFAULT_SOURCE,
    { id: 'hyperliquid', symbol: 'hyperliquid:BTC', probe: 'https://api.hyperliquid.xyz/info' },
    { id: 'coinbase', symbol: 'coinbase:BTC-USD', probe: 'https://api.exchange.coinbase.com/time' },
];

export type Reachability = Record<SourceId, boolean>;

export function pickSource(reachable: Reachability): Source | null {
    return SOURCES.find((s) => reachable[s.id]) ?? null;
}

type FetchLike = (url: string, init: { mode: 'no-cors'; signal: AbortSignal }) => Promise<unknown>;

/**
 * Probes every source at once. `no-cors` makes the request independent of the host's CORS
 * policy: it settles when the host answers over a valid TLS connection and rejects when the
 * network blocks or intercepts it. A source that has not answered after `timeoutMs` counts as
 * unreachable.
 */
export async function probeSources(fetchFn: FetchLike = fetch as FetchLike, timeoutMs = 3000): Promise<Reachability> {
    const results = await Promise.all(
        SOURCES.map(async (s) => {
            const abort = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeout = new Promise<boolean>((resolve) => {
                timer = setTimeout(() => {
                    abort.abort();
                    resolve(false);
                }, timeoutMs);
            });
            const answer = fetchFn(s.probe, { mode: 'no-cors', signal: abort.signal }).then(
                () => true,
                () => false,
            );
            const ok = await Promise.race([answer, timeout]);
            clearTimeout(timer);
            return [s.id, ok] as const;
        }),
    );
    return Object.fromEntries(results) as Reachability;
}

export function blockedNotice(lang: ChartLang): string {
    return lang === 'id'
        ? 'Data pasar tidak bisa dijangkau dari jaringan ini (mungkin diblokir oleh provider internet atau wilayah). Coba pakai VPN atau jaringan lain.'
        : 'Market data cannot be reached from this network (it may be blocked by your internet provider or region). Try a VPN or another network.';
}
