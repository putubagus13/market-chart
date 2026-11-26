// The ChartLab workspace: one chart with bar replay, watchlist and the trade simulator
// (all built into VelaWorkspace), on live data from whichever source is reachable. Pure: it only builds the options.
import type { VelaWorkspaceOptions } from '../src/workspace';
import { BinanceProvider } from '../src/data/providers/binance';
import { CoinbaseProvider } from '../src/data/providers/coinbase';
import { HyperliquidProvider } from '../src/data/providers/hyperliquid';
import type { EmbedParams } from './embed';
import { DEFAULT_SOURCE, type Source } from './source';

export function buildWorkspaceOptions(p: EmbedParams, source: Source = DEFAULT_SOURCE): VelaWorkspaceOptions {
    return {
        layout: false, // a single chart
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
