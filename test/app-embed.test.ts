import { describe, expect, it } from 'vitest';
import { ALLOWED_PARENTS, isAllowedParent, parseParentMessage, readEmbedParams } from '../app/embed';

describe('readEmbedParams', () => {
    it('reads theme, language and the embed flag from the query string', () => {
        expect(readEmbedParams('?theme=light&lang=id&embed=1', true)).toEqual({ theme: 'light', lang: 'id', embedded: true });
    });

    it('defaults to the system theme, English and not embedded', () => {
        expect(readEmbedParams('', true)).toEqual({ theme: 'dark', lang: 'en', embedded: false });
        expect(readEmbedParams('', false).theme).toBe('light');
    });

    it('falls back when a value is not one we support', () => {
        expect(readEmbedParams('?theme=blue&lang=fr', true)).toEqual({ theme: 'dark', lang: 'en', embedded: false });
    });
});

describe('parseParentMessage', () => {
    it('accepts a well-formed set message', () => {
        expect(parseParentMessage({ type: 'chartlab:set', theme: 'light' })).toEqual({ type: 'chartlab:set', theme: 'light' });
    });

    it('rejects anything that is not a chartlab:set message', () => {
        expect(parseParentMessage({ type: 'x' })).toBeNull();
        expect(parseParentMessage(null)).toBeNull();
        expect(parseParentMessage('str')).toBeNull();
    });

    it('rejects a message with no valid field left', () => {
        expect(parseParentMessage({ type: 'chartlab:set', theme: 'neon' })).toBeNull();
    });

    it('drops invalid fields and keeps the valid ones', () => {
        expect(parseParentMessage({ type: 'chartlab:set', theme: 'dark', lang: 'zz' })).toEqual({ type: 'chartlab:set', theme: 'dark' });
    });
});

describe('isAllowedParent', () => {
    it('allows the landing in development and on Vercel previews', () => {
        expect(isAllowedParent('http://localhost:3000')).toBe(true);
        expect(isAllowedParent('https://disatu-landing.vercel.app')).toBe(true);
    });

    it('allows the ChartLab landing on its own domain, and nothing else on that domain', () => {
        expect(isAllowedParent('https://chartlab.disatu.xyz')).toBe(true);
        for (const origin of ['http://chartlab.disatu.xyz', 'https://disatu.xyz', 'https://evil.chartlab.disatu.xyz', 'https://chartlab.disatu.xyz.evil.com']) {
            expect(isAllowedParent(origin), origin).toBe(false);
        }
    });

    it('rejects look-alike and malformed origins', () => {
        for (const origin of ['https://evil.example', 'https://evilvercel.app', 'http://localhost:3000.evil.com', 'http://disatu-landing.vercel.app', 'null', '']) {
            expect(isAllowedParent(origin), origin).toBe(false);
        }
    });

    it('honours an explicit allow-list', () => {
        expect(isAllowedParent('https://a.example', ['https://a.example'])).toBe(true);
        expect(isAllowedParent('https://b.example', ['https://a.example'])).toBe(false);
    });

    it('ships a non-empty default list', () => {
        expect(ALLOWED_PARENTS.length).toBeGreaterThan(0);
    });
});
