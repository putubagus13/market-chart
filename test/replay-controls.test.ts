// @vitest-environment jsdom
// The replay strip drives the shell's replay clock: pick a start bar with a chart click,
// play at the chosen speed, step one bar, exit — and shows only while it has a job.
import { describe, it, expect, afterEach } from 'vitest';
import { ReplayControls, speedToInterval, intervalToSpeed, REPLAY_SPEEDS } from '../src/widget/replay/replay-controls';
import type { WidgetContext } from '../src/widget/contributions';
import { createTranslator } from '../src/plugin';
import type { ClickEvent } from '../src/core/ports/IChartRenderer';

type Handler = (payload: never) => void;

function fakeReplay() {
    const handlers = new Map<string, Set<Handler>>();
    const calls: string[] = [];
    const state = { active: false, playing: false, cursorTime: null as number | null, remaining: 0, nextTime: null, intervalMs: 1000 };
    const emit = (event: string, payload: unknown): void => handlers.get(event)?.forEach((h) => h(payload as never));
    return {
        calls,
        state,
        bounds: { first: 0, last: 10_000 },
        emit,
        on(event: string, h: Handler) {
            if (!handlers.has(event)) handlers.set(event, new Set());
            handlers.get(event)!.add(h);
            return () => handlers.get(event)!.delete(h);
        },
        async start(opts: { from: number }) {
            calls.push(`start:${opts.from}`);
            state.active = true;
            state.cursorTime = opts.from;
            emit('replay:start', { cursorTime: opts.from, remaining: 5 });
        },
        step() { calls.push('step'); return true; },
        play(ms?: number) { calls.push(`play:${ms}`); state.playing = true; if (ms) state.intervalMs = ms; emit('replay:play', { intervalMs: state.intervalMs }); },
        pause() { calls.push('pause'); state.playing = false; emit('replay:pause', undefined); },
        stop() { calls.push('stop'); state.active = false; state.playing = false; emit('replay:end', { reason: 'stopped' }); },
    };
}

function setup() {
    const replay = fakeReplay();
    let clickCb: ((e: ClickEvent) => void) | null = null;
    const host = document.createElement('div');
    document.body.append(host);
    const strips: HTMLElement[] = [];
    const ctx = {
        chart: { on: () => () => {}, renderer: { onClick: (cb: (e: ClickEvent) => void) => { clickCb = cb; return () => (clickCb = null); } } },
        host,
        i18n: createTranslator({ locale: 'en' }),
        toast: () => {},
        dockStrip: (el: HTMLElement) => { strips.push(el); host.append(el); return Object.assign(() => el.remove(), { cover: () => {} }); },
        replay,
    } as unknown as WidgetContext;
    const bar = new ReplayControls(ctx);
    return { bar, replay, click: (time: number | null) => clickCb?.({ time, price: 1 }), hasClickHandler: () => clickCb !== null, strips };
}

const button = (bar: ReplayControls, label: string): HTMLButtonElement => bar.el.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;

describe('replay controls', () => {
    afterEach(() => document.body.replaceChildren());

    it('maps speeds to play intervals and back', () => {
        expect(REPLAY_SPEEDS).toEqual([0.5, 1, 2, 3, 5, 10]);
        expect(speedToInterval(5)).toBe(200);
        expect(speedToInterval(0.5)).toBe(2000);
        expect(intervalToSpeed(200)).toBe(5);
        expect(intervalToSpeed(333)).toBe(3);
    });

    it('stays hidden until armed; a chart click starts the replay at that bar', async () => {
        const { bar, replay, click, hasClickHandler } = setup();
        expect(bar.el.hidden).toBe(true);
        expect(bar.el.isConnected).toBe(false); // not docked while there is nothing to show
        bar.armPick();
        expect(bar.el.isConnected).toBe(true);
        expect(bar.el.hidden).toBe(false);
        expect(bar.picking).toBe(true);
        click(4_000);
        await Promise.resolve();
        expect(replay.calls).toContain('start:4000');
        expect(bar.picking).toBe(false);
        expect(hasClickHandler()).toBe(false);
        expect(bar.el.hidden).toBe(false);
        expect(bar.el.textContent).toContain('5 bars left');
    });

    it('play, step, pause and exit drive the clock; the strip hides when the replay ends', async () => {
        const { bar, replay } = setup();
        await bar.startAt(1_000);
        button(bar, 'Forward one bar').click();
        expect(replay.calls).toContain('step');
        button(bar, 'Play').click();
        expect(replay.calls).toContain('play:1000');
        expect(button(bar, 'Play').hidden).toBe(true);
        expect(button(bar, 'Pause').hidden).toBe(false);
        button(bar, 'Pause').click();
        expect(replay.calls).toContain('pause');
        button(bar, 'Exit replay').click();
        expect(replay.calls).toContain('stop');
        expect(bar.el.hidden).toBe(true);
        expect(bar.el.isConnected).toBe(false);
    });

    it('refuses a start at or after the last bar', async () => {
        const { bar, replay } = setup();
        await bar.startAt(10_000);
        expect(replay.calls.filter((c) => c.startsWith('start'))).toHaveLength(0);
    });
});
