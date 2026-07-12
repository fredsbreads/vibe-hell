import Phaser from "phaser";

/**
 * A brief punch-in-then-expanding, fading ring - used to mark a projectile's
 * destruction or a hit landing. Self-destroys, not pooled since it's
 * rare/cosmetic. The quick overshoot at the start (0.4 -> 1.4 scale in 70ms,
 * "Back.Out") is what sells it as an impact rather than just a fade - the
 * slower expand-and-fade that follows is the same as before.
 *
 * scale multiplies the base radius (6px) - lets a caller make a kill read as
 * bigger/more violent without changing the animation shape itself, e.g. a
 * deflected projectile's chain-kill scaling with chain length (see
 * TimeManager.chainJuiceScale). Defaults to 1, identical to the original
 * fixed-size pop.
 */
export function spawnPop(scene: Phaser.Scene, x: number, y: number, color: number, scale = 1): void {
  const pop = scene.add.circle(x, y, 6 * scale, color, 0.85);
  pop.setScale(0.4);
  scene.tweens.add({
    targets: pop,
    scale: 1.4,
    duration: 70,
    ease: "Back.Out",
    onComplete: () => {
      scene.tweens.add({
        targets: pop,
        scale: 3,
        alpha: 0,
        duration: 200,
        ease: "Cubic.Out",
        onComplete: () => pop.destroy(),
      });
    },
  });
}
