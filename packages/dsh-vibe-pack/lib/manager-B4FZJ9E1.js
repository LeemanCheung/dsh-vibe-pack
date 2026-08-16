import { z } from "zod";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { JSON_SCHEMA, dump, load } from "js-yaml";
import { satisfies, validRange } from "semver";
import { createHash, timingSafeEqual } from "node:crypto";
//#region src/core/compat.ts
function checkCompatibility(pack, runtime) {
	const reasons = [];
	for (const key of ["dsh", "node"]) {
		const range = "compatibility" in pack ? pack.compatibility[key] : pack[key];
		if (!range) continue;
		const version = runtime[key];
		if (!version) reasons.push(`runtime does not report ${key} version required by ${range}`);
		else if (!validRange(range)) reasons.push(`invalid ${key} compatibility range: ${range}`);
		else if (!satisfies(version, range, { includePrerelease: true })) reasons.push(`${key} ${version} does not satisfy ${range}`);
	}
	return {
		compatible: reasons.length === 0,
		reasons
	};
}
function assertCompatibility(requirements, runtime) {
	const result = checkCompatibility(requirements, runtime);
	if (!result.compatible) throw new Error(`incompatible pack: ${result.reasons.join("; ")}`);
}
//#endregion
//#region src/core/security.ts
var SecurityError = class extends Error {};
function sha256$1(data) {
	return createHash("sha256").update(data).digest("hex");
}
function hashesEqual(actual, expected) {
	if (!/^[a-f\d]{64}$/i.test(actual) || !/^[a-f\d]{64}$/i.test(expected)) return false;
	return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}
