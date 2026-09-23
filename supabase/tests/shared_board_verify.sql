-- Execute as the migration owner (normally postgres), after the migration.
-- All test writes, revisions and request records are rolled back together.
-- The singleton is locked during this check; run before inviting users.
-- psql: psql --set=ON_ERROR_STOP=1 --file=supabase/tests/shared_board_verify.sql

begin;
set local statement_timeout = '30s';
set local lock_timeout = '5s';

do $verify$
declare
  v_role text;
  v_count integer;
begin
  if (select count(*) from public.bbob_boards) <> 1 then
    raise exception 'Expected exactly one shared board.';
  end if;
  if not exists (select 1 from public.bbob_boards where id = 'running-pledge') then
    raise exception 'Expected the running-pledge singleton.';
  end if;
  select count(*) into v_count from pg_catalog.pg_class
  where oid in ('public.bbob_boards'::regclass, 'bbob_private.bbob_board_requests'::regclass)
    and relrowsecurity;
  if v_count <> 2 then raise exception 'RLS must be enabled on both tables.'; end if;

  foreach v_role in array array['anon', 'authenticated'] loop
    if pg_catalog.has_table_privilege(v_role, 'public.bbob_boards', 'SELECT,INSERT,UPDATE,DELETE')
      or pg_catalog.has_table_privilege(v_role, 'bbob_private.bbob_board_requests', 'SELECT,INSERT,UPDATE,DELETE') then
      raise exception 'Role % has direct table privileges.', v_role;
    end if;
    if pg_catalog.has_schema_privilege(v_role, 'bbob_private', 'USAGE')
      or pg_catalog.has_function_privilege(v_role, 'bbob_private.bbob_items_are_valid(jsonb)', 'EXECUTE')
      or pg_catalog.has_function_privilege(v_role, 'bbob_private.bbob_utf16_length(text)', 'EXECUTE') then
      raise exception 'Role % can access the private helper schema.', v_role;
    end if;
    if not pg_catalog.has_function_privilege(v_role, 'public.bbob_get_board()', 'EXECUTE')
      or not pg_catalog.has_function_privilege(v_role, 'public.bbob_save_board(bigint,jsonb,uuid)', 'EXECUTE') then
      raise exception 'Role % cannot execute both public RPCs.', v_role;
    end if;
  end loop;

  select count(*) into v_count from pg_catalog.pg_proc
  where oid in ('public.bbob_get_board()'::regprocedure,
    'public.bbob_save_board(bigint,jsonb,uuid)'::regprocedure)
    and prosecdef and proconfig @> array['search_path=""'];
  if v_count <> 2 then raise exception 'Both public RPCs must pin an empty search_path.'; end if;
  if exists (
    select 1 from pg_catalog.pg_proc as p,
      lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) as grants
    where p.oid in ('public.bbob_get_board()'::regprocedure,
      'public.bbob_save_board(bigint,jsonb,uuid)'::regprocedure)
      and grants.grantee = 0 and grants.privilege_type = 'EXECUTE'
  ) then raise exception 'PUBLIC still has EXECUTE on an API function.'; end if;

  begin
    insert into public.bbob_boards (id, items) values ('another-board', '[]');
    raise exception 'A second board ID was accepted.';
  exception when check_violation then null;
  end;
  begin
    update public.bbob_boards set items = '{}'::jsonb where id = 'running-pledge';
    raise exception 'The table constraint accepted invalid items.';
  exception when check_violation then null;
  end;
end;
$verify$;

set local role anon;

do $verify$
declare
  v_original jsonb := public.bbob_get_board();
  v_revision bigint := (v_original ->> 'revision')::bigint;
  v_item jsonb := '{"id":"verification-item","label":"검증 항목","tier":"high","color":"#edf1f4","enabled":true}'::jsonb;
  v_items jsonb;
  v_first_id uuid := pg_catalog.gen_random_uuid();
  v_first jsonb;
  v_second jsonb;
  v_reply jsonb;
  v_invalid jsonb;
  v_cases jsonb;
