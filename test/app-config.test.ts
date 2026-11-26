import { describe, expect, it } from 'vitest';
import { buildWorkspaceOptions } from '../app/config';
import type { EmbedParams } from '../app/embed';
import { SOURCES } from '../app/source';

const embedded: EmbedParams = { theme: 'light', lang: 'id', embedded: true };

describe('buildWorkspaceOptions', () => {
    it('is one chart in the requested theme and language, with live data', () => {
        const o = buildWorkspaceOptions(embedded);
        expect(o.layout).toBe(false);
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
