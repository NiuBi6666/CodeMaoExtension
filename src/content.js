(async () => {
  "use strict";
  if (globalThis.__CRM_LEARNING_ALERT_CONTENT__) return;
  globalThis.__CRM_LEARNING_ALERT_CONTENT__ = true;
  try {
    const [{ startApp }, { startSelectionInverter }] = await Promise.all([
      import(chrome.runtime.getURL("src/app.js")),
      import(chrome.runtime.getURL("src/selection-inverter.js"))
    ]);
    startSelectionInverter();
    await startApp();
  } catch (error) {
    console.error("CRM作业助手启动失败", error);
  }
})();
