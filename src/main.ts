import Phaser from "phaser";
import { TimeTitleScene } from "./scenes/TimeTitleScene";
import { TimeMainScene } from "./scenes/TimeMainScene";
import {
  patchPhaserGamepadPluginSparseArrayBug,
  patchPhaserGamepadPluginStalePadReferenceBug,
} from "./input/phaserGamepadPatch";

patchPhaserGamepadPluginSparseArrayBug();
patchPhaserGamepadPluginStalePadReferenceBug();

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: 800,
  height: 800,
  backgroundColor: "#101014",
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  physics: {
    default: "arcade",
    arcade: {
      debug: false,
    },
  },
  input: {
    gamepad: true,
  },
  scene: [TimeTitleScene, TimeMainScene],
});
