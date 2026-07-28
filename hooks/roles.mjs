// Canonical role identity (Phase 8 Task 4). Dependency-free and
// side-effect-free: hooks/tier.mjs imports it on the delivery hot path, and it
// must keep working from a bare checkout with no build step.
//
// The problem this exists for: a role's identity used to BE its display string,
// so renaming it (curator → liaison → aide) churned every id, skill and script
// that named it. Now the id is frozen and only the name moves.
//
// MIRROR: src/roles.ts carries the same logic for the server side — tsconfig's
// rootDir is `src`, so TypeScript cannot import this file. test/roles.test.mjs
// asserts the two stay in lockstep; if you change a rule or an id here, change
// it there too.

// Display text → role id. Lowercase, non-alphanumerics collapse to "-".
export function slugifyRole(role) {
  return String(role ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// A gate runner is the agent that consumes DONE: reports (QA / coordinator).
export const GATE_RUNNER_ROLE_IDS = new Set(["qa", "quality", "coordinator", "gate"]);
// Coordinators countersign work orders (`go`) and in-flight contract
// amendments (`scope`).
export const COORDINATOR_ROLE_IDS = new Set(["coordinator"]);

// Normalize any role shape into {roleId, displayName, explicit}.
//
// `explicit` records whether the id was DECLARED (registry entry carries a
// frozen roleId) or DERIVED from display text. It is the difference between
// "this agent's identity is `gate`" and "this agent's name happens to contain
// the word gate" — declared ids match exactly, derived ones fall back to the
// legacy word match below so un-migrated registries keep behaving as they did.
//
// Accepts: a plain string, {roleId, displayName}, or an AgentEntry ({role,
// roleId}) passed straight from the registry.
export function resolveRole(role) {
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

// Does this role carry one of `allowedIds`?
//
// Declared ids must match exactly — that is the point of freezing them. A
// derived id additionally matches on any of its hyphen-separated words, which
// reproduces the pre-Task-4 prose regex (/\b(qa|quality|coordinator|gate)\b/i)
// for registries that never declared a roleId.
export function roleMatches(role, allowedIds) {
  const resolved = resolveRole(role);
  if (!resolved) return false;
  if (allowedIds.has(resolved.roleId)) return true;
  if (resolved.explicit) return false;
  return resolved.roleId.split("-").some((word) => allowedIds.has(word));
}

export function isGateRunner(role) {
  return roleMatches(role, GATE_RUNNER_ROLE_IDS);
}

export function isCoordinator(role) {
  return roleMatches(role, COORDINATOR_ROLE_IDS);
}
