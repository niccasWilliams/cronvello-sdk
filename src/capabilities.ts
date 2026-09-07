/**
 * Was Cronvello einem Verwalter anbietet — als Daten, ohne Netz und ohne Vermutung.
 *
 * Ein Verbindungs-Verwalter (node-amp) kann Kanten nur dann selbst herstellen, pruefen und
 * reparieren, wenn er weiss, *was die Gegenseite ueberhaupt anbietet*. Bis hierher war das
 * bei Cronvello Handwissen: irgendwo im Verwalter stand einprogrammiert, dass hier Apps zu
 * registrieren sind. Wird eine Faehigkeit dort angenommen und fehlt sie hier, ist das
 * Ergebnis eine Zeile, die gesund aussieht, weil nie jemand gefragt hat.
 *
 * ⭐ Der Beleg ist hier kein generierter Vertrag, sondern die **Methodenliste des
 * Verwalter-Clients selbst** ({@link ExternalAppsResource}, vom Prototyp gelesen). Das ist
 * fuer dieses Paket der ehrlichere Beleg: es gibt keinen mitgelieferten Vertragsabzug, den
 * man befragen koennte, und eine handgepflegte Aufzaehlung waere genau die Liste, gegen die
 * dieser Bericht gebaut ist. Verschwindet eine Methode, verschwindet die Faehigkeit — ohne
 * dass jemand daran denken muss.
 *
 * ⚠ Der Bericht sagt, was der Client anbietet, nicht was der Aufrufer darf und nicht, ob
 * die laufende Gegenstelle die Route schon kennt. Ein Server, der zu alt fuer eine Route
 * ist, antwortet 404 — das beantwortet der Aufruf, nicht dieser Bericht.
 */

import { ExternalAppsResource } from "./client/admin-client.js";

declare const __CRONVELLO_SDK_VERSION__: string;
const SDK_VERSION: string =
  typeof __CRONVELLO_SDK_VERSION__ === "string" ? __CRONVELLO_SDK_VERSION__ : "0.0.0-unbuilt";

/**
 * Eine Faehigkeit und die Client-Operationen, an denen sie haengt.
 *
 * `operations` ist der Beleg: wer die Angabe anzweifelt, ruft die Methode nach.
 */
export type CronvelloCapability = {
  supported: boolean;
  operations: string[];
  /** Warum nicht — nur gesetzt, wenn `supported` falsch ist. */
  reason?: string;
};

export type CronvelloCapabilities = {
  service: "node-cron";
  sdkVersion: string;
  /** Wie viele Operationen der Verwalter-Client kennt. */
  operationCount: number;
  capabilities: {
    /** Der Dienst nennt seinen eigenen Vertrags-Fingerabdruck. */
    contractFingerprint: CronvelloCapability;
    /** Apps registrieren und wieder entfernen. */
    clientManagement: CronvelloCapability;
    /** Den Token einer registrierten App erneuern. */
    clientRotation: CronvelloCapability;
    /** Gnadenfrist beim Wechsel: der alte Token bleibt eine Weile gueltig. */
    rotationGracePeriod: CronvelloCapability;
    /** Zugang entziehen, ohne die Registrierung zu loeschen. */
    clientRevocation: CronvelloCapability;
    /** Der Zustand einer Registrierung, von aussen abfragbar. */
    peerStatus: CronvelloCapability;
    /**
     * ALLE Registrierungen auflisten — die Faehigkeit, ohne die ein Verwalter nur
     * bestaetigen kann, was er ohnehin schon glaubt.
     */
    registrationListing: CronvelloCapability;
    /** Eine Registrierung ueber ihren Zeiger statt ueber ihr Etikett erreichen. */
    pointerAddressing: CronvelloCapability;
    /** Ein serverseitiger Probelauf, der schreibt *als ob*, aber nichts aendert. */
    serverSideDryRun: CronvelloCapability;
    /**
     * Der Client reicht `liveness` aus der Statusauskunft durch — `retired`, `inactive` und
     * `revoked` sind dort keine Ausfaelle.
     *
     * ⚠ Wie bei jeder Angabe hier gilt: das ist eine Aussage ueber den CLIENT, nicht ueber
     * die laufende Gegenstelle. Ein aelterer Server laesst das Feld weg, dann ist
     * `status.liveness` schlicht `undefined` — und dann bleibt `isLive`, mit derselben
     * Unschaerfe wie zuvor. Der Aufrufer prueft das Feld, er nimmt es nicht an.
     */
    livenessSemantics: CronvelloCapability;
  };
};

/**
 * Die Operationen des Verwalter-Clients, vom Prototyp gelesen statt aufgezaehlt.
 * `constructor` ist keine Operation.
 */
function adminOperations(): string[] {
  return Object.getOwnPropertyNames(ExternalAppsResource.prototype)
    .filter((name) => name !== "constructor")
    .sort();
}

function capabilityFrom(
  present: string[],
  required: string[],
  reasonWhenMissing: string,
): CronvelloCapability {
  const found = required.filter((name) => present.includes(name));
  if (found.length === required.length) return { supported: true, operations: found };
  const missing = required.filter((name) => !found.includes(name));
  return {
    supported: false,
    operations: found,
    reason: `${reasonWhenMissing} Fehlend im Client: ${missing.join(", ")}.`,
  };
}