function assertSafeRelativePath(path) {
	if (!path || path.includes("\0") || isAbsolute(path)) throw new SecurityError(`unsafe path: ${path}`);
	const normalized = path.replace(/\\/g, "/");
	if (normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new SecurityError(`unsafe path: ${path}`);
	return normalized;
}
function containedPath(root, candidate) {
	const resolvedRoot = resolve(root), resolvedCandidate = resolve(root, candidate);
	const rel = relative(resolvedRoot, resolvedCandidate);
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new SecurityError(`path escapes root: ${candidate}`);
	return resolvedCandidate;
}
/** Creates and resolves a destination parent, rejecting symlink escapes before writes. */
async function containedWritablePath(root, candidate) {
	const resolvedRoot = resolve(root);
	await mkdir(resolvedRoot, { recursive: true });
	const lexical = containedPath(resolvedRoot, candidate);
	await mkdir(dirname(lexical), { recursive: true });
	const realRoot = await realpath(resolvedRoot);
	const realParent = await realpath(dirname(lexical));
	const rel = relative(realRoot, realParent);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new SecurityError(`destination parent escapes root: ${candidate}`);
	return join(realParent, basename(lexical));
}
/** Resolves symlinks and verifies the resulting existing file is still inside root. */
async function containedExistingPath(root, candidate) {
	const realRoot = await realpath(root);
	const realCandidate = await realpath(containedPath(realRoot, candidate));
	const rel = relative(realRoot, realCandidate);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new SecurityError(`symlink escapes root: ${candidate}`);
	return realCandidate;
}
const SECRET_KEY = /(?:^|[_-])(token|secret|password|passwd|api[_-]?key|private[_-]?key)(?:$|[_-])/i;
const SECRET_VALUE = /(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----)/;
const SECRET_ASSIGNMENT = /(?:^|[\s{,[;])(?:token|secret|password|passwd|api[_-]?key|private[_-]?key)\s*[:=]\s*["']?[^\s,"'};]{4,}/im;
function findSecrets(value, path = "$") {
	if (typeof value === "string") return SECRET_VALUE.test(value) || SECRET_ASSIGNMENT.test(value) ? [{
		path,
		reason: "credential-like value"
	}] : [];
	if (Array.isArray(value)) return value.flatMap((v, i) => findSecrets(v, `${path}[${i}]`));
	if (!value || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([key, child]) => {
		const childPath = `${path}.${key}`;
		return SECRET_KEY.test(key) && typeof child === "string" && child.length > 0 ? [{
			path: childPath,
			reason: "secret-like key"
		}] : findSecrets(child, childPath);
	});
}
function assertNoSecrets(value) {
	const findings = findSecrets(value);
	if (findings.length) throw new SecurityError(`embedded secrets are forbidden: ${findings.map((x) => x.path).join(", ")}`);
}
function assertDataOnlySource(text, filename = "source") {
	if (text.length > 2e6) throw new SecurityError(`${filename} exceeds 2 MiB limit`);
	if (/(?:^#!|<script\b|\b(?:child_process|subprocess|eval|Function|require\s*\(|import\s*\(|process\.env|console\.|os\.system|Invoke-Expression|Start-Process|curl\b|wget\b|rm\s+-rf))/im.test(text)) throw new SecurityError(`${filename} appears to contain executable source`);
}
//#endregion
//#region src/core/lifecycle.ts
function checkpoint(files, ownership) {
	return {
		version: 1,
		createdAt: (/* @__PURE__ */ new Date()).toISOString(),
		files: [...files].map((f) => ({
			path: f.path,
			digest: sha256$1(f.content),
			owner: f.owner
		})).sort((a, b) => a.path.localeCompare(b.path)),
		ownership
	};
}
function diffCheckpoints(before, after) {
	const old = new Map(before.files.map((f) => [f.path, f])), next = new Map(after.files.map((f) => [f.path, f]));
	return [.../* @__PURE__ */ new Set([...old.keys(), ...next.keys()])].sort().map((path) => {
		const a = old.get(path), b = next.get(path);
		return {
			path,
			before: a,
			after: b,
			type: !a ? "create" : !b ? "delete" : a.digest === b.digest && a.owner === b.owner ? "unchanged" : "update"
		};
	});
}
function exportCheckpoint(checkpoint) {
	return `${JSON.stringify(checkpoint, null, 2)}\n`;
}
//#endregion
//#region src/core/ownership.ts
/** Bidirectional ownership index. Constructor accepts owner -> paths mappings. */
var OwnershipGraph = class OwnershipGraph {
	owners = /* @__PURE__ */ new Map();
	constructor(initial = {}) {
		for (const [owner, paths] of Object.entries(initial)) for (const path of paths) this.claim(owner, path);
	}
	claim(owner, path) {
		(this.owners.get(path) ?? this.owners.set(path, /* @__PURE__ */ new Set()).get(path)).add(owner);
	}
	release(owner, path) {
		const set = this.owners.get(path);
		if (!set) return;
		set.delete(owner);
		if (!set.size) this.owners.delete(path);
	}
	replace(owner, paths) {
		for (const [path, set] of this.owners) if (set.has(owner)) this.release(owner, path);
		for (const path of paths) this.claim(owner, path);
	}
	ownersOf(path) {
		return [...this.owners.get(path) ?? []].sort();
	}
	ownerOf(path) {
		return this.ownersOf(path)[0];
	}
	pathsOf(owner) {
		return [...this.owners].filter(([, owners]) => owners.has(owner)).map(([path]) => path).sort();
	}
	conflicts(owner, paths) {
		return [...paths].flatMap((path) => this.ownersOf(path).filter((existing) => existing !== owner).map((existing) => ({
			owner: existing,
			path
		})));
	}
	toJSON() {
		return Object.fromEntries([...this.owners].map(([path, owners]) => [path, [...owners].sort()]));
	}
	static fromJSON(value) {
		const graph = new OwnershipGraph();
		for (const [path, owners] of Object.entries(value)) for (const owner of owners) graph.claim(owner, path);
		return graph;
	}
};
//#endregion
//#region src/core/safe-yaml.ts
var SafeYamlError = class extends Error {};
/** Parse data-only YAML. Anchors, custom tags, functions, and aliases are rejected. */
function parseSafeYaml(input) {
	if (input.length > 1e6) throw new SafeYamlError("YAML exceeds 1 MiB limit");
	if (/(^|[\s:[{,])(?:!|&|\*)[^\s]*/m.test(input)) throw new SafeYamlError("YAML tags, anchors, and aliases are not allowed");
	let value;
	try {
		value = load(input, {
			schema: JSON_SCHEMA,
			json: false
		});
	} catch (error) {
		throw new SafeYamlError(`invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
	}
	assertPlainData(value);
	return value;
}
function assertPlainData(value, seen = /* @__PURE__ */ new Set()) {
	if (value === null || [
		"string",
		"number",
		"boolean"
	].includes(typeof value)) return;
	if (Array.isArray(value)) {
		for (const item of value) assertPlainData(item, seen);
		return;
	}
	if (typeof value !== "object") throw new SafeYamlError(`unsupported YAML value: ${typeof value}`);
	if (seen.has(value)) throw new SafeYamlError("recursive YAML structures are not allowed");
	seen.add(value);
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) throw new SafeYamlError("YAML must contain plain objects only");
	for (const [key, item] of Object.entries(value)) {
		if (key === "__proto__" || key === "constructor" || key === "prototype") throw new SafeYamlError(`unsafe key: ${key}`);
		assertPlainData(item, seen);
	}
	seen.delete(value);
}
//#endregion
//#region src/core/schema.ts
const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/i, "must be a safe identifier");
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i, "must be a SHA-256 digest");
const PackFileSchema = z.object({
	path: z.string().min(1),
	sha256,
	mode: z.enum([
		"create",
		"replace",
		"merge"
	]).default("replace"),
	secret: z.literal(false).default(false)
}).strict();
const PackSchemaV1 = z.object({
	schemaVersion: z.literal(1),
	id,
	version: z.string().min(1).max(128),
	compatibility: z.object({
		dsh: z.string().optional(),
		node: z.string().optional()
	}).strict().default({}),
	files: z.array(PackFileSchema).min(1).max(1e4),
	ownership: z.record(id, z.array(z.string().min(1))).default({}),
	metadata: z.object({
		name: z.string().max(256).optional(),
		description: z.string().max(2e3).optional(),
		source: z.string().max(2e3).optional()
	}).strict().default({})
}).strict().superRefine((pack, ctx) => {
	const seen = /* @__PURE__ */ new Set();
	for (const file of pack.files) {
		if (seen.has(file.path)) ctx.addIssue({
			code: "custom",
			path: ["files"],
			message: `duplicate file path: ${file.path}`
		});
		seen.add(file.path);
	}
	if (Object.keys(pack.ownership).some((owner) => owner !== pack.id)) ctx.addIssue({
		code: "custom",
		path: ["ownership"],
		message: "ownership may declare only the current pack id"
	});
	const declared = pack.ownership[pack.id];
	if (declared !== void 0) {
		const owned = new Set(declared);
		if (owned.size !== declared.length || owned.size !== seen.size || [...seen].some((path) => !owned.has(path))) ctx.addIssue({
			code: "custom",
			path: ["ownership", pack.id],
			message: "ownership must list every manifest file exactly once"
		});
	}
});
const parsePackV1 = (value) => PackSchemaV1.parse(value);
//#endregion
//#region src/core/source.ts
const MAX_FILES = 1e4;
const MAX_BYTES = 52428800;
const MAX_FILE_BYTES = 2e6;
async function resolveSource(spec) {
	const files = spec.kind === "directory" ? await readDirectory(spec.path) : await readArchive(spec.path);
	if (files.size === 0) throw new SecurityError("source contains no files");
	let bytes = 0;
	for (const [path, value] of files) {
		assertSafeRelativePath(path);
		bytes += value.byteLength;
	}
	if (files.size > MAX_FILES || bytes > MAX_BYTES) throw new SecurityError("source exceeds file or byte limit");
	const digest = sha256$1([...files].sort(([left], [right]) => left.localeCompare(right)).map(([path, data]) => `${path}\0${sha256$1(data)}\n`).join(""));
	return {
		origin: `${spec.kind}:${spec.path}`,
		files,
		digest
	};
}
async function readDirectory(root) {
	const output = /* @__PURE__ */ new Map();
	let bytes = 0;
	const walk = async (directory) => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) throw new SecurityError(`symlinks are not permitted: ${entry.name}`);
			const absolute = join(directory, entry.name);
			if (entry.isDirectory()) await walk(absolute);
			else if (entry.isFile()) {
				const safe = relative(root, absolute).replace(/\\/g, "/");
				const existing = await containedExistingPath(root, safe);
				const info = await stat(existing);
				bytes += info.size;
				if (output.size + 1 > MAX_FILES || bytes > MAX_BYTES || info.size > MAX_FILE_BYTES) throw new SecurityError("source exceeds file or byte limit");
				output.set(assertSafeRelativePath(safe), new Uint8Array(await readFile(existing)));
			}
		}
	};
	await walk(root);
	return output;
}
async function readArchive(path) {
	const extension = extname(path).toLowerCase();
	if (extension !== ".zip" && extension !== ".dshpack") throw new SecurityError("archives must use .dshpack or .zip");
	const content = new Uint8Array(await readFile(path));
	if (content.byteLength > MAX_BYTES) throw new SecurityError("compressed archive exceeds byte limit");
	let files = 0;
	let bytes = 0;
	const names = /* @__PURE__ */ new Set();
	const decoded = unzipSync(content, { filter: (entry) => {
		if (entry.name.endsWith("/")) return false;
		const safe = assertSafeRelativePath(entry.name);
		const folded = safe.toLowerCase();
		if (names.has(folded)) throw new SecurityError(`duplicate archive path: ${safe}`);
		names.add(folded);
		files += 1;
		bytes += entry.originalSize;
		if (files > MAX_FILES || bytes > MAX_BYTES || entry.originalSize > MAX_FILE_BYTES) throw new SecurityError("archive exceeds file or byte limit");
		return true;
	} });
	return new Map(Object.entries(decoded).map(([name, data]) => [assertSafeRelativePath(name), data]));
}
//#endregion
//#region src/core/manager.ts
const emptyPackLedger = () => ({
	version: 1,
	packs: {}
});
/** Filesystem-backed data-only pack lifecycle with one durable mutation lock. */
var PackManager = class {
	root;
	runtime;
	mutations = Promise.resolve();
	constructor(root, runtime = {
		dsh: "0.1.0-rc.6",
		node: process.versions.node
	}) {
		this.root = root;
		this.runtime = runtime;
	}
	get stateRoot() {
		return join(this.root, ".dsh-vibe-pack");
	}
	get statePath() {
		return join(this.stateRoot, "ledger.json");
	}
	async inspect(source) {
		const resolved = await resolveSource(source);
		const manifestNames = ["dshpack.yaml", "dshpack.yml"].filter((name) => resolved.files.has(name));
		if (manifestNames.length !== 1) throw new SecurityError("pack must contain exactly one dshpack.yaml or dshpack.yml manifest");
		const raw = decodeText(resolved.files.get(manifestNames[0]), manifestNames[0]);
		assertDataOnlySource(raw, "manifest");
		const parsed = parseSafeYaml(raw);
		assertNoSecrets(parsed);
		const pack = parsePackV1(parsed);
		assertCompatibility(pack.compatibility, this.runtime);
		const declared = new Set(pack.files.map((entry) => assertSafeRelativePath(entry.path)));
		const extras = [...resolved.files.keys()].filter((path) => !manifestNames.includes(path) && !declared.has(path));
		if (extras.length > 0) throw new SecurityError(`undeclared pack payloads are forbidden: ${extras.sort().join(", ")}`);
		for (const entry of pack.files) {
			const path = assertSafeRelativePath(entry.path);
			const bytes = resolved.files.get(path);
			if (bytes === void 0) throw new SecurityError(`manifest file missing: ${path}`);
			if (!hashesEqual(sha256$1(bytes), entry.sha256)) throw new SecurityError(`hash mismatch: ${path}`);
			validatePayload(path, bytes);
		}
		return {
			pack,
			files: resolved.files,
			digest: resolved.digest
		};
	}
	async plan(source) {
		const info = await this.inspect(source);
		return this.planInspected(info, await this.ledger());
	}
	async planInspected(info, ledger) {
		const graph = new OwnershipGraph(Object.fromEntries(Object.entries(ledger.packs).map(([id, entry]) => [id, Object.keys(entry.files)])));
		const items = [];
		for (const file of info.pack.files) {
			const existing = await readOptional(containedPath(this.root, file.path));
			const owner = graph.ownerOf(file.path);
			let conflict;
			if (existing !== void 0) {
				if (owner === void 0) conflict = "existing unowned resource";
				else if (owner !== info.pack.id) conflict = `owned by ${owner}`;
				else if (ledger.packs[owner]?.files[file.path] !== sha256$1(existing)) conflict = "resource was modified after installation";
				else if (file.mode === "create") conflict = "create mode refuses an existing resource";
			}
			items.push({
				path: file.path,
				action: file.mode,
				...conflict === void 0 ? {} : { conflict }
			});
		}
		return {
			pack: {
				id: info.pack.id,
				version: info.pack.version
			},
			sourceDigest: info.digest,
			items,
			warnings: items.flatMap((item) => item.conflict === void 0 ? [] : [`${item.path}: ${item.conflict}`])
		};
	}
	async install(source, options = {}) {
		return this.serialize(() => this.withLock(async () => {
			const info = await this.inspect(source);
			if (options.expectedDigest !== void 0 && !hashesEqual(info.digest, options.expectedDigest)) throw new SecurityError("pack source changed after preview; review the plan again");
			const ledger = await this.ledger();
			const plan = await this.planInspected(info, ledger);
			if (plan.warnings.length > 0 && !options.force) throw new SecurityError(`conflicts require force: ${plan.warnings.join("; ")}`);
			const paths = info.pack.files.map((file) => file.path);
			const before = await this.capture(paths, ledger);
			const backup = await this.backup(paths);
			try {
				for (const file of info.pack.files) {
					const sourceBytes = info.files.get(file.path);
					if (sourceBytes === void 0) throw new SecurityError(`manifest file missing: ${file.path}`);
					const target = await containedWritablePath(this.root, file.path);
					await writeAtomic(target, file.mode === "merge" ? await mergeContent(target, sourceBytes) : sourceBytes);
				}
				if (options.force) for (const [owner, entry] of Object.entries(ledger.packs)) {
					if (owner === info.pack.id) continue;
					for (const path of paths) delete entry.files[path];
				}
				const files = Object.fromEntries(await Promise.all(paths.map(async (path) => [path, sha256$1(await readFile(containedPath(this.root, path)))])));
				ledger.packs[info.pack.id] = {
					version: info.pack.version,
					sourceDigest: info.digest,
					files,
					checkpoint: before
				};
				await this.save(ledger);
				return plan;
			} catch (error) {
				const rollback = await this.restoreBackup(backup);
				if (rollback !== void 0) throw new Error("install failed and rollback was partial", { cause: {
					error,
					rollback
				} });
				throw error;
			}
		}));
	}
	async uninstall(id, options = {}) {
		await this.serialize(() => this.withLock(async () => {
			const ledger = await this.ledger();
			const installed = ledger.packs[id];
			if (installed === void 0) throw new Error(`pack not installed: ${id}`);
			const backup = await this.backup(Object.keys(installed.files));
			try {
				for (const [path, expected] of Object.entries(installed.files)) {
					const target = await containedWritablePath(this.root, path);
					const current = await readOptional(target);
					if (current !== void 0 && sha256$1(current) !== expected && !options.force) throw new SecurityError(`modified resource protected: ${path}`);
					await rm(target, { force: true });
				}
				delete ledger.packs[id];
				await this.save(ledger);
			} catch (error) {
				const rollback = await this.restoreBackup(backup);
				if (rollback !== void 0) throw new Error("uninstall failed and rollback was partial", { cause: {
					error,
					rollback
				} });
				throw error;
			}
		}));
	}
	async history() {
		return structuredClone(await this.ledger());
	}
	async diff(id) {
		const ledger = await this.ledger();
		const installed = ledger.packs[id];
		if (installed === void 0) throw new Error(`pack not installed: ${id}`);
		return diffCheckpoints(installed.checkpoint, await this.capture(Object.keys(installed.files), ledger));
	}
	async export(id) {
		const installed = (await this.ledger()).packs[id];
		if (installed === void 0) throw new Error(`pack not installed: ${id}`);
		const payloads = {};
		const files = [];
		for (const [path, expected] of Object.entries(installed.files)) {
			const content = await readOptional(containedPath(this.root, path));
			if (content === void 0) throw new SecurityError(`installed resource is missing: ${path}`);
			const digest = sha256$1(content);
			if (digest !== expected) throw new SecurityError(`modified resource protected: ${path}`);
			payloads[path] = content;
			files.push({
				path,
				sha256: digest,
				mode: "replace",
				secret: false
			});
		}
		const manifest = dump({
			schemaVersion: 1,
			id,
			version: installed.version,
			compatibility: {},
			files,
			ownership: { [id]: Object.keys(installed.files) },
			metadata: { name: id }
		}, {
			noRefs: true,
			sortKeys: true,
			lineWidth: 120
		});
		const archive = zipSync({
			"dshpack.yaml": new TextEncoder().encode(manifest),
			...payloads
		}, { level: 6 });
		return `dshpack/base64/v1:${Buffer.from(archive).toString("base64")}`;
	}
	async ledger() {
		try {
			const parsed = JSON.parse(await readFile(this.statePath, "utf8"));
			if (!isLedger(parsed)) throw new SecurityError("Vibe Pack ledger is invalid");
			return parsed;
		} catch (error) {
			if (isMissing(error)) return emptyPackLedger();
			throw error;
		}
	}
	async save(ledger) {
		await writeAtomic(await containedWritablePath(this.root, ".dsh-vibe-pack/ledger.json"), new TextEncoder().encode(`${JSON.stringify(ledger, null, 2)}\n`));
	}
	async capture(paths, ledger) {
		const owners = {};
		for (const [id, entry] of Object.entries(ledger.packs)) owners[id] = Object.keys(entry.files);
		const files = [];
		for (const path of paths) {
			const content = await readOptional(containedPath(this.root, path));
			if (content !== void 0) files.push({
				path,
				content
			});
		}
		return checkpoint(files, owners);
	}
	async backup(paths) {
		const result = /* @__PURE__ */ new Map();
		for (const path of paths) result.set(path, await readOptional(containedPath(this.root, path)));
		return result;
	}
	async restoreBackup(backup) {
		let failure;
		for (const [path, content] of [...backup].reverse()) try {
			const target = await containedWritablePath(this.root, path);
			if (content === void 0) await rm(target, { force: true });
			else await writeAtomic(target, content);
		} catch (error) {
			failure ??= error;
		}
		return failure;
	}
	async withLock(operation) {
		const lockPath = await containedWritablePath(this.root, ".dsh-vibe-pack/transaction.lock");
		try {
			await mkdir(lockPath);
		} catch (error) {
			if (error.code === "EEXIST") throw new SecurityError("another Vibe Pack transaction is active");
			throw error;
		}
		try {
			return await operation();
		} finally {
			await rm(lockPath, {
				recursive: true,
				force: true
			});
		}
	}
	serialize(operation) {
		const result = this.mutations.then(operation, operation);
		this.mutations = result.then(() => void 0, () => void 0);
		return result;
	}
};
async function writeAtomic(target, content) {
	await mkdir(dirname(target), { recursive: true });
	const temporary = `${target}.dsh-pack-${process.pid}-${Date.now()}.tmp`;
	try {
		await writeFile(temporary, content, {
			flag: "wx",
			mode: 384
		});
		await rename(temporary, target);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}
async function readOptional(path) {
	try {
		return new Uint8Array(await readFile(path));
	} catch (error) {
		if (isMissing(error)) return void 0;
		throw error;
	}
}
const STRUCTURED_EXTENSIONS = /* @__PURE__ */ new Set([
	".json",
	".yaml",
	".yml",
	".dshskin"
]);
const TEXT_EXTENSIONS = /* @__PURE__ */ new Set([
	".md",
	".txt",
	".toml",
	".ini"
]);
const BINARY_EXTENSIONS = /* @__PURE__ */ new Set([
	".png",
	".jpg",
	".jpeg",
	".webp",
	".gif"
]);
function decodeText(bytes, path) {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new SecurityError(`${path} must contain valid UTF-8 text`);
	}
}
function validatePayload(path, bytes) {
	const extension = extname(path).toLowerCase();
	if (BINARY_EXTENSIONS.has(extension)) return;
	if (!STRUCTURED_EXTENSIONS.has(extension) && !TEXT_EXTENSIONS.has(extension)) throw new SecurityError(`unsupported data-only file type: ${path}`);
	const text = decodeText(bytes, path);
	assertDataOnlySource(text, path);
	if (extension === ".json" || extension === ".dshskin") try {
		assertNoSecrets(JSON.parse(text));
	} catch (error) {
		if (error instanceof SecurityError) throw error;
		throw new SecurityError(`${path} must contain valid JSON`);
	}
	else if (extension === ".yaml" || extension === ".yml") assertNoSecrets(parseSafeYaml(text));
	else assertNoSecrets(text);
}
async function mergeContent(target, incoming) {
	const existing = await readOptional(target);
	if (existing === void 0) return incoming;
	const beforeText = new TextDecoder().decode(existing);
	const incomingText = new TextDecoder().decode(incoming);
	const before = parseMaybeYaml(beforeText);
	const next = parseMaybeYaml(incomingText);
	if (!isPlainRecord(before) || !isPlainRecord(next)) throw new SecurityError("merge mode requires JSON or YAML objects");
	const merged = mergeRecords(before, next);
	assertNoSecrets(merged);
	const text = extname(target).toLowerCase() === ".json" ? `${JSON.stringify(merged, null, 2)}\n` : dump(merged, {
		noRefs: true,
		sortKeys: true,
		lineWidth: 120
	});
	return new TextEncoder().encode(text);
}
function mergeRecords(before, next) {
	const result = { ...before };
	for (const [key, value] of Object.entries(next)) {
		if (key === "__proto__" || key === "constructor" || key === "prototype") throw new SecurityError(`unsafe merge key: ${key}`);
		const current = result[key];
		result[key] = isPlainRecord(current) && isPlainRecord(value) ? mergeRecords(current, value) : value;
	}
	return result;
}
function parseMaybeYaml(text) {
	try {
		return parseSafeYaml(text);
	} catch {
		return text;
	}
}
function isPlainRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function isMissing(error) {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function isLedger(value) {
	if (!isPlainRecord(value) || value.version !== 1 || !isPlainRecord(value.packs)) return false;
	return Object.entries(value.packs).every(([id, entry]) => /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id) && isPlainRecord(entry) && typeof entry.version === "string" && typeof entry.sourceDigest === "string" && isPlainRecord(entry.files) && Object.entries(entry.files).every(([path, digest]) => {
		try {
			assertSafeRelativePath(path);
		} catch {
			return false;
		}
		return typeof digest === "string" && /^[a-f0-9]{64}$/i.test(digest);
	}) && isPlainRecord(entry.checkpoint));
}
//#endregion
export { checkCompatibility as C, assertCompatibility as S, containedPath as _, parsePackV1 as a, hashesEqual as b, OwnershipGraph as c, exportCheckpoint as d, SecurityError as f, containedExistingPath as g, assertSafeRelativePath as h, PackSchemaV1 as i, checkpoint as l, assertNoSecrets as m, resolveSource as n, SafeYamlError as o, assertDataOnlySource as p, PackFileSchema as r, parseSafeYaml as s, PackManager as t, diffCheckpoints as u, containedWritablePath as v, sha256$1 as x, findSecrets as y };

//# sourceMappingURL=manager-B4FZJ9E1.js.map