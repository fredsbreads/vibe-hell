import Phaser from "phaser";
import { ProjectileKind, KIND_CONFIG, CHASER_TURN_RATE } from "./TimeProjectile";
import { MIN_WORLD_TIMESCALE } from "./worldClock";

const PARTICLE_COUNT = 60;
const KINDS: ProjectileKind[] = ["straight", "zoomer", "chaser", "ricochet"];
const RADIUS = 6;

const TAIL_LENGTH = 40;
const TAIL_SEGMENTS = 8;
const TAIL_SEGMENT_LENGTH = TAIL_LENGTH / TAIL_SEGMENTS;
const TAIL_MAX_ALPHA = 0.75;

/** How often (real ms, before world-timescale scaling) a chaser picks a new random point to curve toward, since there's no player here to home in on. */
const WANDER_RETARGET_MS = 2200;

/**
 * Simulates an invisible player working the stick, so the whole scatter
 * speeds up and slows down the same way real gameplay's world-time dilation
 * would - without ever drawing a player. Steps through a repeating
 * fast/slow rhythm (see TIMESCALE_PATTERN) on a fixed beat, rather than
 * picking a fully random target each time - a beat reads as "someone doing
 * this on purpose" where independent random picks just read as noise, even
 * though each step still jitters within its band for some variety.
 *
 * Glides from one beat's value to the next with a sine ease-in-out spread
 * across the WHOLE beat (see updateSimulatedTimescale), rather than a
 * decay-style ease that rushes toward the new target right after each
 * retarget and then sits nearly flat until the next one - that pattern has
 * a sharp corner in the velocity right at every beat boundary (arriving
 * at ~0 speed, then immediately jerking to a high speed again), which reads
 * as jerky. Sine in-out has zero velocity at both ends of each segment, so
 * consecutive segments meet smoothly instead of kinking.
 */
const TIMESCALE_RETARGET_MS = 1000;
type TimescaleBeat = "fast" | "slow";
const TIMESCALE_PATTERN: TimescaleBeat[] = ["fast", "fast", "fast", "slow", "slow", "slow", "fast", "fast", "slow"];
const TIMESCALE_FAST_RANGE: [number, number] = [0.75, 1];
const TIMESCALE_SLOW_RANGE: [number, number] = [MIN_WORLD_TIMESCALE, 0.22];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  kind: ProjectileKind;
  color: number;
  speed: number;
  headingHistory: number[];
  distanceSinceLastSample: number;
  wanderX: number;
  wanderY: number;
  wanderTimerMs: number;
}

/**
 * Purely decorative ambient background for the title screen - a scatter of
 * projectiles matching the real in-game kinds/colors/speeds (see
 * TimeProjectile.ts, the single source of truth this reuses), bouncing
 * around the screen rectangle forever. Chasers curve toward a randomly
 * wandering point (re-picked every WANDER_RETARGET_MS) instead of a real
 * player, since there isn't one on the title screen; ricochets pick a fresh
 * random direction on each bounce instead of re-aiming at anything.
 *
 * The whole scatter also speeds up and slows down over time, as if an
 * invisible player were working the stick (see updateSimulatedTimescale) -
 * movement, chaser turning, and the chaser wander-retarget timer all scale
 * by this simulated world timescale, same as real gameplay dilates
 * everything about "the world". No player is ever drawn; only its effect on
 * the pace of everything else shows up.
 *
 * Deliberately its own simple thing rather than reusing TimeProjectile
 * directly - this never needs hit detection, deflection, or the hex arena's
 * rotating boundary, just a rectangle to bounce inside, so pulling in
 * Arena/TimeManager here would be pure overhead.
 */
export class TitleBackground {
  private readonly particles: Particle[] = [];
  private readonly graphics: Phaser.GameObjects.Graphics;

  private worldTimescale = 1;
  private timescaleFrom = 1;
  private timescaleTarget = 1;
  private timescaleBeatElapsedMs = 0;
  private timescalePatternIndex = 0;

