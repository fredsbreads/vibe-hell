export type AimMode = "free" | "movement";

const AIM_MODE_STORAGE_KEY = "vibehell.aimMode";

/**
 * "free" aims with the right stick (or mouse, if no gamepad is connected).
 * "movement" aims wherever you're currently moving instead, so Slash needs
 * no separate aim input at all - the game becomes fully playable with just
 * WASD + Space (dash) + J (slash), no mouse or right stick required.
 * Persisted to localStorage so the choice survives page reloads, not just
 * scene restarts.
 */
export function getAimMode(): AimMode {
  return localStorage.getItem(AIM_MODE_STORAGE_KEY) === "movement" ? "movement" : "free";
}

export function toggleAimMode(): AimMode {
  const next: AimMode = getAimMode() === "free" ? "movement" : "free";
  localStorage.setItem(AIM_MODE_STORAGE_KEY, next);
  return next;
}
