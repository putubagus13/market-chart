import type { SerializedDrawing } from '../Drawing';
import { PatternDrawing } from './PatternDrawing';

/** Set on every record saved since the count gained its `0` origin anchor. */
const ORIGIN_PROP = 'origin';

/**
 * Shared base for the Elliott wave counts. Each count starts at a `0` origin — where the
 * move begins — so the first labelled wave ends on the second anchor. Records saved
 * before the origin existed carry one anchor fewer and no `origin` prop; they load with
 * an origin placed in front of their first anchor, so an old count still reads 0…end.
 */
export abstract class ElliottWave extends PatternDrawing {
    constructor(init: Partial<SerializedDrawing> & { paneId: string }) {
        super(init);
        if (init.props?.[ORIGIN_PROP] !== true && this.anchors.length === this.vertexLabels().length - 1) {
            this.anchors.unshift(legacyOrigin(this.anchors));
        }
    }

    protected override writeProps(): Record<string, unknown> {
        return { [ORIGIN_PROP]: true };
    }
}

/**
 * The origin for a pre-origin count: one leg-width before the first anchor in time, and
 * below (or above) it by twice the first retracement — wave 2 (or B) then retraces half
 * of the reconstructed first wave.
 */
function legacyOrigin(anchors: ReadonlyArray<{ time: number; price: number }>): { time: number; price: number } {
    const [a, b] = anchors;
    if (!a) return { time: 0, price: 0 };
    if (!b) return { time: a.time, price: a.price };
    return { time: 2 * a.time - b.time, price: 2 * b.price - a.price };
}
