import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as nodeRuntime from "@zerobyte/core/node";
import { volumeService } from "../volume.service";
import { db } from "~/server/db/db";
import { createTestSession } from "~/test/helpers/auth";
import { withContext } from "~/server/core/request-context";
import { createTestVolume } from "~/test/helpers/volume";
import { VolumeHealthCheckJob } from "~/server/jobs/healthchecks";
import { VolumeAutoRemountJob } from "~/server/jobs/auto-remount";
import { getVolumePath } from "../helpers";
import * as volumeHost from "../volume-host";
import type { VolumeBackend } from "../volume-host/types";
import { agentManager } from "../../agents/agents-manager";
import { cryptoUtils } from "~/server/utils/crypto";
import type { BackendConfig, VolumeOperationResult } from "@zerobyte/contracts/volumes";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));
vi.mock("node:os", async (original) => ({ ...(await original<typeof os>()) }));
vi.mock("@zerobyte/core/node", async (original) => ({ ...(await original<typeof nodeRuntime>()) }));
vi.mock("../volume-host", async (original) => ({ ...(await original<typeof volumeHost>()) }));

afterEach(() => vi.restoreAllMocks());

const unreadableSmbConfig = {
	backend: "smb" as const,
	server: "nas",
	share: "backups",
	username: "backup",
	password: "encv1:unreadable",
	port: 445,
	vers: "3.0" as const,
	mapToContainerUidGid: false,
};

const mockVolumeBackend = () => {
	const calls: { operation: keyof VolumeBackend; config: BackendConfig }[] = [];
	vi.spyOn(volumeHost, "createVolumeBackend").mockImplementation((volume) => {
		const run = (operation: keyof VolumeBackend, status: VolumeOperationResult["status"]) => async () => {
			calls.push({ operation, config: volume.config });
			return { status };
		};
		return {
			mount: run("mount", "mounted"),
			unmount: run("unmount", "unmounted"),
			checkHealth: run("checkHealth", "mounted"),
		};
	});
	return calls;
};

