/* ------------------------------------------------------------------ *
 * Optional sound and voices. Off by default (audio should never
 * surprise anyone). No audio files: chimes are synthesised, and the
 * lanterns speak through the browser's built-in speech synthesis.
 * ------------------------------------------------------------------ */

const KEY = 'bazaar.fx';

export const fxOn = () => {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
};
export function setFx(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* ignore */
  }
  if (!on) stopSpeaking();
}

let ac: AudioContext | undefined;
function audio(): AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  if (!ac) {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!C) return undefined;
    ac = new C();
  }
  if (ac.state === 'suspended') void ac.resume();
  return ac;
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'sine', gain = 0.07) {
  const c = audio();
  if (!c) return;
  const t0 = c.currentTime + start;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

export type Chime = 'buyer' | 'seller' | 'block' | 'held' | 'deal' | 'nodeal';

export function chime(kind: Chime) {
  if (!fxOn()) return;
  switch (kind) {
    case 'buyer':
      tone(660, 0, 0.18, 'triangle');
      break;
    case 'seller':
      tone(440, 0, 0.2, 'triangle');
      break;
    case 'block':
      tone(180, 0, 0.22, 'sawtooth', 0.05);
      tone(150, 0.12, 0.28, 'sawtooth', 0.05);
      break;
    case 'held':
      tone(523, 0, 0.16);
      tone(784, 0.12, 0.3);
      break;
    case 'deal':
      [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.11, 0.7, 'sine', 0.08));
      tone(130, 0, 1.1, 'sine', 0.1); // a low gong under the chord
      break;
    case 'nodeal':
      tone(294, 0, 0.35, 'triangle');
      tone(220, 0.25, 0.5, 'triangle');
      break;
  }
}

export function stopSpeaking() {
  if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
}

/** The buyer's lantern speaks high and quick, the sellers low and slow; different voices when the browser has them. */
export function speak(text: string, who: 'buyer' | 'seller', seed = 0) {
  if (!fxOn() || typeof window === 'undefined' || !window.speechSynthesis) return;
  const synth = window.speechSynthesis;
  const u = new SpeechSynthesisUtterance(text);
  const voices = synth.getVoices().filter((v) => v.lang.startsWith('en'));
  if (voices.length) u.voice = voices[who === 'buyer' ? 0 : (1 + seed) % voices.length];
  u.pitch = who === 'buyer' ? 1.4 : 0.7 + (seed % 3) * 0.12;
  u.rate = who === 'buyer' ? 1.08 : 0.97;
  synth.cancel();
  synth.speak(u);
}
