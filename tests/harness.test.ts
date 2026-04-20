import { describe, it, expect, afterEach } from "vitest";
import {
	createTestSession,
	when,
	calls,
	says,
	type TestSession,
} from "@marcfargas/pi-test-harness";
import * as path from "node:path";

const EXTENSION = path.resolve(__dirname, "../src/index.ts");

describe("pi-bg-process-windows", () => {
	let t: TestSession;
	afterEach(() => t?.dispose());

	it("registers win_bg_status tool and returns empty list", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: {
				bash: "mock output",
			},
		});

		await t.run(
			when("Check background status", [
				calls("win_bg_status", { action: "list" }),
				says("No processes"),
			]),
		);

		const results = t.events.toolResultsFor("win_bg_status");
		expect(results).toHaveLength(1);
		expect(results[0].text).toContain("No background processes");
		expect(results[0].isError).toBe(false);
	});

	it("win_bg_status log without pid returns error", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: {
				bash: "mock output",
			},
		});

		await t.run(
			when("Check log without pid", [
				calls("win_bg_status", { action: "log" }),
				says("Error"),
			]),
		);

		const results = t.events.toolResultsFor("win_bg_status");
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
		expect(results[0].text).toContain("pid");
	});

	it("win_bg_status stop with unknown pid returns not found", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: {
				bash: "mock output",
			},
		});

		await t.run(
			when("Stop unknown process", [
				calls("win_bg_status", { action: "stop", pid: 99999 }),
				says("Not found"),
			]),
		);

		const results = t.events.toolResultsFor("win_bg_status");
		expect(results).toHaveLength(1);
		expect(results[0].text).toMatch(/not found|No process/i);
	});

	it("win_bg_status log with unknown pid returns not found", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: {
				bash: "mock output",
			},
		});

		await t.run(
			when("Check log for unknown pid", [
				calls("win_bg_status", { action: "log", pid: 12345 }),
				says("Not found"),
			]),
		);

		const results = t.events.toolResultsFor("win_bg_status");
		expect(results).toHaveLength(1);
		expect(results[0].text).toMatch(/not found|No process/i);
	});

	it("win_path converts Windows path to all formats", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: {
				bash: "mock output",
			},
		});

		await t.run(
			when("Convert this path", [
				calls("win_path", { path: "C:\\Users\\name\\Documents" }),
				says("Git Bash"),
			]),
		);

		const results = t.events.toolResultsFor("win_path");
		expect(results).toHaveLength(1);
		expect(results[0].text).toContain("Git Bash:");
		expect(results[0].text).toContain("/c/Users/name/Documents");
		expect(results[0].text).toContain("Win32:");
		expect(results[0].text).toContain("C:\\Users\\name\\Documents");
		expect(results[0].text).toContain("file://:");
		expect(results[0].text).toContain("file:///C:/Users/name/Documents");
	});

	it("win_path converts file:// URL", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: {
				bash: "mock output",
			},
		});

		await t.run(
			when("Convert file URL", [
				calls("win_path", { path: "file:///D:/projects/app.ts" }),
				says("Git Bash"),
			]),
		);

		const results = t.events.toolResultsFor("win_path");
		expect(results).toHaveLength(1);
		expect(results[0].text).toContain("/d/projects/app.ts");
		expect(results[0].text).toContain("D:\\projects\\app.ts");
	});
});
