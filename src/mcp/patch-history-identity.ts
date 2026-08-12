import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  MaxforgePatchHistoryIdentity,
  MaxforgePatchHistoryIdentityDecision,
  MaxforgePatchHistoryIdentityStatus,
  ResolveMaxforgePatchHistoryIdentityRequest,
  ResolveMaxforgePatchHistoryIdentityResult,
} from "../max/patch-protocol.js";

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

interface IdentityResolutionRecord extends MaxforgePatchHistoryIdentityDecision {
  readonly schemaVersion: 1;
  readonly record: "identity-resolution";
}

export class PatchHistoryIdentityLedger {
  private readonly knownIdentities = new Set<string>();
  private readonly aliases = new Map<string, string>();
  private readonly forgotten = new Set<string>();
  private readonly decisions: MaxforgePatchHistoryIdentityDecision[] = [];

  constructor(
    private readonly directory: string,
    private readonly projectId: string
  ) {}

  load(): readonly string[] {
    this.knownIdentities.clear();
    this.aliases.clear();
    this.forgotten.clear();
    this.decisions.length = 0;
    const warnings: string[] = [];
    let source: string;
    try {
      source = readFileSync(this.path(), "utf8");
    } catch (error) {
      if (isMissingFileError(error)) return warnings;
      throw error;
    }
    const lines = source.split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (let index = 0; index < lines.length; index++) {
      let raw: unknown;
      try {
        raw = JSON.parse(lines[index]);
      } catch (error) {
        if (index === lines.length - 1) {
          warnings.push(`${this.path()}: ignored incomplete final identity resolution`);
          return warnings;
        }
        warnings.push(
          `${this.path()}: invalid identity resolution ${index + 1}: ${errorMessage(error)}`
        );
        continue;
      }
      const decision = parseIdentityResolutionRecord(raw);
      if (!decision) {
        warnings.push(
          `${this.path()}: ignored invalid identity resolution ${index + 1}`
        );
        continue;
      }
      try {
        this.apply(decision);
      } catch (error) {
        warnings.push(
          `${this.path()}: ignored identity resolution ${index + 1}: ${errorMessage(error)}`
        );
      }
    }
    return warnings;
  }

  observe(identity: MaxforgePatchHistoryIdentity): void {
    validateIdentity(identity, "observed patch history identity");
    this.knownIdentities.add(identityKey(identity));
  }

  status(
    patcherId: string,
    scope: string
  ): MaxforgePatchHistoryIdentityStatus {
    const requested = { patcherId, scope };
    validateIdentity(requested, "requested patch history identity");
    const requestedKey = identityKey(requested);
    const canonicalKey = this.canonicalKey(requestedKey);
    const members = [...this.knownIdentities]
      .filter((key) => this.canonicalKey(key) === canonicalKey)
      .sort()
      .map(identityFromKey);
    const groupKeys = new Set([
      canonicalKey,
      ...members.map(identityKey),
    ]);
    return {
      projectId: this.projectId,
      requested,
      canonical: identityFromKey(canonicalKey),
      known: this.knownIdentities.has(requestedKey) || 0 < members.length,
      forgotten: this.forgotten.has(canonicalKey),
      aliases: members.filter((identity) => identityKey(identity) !== canonicalKey),
      decisions: this.decisions.filter((decision) =>
        groupKeys.has(identityKey(decision.source)) ||
        (decision.target !== undefined && groupKeys.has(identityKey(decision.target)))
      ),
    };
  }

  matches(
    historical: MaxforgePatchHistoryIdentity,
    requested: MaxforgePatchHistoryIdentity
  ): boolean {
    const historicalKey = identityKey(historical);
    return !this.isForgotten(historical) &&
      this.canonicalKey(historicalKey) === this.canonicalKey(identityKey(requested));
  }

  canonical(identity: MaxforgePatchHistoryIdentity): MaxforgePatchHistoryIdentity {
    return identityFromKey(this.canonicalKey(identityKey(identity)));
  }

  isForgotten(identity: MaxforgePatchHistoryIdentity): boolean {
    return this.forgotten.has(this.canonicalKey(identityKey(identity)));
  }

  resolve(
    request: ResolveMaxforgePatchHistoryIdentityRequest
  ): ResolveMaxforgePatchHistoryIdentityResult {
    if (request.expectedProjectId !== this.projectId) {
      throw new Error(
        `Expected project id ${request.expectedProjectId}, but edit history belongs to ${this.projectId}`
      );
    }
    validateRequest(request);
    const decision: MaxforgePatchHistoryIdentityDecision = {
      action: request.action,
      source: { ...request.source },
      ...(request.target ? { target: { ...request.target } } : {}),
      reason: request.reason,
      resolvedAt: request.resolvedAt ?? new Date().toISOString(),
    };
    this.validateNewDecision(decision);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    appendFileSync(this.path(), jsonLine({
      schemaVersion: 1,
      record: "identity-resolution",
      ...decision,
    } satisfies IdentityResolutionRecord), {
      encoding: "utf8",
      mode: 0o600,
      flag: "a",
    });
    chmodSync(this.path(), 0o600);
    this.apply(decision);
    const selected = decision.target ?? decision.source;
    return {
      ...this.status(selected.patcherId, selected.scope),
      action: decision.action,
      physicalDataErased: false,
    };
  }

  private path(): string {
    return join(this.directory, "identity-resolutions-v1.ndjson");
  }

