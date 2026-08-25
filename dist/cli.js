#!/usr/bin/env node
import { createRequire as __WEBPACK_EXTERNAL_createRequire } from "module";
/******/ // The require scope
/******/ var __nccwpck_require__ = {};
/******/ 
/************************************************************************/
/******/ /* webpack/runtime/compat get default export */
/******/ (() => {
/******/ 	// getDefaultExport function for compatibility with non-harmony modules
/******/ 	__nccwpck_require__.n = (module) => {
/******/ 		var getter = module && module.__esModule ?
/******/ 			() => (module['default']) :
/******/ 			() => (module);
/******/ 		__nccwpck_require__.d(getter, { a: getter });
/******/ 		return getter;
/******/ 	};
/******/ })();
/******/ 
/******/ /* webpack/runtime/define property getters */
/******/ (() => {
/******/ 	// define getter functions for harmony exports
/******/ 	__nccwpck_require__.d = (exports, definition) => {
/******/ 		for(var key in definition) {
/******/ 			if(__nccwpck_require__.o(definition, key) && !__nccwpck_require__.o(exports, key)) {
/******/ 				Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 			}
/******/ 		}
/******/ 	};
/******/ })();
/******/ 
/******/ /* webpack/runtime/hasOwnProperty shorthand */
/******/ (() => {
/******/ 	__nccwpck_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
/******/ })();
/******/ 
/******/ /* webpack/runtime/compat */
/******/ 
/******/ if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = new URL('.', import.meta.url).pathname.slice(import.meta.url.match(/^file:\/\/\/\w:/) ? 1 : 0, -1) + "/";
/******/ 
/************************************************************************/
var __webpack_exports__ = {};

;// CONCATENATED MODULE: external "node:fs"
const external_node_fs_namespaceObject = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("node:fs");
;// CONCATENATED MODULE: external "node:path"
const external_node_path_namespaceObject = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("node:path");
var external_node_path_default = /*#__PURE__*/__nccwpck_require__.n(external_node_path_namespaceObject);
;// CONCATENATED MODULE: ./src/report/format.ts
/**
 * Private helpers shared by the Module D renderers. Not part of the public API.
 *
 * Every renderer reads findings through the allow-list accessors here, so a
 * field planted upstream (a `value`, above all) can never reach an output (I1).
 */
const KNOWN_TARGETS = ["production", "preview", "development"];
const TARGET_LABELS = {
    production: "Production",
    preview: "Preview",
    development: "Development",
};
/** "preview" → "Preview". Falls back to capitalising an unexpected target. */
function targetLabel(target) {
    const known = TARGET_LABELS[target];
    if (known !== undefined)
        return known;
    return target.charAt(0).toUpperCase() + target.slice(1);
}
const STATUS_EMOJI = {
    missing: "🔴",
    missing_optional: "🟡",
    elsewhere: "🟡",
    unused: "ℹ️",
    present: "✅",
    ignored: "ℹ️",
};
/** Statuses that describe a problem worth naming in a rendered body. */
const REPORTABLE = [
    "missing",
    "missing_optional",
    "elsewhere",
    "unused",
];
function isReportable(status) {
    return REPORTABLE.includes(status);
}
function readinessWord(status) {
    if (status === "fail")
        return "FAIL";
    if (status === "error")
        return "ERROR";
    return "PASS";
}
/** Copies exactly the five fields a renderer may read. Everything else is dropped. */
function safeFinding(finding) {
    const sites = [];
    for (const site of finding.sites ?? []) {
        sites.push({ file: String(site.file), line: Number(site.line) });
    }
    const found = finding.foundIn ?? [];
    return {
        key: String(finding.key),
        status: finding.status,
        detail: typeof finding.detail === "string" ? finding.detail : "",
        sites,
        foundIn: KNOWN_TARGETS.filter((target) => found.includes(target)),
    };
}
function safeFindings(report) {
    return (report.findings ?? []).map(safeFinding);
}
/** The first site as `file:line`, or undefined when a finding has no site. */
function firstSite(finding) {
    return finding.sites[0];
}

;// CONCATENATED MODULE: ./src/report/text.ts
/**
 * SPEC: docs/SPEC.md — Module D `report` renderers, `renderText` (the CLI block).
 */

function text_location(finding) {
    const site = firstSite(finding);
    if (!site)
        return "";
    return `  (${site.file}:${site.line})`;
}
function lineFor(finding, target) {
    const emoji = STATUS_EMOJI[finding.status];
    const where = text_location(finding);
    switch (finding.status) {
        case "missing":
            return `${emoji} ${finding.key} referenced but missing from ${target}${where}`;
        case "missing_optional":
            return `${emoji} ${finding.key} optional, missing from ${target}${where}`;
        case "elsewhere": {
            const detail = finding.detail === "" ? "" : ` ${finding.detail}`;
            return `${emoji} ${finding.key} exists${detail}${where}`;
        }
        case "unused":
            return `${emoji} ${finding.key} declared but never referenced${where}`;
        default:
            return null;
    }
}
function renderText(report) {
    const target = targetLabel(report.target);
    const lines = [];
    for (const finding of safeFindings(report)) {
        const line = lineFor(finding, target);
        if (line !== null)
            lines.push(line);
    }
    const present = Number(report.counts?.present ?? 0);
    if (present > 0) {
        const noun = present === 1 ? "variable" : "variables";
        lines.push(`✅ ${present} other required ${noun} covered`);
    }
    lines.push(`Environment readiness: ${readinessWord(report.status)}`);
    return lines.join("\n");
}

;// CONCATENATED MODULE: ./src/report/json.ts
/**
 * SPEC: docs/SPEC.md — Module D `report` renderers, `toJSON` + invariant I3
 * (deterministic: sorted keys, stable ordering, no timestamps).
 */

/** The only count names that survive the projection, already in ascending order. */
const COUNT_KEYS = [
    "dynamic",
    "elsewhere",
    "missing",
    "missing_optional",
    "present",
    "unused",
];
/** Allow-listed projection. Any field not named here — `value` above all — is dropped. */
function toJSON(report) {
    const counts = {};
    for (const name of COUNT_KEYS) {
        counts[name] = Number(report.counts?.[name] ?? 0);
    }
    const findings = safeFindings(report).map((finding) => {
        // Object keys are written in ascending order so JSON.stringify is stable.
        const rest = {
            foundIn: finding.foundIn.map((target) => String(target)),
            key: finding.key,
            sites: finding.sites.map((site) => ({ file: site.file, line: site.line })),
            status: String(finding.status),
        };
        if (finding.detail !== "")
            return { detail: finding.detail, ...rest };
        return rest;
    });
    return {
        branch: report.branch === null || report.branch === undefined ? null : String(report.branch),
        counts,
        dynamicAccess: Number(report.dynamicAccess ?? 0),
        findings,
        status: String(report.status),
        target: String(report.target),
        version: String(report.version),
    };
}
/** `JSON.stringify(toJSON(r))` with deterministic key order. */
function stringifyReport(report) {
    return JSON.stringify(toJSON(report));
}

;// CONCATENATED MODULE: external "node:os"
const external_node_os_namespaceObject = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("node:os");
var external_node_os_default = /*#__PURE__*/__nccwpck_require__.n(external_node_os_namespaceObject);
;// CONCATENATED MODULE: ./src/version.ts
/**
 * The version reported in the User-Agent and in every report body.
 *
 * It is a compile-time constant on purpose: the bundled action reads no files at
 * startup, so there is no `package.json` to consult at runtime. `package.json`
 * stays the source of truth — `tests/invariants.test.ts` fails the build if the
 * two ever drift apart, so bumping one means bumping the other.
 */
const VERSION = "1.0.0";
/** The User-Agent sent on every Vercel request: `envcontract/<version>`. */
const USER_AGENT = `envcontract/${VERSION}`;

;// CONCATENATED MODULE: ./src/compare.ts
/**
 * SPEC: docs/SPEC.md — Module C `compare` (pure).
 */

