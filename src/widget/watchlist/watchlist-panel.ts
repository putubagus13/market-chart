// Watchlist — a docked side panel listing the user's symbols with their last price and the
// day's change. A click shows the symbol on the active chart; rows reorder by dragging and
// go with their remove button. The list is saved in the shell's document.
import type { Vela } from '../../Vela';
import { msg } from '../../core/i18n/message';
import type { WidgetContext } from '../contributions';
import { registerSidePanel, registerStatePersistence } from '../contributions';
import { injectChromeStyles } from '../../ui/chromeStyles';
import { css } from '@luxalgo/vela-ui/css';
import { t } from '@luxalgo/vela-ui/t';
import { registerIcon, svg16 } from '@luxalgo/vela-ui/icons';
import { createButton } from '@luxalgo/vela-ui/button';
import { createInput } from '@luxalgo/vela-ui/input';
import { baseOf, tickerIconEl } from '../symbol-icon';
import { priceDecimals } from '../price-decimals';
import { WatchlistModel, quoteFromDaily, type Quote } from './watchlist-model';

const TEXT = {
    title: msg('widget.watchlist.title', 'Watchlist'),
    addCurrent: msg('widget.watchlist.addCurrent', 'Add the chart symbol'),
    addPlaceholder: msg('widget.watchlist.addPlaceholder', 'Add symbol, then Enter'),
    notFound: msg('widget.watchlist.notFound', 'No data source lists {symbol}'),
    already: msg('widget.watchlist.already', '{symbol} is already in the watchlist'),
    remove: msg('widget.watchlist.remove', 'Remove {symbol}'),
    empty: msg('widget.watchlist.empty', 'Add symbols to follow them here.'),
    colSymbol: msg('widget.watchlist.colSymbol', 'Symbol'),
    colLast: msg('widget.watchlist.colLast', 'Last'),
    colChange: msg('widget.watchlist.colChange', 'Chg%'),
};

/** Symbols a fresh watchlist starts with, when the shell's data sources list them. */
export const WATCHLIST_DEFAULTS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
/** How often the open panel refreshes its quotes. */
const REFRESH_MS = 30_000;

registerIcon('watchlist', svg16('<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.5" cy="4" r=".9" fill="currentColor"/><circle cx="2.5" cy="8" r=".9" fill="currentColor"/><circle cx="2.5" cy="12" r=".9" fill="currentColor"/>'));

const STYLE_ID = 'vela-widget-watchlist';
const CSS = css`@layer vela.chrome {

.vela-wl:where(:not([hidden])) { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.vela-wl-add { padding: 8px; border-bottom: 1px solid ${t.border}; }
.vela-wl-head:where(:not([hidden])), .vela-wl-row:where(:not([hidden])) {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto 64px 20px;
    align-items: center;
    gap: 8px;
    padding: 0 8px;
}
.vela-wl-head { height: 26px; color: ${t.fg.muted}; font-size: 11px; border-bottom: 1px solid ${t.border.soft}; }
.vela-wl-list { flex: 1; min-height: 0; overflow-y: auto; }
.vela-wl-row { height: 34px; cursor: pointer; border-inline-start: 2px solid transparent; }
.vela-wl-row:hover { background: ${t.hover}; }
.vela-wl-row[data-active] { background: ${t.hover.strong}; border-inline-start-color: ${t.accent}; }
.vela-wl-row[data-dragging] { opacity: 0.4; }
.vela-wl-row[data-drop] { box-shadow: inset 0 2px 0 ${t.accent}; }
.vela-wl-sym:where(:not([hidden])) { display: flex; align-items: center; gap: 8px; min-width: 0; color: ${t.fg.bright}; font-weight: 600; }
.vela-wl-sym-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vela-wl-icon:where(:not([hidden])) {
    display: inline-flex; align-items: center; justify-content: center; flex: none;
    width: 18px; height: 18px; border-radius: 50%; overflow: hidden;
    color: ${t.fg.onFill}; font-size: 8px; font-weight: 700;
}
.vela-wl-icon img { width: 100%; height: 100%; }
.vela-wl-num { text-align: end; font-variant-numeric: tabular-nums; white-space: nowrap; unicode-bidi: isolate; }
.vela-wl-num[data-dir='up'] { color: ${t.up}; }
.vela-wl-num[data-dir='down'] { color: ${t.down}; }
.vela-wl-row .vela-wl-remove { visibility: hidden; }
.vela-wl-row:hover .vela-wl-remove, .vela-wl-remove:focus-visible { visibility: visible; }
.vela-wl-empty { padding: 20px 10px; text-align: center; color: ${t.fg.muted}; font-size: 12px; }

}`;

