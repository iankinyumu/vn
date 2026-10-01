-- Cross-device avatar sync. The character is saved in the auth user metadata (`avatar`), which
-- clients cannot subscribe to. A trigger copies it into public.profiles.avatar, and profiles joins
-- the realtime publication, so each signed-in page hears its own row change (RLS limits every
-- subscriber to id = auth.uid()) instead of asking the server on a timer.

alter table public.profiles add column if not exists avatar text
  check (avatar is null or avatar ~ '^[a-z0-9-]{1,40}$');

create or replace function public.sync_profile_avatar()
returns trigger language plpgsql security definer set search_path = public as $$
declare next_avatar text := new.raw_user_meta_data ->> 'avatar';
begin
  if next_avatar is not null and next_avatar !~ '^[a-z0-9-]{1,40}$' then next_avatar := null; end if;
  update public.profiles set avatar = next_avatar where id = new.id and avatar is distinct from next_avatar;
  return new;
end;
$$;

-- Named to sort after on_auth_user_created, so the profile row exists when a new user is inserted.
drop trigger if exists on_auth_user_sync_avatar on auth.users;
create trigger on_auth_user_sync_avatar
  after insert or update of raw_user_meta_data on auth.users
  for each row execute function public.sync_profile_avatar();

update public.profiles p
   set avatar = u.raw_user_meta_data ->> 'avatar'
  from auth.users u
 where u.id = p.id
   and u.raw_user_meta_data ->> 'avatar' ~ '^[a-z0-9-]{1,40}$'
   and p.avatar is distinct from u.raw_user_meta_data ->> 'avatar';

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'profiles') then
    alter publication supabase_realtime add table public.profiles;
  end if;
end;
$$;