/** The order findings are grouped in. */
const FINDING_ORDER = [
    "missing",
    "missing_optional",
    "elsewhere",
    "unused",
    "present",
    "ignored",
];
/** production → preview → development, the canonical order everything is emitted in. */
const TARGET_ORDER = ["production", "preview", "development"];
const compare_TARGET_LABELS = {
    production: "Production",
    preview: "Preview",
    development: "Development",
};
/** Code-unit ordering — locale-independent, so the output is byte-stable (I3). */
function byString(a, b) {
    if (a < b)
        return -1;
    if (a > b)
        return 1;
    return 0;
}
function escapeRegExp(literal) {
    return literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
/** Exact key, or a `PREFIX_*` glob. `*` matches any run of characters. */
function matchesPattern(pattern, key) {
    if (!pattern.includes("*"))
        return pattern === key;
    const source = pattern.split("*").map(escapeRegExp).join(".*");
    return new RegExp(`^${source}$`).test(key);
}
function matchesAny(patterns, key) {
    for (const pattern of patterns) {
        if (matchesPattern(pattern, key))
            return true;
    }
    return false;
}
/**
 * SPEC presence rule: present for `target` iff `targets` includes it (or the
 * given customEnvironmentId is listed) AND (`gitBranch` is null OR (target is
 * preview AND gitBranch === branch)). A non-preview var carrying a gitBranch is
 * treated as present.
 */
function isPresent(envVar, opts) {
    const inTargets = envVar.targets.includes(opts.target);
    const inCustomEnv = opts.customEnvironmentId !== undefined &&
        envVar.customEnvironmentIds.includes(opts.customEnvironmentId);
    if (!inTargets && !inCustomEnv)
        return false;
    if (envVar.gitBranch === null)
        return true;
    if (opts.target !== "preview")
        return true;
    return envVar.gitBranch === opts.branch;
}
/** The targets a key exists in at all, ignoring the requested target. */
function targetsFor(key, env) {
    const seen = new Set();
    for (const envVar of env) {
        if (envVar.key !== key)
            continue;
        for (const target of envVar.targets)
            seen.add(target);
    }
    return TARGET_ORDER.filter((target) => seen.has(target));
}
/** The branches a key is pinned to on preview, sorted and de-duplicated. */
function previewBranchesFor(key, env) {
    const branches = new Set();
    for (const envVar of env) {
        if (envVar.key !== key)
            continue;
        if (!envVar.targets.includes("preview"))
            continue;
        if (envVar.gitBranch !== null)
            branches.add(envVar.gitBranch);
    }
    return [...branches].sort(byString);
}
/** "in Production only", "in Preview for branch `staging` only", "in Production and Development". */
function describeElsewhere(key, env) {
    const targets = targetsFor(key, env);
    if (targets.length === 0)
        return "";
    if (targets.length === 1 && targets[0] === "preview") {
        const branch = previewBranchesFor(key, env)[0];
        if (branch !== undefined)
            return `in Preview for branch \`${branch}\` only`;
    }
    const labels = targets.map((target) => compare_TARGET_LABELS[target]);
    if (labels.length === 1)
        return `in ${labels[0]} only`;
    const last = labels[labels.length - 1];
    const head = labels.slice(0, -1).join(", ");
    return `in ${head} and ${last}`;
}
/** Which finding statuses fail under a `fail_on` setting. */
function failingStatuses(failOn) {
    if (failOn === "never")
        return [];
    if (failOn === "missing")
        return ["missing"];
    return ["missing", "elsewhere"];
}
function sitesFor(scan, key) {
    const info = scan.keys.get(key);
    if (!info)
        return [];
    return [...info.sites]
        .sort((a, b) => byString(a.file, b.file) || a.line - b.line || a.col - b.col)
        .map((reference) => ({ file: reference.file, line: reference.line }));
}
function compare(scan, declared, env, opts) {
    const presenceOpts = { target: opts.target, branch: opts.branch, customEnvironmentId: opts.customEnvironmentId };
    const keys = new Set();
    for (const key of scan.keys.keys())
        keys.add(key);
    for (const key of declared.keys())
        keys.add(key);
    // A literal `required` entry pulls a key into the report even when nothing
    // else mentions it. A glob cannot conjure a key name, so it is skipped here.
    for (const pattern of opts.required) {
        if (!pattern.includes("*"))
            keys.add(pattern);
    }
    const findings = [];
    for (const key of [...keys].sort(byString)) {
        const sites = sitesFor(scan, key);
        const foundIn = targetsFor(key, env);
        if (matchesAny(opts.ignore, key)) {
            findings.push({ key, status: "ignored", sites, foundIn });
            continue;
        }
        const inCode = scan.keys.has(key);
        const declaration = declared.get(key);
        const forcedRequired = matchesAny(opts.required, key);
        const forcedOptional = matchesAny(opts.optional, key);
        // Declared in `.env.example` but never dereferenced: informational only,
        // unless the user explicitly demanded the key.
        if (!inCode && !forcedRequired && declaration !== undefined) {
            findings.push({ key, status: "unused", sites, foundIn });
            continue;
        }
        let required;
        if (forcedRequired)
            required = true;
        else if (forcedOptional)
            required = false;
        else if (inCode)
            required = scan.keys.get(key)?.required ?? true;
        else if (declaration !== undefined)
            required = !declaration.optional;
        else
            required = true;
        const present = env.some((envVar) => envVar.key === key && isPresent(envVar, presenceOpts));
        if (present) {
            findings.push({ key, status: "present", sites, foundIn });
        }
        else if (!required) {
            findings.push({ key, status: "missing_optional", sites, foundIn });
        }
        else if (foundIn.length > 0) {
            findings.push({
                key,
                status: "elsewhere",
                detail: describeElsewhere(key, env),
                sites,
                foundIn,
            });
        }
        else {
            findings.push({ key, status: "missing", sites, foundIn });
        }
    }
    findings.sort((a, b) => FINDING_ORDER.indexOf(a.status) - FINDING_ORDER.indexOf(b.status) || byString(a.key, b.key));
    const counts = {
        missing: 0,
        missing_optional: 0,
        present: 0,
        elsewhere: 0,
        unused: 0,
        dynamic: scan.dynamicAccess.length,
    };
    for (const finding of findings) {
        if (finding.status === "missing")
            counts.missing += 1;
        else if (finding.status === "missing_optional")
            counts.missing_optional += 1;
        else if (finding.status === "present")
            counts.present += 1;
        else if (finding.status === "elsewhere")
            counts.elsewhere += 1;
        else if (finding.status === "unused")
            counts.unused += 1;
    }
    const failing = new Set(failingStatuses(opts.failOn ?? "elsewhere"));
    const failed = findings.some((finding) => failing.has(finding.status));
    return {
        status: failed ? "fail" : "pass",
        target: opts.target,
        branch: opts.branch ?? null,
        counts,
        findings,
        dynamicAccess: scan.dynamicAccess.length,
        version: VERSION,
    };
}

;// CONCATENATED MODULE: ./src/report/annotations.ts
/**
 * SPEC: docs/SPEC.md — Module D `report` renderers, `renderAnnotations`.
 */

const MAX_ANNOTATION_MESSAGE = 200;
/** Levels are static: they never vary with the report status or `fail_on`. */
const LEVELS = {
    missing: "error",
    elsewhere: "warning",
    missing_optional: "warning",
};
/** Collapses newlines and clips to the cap, ending in an ellipsis when clipped. */
function clip(message) {
    const flat = message.replace(/\s+/g, " ").trim();
    if (flat.length <= MAX_ANNOTATION_MESSAGE)
        return flat;
    return `${flat.slice(0, MAX_ANNOTATION_MESSAGE - 1)}…`;
}
function messageFor(finding, target) {
    if (finding.status === "elsewhere") {
        const detail = finding.detail === "" ? "another environment" : finding.detail;
        return clip(`${finding.key} is missing from ${target}; it exists ${detail}.`);
    }
    if (finding.status === "missing_optional") {
        return clip(`${finding.key} is optional and missing from ${target}.`);
    }
    return clip(`${finding.key} is referenced in code but missing from ${target}.`);
}
/** One annotation per missing / elsewhere / missing_optional key, at its FIRST site. */
function renderAnnotations(report) {
    const target = targetLabel(report.target);
    const annotations = [];
    for (const finding of safeFindings(report)) {
        const level = LEVELS[finding.status];
        if (level === undefined)
            continue;
        // A GitHub annotation needs an honest file and line, so a key with no site
        // in code (a user-`required` key, say) is skipped rather than faked.
        const site = firstSite(finding);
        if (!site)
            continue;
        annotations.push({
            level,
            file: site.file,
            line: site.line,
            title: `EnvContract: ${finding.key}`,
            message: messageFor(finding, target),
        });
    }
    return annotations;
}

;// CONCATENATED MODULE: ./src/report/markdown.ts
/**
 * SPEC: docs/SPEC.md — Module D `report` renderers, `renderMarkdown`.
 */

/** First line of every rendered body — the sticky-comment lookup key. */
const REPORT_MARKER = "<!-- envcontract:report -->";
/** Present keys are collapsed into a `<details>` block above this count. */
const PRESENT_DETAILS_THRESHOLD = 10;
const FOOTER_TEXT = "Continuously monitor every environment → https://envcontract.vercel.app";
const HEADER_BADGE = {
    pass: "✅ PASS",
    fail: "🔴 FAIL",
    error: "⚠️ ERROR",
};
const STATUS_LABEL = {
    missing: "Missing",
    missing_optional: "Missing (optional)",
    elsewhere: "Elsewhere",
    unused: "Unused",
};
/** Neither a pipe nor a backtick may escape a table cell and break the layout. */
function cell(text) {
    return text.replace(/\|/g, "\\|").replace(/`/g, "\\`");
}
function statusText(finding) {
    const label = STATUS_LABEL[finding.status] ?? finding.status;
    if (finding.status === "elsewhere" && finding.detail !== "") {
        return `${label} — ${finding.detail}`;
    }
    return label;
}
function referencedAt(finding) {
    const site = firstSite(finding);
    if (!site)
        return "—";
    const extra = finding.sites.length - 1;
    const suffix = extra > 0 ? ` +${extra} more` : "";
    return `${cell(site.file)}:${site.line}${suffix}`;
}
function renderMarkdown(report, opts) {
    const findings = safeFindings(report);
    const problems = findings.filter((finding) => isReportable(finding.status));
    const present = findings.filter((finding) => finding.status === "present");
    const target = targetLabel(report.target);
    const badge = HEADER_BADGE[report.status] ?? readinessWord(report.status);
    const lines = [REPORT_MARKER, `## EnvContract — ${target} readiness: ${badge}`];
    if (report.branch !== null && report.branch !== undefined && report.branch !== "") {
        lines.push("", `Branch \`${cell(String(report.branch))}\``);
    }
    if (problems.length > 0) {
        lines.push("", "| | Key | Status | Referenced at |", "| --- | --- | --- | --- |");
        for (const finding of problems) {
            const emoji = STATUS_EMOJI[finding.status];
            lines.push(`| ${emoji} | \`${cell(finding.key)}\` | ${cell(statusText(finding))} | ${referencedAt(finding)} |`);
        }
    }
    if (present.length > 0) {
        const bullets = present.map((finding) => `- \`${cell(finding.key)}\``);
        if (present.length > PRESENT_DETAILS_THRESHOLD) {
            lines.push("", "<details>", `<summary>${present.length} keys present in ${target}</summary>`, "", ...bullets, "", "</details>");
        }
        else {
            lines.push("", `${present.length} keys present in ${target}:`, "", ...bullets);
        }
    }
    if (opts?.licensed !== true) {
        lines.push("", FOOTER_TEXT);
    }
    return lines.join("\n");
}

;// CONCATENATED MODULE: ./src/scanner/envfile.ts
/**
 * SPEC: docs/SPEC.md — Module A `scanner`, "`.env.example` parsing".
 *
 * I1: a real `.env` (no `.example`/`.sample`/`.template` suffix) is NEVER read.
 * `isEnvExampleFile` is the single gate that decides what may be opened.
 */
/** Vercel's key grammar; case is preserved (`port` is a legal key). */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `export KEY=…`, the shell-sourceable form of a declaration. */
const EXPORT_PREFIX = /^export\s+/;
/** `#`, `##`, `#   ` — the comment marker plus the whitespace after it. */
const COMMENT_PREFIX = /^#+[ \t]*/;
const QUOTE_CHARACTERS = new Set(['"', "'", "`"]);
/** CRLF, LF and lone CR all end a line. */
const LINE_BREAK = /\r\n|\n|\r/;
function stripBom(content) {
    return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}
/**
 * True when `text` contains the closing `quote`. A backslash escapes the next
 * character, so `"a\"b"` does not close early.
 */
function closesQuote(text, quote) {
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (char === "\\") {
            i += 1;
            continue;
        }
        if (char === quote)
            return true;
    }
    return false;
}
/** Parses one `.env.example`-shaped file. Never throws on malformed lines. */
function parseEnvExample(content, file) {
    const declared = new Map();
    const warnings = [];
    const declare = (key, optional, line) => {
        if (declared.has(key)) {
            warnings.push({
                file,
                line,
                code: "duplicate_declaration",
                message: `\`${key}\` is declared more than once; the last declaration wins.`,
            });
        }
        declared.set(key, { optional, file, line });
    };
    // I1: the message names the line, never its contents.
    const warnInvalid = (line) => {
        warnings.push({
            file,
            line,
            code: "invalid_env_line",
            message: `Line ${line} is not a valid declaration and was ignored.`,
        });
    };
    const lines = stripBom(content).split(LINE_BREAK);
    for (let index = 0; index < lines.length; index += 1) {
        const trimmed = (lines[index] ?? "").trim();
        const lineNumber = index + 1;
        if (trimmed === "")
            continue;
        if (trimmed.startsWith("#")) {
            // `# KEY=` is a declared-optional key; anything else is prose.
            const body = trimmed.replace(COMMENT_PREFIX, "").replace(EXPORT_PREFIX, "");
            const equals = body.indexOf("=");
            if (equals <= 0)
                continue;
            const key = body.slice(0, equals).trim();
            if (!KEY_PATTERN.test(key))
                continue;
            declare(key, true, lineNumber);
            continue;
        }
        const body = trimmed.replace(EXPORT_PREFIX, "");
        const equals = body.indexOf("=");
        if (equals < 0) {
            // `KEY` with no `=` is still a declaration.
            if (KEY_PATTERN.test(body))
                declare(body, false, lineNumber);
            else
                warnInvalid(lineNumber);
            continue;
        }
        const key = body.slice(0, equals).trim();
        if (!KEY_PATTERN.test(key)) {
            warnInvalid(lineNumber);
            continue;
        }
        declare(key, false, lineNumber);
        // Only the shape of the value matters: a quoted value may span lines, and
        // the lines it swallows must not be parsed as declarations of their own.
        const value = body.slice(equals + 1).trimStart();
        const quote = value.charAt(0);
        if (!QUOTE_CHARACTERS.has(quote))
            continue;
        if (closesQuote(value.slice(1), quote))
            continue;
        index += 1;
        while (index < lines.length && !closesQuote(lines[index] ?? "", quote)) {
            index += 1;
        }
    }
    return { declared: sortByKey(declared), warnings };
}
/** Parses many; later files win on a duplicate key and record a warning. */
function parseEnvExamples(files) {
    const declared = new Map();
    const warnings = [];
    for (const file of files) {
        const result = parseEnvExample(file.content, file.path);
        warnings.push(...result.warnings);
        for (const [key, entry] of result.declared) {
            if (declared.has(key)) {
                warnings.push({
                    file: entry.file,
                    line: entry.line,
                    code: "duplicate_declaration",
                    message: `\`${key}\` is declared in more than one example file; ${entry.file} wins.`,
                });
            }
            declared.set(key, entry);
        }
    }
    return { declared: sortByKey(declared), warnings };
}
/** I3: the declared map is always ordered by key ascending. */
function sortByKey(map) {
    const sorted = new Map();
    for (const key of [...map.keys()].sort()) {
        const entry = map.get(key);
        if (entry)
            sorted.set(key, entry);
    }
    return sorted;
}
/**
 * True only for `.env.example`, `.env.sample`, `.env.template` and
 * `.env.<anything>.example`. False for `.env`, `.env.local`, `.env.production`.
 */
function isEnvExampleFile(path) {
    const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const basename = separator === -1 ? path : path.slice(separator + 1);
    return /^\.env(\..+)?\.(example|sample|template)$/.test(basename);
}

;// CONCATENATED MODULE: ./src/scanner/_scan-chars.ts
/**
 * Private character helpers shared by the scanner. Not part of the public
 * scanner surface: everything here operates on offsets into a source string.
 */
const CH_TAB = 9;
const CH_LF = 10;
const CH_VT = 11;
const CH_FF = 12;
const CH_CR = 13;
const CH_SPACE = 32;
const CH_DOLLAR = 36;
const CH_UNDERSCORE = 95;
const CH_NBSP = 0xa0;
const CH_LSEP = 0x2028;
const CH_PSEP = 0x2029;
const CH_IDEOGRAPHIC_SPACE = 0x3000;
const CH_BOM = 0xfeff;
function isWs(code) {
    return (code === CH_SPACE ||
        code === CH_TAB ||
        code === CH_LF ||
        code === CH_CR ||
        code === CH_VT ||
        code === CH_FF ||
        code === CH_NBSP ||
        code === CH_LSEP ||
        code === CH_PSEP ||
        code === CH_IDEOGRAPHIC_SPACE ||
        code === CH_BOM);
}
/** JS identifier character, approximated: ASCII word chars, `$`, and any non-space above ASCII. */
function isIdentChar(code) {
    return ((code >= 97 && code <= 122) ||
        (code >= 65 && code <= 90) ||
        (code >= 48 && code <= 57) ||
        code === CH_UNDERSCORE ||
        code === CH_DOLLAR ||
        (code > 127 && !isWs(code)));
}
/** First offset at or after `from` that is not whitespace. */
function skipWs(text, from) {
    let i = from;
    while (i < text.length && isWs(text.charCodeAt(i)))
        i += 1;
    return i;
}
/** Last offset at or before `from` that is not whitespace, or -1. */
function skipWsBack(text, from) {
    let i = from;
    while (i >= 0 && isWs(text.charCodeAt(i)))
        i -= 1;
    return i;
}
/** The identifier starting at `from`, or "" when `from` is not an identifier start. */
function readIdent(text, from) {
    let i = from;
    while (i < text.length && isIdentChar(text.charCodeAt(i)))
        i += 1;
    return text.slice(from, i);
}
/** The identifier ENDING at `from` (inclusive), or "" when there is none. */
function readIdentBack(text, from) {
    if (from < 0 || !isIdentChar(text.charCodeAt(from)))
        return "";
    let i = from;
    while (i >= 0 && isIdentChar(text.charCodeAt(i)))
        i -= 1;
    return text.slice(i + 1, from + 1);
}

;// CONCATENATED MODULE: ./src/scanner/ignore.ts
/**
 * SPEC: docs/SPEC.md — Module A `scanner`, "Built-in ignore list".
 *
 * Real data, not a stub: these constants ARE the contract. Keys matched here are
 * dropped from BOTH `references` and `keys`, and surfaced as `ignoredBuiltins`.
 */
/** Exact-match built-ins that the platform always provides on `process.env`. */
const BUILTIN_IGNORE = [
    // Node / generic runtime
    "NODE_ENV",
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "PORT",
    "HOSTNAME",
    "HOME",
    "PATH",
    "PWD",
    "TZ",
    "LANG",
    "CI",
    "TMPDIR",
    "DEBUG",
    "COLOR",
    "NO_COLOR",
    "FORCE_COLOR",
    "TERM",
    "SHELL",
    "USER",
    // Next.js
    "NEXT_RUNTIME",
    "NEXT_PHASE",
    "NEXT_TELEMETRY_DISABLED",
    "NEXT_MANUAL_SIG_HANDLE",
    // Vercel system environment variables
    "VERCEL",
    "VERCEL_ENV",
    "VERCEL_URL",
    "VERCEL_BRANCH_URL",
    "VERCEL_PROJECT_PRODUCTION_URL",
    "VERCEL_REGION",
    "VERCEL_DEPLOYMENT_ID",
    "VERCEL_PROJECT_ID",
    "VERCEL_TARGET_ENV",
    "VERCEL_OIDC_TOKEN",
    "VERCEL_SKEW_PROTECTION_ENABLED",
    "VERCEL_HASH_SALT",
    "VERCEL_AUTOMATION_BYPASS_SECRET",
    // AWS Lambda (Vercel functions run on Lambda)
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_EXECUTION_ENV",
    "_HANDLER",
    "LAMBDA_TASK_ROOT",
];
/** Prefix-matched built-in families. A key starting with any of these is ignored. */
const BUILTIN_IGNORE_PREFIXES = [
    "npm_",
    "NEXT_PRIVATE_",
    "__NEXT_",
    "VERCEL_GIT_",
    "NEXT_PUBLIC_VERCEL_",
    "AWS_LAMBDA_",
];
/**
 * Vite built-ins. These are ignored ONLY for `kind: "import.meta.env"` — a
 * `process.env.MODE` reference is a real user variable.
 */
const VITE_BUILTIN_IGNORE = ["MODE", "BASE_URL", "PROD", "DEV", "SSR"];
/* The data above and the three matchers below are the single source of truth. */
const EXACT_IGNORE = new Set(BUILTIN_IGNORE);
const VITE_IGNORE = new Set(VITE_BUILTIN_IGNORE);
/** True when `key` is a platform built-in for the given reference kind. */
function isBuiltinIgnored(key, kind) {
    if (EXACT_IGNORE.has(key))
        return true;
    for (const prefix of BUILTIN_IGNORE_PREFIXES) {
        if (key.startsWith(prefix))
            return true;
    }
    return kind === "import.meta.env" && VITE_IGNORE.has(key);
}
/**
 * Matches a key against a user ignore pattern: an exact key, or a `PREFIX_*`
 * glob (trailing `*` only).
 */
function matchesIgnorePattern(key, pattern) {
    if (pattern.endsWith("*"))
        return key.startsWith(pattern.slice(0, -1));
    return key === pattern;
}
/** True when `key` matches any of `patterns`. */
function matchesAnyIgnorePattern(key, patterns) {
    for (const pattern of patterns) {
        if (matchesIgnorePattern(key, pattern))
            return true;
    }
    return false;
}

;// CONCATENATED MODULE: ./src/scanner/tokenizer.ts
/**
 * SPEC: docs/SPEC.md — Module A `scanner`, "Tokenizer robustness".
 *
 * A single-pass state machine over JS/TS/JSX source that classifies every byte
 * as either CODE (scannable for references) or NON-CODE (line comment, block
 * comment, string literal body, template literal text, regex literal body).
 *
 * Template literal `${ ... }` expression interiors are CODE, recursively, at any
 * nesting depth.
 */
const tokenizer_CH_TAB = 9;
const tokenizer_CH_LF = 10;
const tokenizer_CH_VT = 11;
const tokenizer_CH_FF = 12;
const tokenizer_CH_CR = 13;
const tokenizer_CH_SPACE = 32;
const CH_BANG = 33;
const CH_DQUOTE = 34;
const CH_HASH = 35;
const tokenizer_CH_DOLLAR = 36;
const CH_SQUOTE = 39;
const CH_STAR = 42;
const CH_SLASH = 47;
const CH_LT = 60;
const CH_LBRACKET = 91;
const CH_BACKSLASH = 92;
const CH_RBRACKET = 93;
const tokenizer_CH_UNDERSCORE = 95;
const CH_BACKTICK = 96;
const CH_LBRACE = 123;
const CH_RBRACE = 125;
const CH_RPAREN = 41;
const tokenizer_CH_NBSP = 0xa0;
const tokenizer_CH_LSEP = 0x2028;
const tokenizer_CH_PSEP = 0x2029;
const tokenizer_CH_IDEOGRAPHIC_SPACE = 0x3000;
const tokenizer_CH_BOM = 0xfeff;
/** Keywords after which a `/` starts a regular expression, not a division. */
const REGEX_PRECEDING_KEYWORDS = new Set([
    "await",
    "case",
    "delete",
    "do",
    "else",
    "in",
    "instanceof",
    "new",
    "of",
    "return",
    "throw",
    "typeof",
    "void",
    "yield",
]);
function isWhitespaceCode(code) {
    return (code === tokenizer_CH_SPACE ||
        code === tokenizer_CH_TAB ||
        code === tokenizer_CH_LF ||
        code === tokenizer_CH_CR ||
        code === tokenizer_CH_VT ||
        code === tokenizer_CH_FF ||
        code === tokenizer_CH_NBSP ||
        code === tokenizer_CH_LSEP ||
        code === tokenizer_CH_PSEP ||
        code === tokenizer_CH_IDEOGRAPHIC_SPACE ||
        code === tokenizer_CH_BOM);
}
function isIdentifierCode(code) {
    return ((code >= 97 && code <= 122) ||
        (code >= 65 && code <= 90) ||
        (code >= 48 && code <= 57) ||
        code === tokenizer_CH_UNDERSCORE ||
        code === tokenizer_CH_DOLLAR ||
        (code > 127 && !isWhitespaceCode(code)));
}
const WARNING_MESSAGES = {
    unterminated_string: "unterminated string literal",
    unterminated_template: "unterminated template literal",
    unterminated_comment: "unterminated block comment",
    unterminated_regex: "unterminated regular expression literal",
};
/** Classify the source into code regions. Never throws on malformed input. */
function tokenize(source) {
    const length = source.length;
    const holes = [];
    const warnings = [];
    const addHole = (start, end) => {
        if (end > start)
            holes.push({ start, end });
    };
    const addWarning = (code, offset) => {
        const position = offsetToPosition(source, offset);
        warnings.push({
            code,
            offset,
            line: position.line,
            col: position.col,
            message: WARNING_MESSAGES[code],
        });
    };
    const stack = [];
    let prev = "other";
    let i = 0;
    // A hashbang is only a hashbang on the very first line, optionally after a BOM.
    const hashbangStart = source.charCodeAt(0) === tokenizer_CH_BOM ? 1 : 0;
    if (source.charCodeAt(hashbangStart) === CH_HASH &&
        source.charCodeAt(hashbangStart + 1) === CH_BANG) {
        const end = lineEndFrom(source, hashbangStart);
        addHole(hashbangStart, end);
        i = end;
    }
    while (i < length) {
        const frame = stack.length > 0 ? stack[stack.length - 1] : undefined;
        if (frame !== undefined && frame.kind === "template") {
            let j = i;
            let resolved = false;
            while (j < length) {
                const code = source.charCodeAt(j);
                if (code === CH_BACKSLASH) {
                    j += 2;
                    continue;
                }
                if (code === CH_BACKTICK) {
                    addHole(frame.textStart, j);
                    stack.pop();
                    i = j + 1;
                    prev = "division";
                    resolved = true;
                    break;
                }
                if (code === tokenizer_CH_DOLLAR && source.charCodeAt(j + 1) === CH_LBRACE) {
                    addHole(frame.textStart, j);
                    stack.push({ kind: "expr", depth: 0 });
                    i = j + 2;
                    prev = "other";
                    resolved = true;
                    break;
                }
                j += 1;
            }
            if (!resolved) {
                addHole(frame.textStart, length);
                addWarning("unterminated_template", frame.start);
                stack.pop();
                i = length;
            }
            continue;
        }
        const code = source.charCodeAt(i);
        if (isWhitespaceCode(code)) {
            i += 1;
            continue;
        }
        if (code === CH_SLASH) {
            const next = source.charCodeAt(i + 1);
            if (next === CH_SLASH) {
                const end = lineEndFrom(source, i);
                addHole(i, end);
                i = end;
                continue;
            }
            if (next === CH_STAR) {
                const close = source.indexOf("*/", i + 2);
                if (close === -1) {
                    addHole(i, length);
                    addWarning("unterminated_comment", i);
                    i = length;
                }
                else {
                    addHole(i, close + 2);
                    i = close + 2;
                }
                continue;
            }
            if (prev === "division") {
                i += 1;
                prev = "other";
                continue;
            }
            i = scanRegex(source, i, addHole, addWarning);
            prev = "division";
            continue;
        }
        if (code === CH_DQUOTE || code === CH_SQUOTE) {
            i = scanString(source, i, code, addHole, addWarning);
            prev = "division";
            continue;
        }
        if (code === CH_BACKTICK) {
            stack.push({ kind: "template", start: i, textStart: i + 1 });
            i += 1;
            continue;
        }
        if (code === CH_LBRACE) {
            if (frame !== undefined && frame.kind === "expr")
                frame.depth += 1;
            i += 1;
            prev = "other";
            continue;
        }
        if (code === CH_RBRACE) {
            if (frame !== undefined && frame.kind === "expr") {
                if (frame.depth === 0) {
                    stack.pop();
                    const outer = stack.length > 0 ? stack[stack.length - 1] : undefined;
                    if (outer !== undefined && outer.kind === "template")
                        outer.textStart = i + 1;
                    i += 1;
                    prev = "division";
                    continue;
                }
                frame.depth -= 1;
            }
            i += 1;
            prev = "division";
            continue;
        }
        if (code === CH_LT && source.charCodeAt(i + 1) === CH_SLASH) {
            // A JSX closing tag: the slash must never open a regex.
            i += 2;
            prev = "other";
            continue;
        }
        if (isIdentifierCode(code)) {
            let j = i + 1;
            while (j < length && isIdentifierCode(source.charCodeAt(j)))
                j += 1;
            const word = source.slice(i, j);
            prev = REGEX_PRECEDING_KEYWORDS.has(word) ? "other" : "division";
            i = j;
            continue;
        }
        if (code === CH_RPAREN || code === CH_RBRACKET) {
            i += 1;
            prev = "division";
            continue;
        }
        i += 1;
        prev = "other";
    }
    for (let k = stack.length - 1; k >= 0; k -= 1) {
        const frame = stack[k];
        if (frame !== undefined && frame.kind === "template") {
            addWarning("unterminated_template", frame.start);
            break;
        }
    }
    return { regions: complement(holes, length), warnings };
}
/** Offset of the line terminator at or after `from`, or the end of the source. */
function lineEndFrom(source, from) {
    let j = from;
    while (j < source.length) {
        const code = source.charCodeAt(j);
        if (code === tokenizer_CH_LF || code === tokenizer_CH_CR)
            return j;
        j += 1;
    }
    return source.length;
}
/** Consumes a string literal starting at its quote; returns the next offset. */
function scanString(source, start, quote, addHole, addWarning) {
    const length = source.length;
    let j = start + 1;
    while (j < length) {
        const code = source.charCodeAt(j);
        if (code === CH_BACKSLASH) {
            j += 2;
            continue;
        }
        if (code === tokenizer_CH_LF || code === tokenizer_CH_CR) {
            addHole(start + 1, j);
            addWarning("unterminated_string", start);
            return j;
        }
        if (code === quote) {
            addHole(start + 1, j);
            return j + 1;
        }
        j += 1;
    }
    addHole(start + 1, length);
    addWarning("unterminated_string", start);
    return length;
}
/** Consumes a regex literal starting at its opening slash; returns the next offset. */
function scanRegex(source, start, addHole, addWarning) {
    const length = source.length;
    let j = start + 1;
    let inClass = false;
    while (j < length) {
        const code = source.charCodeAt(j);
        if (code === CH_BACKSLASH) {
            j += 2;
            continue;
        }
        if (code === tokenizer_CH_LF || code === tokenizer_CH_CR) {
            addHole(start + 1, j);
            addWarning("unterminated_regex", start);
            return j;
        }
        if (code === CH_LBRACKET)
            inClass = true;
        else if (code === CH_RBRACKET)
            inClass = false;
        else if (code === CH_SLASH && !inClass) {
            addHole(start + 1, j);
            return j + 1;
        }
        j += 1;
    }
    addHole(start + 1, length);
    addWarning("unterminated_regex", start);
    return length;
}
/** The ascending complement of `holes` within `[0, length)`. */
function complement(holes, length) {
    const regions = [];
    let cursor = 0;
    for (const hole of holes) {
        if (hole.start > cursor)
            regions.push({ start: cursor, end: hole.start });
        if (hole.end > cursor)
            cursor = hole.end;
    }
    if (cursor < length)
        regions.push({ start: cursor, end: length });
    return regions;
}
/**
 * The source with every non-code byte replaced by a space (newlines preserved),
 * so byte offsets — and therefore line/col — are identical to the input.
 */
function maskNonCode(source, precomputed) {
    const regions = precomputed ?? tokenize(source).regions;
    const parts = [];
    let cursor = 0;
    for (const region of regions) {
        if (region.start > cursor)
            parts.push(blankOut(source, cursor, region.start));
        parts.push(source.slice(region.start, region.end));
        cursor = region.end;
    }
    if (cursor < source.length)
        parts.push(blankOut(source, cursor, source.length));
    return parts.join("");
}
/** `[start, end)` with every character but `\r` and `\n` replaced by a space. */
function blankOut(source, start, end) {
    let breakAt = -1;
    for (let i = start; i < end; i += 1) {
        const code = source.charCodeAt(i);
        if (code === tokenizer_CH_LF || code === tokenizer_CH_CR) {
            breakAt = i;
            break;
        }
    }
    if (breakAt === -1)
        return " ".repeat(end - start);
    const parts = [];
    let runStart = start;
    for (let i = start; i < end; i += 1) {
        const code = source.charCodeAt(i);
        if (code === tokenizer_CH_LF || code === tokenizer_CH_CR) {
            parts.push(" ".repeat(i - runStart), source[i]);
            runStart = i + 1;
        }
    }
    parts.push(" ".repeat(end - runStart));
    return parts.join("");
}
/** True when `offset` falls inside one of `regions`. */
function isCodeOffset(regions, offset) {
    if (offset < 0)
        return false;
    let low = 0;
    let high = regions.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        const region = regions[mid];
        if (region === undefined)
            return false;
        if (offset < region.start)
            high = mid - 1;
        else if (offset >= region.end)
            low = mid + 1;
        else
            return true;
    }
    return false;
}
/**
 * 1-based line/col for a byte offset. `\r\n` counts as one line break, a leading
 * UTF-8 BOM occupies no column.
 */
