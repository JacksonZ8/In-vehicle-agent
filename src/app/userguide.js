const DEFAULT_SOURCE_ID = "nio-es8-user-manual-2026";
const EMPTY_EVIDENCE = Object.freeze([]);
const QUERY_KEYS = Object.freeze(["source", "chunk", "run"]);
const EVIDENCE_REF_FIELDS = Object.freeze([
  "sourceId",
  "sourceVersion",
  "chunkId",
  "pageStart",
  "pageEnd",
  "excerpt",
  "score",
]);
const EVIDENCE_SCORE_FIELDS = Object.freeze(["retrieval", "rerank", "grounding"]);
const HIGHLIGHT_FIELDS = Object.freeze(["chunkId", "pageStart", "pageEnd", "excerpt", "locations"]);
const LOCATION_FIELDS = Object.freeze(["pageNumber", "start", "end"]);

export function createUserGuideState() {
  return freezeState({
    document: null,
    evidenceRefs: EMPTY_EVIDENCE,
    activeChunkId: null,
    drawerExpanded: false,
  });
}

export function reduceUserGuideState(state, event = {}) {
  const current = isRecord(state) ? state : createUserGuideState();
  if (!isRecord(event)) return current;
  if (event.type === "load-failed") return createUserGuideState();
  if (event.type === "clear-active") {
    return freezeState({ ...current, activeChunkId: null });
  }
  if (event.type === "set-drawer-expanded") {
    return freezeState({ ...current, drawerExpanded: event.expanded === true });
  }
  if (event.type !== "document-loaded") return current;
  const evidenceRefs = Array.isArray(event.evidenceRefs)
    ? Object.freeze([...event.evidenceRefs])
    : EMPTY_EVIDENCE;
  return freezeState({
    document: event.document || null,
    evidenceRefs,
    activeChunkId: typeof event.activeChunkId === "string" ? event.activeChunkId : null,
    drawerExpanded: event.keepDrawerExpanded === true && evidenceRefs.length > 0,
  });
}

export function createLatestSelectionGeneration() {
  let current = 0;
  return Object.freeze({
    begin() {
      current += 1;
      return current;
    },
    isCurrent(generation) {
      return generation === current;
    },
  });
}

export function resolveReturnToConsoleAction({ origin, referrer, historyLength } = {}) {
  const sameOriginHistory = Number.isInteger(historyLength)
    && historyLength > 1
    && isSameOriginReferrer(referrer, origin);
  return sameOriginHistory ? "history-back" : "close-or-root";
}

export function returnToConsole(windowRef) {
  if (!isRecord(windowRef)) throw new TypeError("returnToConsole requires a window-like object");
  const action = resolveReturnToConsoleAction({
    origin: windowRef.location?.origin,
    referrer: windowRef.document?.referrer,
    historyLength: windowRef.history?.length,
  });
  if (action === "history-back" && typeof windowRef.history?.back === "function") {
    windowRef.history.back();
    return action;
  }

  if (typeof windowRef.close === "function") windowRef.close();
  const fallback = () => {
    if (windowRef.closed !== true && typeof windowRef.location?.assign === "function") {
      windowRef.location.assign("/");
    }
  };
  if (typeof windowRef.setTimeout === "function") windowRef.setTimeout(fallback, 0);
  else fallback();
  return "close-or-root";
}

function isSameOriginReferrer(referrer, origin) {
  try {
    if (!nonEmptyString(referrer) || !nonEmptyString(origin)) return false;
    return new URL(referrer).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

function freezeState(value) {
  return Object.freeze(value);
}

function parsePageRequest(locationLike) {
  const url = new URL(locationLike.href);
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => !QUERY_KEYS.includes(key))) return invalidRequest();
  if (keys.some((key) => url.searchParams.getAll(key).length !== 1)) return invalidRequest();
  if (keys.length === 0) {
    return Object.freeze({ mode: "browse", sourceId: DEFAULT_SOURCE_ID, chunkId: null, runId: null });
  }
  if (keys.length === 1 && url.searchParams.has("source")) {
    const sourceId = url.searchParams.get("source");
    return nonEmptyString(sourceId)
      ? Object.freeze({ mode: "browse", sourceId, chunkId: null, runId: null })
      : invalidRequest();
  }
  if (keys.length === 3 && QUERY_KEYS.every((key) => url.searchParams.has(key))) {
    const sourceId = url.searchParams.get("source");
    const chunkId = url.searchParams.get("chunk");
    const runId = url.searchParams.get("run");
    return [sourceId, chunkId, runId].every(nonEmptyString)
      ? Object.freeze({ mode: "target", sourceId, chunkId, runId })
      : invalidRequest();
  }
  return invalidRequest();
}

