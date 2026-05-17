---
name: kotlin-expert
description: Author, edit, refactor, and review Kotlin code for idiomatic syntax, ergonomic APIs, correctness, maintainability, null-safety, coroutine usage, Kotlin/JVM or Multiplatform interop, Gradle Kotlin DSL, and Kotlin testing. Use when Codex is asked to write Kotlin, improve Kotlin style, review Kotlin diffs, explain Kotlin-specific design choices, or align code with current Kotlin documentation and best practices.
---

# Kotlin Expert

## Live Kotlin Reference

At the start of each triggered use, retrieve the current Kotlin LLM documentation index from:

```text
https://kotlinlang.org/llms.txt
```

Do not store, vendor, cache, or copy that file into this skill. Use it fresh each time. Treat it as an index: fetch only the specific linked Kotlin documentation pages needed for the task, such as language features, Gradle setup, coroutines, multiplatform, serialization, or testing.

If the preferred fetch method fails for `llms.txt` or a selected linked doc, retry the same URL with curl:

```bash
curl -L --fail --silent --show-error \
  -H 'Accept: text/markdown,text/plain,*/*' \
  <url>
```

If curl fails because sandboxed network access or DNS lookup is blocked, retry the curl command with sandbox escalation and a narrow justification. If network access remains unavailable, say so briefly and continue from repo context and stable Kotlin knowledge.

When using fetched documentation, prefer official Kotlin pages from `kotlinlang.org`. For libraries or tools outside Kotlin itself, prefer their official docs.

## Workflow

1. Identify the Kotlin context: Kotlin version, JVM target or multiplatform targets, Gradle plugins, enabled linters, test framework, and local code style.
2. Fetch `https://kotlinlang.org/llms.txt`, then fetch only the relevant linked docs for current or uncertain Kotlin details, using the curl fallback above when the preferred fetch path fails.
3. For code review requests, narrow the initial scope before inspecting deeply. Unless directed otherwise, check Kotlin files changed between the current branch and the repository's default branch, usually `main` or `master`; if there is no clear branch base, check Kotlin files touched by the last several commits or currently uncommitted changes.
4. Inspect nearby project code before changing style or APIs.
5. Prefer the repository's established conventions unless they conflict with correctness or current Kotlin guidance.
6. Author or review with a Kotlin-first shape: expressive, type-safe, simple, and easy for downstream callers to use.
7. Verify with the narrowest meaningful tasks available, usually compile, tests, ktlint, detekt, or relevant Gradle checks.
8. When any authoring, refactoring, or review task results in code changes, recommend running `$simplify` as a post-completion cleanup pass.

## Authoring Guidance

Use idiomatic Kotlin instead of Java translated into Kotlin:

- Prefer immutable values, small functions, expression bodies where they clarify intent, and narrow visibility.
- Model data with `data class`, `value class`, `sealed` hierarchies, enums, or interfaces based on the domain shape.
- Use nullable types deliberately; avoid `!!` except at tightly proven boundaries.
- Prefer constructor injection and explicit dependencies over hidden globals.
- Prefer extension functions only when they improve call-site clarity without hiding important ownership.
- Use scope functions sparingly; choose the one whose receiver and return value make the code easiest to read.
- Keep public APIs ergonomic: stable names, minimal generic noise, Kotlin collection types, sensible defaults, and no leaked implementation details.
- For `@JvmInline value class` wrappers and small public primitives, validate
  only invariants that are true for every semantic use of the type. Put
  operation-specific constraints in factories, request builders, or narrower
  wrapper types so valid zero, negative, sentinel, or unavailable domain values
  are not rejected accidentally.
- Avoid premature abstractions, clever DSLs, and excessive type gymnastics unless they simplify real caller code.
- Preserve Java interop intentionally when publishing JVM libraries: consider nullability annotations, overloads, visibility, and binary compatibility.

For concurrency, prefer structured concurrency. Do not launch unscoped coroutines from library code. Make cancellation, dispatcher choice, backpressure, and resource ownership explicit. For streams, choose `Flow` only when it fits the lifecycle and semantics better than a suspend function or collection.

For channels and callback-to-`Flow` bridges, remember that `trySend` is
non-suspending. Do not combine a non-suspending callback path with
`BufferOverflow.SUSPEND` unless the implementation actually calls a suspending
send from an appropriate coroutine. Distinguish a closed channel from a full
buffer, and make mapper failures, collector cancellation, and terminal shutdown
cancel upstream resources deterministically.

For error handling, use exceptions for exceptional failures and typed results for expected domain outcomes. Do not wrap everything in `Result` by reflex; optimize for clear caller behavior.

## Review Guidance

Lead with correctness and API risks, then idiom and maintainability. For reviews, report findings first, ordered by severity, with file and line references when available.

Prefer a scoped review surface. Use the merge base between the current branch and the remote default branch when available, for example `origin/main...HEAD` or `origin/master...HEAD`. If the user is on the default branch, or branch metadata is unavailable, inspect the last several commits and any uncommitted Kotlin changes. Expand to broader files only when needed to understand behavior, API contracts, tests, or call sites.

Check for:

- Incorrect nullability, platform-type leakage, unchecked casts, unsafe smart-cast assumptions, and accidental mutation.
- Coroutine leaks, blocking calls in suspend contexts, swallowed cancellation, or dispatcher misuse.
- Channel and `Flow` bridges that treat `trySend` failure as cancellation
  without checking whether the buffer is merely full, or that leave upstream
  work running after mapper failure or collector cancellation.
- Over-broad value-class validation that rejects valid domain values because an
  operation-specific invariant was placed on a shared type.
- Public APIs exposing internal/vendor types or implementation-specific collections.
- Java-style Kotlin: mutable bean patterns, verbose getters, utility classes where top-level functions or objects fit better, or needless builders.
- Overuse of scope functions, implicit receivers, inline/reified tricks, reflection, or DSLs that reduce readability.
- Missing tests around behavior, edge cases, concurrency, serialization, or interop boundaries.
- Build setup mismatches: Kotlin version, JVM target, explicit API mode, lint/detekt tasks, and dependency scopes.

When recommending a rewrite, show the smallest clear Kotlin shape that fixes the issue. Avoid style churn unless the user asked for cleanup or the code is already being touched.

## Verification

Prefer project-native commands. For Gradle projects, look for tasks such as:

```bash
./gradlew test
./gradlew check
./gradlew ktlintCheck
./gradlew detekt
```

If checks cannot run, explain the blocker and what remains unverified.

When the task changes code, recommend `$simplify` after completion so the changed code gets a focused reuse, quality, and efficiency cleanup pass.
