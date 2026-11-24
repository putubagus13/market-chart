// Trading simulator — a side panel for practicing trades during a bar replay. Buy or Sell
// drops a long/short position on the chart at the replay's current close, with a stop and a
// target the user drags into place; placing it opens a simulated trade that the replayed
// bars close at its stop or target. Closed trades build a history with statistics, saved in
// the shell's document.
import type { Vela } from '../../Vela';
import type { OHLCV } from '../../core/model/ohlcv';
import { msg } from '../../core/i18n/message';
import type { MessageLike } from '../../core/i18n/types';
import type { WidgetContext } from '../contributions';
import { registerSidePanel, registerStatePersistence } from '../contributions';
import type { WorkspaceReplay } from '../../workspace/WorkspaceReplay';
import { injectChromeStyles } from '../../ui/chromeStyles';
import { css } from '@luxalgo/vela-ui/css';
import { t } from '@luxalgo/vela-ui/t';
import { registerIcon, svg16 } from '@luxalgo/vela-ui/icons';
import { createButton } from '@luxalgo/vela-ui/button';
import { createTabs } from '@luxalgo/vela-ui/tabs';
import { priceDecimals } from '../price-decimals';
import { timeframeMs } from '../timeframe';
import { replayControlsOf } from '../replay/replay-controls';
import { SimulationEngine, plannedRR, resultPips, resultR, validLevels, type SimTrade, type TradeSide } from './sim-engine';
import { SimStatsView } from './sim-stats-view';
import { PipSizes } from './pip-sizes';

const TEXT = {
    title: msg('widget.sim.title', 'Trading simulator'),
    tabOrder: msg('widget.sim.tab.order', 'Order'),
    tabPositions: msg('widget.sim.tab.positions', 'Positions'),
    tabHistory: msg('widget.sim.tab.history', 'History'),
    tabStats: msg('widget.sim.tab.stats', 'Stats'),
    needReplay: msg('widget.sim.needReplay', 'Trades run on a bar replay. Start one, then buy or sell at the replayed price.'),
    startReplay: msg('widget.sim.startReplay', 'Start bar replay'),
    buy: msg('widget.sim.buy', 'Buy'),
    sell: msg('widget.sim.sell', 'Sell'),
    draftHint: msg('widget.sim.draftHint', 'Drag the stop and target on the chart, then place the order.'),
    entry: msg('widget.sim.entry', 'Entry'),
    stop: msg('widget.sim.stop', 'Stop loss'),
    target: msg('widget.sim.target', 'Take profit'),
    rr: msg('widget.sim.rr', 'Risk : reward'),
    risk: msg('widget.sim.risk', 'Risk'),
    reward: msg('widget.sim.reward', 'Reward'),
    pips: msg('widget.sim.pips', '{value} pips'),
    place: msg('widget.sim.place', 'Place order'),
    cancel: msg('widget.sim.cancel', 'Cancel'),
    wrongSide: msg('widget.sim.wrongSide', 'The stop and the target must sit on opposite sides of the entry.'),
    noPrice: msg('widget.sim.noPrice', 'No price at the replay cursor yet'),
    side: msg('widget.sim.side', 'Side'),
    long: msg('widget.sim.long', 'Long'),
    short: msg('widget.sim.short', 'Short'),
    noPositions: msg('widget.sim.noPositions', 'No open positions.'),
    close: msg('widget.sim.close', 'Close'),
    noHistory: msg('widget.sim.noHistory', 'Closed trades appear here.'),
    remove: msg('widget.sim.remove', 'Remove trade'),
    clearAll: msg('widget.sim.clearAll', 'Clear history'),
    confirmClear: msg('widget.sim.confirmClear', 'Click again to delete every trade'),
    outcomeTp: msg('widget.sim.outcome.tp', 'TP'),
    outcomeSl: msg('widget.sim.outcome.sl', 'SL'),
    outcomeManual: msg('widget.sim.outcome.manual', 'Closed'),
    closedToast: msg('widget.sim.closedToast', '{symbol} {outcome}: {r}R'),
    cancelledToast: msg('widget.sim.cancelledToast', '{count, plural, one {# open trade was} other {# open trades were}} cancelled: the replay moved'),
};