function invalidRequest() {
  const error = new Error("invalid user guide link");
  error.code = "invalid-link";
  throw error;
}

function apiPathFor(request) {
  const params = new URLSearchParams({ source: request.sourceId });
  if (request.mode === "target") {
    params.set("chunk", request.chunkId);
    params.set("run", request.runId);
  }
  return `/api/userguide?${params.toString()}`;
}

async function fetchUserGuide(request, fetchImpl, origin, expectedEvidenceRefs = null) {
  const requestPath = apiPathFor(request);
  const response = await fetchImpl(requestPath, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!response?.ok) {
    let code = "userguide-request-failed";
    try {
      const body = await response.json();
      if (nonEmptyString(body?.error?.code)) code = body.error.code;
    } catch {
      // HTTP status remains the authority when an error body is not JSON.
    }
    const error = new Error(`user guide HTTP ${response?.status ?? "unknown"}`);
    error.code = code;
    throw error;
  }
  if (!isExpectedApiResponse(response.url, origin, request)) {
    const error = new Error("unexpected user guide response URL");
    error.code = "invalid-response";
    throw error;
  }
  let body;
  try {
    body = await response.json();
  } catch {
    const error = new Error("invalid user guide JSON");
    error.code = "invalid-response";
    throw error;
  }
  return request.mode === "browse"
    ? validateBrowseDocument(body, request, origin)
    : validateTargetDocument(body, request, origin, expectedEvidenceRefs);
}

function isExpectedApiResponse(responseUrl, origin, request) {
  try {
    const actual = new URL(responseUrl, origin);
    const expected = new URL(apiPathFor(request), origin);
    return actual.origin === expected.origin
      && actual.pathname === expected.pathname
      && actual.hash === ""
      && exactSearchParams(actual.searchParams, expected.searchParams);
  } catch {
    return false;
  }
}

function exactSearchParams(actual, expected) {
  const actualKeys = [...actual.keys()];
  const expectedKeys = [...expected.keys()];
  return actualKeys.length === expectedKeys.length
    && new Set(actualKeys).size === actualKeys.length
    && expectedKeys.every((key) => actual.get(key) === expected.get(key));
}

function validateBrowseDocument(value, request, origin) {
  if (!isRecord(value)
    || Object.hasOwn(value, "currentEvidence")
    || Object.hasOwn(value, "evidence")
    || Object.hasOwn(value, "highlight")) return invalidResponse();
  const source = validateSource(value.source, request.sourceId);
  const pages = validatePages(value.pages, source.sourceId);
  const pdfHref = validatePdfUrl(value.pdfUrl, source.sourceId, origin);
  return Object.freeze({ mode: "browse", source, pages, pdfHref, currentEvidence: null });
}

function validateTargetDocument(value, request, origin, expectedEvidenceRefs) {
  if (!isRecord(value)) return invalidResponse();
  const source = validateSource(value.source, request.sourceId);
  const pages = validatePages(value.pages, source.sourceId);
  const currentEvidence = validateEvidenceRef(value.currentEvidence);
  const evidenceRefs = Array.isArray(value.evidence)
    ? value.evidence.map(validateEvidenceRef)
    : invalidResponse();
  const highlight = validateHighlight(value.highlight, currentEvidence, pages);
  if (!evidenceRefs.length
    || currentEvidence.sourceId !== source.sourceId
    || currentEvidence.sourceVersion !== source.sourceVersion
    || currentEvidence.chunkId !== request.chunkId
    || duplicateEvidence(evidenceRefs)
    || !evidenceRefs.some((ref) => sameEvidence(ref, currentEvidence))
    || !pagesMatchEvidence(pages, currentEvidence)) {
    return invalidResponse();
  }
  if (expectedEvidenceRefs && !sameEvidenceList(evidenceRefs, expectedEvidenceRefs)) {
    return invalidResponse();
  }
  const pdfPath = validatePdfUrl(value.pdfUrl, source.sourceId, origin);
  return Object.freeze({
    mode: "target",
    source,
    pages,
    pdfHref: `${pdfPath}#page=${currentEvidence.pageStart}`,
    currentEvidence,
    evidenceRefs: Object.freeze(evidenceRefs),
    highlight,
  });
}

