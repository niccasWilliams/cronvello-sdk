/**
 * Next.js App Router dispatch endpoint: app/cronvello/dispatch/route.ts
 *
 * Reconcile the registry from a deploy step or a one-off script (await cronvello.sync()),
 * not from the request handler.
 */
import { cronvello } from "@/lib/cronvello";

export const POST = cronvello.nextHandler();
