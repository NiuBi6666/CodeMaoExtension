(() => {
  "use strict";
  if (window.__CRM_LEARNING_ALERT_BRIDGE__) return;
  window.__CRM_LEARNING_ALERT_BRIDGE__ = true;

  const CHANNEL = "crm-learning-alert:v1";
  const API_ORIGIN = "https://api-live-class-crm.codemao.cn";
  const templates = new Map();
  const latest = new Map();
  const NativeXHR = window.XMLHttpRequest;
  const nativeFetch = window.fetch?.bind(window);

  function classify(url) {
    try {
      const parsed = new URL(url, location.href);
      if (parsed.origin !== API_ORIGIN) return "";
      if (parsed.pathname === "/live/camp/getCampInfo") return "campInfo";
      if (parsed.pathname === "/live/course/getCampInfo") return "courseCampInfo";
      if (parsed.pathname === "/live/camp/queryLessonByCampId") return "lessons";
      if (parsed.pathname === "/live/class-user/teachSearch") return "teachSearch";
      if (parsed.pathname === "/live/class-user/teachTotal") return "teachTotal";
      if (parsed.pathname === "/live/learning-situation/searchLearningSituationList") return "learningSituation";
      return "";
    } catch {
      return "";
    }
  }

  function safeClone(value) {
    try {
      return structuredClone(value);
    } catch {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return null;
      }
    }
  }

  function post(message) {
    window.postMessage({ channel: CHANNEL, direction: "from-page", ...message }, location.origin);
  }

  function remember(kind, template, response) {
    if (!kind || response.data == null) return;
    templates.set(kind, template);
    const capture = {
      kind,
      url: template.url,
      method: template.method,
      status: response.status,
      data: safeClone(response.data),
      capturedAt: new Date().toISOString()
    };
    latest.set(kind, capture);
    post({ type: "CAPTURE", capture });
  }

  function parseJson(text) {
    if (typeof text !== "string" || !text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function filteredHeaders(headers) {
    const result = {};
    const browserManaged = /^(cookie|host|origin|referer|content-length|connection|user-agent|sec-)/i;
    for (const [name, value] of Object.entries(headers || {})) {
      if (!browserManaged.test(name) && typeof value === "string") result[name] = value;
    }
    return result;
  }

  const xhrOpen = NativeXHR.prototype.open;
  const xhrSetRequestHeader = NativeXHR.prototype.setRequestHeader;
  const xhrSend = NativeXHR.prototype.send;

  NativeXHR.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__crmLearningAlertRequest = {
      method: String(method || "GET").toUpperCase(),
      url: new URL(String(url), location.href).href,
      headers: {},
      body: null,
      credentials: this.withCredentials ? "include" : "same-origin"
    };
    return xhrOpen.call(this, method, url, ...rest);
  };

  NativeXHR.prototype.setRequestHeader = function patchedSetRequestHeader(name, value) {
    if (this.__crmLearningAlertRequest) this.__crmLearningAlertRequest.headers[String(name)] = String(value);
    return xhrSetRequestHeader.call(this, name, value);
  };

  NativeXHR.prototype.send = function patchedSend(body) {
    const request = this.__crmLearningAlertRequest;
    if (request) {
      request.body = typeof body === "string" ? body : null;
      request.credentials = this.withCredentials ? "include" : "same-origin";
      const kind = classify(request.url);
      if (kind) {
        this.addEventListener("loadend", () => {
          let data = null;
          try {
            data = this.responseType === "json" ? this.response : parseJson(this.responseText);
          } catch {
            data = null;
          }
          remember(kind, request, { status: this.status, data });
        }, { once: true });
      }
    }
    return xhrSend.call(this, body);
  };

  if (nativeFetch) {
    window.fetch = async function patchedFetch(input, init = {}) {
      const requestUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const request = {
        method: String(init.method || input?.method || "GET").toUpperCase(),
        url: new URL(requestUrl, location.href).href,
        headers: {},
        body: typeof init.body === "string" ? init.body : null,
        credentials: init.credentials || input?.credentials || "same-origin"
      };
      try {
        const headers = new Headers(init.headers || input?.headers || {});
        headers.forEach((value, name) => { request.headers[name] = value; });
        if (!request.body && input instanceof Request && request.method !== "GET") {
          request.body = await input.clone().text();
        }
      } catch {
        // The original request still proceeds if metadata cannot be inspected.
      }
      const response = await nativeFetch(input, init);
      const kind = classify(request.url);
      if (kind) {
        response.clone().json()
          .then((data) => remember(kind, request, { status: response.status, data }))
          .catch(() => undefined);
      }
      return response;
    };
  }

  function patchPayload(value, params, parentKey = "") {
    if (Array.isArray(value)) return value.map((item) => patchPayload(item, params, parentKey));
    if (!value || typeof value !== "object") return value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      let next = patchPayload(child, params, key);
      if (normalizedKey === "campid" && params.campId != null) next = params.campId;
      if (normalizedKey === "classid" && params.allClasses) next = null;
      if (/^(internal)?teacherid$/.test(normalizedKey) && params.teacherId != null) next = params.teacherId;
      if (/^(page|pageno|pageindex|current)$/.test(normalizedKey) && params.page != null) next = params.page;
      if (/^(pagesize|limit|size)$/.test(normalizedKey) && params.pageSize != null) next = params.pageSize;

      const lesson = params.lesson || {};
      if (/^(lessonid|camplessonid|courselessonid)$/.test(normalizedKey)) {
        next = lesson[key] ?? lesson[normalizedKey] ?? lesson.lessonId ?? lesson.campLessonId ?? lesson.id ?? next;
      }
      if (normalizedKey === "lessonids" && Array.isArray(lesson.lessonIds)) next = lesson.lessonIds;
      if (normalizedKey === "lbkcourseid" && lesson.lbkCourseId != null) next = lesson.lbkCourseId;
      if (normalizedKey === "courseid" && lesson.courseId != null) next = lesson.courseId;
      if (/^(lessonname|coursename)$/.test(normalizedKey) && (lesson.name || lesson.lessonName)) {
        next = lesson[key] ?? lesson.name ?? lesson.lessonName;
      }
      output[key] = next;
    }
    return output;
  }

  function buildReplayRequest(kind, params) {
    let template = templates.get(kind);
    if (!template && kind === "learningSituation") {
      const authTemplate = templates.get("teachSearch") || templates.get("campInfo") || templates.get("lessons");
      if (!authTemplate) throw new Error("缺少 CRM 只读查询模板，请刷新页面后重试");
      template = {
        ...authTemplate,
        method: "POST",
        url: `${API_ORIGIN}/live/learning-situation/searchLearningSituationList`,
        body: JSON.stringify({ page: 1, pageSize: 200 })
      };
    }
    if (!template && kind === "courseCampInfo") {
      const authTemplate = templates.get("campInfo") || templates.get("lessons") || templates.get("teachSearch");
      if (!authTemplate) throw new Error("缺少 CRM 只读查询模板，请刷新页面后重试");
      template = {
        ...authTemplate,
        method: "GET",
        url: `${API_ORIGIN}/live/course/getCampInfo`,
        body: null
      };
    }
    if (!template && kind === "teachTotal") {
      const authTemplate = templates.get("teachSearch") || templates.get("campInfo") || templates.get("lessons");
      if (!authTemplate) throw new Error("缺少 CRM 只读查询模板，请刷新页面后重试");
      template = {
        ...authTemplate,
        method: "POST",
        url: `${API_ORIGIN}/live/class-user/teachTotal`,
        body: JSON.stringify({ lessonIds: [] })
      };
    }
    if (!template) throw new Error(`缺少 ${kind} 请求模板，请刷新 CRM 页面后重试`);
    const url = new URL(template.url);
    if (params.allClasses) url.searchParams.delete("classId");
    if (params.campId != null) url.searchParams.set("campId", params.campId);
    if (params.teacherId != null && (url.searchParams.has("internalTeacherId") || kind === "learningSituation" || kind === "courseCampInfo" || kind === "teachTotal")) {
      url.searchParams.set("internalTeacherId", params.teacherId);
    }
    if (params.page != null) {
      for (const key of ["page", "pageNo", "pageIndex", "current"]) {
        if (url.searchParams.has(key)) url.searchParams.set(key, params.page);
      }
    }
    if (params.pageSize != null) {
      for (const key of ["pageSize", "limit", "size"]) {
        if (url.searchParams.has(key)) url.searchParams.set(key, params.pageSize);
      }
    }
    const lesson = params.lesson || {};
    for (const key of ["lessonId", "campLessonId", "courseLessonId", "courseId"]) {
      if (lesson[key] != null && url.searchParams.has(key)) url.searchParams.set(key, lesson[key]);
    }

    let body = template.body;
    if (typeof body === "string" && body.trim().startsWith("{")) {
      const parsed = parseJson(body);
      if (parsed) body = JSON.stringify(patchPayload(parsed, params));
    }
    return {
      url: url.href,
      method: template.method,
      headers: filteredHeaders(template.headers),
      body: template.method === "GET" || template.method === "HEAD" ? undefined : body,
      credentials: template.credentials === "omit" ? "omit" : "include"
    };
  }

  async function replay(kind, params) {
    if (!nativeFetch) throw new Error("当前页面不支持请求重放");
    const request = buildReplayRequest(kind, params || {});
    const response = await nativeFetch(request.url, request);
    let data = null;
    try {
      data = await response.json();
    } catch {
      throw new Error(`CRM 返回了无法解析的数据（HTTP ${response.status}）`);
    }
    if (!response.ok) throw new Error(`CRM 查询失败（HTTP ${response.status}）`);
    return { data, status: response.status, url: request.url };
  }

  window.addEventListener("message", async (event) => {
    const message = event.data;
    if (event.source !== window || message?.channel !== CHANNEL || message.direction !== "to-page") return;
    const requestId = String(message.requestId || "");
    try {
      if (message.type === "STATE_REQUEST") {
        post({
          type: "RESPONSE",
          requestId,
          ok: true,
          result: {
            captures: Object.fromEntries(latest.entries()),
            templates: Object.fromEntries([...templates.keys()].map((key) => [key, true]))
          }
        });
        return;
      }
      if (message.type === "REPLAY_REQUEST" && ["campInfo", "courseCampInfo", "lessons", "teachSearch", "teachTotal", "learningSituation"].includes(message.kind)) {
        const result = await replay(message.kind, message.params || {});
        post({ type: "RESPONSE", requestId, ok: true, result });
        return;
      }
      throw new Error("不支持的页面查询请求");
    } catch (error) {
      post({ type: "RESPONSE", requestId, ok: false, error: error?.message || "页面查询失败" });
    }
  });

  post({ type: "READY" });
})();