function offsetToPosition(source, offset) {
    let line = 1;
    let lineStart = 0;
    let cursor = 0;
    for (;;) {
        const breakAt = source.indexOf("\n", cursor);
        if (breakAt === -1 || breakAt >= offset)
            break;
        line += 1;
        lineStart = breakAt + 1;
        cursor = breakAt + 1;
    }
    let col = offset - lineStart + 1;
    if (line === 1 && source.charCodeAt(0) === tokenizer_CH_BOM)
        col -= 1;
    return { line, col: col < 1 ? 1 : col };
}
/** Strip a leading UTF-8 BOM, returning the text and how many chars were removed. */
function tokenizer_stripBom(source) {
    if (source.charCodeAt(0) === tokenizer_CH_BOM)
        return { text: source.slice(1), removed: 1 };
    return { text: source, removed: 0 };
}

;// CONCATENATED MODULE: ./src/scanner/scanner.ts
/**
 * SPEC: docs/SPEC.md — Module A `scanner` ("Recognized syntaxes", "Optional
 * detection", "Must NOT produce a Reference").
 */



const IGNORE_FILE_MARKER = "envcontract-ignore-file";
const IGNORE_LINE_MARKER = "envcontract-ignore";
const OPTIONAL_LINE_MARKER = "envcontract-optional";
const scanner_CH_BANG = 33;
const scanner_CH_DQUOTE = 34;
const CH_AMP = 38;
const scanner_CH_SQUOTE = 39;
const CH_LPAREN = 40;
const scanner_CH_RPAREN = 41;
const CH_COMMA = 44;
const CH_PLUS = 43;
const CH_MINUS = 45;
const CH_DOT = 46;
const CH_COLON = 58;
const scanner_CH_LT = 60;
const CH_EQ = 61;
const CH_GT = 62;
const CH_QUESTION = 63;
const scanner_CH_LBRACKET = 91;
const scanner_CH_BACKSLASH = 92;
const scanner_CH_RBRACKET = 93;
const scanner_CH_BACKTICK = 96;
const scanner_CH_LBRACE = 123;
const CH_PIPE = 124;
const scanner_CH_RBRACE = 125;
const scanner_CH_LF = 10;
const scanner_CH_CR = 13;
const scanner_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `[A-Za-z_][A-Za-z0-9_]*` — Vercel's key grammar. Case is preserved. */
function isValidKey(key) {
    return scanner_KEY_PATTERN.test(key);
}
/** An empty result, used as the identity when merging. */
function emptyScanResult() {
    return {
        references: [],
        keys: new Map(),
        dynamicAccess: [],
        ignoredBuiltins: [],
        warnings: [],
        filesScanned: 0,
    };
}
/** Pure: no I/O. Scans already-read files. */
function scanner_scanFiles(files, opts) {
    return mergeScanResults(files.map((file) => scanSource(file, opts)));
}
/** Merges per-file results, preserving the documented sort orders. */
function mergeScanResults(results) {
    const merged = emptyScanResult();
    const builtins = new Set();
    for (const result of results) {
        // Element-wise, never `push(...array)`: a minified file can hold more
        // references than the argument limit of a spread call.
        for (const reference of result.references)
            merged.references.push(reference);
        for (const access of result.dynamicAccess)
            merged.dynamicAccess.push(access);
        for (const warning of result.warnings)
            merged.warnings.push(warning);
        merged.filesScanned += result.filesScanned;
        for (const key of result.ignoredBuiltins)
            builtins.add(key);
    }
    merged.references.sort(compareReferences);
    merged.dynamicAccess.sort((a, b) => compareStrings(a.file, b.file) || a.line - b.line || compareStrings(a.kind, b.kind));
    merged.warnings.sort((a, b) => compareStrings(a.file, b.file) || a.line - b.line);
    merged.ignoredBuiltins = [...builtins].sort(compareStrings);
    merged.keys = buildKeys(merged.references);
    return merged;
}
function compareReferences(a, b) {
    return compareStrings(a.file, b.file) || a.line - b.line || a.col - b.col;
}
function compareStrings(a, b) {
    if (a < b)
        return -1;
    if (a > b)
        return 1;
    return 0;
}
function buildKeys(references) {
    const byKey = new Map();
    for (const reference of references) {
        const sites = byKey.get(reference.key);
        if (sites)
            sites.push(reference);
        else
            byKey.set(reference.key, [reference]);
    }
    const keys = new Map();
    for (const key of [...byKey.keys()].sort(compareStrings)) {
        const sites = byKey.get(key) ?? [];
        keys.set(key, { required: sites.some((site) => !site.optional), sites });
    }
    return keys;
}
/** Scans one file. `scanFiles` merges the per-file results. */
function scanSource(file, opts) {
    const result = emptyScanResult();
    result.filesScanned = 1;
    const source = file.content;
    if (source.includes(IGNORE_FILE_MARKER))
        return result;
    const { regions, warnings: tokenizerWarnings } = tokenize(source);
    const masked = maskNonCode(source, regions);
    const length = source.length;
    const lineStarts = [0];
    for (let i = 0; i < length; i += 1) {
        if (source.charCodeAt(i) === scanner_CH_LF)
            lineStarts.push(i + 1);
    }
    const hasBom = source.charCodeAt(0) === 0xfeff;
    const lineOf = (offset) => {
        let low = 0;
        let high = lineStarts.length - 1;
        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if ((lineStarts[mid] ?? 0) <= offset)
                low = mid;
            else
                high = mid - 1;
        }
        return low + 1;
    };
    const colOf = (offset, line) => {
        const col = offset - (lineStarts[line - 1] ?? 0) + 1 - (line === 1 && hasBom ? 1 : 0);
        return col < 1 ? 1 : col;
    };
    for (const warning of tokenizerWarnings) {
        result.warnings.push({
            file: file.path,
            line: warning.line,
            code: warning.code,
            message: warning.message,
        });
    }
    const ignoredLines = new Set();
    for (let at = source.indexOf(IGNORE_LINE_MARKER); at !== -1;) {
        ignoredLines.add(lineOf(at));
        at = source.indexOf(IGNORE_LINE_MARKER, at + 1);
    }
    const optionalLines = new Set();
    for (let at = source.indexOf(OPTIONAL_LINE_MARKER); at !== -1;) {
        const line = lineOf(at);
        optionalLines.add(line);
        optionalLines.add(line + 1);
        at = source.indexOf(OPTIONAL_LINE_MARKER, at + 1);
    }
    /* ------------------------------------------------------------- anchors */
    const anchors = [];
    const bareProcess = [];
    for (let at = masked.indexOf("process"); at !== -1; at = masked.indexOf("process", at + 7)) {
        if (at > 0 && isIdentChar(masked.charCodeAt(at - 1)))
            continue;
        let cursor = skipWs(masked, at + 7);
        if (masked.charCodeAt(cursor) === CH_QUESTION && masked.charCodeAt(cursor + 1) === CH_DOT) {
            cursor = skipWs(masked, cursor + 2);
        }
        else if (masked.charCodeAt(cursor) === CH_DOT) {
            cursor = skipWs(masked, cursor + 1);
        }
        else {
            bareProcess.push(at);
            continue;
        }
        if (!isWordAt(masked, cursor, "env"))
            continue;
        anchors.push({ kind: "process.env", start: at, end: cursor + 3 });
    }
    for (let at = masked.indexOf("import"); at !== -1; at = masked.indexOf("import", at + 6)) {
        if (at > 0 && isIdentChar(masked.charCodeAt(at - 1)))
            continue;
        let cursor = skipWs(masked, at + 6);
        if (masked.charCodeAt(cursor) !== CH_DOT)
            continue;
        cursor = skipWs(masked, cursor + 1);
        if (!isWordAt(masked, cursor, "meta"))
            continue;
        cursor = skipWs(masked, cursor + 4);
        if (masked.charCodeAt(cursor) !== CH_DOT)
            continue;
        cursor = skipWs(masked, cursor + 1);
        if (!isWordAt(masked, cursor, "env"))
            continue;
        anchors.push({ kind: "import.meta.env", start: at, end: cursor + 3 });
    }
    /* ------------------------------------------------------------- aliases */
    const aliases = new Map();
    const declarators = new Set(["const", "let", "var"]);
    const declaredNameBefore = (equalsAt) => {
        const nameEnd = skipWsBack(masked, equalsAt - 1);
        const name = readIdentBack(masked, nameEnd);
        if (name === "")
            return undefined;
        const keywordEnd = skipWsBack(masked, nameEnd - name.length);
        if (!declarators.has(readIdentBack(masked, keywordEnd)))
            return undefined;
        return name;
    };
    for (const anchor of anchors) {
        if (anchor.kind !== "process.env")
            continue;
        const equalsAt = assignmentBefore(masked, anchor.start);
        if (equalsAt === -1)
            continue;
        const name = declaredNameBefore(equalsAt);
        if (name === undefined || aliases.has(name))
            continue;
        aliases.set(name, anchor.end);
    }
    for (const at of bareProcess) {
        const equalsAt = assignmentBefore(masked, at);
        if (equalsAt === -1)
            continue;
        const closeAt = skipWsBack(masked, equalsAt - 1);
        if (masked.charCodeAt(closeAt) !== scanner_CH_RBRACE)
            continue;
        const openAt = matchingBraceBack(masked, closeAt);
        if (openAt === -1)
            continue;
        if (declaredNameBefore(openAt + 1) === undefined && !isDeclaratorBefore(masked, openAt))
            continue;
        for (const entry of destructuringEntries(masked, openAt + 1, closeAt)) {
            if (entry.key !== "env")
                continue;
            const local = entry.local ?? "env";
            if (!aliases.has(local))
                aliases.set(local, at + 7);
        }
    }
    for (const [name, from] of aliases) {
        for (let at = masked.indexOf(name); at !== -1; at = masked.indexOf(name, at + name.length)) {
            if (at < from)
                continue;
            const before = masked.charCodeAt(at - 1);
            if (at > 0 && (isIdentChar(before) || before === CH_DOT))
                continue;
            if (isIdentChar(masked.charCodeAt(at + name.length)))
                continue;
            const next = skipWs(masked, at + name.length);
            const nextCode = masked.charCodeAt(next);
            if (nextCode !== CH_DOT && nextCode !== scanner_CH_LBRACKET && nextCode !== CH_QUESTION)
                continue;
            anchors.push({ kind: "process.env", start: at, end: at + name.length });
        }
    }
    anchors.sort((a, b) => a.end - b.end);
    /* -------------------------------------------------------------- refs */
    const raw = [];
    const invalidKeys = [];
    const addKey = (key, keyOffset, kind, optional) => {
        if (!isValidKey(key)) {
            invalidKeys.push(keyOffset);
            return;
        }
        raw.push({ key, keyOffset, kind, optional });
    };
    for (const anchor of anchors) {
        let cursor = skipWs(masked, anchor.end);
        let code = masked.charCodeAt(cursor);
        if (code === CH_QUESTION && masked.charCodeAt(cursor + 1) === CH_DOT) {
            cursor = skipWs(masked, cursor + 2);
            code = masked.charCodeAt(cursor);
        }
        else if (code === CH_DOT) {
            cursor = skipWs(masked, cursor + 1);
            code = masked.charCodeAt(cursor);
            if (code === scanner_CH_LBRACKET)
                code = 0;
        }
        if (code === scanner_CH_LBRACKET) {
            const bracket = readBracketKey(source, masked, cursor);
            if (bracket === undefined) {
                result.dynamicAccess.push({
                    file: file.path,
                    line: lineOf(cursor),
                    kind: anchor.kind,
                });
                continue;
            }
            addKey(bracket.key, bracket.keyOffset, anchor.kind, isOptionalSite(masked, source, anchor.start, bracket.end));
            continue;
        }
        if (cursor > anchor.end) {
            // A member access: `…env.KEY`, `…env?.KEY`.
            const key = readIdent(source, cursor);
            if (key === "")
                continue;
            addKey(key, cursor, anchor.kind, isOptionalSite(masked, source, anchor.start, cursor + key.length));
            continue;
        }
        // Nothing follows the `env` token: destructuring, or the `in` probe.
        const destructured = destructuringBefore(masked, anchor.start);
        if (destructured !== undefined) {
            for (const entry of destructuringEntries(masked, destructured.open + 1, destructured.close)) {
                addKey(entry.key, entry.offset, anchor.kind, entry.optional);
            }
            continue;
        }
        const probe = inProbeBefore(masked, source, anchor.start);
        if (probe !== undefined)
            addKey(probe.key, probe.keyOffset, anchor.kind, true);
    }
    for (const offset of invalidKeys) {
        const line = lineOf(offset);
        if (ignoredLines.has(line))
            continue;
        result.warnings.push({
            file: file.path,
            line,
            code: "invalid_key",
            message: "key is not a valid environment variable name",
        });
    }
    /* ------------------------------------------------------------ filtering */
    const userIgnore = opts?.ignore ?? [];
    const builtins = new Set();
    for (const item of raw) {
        const line = lineOf(item.keyOffset);
        if (ignoredLines.has(line))
            continue;
        if (matchesAnyIgnorePattern(item.key, userIgnore))
            continue;
        if (isBuiltinIgnored(item.key, item.kind)) {
            builtins.add(item.key);
            continue;
        }
        result.references.push({
            key: item.key,
            file: file.path,
            line,
            col: colOf(item.keyOffset, line),
            kind: item.kind,
            optional: item.optional || optionalLines.has(line),
        });
    }
    result.references.sort(compareReferences);
    result.ignoredBuiltins = [...builtins].sort(compareStrings);
    result.keys = buildKeys(result.references);
    return result;
}
/* ------------------------------------------------------------- utilities */
function isWordAt(text, at, word) {
    if (!text.startsWith(word, at))
        return false;
    return !isIdentChar(text.charCodeAt(at + word.length));
}
/** Offset of a plain `=` immediately before `start`, or -1. */
function assignmentBefore(masked, start) {
    const at = skipWsBack(masked, start - 1);
    if (at < 0 || masked.charCodeAt(at) !== CH_EQ)
        return -1;
    const before = masked.charCodeAt(at - 1);
    if (before === CH_EQ || before === scanner_CH_BANG || before === scanner_CH_LT || before === CH_GT)
        return -1;
    if (masked.charCodeAt(at + 1) === CH_GT)
        return -1;
    return at;
}
function isDeclaratorBefore(masked, openBrace) {
    const at = skipWsBack(masked, openBrace - 1);
    const word = readIdentBack(masked, at);
    return word === "const" || word === "let" || word === "var";
}
/** Offset of the `{` matching the `}` at `closeAt`, or -1. */
function matchingBraceBack(masked, closeAt) {
    let depth = 0;
    for (let i = closeAt; i >= 0; i -= 1) {
        const code = masked.charCodeAt(i);
        if (code === scanner_CH_RBRACE)
            depth += 1;
        else if (code === scanner_CH_LBRACE) {
            depth -= 1;
            if (depth === 0)
                return i;
        }
    }
    return -1;
}
/** `const { A, B } = <here>` — the brace pair assigned to, if any. */
function destructuringBefore(masked, start) {
    const equalsAt = assignmentBefore(masked, start);
    if (equalsAt === -1)
        return undefined;
    const closeAt = skipWsBack(masked, equalsAt - 1);
    if (closeAt < 0 || masked.charCodeAt(closeAt) !== scanner_CH_RBRACE)
        return undefined;
    const openAt = matchingBraceBack(masked, closeAt);
    if (openAt === -1)
        return undefined;
    return { open: openAt, close: closeAt };
}
/** Splits `{ A, B: local, C = "x", ...rest }` into its named bindings. */
function destructuringEntries(masked, from, to) {
    const entries = [];
    let depth = 0;
    let start = from;
    const flush = (end) => {
        const entry = parseDestructuringEntry(masked, start, end);
        if (entry !== undefined)
            entries.push(entry);
    };
    for (let i = from; i < to; i += 1) {
        const code = masked.charCodeAt(i);
        if (code === scanner_CH_LBRACE || code === scanner_CH_LBRACKET || code === CH_LPAREN)
            depth += 1;
        else if (code === scanner_CH_RBRACE || code === scanner_CH_RBRACKET || code === scanner_CH_RPAREN)
            depth -= 1;
        else if (code === CH_COMMA && depth === 0) {
            flush(i);
            start = i + 1;
        }
    }
    flush(to);
    return entries;
}
function parseDestructuringEntry(masked, from, to) {
    const start = skipWs(masked, from);
    if (start >= to)
        return undefined;
    if (masked.charCodeAt(start) === CH_DOT)
        return undefined;
    const key = readIdent(masked, start);
    if (key === "")
        return undefined;
    let local;
    let optional = false;
    let depth = 0;
    for (let i = start + key.length; i < to; i += 1) {
        const code = masked.charCodeAt(i);
        if (code === scanner_CH_LBRACE || code === scanner_CH_LBRACKET || code === CH_LPAREN)
            depth += 1;
        else if (code === scanner_CH_RBRACE || code === scanner_CH_RBRACKET || code === scanner_CH_RPAREN)
            depth -= 1;
        else if (depth === 0 && code === CH_COLON) {
            local = readIdent(masked, skipWs(masked, i + 1));
        }
        else if (depth === 0 &&
            code === CH_EQ &&
            masked.charCodeAt(i + 1) !== CH_EQ &&
            masked.charCodeAt(i - 1) !== CH_EQ) {
            optional = true;
        }
    }
    return local === undefined || local === ""
        ? { key, offset: start, optional }
        : { key, offset: start, local, optional };
}
/** `"KEY" in process.env` — the probed key, when the site has that shape. */
function inProbeBefore(masked, source, start) {
    const wordEnd = skipWsBack(masked, start - 1);
    if (readIdentBack(masked, wordEnd) !== "in")
        return undefined;
    const quoteEnd = skipWsBack(masked, wordEnd - 2);
    const quote = source.charCodeAt(quoteEnd);
    if (quote !== scanner_CH_DQUOTE && quote !== scanner_CH_SQUOTE && quote !== scanner_CH_BACKTICK)
        return undefined;
    let open = quoteEnd - 1;
    while (open >= 0 && source.charCodeAt(open) !== quote)
        open -= 1;
    if (open < 0)
        return undefined;
    return { key: source.slice(open + 1, quoteEnd), keyOffset: open + 1 };
}
/**
 * `env["KEY"]` — the static key, or `undefined` when the subscript is dynamic.
 * `at` is the offset of the `[`.
 */
