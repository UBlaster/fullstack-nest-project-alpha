CREATE INDEX "Document_title_trgm_idx"
ON "Document"
USING GIN ("title" gin_trgm_ops);
