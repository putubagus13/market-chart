// Free labels on a trade: short tags and a note. Pure text rules shared by the order form,
// the engine's validation, and the backup import.

export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 32;
export const MAX_NOTE_LENGTH = 500;

/** Tags typed as comma-separated text: trimmed, without empties or repeats, cut to the limits. */
export function parseTags(text: string): string[] {
    const tags: string[] = [];
    for (const part of text.split(',')) {
        const tag = part.trim().slice(0, MAX_TAG_LENGTH);
        if (tag && !tags.includes(tag)) tags.push(tag);
        if (tags.length === MAX_TAGS) break;
    }
    return tags;
}

export function formatTags(tags: readonly string[] | undefined): string {
    return tags?.join(', ') ?? '';
}

/** A note as stored: trimmed and cut, or `undefined` when nothing is left. */
export function cleanNote(text: string): string | undefined {
    const note = text.trim().slice(0, MAX_NOTE_LENGTH);
    return note || undefined;
}

export function isTags(v: unknown): v is string[] {
    return Array.isArray(v) && v.length <= MAX_TAGS && v.every((t) => typeof t === 'string' && t.length <= MAX_TAG_LENGTH);
}
