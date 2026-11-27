// ChartLab: the workspace as a standalone page, also meant to be embedded in an <iframe>
// by the landing site. Talks to its parent through `embed.ts` (origin-checked messages).
import { registerLocale } from '../src/core/i18n';
import { resolveTheme } from '../src/core/theme';
import { localStorageAdapter } from '../src/widget';
import indonesian from '../src/locales/id';
import { VelaWorkspace } from '../src/workspace';
import { PERSIST_KEY, buildWorkspaceOptions, takeWatchlistDefault } from './config';
import { sanitizingStorage, savedTheme } from './saved-state';
import { isAllowedParent, parseParentMessage, readEmbedParams } from './embed';
import { blockedNotice, pickSource, probeSources } from './source';

registerLocale(indonesian); // English is built in; the switch from the parent may ask for Indonesian

// A visit that names no theme (a bookmark, a typed address) follows the theme the chart was last used in, not the
// operating system's, so it looks the same here as it did in the landing's iframe. An explicit ?theme= still wins.
const backgrounds = { dark: resolveTheme('dark').background, light: resolveTheme('light').background };
const backgroundOf = (t: 'dark' | 'light'): string => backgrounds[t];
const lastTheme = (() => {
    try {
        const raw = localStorageAdapter().get(PERSIST_KEY);
        return typeof raw === 'string' ? savedTheme(raw, backgrounds) : null;
    } catch {
        return null; // storage blocked: nothing saved to follow
    }
})();
const params = readEmbedParams(location.search, lastTheme ? lastTheme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);

// Start on a data source this network can reach (a few seconds at most); say so if none is.
const reachable = await probeSources();
const source = pickSource(reachable);
// What was saved on an earlier visit must not overrule this one: a symbol from a source that is blocked
// today, or colours from the other theme (see saved-state.ts).
const storage = sanitizingStorage(localStorageAdapter(), {
    themeBackground: backgroundOf(params.theme),
    otherThemeBackground: backgroundOf(params.theme === 'dark' ? 'light' : 'dark'),
    reachable,
    fallback: source,
});
// The watchlist starts open the first time on a screen wide enough for it (see takeWatchlistDefault).
const openWatchlist = takeWatchlistDefault({ getItem: (k) => localStorage.getItem(k), setItem: (k, v) => localStorage.setItem(k, v) }, matchMedia('(min-width: 900px)').matches);
const ws = new VelaWorkspace('#chart', { ...buildWorkspaceOptions(params, source ?? undefined, { openWatchlist }), storage });
if (!source) {
    const note = document.createElement('div');
    note.setAttribute('role', 'status');
    note.textContent = blockedNotice(params.lang);
    note.style.cssText =
        'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:10;max-width:min(92vw,640px);padding:8px 14px;border-radius:8px;font:13px/1.4 system-ui,sans-serif;background:#f23645;color:#fff;text-align:center';
    document.body.appendChild(note);
}

// The page behind the chart follows the chart's theme.
const syncBackground = (t: { background: string }): void => {
    document.body.style.background = t.background;
};
for (const cell of ws.cells()) cell.chart.on('theme:changed', syncBackground);
document.documentElement.lang = params.lang;

/** The embedding page's origin, if it is one we allow (Chrome/Safari expose it; the referrer is the fallback). */
function parentOrigin(): string | null {
    const ancestor = location.ancestorOrigins?.[0];
    let referrer = '';
    try {
        referrer = document.referrer ? new URL(document.referrer).origin : '';
    } catch {
        /* no usable referrer */
    }
    return [ancestor, referrer].find((o): o is string => !!o && isAllowedParent(o)) ?? null;
}

if (params.embedded && window.parent !== window) {
    window.addEventListener('message', (event) => {
        // Only our own parent window, and only from an allowed origin.
        if (event.source !== window.parent || !isAllowedParent(event.origin)) return;
        const msg = parseParentMessage(event.data);
        if (!msg) return;
        if (msg.theme) ws.setTheme(msg.theme);
        if (msg.lang) {
            ws.setLocale(msg.lang);
            document.documentElement.lang = msg.lang;
        }
    });

    // "Ready" means the app shell is mounted, not that market data arrived: on a blocked network
    // the data never does, and the host would otherwise show its loading state forever.
    requestAnimationFrame(() =>
        requestAnimationFrame(() => {
            const origin = parentOrigin();
            if (origin) window.parent.postMessage({ type: 'chartlab:ready' }, origin);
        }),
    );
}