function readBracketKey(source, masked, at) {
    const open = skipWs(masked, at + 1);
    const quote = source.charCodeAt(open);
    if (quote !== scanner_CH_DQUOTE && quote !== scanner_CH_SQUOTE && quote !== scanner_CH_BACKTICK)
        return undefined;
    let i = open + 1;
    while (i < source.length) {
        const code = source.charCodeAt(i);
        if (code === scanner_CH_BACKSLASH) {
            i += 2;
            continue;
        }
        if (code === scanner_CH_LF || code === scanner_CH_CR)
            return undefined;
        if (code === quote)
            break;
        i += 1;
    }
    if (i >= source.length)
        return undefined;
    const key = source.slice(open + 1, i);
    if (quote === scanner_CH_BACKTICK && key.includes("${"))
        return undefined;
    const close = skipWs(masked, i + 1);
    if (masked.charCodeAt(close) !== scanner_CH_RBRACKET)
        return undefined;
    return { key, keyOffset: open + 1, end: close + 1 };
}
/* --------------------------------------------------------- optionality */
/** SPEC "Optional detection": looks at the tokens around the reference site. */
function isOptionalSite(masked, source, exprStart, end) {
    const beforeEnd = skipWsBack(masked, exprStart - 1);
    if (readIdentBack(masked, beforeEnd) === "typeof")
        return true;
    let cursor = skipWs(masked, end);
    while (masked.charCodeAt(cursor) === scanner_CH_BANG && masked.charCodeAt(cursor + 1) !== CH_EQ) {
        cursor = skipWs(masked, cursor + 1);
    }
    const code = masked.charCodeAt(cursor);
    const next = masked.charCodeAt(cursor + 1);
    if (code === CH_QUESTION && next === CH_QUESTION) {
        return isOptionalFallback(source, skipWs(masked, cursor + 2));
    }
    if (code === CH_PIPE && next === CH_PIPE) {
        return isOptionalFallback(source, skipWs(masked, cursor + 2));
    }
    if (code === CH_AMP && next === CH_AMP)
        return true;
    if (code === CH_QUESTION && next !== CH_DOT && next !== CH_QUESTION)
        return true;
    if ((code === CH_EQ || code === scanner_CH_BANG) && next === CH_EQ) {
        let after = cursor + 2;
        if (masked.charCodeAt(after) === CH_EQ)
            after += 1;
        // Comparing against a literal is a presence test: the code has a branch for
        // the variable being absent. Comparing against another expression is not.
        return isLiteralComparand(source, skipWs(source, after));
    }
    if (code === scanner_CH_RPAREN && isSoleIfCondition(masked, exprStart))
        return true;
    // `!x`, `!!x` and `Boolean(x)` coerce the value to a yes/no and never read it,
    // so the code already copes with the variable being absent. A member access on
    // the site (`!x.length`) does read it, and stays required.
    if (code !== CH_DOT && code !== scanner_CH_LBRACKET) {
        if (masked.charCodeAt(beforeEnd) === scanner_CH_BANG)
            return true;
        if (isBooleanCall(masked, beforeEnd))
            return true;
    }
    return false;
}
/** The words that are literals rather than references to something else. */
const LITERAL_WORDS = new Set(["undefined", "null", "true", "false", "NaN", "Infinity"]);
/**
 * True when the token at `at` is a literal: a quoted string, a number, or one of
 * the literal keywords. Read from the raw source, because `masked` blanks out
 * the contents — and the quotes — of every string.
 */
