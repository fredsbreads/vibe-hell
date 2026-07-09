import Phaser from "phaser";
import { TimePlayer } from "../timeMode/TimePlayer";
import { TimeManager, PROJECTILE_COLOR } from "../timeMode/TimeManager";
import { ArenaBounds, ARENA_RADIUS } from "../config/arena";
import { Arena } from "../arena/Arena";
import { PolygonArena } from "../arena/PolygonArena";
import { DualSenseMap, isPadButtonDown } from "../input/DualSenseMap";
import { MenuOverlay } from "../ui/MenuOverlay";
import { getShowSlashRangeIndicator, setShowSlashRangeIndicator } from "../config/settings";
import { RecordedFrame, RecordedInputSource } from "../timeMode/ReplayRecorder";
import { randomSeed } from "../timeMode/SeededRandom";

type UiState = "playing" | "paused" | "gameOver";

/** One full rotation every 30s - same slow, trackable rate the original game uses for its rotating shapes. */
const ARENA_ROTATION_RAD_PER_MS = (Math.PI * 2) / 30000;

const RESTART_HOLD_DURATION_MS = 500;
const MENU_STICK_THRESHOLD = 0.5;

/** Brief freeze-frame on a kill - real time itself pauses for this long (see the early-return in update()), not just world-scaled time. Short enough to read as impact rather than lag. */
const KILL_HIT_STOP_MS = 70;
const KILL_SHAKE_DURATION_MS = 90;
const KILL_SHAKE_INTENSITY = 0.004;
const DEATH_SHAKE_DURATION_MS = 220;
const DEATH_SHAKE_INTENSITY = 0.012;
const DEATH_FLASH_DURATION_MS = 200;

/**
 * Target amount of world-scaled simulated time (ms) the replay advances per
 * real rendered frame - kept constant so the replay's VISUAL PACE reads as
 * uniformly brisk throughout, unlike the original live run's dilation swings
 * (near-frozen while idle, brisk while moving). updateReplay() processes as
 * many recorded steps as it takes to hit this target each frame - many more
 * during a stretch that was near-frozen live (each step only contributes a
 * sliver of world time), barely more than one during a stretch that was
 * already near full speed. This is purely a PACING knob: every individual
 * step still derives its own worldTimescale from that step's real recorded
 * moveX/moveY (see TimePlayer.update), so the simulation itself - enemy
 * timers, spawns, RNG draws - stays bit-for-bit faithful to what actually
 * happened; only how many of those true steps get crammed into one real
 * frame varies.
 */
const REPLAY_TARGET_WORLD_MS_PER_FRAME = 48;
/** Hard cap on recorded steps processed in a single real frame - a pure safety valve so an extreme near-frozen stretch can't stall a frame; the target above just takes an extra real frame or two to catch up instead. */
const REPLAY_MAX_STEPS_PER_FRAME = 400;

/**
 * The time-dilation mode's main scene: endless survival, 1 HP, no wave
 * timer - the run just goes until you take a single hit. A single rotating
 * Hexagon arena for this first pass (no shape variety/obstacles yet -
 * deliberately deferred, see the design discussion this branch came out of).
 * The arena's own rotation is world-scaled too, like everything else that
 * isn't the player.
 */
export class TimeMainScene extends Phaser.Scene {
  private player!: TimePlayer;
  private timeManager!: TimeManager;
  private arena!: Arena;

  private enemiesDefeated = 0;
  private scoreText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private timescaleText!: Phaser.GameObjects.Text;
  private arenaOutlineGraphic!: Phaser.GameObjects.Graphics;

