import type { AgentResult, PriceFeedOutput, PricePoint, BTCQuote } from '../types'

// Rolling in-memory price history (shared across calls on the server)
const priceHistory: PricePoint[] = []
const MAX_HISTORY = 180  // 3 hours at 1-min resolution

/**
 * PriceFeedAgent
 * ──────────────
 * Consumes the CoinMarketCap BTC quote.
 * Maintains rolling price history.
 * Computes distance from the Kalshi strike price.
 */
export function runPriceFeed(
  quote: BTCQuote,
  strikePrice: number
): AgentResult<PriceFeedOutput> {
  const start = Date.now()

  const currentPrice = quote.price
  const priceChange1h = currentPrice * (quote.percent_change_1h / 100)
  const priceChangePct1h = quote.percent_change_1h

  // Append to rolling history
  priceHistory.push({ timestamp: Date.now(), price: currentPrice })
  if (priceHistory.length > MAX_HISTORY) priceHistory.shift()

  const aboveStrike = strikePrice > 0 ? currentPrice > strikePrice : true
  const distanceFromStrike = strikePrice > 0 ? currentPrice - strikePrice : 0
  const distanceFromStrikePct =
    strikePrice > 0 ? (distanceFromStrike / strikePrice) * 100 : 0

  const output: PriceFeedOutput = {
    currentPrice,
    priceChange1h,
    priceChangePct1h,
    aboveStrike,
    distanceFromStrike,
    distanceFromStrikePct,
    priceHistory: [...priceHistory],
  }

  const direction = aboveStrike ? 'ABOVE' : 'BELOW'
  const sign = distanceFromStrike >= 0 ? '+' : ''
  const reasoning =
    strikePrice > 0
      ? `BTC at $${currentPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })} — ${direction} strike by ${sign}$${Math.abs(distanceFromStrike).toLocaleString('en-US', { maximumFractionDigits: 0 })} (${sign}${distanceFromStrikePct.toFixed(3)}%). 1h change: ${priceChangePct1h >= 0 ? '+' : ''}${priceChangePct1h.toFixed(3)}%.`
      : `BTC at $${currentPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}. No strike price available yet.`

  return {
    agentName: 'PriceFeedAgent',
    status: 'done',
    output,
    reasoning,
    durationMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  }
}

export function getPriceHistory(): PricePoint[] {
  return [...priceHistory]
}
