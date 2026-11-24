// The simulator's statistics as the Stats tab draws them: figures, the win/loss split, and
// the points of its charts. Pure — no DOM.
import type { LinePoint } from '@luxalgo/vela-ui/line-chart';
import type { BarDatum } from '@luxalgo/vela-ui/bar-chart';
import { MIN_SAMPLE, type SimStats } from './sim-stats';

/** Most trades the per-trade chart shows: the newest ones. */
export const PER_TRADE_BARS = 50;

export interface RatioView {
    rr: number;
    probability: number;
    sample: number;
    expectancy: number;
    recommended: boolean;
}

export interface StatsModel {
    empty: boolean;
    total: number;
    netR: number;
    netPips: number;
    avgR: number;
    winRate: number;
    split: { wins: number; losses: number; breakeven: number };
    maxDrawdownR: number;
    maxDrawdownPips: number;
    longestLosingStreak: number;
    longestWinningStreak: number;
    /** Cumulative R by trade number, from 0 before the first trade. */
    equity: LinePoint[];
    /** Drawdown in R by trade number, from 0 before the first trade. */
    drawdown: LinePoint[];
    bars: BarDatum[];
    barsTruncated: boolean;
    ratios: RatioView[];
    /** The ratio worth recommending — best expectancy, enough trades, and a positive edge — or null. */
    recommendedRR: number | null;
    /** More trades needed before any ratio can be recommended (0 once one can). */
    samplesToRecommend: number;
}

const curve = (ys: readonly number[]): LinePoint[] => [{ x: 0, y: 0 }, ...ys.map((y, i) => ({ x: i + 1, y }))];

export function buildStatsModel(stats: SimStats): StatsModel {
    const recommendedRR = stats.recommended && stats.recommended.expectancy > 0 ? stats.recommended.rr : null;
    const first = Math.max(0, stats.perTrade.length - PER_TRADE_BARS);
    const bars: BarDatum[] = stats.perTrade.slice(first).map((t, i) => ({
        label: String(first + i + 1),
        value: t.r,
        tone: t.r > 1e-9 ? 'profit' : t.r < -1e-9 ? 'loss' : 'muted',
    }));
    const bestSample = stats.rr.reduce((m, row) => Math.max(m, row.sample), 0);
    return {
        empty: stats.total === 0,
        total: stats.total,
        netR: stats.netR,
        netPips: stats.netPips,
        avgR: stats.avgR,
        winRate: stats.winRate,
        split: { wins: stats.wins, losses: stats.losses, breakeven: stats.breakeven },
        maxDrawdownR: stats.maxDrawdownR,
        maxDrawdownPips: stats.maxDrawdownPips,
        longestLosingStreak: stats.longestLosingStreak,
        longestWinningStreak: stats.longestWinningStreak,
        equity: curve(stats.equityR),
        drawdown: curve(stats.drawdownR),
        bars,
        barsTruncated: stats.total > PER_TRADE_BARS,
        ratios: stats.rr.map((row) => ({ ...row, recommended: row.rr === recommendedRR })),
        recommendedRR,
        samplesToRecommend: Math.max(0, MIN_SAMPLE - bestSample),
    };
}