  private uiState: UiState = "playing";
  private menuOverlay!: MenuOverlay;
  /** Set while the OPTIONS submenu (reached from Pause) is showing - non-null means "esc/circle/BACK should return here" instead of the normal state-based back behavior. Null the rest of the time. */
  private optionsBackTarget: (() => void) | null = null;
  private menuHintText!: Phaser.GameObjects.Text;
  private escKey!: Phaser.Input.Keyboard.Key;
  private confirmKey!: Phaser.Input.Keyboard.Key;
  private restartKey!: Phaser.Input.Keyboard.Key;
  private menuUpKey!: Phaser.Input.Keyboard.Key;
  private menuDownKey!: Phaser.Input.Keyboard.Key;
  private prevEscHeld = false;
  private prevConfirmHeld = false;
  private prevCancelHeld = false;
  private prevMenuUpHeld = false;
  private prevMenuDownHeld = false;
  private restartHoldMs = 0;
  private restartHoldText!: Phaser.GameObjects.Text;

  private hitStopRemainingMs = 0;

  /** Seeds this run's RNG (enemy spawns, projectile kinds, aim imperfection) - regenerated each create() so a fresh run is never identical to the last, but held fixed for the rest of the run (and every death-replay loop) so the recorded input stream reproduces it exactly. */
  private runSeed = 0;
  /** This run's input history, one entry per real frame played - see ReplayRecorder's doc comment. Replayed on loop once the run ends. */
  private recordedFrames: RecordedFrame[] = [];
  private replaySource: RecordedInputSource | null = null;
  /** Score shown on the HUD while the death replay is looping - kept separate from enemiesDefeated so the frozen final score in the Game Over menu's subtitle doesn't get overwritten as the replay re-kills the same enemies each loop. */
  private replayEnemiesDefeated = 0;

  constructor() {
    super("TimeMainScene");
  }

  create(): void {
    const { width, height } = this.scale;

    this.enemiesDefeated = 0;
    this.uiState = "playing";
    this.restartHoldMs = 0;
    this.hitStopRemainingMs = 0;
    this.runSeed = randomSeed();
    this.recordedFrames = [];
    this.replaySource = null;
    this.replayEnemiesDefeated = 0;

    const arenaBounds: ArenaBounds = { centerX: width / 2, centerY: height / 2, radius: ARENA_RADIUS };
    this.arena = new Arena(arenaBounds, new PolygonArena(arenaBounds, 6, ARENA_ROTATION_RAD_PER_MS));

    this.generateCircleTexture("time-player", TimePlayer.RADIUS, 0x59f2c8);
    this.generateCircleTexture("time-enemy", 14, 0xff6b4a);
    this.generateCircleTexture("time-projectile", 7, PROJECTILE_COLOR);

    this.arenaOutlineGraphic = this.add.graphics();

    this.player = new TimePlayer(this, arenaBounds.centerX, arenaBounds.centerY, this.arena);
    // A restart can happen while Cross (or Triangle) is still physically held
    // down from confirming Restart in the menu - without this, the brand new
    // TimePlayer's dash edge-detection would start blind (assume nothing was
    // held) and misread that still-held button as a fresh dash the instant
    // the new run begins.
    this.player.resyncInputState();
    this.timeManager = new TimeManager(this, this.arena, this.runSeed);
    this.timeManager.spawnInitialEnemies(this.player.sprite.x, this.player.sprite.y);

    this.statusText = this.add.text(12, 12, "", {
      fontFamily: "monospace",
      fontSize: "16px",
      color: "#e0e0f0",
      lineSpacing: 6,
    });
    this.scoreText = this.add.text(width - 12, 12, "", {
      fontFamily: "monospace",
      fontSize: "16px",
      color: "#e0e0f0",
      align: "right",
    }).setOrigin(1, 0);
    this.timescaleText = this.add.text(width / 2, 12, "", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#6a6a80",
      align: "center",
    }).setOrigin(0.5, 0);

