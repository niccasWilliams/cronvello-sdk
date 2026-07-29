/**
 * Example registry for a Next.js App Router app. Put this at e.g. `lib/cronvello.ts`.
 * On serverless hosts keep the default sync execution mode so jobs finish within the request.
 */
import { defineCronvello, daily, hourly } from "@cronvello/sdk";

export const cronvello = defineCronvello.fromEnv({
  appName: "example-next-app",
  jobs: {
    "rebuild-sitemap": {
      schedule: daily("03:00"),
      handler: async () => {
        // … regenerate and upload your sitemap …
        return { rebuilt: true };
      },
    },
    "heartbeat": {
      schedule: hourly(),
      handler: async () => ({ alive: true }),
    },
  },
});