/** Stop distance of a new position, in average true ranges; the target sits at twice that. */
const STOP_ATR = 1;
const DEFAULT_RR = 2;
/** Bars of history behind the cursor for the average true range. */
const ATR_BARS = 14;
/** How far right of the entry the position box reaches, in bars. */
const BOX_BARS = 25;

registerIcon('trade', svg16('<path d="M2 12.5 6 8.5l2.5 2.5L14 5.5"/><path d="M10.5 5.5H14V9"/>'));

const STYLE_ID = 'vela-widget-sim';
const CSS = css`@layer vela.chrome {

.vela-sim:where(:not([hidden])) { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 12px; }
.vela-sim-tabs { padding: 4px 8px 0; border-bottom: 1px solid ${t.border}; }
.vela-sim-page { flex: 1; min-height: 0; overflow-y: auto; padding: 10px; }
.vela-sim-note { color: ${t.fg.muted}; line-height: 1.45; margin: 0 0 10px; }
.vela-sim-sides:where(:not([hidden])) { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
.vela-sim-sides > * { width: 100%; justify-content: center; }
.vela-sim-grid:where(:not([hidden])) { display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; margin: 8px 0 12px; }
.vela-sim-grid dt { color: ${t.fg.muted}; }
.vela-sim-grid dd { margin: 0; text-align: end; font-variant-numeric: tabular-nums; unicode-bidi: isolate; color: ${t.fg.bright}; }
.vela-sim-actions:where(:not([hidden])) { display: flex; gap: 8px; }
.vela-sim-actions > * { flex: 1; justify-content: center; }
.vela-sim-warn { color: ${t.danger}; margin: 0 0 8px; }
.vela-sim-list { display: flex; flex-direction: column; gap: 6px; }
.vela-sim-trade:where(:not([hidden])) {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 4px 8px;
    padding: 6px 8px;
    border: 1px solid ${t.border.soft};
    border-radius: ${t.radius.sm};
}
.vela-sim-trade-title { font-weight: 600; color: ${t.fg.bright}; }
.vela-sim-trade-sub { grid-column: 1 / -1; color: ${t.fg.muted}; font-variant-numeric: tabular-nums; unicode-bidi: isolate; }
.vela-sim-num { font-variant-numeric: tabular-nums; white-space: nowrap; unicode-bidi: isolate; }
.vela-sim-num[data-dir='up'], .vela-sim-side[data-side='long'] { color: ${t.up}; }
.vela-sim-num[data-dir='down'], .vela-sim-side[data-side='short'] { color: ${t.down}; }
.vela-sim-footer { margin-top: 10px; }
.vela-sim-table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; font-variant-numeric: tabular-nums; }
.vela-sim-table th { color: ${t.fg.muted}; font-weight: 500; text-align: end; padding: 3px 4px; }
.vela-sim-table td { text-align: end; padding: 3px 4px; border-top: 1px solid ${t.border.faint}; }
.vela-sim-table th:first-child, .vela-sim-table td:first-child { text-align: start; }
.vela-sim-table tr[data-best] td { color: ${t.accent}; font-weight: 600; }

}`;

/** One simulator per shell, keyed by its root — the panel and the saved document share it. */
const engines = new WeakMap<HTMLElement, SimulationEngine>();

/** Per-symbol pip sizes, one store per shell like the simulator. */
const pipStores = new WeakMap<HTMLElement, PipSizes>();

export function pipSizesOf(ctx: Pick<WidgetContext, 'host'>): PipSizes {
    let p = pipStores.get(ctx.host);
    if (!p) pipStores.set(ctx.host, (p = new PipSizes()));
    return p;
}

export function simulatorOf(ctx: Pick<WidgetContext, 'host'>): SimulationEngine {
    let e = engines.get(ctx.host);
    if (!e) engines.set(ctx.host, (e = new SimulationEngine()));
    return e;
}

