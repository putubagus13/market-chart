// @vitest-environment jsdom
// Boot defaults a host can ship: `openPanel` (a side panel showing) and `timeframeFavorites` (the topbar's quick-switch chips).
import { describe, it, expect, beforeAll } from 'vitest';

// This jsdom build ships no `CSS` global; the style injector only needs `escape`.
(globalThis as { CSS?: unknown }).CSS ??= { escape: (v: string) => v };
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

import { VelaWorkspace } from '../src/workspace/VelaWorkspace';
import { encodeState } from '../src/workspace/persist';

beforeAll(() => {
    Element.prototype.animate ??= (() => ({ cancel() {}, finish() {}, addEventListener() {} })) as unknown as Element['animate'];
});

function mount(opts: Record<string, unknown> = {}): VelaWorkspace {
    const host = document.createElement('div');
    document.body.append(host);
    return new VelaWorkspace(host, { layout: '1', ...opts } as never);
}

const openId = (ws: VelaWorkspace): string | null => ws.context().panels.openId();

describe('openPanel', () => {
    it('opens the named panel at boot', () => {
        const ws = mount({ openPanel: 'objects' });
        expect(openId(ws)).toBe('objects');
        ws.destroy();
    });

    it('opens nothing without it', () => {
        const ws = mount();
        expect(openId(ws)).toBeNull();
        ws.destroy();
    });

    it('replaces the panel a saved document had open, and keeps the widths it recorded', () => {
        const stored = encodeState({ version: 1, layout: '1', panels: { open: 'dataWindow', widths: { objects: 333 } }, charts: [{ id: 'c1', symbol: 'BTCUSDT', timeframe: '60' }] } as never);
        const storage = { get: () => stored, set: () => {} };
        const ws = mount({ openPanel: 'objects', persist: 'k', storage });
        expect(openId(ws)).toBe('objects');
        expect((ws.getState().panels ?? {}).widths).toEqual({ objects: 333 });
        ws.destroy();
    });

    it('ignores a panel that does not exist, leaving the dock as it was', () => {
        const ws = mount({ openPanel: 'no-such-panel' });
        expect(openId(ws)).toBeNull();
        ws.destroy();
    });
});

describe('timeframeFavorites', () => {
    const doc = (extra: object): string => encodeState({ version: 1, layout: '1', charts: [{ id: 'c1', symbol: 'BTCUSDT', timeframe: '60' }], ...extra } as never);

    it('seeds the quick-switch chips when nothing was saved', () => {
        const ws = mount({ timeframeFavorites: ['5', '60', 'D'] });
        expect(ws.getState().timeframeFavorites).toEqual(['5', '60', 'D']);
        ws.destroy();
    });

    it('has none without it', () => {
        const ws = mount();
        expect(ws.getState().timeframeFavorites).toBeUndefined();
        ws.destroy();
    });

    it('lets the set the user saved win over the default', () => {
        const stored = doc({ timeframeFavorites: ['15'] });
        const ws = mount({ timeframeFavorites: ['5', '60', 'D'], persist: 'k', storage: { get: () => stored, set: () => {} } });
        expect(ws.getState().timeframeFavorites).toEqual(['15']);
        ws.destroy();
    });

    it('shows the chips in the topbar, in duration order', () => {
        const host = document.createElement('div');
        document.body.append(host);
        const ws = new VelaWorkspace(host, { layout: '1', timeframeFavorites: ['D', '5', '60'] } as never);
        const labels = [...host.querySelectorAll('.vela-widget-tf-chips .vela-widget-tf')].map((c) => c.textContent);
        expect(labels.length).toBeGreaterThanOrEqual(3);
        expect(labels.indexOf('5m')).toBeLessThan(labels.indexOf('1h'));
        expect(labels.indexOf('1h')).toBeLessThan(labels.indexOf('1D'));
        ws.destroy();
    });
});
