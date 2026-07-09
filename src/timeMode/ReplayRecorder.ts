import { InputSource, InputState } from "../input/PlayerInput";

/** One real frame's worth of raw input, captured during live play - see TimeMainScene's recording loop. Deliberately just the handful of numbers TimePlayer.update() actually reads (moveX/moveY/aimAngle/dashPressed/slashPressed), not a full world-state snapshot - replaying these through the exact same (now-deterministic, see SeededRandom) simulation reconstructs everything else. */
export interface RecordedFrame {
  moveX: number;
  moveY: number;
  aimAngle: number;
  dashPressed: boolean;
  slashPressed: boolean;
  /** The real delta (ms) that frame actually advanced by - replayed as the step's own delta too (see TimeMainScene's replay loop), not whatever delta the replay's own render happens to produce, so movement distances match the original run exactly rather than drifting off variable frame timing. */
  realDelta: number;
}

/**
 * Feeds back a previously-recorded run one frame per read() call, looping
 * back to the start once exhausted - the death-replay's input source, in
 * place of a live PlayerInput. dashHeld/slashHeld are reconstructed as
 * equal to their *Pressed counterparts (TimePlayer.update() never actually
 * reads the Held fields, they're only present to satisfy InputState).
 */
export class RecordedInputSource implements InputSource {
  private index = 0;

  constructor(private readonly frames: RecordedFrame[]) {}

  /** The recorded realDelta for whatever frame the next read() will return - the caller should step the rest of the simulation (arena/TimeManager) by this same value, not its own live frame delta, for the same reason described on RecordedFrame.realDelta. Falls back to a nominal 16ms if nothing was recorded at all. */
  get nextDelta(): number {
    if (this.frames.length === 0) {
      return 16;
    }
    return this.frames[Math.min(this.index, this.frames.length - 1)].realDelta;
  }

  get isExhausted(): boolean {
    return this.frames.length > 0 && this.index >= this.frames.length;
  }

  /** Restarts playback from the first recorded frame - call this (alongside resetting the rest of the simulation) whenever isExhausted, to loop the replay. */
  rewind(): void {
    this.index = 0;
  }

  read(): InputState {
    if (this.frames.length === 0) {
      return { moveX: 0, moveY: 0, aimAngle: 0, dashHeld: false, dashPressed: false, slashHeld: false, slashPressed: false };
    }
    const frame = this.frames[Math.min(this.index, this.frames.length - 1)];
    this.index++;
    return {
      moveX: frame.moveX,
      moveY: frame.moveY,
      aimAngle: frame.aimAngle,
      dashHeld: frame.dashPressed,
      dashPressed: frame.dashPressed,
      slashHeld: frame.slashPressed,
      slashPressed: frame.slashPressed,
    };
  }
}
