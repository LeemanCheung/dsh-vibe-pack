import { C as checkCompatibility, S as assertCompatibility, _ as containedPath, a as parsePackV1, b as hashesEqual, c as OwnershipGraph, d as exportCheckpoint, f as SecurityError, g as containedExistingPath, h as assertSafeRelativePath, i as PackSchemaV1, l as checkpoint, m as assertNoSecrets, n as resolveSource, o as SafeYamlError, p as assertDataOnlySource, r as PackFileSchema, s as parseSafeYaml, t as PackManager, u as diffCheckpoints, v as containedWritablePath, x as sha256, y as findSecrets } from "./manager-B4FZJ9E1.js";
import { Service } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
//#region src/core/transaction.ts
var TransactionError = class extends Error {
	cause;
	rollbackError;
	constructor(message, cause, rollbackError) {
		super(message);
		this.cause = cause;
		this.rollbackError = rollbackError;
	}
};
/** Applies registered steps atomically from the caller's perspective. */
var Transaction = class {
	steps = [];
	add(name, adapter) {
		this.steps.push({
			name,
			adapter
		});
		return this;
	}
	async commit() {
		const completed = [];
		try {
			for (const step of this.steps) {
				const snapshot = await step.adapter.snapshot();
				completed.push({
					...step,
					snapshot
				});
				await step.adapter.apply();
			}
		} catch (cause) {
			let rollbackError;
			for (const step of completed.reverse()) try {
				await step.adapter.restore(step.snapshot);
			} catch (error) {
				rollbackError ??= error;
			}
			throw new TransactionError("transaction failed and rollback was attempted", cause, rollbackError);
		}
	}
};
var MemoryAdapter = class {
	value;
	next;
	constructor(value, next) {
		this.value = value;
		this.next = next;
	}
	async snapshot() {
		return structuredClone(this.value);
	}
	async restore(snapshot) {
		this.value = structuredClone(snapshot);
	}
	async apply() {
		this.value = this.next();
	}
	get current() {
		return this.value;
	}
};
//#endregion
//#region src/core/adapters.ts
/** One root-contained, reversible filesystem mutation. Undefined content deletes a file. */
var FileMutationAdapter = class {
	root;
	target;
	constructor(root, mutation) {
		this.root = root;
		this.target = containedPath(root, assertSafeRelativePath(mutation.path));
		this.mutation = mutation;
	}
	mutation;
	async snapshot() {
		try {
			return { content: new Uint8Array(await readFile(this.target)) };
		} catch (error) {
			if (error.code === "ENOENT") return {};
			throw error;
		}
	}
	async restore(snapshot) {
		if (snapshot.content) await this.writeAtomic(snapshot.content);
		else await rm(this.target, { force: true });
	}
	async apply() {
		if (this.mutation.content) await this.writeAtomic(this.mutation.content);
		else await rm(this.target, { force: true });
	}
	async writeAtomic(content) {
		await mkdir(dirname(this.target), { recursive: true });
		const temporary = `${this.target}.dsh-pack-${process.pid}-${Date.now()}.tmp`;
		await writeFile(temporary, content, { flag: "wx" });
		await rename(temporary, this.target);
	}
};
//#endregion
//#region src/index.ts
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) {
			if (kind === "field") initializers.unshift(_);
			else descriptor[key] = _;
		}
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
const domainSpec = defineDomain({
	name: "dsh_vibe_pack",
	version: 1,
	tables: { history: domainTable(z.object({
		at: z.string(),
		action: z.string(),
		detail: z.string()
	})) }
});
let VibePackService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _historyList_decorators;
	let _plan_decorators;
	let _install_decorators;
	let _uninstall_decorators;
	let _diff_decorators;
	let _exportPack_decorators;
	return class VibePackService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_historyList_decorators = [Remote("history")];
			_plan_decorators = [Remote("plan")];
			_install_decorators = [Remote("install")];
			_uninstall_decorators = [Remote("uninstall")];
			_diff_decorators = [Remote("diff")];
			_exportPack_decorators = [Remote("export")];
			__esDecorate(this, null, _historyList_decorators, {
				kind: "method",
				name: "historyList",
				static: false,
				private: false,
				access: {
					has: (obj) => "historyList" in obj,
					get: (obj) => obj.historyList
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _plan_decorators, {
				kind: "method",
				name: "plan",
				static: false,
				private: false,
				access: {
					has: (obj) => "plan" in obj,
					get: (obj) => obj.plan
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _install_decorators, {
				kind: "method",
				name: "install",
				static: false,
				private: false,
				access: {
					has: (obj) => "install" in obj,
					get: (obj) => obj.install
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _uninstall_decorators, {
				kind: "method",
				name: "uninstall",
				static: false,
				private: false,
				access: {
					has: (obj) => "uninstall" in obj,
					get: (obj) => obj.uninstall
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _diff_decorators, {
				kind: "method",
				name: "diff",
				static: false,
				private: false,
				access: {
					has: (obj) => "diff" in obj,
					get: (obj) => obj.diff
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _exportPack_decorators, {
				kind: "method",
				name: "exportPack",
				static: false,
				private: false,
				access: {
					has: (obj) => "exportPack" in obj,
					get: (obj) => obj.exportPack
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static inject = ["storageDomain"];
		manager = __runInitializers(this, _instanceExtraInitializers);
		history;
		constructor(ctx, config) {
			super(ctx, "vibePack");
			this.manager = new PackManager(config?.root ?? dshHomePath());
		}
		async [Service.init]() {
			const domain = await this.ctx.storageDomain.open(domainSpec);
			this.history = domain.table("history");
			this.ctx.effect(() => () => domain.close(), "vibe-pack: close storage domain");
		}
		async historyList() {
			return this.manager.history();
		}
		async plan(source) {
			return this.manager.plan(source);
		}
		async install(source, force, expectedDigest) {
			const result = await this.manager.install(source, {
				force,
				expectedDigest
			});
			await this.audit("install", result.pack.id);
			return result;
		}
		async uninstall(id, force) {
			await this.manager.uninstall(id, { force });
			await this.audit("uninstall", id);
		}
		async diff(id) {
			return this.manager.diff(id);
		}
		async exportPack(id) {
			return this.manager.export(id);
		}
		async audit(action, detail) {
			await this.history?.put(`${Date.now()}-${Math.random()}`, {
				at: (/* @__PURE__ */ new Date()).toISOString(),
				action,
				detail
			});
		}
	};
})();
//#endregion
export { FileMutationAdapter, MemoryAdapter, OwnershipGraph, PackFileSchema, PackManager, PackSchemaV1, SafeYamlError, SecurityError, Transaction, TransactionError, assertCompatibility, assertDataOnlySource, assertNoSecrets, assertSafeRelativePath, checkCompatibility, checkpoint, containedExistingPath, containedPath, containedWritablePath, VibePackService as default, diffCheckpoints, exportCheckpoint, findSecrets, hashesEqual, parsePackV1, parseSafeYaml, resolveSource, sha256 };

//# sourceMappingURL=index.js.map