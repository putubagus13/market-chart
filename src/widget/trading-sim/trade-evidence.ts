// Collects what a trade leaves behind while the replay runs: the candles around it and its two
// screenshots. A store that fails never blocks trading: every call resolves, and the first failure
// is reported once (a missing store counts as a failure).
import type { EvidenceStore, ShotKind } from './evidence-store';
import type { ShotPair } from './trade-archive';
import { appendCandle, type Candle } from './trade-window';

interface Collecting {
    symbol: string;
    timeframe: string;
    placedAt: number;
    context: Promise<Candle[]>;
    collected: Candle[];
}

export class TradeEvidence {
    /** Whether screenshots are saved (the user can turn them off; candles are always saved). */
    screenshots = true;
    private readonly collecting = new Map<string, Collecting>();
    private reported = false;

    constructor(
        private readonly store: EvidenceStore | null,
        private readonly onError: () => void,
    ) {}

    private fail(): void {
        if (this.reported) return;
        this.reported = true;
        this.onError();
    }

    private async guard<T>(work: (store: EvidenceStore) => Promise<T>, fallback: T): Promise<T> {
        if (!this.store) {
            this.fail();
            return fallback;
        }
        try {
            return await work(this.store);
        } catch {
            this.fail();
            return fallback;
        }
    }

    /** Start collecting for an order placed on the bar at `placedAt`; `context` resolves to the candles up to it. */
    begin(id: string, symbol: string, timeframe: string, placedAt: number, context: Promise<Candle[]>): void {
        this.collecting.set(id, { symbol, timeframe, placedAt, context, collected: [] });
    }

    /** A revealed candle reaches every collecting window of that market that it follows. */
    append(symbol: string, timeframe: string, candle: Candle): void {
        for (const c of this.collecting.values()) {
            if (c.symbol === symbol && c.timeframe === timeframe && candle[0] > c.placedAt) c.collected = appendCandle(c.collected, candle);
        }
    }

    /** Stop collecting and save the window: the context up to the placement bar, then what was collected. */
    async finish(id: string): Promise<void> {
        const c = this.collecting.get(id);
        if (!c) return;
        this.collecting.delete(id);
        const context = await c.context.catch(() => {
            this.fail();
            return [] as Candle[];
        });
        const window = [...context.filter((x) => x[0] <= c.placedAt), ...c.collected];
        await this.guard((s) => s.putWindow(id, window), undefined);
    }

    /** Stop collecting and keep nothing. */
    discard(id: string): void {
        this.collecting.delete(id);
    }

    async saveShot(id: string, kind: ShotKind, dataUrl: string | null): Promise<void> {
        if (!this.screenshots || !dataUrl) return;
        await this.guard((s) => s.putShot(id, kind, dataUrl), undefined);
    }

    shot(id: string, kind: ShotKind): Promise<string | undefined> {
        return this.guard((s) => s.getShot(id, kind), undefined);
    }

    removeShot(id: string, kind: ShotKind): Promise<void> {
        return this.guard((s) => s.removeShot(id, kind), undefined);
    }

    /** Forget a trade: stop collecting and drop what is stored. */
    async remove(id: string): Promise<void> {
        this.collecting.delete(id);
        await this.guard((s) => s.remove(id), undefined);
    }

    async clear(): Promise<void> {
        await this.guard((s) => s.clear(), undefined);
    }

    /** The saved windows and screenshots of `ids` (ids with nothing saved are left out). */
    async read(ids: readonly string[]): Promise<{ windows: Record<string, Candle[]>; images: Record<string, ShotPair> }> {
        const windows: Record<string, Candle[]> = {};
        const images: Record<string, ShotPair> = {};
        for (const id of ids) {
            const w = await this.guard((s) => s.getWindow(id), undefined);
            if (w) windows[id] = w;
            const pair: ShotPair = {};
            for (const kind of ['open', 'close'] as const) {
                const url = await this.guard((s) => s.getShot(id, kind), undefined);
                if (url) pair[kind] = url;
            }
            if (pair.open || pair.close) images[id] = pair;
        }
        return { windows, images };
    }

    /** Save windows and screenshots read from a backup. */
    async write(data: { windows: Record<string, Candle[]>; images: Record<string, ShotPair> }): Promise<void> {
        for (const [id, w] of Object.entries(data.windows)) await this.guard((s) => s.putWindow(id, w), undefined);
        for (const [id, pair] of Object.entries(data.images)) {
            for (const kind of ['open', 'close'] as const) {
                const url = pair[kind];
                if (url) await this.guard((s) => s.putShot(id, kind, url), undefined);
            }
        }
    }
}
