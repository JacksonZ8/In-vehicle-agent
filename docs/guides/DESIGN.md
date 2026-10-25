# UI Design Language

## Positioning

This prototype should feel like a mature in-vehicle engineering console: precise, dark, dense enough for repeated operation, and centered on the real Three.js vehicle model. The interface supports the car, agent workflow, and vehicle API simulation; it should not compete with the car model or read as a generic blue AI dashboard.

## Six Design Skills Applied

### 1. Impeccable

- Central vehicle model remains the first visual priority.
- Panels use tighter spacing, harder boundaries, and lower glow so the UI looks finished rather than decorative.
- Text hierarchy is compact: small uppercase eyebrows, direct section titles, restrained metric values.
- Bottom controls and scenario buttons have stable dimensions to avoid shifting during state changes.

### 2. Taste Skill

- Avoid large blue gradients, glassmorphism, scanline effects, and broad neon halos.
- Use black, white, and cool gray as the base; reserve electric blue for active system state and yellow for operational emphasis.
- Prefer flat technical surfaces, subtle borders, and simple state contrast over spectacle.
- Keep visual language closer to automotive HMI / engineering workstation than sci-fi command center.

### 3. UI Skills

- Page structure stays modular: telemetry bar, agent panel, vehicle stage, decision panel, voice dock, scenario strip, event timeline.
- Component density is deliberate: repeated cards use small radii, clear borders, and predictable internal rhythm.
- The Three.js vehicle stage is not refactored into alternate renderers or fallback car drawings.
- UI overlays should compress around the vehicle model instead of covering the car body.

### 4. Motion AI Kit

- Preserve Three.js vehicle, component focus, and decomposition motion as the main interaction motion.
- UI motion is limited to fast border/background state changes and calm scenario pulses.
- No attention-grabbing global scanline or exaggerated glow animation.
- Respect reduced-motion preferences with a CSS fallback that minimizes animation.

### 5. Better Icons

- Lightweight symbols and short technical tags are used for component and scenario buttons.
- Vehicle component controls use stable glyphs: body, cabin, battery, window, tailgate, seat, wheels, sensor, chassis, decomposition.
- Scenario shortcuts use domain tags such as `NAV`, `BAT`, `SAFE`, `WIN`, `TAIL`, and `SEAT` for fast scanning.
- Icons are functional identifiers, not decorative emoji.

### 6. DESIGN.md

- This file is the source of truth for the current UI language.
- Future UI changes should update this document when they change color, typography, motion, component density, or vehicle-stage overlay rules.
- Do not describe engineering proxy overlays as original Ferrari movable geometry.

## Color System

- Background: `#050607`, `#080a0c`, `#0d1013`
- Surfaces: `#13171b`, `#191e23`, high-opacity dark panels
- Text: `#f3f6f8` primary, `#96a0a9` muted, `#69737c` secondary metadata
- Active blue: `#55c8ff`, `#1976d2`
- Operational yellow: `#f2c14e`
- Success green: `#7bdca9`
- Warning orange: `#f2a84b`
- Error red: `#ff7066`

Rules:

- Blue is for active system state, focus, and links in the agent pipeline.
- Yellow is for controls, warnings that need attention, and engineering markers.
- Green is for success or local/edge readiness.
- Avoid adding new large gradient families unless there is a clear product reason.

## Typography

- Use system UI fonts with Microsoft YaHei fallback for Chinese.
- Keep letter spacing at zero or near-zero; no negative tracking.
- Eyebrows are small uppercase metadata.
- Section headings should remain compact so dashboard panels do not feel like a landing page.
- Avoid explanatory helper copy inside the app unless it is a real system status or result.

## Layout

- Keep the central vehicle model unobstructed.
- Top pipeline and bottom component controls may sit over the stage, but should stay thin and transparent enough to leave the car readable.
- Side panels are operational: agent state and decision result, not decorative content blocks.
- Cards use low radius, hard edges, and subtle borders.
- Nested card stacks should be avoided unless representing repeated result objects.

## Motion

- Vehicle model motion is primary.
- UI animation should be short, stable, and state-driven.
- Avoid global animated ambience except subtle scenario effects already tied to vehicle mode.
- Reduced-motion media query must remain present.

### Vehicle execution motion truth

- Runtime 的 `submitted / accepted / executing` 只对应明确的 pending 反馈，不得播放“已完成”车辆动画。
- 只有 `observed-succeeded` 且 `confirmedSnapshotId` 匹配 Vehicle State Provider snapshot 时，才播放最终组件动画。
- 最终动画参数只从 snapshot values 投影；requestedState、ToolResult 文案和 ExternalData statePatch 不能充当车辆状态。
- failed、timeout、duplicate 或 Runtime 异常取消当前 commandId 的 pending，并保留上一次 confirmed 视觉状态。
- 同组件新 pending 替换旧 pending；迟到旧终态不得覆盖新命令。不同组件 pending 互不影响。

## Component Rules

- Buttons should have a visible label and a compact symbol/tag.
- Primary action is solid blue, not a shiny gradient.
- Metrics should be scan-friendly and avoid wrapping when possible.
- Event log names use color as status encoding.
- Capability limitation cards use yellow accents to distinguish engineering constraints from normal results.

## Vehicle Model Boundary

- Keep the Three.js GLB vehicle and `VehicleAnimationController` as the source of vehicle motion.
- Do not introduce DOM car, canvas car, procedural vehicle, or fallback rig.
- Existing proxy overlays are engineering visualizations only.
- Future high-fidelity component motion requires a GLB/GLTF with independent named nodes and valid pivots.
