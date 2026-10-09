/** Prompts for Plan mode and code review, sent as the user turn of those requests. */

export const PLAN_PROMPT = `You are a task planner. The user has described a goal. Break it down into a clear, numbered step-by-step plan.

Rules:
- Each step must be a single, concrete, actionable task (no vague steps like "set up the project").
- Number steps as 1. 2. 3. etc.
- After the numbered list, add a section: ## Files Affected — list every file that will be created or modified.
- Do NOT write any code yet. Do NOT execute anything. Only produce the plan.
- End with a single line: > Approve the plan to begin execution.

Goal: `;

export const REVIEW_PROMPT = `You are performing a thorough code review. Analyse the code provided and produce a structured report with these exact sections:

## Overview
One paragraph describing what the code does and its overall quality.

## Issues
List every issue found, each prefixed with a severity badge:
- 🔴 **Critical** — bugs, security vulnerabilities, data loss risks
- 🟡 **Warning** — logic errors, poor error handling, performance problems, deprecated APIs
- 🔵 **Info** — style inconsistencies, naming, missing docs, minor improvements

For each issue include: file/line reference (if determinable), a clear explanation, and a concrete fix or code snippet.
If there are no issues in a category, omit that category.

## Suggestions
Up to 5 actionable improvement ideas that are not bugs but would meaningfully improve the code (architecture, testability, readability, performance).

## Summary
One-sentence verdict: e.g. "Ready to merge with minor changes" / "Needs significant rework before merging".

Be thorough, specific, and constructive. Reference exact line numbers or code snippets wherever possible.`;
