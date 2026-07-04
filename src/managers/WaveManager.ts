import { ProjectileManager } from "./ProjectileManager";

const WAVE_DURATION_MS = 45000;
const INTERMISSION_DURATION_MS = 3000;

const DIFFICULTY_STEP = 0.15;
const DIFFICULTY_PLATEAU_PACE_STEP = 10;

/** Waves at which each harder threat type first joins the fight - basic is always active from wave 1. */
const ZOOMER_INTRODUCED_AT_WAVE = 2;
const CHASER_INTRODUCED_AT_WAVE = 4;
const STOP_WAVE_INTRODUCED_AT_WAVE = 6;
const INTRODUCTION_WAVES = [ZOOMER_INTRODUCED_AT_WAVE, CHASER_INTRODUCED_AT_WAVE, STOP_WAVE_INTRODUCED_AT_WAVE];

/** Stop Wave stays capped at one on screen at a time until pace has plateaued, then a second can appear. */
const STOP_WAVE_INCREASED_CONCURRENCY_WAVE = 12;

export type WavePhase = "active" | "intermission";

/**
 * Drives the GDD's core progression loop: 45s of active survival, then a
 * 3s "Breather Window" intermission that wipes the field and shows a
 * completion banner, before the next (harder) wave begins. Difficulty scales
 * along two independent axes so a single wave transition never does both at
 * once: a spawn-frequency "pace" that steps up +15% on every wave except the
 * ones where a new threat type is introduced (those waves hold pace steady),
 * plateauing after 10 pace steps; and the threat roster itself, which grows
 * on its own schedule (Zoomer at wave 2, Chaser at wave 4, Stop Wave at wave 6).
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
    const paceStep = Math.min(this.paceStepForWave(this.wave), DIFFICULTY_PLATEAU_PACE_STEP);
    const multiplier = 1 + DIFFICULTY_STEP * (paceStep - 1);
    this.projectileManager.setDifficultyMultiplier(multiplier);

    this.projectileManager.setBasicSpawningEnabled(true);
    this.projectileManager.setZoomerSpawningEnabled(this.wave >= ZOOMER_INTRODUCED_AT_WAVE);
    this.projectileManager.setChaserSpawningEnabled(this.wave >= CHASER_INTRODUCED_AT_WAVE);
    this.projectileManager.setStopWaveSpawningEnabled(this.wave >= STOP_WAVE_INTRODUCED_AT_WAVE);
    this.projectileManager.setStopWaveMaxConcurrent(this.wave >= STOP_WAVE_INCREASED_CONCURRENCY_WAVE ? 2 : 1);

    // Re-randomize the Safe Lane's sweep speed/direction every wave, so its motion
    // isn't identical wave-to-wave or run-to-run.
    this.projectileManager.rerollSafeLaneMotion();
  }

  /**
   * Pace advances by one step per wave, except on waves that introduce a new
   * threat type - those hold the previous wave's pace so the roster grows
   * without a simultaneous frequency bump.
   */
  private paceStepForWave(wave: number): number {
    const introWavesSoFar = INTRODUCTION_WAVES.filter((introWave) => introWave <= wave).length;
    return 1 + wave - introWavesSoFar;
  }
}
