# Tab Harbor Agent Guide

This file captures project-level design and implementation constraints for agents working in this repository.

## Design Direction

1. Tab Harbor is a quiet browser workspace, not a SaaS dashboard, wallpaper page, or gamified productivity product.
2. Preserve the calm / literary / composed identity. Interfaces should feel like a reading desk or paper workspace.
3. Prefer scanability over spectacle. If a change makes the page louder before it makes it clearer, reject it.
4. Keep secondary controls quiet. Theme controls, drawer triggers, archive actions, and helper affordances must not visually outrank tab content.
5. Avoid decorative chrome that does not improve hierarchy, orientation, or atmosphere.

## UI Guardrails

1. Do not rely on hover alone for critical controls or discoverability.
2. Keyboard focus must stay visible and usable.
3. Reduced-motion users must still understand every state change without animation.
4. Compact controls still need comfortable hit targets.
5. Theme changes must update the full environment, not just local controls.

## Interaction Lessons

1. Floating editors triggered from compact controls should anchor near the triggering element when practical; default corner placement is only a fallback.
2. For dense icon reordering, prefer explicit grid tracks over `flex-wrap` when cross-row drag behavior matters.
3. For icon drag-and-drop previews, use `ghost + slot` instead of converting the original node to `position: fixed`; keep the dragged visual under the pointer and the layout slot in the flow.
4. Drag preview hit-testing should be based on stable slot positions captured at drag start, not on the currently reflowing DOM alone.
5. FLIP animations in reorderable icon strips should only run for nodes whose order actually changed; avoid re-animating unaffected siblings.

## Frontend Architecture

1. This project is plain HTML, CSS, and ordered `<script>` tags with no bundler or ESM module system.
2. Script load order is part of the runtime contract. Treat changes to `index.html` script order as high impact.
3. Top-level bindings can collide across files. When destructuring from `globalThis`, use file-scoped prefixed aliases instead of shared short names.
4. Keep `extension/app.js` as a thin orchestrator entry. Do not let it grow back into a catch-all runtime file.
5. Prefer responsibility-based module boundaries such as:
   - `ui-helpers.js`
   - `theme-controls.js`
   - `drawer-manager.js`
   - `dashboard-runtime.js`

## Refactor Safety

1. After any script split, actively check for startup-time failures such as `Identifier has already been declared`.
2. A passing `node --test extension/*.test.js` run is necessary but not sufficient for startup refactors.
3. If the page shows static scaffolding but not dynamic tab data, first suspect runtime initialization failure before changing data logic.
4. For startup regressions, inspect real browser console/runtime errors before continuing to refactor.

## Validation

1. Run `node --test extension/*.test.js` after code changes that affect UI structure, script loading, or runtime behavior.
2. For script-loading or initialization changes, also verify the extension in a real browser session.

## Reference

Detailed rationale and lessons learned live in:
- `docs/design-principles-and-lessons.md`
- `.impeccable.md`

%% lat:begin %%
# Before starting work

- Run `lat search` to find sections relevant to your task. Read them to understand the design intent before writing code.
- Run `lat expand` on user prompts to expand any `[[refs]]` — this resolves section names to file locations and provides context.

# Post-task checklist (REQUIRED — do not skip)

After EVERY task, before responding to the user:

- [ ] Update `lat.md/` if you added or changed any functionality, architecture, tests, or behavior
- [ ] Run `lat check` — all wiki links and code refs must pass
- [ ] Do not skip these steps. Do not consider your task done until both are complete.

---

# What is lat.md?

