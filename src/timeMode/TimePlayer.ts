import Phaser from "phaser";
import { PlayerInput, InputSource, InputState } from "../input/PlayerInput";
import { Arena } from "../arena/Arena";
import { computeWorldTimescale } from "./worldClock";
import { getShowSlashRangeIndicator } from "../config/settings";
import { playSlide, playSlash, playDeath, playChargeBanked, playChargeRegen } from "../audio/sfx";

const SLIDE_TINT = 0xaefff0;
const HURT_TINT = 0xff3b3b;

const MOVE_SPEED = 320;
const WALL_EPSILON = 0.5;

/** Slide's own move speed - deliberately just a bit above normal movement (not the old instant-burst Dash's speed), since it's now a holdable state rather than a one-shot burst. */
const SLIDE_SPEED = 460;
/**
 * The baseline distance budget Slide can spend before it stops working (see
 * update()'s isSliding check) - always at least this much, same "there's
 * always a floor" spirit the old dash-charges system had. Scales up with a
 * live deflect chain (see TimeManager.liveMaxChainCount): TimeMainScene
 * calls setMaxSlideDistance(BASE_SLIDE_DISTANCE * Math.max(1,
 * liveMaxChainCount)) every frame, so a chain of 4 quadruples the budget,
 * same multiplier the old "4 deflects -> 4 dashes" model used, just
 * expressed as distance instead of discrete charges. Exported so
 * TimeMainScene can compute that same product without duplicating the
 * number.
 */
export const BASE_SLIDE_DISTANCE = 140;
/** How fast the distance budget refills (px of budget per real second) while NOT actively sliding - world-scaled, like every other "waiting" mechanic in this mode (Slash's cooldown, and the wall-bounce grace period), so standing still doesn't let it regenerate for free. */
const SLIDE_REGEN_PX_PER_SEC = 70;

const SLASH_DURATION_MS = 120;
const SLASH_COOLDOWN_MS = 500;
const SLASH_RANGE = 60;
const SLASH_ARC_WIDTH = 0.9;
const SLASH_COLOR = 0xf2e85c;
/** How far (0-1) into the swing the flash-white tint finishes fading to SLASH_COLOR - just the first slice of the swing reads as a flash. */
const SLASH_FLASH_PORTION = 0.25;

/** A persistent, unobtrusive outline of the exact wedge Slash would hit right now - so "is this actually in range" is answerable by eye, not guesswork. Brighter/more visible when Slash is actually ready, faint while on cooldown. */
const SLASH_RANGE_READY_COLOR = 0x59f2c8;
const SLASH_RANGE_COOLDOWN_COLOR = 0x6a6a80;
const SLASH_RANGE_READY_ALPHA = 0.35;
const SLASH_RANGE_COOLDOWN_ALPHA = 0.12;

export interface SlashHitbox {
  x: number;
  y: number;
  angle: number;
  range: number;
  arcWidth: number;
  /**
   * Identifies which physical swing this hitbox belongs to - a swing's
   * hitbox stays active across several frames (SLASH_DURATION_MS), and a
   * projectile can become re-deflectable again (bounce off an enemy) WHILE
   * that same swing is still active, so TimeManager needs to tell "the same
   * swing, later frame" apart from "a genuinely new swing" to avoid hitting
   * the same projectile twice off one button press. -1 for the preview
   * hitbox, which never actually resolves a hit, so this doesn't matter.
   */
  swingId: number;
}

/**
 * A fork of the original game's Player, adapted for the time-dilation mode's
 * two different clocks (see WaveClock doc comment in worldClock.ts):
 *
 * - The player's own movement, aim, and the ACTIVE duration of Slash (the
 *   moment of acting itself) all run on the real, undilated delta - always
 *   fully responsive, equally skill-testing to time regardless of the
 *   current world timescale.
 * - Slide's distance-budget regen and Slash's cooldown (the "waiting to do
 *   it again" part) run on the world-scaled delta instead - standing still
 *   to wait either out for free doesn't work, because standing still is
 *   exactly what keeps world-time from advancing.
 *
 * 1 HP, no hit-grace window - unlike the original 3-HP game, there's no
 * "cluster of hits in one instant" to guard against, since the very first
 * hit already ends the run.
 */