function validateSource(value, expectedSourceId) {
  if (!isRecord(value)
    || value.sourceId !== expectedSourceId
    || !nonEmptyString(value.sourceVersion)
    || !/^sha256:[a-f0-9]{64}$/iu.test(value.contentDigest)
    || typeof value.title !== "string"
    || typeof value.model !== "string"
    || !Array.isArray(value.applicableModels)
    || !value.applicableModels.every((model) => typeof model === "string")) {
    return invalidResponse();
  }
  return Object.freeze({
    sourceId: value.sourceId,
    sourceVersion: value.sourceVersion,
    contentDigest: value.contentDigest,
    title: value.title,
    model: value.model,
    applicableModels: Object.freeze([...value.applicableModels]),
  });
}

function validatePages(value, sourceId) {
  if (!Array.isArray(value) || !value.length) return invalidResponse();
  const pageNumbers = new Set();
  const pages = value.map((page) => {
    if (!isRecord(page)
      || page.sourceId !== sourceId
      || !Number.isInteger(page.pageNumber)
      || page.pageNumber < 1
      || pageNumbers.has(page.pageNumber)
      || typeof page.text !== "string") return invalidResponse();
    pageNumbers.add(page.pageNumber);
    return Object.freeze({
      pageNumber: page.pageNumber,
      sourceId: page.sourceId,
      text: page.text,
      charCount: Number.isInteger(page.charCount) ? page.charCount : page.text.length,
    });
  });
  pages.sort((left, right) => left.pageNumber - right.pageNumber);
  return Object.freeze(pages);
}

function validateEvidenceRef(value) {
  if (!isRecord(value)
    || !hasExactFields(value, EVIDENCE_REF_FIELDS)
    || !nonEmptyString(value.sourceId)
    || !nonEmptyString(value.sourceVersion)
    || !nonEmptyString(value.chunkId)
    || !Number.isInteger(value.pageStart)
    || !Number.isInteger(value.pageEnd)
    || value.pageStart < 1
    || value.pageEnd < value.pageStart
    || !nonEmptyString(value.excerpt)
    || !validScore(value.score)) return invalidResponse();
  return Object.freeze({
    sourceId: value.sourceId,
    sourceVersion: value.sourceVersion,
    chunkId: value.chunkId,
    pageStart: value.pageStart,
    pageEnd: value.pageEnd,
    excerpt: value.excerpt,
    score: Object.freeze({
      retrieval: value.score.retrieval,
      rerank: value.score.rerank,
      grounding: value.score.grounding,
    }),
  });
}

function validScore(value) {
  return isRecord(value)
    && hasExactFields(value, EVIDENCE_SCORE_FIELDS)
    && typeof value.retrieval === "number"
    && Number.isFinite(value.retrieval)
    && validNullableNumber(value.rerank)
    && validNullableNumber(value.grounding);
}

