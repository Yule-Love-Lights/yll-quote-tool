-- #13 multi-image quoting (PR1): extra street photos on a design.
-- One design still owns ONE base photo (photo_path); extras live in a JSONB
-- array of { id, path, w, h, title? } whose storage objects sit under the same
-- `{designId}/` prefix (extra-<id>.<ext>), so deleteDesign's prefix-removal and
-- the retention purge cover them with no changes.
-- Column-add ⇒ MIGRATION-FIRST: apply before merging the PR1 code.

alter table designs add column if not exists extra_photos jsonb;
