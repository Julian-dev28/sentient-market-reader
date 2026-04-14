'use client'

import type { AgentTrade } from '@/lib/types'

function exportCSV() {
  fetch('/api/trade-log')
    .then(r => r.json())
    .then(({ trades }: { trades: AgentTrade[] }) => {
      const cols = [
        'id','enteredAt','expiresAt','windowKey','marketTicker','side','limitPrice',
        'contracts','cost','strikePrice','btcPriceAtEntry','pModel','pMarket','edge',
        'status','pnl','settlementPrice','liveMode',
        'sentimentScore','sentimentMomentum','orderbookSkew','sentimentLabel',
        'pLLM','confidence','gkVol','distancePct','minutesLeft','aboveStrike',
        'priceMomentum1h','signals',
      ]
      const esc = (v: unknown) => {
        const s = v === undefined || v === null ? '' : String(v)
        return s.includes(',') || s.includes('"') || s.includes('\n')
          ? `"${s.replace(/"/g, '""')}"` : s
      }
      const rows = trades.map(t => [
        t.id, t.enteredAt, t.expiresAt, t.windowKey, t.marketTicker, t.side,
        t.limitPrice, t.contracts, t.cost, t.strikePrice, t.btcPriceAtEntry ?? '',
        t.pModel, t.pMarket, t.edge, t.status, t.pnl ?? '', t.settlementPrice ?? '',
        t.liveMode ?? '',
        t.signals?.sentimentScore ?? '', t.signals?.sentimentMomentum ?? '',
        t.signals?.orderbookSkew ?? '', t.signals?.sentimentLabel ?? '',
        t.signals?.pLLM ?? '', t.signals?.confidence ?? '',
        t.signals?.gkVol ?? '', t.signals?.distancePct ?? '',
        t.signals?.minutesLeft ?? '', t.signals?.aboveStrike ?? '',
        t.signals?.priceMomentum1h ?? '',
        // signals column = the SentimentOutput.signals string array joined by |
        // (not the TradeSignals object — those are already flattened above)
        '',
      ].map(esc).join(','))

      const csv  = [cols.join(','), ...rows].join('\n')
      const blob = new Blob([csv], { type: 'text/csv' })
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `trade-log-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
    })
    .catch(e => console.error('CSV export failed:', e))
}

export default function AgentTradeLog({ trades, onClearHistory }: { trades: AgentTrade[]; onClearHistory?: () => void }) {
  // Group by window, newest first
  const windowKeys = [...new Set([...trades].reverse().map(t => t.windowKey))]

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>Agent Trade Log</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {trades.length > 0 && (
            <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500 }}>
              {trades.length} bet{trades.length !== 1 ? 's' : ''}
            </span>
          )}
          <button
            onClick={exportCSV}
            style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
              color: 'var(--blue)', background: 'none', border: '1px solid var(--blue)',
              borderRadius: 4, padding: '2px 7px', cursor: 'pointer',
            }}
          >
            Export CSV
          </button>
          {trades.length > 0 && onClearHistory && (
            <button
              onClick={onClearHistory}
              style={{
                fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
                color: 'var(--text-muted)', background: 'none', border: '1px solid var(--border)',
                borderRadius: 4, padding: '2px 7px', cursor: 'pointer',
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {trades.length === 0 ? (
        <div style={{ padding: '24px 0', textAlign: 'center' }}>
          <div style={{ fontSize: 10, letterSpacing: '0.07em', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 6 }}>// NO TRADES YET</div>
          <div style={{ fontSize: 11, color: 'var(--text-light)' }}>Start the agent to begin deploying</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {windowKeys.slice(0, 6).map((wk, wi) => {
            const windowTrades = trades.filter(t => t.windowKey === wk).sort((a, b) => a.sliceNum - b.sliceNum)
            const totalCost    = windowTrades.reduce((s, t) => s + t.cost, 0)
            const totalPnl     = windowTrades.reduce((s, t) => s + (t.pnl ?? 0), 0)
            const anyOpen      = windowTrades.some(t => t.status === 'open')
            const allWon       = !anyOpen && windowTrades.every(t => t.status === 'won')
            const anyLost      = windowTrades.some(t => t.status === 'lost')
            const side         = windowTrades[0]?.side

            return (
              <div key={wk} style={{
                borderBottom: wi < windowKeys.slice(0, 6).length - 1 ? '1px solid var(--border)' : 'none',
                paddingBottom: 10, marginBottom: 10,
                animation: `slideUpFade 0.35s ${wi * 50}ms ease both`,
              }}>
                {/* Window header row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
                  <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, fontWeight: 700, color: side === 'yes' ? 'var(--green-dark)' : 'var(--pink-dark)' }}>
                    {side === 'yes' ? 'Yes' : 'No'}
                  </span>
                  <span style={{ fontSize: 9, fontFamily: 'var(--font-geist-mono)', color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {wk}
                  </span>
                  <span style={{
                    fontSize: 10, fontWeight: 700,
                    color: anyOpen ? 'var(--text-muted)' : allWon ? 'var(--green-dark)' : anyLost ? 'var(--pink-dark)' : 'var(--text-muted)',
                    animation: 'scaleIn 0.25s cubic-bezier(0.34,1.56,0.64,1)',
                  }}>
                    {anyOpen ? 'Open' : allWon ? 'Win' : anyLost ? 'Loss' : '—'}
                  </span>
                  {!anyOpen && totalPnl !== 0 && (
                    <span style={{
                      fontFamily: 'var(--font-geist-mono)', fontSize: 13, fontWeight: 800,
                      color: totalPnl >= 0 ? 'var(--green)' : 'var(--pink)',
                      animation: 'numberPop 0.4s cubic-bezier(0.34,1.56,0.64,1)',
                    }}>
                      {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
                    </span>
                  )}
                </div>

                {/* Individual slices */}
                {windowTrades.map((t, i) => (
                  <div key={t.id} style={{
                    display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center',
                    padding: '4px 0 4px 10px',
                    borderBottom: i < windowTrades.length - 1 ? '1px solid var(--border)' : 'none',
                  }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                        <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 9, color: 'var(--text-secondary)', fontWeight: 700 }}>
                          {t.contracts.toLocaleString()}× @ {t.limitPrice}¢
                        </span>
                        {t.orderError ? (
                          <span style={{ fontSize: 8, color: 'var(--red)', fontWeight: 700, background: 'var(--red-pale)', padding: '1px 4px', borderRadius: 3 }} title={t.orderError}>
                            ✗ FAILED
                          </span>
                        ) : t.liveOrderId ? (
                          <span style={{ fontSize: 8, color: 'var(--green-dark)', fontFamily: 'var(--font-geist-mono)', background: 'var(--green-pale)', padding: '1px 4px', borderRadius: 3 }}>
                            ✓ #{t.liveOrderId.slice(-6)}
                          </span>
                        ) : null}
                      </div>
                      <div style={{ fontSize: 8.5, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)', lineHeight: 1.6 }}>
                        {new Date(t.enteredAt).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })} · edge {t.edge >= 0 ? '+' : ''}{(t.edge * 100).toFixed(1)}%
                      </div>
                      {t.orderError && (
                        <div style={{ fontSize: 8, color: 'var(--red)', fontFamily: 'var(--font-geist-mono)', lineHeight: 1.4, marginTop: 1 }}>
                          {t.orderError}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                      <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11, fontWeight: 800, color: 'var(--text-primary)' }}>
                        ${t.cost.toFixed(2)}
                      </span>
                      {t.pnl !== undefined && (
                        <span style={{
                          fontFamily: 'var(--font-geist-mono)', fontSize: 10, fontWeight: 700,
                          color: t.pnl >= 0 ? 'var(--green)' : 'var(--pink)',
                        }}>
                          {t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}

                {/* Window total */}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5, paddingLeft: 10 }}>
                  <span style={{ fontSize: 8, color: 'var(--text-muted)' }}>
                    {windowTrades.length} bet{windowTrades.length !== 1 ? 's' : ''} placed
                  </span>
                  <span style={{ fontSize: 9, fontFamily: 'var(--font-geist-mono)', fontWeight: 700, color: 'var(--text-secondary)' }}>
                    ${totalCost.toFixed(2)} total
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