export class TimePlayer {
  static readonly RADIUS = 16;

  readonly sprite: Phaser.Physics.Arcade.Sprite;

  aimAngle = -Math.PI / 2;

  private input: InputSource;
  private lastInputStateValue: InputState | null = null;
  private readonly aimIndicator: Phaser.GameObjects.Graphics;
  private readonly slashGraphic: Phaser.GameObjects.Graphics;
  private readonly slashRangeGraphic: Phaser.GameObjects.Graphics;
  private readonly slideDistanceAura: Phaser.GameObjects.Graphics;
  /** Drives the slide-distance aura's pulse (see redrawSlideDistanceAura) - real-time, like the slash preview's own pulse, since it's a cosmetic readout rather than part of "the world". */
  private auraPulseMs = 0;

  /**
   * Current velocity, applied to sprite.x/y by hand each update() call
   * (see the end of update()) rather than via sprite.setVelocity() + Arcade
   * Physics' own automatic once-per-real-rendered-frame integration.
   * Deliberate: the death replay calls update() several times per real
   * frame (see TimeMainScene's REPLAY_STEPS_PER_FRAME) to fast-forward
   * playback, each with its own recorded delta - Arcade's auto-integration
   * only ever applies the LAST of those velocities across the REAL frame's
   * own delta, silently discarding the others and drifting the replay's
   * position off the original run's. Manual integration makes movement a
   * pure function of "how many times update() was called, with what
   * deltas" instead of real wall-clock frame timing, which is what actually
   * makes the replay reproduce the recorded run's movement exactly.
   */
  private velocityX = 0;
  private velocityY = 0;

  /**
   * True while Slide's button is held, the stick is actually tilted (no
   * point "sliding" in place - see update()), and there's budget left. Time
   * stays frozen and the player is invincible for as long as this is true;
   * it goes false the instant any of those three stop being true, including
   * the budget hitting 0 mid-hold - nothing special happens then, movement
   * just quietly reverts to normal walking for the rest of the hold (see
   * update()'s speed selection).
   */
  private isSliding = false;
  /**
   * How much further Slide can move the player before it stops working -
   * always at least BASE_SLIDE_DISTANCE (see maxSlideDistanceValue), but can
   * rise above that off the back of a deflected-projectile kill chain (see
   * setMaxSlideDistance). Depletes by the exact distance moved while
   * isSliding is true; regenerates continuously (a stamina meter, not
   * discrete charges) while NOT sliding, up to whatever the current cap is -
   * see tickCooldowns.
   */
  private slideDistance = BASE_SLIDE_DISTANCE;
  /** The current ceiling on slideDistance - always max(1, TimeManager.liveMaxChainCount) * BASE_SLIDE_DISTANCE, kept in sync every frame by the caller via setMaxSlideDistance. */
  private maxSlideDistanceValue = BASE_SLIDE_DISTANCE;

  private slashAngle = 0;
  private slashActiveRemainingMs = 0;
  private slashCooldownRemainingMs = 0;
  private swingId = 0;

  private dead = false;
  private worldTimescaleValue = 1;
  /** True once the death replay takes over - suppresses the slash-range indicator (see redrawSlashRangeIndicator), since it exists to inform a live decision that isn't being made anymore. */
  private isReplaying = false;

