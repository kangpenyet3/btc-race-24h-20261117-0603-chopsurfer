// ChopSurfer — a regime-gated momentum rider for 1-minute cbBTC bars.
//
// Why this shape: a round trip here costs roughly 12-15 bps once the 4 bps
// fee, 2 bps slippage and pool impact are paid on both sides, and most
// 1-minute bars are noise (this market's typical bar moves ~5 bps). A bot
// that trades every wiggle donates its stack to the toll. So this bot only
// rides a move when three independent witnesses agree the move is real:
//
//   1. Momentum: the close has travelled far enough over the last 25 bars
//      to pay the toll several times over — the floor floats with the
//      market's own chop, so a quiet tape demands a quieter signal and a
//      wild tape demands a louder one.
//   2. Trend: the fast EMA sits above the slow EMA by a real margin — and
//      has done so on at least 3 of the last 4 bars, so a one-bar flicker
//      does not count — the close itself is above the slow EMA, and the
//      Kaufman efficiency ratio of the momentum window says the move was
//      travel, not back-and-forth churn.
//   3. Calm: the recent per-bar volatility is under a ceiling; above it the
//      trailing stop would be shaken out by noise alone.
//
// Exits are protective, not predictive: a trailing stop that tightens once
// the ride is comfortably green, a hard stop, a trend-break exit, a fast
// exit for a breakout that fails to follow through, and a time stop that
// frees capital parked in a dead position. Half the ride is banked at the
// take-profit line; the rest keeps riding the stop, so a genuine trend
// still pays beyond it. After any exit a cooldown keeps the bot from
// paying the toll twice for the same wiggle.
//
// Everything is a pure function of the bars and fills seen so far — no
// clock, no randomness, no environment — so two runs over the same window
// agree byte for byte. Indicator math is float64 on + - * / only.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_SPAN = 10;
const SLOW_SPAN = 40;
const MOMENTUM_BARS = 40;
const CHOP_BARS = 60;
const MIN_HISTORY = 64;

// Entry: the 25-bar move must clear the larger of this floor (bps) and
// CHOP_MULTIPLE times the recent mean absolute bar move.
const ENTRY_FLOOR_BPS = 100;
const CHOP_MULTIPLE = 3.0;
// ...and the fast EMA must clear the slow EMA by at least this (bps of price).
const TREND_GAP_BPS = 4;
// Mean absolute bar move (bps) above this means shake-out weather: stay flat.
const CHOP_CEILING_BPS = 45;

// Position size: share of equity, scaled by how far momentum runs past
// the floor, saturating at SIZE_FULL_BPS of momentum.
const SIZE_WEAK = 60;
const SIZE_STRONG = 95;
const SIZE_FULL_BPS = 260;

// Exit geometry (bps).
const TRAIL_LOOSE_BPS = 70;
const TRAIL_TIGHT_BPS = 25;
const TIGHTEN_AFTER_BPS = 50;
const HARD_STOP_BPS = 100;
const TIME_STOP_BARS = 480; // longest a position may sit going nowhere
const TIME_STOP_MIN_GAIN_BPS = 60; // "nowhere" = peak gain never past this
const COOLDOWN_BARS = 20; // bars to sit out after any exit
const TAKE_PROFIT_BPS = 110;

const MAX_SLIPPAGE_BPS = 100;

interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  fast: Ema;
  slow: Ema;
  /** Closes, oldest first, capped at CHOP_BARS + MOMENTUM_BARS + 2. */
  closes: number[];
  /** Mean absolute per-bar return (bps) over the chop window, or null. */
  chopBps: number | null;
  /** Close vs the close MOMENTUM_BARS ago (bps), or null. */
  momentumBps: number | null;
  /** Last few fast-minus-slow EMA gaps (bps of price), newest last. */
  gapHist: number[];
  /** Kaufman efficiency ratio over the momentum window, or null. */
  efficiency: number | null;
}

interface Ride {
  /** Entry price in raw price units (float), from the fill. */
  entryPrice: number;
  /** Highest close seen since entry, raw price units. */
  peak: number;
  /** Bars held so far. */
  bars: number;
  /** Whether the take-profit scale-out already fired for this ride. */
  scaled: boolean;
}

const series = new Map<string, Series>();
const rides = new Map<string, Ride>();
let cooldownUntil = -1;
let barIndex = -1;

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) {
    e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
  }
}

function pushBar(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = {
      fast: { span: FAST_SPAN, warm: [], value: null },
      slow: { span: SLOW_SPAN, warm: [], value: null },
      closes: [],
      chopBps: null,
      momentumBps: null,
      gapHist: [],
      efficiency: null,
    };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  stepEma(s.fast, c);
  stepEma(s.slow, c);
  s.closes.push(c);
  const cap = CHOP_BARS + MOMENTUM_BARS + 2;
  if (s.closes.length > cap) s.closes.splice(0, s.closes.length - cap);

  const n = s.closes.length;
  if (n > MOMENTUM_BARS) {
    const past = s.closes[n - 1 - MOMENTUM_BARS];
    s.momentumBps = past > 0 ? ((c - past) / past) * 10_000 : null;
    let path = 0;
    for (let i = n - MOMENTUM_BARS; i < n; i++) path += Math.abs(s.closes[i] - s.closes[i - 1]);
    const net = Math.abs(c - past);
    s.efficiency = path > 0 ? net / path : null;
  } else {
    s.momentumBps = null;
    s.efficiency = null;
  }
  if (s.fast.value !== null && s.slow.value !== null && s.slow.value > 0) {
    s.gapHist.push(((s.fast.value - s.slow.value) / s.slow.value) * 10_000);
    if (s.gapHist.length > 4) s.gapHist.splice(0, s.gapHist.length - 4);
  }
  if (n > CHOP_BARS) {
    let sum = 0;
    for (let i = n - CHOP_BARS; i < n; i++) {
      const prev = s.closes[i - 1];
      sum += prev > 0 ? Math.abs((s.closes[i] - prev) / prev) * 10_000 : 0;
    }
    s.chopBps = sum / CHOP_BARS;
  } else {
    s.chopBps = null;
  }
  return s;
}

