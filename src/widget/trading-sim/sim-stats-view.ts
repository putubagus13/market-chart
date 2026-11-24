// The trading simulator's Stats tab: the net result up front, the win/loss split, a few
// figures, then three charts (the equity curve, each trade's result, the drawdown), the
// target ratios as a meter list, and the symbol's pip size. Everything is scoped to the
// chart's symbol or to every symbol by the row at the top.
import { msg } from '../../core/i18n/message';
import type { WidgetContext } from '../contributions';
import { injectChromeStyles } from '../../ui/chromeStyles';
import { css } from '@luxalgo/vela-ui/css';
import { t } from '@luxalgo/vela-ui/t';
import { createSelect } from '@luxalgo/vela-ui/select';
import { createEmpty } from '@luxalgo/vela-ui/empty';
import { createFigure, toneOf, type FigureHandle } from '@luxalgo/vela-ui/figure';
import { createCard, type CardHandle } from '@luxalgo/vela-ui/card';
import { createLineChart, type LineChartHandle } from '@luxalgo/vela-ui/line-chart';
import { createBarChart, type BarChartHandle } from '@luxalgo/vela-ui/bar-chart';
import { createBadge } from '@luxalgo/vela-ui/badge';
import { createInput } from '@luxalgo/vela-ui/input';
import type { SimTrade } from './sim-engine';
import { computeStats } from './sim-stats';
import { buildStatsModel, PER_TRADE_BARS, type StatsModel } from './sim-stats-model';
import type { PipSizes } from './pip-sizes';

const TEXT = {
    scope: msg('widget.sim.scope', 'Statistics for'),
    scopeSymbol: msg('widget.sim.scope.symbol', 'This symbol'),
    scopeAll: msg('widget.sim.scope.all', 'All symbols'),
    emptyTitle: msg('widget.sim.stats.emptyTitle', 'No closed trades yet'),
    emptyBody: msg('widget.sim.stats.emptyBody', 'Place trades during a bar replay. Their results and charts appear here.'),
    netResult: msg('widget.sim.stats.netResult', 'Net result'),
    heroSub: msg('widget.sim.stats.heroSub', '{count, plural, one {# trade} other {# trades}} · {pips} pips'),
    winRate: msg('widget.sim.stats.winRate', 'Win rate'),
    winsKey: msg('widget.sim.stats.winsKey', '{count, plural, one {# win} other {# wins}}'),
    lossesKey: msg('widget.sim.stats.lossesKey', '{count, plural, one {# loss} other {# losses}}'),
    evenKey: msg('widget.sim.stats.evenKey', '{count} breakeven'),
    split: msg('widget.sim.stats.split', '{wins, plural, one {# win} other {# wins}} · {losses, plural, one {# loss} other {# losses}} · {breakeven} breakeven'),
    avgR: msg('widget.sim.stats.avgR', 'Average per trade'),
    drawdown: msg('widget.sim.stats.drawdown', 'Max drawdown'),
    drawdownSub: msg('widget.sim.stats.drawdownSub', '{pips} pips'),
    lossStreak: msg('widget.sim.stats.lossStreak', 'Losing streak'),
    winStreakSub: msg('widget.sim.stats.winStreakSub', 'Winning streak {count}'),
    total: msg('widget.sim.stats.total', 'Total trades'),
    equityTitle: msg('widget.sim.stats.equityTitle', 'Equity curve'),
    equityDesc: msg('widget.sim.stats.equityDesc', 'Cumulative result in R after each trade'),
    barsTitle: msg('widget.sim.stats.barsTitle', 'Results per trade'),
    barsDesc: msg('widget.sim.stats.barsDesc', 'Each closed trade, in R'),
    barsNewest: msg('widget.sim.stats.barsNewest', 'Newest {shown} of {total} trades, in R'),
    ddTitle: msg('widget.sim.stats.ddTitle', 'Drawdown'),
    ddDesc: msg('widget.sim.stats.ddDesc', 'How far below its best the result fell, in R'),
    tradeTip: msg('widget.sim.stats.tradeTip', 'Trade {n}: {r}R'),
    ratiosTitle: msg('widget.sim.rrTitle', 'Target ratios'),
    ratiosDesc: msg('widget.sim.stats.ratiosDesc', 'How often trades moved this far in their favor before the stop'),
    recommendedBadge: msg('widget.sim.stats.recommendedBadge', 'Recommended'),
    recommended: msg('widget.sim.recommended', 'Recommended R:R {rr}: reached in {probability} of trades, {expectancy}R per trade on average.'),
    moreTrades: msg('widget.sim.stats.moreTrades', '{count, plural, one {# more trade unlocks} other {# more trades unlock}} a recommendation.'),
    noEdge: msg('widget.sim.noEdge', 'No ratio has a positive expectancy yet.'),
    showTable: msg('widget.sim.stats.showTable', 'Show as table'),
    rrHead: msg('widget.sim.rrHead', 'R:R'),
    rrProbability: msg('widget.sim.rrProbability', 'Reached'),
    rrExpectancy: msg('widget.sim.rrExpectancy', 'Expectancy'),
    pipTitle: msg('widget.sim.stats.pipTitle', 'Pip size'),
    pipLine: msg('widget.sim.stats.pipLine', '1 pip of {symbol} = {size}'),
    pipHint: msg('widget.sim.stats.pipHint', 'Leave empty to use the tick size.'),
    pipInvalid: msg('widget.sim.pipInvalid', 'A pip size must be a positive number'),
};

