ALTER TABLE document_intent
    ADD COLUMN typed_data_digest char(66);

ALTER TABLE document_intent
    ALTER COLUMN typed_data_digest SET NOT NULL;
