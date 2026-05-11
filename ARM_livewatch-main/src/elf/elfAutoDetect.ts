import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface ElfAutoDetectResult {
    path: string;
    source: 'configured' | 'launch' | 'glob' | 'none' | 'ambiguous';
    message?: string;
    candidates?: string[];
}

/**
 * Auto-detect the ELF file path by checking multiple sources:
 *   1. livewatch.elfPath setting (explicit, highest priority)
 *   2. launch.json cortex-debug "executable" field
 *   3. Glob search for .elf files in common build directories
 *
 * Returns a single resolved path only when the result is unambiguous.
 */
export async function autoDetectElfPath(): Promise<ElfAutoDetectResult> {
    // 1. Check explicit setting
    const configured = vscode.workspace.getConfiguration('livewatch').get<string>('elfPath', '');
    if (configured) {
        const abs = resolveWorkspacePath(configured);
        if (abs && fs.existsSync(abs)) {
            return { path: abs, source: 'configured' };
        }
        return {
            path: '',
            source: 'none',
            message: `Configured livewatch.elfPath does not exist: ${configured}`,
        };
    }

    // 2. Read from launch.json cortex-debug configurations
    const fromLaunch = await readFromLaunchJson();
    if (fromLaunch) { return fromLaunch; }

    // 3. Glob search for .elf files in workspace
    const fromGlob = await searchForElfFiles();
    if (fromGlob) { return fromGlob; }

    return {
        path: '',
        source: 'none',
        message: 'No ELF file found. Set livewatch.elfPath explicitly or keep only one build output in the workspace.',
    };
}

/**
 * Read the "executable" field from cortex-debug launch configurations.
 */
async function readFromLaunchJson(): Promise<ElfAutoDetectResult | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const candidates = new Set<string>();

    for (const workspaceFolder of workspaceFolders) {
        const launchConfig = vscode.workspace.getConfiguration('launch', workspaceFolder.uri);
        const configurations = launchConfig.get<any[]>('configurations', []);

        for (const config of configurations) {
            // Check cortex-debug, cppdbg, and platformio configurations
            if (config.type === 'cortex-debug' || config.type === 'cppdbg' || config.type === 'platformio-debug') {
                const exe: string | undefined = config.executable || config.program;
                if (!exe) { continue; }
                const resolved = resolveVariables(exe, workspaceFolder);
                if (fs.existsSync(resolved)) {
                    candidates.add(resolved);
                }
            }
        }
    }

    return classifyCandidates(
        Array.from(candidates),
        'launch',
        'Multiple launch configurations reference different ELF files. Set livewatch.elfPath explicitly.'
    );
}

/**
 * Search workspace for ELF files in common build output directories.
 * Supports .elf, .axf (Keil), .out (IAR) — all are ELF format.
 * Only succeeds when exactly one candidate is found.
 */
async function searchForElfFiles(): Promise<ElfAutoDetectResult | null> {
    const patterns = [
        // CMake
        '**/build/**/*.elf',
        '**/cmake-build-*/**/*.elf',
        // STM32CubeIDE
        '**/Debug/**/*.elf',
        '**/Release/**/*.elf',
        // PlatformIO
        '**/.pio/build/**/*.elf',
        // Keil MDK (.axf is ELF format)
        '**/Objects/**/*.axf',
        '**/Listings/**/*.axf',
        // IAR (.out is ELF format)
        '**/Debug/Exe/**/*.out',
        '**/Release/Exe/**/*.out',
        // Meson
        '**/builddir/**/*.elf',
        // Generic
        '**/out/**/*.elf',
        '**/output/**/*.elf',
        '**/bin/**/*.elf',
    ];

    const candidates = new Set<string>();

    for (const pattern of patterns) {
        const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 10);
        for (const uri of uris) {
            candidates.add(uri.fsPath);
        }
    }

    return classifyCandidates(
        Array.from(candidates),
        'glob',
        'Multiple ELF files were found in the workspace. Set livewatch.elfPath explicitly instead of guessing.'
    );
}

/**
 * Resolve a path relative to the workspace root.
 */
function resolveWorkspacePath(p: string): string | null {
    if (path.isAbsolute(p)) { return p; }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) { return null; }
    return path.resolve(root, p);
}

function classifyCandidates(
    candidates: string[],
    source: 'launch' | 'glob',
    ambiguousPrefix: string,
): ElfAutoDetectResult | null {
    if (candidates.length === 0) {
        return null;
    }
    if (candidates.length === 1) {
        return {
            path: candidates[0],
            source,
        };
    }

    const ordered = [...candidates].sort();
    return {
        path: '',
        source: 'ambiguous',
        candidates: ordered,
        message: `${ambiguousPrefix} Candidates: ${ordered.slice(0, 4).join(', ')}${ordered.length > 4 ? ', ...' : ''}`,
    };
}

/**
 * Resolve VS Code variables like ${workspaceFolder}, ${workspaceRoot}, ${workspaceFolderBasename}.
 */
function resolveVariables(value: string, folder: vscode.WorkspaceFolder): string {
    let result = value;
    result = result.replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath);
    result = result.replace(/\$\{workspaceRoot\}/g, folder.uri.fsPath);
    result = result.replace(/\$\{workspaceFolderBasename\}/g, path.basename(folder.uri.fsPath));
    // If still relative, resolve against workspace
    if (!path.isAbsolute(result)) {
        result = path.resolve(folder.uri.fsPath, result);
    }
    return result;
}
