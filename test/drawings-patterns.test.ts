import { describe, it, expect } from 'vitest';
import { createDrawing, deserializeDrawing, lineSegmentIntersection, type Projector, type PatternDrawing, type SerializedDrawing } from '../src/core/drawings';
import { createTranslator, type MessageLike } from '../src/plugin';

/** Toolbar and drawing text as an English chart shows it. */
const english = createTranslator({ locale: 'en' });
const en = (m: MessageLike | null | undefined): string | null | undefined => (m == null ? m : english.t(m));


const HR = 3600000;

/** Linear projector: x = time/hour, y = 100 − price, single pane 'price'. */
function fakeProjector(): Projector {
    return {
        xOf: (t) => t / HR,
        yOf: (price, paneId) => (paneId === 'price' ? 100 - price : null),
        pxToPoint: (x, y) => ({ time: x * HR, price: 100 - y }),
        paneIdAtY: () => 'price',
        width: 200,
        height: 100,
    };
}

const at = (h: number, price: number): { time: number; price: number } => ({ time: h * HR, price });

describe('drawings/patterns', () => {
    const proj = fakeProjector();

    it('XABCD has 5 vertices, labels X–D, fills two triangles, shows leg ratios', () => {
        const d = createDrawing('xabcd', { paneId: 'price', anchors: [at(0, 50), at(1, 70), at(2, 60), at(3, 80), at(4, 55)] })! as PatternDrawing;
        expect(d.anchorSchema().min).toBe(5);
        expect(d.vertexLabels().map(en)).toEqual(['X', 'A', 'B', 'C', 'D']);
        expect(d.legRatios()).toBe(true);
        expect(d.fillTriangles()).toEqual([[0, 1, 2], [2, 3, 4]]);
        // AB/XA = |60−70| / |70−50| = 10/20 = 0.5
        expect(d.ratioAt(2)).toBeCloseTo(0.5, 6);
        // BC/AB = |80−60| / |60−70| = 20/10 = 2
        expect(d.ratioAt(3)).toBeCloseTo(2, 6);
    });

    it('ABCD has 4 vertices + ratios; hit-tests on its polyline', () => {
        const d = createDrawing('abcd', { paneId: 'price', anchors: [at(0, 40), at(2, 60), at(4, 50), at(6, 70)] })! as PatternDrawing;
        expect(d.anchorSchema().min).toBe(4);
        expect(d.vertexLabels().map(en)).toEqual(['A', 'B', 'C', 'D']);
        // on the A→B leg midpoint: (1h, 50) → px (1, 50)
        expect(d.hitTest(1, 50, proj, 4)).toBe(true);
        expect(d.hitTest(1, 90, proj, 4)).toBe(false);
        expect(d.priceRange()).toEqual({ min: 40, max: 70 });
    });

    it('Elliott impulse / correction count from a 0 origin with no ratios', () => {
        const imp = createDrawing('elliottimpulse', { paneId: 'price', anchors: [at(0, 5), at(1, 10), at(2, 20), at(3, 15), at(4, 30), at(5, 25)] })! as PatternDrawing;
        expect(imp.anchorSchema().min).toBe(6);
        expect(imp.vertexLabels().map(en)).toEqual(['0', '1', '2', '3', '4', '5']);
        expect(imp.legRatios()).toBe(false);
        const corr = createDrawing('elliottcorrection', { paneId: 'price', anchors: [at(0, 35), at(1, 30), at(2, 20), at(3, 26)] })! as PatternDrawing;
        expect(corr.anchorSchema().min).toBe(4);
        expect(corr.vertexLabels().map(en)).toEqual(['0', 'A', 'B', 'C']);
    });

    it('Elliott records saved before the 0 origin load with an origin in front', () => {
        const legacy = deserializeDrawing({ id: 'e1', type: 'elliottimpulse', paneId: 'price', anchors: [at(2, 20), at(3, 15), at(4, 30), at(5, 25), at(6, 35)] } as SerializedDrawing)!;
        expect(legacy.anchors).toHaveLength(6);
        // one leg-width earlier; wave 2 (15) retraces half of the rebuilt wave 1 (10 → 20)
        expect(legacy.anchors[0]).toEqual(at(1, 10));
        expect(legacy.anchors.slice(1)).toEqual([at(2, 20), at(3, 15), at(4, 30), at(5, 25), at(6, 35)]);
        const corr = deserializeDrawing({ id: 'e2', type: 'elliottcorrection', paneId: 'price', anchors: [at(2, 30), at(3, 20), at(4, 26)] } as SerializedDrawing)!;
        expect(corr.anchors).toHaveLength(4);
        expect(corr.anchors[0]).toEqual(at(1, 10));
    });

    it('Elliott records saved with the origin round-trip unchanged, mid-placement drafts included', () => {
        const full = createDrawing('elliottimpulse', { paneId: 'price', anchors: [at(0, 5), at(1, 10), at(2, 20), at(3, 15), at(4, 30), at(5, 25)] })!;
        const back = deserializeDrawing(full.serialize())!;
        expect(back.anchors).toEqual(full.anchors);
        // a placement ghost one point short of complete is rebuilt from the draft's props
        const draft = createDrawing('elliottimpulse', { paneId: 'price', anchors: [at(0, 5)] })!;
        const ghost = createDrawing('elliottimpulse', { paneId: 'price', anchors: [at(0, 5), at(1, 10), at(2, 20), at(3, 15), at(4, 30)], props: draft.serialize().props })!;
        expect(ghost.anchors).toHaveLength(5);
    });

    it('Head & shoulders has 7 vertices, peaks labelled, neckline through the troughs', () => {
        const d = createDrawing('headshoulders', { paneId: 'price', anchors: [at(0, 40), at(1, 60), at(2, 50), at(3, 70), at(4, 50), at(5, 60), at(6, 40)] })! as PatternDrawing;
        expect(d.anchorSchema().min).toBe(7);
        expect(d.vertexLabels().map(en)).toEqual(['', 'LS', '', 'H', '', 'RS', '']);
        expect(d.necklineIndices()).toEqual([2, 4]);
    });

    it('neckline clips to a leg crossing (lineSegmentIntersection), else null', () => {
        // horizontal neckline y=450 through (460,450)-(660,450); left leg (300,500)→(380,350) crosses at x≈326.67
        const left = lineSegmentIntersection(460, 450, 660, 450, 300, 500, 380, 350)!;
        expect(left[0]).toBeCloseTo(326.667, 2);
        expect(left[1]).toBeCloseTo(450, 6);
        // a leg that never reaches the neckline → null (the painter falls back to the trough)
        expect(lineSegmentIntersection(460, 450, 660, 450, 300, 300, 380, 320)).toBeNull();
        // parallel lines → null
        expect(lineSegmentIntersection(0, 0, 10, 0, 0, 5, 10, 5)).toBeNull();
    });

    it('round-trips through serialize', () => {
        const a = createDrawing('xabcd', { paneId: 'price', anchors: [at(0, 50), at(1, 70), at(2, 60), at(3, 80), at(4, 55)] })!.serialize();
        expect(deserializeDrawing(a)!.serialize()).toEqual(a);
        expect(a.type).toBe('xabcd');
    });
});
