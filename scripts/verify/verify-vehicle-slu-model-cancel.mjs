import assert from "node:assert/strict";
import { RoutePolicy } from "../../src/application/route-policy.js";
import { RuntimeKernel } from "../../src/application/runtime-kernel.js";
import { PendingClarificationStore } from "../../src/runtime/pending-clarification-store.js";
import { compactVehicleSluEnvelope, expandVehicleSluCompact } from "../../src/semantic/vehicle-slu-compact.js";
import { projectVehicleSluPendingSummary } from "../../src/semantic/vehicle-slu-prompt.js";
import { auditVehicleSluUxRouteCompatibility, projectVehicleSluUxMetrics } from "../benchmarks/evaluate-vehicle-slu-ux.mjs";
import { buildVehicleSluCompactV9Prompt } from "../../src/semantic/vehicle-slu-compact-v9.js";

const pending = {taskId:"synthetic-task", intent:"body.window.setPosition", acceptedSlots:{zone:"rear_right"}, missingSlots:["percent"], slotProvenance:{zone:"original-turn"}, clarificationQuestion:"开度是多少？", originalUtterance:"将后侧右窗调一下"};
const compact = {d:"vehicle", n:"explain", c:"cancel_pending", f:[]};
assert.deepEqual(projectVehicleSluPendingSummary(pending).acceptedSlotValues,{zone:"rear_right"});
assert.deepEqual(projectVehicleSluPendingSummary({...pending,acceptedSlots:{zone:"arbitrary"}}).acceptedSlotValues,{});
assert.match(buildVehicleSluCompactV9Prompt({text:"some text",pending}),/"acceptedSlotValues":\{"zone":"rear_right"\}/);
const envelope = expandVehicleSluCompact(compact, {requestId:"synthetic-cancel", text:"模型已明确撤回"});
assert.deepEqual(compactVehicleSluEnvelope(envelope), compact);
for (const invalid of [{...compact,c:"execute"}, {...compact,d:"non_vehicle"}, {...compact,n:"none"}, {...compact,f:[{i:"body.tailgate.open",s:"command",a:"execute",p:{open:true}}]}]) {
  assert.throws(() => expandVehicleSluCompact(invalid,{requestId:"invalid"}));
}
let calls = 0;
const policy = new RoutePolicy({localModel:{parse:async()=>{calls += 1;return{semanticEnvelope:envelope};}}});
const route = await policy.resolve("没有任何取消关键词",{requestId:"synthetic-cancel",pending});
assert.equal(calls,1);
assert.equal(route.decision.disposition,"cancel");
assert.equal(route.decision.routeId,null);
assert.equal(route.clarificationTransition.action,"cancel");
const store = new PendingClarificationStore();
store.set("test",pending);
RuntimeKernel.prototype.applyClarificationTransition.call({pendingClarifications:store,assertPendingRunCurrent(){}},{sessionId:"test",transition:route.clarificationTransition});
assert.equal(store.get("test"),null);

const ordinary = expandVehicleSluCompact({d:"vehicle",n:"explain",f:[]},{requestId:"ordinary"});
const noSignal = new RoutePolicy({localModel:{parse:async()=>({semanticEnvelope:ordinary})}});
const preserved = await noSignal.resolve("取消这次请求",{requestId:"ordinary",pending});
assert.equal(preserved.clarificationTransition.action,"preserve");
assert.notEqual(preserved.decision.disposition,"cancel");
console.log("PASS: model-only pending cancellation, invalid signal rejection, and actual store clearing");

const openExpected = {domain:"vehicle", conversationNeed:"none", frames:[{intent:"body.window.setPosition",actionNeed:"clarify",slots:{zone:"rear_right"},missingSlots:["percent"]}], route:{disposition:"clarify",routeId:null}};
const cancelExpected = {domain:"vehicle", conversationNeed:"explain", dialogueAction:"cancel_pending", frames:[],route:{disposition:"cancel",routeId:null}};
const fixture = {contractVersion:"vehicle-slu-ux@1.0.0",datasetVersion:"synthetic-dialogue@1",split:"development",labelReviewStatus:"draft",cases:[{id:"synthetic-dialogue",category:"incomplete-control",labelReviewStatus:"draft",source:{author:"synthetic",method:"unit-test",secondReviewer:"none"},closureRequired:false,closureTurn:null,turns:[{text:"synthetic first",expected:openExpected},{text:"synthetic second",expected:cancelExpected}]}]};
const compatibility = await auditVehicleSluUxRouteCompatibility(fixture);
assert.equal(compatibility.turnCount,2);
assert.equal(compatibility.compatibleTurnCount,2);
const metricCase = {id:"metric-cancel",turns:[{expected:cancelExpected,result:{status:"ok",rawDomain:"vehicle",domain:"vehicle",rawConversationNeed:"explain",conversationNeed:"explain",rawFrames:[],effectiveFrames:[],route:{disposition:"respond",routeId:null},latencyMs:1,modelInvocations:1}}],result:{}};
const metrics = projectVehicleSluUxMetrics([metricCase]);
assert.equal(metrics.intentCapture.numerator,0);
assert.equal(metrics.preRouteIntentCapture.numerator,0);
assert.equal(metrics.modelIntentCapture.numerator,0);
console.log("PASS: cancellation expectation bridge and absent-signal intent scoring");
