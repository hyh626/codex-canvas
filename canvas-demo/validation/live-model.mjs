import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { liveCUJ } from "./live-cuj.mjs";
const engine = process.argv[2];
if (!["codex", "dsh"].includes(engine) || process.argv[3] !== "--live") {
  console.error(
    "Usage: node validation/live-model.mjs codex|dsh --live (calls your configured provider; normal API charges may apply)",
  );
  process.exitCode = 2;
} else {
  const names =
    engine === "codex"
      ? ["CODEX_BIN", "CANVAS_MODEL", "CANVAS_RESPONSES_URL", "CANVAS_API_KEY"]
      : ["DSH_BIN", "CANVAS_DSH_MODEL", "CANVAS_DSH_URL", "CANVAS_DSH_API_KEY"];
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) {
    console.log(
      JSON.stringify({
        engine,
        status: "blocked",
        reason: "missing_configuration",
        missing,
        modelRequests: 0,
      }),
    );
    process.exitCode = 2;
  } else {
    const [command, model, endpoint, apiKey] = names.map(
      (name) => process.env[name],
    );
    if (!path.isAbsolute(command) || !fs.existsSync(command))
      throw Error("Runtime must be an existing absolute path");
    const parent = fileURLToPath(
      new URL("../.data/live-validation/", import.meta.url),
    );
    fs.mkdirSync(parent, { recursive: true });
    const directory = path.join(parent, `${engine}-${randomUUID()}`);
    const report = await liveCUJ({
      engine,
      command,
      model,
      endpoint,
      apiKey,
      directory,
    });
    console.log(
      JSON.stringify(
        { ...report, reportPath: path.join(directory, "report.json") },
        null,
        2,
      ),
    );
    if (report.status !== "passed") process.exitCode = 1;
  }
}
