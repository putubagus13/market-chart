// What the workspace restores from localStorage must not overrule what this visit asked for.
// A saved chart carries its own symbol and its renderer colours, and both can be wrong today:
// the source it was saved on may be blocked on this network, and its colours may belong to the
// other theme (the orchestrator thinks the theme already matches, so a later setTheme is a no-op).
// So the saved document is corrected on its way in. Pure, apart from the storage it wraps.
import type { VelaStorage } from '../src/widget';
import { SOURCES, type Reachability, type Source, type SourceId } from './source';

export interface SavedStateContext {
    /** Background colour of the theme this visit asked for. */
    themeBackground: string;
    reachable: Reachability;
    /** The source to move a stranded chart to; null when none is reachable. */
    fallback: Source | null;
}

const KNOWN: ReadonlySet<string> = new Set(SOURCES.map((s) => s.id));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function sanitizeSavedState(raw: string, ctx: SavedStateContext): string {
    let doc: unknown;
    try {
        doc = JSON.parse(raw);
    } catch {
        return raw;
    }
    if (!isRecord(doc) || !Array.isArray(doc.charts)) return raw;

    for (const chart of doc.charts) {
        if (!isRecord(chart)) continue;

        // Colours saved under the other theme: drop them, so the chart is built from the requested theme.
        const config = chart.rendererConfig;
        const saved = isRecord(config) && isRecord(config.layout) ? config.layout.background : undefined;
        if (typeof saved === 'string' && saved.toLowerCase() !== ctx.themeBackground.toLowerCase()) delete chart.rendererConfig;

        // A symbol from a source this network blocks: move to one that works, keeping the timeframe.
        const provider = chart.provider;
        if (typeof provider === 'string' && KNOWN.has(provider) && ctx.reachable[provider as SourceId] === false && ctx.fallback) {
            chart.symbol = ctx.fallback.symbol;
            chart.provider = ctx.fallback.id;
        }
    }
    return JSON.stringify(doc);
}

/** Wraps a storage so that what the workspace READS is sanitized; what it writes goes through untouched. */
export function sanitizingStorage(inner: VelaStorage, ctx: SavedStateContext): VelaStorage {
    const clean = (v: string | null): string | null => (v === null ? null : sanitizeSavedState(v, ctx));
    return {
        get(key) {
            const v = inner.get(key);
            return v instanceof Promise ? v.then(clean) : clean(v);
        },
        set: (key, value) => inner.set(key, value),
        ...(inner.remove ? { remove: (key: string) => inner.remove!(key) } : {}),
    };
}
