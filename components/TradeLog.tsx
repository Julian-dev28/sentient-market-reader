'use client'

import type { TradeRecord } from '@/lib/types'

export default function TradeLog({ trades }: { trades: TradeRecord[] }) {
  const displayed = [...trades].reverse().slice(0, 12)

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>Paper Trade Log</div>
        {trades.length > 0 && (
          <span className="pill pill-brown" style={{ animation: 'scaleIn 0.25s ease' }}>
            {trades.length} trades
          </span>
        )}
      </div>

      {displayed.length === 0 ? (
        <div style={{ padding: '24px 0', textAlign: 'center' }}>
          <div style={{ fontSize: 10, letterSpacing: '0.07em', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 6 }}>// NO TRADES YET</div>
          <div style={{ fontSize: 11, color: 'var(--text-light)' }}>Pipeline runs every 5 min</div>
        </div>
      ) : displayed.map((trade, i) => {
        const win    = trade.outcome === 'WIN'
        const open   = trade.outcome === 'PENDING'
        const sideUp = trade.side === 'yes'

        return (
          <div
            key={trade.id}
            style={{
              padding: '9px 0',
              borderBottom: i < displayed.length - 1 ? '1px solid var(--border)' : 'none',
              display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center',
              animation: `slideUpFade 0.35s ${i * 40}ms ease both`,
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                <span className={`pill ${sideUp ? 'pill-green' : 'pill-pink'}`} style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 9 }}>
                  BUY {trade.side.toUpperCase()}
                </span>
                <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 9, color: 'var(--text-muted)' }}>
                  {trade.contracts}× @ {trade.limitPrice}¢
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                {trade.liveMode && (
                  <span style={{ fontSize: 8, fontWeight: 700, color: 'var(--green-dark)', background: 'var(--green-pale)', border: '1px solid #a8d8b5', borderRadius: 3, padding: '0px 4px' }}>LIVE</span>
                )}
                {trade.liveOrderId && (
                  <span style={{ fontSize: 8, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)' }} title={`Order ID: ${trade.liveOrderId}`}>
                    #{trade.liveOrderId.slice(-6)}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 8.5, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)', lineHeight: 1.6 }}>
                {new Date(trade.enteredAt).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })} UTC · edge {trade.edge >= 0 ? '+' : ''}{(trade.edge * 100).toFixed(1)}%<br />
                Strike ${trade.strikePrice.toLocaleString('en-US', { maximumFractionDigits: 0 })} · ${trade.btcPriceAtEntry.toLocaleString('en-US', { maximumFractionDigits: 0 })} at entry
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
              <span
                className={`pill ${open ? 'pill-cream' : win ? 'pill-green' : 'pill-pink'}`}
                style={{ animation: 'scaleIn 0.25s cubic-bezier(0.34,1.56,0.64,1)' }}
              >
                {open ? 'OPEN' : win ? 'WIN' : 'LOSS'}
              </span>
              {trade.pnl !== undefined && !open && (
                <span style={{
                  fontFamily: 'var(--font-geist-mono)', fontSize: 13, fontWeight: 800,
                  color: trade.pnl >= 0 ? 'var(--green)' : 'var(--pink)',
                  animation: 'numberPop 0.4s cubic-bezier(0.34,1.56,0.64,1)',
                }}>
                  {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}
                </span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
