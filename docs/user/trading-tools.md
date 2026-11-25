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
3. Click **Place order**. A market order fills at the current close.
4. Play or step the replay. When a revealed bar reaches the stop or the target, the trade
   closes there and a message reports the result. If one bar reaches both, the trade closes at
   the stop: a bar does not show which level came first, and assuming the worse one keeps the
   statistics honest. **Close** on the **Positions** tab exits at the current close.

### Limit orders

Choose **Limit** under Buy and Sell to wait for a price instead of trading at the close. Type
the **Limit price**, or drag the entry line on the chart: the field and the line follow each
other. A new limit order starts half an average range from the price, below it for a buy and
above it for a sell.

The **Type** row names the order from its side and price: a buy below the price (or a sell
above it) is a **limit** order, and the other side waits for a breakout and is a **stop**
order. A price equal to the current close is refused: choose **Market** for that.

A placed limit order waits under **Pending orders** on the **Positions** tab, and its position
on the chart is locked: cancel it with **Cancel order** to change it. It fills at its price when
a later bar of the replay reaches that price, even if the price gaps past it. The bar that
fills an order can close it only at its stop, never at its take profit, because a bar does not
show whether the fill or the take profit came first.

### Adjusting a running trade

Once an order has filled, its position stays on the chart and you can move its
stop while the trade runs, to cut the risk:

- Drag the stop line on the chart, type a price in the **Stop loss** field on the
  **Positions** tab, or press **SL → break-even** to move it to the entry.
- A stop can only move **closer to the price**, and it must stay beyond the current price. A
  looser stop, or one the price has already reached, is refused with a message and the stop
  stays. The entry and the take profit cannot be moved: they snap back.
- The card shows the stop in use and, in brackets, the one the trade started with.

Results in R are always measured against the **original** stop. A trade closed at a stop that
was moved to break-even is 0R, and one closed at a stop moved into profit is a gain of less
than 1R, whatever the stop's distance was when it closed.

### Trailing stop

Switch on **Trailing stop** and set a distance in percent of the price, when you place the
order or later on the **Positions** tab. The stop then follows the best price since the trade
opened: it rises with a long (falls with a short) and keeps that distance from the best price.
It never moves away from the price again, so a profit that has built up does not fall back to
break-even. A trailing stop starts from the stop you set and moves only once it is closer to
the price than that stop. A bar moves the trail only for the **next** bar: the stop that stood
before a bar is the one that bar is tested against.

Moving the replay to another bar, or leaving it, cancels the open trades and the pending
orders: they are not recorded.

### History and statistics

Closed trades go to the **History** tab, newest first, each with its side, entry and exit, its
result in R (multiples of the risk) and in pips, and how it closed. Remove one trade with its
trash button, or every trade with **Clear history** (click twice to confirm). The trades are
saved with the rest of the workspace when you use `persist`. The candles and screenshots of
each trade are kept in your browser (see [Trade journal and dataset](#trade-journal-and-dataset)).

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

### Trade journal and dataset

Each trade keeps what you need to study it later. Everything stays in your browser (its
IndexedDB storage); nothing is sent anywhere.

- **Two screenshots.** One is taken when you place the order, with the entry, stop, and target
  drawn on the chart; the other when the trade closes. Both show on the trade's card in History
  as thumbnails; click one to see both larger. Turn **Save screenshots** off to keep only the
  candles. Trades closed before this existed have no screenshots.
- **Candles.** Each trade saves the 200 bars up to the bar you placed the order on (that bar
  included) and every bar the replay revealed after it until the trade ended. No bar after the
  placement bar is in the "before" part, even when more history is loaded.
- **Tags and a note.** Type tags (separated by commas, for example `breakout, pullback`) and a
  short note in the Order tab before you place, or edit them later on the trade's card. Tags
  stay for your next order; the note clears.
- **Orders that did not fill.** A limit order you cancel, or one the replay ends before its
  price comes, is listed under **Not filled** in History with its candles. These orders never
  count in the statistics.

**Export backup** writes one file, `vela-trades-<date>.json`, with the trades, the orders that
did not fill, their candles, the pip sizes, and (when **Include screenshots in backup** is on)
their screenshots. **Import** reads such a file back: it adds what you do not have and never
overwrites a trade with the same id, and it says how many it added, how many were already
there, and how many entries it could not use. A file in another format, or made by a newer
version, is refused without changing anything.

**Export dataset** writes `vela-dataset-<date>.jsonl` for analysis or machine learning outside
Vela: one JSON object per line, one line per closed trade and per order that did not fill. Read
it in Python with `pandas.read_json(path, lines=True)`.

| Field | Meaning |
| --- | --- |
| `schema` | Version of this format (1). Check it before reading a file. |
| `id`, `symbol`, `timeframe`, `side` | The trade, its market, and `long` or `short`. |
| `entry`, `tp`, `pip` | Entry price, take profit, and one pip in price units. |
| `initial_sl`, `final_sl` | The stop the trade started with, and the stop it ended with. |
| `trail_pct` | The trailing distance in percent of price, or `null`. |
| `placed_time`, `open_time`, `close_time` | Times (milliseconds) of the bar you placed the order on, the bar that filled it (the same bar for a market order), and the bar that closed it. For an order that did not fill, `open_time` is `null` and `close_time` is when it ended. |
| `bars_held` | Bars after the fill, up to and including the close bar; `null` without saved candles. |
| `planned_rr` | Reward over risk at the start. |
| `outcome` | `tp`, `sl`, `manual`, or for orders that did not fill `cancelled` or `unfilled`. |
| `result_r` | The result in multiples of the risk of the original stop; `null` for orders that did not fill. |
| `mfe_r`, `mae_r` | The furthest the price moved for and against the trade, in the same multiples. |
| `stop_moved` | Whether the stop changed after the order. |
| `tags`, `note` | Your labels (`[]` and `null` when empty). |
| `context` | Candles `[time, open, high, low, close, volume]` up to and including the placement bar. Never holds a later bar. Volume is 0 when the data source gives none. |
| `trade` | Candles after the placement bar until the trade or order ended. |

A trade saved without candles has empty `context` and `trade`.

Trades you place by hand are few and follow your own habits, so a model trained on them alone
is unreliable. Use them as labeled examples next to a much larger set of market data.
