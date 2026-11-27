import { describe, expect, it } from 'vitest';
import { WATCHLIST_PANEL, buildWorkspaceOptions, takeWatchlistDefault } from '../app/config';
import type { EmbedParams } from '../app/embed';
import { SOURCES } from '../app/source';

const embedded: EmbedParams = { theme: 'light', lang: 'id', embedded: true };

describe('buildWorkspaceOptions', () => {
    it('is the multi-chart workspace in the requested theme and language, with live data', () => {
        const o = buildWorkspaceOptions(embedded);
        // `false` would pin it to one chart and hide the layout picker; a layout id keeps the grid available.
        expect(o.layout).toBe('1');
        expect(o.theme).toBe('light');
        expect(o.locale).toBe('id');
        expect(o.live).toBe(true);
    });

    it('registers all three data sources, so the picker can search any of them', () => {
        expect(Object.keys(buildWorkspaceOptions(embedded).providers ?? {})).toEqual(['binance', 'hyperliquid', 'coinbase']);
    });

    it('opens on the symbol of the source it was told to use, Binance by default', () => {
        expect(buildWorkspaceOptions(embedded).symbol).toBe('binance:BTCUSDT');
        expect(buildWorkspaceOptions(embedded, SOURCES[1]).symbol).toBe('hyperliquid:BTC');
        expect(buildWorkspaceOptions(embedded, SOURCES[2]).symbol).toBe('coinbase:BTC-USD');
    });

    it('persists under its own storage key, not the playground one', () => {
        expect(buildWorkspaceOptions(embedded).persist).toBe('chartlab');
    });

    it('only grabs focus when it is the whole page, never inside the landing iframe', () => {
        expect(buildWorkspaceOptions({ ...embedded, embedded: true }).autofocus).toBe(false);
        expect(buildWorkspaceOptions({ ...embedded, embedded: false }).autofocus).toBe(true);
    });

    it('never switches the Vela attribution off (the NOTICE requires it)', () => {
        const o = buildWorkspaceOptions(embedded) as Record<string, unknown>;
        expect('attribution' in o).toBe(false);
        expect(JSON.stringify(o)).not.toMatch(/attribution/i);
    });

    it('does not ship the playground demo scripting engine', () => {
        const o = buildWorkspaceOptions(embedded);
        expect(o.engines).toBeUndefined();
    });
});

describe('buildWorkspaceOptions defaults', () => {
    it('offers the 5m to 1M timeframes as quick-switch chips', () => {
        expect(buildWorkspaceOptions(embedded).timeframeFavorites).toEqual(['5', '15', '30', '60', '240', 'D', 'W', 'M']);
    });

    it('keeps the panel shortcuts in a toolbar on the right edge', () => {
        expect(buildWorkspaceOptions(embedded).sidebar).toBe(true);
    });

    it('opens the watchlist only when asked to', () => {
        expect(buildWorkspaceOptions(embedded).openPanel).toBeUndefined();
        expect(buildWorkspaceOptions(embedded, undefined, { openWatchlist: true }).openPanel).toBe(WATCHLIST_PANEL);
        expect(WATCHLIST_PANEL).toBe('vela.watchlist');
    });
});

describe('takeWatchlistDefault', () => {
    const memory = (): Pick<Storage, 'getItem' | 'setItem'> => {
        const m = new Map<string, string>();
        return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
    };

    it('says yes once on a wide screen, then leaves the choice to the saved dock', () => {
        const store = memory();
        expect(takeWatchlistDefault(store, true)).toBe(true);
        expect(takeWatchlistDefault(store, true)).toBe(false);
    });

    it('says no on a narrow screen and keeps its one chance for a wide one', () => {
        const store = memory();
        expect(takeWatchlistDefault(store, false)).toBe(false);
        expect(takeWatchlistDefault(store, true)).toBe(true);
    });

    it('still says yes when storage is blocked, since nothing can be remembered', () => {
        const blocked = {
            getItem: () => {
                throw new Error('blocked');
            },
            setItem: () => {
                throw new Error('blocked');
            },
        };
        expect(takeWatchlistDefault(blocked, true)).toBe(true);
    });
});
