import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildVehicleKnowledgeContext,
  buildVehicleKnowledgeFallback,
  findVehicleKnowledgeSeeds,
  getVehicleKnowledgeApplicability,
  isVehicleKnowledgeTopic,
  VEHICLE_KNOWLEDGE_RETRIEVAL_POLICY,
  vehicleKnowledgeRecommendations,
} from "../../src/external-data/vehicle-knowledge.js";

const serverSource = await readFile(new URL("../../src/server/local-agent-server.mjs", import.meta.url), "utf8");
const vehicleKnowledgeSource = await readFile(new URL("../../src/external-data/vehicle-knowledge.js", import.meta.url), "utf8");

assert.match(serverSource, /from "\.\.\/external-data\/vehicle-knowledge\.js"/, "local-agent-server must import shared vehicle knowledge module");
assert.match(serverSource, /getVehicleKnowledgeApplicability/, "local-agent-server must check vehicle knowledge applicability before LLM");
assert.match(serverSource, /provider: "local-boundary"/, "local-agent-server must have deterministic OOD boundary provider");
assert.match(serverSource, /vehicle-knowledge-seed-not-applicable/, "local-agent-server must tag OOD vehicle knowledge boundary reason");
assert.doesNotMatch(serverSource, /vehicleKnowledgePath/, "local-agent-server must not maintain a second vehicle knowledge JSON path");
assert.doesNotMatch(serverSource, /function findVehicleKnowledgeSeeds/, "local-agent-server must not maintain duplicate seed scoring");
assert.doesNotMatch(serverSource, /text\.includes\(normalizedPattern\).*total \+ 4/s, "server must not restore hidden exact-match weight");

assert.equal(VEHICLE_KNOWLEDGE_RETRIEVAL_POLICY.id, "nio-vehicle-knowledge-seed-retrieval");
assert.equal(VEHICLE_KNOWLEDGE_RETRIEVAL_POLICY.version, "1.0.0");
assert.equal(VEHICLE_KNOWLEDGE_RETRIEVAL_POLICY.exactPatternWeight, 4);
assert.equal(VEHICLE_KNOWLEDGE_RETRIEVAL_POLICY.tokenMatchWeight, 1);
assert.equal(VEHICLE_KNOWLEDGE_RETRIEVAL_POLICY.defaultLimit, 3);
assert.match(vehicleKnowledgeSource, /VEHICLE_KNOWLEDGE_RETRIEVAL_POLICY\.exactPatternWeight/);
assert.match(vehicleKnowledgeSource, /VEHICLE_KNOWLEDGE_RETRIEVAL_POLICY\.tokenMatchWeight/);
assert.match(vehicleKnowledgeSource, /VEHICLE_KNOWLEDGE_RETRIEVAL_POLICY\.defaultLimit/);

const es6Applicability = getVehicleKnowledgeApplicability("NIO ES6 的中控屏多大？");
assert.equal(es6Applicability.status, "applicable");
assert.equal(es6Applicability.model, "ES6");
assert.ok(findVehicleKnowledgeSeeds("NIO ES6 的中控屏多大？").length >= 1);
assert.match(buildVehicleKnowledgeContext("NIO ES6 的中控屏多大？"), /nio-vehicle-knowledge-seed-retrieval@1\.0\.0/);

const assumedApplicability = getVehicleKnowledgeApplicability("NOMI Mate 是什么？");
assert.equal(assumedApplicability.status, "assumed-local-dev");
assert.equal(isVehicleKnowledgeTopic({}, "NOMI Mate 是什么？"), true);

for (const query of ["蔚来 ET5 的中控屏多大？", "ES8 的儿童锁怎么用？", "特斯拉 Model Y 后备箱多大？"]) {
  const applicability = getVehicleKnowledgeApplicability(query);
  assert.equal(applicability.status, "not-applicable", `${query}: explicit non-ES6 model must be not-applicable`);
  assert.deepEqual(findVehicleKnowledgeSeeds(query), [], `${query}: non-applicable model must not retrieve ES6 seed answers`);
  const fallback = buildVehicleKnowledgeFallback(query);
  assert.match(fallback, /不能把它套用到/, `${query}: fallback must not apply ES6 seed`);
  assert.doesNotMatch(fallback, /15\.6 英寸|NIO ES6 是蔚来的智能电动 SUV/, `${query}: fallback must not answer with ES6 facts`);
  assert.match(buildVehicleKnowledgeContext(query), /适用性：not-applicable/, `${query}: context must expose not-applicable boundary`);
}

const recommendations = vehicleKnowledgeRecommendations();
assert.ok(recommendations.some((item) => /NIO ES6/.test(item)));
assert.ok(recommendations.some((item) => /不是完整官方用户手册/.test(item)));

console.log(JSON.stringify({
  ok: true,
  policy: {
    id: VEHICLE_KNOWLEDGE_RETRIEVAL_POLICY.id,
    version: VEHICLE_KNOWLEDGE_RETRIEVAL_POLICY.version,
    defaultLimit: VEHICLE_KNOWLEDGE_RETRIEVAL_POLICY.defaultLimit,
  },
  applicability: {
    es6: es6Applicability.status,
    assumed: assumedApplicability.status,
    explicitOtherModel: "not-applicable",
  },
}, null, 2));
