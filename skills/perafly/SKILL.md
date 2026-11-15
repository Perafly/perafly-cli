---
name: perafly
description: Publish websites with Perafly and manage their versions, data, files, environment variables and Git builds. Use when the user wants to publish, deploy, preview, promote, roll back or check a site on Perafly (*.perafly.app), store records or files for it, connect a folder or repository to a Perafly project, or publish from Git or CI.
---

# Perafly

Perafly turns a folder into a live address and keeps every version. Tools come from the Perafly MCP server (local:
`perafly mcp`, hosted: `https://mcp.perafly.com`). The same actions exist in the `perafly` CLI.

## Rules

1. **Read the schema first.** Read a tool's input schema before calling it. Don't guess parameter names.
2. **Verify writes.** After publishing or promoting, read the result back (`getProject`, `getProjectVersion`) and
   report the live URL only when the version is `ready` and `live` is true.
3. **Approvals.** Publishing over the live version or promoting with an agent sign-in needs a teammate's approval.
   You get `approval_required` with an execution id (`exe_…`) and an `approvalUrl`. Tell the user the URL, then call
   `resume_execution`. If it is still pending, wait and call it again. **Never start a second publish or promote
   instead of the waiting one.**
4. **Previews first.** While iterating, publish with `target: "preview"`: the version URL (`name--vN.perafly.app`)
   shows it without changing the live site. Promote when the user is happy.
5. **Never confirm on the user's behalf.** Don't add `--yes` or `PERAFLY_YES`. Destructive actions (deleting
   projects, keys, billing, members) are not available to agents.
6. **Long work.** If a tool returns an operation (`opr_…`), call `operation_status` with `wait: true`. Report success
   only when its status is `succeeded`.

## Publishing

- MCP: `publish` with `path` (local server: a folder inside the workspace, e.g. `dist`) or inline `files` (hosted).
  Omit `project` to create a new project; pass `name` to choose its address.
- CLI: `perafly publish ./dist --json`. Exit codes: 0 ok, 2 validation or missing confirmation (`approval_required`
  too, with `--no-wait`), 10 auth, 20 not found, 30 conflict, 40 network or rate limit, 50 wait timeout.
- Perafly doesn't build locally: publish the build output (`dist`, `build`, `out`). Secrets (`.env*`, keys),
  `.git` and `node_modules` are never uploaded.

## After publishing

- When a live site misbehaves, read its logs before changing code: MCP `listProjectLogs` (`level: "error"`,
  `stream: "runtime"`) or `perafly logs runtime --level error --json`. Metrics: `getProjectMetrics` or
  `perafly metrics --json` (`runsCode: false` means a static site; `null` means not measured, not zero).

## Data, storage and environment

Team projects (not projects without an account) have a headless data layer, file storage, environment variables and
SFTP accounts.

- **Collections.** `listCollections`, `getCollection`, `createCollection` (`name`, `fields`, `rules`, `hook`),
  `updateCollection` (`fields` is the full list; a field's type can't change). Only indexed fields (at most 5) can be
  filtered or sorted. CLI: `perafly data collections create posts --schema posts.schema.json`, `perafly data
  collections show posts --json`.
