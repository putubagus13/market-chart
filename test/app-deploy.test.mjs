import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { ALLOWED_PARENTS } from '../app/embed';

// Plain .mjs on purpose: it needs Node's fs, and the TypeScript tests carry no Node types.
const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
const headerValue = (source, key) =>
    vercel.headers.find((h) => h.source === source)?.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;

describe('the static ChartLab build', () => {
    const out = mkdtempSync(join(tmpdir(), 'chartlab-'));
    beforeAll(async () => {
        await build({ configFile: 'vite.app.config.ts', logLevel: 'silent', build: { outDir: out, emptyOutDir: true } });
    }, 60_000);
    afterAll(() => rmSync(out, { recursive: true, force: true }));

    it('produces the page, its assets, and the Apache licence and Vela notice', () => {
        const files = readdirSync(out);
        expect(files).toEqual(expect.arrayContaining(['index.html', 'assets', 'LICENSE', 'NOTICE']));
        expect(readFileSync(join(out, 'index.html'), 'utf8')).toContain('<title>ChartLab');
        expect(readFileSync(join(out, 'NOTICE'), 'utf8')).toContain('ATTRIBUTION REQUIREMENT');
    });

    it('keeps the JavaScript under 2.5 MB', () => {
        const assets = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js'));
        expect(assets.length).toBeGreaterThan(0);
        for (const f of assets) expect(statSync(join(out, 'assets', f)).size).toBeLessThan(2.5 * 1024 * 1024);
    });
});

describe('vercel.json', () => {
    it('installs without the slow library build, and builds only the app', () => {
        expect(vercel.installCommand).toContain('--ignore-scripts');
        expect(vercel.buildCommand).toBe('npm run build:app');
        expect(vercel.outputDirectory).toBe('app/dist');
    });

    it('lets only the landing (and local dev) frame the app, and never sends X-Frame-Options', () => {
        const csp = headerValue('/(.*)', 'Content-Security-Policy') ?? '';
        expect(csp).toContain('frame-ancestors');
        expect(csp).toContain('http://localhost:3000');
        expect(csp).toContain('https://*.vercel.app');
        expect(csp).toContain('https://chartlab.disatu.xyz');
        const all = vercel.headers.flatMap((h) => h.headers.map((x) => x.key.toLowerCase()));
        expect(all).not.toContain('x-frame-options');
    });

    it('keeps frame-ancestors and the postMessage allow-list in step', () => {
        const csp = headerValue('/(.*)', 'Content-Security-Policy') ?? '';
        const ancestors = csp.split(';').find((d) => d.trim().startsWith('frame-ancestors')) ?? '';
        for (const origin of ALLOWED_PARENTS) expect(ancestors, origin).toContain(origin);
    });

    it('caches the hashed assets for a year', () => {
        expect(headerValue('/assets/(.*)', 'Cache-Control')).toMatch(/max-age=31536000.*immutable/);
    });
});
