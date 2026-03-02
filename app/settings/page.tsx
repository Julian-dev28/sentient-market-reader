'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'

type Status = 'checking' | 'connected' | 'unconfigured' | 'error'

interface BalanceData {
  balance?: number
  portfolio_value?: number
}

export default function SettingsPage() {
  const [status, setStatus]   = useState<Status>('checking')
  const [balance, setBalance] = useState<BalanceData | null>(null)
  const [errMsg, setErrMsg]   = useState<string>('')

  const checkConnection = useCallback(async () => {
    setStatus('checking')
    setErrMsg('')
    try {
      const res = await fetch('/api/balance')
      if (res.status === 401) {
        setStatus('unconfigured')
        return
      }
      const data = await res.json()
      if (!res.ok) {
        setStatus('error')
        setErrMsg(data.error ?? `HTTP ${res.status}`)
        return
      }
      setBalance(data)
      setStatus('connected')
    } catch (e) {
      setStatus('error')
      setErrMsg(String(e))
    }
  }, [])

  useEffect(() => { checkConnection() }, [checkConnection])

  const statusColor = status === 'connected' ? 'var(--green)'
    : status === 'checking' ? 'var(--text-muted)'
    : 'var(--pink)'

  const statusLabel = status === 'connected' ? 'Connected'
    : status === 'checking' ? 'Checking…'
    : status === 'unconfigured' ? 'Not configured'
    : 'Connection error'

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>

      {/* Nav */}
      <nav style={{
        borderBottom: '1px solid var(--border)',
        padding: '10px 24px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: 'rgba(5,5,7,0.85)', backdropFilter: 'blur(20px)',
        position: 'sticky', top: 0, zIndex: 100,
      }}>
        <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.03em', color: 'var(--text-primary)' }}>
          Sentient <span style={{ color: 'var(--blue)' }}>ROMA</span>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 10, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            Settings
          </span>
        </div>
        <Link href="/dashboard" style={{ fontSize: 12, color: 'var(--text-muted)', textDecoration: 'none', fontWeight: 600 }}>
          ← Dashboard
        </Link>
      </nav>

      <main style={{ maxWidth: 640, margin: '0 auto', padding: '48px 24px' }}>

        {/* Kalshi connection card */}
        <div style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 16, padding: '28px 28px 24px', marginBottom: 20,
        }}>
          {/* Header row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', marginBottom: 3 }}>
                Kalshi Connection
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                API key + RSA private key for order signing
              </div>
            </div>

            {/* Status badge */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '6px 14px', borderRadius: 20,
              border: `1px solid ${statusColor}33`,
              background: `${statusColor}11`,
            }}>
              {status === 'checking' ? (
                <span style={{ fontSize: 11, animation: 'spin-slow 1s linear infinite', display: 'inline-block' }}>◌</span>
              ) : (
                <span style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: statusColor, display: 'inline-block',
                  boxShadow: status === 'connected' ? `0 0 6px ${statusColor}` : 'none',
                }} />
              )}
              <span style={{ fontSize: 12, fontWeight: 700, color: statusColor }}>{statusLabel}</span>
            </div>
          </div>

          {/* Connected state — show balance */}
          {status === 'connected' && balance && (
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20,
            }}>
              {[
                { label: 'Available Balance', value: balance.balance != null ? `$${(balance.balance / 100).toFixed(2)}` : '—' },
                { label: 'Portfolio Value',   value: balance.portfolio_value != null ? `$${(balance.portfolio_value / 100).toFixed(2)}` : '—' },
              ].map(({ label, value }) => (
                <div key={label} style={{
                  padding: '14px 16px', borderRadius: 10,
                  background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>{label}</div>
                  <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 20, fontWeight: 800, color: 'var(--text-primary)' }}>{value}</div>
                </div>
              ))}
            </div>
          )}

          {/* Error state */}
          {status === 'error' && (
            <div style={{
              padding: '12px 16px', borderRadius: 10, marginBottom: 20,
              background: 'var(--pink-pale)', border: '1px solid #3a1020',
              fontSize: 12, color: 'var(--pink)',
            }}>
              {errMsg}
            </div>
          )}

          {/* Not configured — setup instructions */}
          {status === 'unconfigured' && (
            <div style={{ marginBottom: 20 }}>
              <div style={{
                padding: '14px 16px', borderRadius: 10, marginBottom: 16,
                background: 'rgba(212,135,44,0.08)', border: '1px solid rgba(212,135,44,0.25)',
                fontSize: 12, color: 'var(--amber)', lineHeight: 1.6,
              }}>
                <strong>KALSHI_API_KEY</strong> and <strong>KALSHI_PRIVATE_KEY_PATH</strong> are not set in <code>.env.local</code>.
              </div>

              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 12 }}>
                Setup instructions
              </div>
              <ol style={{ margin: 0, padding: '0 0 0 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[
                  <>Log in to <strong>kalshi.com</strong> → Account → API Access → Create API Key.</>,
                  <>Save the <strong>API Key ID</strong> (e.g. <code>054cf370-...</code>) — this is your <code>KALSHI_API_KEY</code>.</>,
                  <>Download the <strong>RSA private key</strong> (.pem file) to your project root.</>,
                  <>Add both to <code>.env.local</code> in the project root:</>,
                ].map((step, i) => (
                  <li key={i} style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{step}</li>
                ))}
              </ol>

              <div style={{
                marginTop: 14, padding: '14px 16px', borderRadius: 10,
                background: '#0a0a14', border: '1px solid var(--border)',
                fontFamily: 'var(--font-geist-mono)', fontSize: 12,
                color: 'var(--text-secondary)', lineHeight: 1.8,
              }}>
                <span style={{ color: 'var(--text-muted)' }}># .env.local</span><br />
                <span style={{ color: 'var(--blue)' }}>KALSHI_API_KEY</span>=<span style={{ color: 'var(--green)' }}>your-api-key-id</span><br />
                <span style={{ color: 'var(--blue)' }}>KALSHI_PRIVATE_KEY_PATH</span>=<span style={{ color: 'var(--green)' }}>./kalshi_private_key.pem</span>
              </div>
            </div>
          )}

          {/* Test / Refresh button */}
          <button
            onClick={checkConnection}
            disabled={status === 'checking'}
            style={{
              padding: '9px 22px', borderRadius: 9, cursor: status === 'checking' ? 'default' : 'pointer',
              border: '1px solid var(--border-bright)', background: 'var(--bg-secondary)',
              color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700,
              opacity: status === 'checking' ? 0.5 : 1, transition: 'all 0.15s',
            }}
          >
            {status === 'checking' ? 'Testing…' : 'Test Connection'}
          </button>
        </div>

        {/* Config reference card */}
        <div style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 16, padding: '24px 28px',
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>API + Model Config</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 18 }}>
            All configured via <code style={{ fontSize: 11 }}>.env.local</code> in the project root.
          </div>

          {[
            { label: 'LLM Provider',      key: 'AI_PROVIDER',          example: 'openrouter',                 desc: 'Primary reasoning provider for ROMA' },
            { label: 'ROMA Mode',         key: 'ROMA_MODE',            example: 'blitz | sharp | keen | smart', desc: 'Default mode; overrideable per cycle' },
            { label: 'OpenRouter Key',    key: 'OPENROUTER_API_KEY',   example: 'sk-or-v1-...',               desc: 'Required when AI_PROVIDER=openrouter' },
            { label: 'xAI / Grok Key',   key: 'XAI_API_KEY',          example: 'xai-...',                    desc: 'Required when AI_PROVIDER=grok' },
            { label: 'Python ROMA URL',   key: 'PYTHON_ROMA_URL',      example: 'http://localhost:8001',      desc: 'roma-dspy microservice endpoint' },
          ].map(({ label, key, example, desc }) => (
            <div key={key} style={{
              display: 'grid', gridTemplateColumns: '140px 1fr', gap: 12, alignItems: 'start',
              padding: '10px 0', borderTop: '1px solid var(--border)',
            }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 2 }}>{label}</div>
                <code style={{ fontSize: 10, color: 'var(--blue)', fontFamily: 'var(--font-geist-mono)' }}>{key}</code>
              </div>
              <div>
                <code style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)', display: 'block', marginBottom: 3 }}>{example}</code>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{desc}</div>
              </div>
            </div>
          ))}
        </div>

      </main>
    </div>
  )
}