  constructor(
    private readonly scene: Phaser.Scene,
    x: number,
    y: number,
    private readonly arena: Arena,
    inputSource?: InputSource,
  ) {
    this.input = inputSource ?? new PlayerInput(scene);

    this.sprite = scene.physics.add.sprite(x, y, "time-player");
    this.sprite.setCircle(TimePlayer.RADIUS);
    this.sprite.setDepth(5);

    this.aimIndicator = scene.add.graphics();
    this.slashGraphic = scene.add.graphics();
    this.slashRangeGraphic = scene.add.graphics();
    this.slideDistanceAura = scene.add.graphics();
    this.slideDistanceAura.setDepth(4);
  }

  /** The world timescale computed from this frame's raw stick input - read this AFTER calling update(), and use it to step everything else ("the world") this same frame. */
  get worldTimescale(): number {
    return this.worldTimescaleValue;
  }

  /** Whatever InputState update() last read - null before the first update() call. Recorded frame-by-frame during live play to build a replayable run (see ReplayRecorder); not meaningful during replay itself, since that's driven by a RecordedInputSource reading its own already-recorded frames back. */
  get lastInputState(): InputState | null {
    return this.lastInputStateValue;
  }

  /**
   * Swaps the input source post-construction - used to switch from live
   * device input to a RecordedInputSource the moment a run ends, so the
   * death replay can drive the exact same player-update code with recorded
   * input instead of a second parallel implementation.
   */
  setInputSource(source: InputSource): void {
    this.input = source;
  }

  /** Marks this player as driven by the death replay from now on - hides the slash-range indicator, which exists to inform a live aiming decision that no longer applies once the run is over. */
  setReplaying(replaying: boolean): void {
    this.isReplaying = replaying;
  }

  /**
   * Re-syncs input edge-detection to whatever's currently held - call this
   * right after leaving a paused state (or right after constructing a fresh
   * TimePlayer on restart), so a button still held from confirming a menu
   * (Cross/Enter doubles as both "confirm" and Slide) doesn't fire that
   * in-game action the instant control returns to gameplay. No-op (and
   * harmless) when the current input source doesn't support it, e.g. a
   * RecordedInputSource during replay.
   */
  resyncInputState(): void {
    this.input.resyncHeldState?.(this.position.x, this.position.y);
  }

  update(realDelta: number): void {
    const state = this.input.read(this.position.x, this.position.y);
    this.lastInputStateValue = state;
    this.aimAngle = state.aimAngle;

    const move = new Phaser.Math.Vector2(state.moveX, state.moveY);
    // Speed scales with how far the stick is tilted (post-deadzone), not just
    // whether it's tilted at all - a light push should move you slower, full
    // tilt still hits top speed. Keyboard input is always -1/0/1 so this has
    // no effect there; it only matters for analog stick input.
    const tilt = Math.min(1, move.length());

    // Deliberately always DERIVED from this frame's moveX/moveY, live or
    // replayed alike - during a death replay this reproduces the exact same
    // worldScaledDelta sequence the original run had (a pure function of
    // already-recorded input), which is what makes the replay's enemy
    // spawns/projectile timing/RNG draws actually match what really
    // happened, instead of a different run that just started from the same
    // seed. See TimeMainScene's updateReplay for how the replay still plays
    // back faster than the original run without touching this.
    //
    // While sliding, though, the stick is treated as neutral regardless of
    // what it's actually doing - Slide's whole point is "move without
    // advancing the world", so letting a held stick ALSO advance world-time
    // while sliding would defeat that. Requires actual stick tilt (not just
    // the button held) - holding Slide in place with a neutral stick isn't
    // "sliding" (see isSliding below), so it doesn't get this treatment or
    // spend any budget; it just reads as standing still, same as ever.
    const wasSliding = this.isSliding;
    this.isSliding = state.dashHeld && tilt > 0 && this.slideDistance > 0;
    this.worldTimescaleValue = this.isSliding ? computeWorldTimescale(0, 0) : computeWorldTimescale(state.moveX, state.moveY);
    const worldScaledDelta = realDelta * this.worldTimescaleValue;

    this.tickCooldowns(worldScaledDelta);

    if (state.slashPressed && this.canSlash()) {
      this.startSlash(state.aimAngle);
    }
    this.updateSlash(realDelta);

    if (this.isSliding && !wasSliding) {
      playSlide();
    }

    const speed = this.isSliding ? SLIDE_SPEED : MOVE_SPEED;
    if (tilt > 0) {
      move.normalize().scale(speed * tilt);
    } else {
      move.set(0, 0);
    }
    this.clipOutwardComponent(move);
    this.velocityX = move.x;
    this.velocityY = move.y;

    if (this.isSliding) {
      const moveDist = (Math.hypot(this.velocityX, this.velocityY) * realDelta) / 1000;
      this.slideDistance = Math.max(0, this.slideDistance - moveDist);
      this.sprite.setTint(SLIDE_TINT);
      this.spawnSlideGhost();
    } else {
      this.sprite.clearTint();
    }

    this.sprite.x += (this.velocityX * realDelta) / 1000;
    this.sprite.y += (this.velocityY * realDelta) / 1000;

    this.auraPulseMs += realDelta;

    this.clampToArena();
    this.redrawAimIndicator();
    this.redrawSlashRangeIndicator();
    this.redrawSlideDistanceAura();
  }

