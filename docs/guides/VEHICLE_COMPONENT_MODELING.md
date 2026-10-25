# Vehicle Component Modeling Guide

## Current Runtime Asset

The HMI loads only the NIO ES7 pair:

- `assets/models/nio-es7/nio-es7-animated.glb`
- `assets/models/nio-es7/nio-es7-component-manifest.json`

The current asset profile is `nio-es7-stage-c-components@1.0.0`. Runtime loading fails closed if the manifest is missing or invalid, required stable nodes are absent, or the 25 expected animation clips are incomplete. The asset is a local development derivative, not official NIO engineering data or production-approved vehicle feedback.

## Repository and Local Asset Boundary

Reusable ES7 modeling scripts, schemas, verifier scripts, the isolated viewer, attribution records, and machine-readable audit metadata remain tracked. Blender scenes and checkpoints, rendered preview images, downloaded source packages, extracted working textures, and intermediate exports stay local and are ignored by Git. The byte-identical final GLB/manifest pair under `vehicle-model-lab/dist/` remains as verifier provenance alongside the HMI runtime pair under `assets/models/nio-es7/`. The old Ferrari experiments and their matching assets are local-only history.

A clean clone can inspect and verify the delivered runtime pair, but does not contain the Blender source scenes or generated lab exports. See `vehicle-model-lab/README.md` and `vehicle-model-lab/THIRD_PARTY_NOTICES.md` before working on the local modeling pipeline or redistributing the asset.

## Component and Animation Contract

The schema in `vehicle-model-lab/schema/es7-components.json` defines stable component IDs and aliases shared by the asset manifest, HMI, and verifier scripts. Moving components must use real mesh nodes and the declared pivots; proxy geometry or an inline manifest fallback is not accepted as a substitute.

Keep the 25 mechanical clips aligned with the manifest. The current profile covers window, tailgate, seat, door, handle, hood, lighting, mirror, wiper, wheel, suspension, and charging-port interactions. HMI completion still depends on a confirming vehicle-state snapshot, not on animation playback alone.

## Verification

The source verification entry points are in `vehicle-model-lab/verify/`, including schema, component, animation, attribution, isolated-viewer, and verifier-failure checks. Main HMI integration checks are in `scripts/verify/`. Their source remains tracked; rendered previews and local Blender checkpoints are not required to run the delivered application.
