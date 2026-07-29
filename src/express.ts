/**
 * Express adapter entry — `import { expressHandler } from "@cronvello/sdk/express"`.
 * (Also available as `cronvello.expressHandler()` on the app itself.)
 */
export {
  expressHandler,
  type ExpressDispatchHandler,
  type ExpressRequestLike,
  type ExpressResponseLike,
} from "./adapters/express.js";
