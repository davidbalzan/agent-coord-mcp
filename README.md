# agent-coord-mcp — archived mirror

**Do not clone this repository to run a live bus.** Fast-forwarding it so `git pull` keeps `dist/server.js` recreates the decoy-clone failure (LESSONS #35).

Last runnable SHA on this remote: `2b8988fd84cd88408edef447909a367aef9ded98`.

Source of truth is [`davidbalzan/groundwork-kit`](https://github.com/davidbalzan/groundwork-kit) (`packages/coord-mcp`). The runnable artifact is the npm package:

```sh
npm i -g agent-coord-mcp
claude mcp add --scope user agent-coord -- agent-coord-mcp
# hooks: $(npm root -g)/agent-coord-mcp/hooks/peek-coord.mjs
```

Or, if you accept one mutable checkout (the kit):

```sh
node /absolute/path/to/groundwork-kit/packages/coord-mcp/dist/server.js
```

This default branch is frozen. Issues and PRs belong on the kit. There is no publish button here.

