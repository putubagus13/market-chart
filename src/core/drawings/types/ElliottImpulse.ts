import { ElliottWave } from './ElliottWave';

/** Elliott impulse wave — a 6-point polyline labelled 0–5, the origin first. */
export class ElliottImpulse extends ElliottWave {
    readonly type = 'elliottimpulse' as const;

    vertexLabels(): readonly string[] {
        return ['0', '1', '2', '3', '4', '5'];
    }
}
