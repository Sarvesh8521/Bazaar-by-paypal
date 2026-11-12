import { useId } from 'react';
import type { Persona } from '../server/agents.ts';

export type Mood = 'calm' | 'scheming' | 'pleased' | 'delighted' | 'shocked' | 'sulking';
export type Tone = 'buyer' | 'seller';

const INK = '#1a1030';

/* ------------------------------------------------------------------ *
 * The two agents are paper lanterns. Teal = buyer, amber = seller.
 * Face, brows and accessories show mood and persona.
 * ------------------------------------------------------------------ */
export function Lantern({ tone, mood = 'calm', persona, speaking = false, size = 140 }: { tone: Tone; mood?: Mood; persona: Persona; speaking?: boolean; size?: number }) {
  const uid = useId().replace(/:/g, '');
  const g = `lg-${uid}`;
  const f = `lf-${uid}`;

  const eyes = (() => {
    switch (mood) {
      case 'pleased':
      case 'delighted':
        return (
          <g fill="none" stroke={INK} strokeWidth="3.5" strokeLinecap="round">
            <path d="M49 99 q7 -9 14 0" />
            <path d="M77 99 q7 -9 14 0" />
          </g>
        );
      case 'shocked':
        return (
          <g fill={INK}>
            <circle cx="56" cy="96" r="8" />
            <circle cx="84" cy="96" r="8" />
            <circle cx="58" cy="93" r="2.4" fill="#fff" />
            <circle cx="86" cy="93" r="2.4" fill="#fff" />
          </g>
        );
      case 'scheming':
        return (
          <g fill={INK}>
            <circle cx="56" cy="97" r="5.5" />
            <circle cx="84" cy="97" r="5.5" />
            <path d="M48 94 H64 M76 94 H92" stroke={INK} strokeWidth="4" strokeLinecap="round" />
          </g>
        );
      default:
        return (
          <g fill={INK}>
            <circle cx="56" cy="96" r="5.5" />
            <circle cx="84" cy="96" r="5.5" />
          </g>
        );
    }
  })();

  const mouth = (() => {
    const base = { fill: 'none', stroke: INK, strokeWidth: 3.5, strokeLinecap: 'round' as const };
    switch (mood) {
      case 'delighted':
        return <path d="M57 115 q13 22 26 0 z" fill={INK} stroke={INK} strokeWidth="2" strokeLinejoin="round" />;
      case 'pleased':
        return <path d="M58 117 q12 12 24 0" {...base} />;
      case 'scheming':
        return <path d="M58 121 q14 6 24 -6" {...base} />;
      case 'shocked':
        return <ellipse cx="70" cy="123" rx="5" ry="7" fill={INK} />;
      case 'sulking':
        return <path d="M60 127 q10 -9 20 0" {...base} />;
      default:
        return <path d="M60 121 q10 4 20 0" {...base} />;
    }
  })();

  const flourish = (() => {
    if (mood === 'sulking') {
      return (
        <g stroke={INK} strokeWidth="4" strokeLinecap="round">
          <path d="M47 85 L63 90" />
          <path d="M93 85 L77 90" />
        </g>
      );
    }
    if (persona === 'friendly') {
      return (
        <g fill="#ff8fa3" opacity=".55">
          <circle cx="44" cy="112" r="6.5" />
          <circle cx="96" cy="112" r="6.5" />
        </g>
      );
    }
    if (persona === 'stubborn') {
      return (
        <g stroke={INK} strokeWidth="4.5" strokeLinecap="round">
          <path d="M47 87 L63 90" />
          <path d="M93 87 L77 90" />
        </g>
      );
    }
    return (
      <g>
        <path d="M48 85 q8 -8 16 -2" fill="none" stroke={INK} strokeWidth="3" strokeLinecap="round" />
        <path d="M92 85 q-8 -8 -16 -2" fill="none" stroke={INK} strokeWidth="3" strokeLinecap="round" />
        <path d="M95 103 q5 9 0 12 q-5 -3 0 -12 z" fill="#a9defc" />
      </g>
    );
  })();

  return (
    <svg viewBox="0 0 140 212" width={size} height={size * 1.51} className={`lantern ${tone}${speaking ? ' speaking' : ''}`} role="img" aria-label={`${tone === 'buyer' ? 'Your' : 'Seller'} agent, ${mood}`}>
      <defs>
        <radialGradient id={g} cx="50%" cy="42%" r="62%">
          <stop offset="0" style={{ stopColor: 'var(--tone-light)' }} />
          <stop offset="1" style={{ stopColor: 'var(--tone)' }} />
        </radialGradient>
        <filter id={f} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="15" />
        </filter>
      </defs>
      <ellipse className="l-glow" cx="70" cy="100" rx="64" ry="76" filter={`url(#${f})`} />
      <g className="l-swing">
        <line x1="70" y1="0" x2="70" y2="24" stroke="var(--brass)" strokeWidth="2" />
        <rect x="46" y="22" width="48" height="11" rx="3" fill="var(--brass-deep)" />
        <path d="M40 36 C14 72 14 132 40 164 L100 164 C126 132 126 72 100 36 Z" fill={`url(#${g})`} />
        <g fill="none" stroke="rgba(26,16,48,.26)" strokeWidth="2">
          <path d="M70 36 V164" />
          <path d="M52 37 C34 80 34 125 52 164" />
          <path d="M88 37 C106 80 106 125 88 164" />
        </g>
        <rect x="46" y="162" width="48" height="9" rx="3" fill="var(--brass-deep)" />
        <g stroke="var(--brass)" strokeWidth="2" strokeLinecap="round" fill="none">
          <path d="M70 171 V190" />
          <path d="M64 197 L62 210 M70 200 V211 M76 197 L78 210" />
        </g>
        <circle cx="70" cy="194" r="5" fill="var(--brass)" />
        {flourish}
        {eyes}
        {mouth}
      </g>
    </svg>
  );
}

