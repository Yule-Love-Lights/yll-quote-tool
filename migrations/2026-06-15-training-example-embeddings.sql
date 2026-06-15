-- =====================================================================
-- #8 Stage B — image-embedding similarity retrieval (2026-06-15)
--
-- Adds a Voyage image embedding to each training example + a cosine-similarity
-- match function, so analyze can retrieve the most VISUALLY SIMILAR past
-- houses as few-shot examples (instead of just the newest). The app degrades
-- to recency when an embedding is missing, so this is purely additive.
--
-- HOW TO APPLY: paste into the Supabase SQL Editor and Run. Idempotent.
-- =====================================================================

-- pgvector (vector type + distance operators). Safe if already enabled.
create extension if not exists vector;

-- The street-photo embedding. voyage-multimodal-3.5 default = 1024 dims, which
-- sits safely under pgvector's 2000-dim index ceiling (no ANN index needed at
-- a few-hundred rows — an exact scan is instant; add HNSW later if it grows).
alter table training_examples
  add column if not exists embedding vector(1024);

-- Cosine-similarity retrieval. Returns the non-excluded, embedded examples
-- nearest the query embedding, closest first. `<=>` is pgvector's cosine
-- distance (smaller = more similar). Called via supabase-js .rpc().
create or replace function match_training_examples(
  query_embedding vector(1024),
  match_count int
)
returns setof training_examples
language sql
stable
as $$
  select *
  from training_examples
  where excluded = false
    and embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;
