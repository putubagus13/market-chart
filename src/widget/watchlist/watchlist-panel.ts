// Watchlist — a docked side panel: the active symbol's details on top, then the user's symbols with a small
// trend line, their last price and the day's change. A click shows the symbol on the active chart; rows reorder by dragging and
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
import { WatchlistModel, quoteFromDaily, seedList, signedChange, sparklineArea, sparklinePath, tickerOf, type Quote } from './watchlist-model';
import { suggestSymbols, symbolFor } from './suggestions';
import type { SymbolDescriptor } from '../../core/ports/DataProvider';

const TEXT = {
    title: msg('widget.watchlist.title', 'Watchlist'),
    toggleSearch: msg('widget.watchlist.toggleSearch', 'Add a symbol'),
    searchPlaceholder: msg('widget.watchlist.searchPlaceholder', 'Search a symbol, e.g. ETHUSDT'),
    suggestions: msg('widget.watchlist.suggestions', 'Symbol suggestions'),
    noMatches: msg('widget.watchlist.noMatches', 'No symbol matches "{query}"'),
    onChart: msg('widget.watchlist.onChart', 'On chart'),
    notFound: msg('widget.watchlist.notFound', 'No data source lists {symbol}'),
    already: msg('widget.watchlist.already', '{symbol} is already in the watchlist'),
    remove: msg('widget.watchlist.remove', 'Remove {symbol}'),
    empty: msg('widget.watchlist.empty', 'Add symbols to follow them here.'),
    colSymbol: msg('widget.watchlist.colSymbol', 'Symbol'),
    colLast: msg('widget.watchlist.colLast', 'Last'),
    colChange: msg('widget.watchlist.colChange', 'Chg%'),
    colTrend: msg('widget.watchlist.colTrend', '24h'),
    trendLabel: msg('widget.watchlist.trendLabel', '24-hour price trend of {symbol}'),
    detailLabel: msg('widget.watchlist.detailLabel', 'Active symbol'),
};

/** Symbols a fresh watchlist starts with, when the shell's data sources list them. */
export const WATCHLIST_DEFAULTS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
/** How often the open panel refreshes its quotes. */
const REFRESH_MS = 30_000;
/** How often the active symbol's price card refreshes: one symbol, so it can afford to be livelier. */
const DETAIL_REFRESH_MS = 10_000;
/** The trend line covers the last day, one point per hour. */
const SPARK_BARS = 24;
const SPARK_W = 48;
const SPARK_H = 24;

registerIcon('watchlist', svg16('<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.5" cy="4" r=".9" fill="currentColor"/><circle cx="2.5" cy="8" r=".9" fill="currentColor"/><circle cx="2.5" cy="12" r=".9" fill="currentColor"/>'));

