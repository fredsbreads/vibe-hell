/**
 * Procedurally synthesized SFX (oscillators + filtered noise, no audio
 * files) for the time-dilation mode. Every sound here is a fire-and-forget
 * one-shot whose own real-world duration is fixed regardless of the current
 * world timescale - that's only valid because every trigger point is itself
 * an instantaneous event (a hit landing, a swing starting) or something that
 * already runs on real, undilated time (Slash's own active duration -
 * see TimePlayer's class doc comment). A sound tied to something that spans
 * world-scaled time (the enemy fire telegraph, an ambient "world is nearly
 * frozen" drone) would need to be driven live, frame by frame, instead of
 * scheduled as a clip - deliberately out of scope here, see the design
 * discussion this module came out of.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function getCtx(): AudioContext {
  if (!ctx || !master) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") {
    ctx.resume();
  }
  return ctx;
}

function getMaster(): GainNode {
  getCtx();
  return master!;
}

function noiseBuffer(c: AudioContext, duration: number): AudioBuffer {
  const length = Math.max(1, Math.floor(c.sampleRate * duration));
  const buffer = c.createBuffer(1, length, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

function makeDistortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 4096;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + amount) * x * 20 * (Math.PI / 180)) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

/** A quick, soft-attack slide - narrow bandpass noise gliding downward, plus a hair of high-frequency bite at the very onset for definition. Deliberately not punchy: no low-frequency thump, low peak gain. Triggered once on the rising edge of Slide starting (see TimePlayer.update()), not every frame it stays held. */
export function playSlide(): void {
  const c = getCtx();
  const m = getMaster();
  const t0 = c.currentTime;

  const noise = c.createBufferSource();
  noise.buffer = noiseBuffer(c, 0.16);
  const filter = c.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(2600, t0);
  filter.frequency.exponentialRampToValueAtTime(500, t0 + 0.13);
  filter.Q.value = 1.4;
  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(0.2, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
  noise.connect(filter).connect(gain).connect(m);
  noise.start(t0);
  noise.stop(t0 + 0.16);

  const tick = c.createBufferSource();
  tick.buffer = noiseBuffer(c, 0.006);
  const tickFilter = c.createBiquadFilter();
  tickFilter.type = "highpass";
  tickFilter.frequency.value = 5000;
  const tickGain = c.createGain();
  tickGain.gain.setValueAtTime(0.1, t0);
  tickGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.006);
  tick.connect(tickFilter).connect(tickGain).connect(m);
  tick.start(t0);
}

/** A short, bright noise burst sweeping down through a bandpass filter - reads as a quick whip/cut, hit or miss. */
export function playSlash(): void {
  const c = getCtx();
  const m = getMaster();
  const t0 = c.currentTime;
  const noise = c.createBufferSource();
  noise.buffer = noiseBuffer(c, 0.12);
  const filter = c.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(6000, t0);
  filter.frequency.exponentialRampToValueAtTime(1400, t0 + 0.09);
  filter.Q.value = 1.2;
  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(0.4, t0 + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);
  noise.connect(filter).connect(gain).connect(m);
  noise.start(t0);
  noise.stop(t0 + 0.12);
}

/** A metallic ping (two detuned sines) plus a short click transient - Slash connecting with a still-hostile or re-deflectable projectile. */
export function playDeflect(): void {
  const c = getCtx();
  const m = getMaster();
  const t0 = c.currentTime;
  [1200, 1780].forEach((f, i) => {
    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(f, t0);
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(0.3 - i * 0.08, t0 + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
    osc.connect(gain).connect(m);
    osc.start(t0);
    osc.stop(t0 + 0.24);
  });
  const click = c.createBufferSource();
  click.buffer = noiseBuffer(c, 0.012);
  const clickGain = c.createGain();
  clickGain.gain.setValueAtTime(0.5, t0);
  clickGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.012);
  click.connect(clickGain).connect(m);
  click.start(t0);
}

/** A punchy low thump plus a short high-passed crack - a direct Slash kill, or a deflected projectile destroying a hostile one (not chained through an enemy - see playChainHit for that). */
export function playKill(): void {
  const c = getCtx();
  const m = getMaster();
  const t0 = c.currentTime;
  const osc = c.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(180, t0);
  osc.frequency.exponentialRampToValueAtTime(60, t0 + 0.09);
  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(0.5, t0 + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);
  osc.connect(gain).connect(m);
  osc.start(t0);
  osc.stop(t0 + 0.12);

  const crack = c.createBufferSource();
  crack.buffer = noiseBuffer(c, 0.02);
  const crackFilter = c.createBiquadFilter();
  crackFilter.type = "highpass";
  crackFilter.frequency.value = 2000;
  const crackGain = c.createGain();
  crackGain.gain.setValueAtTime(0.35, t0);
  crackGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.02);
  crack.connect(crackFilter).connect(crackGain).connect(m);
  crack.start(t0);
}