const STYLE_ID = 'vela-widget-sim-stats';
const CSS = css`@layer vela.chrome {

.vela-sim-stats:where(:not([hidden])) { display: flex; flex-direction: column; gap: 12px; }
.vela-sim-stats-body:where(:not([hidden])) { display: flex; flex-direction: column; gap: 12px; }
.vela-sim-scope:where(:not([hidden])) { display: flex; align-items: center; gap: 8px; color: ${t.fg.muted}; }
/* The one number the tab leads with: larger than the kit's figure, proportional digits. */
.vela-sim-hero [data-slot~='figure-value'] { font-size: 28px; line-height: 1.15; font-variant-numeric: normal; }
.vela-sim-split-head:where(:not([hidden])) { display: flex; justify-content: space-between; color: ${t.fg.muted}; margin-bottom: 6px; }
.vela-sim-split-head strong { color: ${t.fg.bright}; font-weight: 600; }
.vela-sim-split:where(:not([hidden])) { display: flex; gap: 2px; height: 8px; }
.vela-sim-seg { border-radius: 4px; min-width: 0; }
.vela-sim-seg[data-kind='win'] { background: ${t.profit}; }
.vela-sim-seg[data-kind='loss'] { background: ${t.loss}; }
.vela-sim-seg[data-kind='even'] { background: ${t.fg.faint}; }
.vela-sim-legend:where(:not([hidden])) { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; color: ${t.fg.muted}; }
.vela-sim-key:where(:not([hidden])) { display: inline-flex; align-items: center; gap: 6px; }
.vela-sim-key::before { content: ''; width: 8px; height: 8px; border-radius: 2px; background: var(--_key); }
.vela-sim-kpis:where(:not([hidden])) { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
/* Chart boxes include their axis band, so a card never scrolls inside. */
.vela-sim-plot { position: relative; }
.vela-sim-plot[data-size='lg'] { height: 150px; }
.vela-sim-plot[data-size='md'] { height: 120px; }
.vela-sim-plot[data-size='sm'] { height: 100px; }
/* Pins the kit line chart's ink: a drawdown is a loss even when it ends back at 0. */
.vela-sim-drawdown { --_ink: ${t.loss}; }
.vela-sim-ratios:where(:not([hidden])) { display: flex; flex-direction: column; gap: 8px; }
.vela-sim-ratio:where(:not([hidden])) {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr) auto;
    align-items: center;
    gap: 4px 10px;
}
.vela-sim-ratio-name { color: ${t.fg.bright}; font-weight: 600; font-variant-numeric: tabular-nums; }
.vela-sim-ratio-track { height: 8px; border-radius: 4px; background: ${t.border.soft}; overflow: hidden; }
.vela-sim-ratio-fill { display: block; height: 100%; border-radius: 4px; background: ${t.profit}; }
.vela-sim-ratio[data-recommended] .vela-sim-ratio-fill { background: ${t.accent}; }
.vela-sim-ratio-figure { color: ${t.fg}; font-variant-numeric: tabular-nums; white-space: nowrap; unicode-bidi: isolate; }
.vela-sim-ratio-badge { grid-column: 2 / -1; justify-self: start; }
.vela-sim-stats-note { margin: 10px 0 0; color: ${t.fg.muted}; line-height: 1.45; }
.vela-sim-stats details { margin-top: 10px; color: ${t.fg.muted}; }
.vela-sim-stats summary { cursor: pointer; }
.vela-sim-pip:where(:not([hidden])) { display: flex; flex-direction: column; gap: 6px; color: ${t.fg.muted}; }

}`;

