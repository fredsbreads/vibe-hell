export type AimMode = "free" | "virtualStick" | "movement";

const AIM_MODE_STORAGE_KEY = "vibehell.aimMode";
const AIM_MODE_CYCLE: AimMode[] = ["free", "virtualStick", "movement"];

/**
 * "free" aims with the right stick (or mouse relative to the player, if no
 * gamepad is connected). "virtualStick" aims with the mouse relative to a
 * fixed on-screen anchor instead of the player's (moving) position - like a
 * real analog stick mapped onto the mouse, so the same mouse position always
 * means the same aim direction regardless of where the player currently is
 * on screen. "movement" aims wherever you're currently moving instead, so
 * Slash needs no separate aim input at all - fully playable with just WASD +
 * Space (dash) + J (slash), no mouse or right stick required.
 * Persisted to localStorage so the choice survives page reloads, not just
 * scene restarts.
 */
export function getAimMode(): AimMode {
  const stored = localStorage.getItem(AIM_MODE_STORAGE_KEY);
  return (AIM_MODE_CYCLE as string[]).includes(stored ?? "") ? (stored as AimMode) : "free";
}

const SHOW_SLASH_RANGE_STORAGE_KEY = "vibehell.showSlashRange";

/** Whether the persistent Slash-range wedge outline (see TimePlayer.redrawSlashRangeIndicator) is drawn at all - some players find it clutters the view now that they know the range by feel. Defaults to on (the original always-visible behavior) so existing players see no change unless they opt out. */
export function getShowSlashRangeIndicator(): boolean {
  return localStorage.getItem(SHOW_SLASH_RANGE_STORAGE_KEY) !== "false";
}

export function setShowSlashRangeIndicator(value: boolean): void {
  localStorage.setItem(SHOW_SLASH_RANGE_STORAGE_KEY, value ? "true" : "false");
}
