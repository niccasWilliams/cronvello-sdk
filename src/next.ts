/**
 * Next.js adapter entry — `import { nextHandler } from "@cronvello/sdk/next"`.
 * (Also available as `cronvello.nextHandler()` on the app itself.)
 */
export {
  nextHandler,
  type NextRouteHandler,
  type FetchRequestLike,
} from "./adapters/next.js";
