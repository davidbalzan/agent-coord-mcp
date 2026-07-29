// Build identity of the RUNNING server process.
//
// The principle is the #28 pusher-freshness fix carried one layer up: stamp
// what you LOADED at init, compare against what's on disk NOW, and resolve the
// measured artifact from the code that is actually executing
// (import.meta.url), never from configuration — the thing that measures must
// be the thing that ran. A server process outlives `npm run build`; without a
// load-time sample there is nothing truthful to compare the on-disk build to,
// and a server running pre-rebuild code stamps transport markers with logic
// the rebuild replaced (observed live 2026-07-29: post-#28 attach spawned a
// pusher with no `--agent` argv and a single-file freshness stamp, agreeing
// with the new on-disk check only by coincidence).

import { readdirSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Newest mtime (epoch ms) across every file under `dir` (recursive) whose
// name ends with one of `exts`. Returns undefined when the dir is missing or
// unreadable — callers skip their check rather than guess. Pure over its
// arguments so tests exercise it on temp trees instead of touching real
// sources (a utimes on a shared checkout flips every live pusher's freshness
// while the suite runs files in parallel).
export function newestMtimeUnder(dir: string, exts: string[]): number | undefined {
  try {
    let newest: number | undefined;
    for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
      const name = String(rel);
      if (!exts.some((e) => name.endsWith(e))) continue;
      let m: number;
      try {
        m = statSync(path.join(dir, name)).mtimeMs;
      } catch {
        continue; // deleted mid-scan
      }
      if (newest === undefined || m > newest) newest = m;
    }
    return newest;
  } catch {
    return undefined;
  }
}

// The dir this module was loaded FROM: dist/ in production, src/ under tsx.
// Either way it is the code actually running, which is the point.
export const BUILD_DIR = path.dirname(fileURLToPath(import.meta.url));

// .js for the compiled build, .ts for dev-mode (tsx src/server.ts) — both
// sides of every comparison use the same list, so the two modes are each
// self-consistent and can never be compared across.
const BUILD_EXTS = [".js", ".ts"];

// Sampled ONCE at module load: the newest mtime across the build this server
// process actually imported. A later `npm run build` rewrites dist/ under a
// still-running server; this value stays behind, which is exactly what
// doctor's server-build-drift check compares against.
export const SERVER_BUILD_MTIME: number | undefined = newestMtimeUnder(BUILD_DIR, BUILD_EXTS);

// The on-disk side of the comparison, statted fresh per call.
// AGENT_COORD_DIST_DIR is a test seam only: it redirects what doctor
// MEASURES so tests can stage a newer/older build in a temp dir — it never
// changes what the server loads.
export function onDiskBuildMtime(): number | undefined {
  const dir = process.env.AGENT_COORD_DIST_DIR ?? BUILD_DIR;
  return newestMtimeUnder(dir, BUILD_EXTS);
}

// The uncompiled side of the dist-behind-source comparison: newest mtime
// across src/**/*.ts, resolved as BUILD_DIR's sibling. undefined on a
// packaged install with no src/ (callers report "nothing to compare", never
// warn). Under tsx dev-mode BUILD_DIR *is* src/, so the comparison degrades
// to src-vs-src and reads ok — dev-mode has no build to fall behind.
// AGENT_COORD_SRC_DIR is the same test seam as AGENT_COORD_DIST_DIR:
// it redirects measurement only.
export function onDiskSourceMtime(): number | undefined {
  const dir = process.env.AGENT_COORD_SRC_DIR ?? path.resolve(BUILD_DIR, "..", "src");
  return newestMtimeUnder(dir, [".ts"]);
}

// Best-effort checkout identity, report-only: lets doctor NAME the build
// (`branch@sha` would be nicer, but HEAD's sha alone already makes
// mutable-checkout drift visible, which is all this claims). undefined when
// not a git checkout (npm install) — never an error.
export const SERVER_BUILD_SHA: string | undefined = (() => {
  try {
    let gitDir = path.resolve(BUILD_DIR, "..", ".git");
    const st = statSync(gitDir);
    if (st.isFile()) {
      // A worktree's .git is a pointer file: "gitdir: <real dir>".
      const ptr = readFileSync(gitDir, "utf8").trim();
      if (!ptr.startsWith("gitdir:")) return undefined;
      gitDir = ptr.slice("gitdir:".length).trim();
    }
    const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return head.slice(0, 12); // detached
    const ref = head.slice(4).trim();
    try {
      return readFileSync(path.join(gitDir, ref), "utf8").trim().slice(0, 12);
    } catch {
      // Ref may be packed. commondir handling is deliberately out of scope —
      // best-effort means undefined beats wrong.
      const packed = readFileSync(path.join(gitDir, "packed-refs"), "utf8");
      for (const line of packed.split("\n")) {
        if (line.endsWith(` ${ref}`)) return line.slice(0, 12);
      }
      return undefined;
    }
  } catch {
    return undefined;
  }
})();
