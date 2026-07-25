CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE authentication_nonce (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address varchar(42) NOT NULL,
    nonce varchar(64) NOT NULL UNIQUE,
    siwe_message text NOT NULL,
    issued_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    CONSTRAINT authentication_nonce_wallet_format
        CHECK (wallet_address ~ '^0x[0-9a-fA-F]{40}$'),
    CONSTRAINT authentication_nonce_expiry CHECK (expires_at > issued_at)
);

CREATE INDEX authentication_nonce_wallet_active_idx
    ON authentication_nonce (lower(wallet_address), expires_at)
    WHERE consumed_at IS NULL;

CREATE TABLE document_intent (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key varchar(128) NOT NULL UNIQUE,
    operation varchar(16) NOT NULL,
    status varchar(32) NOT NULL,
    issuer varchar(42) NOT NULL,
    chain_nonce numeric(78, 0) NOT NULL,
    deadline timestamptz NOT NULL,
    document_id char(66),
    old_document_id char(66),
    content_digest char(66),
    metadata_commitment char(66),
    canonical_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    document_cid varchar(128),
    cid_codec smallint,
    cid_digest char(66),
    current_version bigint,
    typed_data jsonb NOT NULL,
    failure_code varchar(64),
    failure_detail text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    signed_at timestamptz,
    source_confirmed_at timestamptz,
    CONSTRAINT document_intent_operation
        CHECK (operation IN ('REGISTER', 'REVOKE', 'SUPERSEDE')),
    CONSTRAINT document_intent_status
        CHECK (
            status IN (
                'PREPARED',
                'SIGNED',
                'SOURCE_PENDING',
                'SOURCE_CONFIRMED',
                'FAILED_RETRYABLE',
                'FAILED_TERMINAL'
            )
        ),
    CONSTRAINT document_intent_issuer_format
        CHECK (issuer ~ '^0x[0-9a-fA-F]{40}$'),
    CONSTRAINT document_intent_cid_codec
        CHECK (cid_codec IS NULL OR cid_codec IN (85, 112)),
    CONSTRAINT document_intent_issuer_nonce UNIQUE (issuer, chain_nonce)
);

CREATE INDEX document_intent_status_idx
    ON document_intent (status, updated_at);
CREATE INDEX document_intent_document_idx
    ON document_intent (document_id);

CREATE TABLE pinned_artifact (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    intent_id uuid NOT NULL UNIQUE REFERENCES document_intent(id) ON DELETE CASCADE,
    storage_provider varchar(32) NOT NULL DEFAULT 'PINATA',
    storage_provider_id varchar(256),
    storage_network varchar(16) NOT NULL,
    document_cid varchar(128) NOT NULL,
    cid_codec smallint NOT NULL,
    cid_digest char(66) NOT NULL,
    content_digest char(66) NOT NULL,
    exact_byte_size bigint NOT NULL,
    mime_type varchar(255) NOT NULL,
    original_filename text NOT NULL,
    metadata_preimage jsonb NOT NULL,
    retrieval_verified_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pinned_artifact_storage_network
        CHECK (storage_network IN ('public', 'private')),
    CONSTRAINT pinned_artifact_cid_codec CHECK (cid_codec IN (85, 112)),
    CONSTRAINT pinned_artifact_size CHECK (exact_byte_size > 0)
);

CREATE TABLE document_signature (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    intent_id uuid NOT NULL UNIQUE REFERENCES document_intent(id) ON DELETE CASCADE,
    signer varchar(42) NOT NULL,
    signature text NOT NULL,
    signature_kind varchar(16) NOT NULL,
    verified_digest char(66) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT document_signature_kind CHECK (signature_kind IN ('EOA', 'ERC1271'))
);

CREATE TABLE source_transaction (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    intent_id uuid NOT NULL REFERENCES document_intent(id) ON DELETE CASCADE,
    attempt integer NOT NULL,
    transaction_hash char(66) UNIQUE,
    state varchar(24) NOT NULL,
    nonce numeric(78, 0),
    submitted_at timestamptz,
    block_number bigint,
    block_hash char(66),
    receipt_status integer,
    confirmation_count integer NOT NULL DEFAULT 0,
    canonical_event jsonb,
    failure_code varchar(64),
    failure_detail text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT source_transaction_attempt UNIQUE (intent_id, attempt),
    CONSTRAINT source_transaction_attempt_positive CHECK (attempt > 0),
    CONSTRAINT source_transaction_state
        CHECK (state IN ('PREPARED', 'BROADCAST', 'CONFIRMED', 'FAILED', 'UNKNOWN'))
);

