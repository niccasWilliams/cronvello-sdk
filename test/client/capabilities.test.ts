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

    // ⭐ Seit 0.8.0 keine Luecken mehr, und das ist die Zeile, die es festhaelt: die
    // Rotation legt den abgeloesten Token mit Frist beiseite und `rollbackKey` holt ihn
    // zurueck; `revokeKey` nimmt den Schluessel und laesst die Registrierung stehen. Faellt
    // eine der beiden Methoden wieder weg, faellt hier auch der Bericht — und nicht erst
    // ein Aufruf in Produktion.
    expect(capabilities.rotationGracePeriod.supported).toBe(true);
    expect(capabilities.rotationGracePeriod.operations).toContain("rollbackKey");
    expect(capabilities.clientRevocation.supported).toBe(true);
    expect(capabilities.clientRevocation.operations).toContain("revokeKey");

    // `delete` bleibt daneben bestehen und ist etwas anderes: es nimmt Jobs und Tasks mit.
    // Genau weil beides frueher derselbe Weg war, wurde nicht widerrufen.
    expect(capabilities.clientManagement.operations).toContain("delete");
  });

  it("erklaert, was das Liveness-Abzeichen bedeutet, statt es einem Boolean zu ueberlassen", () => {
    // is_live misst den Katalog-Sync. Eine stillgelegte Registrierung steht dauerhaft auf
    // false, obwohl dort nichts laufen soll — als rotes Abzeichen gelesen meldet das
    // Gesundes als Ausfall.
    const { capabilities } = cronvelloCapabilities();
    expect(capabilities.livenessSemantics.supported).toBe(true);
  });
});
