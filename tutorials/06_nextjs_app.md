# Next.js App

## Running

```bash
# From project root
npm run dev
```

App runs at `http://localhost:3000`. Uses Next.js 16 App Router.

## Pages

| Route | File | Purpose |
|-------|------|---------|
| `/` | `app/page.tsx` | Redirect to `/dashboard` |
| `/dashboard` | `app/dashboard/page.tsx` | Main trading dashboard |
| `/agent` | `app/agent/page.tsx` | Agent-only view (no market card) |
| `/login` | `app/login/page.tsx` | Auth (Appwrite) |
| `/settings` | `app/settings/page.tsx` | Connect Kalshi credentials |

## Dashboard Layout

3-column grid: `310px 1fr 290px`, max-width 1560px.

```
┌─────────────┬──────────────────────┬──────────────┐
│ MarketCard  │ Control Bar          │ PositionsPanel│
│             │ (mode toggle,        │               │
│ SignalPanel │  model picker,       │ MarkovPanel   │
│             │  run button)         │               │
│             ├──────────────────────│ Signal Card   │
│             │ PriceChart (canvas)  │ (if approved) │
│             ├──────────────────────│               │
│             │ AgentPipeline        │               │
│             ├──────────────────────│               │
│             │ PipelineHistory      │               │
└─────────────┴──────────────────────┴──────────────┘
```

## Key State in `app/dashboard/page.tsx`

```typescript
const [botActive, setBotActive]       = useState(false)   // auto-run every 5min
const [analysisMode, setAnalysisMode] = useState<'quant' | 'ai'>('quant')
const [orModel, setOrModel]           = useState('grok-3') // AI mode only

// Live market tick (2s polling)
const { liveMarket, liveOrderbook, liveBTCPrice, livePriceHistory } = useMarketTick(marketTicker)

// Pipeline runner
const { pipeline, history, streamingAgents, isRunning, runCycle } = usePipeline(
  true, botActive, aiRisk, undefined, undefined,
  analysisMode === 'ai' ? orModel : undefined,
  liveBTCPrice, liveStrikePrice, '15m',
)
```

## Analysis Modes

### Quant Mode
Pure mathematical signal: d-score, Cornish-Fisher CF-VaR, GK volatility, Markov chain, Kelly sizing. Deterministic, ~2s per run. No LLM calls.

### AI Mode
Quant pipeline + Grok AI risk manager via ROMA multi-agent loop. Uses xAI Grok models. ~30–120s per run depending on model and depth. Controlled by `XAI_API_KEY`.

Available models:
- `grok-3` — most capable, ~90s
- `grok-3-fast` — faster, good quality
- `grok-3-mini` — compact reasoning
- `grok-3-mini-fast` — fastest, lowest cost

## usePipeline Hook

`hooks/usePipeline.ts` — core hook that manages pipeline execution.

```typescript
const { pipeline, history, streamingAgents, isRunning, serverLocked, nextCycleIn, error, runCycle, stopCycle, monitorDeltaPct } = usePipeline(
  liveMode: boolean,
  botActive: boolean,
  aiRisk: boolean,
  onTrade?: (trade: TradeRecord) => void,
  initialHistory?: PipelineResult[],
  orModel?: string,
  liveBTCPrice?: number,
  liveStrikePrice?: number,
  interval?: string,
)
```

- Calls `POST /api/pipeline` to run a cycle
- In bot mode: auto-runs every 5 minutes
- In AI mode with `botActive`: re-runs when BTC moves ≥0.20% from last run price (`monitorDeltaPct`)
- `serverLocked` = another pipeline cycle is already running (server-side mutex via `lib/pipeline-lock.ts`)

## useMarketTick Hook

`hooks/useMarketTick.ts` — live market data every 2 seconds.

```typescript
const { liveMarket, liveOrderbook, liveBTCPrice, livePriceHistory, refresh } = useMarketTick(ticker)
```

- `ticker = null` → auto-discovers active KXBTC15M market
- `ticker = 'KXBTC15M-...'` → tracks specific market
- `livePriceHistory` — array of `{time, price}` for PriceChart (last 200 points)
- BTC price: Coinbase primary → CoinGecko fallback

