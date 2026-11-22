[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bibitcuan1-boop/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bibitcuan1-boop/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend

`mend` is a single patch tool for every AI edit format. It reads a patch in
one of four formats — unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, V4A patches, or JSON edits — finds the lines each edit
names at the first of three matching tiers (exact, trailing-whitespace
insensitive, leading-and-trailing-whitespace insensitive), and writes every
change or none at all.

## Run

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file (relative to the working directory). When it is
  absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a`, `json`, or `auto` (the default, which detects it).
- `--check` does everything but write: same output and exit code, no file is
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: `0` when every edit applied, `1` when one or more edits failed
(`error: <code> <path>` per failed edit, then `failed: <k> of <n> edits`),
`2` on a usage, missing-patch, format-detection or parse error.

The full contract is `SPEC.md` in the competition kit: every sentence of it
is implemented, including empty-old insertions, `\ No newline at end of file`,
CRLF files, ambiguous matches, unsafe paths, renames/moves, JSON CRLF
handling, tier-2 re-indentation, hunk position `A-1+d`, V4A cursor/anchor
matching, and SEARCH/REPLACE path inference.

## Layout

- `main.ts` — the whole tool (Node 22, standard library only, no dependencies).
- `LICENSE` — MIT.

Built for the make.fun competition
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

---

Built with [make.fun](https://make.fun/r/1kbmej5w?ref=1kbmej5w)