function isLiteralComparand(source, at) {
    const code = source.charCodeAt(at);
    if (code === scanner_CH_DQUOTE || code === scanner_CH_SQUOTE || code === scanner_CH_BACKTICK)
        return true;
    if (isDigit(code))
        return true;
    if ((code === CH_MINUS || code === CH_PLUS || code === CH_DOT) && isDigit(source.charCodeAt(at + 1))) {
        return true;
    }
    return LITERAL_WORDS.has(readIdent(source, at));
}
function isDigit(code) {
    return code >= 48 && code <= 57;
}
/** True when the character at `beforeEnd` opens a `Boolean(` call. */
function isBooleanCall(masked, beforeEnd) {
    if (masked.charCodeAt(beforeEnd) !== CH_LPAREN)
        return false;
    return readIdentBack(masked, skipWsBack(masked, beforeEnd - 1)) === "Boolean";
}
/**
 * The right-hand side of `??` / `||`. A bare `throw` expression or `undefined`
 * keeps the site required; anything else is a real fallback.
 */
function isOptionalFallback(source, at) {
    const word = readIdent(source, at);
    if (word === "throw" || word === "undefined")
        return false;
    return true;
}
/** True when the site is the whole condition of an `if (...)`. */
function isSoleIfCondition(masked, exprStart) {
    const parenAt = skipWsBack(masked, exprStart - 1);
    if (parenAt < 0 || masked.charCodeAt(parenAt) !== CH_LPAREN)
        return false;
    return readIdentBack(masked, skipWsBack(masked, parenAt - 1)) === "if";
}

;// CONCATENATED MODULE: ./src/scanner/files.ts
/**
 * SPEC: docs/SPEC.md — Module A `scanner`, "File selection (`scanDirectory`)".
 *
 * Resolution baked into this API: directory walking is async (`Promise`), and
 * all filesystem access goes through an injectable `FileSystemAdapter` so the
 * runner and the tests can substitute a root without touching the real disk.
 */




const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
/** Extensions scanned as JavaScript. `.vue`/`.svelte`/`.astro` are scanned whole. */
const DEFAULT_INCLUDE_EXTENSIONS = [
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
    ".vue",
    ".svelte",
    ".astro",
];
const ALWAYS_IGNORED_DIRECTORIES = [
    "node_modules",
    ".git",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".vercel",
    ".turbo",
    ".cache",
    "dist",
    "build",
    "out",
    "coverage",
    "storybook-static",
];
/** Substrings/suffixes that mark a file as a test artifact (opt in via `includeTests`). */
const TEST_FILE_MARKERS = [
    ".test.",
    ".spec.",
    "__tests__",
    "__mocks__",
    ".stories.",
];
/** Suffixes never scanned, regardless of options. */
const ALWAYS_IGNORED_SUFFIXES = [".d.ts", ".min.js", ".map"];
/**
 * Directories holding tooling that runs on a laptop or in CI but never inside a
 * Vercel deployment. A variable only these read is not a deployment requirement.
 * Skipped by default; a user `include` glob pulls any of them back in.
 */
const NON_DEPLOYED_DIRECTORIES = [
    "scripts",
    "script",
    "e2e",
    "cypress",
    "playwright",
    "test",
    "tests",
    ".storybook",
    ".github",
];
/**
 * Root config files for the same tooling. Matched by basename prefix, so
 * `vitest.config.ts` and `vitest.config.mjs` both hit. Deliberately absent:
 * `next.config.*`, `vite.config.*`, `astro.config.*`, `svelte.config.*` and
 * `nuxt.config.*`, which Vercel evaluates at build time — the variables they
 * read are real deployment requirements.
 */
const NON_DEPLOYED_CONFIG_PREFIXES = [
    "playwright.config.",
    "cypress.config.",
    "vitest.config.",
    "jest.config.",
    "eslint.config.",
    "prettier.config.",
    ".eslintrc.",
    "commitlint.config.",
];
/** The real Node filesystem adapter used by `main.ts`. */
const nodeFileSystem = {
    async readdir(target) {
        const entries = await external_node_fs_namespaceObject.promises.readdir(target, { withFileTypes: true });
        return entries.map((entry) => ({
            name: entry.name,
            isDirectory: entry.isDirectory(),
            isFile: entry.isFile(),
            isSymbolicLink: entry.isSymbolicLink(),
        }));
    },
    async stat(target) {
        const stats = await external_node_fs_namespaceObject.promises.stat(target);
        return { size: stats.size, isDirectory: stats.isDirectory(), isFile: stats.isFile() };
    },
    realpath(target) {
        return external_node_fs_namespaceObject.promises.realpath(target);
    },
    readFile(target) {
        return external_node_fs_namespaceObject.promises.readFile(target);
    },
    async exists(target) {
        try {
            await external_node_fs_namespaceObject.promises.stat(target);
            return true;
        }
        catch {
            return false;
        }
    },
};
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
function files_compareStrings(a, b) {
    if (a < b)
        return -1;
    if (a > b)
        return 1;
    return 0;
}
function isInside(root, candidate) {
    if (candidate === root)
        return true;
    const prefix = root.endsWith((external_node_path_default()).sep) ? root : `${root}${(external_node_path_default()).sep}`;
    return candidate.startsWith(prefix);
}
function toGitignoreRule(raw) {
    const directoryOnly = raw.endsWith("/");
    let pattern = directoryOnly ? raw.slice(0, -1) : raw;
    const anchored = pattern.includes("/") || pattern.startsWith("/");
    if (pattern.startsWith("/"))
        pattern = pattern.slice(1);
    return { pattern, directoryOnly, anchored };
}
function isGitignored(relativePath, isDirectory, rules) {
    for (const rule of rules) {
        if (rule.directoryOnly && !isDirectory)
            continue;
        if (rule.anchored) {
            if (matchesGlob(relativePath, rule.pattern))
                return true;
            if (relativePath.startsWith(`${rule.pattern}/`))
                return true;
            continue;
        }
        if (relativePath.split("/").some((segment) => matchesGlob(segment, rule.pattern))) {
            return true;
        }
    }
    return false;
}
function isTestPath(relativePath) {
    return TEST_FILE_MARKERS.some((marker) => relativePath.includes(marker));
}
/** True when the path sits in tooling that never runs inside a deployment. */
function isNonDeployedPath(relativePath, name) {
    const segments = relativePath.split("/");
    // The basename is checked separately below, so only directories count here.
    for (let i = 0; i < segments.length - 1; i += 1) {
        if (NON_DEPLOYED_DIRECTORIES.includes(segments[i] ?? ""))
            return true;
    }
    // Config files are matched at the repository root only: a `vitest.config.ts`
    // nested in `src/` is more likely to be application code than tool config.
    if (segments.length > 1)
        return false;
    return NON_DEPLOYED_CONFIG_PREFIXES.some((prefix) => name.startsWith(prefix));
}
/**
 * File-level selection. Hard rules (always-ignored suffixes, a real `.env`,
 * `.gitignore`) come first, then the user's `exclude`, then the user's
 * `include` — which can pull in a file the default rules would have skipped —
 * then the defaults.
 */
