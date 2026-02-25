'use client'

export default function FloatingBackground() {
  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0, overflow: 'hidden' }}>

      {/* ── Large warm orbs ── */}
      {/* Pink top-left */}
      <div style={{
        position: 'absolute', top: '-12%', left: '-6%',
        width: 580, height: 580, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(212,115,142,0.18) 0%, transparent 68%)',
        filter: 'blur(72px)',
        animation: 'float1 20s ease-in-out infinite',
      }} />

      {/* Green right */}
      <div style={{
        position: 'absolute', top: '25%', right: '-10%',
        width: 500, height: 500, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(106,170,122,0.16) 0%, transparent 68%)',
        filter: 'blur(65px)',
        animation: 'float2 24s ease-in-out infinite',
        animationDelay: '-7s',
      }} />

      {/* Brown/amber center-bottom */}
      <div style={{
        position: 'absolute', bottom: '0%', left: '22%',
        width: 440, height: 440, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(200,135,74,0.14) 0%, transparent 68%)',
        filter: 'blur(60px)',
        animation: 'float3 17s ease-in-out infinite',
        animationDelay: '-4s',
      }} />

      {/* Soft pink center */}
      <div style={{
        position: 'absolute', top: '50%', left: '40%',
        width: 360, height: 360, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(232,160,180,0.12) 0%, transparent 68%)',
        filter: 'blur(55px)',
        animation: 'float4 21s ease-in-out infinite',
        animationDelay: '-11s',
      }} />

      {/* Green bottom-right */}
      <div style={{
        position: 'absolute', bottom: '10%', right: '5%',
        width: 300, height: 300, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(141,196,154,0.15) 0%, transparent 68%)',
        filter: 'blur(50px)',
        animation: 'float1 15s ease-in-out infinite',
        animationDelay: '-3s',
      }} />

      {/* Pink top-right small */}
      <div style={{
        position: 'absolute', top: '8%', right: '20%',
        width: 200, height: 200, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(212,115,142,0.16) 0%, transparent 68%)',
        filter: 'blur(38px)',
        animation: 'drift 19s ease-in-out infinite',
        animationDelay: '-2s',
      }} />

      {/* Brown small left */}
      <div style={{
        position: 'absolute', top: '60%', left: '8%',
        width: 160, height: 160, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(155,118,83,0.14) 0%, transparent 68%)',
        filter: 'blur(32px)',
        animation: 'float2 13s ease-in-out infinite',
        animationDelay: '-6s',
      }} />

      {/* ── Floating rings ── */}
      {[
        { x: '78%', y: '18%', size: 90,  color: 'rgba(212,115,142,0.18)', dur: '16s', delay: '0s',  anim: 'float1' },
        { x: '14%', y: '60%', size: 65,  color: 'rgba(106,170,122,0.18)', dur: '20s', delay: '-5s', anim: 'float2' },
        { x: '58%', y: '82%', size: 50,  color: 'rgba(200,135,74,0.16)',  dur: '13s', delay: '-3s', anim: 'float3' },
        { x: '92%', y: '55%', size: 38,  color: 'rgba(155,118,83,0.18)', dur: '22s', delay: '-9s', anim: 'float4' },
        { x: '35%', y: '12%', size: 44,  color: 'rgba(232,160,180,0.2)',  dur: '17s', delay: '-7s', anim: 'float1' },
      ].map((r, i) => (
        <div key={`ring-${i}`} style={{
          position: 'absolute', left: r.x, top: r.y,
          width: r.size, height: r.size, borderRadius: '50%',
          border: `1.5px solid ${r.color}`,
          animation: `${r.anim} ${r.dur} ease-in-out infinite`,
          animationDelay: r.delay,
        }} />
      ))}

      {/* ── Spinning outer ring ── */}
      <div style={{
        position: 'absolute', top: '30%', right: '8%',
        width: 120, height: 120, borderRadius: '50%',
        border: '1px dashed rgba(212,115,142,0.2)',
        animation: 'spin-slow 30s linear infinite',
      }} />
      <div style={{
        position: 'absolute', bottom: '28%', left: '5%',
        width: 80, height: 80, borderRadius: '50%',
        border: '1px dashed rgba(106,170,122,0.22)',
        animation: 'spin-reverse 22s linear infinite',
      }} />

      {/* ── Diamond shapes ── */}
      {[
        { x: '72%', y: '14%', size: 18, rot: 45, color: 'rgba(212,115,142,0.18)', anim: 'float1', dur: '15s', delay: '-2s' },
        { x: '18%', y: '33%', size: 13, rot: 22, color: 'rgba(106,170,122,0.2)',  anim: 'float2', dur: '12s', delay: '-7s' },
        { x: '50%', y: '74%', size: 16, rot: 35, color: 'rgba(200,135,74,0.18)', anim: 'float3', dur: '17s', delay: '-4s' },
        { x: '88%', y: '72%', size: 11, rot: 60, color: 'rgba(232,160,180,0.22)',anim: 'float4', dur: '11s', delay: '-10s' },
        { x: '6%',  y: '20%', size: 14, rot: 15, color: 'rgba(155,118,83,0.18)', anim: 'float1', dur: '19s', delay: '-5s' },
      ].map((s, i) => (
        <div key={`shape-${i}`} style={{
          position: 'absolute', left: s.x, top: s.y,
          width: s.size, height: s.size,
          background: s.color,
          transform: `rotate(${s.rot}deg)`,
          borderRadius: 3,
          animation: `${s.anim} ${s.dur} ease-in-out infinite, spin-slow 35s linear infinite`,
          animationDelay: s.delay,
        }} />
      ))}

      {/* ── Sparkle dots ── */}
      {[
        { x: '11%',  y: '16%', size: 5, color: 'rgba(212,115,142,0.6)', dur: '3.5s', delay: '0s' },
        { x: '86%',  y: '11%', size: 4, color: 'rgba(106,170,122,0.6)', dur: '4.5s', delay: '-1s' },
        { x: '26%',  y: '78%', size: 6, color: 'rgba(200,135,74,0.5)',  dur: '5s',   delay: '-2s' },
        { x: '68%',  y: '55%', size: 4, color: 'rgba(212,115,142,0.5)', dur: '3.8s', delay: '-0.5s' },
        { x: '52%',  y: '22%', size: 5, color: 'rgba(106,170,122,0.6)', dur: '4.2s', delay: '-3s' },
        { x: '42%',  y: '91%', size: 5, color: 'rgba(155,118,83,0.55)', dur: '6s',   delay: '-1.5s' },
        { x: '91%',  y: '82%', size: 4, color: 'rgba(232,160,180,0.6)', dur: '4.8s', delay: '-4s' },
        { x: '4%',   y: '48%', size: 7, color: 'rgba(200,135,74,0.45)', dur: '5.5s', delay: '-2.5s' },
        { x: '75%',  y: '38%', size: 4, color: 'rgba(106,170,122,0.55)',dur: '3.2s', delay: '-0.8s' },
        { x: '33%',  y: '45%', size: 5, color: 'rgba(212,115,142,0.5)', dur: '4.0s', delay: '-3.5s' },
      ].map((p, i) => (
        <div key={`spark-${i}`} style={{
          position: 'absolute', left: p.x, top: p.y,
          width: p.size, height: p.size, borderRadius: '50%',
          background: p.color,
          boxShadow: `0 0 ${p.size * 2}px ${p.color}`,
          animation: `sparkle ${p.dur} ease-in-out infinite`,
          animationDelay: p.delay,
        }} />
      ))}

      {/* ── Subtle warm dot-grid ── */}
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: 'radial-gradient(circle, rgba(155,118,83,0.06) 1px, transparent 1px)',
        backgroundSize: '40px 40px',
      }} />
    </div>
  )
}
