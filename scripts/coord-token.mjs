#!/usr/bin/env node
// coord-token — mint / list / revoke per-agent bearer tokens in tokens.json.
//
// Closes the operator side of low-barrier node onboarding: instead of
// hand-editing tokens.json (and getting its perms right), mint a token for a
// node in one command, then paste it into coord-node on that machine.
//
// Usage:
//   scripts/coord-token.mjs add <agent-id>       mint (or rotate) a token, print it
//   scripts/coord-token.mjs list                 list agent ids (never prints tokens)
//   scripts/coord-token.mjs revoke <agent-id>    remove a token
//   [--dir <coord-dir>]                          override AGENT_COORD_DIR
//
// tokens.json is created 0600 (and re-chmod'd on every write) so secrets are
// never group/other-readable. After add/revoke, SIGHUP the running bus to
// reload its token map (kill -HUP <bus-pid>).

import { randomBytes } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
function opt(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
function die(msg) {
  process.stderr.write(`coord-token: ${msg}\n`);
  process.exit(1);
}

// Must match store.ts ROOT/TOKENS_FILE resolution exactly, or we'd write a file
// the bus never reads.
const ROOT =
  opt("--dir") ??
  process.env.AGENT_COORD_DIR ??
  process.env.CLAUDE_COORD_DIR ??
  path.join(homedir(), "agent-coord");
const TOKENS_FILE = path.join(ROOT, "tokens.json");

const AGENT_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;

function load() {
  if (!existsSync(TOKENS_FILE)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(TOKENS_FILE, "utf8"));
  } catch (e) {
    die(`${TOKENS_FILE} is not valid JSON: ${e.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    die(`${TOKENS_FILE} must be a JSON object of { "agent-id": "token" }`);
  }
  return parsed;
}

function save(map) {
  mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  writeFileSync(TOKENS_FILE, JSON.stringify(map, null, 2) + "\n", {
    mode: 0o600,
  });
  chmodSync(TOKENS_FILE, 0o600); // enforce even when the file pre-existed looser
}

const positional = argv.filter((a) => !a.startsWith("--"));
const cmd = positional[0];
const id = positional[1];

switch (cmd) {
  case "add": {
    if (!id || !AGENT_ID_RE.test(id)) {
      die("usage: coord-token add <agent-id>  (id: [a-zA-Z0-9._-], <=64 chars)");
    }
    const map = load();
    const rotating = id in map;
    const token = "tk_" + randomBytes(24).toString("base64url");
    // Guard the astronomically unlikely collision that would collapse two
    // identities onto one token in the bus's reverse map.
    if (Object.values(map).includes(token)) die("token collision — rerun");
    map[id] = token;
    save(map);
    process.stderr.write(
      `${rotating ? "rotated" : "minted"} token for '${id}' in ${TOKENS_FILE}\n`,
    );
    process.stderr.write(
      `SIGHUP the running bus to load it (kill -HUP <bus-pid>), then on the node:\n` +
        `  AGENT_COORD_TOKEN=${token} scripts/coord-node.sh --server <url> --id ${id} --cmd claude\n`,
    );
    process.stdout.write(token + "\n"); // token alone on stdout, pipe/capture-friendly
    break;
  }
  case "list": {
    const ids = Object.keys(load());
    if (ids.length === 0) {
      process.stderr.write("no tokens configured\n");
      break;
    }
    for (const a of ids) process.stdout.write(a + "\n");
    break;
  }
  case "revoke": {
    if (!id) die("usage: coord-token revoke <agent-id>");
    const map = load();
    if (!(id in map)) die(`no token for '${id}'`);
    delete map[id];
    save(map);
    process.stderr.write(`revoked '${id}'. SIGHUP the bus to apply.\n`);
    break;
  }
  default:
    process.stderr.write(
      "coord-token — per-agent bus tokens\n" +
        "  coord-token add <agent-id>     mint/rotate a token (prints it)\n" +
        "  coord-token list               list agent ids\n" +
        "  coord-token revoke <agent-id>  remove a token\n" +
        "  [--dir <coord-dir>]\n",
    );
    process.exit(cmd ? 1 : 0);
}