/**
 * Der Faehigkeitsbericht dieses Dienstes. Kein Netzzugriff, kein Credential noetig —
 * damit ein Verwalter ihn auch dann fuehren kann, wenn die Verbindung gerade nicht steht.
 */
export function cronvelloCapabilities(): CronvelloCapabilities {
  const operations = adminOperations();

  return {
    service: "node-cron",
    sdkVersion: SDK_VERSION,
    operationCount: operations.length,
    capabilities: {
      contractFingerprint: {
        supported: false,
        operations: [],
        reason:
          "Cronvello liefert keinen Vertragsabzug mit, gegen den sich der laufende Server "
          + "vergleichen liesse (Muster: @orvello/sdk `diagnoseOrvello`, @cronvello/shop-sdk "
          + "`diagnoseShop`). Ein Aufrufer kann heute nur merken, dass eine Route fehlt, wenn "
          + "er sie aufruft und 404 bekommt — im Nachhinein statt vorher.",
      },
      clientManagement: capabilityFrom(
        operations,
        ["register", "delete"],
        "Ohne diese Methoden kann ein Verwalter hier keine App anbinden oder loesen.",
      ),
      clientRotation: capabilityFrom(
        operations,
        ["rotateKey"],
        "Ohne Erneuerung ist ein einmal ausgegebener Token dauerhaft.",
      ),
      // ⭐ Seit @cronvello/sdk 0.8.0 / Cronvello vom 07.09.2026 keine Luecke mehr. Die
      // Rotation legt den abgeloesten Token mit Frist beiseite (`gracePeriodHours`, Default
      // 2 h), `rollbackKey` holt ihn zurueck. Vorher war jede Rotation ein Schritt ohne
      // Rueckweg: landete der neue Wert nicht, war die Kante tot und der alte Wert weg.
      rotationGracePeriod: capabilityFrom(
        operations,
        ["rotateKey", "rollbackKey"],
        "Ohne Frist und Rueckholung ist jede Rotation ein Schritt ohne Rueckweg: landet der "
          + "neue Wert bei der App nicht, laeuft sie ins Leere, und der alte Wert ist weg.",
      ),
      // ⭐ Ebenfalls seit 0.8.0. `revokeKey` nimmt den Schluessel und laesst die
      // Registrierung stehen — der Unterschied zu `delete`, das Jobs und Tasks mitnimmt.
      // Ein Zugang, den man nur unter Verlust der Beziehung entziehen kann, wird nicht
      // entzogen; genau so bleiben kompromittierte Schluessel gueltig.
      clientRevocation: capabilityFrom(
        operations,
        ["revokeKey"],
        "Ohne Widerruf bleibt nur `delete` (mitsamt Jobs und Tasks) oder `rotateKey`, das den "
          + "alten Wert wertlos macht. Beides ist mehr, als ein Verwalter will, der nur einen "
          + "Schluessel sperren moechte — also sperrt er ihn nicht.",
      ),
      peerStatus: capabilityFrom(
        operations,
        ["status"],
        "Ohne Statusauskunft kann ein Verwalter nur raten, was Cronvello ueber die App fuehrt.",
      ),
      registrationListing: capabilityFrom(
        operations,
        ["list"],
        "Ohne Auflistung kann ein Verwalter nur nach Apps fragen, die er ohnehin schon kennt — "
          + "sein Bild ist dann so vollstaendig wie seine eigene Buchfuehrung und nicht "
          + "vollstaendiger.",
      ),
      pointerAddressing: capabilityFrom(
        operations,
        ["statusByRegistrationId"],
        "Ohne den Zeiger bleibt nur das Etikett, und ein Etikett kann umbenannt werden — dann "
          + "sieht eine laufende Registrierung aus wie eine geloeschte (INC-000732).",
      ),
      // ⭐ Der Grund fuer diese Faehigkeit: `isLive` misst den Katalog-Sync, nicht ob die
      // Jobs laufen. Eine stillgelegte Registrierung steht dauerhaft auf false — richtig,
      // dort SOLL nichts gepollt werden — und wurde von einem Verwalter als rotes Abzeichen
      // gezeigt, waehrend derselbe Dienst 18.696 von 18.711 Laeufen in 24 h auf HTTP 200
      // hatte. Ein Verwalter, der `liveness` liest, faellt darauf nicht mehr herein.
      livenessSemantics: capabilityFrom(
        operations,
        ["status", "list"],
        "Ohne Statusauskunft gibt es nichts, dessen Bedeutung der Dienst erklaeren koennte.",
      ),

      serverSideDryRun: {
        supported: false,
        operations: [],
        reason:
          "Cronvello bietet keinen serverseitigen Probelauf an. `register` ist ein Upsert und "
          + "`rotateKey` macht den bestehenden Token wertlos — beide schreiben. Nebenwirkungsfrei "
          + "pruefbar ist nur der Zustand (`status`, `statusByRegistrationId`, `list`).",
      },
    },
  };
}
