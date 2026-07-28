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
