'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAppwrite } from '@/contexts/AppwriteContext'

type ConnStatus = 'checking' | 'connected' | 'unconfigured' | 'error'
type CredSource = 'ui' | 'env' | 'none' | 'db'

interface BalanceData {
  balance?: number
  portfolio_value?: number
}

interface ConnectStatus {
  connected: boolean
  source: CredSource
  apiKey?: string
}

interface ConfigData {
  aiProvider:        string | null
  romaMode:          string | null
  romaMaxDepth:      string | null
  openrouterKeySet:  boolean
  openrouterKeyHint: string | null
  xaiKeySet:         boolean
  anthropicKeySet:   boolean
  kalshiApiKey:      string | null
  kalshiKeyPath:     string | null
}

export default function SettingsPage() {
  const { user, logout } = useAppwrite()
  const router = useRouter()

  // connection state
  const [connStatus, setConnStatus] = useState<ConnStatus>('checking')
  const [credSource, setCredSource] = useState<CredSource>('none')
  const [connectedApiKey, setConnectedApiKey] = useState<string | null>(null)
  const [balance, setBalance]   = useState<BalanceData | null>(null)
  const [connErrMsg, setConnErrMsg] = useState('')

  // upload form state
  const [formApiKey, setFormApiKey]   = useState('')
  const [formPem, setFormPem]         = useState('')
  const [formError, setFormError]     = useState('')
  const [formSubmitting, setFormSubmitting] = useState(false)
  const [disconnecting, setDisconnecting]   = useState(false)
  const [refreshing, setRefreshing]         = useState(false)
  const [dragOver, setDragOver]             = useState(false)
  const [pemFileName, setPemFileName]       = useState<string | null>(null)
  const [showPaste, setShowPaste]           = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // config state
  const [config, setConfig] = useState<ConfigData | null>(null)

  // AI provider keys (stored in localStorage as sentient-provider-keys)
  const [providerKeys, setProviderKeys] = useState({
    openrouter: '', xai: '', anthropic: '', openai: '', huggingface: '',
  })
  const [keysSaved, setKeysSaved] = useState(false)

  useEffect(() => {
    try {
      const stored = localStorage.getItem('sentient-provider-keys')
      if (stored) setProviderKeys(k => ({ ...k, ...JSON.parse(stored) }))
    } catch { /* ignore */ }
  }, [])

  const saveProviderKeys = () => {
    try {
      const trimmed = Object.fromEntries(Object.entries(providerKeys).map(([k, v]) => [k, v.trim()]))
      localStorage.setItem('sentient-provider-keys', JSON.stringify(trimmed))
      setKeysSaved(true)
      setTimeout(() => setKeysSaved(false), 2000)
    } catch { /* ignore */ }
  }

  const loadConnectStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/kalshi-connect', { credentials: 'include' })
      const d = await r.json() as ConnectStatus
      setCredSource(d.source)
      setConnectedApiKey(d.apiKey ?? null)
      return d.connected
    } catch {
      return false
    }
  }, [])

  const checkBalance = useCallback(async () => {
    try {
      const r = await fetch('/api/balance', { credentials: 'include' })
      if (r.status === 401) { setConnStatus('unconfigured'); return }
      const d = await r.json()
      if (!r.ok) { setConnStatus('error'); setConnErrMsg(d.error ?? `HTTP ${r.status}`); return }
      setBalance(d)
      setConnStatus('connected')
    } catch (e) {
      setConnStatus('error')
      setConnErrMsg(String(e))
    }
  }, [])

  const refreshAll = useCallback(async () => {
    setConnStatus('checking')
    setConnErrMsg('')
    setRefreshing(true)
    await loadConnectStatus()
    await checkBalance()
    setRefreshing(false)
  }, [loadConnectStatus, checkBalance])

  const loadConfig = useCallback(async () => {
    try {
      const r = await fetch('/api/settings/config')
      if (r.ok) setConfig(await r.json())
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    refreshAll()
    loadConfig()
  }, [refreshAll, loadConfig])

  // ── Upload form submit ────────────────────────────────────────────────────
  const handleSubmit = async () => {
    setFormError('')
    if (!formApiKey.trim()) { setFormError('API Key ID is required'); return }
    if (!formPem.trim())    { setFormError('Private key (PEM) is required'); return }
    setFormSubmitting(true)
    try {
      const r = await fetch('/api/kalshi-connect', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: formApiKey.trim(), privateKey: formPem.trim() }),
      })
      const d = await r.json()
      if (!r.ok) { setFormError(d.error ?? `HTTP ${r.status}`); return }
      router.push('/dashboard')
    } catch (e) {
      setFormError(String(e))
    } finally {
      setFormSubmitting(false)
    }
  }

  // ── Disconnect ────────────────────────────────────────────────────────────
  const handleDisconnect = async () => {
    setDisconnecting(true)
    try {
      await fetch('/api/kalshi-connect', { method: 'DELETE', credentials: 'include' })
      await refreshAll()
    } finally {
      setDisconnecting(false)
    }
  }

  // ── PEM file loading ──────────────────────────────────────────────────────
  const loadPemFile = (file: File) => {
    setPemFileName(file.name)
    const reader = new FileReader()
    reader.onload = ev => setFormPem(String(ev.target?.result ?? ''))
    reader.readAsText(file)
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) loadPemFile(file)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) loadPemFile(file)
  }

  // ── Derived UI values ─────────────────────────────────────────────────────
  const statusColor = connStatus === 'connected' ? 'var(--green)'
    : connStatus === 'checking' ? 'var(--text-muted)'
    : 'var(--pink)'

  const statusLabel = connStatus === 'connected' ? 'Connected'
    : connStatus === 'checking' ? 'Checking…'
    : connStatus === 'unconfigured' ? 'Not configured'
    : 'Connection error'

  const sourceLabel = credSource === 'db'  ? 'Your account'
    : credSource === 'ui'  ? 'UI upload'
    : credSource === 'env' ? 'Environment vars'
    : null

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {user && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{user.email}</span>
          )}
          <Link href="/dashboard" style={{ fontSize: 12, color: 'var(--text-muted)', textDecoration: 'none', fontWeight: 600 }}>
            ← Dashboard
          </Link>
          {user && (
            <button
              onClick={logout}
              style={{
                fontSize: 12, fontWeight: 600, color: 'var(--text-muted)',
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              }}
            >
              Sign out
            </button>
          )}
        </div>
      </nav>

      <main style={{ maxWidth: 640, margin: '0 auto', padding: '48px 24px' }}>

        {/* ── Kalshi Connection card ── */}
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

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {/* Source badge */}
              {sourceLabel && connStatus === 'connected' && (
                <div style={{
                  padding: '4px 10px', borderRadius: 20, fontSize: 10, fontWeight: 700,
                  color: credSource === 'ui' ? 'var(--blue)' : 'var(--text-muted)',
                  border: `1px solid ${credSource === 'ui' ? 'var(--blue)33' : 'var(--border)'}`,
                  background: credSource === 'ui' ? 'var(--blue)11' : 'transparent',
                  textTransform: 'uppercase', letterSpacing: '0.05em',
                }}>
                  {sourceLabel}
                </div>
              )}

              {/* Status badge */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '6px 14px', borderRadius: 20,
                border: `1px solid ${statusColor}33`,
                background: `${statusColor}11`,
              }}>
                {connStatus === 'checking' ? (
                  <span style={{ fontSize: 11, animation: 'spin-slow 1s linear infinite', display: 'inline-block' }}>◌</span>
                ) : (
                  <span style={{
                    width: 7, height: 7, borderRadius: '50%',
                    background: statusColor, display: 'inline-block',
                    boxShadow: connStatus === 'connected' ? `0 0 6px ${statusColor}` : 'none',
                  }} />
                )}
                <span style={{ fontSize: 12, fontWeight: 700, color: statusColor }}>{statusLabel}</span>
              </div>
            </div>
          </div>

          {/* Connected state — show balance + key info */}
          {connStatus === 'connected' && (
            <>
              {balance && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
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

              {connectedApiKey && (
                <div style={{
                  padding: '10px 14px', borderRadius: 8, marginBottom: 16,
                  background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>API KEY ID</span>
                  <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
                    {connectedApiKey.length > 20 ? `${connectedApiKey.slice(0, 8)}…${connectedApiKey.slice(-4)}` : connectedApiKey}
                  </span>
                </div>
              )}

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={refreshAll}
                  disabled={refreshing}
                  style={{
                    padding: '9px 22px', borderRadius: 9, cursor: refreshing ? 'default' : 'pointer',
                    border: '1px solid var(--border-bright)', background: 'var(--bg-secondary)',
                    color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700,
                    opacity: refreshing ? 0.5 : 1,
                  }}
                >
                  {refreshing ? 'Refreshing…' : 'Refresh'}
                </button>
                {(credSource === 'ui' || credSource === 'db') && (
                  <button
                    onClick={handleDisconnect}
                    disabled={disconnecting}
                    style={{
                      padding: '9px 22px', borderRadius: 9, cursor: disconnecting ? 'default' : 'pointer',
                      border: '1px solid var(--pink)44', background: 'var(--pink)11',
                      color: 'var(--pink)', fontSize: 12, fontWeight: 700,
                      opacity: disconnecting ? 0.5 : 1,
                    }}
                  >
                    {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                )}
              </div>
            </>
          )}

          {/* Error state */}
          {connStatus === 'error' && (
            <div style={{
              padding: '12px 16px', borderRadius: 10, marginBottom: 20,
              background: 'var(--pink-pale)', border: '1px solid #3a1020',
              fontSize: 12, color: 'var(--pink)',
            }}>
              {connErrMsg}
            </div>
          )}

          {/* Not connected — upload form */}
          {(connStatus === 'unconfigured' || connStatus === 'error') && (
            <div style={{ marginTop: connStatus === 'error' ? 0 : 4 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 14 }}>
                Connect your Kalshi account
              </div>

              {/* Step instructions */}
              <ol style={{ margin: '0 0 20px', padding: '0 0 0 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  <>Log in to <strong>kalshi.com</strong> → Account → API Access → Create API Key.</>,
                  <>Copy the <strong>API Key ID</strong> (UUID format) shown after creation.</>,
                  <>Download the <strong>RSA private key</strong> (.pem file) — save it securely.</>,
                  <>Drag the <strong>.pem file</strong> onto the drop zone below, or click to browse.</>,
                ].map((step, i) => (
                  <li key={i} style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{step}</li>
                ))}
              </ol>

              {/* Form */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>
                    API Key ID
                  </label>
                  <input
                    type="text"
                    placeholder="054cf370-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    value={formApiKey}
                    onChange={e => setFormApiKey(e.target.value)}
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      padding: '10px 14px', borderRadius: 9, fontSize: 13,
                      border: '1px solid var(--border-bright)', background: 'var(--bg-secondary)',
                      color: 'var(--text-primary)', fontFamily: 'var(--font-geist-mono)',
                      outline: 'none',
                    }}
                  />
                </div>

                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>
                    Private Key (PEM)
                  </label>

                  {/* Drop zone */}
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={handleDrop}
                    style={{
                      border: `2px dashed ${dragOver ? 'var(--blue)' : pemFileName ? 'var(--green)' : 'var(--border-bright)'}`,
                      borderRadius: 12,
                      background: dragOver ? 'var(--blue)08' : pemFileName ? 'var(--green)08' : 'var(--bg-secondary)',
                      padding: '28px 20px',
                      textAlign: 'center',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                    }}
                  >
                    {pemFileName ? (
                      <>
                        <div style={{ fontSize: 22, marginBottom: 6 }}>✓</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--green)', marginBottom: 3 }}>
                          {pemFileName}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          Drop a different file to replace
                        </div>
                      </>
                    ) : (
                      <>
                        <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.5 }}>⬇</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 3 }}>
                          {dragOver ? 'Drop to load' : 'Drag your .pem file here'}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          or click to browse
                        </div>
                      </>
                    )}
                  </div>

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pem,.key,text/*"
                    onChange={handleFileChange}
                    style={{ display: 'none' }}
                  />

                  {/* Paste toggle */}
                  <button
                    onClick={() => setShowPaste(p => !p)}
                    style={{
                      marginTop: 8, fontSize: 11, fontWeight: 600,
                      color: 'var(--text-muted)', background: 'none',
                      border: 'none', cursor: 'pointer', padding: 0,
                    }}
                  >
                    {showPaste ? '▲ Hide' : '▼ Paste PEM instead'}
                  </button>

                  {showPaste && (
                    <textarea
                      placeholder={'-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----'}
                      value={formPem}
                      onChange={e => { setFormPem(e.target.value); setPemFileName(null) }}
                      rows={7}
                      style={{
                        marginTop: 8,
                        width: '100%', boxSizing: 'border-box',
                        padding: '10px 14px', borderRadius: 9, fontSize: 11,
                        border: '1px solid var(--border-bright)', background: 'var(--bg-secondary)',
                        color: 'var(--text-secondary)', fontFamily: 'var(--font-geist-mono)',
                        outline: 'none', resize: 'vertical', lineHeight: 1.5,
                      }}
                    />
                  )}
                </div>

                {formError && (
                  <div style={{
                    padding: '10px 14px', borderRadius: 8,
                    background: 'var(--pink-pale)', border: '1px solid #3a1020',
                    fontSize: 12, color: 'var(--pink)',
                  }}>
                    {formError}
                  </div>
                )}

                <button
                  onClick={handleSubmit}
                  disabled={formSubmitting}
                  style={{
                    padding: '10px 24px', borderRadius: 9,
                    cursor: formSubmitting ? 'default' : 'pointer',
                    border: 'none', background: 'var(--blue)',
                    color: '#fff', fontSize: 13, fontWeight: 700,
                    opacity: formSubmitting ? 0.6 : 1, alignSelf: 'flex-start',
                  }}
                >
                  {formSubmitting ? 'Saving…' : 'Save & Connect'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── AI Provider Keys card ── */}
        <div style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 16, padding: '24px 28px', marginBottom: 20,
        }}>
          <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', marginBottom: 4 }}>
            AI Provider Keys
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 20 }}>
            Saved locally in your browser. Used for ROMA reasoning — leave blank to use the server default.
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {([
              { key: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-v1-…',  hint: 'Routes any model (Gemini, GPT, Claude, Grok…)' },
              { key: 'xai',        label: 'xAI / Grok',  placeholder: 'xai-…',        hint: 'Direct xAI API — grok-3, grok-4 models' },
              { key: 'anthropic',  label: 'Anthropic',   placeholder: 'sk-ant-…',     hint: 'Direct Anthropic API — Claude models' },
              { key: 'openai',     label: 'OpenAI',      placeholder: 'sk-…',         hint: 'Direct OpenAI API — GPT-4o, o-series models' },
              { key: 'huggingface',label: 'HuggingFace', placeholder: 'hf_…',         hint: 'HuggingFace Inference API — open-source models' },
            ] as { key: keyof typeof providerKeys; label: string; placeholder: string; hint: string }[]).map(({ key, label, placeholder, hint }) => (
              <div key={key}>
                <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 4 }}>
                  {label}
                </label>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 5 }}>{hint}</div>
                <input
                  type="password"
                  placeholder={placeholder}
                  value={providerKeys[key]}
                  onChange={e => setProviderKeys(k => ({ ...k, [key]: e.target.value }))}
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    padding: '9px 14px', borderRadius: 9, fontSize: 12,
                    border: `1px solid ${providerKeys[key] ? 'var(--green)44' : 'var(--border-bright)'}`,
                    background: 'var(--bg-secondary)',
                    color: 'var(--text-primary)', fontFamily: 'var(--font-geist-mono)',
                    outline: 'none',
                  }}
                />
              </div>
            ))}

            <button
              onClick={saveProviderKeys}
              style={{
                padding: '9px 22px', borderRadius: 9, cursor: 'pointer',
                border: 'none',
                background: keysSaved ? 'var(--green)' : 'var(--blue)',
                color: '#fff', fontSize: 12, fontWeight: 700,
                alignSelf: 'flex-start', transition: 'background 0.2s',
              }}
            >
              {keysSaved ? '✓ Saved' : 'Save Keys'}
            </button>
          </div>
        </div>

        {/* ── Config reference card ── */}
        <div style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 16, padding: '24px 28px',
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>API + Model Config</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 18 }}>
            Configured via <code style={{ fontSize: 11 }}>.env.local</code> — showing current values.
          </div>

          {config ? (
            [
              { label: 'LLM Provider',    key: 'AI_PROVIDER',         value: config.aiProvider,        desc: 'Primary reasoning provider for ROMA' },
              { label: 'ROMA Mode',       key: 'ROMA_MODE',           value: config.romaMode,          desc: 'Default analysis depth' },
              { label: 'Max Depth',       key: 'ROMA_MAX_DEPTH',      value: config.romaMaxDepth,      desc: 'Decomposition levels (1=fast, 2+=deeper)' },
{ label: 'OpenRouter Key',  key: 'OPENROUTER_API_KEY',  value: config.openrouterKeySet ? (config.openrouterKeyHint ?? '✓ set') : '✗ not set', desc: 'Required when AI_PROVIDER=openrouter' },
              { label: 'xAI / Grok Key', key: 'XAI_API_KEY',         value: config.xaiKeySet ? '✓ set' : '✗ not set',         desc: 'Required when AI_PROVIDER=grok' },
              { label: 'Anthropic Key',   key: 'ANTHROPIC_API_KEY',   value: config.anthropicKeySet ? '✓ set' : '✗ not set',   desc: 'Required when AI_PROVIDER=anthropic' },
              { label: 'Kalshi API Key',  key: 'KALSHI_API_KEY',      value: config.kalshiApiKey ?? '✗ not set',               desc: 'Kalshi key ID (env var fallback)' },
              { label: 'Kalshi Key Path', key: 'KALSHI_PRIVATE_KEY_PATH', value: config.kalshiKeyPath ?? '✗ not set',          desc: 'Path to .pem file (env var fallback)' },
            ].map(({ label, key, value, desc }) => (
              <div key={key} style={{
                display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, alignItems: 'start',
                padding: '10px 0', borderTop: '1px solid var(--border)',
              }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 2 }}>{label}</div>
                  <code style={{ fontSize: 10, color: 'var(--blue)', fontFamily: 'var(--font-geist-mono)' }}>{key}</code>
                </div>
                <div>
                  <code style={{
                    fontSize: 11, fontFamily: 'var(--font-geist-mono)', display: 'block', marginBottom: 3,
                    color: value?.startsWith('✗') ? 'var(--pink)' : value?.startsWith('✓') ? 'var(--green)' : 'var(--text-primary)',
                  }}>
                    {value ?? '—'}
                  </code>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{desc}</div>
                </div>
              </div>
            ))
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '10px 0' }}>Loading…</div>
          )}
        </div>

      </main>
    </div>
  )
}
