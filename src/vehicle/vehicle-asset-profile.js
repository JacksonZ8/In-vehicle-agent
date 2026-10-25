export const VEHICLE_ASSET_PROFILE = Object.freeze({
  id: "nio-es7-stage-c-components@1.0.0",
  profileMode: "local-dev",
  productionApproved: false,
  assetIdentity: {
    label: "NIO ES7 组件动画 GLB",
    baseAsset: "assets/models/nio-es7/nio-es7-animated.glb",
    derivedAsset: "assets/models/nio-es7/nio-es7-animated.glb",
    sourceVehicleClaim: "nio-es7-2023-cc-by-derivative",
    nioOriginalGeometry: true,
  },
  source: {
    modelSources: Object.freeze([
      "./assets/models/nio-es7/nio-es7-animated.glb",
    ]),
    componentManifestPath: "./assets/models/nio-es7/nio-es7-component-manifest.json",
    pipeline: "ES7 stable-node/clip manifest",
  },
  defaultComponentManifest: Object.freeze({
    body: Object.freeze({
      required: true,
      aliases: Object.freeze(["body_static"]),
      feedback: "original_mesh_highlight",
    }),
    bodyGlass: Object.freeze({
      required: false,
      aliases: Object.freeze(["es7_glass"]),
      feedback: "original_mesh_highlight",
    }),
    cabinInterior: Object.freeze({
      required: false,
      aliases: Object.freeze(["driver_seat_track_static", "passenger_seat_static"]),
      feedback: "original_mesh_highlight",
    }),
    rearLights: Object.freeze({
      required: false,
      aliases: Object.freeze(["rear_tail_fixed_left", "rear_tail_fixed_right"]),
      feedback: "original_mesh_highlight",
    }),
    wheels: Object.freeze({
      required: false,
      aliases: Object.freeze(["wheel_front_left_spin", "wheel_front_right_spin", "wheel_rear_left_spin", "wheel_rear_right_spin"]),
      feedback: "original_mesh_highlight",
    }),
    frontLeftWindow: Object.freeze({
      required: true,
      aliases: Object.freeze(["front_left_window_slider"]),
    }),
    frontRightWindow: Object.freeze({
      required: true,
      aliases: Object.freeze(["front_right_window_slider"]),
    }),
    tailgate: Object.freeze({
      required: true,
      aliases: Object.freeze(["tailgate_pivot"]),
    }),
    driverSeatBackrest: Object.freeze({
      required: true,
      aliases: Object.freeze(["driver_seat_backrest_pivot"]),
    }),
    sensorModule: Object.freeze({
      required: false,
      aliases: Object.freeze(["sensor_module", "roof_sensor", "lidar", "aquila_sensor"]),
      feedback: "engineering_optional",
    }),
    batteryPack: Object.freeze({
      required: false,
      aliases: Object.freeze(["battery_pack", "battery", "traction_battery", "battery_module"]),
      feedback: "engineering_optional",
    }),
    chassis: Object.freeze({
      required: false,
      aliases: Object.freeze(["chassis", "underbody", "skateboard", "frame"]),
      feedback: "engineering_optional",
    }),
  }),
  fidelity: {
    geometry: "nio-es7-2023-cc-by-derivative",
    componentBinding: "stable-node-plus-25-animation-clips",
    realVehicleExecutionFeedback: false,
  },
  license: {
    boundary: "cc-by-4.0-attribution-required",
    publicReleaseApproved: false,
    commercialUseApproved: false,
  },
  manifestPolicy: {
    fallbackAllowed: false,
    fallbackMode: "disabled-for-es7-runtime-manifest",
    productionFailClosed: true,
  },
});

export function canFallbackToInlineManifest(profile = VEHICLE_ASSET_PROFILE) {
  return profile.profileMode === "local-dev" && profile.manifestPolicy?.fallbackAllowed === true;
}
