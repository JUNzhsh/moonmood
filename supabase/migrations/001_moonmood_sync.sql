begin;

create schema if not exists moonmood_private;

create table if not exists moonmood_private.vaults (
  access_hash bytea primary key,
  revision bigint not null check (revision > 0),
  payload text not null check (length(payload) between 40 and 1048576)
);

alter table moonmood_private.vaults enable row level security;
revoke all on schema moonmood_private from public, anon, authenticated;
revoke all on moonmood_private.vaults from public, anon, authenticated;
grant usage on schema moonmood_private to anon;
grant select, insert, update on moonmood_private.vaults to anon;

-- Only the explicitly exposed RPCs set this transaction's access hash.
create policy moonmood_vault_access on moonmood_private.vaults
  to anon
  using (access_hash = (select pg_catalog.decode(pg_catalog.current_setting('moonmood.access_hash', true), 'hex')))
  with check (access_hash = (select pg_catalog.decode(pg_catalog.current_setting('moonmood.access_hash', true), 'hex')));

-- The access key and the browser's encryption key use separate HKDF outputs.
create or replace function public.moonmood_read(p_access text)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  lookup bytea;
begin
  if p_access is null or p_access !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  lookup := pg_catalog.sha256(pg_catalog.convert_to(p_access, 'UTF8'));
  perform pg_catalog.set_config('moonmood.access_hash', pg_catalog.encode(lookup, 'hex'), true);
  return (
    select pg_catalog.jsonb_build_object('revision', revision, 'payload', payload)
    from moonmood_private.vaults where access_hash = lookup
  );
end;
$$;

create or replace function public.moonmood_write(
  p_access text,
  p_revision bigint,
  p_payload text
)
returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare
  lookup bytea;
begin
  if p_access is null or p_access !~ '^[0-9a-f]{64}$'
    or p_revision is null or p_revision < 0
    or p_payload is null or length(p_payload) not between 40 and 1048576
    or p_payload !~ '^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$' then
    return false;
  end if;
  lookup := pg_catalog.sha256(pg_catalog.convert_to(p_access, 'UTF8'));
  perform pg_catalog.set_config('moonmood.access_hash', pg_catalog.encode(lookup, 'hex'), true);

  if p_revision = 0 then
    insert into moonmood_private.vaults (access_hash, revision, payload)
    values (lookup, 1, p_payload)
    on conflict (access_hash) do nothing;
  else
    update moonmood_private.vaults
    set revision = revision + 1, payload = p_payload
    where access_hash = lookup and revision = p_revision;
  end if;
  return found;
end;
$$;

revoke all on function public.moonmood_read(text) from public, anon, authenticated;
revoke all on function public.moonmood_write(text, bigint, text) from public, anon, authenticated;
grant execute on function public.moonmood_read(text) to anon;
grant execute on function public.moonmood_write(text, bigint, text) to anon;

commit;