  private get position(): { x: number; y: number } {
    return { x: this.sprite.x, y: this.sprite.y };
  }

  get isDead(): boolean {
    return this.dead;
  }

  /**
   * Restarts this same TimePlayer instance in place at (x, y) - used to
   * loop the death replay without recreating the sprite/graphics objects
   * each pass. Clears every piece of run-scoped state (slide/slash
   * cooldowns, dead flag, tint, velocity, aim) back to a fresh run's
   * starting values; does NOT touch the input source - the caller sets
   * that once when entering replay and it stays a RecordedInputSource
   * across every loop, just rewound.
   */
  reset(x: number, y: number): void {
    this.sprite.setPosition(x, y);
    this.velocityX = 0;
    this.velocityY = 0;
    this.sprite.clearTint();

    this.isSliding = false;
    this.slideDistance = BASE_SLIDE_DISTANCE;
    this.maxSlideDistanceValue = BASE_SLIDE_DISTANCE;
    this.auraPulseMs = 0;
    this.slideDistanceAura.clear();

    this.slashAngle = 0;
    this.slashActiveRemainingMs = 0;
    this.slashCooldownRemainingMs = 0;
    this.swingId = 0;
    this.slashGraphic.clear();

    this.dead = false;
    this.worldTimescaleValue = 1;
    this.aimAngle = -Math.PI / 2;
    this.lastInputStateValue = null;
  }

  /** How much distance Slide can still cover right now. */
  get slideDistanceAvailable(): number {
    return this.slideDistance;
  }

  /** The current ceiling on slideDistanceAvailable - see setMaxSlideDistance. */
  get maxSlideDistance(): number {
    return this.maxSlideDistanceValue;
  }

  /** Seconds of Slash cooldown remaining (world-time-scaled), 0 if ready. */
  get slashCooldownRemainingSec(): number {
    return this.slashCooldownRemainingMs / 1000;
  }

  get isInvincible(): boolean {
    return this.isSliding;
  }

  get isSlideActive(): boolean {
    return this.isSliding;
  }

  takeDamage(): void {
    this.dead = true;
    this.sprite.setTint(HURT_TINT);
    playDeath();
  }

  getActiveSlashHitbox(): SlashHitbox | null {
    if (this.slashActiveRemainingMs <= 0) {
      return null;
    }
    return {
      x: this.position.x,
      y: this.position.y,
      angle: this.slashAngle,
      range: SLASH_RANGE,
      arcWidth: SLASH_ARC_WIDTH,
      swingId: this.swingId,
    };
  }

