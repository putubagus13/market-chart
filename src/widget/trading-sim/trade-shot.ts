// Screenshots of a chart for the trade journal. A full-size capture can be several megabytes, so it
// is shrunk and encoded as WebP (a browser that cannot encode WebP falls back to PNG on its own).

export const MAX_SHOT_WIDTH = 1600;
const SHOT_QUALITY = 0.8;

/** The size to save an image of `width` × `height` at: unchanged up to `max` wide, else scaled down to it. */
export function fitWidth(width: number, height: number, max: number = MAX_SHOT_WIDTH): { width: number; height: number } {
    if (width <= max) return { width, height };
    return { width: max, height: Math.max(1, Math.round((height * max) / width)) };
}

/** A data URL of `canvas`, shrunk to the saved width, or null when there is nothing to capture. */
export function captureShot(canvas: HTMLCanvasElement | null, doc: Document): string | null {
    try {
        if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
        const size = fitWidth(canvas.width, canvas.height);
        const out = doc.createElement('canvas');
        out.width = size.width;
        out.height = size.height;
        const ctx = out.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(canvas, 0, 0, size.width, size.height);
        return out.toDataURL('image/webp', SHOT_QUALITY);
    } catch {
        return null;
    }
}

/** Resolve after `frames` animation frames, so the chart has repainted with the latest bar. */
export async function afterPaint(win: Pick<Window, 'requestAnimationFrame'>, frames = 2): Promise<void> {
    for (let i = 0; i < frames; i += 1) await new Promise<void>((resolve) => win.requestAnimationFrame(() => resolve()));
}
