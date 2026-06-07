import * as fs from 'fs';
import * as path from 'path';

/** Scan common project files to infer the test runner command. */
export function detectTestCommand(workspaceRoot: string): string | null {
    // ── JS / TS ──────────────────────────────────────────────────────────────
    const pkgPath = path.join(workspaceRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            const script: string = pkg.scripts?.test ?? '';
            if (script && !script.includes('exit 1') && !script.includes('echo "Error')) {
                if (script.includes('vitest'))   { return 'npx vitest run'; }
                if (script.includes('jest'))     { return 'npx jest'; }
                if (script.includes('mocha'))    { return 'npx mocha'; }
                if (script.includes('ava'))      { return 'npx ava'; }
                return 'npm test';
            }
            // No scripts.test, but vitest/jest/mocha in devDependencies
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };
            if (deps?.vitest)  { return 'npx vitest run'; }
            if (deps?.jest)    { return 'npx jest'; }
            if (deps?.mocha)   { return 'npx mocha'; }
        } catch { /* unparseable package.json */ }
    }

    // ── Python ───────────────────────────────────────────────────────────────
    if (
        fs.existsSync(path.join(workspaceRoot, 'pytest.ini')) ||
        fs.existsSync(path.join(workspaceRoot, 'pyproject.toml')) ||
        fs.existsSync(path.join(workspaceRoot, 'setup.cfg'))
    ) { return 'python -m pytest -v'; }
    if (fs.existsSync(path.join(workspaceRoot, 'setup.py'))) {
        return 'python -m pytest -v';
    }

    // ── Go ───────────────────────────────────────────────────────────────────
    if (fs.existsSync(path.join(workspaceRoot, 'go.mod'))) {
        return 'go test ./...';
    }

    // ── Rust ─────────────────────────────────────────────────────────────────
    if (fs.existsSync(path.join(workspaceRoot, 'Cargo.toml'))) {
        return 'cargo test';
    }

    // ── Ruby (RSpec) ─────────────────────────────────────────────────────────
    if (
        fs.existsSync(path.join(workspaceRoot, 'Gemfile')) &&
        fs.existsSync(path.join(workspaceRoot, 'spec'))
    ) { return 'bundle exec rspec'; }

    // ── Java — Maven ─────────────────────────────────────────────────────────
    if (fs.existsSync(path.join(workspaceRoot, 'pom.xml'))) {
        return 'mvn test -q';
    }

    // ── Java — Gradle ────────────────────────────────────────────────────────
    if (
        fs.existsSync(path.join(workspaceRoot, 'build.gradle')) ||
        fs.existsSync(path.join(workspaceRoot, 'build.gradle.kts'))
    ) { return './gradlew test'; }

    // ── PHP (PHPUnit) ────────────────────────────────────────────────────────
    if (fs.existsSync(path.join(workspaceRoot, 'phpunit.xml')) ||
        fs.existsSync(path.join(workspaceRoot, 'phpunit.xml.dist'))) {
        return './vendor/bin/phpunit';
    }

    // ── .NET ─────────────────────────────────────────────────────────────────
    if (
        fs.existsSync(path.join(workspaceRoot, 'global.json')) ||
        fs.readdirSync(workspaceRoot).some(f => f.endsWith('.sln') || f.endsWith('.csproj'))
    ) { return 'dotnet test'; }

    return null;
}

/**
 * Build the test-loop prompt sent to the agent.
 * Instructs it to run, read failures, fix source files, and retry — up to 3 times.
 */
export function buildTestLoopPrompt(testCommand: string): string {
    return `Run the test suite and fix all failures autonomously.

**Test command:** \`${testCommand}\`

Follow this loop:
1. Run \`${testCommand}\` using run_terminal.
2. If all tests pass → report success and stop.
3. If there are failures:
   a. Read the failing source files (not the test files) to understand the bug.
   b. Fix the root cause with edit_file. Only modify test files if they have obvious bugs (wrong expected values, missing imports, stale snapshots).
   c. Run the tests again.
4. Repeat up to 3 fix attempts. If tests still fail, explain the remaining issue clearly and stop.

Be surgical — fix only what is failing; do not refactor unrelated code.`;
}