/** One watchlist per shell, keyed by its root — the panel and the saved document share it. */
const models = new WeakMap<HTMLElement, WatchlistModel>();

export function watchlistOf(ctx: Pick<WidgetContext, 'host'>): WatchlistModel {
    let m = models.get(ctx.host);
    if (!m) models.set(ctx.host, (m = new WatchlistModel()));
    return m;
}

/** The symbol a chart shows ('' before it has one). */
const symbolOf = (chart: Vela): string => chart.market.symbol ?? '';

/** Whether one of the chart's data sources lists `symbol`. */
function resolvable(chart: Vela, symbol: string): boolean {
    return chart.data.resolve(symbol) !== null;
}

/** A symbol's last price and day change, from its two newest daily bars. */
async function fetchQuote(chart: Vela, symbol: string): Promise<{ quote: Quote; decimals: number } | null> {
    const r = chart.data.resolve(symbol);
    const provider = r ? chart.data.providerInstance(r.provider) : undefined;
    if (!r || !provider) return null;
    const bars = await provider.getBars(r.ticker, 'D', { limit: 2 });
    const quote = quoteFromDaily(bars);
    if (!quote) return null;
    const info = await chart.data.symbolInfo(symbol).catch(() => undefined);
    const mintick = info?.mintick;
    return { quote, decimals: priceDecimals(quote.last, typeof mintick === 'number' ? mintick : undefined) };
}

/** The panel body: rows rebuilt from the model, quotes filled in as they arrive. */
export class WatchlistView {
    readonly el: HTMLElement;
    private readonly list: HTMLElement;
    private readonly head: HTMLElement;
    private readonly input: ReturnType<typeof createInput>;
    /** The header's "add the chart symbol" button. */
    readonly addButton: ReturnType<typeof createButton>;
    private readonly quotes = new Map<string, { quote: Quote; decimals: number }>();
    private readonly offs: Array<() => void> = [];
    private timer: ReturnType<typeof setInterval> | null = null;
    private dragFrom = -1;
    /** The panel opened at least once: quotes refresh, and a first-run list is seeded. */
    private wantsQuotes = false;
    private chartOff: (() => void) | null = null;
    private boundChart: Vela | null = null;

