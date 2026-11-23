[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tamadung/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tamadung/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

`mend` is one command-line patch tool for every AI edit format: it applies
unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A
patches, and JSON text-editor tool calls to a tree of text files, to the
specification in the kit's `SPEC.md`. It finds the lines an edit names at the
first of three matching tiers (exact, trailing-whitespace-insensitive,
fully-whitespace-insensitive with re-indentation), and changes every file or
none — a failed edit is reported and nothing is written.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, or `-` / absent for standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`,
  `json`; `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: `0` with one line per changed path (`A`/`D`/`M`, or
`R old -> new` for a move) plus `ok: <n> files`; `1` with one
`error: <code> <path>` line per failed edit plus `failed: <k> of <n> edits`;
`2` with one line (`error: usage`, `error: no-patch`, `error: format`, or
`error: parse <N>`) for a patch that cannot be read at all.

## Files

- `main.ts` — the CLI, Node 22 and its standard library alone.
- `runner.ts` — the kit's trial runner (kept as shipped).
- `check.ts` — runs `main.ts` on the kit's public practice set:
  `node check.ts <practice.json>`.

## Results

- Public practice set: **100 of 100 checks passed, practice score 1000**
  (baseline starter: 24 of 100, score 240).
- 26 additional hand-built edge cases from SPEC.md sentences the practice
  set does not show (no-newline markers, empty-O insertion, chained moves,
  V4A anchors/cursors/EOF chunks, tier-2 re-indentation, CRLF files): all pass.
