// Bar replay controls — a topbar button that arms "pick the start bar", and a strip docked
// above the bottom bar while a replay runs: play/pause, one bar forward, the speed, a date to
// jump to, the cursor's date and the bars left, and the exit. Everything drives the shell's
// shared replay clock (`ctx.replay`), so every chart of a workspace replays together.
import type { Unsubscribe } from '../../core/util/types';
import { msg } from '../../core/i18n/message';
import type { WidgetContext } from '../contributions';
import { registerWidgetAction, registerWidgetAttachment } from '../contributions';
import type { WorkspaceReplay } from '../../workspace/WorkspaceReplay';
import { injectChromeStyles } from '../../ui/chromeStyles';
import { css } from '@luxalgo/vela-ui/css';
import { t } from '@luxalgo/vela-ui/t';
import { registerIcon, svg16 } from '@luxalgo/vela-ui/icons';
import { createButton, type ButtonHandle } from '@luxalgo/vela-ui/button';
import { createSelect } from '@luxalgo/vela-ui/select';
import { createPopover } from '@luxalgo/vela-ui/popover';
import { DatePicker } from '@luxalgo/vela-ui/date-picker';

const TEXT = {
    action: msg('widget.replay.action', 'Bar replay'),
    pickHint: msg('widget.replay.pickHint', 'Click a bar to start the replay from it'),
    cancel: msg('widget.replay.cancel', 'Cancel'),
    selectBar: msg('widget.replay.selectBar', 'Select bar'),
    goToDate: msg('widget.replay.goToDate', 'Go to date'),
    play: msg('widget.replay.play', 'Play'),
    pause: msg('widget.replay.pause', 'Pause'),
    step: msg('widget.replay.step', 'Forward one bar'),
    speed: msg('widget.replay.speed', 'Speed'),
    exit: msg('widget.replay.exit', 'Exit replay'),
    status: msg('widget.replay.status', '{date} · {remaining, plural, one {# bar left} other {# bars left}}'),
    noBarAfter: msg('widget.replay.noBarAfter', 'No bar opens after that date'),
};

/** Playback speeds offered, as multiples of one bar per second. */
export const REPLAY_SPEEDS = [0.5, 1, 2, 3, 5, 10] as const;

/** The play interval (ms per bar) for a speed multiple. */
export function speedToInterval(speed: number): number {
    return Math.round(1000 / speed);
}

/** The listed speed closest to a play interval. */
export function intervalToSpeed(intervalMs: number): number {
    const raw = 1000 / intervalMs;
    return REPLAY_SPEEDS.reduce((best, s) => (Math.abs(s - raw) < Math.abs(best - raw) ? s : best), REPLAY_SPEEDS[1]);
}

registerIcon('play', svg16('<path d="M5 3.5v9l7-4.5z" fill="currentColor"/>'));
registerIcon('pause', svg16('<path d="M5.5 3.5v9M10.5 3.5v9" stroke-width="2"/>'));
registerIcon('step-forward', svg16('<path d="M3.5 3.5v9l6-4.5z" fill="currentColor"/><path d="M12 3.5v9" stroke-width="1.6"/>'));

const STYLE_ID = 'vela-widget-replay';
const CSS = css`@layer vela.chrome {

.vela-replay-bar:where(:not([hidden])) {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-top: 1px solid ${t.border};
    background: ${t.bg};
    color: ${t.fg};
    font-size: 12px;
}
.vela-replay-sep { width: 1px; height: 18px; margin: 0 4px; background: ${t.border}; }
.vela-replay-status {
    margin-inline-start: 8px;
    color: ${t.fg.muted};
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    unicode-bidi: isolate;
}
.vela-replay-hint { color: ${t.accent}; font-weight: 600; }
.vela-replay-controls:where(:not([hidden])) { display: contents; }
.vela-replay-spacer { flex: 1; }

}`;

/** The shell's shared replay clock, when the shell has one (a workspace does). */
function replayOf(ctx: WidgetContext): WorkspaceReplay | null {
    return (ctx as WidgetContext & { replay?: WorkspaceReplay }).replay ?? null;
}

/** The bar of each mounted shell, keyed by its root — the action reaches it through `ctx.host`. */
const bars = new WeakMap<HTMLElement, ReplayControls>();

/**
 * One shell's replay strip and its "pick the start bar" mode. Reads the chart, the replay
 * clock and the translator from the mount context at every use.
 */
