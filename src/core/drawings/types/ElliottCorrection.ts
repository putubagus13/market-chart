import { ElliottWave } from './ElliottWave';

/** Elliott corrective wave — a 4-point polyline labelled 0, A–C, the origin first. */
export class ElliottCorrection extends ElliottWave {
    readonly type = 'elliottcorrection' as const;

    vertexLabels(): readonly string[] {
        return ['0', 'A', 'B', 'C'];
    }
}
