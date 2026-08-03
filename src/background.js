const CODEDOG_ORIGIN = "https://codedog.online";
const ALLOWED_ENDPOINTS = new Set([
  "/api/public/rankings/extension/bootstrap",
  "/api/public/rankings/extension/import"
]);

async function codedogRequest(message) {
  const path = String(message.path || "");
  if (!ALLOWED_ENDPOINTS.has(path)) throw new Error("不允许的 CodeDog 接口");
  const request = message.request || {};
  const response = await fetch(`${CODEDOG_ORIGIN}${path}`, {
    method: request.method || "POST",
    headers: request.headers || {},
    body: request.body || undefined,
    credentials: "omit",
    redirect: "error"
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : {};
  if (!response.ok) {
    return { ok: false, status: response.status, error: payload.error || `CodeDog 请求失败（${response.status}）` };
  }
  return { ok: true, status: response.status, payload };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "CODEDOG_API") return false;
  codedogRequest(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, status: 0, error: error?.message || "CodeDog 网络请求失败" }));
  return true;
});