export class ReplayControls {
    readonly el: HTMLElement;
    private readonly hint: HTMLElement;
    private readonly cancelBtn: ButtonHandle;
    private readonly controls: HTMLElement;
    private readonly playBtn: ButtonHandle;
    private readonly pauseBtn: ButtonHandle;
    private readonly status: HTMLElement;
    private readonly speed: ReturnType<typeof createSelect>;
    private readonly subs: Unsubscribe[] = [];
    private pickOff: Unsubscribe | null = null;
    private cursorTime: number | null = null;
    private remaining = 0;
    private undock: (() => void) | null = null;
    /** Re-reads every label in the current language. */
    private readonly relabel: () => void;
    /** The chart whose `locale:changed` relabels the strip (rebound when the shell swaps it). */
    private localeChart: WidgetContext['chart'] | null = null;
    private localeOff: Unsubscribe | null = null;

    constructor(private readonly ctx: WidgetContext) {
        injectChromeStyles(STYLE_ID, CSS);
        const tr = (m: Parameters<WidgetContext['i18n']['t']>[0]): string => ctx.i18n.t(m);
        this.el = document.createElement('div');
        this.el.className = 'vela-replay-bar';
        this.el.setAttribute('role', 'toolbar');
        this.el.hidden = true;

        this.hint = document.createElement('span');
        this.hint.className = 'vela-replay-hint';
        this.cancelBtn = createButton({ text: tr(TEXT.cancel), variant: 'ghost', size: 'sm', onClick: () => this.cancelPick() });

        this.controls = document.createElement('div');
        this.controls.className = 'vela-replay-controls';
        const selectBar = createButton({ text: tr(TEXT.selectBar), icon: 'cursor', variant: 'ghost', size: 'sm', onClick: () => this.armPick() });
        const goTo = createButton({ text: tr(TEXT.goToDate), icon: 'calendar', variant: 'ghost', size: 'sm' });
        const picker = new DatePicker({ i18n: ctx.i18n, onPick: (day) => {
            popover.hide();
            void this.startAt(Date.parse(`${day}T00:00:00Z`));
        } });
        const popover = createPopover({ trigger: goTo.el, content: picker.el, host: ctx.host, side: 'top', align: 'start' });
        goTo.el.addEventListener('click', () => {
            const cursor = this.cursorTime;
            if (cursor != null) picker.setValue(new Date(cursor).toISOString().slice(0, 10));
            popover.toggle();
        });
        this.playBtn = createButton({ icon: 'play', size: 'icon-sm', variant: 'ghost', label: tr(TEXT.play), onClick: () => this.togglePlay() });
        this.pauseBtn = createButton({ icon: 'pause', size: 'icon-sm', variant: 'ghost', label: tr(TEXT.pause), onClick: () => this.togglePlay() });
        const stepBtn = createButton({ icon: 'step-forward', size: 'icon-sm', variant: 'ghost', label: tr(TEXT.step), onClick: () => replayOf(this.ctx)?.step() });
        const replay = replayOf(ctx);
        this.speed = createSelect({
            options: REPLAY_SPEEDS.map((s) => ({ value: String(s), label: `${ctx.i18n.format.compact(s, { decimals: 1 })}×` })),
            value: String(intervalToSpeed(replay?.state.intervalMs ?? 1000)),
            size: 'sm',
            side: 'top',
            list: { host: ctx.host },
            onValueChange: (v) => {
                const r = replayOf(this.ctx);
                if (r?.state.playing) r.play(speedToInterval(Number(v)));
            },
        });
        this.status = document.createElement('span');
        this.status.className = 'vela-replay-status';
        this.status.dir = 'auto';
        const spacer = document.createElement('span');
        spacer.className = 'vela-replay-spacer';
        const exit = createButton({ icon: 'close', size: 'icon-sm', variant: 'ghost', label: tr(TEXT.exit), onClick: () => this.exit() });
        const sep = (): HTMLElement => Object.assign(document.createElement('span'), { className: 'vela-replay-sep' });
        this.controls.append(selectBar.el, goTo.el, sep(), this.playBtn.el, this.pauseBtn.el, stepBtn.el, this.speed.el, this.status, spacer, exit.el);
        this.el.append(this.hint, this.cancelBtn.el, this.controls);
        this.subs.push(() => popover.destroy());
        this.relabel = () => {
            this.el.setAttribute('aria-label', tr(TEXT.action));
            this.hint.textContent = tr(TEXT.pickHint);
            this.cancelBtn.setText(tr(TEXT.cancel));
            selectBar.setText(tr(TEXT.selectBar));
            goTo.setText(tr(TEXT.goToDate));
            this.playBtn.setText(tr(TEXT.play));
            this.pauseBtn.setText(tr(TEXT.pause));
            stepBtn.setText(tr(TEXT.step));
            exit.setText(tr(TEXT.exit));
            this.speed.el.setAttribute('aria-label', tr(TEXT.speed));
            this.renderStatus();
        };
        this.relabel();

        if (replay) {
            this.subs.push(
                replay.on('replay:start', (e) => this.onCursor(e.cursorTime, e.remaining)),
                replay.on('replay:step', (e) => this.onCursor(e.cursorTime, e.remaining)),
                replay.on('replay:play', () => this.renderPlaying()),
                replay.on('replay:pause', () => this.renderPlaying()),
                replay.on('replay:end', () => this.onEnd()),
            );
        }
        this.render();
    }