/** `+2.00R`, `−1.00R`, `0.00R` — a true minus sign, so a loss never reads as a hyphen. */
function signedR(fmt: WidgetContext['i18n']['format'], v: number, decimals = 2): string {
    const sign = v > 1e-9 ? '+' : v < -1e-9 ? '−' : '';
    return `${sign}${fmt.price(Math.abs(v), { decimals })}R`;
}

export class SimStatsView {
    readonly el: HTMLElement;
    private scope: 'symbol' | 'all' = 'symbol';
    private trades: readonly SimTrade[] = [];
    private symbol = '';
    private scopeLabel!: HTMLElement;
    private scopeSelect!: ReturnType<typeof createSelect>;
    private empty!: ReturnType<typeof createEmpty>;
    private body!: HTMLElement;
    private hero!: FigureHandle;
    private splitHead!: HTMLElement;
    private split!: HTMLElement;
    private legend!: HTMLElement;
    private kpis!: { avg: FigureHandle; dd: FigureHandle; streak: FigureHandle; total: FigureHandle };
    private kpiCards: CardHandle[] = [];
    /** The language the labels were built in; another one rebuilds them. */
    private builtLocale = '';
    private equity!: LineChartHandle;
    private bars!: BarChartHandle;
    private drawdown!: LineChartHandle;
    private cards!: { equity: CardHandle; bars: CardHandle; dd: CardHandle; ratios: CardHandle; pip: CardHandle };
    private ratios!: HTMLElement;
    private pipBody!: HTMLElement;
    private pipField!: ReturnType<typeof createInput>;
    private pipLine!: HTMLElement;
    private pipHint!: HTMLElement;

    constructor(private readonly ctx: WidgetContext, private readonly pips: PipSizes) {
        injectChromeStyles(STYLE_ID, CSS);
        this.el = Object.assign(ctx.host.ownerDocument.createElement('div'), { className: 'vela-sim-stats' });
        this.build();
    }

