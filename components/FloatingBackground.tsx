'use client'

export default function FloatingBackground() {
  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0, overflow: 'hidden' }}>

      {/* Faint slate-blue blob — top right */}
      <div style={{
        position: 'absolute', top: '-8%', right: '-6%',
        width: 520, height: 520, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(74,127,165,0.07) 0%, transparent 65%)',
        filter: 'blur(80px)',
        animation: 'float2 28s ease-in-out infinite',
      }} />

      {/* Faint stone blob — bottom left */}
      <div style={{
        position: 'absolute', bottom: '-5%', left: '-4%',
        width: 440, height: 440, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(125,112,96,0.06) 0%, transparent 65%)',
        filter: 'blur(70px)',
        animation: 'float3 34s ease-in-out infinite',
        animationDelay: '-12s',
      }} />

      {/* Subtle dot grid */}
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: 'radial-gradient(circle, rgba(26,24,20,0.055) 1px, transparent 1px)',
        backgroundSize: '32px 32px',
      }} />
    </div>
  )
}
