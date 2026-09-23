-- One intentionally public collaborative list. Draw history, pending eggs and
-- personal settings never enter this schema. Apply this entire migration once.
-- References: https://supabase.com/docs/guides/database/functions
--             https://supabase.com/docs/guides/api/securing-your-api

begin;

create schema if not exists bbob_private;
revoke all on schema bbob_private from public, anon, authenticated;

-- Supabase uses UTF8. Supplementary Unicode code points occupy two JavaScript
-- UTF-16 code units, so SQL char_length alone would accept invalid client state.
create function bbob_private.bbob_utf16_length(p_text text)
returns integer
language sql
immutable
strict
parallel safe
set search_path = ''
as $function$
  select pg_catalog.char_length(p_text) + (
    select pg_catalog.count(*)::integer
    from pg_catalog.generate_series(1, pg_catalog.char_length(p_text)) as characters(position)
    where pg_catalog.ascii(pg_catalog.substr(p_text, position, 1)) > 65535
  );
$function$;

revoke all on function bbob_private.bbob_utf16_length(text) from public, anon, authenticated;

create function bbob_private.bbob_items_are_valid(p_items jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $function$
declare
  v_item jsonb;
  v_id text;
  v_seen text[] := array[]::text[];
begin
  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array' then
    return false;
  end if;
  if pg_catalog.jsonb_array_length(p_items) > 30
    or pg_catalog.pg_column_size(p_items) > 65536 then
    return false;
  end if;

  for v_item in select value from pg_catalog.jsonb_array_elements(p_items) as entries(value)
  loop
    if pg_catalog.jsonb_typeof(v_item) <> 'object' then
      return false;
    end if;
    if not (v_item ?& array['id', 'label', 'tier', 'color'])
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(v_item) as fields(key)
        where key not in ('id', 'label', 'tier', 'color', 'enabled')
      ) then
      return false;
    end if;
    if pg_catalog.jsonb_typeof(v_item -> 'id') is distinct from 'string'
      or pg_catalog.jsonb_typeof(v_item -> 'label') is distinct from 'string'
      or pg_catalog.jsonb_typeof(v_item -> 'tier') is distinct from 'string'
      or pg_catalog.jsonb_typeof(v_item -> 'color') is distinct from 'string' then
      return false;
    end if;

    v_id := v_item ->> 'id';
    if v_id !~ '^[A-Za-z0-9_-]{1,128}$'
      or v_id = any(v_seen)
      or pg_catalog.char_length(v_item ->> 'label') > 60
      or (v_item ->> 'tier') not in ('high', 'medium', 'low', 'ultra')
      or pg_catalog.char_length(v_item ->> 'color') <> 7
      or (v_item ->> 'color') !~ '^#[0-9A-Fa-f]{6}$' then
      return false;
    end if;
    if bbob_private.bbob_utf16_length(v_item ->> 'label') > 60 then
      return false;
    end if;
    if v_item ? 'enabled'
      and pg_catalog.jsonb_typeof(v_item -> 'enabled') is distinct from 'boolean' then
      return false;
    end if;
    v_seen := pg_catalog.array_append(v_seen, v_id);
  end loop;
  -- Empty/unfinished lists are valid editor state; the client gates drawing.
  return true;
end;
$function$;

revoke all on function bbob_private.bbob_items_are_valid(jsonb) from public, anon, authenticated;

create table public.bbob_boards (
  id text primary key default 'running-pledge' check (id = 'running-pledge'),
  items jsonb not null check (bbob_private.bbob_items_are_valid(items)),
  revision bigint not null default 0 check (revision between 0 and 9007199254740991),
  updated_at timestamptz not null default pg_catalog.clock_timestamp()
);

create table bbob_private.bbob_board_requests (
  request_id uuid primary key,
  expected_revision bigint not null check (expected_revision between 0 and 9007199254740990),
  committed_revision bigint not null unique check (committed_revision = expected_revision + 1),
  response jsonb not null check (
    pg_catalog.jsonb_typeof(response) = 'object'
    and response ->> 'status' = 'ok'
    and pg_catalog.jsonb_typeof(response -> 'board') = 'object'
  ),
  created_at timestamptz not null default pg_catalog.clock_timestamp()
);

alter table public.bbob_boards enable row level security;
alter table bbob_private.bbob_board_requests enable row level security;
revoke all on table public.bbob_boards from public, anon, authenticated;
revoke all on table bbob_private.bbob_board_requests from public, anon, authenticated;