function replayOf(ctx: WidgetContext): WorkspaceReplay | null {
    return (ctx as WidgetContext & { replay?: WorkspaceReplay }).replay ?? null;
}

/** Average true range over `bars` (their first bar only seeds the previous close). */
export function averageTrueRange(bars: readonly OHLCV[]): number {
    let sum = 0;
    let n = 0;
    for (let i = 1; i < bars.length; i += 1) {
        const b = bars[i]!;
        const prev = bars[i - 1]!.close;
        sum += Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
        n += 1;
    }
    return n ? sum / n : 0;
}

/** The bars of `symbol` up to `to`, newest last, straight from its data source. */
async function barsUpTo(chart: Vela, symbol: string, timeframe: string, to: number, limit: number): Promise<OHLCV[]> {
    const r = chart.data.resolve(symbol);
    const provider = r ? chart.data.providerInstance(r.provider) : undefined;
    if (!r || !provider) return [];
    const bars = await provider.getBars(r.ticker, timeframe, { to, limit });
    return bars.filter((b) => b.time <= to);
}

interface Draft {
    drawingId: string;
    entryTime: number;
}

/** The levels a position drawing shows: entry, stop, target, and the side they make. */
function levelsOf(chart: Vela, id: string): { entry: number; sl: number; tp: number; side: TradeSide } | null {
    const d = chart.drawings.all().find((x) => x.id === id);
    const [e, s, tg] = d?.anchors ?? [];
    if (!e || !s || !tg) return null;
    return { entry: e.price, sl: s.price, tp: tg.price, side: tg.price >= e.price ? 'long' : 'short' };
}

export class TradingSimView {
    readonly el: HTMLElement;
    private readonly pages: Record<'order' | 'positions' | 'history' | 'stats', HTMLElement>;
    private readonly tabs: ReturnType<typeof createTabs>;
    private chart: Vela | null = null;
    private chartOffs: Array<() => void> = [];
    private readonly offs: Array<() => void> = [];
    private draft: Draft | null = null;
    /** The drawing of each open trade. */
    private readonly drawingOf = new Map<string, string>();
    private lastBar: OHLCV | null = null;
    private pip = 0;
    private decimals = 2;
    private readonly statsView: SimStatsView;
    private confirmClear = false;
    private warning: MessageLike | null = null;

    constructor(private readonly ctx: WidgetContext, private readonly engine: SimulationEngine, private readonly pips: PipSizes) {
        injectChromeStyles(STYLE_ID, CSS);
        const doc = ctx.host.ownerDocument;
        this.el = doc.createElement('div');
        this.el.className = 'vela-sim';
        const page = (): HTMLElement => Object.assign(doc.createElement('div'), { className: 'vela-sim-page' });
        this.pages = { order: page(), positions: page(), history: page(), stats: page() };
        this.tabs = createTabs({ items: this.tabItems(), defaultValue: 'order', className: 'vela-sim-tabs', onValueChange: () => this.render() });
        for (const [value, el] of Object.entries(this.pages)) this.tabs.panel(value, el);
        this.statsView = new SimStatsView(ctx, pips);
        this.pages.stats.append(this.statsView.el);
        this.el.append(this.tabs.el, ...Object.values(this.pages));
        this.offs.push(
            engine.subscribe(() => {
                this.ctx.stateChanged();
                this.render();
            }),
            pips.subscribe(() => {
                this.ctx.stateChanged();
                this.render();
            }),
        );
        const replay = replayOf(ctx);
        if (replay) {
            this.offs.push(
                replay.on('replay:start', () => this.onReplayMoved()),
                replay.on('replay:end', () => this.onReplayMoved()),
                replay.on('replay:step', () => this.render()),
            );
        }
        this.render();
    }

    private tabItems() {
        const tr = this.ctx.i18n;
        return [
            { value: 'order', label: tr.t(TEXT.tabOrder) },
            { value: 'positions', label: tr.t(TEXT.tabPositions), count: this.engine.openTrades.length || null },
            { value: 'history', label: tr.t(TEXT.tabHistory), count: this.engine.history.length || null },
            { value: 'stats', label: tr.t(TEXT.tabStats) },
        ];
    }

