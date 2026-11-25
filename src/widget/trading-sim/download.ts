// Browser glue for the journal's files: hand the user a file, and read one they pick. Neither
// leaves an element behind in the page.

export function downloadText(doc: Document, filename: string, text: string, mime: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const link = Object.assign(doc.createElement('a'), { href: url, download: filename, hidden: true });
    doc.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** The text of a file the user picks, or null when they cancel. */
export function pickTextFile(doc: Document): Promise<string | null> {
    return new Promise((resolve) => {
        const input = Object.assign(doc.createElement('input'), { type: 'file', accept: '.json,application/json', hidden: true });
        input.addEventListener('change', () => {
            const file = input.files?.[0];
            input.remove();
            if (!file) resolve(null);
            else file.text().then(resolve, () => resolve(null));
        });
        input.addEventListener('cancel', () => {
            input.remove();
            resolve(null);
        });
        doc.body.append(input);
        input.click();
    });
}