function isSelected(relativePath, name, opts, rules) {
    if (ALWAYS_IGNORED_SUFFIXES.some((suffix) => name.endsWith(suffix)))
        return false;
    const isExample = isEnvExampleFile(relativePath);
    // I1: a real `.env` is never opened, whatever the user's globs say.
    if (name.startsWith(".env") && !isExample)
        return false;
    if (isGitignored(relativePath, false, rules))
        return false;
    if (opts.exclude?.some((pattern) => matchesGlob(relativePath, pattern)))
        return false;
    if (opts.include?.some((pattern) => matchesGlob(relativePath, pattern)))
        return true;
    if (isExample)
        return true;
    const extension = external_node_path_default().extname(name);
    if (!DEFAULT_INCLUDE_EXTENSIONS.includes(extension))
        return false;
    if (opts.includeTests !== true && isTestPath(relativePath))
        return false;
    if (isNonDeployedPath(relativePath, name))
        return false;
    return true;
}
/** Walks `root`, applying the ignore rules, gitignore, and user globs. */
async function collectFiles(root, opts = {}) {
    const fs = opts.fs ?? nodeFileSystem;
    const files = [];
    const warnings = [];
    let rootReal = root;
    try {
        rootReal = await fs.realpath(root);
    }
    catch (error) {
        warnings.push({
            file: ".",
            line: 1,
            code: "unreadable_file",
            message: `Could not resolve the scan root: ${describeError(error)}`,
        });
    }
    const rules = await loadGitignore(root, fs, opts, warnings);
    const visited = new Set();
    const walk = async (absolute, real, relativeDir) => {
        if (visited.has(real))
            return;
        visited.add(real);
        let entries;
        try {
            entries = await fs.readdir(absolute);
        }
        catch (error) {
            warnings.push({
                file: relativeDir === "" ? "." : relativeDir,
                line: 1,
                code: "unreadable_file",
                message: `Could not read a directory: ${describeError(error)}`,
            });
            return;
        }
        for (const entry of [...entries].sort((a, b) => files_compareStrings(a.name, b.name))) {
            const childAbsolute = external_node_path_default().join(absolute, entry.name);
            const childRelative = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
            let isDirectory = entry.isDirectory;
            let isFile = entry.isFile;
            let childReal = external_node_path_default().join(real, entry.name);
            if (entry.isSymbolicLink) {
                let resolved;
                try {
                    resolved = await fs.realpath(childAbsolute);
                }
                catch {
                    // A broken link is not an error worth failing the run over.
                    continue;
                }
                // Never leave the scan root through a link.
                if (!isInside(rootReal, resolved))
                    continue;
                try {
                    const stats = await fs.stat(childAbsolute);
                    isDirectory = stats.isDirectory;
                    isFile = stats.isFile;
                }
                catch {
                    continue;
                }
                childReal = resolved;
            }
            if (isDirectory) {
                if (ALWAYS_IGNORED_DIRECTORIES.includes(entry.name))
                    continue;
                if (isGitignored(childRelative, true, rules))
                    continue;
                await walk(childAbsolute, childReal, childRelative);
                continue;
            }
            if (!isFile)
                continue;
            if (!isSelected(childRelative, entry.name, opts, rules))
                continue;
            files.push({
                path: childAbsolute,
                relativePath: childRelative,
                kind: isEnvExampleFile(childRelative) ? "env-example" : "code",
            });
        }
    };
    await walk(root, rootReal, "");
    files.sort((a, b) => files_compareStrings(a.relativePath, b.relativePath));
    return { files, warnings };
}
/** Reads the root `.gitignore`, if any. Nested `.gitignore` files are not read. */
async function loadGitignore(root, fs, opts, warnings) {
    if (opts.respectGitignore === false)
        return [];
    const file = external_node_path_default().join(root, ".gitignore");
    let present = false;
    try {
        present = await fs.exists(file);
    }
    catch {
        present = false;
    }
    if (!present)
        return [];
    let content;
    try {
        content = (await fs.readFile(file)).toString("utf8");
    }
    catch (error) {
        warnings.push({
            file: ".gitignore",
            line: 1,
            code: "unreadable_file",
            message: `Could not read .gitignore: ${describeError(error)}`,
        });
        return [];
    }
    const parsed = parseGitignore(content);
    const lines = content.split(/\r\n|\n|\r/);
    for (const pattern of parsed.unsupported) {
        const index = lines.findIndex((line) => line.trim() === pattern);
        warnings.push({
            file: ".gitignore",
            line: index === -1 ? 1 : index + 1,
            code: "gitignore_unsupported_pattern",
            message: `Unsupported .gitignore pattern skipped: ${pattern}`,
        });
    }
    return parsed.patterns.map(toGitignoreRule);
}
/** Reads the collected files. Binary and oversized files are skipped with a warning. */
async function readSourceFiles(files, opts = {}) {
    const fs = opts.fs ?? nodeFileSystem;
    const limit = opts.maxFileSizeBytes ?? MAX_FILE_SIZE_BYTES;
    const sources = [];
    const warnings = [];
    for (const file of files) {
        let size = null;
        try {
            size = (await fs.stat(file.path)).size;
        }
        catch (error) {
            warnings.push({
                file: file.relativePath,
                line: 1,
                code: "unreadable_file",
                message: `Could not stat the file: ${describeError(error)}`,
            });
            continue;
        }
        if (size > limit) {
            warnings.push({
                file: file.relativePath,
                line: 1,
                code: "file_too_large",
                message: `Skipped a file of ${size} bytes; the limit is ${limit} bytes.`,
            });
            continue;
        }
        let bytes;
        try {
            bytes = await fs.readFile(file.path);
        }
        catch (error) {
            warnings.push({
                file: file.relativePath,
                line: 1,
                code: "unreadable_file",
                message: `Could not read the file: ${describeError(error)}`,
            });
            continue;
        }
        if (looksBinary(bytes)) {
            warnings.push({
                file: file.relativePath,
                line: 1,
                code: "binary_file",
                message: "Skipped a file that looks binary.",
            });
            continue;
        }
        sources.push({ path: file.relativePath, content: bytes.toString("utf8") });
    }
    return { sources, warnings };
}
/** `collectFiles` + `readSourceFiles` + `scanFiles`. */
async function scanDirectory(root, opts = {}) {
    const collected = await collectFiles(root, opts);
    const code = collected.files.filter((file) => file.kind === "code");
    const read = await readSourceFiles(code, opts);
    const scanned = scanFiles(read.sources, opts);
    return {
        ...scanned,
        warnings: [...collected.warnings, ...read.warnings, ...scanned.warnings],
    };
}
/** Parses a `.gitignore` into the simple patterns this tool supports. */
function parseGitignore(content) {
    const patterns = [];
    const unsupported = [];
    for (const raw of content.split(/\r\n|\n|\r/)) {
        const line = raw.trim();
        if (line === "" || line.startsWith("#"))
            continue;
        // Negation and `**` are deliberately not approximated — see the SPEC note.
        if (line.startsWith("!") || line.includes("**")) {
            unsupported.push(line);
            continue;
        }
        patterns.push(line);
    }
    return { patterns, unsupported };
}
const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;
function files_escapeRegExp(text) {
    return text.replace(REGEXP_SPECIALS, "\\$&");
}
const globCache = new Map();
function globToRegExp(pattern) {
    const cached = globCache.get(pattern);
    if (cached)
        return cached;
    let source = "";
    for (let i = 0; i < pattern.length; i += 1) {
        const char = pattern[i] ?? "";
        if (char === "*") {
            if (pattern[i + 1] === "*") {
                const atSegmentStart = i === 0 || pattern[i - 1] === "/";
                if (atSegmentStart && pattern[i + 2] === "/") {
                    // `**/` also matches zero directories.
                    source += "(?:.*/)?";
                    i += 2;
                    continue;
                }
                source += ".*";
                i += 1;
                continue;
            }
            source += "[^/]*";
            continue;
        }
        if (char === "?") {
            source += "[^/]";
            continue;
        }
        if (char === "{") {
            const end = pattern.indexOf("}", i);
            if (end > i) {
                const alternatives = pattern.slice(i + 1, end).split(",");
                source += `(?:${alternatives.map((alt) => files_escapeRegExp(alt)).join("|")})`;
                i = end;
                continue;
            }
        }
        source += files_escapeRegExp(char);
    }
    const compiled = new RegExp(`^${source}$`);
    globCache.set(pattern, compiled);
    return compiled;
}
/** Minimal glob matcher: `*`, `**`, `?`, `{a,b}`, POSIX separators. */
function matchesGlob(relativePath, pattern) {
    return globToRegExp(pattern).test(relativePath);
}
const BINARY_SNIFF_BYTES = 8 * 1024;
/** True when the bytes look binary (a NUL in the first 8KB). */
function looksBinary(bytes) {
    const end = Math.min(bytes.length, BINARY_SNIFF_BYTES);
    for (let i = 0; i < end; i += 1) {
        if (bytes[i] === 0)
            return true;
    }
    return false;
}

;// CONCATENATED MODULE: ./src/vercel/client.ts
/**
 * SPEC: docs/SPEC.md — Module B `vercel` client, and invariants I1 (never see a
 * value) and I4 (read-only: GET requests only, `decrypt` never sent).
 */

const TARGETS = ["production", "preview", "development"];
/** `.message` is templated from the status and our own hint — never from the body. */
class VercelError extends Error {
    code;
    status;
    constructor(code, message, status = null) {
        super(message);
        this.name = "VercelError";
        this.code = code;
        this.status = status;
    }
}
/** Per-request timeout (ms). */
const REQUEST_TIMEOUT_MS = 15_000;
/** Pagination loop guard. */
const MAX_PAGES = 50;
/** Retries for 429. */
const MAX_RATE_LIMIT_RETRIES = 3;
/** Retries for 5xx. */
const MAX_SERVER_ERROR_RETRIES = 1;
/** Backoff used when `Retry-After` is absent. */
const BACKOFF_MS = [1000, 2000, 4000];
const DEFAULT_BASE_URL = "https://api.vercel.com";
const REDACTED = "[redacted]";
/*
 * Every message below is built from the HTTP status and our own hint. No part
 * of a response body ever reaches an error surface (I1).
 */
const MESSAGES = {
    unauthorized: "Vercel rejected the credentials (HTTP 401). Check that the token is set and has not been revoked.",
    forbidden: "Vercel refused the request (HTTP 403). Check the token scope and whether a team id is required.",
    projectNotFound: "Vercel has no such project (HTTP 404). Check the project id or name, and the team it belongs to.",
    rateLimited: (retries) => `Vercel rate-limited the request (HTTP 429) and it did not recover after ${retries} retries.`,
    serverError: (status) => `Vercel returned a server error (HTTP ${status}). This is usually transient — try again.`,
    network: "Could not reach the Vercel API (network error, or the request timed out).",
    badJson: "The Vercel API returned a body that is not valid JSON.",
    badShape: (status) => `The Vercel API returned an unexpected response (HTTP ${status}).`,
    badRow: "The Vercel API returned an environment variable row in an unexpected shape.",
};
/* ------------------------------------------------------------------ helpers */
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Belt and braces: a token must never survive into a string we hand out. */
function redact(text, token) {
    if (token.length === 0 || !text.includes(token))
        return text;
    return text.split(token).join(REDACTED);
}
function isTarget(value) {
    return typeof value === "string" && TARGETS.includes(value);
}
function normalizeTargets(raw) {
    const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
    const out = [];
    for (const entry of list)
        if (isTarget(entry))
            out.push(entry);
    return out;
}
function normalizeStrings(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const entry of raw)
        if (typeof entry === "string")
            out.push(entry);
    return out;
}
/** Seconds-only `Retry-After`; an HTTP-date falls back to the backoff ladder. */
function retryAfterMs(response) {
    const header = response.headers.get("retry-after");
    if (header === null)
        return null;
    const trimmed = header.trim();
    if (!/^\d+$/.test(trimmed))
        return null;
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds))
        return null;
    return seconds * 1000;
}
function backoffFor(attempt) {
    return BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 1000;
}
function paginationNext(body) {
    const pagination = body["pagination"];
    if (!isRecord(pagination))
        return null;
    const next = pagination["next"];
    if (typeof next !== "number" || !Number.isFinite(next))
        return null;
    return next;
}
/**
 * Pure boundary mapper. Picks exactly `key`, `targets`, `gitBranch`, `type`,
 * `customEnvironmentIds`; normalizes a `target` string to an array; drops
 * `value` and every other field. Keeps no reference to `raw`.
 */
