// Scrolling to the oldest loaded bar deepens the history through the depth-only path,
// and the default depth when no `bars` is given.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Vela } from '../src/index';
import { DEFAULT_BARS } from '../src/core/options';
import type { IChartRenderer, RendererCapabilities, IndicatorRenderHandle, VisibleRange } from '../src/core/ports/IChartRenderer';
import type { MarketDataFeed, BarRange } from '../src/core/ports/MarketDataFeed';
import type { MarketConfig } from '../src/core/options';
import type { OHLCV } from '../src/core/model/ohlcv';
import type { Unsubscribe } from '../src/core/util/types';

const T0 = 1_600_000_000_000;
const MIN = 60_000;

function universe(total: number): OHLCV[] {
    return Array.from({ length: total }, (_, i) => ({ time: T0 + i * MIN, open: 100, high: 101, low: 99, close: 100 + (i % 7), volume: 1 }));
}

class ViewportRenderer implements IChartRenderer {
    readonly capabilities: RendererCapabilities = {
        panes: true, paneManagement: false, fills: 'primitive', bgcolor: 'primitive', hline: 'native',
        markers: true, barcolor: 'approximated', perPointColor: true, drawings: true, userDrawings: false, tables: true, inputsUI: true,
    };
    readonly name = 'viewport';
    readonly features: readonly string[] = [];
    bars: OHLCV[] = [];
    private viewportCb: ((r: VisibleRange) => void) | null = null;
    applyFeature(): void {}
    readFeature(): unknown { return undefined; }
    mount(): void {}
    setTheme(): void {}
    resize(): void {}
    destroy(): void {}
    setBars(bars: OHLCV[]): void { this.bars = [...bars]; }
    updateBar(bar: OHLCV): void { this.bars.push(bar); }
    setNativeData(): void {}
    ensurePane(): void {}
    removePane(): void {}
    mountIndicator(model: { id: string }): IndicatorRenderHandle { return { id: model.id }; }
    updateIndicator(): void {}
    removeIndicator(): void {}
    setIndicatorInputs(): void {}
    setIndicatorVisible(): void {}
    setIndicatorStatus(): void {}
    onInputChange(): Unsubscribe { return () => {}; }
    onRemoveIndicator(): Unsubscribe { return () => {}; }
    onCrosshairMove(): Unsubscribe { return () => {}; }
    onClick(): Unsubscribe { return () => {}; }
    getVisibleRange(): VisibleRange | null { return null; }
    setVisibleRange(): void {}
    onViewportChange(cb: (r: VisibleRange) => void): Unsubscribe { this.viewportCb = cb; return () => (this.viewportCb = null); }
    /** Simulate the user panning so that `from`..`to` is on screen. */
    pan(from: number, to: number): void { this.viewportCb?.({ from, to }); }
}

class RangedFeed implements MarketDataFeed {
    readonly all: OHLCV[];
    loads: Array<number | undefined> = [];
    ranges: BarRange[] = [];
    constructor(total: number) { this.all = universe(total); }
    load(cfg: MarketConfig): Promise<OHLCV[]> {
        this.loads.push(cfg.bars);
        return Promise.resolve(this.all.slice(-(cfg.bars ?? DEFAULT_BARS)));
    }
    loadRange(_cfg: MarketConfig, range: BarRange): Promise<OHLCV[]> {
        this.ranges.push(range);
        let out = this.all.filter((b) => (range.from == null || b.time >= range.from) && (range.to == null || b.time <= range.to));
        if (range.limit != null && out.length > range.limit) out = out.slice(-range.limit);
        return Promise.resolve(out);
    }
    subscribe(): Unsubscribe { return () => {}; }
}

async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(500);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function setup(total: number, bars?: number): { chart: Vela; renderer: ViewportRenderer; feed: RangedFeed } {
    const renderer = new ViewportRenderer();
    const feed = new RangedFeed(total);
    const chart = new Vela({} as unknown as HTMLElement, { live: false, ...(bars ? { bars } : {}) }, { renderer, engines: [], dataFeed: feed });
    return { chart, renderer, feed };
}

describe('history depth', () => {
    afterEach(() => vi.useRealTimers());

    it('loads DEFAULT_BARS (5000) when no depth is given', async () => {
        const { chart, renderer, feed } = setup(20_000);
        await chart.ready();
        expect(DEFAULT_BARS).toBe(5_000);
        expect(feed.loads[0]).toBeUndefined();
        expect(renderer.bars).toHaveLength(5_000);
    });

    it('panning to the oldest bars loads one older extension and keeps the newest bars', async () => {
        vi.useFakeTimers();
        const { chart, renderer, feed } = setup(20_000, 1_000);
        await chart.ready();
        await settle();
        expect(renderer.bars).toHaveLength(1_000);
        const newest = renderer.bars[999]!.time;

        renderer.pan(renderer.bars[5]!.time, renderer.bars[200]!.time); // near the oldest edge
        renderer.pan(renderer.bars[3]!.time, renderer.bars[198]!.time); // a second pan inside the debounce
        await settle();
        await chart.historyComplete();
        await settle();
        expect(renderer.bars).toHaveLength(6_000);
        expect(renderer.bars[renderer.bars.length - 1]!.time).toBe(newest);
        expect(feed.ranges.length).toBeGreaterThan(0);
        expect(feed.ranges.every((r) => r.to != null && r.to <= feed.all[19_000]!.time)).toBe(true);
    });

    it('panning away from the edge loads nothing', async () => {
        vi.useFakeTimers();
        const { chart, renderer, feed } = setup(20_000, 1_000);
        await chart.ready();
        await settle();
        renderer.pan(renderer.bars[500]!.time, renderer.bars[900]!.time);
        await settle();
        expect(feed.ranges).toHaveLength(0);
        expect(renderer.bars).toHaveLength(1_000);
    });

    it('stops once the source has no older bars', async () => {
        vi.useFakeTimers();
        const { chart, renderer, feed } = setup(1_500, 1_000);
        await chart.ready();
        await settle();
        renderer.pan(renderer.bars[0]!.time, renderer.bars[100]!.time);
        await settle();
        await chart.historyComplete();
        await settle();
        expect(renderer.bars).toHaveLength(1_500);
        const asked = feed.ranges.length;
        renderer.pan(renderer.bars[0]!.time, renderer.bars[100]!.time);
        await settle();
        expect(feed.ranges).toHaveLength(asked);
    });

    it('does not scroll back during a replay', async () => {
        vi.useFakeTimers();
        const { chart, renderer, feed } = setup(20_000, 1_000);
        await chart.ready();
        await settle();
        await chart.replay.start({ from: renderer.bars[800]!.time });
        await settle();
        const asked = feed.ranges.length;
        renderer.pan(renderer.bars[0]!.time, renderer.bars[100]!.time);
        await settle();
        expect(feed.ranges).toHaveLength(asked);
    });

    it('another market loads at the depth set before the scroll', async () => {
        vi.useFakeTimers();
        const { chart, renderer, feed } = setup(20_000, 1_000);
        await chart.ready();
        await settle();
        renderer.pan(renderer.bars[0]!.time, renderer.bars[100]!.time);
        await settle();
        await chart.historyComplete();
        await settle();
        expect(renderer.bars).toHaveLength(6_000);
        feed.loads = [];
        await chart.setMarket({ timeframe: '5' });
        await settle();
        expect(feed.loads[0]).toBe(1_000);
    });
});
