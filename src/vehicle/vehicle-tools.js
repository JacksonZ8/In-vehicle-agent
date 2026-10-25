import { createVehicleToolResult } from "../runtime/agent-schemas.js";
import {
  createVehicleExecution,
  DevCommandRegistry,
  transitionVehicleExecution,
} from "./execution-state-contract.js";
import { expectedVehicleRequestedState } from "./vehicle-command-contract.js";

const DEV_SOURCE = "dev-adapter";

const VEHICLE_COMMANDS = Object.freeze({
  "body.window.setPosition": Object.freeze({
    component: "window",
    hmiSummary: (args) => `${windowZoneLabel(args.zone)}车窗目标开度 ${args.percent}%（模拟执行）`,
    visualScenario: "windowControl",
  }),
  "body.tailgate.open": Object.freeze({
    component: "tailgate",
    hmiSummary: (args) => (args.open !== false
      ? "后备箱开启请求已发送（模拟执行）。"
      : "后备箱关闭请求已发送（模拟执行）。"),
    visualScenario: "trunkControl",
  }),
  "seat.driver.setBackrestAngle": Object.freeze({
    component: "seat",
    hmiSummary: (args) => `主驾座椅靠背已调节到 ${args.angle}°（模拟执行）。`,
    visualScenario: "seatControl",
  }),
  "seat.comfort.setLevel": Object.freeze({
    component: "seat",
    hmiSummary: (args) => `${seatZoneLabel(args.seatZone)}座椅${args.seatMode === "heat" ? "加热" : "通风"}${args.level === 0 ? "已关闭" : `已设为${args.level}挡`}（模拟执行）。`,
    visualScenario: "cabin",
  }),
  "cabin.comfort.applySettings": Object.freeze({
    component: "cabin",
    hmiSummary: (args) => cabinSettingsSummary(args),
    visualScenario: "cabin",
  }),
  "vehicle.component.setState": Object.freeze({
    component: "vehicle-component",
    hmiSummary: (args) => `ES7 组件动作 ${args.actionId} 已更新为 ${args.value}（模拟执行）。`,
    visualScenario: "componentControl",
  }),
  "cabin.climate.setPreset": Object.freeze({
    component: "climate",
    hmiSummary: (args) => cabinSettingsSummary(args),
    visualScenario: "cabin",
  }),
});

function windowZoneLabel(zone) {
  return ({
    front_left: "主驾",
    front_right: "副驾",
    rear_left: "左后",
    rear_right: "右后",
  })[zone] || "";
}

function seatZoneLabel(zone) {
  return ({
    driver: "主驾",
    passenger: "副驾",
    row2_left: "二排左侧",
    row2_right: "二排右侧",
    row3_left: "三排左侧",
    row3_right: "三排右侧",
  })[zone] || "座椅";
}

function cabinSettingsSummary(args = {}) {
  const parts = [];
  if (args.windowTargets?.length) parts.push(`已更新 ${args.windowTargets.length} 扇车窗开度`);
  if (Number.isFinite(args.temperature)) parts.push(`空调 ${args.temperature}°C`);
  if (typeof args.climatePower === "boolean") parts.push(`空调${args.climatePower ? "开启" : "关闭"}`);
  if (args.climateMode) parts.push(`模式 ${args.climateMode}`);
  if (Number.isFinite(args.fanLevel)) parts.push(`风量 ${args.fanLevel} 挡`);
  if (args.airflow) parts.push(`送风 ${args.airflow}`);
  if (args.passengerMode) parts.push(`乘员模式 ${args.passengerMode}`);
  return `${parts.join("，") || "座舱设置已更新"}（仅模拟执行）。`;
}

function toTimestamp(now) {
  return new Date(now()).toISOString();
}

function requireCommandId(commandId) {
  if (!commandId || typeof commandId !== "string") {
    throw new TypeError("commandId is required");
  }
}

export class VehicleTools {
  constructor(config = {}) {
    this.commandRegistry = config.commandRegistry || new DevCommandRegistry(config);
    this.now = config.now || this.commandRegistry.now || (() => Date.now());
  }

