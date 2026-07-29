/**
 * Minimal Express server that mounts the Cronvello dispatch endpoint and reconciles on boot.
 *
 * Env: CRONVELLO_API_KEY, CRONVELLO_DISPATCH_SECRET, CRONVELLO_APP_URL (public URL of this app).
 */
import express from "express";
import { formatSyncResult } from "@cronvello/sdk";
import { cronvello } from "./cronvello.js";

const app = express();

// Cronvello POSTs here when a task is due; the handler verifies the bearer and runs the job.
app.post(cronvello.dispatchPath, express.json(), cronvello.expressHandler());

app.listen(3000, async () => {
  const result = await cronvello.sync(); // idempotent — safe on every boot/deploy
  console.log(formatSyncResult(result, { color: true }));
});
