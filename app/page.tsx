'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import s from './landing.module.css'

// ── Scroll-reveal ─────────────────────────────────────────────────────────────
function useReveal() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const els = root.querySelectorAll(`.${s.reveal}`)
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add(s.visible); io.unobserve(e.target) }
      }),
      { threshold: 0.1, rootMargin: '0px 0px -48px 0px' },
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [])
  return ref
}

function r(...extra: (string | undefined)[]) {
  return [s.reveal, ...extra].filter(Boolean).join(' ')
}

// ── Data ──────────────────────────────────────────────────────────────────────
const PIPELINE = [
  { num: '01', name: 'Market Discovery',  desc: 'Finds the active KXBTC15M window, reads floor strike and close time from Kalshi.' },
  { num: '02', name: 'Price Feed',        desc: 'Streams live BTC spot from Coinbase. Fetches 15-min OHLCV candles and 1-min live window.' },
  { num: '03', name: 'Quant Signals',     desc: 'Pre-computes RSI, MACD, Bollinger %B, Garman-Klass vol, Brownian motion and log-normal priors.' },
  { num: '04', name: 'Sentiment Agent',   desc: 'ROMA multi-agent loop. Synthesises regime, velocity, momentum and orderbook pressure into a directional score.' },
  { num: '05', name: 'Probability Model', desc: 'Estimates P(BTC > strike) blending ROMA output with time-weighted quant priors via α-blend.' },
  { num: '06', name: 'Risk + Execution',  desc: 'Kelly sizing, daily loss cap, drawdown limit. Outputs YES / NO / PASS with a limit price.' },
]

const MODES = [
  { name: 'BLITZ', time: '~30', unit: 's',   model: 'qwen3-8b',      desc: 'One decomposition level. Sub-minute re-checks.' },
  { name: 'SHARP', time: '~60', unit: 's',   model: 'qwen3-14b',     desc: 'Two executor subtasks. Default for live cycles.' },
  { name: 'KEEN',  time: '~90', unit: 's',   model: 'qwen3-30b-a3b', desc: '30B sparse MoE. Richer reasoning.' },
  { name: 'SMART', time: '~2',  unit: 'min', model: 'qwen3-max',     desc: 'Full model. Reserved for deep analysis.' },
]

const CODE = [
  { k: 'rsi_9',        v: '67.3',    c: '// approaching overbought',  hi: '' },
  { k: 'macd_hist',    v: '+12.4',   c: '// bullish momentum',         hi: '' },
  { k: 'bollinger_%b', v: '0.74',    c: '// upper-band pressure',      hi: '' },
  { k: 'gk_vol_1h',    v: '0.48%',   c: '// annualised σ via OHLC',    hi: 'amber' },
  { k: 'autocorr_1',   v: '+0.31',   c: '// trending regime',          hi: '' },
  { k: 'velocity',     v: '+$2.1/m', c: '// approaching strike',       hi: '' },
  { k: 'p_brownian',   v: '0.612',   c: '// Brownian P(YES)',          hi: '' },
  { k: 'p_lnBinary',   v: '0.598',   c: '// Black-Scholes digital',    hi: '' },
  { k: 'p_blended',    v: '0.638',   c: '// time-weighted blend',      hi: '' },
  { k: 'edge',         v: '+8.3pp',  c: '// vs market 55.5¢',          hi: 'green' },
]

