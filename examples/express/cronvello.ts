/**
 * Example registry for an Express app. Run `cronvello sync ./examples/express/cronvello.ts`
 * (under a TS loader) or import it from your server (see server.ts).
 */
import { defineCronvello, daily, every, weekly } from "@cronvello/sdk";

export const cronvello = defineCronvello.fromEnv({
  appName: "example-express-app",
  logger: console,
  hooks: {
    onJobError: ({ key, error }) => console.error(`[cron] ${key} failed:`, error.message),
  },
  jobs: {
    "send-daily-digest": {
      schedule: daily("08:00"),
      description: "Email everyone their morning digest",
      handler: async ({ logger }) => {
        // … your work here …
        logger.info?.("digest sent");
        return { sent: 42 };
      },
    },
    "cleanup-temp": {
      schedule: every("15m"),
      handler: async () => ({ removed: 3 }),
    },
    "weekly-report": {
      schedule: weekly("mon", "09:00"),
      handler: async () => ({ ok: true }),
    },
  },
});
