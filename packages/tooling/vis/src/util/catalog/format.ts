import { renderToString } from "@visulima/tui";
import { Box } from "@visulima/tui/components/box";
import { Text } from "@visulima/tui/components/text";
import { Table } from "@visulima/tui-kit/table";
import React from "react";

import { DEFAULT_LOW_SCORE_THRESHOLD } from "../../security/socket-security";
import { parseCompositeCatalogName } from "../catalog";
import type { CheckOutdatedResult, OutdatedEntry } from "./types";

export const formatOutdatedJson = (result: CheckOutdatedResult): string => JSON.stringify(result, undefined, 2);

export const formatOutdatedMinimal = (outdated: OutdatedEntry[]): string =>
    outdated.map((entry) => `${entry.packageName}  ${entry.currentRange} → ${entry.newRange}`).join("\n");

export const groupByCatalog = (entries: OutdatedEntry[]): Map<string, OutdatedEntry[]> => {
    const grouped = new Map<string, OutdatedEntry[]>();

    for (const entry of entries) {
        if (!grouped.has(entry.catalogName)) {
            grouped.set(entry.catalogName, []);
        }

        const group = grouped.get(entry.catalogName);

        if (group) {
            group.push(entry);
        }
    }

    return grouped;
};

const formatCatalogDisplayName = (catalogName: string): string => {
    const parsed = parseCompositeCatalogName(catalogName);

    if (parsed) {
        const location = parsed.relativePath === "." ? "root" : parsed.relativePath;

        return `${location} (${parsed.depType})`;
    }

    return `Catalog: ${catalogName}`;
};

export const formatOutdatedTable = (outdated: OutdatedEntry[], logger: Console): void => {
    const byCatalog = groupByCatalog(outdated);
    const columns = process.stdout.columns || 80;
    const hasSocketData = outdated.some((entry) => entry.socketReport);

    for (const [catalogName, entries] of byCatalog) {
        const tableData = entries.flatMap((entry) => {
            const hasSec = entry.vulnerabilities && entry.vulnerabilities.length > 0;
            const hasSocketAlerts = entry.socketReport && entry.socketReport.alerts.length > 0;
            const prefix = hasSec || hasSocketAlerts ? "[SEC] " : "";
            const displayName = `${prefix}${entry.packageName}`;

            const scoreString = entry.socketReport ? `${String(Math.round(entry.socketReport.score.overall * 100))}%` : "";

            const row: Record<string, string> = {
                current: entry.currentRange,
                package: displayName,
                target: entry.newRange,
                type: entry.updateType,
            };

            if (hasSocketData) {
                row.score = scoreString;
            }

            const rows: Record<string, string>[] = [row];

            if (entry.vulnerabilities) {
                for (const vuln of entry.vulnerabilities) {
                    const vulnRow: Record<string, string> = { current: vuln.summary, package: `  ${vuln.severity} ${vuln.id}`, target: "", type: "" };

                    if (hasSocketData) {
                        vulnRow.score = "";
                    }

                    rows.push(vulnRow);
                }
            }

            if (entry.socketReport) {
                for (const alert of entry.socketReport.alerts) {
                    const alertRow: Record<string, string> = {
                        current: alert.category,
                        package: `  [${alert.severity.toUpperCase()}] ${alert.type}`,
                        target: "",
                        type: "",
                    };

                    if (hasSocketData) {
                        alertRow.score = "";
                    }

                    rows.push(alertRow);
                }
            }

            return rows;
        });

        const displayName = formatCatalogDisplayName(catalogName);
        const output = renderToString(React.createElement(Table, { data: tableData }), { columns });

        logger.info(`${displayName}\n${output}\n`);
    }
};

export const formatSummary = (outdated: OutdatedEntry[], scoreMinimum: number = DEFAULT_LOW_SCORE_THRESHOLD): string => {
    let majors = 0;
    let minors = 0;
    let patches = 0;
    let securityCount = 0;
    let socketAlertCount = 0;
    let lowScoreCount = 0;

    for (const entry of outdated) {
        if (entry.updateType === "major") {
            majors++;
        } else if (entry.updateType === "minor") {
            minors++;
        } else {
            patches++;
        }

        if (entry.vulnerabilities && entry.vulnerabilities.length > 0) {
            securityCount++;
        }

        if (entry.socketReport?.alerts.length) {
            socketAlertCount++;
        }

        if (entry.socketReport && entry.socketReport.score.overall < scoreMinimum) {
            lowScoreCount++;
        }
    }

    const parts: string[] = [];

    if (majors) {
        parts.push(`${String(majors)} major`);
    }

    if (minors) {
        parts.push(`${String(minors)} minor`);
    }

    if (patches) {
        parts.push(`${String(patches)} patch`);
    }

    if (securityCount) {
        parts.push(`${String(securityCount)} with vulnerabilities`);
    }

    if (socketAlertCount) {
        parts.push(`${String(socketAlertCount)} with Socket.dev alerts`);
    }

    const summary = `Found ${String(outdated.length)} outdated (${parts.join(", ")})`;
    const columns = process.stdout.columns || 80;

    const children = [React.createElement(Text, { bold: true }, "\u2500 Summary"), React.createElement(Text, null, `  ${summary}`)];

    if (lowScoreCount > 0) {
        children.push(
            React.createElement(
                Text,
                { color: "yellow" },
                `  ${String(lowScoreCount)} package${lowScoreCount === 1 ? "" : "s"} with low Socket.dev score (<${String(Math.round(scoreMinimum * 100))}%)`,
            ),
        );
    }

    return renderToString(React.createElement(Box, { flexDirection: "column", paddingX: 1 }, ...children), { columns });
};
