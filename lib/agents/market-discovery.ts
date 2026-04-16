import type { AgentResult, MarketDiscoveryOutput } from '../types'
import { findNearestMarket, minutesUntilExpiry, secondsUntilExpiry } from '../kalshi'
import type { KalshiMarket } from '../types'

/** Extract strike price from a Kalshi market using available fields in priority order. */
function extractStrike(m: KalshiMarket): number {
  if (m.yes_sub_title) {
    const match = m.yes_sub_title.match(/\$([\d,]+(?:\.\d+)?)/)
    if (match) return parseFloat(match[1].replace(/,/g, ''))
  }
  if (m.floor_strike) return m.floor_strike
  if (m.title) {
    const match = m.title.match(/\$([\d,]+(?:\.\d+)?)/)
    if (match) return parseFloat(match[1].replace(/,/g, ''))
  }
  return 0
}

/**
 * MarketDiscoveryAgent
 * ─────────────────────
 * When kxbtcdMarket is provided (highest-liquidity KXBTCD hourly strike),
 * it is used directly as the active market — bypassing KXBTC15M discovery.
 * Otherwise falls back to scanning the KXBTC15M series.
 */
export async function runMarketDiscovery(
  markets: KalshiMarket[],
  kxbtcdMarket?: KalshiMarket | null,
): Promise<AgentResult<MarketDiscoveryOutput>> {
  const start = Date.now()

  // ── KXBTCD override (hourly, highest-liquidity strike) ────────────────────
  if (kxbtcdMarket) {
    const mins = minutesUntilExpiry(kxbtcdMarket)
    const secs = secondsUntilExpiry(kxbtcdMarket)
    const strikePrice = extractStrike(kxbtcdMarket)

    return {
      agentName: 'MarketDiscoveryAgent',
      status: 'done',
      output: { activeMarket: kxbtcdMarket, strikePrice, minutesUntilExpiry: mins, secondsUntilExpiry: secs },
      reasoning: `KXBTCD hourly: selected ${kxbtcdMarket.ticker} (highest liquidity) — expires in ${mins.toFixed(1)} min. Strike: $${strikePrice.toLocaleString()}.`,
      durationMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    }
  }

  // ── KXBTC15M discovery (default 15-min window) ────────────────────────────
  const active = findNearestMarket(markets)
  const mins = active ? minutesUntilExpiry(active) : 0
  const secs = active ? secondsUntilExpiry(active) : 0
  const strikePrice = active ? extractStrike(active) : 0

  const output: MarketDiscoveryOutput = {
    activeMarket: active,
    strikePrice,
    minutesUntilExpiry: mins,
    secondsUntilExpiry: secs,
  }

  const reasoning = active
    ? `Found active market ${active.ticker} — expires in ${mins.toFixed(1)} min. Strike: $${strikePrice.toLocaleString()}.`
    : 'No open KXBTC15M markets found. Waiting for next window to open.'

  return {
    agentName: 'MarketDiscoveryAgent',
    status: active ? 'done' : 'skipped',
    output,
    reasoning,
    durationMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  }
}
