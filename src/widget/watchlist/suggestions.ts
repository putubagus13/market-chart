// What the watchlist's search box offers while the user types: matching symbols from the sources' indexes,
// minus the ones already in the list. Pure.
import type { SymbolDescriptor } from '../../core/ports/DataProvider';
import { isGroupRow } from '../../data/symbol-groups';
import { filterSymbols } from '../symbol-picker';

/**
 * Up to `limit` symbols for `query` (ticker or name; empty = the majors first), skipping group rows (not loadable
 * on their own) and every ticker in `taken` (upper-case). With `prefer` (a provider id, normally the chart's own),
 * that source's matches come first.
 */
export function suggestSymbols(list: readonly SymbolDescriptor[], query: string, taken: ReadonlySet<string>, limit = 8, prefer?: string): SymbolDescriptor[] {
    const loadable = list.filter((s) => !isGroupRow(s));
    // A wide window, so a coin with dozens of pairs still reaches its USDT pair before the cut.
    const matches = filterSymbols(loadable, query, WINDOW).filter((s) => !taken.has(s.ticker.toUpperCase()));
    const q = query.trim().toUpperCase();
    const home = (s: SymbolDescriptor): number => (prefer !== undefined && s.provider === prefer ? 0 : 1);
    return (q ? [...matches].sort((a, b) => home(a) - home(b) || rank(a, q) - rank(b, q)) : matches).slice(0, limit); // stable: ties keep the index's order
}

const WINDOW = 200;
/** Quote currencies people most likely mean, best first. */
const QUOTES = ['USDT', 'USDC', 'USD', 'FDUSD'];

/** Lower is better: the exact ticker, then the base coin paired with a favoured quote, then the rest of the prefix matches. */
function rank(s: SymbolDescriptor, q: string): number {
    const t = s.ticker.toUpperCase();
    if (t === q) return 0;
    if (t.startsWith(q)) {
        const quote = QUOTES.findIndex((c) => t === q + c);
        return quote >= 0 ? 1 + quote : 10;
    }
    return 20; // matched inside the ticker or on the name: after every prefix match, in the index's order
}

/**
 * The string to store for a suggestion: the bare ticker when its provider is the one the ticker already resolves
 * to (`resolvesTo`), else `provider:ticker`, so the same ticker on two venues stays unambiguous.
 */
export function symbolFor(s: SymbolDescriptor, resolvesTo: string | undefined): string {
    return s.provider && s.provider !== resolvesTo ? `${s.provider}:${s.ticker}` : s.ticker;
}
