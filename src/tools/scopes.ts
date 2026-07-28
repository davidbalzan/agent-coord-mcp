import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AGENTS_FILE, ROOT, SCOPES_FILE, readJson } from "../store.js";
import { resolveRole, roleMatches, slugifyRole } from "../roles.js";
import type { AgentRegistry } from "./shared.js";

// ---------- document write scopes (Phase 8 Task 4) ----------
//
// ADVISORY, AND THAT IS DELIBERATE. Nothing here can stop a write: agents edit
// docs/QUEUE.md, DONE.md and WORKSTREAMS.md with ordinary file tools, which
// never touch the bus, so there is no point at which the server could refuse
// one. What this module gives you is:
//
//   list_scopes  — ask "who owns this document, may I write it?" BEFORE writing
//   doctor       — detect, after the fact, that the last writer wasn't the owner
//
// Pre-emptive enforcement arrives with Task 5 (work state as data in the
// store, where the bus IS the write path). Until then, do not describe a
// declared scope as a guarantee — it is a convention with a smoke detector.

// On-disk shape. Either the flat form:
//   { "docs/QUEUE.md": {"owner": "aide", "mode": "exclusive"} }
// or, when the documents don't live next to the bus's cwd:
//   { "repo": "/path/to/repo", "documents": { ...same map... } }
export type ScopeMode = "exclusive" | "append-only" | "shared";
export type ScopeEntry = { owner: string; mode?: ScopeMode; note?: string };
export type ScopesFile =
  | Record<string, ScopeEntry>
  | { repo?: string; documents: Record<string, ScopeEntry> };

export type LoadedScopes = {
  configured: boolean;
  file: string;
  repo: string;
  documents: { path: string; owner: string; mode: ScopeMode; note?: string }[];
};

function isWrapped(raw: ScopesFile): raw is { repo?: string; documents: Record<string, ScopeEntry> } {
  return typeof (raw as { documents?: unknown }).documents === "object" &&
    (raw as { documents?: unknown }).documents !== null;
}

// Absent file → configured:false, empty document list. Never throws: a broken
// scopes.json degrades to "nothing declared" rather than taking a tool down.
export async function loadScopes(): Promise<LoadedScopes> {
  const empty: LoadedScopes = { configured: false, file: SCOPES_FILE, repo: process.cwd(), documents: [] };
  if (!existsSync(SCOPES_FILE)) return empty;
  const raw = await readJson<ScopesFile | null>(SCOPES_FILE, null);
  if (!raw || typeof raw !== "object") return empty;

  const map = isWrapped(raw) ? raw.documents : (raw as Record<string, ScopeEntry>);
  const repo = isWrapped(raw) && raw.repo ? raw.repo : process.cwd();
  const documents = Object.entries(map ?? {})
    .filter(([, e]) => e && typeof e === "object" && typeof e.owner === "string")
    .map(([p, e]) => ({
      path: p.replace(/^\.\//, ""),
      owner: e.owner,
      mode: (e.mode ?? "exclusive") as ScopeMode,
      ...(e.note ? { note: e.note } : {}),
    }));
  return { configured: true, file: SCOPES_FILE, repo, documents };
}

// Does `agent` own `doc`? An owner is a roleId (matched through the same
// resolution the rest of Task 4 uses) or a bare agentId, so a document can be
// pinned to a role ("aide") or to one specific agent ("david-worker-2").
export function ownsDocument(
  agentId: string | undefined,
  entry: { agentId?: string; role?: string; roleId?: string } | undefined,
  owner: string,
): boolean {
  const target = slugifyRole(owner);
  if (agentId && slugifyRole(agentId) === target) return true;
  return roleMatches(entry, new Set([target]));
}

export const listScopesSchema = {
  // Ask about one document instead of listing everything.
  path: z.string().optional(),
  // Whose write is being contemplated (defaults to nobody — a pure listing).
  agentId: z.string().optional(),
};

export async function listScopesTool(args: { path?: string; agentId?: string }) {
  const scopes = await loadScopes();
  const reg = await readJson<AgentRegistry>(AGENTS_FILE, {});
  const entry = args.agentId ? reg[args.agentId] : undefined;

  // Every answer carries `advisory: true`. A caller that stores this verdict
  // is storing an opinion, not a permission.
  const base = {
    ok: true as const,
    advisory: true as const,
    configured: scopes.configured,
    file: scopes.file,
    repo: scopes.repo,
    note: scopes.configured
      ? "declared scopes are advisory — the bus does not mediate file writes (Phase 8 Task 5)"
      : `no ${path.basename(SCOPES_FILE)} in ${ROOT} — no document is owned, nothing is checked (opt-in)`,
  };

  if (args.path === undefined) {
    return {
      ...base,
      documents: scopes.documents,
      ...(args.agentId
        ? { you: { agentId: args.agentId, role: resolveRole(entry) ?? null } }
        : {}),
    };
  }

  const wanted = args.path.replace(/^\.\//, "");
  const doc = scopes.documents.find((d) => d.path === wanted);
  if (!doc) {
    return { ...base, path: wanted, owned: false, mayWrite: true, reason: "no scope declared for this document" };
  }
  const mine = args.agentId ? ownsDocument(args.agentId, entry, doc.owner) : false;
  return {
    ...base,
    path: doc.path,
    owned: true,
    owner: doc.owner,
    mode: doc.mode,
    ...(doc.note ? { docNote: doc.note } : {}),
    mayWrite: mine || doc.mode === "shared",
    reason: mine
      ? `'${args.agentId}' matches the declared owner '${doc.owner}'`
      : doc.mode === "shared"
        ? `declared shared — any agent may write, '${doc.owner}' is the maintainer`
        : `owned by '${doc.owner}' (${doc.mode})${args.agentId ? `; '${args.agentId}' does not match` : ""} — coordinate before writing`,
  };
}

// ---------- last-writer lookup (used by doctor's scope-drift check) ----------

export type LastWriter = { author: string; email: string; commit: string; when: string };

export function isGitRepo(repo: string): boolean {
  if (!existsSync(repo)) return false;
  const r = spawnSync("git", ["-C", repo, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  return r.status === 0 && String(r.stdout).trim() === "true";
}

// Last commit that touched `file`, or null if git has never seen it. Cheap
// (`-1`), read-only, and confined to `repo`.
export function lastWriterOf(repo: string, file: string): LastWriter | null {
  const r = spawnSync(
    "git",
    ["-C", repo, "log", "-1", "--format=%an%x00%ae%x00%h%x00%aI", "--", file],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return null;
  const line = String(r.stdout).trim();
  if (!line) return null;
  const [author = "", email = "", commit = "", when = ""] = line.split("\0");
  return { author, email, commit, when };
}

// Map a commit author back to a bus agent. Git records humans (or one shared
// machine account), not agent ids, so this only succeeds when the author name
// or email local-part IS a registered agentId or its role id — which is the
// honest limit of the check. Unmappable authors are reported as such by doctor
// instead of being counted as drift.
export function attributeWriter(writer: LastWriter, reg: AgentRegistry): { agentId: string; roleId?: string } | null {
  const candidates = new Set(
    [writer.author, writer.email.split("@")[0] ?? ""].map(slugifyRole).filter(Boolean),
  );
  for (const [agentId, entry] of Object.entries(reg)) {
    const resolved = resolveRole(entry);
    if (candidates.has(slugifyRole(agentId)) || (resolved && candidates.has(resolved.roleId))) {
      return { agentId, ...(resolved ? { roleId: resolved.roleId } : {}) };
    }
  }
  return null;
}
