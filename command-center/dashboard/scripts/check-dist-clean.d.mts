// Types for check-dist-clean.mjs (WP B5 part BUILD).
export declare const EXIT: { readonly CLEAN: 0; readonly USAGE: 2; readonly FINDINGS: 3 };
export interface DistFinding { file: string; needle: string; where: 'name' | 'content' }
export interface DistCheckResult { target: string; scanned_files: number; findings: DistFinding[]; errors: { file: string; error: string }[]; exit_code: number }
export declare function checkDistClean(target: string): DistCheckResult;
export declare function main(argv: string[], io?: { out: (s: string) => void; err: (s: string) => void }): number;
