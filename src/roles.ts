// Canonical role identity, server side (Phase 8 Task 4).
//
// MIRROR of hooks/roles.mjs — tsconfig's rootDir is `src`, so this cannot
// import the hook copy, and the hook copy must stay build-free (the pusher
// loads it from a bare checkout). test/roles.test.mjs asserts the two agree;
// change one, change the other.
//
// See hooks/roles.mjs for the rationale behind `explicit` and the word-match
// fallback.

import { z } from "zod";

export type ResolvedRole = {
  roleId: string;
  displayName: string;
  // true when the id was DECLARED (frozen), false when DERIVED from display text.
  explicit: boolean;
};

export type RoleInput =
  | string
  | { roleId?: string; displayName?: string; role?: string | null }
  | null
  | undefined;

export function slugifyRole(role: unknown): string {
  return String(role ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const GATE_RUNNER_ROLE_IDS = new Set(["qa", "quality", "coordinator", "gate"]);
export const COORDINATOR_ROLE_IDS = new Set(["coordinator"]);

export function resolveRole(role: RoleInput): ResolvedRole | undefined {
  if (role === null || role === undefined) return undefined;
  if (typeof role === "string") {
    const roleId = slugifyRole(role);
    return roleId ? { roleId, displayName: role, explicit: false } : undefined;
  }
  if (typeof role === "object") {
    const declared = typeof role.roleId === "string" ? slugifyRole(role.roleId) : "";
    const name =
      typeof role.displayName === "string" && role.displayName
        ? role.displayName
        : typeof role.role === "string" && role.role
          ? role.role
          : undefined;
    if (declared) return { roleId: declared, displayName: name ?? declared, explicit: true };
    if (name) return resolveRole(name);
  }
  return undefined;
}

export function roleMatches(role: RoleInput, allowedIds: Set<string>): boolean {
  const resolved = resolveRole(role);
  if (!resolved) return false;
  if (allowedIds.has(resolved.roleId)) return true;
  if (resolved.explicit) return false;
  return resolved.roleId.split("-").some((word) => allowedIds.has(word));
}

export function isGateRunner(role: RoleInput): boolean {
  return roleMatches(role, GATE_RUNNER_ROLE_IDS);
}

export function isCoordinator(role: RoleInput): boolean {
  return roleMatches(role, COORDINATOR_ROLE_IDS);
}

// Which roles may emit which record.type at the send path. Enforcement lives
// in messaging.ts (checkRecordAuthority); the table lives here so register/join
// can ECHO the consequence back at onboarding — a role that cannot emit `go`
// should learn it when it registers, not when it sends its first work order.
//
// NOT A TRUST BOUNDARY — roles are self-declared. See checkRecordAuthority.
export const RECORD_AUTHORITY: Record<string, { roles: Set<string>; label: string }> = {
  verdict: { roles: GATE_RUNNER_ROLE_IDS, label: "gate-runner" },
  go: { roles: COORDINATOR_ROLE_IDS, label: "coordinator" },
  scope: { roles: COORDINATOR_ROLE_IDS, label: "coordinator" },
};

// Split the restricted record types into what this role may and may not emit.
// Unrestricted types are omitted from both lists — they are nobody's business.
export function recordAuthorityFor(role: RoleInput): { mayEmit: string[]; mayNotEmit: string[] } {
  const mayEmit: string[] = [];
  const mayNotEmit: string[] = [];
  for (const [type, rule] of Object.entries(RECORD_AUTHORITY)) {
    (roleMatches(role, rule.roles) ? mayEmit : mayNotEmit).push(type);
  }
  return { mayEmit, mayNotEmit };
}

// Wire shape for `role` on register/join. Either free text (v1: `role: "qa
// lead"`) or a declared identity (`{roleId: "qa", displayName: "QA gate"}`).
// Both are supported forever — the string form is not deprecated, it just
// leaves the id derived rather than frozen.
//
// Lives here rather than in tools/ because registry.ts and transport.ts import
// each other; a schema in either would be a temporal-dead-zone hazard.
export const roleInputSchema = z.union([
  z.string(),
  z.object({
    roleId: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
  }),
]);

export type RoleArg = z.infer<typeof roleInputSchema>;