begin
  if pg_catalog.jsonb_typeof(v_original -> 'items') <> 'array'
    or v_original ->> 'updated_at' is null then
    raise exception 'Read RPC returned an invalid board shape.';
  end if;

  begin
    perform 1 from public.bbob_boards;
    raise exception 'Anonymous direct SELECT was allowed.';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.bbob_boards (id, items) values ('running-pledge', '[]');
    raise exception 'Anonymous direct INSERT was allowed.';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.bbob_boards set items = '[]'::jsonb where id = 'running-pledge';
    raise exception 'Anonymous direct UPDATE was allowed.';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.bbob_boards where id = 'running-pledge';
    raise exception 'Anonymous direct DELETE was allowed.';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from bbob_private.bbob_board_requests;
    raise exception 'Anonymous access to the request log was allowed.';
  exception when insufficient_privilege then null;
  end;

  v_items := pg_catalog.jsonb_build_array(v_item);
  v_first := public.bbob_save_board(v_revision, v_items, v_first_id);
  if v_first ->> 'status' <> 'ok'
    or (v_first -> 'board' ->> 'revision')::bigint <> v_revision + 1
    or (v_first -> 'board' -> 'items') is distinct from v_items then
    raise exception 'The initial CAS save did not commit exactly once.';
  end if;
  if public.bbob_get_board() is distinct from v_first -> 'board' then
    raise exception 'Read RPC did not return the committed board.';
  end if;

  v_second := public.bbob_save_board(v_revision + 1,
    pg_catalog.jsonb_build_array(v_item || '{"label":"두 번째 수정"}'::jsonb),
    pg_catalog.gen_random_uuid());
  if v_second ->> 'status' <> 'ok' then raise exception 'Second save failed.'; end if;
  v_reply := public.bbob_save_board(v_revision, v_items, v_first_id);
  if v_reply is distinct from v_first or public.bbob_get_board() is distinct from v_second -> 'board' then
    raise exception 'A retried request changed the board or lost its original response.';
  end if;

  v_reply := public.bbob_save_board(v_revision, v_items, pg_catalog.gen_random_uuid());
  if v_reply ->> 'status' <> 'conflict' or v_reply -> 'board' is distinct from v_second -> 'board' then
    raise exception 'A stale revision did not return the latest board as conflict.';
  end if;
  if public.bbob_get_board() is distinct from v_second -> 'board' then
    raise exception 'Conflict handling modified the stored board.';
  end if;

  begin
    perform public.bbob_save_board(v_revision, '[]'::jsonb, v_first_id);
    raise exception 'Reusing a request ID for different data was accepted.';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.bbob_save_board(v_revision + 1, v_items, v_first_id);
    raise exception 'Reusing a request ID with a different expected revision was accepted.';
  exception when invalid_parameter_value then null;
  end;

  v_revision := (v_second -> 'board' ->> 'revision')::bigint;
  v_cases := pg_catalog.jsonb_build_array(
    'null'::jsonb, '{}'::jsonb, pg_catalog.jsonb_build_array('not an object'),
    pg_catalog.jsonb_build_array(v_item - 'tier'),
    pg_catalog.jsonb_build_array(v_item || '{"label":42}'::jsonb),
    pg_catalog.jsonb_build_array(v_item || '{"id":""}'::jsonb),
    pg_catalog.jsonb_build_array(v_item || '{"id":"   "}'::jsonb),
    pg_catalog.jsonb_build_array(v_item || pg_catalog.jsonb_build_object('id', E'\t\n')),
    pg_catalog.jsonb_build_array(v_item || '{"id":"한글-id"}'::jsonb),
    pg_catalog.jsonb_build_array(v_item || pg_catalog.jsonb_build_object('id', pg_catalog.repeat('x', 129))),
    pg_catalog.jsonb_build_array(v_item || pg_catalog.jsonb_build_object('label', pg_catalog.repeat('가', 61))),
    pg_catalog.jsonb_build_array(v_item || pg_catalog.jsonb_build_object('label', pg_catalog.repeat('😀', 31))),
    pg_catalog.jsonb_build_array(v_item || pg_catalog.jsonb_build_object('label', pg_catalog.repeat('😀', 29) || '가가가')),
    pg_catalog.jsonb_build_array(v_item || '{"tier":"unknown"}'::jsonb),
    pg_catalog.jsonb_build_array(v_item || '{"color":"url(invalid)"}'::jsonb),
    pg_catalog.jsonb_build_array(v_item || '{"enabled":"true"}'::jsonb),
    pg_catalog.jsonb_build_array(v_item || '{"enabled":null}'::jsonb),
    pg_catalog.jsonb_build_array(v_item || '{"weight":20}'::jsonb),
    pg_catalog.jsonb_build_array(v_item || '{"history":[]}'::jsonb),
    pg_catalog.jsonb_build_array(v_item, v_item)
  );
  for v_invalid in select value from pg_catalog.jsonb_array_elements(v_cases) as cases(value)
  loop
    begin
      perform public.bbob_save_board(v_revision, v_invalid, pg_catalog.gen_random_uuid());
      raise exception 'An invalid item payload was accepted: %', v_invalid;
    exception when invalid_parameter_value then null;
    end;
  end loop;
  select pg_catalog.jsonb_agg(v_item || pg_catalog.jsonb_build_object('id', number::text))
  into v_invalid from pg_catalog.generate_series(1, 31) as numbers(number);
  begin
    perform public.bbob_save_board(v_revision, v_invalid, pg_catalog.gen_random_uuid());
    raise exception 'More than 30 items were accepted.';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.bbob_save_board(v_revision, null, pg_catalog.gen_random_uuid());
    raise exception 'SQL NULL items were accepted.';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.bbob_save_board(null, v_items, pg_catalog.gen_random_uuid());
    raise exception 'A NULL expected revision was accepted.';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.bbob_save_board(-1, v_items, pg_catalog.gen_random_uuid());
    raise exception 'A negative expected revision was accepted.';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.bbob_save_board(v_revision, v_items, null);
    raise exception 'A NULL request ID was accepted.';
  exception when invalid_parameter_value then null;
  end;
  if public.bbob_get_board() is distinct from v_second -> 'board' then
    raise exception 'Rejected requests changed the board.';
  end if;

  -- Editable state may have missing tiers, a blank name, or an empty list.
  v_reply := public.bbob_save_board(v_revision,
    pg_catalog.jsonb_build_array(v_item || '{"label":"","enabled":false}'::jsonb),
    pg_catalog.gen_random_uuid());
  if v_reply ->> 'status' <> 'ok' then raise exception 'Blank disabled editor row was rejected.'; end if;
  v_reply := public.bbob_save_board((v_reply -> 'board' ->> 'revision')::bigint,
    '[]'::jsonb, pg_catalog.gen_random_uuid());
  if v_reply ->> 'status' <> 'ok' then raise exception 'Empty editor state was rejected.'; end if;
  v_reply := public.bbob_save_board((v_reply -> 'board' ->> 'revision')::bigint,
    pg_catalog.jsonb_build_array(v_item || pg_catalog.jsonb_build_object('label', pg_catalog.repeat('😀', 30))),
    pg_catalog.gen_random_uuid());
  if v_reply ->> 'status' <> 'ok' then raise exception 'Exactly 60 UTF-16 units were rejected.'; end if;
