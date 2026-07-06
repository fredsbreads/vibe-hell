import Phaser from "phaser";
import { TitleScene } from "./scenes/TitleScene";
import { MainScene } from "./scenes/MainScene";
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
  physics: {
    default: "arcade",
    arcade: {
      debug: false,
    },
  },
  input: {
    gamepad: true,
  },
  scene: [TitleScene, MainScene],
});
