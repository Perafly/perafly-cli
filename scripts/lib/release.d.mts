/** scripts/lib/release.mjs için tipler (testler TypeScript'ten çağırır) */
export type Target = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64" | "windows-x64";

export declare const TARGETS: readonly Target[];
export declare const FORMULA_TARGETS: readonly Target[];

export declare const targetFor: (platform: string, arch: string) => Target;
export declare const binaryName: (target: string) => string;
export declare const isBinaryAsset: (name: string) => boolean;

export declare const formatSha256Sums: (entries: Iterable<{ name: string; sha256: string }>) => string;
export declare const parseSha256Sums: (text: string) => Map<string, string>;

export interface ReleaseConfig {
    /** GitHub deposu (`sahip/ad`): ikililer bu deponun Releases sayfasından indirilir */
    repository: string;
    /** Homebrew tap deposu (`sahip/homebrew-ad`) */
    tap: string;
}
export declare const validateReleaseConfig: (config: unknown) => ReleaseConfig;
export declare const tapShortName: (tap: string) => string;
export declare const downloadBase: (repository: string, version: string) => string;

export declare const fillFormula: (template: string, values: { version: string; repository: string; sums: Map<string, string> }) => string;