CREATE TABLE document_projection (
    document_id char(66) PRIMARY KEY,
    content_digest char(66) NOT NULL,
    metadata_commitment char(66) NOT NULL,
    document_cid varchar(128) NOT NULL,
    cid_codec smallint NOT NULL,
    cid_digest char(66) NOT NULL,
    issuer varchar(42) NOT NULL,
    source_chain_id bigint NOT NULL,
    registered_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    document_version bigint NOT NULL,
    schema_version integer NOT NULL,
    lifecycle_status varchar(16) NOT NULL,
    supersedes char(66),
    superseded_by char(66),
    source_tx_hash char(66) NOT NULL,
    source_block_number bigint NOT NULL,
    source_block_hash char(66) NOT NULL,
    projected_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT document_projection_lifecycle
        CHECK (lifecycle_status IN ('ACTIVE', 'REVOKED', 'SUPERSEDED'))
);

CREATE TABLE dispatch (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id char(66) NOT NULL,
    document_version bigint NOT NULL,
    destination_selector numeric(20, 0) NOT NULL,
    receiver varchar(42) NOT NULL,
    status varchar(32) NOT NULL,
    message_id char(66) UNIQUE,
    source_transaction_hash char(66),
    source_block_number bigint,
    source_block_hash char(66),
    destination_transaction_hash char(66),
    destination_block_number bigint,
    destination_block_hash char(66),
    gas_limit integer NOT NULL,
    fee_token varchar(42),
    fee_amount numeric(78, 0),
    sent_at timestamptz,
    destination_confirmed_at timestamptz,
    recovery_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dispatch_document_lane_version
        UNIQUE (document_id, document_version, destination_selector),
    CONSTRAINT dispatch_status
        CHECK (
            status IN (
                'PENDING',
                'SOURCE_ACCEPTED',
                'DESTINATION_CONFIRMED',
                'DESTINATION_IGNORED',
                'RECOVERY_REQUIRED'
            )
        )
);

CREATE INDEX dispatch_status_idx ON dispatch (status, updated_at);

CREATE TABLE processed_chain_event (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chain_id bigint NOT NULL,
    contract_address varchar(42) NOT NULL,
    transaction_hash char(66) NOT NULL,
    log_index integer NOT NULL,
    block_number bigint NOT NULL,
    block_hash char(66) NOT NULL,
    event_name varchar(64) NOT NULL,
    event_payload jsonb NOT NULL,
    canonical boolean NOT NULL DEFAULT true,
    processed_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT processed_chain_event_identity
        UNIQUE (chain_id, transaction_hash, log_index)
);

CREATE INDEX processed_chain_event_block_idx
    ON processed_chain_event (chain_id, contract_address, block_number);

CREATE TABLE chain_cursor (
    chain_id bigint NOT NULL,
    contract_address varchar(42) NOT NULL,
    next_block bigint NOT NULL,
    last_finalized_block bigint,
    last_finalized_hash char(66),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, contract_address),
    CONSTRAINT chain_cursor_next_block CHECK (next_block >= 0)
);

CREATE TABLE outbox_job (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    deduplication_key varchar(256) NOT NULL UNIQUE,
    job_type varchar(32) NOT NULL,
    intent_id uuid REFERENCES document_intent(id) ON DELETE CASCADE,
    dispatch_id uuid REFERENCES dispatch(id) ON DELETE CASCADE,
    state varchar(16) NOT NULL DEFAULT 'READY',
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    attempt_count integer NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL DEFAULT now(),
    locked_at timestamptz,
    locked_by varchar(128),
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT outbox_job_target CHECK (intent_id IS NOT NULL OR dispatch_id IS NOT NULL),
    CONSTRAINT outbox_job_state
        CHECK (state IN ('READY', 'RUNNING', 'COMPLETED', 'FAILED')),
    CONSTRAINT outbox_job_type
        CHECK (
            job_type IN (
                'SUBMIT_SOURCE',
                'CONFIRM_SOURCE',
                'DISPATCH_DESTINATION',
                'TRACK_DESTINATION',
                'RECONCILE'
            )
        )
);

CREATE INDEX outbox_job_claim_idx
    ON outbox_job (available_at, created_at)
    WHERE state = 'READY';
