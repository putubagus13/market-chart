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
import { createToggleGroup, type ToggleGroupHandle } from '@luxalgo/vela-ui/toggle-group';
import { createInput } from '@luxalgo/vela-ui/input';
import { createSwitch } from '@luxalgo/vela-ui/switch';
import type { ButtonHandle } from '@luxalgo/vela-ui/button';
import { priceDecimals } from '../price-decimals';
import { timeframeMs } from '../timeframe';
import { replayControlsOf } from '../replay/replay-controls';
import { SimulationEngine, initialStop, pendingKind, plannedRR, resultPips, resultR, validLevels, type PendingKind, type PendingOrder, type SimTrade, type StopMove, type TradeSide } from './sim-engine';
import { SimStatsView } from './sim-stats-view';
import { PipSizes } from './pip-sizes';
import { parsePositiveNumber } from './parse-number';

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
    cancelledToast: msg('widget.sim.cancelledToast', '{count, plural, one {# open trade or order was} other {# open trades or orders were}} cancelled: the replay moved'),
    orderType: msg('widget.sim.orderType', 'Order type'),
    market: msg('widget.sim.market', 'Market'),
    limit: msg('widget.sim.limit', 'Limit'),
    limitPrice: msg('widget.sim.limitPrice', 'Limit price'),
    limitInvalid: msg('widget.sim.limitInvalid', 'A limit price must be a positive number'),
    limitAtPrice: msg('widget.sim.limitAtPrice', 'A limit price must differ from the current price. Choose Market to trade at it.'),
    kind: msg('widget.sim.kind', 'Type'),
    buyLimit: msg('widget.sim.kind.buyLimit', 'Buy limit'),
    buyStop: msg('widget.sim.kind.buyStop', 'Buy stop'),
    sellLimit: msg('widget.sim.kind.sellLimit', 'Sell limit'),
    sellStop: msg('widget.sim.kind.sellStop', 'Sell stop'),
    trailing: msg('widget.sim.trailing', 'Trailing stop'),
    trailPct: msg('widget.sim.trailPct', 'Trail distance, % of price'),
    trailInvalid: msg('widget.sim.trail.invalid', 'A trailing distance must be between 0 and 100 percent.'),
    pendingTitle: msg('widget.sim.pendingTitle', 'Pending orders'),
    openTitle: msg('widget.sim.openTitle', 'Open positions'),
    cancelOrder: msg('widget.sim.cancelOrder', 'Cancel order'),
    filledToast: msg('widget.sim.filledToast', '{symbol} order filled at {price}'),
    trailSub: msg('widget.sim.trailSub', 'Trailing {pct}%'),
    stopLoosens: msg('widget.sim.stop.loosens', 'A stop can only move closer to the price.'),
    stopPastPrice: msg('widget.sim.stop.pastPrice', 'The stop must stay beyond the current price.'),
    stopInvalid: msg('widget.sim.stop.invalid', 'A stop must be a positive price'),
    toBreakeven: msg('widget.sim.stop.toBreakeven', 'SL → break-even'),
    slWas: msg('widget.sim.slWas', 'was {price}'),
};

