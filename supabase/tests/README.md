# Shared board database verification

Apply `../migrations/20260923_shared_board.sql` once to the selected Supabase project, after checking for existing objects. The migration creates one `running-pledge` board. It does not import browser history, pending eggs, or personal settings.

Run `shared_board_verify.sql` as the migration owner, normally `postgres`, before inviting users. The file takes the board lock, runs the assertions, and rolls back all test writes and request records. It also resets temporary role changes. With an already configured local connection, run:

```powershell
psql --set=ON_ERROR_STOP=1 --file=supabase/tests/shared_board_verify.sql
```

The success row is `shared-board verification passed; all test writes were rolled back`. Any exception is a failure. Run the entire file in one connection; do not execute its statements individually with autocommit. No password, connection string, or service key belongs in this repository.

The script checks:

- Singleton enforcement, item constraints, RLS, table grants, private helper isolation, and fixed function search paths.
- Anonymous reads and writes through the two RPCs, with direct table operations denied; authenticated RPC access is also checked.
- Successful revision increments, stale-revision conflicts, exact retry responses after another client saves, and rejected reuse of a request ID with different inputs.
- Item field whitelist, duplicate IDs, bounds, types, unknown tiers, invalid colors, malformed arguments, and preservation of blank/disabled editor state.
- Transactional pruning to 512 request records and rejection of a stale retry after its cached response has been pruned.

`bbob_get_board()` returns `{items, revision, updated_at}`. `bbob_save_board(p_expected_revision, p_items, p_request_id)` returns `{status: "ok" | "conflict", board: {items, revision, updated_at}}`. The revision is a JSON number bounded to JavaScript's safe-integer range. Invalid arguments and conflicting reuse of a cached request ID raise SQLSTATE `22023`.

Successful retries must reuse both the original expected revision and UUID. Cached retries return the original successful board snapshot, which can be older than the current board. The client should merge or refresh accordingly. After 512 newer successful saves, an old request's expected revision still prevents duplicate application, but the response becomes `conflict` instead of its expired cached success.

The private label validator counts UTF-16 code units, matching JavaScript: 30 supplementary emoji characters fit the 60-unit limit, while 31 do not. IDs use 1–128 ASCII letters, digits, underscores or hyphens, covering UUIDs and seeded IDs. Blank names and incomplete tier sets can be saved; the draw interface enforces that all four tiers are ready.

This single-connection script checks stale-client behavior. After deployment, additionally send two concurrent REST saves with the same expected revision: different request IDs must produce one success and one conflict; the same request ID and payload must return identical success responses without two revision increments. Also verify that direct REST table access fails and that two browser sessions observe a shared update. Those network checks are separate from this rollback-only SQL script.

The anonymous API intentionally permits everyone with the public application endpoint to edit the same list. There is no per-user ownership rule and no rate limiter in this migration. Request-log storage is bounded.

References: [Supabase function permissions](https://supabase.com/docs/guides/database/functions), [Supabase API grants and RLS](https://supabase.com/docs/guides/api/securing-your-api), [PostgreSQL security-definer guidance](https://www.postgresql.org/docs/current/sql-createfunction.html).
