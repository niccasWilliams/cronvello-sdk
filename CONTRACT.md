# Keeping the SDK aligned with the API contract

`@cronvello/sdk` is a zero-runtime-dependency client for Cronvello's public `/v1` API. Its wire
types in `src/internal/wire.ts` are maintained as plain TypeScript so applications do not need a
runtime schema library.

## When the `/v1` contract changes

1. Compare the updated public API schema with `src/internal/wire.ts`.
2. Update the affected wire interfaces and, for new endpoints, the matching resource method in
   `src/client/client.ts`.
3. Update the synthetic fixtures in `test/fixtures/server-responses.ts` while preserving the
   documented response envelopes.
4. Run `npm run check`, bump the SDK version, and document the change in `CHANGELOG.md`.

Contract fixtures must remain synthetic. Never copy raw responses from a customer or internal
tenant into this repository.

## Load-bearing behavior

- Tasks are created disabled, so `sync()` starts newly created tasks after reconciliation.
- The dispatch callback body is `{ ...requestBody, schedule, _callback? }`. The SDK stores
  `requestBody = {"job":"<key>"}`, so the handler reads `body.job`.
- Inbound dispatch authentication uses `Authorization: Bearer <targetToken>`. The SDK sets the
  task's target token to the configured dispatch secret.
- Async callbacks use `X-Webhook-Signature: sha256=<hmac>`. Cronvello verifies the signature with
  the task's dispatch secret. Sync mode remains the simplest default for serverless handlers.
