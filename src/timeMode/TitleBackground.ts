import Phaser from "phaser";
import { ProjectileKind, KIND_CONFIG, CHASER_TURN_RATE } from "./TimeProjectile";

const PARTICLE_COUNT = 36;
const KINDS: ProjectileKind[] = ["straight", "zoomer", "chaser", "ricochet"];
const RADIUS = 6;

const TAIL_LENGTH = 40;
const TAIL_SEGMENTS = 8;
const TAIL_SEGMENT_LENGTH = TAIL_LENGTH / TAIL_SEGMENTS;
const TAIL_MAX_ALPHA = 0.75;

/** How often (real ms) a chaser picks a new random point to curve toward, since there's no player here to home in on. */
const WANDER_RETARGET_MS = 2200;

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
 * Deliberately its own simple thing rather than reusing TimeProjectile
 * directly - this never needs hit detection, deflection, or the hex arena's
 * rotating boundary, just a rectangle to bounce inside, so pulling in
 * Arena/TimeManager here would be pure overhead.
 */
export class TitleBackground {
  private readonly particles: Particle[] = [];
  private readonly graphics: Phaser.GameObjects.Graphics;

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
    const dt = delta / 1000;
    this.graphics.clear();

    for (const p of this.particles) {
      if (p.kind === "chaser") {
        this.steerChaser(p, delta, dt, width, height);
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
