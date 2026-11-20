// Opt-in scan profiling.
//
// The native layer returns one profile per scan. A git scan makes one native call
// per blob, so `ProfileAccumulator` folds each profile in as its blob finishes
// rather than keeping them all until the end.

import type { ProfileReport } from "../index.js";
import type { ScanProfile, ScanProfileFile, ScanProfilePhase, ScanProfileRule } from "./types";

/** Wall-clock of work done by the TypeScript layer, optionally spanning native scans already counted. */
export interface PhaseOptions {
    /** The phase's wall clock already contains native scans, so it is not added to `totalMs` again. */
    overlapsNative?: boolean;
}

const byMsDesc = (a: { ms: number }, b: { ms: number }): number => b.ms - a.ms;

/** Collects the native profiles and TypeScript-measured phases of one scan. */
export class ProfileAccumulator {
    readonly #files: ScanProfileFile[] = [];

    readonly #phases = new Map<string, ScanProfilePhase>();

    readonly #rules = new Map<string, ScanProfileRule>();

    #totalMs = 0;

    /** Add one native scan. `label` replaces the file name of its single file, e.g. with a commit-qualified path. */
    public addNative(profile: ProfileReport | undefined, label?: string): void {
        if (profile === undefined) {
            return;
        }

        this.#totalMs += profile.totalMs;

        for (const { file, ms } of profile.files) {
            this.#files.push({ file: label ?? file, ms });
        }

        // Native phases are already inside the native total.
        for (const phase of profile.phases) {
            this.addPhase(phase.name, phase.ms, { count: phase.count, overlapsNative: true });
        }

        for (const { count, ms, pattern, ruleId } of profile.rules) {
            const entry = this.#rules.get(ruleId);

            this.#rules.set(ruleId, {
                count: count + (entry?.count ?? 0),
                matches: 0,
                ms: ms + (entry?.ms ?? 0),
                ...(pattern === undefined ? {} : { pattern }),
                ruleId,
            });
        }
    }

    /** Add time spent in the TypeScript layer. */
    public addPhase(name: string, ms: number, options: PhaseOptions & { count?: number } = {}): void {
        const count = options.count ?? 1;
        const entry = this.#phases.get(name);

        this.#phases.set(name, { count: count + (entry?.count ?? 0), ms: ms + (entry?.ms ?? 0), name });

        if (options.overlapsNative !== true) {
            this.#totalMs += ms;
        }
    }

    /** Total counted so far, in milliseconds; pair with {@link addResidual}. */
    public get totalMs(): number {
        return this.#totalMs;
    }

    /**
     * Add a phase that enclosed native scans and TypeScript phases already counted: only the time
     * since `startedAt` that they did not account for (the Git work in between) is added.
     */
    public addResidual(name: string, startedAt: number, totalMsAtStart: number): void {
        this.addPhase(name, Math.max(0, performance.now() - startedAt - (this.#totalMs - totalMsAtStart)));
    }

    /** The finished profile, with each rule's match count taken from the scan's findings. */
    public build(findings: ReadonlyArray<{ ruleId: string }>): ScanProfile {
        const matches = new Map<string, number>();

        for (const finding of findings) {
            matches.set(finding.ruleId, (matches.get(finding.ruleId) ?? 0) + 1);
        }

        return {
            files: this.#files.toSorted(byMsDesc),
            phases: [...this.#phases.values()].toSorted(byMsDesc),
            rules: [...this.#rules.values()].map((rule) => {
                return { ...rule, matches: matches.get(rule.ruleId) ?? 0 };
            }).toSorted(byMsDesc),
            totalMs: this.#totalMs,
        };
    }
}