/** Stop distance of a new position, in average true ranges; the target sits at twice that. */
const STOP_ATR = 1;
const DEFAULT_RR = 2;
/** How far a fresh limit order starts from the price, in average true ranges. */
const LIMIT_OFFSET_ATR = 0.5;
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
/* Order form: the type switch, the limit price, the trailing stop. */
.vela-sim-form:where(:not([hidden])) { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
.vela-sim-row:where(:not([hidden])) { display: flex; align-items: center; gap: 8px; color: ${t.fg.muted}; }
.vela-sim-row > span { flex: 1; min-width: 0; }
.vela-sim-row .vela-input, .vela-sim-row [data-slot='input'] { max-width: 110px; }
.vela-sim-group { margin: 12px 0 6px; color: ${t.fg.muted}; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.vela-sim-group:first-child { margin-top: 0; }
.vela-sim-controls:where(:not([hidden])) { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; color: ${t.fg.muted}; }
.vela-sim-controls .vela-input, .vela-sim-controls [data-slot='input'] { max-width: 84px; }
.vela-sim-unit { color: ${t.fg.muted}; }
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

/** A trade's drawing: on which chart (drawing ids are per chart) and where its box sits in time. */
interface DrawingRef {
    chart: Vela;
    id: string;
    entryTime: number;
    endTime: number;
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
    private readonly drawingOf = new Map<string, DrawingRef>();
    private lastBar: OHLCV | null = null;
    private pip = 0;
    private decimals = 2;
    private readonly statsView: SimStatsView;
    private confirmClear = false;
    private warning: MessageLike | null = null;
    // ── the order form: built once, so what the user types survives a replay step ──
    private orderType: 'market' | 'limit' = 'market';
    private trailOn = false;
    private trailPct = 1;
    private formLocale = '';
    /** Set while the panel writes a stop to the chart, so the resulting edit event is not read back as the user's. */
    private syncing = false;
    /** A render of the Positions page was skipped while the user typed in it. */
    private positionsDirty = false;
    private orderNeed!: HTMLElement;
    private needNote!: HTMLElement;
    private startBtn!: ButtonHandle;
    private orderMain!: HTMLElement;
    private buyBtn!: ButtonHandle;
    private sellBtn!: ButtonHandle;
    private orderForm!: HTMLElement;
    private typeGroup!: ToggleGroupHandle;
    private limitRow!: HTMLElement;
    private limitLabel!: HTMLElement;
    private limitInput!: ReturnType<typeof createInput>;
    private trailSwitch!: ReturnType<typeof createSwitch>;
    private trailLabel!: HTMLElement;
    private trailInput!: ReturnType<typeof createInput>;
    private orderDetails!: HTMLElement;
    private orderWarning!: HTMLElement;
    private orderActions!: HTMLElement;
    private placeBtn!: ButtonHandle;
    private cancelBtn!: ButtonHandle;

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
        this.buildOrderPage();
        this.pages.positions.addEventListener('focusout', (e) => {
            // Focus moving between the page's own controls waits; leaving it catches up on what was skipped.
            if (this.positionsDirty && !this.pages.positions.contains(e.relatedTarget as Node | null)) setTimeout(() => this.render(), 0);
        });
        this.el.append(this.tabs.el, ...Object.values(this.pages));
        this.offs.push(
            engine.subscribe(() => {
                this.ctx.stateChanged();
                this.syncStopDrawings();
                this.render();
            }),
            pips.subscribe(() => {
                this.ctx.stateChanged();
                this.render();
            }),
            engine.onFill((trade) => {
                const ref = this.drawingOf.get(trade.id);
                if (ref) ref.chart.drawings.lock(ref.id, false); // a running trade's stop can be dragged
                const price = this.ctx.i18n.format.price(trade.entry, { decimals: priceDecimals(trade.entry, trade.pip) });
                this.ctx.toast(this.ctx.i18n.t(TEXT.filledToast, { symbol: trade.symbol, price }), 'info');
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
                else this.reconcileDrawing(chart, e.id);
            }),
            chart.on('drawing:removed', (e) => {
                if (e.id === this.draft?.drawingId) {
                    this.draft = null;
                    this.render();
                }
                // A trade whose drawing was deleted keeps running without one.
                for (const [tradeId, ref] of this.drawingOf) if (ref.chart === chart && ref.id === e.id) this.drawingOf.delete(tradeId);
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
        const waiting = this.engine.cancelAllPending();
        for (const t of [...dropped, ...waiting]) this.dropDrawing(this.drawingOf.get(t.id));
        this.drawingOf.clear();
        this.cancelDraft();
        this.lastBar = null;
        const count = dropped.length + waiting.length;
        if (count) this.ctx.toast(this.ctx.i18n.t(TEXT.cancelledToast, { count }), 'info');
        this.render();
    }

    private dropDrawing(ref: DrawingRef | undefined): void {
        if (!ref) return;
        ref.chart.drawings.lock(ref.id, false);
        ref.chart.drawings.remove(ref.id);
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
        const atr = averageTrueRange(bars) || last.close * 0.01;
        const d = side === 'long' ? 1 : -1;
        // A fresh limit order starts half a range on the favorable side of the price (a buy below, a
        // sell above), so placing it without typing a price waits for a pullback instead of being
        // refused for sitting on the current price.
        const entry = this.orderType === 'limit' ? last.close - d * atr * LIMIT_OFFSET_ATR : last.close;
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

    /** Choose between filling at the replay's close and waiting for a price. */
    setOrderType(type: 'market' | 'limit'): void {
        if (type === this.orderType) return;
        this.orderType = type;
        // A market order enters at the close: bring the entry handle back to it.
        if (type === 'market' && this.lastBar) this.moveEntry(this.lastBar.close);
        this.warning = null;
        this.render();
    }

    /** Set the limit price: the entry line on the chart moves to it. */
    setLimitPrice(price: number): void {
        if (!Number.isFinite(price) || price <= 0) return;
        this.moveEntry(price);
        this.warning = null;
        this.render();
    }

    /** The order form's trailing stop: on or off, and optionally its distance in percent of price. */
    setTrail(on: boolean, pct?: number): void {
        this.trailOn = on;
        if (pct !== undefined && pct > 0 && pct < 100) this.trailPct = pct;
        this.render();
    }

    private moveEntry(price: number): void {
        const chart = this.chart;
        const draft = this.draft;
        const d = chart && draft ? chart.drawings.all().find((x) => x.id === draft.drawingId) : null;
        const [entry, ...rest] = d?.anchors ?? [];
        if (!chart || !draft || !entry) return;
        chart.drawings.update(draft.drawingId, { anchors: [{ ...entry, price }, ...rest] });
    }

    /** Place the draft: a market order fills at the replay's close; a limit order waits for its price. */
    placeDraft(): void {
        const chart = this.chart;
        const draft = this.draft;
        const last = this.lastBar;
        if (!chart || !draft || !last) return;
        const lv = levelsOf(chart, draft.drawingId);
        if (!lv) return;
        const limit = this.orderType === 'limit';
        const pip = this.pip || 10 ** -this.decimals;
        if (limit && Math.abs(lv.entry - last.close) < pip / 2) {
            this.warning = TEXT.limitAtPrice;
            this.render();
            return;
        }
        // A market order fills at the current close, wherever the entry handle was dragged.
        const order = { side: lv.side, entry: limit ? lv.entry : last.close, sl: lv.sl, tp: lv.tp };
        if (!validLevels(order)) {
            this.warning = TEXT.wrongSide;
            this.render();
            return;
        }
        const { symbol = '', timeframe = '' } = chart.market;
        const full = { ...order, symbol, timeframe, openTime: last.time, pip, trailPct: this.trailOn ? this.trailPct : undefined };
        const placed = limit ? this.engine.placePending(full, last.close) : this.engine.place(full);
        if (!placed) return;
        const d = chart.drawings.all().find((x) => x.id === draft.drawingId);
        if (d && d.anchors[0] && Math.abs(d.anchors[0].price - order.entry) > 0) {
            chart.drawings.update(draft.drawingId, { anchors: [{ ...d.anchors[0], price: order.entry }, ...d.anchors.slice(1)] });
        }
        // A pending order is final (cancel to change it); a running trade keeps its stop draggable.
        chart.drawings.lock(draft.drawingId, limit);
        const [entryAnchor, endAnchor] = chart.drawings.all().find((x) => x.id === draft.drawingId)?.anchors ?? [];
        if (entryAnchor && endAnchor) this.drawingOf.set(placed.id, { chart, id: draft.drawingId, entryTime: entryAnchor.time, endTime: endAnchor.time });
        this.draft = null;
        this.warning = null;
        this.tabs.setValue('positions');
        this.render();
    }

    /** Tighten a running trade's stop; the reason is shown when it is refused. */
    moveStop(id: string, sl: number): StopMove {
        const last = this.lastBar;
        if (!last) return 'unknown';
        const result = this.engine.moveStop(id, sl, last.close);
        if (result === 'loosens') this.ctx.toast(this.ctx.i18n.t(TEXT.stopLoosens), 'error');
        else if (result === 'past-price') this.ctx.toast(this.ctx.i18n.t(TEXT.stopPastPrice), 'error');
        return result;
    }

    stopToBreakeven(id: string): StopMove {
        const trade = this.engine.openTrades.find((t) => t.id === id);
        return trade ? this.moveStop(id, trade.entry) : 'unknown';
    }

    /** Trail a running trade's stop by `pct` percent of price, or stop trailing with null. */
    setTradeTrail(id: string, pct: number | null): boolean {
        const ok = this.engine.setTrail(id, pct);
        if (!ok && pct !== null) this.ctx.toast(this.ctx.i18n.t(TEXT.trailInvalid), 'error');
        return ok;
    }

    /** Draw each running trade's stop where the trade holds it (a trail, a typed value, or break-even moved it). */
    private syncStopDrawings(): void {
        for (const t of this.engine.openTrades) {
            const ref = this.drawingOf.get(t.id);
            const d = ref?.chart.drawings.all().find((x) => x.id === ref.id);
            const [entry, stop, target] = d?.anchors ?? [];
            if (!ref || !entry || !stop || !target || (stop.price === t.sl && stop.time === ref.endTime)) continue;
            this.syncing = true;
            try {
                ref.chart.drawings.update(ref.id, { anchors: [entry, { time: ref.endTime, price: t.sl }, target] });
            } finally {
                this.syncing = false;
            }
        }
    }

    /**
     * The user edited a running trade's drawing: only the stop is theirs to move, and only by the stop
     * rule. Moving the entry or the target, or the whole box, is not a stop edit: every anchor goes
     * back, times included, and the stop stays where the trade holds it.
     */
    private reconcileDrawing(chart: Vela, drawingId: string): void {
        if (this.syncing) return;
        const found = [...this.drawingOf].find(([, r]) => r.chart === chart && r.id === drawingId);
        const trade = this.engine.openTrades.find((t) => t.id === found?.[0]);
        const ref = found?.[1];
        const d = chart.drawings.all().find((x) => x.id === drawingId);
        const [entry, stop, target] = d?.anchors ?? [];
        if (!trade || !ref || !entry || !stop || !target) return;
        const boxMoved = entry.price !== trade.entry || entry.time !== ref.entryTime || target.price !== trade.tp || target.time !== ref.endTime;
        this.syncing = true;
        try {
            if (!boxMoved && stop.price !== trade.sl) this.moveStop(trade.id, stop.price);
            const sl = (this.engine.openTrades.find((t) => t.id === trade.id) ?? trade).sl;
            if (boxMoved || stop.price !== sl || stop.time !== ref.endTime) {
                chart.drawings.update(drawingId, {
                    anchors: [
                        { time: ref.entryTime, price: trade.entry },
                        { time: ref.endTime, price: sl },
                        { time: ref.endTime, price: trade.tp },
                    ],
                });
            }
        } finally {
            this.syncing = false;
        }
    }

    cancelPendingOrder(id: string): void {
        if (!this.engine.cancelPending(id)) return;
        this.dropDrawing(this.drawingOf.get(id));
        this.drawingOf.delete(id);
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

    /** Build the Order page once: its controls keep their focus and typed text across replay steps. */
    private buildOrderPage(): void {
        const doc = this.ctx.host.ownerDocument;
        const el = (tag: string, className: string): HTMLElement => Object.assign(doc.createElement(tag), { className });
        const page = this.pages.order;

        this.orderNeed = el('div', 'vela-sim-need');
        this.needNote = el('p', 'vela-sim-note');
        this.startBtn = createButton({ icon: 'replay', variant: 'secondary', text: ' ', onClick: () => replayControlsOf(this.ctx)?.armPick() });
        this.orderNeed.append(this.needNote, this.startBtn.el);

        this.orderMain = el('div', 'vela-sim-main');
        const sides = el('div', 'vela-sim-sides');
        this.buyBtn = createButton({ text: ' ', variant: 'up', onClick: () => void this.openDraft('long') });
        this.sellBtn = createButton({ text: ' ', variant: 'down', onClick: () => void this.openDraft('short') });
        sides.append(this.buyBtn.el, this.sellBtn.el);

        this.orderForm = el('div', 'vela-sim-form');
        this.typeGroup = createToggleGroup({ items: this.typeItems(), size: 'sm', fill: true, defaultValue: 'market', onValueChange: (v) => this.setOrderType(v === 'limit' ? 'limit' : 'market') });
        this.limitRow = el('div', 'vela-sim-row');
        this.limitLabel = doc.createElement('span');
        this.limitInput = createInput({ size: 'sm' });
        this.limitInput.input.inputMode = 'decimal';
        this.limitInput.input.addEventListener('change', () => this.commitLimit(this.limitInput.input.value));
        this.limitRow.append(this.limitLabel, this.limitInput.el);
        const trailRow = el('div', 'vela-sim-row');
        this.trailSwitch = createSwitch({ onCheckedChange: (on) => this.setTrail(on) });
        this.trailLabel = doc.createElement('span');
        this.trailInput = createInput({ size: 'sm' });
        this.trailInput.input.inputMode = 'decimal';
        this.trailInput.input.addEventListener('change', () => this.commitTrail(this.trailInput.input.value));
        trailRow.append(this.trailSwitch.el, this.trailLabel, this.trailInput.el, Object.assign(doc.createElement('span'), { className: 'vela-sim-unit', textContent: '%' }));
        this.orderForm.append(this.typeGroup.el, this.limitRow, trailRow);

        this.orderDetails = el('div', 'vela-sim-details');
        this.orderWarning = el('p', 'vela-sim-note vela-sim-warn');
        this.orderActions = el('div', 'vela-sim-actions');
        this.placeBtn = createButton({ text: ' ', variant: 'default', onClick: () => this.placeDraft() });
        this.cancelBtn = createButton({ text: ' ', variant: 'ghost', onClick: () => this.cancelDraft() });
        this.orderActions.append(this.placeBtn.el, this.cancelBtn.el);

        this.orderMain.append(sides, this.orderForm, this.orderDetails, this.orderWarning, this.orderActions);
        page.append(this.orderNeed, this.orderMain);
    }

    private typeItems() {
        const tr = this.ctx.i18n;
        return [
            { value: 'market', label: tr.t(TEXT.market) },
            { value: 'limit', label: tr.t(TEXT.limit) },
        ];
    }

    private commitLimit(text: string): void {
        const price = parsePositiveNumber(text);
        if (price === null) this.ctx.toast(this.ctx.i18n.t(TEXT.limitInvalid), 'error');
        else this.setLimitPrice(price);
        this.render();
    }

    private commitTrail(text: string): void {
        const pct = parsePositiveNumber(text);
        if (pct === null || pct >= 100) this.ctx.toast(this.ctx.i18n.t(TEXT.trailInvalid), 'error');
        else this.setTrail(this.trailOn, pct);
        this.render();
    }

    private kindLabel(side: TradeSide, kind: PendingKind): MessageLike {
        const limit = kind === 'limit';
        return side === 'long' ? (limit ? TEXT.buyLimit : TEXT.buyStop) : limit ? TEXT.sellLimit : TEXT.sellStop;
    }

    private renderOrder(): void {
        const tr = this.ctx.i18n;
        const active = this.replayActive;
        this.needNote.textContent = tr.t(TEXT.needReplay);
        this.startBtn.setText(tr.t(TEXT.startReplay));
        this.orderNeed.hidden = active;
        this.orderMain.hidden = !active;
        // Labels are set whether or not the form shows: a hidden control still reads in the current language.
        this.buyBtn.setText(tr.t(TEXT.buy));
        this.sellBtn.setText(tr.t(TEXT.sell));
        this.placeBtn.setText(tr.t(TEXT.place));
        this.cancelBtn.setText(tr.t(TEXT.cancel));
        // Relabel the toggle only when the language changed (a rebuilt toggle loses keyboard focus).
        if (this.formLocale !== tr.locale) {
            this.formLocale = tr.locale;
            this.typeGroup.setItems(this.typeItems());
            this.typeGroup.setValue(this.orderType);
        }
        this.limitLabel.textContent = tr.t(TEXT.limitPrice);
        this.trailLabel.textContent = tr.t(TEXT.trailing);
        this.trailSwitch.el.querySelector('input')?.setAttribute('aria-label', tr.t(TEXT.trailing));
        this.limitInput.input.setAttribute('aria-label', tr.t(TEXT.limitPrice));
        this.trailInput.input.setAttribute('aria-label', tr.t(TEXT.trailPct));
        this.trailInput.input.title = tr.t(TEXT.trailPct);
        if (!active) return;
        this.orderWarning.textContent = this.warning ? tr.t(this.warning) : '';
        this.orderWarning.hidden = !this.warning;

        const chart = this.chart;
        const draft = this.draft;
        const lv = chart && draft ? levelsOf(chart, draft.drawingId) : null;
        const last = this.lastBar;
        const hasDraft = !!(lv && last);
        this.orderForm.hidden = !hasDraft;
        this.orderDetails.hidden = !hasDraft;
        this.orderActions.hidden = !hasDraft;
        if (!lv || !last) return;

        this.typeGroup.setValue(this.orderType);
        this.limitRow.hidden = this.orderType !== 'limit';
        if (this.trailSwitch.checked !== this.trailOn) this.trailSwitch.setChecked(this.trailOn);
        const doc = this.ctx.host.ownerDocument;
        if (doc.activeElement !== this.limitInput.input) this.limitInput.input.value = lv.entry.toFixed(this.decimals);
        if (doc.activeElement !== this.trailInput.input) this.trailInput.input.value = String(this.trailPct);
        this.trailInput.input.disabled = !this.trailOn;

        const entry = this.orderType === 'limit' ? lv.entry : last.close;
        const risk = Math.abs(entry - lv.sl);
        const reward = Math.abs(lv.tp - entry);
        const pip = (chart && this.pips.get(chart.market.symbol ?? '')) || this.pip || 10 ** -this.decimals;
        const side = this.el.ownerDocument.createElement('span');
        side.className = 'vela-sim-side';
        side.dataset.side = lv.side;
        side.textContent = tr.t(lv.side === 'long' ? TEXT.long : TEXT.short);
        this.orderDetails.replaceChildren(
            this.note(TEXT.draftHint),
            this.grid([
                [TEXT.side, side],
                [TEXT.kind, tr.t(this.orderType === 'limit' ? this.kindLabel(lv.side, pendingKind(lv.side, entry, last.close)) : TEXT.market)],
                [TEXT.entry, this.fmtPrice(entry)],
                [TEXT.stop, this.fmtPrice(lv.sl)],
                [TEXT.target, this.fmtPrice(lv.tp)],
                [TEXT.risk, tr.t(TEXT.pips, { value: this.fmtNum(risk / pip, 1) })],
                [TEXT.reward, tr.t(TEXT.pips, { value: this.fmtNum(reward / pip, 1) })],
                [TEXT.rr, `1 : ${this.fmtNum(risk > 0 ? reward / risk : 0)}`],
            ]),
        );
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
        const was = trade.sl !== initialStop(trade) ? ` (${tr.t(TEXT.slWas, { price: this.fmtPrice(initialStop(trade), decimals) })})` : '';
        const trail = trade.trailPct !== undefined ? ` · ${tr.t(TEXT.trailSub, { pct: String(trade.trailPct) })}` : '';
        sub.textContent =
            `${this.fmtPrice(trade.entry, decimals)}${exit} · ${tr.t(TEXT.pips, { value: this.fmtNum(pips, 1) })} · ` +
            `SL ${this.fmtPrice(trade.sl, decimals)}${was} · TP ${this.fmtPrice(trade.tp, decimals)} · 1:${this.fmtNum(plannedRR(trade))}${trail}${outcome}`;
        card.append(title, rEl, action, sub);
        if (kind === 'open') card.append(...this.stopControls(trade, decimals));
        return card;
    }

    /** The stop controls of a running trade: a stop price, break-even, and the trailing stop. */
    private stopControls(trade: SimTrade, decimals: number): HTMLElement[] {
        const doc = this.el.ownerDocument;
        const tr = this.ctx.i18n;
        const stopRow = Object.assign(doc.createElement('div'), { className: 'vela-sim-controls' });
        const trailRow = Object.assign(doc.createElement('div'), { className: 'vela-sim-controls' });
        const slInput = createInput({ size: 'sm' });
        slInput.input.inputMode = 'decimal';
        slInput.input.value = trade.sl.toFixed(decimals);
        slInput.input.setAttribute('aria-label', tr.t(TEXT.stop));
        slInput.input.addEventListener('change', () => {
            const price = parsePositiveNumber(slInput.input.value);
            if (price === null) this.ctx.toast(tr.t(TEXT.stopInvalid), 'error');
            else this.moveStop(trade.id, price);
            this.render();
        });
        const breakeven = createButton({ text: tr.t(TEXT.toBreakeven), size: 'xs', variant: 'outline', onClick: () => this.stopToBreakeven(trade.id) });
        const trailSwitch = createSwitch({ checked: trade.trailPct !== undefined, onCheckedChange: (on) => this.setTradeTrail(trade.id, on ? (trade.trailPct ?? this.trailPct) : null) });
        trailSwitch.el.querySelector('input')?.setAttribute('aria-label', tr.t(TEXT.trailing));
        const trailLabel = Object.assign(doc.createElement('span'), { textContent: tr.t(TEXT.trailing) });
        const trailInput = createInput({ size: 'sm' });
        trailInput.input.inputMode = 'decimal';
        trailInput.input.value = String(trade.trailPct ?? this.trailPct);
        trailInput.input.setAttribute('aria-label', tr.t(TEXT.trailPct));
        trailInput.input.title = tr.t(TEXT.trailPct);
        trailInput.input.addEventListener('change', () => {
            const pct = parsePositiveNumber(trailInput.input.value);
            if (pct === null || pct >= 100) this.ctx.toast(tr.t(TEXT.trailInvalid), 'error');
            else this.setTradeTrail(trade.id, pct);
            this.render();
        });
        stopRow.append(slInput.el, breakeven.el);
        trailRow.append(trailSwitch.el, trailLabel, trailInput.el, Object.assign(doc.createElement('span'), { className: 'vela-sim-unit', textContent: '%' }));
        return [stopRow, trailRow];
    }

    private pendingCard(order: PendingOrder): HTMLElement {
        const doc = this.el.ownerDocument;
        const tr = this.ctx.i18n;
        const card = doc.createElement('div');
        card.className = 'vela-sim-trade';
        card.dataset.pending = order.id;
        const title = doc.createElement('span');
        title.className = 'vela-sim-trade-title';
        const side = doc.createElement('span');
        side.className = 'vela-sim-side';
        side.dataset.side = order.side;
        side.textContent = tr.t(this.kindLabel(order.side, order.kind));
        title.append(side, ` ${order.symbol} · ${order.timeframe}`);
        const decimals = priceDecimals(order.entry, order.pip);
        const price = Object.assign(doc.createElement('span'), { className: 'vela-sim-num', textContent: this.fmtPrice(order.entry, decimals) });
        const cancel = createButton({ text: tr.t(TEXT.cancelOrder), size: 'xs', variant: 'outline', onClick: () => this.cancelPendingOrder(order.id) }).el;
        const sub = Object.assign(doc.createElement('span'), { className: 'vela-sim-trade-sub' });
        const trail = order.trailPct !== undefined ? ` · ${tr.t(TEXT.trailSub, { pct: String(order.trailPct) })}` : '';
        sub.textContent = `SL ${this.fmtPrice(order.sl, decimals)} · TP ${this.fmtPrice(order.tp, decimals)} · 1:${this.fmtNum(plannedRR(order))}${trail}`;
        card.append(title, price, cancel, sub);
        return card;
    }

    private renderPositions(): void {
        const page = this.pages.positions;
        // A replay step must not rebuild the cards under the user's typing (a text field; the trailing
        // switch is a click, not typing). The commit, or the focus leaving the page, renders again, and a
        // card whose trade is gone never holds the focus back.
        const active = this.el.ownerDocument.activeElement;
        const typing = active instanceof HTMLInputElement && active.type !== 'checkbox' && page.contains(active);
        const cardTrade = typing ? active.closest('[data-trade]')?.getAttribute('data-trade') : null;
        if (typing && (!cardTrade || this.engine.openTrades.some((t) => t.id === cardTrade))) {
            this.positionsDirty = true;
            return;
        }
        this.positionsDirty = false;
        page.replaceChildren();
        const pending = this.engine.pendingOrders;
        const open = this.engine.openTrades;
        if (!pending.length && !open.length) {
            page.append(this.note(TEXT.noPositions));
            return;
        }
        const doc = this.el.ownerDocument;
        const group = (title: MessageLike, cards: HTMLElement[]): void => {
            page.append(Object.assign(doc.createElement('h4'), { className: 'vela-sim-group', textContent: this.ctx.i18n.t(title) }));
            page.append(Object.assign(doc.createElement('div'), { className: 'vela-sim-list' }));
            page.lastElementChild!.append(...cards);
        };
        if (pending.length) group(TEXT.pendingTitle, pending.map((o) => this.pendingCard(o)));
        if (open.length) group(TEXT.openTitle, open.map((t) => this.tradeCard(t, 'open')));
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