  private validateNewDecision(decision: MaxforgePatchHistoryIdentityDecision): void {
    const sourceKey = identityKey(decision.source);
    const canonicalSource = this.canonicalKey(sourceKey);
    if (canonicalSource !== sourceKey) {
      throw new Error(
        `Patch history identity ${formatIdentity(decision.source)} is already an alias of ${formatIdentity(identityFromKey(canonicalSource))}`
      );
    }
    if (!this.knownIdentities.has(sourceKey)) {
      throw new Error(
        `Patch history identity ${formatIdentity(decision.source)} is not known`
      );
    }
    if (this.forgotten.has(sourceKey)) {
      throw new Error(
        `Patch history identity ${formatIdentity(decision.source)} is already forgotten`
      );
    }
    if (decision.action === "forget") return;
    const target = decision.target!;
    const targetKey = identityKey(target);
    if (this.canonicalKey(targetKey) !== targetKey) {
      throw new Error(
        `Target patch history identity ${formatIdentity(target)} is already an alias`
      );
    }
    if (this.forgotten.has(targetKey)) {
      throw new Error(
        `Target patch history identity ${formatIdentity(target)} is forgotten`
      );
    }
    if (decision.action === "rekey" && this.knownIdentities.has(targetKey)) {
      throw new Error(
        `Rekey requires an unused target identity; ${formatIdentity(target)} is already known. Use merge only after confirming both identities are the same patch.`
      );
    }
    if (decision.action === "merge" && !this.knownIdentities.has(targetKey)) {
      throw new Error(
        `Merge requires a known target identity; ${formatIdentity(target)} is not known`
      );
    }
  }

  private apply(decision: MaxforgePatchHistoryIdentityDecision): void {
    const sourceKey = identityKey(decision.source);
    const source = this.canonicalKey(sourceKey);
    if (source !== sourceKey) {
      throw new Error(
        `Patch history identity ${formatIdentity(decision.source)} is already an alias`
      );
    }
    if (decision.action === "forget") {
      this.forgotten.add(source);
      this.decisions.push(decision);
      return;
    }
    const target = decision.target;
    if (!target) throw new Error(`${decision.action} requires a target identity`);
    if (decision.source.scope !== target.scope) {
      throw new Error("Patch history identity resolution requires the same scope");
    }
    const targetKey = identityKey(target);
    const canonicalTarget = this.canonicalKey(targetKey);
    if (canonicalTarget !== targetKey) {
      throw new Error(
        `Target patch history identity ${formatIdentity(target)} is already an alias`
      );
    }
    if (source === canonicalTarget) {
      throw new Error("Patch history identity resolution cannot target itself");
    }
    if (this.forgotten.has(source) || this.forgotten.has(canonicalTarget)) {
      throw new Error("Forgotten patch history identities cannot be resolved");
    }
    this.aliases.set(source, canonicalTarget);
    this.knownIdentities.add(identityKey(target));
    this.decisions.push(decision);
  }

  private canonicalKey(key: string): string {
    const visited = new Set<string>();
    let current = key;
    while (this.aliases.has(current)) {
      if (visited.has(current)) {
        throw new Error("Patch history identity resolution contains a cycle");
      }
      visited.add(current);
      current = this.aliases.get(current)!;
    }
    return current;
  }
}

function parseIdentityResolutionRecord(
  raw: unknown
): MaxforgePatchHistoryIdentityDecision | undefined {
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== 1 ||
    raw.record !== "identity-resolution" ||
    (raw.action !== "rekey" && raw.action !== "merge" && raw.action !== "forget") ||
    !isIdentity(raw.source) ||
    typeof raw.reason !== "string" ||
    raw.reason.trim().length === 0 ||
    raw.reason.length > 512 ||
    typeof raw.resolvedAt !== "string" ||
    !Number.isFinite(Date.parse(raw.resolvedAt))
  ) return undefined;
  if (raw.action === "forget") {
    if (raw.target !== undefined) return undefined;
  } else if (!isIdentity(raw.target) || raw.target.scope !== raw.source.scope) {
    return undefined;
  }
  return {
    action: raw.action,
    source: raw.source,
    ...(raw.target ? { target: raw.target } : {}),
    reason: raw.reason,
    resolvedAt: raw.resolvedAt,
  };
}

function validateRequest(request: ResolveMaxforgePatchHistoryIdentityRequest): void {
  validateIdentity(request.source, "source patch history identity");
  if (request.reason.trim().length === 0 || request.reason.length > 512) {
    throw new Error("Patch history identity resolution reason must contain 1 to 512 characters");
  }
  const resolvedAt = request.resolvedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(resolvedAt))) {
    throw new Error("Invalid patch history identity resolution timestamp");
  }
  if (request.action === "forget") {
    if (request.target !== undefined) {
      throw new Error("Forget must not include a target identity");
    }
    return;
  }
  if (!request.target) throw new Error(`${request.action} requires a target identity`);
  validateIdentity(request.target, "target patch history identity");
  if (request.source.scope !== request.target.scope) {
    throw new Error("Patch history identity resolution requires the same scope");
  }
}

function validateIdentity(identity: MaxforgePatchHistoryIdentity, label: string): void {
  if (!isIdentity(identity)) throw new Error(`Invalid ${label}`);
}

function isIdentity(value: unknown): value is MaxforgePatchHistoryIdentity {
  return isRecord(value) &&
    typeof value.patcherId === "string" && IDENTIFIER_PATTERN.test(value.patcherId) &&
    typeof value.scope === "string" && IDENTIFIER_PATTERN.test(value.scope);
}

function identityKey(identity: MaxforgePatchHistoryIdentity): string {
  return `${identity.patcherId}\u0000${identity.scope}`;
}

function identityFromKey(key: string): MaxforgePatchHistoryIdentity {
  const separator = key.indexOf("\u0000");
  if (separator < 0) throw new Error("Invalid patch history identity key");
  return {
    patcherId: key.slice(0, separator),
    scope: key.slice(separator + 1),
  };
}

function formatIdentity(identity: MaxforgePatchHistoryIdentity): string {
  return `${identity.patcherId}:${identity.scope}`;
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
