import { ProjectileManager } from "./ProjectileManager";

const WAVE_DURATION_MS = 45000;
const INTERMISSION_DURATION_MS = 3000;

const DIFFICULTY_STEP = 0.15;
const DIFFICULTY_PLATEAU_WAVE = 10;

/** Waves at which each harder threat type first joins the fight - basic is always active from wave 1. */
const ZOOMER_INTRODUCED_AT_WAVE = 3;
const CHASER_INTRODUCED_AT_WAVE = 4;
const STOP_WAVE_INTRODUCED_AT_WAVE = 5;

export type WavePhase = "active" | "intermission";

/**
 * Drives the GDD's core progression loop: 45s of active survival, then a
 * 3s "Breather Window" intermission that wipes the field and shows a
 * completion banner, before the next (harder) wave begins. Difficulty
 * scales via ProjectileManager's spawn-frequency multiplier (+15%/wave,
 * plateauing at wave 10) and by introducing tougher threat types on a
 * schedule, per the GDD's wave 1-2 / 3 / 4+ progression.
 */
export class WaveManager {
  private wave = 1;
  private phaseValue: WavePhase = "active";
  private phaseTimeRemainingMsValue = WAVE_DURATION_MS;

  constructor(
    private readonly projectileManager: ProjectileManager,
    startWave = 1,
  ) {
    this.wave = startWave;
    this.applyWaveConfig();
  }

  get currentWave(): number {
    return this.wave;
  }

  get phase(): WavePhase {
    return this.phaseValue;
  }

  get phaseTimeRemainingMs(): number {
    return this.phaseTimeRemainingMsValue;
  }

  update(delta: number): void {
    this.phaseTimeRemainingMsValue -= delta;
    if (this.phaseTimeRemainingMsValue > 0) {
      return;
    }

    if (this.phaseValue === "active") {
      this.startIntermission();
    } else {
      this.startNextWave();
    }
  }

  private startIntermission(): void {
    this.phaseValue = "intermission";
    this.phaseTimeRemainingMsValue = INTERMISSION_DURATION_MS;
    this.projectileManager.clearAll();
    this.projectileManager.setBasicSpawningEnabled(false);
    this.projectileManager.setZoomerSpawningEnabled(false);
    this.projectileManager.setChaserSpawningEnabled(false);
    this.projectileManager.setStopWaveSpawningEnabled(false);
  }

  private startNextWave(): void {
    this.wave += 1;
    this.phaseValue = "active";
    this.phaseTimeRemainingMsValue = WAVE_DURATION_MS;
    this.applyWaveConfig();
  }

  private applyWaveConfig(): void {
    const scalingWave = Math.min(this.wave, DIFFICULTY_PLATEAU_WAVE);
    const multiplier = 1 + DIFFICULTY_STEP * (scalingWave - 1);
    this.projectileManager.setDifficultyMultiplier(multiplier);

    this.projectileManager.setBasicSpawningEnabled(true);
    this.projectileManager.setZoomerSpawningEnabled(this.wave >= ZOOMER_INTRODUCED_AT_WAVE);
    this.projectileManager.setChaserSpawningEnabled(this.wave >= CHASER_INTRODUCED_AT_WAVE);
    this.projectileManager.setStopWaveSpawningEnabled(this.wave >= STOP_WAVE_INTRODUCED_AT_WAVE);

    // Re-randomize the Safe Lane's sweep speed/direction every wave, so its motion
    // isn't identical wave-to-wave or run-to-run.
    this.projectileManager.rerollSafeLaneMotion();
  }
}
