import type { AgentResult, PriceFeedOutput, BTCQuote } from '../types'

/**
 * PriceFeedAgent
 * ──────────────
 * Consumes the BTC quote.
 * Computes distance from the Kalshi strike price.
 * Price history is maintained client-side by useMarketTick (Binance ticks).
 */
export function runPriceFeed(
  quote: BTCQuote,
  strikePrice: number
): AgentResult<PriceFeedOutput> {
  const start = Date.now()

  const currentPrice = quote.price
  const priceChange1h = currentPrice * (quote.percent_change_1h / 100)
  const priceChangePct1h = quote.percent_change_1h

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

