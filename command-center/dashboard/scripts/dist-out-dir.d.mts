// Types for dist-out-dir.mjs (Lead integration of WP B5 part BUILD).
export declare const DEFAULT_PROJECT_ROOT: string;
export declare const DEFAULT_COMMAND_CENTER_ROOT: string;
/** The three fs calls the resolver makes; structural so a test can pass a fake. */
export interface DistOutDirFs {
  existsSync(p: string): boolean;
  statSync(p: string): { isDirectory(): boolean };
  readdirSync(p: string): string[];
}
export interface ResolveDistOutDirOptions {
  projectRoot?: string;
  commandCenterRoot?: string;
  tmpDir?: string;
  cwd?: string;
  fs?: DistOutDirFs;
}
export declare function resolveDistOutDir(raw: string | undefined | null, opts?: ResolveDistOutDirOptions): string | null;
