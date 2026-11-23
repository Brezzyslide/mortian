-- Net balance (debits minus credits) of one ledger account, using the account_code index.
-- Read-only helper for summary queries; postings still go only through the posting service.
CREATE FUNCTION ledger_balance(code text) RETURNS bigint
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(sum(CASE side WHEN 'debit' THEN amount ELSE -amount END), 0)::bigint
    FROM ledger_line WHERE account_code = code
$$;
