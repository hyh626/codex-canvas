const { app, BrowserWindow } = require("electron");
const path = require("node:path");
let backend;
app.whenReady().then(async () => {
  const { createApp } = await import("../server.mjs");
  backend = createApp({
    dir: path.join(app.getPath("userData"), "canvas-demo"),
  });
  backend.server.listen(0, "127.0.0.1", () => {
    const window = new BrowserWindow({
      width: 1440,
      height: 960,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    const origin = `http://127.0.0.1:${backend.server.address().port}`;
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (new URL(url).origin !== origin) event.preventDefault();
    });
    window.loadURL(origin);
  });
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => backend?.close());
