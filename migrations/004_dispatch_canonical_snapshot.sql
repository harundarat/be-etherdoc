ALTER TABLE dispatch
    ADD COLUMN content_digest char(66),
    ADD COLUMN document_status varchar(16),
    ADD COLUMN issuer varchar(42);

ALTER TABLE dispatch
    ADD CONSTRAINT dispatch_document_status
        CHECK (
            document_status IS NULL
            OR document_status IN ('ACTIVE', 'REVOKED', 'SUPERSEDED')
        );
