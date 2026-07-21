(async () => {
  "use strict";
  if (globalThis.__CRM_LEARNING_ALERT_CONTENT__) return;
  globalThis.__CRM_LEARNING_ALERT_CONTENT__ = true;
  try {
    const { startApp } = await import(chrome.runtime.getURL("src/app.js"));
    await startApp();
  } catch (error) {
    console.error("CRM作业助手启动失败", error);
  }
})();
