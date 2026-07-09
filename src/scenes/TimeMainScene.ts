import Phaser from "phaser";
import { TimePlayer } from "../timeMode/TimePlayer";
import { TimeManager, PROJECTILE_COLOR } from "../timeMode/TimeManager";
import { ArenaBounds, ARENA_RADIUS } from "../config/arena";
import { Arena } from "../arena/Arena";
import { PolygonArena } from "../arena/PolygonArena";
import { DualSenseMap, isPadButtonDown } from "../input/DualSenseMap";
import { MenuOverlay } from "../ui/MenuOverlay";

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

  constructor() {
    super("TimeMainScene");
  }

  create(): void {
    const { width, height } = this.scale;

    this.enemiesDefeated = 0;
    this.uiState = "playing";
    this.restartHoldMs = 0;
    this.hitStopRemainingMs = 0;

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
    this.timeManager = new TimeManager(this, this.arena);
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

    this.player.update(delta, {
      snapAngle: (x, y, angle, range, arcWidth) => this.timeManager.computeSnappedAimAngle(x, y, angle, range, arcWidth),
      findChainLock: (x, y, target, referenceAngle, range, arcWidth) =>
        this.timeManager.findChainLock(x, y, target, referenceAngle, range, arcWidth),
    });
    const worldTimescale = this.player.worldTimescale;
    const worldScaledDelta = delta * worldTimescale;

    this.arena.update(worldScaledDelta);

    const deflectedKills = this.timeManager.update(delta, worldScaledDelta, this.player.sprite.x, this.player.sprite.y);
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

  private pollMenuInputs(delta: number): void {
    const pad = this.input.gamepad?.pad1;

    const escHeld = this.escKey.isDown || isPadButtonDown(pad, DualSenseMap.OPTIONS);
    const escPressed = escHeld && !this.prevEscHeld;
    this.prevEscHeld = escHeld;
    if (escPressed) {
      if (this.uiState === "playing") {
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
    if (cancelPressed && this.uiState === "paused") {
      this.exitPause();
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
      { label: "RESTART", onSelect: () => this.restartRun() },
      { label: "MAIN MENU", onSelect: () => this.goToMainMenu() },
    ]);
    this.menuHintText.setVisible(true);
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
    this.physics.pause();
    this.cameras.main.shake(DEATH_SHAKE_DURATION_MS, DEATH_SHAKE_INTENSITY);
    this.cameras.main.flash(DEATH_FLASH_DURATION_MS, 255, 59, 59);
    this.resyncMenuNavHeldState();
    this.menuOverlay.show("GAME OVER", `Enemies Defeated: ${this.enemiesDefeated}`, [
      { label: "RESTART", onSelect: () => this.restartRun() },
      { label: "MAIN MENU", onSelect: () => this.goToMainMenu() },
    ]);
    this.menuHintText.setVisible(true);
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