function validNullableNumber(value) {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function validatePdfUrl(value, sourceId, origin) {
  try {
    if (!nonEmptyString(value)) return invalidResponse();
    const url = new URL(value, origin);
    const keys = [...url.searchParams.keys()];
    if (url.origin !== origin
      || url.pathname !== "/api/userguide/pdf"
      || url.hash !== ""
      || keys.length !== 1
      || keys[0] !== "source"
      || url.searchParams.getAll("source").length !== 1
      || url.searchParams.get("source") !== sourceId) return invalidResponse();
    return `${url.pathname}${url.search}`;
  } catch (error) {
    if (error?.code === "invalid-response") throw error;
    return invalidResponse();
  }
}

function invalidResponse() {
  const error = new Error("invalid user guide response");
  error.code = "invalid-response";
  throw error;
}

function duplicateEvidence(evidenceRefs) {
  const keys = evidenceRefs.map((ref) => `${ref.sourceId}\u0000${ref.sourceVersion}\u0000${ref.chunkId}`);
  return new Set(keys).size !== keys.length;
}

function sameEvidenceList(left, right) {
  return left.length === right.length && left.every((ref, index) => sameEvidence(ref, right[index]));
}

function sameEvidence(left, right) {
  return left.sourceId === right.sourceId
    && left.sourceVersion === right.sourceVersion
    && left.chunkId === right.chunkId
    && left.pageStart === right.pageStart
    && left.pageEnd === right.pageEnd
    && left.excerpt === right.excerpt
    && left.score.retrieval === right.score.retrieval
    && left.score.rerank === right.score.rerank
    && left.score.grounding === right.score.grounding;
}

function validateHighlight(value, evidence, pages) {
  if (!isRecord(value)
    || !hasExactFields(value, HIGHLIGHT_FIELDS)
    || value.chunkId !== evidence.chunkId
    || value.pageStart !== evidence.pageStart
    || value.pageEnd !== evidence.pageEnd
    || value.excerpt !== evidence.excerpt
    || !Array.isArray(value.locations)
    || !value.locations.length) return invalidResponse();
  const pagesByNumber = new Map(pages.map((page, index) => [page.pageNumber, { page, index }]));
  let previousPageIndex = -1;
  const locations = value.locations.map((location) => {
    if (!isRecord(location)
      || !hasExactFields(location, LOCATION_FIELDS)
      || !Number.isInteger(location.pageNumber)
      || !Number.isInteger(location.start)
      || !Number.isInteger(location.end)) return invalidResponse();
    const pageEntry = pagesByNumber.get(location.pageNumber);
    if (!pageEntry
      || pageEntry.index <= previousPageIndex
      || location.start < 0
      || location.end <= location.start
      || location.end > pageEntry.page.text.length) return invalidResponse();
    previousPageIndex = pageEntry.index;
    return Object.freeze({
      pageNumber: location.pageNumber,
      start: location.start,
      end: location.end,
    });
  });
  const reconstructed = normalizeWhitespace(locations.map((location) => {
    const page = pagesByNumber.get(location.pageNumber).page;
    return page.text.slice(location.start, location.end);
  }).join(" "));
  if (!reconstructed || reconstructed !== normalizeExcerpt(evidence.excerpt)) return invalidResponse();
  return Object.freeze({
    chunkId: value.chunkId,
    pageStart: value.pageStart,
    pageEnd: value.pageEnd,
    excerpt: value.excerpt,
    locations: Object.freeze(locations),
  });
}

function pagesMatchEvidence(pages, evidence) {
  const expected = Array.from(
    { length: evidence.pageEnd - evidence.pageStart + 1 },
    (_value, index) => evidence.pageStart + index,
  );
  return pages.length === expected.length
    && pages.every((page, index) => page.pageNumber === expected[index]);
}

function normalizeExcerpt(value) {
  const normalized = normalizeWhitespace(value);
  if (/^(?:\.|\u2026|\u22ef|\s)+$/u.test(normalized)) return "";
  return normalized
    .replace(/^(?:(?:\.\.\.|\u2026)\s*)+/u, "")
    .replace(/(?:\s*(?:\.\.\.|\u2026))+$/u, "")
    .trim();
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function createDomController(documentRef, windowRef, fetchImpl) {
  const elements = {
    app: documentRef.querySelector("#userGuideApp"),
    title: documentRef.querySelector("#guideTitle"),
    meta: documentRef.querySelector("#guideMeta"),
    status: documentRef.querySelector("#userGuideStatus"),
    error: documentRef.querySelector("#userGuideError"),
    returnToConsole: documentRef.querySelector("#returnToConsole"),
    pages: documentRef.querySelector("#manualPages"),
    pdf: documentRef.querySelector("#pdfLink"),
    evidenceRegion: documentRef.querySelector("#evidenceRegion"),
    drawerToggle: documentRef.querySelector("#evidenceDrawerToggle"),
    drawer: documentRef.querySelector("#evidenceDrawer"),
    evidenceList: documentRef.querySelector("#evidenceList"),
  };
  let state = createUserGuideState();
  let pageRequest;
  const selectionGeneration = createLatestSelectionGeneration();

  function renderDocument(documentValue) {
    elements.pages.replaceChildren();
    if (!documentValue) return;
    elements.title.textContent = documentValue.source.title;
    const model = documentValue.source.model || "ES8";
    elements.meta.textContent = `${model} · 版本 ${documentValue.source.sourceVersion} · ${documentValue.pages.length} 页`;
    const fragment = documentRef.createDocumentFragment();
    for (const page of documentValue.pages) {
      const article = documentRef.createElement("article");
      article.className = "manual-page";
      article.dataset.manualPage = String(page.pageNumber);
      article.id = `manual-page-${page.pageNumber}`;
      const label = documentRef.createElement("span");
      label.className = "page-label";
      label.textContent = `Manual / ${String(page.pageNumber).padStart(3, "0")}`;
      const text = documentRef.createElement("p");
      text.className = "page-text";
      text.dataset.pageText = String(page.pageNumber);
      text.textContent = page.text;
      article.append(label, text);
      fragment.append(article);
    }
    elements.pages.append(fragment);
  }

  function clearActiveMarks() {
    for (const mark of elements.pages.querySelectorAll("mark[data-evidence-active]")) {
      const callout = mark.closest("[data-evidence-callout]");
      if (callout) callout.remove();
      else mark.replaceWith(documentRef.createTextNode(mark.textContent || ""));
    }
  }

  function highlightEvidence(evidence, highlight) {
    clearActiveMarks();
    if (!evidence || !highlight?.locations?.length) return false;
    const firstLocation = highlight.locations[0];
    if (highlight.locations.length > 1) {
      const pageElement = elements.pages.querySelector(`[data-manual-page="${firstLocation.pageNumber}"]`);
      if (!pageElement) return false;
      const callout = documentRef.createElement("aside");
      callout.className = "cross-page-evidence";
      callout.dataset.evidenceCallout = "";
      const label = documentRef.createElement("span");
      label.className = "page-label";
      label.textContent = "Cross-page evidence";
      const mark = createActiveMark(evidence, evidence.excerpt, true);
      callout.append(label, mark);
      pageElement.append(callout);
      mark.scrollIntoView({ block: "center" });
      return true;
    }
    const page = state.document.pages.find((candidate) => candidate.pageNumber === firstLocation.pageNumber);
    const textElement = elements.pages.querySelector(`[data-page-text="${firstLocation.pageNumber}"]`);
    if (!page || !textElement) return false;
    const before = documentRef.createTextNode(page.text.slice(0, firstLocation.start));
    const mark = createActiveMark(
      evidence,
      page.text.slice(firstLocation.start, firstLocation.end),
      false,
    );
    const after = documentRef.createTextNode(page.text.slice(firstLocation.end));
    textElement.replaceChildren(before, mark, after);
    mark.scrollIntoView({ block: "center" });
    return true;
  }

  function createActiveMark(evidence, text, crossPage) {
    const mark = documentRef.createElement("mark");
    mark.dataset.evidenceActive = "";
    mark.dataset.chunkId = evidence.chunkId;
    if (crossPage) mark.dataset.evidenceCrossPage = "";
    mark.textContent = text;
    return mark;
  }

  function renderEvidence() {
    const visible = state.document?.mode === "target" && state.evidenceRefs.length > 0;
    elements.evidenceRegion.hidden = !visible;
    elements.evidenceList.replaceChildren();
    if (!visible) {
      elements.drawer.hidden = true;
      elements.drawerToggle.textContent = "";
      elements.drawerToggle.setAttribute("aria-expanded", "false");
      return;
    }
    elements.drawerToggle.textContent = `本次可信证据 ${state.evidenceRefs.length} 条`;
    elements.drawerToggle.setAttribute("aria-expanded", String(state.drawerExpanded));
    elements.drawer.hidden = !state.drawerExpanded;
    const fragment = documentRef.createDocumentFragment();
    state.evidenceRefs.forEach((evidence, index) => {
      const button = documentRef.createElement("button");
      button.type = "button";
      button.className = "evidence-item";
      button.dataset.evidenceRank = String(index + 1);
      button.dataset.chunkId = evidence.chunkId;
      button.setAttribute("aria-pressed", String(state.activeChunkId === evidence.chunkId));
      const rank = documentRef.createElement("span");
      rank.className = "evidence-rank";
      rank.textContent = `#${index + 1}`;
      const detail = documentRef.createElement("span");
      const title = documentRef.createElement("strong");
      title.textContent = `第 ${evidence.pageStart}${evidence.pageEnd === evidence.pageStart ? "" : `-${evidence.pageEnd}`} 页`;
      const excerpt = documentRef.createElement("span");
      excerpt.textContent = evidence.excerpt;
      detail.append(title, excerpt);
      button.append(rank, detail);
      button.addEventListener("click", () => void selectEvidence(evidence));
      fragment.append(button);
    });
    elements.evidenceList.append(fragment);
  }

  function renderLoadedState() {
    renderDocument(state.document);
    elements.pdf.href = state.document.pdfHref;
    elements.pdf.hidden = false;
    renderEvidence();
    if (state.activeChunkId && !highlightEvidence(state.document.currentEvidence, state.document.highlight)) {
      throw Object.assign(new Error("evidence excerpt not found"), { code: "invalid-response" });
    }
  }

  function showError(error) {
    state = reduceUserGuideState(state, { type: "load-failed" });
    renderDocument(null);
    renderEvidence();
    elements.pdf.removeAttribute("href");
    elements.pdf.hidden = true;
    elements.status.textContent = "用户手册未加载";
    elements.error.textContent = friendlyError(error);
    elements.error.hidden = false;
    elements.app.dataset.loadState = "error";
  }

  async function selectEvidence(evidence) {
    if (!pageRequest?.runId || state.activeChunkId === evidence.chunkId) return;
    const generation = selectionGeneration.begin();
    const acceptedEvidence = state.evidenceRefs;
    state = reduceUserGuideState(state, { type: "clear-active" });
    clearActiveMarks();
    renderEvidence();
    elements.status.textContent = "正在定位所选证据";
    try {
      const nextRequest = Object.freeze({
        mode: "target",
        sourceId: evidence.sourceId,
        chunkId: evidence.chunkId,
        runId: pageRequest.runId,
      });
      const documentValue = await fetchUserGuide(
        nextRequest,
        fetchImpl,
        windowRef.location.origin,
        acceptedEvidence,
      );
      if (!selectionGeneration.isCurrent(generation)) return;
      state = reduceUserGuideState(state, {
        type: "document-loaded",
        document: documentValue,
        evidenceRefs: documentValue.evidenceRefs,
        activeChunkId: documentValue.currentEvidence.chunkId,
        keepDrawerExpanded: true,
      });
      renderLoadedState();
      elements.status.textContent = `已定位第 ${documentValue.currentEvidence.pageStart} 页可信证据`;
      elements.app.dataset.loadState = "ready";
    } catch (error) {
      if (!selectionGeneration.isCurrent(generation)) return;
      showError(error);
    }
  }

  elements.drawerToggle.addEventListener("click", () => {
    state = reduceUserGuideState(state, {
      type: "set-drawer-expanded",
      expanded: !state.drawerExpanded,
    });
    renderEvidence();
  });
  elements.returnToConsole.addEventListener("click", () => returnToConsole(windowRef));

  return Object.freeze({
    async start() {
      elements.app.dataset.loadState = "loading";
      elements.error.hidden = true;
      try {
        pageRequest = parsePageRequest(windowRef.location);
        const documentValue = await fetchUserGuide(
          pageRequest,
          fetchImpl,
          windowRef.location.origin,
        );
        const targetMode = documentValue.mode === "target";
        state = reduceUserGuideState(state, {
          type: "document-loaded",
          document: documentValue,
          evidenceRefs: targetMode ? documentValue.evidenceRefs : EMPTY_EVIDENCE,
          activeChunkId: targetMode ? documentValue.currentEvidence.chunkId : null,
        });
        renderLoadedState();
        elements.status.textContent = targetMode
          ? `已定位第 ${documentValue.currentEvidence.pageStart} 页可信证据`
          : `已加载完整 ${documentValue.source.model || "ES8"} 用户手册`;
        elements.app.dataset.loadState = "ready";
      } catch (error) {
        showError(error);
      }
    },
  });
}

function friendlyError(error) {
  if (error?.code === "invalid-link") return "链接参数无效，未加载任何证据。";
  if (error?.code === "evidence-run-expired") return "本次证据链接已过期，请返回主页重新查询。";
  if (["evidence-target-not-found", "userguide-source-not-found"].includes(error?.code)) {
    return "未找到可验证的用户手册内容。";
  }
  if (error?.code === "invalid-response") return "用户手册响应未通过验证，已停止展示证据。";
  return "用户手册暂时无法加载，请稍后重试。";
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactFields(value, fields) {
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  const start = () => void createDomController(document, window, window.fetch.bind(window)).start();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
