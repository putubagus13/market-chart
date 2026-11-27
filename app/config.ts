// The ChartLab workspace: a grid of charts (it opens on one; the layout picker offers 2, 4, 8 and more) with bar
// replay, a watchlist and the trade simulator (all built into VelaWorkspace), on live data from whichever source is
// reachable. Pure: it only builds the options.
import type { VelaWorkspaceOptions } from '../src/workspace';
import { BinanceProvider } from '../src/data/providers/binance';
import { CoinbaseProvider } from '../src/data/providers/coinbase';
import { HyperliquidProvider } from '../src/data/providers/hyperliquid';
import type { EmbedParams } from './embed';
import { DEFAULT_SOURCE, type Source } from './source';

/** The watchlist's id in the side-panel dock. */
export const WATCHLIST_PANEL = 'vela.watchlist';

/** The quick-switch timeframe chips: 5m, 15m, 30m, 1h, 4h, 1D, 1W, 1M (chart timeframe values). */
export const TIMEFRAME_FAVORITES = ['5', '15', '30', '60', '240', 'D', 'W', 'M'];

const WATCHLIST_SEEN_KEY = 'chartlab.watchlist-seen';

/**
 * Whether to open the watchlist on this boot: once per browser, on a screen wide enough for a side column.
 * After that the dock remembers what the visitor chose (open or closed), so the default never fights them.
 * When storage is blocked nothing can be remembered, so the answer stays yes.
 */
export function takeWatchlistDefault(store: Pick<Storage, 'getItem' | 'setItem'>, wide: boolean): boolean {
    if (!wide) return false;
    try {
        if (store.getItem(WATCHLIST_SEEN_KEY)) return false;
        store.setItem(WATCHLIST_SEEN_KEY, '1');
    } catch {
        /* blocked storage: show it, nothing to remember */
    }
    return true;
}

export function buildWorkspaceOptions(p: EmbedParams, source: Source = DEFAULT_SOURCE, extra: { openWatchlist?: boolean } = {}): VelaWorkspaceOptions {
    return {
        layout: '1', // starts on one chart; the layout picker (not hidden) offers the grids
        timeframeFavorites: TIMEFRAME_FAVORITES,
        sidebar: true, // the panel toggles (watchlist, objects, data window…) live on the right edge, not in the topbar
        ...(extra.openWatchlist ? { openPanel: WATCHLIST_PANEL } : {}),
        symbol: source.symbol, // the first source the network lets us reach (see source.ts)
        timeframe: '60',
        live: true,
        theme: p.theme,
        locale: p.lang,
        providers: {
            // All three are registered, so the symbol picker can search any of them; `source` only
            // decides which one the chart opens on.
            binance: () => new BinanceProvider(),
            hyperliquid: () => new HyperliquidProvider(),
            coinbase: () => new CoinbaseProvider(),
        },
        persist: 'chartlab', // its own localStorage key
        // Inside the landing's iframe the chart must not pull focus away from the host page.
        autofocus: !p.embedded,
        settings: { hidden: ['advanced'] },
    };
}