  constructor(private readonly scene: Phaser.Scene) {
    this.graphics = scene.add.graphics().setDepth(-1);
    const { width, height } = scene.scale;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const kind = KINDS[i % KINDS.length];
      const config = KIND_CONFIG[kind];
      const angle = Math.random() * Math.PI * 2;
      const x = Math.random() * width;
      const y = Math.random() * height;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * config.speed,
        vy: Math.sin(angle) * config.speed,
        kind,
        color: config.color,
        speed: config.speed,
        headingHistory: [angle],
        distanceSinceLastSample: 0,
        wanderX: Math.random() * width,
        wanderY: Math.random() * height,
        wanderTimerMs: Math.random() * WANDER_RETARGET_MS,
      });
    }
  }

  update(delta: number): void {
    const { width, height } = this.scene.scale;
    this.updateSimulatedTimescale(delta);
    const scaledDelta = delta * this.worldTimescale;
    const dt = scaledDelta / 1000;
    this.graphics.clear();

    for (const p of this.particles) {
      if (p.kind === "chaser") {
        this.steerChaser(p, scaledDelta, dt, width, height);
      }

      const moveDist = Math.hypot(p.vx, p.vy) * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      const bounced = this.bounceOffScreenEdge(p, width, height);
      if (bounced && p.kind === "ricochet") {
        const randomAngle = Math.random() * Math.PI * 2;
        p.vx = Math.cos(randomAngle) * p.speed;
        p.vy = Math.sin(randomAngle) * p.speed;
      }

      this.sampleHeading(p, moveDist);
      this.drawTail(p);
      this.graphics.fillStyle(p.color, 1);
      this.graphics.fillCircle(p.x, p.y, RADIUS);
    }
  }

  /** Glides the fake "stick tilt" from one step of the fast/slow rhythm to the next, sine-eased across the whole beat - see the class-level doc comment. Always driven by real delta, since this is what's simulating the input itself, not something the input scales. */
  private updateSimulatedTimescale(delta: number): void {
    this.timescaleBeatElapsedMs += delta;
    if (this.timescaleBeatElapsedMs >= TIMESCALE_RETARGET_MS) {
      this.timescaleBeatElapsedMs -= TIMESCALE_RETARGET_MS;
      this.timescaleFrom = this.timescaleTarget;
      const beat = TIMESCALE_PATTERN[this.timescalePatternIndex % TIMESCALE_PATTERN.length];
      this.timescalePatternIndex++;
      const [lo, hi] = beat === "fast" ? TIMESCALE_FAST_RANGE : TIMESCALE_SLOW_RANGE;
      this.timescaleTarget = lo + Math.random() * (hi - lo);
    }
    const t = Math.min(1, this.timescaleBeatElapsedMs / TIMESCALE_RETARGET_MS);
    const eased = Phaser.Math.Easing.Sine.InOut(t);
    this.worldTimescale = Phaser.Math.Linear(this.timescaleFrom, this.timescaleTarget, eased);
  }

  private steerChaser(p: Particle, delta: number, dt: number, width: number, height: number): void {
    p.wanderTimerMs -= delta;
    if (p.wanderTimerMs <= 0) {
      p.wanderX = Math.random() * width;
      p.wanderY = Math.random() * height;
      p.wanderTimerMs = WANDER_RETARGET_MS;
    }
    const currentAngle = Math.atan2(p.vy, p.vx);
    const targetAngle = Math.atan2(p.wanderY - p.y, p.wanderX - p.x);
    const newAngle = Phaser.Math.Angle.RotateTo(currentAngle, targetAngle, CHASER_TURN_RATE * dt);
    p.vx = Math.cos(newAngle) * p.speed;
    p.vy = Math.sin(newAngle) * p.speed;
  }

  /** Simple mirror bounce off the screen rectangle. Returns true if a bounce happened this frame. */
  private bounceOffScreenEdge(p: Particle, width: number, height: number): boolean {
    let bounced = false;
    if (p.x < RADIUS) {
      p.x = RADIUS;
      p.vx = Math.abs(p.vx);
      bounced = true;
    } else if (p.x > width - RADIUS) {
      p.x = width - RADIUS;
      p.vx = -Math.abs(p.vx);
      bounced = true;
    }
    if (p.y < RADIUS) {
      p.y = RADIUS;
      p.vy = Math.abs(p.vy);
      bounced = true;
    } else if (p.y > height - RADIUS) {
      p.y = height - RADIUS;
      p.vy = -Math.abs(p.vy);
      bounced = true;
    }
    return bounced;
  }

  /** Same distance-sampled heading history as TimeProjectile, so the tail visibly bends along the actual curved path. */
  private sampleHeading(p: Particle, moveDist: number): void {
    p.distanceSinceLastSample += moveDist;
    while (p.distanceSinceLastSample >= TAIL_SEGMENT_LENGTH) {
      p.headingHistory.push(Math.atan2(p.vy, p.vx));
      if (p.headingHistory.length > TAIL_SEGMENTS) {
        p.headingHistory.shift();
      }
      p.distanceSinceLastSample -= TAIL_SEGMENT_LENGTH;
    }
  }

  private drawTail(p: Particle): void {
    let cursorX = p.x;
    let cursorY = p.y;
    for (let i = 0; i < TAIL_SEGMENTS; i++) {
      const historyIndex = Math.max(0, p.headingHistory.length - 1 - i);
      const angle = p.headingHistory[historyIndex];
      const nextX = cursorX - Math.cos(angle) * TAIL_SEGMENT_LENGTH;
      const nextY = cursorY - Math.sin(angle) * TAIL_SEGMENT_LENGTH;
      const alpha = TAIL_MAX_ALPHA * (1 - i / TAIL_SEGMENTS);
      const strokeWidth = RADIUS * (1 - i / TAIL_SEGMENTS) * 0.9;
      this.graphics.lineStyle(Math.max(1, strokeWidth), p.color, alpha);
      this.graphics.lineBetween(cursorX, cursorY, nextX, nextY);
      cursorX = nextX;
      cursorY = nextY;
    }
  }

  destroy(): void {
    this.graphics.destroy();
  }
}
