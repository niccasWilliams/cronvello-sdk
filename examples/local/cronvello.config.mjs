import { setTimeout as sleep } from "node:timers/promises";
import { defineCronvello, every } from "@cronvello/sdk";

let attempts = 0;

// Demo data only: these handlers log messages and wait. No external services.
export default defineCronvello({
  appName: "cronvello-local-demo",
  jobs: {
    heartbeat: {
      schedule: every("10s"),
      handler: async () => {
        console.log("Heartbeat completed");
        return { ok: true };
      },
    },
    "retry-demo": {
      schedule: every("20s"),
      maxRetries: 1,
      handler: async () => {
        attempts += 1;
        if (attempts % 2 === 1) {
          throw new Error("Intentional demo failure; the next attempt succeeds");
        }
        return { recovered: true, attempt: attempts };
      },
    },
    "overlap-demo": {
      schedule: every("10s"),
      allowConcurrentRuns: false,
      handler: async () => {
        await sleep(12_000);
        return { waitedMs: 12_000 };
      },
    },
  },
});