    /** Follow the active chart: its bars close trades, its drawings carry the draft. */
    bindChart(chart: Vela): void {
        if (chart === this.chart) return;
        for (const off of this.chartOffs.splice(0)) off();
        this.chart = chart;
        this.chartOffs.push(
            chart.on('bar', (bar) => this.onBar(bar)),
            chart.on('drawing:edited', (e) => {
                if (e.id === this.draft?.drawingId) this.render();
            }),
            chart.on('drawing:removed', (e) => {
                if (e.id === this.draft?.drawingId) {
                    this.draft = null;
                    this.render();
                }
            }),
            chart.on('market:changed', () => this.render()),
            chart.on('locale:changed', () => this.render()),
        );
        this.render();
    }

    private get replayActive(): boolean {
        return replayOf(this.ctx)?.state.active ?? false;
    }

    private onBar(bar: OHLCV): void {
        const chart = this.chart;
        if (!chart || !this.replayActive) return;
        this.lastBar = bar;
        const { symbol = '', timeframe = '' } = chart.market;
        const done = this.engine.onBar(symbol, timeframe, bar);
        for (const trade of done) {
            this.dropDrawing(this.drawingOf.get(trade.id));
            this.drawingOf.delete(trade.id);
            const outcome = this.ctx.i18n.t(trade.outcome === 'tp' ? TEXT.outcomeTp : TEXT.outcomeSl);
            const r = this.ctx.i18n.format.price(resultR(trade), { decimals: 2 });
            this.ctx.toast(this.ctx.i18n.t(TEXT.closedToast, { symbol: trade.symbol, outcome, r }), trade.outcome === 'tp' ? 'success' : 'error');
        }
        if (!done.length && this.engine.openTrades.length) this.render();
    }

    /** A replay that seeks or ends takes its open trades and the draft with it. */
    private onReplayMoved(): void {
        const dropped = this.engine.cancelOpen();
        for (const t of dropped) this.dropDrawing(this.drawingOf.get(t.id));
        this.drawingOf.clear();
        this.cancelDraft();
        this.lastBar = null;
        if (dropped.length) this.ctx.toast(this.ctx.i18n.t(TEXT.cancelledToast, { count: dropped.length }), 'info');
        this.render();
    }

    private dropDrawing(id: string | undefined): void {
        if (!id || !this.chart) return;
        this.chart.drawings.lock(id, false);
        this.chart.drawings.remove(id);
    }

    /** Buy or Sell: a position at the replay's close, its stop one average range away, its target twice that. */
    async openDraft(side: TradeSide): Promise<void> {
        const chart = this.chart;
        const replay = replayOf(this.ctx);
        const cursor = replay?.state.cursorTime;
        if (!chart || !replay || cursor == null) return;
        replay.pause();
        this.cancelDraft();
        const { symbol = '', timeframe = '' } = chart.market;
        const bars = await barsUpTo(chart, symbol, timeframe, cursor, ATR_BARS + 1).catch(() => [] as OHLCV[]);
        const last = bars[bars.length - 1] ?? this.lastBar;
        if (!last) {
            this.ctx.toast(this.ctx.i18n.t(TEXT.noPrice), 'error');
            return;
        }
        this.lastBar = last;
        const info = await chart.data.symbolInfo(symbol).catch(() => undefined);
        const mintick = typeof info?.mintick === 'number' && info.mintick > 0 ? info.mintick : undefined;
        this.decimals = priceDecimals(last.close, mintick);
        // The trade keeps the tick size; a user pip size applies only where results are read.
        this.pip = mintick ?? 10 ** -this.decimals;
        const entry = last.close;
        const atr = averageTrueRange(bars) || entry * 0.01;
        const d = side === 'long' ? 1 : -1;
        const sl = entry - d * atr * STOP_ATR;
        const tp = entry + d * atr * STOP_ATR * DEFAULT_RR;
        const end = last.time + BOX_BARS * timeframeMs(timeframe);
        const drawing = chart.drawings.add('position', {
            anchors: [
                { time: last.time, price: entry },
                { time: end, price: sl },
                { time: end, price: tp },
            ],
        });
        if (!drawing) return;
        // The replayed bars end at the plot's right edge: make room so every handle is in reach.
        const view = chart.getVisibleRange();
        const right = end + 3 * timeframeMs(timeframe);
        if (view && view.to < right) chart.setVisibleRange({ from: view.from + (right - view.to), to: right });
        this.draft = { drawingId: drawing.id, entryTime: last.time };
        this.warning = null;
        this.tabs.setValue('order');
        this.render();
    }

