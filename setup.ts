#!/usr/bin/env npx tsx
/**
 * Setup Wizard for Code Agents Showcase
 *
 * Run from inside the code-agents repo to install into your project:
 *   npx tsx setup.ts ~/my-project
 *
 * Or run with no args to install into the current directory:
 *   npx tsx setup.ts
 *
 * Non-interactive (for scripts, CI, or when Claude Code runs the wizard):
 *   npx tsx setup.ts ~/my-project --yes
 *   npx tsx setup.ts ~/my-project --yes --mode fallback --provider gemini
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'node:readline/promises';
import { execSync } from 'child_process';
import { parseArgs } from 'node:util';

// Readline is created lazily so non-interactive runs never touch stdin.
// (Piped stdin makes readline silently drop input - the old silent-failure bug.)
let rl: readline.Interface | null = null;

function getRl(): readline.Interface {
    if (!rl) {
        rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
    }
    return rl;
}

function closeRl(): void {
    if (rl) {
        rl.close();
        rl = null;
    }
}

// ============================================================
// CLI ARGUMENTS
// ============================================================

const VALID_MODES = ['disabled', 'fallback', 'ai-only'];
const VALID_PROVIDERS = ['auto', 'gemini', 'openai', 'anthropic', 'ollama'];
const VALID_CONSERVATIVENESS = ['strict', 'balanced', 'aggressive'];

interface CliOptions {
    yes: boolean;
    mode: string;
    provider: string;
    conservativeness: string;
    stack: string;
    editor: boolean;
    targetArg: string | undefined;
}

function printUsage(): void {
    console.log(`
Usage: npx tsx setup.ts [target-project-path] [options]

Interactive (default):
  npx tsx setup.ts ~/my-project

Non-interactive (for scripts, CI, or when Claude Code runs the wizard):
  npx tsx setup.ts ~/my-project --yes
  npx tsx setup.ts ~/my-project --yes --mode fallback --provider gemini

Options:
  -y, --yes                  Accept defaults, never prompt (required when stdin is not a terminal)
      --mode <m>             disabled | fallback | ai-only                 (default: disabled)
      --provider <p>         auto | gemini | openai | anthropic | ollama   (default: auto)
      --conservativeness <c> strict | balanced | aggressive                (default: balanced)
      --stack <list>         Comma-separated tech stack (wildcard), e.g.
                             java-spring,vue,dotnet                        (default: auto-detect)
      --editor               Also install the NeoVim editor config         (default: skip)
  -h, --help                 Show this help
`);
}

function parseCliOptions(): CliOptions {
    let values: { [key: string]: unknown };
    let positionals: string[];
    try {
        ({ values, positionals } = parseArgs({
            args: process.argv.slice(2),
            options: {
                yes: { type: 'boolean', short: 'y', default: false },
                mode: { type: 'string', default: 'disabled' },
                provider: { type: 'string', default: 'auto' },
                conservativeness: { type: 'string', default: 'balanced' },
                stack: { type: 'string', default: '' },
                editor: { type: 'boolean', default: false },
                help: { type: 'boolean', short: 'h', default: false },
            },
            allowPositionals: true,
        }));
    } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        printUsage();
        process.exit(1);
    }

    if (values.help) {
        printUsage();
        process.exit(0);
    }

    const mode = values.mode as string;
    const provider = values.provider as string;
    const conservativeness = values.conservativeness as string;
    if (!VALID_MODES.includes(mode)) {
        console.error(`Error: invalid --mode "${mode}" (expected: ${VALID_MODES.join(' | ')})`);
        process.exit(1);
    }
    if (!VALID_PROVIDERS.includes(provider)) {
        console.error(`Error: invalid --provider "${provider}" (expected: ${VALID_PROVIDERS.join(' | ')})`);
        process.exit(1);
    }
    if (!VALID_CONSERVATIVENESS.includes(conservativeness)) {
        console.error(`Error: invalid --conservativeness "${conservativeness}" (expected: ${VALID_CONSERVATIVENESS.join(' | ')})`);
        process.exit(1);
    }

    return {
        yes: values.yes as boolean,
        mode,
        provider,
        conservativeness,
        stack: values.stack as string,
        editor: values.editor as boolean,
        targetArg: positionals[0],
    };
}

// ============================================================
// HELPERS
// ============================================================

async function promptChoice(question: string, choices: string[], defaultIdx: number = 0): Promise<number> {
    console.log(`\n${question}`);
    choices.forEach((c, i) => {
        const marker = i === defaultIdx ? ' (default)' : '';
        console.log(`  [${i + 1}] ${c}${marker}`);
    });

    const answer = await getRl().question(`\nChoice [${defaultIdx + 1}]: `);
    const num = parseInt(answer.trim(), 10);
    if (isNaN(num) || num < 1 || num > choices.length) {
        return defaultIdx;
    }
    return num - 1;
}

async function promptString(question: string, defaultVal: string = ''): Promise<string> {
    const suffix = defaultVal ? ` [${defaultVal}]` : '';
    const answer = await getRl().question(`${question}${suffix}: `);
    return answer.trim() || defaultVal;
}

function copyDirRecursive(src: string, dest: string, exclude: string[] = []): number {
    let count = 0;
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        if (exclude.includes(entry.name)) continue;

        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            count += copyDirRecursive(srcPath, destPath, exclude);
        } else {
            fs.copyFileSync(srcPath, destPath);
            count++;
        }
    }
    return count;
}

// ============================================================
// TECH STACK DETECTION
// ============================================================

interface DetectedStack {
    hasReact: boolean;
    hasVue: boolean;
    hasExpress: boolean;
    hasTypescript: boolean;
    hasPrisma: boolean;
    hasSentry: boolean;
    hasMUI: boolean;
    hasTanStack: boolean;
    hasJava: boolean;
    hasSpringBoot: boolean;
    hasMicronaut: boolean;
    hasDotNet: boolean;
    hasGo: boolean;
    hasPython: boolean;
}

// Root + common mono-repo subfolders we look inside for stack manifests.
const STACK_SCAN_DIRS = ['', 'frontend', 'client', 'web', 'app', 'api', 'server', 'backend', 'src'];

// True if any entry in one of the scan dirs satisfies `predicate` (non-recursive).
function anyFileMatches(projectDir: string, predicate: (name: string) => boolean): boolean {
    for (const sub of STACK_SCAN_DIRS) {
        const dir = path.join(projectDir, sub);
        try {
            if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
            if (fs.readdirSync(dir).some(predicate)) return true;
        } catch {
            // Unreadable directory - ignore.
        }
    }
    return false;
}

function readIfExists(projectDir: string, rel: string): string | null {
    const full = path.join(projectDir, rel);
    try {
        return fs.existsSync(full) ? fs.readFileSync(full, 'utf-8') : null;
    } catch {
        return null;
    }
}

function detectTechStack(projectDir: string): DetectedStack {
    const stack: DetectedStack = {
        hasReact: false,
        hasVue: false,
        hasExpress: false,
        hasTypescript: false,
        hasPrisma: false,
        hasSentry: false,
        hasMUI: false,
        hasTanStack: false,
        hasJava: false,
        hasSpringBoot: false,
        hasMicronaut: false,
        hasDotNet: false,
        hasGo: false,
        hasPython: false,
    };

    // ---- JavaScript / TypeScript ecosystem (package.json) ----
    const packagePaths = STACK_SCAN_DIRS.map(d => path.join(d, 'package.json'));

    for (const pkgPath of packagePaths) {
        const fullPath = path.join(projectDir, pkgPath);
        if (!fs.existsSync(fullPath)) continue;

        try {
            const pkg = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
            const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

            if (allDeps['react']) stack.hasReact = true;
            if (allDeps['vue'] || allDeps['nuxt']) stack.hasVue = true;
            if (allDeps['express']) stack.hasExpress = true;
            if (allDeps['typescript']) stack.hasTypescript = true;
            if (allDeps['prisma'] || allDeps['@prisma/client']) stack.hasPrisma = true;
            if (allDeps['@sentry/node'] || allDeps['@sentry/react']) stack.hasSentry = true;
            if (allDeps['@mui/material']) stack.hasMUI = true;
            if (allDeps['@tanstack/react-query'] || allDeps['@tanstack/react-router'] ||
                allDeps['@tanstack/vue-query'] || allDeps['@tanstack/vue-router']) stack.hasTanStack = true;
        } catch {
            // Skip invalid package.json
        }
    }

    // ---- File-pattern detection (JS/TS) ----
    if (fs.existsSync(path.join(projectDir, 'tsconfig.json'))) stack.hasTypescript = true;
    if (fs.existsSync(path.join(projectDir, 'prisma'))) stack.hasPrisma = true;

    // ---- Java (Maven / Gradle) + framework flavor ----
    const pom = readIfExists(projectDir, 'pom.xml');
    const gradle = readIfExists(projectDir, 'build.gradle') || readIfExists(projectDir, 'build.gradle.kts');
    if (pom || gradle) {
        stack.hasJava = true;
        const buildFiles = `${pom || ''}\n${gradle || ''}`;
        if (/spring-boot|org\.springframework/i.test(buildFiles)) stack.hasSpringBoot = true;
        if (/micronaut/i.test(buildFiles)) stack.hasMicronaut = true;
    }

    // ---- .NET (*.csproj / *.fsproj / *.sln) ----
    if (anyFileMatches(projectDir, n => n.endsWith('.csproj') || n.endsWith('.fsproj') || n.endsWith('.sln'))) {
        stack.hasDotNet = true;
    }

    // ---- Go ----
    if (fs.existsSync(path.join(projectDir, 'go.mod'))) stack.hasGo = true;

    // ---- Python ----
    if (fs.existsSync(path.join(projectDir, 'requirements.txt')) ||
        fs.existsSync(path.join(projectDir, 'pyproject.toml')) ||
        fs.existsSync(path.join(projectDir, 'setup.py')) ||
        fs.existsSync(path.join(projectDir, 'Pipfile'))) {
        stack.hasPython = true;
    }

    return stack;
}

// ============================================================
// STACK PROFILE (wildcard-friendly)
// ============================================================
//
// The wizard understands a set of canonical tokens for labeling and for the
// "get started" hint, but it accepts ANY token verbatim so teams can declare
// whatever stack they use (e.g. `--stack java-spring,vue,dotnet,aws`). The
// resulting profile is persisted to skill-rules.json (settings.stack_profile)
// so hooks / Claude can read it when deciding what to do.

const KNOWN_STACK_TOKENS: Record<string, string> = {
    react: 'React', vue: 'Vue', angular: 'Angular', svelte: 'Svelte', nuxt: 'Nuxt',
    express: 'Express', node: 'Node', nestjs: 'NestJS',
    java: 'Java', 'java-spring': 'Java/Spring Boot', 'spring-boot': 'Java/Spring Boot', spring: 'Java/Spring Boot',
    'java-micronaut': 'Java/Micronaut', micronaut: 'Java/Micronaut',
    dotnet: '.NET', '.net': '.NET', csharp: 'C#/.NET', 'c#': 'C#/.NET',
    go: 'Go', golang: 'Go',
    python: 'Python', django: 'Django', fastapi: 'FastAPI', flask: 'Flask',
    typescript: 'TypeScript', ts: 'TypeScript', javascript: 'JavaScript',
    prisma: 'Prisma', mui: 'MUI', tanstack: 'TanStack', sentry: 'Sentry',
    aws: 'AWS', azure: 'Azure', gcp: 'GCP',
};

// Framework tokens that would each want their own guideline skill.
const FRAMEWORK_TOKENS = new Set([
    'react', 'vue', 'angular', 'svelte', 'nuxt',
    'express', 'node', 'nestjs',
    'java', 'java-spring', 'spring-boot', 'java-micronaut', 'micronaut',
    'dotnet', 'go', 'python', 'django', 'fastapi', 'flask',
]);

// Frameworks this repo ships an opinionated guideline skill for out of the box.
// Everything else is supported via "adapt a skill" (CLAUDE_INTEGRATION_GUIDE.md).
const SHIPPED_FRAMEWORK_TOKENS = new Set(['react', 'express', 'node']);

function normalizeToken(t: string): string {
    return t.trim().toLowerCase();
}

function labelForToken(t: string): string {
    return KNOWN_STACK_TOKENS[normalizeToken(t)] || t.trim();
}

function parseDeclaredStack(declared: string): string[] {
    return (declared || '').split(',').map(normalizeToken).filter(Boolean);
}

// Tokens implied by auto-detection of the target project.
function detectionTokens(stack: DetectedStack): string[] {
    const t: string[] = [];
    if (stack.hasTypescript) t.push('typescript');
    if (stack.hasReact) t.push('react');
    if (stack.hasVue) t.push('vue');
    if (stack.hasExpress) t.push('express');
    if (stack.hasPrisma) t.push('prisma');
    if (stack.hasMUI) t.push('mui');
    if (stack.hasTanStack) t.push('tanstack');
    if (stack.hasSentry) t.push('sentry');
    if (stack.hasSpringBoot) t.push('java-spring');
    else if (stack.hasJava) t.push('java');
    if (stack.hasMicronaut) t.push('java-micronaut');
    if (stack.hasDotNet) t.push('dotnet');
    if (stack.hasGo) t.push('go');
    if (stack.hasPython) t.push('python');
    return t;
}

// ============================================================
// PROVIDER VALIDATION
// ============================================================

async function validateProvider(provider: string): Promise<boolean> {
    switch (provider) {
        case 'gemini': {
            if (!process.env.GEMINI_API_KEY) {
                console.log('\n  GEMINI_API_KEY not found in environment.');
                console.log('  Get a free key: https://aistudio.google.com/apikey');
                console.log('  Add to ~/.bashrc: export GEMINI_API_KEY=your-key');
                return false;
            }
            console.log('  GEMINI_API_KEY found.');
            return true;
        }
        case 'openai': {
            if (!process.env.OPENAI_API_KEY) {
                console.log('\n  OPENAI_API_KEY not found in environment.');
                console.log('  Get a key: https://platform.openai.com/api-keys');
                return false;
            }
            console.log('  OPENAI_API_KEY found.');
            return true;
        }
        case 'anthropic': {
            if (!process.env.ANTHROPIC_API_KEY) {
                console.log('\n  ANTHROPIC_API_KEY not found in environment.');
                console.log('  Get a key: https://console.anthropic.com/settings/keys');
                return false;
            }
            console.log('  ANTHROPIC_API_KEY found.');
            return true;
        }
        case 'ollama': {
            console.log('  Checking Ollama availability...');
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 2000);
                const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
                const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
                clearTimeout(timeout);
                if (response.ok) {
                    console.log('  Ollama is running.');
                    return true;
                }
            } catch {
                // Fall through
            }
            console.log('\n  Ollama not available at localhost:11434.');
            console.log('  Install: https://ollama.ai');
            console.log('  Then: ollama pull llama3.2');
            return false;
        }
        default:
            return false;
    }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
    const opts = parseCliOptions();
    const nonInteractive = opts.yes;

    // ---- Node version check ----
    const nodeMajor = parseInt(process.versions.node, 10);
    if (nodeMajor < 18) {
        console.error(`Error: Node 18+ required (20+ recommended), found v${process.versions.node}`);
        closeRl();
        process.exit(1);
    }

    // ---- Piped/closed stdin without --yes would silently break readline ----
    if (!process.stdin.isTTY && !nonInteractive) {
        console.error('Error: stdin is not a terminal, so the interactive wizard cannot run.');
        console.error('Re-run with --yes to accept defaults:');
        console.error('  npx tsx setup.ts ~/my-project --yes');
        console.error('Run with --help to see all non-interactive options.');
        process.exit(1);
    }

    // ---- Plain Windows cannot run the bash hooks ----
    if (process.platform === 'win32') {
        console.error('\nError: the hooks are bash scripts and will not run on plain Windows.');
        console.error('Use WSL2 (https://learn.microsoft.com/windows/wsl/install) and re-run this wizard inside your WSL2 shell.');
        if (nonInteractive) {
            process.exit(1);
        }
        const cont = await promptString('Continue anyway at your own risk? (y/n)', 'n');
        if (cont.toLowerCase() !== 'y') {
            closeRl();
            process.exit(1);
        }
    }

    console.log('');
    console.log('============================================================');
    console.log('  Code Agents - Setup Wizard');
    console.log('============================================================');

    // ---- Determine source and target directories ----
    const scriptDir = path.dirname(new URL(import.meta.url).pathname);
    const showcaseClaudeDir = path.join(scriptDir, '.claude');

    // Find the code-agents .claude/ source
    let sourceDir = '';
    if (fs.existsSync(showcaseClaudeDir)) {
        sourceDir = showcaseClaudeDir;
    } else {
        console.log('\n  Error: Cannot find .claude/ directory in the code-agents repo.');
        console.log('  Make sure you run this script from the code-agents repo root.');
        closeRl();
        process.exit(1);
    }

    // Determine target project
    let targetDir = process.cwd();
    if (opts.targetArg) {
        targetDir = path.resolve(opts.targetArg);
    }

    // If running from inside the code-agents repo itself, ask for target
    if (path.resolve(targetDir) === path.resolve(scriptDir)) {
        if (nonInteractive) {
            console.error('\n  Error: no target project path given (you are inside the code-agents repo).');
            console.error('    npx tsx setup.ts /path/to/your-project --yes');
            process.exit(1);
        }
        const projectPath = await promptString(
            '\n  You are inside the code-agents repo.\n  Enter the path to YOUR project',
            ''
        );
        if (!projectPath) {
            console.log('  No project path provided. Exiting.');
            closeRl();
            process.exit(0);
        }
        targetDir = path.resolve(projectPath);
    }

    // Verify target exists
    if (!fs.existsSync(targetDir)) {
        if (nonInteractive) {
            fs.mkdirSync(targetDir, { recursive: true });
            console.log(`\n  Target directory did not exist - created ${targetDir}`);
        } else {
            console.log(`\n  Target directory does not exist: ${targetDir}`);
            const create = await promptString('  Create it? (y/n)', 'n');
            if (create.toLowerCase() === 'y') {
                fs.mkdirSync(targetDir, { recursive: true });
                console.log(`  Created ${targetDir}`);
            } else {
                console.log('  To create it yourself, run:');
                console.log(`    mkdir -p ${targetDir}`);
                closeRl();
                process.exit(1);
            }
        }
    }

    console.log(`\n  Source:  ${sourceDir}`);
    console.log(`  Target: ${targetDir}`);

    // ---- Check for existing .claude/ ----
    const targetClaudeDir = path.join(targetDir, '.claude');
    const isUpgrade = fs.existsSync(targetClaudeDir);

    if (isUpgrade) {
        console.log('\n  Existing .claude/ found - no files will be copied.');
        console.log('  On a re-run, this script only:');
        console.log('    1. Makes your existing hook scripts executable (chmod +x)');
        console.log('    2. Updates skill-rules.json settings (only if that file exists)');
        console.log('    3. Runs npm install for hook dependencies');
        console.log('  If you want the new files from this repo, delete or rename your');
        console.log('  .claude/ first and re-run, or copy the pieces you want manually.');
    } else {
        console.log('\n  No .claude/ found - will copy full code-agents.');
    }

    // ---- Detect tech stack ----
    console.log('\n--- Tech Stack Detection ---');
    const stack = detectTechStack(targetDir);

    // Explicitly declared stack (--stack) always wins; in interactive mode with
    // nothing declared, let the user describe it. Detection seeds/augments it.
    let declaredTokens = parseDeclaredStack(opts.stack);
    if (!nonInteractive && declaredTokens.length === 0) {
        const answer = await promptString(
            '  Describe your tech stack (comma-separated, e.g. java-spring, vue, dotnet)\n  or leave blank to auto-detect',
            ''
        );
        declaredTokens = parseDeclaredStack(answer);
    }

    const autoTokens = detectionTokens(stack);
    // Effective profile: declared first (author intent), then anything detected.
    const profileTokens = Array.from(new Set([...declaredTokens, ...autoTokens]));
    const detected = profileTokens.map(labelForToken);

    if (declaredTokens.length > 0) {
        console.log(`  Declared stack: ${declaredTokens.map(labelForToken).join(', ')}`);
    }
    if (autoTokens.length > 0) {
        console.log(`  Auto-detected:  ${autoTokens.map(labelForToken).join(', ')}`);
    }
    if (profileTokens.length === 0) {
        console.log('  No specific frameworks detected (will use generic config).');
    }

    // ---- Mode selection ----
    let selectedMode: string;
    if (nonInteractive) {
        selectedMode = opts.mode;
        console.log(`\n  Activation mode: ${selectedMode} (from flags)`);
    } else {
        const modeIdx = await promptChoice(
            'Choose activation mode:',
            [
                'Classic (regex-only) - Zero cost, works offline, no API key needed',
                'AI-Enhanced (fallback) - AI classification with regex fallback',
                'AI-Only - Pure AI classification, no fallback',
            ],
            0
        );
        selectedMode = ['disabled', 'fallback', 'ai-only'][modeIdx];
    }

    // ---- Provider selection ----
    let selectedProvider = '';
    if (selectedMode !== 'disabled') {
        if (nonInteractive) {
            selectedProvider = opts.provider;
            console.log(`  AI provider: ${selectedProvider} (from flags)`);
        } else {
            const providerIdx = await promptChoice(
                'Choose AI provider:',
                [
                    'Auto-detect - Try providers based on available API keys',
                    'Gemini - Free tier, fast (recommended)',
                    'OpenAI - GPT-4o-mini, pay-per-use',
                    'Anthropic - Claude Haiku, pay-per-use',
                    'Ollama - Local, free, no API key needed',
                ],
                0
            );

            const providers = ['auto', 'gemini', 'openai', 'anthropic', 'ollama'];
            selectedProvider = providers[providerIdx];
        }

        if (selectedProvider !== 'auto') {
            const valid = await validateProvider(selectedProvider);
            if (!valid) {
                if (nonInteractive) {
                    console.error('  Warning: provider not available right now - continuing anyway.');
                    console.error('  Skill activation falls back to regex matching until the key/server is set up.');
                } else {
                    const proceed = await promptString(
                        '\n  Provider not available. Continue anyway? (y/n)',
                        'y'
                    );
                    if (proceed.toLowerCase() !== 'y') {
                        console.log('  Setup cancelled.');
                        closeRl();
                        process.exit(0);
                    }
                }
            }
        }
    }

    // ---- Conservativeness ----
    let conservativeness: string;
    if (nonInteractive) {
        conservativeness = opts.conservativeness;
    } else {
        const conservIdx = await promptChoice(
            'Choose conservativeness level:',
            [
                'Strict - Minimize false positives, only suggest when clear intent',
                'Balanced - Standard behavior (recommended)',
                'Aggressive - Catch everything, suggest liberally',
            ],
            1
        );
        conservativeness = ['strict', 'balanced', 'aggressive'][conservIdx];
    }

    // ---- Editor Configuration (Optional) ----
    let installEditor: boolean;
    if (nonInteractive) {
        installEditor = opts.editor;
    } else {
        const editorIdx = await promptChoice(
            'Install NeoVim editor config for Claude Code prompt editing? (Ctrl+G)',
            [
                'Skip - Keep current editor setup',
                'Install - NeoVim config optimized for prompt editing',
            ],
            0
        );
        installEditor = editorIdx === 1;
    }

    // ============================================================
    // APPLY CONFIGURATION
    // ============================================================
    console.log('\n--- Installing ---');

    // Step 1: Copy .claude/ if fresh install
    if (!isUpgrade) {
        const filesCopied = copyDirRecursive(sourceDir, targetClaudeDir, [
            'node_modules',
            'state',
            'data',
            'memory',
            'skill-guard.log',
            'settings.local.json',
            'tsc-cache',
        ]);
        console.log(`  Copied ${filesCopied} files to ${targetClaudeDir}`);
    }

    // Step 2: Make shell scripts executable
    const hooksDir = path.join(targetClaudeDir, 'hooks');
    if (fs.existsSync(hooksDir)) {
        try {
            execSync('chmod +x *.sh', { cwd: hooksDir, stdio: 'pipe' });
            console.log('  Made hook scripts executable');
        } catch (err) {
            if (process.platform === 'win32') {
                console.log('  Note: skipping chmod on Windows (not needed there).');
            } else {
                console.log(`  Warning: Could not chmod +x hooks: ${err instanceof Error ? err.message : err}`);
                console.log('  Run manually:');
                console.log(`    chmod +x ${path.join(hooksDir, '*.sh')}`);
            }
        }
    }

    // Step 3: Update skill-rules.json with settings
    const rulesPath = path.join(targetClaudeDir, 'skills', 'skill-rules.json');
    if (fs.existsSync(rulesPath)) {
        try {
            const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
            rules.version = '2.0';
            rules.settings = {
                skill_activation_mode: selectedMode,
                conservativeness,
                stack_profile: profileTokens,
            };
            fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 4));
            console.log(`  Updated skill-rules.json (mode: ${selectedMode}, conservativeness: ${conservativeness})`);
            if (profileTokens.length > 0) {
                console.log(`  Stack profile:    ${profileTokens.map(labelForToken).join(', ')}`);
            }
        } catch (err) {
            console.log(`  Warning: Could not update skill-rules.json: ${err}`);
        }
    }

    // Step 4: Install npm dependencies
    if (fs.existsSync(path.join(hooksDir, 'package.json'))) {
        console.log('  Installing hook dependencies (this may take a moment)...');
        try {
            execSync('npm install', { cwd: hooksDir, stdio: 'pipe' });
            console.log('  Dependencies installed.');
        } catch {
            console.log('  Warning: npm install failed. Run manually:');
            console.log(`    cd ${hooksDir} && npm install`);
        }
    }

    // Step 5: Install editor config (optional)
    if (installEditor) {
        const editorSrcDir = path.join(scriptDir, 'editor-config');
        if (fs.existsSync(editorSrcDir)) {
            // Copy init.lua to ~/.config/nvim/init.lua
            const nvimDir = path.join(os.homedir(), '.config', 'nvim');
            const initLuaSrc = path.join(editorSrcDir, 'init.lua');
            if (fs.existsSync(initLuaSrc)) {
                fs.mkdirSync(nvimDir, { recursive: true });
                fs.copyFileSync(initLuaSrc, path.join(nvimDir, 'init.lua'));
                console.log('  Copied init.lua -> ~/.config/nvim/init.lua');
            }

            // Copy vimrc to ~/.vimrc
            const vimrcSrc = path.join(editorSrcDir, 'vimrc');
            if (fs.existsSync(vimrcSrc)) {
                fs.copyFileSync(vimrcSrc, path.join(os.homedir(), '.vimrc'));
                console.log('  Copied vimrc -> ~/.vimrc');
            }
        }
    }

    // ============================================================
    // VERIFY
    // ============================================================
    const verifyScript = path.join(targetClaudeDir, 'scripts', 'verify-setup.sh');
    let verifyResult: 'passed' | 'failed' | 'skipped' = 'skipped';
    if (process.platform !== 'win32' && fs.existsSync(verifyScript)) {
        console.log('\n--- Verifying Installation ---');
        try {
            execSync(`bash "${verifyScript}"`, {
                cwd: targetDir,
                stdio: 'inherit',
                env: { ...process.env, CLAUDE_PROJECT_DIR: targetDir },
            });
            verifyResult = 'passed';
        } catch {
            verifyResult = 'failed';
        }
    }

    // ============================================================
    // SUMMARY
    // ============================================================
    console.log('\n============================================================');
    console.log(verifyResult === 'failed' ? '  Setup Finished - With Failed Checks' : '  Setup Complete!');
    console.log('============================================================');
    console.log(`  Project:          ${targetDir}`);
    console.log(`  Mode:             ${selectedMode}`);
    console.log(`  Provider:         ${selectedProvider || 'N/A (regex-only)'}`);
    console.log(`  Conservativeness: ${conservativeness}`);
    console.log(`  Tech stack:       ${detected.join(', ') || 'generic'}`);
    if (verifyResult === 'passed') {
        console.log('  Verification:     all checks passed');
    } else if (verifyResult === 'failed') {
        console.log('  Verification:     SOME CHECKS FAILED - fixes printed above');
        console.log('                    Re-check any time: bash .claude/scripts/verify-setup.sh');
    }
    if (installEditor) {
        console.log('  Editor:           NeoVim config installed');
    }

    if (isUpgrade) {
        console.log('\n  What was updated (no files copied - existing .claude/ left as-is):');
        if (fs.existsSync(hooksDir)) {
            console.log('    .claude/hooks/*.sh - made executable');
        }
        if (fs.existsSync(rulesPath)) {
            console.log('    .claude/skills/skill-rules.json - activation settings updated');
        }
        if (fs.existsSync(path.join(hooksDir, 'package.json'))) {
            console.log('    .claude/hooks/ - npm dependencies installed');
        }
    } else {
        console.log('\n  What was installed:');
        console.log('    .claude/hooks/     - Skill activation hooks (auto-trigger skills)');
        console.log('    .claude/skills/    - 4 production skills + skill-rules.json');
        console.log('    .claude/agents/    - 8 specialized agents');
        console.log('    .claude/commands/  - 4 slash commands (/dev-docs, /verify-setup, etc.)');
        console.log('    .claude/scripts/   - verify-setup.sh health check');
        console.log('    .claude/settings.json - Hook registrations');
    }
    if (installEditor) {
        console.log('    ~/.config/nvim/init.lua - NeoVim config (Space+w to submit)');
        console.log('    ~/.vimrc               - Vim fallback config');
    }

    if (installEditor) {
        console.log('\n  Editor setup:');
        console.log('    Add to your shell profile: export EDITOR=nvim');
        console.log('    Then: source ~/.bashrc');
    }

    // Tailor the first-step hint to the profile. We only ship guideline skills
    // for React (frontend) and Express/Node (backend); for any other stack we
    // point at the "adapt a skill" workflow instead of promising a skill fires.
    const shipsFrontend = profileTokens.includes('react');
    const shipsBackend = profileTokens.includes('express') || profileTokens.includes('node');
    const needsAdaptation = profileTokens
        .filter(t => FRAMEWORK_TOKENS.has(t) && !SHIPPED_FRAMEWORK_TOKENS.has(t))
        .map(labelForToken);

    console.log('\n  Get started:');
    console.log(`    1. cd ${targetDir} && claude`);
    if (shipsFrontend) {
        console.log('    2. Try this exact prompt and watch a skill auto-activate:');
        console.log('         "create a new React component"');
        console.log('       You should see frontend-dev-guidelines flagged before Claude responds.');
    } else if (shipsBackend) {
        console.log('    2. Try this exact prompt and watch a skill auto-activate:');
        console.log('         "create a new API endpoint"');
        console.log('       You should see backend-dev-guidelines flagged before Claude responds.');
    } else {
        console.log('    2. This repo ships guideline skills for React and Express/Node only.');
        console.log(`       For your stack (${detected.join(', ') || 'generic'}), ask Claude to adapt one:`);
        console.log('         "Adapt backend-dev-guidelines for my stack - see CLAUDE_INTEGRATION_GUIDE.md"');
    }
    if (needsAdaptation.length > 0 && (shipsFrontend || shipsBackend)) {
        console.log(`\n  Note: no shipped guideline skill yet for: ${needsAdaptation.join(', ')}.`);
        console.log('        Ask Claude to adapt one - see CLAUDE_INTEGRATION_GUIDE.md ("Adapting Skills").');
    }
    console.log('    3. Re-verify the install any time:');
    console.log('         bash .claude/scripts/verify-setup.sh');

    if (selectedMode !== 'disabled') {
        console.log('\n  AI mode needs an API key (until then it falls back to regex matching):');
        if (selectedProvider === 'ollama') {
            console.log('    1. Install Ollama: https://ollama.ai');
            console.log('    2. Run: ollama pull llama3.2 && ollama serve');
        } else {
            const keyName = selectedProvider === 'openai' ? 'OPENAI_API_KEY'
                : selectedProvider === 'anthropic' ? 'ANTHROPIC_API_KEY'
                    : 'GEMINI_API_KEY';
            if (keyName === 'GEMINI_API_KEY') {
                console.log('    1. Get a free key: https://aistudio.google.com/apikey');
            } else if (keyName === 'OPENAI_API_KEY') {
                console.log('    1. Get a key: https://platform.openai.com/api-keys');
            } else {
                console.log('    1. Get a key: https://console.anthropic.com/settings/keys');
            }
            console.log('    2. cp .claude/hooks/.env.example .claude/hooks/.env');
            console.log(`    3. Open .claude/hooks/.env and uncomment ${keyName}=your-key`);
        }
    } else {
        console.log('\n  To enable AI classification later:');
        console.log('    1. Edit .claude/skills/skill-rules.json: "skill_activation_mode" -> "fallback"');
        console.log('    2. Get a free Gemini key: https://aistudio.google.com/apikey');
        console.log('    3. cp .claude/hooks/.env.example .claude/hooks/.env and add the key there');
    }

    console.log('');
    closeRl();
}

main().catch(err => {
    console.error('Setup error:', err);
    closeRl();
    process.exit(1);
});
