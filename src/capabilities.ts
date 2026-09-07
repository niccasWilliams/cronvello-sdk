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
      rotationGracePeriod: {
        supported: false,
        operations: [],
        reason:
          "`rotateKey` ist ein harter Schnitt: der neue Token gilt sofort, der alte hoert im "
          + "selben Moment auf zu gelten. Wer rotiert, muss den neuen Wert in der Umgebung der "
          + "App stehen haben, BEVOR er rotiert — sonst laeuft sie bis zum Ausrollen ins Leere. "
          + "node-shop kann das anders (`gracePeriodHours`), Cronvello heute nicht.",
      },
      clientRevocation: {
        supported: false,
        operations: [],
        reason:
          "Es gibt keinen Widerruf, der die Registrierung stehen laesst. Ein Zugang wird "
          + "entzogen, indem die App geloescht wird (`delete`, mitsamt ihren Jobs und Tasks) "
          + "oder indem `rotateKey` den alten Wert wertlos macht. Beides ist mehr, als ein "
          + "Verwalter will, der nur einen Schluessel sperren moechte.",
      },
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