    /** Place the draft: a market order at the replay's close with the drawn stop and target. */
    placeDraft(): void {
        const chart = this.chart;
        const draft = this.draft;
        const last = this.lastBar;
        if (!chart || !draft || !last) return;
        const lv = levelsOf(chart, draft.drawingId);
        if (!lv) return;
        // A market order fills at the current close, wherever the entry handle was dragged.
        const order = { side: lv.side, entry: last.close, sl: lv.sl, tp: lv.tp };
        if (!validLevels(order)) {
            this.warning = TEXT.wrongSide;
            this.render();
            return;
        }
        const { symbol = '', timeframe = '' } = chart.market;
        const trade = this.engine.place({ ...order, symbol, timeframe, openTime: last.time, pip: this.pip || 10 ** -this.decimals });
        if (!trade) return;
        const d = chart.drawings.all().find((x) => x.id === draft.drawingId);
        if (d && d.anchors[0] && Math.abs(d.anchors[0].price - order.entry) > 0) {
            chart.drawings.update(draft.drawingId, { anchors: [{ ...d.anchors[0], price: order.entry }, ...d.anchors.slice(1)] });
        }
        chart.drawings.lock(draft.drawingId, true);
        this.drawingOf.set(trade.id, draft.drawingId);
        this.draft = null;
        this.warning = null;
        this.tabs.setValue('positions');
        this.render();
    }

    cancelDraft(): void {
        const id = this.draft?.drawingId;
        this.draft = null;
        this.warning = null;
        if (id && this.chart) this.chart.drawings.remove(id);
        this.render();
    }

    closeTrade(id: string): void {
        const last = this.lastBar;
        if (!last) return;
        const trade = this.engine.close(id, last.close, last.time);
        if (trade) {
            this.dropDrawing(this.drawingOf.get(id));
            this.drawingOf.delete(id);
        }
    }

    // ── rendering ──────────────────────────────────────────────

    private render(): void {
        this.tabs.setItems(this.tabItems());
        this.renderOrder();
        this.renderPositions();
        this.renderHistory();
        this.renderStats();
    }

    private fmtPrice(v: number, decimals = this.decimals): string {
        return this.ctx.i18n.format.price(v, { decimals });
    }

    private fmtNum(v: number, decimals = 2): string {
        return this.ctx.i18n.format.price(v, { decimals });
    }

    private signed(el: HTMLElement, v: number): HTMLElement {
        if (v > 0) el.dataset.dir = 'up';
        else if (v < 0) el.dataset.dir = 'down';
        return el;
    }

    private grid(rows: Array<[MessageLike, string | HTMLElement]>): HTMLElement {
        const doc = this.el.ownerDocument;
        const dl = doc.createElement('dl');
        dl.className = 'vela-sim-grid';
        for (const [label, value] of rows) {
            const dt = doc.createElement('dt');
            dt.textContent = this.ctx.i18n.t(label);
            const dd = doc.createElement('dd');
            if (typeof value === 'string') dd.textContent = value;
            else dd.append(value);
            dl.append(dt, dd);
        }
        return dl;
    }

    private note(text: MessageLike, className = 'vela-sim-note'): HTMLElement {
        return Object.assign(this.el.ownerDocument.createElement('p'), { className, textContent: this.ctx.i18n.t(text) });
    }

