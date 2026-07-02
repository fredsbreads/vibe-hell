import Phaser from "phaser";

/** A brief expanding, fading ring - used to mark a projectile's destruction or a hit landing. Self-destroys, not pooled since it's rare/cosmetic. */
export function spawnPop(scene: Phaser.Scene, x: number, y: number, color: number): void {
  const pop = scene.add.circle(x, y, 6, color, 0.85);
  scene.tweens.add({
    targets: pop,
    scale: 3,
    alpha: 0,
    duration: 250,
    ease: "Cubic.Out",
    onComplete: () => pop.destroy(),
  });
}
