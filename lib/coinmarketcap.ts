import type { BTCQuote } from './types'

const CMC_BASE = 'https://pro-api.coinmarketcap.com/v1'

export async function getBTCQuote(apiKey: string): Promise<BTCQuote> {
  const url = `${CMC_BASE}/cryptocurrency/quotes/latest?symbol=BTC&convert=USD`
  const res = await fetch(url, {
    headers: {
      'X-CMC_PRO_API_KEY': apiKey,
      Accept: 'application/json',
    },
    next: { revalidate: 0 },
  })
  if (!res.ok) throw new Error(`CMC error: ${res.status}`)
  const data = await res.json()
  const q = data.data?.BTC?.quote?.USD
  if (!q) throw new Error('CMC: no BTC quote in response')
  return {
    price: q.price,
    percent_change_1h: q.percent_change_1h,
    percent_change_24h: q.percent_change_24h,
    volume_24h: q.volume_24h,
    market_cap: q.market_cap,
    last_updated: q.last_updated,
  }
}