    /** Whether the strip shows (a replay runs, or a start bar is being picked). */
    get visible(): boolean {
        return !this.el.hidden;
    }

    /** Whether the next chart click picks the replay's start bar. */
    get picking(): boolean {
        return this.pickOff !== null;
    }

    /** Arm "pick the start bar": the next click on a chart starts (or moves) the replay there. */
    armPick(): void {
        this.cancelPick();
        replayOf(this.ctx)?.pause();
        this.pickOff = this.ctx.chart.renderer.onClick((e) => {
            if (e.time == null) return;
            this.cancelPick();
            void this.startAt(e.time);
        });
        this.render();
    }

    cancelPick(): void {
        this.pickOff?.();
        this.pickOff = null;
        this.render();
    }

    /** Start (or seek) the replay so the bar opening at or before `time` is the last shown. */
    async startAt(time: number): Promise<void> {
        const replay = replayOf(this.ctx);
        if (!replay || !Number.isFinite(time)) return;
        const bounds = replay.bounds;
        if (bounds && time >= bounds.last) {
            this.ctx.toast(this.ctx.i18n.t(TEXT.noBarAfter), 'info');
            return;
        }
        await replay.start({ from: time });
    }

    togglePlay(): void {
        const replay = replayOf(this.ctx);
        if (!replay?.state.active) return;
        if (replay.state.playing) replay.pause();
        else replay.play(speedToInterval(Number(this.speed.value)));
    }

    exit(): void {
        this.cancelPick();
        replayOf(this.ctx)?.stop();
    }

    private onCursor(cursorTime: number, remaining: number): void {
        this.cursorTime = cursorTime;
        this.remaining = remaining;
        this.render();
    }

    private onEnd(): void {
        this.cursorTime = null;
        this.remaining = 0;
        this.render();
    }

    private renderPlaying(): void {
        const playing = replayOf(this.ctx)?.state.playing ?? false;
        this.playBtn.el.hidden = playing;
        this.pauseBtn.el.hidden = !playing;
    }

    private render(): void {
        this.bindLocale();
        const active = replayOf(this.ctx)?.state.active ?? false;
        const picking = this.picking;
        const show = active || picking;
        this.el.hidden = !show;
        // Docked only while shown: a strip takes its row in the shell even when empty.
        if (show && !this.undock) this.undock = this.ctx.dockStrip(this.el);
        else if (!show && this.undock) {
            this.undock();
            this.undock = null;
        }
        this.hint.hidden = !picking;
        this.cancelBtn.el.hidden = !picking;
        this.controls.hidden = picking || !active;
        this.renderStatus();
        this.renderPlaying();
    }

    private renderStatus(): void {
        if (this.cursorTime != null) {
            const date = this.ctx.i18n.format.timeStamp(this.cursorTime);
            this.status.textContent = this.ctx.i18n.t(TEXT.status, { date, remaining: this.remaining });
        } else this.status.textContent = '';
    }

    /** Follow the shell's language through its current chart's `locale:changed`. */
    private bindLocale(): void {
        const chart = this.ctx.chart;
        if (chart === this.localeChart) return;
        this.localeOff?.();
        this.localeChart = chart;
        this.localeOff = chart.on('locale:changed', () => this.relabel());
    }

    destroy(): void {
        this.localeOff?.();
        this.localeOff = null;
        this.cancelPick();
        for (const off of this.subs.splice(0)) off();
        this.undock?.();
        this.undock = null;
        this.el.remove();
    }
}

/** The replay strip of the shell `ctx` belongs to, if mounted. */
export function replayControlsOf(ctx: WidgetContext): ReplayControls | undefined {
    return bars.get(ctx.host);
}

let installed = false;

/** Register the replay strip and its topbar button. Idempotent. */
export function installReplayControls(): void {
    if (installed) return;
    installed = true;
    registerWidgetAttachment({
        id: 'vela.replay',
        mount(ctx) {
            if (!replayOf(ctx)) return () => undefined;
            const bar = new ReplayControls(ctx);
            bars.set(ctx.host, bar);
            return () => {
                if (bars.get(ctx.host) === bar) bars.delete(ctx.host);
                bar.destroy();
            };
        },
    });

    registerWidgetAction({
        id: 'vela.replay',
        target: 'topbar',
        label: TEXT.action,
        icon: 'replay',
        iconOnly: true,
        align: 'left',
        order: 10,
        mobile: 'menu',
        when: (ctx) => replayOf(ctx) !== null,
        run: (ctx) => {
            const bar = replayControlsOf(ctx);
            if (!bar) return;
            if (bar.picking) bar.cancelPick();
            else bar.armPick();
        },
    });
}