## Components

### MarketCard
Shows: current market ticker, strike price, BTC price, distance from strike (%), yes/no ask prices, countdown timer. Live orderbook depth bar.

### PriceChart
`components/PriceChart.tsx` — 60fps Canvas chart with Catmull-Rom spline interpolation.
- Strike price rendered as horizontal dashed line
- Price above strike: green fill; below: red fill
- Renders `livePriceHistory` (real-time) at 2s update rate
- Height controlled by wrapper — currently ~220px

### AgentPipeline
Displays each agent's status (pending/running/done/error) in a vertical card stack. Streaming agents animate. In AI mode shows ROMA sub-steps.

### SignalPanel
Shows Markov signal output: P(YES), gap, persist, Hurst, GK vol, d-score, minutes left, recommendation chip.

### MarkovPanel
Visualizes the 9×9 transition matrix as a heatmap and shows the current state distribution.

### PositionsPanel
Auto-refreshes every 15s. Shows: Kalshi balance, open positions with contracts/value, resting orders with cancel button.

### PipelineHistory
Accordion list of past pipeline runs. Each row shows: mode, verdict (YES/NO/NO_TRADE), p_yes, key gate results.

## API Routes

All routes in `app/api/`:

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/pipeline` | POST | Run agent pipeline cycle |
| `/api/market` | GET | Fetch active KXBTC15M market |
| `/api/btc-price` | GET | BTC spot price (Coinbase → CoinGecko) |
| `/api/place-order` | POST | Place Kalshi limit order |
| `/api/balance` | GET | Kalshi account balance |
| `/api/positions` | GET | Open positions + resting orders |
| `/api/cancel-order/[orderId]` | DELETE | Cancel resting order |
| `/api/kalshi-connect` | GET/POST/DELETE | Manage per-user Kalshi creds (Appwrite) |

## Trade Alert Modal

When the pipeline completes with a non-PASS execution signal, a modal pops up:
- Shows direction (↑/↓), price, edge, P(model)
- "Buy $40" button places a real order immediately via `/api/place-order`
- Dismissed per-window (stored in `localStorage`) — won't re-show for same window

```typescript
useEffect(() => {
  if (ex.action !== 'PASS' && ex.side && ex.limitPrice != null) {
    const windowKey = mdOut.activeMarket?.event_ticker ?? ...
    if (alertShownWindowRef.current === windowKey) return
    if (getDismissedKey() === windowKey) return
    alertShownWindowRef.current = windowKey
    setTradeAlert({ action: ex.action, side: ex.side, limitPrice: ex.limitPrice, ... })
  }
}, [pipeline])
```

## Design System

```css
--bg-primary:    #faf7f2    /* warm cream */
--bg-secondary:  #f2ede5
--bg-card:       #ffffff
--border:        rgba(180,155,120,0.25)
--text-primary:  #2c2419
--text-secondary:#6b5744
--text-muted:    #9c8572
--green:         #3a9e72
--green-dark:    #2d6b50
--green-pale:    rgba(58,158,114,0.1)
--pink:          #e06fa0
--blue:          #4a7fa5
--blue-dark:     #2e5a7a
--brown:         #8b6f47
--amber:         #d4872c
--red:           #c0453e
--font-geist-mono: (monospace stack)
```

Cards: `background: var(--bg-card)`, `border-radius: 16px`, `border: 1px solid var(--border)`, `box-shadow: 0 2px 12px rgba(0,0,0,0.06)`.

Layout uses inline styles throughout (no Tailwind, no CSS modules for layout).

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Shift+R` | Run / stop pipeline cycle |

## Environment Variables (`.env.local`)

```env
KALSHI_API_KEY=...
KALSHI_PRIVATE_KEY_PATH=./kalshi_private.pem
ANTHROPIC_API_KEY=...
XAI_API_KEY=...
NEXT_PUBLIC_APPWRITE_ENDPOINT=...
NEXT_PUBLIC_APPWRITE_PROJECT_ID=...
ENCRYPTION_KEY=...   # 64-char hex for AES-256-GCM
ROMA_MAX_DEPTH=1
```