    private renderOrder(): void {
        const page = this.pages.order;
        const tr = this.ctx.i18n;
        page.replaceChildren();
        if (!this.replayActive) {
            page.append(this.note(TEXT.needReplay));
            const start = createButton({ text: tr.t(TEXT.startReplay), icon: 'replay', variant: 'secondary', onClick: () => replayControlsOf(this.ctx)?.armPick() });
            page.append(start.el);
            return;
        }
        const sides = this.el.ownerDocument.createElement('div');
        sides.className = 'vela-sim-sides';
        const buy = createButton({ text: tr.t(TEXT.buy), variant: 'up', onClick: () => void this.openDraft('long') });
        const sell = createButton({ text: tr.t(TEXT.sell), variant: 'down', onClick: () => void this.openDraft('short') });
        sides.append(buy.el, sell.el);
        page.append(sides);
        const chart = this.chart;
        const draft = this.draft;
        const lv = chart && draft ? levelsOf(chart, draft.drawingId) : null;
        if (!lv || !this.lastBar) return;
        const entry = this.lastBar.close;
        const risk = Math.abs(entry - lv.sl);
        const reward = Math.abs(lv.tp - entry);
        const pip = (chart && this.pips.get(chart.market.symbol ?? '')) || this.pip || 10 ** -this.decimals;
        const side = this.el.ownerDocument.createElement('span');
        side.className = 'vela-sim-side';
        side.dataset.side = lv.side;
        side.textContent = tr.t(lv.side === 'long' ? TEXT.long : TEXT.short);
        page.append(this.note(TEXT.draftHint));
        page.append(
            this.grid([
                [TEXT.side, side],
                [TEXT.entry, this.fmtPrice(entry)],
                [TEXT.stop, this.fmtPrice(lv.sl)],
                [TEXT.target, this.fmtPrice(lv.tp)],
                [TEXT.risk, tr.t(TEXT.pips, { value: this.fmtNum(risk / pip, 1) })],
                [TEXT.reward, tr.t(TEXT.pips, { value: this.fmtNum(reward / pip, 1) })],
                [TEXT.rr, `1 : ${this.fmtNum(risk > 0 ? reward / risk : 0)}`],
            ]),
        );
        if (this.warning) page.append(this.note(this.warning, 'vela-sim-warn'));
        const actions = this.el.ownerDocument.createElement('div');
        actions.className = 'vela-sim-actions';
        actions.append(
            createButton({ text: tr.t(TEXT.place), variant: 'default', onClick: () => this.placeDraft() }).el,
            createButton({ text: tr.t(TEXT.cancel), variant: 'ghost', onClick: () => this.cancelDraft() }).el,
        );
        page.append(actions);
    }

    private tradeCard(trade: SimTrade, kind: 'open' | 'closed'): HTMLElement {
        const doc = this.el.ownerDocument;
        const tr = this.ctx.i18n;
        const card = doc.createElement('div');
        card.className = 'vela-sim-trade';
        card.dataset.trade = trade.id;
        const title = doc.createElement('span');
        title.className = 'vela-sim-trade-title';
        const side = doc.createElement('span');
        side.className = 'vela-sim-side';
        side.dataset.side = trade.side;
        side.textContent = tr.t(trade.side === 'long' ? TEXT.long : TEXT.short);
        title.append(side, ` ${trade.symbol} · ${trade.timeframe}`);
        const decimals = priceDecimals(trade.entry, trade.pip);
        let r: number;
        let pips: number;
        if (kind === 'open') {
            const now = this.lastBar?.close ?? trade.entry;
            const probe = { ...trade, exit: now };
            r = resultR(probe);
            pips = resultPips(probe, this.pips.pipOf(probe));
        } else {
            r = resultR(trade);
            pips = resultPips(trade, this.pips.pipOf(trade));
        }
        const rEl = this.signed(Object.assign(doc.createElement('span'), { className: 'vela-sim-num', textContent: `${this.fmtNum(r)}R` }), r);
        const action =
            kind === 'open'
                ? createButton({ text: tr.t(TEXT.close), size: 'xs', variant: 'outline', onClick: () => this.closeTrade(trade.id) }).el
                : createButton({ icon: 'trash', size: 'icon-xs', variant: 'ghost', label: tr.t(TEXT.remove), onClick: () => this.engine.removeFromHistory(trade.id) }).el;
        const sub = doc.createElement('span');
        sub.className = 'vela-sim-trade-sub';
        const outcome = trade.outcome ? ` · ${tr.t(trade.outcome === 'tp' ? TEXT.outcomeTp : trade.outcome === 'sl' ? TEXT.outcomeSl : TEXT.outcomeManual)}` : '';
        const exit = trade.exit !== undefined ? ` → ${this.fmtPrice(trade.exit, decimals)}` : '';
        sub.textContent =
            `${this.fmtPrice(trade.entry, decimals)}${exit} · ${tr.t(TEXT.pips, { value: this.fmtNum(pips, 1) })} · ` +
            `SL ${this.fmtPrice(trade.sl, decimals)} · TP ${this.fmtPrice(trade.tp, decimals)} · 1:${this.fmtNum(plannedRR(trade))}${outcome}`;
        card.append(title, rEl, action, sub);
        return card;
    }

