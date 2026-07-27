CREATE INDEX authentication_nonce_consumed_cleanup_idx
    ON authentication_nonce (consumed_at, id)
    WHERE consumed_at IS NOT NULL;

CREATE INDEX authentication_nonce_expired_cleanup_idx
    ON authentication_nonce (expires_at, id)
    WHERE consumed_at IS NULL;