  /**
   * The hitbox a Slash would use if triggered this exact instant, aimed at
   * the player's CURRENT aim angle rather than a locked-in swing angle - for
   * the "what would get hit right now" QoL preview, not an actual swing.
   * Null whenever Slash isn't off cooldown, since canSlash() being false
   * also covers "currently mid-swing" (the cooldown starts the instant a
   * swing does), so there's no separate check needed for that case.
   */
  getPreviewSlashHitbox(): SlashHitbox | null {
    if (!this.canSlash()) {
      return null;
    }
    return {
      x: this.position.x,
      y: this.position.y,
      angle: this.aimAngle,
      range: SLASH_RANGE,
      arcWidth: SLASH_ARC_WIDTH,
      swingId: -1,
    };
  }

  /**
   * Clears Slash's cooldown immediately - call this when a deflected
   * projectile goes on to kill something, rewarding a successful deflect
   * chain with another swing right away instead of waiting out the full
   * cooldown. Clamped to slashActiveRemainingMs rather than always
   * dropping straight to 0: a deflect-kill could in principle land during
   * the same swing that caused it (a very fast bounce), and canSlash()
   * only checks the cooldown, not whether a swing is still active - going
   * below the current swing's own remaining time would let a new swing
   * start while the old one's hitbox/animation is still playing.
   */
  resetSlashCooldown(): void {
    this.slashCooldownRemainingMs = Math.min(this.slashCooldownRemainingMs, this.slashActiveRemainingMs);
  }

  /**
   * Keeps slideDistanceAvailable's ceiling in sync with the live
   * deflected-projectile chain (see TimeManager.liveMaxChainCount) - call
   * every frame with BASE_SLIDE_DISTANCE * Math.max(1, that count). A no-op
   * unless the ceiling actually changed since last frame: rising snaps the
   * available distance straight up to the new max (a fresh chain hit hands
   * over that much extra slide immediately, no waiting - see
   * playChargeBanked), falling - the chain's source projectile despawned -
   * resets it straight down (or back up) to the new max just as
   * immediately, per "if the projectile despawns, the bonus resets."
   * Deliberately snaps rather than clamping the existing amount: landing
   * exactly on the new ceiling either way is what makes both directions
   * read as one consistent "reset," not two different rules.
   */
  setMaxSlideDistance(maxDistance: number): void {
    if (maxDistance === this.maxSlideDistanceValue) {
      return;
    }
    if (maxDistance > this.maxSlideDistanceValue) {
      playChargeBanked();
    }
    this.maxSlideDistanceValue = maxDistance;
    this.slideDistance = maxDistance;
  }

  private canSlash(): boolean {
    return this.slashCooldownRemainingMs <= 0;
  }

  /** A fading afterimage left behind while sliding, so it reads as motion rather than a teleport - the same "aftereffect" the old burst-dash had, just spawned continuously for as long as isSliding stays true instead of over a fixed duration. */
  private spawnSlideGhost(): void {
    const ghost = this.scene.add.image(this.sprite.x, this.sprite.y, "time-player");
    ghost.setTint(SLIDE_TINT);
    ghost.setAlpha(0.5);
    this.scene.tweens.add({
      targets: ghost,
      alpha: 0,
      scale: 0.7,
      duration: 220,
      onComplete: () => ghost.destroy(),
    });
  }

  private startSlash(angle: number): void {
    this.slashAngle = angle;
    this.slashActiveRemainingMs = SLASH_DURATION_MS;
    this.slashCooldownRemainingMs = SLASH_COOLDOWN_MS;
    this.swingId++;
    this.redrawSlashArc();
    playSlash();
  }

  private updateSlash(realDelta: number): void {
    if (this.slashActiveRemainingMs <= 0) {
      return;
    }
    this.slashActiveRemainingMs -= realDelta;
    if (this.slashActiveRemainingMs <= 0) {
      this.slashGraphic.clear();
    } else {
      this.redrawSlashArc();
    }
  }