/** Entry floor in bps: the fixed floor, or a multiple of current chop. */
function entryFloor(s: Series): number {
  if (s.chopBps === null) return ENTRY_FLOOR_BPS;
  return Math.max(ENTRY_FLOOR_BPS, CHOP_MULTIPLE * s.chopBps);
}

function wantsEntry(s: Series, close: number): boolean {
  if (s.fast.value === null || s.slow.value === null) return false;
  if (s.momentumBps === null || s.chopBps === null) return false;
  if (s.closes.length < MIN_HISTORY) return false;
  if (s.chopBps > CHOP_CEILING_BPS) return false;
  if (s.momentumBps < entryFloor(s)) return false;
  const gapBps = ((s.fast.value - s.slow.value) / s.slow.value) * 10_000;
  if (gapBps < TREND_GAP_BPS) return false;
  const persistent = s.gapHist.filter((g) => g >= TREND_GAP_BPS).length;
  if (s.gapHist.length >= 4 && persistent < 3) return false;
  if (s.efficiency !== null && s.efficiency < 0.28) return false;
  if (close < s.slow.value) return false;
  return true;
}

function wantsExit(s: Series, ride: Ride, close: number): boolean {
  const gainBps = ((ride.peak - ride.entryPrice) / ride.entryPrice) * 10_000;
  const nowBps = ((close - ride.entryPrice) / ride.entryPrice) * 10_000;
  if (nowBps >= TAKE_PROFIT_BPS && ride.scaled) return true;
  const trailBps = gainBps >= TIGHTEN_AFTER_BPS ? TRAIL_TIGHT_BPS : TRAIL_LOOSE_BPS;
  if (close <= ride.peak * (1 - trailBps / 10_000)) return true;
  if (close <= ride.entryPrice * (1 - HARD_STOP_BPS / 10_000)) return true;
  if (ride.bars >= TIME_STOP_BARS && gainBps < TIME_STOP_MIN_GAIN_BPS) return true;
  if (ride.bars >= 20 && gainBps < 35 && s.fast.value !== null && s.slow.value !== null && s.fast.value < s.slow.value) return true;
  if (s.fast.value !== null && s.slow.value !== null) {
    if (s.fast.value < s.slow.value && s.momentumBps !== null && s.momentumBps < 0) return true;
  }
  return false;
}

await runBars({
  onBatch(state: BarsState, batch) {
    barIndex++;
    // Learn entry prices from fills (a buy filled at the open of its fill bar).
    for (const f of batch.fills) {
      if (f.side === 'buy' && f.status === 'filled') {
        rides.set(f.symbol, { entryPrice: Number(f.price), peak: Number(f.price), bars: 0, scaled: false });
      }
    }
    const fresh = new Map<string, Series>();
    for (const bar of batch.bars) fresh.set(bar.symbol, pushBar(bar));
    if (state.warmingUp) return [];

    const orders: (BuyInput | SellInput)[] = [];
    const { caps, fees } = state.hello;
    const minNotional = BigInt(fees.min_notional_quote_units);

    for (const { symbol } of state.hello.symbols) {
      const s = fresh.get(symbol);
      if (s === undefined) continue;
      const close = state.close(symbol);
      if (close === null) continue;
      const closeNum = Number(close);
      const held = state.positions.get(symbol);

      if (held !== undefined) {
        let ride = rides.get(symbol);
        if (ride === undefined) {
          // Position we did not open this run (should not happen): anchor
          // the ride at cost so the stops still protect it.
          const qty = Number(held.qty);
          const approx = qty > 0 ? Number(held.cost) / qty : closeNum;
          ride = { entryPrice: approx, peak: closeNum, bars: 0, scaled: false };
          rides.set(symbol, ride);
        }
        ride.bars++;
        if (closeNum > ride.peak) ride.peak = closeNum;
        const gainNowBps = ((closeNum - ride.entryPrice) / ride.entryPrice) * 10_000;
        if (!ride.scaled && gainNowBps >= TAKE_PROFIT_BPS && held.qty > 1n) {
          // Bank half at the take-profit line; the rest keeps riding the
          // trailing stop, so a real trend still pays beyond the cap.
          orders.push({ side: 'sell', symbol, qty: held.qty / 2n, max_slippage_bps: MAX_SLIPPAGE_BPS });
          ride.scaled = true;
          continue;
        }
        if (wantsExit(s, ride, closeNum)) {
          orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          rides.delete(symbol);
          cooldownUntil = barIndex + COOLDOWN_BARS;
        }
        continue;
      }

      // Flat: consider an entry.
      rides.delete(symbol);
      if (barIndex < cooldownUntil) continue;
      if (orders.length >= caps.max_orders_per_bar) continue;
      if (!wantsEntry(s, closeNum)) continue;

      const strength = Math.min(1, (s.momentumBps as number) / SIZE_FULL_BPS);
      const pct = SIZE_WEAK + (SIZE_STRONG - SIZE_WEAK) * strength;
      let notional = (state.equity * BigInt(Math.round(pct))) / 100n;
      const room = state.weightRoom(symbol);
      if (notional > room) notional = room;
      if (notional > state.cash) notional = state.cash;
      if (notional < minNotional) continue;
      orders.push({ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
    }
    return orders;
  },
});