insert into public.bbob_boards (id, items)
values (
  'running-pledge',
  '[
    {"id":"penalty-1","label":"청소 20분","tier":"high","color":"#edf1f4"},
    {"id":"penalty-2","label":"설거지 전담","tier":"high","color":"#edf1f4"},
    {"id":"penalty-3","label":"친구에게 커피 사기","tier":"medium","color":"#639be9"},
    {"id":"penalty-4","label":"배달 대신 직접 요리","tier":"low","color":"#dfb956"},
    {"id":"penalty-5","label":"미뤄둔 일 30분","tier":"ultra","color":"#f5c331"}
  ]'::jsonb
);

-- These two tightly scoped DEFINER functions are the entire anonymous API.
-- They never accept a board ID, caller SQL, or any other table/column names.
create function public.bbob_get_board()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_board jsonb;
begin
  select pg_catalog.jsonb_build_object(
    'items', b.items, 'revision', b.revision, 'updated_at', b.updated_at
  ) into v_board
  from public.bbob_boards as b
  where b.id = 'running-pledge';

  if not found then
    raise exception using errcode = '55000', message = 'Shared board is not initialized.';
  end if;
  return v_board;
end;
$function$;

create function public.bbob_save_board(
  p_expected_revision bigint,
  p_items jsonb,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_board public.bbob_boards%rowtype;
  v_request bbob_private.bbob_board_requests%rowtype;
  v_snapshot jsonb;
  v_response jsonb;
begin
  if p_expected_revision is null or p_expected_revision < 0
    or p_expected_revision > 9007199254740991 or p_request_id is null then
    raise exception using errcode = '22023', message = 'A valid expected revision and request ID are required.';
  end if;
  if not bbob_private.bbob_items_are_valid(p_items) then
    raise exception using errcode = '22023', message = 'Invalid shared items.';
  end if;

  -- Every accepted write and deduplication check share this singleton row lock.
  select b.* into v_board from public.bbob_boards as b
  where b.id = 'running-pledge'
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'Shared board is not initialized.';
  end if;

  select r.* into v_request from bbob_private.bbob_board_requests as r
  where r.request_id = p_request_id;
  if found then
    if v_request.expected_revision <> p_expected_revision
      or (v_request.response -> 'board' -> 'items') is distinct from p_items then
      raise exception using errcode = '22023', message = 'Request ID was already used with different data.';
    end if;
    return v_request.response;
  end if;

  v_snapshot := pg_catalog.jsonb_build_object(
    'items', v_board.items, 'revision', v_board.revision, 'updated_at', v_board.updated_at
  );
  if v_board.revision <> p_expected_revision then
    return pg_catalog.jsonb_build_object('status', 'conflict', 'board', v_snapshot);
  end if;
  if v_board.revision = 9007199254740991 then
    raise exception using errcode = '54000', message = 'Shared board revision limit reached.';
  end if;

  update public.bbob_boards as b
  set items = p_items, revision = b.revision + 1, updated_at = pg_catalog.clock_timestamp()
  where b.id = 'running-pledge'
  returning b.* into v_board;

  v_snapshot := pg_catalog.jsonb_build_object(
    'items', v_board.items, 'revision', v_board.revision, 'updated_at', v_board.updated_at
  );
  v_response := pg_catalog.jsonb_build_object('status', 'ok', 'board', v_snapshot);
  insert into bbob_private.bbob_board_requests (
    request_id, expected_revision, committed_revision, response
  ) values (p_request_id, p_expected_revision, v_board.revision, v_response);

  -- Bound storage without a cron job. A pruned old request cannot reapply:
  -- its old expected revision will conflict with the monotonically newer board.
  delete from bbob_private.bbob_board_requests as stale
  where stale.request_id in (
    select request_id from bbob_private.bbob_board_requests
    order by committed_revision desc offset 512
  );
  return v_response;
end;
$function$;

revoke all on function public.bbob_get_board() from public, anon, authenticated;
revoke all on function public.bbob_save_board(bigint, jsonb, uuid) from public, anon, authenticated;
grant usage on schema public to anon, authenticated;
grant execute on function public.bbob_get_board() to anon, authenticated;
grant execute on function public.bbob_save_board(bigint, jsonb, uuid) to anon, authenticated;

comment on table public.bbob_boards is
  'One public collaborative penalty list. RPC access only; never store personal draw history or settings.';
comment on table bbob_private.bbob_board_requests is
  'Latest 512 successful shared-list saves, for idempotent retries. Private and pruned transactionally.';

notify pgrst, 'reload schema';
commit;