  /**
   * The arc starts bright/thick (a flash) and tapers down to the settled
   * thin yellow line over the swing's active duration - reads as a moment
   * of impact rather than a static line that just appears and disappears.
   */
  private redrawSlashArc(): void {
    this.slashGraphic.clear();
    const progress = 1 - this.slashActiveRemainingMs / SLASH_DURATION_MS;
    const width = Phaser.Math.Linear(10, 4, progress);
    const alpha = Phaser.Math.Linear(1, 0.5, progress);
    const flashProgress = Math.min(1, progress / SLASH_FLASH_PORTION);
    const color = Phaser.Display.Color.Interpolate.ColorWithColor(
      Phaser.Display.Color.ValueToColor(0xffffff),
      Phaser.Display.Color.ValueToColor(SLASH_COLOR),
      100,
      flashProgress * 100,
    ).color;

    this.slashGraphic.lineStyle(width, color, alpha);
    this.slashGraphic.beginPath();
    this.slashGraphic.arc(this.position.x, this.position.y, SLASH_RANGE, this.slashAngle - SLASH_ARC_WIDTH / 2, this.slashAngle + SLASH_ARC_WIDTH / 2);
    this.slashGraphic.strokePath();
  }

  /**
   * A persistent wedge outline (arc + two radial lines back to the player)
   * showing exactly the region a Slash would hit if triggered this instant -
   * same range/arc-width/current-aim math getPreviewSlashHitbox() and the
   * actual swing both use, so this can never disagree with what's really
   * slashable. Drawn every frame regardless of swing state; brighter when
   * Slash is actually ready, faint while on cooldown. Suppressed entirely
   * during the death replay - it exists to help aim a swing that's about to
   * happen, and nothing being replayed is still being decided live.
   */
  private redrawSlashRangeIndicator(): void {
    this.slashRangeGraphic.clear();
    if (!getShowSlashRangeIndicator() || this.isReplaying) {
      return;
    }
    const ready = this.canSlash();
    const color = ready ? SLASH_RANGE_READY_COLOR : SLASH_RANGE_COOLDOWN_COLOR;
    const alpha = ready ? SLASH_RANGE_READY_ALPHA : SLASH_RANGE_COOLDOWN_ALPHA;
    const { x, y } = this.position;
    const startAngle = this.aimAngle - SLASH_ARC_WIDTH / 2;
    const endAngle = this.aimAngle + SLASH_ARC_WIDTH / 2;

    this.slashRangeGraphic.lineStyle(1.5, color, alpha);
    this.slashRangeGraphic.beginPath();
    this.slashRangeGraphic.arc(x, y, SLASH_RANGE, startAngle, endAngle);
    this.slashRangeGraphic.strokePath();

    this.slashRangeGraphic.lineBetween(x, y, x + Math.cos(startAngle) * SLASH_RANGE, y + Math.sin(startAngle) * SLASH_RANGE);
    this.slashRangeGraphic.lineBetween(x, y, x + Math.cos(endAngle) * SLASH_RANGE, y + Math.sin(endAngle) * SLASH_RANGE);
  }

