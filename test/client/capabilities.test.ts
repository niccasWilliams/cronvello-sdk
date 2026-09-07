import { describe, expect, it } from "vitest";

import { cronvelloCapabilities } from "../../src/capabilities.js";
import { ExternalAppsResource } from "../../src/client/admin-client.js";

describe("cronvelloCapabilities", () => {
  it("counts the admin client's own methods, not a maintained list", () => {
    const report = cronvelloCapabilities();
    const methods = Object.getOwnPropertyNames(ExternalAppsResource.prototype)
      .filter((name) => name !== "constructor");

    expect(report.service).toBe("node-cron");
    expect(report.operationCount).toBe(methods.length);
  });

  it("backs every claim with a method that exists on the client", () => {
    const report = cronvelloCapabilities();
    const methods = Object.getOwnPropertyNames(ExternalAppsResource.prototype);

    for (const [name, capability] of Object.entries(report.capabilities)) {
      for (const operation of capability.operations) {
        expect(methods, `${name} cites unknown operation ${operation}`).toContain(operation);
      }
      // Eine nicht vorhandene Faehigkeit ohne Begruendung waere genau der stille
      // Zustand, gegen den dieser Bericht gebaut ist.
      if (!capability.supported) {
        expect(capability.reason, `${name} says no without saying why`).toBeTruthy();
      }
    }
  });

  it("knows what a connection manager actually needs from Cronvello", () => {
    const { capabilities } = cronvelloCapabilities();

    expect(capabilities.clientManagement.supported).toBe(true);
    expect(capabilities.clientRotation.supported).toBe(true);
    expect(capabilities.peerStatus.supported).toBe(true);
    expect(capabilities.pointerAddressing.supported).toBe(true);
    // Die Faehigkeit, ohne die ein Verwalter nur bestaetigen kann, was er ohnehin glaubt.
    expect(capabilities.registrationListing.supported).toBe(true);

    // Bewusst false, jeweils mit Grund: rotateKey ist ein harter Schnitt, und es gibt
    // keinen Widerruf, der die Registrierung stehen laesst.
    expect(capabilities.rotationGracePeriod.supported).toBe(false);
    expect(capabilities.clientRevocation.supported).toBe(false);
  });
});