/* ----------------------- strings of lanterns overhead ----------------------- */

export function Bunting() {
  const sag = (x: number) => 22 + 38 * Math.sin((Math.PI * (((x + 1200) % 400) / 400)));
  const pts: string[] = [];
  for (let x = -20; x <= 1220; x += 20) pts.push(`${x === -20 ? 'M' : 'L'}${x} ${sag(x).toFixed(1)}`);
  const lamps = [90, 250, 410, 570, 730, 890, 1050, 1160];
  const tones = ['var(--seller)', 'var(--ruby)', 'var(--buyer)', 'var(--seller)', 'var(--plum-bright)', 'var(--seller)', 'var(--buyer)', 'var(--ruby)'];
  return (
    <svg className="bunting" viewBox="0 0 1200 150" preserveAspectRatio="xMidYMin slice" aria-hidden="true">
      <path d={pts.join(' ')} fill="none" stroke="var(--brass-deep)" strokeWidth="2" />
      {lamps.map((x, i) => {
        const y = sag(x);
        return (
          <g key={x} transform={`translate(${x} ${y.toFixed(1)})`}>
            <g className="bunt-lamp" style={{ animationDelay: `${i * 0.45}s` }}>
              <line x1="0" y1="0" x2="0" y2="12" stroke="var(--brass-deep)" strokeWidth="1.5" />
              <path d="M-10 14 C-18 30 -18 50 -10 60 L10 60 C18 50 18 30 10 14 Z" fill={tones[i]} opacity=".92" />
              <path d="M0 14 V60" stroke="rgba(26,16,48,.3)" strokeWidth="1.5" />
              <rect x="-8" y="58" width="16" height="4" rx="1.5" fill="var(--brass-deep)" />
            </g>
          </g>
        );
      })}
    </svg>
  );
}

/* ------------------------------ stall awning ------------------------------ */

export function Awning() {
  const stripes = Array.from({ length: 6 }, (_, i) => i);
  return (
    <svg className="awning" viewBox="0 0 300 74" preserveAspectRatio="none" aria-hidden="true">
      {stripes.map((i) => (
        <g key={i} className={i % 2 ? 'awn-b' : 'awn-a'}>
          <rect x={i * 50} y="0" width="50.5" height="50" />
          <path d={`M${i * 50} 50 a25 24 0 0 0 50 0 z`} />
        </g>
      ))}
      <rect x="0" y="0" width="300" height="6" className="awn-trim" />
    </svg>
  );
}

/* --------------------- product placeholder (no photo yet) --------------------- */

export function ProductArt({ title }: { title: string }) {
  const t = title.toLowerCase();
  const stroke = { fill: 'none', stroke: 'var(--text)', strokeWidth: 4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  let icon;
  if (/head|audio|ear/.test(t)) {
    icon = (
      <g {...stroke}>
        <path d="M24 70 V58 a36 36 0 0 1 72 0 V70" />
        <rect x="18" y="66" width="18" height="30" rx="7" fill="var(--seller)" />
        <rect x="84" y="66" width="18" height="30" rx="7" fill="var(--seller)" />
      </g>
    );
  } else if (/key|board/.test(t)) {
    icon = (
      <g {...stroke}>
        <rect x="10" y="34" width="100" height="56" rx="9" />
        {[0, 1, 2].map((r) => [0, 1, 2, 3, 4].map((c) => <rect key={`${r}${c}`} x={20 + c * 17} y={44 + r * 14} width="11" height="8" rx="2" fill="var(--buyer)" stroke="none" />))}
      </g>
    );
  } else if (/camera|film|photo/.test(t)) {
    icon = (
      <g {...stroke}>
        <rect x="10" y="38" width="100" height="62" rx="10" />
        <path d="M38 38 l7 -12 h30 l7 12" />
        <circle cx="60" cy="69" r="19" />
        <circle cx="60" cy="69" r="8" fill="var(--seller)" />
      </g>
    );
  } else {
    icon = (
      <g {...stroke}>
        <path d="M24 44 h72 l6 52 H18 z" />
        <path d="M44 44 a16 16 0 0 1 32 0" />
      </g>
    );
  }
  return (
    <svg viewBox="0 0 120 120" className="product-art" role="img" aria-label={`Illustration for ${title}`}>
      {icon}
    </svg>
  );
}

export function ShieldIcon({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d="M12 2 4 5.5v6c0 5 3.4 8.7 8 10.5 4.6-1.8 8-5.5 8-10.5v-6z" fill="currentColor" opacity=".18" />
      <path d="M12 2 4 5.5v6c0 5 3.4 8.7 8 10.5 4.6-1.8 8-5.5 8-10.5v-6z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="m8.5 12 2.4 2.4 4.7-4.9" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