  /**
   * A pulsing ring (or several, for a bigger bank) around the player that
   * only appears once a deflect chain has actually raised the slide-distance
   * cap above the baseline - a visible "loaded" tell for the bonus, rather
   * than a permanent fixture around the player during ordinary play. Ring
   * count/pulse speed scale with how many multiples of the baseline the
   * current cap represents (i.e. the live chain length); brightness also
   * scales with how full the tank currently is, so a drained bonus reads as
   * dimmer than a full one even at the same chain length. Not suppressed
   * during the death replay - unlike the slash-range indicator, this isn't
   * informing a live decision, it's just presentation (same as the slide
   * ghost trail or slash flash, which also still play back).
   */
  private redrawSlideDistanceAura(): void {
    this.slideDistanceAura.clear();
    if (this.maxSlideDistanceValue <= BASE_SLIDE_DISTANCE) {
      return;
    }
    const chainFactor = this.maxSlideDistanceValue / BASE_SLIDE_DISTANCE;
    const fillRatio = this.slideDistance / this.maxSlideDistanceValue;
    const pulseSpeed = 1.2 + chainFactor * 0.35;
    const pulse = (Math.sin((this.auraPulseMs / 1000) * pulseSpeed * Math.PI * 2) + 1) / 2;
    const ringCount = Math.min(4, Math.ceil(chainFactor / 2));
    const { x, y } = this.position;
    const baseR = TimePlayer.RADIUS * 1.3;

    for (let i = 0; i < ringCount; i++) {
      const spread = ringCount > 1 ? i / (ringCount - 1) : 0;
      const radius = baseR * (1.3 + spread * 0.9 + pulse * 0.15);
      const alpha = (0.5 - spread * 0.28) * (0.5 + pulse * 0.5) * fillRatio;
      this.slideDistanceAura.lineStyle(2, SLIDE_TINT, Math.max(0, alpha));
      this.slideDistanceAura.strokeCircle(x, y, radius);
    }
  }

  /**
   * Slide's distance budget regenerates (a stamina meter, not discrete
   * charges - see slideDistance's doc comment) and Slash's cooldown ticks
   * down, both on world-scaled time; everything else about the player stays
   * on real time (see class doc comment). Regen only runs while NOT actively
   * sliding - spending and regenerating never happen in the same frame.
   */
  private tickCooldowns(worldScaledDelta: number): void {
    if (!this.isSliding && this.slideDistance < this.maxSlideDistanceValue) {
      this.slideDistance = Math.min(this.maxSlideDistanceValue, this.slideDistance + (SLIDE_REGEN_PX_PER_SEC * worldScaledDelta) / 1000);
      if (this.slideDistance >= this.maxSlideDistanceValue) {
        playChargeRegen();
      }
    }
    if (this.slashCooldownRemainingMs > 0) {
      this.slashCooldownRemainingMs = Math.max(0, this.slashCooldownRemainingMs - worldScaledDelta);
    }
  }

  private redrawAimIndicator(): void {
    this.aimIndicator.clear();
    this.aimIndicator.lineStyle(2, 0x59f2c8, 0.8);
    const { x, y } = this.position;
    const tipX = x + Math.cos(this.aimAngle) * 36;
    const tipY = y + Math.sin(this.aimAngle) * 36;
    this.aimIndicator.lineBetween(x, y, tipX, tipY);
  }

  private clipOutwardComponent(velocity: Phaser.Math.Vector2): void {
    const dx = this.sprite.x - this.arena.bounds.centerX;
    const dy = this.sprite.y - this.arena.bounds.centerY;
    const distFromCenter = Math.sqrt(dx * dx + dy * dy);
    if (distFromCenter === 0) {
      return;
    }

    const angle = Math.atan2(dy, dx);
    const maxDist = this.arena.maxRadiusAtAngle(angle) - TimePlayer.RADIUS;

    if (distFromCenter >= maxDist - WALL_EPSILON) {
      const normal = this.arena.normalAtAngle(angle);
      const outwardSpeed = velocity.x * normal.x + velocity.y * normal.y;
      if (outwardSpeed > 0) {
        velocity.x -= outwardSpeed * normal.x;
        velocity.y -= outwardSpeed * normal.y;
      }
    }
  }

  private clampToArena(): void {
    const dx = this.sprite.x - this.arena.bounds.centerX;
    const dy = this.sprite.y - this.arena.bounds.centerY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= 0) {
      return;
    }

    const angle = Math.atan2(dy, dx);
    const maxDist = this.arena.maxRadiusAtAngle(angle) - TimePlayer.RADIUS;

    if (dist > maxDist) {
      const scale = maxDist / dist;
      this.sprite.x = this.arena.bounds.centerX + dx * scale;
      this.sprite.y = this.arena.bounds.centerY + dy * scale;
    }
  }
}
