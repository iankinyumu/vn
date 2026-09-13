-- Authenticated users may update only their own display name through the RLS-protected profile table.
create policy profiles_update_own
on public.profiles for update to authenticated
using (id = auth.uid())
with check (id = auth.uid());