    this.menuOverlay = new MenuOverlay(this, width, height);
    this.menuHintText = this.add
      .text(width / 2, height / 2 + 110, "Up/Down or D-Pad/Stick to select  ·  Enter/Cross confirm  ·  Esc/Options/Circle back", {
        fontFamily: "monospace",
        fontSize: "12px",
        color: "#6a6a80",
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(21)
      .setVisible(false);
    this.restartHoldText = this.add
      .text(width / 2, height - 60, "", {
        fontFamily: "monospace",
        fontSize: "14px",
        color: "#ffe98a",
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(21);

    this.escKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
    this.confirmKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.ENTER);
    this.restartKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.R);
    this.menuUpKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.UP);
    this.menuDownKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN);
    this.resyncMenuNavHeldState();
  }

  update(_time: number, delta: number): void {
    this.pollMenuInputs(delta);
    this.menuOverlay.update(delta);

    if (this.uiState === "gameOver") {
      this.updateReplay();
      return;
    }

    if (this.uiState !== "playing") {
      return;
    }

    if (this.hitStopRemainingMs > 0) {
      // A brief total freeze on a kill - real time itself pauses (not just
      // world-scaled time), so this decrements by the raw delta and skips
      // every other update this frame, menu polling excepted (handled above).
      this.hitStopRemainingMs = Math.max(0, this.hitStopRemainingMs - delta);
      return;
    }

    this.player.update(delta);
    const inputState = this.player.lastInputState;
    if (inputState) {
      this.recordedFrames.push({
        moveX: inputState.moveX,
        moveY: inputState.moveY,
        aimAngle: inputState.aimAngle,
        dashPressed: inputState.dashPressed,
        slashPressed: inputState.slashPressed,
        realDelta: delta,
      });
    }
    const worldTimescale = this.player.worldTimescale;
    const worldScaledDelta = delta * worldTimescale;

    this.arena.update(worldScaledDelta);

    const deflectedKills = this.timeManager.update(delta, worldScaledDelta, this.player.sprite.x, this.player.sprite.y);
    if (deflectedKills > 0) {
      // Reward a successful deflect chain with another swing right away,
      // instead of making the player wait out Slash's full cooldown.
      this.player.resetSlashCooldown();
    }
    const slashKills = this.timeManager.checkSlashHits(this.player.getActiveSlashHitbox());
    this.timeManager.updateSlashPreview(this.player.getPreviewSlashHitbox(), delta);
    const killsThisFrame = deflectedKills + slashKills;
    this.enemiesDefeated += killsThisFrame;
    if (killsThisFrame > 0) {
      this.hitStopRemainingMs = KILL_HIT_STOP_MS;
      this.cameras.main.shake(KILL_SHAKE_DURATION_MS, KILL_SHAKE_INTENSITY);
    }

    if (!this.player.isInvincible && this.timeManager.checkPlayerHit(this.player.sprite.x, this.player.sprite.y, TimePlayer.RADIUS)) {
      this.player.takeDamage();
    }

    this.scoreText.setText(`ENEMIES DEFEATED: ${this.enemiesDefeated}`);
    this.timescaleText.setText(`world: ${Math.round(worldTimescale * 100)}%`);
    const dashLabel =
      this.player.dashCooldownRemainingSec > 0 ? `DASH: ${this.player.dashCooldownRemainingSec.toFixed(1)}s` : "DASH: READY";
    const slashLabel =
      this.player.slashCooldownRemainingSec > 0 ? `SLASH: ${this.player.slashCooldownRemainingSec.toFixed(1)}s` : "SLASH: READY";
    this.statusText.setText(`${dashLabel}\n${slashLabel}\nHP: ${this.player.isDead ? "♡" : "♥"}`);
    this.redrawArenaOutline();

    if (this.player.isDead) {
      this.enterGameOver();
    }
  }

  /**
   * Drives the death replay: steps the exact same simulation code the live
   * run used (player/arena/timeManager update, slash-hit resolution,
   * player-hit death check), fed by the recorded input stream instead of a
   * live device. World timescale is re-derived from each step's recorded
   * moveX/moveY exactly as it was live (see TimePlayer.update), so this
   * reproduces the actual run rather than a different one. Processes
   * recorded steps until REPLAY_TARGET_WORLD_MS_PER_FRAME of world time has
   * been covered THIS real frame (see its own doc comment for why that's
   * variable-count rather than a fixed steps-per-frame) - a pure pacing
   * choice layered on top of a state-faithful replay, not a different
   * simulation. Loops back to the start (resetForReplayLoop) the instant
   * either the recording runs out or the player dies again, so it plays
   * forever behind the (compact, corner-layout) Game Over menu until the
   * player restarts or leaves.
   */
  private updateReplay(): void {
    if (!this.replaySource) {
      return;
    }

    let worldMsCovered = 0;
    let steps = 0;
    while (worldMsCovered < REPLAY_TARGET_WORLD_MS_PER_FRAME && steps < REPLAY_MAX_STEPS_PER_FRAME) {
      if (this.replaySource.isExhausted || this.player.isDead) {
        this.resetForReplayLoop();
      }

      const stepDelta = this.replaySource.nextDelta;
      this.player.update(stepDelta);
      const worldScaledDelta = stepDelta * this.player.worldTimescale;
      this.arena.update(worldScaledDelta);

      const deflectedKills = this.timeManager.update(stepDelta, worldScaledDelta, this.player.sprite.x, this.player.sprite.y);
      if (deflectedKills > 0) {
        this.player.resetSlashCooldown();
      }
      const slashKills = this.timeManager.checkSlashHits(this.player.getActiveSlashHitbox());
      this.timeManager.updateSlashPreview(this.player.getPreviewSlashHitbox(), stepDelta);
      this.replayEnemiesDefeated += deflectedKills + slashKills;

      if (!this.player.isInvincible && this.timeManager.checkPlayerHit(this.player.sprite.x, this.player.sprite.y, TimePlayer.RADIUS)) {
        this.player.takeDamage();
      }

      worldMsCovered += worldScaledDelta;
      steps++;
    }

    this.scoreText.setText(`ENEMIES DEFEATED: ${this.replayEnemiesDefeated}`);
    this.timescaleText.setText(`world: ${Math.round(this.player.worldTimescale * 100)}%`);
    const dashLabel =
      this.player.dashCooldownRemainingSec > 0 ? `DASH: ${this.player.dashCooldownRemainingSec.toFixed(1)}s` : "DASH: READY";
    const slashLabel =
      this.player.slashCooldownRemainingSec > 0 ? `SLASH: ${this.player.slashCooldownRemainingSec.toFixed(1)}s` : "SLASH: READY";
    this.statusText.setText(`${dashLabel}\n${slashLabel}\nHP: ${this.player.isDead ? "♡" : "♥"}`);
    this.redrawArenaOutline();
  }

  /** Restarts the death replay from the top - same starting position/seed/arena orientation the live run itself began with, so each loop is bit-for-bit identical to the last. Resets the existing pooled player/timeManager/arena in place rather than reconstructing them. */
  private resetForReplayLoop(): void {
    const { centerX, centerY } = this.arena.bounds;
    this.player.reset(centerX, centerY);
    this.arena.resetRotation();
    this.timeManager.reset(this.runSeed);
    this.timeManager.spawnInitialEnemies(centerX, centerY);
    this.replaySource?.rewind();
    this.replayEnemiesDefeated = 0;
  }

  private pollMenuInputs(delta: number): void {
    const pad = this.input.gamepad?.pad1;

    const escHeld = this.escKey.isDown || isPadButtonDown(pad, DualSenseMap.OPTIONS);
    const escPressed = escHeld && !this.prevEscHeld;
    this.prevEscHeld = escHeld;
    if (escPressed) {
      if (this.optionsBackTarget) {
        this.closeOptions();
      } else if (this.uiState === "playing") {
        this.enterPause();
      } else if (this.uiState === "paused") {
        this.exitPause();
      } else {
        this.goToMainMenu();
      }
    }

    const cancelHeld = isPadButtonDown(pad, DualSenseMap.CIRCLE);
    const cancelPressed = cancelHeld && !this.prevCancelHeld;
    this.prevCancelHeld = cancelHeld;
    if (cancelPressed) {
      if (this.optionsBackTarget) {
        this.closeOptions();
      } else if (this.uiState === "paused") {
        this.exitPause();
      }
    }

    const restartHeld = this.restartKey.isDown || isPadButtonDown(pad, DualSenseMap.TRIANGLE);
    if (restartHeld) {
      this.restartHoldMs += delta;
      if (this.restartHoldMs >= RESTART_HOLD_DURATION_MS) {
        this.restartHoldMs = 0;
        this.restartHoldText.setText("");
        this.restartRun();
        return;
      }
      const pct = Math.min(100, Math.round((this.restartHoldMs / RESTART_HOLD_DURATION_MS) * 100));
      this.restartHoldText.setText(`HOLD R TO RESTART... ${pct}%`);
    } else {
      this.restartHoldMs = 0;
      this.restartHoldText.setText("");
    }

    if (this.uiState === "playing") {
      return;
    }

    const stickY = pad?.leftStick.y ?? 0;
    const upHeld = this.menuUpKey.isDown || isPadButtonDown(pad, DualSenseMap.DPAD_UP) || stickY < -MENU_STICK_THRESHOLD;
    const upPressed = upHeld && !this.prevMenuUpHeld;
    this.prevMenuUpHeld = upHeld;
    if (upPressed) {
      this.menuOverlay.moveFocus(-1);
    }

    const downHeld =
      this.menuDownKey.isDown || isPadButtonDown(pad, DualSenseMap.DPAD_DOWN) || stickY > MENU_STICK_THRESHOLD;
    const downPressed = downHeld && !this.prevMenuDownHeld;
    this.prevMenuDownHeld = downHeld;
    if (downPressed) {
      this.menuOverlay.moveFocus(1);
    }

    const confirmHeld = this.confirmKey.isDown || isPadButtonDown(pad, DualSenseMap.CROSS);
    const confirmPressed = confirmHeld && !this.prevConfirmHeld;
    this.prevConfirmHeld = confirmHeld;
    if (confirmPressed) {
      this.menuOverlay.confirmFocused();
    }
  }

  private resyncMenuNavHeldState(): void {
    const pad = this.input.gamepad?.pad1;
    const stickY = pad?.leftStick.y ?? 0;
    this.prevEscHeld = this.escKey.isDown || isPadButtonDown(pad, DualSenseMap.OPTIONS);
    this.prevConfirmHeld = this.confirmKey.isDown || isPadButtonDown(pad, DualSenseMap.CROSS);
    this.prevCancelHeld = isPadButtonDown(pad, DualSenseMap.CIRCLE);
    this.prevMenuUpHeld =
      this.menuUpKey.isDown || isPadButtonDown(pad, DualSenseMap.DPAD_UP) || stickY < -MENU_STICK_THRESHOLD;
    this.prevMenuDownHeld =
      this.menuDownKey.isDown || isPadButtonDown(pad, DualSenseMap.DPAD_DOWN) || stickY > MENU_STICK_THRESHOLD;
  }

  private enterPause(): void {
    this.uiState = "paused";
    this.physics.pause();
    this.resyncMenuNavHeldState();
    this.menuOverlay.show("PAUSED", "", [
      { label: "RESUME", onSelect: () => this.exitPause() },
      { label: "OPTIONS", onSelect: () => this.showOptions(() => this.enterPause()) },
      { label: "RESTART", onSelect: () => this.restartRun() },
      { label: "MAIN MENU", onSelect: () => this.goToMainMenu() },
    ]);
    this.menuHintText.setVisible(true);
  }

  /** Swaps the (already-showing) menu overlay to the OPTIONS screen - onBack is called (and the overlay swapped back) on BACK/esc/circle. Reuses the single shared menuOverlay rather than a separate instance, matching how pause/game-over already share it. Always full-screen "center" layout regardless of which menu opened it (the Game Over corner menu is too small to fit this), so its own nav hint text is shown here too and hidden again once onBack takes over. */
  private showOptions(onBack: () => void): void {
    this.optionsBackTarget = onBack;
    this.resyncMenuNavHeldState();
    this.menuOverlay.show("OPTIONS", "", [
      {
        label: `SLASH RANGE INDICATOR: ${getShowSlashRangeIndicator() ? "ON" : "OFF"}`,
        onSelect: () => {
          setShowSlashRangeIndicator(!getShowSlashRangeIndicator());
          this.showOptions(onBack);
        },
      },
      { label: "BACK", onSelect: () => this.closeOptions() },
    ]);
    this.menuHintText.setVisible(true);
  }

  private closeOptions(): void {
    const back = this.optionsBackTarget;
    this.optionsBackTarget = null;
    back?.();
  }

  private exitPause(): void {
    this.uiState = "playing";
    this.physics.resume();
    this.menuOverlay.hide();
    this.menuHintText.setVisible(false);
    // Whatever button confirmed "Resume" (Cross/Enter) may still be physically
    // held for a frame or two - resync so TimePlayer doesn't mistake that
    // same still-held button for a fresh dash press the instant play resumes.
    this.player.resyncInputState();
  }

  private enterGameOver(): void {
    this.uiState = "gameOver";
    // Deliberately NOT this.physics.pause() - the death replay keeps the
    // whole simulation running (see updateReplay) so it stays visible behind
    // the compact corner menu, unlike the full-screen Pause overlay.
    this.cameras.main.shake(DEATH_SHAKE_DURATION_MS, DEATH_SHAKE_INTENSITY);
    this.cameras.main.flash(DEATH_FLASH_DURATION_MS, 255, 59, 59);
    // The compact corner menu is self-explanatory (two clickable/highlightable
    // buttons right under the title) - the full hint text is sized/positioned
    // for the old full-screen centered menu and would clutter the small panel.
    this.showGameOverMenu();

    this.replaySource = new RecordedInputSource(this.recordedFrames);
    this.player.setInputSource(this.replaySource);
    this.player.setReplaying(true);
    this.resetForReplayLoop();
  }

  /** (Re-)shows the Game Over corner menu - split out from enterGameOver() so returning here from OPTIONS doesn't repeat the one-time death shake/flash/replay setup. */
  private showGameOverMenu(): void {
    this.resyncMenuNavHeldState();
    this.menuOverlay.show(
      "GAME OVER",
      `Enemies Defeated: ${this.enemiesDefeated}`,
      [
        { label: "RESTART", onSelect: () => this.restartRun() },
        { label: "OPTIONS", onSelect: () => this.showOptions(() => this.showGameOverMenu()) },
        { label: "MAIN MENU", onSelect: () => this.goToMainMenu() },
      ],
      "corner",
    );
    this.menuHintText.setVisible(false);
  }

  private restartRun(): void {
    this.scene.restart();
  }

  private goToMainMenu(): void {
    this.scene.start("TimeTitleScene");
  }

  private redrawArenaOutline(): void {
    const vertices = this.arena.getRenderVertices();
    this.arenaOutlineGraphic.clear();
    this.arenaOutlineGraphic.fillStyle(0x1a1a2e, 1);
    this.arenaOutlineGraphic.lineStyle(4, 0x4a4a6a, 1);

    if (!vertices) {
      const { centerX, centerY, radius } = this.arena.bounds;
      this.arenaOutlineGraphic.fillCircle(centerX, centerY, radius);
      this.arenaOutlineGraphic.strokeCircle(centerX, centerY, radius);
      return;
    }

    this.arenaOutlineGraphic.beginPath();
    this.arenaOutlineGraphic.moveTo(vertices[0].x, vertices[0].y);
    for (let i = 1; i < vertices.length; i++) {
      this.arenaOutlineGraphic.lineTo(vertices[i].x, vertices[i].y);
    }
    this.arenaOutlineGraphic.closePath();
    this.arenaOutlineGraphic.fillPath();
    this.arenaOutlineGraphic.strokePath();
  }

  private generateCircleTexture(key: string, radius: number, color: number): void {
    if (this.textures.exists(key)) {
      return;
    }
    const size = radius * 2;
    const graphics = this.add.graphics();
    graphics.fillStyle(color, 1);
    graphics.fillCircle(radius, radius, radius);
    graphics.generateTexture(key, size, size);
    graphics.destroy();
  }
}
