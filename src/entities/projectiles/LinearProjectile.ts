import Phaser from "phaser";
import { Arena } from "../../arena/Arena";

/** How far past the arena wall a projectile must drift before it's considered escaped. */
const ESCAPE_MARGIN = 80;

/** How long a projectile sits still at its spawn point, telegraphing its arrival, before it starts moving. */
const SPAWN_TELEGRAPH_MS = 400;
const TELEGRAPH_START_ALPHA = 0.35;

/** How many wall bounces the 1st deflect grants; each subsequent deflect (up to MAX_DEFLECT_TIER) adds this many more to the total cap. */
const DEFLECT_BASE_BOUNCE_CAP = 3;
/** Highest deflect tier a projectile can reach - the 3rd deflect bursts it straight out of the arena instead of granting more bounces. */
const MAX_DEFLECT_TIER = 3;
/** Each deflect beyond the 1st multiplies the projectile's current speed by this, compounding - tier 3 is this squared relative to tier 1. */
const DEFLECT_SPEED_MULTIPLIER = 1.5;
/**
 * Solid fill color per deflect tier - escalates from the calm "friendly"
 * teal (matches the player/Dash color) toward a hotter, brighter tone as the
 * projectile gets closer to bursting out on its 3rd deflect. Index 0 is
 * unused (only tiers 1-3 are ever deflected).
 */
const DEFLECT_TINTS: readonly number[] = [0x000000, 0x59f2c8, 0xa0fbe6, 0xffffff];
/** Visual-only scale bump per tier, so a higher-tier projectile reads as "more charged up" at a glance - purely cosmetic, doesn't affect the collision radius. */
const DEFLECT_SCALES: readonly number[] = [1, 1, 1.15, 1.3];

/**
 * Shared base for pooled projectiles that aim at the player once on spawn
 * and travel in a straight line (no wall bounce). Subclasses just supply a
 * speed/radius/texture and decide what "step" means for their trajectory.
 * Toggled via setActive/setVisible rather than created/destroyed for pooling.
 */
export abstract class LinearProjectile extends Phaser.GameObjects.Image {
  readonly radius: number;

  protected readonly speed: number;
  protected vx = 0;
  protected vy = 0;
  protected telegraphRemainingMs = 0;
  /** World angle (from the arena center) this projectile spawned at - used to keep it riding the perimeter while telegraphing, even as the arena rotates underneath it. */
  private perimeterAngle = 0;
  /** 0 = still hostile. 1-3 = how many times it's been deflected; see deflect(). */
  private deflectTierValue = 0;
  private deflectedBounceCount = 0;
  /**
   * Which Slash swing (Player#slashSwingId) last tiered this up. A single
   * swing's hitbox stays active for several frames (SLASH_DURATION_MS), and
   * without this an already-deflected-but-not-max-tier projectile would be
   * eligible to get hit again on the very next frame by that SAME swing
   * before it ever moves out of range - tiering it up 2-3 times from what
   * should be one hit. -1 (no real swingId is ever negative) so a freshly
   * spawned/recycled projectile is never mistaken for already having been
   * hit by whatever swing happens to be active.
   */
  private lastDeflectedBySwingId = -1;
  private deflectBounceCap = DEFLECT_BASE_BOUNCE_CAP;
  /** The speed deflected movement uses, compounding each additional deflect - starts from the projectile's own base speed on the 1st deflect. */
  private deflectSpeed = 0;

  private readonly maxLifetimeMs: number;
  private lifetimeRemainingMs: number;

  /**
   * maxLifetimeMs is Infinity by default (no cap) - only threat types that can
   * linger indefinitely by bouncing (Basic, Chaser) pass a real value. Zoomer
   * doesn't bounce and already self-clears by exiting the arena, so it has no
   * need for one.
   */
  constructor(scene: Phaser.Scene, textureKey: string, speed: number, radius: number, maxLifetimeMs = Infinity) {
    super(scene, 0, 0, textureKey);
    this.speed = speed;
    this.radius = radius;
    this.maxLifetimeMs = maxLifetimeMs;
    this.lifetimeRemainingMs = maxLifetimeMs;
    scene.add.existing(this);
    this.setActive(false);
    this.setVisible(false);
  }