    /** Build the tab's parts with their labels in the current language. */
    private build(): void {
        const ctx = this.ctx;
        const doc = ctx.host.ownerDocument;
        const tr = ctx.i18n;
        this.builtLocale = tr.locale;
        const div = (className: string): HTMLElement => Object.assign(doc.createElement('div'), { className });

        const scopeRow = div('vela-sim-scope');
        this.scopeLabel = doc.createElement('span');
        this.scopeSelect = createSelect({
            options: [
                { value: 'symbol', label: tr.t(TEXT.scopeSymbol) },
                { value: 'all', label: tr.t(TEXT.scopeAll) },
            ],
            value: this.scope,
            size: 'sm',
            list: { host: ctx.host },
            onValueChange: (v) => this.setScope(v === 'all' ? 'all' : 'symbol'),
        });
        scopeRow.append(this.scopeLabel, this.scopeSelect.el);

        this.empty = createEmpty({ icon: 'trade', title: tr.t(TEXT.emptyTitle), description: tr.t(TEXT.emptyBody) });
        this.body = div('vela-sim-stats-body');

        this.hero = createFigure({ label: tr.t(TEXT.netResult), className: 'vela-sim-hero' });

        const splitWrap = div('vela-sim-split-wrap');
        this.splitHead = div('vela-sim-split-head');
        this.split = div('vela-sim-split');
        this.split.setAttribute('role', 'img');
        this.legend = div('vela-sim-legend');
        splitWrap.append(this.splitHead, this.split, this.legend);

        const kpis = div('vela-sim-kpis');
        const figure = (label: (typeof TEXT)[keyof typeof TEXT]): FigureHandle => {
            const f = createFigure({ label: tr.t(label) });
            const card = createCard({ variant: 'inset', size: 'sm', content: f.el });
            this.kpiCards.push(card);
            kpis.append(card.el);
            return f;
        };
        this.kpis = { avg: figure(TEXT.avgR), dd: figure(TEXT.drawdown), streak: figure(TEXT.lossStreak), total: figure(TEXT.total) };

        const plot = (size: 'lg' | 'md' | 'sm', chart: HTMLElement): HTMLElement => {
            const box = div('vela-sim-plot');
            box.dataset.size = size;
            box.append(chart);
            return box;
        };
        const tip = (n: number, r: number): string => tr.t(TEXT.tradeTip, { n: String(n), r: signedR(tr.format, r).slice(0, -1) });
        const axisR = (v: number): string => `${tr.format.price(v, { decimals: Math.abs(v) < 10 ? 1 : 0 })}R`;
        this.equity = createLineChart({ axes: true, baseline: 0, format: (p) => tip(p.x, p.y), xFormat: (x) => String(Math.round(x)), yFormat: axisR });
        this.bars = createBarChart({ axes: true, yFormat: axisR, format: (d) => tip(Number(d.label), d.value) });
        this.drawdown = createLineChart({ axes: true, baseline: 0, className: 'vela-sim-drawdown', format: (p) => tip(p.x, p.y), xFormat: (x) => String(Math.round(x)), yFormat: axisR });

        this.ratios = div('vela-sim-ratios');
        this.pipBody = div('vela-sim-pip');
        this.pipField = createInput({ size: 'sm', fill: true });
        this.pipField.input.inputMode = 'decimal';
        this.pipField.input.addEventListener('change', () => this.commitPip(this.pipField.input.value));
        this.pipLine = doc.createElement('span');
        this.pipHint = doc.createElement('span');
        this.pipBody.append(this.pipField.el, this.pipLine, this.pipHint);
        this.cards = {
            equity: createCard({ size: 'sm', title: tr.t(TEXT.equityTitle), description: tr.t(TEXT.equityDesc), content: plot('lg', this.equity.el) }),
            bars: createCard({ size: 'sm', title: tr.t(TEXT.barsTitle), description: tr.t(TEXT.barsDesc), content: plot('md', this.bars.el) }),
            dd: createCard({ size: 'sm', title: tr.t(TEXT.ddTitle), description: tr.t(TEXT.ddDesc), content: plot('sm', this.drawdown.el) }),
            ratios: createCard({ size: 'sm', title: tr.t(TEXT.ratiosTitle), description: tr.t(TEXT.ratiosDesc), content: this.ratios }),
            pip: createCard({ size: 'sm', title: tr.t(TEXT.pipTitle), content: this.pipBody }),
        };

        this.body.append(this.hero.el, splitWrap, kpis, this.cards.equity.el, this.cards.bars.el, this.cards.dd.el, this.cards.ratios.el, this.cards.pip.el);
        this.el.replaceChildren(scopeRow, this.empty.el, this.body);
    }

    private teardown(): void {
        this.equity.destroy();
        this.bars.destroy();
        this.drawdown.destroy();
        this.hero.destroy();
        for (const f of Object.values(this.kpis)) f.destroy();
        for (const c of this.kpiCards.splice(0)) c.destroy();
        for (const c of Object.values(this.cards)) c.destroy();
        this.pipField.destroy();
        this.el.replaceChildren();
    }

    /** Show the trades of the chart's symbol, or of every symbol. */
    setScope(scope: 'symbol' | 'all'): void {
        this.scope = scope;
        if (this.scopeSelect.value !== scope) this.scopeSelect.setValue(scope);
        this.paint();
    }

    render(trades: readonly SimTrade[], symbol: string): void {
        this.trades = trades;
        this.symbol = symbol;
        this.paint();
    }

