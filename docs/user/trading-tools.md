# Trading tools: replay, watchlist, and trade simulator

The workspace ships three tools for working through a trading plan: bar replay controls, a
watchlist, and a trade simulator for backtesting by hand. They are built on the same public
seams a plugin uses (a topbar action, a widget attachment, side panels, and saved state), so
they appear in every `VelaWorkspace` (and `VelaWidget`) without any option.

## Bar replay controls

Click **Bar replay** in the topbar, then click a bar on the chart. The chart rewinds to that
bar and a replay strip appears above the bottom bar. From the strip you can:

- **Select bar** — pick another start bar with a click on the chart.
- **Go to date** — pick a day from a calendar. The chart rewinds to the start of that day
  (UTC), so its first bar is the next one revealed; if the loaded history does not reach that
  far, older bars load first.
- **Play / Pause** — reveal one bar per tick at the chosen **speed**: 0.5×, 1×, 2×, 3×, 5×,
  or 10× (10× reveals ten bars a second).
- **Forward one bar** — reveal exactly one more bar.
- **Exit replay** (×) — bring the full history back and resume live updates.

The strip shows the replay's current bar time and how many bars are left. It drives
[`ws.replay`](./workspace.md#bar-replay-across-the-grid), so in a multi-chart layout every chart replays on one
clock. A replay never extends the history by scrolling back.

## Watchlist

Open **Watchlist** from the panel buttons in the topbar. A fresh watchlist starts with the
chart's symbol and a few major pairs that your data sources list.

- **Add a symbol**: type its ticker in the box at the top and press Enter, or click **+** in
  the panel header to add the symbol the chart shows. A ticker no data source lists is refused
  with a message.
- **Show a symbol**: click its row (or focus it and press Enter). The row of the symbol on the
  active chart is highlighted.
- **Reorder**: drag a row onto another.
- **Remove**: hover a row and click its ×, or focus it and press Delete.

Each row shows the last price and the change against the previous daily close. Prices refresh
every 30 seconds while the panel is open. The list is saved with the rest of the workspace
when you use `persist`.

## Trade simulator

Open **Trading simulator** from the panel buttons. Trades run on a bar replay, so start one
first (the panel offers a **Start bar replay** button).

1. Click **Buy** or **Sell**. The replay pauses and a long or short position appears on the
   chart at the current bar's close. Its stop loss sits one average true range (14 bars) away,
   and its take profit twice as far, for a 1:2 risk:reward.
2. Drag the stop and target levels on the chart. The **Order** tab shows the entry, the
   levels, the risk and reward in pips, and the risk:reward live.
3. Click **Place order**. The order fills at the current close, and the position on the chart
   locks.
4. Play or step the replay. When a revealed bar reaches the stop or the target, the trade
   closes there and a message reports the result. If one bar reaches both, the trade closes at
   the stop: a bar does not show which level came first, and assuming the worse one keeps the
   statistics honest. **Close** on the **Positions** tab exits at the current close.

Moving the replay to another bar, or leaving it, cancels the open trades: they are not
recorded.

### History and statistics

Closed trades go to the **History** tab, newest first, each with its side, entry and exit, its
result in R (multiples of the risk) and in pips, and how it closed. Remove one trade with its
trash button, or every trade with **Clear history** (click twice to confirm). The history is
saved with the rest of the workspace when you use `persist`.

The **Stats** tab shows your results as figures and charts. The **Statistics for** menu at the
top scopes everything below it to the chart's symbol or to all symbols. From top to bottom:

- **Net result**: the sum of every result in R (multiples of the risk), with the number of
  trades and the net in pips under it.
- **Win rate**: the share of profitable trades, with a bar split into wins, losses, and
  breakeven trades (closed exactly at their entry), and their counts.
- **Figures**: the average result per trade, the maximum drawdown (the largest fall of the
  running result from its highest point, in R and in pips), the longest losing streak (with the
  longest winning streak under it), and the total number of trades.
- **Equity curve**: the running result in R after each trade. A curve that climbs steadily
  means your plan is working; long flat or falling stretches show where it is not.
- **Results per trade**: one bar per trade, above zero for a gain and below for a loss. With
  more than 50 trades, the chart shows the newest 50.
- **Drawdown**: how far below its best the running result stood after each trade.
- **Target ratios**: for each risk:reward from 1:1 to 1:5, how often trades moved that far in
  their favor before their stop, and the expectancy (the average result per trade in R, had
  every trade used that target). The **Recommended** ratio is the one with the best positive
  expectancy, once at least 10 trades have a known outcome at that ratio. A trade that closed
  at its own target below a ratio says nothing about that ratio, so it does not count there.
  **Show as table** lists the same values as a table.

Hover a chart to read the value at a trade.

### Pip size

A pip defaults to the symbol's smallest price step (its tick size, for example 0.01 on
BTCUSDT), which makes pip counts large on such symbols. With **This symbol** selected, set the
**Pip size** card at the bottom of the Stats tab to the size you count in, for example 1 to
count BTCUSDT in whole dollars. The setting applies to that symbol's past and future trades,
and it is saved with the workspace. Clear the field to go back to the tick size.
