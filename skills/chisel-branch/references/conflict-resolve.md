# Integration conflict resolve protocol

This protocol is intentionally separate from normal branch conversion. It
keeps the integration worktree and the developer branch independent.

1. Read the external receipt path returned as `report_file` (under the sibling
   `.chisel-merge-receipts/` directory). Do not delete the report; it records
   `base`, `ours`, `theirs`, file classifications, and the target head observed
   before merge. Keeping it outside the integration worktree prevents
   `git add -A` from committing diagnostics.
2. Resolve only inside the integration worktree. Verify no unmerged entries:

   ```bash
   git -C <integration-worktree> diff --name-only --diff-filter=U
   git -C <integration-worktree> add <resolved-files>
   ```

3. With explicit user approval, continue. The command refuses to commit while
   unmerged entries remain, runs `git diff --check`, creates the integration
   commit, and optionally fetches/pushes without force:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/branch-merge.mjs --continue \
     --repo <repo> --integration-worktree <integration-worktree> \
     --verify-command-json '["npm","test"]' --confirm
   ```

   Pass each repository's required checks as a JSON argv array; commands run
   with `execFileSync` (no shell interpolation) and are recorded in the receipt.

4. Abort when the merge should be discarded. `--cleanup` is a separate,
   explicit choice; neither action deletes the development branch:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/branch-merge.mjs --abort \
     --repo <repo> --integration-worktree <integration-worktree> [--cleanup]
   ```
