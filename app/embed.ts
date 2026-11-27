// How the ChartLab app talks to the page that embeds it (an <iframe> on the landing site).
// Pure functions only: nothing here touches the DOM, so it is covered by plain unit tests.

export type ChartTheme = 'dark' | 'light';
export type ChartLang = 'id' | 'en';

export const SUPPORTED_LANGS: readonly ChartLang[] = ['id', 'en'];

/**
 * Origins allowed to embed the app and to send it messages. A leading `*.` matches any
 * sub-domain (dot boundary, same scheme). Keep in step with `frame-ancestors` in vercel.json.
 */
export const ALLOWED_PARENTS: readonly string[] = ['http://localhost:3000', 'https://*.vercel.app', 'https://chartlab.disatu.xyz'];

export interface EmbedParams {
    theme: ChartTheme;
    lang: ChartLang;
    /** True inside the landing's iframe (`?embed=1`): do not steal the host page's focus. */
    embedded: boolean;
}

export type ParentMessage = { type: 'chartlab:set'; theme?: ChartTheme; lang?: ChartLang };

const isTheme = (v: unknown): v is ChartTheme => v === 'dark' || v === 'light';
const isLang = (v: unknown): v is ChartLang => (SUPPORTED_LANGS as readonly unknown[]).includes(v);

export function readEmbedParams(search: string, prefersDark: boolean): EmbedParams {
    const q = new URLSearchParams(search);
    const theme = q.get('theme');
    const lang = q.get('lang');
    return {
        theme: isTheme(theme) ? theme : prefersDark ? 'dark' : 'light',
        lang: isLang(lang) ? lang : 'en',
        embedded: q.get('embed') === '1',
    };
}

/** Validates a message from the parent page. Invalid fields are dropped; nothing valid left means `null`. */
export function parseParentMessage(data: unknown): ParentMessage | null {
    if (typeof data !== 'object' || data === null) return null;
    const m = data as Record<string, unknown>;
    if (m.type !== 'chartlab:set') return null;
    const out: ParentMessage = { type: 'chartlab:set' };
    if (isTheme(m.theme)) out.theme = m.theme;
    if (isLang(m.lang)) out.lang = m.lang;
    return out.theme === undefined && out.lang === undefined ? null : out;
}

export function isAllowedParent(origin: string, allowed: readonly string[] = ALLOWED_PARENTS): boolean {
    let url: URL;
    try {
        url = new URL(origin);
    } catch {
        return false;
    }
    if (url.origin !== origin) return false; // reject paths, "null", anything not a bare origin
    return allowed.some((entry) => {
        const wild = /^(https?:)\/\/\*\.(.+)$/.exec(entry);
        if (!wild) return entry === origin;
        return url.protocol === wild[1] && url.host.endsWith(`.${wild[2]}`);
    });
}