function toEnvVar(raw) {
    if (!isRecord(raw))
        throw new VercelError("bad_response", MESSAGES.badRow);
    const key = raw["key"];
    if (typeof key !== "string")
        throw new VercelError("bad_response", MESSAGES.badRow);
    const gitBranch = raw["gitBranch"];
    const type = raw["type"];
    return {
        key,
        targets: normalizeTargets(raw["target"]),
        gitBranch: typeof gitBranch === "string" && gitBranch.length > 0 ? gitBranch : null,
        type: typeof type === "string" ? type : "",
        customEnvironmentIds: normalizeStrings(raw["customEnvironmentIds"]),
    };
}
/* ------------------------------------------------------------------- client */
function createVercelClient(options) {
    const token = options.token;
    const teamId = options.teamId;
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const userAgent = options.userAgent ?? USER_AGENT;
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const doSleep = options.sleep ??
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const fail = (code, message, status = null) => {
        throw new VercelError(code, redact(message, token), status);
    };
    const buildUrl = (path, params) => {
        const url = new URL(`${baseUrl}${path}`);
        if (teamId !== undefined && teamId !== "")
            url.searchParams.set("teamId", teamId);
        for (const [name, value] of Object.entries(params)) {
            if (value !== undefined)
                url.searchParams.set(name, value);
        }
        return url.toString();
    };
    /** One GET, with the 15s abort guard. Any transport failure is `network`. */
    const getOnce = async (url) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await doFetch(url, {
                method: "GET",
                headers: {
                    authorization: `Bearer ${token}`,
                    "user-agent": userAgent,
                    accept: "application/json",
                },
                signal: controller.signal,
            });
        }
        catch {
            // The cause is deliberately dropped: it may quote the URL or the token.
            return fail("network", MESSAGES.network);
        }
        finally {
            clearTimeout(timer);
        }
    };
    const parseJson = async (response) => {
        let text;
        try {
            text = await response.text();
        }
        catch {
            return fail("network", MESSAGES.network);
        }
        try {
            return JSON.parse(text);
        }
        catch {
            return fail("bad_response", MESSAGES.badJson, response.status);
        }
    };
    /** GET + retry ladder + JSON parse. The body never reaches an error message. */
    const getJson = async (url) => {
        let rateLimitRetries = 0;
        let serverErrorRetries = 0;
        for (;;) {
            const response = await getOnce(url);
            const status = response.status;
            if (response.ok)
                return await parseJson(response);
            if (status === 401)
                fail("unauthorized", MESSAGES.unauthorized, status);
            if (status === 403)
                fail("forbidden", MESSAGES.forbidden, status);
            if (status === 404)
                fail("project_not_found", MESSAGES.projectNotFound, status);
            if (status === 429) {
                if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
                    fail("rate_limited", MESSAGES.rateLimited(MAX_RATE_LIMIT_RETRIES), status);
                }
                const waitMs = retryAfterMs(response) ?? backoffFor(rateLimitRetries);
                rateLimitRetries += 1;
                await doSleep(waitMs);
                continue;
            }
            if (status >= 500) {
                if (serverErrorRetries >= MAX_SERVER_ERROR_RETRIES) {
                    fail("server_error", MESSAGES.serverError(status), status);
                }
                // Back off before the retry: an immediate second request only adds load
                // to an API that is already failing.
                await doSleep(backoffFor(serverErrorRetries));
                serverErrorRetries += 1;
                continue;
            }
            fail("bad_response", MESSAGES.badShape(status), status);
        }
    };
    const listEnv = async (projectIdOrName, opts = {}) => {
        const path = `/v10/projects/${encodeURIComponent(projectIdOrName)}/env`;
        const out = [];
        const seenIds = new Set();
        let until;
        for (let page = 0; page < MAX_PAGES; page += 1) {
            const body = await getJson(buildUrl(path, {
                gitBranch: opts.gitBranch,
                customEnvironmentId: opts.customEnvironmentId,
                until,
            }));
            if (!isRecord(body))
                fail("bad_response", MESSAGES.badShape(200));
            const record = body;
            const rows = record["envs"];
            if (!Array.isArray(rows))
                fail("bad_response", MESSAGES.badShape(200));
            for (const raw of rows) {
                const id = isRecord(raw) && typeof raw["id"] === "string" ? raw["id"] : null;
                if (id !== null) {
                    if (seenIds.has(id))
                        continue;
                    seenIds.add(id);
                }
                out.push(toEnvVar(raw));
            }
            const next = paginationNext(record);
            if (next === null)
                break;
            until = String(next);
        }
        return out;
    };
    const toProjectRef = (candidate) => {
        if (!isRecord(candidate))
            return null;
        const id = candidate["id"];
        const name = candidate["name"];
        if (typeof id !== "string" || typeof name !== "string")
            return null;
        return { id, name };
    };
    const projectList = (body) => {
        if (Array.isArray(body))
            return body;
        if (isRecord(body) && Array.isArray(body["projects"]))
            return body["projects"];
        return fail("bad_response", MESSAGES.badShape(200));
    };
    const linksTo = (candidate, org, repo) => {
        if (!isRecord(candidate))
            return false;
        const link = candidate["link"];
        if (!isRecord(link))
            return false;
        const linkOrg = link["org"];
        const linkRepo = link["repo"];
        if (typeof linkOrg !== "string" || typeof linkRepo !== "string")
            return false;
        return linkOrg.toLowerCase() === org.toLowerCase() && linkRepo.toLowerCase() === repo.toLowerCase();
    };
    const findByRepo = async (repoSlug) => {
        const slash = repoSlug.indexOf("/");
        const org = slash === -1 ? "" : repoSlug.slice(0, slash);
        const repo = slash === -1 ? repoSlug : repoSlug.slice(slash + 1);
        const byLink = projectList(await getJson(buildUrl("/v10/projects", { repoUrl: `https://github.com/${org}/${repo}` }))).filter((candidate) => linksTo(candidate, org, repo));
        if (byLink.length === 1) {
            const ref = toProjectRef(byLink[0]);
            if (ref !== null)
                return ref;
        }
        if (byLink.length > 1) {
            const candidates = byLink
                .map((candidate) => toProjectRef(candidate))
                .filter((ref) => ref !== null)
                .map((ref) => ref.name)
                .sort();
            return { error: "ambiguous", candidates };
        }
        // Fallback: a project may carry the repo name without a git link.
        const bySearch = projectList(await getJson(buildUrl("/v10/projects", { search: repo })));
        for (const candidate of bySearch) {
            const ref = toProjectRef(candidate);
            if (ref !== null && ref.name.toLowerCase() === repo.toLowerCase())
                return ref;
        }
        return null;
    };
    const findByIdOrName = async (idOrName) => {
        try {
            const body = await getJson(buildUrl(`/v10/projects/${encodeURIComponent(idOrName)}`, {}));
            return toProjectRef(body);
        }
        catch (error) {
            // "Which project?" has "none" as a valid answer; only listEnv errors on 404.
            if (error instanceof VercelError && error.code === "project_not_found")
                return null;
            throw error;
        }
    };
    const findProject = async (query) => "repo" in query ? await findByRepo(query.repo) : await findByIdOrName(query.idOrName);
    return { listEnv, findProject };
}

;// CONCATENATED MODULE: ./src/run.ts
/**
 * SPEC: docs/SPEC.md — Module E `run` / Action entry, plus invariants I2 (fail
 * closed) and I4 (the PR comment is the only write).
 *
 * Every dependency is injected: `fetch`, the filesystem, the environment map,
 * the GitHub client, and the writers for the step summary, annotations and
 * outputs. `main.ts` is the only place that builds real ones.
 */