test.each(["unmounted", "error", "mounted"] as const)(
	"controller recovers an accessible directory saved as %s without an agent",
	async (status) => {
		const { organizationId } = await createTestSession();
		const root = await fs.mkdtemp(join(os.tmpdir(), "zerobyte-controller-volume-"));

		try {
			const volume = await createTestVolume({
				organizationId,
				status,
				autoRemount: false,
				config: { backend: "directory", path: root },
			});
			await withContext({ organizationId }, async () => {
				const readiness = await volumeService.ensureHealthyVolume(volume.shortId);
				expect(readiness).toMatchObject({
					ready: true,
					remounted: false,
					volume: { status: "mounted", lastError: null },
				});
				const detail = await volumeService.getVolume(volume.shortId);
				expect(detail.statfs).toEqual({});
				await fs.mkdir(join(root, "backups"));
				await fs.writeFile(join(root, "file.txt"), "backup data");

				await expect(volumeService.listFiles(volume.shortId)).rejects.toThrow("agent");
				await expect(volumeService.browseFilesystem(root)).rejects.toThrow("agent");
				await expect(volumeService.unmountVolume(volume.shortId)).resolves.toMatchObject({ status: "mounted" });
				await fs.rm(root, { recursive: true });
				await fs.writeFile(root, "not a directory");
				await expect(volumeService.ensureHealthyVolume(volume.shortId)).resolves.toMatchObject({
					ready: false,
					reason: "Path is not a directory",
				});
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	},
);

test("periodic checks recover directories while preserving manually unmounted network volumes", async () => {
	const { organizationId } = await createTestSession();
	const root = await fs.mkdtemp(join(os.tmpdir(), "zerobyte-controller-health-"));

	try {
		const volume = await createTestVolume({
			organizationId,
			status: "unmounted",
			autoRemount: false,
			config: { backend: "directory", path: root },
		});
		const network = await createTestVolume({
			organizationId,
			status: "unmounted",
			type: "nfs",
			config: { backend: "nfs", server: "nas", exportPath: "/data", version: "4", port: 2049, readOnly: false },
		});
		await new VolumeHealthCheckJob().run();
		expect(await db.query.volumesTable.findFirst({ where: { id: volume.id } })).toMatchObject({
			status: "mounted",
		});
		await withContext({ organizationId }, () => volumeService.ensureHealthyVolume(network.shortId)).then((result) =>
			expect(result.ready).toBe(false),
		);
		await fs.rm(root, { recursive: true });
		await withContext({ organizationId }, () => volumeService.checkHealth(volume.shortId));
		await fs.mkdir(root);
		await new VolumeAutoRemountJob().run();
		expect(await db.query.volumesTable.findFirst({ where: { id: volume.id } })).toMatchObject({
			status: "mounted",
			autoRemount: false,
		});
		expect(await db.query.volumesTable.findFirst({ where: { id: network.id } })).toMatchObject({
			status: "unmounted",
		});
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("controller mounts, checks and unmounts managed backends without a connected local agent", async () => {
	const { organizationId } = await createTestSession();
	const volume = await createTestVolume({
		organizationId,
		status: "error",
		type: "nfs",
		config: { backend: "nfs", server: "nas", exportPath: "/data", version: "4", port: 2049, readOnly: false },
	});
	const mountPath = getVolumePath(volume);
	let mounted = false;
	const originalReadFile = fs.readFile;
	vi.spyOn(os, "platform").mockReturnValue("linux");
	vi.spyOn(fs, "readFile").mockImplementation((...args) =>
		args[0] === "/proc/self/mountinfo"
			? Promise.resolve(mounted ? `36 25 0:32 / ${mountPath} rw - nfs nas:/data rw` : "")
			: originalReadFile(...args),
	);
	vi.spyOn(fs, "access").mockResolvedValue();
	vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
	vi.spyOn(fs, "rmdir").mockResolvedValue();
	const execute = vi.spyOn(nodeRuntime, "safeExec").mockImplementation(async ({ command }) => {
		mounted = command === "mount";
		return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
	});

	await withContext({ organizationId }, async () => {
		await expect(volumeService.ensureHealthyVolume(volume.shortId)).resolves.toMatchObject({
			ready: true,
			remounted: true,
		});
		await expect(volumeService.checkHealth(volume.shortId)).resolves.toMatchObject({ status: "mounted" });
		await expect(volumeService.unmountVolume(volume.shortId)).resolves.toMatchObject({ status: "unmounted" });
		await expect(volumeService.ensureHealthyVolume(volume.shortId)).resolves.toMatchObject({ ready: false });
	});

	expect(execute.mock.calls.map(([request]) => request.command)).toEqual(["mount", "umount"]);
	expect(await db.query.volumesTable.findFirst({ where: { id: volume.id } })).toMatchObject({
		status: "unmounted",
		lastError: null,
	});
});

test("controller tests backend connections without a worker", async () => {
	const root = await fs.mkdtemp(join(os.tmpdir(), "zerobyte-controller-connection-"));

	try {
		await expect(volumeService.testConnection({ backend: "directory", path: root })).resolves.toMatchObject({
			success: true,
		});
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

describe("volumeService.getVolume", () => {
	test("gets statfs without decrypting stored credentials", async () => {
		const { organizationId, user } = await createTestSession();
		const volume = await createTestVolume({
			organizationId,
			status: "mounted",
			agentId: "agent-1",
			type: "smb",
			config: unreadableSmbConfig,
		});
		vi.spyOn(agentManager, "runFilesystemCommand").mockResolvedValue({
			name: "filesystem.statfs",
			result: { total: 100, used: 40, free: 60 },
		});
		vi.spyOn(cryptoUtils, "resolveSecret").mockRejectedValue(
			new Error("Unsupported state or unable to authenticate data"),
		);

		await withContext({ organizationId, userId: user.id }, async () => {
			const result = await volumeService.getVolume(volume.shortId);

			expect(result.statfs).toEqual({ total: 100, used: 40, free: 60 });
		});
		expect(cryptoUtils.resolveSecret).not.toHaveBeenCalled();
	});
});

describe("volumeService.mountVolume", () => {
	test("does not unmount when stored credentials cannot be decrypted", async () => {
		const { organizationId, user } = await createTestSession();
		const volume = await createTestVolume({
			organizationId,
			status: "error",
			agentId: "agent-1",
			type: "smb",
			config: unreadableSmbConfig,
		});
		const backendCalls = mockVolumeBackend();
		vi.spyOn(cryptoUtils, "resolveSecret").mockRejectedValue(
			new Error("Unsupported state or unable to authenticate data"),
		);

		await withContext({ organizationId, userId: user.id }, async () => {
			await expect(volumeService.mountVolume(volume.shortId)).rejects.toThrow(
				"Unsupported state or unable to authenticate data",
			);
		});
		expect(backendCalls).toEqual([]);
	});
});

describe("volumeService.updateVolume", () => {
	test("can replace a volume secret when the previous secret cannot be decrypted", async () => {
		const { organizationId, user } = await createTestSession();
		const replacementCiphertext = "encv1:replacement";
		const volume = await createTestVolume({
			organizationId,
			status: "mounted",
			agentId: "agent-1",
			type: "smb",
			config: unreadableSmbConfig,
		});
		const backendCalls = mockVolumeBackend();
		vi.spyOn(cryptoUtils, "sealSecret").mockResolvedValue(replacementCiphertext);
		vi.spyOn(cryptoUtils, "resolveSecret").mockImplementation(async (value) => {
			if (value === unreadableSmbConfig.password) {
				throw new Error("Unsupported state or unable to authenticate data");
			}
			if (value === replacementCiphertext) {
				return "new-password";
			}
			return value;
		});

		await withContext({ organizationId, userId: user.id }, async () => {
			await expect(
				volumeService.updateVolume(volume.shortId, {
					config: {
						backend: "smb",
						server: "nas",
						share: "backups",
						username: "backup",
						password: "new-password",
						port: 445,
						vers: "3.0",
						mapToContainerUidGid: false,
					},
				}),
			).resolves.toBeDefined();
		});

		expect(backendCalls).toEqual([
			{
				operation: "unmount",
				config: expect.objectContaining({ password: unreadableSmbConfig.password }),
			},
			{ operation: "mount", config: expect.objectContaining({ password: "new-password" }) },
		]);

		const updatedVolume = await db.query.volumesTable.findFirst({ where: { id: volume.id } });
		expect(updatedVolume).toMatchObject({ status: "mounted" });
		expect(updatedVolume?.config).toMatchObject({ password: replacementCiphertext });
	});

	test("preserves unchanged stored credentials without resealing or remounting", async () => {
		const { organizationId, user } = await createTestSession();
		const volume = await createTestVolume({
			organizationId,
			status: "mounted",
			agentId: "agent-1",
			type: "smb",
			config: unreadableSmbConfig,
		});
		const backendCalls = mockVolumeBackend();
		vi.spyOn(cryptoUtils, "sealSecret").mockRejectedValue(
			new Error("Unsupported state or unable to authenticate data"),
		);

		await withContext({ organizationId, userId: user.id }, async () => {
			await expect(
				volumeService.updateVolume(volume.shortId, { name: "Renamed volume", config: volume.config }),
			).resolves.toBeDefined();
		});

		expect(cryptoUtils.sealSecret).not.toHaveBeenCalled();
		expect(backendCalls).toEqual([]);
		const updatedVolume = await db.query.volumesTable.findFirst({ where: { id: volume.id } });
		expect(updatedVolume).toMatchObject({ name: "Renamed volume", config: volume.config });
	});

	test.each(["sealSecret", "resolveSecret"] as const)(
		"does not unmount or persist when %s fails for changed credentials",
		async (failingStep) => {
			const { organizationId, user } = await createTestSession();
			const volume = await createTestVolume({
				organizationId,
				status: "mounted",
				agentId: "agent-1",
				type: "smb",
				config: unreadableSmbConfig,
			});
			const backendCalls = mockVolumeBackend();
			vi.spyOn(cryptoUtils, "sealSecret").mockImplementation(async (value) => value);
			vi.spyOn(cryptoUtils, failingStep).mockRejectedValue(new Error("Failed to prepare replacement credential"));

			await withContext({ organizationId, userId: user.id }, async () => {
				await expect(
					volumeService.updateVolume(volume.shortId, {
						config: { ...unreadableSmbConfig, password: "new-password" },
					}),
				).rejects.toThrow("Failed to prepare replacement credential");
			});

			expect(backendCalls).toEqual([]);
			const storedVolume = await db.query.volumesTable.findFirst({ where: { id: volume.id } });
			expect(storedVolume).toMatchObject({ status: "mounted", config: unreadableSmbConfig });
		},
	);
});

describe("volumeService.testConnection", () => {
	test("decrypts stored credentials before testing the connection", async () => {
		const password = await cryptoUtils.sealSecret("stored-password");
		const backendCalls = mockVolumeBackend();

		await expect(
			volumeService.testConnection({
				backend: "smb",
				server: "nas",
				share: "backups",
				username: "backup",
				password,
				port: 445,
				vers: "3.0",
				mapToContainerUidGid: false,
			}),
		).resolves.toEqual({
			success: true,
			message: "Connection successful",
		});

		expect(backendCalls).toEqual([
			{ operation: "mount", config: expect.objectContaining({ password: "stored-password" }) },
			{ operation: "unmount", config: expect.objectContaining({ password: "stored-password" }) },
		]);
	});
});
