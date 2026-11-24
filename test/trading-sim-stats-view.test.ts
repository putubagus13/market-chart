// @vitest-environment jsdom
// The simulator's Stats tab: figures, the win/loss split, three charts, the target-ratio list
// and the pip-size field, all scoped to the chart's symbol or to every symbol.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { SimStatsView } from '../src/widget/trading-sim/sim-stats-view';
import { PipSizes } from '../src/widget/trading-sim/pip-sizes';
import type { SimTrade } from '../src/widget/trading-sim/sim-engine';
import type { WidgetContext } from '../src/widget/contributions';
import { createTranslator, registerLocale } from '../src/plugin';

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

/** A closed long with risk 10 (entry 100, stop 90): a TP exit at 120 (+2R), an SL exit at 90 (−1R). */
function closed(i: number, outcome: 'tp' | 'sl', over: Partial<SimTrade> = {}): SimTrade {
    return {
        id: `t${i}`, symbol: 'BTC', timeframe: '60', side: 'long', entry: 100, sl: 90, tp: 120, openTime: 0, pip: 1,
        closeTime: i + 1, exit: outcome === 'tp' ? 120 : 90, outcome, mfe: outcome === 'tp' ? 20 : 0, mae: outcome === 'sl' ? 10 : 0, ...over,
    };
}
const SEQ: Array<'tp' | 'sl'> = ['tp', 'sl', 'sl', 'sl', 'tp', 'tp', 'sl'];
const sequence = (): SimTrade[] => SEQ.map((o, i) => closed(i, o));

function setup() {
    const host = document.createElement('div');
    document.body.append(host);
    const toast = vi.fn();
    const ctx = { host, i18n: createTranslator({ locale: 'en' }), toast, stateChanged: () => {} } as unknown as WidgetContext;
    const pips = new PipSizes();
    const view = new SimStatsView(ctx, pips);
    host.append(view.el);
    return { view, pips, toast, $: <T extends Element = HTMLElement>(sel: string) => view.el.querySelector<T>(sel), $$: (sel: string) => view.el.querySelectorAll(sel) };
}

