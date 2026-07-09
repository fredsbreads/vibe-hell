/**
 * Core hook of this mode: the world (enemies, hostile projectiles, deflected
 * projectiles once their initial burst ends) only advances as fast as the
 * player is currently moving the left stick - stand still and everything
 * gets close to frozen, push the stick and time speeds back up. The
 * player's own movement/aim/action-triggers are never scaled by this - only
 * "the world" is.
 *
 * Driven by the RAW stick tilt magnitude (moveX/moveY straight from
 * PlayerInput, already deadzone-applied), not the player's actual resulting
 * velocity - using resulting velocity would mean pushing into a wall (fully
 * tilted stick, but clipped/zero net displacement) accidentally freezes the
 * world despite the player clearly trying to move.
 */

/**
 * Never quite zero at full rest - matches SUPERHOT's own idle behavior
 * (close to frozen, not literally frozen), so there's still a way to
 * progress by waiting alone, just an extremely slow one. Also means
 * world-time-gated cooldowns (Dash lockout, Slash cooldown) aren't
 * permanently stuck if a player never moves at all.
 */
export const MIN_WORLD_TIMESCALE = 0.02;

export function computeWorldTimescale(moveX: number, moveY: number): number {
  const magnitude = Math.hypot(moveX, moveY);
  return Math.max(MIN_WORLD_TIMESCALE, Math.min(1, magnitude));
}