  async execute(toolCall) {
    requireCommandId(toolCall?.commandId);
    if (toolCall.tool === "safety.reject") return this.reject(toolCall);

    const command = VEHICLE_COMMANDS[toolCall.tool];
    if (!command) {
      return this.reject({
        ...toolCall,
        args: {
          reason: `未知工具 ${toolCall.tool}`,
          alternative: "请改用已支持的车控或规划指令。",
        },
        rejectionCode: "unknown-tool",
        rejectionStage: "routing",
      });
    }
    return this.executeVehicleCommand(toolCall, command);
  }

  executeVehicleCommand(toolCall, command) {
    const { requestId, commandId, tool, args = {} } = toolCall;
    const requestedState = expectedVehicleRequestedState(toolCall);
    if (!requestedState) {
      return this.reject({
        ...toolCall,
        args: {
          reason: "车辆组件动作或目标值无效。",
          alternative: "请使用已支持的 ES7 组件动作和范围内数值。",
        },
        rejectionCode: "invalid-component-action",
        rejectionStage: "validation",
      });
    }
    const timestamp = toTimestamp(this.now);
    let execution = createVehicleExecution({
      requestId,
      commandId,
      tool,
      requestedState,
      source: DEV_SOURCE,
      at: timestamp,
    });

    if (!this.commandRegistry.register(commandId)) {
      execution = transitionVehicleExecution(execution, "duplicate-command", {
        source: DEV_SOURCE,
        at: timestamp,
        traceData: { component: command.component },
      });
    } else if (this.commandRegistry.timeoutCommandIds?.has(commandId)) {
      execution = transitionVehicleExecution(execution, "timeout", {
        source: DEV_SOURCE,
        at: timestamp,
        traceData: { component: command.component },
        error: {
          code: "dev-adapter-timeout",
          message: `commandId ${commandId} 在开发适配器中模拟超时`,
          stage: "submission",
          retryable: true,
        },
      });
    } else {
      execution = transitionVehicleExecution(execution, "accepted", {
        source: DEV_SOURCE,
        at: timestamp,
        traceData: { component: command.component },
      });
    }

    const executionError = execution.executionError || (execution.executionState === "duplicate-command"
      ? {
        code: "duplicate-command",
        message: `重复 commandId ${commandId}`,
        stage: "adapter-begin",
        retryable: false,
      }
      : undefined);

    return createVehicleToolResult({
      requestId,
      commandId,
      tool,
      ok: execution.executionState === "accepted",
      executionState: execution.executionState,
      requestedState: execution.requestedState,
      executionTrace: execution.executionTrace,
      executionError,
      hmiSummary: execution.executionState === "accepted"
        ? command.hmiSummary(args)
        : this.executionFailureSummary(execution),
      visualScenario: command.visualScenario,
      source: DEV_SOURCE,
      simulated: true,
      timestamp,
    });
  }

  executionFailureSummary(execution) {
    if (execution.executionState === "duplicate-command") {
      return `重复 commandId ${execution.commandId}，开发适配器未重复执行车辆动作。`;
    }
    return `${execution.executionError.message}。开发适配器未执行车辆动作。`;
  }

  reject({ requestId, commandId, tool, args = {}, rejectionCode = "safety-rejected", rejectionStage = "safety" }) {
    requireCommandId(commandId);
    const timestamp = toTimestamp(this.now);
    const reason = args.reason || "车辆控制请求被拒绝";
    const alternative = args.alternative || "请保持当前状态。";
    const execution = transitionVehicleExecution(createVehicleExecution({
      requestId,
      commandId,
      tool: tool || "safety.reject",
      source: DEV_SOURCE,
      at: timestamp,
    }), "failed", {
      source: DEV_SOURCE,
      at: timestamp,
      traceData: { component: rejectionStage },
      error: {
        code: rejectionCode,
        message: reason,
        stage: rejectionStage,
        retryable: false,
      },
    });
    return createVehicleToolResult({
      requestId,
      commandId,
      tool: tool || "safety.reject",
      ok: false,
      executionState: execution.executionState,
      executionTrace: execution.executionTrace,
      executionError: execution.executionError,
      hmiSummary: `${reason} ${alternative}`,
      visualScenario: "blocked",
      source: DEV_SOURCE,
      simulated: false,
      timestamp,
    });
  }
}
