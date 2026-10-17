export { createBackup, hasBackup, restoreFromBackup } from "./catalog/backup";
export { detectJsonIndent, parseBunCatalogs } from "./catalog/bun";
export { fetchChangelogInfo } from "./catalog/changelog";
export { parseCompositeCatalogName } from "./catalog/composite";
// The catalog implementation lives in ./catalog/engine.ts. This file keeps the
// public surface of `util/catalog` unchanged.
export { applyCatalogUpdates, applyPackageJsonUpdates, collectInternalOutdated, hasCatalogs, hasPackageJsonDeps, readCatalogs, readPackageJsonDeps, toFilterArray } from "./catalog/engine";
export { formatOutdatedJson, formatOutdatedMinimal, formatOutdatedTable, formatSummary, groupByCatalog } from "./catalog/format";
export { getRegistryForPackage, loadNpmrc, parseNpmrc } from "./catalog/npmrc";
export { fetchVulnerabilities } from "./catalog/osv";
export type { MaturityOptions } from "./catalog/outdated";
export { checkOutdated, findTargetVersion } from "./catalog/outdated";
export { matchesFilters, matchesPattern, resolvePackageTarget } from "./catalog/patterns";
export { parseCatalogsFromYaml } from "./catalog/pnpm-yaml";
export { promptPackageSelection } from "./catalog/prompt";
export { fetchPackageVersions } from "./catalog/registry";
export type { ApplyCatalogUpdatesOptions, CatalogCheckOptions, ChangelogInfo, CheckOutdatedResult, NpmrcConfig, OutdatedEntry, ReadCatalogOptions, SecurityVulnerability, SocketReport, UpdateTarget } from "./catalog/types";
export { extractPrefix, getUpdateType, isNewer, parseVersion } from "./catalog/version";