- **Records.** `listRecords` (`filter` is an object: `{ "status": "published", "views": { "gte": 100 } }`; operators
  `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`; `sort: "-createdAt"`), `getRecord`, `createRecord` and `updateRecord`
  (the record's fields go in `body`; `null` removes a field), `deleteRecord`. CLI: `perafly data ls posts --filter
  status=published --filter views:gte=100 --json`, `perafly data add posts --file record.json`. Read a record back
  after writing it.
- **Keys.** Connect the front end with the publishable key from `getDataKeys` (`pfp_…`, safe in the browser). A
  collection's `rules` decide what that key may do: you can make `create` public, but making `read`, `update` or
  `delete` public needs a person (`rule_requires_person`). Server code uses the `PERAFLY_SECRET_KEY` environment
  variable; never put it in the browser or in a file you publish.
- **Change hooks.** A collection's `hook` posts to a path on the live site; `listHookDeliveries` shows whether
  deliveries succeed. The site verifies them with `PERAFLY_WEBHOOK_SECRET`.
- **Storage.** `listStorage`, `getStorageFile`, `moveStorage`, `deleteStorage`. Paths start with `public/` (served at
  `https://<name>.perafly.app/_files/…`, even when the project is private) or `private/`. Upload with the CLI:
  `perafly storage put ./hero.jpg public/images/` or `perafly storage sync ./media public/media` (uploads missing or
  changed files, deletes nothing).
- **Environment variables.** `listEnvVars` (sensitive values never come back). Changes apply from the next version:
  publish again after the user sets one.
- **Only the user can** create or rotate keys, set or remove environment variables, open or revoke SFTP accounts,
  delete collections and export data. Ask them to run `perafly data keys --create-secret`, `perafly env set NAME`
  (the value comes from stdin or a hidden prompt, never an argument), `perafly sftp add <label> --key
  ~/.ssh/id_ed25519.pub` or `perafly data export <collection> --out file.csv`. Never ask for a secret in the chat
  and never pass one as a command argument.

## Git and CI

Team projects build from Git: a push to the production branch publishes to live, other branches become branch
previews at `https://<name>--br-<branch>.perafly.app`.

- **Read.** `getProjectGit` (GitHub repository or `null`, production branch, automatic deploys, `push.url`),
  `listGitBuilds` (`status`: `queued`, `running`, `succeeded`, `failed`, `superseded`, `awaiting_approval`,
  `canceled`; each build has `commit`, `version` and `branchUrl`), `listProjectBranches` (branch preview addresses and
  the version each serves). CLI: `perafly git --json`, `perafly git builds --json`, `perafly branches --json`. When a
  build fails, read its version's build log (`getBuildLog`) before changing code.
- **Direct push** (no GitHub): the user runs `perafly git remote` once in the repository, then `git push perafly
  HEAD:main`. The key is never put in the remote URL or Git's config; don't add it there.
- **CI.** `npx perafly publish ./dist` with the `PERAFLY_TOKEN` secret detects the branch and commit in GitHub Actions,
  GitLab CI, Bitbucket and CircleCI (or pass `--branch` and `--commit`). Without `--target`, the project's branch rule
  decides live or preview.
- **Only the user can** connect or disconnect a GitHub repository, change the production branch or automatic deploys
  (`perafly git set …`, `perafly git disconnect`), and approve a pull request build from a fork (`perafly git approve
  gbd_…`): a fork's code runs with the project's environment variables, so the user reads the pull request first.
  Never approve on their behalf.

## Without an account

Publishing without a sign-in creates a project that stays live for 24 hours after each publish. Its key is stored in
`.perafly/state.json` (never commit it). Tell the user they can keep it with `perafly projects claim`.

## Errors

Errors carry a stable `code` (RFC 9457). Common ones: `path_blocked` (a file isn't allowed), `noop_publish` / `noop`
(nothing changed), `approval_required`, `approval_declined`, `version_not_ready`, `rate_limited` (wait for
`Retry-After`). Data and storage: `field_not_indexed` (mark the field `indexed` to filter or sort by it),
`rule_requires_person`, `record_too_large` (64 KB), `storage_path_invalid` (paths start with `public/` or
`private/`), `storage_exists` (pass `overwrite`). `plan_limit_*` and `plan_feature_unavailable` (HTTP 402, CLI exit
30) mean the plan doesn't allow it: tell the user; don't work around it. Git: `git_build_not_awaiting` (the build is
not waiting for approval), `git_repository_not_found` (the repository isn't in the team's GitHub installations),
`github_not_configured` (GitHub isn't available; direct push still works).
