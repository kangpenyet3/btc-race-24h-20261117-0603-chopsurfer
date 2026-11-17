# btc-race-24h-20261117-0603-chopsurfer

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/kangpenyet3/btc-race-24h-20261117-0603-chopsurfer/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/kangpenyet3/btc-race-24h-20261117-0603-chopsurfer/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

ChopSurfer: a regime-gated momentum rider for 1-minute cbBTC bars. It only
buys when momentum over the last 25 bars clears a floor that floats with the
market's own chop, the fast EMA confirms the trend, and volatility is calm
enough not to shake out its trailing stop. Exits are protective: a trailing
stop that tightens once the ride is green, a hard stop, a trend-break exit
and a time stop, followed by a cooldown so the same wiggle is never paid
for twice.

## Run it

```sh
node main.ts   # driven by the bars-replay harness over stdin/stdout
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=846718m5&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
