// Statistics over the simulator's closed trades. Pure functions.
import { plannedRR, resultPips, resultR, riskOf, type SimTrade, type TradeOutcome } from './sim-engine';

/** Reward:risk ratios the recommendation weighs. */
export const RR_CANDIDATES = [1, 1.5, 2, 2.5, 3, 4, 5] as const;
/** Fewest trades with a known outcome at a ratio before it can be recommended. */
export const MIN_SAMPLE = 10;

export interface RRRow {
    rr: number;
    /** Share of trades that moved this many risks in their favor before the stop. */
    probability: number;
    /** Trades with a known outcome at this ratio. */
    sample: number;
    /** Average result per trade in risks, had every trade used this target: p·R − (1 − p). */
    expectancy: number;
}

export interface SimStats {
    total: number;
    wins: number;
    losses: number;
    breakeven: number;
    /** 0..1; 0 with no trades. */
    winRate: number;
    netPips: number;
    netR: number;
    avgR: number;
    /** Largest fall of the cumulative pip result from a peak (≥ 0). */
    maxDrawdownPips: number;
    /** Largest fall of the cumulative result in risks from a peak (≥ 0) — comparable across symbols. */
    maxDrawdownR: number;
    longestLosingStreak: number;
    longestWinningStreak: number;
    rr: RRRow[];
    /** Cumulative result in R after each trade, in close order. */
    equityR: number[];
    /** How far below its running peak (never below 0) the cumulative R stands after each trade (≤ 0). */
    drawdownR: number[];
    /** Each trade's result, in close order. */
    perTrade: Array<{ r: number; outcome: TradeOutcome; symbol: string; closeTime: number }>;
    /** The ratio with the best expectancy among those with enough sample, or null. */
    recommended: RRRow | null;
}

/** How far a trade went in its favor, in risks. */
function mfeR(t: SimTrade): number {
    const risk = riskOf(t);
    return risk > 0 ? t.mfe / risk : 0;
}

/**
 * The share of trades reaching `rr` risks in their favor. A trade that closed at its own
 * take profit below `rr` says nothing about `rr` (it might have gone on), so it is left out.
 */
function rrRow(trades: readonly SimTrade[], rr: number): RRRow {
    let reached = 0;
    let failed = 0;
    for (const t of trades) {
        if (mfeR(t) >= rr - 1e-9) reached += 1;
        else if (t.outcome === 'tp' && plannedRR(t) < rr) continue;
        else failed += 1;
    }
    const sample = reached + failed;
    const probability = sample > 0 ? reached / sample : 0;
    return { rr, probability, sample, expectancy: probability * rr - (1 - probability) };
}

export interface StatsOptions {
    /** The pip size each trade's pips use (default: the tick size it was placed with). */
    pipOf?: (t: SimTrade) => number;
}

export function computeStats(trades: readonly SimTrade[], opts: StatsOptions = {}): SimStats {
    const ordered = [...trades].sort((a, b) => (a.closeTime ?? 0) - (b.closeTime ?? 0));
    let wins = 0;
    let losses = 0;
    let breakeven = 0;
    let netPips = 0;
    let netR = 0;
    let peak = 0;
    let maxDrawdownPips = 0;
    let peakR = 0;
    let maxDrawdownR = 0;
    let lossRun = 0;
    let winRun = 0;
    let longestLosingStreak = 0;
    let longestWinningStreak = 0;
    const equityR: number[] = [];
    const drawdownR: number[] = [];
    const perTrade: SimStats['perTrade'] = [];
    for (const t of ordered) {
        const r = resultR(t);
        netR += r;
        netPips += resultPips(t, opts.pipOf?.(t));
        peak = Math.max(peak, netPips);
        maxDrawdownPips = Math.max(maxDrawdownPips, peak - netPips);
        peakR = Math.max(peakR, netR);
        maxDrawdownR = Math.max(maxDrawdownR, peakR - netR);
        equityR.push(netR);
        drawdownR.push(netR - peakR);
        perTrade.push({ r, outcome: t.outcome ?? 'manual', symbol: t.symbol, closeTime: t.closeTime ?? 0 });
        if (r > 1e-9) {
            wins += 1;
            winRun += 1;
            lossRun = 0;
        } else if (r < -1e-9) {
            losses += 1;
            lossRun += 1;
            winRun = 0;
        } else {
            breakeven += 1;
            winRun = 0;
            lossRun = 0;
        }
        longestLosingStreak = Math.max(longestLosingStreak, lossRun);
        longestWinningStreak = Math.max(longestWinningStreak, winRun);
    }
    const total = ordered.length;
    const rr = RR_CANDIDATES.map((c) => rrRow(ordered, c));
    const eligible = rr.filter((row) => row.sample >= MIN_SAMPLE);
    const recommended = eligible.length ? eligible.reduce((best, row) => (row.expectancy > best.expectancy ? row : best)) : null;
    return {
        total,
        wins,
        losses,
        breakeven,
        winRate: total ? wins / total : 0,
        netPips,
        netR,
        avgR: total ? netR / total : 0,
        maxDrawdownPips,
        maxDrawdownR,
        longestLosingStreak,
        longestWinningStreak,
        rr,
        equityR,
        drawdownR,
        perTrade,
        recommended,
    };
}
