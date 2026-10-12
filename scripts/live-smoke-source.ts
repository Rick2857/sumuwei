import { basename, resolve } from 'node:path'
import { PRODUCTION_DB_DIR, isProductionDir } from '../src/dev/sandbox.ts'
import { digestTree, readOwnerRecord, ownerRecordPath } from '../src/infrastructure/persistence/production-db-safety.ts'
import { isSnapshotIdShaped, readSnapshotManifest } from '../src/infrastructure/persistence/production-db-restore.ts'

/** Select bytes to copy; never open either the production database or snapshot. */
export function liveSmokeSource(argv: readonly string[]) {
  const selected = argv.find(value => value.startsWith('--snapshot-source='))?.slice('--snapshot-source='.length)
    ?? process.env.PROJECT_LG_VERIFIED_SNAPSHOT_SOURCE
  if (selected) {
    const directory = resolve(selected)
    if (isProductionDir(directory)) throw new Error('live_smoke_snapshot_overlaps_production')
    const manifest = readSnapshotManifest(`${directory}.manifest.json`)
    if (!manifest || manifest.sourceDirKind !== 'production-data-dir' || manifest.algorithm !== 'inc01-tree-digest-v1'
      || !isSnapshotIdShaped(manifest.snapshotId) || basename(directory) !== `pglite-${manifest.snapshotId}`
      || !(manifest.fileCount > 0) || !Array.isArray(manifest.excludedPaths)
      || manifest.excludedPaths.some(path => path !== 'postmaster.pid')) throw new Error('live_smoke_verified_manifest_required')
    const digest = digestTree(directory, manifest.excludedPaths)
    if (digest.treeSha256 !== manifest.nonVolatileTreeSha256 || digest.measuredCount !== manifest.fileCount
      || digest.totalBytes !== manifest.totalBytes) throw new Error('live_smoke_snapshot_digest_mismatch')
    return { directory, kind: 'verified_snapshot' as const, snapshotId: manifest.snapshotId, treeSha256: digest.treeSha256 }
  }
  const owner = readOwnerRecord(ownerRecordPath(PRODUCTION_DB_DIR))
  if (owner?.cleanClose !== true) throw new Error('live_smoke_closed_source_required: use a verified --snapshot-source')
  return { directory: PRODUCTION_DB_DIR, kind: 'closed_production_copy' as const }
}
