import type { AgentResult, MarketDiscoveryOutput } from '../types'
import { findNearestMarket, minutesUntilExpiry, secondsUntilExpiry } from '../kalshi'
import type { KalshiMarket } from '../types'

/**
 * MarketDiscoveryAgent
 * ─────────────────────
 * Scans the KXBTC15M series for the nearest open market window.
 * Identifies the "price to beat" (strike) from the market context.
 */
export async function runMarketDiscovery(
  markets: KalshiMarket[]
): Promise<AgentResult<MarketDiscoveryOutput>> {
  const start = Date.now()

  const active = findNearestMarket(markets)
  const mins = active ? minutesUntilExpiry(active) : 0
  const secs = active ? secondsUntilExpiry(active) : 0

  // Use floor_strike (first-class Kalshi field) for the "price to beat"
  // Fallback: parse from yes_sub_title ("Price to beat: $65,619.62") or title
  let strikePrice = 0
  if (active?.floor_strike) {
    strikePrice = active.floor_strike
  } else if (active?.yes_sub_title) {
    const match = active.yes_sub_title.match(/\$([\d,]+(?:\.\d+)?)/)
    if (match) strikePrice = parseFloat(match[1].replace(/,/g, ''))
  } else if (active?.title) {
    const match = active.title.match(/\$([\d,]+(?:\.\d+)?)/)
    if (match) strikePrice = parseFloat(match[1].replace(/,/g, ''))
  }

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