This project uses [lat.md](https://www.npmjs.com/package/lat.md) to maintain a structured knowledge graph of its architecture, design decisions, and test specs in the `lat.md/` directory. It is a set of cross-linked markdown files that describe **what** this project does and **why** — the domain concepts, key design decisions, business logic, and test specifications. Use it to ground your work in the actual architecture rather than guessing.

# Commands

```bash
lat locate "Section Name"      # find a section by name (exact, fuzzy)
lat refs "file#Section"        # find what references a section
lat search "natural language"  # semantic search across all sections
lat expand "user prompt text"  # expand [[refs]] to resolved locations
lat check                      # validate all links and code refs
```

Run `lat --help` when in doubt about available commands or options.

If `lat search` fails because no API key is configured, explain to the user that semantic search requires a key provided via `LAT_LLM_KEY` (direct value), `LAT_LLM_KEY_FILE` (path to key file), or `LAT_LLM_KEY_HELPER` (command that prints the key). Supported key prefixes: `sk-...` (OpenAI) or `vck_...` (Vercel). If the user doesn't want to set it up, use `lat locate` for direct lookups instead.

# Syntax primer

- **Section ids**: `lat.md/path/to/file#Heading#SubHeading` — full form uses project-root-relative path (e.g. `lat.md/tests/search#RAG Replay Tests`). Short form uses bare file name when unique (e.g. `search#RAG Replay Tests`, `cli#search#Indexing`).
- **Wiki links**: `[[target]]` or `[[target|alias]]` — cross-references between sections. Can also reference source code: `[[src/foo.ts#myFunction]]`.
- **Source code links**: Wiki links in `lat.md/` files can reference functions, classes, constants, and methods in TypeScript/JavaScript/Python/Rust/Go/C files. Use the full path: `[[src/config.ts#getConfigDir]]`, `[[src/server.ts#App#listen]]` (class method), `[[lib/utils.py#parse_args]]`, `[[src/lib.rs#Greeter#greet]]` (Rust impl method), `[[src/app.go#Greeter#Greet]]` (Go method), `[[src/app.h#Greeter]]` (C struct). `lat check` validates these exist.
- **Code refs**: `// @lat: [[section-id]]` (JS/TS/Rust/Go/C) or `# @lat: [[section-id]]` (Python) — ties source code to concepts

# Test specs

Key tests can be described as sections in `lat.md/` files (e.g. `tests.md`). Add frontmatter to require that every leaf section is referenced by a `// @lat:` or `# @lat:` comment in test code:

```markdown
---
lat:
  require-code-mention: true
---
# Tests

Authentication and authorization test specifications.

## User login

Verify credential validation and error handling for the login endpoint.

### Rejects expired tokens
Tokens past their expiry timestamp are rejected with 401, even if otherwise valid.

### Handles missing password
Login request without a password field returns 400 with a descriptive error.
```

Every section MUST have a description — at least one sentence explaining what the test verifies and why. Empty sections with just a heading are not acceptable. (This is a specific case of the general leading paragraph rule below.)

Each test in code should reference its spec with exactly one comment placed next to the relevant test — not at the top of the file:

```python
# @lat: [[tests#User login#Rejects expired tokens]]
def test_rejects_expired_tokens():
    ...

# @lat: [[tests#User login#Handles missing password]]
def test_handles_missing_password():
    ...
```

Do not duplicate refs. One `@lat:` comment per spec section, placed at the test that covers it. `lat check` will flag any spec section not covered by a code reference, and any code reference pointing to a nonexistent section.

# Section structure

Every section in `lat.md/` **must** have a leading paragraph — at least one sentence immediately after the heading, before any child headings or other block content. The first paragraph must be ≤250 characters (excluding `[[wiki link]]` content). This paragraph serves as the section's overview and is used in search results, command output, and RAG context — keeping it concise guarantees the section's essence is always captured.

```markdown
# Good Section

Brief overview of what this section documents and why it matters.

More detail can go in subsequent paragraphs, code blocks, or lists.

## Child heading

Details about this child topic.
```

```markdown
# Bad Section

## Child heading

Details about this child topic.
```

The second example is invalid because `Bad Section` has no leading paragraph. `lat check` validates this rule and reports errors for missing or overly long leading paragraphs.
%% lat:end %%