const STYLE_ID = 'vela-widget-watchlist';
const CSS = css`@layer vela.chrome {

.vela-wl:where(:not([hidden])) { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.vela-wl-search:where(:not([hidden])) { display: block; position: relative; padding: 8px; border-bottom: 1px solid ${t.border}; }
/* The suggestions float under the box, over the list, so opening them never moves the rows. */
.vela-wl-suggest:where(:not([hidden])) {
    position: absolute; inset-inline: 8px; top: calc(100% - 4px); z-index: ${t.z.menu};
    max-height: 264px; overflow-y: auto; border: 1px solid ${t.border}; border-radius: ${t.radius.md};
    background: ${t.bg}; box-shadow: ${t.shadow};
}
.vela-wl-sug:where(:not([hidden])) { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 6px 8px; cursor: pointer; }
.vela-wl-sug:hover, .vela-wl-sug[data-active] { background: ${t.hover.strong}; }
.vela-wl-sug-text { min-width: 0; }
.vela-wl-sug-name { color: ${t.fg.bright}; font-size: 12px; font-weight: 600; line-height: 1.25; }
.vela-wl-sug-desc { color: ${t.fg.muted}; font-size: 11px; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vela-wl-sug-tag { color: ${t.fg.muted}; font-size: 10px; border: 1px solid ${t.border}; border-radius: ${t.radius.sm}; padding: 1px 5px; white-space: nowrap; }
.vela-wl-sug-none { padding: 10px; color: ${t.fg.muted}; font-size: 12px; text-align: center; }
.vela-wl-head:where(:not([hidden])), .vela-wl-row:where(:not([hidden])) {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 48px 72px 52px;
    align-items: center;
    gap: 6px;
    padding: 0 8px;
}
.vela-wl-head { height: 26px; color: ${t.fg.muted}; font-size: 11px; border-bottom: 1px solid ${t.border.soft}; }
.vela-wl-list { flex: 1; min-height: 0; overflow-y: auto; }
.vela-wl-row { position: relative; height: 34px; cursor: pointer; border-inline-start: 2px solid transparent; border-top: 2px solid transparent; }
.vela-wl-row:hover { background: ${t.hover}; }
.vela-wl-row[data-active] { background: ${t.hover.strong}; border-inline-start-color: ${t.accent}; }
.vela-wl-row[data-dragging] { opacity: 0.4; }
.vela-wl-row[data-drop] { border-top-color: ${t.accent}; }
.vela-wl-sym:where(:not([hidden])) { display: flex; align-items: center; gap: 8px; min-width: 0; color: ${t.fg.bright}; font-weight: 600; }
.vela-wl-sym-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vela-wl-icon:where(:not([hidden])) {
    display: inline-flex; align-items: center; justify-content: center; flex: none;
    width: 18px; height: 18px; border-radius: 50%; overflow: hidden;
    color: ${t.fg.onFill}; font-size: 8px; font-weight: 700;
}
.vela-wl-icon img { width: 100%; height: 100%; }
.vela-wl-spark { display: block; width: 48px; height: 24px; overflow: visible; color: ${t.fg.muted}; }
.vela-wl-spark[data-dir='up'] { color: ${t.up}; }
.vela-wl-spark[data-dir='down'] { color: ${t.down}; }
.vela-wl-spark-line { fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.vela-wl-detail:where(:not([hidden])) { display: grid; gap: 2px; padding: 12px 12px 10px; flex: none; border-top: 1px solid ${t.border}; }
.vela-wl-detail-id:where(:not([hidden])) { display: flex; align-items: center; gap: 8px; min-width: 0; }
.vela-wl-detail-id .vela-wl-icon { width: 24px; height: 24px; font-size: 10px; }
.vela-wl-detail-name { color: ${t.fg.bright}; font-size: 14px; font-weight: 700; line-height: 1.2; }
.vela-wl-detail-desc { color: ${t.fg.muted}; font-size: 11px; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vela-wl-detail-price { margin-top: 6px; color: ${t.fg.bright}; font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.2; min-height: 1.2em; }
.vela-wl-detail-chg { font-size: 12px; font-variant-numeric: tabular-nums; color: ${t.fg.muted}; min-height: 1.4em; }
.vela-wl-detail-chg[data-dir='up'], .vela-wl-detail-price[data-dir='up'] { color: ${t.up}; }
.vela-wl-detail-chg[data-dir='down'], .vela-wl-detail-price[data-dir='down'] { color: ${t.down}; }
.vela-wl-num { text-align: end; font-variant-numeric: tabular-nums; white-space: nowrap; unicode-bidi: isolate; }
.vela-wl-num[data-dir='up'] { color: ${t.up}; }
.vela-wl-num[data-dir='down'] { color: ${t.down}; }
.vela-wl-row .vela-wl-remove { visibility: hidden; position: absolute; inset-inline-end: 4px; top: 50%; transform: translateY(-50%); background: ${t.bg}; border-radius: ${t.radius.sm}; }
.vela-wl-remove:focus-visible { visibility: visible; }
.vela-wl-row:hover .vela-wl-remove { visibility: visible; }
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

/** What a row (or the detail card) shows for one symbol. */
interface QuoteEntry {
    quote: Quote;
    decimals: number;
    /** The last day's hourly closes, oldest first; empty when the source could not give them. */
    spark: number[];
}

/**
 * A symbol's last price and day change, from its two newest daily bars, plus (unless `spark` is false) the
 * last day's hourly closes for the trend line. A source that cannot give the hourly bars still gives the quote.
 */
async function fetchQuote(chart: Vela, symbol: string, { spark = true }: { spark?: boolean } = {}): Promise<QuoteEntry | null> {
    const r = chart.data.resolve(symbol);
    const provider = r ? chart.data.providerInstance(r.provider) : undefined;
    if (!r || !provider) return null;
    const [daily, hourly] = await Promise.all([
        provider.getBars(r.ticker, 'D', { limit: 2 }),
        spark ? provider.getBars(r.ticker, '60', { limit: SPARK_BARS }).catch(() => []) : Promise.resolve([]),
    ]);
    const quote = quoteFromDaily(daily);
    if (!quote) return null;
    const info = await chart.data.symbolInfo(symbol).catch(() => undefined);
    const mintick = info?.mintick;
    return { quote, decimals: priceDecimals(quote.last, typeof mintick === 'number' ? mintick : undefined), spark: hourly.map((b) => b.close) };
}

/** "Bitcoin / TetherUS · Binance": what the symbol is and where its data comes from. */
async function describeSymbol(chart: Vela, symbol: string): Promise<string> {
    const info = await chart.data.symbolInfo(symbol).catch(() => undefined);
    const r = chart.data.resolve(symbol);
    const source = r ? chart.data.providerInstance(r.provider)?.info?.().displayName : undefined;
    return [info?.description, source].filter((x): x is string => !!x).join(' \u00b7 ');
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Gradient ids must be unique in the document, and a page can hold more than one watchlist. */
let sparkIds = 0;

/** The panel body: rows rebuilt from the model, quotes filled in as they arrive. */
export class WatchlistView {
    readonly el: HTMLElement;
    private readonly list: HTMLElement;
    private readonly head: HTMLElement;
    private readonly input: ReturnType<typeof createInput>;
    /** The search box and its suggestions, shown while the "+" is pressed. */
    private readonly search: HTMLElement;
    private readonly suggest: HTMLElement;
    private searchOpen = false;
    private suggestions: SymbolDescriptor[] = [];
    private activeSuggestion = -1;
    /** ArrowDown on an empty box asks for the majors; typing is what normally opens the dropdown. */
    private dropdownForced = false;
    /** Escape or a click elsewhere closed the dropdown; typing (or focusing the box) opens it again. */
    private dropdownDismissed = false;
    private outsideOff: (() => void) | null = null;
    /** The header's "+" button: it opens and closes the search box. */
    readonly addButton: ReturnType<typeof createButton>;
    private readonly quotes = new Map<string, QuoteEntry>();
    /** The active-symbol card, above the list. */
    private readonly detail: HTMLElement;
    private readonly detailId: HTMLElement;
    private readonly detailName: HTMLElement;
    private readonly detailDesc: HTMLElement;
    private readonly detailPrice: HTMLElement;
    private readonly detailChg: HTMLElement;
    private detailSymbol = '';
    private detailIconFor = '';
    private detailQuote: QuoteEntry | null = null;
    private detailText = '';
    private detailTimer: ReturnType<typeof setInterval> | null = null;
    private readonly offs: Array<() => void> = [];
    private timer: ReturnType<typeof setInterval> | null = null;
    private dragFrom = -1;
    /** The panel opened at least once: quotes refresh, and a first-run list is seeded. */
    private wantsQuotes = false;
    /** The sources' symbol lists have loaded, so every default can be checked against them. */
    private indexReady = false;
    /** The first-run list was seeded before {@link indexReady}, so it holds only what resolved then. */
    private reseed = false;
    private chartOff: (() => void) | null = null;
    private boundChart: Vela | null = null;

    constructor(private readonly ctx: WidgetContext, private readonly model: WatchlistModel) {
        injectChromeStyles(STYLE_ID, CSS);
        const doc = ctx.host.ownerDocument;
        this.el = doc.createElement('div');
        this.el.className = 'vela-wl';
        this.search = doc.createElement('div');
        this.search.className = 'vela-wl-search';
        this.search.hidden = true;
        this.addButton = createButton({
            icon: 'plus',
            size: 'icon-sm',
            variant: 'ghost',
            label: ctx.i18n.t(TEXT.toggleSearch),
            defaultPressed: false,
            onPressedChange: (on) => this.setSearch(on),
        });
        this.input = createInput({ size: 'sm', fill: true, placeholder: ctx.i18n.t(TEXT.searchPlaceholder) });
        this.input.input.addEventListener('input', () => {
            this.dropdownDismissed = false;
            this.dropdownForced = false;
            this.activeSuggestion = this.typed() ? 0 : -1; // a typed query highlights its best match
            this.renderSuggestions();
        });
        this.input.input.addEventListener('focus', () => {
            if (!this.dropdownDismissed) return;
            this.dropdownDismissed = false;
            this.renderSuggestions();
        });
        this.input.input.addEventListener('keydown', (e) => this.onSearchKey(e));
        this.suggest = doc.createElement('div');
        this.suggest.className = 'vela-wl-suggest';
        this.suggest.setAttribute('role', 'listbox');
        this.suggest.setAttribute('aria-label', ctx.i18n.t(TEXT.suggestions));
        this.suggest.id = `vela-wl-suggest-${++sparkIds}`;
        this.suggest.hidden = true;
        this.input.input.setAttribute('role', 'combobox');
        this.input.input.setAttribute('aria-autocomplete', 'list');
        this.input.input.setAttribute('aria-expanded', 'false');
        this.input.input.setAttribute('aria-controls', this.suggest.id);
        this.search.append(this.input.el, this.suggest);
        this.head = doc.createElement('div');
        this.head.className = 'vela-wl-head';
        this.list = doc.createElement('div');
        this.list.className = 'vela-wl-list';
        this.list.setAttribute('role', 'list');
        this.detail = doc.createElement('div');
        this.detail.className = 'vela-wl-detail';
        this.detail.hidden = true;
        this.detail.setAttribute('role', 'group');
        this.detailId = doc.createElement('div');
        this.detailId.className = 'vela-wl-detail-id';
        this.detailName = doc.createElement('div');
        this.detailName.className = 'vela-wl-detail-name';
        this.detailDesc = doc.createElement('div');
        this.detailDesc.className = 'vela-wl-detail-desc';
        const names = doc.createElement('div');
        names.style.minWidth = '0';
        names.append(this.detailName, this.detailDesc);
        this.detailId.append(names);
        this.detailPrice = doc.createElement('div');
        this.detailPrice.className = 'vela-wl-detail-price';
        this.detailChg = doc.createElement('div');
        this.detailChg.className = 'vela-wl-detail-chg';
        this.detail.append(this.detailId, this.detailPrice, this.detailChg);
        this.el.append(this.search, this.head, this.list, this.detail); // the active symbol's card sits at the bottom
        this.offs.push(model.subscribe(() => {
            this.ctx.stateChanged();
            this.render();
            this.renderSuggestions(); // what is already listed is not suggested again
            void this.refresh();
        }));
        this.render();
    }

    /** What is in the search box right now (the kit's `value` only updates on commit, not while typing). */
    private typed(): string {
        return this.input.input.value.trim();
    }

    /** Show or hide the search box (the "+" button). Opening focuses it and lists suggestions at once. */
    setSearch(open: boolean): void {
        if (open === this.searchOpen && this.search.hidden === !open) return;
        this.searchOpen = open;
        this.search.hidden = !open;
        this.addButton.setPressed(open);
        this.outsideOff?.();
        this.outsideOff = null;
        this.dropdownForced = false;
        this.dropdownDismissed = false;
        this.activeSuggestion = -1;
        if (open) {
            this.renderSuggestions(); // nothing typed yet: the dropdown stays closed
            this.input.input.focus();
            // A press anywhere outside the box (and its "+") closes the dropdown, not the box.
            const doc = this.el.ownerDocument;
            const onDown = (e: Event): void => {
                const target = e.target as Node | null;
                if (!target || this.search.contains(target) || this.addButton.el.contains(target)) return;
                this.dropdownDismissed = true;
                this.renderSuggestions();
            };
            doc.addEventListener('pointerdown', onDown, true);
            this.outsideOff = () => doc.removeEventListener('pointerdown', onDown, true);
        } else {
            this.input.setValue('');
            this.suggestions = [];
            this.suggest.replaceChildren();
            this.suggest.hidden = true;
        }
    }

    private onSearchKey(e: KeyboardEvent): void {
        const dropdownOpen = !this.suggest.hidden;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (dropdownOpen) {
                // the first Escape only closes the dropdown; a second closes the box
                this.dropdownDismissed = true;
                this.dropdownForced = false;
                this.renderSuggestions();
                return;
            }
            this.setSearch(false);
            this.addButton.el.focus();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!dropdownOpen) {
                // open it (the majors, when nothing is typed) with the first row highlighted
                this.dropdownForced = true;
                this.dropdownDismissed = false;
                this.activeSuggestion = 0;
                this.renderSuggestions();
                return;
            }
            const n = this.suggestions.length;
            if (n === 0) return;
            const step = e.key === 'ArrowDown' ? 1 : -1;
            this.activeSuggestion = (this.activeSuggestion + step + n) % n;
            this.markSuggestion();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const picked = dropdownOpen ? this.suggestions[this.activeSuggestion] : undefined;
            if (picked) this.pick(picked);
            else this.addTyped();
        }
    }

    /** Rebuild the suggestion list for what is typed: the best matches, or the majors (and the chart's own symbol) when empty. */
    private renderSuggestions(): void {
        if (!this.searchOpen) return;
        const chart = this.boundChart;
        const doc = this.el.ownerDocument;
        const tr = this.ctx.i18n;
        const query = this.typed();
        // A dropdown: it opens when something is typed (or on ArrowDown), and not after Escape or a click elsewhere.
        if (this.dropdownDismissed || (query === '' && !this.dropdownForced)) {
            this.suggestions = [];
            this.suggest.replaceChildren();
            this.suggest.hidden = true;
            this.input.input.setAttribute('aria-expanded', 'false');
            this.input.input.removeAttribute('aria-activedescendant');
            return;
        }
        const taken = new Set(this.model.symbols.map(tickerOf));
        let list = chart ? suggestSymbols(chart.data.symbols(), query, taken, 8, chart.data.resolve(symbolOf(chart))?.provider) : [];
        // Nothing typed: the symbol on the chart comes first, if it is not in the list yet.
        let onChart = '';
        if (!query && chart) {
            const current = symbolOf(chart);
            if (current && !taken.has(tickerOf(current))) {
                onChart = tickerOf(current);
                const own: SymbolDescriptor = { ticker: current.replace(/^[^:]*:/, ''), provider: chart.data.resolve(current)?.provider };
                list = [own, ...list.filter((s) => s.ticker.toUpperCase() !== onChart)].slice(0, 8);
            }
        }
        this.suggestions = list;
        if (this.activeSuggestion >= list.length) this.activeSuggestion = list.length - 1;
        const expanded = list.length > 0 || query !== '';
        this.suggest.hidden = !expanded;
        this.input.input.setAttribute('aria-expanded', String(expanded));
        if (list.length === 0) {
            if (query) {
                const none = doc.createElement('div');
                none.className = 'vela-wl-sug-none';
                none.textContent = tr.t(TEXT.noMatches, { query });
                this.suggest.replaceChildren(none);
            } else this.suggest.replaceChildren();
            return;
        }
        this.suggest.replaceChildren(
            ...list.map((s, i) => {
                const row = doc.createElement('div');
                row.className = 'vela-wl-sug';
                row.setAttribute('role', 'option');
                row.id = `${this.suggest.id}-${i}`;
                const symbol = s.provider ? `${s.provider}:${s.ticker}` : s.ticker;
                const text = doc.createElement('div');
                text.className = 'vela-wl-sug-text';
                const name = doc.createElement('div');
                name.className = 'vela-wl-sug-name';
                name.textContent = s.ticker;
                text.append(name);
                if (s.description) {
                    const desc = doc.createElement('div');
                    desc.className = 'vela-wl-sug-desc';
                    desc.textContent = s.description;
                    text.append(desc);
                }
                const tag = doc.createElement('span');
                tag.className = 'vela-wl-sug-tag';
                tag.textContent = s.ticker.toUpperCase() === onChart ? tr.t(TEXT.onChart) : (s.prefix ?? s.provider ?? '');
                tag.hidden = tag.textContent === '';
                row.append(tickerIconEl(doc, baseOf({ ticker: s.ticker }), s.ticker, 'vela-wl-icon', chart?.data.symbolIcon(symbol)), text, tag);
                // pointerdown keeps the focus in the input, so the list stays open while the user picks
                row.addEventListener('pointerdown', (e) => e.preventDefault());
                row.addEventListener('click', () => this.pick(s));
                row.addEventListener('mousemove', () => {
                    if (this.activeSuggestion === i) return;
                    this.activeSuggestion = i;
                    this.markSuggestion(false);
                });
                return row;
            }),
        );
        this.markSuggestion(false);
    }

    private markSuggestion(scroll = true): void {
        [...this.suggest.querySelectorAll<HTMLElement>('.vela-wl-sug')].forEach((row, i) => {
            const on = i === this.activeSuggestion;
            if (on) row.dataset.active = '';
            else delete row.dataset.active;
            row.setAttribute('aria-selected', String(on));
            if (on) this.input.input.setAttribute('aria-activedescendant', row.id);
            if (on && scroll) row.scrollIntoView({ block: 'nearest' });
        });
    }

    /** Add a suggestion; the search stays open so several can be added in a row. */
    private pick(s: SymbolDescriptor): void {
        const chart = this.boundChart;
        if (!chart) return;
        if (this.addSymbol(symbolFor(s, chart.data.resolve(s.ticker)?.provider))) {
            this.input.setValue('');
            this.activeSuggestion = -1;
            this.renderSuggestions();
            this.input.input.focus();
        }
    }

    addTyped(): void {
        const raw = this.typed().toUpperCase();
        if (!raw) return;
        if (this.addSymbol(raw)) {
            this.input.setValue('');
            this.activeSuggestion = -1;
            this.renderSuggestions();
        }
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
    seedDefaults(again = false): void {
        const chart = this.boundChart;
        if (!chart || this.model.touched || (!again && this.model.symbols.length > 0)) return;
        // Before the sources' symbol lists load, only the chart's own symbol resolves: seed again when they are in.
        if (!this.indexReady) this.reseed = true;
        this.model.seed(seedList(symbolOf(chart), WATCHLIST_DEFAULTS, (s) => resolvable(chart, s)));
    }

    /** Follow the active chart: its symbol marks the active row, its language the labels.
     *  The view reads no chart before this — a panel restored open mounts before any chart exists. */
    bindChart(chart: Vela): void {
        if (chart === this.boundChart) return;
        this.chartOff?.();
        this.boundChart = chart;
        const offs = [
            chart.on('market:changed', () => {
                this.markActive();
                void this.refreshDetail();
            }),
            chart.on('locale:changed', () => {
                this.render();
                this.renderDetail();
            }),
        ];
        this.chartOff = () => offs.forEach((off) => off());
        this.indexReady = false;
        if (this.wantsQuotes) this.seedDefaults();
        this.render();
        void this.refresh();
        void this.refreshDetail();
        // Icons and quotes come from the providers, whose symbol index may still be loading.
        void chart.data.ready().then(() => {
            if (this.boundChart !== chart) return;
            this.indexReady = true;
            this.renderSuggestions(); // the symbol lists are in: suggest from them
            if (this.reseed && this.wantsQuotes) {
                this.reseed = false;
                this.seedDefaults(true);
            }
            this.render();
            void this.refresh();
            this.detailIconFor = ''; // the icon URL may only be known now
            void this.refreshDetail();
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
        void this.refreshDetail();
        this.detailTimer = setInterval(() => {
            if (!this.el.isConnected || this.el.getClientRects().length === 0) return;
            void this.refreshDetail();
        }, DETAIL_REFRESH_MS);
    }

    /** Re-read the active symbol's card: its name at once, its price and change when they arrive. */
    async refreshDetail(): Promise<void> {
        const chart = this.boundChart;
        if (!chart || !this.wantsQuotes) return; // a panel nobody opened asks the sources for nothing
        const symbol = symbolOf(chart);
        if (symbol !== this.detailSymbol) {
            this.detailSymbol = symbol;
            this.detailQuote = null;
            this.detailText = '';
        }
        this.renderDetail();
        if (!symbol) return;
        const [quote, text] = await Promise.all([fetchQuote(chart, symbol, { spark: false }).catch(() => null), describeSymbol(chart, symbol).catch(() => '')]);
        if (this.boundChart !== chart || symbolOf(chart) !== symbol) return; // the chart moved on while we waited
        if (quote) this.detailQuote = quote;
        if (text) this.detailText = text;
        this.renderDetail();
    }

    private renderDetail(): void {
        const symbol = this.detailSymbol;
        this.detail.hidden = symbol === '';
        if (symbol === '') return;
        const doc = this.el.ownerDocument;
        const ticker = symbol.replace(/^[^:]*:/, '');
        this.detail.setAttribute('aria-label', this.ctx.i18n.t(TEXT.detailLabel));
        this.detailName.textContent = ticker;
        this.detailDesc.textContent = this.detailText;
        this.detailDesc.hidden = this.detailText === '';
        if (this.detailIconFor !== symbol) {
            this.detailIconFor = symbol;
            this.detailId.querySelector('.vela-wl-icon')?.remove();
            this.detailId.prepend(tickerIconEl(doc, baseOf({ ticker }), ticker, 'vela-wl-icon', this.boundChart?.data.symbolIcon(symbol)));
        }
        const q = this.detailQuote;
        if (!q) {
            this.detailPrice.textContent = '';
            this.detailChg.textContent = '';
            delete this.detailPrice.dataset.dir;
            delete this.detailChg.dataset.dir;
            return;
        }
        const fmt = this.ctx.i18n.format;
        const dir = q.quote.change > 0 ? 'up' : q.quote.change < 0 ? 'down' : '';
        this.detailPrice.textContent = fmt.price(q.quote.last, { decimals: q.decimals });
        this.detailChg.textContent = `${signedChange(q.quote.change, (abs) => fmt.price(abs, { decimals: q.decimals }))} (${fmt.percent(q.quote.changePercent, { signed: true })})`;
        for (const el of [this.detailPrice, this.detailChg]) {
            if (dir) el.dataset.dir = dir;
            else delete el.dataset.dir;
        }
    }

    private render(): void {
        const doc = this.el.ownerDocument;
        const tr = this.ctx.i18n;
        this.input.input.placeholder = tr.t(TEXT.searchPlaceholder);
        this.addButton.setText(tr.t(TEXT.toggleSearch));
        this.suggest.setAttribute('aria-label', tr.t(TEXT.suggestions));
        this.head.replaceChildren(
            ...[TEXT.colSymbol, TEXT.colTrend, TEXT.colLast, TEXT.colChange].map((m, i) => {
                const span = doc.createElement('span');
                span.textContent = tr.t(m);
                if (i === 1) span.className = 'vela-wl-trend-head';
                else if (i > 1) span.className = 'vela-wl-num';
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
        const spark = doc.createElementNS(SVG_NS, 'svg');
        spark.setAttribute('class', 'vela-wl-spark');
        spark.setAttribute('viewBox', `0 0 ${SPARK_W} ${SPARK_H}`);
        spark.setAttribute('role', 'img');
        spark.setAttribute('aria-label', this.ctx.i18n.t(TEXT.trendLabel, { symbol: ticker }));
        // An area chart: a gradient that fades from the trend's colour to nothing under the line, then the line itself.
        const gradId = `vela-wl-grad-${++sparkIds}`;
        const defs = doc.createElementNS(SVG_NS, 'defs');
        const grad = doc.createElementNS(SVG_NS, 'linearGradient');
        grad.setAttribute('id', gradId);
        grad.setAttribute('x1', '0');
        grad.setAttribute('y1', '0');
        grad.setAttribute('x2', '0');
        grad.setAttribute('y2', '1');
        for (const [offset, opacity] of [['0', '0.38'], ['1', '0']] as const) {
            const stop = doc.createElementNS(SVG_NS, 'stop');
            stop.setAttribute('offset', offset);
            stop.setAttribute('style', `stop-color:currentColor;stop-opacity:${opacity}`);
            grad.append(stop);
        }
        defs.append(grad);
        const area = doc.createElementNS(SVG_NS, 'path');
        area.setAttribute('class', 'vela-wl-spark-area');
        area.setAttribute('fill', `url(#${gradId})`);
        const line = doc.createElementNS(SVG_NS, 'path');
        line.setAttribute('class', 'vela-wl-spark-line');
        spark.append(defs, area, line);
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
        row.append(sym, spark as unknown as HTMLElement, last, chg, remove.el); // the remove button floats over the row's end
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
        const spark = row.querySelector<SVGSVGElement>('.vela-wl-spark')!;
        spark.querySelector('.vela-wl-spark-line')!.setAttribute('d', sparklinePath(q.spark, SPARK_W, SPARK_H, 1.5));
        spark.querySelector('.vela-wl-spark-area')!.setAttribute('d', sparklineArea(q.spark, SPARK_W, SPARK_H, 1.5));
        last.textContent = fmt.price(q.quote.last, { decimals: q.decimals });
        chg.textContent = fmt.percent(q.quote.changePercent);
        const dir = q.quote.change > 0 ? 'up' : q.quote.change < 0 ? 'down' : '';
        for (const el of [last, chg, spark]) {
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
        this.outsideOff?.();
        this.outsideOff = null;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        if (this.detailTimer) clearInterval(this.detailTimer);
        this.detailTimer = null;
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
        width: 340,
        resizable: true,
        minWidth: 280,
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