    private paint(): void {
        const tr = this.ctx.i18n;
        if (tr.locale !== this.builtLocale) {
            this.teardown();
            this.build();
            this.scopeSelect.setValue(this.scope);
        }
        this.scopeLabel.textContent = tr.t(TEXT.scope);
        const scoped = this.scope === 'all' ? this.trades : this.trades.filter((t) => t.symbol === this.symbol);
        const m = buildStatsModel(computeStats(scoped, { pipOf: (t) => this.pips.pipOf(t) }));

        this.empty.el.hidden = !m.empty;
        this.body.hidden = m.empty;
        this.cards.pip.el.hidden = this.scope === 'all';
        // Even with nothing to chart, a symbol's pip size can be set: keep that card reachable.
        if (m.empty) {
            this.body.hidden = this.scope === 'all';
            for (const child of this.body.children) (child as HTMLElement).hidden = child !== this.cards.pip.el;
        } else for (const child of this.body.children) (child as HTMLElement).hidden = child === this.cards.pip.el && this.scope === 'all';
        if (!m.empty) this.paintFigures(m);
        if (this.scope === 'symbol') this.paintPip();
    }

    private paintFigures(m: StatsModel): void {
        const tr = this.ctx.i18n;
        const fmt = tr.format;
        const pips = (v: number): string => `${v > 1e-9 ? '+' : v < -1e-9 ? '−' : ''}${fmt.price(Math.abs(v), { decimals: 1 })}`;

        this.hero.set(signedR(fmt, m.netR), toneOf(m.netR), tr.t(TEXT.heroSub, { count: m.total, pips: pips(m.netPips) }));

        const { wins, losses, breakeven } = m.split;
        const sentence = tr.t(TEXT.split, { wins, losses, breakeven });
        const head = this.splitHead.ownerDocument;
        const label = head.createElement('span');
        label.textContent = tr.t(TEXT.winRate);
        const value = head.createElement('strong');
        value.textContent = fmt.percent(m.winRate * 100, { decimals: 1, signed: false });
        this.splitHead.replaceChildren(label, value);
        this.split.setAttribute('aria-label', `${tr.t(TEXT.winRate)} ${value.textContent}: ${sentence}`);
        this.split.replaceChildren(
            ...([['win', wins], ['loss', losses], ['even', breakeven]] as const)
                .filter(([, n]) => n > 0)
                .map(([kind, n]) => {
                    const seg = head.createElement('span');
                    seg.className = 'vela-sim-seg';
                    seg.dataset.kind = kind;
                    seg.style.flex = `${n} 1 0`;
                    return seg;
                }),
        );
        const key = (kind: string, color: string, text: string): HTMLElement => {
            const el = head.createElement('span');
            el.className = 'vela-sim-key';
            el.dataset.kind = kind;
            el.style.setProperty('--_key', color);
            el.textContent = text;
            return el;
        };
        this.legend.replaceChildren(
            key('win', String(t.profit), tr.t(TEXT.winsKey, { count: wins })),
            key('loss', String(t.loss), tr.t(TEXT.lossesKey, { count: losses })),
            key('even', String(t.fg.faint), tr.t(TEXT.evenKey, { count: breakeven })),
        );

        this.kpis.avg.set(signedR(fmt, m.avgR), toneOf(m.avgR), null);
        this.kpis.dd.set(m.maxDrawdownR > 1e-9 ? signedR(fmt, -m.maxDrawdownR) : signedR(fmt, 0), m.maxDrawdownR > 1e-9 ? 'loss' : 'neutral', tr.t(TEXT.drawdownSub, { pips: fmt.price(m.maxDrawdownPips, { decimals: 1 }) }));
        this.kpis.streak.set(String(m.longestLosingStreak), m.longestLosingStreak > 0 ? 'loss' : 'neutral', tr.t(TEXT.winStreakSub, { count: m.longestWinningStreak }));
        this.kpis.total.set(String(m.total), 'neutral', null);

        this.equity.setData(m.equity);
        this.bars.setData(m.bars);
        this.drawdown.setData(m.drawdown);
        this.cards.bars.setDescription(m.barsTruncated ? tr.t(TEXT.barsNewest, { shown: PER_TRADE_BARS, total: m.total }) : tr.t(TEXT.barsDesc));
        this.paintRatios(m);
    }

