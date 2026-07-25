ALTER TABLE dispatch
    ADD COLUMN source_nonce numeric(78, 0),
    ADD COLUMN failure_code varchar(64),
    ADD COLUMN failure_detail text;

CREATE UNIQUE INDEX dispatch_source_transaction_hash_unique
    ON dispatch (source_transaction_hash)
    WHERE source_transaction_hash IS NOT NULL;

CREATE UNIQUE INDEX dispatch_destination_transaction_hash_unique
    ON dispatch (destination_transaction_hash)
    WHERE destination_transaction_hash IS NOT NULL;