const INPUT_NAMES = (/* unused pure expression or super */ null && ([
    "vercel_token",
    "target",
    "project",
    "team_id",
    "branch",
    "path",
    "include",
    "exclude",
    "ignore",
    "optional",
    "required",
    "fail_on",
    "on_error",
    "comment",
    "github_token",
    "license_key",
    "report_url",
    "include_tests",
]));
const _inputNamesAreExhaustive = true;
void _inputNamesAreExhaustive;
const OUTPUT_NAMES = [
    "status",
    "missing",
    "missing_count",
    "report_json",
    "summary",
];
/** Where a licensed report is posted when the input is left empty. */
const DEFAULT_REPORT_URL = "https://envcontract.vercel.app/api/report";
/** The single file this tool writes. */
const REPORT_FILE_NAME = "envcontract-report.json";
/** `<n>/merge` — the ref name GitHub invents for a PR merge commit. Not a branch. */
const MERGE_REF = /^\d+\/merge$/;
/** The report upload gets the same 15s ceiling as a Vercel request. */
const UPLOAD_TIMEOUT_MS = 15_000;
const TRUE_WORDS = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "n", "off"]);
/* ----------------------------------------------------------------- parsing */
/** Splits a newline- or comma-separated action input into trimmed, non-empty entries. */
function parseList(raw) {
    return raw
        .split(/[,\r\n]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}
/** `true`/`false`/`1`/`0`/`yes`/`no`, case-insensitive; anything else is `fallback`. */
function parseBoolean(raw, fallback) {
    const word = raw.trim().toLowerCase();
    if (TRUE_WORDS.has(word))
        return true;
    if (FALSE_WORDS.has(word))
        return false;
    return fallback;
}
function parseFailOn(raw) {
    const word = raw.trim().toLowerCase();
    if (word === "missing" || word === "elsewhere" || word === "never")
        return word;
    return "elsewhere";
}
function run_isTarget(value) {
    return TARGETS.includes(value);
}
/**
 * `auto` → production on a push to the default branch, preview otherwise.
 * Returns null for a target string that is not one of the four documented words.
 */
function resolveTargetOrNull(inputs, deps) {
    const word = inputs.target.trim().toLowerCase();
    if (word === "")
        return "preview";
    if (word === "auto") {
        const ref = (deps.env["GITHUB_REF_NAME"] ?? "").trim();
        const onDefaultBranch = ref !== "" && ref === deps.github.defaultBranch;
        return deps.github.eventName === "push" && onDefaultBranch ? "production" : "preview";
    }
    return run_isTarget(word) ? word : null;
}
/** `auto` → production on a push to the default branch, preview otherwise. */
function resolveTarget(inputs, deps) {
    const target = resolveTargetOrNull(inputs, deps);
    if (target === null)
        throw new Error(unknownTargetMessage(inputs.target));
    return target;
}
function unknownTargetMessage(raw) {
    return `Unknown target "${raw.trim()}". Use production, preview, development, or auto.`;
}
/**
 * `branch` input → `GITHUB_HEAD_REF` → `GITHUB_REF_NAME`. A `<n>/merge` ref name
 * is an unknown branch → null.
 */
function resolveBranch(inputs, deps) {
    const fromInput = inputs.branch.trim();
    if (fromInput !== "")
        return fromInput;
    const headRef = (deps.env["GITHUB_HEAD_REF"] ?? "").trim();
    if (headRef !== "")
        return headRef;
    const refName = (deps.env["GITHUB_REF_NAME"] ?? "").trim();
    if (refName === "" || MERGE_REF.test(refName))
        return null;
    return refName;
}
/* -------------------------------------------------------------- resolution */
/** Reads `.vercel/project.json` if present; never throws. */
async function readVercelProjectJson(deps) {
    const file = external_node_path_default().join(deps.cwd, ".vercel", "project.json");
    let raw;
    try {
        raw = (await deps.fs.readFile(file)).toString("utf8");
    }
    catch {
        // Absent or unreadable is the normal case outside a `vercel link`ed repo.
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        deps.logger.debug(`Ignoring ${file}: it is not valid JSON.`);
        return null;
    }
    if (typeof parsed !== "object" || parsed === null)
        return null;
    const record = parsed;
    const out = {};
    if (typeof record["projectId"] === "string")
        out.projectId = record["projectId"];
    if (typeof record["orgId"] === "string")
        out.orgId = record["orgId"];
    return out;
}
/**
 * Precedence baked in here (refines the SPEC prose): `project` input →
 * `VERCEL_PROJECT_ID` env → `.vercel/project.json` → the Vercel repo link.
 */
async function resolveProject(inputs, deps, client) {
    const fromInput = inputs.project.trim();
    if (fromInput !== "")
        return { idOrName: fromInput, source: "input" };
    const fromEnv = (deps.env["VERCEL_PROJECT_ID"] ?? "").trim();
    if (fromEnv !== "")
        return { idOrName: fromEnv, source: "env" };
    const linked = await readVercelProjectJson(deps);
    const fromJson = (linked?.projectId ?? "").trim();
    if (fromJson !== "")
        return { idOrName: fromJson, source: "project_json" };
    const { owner, repo } = deps.github.repo;
    if (owner !== "" && repo !== "") {
        const found = await client.findProject({ repo: `${owner}/${repo}` });
        if (found !== null && "error" in found) {
            return { idOrName: null, source: "none", candidates: found.candidates };
        }
        if (found !== null)
            return { idOrName: found.id, source: "repo_link" };
    }
    return { idOrName: null, source: "none" };
}
/** `team_id` input → `VERCEL_ORG_ID` → `VERCEL_TEAM_ID` → `.vercel/project.json` orgId. */
async function resolveTeamId(inputs, deps) {
    const fromInput = inputs.team_id.trim();
    if (fromInput !== "")
        return fromInput;
    const fromOrgId = (deps.env["VERCEL_ORG_ID"] ?? "").trim();
    if (fromOrgId !== "")
        return fromOrgId;
    const fromTeamId = (deps.env["VERCEL_TEAM_ID"] ?? "").trim();
    if (fromTeamId !== "")
        return fromTeamId;
    const linked = await readVercelProjectJson(deps);
    const fromJson = (linked?.orgId ?? "").trim();
    if (fromJson !== "")
        return fromJson;
    return null;
}
/* ------------------------------------------------------------------ writes */
/** Finds the marker comment and updates it, or creates one. Failures are warnings. */
async function upsertStickyComment(body, deps) {
    const prNumber = deps.github.prNumber;
    if (prNumber === null)
        return null;
    const marker = firstLine(body);
    let existing;
    try {
        const comments = await deps.github.listComments(prNumber);
        existing = comments.find((comment) => comment.body.includes(marker));
    }
    catch (error) {
        deps.logger.warning(`Could not read the pull request comments, so the sticky comment was skipped: ${describe(error)}`);
        return null;
    }
    try {
        if (existing !== undefined)
            return await deps.github.updateComment(existing.id, body);
        return await deps.github.createComment(prNumber, body);
    }
    catch (error) {
        deps.logger.warning(`Could not post the pull request comment (the check result is unaffected): ${describe(error)}`);
        return null;
    }
}
/** Body is `toJSON(report)` plus `{repo, sha, target}` and nothing else. Failures are warnings. */
async function uploadReport(report, opts, deps) {
    const { owner, repo } = deps.github.repo;
    // I1: an allow-listed projection plus three identifiers. Nothing else is sent.
    const body = JSON.stringify({
        repo: `${owner}/${repo}`,
        sha: deps.github.sha,
        target: report.target,
        report: toJSON(report),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
        const response = await deps.fetch(opts.reportUrl, {
            method: "POST",
            headers: {
                authorization: `Bearer ${opts.licenseKey}`,
                "content-type": "application/json",
                "user-agent": USER_AGENT,
            },
            body,
            signal: controller.signal,
        });
        if (!response.ok) {
            deps.logger.warning(`The report upload was rejected (HTTP ${response.status}); the check result is unaffected.`);
            return false;
        }
        return true;
    }
    catch (error) {
        deps.logger.warning(`The report upload failed (the check result is unaffected): ${describe(error)}`);
        return false;
    }
    finally {
        clearTimeout(timer);
    }
}
/* -------------------------------------------------------------------- scan */
async function scanRepository(inputs, deps) {
    const requested = inputs.path.trim() === "" ? "." : inputs.path.trim();
    const root = external_node_path_default().isAbsolute(requested) ? requested : external_node_path_default().resolve(deps.cwd, requested);
    const options = {
        include: parseList(inputs.include),
        exclude: parseList(inputs.exclude),
        includeTests: parseBoolean(inputs.include_tests, false),
        fs: deps.fs,
    };
    const collected = await collectFiles(root, options);
    const code = collected.files.filter((file) => file.kind === "code");
    const examples = collected.files.filter((file) => file.kind === "env-example");
    const readCode = await readSourceFiles(code, options);
    const readExamples = await readSourceFiles(examples, options);
    const scanned = scanner_scanFiles(readCode.sources, {});
    const parsed = parseEnvExamples(readExamples.sources);
    const warnings = [
        ...collected.warnings,
        ...readCode.warnings,
        ...readExamples.warnings,
        ...scanned.warnings,
        ...parsed.warnings,
    ];
    for (const warning of warnings) {
        deps.logger.debug(`${warning.file}:${warning.line} ${warning.code}: ${warning.message}`);
    }
    return { scan: { ...scanned, warnings }, declared: parsed.declared };
}
/**
 * A key declared in `.env.example` but never referenced in code is a stale
 * declaration only when the environment does not configure it either. When
 * Vercel already has the key the deployment is fine, so there is nothing to
 * tell the user about — reporting it would be noise, not a finding.
 */
function pruneDeclared(declared, scan, env) {
    const configured = new Set(env.map((entry) => entry.key));
    const kept = new Map();
    for (const [key, entry] of declared) {
        if (!scan.keys.has(key) && configured.has(key))
            continue;
        kept.set(key, entry);
    }
    return kept;
}
/* ------------------------------------------------------------------ runner */
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
/** I1: belt and braces — a token can never survive into anything we emit. */
function redactToken(message, token) {
    const secret = token.trim();
    if (secret.length === 0 || !message.includes(secret))
        return message;
    return message.split(secret).join("[redacted]");
}
function firstLine(text) {
    const end = text.indexOf("\n");
    return end === -1 ? text : text.slice(0, end);
}
function emptyCounts() {
    return { missing: 0, missing_optional: 0, present: 0, elsewhere: 0, unused: 0, dynamic: 0 };
}
function errorReport(target, branch) {
    return {
        status: "error",
        target,
        branch,
        counts: emptyCounts(),
        findings: [],
        dynamicAccess: 0,
        version: VERSION,
    };
}
function readSettings(inputs, deps) {
    // A comment needs somewhere to go (a pull request), something to post with (a
    // token), and permission (the input). Anything less and the run stays silent.
    const onPullRequest = deps.github.eventName.startsWith("pull_request") && deps.github.prNumber !== null;
    return {
        onErrorWarn: inputs.on_error.trim().toLowerCase() === "warn",
        licenseKey: inputs.license_key.trim(),
        reportUrl: inputs.report_url.trim() === "" ? DEFAULT_REPORT_URL : inputs.report_url.trim(),
        comment: parseBoolean(inputs.comment, true) && inputs.github_token.trim() !== "" && onPullRequest,
    };
}
/**
 * The one place a finished report turns into everything a run emits: the step
 * summary, the annotations, the outputs, the JSON file, the sticky comment and
 * (when licensed) the upload. I1 holds because every one of these is derived
 * from `report`, which the Vercel boundary already stripped of values.
 */
async function emitReport(report, settings, deps) {
    const markdown = renderMarkdown(report, { licensed: settings.licenseKey !== "" });
    const annotations = renderAnnotations(report);
    for (const annotation of annotations)
        deps.annotations.emit(annotation);
    // A step summary is a courtesy, never a verdict: a read-only summary file
    // must not turn a passing check red.
    try {
        await deps.summary.write(markdown);
    }
    catch (error) {
        deps.logger.warning(`Could not write the step summary: ${describe(error)}`);
    }
    const missing = report.findings
        .filter((finding) => finding.status === "missing")
        .map((finding) => finding.key);
    const reportDirectory = (deps.env["RUNNER_TEMP"] ?? "").trim() || external_node_os_default().tmpdir();
    const reportPath = external_node_path_default().join(reportDirectory, REPORT_FILE_NAME);
    let writtenPath = reportPath;
    try {
        await deps.writeFile(reportPath, `${JSON.stringify(toJSON(report), null, 2)}\n`);
    }
    catch (error) {
        writtenPath = "";
        deps.logger.warning(`Could not write the JSON report: ${describe(error)}`);
    }
    const outputs = {
        status: report.status,
        missing: missing.join(","),
        missing_count: String(missing.length),
        report_json: writtenPath,
        summary: markdown,
    };
    for (const name of OUTPUT_NAMES)
        deps.outputs.setOutput(name, outputs[name]);
    if (settings.comment)
        await upsertStickyComment(markdown, deps);
    if (settings.licenseKey !== "") {
        await uploadReport(report, { licenseKey: settings.licenseKey, reportUrl: settings.reportUrl }, deps);
    }
    // I2: only an explicit `on_error: warn` may turn a broken run green.
    const exitCode = report.status === "pass" ? 0 : report.status === "error" && settings.onErrorWarn ? 0 : 1;
    return { report, exitCode, markdown, annotations, outputs };
}
/** The whole Action, minus process wiring. Never throws for an expected failure. */
async function runEnvContract(inputs, deps) {
    const settings = readSettings(inputs, deps);
    const branch = resolveBranch(inputs, deps);
    const fail = async (message, target) => {
        const safe = redactToken(message, inputs.vercel_token);
        if (settings.onErrorWarn)
            deps.logger.warning(safe);
        else
            deps.logger.error(safe);
        return await emitReport(errorReport(target, branch), settings, deps);
    };
    const target = resolveTargetOrNull(inputs, deps);
    if (target === null)
        return await fail(unknownTargetMessage(inputs.target), "preview");
    try {
        const teamId = await resolveTeamId(inputs, deps);
        const clientOptions = {
            token: inputs.vercel_token,
            fetch: deps.fetch,
        };
        if (teamId !== null)
            clientOptions.teamId = teamId;
        if (deps.sleep !== undefined)
            clientOptions.sleep = deps.sleep;
        if (deps.now !== undefined)
            clientOptions.now = deps.now;
        const client = deps.client ?? createVercelClient(clientOptions);
        const project = await resolveProject(inputs, deps, client);
        if (project.idOrName === null) {
            if (project.candidates !== undefined && project.candidates.length > 0) {
                return await fail(`The repository is linked to more than one Vercel project (${project.candidates.join(", ")}). Set the \`project\` input to the one to check.`, target);
            }
            return await fail("Could not work out which Vercel project to check. Set the `project` input, the VERCEL_PROJECT_ID environment variable, or link the repository in Vercel.", target);
        }
        // No `gitBranch` filter: branch scoping is decided locally, so a variable
        // that exists only for another branch can still be reported as `elsewhere`.
        const env = await client.listEnv(project.idOrName, {});
        const { scan, declared } = await scanRepository(inputs, deps);
        const report = compare(scan, pruneDeclared(declared, scan, env), env, {
            target,
            branch: branch ?? undefined,
            ignore: parseList(inputs.ignore),
            optional: parseList(inputs.optional),
            required: parseList(inputs.required),
            failOn: parseFailOn(inputs.fail_on),
        });
        return await emitReport(report, settings, deps);
    }
    catch (error) {
        return await fail(describe(error), target);
    }
}

;// CONCATENATED MODULE: ./src/cli.ts
/**
 * SPEC: docs/SPEC.md — Module E, CLI:
 * `npx envcontract --target preview --project my-app [--json] [--dir .]`
 * Exit codes: 0 pass, 1 fail, 2 error.
 *
 * Hand-rolled argument parsing, no dependencies. This is the ONLY module allowed
 * to write to stdout (`tests/invariants.test.ts` enforces that).
 */






const USAGE = `envcontract — does this commit need config this environment doesn't have?

Usage:
  envcontract --target <production|preview|development> [options]

Options:
  --project <id|name>      Vercel project (default: auto-detect)
  --team-id <id>           Vercel team id
  --branch <name>          Branch for preview-scoped variables
  --dir <path>             Directory to scan (default: .)
  --token <token>          Vercel token (default: $VERCEL_TOKEN)
  --token-env <name>       Read the token from another environment variable
  --fail-on <missing|elsewhere|never>
  --on-error <fail|warn>
  --include/--exclude <glob>
  --ignore/--optional/--required <key>
  --include-tests
  --json                   Print the JSON report instead of the text block
  --help

Exit codes: 0 pass, 1 fail, 2 error.
`;
const TARGET_WORDS = new Set(["production", "preview", "development", "auto"]);
const FAIL_ON_WORDS = new Set(["missing", "elsewhere", "never"]);
const ON_ERROR_WORDS = new Set(["fail", "warn"]);
/** Every flag that consumes the next argv entry. Anything else is unknown. */
const VALUE_FLAGS = new Set([
    "--target",
    "--project",
    "--team-id",
    "--branch",
    "--dir",
    "--token",
    "--token-env",
    "--fail-on",
    "--on-error",
    "--include",
    "--exclude",
    "--ignore",
    "--optional",
    "--required",
]);
function usageError(message) {
    return { message, exitCode: 2 };
}
function defaults() {
    return {
        target: "preview",
        project: null,
        teamId: null,
        branch: null,
        dir: ".",
        token: null,
        tokenEnv: null,
        json: false,
        failOn: "elsewhere",
        onError: "fail",
        include: [],
        exclude: [],
        ignore: [],
        optional: [],
        required: [],
        includeTests: false,
        help: false,
    };
}
/** Parses argv (without `node` and the script path). Throws nothing; returns a CliError. */
function parseArgs(argv) {
    const args = defaults();
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index] ?? "";
        switch (flag) {
            case "--help":
            case "-h":
                args.help = true;
                continue;
            case "--json":
                args.json = true;
                continue;
            case "--include-tests":
                args.includeTests = true;
                continue;
            default:
                break;
        }
        if (!VALUE_FLAGS.has(flag))
            return usageError(`Unknown option "${flag}".`);
        // A flag that takes a value consumes the next entry; another flag in that
        // slot means the value was forgotten, which is a usage error, not a guess.
        const next = argv[index + 1];
        if (next === undefined || next.startsWith("--")) {
            return usageError(`${flag} needs a value.`);
        }
        index += 1;
        const raw = next;
        switch (flag) {
            case "--target": {
                const word = raw.trim().toLowerCase();
                if (!TARGET_WORDS.has(word)) {
                    return usageError(`Unknown target "${raw}". Use production, preview, development, or auto.`);
                }
                args.target = word;
                break;
            }
            case "--fail-on": {
                const word = raw.trim().toLowerCase();
                if (!FAIL_ON_WORDS.has(word)) {
                    return usageError(`Unknown --fail-on "${raw}". Use missing, elsewhere, or never.`);
                }
                args.failOn = word;
                break;
            }
            case "--on-error": {
                const word = raw.trim().toLowerCase();
                if (!ON_ERROR_WORDS.has(word)) {
                    return usageError(`Unknown --on-error "${raw}". Use fail or warn.`);
                }
                args.onError = word;
                break;
            }
            case "--project":
                args.project = raw;
                break;
            case "--team-id":
                args.teamId = raw;
                break;
            case "--branch":
                args.branch = raw;
                break;
            case "--dir":
                args.dir = raw;
                break;
            case "--token":
                args.token = raw;
                break;
            case "--token-env":
                args.tokenEnv = raw;
                break;
            case "--include":
                args.include.push(raw);
                break;
            case "--exclude":
                args.exclude.push(raw);
                break;
            case "--ignore":
                args.ignore.push(raw);
                break;
            case "--optional":
                args.optional.push(raw);
                break;
            case "--required":
                args.required.push(raw);
                break;
            default:
                return usageError(`Unknown option "${flag}".`);
        }
    }
    return args;
}
function isCliError(value) {
    return "message" in value;
}
function toInputs(args, token) {
    return {
        vercel_token: token,
        target: args.target,
        project: args.project ?? "",
        team_id: args.teamId ?? "",
        branch: args.branch ?? "",
        path: args.dir,
        include: args.include.join("\n"),
        exclude: args.exclude.join("\n"),
        ignore: args.ignore.join("\n"),
        optional: args.optional.join("\n"),
        required: args.required.join("\n"),
        fail_on: args.failOn,
        on_error: args.onError,
        // The CLI has no pull request to comment on and no license to report under.
        comment: "false",
        github_token: "",
        license_key: "",
        report_url: DEFAULT_REPORT_URL,
        include_tests: args.includeTests ? "true" : "false",
    };
}
/** The CLI, with injected deps and an injected writer. Returns the exit code. */
async function cli(argv, deps, write) {
    // stdout carries the report and nothing else, so `--json` stays pipeable.
    // Diagnostics — usage errors, the missing-token message — go to stderr.
    const parsed = parseArgs(argv);
    if (isCliError(parsed)) {
        deps.logger.error(`${parsed.message}\n\n${USAGE.trimEnd()}`);
        return 2;
    }
    // `--help` is a request for the usage block, so it is output, not an error.
    if (parsed.help) {
        write(USAGE.trimEnd());
        return 0;
    }
    const fromEnv = parsed.tokenEnv === null ? deps.env["VERCEL_TOKEN"] : deps.env[parsed.tokenEnv];
    const token = (parsed.token ?? fromEnv ?? "").trim();
    if (token === "") {
        deps.logger.error("No Vercel token. Pass --token, or set VERCEL_TOKEN in the environment.");
        return 2;
    }
    const result = await runEnvContract(toInputs(parsed, token), deps);
    write(parsed.json ? stringifyReport(result.report) : renderText(result.report));
    // I2: an error is never a green run, and it is louder than a plain failure.
    if (result.report.status === "error")
        return 2;
    return result.exitCode === 0 ? 0 : 1;
}
/** Process wiring: builds real deps, writes to stdout, sets `process.exitCode`. */
async function cliMain() {
    const slug = (process.env["GITHUB_REPOSITORY"] ?? "").split("/");
    const deps = {
        fetch: (input, init) => globalThis.fetch(input, init),
        fs: nodeFileSystem,
        async writeFile(file, content) {
            await external_node_fs_namespaceObject.promises.mkdir(external_node_path_default().dirname(file), { recursive: true });
            await external_node_fs_namespaceObject.promises.writeFile(file, content, "utf8");
        },
        env: process.env,
        cwd: process.cwd(),
        github: {
            eventName: "local",
            repo: { owner: slug[0] ?? "", repo: slug[1] ?? "" },
            sha: process.env["GITHUB_SHA"] ?? "",
            defaultBranch: "main",
            prNumber: null,
            listComments: async () => [],
            createComment: async (_pr, body) => ({ id: 0, body }),
            updateComment: async (id, body) => ({ id, body }),
        },
        // Diagnostics go to stderr so `--json` stdout stays machine-readable.
        logger: {
            info: (message) => console.error(message),
            warning: (message) => console.error(`warning: ${message}`),
            error: (message) => console.error(`error: ${message}`),
            debug: () => undefined,
        },
        outputs: { setOutput: () => undefined },
        summary: { write: async () => undefined },
        annotations: { emit: () => undefined },
    };
    process.exitCode = await cli(process.argv.slice(2), deps, (line) => console.log(line));
}

;// CONCATENATED MODULE: ./src/cli-main.ts
/**
 * Bundle entry for the `envcontract` binary. `cli.ts` stays side-effect free so
 * the test suite can import it; this file is the one that actually runs it.
 */

void cliMain();