    private renderPositions(): void {
        const page = this.pages.positions;
        page.replaceChildren();
        const open = this.engine.openTrades;
        if (!open.length) {
            page.append(this.note(TEXT.noPositions));
            return;
        }
        const list = Object.assign(this.el.ownerDocument.createElement('div'), { className: 'vela-sim-list' });
        list.append(...open.map((t) => this.tradeCard(t, 'open')));
        page.append(list);
    }

    private renderHistory(): void {
        const page = this.pages.history;
        const tr = this.ctx.i18n;
        page.replaceChildren();
        const trades = [...this.engine.history].reverse();
        if (!trades.length) {
            this.confirmClear = false;
            page.append(this.note(TEXT.noHistory));
            return;
        }
        const list = Object.assign(this.el.ownerDocument.createElement('div'), { className: 'vela-sim-list' });
        list.append(...trades.map((t) => this.tradeCard(t, 'closed')));
        const footer = Object.assign(this.el.ownerDocument.createElement('div'), { className: 'vela-sim-footer' });
        footer.append(
            createButton({
                text: tr.t(this.confirmClear ? TEXT.confirmClear : TEXT.clearAll),
                size: 'sm',
                variant: this.confirmClear ? 'destructive' : 'outline',
                onClick: () => {
                    if (this.confirmClear) {
                        this.confirmClear = false;
                        this.engine.clearHistory();
                    } else {
                        this.confirmClear = true;
                        this.render();
                    }
                },
            }).el,
        );
        page.append(list, footer);
    }

    private renderStats(): void {
        this.statsView.render(this.engine.history, this.chart?.market.symbol ?? '');
    }

    destroy(): void {
        this.statsView.destroy();
        for (const off of this.chartOffs.splice(0)) off();
        for (const off of this.offs.splice(0)) off();
        this.tabs.destroy();
        this.el.remove();
    }
}

let installed = false;

/** Register the trading simulator panel and its saved history. Idempotent. */
export function installTradingSimulator(): void {
    if (installed) return;
    installed = true;
    registerSidePanel({
        id: 'vela.tradingSim',
        title: TEXT.title,
        icon: 'trade',
        order: 40,
        width: 320,
        resizable: true,
        minWidth: 280,
        maxWidth: 560,
        mount(ctx, body) {
            const view = new TradingSimView(ctx, simulatorOf(ctx), pipSizesOf(ctx));
            body.append(view.el);
            return {
                onChart: (chart) => view.bindChart(chart),
                destroy: () => view.destroy(),
            };
        },
    });

    registerStatePersistence({
        key: 'vela.tradingSim',
        scope: 'global',
        serialize: (ctx) => {
            const e = simulatorOf(ctx);
            const pipSizes = pipSizesOf(ctx).toJSON();
            return e.history.length || Object.keys(pipSizes).length ? { ...e.toJSON(), pipSizes } : undefined;
        },
        restore: (payload, ctx) => {
            simulatorOf(ctx).restoreHistory(payload);
            pipSizesOf(ctx).restore((payload as { pipSizes?: unknown } | null)?.pipSizes);
        },
    });
}
