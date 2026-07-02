-- #13 multi-image (checkpoint-1 follow-up): a staff title for the BASE photo,
-- so the "Photo 1" tab is renameable like the extras (whose titles live in
-- extra_photos). Nullable — null renders as "Photo 1".
-- Column-add ⇒ MIGRATION-FIRST: apply before merging the checkpoint-1 PRs.

alter table designs add column if not exists photo_title text;