describe('the Stats tab', () => {
    afterEach(() => document.body.replaceChildren());

    it('renders an empty state with no trades', () => {
        const { view, $$ } = setup();
        view.render([], 'BTC');
        const shown = (el: Element): boolean => !el.closest('[hidden]');
        expect([...$$('[data-slot="empty"]')].filter(shown)).toHaveLength(1);
        expect([...$$('[data-slot="line-chart"], [data-slot="bar-chart"], .vela-sim-hero')].filter(shown)).toHaveLength(0);
        expect([...$$('.vela-sim-pip')].filter(shown)).toHaveLength(1); // the pip size can be set before any trade
        expect(view.el.textContent).not.toContain('NaN');
    });

    it('renders the hero, the split and three charts', () => {
        const { view, $, $$ } = setup();
        view.render(sequence(), 'BTC');
        expect($('.vela-sim-hero')!.textContent).toContain('+2.00R');
        expect($('.vela-sim-split')!.getAttribute('aria-label')).toContain('3 wins · 4 losses');
        expect($$('[data-slot="line-chart"]')).toHaveLength(2);
        expect($$('[data-slot="bar-chart"]')).toHaveLength(1);
        expect(view.el.textContent).not.toContain('NaN');
    });

    it('relabels everything when the language changes', () => {
        const off = registerLocale({ locale: 'xx', messages: { 'widget.sim.scope.symbol': 'XX symbol', 'widget.sim.stats.equityTitle': 'XX equity', 'widget.sim.stats.emptyTitle': 'XX empty' } });
        try {
            const host = document.createElement('div');
            document.body.append(host);
            let i18n = createTranslator({ locale: 'en' });
            const ctx = { host, get i18n() { return i18n; }, toast: () => {}, stateChanged: () => {} } as unknown as WidgetContext;
            const view = new SimStatsView(ctx, new PipSizes());
            host.append(view.el);
            view.render([], 'BTC');
            i18n = createTranslator({ locale: 'xx' });
            view.render([], 'BTC');
            expect(view.el.textContent).toContain('XX symbol');
            expect(view.el.textContent).toContain('XX empty');
            view.render(sequence(), 'BTC');
            expect(view.el.textContent).toContain('XX equity');
        } finally {
            off();
        }
    });

    it('pip size refuses unparseable text and zero, and only empty resets it', () => {
        const { view, pips, toast, $ } = setup();
        view.render([closed(0, 'tp')], 'BTC');
        pips.set('BTC', 10);
        const commit = (text: string): void => {
            const input = $<HTMLInputElement>('.vela-sim-pip input')!;
            input.value = text;
            input.dispatchEvent(new Event('change'));
        };
        for (const bad of ['abc', '-', '0', '1,5']) {
            toast.mockClear();
            commit(bad);
            expect(pips.get('BTC'), bad).toBe(10);
            expect(toast, bad).toHaveBeenCalledWith(expect.any(String), 'error');
        }
        commit('');
        expect(pips.get('BTC')).toBeUndefined();
    });

    it('keeps the pip size field and what is typed in it across re-renders', () => {
        const { view, $ } = setup();
        view.render([closed(0, 'tp')], 'BTC');
        const input = $<HTMLInputElement>('.vela-sim-pip input')!;
        input.focus();
        input.value = '1';
        view.render([closed(0, 'tp'), closed(1, 'sl')], 'BTC'); // a replay step re-renders
        expect($<HTMLInputElement>('.vela-sim-pip input')).toBe(input);
        expect(input.value).toBe('1');
    });

    it('labels each legend key on its own, whatever the sentence looks like', () => {
        const off = registerLocale({ locale: 'xy', messages: { 'widget.sim.stats.split': '{wins}W、{losses}L、{breakeven}B' } });
        try {
            const host = document.createElement('div');
            document.body.append(host);
            const ctx = { host, i18n: createTranslator({ locale: 'xy' }), toast: () => {}, stateChanged: () => {} } as unknown as WidgetContext;
            const view = new SimStatsView(ctx, new PipSizes());
            host.append(view.el);
            view.render(sequence(), 'BTC');
            const keys = [...view.el.querySelectorAll('.vela-sim-key')].map((k) => k.textContent);
            expect(keys).toEqual(['3 wins', '4 losses', '0 breakeven']);
        } finally {
            off();
        }
    });

    it('the split reads singular counts as singular', () => {
        const { view, $ } = setup();
        view.render([closed(0, 'tp'), closed(1, 'sl')], 'BTC');
        expect($('.vela-sim-split')!.getAttribute('aria-label')).toContain('1 win · 1 loss');
    });

    it('drawdown always draws in the loss tone', () => {
        const { view, $$ } = setup();
        view.render([...sequence(), closed(7, 'tp')], 'BTC'); // back at a new peak: the drawdown ends at 0
        const lines = [...$$('[data-slot="line-chart"]')];
        expect(lines.filter((el) => el.classList.contains('vela-sim-drawdown'))).toHaveLength(1);
        // jsdom has no cascade layers: assert the rule that pins the ink (the browser check reads the color)
        const css = [...document.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');
        expect(css).toMatch(/\.vela-sim-drawdown[^{]*\{[^}]*--_ink:\s*var\(--vela-loss\)/);
    });

    it('marks exactly one recommended ratio', () => {
        const { view, $$ } = setup();
        const trades: SimTrade[] = [];
        for (let i = 0; i < 4; i += 1) trades.push(closed(i, 'sl', { mfe: 30 }));
        for (let i = 4; i < 8; i += 1) trades.push(closed(i, 'sl', { mfe: 15 }));
        for (let i = 8; i < 12; i += 1) trades.push(closed(i, 'sl', { mfe: 0 }));
        view.render(trades, 'BTC');
        const recommended = [...$$('.vela-sim-ratio[data-recommended]')];
        expect(recommended).toHaveLength(1);
        expect(recommended[0]!.textContent!.trim().startsWith('1:1.5')).toBe(true);
    });

    it('scope filters every section', () => {
        const { view, $ } = setup();
        const trades = [closed(0, 'tp', { symbol: 'BTC' }), closed(1, 'sl', { symbol: 'ETH' })];
        view.render(trades, 'ETH');
        expect($('.vela-sim-hero')!.textContent).toContain('−1.00R');
        view.setScope('all');
        expect($('.vela-sim-hero')!.textContent).toContain('+1.00R');
    });

    it('pip size field validates and saves', () => {
        const { view, pips, toast, $ } = setup();
        view.render([closed(0, 'tp')], 'BTC');
        expect($('.vela-sim-hero')!.textContent).toContain('20.0 pips');
        const field = (): HTMLInputElement => $<HTMLInputElement>('.vela-sim-pip input')!;
        field().value = '-3';
        field().dispatchEvent(new Event('change'));
        expect(toast).toHaveBeenCalledWith(expect.any(String), 'error');
        expect(pips.get('BTC')).toBeUndefined();
        field().value = '10';
        field().dispatchEvent(new Event('change'));
        expect(pips.get('BTC')).toBe(10);
        view.render([closed(0, 'tp')], 'BTC');
        expect($('.vela-sim-hero')!.textContent).toContain('2.0 pips');
    });
});