    private paintRatios(m: StatsModel): void {
        const tr = this.ctx.i18n;
        const fmt = tr.format;
        const doc = this.ratios.ownerDocument;
        const name = (rr: number): string => `1:${fmt.price(rr, { decimals: rr % 1 ? 1 : 0 })}`;
        const pct = (p: number): string => fmt.percent(p * 100, { decimals: 0, signed: false });
        const rows = m.ratios.map((row) => {
            const el = doc.createElement('div');
            el.className = 'vela-sim-ratio';
            if (row.recommended) el.dataset.recommended = '';
            const nameEl = Object.assign(doc.createElement('span'), { className: 'vela-sim-ratio-name', textContent: name(row.rr) });
            const track = Object.assign(doc.createElement('span'), { className: 'vela-sim-ratio-track' });
            const fill = Object.assign(doc.createElement('span'), { className: 'vela-sim-ratio-fill' });
            fill.style.width = `${row.sample ? Math.round(row.probability * 100) : 0}%`;
            track.append(fill);
            const figure = Object.assign(doc.createElement('span'), {
                className: 'vela-sim-ratio-figure',
                textContent: row.sample ? `${pct(row.probability)} · ${signedR(fmt, row.expectancy)}` : '—',
            });
            el.append(nameEl, track, figure);
            if (row.recommended) {
                const badge = createBadge({ text: tr.t(TEXT.recommendedBadge), className: 'vela-sim-ratio-badge' });
                el.append(badge.el);
            }
            return el;
        });
        const rec = m.ratios.find((r) => r.recommended);
        const note = Object.assign(doc.createElement('p'), { className: 'vela-sim-stats-note' });
        if (rec) note.textContent = tr.t(TEXT.recommended, { rr: name(rec.rr), probability: pct(rec.probability), expectancy: signedR(fmt, rec.expectancy).slice(0, -1) });
        else if (m.samplesToRecommend > 0) note.textContent = tr.t(TEXT.moreTrades, { count: m.samplesToRecommend });
        else note.textContent = tr.t(TEXT.noEdge);

        const details = doc.createElement('details');
        const summary = Object.assign(doc.createElement('summary'), { textContent: tr.t(TEXT.showTable) });
        const table = Object.assign(doc.createElement('table'), { className: 'vela-sim-table' });
        const head = doc.createElement('tr');
        for (const h of [TEXT.rrHead, TEXT.rrProbability, TEXT.rrExpectancy]) head.append(Object.assign(doc.createElement('th'), { textContent: tr.t(h) }));
        table.append(head);
        for (const row of m.ratios) {
            const r = doc.createElement('tr');
            if (row.recommended) r.dataset.best = '';
            for (const c of [name(row.rr), row.sample ? `${pct(row.probability)} (${row.sample})` : '—', row.sample ? signedR(fmt, row.expectancy) : '—']) {
                r.append(Object.assign(doc.createElement('td'), { textContent: c }));
            }
            table.append(r);
        }
        details.append(summary, table);
        this.ratios.replaceChildren(...rows, note, details);
    }

    /** Refresh the pip size card. A field the user is typing in keeps what they typed. */
    private paintPip(): void {
        const tr = this.ctx.i18n;
        const symbol = this.symbol;
        const own = this.pips.get(symbol);
        const tick = [...this.trades].reverse().find((t) => t.symbol === symbol)?.pip;
        const input = this.pipField.input;
        if (input.ownerDocument.activeElement !== input) input.value = own !== undefined ? String(own) : '';
        input.placeholder = tick !== undefined ? String(tick) : '';
        const size = own ?? tick;
        this.pipLine.textContent = size !== undefined ? tr.t(TEXT.pipLine, { symbol, size: String(size) }) : tr.t(TEXT.pipHint);
        this.pipHint.textContent = tr.t(TEXT.pipHint);
        this.pipHint.hidden = size === undefined;
    }

    /** Apply what the user committed: empty goes back to the tick size; anything but a positive number is refused. */
    private commitPip(raw: string): void {
        const text = raw.trim();
        if (text === '') {
            this.pips.set(this.symbol, null);
        } else {
            const size = /^\d*\.?\d+$/.test(text) ? Number(text) : NaN;
            if (!this.pips.set(this.symbol, size)) this.ctx.toast(this.ctx.i18n.t(TEXT.pipInvalid), 'error');
        }
        this.paintPip();
    }

    destroy(): void {
        this.teardown();
        this.el.remove();
    }
}