/**
 * A short stinger whose pitch climbs and timbre brightens with chain
 * length - plays each time a deflected projectile bounces off (kills)
 * another enemy. chainCount is the projectile's own running total (see
 * TimeProjectile.chainKillCount), not clamped here - the pitch keeps
 * climbing indefinitely, same "no hard ceiling" spirit as the dash-charge
 * mechanic it's rewarding.
 */
export function playChainHit(chainCount: number): void {
  const c = getCtx();
  const m = getMaster();
  const t0 = c.currentTime;
  const n = Math.max(1, chainCount);
  const baseFreq = 660;
  const freq = baseFreq * Math.pow(2, ((n - 1) * 3) / 12);
  const peak = 0.22 + n * 0.05;

  const osc = c.createOscillator();
  osc.type = n >= 3 ? "square" : "sine";
  osc.frequency.setValueAtTime(freq, t0);
  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09 + n * 0.01);
  osc.connect(gain).connect(m);
  osc.start(t0);
  osc.stop(t0 + 0.2);

  if (n >= 2) {
    const osc2 = c.createOscillator();
    osc2.type = "triangle";
    osc2.frequency.setValueAtTime(freq * 2, t0);
    const gain2 = c.createGain();
    gain2.gain.setValueAtTime(0.0001, t0);
    gain2.gain.linearRampToValueAtTime(peak * 0.4, t0 + 0.006);
    gain2.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);
    osc2.connect(gain2).connect(m);
    osc2.start(t0);
    osc2.stop(t0 + 0.2);
  }
}

/** A bright three-note chime - a chain hit just raised the live slide-distance cap (see TimePlayer.setMaxSlideDistance), handing over fresh bonus slide distance. */
export function playChargeBanked(): void {
  const c = getCtx();
  const m = getMaster();
  const t0 = c.currentTime;
  [1000, 2000, 3000].forEach((f, i) => {
    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(f, t0);
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(0.28 / (i + 1), t0 + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
    osc.connect(gain).connect(m);
    osc.start(t0);
    osc.stop(t0 + 0.36);
  });
}

/** A quiet, single-note tick - the slide-distance budget just fully regenerated back to its cap (see TimePlayer.tickCooldowns). Deliberately smaller than playChargeBanked - this is a background/idle event, not a combat reward. */
export function playChargeRegen(): void {
  const c = getCtx();
  const m = getMaster();
  const t0 = c.currentTime;
  const osc = c.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(1400, t0);
  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(0.15, t0 + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
  osc.connect(gain).connect(m);
  osc.start(t0);
  osc.stop(t0 + 0.16);
}

/** A harsh, distorted, descending tone - the run just ended. */
export function playDeath(): void {
  const c = getCtx();
  const m = getMaster();
  const t0 = c.currentTime;
  const osc = c.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(320, t0);
  osc.frequency.exponentialRampToValueAtTime(45, t0 + 0.55);
  const filter = c.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(3000, t0);
  filter.frequency.exponentialRampToValueAtTime(200, t0 + 0.5);
  const shaper = c.createWaveShaper();
  shaper.curve = makeDistortionCurve(30);
  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(0.4, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
  osc.connect(shaper).connect(filter).connect(gain).connect(m);
  osc.start(t0);
  osc.stop(t0 + 0.62);
}

/** A rising noise sweep plus a rising sine - the death replay is taking over. */
export function playReplayStart(): void {
  const c = getCtx();
  const m = getMaster();
  const t0 = c.currentTime;
  const noise = c.createBufferSource();
  noise.buffer = noiseBuffer(c, 0.35);
  const filter = c.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(200, t0);
  filter.frequency.exponentialRampToValueAtTime(5000, t0 + 0.32);
  filter.Q.value = 0.9;
  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(0.35, t0 + 0.28);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.36);
  noise.connect(filter).connect(gain).connect(m);
  noise.start(t0);
  noise.stop(t0 + 0.36);

  const osc = c.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(80, t0);
  osc.frequency.exponentialRampToValueAtTime(900, t0 + 0.3);
  const oscGain = c.createGain();
  oscGain.gain.setValueAtTime(0.0001, t0);
  oscGain.gain.linearRampToValueAtTime(0.25, t0 + 0.25);
  oscGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
  osc.connect(oscGain).connect(m);
  osc.start(t0);
  osc.stop(t0 + 0.33);
}
