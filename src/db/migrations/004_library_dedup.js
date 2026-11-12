'use strict';

// Enforce library de-duplication at the DB level so the download check-then-insert
// can't race two identical files into two rows (which would share one on-disk file
// and break deletion). Collapse any pre-existing duplicates first, re-pointing
// server_content references to the surviving row, then add the UNIQUE index.

function up(db) {
  // Set-based instead of a query per duplicate: one pass re-points references
  // to the surviving (lowest-id) row of each (sha256, category) group, a second
  // drops the losers. sha256 is NOT NULL, but the IS NOT NULL guard keeps a
  // hand-edited row from being collapsed with others by GROUP BY's NULL group.
  db.exec(`
    CREATE TEMP TABLE library_dedup_map AS
      SELECT l.id AS loser, k.keep
        FROM library_files l
        JOIN (SELECT sha256, category, MIN(id) AS keep
                FROM library_files
               WHERE sha256 IS NOT NULL
               GROUP BY sha256, category
              HAVING COUNT(*) > 1) k
          ON k.sha256 = l.sha256 AND k.category = l.category
       WHERE l.id <> k.keep;
    UPDATE server_content
       SET library_id = (SELECT keep FROM library_dedup_map WHERE loser = server_content.library_id)
     WHERE library_id IN (SELECT loser FROM library_dedup_map);
    DELETE FROM library_files WHERE id IN (SELECT loser FROM library_dedup_map);
    DROP TABLE library_dedup_map;
  `);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_library_sha_cat ON library_files(sha256, category)');
}

module.exports = { up };
