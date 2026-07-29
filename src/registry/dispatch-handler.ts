/**
 * The minimal interface the adapters depend on: anything that can turn a neutral
 * `DispatchRequest` into a `DispatchResponse`. `CronvelloApp` implements it.
 */
export type { DispatchRequest, DispatchResponse } from "./dispatch.js";
import type { DispatchRequest, DispatchResponse } from "./dispatch.js";

export interface DispatchHandler {
  handle(req: DispatchRequest): Promise<DispatchResponse>;
}