end;
$verify$;

reset role;
set local role authenticated;

do $verify$
declare
  v_board jsonb := public.bbob_get_board();
  v_reply jsonb;
begin
  begin
    perform 1 from public.bbob_boards;
    raise exception 'Authenticated direct SELECT was allowed.';
  exception when insufficient_privilege then null;
  end;
  v_reply := public.bbob_save_board((v_board ->> 'revision')::bigint,
    v_board -> 'items', pg_catalog.gen_random_uuid());
  if v_reply ->> 'status' <> 'ok' then raise exception 'Authenticated RPC write failed.'; end if;
end;
$verify$;

reset role;

do $verify$
declare
  v_first_id uuid := pg_catalog.gen_random_uuid();
  v_original_revision bigint := (public.bbob_get_board() ->> 'revision')::bigint;
  v_revision bigint := v_original_revision;
  v_reply jsonb;
  v_iteration integer;
begin
  v_reply := public.bbob_save_board(v_revision, '[]'::jsonb, v_first_id);
  v_revision := (v_reply -> 'board' ->> 'revision')::bigint;
  for v_iteration in 1..512 loop
    v_reply := public.bbob_save_board(v_revision, '[]'::jsonb, pg_catalog.gen_random_uuid());
    v_revision := (v_reply -> 'board' ->> 'revision')::bigint;
  end loop;
  if (select count(*) from bbob_private.bbob_board_requests) <> 512 then
    raise exception 'Idempotency request storage did not remain bounded to 512 rows.';
  end if;
  if exists (select 1 from bbob_private.bbob_board_requests where request_id = v_first_id) then
    raise exception 'The oldest request was not pruned.';
  end if;
  v_reply := public.bbob_save_board(v_original_revision, '[]'::jsonb, v_first_id);
  if v_reply ->> 'status' <> 'conflict'
    or (public.bbob_get_board() ->> 'revision')::bigint <> v_revision then
    raise exception 'A pruned old retry reapplied a previously committed write.';
  end if;
end;
$verify$;

rollback;
select 'shared-board verification passed; all test writes were rolled back' as result;