  activate(x: number, y: number, targetX: number, targetY: number, arena: Arena): void {
    this.setPosition(x, y);
    this.perimeterAngle = Math.atan2(y - arena.bounds.centerY, x - arena.bounds.centerX);
    const angle = Math.atan2(targetY - y, targetX - x);
    this.vx = Math.cos(angle) * this.speed;
    this.vy = Math.sin(angle) * this.speed;
    this.telegraphRemainingMs = SPAWN_TELEGRAPH_MS;
    this.lifetimeRemainingMs = this.maxLifetimeMs;
    this.deflectTierValue = 0;
    this.deflectedBounceCount = 0;
    this.deflectBounceCap = DEFLECT_BASE_BOUNCE_CAP;
    this.lastDeflectedBySwingId = -1;
    this.clearTint();
    this.setScale(1);
    this.setAlpha(TELEGRAPH_START_ALPHA);
    this.setActive(true);
    this.setVisible(true);
  }

  deactivate(): void {
    this.setActive(false);
    this.setVisible(false);
  }

  /** True once this has been deflected at least once (tier 1-3) - friendly from here on, regardless of tier. */
  get deflected(): boolean {
    return this.deflectTierValue > 0;
  }

  get deflectTier(): number {
    return this.deflectTierValue;
  }

  /** True once a projectile has reached its 3rd deflect and can't be deflected again. */
  get isMaxDeflectTier(): boolean {
    return this.deflectTierValue >= MAX_DEFLECT_TIER;
  }

  /**
   * True if a swing with this ID is allowed to deflect/tier-up this
   * projectile - false once it's maxed out, or if this exact swing already
   * hit it. A single swing's hitbox stays active for several frames
   * (SLASH_DURATION_MS), so without the swingId check, an already-deflected
   * (not yet max tier) projectile sitting in range would get tiered up again
   * on the very next frame by that SAME swing, before it ever moves out of
   * range - turning one hit into 2-3.
   */
  canBeDeflectedBy(swingId: number): boolean {
    return !this.isMaxDeflectTier && this.lastDeflectedBySwingId !== swingId;
  }

  /**
   * Converts an active hostile projectile into a friendly deflected one (1st
   * deflect), or escalates an already-deflected one to its next tier (2nd/3rd
   * deflect) - fired off in the player's current aim direction each time.
   * Tier 1 behaves as the original deflect always has: own base speed, a
   * plain mirror bounce off the wall (see bounceOffWall) capped at
   * DEFLECT_BASE_BOUNCE_CAP bounces, rather than retaining its original
   * type's quirks (e.g. Chaser's re-aim-on-bounce). Tier 2 grants
   * DEFLECT_BASE_BOUNCE_CAP more bounces on top of however many it has left
   * and multiplies its speed. Tier 3 multiplies speed again but stops
   * bouncing entirely - see the bounceOffWall-gating in each subclass's
   * step() - so it bursts straight through the wall and escapes instead.
   * Recolored/rescaled per tier (cosmetic only; the collision radius never
   * changes) so a charged-up projectile reads as more dangerous at a glance.
   * Destroys any hostile projectile it touches for as long as it's alive,
   * at every tier (see ProjectileManager). Callers must check
   * canBeDeflectedBy(swingId) first - this only guards against exceeding the
   * max tier, not against the same swing hitting it twice.
   */
  deflect(aimAngle: number, swingId: number): void {
    if (this.isMaxDeflectTier) {
      return;
    }
    this.lastDeflectedBySwingId = swingId;
    this.deflectTierValue += 1;

    if (this.deflectTierValue === 1) {
      this.deflectSpeed = this.speed;
    } else {
      if (this.deflectTierValue === 2) {
        this.deflectBounceCap += DEFLECT_BASE_BOUNCE_CAP;
      }
      this.deflectSpeed *= DEFLECT_SPEED_MULTIPLIER;
    }

    this.vx = Math.cos(aimAngle) * this.deflectSpeed;
    this.vy = Math.sin(aimAngle) * this.deflectSpeed;
    this.setTintFill(DEFLECT_TINTS[this.deflectTierValue]);
    this.setScale(DEFLECT_SCALES[this.deflectTierValue]);
  }

