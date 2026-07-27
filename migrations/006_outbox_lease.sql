ALTER TABLE outbox_job
    ADD COLUMN lease_token uuid;

CREATE INDEX outbox_job_expired_lease_idx
    ON outbox_job (locked_at, created_at)
    WHERE state = 'RUNNING';
