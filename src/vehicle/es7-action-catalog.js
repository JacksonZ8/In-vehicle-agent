export const ES7_ACTION_CATALOG_VERSION = "nio-es7-action-catalog@1.0.0";

const BINARY = Object.freeze({ unit: "binary", minimum: 0, maximum: 1, defaultValue: 0 });

const definitions = [
  ["front_left_door_open", "左前门", BINARY, ["左前门", "主驾车门"]],
  ["front_right_door_open", "右前门", BINARY, ["右前门", "副驾车门"]],
  ["rear_left_door_open", "左后门", BINARY, ["左后门"]],
  ["rear_right_door_open", "右后门", BINARY, ["右后门"]],
  ["front_left_window_open", "左前窗", { unit: "percent", minimum: 0, maximum: 100, defaultValue: 0, dedicatedState: true }, ["左前窗", "主驾车窗"]],
  ["front_right_window_open", "右前窗", { unit: "percent", minimum: 0, maximum: 100, defaultValue: 0, dedicatedState: true }, ["右前窗", "副驾车窗"]],
  ["rear_left_window_open", "左后窗", { unit: "percent", minimum: 0, maximum: 100, defaultValue: 0, dedicatedState: true }, ["左后窗"]],
  ["rear_right_window_open", "右后窗", { unit: "percent", minimum: 0, maximum: 100, defaultValue: 0, dedicatedState: true }, ["右后窗"]],
  ["front_left_handle_deploy", "左前门把手", BINARY, ["左前门把手", "主驾门把手"]],
  ["front_right_handle_deploy", "右前门把手", BINARY, ["右前门把手", "副驾门把手"]],
  ["rear_left_handle_deploy", "左后门把手", BINARY, ["左后门把手"]],
  ["rear_right_handle_deploy", "右后门把手", BINARY, ["右后门把手"]],
  ["hood_open", "前舱盖", BINARY, ["前舱盖", "前盖", "引擎盖"]],
  ["tailgate_open", "尾门", { ...BINARY, dedicatedState: true }, ["尾门", "后备箱"]],
  ["front_wheels_steer", "前轮转向", { unit: "degree", minimum: -30, maximum: 30, defaultValue: 0 }, ["前轮", "前轮转向"]],
  ["wheels_roll", "车轮滚动", { ...BINARY, loop: true }, ["车轮", "轮胎"]],
  ["charge_port_open", "充电口", BINARY, ["充电口", "充电口盖"]],
  ["mirror_left_fold", "左后视镜", BINARY, ["左后视镜", "左侧后视镜"]],
  ["mirror_right_fold", "右后视镜", BINARY, ["右后视镜", "右侧后视镜"]],
  ["wipers_sweep", "雨刷", { ...BINARY, loop: true }, ["雨刷", "雨刮", "雨刮器"]],
  ["suspension_raise", "车身高度", { unit: "centimeter", minimum: 0, maximum: 6, defaultValue: 0 }, ["悬架", "车身高度"]],
  ["driver_seat_fore_aft", "主驾前后", { unit: "centimeter", minimum: -14, maximum: 12, defaultValue: 0 }, ["主驾前后", "主驾座椅前后"]],
  ["driver_seat_height", "主驾高度", { unit: "centimeter", minimum: 0, maximum: 8, defaultValue: 0 }, ["主驾高度", "主驾座椅高度"]],
  ["driver_seat_backrest_recline", "主驾靠背", { unit: "degree", minimum: -20, maximum: 5, defaultValue: 0, dedicatedState: true }, ["主驾靠背", "座椅靠背"]],
  ["driver_seat_headrest_height", "主驾头枕", { unit: "centimeter", minimum: 0, maximum: 8, defaultValue: 0 }, ["主驾头枕", "头枕"]],
];

function deepFreeze(value) {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (value && typeof value === "object") Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

export const ES7_ACTION_CATALOG = deepFreeze(Object.fromEntries(definitions.map(([
  id, label, value, aliases,
]) => [id, {
  id,
  clip: id,
  label,
  aliases,
  unit: value.unit,
  minimum: value.minimum,
  maximum: value.maximum,
  defaultValue: value.defaultValue,
  loop: value.loop === true,
  dedicatedState: value.dedicatedState === true,
}])));

export const ES7_GENERIC_ACTION_IDS = Object.freeze(
  Object.values(ES7_ACTION_CATALOG)
    .filter((definition) => !definition.dedicatedState)
    .map((definition) => definition.id),
);

export const ES7_ACTION_GROUPS = deepFreeze({
  mirrors_fold_both: {
    id: "mirrors_fold_both",
    label: "双侧后视镜",
    aliases: ["两个后视镜", "双侧后视镜", "左右后视镜"],
    targets: ["mirror_left_fold", "mirror_right_fold"],
    unit: "binary",
    minimum: 0,
    maximum: 1,
  },
});

export function getEs7ActionDefinition(actionId) {
  return ES7_ACTION_CATALOG[actionId] || ES7_ACTION_GROUPS[actionId] || null;
}

export function isValidEs7ActionValue(definition, value) {
  return Boolean(definition)
    && typeof value === "number"
    && Number.isFinite(value)
    && value >= definition.minimum
    && value <= definition.maximum
    && (definition.unit !== "binary" || value === 0 || value === 1);
}

export function requestedEs7ComponentActionState(actionId, value) {
  const definition = getEs7ActionDefinition(actionId);
  if (!definition || !isValidEs7ActionValue(definition, value)) return null;
  const targets = definition.targets || [definition.id];
  if (targets.some((id) => !ES7_GENERIC_ACTION_IDS.includes(id))) return null;
  return Object.freeze(Object.fromEntries(targets.map((id) => [id, value])));
}

export function normalizeEs7ComponentActionStateById(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length) return null;
  const normalized = {};
  for (const [actionId, actionValue] of entries) {
    if (!ES7_GENERIC_ACTION_IDS.includes(actionId)) return null;
    const definition = ES7_ACTION_CATALOG[actionId];
    if (!isValidEs7ActionValue(definition, actionValue)) return null;
    normalized[actionId] = actionValue;
  }
  return Object.freeze(normalized);
}

export function es7ActionProgress(actionId, value) {
  const definition = ES7_ACTION_CATALOG[actionId];
  if (!definition || !isValidEs7ActionValue(definition, value)) return null;
  return (value - definition.minimum) / (definition.maximum - definition.minimum);
}
