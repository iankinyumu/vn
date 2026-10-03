-- System notifications (20261003100000): deposits reaching an outcome and account restrictions
-- being applied or lifted. Each producer is an AFTER trigger that hands the row to
-- admin_private.deliver_notification with a dedupe key, so a retried write delivers once. A
-- notification must never stop the payment or restriction change itself, so failures are logged
-- as warnings and swallowed.

-- A deposit that reaches an outcome the customer should hear about. Sandbox credits go to the
-- separate test balance, and the copy says so.
create function admin_private.notify_payment_outcome() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_amount text := '$' || to_char(new.usd_amount, 'FM999G999G990D00'); v_title text; v_body text;
begin
    if new.state is not distinct from old.state then return new; end if;
    case new.state
        when 'CONFIRMED' then
            v_title := 'Deposit confirmed';
            v_body := case when new.environment = 'SANDBOX' then v_amount || ' was added to your Real sandbox test balance. Test funds cannot be withdrawn.'
                           else v_amount || ' was added to your Real account.' end;
        when 'FAILED', 'REJECTED' then
            v_title := 'Deposit not completed';
            v_body := 'The M-Pesa payment for ' || v_amount || ' did not go through. No money was taken for this deposit.';
        when 'EXPIRED' then
            v_title := 'M-Pesa prompt expired';
            v_body := 'The prompt for ' || v_amount || ' was not approved in time. You can start a new deposit.';
        when 'MANUAL_REVIEW' then
            v_title := 'Deposit under review';
            v_body := 'We are checking the M-Pesa payment for ' || v_amount || '. Support will update you here.';
        when 'REVERSED' then
            v_title := 'Deposit reversed';
            v_body := 'The deposit of ' || v_amount || ' was reversed. Contact support if you have questions.';
        else return new;
    end case;
    begin
        perform admin_private.deliver_notification(new.user_id, 'funding', v_title, v_body,
            case when new.state in ('MANUAL_REVIEW', 'REVERSED') then 'support.html' end,
            jsonb_build_object('payment_id', new.id, 'state', new.state, 'environment', new.environment),
            null, 'payment:' || new.id::text || ':' || new.state);
    exception when others then
        raise warning 'payment notification failed for %: %', new.id, sqlerrm;
    end;
    return new;
end;
$$;
revoke all on function admin_private.notify_payment_outcome() from public, anon, authenticated;

do $$
begin
    if to_regclass('funding.payments') is not null then
        drop trigger if exists payments_notify_outcome on funding.payments;
        create trigger payments_notify_outcome after update of state on funding.payments
            for each row execute function admin_private.notify_payment_outcome();
    end if;
end;
$$;

-- A restriction applied or lifted. The staff reason stays internal: the customer is told what
-- changed and where to ask, as the restriction banner already does.
create function admin_private.notify_restriction_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_scope text := case new.scope when 'DEMO' then 'Practice' when 'REAL' then 'Real' else 'all' end;
        v_area text := case new.restriction_type when 'TRADING' then 'trading' when 'WITHDRAWAL' then 'withdrawals' when 'DEPOSIT' then 'deposits' else 'access' end;
begin
    begin
        if tg_op = 'INSERT' and new.active then
            perform admin_private.deliver_notification(new.user_id, 'account',
                case new.severity when 'NOTICE' then 'A notice on your account' when 'LIMITED' then 'A limit on your account' else 'A restriction on your account' end,
                format('This applies to %s on %s accounts. Contact support if you have questions.', v_area, v_scope),
                'support.html', jsonb_build_object('restriction_id', new.id, 'severity', new.severity),
                null, 'restriction:' || new.id::text || ':applied');
        elsif tg_op = 'UPDATE' and old.active and not new.active then
            perform admin_private.deliver_notification(new.user_id, 'account',
                'A restriction was lifted',
                format('The %s restriction on %s accounts no longer applies.', v_area, v_scope),
                null, jsonb_build_object('restriction_id', new.id),
                null, 'restriction:' || new.id::text || ':lifted');
        end if;
    exception when others then
        raise warning 'restriction notification failed for %: %', new.id, sqlerrm;
    end;
    return new;
end;
$$;
revoke all on function admin_private.notify_restriction_change() from public, anon, authenticated;

drop trigger if exists account_restrictions_notify on public.account_restrictions;
create trigger account_restrictions_notify after insert or update of active on public.account_restrictions
    for each row execute function admin_private.notify_restriction_change();
