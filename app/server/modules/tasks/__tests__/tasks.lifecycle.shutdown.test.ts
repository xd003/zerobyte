import { beforeEach, expect, test } from "vitest";
import { db } from "~/server/db/db";
import { tasksTable } from "~/server/db/schema";
import type { TaskResult } from "~/schemas/tasks";
import { ensureTestOrganization, TEST_ORG_ID } from "~/test/helpers/organization";
import { cancelAllTaskExecutionsForShutdown, runTaskLifecycle } from "../tasks.lifecycle";
import { taskStore } from "../tasks.store";

// Shutdown is one-way for the module, so these cases live in their own file.

const createTask = (id: string) =>
	taskStore.create({
		id,
		organizationId: TEST_ORG_ID,
		resourceType: "repository",
		resourceId: "repo-short",
		targetDisplayName: "Test repository",
		input: { kind: "deleteSnapshots", repositoryId: "repo-short", snapshotIds: ["snapshot-1"] },
	});

beforeEach(async () => {
	await ensureTestOrganization();
	await db.delete(tasksTable);
});

test("shutdown aborts running non-cancellable tasks and cancels tasks started afterwards", async () => {
	const runningTask = createTask("task-running-at-shutdown");
	const started = Promise.withResolvers<void>();

	const running = runTaskLifecycle({
		taskId: runningTask.id,
		label: "test task",
		cancellable: false,
		run: (signal) => {
			const { promise, reject } = Promise.withResolvers<TaskResult>();
			signal.addEventListener("abort", () => reject(signal.reason));
			started.resolve();
			return promise;
		},
	});
	await started.promise;

	expect(cancelAllTaskExecutionsForShutdown()).toBe(1);
	await running;

	const lateTask = createTask("task-started-after-shutdown");
	let lateTaskRan = false;
	await runTaskLifecycle({
		taskId: lateTask.id,
		label: "test task",
		run: async () => {
			lateTaskRan = true;
			return { kind: "deleteSnapshots", deletedSnapshotIds: [] };
		},
	});

	expect(lateTaskRan).toBe(false);
	for (const taskId of [runningTask.id, lateTask.id]) {
		expect(taskStore.findById({ organizationId: TEST_ORG_ID, taskId })).toMatchObject({
			status: "cancelled",
			error: "Task was interrupted by server shutdown",
		});
	}
});
