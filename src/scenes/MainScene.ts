import Phaser from "phaser";
import { Player } from "../entities/Player";
import { ProjectileManager, SAFE_LANE_ARC_RADIANS } from "../managers/ProjectileManager";
import { WaveManager } from "../managers/WaveManager";
import { ArenaBounds, ARENA_RADIUS } from "../config/arena";
import { Arena } from "../arena/Arena";
import { ArenaShape } from "../arena/ArenaShape";
import { CircleArena } from "../arena/CircleArena";
import { PolygonArena } from "../arena/PolygonArena";
import { BASIC_PROJECTILE_RADIUS } from "../entities/projectiles/BasicProjectile";
import { ZOOMER_PROJECTILE_RADIUS } from "../entities/projectiles/ZoomerProjectile";
import { CHASER_PROJECTILE_RADIUS } from "../entities/projectiles/ChaserProjectile";
import { DualSenseMap, isPadButtonDown } from "../input/DualSenseMap";
import { getVirtualStickAnchor, VIRTUAL_STICK_RADIUS } from "../input/PlayerInput";
import { getAimMode } from "../config/settings";
import { MenuOverlay } from "../ui/MenuOverlay";

type UiState = "playing" | "paused" | "gameOver";

/** One full rotation every 30s for spinning arena shapes - slow enough to track, per the GDD's "Spin" wave stage. */
const ARENA_ROTATION_RAD_PER_MS = (Math.PI * 2) / 30000;

/** How long R (or gamepad Square) must be held while paused/game-over before it triggers a restart. */
const RESTART_HOLD_DURATION_MS = 500;

/** How far the left stick must tilt vertically to count as an Up/Down menu-navigation press. */
const MENU_STICK_THRESHOLD = 0.5;

/** Debug-cyclable arena shapes (key 4), demonstrating the shape abstraction beyond the default circle. */
const ARENA_SHAPE_CYCLE: Array<{ label: string; build: (bounds: ArenaBounds) => ArenaShape }> = [
  { label: "Circle", build: (bounds) => new CircleArena(bounds) },
  { label: "Square", build: (bounds) => new PolygonArena(bounds, 4, ARENA_ROTATION_RAD_PER_MS) },
  { label: "Hexagon", build: (bounds) => new PolygonArena(bounds, 6, ARENA_ROTATION_RAD_PER_MS) },
  { label: "Octagon", build: (bounds) => new PolygonArena(bounds, 8, ARENA_ROTATION_RAD_PER_MS) },
];

interface MainSceneData {
  startWave?: number;
}

export class MainScene extends Phaser.Scene {
  private player!: Player;
  private projectileManager!: ProjectileManager;
  private waveManager!: WaveManager;
  private arena!: Arena;
  private arenaShapeIndex = 0;
  private startWave = 1;

  private threatsEndured = 0;
  private threatsText!: Phaser.GameObjects.Text;
  private debugText!: Phaser.GameObjects.Text;
  private safeLaneGraphic!: Phaser.GameObjects.Graphics;
  private arenaOutlineGraphic!: Phaser.GameObjects.Graphics;
  private virtualStickGraphic!: Phaser.GameObjects.Graphics;
  private waveText!: Phaser.GameObjects.Text;
  private waveBannerText!: Phaser.GameObjects.Text;

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

  constructor() {
    super("MainScene");
  }

