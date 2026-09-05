# Contributing to deepseek-tui

deepseek-tui is a terminal frontend for the DeepSeek Harness — an Ink chat UI bundled as a Cordis plugin that boots in-process via a harness profile. The commit conventions below codify the owner's style so any developer or agent can produce uniform history in this repository.

## Commit Message Conventions

### Component grouping

- Derive the component label at commit time from the first top-level path segment of the changed files inside this repository — never from a fixed list. Humanize the segment into a title-case label for the subject.
  - Files under `src/`, e.g. `src/index.tsx` → `[Src]`.
  - Root-level files not under any top-level directory — `AGENTS.md`, `package.json`, `cordis.patch.yml`, `tsconfig.json` → `[Repo]`.
  - The rule is layout-relative: if the repository later grows a `docs/` directory, its files commit as `[Docs]`; a future `packages/` split labels its files `[Packages]`.
- Dot-directories that hold tool configuration use their conventional label: `.github/...` → `[GitHub]`.
- Tightly-coupled spans across components combine with `/` — e.g. removing a root-level entry after moving it under `src/` and updating `package.json` to match → `[Repo/Src]`.
- When a change spans the whole product with no honest single top-level owner, use the smallest shared label that fits — e.g. a bundle-wide rename touching `src/`, `cordis.patch.yml`, and `package.json` → `[Tui]`.
- Keep the component label human-readable and in title case inside the commit subject.

### Commit workflow

- Create one commit per top-level component; never mix unrelated components into one commit.
- Stage per component and review the staged diff before committing; never `git add -A`.
- If a change cannot be split safely across components, use the smallest honest shared label that fits (`[Tui]`) or ask.

### Subject line format

```
[Component] - Summary
```

Examples:

```
[Src] - Render followup events with streaming markdown
[Repo] - Document profile boot commands in AGENTS.md
[Repo/Src] - Fold root bootstrap into src entry and update package.json exports
[Tui] - Rename plugin id across bundle config, package, and app entry
```

### Subject line rules

- Put the component name in square brackets, followed by a space, a dash, and a space.
- Write the summary in sentence style, not title case.
- Capitalize the first letter of the sentence, proper names, and short all-caps terms when needed.
- Keep the summary concise and specific.

### Body rules

- Add detail lines after a blank line, as short sentences or wrapped prose.
- Capitalize the first letter of each sentence, proper names, and short all-caps terms when appropriate.
- Mention the key files or behavior changes when that helps explain the commit.
- If the commit is trivial, keep the body brief rather than omitting it entirely.
- Only list the actual authors of the changes. An agent that merely executes the commit (runs `git commit`) but did not contribute to the code or content changes is NOT a co-author and MUST NOT be listed.
- End the body with a blank line followed by a signature line:
  - If an agent authored the changes, always sign with the main session agent's identity: `OpenCode` followed by the session's model id (e.g. `OpenCode - deepseek-v4-flash`). An executing subagent signs as the delegating main agent (`OpenCode`) — never with its own subagent name, and never with the orchestrator's or another model's identity.
  - If the user authored the changes and an agent is only committing, use the user's git config `user.name` and `user.email`.
  - If the changes are co-authored by the user and one or more agents, include one line per author in this order: user, leading agent, remaining agents in alphabetical order.
- Do NOT use `Co-Authored-By` or any other signature form.