    constructor(private readonly ctx: WidgetContext, private readonly model: WatchlistModel) {
        injectChromeStyles(STYLE_ID, CSS);
        const doc = ctx.host.ownerDocument;
        this.el = doc.createElement('div');
        this.el.className = 'vela-wl';
        const add = doc.createElement('div');
        add.className = 'vela-wl-add';
        this.addButton = createButton({ icon: 'plus', size: 'icon-sm', variant: 'ghost', label: ctx.i18n.t(TEXT.addCurrent), onClick: () => this.addCurrent() });
        this.input = createInput({ size: 'sm', fill: true, placeholder: ctx.i18n.t(TEXT.addPlaceholder) });
        this.input.input.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            this.addTyped();
        });
        add.append(this.input.el);
        this.head = doc.createElement('div');
        this.head.className = 'vela-wl-head';
        this.list = doc.createElement('div');
        this.list.className = 'vela-wl-list';
        this.list.setAttribute('role', 'list');
        this.el.append(add, this.head, this.list);
        this.offs.push(model.subscribe(() => {
            this.ctx.stateChanged();
            this.render();
            void this.refresh();
        }));
        this.render();
    }

    /** Add the symbol the active chart shows. */
    addCurrent(): void {
        const chart = this.boundChart;
        if (chart) this.addSymbol(symbolOf(chart));
    }

    addTyped(): void {
        const raw = this.input.value.trim().toUpperCase();
        if (!raw) return;
        if (this.addSymbol(raw)) this.input.setValue('');
    }

    private addSymbol(symbol: string): boolean {
        const tr = this.ctx.i18n;
        const chart = this.boundChart;
        if (!chart) return false;
        if (!resolvable(chart, symbol)) {
            this.ctx.toast(tr.t(TEXT.notFound, { symbol }), 'error');
            return false;
        }
        if (this.model.has(symbol)) {
            this.ctx.toast(tr.t(TEXT.already, { symbol }), 'info');
            return false;
        }
        return this.model.add(symbol);
    }

    /** Fill a first-run list with the defaults the chart's sources list, the chart's own symbol first. */
    seedDefaults(): void {
        const chart = this.boundChart;
        if (!chart || this.model.touched || this.model.symbols.length > 0) return;
        this.model.seed([symbolOf(chart), ...WATCHLIST_DEFAULTS].filter((s) => s !== '' && resolvable(chart, s)));
    }

    /** Follow the active chart: its symbol marks the active row, its language the labels.
     *  The view reads no chart before this — a panel restored open mounts before any chart exists. */
    bindChart(chart: Vela): void {
        if (chart === this.boundChart) return;
        this.chartOff?.();
        this.boundChart = chart;
        const offs = [chart.on('market:changed', () => this.markActive()), chart.on('locale:changed', () => this.render())];
        this.chartOff = () => offs.forEach((off) => off());
        if (this.wantsQuotes) this.seedDefaults();
        this.render();
        void this.refresh();
        // Icons and quotes come from the providers, whose symbol index may still be loading.
        void chart.data.ready().then(() => {
            if (this.boundChart !== chart) return;
            this.render();
            void this.refresh();
        });
    }

    /** Re-read quotes for every row. */
    async refresh(): Promise<void> {
        const chart = this.boundChart;
        if (!chart) return;
        await Promise.all(
            this.model.symbols.map(async (symbol) => {
                const q = await fetchQuote(chart, symbol).catch(() => null);
                if (!q) return;
                this.quotes.set(symbol, q);
                this.paintQuote(symbol);
            }),
        );
    }

    /** Refresh now and every {@link REFRESH_MS} while the panel shows. */
    startRefreshing(): void {
        this.wantsQuotes = true;
        this.seedDefaults();
        void this.refresh();
        if (this.timer) return;
        this.timer = setInterval(() => {
            if (!this.el.isConnected || this.el.getClientRects().length === 0) return;
            void this.refresh();
        }, REFRESH_MS);
    }

    private render(): void {
        const doc = this.el.ownerDocument;
        const tr = this.ctx.i18n;
        this.input.input.placeholder = tr.t(TEXT.addPlaceholder);
        this.addButton.setText(tr.t(TEXT.addCurrent));
        this.head.replaceChildren(
            ...[TEXT.colSymbol, TEXT.colLast, TEXT.colChange].map((m, i) => {
                const span = doc.createElement('span');
                span.textContent = tr.t(m);
                if (i > 0) span.className = 'vela-wl-num';
                return span;
            }),
            doc.createElement('span'),
        );
        const symbols = this.model.symbols;
        this.head.hidden = symbols.length === 0;
        if (symbols.length === 0) {
            const empty = doc.createElement('div');
            empty.className = 'vela-wl-empty';
            empty.textContent = tr.t(TEXT.empty);
            this.list.replaceChildren(empty);
            return;
        }
        this.list.replaceChildren(...symbols.map((s, i) => this.row(s, i)));
        this.markActive();
    }

    private row(symbol: string, index: number): HTMLElement {
        const doc = this.el.ownerDocument;
        const chart = this.boundChart;
        const row = doc.createElement('div');
        row.className = 'vela-wl-row';
        row.setAttribute('role', 'listitem');
        row.dataset.symbol = symbol;
        row.draggable = true;
        row.tabIndex = 0;
        const sym = doc.createElement('span');
        sym.className = 'vela-wl-sym';
        const ticker = symbol.replace(/^[^:]*:/, '');
        const text = doc.createElement('span');
        text.className = 'vela-wl-sym-text';
        text.textContent = ticker;
        sym.append(tickerIconEl(doc, baseOf({ ticker }), ticker, 'vela-wl-icon', chart?.data.symbolIcon(symbol)), text);
        const last = doc.createElement('span');
        last.className = 'vela-wl-num vela-wl-last';
        const chg = doc.createElement('span');
        chg.className = 'vela-wl-num vela-wl-chg';
        const remove = createButton({
            icon: 'close',
            size: 'icon-xs',
            variant: 'ghost',
            label: this.ctx.i18n.t(TEXT.remove, { symbol: ticker }),
            className: 'vela-wl-remove',
            onClick: (e) => {
                e.stopPropagation();
                this.model.remove(symbol);
            },
        });
        row.append(sym, last, chg, remove.el);
        const open = (): void => this.ctx.setSymbol(symbol);
        row.addEventListener('click', open);
        row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') open();
            else if (e.key === 'Delete') this.model.remove(symbol);
        });
        row.addEventListener('dragstart', (e) => {
            this.dragFrom = index;
            row.dataset.dragging = '';
            e.dataTransfer?.setData('text/plain', symbol);
        });
        row.addEventListener('dragend', () => {
            delete row.dataset.dragging;
            this.dragFrom = -1;
        });
        row.addEventListener('dragover', (e) => {
            if (this.dragFrom < 0) return;
            e.preventDefault();
            row.dataset.drop = '';
        });
        row.addEventListener('dragleave', () => delete row.dataset.drop);
        row.addEventListener('drop', (e) => {
            e.preventDefault();
            delete row.dataset.drop;
            if (this.dragFrom >= 0) this.model.move(this.dragFrom, index);
        });
        queueMicrotask(() => this.paintQuote(symbol));
        return row;
    }

    private paintQuote(symbol: string): void {
        const row = [...this.list.querySelectorAll<HTMLElement>('.vela-wl-row')].find((r) => r.dataset.symbol === symbol);
        const q = this.quotes.get(symbol);
        if (!row || !q) return;
        const fmt = this.ctx.i18n.format;
        const last = row.querySelector<HTMLElement>('.vela-wl-last')!;
        const chg = row.querySelector<HTMLElement>('.vela-wl-chg')!;
        last.textContent = fmt.price(q.quote.last, { decimals: q.decimals });
        chg.textContent = fmt.percent(q.quote.changePercent);
        const dir = q.quote.change > 0 ? 'up' : q.quote.change < 0 ? 'down' : '';
        for (const el of [last, chg]) {
            if (dir) el.dataset.dir = dir;
            else delete el.dataset.dir;
        }
    }

    private markActive(): void {
        const chart = this.boundChart;
        if (!chart) return;
        const current = symbolOf(chart).replace(/^[^:]*:/, '').toUpperCase();
        for (const row of this.list.querySelectorAll<HTMLElement>('.vela-wl-row')) {
            const mine = (row.dataset.symbol ?? '').replace(/^[^:]*:/, '').toUpperCase();
            if (mine === current) row.dataset.active = '';
            else delete row.dataset.active;
        }
    }

    destroy(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.chartOff?.();
        for (const off of this.offs.splice(0)) off();
        this.addButton.destroy();
        this.el.remove();
    }
}

let installed = false;

/** Register the watchlist panel and its saved state. Idempotent. */
export function installWatchlist(): void {
    if (installed) return;
    installed = true;
    registerSidePanel({
        id: 'vela.watchlist',
        title: TEXT.title,
        icon: 'watchlist',
        order: 30,
        width: 300,
        resizable: true,
        minWidth: 240,
        maxWidth: 520,
        mount(ctx, body, header) {
            const view = new WatchlistView(ctx, watchlistOf(ctx));
            header.slot.append(view.addButton.el);
            body.append(view.el);
            return {
                onChart: (chart) => view.bindChart(chart),
                onOpen: () => view.startRefreshing(),
                destroy: () => view.destroy(),
            };
        },
    });

    registerStatePersistence({
        key: 'vela.watchlist',
        scope: 'global',
        serialize: (ctx) => {
            const m = watchlistOf(ctx);
            return m.touched ? m.toJSON() : undefined;
        },
        restore: (payload, ctx) => watchlistOf(ctx).restore(payload),
    });
}