  /**
   * Advances the telegraph timer and fades the sprite in while it's still
   * telegraphing; otherwise moves it along its velocity. Returns false while
   * still telegraphing (hasn't started moving yet), so subclasses know to
   * skip bounce/escape checks for this step. While telegraphing, keeps
   * re-anchoring to the arena's current boundary at its original spawn
   * bearing, so a rotating arena carries it along the perimeter instead of
   * leaving it sitting at a fixed point while the wall rotates out from
   * under it (and it launches from a spot that no longer matches the wall).
   */
  protected move(delta: number, arena: Arena): boolean {
    if (this.telegraphRemainingMs > 0) {
      this.telegraphRemainingMs = Math.max(0, this.telegraphRemainingMs - delta);
      const progress = 1 - this.telegraphRemainingMs / SPAWN_TELEGRAPH_MS;
      this.setAlpha(TELEGRAPH_START_ALPHA + (1 - TELEGRAPH_START_ALPHA) * progress);
      const point = arena.boundaryPointAtAngle(this.perimeterAngle);
      this.setPosition(point.x, point.y);
      return false;
    }

    this.lifetimeRemainingMs -= delta;

    const dt = delta / 1000;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    return true;
  }

  protected hasEscaped(arena: Arena): boolean {
    const dx = this.x - arena.bounds.centerX;
    const dy = this.y - arena.bounds.centerY;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    return dist > arena.maxRadiusAtAngle(angle) + ESCAPE_MARGIN;
  }

  /**
   * Mirror-bounces off the arena wall if past it (reflecting velocity off
   * the true wall normal - a flat edge's normal for polygon arenas, radial
   * for a circle), same math Basic already used for its predictable bounce.
   * Shared so deflected projectiles of any original type bounce identically
   * - counting toward their deflectBounceCap - rather than each type keeping
   * its own original quirks (e.g. Chaser's re-aim) once deflected. Callers
   * skip calling this at all once a projectile reaches deflect tier 3, so it
   * flies straight through the wall unclamped instead of bouncing.
   */
  protected bounceOffWall(arena: Arena): void {
    const dx = this.x - arena.bounds.centerX;
    const dy = this.y - arena.bounds.centerY;
    const distFromCenter = Math.sqrt(dx * dx + dy * dy);
    if (distFromCenter === 0) {
      return;
    }

    const angle = Math.atan2(dy, dx);
    const maxDist = arena.maxRadiusAtAngle(angle) - this.radius;
    if (distFromCenter <= maxDist) {
      return;
    }

    const scale = maxDist / distFromCenter;
    this.x = arena.bounds.centerX + dx * scale;
    this.y = arena.bounds.centerY + dy * scale;

    const n = arena.normalAtAngle(angle);
    const dot = this.vx * n.x + this.vy * n.y;
    this.vx -= 2 * dot * n.x;
    this.vy -= 2 * dot * n.y;

    if (this.deflectTierValue > 0) {
      this.deflectedBounceCount++;
    }
  }

  /** True once a deflected projectile has used up all its wall bounces and should despawn. Always false for a still-hostile projectile (no bounce cap) or a tier-3 one (no bounce cap applies - it bursts out instead). */
  protected hasUsedAllDeflectedBounces(): boolean {
    return this.deflectTierValue > 0 && this.deflectedBounceCount >= this.deflectBounceCap;
  }

  /**
   * True once a capped-lifetime projectile has been alive (excluding its
   * spawn telegraph) longer than maxLifetimeMs - a bouncing threat that never
   * happens to escape on its own otherwise lingers indefinitely. Always false
   * for types with no cap (maxLifetimeMs left at the Infinity default).
   */
  protected hasExpired(): boolean {
    return this.lifetimeRemainingMs <= 0;
  }

  /**
   * Advances the projectile. Returns true once it should be despawned (e.g.
   * flew past the wall). playerX/playerY are provided for subclasses (like
   * Chaser) that re-aim at the player mid-flight; most ignore them.
   */
  abstract step(delta: number, arena: Arena, playerX: number, playerY: number): boolean;
}