  create(data: MainSceneData): void {
    const { width, height } = this.scale;

    // Re-assign every run-scoped field explicitly: scene.restart() re-invokes create()
    // on the SAME instance rather than constructing a fresh one, so field initializers
    // above only apply to the very first run - anything mutated during play must be
    // reset here or a "restart" would silently carry over stale state.
    this.threatsEndured = 0;
    this.uiState = "playing";
    this.prevEscHeld = false;
    this.prevConfirmHeld = false;
    this.prevCancelHeld = false;
    this.prevMenuUpHeld = false;
    this.prevMenuDownHeld = false;
    this.restartHoldMs = 0;
    // Restart passes { startWave: this.startWave } explicitly (see restartRun) so a
    // jumped-to wave survives a restart; falls back to 1 if launched with no data at all.
    if (data?.startWave !== undefined) {
      this.startWave = data.startWave;
    }

    const arenaBounds: ArenaBounds = { centerX: width / 2, centerY: height / 2, radius: ARENA_RADIUS };
    this.arena = new Arena(arenaBounds, ARENA_SHAPE_CYCLE[this.arenaShapeIndex].build(arenaBounds));

    this.generateCircleTexture("player", Player.RADIUS, 0x59f2c8);
    this.generateCircleTexture("basic-projectile", BASIC_PROJECTILE_RADIUS, 0xff6b4a);
    this.generateCircleTexture("zoomer-projectile", ZOOMER_PROJECTILE_RADIUS, 0xf2e85c);
    this.generateCircleTexture("chaser-projectile", CHASER_PROJECTILE_RADIUS, 0xd35cf2);

    this.arenaOutlineGraphic = this.add.graphics();
    this.safeLaneGraphic = this.add.graphics();
    this.virtualStickGraphic = this.add.graphics().setScrollFactor(0).setDepth(15);

    this.player = new Player(this, arenaBounds.centerX, arenaBounds.centerY, this.arena);
    this.projectileManager = new ProjectileManager(this, this.arena);
    this.waveManager = new WaveManager(this.projectileManager, this.startWave);

    this.threatsText = this.add
      .text(width - 12, 12, "", {
        fontFamily: "monospace",
        fontSize: "16px",
        color: "#e0e0f0",
      })
      .setOrigin(1, 0);

    this.waveText = this.add
      .text(width / 2, 12, "", {
        fontFamily: "monospace",
        fontSize: "16px",
        color: "#e0e0f0",
      })
      .setOrigin(0.5, 0);

    this.waveBannerText = this.add
      .text(arenaBounds.centerX, arenaBounds.centerY, "", {
        fontFamily: "monospace",
        fontSize: "36px",
        color: "#ffe98a",
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(10);

    this.debugText = this.add
      .text(width - 12, height - 12, "", {
        fontFamily: "monospace",
        fontSize: "14px",
        color: "#8a8aa0",
        align: "right",
      })
      .setOrigin(1, 1);

    this.menuOverlay = new MenuOverlay(this, width, height);
    this.menuHintText = this.add
      .text(width / 2, height / 2 + 130, "Up/Down or D-Pad/Stick to select  ·  Enter/Cross confirm  ·  Esc/Options/Circle back", {
        fontFamily: "monospace",
        fontSize: "12px",
        color: "#6a6a80",
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(21)
      .setVisible(false);
    this.restartHoldText = this.add
      .text(width / 2, height - 90, "", {
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

    this.setupDebugSpawnToggles();
  }

  update(_time: number, delta: number): void {
    this.pollMenuInputs(delta);
    this.menuOverlay.update();

    if (this.uiState !== "playing") {
      return;
    }

    this.player.update(delta);

    this.projectileManager.update(delta, this.player.sprite.x, this.player.sprite.y);
    // Only a Slash kill counts as a "threat endured" - a projectile that simply
    // escapes the arena unhandled isn't scored.
    const slashHits = this.projectileManager.checkSlashHits(this.player.getActiveSlashHitbox());
    this.threatsEndured += slashHits;

    if (!this.player.isInvincible) {
      const damage = this.projectileManager.checkPlayerCollisions(
        this.player.sprite.x,
        this.player.sprite.y,
        Player.RADIUS,
      );
      if (damage > 0) {
        this.player.takeDamage(damage);
      }
    }

    // Stop Wave is a pure Dash counter: walking through it is completely
    // harmless, so the check only ever runs while the player is dashing.
    // Getting hit cancels the dash immediately (interruptDashAndDamage), which
    // naturally prevents repeat damage from the same overlap on the next
    // frame - isDashActive is already false by then.
    if (this.player.isDashActive) {
      const stopWaveHits = this.projectileManager.checkStopWaveCollisions(
        this.player.sprite.x,
        this.player.sprite.y,
        Player.RADIUS,
      );
      if (stopWaveHits > 0) {
        this.player.interruptDashAndDamage(stopWaveHits);
      }
    }

    this.waveManager.update(delta);

    this.threatsText.setText(`THREATS ENDURED: ${this.threatsEndured}`);
    this.updateDebugText();
    this.updateWaveUi();
    this.redrawArenaOutline();
    this.redrawSafeLane();
    this.redrawVirtualStick();

    if (this.player.isDead) {
      this.enterGameOver();
    }
  }

  /**
   * Escape/Options is a context-sensitive "back" button: pauses while
   * playing, resumes while paused, and returns to the title while dead.
   * Circle is a dedicated cancel button matching PlayStation UX convention -
   * while paused, it closes the menu and resumes play, same as Options would,
   * but without also being the button that opened the pause menu in the
   * first place. While a menu is open, Up/Down (arrow keys, D-pad, or the
   * left stick) move the highlighted option and Enter/Cross activates it -
   * the standard "highlight + confirm" pattern, rather than a fixed key/
   * button per menu item. R/Square is a separate direct Restart shortcut
   * (held, to guard against an accidental press) that works in any uiState,
   * not just while a menu is open. Polled with edge-detection (like
   * PlayerInput) since Phaser doesn't expose gamepad button presses as
   * keydown-style events.
   */
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

    // Restart discards the current run, so it requires a brief hold rather than an
    // instant tap - a stray/reflexive press of R (or Square) shouldn't be able to
    // wipe out progress. Works in every uiState (mid-run included, not just paused/
    // game-over) so you can bail out and restart without pausing first.
    // restartHoldText shows the hold building up so it reads as a deliberate confirm
    // gesture instead of the key just not working.
    const restartHeld = this.restartKey.isDown || isPadButtonDown(pad, DualSenseMap.SQUARE);
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

  private enterPause(): void {
    this.uiState = "paused";
    this.physics.pause();
    this.tweens.pauseAll();
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
    this.tweens.resumeAll();
    this.menuOverlay.hide();
    this.menuHintText.setVisible(false);
  }

  private enterGameOver(): void {
    this.uiState = "gameOver";
    this.physics.pause();
    this.tweens.pauseAll();
    const stats = `Wave ${this.waveManager.currentWave}   Threats Endured: ${this.threatsEndured}`;
    this.menuOverlay.show("GAME OVER", stats, [
      { label: "RESTART", onSelect: () => this.restartRun() },
      { label: "MAIN MENU", onSelect: () => this.goToMainMenu() },
    ]);
    this.menuHintText.setVisible(true);
  }

  private restartRun(): void {
    // Explicitly re-pass startWave: scene.restart() with no data does not automatically
    // resupply what create() originally received, so a jumped-to wave would otherwise
    // silently fall back to wave 1 on restart.
    this.scene.restart({ startWave: this.startWave });
  }

  private goToMainMenu(): void {
    this.scene.start("TitleScene");
  }

  /** "WAVE X" + time remaining while active; a "WAVE X COMPLETE" banner during the Breather Window intermission. */
  private updateWaveUi(): void {
    const secondsLeft = Math.max(0, Math.ceil(this.waveManager.phaseTimeRemainingMs / 1000));

    if (this.waveManager.phase === "active") {
      this.waveText.setText(`WAVE ${this.waveManager.currentWave}   ${secondsLeft}s`);
      this.waveBannerText.setText("");
    } else {
      this.waveText.setText(`WAVE ${this.waveManager.currentWave} COMPLETE`);
      this.waveBannerText.setText(`WAVE ${this.waveManager.currentWave} COMPLETE\nnext wave in ${secondsLeft}s`);
    }
  }

  /** Draws the current arena shape's wall - a smooth circle, or a closed polyline through a polygon's (possibly spinning) vertices. */
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

  /**
   * Draws the virtual stick's fixed anchor ring plus a dot tracking the mouse,
   * clamped to the ring so it reads like a real stick - visual feedback for
   * "virtualStick" aim mode. Hidden whenever a gamepad is connected, since in
   * that case the mode falls back to the real right stick and this UI would be
   * both unused and misleading.
   */
  private redrawVirtualStick(): void {
    this.virtualStickGraphic.clear();
    if (getAimMode() !== "virtualStick" || this.input.gamepad?.pad1) {
      return;
    }

    const anchor = getVirtualStickAnchor(this);
    const pointer = this.input.activePointer;
    const dx = pointer.x - anchor.x;
    const dy = pointer.y - anchor.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const clampedDist = Math.min(dist, VIRTUAL_STICK_RADIUS);
    const dotX = dist > 0 ? anchor.x + (dx / dist) * clampedDist : anchor.x;
    const dotY = dist > 0 ? anchor.y + (dy / dist) * clampedDist : anchor.y;

    this.virtualStickGraphic.lineStyle(2, 0x59f2c8, 0.5);
    this.virtualStickGraphic.strokeCircle(anchor.x, anchor.y, VIRTUAL_STICK_RADIUS);
    this.virtualStickGraphic.fillStyle(0x59f2c8, 0.25);
    this.virtualStickGraphic.fillCircle(anchor.x, anchor.y, 3);
    this.virtualStickGraphic.fillStyle(0xffe98a, 0.9);
    this.virtualStickGraphic.fillCircle(dotX, dotY, 8);
  }

  /** Renders the Safe Lane Volley Rule's guaranteed-empty arc, sampled along the current wall shape so it hugs flat edges/corners too, not just a circle. */
  private redrawSafeLane(): void {
    const center = this.projectileManager.safeLaneCenterAngle;
    const half = SAFE_LANE_ARC_RADIANS / 2;
    const segments = 32;

    this.safeLaneGraphic.clear();
    this.safeLaneGraphic.lineStyle(6, 0x59f2c8, 0.3);
    this.safeLaneGraphic.beginPath();
    for (let i = 0; i <= segments; i++) {
      const angle = center - half + (SAFE_LANE_ARC_RADIANS * i) / segments;
      const point = this.arena.boundaryPointAtAngle(angle);
      if (i === 0) {
        this.safeLaneGraphic.moveTo(point.x, point.y);
      } else {
        this.safeLaneGraphic.lineTo(point.x, point.y);
      }
    }
    this.safeLaneGraphic.strokePath();
  }

  /** Debug-only: number keys manually toggle each threat type's spawning; key 4 cycles the arena shape. */
  private setupDebugSpawnToggles(): void {
    this.input.keyboard!.on("keydown-ONE", () => {
      this.projectileManager.setZoomerSpawningEnabled(!this.projectileManager.isZoomerSpawningEnabled);
    });
    this.input.keyboard!.on("keydown-TWO", () => {
      this.projectileManager.setStopWaveSpawningEnabled(!this.projectileManager.isStopWaveSpawningEnabled);
    });
    this.input.keyboard!.on("keydown-THREE", () => {
      this.projectileManager.setChaserSpawningEnabled(!this.projectileManager.isChaserSpawningEnabled);
    });
    this.input.keyboard!.on("keydown-FOUR", () => {
      this.arenaShapeIndex = (this.arenaShapeIndex + 1) % ARENA_SHAPE_CYCLE.length;
      this.arena.setShape(ARENA_SHAPE_CYCLE[this.arenaShapeIndex].build(this.arena.bounds));
    });
  }

  private updateDebugText(): void {
    const zoomerState = this.projectileManager.isZoomerSpawningEnabled ? "ON" : "off";
    const stopWaveState = this.projectileManager.isStopWaveSpawningEnabled ? "ON" : "off";
    const chaserState = this.projectileManager.isChaserSpawningEnabled ? "ON" : "off";
    const shapeLabel = ARENA_SHAPE_CYCLE[this.arenaShapeIndex].label;
    this.debugText.setText(
      `[DEBUG] 1: Zoomer ${zoomerState}   2: Stop Wave ${stopWaveState}   3: Chaser ${chaserState}   4: Arena (${shapeLabel})`,
    );
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