// ── Component ─────────────────────────────────────────────────────────────────
export default function Landing() {
  const rootRef = useReveal()

  return (
    <div className={s.root} ref={rootRef}>

      {/* Nav */}
      <nav className={s.nav}>
        <a href="/" className={s.navLogo}>
          SENTIENT <span className={s.navLogoAccent}>ROMA</span>
        </a>
        <div className={s.navLinks}>
          <a href="#pipeline" className={s.navLink}>Pipeline</a>
          <a href="#signals"  className={s.navLink}>Signals</a>
          <a href="#modes"    className={s.navLink}>Modes</a>
        </div>
        <Link href="/dashboard" className={s.navCta}>Open App →</Link>
      </nav>

      {/* Hero */}
      <section className={s.hero}>
        <div className={s.heroInner}>
          <p className={s.heroEyebrow}>KXBTC15M · Kalshi Binary Markets</p>
          <h1 className={s.heroHeadline}>
            A QUANT<br />
            <span className={s.heroAccent}>EDGE</span> ON<br />
            EVERY WINDOW
          </h1>
          <p className={s.heroSub}>
            ROMA multi-agent pipeline for Kalshi KXBTC15M.
            Pre-computed quant signals feed parallel LLM reasoning —
            sentiment, probability, risk, execution.
          </p>
          <div className={s.heroCtas}>
            <Link href="/dashboard" className={s.btnPrimary}>Open Dashboard →</Link>
            <a href="#pipeline"     className={s.btnSecondary}>How it works</a>
          </div>
        </div>
        <div className={s.scrollCue}>
          <div className={s.scrollLine} />
          Scroll
        </div>
      </section>

      {/* Stats */}
      <div className={s.statsRow}>
        {[
          { num: '60',  accent: 's',  label: 'Pipeline latency',  desc: 'sharp mode · two parallel ROMA solves' },
          { num: '4',   accent: '×',  label: 'ROMA modes',         desc: 'blitz · sharp · keen · smart' },
          { num: '12',  accent: '+',  label: 'Quant signals',      desc: 'RSI · MACD · GK vol · Black-Scholes · autocorr' },
        ].map(({ num, accent, label, desc }, i) => (
          <div className={`${s.statItem} ${r(i > 0 ? s.d1 : undefined)}`} key={label}>
            <div className={s.statNum}>{num}<span className={s.statAccent}>{accent}</span></div>
            <div className={s.statLabel}>{label}</div>
            <div className={s.statDesc}>{desc}</div>
          </div>
        ))}
      </div>

      {/* Pipeline */}
      <section className={s.section} id="pipeline">
        <div className={s.inner}>
          <p className={`${s.label} ${r()}`}>Agent Pipeline</p>
          <h2 className={`${s.headline} ${r(s.d1)}`}>Six stages.<br />One decision.</h2>
          <p className={`${s.sub} ${r(s.d2)}`}>
            From market tick to signed order in a single cycle.
            Every stage is typed, logged and observable in real time.
          </p>
          <div className={s.pipelineList}>
            {PIPELINE.map((step, i) => (
              <div className={`${s.pipelineItem} ${r(i < 3 ? s.d1 : s.d2)}`} key={step.num}>
                <span className={s.pipelineNum}>{step.num}</span>
                <span className={s.pipelineName}>{step.name}</span>
                <span className={s.pipelineDesc}>{step.desc}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Signals */}
      <section className={s.section} id="signals">
        <div className={s.inner}>
          <p className={`${s.label} ${r()}`}>Quantitative Framework</p>
          <div className={s.signalsGrid}>
            <div>
              <h2 className={`${s.signalsHeadline} ${r(s.d1)}`}>
                The math runs<br />before the LLM.
              </h2>
              <p className={`${s.signalsBody} ${r(s.d2)}`}>
                All indicators are pre-computed in TypeScript before
                the ROMA call. Models reason about derived signals —
                not raw OHLCV data.
              </p>
              <ul className={`${s.signalsList} ${r(s.d2)}`}>
                {[
                  'Garman-Klass volatility — 7.4× more efficient than close-to-close',
                  'Log-normal binary option pricing (Black-Scholes digital)',
                  'Lag-1 autocorrelation for regime detection',
                  'Pressure-weighted orderbook imbalance',
                  'Price velocity + acceleration on 1-min candles',
                  'Dual prior blend — α → 0.70 at expiry',
                ].map(item => (
                  <li className={s.signalItem} key={item}>
                    <span className={s.signalDot} />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className={`${s.codeBlock} ${r(s.d1)}`}>
              {CODE.map(line => (
                <div className={s.codeLine} key={line.k}>
                  <span className={s.codeKey}>{line.k}</span>
                  <span className={line.hi === 'green' ? s.codeGreen : line.hi === 'amber' ? s.codeAmber : s.codeVal}>
                    {line.v}
                  </span>
                  <span className={s.codeComment}>{line.c}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Modes */}
      <section className={s.section} id="modes">
        <div className={s.inner}>
          <p className={`${s.label} ${r()}`}>ROMA Modes</p>
          <h2 className={`${s.headline} ${r(s.d1)}`}>Speed or depth.<br />Your call.</h2>
          <p className={`${s.sub} ${r(s.d2)}`}>
            Each mode selects a Qwen model tier via OpenRouter.
            Override sentiment and probability stages independently.
          </p>
        </div>
        <div className={s.modesGrid}>
          {MODES.map((m, i) => (
            <div className={`${s.modeItem} ${r(i < 2 ? s.d1 : s.d2)}`} key={m.name}>
              <p className={s.modeName}>{m.name}</p>
              <p className={s.modeTime}>{m.time}<span className={s.modeUnit}> {m.unit}</span></p>
              <p className={s.modeModel}>{m.model}</p>
              <p className={s.modeDesc}>{m.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className={s.cta}>
        <div className={s.ctaInner}>
          <h2 className={`${s.ctaHeadline} ${r()}`}>
            TRADE THE<br />NEXT WINDOW
          </h2>
          <p className={`${s.ctaSub} ${r(s.d1)}`}>
            Live BTC data · Kalshi orderbook · ROMA multi-agent reasoning.
          </p>
          <div className={`${s.ctaBtns} ${r(s.d2)}`}>
            <Link href="/dashboard" className={s.btnPrimary}>Open Dashboard →</Link>
            <Link href="/settings"  className={s.btnSecondary}>Connect Kalshi</Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className={s.footer}>
        <span className={s.footerBrand}>Sentient ROMA · KXBTC15M Algotrader</span>
        <div className={s.footerLinks}>
          <Link href="/dashboard" className={s.footerLink}>Dashboard</Link>
          <Link href="/settings"  className={s.footerLink}>Settings</Link>
        </div>
      </footer>

    </div>
  )
}
